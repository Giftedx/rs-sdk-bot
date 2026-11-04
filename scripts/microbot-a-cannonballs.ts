// Behaviour source: pinned Microbot-Hub; BSD notice: research/microbot-ports-LICENSE.txt.
// Finite Al Kharid furnace supply: bun scripts/microbot-a-cannonballs.ts <account> [steel-bars=1] [cap=1200].
// Native cannonballs.rs2 consumes one steel bar and makes four balls, requires Smithing35 and ammo_mould.
import {existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {walkPath,sessionWalker} from '../packages/core/src/walk';
import {depositObserved} from '../packages/core/src/deposit';
export const CANNON={bar:2353,ball:2,mould:4,level:35,perBar:4,bank:{x:3269,z:3167},furnace:{x:3274,z:3186}} as const;
type Stock=readonly{id:number;count:number}[];
const count=(rows:Stock,id:number)=>rows.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function cannonballEffect(before:Stock,after:Stock,xp0:number,xp1:number){
 const ids=new Set([...before,...after].map(i=>i.id));
 if([...ids].every(id=>count(before,id)===count(after,id))&&xp0===xp1)return 'none';
 return xp1>xp0&&[...ids].every(id=>count(after,id)-count(before,id)===(id===CANNON.bar?-1:id===CANNON.ball?4:0))?'made':'invalid';
}
export async function runCannonballs(s:Session,o:{bars:number;cap:number;stop?:()=>boolean}){
 if(!Number.isSafeInteger(o.bars)||o.bars<1||o.bars>26||!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>10000)throw Error('invalid cannonball batch');
 const st=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),held=(id:number)=>count(inv(),id),xp=()=>s.sdk.getSkillXp('Smithing')??0;
 const p0=st()?.player,hp0=s.sdk.getSkill('Hitpoints')?.level??0;
 if(!p0||hp0<7||(s.sdk.getSkill('Smithing')?.level??0)<35||p0.level!==0||Math.max(Math.abs(p0.worldX-3269),Math.abs(p0.worldZ-3167))>5)throw Error('stage cannonballs at Al Kharid bank with Smithing35 and known HP');
 let ended=false,made=0,failure='',stop='target';void s.ended.then(()=>{ended=true;});const start=s.tick(),xp0=xp();
 const unsafe=()=>{const p=st()?.player;return !p||p.isDead||p.lifeId!==p0.lifeId||(s.sdk.getSkill('Hitpoints')?.level??0)<hp0;};
 const over=()=>ended||unsafe()||!!o.stop?.()||s.tick()-start>=o.cap;
 const near=(x:number,z:number)=>{const p=st()?.player;return !!p&&p.level===0&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=3;};
 const walk=async(x:number,z:number,cleanup=false)=>{const r=await walkPath(await sessionWalker(s),[{x,z,tol:1}],{maxTicks:120,stop:()=>ended||unsafe()||(!cleanup&&over())});if(!r.ok||!near(x,z))throw Error('cannonball route failed');};
 const open=async()=>{if(st()?.bank.isOpen&&s.bankObservation?.())return;await s.bot.dismissBlockingUI();const gen=s.bankObservation?.()?.generation??-1;if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!st()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>gen,{timeoutTicks:15}))throw Error('cannonball bank observation missing');};
 const totals=()=>{const r=new Map<number,number>();for(const i of [...inv(),...(s.bankObservation?.()?.items??[])])r.set(i.id,(r.get(i.id)??0)+i.count);return r;};
 let initial:Map<number,number>|undefined;
 try{
  if(over())throw Error('cannonball stopped before work');await open();initial=totals();
  for(const id of [CANNON.bar,CANNON.ball]){const i=inv().find(i=>i.id===id);if(i)await depositObserved(s,i);}
  const withdraw=async(id:number,n:number)=>{const i=st()?.bank.items.find(i=>i.id===id);if(!i||i.count<n||!(await s.bot.withdrawItem(i,n,{asNote:false})).success||!await waitUntil(s,()=>held(id)===n,{timeoutTicks:10}))throw Error('cannonball supply unavailable '+id);};
  if(!held(CANNON.mould))await withdraw(CANNON.mould,1);
  if(28-inv().length<o.bars)throw Error('cannonball inventory space');await withdraw(CANNON.bar,o.bars);
  if(!(await s.bot.closeBank()).success||!await waitUntil(s,()=>!st()?.bank.isOpen,{timeoutTicks:8}))throw Error('cannonball bank close failed');
  if(over())throw Error('cannonball stopped before furnace');await walk(3274,3186);
  while(made<o.bars&&!over()){
   await s.bot.dismissBlockingUI();if(over())break;
   const furnace=s.sdk.findNearbyLoc(/^furnace$/i,{withOption:/smelt/i}),bar=inv().find(i=>i.id===CANNON.bar);if(!furnace||!bar||!held(CANNON.mould))throw Error('cannonball furnace/bar/mould missing');
   const before=inv().map(i=>({id:i.id,count:i.count})),beforeXp=xp();
   if(!(await s.sdk.sendUseItemOnLoc(bar.slot,furnace.x,furnace.z,furnace.id)).success)throw Error('cannonball dispatch refused');
   // Native recipe has delays before debit/output; never close its modal mid-cast.
   await waitUntil(s,()=>ended||unsafe()||held(CANNON.bar)<count(before,CANNON.bar),{timeoutTicks:Math.min(24,Math.max(1,o.cap-(s.tick()-start)))});
   await waitUntil(s,()=>ended||unsafe()||xp()>beforeXp&&held(CANNON.ball)>count(before,CANNON.ball),{timeoutTicks:3});
   const effect=cannonballEffect(before,inv(),beforeXp,xp());if(effect!=='made')throw Error('cannonball effect '+effect);made++;
   console.log('CANNONBALL_BATCH '+JSON.stringify({bars:made,balls:made*4,tick:s.tick()}));await waitTicks(s,1);
  }
  if(made!==o.bars)stop='stopped/cap';
 }catch(e){failure=String(e);stop='failure';}
 finally{if(initial&&!ended&&!unsafe())try{await walk(3269,3167,true);await open();for(const id of [CANNON.bar,CANNON.ball]){const i=inv().find(i=>i.id===id);if(i)await depositObserved(s,i);}}catch(e){failure+='; cleanup '+String(e);}}
 const final=initial&&s.bankObservation?.()?totals():undefined;
 const ids=new Set([...(initial?.keys()??[]),...(final?.keys()??[])]);
 const conserved=!!initial&&!!final&&[...ids].every(id=>(final!.get(id)??0)-(initial!.get(id)??0)===(id===CANNON.bar?-made:id===CANNON.ball?made*4:0));
 const banked=count(s.bankObservation?.()?.items??[],CANNON.ball)-(initial?.get(CANNON.ball)??0);
 const ok=!failure&&!ended&&!unsafe()&&!o.stop?.()&&made===o.bars&&conserved&&banked===made*4&&held(CANNON.ball)===0&&held(CANNON.bar)===0&&near(3269,3167);
 return{ok,stop,failure,bars:made,balls:made*4,banked,conserved,xp:xp()-xp0,ticks:s.tick()-start};
}
if(import.meta.main){let s:Session|undefined,stopped=false;try{const [account,bars,cap]=process.argv.slice(2);if(!account)throw Error('account required');s=await openBot(account,{onStop:async()=>{stopped=true;}});const r=await runCannonballs(s,{bars:Number(bars??1),cap:Number(cap??1200),stop:()=>stopped||existsSync('.practice/stop-microbot-cannonballs')});console.log('CANNONBALL_RESULT '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));}catch(e){await finish(s?[s]:[],false,String(e));}}
