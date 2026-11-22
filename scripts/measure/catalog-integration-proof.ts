// Native acceptance for finite planner output and partial ground-supply completion.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,realpathSync,statSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {serverFromEnv} from '../../packages/core/src/bot';
import {isLocalServer} from '../../packages/core/src/localserver';
import {readLogoutProof} from '../../packages/core/src/session-lifecycle';
import {killTree} from '../../packages/core/src/proc';
import {resolveSkillerStep} from '../aio-skiller';
import {capabilityRevision} from '../../packages/core/src/worker-release';
import {levelForXp} from '../../packages/planner/src/curve';
import {readPracticeSave,parsePracticeSave,waitPracticeSave} from './fleet-player-save';

const root=resolve(import.meta.dir,'../..');
type Save=ReturnType<typeof readPracticeSave>;
const amount=(save:Save,id:number,container?:number)=>Object.entries(save.inventories).filter(([key])=>container===undefined||Number(key)===container)
 .flatMap(([,rows])=>rows).filter(row=>row.id===id).reduce((n,row)=>n+row.count,0);
const totals=(save:Save,skip:number[]=[])=>{
 const result:Record<number,number>={};for(const key of [93,94,95])for(const row of save.inventories[key]??[])
  if(!skip.includes(row.id))result[row.id]=(result[row.id]??0)+row.count;
 return result;
};
type ArtisanMode='cut'|'producer'|'tools'|'observer';
const entries={cut:'scripts/aio-skiller.ts',producer:'scripts/aio-skiller.ts',tools:'scripts/aio-market.ts',observer:'scripts/aio-logistics.ts'} as const;
export const toolsEnv={ITEMS:'ring mould|chisel',STOCK_TARGET:'1',STOP_AT_TARGET:'1',MAX_ITEMS:'2',MAX_SPEND:'20',FLOAT:'100',COIN_RESERVE:'0',NO_BUY_TICKS:'25',BANK_PACK:'1'};
export const artisanSourceEntries=(mode:ArtisanMode):string[]=>[entries[mode],'scripts/measure/catalog-integration-proof.ts',...(mode==='producer'?['scripts/aio-skiller.ts']:[])];
export const artisanSourceRevision=(mode:ArtisanMode,base=root)=>capabilityRevision(artisanSourceEntries(mode),base);
const files=['before.sav','after.sav','stdout.log','stderr.log','execution.json','logout.json'] as const;
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const artifactRoot=()=>resolve(root,process.env.DELIVERY_DIR??'.practice/artisan-native');
type Artifact={version:1;status:'pending'|'complete';mode:ArtisanMode;account:string;server:string;attempt:string;startedAt:number;completedAt?:number;
 source:{entry:string;entries:string[];revision:string;proofSha256:string};files?:Record<string,string>};
const manifest=(mode:ArtisanMode)=>join(artifactRoot(),mode,'manifest.json');
function startArtifact(name:string,mode:ArtisanMode,server:string,before:Uint8Array){
 const dir=join(artifactRoot(),mode);mkdirSync(dir,{recursive:true});const directory=mkdtempSync(join(dir,name.toLowerCase()+'-'));
 const record:Artifact={version:1,status:'pending',mode,account:name.toLowerCase(),server,attempt:basename(directory),startedAt:Date.now(),
  source:{entry:entries[mode],entries:artisanSourceEntries(mode),revision:artisanSourceRevision(mode),proofSha256:hash(readFileSync(import.meta.path))}};
 writeFileSync(join(directory,'before.sav'),before);writeFileSync(manifest(mode),JSON.stringify(record,null,2));return{directory,record};
}

