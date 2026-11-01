import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
const dir=import.meta.dir,html=readFileSync(dir+'/index.html','utf8'),names=JSON.parse(readFileSync(dir+'/items.json','utf8'));

test('the local item sheet contains the final game item IDs with visible artwork',()=>{
 const png=readFileSync(dir+'/items.png'),width=png.readUInt32BE(16),height=png.readUInt32BE(20);
 expect(width).toBe(2048);expect(height).toBeGreaterThanOrEqual(2048);expect(png[25]).toBe(6);
 const data:Buffer[]=[];for(let at=8;at<png.length;){const n=png.readUInt32BE(at);if(png.toString('ascii',at+4,at+8)==='IDAT')data.push(png.subarray(at+8,at+8+n));at+=12+n;}
 const rows=inflateSync(Buffer.concat(data)),stride=width*4+1;
 for(const id of [385,3904,4000,4088]){
  let pixels=0;for(let y=0;y<32;y++)for(let x=0;x<32;x++)pixels+=rows[(Math.floor(id/64)*32+y)*stride+1+((id%64)*32+x)*4+3]!>0?1:0;
  expect(pixels).toBeGreaterThan(0);
 }
 expect(Object.values(names).some(id=>Number(id)>=3904)).toBe(true);
});

test('the client permits local icons throughout the generated item range',()=>{
 const count=Number(html.match(/const ITEM_SPRITE_COUNT=(\d+);/)?.[1]);expect(count).toBeGreaterThan(4088);
 const code=html.slice(html.indexOf('function icon('),html.indexOf('// Stack numbers'));
 const icon=new Function('S','LOCAL_ITEMS','ITEM_SPRITE_COUNT','E',code+';return icon;')({icons:{'Last item':4088}},names,count,String);
 expect(icon('Last item')).not.toContain('ico none');expect(icon('Unknown item')).toContain('ico none');
});
