// Exact native regression: one already worn plus one held copy of each bronze kit item.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {runBotName} from '../../packages/practice/src/prove';
import {readPracticeSave,waitPracticeSave} from './fleet-player-save';
import {openBot,finish} from '../../packages/core/src/bot';
import {waitUntil} from '../../packages/core/src/ticks';
import {equipCowKit} from '../gather-combat';
const sourceSha256=createHash('sha256').update(readFileSync('scripts/gather-combat.ts')).digest('hex').toUpperCase();
if(sourceSha256!=='FD2DA0B1FEBDE5410C43C64D1130E9CE0FB22A892847B8A24E7F564699FA5E39')throw new Error('cow final freeze changed');
const count=(items:readonly {id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
if(process.argv[2]==='--child'){
 const s=await openBot(process.argv[3]!);
 try{
  for(const id of [1277,1171]){
   const item=s.sdk.getInventory().find(i=>i.id===id);if(!item)throw new Error('missing native prep kit');
   await s.bot.equipItem(item);
   if(!await waitUntil(s,()=>s.sdk.getEquipment().some(i=>i.id===id),{timeoutTicks:10}))throw new Error('native prep failed to wear kit');
  }
  const before={inventory:s.sdk.getInventory(),equipment:s.sdk.getEquipment()};
  if(![1277,1171].every(id=>count(before.inventory,id)===1&&count(before.equipment,id)===1))throw new Error('requires exact worn+held duplicate fixture');
  let calls=0;const equip=s.bot.equipItem;
  (s.bot as any).equipItem=(...args:any[])=>{calls++;return equip.apply(s.bot,args as Parameters<typeof equip>);};
  await equipCowKit(s);
  const after={inventory:s.sdk.getInventory(),equipment:s.sdk.getEquipment()};
  const ok=calls===0&&[1277,1171].every(id=>count(after.inventory,id)===1&&count(after.equipment,id)===1);
  console.log('KIT_PROOF '+JSON.stringify({ok,calls,before,after}));await finish([s],ok,`native-kit-idempotent calls=${calls} preserved=${ok}`);
 }catch(e){await finish([s],false,String(e));}
}else{
 if(process.env.REUSE_STACK!=='1')throw new Error('existing stack required');
 const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB'],{windowsHide:true}).stdout.toString().trim());if(free<9)throw new Error(`single-bot start requires9GiB (8floor+1reserve); actual${free}`);
 const actor=runBotName('flkit',1),dir=resolve('.practice/fleet-proof'),prefix=`cow-kit-${actor}`;await createBot(actor);
 const path=await applyPreset(actor,{position:{x:2654,z:3283,level:0},coins:165,inventory:[{id:1277,count:1},{id:1277,count:1},{id:1171,count:1},{id:1171,count:1},{id:333,count:1},{id:333,count:1}]});
 const initial=readPracticeSave(path);console.log(`PROOF_START actor=${actor} source=${sourceSha256} freeGiB=${free}`);
 const p=Bun.spawn(['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),import.meta.path,'--child',actor],{env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0'},stdout:'pipe',stderr:'pipe',windowsHide:true});let output='';const timer=setTimeout(()=>p.kill(),60000);
 const read=async(stream:ReadableStream<Uint8Array>)=>{for await(const b of stream){const part=new TextDecoder().decode(b);output+=part;writeFileSync(resolve(dir,`${prefix}.log`),output);process.stdout.write(part);}};
 await Promise.all([read(p.stdout),read(p.stderr)]);const code=await p.exited;clearTimeout(timer);
 const result=JSON.parse(output.match(/^KIT_PROOF (.+)$/m)?.[1]??'null');
 const publication=await waitPracticeSave(path,s=>[1277,1171].every(id=>count(s.inventories[93]??[],id)===1&&count(s.inventories[94]??[],id)===1));
 const totals=(s:typeof initial)=>{const m=new Map<number,number>();for(const items of Object.values(s.inventories))for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};const before=totals(initial),after=totals(publication.save);
 const preserved=[...new Set([...before.keys(),...after.keys()])].every(id=>(before.get(id)??0)===(after.get(id)??0));
 const ok=code===0&&publication.matched&&result?.ok&&result.calls===0&&preserved&&/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(output)&&output.includes('LOGOUT logged-out');
 writeFileSync(resolve(dir,`${prefix}-snapshot.json`),JSON.stringify({ok,actor,sourceSha256,result,preserved,initial,final:publication.save},null,2));console.log(`PROOF_GATE cow-kit ok=${ok} equipCalls=${result?.calls} preserved=${preserved}`);process.exitCode=ok?0:1;
}
