import { Decoder, ProtocolError } from './dist/index.js';
import { frame, concat, utf8 } from './tests/fixtures.mjs';

console.log('--- byte-by-byte: fragmented UTF-8 with an interleaved ping ---');
const capture=concat(
  frame(1,new Uint8Array([0xe4]),false),   // first byte of '中', message opens
  frame(9,new Uint8Array([42])),            // ping between fragments
  frame(0,new Uint8Array([0xb8,0xad])),     // rest of '中', message completes
  frame(1,utf8('offline')),
);
const decoder=new Decoder();
for(const byte of capture) {
  for(const event of decoder.push(new Uint8Array([byte]))) console.log('during push:',event);
}
for(const event of decoder.finish()) console.log('at EOF:',event);
console.log('bufferedBytes at idle:',decoder.bufferedBytes);

console.log('--- oversize declared length rejected at the header ---');
const limited=new Decoder({maxMessageBytes:16});
const header=new Uint8Array([0x82,0xfe,0x10,0x00]); // binary, 64-bit tag 126, length 4096
try {
  limited.push(header.subarray(0,2));
  limited.push(header.subarray(2)); // decisive length bytes: throws before mask/payload
} catch (error) {
  if(error instanceof ProtocolError) console.log('rejected:',error.code,'at byte',error.offset);
  else throw error;
}
