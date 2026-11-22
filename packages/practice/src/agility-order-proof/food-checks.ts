import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {readPracticeSave} from '../fleet-player-save';
import {
 actionLines,ARDOUGNE_ENTRY_CONFIGURATION,type Child,d8,type FallOutcome,FOOD_RECOVERY_CONFIGURATION,
 foodBinding,foodLines,type FoodConfig,GNOME_START,GNOME_STEPS,type HealConfig,INFLIGHT_BASE,
 INFLIGHT_FOOD_CONFIGURATION,initializationBinding,integer,items,lastLine,musicVarps,type Save,savedLogoutOf,
 sha256,singleIdentity,sources,STRONGHOLD_SOUTH,trainedLevel,
} from './contracts';
import {
 agilitySaveChecks,childChecks,femiGateVarp,initializationEvidenceChecks,savedCoursePosition,
 strongholdGateCrossed,zeroFallObserved,
} from './save-checks';

// Pinned consume_normal.dbrow heal_12 + consume.rs2 -> installed worker health():
// reuse the ordinary fixture lifecycle; adapt only current HP for a labelled recovery.
// Gnome's first obstacle cannot fall. Target 2 ends after that useful XP effect.
// 10 -> 22 -> 34 -> 46 necessarily requires three consecutive lobster heals.
export function foodRecoveryChecks(before:Save,after:Save,log:string,child:Child,name:string,C:FoodConfig=FOOD_RECOVERY_CONFIGURATION){
 let events:any[]=[];let readable=true;try{events=foodLines(log);}catch{readable=false;}
 const dispatch=events.filter(e=>e.event==='dispatch'),effects=events.filter(e=>e.event==='effect');
 const food=(s:Save)=>(s.inventories[93]??[]).filter(i=>i.id===C.foodId).reduce((n,i)=>n+i.count,0);
 const result=lastLine(log,'AGILITY_ORDER_RESULT');
 const tick=(n:any)=>Number.isSafeInteger(n)&&n>=0;
 const snapshot=(e:any)=>tick(e.tick)&&Number.isSafeInteger(e.hp)&&e.hp>0&&e.baseHp===C.baseHp
  &&Number.isFinite(e.xp)&&Array.isArray(e.inventory)&&new Set(e.inventory.map((i:any)=>i.slot)).size===e.inventory.length
  &&e.inventory.every((i:any)=>Number.isSafeInteger(i.slot)&&Number.isSafeInteger(i.id)&&Number.isSafeInteger(i.count)&&i.count>0)
  &&e.count===e.inventory.filter((i:any)=>i.id===C.foodId).reduce((n:number,i:any)=>n+i.count,0)
  &&Object.hasOwn(e,'anim')&&Object.hasOwn(e,'dialog')&&Array.isArray(e.messages)&&e.rejected===0;
 let order=readable&&dispatch.length===3&&effects.length===3,heals=order,cooldown=order,slots=order;
 let previous:any;
 for(let i=0;i<dispatch.length;i++){
  const d=dispatch[i],seq=i+1,group=events.filter(e=>e.sequence===seq&&e.event!=='cooldown');
  if(!snapshot(d)){order=false;heals=false;slots=false;cooldown=false;continue;}
  const r=group.filter(e=>e.event==='reply'),o=group.filter(e=>e.event==='observation'),e=group.filter(e=>e.event==='effect');
  order&&=d.sequence===seq&&group[0]===d&&r.length===1&&r[0].reply?.success===true&&e.length===1
   &&group.at(-1)===e[0]&&o.length>0&&group.every((v,j)=>snapshot(v)&&v.slot===d.slot&&v.id===C.foodId&&v.held===d.held&&(j===0||v.tick>=group[j-1].tick))
   &&group[1]===r[0]&&group.slice(2,-1).every(v=>v.event==='observation');
  if(!e[0]){heals=false;cooldown=false;slots=false;continue;}
  const effect=e[0],hpFirst=o.find(v=>v.hp>d.hp),debitFirst=o.find(v=>v.count===d.count-1);
  heals&&=d.count===C.foodCount-i&&d.held===d.count&&d.hp===C.currentHp+i*C.heal&&d.xp===before.skills[16]!.xp
   &&effect.hp===d.hp+C.heal&&effect.count===d.count-1&&effect.xp===d.xp
   &&tick(effect.hpTick)&&tick(effect.inventoryTick)&&effect.hpTick===hpFirst?.tick&&effect.inventoryTick===debitFirst?.tick
   &&effect.tick>=d.tick&&effect.tick-d.tick<=C.effectTicks&&effect.hpTick>=d.tick&&effect.inventoryTick>=d.tick;
  const expected=d.inventory.filter((v:any)=>v.slot!==d.slot);
  heals&&=o.every(v=>(v.hp===d.hp||v.hp===d.hp+C.heal)&&(v.count===d.count||v.count===d.count-1)
   &&(v.tick<(hpFirst?.tick??Infinity)||v.hp===d.hp+C.heal)
   &&(v.tick<(debitFirst?.tick??Infinity)||v.count===d.count-1));
  slots&&=d.inventory.some((v:any)=>v.slot===d.slot&&v.id===C.foodId&&v.count===1)
   &&isDeepStrictEqual(expected,effect.inventory)
   &&o.every(v=>isDeepStrictEqual(v.inventory,v.count===d.count?d.inventory:expected))
   &&isDeepStrictEqual(d.inventory,i===0?before.inventories[93]:previous?.inventory);
  if(previous){
   const c=events.filter(v=>v.sequence===seq&&v.event==='cooldown');
   cooldown&&=c.length===1&&c[0].lastEffectTick===previous.tick&&c[0].tick===previous.tick
    &&c[0].readyAfter===previous.tick+C.eatDelayTicks&&d.tick>c[0].readyAfter
    &&d.tick<=c[0].readyAfter+2&&events.indexOf(c[0])>events.indexOf(previous)&&events.indexOf(c[0])<events.indexOf(d);
  }
  previous=effect;
 }
 const state=agilitySaveChecks(before,after,C.target);
 return{...state,...childChecks(child,log,'progress'),readable,
  start:isDeepStrictEqual(before.position,C.position)&&before.skills[3]?.level===C.currentHp
   &&trainedLevel(before.skills[3]!.xp)===C.baseHp&&before.skills[16]?.rawExperience===0&&food(before)===C.foodCount,
  identity:/^[a-z0-9]{1,12}$/i.test(name)&&(log.match(/^LEDGER .* bot=([^\r\n]+)$/gm)??[]).length===1
   &&new RegExp(`^LEDGER .* bot=${name}$`,'m').test(log),
  order,heals,cooldown,slots,
  events:events.every(e=>Number.isSafeInteger(e.sequence)&&e.sequence>=1&&e.sequence<=3
   &&['dispatch','reply','observation','effect','cooldown'].includes(e.event))
   &&events.filter(e=>e.event==='cooldown').length===2,
  debit:food(before)-food(after)===3&&result?.eats===3,
  savedHp:after.skills[3]?.level===C.currentHp+3*C.heal,
  savedInventory:!!previous&&isDeepStrictEqual(after.inventories[93],previous.inventory),
  retainedSkills:before.skills.every((s,i)=>i===16||i===3||isDeepStrictEqual(s,after.skills[i])),
  retainedAssets:[...new Set([...Object.keys(before.inventories),...Object.keys(after.inventories)])]
   .every(k=>k==='93'||isDeepStrictEqual(before.inventories[Number(k)],after.inventories[Number(k)])),
  progress:!!previous&&[...log.matchAll(/^AGILITY_PROGRESS level=\d+ xp=(\d+(?:\.\d+)?) tick=(\d+) step=\w+$/gm)]
   .some(m=>Number(m[1])>before.skills[16]!.xp&&Number(m[2])>previous.tick)
   &&result?.course===C.course&&result?.target===C.target,
  savedLogout:(after.vars[134]??0)>(before.vars[134]??0),position:savedCoursePosition(after,'gnome')};
}

