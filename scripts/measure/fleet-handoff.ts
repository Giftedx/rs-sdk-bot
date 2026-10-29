// Local two-account integration proof of the production handoff CLI.
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {runBotName} from '../../packages/practice/src/prove';
import {ownedAccounts} from '../../packages/core/src/tradeguard';
import {readPracticeSave,waitPracticeSave} from './fleet-player-save';
const dir=resolve('.practice/fleet-proof');
const donor=runBotName('flgive',1),receiver=runBotName('fltake',1);
const prefix=`handoff-${donor}-${receiver}`;
const expected:Record<string,string>={'scripts/handoff-inputs.ts':'4E39760FDA04B872DFED71AA2CF5E914CEA78BF667DE365F1988591B92A7E80A','scripts/banker.ts':'1F100799D028BA40FD0F60FF1390122E82DA65A8C5E8CBACD026ED927D92E718'};
const hashes=Object.fromEntries(Object.keys(expected).map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase()]));
if(Object.entries(expected).some(([p,h])=>hashes[p]!==h))throw new Error('production hash changed');
if(process.env.REUSE_STACK!=='1')throw new Error('existing local stack required');
if(existsSync('.practice/withdraw')&&readdirSync('.practice/withdraw').some(f=>f.endsWith('.json')))throw new Error('another payout request pending; owner must resolve');
const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB'],{windowsHide:true}).stdout.toString().trim());
if(free<11)throw new Error(`two-account reservation needs11GiB; free=${free}`);
console.log(`PROOF_RESOURCE freeGiB=${free} donor=${donor} receiver=${receiver}`);
const initial:Record<string,ReturnType<typeof readPracticeSave>>={};
const paths:Record<string,string>={};
const count=(items:{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
async function child(args:string[],label:string,timeout=60000){
 const p=Bun.spawn(['bun',...args],{env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0'},stdout:'pipe',stderr:'pipe',windowsHide:true});
 const timer=setTimeout(()=>p.kill(),timeout);let out='';
 const read=async(stream:ReadableStream<Uint8Array>,channel:string)=>{for await(const b of stream){const part=new TextDecoder().decode(b);out+=part;writeFileSync(resolve(dir,`${prefix}-${label}.log`),out);process.stdout.write(`[${label}:${channel}] ${part}`);}};
 await Promise.all([read(p.stdout,'out'),read(p.stderr,'err')]);const exitCode=await p.exited;clearTimeout(timer);return{out,exitCode};
}
for(const name of [donor,receiver]){
 await createBot(name);
 paths[name]=await applyPreset(name,{position:{x:2727,z:3492,level:0},coins:200,inventory:[{id:1735,count:1},{id:315,count:1},{id:2309,count:1}],bank:name===donor?[{id:1779,count:153}]:[]});
 initial[name]=readPracticeSave(paths[name]!);
 const pre=await child(['--preload',resolve('scripts/measure/fleet-observe.ts'),resolve('scripts/measure/fleet-bank-inspect.ts'),name],`auth-${name}`);
 if(pre.exitCode!==0||!pre.out.includes('LOGOUT logged-out')||!ownedAccounts('localhost:8888').has(name.toLowerCase()))throw new Error(`authenticated ownership preflight failed ${name}`);
}
console.log(`PROOF_HANDOFF_START donor=${donor} receiver=${receiver}`);
const hpSamples:Record<string,number[]>={[donor]:[],[receiver]:[]};
const meter=setInterval(()=>{for(const name of [donor,receiver])try{const s=JSON.parse(readFileSync(resolve('.practice/status',`${name}.json`),'utf8'));if(s.hp?.now>0)hpSamples[name]!.push(s.hp.now);}catch{}},200);
const run=await child([resolve('scripts/handoff-inputs.ts'),donor,receiver,'153:Flax','--notes','--keep=^(Shears|Knife|Trout|Salmon|Bread|Shrimps|Coins)$','--bank-x=2727','--bank-z=3492'],'production',300000);
clearInterval(meter);
const d=await waitPracticeSave(paths[donor]!,s=>count(s.inventories[95]??[],1779)===0,{timeoutMs:6000});
const r=await waitPracticeSave(paths[receiver]!,s=>count(s.inventories[93]??[],1780)===153,{timeoutMs:6000});
const assets=(s:ReturnType<typeof readPracticeSave>)=>{const m=new Map<number,number>();for(const items of Object.values(s.inventories))for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
const preserved=[donor,receiver].every(name=>{const a=assets(initial[name]!),b=assets(name===donor?d.save:r.save);return [...a].filter(([id])=>id!==1779).every(([id,n])=>b.get(id)===n);});
const survival=[donor,receiver].every(name=>{const s=JSON.parse(readFileSync(resolve('.practice/status',`${name}.json`),'utf8'));return s.hp.now===10&&s.hp.max===10&&typeof s.result==='string'&&s.result.startsWith('ok ');});
const hpStable=Object.values(hpSamples).every(v=>v.length>0&&v.every(h=>h===10));
const logout=(run.out.match(/LOGOUT logged-out/g)??[]).length===2;
const ok=hpStable&&logout&&run.exitCode===0&&/HANDOFF_RESULT.*"ok":true/.test(run.out)&&d.matched&&r.matched&&preserved&&survival&&count(d.save.inventories[93]??[],1780)===0&&count(r.save.inventories[95]??[],1779)===0;
writeFileSync(resolve(dir,`${prefix}-snapshot.json`),JSON.stringify({ok,donor,receiver,hashes,initial,final:{donor:d.save,receiver:r.save},publication:{donor:d.matched,receiver:r.matched},preserved,survival,hpSamples,hpStable,logout,exitCode:run.exitCode},null,2));
console.log(`PROOF_GATE handoff ok=${ok} exactNotes=${count(r.save.inventories[93]??[],1780)} preserved=${preserved} survival=${survival}`);
process.exitCode=ok?0:1;
