# uitest-phone

Headless HarmonyOS device agent: a 21-command CLI, an MCP server and an agent
skill, built on [`uitest-sdk`](https://www.npmjs.com/package/uitest-sdk).

```bash
npm i -g uitest-phone     # or: npx uitest-phone doctor
uitest-phone doctor
```

Each command opens the device, runs one step, waits for the UI to settle, and
prints the resulting screen or a diff. The same 21 commands are served to an
MCP client by `uitest-phone mcp`, and `uitest-phone connect` writes the MCP
entry and installs the skill for Claude Code, Codex, Gemini CLI or Copilot CLI.

- `hold` / `handoff` / `resume`: the person takes the phone and agents stop
  with `lease_held` until they hand it back.
- `approvals`: list, allow and deny the steps policy gated.

The browser mirror is a separate product: [`uitest-console`](https://www.npmjs.com/package/uitest-console).

Full documentation: <https://growvv.github.io/uitest-sdk/>.
