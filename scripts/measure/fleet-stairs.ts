// Local integration proof for Lumbridge stair publication races. One bot at a time.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {openBot,finish,getWorld,accountOf} from '../../packages/core/src/bot';
import {goTo} from '../../packages/core/src/walk';
import {waitTicks} from '../../packages/core/src/ticks';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {proveInProcess,realInProcessDeps} from '../../packages/practice/src/prove';
import {startStack} from '../../packages/practice/src/stack';

if(process.argv[2]) {
 const s=await openBot(process.argv[2]);
 try {
  await waitTicks(s,3); const t0=s.tick(); let last=s.sdk.getState()!.player!.level;
  const off=s.onTick(()=>{const p=s.sdk.getState()?.player;if(p && p.level!==last){console.log(`STAIRS floor=${last}->${p.level} at=${p.worldX},${p.worldZ} t=${s.tick()-t0}`);last=p.level;}});
  const r=await goTo(s,await getWorld(),{x:3218,z:3256,level:0},accountOf(s),{legTimeoutTicks:100});
  off(); const p=s.sdk.getState()!.player!;
  console.log(`STAIRS reply=${JSON.stringify(r)} pos=${p.worldX},${p.worldZ},${p.level}`);
  await finish([s],r.ok && p.level===0 && Math.max(Math.abs(p.worldX-3218),Math.abs(p.worldZ-3256))<=2,`stairs ticks=${s.tick()-t0} level=${p.level}`);
 } catch(e) {await finish([s],false,String(e));}
} else {
 const starts=[{x:3209,z:3220,level:2},{x:3205,z:3228,level:1},{x:3207,z:3218,level:2}];
 const dir=resolve('.practice/fleet-proof');mkdirSync(dir,{recursive:true});let next=0;
 const stack=await startStack({tickMs:400});
 try {
  const report=await proveInProcess({bot:'ballstairs',script:import.meta.path,runs:3,timeoutMs:120000,pass:t=>/^RESULT ok stairs.*level=0/m.test(t)}, {
   ...realInProcessDeps,
   async prepare(name){const mon=JSON.parse(readFileSync('.practice/monitor.json','utf8'));if(mon.freeGB<8 || mon.practiceBots>=6)throw new Error('practice load gate');await createBot(name);await applyPreset(name,{position:starts[next++]!,inventory:[{id:1735,count:1}]});},
   async run(script,bot,timeoutMs){
    const p=Bun.spawn(['bun',script,bot],{stdout:'pipe',stderr:'pipe',env:{...process.env,DEMO_OK:''},windowsHide:true});const timer=setTimeout(()=>p.kill(),timeoutMs);
    const [out,err]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);const exitCode=await p.exited;clearTimeout(timer);const stdout=(out+err).replace(/^.*PASSWORD.*$/gm,'[redacted]');
    writeFileSync(resolve(dir,`stairs-${bot}.log`),stdout);console.log(stdout.split(/\r?\n/).filter(l=>/^(START|STAIRS|RESULT|LEDGER)/.test(l)).join('\n'));return{stdout,exitCode};
   },
  });
  const hashes=Object.fromEntries(['packages/core/src/walk.ts','packages/core/src/act.ts','scripts/collect-wool.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
  writeFileSync(resolve(dir,'stairs-report.json'),JSON.stringify({...report,starts,tickMs:400,hashes},null,2));console.log(JSON.stringify(report));process.exitCode=report.passes===3?0:1;
 } finally {await stack.stop();}
}
