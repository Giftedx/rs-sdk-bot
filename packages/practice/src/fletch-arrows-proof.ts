import {readFileSync,writeFileSync,copyFileSync,existsSync,readdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {freemem} from 'node:os';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {startStack} from './stack';
import {rsSdkRoot,practiceDir} from './paths';
import {killTree} from './proc';
import {selectAmmoProofEndpoints,ammoProofAccountEnv,startAmmoProofStack,ammoChildConfiguration,ammoRegistrationArgs} from './ammo-order-proof';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {workerSourceRevision} from '../../core/src/worker-release';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';

// Native rune arrow order: the real CLI fletches an exact batch from owned bank stock, then a
// separate consumer stage reads the saved state. Bank 95, pack 93, worn 94; skill 9 is Fletching.
type Save=ReturnType<typeof readPracticeSave>;
type Run={code:number;log:string};
const HEADLESS=53,TIP=44,ARROW=892,MAKE=45;
export const ORDER_ENV={MAX_MAKE:String(MAKE),TIP_RESERVE:'5',HEADLESS_RESERVE:'200'};
export const ORDER_ARGS=['scripts/fletch-arrows.ts','3000','native-arrows','rune'];
const BANK={x:3185,z:3436,level:0};
const KIT=[{id:995,count:100}];
export const PRODUCTION_BANK=[{id:HEADLESS,count:400},{id:TIP,count:50},{id:ARROW,count:12},{id:995,count:1000}];
export const REFUSAL_BANK=[{id:HEADLESS,count:400},{id:995,count:1000}];
const qty=(s:Save,id:number,c=95)=>(s.inventories[c]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const totals=(s:Save)=>{const m=new Map<number,number>();for(const c of [93,94,95])for(const i of s.inventories[c]??[])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
const reconciled=(before:Save,after:Save,changes:Map<number,number>)=>{const a=totals(before),b=totals(after);return [...new Set([...a.keys(),...b.keys(),...changes.keys()])].every(id=>(b.get(id)??0)===(a.get(id)??0)+(changes.get(id)??0));};
const resultLine=(log:string)=>JSON.parse(log.split(/\r?\n/).find(l=>l.startsWith('NATIVE_ARROW_BANK '))?.slice('NATIVE_ARROW_BANK '.length)??'null');
const atBank=(s:Save)=>s.position.level===BANK.level&&Math.max(Math.abs(s.position.x-BANK.x),Math.abs(s.position.z-BANK.z))<=8;

export function arrowOrderChecks(p:{before:Save;final:Save;refusalBefore:Save;refused:Save;production:Run;refusal:Run}){
 const {before,final,refusalBefore,refused,production,refusal}=p,r=resultLine(production.log),q=resultLine(refusal.log);
 return{
  entry:qty(before,HEADLESS)===400&&qty(before,TIP)===50&&qty(before,ARROW)===12&&before.skills[9]!.level>=75&&qty(refusalBefore,TIP)===0&&qty(refusalBefore,HEADLESS)===400&&refusalBefore.skills[9]!.level>=75,
  exit:production.code===0&&production.log.includes('RESULT ok ')&&r?.ok===true&&r?.targetMet===true&&r?.made===MAKE&&r?.banked===MAKE,
  bank:qty(final,ARROW)===qty(before,ARROW)+MAKE&&qty(final,TIP)===qty(before,TIP)-MAKE&&qty(final,HEADLESS)===qty(before,HEADLESS)-MAKE&&qty(final,ARROW,93)===0,
  assets:reconciled(before,final,new Map([[ARROW,MAKE],[TIP,-MAKE],[HEADLESS,-MAKE]])),
  xp:final.skills[9]!.xp>before.skills[9]!.xp&&final.skills.every((k,i)=>i===9||k.xp===before.skills[i]!.xp),
  refusal:refusal.code!==0&&refusal.log.includes('RESULT fail native arrows missing owned inputs')&&q?.made===0&&q?.actions===0,
  refusalAssets:reconciled(refusalBefore,refused,new Map())&&refused.skills.every((k,i)=>k.xp===refusalBefore.skills[i]!.xp),
  healthy:final.skills[3]!.level===before.skills[3]!.level&&refused.skills[3]!.level===refusalBefore.skills[3]!.level,
  position:[before,final,refusalBefore,refused].every(atBank),
  logout:production.log.includes('LOGOUT logged-out')&&refusal.log.includes('LOGOUT logged-out'),
 };
}

function verify(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const log=(label:string)=>readFileSync(join(directory,label+'.log'),'utf8')+readFileSync(join(directory,label+'.err'),'utf8');
 const save=(label:string)=>readPracticeSave(join(directory,label+'.sav'));
 const checks={...arrowOrderChecks({before:save('before'),final:save('final'),refusalBefore:save('refusal-before'),refused:save('refused'),production:{code:meta.productionCode,log:log('production')},refusal:{code:meta.refusalCode,log:log('refusal')}}),
  source:meta.source===workerSourceRevision(),fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000};
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,source:meta.source,scope:'Native150ms/25x practice: 45 owned Rune arrowtips + 45 owned headless arrows -> 45 banked Rune arrows; no-tip refusal. No live, unattended or speed claim.'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}

async function run(directory:string){
 if(!existsSync(join(practiceDir(),'delivery-native.lock')))throw Error('practice turn required: run through delivery');
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error(`practice needs ${PRACTICE_STARTUP_GB}GiB free: ${FREE_FLOOR_GB}GiB floor plus startup reserve`);
 const requests=join(practiceDir(),'withdraw');
 if(existsSync(requests)&&readdirSync(requests).some(p=>p.endsWith('.json')))throw Error('supply requests pending; preserve their owner');
 const endpoints=selectAmmoProofEndpoints();
 const lock=join(practiceDir(),'delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,task:'arrow-fletch-order',directory,at:Date.now()}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 const command=async(args:string[],env:Record<string,string>,label:string,timeoutMs=180000):Promise<Run>=>{
  const out=join(directory,label+'.log'),err=join(directory,label+'.err');
  const child=Bun.spawn({...ammoChildConfiguration(args,env,endpoints),windowsHide:true,stdout:Bun.file(out),stderr:Bun.file(err)});
  let expired=false;const timer=setTimeout(()=>{expired=true;void killTree(child.pid);},timeoutMs);
  const code=await child.exited;clearTimeout(timer);
  return{code:expired?-1:code,log:readFileSync(out,'utf8')+readFileSync(err,'utf8')};
 };
 const account=async(prefix:string,bank:{id:number;count:number}[],label:string)=>{
  const name=runBotName(prefix,1);
  if(existsSync(join(rsSdkRoot(),'bots',name)))throw Error('practice name already exists');
  const created=await createBot(name);
  writeFileSync(created.envPath,ammoProofAccountEnv(readFileSync(created.envPath,'utf8'),endpoints));
  const path=await applyPreset(name,{position:BANK,skills:{Fletching:80,Hitpoints:20},inventory:KIT,bank});
  if((await command(ammoRegistrationArgs(name,endpoints),{},label+'-auth')).code!==0)throw Error(`${label} registration failed; see auth logs`);
  if(!(await waitPracticeSave(path,s=>atBank(s)&&s.skills[9]!.level===80&&qty(s,HEADLESS)===400)).matched)throw Error(`${label} entry state not retained`);
  copyFileSync(path,join(directory,label+'-before.sav'));
  return{name,path};
 };
 try{
  const source=workerSourceRevision();
  stack=await startAmmoProofStack(endpoints);
  const producer=await account('rarr',PRODUCTION_BANK,'production');
  copyFileSync(join(directory,'production-before.sav'),join(directory,'before.sav'));
  const production=await command([ORDER_ARGS[0]!,producer.name,...ORDER_ARGS.slice(1)],ORDER_ENV,'production');
  await waitPracticeSave(producer.path,s=>qty(s,ARROW)===12+MAKE);copyFileSync(producer.path,join(directory,'final.sav'));
  const refuser=await account('rnot',REFUSAL_BANK,'refusal');
  const refusal=await command([ORDER_ARGS[0]!,refuser.name,...ORDER_ARGS.slice(1)],ORDER_ENV,'refusal');
  copyFileSync(refuser.path,join(directory,'refused.sav'));
  writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source,names:[producer.name,refuser.name],productionCode:production.code,refusalCode:refusal.code,server:endpoints.server,endpoints:{ports:endpoints.ports,instance:endpoints.instance}},null,2));
  return verify(directory);
 }finally{
  try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}
 }
}

if(import.meta.main){
 try{
  if(!process.env.DELIVERY_DIR)throw Error('run through bun run deliver arrow-fletch-order');
  const directory=resolve(process.env.DELIVERY_DIR);
  process.exitCode=(process.argv[2]==='--verify'?verify(directory):await run(directory)).ok?0:1;
 }catch(error){console.error(String(error));process.exitCode=1;}
}
