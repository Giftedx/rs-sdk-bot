// Native95FA guard proof: one reserve-only failure, then one real string/full-bank success.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {runBotName} from '../../packages/practice/src/prove';
import {readPracticeSave,waitPracticeSave} from './fleet-player-save';
import {isNoProgressFailure} from '../../packages/practice/src/supervise';
import {parseJm2} from '../../packages/knowledge/src/jm2';
const seersBooths=parseJm2('m42_54.jm2',readFileSync('vendor/rs-sdk/server/content/maps/m42_54.jm2','utf8')).locs.filter(l=>l.id===2213&&l.level===0&&l.x>=2720&&l.x<=2730&&l.z>=3493&&l.z<=3497);
const sourceSha256=createHash('sha256').update(readFileSync('scripts/spin-bowstrings.ts')).digest('hex').toUpperCase();
if(sourceSha256!=='95FA80C3FC05DEFDCF6F8C24A620E809F51DA6B068F4E07A90A52A9A4F73027D'||process.env.REUSE_STACK!=='1')throw new Error('source freeze/existing stack required');
const dir=resolve('.practice/fleet-proof'),results:any[]=[];
const count=(items:{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
for(const [index,raw] of [50,51].entries()){
 const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB']).stdout.toString().trim());if(free<9)throw new Error(`single-bot start needs9GiB actual${free}`);
 const actor=runBotName('flguard',index+1),prefix=`spin-guard-${raw}-${actor}`;await createBot(actor);
 const path=await applyPreset(actor,{position:{x:2727,z:3492,level:0},skills:{Crafting:80},inventory:[{id:1735,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:1779,count:raw},{id:1777,count:7},{id:995,count:170},{id:1737,count:40},{id:1759,count:25}]});
 const initial=readPracticeSave(path);console.log(`PROOF_START actor=${actor} raw=${raw} freeGiB=${free} source=${sourceSha256}`);
 const p=Bun.spawn(['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),resolve('scripts/spin-bowstrings.ts'),actor],{env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',MAX_MAKE:'1',RAW_RESERVE:'50',MAX_TRIPS:'4',CAP:'300'},stdout:'pipe',stderr:'pipe'});let output='';const timer=setTimeout(()=>p.kill(),150000);
 const read=async(stream:ReadableStream<Uint8Array>)=>{for await(const b of stream){const part=new TextDecoder().decode(b);output+=part;writeFileSync(resolve(dir,`${prefix}.log`),output);process.stdout.write(part);}};
 await Promise.all([read(p.stdout),read(p.stderr)]);const exitCode=await p.exited;clearTimeout(timer);
 const result=JSON.parse(output.match(/^SPIN_BANK (.+)$/m)?.[1]??'null'),made=raw-50;
 const final=await waitPracticeSave(path,s=>count(s.inventories[95]??[],1779)===50&&count(s.inventories[95]??[],1777)===7+made&&s.skills[12]!.xp===initial.skills[12]!.xp+made*375);
 const totals=(s:typeof initial)=>{const m=new Map<number,number>();for(const items of Object.values(s.inventories))for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};const before=totals(initial),after=totals(final.save);
 const assets=[...new Set([...before.keys(),...after.keys()])].every(id=>(after.get(id)??0)===(before.get(id)??0)+(id===1779?-made:id===1777?made:0));
 const finalResult=output.split(/\r?\n/).filter(l=>l.startsWith('RESULT ')).at(-1)??'',noProgress=isNoProgressFailure(finalResult);
 const resultGate=raw===50?exitCode!==0&&/^RESULT fail .*no spinning progress: bank flax at reserve/.test(finalResult)&&(output.match(/^RESULT fail /gm)??[]).length===1&&noProgress&&result?.stop==='input-wait'&&!result?.ok:exitCode===0&&/^RESULT ok /m.test(output)&&!noProgress&&result?.ok&&result.targetMet;
 const life=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(output),atBank=final.save.position.level===0&&seersBooths.some(b=>Math.max(Math.abs(final.save.position.x-b.x),Math.abs(final.save.position.z-b.z))<=1);
 const ok=final.matched&&resultGate&&assets&&life&&atBank&&result.made===made&&result.spunTotal===made&&result.rawBank===50&&result.xpGain===made*375&&count(final.save.inventories[93]??[],1777)===0&&output.includes('LOGOUT logged-out');
 const report={ok,actor,raw,sourceSha256,result,exitCode,finalResult,noProgress,assets,life,atBank,initial,final:final.save};results.push(report);writeFileSync(resolve(dir,`${prefix}-snapshot.json`),JSON.stringify(report,null,2));console.log(`PROOF_GATE spin-guard raw=${raw} expectedMade=${made} noProgress=${noProgress} assets=${assets} ok=${ok}`);
 if(!ok)break;
}
writeFileSync(resolve(dir,'spin-guard-report.json'),JSON.stringify({ok:results.length===2&&results.every(r=>r.ok),sourceSha256,results},null,2));process.exitCode=results.length===2&&results.every(r=>r.ok)?0:1;
