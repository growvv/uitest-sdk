import { describe, it, expect } from "vitest";
import { originAllowed } from "../../src/viewer/origin.js";

/**
 * Which `Origin` headers may open the live WebSocket.
 *
 * A WebSocket is exempt from the same-origin policy: the browser will connect
 * a page to `ws://127.0.0.1:7000` no matter what origin that page came from.
 * So the check has to happen here, and the default port being fixed at 7000
 * makes the address trivially discoverable.
 *
 * `undefined` means the header was absent, which a browser never does — only a
 * programmatic client, which is not confined by a page and can already run hdc
 * itself. `null` is different: a sandboxed frame or a file:// page sends it.
 */

const LOCAL = { host: "127.0.0.1", port: 7000, hostHeader: "127.0.0.1:7000" };

describe("originAllowed", () => {
  it("accepts the page's own origin", () => {
    expect(originAllowed("http://127.0.0.1:7000", LOCAL)).toBe(true);
    expect(originAllowed("http://localhost:7000", LOCAL)).toBe(true);
  });

  it("accepts the loopback aliases interchangeably", () => {
    // The person may type either; the page served on one origin is the same
    // page. Refusing localhost because the server bound 127.0.0.1 would be a
    // usability bug, not a security win.
    expect(originAllowed("http://127.0.0.1:7000", { ...LOCAL, hostHeader: "localhost:7000" })).toBe(true);
    expect(originAllowed("http://localhost:7000", LOCAL)).toBe(true);
    expect(originAllowed("http://[::1]:7000", LOCAL)).toBe(true);
  });

  it("refuses another site's origin", () => {
    // The attack: any page the person visits opens a socket to the fixed port
    // and starts driving the phone.
    expect(originAllowed("https://evil.example", LOCAL)).toBe(false);
    expect(originAllowed("http://evil.example:7000", LOCAL)).toBe(false);
    expect(originAllowed("https://127.0.0.1:7000", LOCAL)).toBe(false);
  });

  it("refuses a null origin", () => {
    // A sandboxed iframe or a downloaded file:// page sends `Origin: null`.
    expect(originAllowed("null", LOCAL)).toBe(false);
  });

  it("accepts a client that sent no origin at all", () => {
    // Not a browser. It is not sandboxed by anything the SDK can enforce.
    expect(originAllowed(undefined, LOCAL)).toBe(true);
  });

  it("refuses a different port on the same host", () => {
    // Another local server is still another origin: a page it serves could
    // otherwise reach this one.
    expect(originAllowed("http://127.0.0.1:8080", LOCAL)).toBe(false);
  });

  it("refuses a malformed origin", () => {
    expect(originAllowed("not a url", LOCAL)).toBe(false);
    expect(originAllowed("", LOCAL)).toBe(false);
    expect(originAllowed("ftp://127.0.0.1:7000", LOCAL)).toBe(false);
  });

  it("accepts the LAN address when the server was opened to the network", () => {
    // --host 0.0.0.0 is the person saying "reachable from elsewhere", so the
    // page legitimately comes from the machine's LAN address. Rebinding is the
    // accepted cost of that choice, and the CLI warns about it.
    const open = { host: "0.0.0.0", port: 7000, hostHeader: "192.168.1.5:7000" };
    expect(originAllowed("http://192.168.1.5:7000", open)).toBe(true);
    // A page from anywhere else is still refused: the origin has to match the
    // host the client dialled.
    expect(originAllowed("https://evil.example", open)).toBe(false);
    expect(originAllowed("http://192.168.1.6:7000", open)).toBe(false);
    // The same person on loopback sends Host: 127.0.0.1:7000 instead.
    expect(originAllowed("http://127.0.0.1:7000", { ...open, hostHeader: "127.0.0.1:7000" })).toBe(true);
  });

  it("accepts the configured non-loopback host and nothing else", () => {
    const lan = { host: "192.168.1.5", port: 7000, hostHeader: "192.168.1.5:7000" };
    expect(originAllowed("http://192.168.1.5:7000", lan)).toBe(true);
    expect(originAllowed("http://192.168.1.6:7000", lan)).toBe(false);
  });

  it("refuses DNS rebinding against a loopback-bound server", () => {
    // The rebinding attack: attacker.example resolves to 127.0.0.1, so the
    // browser sends Host and Origin both naming the attacker's domain. A
    // loopback server cannot be reached under any other name, so a non-loopback
    // Host means the name resolved here from elsewhere.
    const rebinding = { host: "127.0.0.1", port: 7000, hostHeader: "attacker.example:7000" };
    expect(originAllowed("http://attacker.example:7000", rebinding)).toBe(false);
  });
});
