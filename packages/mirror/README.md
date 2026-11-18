# uitest-mirror

A HarmonyOS scrcpy. One command opens the phone in its own window; the mouse
and keyboard go to the device. Built on [`uitest-sdk`](https://www.npmjs.com/package/uitest-sdk).

```bash
npm i -g uitest-mirror
uitest-mirror
```

```
uitest-mirror [--serial <id>] [--transport grpc|ws|mjpeg] [--max-fps 15|30|60|120]
              [--bit-rate N] [--max-size N] [--record <file>]
              [--no-control] [--stay-awake] [--window-title <text>]
              [--port N] [--state-dir dir] [--ws-extension <path>]
```

| Flag | Meaning |
|---|---|
| `--serial` | Which device, when more than one is attached |
| `--transport` | `grpc` (6.8 extension, bundled), `ws` (7.0 extension, `--ws-extension`), `mjpeg` (no extension) |
| `--max-fps` | 15, 30, 60 or 120. Other values are refused: the extension silently ignores them |
| `--bit-rate` | Encoder bit rate in bits/s. Default 8 000 000 |
| `--max-size` | Longest edge in pixels. Resolved to the transport's own scale |
| `--record` | Record from the first frame to this file; stopped when the window closes |
| `--no-control` | Watch only: no keyboard, no mouse |
| `--stay-awake` | Override the device's sleep timeout while running |
| `--window-title` | The window's title |
| `--port` | Page port. Default 0 (the kernel picks one) |

## What it does not do

No MCP, no skill, no approval inbox, no automation commands, no node table, no
audio, no camera, no OTG. Those live in `uitest-phone` and `uitest-console`.

## The device is yours while it runs

`uitest-mirror` takes the device lease, the same lease an agent task takes. If
an agent holds the phone, mirror exits and names the holder rather than
fighting for it. Release it by closing the window.

## Staying awake

`--stay-awake` sets the device's sleep timeout with `power-shell timeout -o`
and restores it with `-r` on a clean exit. If the process is killed outright
the override stays; put it back with:

```bash
hdc shell power-shell timeout -r
```

## Requirements

- Node 20+
- `hdc` on `PATH`, or `HDC_PATH` pointing at it
- A HarmonyOS device with the SDK's extensions available for the transport you
  choose (`uitest-sdk` ships the 6.8 build; `--transport ws` needs your own
  7.0 `libscreen_casting.z.so`)

Unset `HDC_SERVER_PORT` before running if your shell sets it: it points hdc at
a different server and the device will look absent.
