import test from 'node:test';
import assert from 'node:assert/strict';
import { Decoder, parseCapture, ProtocolError, DecoderClosed } from '../dist/index.js';
import { frame, concat, utf8 } from './fixtures.mjs';

test('complete capture retains binary, text and absolute offsets',()=>{
  const a=frame(1,utf8('hello')), b=frame(2,new Uint8Array([0,255,17]));
  assert.deepEqual(parseCapture(concat(a,b)),[
    {type:'text',data:'hello',offset:0}, {type:'binary',data:new Uint8Array([0,255,17]),offset:a.length}]);
});
test('fragmented UTF-8 with an interleaved ping',()=>{
  const a=frame(1,new Uint8Array([0xe4]),false), ping=frame(9,new Uint8Array([7]));
  const b=frame(0,new Uint8Array([0xb8,0xad]));
  assert.deepEqual(parseCapture(concat(a,ping,b)),[
    {type:'ping',data:new Uint8Array([7]),offset:a.length}, {type:'text',data:'中',offset:0}]);
});
test('Decoder collected events match the complete-capture entry',()=>{
  const bytes=concat(frame(1,utf8('split')),frame(10,new Uint8Array([8])));
  const decoder=new Decoder(), events=[];
  events.push(...decoder.push(bytes.subarray(0,3)),...decoder.push(bytes.subarray(3)),...decoder.finish());
  assert.deepEqual(events,parseCapture(bytes)); assert.deepEqual(decoder.finish(),[]);
  assert.throws(()=>decoder.push(new Uint8Array()),DecoderClosed);
});
test('whole capture rejects incomplete frames and invalid UTF-8',()=>{
  assert.throws(()=>parseCapture(new Uint8Array([0x81])),e=>e instanceof ProtocolError&&e.code==='TRUNCATED_FRAME'&&e.offset===0);
  assert.throws(()=>parseCapture(frame(1,new Uint8Array([0xc0,0x80]))),e=>e.code==='INVALID_UTF8');
});
