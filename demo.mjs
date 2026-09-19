import { Decoder, ProtocolError } from './dist/index.js';
import { frame, concat, utf8 } from './tests/fixtures.mjs';

console.log('--- byte-by-byte feed: events arrive during push, not at EOF ---');
{
  const capture = concat(frame(1, utf8('offline')), frame(9, new Uint8Array([42])));
  const decoder = new Decoder();
  for (const byte of capture) {
    for (const event of decoder.push(new Uint8Array([byte]))) console.log('during push:', event);
  }
  console.log('finish:', decoder.finish(), 'bufferedBytes:', decoder.bufferedBytes);
}

console.log('--- fragmented UTF-8 with an interleaved ping ---');
{
  const hanzi = utf8('中文');
  const capture = concat(
    frame(1, hanzi.subarray(0, 4), false),   // splits the second character
    frame(9, new Uint8Array([7])),           // control interleaved mid-message
    frame(0, hanzi.subarray(4)),
  );
  const decoder = new Decoder();
  for (const event of pushAll(decoder, capture)) console.log('event:', event);
  decoder.finish();
}

console.log('--- oversized declared length rejected from the header alone ---');
{
  const decoder = new Decoder({maxMessageBytes: 16});
  const headerOnly = new Uint8Array([0x82, 0xfe, 0x10, 0x00]); // declares 4096 > 16
  try {
    decoder.push(headerOnly);
  } catch (error) {
    console.log('rejected before any payload byte:', error instanceof ProtocolError, error.code, 'at offset', error.offset);
  }
}

function pushAll(decoder, bytes) {
  const events = [];
  for (const byte of bytes) events.push(...decoder.push(new Uint8Array([byte])));
  return events;
}
