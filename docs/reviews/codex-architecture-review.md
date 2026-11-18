# Architecture and code review — uitest monorepo at 57cfd21

## Verdict
The package boundaries and public API split are broadly sound, and the products correctly depend only on `uitest-sdk`. The biggest risk is lifecycle management: several failure and concurrency paths can leave device daemons, `hdc fport` forwards, recordings, or leases behind, eventually preventing later sessions from working.

## Critical

**A failed agent-daemon startup can strand the daemon it just launched.**

**Where** — `packages/core/src/driver/device.ts:176`

**What** — `Device.connect()` starts a daemon and then awaits `waitForAgent()` before entering the cleanup `try` block at line 183. If the daemon never listens and `waitForAgent()` times out, the newly recorded `ownPid` is never killed.

**Why it matters** — A broken or slow daemon startup can leave an unusable `uitest` process on the phone. Repeated connection attempts can accumulate processes and interfere with the next agent or cast session.

**Fix** — Put daemon startup and readiness polling inside the same resource-acquisition transaction as the port/socket setup, and kill only the daemon identified as owned when readiness fails.

**Cast startup errors after daemon and forward creation leak device resources.**

**Where** — `packages/core/src/cast/ws-client.ts:171`, `packages/core/src/cast/ws-client.ts:186`, `packages/core/src/cast/client.ts:153`, `packages/core/src/cast/client.ts:161`

**What** — Both cast implementations clean up only inside the initial startup `try`. WebSocket record-mode `client.command()` runs after that block, while the gRPC client construction and `beginRecording()` also run after cleanup has ended. Exceptions there bypass daemon killing and `fport` removal.

**Why it matters** — A failed recording start, gRPC construction, or startup command can leave a cast daemon and forward alive. Viewer retries or repeated CLI attempts accumulate orphaned resources and can eventually make casting fail.

**Fix** — Keep the daemon, forward, socket/stub, and record-start operation under one acquisition cleanup scope. Dispose the partially constructed client or explicitly remove the forward and kill the owned daemon on every post-forward failure.

## Important

**`uitest-console --record` does not start recording automatically.**

**Where** — `packages/console/src/cli.ts:150`, `packages/console/src/cli.ts:170`, `packages/core/src/viewer/server.ts:290`, `packages/console/README.md:28`

**What** — The console passes `recordPath` into its source but never passes `recordOnStart: true` to `startViewerServer`. Core defaults `recordOnStart` to false, so the file is created only after somebody presses the page’s Record button.

**Why it matters** — The documented command `uitest-console --record demo.mp4` can run for an hour and produce no recording when the user expects recording to begin immediately.

**Fix** — Treat a supplied record path as an explicit startup-recording request and pass the corresponding viewer option. Add a wiring test that observes the actual server options, not just parsed CLI values.

**The documented second viewer cannot start reliably and can reuse the first viewer’s cast socket.**

**Where** — `packages/core/src/api.ts:313`, `packages/core/src/viewer/source.ts:48`, `packages/core/src/viewer/source.ts:53`, `packages/core/README.md:106`

**What** — Every `session.view.open()` defaults to HTTP port `7000`, despite the README opening a second viewer without specifying another port. Even when a caller supplies a different HTTP port, both sources default their cast socket suffix to `process.pid`, so viewers in one process use the same `uitest_live_<pid>` socket.

**Why it matters** — The second viewer either fails with an address-in-use error or both viewers compete for the same device-side cast daemon and disrupt each other’s stream.

**Fix** — Allocate a distinct HTTP port by default for additional views and generate a unique per-view cast socket suffix. Keep explicit caller-provided ports and socket identifiers supported.

**Concurrent shutdown calls return before cleanup has completed.**

**Where** — `packages/core/src/viewer/server.ts:385`, `packages/core/src/operations/session.ts:948`, `packages/core/src/driver/device.ts:286`

**What** — `ViewerServer.close()` returns immediately when another close is in progress. `Session.release()` and `Device.dispose()` use the same early-return pattern; both mark their state as released/disconnected before asynchronous cleanup finishes.

**Why it matters** — Two callers can race during shutdown, await the second call, and let the process exit while sockets, cast daemons, forwards, leases, or trace writes are still being released.

**Fix** — Store the in-flight cleanup promise and return it from subsequent calls. Make every public close/release/dispose operation idempotent while still joining the first cleanup.

**Manual recording startup is not serialized.**

**Where** — `packages/core/src/viewer/server.ts:1044`, `packages/core/src/viewer/server.ts:1049`, `packages/core/src/cast/record.ts:49`, `packages/core/src/cast/record.ts:56`

