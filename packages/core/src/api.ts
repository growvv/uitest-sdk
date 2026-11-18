import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import type { CastClient, CastOptions } from "./cast/types.js";
import { createViewerSource } from "./viewer/source.js";
import { startViewerServer } from "./viewer/server.js";
import type { ViewerServer } from "./viewer/server.js";

/** Everything needed to open a device and a session in one call. */
export interface ConnectOptions extends DeviceOptions, SessionOptions {}

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

/** Records the socket/port pair a recording daemon needs to live beside the stream. */
const RECORD_PORT_OFFSET = 1;

/** Opens the URL in the platform's default browser; failure is not fatal. */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The URL is returned either way.
  }
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
  private readonly views = new Set<ViewerServer>();

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
        await mkdir(dirname(out), { recursive: true });
        const stream = await this.castDefaults();
        const ws = (rest.transport ?? stream.transport) === "ws";
        const cast = await createCast(this.device, {
          ...stream,
          ...rest,
          mode: "record",
          ...(ws
            ? { port: (rest.port ?? stream.port ?? 5000) + RECORD_PORT_OFFSET }
            : { socketName: `uitest_record_${process.pid}` }),
          outputPath: out,
        });
        return {
          path: out,
          stop: async () => {
            await cast.dispose();
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
        const source = createViewerSource(this.core, this.device, {
          stateDir: this.stateDir,
          cast: await this.castDefaults(),
          ...(opts.layout !== undefined ? { layout: opts.layout } : {}),
        });
        const server = await startViewerServer({
          port: opts.port ?? 7000,
          host: opts.host ?? "127.0.0.1",
          privacy: opts.privacy ?? true,
          source,
        });
        const host = opts.host ?? "127.0.0.1";
        const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
        const url = `http://${shown}:${server.port}/`;
        if (opts.open !== false) openBrowser(url);
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
    await this.core.release();
  }

  /** Cast defaults from this state directory, minus the mode an operation decides. */
  private async castDefaults(): Promise<Omit<CastOptions, "mode">> {
    const config = await CastConfig.load(castConfigPath(this.stateDir));
    return config.get();
  }
}
