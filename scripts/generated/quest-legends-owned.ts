// Native Legends' Quest; donor route: pinned LegendsQuest.java, BSD notice research/microbot-ports-LICENSE.txt.
// Public quest colours, dialogue, items and actual positions authorize this fresh-quest route.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {openBot,settle,accountOf} from '../../packages/core/src/bot';
import type {Session} from '../../packages/core/src/inprocess';
import {BotActions} from '../../vendor/rs-sdk/sdk/actions';
import {waitTicks,waitUntil} from '../../packages/core/src/ticks';
import {walkPath,sessionWalker,walkRoute} from '../../packages/core/src/walk';
import{loadTravel,travelAllowed}from'../../packages/core/src/travel';
import {depositObserved} from '../../packages/core/src/deposit';
import {componentId} from '../../packages/core/src/logout';
import {questFlags} from '../../packages/core/src/quest-status';
import {openQuest} from './quest-lib';
import {spellOnNativeLoc} from '../microbot-c-spell-loc';
import {productionStopRequested} from '../microbot-c-lifetime';
import {createPotionCareSession} from '../microbot-potion-care';

const content=join(import.meta.dir,'../../vendor/rs-sdk/server/content');
function nativePack(kind:'obj'|'loc'|'npc') {return new Map(readFileSync(join(content,'pack',kind+'.pack'),'utf8').split(/\r?\n/).filter(Boolean).map(l=>{const [id,name]=l.split('=');return[name!,Number(id)] as const;}));}
const objects=nativePack('obj'),locations=nativePack('loc'),npcs=nativePack('npc');
const id=(kind:Map<string,number>,name:string)=>{const n=kind.get(name);if(n===undefined)throw Error('pinned Native name absent: '+name);return n;};
const obj=(name:string)=>id(objects,name),locId=(name:string)=>id(locations,name),npcId=(name:string)=>id(npcs,name);
export const LEGENDS_ITEMS=Object.freeze({notes:obj('thkaramjamap'),map:obj('thkaramjamapcomp'),bull:obj('bullroarer'),picture:obj('goldbowlpic'),bowl:obj('goldbowl_empty'),blessed:obj('goldbowlbless_empty'),pure:obj('goldbowlbless_pure'),book:obj('book_of_binding'),seed:obj('yommiseeds'),germ:obj('yommiseeds_germ'),mixture:obj('snakeweed_sol'),bravery:obj('bravery_pot'),a:obj('heartcrystal_sectiona'),b:obj('heartcrystal_sectionb'),c:obj('heartcrystal_sectionc'),heart:obj('heartcrystal'),glow:obj('heartcrystal_glow'),dagger:obj('deathdagger'),force:obj('holyforce'),totem:obj('thtotempole'),gift:obj('thtotempolegift'),reed:obj('reed_hollow')});
const I=LEGENDS_ITEMS,BANK={x:3185,z:3436,level:0};
const GUJUO_SPOTS = [{ x: 2815, z: 2935 }, { x: 2840, z: 2925 }] as const;
export const LEGENDS_SKILLS={Agility:50,Thieving:50,Strength:50,Mining:52,Crafting:50,Prayer:42,Smithing:50,Herblore:45,Woodcutting:50,Magic:60} as const;
export type LegendsOrder={account:string;server:string;cap:number;returnTicks:number;xpRate:number;maximumTrials:number;maximumFood:number;maximumDoses:number;coinBudget:number;training:[string,string,string,string]};
const trainingMenus=[['Attack','Defence','Strength'],['Hitpoints','Prayer','Magic'],['Woodcutting','Crafting','Smithing'],['Herblore','Agility','Thieving']];
export function legendsTrainingOptions(skill:string){const menu=trainingMenus.findIndex(a=>a.includes(skill));if(menu<0)throw Error('unsupported Native Legends training');return[...Array.from({length:menu},(_,i)=>new RegExp('Go to Skill Menu '+(i+2))),new RegExp('^\\* '+skill+' \\*$')];}
export function validateLegendsOrder(o:LegendsOrder){if(!o||!/^[-a-z0-9]{1,12}$/i.test(o.account)||!o.server||![o.cap,o.returnTicks,o.xpRate,o.maximumTrials,o.maximumFood,o.maximumDoses,o.coinBudget].every(n=>Number.isSafeInteger(n)&&n>0)||o.cap>60000||o.returnTicks<500||o.cap<=o.returnTicks||o.xpRate>1000||o.maximumTrials>20||o.maximumFood>100||o.maximumDoses>60||o.coinBudget>10000||o.training.length!==4)throw Error('explicit finite Legends order required');for(const skill of o.training)legendsTrainingOptions(skill);}
export function legendsNextFare(budget:number,spent:number,outbound:boolean){if(!Number.isSafeInteger(budget)||budget<1||budget>10000||!Number.isSafeInteger(spent)||spent<0||spent>budget||typeof outbound!=='boolean'||budget-spent<(outbound?60:30))throw Error('Legends fare budget cannot fund journey and return');return spent+30;}
export async function legendsSummonAttempt(io: {
 present: () => boolean;
 saw: (pattern: RegExp) => boolean;
 send: () => Promise<unknown>;
 step: (send: () => Promise<unknown>, done: () => boolean) => Promise<void>;
 cooldown: () => Promise<void>;
 retreat: () => Promise<void>;
}) {
 await io.step(io.send, () => io.present() || io.saw(/nothing much seems to happen|takes a dislike|native cannot get to you|too busy to do that at the moment/i));
 if (io.saw(/takes a dislike/i)) {
  await io.retreat();
  return false;
 }
 if (io.present()) return true;
 if (io.saw(/too busy to do that at the moment/i)) await io.cooldown();
 return false;
}
export function legendsPackEffect(before:Readonly<Record<number,number>>,after:Readonly<Record<number,number>>,delta:Readonly<Record<number,number>>){return [...new Set([...Object.keys(before),...Object.keys(after),...Object.keys(delta)])].every(k=>(after[+k]??0)-(before[+k]??0)===(delta[+k]??0));}
export function legendsMapEffect(before:Record<number,number>,after:Record<number,number>,complete:boolean){return legendsPackEffect(before,after,{[obj('papyrus')]:-1,...(complete?{[I.notes]:-1,[I.map]:1}:{})})&&(!complete||(after[I.map]??0)===1);}
export async function legendsMapAttempt(io:{pack:()=>Record<number,number>;saw:(pattern:RegExp)=>boolean;step:(send:()=>Promise<unknown>,done:()=>boolean)=>Promise<void>;send:()=>Promise<unknown>},complete:boolean){
 const before={...io.pack()},success=()=>io.saw(/neatly add a new section/i);
 const summons = obj('regicide_quest_kings_summons');
 const mappingStock = () => {
  const current = { ...io.pack() };
  if (!before[summons] && current[summons] === 1 && io.saw(/Kings messenger.*King Lathas sent this message for you/i)) {
   delete current[summons];
  }
  return current;
 };
 // The client can enumerate wrapped object-box lines in reverse display order.
 const ruinedPaper = () => io.saw(/(?=.*the paper is totally)(?=.*ruined\.)/i);
 const brokenCharcoal = () => io.saw(/snap your stick/i);
 const ruinedBoth = () => io.saw(/destroying them both|you fall over, landing on/i);
 const failure = () => io.saw(/make a mess but are able/i) || ruinedPaper() || brokenCharcoal() || ruinedBoth();
 // Native closes the section page, delays, then pauses on completion before converting the notes.
 await io.step(io.send,()=>success()?io.saw(/Mapping the Kharazi Jungle \*\*\*/i)&&legendsMapEffect(before,mappingStock(),complete):failure());
 if(success()){if(!legendsMapEffect(before,mappingStock(),complete))throw Error('Legends mapping stock conversion differs');return true;}
 const paper = ruinedPaper() || ruinedBoth() ? -1 : 0;
 const charcoal = brokenCharcoal() || ruinedBoth() ? -1 : 0;
 if(!failure()||!legendsPackEffect(before,mappingStock(),{[obj('papyrus')]:paper,[obj('charcoal')]:charcoal}))throw Error('Legends map outcome unknown');
 return false;
}
export async function legendsBlessBowlAttempt(io: {
 pack: () => Record<number, number>;
 prayer: () => number;
 sawFailure: () => boolean;
 send: () => Promise<unknown>;
 step: (send: () => Promise<unknown>, done: () => boolean, choices: RegExp[]) => Promise<void>;
}) {
 const before = { ...io.pack() }, prayerBefore = io.prayer();
 if (prayerBefore < 42 || before[I.bowl] !== 1 || before[I.blessed]) throw Error('Legends bowl blessing inputs unavailable');
 const choices = [/^Yes, I'd like (?:you )?to bless my gold bowl\.$/i];
 const blessed = () => legendsPackEffect(before, io.pack(), { [I.bowl]: -1, [I.blessed]: 1 });
 await io.step(io.send, () => {
  if (!blessed() && !io.sawFailure()) return false;
  choices.splice(0, choices.length, /^No thanks, I'll wait\.$/i, /^No thanks, I need help with something else\.$/i, /^Ok thanks for your help\.$/i);
  return true;
 }, choices);
 if (blessed() && io.prayer() === prayerBefore) return true;
 if (io.sawFailure() && io.prayer() === prayerBefore - 5 && legendsPackEffect(before, io.pack(), {})) return false;
 throw Error('Legends bowl blessing outcome differs');
}
export function legendsContext(raw:Session,cap:number,hpFloor=25){const client=raw.client,executor=(client as any).executeBotAction,server=raw.lifecycle?.server,p=raw.sdk.getState()?.player,life=p?.lifeId,respawns=p?.respawnCount??0,start=raw.tick();let ended=false,lost=false;void raw.ended.then(()=>{ended=true;});return{start,alive(){const now=raw.sdk.getState()?.player;if(raw.client!==client||(client as any).executeBotAction!==executor)lost=true;return raw.lifecycle?.server===server&&!lost&&!ended&&typeof executor==='function'&&life!==undefined&&!!now&&!now.isDead&&now.lifeId===life&&(now.respawnCount??0)===respawns&&(raw.sdk.getSkill('Hitpoints')?.level??0)>=hpFloor&&raw.tick()-start<cap;}};}

export function legendsLoginOwner(s:Session){const client=s.client as {executeBotAction?:unknown},executor=client.executeBotAction,server=s.lifecycle?.server,p=s.sdk.getState()?.player,life=p?.lifeId,respawns=p?.respawnCount??0;let lost=false,ended=false;void s.ended.then(()=>{ended=true;});return()=>{const now=s.sdk.getState()?.player;if(s.client!==client||client.executeBotAction!==executor||s.lifecycle?.server!==server||now?.lifeId!==life||(now?.respawnCount??0)!==respawns)lost=true;return !lost&&!ended&&typeof executor==='function'&&life!==undefined&&!!now&&!now.isDead;};}
export async function finishLegendsOwned(s:Session,owns:()=>boolean,ok:boolean,detail:string,finish:typeof settle=settle){if(!owns()){console.error('LEGENDS_SETTLEMENT original login owner/life unavailable; no logout input');return false;}return finish([s],ok,detail);}
// Only Native Prayer restoration is used here; it has zero prevention cooldown.
// Keep their total dose budget and unknown-outcome latch across bounded primitive windows.
export function legendsPotionWindows(s: Session, maximum: number, observation: () => boolean, stop: () => boolean, create = createPotionCareSession) {
 let doses = 0, windowStart = 0, blocked = false;
 let window: ReturnType<typeof createPotionCareSession> | undefined;
 let windowFloor: 35 | 42 | undefined;
 return {
  get doses() { return doses; },
  async poll(prayerFloor: 35 | 42 = 35) {
   if (blocked) throw Error('Legends potion outcome unresolved');
   if (doses >= maximum) return;
   try {
    if (window?.blocked) throw Error('Legends prior potion window unresolved');
    if (!window || s.tick() - windowStart >= 900 || windowFloor !== prayerFloor) {
     window = create(s, {policies: [{id: 2434, below: prayerFloor}], maximumDoses: Math.min(40, maximum - doses), maximumVials: 0, cap: 1000}, observation, stop);
     windowStart = s.tick();
     windowFloor = prayerFloor;
    }
    const before = window.doses;
    await window.poll();
    doses += window.doses - before;
    if (window.blocked) throw Error('Legends potion window unresolved');
   } catch (error) { blocked = true; throw error; }
  },
 };
}

const pack=(s:Session)=>{const m:Record<number,number>={};for(const row of s.sdk.getInventory())m[row.id]=(m[row.id]??0)+row.count;return m;};
const flag=(s:Session)=>questFlags(s.client)?.find(q=>/legends/i.test(q.name))?.state;
const cursor=(s:Session)=>Math.max(-1,...(s.sdk.getState()?.gameMessages??[]).map(m=>m.observationId??m.tick));
const fresh=(s:Session,mark:number,re:RegExp)=>(s.sdk.getState()?.gameMessages??[]).some(m=>m.type===0&&(m.observationId??m.tick)>mark&&re.test(m.text));
const jungleIds=new Set([...locations].filter(([n])=>/^kharazi_jungle_(tree|plant)/.test(n)).map(([,n])=>n));
export async function legendsSurfaceJourney(from:{x:number;z:number;level:number},to:{x:number;z:number;level:number},drive:{ground:(to:{x:number;z:number})=>Promise<void>;boat:(outbound:boolean)=>Promise<void>}){
 if(from.level!==0||to.level!==0||from.z>=9000||to.z>=9000)throw Error('Legends known surface journey required');const island=(p:{x:number;z:number})=>p.x>=2700&&p.x<3000&&p.z>=2800&&p.z<=3300,outbound=island(to);if(island(from)!==outbound){await drive.ground(outbound?{x:3028,z:3216}:{x:2955,z:3146});await drive.boat(outbound);}await drive.ground(to);
}
export function legendsJungleTarget<T extends {id:number;x:number;z:number;reachable?:boolean;optionsWithIndex:{opIndex:number}[]}>(locs:readonly T[],p:{x:number;z:number},direction:number){return locs.filter(t=>jungleIds.has(t.id)&&t.reachable===true&&t.optionsWithIndex.some(o=>o.opIndex===1)&&(t.z-p.z)*direction>0&&Math.abs(t.x-p.x)<=1&&Math.max(Math.abs(t.x-p.x),Math.abs(t.z-p.z))<=2).sort((a,b)=>Math.abs(a.x-p.x)-Math.abs(b.x-p.x)||Math.abs(a.z-p.z)-Math.abs(b.z-p.z))[0];}


export async function runLegends(raw:Session,o:LegendsOrder,requested:()=>boolean=()=>false){
 validateLegendsOrder(o);if(raw.name.toLowerCase()!==o.account.toLowerCase()||raw.lifecycle?.server!==o.server)throw Error('Legends account/server identity mismatch');
 const flags=questFlags(raw.client);if(!flags||flag(raw)!=='not started'||!['Family Crest',"Hero's Quest",'Shilo Village','Underground Pass','Waterfall Quest'].every(name=>flags.some(q=>q.name===name&&q.state==='complete'))||(raw.client as any).membersAccount!==1)throw Error('fresh public Legends/prerequisite flags and member account required');
 for(const[name,n]of Object.entries(LEGENDS_SKILLS))if((raw.sdk.getSkill(name)?.level??0)<n)throw Error('Legends Native skill required '+name+' '+n);
 const initialHp=raw.sdk.getSkill('Hitpoints')?.level??0,maximumHp=raw.sdk.getSkill('Hitpoints')?.baseLevel??0,gear=raw.sdk.getEquipment().map(i=>({id:i.id,count:i.count,slot:i.slot})),style=raw.sdk.getState()?.combatStyle,retaliate=raw.sdk.getState()?.autoRetaliateEnabled,prayers=raw.sdk.getPrayerState();
 if(initialHp<90||maximumHp<initialHp||maximumHp>99||!style?.known||!Number.isSafeInteger(style.currentStyle)||retaliate!==false||!prayers||prayers.activePrayers.some(Boolean)||!gear.some(i=>i.slot===3))throw Error('Legends requires HP90+, observed melee kit/style, retaliationOFF and prayersOFF');
 const context=legendsContext(raw,o.cap),fatal=()=>!context.alive(),stop=()=>fatal()||productionStopRequested(raw.name,requested)||raw.tick()-context.start>=o.cap-o.returnTicks;let working=true,uncertain=false,prayerUnknown=false,food=0,fareSpent=0,stageName='admission',failure='',q:Awaited<ReturnType<typeof openQuest>>|undefined;
 const receipts:{step:string;tick:number;before:Record<number,number>;after:Record<number,number>}[]=[],guard=()=>{if(fatal()||working&&stop()||uncertain)throw Error('Legends original life/owner/stop or paid outcome unavailable');};
 const sdk=new Proxy(raw.sdk,{get(target,key,receiver){const v=Reflect.get(target,key,receiver);return typeof v==='function'?function(...args:unknown[]){if(typeof key==='string'&&key.startsWith('send'))guard();return v.apply(receiver,args);}:v;}}),s={...raw,sdk,bot:new BotActions(sdk),direct:async(action:Parameters<Session['direct']>[0])=>{guard();return raw.direct(action);}} as Session;
 const pageEvents:{tick:number;text:string}[]=[];let pageLast='';const offPages=s.onTick(()=>{const d=sdk.getDialog();const text=d?.isOpen?[d.text??'',...(d.allComponents??[]).map(c=>c.text??'')].join(' '):'';if(text&&text!==pageLast)pageEvents.push({tick:s.tick(),text});pageLast=text;});const pageMark=()=>pageEvents.length,sawSince=(mark:number,re:RegExp)=>pageEvents.slice(mark).some(p=>re.test(p.text));
 const count=(item:number)=>pack(s)[item]??0,has=(item:number)=>count(item)>0,pos=()=>s.sdk.getState()!.player!,near=(x:number,z:number,r=1)=>Math.max(Math.abs(pos().worldX-x),Math.abs(pos().worldZ-z))<=r;
 const wait=async(test:()=>boolean,ticks=20)=>{if(!await waitUntil(s,()=>fatal()||test(),{timeoutTicks:ticks})||fatal()||!test())throw Error('Legends '+stageName+' observed effect absent');};
 const step=async(label:string,send:()=>Promise<unknown>,ok:()=>boolean,choices:RegExp[]=[],ticks=60)=>{guard();stageName=label;const before=pack(s);await send();if(!await q!.converse(choices,()=>fatal()||ok()&&!q!.dialogOpen(),ticks)||fatal()||!ok())throw Error('Legends '+label+' effect unobserved; no paid retry');receipts.push({step:label,tick:s.tick(),before,after:pack(s)});await waitTicks(s,3);guard();};
 const paid=async(label:string,delta:Record<number,number>,send:()=>Promise<unknown>,choices:RegExp[]=[],ticks=60)=>{const before=pack(s);try{await step(label,send,()=>legendsPackEffect(before,pack(s),delta),choices,ticks);if(!legendsPackEffect(before,pack(s),delta))throw Error('Legends '+label+' whole-pack settlement changed');}catch(error){uncertain=true;throw error;}};
 const walk=async(x:number,z:number,tol=1)=>{guard();await q!.walk(stageName,[{x,z,tol}]);if(!near(x,z,tol))throw Error('Legends route endpoint unobserved');};
 const modal=async()=>{guard();await sdk.sendCloseModal();await wait(()=>!sdk.getDialog()?.isOpen&&!sdk.getState()?.interface.isOpen,8);await waitTicks(s,2);};
 const move=async(x:number,z:number)=>{await modal();const controller=new AbortController(),off=s.onTick(()=>{if(fatal()||working&&stop())controller.abort();});const ground=async(to:{x:number;z:number})=>{guard();const r=await walkPath(await sessionWalker(s),[{...to,tol:1}],{maxTicks:600,stop:()=>fatal()||working&&stop()});guard();if(!r.ok||!near(to.x,to.z,1))throw Error('Legends ground route '+(!r.ok?r.detail:'landing absent'));};try{const p=pos();await legendsSurfaceJourney({x:p.worldX,z:p.worldZ,level:p.level},{x,z,level:0},{ground,boat:async outbound=>{guard();const id=outbound?'npc:captain_tobias:karamja-musa-point@3028,3216':'npc:customs_officer:port-sarim@2955,3146',t=loadTravel().find(t=>t.id===id),p=pos();if(!t?.from||t.kind!=='boat'||t.coins!==30||p.level!==0||Math.max(Math.abs(p.worldX-t.from.x),Math.abs(p.worldZ-t.from.z))>3||!travelAllowed(t,accountOf(s)))throw Error('Legends observed funded Native ferry unavailable');const nextFare=legendsNextFare(o.coinBudget,fareSpent,outbound),before=pack(s);const r=await walkRoute(s,[{kind:'travel',travel:t,at:t.from,to:t.to}],{signal:controller.signal,legTimeoutTicks:150,maxRetriesPerLeg:1});if(fatal()||!near(t.to.x,t.to.z,3)||!legendsPackEffect(before,pack(s),{995:-30})){uncertain=true;throw Error('Legends Native ferry outcome unknown; no retry '+(!r.ok?r.detail:''));}fareSpent=nextFare;receipts.push({step:'Native ferry fare',tick:s.tick(),before,after:pack(s)});guard();}});}finally{off();}};
 const l=(name:string,x:number,z:number)=>{const row=sdk.getState()?.nearbyLocs.find(n=>n.id===locId(name)&&n.x===x&&n.z===z);if(!row)throw Error('Legends observed Native loc absent '+name+' '+x+','+z);return row;};
 const interact=(name:string,x:number,z:number,op=1)=>q!.opLoc(l(name,x,z),op);
 const useLoc=(item:number,name:string,x:number,z:number)=>{if(!has(item))throw Error('Legends owned input missing '+item);return q!.useOnLoc(item,l(name,x,z));};
 const held=(item:number,op=1)=>{const row=sdk.getInventory().find(i=>i.id===item);if(!row)throw Error('Legends owned inventory input absent');return s.direct({type:'useInventoryItem',slot:row.slot,optionIndex:op,reason:'finite Native Legends quest'});};
 const talk=async(name:string,home:{x:number;z:number},choices:RegExp[],ok:()=>boolean)=>{stageName=name;await q!.talk(name,new RegExp('^'+name+'$','i'),choices,ok,home,130);guard();if(!ok())throw Error('Legends public dialogue effect absent '+name);};
 const trials=async(label:string,send:()=>Promise<unknown>,success:()=>boolean,knownFailure:RegExp,choices:RegExp[]=[],ticks=80,prepare?:()=>Promise<void>)=>{for(let n=0;n<o.maximumTrials;n++){guard();if(success())return;await prepare?.();const mark=cursor(s),pages=pageMark(),before=pack(s);await step(label,send,()=>success()||fresh(s,mark,knownFailure)||sawSince(pages,knownFailure),choices,ticks);if(success())return;if(!legendsPackEffect(before,pack(s),{}))throw Error('Legends '+label+' unexpected trial stock change');await upkeep();}throw Error('Legends '+label+' declared trial budget exhausted');};
 const prayer=async(on:boolean)=>{if(prayerUnknown||fatal())throw Error('Legends prayer original context unavailable');if(sdk.isPrayerActive(14)===on)return;guard();prayerUnknown=true;try{await sdk.sendTogglePrayer(14);}catch{}try{await wait(()=>sdk.isPrayerActive(14)===on,8);prayerUnknown=false;}catch(error){throw Error('Legends prayer transition uncertain; no toggle retry '+error);}};
 const potions=legendsPotionWindows(s,o.maximumDoses,()=>!fatal(),stop);
 const upkeep=async(prayerFloor:35|42=35)=>{guard();while((sdk.getSkill('Hitpoints')?.level??0)<75){if(food>=o.maximumFood||!has(385))throw Error('Legends declared food budget exhausted');const before=pack(s),hp=sdk.getSkill('Hitpoints')!.level;await paid('owned shark', {385:-1},()=>held(385),[],12);const after=sdk.getSkill('Hitpoints')!.level;if(after<=hp||after>Math.min(maximumHp,hp+20))throw Error('Legends shark HP receipt differs');food++;if(!legendsPackEffect(before,pack(s),{385:-1}))throw Error('Legends shark stock differs');}await potions.poll(prayerFloor);};
 let bankRows:{id:number;count:number}[]=[],baseline:Record<number,number>={};
 const allAssets=()=>{const m={...pack(s)};for(const row of[...sdk.getEquipment(),...bankRows])m[row.id]=(m[row.id]??0)+row.count;return m;};
 const openBank=async()=>{guard();const generation=s.bankObservation?.()?.generation??-1;if(!sdk.getState()?.bank.isOpen||!s.bankObservation?.()){await s.bot.openBank();await wait(()=>!!sdk.getState()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>generation,12);}bankRows=s.bankObservation!()!.items.map(r=>({id:r.id,count:r.count}));};
 const bank=async(need:Record<number,number>,keep:readonly number[]=[])=>{stageName='owned bank/refill';if(pos().worldZ>=2882&&pos().worldZ<=2935&&pos().worldX>=2757&&pos().worldX<=2974)await crossing(true);await move(BANK.x,BANK.z);await openBank();if(need[995]!==undefined)need={...need,995:o.coinBudget+37-fareSpent};
  // depositObserved settles every slot holding the dispatched item ID.
  const deposits = new Map(sdk.getInventory().filter(row => !keep.includes(row.id)).map(row => [row.id, row]));
  for (const row of deposits.values()) await depositObserved(s, row);
  bankRows=s.bankObservation!()!.items.map(r=>({id:r.id,count:r.count}));for(const [key,total]of Object.entries(need)){const item=+key,n=total-count(item);if(n<=0)continue;guard();const row=sdk.getState()?.bank.items.find(i=>i.id===item),before=pack(s),g=s.bankObservation!()!.generation;if(!row||row.count<n)throw Error('Legends declared owned stock unavailable '+item);await s.bot.withdrawItem(row,n,{asNote:false});await wait(()=>legendsPackEffect(before,pack(s),{[item]:n})&&(s.bankObservation?.()?.generation??-1)>g,10);}bankRows=s.bankObservation!()!.items.map(r=>({id:r.id,count:r.count}));await s.bot.closeBank();await wait(()=>!sdk.getState()?.bank.isOpen,8);};
 const basic=()=>({995:o.coinBudget+37-fareSpent,1359:1,975:1,946:1,385:Math.min(7,o.maximumFood-food),2434:2});
 const crossing=async(north:boolean)=>{const end=north?2942:2934,direction=north?1:-1;if(north)await walk(2864,2934,0);else{await move(2864,2942);await walk(2864,2942,0);}for(let n=0;n<10;n++){guard();const p={x:pos().worldX,z:pos().worldZ};if(north?p.z>=end:p.z<=end)return;const path=sdk.findPath(2864,end);if(path.success&&path.reachedDestination){await walk(2864,end,0);return;}const candidate=legendsJungleTarget(sdk.getState()?.nearbyLocs??[],p,direction);if(!candidate)throw Error('Legends observed Native jungle crossing target absent');const mark=cursor(s);await step(north?'cut north Native jungle':'cut south Native jungle',()=>q!.opLoc(candidate,1),()=>((pos().worldZ-p.z)*direction>0)||fresh(s,mark,/This way is blocked off/),[],60);if((pos().worldZ-p.z)*direction<=0)throw Error('Legends Native jungle crossing refused');await upkeep();}throw Error('Legends bounded Native jungle crossing exhausted');};
 const jungle=()=>crossing(false);

 let gujuoSpot = 0;
 const gujuoWildlife = new Set(['oomlie_bird', 'jungle_savage', 'jungle_wolf'].map(npcId));
 const gujuoClearingQuiet = () => {
  const state = sdk.getState();
  const selfSlot = (s.client as { selfSlot?: number }).selfSlot;
  if (!state?.player || typeof selfSlot !== 'number' || !Number.isSafeInteger(selfSlot) || selfSlot < 0) return false;
  return !state.nearbyNpcs.some(npc => gujuoWildlife.has(npc.id) && npc.targetIndex === 32768 + selfSlot);
 };
 const summon = async () => {
  const reachClearing = () => walk(GUJUO_SPOTS[gujuoSpot]!.x, GUJUO_SPOTS[gujuoSpot]!.z, 0);
  await reachClearing();
  const present = () => !!sdk.getState()?.nearbyNpcs.some(n => n.id === npcId('gujuo'));
  const retreat = async () => {
   gujuoSpot = 1 - gujuoSpot;
   await reachClearing();
   await upkeep();
   const pursuitCleared = async () => {
    await waitUntil(s, () => fatal() || gujuoClearingQuiet(), { timeoutTicks: 16 });
    guard();
    return gujuoClearingQuiet();
   };
   if (!await pursuitCleared()) {
    // Jungle savages can follow across both Gujuo clearings. The map route spans their leash.
    const east = { x: 2910, z: 2916 }, west = { x: 2791, z: 2917 };
    const escape = gujuoSpot === 1 ? [east, west] : [west, east];
    for (const tile of escape) {
     await walk(tile.x, tile.z, 0);
     await upkeep();
     if (await pursuitCleared()) break;
    }
    if (!gujuoClearingQuiet()) throw Error('Legends wildlife pursuit did not clear on the map route');
    await reachClearing();
    await upkeep();
    await wait(gujuoClearingQuiet, 16);
   }
   const lastHit = sdk.getState()?.player?.combat?.lastDamageTick;
   await waitTicks(s, 8);
   guard();
   if (lastHit === undefined || !gujuoClearingQuiet() || sdk.getState()?.player?.combat?.lastDamageTick !== lastHit) {
    throw Error('Legends could not shake hostile wildlife before retrying Gujuo');
   }
  };
  for (let trial = 0; trial < o.maximumTrials; trial++) {
   started = s.tick();
   guard();
   if (!gujuoClearingQuiet()) { await retreat(); continue; }
   if (present()) return;
   const mark = cursor(s);
   const summoned = await legendsSummonAttempt({
    present, retreat, saw: pattern => fresh(s, mark, pattern), send: () => held(I.bull),
    step: (send, done) => step('summon Gujuo', send, done, [], 18),
    cooldown: async () => { await waitTicks(s, 8); guard(); },
   });
   if (summoned) {
    if (gujuoClearingQuiet()) return;
    await retreat();
   }
  }
  throw Error('Legends finite Gujuo summon budget exhausted');
 };
 let started=0;
 const gujuo=async(choices:RegExp[],ok:()=>boolean)=>{started=s.tick();if(sdk.getInventory().length>=28)throw Error('Legends Gujuo reward needs an empty inventory slot');await summon();const n=sdk.getState()!.nearbyNpcs.find(n=>n.id===npcId('gujuo'))!;await talk('Gujuo',{x:n.x,z:n.z},choices,ok);};
 let caveReturn: 'none' | 'shaman' | 'strength' = 'none';
 const cave = async () => {
  await walk(2781, 2934);
  const crawlMark = cursor(s);
  // Native emits the exhaustion line at the end of a failed crawl, just before its damage settles.
  await trials('Shaman cave entrance', () => interact('lgshamancaverock1', 2781, 2936),
   () => near(2773, 9341, 0) && fresh(s, crawlMark, /After some time, you find a small cave opening/i),
   /^And you're totally exhausted from the ordeal\.$/i, [/Yes, I'll crawl through/i]);
  caveReturn = 'shaman';
  await walk(2790, 9334);
 };
 const exitCave = async () => {
  await walk(2773, 9341);
  await step('leave Shaman cave', () => interact('shaman_entrance_caver', 2773, 9342), () => near(2781, 2934));
  caveReturn = 'none';
 };
 const firewall=async(pure:boolean)=>{await walk(2790,9334);const mark=cursor(s);await step('enter flaming octagram',()=>pure?useLoc(I.pure,'lqfirewall_straight',2790,9333):interact('lqfirewall_straight',2790,9333,2),()=>pos().worldZ<=9332&&(pure?fresh(s,mark,/splash some pure water/):true));};
 const surface=async()=>{if(pos().worldZ>9000){if(pos().worldZ<9334&&pos().worldX>2786){await step('leave cured octagram',()=>interact('lqfirewall_straight',2790,9333,2),()=>pos().worldZ>=9334);}await exitCave();}};
 const reed=async()=>{await walk(2836,2917);if(!has(I.reed))await paid('cut hollow reed',{[I.reed]:1},()=>useLoc(946,'tall_reeds',2836,2916));};
 const fill=async()=>{await reed();await paid('sacred surface water',{[I.reed]:-1,[I.blessed]:-1,[I.pure]:1},()=>useLoc(I.reed,'sacred_water',2837,2915));};
 const combat=async(name:string,home:{x:number;z:number},done:()=>boolean,defeat:RegExp|null,targetIndex?:number)=>{await upkeep();await walk(home.x,home.z,2);await wait(()=>!!sdk.getState()?.nearbyNpcs.some(n=>n.id===npcId(name)),20);const targets=sdk.getState()!.nearbyNpcs.filter(n=>n.id===npcId(name)&&(targetIndex===undefined||n.index===targetIndex)&&(!n.inCombat||n.targetIndex===32768+(s.client as any).selfSlot)).sort((a,b)=>a.distance-b.distance);if(!targets.length||targets[0]!.hp===0)throw Error('Legends unclaimed observed quest adversary required');const index=targets[0]!.index,own=32768+(s.client as any).selfSlot,mark=cursor(s),began=s.tick();let lastAttack=-100,lastProgress=s.tick(),hp=targets[0]!.hp;await prayer(true);while(!done()&&!(defeat!==null&&fresh(s,mark,defeat))&&s.tick()-began<2500){guard();if(sdk.getState()!.nearbyPlayers.length)throw Error('Legends quest duel foreign player');const target=sdk.getState()!.nearbyNpcs.find(n=>n.id===npcId(name)&&n.index===index);if(target&&target.hp!==0){if(target.inCombat&&target.targetIndex!==own&&target.targetIndex!==-1)throw Error('Legends private duel belongs to another player');if(target.hp!==hp){hp=target.hp;lastProgress=s.tick();}await upkeep();if(!sdk.isPrayerActive(14))await prayer(true);if(s.tick()-lastAttack>=8&&sdk.getState()?.player?.combat?.targetIndex!==index){await sdk.sendInteractNpc(index,2);lastAttack=s.tick();}}if(fresh(s,mark,/It's not after you|attack glides straight through/))throw Error('Legends native quest combat ownership refused');if(s.tick()-lastProgress>180)throw Error('Legends quest combat made no observed progress');await q!.converse([],()=>!q!.dialogOpen(),2);await waitTicks(s,1);}await wait(()=>done()||(defeat!==null&&fresh(s,mark,defeat)),25);await waitTicks(s,15);await prayer(false);await upkeep();};
 try{
  guard();q=await openQuest({session:s,stop:()=>working?stop():fatal(),cap:o.cap,food:[],eatAt:1});await move(BANK.x,BANK.z);await openBank();baseline=allAssets();if(Object.values(I).some(item=>(baseline[item]??0)>0))throw Error('Legends fresh route cannot inherit owned quest-progress items');await s.bot.closeBank();
  await bank({...basic(), [obj('papyrus')]: 6, [obj('charcoal')]: 3});
  await move(2729, 3348);
  stageName = 'Legends guard entry';
  await wait(() => !!q!.npc(/^Legends guard$/i), 8);
  const guildGuard = q.npc(/^Legends guard$/i);
  if (!guildGuard) throw Error('Legends observed guild guard absent');
  const guildEntry = pageMark();
  await step('Legends guard entry', () => q!.talkTo(guildGuard),
   () => near(2728, 3350, 1) && pos().worldZ >= 3350 && sawSince(guildEntry, /guard unlocks the gate/i),
   [/^What is this place\?$/i, /^Can I go on the quest\?$/i, /^Yes, I'd like to talk to Grand Vizier Erkle\.$/i], 120);
  await walk(2725,3367);await talk('Radimus Erkle',{x:2725,z:3368},[/Yes actually, what's involved/i,/Yes, it sounds great/i],()=>has(I.notes)&&flag(s)==='started');
  await jungle();for(const [section,[x,z]]of [[2791,2917],[2852,2915],[2910,2916]].entries()){await walk(x!,z!);let mapped=false;for(let n=0;n<o.maximumTrials&&!mapped;n++){const mark=pageMark();mapped=await legendsMapAttempt({pack:()=>pack(s),saw:re=>sawSince(mark,re),send:()=>held(I.notes,2),step:(send,done)=>step('map Kharazi section',send,done,[],60)},section===2);}if(!mapped)throw Error('Legends map trial budget exhausted');}if(!has(I.map))throw Error('Legends completed public map absent');
  await crossing(true);await walk(2867,2942);const forester=sdk.getState()?.nearbyNpcs.find(n=>/Jungle forester/i.test(n.name));if(!forester)throw Error('Legends native forester absent');await paid('forester map copy',{[I.bull]:1},()=>q!.useOnNpc(I.map,forester),[/Yes, go ahead make a copy/i]);await bank({...basic()},[I.map,I.bull]);
  await jungle();await gujuo([/hoping to attract/i,/develop friendly relations/i,/get your people together/i,/What can we do instead/i,/How do we make/i,/I will release Ungadulu/i],()=>q!.sawText(/release Ungadulu|find.*cave|good luck/i));await cave();await step('Ungadulu pure-water clue',()=>interact('lqfirewall_straight',2790,9333,2),()=>q!.sawText(/from the above lands/i),[/Who are you/i,/Where do I get pure water/i]);await exitCave();await gujuo([/Ungadulu looks a little strange/i,/pure water to douse/i,/What kind of a vessel/i,/Ok thanks for your help/i],()=>has(I.picture));
  await bank({...basic(),2347:1,2357:6},[I.map,I.bull,I.picture]);await move(3187,3425);for(let n=0;n<o.maximumTrials&&!has(I.bowl);n++){const before=pack(s),mark=cursor(s);await step('forge gold bowl',()=>useLoc(2357,'anvil',3188,3426),()=>has(I.bowl)||fresh(s,mark,/make a mistake forging/),[/^Yes$/]);const lost=(before[2357]??0)-count(2357);if(has(I.bowl)){if(!legendsPackEffect(before,pack(s),{2357:-2,[I.bowl]:1}))throw Error('Legends forged bowl whole-pack differs');}else if(![1,2].includes(lost)||!legendsPackEffect(before,pack(s),{2357:-lost}))throw Error('Legends forge failure debit unknown');}if(!has(I.bowl))throw Error('Legends finite forge budget exhausted');
  await bank({...basic(),[I.bowl]:1},[I.map,I.bull,I.picture]);await jungle();for(let n=0;n<o.maximumTrials&&!has(I.blessed);n++){await upkeep(42);started=s.tick();await summon();const native=q.npc(/^Gujuo$/i);if(!native)throw Error('Legends bowl blessing native absent');const mark=pageMark();await legendsBlessBowlAttempt({pack:()=>pack(s),prayer:()=>sdk.getSkill('Prayer')?.level??0,sawFailure:()=>sawSince(mark,/not able to go into a deep enough trance/i),send:async()=>{if(!gujuoClearingQuiet())throw Error('Legends wildlife targets the bowl bearer');if(!q!.dialogOpen())await q!.useOnNpc(I.bowl,native);},step:(send,done,choices)=>step('one bowl blessing attempt',send,done,choices,100)});}if(!has(I.blessed))throw Error('Legends bounded bowl blessing failed');
  await surface();await bank({...basic(),385:2,2434:1,1265:1,1523:1,566:1,558:1,557:1,563:2,1609:1,1611:1,1613:1,1607:1,1601:1,1603:1,1605:1},[I.map,I.bull,I.blessed]);await jungle();await cave();
  // The first traversal pays SMELL and the seven gems once; later traversals use the observed doors.
  await enterTrials(true);if(sdk.getState()?.groundItems.some(g=>g.id===I.book))throw Error('Legends preexisting Book of Binding pile ambiguous');for(const [item,x,z]of[[1609,2764,9309],[1611,2771,9303],[1613,2772,9295],[1607,2781,9291],[1601,2774,9287],[1603,2767,9289],[1605,2757,9297]]){await walk(x!,z!,1);await paid('bind gem '+item,{[item!]:-1},()=>useLoc(item!,'lg_gemplacerock',x!,z!));}await walk(2765,9297,1);await wait(()=>!!sdk.getState()?.groundItems.some(g=>g.id===I.book),60);const books=sdk.getState()!.groundItems.filter(g=>g.id===I.book);if(books.length!==1||books[0]!.count!==1||sdk.getState()!.nearbyPlayers.length)throw Error('Legends fresh Book of Binding ownership ambiguous');const book=books[0]!;await paid('owned Book of Binding',{[I.book]:1},()=>s.direct({type:'pickupItem',x:book.x,z:book.z,itemId:I.book,reason:'fresh seven-gem quest reward'}));
  await leaveTrials();await exitCave();await bank({...basic()},[I.map,I.bull,I.blessed,I.book]);await jungle();await fill();await cave();await firewall(true);await step('bind possessed Ungadulu',()=>q!.useOnNpc(I.book,q!.npc(/^Ungadulu$/i)),()=>!!sdk.getState()?.nearbyNpcs.some(n=>n.id===npcId('nezikchened')),[],130);await combat('nezikchened',{x:2792,z:9328},()=>false,/demon's body falls.*pile of ashes/i);await talk('Ungadulu',{x:2792,z:9328},[/collect some Yommi tree seeds/i,/Ok, thanks/i],()=>has(I.seed));const seeds=count(I.seed);await paid('germinate Yommi seeds',{[I.seed]:-seeds,[I.germ]:seeds,[I.pure]:-1,[I.blessed]:1},()=>q!.useOnItem(I.seed,I.pure));await surface();await reed();const mark=pageMark();await step('observe dry sacred pool',()=>useLoc(I.reed,'sacred_water',2837,2915),()=>sawSince(mark,/dried|sludge|pollut/i));await gujuo([/pool has dried up/i,/source of the spring/i,/If I went, could you help/i,/Ok thanks/i],()=>q!.sawText(/Snake weed and Ardrigal/i));
  await bank({...basic(),385:5,2434:1,[I.blessed]:1,[obj('snake_weed')]:1,[obj('ardrigal')]:1,227:1,567:1,557:30,564:3,954:1,1265:1,1523:1},[I.map,I.bull,I.book]);await paid('snakeweed solution',{[obj('snake_weed')]:-1,227:-1,[I.mixture]:1},()=>q!.useOnItem(obj('snake_weed'),227));await paid('bravery mixture',{[obj('ardrigal')]:-1,[I.mixture]:-1,[I.bravery]:1},()=>q!.useOnItem(obj('ardrigal'),I.mixture));await jungle();await cave();await enterTrials(false);await descend(true);await lowerPath();
  for(const [name,item,home]of[['san_tojalon',I.a,{x:2395,z:4721}],['irvig_senay',I.b,{x:2412,z:4723}],['ranalph_devere',I.c,{x:2424,z:4701}]] as const)await combat(name,home,()=>has(item),/You have proved yourself|fought the good fight/i);
  await walk(2426,4725);for(const item of[I.a,I.b,I.c]){const last=item===I.c;await paid('fuse owned heart section',{[item]:-1,...(last?{[I.heart]:1}:{})},()=>useLoc(item,'furnace_legendsquest',2426,4726));}await walk(2410,4716);await paid('light dragons eye',{[I.heart]:-1,[I.glow]:1},()=>useLoc(I.heart,'dragons_eye_rock',2410,4715));await walk(2422,4692);await paid('open heart recess',{[I.glow]:-1},()=>useLoc(I.glow,'heart_recess_empty',2422,4691));await barrier();await boulder(false,true);
  await leaveLower();await leaveTrials();await walk(2790,9334);await firewall(false);await paid('Ungadulu holy force',{[I.dagger]:-1,[I.force]:1},()=>q!.useOnNpc(I.dagger,q!.npc(/^Ungadulu$/i)),[],120);await surface();await bank({...basic(),385:5,2434:1,567:1,557:30,564:3,1265:1,1523:1},[I.map,I.bull,I.book,I.force,I.blessed]);await jungle();await cave();await enterTrials(false);await descend(false);await lowerPath();await barrier();await boulder(false);await modal();await step('reveal Echned with Holy Force',()=>held(I.force),()=>!!sdk.getState()?.nearbyNpcs.some(n=>n.id===npcId('nezikchened')));await combat('nezikchened',{x:2395,z:4679},()=>false,/demon's body falls.*pile of ashes/i);await boulder(true);await paid('collect source sacred water',{[I.blessed]:-1,[I.pure]:1},()=>useLoc(I.blessed,'lgwaterpool',2393,4679));await leaveLower();await leaveTrials();await exitCave();
  await bank({...basic(),[I.germ]:seeds},[I.map,I.bull,I.book,I.force,I.pure,I.blessed]);await jungle();if(!has(I.pure))await fill();await walk(2778,2916);const soil={x:2778,z:2916};for(let attempt=0;attempt<seeds&&!has(I.totem);attempt++){const before=count(I.germ),plantMark=pageMark();await step('plant owned Yommi',()=>useLoc(I.germ,'fertilesoil',soil.x,soil.z),()=>count(I.germ)===before-1,[],15);if(!sdk.getState()?.nearbyLocs.some(t=>t.id===locId('yommitree_sapling')&&t.x===soil.x&&t.z===soil.z)){await waitTicks(s,3);if(!sdk.getState()?.nearbyLocs.some(t=>t.id===locId('yommitree_sapling')&&t.x===soil.x&&t.z===soil.z)){if(!sawSince(plantMark,/planted the seed incorrectly.*withers and dies/i))throw Error('Legends paid Yommi plant outcome unknown');continue;}}await paid('water owned Yommi',{[I.pure]:-1,[I.blessed]:1},()=>useLoc(I.pure,'yommitree_sapling',soil.x,soil.z),[],12);for(const [from,to]of[['yommitree_adult','yommitree_felled'],['yommitree_felled','yommitree_trimmed'],['yommitree_trimmed','yommitree_totem']]){await wait(()=>!!sdk.getState()?.nearbyLocs.some(t=>t.id===locId(from!)&&t.x===soil.x&&t.z===soil.z),8);await step('carve owned Yommi '+to,()=>useLoc(1359,from!,soil.x,soil.z),()=>!!sdk.getState()?.nearbyLocs.some(t=>t.id===locId(to!)&&t.x===soil.x&&t.z===soil.z),[],12);}await paid('take owned Yommi totem',{[I.totem]:1},()=>interact('yommitree_totem',soil.x,soil.z));}if(!has(I.totem))throw Error('Legends owned Yommi seed budget exhausted');
  await upkeep();await walk(2852,2918);await step('challenge final Nezikchened',()=>useLoc(I.totem,'lg_ord_totem_pole',2852,2917),()=>!!sdk.getState()?.nearbyNpcs.some(n=>n.id===npcId('nezikchened')),[],100);await combat('nezikchened',{x:2852,z:2918},()=>false,/final killing blow to the foul demon/i);await paid('replace corrupted totem',{[I.totem]:-1},()=>useLoc(I.totem,'lg_ord_totem_pole',2852,2917));if(!has(I.gift))await gujuo([/Ok thanks/i],()=>has(I.gift));
  await bank({...basic(),[I.map]:1,[I.gift]:1});await move(2729,3348);await step('guild return gate',()=>interact('legendsguildgatel',2728,3349),()=>pos().worldZ>=3350);await walk(2725,3367);await paid('return map and gilded totem',{[I.map]:-1,[I.gift]:-1},()=>q!.talkTo(q!.npc(/^Radimus Erkle$/i)),[],130);await walk(2727,3374);const tutor=q.npc(/^Radimus Erkle$/i);if(!tutor)throw Error('Legends hall tutor absent');await q.talkTo(tutor);await q.converse([/Yes, I'll train now/i],()=>sdk.getDialog()?.options.some(op=>/\* Attack \*/.test(op.text))??false,60);for(const skill of o.training){const before=sdk.getSkillXp(skill)??0;if(!await q.converse(legendsTrainingOptions(skill),()=>sdk.getSkillXp(skill)!-before===7650*o.xpRate,90))throw Error('Legends training exact public XP missing '+skill);}await q.converse([],()=>flag(s)==='complete',60);if(flag(s)!=='complete')throw Error('Legends public green completion flag absent');
 }catch(error){failure=String(error);}finally{working=false;if(!fatal()&&!uncertain&&!prayerUnknown){try{await prayer(false);await escapeKnownCave();await bank({});}catch(error){failure += (failure ? '; ' : '') + 'Legends cleanup '+String(error);}}q?.dispose();offPages();}
 const gearSame=JSON.stringify(sdk.getEquipment().map(i=>({id:i.id,count:i.count,slot:i.slot})))===JSON.stringify(gear),controls=sdk.getState()?.combatStyle?.currentStyle===style.currentStyle&&sdk.getState()?.autoRetaliateEnabled===retaliate&&sdk.getPrayerState()?.activePrayers.every(v=>!v)===true;return{ok:!failure&&flag(s)==='complete'&&gearSame&&controls,failure,stage:stageName,ticks:s.tick()-context.start,food,doses:potions.doses,receipts,gearSame,controls,quest:flag(s),baseline,finalAssets:allAssets(),uncertain,prayerUnknown};

 async function enterTrials(first: boolean) {
  await walk(2794, 9339);
  await trials('bookcase crevice', () => interact('shaman_bookcase', 2795, 9339, 2), () => pos().worldX >= 2799, /get stuck/i, [/Yes please/i]);
  caveReturn = 'none';
  await walk(2809, 9333);
  await trials('Thieving trial', () => interact('lglockpickgatebottoml', 2810, 9332, 2), () => pos().worldZ < 9332, /fail to pick/i);
  for (const [name, z] of [['mine_test_boulder1', 9327], ['mine_test_boulder2', 9323], ['mine_test_boulder3', 9319]] as const) {
   await walk(2809, z + 1);
   await trials('Mining trial ' + z, () => interact(name, 2809, z), () => pos().worldZ < z, /only succeed in scratching/i);
  }
  await walk(2809, 9315);
  await trials('Strength trial', () => interact('lgstrengthtrialgatel', 2810, 9314), () => pos().worldZ < 9314, /run out of steam/i, [/Yes, I'm very strong/i, /Yes, I'll try to push through/i]);
  caveReturn = 'strength';
  stageName = 'approach south crumbled wall';
  await walk(2790, 9295, 0);
  await step('jump north crumbled wall', () => interact('crumbled_wall', 2789, 9295, 2), () => near(2789, 9296, 0));
  caveReturn = 'none';
  await walk(2779, 9306);
  if (first) {
   for (const rune of [566, 558, 557, 563, 563]) {
    await paid('SMELL rune ' + rune, { [rune]: -1 }, () => useLoc(rune, 'lgancientwalldoor', 2779, 9305), [/Yes, I'll go through/i]);
   }
  } else {
   await step('known SMELL doorway', () => interact('lgancientwalldoor', 2779, 9305), () => near(2774, 9301, 1));
  }
 }
 async function leaveTrials() {
  await walk(2776, 9302);
  await step('leave gem cavern', () => interact('lgancientwalldoor', 2776, 9303), () => near(2780, 9306));
  stageName = 'approach north crumbled wall';
  await walk(2789, 9296, 0);
  await step('jump south crumbled wall', () => interact('crumbled_wall', 2789, 9295, 2), () => near(2790, 9295, 0));
  caveReturn = 'strength';
  await leaveStrengthCorridor();
 }
 async function leaveStrengthCorridor() {
  // Native's outward double door lands on the chosen leaf, not the tile beyond it.
  if (!near(2810, 9314, 0)) {
   stageName = 'return strength gate approach';
   await walk(2809, 9313);
   if (pos().worldZ >= 9314) throw Error('Legends return Strength gate south stand unobserved');
   const clearAttacker = async () => {
    // Native melee closes the gate dialogue even on a zero hit.
    const own = 32768 + (s.client as any).selfSlot;
    const wings = () => sdk.getState()?.nearbyNpcs.filter(n => n.id === npcId('deathwing') && n.targetIndex === own && n.hp !== 0 && n.animId !== 36) ?? [];
    const attackers = wings();
    if (attackers.length > 1) throw Error('Legends return gate has multiple Death wing attackers');
    const wing = attackers[0];
    if (wing) {
     const defeated = () => !!sdk.getState()?.nearbyNpcs.some(n => n.id === wing.id && n.index === wing.index && (n.hp === 0 || n.animId === 36)); // Native bat_death
     let observed = false;
     await combat('deathwing', {x: 2809, z: 9313}, () => observed ||= defeated(), null, wing.index);
     if (!observed) throw Error('Legends Death wing defeat unobserved');
     await walk(2809, 9313);
    }
    if (wings().length) throw Error('Legends return gate still has a Death wing attacker');
   };
   await trials('return strength trial', () => interact('lgstrengthtrialgatel', 2810, 9314), () => near(2810, 9314, 0), /run out of steam/i, [/Yes, I'm very strong/i, /Yes, I'll try to push through/i], 80, clearAttacker);
  }
  caveReturn = 'none';
  for (const [name, z] of [['mine_test_boulder3', 9319], ['mine_test_boulder2', 9323], ['mine_test_boulder1', 9327]] as const) {
   await walk(2809, z - 1);
   await trials('return mining ' + z, () => interact(name, 2809, z), () => pos().worldZ > z, /only succeed in scratching/i, [/Yes, I'll try to climb out/i]);
  }
  await walk(2809, 9331);
  if (pos().worldZ >= 9332) throw Error('Legends return lock gate south stand unobserved');
  await step('return lockpick gate', () => interact('lglockpickgatebottoml', 2810, 9332, 1), () => near(2810, 9332, 0));
  await walk(2799, 9340);
  await step('return bookcase crevice', () => interact('shaman_cave_crevice', 2799, 9341, 2), () => pos().worldX <= 2795, [/Yes please/i]);
  caveReturn = 'shaman';
 }
 async function escapeKnownCave() {
  const p = pos();
  if (p.level !== 0 || p.worldZ < 9000) return;
  if (caveReturn === 'strength' && p.worldX >= 2790 && p.worldX <= 2811 && p.worldZ >= 9295 && (p.worldZ < 9314 || near(2810, 9314, 0))) {
   await leaveStrengthCorridor();
  }
  const exit = pos();
  if (caveReturn !== 'shaman' || exit.worldX < 2770 || exit.worldX > 2798 || exit.worldZ < 9320 || exit.worldZ > 9343) {
   throw Error('Legends cave return has no confirmed route from this position');
  }
  await surface();
 }
 async function descend(first:boolean){
  stageName = 'magical trial gate approach';
  await walk(2763, 9312, 0);
  const gate = l('lgmagictrialgateclosed', 2762, 9313);
  const spell = componentId('magic:earth_orb');
  const mark = pageMark();
  await paid('charge-orb magical trial', {567: -1, 557: -30, 564: -3}, async () => {
   guard();
   spellOnNativeLoc(s.client, gate.x, gate.z, gate.id, spell);
  }, [], 80);
  const landed = () => near(2763, 9320, 0) && sawSince(mark, /large gaping hole/i) && !q!.dialogOpen();
  if (!await q!.converse([], () => fatal() || landed(), 40) || fatal() || !landed()) {
   throw Error('Legends orb trial landing and dialogue unobserved');
  }
  await walk(2759,9328);if(first)await paid('tie owned rope',{954:-1},()=>useLoc(954,'lg_winchdown_norope',2759,9329));else await step('find own tied rope',()=>interact('lg_winchdown_norope',2759,9329),()=>!!sdk.getState()?.nearbyLocs.some(t=>t.id===locId('lg_winchdown_rope')));if(first)await paid('drink bravery',{[I.bravery]:-1,229:1},()=>held(I.bravery),[/Yes, I'll bravely drink/i]);await upkeep();await step('descend owned rope',()=>interact('lg_winchdown_rope',2759,9329),()=>near(2377,4712,1),[/Yes, I'll shimmy down/i],70);await upkeep();}
 async function lowerPath(){for(const [name,x,z,after]of[['rocky_ledge',2377,4717,{x:2376,z:4717}],['rocky_ledge1',2377,4728,{x:2378,z:4728}],['rocky_ledge2',2382,4729,{x:2382,z:4728}],['viycaves_climbrock1',2387,4728,{x:2388,z:4728}],['viycaves_climbrock2',2390,4724,{x:2390,z:4723}],['viycaves_climbrock3',2390,4718,{x:2390,z:4717}]] as const){await walk(x,z,1);await upkeep();await trials(name,()=>interact(name,x,z),()=>near(after.x,after.z,0),/slip and fall|near fall|nasty fall|nervous/i,[/Yes, I can think of nothing more exciting/i,/Yes, I want to climb/i],65);}}
 async function barrier(){await walk(2421,4691);await step('heart-authorized barrier',()=>interact('legendsquest_force_barrier',2421,4690),()=>near(2421,4690,0));}
 async function boulder(push:boolean,first=false){await walk(push?2395:2394,4679,0);const n=sdk.getState()?.nearbyNpcs.find(n=>n.id===npcId('boulder_legends'));if(!n)throw Error('Legends observed source boulder absent');const send=()=>s.direct({type:'interactNpc',npcIndex:n.index,optionIndex:1,reason:'Legends source quest'});if(first){await paid('spirit dark dagger',{[I.dagger]:1},send,[/Er... me/i,/Yes, I need it for my quest/i,/What can I do about/i,/I'll do what I must/i],130);return;}if(push){await step('push source boulder',send,()=>!!sdk.getState()?.nearbyLocs.some(t=>t.id===locId('lgwaterpool')),[],30);return;}await send();if(!await q!.converse([],()=>!!sdk.getState()?.nearbyNpcs.some(n=>n.id===npcId('echned_zekin')),50))throw Error('Legends source spirit absent');}
 async function leaveLower(){await walk(2421,4690);await step('return heart barrier',()=>interact('legendsquest_force_barrier',2421,4690),()=>near(2421,4691,0));for(const [name,x,z]of[['viycaves_climbrock3',2390,4718],['viycaves_climbrock2',2390,4724],['viycaves_climbrock1',2387,4728],['rocky_ledge2',2382,4729],['rocky_ledge1',2377,4728],['rocky_ledge',2377,4717]] as const){await walk(x,z,1);const p={x:pos().worldX,z:pos().worldZ};await step('return '+name,()=>interact(name,x,z),()=>!near(p.x,p.z,0),[/Yes, I want to climb/i,/Yes, I can think/i],65);await upkeep();}await walk(2377,4712);await step('climb own lower rope',()=>interact('lgclimbrope_viyeldicaves',2377,4711),()=>near(2760,9328));await walk(2763,9318);await step('return magical trial portal',()=>interact('lgmagictrialgateclosed',2762,9317),()=>near(2763,9312,0));}
}

if(import.meta.main){const path=process.argv[2];if(!path)throw Error('usage: quest-legends-owned.ts <explicit-order.json>');const order=JSON.parse(readFileSync(path,'utf8')) as LegendsOrder;validateLegendsOrder(order);let stopped=false;const s=await openBot(order.account,{onStop:async()=>{stopped=true;}}),owns=legendsLoginOwner(s);let ok=false,detail='';try{const result=await runLegends(s,order,()=>stopped);console.log('LEGENDS '+JSON.stringify(result));ok=result.ok;detail=JSON.stringify(result);}catch(error){detail=String(error);}if(!await finishLegendsOwned(s,owns,ok,detail))process.exitCode=1;}
