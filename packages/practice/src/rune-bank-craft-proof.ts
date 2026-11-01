// Harness-owned practice proof for scripts/rune-bank-craft.ts. --verify never launches services or workers.
// One staged account: Rune Mysteries done, air/mind talismans and 30 essence banked, 5 air runes held.
// At xpRate1 the first 27 air essence unlock mind. The remaining 3 essence must become mind runes.
import {readFileSync,writeFileSync,appendFileSync,copyFileSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {workerSourceRevision} from '../../core/src/worker-release';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {wrapTransparent} from './shark-fishing-diagnostic';

// Practice preload uses the existing transparent observer hooks. No pinned file is changed.
export async function installRuneEntryObserver(root:string,out:string,name:string){
 const load=(p:string)=>import(pathToFileURL(join(root,p)).href);
 await load('tools/pack/PackAll.ts');
 const World=(await load('src/engine/World.ts')).default;
 const Player=(await load('src/engine/entity/Player.ts')).default;
 const Handler=(await load('src/network/game/client/handler/OpLocUHandler.ts')).default;
 const Decoder=(await load('src/network/game/client/codec/OpLocUDecoder.ts')).default;
 const Runner=(await load('src/engine/script/ScriptRunner.ts')).default;
 const {ScriptOpcodeMap}=await load('src/engine/script/ScriptOpcode.ts');
 let until=-1,handling=false,rows=0;
 const emit=(row:object)=>{if(rows++<512)appendFileSync(out,JSON.stringify({at:Date.now(),clock:World.currentTick,...row})+'\n');};
 const fail=(error:unknown)=>{try{emit({kind:'observer-error',error:String(error)});}catch{}};
 const mine=(p:any)=>p?.username?.toLowerCase()===name.toLowerCase();
 const active=(p:any)=>mine(p)&&World.currentTick<=until;
 const target=(t:any)=>t?{type:t.type,x:t.x,z:t.z,level:t.level}:null;
 const snap=(p:any)=>({x:p.x,z:p.z,level:p.level,protect:p.protect,delayed:p.delayed,
  modalMain:p.modalMain,modalChat:p.modalChat,modalSide:p.modalSide,modalState:p.modalState,
  target:target(p.target),targetOp:p.targetOp,lastUseItem:p.lastUseItem,lastUseSlot:p.lastUseSlot});
 wrapTransparent(Decoder.prototype,'decode',{
  after(_ctx,_self,_args,o){if(!o.threw){const m=o.result as any;if(m?.loc===2453)emit({kind:'decoded-oplocu',message:m});}}
 },fail);
 wrapTransparent(Handler.prototype,'handle',{
  before(_self,args){const [message,p]=args;if(!mine(p)||message.loc!==2453)return;
   until=World.currentTick+25;handling=true;return {message,player:name,before:snap(p)};},
  after(ctx,_self,args,o){if(!ctx)return;handling=false;emit({kind:'oplocu-handler',...ctx,after:snap(args[1]),
   accepted:o.threw?null:o.result,error:o.threw?String(o.error):null});}
 },fail);
 for(const key of ['canAccess','processInteraction','executeScript','setInteraction'])wrapTransparent(Player.prototype,key,{
  before(p,args){if(!active(p))return;return {before:snap(p),script:key==='executeScript'?args[0]?.script?.name:null};},
  after(ctx,p,_args,o){if(ctx)emit({kind:key,...ctx,after:snap(p),result:o.threw?null:typeof o.result==='boolean'?o.result:null,
   error:o.threw?String(o.error):null});}
 },fail);
 wrapTransparent(Player.prototype,'write',{
  before(p,args){if(active(p)&&args[0]?.constructor?.name==='UnsetMapFlag')emit({kind:'unset-map-flag',handling,
   state:snap(p),frames:(Error().stack??'').split('\n').slice(1,12)});}
 },fail);
 for(const key of ['JUMP','JUMP_WITH_PARAMS','P_TELEJUMP']){
  const opcode=ScriptOpcodeMap.get(key);if(!Number.isInteger(opcode))throw Error(`entry observer opcode missing: ${key}`);
  wrapTransparent(Runner.HANDLERS,opcode,{
   before(_self,args){const s=args[0];if(active(s._activePlayer))return {script:s.script?.name,state:snap(s._activePlayer)};},
   after(ctx,_self,args,o){if(ctx)emit({kind:key,...ctx,toScript:args[0].script?.name,after:snap(args[0]._activePlayer),
    error:o.threw?String(o.error):null});}
  },fail);
 }
 emit({kind:'installed',player:name,windowTicks:25,maxRows:512});
}

type Save=ReturnType<typeof readPracticeSave>;
const ESSENCE=1436,AIR=556,MIND=558,TALISMAN=1438,MIND_TALISMAN=1448,PACK=93,BANK=95,RC=20,XP_RATE=1,STAGED=30;
export const runeBankCraftFixture={position:{x:3013,z:3355,level:0},varps:{63:6,101:1,281:1000},
 skills:{Attack:47,Hitpoints:33,Runecraft:1},
 bank:[{id:ESSENCE,count:STAGED},{id:AIR,count:25},{id:TALISMAN,count:1},{id:MIND_TALISMAN,count:1}],inventory:[{id:AIR,count:5}]} satisfies SaveConfig;
const sum=(s:Save,id:number,container?:number)=>Object.entries(s.inventories).filter(([key])=>container===undefined||Number(key)===container)
 .reduce((n,[,items])=>n+items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),0);
