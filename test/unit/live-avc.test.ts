import { describe, it, expect } from "vitest";
import {
  avcC,
  codecString,
  nalType,
  splitNalUnits,
  toAvcc,
} from "../../src/live/avc.js";

/** A NAL unit with a 4-byte start code. */
const nal = (header: number, body: number[] = []): Buffer =>
  Buffer.concat([Buffer.from([0, 0, 0, 1, header]), Buffer.from(body)]);

const sps = Buffer.from([0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78]);
const pps = Buffer.from([0x68, 0xee, 0x3c, 0xb0]);

describe("splitNalUnits", () => {
  it("splits on 4-byte start codes and drops them", () => {
    const buf = Buffer.concat([nal(0x67, [1, 2]), nal(0x68, [3]), nal(0x65, [4, 5, 6])]);
    const units = splitNalUnits(buf);
    expect(units).toHaveLength(3);
    expect(units[0]![0]).toBe(0x67);
    expect(units[2]!.equals(Buffer.from([0x65, 4, 5, 6]))).toBe(true);
  });

  it("splits on 3-byte start codes too", () => {
    const buf = Buffer.concat([
      Buffer.from([0, 0, 1, 0x67, 0x64]),
      Buffer.from([0, 0, 1, 0x65, 0x88]),
    ]);
    const units = splitNalUnits(buf);
    expect(units).toHaveLength(2);
    expect(units[1]![0]).toBe(0x65);
  });

  it("returns nothing for an empty buffer", () => {
    expect(splitNalUnits(Buffer.alloc(0))).toEqual([]);
  });

  it("tolerates trailing bytes after the last unit", () => {
    const units = splitNalUnits(Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]));
    expect(units).toHaveLength(1);
    expect(units[0]!.length).toBe(4);
  });
});

describe("nalType", () => {
  it("masks the low five bits", () => {
    expect(nalType(Buffer.from([0x67]))).toBe(7);
    expect(nalType(Buffer.from([0x68]))).toBe(8);
    expect(nalType(Buffer.from([0x65]))).toBe(5);
    expect(nalType(Buffer.from([0x41]))).toBe(1);
    // The forbidden bit must not leak into the type.
    expect(nalType(Buffer.from([0xe7]))).toBe(7);
  });

  it("rejects an empty unit", () => {
    expect(() => nalType(Buffer.alloc(0))).toThrow();
  });
});

describe("codecString", () => {
  it("builds avc1.PPCCLL from the SPS header", () => {
    // profile 0x64 (High), constraints 0x00, level 0x28 (4.0)
    expect(codecString(sps)).toBe("avc1.640028");
  });

  it("rejects a unit that is not an SPS", () => {
    expect(() => codecString(pps)).toThrow();
  });

  it("rejects a truncated SPS", () => {
    expect(() => codecString(Buffer.from([0x67, 0x64]))).toThrow();
  });
});

describe("toAvcc", () => {
  it("prefixes each unit with its length, big endian", () => {
    const out = toAvcc([Buffer.from([0x65, 1, 2]), Buffer.from([0x41, 3])]);
    expect(out.readUInt32BE(0)).toBe(3);
    expect(out.subarray(4, 7).equals(Buffer.from([0x65, 1, 2]))).toBe(true);
    expect(out.readUInt32BE(7)).toBe(2);
    expect(out.subarray(11).equals(Buffer.from([0x41, 3]))).toBe(true);
  });

  it("returns an empty buffer for no units", () => {
    expect(toAvcc([]).length).toBe(0);
  });
});

describe("avcC", () => {
  it("writes the record WebCodecs expects as `description`", () => {
    const record = avcC(sps, pps);
    expect(record[0]).toBe(1); // configurationVersion
    expect(record[1]).toBe(0x64); // profile
    expect(record[2]).toBe(0x00); // compatibility
    expect(record[3]).toBe(0x28); // level
    expect(record[4]).toBe(0xff); // 6 reserved bits + lengthSizeMinusOne = 3
    expect(record[5]).toBe(0xe1); // 3 reserved bits + one SPS
    expect(record.readUInt16BE(6)).toBe(sps.length);
    expect(record.subarray(8, 8 + sps.length).equals(sps)).toBe(true);
    const afterSps = 8 + sps.length;
    expect(record[afterSps]).toBe(1); // one PPS
    expect(record.readUInt16BE(afterSps + 1)).toBe(pps.length);
    expect(record.subarray(afterSps + 3).equals(pps)).toBe(true);
  });

  it("rejects a missing PPS", () => {
    expect(() => avcC(sps, Buffer.alloc(0))).toThrow();
  });
});