const sampleValue=(v:any)=>({tick:v.tick,at:v.at,anim:v.anim,rejected:v.rejected,mapFlags:v.mapFlags,hp:v.hp,xp:v.xp,ops:v.ops,messages:v.messages});
function samplesValid(samples:any[]){
 return samples.length>0&&samples.every((v,i)=>integer(v?.tick)&&/^\d+,\d+,[0-3]$/.test(v.at)
  &&Number.isSafeInteger(v.anim)&&v.anim>=-1&&integer(v.rejected)&&integer(v.mapFlags)&&integer(v.ops)&&integer(v.hp)&&v.hp>0&&Number.isFinite(v.xp)&&v.xp>=0
  &&Array.isArray(v.messages)&&v.messages.every((m:any)=>integer(m?.tick)&&typeof m.text==='string')
  &&(i===0||v.tick===samples[i-1].tick+1&&v.rejected>=samples[i-1].rejected&&v.mapFlags>=samples[i-1].mapFlags&&v.ops>=samples[i-1].ops&&v.xp>=samples[i-1].xp));
}

// Independent of the worker's quiet/settled decision. Require every tick, including unchanged ticks.
export function settlementEvidence(v:any,d:any,actions:any[]):{settled:boolean;active:boolean}{
 const no={settled:false,active:false},C=INFLIGHT_FOOD_CONFIGURATION;
 if(!v||!Array.isArray(v.marks)||!Array.isArray(v.observations)||!samplesValid(v.marks)||!samplesValid(v.observations))return no;
 const m=v.marks,first=m[0],last=m.at(-1),dispatch=actions.filter(a=>a.event==='dispatch'&&a.ops===v.actionId);
 if(dispatch.length!==1)return no;
 const a=dispatch[0],quiet=m.slice(-C.quietTicks-1);
 const settled=v.settled===true&&v.quiet===C.quietTicks&&v.opsWhileSettling===0&&v.opsSinceDispatch===first.ops-a.ops
  &&integer(v.start)&&integer(v.tick)&&v.tick-v.start<=C.settleMaxTicks&&v.tick>=v.start&&v.dispatchTick===a.tick
  &&a.speculative===false&&a.actionId===a.ops&&v.step===a.step&&v.dispatchAt===a.at
  &&v.dispatchTick<=v.start&&first.tick===v.start&&last.tick===v.tick&&v.tick===d.tick
  &&v.observations[0].tick===a.tick&&isDeepStrictEqual(v.observations[0],sampleValue(a))
  &&m.every((p:any)=>p.ops===first.ops)&&quiet.length===C.quietTicks+1
  &&quiet.every((p:any)=>p.anim===-1&&p.at===last.at&&p.rejected===last.rejected&&p.mapFlags===last.mapFlags&&p.hp===last.hp&&p.xp===last.xp)
  &&last.at===d.at&&last.hp===d.hp&&last.xp===d.xp&&last.ops===d.workerOps&&d.anim===-1
  &&v.rejected===last.rejected-a.rejected
  &&!actions.some(p=>p.event!=='observation'&&p.ops>first.ops&&p.tick>=v.start&&p.tick<=v.tick
   &&!(p.event==='food'&&p.sequence===d.sequence&&p.tick===d.tick&&p.ops===d.workerOps+1));
 if(!settled)return no;
 if(a.step!=='stones')return{settled:true,active:false};
 const raw=[sampleValue(a),...actions.filter(p=>p.event==='observation'&&p.actionId===a.ops&&p.tick<=v.tick).map(sampleValue)];
 // Cross-check nested samples against the separately published ordered observations and operation log.
 if(!isDeepStrictEqual(raw,v.observations)||!isDeepStrictEqual(raw.filter(p=>p.tick>=v.start),m))return no;
 const due=raw.findIndex(p=>p.tick===v.start),prev=raw[due-1],now=raw[due];
 // Stones start at x3002. The normal crossing reaches x2996 only after the last jump.
 const onStones=(p:any)=>p.at.endsWith(',3960,0')&&Number(p.at.split(',')[0])>=2997&&Number(p.at.split(',')[0])<=3002;
 const active=a.locId===2311&&a.x===3001&&a.z===3960&&!!prev&&prev.hp>=C.baseHp/2&&now.hp<C.baseHp/2
  &&now.anim===741&&onStones(now)&&now.tick>a.tick
  &&raw.some(p=>p.tick<=now.tick&&p.messages.some((msg:any)=>msg.tick>=a.tick&&msg.tick<=p.tick&&msg.text==='You carefully start crossing the stepping stones...'))
  &&m.some((p:any)=>onStones(p)&&p.at!==now.at&&p.mapFlags>now.mapFlags&&p.ops===now.ops)
  &&!actions.some(p=>p.event==='dispatch'&&p.speculative===false&&p.ops>a.ops&&p.tick<=v.tick);
 return{settled:true,active};
}