const assets=(s:Save)=>{const a:Record<number,number>={};for(const i of Object.values(s.inventories).flat())a[i.id]=(a[i.id]??0)+i.count;return a;};
export function runeBankSaveChecks(before:Save,after:Save,xpRate=XP_RATE){
 const used=sum(before,ESSENCE)-sum(after,ESSENCE),raw=(s:Save,i:number)=>s.skills[i]!.rawExperience;
 const a=assets(before),b=assets(after),converted=new Set([ESSENCE,AIR,MIND]);
 return {entry:before.vars[63]===6&&sum(before,ESSENCE,BANK)===STAGED&&sum(before,ESSENCE,PACK)===0&&sum(before,TALISMAN)===1
   &&sum(before,MIND_TALISMAN)===1&&sum(before,MIND)===0&&sum(before,AIR,PACK)>0&&before.skills[RC]!.level===1&&raw(before,RC)===0,
  essence:used===STAGED&&sum(after,ESSENCE)===0,
  // Air 5 and mind 5.5 XP per essence, saved as tenths.
  xp:raw(after,RC)-raw(before,RC)===(27*50+3*55)*xpRate,
  runes:sum(after,AIR,BANK)-sum(before,AIR)===27&&sum(after,MIND,BANK)-sum(before,MIND)===3
   &&sum(after,AIR,PACK)===0&&sum(after,MIND,PACK)===0,
  multiplierOne:after.skills[RC]!.level<11,
  otherSkills:after.skills.every((s,i)=>i===RC||s.rawExperience===raw(before,i)),
  assets:[...new Set([...Object.keys(a),...Object.keys(b)])].every(id=>converted.has(Number(id))||(a[Number(id)]??0)===(b[Number(id)]??0)),
  life:after.skills[3]!.level>0};
}
function verify(directory:string){
 const before=readPracticeSave(join(directory,'before.sav')),after=readPracticeSave(join(directory,'after.sav'));
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8')),log=readFileSync(join(directory,'worker.log'),'utf8');
 const summary=JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('RUNE_BANK_CRAFT_RESULT ')).at(-1)?.slice('RUNE_BANK_CRAFT_RESULT '.length)??'null');
 const refusalLog=readFileSync(join(directory,'refusal.log'),'utf8');
 const refusal=JSON.parse(refusalLog.split(/\r?\n/).filter(l=>l.startsWith('RUNE_BANK_CRAFT_RESULT ')).at(-1)?.slice('RUNE_BANK_CRAFT_RESULT '.length)??'null');
 const refused=readPracticeSave(join(directory,'refusal.sav'));
 const used=sum(before,ESSENCE)-sum(after,ESSENCE);
 const checks={...runeBankSaveChecks(before,after),exit:meta.code===0&&!meta.timedOut,published:meta.published===true,
  result:summary?.ok===true&&summary?.consumed===used&&summary?.crafted===used&&summary?.trips>=2&&summary?.bankEssence===0,
  ladder:summary?.tripResults?.length===2&&summary.tripResults[0]?.altar==='air'&&summary.tripResults[0]?.consumed===27
   &&summary.tripResults[1]?.altar==='mind'&&summary.tripResults[1]?.level===2&&summary.tripResults[1]?.consumed===3
   &&log.includes('"trip":1,"altar":"air"')&&log.includes('"trip":2,"altar":"mind"'),
  logout:(log.match(/^LOGOUT logged-out\r?$/gm)??[]).length===1&&!/^WARN .*logout/m.test(log),
  refusal:meta.refusal?.code===1&&!meta.refusal.timedOut&&refusal?.ok===false&&refusal?.consumed===0&&refusal?.crafted===0
   &&refusal?.failure==='Error: next acquisition: rune essence1436 exhausted before any crafting',
  refusalAssets:JSON.stringify(assets(after))===JSON.stringify(assets(refused))
   &&after.skills.every((s,i)=>s.rawExperience===refused.skills[i]!.rawExperience)&&refused.skills[3]!.level>0,
  refusalLogout:(refusalLog.match(/^LOGOUT logged-out\r?$/gm)??[]).length===1&&!/^WARN .*logout/m.test(refusalLog),
  life:!/"died"/.test(log),
  source:meta.source===workerSourceRevision(),fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000};
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),
  scope:'One staged practice account, 27 air essence then 3 mind essence after level 2, tick150 xpRate1. Other altars, live, unattended and speed remain unproved.',
  checks,used,runecraftXp:after.skills[RC]!.xp,workerElapsedMs:meta.workerElapsedMs};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(directory:string){
 // Delivery owns the practice turn and waits for current native admission before this entry.
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('HOST_DEFERRED_NATIVE_HEADROOM: insufficient practice startup reserve; no stack started');
 const lock=resolve(import.meta.dir,'../../../.practice/delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'rune-bank-craft'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const source=workerSourceRevision(),name=runBotName('rbc',1);
  const botDir=resolve(import.meta.dir,'../../../vendor/rs-sdk/bots',name);if(existsSync(botDir))throw Error('fresh account required');
  const preload=join(directory,'rune-entry-preload.ts'),trace=join(directory,'rune-entry-engine.jsonl');
  writeFileSync(preload,`import {isMainThread} from 'node:worker_threads';\nif(isMainThread){const {installRuneEntryObserver}=await import(${JSON.stringify(pathToFileURL(import.meta.path).href)});\nawait installRuneEntryObserver(process.cwd(),${JSON.stringify(trace)},${JSON.stringify(name)});}\n`);
  stack=await startStack({tickMs:150,xpRate:XP_RATE,readyTimeoutMs:60000,enginePreload:{module:preload,env:{}}});await createBot(name);
  if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
  const path=await applyPreset(name,runeBankCraftFixture);
  copyFileSync(path,join(directory,'before.sav'));
  const before=readPracticeSave(path),started=Date.now();
  const worker=async(log:string,err:string)=>{
  if(freemem()/2**30<FREE_FLOOR_GB)throw Error('practice memory floor reached before child');
  const child=Bun.spawn(['bun','scripts/rune-bank-craft.ts',name,'99'],{cwd:resolve(import.meta.dir,'../../..'),
   env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',CAP:'4000'},
   stdout:Bun.file(join(directory,log)),stderr:Bun.file(join(directory,err)),windowsHide:true});
  let timedOut=false,termination:Promise<void>|undefined;const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid);},600000);
  const code=await child.exited;clearTimeout(timer);await termination;
  return {code,timedOut};
  };
  const {code,timedOut}=await worker('worker.log','worker.err');
  const workerElapsedMs=Date.now()-started;
  const saved=await waitPracticeSave(path,s=>code!==0||sum(s,ESSENCE)===0&&s.skills[RC]!.rawExperience>before.skills[RC]!.rawExperience);
  copyFileSync(path,join(directory,'after.sav'));
  if(code!==0||timedOut||!saved.matched)throw Error('productive CLI failed; retain worker logs and saves');
  // Same account and stock, without reseeding: exhausted essence must refuse with logout.
  const refusal=await worker('refusal.log','refusal.err');
  copyFileSync(path,join(directory,'refusal.sav'));
  writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),name,source,code,timedOut,published:saved.matched,workerElapsedMs,refusal},null,2));
  return verify(directory);
 }finally{try{await stack?.stop();}finally{try{
  if(stack)for(const [service,path] of Object.entries(stack.logs))if(existsSync(path))copyFileSync(path,join(directory,`${service}.log`));
 }finally{closeSync(fd);unlinkSync(lock);}}}
}
if(import.meta.main){
 try{
  if(!process.env.DELIVERY_DIR)throw Error('run through the delivery harness (DELIVERY_DIR)');
  const directory=resolve(process.env.DELIVERY_DIR);
  process.exitCode=(process.argv[2]==='--verify'?verify(directory):await run(directory)).ok?0:1;
 }catch(error){console.error(String(error));process.exitCode=1;}
}
