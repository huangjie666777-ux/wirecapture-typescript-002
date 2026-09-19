# wirecapture

An existing, offline client-to-server WebSocket capture pipeline in TypeScript.
`wire.ts` parses contiguous frames, `messages.ts` assembles messages, and
`capture.ts` provides the synchronous `parseCapture` API. `Decoder` currently
copies the growing capture on every `push` and parses it only at `finish`.
Refactor this adapter into a genuinely incremental decoder without breaking
the public whole-capture entry or the existing regression tests.

Node.js 22.16.0 and TypeScript 5.8.3 are prepared. Run `npm test` or `npm run demo`;
no dependency installation or network access is needed. The current demo prints
its events at EOF, illustrating the behavior that the refactor must change.

## Public contract

`new Decoder({maxMessageBytes?: number})`, `push(chunk: Uint8Array): Event[]`,
`finish(): Event[]`, and the read-only `bufferedBytes` property stay available
through `src/index.ts`, alongside `parseCapture`, `ProtocolError`, and
`DecoderClosed`. A missing limit defaults to 1 MiB. A supplied limit must be a
positive safe integer or construction throws `RangeError`. Input chunks are
valid Uint8Arrays; arbitrary byte boundaries and empty chunks are legal.

Events have exactly `{type, data, offset}`. Text data is a string; binary, ping,
pong, and close data is an owned Uint8Array. `offset` is zero-based, measured in
the entire encoded input stream including all headers, masks and controls.
Message events use the first data frame's offset; controls use their own frame
offset. Return events in completion order, so an interleaved ping precedes a
fragmented text message even though the text's offset is earlier. A completed
message/control must be returned by the push that supplies its last byte.

Input may be overwritten by its caller immediately after push returns. Decoding
must not modify input or retain mutable aliases to it. Mutating a returned byte
event must not alter any other event or unfinished parser state.

## Framing scope

This is a deliberately scoped offline decoder, not a WebSocket connection.
All frames are masked client-to-server frames, RSV bits are zero, and opcodes
are continuation=0, text=1, binary=2, close=8, ping=9 and pong=10. Masking uses
the four mask bytes cyclically, starting at zero for each frame. Length fields
are unsigned big-endian; the shortest encoding is mandatory. A 64-bit length
must fit Number.MAX_SAFE_INTEGER before conversion to Number. Control frames
must have FIN=1 and payload length <=125, without extended-length encoding.

At most one fragmented data message is open. Continuation requires an open
message; text/binary cannot start another until it ends. Controls can occur
between any data fragments and do not close or reset the data message. Empty
messages and empty fragments are legal. Text is strict UTF-8 only when the full
message ends, including overlong sequences, surrogates and truncated scalars;
the UTF-8 BOM is preserved as U+FEFF. Binary messages are never UTF-8 validated.

Close is emitted as raw control bytes. Do not validate status-code semantics,
enforce close-handshake state, or stop decoding after it. Compression, extension
negotiation, unmasked server frames, sockets and HTTP handshake are out of scope.
The framing subset is informed by RFC6455 sections 5.2–5.6; this README defines
the exact local exercise contract rather than claiming full RFC conformance.

## Errors and timing

ProtocolError carries the following code and offset; its text is not specified.

| Code | Condition | Offset |
|---|---|---|
| BAD_RSV | any RSV bit set | offending frame start |
| BAD_OPCODE | any opcode outside 0,1,2,8,9,10 | offending frame start |
| UNMASKED | mask flag is zero | offending frame start |
| CONTROL_FRAME | fragmented control or control length tag >125 | offending frame start |
| NON_CANONICAL_LENGTH | 126 encoding for <126, or 127 encoding for <65536 | offending frame start |
| LENGTH_RANGE | 64-bit length exceeds Number.MAX_SAFE_INTEGER, including a set high bit | offending frame start |
| SEQUENCE | orphan continuation or new data opcode during fragmentation | offending frame start |
| MESSAGE_TOO_LARGE | a data frame's declared length plus previous fragments exceeds maxMessageBytes | offending frame start |
| INVALID_UTF8 | completed text is not well-formed UTF-8 | first frame of that message |
| TRUNCATED_FRAME | EOF inside any frame header, mask or payload | incomplete frame start |
| TRUNCATED_MESSAGE | EOF after complete frames but without final data fragment | first frame of unfinished message |

After the two basic header bytes are available, validate their decidable rules
(including fragmentation sequence) immediately. Extended-length validity and
cumulative data size must be checked as soon as their length bytes are available,
before waiting for the mask key or payload and before allocating according to
that declared size. LENGTH_RANGE precedes converting a 64-bit length; canonical
length validation precedes the size-limit comparison. If several basic-header
rules are violated simultaneously, any applicable code at that frame start is
acceptable. Controls do not consume the data-message quota.

Protocol failure is terminal: save that exact ProtocolError object, propagate
it, and rethrow the same object on every later push/finish. If a push fails,
it returns no events; events from earlier successful pushes remain valid.
Incomplete input alone is not a push error. At EOF a partial frame takes
precedence over an open fragmented message. Successful finish returns no
additional events and is idempotent; every subsequent push, including an empty
chunk, throws DecoderClosed. There is no reset method.

## Retention and compatibility

After each successful push, retain only unfinished data-message payload,
unfinished control payload, and up to 14 bytes of raw header state.
`bufferedBytes` reports those actually retained bytes (not object overhead,
capacity of spare allocation, or already-returned events) and must be at most
`maxMessageBytes + 139`, independent of the total capture length. At an idle
message/frame boundary it is zero. Do not retain or rescan the whole capture,
and do not concatenate all prior input each time another chunk arrives.

The current complete-capture fixtures are compatibility coverage, not a hidden
implementation guide. Preserve `tests/legacy.test.mjs`; add focused tests for
incremental behavior. Business changes stay within `src/`. Tests, README and
demo may be extended, but dependency and public API changes are not requested.