export function inflightFoodChecks(before:Save,after:Save,log:string,child:Child,name:string){
 const C=INFLIGHT_FOOD_CONFIGURATION;
 let events:any[]=[],actions:any[]=[],stream:{kind:string;value:any}[]=[];let readable=true;
 try{events=foodLines(log);actions=actionLines(log);
  stream=log.split(/\r?\n/).flatMap(l=>l.startsWith('AGILITY_FOOD ')?[{kind:'food',value:JSON.parse(l.slice(13))}]
   :l.startsWith('AGILITY_ACTION ')?[{kind:'action',value:JSON.parse(l.slice(15))}]:[]);
 }catch{events=[];actions=[];stream=[];readable=false;}
 const food=(s:Save)=>(s.inventories[93]??[]).filter(i=>i.id===C.foodId).reduce((n,i)=>n+i.count,0);
 const result=lastLine(log,'AGILITY_ORDER_RESULT');
 const falls=[...log.matchAll(/^AGILITY_RECOVERY fall tick=(\d+) /gm)].map(m=>Number(m[1]));
 const dispatch=events.filter(e=>e.event==='dispatch'),effects=events.filter(e=>e.event==='effect');
 let heals=readable&&dispatch.length>=1&&effects.length===dispatch.length,settled=heals,isolation=heals,active=false;
 for(const [i,d] of dispatch.entries()){
  const group=events.filter(e=>e.sequence===i+1),st=group.filter(e=>e.event==='settle');
  const r=group.filter(e=>e.event==='reply'),e=group.filter(e=>e.event==='effect');
  const at=(v:any)=>group.indexOf(v);
  // A settle report precedes its dispatch, observed every quiet tick, and sent no packet.
  const validated=st.map(v=>settlementEvidence(v,d,actions));
  const previous=effects[i-1],actionSince=actions.some(a=>a.event==='dispatch'&&a.tick<=d.tick&&(!previous||a.tick>=previous.tick));
  settled&&=st.length===(actionSince?1:0)&&validated.every(v=>v.settled)&&st.every(v=>at(v)<at(d));
  active||=validated.some(v=>v.active);
  heals&&=d.sequence===i+1&&r.length===1&&r[0].reply?.success===true&&e.length===1&&at(r[0])===at(d)+1&&at(e[0])===group.length-1
   &&d.hp<C.baseHp/2&&d.held===d.count&&d.id===C.foodId&&e[0].hp===Math.min(C.baseHp,d.hp+C.heal)&&e[0].hp>d.hp
   &&e[0].count===d.count-1&&e[0].tick>=d.tick&&e[0].tick-d.tick<=C.effectTicks&&Number.isSafeInteger(e[0].hpTick)&&Number.isSafeInteger(e[0].inventoryTick);
  // Only the eat was sent between dispatch and effect, and the server refused nothing in that window.
  isolation&&=d.ops===0&&d.rejected===0&&group.filter(v=>v.event==='observation'||v.event==='effect').every(v=>v.ops===1&&v.rejected===0);
  const observations=group.filter(v=>v.event==='observation'),effect=e[0],expected=Array.isArray(d.inventory)?d.inventory.filter((v:any)=>v.slot!==d.slot):[];
  heals&&=Array.isArray(d.inventory)&&d.inventory.some((v:any)=>v.slot===d.slot&&v.id===C.foodId&&v.count===1)
   &&isDeepStrictEqual(d.inventory,previous?.inventory??before.inventories[93])&&!!effect
   &&isDeepStrictEqual(effect.inventory,expected)&&effect.hpTick===observations.find(v=>v.hp>d.hp)?.tick
   &&effect.inventoryTick===observations.find(v=>v.count===d.count-1)?.tick
   &&observations.length>0&&group.filter(v=>!['settle','cooldown'].includes(v.event)).every((v,j,list)=>integer(v.tick)&&(j===0||v.tick>=list[j-1].tick)
    &&v.id===d.id&&v.slot===d.slot&&v.held===d.held&&v.xp===d.xp&&v.baseHp===C.baseHp
    &&v.count===(v.inventory??[]).filter((item:any)=>item.id===C.foodId).reduce((n:number,item:any)=>n+item.count,0))
   &&observations.every(v=>(v.hp===d.hp||v.hp===Math.min(C.baseHp,d.hp+C.heal))
    &&isDeepStrictEqual(v.inventory,v.count===d.count?d.inventory:expected));
  isolation&&=group.filter(v=>v.event==='reply'||v.event==='observation'||v.event==='effect')
   .every(v=>v.workerOps===d.workerOps+1&&v.ops===1&&v.rejected===0)
   &&actions.filter(a=>a.event==='food'&&a.sequence===d.sequence&&a.tick===d.tick&&a.ops===d.workerOps+1).length===1
   &&!actions.some(a=>a.event!=='observation'&&a.ops>d.workerOps+1&&a.tick<=effect?.tick&&a.tick>=d.tick);
  const line=(kind:string,event:string)=>stream.findIndex(v=>v.kind===kind&&v.value.event===event&&v.value.sequence===d.sequence);
  isolation&&=line('food','dispatch')<line('action','food')&&line('action','food')<line('food','reply');
 }
 const last=effects.at(-1);
 const state=agilitySaveChecks(before,after,C.target),agi=before.skills[16];
 return{...state,...childChecks(child,log,'progress'),readable,
  start:isDeepStrictEqual(before.position,C.position)&&before.skills[3]?.level===C.currentHp&&trainedLevel(before.skills[3]!.xp)===C.baseHp
   &&agi?.level===C.startLevel&&trainedLevel(agi.xp)===C.startLevel&&food(before)===C.foodCount,
  identity:/^[a-z0-9]{1,12}$/i.test(name)&&(log.match(/^LEDGER .* bot=([^\r\n]+)$/gm)??[]).length===1&&new RegExp(`^LEDGER .* bot=${name}$`,'m').test(log),
  savedLogout:(after.vars[134]??0)>(before.vars[134]??0),position:savedCoursePosition(after,'wilderness'),
  fallBeforeFood:falls.length>=1&&!!dispatch[0]&&falls[0]!<=dispatch[0].tick,
  // A completed fall/pit landing and a speculative pending label cannot prove active stones timing.
  inflight:active,
  settled,heals,isolation,
  actions:actions.length>0&&actions.every((a,i)=>integer(a.tick)&&integer(a.ops)&&['dispatch','observation','food','modal'].includes(a.event)
   &&(i===0||a.tick>=actions[i-1].tick&&a.ops>=actions[i-1].ops))
   &&actions.filter(a=>a.event!=='observation').every((a,i)=>a.ops===i+1),
  traceOrder:stream.length>0&&stream.every((v,i)=>integer(v.value.tick)&&(i===0||v.value.tick>=stream[i-1].value.tick)),
  events:events.every(e=>Number.isSafeInteger(e.sequence)&&e.sequence>=1&&['settle','dispatch','reply','observation','effect','cooldown'].includes(e.event)),
  debit:food(before)-food(after)===effects.length&&result?.eats===effects.length,
  savedInventory:!!last&&isDeepStrictEqual(after.inventories[93],last.inventory),
  savedHp:after.skills[3]?.level===result?.finalHp&&result.finalHp>0,
  progress:!!last&&[...log.matchAll(/^AGILITY_PROGRESS level=\d+ xp=(\d+(?:\.\d+)?) tick=(\d+) step=\w+$/gm)]
   .some(m=>Number(m[1])>last.xp&&Number(m[2])>last.tick)&&result?.course===C.course&&result?.target===C.target};
}

