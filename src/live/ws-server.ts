import { createHash } from "node:crypto";
import type { WsFrame } from "../cast/ws.js";

/**
 * The server half of RFC6455, for the live inspector's browser client.
 *
 * Deliberately small: no extensions, no fragmentation out (the browser client
 * never asks for any), no permessage-deflate. The only client frames that
 * matter are small JSON text messages and the close handshake.
 */

/** RFC6455 §1.3's fixed GUID; the accept key is SHA-1(key + GUID). */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/**
 * The 101 response. `protocol` is echoed only when the client offered one —
 * a response naming a subprotocol the client never sent is a protocol error.
 */
export function buildUpgradeResponse(key: string, protocol?: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("upgrade request has no Sec-WebSocket-Key");
  return (
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey(trimmed)}\r\n` +
    (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : "") +
    "\r\n"
  );
}

/** One server frame header. Server frames are never masked (RFC6455 §5.1). */
export function frameHeader(opcode: number, length: number): Buffer {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  if (length < 65_536) {
    const h = Buffer.alloc(4);
    h[0] = 0x80 | opcode;
    h[1] = 126;
    h.writeUInt16BE(length, 2);
    return h;
  }
  const h = Buffer.alloc(10);
  h[0] = 0x80 | opcode;
  h[1] = 127;
  h.writeBigUInt64BE(BigInt(length), 2);
  return h;
}

export function encodeServerText(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  return Buffer.concat([frameHeader(0x1, payload.length), payload]);
}

export function encodeServerBinary(payload: Buffer): Buffer {
  return Buffer.concat([frameHeader(0x2, payload.length), payload]);
}

export function encodeServerClose(code = 1000): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return Buffer.concat([frameHeader(0x8, 2), payload]);
}

/**
 * Splits client bytes into frames, unmasking each payload.
 *
 * An unmasked client frame is rejected: RFC6455 §5.1 requires masking, and a
 * peer that skips it is broken in a way that would hide bugs rather than
 * reveal them.
 */
export function decodeClientFrames(buf: Buffer): { frames: WsFrame[]; rest: Buffer } {
  const frames: WsFrame[] = [];
  let i = 0;
  for (;;) {
    if (buf.length - i < 2) break;
    const opcode = buf[i]! & 0x0f;
    const masked = (buf[i + 1]! & 0x80) !== 0;
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
    if (!masked) throw new Error("client frame is not masked (RFC6455 §5.1)");
    if (buf.length - off < 4 + len) break;
    const mask = buf.subarray(off, off + 4);
    const payload = Buffer.allocUnsafe(len);
    for (let k = 0; k < len; k++) payload[k] = buf[off + 4 + k]! ^ mask[k % 4]!;
    frames.push({ opcode, payload });
    i = off + 4 + len;
  }
  return { frames, rest: i === 0 ? buf : buf.subarray(i) };
}
