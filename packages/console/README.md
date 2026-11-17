# uitest-console

The person-facing half of [`uitest-phone`](https://www.npmjs.com/package/uitest-phone):
a local web page that mirrors the phone, lets you take it, and shows the steps
waiting for your approval. Built on [`uitest-sdk`](https://www.npmjs.com/package/uitest-sdk).

```bash
npm i -g uitest-console
uitest-console
```

It opens a browser window with:

- the live screen and the node table, with the same masking as the SDK;
- **Hold / Resume** — Hold takes the device, so every agent command stops with
  `lease_held`; Resume hands it back;
- **the approval inbox** — steps the policy gated, with the app, the rule and
  the time left; Allow (once / this task / always) or Deny.

Watching does not take the device, so it can run beside an agent session. The
page listens on `127.0.0.1:7042` unless `--host` says otherwise; anyone who can
reach that port can watch and drive the phone.

```bash
uitest-console --device <id> --state-dir .uitest-phone   # pick a device/state
uitest-console --transport mjpeg --scale 2               # emulator or slow link
uitest-console --no-open                                 # print the URL only
```

Full documentation: <https://growvv.github.io/uitest-sdk/>.