// A sample without a fall line is only a retained zero-fall sample when every other obstacle earned XP.
export function inflightFoodOutcome(checks:Record<string,boolean>,before:Save,after:Save,log:string):FallOutcome{
 if(/^AGILITY_RECOVERY fall /m.test(log))return Object.values(checks).every(Boolean)?'proved':'failed';
 return INFLIGHT_BASE.every(k=>checks[k])&&!/^AGILITY_FOOD /m.test(log)&&zeroFallObserved(before,after,log)?'zero-fall':'failed';
}

export function readInflightSample(directory:string,label:string,fixture:number){
 const [b,a,l]=[`${label}-before.sav`,`${label}-after.sav`,`${label}.log`].map(f=>join(directory,f));
 const [ib,ia,il]=[`initial-${fixture}-before.sav`,`initial-${fixture}-after.sav`,`initial-${fixture}.log`].map(f=>join(directory,f));
 return{before:readPracticeSave(b!),after:readPracticeSave(a!),log:readFileSync(l!,'utf8'),
  sha256:{before:sha256(readFileSync(b!)),after:sha256(readFileSync(a!)),log:sha256(readFileSync(l!))},
  initial:JSON.parse(readFileSync(join(directory,`initial-${fixture}.json`),'utf8')),
  initialFiles:{before:readPracticeSave(ib!),after:readPracticeSave(ia!),log:readFileSync(il!,'utf8'),
   sha256:{before:sha256(readFileSync(ib!)),after:sha256(readFileSync(ia!)),log:sha256(readFileSync(il!))}}};
}

