import{readFileSync}from'node:fs';
import{openBot,settle}from'../packages/core/src/bot';
import type{Session}from'../packages/core/src/inprocess';
import{BotActions}from'../vendor/rs-sdk/sdk/actions';
import{waitUntil,waitTicks}from'../packages/core/src/ticks';
import{walkPath,sessionWalker}from'../packages/core/src/walk';
import{productionStopRequested}from'./microbot-c-lifetime';
import{runBankProfile,type BankProfile,type Tile}from'./microbot-bank-jobs';
import{runStagedFishing,FISH_PROFILES}from'./microbot-b-fishing';
import{cookingRecipes,nativeHeatSources,runCookingBatch}from'./microbot-b-cooking';
export type VillageMode='DROP_RAW'|'COOK_AND_DROP'|'COOK_AND_BANK'|'BANK_RAW';
export type VillageOrder={method:'fly'|'riverBait';mode:VillageMode;target:number;batch:number;reserve:number;cap:number;returnTicks:number;xpRate:number};
export const VILLAGE_BANK:Tile={x:3094,z:3491,level:0},VILLAGE_SPOT:Tile={x:3107,z:3430,level:0};
// Native range2728 at3160,3427; the donor's permanent village fire43475 is absent.
export const VILLAGE_HEAT={x:3160,z:3427,level:0,id:2728};
// Native range forceapproach=east rotated by map angle3 admits only its north face, inside the house entered via door1533 at3160,3432.
export const VILLAGE_HEAT_STAND={x:3160,z:3428};
export function villagePolicy(o:VillageOrder){
 if(!o||!['fly','riverBait'].includes(o.method)||!['DROP_RAW','COOK_AND_DROP','COOK_AND_BANK','BANK_RAW'].includes(o.mode)||![o.target,o.batch,o.cap,o.returnTicks,o.xpRate].every(n=>Number.isSafeInteger(n)&&n>0)||o.target>10000||o.batch>24||o.cap>100000||o.returnTicks<100||o.cap<=o.returnTicks||o.xpRate>1000||!Number.isSafeInteger(o.reserve)||o.reserve<0)throw Error('invalid finite village fishing order');
 const fish=FISH_PROFILES[o.method],cook=o.mode.startsWith('COOK_'),drop=o.mode.endsWith('DROP')||o.mode==='DROP_RAW',recipes=cookingRecipes().recipes.filter(r=>fish.products.includes(r.raw as never));if(recipes.length!==fish.products.length||recipes.some(r=>!r.range||r.products.length!==1||r.burnt!==343))throw Error('native village cooking recipes absent');
 return{fish,cook,drop,recipes,outputs:[...fish.products,...new Set(recipes.flatMap(r=>[...r.products,r.burnt!]))]};
}
const FISH_XP:Readonly<Record<number,number>>={335:50,331:70,349:60};
const pack=(s:Session)=>{const out:Record<number,number>={};for(const i of s.sdk.getInventory())out[i.id]=(out[i.id]??0)+i.count;return out;};
export function villagePackEffect(before:Record<number,number>,after:Record<number,number>,expected:Record<number,number>){return[...new Set([...Object.keys(before),...Object.keys(after),...Object.keys(expected)])].every(id=>(after[+id]??0)-(before[+id]??0)===(expected[+id]??0));}
export async function dropVillageOutput(s:Session,ids:readonly number[],maximum:number,stop:()=>boolean){
 const initial=pack(s),dropped:Record<number,number>={};let slots=0;
 while(slots<maximum){if(stop())throw Error('village drop stopped');const row=s.sdk.getInventory().find(i=>ids.includes(i.id));if(!row)break;const before=pack(s),id=row.id,count=row.count,slot=row.slot;if(!Number.isSafeInteger(row.count)||row.count<1||row.optionsWithIndex.some(v=>v.opIndex===5&&!/^drop$/i.test(v.text)))throw Error('village fresh native drop unknown');
  // Unknown dispatch has no retry: only the exact whole-pack debit authorizes progress.
  await s.direct({type:'dropItem',slot,reason:'finite village owned catch output'});if(!await waitUntil(s,()=>stop()||villagePackEffect(before,pack(s),{[id]:-count}),{timeoutTicks:8})||stop()||!villagePackEffect(before,pack(s),{[id]:-count}))throw Error('village drop effect unresolved');dropped[id]=(dropped[id]??0)+count;slots++;
 }
 if(s.sdk.getInventory().some(i=>ids.includes(i.id))||!villagePackEffect(initial,pack(s),Object.fromEntries(Object.entries(dropped).map(([id,n])=>[id,-n]))))throw Error('village drop stock mismatch');return dropped;
}
export type VillageDeps={bank?:typeof runBankProfile;walk?:(s:Session,to:{x:number;z:number},stop:()=>boolean)=>Promise<void>};
export async function runVillageFishing(original:Session,o:VillageOrder,requestStop:()=>boolean=()=>false,deps:VillageDeps={}){
 const policy=villagePolicy(o),client=original.client,executor=(client as any)?.executeBotAction,first=original.sdk.getState()?.player,life=first?.lifeId,respawns=first?.respawnCount??0,hp=original.sdk.getSkill('Hitpoints')?.level??0,start=original.tick();let ended=false,lost=false,phase='admission';void original.ended.then(()=>{ended=true;});
 const gear=()=>JSON.stringify((original.sdk.getState()?.equipment??[]).map(i=>({slot:i.slot,id:i.id,count:i.count})).sort((a,b)=>a.slot-b.slot)),initialGear=gear(),initialOtherXp=JSON.stringify((original.sdk.getState()?.skills??[]).filter(k=>!['Fishing','Cooking'].includes(k.name)).map(k=>[k.name,k.experience]));
 const fatal=()=>{const p=original.sdk.getState()?.player;if(original.client!==client||(client as any)?.executeBotAction!==executor)lost=true;return lost||typeof executor!=='function'||ended||life===undefined||!p||p.isDead||p.lifeId!==life||(p.respawnCount??0)!==respawns||p.level!==0||(original.sdk.getSkill('Hitpoints')?.level??0)!==hp||gear()!==initialGear||JSON.stringify((original.sdk.getState()?.skills??[]).filter(k=>!['Fishing','Cooking'].includes(k.name)).map(k=>[k.name,k.experience]))!==initialOtherXp||original.tick()-start>=o.cap;};
 const stopped=()=>fatal()||productionStopRequested(original.name,requestStop);
 const guard=()=>{if(fatal())throw Error('village original life/owner/health/gear unavailable');if(phase==='produce'&&productionStopRequested(original.name,requestStop)){phase='return';throw Error('village work stopped; owned return permitted');}};
 const sdk=new Proxy(original.sdk,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);return typeof value==='function'?function(...args:unknown[]){if(typeof key==='string'&&key.startsWith('send'))guard();return value.apply(receiver,args);}:value;}});
 const s={...original,sdk,bot:new BotActions(sdk),direct:async(action:Parameters<Session['direct']>[0])=>{guard();return original.direct(action);}}as Session;
 if(hp<1||stopped())throw Error('village admission stopped');
 const receipts:{caught:Record<number,number>;cooked:Record<number,number>;burnt:number;dropped:Record<number,number>}[]=[];
 const move=async(to:{x:number;z:number},stop:()=>boolean,tol=1)=>{if(stop())throw Error('village route stopped');if(deps.walk){await deps.walk(s,to,stop);if(stop())throw Error('village route owner changed');const p=s.sdk.getState()?.player;if(!p||p.level!==0||Math.max(Math.abs(p.worldX-to.x),Math.abs(p.worldZ-to.z))>tol)throw Error('village cooking arrival unobserved');return;}const result=await walkPath(await sessionWalker(s),[{...to,tol}],{stop,maxTicks:Math.min(250,o.cap-(s.tick()-start)-o.returnTicks)});if(!result.ok||stop())throw Error('village cooking route '+result.detail);};
 const profile:BankProfile={bank:VILLAGE_BANK,site:VILLAGE_SPOT,inputs:{[policy.fish.bait]:1},tools:[policy.fish.tool],outputs:policy.outputs,capacityOutputs:{[policy.fish.products[0]!]:1},prepare:async()=>{phase='produce';if(stopped())throw Error('village stopped before travel');},run:async(n,cap,stop)=>{
  phase='produce';try{const over=()=>stop()||stopped(),before=pack(s),xpBefore=s.sdk.getSkillXp('Fishing')??0;
  await runStagedFishing({state:()=>s.sdk.getState(),tick:()=>s.tick(),stopped:over,interact:(i,op)=>s.sdk.sendInteractNpc(i,op),combine:(a,b)=>s.sdk.sendUseItemOnItem(a,b),wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1)},{method:o.method,amount:n,cap,maxAttempts:10,progressTicks:Math.min(300,cap),xpRate:o.xpRate});
  const at=s.sdk.getState()?.player;if(!at||over())throw Error('village stopped after fishing');await s.sdk.sendWalk(at.worldX,at.worldZ);await waitTicks(s,3);if(over())throw Error('village fishing settlement stopped');
  const after=pack(s),caught=Object.fromEntries(policy.fish.products.map(id=>[id,(after[id]??0)-(before[id]??0)])),total=Object.values(caught).reduce((a,b)=>a+b,0),fishingXp=Object.entries(caught).reduce((a,[id,n])=>a+n*(FISH_XP[+id]??NaN)*o.xpRate,0),expected={...caught,[policy.fish.bait]:-total};if(total<n||total>n+1||!villagePackEffect(before,after,expected)||(s.sdk.getSkillXp('Fishing')??0)-xpBefore!==fishingXp)throw Error('village fishing exact stock/XP mismatch');
  const receipt={caught,cooked:{}as Record<number,number>,burnt:0,dropped:{}as Record<number,number>};
  if(policy.cook){await move(VILLAGE_HEAT_STAND,over,0);for(const r of policy.recipes){const amount=caught[r.raw]??0;if(!amount)continue;const cookingXp=s.sdk.getSkillXp('Cooking')??0;const cooked=await runCookingBatch({state:()=>s.sdk.getState(),tick:()=>s.tick(),stop:over,close:async()=>{if(over())throw Error('village cooking stopped');await s.sdk.sendCloseModal();},heat:async(slot,kind)=>{if(over())return false;const heat=s.sdk.getState()?.nearbyLocs.find(l=>l.id===VILLAGE_HEAT.id&&l.x===VILLAGE_HEAT.x&&l.z===VILLAGE_HEAT.z&&nativeHeatSources().get(l.id)===kind&&l.distance<=2&&l.reachable!==false);if(!heat)throw Error('native village substitute range unobserved');return(await s.sdk.sendUseItemOnLoc(slot,heat.x,heat.z,heat.id)).success;},wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1)},r,{maximum:amount,cap:Math.max(1,o.cap-o.returnTicks-(s.tick()-start)),heat:'range'});if((s.sdk.getSkillXp('Cooking')??0)-cookingXp!==cooked.cooked*r.xp*o.xpRate/10)throw Error('village cooking native XP mismatch');receipt.burnt+=cooked.burnt;for(const[id,count]of Object.entries(cooked.products))receipt.cooked[+id]=(receipt.cooked[+id]??0)+count;}}
  if(policy.drop)receipt.dropped=await dropVillageOutput(s,policy.cook?policy.outputs.filter(id=>!policy.fish.products.includes(id as never)):policy.fish.products,28,over);
  receipts.push(receipt);return total;}finally{phase='return';}
 }};
 try{const result=await(deps.bank??runBankProfile)(s,{family:'village-fishing',recipe:o.method+':'+o.mode,target:o.target,batch:o.batch,reserve:o.reserve,cap:o.cap,returnTicks:o.returnTicks,members:false},profile,stopped);return{...result,mode:o.mode,receipts};}finally{phase='return';}
}
if(import.meta.main){const account=process.argv[2],path=process.argv[3];if(!account||!path)throw Error('usage: microbot-village-fishing.ts account order.json');const o=JSON.parse(readFileSync(path,'utf8'))as VillageOrder;villagePolicy(o);let stopped=false;const s=await openBot(account,{onStop:async()=>{stopped=true;}});let ok=false;try{const result=await runVillageFishing(s,o,()=>stopped);console.log('VILLAGE_FISHING '+JSON.stringify(result));ok=result.ok;}finally{ok=await settle([s],ok,'finite village fishing order');}process.exitCode=ok?0:1;}
