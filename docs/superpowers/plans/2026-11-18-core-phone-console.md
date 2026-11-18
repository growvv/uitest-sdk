# core + phone + console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single `uitest-sdk@0.9.4` package into `uitest-sdk@0.10.0` (core), `uitest-phone@0.10.0` (headless agent package) and `uitest-console@0.1.0` (optional human console), without losing any 0.9.4 capability, then release and publish per-product acceptance reports with screenshots.

**Architecture:** Stage 1 reorganises the existing single package into `transport → driver → operations → governance/cast/input → viewer` directories and adds the category-shaped public API. Stage 2 moves the whole tree into `packages/core` and adds npm workspaces; `packages/phone` and `packages/console` consume only core's `exports`. The viewer (origin-checked HTTP+WS server, WebCodecs player, inspect panel, privacy switch, input) exists once in core; products inject a page and options.

**Tech Stack:** TypeScript 5 (NodeNext, strict), Node ≥20, npm workspaces, vitest 1.x, tsx, @grpc/grpc-js, jpeg-js, jsonc-parser (phone only), Chrome/Edge for browser screenshots.

**Spec:** `docs/superpowers/specs/2026-11-18-core-products-design.md`

## Global Constraints

- Versions: `uitest-sdk@0.10.0`, `uitest-phone@0.10.0`, `uitest-console@0.1.0`; `uitest-mirror@0.1.0` is Plan 2.
- Dependency edges: only `phone → core`, `console → core`, `mirror → core`. No product→product, no core→product, no `uitest-sdk/dist/*` deep imports.
- Preserve every 0.9.4 capability; breaking API changes are allowed only where the spec names them (`Device.createCast`, `Device.openInputLane`, `live` moving out of the CLI, flat root exports). No feature is deleted without a replacement or a documented migration message.
- One implementation each of: viewer/origin checks, player, inspect panel, privacy masking, cast transports, COMMANDS, approval store, tag hash. Products compose, never re-implement.
- Never write a real device serial into any tracked file, output, report or screenshot name. Only the 8-hex tag from `tagOf()`. Never publish personal screen contents: stage the calculator before screenshots and inspect every captured image before it is copied to `site/`.
- Never write token values into repo files, docs or commits. A temp npmrc containing `$NPM_TOKEN` lives outside the repo and is deleted after publishing.
- Daemons are killed only when this process started them or when no active session exists; never `killall uitest`. No silent transport fallback (ws/grpc/mjpeg is always explicit). `unset HDC_SERVER_PORT` before every device run. HDC path is `D:/Application/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe`.
- Acceptance evidence: `docs/acceptance/<product>-<version>/report.json` + screenshots; generated site page `site/acceptance-<product>-<version>.html` under the same origin `acceptance.html` hub; every report needs real-device screenshots on both tags `7544d645` and `6c585f5b` when both are attached.
- Approval TTL is 60 s by default; a replay with an id is valid only after a person wrote an `allow` decision. Headless is fail-closed.
- Tests: every task ends with `npm test` (or the task's named subset) green and a commit ending with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

- **Cross-process visibility.** Phone and console use different processes but must see the same pending approvals and hold for the same device. A `--state-dir` or tag mismatch silently makes the inbox empty or the takeover invisible; tests in Tasks 5, 13 and 15 pin the shared path convention.
- **Self-approval.** The agent receives the approval id in `approval_pending`; possessing the id must never be enough to proceed. Task 5's tests must show replay-without-decision stays pending, deny denies, allow proceeds exactly once.
- **Origin security after the move.** The seven handshakes plus missing-key 400 and upgrade-path 404 must still be enforced by the one core server, including console extension messages. Task 8 owns these tests; no product may start a second HTTP/WS server.
- **Page injection is server-authored.** `renderPlayerPage` injects console-owned constant strings, never device or user text. Task 8/15 test that a page title with HTML is escaped and approval rows are rendered as text.
- **Takeover actually stops the agent.** Console hold must make the next agent command return `lease_held`, while the console keeps mirroring; resume must let the agent continue. Task 15 tests this across two processes.
- **Acceptance screenshots leak personal data.** Lock screen, notifications and third-party profiles have leaked before. Tasks 16–18 include a visual inspection step for every image, and the report generator only copies reviewed images.

---

### Task 1: Commit the spec and plan, start the branch

**Files:**
- Commit: `docs/superpowers/specs/2026-11-18-core-products-design.md`, `docs/superpowers/plans/2026-11-18-core-phone-console.md`

**Interfaces:**
- Produces: branch `arch/core-products`; later tasks commit here. Merge to `master` only in Task 19.

- [ ] **Step 1: Create the branch**

```bash
git switch -c arch/core-products
```

- [ ] **Step 2: Commit the documents**

```bash
git add docs/superpowers/specs/2026-11-18-core-products-design.md docs/superpowers/plans/2026-11-18-core-phone-console.md
git commit -m "docs: core + phone + console design and implementation plan

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Transport module and one tag hash

**Files:**
- Create: `src/transport/tag.ts`
- Move: `src/hdc.ts`, `src/files.ts`, `src/apps.ts`, `src/pool.ts`, `src/model.ts`, `src/errors.ts`, `src/util/*` → `src/transport/`
- Modify: every importer under `src/`, `test/`, `scripts/`
- Test: `test/unit/tag.test.ts` (new), existing `trace.test.ts`, `hold.test.ts`, `session.test.ts`

**Interfaces:**
- Produces: `tagOf(deviceId: string | null | undefined): string` (SHA-1 first 8 hex; `"nodevice"` for absent), `deviceTag` aliased to it. All transport imports live under `src/transport/`.

- [ ] **Step 1: Write the failing tag test**

```ts
// test/unit/tag.test.ts
import { describe, expect, it } from "vitest";
import { tagOf, deviceTag } from "../../src/transport/tag.js";

describe("tagOf", () => {
  it("hashes a serial to 8 lowercase hex characters", () => {
    expect(tagOf("SYNTH0DEVICE0001")).toMatch(/^[0-9a-f]{8}$/);
    expect(tagOf("SYNTH0DEVICE0001")).toBe(tagOf("SYNTH0DEVICE0001"));
    expect(tagOf("SYNTH0DEVICE0001")).not.toBe(tagOf("SYNTH0DEVICE0002"));
  });
  it("uses one placeholder for every absent-device spelling", () => {
    expect(tagOf(undefined)).toBe("nodevice");
    expect(tagOf(null)).toBe("nodevice");
    expect(deviceTag(null)).toBe("nodevice");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/tag.test.ts`
Expected: FAIL — cannot resolve `src/transport/tag.js`.

- [ ] **Step 3: Move the files and create `tag.ts`**

```bash
mkdir -p src/transport/util
git mv src/hdc.ts src/files.ts src/apps.ts src/pool.ts src/model.ts src/errors.ts src/transport/
git mv src/util/bounds.ts src/transport/util/bounds.ts
# repeat for every other file under src/util/
```

`tag.ts` holds the body currently in `session.ts:178`; `export const deviceTag = tagOf;`.
Then rewrite relative imports: every file that moved keeps same-directory imports; every outside importer gains `transport/`. Run `npm run typecheck` and fix each unresolved specifier until it is clean.

- [ ] **Step 4: Point the old definitions at the new one**

`src/session.ts` re-exports `tagOf` from `./transport/tag.js`; `src/trace.ts` exports `deviceTag` from there; `src/doctor.ts` `deviceTagOf` is an alias. Delete the three duplicate hash implementations. Update `trace.test.ts:242` to expect `"nodevice"`.

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS, 68 files plus the new tag test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(core): move transport primitives and unify the device tag hash

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Driver module and the ControlDriver interface

**Files:**
- Create: `src/driver/control.ts`, `src/driver/agent-driver.ts`
- Move: `src/device.ts` → `src/driver/device.ts`; `src/agent/*` → `src/driver/agent/`; `src/hypium/*` → `src/driver/hypium/`; `src/cli.ts` → `src/driver/cli.ts`
- Test: `test/unit/driver-control.test.ts` (new); existing `device.test.ts`, agent/hypium tests

**Interfaces:**
- Produces:
  ```ts
  export interface ControlDriver {
    readonly kind: "agent";
    readonly deviceId?: string;
    readonly hdc?: ShellRunner;
    hypium(api: string, thisRef: string, args: unknown[]): Promise<unknown>;
    captureLayout(): Promise<UiNode>;
    getDisplaySize(): Promise<{ width: number; height: number }>;
    getDisplayRotation(): Promise<number>;
    captureScreen(opts?: { scale?: number }): Promise<Buffer>;
    click(x: number, y: number): Promise<void>;
    touchDown(x: number, y: number): Promise<void>;
    touchMove(x: number, y: number): Promise<void>;
    touchUp(x: number, y: number): Promise<void>;
    inputText(x: number, y: number, text: string, mode?: InputTextMode): Promise<void>;
    triggerKey(code: number): Promise<void>;
    dispose?(): Promise<void>;
  }
  export class AgentDriver implements ControlDriver { constructor(device: Device) }
  ```
- The extension protocol is the only control transport; `HypiumDriver` remains the 118-member facade over the same agent (a comment in `control.ts` records this). `SessionDevice` stays structurally compatible.

- [ ] **Step 1: Write the failing adapter test**

```ts
// test/unit/driver-control.test.ts
import { describe, expect, it, vi } from "vitest";
import { AgentDriver } from "../../src/driver/agent-driver.js";

describe("AgentDriver", () => {
  it("delegates the control calls to the device's agent connection", async () => {
    const agent = {
      hypium: vi.fn(async () => "ok"),
      captureLayout: vi.fn(async () => ({ tag: "root", children: [] })),
      getDisplaySize: vi.fn(async () => ({ width: 1216, height: 2688 })),
      getDisplayRotation: vi.fn(async () => 0),
      captureScreen: vi.fn(async () => Buffer.from([1])),
      click: vi.fn(async () => undefined),
      touchDown: vi.fn(async () => undefined),
      touchMove: vi.fn(async () => undefined),
      touchUp: vi.fn(async () => undefined),
      inputText: vi.fn(async () => undefined),
      triggerKey: vi.fn(async () => undefined),
    };
    const driver = new AgentDriver({ deviceId: "SYNTH0DEVICE0001", agent, hdc: undefined } as never);
    expect(driver.kind).toBe("agent");
    await driver.click(10, 20);
    expect(agent.click).toHaveBeenCalledWith(10, 20);
    await driver.captureLayout();
    expect(agent.captureLayout).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/driver-control.test.ts`
Expected: FAIL — no `src/driver/agent-driver.js`.

- [ ] **Step 3: Move and fix imports**

```bash
mkdir -p src/driver
git mv src/device.ts src/driver/device.ts
git mv src/agent src/driver/agent
git mv src/hypium src/driver/hypium
git mv src/cli.ts src/driver/cli.ts
```

Run `npm run typecheck`; for every moved agent/hypium file, imports of `model`, `errors`, `util` now go through `../../transport/...`. Fix until clean.

- [ ] **Step 4: Implement `control.ts` and `agent-driver.ts`**

`AgentDriver` holds a structural `{ deviceId?, agent, hdc? }` and forwards each method (12 one-liners). `kind` is `"agent"`. No new logic.

- [ ] **Step 5: Run the adapter test and the suite**

Run: `npx vitest run test/unit/driver-control.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(core): move the driver stack and add the ControlDriver adapter

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Input lane, cast record, and de-god-object `Device`

**Files:**
- Create: `src/input/lane.ts` (from `src/live/input-lane.ts`), `src/input/open.ts`, `src/cast/create.ts`
- Move: `src/live/record.ts` → `src/cast/record.ts`
- Modify: `src/driver/device.ts` (remove `createCast`, `openInputLane`), `src/live/server.ts`, `src/live/cli.ts`, `src/index.ts`
- Test: `test/unit/device-surface.test.ts` (new), updated cast/device/input tests

**Interfaces:**
- Produces:
  ```ts
  // cast/create.ts
  export interface CastHost {
    readonly agent: AgentClient;
    readonly hdc: HdcRunner;
    readonly abi: "arm64" | "x86_64";
    resolveCastExtension(): string | null;
  }
  export function createCast(host: CastHost, opts: CastOptions): Promise<CastClient>;

  // input/open.ts
  export interface InputHost {
    readonly hdc: HdcRunner;
    readonly deviceId: string;
    readonly agentPort: number;
    readonly requestTimeoutMs?: number;
    readonly retryOnBusy?: boolean;
  }
  export function openInput(host: InputHost): Promise<InputSession>;
  ```
- `Device` gains public read-only `abi` and `agentPort`, keeps `resolveCastExtension()`, and no longer has `createCast`/`openInputLane`.

- [ ] **Step 1: Write the failing surface test**

```ts
// test/unit/device-surface.test.ts
import { describe, expect, it } from "vitest";
import { Device } from "../../src/driver/device.js";

describe("Device surface", () => {
  it("owns connection, not transport policy", () => {
    expect("createCast" in Device.prototype).toBe(false);
    expect("openInputLane" in Device.prototype).toBe(false);
    expect("dispose" in Device.prototype).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/device-surface.test.ts`
Expected: FAIL — both methods still exist.

- [ ] **Step 3: Move record/input and extract the two functions**

Move `live/record.ts` to `cast/record.ts` and `live/input-lane.ts` to `input/lane.ts`; update imports (`../agent/gestures.js` → `../driver/agent/gestures.js`, `../model.js` → `../transport/model.js`). Copy the bodies of `Device.createCast` and `openInputLane` into the functions above, replacing `this` with `host`, and delete the methods. Add `get abi()` and `get agentPort()` to `Device`.

- [ ] **Step 4: Update every caller**

`live/cli.ts` uses `createCast(device, …)` and `openInput(device)`; `live/server.ts` imports `../input/lane.js` and `../cast/record.js`; `index.ts` exports the new functions. Update tests that called the methods.

- [ ] **Step 5: Run the targeted tests and the suite**

Run: `npx vitest run test/unit/device-surface.test.ts test/unit/device.test.ts test/unit/live-input-lane.test.ts test/unit/live-record.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(core): move input and cast out of Device

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Governance module, approval decisions, 60 s fail-closed

**Files:**
- Move: `src/policy.ts`, `src/approvals.ts`, `src/lease.ts`, `src/hold.ts`, `src/trace.ts` → `src/governance/`
- Modify: `src/approvals.ts` (per-id store + decisions), `src/session.ts` (gate, TTL, accessors), `src/commands.ts` (status)
- Test: `test/unit/approvals.test.ts` (rewrite), `test/unit/session.test.ts`, `test/unit/commands.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ApprovalDecision = "allow" | "deny";
  export interface DecisionResult {
    kind: "allowed" | "denied" | "unknown" | "expired" | "already-used";
    reason?: string;
  }
  export class Approvals {
    constructor(opts: { dir: string; ttlMs?: number; now?: () => number });
    request(step: StepIdentity, rule?: string, context?: { bundle?: string; task?: string }): PendingApproval;
    pending(): PendingApproval[];
    decide(id: string, decision: ApprovalDecision, opts?: { by?: "cli" | "console"; scope?: ApprovalScope; reason?: string }): DecisionResult;
    consume(id: string, step: StepIdentity, opts?: { scope?: ApprovalScope }): ConsumeResult;
  }
  export type ConsumeResult =
    | { kind: "approved"; rule?: string; scope?: ApprovalScope }
    | { kind: "pending"; reason: string }
    | { kind: "denied"; reason: string }
    | { kind: "stale"; reason: string };
  ```
- Storage: `<dir>/<id>.json` pending, `<id>.allow` / `<id>.deny` first-writer-wins decisions, `<id>.used` consume marker. `<dir>` is `<stateDir>/approvals/<tag>`. TTL 60 s; `SessionOptions` gains `approvalTtlMs?: number` (default 60_000). `PendingApproval` gains `bundle?: string`, `task?: string`, `status: "pending" | "allowed" | "denied"`.
- `Session` gains `stateDir`, `pendingApprovals()`, `resolveApproval(id, decision, opts?)`, `approvalStatus(id)`; `gate` returns `approval_pending` again (same id) when a replay is still undecided.

- [ ] **Step 1: Write the failing decision tests**

```ts
// test/unit/approvals.test.ts (new cases)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Approvals } from "../../src/governance/approvals.js";

const step = { command: "tap", args: { text: "删除" }, signature: "sig-1" };

describe("approval decisions", () => {
  it("cannot be consumed by the agent alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "uitest-appr-"));
    const store = new Approvals({ dir });
    const pending = store.request(step, "deletes", { bundle: "com.demo", task: "t" });
    expect(store.consume(pending.id, step).kind).toBe("pending");
  });
  it("proceeds once after a person allows it", () => {
    const dir = mkdtempSync(join(tmpdir(), "uitest-appr-"));
    const store = new Approvals({ dir });
    const pending = store.request(step, "deletes", { bundle: "com.demo", task: "t" });
    expect(store.decide(pending.id, "allow", { by: "cli" }).kind).toBe("allowed");
    expect(store.consume(pending.id, step)).toMatchObject({ kind: "approved", rule: "deletes" });
    expect(store.consume(pending.id, step).kind).toBe("denied");
  });
  it("denies after a person denies, and survives a reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "uitest-appr-"));
    const first = new Approvals({ dir });
    const pending = first.request(step, "deletes");
    expect(first.decide(pending.id, "deny", { by: "console", reason: "not now" }).kind).toBe("denied");
    expect(new Approvals({ dir }).consume(pending.id, step)).toMatchObject({ kind: "denied" });
  });
  it("expires after 60 s by default", () => {
    let now = 1_000;
    const dir = mkdtempSync(join(tmpdir(), "uitest-appr-"));
    const store = new Approvals({ dir, now: () => now });
    const pending = store.request(step, "deletes");
    now += 60_001;
    expect(store.consume(pending.id, step).kind).toBe("denied");
    expect(store.pending()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/approvals.test.ts`
Expected: FAIL — `Approvals` has no `decide`, `request` takes no context.

- [ ] **Step 3: Move governance and rewrite the store**

```bash
mkdir -p src/governance
git mv src/policy.ts src/approvals.ts src/lease.ts src/hold.ts src/trace.ts src/governance/
```

Implement the per-id store with `mkdirSync(dir, { recursive: true, mode: 0o700 })` and `writeFileSync(file, json, { flag: "wx", mode: 0o600 })` for pending/decision/used files; parse defensively (unreadable/partial files are skipped). `decide` creates the decision file with `wx`; if the opposite file exists it returns `denied` with `"already decided"`. `consume` checks `deny` first, then `allow`, then exact step hash/signature, then creates `.used` with `wx`; an existing `.used` denies.

- [ ] **Step 4: Wire the gate and accessors**

In `Session.open`, build `new Approvals({ dir: join(stateDir, "approvals", tag), ttlMs: opts.approvalTtlMs ?? 60_000 })`, store `stateDir`. `gate`:
- decision `deny` → `approval_denied`
- `pending` → return `approval_pending` with the same id and text "waiting for a person"
- `approved` → add grant when scope is task/always, using `result.scope ?? approvalScope`
- `stale`/`denied` as today.
`pendingApprovals()` delegates to `pending()`; `resolveApproval` delegates to `decide`.

- [ ] **Step 5: Update `status` and tests**

`CommandRunner.status` adds `pending: <id> <command> <rule> <bundle> expires-in-Ns` lines and `data.pending`. Update the existing approval tests (TTL assertions, default 60 s) and the session gate tests. Run:

`npx vitest run test/unit/approvals.test.ts test/unit/session.test.ts test/unit/commands.test.ts test/unit/hold.test.ts test/unit/handoff.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add -A
git commit -m "feat(core): approval decisions, 60 s fail-closed gateway, per-id store

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Operations module and additive Session accessors

**Files:**
- Move: `src/session.ts`, `src/refs.ts`, `src/commands.ts`, `src/doctor.ts` → `src/operations/`
- Create: `src/operations/trace-read.ts` (recent trace reader)
- Modify: `src/session.ts` (add `stateDir`, `launch`, `screenshot`, `waitForSelector`, `leaseInfo`)
- Test: `test/unit/session-launch.test.ts` (new), existing session/commands tests

**Interfaces:**
- Produces:
  ```ts
  // Session additions
  readonly stateDir: string;
  async launch(app: string, opts?: { ability?: string }): Promise<ActionResult>;
  async screenshot(opts?: { out?: string }): Promise<ActionResult>;
  async waitForSelector(selector: On, opts?: WaitForOptions): Promise<ActionResult>;
  leaseInfo(): Promise<LeaseInfo | null>;

  // governance/trace.ts
  export function readRecentTrace(stateDir: string, opts?: { limit?: number }): Promise<TraceRecord[]>;
  ```
- `CommandRunner.launch` delegates to `session.launch` with no behavior change.

- [ ] **Step 1: Write the failing launch test**

```ts
// test/unit/session-launch.test.ts
import { describe, expect, it, vi } from "vitest";
import { Session } from "../../src/operations/session.js";

describe("Session.launch", () => {
  it("refuses a bundle outside the app allow-list before launching", async () => {
    const device = fakeDevice({ bundle: "com.bank.app" });
    const session = await Session.open(device, { lease: false, noTrace: true, apps: "com.demo" } as never);
    const launched = vi.fn();
    (session as never as { apps: { launch: typeof launched } }).apps.launch = launched;
    const result = await session.launch("com.bank.app");
    expect(result.status).toBe("blocked");
    expect(launched).not.toHaveBeenCalled();
  });
});
```

`fakeDevice` is the same fake used by `session.test.ts`; copy its helper into a shared `test/unit/fake-device.ts` if needed (test utility, not production).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/session-launch.test.ts`
Expected: FAIL — `session.launch` is not a function.

- [ ] **Step 3: Move and add the accessors**

```bash
mkdir -p src/operations
git mv src/session.ts src/refs.ts src/commands.ts src/doctor.ts src/operations/
```

Move the body of `CommandRunner.launch` (bundle resolution, policy scope check, launch, foreground polling) into `Session.launch`; have the runner call it. Add `stateDir` (set in the constructor), `screenshot` (default `<stateDir>/shots/shot-<ts>.jpg`, calls `observe`), `waitForSelector` (delegates to `waitFor`), `leaseInfo` (reads the lock path).

- [ ] **Step 4: Add `readRecentTrace` with a failing test**

```ts
it("returns the newest records across trace files, newest last", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uitest-trace-"));
  const a = new TraceRecorder({ dir, task: "t", deviceId: "SYNTH0DEVICE0001" });
  a.step({ command: "tap", args: {}, status: "settled", text: "one" });
  await a.flush();
  const recent = await readRecentTrace(dir, { limit: 5 });
  expect(recent.at(-1)?.command).toBe("tap");
});
```

Implement by scanning `<stateDir>/traces/*.jsonl`, parsing lines, sorting by `at`, slicing the last `limit`.

- [ ] **Step 5: Run the targeted tests and the suite**

Run: `npx vitest run test/unit/session-launch.test.ts test/unit/session.test.ts test/unit/commands.test.ts test/unit/trace.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(core): move operations and expose launch/screenshot/lease accessors

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Cast module consolidation

**Files:**
- Move: `src/config.ts` → `src/cast/config.ts`; `src/fps.ts` → `src/cast/fps.ts`
- Modify: `src/cast/*` imports; `src/index.ts`
- Test: existing `config.test.ts`, `fps.test.ts`, cast tests

**Interfaces:**
- Produces: all cast-related modules under `src/cast/`; `CastConfig`, `castConfigPath`, `FpsMeter`, `Recording`, `createCast` are siblings.

- [ ] **Step 1: Move and fix imports**

```bash
git mv src/config.ts src/cast/config.ts
git mv src/fps.ts src/cast/fps.ts
```

Run `npm run typecheck` and fix importers in `src/`, `test/`, `scripts/` (`./config.js` → `../cast/config.js` from outside cast).

- [ ] **Step 2: Run cast and config tests**

Run: `npx vitest run test/unit/config.test.ts test/unit/fps.test.ts test/unit/cast-client.test.ts test/unit/cast-ws-client.test.ts test/unit/live-record.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add -A
git commit -m "refactor(core): consolidate cast, config and fps under cast/

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: Viewer split, feature flags, hooks, and the single origin check

**Files:**
- Move: `src/live/origin.ts`, `ws-server.ts`, `avc.ts`, `input.ts`, `state.ts`, `server.ts`, `player.ts` → `src/viewer/`
- Create: `src/viewer/source.ts`
- Modify: `src/viewer/server.ts` (rename types, features, modes, hooks, page), `src/viewer/player.ts` (`renderPlayerPage`, feature hiding, `window.uitestViewer`), `src/live/cli.ts` (imports)
- Test: `test/unit/viewer-server.test.ts` (renamed from `live-server.test.ts`), `test/unit/viewer-player.test.ts` (renamed), `test/unit/viewer-source.test.ts` (new), `test/unit/live-origin.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ViewerSource {
    createCast(): Promise<CastClient>;
    readScreen?(redact: boolean): Promise<Screen>;
    displaySize?(): Promise<{ width: number; height: number }>;
    capture?(): Promise<string>;
    startRecording?(): Promise<string>;
    stopRecording?(): Promise<string | null>;
    openInput?(): Promise<InputSession>;
  }
  export interface ViewerFeatures {
    inspect?: boolean; privacy?: boolean; capture?: boolean; record?: boolean; control?: boolean;
  }
  export interface ViewerClient {
    readonly id: string;
    send(message: Record<string, unknown>): void;
  }
  export interface ViewerHooks {
    onClient?(client: ViewerClient): void;
    onClientGone?(clientId: string): void;
    onMessage?(client: ViewerClient, message: Record<string, unknown>): boolean;
  }
  export interface ViewerServerOptions {
    port?: number; host?: string; privacy?: boolean; graceMs?: number;
    layoutMs?: number; watchdogMs?: number;
    source: ViewerSource;
    features?: ViewerFeatures;
    page?: string;
    input?: { mode: "takeover" | "always" | "off"; open(): Promise<InputSession> };
    hooks?: ViewerHooks;
  }
  export class ViewerServer { static start(opts): Promise<ViewerServer>; readonly port; readonly state; close() }
  export function startViewerServer(opts: ViewerServerOptions): Promise<ViewerServer>;
  export function createViewerSource(session: Session, device: Device, opts: {
    stateDir: string; cast?: Omit<CastOptions, "mode" | "outputPath">;
    socketSuffix?: string; layout?: boolean; capture?: boolean;
  }): ViewerSource;
  export function renderPlayerPage(opts?: {
    title?: string; extraHtml?: string; extraScript?: string;
  }): string;
  ```
- `hello` adds `canInspect`, `canInput`, `canRecord`, `canShot`, `mode`. Page hides aside/takeover/Shot/Record when false. `input.mode` defaults to `"takeover"` when `openInput` exists, `"off"` otherwise. `hooks.onMessage` runs after built-in message types.
- `window.uitestViewer = { send(message), on(type, handler), hello() }` is defined by the page script; extensions are appended by `renderPlayerPage`.
- Origin checks remain only in `viewer/server.ts`; add tests for missing `Sec-WebSocket-Key` → 400 and upgrade to the wrong path → 404.

- [ ] **Step 1: Write the failing feature/hook tests**

```ts
// test/unit/viewer-server.test.ts (new cases)
it("advertises what the source can do and hides the rest", async () => {
  const server = await startViewerServer({ port: 0, source: fakeSource({ readScreen: undefined }) });
  const hello = await connectAndHello(server.url);
  expect(hello.canInspect).toBe(false);
  expect(hello.canInput).toBe(true);
  await server.close();
});
it("lets a product handle its own message types", async () => {
  const seen: string[] = [];
  const server = await startViewerServer({
    port: 0, source: fakeSource(),
    hooks: { onMessage: (_c, m) => { if (m.type === "console:list") { seen.push("list"); return true; } return false; } },
  });
  await sendAndExpect(server.url, { type: "console:list" }, 200);
  expect(seen).toEqual(["list"]);
  await server.close();
});
it("accepts input from every tab in always mode and none in off mode", async () => {
  // two scenarios, one lane spy; takeover mode itself is already covered by live-server tests
});
it("refuses an upgrade without Sec-WebSocket-Key with 400", async () => {
  // raw socket helper from live-server.test.ts
});
it("serves an injected page and escapes the title", async () => {
  const server = await startViewerServer({ port: 0, source: fakeSource(), page: renderPlayerPage({ title: "<b>x</b>", extraHtml: "<div id=\"inbox\"></div>" }) });
  const html = await (await fetch(server.url)).text();
  expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(html).toContain("id=\"inbox\"");
  await server.close();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/viewer-server.test.ts`
Expected: FAIL — no `startViewerServer`, no feature flags.

- [ ] **Step 3: Move and rename**

```bash
mkdir -p src/viewer
git mv src/live/origin.ts src/viewer/origin.ts
git mv src/live/ws-server.ts src/viewer/ws-server.ts
git mv src/live/avc.ts src/viewer/avc.ts
git mv src/live/input.ts src/viewer/input.ts
git mv src/live/state.ts src/viewer/state.ts
git mv src/live/server.ts src/viewer/server.ts
git mv src/live/player.ts src/viewer/player.ts
git mv test/unit/live-server.test.ts test/unit/viewer-server.test.ts
git mv test/unit/live-player-page.test.ts test/unit/viewer-player.test.ts
```

Rename `LiveSource/LiveServer/LiveServerOptions` to `ViewerSource/ViewerServer/ViewerServerOptions` throughout; `LiveInput/LiveState` keep their names. Update `src/live/cli.ts` imports to `../viewer/...`.

- [ ] **Step 4: Implement features, modes and hooks**

In `start`: derive features (`inspect = features.inspect ?? Boolean(source.readScreen)`, etc.); `input.mode = input?.mode ?? (source.openInput ? "takeover" : "off")`; only call `ensureInput` eagerly when mode is `takeover` or `always`. `hello` sends the flags. `routeInput` accepts from any client in `always`, rejects in `off`, requires the controller in `takeover`. `dropClient` keeps the viewer grace/privacy behavior and calls `hooks.onClientGone`. `onClientMessage` calls `hooks.onMessage` for unhandled types before ignoring.

- [ ] **Step 5: Implement the player changes**

Convert `PLAYER_HTML` into `const BASE = \`...\`` and:
```ts
const EXTRA_MARK = "</body>";
export function renderPlayerPage(opts: { title?: string; extraHtml?: string; extraScript?: string } = {}): string {
  const title = escapeHtml(opts.title ?? "uitest viewer");
  let html = BASE.replace("<title>uitest live</title>", `<title>${title}</title>`);
  if (opts.extraHtml) html = html.replace(EXTRA_MARK, `${opts.extraHtml}\n${EXTRA_MARK}`);
  if (opts.extraScript) html = html.replace(EXTRA_MARK, `<script>${opts.extraScript}</script>\n${EXTRA_MARK}`);
  return html;
}
export const PLAYER_HTML = renderPlayerPage();
```
The inline script exposes `window.uitestViewer` and hides `#takeover` when `hello.canInput !== true || hello.mode !== "takeover"`, `aside` when `!hello.canInspect`, Shot/Record when false.

- [ ] **Step 6: Implement `createViewerSource`**

Extract the source construction from `live/cli.ts:120-190` into `viewer/source.ts`; `live/cli.ts` calls it. Keep the pid socket suffix, `readScreen` redaction via `session.reader.builder.setRedact`, default screenshot path, and the Recording instance. Test with a fake session/device that it toggles redaction and returns the same source shape.

- [ ] **Step 7: Run viewer tests and the suite**

Run: `npx vitest run test/unit/viewer-server.test.ts test/unit/viewer-player.test.ts test/unit/viewer-source.test.ts test/unit/live-origin.test.ts test/unit/live-input.test.ts test/unit/live-state.test.ts && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(core): viewer split with feature flags, hooks and page injection

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: Core API facade, subpath exports, small root

**Files:**
- Create: `src/api.ts`, `src/exports/commands.ts`, `src/exports/cast.ts`, `src/exports/viewer.ts`, `src/exports/govern.ts`, `src/exports/drivers.ts`
- Modify: `src/index.ts`, `package.json` (`exports` map), `src/cli-main.ts` (move `parseArgv` to `src/operations/argv.ts`)
- Test: `test/unit/api.test.ts` (new), `test/unit/package-entry.test.ts` (rewrite), `test/unit/cli-main.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ConnectOptions extends DeviceOptions, SessionOptions {}
  export async function connectDevice(opts?: DeviceOptions): Promise<Device>;
  export async function connect(opts?: ConnectOptions): Promise<Session>;
  export class Session {
    readonly device: Device;
    readonly core: CoreSession;
    readonly stateDir: string;
    readonly task: string;
    readonly tag: string;
    readonly observe: ObserveApi;
    readonly act: ActApi;
    readonly wait: WaitApi;
    readonly cast: CastApi;
    readonly view: ViewApi;
    readonly govern: GovernApi;
    close(): Promise<void>;
  }
  export interface ObserveApi {
    (opts?: { out?: string }): Promise<ActionResult>;
    layout(opts?: { out?: string }): Promise<Screen>;
    screenshot(opts?: { out?: string }): Promise<{ path: string; result: ActionResult }>;
    window(filter?: WindowFilter, opts?: WindowOptions): Promise<WindowResult>;
    apps(): Promise<AppInfo[]>;
    inspect(opts?: { out?: string; html?: string }): Promise<InspectResult>;
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
    scrollUntil(target: string | On | { text: string }, opts?: ListOptions & { timeoutMs?: number }): Promise<ActionResult>;
  }
  export interface CastApi {
    open(opts?: Omit<CastOptions, "mode">): Promise<CastClient>;
    record(opts: Omit<CastOptions, "mode" | "outputPath"> & { out: string }): Promise<{ path: string; stop(): Promise<string | null> }>;
    configure(settings: Partial<CastSettings>): Promise<CastSettings>;
  }
  export interface ViewApi {
    open(opts?: { port?: number; host?: string; privacy?: boolean; layout?: boolean; open?: boolean }): Promise<{ url: string; port: number; close(): Promise<void> }>;
  }
  export interface GovernApi {
    readonly policy: Policy;
    readonly approvals: { pending(): PendingApproval[]; decide(id: string, d: ApprovalDecision, opts?: { scope?: ApprovalScope; reason?: string }): DecisionResult };
    readonly lease: { assert(): Promise<void>; info(): Promise<LeaseInfo | null>; hold(reason?: string): Promise<HoldResult>; resume(): Promise<boolean> };
    readonly trace: TraceRecorder | null;
    recent(limit?: number): Promise<TraceRecord[]>;
  }
  ```
- Root runtime exports exactly: `connect, connectDevice, Session, Device, tagOf, VERSION`, all 13 error classes. Root type exports: `ConnectOptions, SessionOptions, DeviceOptions, Screen, ScreenElement, ActionResult, ActionStatus, Target, TapOptions, TypeOptions, ObserveApi, ActApi, WaitApi, CastApi, ViewApi, GovernApi, PendingApproval, LeaseInfo, CastSettings, ViewerHandle`. Nothing else at root.
- Subpaths:
  - `./commands`: `COMMANDS, CommandRunner, parseArgv, exitCodeForError`, `RunResult`, `RunnerOptions`, `CommandSpec`, `ParsedArgv`, `CoreSession` type.
  - `./cast`: `createCast, CastClient, CastOptions, JpegFrame, CastConfig, castConfigPath, CastSettings, Recording, FpsMeter, resolveCastingExtension, CASTING_EXTENSION, H264CastClient, WsCastClient, MjpegCastClient`.
  - `./viewer`: `startViewerServer, ViewerServer, ViewerSource, ViewerServerOptions, ViewerFeatures, ViewerHooks, renderPlayerPage, PLAYER_HTML, createViewerSource, openInput, originAllowed, LiveState`, viewer/input types.
  - `./govern`: `Policy, Approvals, Grants, Lease, readLease, holdDevice, handoffDevice, resumeDevice, readHold, resolveTag, HOLD_TASK, TraceRecorder, readRecentTrace`, governance types.
  - `./drivers`: `ControlDriver, AgentDriver, Device, HypiumDriver, Gesture, HYPIIUM_CATALOG, shellCommand?`, hypium types.

- [ ] **Step 1: Write the failing API test**

```ts
// test/unit/api.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { connect } from "../../src/api.js";
import { Device } from "../../src/driver/device.js";

describe("connect", () => {
  it("returns a session whose observe namespace reads the screen", async () => {
    const device = fakeDevice(); // same fake as session.test.ts
    vi.spyOn(Device, "connect").mockResolvedValue(device as never);
    const session = await connect({ stateDir: mkdtempSync(join(tmpdir(), "uitest-api-")), lease: false, noTrace: true });
    const screen = await session.observe.layout();
    expect(screen.bundle).toBe("com.demo");
    expect(session.observe).toBeTypeOf("function");
    await session.close();
  });
  it("disposes the device when the session cannot open", async () => {
    const dispose = vi.fn(async () => undefined);
    vi.spyOn(Device, "connect").mockResolvedValue({ dispose } as never);
    await expect(connect({ lease: false })).rejects.toThrow();
    expect(dispose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/api.test.ts`
Expected: FAIL — no `src/api.js`.

- [ ] **Step 3: Implement the facade**

`connect` = `Device.connect(opts)` → `CoreSession.open(device, opts)` → facade; on failure dispose the device. `observe` is a callable `Object.assign(bound, { layout, screenshot, window, apps, inspect })`. Each namespace method delegates to the existing `CoreSession` method or a thin helper (default paths for screenshot/inspect). `view.open` constructs a source via `createViewerSource` and calls `startViewerServer`, returning a handle whose `close()` closes the server only (not the session); reject `view.open` when `layout` is false but inspect requested, and render `PLAYER_HTML`.
`govern.lease.hold/resume` use `holdDevice`/`resumeDevice` with `stateDir`/`tag`; `govern.recent` uses `readRecentTrace`.

- [ ] **Step 4: Move `parseArgv`**

Create `src/operations/argv.ts` with `ParsedArgv` and `parseArgv` (including a new `positionals: string[]` field while preserving every existing field). `cli-main.ts` imports and re-exports them for compatibility. Add a test that `parseArgv(["approvals","allow","abc123"])` yields `{ command: "approvals", positionals: ["allow","abc123"] }`.

- [ ] **Step 5: Trim the barrel and add subpaths**

Rewrite `src/index.ts` to the exact list above. Create the five export files. Add the `exports` map to `package.json` with types+import for each subpath. Rewrite `package-entry.test.ts` to assert: every root name in the expected set resolves at runtime, no duplicate exports, root runtime count ≤ 20, and each subpath imports successfully via `import("../../src/exports/....js")`.

- [ ] **Step 6: Run API, package-entry, CLI tests and the suite**

Run: `npx vitest run test/unit/api.test.ts test/unit/package-entry.test.ts test/unit/cli-main.test.ts && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): category-shaped API and explicit subpath exports

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 10: Layer checker as CI guard

**Files:**
- Create: `scripts/check-layers.mjs`, `test/unit/check-layers.test.ts`
- Modify: `package.json` scripts, `.github/workflows/pages.yml`

**Interfaces:**
- Produces: `checkLayers(root: string): string[]` (list of violations, empty is clean) and a CLI that prints `layers ok` or the first violation.
- Rules: no source under `packages/core` imports a product specifier; no product imports another product; no `uitest-sdk/dist/` or `/src/` deep import; product dependencies in package.json are only `uitest-sdk` plus declared runtime libs; core has no bin/MCP/skill source.

- [ ] **Step 1: Write the failing checker test**

```ts
// test/unit/check-layers.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkLayers } from "../../scripts/check-layers.mjs";

describe("checkLayers", () => {
  it("reports a core import of a product package", () => {
    const root = mkdtempSync(join(tmpdir(), "uitest-layers-"));
    mkdirSync(join(root, "packages/core/src"), { recursive: true });
    writeFileSync(join(root, "packages/core/src/bad.ts"), 'import "uitest-phone";\n');
    expect(checkLayers(root)).toContain("packages/core/src/bad.ts imports uitest-phone");
  });
  it("accepts a product importing a core subpath", () => {
    const root = mkdtempSync(join(tmpdir(), "uitest-layers-"));
    mkdirSync(join(root, "packages/phone/src"), { recursive: true });
    writeFileSync(join(root, "packages/phone/src/good.ts"), 'import { connect } from "uitest-sdk";\nimport { COMMANDS } from "uitest-sdk/commands";\n');
    expect(checkLayers(root)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/check-layers.test.ts`
Expected: FAIL — no checker.

- [ ] **Step 3: Implement the checker**

Scan `packages/*/src/**/*.ts` for static `from "..."` / `import "..."` / `export ... from "..."` specifiers. Parse each `packages/*/package.json` dependency names. Return violations in a deterministic order. The CLI runs it against the repo root.

- [ ] **Step 4: Wire it into scripts and CI**

Add `"check:layers": "node scripts/check-layers.mjs"` to root scripts. In `.github/workflows/pages.yml`, run it in the test job after the build, and run `node scripts/check-site.mjs` in the test job as well (it currently only runs on deploy). At this point the packages do not exist yet, so the checker accepts an empty/missing `packages/` tree and only the unit test exercises rules; the real-tree run is required from Task 11 onward.

- [ ] **Step 5: Run the test and the checker**

Run: `npx vitest run test/unit/check-layers.test.ts && node scripts/check-layers.mjs`
Expected: PASS and `layers ok`.

- [ ] **Step 6: Device smoke on the refactored single package**

```bash
unset HDC_SERVER_PORT
npx tsx -e "import('./src/api.js').then(async ({ connect }) => { const s = await connect({ stateDir: '.work-bench/smoke', lease: false, noTrace: true }); console.log((await s.observe.layout()).bundle); await s.close(); })"
npm run test:device
```
Expected: the calculator/e2e bundle prints, device tests pass. (This is the spec's stage-1 "对外行为不变" check.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test(arch): enforce package dependency edges in CI

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 11: npm workspaces and the core package

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/tsconfig.test.json`, `packages/core/README.md`, `packages/core/docs/api.md`, `packages/core/examples/quickstart.mjs`, `packages/core/LICENSE`, `packages/core/NOTICE`, `packages/core/CHANGELOG.md`, `packages/core/SECURITY.md`
- Move: `src/` → `packages/core/src/`; `assets/` native files → `packages/core/assets/`; `test/` → `packages/core/test/`; `docs/api.md` → `packages/core/docs/api.md`; `examples/quickstart.mjs` → core
- Stash for later packages: product sources (`bin.ts`, `cli-main.ts`, `mcp.ts`, `mcp-register.ts`, `install-skill.ts`, `connect.ts`, `live/cli.ts`) → `.product-hold/`; their tests (`cli-main`, `mcp`, `mcp-register`, `connect`, `install-skill`, `live-cli`, `live-cli-wiring`) → `.product-test-hold/`
- Modify: root `package.json` (private workspaces), `tsconfig*.json`, `vitest.config.ts`, lockfile, `.github/workflows/pages.yml`, `scripts/check-site.mjs`, `scripts/gen-api-page.mjs`, `scripts/*.ts`

**Interfaces:**
- Produces: root private monorepo with `workspaces: ["packages/*"]`; `packages/core/package.json` name `uitest-sdk`, version `0.10.0`, no `bin`, exports map from Task 9, files `dist/assets/docs/api.md/examples/NOTICE/CHANGELOG.md/SECURITY.md/README.md/LICENSE`, deps `@grpc/grpc-js`, `@grpc/proto-loader`, `jpeg-js`.
- Moves preserve relative import validity: `src` and `test` move together under `packages/core`, so `../../src/...` still resolves.

- [ ] **Step 1: Create the package skeleton**

Write `packages/core/package.json` (no bin; `main`/`types`/`exports` as in Task 9; scripts `build` = `tsc && node -e "...copy scrcpy.proto..."`, `test` = `vitest run`, `typecheck` = `tsc --noEmit`, `typecheck:tests` = `tsc -p tsconfig.test.json`, `prepublishOnly` = `npm run build && npm test`). Write the two tsconfigs with `rootDir: src`, `outDir: dist`.

- [ ] **Step 2: Move the tree**

```bash
mkdir -p packages/core
git mv src packages/core/src
git mv test packages/core/test
git mv assets/arm64 packages/core/assets/arm64
git mv assets/x86_64 packages/core/assets/x86_64
git mv assets/manifest.json packages/core/assets/manifest.json
git mv docs/api.md packages/core/docs/api.md
git mv examples packages/core/examples
git mv LICENSE NOTICE CHANGELOG.md SECURITY.md README.md packages/core/
```

Move `assets/skill` to a temporary root stash for Task 12 (`git mv assets/skill .skill-hold`), then delete `assets/` if empty. Move the product sources and their tests out of core so the core tarball cannot contain them:

```bash
mkdir -p .product-hold .product-test-hold
git mv packages/core/src/bin.ts packages/core/src/cli-main.ts packages/core/src/mcp.ts \
       packages/core/src/mcp-register.ts packages/core/src/install-skill.ts \
       packages/core/src/connect.ts packages/core/src/live/cli.ts .product-hold/
git mv packages/core/test/unit/cli-main.test.ts packages/core/test/unit/mcp.test.ts \
       packages/core/test/unit/mcp-register.test.ts packages/core/test/unit/connect.test.ts \
       packages/core/test/unit/install-skill.test.ts packages/core/test/unit/live-cli.test.ts \
       packages/core/test/unit/live-cli-wiring.test.ts .product-test-hold/
```

Remove the now-empty `packages/core/src/live/` directory. Update `defaultExtensionDir()` to `new URL("../../assets", import.meta.url)` (from `src/driver` and `dist/driver`).

- [ ] **Step 3: Root monorepo config**

Root `package.json`: `"name": "uitest-monorepo"`, `"private": true`, `"workspaces": ["packages/*"]`, engines, scripts:
```json
{
  "build": "npm run build -w uitest-sdk",
  "test": "npm run build -w uitest-sdk && vitest run",
  "test:device": "vitest run packages/core/test/device",
  "typecheck": "npm run build -w uitest-sdk && npm run typecheck -ws --if-present",
  "typecheck:tests": "npm run build -w uitest-sdk && npm run typecheck:tests -ws --if-present",
  "check:site": "node scripts/check-site.mjs",
  "check:layers": "node scripts/check-layers.mjs"
}
```
Root devDeps: typescript, vitest, tsx, @types/node. Regenerate `package-lock.json` with `npm install`.

- [ ] **Step 4: Vitest and tsconfig**

Root `vitest.config.ts`: include `packages/*/test/**/*.test.ts`, `maxWorkers: 1`, `minWorkers: 1`. Root `tsconfig.json` for scripts: `noEmit`, include `scripts/**/*.ts`, module NodeNext. Remove the old root `tsconfig.test.json` or make it forward to the package.

- [ ] **Step 5: Fix tooling paths**

`check-site.mjs` imports `packages/core/dist/version.js` and `packages/core/dist/hypium/catalog.js`. `gen-api-page.mjs` reads the same. `scripts/acceptance.ts` and other scripts import `uitest-sdk` (built) and subpaths instead of `../src/...`; update generated snippet import paths to `uitest-sdk`. `package-docs.test.ts` runs `npm pack --dry-run --json` with `cwd: packages/core` and expects no `bin`, no `assets/skill`, no `dist/bin.js`. `site-main.test.ts` resolves the repo root as `../../../..` from `packages/core/test/unit`.

- [ ] **Step 6: Verify the core package**

```bash
npm install
npm run build
npm run typecheck
npm run typecheck:tests
npm test
node scripts/check-site.mjs
node scripts/check-layers.mjs
npm pack --workspace uitest-sdk --dry-run --json
```
Expected: all green; the tarball lists no `bin`, `assets/skill`, `dist/bin.js`, `dist/mcp.js`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "build: npm workspaces and the uitest-sdk 0.10 core package

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 12: `uitest-phone` headless agent package

**Files:**
- Create: `packages/phone/package.json`, `tsconfig.json`, `tsconfig.test.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, `SECURITY.md`
- Move: `.product-hold/{bin,cli-main,mcp,mcp-register,install-skill,connect}.ts` → `packages/phone/src/`; `.skill-hold` → `packages/phone/assets/skill/`; `.product-test-hold/{cli-main,mcp,mcp-register,connect,install-skill}.test.ts` → `packages/phone/test/unit/`
- Modify: `packages/phone/src/{version.ts,cli-main.ts,mcp.ts,connect.ts,install-skill.ts,bin.ts}`; root build/test scripts; CI

**Interfaces:**
- Produces: bin `uitest-phone` → `packages/phone/dist/bin.js`; version 0.10.0; dependency `uitest-sdk: "~0.10.0"` + `jsonc-parser`; no native assets, no web assets.
- `--version` prints `uitest-phone <phone VERSION> (uitest-sdk <core VERSION>)`; MCP `serverInfo.name = "uitest-phone"`, version = phone VERSION; connect npx fallback `npx -y uitest-phone@<version> mcp`; skill marker `package: "uitest-phone"` with migration from `"uitest-sdk"` markers (adopt + refresh when digests match, keep hand-edited copies).
- `runCommand` uses `connect()` from core and passes `session.core` + `session.device` to `CommandRunner`; `bin.ts` dispatches `mcp`, `connect`, `install-skill`, `hold`, `handoff`, `resume`, `approvals` (Task 13), and prints a migration message for `live`:
  `live moved to uitest-console · npm i -g uitest-console · uitest-console` (exit 1).

- [ ] **Step 1: Write the failing package identity test**

```ts
// packages/phone/test/unit/identity.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/version.js";
import { toolDefinitions } from "../../src/mcp.js";

describe("uitest-phone identity", () => {
  it("reports the phone version, not the core version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
  it("generates one MCP tool per core command", () => {
    expect(toolDefinitions()).toHaveLength(21);
    expect(toolDefinitions()[0]?.name).toMatch(/^uitest_/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/phone/test/unit/identity.test.ts`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Create the package and move the product files**

Write `packages/phone/package.json` (`bin: {"uitest-phone": "dist/bin.js"}`, files `dist/assets/NOTICE/CHANGELOG.md/SECURITY.md/README.md/LICENSE`, engines node>=20). Add the phone's own `CHANGELOG.md` (0.10.0 migration from 0.9.4), `SECURITY.md` (approval trust boundary, serial hygiene) and `LICENSE`. Move the six source files and the skill assets; restore the five stashed tests. Update imports from `../src/...` to `uitest-sdk` subpaths:
```ts
import { connect } from "uitest-sdk";
import { COMMANDS, CommandRunner, parseArgv, exitCodeForError } from "uitest-sdk/commands";
import { holdDevice, resumeDevice } from "uitest-sdk/govern";
```
`src/version.ts` reads `../package.json`; also export `CORE_VERSION` (import from `uitest-sdk`).

- [ ] **Step 4: Fix CLI wiring and identity strings**

`commands.ts` stays in core. `cli-main.ts`'s `runCommand` uses `connect()`; `main` keeps the same exit-code mapping. `bin.ts` refreshSkill uses the phone's version and assets. `connect.ts` writes `npx -y uitest-phone@${VERSION} mcp`. Add the `live` migration message. Update `formatHelp` to list the phone commands and the new non-command verbs.

- [ ] **Step 5: Update root scripts and CI**

Root `build` adds `npm run build -w uitest-phone` after core; `test` builds core then runs vitest (product tests import core dist); `typecheck`/`typecheck:tests` include workspaces. CI `npm ci && npm run build && npm run typecheck && npm run typecheck:tests && npm test`.

- [ ] **Step 6: Verify with a clean-room install**

```bash
npm install
npm run build
npm test
mkdir -p .work-bench/phone-clean && cd .work-bench/phone-clean && rm -rf node_modules package.json
npm init -y >/dev/null && npm i ../../packages/phone/dist/../.. --no-save # use npm pack below instead
```

Use the correct form:
```bash
npm pack --workspace uitest-sdk --pack-destination .work-bench
npm pack --workspace uitest-phone --pack-destination .work-bench
cd .work-bench/phone-clean
npm init -y >/dev/null
npm i ../uitest-sdk-0.10.0.tgz ../uitest-phone-0.10.0.tgz
npx uitest-phone --version
npx uitest-phone doctor --json || true   # no device needed to prove the CLI loads
```
Expected: version line `uitest-phone 0.10.0 (uitest-sdk 0.10.0)`; tarball of core has no `bin`; phone tarball has no `.so`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(phone): headless uitest-phone package on core 0.10

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 13: `uitest-phone approvals` and the fail-closed flow

**Files:**
- Create: `packages/phone/src/approvals.ts`, `packages/phone/test/unit/approvals-cli.test.ts`, `scripts/check-skill.mjs`
- Modify: `packages/phone/src/bin.ts`, `packages/phone/src/cli-main.ts` (status pending), `packages/phone/assets/skill/{SKILL,REFERENCE}.md`, root CI

**Interfaces:**
- Produces:
  ```
  uitest-phone approvals list [--json] [--state-dir dir] [--tag tag]
  uitest-phone approvals allow <id> [--scope once|task|always] [--yes] [--reason text]
  uitest-phone approvals deny <id> [--yes] [--reason text]
  ```
  `allow` requires an interactive TTY confirmation unless `--yes`; non-TTY without `--yes` exits 2 with `approval_refused · --yes is required when no terminal is attached`. Success prints `allowed <id>` / `denied <id>`. Listing scans `<state-dir>/approvals/*/` and prints `id`, command, bundle, rule, age, expiry; `--json` emits an array.
- `status` includes pending approvals. Skill text: "approval_pending means stop and ask the person; never call approvals yourself; the id expires in 60 s; retry only after the person says it was allowed."
- `scripts/check-skill.mjs` imports `COMMANDS` from `uitest-sdk/commands`, extracts the command table from `SKILL.md`/`REFERENCE.md`, and fails on missing/extra command names. Run in CI.

- [ ] **Step 1: Write the failing cross-process test**

```ts
// packages/phone/test/unit/approvals-cli.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Approvals } from "uitest-sdk/govern";

const bin = join(import.meta.dirname, "..", "..", "dist", "bin.js");

it("allows a pending id from a second process without the agent holding a decision", () => {
  const state = mkdtempSync(join(tmpdir(), "uitest-phone-cli-"));
  const store = new Approvals({ dir: join(state, "approvals", "7544d645") });
  const pending = store.request({ command: "tap", args: { text: "删除" }, signature: "sig" }, "deletes", { bundle: "com.demo", task: "t" });
  const out = execFileSync(process.execPath, [bin, "approvals", "allow", pending.id, "--yes", "--state-dir", state], { encoding: "utf8" });
  expect(out).toContain(`allowed ${pending.id}`);
  expect(store.consume(pending.id, { command: "tap", args: { text: "删除" }, signature: "sig" }).kind).toBe("approved");
});
it("refuses allow without --yes when no TTY is attached", () => {
  // spawnSync with stdio pipes, expect exit 2 and approval_refused
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build -w uitest-phone && npx vitest run packages/phone/test/unit/approvals-cli.test.ts`
Expected: FAIL — unknown command `approvals`.

- [ ] **Step 3: Implement the CLI**

Use core `Approvals` with `{dir: join(stateDir, "approvals", tag)}`; resolve the tag by scanning directories when `--tag` is absent. `list` and `allow/deny` never connect to a device. `allow --scope` writes the scope into the decision file via `decide(..., {scope, by:"cli"})`. `--reason` is stored on deny.

- [ ] **Step 4: Update status, skill and the checker**

`CommandRunner.status` already includes pending from Task 5. Update `SKILL.md`/`REFERENCE.md` command table and approval prose; add `check-skill.mjs` with a fixture test that a missing command fails. Run:
`node scripts/check-skill.mjs`
Expected: `skill ok`.

- [ ] **Step 5: Run the tests and the suite**

Run: `npx vitest run packages/phone/test/unit/approvals-cli.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(phone): approvals CLI and fail-closed agent guidance

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 14: `uitest-console` package

**Files:**
- Create: `packages/console/package.json`, `src/bin.ts`, `src/cli.ts`, `src/page.ts`, `src/server.ts`, `src/window.ts`, `README.md`, `LICENSE`, `CHANGELOG.md`, `SECURITY.md`
- Move: `.product-hold/live/cli.ts` → `packages/console/src/viewer-cli.ts` (the reusable parts are already in `createViewerSource`); `.product-test-hold/{live-cli,live-cli-wiring}.test.ts` → `packages/console/test/unit/`
- Test: `packages/console/test/{cli,page,server,window}.test.ts`

**Interfaces:**
- Produces: bin `uitest-console` → `dist/bin.js`; version 0.1.0; dependency `uitest-sdk: "~0.10.0"`; no native assets.
- CLI:
  ```
  uitest-console [--device <id>] [--state-dir <dir>] [--port 7042] [--host 127.0.0.1]
                 [--transport grpc|ws|mjpeg] [--no-open] [--privacy on|off]
                 [--task console] [--record <file>]
  ```
- `createConsoleServer({session, device, approvals, stateDir, port, host})` starts `startViewerServer` with:
  - `page: renderPlayerPage({title:"uitest-console", extraHtml: CONSOLE_HTML, extraScript: CONSOLE_SCRIPT})`
  - `hooks.onMessage` handling:
    - `console:approvals:list` → `{type:"console:approvals", items: approvals.pending()}`
    - `console:approvals:decide` → `approvals.decide(id, decision, {by:"console", scope, reason})` then a refreshed list
    - `console:hold` → `holdDevice({stateDir, tag, reason:"console takeover"})`; reply `{type:"console:held", held:true, tookOverFrom}`
    - `console:resume` → `resumeDevice({stateDir, tag})`; reply `{type:"console:held", held:false}`
    - `console:activity` → `readRecentTrace(stateDir, {limit:20})`; reply `{type:"console:activity", items}`
  - The console session opens with `lease: false`; it never asserts the lease for reads. Hold/resume are the only lease writes.
- Page extension: an approvals panel (id `#inbox`) with a list and Allow/Deny buttons, a Hold/Resume button, and an activity list; uses `window.uitestViewer.send`/`on`; polls `console:approvals:list` every 2 s while idle; renders all fields with `textContent`, never `innerHTML`.
- `window.ts` exports `appWindowCommand(browser: "edge"|"chrome", url: string): {command: string; args: string[]}` and `openWindow(url, title)`; Windows Edge `msedge.exe --app=<url> --window-size=1100,900`, Chrome equivalent; fallback prints the URL.

- [ ] **Step 1: Write the failing page/hook tests**

```ts
// packages/console/test/page.test.ts
import { describe, expect, it, vi } from "vitest";
import { CONSOLE_HTML, CONSOLE_SCRIPT } from "../src/page.js";

it("renders approval fields as text, never HTML", () => {
  const rendered = renderApprovalRow({ id: "a1", command: "tap", bundle: "<img src=x onerror=alert(1)>", rule: "deletes", expiresAt: Date.now() + 60_000 });
  expect(rendered).not.toContain("<img");
  expect(rendered).toContain("&lt;img");
});
```
(Implement `renderApprovalRow` in `src/page.ts` as a pure function used by the script string; the test drives it directly.)

```ts
// packages/console/test/server.test.ts
it("allows a pending approval over the viewer socket", async () => {
  // start fake viewer source + console hooks; send console:approvals:list; expect items
  // send console:approvals:decide allow; expect store decision
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/console/test/page.test.ts packages/console/test/server.test.ts`
Expected: FAIL — package missing.

- [ ] **Step 3: Scaffold and implement**

Create `package.json` (bin `uitest-console`, files `dist/README/LICENSE`, dep `uitest-sdk`), tsconfigs. `cli.ts`: parse flags, `connect({device, stateDir, task:"console", lease:false})`, build the source with `createViewerSource` (recording enabled when `--record`), start `createConsoleServer`, open the browser or print the URL, handle SIGINT to close. On startup print `uitest-console <version> · <url> · device <tag>`.

- [ ] **Step 4: Implement `page.ts` and `window.ts`**

The page extension is a constant string; `renderApprovalRow` escapes with a local `escapeHtml`. Buttons: Allow (`scope` select once/task/always), Deny (reason prompt), Hold, Resume. Activity list read-only. Hold state shows a red banner "You have the phone · agents are paused".

- [ ] **Step 5: Tests**

Test the hooks with an in-process viewer server and a fake source; test the page row escaping and the window command builder. Run:
`npx vitest run packages/console/test && npm test`
Expected: PASS.

- [ ] **Step 6: Clean-room pack**

```bash
npm run build
npm pack --workspace uitest-console --pack-destination .work-bench
cd .work-bench/console-clean && npm init -y >/dev/null && npm i ../uitest-sdk-0.10.0.tgz ../uitest-console-0.1.0.tgz
npx uitest-console --help
```
Expected: help text lists the flags; no native `.so` in the console tarball.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(console): local web console with takeover and approval inbox

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 15: Docs, site package sections, and the checkers

**Files:**
- Modify: `packages/core/README.md`, `packages/core/docs/api.md`, `packages/phone/README.md`, `packages/console/README.md`, root `README.md`, `CHANGELOG.md` (each package), `site/index.html`, `site/docs.html`, `site/changelog.html`, `scripts/check-site.mjs`, `scripts/gen-api-page.mjs`, `packages/core/test/unit/{package-docs,site-main}.test.ts`

**Interfaces:**
- Produces: docs describe four packages/2 products, install commands `npm i uitest-sdk`, `npm i -g uitest-phone`, `npm i -g uitest-console`; `docs/api.md` covers only core's public API; CHANGELOG 0.10.0 migration table (core no bin, `Device.createCast`→`uitest-sdk/cast`, `openInputLane`→`uitest-sdk/viewer`, `uitest-phone live`→`uitest-console`); site nav links each package page and the acceptance hub.

- [ ] **Step 1: Write the failing docs test**

Add to `package-docs.test.ts`: core tarball has no `bin`; core docs do not mention `uitest-sdk mcp|install-skill|live` as core commands; phone README contains the 21-command table and the approvals flow; console README contains hold/inbox.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/unit/package-docs.test.ts`
Expected: FAIL — docs still describe the single package.

- [ ] **Step 3: Rewrite the docs**

Core `docs/api.md`: `connect`, session namespaces, subpaths, errors, approval model, viewer options. Phone `README`: install, MCP/skill/connect, 21 commands, approvals CLI, migration from 0.9.4. Console `README`: install, URL, hold/resume, inbox, activity, security (local only; `--host` warning). Root `README`: repo map, dev commands, release order.

- [ ] **Step 4: Update the site**

Replace single-package install needles with the three packages. Update `site/docs.html` API examples to `connect()`/namespaces and link `uitest-sdk/{commands,cast,viewer,govern,drivers}`. Add a "packages" section to `index.html`. Update `check-site.mjs` needle lists accordingly; keep the historical 0.9.4 content under the changelog. `gen-api-page.mjs` reads `packages/core/dist`.

- [ ] **Step 5: Run the checkers and tests**

Run: `npm test && node scripts/check-site.mjs && node scripts/check-skill.mjs && node scripts/check-layers.mjs`
Expected: all green (`site ok`, `skill ok`, `layers ok`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs(site): document core, phone and console as separate packages

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 16: Core acceptance report with screenshots

**Files:**
- Create: `scripts/screenshot.mjs`, `scripts/gen-acceptance-pages.mjs`, `scripts/acceptance-core.ts`
- Modify: `scripts/acceptance.ts` (public imports, evidence dir), `scripts/acceptance-security.ts`, `packages/core/test/device/acceptance.helpers.ts`, `scripts/check-site.mjs`, `site/acceptance.html` (becomes the hub), `site/acceptance-0.9.4.html` (moved from the old acceptance.html)
- Output: `docs/acceptance/core-0.10.0/{report.json,report.md,screenshots,logs,scripts}`, `site/acceptance-core-0.10.0.html`, `site/assets/acceptance/core-0.10.0/*`, `site/acceptance.html` (hub)

**Interfaces:**
- Produces: `report.json` schema used by every product report:
  ```ts
  interface AcceptanceReport {
    product: "core" | "phone" | "console" | "mirror";
    version: string;
    date: string;             // YYYY-MM-DD
    commit: string;           // git HEAD
    devices: { tag: string; model: string; resolution: string }[];
    cases: { id: string; title: string; status: "pass" | "fail" | "skip"; detail: string; screenshots: string[] }[];
    summary: { passed: number; failed: number; skipped: number };
    rerun: string[];
    issues: string[];
  }
  ```
- `scripts/screenshot.mjs` exports `capturePage({url, out, width, height, waitFor, timeoutMs})`: starts headless Chrome/Edge with `--remote-debugging-port=<free>`, navigates, polls `Runtime.evaluate` for `waitFor` (default `window.uitestViewer && document.querySelector("canvas")`), calls `Page.captureScreenshot`, kills Chrome it started.
- `scripts/gen-acceptance-pages.mjs` also owns the site acceptance structure: it scans `docs/acceptance/*/report.json`, writes one `site/acceptance-<product>-<version>.html` per report, and writes the hub `site/acceptance.html` listing every report plus the historical `acceptance-0.9.4.html`. Missing or failed reports stay visible as "missing" cards; the generator exits 1 if a report version disagrees with its package.json.
- `acceptance-core.ts`: 16 capability closures on both targets + viewer browser screenshots (mirror, inspect panel, privacy on/off) + security handshake results (7 + 400 + 404) + `npm pack` core smoke. All imports from `uitest-sdk` and `uitest-sdk/viewer`; no `src/`.

- [ ] **Step 1: Write the failing report generator test**

```ts
// packages/core/test/unit/gen-acceptance.test.ts
import { describe, expect, it } from "vitest";
import { renderReportPage } from "../../../../scripts/gen-acceptance-pages.mjs";

const fixture = {
  product: "core" as const, version: "0.10.0", date: "2026-11-18", commit: "abc1234",
  devices: [{ tag: "7544d645", model: "tablet", resolution: "1600x2560" }],
  cases: [{ id: "c1", title: "connect", status: "pass" as const, detail: "ok", screenshots: ["connect-7544d645.jpg"] }],
  summary: { passed: 1, failed: 0, skipped: 0 }, rerun: ["npx tsx scripts/acceptance-core.ts"], issues: [],
};
it("fails when a report has no screenshot", () => {
  expect(() => renderReportPage({ ...fixture, cases: [{ ...fixture.cases[0]!, screenshots: [] }] })).toThrow(/screenshot/);
});
it("escapes product text in the page", () => {
  const html = renderReportPage({ ...fixture, cases: [{ ...fixture.cases[0]!, title: "<script>x</script>" }] });
  expect(html).toContain("&lt;script&gt;");
});
```

Add `scripts/gen-acceptance-pages.d.mts` declaring `renderReportPage` so `typecheck:tests` can import the `.mjs` from TypeScript.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/unit/gen-acceptance.test.ts`
Expected: FAIL — no generator.

- [ ] **Step 3: Implement the generator and screenshot helper**

`renderReportPage(report, images)` produces a deterministic HTML page: header with product/version/date/commit, summary tiles, device table (tags only), cases table with status pills and `<img>` thumbnails, rerun commands, issues. It throws if a case has no screenshot (every non-skip case must carry one; the report as a whole must carry at least two). It copies images from `docs/acceptance/<product>-<version>/screenshots/` to `site/assets/acceptance/<product>-<version>/` when run as a CLI. The same run writes the hub. Move the old acceptance page first:

```bash
git mv site/acceptance.html site/acceptance-0.9.4.html
# keep its content, change its title/version to 0.9.4, and make its top nav point at acceptance.html
```

Generalise `check-site.mjs`: register `acceptance-0.9.4.html` with its existing anchors/row-count/needle checks; then for every `docs/acceptance/*/report.json`, require `site/acceptance-<product>-<version>.html`, verify the product/version/summary text, every referenced image exists and is a complete JPEG ≥20 KB, no serial-like token, and a link back to `acceptance.html`; require the hub to link every report page and the legacy page; require every other page to link `href="acceptance.html"`. Derive versions from `packages/*/package.json` so a version bump without a report fails the check.

- [ ] **Step 4: Adapt the core acceptance script**

Use `connect()`/`observe`/`act`/`cast`/`view` public APIs. Keep the 16 capability names. Evidence root `docs/acceptance/core-0.10.0`. Start a viewer with `session.view.open({layout:true})`; use `capturePage` to save `viewer-mirror.png`, `viewer-inspect.png`, `viewer-privacy.png`. Run the security script against `startViewerServer`; record cases. Stage the calculator before captures and restore the foreground app.

- [ ] **Step 5: Run on both devices**

```bash
unset HDC_SERVER_PORT
npx tsx scripts/acceptance-core.ts --targets <tag-or-serial-A>,<tag-or-serial-B>  # never commit the serials
node scripts/gen-acceptance-pages.mjs
node scripts/check-site.mjs
```
Expected: `docs/acceptance/core-0.10.0/report.json` with 16/16 capability cases and ≥3 browser screenshots per device or one device + viewer; `site/acceptance-core-0.10.0.html` exists; check-site green.

- [ ] **Step 6: Inspect every screenshot**

Open each image (Read tool / image viewer). Reject any with notifications, account data, chat or third-party profiles; recapture after staging the calculator. Only then copy to `site/`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test(core): 0.10.0 acceptance report with browser and device screenshots

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 17: Phone acceptance report with screenshots

**Files:**
- Create: `scripts/acceptance-phone.ts`
- Output: `docs/acceptance/phone-0.10.0/*`, `site/acceptance-phone-0.10.0.html`, `site/assets/acceptance/phone-0.10.0/*`

**Interfaces:**
- Cases: install from tarball, 21 commands on both devices (screenshot after each visual step), MCP `tools/list` = 21 and one `tools/call`, skill install/refresh into a temp HOME, approvals: pending → replay-without-decision still pending → console/CLI deny → retry denied → allow → retry settled → second replay denied (self-approval impossible), hold → agent `lease_held` → resume → continue, `live` migration message. Each case records a device screenshot where it changes the screen; approval cases record the calculator before/after.

- [ ] **Step 1: Write the failing smoke test**

A `packages/phone/test/unit/acceptance-shape.test.ts` asserting the report schema: product `phone`, version `0.10.0`, ≥21 cases, every non-skip case has ≥1 screenshot path, no serial-like token in `report.json`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/phone/test/unit/acceptance-shape.test.ts`
Expected: FAIL — no report.

- [ ] **Step 3: Implement and run**

Use `node packages/phone/dist/bin.js` (built from the tarball) with `--state-dir .work-bench/accept-phone`, `--device <id>`. Capture screenshots through core's `connect()` (direct agent screenshot) to keep evidence off personal screens. Generate the page.

- [ ] **Step 4: Visual inspection and check-site**

Read every screenshot; reject personal data; run `node scripts/check-site.mjs`. Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(phone): 0.10.0 acceptance report and device screenshots

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 18: Console acceptance report with browser screenshots

**Files:**
- Create: `scripts/acceptance-console.ts`
- Output: `docs/acceptance/console-0.1.0/*`, `site/acceptance-console-0.1.0.html`, `site/assets/acceptance/console-0.1.0/*`

**Interfaces:**
- Cases: console starts on both devices; mirror frame arrives; inspect panel shows element rows; privacy switch masks credentials; approval inbox shows a pending item created by a gated action (`--confirm all`), Allow makes the agent's replay settle; Deny blocks it; Hold makes an agent command return `lease_held` while the console keeps streaming; Resume lets the agent continue; origin handshakes pass (core's one implementation); page has no external requests.
- Evidence: `capturePage` screenshots of mirror, inspect, inbox-pending, inbox-allowed, held banner, resumed; device screenshots of the action result.

- [ ] **Step 1: Write the failing shape test** (same schema; product `console`, version `0.1.0`, ≥8 cases, ≥6 screenshots).
- [ ] **Step 2: Run it to verify it fails.**
- [ ] **Step 3: Implement and run on both devices.**
- [ ] **Step 4: Visual inspection, generate page, check-site.**
- [ ] **Step 5: Commit.**

```bash
git add -A
git commit -m "test(console): 0.1.0 acceptance report with takeover and inbox screenshots

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 19: Release core 0.10.0, phone 0.10.0, console 0.1.0

**Files:**
- Modify: root/package manifests only if a final version/lock change is needed
- Create: git tags; GitHub releases

**Interfaces:**
- Produces: three published npm versions; tags `core-v0.10.0`, `phone-v0.10.0`, `console-v0.1.0`; deployed site with the three reports; a clean-room install proof.

- [ ] **Step 1: Final green run**

```bash
npm install
npm run build
npm run typecheck
npm run typecheck:tests
npm test
node scripts/check-site.mjs
node scripts/check-skill.mjs
node scripts/check-layers.mjs
```

- [ ] **Step 2: Pack and clean-room install**

```bash
npm pack --workspace uitest-sdk --pack-destination .work-bench
npm pack --workspace uitest-phone --pack-destination .work-bench
npm pack --workspace uitest-console --pack-destination .work-bench
# install into three fresh dirs and run --version/help as in Tasks 12/14
```

- [ ] **Step 3: Publish with the token outside the repo**

```bash
TMP_NPMRC=$(mktemp)
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN"
npm publish --workspace uitest-sdk --userconfig "$TMP_NPMRC"
npm publish --workspace uitest-phone --userconfig "$TMP_NPMRC"
npm publish --workspace uitest-console --userconfig "$TMP_NPMRC"
rm -f "$TMP_NPMRC"
npm view uitest-sdk@0.10.0 version
npm view uitest-phone@0.10.0 version
npm view uitest-console@0.1.0 version
```
Expected: 0.10.0, 0.10.0, 0.1.0. If a publish is rejected, read the error and fix without ever writing the token into the repo.

- [ ] **Step 4: Commit, tag, push**

```bash
git add -A
git commit -m "release: core 0.10.0, phone 0.10.0, console 0.1.0

Co-Authored-By: Claude Code <noreply@anthropic.com>"
git tag core-v0.10.0
git tag phone-v0.10.0
git tag console-v0.1.0
git switch master && git merge --ff-only arch/core-products
git push origin master --tags
```

If github.com DNS is poisoned, push with the known fixed IP + schannel one-command workaround (`-c http.curloptResolve=...`, `http.schannelCheckRevoke=false`), without changing global config.

- [ ] **Step 5: GitHub releases**

```bash
gh release create core-v0.10.0 --title "core 0.10.0" --notes "uitest-sdk core: category-shaped API, viewer, governance; no bin."
gh release create phone-v0.10.0 --title "uitest-phone 0.10.0" --notes "Headless agent package: CLI, MCP, skill, approvals CLI."
gh release create console-v0.1.0 --title "uitest-console 0.1.0" --notes "Optional console: mirror, inspect, takeover, approval inbox."
```

- [ ] **Step 6: Verify the live site and packages**

Wait for the Pages workflow; `curl -s https://growvv.github.io/uitest-sdk/ | grep ...` for the new package sections and each acceptance page. Check the npm tarballs with `npm view <pkg> dist.tarball` and a fresh install.

---

### Task 20: Final whole-branch review and fix pass

- [ ] **Step 1: Review package**

Run the executing-plans review-package script on `arch/core-products` vs `master` and dispatch the code reviewer with this plan's Review Focus and the ledger's rulings.

- [ ] **Step 2: Re-grade and fix**

Critical/Important findings get one fix pass; each fix starts with a failing test, ends with a green suite. Minor findings are listed in the final message.

- [ ] **Step 3: Ledger and finish**

Record rulings, deferred minors, and use `superpowers:finishing-a-development-branch`. Plan 2 (`uitest-mirror@0.1.0`) starts after this merge.
