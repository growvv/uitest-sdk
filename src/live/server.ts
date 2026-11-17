import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { H264Chunk } from "../transport/model.js";
import type { CastClient, JpegFrame } from "../cast/types.js";
import type { Screen } from "../driver/agent/screen.js";
import { WS_OPCODE_CLOSE, WS_OPCODE_PING, WS_OPCODE_TEXT } from "../cast/ws.js";
import { NAL_IDR, avcC, codecString, nalType, parameterSets, splitNalUnits, toAvcc } from "./avc.js";
import { LiveState, type LiveStatus } from "./state.js";
import { PLAYER_HTML } from "./player.js";
import { LiveInput } from "./input.js";
import type { InputSession } from "../input/lane.js";
import { originAllowed } from "./origin.js";
import {
  buildUpgradeResponse,
  decodeClientFrames,
  encodeServerBinary,
  encodeServerClose,
  encodeServerText,
  frameHeader,
} from "./ws-server.js";

/**
 * The live inspector: one HTTP server, one WebSocket per tab, one cast.
 *
 * Frames are relayed, not stored: the device's Annex-B NAL units are converted
 * to length-prefixed AVCC and sent as `flag byte | pts | AVCC` the moment they
 * arrive, and the browser decodes them with WebCodecs. Nothing here waits for a
 * keyframe, a buffer or an acknowledgement — a paused tab is detected from the
 * socket's own write queue and skipped until it drains.
 */

/** Pending socket bytes above which a tab is considered behind. */
const WATERMARK = 1 << 20;

/** How often congestion may ask the encoder for a keyframe. */
const CONGESTION_IDR_MS = 250;

/** Restart backoff for a cast that died while a tab was watching. */
const RETRY_MS = [500, 1000, 2000, 4000, 5000] as const;

export interface LiveSource {
  createCast(): Promise<CastClient>;
  /**
   * The current screen. `redact` is the privacy switch, passed down to the
   * builder. Omitted for video-only mirroring: without it the page shows the
   * picture and no node table.
   */
  readScreen?(redact: boolean): Promise<Screen>;
  /**
   * The display size, without reading the layout.
   *
   * `hello` advertises it so the page converts clicks against the display
   * rather than the decoded frame. Without `readScreen` (`--no-layout`) this
   * is the only source: a half-size frame would otherwise make every tap land
   * at half coordinates. Omitted means the page falls back to the frame size.
   */
  displaySize?(): Promise<{ width: number; height: number }>;
  /**
   * Saves one screenshot and returns its path. Omitted means the page shows no
   * capture button — there is nothing to save with.
   */
  capture?(): Promise<string>;
  /**
   * Starts an MP4 recording and returns the path it will be written to.
   * Omitted means the page shows no record button.
   *
   * Recordings run on a second cast, so they need their own socket; the
   * implementation is responsible for that. `stopRecording` resolves with the
   * finished file, or null when there was nothing to stop.
   */
  startRecording?(): Promise<string>;
  stopRecording?(): Promise<string | null>;
  /**
   * Opens the second agent connection used for input. Omitted means the page
   * has no takeover button — there is no wire to send gestures on.
   */
  openInput?(): Promise<InputSession>;
}

export interface LiveServerOptions {
  port?: number;
  host?: string;
  /** Mask credentials. Default true; a tab can turn it off for its own session. */
  privacy?: boolean;
  /** How long the cast survives with no tab attached. Default 5000 ms. */
  graceMs?: number;
  /** Minimum spacing between layout reads. Default 250 ms. */
  layoutMs?: number;
  /**
   * How long a held pointer may go without movement before the server lifts it.
   * Default 10_000. A tab that sleeps mid-drag must not leave the phone stuck
   * in a press.
   */
  watchdogMs?: number;
  source: LiveSource;
}

interface Client {
  /** Server-assigned identity: `c1`, `c2`… Stable for the life of the socket. */
  id: string;
  socket: Socket;
  buf: Buffer;
  /** Deltas are being dropped until the socket drains. */
  congested: boolean;
  /** This tab asked to see credentials unmasked. */
  unmasked: boolean;
}

export class LiveServer {
  private readonly live = new LiveState();
  private readonly clients = new Set<Client>();
  private readonly graceMs: number;
  private readonly layoutMs: number;
  private readonly watchdogMs: number;
  private readonly source: LiveSource;
  /** The address the server bound, for the Origin check. */
  private readonly boundHost: string;

  private cast: CastClient | null = null;
  private startingCast = false;
  private closing = false;

  private codec: string | null = null;
  private description: Buffer | null = null;
  private screen: Screen | null = null;
  /** Display size when layout is off, so the page still converts clicks right. */
  private displayOnly: { width: number; height: number } | null = null;
  /**
   * Whether the shared screen model is currently unmasked. One model is shared
   * by every tab, so a single tab opting out would otherwise unmask the next
   * person's view; masking therefore holds unless every attached tab asks for
   * the raw view.
   */
  private privacy: boolean;
  /** The server's own default, used when no tab has an opinion. */
  private readonly maskByDefault: boolean;

