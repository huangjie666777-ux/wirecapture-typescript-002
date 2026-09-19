import { Event, messageLimit, Options, ProtocolError } from "./types.js";
import { Messages } from "./messages.js";
import { readFrame } from "./wire.js";

/** Public synchronous entry for complete, offline captures. */
export function parseCapture(bytes: Uint8Array, options: Options = {}): Event[] {
  const messages = new Messages(messageLimit(options));
  const events: Event[] = [];
  let position = 0;
  while (position < bytes.length) {
    const result = readFrame(bytes, position);
    if (!result) throw new ProtocolError("TRUNCATED_FRAME", position);
    events.push(...messages.accept(result.frame));
    position = result.next;
  }
  messages.finish();
  return events;
}
