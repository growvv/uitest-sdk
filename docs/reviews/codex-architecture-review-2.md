# Verdict

The fixes cover the happy paths, but the repository is not fully fixed. Two Critical findings remain best-effort cleanup only, the viewer-port fix handles gRPC but not WebSocket transport, and recording/session shutdown still has race windows that can strand device daemons or forwards.

No files were modified.

# Round-one findings: fixed / not fixed

| Finding | Status | Verification |
|---|---|---|
| C1 | **Partially fixed — Critical gap remains** | Readiness polling is now guarded in `packages/core/src/driver/device.ts:171`, but failure of the new `kill -9` is swallowed at `packages/core/src/driver/device.ts:174`. The original timeout is rethrown while the daemon may remain alive. |
| C2 | **Partially fixed — Critical gap remains** | H.264 and WS startup cleanup now covers post-forward failures at `packages/core/src/cast/client.ts:142` and `packages/core/src/cast/ws-client.ts:164`. However, `fportRemove` and `kill -9` failures are swallowed at `packages/core/src/cast/client.ts:171` and `packages/core/src/cast/ws-client.ts:174`. A failed cleanup still strands the forward or daemon. Also, `ownDaemon()` runs before the cleanup scope at `packages/core/src/cast/client.ts:134` and `packages/core/src/cast/ws-client.ts:155`; if daemon launch succeeds but PID discovery fails, the daemon is not cleaned up. |
| I1 | **Fixed** | `--record` now reaches `startViewerServer` as `recordOnStart: true` at `packages/console/src/cli.ts:177`, and `createConsoleServer` forwards it at `packages/console/src/server.ts:192`. Unsupported MJPEG recording fails visibly through the viewer error path rather than silently creating an empty file. A page click during startup is rejected by `packages/core/src/viewer/server.ts:1061`. |
| I2 | **Partially fixed** | The second HTTP viewer now gets an OS-selected port at `packages/core/src/api.ts:309`, and gRPC viewers get distinct suffixes at `packages/core/src/api.ts:302` and `packages/core/src/viewer/source.ts:53`. The fix does not cover WebSocket transport: `source.ts:53` deliberately omits the suffix for WS, while `WsCastClient` defaults every viewer to device port 5000 at `packages/core/src/cast/ws-client.ts:106`. Two WS viewers therefore still start against the same device-side port. |
| I3 | **Fixed for the reported concurrent-call case** | `ViewerServer.close`, `Session.release`, and `Device.dispose` now join their first cleanup through `closePromise`, `releasePromise`, and `disposePromise` at `packages/core/src/viewer/server.ts:397`, `packages/core/src/operations/session.ts:952`, and `packages/core/src/driver/device.ts:288`. The remaining shutdown race is listed below under New defects. |
| I4 | **Partially fixed** | Concurrent starts are guarded by `starting` in `packages/core/src/cast/record.ts:54` and by `startingRecording` in `packages/core/src/viewer/server.ts:1061`. `Recording.stop()` is still not joined with an in-flight start or stop; see New defects. |
| I5 | **Fixed** | `Approvals.decide` now treats only `EEXIST` as a write race at `packages/core/src/governance/approvals.ts:239`; other failures throw `EAPPROVALWRITE` at `packages/core/src/governance/approvals.ts:242`. The console catches and reports it at `packages/console/src/server.ts:137`, while the phone CLI's outer handler reports it at `packages/phone/src/approvals.ts:195`. |
| I6 | **Fixed** | The root and core documentation now name all three products, and the documentation test checks `uitest-mirror` at `packages/core/test/unit/package-docs.test.ts:260`. |
| M1 | **Fixed** | `unacceptedVersions` correctly checks current package versions at `scripts/gen-acceptance-pages.mjs:308`; `misplacedReports` checks the report directory identity at `scripts/gen-acceptance-pages.mjs:327`; `main()` sets `bad` and exits nonzero at `scripts/gen-acceptance-pages.mjs:377` and `scripts/gen-acceptance-pages.mjs:394`. |
| Cross-check: shared `openWindow` | **Fixed** | `Session.view.open()` imports and calls the shared helper at `packages/core/src/api.ts:45` and `packages/core/src/api.ts:317`; the private launcher is gone. |
| Cross-check: shared `Recording` implementation | **Fixed** | `Session.cast.record()` now constructs `Recording` at `packages/core/src/api.ts:270` instead of duplicating socket, directory, and WS-port logic. |
| Cross-check: shared transport helpers | **Fixed** | `connectTcp` and `pids` have one implementation in `packages/core/src/transport/helpers.ts:12`; the device and input paths use it. |
| Cross-check: shared `waitForStop` | **Fixed** | Both products import the core implementation from `uitest-sdk/viewer`; the shared implementation is at `packages/core/src/viewer/lifecycle.ts:15`. |
| Cross-check: undocumented error codes | **Fixed** | The documentation includes the previously missing codes, and `packages/core/test/unit/error-codes-documented.test.ts:49` checks the source against `packages/core/docs/api.md`. |
| Cross-check: unused `DevicePool` | **No fix required** | `DevicePool` remains exported, but it is a documented public library capability with its own tests. This is not a shipped defect. |