export function artisanTransition(mode:ArtisanMode,beforeBytes:Uint8Array,afterBytes:Uint8Array,stdout:string){
 const before=parsePracticeSave(beforeBytes),after=parsePracticeSave(afterBytes),expectedXp=mode==='cut'?2500:mode==='producer'?1000:0;
 let spentTotal:number|undefined,fareTotal:number|undefined,observation:{generation:number;at:number;items:number}|undefined;
 assert.match(stdout,/^RESULT ok\b/m,'successful actual worker');assert.match(stdout,/^LOGOUT logged-out\s*$/m,'worker logout acknowledgement');
 if(mode==='observer'){
  assert.deepEqual(before.position,{x:3085,z:3250,level:0});assert.equal(before.skills[12]!.level,51);assert.equal(before.skills[3]!.level,64);
  assert.equal(amount(before,995,95),100470);assert.equal(amount(before,1623,95),4);
  const lines=stdout.split(/\r?\n/),markers=lines.filter(line=>line.startsWith('BANK_OBSERVED ')),banks=lines.filter(line=>line.startsWith('BANK ')),results=lines.filter(line=>line.startsWith('RESULT '));
  assert.equal(markers.length,1,'one fresh bank marker');assert.equal(banks.length,1,'one fresh BANK payload');assert.equal(results.length,1,'one settled inspection result');
  observation=JSON.parse(markers[0]!.slice('BANK_OBSERVED '.length));assert.ok(observation);
  assert.ok(Number.isSafeInteger(observation.generation)&&observation.generation>0);assert.ok(Number.isSafeInteger(observation.at)&&observation.at>0);assert.equal(observation.items,2);
  assert.equal(results[0],`RESULT ok inspection bankObserved=1 bankGeneration=${observation.generation} bankObservedAt=${observation.at} bankItems=${observation.items}`,'settled fresh bank result');
  assert.ok(lines.indexOf(markers[0]!)<lines.indexOf('LOGOUT logged-out')&&lines.indexOf('LOGOUT logged-out')<lines.indexOf(results[0]!), 'bank observed before confirmed logout and success');
  const bank=JSON.parse(banks[0]!.slice('BANK '.length));assert.ok(Array.isArray(bank));
  assert.deepEqual(bank.map((row:any)=>({id:row.id,count:row.count})).sort((a:any,b:any)=>a.id-b.id),[{id:995,count:100470},{id:1623,count:4}],'exact observed bank assets');
  assert.deepEqual(totals(after),totals(before),'observation preserves all assets');assert.deepEqual(after.inventories[93]??[],before.inventories[93]??[]);
 }else if(mode==='tools'){
  assert.deepEqual(before.position,{x:3085,z:3250,level:0});assert.equal(before.skills[12]!.level,51);assert.equal(before.skills[3]!.level,64);
  assert.equal(amount(before,995,95),100470);assert.equal(amount(before,1623,95),4);assert.equal(amount(before,1755),0);assert.equal(amount(before,1592),0);
  assert.equal(amount(after,1755,95),1);assert.equal(amount(after,1592,95),1);assert.equal(amount(after,1755),1);assert.equal(amount(after,1592),1);assert.equal(amount(after,1623,95),4);
  const result=stdout.split(/\r?\n/).filter(line=>line.startsWith('RESULT ')).at(-1)??'';
  assert.match(result,/^RESULT ok\b/);const field=(name:string)=>Number(result.match(new RegExp(`\\b${name}=(\\d+)(?:\\s|$)`))?.[1]??NaN);
  spentTotal=field('spentTotal');fareTotal=field('fareTotal');
  assert.equal(field('boughtTotal'),2);assert.equal(field('bankedTotal'),2);assert.equal(field('targetMet'),1);assert.equal(field('maxSpend'),20);assert.equal(field('maxItems'),2);
  assert.ok(Number.isSafeInteger(spentTotal)&&spentTotal>0&&spentTotal<=20,'bounded shop spend');
  assert.ok(Number.isSafeInteger(fareTotal)&&fareTotal>=0&&fareTotal<=10,'bounded mainland toll');assert.ok(field('ticks')>0&&field('ticks')<=1500,'bounded shop ticks');
  assert.equal(amount(before,995)-amount(after,995),spentTotal+fareTotal,'shop coin debit matches buys and fares');
  assert.deepEqual(totals(after,[995,1755,1592]),totals(before,[995,1755,1592]));
 }else if(mode==='cut'){
  assert.equal(amount(before,1623,95),2);assert.equal(amount(before,1755),1);assert.equal(amount(before,1607),0);
  assert.equal(amount(after,1623),0);assert.equal(amount(after,1607,95),2);assert.equal(amount(after,1607),2);assert.equal(amount(after,1755),1);
  assert.deepEqual(totals(after,[1623,1607]),totals(before,[1623,1607]));
 }else{
  assert.equal(amount(before,1607,95),13);assert.equal(amount(before,2357,95),13);assert.equal(amount(before,1592,95),1);assert.equal(amount(before,1637),0);
  assert.equal(amount(after,1637,95),1);assert.equal(amount(after,1637),1);assert.equal(amount(after,1607),12);assert.equal(amount(after,2357),12);
  assert.deepEqual(totals(after,[1607,2357,1637]),totals(before,[1607,2357,1637]));
  assert.deepEqual(after.inventories[93]??[],before.inventories[93]??[]);
 }
 assert.deepEqual(after.inventories[94]??[],before.inventories[94]??[]);
 assert.equal(after.skills[12]!.rawExperience-before.skills[12]!.rawExperience,expectedXp*10,'exact native25x Crafting XP');
 assert.equal(after.skills[12]!.level,levelForXp(after.skills[12]!.xp));
 for(let i=0;i<21;i++)if(i!==12)assert.deepEqual(after.skills[i],before.skills[i],'unrelated skill '+i);
 return{mode,xpGain:expectedXp,item:mode==='cut'?1607:mode==='producer'?1637:mode==='tools'?1755:undefined,count:mode==='observer'?0:mode==='producer'?1:2,
  ...(mode==='observer'?{bankObserved:true,observation}:{}),
  ...(mode==='tools'?{items:{1755:1,1592:1},spentTotal,fareTotal}:{})};
}

