---
name: uitest-phone
description: Use when a coding agent needs to operate a HarmonyOS app on a connected phone or emulator — launch it, read what is on screen, tap, type or swipe by ref, read a scrolling list, wait for UI, or capture screenshots.
---

# uitest-phone

Drive a HarmonyOS device with one CLI. Each command opens the device, runs one
step, waits for the UI to settle, and prints the resulting screen or a diff.

```bash
npx uitest-sdk doctor
```

`doctor` must report a target and a `waitForIdle=yes` capability. `npx` runs the
package's only binary; once installed, the command itself is `uitest-phone`.
Then work in steps:

```bash
npx uitest-sdk observe --task "check whether WLAN is on"
npx uitest-sdk tap --ref 12 --task "check whether WLAN is on"
```

Every command takes the same global flags, so the session is reconstructed per
call:

| Flag | Meaning |
| --- | --- |
| `--task <name>` | Name this task; it appears in the lease and the trace. |
| `--state-dir <dir>` | Traces, shots and leases (default `.uitest-phone`). |
| `--device <id>` | hdc target when several are attached. |
| `--read-only` | Refuse anything that changes data. |
| `--apps a.b,c.d` | Allow-list; other apps are blocked. |
| `--confirm <rules>` | `payments,finance,deletes,sends,commits`, `all`, or `none`. |
| `--settle-ms <n>` | How long to wait for the UI to go quiet. |
| `--trace-shots` | Save a screenshot with every step (~180 ms each). |
| `--approval-id <id>` | Run one step a person approved. |
| `--json` | Print one JSON document instead of text. |

Do not write ad-hoc scripts against the SDK or raw `hdc` for UI. The CLI
resolves bundles and abilities, waits for the UI to settle, records every step,
and enforces approvals.

## Setup

```
npx uitest-sdk connect [--agent claude|codex]
```

