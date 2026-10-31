// Harness entry only. No game or server work occurs on import or with --verify.
// Native: bun packages/practice/src/magic-order-proof.ts (DELIVERY_DIR set by the delivery harness).
// Saved-state consumer: the same command with --verify reads the retained .sav files and logs only.
import {readFileSync,writeFileSync,copyFileSync,existsSync,openSync,closeSync,unlinkSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {workerSourceRevision} from '../../core/src/worker-release';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';

type Save=ReturnType<typeof readPracticeSave>;
const root=resolve(import.meta.dir,'../../..');
const OWNED=['scripts/magic-order.ts','scripts/magic-order.test.ts','packages/practice/src/magic-order-proof.ts','packages/practice/test/magic-order-proof.test.ts'];
export function sources(){return{runtime:workerSourceRevision(),files:Object.fromEntries([...OWNED,
 'scripts/shop-buyer.ts','scripts/train-chickens.ts','scripts/quest-sustain.ts','packages/core/src/walk.ts','packages/core/src/deposit.ts',
 'vendor/rs-sdk/server/content/scripts/skill_combat/scripts/player/player_magic.rs2',
 'vendor/rs-sdk/server/content/scripts/skill_combat/configs/magic/magic_combat_spells.dbrow',
 'vendor/rs-sdk/server/content/scripts/areas/area_varrock/configs/varrock.inv',
].map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]))};}
// Admission uses the shared practice floor and startup reserve.
export const ADMISSION={floorGb:FREE_FLOOR_GB,startupGb:PRACTICE_STARTUP_GB};
export const CONFIG={tickMs:150,xpRate:25,childTimeoutMs:240000,saveWaitMs:20000,freshMs:900000} as const;
const AIR=556,MIND=558,COINS=995,TROUT=333;
const SPENT=new Set([AIR,MIND,COINS,TROUT]);
export const FIXTURES={
 // The Abracadickra shape: Varrock West bank, HP10, banked coins, 37 air and 31 mind runes.
 // consume_effect_stat deletes the selected slot. Unstackable trout each need their own slot.
 varrock:{position:{x:3185,z:3436,level:0},inventory:[{id:TROUT,count:1},{id:TROUT,count:1},{id:TROUT,count:1},{id:1351,count:1}],
  bank:[{id:AIR,count:37},{id:MIND,count:31},{id:COINS,count:400},{id:1511,count:5}]},
 // Draynor bank with no mind runes, used with RUNE_BUDGET=0.
 short:{position:{x:3092,z:3243,level:0},inventory:[{id:TROUT,count:1},{id:TROUT,count:1}],bank:[{id:AIR,count:10},{id:COINS,count:300}]},
} satisfies Record<string,SaveConfig>;
type Fixture=keyof typeof FIXTURES;
type Mode='progress'|'refusal';
export const CASES=[
 {label:'varrock',fixture:'varrock',mode:'progress',env:{TARGET_LEVEL:'15',RUNE_BUDGET:'200',CASH_RESERVE:'100'}},
 // The varrock account again, after its saved Magic 15. A failed varrock case ends the run before this case.
 {label:'rerun',fixture:'varrock',mode:'refusal',env:{TARGET_LEVEL:'15',RUNE_BUDGET:'200',CASH_RESERVE:'100'}},
 {label:'short',fixture:'short',mode:'refusal',env:{TARGET_LEVEL:'12',RUNE_BUDGET:'0',CASH_RESERVE:'0'}},
] as const satisfies readonly {label:string;fixture:Fixture;mode:Mode;env:Record<string,string>}[];
const CHILD_ENV={RANDOM_EVENTS:'0',MAX_CASTS:'200',CAP:'1500'};