// Read-only qualification consumer. No game process, account login or current lifecycle file is consulted.
export function verifyArtisanEvidence(mode:ArtisanMode){
 const record=JSON.parse(readFileSync(manifest(mode),'utf8')) as Artifact;
 assert.equal(record.version,1);assert.equal(record.status,'complete');assert.equal(record.mode,mode);assert.match(record.account,/^aiob[a-z0-9]+$/i);
 assert.equal(isLocalServer(record.server),true);assert.equal(basename(record.attempt),record.attempt);assert.ok(record.attempt.startsWith(record.account+'-'));assert.match(record.attempt,/^[a-z0-9-]+$/i);
 assert.equal(record.source.entry,entries[mode]);assert.deepEqual(record.source.entries,artisanSourceEntries(mode));
 assert.equal(record.source.revision,artisanSourceRevision(mode),'worker, dispatcher or proof source differs');
 assert.equal(record.source.proofSha256,hash(readFileSync(import.meta.path)),'proof source differs');
 const directory=join(artifactRoot(),mode,record.attempt);
 for(const file of files)assert.equal(hash(readFileSync(join(directory,file))),record.files?.[file],'retained artifact hash '+file);
 const execution=JSON.parse(readFileSync(join(directory,'execution.json'),'utf8'));
 assert.equal(execution.exitCode,0);assert.equal(execution.expired,false);assert.equal(execution.script,entries[mode]);
 if(mode==='cut'){assert.deepEqual(execution.args,['artisan','crafting','inventory','cut-sapphire']);assert.equal(execution.env.MAX_MAKE,'2');assert.equal(execution.env.CAP,'600');}
 else if(mode==='tools'){assert.deepEqual(execution.args,['shop-buy','dommik','1500']);for(const [key,value]of Object.entries(toolsEnv))assert.equal(execution.env[key],value,'finite shop control '+key);}
 else if(mode==='observer'){
  assert.deepEqual(execution.args,['inspect']);assert.equal(execution.env.REQUIRE_BANK,'1');
  assert.ok(Number.isFinite(execution.save?.beforeMtimeMs)&&execution.save.afterMtimeMs>execution.save.beforeMtimeMs,'same-attempt saved observation');
  assert.ok(execution.save.afterMtimeMs>=record.startedAt&&execution.save.afterMtimeMs<=record.completedAt!,'save belongs to retained attempt');
 }
 else for(const value of ['jewellery-trip','RECIPE=sapphire_ring','TARGET=1','BATCH=1'])assert.ok(execution.args.includes(value),'one-ring launch '+value);
 const logout=JSON.parse(readFileSync(join(directory,'logout.json'),'utf8'));
 assert.equal(logout.state,'confirmed');assert.equal(logout.domain,'practice');assert.equal(logout.account,record.account);assert.equal(logout.server,record.server);
 assert.match(logout.attemptId,/^\d{13}-\d{1,10}-\d{1,10}$/);assert.ok(logout.loggedOutAt>=record.startedAt&&logout.loggedOutAt<=record.completedAt!);
 const result=artisanTransition(mode,readFileSync(join(directory,'before.sav')),readFileSync(join(directory,'after.sav')),readFileSync(join(directory,'stdout.log'),'utf8'));
 if(mode==='observer'){assert.ok(result.observation);assert.ok(result.observation.at>=record.startedAt&&result.observation.at<=logout.loggedOutAt,'bank observed during retained session');}
 return result;
}

