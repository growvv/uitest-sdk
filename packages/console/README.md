# uitest-console

The person-facing half of [`uitest-phone`](https://www.npmjs.com/package/uitest-phone):
a local web page that mirrors the phone, lets you take it, and shows the steps
waiting for your approval. Built on [`uitest-sdk`](https://www.npmjs.com/package/uitest-sdk).

```bash
npm i -g uitest-console
uitest-console
```

It opens a browser window with:

- **the mirror and the node table** — the same player, masking and Origin check
  as the SDK; click a node (or its box) to copy its ref, role, label and centre;
- **Hold / Resume** — Hold writes the person's lease, so every agent command
  stops with `lease_held`; Resume hands the phone back and the next command
  continues. Watching alone never takes the lease, so the console runs beside an
  agent session;
- **the approval inbox** — the steps the policy gated, with the app, the rule and
  the time left; Allow (once / this task / always) or Deny. It writes the same
  decision files `uitest-phone approvals` writes, so either channel can answer;
- **recent activity** — the last trace steps, read-only, newest last.

```bash
uitest-console --device <id> --state-dir .uitest-phone   # pick a device/state
uitest-console --transport mjpeg --scale 2               # emulator or slow link
uitest-console --record demo.mp4                         # record while you watch
uitest-console --no-layout                               # mirror only, no node table
uitest-console --no-open                                 # print the URL only
```

The same flags the old `uitest-sdk live` took are still here: `--privacy on|off`,
`--port`, `--host`, `--fps`, `--cast-port`, `--ws-extension`.

## Security

The server listens on `127.0.0.1:7042` unless `--host` says otherwise. **Anyone
who can reach that port can watch and drive the phone** — `--host 0.0.0.0` hands
the device to the whole network. The WebSocket handshake only accepts an `Origin`
matching the address the client dialled (the implementation is core's, shared
with every product), the inbox writes the gateway's decision files, Hold is an
explicit lease, and device text is escaped before it reaches the page. Device
serials only ever appear as the 8-character tag.

Full documentation: <https://growvv.github.io/uitest-sdk/>.
