import { join } from "node:path";
import { Device } from "./driver/device.js";
import type { DeviceOptions } from "./driver/device.js";
import { Session as CoreSession } from "./operations/session.js";
import type {
  InspectResult,
  ListOptions,
  PinchInput,
  SwipeInput,
  TapOptions,
  Target,
  TypeOptions,
  WaitForOptions,
  WindowFilter,
  WindowOptions,
  WindowResult,
} from "./operations/session.js";
import type { SessionOptions } from "./operations/session.js";
import type { Screen } from "./driver/agent/screen.js";
import type { ActionResult } from "./driver/agent/result.js";
import type { On } from "./driver/agent/selector.js";
import type { Point } from "./driver/agent/gestures.js";
import type { Policy } from "./governance/policy.js";
import type {
  ApprovalDecision,
  ApprovalScope,
  DecisionResult,
  PendingApproval,
} from "./governance/approvals.js";
import type { LeaseInfo } from "./governance/lease.js";
import {
  handoffDevice,
  holdDevice,
  resumeDevice,
} from "./governance/hold.js";
import type { HoldResult } from "./governance/hold.js";
import { readRecentTrace } from "./governance/trace.js";
import type { TraceRecorder, TraceRecord } from "./governance/trace.js";
import { castConfigPath, CastConfig } from "./cast/config.js";
import type { CastSettings } from "./cast/config.js";
import { createCast } from "./cast/create.js";
import { Recording } from "./cast/record.js";
import type { CastClient, CastOptions } from "./cast/types.js";
import { createViewerSource } from "./viewer/source.js";
import { openWindow } from "./viewer/window.js";
import { keepAwake } from "./keep-awake.js";
import type { KeepAwakeHandle } from "./keep-awake.js";
import { startViewerServer } from "./viewer/server.js";
import type { ViewerServer } from "./viewer/server.js";

/** Everything needed to open a device and a session in one call. */
export interface ConnectOptions extends DeviceOptions, SessionOptions {}

/**
 * Device-side ports for a ws viewer, and the gap between two views.
 *
 * The extension's default port (5000) is shared by every client that does not
 * name one, and the record daemon takes `port + 1`. A stride of 2 keeps each
 * view's stream and recorder inside its own pair.
 */
const WS_VIEW_BASE_PORT = 5000;
const WS_VIEW_PORT_STRIDE = 2;

/** Connects to the attached device, or the one `deviceId` names. */
export async function connectDevice(opts: DeviceOptions = {}): Promise<Device> {
  return Device.connect(opts);
}

/**
 * Connects and takes the device, returning the category-shaped API.
 *
 * The device is disposed when the session cannot open: a lease conflict or a
 * policy failure must not leave a daemon and an fport behind.
 */
export async function connect(opts: ConnectOptions = {}): Promise<Session> {
  const device = await Device.connect(opts);
  let core: CoreSession;
  try {
    core = await CoreSession.open(device, opts);
  } catch (e) {
    await device.dispose().catch(() => undefined);
    throw e;
  }
  return new Session(device, core);
}

export interface ObserveApi {
  (opts?: { out?: string }): Promise<ActionResult>;
  layout(opts?: { out?: string }): Promise<Screen>;
  screenshot(opts?: { out?: string }): Promise<{ path: string; result: ActionResult }>;
  window(filter?: WindowFilter, opts?: WindowOptions): Promise<WindowResult>;
  /** Installed bundles. The ability is resolved at launch, so it is not here. */
  apps(): Promise<Array<{ bundle: string }>>;
  inspect(opts?: { out?: string; html?: string }): Promise<InspectResult>;
}

export interface DragOptions {
  holdMs?: number;
  durationMs?: number;
  approvalId?: string;
  approvalScope?: ApprovalScope;
}

export interface FlingOptions {
  approvalId?: string;
  approvalScope?: ApprovalScope;
}