  private layoutTimer: NodeJS.Timeout | undefined;
  private graceTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryIndex = 0;
  /** In-flight disposal of a cast that died; the next open waits for it. */
  private castDisposal: Promise<void> | null = null;
  private reading = false;
  private reread = false;
  private lastReadAt = 0;
  private lastCongestionIdrAt = 0;

  // ---- Takeover -----------------------------------------------------------
  //
  // Page-level control only: the live process keeps its device lease, and a
  // second agent connection carries gestures. The server is the single
  // arbiter of which tab, if any, is driving — a browser tab cannot be trusted
  // to coordinate with its peers.
  private nextClientId = 1;
  private controller: Client | null = null;
  private input: LiveInput | null = null;
  private inputSession: InputSession | null = null;
  /** A lane-open already in flight; concurrent take requests share it. */
  private inputOpening: Promise<InputSession> | null = null;
  /** No takeover attempt before this timestamp; a failed open backs off. */
  private inputRetryAt = 0;
  private taking = false;
  /** The tab whose `take` is opening the lane, if one is in flight. */
  private takingFor: Client | null = null;
  private watchdogTimer: NodeJS.Timeout | undefined;
  private statsTimer: NodeJS.Timeout | undefined;

  /**
   * The path of the in-flight recording, if any. One at a time: the
   * extension's encoder is start/stop driven and a second recording would
   * compete for it, so the page is told rather than silently starting a
   * second one.
   */
  private recording: string | null = null;
  /**
   * The stop currently running. `close()` waits on it instead of issuing its
   * own: on a device a second stop is a second `onEnd` and a second pull of
   * the same MP4.
   */
  private stopping: Promise<void> | null = null;

  private constructor(
    private readonly server: Server,
    opts: LiveServerOptions,
  ) {
    this.graceMs = opts.graceMs ?? 5000;
    this.layoutMs = opts.layoutMs ?? 250;
    this.watchdogMs = opts.watchdogMs ?? 10_000;
    this.maskByDefault = opts.privacy !== false;
    this.privacy = this.maskByDefault;
    this.source = opts.source;
    this.boundHost = opts.host ?? "127.0.0.1";
    this.live.onChange((next) => {
      if (next === "live") this.retryIndex = 0;
      this.broadcastText({ type: "state", state: next, reason: this.live.reason ?? null });
    });
  }

  static async start(opts: LiveServerOptions): Promise<LiveServer> {
    const server = createServer();
    const self = new LiveServer(server, opts);
    server.on("request", (req, res) => self.onRequest(req, res));
    server.on("upgrade", (req, socket, head) => self.onUpgrade(req, socket as Socket, head));
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
    // Open the write lane now, while the first tab is still loading its
    // player, so the first takeover is fast. A read-only session never opens
    // one: the failure is swallowed and the next take reports it.
    void self.ensureInput().catch(() => undefined);
    // Ask for the display size up front: the greeting carries it, and a tab
    // that connects before the first layout read must still convert clicks
    // against the display rather than the decoded frame. A failure here is
    // not fatal — the greeting then carries 0x0 and the page falls back.
    void self.ensureDisplaySize().catch(() => undefined);
    return self;
  }

  /** Caches the display size for `hello` and for clamping input. */
  private async ensureDisplaySize(): Promise<void> {
    if (this.displayOnly) return;
    const size = this.source.displaySize;
    if (!size) return;
    try {
      const s = await size.call(this.source);
      if (!this.closing && s.width > 0 && s.height > 0) {
        this.displayOnly = s;
        // A tab that connected while the size was unknown was told 0x0; the
        // page must learn the real display before its first gesture.
        if (this.clients.size > 0) this.broadcastHello();
      }
    } catch {
      // The greeting falls back to the layout's size once a read succeeds.
    }
  }

  /** The display the page should convert clicks against. */
  private displaySize(): { width: number; height: number } | null {
    return this.screen?.display ?? this.displayOnly;
  }

  /** The port actually bound; useful when `port: 0` asked for an ephemeral one. */
  get port(): number {
    const address = this.server.address();
    return address && typeof address === "object" ? (address as AddressInfo).port : 0;
  }

  get state(): LiveStatus {
    return this.live.state;
  }

  /** Page reconnects since the last clean stop. */
  get reconnects(): number {
    return this.live.reconnects;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.graceTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.layoutTimer);
    this.layoutTimer = undefined;
    this.graceTimer = undefined;
    this.retryTimer = undefined;

    // Go read-only and lift any held pointer before the sockets and the lane
    // go away. `cancel()` caps its wait at 500 ms, so a dead lane cannot hang
    // shutdown.
    await this.releaseControl("closed");
    const inputSession = this.inputSession;
    this.inputSession = null;
    if (inputSession) await inputSession.close().catch(() => undefined);

