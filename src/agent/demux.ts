export interface DemuxHandlers {
  onJson(line: string): void;
  onFrame(jpeg: Buffer): void;
}

type Mode = "idle" | "json" | "jpeg";

const SOI = 0xd8; // start of image, second byte of FF D8
const EOI = 0xd9; // end of image, second byte of FF D9

function isWhitespace(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a;
}

/** Index of the two-byte marker `a b` at or after `from`, or -1. */
function findMarker(buf: Buffer, a: number, b: number, from: number): number {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === a && buf[i + 1] === b) return i;
  }
  return -1;
}

/**
 * Demultiplexes the agent's single TCP stream, where newline-terminated JSON
 * replies and raw JPEG frames arrive interleaved with no framing metadata.
 *
 * Only `FF D8 ... FF D9` bounds a frame: entropy-coded JPEG data may contain
 * `{`, `FF D8`, and newlines, so neither may be used to switch modes.
 */
export class FrameDemux {
  private mode: Mode = "idle";
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly handlers: DemuxHandlers) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  private drain(): void {
    for (;;) {
      if (this.mode === "idle") {
        let skip = 0;
        while (skip < this.buf.length && isWhitespace(this.buf[skip])) skip++;
        if (skip > 0) this.buf = this.buf.subarray(skip);
        if (this.buf.length === 0) return;

        const first = this.buf[0]!;
        if (first === 0x7b) {
          this.mode = "json";
          continue;
        }
        if (first === 0xff) {
          if (this.buf.length < 2) return; // wait for the second marker byte
          if (this.buf[1] === SOI) {
            this.mode = "jpeg";
            continue;
          }
          this.buf = this.buf.subarray(1);
          continue;
        }
        this.buf = this.buf.subarray(1); // junk byte: drop so we cannot wedge
        continue;
      }

      if (this.mode === "json") {
        const nl = this.buf.indexOf(0x0a);
        if (nl < 0) return;
        const line = this.buf.subarray(0, nl).toString("utf8").trim();
        this.buf = this.buf.subarray(nl + 1);
        this.mode = "idle";
        if (line.length > 0) this.handlers.onJson(line);
        continue;
      }

      // jpeg: start searching after the opening FF D8 so the two are not paired.
      const eoi = findMarker(this.buf, 0xff, EOI, 2);
      if (eoi < 0) return;
      const frame = Buffer.from(this.buf.subarray(0, eoi + 2));
      this.buf = this.buf.subarray(eoi + 2);
      this.mode = "idle";
      this.handlers.onFrame(frame);
    }
  }
}
