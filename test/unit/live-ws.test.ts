import { describe, it, expect } from "vitest";
import {
  acceptKey,
  buildUpgradeResponse,
  decodeClientFrames,
  encodeServerBinary,
  encodeServerText,
  frameHeader,
} from "../../src/viewer/ws-server.js";

// RFC6455 §1.3's example pair, held as hex so the literal is unambiguous: the
// key is the base64 of "the sample nonce" and the accept is SHA-1(key + GUID).
const EXAMPLE_KEY = Buffer.from("7468652073616d706c65206e6f6e6365", "hex").toString("base64");
const EXAMPLE_ACCEPT = Buffer.from("b37a4f2cc0624f1690f64606cf385945b2bec4ea", "hex").toString("base64");

describe("acceptKey", () => {
  it("matches the RFC6455 example", () => {
    expect(acceptKey(EXAMPLE_KEY)).toBe(EXAMPLE_ACCEPT);
  });

  it("is stable for the same key", () => {
    expect(acceptKey("abc")).toBe(acceptKey("abc"));
    expect(acceptKey("abc")).not.toBe(acceptKey("abd"));
  });
});

describe("buildUpgradeResponse", () => {
  it("returns 101 with the computed accept and the chosen subprotocol", () => {
    const res = buildUpgradeResponse(EXAMPLE_KEY, "uitest-live");
    expect(res.startsWith("HTTP/1.1 101 Switching Protocols\r\n")).toBe(true);
    expect(res).toContain("Upgrade: websocket\r\n");
    expect(res).toContain("Connection: Upgrade\r\n");
    expect(res).toContain("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n");
    expect(res).toContain("Sec-WebSocket-Protocol: uitest-live\r\n");
    expect(res.endsWith("\r\n\r\n")).toBe(true);
  });

  it("omits the subprotocol header when none was requested", () => {
    expect(buildUpgradeResponse("abc")).not.toContain("Sec-WebSocket-Protocol");
  });

  it("rejects a missing key", () => {
    expect(() => buildUpgradeResponse("")).toThrow();
  });
});

describe("server frames", () => {
  it("writes unmasked text frames (RFC6455 §5.1)", () => {
    const frame = encodeServerText('{"type":"state","state":"live"}');
    expect(frame[0]).toBe(0x81); // FIN + text
    const len = frame[1]! & 0x7f;
    expect(frame[1]! & 0x80).toBe(0); // mask bit clear
    expect(len).toBe(Buffer.byteLength('{"type":"state","state":"live"}'));
    expect(frame.subarray(2).toString()).toBe('{"type":"state","state":"live"}');
  });

  it("writes unmasked binary frames with the 16-bit length form", () => {
    const payload = Buffer.alloc(300, 7);
    const frame = encodeServerBinary(payload);
    expect(frame[0]).toBe(0x82);
    expect(frame[1]).toBe(126);
    expect(frame.readUInt16BE(2)).toBe(300);
    expect(frame.subarray(4).equals(payload)).toBe(true);
  });

  it("uses the 64-bit length form above 65535 bytes", () => {
    const payload = Buffer.alloc(70_000, 3);
    const frame = encodeServerBinary(payload);
    expect(frame[1]).toBe(127);
    expect(Number(frame.readBigUInt64BE(2))).toBe(70_000);
  });

  it("frames a header only", () => {
    expect(frameHeader(0x2, 5)[0]).toBe(0x82);
  });
});

describe("decodeClientFrames", () => {
  /** A masked client frame, as a browser sends it. */
  function masked(opcode: number, payload: Buffer): Buffer {
    const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const out = Buffer.alloc(2 + 4 + payload.length);
    out[0] = 0x80 | opcode;
    out[1] = 0x80 | payload.length;
    mask.copy(out, 2);
    for (let i = 0; i < payload.length; i++) out[6 + i] = payload[i]! ^ mask[i % 4]!;
    return out;
  }

  it("unmasks a client text frame", () => {
    const { frames, rest } = decodeClientFrames(masked(0x1, Buffer.from('{"type":"refresh"}')));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.opcode).toBe(0x1);
    expect(frames[0]!.payload.toString()).toBe('{"type":"refresh"}');
    expect(rest.length).toBe(0);
  });

  it("keeps a partial frame for the next read", () => {
    const full = masked(0x1, Buffer.from("hello"));
    const first = decodeClientFrames(full.subarray(0, 5));
    expect(first.frames).toHaveLength(0);
    expect(first.rest.length).toBe(5);
    const second = decodeClientFrames(Buffer.concat([first.rest, full.subarray(5)]));
    expect(second.frames[0]!.payload.toString()).toBe("hello");
  });

  it("decodes several frames in one chunk", () => {
    const a = masked(0x1, Buffer.from("a"));
    const b = masked(0x8, Buffer.alloc(0));
    const { frames } = decodeClientFrames(Buffer.concat([a, b]));
    expect(frames.map((f) => f.opcode)).toEqual([0x1, 0x8]);
  });

  it("rejects an unmasked client frame", () => {
    // RFC6455 §5.1: a client MUST mask; accepting it would hide a broken peer.
    const bad = Buffer.from([0x81, 0x01, 0x41]);
    expect(() => decodeClientFrames(bad)).toThrow();
  });

  it("handles the 16-bit length form", () => {
    const payload = Buffer.alloc(200, 0x41);
    const mask = Buffer.from([1, 2, 3, 4]);
    const out = Buffer.alloc(4 + 4 + payload.length);
    out[0] = 0x81;
    out[1] = 0x80 | 126;
    out.writeUInt16BE(200, 2);
    mask.copy(out, 4);
    for (let i = 0; i < payload.length; i++) out[8 + i] = payload[i]! ^ mask[i % 4]!;
    const { frames } = decodeClientFrames(out);
    expect(frames[0]!.payload.length).toBe(200);
  });
});