// Independent recomputation from raw CRC-valid bytes and logs. Recorded flags never grant a pass.
export function verifyInflightFood(directory:string,source:unknown){
 const C=INFLIGHT_FOOD_CONFIGURATION,checks:Record<string,boolean>={};
 let meta:any;try{meta=JSON.parse(readFileSync(join(directory,'inflight.json'),'utf8'));}catch{return{'inflight.files':false};}
 const samples:any[]=Array.isArray(meta?.samples)?meta.samples:[];
 checks['inflight.configuration']=isDeepStrictEqual(meta.configuration,C);
 checks['inflight.source']=isDeepStrictEqual(meta.source,source);
 checks['inflight.count']=samples.length>=1&&samples.length<=C.fixtures.length;
 checks['inflight.unique']=new Set(samples.map(s=>s?.name)).size===samples.length;
 checks['inflight.omitted']=C.fixtures.slice(samples.length).every((_,i)=>!existsSync(join(directory,`inflight-${samples.length+i+1}.log`)));
 for(const [i,s] of samples.entries()){
  const key=`inflight-${i+1}`,lastSample=i===samples.length-1;
  const order=s?.index===i+1&&s?.fixture===C.fixtures[i]&&s?.label===key&&typeof s?.name==='string'&&s.name.endsWith(String(s.fixture));
  checks[`${key}.order`]=order;
  let files:ReturnType<typeof readInflightSample>|undefined;try{files=readInflightSample(directory,key,C.fixtures[i]!);}catch{}
  checks[`${key}.files`]=!!files;
  if(!files||!order||!s.child){checks[`${key}.outcome`]=false;continue;}
  checks[`${key}.hashes`]=isDeepStrictEqual(files.sha256,s.sha256);
  const init=initializationEvidenceChecks(files.initialFiles.before,files.initialFiles.after,files.initialFiles.log,files.initial.child,s.name);
  const binding=initializationBinding(s.name,s.fixture,source,files.initialFiles.sha256);
  checks[`${key}.initialized`]=Object.values(init).every(Boolean)&&isDeepStrictEqual(files.initial.checks,init)
   &&files.initial.name===s.name&&files.initial.index===s.fixture&&!files.initial.error&&!files.initial.captureError;
  checks[`${key}.initializationBinding`]=isDeepStrictEqual(files.initial.binding,binding)&&isDeepStrictEqual(s.initialization,binding);
  checks[`${key}.initialBaseline`]=files.initialFiles.sha256.after===files.sha256.before;
  const recomputed=inflightFoodChecks(files.before,files.after,files.log,s.child,s.name);
  for(const [k,v] of Object.entries(recomputed))checks[`${key}.${k}`]=lastSample?v:INFLIGHT_BASE.includes(k as any)?v:true;
  const outcome=inflightFoodOutcome(recomputed,files.before,files.after,files.log);
  checks[`${key}.outcome`]=outcome===s.outcome&&outcome===(lastSample?'proved':'zero-fall');
 }
 checks.inflight=Object.values(checks).every(Boolean);
 return checks;
}

