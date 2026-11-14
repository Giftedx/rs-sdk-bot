import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const dir=import.meta.dir,html=readFileSync(dir+'/index.html','utf8'),names=JSON.parse(readFileSync(dir+'/items.json','utf8'));
const count=Number(html.match(/const ITEM_SPRITE_COUNT=(\d+);/)?.[1]);
const iconFor=(state:any)=>new Function('S','LOCAL_ITEMS','ITEM_SPRITE_COUNT','E',html.slice(html.indexOf('function icon('),html.indexOf('// Stack numbers'))+';return icon;')(state,names,count,String);

test('the sprite URL changes with the sheet so cached older artwork cannot hide new IDs',()=>{
 const hash=createHash('sha256').update(readFileSync(dir+'/items.png')).digest('hex');
 expect(html.includes('/items.png?v='+hash)).toBe(true);
});

test('the local item sheet contains the final game item IDs with visible artwork',()=>{
 const png=readFileSync(dir+'/items.png'),width=png.readUInt32BE(16),height=png.readUInt32BE(20);
 expect(width).toBe(2048);expect(height).toBeGreaterThanOrEqual(2048);expect(png[25]).toBe(6);
 const data:Buffer[]=[];for(let at=8;at<png.length;){const n=png.readUInt32BE(at);if(png.toString('ascii',at+4,at+8)==='IDAT')data.push(png.subarray(at+8,at+8+n));at+=12+n;}
 const rows=inflateSync(Buffer.concat(data)),stride=width*4+1;
 for(const id of [385,1135,2503,2504,3904,4000,4088]){
  let pixels=0;for(let y=0;y<32;y++)for(let x=0;x<32;x++)pixels+=rows[(Math.floor(id/64)*32+y)*stride+1+((id%64)*32+x)*4+3]!>0?1:0;
  expect(pixels).toBeGreaterThan(0);
 }
 expect(Object.values(names).some(id=>Number(id)>=3904)).toBe(true);
});

test('the client permits local icons throughout the generated item range',()=>{
 expect(count).toBeGreaterThan(4088);
 const icon=iconFor({icons:{'Last item':4088}});
 expect(icon('Last item')).not.toContain('ico none');expect(icon('Unknown item')).toContain('ico none');
});

test('raw IDs keep same-name dragonhide colours and certificate artwork instead of a name or base-item sprite',()=>{
 const icon=iconFor({icons:{'Dragonhide body':1135}}),green={id:1135,name:'Dragonhide body'},black={id:2503,name:'Dragonhide body'},note={id:2504,baseId:2503,name:'Dragonhide body (noted)'};
 const position=(id:number,size=32)=>`background-position:-${id%64*size}px -${Math.floor(id/64)*size}px`;
 expect(names['dragonhide body']).toBe(1135);
 expect(icon(green)).toContain(position(1135));expect(icon(black)).toContain(position(2503));expect(icon(note)).toContain(position(2504));
 expect(icon(black)).not.toContain(position(1135));expect(icon(note)).not.toContain(position(2503));
 expect(icon({baseId:2503,name:black.name},24)).toContain(position(2503,24));
});

test('explicit invalid raw IDs cannot borrow a base ID or a safe alias; current empty alias tables stay unknown',()=>{
 const icon=iconFor({icons:{Shark:385}});
 for(const id of [undefined,null,-1,1.5,NaN,Infinity,count,999999,'385'])
  expect(icon({id,baseId:385,name:'Shark'})).toContain('ico none');
 for(const baseId of [undefined,null,-1,1.5,count])expect(icon({baseId,name:'Shark'})).toContain('ico none');
 expect(icon('Shark')).not.toContain('ico none');
 expect(iconFor({icons:{}})('Shark')).toContain('ico none');
 expect(iconFor({icons:{}})({name:'Shark'})).toContain('ico none');
 expect(iconFor({icons:{shark:385}})('Shark')).not.toContain('ico none');
 // An older response without the authoritative table retains its local-name sprite contract.
 expect(iconFor({})('Shark')).not.toContain('ico none');
});
