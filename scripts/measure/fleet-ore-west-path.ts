import {writeFileSync} from 'node:fs';
import {loadPathfinding} from '../../packages/core/src/pathcache';
const root='F:/dev-on-f/osrs-rs-research/rs-sdk-bot';
const pf=await import(root+'/vendor/rs-sdk/sdk/pathfinding.ts');
const world=await import(root+'/packages/core/src/world.ts');
const {expandPath}=await import(root+'/packages/core/src/walk.ts');
const cache=await loadPathfinding(),restored=cache.restored;
console.log('INIT '+JSON.stringify({restored,ms:cache.ms,scope:'cache-load-and-init'}));
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