export interface ActApi {
  tap(target: Target, opts?: TapOptions): Promise<ActionResult>;
  type(text: string, opts?: TypeOptions): Promise<ActionResult>;
  swipe(input: SwipeInput): Promise<ActionResult>;
  drag(from: Point, to: Point, opts?: DragOptions): Promise<ActionResult>;
  fling(from: Point, to: Point, opts?: FlingOptions): Promise<ActionResult>;
  pinch(opts: PinchInput): Promise<ActionResult>;
  key(key: string | number): Promise<ActionResult>;
  launch(app: string, opts?: { ability?: string }): Promise<ActionResult>;
  longPress(target: Target, holdMs?: number): Promise<ActionResult>;
  doubleClick(target: Target, opts?: TapOptions): Promise<ActionResult>;
}

export interface WaitApi {
  forText(text: string, opts?: WaitForOptions): Promise<ActionResult>;
  forSelector(selector: On, opts?: WaitForOptions): Promise<ActionResult>;
  settle(previousHash?: string): Promise<ActionResult>;
  scrollUntil(
    target: string | On | { text: string },
    opts?: ListOptions & { timeoutMs?: number },
  ): Promise<ActionResult>;
}

export interface RecordingHandle {
  path: string;
  stop(): Promise<string | null>;
}

export interface CastApi {
  open(opts?: Omit<CastOptions, "mode">): Promise<CastClient>;
  record(
    opts: Omit<CastOptions, "mode" | "outputPath"> & { out: string },
  ): Promise<RecordingHandle>;
  configure(settings: Partial<CastSettings>): Promise<CastSettings>;
}

/** A running viewer page. Closing it stops the page, not the session. */
export interface ViewerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface ViewApi {
  open(opts?: {
    port?: number;
    host?: string;
    privacy?: boolean;
    layout?: boolean;
    open?: boolean;
  }): Promise<ViewerHandle>;
}

export interface GovernApi {
  readonly policy: Policy;
  readonly approvals: {
    pending(): PendingApproval[];
    decide(
      id: string,
      decision: ApprovalDecision,
      opts?: { scope?: ApprovalScope; reason?: string },
    ): DecisionResult;
  };
  readonly lease: {
    assert(): Promise<void>;
    info(): Promise<LeaseInfo | null>;
    hold(reason?: string): Promise<HoldResult>;
    resume(): Promise<boolean>;
  };
  readonly trace: TraceRecorder | null;
  recent(limit?: number): Promise<TraceRecord[]>;
}

/**
 * One task's view of one device, shaped by what an agent is doing.
 *
 * `observe`, `act`, `wait`, `cast`, `view` and `govern` are the categories: a
 * caller that knows it wants to read a screen never has to guess whether the
 * method lives on the device, the session or a driver. The advanced surfaces —
 * commands, drivers, governance internals — are explicit subpath imports.
 */
export class Session {
  readonly observe: ObserveApi;
  readonly act: ActApi;
  readonly wait: WaitApi;
  readonly cast: CastApi;
  readonly view: ViewApi;
  readonly govern: GovernApi;
  /**
   * Keeps the display awake, returning a handle that puts the device's own
   * timeout back. A mirror that goes dark after thirty seconds looks broken;
   * changing a person's settings is a side effect, so the caller asks.
   *
   * `close()` restores every handle this session handed out that is still
   * awake: the session is the thing that outlives the caller, and a person who
   * closes the window should not find their phone's sleep timeout changed.
   */
  readonly keepAwake: (seconds?: number) => Promise<KeepAwakeHandle>;
  private readonly views = new Set<ViewerServer>();
  /**
   * How many viewers this session has opened. The first gets the documented
   * port 7000; later ones ask the OS for a free port, because two pages that
   * both default to 7000 is the documented second viewer failing with
   * EADDRINUSE.
   */
  private viewSeq = 0;
  /** Handles from `keepAwake` whose restore `close()` still owes. */
  private readonly awakeHandles = new Set<KeepAwakeHandle>();

