import test from 'node:test';
import assert from 'node:assert/strict';
import { Decoder, parseCapture, ProtocolError, DecoderClosed } from '../dist/index.js';
import { frame, concat, utf8 } from './fixtures.mjs';

function pushIn(decoder, bytes, sizes) {
  const events = [];
  let at = 0, i = 0;
  while (at < bytes.length) {
    const n = Math.min(sizes[i++ % sizes.length], bytes.length - at);
    events.push(...decoder.push(bytes.subarray(at, at + n)));
    at += n;
  }
  return events;
}

const sample = concat(
  frame(1, utf8('he'), false),
  frame(9, new Uint8Array([1, 2, 3])),
  frame(0, utf8('llo')),
  frame(2, new Uint8Array(200).map((_, i) => i & 255)),
  frame(10),
  frame(8, new Uint8Array([3, 232])),
  frame(1, utf8('done')),
);

test('every chunk split reproduces parseCapture events and offsets', () => {
  const expected = parseCapture(sample);
  for (const sizes of [[1], [2, 3, 5, 7], [sample.length], [13, 1, 1, 64]]) {
    const decoder = new Decoder();
    const events = pushIn(decoder, sample, sizes);
    assert.deepEqual(events, expected);
    assert.deepEqual(decoder.finish(), []);
    assert.equal(decoder.bufferedBytes, 0);
  }
});

test('events are delivered by the completing push, not at finish', () => {
  const bytes = frame(1, utf8('hi'));
  const decoder = new Decoder();
  assert.deepEqual(decoder.push(bytes.subarray(0, bytes.length - 1)), []);
  const events = decoder.push(bytes.subarray(bytes.length - 1));
  assert.deepEqual(events, [{type: 'text', data: 'hi', offset: 0}]);
  assert.deepEqual(decoder.finish(), []);
});

test('empty frame completed at exact chunk end emits immediately', () => {
  const decoder = new Decoder();
  const events = decoder.push(frame(9));
  assert.deepEqual(events, [{type: 'ping', data: new Uint8Array(), offset: 0}]);
});

test('interleaved ping precedes fragmented text despite later offset', () => {
  const a = frame(1, new Uint8Array([0xe4]), false);
  const ping = frame(9, new Uint8Array([7]));
  const b = frame(0, new Uint8Array([0xb8, 0xad]));
  const decoder = new Decoder();
  const events = pushIn(decoder, concat(a, ping, b), [1]);
  assert.deepEqual(events, [
    {type: 'ping', data: new Uint8Array([7]), offset: a.length},
    {type: 'text', data: '中', offset: 0},
  ]);
});

test('multibyte UTF-8 split across chunks and fragments validates only at completion', () => {
  const text = '中🙂abc';
  const payload = utf8(text);
  const first = frame(1, payload.subarray(0, 3), false);
  const second = frame(0, payload.subarray(3));
  const decoder = new Decoder();
  const events = pushIn(decoder, concat(first, second), [1]);
  assert.deepEqual(events, [{type: 'text', data: text, offset: 0}]);
});

test('invalid UTF-8 reported at message start and locks the decoder', () => {
  const decoder = new Decoder();
  let caught;
  try { decoder.push(frame(1, new Uint8Array([0xc0, 0x80]))); } catch (e) { caught = e; }
  assert.ok(caught instanceof ProtocolError);
  assert.equal(caught.code, 'INVALID_UTF8');
  assert.equal(caught.offset, 0);
  assert.throws(() => decoder.push(new Uint8Array([0])), e => e === caught);
  assert.throws(() => decoder.finish(), e => e === caught);
});

test('64-bit length split across chunks; mask index restarts per frame', () => {
  const payload = new Uint8Array(70000).map((_, i) => (i * 31) & 255);
  const bytes = concat(frame(2, payload), frame(2, new Uint8Array([9, 9, 9])));
  const decoder = new Decoder();
  const events = pushIn(decoder, bytes, [3, 5, 2, 4096, 1, 65536]);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {type: 'binary', data: payload, offset: 0});
  assert.deepEqual(events[1].data, new Uint8Array([9, 9, 9]));
  assert.equal(events[1].offset, bytes.length - 9);
});

