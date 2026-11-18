import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CastClient, CastOptions } from "./types.js";
import { UitestError } from "../transport/errors.js";

/** The port offset for the record daemon under the ws transport. */
const RECORD_PORT_OFFSET = 1;

export interface RecordingOptions {
  /** Where the MP4 goes; the file is named by start time under `shots/`. */
  stateDir: string;
  /**
   * Writes the MP4 to this exact path instead of `shots/live-<time>.mp4`.
   * Used when a person named the file they will look for afterwards.
   */
  outputPath?: string;
  /**
   * Socket name for the record daemon, unique per process.
   *
   * A fixed name is not usable: a second `live` on the same device would take
   * over the first one's socket, and the two daemons would fight over it.
   */
  socketName: string;
  createCast(opts: CastOptions): Promise<CastClient>;
  /** The stream's own cast options, copied so the record daemon differs only
   *  where it must: mode, output path and socket/port. */
  streamCast: CastOptions;
}

/**
 * One MP4 recording, started and stopped from the live page.
 *
 * The record daemon has to run beside the stream daemon — pressing record must
 * not stop the picture — so it needs a socket (grpc) or port (ws) of its own.
 *
 * The client is recording as soon as `createCast` resolves: record mode opens
 * `onStart` inside `start()`, because `onEnd` can only close a muxer that was
 * opened. Calling `stream()` on it would open a *second* `onStart` on the same
 * daemon, which the extension refuses — measured as a 259-byte MP4 and a
 * second, orphaned device process.
 */
export class Recording {
  private cast: CastClient | null = null;
  private path: string | null = null;
  /**
   * A `start()` that has not resolved yet.
   *
   * `this.cast` is only set once `createCast` resolves, so two calls that
   * arrive while the first is still opening the record daemon both passed the
   * `cast` check and started a second daemon on the same socket — the second
   * takes the first one's place and one recording is lost. This flag is set
   * synchronously, before the first await, so the second call is refused.
   */
  private starting = false;
  /**
   * The `start()` in flight, so a `stop()` that arrives during it waits for the
   * cast to exist instead of reporting that nothing was running. Returning
   * `null` there told the caller the file was not coming while `start()` was
   * about to install a live cast nobody would stop.
   */
  private startPromise: Promise<string> | null = null;
  /**
   * The `stop()` in flight. `this.cast` is cleared before `dispose()` is
   * awaited, so a second caller saw nothing running and resolved at once —
   * while the first was still stopping the daemon, pulling the MP4 and
   * removing the forward.
   */
  private stopPromise: Promise<string | null> | null = null;

  constructor(private readonly opts: RecordingOptions) {}

  /** Starts recording; resolves with the path the MP4 will be written to. */
  async start(): Promise<string> {
    if (this.cast || this.starting || this.stopPromise) {
      throw new UitestError("already recording", "EBADARG");
    }
    this.starting = true;

    const out = this.opts.outputPath ?? join(this.opts.stateDir, "shots", `live-${Date.now()}.mp4`);
    const run = (async () => {
      await mkdir(dirname(out), { recursive: true });

      const stream = this.opts.streamCast;
      const cast = await this.opts.createCast({
        ...stream,
        mode: "record",
        // A second daemon on the stream's socket would take the picture away.
        ...(stream.transport === "ws"
          ? { port: (stream.port ?? 5000) + RECORD_PORT_OFFSET }
          : { socketName: this.opts.socketName }),
        outputPath: out,
      });
      // Set only after the cast exists: a failed start must leave no half-state
      // behind, or the next attempt would be refused as "already recording".
      this.cast = cast;
      this.path = out;
      return out;
    })();
    // Recorded synchronously, before the first await, so `stop()` can join it.
    this.startPromise = run;
    try {
      return await run;
    } finally {
      this.starting = false;
      if (this.startPromise === run) this.startPromise = null;
    }
  }

  /**
   * Stops the recording and resolves with the finished file, or null when
   * nothing was running. `dispose()` ends the call and pulls the MP4.
   */
  stop(): Promise<string | null> {
    // A second caller joins the first stop rather than returning `null` while
    // the daemon, the file and the forward are still being released.
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }

  private async finishStop(): Promise<string | null> {
    // A start that is still opening the daemon is about to install a cast. It
    // is ours to stop, not something to report as absent.
    const starting = this.startPromise;
    if (starting) await starting.catch(() => undefined);
    const cast = this.cast;
    const out = this.path;
    this.cast = null;
    this.path = null;
    try {
      if (!cast) return null;
      await cast.dispose();
      return out;
    } finally {
      this.stopPromise = null;
    }
  }
}
