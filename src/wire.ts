import { ProtocolError } from "./types.js";

export interface Frame { fin: boolean; opcode: number; payload: Uint8Array; offset: number; }
export interface DecodedFrame { frame: Frame; next: number; }

/** Decode one complete frame from a contiguous capture. Undefined means incomplete. */
export function readFrame(bytes: Uint8Array, start: number): DecodedFrame | undefined {
  if (bytes.length - start < 2) return undefined;
  const first = bytes[start], second = bytes[start + 1];
  const fin = (first & 128) !== 0, opcode = first & 15;
  if (first & 112) throw new ProtocolError("BAD_RSV", start);
  if (![0, 1, 2, 8, 9, 10].includes(opcode)) throw new ProtocolError("BAD_OPCODE", start);
  if (!(second & 128)) throw new ProtocolError("UNMASKED", start);
  const short = second & 127;
  if (opcode >= 8 && (!fin || short > 125)) throw new ProtocolError("CONTROL_FRAME", start);
  let size = short, pos = start + 2;
  if (short === 126) {
    if (bytes.length - pos < 2) return undefined;
    size = bytes[pos] * 256 + bytes[pos + 1]; pos += 2;
    if (size < 126) throw new ProtocolError("NON_CANONICAL_LENGTH", start);
  } else if (short === 127) {
    if (bytes.length - pos < 8) return undefined;
    let big = 0n;
    for (let i = 0; i < 8; i++) big = (big << 8n) | BigInt(bytes[pos + i]);
    pos += 8;
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolError("LENGTH_RANGE", start);
    if (big < 65536n) throw new ProtocolError("NON_CANONICAL_LENGTH", start);
    size = Number(big);
  }
  if (bytes.length - pos < 4 || bytes.length - pos - 4 < size) return undefined;
  const payload = new Uint8Array(size);
  for (let i = 0; i < size; i++) payload[i] = bytes[pos + 4 + i] ^ bytes[pos + (i % 4)];
  return { frame: { fin, opcode, payload, offset: start }, next: pos + 4 + size };
}
