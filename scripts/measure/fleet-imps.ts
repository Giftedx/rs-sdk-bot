// Actual Sword snapshot, bounded source-frozen native Imp hero-drop proof. Stack owned separately.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {runBotName} from '../../packages/practice/src/prove';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from './fleet-player-save';
import {openBot,finish} from '../../packages/core/src/bot';
import {waitUntil} from '../../packages/core/src/ticks';
import {parseJm2} from '../../packages/knowledge/src/jm2';
const script=resolve('scripts/gather-imps.ts'),sourceSha256=createHash('sha256').update(readFileSync(script)).digest('hex').toUpperCase();
if(!process.env.EXPECT_IMP_SHA||sourceSha256!==process.env.EXPECT_IMP_SHA||process.env.IMP_ROUTE_GO!=='1')throw new Error('exact source freeze plus route GO required');
const deferredNpcIndices=(process.env.IMP_DEFERRED??'').split(',').filter(Boolean).map(Number);
const maximum=1; // Directed first productive gate; prior MAX2 failures remain separate raw evidence.
const routeAudit=JSON.parse(readFileSync('.practice/fleet-proof/imp-route-admission.json','utf8'));if(routeAudit.decision!=='GO_FOR_BOUNDED_PRACTICE_ONLY'||routeAudit.via?.x!==2649||routeAudit.via?.z!==3267)throw new Error('corrected route GO missing');
const sword=JSON.parse(readFileSync('.practice/status/Swordinhand.json','utf8'));
if(!Array.isArray(sword.equipment))throw new Error('source equipment unknown');
const ids=[592,1470,1472,1474,1476],foods=[333],count=(items:readonly {id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
if(process.argv[2]==='--child'){
 const s=await openBot(process.argv[3]!);
 try{
  await waitUntil(s,()=>s.sdk.getSkill('Hitpoints')?.baseLevel===sword.hp.max,{timeoutTicks:15});
  if(!s.sdk.getState()!.skills.every((v,i)=>v.experience===sword.skills[i].xp&&v.baseLevel===sword.skills[i].level)||s.sdk.getSkill('Hitpoints')?.level!==sword.hp.now)throw new Error('exact Sword runtime fixture mismatch');
  console.log('IMP_INITIAL '+JSON.stringify({skills:s.sdk.getState()!.skills,player:s.sdk.getState()!.player,inventory:s.sdk.getInventory(),equipment:s.sdk.getEquipment()}));
  const direct=s.direct.bind(s);s.direct=async action=>{if(action.type==='walkTo'&&action.reason==='imp halt'){const st=s.sdk.getState(),player=st?.player;if(player)console.log('IMP_CANCEL_CALL '+JSON.stringify({tick:s.tick(),pos:[player.worldX,player.worldZ,player.level],x:action.x,z:action.z,combat:player.combat,autoRetaliate:st?.autoRetaliateEnabled}));}return direct(action);};
  const {runImps}=await import(script);
  const result=await runImps(s,{cap:1500,maximum,deferredNpcIndices});
  console.log('IMP_NATIVE_RESULT '+JSON.stringify(result));await finish([s],result.ok,`imp-native ${JSON.stringify(result)}`);
 }catch(e){await finish([s],false,String(e));}
}else{
 if(process.env.REUSE_STACK!=='1')throw new Error('operator must warm the single approved stack first');
 const active=JSON.parse(readFileSync('.practice/pids.json','utf8'));if(!active.engine?.pid||!active.gateway?.pid)throw new Error('stack identity missing');
 const tsc=Bun.spawnSync(['powershell','-NoProfile','-Command',"@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|bun' -and $_.CommandLine -match 'tsc --noEmit|typescript[\\\\/]bin[\\\\/]tsc' }).Count"],{stdout:'pipe'}).stdout.toString().trim();if(Number(tsc)!==0)throw new Error('heavy typecheck still running');
 const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB']).stdout.toString().trim());if(free<9)throw new Error(`warmed stack needs>=9GiB before actor; actual${free}`);
 const actor=runBotName('flimp',1),dir=resolve('.practice/fleet-proof'),prefix=`imps-${actor}`;await createBot(actor);
 const path=await applyPreset(actor,{position:sword.pos,skills:Object.fromEntries(sword.skills.map((v:{name:string;level:number})=>[v.name,v.level])),inventory:sword.inventory.map((i:{id:number;count:number})=>({id:i.id,count:i.count})),equipment:sword.equipment.map((i:{id:number;count:number;slot:number})=>({id:i.id,count:i.count,slot:i.slot})),bank:sword.bank.map((i:{id:number;count:number})=>({id:i.id,count:i.count}))});setPracticeSkills(path,sword.skills.map((v:{name:string;level:number;xp:number})=>({level:v.name==='Hitpoints'?sword.hp.now:v.level,xp:v.xp})));
 const initial=readPracticeSave(path);writeFileSync(resolve(dir,`${prefix}-initial.json`),JSON.stringify(initial,null,2));console.log(`PROOF_START actor=${actor} source=${sourceSha256} freeGiB=${free} maximum=${maximum} initialDeferred=${deferredNpcIndices.join(',')||'-'} sourceStatusAt=${sword.at}`);
 const p=Bun.spawn(['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),'--preload',resolve('scripts/measure/fleet-imp-observe.ts'),import.meta.path,'--child',actor],{env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',PROOF_TRACE_PATH:'1'},stdout:'pipe',stderr:'pipe'});let output='';const timer=setTimeout(()=>p.kill(),660000);
 const read=async(stream:ReadableStream<Uint8Array>)=>{for await(const b of stream){const text=new TextDecoder().decode(b);output+=text;writeFileSync(resolve(dir,`${prefix}.log`),output);process.stdout.write(text);}};await Promise.all([read(p.stdout),read(p.stderr)]);const exitCode=await p.exited;clearTimeout(timer);
 const result=JSON.parse(output.match(/^IMP_NATIVE_RESULT (.+)$/m)?.[1]??'null');
 const baseline=count(initial.inventories[95]??[],592),final=await waitPracticeSave(path,s=>!!result&&count(s.inventories[95]??[],592)===baseline+Number(result.loot?.[592]??-1)&&s.skills[0]!.xp===initial.skills[0]!.xp+result.attackXp,{timeoutMs:6000});
 const totals=(s:typeof initial)=>{const m=new Map<number,number>();for(const items of Object.values(s.inventories))for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};const before=totals(initial),after=totals(final.save),observedLoot:Record<number,number>=result?.loot??{};
 const assets=!!result&&[...new Set([...before.keys(),...after.keys()])].every(id=>(after.get(id)??0)===(before.get(id)??0)+(ids.includes(id)?Number(observedLoot[id]??0):foods.includes(id)?-result.eaten:0));
 const outputBanked=!!result&&ids.every(id=>count(final.save.inventories[95]??[],id)-count(initial.inventories[95]??[],id)===Number(observedLoot[id]??0)&&count(final.save.inventories[93]??[],id)===0)&&Number(observedLoot[592]??0)===Number(result.mandatoryAshes??0)+Number(result.bonusAshes??0);
 const booths=parseJm2('m41_51.jm2',readFileSync('vendor/rs-sdk/server/content/maps/m41_51.jm2','utf8')).locs.filter(l=>l.id===2213&&l.level===0&&l.x>=2650&&l.x<=2660&&l.z>=3280&&l.z<=3290),atBank=final.save.position.level===0&&booths.some(b=>Math.max(Math.abs(final.save.position.x-b.x),Math.abs(final.save.position.z-b.z))<=1);
 const frames=output.split(/\r?\n/).filter(l=>l.startsWith('IMP_FRAME ')).map(l=>JSON.parse(l.slice(10)));
 const attackCalls=output.split(/\r?\n/).filter(l=>l.startsWith('IMP_ATTACK_CALL ')).map(l=>JSON.parse(l.slice(16)));
 const cancelCalls=output.split(/\r?\n/).filter(l=>l.startsWith('IMP_CANCEL_CALL ')).map(l=>JSON.parse(l.slice(16)));
 const inside=(p:number[],margin=0)=>p[2]===0&&p[0]>=2627+margin&&p[0]<=2645-margin&&p[1]>=3222+margin&&p[1]<=3253-margin;
 const credits:any[]=result?.credits??[];
 const attributedAshes=credits.reduce((n,c)=>n+Number(c.freshAshCount??0),0),bonusAshes=credits.reduce((n,c)=>n+Number(c.extraAshes??0),0);
 const unexplainedAshes=count(final.save.inventories[95]??[],592)-baseline-attributedAshes;
 let lastCreditDeath=-1;const deathWitnesses:{npcIndex:number;attackTick:number;deathTick:number}[]=[];
 const anchoredCredits=credits.every(c=>{const call=attackCalls.find(a=>a.npcIndex===c.npcIndex&&a.tick>lastCreditDeath);const death=call?frames.find(f=>f.tick>=call.tick&&f.imps.some((n:any)=>n.index===c.npcIndex&&(n.hp===0||n.anim===172)&&(n.tileX??n.x)===c.anchor[0]&&(n.tileZ??n.z)===c.anchor[1])):undefined;if(!call||!death)return false;lastCreditDeath=death.tick;deathWitnesses.push({npcIndex:c.npcIndex,attackTick:call.tick,deathTick:death.tick});return c.guaranteedAshes===1&&[1,2].includes(c.freshAshCount)&&c.extraAshes===c.freshAshCount-1&&c.ownAttackXp>0&&(c.observedHp0===true||c.deathAnim===true)&&inside([...c.anchor,0]);});
 const corpseAccounting=!!result&&credits.length===result.creditedKills&&anchoredCredits&&Number(result.mandatoryAshes)===result.creditedKills&&Number(result.bonusAshes)===bonusAshes&&Number(result.unexplainedAshes)===0&&unexplainedAshes===0&&attributedAshes===Number(observedLoot[592]??0)&&ids.filter(id=>id!==592).every(id=>credits.reduce((n,c)=>n+Number(c.beadCounts?.[id]??0),0)===Number(observedLoot[id]??0));
 const abandoned:any[]=result?.abandoned??[],creditedXp=credits.reduce((n,c)=>n+Number(c.ownAttackXp??0),0),abandonedXp=abandoned.reduce((n,c)=>n+Number(c.partialDamageXp??0),0);
 const xpAccounting=!!result&&creditedXp===result.creditedAttackXp&&abandonedXp===result.abandonedAttackXp&&creditedXp+abandonedXp===result.attackXp&&final.save.skills[0]!.xp-initial.skills[0]!.xp===result.attackXp&&abandoned.every(a=>a.cancellationObserved===true&&a.partialDamageXp>=0);
 const deferredAudit=!!result&&JSON.stringify(result.initialDeferredNpcIndices)===JSON.stringify(deferredNpcIndices)&&attackCalls.every(a=>!deferredNpcIndices.includes(a.npcIndex))&&credits.every(c=>!deferredNpcIndices.includes(c.npcIndex));
 const threatViolations=frames.filter(f=>f.pos[2]!==0||routeAudit.threats.some((h:{b:number[];r:number})=>Math.max(Math.max(h.b[0]!-f.pos[0],0,f.pos[0]-h.b[2]!),Math.max(h.b[1]!-f.pos[1],0,f.pos[1]-h.b[3]!))<=h.r));
 const fullThreatAudit=frames.length>0&&threatViolations.length===0;
 const attackSafety=attackCalls.length>0&&attackCalls.every(a=>a.autoRetaliate===false&&a.distance<=1&&inside(a.pos,2)&&inside([...a.target,0],3));
 const reengageCalls=attackCalls.filter((a,i)=>attackCalls.slice(0,i).some(p=>p.npcIndex===a.npcIndex));
 const reengagementAudit=!!result&&reengageCalls.length===result.reengagements&&reengageCalls.every(a=>{const previous=attackCalls.filter(p=>p.tick<a.tick&&p.npcIndex===a.npcIndex).at(-1);return cancelCalls.some(c=>previous&&c.tick>previous.tick&&c.tick<a.tick&&c.x===c.pos[0]&&c.z===c.pos[1]&&frames.some(f=>f.tick>c.tick&&f.tick<=a.tick&&f.pos.every((v:number,i:number)=>v===c.pos[i])&&f.combat?.inCombat===false&&f.combat.targetType==='none'&&f.autoRetaliate===false));});
 const firstAttack=attackCalls[0]?.tick??Infinity;
 const lastPickup=frames.find(f=>f.tick>=firstAttack&&ids.every(id=>Number(f.heldLoot?.[id]??0)===Number(observedLoot[id]??0))&&Number(f.heldLoot?.[592]??0)>0)?.tick;
 const huntFrames=frames.filter(f=>f.tick>=firstAttack&&lastPickup!==undefined&&f.tick<=lastPickup);
 const fenceAudit=huntFrames.length>0&&huntFrames.every(f=>inside(f.pos));
 const life=/PROOF_SURVIVAL started=true died=false/.test(output),otherSkills=final.save.skills.every((v,i)=>[0,3].includes(i)||v.xp===initial.skills[i]!.xp);
 const ok=exitCode===0&&final.matched&&result?.ok&&result.creditedKills===maximum&&result.attackXp>0&&outputBanked&&assets&&atBank&&life&&otherSkills&&corpseAccounting&&xpAccounting&&deferredAudit&&fullThreatAudit&&attackSafety&&reengagementAudit&&fenceAudit&&!result.died&&output.includes('LOGOUT logged-out');
 writeFileSync(resolve(dir,`${prefix}-snapshot.json`),JSON.stringify({ok,actor,sourceSha256,sourceStatusAt:sword.at,result,assets,outputBanked,atBank,life,otherSkills,corpseAccounting,deathWitnesses,xpAccounting,creditedXp,abandonedXp,deferredAudit,deferredNpcIndices,fullThreatAudit,threatViolations,routeAuditSha256:createHash('sha256').update(readFileSync('.practice/fleet-proof/imp-route-admission.json')).digest('hex'),attributedAshes,bonusAshes,unexplainedAshes,attackSafety,attackCalls,reengagementAudit,reengageCalls,cancelCalls,fenceAudit,huntFrames:huntFrames.length,lastPickup,qualification:'mandatoryAsh==kills; per-corpse1or2ashes explicitlyattributed; unexplained0; no all-four-bead promise; teleport native-proved only if observed',initial,final:final.save},null,2));console.log(`PROOF_GATE imps ok=${ok} credited=${result?.creditedKills} ashes=${observedLoot[592]} assets=${assets} outputBanked=${outputBanked} life=${life}`);process.exitCode=ok?0:1;
}
