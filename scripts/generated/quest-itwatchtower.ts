// Native Watch Tower from public not-started state. Native quest_itwatchtower handlers own the sequence;
// Microbot Watchtower helper supplies route intent only (its modern crystal-pillar steps do not exist here).
import {openQuest} from './quest-lib';
import {openBot,finish} from '../../packages/core/src/bot';
import type {Session} from '../../packages/core/src/inprocess';
import {questFlags,questDefinitions} from '../../packages/core/src/quest-status';
import {BotActions} from '../../vendor/rs-sdk/sdk/actions';
import {productionStopRequested} from '../microbot-c-lifetime';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {sessionWalker,walkPath} from '../../packages/core/src/walk';
import {waitUntil,waitTicks} from '../../packages/core/src/ticks';

export const WATCH_ITEMS={nails:2384,key:2378,tooth:2377,gold:2393,part1:2373,part2:2374,part3:2375,relic:2372,map:2376,crystal1:2380,crystal2:2381,crystal3:2382,crystal4:2383,cake:2379,nightshade:2398,partial:2390,potion:2394,enchanted:2395,scroll:2396} as const;
export const WATCH_ENTRY={Magic:14,Mining:40,Herblore:14,Thieving:15,Agility:25} as const;
export const WATCH_SUPPLIES:Readonly<Record<number,number>>={995:20,954:2,536:1,2357:1,560:1,91:1,247:1,2391:1,33:1,1265:1,385:8};
export async function watchtowerTowerEntry(level:()=>number,loc:(label:string,id:number,x:number,z:number,done:()=>boolean)=>Promise<void>){
 // The ground ladder is inside the tower. The native climbable wall admits surface returns too.
 if(level()===0)await loc('climb tower wall',2299,2548,3119,()=>level()===1);
 if(level()===1)await loc('wizard ladder',2796,2549,3111,()=>level()===2);
}
export function watchtowerCakeOpening(player:{worldX:number;worldZ:number;level:number},locs:readonly{id:number;x:number;z:number}[],npcs:readonly{id:number;x:number;z:number}[]){
 // npc_find(...,3,LINEOFWALK) cannot see through the solid two-tile counter.
 // Pin its south-side interaction tile and the observed trader behind it.
 const traders=npcs.filter(n=>n.id===875);
 return player.level===0&&player.worldX===2506&&player.worldZ===3024&&locs.some(l=>l.id===2793&&l.x===2506&&l.z===3023)&&traders.length===1&&traders.every(n=>n.x>=2506&&n.x<=2507&&n.z>=3018&&n.z<=3022);
}
export function watchtowerBridgeLoc(s:Session,owns:()=>boolean,type:{name?:string;op?:readonly(string|null)[]}|undefined){
 if(!owns()||s.sdk.getStateAge()>5000)return;
 const c=s.client as any,p=s.sdk.getState()?.player,x=2530-c.mapBuildBaseX,z=3026-c.mapBuildBaseZ;
 if(!p||p.isDead||p.level!==0||c.minusedlevel!==0||!Number.isInteger(x)||!Number.isInteger(z)||x<0||z<0||x>=104||z>=104||Math.max(Math.abs(p.worldX-2530),Math.abs(p.worldZ-3026))>2||type?.name!=='Rock'||type.op?.[0]!=='Jump-From')return;
 const tag=c.world?.sceneType(1,x,z);
 // Native m39_47 plane1 LINK_BELOW maps this observed loc to server plane0.
 if(!Number.isInteger(tag)||((tag>>>29)&3)!==2||((tag>>>14)&0x7fff)!==2830||(tag&127)!==x||((tag>>>7)&127)!==z||!owns())return;
 return{id:2830,name:type.name,x:2530,z:3026,level:0,distance:1,optionsWithIndex:[{text:type.op[0],opIndex:1}],options:[type.op[0]]};
}
export async function watchtowerCityExit(observe:()=>{x:number;z:number;level:number;coins:number;agilityXP:number},loc:(label:string,id:number,x:number,z:number,done:()=>boolean)=>Promise<void>,approachGate:()=>Promise<void>){
 const before=observe();
 const at=(x:number,z:number)=>{const after=observe();return after.level===0&&after.x===x&&after.z===z&&after.coins===before.coins&&after.agilityXP===before.agilityXP;};
 await loc('return city bridge',2831,2531,3029,()=>at(2531,3026));
 await loc('return market battlement',2832,2507,3011,()=>at(2506,3011));
 await approachGate();
 if(!at(2503,3063))throw Error('Watchtower inside exit gate approach unconfirmed');
 // The native ordinary right-gate handler teleports from x2503 to its x2504 anchor.
 await loc('leave Gu Tanoth city',2789,2504,3063,()=>at(2504,3063));
}
export async function watchtowerEnchantPotion(io:{pack:()=>Record<number,number>;give:(done:(freshText:string)=>boolean)=>Promise<void>}){
 const before={...io.pack()};
 // Native credits the potion before dialogue, then delays before this terminal page.
 await io.give(text=>{
  const after=io.pack(),delta:Record<number,number>={2394:-1,2395:1};
  return text.includes('Here it is - a dangerous substance.')&&text.includes('if your magic ability is high enough.')&&[...new Set([...Object.keys(before),...Object.keys(after),...Object.keys(delta)])].every(id=>(after[+id]??0)-(before[+id]??0)===(delta[+id]??0));
 });
}
export const WATCH_SHAMAN_ORDINALS=["That's one destroyed...","That's the second one gone...","That's the next one dealt with...","There goes another one...","Thats five, only one more left now..."] as const;
export function watchtowerShamanEffect(before:Readonly<Record<number,number>>,after:Readonly<Record<number,number>>,ordinal:number,gone:boolean,freshSignal:boolean){
 if(!gone||!freshSignal||!Number.isSafeInteger(ordinal)||ordinal<1||ordinal>6)return false;
 const delta:Record<number,number>=ordinal===6?{2395:-1,229:1,2382:1}:{};
 return [...new Set([...Object.keys(before),...Object.keys(after),...Object.keys(delta)])].every(id=>(after[+id]??0)-(before[+id]??0)===(delta[+id]??0));
}
export function watchtowerEntry(s:Session){
 for(const[k,v]of Object.entries(WATCH_ENTRY))if((s.sdk.getSkill(k)?.level??0)<v)throw Error('Watchtower skill required '+k);
 for(const[id,n]of Object.entries(WATCH_SUPPLIES))if(s.sdk.getInventory().filter(i=>i.id===+id).reduce((a,i)=>a+i.count,0)<n)throw Error('Watchtower owned supply missing '+id);
 if((s.sdk.getSkill('Hitpoints')?.level??0)<90||(s.sdk.getSkill('Defence')?.level??0)<70||(s.sdk.getSkill('Attack')?.level??0)<70||(s.sdk.getSkill('Strength')?.level??0)<70)throw Error('Watchtower finite melee/health staging required');
 if(!s.sdk.getEquipment().some(i=>i.slot===5&&i.id===1540)||!s.sdk.getEquipment().some(i=>i.slot===3&&i.id===1289))throw Error('Watchtower rune sword and anti-dragon shield required');
 if(questFlags(s.client)?.find(q=>q.name==='Watch Tower')?.state!=='not started')throw Error('Watchtower requires observed public not-started journal');
 const st=s.sdk.getState();if(st?.autoRetaliateEnabled!==false||st?.prayers.activePrayers.some(Boolean)||!st.player||st.player.level!==0||Math.max(Math.abs(st.player.worldX-2548),Math.abs(st.player.worldZ-3119))>15)throw Error('Watchtower idle tower staging/controls required');
 const questItems=new Set(Object.values(WATCH_ITEMS));if(s.sdk.getInventory().some(i=>questItems.has(i.id as any)))throw Error('Watchtower entry contains quest progress items');
}
export function madSkavidReply(text:string){if(/Ar cur/i.test(text))return /^Gor\.$/i;if(/Bidith ig/i.test(text))return /^Cur\.$/i;if(/Cur tanath/i.test(text))return /^Bidith\.$/i;if(/Gor nod/i.test(text))return /^Tanath\.$/i;throw Error('unobserved mad-skavid phrase');}
export const WATCH_CAVES=[
 {id:2809,x:2553,z:3033,out:2821,ox:2504,oz:9442,npc:863,nx:2499,nz:9433,reply:/Okay, okay/,effect:/Those will gets you started/},
 {id:2808,x:2552,z:3052,out:2820,ox:2497,oz:9451,npc:867,nx:2500,nz:9451,reply:/^Cur\.$/i,effect:/Cur,.*cur tanath/i},
 {id:2807,x:2539,z:3052,out:2819,ox:2518,oz:9456,npc:866,nx:2515,nz:9452,reply:/^Ar\.$/i,effect:/Ar,.*Ar cur/i},
 {id:2806,x:2522,z:3068,out:2818,ox:2532,oz:9470,npc:865,nx:2530,nz:9465,reply:/^Ig\.$/i,effect:/Bidith ig/i},
 {id:2805,x:2560,z:3022,out:2817,ox:2497,oz:9418,npc:868,nx:2503,nz:9415,reply:/^Nod\.$/i,effect:/Gor nod/i},
] as const;
export function watchtowerNativeBindings(){
 const base='vendor/rs-sdk/server/content/',pack=(kind:string)=>new Map(readFileSync(base+'pack/'+kind+'.pack','utf8').split(/\r?\n/).map(l=>{const[i,n]=l.split('=');return[n,Number(i)];}));
 const objects=pack('obj'),locs=pack('loc'),npcs=pack('npc');for(const[name,id]of Object.entries({fingernails:2384,relicpart1:2373,relicpart2:2374,relicpart3:2375,magic_ogre_potion:2395,powering_crystal4:2383,watchtowerspell:2396}))if(objects.get(name)!==id)throw Error('Watchtower Native object differs '+name);
 if(locs.get('watchleverup')!==2794||npcs.get('ogre_shaman')!==871||npcs.get('gorad')!==856)throw Error('Watchtower Native action mapping differs');questDefinitions();
 return{rawRewardMagic:153000,coins:5000,questPoints:4};
}
export function watchtowerOwnContext(s:Session){
 const client=s.client as any,owner=client?.executeBotAction,self=client?.selfSlot,p=s.sdk.getState()?.player,life=p?.lifeId,respawns=p?.respawnCount??0;let lost=false;
 return()=>{const now=s.sdk.getState()?.player;if(!p||typeof owner!=='function'||s.client!==client||client.executeBotAction!==owner||client.selfSlot!==self||!now||now.isDead||now.lifeId!==life||(now.respawnCount??0)!==respawns)lost=true;return !lost;};
}
export async function finishWatchtowerOwned(s:Session,owns:()=>boolean,ok:boolean,detail:string,close:(sessions:Session[],ok:boolean,detail:string)=>Promise<unknown>=finish){
 if(!owns()){console.log('WATCHTOWER_SETTLEMENT_DEFERRED original client/life/input owner lost');return false;}
 await close([s],ok,detail);return true;
}
export async function runWatchtower(original:Session,{cap=6000,xpRate=25,stop=()=>false}:{cap?:number;xpRate?:number;stop?:()=>boolean}={}){
 if(!Number.isSafeInteger(cap)||cap<=120||cap>12000||!Number.isSafeInteger(xpRate)||xpRate<1||xpRate>1000)throw Error('invalid Watchtower finite budget');
 const binding=watchtowerNativeBindings();watchtowerEntry(original);
 const client=original.client as any,owner=client.executeBotAction,p=original.sdk.getState()!.player!,life=p.lifeId,respawns=p.respawnCount??0,start=original.tick(),gear=JSON.stringify(original.sdk.getEquipment());let ended=false,cleanup=false;void original.ended.then(()=>{ended=true;});
 let allowed:RegExp[]=[];const guard=()=>{const now=original.sdk.getState()?.player;if(ended||original.client!==client||client.executeBotAction!==owner||typeof owner!=='function'||!now||now.isDead||now.lifeId!==life||(now.respawnCount??0)!==respawns||original.sdk.getStateAge()>5000||original.tick()-start>=cap||(!cleanup&&(productionStopRequested(original.name,stop)||existsSync('.practice/stop-quest-itwatchtower')))||(original.sdk.getSkill('Hitpoints')?.level??0)<30||JSON.stringify(original.sdk.getEquipment())!==gear)throw Error('Watchtower original owner/life/HP/gear/stop/cap');};
 const sdk=new Proxy(original.sdk,{get(t,k,r){const v=Reflect.get(t,k,r);return typeof v==='function'?function(...a:any[]){if(typeof k==='string'&&k.startsWith('send')){guard();if(k==='sendClickDialog'){const d=original.sdk.getDialog(),choices=d?.options?.filter(o=>!/click here to continue/i.test(o.text))??[];if(choices.length&&!choices.some(o=>o.index===a[0]&&allowed.some(re=>re.test(o.text))))throw Error('unexpected Watchtower dialogue choice');}}return v.apply(r,a);}:v;}});
 const s={...original,sdk,bot:new BotActions(sdk),direct:async(a:Parameters<Session['direct']>[0])=>{guard();return original.direct(a);}}as Session;
 const q=await openQuest({session:s,cap:cap-120,eatAt:65,food:[385],stop:()=>(productionStopRequested(original.name,stop)||existsSync('.practice/stop-quest-itwatchtower'))});let phase='entry';const milestones:string[]=[];let receipt:any;const initialCoins=q.cnt(995),initialMagic=q.xp('Magic'),initialPack=new Map<number,number>(q.inv().map(i=>[i.id,q.cnt(i.id)]));
 const walk=async(x:number,z:number,tol=2)=>{guard();await q.walk(phase,[{x,z,tol}]);guard();};
 const npc=(id:number)=>q.st()?.nearbyNpcs?.filter((n:any)=>n.id===id).sort((a:any,b:any)=>a.distance-b.distance)[0];
 const {default:ClientLocType}=await import(resolve('vendor/rs-sdk/server/webclient/src/config/LocType.ts'));guard();
 const owns=()=>{try{guard();return true;}catch{return false;}};
 const freshLoc=(id:number,x:number,z:number)=>{const l=q.locs().find((l:any)=>l.id===id&&l.x===x&&l.z===z)??(id===2830&&x===2530&&z===3026?watchtowerBridgeLoc(s,owns,ClientLocType.list(2830)):undefined);if(!l)throw Error('Watchtower loc not observed '+id);return l;};
 let seen='';const text=()=>{const d=s.sdk.getDialog();return[d?.text??'',...(d?.allComponents??[]).map((c:any)=>c.text??'')].join(' ');};
 const act=async(label:string,send:()=>Promise<unknown>,pats:RegExp[],done:(seen:string)=>boolean,ticks=100,dynamic=false)=>{
  phase=label;seen='';allowed=pats;let quiet=0;const off=s.onTick(()=>{const t=text();if(t)seen+=' '+t;if(dynamic){try{allowed.splice(0,allowed.length,madSkavidReply(seen));}catch{}}});
  try{guard();await send();const ok=await q.converse(allowed,()=>{quiet=q.dialogOpen()?0:quiet+1;return quiet>=3&&done(seen);},ticks);guard();if(!ok)throw Error('Watchtower effect unknown '+label);milestones.push(label);q.milestone(label);console.log('WATCHTOWER_STEP '+JSON.stringify({phase,tick:s.tick(),quest:questFlags(client)?.find(f=>f.name==='Watch Tower')?.state,items:q.inv().map(i=>[i.id,i.count])}));}finally{off();allowed=[];}
 };
 const talk=async(label:string,id:number,x:number,z:number,pats:RegExp[],effect:RegExp|(()=>boolean),dynamic=false)=>{phase=label;await walk(x,z,3);await act(label,async()=>{const n=npc(id);if(!n)throw Error('Watchtower NPC absent '+id);return q.talkTo(n);},pats,seen=>typeof effect==='function'?effect():effect.test(seen),150,dynamic);};
 const loc=async(label:string,id:number,x:number,z:number,done:()=>boolean,op=1,pats:RegExp[]=[])=>{if(done())return;phase=label;await walk(x,z,2);await act(label,()=>q.opLoc(freshLoc(id,x,z),op),pats,done,80);};
 const give=async(label:string,item:number,id:number,x:number,z:number,done:(seen:string)=>boolean)=>{phase=label;await walk(x,z,3);await act(label,async()=>{const n=npc(id);if(!n||!q.has(item))throw Error('Watchtower give input absent');return q.useOnNpc(item,n);},[],done,130);};
 const tower=()=>watchtowerTowerEntry(()=>q.lvl(),loc);
 const down=async()=>{if(q.lvl()===2)await loc('down wizard ladder',2797,2549,3111,()=>q.lvl()===1);if(q.lvl()===1){phase='down tower';await walk(2544,3111);const ladder=q.findLoc((l:any)=>l.x===2544&&l.z===3111&&(l.optionsWithIndex??[]).some((o:any)=>/climb-down/i.test(o.text)));if(!ladder)throw Error('Native tower down ladder absent');await act(phase,()=>q.opLoc(ladder,q.opIndex(ladder,/climb-down/i)),[],()=>q.lvl()===0);}};
 const grew=async()=>{phase='Grew island';await walk(2501,3087,0);await act('rope to Grew',()=>q.useOnLoc(954,freshLoc(2326,2499,3087)),[],()=>q.pos().worldX>=2505,30);};
 const leaveGrew=()=>loc('leave Grew island',2324,2511,3090,()=>q.pos().worldZ>=3096);
 const city=async()=>{phase='Gu Tanoth gate';await walk(2506,3063);await loc('city friendship gate',2788,2504,3062,()=>q.pos().worldX<=2503);};
 const pickup=async(id:number,x:number,z:number,amount:number)=>{phase='owned quest ground pickup';await walk(x,z,1);for(let i=0;i<amount;i++){const before=q.cnt(id);if(!await q.waitUntil(()=>q.st()?.groundItems?.some((g:any)=>g.id===id&&g.x===x&&g.z===z),150))throw Error('quest ground spawn absent');await act('take nightshade',async()=>{const g=q.st().groundItems.find((g:any)=>g.id===id&&g.x===x&&g.z===z);return s.bot.pickupItem(g);},[],()=>q.cnt(id)===before+1,20);}};
 try{
  await tower();await talk('start Watch Tower',872,2546,3114,[/What.s the matter/,/So how come/,/Can I be of help/],()=>questFlags(client)?.some(f=>f.name==='Watch Tower'&&f.state==='started')===true);
  await down();await loc('find fingernails',2799,2544,3134,()=>q.has(2384));await tower();await talk('identify skavid',872,2546,3114,[/What do you suggest/,/So what do I do/],/Tribal ogres often dislike/);await down();
  await talk('Og stolen gold task',853,2506,3116,[/I seek entrance/],()=>q.has(2378));await grew();await talk('Grew tooth task',854,2513,3084,[/Don.t eat me/],/knock one of his teeth out/i);await leaveGrew();
  await loc('Toban tunnel',2811,2499,2989,()=>q.near(2576,3029,4));await talk('Toban dragon bones task',855,2576,3027,[/I seek entrance/,/I could do something/],/bones of an adult dragon/i);await talk('give dragon bones',855,2576,3027,[],()=>q.has(2375));await loc('Toban chest',2790,2575,3031,()=>q.has(2393));
  phase='Gorad tooth';await walk(2577,3021,3);const gorad=npc(856);if(!gorad)throw Error('Gorad absent');await act('Gorad tooth',()=>s.direct({type:'interactNpc',npcIndex:gorad.index,optionIndex:2,reason:'SDK'}),[],()=>q.has(2377),350);await s.direct({type:'walkTo',x:q.pos().worldX,z:q.pos().worldZ,reason:'SDK'});
  await loc('leave Toban island',2812,2575,3029,()=>q.near(2500,2988,4));await talk('return stolen gold',853,2506,3116,[],()=>q.has(2373));await grew();await talk('return tooth',854,2513,3084,[],()=>q.has(2374)&&q.has(2380));await leaveGrew();await tower();
  for(const id of[2373,2374,2375])await give('give relic part '+id,id,872,2546,3114,()=>!q.has(id));if(!q.has(2372))throw Error('assembled relic absent');await down();
  await give('friendship relic',2372,859,2506,3063,()=>q.pos().worldX<=2503);phase='rock cake';await walk(2506,3024,0);if(!await q.waitUntil(()=>watchtowerCakeOpening(q.pos(),q.locs(),q.st()?.nearbyNpcs??[]),180))throw Error('rock-cake counter/trader opening unobserved');await act('steal rock cake',()=>{if(!watchtowerCakeOpening(q.pos(),q.locs(),q.st()?.nearbyNpcs??[]))throw Error('rock-cake opening changed before single input');return q.opLoc(freshLoc(2793,2506,3023));},[],()=>q.has(2379),80);
  await talk('market gift request',860,2503,3012,[/But I am a friend/],/Surprise us/i);await talk('give rock cake',860,2503,3012,[],()=>!q.has(2379));await loc('market battlement',2832,2507,3011,()=>q.pos().worldX>=2508);
  const bridgeCoins=q.cnt(995),bridgeXP=q.xp('Agility');await loc('paid bridge jump',2830,2530,3026,()=>q.lvl()===0&&q.near(2530,3029,0)&&q.cnt(995)===bridgeCoins-20&&q.xp('Agility')===bridgeXP+5*xpRate,1,[/Okay, I.ll pay/]);await talk('city riddle',862,2541,3029,[/I seek passage/],/riddle take/i);await give('death rune answer',560,862,2541,3029,()=>q.has(2376));
  await watchtowerCityExit(()=>({x:q.pos().worldX,z:q.pos().worldZ,level:q.lvl(),coins:q.cnt(995),agilityXP:q.xp('Agility')}),loc,()=>walk(2503,3063,0));
  for(const c of WATCH_CAVES){await loc('enter skavid '+c.npc,c.id,c.x,c.z,()=>q.pos().worldZ>9000);await talk('learn skavid '+c.npc,c.npc,c.nx,c.nz,[c.reply],c.effect);await loc('leave skavid '+c.npc,c.out,c.ox,c.oz,()=>q.pos().worldZ<9000);}
  await talk('gold gate request',858,2551,3031,[],/bar of pure gold/i);await talk('gold gate payment',858,2551,3031,[],()=>!q.has(2357));await loc('mad skavid cave',2810,2527,3011,()=>q.pos().worldZ>9000);await talk('mad skavid answer',864,2523,9411,[],()=>q.has(2381),true);await pickup(2398,2528,9415,2);await loc('leave mad cave',2822,2521,9411,()=>q.pos().worldZ<9000);
  await city();await give('first enclave entry',2398,870,2507,3036,()=>q.pos().worldZ>9000);await loc('leave enclave for potion',2813,2598,9468,()=>q.pos().worldZ<9000);await tower();await talk('learn shaman potion',872,2546,3114,[],/wrong order can cause explosions/i);
  await act('jangerberries into guam',()=>q.useOnItem(247,91),[],()=>q.has(2390),15);await act('ground bat bones last',()=>q.useOnItem(2391,2390),[],()=>q.has(2394),15);await watchtowerEnchantPotion({pack:()=>Object.fromEntries(q.inv().map(i=>[i.id,q.cnt(i.id)])),give:done=>give('enchant potion',2394,872,2546,3114,done)});await down();await city();await give('second enclave entry',2398,870,2507,3036,()=>q.pos().worldZ>9000);
  const shamanHomes=[[2582,9437],[2592,9436],[2606,9438],[2607,9451],[2599,9461],[2577,9451]];const removed=new Set<number>();
  for(const[x,z]of shamanHomes){phase='dissolve shaman';await walk(x!,z!,3);const n=q.st().nearbyNpcs.filter((n:any)=>n.id===871&&!removed.has(n.index)).sort((a:any,b:any)=>Math.max(Math.abs(a.x-x!),Math.abs(a.z-z!))-Math.max(Math.abs(b.x-x!),Math.abs(b.z-z!)))[0];if(!n)throw Error('fresh shaman absent');
   const ordinal=removed.size+1,before=Object.fromEntries(q.inv().map(i=>[i.id,q.cnt(i.id)])),cursor=Math.max(-1,...(q.st().gameMessages??[]).map((m:any)=>m.observationId??-1));
   await act('dissolve shaman '+n.index,()=>q.useOnNpc(2395,n),[],seen=>watchtowerShamanEffect(before,Object.fromEntries(q.inv().map(i=>[i.id,q.cnt(i.id)])),ordinal,!q.st().nearbyNpcs.some((k:any)=>k.index===n.index&&k.id===871),ordinal<6?seen.includes(WATCH_SHAMAN_ORDINALS[ordinal-1]!):q.st().gameMessages.some((m:any)=>m.type===0&&m.sender===''&&m.fromSelf===false&&m.observationId>cursor&&m.text==='You snatch it up quickly.')),50);removed.add(n.index);}
  if(!q.has(2382))throw Error('sixth shaman crystal absent');await loc('mine sacred crystal',2816,2590,9449,()=>q.has(2383),2);await loc('leave enclave with crystals',2813,2598,9468,()=>q.pos().worldZ<9000);await tower();await talk('all four crystals',872,2546,3114,[],/Throw the lever to activate/i);
  await loc('activate Watch Tower',2794,2543,3115,()=>q.has(2396)&&q.xp('Magic')-initialMagic===binding.rawRewardMagic*xpRate/10);if(q.cnt(995)!==initialCoins-20+5000)throw Error('Watchtower coin reward differs');
  await act('read teleport scroll',()=>s.sdk.sendUseItem(q.slot(2396)!,1),[],()=>!q.has(2396),60);
  const complete=questFlags(client)?.some(f=>f.name==='Watch Tower'&&f.state==='complete')===true;if(!complete)throw Error('public Watch Tower completion absent');
  const delta:Record<number,number>={995:4980,954:-2,536:-1,2357:-1,560:-1,91:-1,247:-1,2391:-1,385:-q.stats.eats,2384:1,2372:1,2376:1,229:1};const ids=new Set([...initialPack.keys(),...q.inv().map(i=>i.id)]);if([...ids].some(id=>q.cnt(id)-(initialPack.get(id)??0)!==(delta[id]??0)))throw Error('Watchtower final whole inventory differs');
  return receipt={ok:true,phase,quest:'Watch Tower',complete,scrollRead:true,magicXP:q.xp('Magic')-initialMagic,coins:q.cnt(995)-initialCoins,ticks:s.tick()-start,stats:q.stats,milestones};
 }finally{
  await q.dispose();cleanup=true;
  const own=()=>!ended&&original.client===client&&client.executeBotAction===owner&&original.sdk.getState()?.player?.lifeId===life&&(original.sdk.getState()?.player?.respawnCount??0)===respawns&&!original.sdk.getState()?.player?.isDead;
  if(own()){
   const p=original.sdk.getState()!.player!;await original.direct({type:'walkTo',x:p.worldX,z:p.worldZ,running:false,reason:'Watchtower owned cleanup cancel'});
   await waitUntil(original,()=>!own()||original.sdk.getState()?.player?.combat.targetType==='none',{timeoutTicks:8});
   if(own()&&original.tick()-start<cap-35){
    const at=original.sdk.getState()!.player!,exit=at.worldZ>9400&&at.worldX>=2560?{id:2813,x:2598,z:9468}:at.level===0&&at.worldX>=2566&&at.worldX<=2595&&at.worldZ>=3000&&at.worldZ<=3045?{id:2812,x:2575,z:3029}:undefined;
    if(exit){const walker=await sessionWalker(s);guard();const walked=await walkPath(walker,[{x:exit.x,z:exit.z,tol:1}],{maxTicks:Math.min(70,cap-(original.tick()-start)-25),stop:()=>!own()});if(walked.ok&&own()){const observed=s.sdk.getState()?.nearbyLocs.find(l=>l.id===exit.id&&l.x===exit.x&&l.z===exit.z);if(observed)await s.direct({type:'interactLoc',x:exit.x,z:exit.z,locId:exit.id,optionIndex:1,reason:'Watchtower owned exit'});}}
    else if(!receipt&&at.level===0&&at.worldX>=2496&&at.worldX<=2561&&at.worldZ>=3000&&at.worldZ<=3062){const walker=await sessionWalker(s);guard();await walkPath(walker,[{x:2507,z:3065,tol:0}],{maxTicks:Math.min(70,cap-(original.tick()-start)-25),stop:()=>!own()});}
    if(own())await waitTicks(original,18);
   }
  }
  if(receipt){guard();if(original.sdk.getState()?.player?.combat.targetType!=='none')throw Error('Watchtower cleanup target unconfirmed');receipt.ticks=original.tick()-start;receipt.cleanupConfirmed=true;}
 }
}
if(import.meta.main){watchtowerNativeBindings();let stopped=false;const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}}),owns=watchtowerOwnContext(s);try{const r=await runWatchtower(s,{cap:Number(process.env.WATCHTOWER_CAP??6000),xpRate:Number(process.env.WATCHTOWER_XP_RATE??25),stop:()=>stopped});console.log('WATCHTOWER_RESULT '+JSON.stringify(r));if(!await finishWatchtowerOwned(s,owns,r.ok,JSON.stringify(r)))process.exitCode=1;}catch(e){if(!await finishWatchtowerOwned(s,owns,false,String(e)))process.exitCode=1;}}
