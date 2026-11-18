import net from "node:net";
import { AgentClient } from "../driver/agent/client.js";
import { AgentInputLane } from "./lane.js";
import type { InputSession } from "./lane.js";
import type { HdcRunner } from "../transport/hdc.js";
import { connectTcp } from "../transport/helpers.js";

/** The part of a connected device an input lane needs; `Device` satisfies it. */
export interface InputHost {
  readonly hdc: HdcRunner;
  readonly deviceId: string;
  readonly agentPort: number;
  readonly requestTimeoutMs?: number;
  readonly retryOnBusy?: boolean;
}


/**
 * Opens a second agent connection dedicated to input.
 *
 * The daemon serialises requests per connection, so a click sent on the
 * read connection waits behind a 300-600 ms layout read. A second forward
 * and socket give input its own queue: measured p50 12 ms while layout reads
 * are in flight. No daemon is started and no health check is run - a
 * read-only `live` page never calls this, and the first failure is reported
 * to whoever tried to take control.
 *
 * No transparent reconnect: replaying a gesture after a socket swap is how
 * duplicate down/up pairs reach the device. The caller opens a fresh lane
 * after the failure instead.
 */
export async function openInput(host: InputHost): Promise<InputSession> {
  const port = await host.hdc.fportAdd(host.agentPort, "tcp:8012");
  let sock: net.Socket;
  try {
    sock = await connectTcp(port);
  } catch (e) {
    await host.hdc.fportRemove(port).catch(() => undefined);
    throw e;
  }
  const client = new AgentClient(sock, {
    requestTimeoutMs: host.requestTimeoutMs,
    retryOnBusy: host.retryOnBusy,
  });
  const hdc = host.hdc;
  return {
    lane: new AgentInputLane(client),
    async close() {
      client.close();
      await hdc.fportRemove(port).catch(() => undefined);
    },
  };
}
