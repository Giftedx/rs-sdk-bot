// Native acceptance for the existing shop-buyer CLI. Import and --verify never start a service.
import{readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync,openSync,closeSync,unlinkSync}from'node:fs';
import{join,resolve}from'node:path';
import{createHash}from'node:crypto';
import{freemem}from'node:os';
import{createBot}from'./bots';
import{applyPreset,type SaveConfig}from'./presets';
import{practiceDir,rsSdkRoot}from'./paths';
import{runBotName}from'./prove';
import{killTree}from'./proc';
import{stopStack}from'./stack';
import{selectGeProofEndpoints,startGeProofStack,geProofAccountEnv,assertGeProofAccount}from'./ge-bulk-order-proof';
import{readPracticeSave,waitPracticeSave}from'../../../scripts/measure/fleet-player-save';
import{capabilityRevision,type ReleaseMemo}from'../../core/src/worker-release';
import{readLogoutProof}from'../../core/src/session-lifecycle';
import{orderPaths}from'../../../scripts/buy-owned-ge-item';
import{FREE_FLOOR_GB,PRACTICE_STARTUP_GB}from'../../core/src/memory';
import{productionConserved}from'../../../scripts/earth-production';
type Save=ReturnType<typeof readPracticeSave>;
type Run={code:number;timedOut:boolean;log:string;hpMin:number;logout?:ReturnType<typeof readLogoutProof>};
const root=resolve(import.meta.dir,'../../..');
const total=(s:Save,id:number)=>Object.values(s.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const bank=(s:Save,id:number)=>(s.inventories[95]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const amount=(log:string,key:string)=>Number(log.split(/\r?\n/).filter(l=>l.startsWith('RESULT ')).at(-1)?.match(new RegExp('\\b'+key+'=(\\d+)'))?.[1]??NaN);
const exits=(r:Run)=>({exit:r.code===0&&!r.timedOut,logout:/^LOGOUT logged-out\r?$/m.test(r.log)&&!/^WARN .*?(logout|session close)/m.test(r.log)});
const unchanged=(a:Save,b:Save,allowed:number[]=[])=>[...new Set([...Object.values(a.inventories).flat(),...Object.values(b.inventories).flat()].map(i=>i.id))].every(id=>allowed.includes(id)||total(a,id)===total(b,id));
const atBank=(s:Save)=>s.position.level===0&&Math.max(Math.abs(s.position.x-3253),Math.abs(s.position.z-3420))<=4;
export const shopSupplyFixture=(coins:number,extra:SaveConfig={}):SaveConfig=>({position:{x:3185,z:3436,level:0},skills:{Attack:49,Strength:10,Defence:11,Hitpoints:35},inventory:[{id:1277,count:1}],bank:[{id:995,count:coins},{id:554,count:1482},{id:557,count:3},{id:1521,count:7}],...extra});
export function shopSupplyChecks(before:Save,after:Save,r:Run){const spent=amount(r.log,'spentTotal');return{
 ...exits(r),entry:total(before,557)===3&&total(before,554)===1482&&total(before,995)===352288,
 target:bank(after,557)===1139&&total(after,557)===1139&&amount(r.log,'boughtTotal')===1136&&amount(r.log,'targetMet')===1,
 coins:Number.isSafeInteger(spent)&&spent>0&&spent<=45440&&total(before,995)-total(after,995)===spent&&total(after,995)>=30000,
 assets:unchanged(before,after,[557,995])&&bank(after,554)===1482,
 health:Number.isFinite(r.hpMin)&&r.hpMin>0&&after.skills[3]!.level===before.skills[3]!.level&&after.skills[3]!.xp===before.skills[3]!.xp,
 bank:atBank(after),result:/^RESULT ok /m.test(r.log),
};}
export function shopRepeatChecks(before:Save,after:Save,r:Run){return{...exits(r),assets:unchanged(before,after),bank:atBank(after),target:bank(after,557)===1139&&amount(r.log,'boughtTotal')===0&&amount(r.log,'spentTotal')===0&&amount(r.log,'targetMet')===1};}
export function shopRefusalChecks(before:Save,after:Save,r:Run){
 const line=r.log.split(/\r?\n/).find(l=>l.startsWith('OWNED_GE_ITEM '));let ge:any;try{ge=line&&JSON.parse(line.slice(14));}catch{}
 const ordinary=ge?.ok===false&&ge.newItemsThisSession===0&&ge.cashDeltaThisSession===0&&ge.spent===0&&/owned reserve missing/.test(ge.failure??'');
 return{...exits(r),exit:!r.timedOut&&(ordinary?r.code===1:r.code===0),assets:unchanged(before,after),health:Number.isFinite(r.hpMin)&&r.hpMin>0,
 refusal:ordinary||amount(r.log,'boughtTotal')===0&&amount(r.log,'spentTotal')===0&&amount(r.log,'targetMet')===0&&/stop=(?:stock-wait|coin-reserve|bounded-purchase-unaffordable)/.test(r.log)};
}
export function bettySupplyChecks(before:Save,after:Save,r:Run){const spent=amount(r.log,'spentTotal');return{
 ...exits(r),target:bank(after,557)===53&&total(after,557)===53&&amount(r.log,'boughtTotal')===50&&amount(r.log,'targetMet')===1,
 bank:after.position.level===0&&Math.max(Math.abs(after.position.x-3092),Math.abs(after.position.z-3243))<=4,
 coins:Number.isSafeInteger(spent)&&spent>0&&spent<=2000&&total(before,995)-total(after,995)===spent&&total(after,995)>=30000,
 assets:unchanged(before,after,[557,995])&&bank(after,554)===1482,health:Number.isFinite(r.hpMin)&&r.hpMin>0,
};}
export function refillSupplyChecks(before:Save,after:Save,r:Run){
 let result:any;try{result=JSON.parse(r.log.split(/\r?\n/).find(l=>l.startsWith('EARTH_REFILL '))!.slice(13));}catch{}
 return{...exits(r),target:bank(after,557)===53&&total(after,557)===53&&result?.targetMet===1&&result?.seeded===1&&result?.boughtTotal===51,
  coins:Number.isSafeInteger(result?.spentTotal)&&result.spentTotal>0&&result.spentTotal<=2000&&Number.isSafeInteger(result?.seedCredit)&&result.seedCredit>=0&&total(before,995)-total(after,995)===result.spentTotal-result.seedCredit,
  bank:result?.bank===true&&after.position.level===0&&Math.max(Math.abs(after.position.x-3092),Math.abs(after.position.z-3243))<=4,
  assets:unchanged(before,after,[557,995])&&bank(after,554)===1482,health:Number.isFinite(r.hpMin)&&r.hpMin>6,
  result:result?.ok===true&&result?.conserved===true,
 };
}
const files=['scripts/buy-owned-ge-item.ts','scripts/earth-shop.ts','scripts/earth-shop.test.ts','scripts/earth-production.ts','scripts/earth-production.test.ts','scripts/shop-buyer.ts','scripts/shop-buyer.test.ts','packages/practice/src/shop-supply-order-proof.ts','packages/practice/test/shop-supply-order-proof.test.ts'];
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const artifactPaths=['before.sav','after.sav','repeat.sav','refuse-before.sav','refused.sav','buy.log','repeat.log','refuse.log','empty-ge.log','original-ge-journal.json','original-ge-journal-after.json','fallback-spend.json','betty-before.sav','betty-after.sav','betty.log','betty-empty-ge.log','refill-before.sav','refill-after.sav','refill-repeat.sav','refill.log','refill-repeat.log','refill-empty-ge.log','refill-ledger.json','hunt-before.sav','hunt-after.sav','craft-before.sav','craft-after.sav','owned-hunt.log','owned-craft.log'];
const ownedTotals=(s:Save)=>{const m=new Map<number,number>();for(const c of [93,94,95])for(const i of s.inventories[c]??[])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
const productionSaved=(before:Save,after:Save,v:any)=>productionConserved(ownedTotals(before),ownedTotals(after),{consumed:v.consumed,crafted:v.crafted,air:v.air,eaten:v.eaten,found:v.found})&&JSON.stringify(before.inventories[94]??[])===JSON.stringify(after.inventories[94]??[]);
const source=(memo:ReleaseMemo=new Map())=>({runtime:capabilityRevision(['scripts/buy-owned-ge-item.ts'],root,memo),files:Object.fromEntries(files.map(f=>[f,hash(join(root,f))]))});
export function verifyShopSupply(directory:string,memo:ReleaseMemo=new Map()){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const now=Date.now(),ageMs=now-meta.at;
 const saved=(p:string)=>readPracticeSave(join(directory,p+'.sav'));
 const run=(key:string):Run=>({...meta.runs[key],log:readFileSync(join(directory,key+'.log'),'utf8')});
 const checks={...shopSupplyChecks(saved('before'),saved('after'),run('buy')),
  repeat:Object.values(shopRepeatChecks(saved('after'),saved('repeat'),run('repeat'))).every(Boolean),
  refusal:Object.values(shopRefusalChecks(saved('refuse-before'),saved('refused'),run('refuse'))).every(Boolean),
  source:JSON.stringify(meta.source)===JSON.stringify(source(memo)),
  lifecycle:Object.values(meta.runs).every((r:any)=>r.logout?.state==='confirmed'),
  artifacts:artifactPaths.every(f=>typeof meta.hashes?.[f]==='string'&&hash(join(directory,f))===meta.hashes[f])&&Object.entries(meta.hashes).every(([f,h])=>hash(join(directory,f))===h),
  nativeRun:typeof meta.directory==='string'&&meta.directory===resolve(directory),
  // Immutable saved effects have no age limit. Qualification and live admission have separate owners.
  fresh:Number.isFinite(meta.at)&&meta.at<=now,
  originalJournal:hash(join(directory,'original-ge-journal.json'))===hash(join(directory,'original-ge-journal-after.json')),
  fallbackSpend:(()=>{const j=JSON.parse(readFileSync(join(directory,'fallback-spend.json'),'utf8'));return j.phase==='settled'&&j.request.item===557&&j.request.quantity===1136&&j.request.expectedOwned===3&&j.spent===total(saved('before'),995)-total(saved('after'),995);})(),
  betty:Object.values(bettySupplyChecks(saved('betty-before'),saved('betty-after'),run('betty'))).every(Boolean),
  refill:Object.values(refillSupplyChecks(saved('refill-before'),saved('refill-after'),run('refill'))).every(Boolean),
  refillRepeat:unchanged(saved('refill-after'),saved('refill-repeat'))&&exits(run('refill-repeat')).exit&&amount(run('refill-repeat').log,'boughtTotal')===0&&amount(run('refill-repeat').log,'seeded')===0,
  refillLedger:(()=>{const j=JSON.parse(readFileSync(join(directory,'refill-ledger.json'),'utf8'));return j.phase==='settled'&&j.seeded===1&&j.spent===amount(run('refill').log,'spentTotal');})(),
  ownedHunt:(()=>{const r=run('owned-hunt'),v=JSON.parse(r.log.split(/\r?\n/).find(l=>l.startsWith('EARTH_PRODUCTION '))!.slice(17));return r.code===0&&!r.timedOut&&v.ok===true&&v.kills===2&&v.pilotReady===1&&v.conserved===true&&v.equipmentRestored===true&&productionSaved(saved('hunt-before'),saved('hunt-after'),v)&&r.hpMin>6&&bank(saved('hunt-after'),995)===bank(saved('hunt-before'),995)&&bank(saved('hunt-after'),554)===1482;})(),
  ownedCraft:(()=>{const r=run('owned-craft'),v=JSON.parse(r.log.split(/\r?\n/).find(l=>l.startsWith('EARTH_PRODUCTION '))!.slice(17));return r.code===0&&!r.timedOut&&v.ok===true&&v.targetMet===1&&v.trips===2&&v.conserved===true&&productionSaved(saved('craft-before'),saved('craft-after'),v)&&v.consumed>0&&v.consumed<60&&bank(saved('craft-after'),557)>=103&&bank(saved('craft-after'),557)<=105&&bank(saved('craft-after'),554)===1482&&total(saved('craft-before'),1436)-total(saved('craft-after'),1436)===v.consumed&&r.hpMin>6;})(),
 };
 const report={ok:Object.values(checks).every(Boolean),checks,at:now,nativeAt:meta.at,ageMs,directory:resolve(directory),source:meta.source,scope:'Native 150ms/25x existing shop-buyer CLI: exact 1136-earth acquisition, retained1482fire, repeat and funds refusal; no live or rank claim.'};
 writeFileSync(join(directory,'verified.json'),JSON.stringify(report,null,2));return report;
}
// One low free-memory sample between two child runs stopped a proof that had 16 GiB free at the next check.
// Only a floor breach that lasts the whole bounded wait stops the proof.
export const HEADROOM_WAIT_MS=60000;
export async function waitFreeMemory(floorGb:number,read:()=>number=()=>freemem()/2**30,pause:(ms:number)=>Promise<unknown>=ms=>Bun.sleep(ms),waitMs=HEADROOM_WAIT_MS){
 let free=read();
 for(let waited=0;free<floorGb&&waited<waitMs;waited+=250){await pause(250);free=read();}
 return free;
}
export async function runShopSupplyNative(directory:string){
 mkdirSync(directory,{recursive:true});if(existsSync(join(directory,'before.sav')))throw Error('preserve existing native snapshots');
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('native shop startup headroom unavailable');
 const endpoint=selectGeProofEndpoints(),pin=source(),actors=new Set<string>();
 const lock=join(practiceDir(),'delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,task:'shop-supply-order',directory,at:Date.now()}));
 let stack:Awaited<ReturnType<typeof startGeProofStack>>|undefined;
 const command=async(name:string,label:string,shop=true,quantity=1136,profile='aubury',extra:Record<string,string>={}):Promise<Run>=>{
  if(!actors.has(name))throw Error('owned practice actor required');
  const free=await waitFreeMemory(FREE_FLOOR_GB);
  if(free<FREE_FLOOR_GB)throw Error(`native memory boundary: ${free.toFixed(2)}GiB free below ${FREE_FLOOR_GB}GiB floor after ${HEADROOM_WAIT_MS}ms`);
  const started=Date.now(),out=join(directory,label+'.log'),err=join(directory,label+'.err');
  const child=Bun.spawn(['bun','scripts/buy-owned-ge-item.ts',name],{cwd:root,windowsHide:true,stdout:Bun.file(out),stderr:Bun.file(err),env:{...process.env,...endpoint.env,DEMO_OK:'',RANDOM_EVENTS:'0',ORDER_KEY:'native-earth-shop',ITEM_ID:'557',QUANTITY:String(quantity),EXPECTED_OWNED:'3',LIMIT_PRICE:'40',CASH_RESERVE:'30000',ORDER_MS:'900000',FILL_WAIT_TICKS:'0',CAP:profile.startsWith('owned-')?'20000':profile.endsWith('-refill')?'16000':profile==='betty'?'3000':'1600',SHOP_PROFILE:shop?profile:'',...extra}});
  let hpMin=Infinity,ready=false,timedOut=false,termination:Promise<void>|undefined;
  const observe=()=>{try{const s=JSON.parse(readFileSync(join(root,'.practice/status',name+'.json'),'utf8'));if(s.started>=started-2000&&s.name===name&&Number.isFinite(s.hp?.now)){if(s.hp.now>0)ready=true;if(ready)hpMin=Math.min(hpMin,s.hp.now);}}catch{}};
  const monitor=setInterval(observe,100),timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid);},240000);
  const code=await child.exited;clearTimeout(timer);clearInterval(monitor);observe();await termination;
  return{code,timedOut,hpMin,log:readFileSync(out,'utf8')+readFileSync(err,'utf8'),logout:readLogoutProof(name,endpoint.server)};
 };
 try{
  stack=await startGeProofStack(endpoint);
  const seed=async(index:number,coins:number,extra:Record<string,unknown>={})=>{
   const name=runBotName('flshop',index);if(existsSync(join(rsSdkRoot(),'bots',name)))throw Error('practice identity already exists');
   const {envPath}=await createBot(name);writeFileSync(envPath,geProofAccountEnv(readFileSync(envPath,'utf8'),endpoint));assertGeProofAccount(readFileSync(envPath,'utf8'),endpoint.env);actors.add(name);
   const path=await applyPreset(name,shopSupplyFixture(coins,extra));return{name,path};
  };
  const buyer=await seed(1,352288);copyFileSync(buyer.path,join(directory,'before.sav'));
  const empty=await command(buyer.name,'empty-ge',false);if(empty.code===0||!empty.log.includes('"acquired":0')||!empty.log.includes('LOGOUT logged-out'))throw Error('real zero-fill GE settlement not proved');
  const journal=orderPaths(endpoint.server,buyer.name,'native-earth-shop').journal,journalBefore=hash(journal);
  copyFileSync(journal,join(directory,'original-ge-journal.json'));
  const buy=await command(buyer.name,'buy');
  const after=await waitPracticeSave(buyer.path,s=>bank(s,557)===1139&&atBank(s),{timeoutMs:15000});copyFileSync(buyer.path,join(directory,'after.sav'));if(!after.matched)throw Error('useful exact earth output not saved');
  const repeat=await command(buyer.name,'repeat');await waitPracticeSave(buyer.path,s=>bank(s,557)===1139&&atBank(s));copyFileSync(buyer.path,join(directory,'repeat.sav'));
  if(hash(journal)!==journalBefore)throw Error('shop fallback changed the GE journal');
  copyFileSync(journal,join(directory,'original-ge-journal-after.json'));copyFileSync(journal+'.shop.json',join(directory,'fallback-spend.json'));
  const poor=await seed(2,30000);copyFileSync(poor.path,join(directory,'refuse-before.sav'));
  const refuse=await command(poor.name,'refuse',false);await waitPracticeSave(poor.path,s=>s.position.x===3185&&s.position.z===3436);copyFileSync(poor.path,join(directory,'refused.sav'));
  const alternate=await seed(3,352288);copyFileSync(alternate.path,join(directory,'betty-before.sav'));
  const emptyBetty=await command(alternate.name,'betty-empty-ge',false,50);if(emptyBetty.code===0||!emptyBetty.log.includes('"acquired":0')||!emptyBetty.log.includes('LOGOUT logged-out'))throw Error('alternate zero-fill GE settlement unproved');
  const betty=await command(alternate.name,'betty',true,50,'betty');
  const bettySaved=await waitPracticeSave(alternate.path,s=>bank(s,557)===53&&s.position.level===0&&Math.max(Math.abs(s.position.x-3092),Math.abs(s.position.z-3243))<=4,{timeoutMs:15000});
  copyFileSync(alternate.path,join(directory,'betty-after.sav'));if(!bettySaved.matched)throw Error('alternate shop stock not saved');
  const seeded=await seed(4,352288);copyFileSync(seeded.path,join(directory,'refill-before.sav'));
  const emptyRefill=await command(seeded.name,'refill-empty-ge',false,50);if(emptyRefill.code===0||!emptyRefill.log.includes('"acquired":0'))throw Error('refill zero-fill settlement unproved');
  const refill=await command(seeded.name,'refill',true,50,'betty-refill');
  const refillSaved=await waitPracticeSave(seeded.path,s=>bank(s,557)===53&&s.position.level===0&&Math.max(Math.abs(s.position.x-3092),Math.abs(s.position.z-3243))<=4,{timeoutMs:15000});
  copyFileSync(seeded.path,join(directory,'refill-after.sav'));if(!refillSaved.matched)throw Error('seeded refill target not saved');
  const refillRepeat=await command(seeded.name,'refill-repeat',true,50,'betty-refill');await waitPracticeSave(seeded.path,s=>bank(s,557)===53);
  copyFileSync(seeded.path,join(directory,'refill-repeat.sav'));copyFileSync(orderPaths(endpoint.server,seeded.name,'native-earth-shop').journal+'.shop.json',join(directory,'refill-ledger.json'));
  const hunter=await seed(5,352288,{skills:{Attack:49,Strength:10,Defence:11,Hitpoints:35},inventory:[],bank:[{id:995,count:352288},{id:554,count:1482},{id:557,count:3},{id:1277,count:1},{id:1171,count:1},{id:1115,count:1},{id:1891,count:8}]});
  await command(hunter.name,'hunt-empty-ge',false,100);
  copyFileSync(hunter.path,join(directory,'hunt-before.sav'));
  const ownedHunt=await command(hunter.name,'owned-hunt',true,100,'owned-talismans',{HUNT_KILLS_PER_TARGET:'1'});
  await waitPracticeSave(hunter.path,s=>s.position.z===3436||ownedHunt.code!==0);copyFileSync(hunter.path,join(directory,'hunt-after.sav'));
  const crafter=await seed(6,352288,{skills:{Runecraft:51,Hitpoints:35},inventory:[],bank:[{id:995,count:352288},{id:554,count:1482},{id:557,count:3},{id:1436,count:60},{id:1438,count:1},{id:1440,count:1}]});await command(crafter.name,'craft-empty-ge',false,100);
  copyFileSync(crafter.path,join(directory,'craft-before.sav'));
  const ownedCraft=await command(crafter.name,'owned-craft',true,100,'owned-craft');
  await waitPracticeSave(crafter.path,s=>bank(s,557)>=103||ownedCraft.code!==0);copyFileSync(crafter.path,join(directory,'craft-after.sav'));
  writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),directory:resolve(directory),source:pin,endpoint:{ports:endpoint.ports,instance:endpoint.instance},runs:{buy,repeat,refuse,betty,refill,'refill-repeat':refillRepeat,'owned-hunt':ownedHunt,'owned-craft':ownedCraft},hashes:Object.fromEntries(artifactPaths.map(f=>[f,hash(join(directory,f))]))},null,2));
  return verifyShopSupply(directory);
 }finally{
  try{await(stack?stack.stop():stopStack(endpoint.instance));}finally{closeSync(fd);if(existsSync(lock)&&JSON.parse(readFileSync(lock,'utf8')).pid===process.pid)unlinkSync(lock);}
 }
}
if(import.meta.main){const directory=process.env.DELIVERY_DIR;if(!directory)throw Error('DELIVERY_DIR required');const report=process.argv[2]==='--verify'?verifyShopSupply(resolve(directory)):await runShopSupplyNative(resolve(directory));console.log(JSON.stringify(report));process.exitCode=report.ok?0:1;}
