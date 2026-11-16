# uitest-phone reference

Complete command and behavior reference. The working loop and safety rules are
in [SKILL.md](SKILL.md).

## Architecture

```
agent → uitest-phone → uitest-sdk → agent.so (TCP 8012) → HarmonyOS device
```

One command opens the device, runs one step, settles, prints the result, and
releases. There is no background daemon: state that must outlive a command
(the trace, the lease, pending approvals) lives in the state directory.

- The device extension is pushed and its daemon started on first use; later
  commands reuse it.
- The lease is one file per device under `<state-dir>/leases/`. A second task
  gets `lease_held` before touching anything.
- Traces are one JSON line per step under `<state-dir>/traces/`, with the
  device serial replaced by an 8-character hash.

## Requirements and installation

- Node.js 20 or newer.
- `hdc` on `PATH`, or `HDC_PATH` pointing at it, with one phone or emulator
  attached.
- No other install step: `npx uitest-sdk` fetches the package, which carries
  the device extension for arm64 and x86_64. The installed command is
  `uitest-phone`; `npx uitest-sdk` runs it without a global install.

Environment variables:

| Variable | Purpose |
| --- | --- |
| `HDC_PATH` | Explicit path to `hdc`. |
| `HDC_TARGET` | Default device id, when several are attached. |

Install the skill for an agent:

```
npx uitest-sdk install-skill [--dir <path>] [--force]
```

