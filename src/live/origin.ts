import { isIP } from "node:net";

/**
 * Whether an `Origin` header may open the live WebSocket.
 *
 * A WebSocket is exempt from the same-origin policy: any page the person has
 * open can connect to `ws://127.0.0.1:7000` and start sending frames, and the
 * default port is a constant. The check therefore has to happen on the server,
 * and it has to be an allow-list rather than a deny-list.
 *
 * `origin === undefined` means the header was absent. A browser always sends
 * one for a WebSocket, so that is a programmatic client — already able to run
 * `hdc` itself, and not something this check can constrain. `"null"` is the
 * opposite case: a sandboxed frame or a `file://` page sends it and is exactly
 * what must be refused.
 *
 * The rule is "the page must have been served from the address the client
 * dialled": same host, same port, and plain HTTP, because that is the only
 * scheme this server speaks. When bound to loopback, the dialled name must
 * itself be a loopback name — that is what refuses DNS rebinding, where an
 * attacker's domain resolves to 127.0.0.1 and would otherwise present a
 * matching Host and Origin. When the server was deliberately opened to the
 * network (`--host`), rebinding is the accepted cost of that choice.
 */

export interface OriginContext {
  /** The address the server bound. */
  host: string;
  /** The port it bound, used when the client sent no port in `Host`. */
  port: number;
  /** The client's `Host` header, e.g. `127.0.0.1:7000`. */
  hostHeader: string;
}

/** Hosts that mean "this machine". */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

/**
 * An IP literal, or `localhost`. A page served by this server is reached by an
 * address, never by a domain name — so a `Host` that is a domain can only come
 * from a name that resolved here from somewhere else, which is DNS rebinding.
 */
function isAddressLiteral(host: string): boolean {
  if (isLoopback(host)) return true;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return isIP(bare) !== 0;
}

/** `192.168.1.5:7000` → `{ host: "192.168.1.5", port: 7000 }`. */
function splitHostHeader(header: string): { host: string; port: number | null } {
  const trimmed = header.trim();
  // `[::1]:7000` — the colons inside the brackets are not separators.
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed) {
    return { host: `[${bracketed[1]}]`, port: bracketed[2] ? Number(bracketed[2]) : null };
  }
  const last = trimmed.lastIndexOf(":");
  if (last > 0 && /^\d+$/.test(trimmed.slice(last + 1))) {
    return { host: trimmed.slice(0, last), port: Number(trimmed.slice(last + 1)) };
  }
  return { host: trimmed, port: null };
}

export function originAllowed(origin: string | undefined, ctx: OriginContext): boolean {
  if (origin === undefined) return true;
  if (origin === "null" || origin === "") return false;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // This server speaks plain HTTP; a TLS origin is a different page.
  if (url.protocol !== "http:") return false;

  const dialled = splitHostHeader(ctx.hostHeader);
  const dialledPort = dialled.port ?? ctx.port;
  if (Number(url.port || 80) !== dialledPort) return false;

  const originHost = url.hostname.toLowerCase();
  const dialledHost = dialled.host.toLowerCase();

  // A domain in `Host` means the name resolved to this address from elsewhere
  // — the rebinding attack. No legitimate page is served under a domain.
  if (!isAddressLiteral(dialledHost)) return false;

  if (isLoopback(ctx.host)) {
    // A loopback-bound server is only reachable on a loopback name.
    return isLoopback(originHost);
  }

  return originHost === dialledHost;
}
