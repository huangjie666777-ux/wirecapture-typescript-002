import { parseCapture } from "./capture.js";
import { DecoderClosed, Event, join, messageLimit, Options, ProtocolError } from "./types.js";

/** Legacy adapter. It retains the whole capture and only decodes at EOF. */
export class Decoder {
  private input = new Uint8Array(0);
  private ended = false;
  private failure: ProtocolError | undefined;
  private readonly limit: number;
  constructor(options: Options = {}) { this.limit = messageLimit(options); }

  get bufferedBytes(): number { return this.input.length; }

  push(chunk: Uint8Array): Event[] {
    if (this.failure) throw this.failure;
    if (this.ended) throw new DecoderClosed();
    this.input = join([this.input, chunk]);
    return [];
  }

  finish(): Event[] {
    if (this.failure) throw this.failure;
    if (this.ended) return [];
    try {
      const events = parseCapture(this.input, {maxMessageBytes: this.limit});
      this.input = new Uint8Array(0); this.ended = true;
      return events;
    } catch (error) {
      if (error instanceof ProtocolError) this.failure = error;
      throw error;
    }
  }
}