// Raw files are decoded with CRC validation on every verification. Recorded checks never grant a pass.
export function verifyFoodRecovery(directory:string,source:unknown=sources(),requireReport=true):Record<string,boolean>{
 try{
  const meta=JSON.parse(readFileSync(join(directory,'food-recovery.json'),'utf8'));
  const b=join(directory,'food-before.sav'),a=join(directory,'food-after.sav'),l=join(directory,'food.log');
  const hashes={before:sha256(readFileSync(b)),after:sha256(readFileSync(a)),log:sha256(readFileSync(l))};
  const initial=JSON.parse(readFileSync(join(directory,'initial-10.json'),'utf8'));
  const ib=join(directory,'initial-10-before.sav'),ia=join(directory,'initial-10-after.sav'),il=join(directory,'initial-10.log');
  const initHashes={before:sha256(readFileSync(ib)),after:sha256(readFileSync(ia)),log:sha256(readFileSync(il))};
  const binding=initializationBinding(meta.name,10,source,initHashes);
  const initChecks=initializationEvidenceChecks(readPracticeSave(ib),readPracticeSave(ia),readFileSync(il,'utf8'),initial.child,meta.name);
  const checks={files:true,source:isDeepStrictEqual(meta.source,source),configuration:isDeepStrictEqual(meta.configuration,FOOD_RECOVERY_CONFIGURATION),
   binding:isDeepStrictEqual(meta.binding,foodBinding(meta.name,source,meta.child,hashes,binding)),
   initialized:initial.name===meta.name&&initial.index===10&&!initial.error&&!initial.captureError
    &&isDeepStrictEqual(initial.binding,binding)&&isDeepStrictEqual(initial.checks,initChecks)&&Object.values(initChecks).every(Boolean)
    &&hashes.before===initHashes.after,
   ...foodRecoveryChecks(readPracticeSave(b),readPracticeSave(a),readFileSync(l,'utf8'),meta.child,meta.name),
   ...verifyInflightFood(directory,source)};
  if(!requireReport)return checks;
  const report=JSON.parse(readFileSync(join(directory,'consumer.json'),'utf8'));
  return{...checks,report:report.ok===true&&isDeepStrictEqual(report.checks,checks)&&report.name===meta.name
   &&isDeepStrictEqual(report.binding,meta.binding)&&isDeepStrictEqual(report.source,source)
   &&isDeepStrictEqual(report.configuration,FOOD_RECOVERY_CONFIGURATION)};
 }catch{return{files:false};}
}

// Course-scope isolation: no Wilderness/Barbarian step, recovery or in-flight trace in a Gnome case.
export function gnomeScope(log:string,mode:'progress'|'refusal'){
 let actions:any[];try{actions=actionLines(log);}catch{return false;}
 const steps=[...log.matchAll(/^AGILITY_PROGRESS level=\d+ xp=\S+ tick=\d+ step=(\w+)\r?$/gm)].map(m=>m[1]!);
 const dispatched=actions.filter(a=>a.event==='dispatch').map(a=>a.step);
 const known=(s:unknown)=>(GNOME_STEPS as readonly unknown[]).includes(s);
 if(/^AGILITY_(RECOVERY|INFLIGHT)/m.test(log))return false;
 if(mode==='refusal')return steps.length===0&&dispatched.length===0;
 return lastLine(log,'AGILITY_ORDER_RESULT')?.course==='gnome'&&steps.length>0&&steps.every(known)&&dispatched.every(known);
}

