import net from "node:net";

/**
 * The two one-liners every device-facing module needs, in one place.
 *
 * They were copied into two and three modules respectively; a divergence in
 * `pids` decides which daemon a process believes it owns, and a divergence in
 * `connectTcp` is a tunnel that hangs instead of failing.
 */

/** Parses `pidof` output. Multiple pids come back space-separated on one line. */
export function pids(output: string): Set<string> {
  return new Set(output.split(/\s+/).filter((t) => /^\d+$/.test(t)));
}

/** Connects to a loopback port; rejects when nothing is listening. */
export function connectTcp(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, "127.0.0.1");
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}