One command makes an agent ready: it registers the MCP server in that agent's
own settings file — only this package's entry; comments and order stay — and
installs this skill into the directories the agent reads (`~/.claude/skills`
for Claude Code, `~/.agents/skills` for the cross-runtime alias). Start a new
session afterwards. Details in [REFERENCE.md](REFERENCE.md#connect-an-agent).

## The loop

1. `observe` and read the screen.
2. Pick a `[ref]` and act on it.
3. Read the returned screen or diff.
4. Repeat; finish with `report` when the person wants a record.

## Reading a screen

```
screen 1216x2688 · app: com.huawei.hmos.settings · rotation 0° · focus [7]
[2] input "Search settings" @608,206
[7] input "" @608,300 focused
[12] button "WLAN" @608,610
[13] toggle "WLAN" @1200,610 checked
[20] list "Apps" @608,900 scrollable
```

Each line is `[ref] role "label" @centerX,centerY states`. Roles include
`text`, `button`, `input`, `list`, `toggle`, `checkbox`, `radio`, `slider`,
`tabs`, `nav`. States include `focused`, `disabled`, `checked`, `selected`,
`scrollable`, `password`.

- A ref is a handle for the current screen. It stays valid while the element
  keeps its label and place; after the screen changes, use the newest output.
- `not_found` means the ref or label is not there now: `observe` and choose
  again. Do not guess coordinates.
- The renderer omits the status bar, the bottom navigation bar, structural
  containers and unlabeled inert nodes. If the person asks about something not
  listed, take a `screenshot`.
- After an action the CLI prints a diff: `+` added, `-` removed, `~` changed;
  `no change` means nothing changed. It prints the full screen when the app,
  size or rotation changed, or when too much changed.
- `uncertain` means the UI never stopped changing. Observe before deciding the
  action worked.

## Acting

| Goal | Command |
| --- | --- |
| Tap by ref | `tap --ref 12` |
| Tap by label | `tap --text WLAN` |
| Tap by selector | `tap --selector "type=Button&text=Save"` |
| Long-press | `tap --ref 12 --long` |
| Double-tap | `double-click --ref 12` |
| Drag an item | `drag --from 600,1400 --to 600,500` |
| Fling a list | `fling --direction up` |
| Zoom in or out | `pinch --ref 20 --scale 2` |
| Type into the focused field | `type --text "hello"` |
| Type into a field | `type --ref 7 --text "hello"` |
| Scroll a list | `swipe --direction up --ref 20` |
| Swipe by points | `swipe --from 600,1800 --to 600,600` |
| System key | `key --key back` (also `home`, `power`, `enter`) |
| Wait for a label | `wait-for --text "Connected"` |
| Read a whole list | `read-list --ref 20` |
| Scroll until visible | `scroll-until --text "About"` |
| Open an app | `launch --app settings` or `--app com.example.app` |
| Find a bundle id | `apps --query wechat` |
| App in front | `apps --current` |
| Is this installed | `apps --has com.example.app` |
| Inspect a window | `window --bundle com.example.app` |
| Save a screenshot | `screenshot --out shot.jpg` |
| Write a report | `report --title "WLAN check"` |
| Session info | `status` |

Selectors: `text=`, `text~=` (contains), `type=`, `id=`, and the bare
predicates `clickable`, `scrollable`, `enabled`, `checked`, `focused`; chain
them with `&`. Type names are case-sensitive on the device — `type=Button`
matches, `type=button` does not.

Launch aliases: `settings`, `launcher`/`home`, `camera`, `photos`/`gallery`,
`clock`, `calendar`, `calculator`. A name without dots is matched against
installed bundles; a bundle id is used directly. `--ability NAME` overrides the
declared entry ability.

- Prefer `--ref` or `--text`; use `--x/--y` only when the element has no label,
  and take the numbers from the screen output.
- `launch` returns whatever page the app resumes on. Settings may reopen a
  previous subpage; press `back` until the expected page is on screen, or use
  `wait-for`.
- `read-list` pages the largest list, or the list at `--ref`, and prints each
  label once. A list that does not announce its end costs one extra scroll.
- `scroll-until` pages the list one screen at a time. The device's own
  `scrollSearch` is not used: a miss blocks for 30 s and leaves the device
  locked afterwards.
- `drag` holds before moving, which is what a reorder gesture needs; `swipe`
  scrolls and `fling` keeps the list moving after release. Pick by what the UI
  expects, not by distance.
- `pinch` is the only two-finger gesture: `--ref` zooms inside an element,
  `--scale` above 1 zooms in and below 1 zooms out. A single-finger swipe
  cannot substitute for it.
- `screenshot` saves the device JPEG at half the display size; double any pixel
  measured in it before using it as a coordinate. The command reports the
  frame size, display size and factor.
- `type` uses the device IME, so Chinese and emoji work. Check the diff rather
  than assuming the field accepted the text.

## Statuses

| Status | Meaning | What to do |
| --- | --- | --- |
| `settled` | The action ran and the screen settled. | Read the diff and continue. |
| `uncertain` | The screen never stopped changing. | Observe before deciding it worked. |
| `not_found` | The ref, label or list was not there. | Observe and choose again. |
| `approval_pending` | The policy needs a person's approval. | Stop and ask; see below. |
| `approval_denied` | The id was unknown, expired, already used, or did not match. | Do not retry another way; report it. |
| `blocked` | Credentials, read-only, or the app allow-list refused. | Report the rule; do not work around it. |
| `stale` | The screen changed while an approval waited. | Observe and, if still needed, ask again. |
| `lease_held` | Another task — or the person — holds the phone. | Stop. Do not retry in a loop. |

CLI exit codes: `0` settled, `1` uncertain/not_found, `2` lease held,
`3` approval pending, `4` blocked/denied/stale.

When `lease_held` names `"held by a person"`, a person is using the phone.
Stop and tell them; they will run `uitest-phone resume` when they are done.
Do not delete the lock file, do not retry in a loop, and do not look for
another way to drive the device. This can arrive between two calls of one MCP
session: a person may take the phone at any time.

## Approvals and safety

By default, **payments, finance, deleting and sending** stop at
`approval_pending`. Those are the four things a person cannot take back: money
leaves, a file is gone, a message has been read. The policy matches the labels
of every element under the target, plus the app argument for `launch`.

`commits` (确认 / 保存) is deliberately *not* on the default list: it is the
label of half the ordinary form buttons on a phone, and asking on every one
would train the person to approve without reading.

When you get `approval_pending`:

1. Tell the person the exact step and the rule, and wait for an explicit yes.
2. Repeat the **same command, exactly**, adding `--approval-id <id>`.
3. The id is one-use, expires, and is bound to the command and the screen. If
   the screen changed you get `stale`; observe and ask again.
4. If the person says no, stop. `approval_denied` or `blocked` means do not
   route around it.

Credential fields (password, OTP, PIN, verification code) are always blocked.
Do not ask the person for a password or OTP, and do not type one even into a
field the policy did not label as a credential field; ask the person to take
the phone.

`--confirm all` adds deleting, sending and confirming actions to the approval
set. `--confirm none` removes approvals only on the person's explicit
instruction; credentials and read-only still apply.

## Finish

```bash
npx uitest-sdk report --title "WLAN check"
```

This writes an HTML report with every step to `<state-dir>/traces/`. It reads
the task's trace files back from disk, so it covers steps from earlier commands
too — not just the one that wrote the report. Each command releases the device
when it exits, so there is no lease to drop; a crashed command's lease expires
on its own.

`<state-dir>` (default `.uitest-phone/`) is gitignored and contains the person's
screen contents. Never commit it, paste it into documentation, or copy it into
a PR.

## Limitations

- HarmonyOS only; the phone or emulator must be attached and visible to `hdc`.
- Visible UI only. Background app automation is out of scope.
- One task per phone: a second task gets `lease_held` rather than a corrupted
  screen.
- List item refs change when the list scrolls; use `read-list` for whole lists.
- If a capability is missing, `doctor` says so. Report the gap; do not add your
  own SDK or `hdc` script.

Full command and argument reference: [REFERENCE.md](REFERENCE.md).
