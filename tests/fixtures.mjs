export const utf8 = text => new TextEncoder().encode(text);
export function concat(...parts) {
  const output = new Uint8Array(parts.reduce((n,p) => n+p.length,0));
  let at=0; for(const part of parts){output.set(part,at);at+=part.length;} return output;
}
export function frame(opcode, payload=new Uint8Array(), fin=true, key=[0x37,0xfa,0x21,0x3d]) {
  const length=payload.length;
  const tag=length<126?length:length<65536?126:127;
  const ext=tag===126?2:tag===127?8:0;
  const result=new Uint8Array(2+ext+4+length);
  result[0]=(fin?128:0)|opcode; result[1]=128|tag;
  let value=BigInt(length);
  for(let i=ext-1;i>=0;i--){result[2+i]=Number(value&255n);value>>=8n;}
  result.set(key,2+ext);
  for(let i=0;i<length;i++)result[6+ext+i]=payload[i]^key[i%4];
  return result;
}