// Shared health() -> settleObstacle(): a food dispatch after a course dispatch that no settled report retired
// needs exactly one settled report for that sequence; otherwise no report may exist. Recomputed from the
// ordered AGILITY_FOOD/AGILITY_ACTION stream. Each eat is the only packet between its dispatch and reply.
export function sharedSettlementChecks(log:string){
 const no={settlement:false,actions:false,foodActions:false};
 let stream:{kind:'food'|'action';value:any}[];
 try{stream=log.split(/\r?\n/).flatMap((l):{kind:'food'|'action';value:any}[]=>l.startsWith('AGILITY_FOOD ')?[{kind:'food',value:JSON.parse(l.slice(13))}]
  :l.startsWith('AGILITY_ACTION ')?[{kind:'action',value:JSON.parse(l.slice(15))}]:[]);}catch{return no;}
 if(!stream.every(v=>!!v.value&&typeof v.value==='object'&&!Array.isArray(v.value)))return no;
 const actions=stream.filter(v=>v.kind==='action').map(v=>v.value);
 let settlement=true,foodActions=true,pending=false,settles:any[]=[];
 for(const [i,{kind,value:v}] of stream.entries()){
  if(kind==='action'){if(v.event==='dispatch'&&v.speculative===false)pending=true;continue;}
  if(v.event==='settle'){settles.push(v);continue;}
  if(v.event!=='dispatch')continue;
  settlement&&=settles.length===(pending?1:0)&&settles.every(s=>s.sequence===v.sequence&&settlementEvidence(s,v,actions).settled);
  if(settles.length)pending=false;
  settles=[];
  const reply=stream.findIndex((x,j)=>j>i&&x.kind==='food'&&x.value.event==='reply'&&x.value.sequence===v.sequence);
  const between=reply>i?stream.slice(i+1,reply).filter(x=>x.kind==='action'):[];
  foodActions&&=between.length===1&&between[0]!.value.event==='food'&&between[0]!.value.sequence===v.sequence&&between[0]!.value.ops===v.workerOps+1;
 }
 settlement&&=settles.length===0;
 return{settlement,foodActions,actions:actions.length>0&&actions.every((a,i)=>integer(a.tick)&&integer(a.ops)&&['dispatch','observation','food','modal'].includes(a.event)
  &&(i===0||a.tick>=actions[i-1].tick&&a.ops>=actions[i-1].ops))&&actions.filter(a=>a.event!=='observation').every((a,i)=>a.ops===i+1)};
}

export function gnomeFoodChecks(before:Save,after:Save,log:string,child:Child,name:string,C:FoodConfig){
 return{...foodRecoveryChecks(before,after,log,child,name,C),...sharedSettlementChecks(log),scope:gnomeScope(log,'progress')};
}

// Ordered, exact food effects for any number of heals: dispatch at low HP, one successful reply, observed
// HP rise (capped at base) and one-item debit, inventory equality and eat-delay cooldown between heals.
export function healSequence(events:any[],before:Save,C:HealConfig){
 const dispatch=events.filter(e=>e.event==='dispatch'),effects=events.filter(e=>e.event==='effect');
 let ok=dispatch.length>=1&&effects.length===dispatch.length,previous:any;
 for(const [i,d] of dispatch.entries()){
  const seq=i+1,group=events.filter(e=>e.sequence===seq&&e.event!=='cooldown'&&e.event!=='settle');
  const r=group.filter(e=>e.event==='reply'),o=group.filter(e=>e.event==='observation'),effect=group.find(e=>e.event==='effect');
  if(!effect||!Array.isArray(d.inventory)){ok=false;continue;}
  ok&&=d.sequence===seq&&group[0]===d&&r.length===1&&group[1]===r[0]&&r[0].reply?.success===true&&group.filter(e=>e.event==='effect').length===1
   &&group.at(-1)===effect&&o.length>0&&group.slice(2,-1).every(v=>v.event==='observation')
   &&d.id===C.foodId&&d.held===d.count&&d.baseHp===C.baseHp&&d.hp<Math.max(8,C.baseHp*0.5)
   &&effect.hp===Math.min(C.baseHp,d.hp+C.heal)&&effect.hp>d.hp&&effect.count===d.count-1
   &&integer(effect.tick)&&effect.tick>=d.tick&&effect.tick-d.tick<=C.effectTicks
   &&effect.hpTick===o.find(v=>v.hp>d.hp)?.tick&&effect.inventoryTick===o.find(v=>v.count===d.count-1)?.tick
   &&group.every((v,j)=>integer(v.tick)&&(j===0||v.tick>=group[j-1].tick)&&v.slot===d.slot&&v.id===d.id&&v.held===d.held&&v.baseHp===C.baseHp)
   &&d.inventory.some((v:any)=>v.slot===d.slot&&v.id===C.foodId&&v.count===1)
   &&isDeepStrictEqual(effect.inventory,d.inventory.filter((v:any)=>v.slot!==d.slot))
   &&isDeepStrictEqual(d.inventory,i===0?before.inventories[93]:previous?.inventory)
   &&o.every(v=>(v.hp===d.hp||v.hp===effect.hp)&&isDeepStrictEqual(v.inventory,v.count===d.count?d.inventory:effect.inventory));
  // Natural regeneration may add HP between login and the first eat; it can never remove the low-HP need.
  if(i===0)ok&&=d.hp>=C.currentHp;
  if(previous){
   const c=events.filter(v=>v.sequence===seq&&v.event==='cooldown');
   ok&&=c.length<=1&&d.tick>previous.tick+C.eatDelayTicks&&(c.length===0||c[0].lastEffectTick===previous.tick&&c[0].readyAfter===previous.tick+C.eatDelayTicks
    &&events.indexOf(c[0])>events.indexOf(previous)&&events.indexOf(c[0])<events.indexOf(d));
  }
  previous=effect;
 }
 return{ok,count:effects.length,last:previous};
}

