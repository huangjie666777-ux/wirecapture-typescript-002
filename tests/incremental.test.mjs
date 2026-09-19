import test from 'node:test';
import assert from 'node:assert/strict';
import { Decoder, parseCapture, ProtocolError, DecoderClosed } from '../dist/index.js';
import { frame, concat, utf8 } from './fixtures.mjs';

function pushAll(decoder, bytes, size=1) {
  const events=[];
  for(let i=0;i<bytes.length;i+=size) events.push(...decoder.push(bytes.subarray(i,i+size)));
  return events;
}

test('byte-by-byte push matches parseCapture and stays bounded',()=>{
  const bytes=concat(
    frame(1,utf8('hé'),false),
    frame(9,new Uint8Array([1,2,3])),
    frame(0,utf8('llo')),
    frame(2,new Uint8Array(200).map((_,i)=>i&255)),
    frame(8,new Uint8Array([3,232])),
  );
  const decoder=new Decoder();
  const events=pushAll(decoder,bytes);
  events.push(...decoder.finish());
  assert.deepEqual(events,parseCapture(bytes));
  assert.equal(decoder.bufferedBytes,0);
});

test('events are emitted by the push that completes them, not at finish',()=>{
  const decoder=new Decoder();
  const f=frame(1,utf8('hi'));
  assert.deepEqual(decoder.push(f.subarray(0,f.length-1)),[]);
  const events=decoder.push(f.subarray(f.length-1));
  assert.deepEqual(events,[{type:'text',data:'hi',offset:0}]);
  assert.deepEqual(decoder.finish(),[]);
});

test('fragmented multibyte UTF-8 across chunks with interleaved ping/pong',()=>{
  const a=frame(1,new Uint8Array([0xe4]),false);
  const ping=frame(9,new Uint8Array([7]));
  const b=frame(0,new Uint8Array([0xb8]),false);
  const pong=frame(10,new Uint8Array([9]));
  const c=frame(0,new Uint8Array([0xad]));
  const bytes=concat(a,ping,b,pong,c);
  const decoder=new Decoder();
  const events=pushAll(decoder,bytes,3);
  assert.deepEqual(events,[
    {type:'ping',data:new Uint8Array([7]),offset:a.length},
    {type:'pong',data:new Uint8Array([9]),offset:a.length+ping.length+b.length},
    {type:'text',data:'中',offset:0},
  ]);
  assert.deepEqual(decoder.finish(),[]);
});

test('16-bit and 64-bit lengths split across chunks',()=>{
  const big=new Uint8Array(70000).map((_,i)=>i&255);
  const bytes=concat(frame(2,new Uint8Array(300).fill(5)),frame(2,big));
  const decoder=new Decoder();
  const events=pushAll(decoder,bytes,7);
  assert.equal(events.length,2);
  assert.deepEqual(events[1].data,big);
  assert.equal(events[1].offset,bytes.length-big.length-14);
  assert.deepEqual(decoder.finish(),[]);
});

test('mask index restarts per frame',()=>{
  const a=frame(1,utf8('ab'),false, [1,2,3,4]);
  const b=frame(0,utf8('cd'),true,[9,9,9,9]);
  const decoder=new Decoder();
  const events=pushAll(decoder,concat(a,b),1);
  assert.deepEqual(events,[{type:'text',data:'abcd',offset:0}]);
});

test('header errors fire as soon as the decisive bytes arrive',()=>{
  // RSV: only the first byte is needed in principle, contract says after 2 basic bytes
  let d=new Decoder();
  assert.throws(()=>d.push(new Uint8Array([0xC1,0x80])),e=>e.code==='BAD_RSV'&&e.offset===0);
  // NON_CANONICAL_LENGTH after the 2 extended bytes, before mask key
  d=new Decoder();
  d.push(new Uint8Array([0x82,0xfe]));
  assert.throws(()=>d.push(new Uint8Array([0x00,0x10])),e=>e.code==='NON_CANONICAL_LENGTH'&&e.offset===0);
  // LENGTH_RANGE after 8 extended bytes, before mask key
  d=new Decoder();
  d.push(new Uint8Array([0x82,0xff]));
  assert.throws(()=>d.push(new Uint8Array([0x80,0,0,0,0,0,0,0])),e=>e.code==='LENGTH_RANGE');
  // MESSAGE_TOO_LARGE at length declaration, before mask/payload allocation
  d=new Decoder({maxMessageBytes:10});
  d.push(new Uint8Array([0x82,0xfe]));
  assert.throws(()=>d.push(new Uint8Array([0x10,0x00])),e=>e.code==='MESSAGE_TOO_LARGE'&&e.offset===0);
});

test('MESSAGE_TOO_LARGE rejects at header time and latches the same object',()=>{
  const d=new Decoder({maxMessageBytes:10});
  let caught;
  try { d.push(new Uint8Array([0x82,0xfe,0x10,0x00])); } catch(e){ caught=e; }
  assert.ok(caught instanceof ProtocolError && caught.code==='MESSAGE_TOO_LARGE' && caught.offset===0);
  assert.equal(d.bufferedBytes<=10+139,true);
  assert.throws(()=>d.push(new Uint8Array([1])),e=>e===caught);
  assert.throws(()=>d.finish(),e=>e===caught);
});

