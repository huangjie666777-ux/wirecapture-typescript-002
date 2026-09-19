import { DecoderClosed, Event, join, messageLimit, Options, ProtocolError } from "./types.js";

const MAX_HEADER = 14; // 2 basic + 8 extended length + 4 mask key
const MAX_CONTROL = 125;

/**
 * Bounded incremental decoder. Each push consumes its chunk immediately,
 * returns events completed by those bytes, and retains only unfinished
 * message payload, an unfinished control payload and raw header bytes.
 */
export class Decoder {
  private readonly head = new Uint8Array(MAX_HEADER);
  private headLen = 0;
  private basicChecked = false;
  private lengthChecked = false;
  private headerNeed = 2;

  private streamPos = 0;   // absolute offset of the next byte to consume
  private frameStart = 0;  // absolute offset of the frame being read

  // Current frame. hdrOpcode/hdrFin apply while the header is incomplete;
  // opcode >= 0 marks the payload phase.
  private fin = false;
  private hdrOpcode = -1;
  private hdrFin = false;
  private opcode = -1;
  private declared = 0;
  private readonly mask = new Uint8Array(4);
  private remaining = 0;
  private consumed = 0;

  // Open data-message assembly.
  private parts: Uint8Array[] = [];
  private msgOpcode: number | undefined;
  private msgStart = 0;
  private msgBytes = 0;

  // Unfinished control payload.
  private readonly ctrl = new Uint8Array(MAX_CONTROL);
  private ctrlLen = 0;

  private ended = false;
  private failure: ProtocolError | undefined;
  private readonly limit: number;
  constructor(options: Options = {}) { this.limit = messageLimit(options); }

  get bufferedBytes(): number { return this.headLen + this.msgBytes + this.ctrlLen; }

  push(chunk: Uint8Array): Event[] {
    if (this.failure) throw this.failure;
    if (this.ended) throw new DecoderClosed();
    const events: Event[] = [];
    try {
      let at = 0;
      while (at < chunk.length) {
        at = this.opcode < 0 ? this.readHeader(chunk, at, events) : this.readPayload(chunk, at, events);
      }
      return events;
    } catch (error) {
      if (error instanceof ProtocolError) this.failure = error;
      throw error;
    }
  }

  finish(): Event[] {
    if (this.failure) throw this.failure;
    if (this.ended) return [];
    if (this.headLen > 0 || this.opcode >= 0) {
      this.failure = new ProtocolError("TRUNCATED_FRAME", this.frameStart);
      throw this.failure;
    }
    if (this.msgOpcode !== undefined) {
      this.failure = new ProtocolError("TRUNCATED_MESSAGE", this.msgStart);
      throw this.failure;
    }
    this.ended = true;
    return [];
  }

  private readHeader(chunk: Uint8Array, at: number, events: Event[]): number {
    if (this.headLen === 0) this.frameStart = this.streamPos;
    const take = Math.min(this.headerNeed - this.headLen, chunk.length - at);
    this.head.set(chunk.subarray(at, at + take), this.headLen);
    this.headLen += take;
    this.streamPos += take;
    at += take;
    if (!this.basicChecked && this.headLen >= 2) {
      this.basicChecked = true;
      this.checkBasic();
    }
    if (this.basicChecked && !this.lengthChecked && this.headLen >= this.headerNeed - 4) {
      this.lengthChecked = true;
      this.checkLength();
    }
    if (this.lengthChecked && this.headLen === this.headerNeed) {
      this.mask.set(this.head.subarray(this.headerNeed - 4, this.headerNeed));
      this.headLen = 0;
      this.basicChecked = false;
      this.lengthChecked = false;
      this.headerNeed = 2;
      this.opcode = this.hdrOpcode;
      this.fin = this.hdrFin;
      this.remaining = this.declared;
      this.consumed = 0;
      if (this.remaining === 0) this.completeFrame(events);
    }
    return at;
  }

