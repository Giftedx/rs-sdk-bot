// Exact-source collector CAP/final-bank proof. This is NOT fleet-practice's flax spinner mode.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {runBotName} from '../../packages/practice/src/prove';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from './fleet-player-save';
import {openBot,finish} from '../../packages/core/src/bot';
import {waitUntil} from '../../packages/core/src/ticks';
import {runFlax} from '../gather-flax';
import {parseJm2} from '../../packages/knowledge/src/jm2';
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();
const sourceSha256=hash('scripts/gather-flax.ts');
if(sourceSha256!=='E1309F155CAEE9BB7B79199A3E759B1D29E500D776707E7F329B14C72738032F')throw new Error('flax collector freeze changed');
const sourcePath=resolve(process.env.FLAX_SOURCE_PATH??'.practice/status/Pocketrocket.json'),sourceBytes=readFileSync(sourcePath),source=JSON.parse(sourceBytes.toString());
if(source.name!=='Pocketrocket'||!Array.isArray(source.equipment)||source.skills.length!==21||source.hp.now<=0||source.pos.level!==0)throw new Error('exact Pocket fixture readiness unknown');
const count=(a:readonly {id:number;count:number}[],id:number)=>a.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),initialHeld=count(source.inventory,1779);
if(initialHeld<=0||Math.max(Math.abs(source.pos.x-2744),Math.abs(source.pos.z-3445))>15)throw new Error('requires actual paused Pocket field fixture carrying flax');
if(process.argv[2]==='--child'){
 let stopped=false,edge:unknown;const s=await openBot(process.argv[3]!,{onStop:async()=>{stopped=true;}});
 try{
  await waitUntil(s,()=>s.sdk.getSkill('Hitpoints')?.level===source.hp.now,{timeoutTicks:15});
  if(!s.sdk.getState()!.skills.every((v,i)=>v.experience===source.skills[i].xp&&v.baseLevel===source.skills[i].level))throw new Error('exact Pocket runtime skills mismatch');
  const start=s.tick(),off=s.onTick(()=>{const p=s.sdk.getState()?.player,held=count(s.sdk.getInventory(),1779);if(!edge&&s.tick()-start>=1&&held>0&&p&&Math.max(Math.abs(p.worldX-2744),Math.abs(p.worldZ-3445))<=15){edge={tick:s.tick(),used:s.tick()-start,held,pos:[p.worldX,p.worldZ,p.level]};console.log('FLAX_CAP_EDGE '+JSON.stringify(edge));}});
  const r=await runFlax(s,{cap:1,bankAt:28,stop:()=>stopped});off();
  console.log('FLAX_NATIVE_RESULT '+JSON.stringify({...r,edge}));await finish([s],r.ok,`flax-week ${JSON.stringify(r)}`);
 }catch(e){await finish([s],false,String(e));}
}else{
 if(process.env.REUSE_STACK!=='1')throw new Error('operator must warm one owned stack');
 const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB']).stdout.toString().trim());if(free<9)throw new Error(`one actor needs9GiB; actual${free}`);
 const actor=runBotName('flflax',1),dir=resolve('.practice/fleet-proof'),prefix=`flax-week-${actor}`,frozenSource=resolve(dir,`${prefix}-source.json`);writeFileSync(frozenSource,sourceBytes);await createBot(actor);
 const path=await applyPreset(actor,{position:source.pos,skills:Object.fromEntries(source.skills.map((v:{name:string;level:number})=>[v.name,v.level])),inventory:source.inventory.map((i:{id:number;count:number})=>({id:i.id,count:i.count})),equipment:source.equipment,bank:source.bank.map((i:{id:number;count:number})=>({id:i.id,count:i.count}))});setPracticeSkills(path,source.skills.map((v:{name:string;level:number;xp:number})=>({level:v.name==='Hitpoints'?source.hp.now:v.level,xp:v.xp})));
 const initial=readPracticeSave(path),totals=(v:typeof initial)=>{const m=new Map<number,number>();for(const a of Object.values(v.inventories))for(const i of a)m.set(i.id,(m.get(i.id)??0)+i.count);return m;},before=totals(initial),owned=[...source.inventory,...source.equipment,...source.bank];
 if([...new Set([...before.keys(),...owned.map((i:{id:number})=>i.id)])].some(id=>(before.get(id)??0)!==count(owned,id)))throw new Error('exact source assets not cloned');
 writeFileSync(resolve(dir,`${prefix}-initial.json`),JSON.stringify(initial,null,2));console.log(`PROOF_START flax-week actor=${actor} source=${sourceSha256} sourceStatusAt=${source.at} CAP=1 heldBaseline=${initialHeld} bankBaseline=${count(source.bank,1779)} freeGiB=${free}`);
 const p=Bun.spawn(['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),import.meta.path,'--child',actor],{env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',COURIERS:'',FLAX_SOURCE_PATH:frozenSource,PROOF_TRACE_PATH:'1'},stdout:'pipe',stderr:'pipe'});let output='',timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;writeFileSync(resolve('.practice',`stop-${actor}`),'bounded local flax proof timeout');},120000),hard=setTimeout(()=>p.kill(),150000);
 const read=async(stream:ReadableStream<Uint8Array>)=>{for await(const bytes of stream){const part=new TextDecoder().decode(bytes);output+=part;writeFileSync(resolve(dir,`${prefix}.log`),output);process.stdout.write(part);}};await Promise.all([read(p.stdout),read(p.stderr)]);const code=await p.exited;clearTimeout(timer);clearTimeout(hard);
 const r=JSON.parse(output.match(/^FLAX_NATIVE_RESULT (.+)$/m)?.[1]??'null');
 const final=await waitPracticeSave(path,v=>!!r&&count(v.inventories[93]??[],1779)===0&&count(v.inventories[95]??[],1779)===count(initial.inventories[95]??[],1779)+initialHeld+Number(r.picks),{timeoutMs:6000});
 const after=totals(final.save),netNew=(after.get(1779)??0)-(before.get(1779)??0),assets=[...new Set([...before.keys(),...after.keys()])].every(id=>id===1779||(before.get(id)??0)===(after.get(id)??0));
 const skills=JSON.stringify(initial.skills)===JSON.stringify(final.save.skills),equipment=JSON.stringify(initial.inventories[94]??[])===JSON.stringify(final.save.inventories[94]??[]);
 const booths=parseJm2('m42_54.jm2',readFileSync('vendor/rs-sdk/server/content/maps/m42_54.jm2','utf8')).locs.filter(l=>l.id===2213&&l.level===0&&l.x>=2718&&l.x<=2730&&l.z>=3490&&l.z<=3498),atBank=final.save.position.level===0&&booths.some(b=>Math.max(Math.abs(final.save.position.x-b.x),Math.abs(final.save.position.z-b.z))<=1);
 const life=new RegExp(`PROOF_SURVIVAL started=true died=false hpMin=${source.hp.now} finalHp=${source.hp.now}`).test(output),worker=!!r?.ok&&r.picks>0&&netNew===r.picks&&r.banked===initialHeld+r.picks&&r.held===0&&r.finalBankConfirmed===true&&r.bankObservedAt>0&&!r.died&&!r.ended&&!r.stopped&&!!r.edge&&r.ticks>1;
 const ok=code===0&&worker&&final.matched&&assets&&skills&&equipment&&atBank&&life&&!timedOut&&output.includes('LOGOUT logged-out');
 writeFileSync(resolve(dir,`${prefix}-snapshot.json`),JSON.stringify({ok,actor,sourceSha256,harnessSha256:hash(import.meta.path),sourceSnapshotSha256:hash(frozenSource),sourceStatusAt:source.at,qualification:'Actual paused Pocket field entry and assets, one CAP-bounded pick then exact-source final-bank route. Existing held flax excluded from net-new output. No stop-native or bank-to-field entry claim.',code,result:r,initialHeld,netNew,worker,assets,skills,equipment,atBank,life,timedOut,initial,final:final.save},null,2));console.log(`PROOF_GATE flax-week ok=${ok} netNew=${netNew} assets=${assets} atBank=${atBank} life=${life}`);process.exitCode=ok?0:1;
}
