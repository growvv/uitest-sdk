# uitest-phone

Headless HarmonyOS device agent: a 21-command CLI, an MCP server and an agent
skill, built on [`uitest-sdk`](https://www.npmjs.com/package/uitest-sdk).

```bash
npm i -g uitest-phone     # or: npx uitest-phone doctor
uitest-phone doctor
```

Each command opens the device, runs one step, waits for the UI to settle, and
prints the resulting screen or a diff. Cross-process state (refs, approvals,
leases, traces) lives in `--state-dir`, default `.uitest-phone/` — that
directory holds screen content, so it is gitignored and never shared.

## Commands

`handoff` only writes a lease and does not touch the device; the other 20 drive it.

| Command | What it does |
|---|---|
| `observe` | Read the screen: one line per element with a ref, role, label and centre; `--out` saves a JPEG |
| `tap` | Tap by ref, text, selector or coordinate; `--long` holds instead |
| `type` | Type into the focused field or `--ref`; `--paste` pastes in one go |
| `swipe` | Swipe between two points or in a direction; `--ref` swipes inside an element |
| `double-click` | Double-tap by ref, text or selector |
| `drag` | Press, then move (drag to reorder) |
| `fling` | Quick flick; the list keeps moving after release |
| `pinch` | Two-finger zoom through the device's `PointerMatrix` |
| `key` | `back`, `home`, `power`, `enter`, or a numeric key code |
| `wait-for` | Wait for a label to appear; one device round trip |
| `read-list` | Read a whole scrolling list, each label once |
| `scroll-until` | Page down until a label is on screen (not the device's `scrollSearch`, which wedges the lock) |
| `launch` | Start an app by short name or bundle; the policy allow-list applies here too |
| `apps` | List installed apps; `--current` foreground, `--has` installed? |
| `window` | The focused window, or one bundle's; `--focus` / `--close` |
| `doctor` | Probe the device and the capabilities this build needs |
| `screenshot` | Save one JPEG and report its size and scale factor |
| `inspect` | Box and number every element (the number is the ref); `--html` writes a hover panel |
| `report` | Aggregate every step of a task into one self-contained HTML report |
| `status` | Current task, device tag and policy settings; does not touch the device |
| `handoff` | Hand the phone to a person (`--reason`) and stop until `resume` |

```bash
npx uitest-phone doctor
npx uitest-phone observe --task "check WLAN"
npx uitest-phone tap --ref 12 --task "check WLAN"
npx uitest-phone inspect --html layout.html
npx uitest-phone report --title "WLAN check"
```

Status is the result: `settled` / `uncertain` / `not_found` / `blocked` /
`approval_pending` / `approval_denied` / `stale` / `lease_held` / `handoff` /
`device_locked` / `device_needs_setup` / `device_offline`, exit codes
0/1/1/4/3/4/4/2/2/2/2/2. Anything but `settled` also puts `approvalId`, `rule`
and `reason` into `--json`'s `data`.

## Agents

```bash
uitest-phone connect              # write the MCP entry and install the skill
uitest-phone connect --agent gemini   # also codex, copilot
uitest-phone mcp                  # stdio MCP: uitest_<command>, one device for the process
uitest-phone install-skill        # ~/.claude/skills and ~/.agents/skills
```

`connect` edits only its own entry in the agent's own settings file, keeps
comments and key order, and writes nothing when the entry is already right. The
skill installs into `~/.claude/skills/uitest-phone` and
`~/.agents/skills/uitest-phone` (the cross-runtime alias Codex, Copilot CLI and
Gemini CLI read). After an upgrade `mcp` refreshes a copy this package wrote and
leaves hand-edited ones alone.

## Approvals

Policy gates payments, finance, deletes and sends before the device is touched.
A gated step returns `approval_pending` with an id; **the person answers, not the
agent**:

```bash
uitest-phone approvals list               # id, command, rule, app, task, time left
uitest-phone approvals allow <id>         # --scope once|task|always
uitest-phone approvals deny <id> --reason "wrong account"
```

- The decision is written by this command (or the console's inbox) into
  `<state-dir>/approvals/<device-hash>/<id>.allow|.deny`; the request itself is
  `<id>.json` and is marked `<id>.used` once consumed. The agent holds the id and
  still cannot approve it.
- The id is bound to the command and the target's signature, is single-use, and
  expires 60 seconds after the step was gated. A screen that changed in the
  meantime returns `stale` rather than acting on something else.
- `--yes` is required when no terminal is attached (`approval_refused`, exit 2),
  so a script cannot silently approve on someone's behalf.
- `--scope task` stops asking for that rule in this task; `always` stops asking
  in this state directory. Credentials stay blocked either way, `--read-only`
  still refuses writes, and the `--apps` allow-list still applies.

## The person takes the phone

```bash
uitest-phone hold                     # the person has it; agents stop with lease_held
uitest-phone resume                   # hand it back; the next command continues
```

`hold` writes the lease `held by a person`, including for a running `mcp`
session: the next agent command stops with `lease_held` (exit 2) and does not
retry. `handoff --reason "..."` is the agent's half of the same gate — it writes
the lease, returns `handoff` immediately, and repeats the reason on every
`lease_held`. Neither expires on its own, because process liveness says nothing
about who is holding the phone.

The browser mirror, takeover and approval inbox are a separate product:
[`uitest-console`](https://www.npmjs.com/package/uitest-console).

## Migrating from `uitest-sdk` 0.9.4

The CLI, the MCP server and the skill used to ship inside `uitest-sdk`. They now
live here, on top of the same library:

| 0.9.4 | 0.10.0 |
|---|---|
| `npx uitest-sdk <command>` | `npx uitest-phone <command>` |
| `npx uitest-sdk mcp` | `npx uitest-phone mcp` |
| `npx uitest-sdk connect` | `npx uitest-phone connect` |
| `npx uitest-sdk install-skill` | `npx uitest-phone install-skill` |
| `npx uitest-sdk live` | `npm i -g uitest-console && uitest-console` |

The commands, the MCP tools and the skill content are unchanged. The skill
marker moved from `uitest-sdk` to `uitest-phone`: a copy this package wrote
under the old marker is adopted and refreshed, a hand-edited one is left alone.

Full documentation: <https://growvv.github.io/uitest-sdk/>.
