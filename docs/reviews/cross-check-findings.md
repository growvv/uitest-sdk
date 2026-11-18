# Cross-check findings (mine, while Codex ran)

Independent pass over the same tree, to grade Codex's report rather than accept it.
Line numbers checked against `master` at `57cfd21`.

**Status:** all three confirmed defects and the duplication minors below are fixed;
the error-taxonomy minor is addressed by documenting every thrown code and by a test
that keeps it that way. See `README.md` in this directory for the commit-level record.

## Confirmed defects

### 1. `uitest-console --record` never starts a recording — Important
- `packages/console/src/cli.ts:150` passes `recordPath` into `createViewerSource`.
- `packages/core/src/viewer/source.ts:79-85,101-102` builds a `Recording` and exposes
  `startRecording` / `stopRecording` because of it.
- `packages/console/src/server.ts:171-184` (`createConsoleServer`) never sets
  `recordOnStart`, and `packages/console/src/cli.ts` never sets it either.
- So the file named on the command line is only written if a person clicks Record in
  the page. `packages/console/README.md:28` advertises
  `uitest-console --record demo.mp4  # record while you watch`.
- Introduced in `bde06ff`; the pre-split `live` CLI had no `--record` at all, so this
  was new and never worked.
- Test `packages/console/test/unit/cli.test.ts:46` only asserts the flag is carried
  into the options object — it cannot see the missing wire.

### 2. Core has two browser launchers, and `session.view.open()` uses the wrong one — Important
- `packages/core/src/viewer/window.ts:83` `openWindow` is the product path (Edge/Chrome
  `--app=`, fallback prints the URL, optional `onClose`).
- `packages/core/src/api.ts:176-190` `openBrowser` is a second, older launcher
  (`cmd /c start`, `open`, `xdg-open`) used only by `session.view.open()` at
  `packages/core/src/api.ts:321`.
- Consequences: a library caller gets a browser *tab*, not the app window the 0.11.0
  changelog says the shared implementation provides; no `opened` result, no fallback
  message; two code paths to keep working.
- Nothing tests `openBrowser` or `session.view.open()` at all.

### 3. `Session.cast.record` duplicates `Recording` — Important
- `packages/core/src/api.ts:277-298` re-implements `Recording.start`
  (`packages/core/src/cast/record.ts:49-70`): mkdir, the ws port offset, the grpc
  socket name, `mode: "record"`.
- `RECORD_PORT_OFFSET` is declared twice (`api.ts:173`, `cast/record.ts:7`).
- If the rule changes in one place, the other silently starts a second daemon on the
  stream's own socket/port — the failure mode `record.ts` exists to prevent.

## Duplication and dead surface — Minor
- `connectTcp` copied verbatim: `packages/core/src/driver/device.ts:56` and
  `packages/core/src/input/open.ts:16`.
- `pids` copied verbatim: `packages/core/src/cast/daemon.ts:4` and
  `packages/core/src/driver/device.ts:52`.
- `waitForStop` copied between products: `packages/console/src/cli.ts:234` and
  `packages/mirror/src/cli.ts:291`. Products cannot import each other, so the shared
  home is core; today the copy is manual.
- `DevicePool` is exported from `uitest-sdk/drivers` (`exports/drivers.ts:46`) but no
  product or core module uses it — only `packages/core/test/unit/pool.test.ts`.

## Error taxonomy — Minor
- Two codes mean "bad argument": `EINVALIDARGUMENT` (15 sites, `operations/`) and
  `EBADARG` (12 sites, `cast/`).
- 25 codes used in `packages/core/src` do not appear in the documented table
  (`packages/core/docs/api.md:605-620`), including `EINVALIDARGUMENT`, `EGESTURE`,
  `EINVALIDSELECTOR`, `ECASTCLOSED`, `ECAPTURE`.
