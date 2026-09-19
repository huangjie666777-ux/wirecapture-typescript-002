import { DecoderClosed, Event, join, messageLimit, Options, ProtocolError } from "./types.js";

const HEADER_MAX = 14; // 2 basic + 8 extended length + 4 mask key

/**
 * Incremental, bounded decoder. Each push consumes its chunk immediately,
 * returns the events completed by those bytes, and retains only unfinished
 * message payload, an unfinished control payload and raw header bytes.
 */
export class Decoder {
  private readonly limit: number;
  private failure: ProtocolError | undefined;
  private ended = false;

  private offset = 0;      // absolute offset of the next input byte
  private frameStart = 0;  // absolute offset of the frame being read
  private header = new Uint8Array(HEADER_MAX);
  private headerLen = 0;
  private headerFull = 0;  // total header size, known after the 2 basic bytes
  private mask = new Uint8Array(4);
  private maskIndex = 0;

  private fin = false;
  private opcode = 0;
  private payload: Uint8Array | undefined; // exact-size buffer for the current frame
  private payloadFilled = 0;

  private msgParts: Uint8Array[] = [];
  private msgBytes = 0;
  private msgOpcode: number | undefined;
  private msgStart = 0;

  private events: Event[] = [];

  constructor(options: Options = {}) { this.limit = messageLimit(options); }

  get bufferedBytes(): number {
    return this.headerLen + this.payloadFilled + this.msgBytes;
  }

  push(chunk: Uint8Array): Event[] {
    if (this.failure) throw this.failure;
    if (this.ended) throw new DecoderClosed();
    try {
      for (let i = 0; i < chunk.length; i++) this.feed(chunk[i]);
    } catch (error) {
      if (error instanceof ProtocolError) { this.failure = error; this.events = []; }
      throw error;
    }
    const out = this.events;
    this.events = [];
    return out;
  }

  finish(): Event[] {
    if (this.failure) throw this.failure;
    if (this.ended) return [];
    this.ended = true;
    if (this.headerLen > 0 || this.payload !== undefined) {
      this.failure = new ProtocolError("TRUNCATED_FRAME", this.frameStart);
      throw this.failure;
    }
    if (this.msgOpcode !== undefined) {
      this.failure = new ProtocolError("TRUNCATED_MESSAGE", this.msgStart);
      throw this.failure;
    }
    return [];
  }

  private feed(byte: number): void {
    this.offset++;
    if (this.payload !== undefined) {
      this.payload[this.payloadFilled++] = byte ^ this.mask[this.maskIndex];
      this.maskIndex = (this.maskIndex + 1) & 3;
      if (this.payloadFilled === this.payload.length) this.completeFrame();
      return;
    }
    this.header[this.headerLen++] = byte;
    if (this.headerLen === 2) this.checkBasic();
    else if (this.headerLen === this.headerFull) this.startPayload();
    else this.checkLength();
  }

  private checkBasic(): void {
    const first = this.header[0], second = this.header[1];
    const at = this.frameStart;
    if (first & 112) throw new ProtocolError("BAD_RSV", at);
    const opcode = first & 15;
    if (![0, 1, 2, 8, 9, 10].includes(opcode)) throw new ProtocolError("BAD_OPCODE", at);
    if (!(second & 128)) throw new ProtocolError("UNMASKED", at);
    const fin = (first & 128) !== 0;
    const tag = second & 127;
    if (opcode >= 8 && (!fin || tag > 125)) throw new ProtocolError("CONTROL_FRAME", at);
    if (opcode === 0) {
      if (this.msgOpcode === undefined) throw new ProtocolError("SEQUENCE", at);
    } else if (opcode < 8 && this.msgOpcode !== undefined) {
      throw new ProtocolError("SEQUENCE", at);
    }
    if (opcode < 8 && tag <= 125 && this.msgBytes + tag > this.limit) {
      throw new ProtocolError("MESSAGE_TOO_LARGE", at);
    }
    this.fin = fin;
    this.opcode = opcode;
    this.headerFull = 2 + (tag === 126 ? 2 : tag === 127 ? 8 : 0) + 4;
  }

  private checkLength(): void {
    const tag = this.header[1] & 127;
    const at = this.frameStart;
    let size: number;
    if (tag === 126) {
      if (this.headerLen !== 4) return;
      size = (this.header[2] << 8) | this.header[3];
      if (size < 126) throw new ProtocolError("NON_CANONICAL_LENGTH", at);
    } else if (tag === 127) {
      if (this.headerLen !== 10) return;
      let big = 0n;
      for (let i = 0; i < 8; i++) big = (big << 8n) | BigInt(this.header[2 + i]);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolError("LENGTH_RANGE", at);
      if (big < 65536n) throw new ProtocolError("NON_CANONICAL_LENGTH", at);
      size = Number(big);
    } else return;
    if (this.opcode < 8 && this.msgBytes + size > this.limit) {
      throw new ProtocolError("MESSAGE_TOO_LARGE", at);
    }
  }

  private startPayload(): void {
    this.mask = this.header.slice(this.headerFull - 4, this.headerFull);
    this.maskIndex = 0;
    this.headerLen = 0;
    const tag = this.header[1] & 127;
    let size = tag;
    if (tag === 126) size = (this.header[2] << 8) | this.header[3];
    else if (tag === 127) {
      let big = 0n;
      for (let i = 0; i < 8; i++) big = (big << 8n) | BigInt(this.header[2 + i]);
      size = Number(big);
    }
    this.payload = new Uint8Array(size);
    this.payloadFilled = 0;
    if (size === 0) this.completeFrame();
  }

  private completeFrame(): void {
    const payload = this.payload!;
    const at = this.frameStart;
    this.payload = undefined;
    this.payloadFilled = 0;
    this.headerFull = 0;
    this.frameStart = this.offset;
    if (this.opcode >= 8) {
      const type = ({8: "close", 9: "ping", 10: "pong"} as const)[this.opcode as 8 | 9 | 10];
      this.events.push({type, data: payload, offset: at} as Event);
      return;
    }
    if (this.opcode !== 0) {
      this.msgOpcode = this.opcode;
      this.msgStart = at;
    }
    this.msgParts.push(payload);
    this.msgBytes += payload.length;
    if (!this.fin) return;
    const full = join(this.msgParts);
    const opcode = this.msgOpcode!;
    const start = this.msgStart;
    this.msgParts = [];
    this.msgBytes = 0;
    this.msgOpcode = undefined;
    if (opcode === 1) {
      let text: string;
      try { text = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(full); }
      catch { throw new ProtocolError("INVALID_UTF8", start); }
      this.events.push({type: "text", data: text, offset: start});
    } else {
      this.events.push({type: "binary", data: full, offset: start});
    }
  }
}
