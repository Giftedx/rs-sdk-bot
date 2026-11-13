// Finite at-site native ore mining. Existing gather-ore/gather-essence own bank routes.
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseConfigs} from '../packages/knowledge/src/config';
import {openBot,finish} from '../packages/core/src/bot';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import type {BotWorldState,NearbyLoc} from '../vendor/rs-sdk/sdk/types';
import {componentId} from '../packages/core/src/logout';
import {runRotationMining,siteTiles,MINING_SITES,type MiningAction,type RotationOptions} from './mining-rotation';
const content=resolve(import.meta.dir,'../vendor/rs-sdk/server/content');
const pack=(kind:string)=>new Map(readFileSync(resolve(content,'pack',kind+'.pack'),'utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(.+)$/);return m?[[m[2]!,Number(m[1])] as const]:[];}));
const obj=pack('obj'),loc=pack('loc'),item=(name:string)=>{const n=obj.get(name);if(n===undefined)throw Error('native mining item missing '+name);return n;};
const configs=(file:string)=>parseConfigs(readFileSync(resolve(content,file),'utf8'),file);
export interface MiningProfile{name:string;rocks:number[];products:number[];level:number;respawn:number;gemRock:boolean;perfect:boolean;essence:boolean;excludedRocks:string[]}
let cachedMiningProfiles:MiningProfile[]|undefined;
export function miningProfiles():MiningProfile[]{
 if(cachedMiningProfiles)return cachedMiningProfiles;
 const gems=configs('scripts/skill_mining/configs/gem_rock_table.dbrow').flatMap(b=>(b.props.data??[]).filter(v=>v.startsWith('drop,')).map(v=>item(v.split(',')[1]!)));
 const profiles=configs('scripts/skill_mining/configs/mine.dbrow').map(b=>{
  const rows=b.props.data??[],one=(key:string)=>rows.find(v=>v.startsWith(key+','))?.slice(key.length+1),names=rows.filter(v=>v.startsWith('rock,')).map(v=>v.slice(5)),gemRock=b.name==='gem_rock';
  const excludedRocks=names.filter(n=>n.startsWith('macro_')||n==='misc_dummy_coalrock1');
  const rocks=names.filter(n=>!excludedRocks.includes(n)).map(n=>{const value=loc.get(n);if(value===undefined)throw Error('native mining rock missing '+n);return value;});
  return{name:b.name,rocks,products:gemRock?gems:[item(one('rock_output')!)],level:Number(one('rock_level')),respawn:Number(one('rock_respawnrate')??0),gemRock,perfect:false,essence:b.name==='rune_essence_table',excludedRocks};
 });
 const gold=profiles.find(p=>p.name==='gold_rock_table')!;profiles.push({...gold,name:'perfect_gold_rock_table',products:[item('perfect_gold_ore')],perfect:true});
 cachedMiningProfiles=profiles;
 return cachedMiningProfiles;
}
export const incidentalMiningGems=['uncut_diamond','uncut_ruby','uncut_emerald','uncut_sapphire'].map(item);
const pickaxes=configs('scripts/skill_mining/configs/pickaxes.obj').filter(b=>/^(bronze|iron|steel|mithril|adamant|rune)_pickaxe$/.test(b.name)).map(b=>({id:item(b.name),level:Number((b.props.param??[]).find(v=>v.startsWith('levelrequire,'))?.split(',')[1]),rate:Number((b.props.param??[]).find(v=>v.startsWith('mining_rate,'))?.split(',')[1])}));
export function eligiblePickaxe(s:{skills:readonly{name:string;level:number}[];inventory:readonly{id:number}[];equipment:readonly{id:number;slot:number}[]}){
 const level=s.skills.find(k=>k.name==='Mining')?.level??0;
 return pickaxes.filter(p=>level>=p.level&&(s.inventory.some(i=>i.id===p.id)||s.equipment.some(i=>i.id===p.id&&i.slot===3))).sort((a,b)=>a.rate-b.rate)[0];
}
export function inPerfectMine(s:BotWorldState){const p=s.player;return !!p&&p.level===0&&p.worldX>=2736&&p.worldX<=2740&&p.worldZ>=9684&&p.worldZ<=9693;}
export function selectMiningRock(s:BotWorldState,p:MiningProfile):NearbyLoc|undefined{
 return s.nearbyLocs.filter(l=>p.rocks.includes(l.id)&&l.level===s.player?.level&&l.distance<=2&&l.reachable!==false&&l.optionsWithIndex.some(o=>o.opIndex===1&&/^mine$/i.test(o.text))&&!s.nearbyPlayers.some(other=>Math.max(Math.abs(other.x-l.x),Math.abs(other.z-l.z))<=2)).sort((a,b)=>a.distance-b.distance)[0];
}
const xp=(s:BotWorldState)=>s.skills.find(k=>k.name==='Mining')?.experience??0;
const hp=(s:BotWorldState)=>s.skills.find(k=>k.name==='Hitpoints')?.level??0;
const stock=(s:BotWorldState)=>{const result:Record<number,number>={};for(const i of s.inventory)result[i.id]=(result[i.id]??0)+i.count;return result;};
export function miningEffect(p:MiningProfile,b:BotWorldState,a:BotWorldState):{kind:'ore'|'incidental';id:number}|null{
 const before=stock(b),after=stock(a),keys=new Set([...Object.keys(before),...Object.keys(after)].map(Number)),deltas=[...keys].map(id=>({id,n:(after[id]??0)-(before[id]??0)})).filter(v=>v.n!==0);
 if(!deltas.length)return null;
 if(deltas.length!==1||deltas[0]!.n!==1)throw Error('mining inventory effect does not reconcile');const id=deltas[0]!.id;
 if(p.products.includes(id)&&xp(a)>xp(b))return{kind:'ore',id};
 if(p.products.includes(id)&&xp(a)===xp(b))return null;
 if(!p.gemRock&&!p.essence&&incidentalMiningGems.includes(id)&&xp(a)===xp(b))return{kind:'incidental',id};
 throw Error('mining ore/gem and XP do not reconcile');
}
export interface MiningDriver{state:()=>BotWorldState|null;tick:()=>number;stop:()=>boolean;mine:(l:NearbyLoc)=>Promise<boolean>;wait:(test:()=>boolean,ticks:number)=>Promise<boolean>;step:()=>Promise<void>;clearModal?:()=>Promise<void>;send?:(actions:readonly MiningAction[])=>Promise<void>}
// `rotation` keeps the rock rotation and, with `knife`, the knife reset (scripts/mining-rotation.ts).
export async function runAtSiteMining(d:MiningDriver,p:MiningProfile,o:{maximum:number;cap:number;idleTicks:number;rotation?:Omit<RotationOptions,'maximum'|'cap'|'idleTicks'>}){
 if(![o.maximum,o.cap,o.idleTicks].every(n=>Number.isSafeInteger(n)&&n>0))throw Error('invalid mining bounds');
 if(p.essence)throw Error('reuse scripts/gather-essence.ts for continuous essence mining');
 const initial=d.state();if(!initial?.player||hp(initial)<1)throw Error('mining state unknown');
 if((initial.skills.find(k=>k.name==='Mining')?.level??0)<p.level)throw Error('native mining level short');
 if(!eligiblePickaxe(initial))throw Error('native eligible owned pickaxe required');
 if(p.perfect!==inPerfectMine(initial)&&p.rocks.some(id=>miningProfiles().find(r=>r.name==='gold_rock_table')!.rocks.includes(id)))throw Error('gold output differs inside Family Crest perfect mine; select exact profile');
 if(o.rotation)return runRotationMining(d,p,{...o.rotation,maximum:o.maximum,cap:o.cap,idleTicks:o.idleTicks},eligiblePickaxe(initial)!.rate,incidentalMiningGems);
 const start=d.tick();let progress=start,made=0,attempts=0,sideGems=0,active:string|undefined;const outputs:Record<number,number>={};
 const equipment=JSON.stringify(initial.equipment.map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot));
 const state=()=>{const s=d.state();if(!s?.player)throw Error('mining session ended');if(d.stop())throw Error('mining stopped');if(d.tick()-start>=o.cap)throw Error('mining tick cap');if(s.player.isDead||s.player.lifeId!==initial.player!.lifeId||s.player.level!==initial.player!.level||hp(s)!==hp(initial))throw Error('mining health or life changed');if(JSON.stringify(s.equipment.map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot))!==equipment||!eligiblePickaxe(s))throw Error('mining owned pickaxe/equipment changed');return s;};
 while(made<o.maximum){
  let before=state();if(d.tick()-progress>=o.idleTicks)throw Error('mining no useful ore progress');if(before.inventory.length>=28)throw Error('mining pack full; retain ore for owned bank route');
  if(before.dialog?.isOpen||before.interface?.isOpen){if(!d.clearModal)throw Error('mining modal blocks action');await d.clearModal();active=undefined;before=state();}
  const target=selectMiningRock(before,p);if(!target){active=undefined;await d.step();continue;}
  const key=`${target.id}:${target.x}:${target.z}:${target.level}`;
  if(active!==key){if(!await d.mine(target))throw Error('native Mine option refused');attempts++;active=key;}
  let effect:ReturnType<typeof miningEffect>=null;
  await d.wait(()=>{const s=state();effect=miningEffect(p,before,s);return !!effect||!s.nearbyLocs.some(l=>l.id===target.id&&l.x===target.x&&l.z===target.z&&l.level===target.level);},Math.min(40,o.idleTicks-(d.tick()-progress),o.cap-(d.tick()-start)));
  let after=state();effect=miningEffect(p,before,after);
  if(!effect&&!after.nearbyLocs.some(l=>l.id===target.id&&l.x===target.x&&l.z===target.z&&l.level===target.level)){await d.step();after=state();effect=miningEffect(p,before,after);}
  if(!effect&&(JSON.stringify(stock(before))!==JSON.stringify(stock(after))||xp(after)!==xp(before)))throw Error('mining item/XP publication did not settle');
  if(effect){outputs[effect.id]=(outputs[effect.id]??0)+1;if(effect.kind==='ore'){made++;progress=d.tick();active=undefined;}else sideGems++;}
  if(!after.nearbyLocs.some(l=>l.id===target.id&&l.x===target.x&&l.z===target.z&&l.level===target.level))active=undefined;
  if(made<o.maximum)await d.step();
 }
 return{made,sideGems,attempts,outputs,xp:xp(state())-xp(initial),ticks:d.tick()-start,banked:0};
}
if(import.meta.main){
 const name=process.argv[2],profile=miningProfiles().find(p=>p.name===process.argv[3]),maximum=Number(process.argv[4]??1),cap=Number(process.argv[5]??2000);if(!name||!profile)throw Error('account and native mining table profile required');
 const s=await openBot(name).catch(e=>finish([],false,`login: ${String(e)}`));let ended=false;void s.ended.then(()=>{ended=true;});
 // MINING_ROTATE=1: rock rotation over the site (MINING_SITE=<key of MINING_SITES>, or the rocks within 3 tiles);
 // MINING_KNIFE=1 adds the knife reset, MINING_DROP=1 drops each ore. s.direct sends the actions of one tick together.
 const env=process.env,site=MINING_SITES.find(t=>t.key===env.MINING_SITE);if(env.MINING_SITE&&!site)throw Error('unknown MINING_SITE '+env.MINING_SITE);
 const rotation=env.MINING_ROTATE==='1'||env.MINING_KNIFE==='1'?{knife:env.MINING_KNIFE==='1',drop:env.MINING_DROP==='1',make1:componentId('skill_multi3:make1_a'),players:Number(env.MINING_PLAYERS??1),rocks:site?siteTiles(profile,site):undefined,keep:(env.MINING_KEEP??'').split(',').filter(Boolean).map(Number),pick:env.MINING_PICK==='nearest'||env.MINING_PICK==='roll'?env.MINING_PICK as 'nearest'|'roll':undefined}:undefined;
 try{const r=await runAtSiteMining({state:()=>s.sdk.getState(),tick:()=>s.tick(),stop:()=>ended||existsSync(`.practice/stop-${name}`)||existsSync('.practice/stop-all'),mine:async l=>(await s.sdk.sendInteractLoc(l.x,l.z,l.id,1)).success,wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1),clearModal:async()=>{await s.sdk.sendCloseModal();},send:async acts=>{for(const a of acts)await s.direct({...a,reason:'SDK'});}},profile,{maximum,cap,idleTicks:Number(process.env.IDLE_TICKS??1200),rotation});
  // Ticks per ore from the first ore to the last, so the walk and the login are not in it.
  const rolls=(r as {rolls?:number[]}).rolls;if(rolls&&rolls.length>1){const per=(rolls.at(-1)!-rolls[0]!)/(rolls.length-1);console.log(`MINING_RATE ores=${r.made} ticksPerOre=${per.toFixed(2)} xpPerTick=${(r.xp/r.made/per).toFixed(1)} runTicks=${r.ticks} runXpPerTick=${(r.xp/r.ticks).toFixed(1)}`);}
  await finish([s],true,JSON.stringify(r));}catch(e){await finish([s],false,String(e));}
}
