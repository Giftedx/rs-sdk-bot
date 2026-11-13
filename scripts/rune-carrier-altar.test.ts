import {beforeAll,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {RUNE_CARRIER_ALTARS,UNSUPPORTED_CARRIER_ALTARS,BODY_CARRIER_ALTAR,carrierAltar,runesPerEssence,carrierXpPerEssence,insideCarrierAltar} from './rune-carrier-altar';
import {RUNE_ALTARS} from './rune-bank-craft';
import {runeCarrierRoster,runeCarrierStaged} from './rune-carrier-roster';
import {loadPathfinding} from '../packages/core/src/pathcache';
import {initPathfinding} from '../vendor/rs-sdk/sdk/pathfinding';
import * as rsmod from '../vendor/rs-sdk/server/vendor/rsmod-pathfinder';
import {CollisionType} from '../vendor/rs-sdk/server/vendor/rsmod-pathfinder';

const root=resolve(import.meta.dir,'..'),content=join(root,'vendor/rs-sdk/server/content');
const read=(path:string)=>readFileSync(join(content,path),'utf8');
// pack/<type>.pack lines are `<id>=<name>`.
const pack=(type:string)=>new Map(read(`pack/${type}.pack`).split(/\r?\n/).map(l=>l.split('=')).filter(p=>p.length===2).map(([id,name])=>[name!,Number(id)]));
// runecraft.dbrow: `[runecraft_<name>]` then `data=<column>,<values>` lines; a column can repeat (enter_coord).
function dbrows(){
 const rows=new Map<string,Map<string,string[]>>();let current:Map<string,string[]>|undefined;
 for(const line of read('scripts/skill_runecraft/configs/runecraft.dbrow').split(/\r?\n/)){
  const head=/^\[runecraft_(\w+)\]$/.exec(line);if(head){current=new Map();rows.set(head[1]!,current);continue;}
  const data=/^data=(\w+),(.*)$/.exec(line);if(data&&current&&!current.has(data[1]!))current.set(data[1]!,[data[2]!]);
 }
 return rows;
}
// A coord is level_squareX_squareZ_localX_localZ.
const coord=(text:string)=>{const [level,mx,mz,lx,lz]=text.split(',')[0]!.split('_').map(Number);return {level:level!,x:mx!*64+lx!,z:mz!*64+lz!};};
// maps/m<x>_<z>.jm2 LOC lines are `<level> <localX> <localZ>: <id> <shape> [angle]`.
function placements(id:number,x:number,z:number){
 const square=`m${Math.floor(x/64)}_${Math.floor(z/64)}`,out:{x:number;z:number;shape:number}[]=[];
 for(const line of read(`maps/${square}.jm2`).split(/\r?\n/)){
  const m=/^0 (\d+) (\d+): (\d+) (\d+)/.exec(line);
  if(m&&Number(m[3])===id)out.push({x:Math.floor(x/64)*64+Number(m[1]),z:Math.floor(z/64)*64+Number(m[2]),shape:Number(m[4])});
 }
 return out;
}

test('every runecraft.dbrow row is a carrier altar or an unsupported altar with a reason',()=>{
 const names=[...dbrows().keys()].sort(),listed=[...RUNE_CARRIER_ALTARS.map(a=>a.name),...UNSUPPORTED_CARRIER_ALTARS.map(a=>a.name)].sort();
 expect(listed).toEqual(names);
 expect(RUNE_CARRIER_ALTARS.map(a=>a.name as string).sort()).toEqual(RUNE_ALTARS.map(a=>a.name).sort());
 for(const u of UNSUPPORTED_CARRIER_ALTARS)expect(u.reason.length).toBeGreaterThan(20);
 expect(()=>carrierAltar('law')).toThrow('Entrana');
});

test('each carrier altar row matches runecraft.dbrow, the obj and loc packs, the maps and RUNE_ALTARS',()=>{
 const rows=dbrows(),objs=pack('obj'),locs=pack('loc');
 for(const a of RUNE_CARRIER_ALTARS){
  const r=rows.get(a.name)!,field=(c:string)=>r.get(c)?.[0];
  expect({name:a.name,members:Number(field('members')),level:Number(field('level')),xpTenths:Number(field('experience')),rune:objs.get(field('rune')!),
   talisman:objs.get(field('talisman')!),multiplier:field('multiplier')===undefined?null:Number(field('multiplier')),enter:coord(field('enter_coord')!)})
   .toEqual({name:a.name,members:0,level:a.level,xpTenths:a.xpTenths,rune:a.rune,talisman:a.talisman,multiplier:a.multiplier,enter:{level:0,...a.enter}});
  expect(locs.get(`${a.name}_altar`)).toBe(a.altar.id);
  expect(placements(a.altar.id,a.enter.x,a.enter.z)).toEqual([{x:a.altar.x,z:a.altar.z,shape:10}]);
  const legacy=RUNE_ALTARS.find(r=>r.name===a.name)!;
  expect({level:legacy.level,xp:legacy.xp*10,rune:legacy.rune,talisman:legacy.talisman,inside:{x:legacy.inside.x,z:legacy.inside.z}})
   .toEqual({level:a.level,xp:a.xpTenths,rune:a.rune,talisman:a.talisman,inside:a.enter});
 }
});

test('the carriers bank is the travel cache nearest bank of the ruins',()=>{
 const travel=JSON.parse(readFileSync(join(root,'packages/planner/src/haggis-travel.json'),'utf8'));
 for(const a of RUNE_CARRIER_ALTARS){
  const near=travel.nearestBank[`${a.name}-ruins`],site=travel.banks[near.bank];
  expect({site:near.bank,x:site.x,z:site.z}).toEqual({site:a.bank.site,x:a.bank.x,z:a.bank.z});
 }
});

test('body keeps the pipeline numbers it was built with',()=>{
 expect(BODY_CARRIER_ALTAR).toMatchObject({rune:559,talisman:1446,altar:{id:2483},bank:{x:3094,z:3491},crafter:{x:2523,z:4832},staging:{x:2523,z:4833}});
 for(const level of [20,45,46,91,92,99])expect(runesPerEssence(BODY_CARRIER_ALTAR,level)).toBe(Math.floor(level/46)+1);
 expect(carrierXpPerEssence(BODY_CARRIER_ALTAR,25)).toBe(25*7.5);
 expect(insideCarrierAltar(BODY_CARRIER_ALTAR,{worldX:2523,worldZ:4833,level:0})).toBe(true);
 expect(insideCarrierAltar(BODY_CARRIER_ALTAR,{worldX:3053,worldZ:3445,level:0})).toBe(false);
});

test('air multiples and XP follow runecraft.rs2: two runes from 11, three from 22',()=>{
 const air=carrierAltar('air');
 expect([1,10,11,21,22,44].map(l=>runesPerEssence(air,l))).toEqual([1,1,2,2,3,5]);
 expect(carrierXpPerEssence(air,25)).toBe(125);
 expect(insideCarrierAltar(air,{worldX:2842,worldZ:4834,level:0})).toBe(true);
});

test('the staged mode names one altar and a target level after the roster',()=>{
 const names=['Runner','CarrierB','CarrierC'];
 expect(runeCarrierRoster([...names,'--staged=air:44'])).toEqual(names);
 expect(runeCarrierStaged('--staged=fire:30')).toEqual({altar:'fire',target:30});
 expect(runeCarrierStaged('--carriers')).toBeUndefined();
 for(const mode of ['--staged=air','--staged=air:1','--staged=air:100','--staged=Air:44','--staged=air:044'])expect(()=>runeCarrierRoster([...names,mode])).toThrow();
 expect(()=>runeCarrierRoster([...names,'--carriers','--staged=air:44'])).toThrow();
});

beforeAll(async()=>{await loadPathfinding();},120_000);
test('the crafter and staging tiles are walkable and reachable from the entry tile',()=>{
 initPathfinding();
 const DIRS=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]] as const;
 for(const a of RUNE_CARRIER_ALTARS){
  const key=(x:number,z:number)=>x+','+z,seen=new Set([key(a.enter.x,a.enter.z)]),queue:[number,number][]=[[a.enter.x,a.enter.z]];
  while(queue.length){const [x,z]=queue.shift()!;for(const [dx,dz] of DIRS){const nx=x+dx,nz=z+dz;
   if(Math.abs(nx-a.altar.x)>15||Math.abs(nz-a.altar.z)>20||seen.has(key(nx,nz))||!rsmod.canTravel(0,x,z,dx,dz,1,0,CollisionType.NORMAL))continue;seen.add(key(nx,nz));queue.push([nx,nz]);}}
  // The 3x3 altar blocks its own tiles, so a search that walks into it reads no collision.
  expect({altar:a.name,crafter:seen.has(key(a.crafter.x,a.crafter.z)),staging:seen.has(key(a.staging.x,a.staging.z)),centre:seen.has(key(a.altar.x+1,a.altar.z+1))})
   .toEqual({altar:a.name,crafter:true,staging:true,centre:false});
 }
},60_000);
