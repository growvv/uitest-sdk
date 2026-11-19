# Changelog

## 0.1.2 (2026-11-20)

Runs on `uitest-sdk@0.11.2`. No source changes in this package: the release
carries the core fixes below and the new `bench` acceptance case.

- The acceptance report now measures the four mirrorbench numbers on the
  device at acceptance time (first picture, drag fps, input→frame median)
  instead of only opening a window and photographing it.

## 0.1.1 (2026-11-19)

Runs on `uitest-sdk@0.11.1`. Fixes what the first acceptance run found: the
window the product opens is now the window it watches.

- **The window is a window, not a hand-off.** The browser is launched with a
  profile of its own, so the process this command spawned lives as long as the
  window. Before this, a browser that was already running took the URL and the
  launcher exited at once — and because a closed window is a stop signal, the
  product stopped the moment it started.
- **A browser that is not installed is not a closed window.** On Windows
  `msedge.exe` and `chrome.exe` are not on PATH; the launch failed
  asynchronously and was read as "the person closed the window". The installed
  path is now used, and only a process that really ran can report a close.
- **Stopping for any other reason closes the window**, so Ctrl+C or a closed
  stdin does not leave a page pointing at a server that is gone.
- **The window's profile is deleted before the process exits.** Removing it
  right after the kill loses a race with the browser's shutdown (EPERM for
  about 590 ms on Windows), and the old retry was an unref'd timer the exiting
  process never reached — one 20–760 MB directory per stop. `close()` now
  waits for the removal to finish.
- **A stop releases the cast daemon and its forward.** A frame arriving while
  the product was shutting down made the viewer drop the cast without
  disposing it, so the phone kept a `libscreen_casting` daemon and an hdc
  forward, and the open socket kept this process alive past its own `close()`
  — the acceptance harness killed it after 20 s. Fixed in core 0.11.1.
- Runs on core's lifecycle fixes: a second `close()`/`stop()` joins the first
  instead of returning early, and a daemon the reconnect started is cleaned up
  too.

## 0.1.0 (2026-11-18)

First release: a HarmonyOS scrcpy as the fourth package in this repository.

- One command opens the device in a borderless browser window (`--app`), with
  a plain URL printed when neither Edge nor Chrome is installed.
- Mouse and keyboard go to the phone: click, drag, wheel, pinch, text and the
  system keys including Back, Home and Recents.
- `--max-fps`, `--bit-rate`, `--max-size`, `--transport` map onto core's cast.
  `--max-size` is resolved per transport, because an integer divisor and a
  fraction are not the same number.
- `--record <file>` records from the first frame, not from a button press. A
  transport that cannot record (mjpeg, or a device without the H.264
  extension) says so in the page instead of failing silently.
- `--window-title` sets the page's title; closing the window ends the run and
  releases the lease.
- `--stay-awake` overrides the device's sleep timeout and restores it on exit.
- Takes the device lease: an agent holding the phone makes mirror exit and
  name the holder instead of interleaving gestures with it. The lease is also
  checked before every gesture, so `uitest-phone hold` stops the mirror from
  driving a phone a person has taken.
- Out of scope by design: MCP, skill, approvals, automation, the node table,
  audio, camera and OTG.