  constructor(
    readonly device: Device,
    readonly core: CoreSession,
  ) {
    this.observe = Object.assign(
      (opts: { out?: string } = {}) => this.core.observe(opts),
      {
        layout: async (opts: { out?: string } = {}): Promise<Screen> => {
          if (!opts.out) return this.core.screen();
          const result = await this.core.observe({ out: opts.out });
          return result.screen ?? this.core.screen();
        },
        screenshot: async (
          opts: { out?: string } = {},
        ): Promise<{ path: string; result: ActionResult }> => {
          const path = opts.out ?? join(this.stateDir, "shots", `shot-${Date.now()}.jpg`);
          const result = await this.core.screenshot({ out: path });
          return { path, result };
        },
        window: (filter?: WindowFilter, opts?: WindowOptions) => this.core.window(filter, opts),
        // `list()` returns bundle names only — the ability is resolved at launch
        // time, not enumerated. `AppInfo` therefore carries no `ability` here,
        // and the type says so rather than promising a field that is never set.
        apps: async (): Promise<Array<{ bundle: string }>> =>
          this.core.apps ? (await this.core.apps.list()).map((bundle) => ({ bundle })) : [],
        inspect: async (opts: { out?: string; html?: string } = {}): Promise<InspectResult> => {
          const out = opts.out ?? join(this.stateDir, "shots", `inspect-${Date.now()}.jpg`);
          return this.core.inspect({ out, ...(opts.html ? { html: opts.html } : {}) });
        },
      },
    );

    this.act = {
      tap: (target, opts) => this.core.tap(target, opts),
      type: (text, opts) => this.core.type(text, opts),
      swipe: (input) => this.core.swipe(input),
      drag: (from, to, opts = {}) => this.core.drag(from, to, opts),
      fling: (from, to, opts = {}) => this.core.fling(from, to, opts),
      pinch: (opts) => this.core.pinch(opts),
      key: (key) => this.core.pressKey(key),
      launch: (app, opts) => this.core.launch(app, opts),
      longPress: (target, holdMs) =>
        holdMs === undefined ? this.core.longPress(target) : this.core.longPress(target, holdMs),
      doubleClick: (target, opts) => this.core.doubleClick(target, opts),
    };

    this.wait = {
      forText: (text, opts) => this.core.waitFor(text, opts),
      forSelector: (selector, opts) => this.core.waitForSelector(selector, opts),
      settle: (previousHash) => this.core.settle(previousHash),
      scrollUntil: (target, opts) => this.core.scrollUntilVisible(target, opts),
    };

    this.cast = {
      open: async (opts = {}) =>
        createCast(this.device, { ...(await this.castDefaults()), mode: "stream", ...opts }),
      record: async (opts) => {
        const { out, ...rest } = opts;
        // `Recording` owns the rule that a record daemon must not share the
        // stream's socket or port. Re-implementing it here was a second copy
        // that would silently drift — and the failure mode is a second daemon
        // on the stream's own socket, which takes the picture away.
        const recording = new Recording({
          stateDir: this.stateDir,
          outputPath: out,
          socketName: `uitest_record_${process.pid}`,
          createCast: (castOpts) => createCast(this.device, castOpts),
          streamCast: { ...(await this.castDefaults()), ...rest, mode: "stream" },
        });
        await recording.start();
        return {
          path: out,
          stop: async () => {
            await recording.stop();
            return out;
          },
        };
      },
      configure: async (settings) => {
        const config = await CastConfig.load(castConfigPath(this.stateDir));
        return config.set(settings);
      },
    };

    this.view = {
      open: async (opts = {}) => {
        // Each view gets its own cast daemons. The suffix defaults to the pid,
        // which is unique per process but not per view: two views in one
        // process would share `uitest_live_<pid>` and take turns stealing each
        // other's socket. The sequence makes it unique per view.
        const seq = this.viewSeq++;
        const cast = await this.castDefaults();
        const source = createViewerSource(this.core, this.device, {
          stateDir: this.stateDir,
          // The ws transport has no socket name, only a device-side TCP port,
          // so the suffix isolates nothing there: two views would both ask for
          // the default 5000, and the second `ownDaemon("-p 5000")` matches the
          // first view's process — disposing one kills the other's stream.
          // Each view therefore gets a port of its own, two apart: the record
          // daemon runs beside the stream at `port + 1`, so one-apart views
          // would collide with each other's recorder.
          cast:
            cast.transport === "ws" && cast.port === undefined
              ? { ...cast, port: WS_VIEW_BASE_PORT + seq * WS_VIEW_PORT_STRIDE }
              : cast,
          socketSuffix: `${process.pid}_${seq}`,
          ...(opts.layout !== undefined ? { layout: opts.layout } : {}),
        });
        const server = await startViewerServer({
          // 7000 is the documented default for the first page. A second page
          // that asked for it too would fail with EADDRINUSE; `port: 0` asks
          // the OS, and the caller reads the real port from the handle.
          port: opts.port ?? (seq === 0 ? 7000 : 0),
          host: opts.host ?? "127.0.0.1",
          privacy: opts.privacy ?? true,
          source,
        });
        const host = opts.host ?? "127.0.0.1";
        const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
        const url = `http://${shown}:${server.port}/`;
        if (opts.open !== false) openWindow(url);
        this.views.add(server);
        return {
          url,
          port: server.port,
          close: async () => {
            this.views.delete(server);
            await server.close();
          },
        };
      },
    };

    this.keepAwake = async (seconds?: number) => {
      const handle = await keepAwake(this.device.hypium, seconds);
      // Wrapped so `close()` can drop the entry once the caller restored it
      // itself: a second `-r` would undo a timeout set by someone else since.
      const wrapped: KeepAwakeHandle = {
        restore: async () => {
          this.awakeHandles.delete(wrapped);
          await handle.restore();
        },
      };
      this.awakeHandles.add(wrapped);
      return wrapped;
    };

    this.govern = {
      policy: this.core.policy,
      approvals: {
        pending: () => this.core.pendingApprovals(),
        decide: (id, decision, opts = {}) => this.core.resolveApproval(id, decision, opts),
      },
      lease: {
        assert: () => this.core.assertLease(),
        info: () => this.core.leaseInfo(),
        hold: (reason?: string) =>
          reason === undefined
            ? holdDevice({ stateDir: this.stateDir, tag: this.tag })
            : handoffDevice({ stateDir: this.stateDir, tag: this.tag, reason }),
        resume: () => resumeDevice({ stateDir: this.stateDir, tag: this.tag }),
      },
      trace: this.core.trace,
      recent: (limit?: number) => readRecentTrace(this.stateDir, limit === undefined ? {} : { limit }),
    };
  }

  get stateDir(): string {
    return this.core.stateDir;
  }

  get task(): string {
    return this.core.task;
  }

  get tag(): string {
    return this.core.tag;
  }

  /** Closes every viewer this session opened, releases the lease, disposes the device. */
  async close(): Promise<void> {
    for (const viewer of [...this.views]) {
      this.views.delete(viewer);
      await viewer.close().catch(() => undefined);
    }
    // A handle the caller never restored is this session's debt: the device
    // would otherwise keep the override for its full hour after the window
    // closed.
    for (const handle of [...this.awakeHandles]) {
      this.awakeHandles.delete(handle);
      await handle.restore().catch(() => undefined);
    }
    await this.core.release();
  }

  /** Cast defaults from this state directory, minus the mode an operation decides. */
  private async castDefaults(): Promise<Omit<CastOptions, "mode">> {
    const config = await CastConfig.load(castConfigPath(this.stateDir));
    return config.get();
  }
}