It writes both directories agents read: `<home>/.claude/skills/uitest-phone`
for Claude Code and `<home>/.agents/skills/uitest-phone`, the cross-runtime
alias ([agentskills.io](https://agentskills.io)) that Codex, Copilot CLI and
Gemini CLI read. Every target is checked before anything is written, so a
refusal leaves no half install. An existing `SKILL.md` is kept unless
`--force` is given, so a hand-edited copy is never overwritten by accident.
`--dir` writes one directory instead. The skill ships inside the package, so
its commands and the binary are always the same version.

An upgrade refreshes its own copy: each install writes `.uitest-skill.json`
(version and file digests), and `mcp` startup rewrites an unchanged copy to the
running version, so no manual reinstall is needed. A copy the person edited is
left alone, as is a hand-written one; an untouched 0.3.0 copy is recognised by
its published digests and adopted.

## Connect an agent

```
npx uitest-sdk connect [--agent claude|codex|gemini|copilot] [--force]
```

Does the whole setup in one step: registers the MCP server in the agent's own
settings file and installs the skill where that agent reads skills.

| Agent | Settings file | Skill directories |
| --- | --- | --- |
| `claude` (default) | `~/.claude.json` (`$CLAUDE_CONFIG_DIR`) | `~/.claude/skills`, `~/.agents/skills` |
| `codex` | `~/.codex/config.toml` (`$CODEX_HOME`) | `~/.agents/skills` |
| `gemini` | `~/.gemini/settings.json` | `~/.agents/skills` |
| `copilot` | `~/.copilot/mcp-config.json` (`$COPILOT_HOME`) | `~/.agents/skills` |

Only this package's entry is touched. Comments, key order and the other
servers' formatting stay as they were, and a run that finds the entry already
right changes nothing. A settings file that does not parse is refused and left
alone, naming the file and the offset — fix it by hand and run again. A skill
that is already installed is kept and reported; the server registration still
happens. Start a new agent session afterwards: MCP servers are read at session
start.

The entry starts the installed package by absolute path with the same `node`
that ran `connect`, because an agent launched from the Dock or the Start menu
does not see the terminal's `PATH`. When the only copy is in npx's cache, the
entry names the package instead (`npx -y uitest-sdk@<version> mcp`), since
npm sweeps that cache.

## MCP server

```
npx uitest-sdk mcp [--device <id>] [--read-only] [--apps a.b] [--confirm rules]
```

Serves every command as a tool named `uitest_<command>` over stdio, JSON-RPC
2.0. The session is opened once for the life of the process, so tool calls do
not pay device startup per step. A tool that returns a non-`settled` status is
reported as a tool error (`isError: true`) with the status and its reason in
the text, not as a transport failure.

`connect` writes the entry for you. By hand it is:

```json
{"mcpServers": {"uitest-phone": {"command": "npx", "args": ["-y", "uitest-sdk", "mcp"]}}}
```

## Screen model

Each screen line:

```
[ref] role "label" @centerX,centerY state1 state2
```

The header is:

```
screen <width>x<height> · app: <bundle> · rotation <degrees>° · focus [ref]
```

- `ref` is allocated per session and stays bound to a signature of
  `role | label | bounds | description | hint`. The ref survives rerenders while
  all of those stay the same.
- Refs reset when the process exits; they are not global IDs. A new command
  reads a fresh screen, so refs from a previous command only work if the screen
  did not change.
- Scroll changes bounds, so refs to list items change after a scroll. That is
  why `read-list` exists.
- Labels prefer `text`, then `description`, then `hint`; labeled buttons fall
  back to descendant text, then to a cleaned `id`. An input with only an id gets
  a humanized label such as `"history record go"`.
- Hidden nodes, zero-area nodes, the top status bar, the bottom navigation bar,
  and structural containers (`column`, `row`, `stack`, `scroll`, `swiper`, …)
  are omitted.
- A clickable ancestor that only repeats a deeper clickable control's label is
  dropped, so the agent aims at the control rather than its container.
- Roles: `text`, `button`, `input`, `list`, `toggle`, `checkbox`, `radio`,
  `slider`, `tabs`, `nav`, and raw component names.
- States: `focused`, `disabled`, `checked`, `selected`, `scrollable`,
  `password`.
- Credentials are masked before the screen reaches the agent. A password
  field's value is `••••••`; in a credential context, digit runs of 3–8
  (one-time codes, PINs) become bullets of the same length. The words around
  them stay, so the policy still classifies the step. A masked element cannot
  be found by its secret text (`tap --text 482913` is `not_found`), and its
  box is covered with gray in screenshots and report shots. The low-level
  `agent.captureLayout()` / `captureScreen()` are untouched.

After an action, a diff is printed:

```
+ [31] button "Save" @658,2400
- [12] button "Edit" @1200,610
~ [4] input "hello" @658,300 focused
```

`no change` means the screen hash did not change. A full screen is printed when
the bundle, display size, or rotation changed, or when more than half the lines
changed.

## Settling

After every action the CLI waits for the UI to stop changing:

1. `Driver.waitForIdle(200, 3000)` on the device. This is one round trip and the
   device sees animations a host cannot.
2. Then host polling: two consecutive identical screen hashes. A repaint takes a
   frame or two, so an unchanged screen is disbelieved for 400 ms after an
   action — otherwise the old page is read twice and reported as "no change".
3. The whole wait is bounded by `--settle-ms` (default 3000). Exceeding it is
   reported as `uncertain`, not thrown.

## Commands

All commands accept the global flags from SKILL.md and print a status line
first. `--json` prints `{status, code, text, data}` instead.

### observe

```
observe [--out shot.jpg] [--wait-ms 3000]
```

Reads the screen. `--wait-ms` first waits for the screen to change, which is
useful right after a `launch`. `--out` also saves a JPEG.

### tap

```
tap --ref 12 [--long]
tap --text WLAN
tap --selector "type=Button&text=Save"
tap --x 600 --y 1200
```

A ref is resolved against the current screen and tapped at its center. `--text`
and `--selector` go through the device's own `Component.click`, which does not
need a layout read. `--long` holds the pointer for 800 ms.

### type

```
type --text "hello" [--ref 7] [--paste]
```

Types into the focused input, or the input at `--ref`. Uses the device IME, so
Chinese and emoji work. A password field is refused before any keystroke.
`--paste` sends the whole string at once through the extension's clipboard path
instead of one key per character: on a 36-character string it took 1.3 s
against 2.8 s for per-key input, and the text arrives intact.

### swipe

```
swipe --direction up|down|left|right [--ref 20] [--duration-ms 300]
swipe --from 600,1800 --to 600,600
```

The direction form swipes inside `--ref` when given, otherwise inside a box
inset 12% from the screen edge. Every path is built from pointer down/move/up;
`Driver.swipe` is 3–5x slower on a real device and 19–38x slower on the
emulator, and gives no control over the path.

### double-click

```
double-click --ref 12
double-click --text "Photo"
```

Uses the device's own `Component.doubleClick` when the target came from a
label or selector, so the two taps are timed by the device rather than by the
host.

### drag

```
drag --from 600,1400 --to 600,500 [--hold-ms 300] [--duration-ms 500]
```

Holds before moving. The hold is what makes the device treat the gesture as
dragging a held item; without it the list scrolls instead. Use `swipe` for
scrolling and `drag` only when the UI expects a reorder.

### fling

```
fling --direction up
fling --from 600,1800 --to 600,600
```

A short, fast path (120 ms by default): the release velocity keeps the list
moving after the finger lifts. A `swipe` of the same distance stops when the
finger stops.

### pinch

```
pinch --ref 20 --scale 2
pinch --center 608,1300 --from 150 --to 400
```

Two fingers moving apart or together, through the device's `PointerMatrix`.
The single-pointer channel cannot express two simultaneous paths.

- `--ref` pinches inside that element; its middle becomes the center and the
  fingers start a quarter of its shorter side apart.
- `--center x,y` pinches around a point, with `--from` and `--to` as
  half-distances.
- `--scale` sets the end distance as a multiple of the start: `2` zooms in,
  `0.5` zooms out. `--to` wins over `--scale` when both are given.

### window

```
window
window --bundle com.example.app
window --bundle com.example.app --focus
window --bundle com.example.app --close
```

Reports the focused window, or the one a bundle owns: bundle id, whether it
has focus, and its bounds. `--focus` raises it first; `--close` closes it and
reports `bounds: -`, because a closed window has none.

The extension has no window enumeration — `Driver.findWindows` does not exist —
so a window is always addressed by filter. A filter that matches nothing is
`not_found`.

### key

```
key --key back|home|power|enter|escape|volume-up|...
key --key 2054
```

Named keys map to HarmonyOS key codes. `power` is sent as 26, which is the code
measured to wake this device's display.

### wait-for

```
wait-for --text "Connected" [--timeout-ms 10000]
```

Uses `Driver.waitForComponent` on the device: one round trip, and the device
sees layout passes a host poll cannot. A timeout is `not_found`, not an error.

### read-list

```
read-list [--ref 20] [--max-screens 8]
```

Pages the largest scrollable on screen, or the one at `--ref`, and prints every
distinct label once, in reading order. Stops at the list's own end marker, when
a scroll reveals nothing new, or at the screen budget. A list that does not
announce its end costs one extra scroll.

### scroll-until

```
scroll-until --text "About" [--ref 20] [--max-screens 8]
```

Pages the list one screen at a time, like `read-list`, and stops at the first
page containing the label. A label already on screen costs no scroll.

The device's `Component.scrollSearch` is deliberately not used. Measured on a
real device, a search that misses blocks for 30 s until the request times out,
and the device's global lock stays held afterwards — every following command
then fails with `Disallow concurrent use` for about a minute. Paging costs one
scroll per screen and leaves the device usable.

### launch

```
launch --app settings
launch --app com.example.app --ability EntryAbility
```

Resolves a short name through the alias table, then against installed bundles;
an ambiguous name is an error that lists the candidates. The entry ability is
read from `bm dump` — Settings declares
`com.huawei.hmos.settings.MainAbility`, Calculator declares
`CalculatorAbility` — and an `aa start` failure is surfaced rather than
reported as success.

Aliases: `settings`, `launcher`/`home`, `camera`, `photos`/`gallery`, `clock`,
`calendar`, `calculator`.

### apps

```
apps [--query wechat]
apps --current
apps --has com.example.app
```

Lists installed bundle ids, filtered by substring. Exact match first, then
last-segment match, then substring.

`--current` reports the app in front, as `bundle · ability`. A locked device
has no foreground mission and answers `not_found`, which is the truth rather
than a failure.

`--has` answers whether one bundle is installed: `settled` with
`installed: true`, or `not_found` with exit code 1. Use it before `launch`
when the bundle id is uncertain.

### doctor

```
doctor
```

Probes each capability this CLI depends on — `waitForIdle`, `findComponent`,
`waitForComponent`, `findWindow`, `multiTouch` — and reports the target count,
display size and session policy. A missing capability is reported, not thrown.
Serial numbers appear only as an 8-character hash.

### screenshot

```
screenshot [--out shot.jpg]
```

Saves the device JPEG and reports `frame`, `display` and `factor`. The device
ignores the requested scale and returns a fixed frame (measured 608x1344 for a
1216x2688 display), so the factor comes from the frame itself. Double any pixel
measured in the image before using it as a tap coordinate. Credential elements
are covered with gray in the saved image, matching the masked labels.

### inspect

```
inspect [--out annotated.jpg] [--html panel.html]
```

Draws a box around every element on the screenshot and numbers it; **the number
is the ref**, so `tap --ref 3` works directly. Boxes are coloured by role
(text, button, input, list, ...), and a masked element is greyed out before its
box is drawn — the outline never replaces redaction.

`--html` also writes a single self-contained panel: the same frame with CSS
overlays plus the node table, and hovering a row highlights its box. Useful
when a person wants to look at the layout, or when a ref is ambiguous.

Both files default to `<state-dir>/shots/inspect-<timestamp>.jpg`.

### live (not a command)

```
live [--port 7000] [--privacy on|off] [--no-open] [--no-layout]
     [--scale 1..5] [--fps 15|30|60|120] [--transport grpc|ws]
```

Serves the phone in a browser tab: the screen on the left, the node table on the
right. Clicking a node (or its box on the picture) copies its ref, role, label
and centre; the refs are the same ones `tap --ref` takes. H.264 is decoded by
the browser's own WebCodecs decoder, so no plugin or build step is involved.

Credentials are masked by default — password values and codes are hidden in the
node table and boxed over on the picture. `--privacy off` only sets the page's
initial state; the switch in the page still works, and the server follows it.

The page header has two buttons for the person watching: **Shot** saves a JPEG
under `<state-dir>/shots/` (through the same masking path as the node table),
and **Record** writes an MP4 there. Recording runs on a second cast daemon so
the picture keeps streaming; only one recording runs at a time, and closing the
page stops and finishes it.

Like `mcp`, `hold` and `resume`, this is not one of the commands: it runs until
interrupted and holds the device lease the whole time, so agent commands stop
with `lease_held` while a person is watching. It listens on `127.0.0.1` unless
`--host` says otherwise.

### report

```
report [--title "WLAN check"] [--task "WLAN check"]
```

Writes a self-contained HTML file with every step to `<state-dir>/traces/`.
With `--trace-shots`, each row also links to the screenshot saved for that
step; the link is relative to the report, so the pair can be moved together.

Every command is recorded, including the ones that never read the screen
(`apps`, `launch`, `doctor`, `window`), so the step that changed the app is in
the report too.

Each command is its own process and writes its own trace file, so the report
reads the task's files back from disk and renumbers the steps across them. It
covers the most recent run of the task — files more than 30 minutes apart start
a new run, so an old attempt at the same task name does not get mixed in.

`--task` picks a task other than this session's. With neither `--task` nor a
task that recorded steps, it falls back to the newest task and prints which one
it covered, rather than writing an empty report. The status line says how many
steps and trace files went in.

### status

```
status
```

Prints the task name, device hash, read-only flag, confirm rules and app
allow-list.

## Selectors

```
text=WLAN            exact label
text~=WLAN           label contains
type=Button          component type (case-sensitive on the device)
id=id_content        component id
clickable            bare predicate means "true"
type=Button&text=Save
text="A & B = C"     quote a value that contains & or =
```

## Takeover: the person takes the phone

```
uitest-phone handoff --reason <text> [--device <id>] [--state-dir <dir>]
uitest-phone hold [--device <id>] [--state-dir <dir>]
uitest-phone resume [--device <id>] [--state-dir <dir>]
```

`handoff` is the agent's side of the same lease: it reached a step only a
person can do — signing in, a one-time code, unlocking the phone — and gives
the phone up instead of guessing. It writes `"held by a person"` at once and
returns `handoff` (exit 2); stop, tell the person exactly what you need, and
end your turn. The reason is stored in the lease and repeated by every command
that gets `lease_held`, so the person and any other agent can see what is
needed. Agents call it as the MCP tool `uitest_handoff`, where `reason` is
required. `resume` hands the phone back; the same agent session continues on
its next command.

`hold` writes the device's lease as `"held by a person"` and exits; every
agent command on that device then stops with `lease_held` (exit 2) in a couple
of seconds. It preempts a task that is already running — including an open
`uitest-phone mcp` session, which holds one lease for its whole life. The task
is not stopped mid-gesture; it finds out on its next command, and `hold` prints
which task it took the device from. `resume` releases it, and the same agent
session takes the device again on its next command instead of needing a
restart. Only a hold or handoff is released: a lease that belongs to another
task is left alone, because only the task that took the device can end cleanly.

A hold is not judged by process liveness — the command that wrote it has
already exited — so it never expires on its own and no agent command steals it
back. The person's phone stays theirs until they say otherwise.

There is no device-side signal for "a person is using the phone": the
UI-action stream closes the session and can wedge the agent daemon, and
injected taps are reported as fingers, so a synthetic action and a real one
cannot be told apart. A hold is therefore an explicit statement by the person,
which is also the only version an agent can obey.

## Statuses and exit codes

| Status | Exit | Meaning |
| --- | --- | --- |
| `settled` | 0 | The step ran and the UI settled. |
| `uncertain` | 1 | The UI never stopped changing within `--settle-ms`. |
| `not_found` | 1 | The ref, label or list is not on screen. |
| `lease_held` | 2 | Another task, or a person, holds this device. |
| `handoff` | 2 | You asked the person to take the phone; wait for `resume`. |
| `device_locked` | 2 | The screen is the system lock screen; only the person can unlock it. |
| `device_needs_setup` | 2 | The phone has not authorized this computer for debugging. |
| `device_offline` | 2 | No usable target: unplugged, off, or still connecting. |
| `approval_pending` | 3 | A person must approve this exact step. |
| `blocked` | 4 | Policy refused before the device was touched. |
| `approval_denied` | 4 | The approval id was wrong, used or expired. |
| `stale` | 4 | The screen changed while the approval waited. |

## Approvals

The policy classifies the labels of every element under the target:

| Rule | Examples | Default |
| --- | --- | --- |
| `credentials` | 密码, password, OTP, PIN | always blocked |
| `payments` | 支付, 付款, pay, checkout, transfer | approval |
| `finance` | 银行, 钱包, bank, wallet, alipay | approval |
| `deletes` | 删除, 卸载, delete, reset | approval |
| `sends` | 发送, 发布, send, publish | approval |
| `commits` | 确认, 保存, confirm, save | allowed |

The default set is payments, finance, deletes and sends — the four ways an
agent can do something a person cannot take back. `commits` stays opt-in
because it labels half the ordinary form buttons on a phone; a person asked on
every one of them learns to approve without reading. Narrow the set with
`--confirm payments,finance`.

Latin words match on word boundaries, so `pay` does not fire inside
`paypal`; Chinese matches as a substring. `--confirm` moves rules into the
approval set.

An approval id is bound to the command, its arguments and the target's
signature. It is single-use and expires after 10 minutes. A step whose target
moved between approval and execution returns `stale`; a step that changed in any
other way returns `approval_denied`.

`--approval-scope` decides how long the answer lasts. `once` (default) replays
the one step. `task` remembers the rule for the same app until `resume` or a
new task. `always` remembers it for every task that uses this state dir. A
grant is keyed by rule and app, and it only skips the approval prompt: a
credential is still always blocked, read-only still refuses anything that
changes data, and `--apps` still blocks an app outside the allow-list. `resume`
drops `task` grants — the context they were given in is gone — and keeps
`always` grants.

## State directory

```
<state-dir>/
  leases/<device-hash>.lock        one task per device
  refs-<device-hash>.json          ref table, so refs outlive a command
  approvals-<device-hash>.json     ids a person has been asked for
  grants-<device-hash>.json        rules a person asked not to be asked again
  traces/<timestamp>-<task>.jsonl  one file per command
  traces/<timestamp>-<title>.html
  shots/                           per-step screenshots, with --trace-shots
```

The ref and approval files are what make the one-command-per-invocation model
work: the ref an `observe` printed still addresses the same element in the
next `tap`, and the id an `approval_pending` printed can be redeemed by the
command that replays the step. A ref that is not on the current screen does not
resolve at all — it never silently addresses whatever took its place.

The device serial never appears in any of these files; only an 8-character
hash. The directory contains the person's screen contents: never commit it or
paste it into a document.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `device_offline` | No usable target: unplugged, off, or still connecting | Reconnect the cable, unlock the phone; `hdc list targets -v` shows the state. |
| `device_needs_setup` | The phone has not authorized this computer | Unlock it and tap Allow on the USB debugging prompt. |
| `device_locked` | The phone is on its lock screen | Ask the person to unlock it, or `handoff`; never guess a PIN. |
| `agent daemon never listened on 8012` | `uitest` could not start | Check `pidof uitest`; reboot the device if the daemon is wedged. |
| `lease_held` | Another task, or a person, holds the device | If it names `"held by a person"`, stop and wait: they will run `uitest-phone resume`. Otherwise wait for the heartbeat to expire, or remove the lock file if that task is gone. |
| `Disallow concurrent use` | Two processes drive one device, or a killed one still holds it | Use one task per device. A client killed mid-command leaves a `CLOSE_WAIT` socket on the daemon that holds the lock indefinitely; `connect` restarts the agent daemon when no live client is connected, and tells you the exact command when it cannot. |
| `Capture already running` | A recording is active | Stop it; capture is one channel per device. |
| `not_found` right after a tap | The ref belongs to the previous screen | `observe` and use the new refs. |
| `uncertain` on launch | The app animates longer than `--settle-ms` | Raise `--settle-ms` or `wait-for` the expected label. |
| `waitForIdle=no` in `doctor` | Older extension build | Settling falls back to host polling; everything else still works. |
