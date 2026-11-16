import { randomBytes } from "node:crypto";

/**
 * Minimal RFC6455 codec for the 7.0 casting extension.
 *
 * Only what the extension actually uses is implemented: text commands out,
 * text + binary frames in. Measured against the real daemon: the server never
 * fragments, never masks, and only ever sends opcodes 1 and 2.
 */

export const WS_OPCODE_CONTINUATION = 0x0;
export const WS_OPCODE_TEXT = 0x1;
export const WS_OPCODE_BINARY = 0x2;
export const WS_OPCODE_CLOSE = 0x8;
export const WS_OPCODE_PING = 0x9;
export const WS_OPCODE_PONG = 0xa;

export interface WsFrame {
  opcode: number;
  payload: Buffer;
}

/**
 * The upgrade request. `Sec-WebSocket-Protocol: scrcpy` is mandatory — the
 * extension refuses the upgrade without it.
 */
export function buildHandshake(host: string, key?: string): string {
  return (
    "GET / HTTP/1.1\r\n" +
    `Host: ${host}\r\n` +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Key: ${key ?? randomBytes(16).toString("base64")}\r\n` +
    "Sec-WebSocket-Version: 13\r\n" +
    "Sec-WebSocket-Protocol: scrcpy\r\n" +
    "\r\n"
  );
}

/** Status code of the handshake response line, or null if it is not HTTP. */
export function handshakeStatus(head: string): number | null {
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
  return m ? Number(m[1]) : null;
}

function frameHeader(opcode: number, length: number): Buffer {
  // Client frames are always masked (RFC6455 §5.3). FIN is always set: the
  // extension's commands are single small text messages.
  if (length < 126) return Buffer.from([0x80 | opcode, 0x80 | length]);
  if (length < 65_536) {
    const h = Buffer.alloc(4);
    h[0] = 0x80 | opcode;
    h[1] = 0x80 | 126;
    h.writeUInt16BE(length, 2);
    return h;
  }
  const h = Buffer.alloc(10);
  h[0] = 0x80 | opcode;
  h[1] = 0x80 | 127;
  h.writeBigUInt64BE(BigInt(length), 2);
  return h;
}

function maskPayload(payload: Buffer): { mask: Buffer; masked: Buffer } {
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  return { mask, masked };
}

/** A masked client text frame carrying one JSON command. */
export function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const { mask, masked } = maskPayload(payload);
  return Buffer.concat([frameHeader(WS_OPCODE_TEXT, payload.length), mask, masked]);
}

export function encodeCloseFrame(): Buffer {
  return Buffer.concat([frameHeader(WS_OPCODE_CLOSE, 0), randomBytes(4)]);
}

export function encodePongFrame(payload: Buffer): Buffer {
  const { mask, masked } = maskPayload(payload);
  return Buffer.concat([frameHeader(WS_OPCODE_PONG, payload.length), mask, masked]);
}

/**
 * Splits whatever has arrived into complete frames, returning the bytes of an
 * unfinished trailing frame so the caller can prepend them to the next read.
 *
 * Server frames are never masked, so the mask bit is ignored on purpose: a
 * masked frame from this server would be a protocol error, not something to
 * decode.
 */
export function decodeFrames(buf: Buffer): { frames: WsFrame[]; rest: Buffer } {
  const frames: WsFrame[] = [];
  let i = 0;
  for (;;) {
    if (buf.length - i < 2) break;
    const opcode = buf[i]! & 0x0f;
    let len = buf[i + 1]! & 0x7f;
    let off = i + 2;
    if (len === 126) {
      if (buf.length - i < 4) break;
      len = buf.readUInt16BE(i + 2);
      off = i + 4;
    } else if (len === 127) {
      if (buf.length - i < 10) break;
      len = Number(buf.readBigUInt64BE(i + 2));
      off = i + 10;
    }
    if (buf.length - off < len) break;
    frames.push({ opcode, payload: buf.subarray(off, off + len) });
    i = off + len;
  }
  return { frames, rest: i === 0 ? buf : buf.subarray(i) };
}

/** NAL unit types in an Annex-B buffer, in order. */
export function nalTypes(annexB: Buffer): number[] {
  const out: number[] = [];
  let i = 0;
  while (i + 3 <= annexB.length) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1) {
      if (i + 3 < annexB.length) out.push(annexB[i + 3]! & 0x1f);
      i += 4;
    } else if (
      i + 4 <= annexB.length &&
      annexB[i] === 0 &&
      annexB[i + 1] === 0 &&
      annexB[i + 2] === 0 &&
      annexB[i + 3] === 1
    ) {
      if (i + 4 < annexB.length) out.push(annexB[i + 4]! & 0x1f);
      i += 5;
    } else i++;
  }
  return out;
}

const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;

/** A keyframe is one that carries an IDR slice (or only parameter sets). */
export function isKeyFrame(annexB: Buffer): boolean {
  const types = nalTypes(annexB);
  return types.includes(NAL_IDR) || (types.length > 0 && types.every((t) => t === NAL_SPS || t === NAL_PPS));
}
