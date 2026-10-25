// Source-bound cow admission from the actual parked Swordinhand snapshot.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {runBotName} from '../../packages/practice/src/prove';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from './fleet-player-save';
import {openBot,finish} from '../../packages/core/src/bot';
import {waitUntil,waitTicks} from '../../packages/core/src/ticks';
import {runCows} from '../gather-combat';
const sourceSha256=createHash('sha256').update(readFileSync('scripts/gather-combat.ts')).digest('hex').toUpperCase();
if(sourceSha256!=='FD2DA0B1FEBDE5410C43C64D1130E9CE0FB22A892847B8A24E7F564699FA5E39')throw new Error('cow source freeze changed');
const account=process.env.COW_PROFILE==='Mightyrod'?'Mightyrod':'Swordinhand',trainSkill=account==='Mightyrod'?'Defence':'Strength';
const sword=JSON.parse(readFileSync(`.practice/status/${account}.json`,'utf8'));
if(!Array.isArray(sword.equipment))throw new Error('source equipment UNKNOWN; fresh observed array required before fixture');
const count=(items:readonly {id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
if(process.argv[2]==='--child'){
 const s=await openBot(process.argv[3]!);
 try{
  await waitUntil(s,()=>s.sdk.getSkill('Hitpoints')?.baseLevel===sword.hp.max,{timeoutTicks:15});
  const skills=s.sdk.getState()!.skills;
  if(!skills.every((v,i)=>v.experience===sword.skills[i].xp&&v.baseLevel===sword.skills[i].level)||s.sdk.getSkill('Hitpoints')?.level!==sword.hp.now)throw new Error('actual source account clone runtime skill/currentHP mismatch');
  console.log('COW_INITIAL '+JSON.stringify({skills,player:s.sdk.getState()!.player,inventory:s.sdk.getInventory(),equipment:s.sdk.getEquipment()}));
  if(!(await s.bot.openBank()).success)throw new Error('owned gear bank unavailable');await waitTicks(s,2);
  for(const id of [1277,1171]){
   if(count([...s.sdk.getInventory(),...s.sdk.getEquipment()],id)>0)continue;
   const item=s.sdk.getState()!.bank.items.find(i=>i.id===id);
   if(!item||item.count!==1)throw new Error('actual owned bronze kit unavailable');
   await s.bot.withdrawItem(item,1,{asNote:false});
   if(!await waitUntil(s,()=>count(s.sdk.getInventory(),id)===1,{timeoutTicks:6}))throw new Error('owned kit withdrawal failed');
  }
  await s.bot.closeBank();
  const result=await runCows(s,{cap:1500,maximum:5,trainSkill,targetLevel:10,diagnostics:true});
  console.log('COW_ADMISSION '+JSON.stringify(result));
  await finish([s],result.ok,`cow-admission ${JSON.stringify(result)}`);
 }catch(e){await finish([s],false,String(e));}
}else{
 if(process.env.REUSE_STACK!=='1')throw new Error('existing stack required');
 const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB']).stdout.toString().trim());
 if(free<9)throw new Error(`single-bot start requires9GiB (8floor+1reserve); actual${free}`);
 const actor=runBotName('flsword',1),dir=resolve('.practice/fleet-proof'),prefix=`cow-admission-${actor}`;
 await createBot(actor);
 const savePath=await applyPreset(actor,{position:sword.pos,skills:Object.fromEntries(sword.skills.map((v:{name:string;level:number})=>[v.name,v.level])),inventory:sword.inventory.map((i:{id:number;count:number})=>({id:i.id,count:i.count})),equipment:sword.equipment.map((i:{id:number;count:number;slot:number})=>({id:i.id,count:i.count,slot:i.slot})),bank:sword.bank.map((i:{id:number;count:number})=>({id:i.id,count:i.count}))});
 setPracticeSkills(savePath,sword.skills.map((v:{name:string;level:number;xp:number})=>({level:v.name==='Hitpoints'?sword.hp.now:v.level,xp:v.xp})));
 const initial=readPracticeSave(savePath);writeFileSync(resolve(dir,`${prefix}-initial.json`),JSON.stringify(initial,null,2));
 console.log(`PROOF_START actor=${actor} freeGiB=${free} source=${sourceSha256} ${trainSkill}Goal10=true actualCurrentHP=${sword.hp.now} sourceAccount=${account}`);
 const p=Bun.spawn(['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),import.meta.path,'--child',actor],{env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',PROOF_TRACE_PATH:'1'},stdout:'pipe',stderr:'pipe'});
 let output='';const timer=setTimeout(()=>p.kill(),660000);
 const read=async(stream:ReadableStream<Uint8Array>)=>{for await(const part of stream){const text=new TextDecoder().decode(part);output+=text;writeFileSync(resolve(dir,`${prefix}.log`),output);process.stdout.write(text);}};
 await Promise.all([read(p.stdout),read(p.stderr)]);const exitCode=await p.exited;clearTimeout(timer);
 const result=JSON.parse(output.match(/^COW_ADMISSION (.+)$/m)?.[1]??'null');
 const final=await waitPracticeSave(savePath,s=>!!result&&s.skills[trainSkill==='Defence'?1:2]!.xp===initial.skills[trainSkill==='Defence'?1:2]!.xp+result.selectedXp&&(s.inventories[95]??[]).some(i=>i.id===1739&&i.count===result.creditedKills),{timeoutMs:6000});
 const totals=(s:typeof initial)=>{const m=new Map<number,number>();for(const items of Object.values(s.inventories))for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
 const before=totals(initial),after=totals(final.save),drops=[1739,526,2132];
 const assets=!!result&&[...new Set([...before.keys(),...after.keys()])].every(id=>(after.get(id)??0)===(before.get(id)??0)+(drops.includes(id)?result.creditedKills:id===333?-result.eaten:0));
 const paths=output.split(/\r?\n/).filter(l=>l.startsWith('PROOF_PATH ')).map(l=>JSON.parse(l.slice(11)));
 const bearNear=paths.filter(p=>p.nearBears.some((n:{distance:number})=>n.distance<=6));
 const damage=output.split(/\r?\n/).filter(l=>l.startsWith('PROOF_DAMAGE ')).map(l=>JSON.parse(l.slice(13)));
 const bearDamage=damage.some(p=>p.npcs.some((n:{id:number;inCombat:boolean;targetIndex:number})=>n.id===105&&n.inCombat&&n.targetIndex!==-1));
 const atBank=final.save.position.level===0&&Math.max(Math.abs(final.save.position.x-2654),Math.abs(final.save.position.z-3283))<=4;
 const ok=exitCode===0&&final.matched&&result?.ok&&result.targetMet&&result.trainSkill===trainSkill&&result.finalLevel>=10&&result.selectedXp>0&&result.creditedKills>=1&&result.creditedKills<=5&&drops.every(id=>count(final.save.inventories[95]??[],id)-(before.get(id)??0)===result.creditedKills)&&assets&&atBank&&!bearDamage&&bearNear.length===0&&!result.died&&result.respawns===0&&/PROOF_SURVIVAL started=true died=false/.test(output)&&output.includes('LOGOUT logged-out');
 writeFileSync(resolve(dir,`${prefix}-snapshot.json`),JSON.stringify({ok,actor,sourceSha256,sourceAccount:account,sourceEquipment:sword.equipment,sourceStatusAt:sword.at,assets,atBank,bearNear,bearDamage,pathFrames:paths.length,damage,result,initial,final:final.save},null,2));
 console.log(`PROOF_GATE cow-admission ok=${ok} kills=${result?.creditedKills} ${trainSkill}=${result?.finalLevel} assets=${assets} bearDamage=${bearDamage} bearNear=${bearNear.length}`);process.exitCode=ok?0:1;
}