test('MESSAGE_TOO_LARGE is thrown from header bytes alone, before payload', () => {
  const short = new Decoder({maxMessageBytes: 10});
  assert.throws(() => short.push(new Uint8Array([0x82, 0x8b])), e =>
    e instanceof ProtocolError && e.code === 'MESSAGE_TOO_LARGE' && e.offset === 0);
  const extended = new Decoder({maxMessageBytes: 100});
  assert.throws(() => extended.push(new Uint8Array([0x82, 0xfe, 0x00, 0xc8])), e =>
    e instanceof ProtocolError && e.code === 'MESSAGE_TOO_LARGE' && e.offset === 0);
});

test('cumulative fragment sizes count toward the limit, controls do not', () => {
  const decoder = new Decoder({maxMessageBytes: 4});
  assert.deepEqual(decoder.push(frame(1, new Uint8Array(3), false)), []);
  assert.deepEqual(decoder.push(frame(9, new Uint8Array(125))).length, 1);
  assert.throws(() => decoder.push(frame(0, new Uint8Array(2)).subarray(0, 2)),
    e => e.code === 'MESSAGE_TOO_LARGE');
});

test('LENGTH_RANGE rejects huge 64-bit length as soon as length bytes arrive', () => {
  const decoder = new Decoder();
  const header = new Uint8Array([0x82, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.throws(() => decoder.push(header), e =>
    e instanceof ProtocolError && e.code === 'LENGTH_RANGE' && e.offset === 0);
});

test('basic header errors surface from the first two bytes', () => {
  for (const [bytes, code] of [
    [new Uint8Array([0xc1, 0x80]), 'BAD_RSV'],
    [new Uint8Array([0x83, 0x80]), 'BAD_OPCODE'],
    [new Uint8Array([0x81, 0x00]), 'UNMASKED'],
    [new Uint8Array([0x09, 0x80]), 'CONTROL_FRAME'],
    [new Uint8Array([0x80, 0x80]), 'SEQUENCE'],
  ]) {
    const decoder = new Decoder();
    assert.throws(() => decoder.push(bytes), e =>
      e instanceof ProtocolError && e.code === code && e.offset === 0, code);
  }
});

test('NON_CANONICAL_LENGTH for both 16-bit and 64-bit forms', () => {
  const a = new Decoder();
  assert.throws(() => a.push(new Uint8Array([0x81, 0xfe, 0x00, 0x7d])),
    e => e.code === 'NON_CANONICAL_LENGTH');
  const b = new Decoder();
  const header = new Uint8Array([0x81, 0xff, 0, 0, 0, 0, 0, 0, 0, 0]);
  header[9] = 0xff; // 255 < 65536 via 64-bit encoding
  assert.throws(() => b.push(header), e => e.code === 'NON_CANONICAL_LENGTH');
});

test('SEQUENCE when a new data opcode arrives during fragmentation', () => {
  const decoder = new Decoder();
  decoder.push(frame(1, new Uint8Array([1]), false));
  assert.throws(() => decoder.push(frame(2, new Uint8Array([1]))),
    e => e instanceof ProtocolError && e.code === 'SEQUENCE' && e.offset === 7);
});

test('finish reports truncated frame before truncated message', () => {
  const open = new Decoder();
  open.push(frame(1, new Uint8Array([65]), false));
  assert.throws(() => open.finish(), e =>
    e.code === 'TRUNCATED_MESSAGE' && e.offset === 0);

  const partial = new Decoder();
  partial.push(frame(1, new Uint8Array([65]), false));
  partial.push(new Uint8Array([0x80])); // start of another frame
  assert.throws(() => partial.finish(), e =>
    e.code === 'TRUNCATED_FRAME' && e.offset === 7);
});

test('finish is idempotent and later pushes throw DecoderClosed', () => {
  const decoder = new Decoder();
  decoder.push(frame(1, utf8('ok')));
  assert.deepEqual(decoder.finish(), []);
  assert.deepEqual(decoder.finish(), []);
  assert.throws(() => decoder.push(new Uint8Array()), DecoderClosed);
});

test('bufferedBytes reflects retention and stays bounded', () => {
  const decoder = new Decoder({maxMessageBytes: 1000});
  assert.equal(decoder.bufferedBytes, 0);
  decoder.push(frame(1, new Uint8Array(500), false));
  assert.equal(decoder.bufferedBytes, 500);
  const ping = frame(9, new Uint8Array(120));
  decoder.push(ping.subarray(0, 2)); // unfinished ping header
  assert.equal(decoder.bufferedBytes, 502);
  assert.equal(decoder.push(ping.subarray(2)).length, 1); // ping completes
  assert.equal(decoder.bufferedBytes, 500);
  assert.equal(decoder.push(frame(0, new Uint8Array(400))).length, 1);
  assert.equal(decoder.bufferedBytes, 0);
});

test('bufferedBytes never exceeds maxMessageBytes + 139 under byte-wise feeds', () => {
  const limit = 300;
  const payload = new Uint8Array(limit);
  const capture = concat(
    frame(1, payload.subarray(0, 100), false),
    frame(9, new Uint8Array(125)),
    frame(0, payload.subarray(100)),
  );
  const decoder = new Decoder({maxMessageBytes: limit});
  for (const byte of capture) {
    decoder.push(new Uint8Array([byte]));
    assert.ok(decoder.bufferedBytes <= limit + 139, String(decoder.bufferedBytes));
  }
  assert.equal(decoder.bufferedBytes, 0);
});

test('caller mutation of input after push does not affect decoder or events', () => {
  const bytes = frame(2, new Uint8Array([1, 2, 3]));
  const copy = bytes.slice();
  const decoder = new Decoder();
  assert.deepEqual(decoder.push(bytes.subarray(0, 4)), []); // header fragment retained internally
  bytes.fill(0xff); // caller overwrites its buffer immediately
  const events = decoder.push(copy.subarray(4));
  assert.deepEqual(events, [{type: 'binary', data: new Uint8Array([1, 2, 3]), offset: 0}]);
});

test('mutating a returned event does not alter decoder state or other events', () => {
  const decoder = new Decoder();
  const first = decoder.push(frame(2, new Uint8Array([1, 2, 3])))[0];
  first.data[0] = 99;
  const second = decoder.push(frame(2, new Uint8Array([4, 5, 6])))[0];
  assert.deepEqual(second.data, new Uint8Array([4, 5, 6]));
  assert.deepEqual(parseCapture(frame(2, new Uint8Array([1, 2, 3])))[0].data, new Uint8Array([1, 2, 3]));
});

test('close payload passes through as raw bytes and decoding continues', () => {
  const decoder = new Decoder();
  const events = pushIn(decoder, concat(
    frame(8, new Uint8Array([0xff, 0xff, 1, 2])),
    frame(1, utf8('after')),
  ), [1]);
  assert.deepEqual(events, [
    {type: 'close', data: new Uint8Array([0xff, 0xff, 1, 2]), offset: 0},
    {type: 'text', data: 'after', offset: 10},
  ]);
});

test('empty messages and empty fragments are legal', () => {
  const decoder = new Decoder();
  const events = pushIn(decoder, concat(
    frame(1),
    frame(1, new Uint8Array(), false),
    frame(0),
  ), [2]);
  assert.deepEqual(events, [
    {type: 'text', data: '', offset: 0},
    {type: 'text', data: '', offset: 6},
  ]);
});

test('UTF-8 BOM is preserved as U+FEFF', () => {
  const decoder = new Decoder();
  const events = decoder.push(frame(1, utf8('\ufeffx')));
  assert.deepEqual(events, [{type: 'text', data: '\ufeffx', offset: 0}]);
});

test('construction validates the limit', () => {
  assert.throws(() => new Decoder({maxMessageBytes: 0}), RangeError);
  assert.throws(() => new Decoder({maxMessageBytes: 1.5}), RangeError);
  assert.throws(() => new Decoder({maxMessageBytes: 2 ** 53}), RangeError);
});
