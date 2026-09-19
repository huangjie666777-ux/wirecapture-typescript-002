import { Event, join, ProtocolError } from "./types.js";
import { Frame } from "./wire.js";

/** Stateful message assembly used by the existing whole-capture pipeline. */
export class Messages {
  private parts: Uint8Array[] = [];
  private opcode: number | undefined;
  private start = 0;
  private bytes = 0;
  constructor(private readonly limit: number) {}

  accept(frame: Frame): Event[] {
    if (frame.opcode >= 8) {
      const type = ({8: "close", 9: "ping", 10: "pong"} as const)[frame.opcode as 8 | 9 | 10];
      return [{type, data: frame.payload.slice(), offset: frame.offset}];
    }
    if (frame.opcode === 0) {
      if (this.opcode === undefined) throw new ProtocolError("SEQUENCE", frame.offset);
    } else {
      if (this.opcode !== undefined) throw new ProtocolError("SEQUENCE", frame.offset);
      this.opcode = frame.opcode; this.start = frame.offset;
    }
    this.bytes += frame.payload.length;
    if (this.bytes > this.limit) throw new ProtocolError("MESSAGE_TOO_LARGE", frame.offset);
    this.parts.push(frame.payload);
    if (!frame.fin) return [];
    const payload = join(this.parts);
    let event: Event;
    if (this.opcode === 1) {
      let text: string;
      try { text = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(payload); }
      catch { throw new ProtocolError("INVALID_UTF8", this.start); }
      event = {type: "text", data: text, offset: this.start};
    } else event = {type: "binary", data: payload, offset: this.start};
    this.parts = []; this.bytes = 0; this.opcode = undefined;
    return [event];
  }

  finish(): void {
    if (this.opcode !== undefined) throw new ProtocolError("TRUNCATED_MESSAGE", this.start);
  }
}
