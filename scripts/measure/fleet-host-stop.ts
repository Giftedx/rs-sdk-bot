// Historical-fixture SINGLE hosted worker STOP gate. No fresh public admission or memory/scaling claim.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {BotSDK} from '../../vendor/rs-sdk/sdk/index';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {runBotName} from '../../packages/practice/src/prove';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from './fleet-player-save';
import {parseJm2} from '../../packages/knowledge/src/jm2';
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
const hostSha256=hash('packages/core/src/host.ts'),prayerSha256=hash('scripts/train-prayer.ts');
if(hostSha256!=='2F5C1509181F25E239D6ED91E8213F3C33A430E21BE9DD56D2A809AB25ED6C82'||prayerSha256!=='458AEDDE6C5043A6F336656291FEE297340FAF328DEBD6ACF96667CF6B722368')throw new Error('host/worker freeze changed');
const sourcePath='.practice/fleet-proof/prayer-flprayxwwy01-source.json',sourceBytes=readFileSync(sourcePath),source=JSON.parse(sourceBytes.toString());
const count=(items:readonly {id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
if(!Array.isArray(source.equipment)||source.hp.now!==70||source.skills[5].xp!==0||count(source.bank,526)!==222)throw new Error('historical pre-Prayer fixture changed');
if(process.env.HOST_STOP_OBSERVER==='1'){
 const actor=process.env.HOST_STOP_ACTOR;if(!actor||!/^fl[a-z0-9]+$/i.test(actor))throw new Error('private actor required');
 const original=BotSDK.prototype.getState;let requested=false;
 BotSDK.prototype.getState=function(){const st=original.call(this),p=st?.player,prayer=st?.skills.find(s=>s.name==='Prayer');
  if(!requested&&st?.inGame&&p&&prayer&&prayer.experience>0){requested=true;const evidence={tick:st.tick,prayerXp:prayer.experience,heldBones:count(st.inventory,526),bankOpen:st.bank.isOpen,pos:[p.worldX,p.worldZ,p.level]};writeFileSync(resolve('.practice',`stop-${actor}`),'local hosted STOP proof after first observed real bone XP');console.log('HOST_STOP_REQUEST '+JSON.stringify(evidence));}
  return st;
 };
}else{
 if(process.env.REUSE_STACK!=='1')throw new Error('operator must warm one local stack');
 const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB'],{windowsHide:true}).stdout.toString().trim());if(free<9)throw new Error(`warm single actor admission needs9GiB; actual${free}`);
 const actor=runBotName('flhstop',1),dir=resolve('.practice/fleet-proof'),prefix=`host-stop-${actor}`;await createBot(actor);
 const path=await applyPreset(actor,{position:source.pos,skills:Object.fromEntries(source.skills.map((s:{name:string;level:number})=>[s.name,s.level])),inventory:source.inventory.map((i:{id:number;count:number})=>({id:i.id,count:i.count})),equipment:source.equipment,bank:source.bank.map((i:{id:number;count:number})=>({id:i.id,count:i.count}))});setPracticeSkills(path,source.skills);
 const initial=readPracticeSave(path);writeFileSync(resolve(dir,`${prefix}-initial.json`),JSON.stringify(initial,null,2));
 console.log(`PROOF_START host-stop actor=${actor} host=${hostSha256} prayer=${prayerSha256} historicalFixture=true freeGiB=${free}`);
 const p=Bun.spawn(['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),'--preload',import.meta.path,resolve('packages/core/src/host.ts'),'scripts/train-prayer.ts',actor],{env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',MAX_BURY:'175',BONE_RESERVE:'6',CAP:'200',HOST_STOP_OBSERVER:'1',HOST_STOP_ACTOR:actor,PROOF_EXPECT_SKILLS:JSON.stringify(source.skills),PROOF_TRACE_PATH:'1'},stdout:'pipe',stderr:'pipe',windowsHide:true});
 let output='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;p.kill();},120000);
 const read=async(stream:ReadableStream<Uint8Array>)=>{for await(const bytes of stream){const part=new TextDecoder().decode(bytes);output+=part;writeFileSync(resolve(dir,`${prefix}.log`),output);process.stdout.write(part);}};await Promise.all([read(p.stdout),read(p.stderr)]);const code=await p.exited;clearTimeout(timer);
 const worker=JSON.parse(output.match(/PRAYER_BANK (.+)$/m)?.[1]??'null'),host=output.match(/^HOST done .+$/m)?.[0]??'',request=JSON.parse(output.match(/^HOST_STOP_REQUEST (.+)$/m)?.[1]??'null');
 const final=await waitPracticeSave(path,v=>!!worker&&v.skills[5]!.rawExperience===Number(worker.buried)*1125&&count(v.inventories[93]??[],526)===0&&count(v.inventories[95]??[],526)===222-Number(worker.buried),{timeoutMs:6000});
 const totals=(v:typeof initial)=>{const m=new Map<number,number>();for(const items of Object.values(v.inventories))for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;},before=totals(initial),after=totals(final.save),debit=(before.get(526)??0)-(after.get(526)??0);
 const assets=[...new Set([...before.keys(),...after.keys()])].every(id=>(after.get(id)??0)===(before.get(id)??0)-(id===526?debit:0));
 const equipment=JSON.stringify(initial.inventories[94]??[])===JSON.stringify(final.save.inventories[94]??[]),skills=final.save.skills.every((s,i)=>i===5?s.rawExperience===1125*debit:s.rawExperience===initial.skills[i]!.rawExperience&&s.level===initial.skills[i]!.level);
 const booths=parseJm2('m41_51.jm2',readFileSync('vendor/rs-sdk/server/content/maps/m41_51.jm2','utf8')).locs.filter(l=>l.id===2213&&l.level===0&&l.x>=2650&&l.x<=2660&&l.z>=3280&&l.z<=3290),atBank=final.save.position.level===0&&booths.some(b=>Math.max(Math.abs(final.save.position.x-b.x),Math.abs(final.save.position.z-b.z))<=1);
 const expectedWorkFailure=code===1&&host.startsWith('HOST done ok=0/1 ')&&output.includes(`[${actor}] RESULT fail mode=prayer` )&&worker?.ok===false&&worker.targetMet===false&&worker.stop==='stop-file';
 const cleanup=!!request&&request.prayerXp>0&&request.heldBones>0&&worker?.heldBones===0&&worker.buried===debit&&worker.consumed===debit&&worker.boneBank===222-debit&&worker.preserved===true&&worker.died===false&&debit>=1&&debit<=13;
 const life=/PROOF_SURVIVAL started=true died=false hpMin=70 finalHp=70/.test(output);
 const ok=expectedWorkFailure&&cleanup&&final.matched&&assets&&equipment&&skills&&atBank&&life&&!timedOut&&output.includes('PROOF_SKILLS_EXACT true')&&output.includes('HOST start bots=1 script=scripts/train-prayer.ts')&&output.includes('LOGOUT logged-out');
 writeFileSync(resolve(dir,`${prefix}-snapshot.json`),JSON.stringify({ok,actor,hostSha256,prayerSha256,harnessSha256:hash(import.meta.path),sourcePath,sourceSnapshotSha256:hash(sourcePath),qualification:'Historical PRE-Prayer Mighty fixture; SINGLE actual runHost entry/custom-onStop bank cleanup. Expected production RESULTfail remains failure. No fresh public prerequisite, multi-actor or memory/scaling claim.',code,worker,host,request,debit,expectedWorkFailure,cleanup,assets,equipment,skills,atBank,life,timedOut,initial,final:final.save},null,2));
 console.log(`PROOF_GATE host-stop ok=${ok} expectedWorkFailure=${expectedWorkFailure} unusedBanked=${cleanup} debit=${debit} assets=${assets}`);process.exitCode=ok?0:1;
}
