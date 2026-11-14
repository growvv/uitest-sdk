import { describe, it, expect } from "vitest";
import { FrameDemux } from "../../src/agent/demux.js";

function collect() {
  const json: string[] = [];
  const frames: Buffer[] = [];
  const d = new FrameDemux({ onJson: (l) => json.push(l), onFrame: (f) => frames.push(f) });
  return { d, json, frames };
}
const JPEG = (payload: Buffer) => Buffer.concat([Buffer.from([0xff, 0xd8]), payload, Buffer.from([0xff, 0xd9])]);

describe("FrameDemux", () => {
  it("splits a JSON line", () => {
    const { d, json } = collect();
    d.push(Buffer.from('{"result":1}\n'));
    expect(json).toEqual(['{"result":1}']);
  });

  it("splits a JPEG frame", () => {
    const { d, frames } = collect();
    d.push(JPEG(Buffer.from([1, 2, 3])));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(JPEG(Buffer.from([1, 2, 3])));
  });

  it("handles a chunk boundary inside the FFD8 marker", () => {
    const { d, frames } = collect();
    d.push(Buffer.from([0xff]));
    d.push(Buffer.from([0xd8, 9, 9, 0xff, 0xd9]));
    expect(frames).toHaveLength(1);
  });

  it("handles a chunk boundary inside the FFD9 marker", () => {
    const { d, frames } = collect();
    d.push(Buffer.from([0xff, 0xd8, 1, 2, 0xff]));
    expect(frames).toHaveLength(0);
    d.push(Buffer.from([0xd9]));
    expect(frames).toHaveLength(1);
  });

  it("does not treat '{' inside JPEG payload as JSON", () => {
    const { d, json, frames } = collect();
    d.push(JPEG(Buffer.from('{"fake":true}', "utf8")));
    expect(json).toHaveLength(0);
    expect(frames).toHaveLength(1);
  });

  it("does not treat FFD8 inside JPEG payload as a new frame", () => {
    const { d, frames } = collect();
    d.push(JPEG(Buffer.from([0xff, 0xd8, 0xaa])));
    expect(frames).toHaveLength(1);
  });

  it("interleaves JSON and frames in arrival order", () => {
    const { d, json, frames } = collect();
    d.push(Buffer.concat([JPEG(Buffer.from([1])), Buffer.from('{"a":1}\n'), JPEG(Buffer.from([2]))]));
    expect(frames).toHaveLength(2);
    expect(json).toEqual(['{"a":1}']);
  });

  it("keeps partial JSON buffered across chunks", () => {
    const { d, json } = collect();
    d.push(Buffer.from('{"res'));
    expect(json).toHaveLength(0);
    d.push(Buffer.from('ult":2}\n'));
    expect(json).toEqual(['{"result":2}']);
  });
});