async function worker(name:string,script:string,args:string[],env:Record<string,string>={},expected=0,directory?:string){
 const child=Bun.spawn([process.execPath,resolve(root,script),name,...args],{cwd:root,env:{...process.env,...env},windowsHide:true,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 let expired=false;const timer=setTimeout(()=>{expired=true;void killTree(child.pid);},90000);
 try{
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(directory){writeFileSync(join(directory,'stdout.log'),stdout);writeFileSync(join(directory,'stderr.log'),stderr);writeFileSync(join(directory,'execution.json'),JSON.stringify({script,args,env,exitCode:code,expired},null,2));}
  console.log(stdout);if(stderr)console.error(stderr);
  assert.equal(expired,false,'native worker deadline');assert.equal(code,expected,'native worker exit');
  assert.match(stdout,/^LOGOUT logged-out\s*$/m,'confirmed worker logout');return stdout;
 }finally{clearTimeout(timer);}
}
async function prove(name:string,mode:string,savePath:string){
 assert.match(name,/^aiob[a-z0-9]+$/i,'bench fixture account required');
 assert.equal(basename(savePath).toLowerCase(),name.toLowerCase()+'.sav');
 assert.equal(dirname(realpathSync(savePath)),realpathSync(resolve(root,'vendor/rs-sdk/server/engine/data/players/main')),'generated practice save required');
 const server=serverFromEnv(readFileSync(resolve(root,'vendor/rs-sdk/bots',name,'bot.env'),'utf8'));
 assert.equal(isLocalServer(server),true,'native proof is local only');
 const beforeBytes=readFileSync(savePath),before=parsePracticeSave(beforeBytes),beforeMtimeMs=statSync(savePath).mtimeMs,
  artifact=mode==='producer'||mode==='cut'||mode==='tools'||mode==='observer'?startArtifact(name,mode,server,beforeBytes):undefined;
 let stdout:string,expectedItem:number;
 if(mode==='producer'){
  assert.equal(amount(before,1607,95),13);assert.equal(amount(before,2357,95),13);assert.equal(amount(before,1592,95),1);
  const step=resolveSkillerStep('crafting','jewellery-trip',['RECIPE=sapphire_ring','TARGET=1','BATCH=1','CAP=1500']);
  assert.equal(step.script,entries.producer);
  stdout=await worker(name,step.script,step.args,step.env,0,artifact!.directory);assert.match(stdout,/^RESULT ok\b/m);expectedItem=1637;
  const saved=await waitPracticeSave(savePath,save=>amount(save,1637,95)===1);assert.equal(saved.matched,true);
  const after=readPracticeSave(savePath);
  assert.equal(amount(after,1637,95),1);assert.equal(amount(after,1607,95),12);assert.equal(amount(after,2357,95),12);
  assert.deepEqual(totals(after,[1607,2357,1637]),totals(before,[1607,2357,1637]));
  assert.deepEqual(after.inventories[93]??[],before.inventories[93]??[]);assert.deepEqual(after.inventories[94]??[],before.inventories[94]??[]);
  assert.deepEqual(after.skills[3],before.skills[3]);
 }else if(mode==='cut'){
  assert.equal(amount(before,1623,95),2);assert.equal(amount(before,1755),1);
  stdout=await worker(name,entries.cut,['artisan','crafting','inventory','cut-sapphire'],{MAX_MAKE:'2',CAP:'600'},0,artifact!.directory);expectedItem=1607;
  const saved=await waitPracticeSave(savePath,save=>amount(save,1607,95)===2);assert.equal(saved.matched,true);
 }else if(mode==='tools'){
  assert.equal(amount(before,1755),0);assert.equal(amount(before,1592),0);
  stdout=await worker(name,entries.tools,['shop-buy','dommik','1500'],toolsEnv,0,artifact!.directory);expectedItem=1755;
  const saved=await waitPracticeSave(savePath,save=>amount(save,1755,95)===1&&amount(save,1592,95)===1);assert.equal(saved.matched,true);
 }else if(mode==='observer'){
  stdout=await worker(name,entries.observer,['inspect'],{REQUIRE_BANK:'1'},0,artifact!.directory);expectedItem=995;
  const saved=await waitPracticeSave(savePath,()=>statSync(savePath).mtimeMs>beforeMtimeMs);assert.equal(saved.matched,true,'same-attempt observation save');
  const executionPath=join(artifact!.directory,'execution.json'),execution=JSON.parse(readFileSync(executionPath,'utf8'));
  execution.save={beforeMtimeMs,afterMtimeMs:statSync(savePath).mtimeMs};writeFileSync(executionPath,JSON.stringify(execution,null,2));
 }else{
  assert.equal(mode,'gather-short');assert.equal((before.inventories[93]??[]).length,28);assert.equal(amount(before,1059,93),1);
  stdout=await worker(name,'scripts/aio-skiller.ts',['gather','foraging','spawn','1059','2'],{TICKS:'1'},1);
  assert.match(stdout,/^RESULT fail .*banked=1 .*targetMet=false remaining=1\b/m);expectedItem=1059;
  const saved=await waitPracticeSave(savePath,save=>amount(save,1059,95)===1);assert.equal(saved.matched,true);
  const after=readPracticeSave(savePath);assert.equal(amount(after,1059,95),1);assert.equal(amount(after,1059,93),0);
  assert.deepEqual(totals(after),totals(before));assert.deepEqual(after.inventories[94]??[],before.inventories[94]??[]);
  assert.deepEqual(after.skills,before.skills);
 }
 const logout=readLogoutProof(name,server,{root:resolve(root,'.practice/session-lifecycle')});assert.equal(logout.state,'confirmed');
 if(artifact){
  const afterBytes=readFileSync(savePath);artisanTransition(artifact.record.mode,beforeBytes,afterBytes,stdout);
  writeFileSync(join(artifact.directory,'after.sav'),afterBytes);writeFileSync(join(artifact.directory,'logout.json'),JSON.stringify(logout,null,2));
  artifact.record.completedAt=Date.now();artifact.record.files=Object.fromEntries(files.map(file=>[file,hash(readFileSync(join(artifact.directory,file)))]));artifact.record.status='complete';
  writeFileSync(manifest(artifact.record.mode),JSON.stringify(artifact.record,null,2));verifyArtisanEvidence(artifact.record.mode);
 }
 console.log('CATALOG_INTEGRATION_PROOF '+JSON.stringify({mode,item:expectedItem,assets:true,logout:true}));
 console.log('RESULT ok catalog native '+mode);
}
if(import.meta.main){
 const [name,mode,save]=process.argv.slice(2);
 try{
  if(name==='--verify'){
   assert.ok(mode==='cut'||mode==='producer'||mode==='tools'||mode==='observer','verify mode cut|producer|tools|observer required');const result=verifyArtisanEvidence(mode);
   console.log('CATALOG_ARTISAN_VERIFIED '+JSON.stringify(result));console.log('RESULT ok artisan native verified '+mode);
  }else{if(!name||!mode||!save)throw Error('usage: catalog-integration-proof.ts account cut|producer|tools|observer|gather-short save, or --verify cut|producer|tools|observer');await prove(name,mode,resolve(root,save));}
 }catch(error){console.error(String(error));process.exitCode=1;}
}
