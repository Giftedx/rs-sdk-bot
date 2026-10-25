import {readFileSync,statSync,writeFileSync} from 'node:fs';
const root='F:/dev-on-f/osrs-rs-research/rs-sdk-bot';
const pf=await import(root+'/vendor/rs-sdk/sdk/pathfinding.ts');
const rsmod:any=await import(root+'/vendor/rs-sdk/server/vendor/rsmod-pathfinder/rsmod-pathfinder.js');
const world=await import(root+'/packages/core/src/world.ts');
const {expandPath}=await import(root+'/packages/core/src/walk.ts');
let restored=false;
try {const buf=readFileSync(root+'/.practice/cache/rsmod-pathfinding.snap');const headLen=buf.readUInt32LE(0),snap=buf.subarray(4+headLen);const w=statSync(root+'/vendor/rs-sdk/server/vendor/rsmod-pathfinder/rsmod_bg.wasm'),d=statSync(root+'/vendor/rs-sdk/sdk/collision-data.json');const key=JSON.stringify({v:1,wasm:[w.size,Math.floor(w.mtimeMs)],data:[d.size,Math.floor(d.mtimeMs)]});if(buf.subarray(4,4+headLen).toString()===`${key}:${snap.length}`){const mem=rsmod.__wasm.memory;const need=Math.ceil(snap.length/65536)-mem.buffer.byteLength/65536;if(need>0)mem.grow(need);new Uint8Array(mem.buffer).set(snap);restored=true;}}catch{}
const t0=performance.now();pf.initPathfinding();console.log('INIT '+JSON.stringify({restored,ms:performance.now()-t0}));
const acct={skills:{attack:1,strength:1,defence:1},items:['bronze_sword','wooden_shield','trout'],varps:{}};
const bank={x:2655,z:3283,level:0},pen={x:2664,z:3344,level:0},nw={x:2648,z:3358,level:0},ne={x:2677,z:3358,level:0};
const legs=[['direct-out',bank,pen],['direct-return',pen,bank],['bank-nw',bank,nw],['nw-ne',nw,ne],['ne-pen',ne,pen],['pen-ne',pen,ne],['ne-nw',ne,nw],['nw-bank',nw,bank]] as const;
const bearSpawns=JSON.parse(readFileSync(root+'/knowledge/ubermouse/world.json','utf8')).npcSpawns.filter((n:any)=>/bear/i.test(n.config)&&n.centre.level===0&&n.centre.x>2600&&n.centre.x<2750&&n.centre.z>3250&&n.centre.z<3400).map((n:any)=>n.bbox);
const distance=(p:{x:number;z:number})=>Math.min(...bearSpawns.map((b:any)=>Math.max(Math.max(b.x1-p.x,0,p.x-b.x2),Math.max(b.z1-p.z,0,p.z-b.z2))));
const rows=[];
for(const [leg,from,to] of legs){
 const blocked=world.blockedDoorsNear(from,to,acct).map((x:any)=>pf.getDoorAt(x.level,x.x,x.z)).filter(Boolean);
 const corners=pf.findLongPath(0,from.x,from.z,to.x,to.z,500,blocked),tiles=expandPath(from,corners);
 const minBearDistance=Math.min(...tiles.map(distance));
 const row={leg,from,to,corners,tiles,minBearDistance,end:corners.at(-1)};rows.push(row);console.log('PATH '+JSON.stringify({...row,tiles:tiles.length,corners:corners.length}));
}
const grid=[];
for(let x=2655;x<=2674;x++)for(let z=3339;z<=3356;z++){
 const from={x,z,level:0};const blocked=world.blockedDoorsNear(from,ne,acct).map((x:any)=>pf.getDoorAt(x.level,x.x,x.z)).filter(Boolean);
 const corners=pf.findLongPath(0,x,z,ne.x,ne.z,500,blocked),tiles=expandPath(from,corners),end=corners.at(-1);
 grid.push({from,end,full:!!end&&Math.max(Math.abs(end.x-ne.x),Math.abs(end.z-ne.z))<=1,minBearDistance:tiles.length?Math.min(...tiles.map(distance)):null,tiles:tiles.length});
}
const bad=grid.filter(g=>!g.full||g.minBearDistance===null||g.minBearDistance<=7);
console.log('COW_GRID '+JSON.stringify({cases:grid.length,bad:bad.length,examples:bad.slice(0,5)}));
writeFileSync(root+'/.practice/fleet-proof/cow-path-probe.json',JSON.stringify({restored,bearSpawns,rows,grid},null,2));
