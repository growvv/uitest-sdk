import { describe, it, expect } from "vitest";
import { Recording } from "../../src/live/record.js";
import type { CastClient, CastOptions } from "../../src/cast/types.js";

/**
 * A record client that behaves like the real one where it matters.
 *
 * `H264CastClient.start()` opens the recording itself in record mode, and its
 * own comment says `onStart` cannot be called twice in one process. So the
 * client counts `stream()` calls: opening one after `start()` is exactly the
 * bug that produced a 259-byte MP4 and a second device daemon.
 */
class FakeRecordClient implements CastClient {
  readonly castKind = "h264" as const;
  streamCalls = 0;
  disposed = false;
  async *stream(): AsyncIterable<never> {
    this.streamCalls++;
    // A record client streams nothing to us: frames go to the device muxer.
    return;
  }
  async requestIDRFrame(): Promise<void> {}
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function harness() {
  const made: FakeRecordClient[] = [];
  const options: CastOptions[] = [];
  const stateDir = "C:/tmp/state";
  const rec = new Recording({
    stateDir,
    socketName: "uitest_live_record_4242",
    createCast: async (opts) => {
      options.push(opts);
      const c = new FakeRecordClient();
      made.push(c);
      return c;
    },
    streamCast: { mode: "stream", frameRate: 30 } as CastOptions,
  });
  return { rec, made, options, stateDir };
}

describe("Recording", () => {
  it("starts a record cast without opening a second stream", async () => {
    // The record client is already recording when start() returns. Calling
    // stream() on it opens a second onStart on the same daemon, which the
    // extension does not allow: it fails to start and the file stays empty.
    const { rec, made } = harness();
    const path = await rec.start();

    expect(path).toMatch(/\.mp4$/);
    expect(made).toHaveLength(1);
    expect(made[0]!.streamCalls).toBe(0);
    await rec.stop();
  });

  it("records in record mode with an output path and its own socket", async () => {
    const { rec, options } = harness();
    await rec.start();

    expect(options).toHaveLength(1);
    const opts = options[0]!;
    expect(opts.mode).toBe("record");
    // Without outputPath the client refuses to start at all; without its own
    // socket the record daemon would take the stream's.
    expect(opts.outputPath).toMatch(/\.mp4$/);
    expect(opts.socketName).toBeTruthy();
    expect(opts.socketName).not.toBe("scrcpy_grpc_socket");
    await rec.stop();
  });

  it("gives the websocket transport a port of its own", async () => {
    // The ws transport has no socket names, only ports: sharing one would make
    // the record daemon collide with the stream daemon.
    const made: FakeRecordClient[] = [];
    const options: CastOptions[] = [];
    const rec = new Recording({
      stateDir: "C:/tmp/state",
      socketName: "uitest_live_record_4242",
      createCast: async (opts) => {
        options.push(opts);
        const c = new FakeRecordClient();
        made.push(c);
        return c;
      },
      streamCast: { mode: "stream", transport: "ws", port: 5000 } as CastOptions,
    });
    await rec.start();
    expect(options[0]!.port).toBe(5001);
    await rec.stop();
  });

  it("disposes the client and returns the path it was given", async () => {
    const { rec, made } = harness();
    const path = await rec.start();
    const stopped = await rec.stop();

    expect(stopped).toBe(path);
    expect(made[0]!.disposed).toBe(true);
    // A second stop is a no-op rather than a second pull of the same file.
    expect(await rec.stop()).toBeNull();
  });

  it("refuses a second start while one is running", async () => {
    const { rec, made } = harness();
    await rec.start();
    await expect(rec.start()).rejects.toThrow(/already recording/i);
    expect(made).toHaveLength(1);
    await rec.stop();
  });

  it("clears the client when start fails, so a retry can work", async () => {
    let calls = 0;
    const rec = new Recording({
      stateDir: "C:/tmp/state",
      socketName: "uitest_live_record_4242",
      createCast: async () => {
        calls++;
        if (calls === 1) throw new Error("daemon did not start");
        return new FakeRecordClient();
      },
      streamCast: { mode: "stream" } as CastOptions,
    });
    await expect(rec.start()).rejects.toThrow(/daemon did not start/);
    // The failure must not leave a half-set state behind: the next start works.
    // (`start()` would throw "already recording" if the failed attempt had
    // stored its client.)
    await expect(rec.start()).resolves.toMatch(/\.mp4$/);
    await rec.stop();
  });
});