// Inventory types in the saved player: 93 pack, 94 worn, 95 bank.
export function totals(s:Save){const out=new Map<number,number>();for(const t of [93,94,95])for(const i of s.inventories[t]??[])out.set(i.id,(out.get(i.id)??0)+i.count);return out;}
const total=(s:Save,id:number)=>totals(s).get(id)??0;
const held=(s:Save,id:number,type=93)=>(s.inventories[type]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function lines(log:string,prefix:string):any[]{return log.split(/\r?\n/).filter(l=>l.startsWith(prefix+' ')).map(l=>{try{return JSON.parse(l.slice(prefix.length+1));}catch{return null;}});}
export function unrelatedKept(before:Save,after:Save){
 const a=totals(before),b=totals(after);
 return [...new Set([...a.keys(),...b.keys()])].every(id=>SPENT.has(id)||(a.get(id)??0)===(b.get(id)??0));
}
const skillsEqual=(a:Save,b:Save)=>a.skills.every((s,i)=>s.rawExperience===b.skills[i]!.rawExperience&&s.level===b.skills[i]!.level);
// A refusal moves nothing: each container keeps its exact items.
const itemsEqual=(a:Save,b:Save)=>[93,94,95].every(t=>{
 const sum=(s:Save)=>{const m=new Map<number,number>();for(const i of s.inventories[t]??[])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
 const x=sum(a),y=sum(b);return x.size===y.size&&[...x].every(([id,n])=>y.get(id)===n);
});
export type Child={code:number;timedOut:boolean};
// One worker segment from its own saves and log. A cast debits exactly 1 air and 1 mind (no staff in any fixture).
export function segmentChecks(before:Save,after:Save,log:string){
 const purchases=lines(log,'MAGIC_ORDER_PURCHASE'),castLines=lines(log,'MAGIC_ORDER_CAST'),eats=lines(log,'MAGIC_ORDER_EAT');
 const bought={air:purchases.filter(p=>p?.rune==='Air rune').reduce((n,p)=>n+p.bought,0),mind:purchases.filter(p=>p?.rune==='Mind rune').reduce((n,p)=>n+p.bought,0)};
 const spent=purchases.reduce((n,p)=>n+(p?.spent??0),0);
 const debit={air:total(before,AIR)+bought.air-total(after,AIR),mind:total(before,MIND)+bought.mind-total(after,MIND)};
 return{purchases,castLines:castLines.length,bought,spent,debit,eats:eats.length,
  checks:{
   runeDebitMatched:debit.air===debit.mind&&debit.air>=0,
   coinDebit:total(before,COINS)-total(after,COINS)===spent,
   foodEaten:total(before,TROUT)-total(after,TROUT)===eats.length,
   unrelatedAssets:unrelatedKept(before,after),
   alive:after.skills[3]!.level>0&&!/\bdied\b/.test(log)&&!(after.position.x===3222&&after.position.z===3218),
   // Purchases only after the carried runes could not fund one more cast: owned runes are never bought twice.
   purchaseOnlyWhenShort:purchases.every(p=>!!p&&(p.packBefore?.air<1||p.packBefore?.mind<1)&&p.bought>0&&p.spent>0),
  }};
}
const resultOf=(log:string)=>lines(log,'MAGIC_ORDER_RESULT');
const loggedOut=(log:string)=>/^LOGOUT logged-out$/m.test(log)&&/^RESULT (ok|fail) /m.test(log);
export function progressChecks(before:Save,after:Save,log:string,child:Child,target:number,budget:number,reserve:number){
 const seg=segmentChecks(before,after,log),results=resultOf(log),r=results[0];
 return{...seg.checks,
  exit:child.code===0&&!child.timedOut,
  oneResult:results.length===1&&r?.ok===true&&r.stop==='target',
  level:after.skills[6]!.level>=target&&after.skills[6]!.rawExperience>before.skills[6]!.rawExperience,
  castsExact:seg.debit.air===r?.casts&&seg.castLines===r?.casts&&r?.casts>0,
  resultAccounting:r?.coinsSpent===seg.spent&&r?.bought?.air===seg.bought.air&&r?.bought?.mind===seg.bought.mind&&r?.eats===seg.eats&&r?.hpMin>0,
  budget:seg.spent<=budget&&total(after,COINS)>=reserve,
  leftoversBanked:held(after,AIR)===0&&held(after,MIND)===0&&held(after,AIR,95)===total(after,AIR)&&held(after,MIND,95)===total(after,MIND),
  logout:loggedOut(log)};
}
export function refusalChecks(before:Save,after:Save,log:string,child:Child,stop:string){
 const r=resultOf(log);
 return{exit:child.code!==0&&!child.timedOut,refused:r.length===1&&r[0]?.ok===false&&r[0]?.stop===stop&&r[0]?.casts===0&&r[0]?.coinsSpent===0,
  unchanged:itemsEqual(before,after)&&skillsEqual(before,after),noAction:lines(log,'MAGIC_ORDER_PURCHASE').length===0&&lines(log,'MAGIC_ORDER_CAST').length===0,
  logout:loggedOut(log)};
}
// Fixture shapes, checked against the before saves rather than trusted from the preset.
export function fixtureChecks(save:Save,fixture:Fixture){
 const f=FIXTURES[fixture],bank=(id:number)=>held(save,id,95);
 const food=(save.inventories[93]??[]).filter(i=>i.id===TROUT);
 return save.position.x===f.position.x&&save.position.z===f.position.z&&save.position.level===0&&save.skills[3]!.level===10
  &&food.length===f.inventory.filter(i=>i.id===TROUT).length&&food.every(i=>i.count===1)
  &&save.skills[6]!.level===1&&f.bank.every(i=>bank(i.id)===i.count)&&bank(COINS)>0;
}
type CaseRecord={label:string;name:string;fixture:Fixture;mode:Mode;env:Record<string,string>;child:Child;saveMatched:boolean;elapsedMs:number};
const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
export function verify(directory:string,now=Date.now(),source:unknown=sources()){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const read=(label:string)=>({before:readPracticeSave(join(directory,`${label}-before.sav`)),after:readPracticeSave(join(directory,`${label}-after.sav`)),
  log:readFileSync(join(directory,`${label}.log`),'utf8')});
 const rec=(label:string):CaseRecord=>meta.cases.find((c:CaseRecord)=>c.label===label);
 const checks:Record<string,boolean>={
  source:JSON.stringify(meta.source)===JSON.stringify(source),
  fresh:Number.isFinite(meta.at)&&meta.at<=now&&now-meta.at<CONFIG.freshMs,
  configuration:meta.tickMs===CONFIG.tickMs&&meta.xpRate===CONFIG.xpRate,
  cases:JSON.stringify(meta.cases?.map((c:CaseRecord)=>c.label))===JSON.stringify(CASES.map(c=>c.label)),
 };
 const add=(prefix:string,values:Record<string,boolean>)=>{for(const [k,v] of Object.entries(values))checks[`${prefix}.${k}`]=v;};
 const env=(label:string)=>{const e=rec(label).env;return{target:Number(e.TARGET_LEVEL),budget:Number(e.RUNE_BUDGET),reserve:Number(e.CASH_RESERVE)};};
 const v=read('varrock'),q=read('rerun'),c=read('short');
 checks['varrock.fixture']=fixtureChecks(v.before,'varrock');
 checks['short.fixture']=fixtureChecks(c.before,'short');
 {const e=env('varrock');add('varrock',progressChecks(v.before,v.after,v.log,rec('varrock').child,e.target,e.budget,e.reserve));
  checks['varrock.noPurchase']=lines(v.log,'MAGIC_ORDER_PURCHASE').length===0&&total(v.before,COINS)===total(v.after,COINS);
  checks['varrock.saveMatched']=rec('varrock').saveMatched===true;}
 add('rerun',refusalChecks(q.before,q.after,q.log,rec('rerun').child,'already at target'));
 // The rerun launches from the exact saved bytes the varrock order left, at its target.
 checks['rerun.sameAccount']=rec('rerun').name===rec('varrock').name;
 checks['rerun.fromVarrockSave']=sha(join(directory,'rerun-before.sav'))===sha(join(directory,'varrock-after.sav'))&&q.before.skills[6]!.level>=env('rerun').target;
 add('short',refusalChecks(c.before,c.after,c.log,rec('short').child,'short runes'));
 checks['short.missing']=resultOf(c.log)[0]?.missing?.mind===1&&resultOf(c.log)[0]?.missing?.air===0;
 checks.uniqueAccounts=rec('varrock').name!==rec('short').name;
 const report={ok:Object.values(checks).every(Boolean),at:now,
  scope:'One native 150ms/25x practice run of scripts/magic-order.ts on fresh fixtures. No live, unattended or speed claim.',checks,
  magic:{varrock:v.after.skills[6]!.level}};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 return report;
}

async function child(directory:string,label:string,name:string,env:Record<string,string>):Promise<Child>{
 if(freemem()/2**30<ADMISSION.floorGb)throw Error('practice memory floor reached before child');
 const log=join(directory,label+'.log');writeFileSync(log,'');
 const proc=Bun.spawn(['bun','scripts/magic-order.ts',name],{cwd:root,env:{...process.env,DEMO_OK:'',...CHILD_ENV,...env},
  stdout:Bun.file(log),stderr:Bun.file(join(directory,label+'.err')),windowsHide:true});
 let timedOut=false,termination:Promise<void>|undefined;
 const timer=setTimeout(()=>{timedOut=true;termination=killTree(proc.pid);},CONFIG.childTimeoutMs);
 const memory=setInterval(()=>{if(freemem()/2**30<ADMISSION.floorGb&&!termination){timedOut=true;termination=killTree(proc.pid);}},1000);
 try{
  return{code:await proc.exited,timedOut};
 }finally{clearTimeout(timer);clearInterval(memory);if(proc.exitCode===null)await killTree(proc.pid);await termination;}
}
async function run(directory:string){
 if(freemem()/2**30<ADMISSION.startupGb)throw Error(`insufficient practice startup reserve: ${ADMISSION.startupGb} GiB free required`);
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'magic-order'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const source=sources(),records:CaseRecord[]=[],accounts=new Map<Fixture,{name:string;path:string}>();
  stack=await startStack({tickMs:CONFIG.tickMs,xpRate:CONFIG.xpRate,readyTimeoutMs:60000});
  const account=async(fixture:Fixture)=>{
   const known=accounts.get(fixture);if(known)return known;
   const name=runBotName('mage',accounts.size+1),botDir=join(root,'vendor/rs-sdk/bots',name);
   if(existsSync(botDir))throw Error('fresh account required');
   await createBot(name);
   if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
   const a={name,path:await applyPreset(name,FIXTURES[fixture])};accounts.set(fixture,a);return a;
  };
  const write=()=>writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source,tickMs:CONFIG.tickMs,xpRate:CONFIG.xpRate,cases:records},null,2));
  for(const c of CASES){
   const a=await account(c.fixture),started=Date.now();
   copyFileSync(a.path,join(directory,`${c.label}-before.sav`));
   const stamp=statSync(a.path).mtimeMs;
   const record:CaseRecord={label:c.label,name:a.name,fixture:c.fixture,mode:c.mode,env:{...c.env},child:{code:-1,timedOut:false},saveMatched:false,elapsedMs:0};
   records.push(record);
   try{
    record.child=await child(directory,c.label,a.name,{...c.env});
    // A clean logout saves at once. A progress save must also hold the final effect, so an earlier periodic save
    // never stands in for it.
    const target=Number(c.env.TARGET_LEVEL);
    const effect=(s:Save)=>c.mode==='progress'?s.skills[6]!.level>=target&&held(s,AIR)===0&&held(s,MIND)===0:true;
    const saved=await waitPracticeSave(a.path,s=>statSync(a.path).mtimeMs>stamp&&effect(s),{timeoutMs:CONFIG.saveWaitMs});
    record.saveMatched=saved.matched;
    if(!saved.matched)throw Error(`${c.label}: saved state unobserved ${saved.lastError}`);
   }finally{
    copyFileSync(a.path,join(directory,`${c.label}-after.sav`));record.elapsedMs=Date.now()-started;write();
   }
  }
  write();return verify(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){
 try{
  if(!process.env.DELIVERY_DIR)throw Error('run through bun run deliver magic-order');
  const directory=resolve(process.env.DELIVERY_DIR);
  process.exitCode=(process.argv[2]==='--verify'?verify(directory):await run(directory)).ok?0:1;
 }catch(error){console.error(String(error));process.exitCode=1;}
}