test('cumulative size across fragments counts, controls do not',()=>{
  const d=new Decoder({maxMessageBytes:10});
  d.push(frame(1,new Uint8Array(6),false));
  d.push(frame(9,new Uint8Array(100).subarray(0,100)));
  assert.throws(()=>d.push(frame(0,new Uint8Array(5))),e=>e.code==='MESSAGE_TOO_LARGE');
});

test('SEQUENCE errors at basic header',()=>{
  let d=new Decoder();
  assert.throws(()=>d.push(frame(0,new Uint8Array([1]))),e=>e.code==='SEQUENCE'&&e.offset===0);
  d=new Decoder();
  d.push(frame(1,utf8('open'),false));
  assert.throws(()=>d.push(frame(2,new Uint8Array([1]))),e=>e.code==='SEQUENCE');
});

test('invalid UTF-8 reported at message start offset and latched',()=>{
  const prefix=frame(9,new Uint8Array([1]));
  const bad=frame(1,new Uint8Array([0xc0,0x80]));
  const d=new Decoder();
  d.push(prefix);
  let caught;
  try { d.push(bad); } catch(e){ caught=e; }
  assert.equal(caught.code,'INVALID_UTF8');
  assert.equal(caught.offset,prefix.length);
  assert.throws(()=>d.push(new Uint8Array([0])),e=>e===caught);
});

test('finish reports truncated frame before truncated message',()=>{
  let d=new Decoder();
  d.push(frame(1,utf8('ab'),false));
  d.push(new Uint8Array([0x80]));
  assert.throws(()=>d.finish(),e=>e.code==='TRUNCATED_FRAME'&&e.offset===frame(1,utf8('ab'),false).length);
  d=new Decoder();
  d.push(frame(1,utf8('ab'),false));
  assert.throws(()=>d.finish(),e=>e.code==='TRUNCATED_MESSAGE'&&e.offset===0);
  assert.throws(()=>d.finish(),e=>e.code==='TRUNCATED_MESSAGE');
  assert.throws(()=>d.push(new Uint8Array()),e=>e.code==='TRUNCATED_MESSAGE');
});

test('finish is idempotent and later pushes throw DecoderClosed',()=>{
  const d=new Decoder();
  d.push(frame(1,utf8('x')));
  assert.deepEqual(d.finish(),[]);
  assert.deepEqual(d.finish(),[]);
  assert.throws(()=>d.push(new Uint8Array()),DecoderClosed);
  assert.throws(()=>d.push(frame(1,utf8('y'))),DecoderClosed);
});

test('bufferedBytes reflects retention and stays bounded',()=>{
  const d=new Decoder({maxMessageBytes:1000});
  assert.equal(d.bufferedBytes,0);
  const f=frame(1,new Uint8Array(500),false);
  d.push(f);
  assert.equal(d.bufferedBytes,500);
  d.push(new Uint8Array([0x89,0x85])); // ping header, 5-byte payload
  assert.equal(d.bufferedBytes,502);
  d.push(frame(9,new Uint8Array(5)).subarray(2)); // mask + payload of ping
  assert.equal(d.bufferedBytes,500);
  d.push(frame(0,new Uint8Array(500)));
  assert.equal(d.bufferedBytes,0);
});

test('input mutation after push and returned-event mutation are isolated',()=>{
  const d=new Decoder();
  const chunk=new Uint8Array(frame(2,new Uint8Array([1,2,3])));
  const events=d.push(chunk);
  chunk.fill(0);
  assert.deepEqual(events,[{type:'binary',data:new Uint8Array([1,2,3]),offset:0}]);
  events[0].data[0]=99;
  const d2=new Decoder();
  assert.deepEqual(d2.push(frame(2,new Uint8Array([1,2,3])))[0].data,new Uint8Array([1,2,3]));
  assert.deepEqual(d.finish(),[]);
});

test('empty chunks and empty messages are legal',()=>{
  const d=new Decoder();
  assert.deepEqual(d.push(new Uint8Array()),[]);
  assert.deepEqual(d.push(frame(1)),[{type:'text',data:'',offset:0}]);
  assert.deepEqual(d.push(frame(2)),[{type:'binary',data:new Uint8Array(),offset:frame(1).length}]);
  assert.deepEqual(d.finish(),[]);
});

test('close emits raw bytes and decoding continues',()=>{
  const bytes=concat(frame(8,new Uint8Array([3,232,255])),frame(1,utf8('after')));
  const d=new Decoder();
  const events=pushAll(d,bytes,2);
  assert.deepEqual(events,[
    {type:'close',data:new Uint8Array([3,232,255]),offset:0},
    {type:'text',data:'after',offset:frame(8,new Uint8Array([3,232,255])).length},
  ]);
});

test('constructor validates the limit',()=>{
  assert.throws(()=>new Decoder({maxMessageBytes:0}),RangeError);
  assert.throws(()=>new Decoder({maxMessageBytes:1.5}),RangeError);
  assert.throws(()=>new Decoder({maxMessageBytes:Number.MAX_SAFE_INTEGER+1}),RangeError);
});
