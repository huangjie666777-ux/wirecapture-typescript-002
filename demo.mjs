import { Decoder } from './dist/index.js';
import { frame, concat, utf8 } from './tests/fixtures.mjs';
const capture=concat(frame(1,utf8('offline')),frame(9,new Uint8Array([42])));
const decoder=new Decoder();
for(const byte of capture) {
  for(const event of decoder.push(new Uint8Array([byte]))) console.log('during push:',event);
}
for(const event of decoder.finish()) console.log('at EOF:',event);
