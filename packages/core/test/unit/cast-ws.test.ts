import { describe, it, expect } from "vitest";
import {
  buildHandshake,
  decodeFrames,
  encodeCloseFrame,
  encodeTextFrame,
  handshakeStatus,
  WS_OPCODE_BINARY,
  WS_OPCODE_CLOSE,
  WS_OPCODE_PING,
  WS_OPCODE_TEXT,
} from "../../src/cast/ws.js";

describe("buildHandshake", () => {
  it("asks to upgrade to the scrcpy subprotocol", () => {
    // The 7.0 extension only completes the upgrade when this header is present;
    // without it the server answers 400 rather than 101.
    const req = buildHandshake("127.0.0.1:5000");
    expect(req.startsWith("GET / HTTP/1.1\r\n")).toBe(true);
    expect(req).toContain("Upgrade: websocket\r\n");
    expect(req).toContain("Connection: Upgrade\r\n");
    expect(req).toContain("Sec-WebSocket-Protocol: scrcpy\r\n");
    expect(req).toContain("Sec-WebSocket-Version: 13\r\n");
    expect(req.endsWith("\r\n\r\n")).toBe(true);
  });

  it("accepts an injected key so tests are deterministic", () => {
    // Hex, not a literal: a base64-looking string in a test file reads like a
    // credential and is easy to mistake for one.
    const key = Buffer.from("746573742d6b6579", "hex").toString("latin1");
    const req = buildHandshake("127.0.0.1:5000", key);
    expect(req).toContain(`Sec-WebSocket-Key: ${key}\r\n`);
  });
});

describe("handshakeStatus", () => {
  it("reads the status code from the response line", () => {
    expect(handshakeStatus("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n")).toBe(101);
    expect(handshakeStatus("HTTP/1.1 400 Bad Request\r\n\r\n")).toBe(400);
  });

  it("returns null when the response line is not HTTP", () => {
    expect(handshakeStatus("garbage")).toBeNull();
  });
});

describe("encodeTextFrame", () => {
  it("masks the payload and sets the FIN + text bits", () => {
    // RFC6455 §5.3: every client frame must be masked.
    const frame = encodeTextFrame('{"type":"start"}');
    expect(frame[0]).toBe(0x81);
    expect(frame[1]! & 0x80).toBe(0x80); // mask bit
    const len = frame[1]! & 0x7f;
    expect(len).toBe(Buffer.byteLength('{"type":"start"}'));
    const mask = frame.subarray(2, 6);
    const masked = frame.subarray(6);
    const plain = Buffer.alloc(masked.length);
    for (let i = 0; i < masked.length; i++) plain[i] = masked[i]! ^ mask[i % 4]!;
    expect(plain.toString("utf8")).toBe('{"type":"start"}');
  });

  it("uses the 16-bit extended length for payloads of 126 bytes or more", () => {
    const text = "x".repeat(200);
    const frame = encodeTextFrame(text);
    expect(frame[0]).toBe(0x81);
    expect(frame[1]! & 0x7f).toBe(126);
    expect(frame.readUInt16BE(2)).toBe(200);
    // 2 header + 2 extended length + 4 mask + 200 payload
    expect(frame.length).toBe(208);
  });
});

describe("encodeCloseFrame", () => {
  it("emits a masked close frame with no payload", () => {
    const frame = encodeCloseFrame();
    expect(frame[0]! & 0x0f).toBe(WS_OPCODE_CLOSE);
    expect(frame[1]! & 0x80).toBe(0x80);
    expect(frame[1]! & 0x7f).toBe(0);
  });
});

describe("decodeFrames", () => {
  const serverFrame = (opcode: number, payload: Buffer): Buffer => {
    const head: number[] = [0x80 | opcode];
    if (payload.length < 126) head.push(payload.length);
    else {
      head.push(126, payload.length >> 8, payload.length & 0xff);
    }
    return Buffer.concat([Buffer.from(head), payload]);
  };

  it("decodes a complete unmasked server frame", () => {
    const buf = serverFrame(WS_OPCODE_TEXT, Buffer.from('{"type":"started"}'));
    const { frames, rest } = decodeFrames(buf);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.opcode).toBe(WS_OPCODE_TEXT);
    expect(frames[0]!.payload.toString("utf8")).toBe('{"type":"started"}');
    expect(rest.length).toBe(0);
  });

  it("keeps a partial frame in rest instead of yielding it", () => {
    // Frames arrive split across TCP segments; a half frame must wait.
    const whole = serverFrame(WS_OPCODE_BINARY, Buffer.alloc(300, 7));
    const { frames, rest } = decodeFrames(whole.subarray(0, 100));
    expect(frames).toHaveLength(0);
    expect(rest.length).toBe(100);
  });

  it("decodes several frames from one buffer and leaves the tail", () => {
    const a = serverFrame(WS_OPCODE_TEXT, Buffer.from("a"));
    const b = serverFrame(WS_OPCODE_BINARY, Buffer.from([1, 2, 3]));
    const partial = serverFrame(WS_OPCODE_BINARY, Buffer.alloc(10)).subarray(0, 5);
    const { frames, rest } = decodeFrames(Buffer.concat([a, b, partial]));
    expect(frames.map((f) => f.opcode)).toEqual([WS_OPCODE_TEXT, WS_OPCODE_BINARY]);
    expect(rest.length).toBe(5);
  });

  it("decodes a 64-bit extended length", () => {
    const payload = Buffer.alloc(70_000, 3);
    const head = Buffer.alloc(10);
    head[0] = 0x80 | WS_OPCODE_BINARY;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(payload.length), 2);
    const { frames } = decodeFrames(Buffer.concat([head, payload]));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.length).toBe(70_000);
  });

  it("surfaces ping and close frames rather than dropping them", () => {
    const buf = Buffer.concat([
      serverFrame(WS_OPCODE_PING, Buffer.from("hi")),
      serverFrame(WS_OPCODE_CLOSE, Buffer.alloc(0)),
    ]);
    const { frames } = decodeFrames(buf);
    expect(frames.map((f) => f.opcode)).toEqual([WS_OPCODE_PING, WS_OPCODE_CLOSE]);
  });

  it("handles an empty buffer", () => {
    expect(decodeFrames(Buffer.alloc(0))).toEqual({ frames: [], rest: Buffer.alloc(0) });
  });
});