// Town -> gate -> Femi -> course: the planned gate route from 2654,3283, observed gate walk, exact crossing
// 2461,3385 with Femi's final thanks, observed course approach, owned-food heals, Agility10 and logout.
export function ardougneEntryChecks(before:Save,after:Save,log:string,child:Child,name:string){
 const A=ARDOUGNE_ENTRY_CONFIGURATION,b=items(before),a=items(after),keys=new Set([...b.keys(),...a.keys()]),foodKey=`93:${A.foodId}`;
 const lines=(tag:string)=>log.split(/\r?\n/).filter(l=>l.startsWith(tag+' ')).flatMap(l=>{try{return[JSON.parse(l.slice(tag.length+1))];}catch{return[];}});
 const route=lines('AGILITY_ENTRY_ROUTE'),entry=lines('AGILITY_ENTRY').at(-1),walks=lines('AGILITY_ENTRY_WALK');
 const result=lastLine(log,'AGILITY_ORDER_RESULT'),at=(tag:string)=>log.split(/\r?\n/).findIndex(l=>l.startsWith(tag+' '));
 let events:any[]=[],readable=true;try{events=foodLines(log);}catch{readable=false;}
 const heals=healSequence(events,before,A);
 const food=(s:Save)=>(s.inventories[93]??[]).filter(i=>i.id===A.foodId).reduce((n,i)=>n+i.count,0);
 const reached=(label:string,goal:{x:number;z:number})=>{const w=walks.filter(v=>v?.label===label).at(-1)?.current;
  return w?.ok===true&&w.at?.level===0&&d8(w.at,goal)<=1;};
 const agi=after.skills[16],old=before.skills[16];
 return{...childChecks(child,log,'progress'),readable,
  start:isDeepStrictEqual(before.position,A.position)&&before.skills[3]?.level===A.currentHp&&trainedLevel(before.skills[3]!.xp)===A.baseHp
   &&A.currentHp<Math.max(8,A.baseHp*0.5)&&old?.rawExperience===0&&food(before)===A.foodCount&&trainedLevel(before.skills[17]?.xp??0)===99,
  route:route.length===1&&route[0].route==='gate'&&route[0].at==='2654,3283,0'&&entry?.route==='walk'&&entry.fares===0&&entry.coinsSpent===0
   &&entry.foodBought===0&&!/^AGILITY_ENTRY_(FARE|PURCHASE) /m.test(log)&&at('AGILITY_ENTRY_ROUTE')<at('AGILITY_ENTRY_GATE')&&at('AGILITY_ENTRY_GATE')<at('AGILITY_ENTRY'),
  walk:reached('walk to Stronghold gate',STRONGHOLD_SOUTH)&&reached('course approach',GNOME_START),
  gate:strongholdGateCrossed(log),
  femi:(before.vars[152]??0)===0&&after.vars[152]===2&&femiGateVarp(before,after,log),
  heals:readable&&heals.ok,
  debit:food(before)-food(after)===heals.count&&result?.eats===heals.count&&entry?.eats===heals.count,
  savedHp:after.skills[3]?.level===result?.finalHp&&result.finalHp>A.currentHp&&result.finalHp<=A.baseHp,
  target:!!agi&&!!old&&agi.rawExperience>old.rawExperience&&trainedLevel(agi.xp)>=A.target&&trainedLevel(old.xp)<A.target
   &&result?.course==='gnome'&&result?.target===A.target,
  position:savedCoursePosition(after,'gnome'),
  assets:[...keys].every(k=>k===foodKey?(a.get(k)??0)===(b.get(k)??0)-heals.count:(b.get(k)??0)===(a.get(k)??0)),
  skills:before.skills.every((s,i)=>i===16||after.skills[i]?.rawExperience===s.rawExperience&&(i===3||after.skills[i]?.level===s.level)),
  vars:[...new Set([...Object.keys(before.vars),...Object.keys(after.vars)])].every(k=>{
   const id=Number(k),old=before.vars[id]??0,next=after.vars[id]??0;
   if(id===134)return Number.isSafeInteger(next)&&next>=0;
   if(musicVarps.has(id))return ((old&next)>>>0)===(old>>>0);
   if(id===152)return femiGateVarp(before,after,log);
   return [173,264,265,266].includes(id)||old===next;
  }),
  alive:(after.skills[3]?.level??0)>0,identity:singleIdentity(log,name),savedLogout:savedLogoutOf(before,after),
  ...sharedSettlementChecks(log),scope:gnomeScope(log,'progress')};
}
