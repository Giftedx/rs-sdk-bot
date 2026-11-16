// Practice-only exact observed-state comparison. The real Ranged CLI owns every game action.
import {copyFileSync,existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {pointBotAt} from './rehearse';
import {runBotName} from './prove';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {serverFromEnv} from '../../core/src/bot';
import {isLocalServer} from '../../core/src/localserver';
import {capabilityRevision} from '../../core/src/worker-release';
import {killTree} from './proc';
import entry from './ranged-progression-entry.json';

const root=resolve(import.meta.dir,'../../..');
const sourceStatus=resolve(import.meta.dir,'ranged-progression-entry.json');
const proofSource=()=>createHash('sha256').update(readFileSync(import.meta.path)).digest('hex');
export const RANGED_COMPARISON_TARGET=83;
export const RANGED_COMPARISON_PRESET:SaveConfig={
 position:entry.pos,skills:Object.fromEntries(entry.skills.filter(k=>!k.name.startsWith('Stat')).map(k=>[k.name,k.level])),
 inventory:entry.inventory.map(i=>({id:i.id,count:i.count})),equipment:entry.equipment.map(i=>({id:i.id,count:i.count,slot:i.slot})),
 bank:entry.bank.map(i=>({id:i.id,count:i.count})),
};
const total=(save:ReturnType<typeof readPracticeSave>,id:number)=>Object.values(save.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const sameItems=(actual:readonly {id:number;count:number}[],expected:readonly {id:number;count:number}[])=>{
 const counts=(rows:readonly {id:number;count:number}[])=>{
  const map=new Map<number,number>();for(const i of rows)map.set(i.id,(map.get(i.id)??0)+i.count);return JSON.stringify([...map].sort(([a],[b])=>a-b));
 };
 return counts(actual)===counts(expected);
};
export function rangedComparisonChecks(before:ReturnType<typeof readPracticeSave>,after:ReturnType<typeof readPracticeSave>,result:any,log:string,code:number,target=RANGED_COMPARISON_TARGET){
 const id=result?.arrow??result?.ammoId,foodIds=new Set([329,333,1985,385,373,379,2142,2309,1901,1895,1893,1891]);
 const chicken=result?.method==='ranged/chickens';
 const allowed=new Set([995,id,...foodIds,...chicken?[526,2138,314]:[]]);
 const ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
 const coinDebit=total(before,995)-total(after,995),arrowDebit=Number.isSafeInteger(id)?total(before,id)-total(after,id):NaN;
 return{
  exit:code===0,result:result?.ok===true&&result?.targetMet===true&&result.finalLevel>=target,
  exactEntry:before.skills.length===entry.skills.length&&before.skills.every((s,i)=>s.xp===entry.skills[i]!.xp&&s.level===entry.skills[i]!.currentLevel)
   &&before.position.x===entry.pos.x&&before.position.z===entry.pos.z&&before.position.level===entry.pos.level
   &&sameItems(before.inventories[93]??[],entry.inventory)&&sameItems(before.inventories[94]??[],entry.equipment)&&sameItems(before.inventories[95]??[],entry.bank),
  xp:after.skills[4]!.xp-before.skills[4]!.xp===result?.xpGain&&result.xpGain>0&&after.skills[4]!.level>=target,
  bank:after.position.level===0&&[[3253,3421],[2619,3332]].some(([x,z])=>Math.max(Math.abs(after.position.x-x!),Math.abs(after.position.z-z!))<=6),
  assets:[...ids].every(i=>allowed.has(i)||total(before,i)===total(after,i)),
  arrows:Number.isSafeInteger(arrowDebit)&&arrowDebit>=0&&arrowDebit===result?.arrowsSpent,
  coins:Number.isSafeInteger(coinDebit)&&coinDebit>=0&&coinDebit<=500&&total(after,995)>=382483&&coinDebit===result?.coinsSpent,
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
 const checks={...rangedComparisonChecks(before,after,result,log,report.code,report.target),
  fresh:Date.now()>=report.at&&Date.now()-report.at<900000,
  source:report.source===capabilityRevision(['scripts/ranged-train.ts'],root),
  proofSource:report.proofSource===proofSource(),
  entryHash:report.entrySha256===createHash('sha256').update(readFileSync(sourceStatus)).digest('hex'),
 };
 const output={ok:Object.values(checks).every(Boolean),checks,evidence:folder};
 console.log('RANGED_SAVED_PROOF '+JSON.stringify(output));return output.ok;
}
async function run(template:string,mode:string,target=RANGED_COMPARISON_TARGET){
 if(!['adaptive','chickens','troopers'].includes(mode))throw Error('comparison method must be adaptive, chickens or troopers');
 if(![83,85].includes(target))throw Error('comparison target must be83 or85');
 const templateEnv=readFileSync(join(root,'vendor/rs-sdk/bots',template,'bot.env'),'utf8'),server=serverFromEnv(templateEnv);
 if(!isLocalServer(server)||process.env.DEMO_OK==='1')throw Error('Ranged comparison is local practice only');
 const port=Number(server.slice(server.lastIndexOf(':')+1));if(!Number.isSafeInteger(port)||port<1)throw Error('comparison engine port unknown');
 const name=runBotName('aiobfl',1),botDir=join(root,'vendor/rs-sdk/bots',name),folder=resolve(root,process.env.BENCH_OUTPUT_DIR??'.practice/progression-ranged',`${mode}-${process.env.SIM_SEED??process.env.BENCH_SEED??'seed'}-${name}`);
 if(existsSync(botDir))throw Error('comparison identity already exists');
 mkdirSync(folder,{recursive:true});
 try{
  const {envPath}=await createBot(name);pointBotAt(envPath,port,port+1);
  const path=await applyPreset(name,RANGED_COMPARISON_PRESET);
  setPracticeSkills(path,entry.skills.map(s=>({level:s.currentLevel,xp:s.xp})));
  copyFileSync(path,join(folder,'before.sav'));
  const pin=capabilityRevision(['scripts/ranged-train.ts'],root),verifier=proofSource(),started=Date.now();
  const proc=Bun.spawn(['bun',join(root,'scripts/ranged-train.ts'),name,String(target),'20000'],{
   cwd:root,env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',LOOT_WATCH:'0',MIN_ARROWS:'30',BUY_ARROWS:'0',MAX_SPEND:'500',COIN_RESERVE:'382483',AMMO:'100',FOOD:'3',FOOD_ID:'329',KILLS_PER_TRIP:'8',MAX_TRIPS:'50',
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
  const checks={...rangedComparisonChecks(before,settled.save,result,log,code,target),persisted:settled.matched,timeout:!timedOut,source:pin===capabilityRevision(['scripts/ranged-train.ts'],root)};
  const ok=Object.values(checks).every(Boolean);
  const levels=Object.fromEntries(entry.skills.filter(s=>['Attack','Strength','Defence','Hitpoints','Magic','Prayer'].includes(s.name)).map(s=>[s.name,{min:s.level,max:s.level}]));
  const supportedMethods=ok&&['ranged/chickens','ranged/troopers'].includes(result?.method)?[{id:result.method,source:pin,bands:[{
   levels:{...levels,Ranged:{min:entry.skills[4]!.level,max:target}},items:{841:1,882:149,2142:43},loadout:[284,285],
  }]}]:[];
  const report={ok,at:Date.now(),code,mode,seed:Number(process.env.SIM_SEED??process.env.BENCH_SEED??7),source:pin,proofSource:verifier,entrySha256:createHash('sha256').update(readFileSync(sourceStatus)).digest('hex'),entryAt:entry.at,target,supportedMethods,
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
