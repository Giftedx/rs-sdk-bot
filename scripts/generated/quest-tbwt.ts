// Native Tai Bwo Wannai Trio. Behaviour source: pinned QuestHelper TaiBwoWannaiTrio.java;
// BSD notice: research/microbot-ports-LICENSE.txt. Only transmitted progress 320/321 is read.
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,settle} from '../../packages/core/src/bot';
import type {Session} from '../../packages/core/src/inprocess';
import {questFlags} from '../../packages/core/src/quest-status';
import {waitTicks,waitUntil} from '../../packages/core/src/ticks';
import {BotActions} from '../../vendor/rs-sdk/sdk/actions';
import {componentId} from '../../packages/core/src/logout';
import {openQuest} from './quest-lib';
import {productionEffect,type InventoryRecipe} from '../microbot-production';
import {cookingRecipes,runCookingBatch} from '../microbot-b-cooking';
import {nativeNpcSpell,runNpcMagic} from '../microbot-magic-npc';
import {runVisibleGroundLoot} from '../microbot-b-mining-loot';
import {productionStopRequested} from '../microbot-c-lifetime';
import type {BotWorldState} from '../../vendor/rs-sdk/sdk/types';

export async function trioCompleteScreen(s:Session,reward:()=>boolean,guard:()=>void,remaining:number){guard();const ui=s.sdk.getState()?.interface,root=componentId('questscroll_tbwt');if(remaining<1||!reward()||!ui?.isOpen||ui.interfaceId!==root)throw Error('Trio exact completed reward screen unconfirmed');const stock=pack(s),beforeXp=xp(s);try{await s.sdk.sendCloseModal();}catch{/* This sole known screen acknowledgement may still close it. */}if(!await waitUntil(s,()=>{guard();return reward()&&screenClosed();},{timeoutTicks:Math.min(12,remaining)}))throw Error('Trio quest completion screen close unknown; no repeat');function screenClosed(){return s.sdk.getState()?.interface.isOpen===false&&trioPackEffect(stock,pack(s),{})&&JSON.stringify(beforeXp)===JSON.stringify(xp(s));}}
export const TRIO_TIMFRAKU_TERMINAL=/You should go and see my sons in the village\. I think they have something for you\./i;
export const TRIO_TAMAYU_AGILITY_TERMINAL=/I feel agile enough to finally match the Shaikahan!/i;
export const TRIO_ITEMS={bait:3150,agility4:3032,ironKp:3171,pastyBones:3128,marinated:3130,bananaRum:3164,seaweed:401,mind:558,food:379,vessel:3157,loaded:3159,manual:3161,corpse:3166,skin:3167,sandwich:3168,monkeyBones:3183,runeKp:3175} as const;
export const TRIO_RECIPES:InventoryRecipe[]=[
 {name:'Trio vessel bait',inputs:[{id:3157,units:1},{id:3150,units:1}],tools:[],product:3159,skill:'Cooking',level:1,xp:false,members:true,source:'quest_tbwt.rs2'},
 {name:'Trio seaweed skin sandwich',inputs:[{id:3167,units:1},{id:401,units:1}],tools:[],product:3168,skill:'Cooking',level:1,xp:false,members:true,source:'quest_tbwt.rs2'},
];
const I=TRIO_ITEMS,HOME={x:2781,z:3087},TAMAYU={x:2844,z:3042},TIADECHE={x:2912,z:3118},TINSAY={x:2764,z:2976},LUBUFU={x:2770,z:3169};
export type TrioOrder={cap:number;xpRate:number;maximumCasts:number};
type LogState={x:number;z:number;level:number;hp:number;stock:Record<number,number>;xp:Record<string,number>};
type LogHealth={hp:number;falls:number;regens:number;damage:number};
export function trioLogHealth(initial:number,base:number,start:number){
 // login.rs2 sets health_regen to100; stat.rs2 heals one up to base HP.
 // Its phase is hidden. Rapid Heal must stay off throughout the48-tick crossing.
 if(![initial,base,start].every(Number.isSafeInteger)||initial<35||initial>base)throw Error('Trio log base HP unknown');
 let candidates:LogHealth[]=[{hp:initial,falls:0,regens:0,damage:0}],last=start;
 return(hp:number,tick:number,fallKnown:boolean)=>{
  if(!Number.isSafeInteger(hp)||hp<35||hp>base||tick<last||tick-start>48)throw Error('Trio log health trajectory changed');
  const next=new Map<string,LogHealth>();
  for(const prior of candidates)for(const events of [[],['regen'],['fall'],['regen','fall'],['fall','regen']]){
   const c={...prior};let valid=true;
   for(const event of events){if(event==='regen'){if(tick===last||c.regens>=Math.ceil((tick-start)/100)||c.hp>=base){valid=false;break;}c.hp++;c.regens++;}else{if(!fallKnown||c.falls){valid=false;break;}c.damage=Math.floor(c.hp*6/100)+1;c.hp-=c.damage;c.falls++;}}
   if(valid&&c.hp===hp)next.set(JSON.stringify(c),c);
  }
  last=tick;candidates=[...next.values()];if(!candidates.length)throw Error('Trio log unexplained damage/healing');return candidates;
 };
}
export function trioLogLoc(s:Session,east:boolean,owns:()=>boolean,type:{name?:string;op?:readonly(string|null)[]}|undefined){
 if(!owns()||s.sdk.getStateAge()>5000)return;
 const c=s.client as any,p=s.sdk.getState()?.player,worldX=east?2907:2909,x=worldX-c.mapBuildBaseX,z=3049-c.mapBuildBaseZ;
 if(!p||p.isDead||p.level!==0||c.minusedlevel!==0||p.worldX!==(east?2906:2910)||p.worldZ!==3049||![x,z].every(Number.isInteger)||x<0||z<0||x>=104||z>=104||type?.name!=='A wooden log'||type.op?.[0]!=='Cross')return;
 const tag=c.world?.gdType(1,x,z);
 if(!Number.isInteger(tag)||((tag>>>29)&3)!==2||((tag>>>14)&0x7fff)!==2332||(tag&127)!==x||((tag>>>7)&127)!==z||!owns())return;
 return{id:2332,name:type.name,x:worldX,z:3049,level:0,distance:1,optionsWithIndex:[{text:type.op[0],opIndex:1}],options:[type.op[0]]};
}
export function trioLogEffect(before:LogState,after:LogState,east:boolean,rate:number,successMessage:boolean,failureMessage:boolean,health?:readonly LogHealth[]){
 if(before.x!==(east?2906:2910)||before.z!==3049||before.level!==0||!trioPackEffect(before.stock,after.stock,{})||after.level!==0)return;
 const delta=after.xp.Agility-before.xp.Agility;
 if([...new Set([...Object.keys(before.xp),...Object.keys(after.xp)])].some(k=>k!=='Agility'&&after.xp[k]!==before.xp[k]))return;
 if(successMessage&&!failureMessage&&after.x===before.x+(east?4:-4)&&after.z===3049&&(health?health.some(h=>h.falls===0):after.hp===before.hp)&&delta===4*rate)return{kind:'success' as const,hpLoss:before.hp-after.hp,agilityXP:delta};
 const damage=Math.floor(before.hp*6/100)+1;
 if(failureMessage&&!successMessage&&after.x===(east?2909:2903)&&after.z===(east?3059:3057)&&(health?health.some(h=>h.falls===1):after.hp===before.hp-damage)&&after.hp>=35&&delta===2*rate)return{kind:'washed' as const,hpLoss:before.hp-after.hp,agilityXP:delta};
}
export function trioLogMessages(messages:readonly{type:number;sender?:string;fromSelf?:boolean;observationId?:number;text:string}[],cursor:number){const fresh=messages.filter(m=>m.type===0&&m.sender===''&&m.fromSelf===false&&Number.isSafeInteger(m.observationId)&&m.observationId!>cursor).map(m=>m.text);return{success:fresh.includes('You make it across the log without any problems.'),failure:fresh.includes('You lose your footing and fall into the water.')&&fresh.includes('You finally come to shore.')};}
export async function trioLogCrossing(io:{tick():number;read():LogState;baseHP():number;rapidHealOff():boolean;guard():void;send():Promise<unknown>;step():Promise<void>;messages():{success:boolean;failure:boolean}},east:boolean,rate:number){
 io.guard();const before=io.read(),start=io.tick();if(before.level!==0||before.x!==(east?2906:2910)||before.z!==3049||before.hp-(Math.floor(before.hp*6/100)+1)<35)throw Error('Trio funded exact log approach required');
 const baseHP=io.baseHP(),observeHealth=trioLogHealth(before.hp,baseHP,start);if(!io.rapidHealOff())throw Error('Trio log Rapid Heal must be observed off');
 let replyUnknown=false;try{await io.send();}catch{replyUnknown=true;}
 let quiet=0,last='';for(;;){io.guard();if(!io.rapidHealOff()||io.baseHP()!==baseHP)throw Error('Trio log regen policy changed');const after=io.read(),messages=io.messages(),health=observeHealth(after.hp,io.tick(),messages.failure),effect=trioLogEffect(before,after,east,rate,messages.success,messages.failure,health),key=effect?JSON.stringify(after):'';quiet=effect?(key===last?quiet+1:1):0;last=key;
  if(effect&&quiet>=3)return{...effect,east,replyUnknown,start,end:io.tick(),before,after,healthTrajectories:health.filter(h=>h.falls===(effect.kind==='washed'?1:0))};
  if(io.tick()-start>=48)throw Error('Trio log effect unknown; no repeat');await io.step();
 }
}
export function trioPackEffect(b:Readonly<Record<number,number>>,a:Readonly<Record<number,number>>,d:Readonly<Record<number,number>>){return [...new Set([...Object.keys(b),...Object.keys(a),...Object.keys(d)])].every(k=>(a[+k]??0)-(b[+k]??0)===(d[+k]??0));}
export async function trioOwnedHandover(io:{read:()=>Record<number,number>;guard:()=>void;send:()=>Promise<unknown>;settle:(done:()=>boolean)=>Promise<boolean>},delta:Record<number,number>,extra:()=>boolean=()=>true){
 io.guard();const before={...io.read()};let replyUnknown=false;
 try{await io.send();}catch{replyUnknown=true;}
 const done=()=>{io.guard();return trioPackEffect(before,io.read(),delta)&&extra();};
 if(!await io.settle(done)||!done())throw Error('Trio owned handover unconfirmed; no retry'+(replyUnknown?' (reply unknown)':''));
 return{before,after:{...io.read()},delta:{...delta},replyUnknown};
}
export type TrioHuntPoint={tick:number;x:number;z:number;level:number;life:number;respawns:number;fresh:boolean;tamayu?:{id:number;index:number;x:number;z:number}};
export function trioHuntPoint(s:Session,index:number):TrioHuntPoint|undefined{const st=s.sdk.getState(),p=st?.player,c=s.client as any,n=st?.nearbyNpcs.find(n=>n.id===1167&&n.index===index),native=c.npc?.[index];if(!p)return;
 const x=c.mapBuildBaseX+native?.routeX?.[0],z=c.mapBuildBaseZ+native?.routeZ?.[0];
 return{tick:s.tick(),x:p.worldX,z:p.worldZ,level:p.level,life:p.lifeId,respawns:p.respawnCount,fresh:s.sdk.getStateAge()<=5000&&c.mapBuildBaseX+c.localPlayer?.routeX?.[0]===p.worldX&&c.mapBuildBaseZ+c.localPlayer?.routeZ?.[0]===p.worldZ&&c.minusedlevel===p.level,tamayu:n&&native?.type?.id===1167&&[x,z].every(Number.isSafeInteger)?{id:1167,index,x,z}:undefined};
}
export function trioHuntReceipt(points:readonly TrioHuntPoint[],second:boolean,context:{index:number;life:number;respawns:number}){let away=false,returned:number|undefined;
 for(const p of points){if(p.life!==context.life||p.respawns!==context.respawns)return false;if(!p.fresh||p.level!==0)continue;
  if(p.x===(second?2537:2520)&&p.z===4568)away=true;
  if(!away||p.z>=4000)continue;returned??=points.indexOf(p);
  if(second)return p.x===2848&&p.z===3039;
  const first=points[returned]!;if(p.x!==first.x||p.z!==first.z||p.tick-first.tick>1)return false;
  const n=p.tamayu;if(!n||n.id!==1167||n.index!==context.index||![n.x,n.z].every(Number.isSafeInteger))continue;
  const nativeFindDistance=Math.max(Math.abs(n.x-2844),Math.abs(n.z-3042)),distance=nativeFindDistance<=5?Math.max(Math.abs(p.x-n.x),Math.abs(p.z-n.z)):Math.max(Math.abs(p.x-2844),Math.abs(p.z-3042));
  if(distance>=2&&distance<=4)return true;
 }return false;
}
export function trioOwnedActions(raw:Session,guard:()=>void):Session{
 const sdk=new Proxy(raw.sdk,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);return typeof value==='function'?function(...args:unknown[]){if(String(key).startsWith('send'))guard();return value.apply(receiver,args);}:value;}}),bot=new BotActions(sdk);
 const view=Object.create(raw) as Session;Object.defineProperties(view,{sdk:{value:sdk},bot:{value:bot},direct:{value:(a:Parameters<Session['direct']>[0])=>{guard();return raw.direct(a);}}});return view;
}
export function trioMonkeySession(s:Session,index:number):Session{const sdk=new Proxy(s.sdk,{get(target,key,receiver){if(key==='getState')return()=>{const st=target.getState();return st?{...st,nearbyNpcs:st.nearbyNpcs.filter(n=>n.index===index)}:st;};const v=Reflect.get(target,key,receiver);return typeof v==='function'?function(...args:unknown[]){return v.apply(receiver,args);}:v;}});const view=Object.create(s)as Session;Object.defineProperty(view,'sdk',{value:sdk});return view;}
export function trioOwnContext(s:Session){const client=s.client as any,owner=client.executeBotAction,selfSlot=client.selfSlot,p=s.sdk.getState()?.player,life=p?.lifeId,respawns=p?.respawnCount;return()=>{const now=s.sdk.getState()?.player;return !!p&&s.client===client&&client.executeBotAction===owner&&client.selfSlot===selfSlot&&!!now&&!now.isDead&&now.lifeId===life&&now.respawnCount===respawns;};}
export function trioDialogReceipt(read:()=>Pick<BotWorldState,'recentDialogs'|'dialog'>|null,tick:()=>number){
 const before=read(),cursor=Math.max(-1,...(before?.recentDialogs??[]).map(d=>d.observationId??-1)),page=before?.dialog.pageId,start=tick();
 return(re:RegExp)=>{const st=read();if(!st)return false;if(st.recentDialogs.some(d=>Number.isSafeInteger(d.observationId)&&d.observationId!>cursor&&d.tick>=start&&re.test(d.text.join(' '))))return true;
  const d=st.dialog;return d.isOpen&&!!d.pageId&&d.pageId!==page&&tick()>=start&&re.test([d.text??'',...(d.allComponents??[]).map(c=>c.text)].join(' '));};
}
export function trioMonkeyContinuation(n:{id:number;index:number;targetIndex:number;lastCombatTick:number|null},index:number,claim:{start:number;end:number;combat:number}|undefined,tick:number,continuous:boolean){return continuous&&!!claim&&n.id===132&&n.index===index&&n.targetIndex===-1&&Number.isSafeInteger(n.lastCombatTick)&&n.lastCombatTick===claim.combat&&claim.combat>=claim.start&&claim.combat<=claim.end&&tick>=claim.end&&tick-claim.end<=45;}
export function trioRenewMonkeyClaim(prior:{start:number;end:number;combat:number}|undefined,child:{ok:boolean;casts:number;attempts:number;start:number;end:number},combat:number|null|undefined){if(!child.ok||child.casts!==1||child.attempts!==1||!Number.isSafeInteger(combat)||child.end<child.start||child.end-child.start>45)return;if(combat!>=child.start&&combat!<=child.end)return{start:child.start,end:child.end,combat:combat!};if(prior&&combat===prior.combat&&prior.combat>=prior.start&&prior.combat<=prior.end&&child.start>=prior.end&&child.start-prior.end<=45)return{...prior,end:child.end};}
export function trioMonkeyBinding(n:{id:number;index:number;targetIndex:number}|undefined,current:unknown,original:unknown,index:number,uid:number,corpse:boolean){return !n?corpse:!!original&&current===original&&n.index===index&&n.id===132&&(n.targetIndex===-1||n.targetIndex===uid);}
export function trioMonkeyXpReceipt(casts:number,magicDelta:number,hpDelta:number,rate:number,ticks=0){
 // Native Monkey has6HP; Npc.processRegen restores at most1 per100 ticks.
 // Whole public XP may hide a fractional starting balance. Adjacent damage
 // credits differ by2XP per rate, so this pair still identifies one amount.
 const candidates=[];for(let damage=6;damage<=6+Math.ceil(ticks/100);damage++){const magic=(casts*55+damage*20)*rate/10,hp=damage*13*rate/10;if(casts>=1&&[Math.floor(magic),Math.ceil(magic)].includes(magicDelta)&&[Math.floor(hp),Math.ceil(hp)].includes(hpDelta))candidates.push(damage);}return candidates.length===1?candidates[0]!:false;
}
const pack=(s:Session)=>{const a:Record<number,number>={};for(const r of s.sdk.getInventory())a[r.id]=(a[r.id]??0)+r.count;return a;};
const gear=(s:Session)=>JSON.stringify(s.sdk.getEquipment().map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot));
const xp=(s:Session)=>Object.fromEntries((s.sdk.getState()?.skills??[]).map(k=>[k.name,k.experience]));
export function trioAdmission(s:Session,flags:typeof questFlags=questFlags){
 const f=flags(s.client),p=s.sdk.getState()?.player,items=pack(s),client=s.client as any;
 if(!f?.some(q=>q.name==='Jungle Potion'&&q.state==='complete')||!f.some(q=>q.name==='Tai Bwo Wannai Trio'&&q.state==='not started')||client.var?.[320]!==0||client.var?.[321]!==0)throw Error('fresh Trio and observed completed Jungle Potion required; no private progress recovery');
 if(client.membersAccount!==1||!p||p.isDead||p.level!==0||Math.max(Math.abs(p.worldX-HOME.x),Math.abs(p.worldZ-HOME.z))>12)throw Error('Trio member session at Timfraku surface required');
 for(const [name,min] of [['Cooking',30],['Agility',15],['Fishing',5],['Magic',1],['Hitpoints',70]] as const)if((s.sdk.getSkill(name)?.level??0)<min)throw Error('Trio required skill/health '+name);
 for(const [id,n]of Object.entries({3150:21,3032:1,3171:1,3128:1,3164:1,401:1,558:20,379:1}))if((items[+id]??0)<n)throw Error('Trio owned staged input missing '+id);
 if([3157,3159,3161,3166,3167,3168,3130,3175].some(id=>items[id]))throw Error('fresh Trio must earn progress items');
 if(!s.sdk.getEquipment().some(i=>i.slot===3&&i.id===1381)||client.var?.[108]!==0)throw Error('Trio worn Air staff and observed normal manual magic required');
}