# New defects

- **Important — device auto-restart loses ownership of the replacement daemon.** When the agent reconnects after the daemon is no longer listening, `packages/core/src/driver/device.ts:187` calls `startDaemon(hdc)` but discards the returned PID. `Device.dispose()` later only knows the original `ownPid` at `packages/core/src/driver/device.ts:302`. If the original connection reused an existing daemon, or the original daemon was replaced, the restarted daemon survives disposal.

- **Important — `Recording.stop()` can return before recording cleanup finishes.** `packages/core/src/cast/record.ts:91` clears `this.cast` before awaiting `cast.dispose()`. If two callers call `stop()` concurrently, the second returns `null` immediately while the first is still stopping, pulling the file, killing the daemon, and removing the forward. A process that exits after the second call can leave those resources behind. The same state transition lets `stop()` race an in-flight `start()` and return `null` before `start()` later installs a live cast.

- **Important — viewer grace-period shutdown is not joined by `ViewerServer.close()`.** The last client schedules `stopCast()` at `packages/core/src/viewer/server.ts:594`. `stopCast()` clears `this.cast` and awaits disposal at `packages/core/src/viewer/server.ts:1410`, but it is not stored in `castDisposal` or another shutdown promise. If the grace timer has begun and `close()` runs concurrently, `close()` can observe no current cast at `packages/core/src/viewer/server.ts:442`, close the HTTP server, and resolve before `stopCast()` finishes releasing the daemon and forward.

- **Important — concurrent `Session.close()` calls do not join viewer cleanup.** `packages/core/src/api.ts:376` has no in-flight close promise. The first caller removes a viewer from `this.views` and waits for `viewer.close()` at `packages/core/src/api.ts:380`; a second caller sees an empty set and proceeds directly to `core.release()` at `packages/core/src/api.ts:389`. The second call can resolve while the first viewer still owns a cast daemon or forward.

- **Minor — a failed startup recording error remains after a later retry succeeds.** `packages/core/src/viewer/server.ts:1551` stores `recordingError`, but the successful path at `packages/core/src/viewer/server.ts:1546` never clears it. If the initial `recordOnStart` attempt fails transiently and a later `live` transition retries successfully, a newly connected page receives both `recording: true` and the stale `recordingError` through `packages/core/src/viewer/server.ts:1210`, causing a false “record failed” notification.

# Architecture assessment

The first review’s lifecycle concern is only partially addressed. The fixes add local guards around the specific paths that were found, but there is still no shared cleanup transaction spanning the session, viewers, casts, recording handles, and input lanes.

- `ViewerServer` owns HTTP sockets, cast retry state, cast disposal, recording state, input lanes, layout timers, and browser clients in one class beginning at `packages/core/src/viewer/server.ts:168`. The grace-stop race is evidence that these ownership paths are still independently coordinated.
- `Recording` owns a cast client and therefore a device daemon and forward, but its start/stop operations are not represented by one shared lifecycle promise at `packages/core/src/cast/record.ts:42`.
- `Session.cast.open()` and `Session.cast.record()` return resource-owning handles at `packages/core/src/api.ts:261` and `packages/core/src/api.ts:264`, but `Session.close()` does not track or dispose those handles. A caller can close the session while a direct cast or recording remains active.
- `InputSession` owns a second agent client and forward. The viewer normally closes it, but `openInput()` only cleans up the forward on connection failure at `packages/core/src/input/open.ts:35`; construction failures after a successful connection are outside that transaction.
- `Device.connect()` and cast startup still treat daemon ownership as a PID plus best-effort cleanup rather than a reusable acquisition transaction. The discarded auto-restart PID is a concrete remaining example.

`ViewerServer` is still doing too much, and it is now the top concentration point for lifecycle risk—not because the responsibilities are merely large, but because cast retry, recording, client shutdown, and input shutdown can race through separate state fields.

# What is good

- The normal readiness-failure path now attempts to kill only the daemon identified by that connection.
- Cast ownership uses command-line markers rather than blind `pidof` termination.
- The normal post-forward startup paths now have cleanup scopes instead of leaving cleanup after the return path.
- The in-flight close/release/dispose fixes correctly make repeated calls wait for the first cleanup on successful shutdown.
- `recordOnStart` reports unsupported recording rather than silently producing an empty file, and page clicks are serialized against startup.
- Approval write failures now distinguish a real `EEXIST` race from permission, disk, and directory errors.
- Acceptance-page generation now has meaningful current-version and directory-consistency checks.
- The shared helper refactors remove the verified duplicated implementations without changing the public product-to-core dependency direction.