**What** — `startRecording()` checks `startingRecording` but never assigns its own in-flight promise to that field. The lower-level `Recording.start()` also checks `this.cast` before awaiting `createCast()`, allowing concurrent calls to pass the check.

**Why it matters** — Two tabs or near-simultaneous clicks can start competing record daemons. One recording may take over the socket while the other is lost, leaving an orphaned device process or an unusable output file.

**Fix** — Assign the in-flight promise synchronously before awaiting the source operation, and make `Recording.start()` join or reject against an explicit startup promise.

**Approval decision I/O failures are reported as an already-decided approval.**

**Where** — `packages/core/src/governance/approvals.ts:231`, `packages/core/src/governance/approvals.ts:233`, `packages/console/src/server.ts:132`

**What** — The `wx` write catch handles every error, not only an `EEXIST` race. Permission errors, read-only directories, and disk-full failures fall through to `decisionResult()`, which reports `denied: already decided` even though no decision file was written. The console also emits no generic error for that result.

**Why it matters** — The person can believe Allow or Deny was processed while the approval remains pending and the agent continues waiting until timeout.

**Fix** — Treat only `EEXIST` as a race and rethrow other I/O failures using the approval error taxonomy. Make both CLI and console surface every non-success decision result.

**Site checks do not verify that acceptance evidence was run against the current commit.**

**Where** — `scripts/check-site.mjs:927`

**What** — The checker verifies that the generated page contains the report’s recorded commit, but never compares that commit with repository `HEAD`. Current reports are stamped with `9f96536` and `e26d28c`, while the reviewed repository is at `57cfd21`.

**Why it matters** — A runtime change after the acceptance run can pass CI while the published page still claims evidence for the current package version.

**Fix** — Compare each current-version report’s commit with the checkout’s `HEAD`, or require an explicit release commit supplied by the workflow and validate it consistently.

## Minor

**The acceptance page generator logs missing current reports but exits successfully.**

**Where** — `scripts/gen-acceptance-pages.mjs:333`

**What** — The generator prints a note when a package version has no matching report but never sets `bad = true`. Its documentation says a missing report is a release failure, but the generator itself does not enforce that contract.

**Why it matters** — Anyone invoking the generator directly can receive a successful exit status and publish an incomplete acceptance hub unless they separately run `check-site.mjs`.

**Fix** — Mark the missing-report condition as an error and exit non-zero. Keep `check-site.mjs` as the independent final guard.

**Repository and core documentation still describe only two products.**

**Where** — `README.md:3`, `packages/core/README.md:156`, `packages/core/test/unit/package-docs.test.ts:260`

**What** — The repository now contains `uitest-mirror`, and the generated site lists four packages, but the root and core READMEs still say “two products.” The documentation test explicitly asserts only `uitest-phone` and `uitest-console`.

**Why it matters** — npm and GitHub readers can miss the mirror package, while the documentation test protects the stale product count instead of detecting it.

**Fix** — Update the package lists and product-count wording, and make the documentation test enumerate all published packages, including `uitest-mirror`.

## Architecture assessment

The package boundaries are correct: `packages/phone`, `packages/console`, and `packages/mirror` import only public `uitest-sdk` entry points, while core does not import any product. `scripts/check-layers.mjs` reinforces the intended one-way dependency graph.

The root API in `packages/core/src/index.ts` is appropriately small. The six subpaths provide sensible capability groupings: commands, cast, viewer, governance, and drivers. The `/drivers` surface is intentionally broad for advanced consumers building their own adapters; it is not being used as a product escape hatch.

`packages/core/src/api.ts` is a useful composition layer rather than a second implementation of device behavior. The main cohesion concern is `packages/core/src/viewer/server.ts`: it owns HTTP/WebSocket handling, cast lifecycle, layout polling, recording, input arbitration, privacy, and retry state. That is a large responsibility, but the state is currently centralized and understandable. The more serious architectural weakness is lifecycle transaction handling: ownership is spread across viewer state, cast clients, `Recording`, `Device`, and `Session`, and several of those owners do not expose a shared in-flight cleanup promise.

## What is good

- `scripts/check-layers.mjs` enforces the product-to-core dependency direction and rejects deep imports.
- `createCast()` resolves transport and `maxSize` before starting device resources, and refuses unsupported recording modes instead of silently producing empty files.
- Cast daemon ownership uses command-line markers in `packages/core/src/cast/daemon.ts`, avoiding unsafe PID-timing heuristics and accidental termination of sibling sessions.
- The viewer tracks cast opening and cast disposal separately, and startup recording has explicit failure reporting and shutdown handling.
- Approval requests use atomic file creation and typed `ApprovalWriteError` handling for request-write failures.
- The public API categories in `packages/core/src/api.ts` match the design intent and keep product UX out of core.