import {readFileSync,statSync,writeFileSync} from 'node:fs';
const root='F:/dev-on-f/osrs-rs-research/rs-sdk-bot';
const pf=await import(root+'/vendor/rs-sdk/sdk/pathfinding.ts');
const rsmod:any=await import(root+'/vendor/rs-sdk/server/vendor/rsmod-pathfinder/rsmod-pathfinder.js');
const world=await import(root+'/packages/core/src/world.ts');
const {expandPath}=await import(root+'/packages/core/src/walk.ts');
let restored=false;
try {const buf=readFileSync(root+'/.practice/cache/rsmod-pathfinding.snap');const headLen=buf.readUInt32LE(0),snap=buf.subarray(4+headLen);const w=statSync(root+'/vendor/rs-sdk/server/vendor/rsmod-pathfinder/rsmod_bg.wasm'),d=statSync(root+'/vendor/rs-sdk/sdk/collision-data.json');const key=JSON.stringify({v:1,wasm:[w.size,Math.floor(w.mtimeMs)],data:[d.size,Math.floor(d.mtimeMs)]});if(buf.subarray(4,4+headLen).toString()===`${key}:${snap.length}`){const mem=rsmod.__wasm.memory;const need=Math.ceil(snap.length/65536)-mem.buffer.byteLength/65536;if(need>0)mem.grow(need);new Uint8Array(mem.buffer).set(snap);restored=true;}}catch{}
const t0=performance.now();pf.initPathfinding();console.log('INIT '+JSON.stringify({restored,ms:performance.now()-t0}));
const acct={skills:{mining:31},items:['bronze_pickaxe','bread','shrimps'],varps:{}};
const mine={x:3283,z:3366,level:0},west={x:3268,z:3368,level:0},bank={x:3253,z:3420,level:0};
const south={x:3283,z:3358,level:0},eastSouth={x:3302,z:3358,level:0},eastNorth={x:3302,z:3395,level:0};
const legs=[['direct',mine,bank],['mine-west',mine,west],['west-bank',west,bank],['mine-south',mine,south],['south-east',south,eastSouth],['east-north',eastSouth,eastNorth],['east-bank',eastNorth,bank],['bank-east',bank,eastNorth],['north-south',eastNorth,eastSouth],['east-south-west',eastSouth,south],['south-mine',south,mine]] as const;
const rows=[];
for(const [leg,from,to] of legs){
 const blocked=world.blockedDoorsNear(from,to,acct).map((x:{level:number;x:number;z:number})=>pf.getDoorAt(x.level,x.x,x.z)).filter(Boolean);
 const corners=pf.findLongPath(0,from.x,from.z,to.x,to.z,500,blocked),tiles=expandPath(from,corners);
 const minRatDistance=Math.min(...tiles.map((p:{x:number;z:number})=>Math.max(Math.abs(p.x-3289),Math.abs(p.z-3374))));
 const row={leg,from,to,corners,tiles,minRatDistance,minWizardDistance:Math.min(...tiles.map((p:{x:number;z:number})=>Math.max(Math.max(3223-p.x,0,p.x-3232),Math.max(3363-p.z,0,p.z-3374)))),maxX:Math.max(...tiles.map((p:{x:number;z:number})=>p.x)),end:corners.at(-1)};rows.push(row);
 console.log('PATH '+JSON.stringify({...row,tiles:tiles.length,corners:corners.length}));
}
writeFileSync(root+'/.practice/fleet-proof/ore-west-path-probe.json',JSON.stringify({restored,ratObservedTile:{x:3289,z:3374},rows},null,2));
