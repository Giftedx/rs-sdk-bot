// Finite caller-staged native pickpockets. No bank/site routes or automatic task promotion.
// bun scripts/microbot-a-pickpocket.ts <account> <profile> [successes=10] [attempts=40] [cap=2000]
// MEMBERS=1; XP_RATE=25 scopes the expected native XP multiplier; FOOD_ID/FOOD_RESERVE optional whole food.
import {readFileSync,existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {questFoodDefinitions} from './quest-sustain';
import {questFlags} from '../packages/core/src/quest-status';
import {objId} from './measure/floor-bands';
export interface PocketProfile{name:string;npcs:number[];level:number;xp:number;stunTicks:number;damage:number;pocket:string;loot:{id:number;min:number;max:number}[];source:string;line:number}
export function pickpocketProfiles():PocketProfile[]{
 const path='vendor/rs-sdk/server/content/scripts/skill_thieving/configs/pickpocking/pickpocket.dbrow',text=readFileSync(path,'utf8');
 const ids=new Map(readFileSync('vendor/rs-sdk/server/content/pack/npc.pack','utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(\w+)$/);return m?[[m[2]!,Number(m[1])] as const]:[]}));
 const triggers=readFileSync('vendor/rs-sdk/server/content/scripts/skill_thieving/scripts/pickpocketing/pickpocket.rs2','utf8');
 return [...text.matchAll(/^\[pickpocket_([^\]]+)\]\r?\n([^\[]*)/gm)].map(m=>{
  const body=m[2]!,field=(key:string)=>body.match(new RegExp('^data='+key+',(.+)$','m'))?.[1]?.trim();
  const npcs=[...body.matchAll(/^data=npc,(\w+)/gm)].map(n=>{if(!triggers.includes('[opnpc3,'+n[1]+']'))throw Error('native pickpocket trigger missing '+n[1]);const id=ids.get(n[1]!);if(id===undefined)throw Error('native NPC ID missing');return id;});
  const loot=[...body.matchAll(/^data=loot,(\w+),(\d+),(\d+),(\d+)/gm)].map(n=>({id:objId(n[1]!),min:Number(n[2]),max:Number(n[3])}));
  return{name:m[1]!,npcs,level:Number(field('level')),xp:Number(field('experience'))/10,stunTicks:Number(field('stun_ticks')),damage:Number(field('stun_damage')),pocket:field('pocket')!,loot,source:path,line:text.slice(0,m.index).split('\n').length};
 });
}
export interface PocketSnapshot{items:Record<number,number>;xp:number;hp:number}
export function pocketEffect(p:PocketProfile,b:PocketSnapshot,a:PocketSnapshot,event:'success'|'failure'|'none',rate:number){
 const ids=new Set([...Object.keys(b.items),...Object.keys(a.items)].map(Number));
 const unchanged=[...ids].every(id=>(b.items[id]??0)===(a.items[id]??0));
 if(event==='failure')return unchanged&&a.xp===b.xp&&a.hp===b.hp-p.damage?'failure':'invalid';
 if(event==='success'){
  if(a.hp!==b.hp||Math.round((a.xp-b.xp)*10)!==Math.round(p.xp*rate*10))return 'invalid';
  return [...ids].every(id=>{const n=(a.items[id]??0)-(b.items[id]??0),loot=p.loot.find(i=>i.id===id);return loot?(n===0||Number.isSafeInteger(n)&&n>=loot.min&&n<=loot.max):n===0;})?'success':'invalid';
 }
 return unchanged&&a.xp===b.xp&&a.hp===b.hp?'none':'invalid';
}
export interface PocketOptions{successes:number;attempts:number;cap:number;maxNoProgress:number;hpFloor:number;eatAt:number;food:number;foodReserve:number;xpRate:number;members:boolean;stop?:()=>boolean}
export function validatePocketOptions(o:PocketOptions){
 if(![o.successes,o.attempts,o.cap,o.maxNoProgress,o.hpFloor,o.eatAt,o.food,o.foodReserve].every(Number.isSafeInteger)||o.successes<1||o.successes>1000||o.attempts<o.successes||o.attempts>10000||o.cap<1||o.cap>100000||o.maxNoProgress<1||o.maxNoProgress>100||o.hpFloor<1||o.eatAt<o.hpFloor||o.food<0||o.foodReserve<0||!Number.isFinite(o.xpRate)||o.xpRate<=0||o.xpRate>1000)throw Error('invalid finite pickpocket limits');
 if(!o.members)throw Error('native pickpocketing requires member scope');
 if(o.food){const f=questFoodDefinitions().get(o.food);if(!f||f.next!==undefined)throw Error('stage a native whole food with no returned item');}
 return o;
}
export async function runPickpockets(s:Session,p:PocketProfile,o:PocketOptions){
 validatePocketOptions(o);const st=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
 const read=():PocketSnapshot=>{const items:Record<number,number>={};for(const i of inv())items[i.id]=(items[i.id]??0)+i.count;return{items,xp:s.sdk.getSkillXp('Thieving')??0,hp:hp()};};
 const p0=st()?.player;if(!p0||hp()<=o.hpFloor+p.damage||(s.sdk.getSkill('Thieving')?.level??0)<p.level)throw Error('pickpocket entry state/level/health missing');
 if(p.name==='viking'&&!questFlags(s.client)?.some(q=>/fremennik/i.test(q.name)&&q.state==='complete'))throw Error('Fremennik Trials completion unobserved');
 const start=s.tick(),initial=read();let ended=false,successes=0,failures=0,attempts=0,eaten=0,noProgress=0,stop='target',failure='';void s.ended.then(()=>{ended=true;});
 const dead=()=>{const q=st()?.player;return !q||q.isDead||q.lifeId!==p0.lifeId||(q.respawnCount??0)>(p0.respawnCount??0)||hp()<=0;};
 const over=()=>ended||dead()||!!o.stop?.()||!!process.env.STOP_FILE&&existsSync(process.env.STOP_FILE)||s.tick()-start>=o.cap;
 const wait=async(predicate:()=>boolean,n:number)=>await waitUntil(s,()=>over()||predicate(),{timeoutTicks:Math.min(n,Math.max(1,o.cap-(s.tick()-start)))})&&!over()&&predicate();
 const rest=async(n:number)=>{for(let i=0;i<n&&!over();i++)await waitTicks(s,1);};
 const cursor=()=>Math.max(-1,...(st()?.gameMessages??[]).map(m=>m.observationId??m.tick));
 try{
 while(successes<o.successes&&attempts<o.attempts&&!over()){
  const q=st()?.player;if(!q||q.level!==p0.level||Math.max(Math.abs(q.worldX-p0.worldX),Math.abs(q.worldZ-p0.worldZ))>8||q.combat?.inCombat)throw Error('pickpocket site/combat changed');
  if(hp()<=o.eatAt&&o.food&&(read().items[o.food]??0)>o.foodReserve){
   await s.bot.dismissBlockingUI();if(over())break;const item=inv().find(i=>i.id===o.food),b=read(),option=item?.optionsWithIndex.find(v=>/^(eat|drink)$/i.test(v.text));if(!item||!option)throw Error('whole food Eat option absent');
   if(!(await s.sdk.sendUseItem(item.slot,option.opIndex)).success||!await wait(()=>hp()>b.hp&&(read().items[o.food]??0)===(b.items[o.food]??0)-1,8))throw Error('food debit/heal missing');
   const a=read(),keys=new Set([...Object.keys(b.items),...Object.keys(a.items)].map(Number));if([...keys].some(id=>(a.items[id]??0)-(b.items[id]??0)!==(id===o.food?-1:0))||a.xp!==b.xp)throw Error('food changed unrelated assets');eaten++;await rest(3);continue;
  }
  if(hp()<=o.hpFloor+p.damage){stop='health/food';break;}
  // The native reward loop can grant several loot rows in one pocket, including rare nonstackables.
  if(inv().length>28-p.loot.length){stop='inventory space';break;}
  await s.bot.dismissBlockingUI();if(over())break;
  const npc=st()?.nearbyNpcs.filter(n=>p.npcs.includes(n.id)&&n.reachable!==false&&!n.inCombat&&n.distance<=5&&n.optionsWithIndex.some(v=>v.opIndex===3&&/^pick.?pocket$/i.test(v.text))).sort((a,b)=>a.distance-b.distance)[0];if(!npc){stop='target missing';break;}
  const b=read(),c=cursor();attempts++;
  if(!(await s.sdk.sendInteractNpc(npc.index,3)).success)throw Error('pickpocket dispatch refused');
  const event=()=>{const messages=(st()?.gameMessages??[]).filter(m=>(m.observationId??m.tick)>c).map(m=>m.text);const good=messages.includes('You pick the '+p.pocket+'.'),bad=messages.includes('You fail to pick the '+p.pocket+'.');return good&&!bad?'success':bad&&!good?'failure':'none';};
  await wait(()=>event()!=='none',12);const e=event();
  if(e==='failure')await wait(()=>hp()===b.hp-p.damage,5);else if(e==='success')await wait(()=>pocketEffect(p,b,read(),e,o.xpRate)==='success',4);
  const effect=pocketEffect(p,b,read(),e,o.xpRate);
  if(effect==='success'){successes++;noProgress=0;await rest(2);}
  else if(effect==='failure'){failures++;if(++noProgress>=o.maxNoProgress){stop='no useful progress';break;}await rest(p.stunTicks+2);}
  else if(effect==='none'){if(++noProgress>=Math.min(3,o.maxNoProgress)){stop='no effect';break;}await rest(2);}
  else throw Error('pickpocket XP/loot/stun/health receipt mismatch');
  console.log('PICKPOCKET_RECEIPT '+JSON.stringify({profile:p.name,npc:npc.id,effect,successes,failures,attempts,hp:hp(),tick:s.tick()}));
 }
 if(successes!==o.successes&&stop==='target')stop=over()?'stopped/cap':'attempt budget';
 }catch(e){failure=String(e);stop='failure';}
 const final=read(),allowed=new Set([...p.loot.map(i=>i.id),o.food]),all=new Set([...Object.keys(initial.items),...Object.keys(final.items)].map(Number));
 const kitPreserved=[...all].every(id=>allowed.has(id)||(final.items[id]??0)===(initial.items[id]??0));
 const loot=Object.fromEntries(p.loot.map(i=>[i.id,(final.items[i.id]??0)-(initial.items[i.id]??0)+(i.id===o.food?eaten:0)]));
 return{ok:!failure&&!over()&&successes===o.successes&&kitPreserved,profile:p.name,stop,failure,successes,failures,attempts,eaten,hp:hp(),xp:final.xp-initial.xp,loot,kitPreserved,ticks:s.tick()-start};
}
if(import.meta.main){let s:Session|undefined,stopped=false;try{const [account,name,successes,attempts,cap]=process.argv.slice(2);const p=pickpocketProfiles().find(p=>p.name===name);if(!account||!p)throw Error('account and native pickpocket profile required');const o=validatePocketOptions({successes:Number(successes??10),attempts:Number(attempts??40),cap:Number(cap??2000),maxNoProgress:Number(process.env.NO_PROGRESS??10),hpFloor:Number(process.env.HP_FLOOR??10),eatAt:Number(process.env.EAT_AT??20),food:Number(process.env.FOOD_ID??0),foodReserve:Number(process.env.FOOD_RESERVE??0),xpRate:Number(process.env.XP_RATE??25),members:process.env.MEMBERS==='1',stop:()=>stopped||existsSync('.practice/stop-microbot-pickpocket')});s=await openBot(account,{onStop:async()=>{stopped=true;}});const r=await runPickpockets(s,p,o);console.log('PICKPOCKET_RESULT '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));}catch(e){await finish(s?[s]:[],false,String(e));}}