    for (const client of [...this.clients]) this.closeClient(client, 1001);
    this.clients.clear();

    // A recording left running would keep the device's encoder busy with
    // nobody left to collect the file. Stop it before the cast goes away —
    // unless a stop is already in flight, in which case wait for that one.
    if (this.stopping) {
      await this.stopping.catch(() => undefined);
    } else if (this.recording && this.source.stopRecording) {
      try {
        await this.source.stopRecording();
      } catch {
        // Shutting down anyway; the device-side file is left where it is.
      }
      this.recording = null;
    }

    const cast = this.cast;
    this.cast = null;
    if (cast) await cast.dispose().catch(() => undefined);
    // A cast that died mid-run is disposed beside the retry, not here. The
    // caller may exit the process as soon as `close()` resolves, so this wait
    // is what keeps the device daemon from being left behind.
    const disposal = this.castDisposal;
    this.castDisposal = null;
    if (disposal) await disposal;

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
    this.settle("stopped");
  }

  // ---- HTTP ---------------------------------------------------------------

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "close",
      });
      res.end(PLAYER_HTML);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
    res.end("not found\n");
  }

  // ---- WebSocket ----------------------------------------------------------

  /**
   * Answer a WebSocket handshake we will not complete and take the socket down.
   *
   * `socket.end()` alone is not enough: a peer that keeps writing to a
   * half-closed socket keeps it open (Node stops reading, the write side of the
   * refusal never drains), and the socket stays in the server's connection
   * count, so `server.close()` never fires its callback. Destroying on flush
   * makes the refusal final — the status line still reaches a browser, which is
   * all the client is owed.
   */
  private refuseUpgrade(socket: Socket, status: string): void {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.once("finish", () => socket.destroy());
  }

  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/live") {
      this.refuseUpgrade(socket, "404 Not Found");
      return;
    }
    // A WebSocket is exempt from the same-origin policy, so any page the person
    // has open can dial this fixed port. The Origin check is what makes the
    // page the only thing that can: without it a visited site takes control of
    // the phone. See origin.ts for what each case means.
    const origin = req.headers.origin;
    const allowed = originAllowed(typeof origin === "string" ? origin : undefined, {
      host: this.boundHost,
      port: this.port,
      hostHeader: String(req.headers.host ?? ""),
    });
    if (!allowed) {
      // 403 rather than 101: the browser reports the refusal to its own console,
      // and nothing about the session (frames, layout, client ids) is sent.
      this.refuseUpgrade(socket, "403 Forbidden");
      return;
    }
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const offered = String(req.headers["sec-websocket-protocol"] ?? "");
    const protocol = offered.split(",")[0]?.trim() || undefined;
    let response: string;
    try {
      response = buildUpgradeResponse(key, protocol);
    } catch {
      this.refuseUpgrade(socket, "400 Bad Request");
      return;
    }
    socket.setNoDelay(true);
    socket.write(response);
    this.attach(
      {
        id: `c${this.nextClientId++}`,
        socket,
        buf: Buffer.alloc(0),
        congested: false,
        unmasked: false,
      },
      head,
    );
  }

  private attach(client: Client, head: Buffer): void {
    this.clients.add(client);
    client.socket.on("data", (d) => this.onClientData(client, d));
    client.socket.on("error", () => this.dropClient(client));
    client.socket.on("close", () => this.dropClient(client));

    clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    this.retryIndex = 0;

    if (head.length) this.onClientData(client, head);

    if (!this.cast && !this.startingCast) void this.runCast();
    // Always greet immediately, even before a frame exists: the page needs the
    // session's state and the privacy flag to render correctly, and a second
    // hello follows as soon as the stream's format is known.
    // A new tab starts from the server's own default, never from whatever the
    // previous tab chose: the shared model is re-masked if this tab wants it.
    client.unmasked = !this.maskByDefault;
    this.refreshPrivacy();
    this.sendHello(client);
    if (this.screen) this.sendText(client, this.nodesMessage());
    void this.readLayout(true);
    // A fresh viewer needs a fresh keyframe; if the cast is still starting the
    // request is issued once it exists, in `runCast`.
    this.requestIdr("attach");
  }

  private dropClient(client: Client): void {
    if (!this.clients.has(client)) return;
    // The controller leaving is a release. Do it while the tab is still in the
    // set, so the read-only broadcast reaches the other tabs before anything
    // else about this disconnect is processed.
    if (this.controller === client) void this.releaseControl("disconnected");
    this.clients.delete(client);
    try {
      client.socket.destroy();
    } catch {
      // Already gone.
    }
    // The tab that was holding the view unmasked may have been the only one;
    // the remaining tabs go back to masked.
    if (this.clients.size > 0) this.refreshPrivacy();
    if (this.clients.size > 0 || this.closing) return;
    clearTimeout(this.layoutTimer);
    this.layoutTimer = undefined;
    if (this.live.state === "live") this.transition("reconnecting");
    clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined;
      void this.stopCast();
    }, this.graceMs);
    this.graceTimer.unref?.();
  }

  private onClientData(client: Client, data: Buffer): void {
    client.buf = client.buf.length ? Buffer.concat([client.buf, data]) : data;
    let frames;
    try {
      ({ frames, rest: client.buf } = decodeClientFrames(client.buf));
    } catch {
      this.closeClient(client, 1002);
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === WS_OPCODE_TEXT) this.onClientMessage(client, frame.payload);
      else if (frame.opcode === WS_OPCODE_PING) {
        if (!client.socket.destroyed) {
          client.socket.write(Buffer.concat([frameHeader(0x0a, frame.payload.length), frame.payload]));
        }
      } else if (frame.opcode === WS_OPCODE_CLOSE) {
        this.closeClient(client, 1000);
      }
    }
  }

  private onClientMessage(client: Client, payload: Buffer): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(message.type ?? "");
    // Control messages are arbitrated first: a stale tab's input must not be
    // able to ride in on the same event as a takeover request.
    if (type === "control") {
      this.onControl(client, message);
      return;
    }
    if (type === "input") {
      this.routeInput(client, message);
      return;
    }
    if (type === "privacy") {
      client.unmasked = !Boolean(message.value);
      this.refreshPrivacy();
      return;
    }
    if (type === "requestIDR" || type === "start") {
      client.congested = false;
      this.requestIdr("client");
      return;
    }
    if (type === "shot") {
      void this.capture(client);
      return;
    }
    if (type === "record") {
      if (message.action === "stop") void this.stopRecording(client);
      else void this.startRecording(client);
    }
  }

  // ---- Takeover -----------------------------------------------------------

  private onControl(client: Client, message: Record<string, unknown>): void {
    const action = String(message.action ?? "");
    if (action === "take") {
      void this.takeControl(client);
      return;
    }
    // Releasing is the controller's privilege; a stale tab cannot end someone
    // else's session.
    if (action === "release" && this.controller === client) {
      void this.releaseControl("released");
    }
  }

  /**
   * Grants control to one tab, or refuses with a reason it can show.
   *
   * The state changes only after the write lane is open: reporting
   * `controlled` first and failing the first gesture later is exactly the
   * "clicked, nothing happened" failure this design forbids.
   */
  private async takeControl(client: Client): Promise<void> {
    if (this.closing || !this.clients.has(client)) return;
    // Another take is opening the lane. Refuse instead of queueing: letting
    // both tabs think they are operating is worse than refusing one.
    // The tab that already holds control is not a competitor: a repeated
    // `take` from it (double-click, or a click while the first open is still
    // in flight) must confirm its state, not tell it that it is read-only.
    // The page believes every control message, so a `busy` there made the
    // controller drop its own control while the server kept it — and then no
    // tab could ever take control again.
    if (this.controller === client) {
      this.sendText(client, { type: "control", state: "controlled", clientId: client.id });
      return;
    }
    if (this.taking) {
      // The same tab asking again while its own open is in flight is a
      // double-click, not a competitor: the answer it is waiting for is
      // already on its way.
      if (this.takingFor === client) return;
      this.sendBusy(client);
      return;
    }
    if (this.controller) {
      this.sendBusy(client);
      return;
    }
    this.taking = true;
    this.takingFor = client;
    try {
      const session = await this.ensureInput();
      if (this.closing || !this.clients.has(client)) return;
      if (this.controller) {
        this.sendBusy(client);
        return;
      }
      this.controller = client;
      this.input = new LiveInput({
        lane: session.lane,
        // The server clamps to the latest known display; LiveInput clamps too,
        // as a second line of defence for tests and old pages.
        bounds: () => this.displaySize(),
        focusPoint: () => focusedCenter(this.screen),
        holdMs: this.watchdogMs,
        onError: (error) => this.onInputError(error),
      });
      this.startWatchdog();
      this.startStats();
      this.broadcastText({
        type: "control",
        state: "controlled",
        clientId: client.id,
        by: client.id,
      });
    } catch (e) {
      this.sendText(client, {
        type: "control",
        state: "readonly",
        reason: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.taking = false;
      this.takingFor = null;
    }
  }

  /**
   * Returns the write lane, opening it if needed.
   *
   * Concurrent requests share one open. A failure is remembered for five
   * seconds so a page whose button is still clickable cannot hammer the
   * device with fport attempts.
   */
  private async ensureInput(): Promise<InputSession> {
    if (this.inputSession) return this.inputSession;
    if (Date.now() < this.inputRetryAt) {
      throw new Error("the input lane is cooling down after a failure");
    }
    if (this.inputOpening) return this.inputOpening;
    const open = this.source.openInput;
    if (!open) throw new Error("this session cannot send input");
    const opening = (async (): Promise<InputSession> => {
      try {
        const session = await open.call(this.source);
        if (this.closing) {
          await session.close().catch(() => undefined);
          throw new Error("the server closed while the input lane was opening");
        }
        this.inputSession = session;
        return session;
      } catch (e) {
        this.inputRetryAt = Date.now() + 5000;
        throw e;
      } finally {
        this.inputOpening = null;
      }
    })();
    this.inputOpening = opening;
    // `open` is supplied by the caller and may throw synchronously. The IIFE
    // then settles before the line above runs, so its finally cleared the
    // field while it was still null and the rejected promise was stored
    // afterwards — kept forever, and every later takeover got that same
    // rejection. Clear it here too; the finally handles the async case.
    opening.catch(() => {
      if (this.inputOpening === opening) this.inputOpening = null;
    });
    return opening;
  }

  /**
   * Drops control and lifts a held pointer.
   *
   * The read-only broadcast goes out before the lift is awaited: the page
   * must stop looking controllable immediately, and the device-side lift is
   * best effort. `cancel()` bounds that lift at 500 ms.
   */
  private async releaseControl(reason?: string, message?: string): Promise<void> {
    const held = this.input;
    const wasControlled = this.controller !== null;
    this.controller = null;
    this.input = null;
    this.stopWatchdog();
    this.stopStats();
    if (wasControlled) {
      this.broadcastText({
        type: "control",
        state: "readonly",
        ...(reason ? { reason } : {}),
        ...(message ? { message } : {}),
      });
    }
    if (held) await held.cancel().catch(() => undefined);
  }

  /**
   * Routes one input message from the controller.
   *
   * Everything is validated here and nowhere else: a malformed number or an
   * unknown key is dropped rather than forwarded. Coordinates are clamped by
   * LiveInput against the latest display.
   */
  private routeInput(client: Client, message: Record<string, unknown>): void {
    const input = this.input;
    if (!input || this.controller !== client) return;
    const finite = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    switch (String(message.action ?? "")) {
      case "down": {
        const x = finite(message.x);
        const y = finite(message.y);
        if (x !== null && y !== null) input.down(x, y);
        return;
      }
      case "move": {
        const x = finite(message.x);
        const y = finite(message.y);
        if (x !== null && y !== null) input.move(x, y);
        return;
      }
      case "up": {
        const x = finite(message.x);
        const y = finite(message.y);
        if (x !== null && y !== null) input.up(x, y);
        return;
      }
      case "pinch": {
        const cx = finite(message.cx);
        const cy = finite(message.cy);
        const half = finite(message.half);
        if (cx !== null && cy !== null && half !== null) input.pinch(cx, cy, half);
        return;
      }
      case "wheel": {
        const x = finite(message.x);
        const y = finite(message.y);
        const dy = finite(message.dy);
        if (x !== null && y !== null && dy !== null) input.wheel(x, y, dy);
        return;
      }
      case "text": {
        if (typeof message.text !== "string") return;
        const text = message.text.slice(0, 2000);
        const x = finite(message.x);
        const y = finite(message.y);
        input.type(text, x !== null && y !== null ? { x, y } : undefined);
        return;
      }
      case "key": {
        const key = String(message.key ?? "");
        if (key === "back" || key === "home" || key === "enter" || key === "delete") {
          input.key(key);
        }
        return;
      }
    }
  }

  /**
   * The write lane rejected an operation. The page must go read-only at once;
   * the lane is discarded and reopened on the next takeover after a short
   * backoff.
   */
  private onInputError(error: Error): void {
    const session = this.inputSession;
    this.inputSession = null;
    this.inputRetryAt = Date.now() + 500;
    void this.releaseControl("error", error.message);
    if (session) void session.close().catch(() => undefined);
  }

  private sendBusy(client: Client): void {
    const holder = this.controller;
    this.sendText(client, {
      type: "control",
      state: "readonly",
      reason: "busy",
      ...(holder ? { by: holder.id } : {}),
    });
  }

  /**
   * Ticks the watchdog while control is held. The interval is a quarter of the
   * hold window (capped at a second), so a stuck pointer is lifted close to
   * the deadline rather than up to a second late.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    const every = Math.max(10, Math.min(1000, Math.floor(this.watchdogMs / 4)));
    this.watchdogTimer = setInterval(() => this.input?.tick(), every);
    this.watchdogTimer.unref?.();
  }

  private stopWatchdog(): void {
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }

  /** Publishes injection latency at most once a second while controlled. */
  private startStats(): void {
    this.stopStats();
    this.statsTimer = setInterval(() => {
      if (!this.input || !this.controller) return;
      const stats = this.input.stats();
      if (!stats) return;
      this.broadcastText({
        type: "control",
        state: "controlled",
        clientId: this.controller.id,
        stats,
      });
    }, 1000);
    this.statsTimer.unref?.();
  }

  private stopStats(): void {
    clearInterval(this.statsTimer);
    this.statsTimer = undefined;
  }

  /**
   * Saves one screenshot on the server's behalf.
   *
   * The reply carries the path so the person can find the file; a failure is
   * reported to the tab that asked and nowhere else, because the other tabs
   * did not click anything.
   */
  private async capture(client: Client): Promise<void> {
    const capture = this.source.capture;
    if (!capture) {
      this.sendText(client, { type: "saved", error: "this session cannot save screenshots" });
      return;
    }
    try {
      const path = await capture.call(this.source);
      this.sendText(client, { type: "saved", path });
    } catch (e) {
      this.sendText(client, { type: "saved", error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async startRecording(client: Client): Promise<void> {
    const start = this.source.startRecording;
    if (!start) {
      this.sendText(client, { type: "record", error: "this session cannot record" });
      return;
    }
    if (this.recording || this.stopping) {
      this.sendText(client, { type: "record", error: "already recording" });
      return;
    }
    try {
      const path = await start.call(this.source);
      this.recording = path;
      // Every tab shows the same badge: the recording belongs to the device,
      // not to the tab that started it.
      this.broadcastText({ type: "record", recording: true, path });
    } catch (e) {
      this.sendText(client, {
        type: "record",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Stops the recording and reports the finished file.
   *
   * The stop is kept as a promise so the window between the source's promise
   * and the state update is visible: a second click, or `close()` landing in
   * that window, would otherwise start a second stop and on a real device a
   * second pull of the same file.
   */
  private async stopRecording(client: Client): Promise<void> {
    const stop = this.source.stopRecording;
    if (!stop || !this.recording || this.stopping) {
      this.sendText(client, { type: "record", error: "not recording" });
      return;
    }
    const run = (async () => {
      try {
        const path = await stop.call(this.source);
        this.recording = null;
        this.broadcastText({ type: "record", recording: false });
        if (path) this.broadcastText({ type: "saved", path });
        else this.sendText(client, { type: "saved", error: "the recording produced no file" });
      } catch (e) {
        this.recording = null;
        this.broadcastText({ type: "record", recording: false });
        this.sendText(client, {
          type: "saved",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    this.stopping = run;
    try {
      await run;
    } finally {
      this.stopping = null;
    }
  }

  /**
   * Recomputes the shared view's masking from every attached tab.
   *
   * Unmasking is a person's decision about their own phone, but the screen
   * model is one object shared by every tab. So the raw view is served only
   * while every tab has asked for it; otherwise the model stays masked, and
   * each tab is told what it is actually looking at.
   */
  private refreshPrivacy(): void {
    let unmask = this.clients.size > 0;
    for (const client of this.clients) if (!client.unmasked) unmask = false;
    if (this.clients.size === 0) unmask = !this.maskByDefault;
    const next = !unmask;
    if (next === this.privacy) return;
    this.privacy = next;
    this.broadcastText({ type: "privacy", value: next });
    if (this.source.readScreen) void this.readLayout(true);
  }

  private closeClient(client: Client, code: number): void {
    const socket = client.socket;
    if (socket.destroyed) return;
    try {
      socket.write(encodeServerClose(code));
    } catch {
      // The peer is already gone; the close event cleans up.
    }
    socket.end();
  }

  private sendText(client: Client, message: Record<string, unknown>): void {
    if (client.socket.destroyed || !client.socket.writable) return;
    client.socket.write(encodeServerText(JSON.stringify(message)));
  }

  private broadcastText(message: Record<string, unknown>): void {
    if (this.clients.size === 0) return;
    const frame = encodeServerText(JSON.stringify(message));
    for (const client of this.clients) {
      if (client.socket.destroyed || !client.socket.writable) continue;
      client.socket.write(frame);
    }
  }

  private sendHello(client: Client): void {
    // A greeting names the tab it greets; the broadcast hello cannot, because
    // one message goes to every tab.
    this.sendText(client, this.hello(client.id));
  }

  private broadcastHello(): void {
    const frame = encodeServerText(JSON.stringify(this.hello()));
    for (const client of this.clients) {
      if (client.socket.destroyed || !client.socket.writable) continue;
      client.socket.write(frame);
    }
  }

  private controlState(): { state: "readonly" | "controlled"; by?: string } {
    return this.controller
      ? { state: "controlled", by: this.controller.id }
      : { state: "readonly" };
  }

  private hello(clientId?: string): Record<string, unknown> {
    return {
      type: "hello",
      ...(clientId !== undefined ? { clientId } : {}),
      control: this.controlState(),
      codec: this.codec,
      description: this.description ? this.description.toString("base64") : null,
      width: this.displaySize()?.width ?? 0,
      height: this.displaySize()?.height ?? 0,
      state: this.live.state,
      privacy: this.privacy,
      // What this session can do, so the page shows a button only when
      // clicking it would work. A video-only mirror has neither.
      canShot: Boolean(this.source.capture),
      canRecord: Boolean(this.source.startRecording && this.source.stopRecording),
      recording: this.recording !== null,
    };
  }

  private nodesMessage(): Record<string, unknown> {
    const screen = this.screen;
    return {
      type: "nodes",
      privacy: this.privacy,
      display: screen ? { ...screen.display } : null,
      bundle: screen?.bundle ?? "",
      locked: Boolean(screen?.locked),
      nodes: (screen?.elements ?? []).map((e) => ({
        ref: e.ref,
        role: e.role,
        label: e.label,
        ...(e.masked ? { masked: true } : {}),
        x: e.rect.x,
        y: e.rect.y,
        w: e.rect.width,
        h: e.rect.height,
        cx: e.center.x,
        cy: e.center.y,
        clickable: e.clickable,
        input: e.input,
        scrollable: e.scrollable,
      })),
    };
  }

  // ---- Layout -------------------------------------------------------------

  private async readLayout(force = false): Promise<void> {
    if (this.closing || this.clients.size === 0) return;
    const read = this.source.readScreen;
    if (!read) return;
    if (!force && Date.now() - this.lastReadAt < this.layoutMs) {
      this.scheduleLayout();
      return;
    }
    if (this.reading) {
      this.reread = true;
      return;
    }
    this.reading = true;
    try {
      const screen = await read.call(this.source, this.privacy);
      this.lastReadAt = Date.now();
      this.screen = screen;
      this.broadcastText(this.nodesMessage());
    } catch {
      // Keep the last table: a layout read failing once is not a reason to
      // blank the panel.
    } finally {
      this.reading = false;
      if (this.reread) {
        this.reread = false;
        void this.readLayout(true);
      }
    }
    this.scheduleLayout();
  }

  private scheduleLayout(): void {
    if (this.layoutTimer || this.closing || this.clients.size === 0) return;
    if (!this.source.readScreen) return;
    const wait = Math.max(0, this.layoutMs - (Date.now() - this.lastReadAt));
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = undefined;
      void this.readLayout(true);
    }, wait);
    this.layoutTimer.unref?.();
  }

  // ---- Cast ---------------------------------------------------------------

  private async runCast(): Promise<void> {
    if (this.cast || this.startingCast || this.closing) return;
    this.startingCast = true;
    // A replacement must not start while the previous client is still winding
    // down: MJPEG's `dispose()` stops the shared agent's capture, so it would
    // stop the new stream instead of the old one.
    const disposal = this.castDisposal;
    this.castDisposal = null;
    if (disposal) await disposal;
    if (this.closing) {
      this.startingCast = false;
      return;
    }
    let cast: CastClient | null = null;
    try {
      this.transition("starting");
      cast = await this.source.createCast();
      this.cast = cast;
      this.requestIdr("attach");
      // x86_64 devices have no H.264 extension and get an MJPEG client instead.
      // Its frames are whole JPEGs, so they need no decoding pipeline and no
      // parameter sets — but they must not be read as NAL units either.
      const mjpeg = cast.castKind === "mjpeg";
      if (mjpeg) {
        this.codec = "mjpeg";
        this.description = null;
        this.broadcastHello();
        this.transition("live");
      }
      for await (const chunk of cast.stream()) {
        if (this.closing || this.cast !== cast) break;
        if (mjpeg) this.onJpeg(chunk as JpegFrame);
        else this.onChunk(chunk as H264Chunk);
      }
      if (!this.closing && cast && this.cast === cast) {
        // `dispose()` is what stops the device-side daemon and removes the
        // forward; without it every loss leaves an orphaned daemon on the
        // phone, and each one competes for the encoder (measured: ten-minute
        // runs decayed from ~18 fps to 13 fps after a few accumulated).
        //
        // It runs beside the retry, not before it: awaiting here would keep
        // `startingCast` true, and the retry that fires meanwhile would return
        // early and never be rescheduled. `runCast` waits for the disposal
        // before it opens a replacement — for MJPEG that order matters,
        // because its `dispose()` stops the *shared* agent's capture.
        this.cast = null;
        this.castDisposal = cast.dispose().catch(() => undefined);
        this.onCastLost("the cast stream ended");
      }
    } catch (err) {
      if (!this.closing && cast && this.cast === cast) {
        this.cast = null;
        this.castDisposal = cast.dispose().catch(() => undefined);
        this.onCastLost(err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.startingCast = false;
      if (this.cast === cast) this.cast = null;
    }
  }

  /**
   * Relays one JPEG in the same envelope as an H.264 frame, so the page has one
   * message shape: a flag byte, a pts, then the picture. Every JPEG stands
   * alone, hence the flag is always 1.
   */
  private onJpeg(frame: JpegFrame): void {
    if (this.clients.size === 0) return;
    const payload = Buffer.allocUnsafe(5 + frame.data.length);
    payload[0] = 1;
    payload.writeUInt32BE(frame.pts >>> 0, 1);
    frame.data.copy(payload, 5);
    const encoded = encodeServerBinary(payload);
    for (const client of this.clients) {
      const socket = client.socket;
      if (socket.destroyed || !socket.writable) continue;
      // JPEGs cannot be skipped and resumed the way a keyframe can: the next
      // one is a complete picture, so dropping is always safe.
      if (socket.writableLength > WATERMARK) continue;
      socket.write(encoded);
    }
  }

  private onCastLost(reason: string): void {
    this.cast = null;
    this.settle("failed", reason);
    if (this.closing || this.clients.size === 0) return;
    const delay = RETRY_MS[Math.min(this.retryIndex++, RETRY_MS.length - 1)]!;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.runCast();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async stopCast(): Promise<void> {
    const cast = this.cast;
    this.cast = null;
    if (!cast) {
      if (this.live.state !== "idle" && this.live.state !== "stopped") this.settle("stopped");
      return;
    }
    this.transition("stopping");
    await cast.dispose().catch(() => undefined);
    this.settle("stopped");
  }

  private onChunk(chunk: H264Chunk): void {
    const units = splitNalUnits(chunk.data);
    if (units.length === 0) return;

    const formatChanged = this.updateFormat(units);
    if (this.codec && (this.live.state === "starting" || this.live.state === "reconnecting")) {
      this.transition("live");
    }
    if (formatChanged) this.broadcastHello();

    // The source's `isKeyFrame` is not the question the browser asks. WebCodecs
    // rejects a chunk typed `key` that holds no IDR slice, and the 6.8
    // extension's opening frame is exactly that: SPS and PPS, no picture. A
    // frame with no slice at all carries nothing to draw, so it is not sent;
    // a keyframe is one with an IDR in it.
    const idr = units.some((unit) => nalType(unit) === NAL_IDR);
    const hasSlice = units.some((unit) => {
      const type = nalType(unit);
      return type === NAL_IDR || type === 1;
    });
    if (!this.codec || this.clients.size === 0 || !hasSlice) return;

    const avcc = toAvcc(units);
    const payload = Buffer.allocUnsafe(5 + avcc.length);
    payload[0] = idr ? 1 : 0;
    // The pts field is the source's millisecond clock, truncated to 32 bits.
    // It orders frames for the decoder; it is not a wall-clock time.
    payload.writeUInt32BE(chunk.pts >>> 0, 1);
    avcc.copy(payload, 5);
    const frame = encodeServerBinary(payload);
    for (const client of this.clients) this.writeFrame(client, frame, idr);
  }

  private updateFormat(units: Buffer[]): boolean {
    const sets = parameterSets(units);
    if (!sets) return false;
    let codec: string;
    let description: Buffer;
    try {
      codec = codecString(sets.sps);
      description = avcC(sets.sps, sets.pps);
    } catch {
      return false;
    }
    if (this.codec === codec && this.description?.equals(description)) return false;
    this.codec = codec;
    this.description = description;
    return true;
  }

  private writeFrame(client: Client, frame: Buffer, key: boolean): void {
    const socket = client.socket;
    if (socket.destroyed || !socket.writable) return;
    const pending = socket.writableLength;
    if (pending > WATERMARK) {
      if (!client.congested) {
        client.congested = true;
        this.requestIdr("congestion");
      }
      return;
    }
    if (client.congested) {
      if (pending > WATERMARK / 2) return;
      // Draining: resume only on a keyframe, so the picture restarts coherently.
      client.congested = false;
      this.requestIdr("congestion");
      if (!key) return;
    }
    socket.write(frame);
  }

  private requestIdr(reason: "attach" | "client" | "congestion"): void {
    if (reason === "congestion") {
      const now = Date.now();
      if (now - this.lastCongestionIdrAt < CONGESTION_IDR_MS) return;
      this.lastCongestionIdrAt = now;
    }
    const cast = this.cast;
    if (!cast) return;
    cast.requestIDRFrame().catch(() => undefined);
  }

  // ---- State --------------------------------------------------------------

  /**
   * A transition the session declares. Teardown and attach paths use `settle`
   * instead: they must always complete, and a state that refuses them would
   * strand the server rather than protect anything.
   */
  private transition(next: LiveStatus, reason?: string): void {
    try {
      this.live.to(next, reason);
    } catch {
      this.live.force(next, reason);
    }
  }

  private settle(next: LiveStatus, reason?: string): void {
    this.transition(next, reason);
  }
}

/** The center of the focused input, where text goes when the page sends no point. */
function focusedCenter(screen: Screen | null): { x: number; y: number } | null {
  const field = screen?.elements.find((e) => e.focused && e.input);
  return field ? { x: field.center.x, y: field.center.y } : null;
}