  private checkBasic(): void {
    const first = this.head[0], second = this.head[1];
    const fin = (first & 128) !== 0, opcode = first & 15;
    if (first & 112) throw new ProtocolError("BAD_RSV", this.frameStart);
    if (![0, 1, 2, 8, 9, 10].includes(opcode)) throw new ProtocolError("BAD_OPCODE", this.frameStart);
    if (!(second & 128)) throw new ProtocolError("UNMASKED", this.frameStart);
    const tag = second & 127;
    if (opcode >= 8 && (!fin || tag > 125)) throw new ProtocolError("CONTROL_FRAME", this.frameStart);
    if (opcode === 0) {
      if (this.msgOpcode === undefined) throw new ProtocolError("SEQUENCE", this.frameStart);
    } else if (opcode < 8) {
      if (this.msgOpcode !== undefined) throw new ProtocolError("SEQUENCE", this.frameStart);
      this.msgOpcode = opcode;
      this.msgStart = this.frameStart;
    }
    this.hdrFin = fin;
    this.hdrOpcode = opcode;
    this.headerNeed = 2 + (tag === 126 ? 2 : tag === 127 ? 8 : 0) + 4;
    if (tag < 126) {
      this.declared = tag;
      this.lengthChecked = true;
      this.checkSize(tag);
    }
  }

  private checkLength(): void {
    const tag = this.head[1] & 127;
    if (tag === 126) {
      const size = this.head[2] * 256 + this.head[3];
      if (size < 126) throw new ProtocolError("NON_CANONICAL_LENGTH", this.frameStart);
      this.declared = size;
      this.checkSize(size);
    } else if (tag === 127) {
      let big = 0n;
      for (let i = 0; i < 8; i++) big = (big << 8n) | BigInt(this.head[2 + i]);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolError("LENGTH_RANGE", this.frameStart);
      if (big < 65536n) throw new ProtocolError("NON_CANONICAL_LENGTH", this.frameStart);
      const size = Number(big);
      this.declared = size;
      this.checkSize(size);
    }
  }

  private checkSize(size: number): void {
    if (this.hdrOpcode < 8 && this.msgBytes + size > this.limit) {
      throw new ProtocolError("MESSAGE_TOO_LARGE", this.frameStart);
    }
  }

  private readPayload(chunk: Uint8Array, at: number, events: Event[]): number {
    const take = Math.min(this.remaining, chunk.length - at);
    if (take > 0) {
      const piece = new Uint8Array(take);
      for (let i = 0; i < take; i++) {
        piece[i] = chunk[at + i] ^ this.mask[(this.consumed + i) % 4];
      }
      if (this.opcode >= 8) {
        this.ctrl.set(piece, this.ctrlLen);
        this.ctrlLen += take;
      } else {
        this.parts.push(piece);
        this.msgBytes += take;
      }
      this.consumed += take;
      this.remaining -= take;
      this.streamPos += take;
      at += take;
    }
    if (this.remaining === 0) this.completeFrame(events);
    return at;
  }

  private completeFrame(events: Event[]): void {
    const opcode = this.opcode;
    this.opcode = -1;
    if (opcode >= 8) {
      const type = ({8: "close", 9: "ping", 10: "pong"} as const)[opcode as 8 | 9 | 10];
      events.push({type, data: this.ctrl.slice(0, this.ctrlLen), offset: this.frameStart});
      this.ctrlLen = 0;
      return;
    }
    if (!this.fin) return;
    const payload = join(this.parts);
    const msgOpcode = this.msgOpcode as number;
    this.parts = [];
    this.msgBytes = 0;
    this.msgOpcode = undefined;
    if (msgOpcode === 1) {
      let text: string;
      try { text = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(payload); }
      catch { throw new ProtocolError("INVALID_UTF8", this.msgStart); }
      events.push({type: "text", data: text, offset: this.msgStart});
    } else {
      events.push({type: "binary", data: payload, offset: this.msgStart});
    }
  }
}
