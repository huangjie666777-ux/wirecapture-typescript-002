export type Event =
  | { type: "text"; data: string; offset: number }
  | { type: "binary" | "ping" | "pong" | "close"; data: Uint8Array; offset: number };

export interface Options { maxMessageBytes?: number; }

export type ErrorCode = "BAD_RSV" | "BAD_OPCODE" | "UNMASKED" | "CONTROL_FRAME"
  | "NON_CANONICAL_LENGTH" | "LENGTH_RANGE" | "SEQUENCE" | "MESSAGE_TOO_LARGE"
  | "INVALID_UTF8" | "TRUNCATED_FRAME" | "TRUNCATED_MESSAGE";

export class ProtocolError extends Error {
  constructor(public readonly code: ErrorCode, public readonly offset: number) {
    super(`${code} at byte ${offset}`);
    this.name = "ProtocolError";
  }
}

export class DecoderClosed extends Error {
  constructor() { super("Decoder has finished"); this.name = "DecoderClosed"; }
}

export function messageLimit(options: Options = {}): number {
  const value = options.maxMessageBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("maxMessageBytes must be a positive safe integer");
  return value;
}

export function join(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { output.set(chunk, at); at += chunk.length; }
  return output;
}
