import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const {parsePracticeSave}=await import(process.cwd()+'/scripts/measure/fleet-player-save');
const {capabilityRevision}=await import(process.cwd()+'/packages/core/src/worker-release');
const {applyDelta}=await import(process.cwd()+'/packages/core/src/tick-record');
const base=process.argv[2];if(!base)throw Error('bundle directory required');const published=JSON.parse(readFileSync(base+'/../cloud-porksword-magic7-ready.json','utf8'));const raw={source:published.runtimeRevision,account:published.fixtureAccount,code:0,timedOut:false,online:published.engineObservation};const log=readFileSync(base+'/native.log','utf8');
const result=JSON.parse(log.split('\n').find(l=>l.startsWith('MAGIC_ORDER_RESULT '))!.slice('MAGIC_ORDER_RESULT '.length));
const before=parsePracticeSave(readFileSync(base+'/before.sav')),after=parsePracticeSave(readFileSync(base+'/after.sav'));
const count=(s:any,id:number)=>Object.values(s.inventories).flat().filter((i:any)=>i.id===id).reduce((n:number,i:any)=>n+i.count,0);
const tickBytes=readFileSync(base+'/ticks.ndjson.gz');let state:any={},lives=new Set(),dead=false;
for(const line of gunzipSync(tickBytes).toString().trim().split('\n')){const x=JSON.parse(line);if(x.k!=='s'&&x.k!=='p')continue;state=applyDelta(state,x);if(state.player?.lifeId!==undefined)lives.add(state.player.lifeId);dead ||= !!state.player?.isDead;}
const checks={exit:raw.code===0&&!raw.timedOut,worker:result.ok===true,release:raw.source===capabilityRevision(['scripts/magic-order.ts']),savedMagic7:after.skills[6].level===7,baseHP:state.player.maxHp>=11&&state.player.maxHp<=12,combat6:state.player.combatLevel===6,currentHP:after.skills[3].level>=7,otherSkills:before.skills.every((s:any,i:number)=>i===3||i===6||s.rawExperience===after.skills[i].rawExperience),hpXp:after.skills[3].xp-before.skills[3].xp===result.hpXpGained,xp:after.skills[6].xp-before.skills[6].xp===result.magicXpGained,runes:[556,558].every(id=>count(before,id)-count(after,id)===result.casts),coins:count(before,995)===8284&&count(after,995)===8284,assets:[...new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map((i:any)=>i.id))].every(id=>[556,558].includes(id)||count(before,id)===count(after,id)),bank:after.position.level===0&&Math.max(Math.abs(after.position.x-3252),Math.abs(after.position.z-3420))<=3,noDeath:!dead&&lives.size===1,logout:/^LOGOUT logged-out$/m.test(log)&&!raw.online.online&&!raw.online.pendingLogout};
const ok=Object.values(checks).every(Boolean);console.log(JSON.stringify({ok,checks,result,release:raw.source}));process.exitCode=ok?0:1;
