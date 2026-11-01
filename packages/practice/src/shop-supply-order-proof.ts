// Native acceptance for the existing shop-buyer CLI. Import and --verify never start a service.
import{readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync,openSync,closeSync,unlinkSync}from'node:fs';
import{join,resolve}from'node:path';
import{createHash}from'node:crypto';
import{freemem}from'node:os';
import{createBot}from'./bots';
import{applyPreset}from'./presets';
import{practiceDir,rsSdkRoot}from'./paths';
import{runBotName}from'./prove';
import{killTree}from'./proc';
import{stopStack}from'./stack';
import{selectGeProofEndpoints,startGeProofStack,geProofAccountEnv,assertGeProofAccount}from'./ge-bulk-order-proof';
import{readPracticeSave,waitPracticeSave}from'../../../scripts/measure/fleet-player-save';
import{capabilityRevision}from'../../core/src/worker-release';
import{readLogoutProof}from'../../core/src/session-lifecycle';
import{FREE_FLOOR_GB,PRACTICE_STARTUP_GB}from'../../core/src/memory';
type Save=ReturnType<typeof readPracticeSave>;
type Run={code:number;timedOut:boolean;log:string;hpMin:number;logout?:ReturnType<typeof readLogoutProof>};
const root=resolve(import.meta.dir,'../../..');
const total=(s:Save,id:number)=>Object.values(s.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const bank=(s:Save,id:number)=>(s.inventories[95]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const amount=(log:string,key:string)=>Number(log.match(new RegExp('\\b'+key+'=(\\d+)'))?.[1]??NaN);
const exits=(r:Run)=>({exit:r.code===0&&!r.timedOut,logout:/^LOGOUT logged-out\r?$/m.test(r.log)&&!/^WARN .*?(logout|session close)/m.test(r.log)});
const unchanged=(a:Save,b:Save,allowed:number[]=[])=>[...new Set([...Object.values(a.inventories).flat(),...Object.values(b.inventories).flat()].map(i=>i.id))].every(id=>allowed.includes(id)||total(a,id)===total(b,id));
const atBank=(s:Save)=>s.position.level===0&&Math.max(Math.abs(s.position.x-3253),Math.abs(s.position.z-3420))<=4;
export function shopSupplyChecks(before:Save,after:Save,r:Run){const spent=amount(r.log,'spentTotal');return{
 ...exits(r),entry:total(before,557)===3&&total(before,554)===1482&&total(before,995)===352288,
 target:bank(after,557)===1139&&total(after,557)===1139&&amount(r.log,'boughtTotal')===1136&&amount(r.log,'targetMet')===1,
 coins:Number.isSafeInteger(spent)&&spent>0&&spent<=45440&&total(before,995)-total(after,995)===spent&&total(after,995)>=30000,
 assets:unchanged(before,after,[557,995])&&bank(after,554)===1482,
 health:Number.isFinite(r.hpMin)&&r.hpMin>0&&after.skills[3]!.level===before.skills[3]!.level&&after.skills[3]!.xp===before.skills[3]!.xp,
 bank:atBank(after),result:/^RESULT ok /m.test(r.log),
};}
export function shopRepeatChecks(before:Save,after:Save,r:Run){return{...exits(r),assets:unchanged(before,after),bank:atBank(after),target:bank(after,557)===1139&&amount(r.log,'boughtTotal')===0&&amount(r.log,'spentTotal')===0&&amount(r.log,'targetMet')===1};}
export function shopRefusalChecks(before:Save,after:Save,r:Run){return{...exits(r),assets:unchanged(before,after),health:r.hpMin>0,refusal:amount(r.log,'boughtTotal')===0&&amount(r.log,'spentTotal')===0&&amount(r.log,'targetMet')===0&&/stop=(?:stock-wait|coin-reserve|bounded-purchase-unaffordable)/.test(r.log)};}
const files=['scripts/shop-buyer.ts','scripts/shop-buyer.test.ts','packages/practice/src/shop-supply-order-proof.ts','packages/practice/test/shop-supply-order-proof.test.ts'];
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const source=()=>({runtime:capabilityRevision(['scripts/shop-buyer.ts'],root),files:Object.fromEntries(files.map(f=>[f,hash(join(root,f))]))});
export function verifyShopSupply(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const saved=(p:string)=>readPracticeSave(join(directory,p+'.sav'));
 const run=(key:string):Run=>({...meta.runs[key],log:readFileSync(join(directory,key+'.log'),'utf8')});
 const checks={...shopSupplyChecks(saved('before'),saved('after'),run('buy')),
  repeat:Object.values(shopRepeatChecks(saved('after'),saved('repeat'),run('repeat'))).every(Boolean),
  refusal:Object.values(shopRefusalChecks(saved('refuse-before'),saved('refused'),run('refuse'))).every(Boolean),
  source:JSON.stringify(meta.source)===JSON.stringify(source()),
  lifecycle:Object.values(meta.runs).every((r:any)=>r.logout?.state==='confirmed'),
  artifacts:Object.entries(meta.hashes).every(([f,h])=>hash(join(directory,f))===h),
  fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,
 };
 const report={ok:Object.values(checks).every(Boolean),checks,at:Date.now(),source:meta.source,scope:'Native 150ms/25x existing shop-buyer CLI: exact 1136-earth acquisition, retained1482fire, repeat and funds refusal; no live or rank claim.'};
 writeFileSync(join(directory,'verified.json'),JSON.stringify(report,null,2));return report;
}
async function native(directory:string){
 mkdirSync(directory,{recursive:true});if(existsSync(join(directory,'before.sav')))throw Error('preserve existing native snapshots');
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('native shop startup headroom unavailable');
 const endpoint=selectGeProofEndpoints(),pin=source(),actors=new Set<string>();
 const lock=join(practiceDir(),'delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,task:'shop-supply-order',directory,at:Date.now()}));
 let stack:Awaited<ReturnType<typeof startGeProofStack>>|undefined;
 const command=async(name:string,label:string):Promise<Run>=>{
  if(!actors.has(name)||freemem()/2**30<FREE_FLOOR_GB)throw Error('owned actor/native memory boundary');
  const started=Date.now(),out=join(directory,label+'.log'),err=join(directory,label+'.err');
  const child=Bun.spawn(['bun','scripts/shop-buyer.ts',name,'aubury','1600','2000'],{cwd:root,windowsHide:true,stdout:Bun.file(out),stderr:Bun.file(err),env:{...process.env,...endpoint.env,DEMO_OK:'',RANDOM_EVENTS:'0',ITEMS:'earth rune',STOP_AT_TARGET:'1',STOCK_TARGET:'1139',MAX_ITEMS:'1136',MAX_SPEND:'45440',COIN_RESERVE:'30000',FLOAT:'75440',NO_BUY_TICKS:'25',BANK_PACK:'1'}});
  let hpMin=Infinity,timedOut=false,termination:Promise<void>|undefined;
  const observe=()=>{try{const s=JSON.parse(readFileSync(join(root,'.practice/status',name+'.json'),'utf8'));if(s.started>=started-2000&&s.name===name&&Number.isFinite(s.hp?.now))hpMin=Math.min(hpMin,s.hp.now);}catch{}};
  const monitor=setInterval(observe,100),timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid);},240000);
  const code=await child.exited;clearTimeout(timer);clearInterval(monitor);observe();await termination;
  return{code,timedOut,hpMin,log:readFileSync(out,'utf8')+readFileSync(err,'utf8'),logout:readLogoutProof(name,endpoint.server)};
 };
 try{
  stack=await startGeProofStack(endpoint);
  const seed=async(index:number,coins:number)=>{
   const name=runBotName('flshop',index);if(existsSync(join(rsSdkRoot(),'bots',name)))throw Error('practice identity already exists');
   const {envPath}=await createBot(name);writeFileSync(envPath,geProofAccountEnv(readFileSync(envPath,'utf8'),endpoint));assertGeProofAccount(readFileSync(envPath,'utf8'),endpoint.env);actors.add(name);
   const path=await applyPreset(name,{position:{x:3185,z:3436,level:0},skills:{Hitpoints:35},inventory:[{id:1277,count:1}],bank:[{id:995,count:coins},{id:554,count:1482},{id:557,count:3},{id:1521,count:7}]});return{name,path};
  };
  const buyer=await seed(1,352288);copyFileSync(buyer.path,join(directory,'before.sav'));
  const buy=await command(buyer.name,'buy');
  const after=await waitPracticeSave(buyer.path,s=>bank(s,557)===1139&&atBank(s),{timeoutMs:15000});copyFileSync(buyer.path,join(directory,'after.sav'));if(!after.matched)throw Error('useful exact earth output not saved');
  const repeat=await command(buyer.name,'repeat');await waitPracticeSave(buyer.path,s=>bank(s,557)===1139&&atBank(s));copyFileSync(buyer.path,join(directory,'repeat.sav'));
  const poor=await seed(2,30000);copyFileSync(poor.path,join(directory,'refuse-before.sav'));
  const refuse=await command(poor.name,'refuse');await waitPracticeSave(poor.path,s=>atBank(s));copyFileSync(poor.path,join(directory,'refused.sav'));
  const paths=['before.sav','after.sav','repeat.sav','refuse-before.sav','refused.sav','buy.log','repeat.log','refuse.log'];
  writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source:pin,endpoint:{ports:endpoint.ports,instance:endpoint.instance},runs:{buy,repeat,refuse},hashes:Object.fromEntries(paths.map(f=>[f,hash(join(directory,f))]))},null,2));
  return verifyShopSupply(directory);
 }finally{
  try{await(stack?stack.stop():stopStack(endpoint.instance));}finally{closeSync(fd);if(existsSync(lock)&&JSON.parse(readFileSync(lock,'utf8')).pid===process.pid)unlinkSync(lock);}
 }
}
if(import.meta.main){const directory=process.env.DELIVERY_DIR;if(!directory)throw Error('DELIVERY_DIR required');const report=process.argv[2]==='--verify'?verifyShopSupply(resolve(directory)):await native(resolve(directory));console.log(JSON.stringify(report));process.exitCode=report.ok?0:1;}
