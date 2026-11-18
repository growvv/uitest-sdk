# Review record — 2026-11-19, `master` at `57cfd21`

Reviewed at `57cfd21`; every accepted finding is fixed in `4dd3cab`, `2941606`
and `0331071`. Nothing below is still open.

Two independent passes over the whole repository:

- **Codex** (`lab/gpt-6.2-sol`, reasoning `xhigh`, read-only, ~2 h, 16 M tokens):
  `codex-architecture-review.md` — the full report, kept verbatim.
- **Claude**, cross-checking the same tree: `cross-check-findings.md`.

Every Codex finding below was re-verified against the code before it was acted on;
the grade is by effect on the person using the software, not by the report's label.

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