export async function runTaiBwoWannaiTrio(raw:Session,o:TrioOrder,requestStop:()=>boolean=()=>false){
 if(!o||!Number.isSafeInteger(o.cap)||o.cap<1000||o.cap>15000||!Number.isSafeInteger(o.xpRate)||o.xpRate<1||o.xpRate>1000||!Number.isSafeInteger(o.maximumCasts)||o.maximumCasts<1||o.maximumCasts>40)throw Error('finite Trio cap, explicit native XP rate and cast bound required');
 trioAdmission(raw);if((pack(raw)[558]??0)<o.maximumCasts)throw Error('Trio declared cast bound requires owned Mind rune reserve');const client=raw.client as any,executor=client.executeBotAction,first=raw.sdk.getState()!.player!,life=first.lifeId,respawns=first.respawnCount,kit=gear(raw),initial=pack(raw),start=raw.tick(),baseline=xp(raw),retaliate=raw.sdk.getState()!.autoRetaliateEnabled,questPoints0=client.var?.[101];if(!Number.isSafeInteger(questPoints0))throw Error('Trio initial public quest points unknown');
 let ended=false,casts=0,phase='start',targetGuard=()=>{};void raw.ended.then(()=>{ended=true;});const ledger:Record<number,number>={},steps:string[]=[];
 const selfSlot=client.selfSlot;const fatal=()=>{const p=raw.sdk.getState()?.player;return ended||raw.client!==client||client.executeBotAction!==executor||client.selfSlot!==selfSlot||!p||p.isDead||p.lifeId!==life||p.respawnCount!==respawns||(raw.sdk.getSkill('Hitpoints')?.level??0)<35||raw.sdk.getStateAge()>5000;};
 const over=()=>fatal()||requestStop()||raw.tick()-start>=o.cap;
 const guard=()=>{if(over()||gear(raw)!==kit||raw.sdk.getState()?.nearbyPlayers.length)throw Error('Trio stopped, original life/kit/owner/isolated area changed at '+phase);targetGuard();};
 const s=trioOwnedActions(raw,guard);
 const q=await openQuest({session:s,cap:o.cap,stop:over,reservedFood:{379:1},food:[379],eatAt:35});
 const {default:ClientLocType}=await import(resolve('vendor/rs-sdk/server/webclient/src/config/LocType.ts'));guard();
 const logCrossings:Awaited<ReturnType<typeof trioLogCrossing>>[]=[];
 const progress=(id:320|321):number=>client.var?.[id];
 const add=(d:Record<number,number>)=>{for(const[id,n]of Object.entries(d))ledger[+id]=(ledger[+id]??0)+n;};
 const mark=(label:string)=>{steps.push(label);console.log('TRIO_STEP '+JSON.stringify({label,tick:s.tick(),main:progress(320),tiadeche:progress(321),items:pack(s)}));};
 const quiet=async()=>{let shut=0;if(!await q.converse([/^no$/i],()=>{guard();shut=q.dialogOpen()?0:shut+1;return shut>=3;},100))throw Error('Trio dialogue settlement unknown');};
 const talk=async(label:string,name:RegExp,home:{x:number;z:number},patterns:RegExp[],done:()=>boolean,text?:RegExp)=>{phase=label;guard();await q.walk(label+' approach',[{...home,tol:2}]);guard();const ids=progress(320)===6?[1162,1164,1166,1168,1171]:[1162,1163,1165,1167,1171],n=s.sdk.getState()?.nearbyNpcs.filter(n=>name.test(n.name)&&ids.includes(n.id)).sort((a,b)=>a.distance-b.distance)[0];if(!n||client.npc?.[n.index]?.type?.id!==n.id)throw Error('Trio exact native talk target absent '+label);const seen=trioDialogReceipt(()=>s.sdk.getState(),()=>s.tick()),native=client.npc?.[n.index];
  // A native page can close for4/10 ticks before its next page. Keep one
  // conversation alive through that pause instead of talking again.
  try{await q.talkTo(n);}catch(e){console.log('TRIO_TALK_REPLY_UNKNOWN '+label+' '+String(e));}
  const deadline=s.tick()+160,original=()=>{guard();if(client.npc?.[n.index]!==native||native.type?.id!==n.id)throw Error('Trio original talk NPC replaced');};if(label==='Timfraku quest reward'){if(!await q.converse(patterns,()=>{original();const ui=s.sdk.getState()?.interface;return done()&&ui?.isOpen===true&&ui.interfaceId===componentId('questscroll_tbwt');},160))throw Error('Trio completed reward screen absent; no repeat');await trioCompleteScreen(s,done,original,deadline-s.tick());}
  if(s.tick()>=deadline||!await q.converse(patterns,()=>{original();return done()&&(!text||seen(text));},deadline-s.tick()))throw Error('Trio conversation unconfirmed; no repeat '+label);guard();await quiet();mark(label);
 };
 const freshTalk=async(label:string,name:RegExp,home:{x:number;z:number},patterns:RegExp[],text:RegExp)=>talk(label,name,home,patterns,()=>true,text);
 const move=async(label:string,x:number,z:number,tol=2)=>{phase=label;guard();await q.walk(label,[{x,z,tol}]);guard();};
 const crossLog=async(east:boolean)=>{phase=east?'river log east':'river log west';await move(phase+' approach',east?2906:2910,3049,0);guard();
  if(!trioLogLoc(s,east,()=>{guard();return true;},ClientLocType.list(2332)))throw Error('Trio loaded native river log unobserved before input');
  const cursor=Math.max(-1,...(s.sdk.getState()?.gameMessages??[]).map(m=>m.observationId??-1));
  const receipt=await trioLogCrossing({tick:()=>s.tick(),guard,baseHP:()=>s.sdk.getSkill('Hitpoints')?.baseLevel??NaN,rapidHealOff:()=>s.sdk.getState()?.prayers.activePrayers[7]===false,read:()=>({x:q.pos().worldX,z:q.pos().worldZ,level:q.lvl(),hp:s.sdk.getSkill('Hitpoints')?.level??0,stock:pack(s),xp:xp(s)}),
   send:async()=>{guard();const loc=trioLogLoc(s,east,()=>{guard();return true;},ClientLocType.list(2332));if(!loc)throw Error('Trio loaded native river log unobserved');return q.opLoc(loc,1);},step:()=>waitTicks(s,1),
   messages:()=>trioLogMessages(s.sdk.getState()?.gameMessages??[],cursor)},east,o.xpRate);
  logCrossings.push(receipt);console.log('TRIO_LOG_CROSSING '+JSON.stringify(receipt));
 };
 const hand=async(label:string,id:number,npcId:number,home:{x:number;z:number},delta:Record<number,number>,patterns:RegExp[]=[],extra:()=>boolean=()=>true,text?:RegExp)=>{
  phase=label;await move(label+' approach',home.x,home.z,2);guard();const n=s.sdk.getState()?.nearbyNpcs.find(n=>n.id===npcId&&n.reachable!==false);if(!n)throw Error('Trio exact native handover NPC absent '+npcId);const native=client.npc?.[n.index];if(!native||native.type?.id!==npcId)throw Error('Trio native handover identity unknown');
  // Dialogue can precede the debit. One dispatch only, including transport-unknown replies.
  const seen=trioDialogReceipt(()=>s.sdk.getState(),()=>s.tick()),receipt=await trioOwnedHandover({read:()=>pack(s),guard:()=>{guard();if(client.npc?.[n.index]!==native||native.type?.id!==npcId)throw Error('Trio original handover NPC replaced');},send:async()=>q.useOnNpc(id,n),settle:done=>q.converse(patterns,done,130)},delta,()=>extra()&&(!text||seen(text)));
  console.log('TRIO_HANDOVER '+JSON.stringify({label,...receipt}));add(delta);await quiet();mark(label);
 };
 const combine=async(r:InventoryRecipe)=>{phase=r.name;guard();const before={items:pack(s),xp:q.xp(r.skill)};try{await q.useOnItem(r.inputs[0]!.id,r.inputs[1]!.id);}catch(e){console.log('TRIO_INPUT_UNKNOWN '+String(e));}if(!await waitUntil(s,()=>over()||productionEffect(r,before,{items:pack(s),xp:q.xp(r.skill)})!=='none',{timeoutTicks:12})||over()||productionEffect(r,before,{items:pack(s),xp:q.xp(r.skill)})!=='made')throw Error('Trio combination unconfirmed; no retry');const d:Record<number,number>={[r.product]:1};for(const i of r.inputs)d[i.id]=-i.units;add(d);await quiet();mark(r.name);};
 const hut=async(up:boolean)=>{await move('Timfraku ladder',2782,3087,1);const id=up?1747:1746;await q.step(up?'Timfraku upstairs':'Timfraku downstairs',()=>{guard();const l=q.findLoc(l=>l.id===id&&l.x===2782&&l.z===3087);if(!l)throw Error('Trio observed exact hut ladder absent');return q.opLoc(l,1);},()=>q.lvl()===(up?1:0),16,1);};
 const hunt=async(second:boolean)=>{const label=second?'Tamayu supplied hunt':'Tamayu first hunt';phase=label;await move(label+' approach',TAMAYU.x,TAMAYU.z,2);const n=s.sdk.getState()?.nearbyNpcs.find(n=>n.id===1167);if(!n)throw Error('Trio exact Tamayu absent');const context={index:n.index,life,respawns},points:TrioHuntPoint[]=[],off=s.onTick(()=>{const point=trioHuntPoint(s,n.index);if(point)points.push(point);});try{
  // A silent cutscene lasts more than three closed-dialog ticks. Do not use
  // talk's idle-dialog retry during an already accepted hunt.
  guard();await q.talkTo(n);if(!await q.converse(second?[/take me on your next hunt/i]:[/when will you succeed/i,/^yes$/i],()=>{guard();return trioHuntReceipt(points,second,context);},160))throw Error('Trio actual hunt excursion/return absent; no repeat');await quiet();mark(label);
 }finally{off();}};
 try{
  await hut(true);await talk('Timfraku start',/^Timfraku$/i,HOME,[/roving adventurer/i,/trufitus sent me/i,/your gratitude/i,/^yes$/i],()=>progress(320)===3);await hut(false);
  await freshTalk('Lubufu introduction',/^Lubufu$/i,LUBUFU,[/who are you/i],/what a foolish question! now leave/i);await waitTicks(s,11);
  await freshTalk('Lubufu bait request',/^Lubufu$/i,LUBUFU,[/talk about him/i,/how old are you/i,/help collect the bait/i,/sound like you could do with the help/i],/return here as soon as you have caught 20/i);
  const baitBefore=pack(s);await talk('Lubufu twenty bait',/^Lubufu$/i,LUBUFU,[],()=>trioPackEffect(baitBefore,pack(s),{3150:-20}));add({3150:-20});
  await freshTalk('Lubufu octopus',/^Lubufu$/i,LUBUFU,[/^what is a Karambwan\?$/i],/really ought to know/i);
  await freshTalk('Lubufu restaurant',/^Lubufu$/i,LUBUFU,[/what do you do with your Karambwan/i],/before you ask/i);
  const fishing=q.xp('Fishing'),vesselBefore=pack(s);await talk('Lubufu apprenticeship',/^Lubufu$/i,LUBUFU,[/what do you use to catch/i,/^yes!$/i],()=>trioPackEffect(vesselBefore,pack(s),{3157:1})&&q.xp('Fishing')-fishing===1500*o.xpRate);add({3157:1});
  await crossLog(true);await talk('Tiadeche news',/^Tiadeche$/i,TIADECHE,[/anything I can do/i],()=>progress(321)===2,/something .*helpful/i);
  await combine(TRIO_RECIPES[0]!);await hand('Tiadeche vessel',3159,1163,TIADECHE,{3159:-1},[/^no$/i],()=>progress(321)===4);
  await crossLog(false);const recovered=pack(s);await talk('Lubufu lost vessel',/^Lubufu$/i,LUBUFU,[/lost my Karambwan vessel/i,/floated away/i],()=>trioPackEffect(recovered,pack(s),{3157:1}));add({3157:1});
  await freshTalk('Tamayu news',/^Tamayu$/i,TAMAYU,[],/vow upon the blood/i);await hunt(false);
  await hand('Tamayu agility',3032,1167,TAMAYU,{3032:-1},[],()=>true,TRIO_TAMAYU_AGILITY_TERMINAL);await hand('Tamayu poisoned spear',3171,1167,TAMAYU,{3171:-1});await hunt(true);
  await move('native Monkey clearing',2835,3030,2);const monkey=s.sdk.getState()?.nearbyNpcs.filter(n=>n.id===132&&(n.hp===null||n.hp===6)&&(n.maxHp==null||n.maxHp===6)&&n.reachable!==false&&!n.inCombat).sort((a,b)=>a.distance-b.distance)[0];
  if(!monkey||s.sdk.getState()?.groundItems.some(i=>i.id===3166))throw Error('Trio fresh unclaimed Monkey/corpse area required');const index=monkey.index,native=client.npc?.[index];if(!native||native.type?.id!==132)throw Error('Trio native Monkey identity absent');let corpse=false,gone=false,last={x:monkey.x,z:monkey.z};
  const watch=()=>{const n=raw.sdk.getState()?.nearbyNpcs.find(n=>n.index===index);if(n){if(!trioMonkeyBinding(n,client.npc?.[index],native,index,32768+selfSlot,corpse)||native.type?.id!==132)throw Error('Trio original Monkey ownership changed');last={x:n.x,z:n.z};corpse ||=n.hp===0||n.animId===223;}else if(corpse)gone=true;};
  const scoped=trioMonkeySession(s,index);
  let monkeyProblem='',accepted:{start:number;end:number;combat:number}|undefined;const passive=(n:Parameters<typeof trioMonkeyContinuation>[0])=>{guard();watch();return trioMonkeyContinuation(n,index,accepted,s.tick(),!corpse&&!gone&&raw.sdk.getStateAge()<=5000&&client.npc?.[index]===native&&native.type?.id===132);};targetGuard=()=>{if(monkeyProblem)throw Error(monkeyProblem);watch();};const offMonkey=s.onTick(()=>{try{watch();}catch(e){monkeyProblem=String(e);}});const mindBefore=q.cnt(558),monkeyMagic=q.xp('Magic'),monkeyHp=q.xp('Hitpoints'),monkeyStart=s.tick();try{while(!gone&&casts<o.maximumCasts){guard();watch();if(gone)break;if(!corpse){const childStart=s.tick(),r=await runNpcMagic(scoped,nativeNpcSpell('wind_strike'),{npc:132,casts:1,cap:45,members:true,hpFloor:35,ownedPassiveTarget:passive,stop:()=>over()||!!monkeyProblem});casts+=r.casts;if(!r.ok){console.log('TRIO_MONKEY_FAILURE '+JSON.stringify({child:r,monkeyProblem,parentOver:over(),parentFatal:fatal(),requestStop:requestStop(),stateAge:raw.sdk.getStateAge(),ingame:client.ingame,originalClient:raw.client===client,originalExecutor:client.executeBotAction===executor,originalSelfSlot:client.selfSlot===selfSlot,originalNpc:client.npc?.[index]===native,nativeType:client.npc?.[index]?.type?.id,originalNativeType:native.type?.id,publicTarget:raw.sdk.getState()?.nearbyNpcs.find(n=>n.index===index),player:raw.sdk.getState()?.player,hp:raw.sdk.getSkill('Hitpoints')?.level,childStart,childEnd:s.tick()}));throw Error('Trio Monkey cast unconfirmed '+(r.failure||r.stop));}guard();watch();const combat=raw.sdk.getState()?.nearbyNpcs.find(n=>n.index===index)?.lastCombatTick;accepted=trioRenewMonkeyClaim(accepted,{ok:r.ok,casts:r.casts,attempts:r.attempts,start:childStart,end:s.tick()},combat);}await waitTicks(s,1);watch();if(corpse&&!gone){await waitUntil(s,()=>{watch();return gone;},{timeoutTicks:8});}}
  }finally{offMonkey();targetGuard=()=>{};}if(monkeyProblem)throw Error(monkeyProblem);const monkeyTicks=s.tick()-monkeyStart,monkeyDamage=trioMonkeyXpReceipt(casts,q.xp('Magic')-monkeyMagic,q.xp('Hitpoints')-monkeyHp,o.xpRate,monkeyTicks);if(!corpse||!gone||mindBefore-q.cnt(558)!==casts||!monkeyDamage)throw Error('Trio owned Monkey death/runes/attributed XP unconfirmed');add({558:-casts});
  const loot=await runVisibleGroundLoot({state:()=>{guard();const st=s.sdk.getState();return st?{...st,groundItems:st.groundItems.filter(i=>i.id===3166&&i.count===1&&Math.max(Math.abs(i.x-last.x),Math.abs(i.z-last.z))<=1)}:null;},tick:()=>s.tick(),stop:over,definition:id=>{const d=client.objType(id);return{cost:d.cost,stackable:d.stackable};},pickup:async i=>(await s.sdk.sendPickup(i.x,i.z,i.id)).success,wait:(p,t)=>waitUntil(s,p,{timeoutTicks:t}),step:()=>waitTicks(s,1),clearModal:async()=>{await s.sdk.sendCloseModal();}},{mode:'list',ids:[3166],names:[],minimumValue:0,maximumValue:2147483647,radius:12,maximumUnits:1,cap:35,idleTicks:20});if(loot.units!==1)throw Error('Trio corpse receipt absent');add({3166:1});
  await hand('Tamayu skinning',3166,1167,TAMAYU,{3166:-1,3167:1,3183:1});await combine(TRIO_RECIPES[1]!);
  await move('native cooking fire',2790,3049,1);const recipe=cookingRecipes().recipes.find(r=>r.raw===3128&&r.products.includes(3130));if(!recipe)throw Error('Trio native cooking recipe absent');const cooked=await runCookingBatch({state:()=>s.sdk.getState(),tick:()=>s.tick(),stop:over,heat:async slot=>{guard();const fire=q.findLoc(l=>l.id===2732&&[2789,2790].includes(l.x)&&l.z===3048);if(!fire)throw Error('Trio observed permanent fire absent');return(await s.sdk.sendUseItemOnLoc(slot,fire.x,fire.z,fire.id)).success;},wait:(p,t)=>waitUntil(s,p,{timeoutTicks:t}),step:()=>waitTicks(s,1),close:async()=>{await s.sdk.sendCloseModal();} },recipe,{maximum:1,cap:40,heat:'fire',expectedProduct:3130});if(cooked.cooked!==1)throw Error('Trio bones cooking unconfirmed');add({3128:-1,3130:1});
  await move('Cairn rocks east',2795,2979,0);await q.step('Cairn rocks climb',()=>{guard();const l=q.findLoc(l=>l.id===2231&&l.x===2794&&l.z===2979);if(!l)throw Error('Trio observed Cairn rocks absent');return q.opLoc(l,1);},()=>q.pos().worldX<=2791,18,1);
  await move('Cairn bridge east',2782,2979,0);await move('Cairn bridge west',2774,2979,0);
  await freshTalk('Tinsay news',/^Tinsay$/i,TINSAY,[],/banana in Karamjan rum/i);
  await hand('Tinsay banana rum',3164,1165,TINSAY,{3164:-1},[],()=>true,/aha! a seaweed in monkey skin sandwich/i);
  await hand('Tinsay sandwich',3168,1165,TINSAY,{3168:-1},[],()=>true,/marinated in Karambwanji!/i);
  await hand('Tinsay marinated bones',3130,1165,TINSAY,{3130:-1},[],()=>true,/meet you in the village once/i);
  await hand('Tinsay crafting manual',3157,1165,TINSAY,{3157:-1,3161:1},[],()=>progress(321)===5);
  await move('Cairn bridge return west',2774,2979,0);await move('Cairn bridge return east',2782,2979,0);await move('Cairn rocks west',2791,2979,0);await q.step('Cairn rocks descend',()=>{guard();const l=q.findLoc(l=>l.id===2231&&l.x===2792&&l.z===2979);if(!l)throw Error('Trio observed west Cairn rocks absent');return q.opLoc(l,1);},()=>q.pos().worldX>=2795,18,1);
  await crossLog(true);await hand('Tiadeche manual',3161,1163,TIADECHE,{3161:-1},[],()=>progress(321)===6);if(progress(320)!==4)throw Error('Trio native brothers/Lubufu completion unconfirmed');await crossLog(false);
  await move('Timfraku return',HOME.x,HOME.z,2);await hut(true);const gold=pack(s);await talk('Timfraku quest reward',/^Timfraku$/i,HOME,[/rather have some gold/i],()=>progress(320)===6&&client.var[101]-questPoints0===2&&trioPackEffect(gold,pack(s),{995:2000})&&questFlags(client)?.some(q=>q.name==='Tai Bwo Wannai Trio'&&q.state==='complete')===true,TRIO_TIMFRAKU_TERMINAL);add({995:2000});await hut(false);
  const rew=async(label:string,name:RegExp,home:{x:number;z:number},expected:Record<string,number>,delta:Record<number,number>={})=>{const x=xp(s),b=pack(s);await talk(label,name,home,[],()=>Object.entries(expected).every(([k,n])=>(xp(s)[k]??0)-(x[k]??0)===n*o.xpRate)&&trioPackEffect(b,pack(s),delta));add(delta);};
  await rew('Tamayu final reward',/^Tamayu$/i,{x:2800,z:3057},{Attack:2500,Strength:2500},{3175:1});await rew('Tinsay final reward',/^Tinsay$/i,{x:2790,z:3054},{Cooking:5000});await rew('Tiadeche final reward',/^Tiadeche$/i,{x:2781,z:3057},{Fishing:5000});
  guard();if(q.stats.eats)throw Error('Trio unexpected food use outside declared ledger');if(!trioPackEffect(initial,pack(s),ledger))throw Error('Trio final whole owned inventory audit failed');if(q.xp('Fishing')-baseline.Fishing!==6500*o.xpRate||q.xp('Cooking')-baseline.Cooking!==5100*o.xpRate||q.xp('Attack')-baseline.Attack!==2500*o.xpRate||q.xp('Strength')-baseline.Strength!==2500*o.xpRate)throw Error('Trio final reward XP failed');
  const bridgeBalances=q.msgCount(/you manage to keep your balance on the bridge/i),logXP=logCrossings.reduce((n,r)=>n+r.agilityXP,0);if(logCrossings.length!==4||q.xp('Agility')-baseline.Agility!==(2+10*bridgeBalances)*o.xpRate+logXP)throw Error('Trio native rock climbs/Cairn bridge/river log XP mismatch');
  for(const [name,value]of Object.entries(xp(s)))if(!['Attack','Strength','Fishing','Cooking','Agility','Magic','Hitpoints'].includes(name)&&value!==baseline[name])throw Error('Trio unrelated XP changed '+name);
  return{ok:true,complete:true,questPoints:2,coins:2000,casts,monkeyDamage,monkeyTicks,bridgeBalances,logCrossings,ledger,steps,ticks:s.tick()-start,xpBefore:baseline,xpAfter:xp(s),inventory:pack(s)};
 }finally{await q.dispose();if(!fatal()&&raw.sdk.getState()?.autoRetaliateEnabled!==retaliate){await raw.direct({type:'clickComponent',component:componentId('com_mode:com_retaliate'),reason:'SDK'});await waitUntil(raw,()=>raw.sdk.getState()?.autoRetaliateEnabled===retaliate,{timeoutTicks:8});}}
}
export function trioStopRequested(name:string,stopped=false,exists:(path:string)=>boolean=existsSync){return productionStopRequested(name,()=>stopped,exists)||exists('.practice/stop-quest-tbwt');}
if(import.meta.main){let s:Session|undefined,stopped=false,own=()=>false;try{const name=process.argv[2];if(!name)throw Error('account required');nativeNpcSpell('wind_strike');cookingRecipes();s=await openBot(name,{onStop:async(s,detail)=>{console.log('TRIO_STOP '+JSON.stringify({tick:s.tick(),detail}));stopped=true;}});own=trioOwnContext(s);const result=await runTaiBwoWannaiTrio(s,{cap:Number(process.argv[3]??6000),xpRate:Number(process.env.NODE_XP_RATE??25),maximumCasts:Number(process.env.TRIO_MAX_CASTS??25)},()=>trioStopRequested(name,stopped));console.log('TRIO_RESULT '+JSON.stringify(result));if(!own())throw Error('Trio original settlement ownership lost');if(!await settle([s],true,JSON.stringify(result)))process.exitCode=1;}catch(e){if(!s||own())await settle(s?[s]:[],false,String(e));else console.log('TRIO_SETTLEMENT_DEFERRED '+String(e));process.exitCode=1;}}
