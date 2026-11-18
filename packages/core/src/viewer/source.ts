import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Recording } from "../cast/record.js";
import { createCast } from "../cast/create.js";
import { openInput } from "../input/open.js";
import type { CastOptions } from "../cast/types.js";
import type { Device } from "../driver/device.js";
import type { Screen } from "../driver/agent/screen.js";
import type { Session } from "../operations/session.js";
import type { ViewerSource } from "./server.js";

export interface ViewerSourceOptions {
  /** Where screenshots and recordings are written. */
  stateDir: string;
  /** Stream settings, minus the mode and output path the viewer decides. */
  cast?: Omit<CastOptions, "mode" | "outputPath">;
  /**
   * Distinguishes this viewer's daemons from another process's on the same
   * device. Defaults to the pid, which is unique on this host.
   */
  socketSuffix?: string;
  /** Serve layout and node boxes. Default true. */
  layout?: boolean;
  /** Offer a screenshot button. Default true. */
  capture?: boolean;
  /**
   * Write the page's recording to this exact path instead of a timestamped
   * name under `shots/`. A product with a `--record <file>` flag passes it
   * through so the file is where the person was told it would be.
   */
  recordPath?: string;
}

/**
 * Wraps a live session and its device as the viewer's source.
 *
 * Each page gets its own daemons: a fixed socket name lets a second viewer on
 * the same device take over the first one's socket, and the two then fight
 * over it. Recording runs on a second cast beside the stream, because the
 * extension's encoder is start/stop driven and a second `onStart` on the same
 * daemon is refused.
 */
export function createViewerSource(
  session: Session,
  device: Device,
  opts: ViewerSourceOptions,
): ViewerSource {
  const suffix = opts.socketSuffix ?? String(process.pid);
  const stateDir = opts.stateDir;
  const streamCast: CastOptions = {
    mode: "stream",
    ...opts.cast,
    ...(opts.cast?.transport === "ws" ? {} : { socketName: `uitest_live_${suffix}` }),
  };

  const readScreen = async (redact: boolean): Promise<Screen> => {
    session.reader.builder.setRedact(redact);
    return session.reader.read();
  };

  // A screenshot goes through the session, so it is masked the same way the
  // node table is: a password the page hides in text must not be readable in
  // the saved pixels. The session already owns that rule (`saveShot`), and a
  // second implementation here would be a second place to get it wrong.
  const capture = async (): Promise<string> => {
    const out = join(stateDir, "shots", `live-${Date.now()}.jpg`);
    await mkdir(dirname(out), { recursive: true });
    const result = await session.observe({ out });
    // A locked phone writes no file, and a `saved` reply naming a path that
    // does not exist sends the person looking for it. Fail with the reason the
    // session gave; the tab shows it and no file is promised.
    if (result.status !== "settled") {
      const why = "reason" in result ? result.reason : result.status;
      throw new Error(`${result.status}: the screenshot was not saved · ${why}`);
    }
    return out;
  };

  const recording = new Recording({
    stateDir,
    socketName: `uitest_live_record_${suffix}`,
    createCast: (castOpts) => createCast(device, castOpts),
    streamCast,
    ...(opts.recordPath ? { outputPath: opts.recordPath } : {}),
  });

  return {
    createCast: () => createCast(device, streamCast),
    // Takeover is always offered: a read-only viewer never triggers it, and
    // the server opens the lane at startup so the first take does not wait on
    // an fport. A second forward and socket keep input out of the layout
    // queue, which is what makes a tap land in tens of milliseconds.
    openInput: () => openInput(device),
    ...(opts.layout !== false ? { readScreen } : {}),
    // Even with the layout off the page needs the display size: a half-size
    // frame (--scale 2, every MJPEG device) would otherwise make every click
    // land at half coordinates. `getDisplaySize` is one agent call, not a
    // layout read.
    displaySize: () => device.agent.getDisplaySize(),
    ...(opts.capture !== false ? { capture } : {}),
    startRecording: () => recording.start(),
    stopRecording: () => recording.stop(),
  };
}
