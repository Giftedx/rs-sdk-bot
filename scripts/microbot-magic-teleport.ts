// Behaviour source: pinned Microbot-Hub; BSD notice: research/microbot-ports-LICENSE.txt.
// Seven pinned standard teleports, finite staged batches: bun scripts/microbot-magic-teleport.ts <account> <destination> [casts=1] [cap=1200].
// MEMBERS=1 scopes member-spell expectations; native server requirements and quest/scroll checks still decide acceptance.
// COMBO_ALCH=high-alch|low-alch and ALCH_ITEM=debugname insert one observed item conversion after each teleport.
import {readFileSync,existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {componentId} from '../packages/core/src/logout';
import {objId} from './measure/floor-bands';
import {elementalRuneCost,itemMagicRecipe,runItemMagic,type Recipe} from './microbot-magic-items';
export interface NativeTeleport{name:string;component:string;level:number;members:boolean;runes:Record<number,number>;to:{x:number;z:number;level:number}}
export function nativeTeleport(name:string):NativeTeleport{
 if(!/^(varrock|lumbridge|falador|camelot|ardougne|watchtower|trollheim)$/.test(name))throw Error('unsupported native teleport');
 const text=readFileSync('vendor/rs-sdk/server/content/scripts/skill_magic/configs/magic_spells.dbrow','utf8'),body=text.split('[magic_spell_teleport_'+name+']')[1]?.split('\n[')[0];if(!body)throw Error('native teleport missing');
 const field=(key:string)=>body.match(new RegExp('^data='+key+',(.+)$','m'))?.[1]?.trim(),parts=field('runesrequired')!.split(','),runes:Record<number,number>={};
 for(let i=0;i<parts.length;i+=2)if(parts[i]!=='null')runes[objId(parts[i]!)]=Number(parts[i+1]);
 const [level,mx,mz,lx,lz]=field('tele_coord')!.split('_').map(Number);
 return{name,component:'magic:'+name+'_teleport',level:Number(field('levelrequired')),members:field('members')==='true',runes,to:{x:mx!*64+lx!,z:mz!*64+lz!,level:level!}};
}
export function teleportReceipt(t:NativeTeleport,costs:Record<number,number>,b:Record<number,number>,a:Record<number,number>,xp0:number,xp1:number,p:{worldX:number;worldZ:number;level:number}|null|undefined){
 const keys=new Set([...Object.keys(b),...Object.keys(a),...Object.keys(costs)]);
 return xp1>xp0&&[...keys].every(k=>(b[Number(k)]??0)-(a[Number(k)]??0)===(costs[Number(k)]??0))&&!!p&&p.level===t.to.level&&Math.max(Math.abs(p.worldX-t.to.x),Math.abs(p.worldZ-t.to.z))<=2;
}
export async function runTeleportMagic(s:Session,t:NativeTeleport,o:{casts:number;cap:number;members?:boolean;combo?:Recipe;stop?:()=>boolean}){
 if(!Number.isSafeInteger(o.casts)||o.casts<1||o.casts>1000||!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>100000)throw Error('invalid finite teleport limits');
 if(t.members&&!o.members)throw Error('member teleport requires explicit member batch scope');
 const st=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),xp=()=>s.sdk.getSkillXp('Magic')??0,hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
 const counts=()=>{const r:Record<number,number>={};for(const i of inv())r[i.id]=(r[i.id]??0)+i.count;return r;};
 const p0=st()?.player,hp0=hp();if(!p0||hp0<10||(s.sdk.getSkill('Magic')?.level??0)<t.level)throw Error('teleport entry player/level unknown');
 let ended=false,casts=0,combos=0,failure='',stop='target';void s.ended.then(()=>{ended=true;});const start=s.tick(),xp0=xp();
 const over=()=>ended||!!o.stop?.()||s.tick()-start>=o.cap||!st()?.player||st()?.player?.lifeId!==p0.lifeId||hp()<hp0;
 const rest=async(n:number)=>{for(let i=0;i<n&&!over();i++)await waitTicks(s,1);};
 try{
 while(casts<o.casts&&!over()){
  await s.bot.dismissBlockingUI();if(over())break;
  const costs=Object.fromEntries(Object.entries(t.runes).map(([id,n])=>[id,elementalRuneCost(Number(id),n,s.sdk.getEquipment(),o.members??false)])) as Record<number,number>;
  const b=counts(),x0=xp();if(Object.entries(costs).some(([id,n])=>(b[Number(id)]??0)<n)){stop='runes';break;}
  const reply=await s.direct({type:'clickComponent',componentId:componentId(t.component),reason:'SDK'}) as {success?:boolean};if(reply?.success===false)throw Error('teleport dispatch refused');
  await waitUntil(s,()=>over()||teleportReceipt(t,costs,b,counts(),x0,xp(),st()?.player),{timeoutTicks:Math.min(15,Math.max(1,o.cap-(s.tick()-start)))});
  if(!teleportReceipt(t,costs,b,counts(),x0,xp(),st()?.player))throw Error('teleport rune/XP/destination effect missing; check native quest, scroll and member requirements');casts++;await rest(6);
  if(o.combo&&!over()){const r=await runItemMagic(s,o.combo,{count:1,cap:Math.max(1,o.cap-(s.tick()-start)),members:o.members,stop:over});if(!r.ok)throw Error('teleport alch combo '+r.stop);combos++;await rest(6);}
  console.log('TELEPORT_MAGIC_CAST '+JSON.stringify({casts,combos,destination:t.name,tick:s.tick()}));
 }
 if(casts!==o.casts&&stop==='target')stop='stopped/cap';
 }catch(e){failure=String(e);stop='failure';}
 return{ok:!failure&&!over()&&casts===o.casts&&(!o.combo||combos===casts),stop,failure,casts,combos,magicXp:xp()-xp0,ticks:s.tick()-start};
}
if(import.meta.main){let s:Session|undefined,stopped=false;try{const [account,name,casts,cap]=process.argv.slice(2);if(!account||!name)throw Error('account and native destination required');const t=nativeTeleport(name),combo=process.env.COMBO_ALCH?itemMagicRecipe(process.env.COMBO_ALCH,process.env.ALCH_ITEM):undefined;s=await openBot(account,{onStop:async()=>{stopped=true;}});const r=await runTeleportMagic(s,t,{casts:Number(casts??1),cap:Number(cap??1200),members:process.env.MEMBERS==='1',combo,stop:()=>stopped||existsSync('.practice/stop-microbot-magic')});console.log('TELEPORT_MAGIC_RESULT '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));}catch(e){await finish(s?[s]:[],false,String(e));}}
