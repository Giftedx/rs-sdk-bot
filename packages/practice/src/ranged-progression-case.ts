// Practice-only exact observed-state comparison. The real Ranged CLI owns every game action.
import {copyFileSync,existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {pointBotAt} from './rehearse';
import {RANGED_BOT_HOST} from './ranged-train-proof';
import {runBotName} from './prove';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from './fleet-player-save';
import {serverFromEnv} from '../../core/src/bot';
import {isLocalServer} from '../../core/src/localserver';
import {capabilityRevision} from '../../core/src/worker-release';
import {killTree} from '../../core/src/proc';
import {levelForXp} from '../../planner/src/curve';

const root=resolve(import.meta.dir,'../../..');
const sourceStatus=resolve(import.meta.dir,'ranged-progression-entry.json');
const proofSource=()=>createHash('sha256').update(readFileSync(import.meta.path)).digest('hex');
export const RANGED_COMPARISON_TARGET=83;
const skillNames=['Attack','Defence','Strength','Hitpoints','Ranged','Prayer','Magic','Cooking','Woodcutting','Fletching','Fishing','Firemaking','Crafting','Smithing','Mining','Herblore','Agility','Thieving','Stat18','Stat19','Runecraft'];
type EntryItem={id:number;count:number};
export interface RangedComparisonEntry{
 at:number;bankAt:number;sourceSha256:string;producer:{loggedOutAt:number;receiptSha256:string};
 pos:{x:number;z:number;level:number};hp:{now:number;max:number};
 skills:{name:string;level:number;currentLevel:number;xp:number}[];inventory:EntryItem[];equipment:(EntryItem&{slot:number})[];bank:EntryItem[];
}
const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function entryRecord(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw Error('invalid Ranged entry object');
 return value as Record<string,unknown>;
}
function entryNumber(value:unknown,min:number,max:number):number{
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw Error('invalid Ranged entry number');return value;
}
function entryHash(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error('invalid Ranged entry hash');return value;}
export function parseRangedEntry(raw:Uint8Array):{entry:RangedComparisonEntry;bytes:Uint8Array;sha256:string}{
 const bytes=Uint8Array.from(raw);let value:unknown;try{value=JSON.parse(Buffer.from(bytes).toString('utf8'));}catch{throw Error('invalid Ranged entry JSON');}
 const e=entryRecord(value,['at','bankAt','sourceSha256','producer','pos','hp','skills','inventory','equipment','bank']);
 const at=entryNumber(e.at,1,Number.MAX_SAFE_INTEGER),bankAt=entryNumber(e.bankAt,1,at),p=entryRecord(e.producer,['loggedOutAt','receiptSha256']);
 const producer={loggedOutAt:entryNumber(p.loggedOutAt,bankAt,at),receiptSha256:entryHash(p.receiptSha256)},pos=entryRecord(e.pos,['x','z','level']),hp=entryRecord(e.hp,['now','max']);
 if(!Array.isArray(e.skills)||e.skills.length!==21)throw Error('invalid Ranged entry skills');
 const skills=e.skills.map((row:unknown,i:number)=>{const s=entryRecord(row,['name','level','currentLevel','xp']);
  const level=entryNumber(s.level,1,99),currentLevel=entryNumber(s.currentLevel,i===3?1:0,99),xp=entryNumber(s.xp,0,214748364);
  if(s.name!==skillNames[i]||levelForXp(xp)!==level)throw Error('invalid Ranged entry skill identity or base XP');
  return{name:skillNames[i]!,level,currentLevel,xp};
 });
 const rows=(value:unknown,limit:number,equipment=false)=>{
  if(!Array.isArray(value)||value.length>limit)throw Error('invalid Ranged entry container');
  const slots=new Set<number>(),ids=new Set<number>(),counts=new Map<number,number>();
  return value.map((row:unknown)=>{const i=entryRecord(row,equipment?['id','count','slot']:['id','count']);
   const item={id:entryNumber(i.id,1,65534),count:entryNumber(i.count,1,2147483647)},slot=equipment?entryNumber(i.slot,0,13):undefined;
   const n=(counts.get(item.id)??0)+item.count;if(n>2147483647||limit===800&&ids.has(item.id)||slot!==undefined&&slots.has(slot))throw Error('invalid Ranged entry duplicate or count');
   ids.add(item.id);counts.set(item.id,n);if(slot!==undefined)slots.add(slot);return{...item,...slot===undefined?{}:{slot}};
  });
 };
 const inventory=rows(e.inventory,28),bank=rows(e.bank,800),equipment=rows(e.equipment,14,true).map(i=>({...i,slot:entryNumber(i.slot,0,13)}));
 const health={now:entryNumber(hp.now,1,99),max:entryNumber(hp.max,1,99)};
 if(health.now!==skills[3]!.currentLevel||health.max!==skills[3]!.level)throw Error('invalid Ranged entry health');
 const entry:RangedComparisonEntry={at,bankAt,sourceSha256:entryHash(e.sourceSha256),producer,pos:{x:entryNumber(pos.x,0,16383),z:entryNumber(pos.z,0,16383),level:entryNumber(pos.level,0,3)},hp:health,skills,inventory,equipment,bank};
 return{entry,bytes,sha256:sha256(bytes)};
}
export function loadRangedComparisonEntry(path=process.env.RANGED_PROGRESSION_ENTRY){return parseRangedEntry(readFileSync(path?resolve(path):sourceStatus));}
export function rangedPracticeTarget(fixed:number,entry:RangedComparisonEntry,env:Record<string,string|undefined>=process.env){
 const requested=env.RANGED_PROGRESSION_TARGET;if(requested===undefined)return fixed;
 const target=Number(requested),level=entry.skills[4]!.level;
 // Any finite level above the entry: the proof states the XP that the run made (gainXp), so a longer run proves more
 // and admits no more than it ran. The coordinator keeps its own bound for an observed account
 // (packages/router/src/progression-native-context.ts).
 if(!env.RANGED_PROGRESSION_ENTRY||!Number.isSafeInteger(target)||target<=level||target>99)throw Error('the Ranged target of an entry file must be a level above the entry, 99 at most');
 return target;
}
export function rangedPracticeCoins(entry:RangedComparisonEntry){
 const coins=[...entry.inventory,...entry.equipment,...entry.bank].filter(i=>i.id===995).reduce((sum,i)=>sum+i.count,0);
 // Preserve the fixed fixture's protected stock. A poorer captured entry never receives invented coins.
 return{spend:Math.min(500,coins),reserve:Math.max(coins>=382483?382483:0,coins-500)};
}
const entry=loadRangedComparisonEntry('').entry;
export function rangedComparisonPreset(entry:RangedComparisonEntry):SaveConfig{return{
 position:entry.pos,skills:Object.fromEntries(entry.skills.filter(k=>!k.name.startsWith('Stat')).map(k=>[k.name,k.level])),
 inventory:entry.inventory.map(i=>({id:i.id,count:i.count})),equipment:entry.equipment.map(i=>({id:i.id,count:i.count,slot:i.slot})),
 bank:entry.bank.map(i=>({id:i.id,count:i.count})),
};}
export const RANGED_COMPARISON_PRESET=rangedComparisonPreset(entry);
const foodIds=new Set([329,333,1985,385,373,379,2142,2309,1901,1895,1893,1891]);
type SupportedRangedMethod={id:string;source:string;bands:{levels:Record<string,{min:number}>;gainXp:Record<string,number>;kit:number[];items:Record<string,number>;loadout:number[]}[]};
// A Ranged training method of the worker: the id the worker reports for the kill loop it ran. An acquire step
// (a shop or market buy) trains nothing and gets no proof here.
export const rangedTrainingMethod=(id:unknown):id is string=>typeof id==='string'&&/^ranged\/[a-z0-9-]+$/.test(id)&&!/^ranged\/(?:lowe|guild|ge)-buy-/.test(id);
// The proof admits the envelope of its entry, not the entry alone: every account at or above the entry in each
// dimension where more is never worse for the proof's purpose (the worker reaches its finite target, does not die
// and logs out).
// - Attack, Strength, Defence, Hitpoints, Magic, Prayer, Ranged: a minimum. A higher level gives more damage, more
//   accuracy, more defence or more life, and takes none away. For one amount of Ranged XP the entry is the worst
//   case: the kills are the same and each kill takes the longest at the lowest Ranged level.
// - Bow, arrows and food: a minimum count over the worn items, the pack and the bank.
// - Worn items: the account wears each item the entry wore. More worn items are allowed, so the weakest entry of a
//   method wears the bow and the arrows alone.
// - One run: `gainXp` is the Ranged XP that the proof run made. A planned step adds that much XP at most, so no
//   step is more work than the run that was proved. Levels are not the bound: 5 levels at Ranged 90 are about 500
//   times the XP of 5 levels at Ranged 1.
// - The kit: `kit` is the bow and the arrow that the proof run fought with. The worker takes the best pair that
//   the account owns (rangedKit), so the method must name this same pair for the account. An account that owns a
//   better bow runs another kit and needs a proof from an entry with that kit.
export function rangedSupportedMethods(entry:RangedComparisonEntry,result:any,source:string,target:number):SupportedRangedMethod[]{
 if(!rangedTrainingMethod(result?.method))return[];
 const stock=new Map<number,number>();for(const i of [...entry.inventory,...entry.equipment,...entry.bank])stock.set(i.id,(stock.get(i.id)??0)+i.count);
 const items=Object.fromEntries([...stock].filter(([id])=>id===result.bow||id===result.arrow||foodIds.has(id)));
 const levels=Object.fromEntries(entry.skills.filter(s=>['Attack','Strength','Defence','Hitpoints','Magic','Prayer','Ranged'].includes(s.name)).map(s=>[s.name,{min:s.level}]));
 return[{id:result.method,source,bands:[{levels,gainXp:{Ranged:Math.max(0,Math.floor(Number(result.xpGain)||0))},kit:[result.bow,result.arrow].filter(id=>Number.isSafeInteger(id)&&id>0),items,loadout:entry.equipment.map(i=>i.id)}]}];
}
export function rangedEntryProofChecks(bytes:Uint8Array,report:{entrySha256:string;source:string;target:number;supportedMethods:unknown},result:any){
 const loaded=parseRangedEntry(bytes);if(loaded.sha256!==report.entrySha256)throw Error('frozen Ranged entry SHA-256 differs');
 return{entry:loaded.entry,supportedMethods:JSON.stringify(report.supportedMethods)===JSON.stringify(rangedSupportedMethods(loaded.entry,result,report.source,report.target))};
}
const total=(save:ReturnType<typeof readPracticeSave>,id:number)=>Object.values(save.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const sameItems=(actual:readonly {id:number;count:number}[],expected:readonly {id:number;count:number}[])=>{
 const counts=(rows:readonly {id:number;count:number}[])=>{
  const map=new Map<number,number>();for(const i of rows)map.set(i.id,(map.get(i.id)??0)+i.count);return JSON.stringify([...map].sort(([a],[b])=>a-b));
 };
 return counts(actual)===counts(expected);
};
export function rangedComparisonChecks(before:ReturnType<typeof readPracticeSave>,after:ReturnType<typeof readPracticeSave>,result:any,log:string,code:number,target=RANGED_COMPARISON_TARGET,effectiveEntry:RangedComparisonEntry=entry){
 const entry=effectiveEntry,id=result?.arrow??result?.ammoId;
 const budget=rangedPracticeCoins(entry);
 const chicken=result?.method==='ranged/chickens';
 const allowed=new Set([995,id,...foodIds,...chicken?[526,2138,314]:[]]);
 const ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
 const coinDebit=total(before,995)-total(after,995),arrowDebit=Number.isSafeInteger(id)?total(before,id)-total(after,id):NaN;
 return{
  exit:code===0,result:result?.ok===true&&result?.targetMet===true&&result.finalLevel>=target,
  exactEntry:before.skills.length===entry.skills.length&&before.skills.every((s,i)=>s.xp===entry.skills[i]!.xp&&s.level===entry.skills[i]!.currentLevel)
   &&before.position.x===entry.pos.x&&before.position.z===entry.pos.z&&before.position.level===entry.pos.level
   &&sameItems(before.inventories[93]??[],entry.inventory)&&sameItems(before.inventories[94]??[],entry.equipment)
   &&(before.inventories[94]??[]).every(i=>entry.equipment.some(e=>e.slot===i.slot&&e.id===i.id&&e.count===i.count))&&sameItems(before.inventories[95]??[],entry.bank),
  xp:after.skills[4]!.xp-before.skills[4]!.xp===result?.xpGain&&result.xpGain>0&&after.skills[4]!.level>=target,
  bank:after.position.level===0&&[[3253,3421],[2619,3332]].some(([x,z])=>Math.max(Math.abs(after.position.x-x!),Math.abs(after.position.z-z!))<=6),
  assets:[...ids].every(i=>allowed.has(i)||total(before,i)===total(after,i)),
  arrows:Number.isSafeInteger(arrowDebit)&&arrowDebit>=0&&arrowDebit===result?.arrowsSpent,
  coins:Number.isSafeInteger(coinDebit)&&coinDebit>=0&&coinDebit<=budget.spend&&total(after,995)>=budget.reserve&&coinDebit===result?.coinsSpent,
  accounting:result?.accounting===true&&result?.preserved===true,
  health:after.skills[3]!.level>0&&result?.died===false,
  logout:(log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*?(logout|session close)/m.test(log),
 };
}
export function rangedComparisonPass(log:string){
 const line=log.split(/\r?\n/).find(l=>l.startsWith('RANGED_MATCHED_PROOF '));
 try{return JSON.parse(line?.slice('RANGED_MATCHED_PROOF '.length)??'null')?.ok===true;}catch{return false;}
}
export function verifyRangedComparison(folder:string){
 const report=JSON.parse(readFileSync(join(folder,'proof.json'),'utf8'));
 const log=readFileSync(join(folder,'worker.log'),'utf8');
 const before=readPracticeSave(join(folder,'before.sav')),after=readPracticeSave(join(folder,'after.sav'));
 const result=JSON.parse(log.split(/\r?\n/).find(l=>l.startsWith('RANGED_TRAIN_RESULT '))?.slice(20)??'null');
 const frozen=rangedEntryProofChecks(readFileSync(join(folder,'entry.json')),report,result);
 const checks={...rangedComparisonChecks(before,after,result,log,report.code,report.target,frozen.entry),
  fresh:Date.now()>=report.at&&Date.now()-report.at<900000,
  source:report.source===capabilityRevision(['scripts/ranged-train.ts'],root),
  proofSource:report.proofSource===proofSource(),
  entryHash:true,supportedMethods:frozen.supportedMethods,
 };
 const output={ok:Object.values(checks).every(Boolean),checks,evidence:folder};
 console.log('RANGED_SAVED_PROOF '+JSON.stringify(output));return output.ok;
}
// 'localhost' resolves to ::1 on Windows, but the web transport binds 0.0.0.0 only.
export function pointRangedComparisonBot(envPath:string,port:number){pointBotAt(envPath,port,port+1,RANGED_BOT_HOST);}
async function run(template:string,mode:string,target=RANGED_COMPARISON_TARGET){
 if(!['adaptive','chickens','troopers'].includes(mode))throw Error('comparison method must be adaptive, chickens or troopers');
 if(![83,85].includes(target))throw Error('fixed comparison target must be83 or85');
 const templateEnv=readFileSync(join(root,'vendor/rs-sdk/bots',template,'bot.env'),'utf8'),server=serverFromEnv(templateEnv);
 if(!isLocalServer(server)||process.env.DEMO_OK==='1')throw Error('Ranged comparison is local practice only');
 const override=process.env.RANGED_PROGRESSION_ENTRY;
 if(override&&process.env.BENCH_CACHE!=='0')throw Error('Ranged entry override requires uncached practice (--profile or --no-keep)');
 const loaded=loadRangedComparisonEntry(override),entry=loaded.entry;
 target=rangedPracticeTarget(target,entry);
 if(entry.skills[4]!.level>=target)throw Error('Ranged entry must precede the finite target');
 const port=Number(server.slice(server.lastIndexOf(':')+1));if(!Number.isSafeInteger(port)||port<1)throw Error('comparison engine port unknown');
 const name=runBotName('aiobfl',1),botDir=join(root,'vendor/rs-sdk/bots',name),folder=resolve(root,process.env.BENCH_OUTPUT_DIR??'.practice/progression-ranged',`${mode}-${process.env.SIM_SEED??process.env.BENCH_SEED??'seed'}-${name}`);
 if(existsSync(botDir))throw Error('comparison identity already exists');
 mkdirSync(folder,{recursive:true});
 writeFileSync(join(folder,'entry.json'),loaded.bytes,{flag:'wx'});
 try{
  const {envPath}=await createBot(name);pointRangedComparisonBot(envPath,port);
  const path=await applyPreset(name,rangedComparisonPreset(entry));
  setPracticeSkills(path,entry.skills.map(s=>({level:s.currentLevel,xp:s.xp})));
  copyFileSync(path,join(folder,'before.sav'));
  const pin=capabilityRevision(['scripts/ranged-train.ts'],root),verifier=proofSource(),started=Date.now(),budget=rangedPracticeCoins(entry);
  const proc=Bun.spawn(['bun',join(root,'scripts/ranged-train.ts'),name,String(target),'20000'],{
   cwd:root,env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',LOOT_WATCH:'0',MIN_ARROWS:'30',BUY_ARROWS:'0',MAX_SPEND:String(budget.spend),COIN_RESERVE:String(budget.reserve),AMMO:'100',FOOD:'3',FOOD_ID:'329',KILLS_PER_TRIP:'8',MAX_TRIPS:'50',
    RANGED_COMPARE_METHOD:mode==='adaptive'?'':mode},stdout:'pipe',stderr:'pipe',windowsHide:true,
  });
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;void killTree(proc.pid);},540000);
  const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);clearTimeout(timer);
  const elapsedMs=Date.now()-started,log=out+err;process.stdout.write(log);writeFileSync(join(folder,'worker.log'),log);
  const ledgerTicks=[...log.matchAll(/^LEDGER ticks=(\d+)/gm)].map(m=>Number(m[1])).at(-1)??null;
  let result:any=null;try{result=JSON.parse(out.split(/\r?\n/).find(l=>l.startsWith('RANGED_TRAIN_RESULT '))?.slice(20)??'null');}catch{/* Failed CLI output is retained. */}
  const before=readPracticeSave(join(folder,'before.sav'));
  const settled=await waitPracticeSave(path,s=>s.skills[4]!.xp-before.skills[4]!.xp===result?.xpGain,{timeoutMs:15000});
  copyFileSync(path,join(folder,'after.sav'));
  const checks={...rangedComparisonChecks(before,settled.save,result,log,code,target,entry),persisted:settled.matched,timeout:!timedOut,source:pin===capabilityRevision(['scripts/ranged-train.ts'],root)};
  const ok=Object.values(checks).every(Boolean);
  const supportedMethods=ok?rangedSupportedMethods(entry,result,pin,target):[];
  const report={ok,at:Date.now(),code,mode,seed:Number(process.env.SIM_SEED??process.env.BENCH_SEED??7),source:pin,proofSource:verifier,entrySha256:loaded.sha256,entryAt:entry.at,target,supportedMethods,
   elapsedMs,ticks:ledgerTicks,workerTicks:result?.ticks??null,xpGain:result?.xpGain??null,checks,result,evidence:folder,
   scope:'Exact observed skills, current Prayer, containers and bank position from the saved entry. Unknown native quest varps are not reconstructed. Whole CLI includes approach, bank work and cleanup; no live or unobserved upgrade claim.'};
  writeFileSync(join(folder,'proof.json'),JSON.stringify(report,null,2));
  if(mode==='adaptive'){
   const pointerDir=process.env.DELIVERY_DIR??resolve(root,'.practice/progression-ranged');mkdirSync(pointerDir,{recursive:true});
   writeFileSync(join(pointerDir,'ranged-adaptive-proof.json'),JSON.stringify({folder}));
  }
  console.log('RANGED_MATCHED_PROOF '+JSON.stringify(report));return report.ok;
 }finally{if(dirname(botDir)===join(root,'vendor/rs-sdk/bots'))rmSync(botDir,{recursive:true,force:true});}
}
if(import.meta.main){
 if(process.argv[2]==='--verify'){
  try{const folder=process.argv[3]??JSON.parse(readFileSync(join(process.env.DELIVERY_DIR??resolve(root,'.practice/progression-ranged'),'ranged-adaptive-proof.json'),'utf8')).folder;process.exitCode=verifyRangedComparison(folder)?0:1;}
  catch(error){console.error(String(error));process.exitCode=1;}
 }else run(process.argv[2]!,process.argv[3]??'adaptive',Number(process.argv[4]??RANGED_COMPARISON_TARGET)).then(ok=>{process.exitCode=ok?0:1;}).catch(error=>{console.error(String(error));process.exitCode=1;});
}
