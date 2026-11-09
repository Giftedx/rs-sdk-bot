// Build the local item sheet from the installed game's config and models.
// Usage: bun packages/dashboard/tools/export-item-icons.ts
import '../../../vendor/rs-sdk/server/webclient/src/lite/dom-shim';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';

const {ItemViewer}=await import('../../../vendor/rs-sdk/server/webclient/src/viewer/ItemViewer');
const {default:ObjType}=await import('../../../vendor/rs-sdk/server/webclient/src/config/ObjType');
const pack=resolve(import.meta.dir,'../../../vendor/rs-sdk/server/engine/data/pack');
const viewer=new ItemViewer();
viewer.initFromData({config:readFileSync(pack+'/client/config'),textures:readFileSync(pack+'/client/textures'),versionlist:readFileSync(pack+'/client/versionlist'),ondemand:readFileSync(pack+'/ondemand.zip')},{lazyModels:true});
const count=ObjType.numDefinitions,width=2048,height=Math.ceil(count/64)*32,stride=width*4+1,rows=Buffer.alloc(height*stride);
const names:Record<string,number>={},missing:number[]=[];
for(let id=0;id<count;id++){
 const definition=ObjType.list(id),name=definition.name?.toLowerCase();
 if(name&&name!=='null'&&names[name]===undefined)names[name]=id;
 const sprite=viewer.renderItemIcon(id);
 if(!sprite){if(name&&name!=='null')missing.push(id);continue;}
 for(let y=0;y<32;y++)for(let x=0;x<32;x++){
  const pixel=sprite.data[y*32+x];if(!pixel)continue;
  const offset=(Math.floor(id/64)*32+y)*stride+1+((id%64)*32+x)*4;
  rows[offset]=(pixel>>>16)&255;rows[offset+1]=(pixel>>>8)&255;rows[offset+2]=pixel&255;rows[offset+3]=255;
 }
}
if(missing.length)throw Error('Named items without sprites: '+missing.join(','));
// The map exporter uses the same filter-0 PNG layout; these rows carry alpha.
const crcTable=new Int32Array(256).map((_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c;});
const crc=(bytes:Buffer)=>{let c=-1;for(const b of bytes)c=crcTable[(c^b)&255]!^(c>>>8);return(c^-1)>>>0;};
const chunk=(type:string,data:Buffer)=>{const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type),data]),sum=Buffer.alloc(4);sum.writeUInt32BE(crc(body));return Buffer.concat([length,body,sum]);};
const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows,{level:9})),chunk('IEND',Buffer.alloc(0))]);
const out=resolve(import.meta.dir,'..'),page=out+'/index.html';
const html=readFileSync(page,'utf8');
const generated=`const ITEM_SPRITE_COUNT=${count};const LOCAL_ITEMS=${JSON.stringify(names)};`;
if(!/(?:const ITEM_SPRITE_COUNT=\d+;)?const LOCAL_ITEMS=\{[^\r\n]+\};/.test(html))throw Error('Local item table not found');
writeFileSync(out+'/items.png',png);writeFileSync(out+'/items.json',JSON.stringify(names));
const hash=createHash('sha256').update(png).digest('hex');
writeFileSync(page,html.replace(/(?:const ITEM_SPRITE_COUNT=\d+;)?const LOCAL_ITEMS=\{[^\r\n]+\};/,()=>generated).replace(/\/items\.png(?:\?v=[a-f0-9]+)?/g,'/items.png?v='+hash));
console.log(JSON.stringify({count,names:Object.keys(names).length,width,height,bytes:png.length}));
