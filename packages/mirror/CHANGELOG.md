# Changelog

## 0.1.0 (2026-11-18)

First release: a HarmonyOS scrcpy as the fourth package in this repository.

- One command opens the device in a borderless browser window (`--app`), with
  a plain URL printed when neither Edge nor Chrome is installed.
- Mouse and keyboard go to the phone: click, drag, wheel, pinch, text and the
  system keys including Back, Home and Recents.
- `--max-fps`, `--bit-rate`, `--max-size`, `--transport` map onto core's cast.
  `--max-size` is resolved per transport, because an integer divisor and a
  fraction are not the same number.
- `--record <file>` records from the first frame, not from a button press.
- `--stay-awake` overrides the device's sleep timeout and restores it on exit.
- Takes the device lease: an agent holding the phone makes mirror exit and
  name the holder instead of interleaving gestures with it.
- Out of scope by design: MCP, skill, approvals, automation, the node table,
  audio, camera and OTG.
