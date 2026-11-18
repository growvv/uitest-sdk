# Review record — 2026-11-19, `master` at `57cfd21`

Reviewed at `57cfd21`; every accepted finding is fixed in `4dd3cab`, `2941606`
and `0331071`. Nothing below is still open.

Two independent passes over the whole repository:

- **Codex** (`lab/gpt-6.2-sol`, reasoning `xhigh`, read-only, ~2 h, 16 M tokens):
  `codex-architecture-review.md` — the full report, kept verbatim.
- **Claude**, cross-checking the same tree: `cross-check-findings.md`.

Every Codex finding below was re-verified against the code before it was acted on;
the grade is by effect on the person using the software, not by the report's label.

A **second review round** ran afterwards at `e5e1757`, over the fixes; its report
is `codex-architecture-review-2.md`, kept verbatim, and its outcome is recorded
under "Round two" at the end of this file.

## Verdict

Package boundaries are sound and `scripts/check-layers.mjs` enforces them. The
weak point is **lifecycle ownership**: resources are acquired in several objects
(`Device`, cast clients, `Recording`, `ViewerServer`, `Session`) and only some of
them clean up on every failure path or join a concurrent close.

## Accepted — Critical

| # | Finding | Where | Status |
|---|---|---|---|
| C1 | A daemon this process started survives a failed readiness poll | `driver/device.ts:176` | fixed |
| C2 | Cast startup after the forward leaks the daemon and the forward | `cast/ws-client.ts:186`, `cast/client.ts:161` | fixed |

## Accepted — Important

| # | Finding | Where | Status |
|---|---|---|---|
| I1 | `uitest-console --record` never starts a recording | `console/src/cli.ts:150` | fixed |
| I2 | A second `session.view.open()` reuses port 7000 and the same cast socket | `api.ts:313`, `viewer/source.ts:48` | fixed |
| I3 | Concurrent `close()`/`release()`/`dispose()` resolve before cleanup finishes | `viewer/server.ts:385`, `operations/session.ts:948`, `driver/device.ts:286` | fixed |
| I4 | A page's record click is not serialised against itself | `viewer/server.ts:1044`, `cast/record.ts:49` | fixed |
| I5 | A failed approval write is reported as "already decided" | `governance/approvals.ts:231` | fixed |
| I6 | Both READMEs still say "two products" and a test pins that | `README.md:3`, `core/README.md:156`, `package-docs.test.ts:260` | fixed |

## Accepted — Minor

| # | Finding | Where | Status |
|---|---|---|---|
| M1 | The page generator logs a missing report but exits 0 | `gen-acceptance-pages.mjs:333` | fixed |

## How each fix is pinned

Every fix landed test-first: the test was run and watched fail for the reason the
finding names, then the code changed until it passed, then the whole suite ran.

| # | Test | What it proves |
|---|---|---|
| C1 | `device.test.ts` — "kills the daemon it started when it never becomes ready" | a daemon that never binds 8012 is killed by the call that spawned it |
| C2 | `cast-ws-client.test.ts` — "releases the daemon and forward when the record start is refused"; `cast-client-startup.test.ts` — "releases the daemon and the forward when the service cannot be loaded" | a failure after the forward frees both |
| I1 | `console/cli-record.test.ts` — three cases | `--record` reaches `startViewerServer` as `recordOnStart: true`, and only then |
| I2 | `api-view-ports.test.ts` | the second view asks the OS for a port and gets its own socket suffix |
| I3 | `viewer-server.test.ts` — "makes a second close wait for the first to finish"; `session-release-join.test.ts`; `device.test.ts` — "makes a second dispose wait for the first" | a second close/release/dispose joins the first instead of returning early |
| I4 | `live-record.test.ts` — "refuses a second start that arrives while the first is still opening"; `viewer-server.test.ts` — "refuses a second record click that lands while the first is still opening" | the in-flight start is recorded synchronously, at both levels |
| I5 | `approvals-io.test.ts`; `console/server.test.ts` — "tells the tab when the decision could not be written" | a non-`EEXIST` write failure throws `EAPPROVALWRITE`, and the console reports it instead of throwing past the hook |
| I6 | `package-docs.test.ts` — "names every product a reader should install instead" | the core README names `uitest-mirror`; root README says three products |
| M1 | `gen-acceptance.test.ts` — `unacceptedVersions` and `misplacedReports` cases | a current version with no report is an error the caller exits 1 on; a historic report is not |

**M1 had a second half.** Fixing the missing-report exit exposed that the
generator also compared every *historic* report's version with today's
`package.json`, so it already exited 1 on a healthy tree — which made the new
exit code meaningless. It now checks that a report matches its own directory
(`core-0.10.0/` holds a 0.10.0 report); whether the *current* version has one is
`check-site.mjs`'s question, answered from `package.json`. Verified by hand:
exit 0 on the tree as it stands, exit 1 with `mirror-0.1.0/` moved aside.

`npm test` → 118 files, 1121 tests passing. `npm run typecheck`,
`npm run typecheck:tests`, `check-layers`, `check-site` and `check-skill` all pass.

## Cross-check findings, also fixed

The second pass (`cross-check-findings.md`) found three defects of its own and a
set of duplication and taxonomy minors. All of them are now addressed:

| Finding | Fix | Test |
|---|---|---|
| `session.view.open()` used a private `openBrowser` instead of core's `openWindow` | it calls `openWindow`, and `openBrowser` is deleted | `api-shared-paths.test.ts` |
| `session.cast.record()` re-implemented `Recording.start` (mkdir, ws port offset, gRPC socket name; `RECORD_PORT_OFFSET` declared twice) | it builds a `Recording` and uses it | `api-shared-paths.test.ts` |
| `connectTcp` copied in `driver/device.ts` and `input/open.ts`; `pids` copied in `cast/daemon.ts` and `driver/device.ts` | one `transport/helpers.ts` | `transport-helpers.test.ts` |
| `waitForStop` copied between the console and the mirror | one `viewer/lifecycle.ts`, exported as `uitest-sdk/viewer` | `wait-for-stop.test.ts` |
| 25 thrown codes missing from the documented table; `EBADARG` vs `EINVALIDARGUMENT` | every code is documented, the two argument codes are explained, and a test fails when a new code is thrown undocumented | `error-codes-documented.test.ts` |

`DevicePool` is left exported and unused: it is a documented library capability
(`uitest-sdk/drivers`) with its own tests, not dead product code, and removing a
public export is a breaking change that this review did not ask for.

## Declined — with reason

**Site checks do not compare an acceptance report's commit with `HEAD`.**
The report's `commit` is the commit the acceptance actually ran at. Docs-only
commits legitimately follow it — this release's own mirror report is `e26d28c`
while the tag is on a later docs commit. Requiring equality would fail CI on every
subsequent commit and force a device re-run for a typo fix. The invariant that
matters is that the *code* under test is unchanged, which the report already
records; the site check verifies the page shows that commit and the summary it
claims. Cost if wrong: a runtime change made after an acceptance run ships with a
page naming the older commit — the page is then stale, not false.

## Round two — 2026-11-19, `master` at `e5e1757`

Codex reviewed the four fix commits (`git diff 57cfd21..HEAD`) on the same model
and settings, and was asked to say explicitly where a round-one fix only looked
fixed. Its report is `codex-architecture-review-2.md`, kept verbatim. Every
finding was re-verified against the code before it was acted on, and each fix
below was written as a failing test first.

### What round two found

| # | Finding | Verified? | Outcome |
|---|---|---|---|
| R1 | I2's per-view isolation covered gRPC socket names and the HTTP port but not the **ws** transport, where every view falls back to device port 5000 | yes — and Claude found the same defect independently while the review ran | fixed in `18dbc5d` |
| R2 | `Recording.stop()` clears `this.cast` before awaiting `dispose()`, so a second caller returns `null` while the first is still releasing the daemon, the MP4 and the forward; the same gap lets `stop()` race an in-flight `start()` | yes | fixed in `48ef5f2` |
| R3 | `Session.close()` has no in-flight promise; a second caller finds the viewer set already drained and releases the core mid-teardown | yes | fixed in `48ef5f2` |
| R4 | `Device.connect()` discards the pid of a daemon the reconnect (or the health-check restart) started, so `dispose()` leaves it running | yes | fixed in `48ef5f2` |
| R5 | Both cast clients run `ownDaemon()` before the cleanup scope: a daemon that launches but has not reached `ps -ef` is abandoned | yes | fixed in `48ef5f2` |
| R6 | A startup `recordingError` is never cleared, so a tab connecting after a later retry succeeded is told "record failed" for a recording that is running | yes | fixed in `48ef5f2` |
| R7 | The grace-period `stopCast()` is not joined by `close()`, which can then resolve before the daemon and forward are released | **no** | not a defect — see below |
| R8 | C1/C2 residuals: a failed `kill -9` or `fportRemove` is swallowed | yes, but by design | declined — see below |

### How each fix is pinned

| # | Test | What it proves |
|---|---|---|
| R1 | `api-view-ws-ports.test.ts` | two ws views get different device ports, two apart; an explicit port is kept; gRPC gets none |
| R2 | `live-record.test.ts` — "makes a second stop wait for the first"; "waits for an in-flight start rather than reporting nothing" | the second stop joins the first, and a stop during a start returns the path |
| R3 | `api-shared-paths.test.ts` — "makes a second close wait for the first" | the second `Session.close()` does not resolve early |
| R4 | `device.test.ts` — "disposes the daemon the reconnect started"; "restarts a daemon whose global lock is held by a dead connection" (extended) | both replacement daemons are killed by `dispose()` |
| R5 | `cast-client-startup.test.ts` and `cast-ws-client.test.ts` — "daemon launched but not identifiable" | exactly the one new pid is killed; the agent daemon is not |
| R6 | `viewer-record-on-start.test.ts` — "forgets a startup failure once a retry succeeds"; `viewer-server.test.ts` — "forgets a startup failure once a page starts a recording" | the greeting no longer carries a stale error beside `recording: true` |
| R7 | `viewer-server.test.ts` — "waits for the grace stop before close resolves" | kept as a pin for behaviour that already held |

### R7 — not a defect

The report said `close()` could resolve while the grace timer's `stopCast()`
was still disposing. It cannot. The cast stream is consumed inside
`openCast()`, whose promise `close()` awaits as `castOpening`; `stopCast()`
only runs after that promise has settled, and the dispose it awaits is
therefore already complete when `close()` proceeds. A probe that held
`cast.dispose()` open confirmed it: `close()` did not resolve until the dispose
was released. The test stays as a regression pin.

### R8 — declined, with reason

A `kill -9` that fails, or an `fportRemove` that fails, is swallowed during
cleanup. That is deliberate. These run in `finally` blocks whose whole job is to
free the device after a failure that is already being reported; replacing that
report with "cleanup also failed" hides the cause the caller needs, and throwing
from a `finally` would turn a handled start failure into an unhandled one. The
device is left in a state the next call discovers and repairs (a stale forward
is removed on the next `fportAdd`; a daemon without a listener is restarted).
What would change this: evidence that a specific failure mode leaves the device
unusable *and* is invisible to the next call — none was found.

### Result

`npm test` → 119 files, 1133 tests passing. `npm run typecheck`,
`npm run typecheck:tests`, `check-layers`, `check-site` and `check-skill` all
pass.
