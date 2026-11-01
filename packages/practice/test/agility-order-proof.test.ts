import {test,expect} from 'bun:test';
import {createSaveData} from '../../../vendor/rs-sdk/sdk/test/utils/save-generator';
import {afterAll} from 'bun:test';
import {readFileSync,writeFileSync,mkdtempSync,unlinkSync,rmdirSync,rmSync,readdirSync,copyFileSync,cpSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {workerSourceRevision} from '../../core/src/worker-release';
import {verify,verificationReport,sources,foodRecoveryChecks,verifyFoodRecovery,FOOD_RECOVERY_CONFIGURATION,restartInitialProjection} from '../src/agility-order-proof';
import {INFLIGHT_FOOD_CONFIGURATION,inflightFoodChecks,inflightFoodOutcome,verifyInflightFood} from '../src/agility-order-proof';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {readPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {agilityInitializationChecks,retainedApproachChecks} from '../src/agility-order-proof';
import {agilitySaveChecks,childChecks,trainedLevel,fallRecoveryCheck,savedCoursePosition,agilityFixturePreset,agilitySaveDifferences,interruptionSaveChecks,interruptionDeadlineMs,draynorEntryChecks} from '../src/agility-order-proof';
import {strongholdGateCrossed,femiGateVarp} from '../src/agility-order-proof';
import {FALL_SAMPLE_PLAN,INITIALIZATION_CONFIGURATION,initializationEvidenceChecks,NATIVE_FORMAT,fallSampleAdmitted,fallSampleChecks,fallSampleOutcome,zeroFallObserved,sampleFalls,verifyFallSamples,readFallSamples,type FallSample,type FallFiles} from '../src/agility-order-proof';
import {statSync,mkdirSync} from 'node:fs';
import {verifyGnome,verifyGnomeFood,verifyArdougneEntry,verifyGnomeConsumer,verifyDraynorEvidence,verifyRetainedApproachEvidence,gnomeScope,sharedSettlementChecks,
 gnomeFoodChecks,ardougneEntryChecks,healSequence,GNOME_STEPS,GNOME_SCOPE,GNOME_FOOD_CONFIGURATION,ARDOUGNE_CONFIGURATION,ARDOUGNE_ENTRY_CONFIGURATION,
 GNOME_CONSUMER_CONFIGURATION,GNOME_CONSUMER_PLAN,GNOME_FOOD_RESTART_CONFIGURATION,DRAYNOR_START} from '../src/agility-order-proof';
import {PRESETS} from '../src/presets';
import {COURSES} from '../../../scripts/agility-order';

// Synthetic unit evidence only. These bytes cannot be a native delivery receipt.
let recoveryTestSource:ReturnType<typeof sources>|undefined;
function recoveryUnitBundle(){
 const C=FOOD_RECOVERY_CONFIGURATION,dir=mkdtempSync(join(tmpdir(),'agility-food-unit-')),name='unitagi10';
 const source=recoveryTestSource??=sources(),child={code:0,timedOut:false,interrupted:false};
 const crc=(b:Buffer)=>{b.writeUInt32BE(Bun.hash.crc32(b.subarray(0,-4))>>>0,b.length-4);return b;};
 const raw=Buffer.from(createSaveData(agilityFixturePreset({position:C.position,skills:{Hitpoints:70},
  inventory:Array.from({length:5},()=>({id:379,count:1})),bank:[{id:995,count:12345},{id:1511,count:13}],
  equipment:[{id:1351,count:1,slot:3}],varps:{134:10}})));
 raw[47]=10;crc(raw);
 // Convert only the variable storage to the pinned v9 sparse format.
 const v9=(input:Buffer)=>{
  const count=input.readUInt16BE(133),entries:Buffer[]=[];
  for(let id=0;id<count;id++){
   let value=input.readInt32BE(135+id*4)>>>0;if(!value)continue;
   const bytes=[value&127];while((value>>>=7)>0)bytes.unshift((value&127)|128);
   const entry=Buffer.alloc(2);entry.writeUInt16BE(id);entries.push(Buffer.concat([entry,Buffer.from(bytes)]));
  }
  const n=Buffer.alloc(2);n.writeUInt16BE(entries.length);
  const out=Buffer.concat([input.subarray(0,133),n,...entries,input.subarray(135+count*4)]);out.writeUInt16BE(9,2);return crc(out);
 };
 const initialRaw=Buffer.from(raw);initialRaw.writeInt32BE(9,135+134*4);
 writeFileSync(join(dir,'initial-10-before.sav'),crc(initialRaw));writeFileSync(join(dir,'initial-10-after.sav'),v9(raw));
 copyFileSync(join(dir,'initial-10-after.sav'),join(dir,'food-before.sav'));
 let final=Buffer.from(raw);final[47]=46;final.writeInt32BE(1000,108);final[112]=2;final.writeInt32BE(11,135+134*4);
 for(const entry of savedFields(final).entries.filter(e=>e.inv===93&&e.slot<3).reverse()){
  final=Buffer.concat([final.subarray(0,entry.start),Buffer.from([0,0]),final.subarray(entry.end)]);
 }
 writeFileSync(join(dir,'food-after.sav'),v9(crc(final)));
 const before=readPracticeSave(join(dir,'food-before.sav')),after=readPracticeSave(join(dir,'food-after.sav'));
 const events:any[]=[];let inventory=structuredClone(before.inventories[93]!);
 for(let i=0;i<3;i++){
  const at=10+i*4,sequence=i+1,hp=10+i*12;
  if(i)events.push({event:'cooldown',sequence,tick:at-3,lastEffectTick:at-3,readyAfter:at-1});
  const d={sequence,slot:i,id:379,held:5-i,tick:at,hp,baseHp:70,xp:0,count:5-i,inventory:structuredClone(inventory),anim:-1,dialog:null,rejected:0,messages:[]};
  events.push({event:'dispatch',...d},{event:'reply',...d,reply:{success:true}},{event:'observation',...d});
  inventory=inventory.filter(item=>item.slot!==i);
  const effect={...d,tick:at+1,hp:hp+12,count:4-i,inventory:structuredClone(inventory),anim:829,messages:[{tick:at+1,text:'You eat the lobster.'}]};
  events.push({event:'observation',...effect},{event:'effect',...effect,hpTick:at+1,inventoryTick:at+1});
 }
 const log=events.map(e=>'AGILITY_FOOD '+JSON.stringify(e)).join('\n')+'\nAGILITY_PROGRESS level=2 xp=100 tick=24 step=log\n'
  +'AGILITY_ORDER_RESULT '+JSON.stringify({ok:true,course:'gnome',target:2,level:2,xpGained:100,eats:3})
  +'\nRESULT ok agility\nLEDGER ticks=24 bot='+name+'\nLOGOUT logged-out\n';
 writeFileSync(join(dir,'food.log'),log);
 const initLog='RESULT fail Error: already at target\nLEDGER ticks=1 bot='+name+'\nLOGOUT logged-out\n';
 writeFileSync(join(dir,'initial-10.log'),initLog);
 const initChild={code:1,timedOut:false,interrupted:false};
 const initial=bindInitialization(dir,10,name,source);
 writeFileSync(join(dir,'initial-10.json'),JSON.stringify({name,index:10,child:initChild,binding:initial,
  checks:initializationEvidenceChecks(readPracticeSave(join(dir,'initial-10-before.sav')),before,initLog,initChild,name)}));
 const hashes=()=>({before:digest(readFileSync(join(dir,'food-before.sav'))),after:digest(readFileSync(join(dir,'food-after.sav'))),log:digest(readFileSync(join(dir,'food.log')))});
 const meta:any={name,source,child,configuration:C,binding:{name,source,child,configuration:C,sha256:hashes(),initialization:initial}};
 // Labelled in-flight sample: ordinary Wilderness fixture 11 at HP 36/70, a natural fall, a settled
 // obstacle, one exact eat with no other packet or refusal, then later XP to the target.
 const I=INFLIGHT_FOOD_CONFIGURATION,iname='unitagi11';
 const minXp=(level:number)=>{let lo=0,hi=2e8;while(lo<hi){const m=Math.floor((lo+hi)/2);if(trainedLevel(m)>=level)hi=m;else lo=m+1;}return lo;};
 const xp52=minXp(52),xp70=minXp(70);
 const wraw=Buffer.from(createSaveData(agilityFixturePreset({position:I.position,skills:{Hitpoints:70},
  inventory:Array.from({length:15},()=>({id:379,count:1})),bank:[{id:995,count:12345},{id:1511,count:13}],
  equipment:[{id:1351,count:1,slot:3}],varps:{134:10}})));
 wraw.writeInt32BE(xp52*10,108);wraw[112]=52;wraw[47]=I.currentHp;crc(wraw);
 const winit=Buffer.from(wraw);winit.writeInt32BE(9,135+134*4);
 writeFileSync(join(dir,'initial-11-before.sav'),crc(winit));writeFileSync(join(dir,'initial-11-after.sav'),v9(wraw));
 copyFileSync(join(dir,'initial-11-after.sav'),join(dir,'inflight-1-before.sav'));
 let wfinal=Buffer.from(wraw);wfinal[47]=42;wfinal.writeInt32BE(xp70*10,108);wfinal[112]=70;
 wfinal.writeUInt16BE(2996,4);wfinal.writeUInt16BE(3960,6);wfinal.writeInt32BE(11,135+134*4);
 for(const entry of savedFields(wfinal).entries.filter(e=>e.inv===93&&e.slot<1).reverse()){
  wfinal=Buffer.concat([wfinal.subarray(0,entry.start),Buffer.from([0,0]),wfinal.subarray(entry.end)]);
 }
 writeFileSync(join(dir,'inflight-1-after.sav'),v9(crc(wfinal)));
 const ibefore=readPracticeSave(join(dir,'inflight-1-before.sav')),iafter=readPracticeSave(join(dir,'inflight-1-after.sav'));
 const x1=xp52+325,d={sequence:1,slot:0,id:379,held:15,tick:36,hp:30,baseHp:70,xp:x1,count:15,inventory:structuredClone(ibefore.inventories[93]),anim:-1,dialog:null,rejected:0,ops:0,workerOps:1,at:'2996,3960,0',messages:[]};
 const e={...d,tick:38,hp:42,count:14,inventory:structuredClone(iafter.inventories[93]),ops:1,workerOps:2,messages:[{tick:38,text:'You eat the lobster.'}]};
 const actionSamples=Array.from({length:17},(_,i)=>({tick:20+i,at:i===0?'3005,3962,0':i<7?'3002,3960,0':i===7?'3001,3960,0':i===8?'3000,3960,0':i===9?'2999,3960,0':'2996,3960,0',
  anim:i>0&&i<10&&i%2===1?741:-1,rejected:Math.min(5,Math.floor((i+1)/2)),mapFlags:Math.min(5,Math.floor((i+1)/2)),hp:i<7?40:30,xp:i<10?x1-200:x1,ops:1,
  messages:i===0?[]:[{tick:21,text:'You carefully start crossing the stepping stones...'}]}));
 const actions:any[]=[{event:'dispatch',...actionSamples[0],step:'stones',locId:2311,x:3001,z:3960,speculative:false,actionId:1},
  ...actionSamples.slice(1).map(v=>({event:'observation',...v,actionId:1}))];
 const ievents:any[]=[
  {event:'settle',sequence:1,step:'stones',actionId:1,dispatchTick:20,dispatchAt:'3005,3962,0',start:27,tick:36,quiet:6,fallTick:27,rejected:5,opsSinceDispatch:0,opsWhileSettling:0,
   observations:actionSamples,marks:actionSamples.slice(7),settled:true},
  {event:'dispatch',...d},{event:'reply',...d,ops:1,workerOps:2,reply:{success:true,phase:'dispatch'}},{event:'observation',...d,ops:1,workerOps:2},
  {event:'observation',...e},{event:'effect',...e,hpTick:38,inventoryTick:38}];
 const ilog=`AGILITY_PROGRESS level=52 xp=${x1-200} tick=15 step=pipe\nAGILITY_RECOVERY fall tick=19 step=log hp=40 at=2998,10346 xp=${x1-200}\n`
  +actions.map(v=>'AGILITY_ACTION '+JSON.stringify(v)).join('\n')+'\n'
  +ievents.map(v=>'AGILITY_FOOD '+JSON.stringify(v)+(v.event==='dispatch'?'\nAGILITY_ACTION '+JSON.stringify({event:'food',tick:36,ops:2,sequence:1,slot:0,id:379}):'')).join('\n')
  +`\nAGILITY_RECOVERY pit tick=45 at=3005,3962\nAGILITY_PROGRESS level=70 xp=${xp70} tick=60 step=stones\n`
  +'AGILITY_ORDER_RESULT '+JSON.stringify({ok:true,course:'wilderness',target:I.target,level:70,xpGained:xp70-xp52,eats:1,finalHp:42})
  +'\nRESULT ok agility\nLEDGER ticks=60 bot='+iname+'\nLOGOUT logged-out\n';
 writeFileSync(join(dir,'inflight-1.log'),ilog);
 writeFileSync(join(dir,'initial-11.log'),'RESULT fail Error: already at target\nLEDGER ticks=1 bot='+iname+'\nLOGOUT logged-out\n');
 const iinit=bindInitialization(dir,11,iname,source);
 writeFileSync(join(dir,'initial-11.json'),JSON.stringify({name:iname,index:11,child:initChild,binding:iinit,
  checks:initializationEvidenceChecks(readPracticeSave(join(dir,'initial-11-before.sav')),ibefore,readFileSync(join(dir,'initial-11.log'),'utf8'),initChild,iname)}));
 const ihashes=()=>({before:digest(readFileSync(join(dir,'inflight-1-before.sav'))),after:digest(readFileSync(join(dir,'inflight-1-after.sav'))),log:digest(readFileSync(join(dir,'inflight-1.log')))});
 const imeta:any={configuration:I,source,samples:[{index:1,fixture:11,label:'inflight-1',name:iname,child:structuredClone(child),sha256:ihashes(),initialization:iinit,outcome:'proved'}]};
 const rebind=()=>{
  if(imeta.samples[0])imeta.samples[0].sha256=ihashes();writeFileSync(join(dir,'inflight.json'),JSON.stringify(imeta));
  meta.binding.sha256=hashes();writeFileSync(join(dir,'food-recovery.json'),JSON.stringify(meta));
  const checks=verifyFoodRecovery(dir,source,false);
  writeFileSync(join(dir,'consumer.json'),JSON.stringify({ok:true,name,source,configuration:C,binding:meta.binding,checks}));
 };
 rebind();return{dir,name,source,child,before,after,events,log,meta,rebind,ibefore,iafter,ievents,ilog,iname,imeta};
}

test('consecutive heal proof independently reconciles three debits, heals, cooldowns and later XP',()=>{
 const f=recoveryUnitBundle();try{
  expect(Object.entries(foodRecoveryChecks(f.before,f.after,f.log,f.child,f.name)).filter(([,v])=>!v)).toEqual([]);
  expect(Object.entries(JSON.parse(readFileSync(join(f.dir,'initial-10.json'),'utf8')).checks).filter(([,v])=>!v)).toEqual([]);
  expect(Object.entries(verifyFoodRecovery(f.dir)).filter(([,v])=>!v)).toEqual([]);
  // Raw synthetic unit evidence is never added to a product delivery folder.
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

test('food proof rejects zero/one heal, duplicate or dropped consumption, bad cooldown and unresolved effects',()=>{
 const f=recoveryUnitBundle();try{
  const rejects=(edit:(e:any[])=>any[],suffix=f.log.slice(f.log.indexOf('AGILITY_PROGRESS ')))=>{
   const log=edit(structuredClone(f.events)).map(e=>'AGILITY_FOOD '+JSON.stringify(e)).join('\n')+'\n'+suffix;
   expect(Object.values(foodRecoveryChecks(f.before,f.after,log,f.child,f.name)).every(Boolean)).toBe(false);
  };
  rejects(()=>[]);rejects(e=>e.filter(v=>v.sequence===1));
  rejects(e=>[...e,e[0]]);rejects(e=>e.filter(v=>v.event!=='effect'));
  rejects(e=>e.filter(v=>v.event!=='cooldown'));
  rejects(e=>{e.find(v=>v.sequence===2&&v.event==='dispatch').tick=13;return e;});
  rejects(e=>{e.find(v=>v.sequence===2&&v.event==='cooldown').lastEffectTick--;return e;});
  rejects(e=>{e.find(v=>v.event==='reply').reply.success=false;return e;});
  rejects(e=>{e.find(v=>v.event==='effect').hpTick+=9;return e;});
  rejects(e=>{e.find(v=>v.event==='effect').hp=10;return e;});
  rejects(e=>{e.find(v=>v.event==='effect').count--;return e;});
  rejects(e=>{delete e[0].inventory;return e;});
  rejects(e=>e,f.log.slice(f.log.indexOf('AGILITY_PROGRESS ')).replace('"eats":3','"eats":0'));
  for(const text of ['LOGOUT logged-out','AGILITY_PROGRESS level=2 xp=100 tick=24 step=log']){
   expect(Object.values(foodRecoveryChecks(f.before,f.after,f.log.replace(text,''),f.child,f.name)).every(Boolean)).toBe(false);
  }
  for(const edit of [(s:Save)=>{s.skills[3]!.level--;},(s:Save)=>{s.inventories[93]!.pop();},
   (s:Save)=>{s.skills[0]!.rawExperience++;},(s:Save)=>{s.skills[0]!.level++;},(s:Save)=>{s.inventories[95]![0]!.slot++;}]){
   const after=structuredClone(f.after);edit(after);expect(Object.values(foodRecoveryChecks(f.before,after,f.log,f.child,f.name)).every(Boolean)).toBe(false);
  }
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

test('food verifier rejects missing/CRC-invalid files, source/account/configuration substitutions and rehashed raw lies',()=>{
 const attacks:((f:ReturnType<typeof recoveryUnitBundle>)=>void)[]=[
  ...['food-before.sav','food-after.sav','food.log','consumer.json','initial-10-before.sav','initial-10-after.sav','initial-10.log','initial-10.json'].map(p=>(f:ReturnType<typeof recoveryUnitBundle>)=>unlinkSync(join(f.dir,p))),
  f=>mutateSave(join(f.dir,'food-after.sav'),b=>b[47]=45,false),
  f=>{f.meta.source={runtime:'foreign'};f.rebind();},
  f=>{f.meta.name='foreign10';f.rebind();},
  f=>{f.meta.configuration={...FOOD_RECOVERY_CONFIGURATION,target:10};f.rebind();},
  f=>{f.meta.child.timedOut=true;f.rebind();},
  f=>{writeFileSync(join(f.dir,'food.log'),f.log.replace('"eats":3','"eats":0'));f.rebind();},
  f=>{writeFileSync(join(f.dir,'food.log'),f.log.split('\n').filter(l=>!l.includes('"event":"cooldown"')).join('\n'));f.rebind();},
  f=>{mutateSave(join(f.dir,'food-after.sav'),b=>b[47]=45);f.rebind();},
  f=>{mutateSave(join(f.dir,'food-before.sav'),b=>b[47]=11);f.rebind();},
  f=>{writeFileSync(join(f.dir,'food.log'),f.log.replace('LOGOUT logged-out',''));f.rebind();},
  f=>{writeFileSync(join(f.dir,'food.log'),f.log+'\n');},
 ];
 for(const [i,attack] of attacks.entries()){
  const f=recoveryUnitBundle();try{attack(f);expect(Object.values(verifyFoodRecovery(f.dir,f.source)).every(Boolean),String(i)).toBe(false);}
  finally{rmSync(f.dir,{recursive:true,force:true});}
 }
});
test('in-flight food proof recomputes fall, settled obstacle, one isolated heal, debit, later XP and logout',()=>{
 const f=recoveryUnitBundle();try{
  const checks=inflightFoodChecks(f.ibefore,f.iafter,f.ilog,f.child,f.iname);
  expect(Object.entries(checks).filter(([,v])=>!v)).toEqual([]);
  expect(inflightFoodOutcome(checks,f.ibefore,f.iafter,f.ilog)).toBe('proved');
  expect(Object.entries(verifyInflightFood(f.dir,f.source)).filter(([,v])=>!v)).toEqual([]);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

test('settlement flags cannot certify contradictory or incomplete quiet observations',()=>{
 const f=recoveryUnitBundle();try{
  for(const marks of [[],[{tick:31,at:'1,1,3',anim:741,rejected:999,hp:1,xp:0}]]){
   const log=f.ilog.split('\n').map(l=>{
    if(!l.startsWith('AGILITY_FOOD '))return l;
    const v=JSON.parse(l.slice(13));if(v.event==='settle')v.marks=marks;
    return 'AGILITY_FOOD '+JSON.stringify(v);
   }).join('\n');
   expect(inflightFoodChecks(f.ibefore,f.iafter,log,f.child,f.iname).settled).toBe(false);
  }
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('in-flight food proof rejects unsettled, transient, attributed-packet, zero-effect and misordered evidence',()=>{
 const f=recoveryUnitBundle();try{
  const head=f.ilog.slice(0,f.ilog.indexOf('AGILITY_FOOD ')),tail=f.ilog.slice(f.ilog.indexOf('\nAGILITY_RECOVERY pit'));
  const rejects=(edit:(e:any[])=>any[],label:string,suffix=tail,prefix=head)=>{
   const log=prefix+edit(structuredClone(f.ievents)).map(e=>'AGILITY_FOOD '+JSON.stringify(e)
    +(e.event==='dispatch'?'\nAGILITY_ACTION '+JSON.stringify({event:'food',tick:e.tick,ops:e.workerOps+1,sequence:e.sequence,slot:e.slot,id:e.id}):'')).join('\n')+suffix;
   const c=inflightFoodChecks(f.ibefore,f.iafter,log,f.child,f.iname);
   expect(Object.values(c).every(Boolean),label).toBe(false);
   expect(inflightFoodOutcome(c,f.ibefore,f.iafter,log),label).toBe('failed');
  };
  rejects(e=>e.filter(v=>v.event!=='settle'),'no settle');
  rejects(e=>{e[0].settled=false;return e;},'unsettled');
  rejects(e=>{e[0].quiet=1;return e;},'one transient quiet tick');
  rejects(e=>{e[0].opsWhileSettling=1;return e;},'packet while settling');
  rejects(e=>{e[0].tick=40;return e;},'settled after dispatch');
  rejects(e=>{e[0].dispatchTick=32;return e;},'no obstacle pending before recovery');
  rejects(e=>{e[0].marks=e[0].marks.slice(0,1);return e;},'fabricated settled true and quiet six');
  rejects(e=>{e[0].marks.splice(3,1);return e;},'missing quiet tick');
  rejects(e=>{e[0].marks[3].tick--;return e;},'duplicate tick');
  rejects(e=>{e[0].marks.at(-1).rejected++;return e;},'new exactmove feedback inside quiet window');
  rejects(e=>{e[0].marks[3].rejected=0;return e;},'rejection counter goes backwards');
  rejects(e=>{e[0].marks.at(-1).anim=741;return e;},'active animation inside quiet window');
  rejects(e=>{e[0].marks.at(-1).at='2997,3960,0';return e;},'moving terminal position');
  rejects(e=>{e[0].marks[3].ops++;return e;},'intervening worker packet');
  rejects(e=>{e[0].step='log';return e;},'speculative log replaces stones identity');
  rejects(e=>{delete e[0].observations;return e;},'missing action observations');
  rejects(e=>{delete e[0].marks[3].mapFlags;return e;},'unknown exactmove feedback');
  rejects(e=>[e[1],e[0],...e.slice(2)],'food before settlement');
  rejects(e=>{for(const v of e.slice(3))v.ops=2;return e;},'obstacle click inside food window');
  rejects(e=>{e[4].rejected=1;return e;},'refusal inside food window');
  rejects(e=>{e[2].rejected=1;return e;},'reply rejection cannot disappear before effect');
  rejects(e=>{for(const v of e.slice(4)){v.hp=30;v.count=15;}return e;},'zero effect');
  rejects(e=>{e[5].hp=41;return e;},'inexact heal');
  rejects(e=>{e[5].tick=50;return e;},'effect past the eight-tick bound');
  rejects(e=>{e[2].reply.success=false;return e;},'refused reply');
  rejects(e=>{e[1].hp=40;e[2].hp=40;e[3].hp=40;return e;},'eat above the HP floor');
  rejects(e=>e,'fall after the eat',tail,head.replace('fall tick=19','fall tick=39'));
  rejects(e=>e,'no fall',tail,head.replace(/AGILITY_RECOVERY fall[^\n]*\n/,''));
  rejects(e=>e,'no later XP',tail.replace(/AGILITY_PROGRESS level=70[^\n]*\n/,''));
  rejects(e=>e,'missing logout',tail.replace('LOGOUT logged-out',''));
  rejects(e=>e,'eat count lie',tail.replace('"eats":1','"eats":2'));
  rejects(e=>e,'saved HP mismatch',tail.replace('"finalHp":42','"finalHp":43'));
  for(const [label,edit] of [
   ['missing action dispatch',(v:any[])=>v.filter(a=>a.event!=='dispatch')],
   ['speculative log identity',(v:any[])=>{v[0].step='log';v[0].locId=2297;v[0].speculative=true;return v;}],
   ['no observed start',(v:any[])=>{for(const a of v)a.messages=[];return v;}],
   ['missing action tick',(v:any[])=>v.filter(a=>a.tick!==25)],
  ] as const){
   const acts=head.split('\n').filter(l=>l.startsWith('AGILITY_ACTION ')).map(l=>JSON.parse(l.slice(15)));
   const prefix=head.split('\n').filter(l=>!l.startsWith('AGILITY_ACTION ')).join('\n')
    +edit(acts).map(a=>'AGILITY_ACTION '+JSON.stringify(a)).join('\n')+'\n';
   rejects(e=>e,label,tail,prefix);
  }
  for(const [label,edit] of [['no debit',(s:Save)=>{s.inventories[93]=structuredClone(f.ibefore.inventories[93]!);}],
   ['lost bank',(s:Save)=>{s.inventories[95]!.pop();}],['other skill',(s:Save)=>{s.skills[0]!.rawExperience++;}],
   ['HP XP',(s:Save)=>{s.skills[3]!.rawExperience++;}],['dead',(s:Save)=>{s.skills[3]!.level=0;}],
   ['no logout',(s:Save)=>{s.vars[134]=f.ibefore.vars[134]!;}],['off course',(s:Save)=>{s.position={x:3005,z:10363,level:0};}]] as const){
   const after=structuredClone(f.iafter);edit(after);
   expect(Object.values(inflightFoodChecks(f.ibefore,after,f.ilog,f.child,f.iname)).every(Boolean),label).toBe(false);
  }
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('a no-fall sample is only a retained zero-fall sample, never the in-flight proof',()=>{
 const f=recoveryUnitBundle();try{
  const log=f.ilog.replace(/AGILITY_RECOVERY fall[^\n]*\n/,'').split('\n').filter(l=>!l.startsWith('AGILITY_FOOD ')&&!l.startsWith('AGILITY_RECOVERY pit')).join('\n');
  const after=structuredClone(f.iafter);after.inventories[93]=structuredClone(f.ibefore.inventories[93]!);after.skills[3]!.level=INFLIGHT_FOOD_CONFIGURATION.currentHp;
  expect(inflightFoodOutcome(inflightFoodChecks(f.ibefore,after,log,f.child,f.iname),f.ibefore,after,log)).toBe('zero-fall');
  f.imeta.samples[0].outcome='zero-fall';f.rebind();
  expect(verifyInflightFood(f.dir,f.source)['inflight-1.outcome']).toBe(false);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('in-flight verifier rejects missing, CRC-invalid, substituted, rehashed-lie and omitted evidence',()=>{
 type B=ReturnType<typeof recoveryUnitBundle>;
 const attacks:[string,(f:B)=>void][]=[
  ...['inflight.json','inflight-1-before.sav','inflight-1-after.sav','inflight-1.log','initial-11.json','initial-11-before.sav','initial-11-after.sav','initial-11.log']
   .map(p=>[`missing ${p}`,(f:B)=>unlinkSync(join(f.dir,p))] as [string,(f:B)=>void]),
  ['CRC-invalid after',f=>mutateSave(join(f.dir,'inflight-1-after.sav'),b=>b[47]=41,false)],
  ['unrehashed log edit',f=>writeFileSync(join(f.dir,'inflight-1.log'),f.ilog+'\n')],
  ['rehashed zero effect',f=>{writeFileSync(join(f.dir,'inflight-1.log'),f.ilog.replaceAll('"hp":42','"hp":30'));f.rebind();}],
  ['rehashed missing settle',f=>{writeFileSync(join(f.dir,'inflight-1.log'),f.ilog.split('\n').filter(l=>!l.includes('"event":"settle"')).join('\n'));f.rebind();}],
  ['substituted account',f=>{f.imeta.samples[0].name='foreign11';f.rebind();}],
  ['substituted fixture',f=>{f.imeta.samples[0].fixture=12;f.rebind();}],
  ['foreign source',f=>{f.imeta.source={runtime:'foreign'};f.rebind();}],
  ['changed configuration',f=>{f.imeta.configuration={...INFLIGHT_FOOD_CONFIGURATION,currentHp:10};f.rebind();}],
  ['timed-out child',f=>{f.imeta.samples[0].child.timedOut=true;f.rebind();}],
  ['no samples',f=>{f.imeta.samples=[];f.rebind();}],
  ['omitted retained sample',f=>{writeFileSync(join(f.dir,'inflight-2.log'),'');}],
  ['initialization substitution',f=>{mutateSave(join(f.dir,'initial-11-after.sav'),b=>b[47]=35);f.rebind();}],
 ];
 for(const [label,attack] of attacks){
  const f=recoveryUnitBundle();try{attack(f);expect(Object.values(verifyFoodRecovery(f.dir,f.source)).every(Boolean),label).toBe(false);}
  finally{rmSync(f.dir,{recursive:true,force:true});}
 }
});
type Save=Parameters<typeof agilitySaveChecks>[0];
// Exact retained initial-6 bytes, compressed only for storage in this owned test.
// Originals remain in .practice/deliveries/agility-order-1793220188428-1mlNYe.
const retained=mkdtempSync(join(tmpdir(),'agility-init-'));
const retainedBytes={
 before:'H4sIAAAAAAAAClNgYWDjEeFZxcDAJSSlqKLFAAbqAgwMzC9ALEZkQs2DC0OMGgSjKQMa+P///39CYsh8bOrxAVLV0xoMNveMgqEXp6NpiBCAFGn0MouJIZZBhvnJfwYGxh1kWhLP+AFsgM031he8ZJoxCkbBKGAYCoBxYYvD+iY+l5dZAJ4W1hWXCQAA',
 after:'H4sIAAAAAAAAClNgYeDkEeFZxcDAJSSlqKLFAAbqAgwMzK9ALEZkQs2DC0OMKoQwA0v/////6xk4IRQvhBKAUBIKDDIQljWEcoBQbWIMy5gYVjAxrGRi2AoRugimGIUhlCiEkmzPYNRpz2DMB3OZGWIZZJif/GdgYNzBQB6IZ1QAG2DzjfUFL5lmjIJRwMAQx8CHLxiYmJl6FoBZoIzCuLDFYX0TbYJta+9JewBgTEtNDAQAAA==',
};
// Exact failed course-approach saves (1793223412779-MYgq0a), not regenerated fixtures.
const approachBytes={
 before:'H4sIAAAAAAAAClNgYeDk3Meby8DAJSSlqKLFAAbqAgwMrCdBLEZkQs2DC0OMKoQ4A0v/////6xk4IRQvhBKAUCJHGhgYRA82NDAwiHV0NLgxiC9smMHAIPFAgUEGosIaQjlAqLYWVoZlTAwrmBhWMjFshYhdBFOMwhBKFEJJtmcw6rRnMOaDucwMsQwyzE/+MzAwZrGvYYSiQ1DEQDyIZ1QAG2PzjfUFLwn6RsEoYEABcQx8+IKEiSnXN4EpjzeUgR2UjRa2pDjupU0Qfp/41QwABmmZTSsEAAA=',
 after:'H4sIAAAAAAAAClNgYeDk3MabzMDAJSSlqKLFAAbqAgwMbHkgFiMyoebBhSFGEqEugN0ASQaW/v///9czcEIoXgglAKFEjjQwMIgebGhgYBDr6GhwYxBf2DCDgUHigQKDDESFNYRygFBtjTYMM5gYljExrGBiWMnEsBUifBFMMXKwMQpDWKIQSrI9g1GnPYMxH8xlZohlkGF+8p+BgTGLfQ0jFB2CIgbiQTyjAtgYm2+sL3hJ0DcKRgEDCohj4MMXJExMWWcDmdLPBjFwgzLTwpYUx73UCEK2HHQRXfGvIQAybITYMQQAAA==',
};
for(const key of ['before','after'] as const)writeFileSync(join(retained,'approach-'+key+'.sav'),gunzipSync(Buffer.from(approachBytes[key],'base64')));
function completedGate(){
 const page={pageId:'choice-1',isOpen:true,isWaiting:false,text:'Select an Option',options:[
  {index:1,text:"Sorry, I'm a bit busy.",componentId:2461},{index:2,text:'OK then.',componentId:2462}]};
 const completed={tick:80,page:{pageId:'thanks-1',isOpen:true,isWaiting:false,text:'Femi\nThanks again friend!',options:[] as typeof page.options}};
 return{opens:2,femi:1,choiceAttempts:1,choices:[{tick:60,page,index:2,reply:{success:true},advanced:completed,completed}],at:'2461,3385,0',tick:90};
}
test('retained Femi dispatch count and intermediate crossing stay failed on CRC-checked save copies',()=>{
 const paths=['before','after'].map(k=>join(retained,'approach-'+k+'.sav'));
 expect(paths.map(p=>createHash('sha256').update(readFileSync(p)).digest('hex'))).toEqual([
  'fdb0cc8eab31981bb9fa5350c229b8e66b1ceed860502b179788ba6009b6a0ec','7a4aab3163678146b88bd121f6103921b4659de837fae599d908ac66c5ffb140']);
 const before=readPracticeSave(paths[0]!),after=readPracticeSave(paths[1]!);
 const diff=agilitySaveDifferences(before,after);
 expect(diff.vars).toEqual([{id:134,before:517,after:188},{id:152,before:0,after:2},{id:264,before:0,after:6}]);
 expect(diff.items).toEqual([]);expect(diff.containers).toEqual([]);
 expect(diff.skills).toEqual([{index:16,before:{index:16,rawExperience:0,xp:0,level:1},after:{index:16,rawExperience:10000,xp:1000,level:10}}]);
 const failed='AGILITY_ENTRY_GATE {"opens":3,"femi":2,"at":"2461,3384,0","tick":88}';
 expect(strongholdGateCrossed(failed)).toBe(false);expect(femiGateVarp(before,after,failed)).toBe(false);
 // Counterfactual predicates only. These cannot upgrade the retained failed report.
 const log=(g=completedGate())=>'AGILITY_ENTRY_GATE '+JSON.stringify(g);
 expect(femiGateVarp(before,after,log())).toBe(true);
 for(const edit of [
  (g:ReturnType<typeof completedGate>)=>{g.at='2461,3384,0';},
  (g:ReturnType<typeof completedGate>)=>{g.choiceAttempts=2;},
  (g:ReturnType<typeof completedGate>)=>{g.choices[0]!.reply.success=false;},
  (g:ReturnType<typeof completedGate>)=>{g.choices[0]!.completed.page.text='Thanks traveller!';},
  (g:ReturnType<typeof completedGate>)=>{g.choices[0]!.completed.tick=60;},
  (g:ReturnType<typeof completedGate>)=>{g.choices[0]!.advanced.page=structuredClone(g.choices[0]!.page);},
  (g:ReturnType<typeof completedGate>)=>{(g.choices[0] as any).advanced={tick:70};},
  (g:ReturnType<typeof completedGate>)=>{g.choices[0]!.advanced={tick:70,page:{...structuredClone(g.choices[0]!.page),text:'changed text'}};},
  (g:ReturnType<typeof completedGate>)=>{(g.choices as any)[0]=null;},
  (g:ReturnType<typeof completedGate>)=>{g.choices[0]!.index=1;},
 ]){const g=completedGate();edit(g);expect(femiGateVarp(before,after,log(g))).toBe(false);}
 const unknown=structuredClone(after);unknown.vars[77]=(before.vars[77]??0)+1;
 expect(agilitySaveChecks(before,unknown,10,'progress',[152]).vars).toBe(false);
});
for(const key of ['before','after'] as const)writeFileSync(join(retained,key+'.sav'),gunzipSync(Buffer.from(retainedBytes[key],'base64')));
afterAll(()=>{for(const key of ['before','after']){unlinkSync(join(retained,key+'.sav'));unlinkSync(join(retained,'approach-'+key+'.sav'));}rmdirSync(retained);});
function retainedInitialization(){return{before:readPracticeSave(join(retained,'before.sav')),after:readPracticeSave(join(retained,'after.sav'))};}
test('retained CRC-checked initialization adds only empty worn inventory, not lost assets',()=>{
 const {before,after}=retainedInitialization();
 expect(readFileSync(join(retained,'before.sav')).length).toBe(2455);
 expect(readFileSync(join(retained,'after.sav')).length).toBe(1036);
 expect(createHash('sha256').update(readFileSync(join(retained,'before.sav'))).digest('hex')).toBe('33f02fbe109c4502c6e16e18387391e1927df9020d4255326eba33fe76b416ac');
 expect(createHash('sha256').update(readFileSync(join(retained,'after.sav'))).digest('hex')).toBe('baa577d92aa23cd157eb85ca2eb5ea9f39cb8cb70745c272a4f980ec49616d1a');
 expect(before.position).toEqual({x:3092,z:3242,level:0});expect(after.position).toEqual(before.position);
 expect(after.skills).toEqual(before.skills);
 expect(before.inventories).toEqual({93:[{slot:0,id:995,count:440}],95:[{slot:0,id:995,count:15606},{slot:1,id:1511,count:13}]});
 expect(after.inventories).toEqual({...before.inventories,94:[]});
 expect(Object.values(agilityInitializationChecks(before,after)).every(Boolean)).toBe(true);
});
test('initialization compares container, slot, item and quantity independent of list order',()=>{
 const {before,after}=retainedInitialization();
 after.inventories[95]!.reverse();
 expect(agilityInitializationChecks(before,after).inventories).toBe(true);
 const reverse=agilityInitializationChecks(after,before);expect(reverse.inventories).toBe(true);
 for(const edit of [
  (s:Save)=>{s.inventories[95]![0]!.slot=2;},
  (s:Save)=>{s.inventories[95]![0]!.id=1512;},
  (s:Save)=>{s.inventories[95]![0]!.count--;},
  (s:Save)=>{s.inventories[94]=s.inventories[93]!;delete s.inventories[93];},
  (s:Save)=>{s.inventories[94]=[{slot:0,id:1351,count:1}];},
  (s:Save)=>{s.inventories[95]!.pop();},
  (s:Save)=>{s.inventories[95]!.push({...s.inventories[95]![0]!});},
  (s:Save)=>{s.inventories[999]=[];},
 ]){const changed=structuredClone(after);edit(changed);expect(agilityInitializationChecks(before,changed).inventories).toBe(false);}
});
test('initialization rejects unknown varp changes while retaining source-backed login defaults',()=>{
 const {before,after}=retainedInitialization();
 for(const id of [77,266,300,999]){const changed=structuredClone(after);changed.vars[id]=(changed.vars[id]??0)+1;expect(agilityInitializationChecks(before,changed).vars).toBe(false);}
 const controls=structuredClone(after);controls.vars[166]=3;expect(agilityInitializationChecks(before,controls).vars).toBe(false);
 const music=structuredClone(after);before.vars[24]=64;expect(agilityInitializationChecks(before,music).vars).toBe(false);
});
test('initialization rejects raw fractional XP, current level and all position mutations',()=>{
 const {before,after}=retainedInitialization();
 for(const index of [0,3,16,20]){
  const xp=structuredClone(after);xp.skills[index]!.rawExperience++;expect(agilityInitializationChecks(before,xp).skills).toBe(false);
  const level=structuredClone(after);level.skills[index]!.level++;expect(agilityInitializationChecks(before,level).skills).toBe(false);
 }
 for(const key of ['x','z','level'] as const){const changed=structuredClone(after);changed.position[key]++;expect(agilityInitializationChecks(before,changed).position).toBe(false);}
});
function save(xp=0,level=1):Save{return{version:9,position:{x:2474,z:3437,level:0},vars:{77:2},
 skills:Array.from({length:21},(_,index)=>({index,level:index===16?level:index===3?70:1,xp:index===16?xp:0,rawExperience:index===16?xp*10:0})),
 inventories:{93:[{slot:0,id:379,count:15}],95:[{slot:0,id:995,count:12345}],94:[{slot:3,id:1351,count:1}]}};}

test('reduced approach needs actual entry, XP, assets, life and logout, never a broad position alone',()=>{
 const before=save();before.position={x:2494,z:3437,level:0};before.skills[3]!.level=10;
 const after=structuredClone(before);after.position={x:2474,z:3428,level:0};after.skills[16]={index:16,xp:2000,rawExperience:20000,level:10};
 const entry='AGILITY_ENTRY '+JSON.stringify({route:'walk',fares:0,foodBought:0,coinsSpent:0,eats:0})+'\n';
 const gate='AGILITY_ENTRY_GATE '+JSON.stringify(completedGate())+'\n';
 const log=gate+entry+'AGILITY_PROGRESS level=10 xp=2000 tick=12 step=log\nAGILITY_ORDER_RESULT '+JSON.stringify({ok:true,level:10,target:10,xpGained:2000})+'\nLOGOUT logged-out\nRESULT ok agility\n';
 const child={code:0,timedOut:false,interrupted:false};
 const checks=(a=after,l=log)=>retainedApproachChecks(before,a,10,l,child);
 expect(Object.values(checks()).every(Boolean)).toBe(true);
 expect(checks(before).target).toBe(false);
 expect(checks(after,log.replace(entry,'')).entry).toBe(false);
 expect(checks(after,log.replace('LOGOUT logged-out','')).logout).toBe(false);
 const lost=structuredClone(after);lost.inventories[95]![0]!.count--;expect(checks(lost).assets).toBe(false);
 const changed=structuredClone(after);changed.skills[0]!.rawExperience++;expect(checks(changed).skills).toBe(false);
 const dead=structuredClone(after);dead.skills[3]!.level=0;expect(checks(dead).alive).toBe(false);
 // The strip is outside the Stronghold: no observed gate crossing, no pass.
 expect(checks(after,log.replace(gate,'')).gate).toBe(false);
 expect(checks(after,log.replace('2461,3385,0','2461,3382,0')).gate).toBe(false);
 // Femi's answer may set varp 152 from 0 to 2 only with its receipt.
 const helped=structuredClone(after);helped.vars[152]=2;
 expect(Object.values(checks(helped)).every(Boolean)).toBe(true);
 expect(checks(helped,log.replace('"femi":1','"femi":0')).vars).toBe(false);
 expect(checks(helped,log.replace(gate,'')).vars).toBe(false);
 const declined=structuredClone(after);declined.vars[152]=1;expect(checks(declined).vars).toBe(false);
 const quest=structuredClone(after);quest.vars[77]=0;expect(checks(quest).vars).toBe(false);
});

test('abrupt interruption waits for server removal and persisted XP, not the first progress line',()=>{
 const before=save(),middle=save(187,3);before.vars[134]=116;middle.vars[134]=650;
 const log='AGILITY_PROGRESS level=3 xp=187 tick=13 step=log\n';
 const timeout='[LOGOUT DEBUG] Server requesting idle logout for fixture - ticksSinceConnected=500, timeout=500\n';
 const removed='[LOGOUT DEBUG] Server removePlayer() called for fixture\n';
 const checks=(s:Save,engine=timeout+removed,worker=log)=>interruptionSaveChecks(before,s,20,worker,engine,'fixture');
 expect(Object.values(checks(middle)).every(Boolean)).toBe(true);
 // Before the engine's 500-tick idle timeout, disk legitimately has the baseline.
 expect(checks(before,'').persistedProgress).toBe(false);
 expect(checks(middle,timeout).serverRemoval).toBe(false);
 expect(checks(middle,removed).serverRemoval).toBe(false);
 expect(checks(middle,removed+timeout).serverRemoval).toBe(false);
 expect(checks(middle,(timeout+removed).replaceAll('fixture','other')).serverRemoval).toBe(false);
 expect(Object.values(checks(middle,timeout.replace('requesting idle logout','forcing logout')+removed)).every(Boolean)).toBe(true);
 expect(checks(middle,timeout+removed,'').abrupt).toBe(false);
 expect(checks(middle,timeout+removed,log+'LOGOUT logged-out\nRESULT fail stopped\n').abrupt).toBe(false);
 expect(checks(save(10000,20)).unfinished).toBe(false);
 const lost=structuredClone(middle);lost.skills[16]!.rawExperience=1000;lost.skills[16]!.xp=100;
 expect(checks(lost).persistedProgress).toBe(false);
 const damaged=structuredClone(middle);damaged.inventories[95]![0]!.count--;
 expect(checks(damaged).assets).toBe(false);
 const unsaved=structuredClone(middle);unsaved.vars[134]=116;
 expect(checks(unsaved).savedLogout).toBe(false);
 // World.TIMEOUT_NO_RESPONSE=1000 ticks. Allow bounded save acknowledgement too.
 expect(interruptionDeadlineMs(150)).toBe(165000);
});

test('fixture starts with typed nulls and full special energy before the first login',()=>{
 const input={position:{x:2460,z:3445,level:0},varps:{266:1,77:2}};
 const preset=agilityFixturePreset(input);
 expect(preset.position).toEqual(input.position);
 expect(input.varps).toEqual({266:1,77:2});
 for(const id of [4,9,13,16,28,64,181,209])expect(preset.varps![id]).toBe(-1);
 expect(preset.varps![300]).toBe(1000);
 expect(preset.varps![266]).toBe(1);expect(preset.varps![77]).toBe(2);
 // Exercise the actual producer: the old dense file must contain these values
 // before any engine login can overwrite its constructor defaults.
 const bytes=Buffer.from(createSaveData(preset));
 expect(bytes.readUInt16BE(133)).toBe(309);
 for(const id of [4,9,13,16,28,64,181,209])expect(bytes.readInt32BE(135+id*4)).toBe(-1);
 expect(bytes.readInt32BE(135+300*4)).toBe(1000);
 expect(bytes.readInt32BE(135+266*4)).toBe(1);
 // Explicit scenario state still wins, including a non-null coordinate.
 expect(agilityFixturePreset({varps:{4:123}}).varps![4]).toBe(123);
});

test('retained approach mismatch remains a failure and reports exact varp values',()=>{
 const before=save(),after=save(1000,10);
 for(const id of [4,9,13,16,28,64,181,209])after.vars[id]=4294967295;
 before.vars[134]=23;after.vars[134]=98;after.vars[264]=6;after.vars[300]=100;
 expect(agilitySaveChecks(before,after,10).vars).toBe(false);
 const delta=agilitySaveDifferences(before,after);
 expect(delta.vars).toContainEqual({id:4,before:0,after:4294967295});
 expect(delta.vars).toContainEqual({id:300,before:0,after:100});
 expect(delta.skills).toContainEqual({index:16,before:before.skills[16],after:after.skills[16]});
 expect(delta.items).toEqual([]);
 // A stable baseline removes the unrelated mutations without exempting them.
 const stable=save();Object.assign(stable.vars,after.vars);
 expect(Object.values(agilitySaveChecks(stable,after,10)).every(Boolean)).toBe(true);
 const damaged=structuredClone(after);damaged.vars[4]=0;
 expect(agilitySaveChecks(stable,damaged,10).vars).toBe(false);
});
test('pinned LostCity XP curve uses exponent level/10, not modern level/7',()=>{
 expect(trainedLevel(80)).toBe(2);expect(trainedLevel(79)).toBe(1);
 // Threshold independently calculated from Player.ts levelExperience recurrence.
 let points=0;for(let level=1;level<52;level++)points+=Math.floor(level+Math.pow(2,level/10)*300);
 const threshold=Math.floor(points/4);expect(trainedLevel(threshold)).toBe(52);expect(trainedLevel(threshold-1)).toBe(51);
});
test('saved XP must reach target; a boosted current level cannot pass',()=>{
 const before=save(),after=save(1000,99);
 expect(agilitySaveChecks(before,after,99).target).toBe(false);
 expect(Object.values(agilitySaveChecks(before,save(1000,10),2)).every(Boolean)).toBe(true);
 expect(agilitySaveChecks(before,save(0,99),2).target).toBe(false);
});
test('unrelated inventory, equipment, skills and quest flags must survive',()=>{
 const before=save(),good=save(1000,10);good.inventories[93]![0]!.count--;good.vars[173]=1;
 expect(Object.values(agilitySaveChecks(before,good,2)).every(Boolean)).toBe(true);
 const missing=structuredClone(good);missing.inventories[95]![0]!.count--;
 expect(agilitySaveChecks(before,missing,2).assets).toBe(false);
 const moved=structuredClone(good);moved.inventories[94]=[];moved.inventories[95]!.push({slot:1,id:1351,count:1});
 expect(agilitySaveChecks(before,moved,2).assets).toBe(false);
 const changed=structuredClone(good);changed.skills[0]!.rawExperience=10;
 expect(agilitySaveChecks(before,changed,2).skills).toBe(false);
 const quest=structuredClone(good);quest.vars[77]=0;expect(agilitySaveChecks(before,quest,2).vars).toBe(false);
 const food=structuredClone(good);food.inventories[93]![0]!.count=16;expect(agilitySaveChecks(before,food,2).assets).toBe(false);
});
test('refusal preserves the complete saved state',()=>{
 const before=save(1000,10);expect(Object.values(agilitySaveChecks(before,structuredClone(before),2,'refusal')).every(Boolean)).toBe(true);
 const moved=structuredClone(before);moved.position.x++;
 expect(agilitySaveChecks(before,moved,2,'refusal').target).toBe(false);
});

test('engine logout clock and save format are metadata, not player progress',()=>{
 const before=save(1000,10),after=structuredClone(before);before.version=6;after.version=9;
 before.vars[134]=79;after.vars[134]=95;
 expect(Object.values(agilitySaveChecks(before,after,2,'refusal')).every(Boolean)).toBe(true);
 const changed=structuredClone(after);changed.vars[77]=0;
 expect(agilitySaveChecks(before,changed,2,'refusal').target).toBe(false);
 const moved=structuredClone(after);moved.position.z++;
 expect(agilitySaveChecks(before,moved,2,'refusal').target).toBe(false);
 const malformed=structuredClone(after);malformed.vars[134]=-1;
 expect(agilitySaveChecks(before,malformed,2,'refusal').vars).toBe(false);
});

test('fall proof needs a real fall followed by later XP, not a seeded pit or click',()=>{
 const fall='AGILITY_RECOVERY fall tick=10 step=ropeswing hp=58 at=3004,10357 xp=42000\n';
 expect(fallRecoveryCheck(fall+'AGILITY_PROGRESS level=53 xp=42500 tick=20 step=log\n')).toBe(true);
 expect(fallRecoveryCheck('AGILITY_RECOVERY pit tick=11 at=3005,3962\nAGILITY_PROGRESS level=53 xp=42500 tick=20 step=log\n')).toBe(false);
 expect(fallRecoveryCheck(fall)).toBe(false);
 expect(fallRecoveryCheck(fall+'AGILITY_PROGRESS level=52 xp=42000 tick=20 step=log\n')).toBe(false);
 expect(fallRecoveryCheck('AGILITY_PROGRESS level=53 xp=42500 tick=5 step=log\n'+fall)).toBe(false);
});

test('saved final position must be on the requested course',()=>{
 const s=save(1000,10);expect(savedCoursePosition(s,'gnome')).toBe(true);
 expect(savedCoursePosition(s,'wilderness')).toBe(false);
 s.position={x:3005,z:10363,level:0};expect(savedCoursePosition(s,'wilderness')).toBe(false);
 s.position.z=3962;expect(savedCoursePosition(s,'wilderness')).toBe(true);
 s.position.level=1;expect(savedCoursePosition(s,'wilderness')).toBe(false);
});

test('login defaults must be baselined, never globally exempted as Agility work',()=>{
 const before=save(),after=save(1000,10);
 after.vars[166]=2;after.vars[168]=2;after.vars[169]=2;after.vars[21]=2097152;
 after.vars[275]=4294967295;after.vars[277]=4294967295;after.vars[300]=100;after.vars[367]=4294967295;
 expect(agilitySaveChecks(before,after,2).vars).toBe(false);
 const baseline=structuredClone(after);baseline.skills=before.skills;
 expect(Object.values(agilitySaveChecks(baseline,after,2)).every(Boolean)).toBe(true);
});
test('child result, exit and logout are separate requirements',()=>{
 const meta={code:0,timedOut:false,interrupted:false};
 const result='AGILITY_ORDER_RESULT '+JSON.stringify({ok:true,level:10,target:10,xpGained:1000});
 const good=result+'\nLOGOUT logged-out\nRESULT ok agility-order\n';
 expect(Object.values(childChecks(meta,good,'progress')).every(Boolean)).toBe(true);
 expect(childChecks(meta,result,'progress').logout).toBe(false);
 expect(childChecks({...meta,code:1},good,'progress').exit).toBe(false);
 expect(childChecks({...meta,timedOut:true},good,'progress').exit).toBe(false);
 expect(childChecks(meta,'LOGOUT logged-out\nRESULT ok\n','progress').result).toBe(false);
 expect(childChecks(meta,result+'\nLOGOUT logged-out\nRESULT fail close failed\n','progress').result).toBe(false);
 expect(Object.values(childChecks({...meta,code:1},'LOGOUT logged-out\nRESULT fail already at target\n','refusal')).every(Boolean)).toBe(true);
});

function draynor(){
 const before=save();before.position={x:3092,z:3242,level:0};before.vars[20]=4;
 // A fresh account's Hitpoints 10, from the pinned XP curve.
 let points=0;for(let level=1;level<10;level++)points+=Math.floor(level+300*2**(level/10));
 Object.assign(before.skills[3]!,{level:10,xp:Math.floor(points/4),rawExperience:Math.floor(points/4)*10});
 before.inventories={93:[{slot:0,id:995,count:440}],95:[{slot:0,id:995,count:15606},{slot:1,id:1511,count:13}]};
 const after=save(1000,10);after.skills[3]=structuredClone(before.skills[3]!);after.vars[20]=4|64;after.vars[21]=8;
 after.inventories={93:[{slot:0,id:995,count:440-60-6},{slot:1,id:1963,count:1}],95:structuredClone(before.inventories[95]!)};
 const log=['AGILITY_ENTRY_PURCHASE {"item":"/^banana$/i","sdkSuccess":true,"bought":1,"spent":2,"coins":438,"tick":40}',
  'AGILITY_ENTRY_PURCHASE {"item":"/^banana$/i","sdkSuccess":true,"bought":1,"spent":2,"coins":436,"tick":41}',
  'AGILITY_ENTRY_PURCHASE {"item":"/^banana$/i","sdkSuccess":true,"bought":1,"spent":2,"coins":434,"tick":42}',
  'AGILITY_ENTRY_PURCHASE {"item":"/^cheese$/i","sdkSuccess":false,"bought":0,"spent":0,"coins":434,"tick":43}',
  'AGILITY_ENTRY_FARE {"leg":"sail to Karamja","paid":30,"coins":404,"tick":80}',
  'AGILITY_ENTRY_FARE {"leg":"sail to Ardougne","paid":30,"coins":374,"tick":300}',
  'AGILITY_ENTRY_GATE '+JSON.stringify({...completedGate(),tick:600}),
  'AGILITY_ENTRY {"route":"draynor","fares":2,"foodBought":3,"coinsSpent":66,"eats":2,"tick":700,"at":"2474,3437,0"}',
  'AGILITY_PROGRESS level=10 xp=1000 tick=760 step=pipe',
  'AGILITY_ORDER_RESULT {"ok":true,"level":10,"target":10,"xpGained":1000,"eats":2,"entry":{"route":"draynor","coinsSpent":66}}',
  'LOGOUT logged-out','RESULT ok agility-order gnome'].join('\n')+'\n';
 return{before,after,log};
}
test('Draynor entry passes only with matched fares, purchases, eaten food and unchanged bank',()=>{
 const {before,after,log}=draynor();
 const r=draynorEntryChecks(before,after,10,log);
 expect(r.checks).toEqual({start:true,route:true,gate:true,target:true,position:true,assets:true,coins:true,food:true,skills:true,vars:true,alive:true});
 expect(draynorEntryChecks(before,after,10,log.replace(/^AGILITY_ENTRY_GATE .*\n/m,'')).checks.gate).toBe(false);
 const helped=structuredClone(after);helped.vars[152]=2;expect(draynorEntryChecks(before,helped,10,log).checks.vars).toBe(true);
 expect(draynorEntryChecks(before,helped,10,log.replace(/^AGILITY_ENTRY_GATE .*\n/m,'')).checks.vars).toBe(false);
 const declined=structuredClone(after);declined.vars[152]=1;expect(draynorEntryChecks(before,declined,10,log).checks.vars).toBe(false);
 expect(r.receipt).toEqual({coinsSpent:66,fares:60,foodBought:3,foodSpent:6,foodEaten:2,eats:2});
 const bank=structuredClone(after);bank.inventories[95]![0]!.count--;expect(draynorEntryChecks(before,bank,10,log).checks.assets).toBe(false);
 const unreceipted=structuredClone(after);unreceipted.inventories[93]![0]!.count-=5;expect(draynorEntryChecks(before,unreceipted,10,log).checks.coins).toBe(false);
 expect(draynorEntryChecks(before,after,10,log.replace(/^AGILITY_ENTRY_FARE .*Ardougne.*\n/m,'')).checks.route).toBe(false);
 // Eaten count must match the worker's observed eats, not only the bag difference.
 expect(draynorEntryChecks(before,after,10,log.replace('"eats":2,"entry"','"eats":1,"entry"')).checks.food).toBe(false);
 const relocated=structuredClone(before);relocated.position={x:2460,z:3445,level:0};expect(draynorEntryChecks(relocated,after,10,log).checks.start).toBe(false);
 const seeded=structuredClone(before);seeded.inventories[93]!.push({slot:2,id:379,count:5});expect(draynorEntryChecks(seeded,after,10,log).checks.start).toBe(false);
 const levelled=structuredClone(before);levelled.skills[0]!.rawExperience=10;expect(draynorEntryChecks(levelled,after,10,log).checks.start).toBe(false);
 const poor=structuredClone(before);poor.inventories[93]![0]!.count=40;expect(draynorEntryChecks(poor,after,10,log).checks.start).toBe(false);
 const away=structuredClone(after);away.position={x:2683,z:3270,level:0};expect(draynorEntryChecks(before,away,10,log).checks.position).toBe(false);
 // Music unlocks may only gain bits. Quest and other varps stay exact.
 const lost=structuredClone(after);lost.vars[20]=64;expect(draynorEntryChecks(before,lost,10,log).checks.vars).toBe(false);
 const quest=structuredClone(after);quest.vars[77]=0;expect(draynorEntryChecks(before,quest,10,log).checks.vars).toBe(false);
 const combat=structuredClone(after);combat.skills[0]!.rawExperience=10;expect(draynorEntryChecks(before,combat,10,log).checks.skills).toBe(false);
 expect(draynorEntryChecks(before,save(0,1),10,log).checks.target).toBe(false);
});

// Exact retained fall evidence. zero: delivery 1793225435815-2zPEma (seven laps, 0 falls).
// fell: delivery 1793224744297-VuAuXF (falls at ticks 20, 239 and 405). The verifier tests
// compose them as counterfactual samples. Neither old delivery becomes fresh fall proof.
const fallEvidence={
 zero:{before:'H4sIAAAAAAACClNgYeDk3sOfyMDAJSSlqKLFAAbqAgwMzK9ALEYGkRAfN3QWmQTr3gQTrBJCDCz9////r2fghFC8EEoAQokfYGCQgTAdIFRbuxHDMiaGFUwMK5kYtkLELoIpRmEIJQqhJNszGHWAOB/MZWaIZZBhrGEkHjHgBnEMfBAGqwd2ZfGMCsxP/jMwGFiyvuBlGAWjgEzAxPSmP5wBll0YF7ZMZbtFG5syxXeaAwBzOidlEgQAAA==',
  after:'H4sIAAAAAAACClNgYeDk3sQfy8DAJSSlqKLFAAbqAgwMrAdALEYGkRAfN3QWmYTI/zzsBggxsPT///+/noETQvFCKAEIJQ50iQyE6QCh2rolGZYxMaxgYljJxLAVInYRTDEKQyhRCCXZnsGoA8T5YC4zQyyDDGMNI/GIATeIY+CDMFg9sCuLZ1RgfvKfgcHAkvUFL8MoGAVkAiamN/0pQBzOeAaUWxa2TGW7RQ1zWXehi+hqnn0BAIO5IB8SBAAA',
  log:'H4sIAAAAAAACCo2WXWvjOBSG7/MrhK9a1hn0bSsQ2FkmhEKgJc1c7N4Mbqx4TFzL2Eo/Zpj/PseWbLOw26g3tY/0+LUfnQg9ZPb7qazzsi5QWZe2zKryh87hGnGlnjt0Q5hMMEc/TK079AfC6Dkr6yqrc3QqqypGhMqUCYxsWekuRlQqgnJj2g4mdmedx0ggYJev2buvP1XmCAO3i8fD5/0BMQyPZ4olCC8+b+92d4e/vz3s77f7zeMjqvSLrtaCordmzRJFU8g5ntdEoM7qZt2Ujb4CpXyEKHVQaxrdvcIXXyOnOHi3gexsb+EKpqZAwR1Wmf+Pkj0jiMLEMZKPL3k8d1coSglzVEoDfHgomSAV6sORbIojmAcJSRw3JRJKrhtRPSQlSaWHGAlQIrHDuBpbhKvrTkZKTRR8a5gUjyZzYEJCpIzcHJmmV6XIobVSzBPfJkSlIVI8lqR+ASiRAVIcRehEURYqhTl0DmRpkBTH0TlSiOtSRA8pngjfKVSKECkOE1iO+0LKAqR4SkyUwqFSHCqnQIZFkBTPTZFs3ME+kjL85ghWmPtWYYyGWBk5JvwS9Jv6dS0jls5YEurFsQTPkQkNEjOCc+i4l31kJh0oCj58vzClQsyMnGR+HThJAsx4jJMJozzUjPLsHMlUkBkPijl03NA+MJMMWxJhiSS+Z7iU/2Xmfv9ls/8G5NfdAf2MzDla2fai4yiz0SqimMolwUuaHihdEbli8hPj4p8ojo7m0nYa5ryWVa5b+IIOqjZrCw1kguPoSZ9Mq3f9+0QrQeOocpf92FuzhTOHzqOVgj8BY1nTwVAcnbKqgiuY05R281Zad6Oz8aK27Xu0+hm15mL7/BrsRT3XajfjZEz+l7kU3+1wezRl3T02wP37QUXW4/Wlqn7Be4MiKHPJfy12my/bzX6w1oE2PhwBBJyfXuAZpn1fw4HJvGjYLgTK6vJ5rRjK4ZRlinWv+FLDhDKv9ADB/4ejXSefBKpMXejO3vVD5E/LbvpjUtwfk25juCd8LAjsCklfEH2BuIKaCmwocHVDQR8UuLhFT8aus6J8eyaWicXufnv/9QChRaHzJbha+EU2ZwSzqtK+L00LK4fmBZybx62jb6NhiRa/AbR1yIdYCgAA'},
 fell:{before:'H4sIAAAAAAACClNgYeDk3sOfyMDAJSSlqKLFAAbqAgwMzK9ALEYGkRAfN3QWmQTr3gQTrBJCDCz9////r2fghFC8EEoAQokfYGCQgTAdIFRbuwPDMiaGFUwMK5kYtkLELoIpRmEIJQqhJNszGHWAOB/MZWaIZZBhrGEkHjHgBnEMfBAGqwd2ZfGMCsxP/jMwGFiyvuBlGAWjgEzAxPSmP5wBll0YF7Z0ZS6ijU1aJdOtAcIBpn0SBAAA',
  after:'H4sIAAAAAAACClNgYeDk3sQfy8DAJSSlqKLFAAbqAgwMbHYgFiODSIiPG5ylBWGRSYi6WbthlRBiYOn///9/PQMnhOKFUAIQSvwAA4MMhOkAodp6VBmWMTGsYGJYycSwFSJ2EUwxCkMoUQgl2Z7BqAPE+WAuM0MsgwxjDSPxiAE3iGPggzBYPbAri2dUYH7yn4HBwJL1BS/DKBgFZAImplf8kUyv+1MY+kC5ZWFLV+YiapjLZoMuouCy7i8AIV78DRIEAAA=',
  log:'H4sIAAAAAAACCo2WbW+cOBDH3++nsHiV6EjlZ+yVkNq7rqJIkRJttie1b05kcTZoCUbA5qFVv/uNFwO66zb4FWD884z/M+PxbdY9PhRVXlQ7VFRFV2Rl8d3k8I64Yk8tOiNMJpij77YyLfoDYfSUFVWZVTl6KMoyRoRKxQRGXVGaNkZUaoJya5sWJrZ7k8dIIGAvXrI3P35f2i38OF/cbT6tN4hhWJ5pliC8+HR5dX21+frP7frmcr26u0OleTZlKih6rVOWaKrAznafEoHaztRpXdRmhNarv27+Xq2/ooesLPt5FPfzGlub9sVt8rFOE4yyLnVmY4KZSMa1f12pLjq/kPSMiJmWdMZRxQdHOe0daDun3xw27k/oHivtLpiRetjrdj9nSVNOekolJ5T8DZQMkOb/k/V9kuPRHME6SBDWc6NFyLJ5RaSDBKOEeYjJEEk8JsCETy4eoMkxbQRsbaAkCRXFo5PBRAaJ0nNiMqnZrCgSO0gmXKuhJFiAKAOmiA8ApWReFE8pNlHqd6Kcqlb2n+RwtSqHWqWu7ti4/JwHk98iSFvP6cnzhM9re/RHkUT5hKOKh2jbYxRrH0eGaYC2nhITpQMTzqNsMkh5kCiem0xyMi+KcJCWWPqEY4KEiOIxpnwA2HCevSuKp9RIJTJUlB5NJoOanBTlRKJyLEYdXJZy5bKUaq1cR+FyXPmdjsKJDmopg5/jFjkTQcHrOTXuD86b+eAdjxhCsBI+pbmkIdHzHCHSpwpXOCB8AyYnLAmNn2fpaFLgoGY7gqNRQebbLWSjo6ggbOjRNKThjhwXPg6CB7TcEdMjJkKb7sDKyaQM6rojOBlV8203OR6dhGlO2XB7Odl3b9afV2uohLsv1xv0I7L7aNk1BxNHWRctIwpt7YLgC6o2lC6xWFL8AeriWxRHW3toWgNzXooyNw3soIXRLmt2BsgEx9G9ebCNuXb+REtB46jsX92/1/oSbqwmj5YEE4UT+JnVbbRUceQqGt5YHEFZrl6LDj4ANpl7AdRUXfMWLX9EjT10zoEK5Isc15h+xoO1+Z/2sHvsjp9bW1TtXQ1czw8L7TKHV4ey/AmOg0YwLDT/ubhefb5crY+ytaAb7y9acP1+hjVs85bCfds+m9RVcVYVT5C3GuVwS7e71Il8qGBGkZcm5fr4vN12qfpAUWmrnWm7K/eLfuykPoPjicNJw9h5DAOU47OxrZ7H5GPHzo5XYncTP34TPgwI3A8kZ/60EuQc3dsuzXbFa32fM7G4vrm8+bIBq7udyS9ArYWPs90jmFUW3duFbSB4aIrhlD99KIdMOkZp8S+5RcqRmgwAAA=='},
};
const unpack=(b64:string)=>gunzipSync(Buffer.from(b64,'base64'));
const fallChild={code:0,timedOut:false,interrupted:false};
const fallDir=mkdtempSync(join(tmpdir(),'agility-fall-'));
// Sample 2 uses fixture 8. Only the counterfactual ledger name is rewritten for that slot.
const initialBytes=[{"-before.sav":"H4sIAAAAAAAAClNgYWDj3sOfyMDAJSSlqKLFAAbqAgwMzC9ALEYGkRAfN3QWmQTr3gQTbBKMpgxo4P////8JiSHzsanHB0hVT2sw2NwzCoZenI6mIUIAUqTRyyxmhlgGGcYaRuIRHsPiGPggDFYP7MriGT8wP/nPwGBgyfqCl2xfjYJRMAoYBj9gXNgyle3WVnfDmwBGcKk9wgkAAA==","-after.sav":"H4sIAAAAAAAAClNgYeDk3sOfyMDAJSSlqKLFAAbqAgwMzK9ALEYGkRAfN3QWmQTr3gQTrBJCDCz9////r2fghFC8EEoAQokfYGCQgTAdIFRbuxHDMiaGFUwMK5kYtkLELoIpRmEIJQqhJNszGHXaMxjzwVxmhlgGGcYaRuIRA24Qx8AHYbB6YFcWz6jA/OQ/A4OBJesLXjwGjYJRwIAPMDG96Q8Hs0AJjXFhy1S2W7QJskzxneYAczonZRIEAAA=",".log":"H4sIAAAAAAAACi2KwWrCQBRF9/mKu2yplhejsRZmUWiQgqBo/ICnM04fTmZK5mnVry+Brg6cczas3yeJVqKHRFHhIA9nIRHTetFlPJVVPacpHim6jBcQOpYYOFqcJIQRykn9Vs0IKsHlESb1ooRNqc/oOJ+dHWGGFN34l+///hDS8ezsc7FrP7YtKqIpqkU1BxWr5nPZbKFyPGdDuP0YgsSri5r6uyF06eoMgaN0hmCFQ/KGkPUSh9OGoQ7YHNXQKyGk6F3Wr6HgkNSwl1tXajUrVuvlet8iJO+dHaeLFttmt1+1OLEENH2f+ndw6B3bO1ih3HunxR9seP/wMgEAAA=="},{"-before.sav":"H4sIAAAAAAAAClNgYWDj3sOfyMDAJSSlqKLFAAbqAgwMzC9ALEYGkRAfN3QWmQTr3gQTbBKMpgxo4P////8JiSHzsanHB0hVT2sw2NwzCoZenI6mIUIAUqTRyyxmhlgGGcYaRuIRHsPiGPggDFYP7MriGT8wP/nPwGBgyfqCl2xfjYJRMAoYBj9gXNjSlblIri36EwD+kpalwgkAAA==","-after.sav":"H4sIAAAAAAAAClNgYeDk3sOfyMDAJSSlqKLFAAbqAgwMzK9ALEYGkRAfN3QWmQTr3gQTrBJCDCz9////r2fghFC8EEoAQokfYGCQgTAdIFRbuwPDMiaGFUwMK5kYtkLELoIpRmEIJQqhJNszGHXaMxjzwVxmhlgGGcYaRuIRA24Qx8AHYbB6YFcWz6jA/OQ/A4OBJesLXjwGjYJRwIAPMDG96Q8Hs0AJjXFhS1fmItoEmVbJdGsAwgGmfRIEAAA=",".log":"H4sIAAAAAAAACi2K3WoCMRQG7/cpvsuWajnr+lvIRaGLFARF1wc4mmx62GwiSbTq05eFXg3MzI7zTytei7cQL1nYydNoiMd0VfYJL2U1X9AUz+BNwhsIPYt37DVacW6EcjJfVjNCFmfSCJP5qoQOISb0nDqjR5gheDP+5ce/P7lw7ox+LQ7N575BRTRFtaoWoGJTf63rPbKcu6QI94siiL8Zn0N8KEIfbkYR2EuvCFrYBasIKV/9cGo31AG7c1b0TnDBW5Py91BwClmxlfvlpKtZsdmut8cGLlhr9Dhcc7GvD8dNg5bFoY4xxA+wi4b1A5yROVqTiz8H/nw7MgEAAA=="}];
const testSource={runtime:'retained-counterfactual',files:{}};
const digest=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
function bindInitialization(directory:string,fixture:number,name:string,source:unknown=testSource){
 const raw=Object.fromEntries(['before','after','log'].map(k=>[k,digest(readFileSync(join(directory,'initial-'+fixture+(k==='log'?'.log':'-'+k+'.sav'))))]));
 return {format:'agility-initialization-1',name,index:fixture,source,configuration:INITIALIZATION_CONFIGURATION,sha256:raw};
}
const fallSlots=[{label:'fall-1',fixture:5,name:'agixm1t35',src:fallEvidence.zero,outcome:'zero-fall'},
 {label:'fall-2',fixture:8,name:'agixpbd38',src:fallEvidence.fell,outcome:'proved'}] as const;
for(const s of fallSlots){
 writeFileSync(join(fallDir,s.label+'-before.sav'),unpack(s.src.before));writeFileSync(join(fallDir,s.label+'-after.sav'),unpack(s.src.after));
 writeFileSync(join(fallDir,s.label+'.log'),unpack(s.src.log).toString('utf8').replace('bot=agixpbd35','bot=agixpbd38'));
 const idx=s.fixture===5?0:1;
 for(const suffix of ['-before.sav','-after.sav','.log'] as const){let bytes=unpack(initialBytes[idx]![suffix]!);
  if(suffix==='.log')bytes=Buffer.from(bytes.toString().replace('bot=agixpbd35','bot=agixpbd38'));
  writeFileSync(join(fallDir,'initial-'+s.fixture+suffix),bytes);
 }
 const ib=readPracticeSave(join(fallDir,'initial-'+s.fixture+'-before.sav')),ia=readPracticeSave(join(fallDir,'initial-'+s.fixture+'-after.sav'));
 const child={code:1,timedOut:false,interrupted:false};
 writeFileSync(join(fallDir,'initial-'+s.fixture+'.json'),JSON.stringify({name:s.name,index:s.fixture,child,
  binding:bindInitialization(fallDir,s.fixture,s.name),checks:initializationEvidenceChecks(ib,ia,readFileSync(join(fallDir,'initial-'+s.fixture+'.log'),'utf8'),child,s.name)}));
}
afterAll(()=>{rmSync(fallDir,{recursive:true,force:true});});
const fallFiles=readFallSamples(fallDir);
function fallMeta(){const at=Date.now();return{at,fall:{plan:structuredClone(FALL_SAMPLE_PLAN) as any,samples:fallSlots.map((s,i)=>({index:i+1,fixture:s.fixture as number,label:s.label as string,
 name:s.name as string,outcome:s.outcome as string,at:at-1000+i,child:{...fallChild},initialization:bindInitialization(fallDir,s.fixture,s.name),sha256:fallFiles.read(s.label)!.sha256}))}};}
type FallRead=(label:string)=>FallFiles|undefined;
const verifyMeta=(m=fallMeta(),read:FallRead=fallFiles.read,present=fallFiles.present)=>verifyFallSamples(m.fall,m.at,read,present,testSource);

test('initialization flags alone cannot replace retained raw saves and log',()=>{
 // This is the rejected delivery's acceptance hole: the reader currently has
 // only initial-N.json and accepts it without reading either save or the log.
 const read:FallRead=l=>{const f=fallFiles.read(l)!;return {...f,initial:{...f.initial,checks:{readable:true}}};};
 expect(verifyMeta(fallMeta(),read).fall).toBe(false);
});

test('retained zero-fall run was genuine: every step earned XP and HP did not drop',()=>{
 const z=fallFiles.read('fall-1')!,f=fallFiles.read('fall-2')!;
 expect(z.sha256.before).toBe('de458d0d211f469279ed6f008f61b3885e67a5a63f656b316cfeaf56d4208017');
 expect(z.sha256.after).toBe('484ab7821ae484875d6caa298604a161a741029090a4f2a990a50014e6f630e3');
 expect([z.before.skills[16]!.rawExperience,z.after.skills[16]!.rawExperience]).toEqual([376160,1376110]);
 expect([z.before.skills[16]!.level,z.after.skills[16]!.level,z.before.skills[3]!.level,z.after.skills[3]!.level]).toEqual([52,70,70,70]);
 expect(agilitySaveDifferences(z.before,z.after).vars).toEqual([{id:134,before:946,after:1433}]);
 expect(zeroFallObserved(z.before,z.after,z.log)).toBe(true);
 const zc=fallSampleChecks(z.before,z.after,z.log,fallChild,'agixm1t35');
 expect(Object.values(zc).every(Boolean)).toBe(true);
 expect(fallSampleOutcome(zc,z.before,z.after,z.log)).toBe('zero-fall');
 const fc=fallSampleChecks(f.before,f.after,f.log,fallChild,'agixpbd38');
 expect(Object.values(fc).every(Boolean)).toBe(true);
 expect(fallSampleOutcome(fc,f.before,f.after,f.log)).toBe('proved');
 // A fall run cannot pose as zero-fall. Lost obstacle XP or an HP drop means a missed fall.
 expect(zeroFallObserved(f.before,f.after,f.log)).toBe(false);
 const repeated=z.log.replace('xp=38428 tick=22 step=ropeswing','xp=37928 tick=22 step=ropeswing');
 expect(zeroFallObserved(z.before,z.after,repeated)).toBe(false);
 const hurt=structuredClone(z.after);hurt.skills[3]!.level=59;expect(zeroFallObserved(z.before,hurt,z.log)).toBe(false);
 const unsaved=structuredClone(z.after);unsaved.skills[16]!.xp--;expect(zeroFallObserved(z.before,unsaved,z.log)).toBe(false);
});
test('a fall with no later XP fails the sample instead of permitting another',()=>{
 const f=fallFiles.read('fall-2')!;
 const lines=f.log.split('\n'),first=lines.findIndex(l=>l.startsWith('AGILITY_RECOVERY fall '));
 const stuck=lines.filter((l,i)=>i<=first||!l.startsWith('AGILITY_PROGRESS ')).join('\n');
 const c=fallSampleChecks(f.before,f.after,stuck,fallChild,'agixpbd38');
 expect(fallSampleOutcome(c,f.before,f.after,stuck)).toBe('failed');
 // Ordinary predicate failures also stop: wrong start, no saved logout, foreign ledger.
 const moved=structuredClone(f.before);moved.position={x:3005,z:10363,level:0};
 expect(fallSampleChecks(moved,f.after,f.log,fallChild,'agixpbd38').start).toBe(false);
 const notOut=structuredClone(f.after);notOut.vars[134]=f.before.vars[134]!;
 expect(fallSampleChecks(f.before,notOut,f.log,fallChild,'agixpbd38').savedLogout).toBe(false);
 expect(fallSampleChecks(f.before,f.after,f.log,fallChild,'agixother8').identity).toBe(false);
 expect(fallSampleChecks(f.before,f.after,f.log.replace('LOGOUT logged-out\n',''),fallChild,'agixpbd38').logout).toBe(false);
});
test('sampling stops after an observed recovery, on any failure, or at the limit',async()=>{
 const runner=(outcomes:(FallSample['outcome']|Error)[])=>{const calls:number[]=[];
  return{calls,run:async(s:FallSample)=>{calls.push(s.fixture);const o=outcomes[s.index-1]!;if(o instanceof Error)throw o;s.outcome=o;}};};
 let r=runner(['zero-fall','proved','zero-fall']),samples:FallSample[]=[];
 await sampleFalls(r.run,()=>0,samples);
 expect(r.calls).toEqual([5,8]);expect(samples.map(s=>[s.label,s.outcome])).toEqual([['fall-1','zero-fall'],['fall-2','proved']]);
 r=runner([new Error('child exit 1'),'proved']);samples=[];
 await expect(sampleFalls(r.run,()=>0,samples)).rejects.toThrow('child exit 1');
 expect(r.calls).toEqual([5]);expect(samples[0]).toMatchObject({outcome:'failed',error:'Error: child exit 1'});
 r=runner(['failed','proved']);samples=[];
 await expect(sampleFalls(r.run,()=>0,samples)).rejects.toThrow('fall sample 1 failed');expect(r.calls).toEqual([5]);
 r=runner(['zero-fall','zero-fall','zero-fall','proved']);samples=[];
 await expect(sampleFalls(r.run,()=>0,samples)).rejects.toThrow('exhausted without an observed fall');
 expect(r.calls).toEqual([5,8,9]);expect(samples.length).toBe(3);
 // Admission keeps the worst sample plus cleanup inside the 900000ms harness deadline.
 expect(FALL_SAMPLE_PLAN.sampleWorstMs).toBe(390000);
 expect(fallSampleAdmitted(480000)).toBe(true);expect(fallSampleAdmitted(480001)).toBe(false);expect(fallSampleAdmitted(NaN)).toBe(false);
 let clock=0;r=runner(['zero-fall','zero-fall']);samples=[];
 await expect(sampleFalls(async s=>{await r.run(s);clock+=400000;},()=>clock,samples)).rejects.toThrow('fall sample 3 not admitted');
 expect(r.calls).toEqual([5,8]);
});
test('read-only verification accepts the bound sample list and rejects omitted, substituted, duplicate, stale or failed samples',()=>{
 const stamps=()=>fallSlots.flatMap(s=>['-before.sav','-after.sav','.log'].map(x=>{const p=join(fallDir,s.label+x);return[readFileSync(p).toString('base64'),statSync(p).mtimeMs];}));
 const was=JSON.stringify(stamps());
 const good=verifyMeta();expect(Object.entries(good).filter(([,v])=>!v)).toEqual([]);expect(good.fall).toBe(true);
 const fails=(edit:(m:ReturnType<typeof fallMeta>)=>void,read:FallRead=fallFiles.read,present=fallFiles.present)=>{const m=fallMeta();edit(m);return verifyMeta(m,read,present).fall;};
 // Old single-case metadata has no sample plan.
 expect(verifyFallSamples(undefined,Date.now(),fallFiles.read,fallFiles.present).fall).toBe(false);
 // Dropping the proving sample leaves its retained files: omitted, and the last sample is not proved.
 expect(fails(m=>{m.fall.samples.pop();})).toBe(false);
 expect(fails(()=>{},fallFiles.read,l=>l==='fall-3'||fallFiles.present(l))).toBe(false);
 expect(fails(m=>{m.fall.samples[0]!.sha256={...m.fall.samples[0]!.sha256,log:'0'.repeat(64)};})).toBe(false);
 expect(fails(()=>{},l=>{const f=fallFiles.read(l);return f&&l==='fall-2'?{...f,sha256:{...f.sha256,after:'0'.repeat(64)}}:f;})).toBe(false);
 expect(fails(m=>{m.fall.samples[1]!.name=m.fall.samples[0]!.name;})).toBe(false);
 expect(fails(m=>{m.fall.samples[1]!.fixture=5;})).toBe(false);
 expect(fails(m=>{m.fall.samples.reverse();})).toBe(false);
 expect(fails(m=>{m.fall.samples[0]!.at=m.at-FALL_SAMPLE_PLAN.deadlineMs;})).toBe(false);
 expect(fails(m=>{m.fall.samples[1]!.at=m.fall.samples[0]!.at;})).toBe(false);
 expect(fails(m=>{m.fall.samples[0]!.child.code=1;})).toBe(false);
 expect(fails(m=>{m.fall.samples[1]!.outcome='zero-fall';})).toBe(false);
 expect(fails(m=>{m.fall.plan={...m.fall.plan,limit:4};})).toBe(false);
 expect(fails(()=>{},l=>l==='fall-1'?undefined:fallFiles.read(l))).toBe(false);
 expect(fails(()=>{},l=>{const f=fallFiles.read(l);return f&&{...f,initial:{...f.initial,checks:{saveMatched:false}}};})).toBe(false);
 expect(fails(()=>{},l=>{const f=fallFiles.read(l)!;return{...f,log:f.log.replace('LOGOUT logged-out\n','')};})).toBe(false);
 // A proving sample cannot be followed by another sample.
 const extra=fallMeta();extra.fall.samples.push({...extra.fall.samples[1]!,index:3,fixture:9,label:'fall-3',name:'agixpbd39',at:extra.at});
 expect(verifyMeta(extra).fall).toBe(false);
 expect(JSON.stringify(stamps())).toBe(was);
});

// Exact rejected Uq4QIR raw files. Tests bind copies to current source solely to
// exercise the final CLI offline. The rejected delivery and its report never change.
const recordedNativeBundle="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";

function recordedCopy(){
 const dir=mkdtempSync(join(tmpdir(),'agility-recorded-'));
 const bundle=JSON.parse(unpack(recordedNativeBundle).toString());
 for(const [name,b64] of Object.entries(bundle))writeFileSync(join(dir,name),Buffer.from(b64 as string,'base64'));
 const meta=JSON.parse(readFileSync(join(dir,'native.json'),'utf8'));
 const root=resolve(import.meta.dir,'../../..');
 // Source bytes are stable for this test process. The production verifier still
 // recomputes them on every call; avoid hashing the whole runtime twice per attack.
 meta.source=recoveryTestSource??=sources();
 meta.format=NATIVE_FORMAT;meta.at=Date.now();
 for(const s of meta.fall.samples){
  s.at=meta.at-1;
  const p=join(dir,'initial-'+s.fixture+'.json'),init=JSON.parse(readFileSync(p,'utf8'));
  init.binding=bindInitialization(dir,s.fixture,s.name,meta.source);
  init.checks=initializationEvidenceChecks(readPracticeSave(join(dir,'initial-'+s.fixture+'-before.sav')),
   readPracticeSave(join(dir,'initial-'+s.fixture+'-after.sav')),readFileSync(join(dir,'initial-'+s.fixture+'.log'),'utf8'),init.child,s.name);
  s.initialization=init.binding;writeFileSync(p,JSON.stringify(init));
 }
 writeFileSync(join(dir,'native.json'),JSON.stringify(meta));return{dir,meta};
}
function rebindCopy(dir:string,meta:any){
 const s=meta.fall.samples[0],p=join(dir,'initial-5.json'),init=JSON.parse(readFileSync(p,'utf8'));
 init.binding=bindInitialization(dir,5,s.name,meta.source);s.initialization=init.binding;
 // Recorded predicates deliberately stay true. They cannot cover a raw mutation.
 writeFileSync(p,JSON.stringify(init));
 s.sha256=Object.fromEntries(['before','after','log'].map(k=>[k,digest(readFileSync(join(dir,'fall-1'+(k==='log'?'.log':'-'+k+'.sav'))))]));
 writeFileSync(join(dir,'native.json'),JSON.stringify(meta));
}

// A synthetic integration bundle exercises the actual read-only CLI, never a native receipt.
function evidenceTree(dir:string):Record<string,string>{
 const result:Record<string,string>={};
 const walk=(base:string)=>{for(const entry of readdirSync(join(dir,base),{withFileTypes:true})){
  const name=join(base,entry.name);if(entry.isDirectory()){result[name+'/']='directory';walk(name);}
  else result[name]=digest(readFileSync(join(dir,name)));
 }};walk('');return result;
}
test('actual --verify CLI leaves all evidence names and bytes unchanged on success and failure',async()=>{
 const {dir}=recordedCopy(),food=recoveryUnitBundle();
 try{
  cpSync(food.dir,join(dir,'food-recovery'),{recursive:true});
  const generated=verificationReport(dir);
  expect(Object.entries(generated.checks).filter(([,v])=>!v)).toEqual([]);
  writeFileSync(join(dir,'consumer.json'),JSON.stringify(generated));
  const cli=async()=>{const p=Bun.spawn([process.execPath,'packages/practice/src/agility-order-proof.ts','--verify'],
   {cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,DELIVERY_DIR:dir},stdout:'pipe',stderr:'pipe',windowsHide:true,timeout:10000});
   const [status,stdout,stderr]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);return{status,stdout,stderr};};
  let tree=evidenceTree(dir),child=await cli();
  expect(child.status).toBe(0);expect(JSON.parse(child.stdout.trim()).ok).toBe(true);
  expect(evidenceTree(dir)).toEqual(tree);
  // Imported functions have the same read-only contract.
  expect(verify(dir).ok).toBe(true);expect(evidenceTree(dir)).toEqual(tree);
  writeFileSync(join(dir,'food-recovery','inflight-1.log'),food.ilog.replace('"anim":741','"anim":-1'));
  tree=evidenceTree(dir);child=await cli();expect(child.status).toBe(1);expect(JSON.parse(child.stdout.trim()).ok).toBe(false);
  expect(evidenceTree(dir)).toEqual(tree);expect(verify(dir).ok).toBe(false);expect(evidenceTree(dir)).toEqual(tree);
  unlinkSync(join(dir,'consumer.json'));tree=evidenceTree(dir);child=await cli();expect(child.status).toBe(1);
  expect(evidenceTree(dir)).toEqual(tree);
 }finally{rmSync(dir,{recursive:true,force:true});rmSync(food.dir,{recursive:true,force:true});}
},30000);
function mutateSave(path:string,edit:(bytes:Buffer)=>void,crc=true){
 const b=Buffer.from(readFileSync(path));edit(b);
 if(crc)b.writeUInt32BE(Bun.hash.crc32(b.subarray(0,-4))>>>0,b.length-4);
 writeFileSync(path,b);
}
// Locate serialized fields without assuming the v6 and v9 variable sections have
// the same size. Offsets follow the existing readPracticeSave layout.
function savedFields(b:Buffer){
 let at=135;const vars=new Map<number,number>(),n=b.readUInt16BE(133),version=b.readUInt16BE(2);
 for(let i=0;i<n;i++){
  if(version<7){vars.set(i,at+3);at+=4;}
  else{const id=b.readUInt16BE(at);at+=2;while(b[at]!&128)at++;vars.set(id,at++);}
 }
 const entries:{inv:number;slot:number;id:number;start:number;end:number;count:number}[]=[];
 const invs=b[at++]!;
 for(let i=0;i<invs;i++){
  const inv=b.readUInt16BE(at),size=b.readUInt16BE(at+2);at+=4;
  for(let slot=0;slot<size;slot++){
   const start=at,id=b.readUInt16BE(at)-1;at+=2;
   if(id<0){entries.push({inv,slot,id,start,end:at,count:at});continue;}
   const short=b[at++]!,count=short===255?at:at-1;if(short===255)at+=4;
   entries.push({inv,slot,id,start,end:at,count});
  }
 }
 return{vars,entries};
}
const rawMutations:{name:string;edit:(b:Buffer)=>void}[]=[
 {name:'raw fractional XP',edit:b=>b.writeInt32BE(b.readInt32BE(28)+1,28)},
 {name:'Agility raw XP',edit:b=>b.writeInt32BE(b.readInt32BE(108)+1,108)},
 {name:'current level',edit:b=>b[32]=b[32]!+1},
 {name:'HP level',edit:b=>b[47]=b[47]!-1},
 {name:'x',edit:b=>b.writeUInt16BE(b.readUInt16BE(4)+1,4)},
 {name:'z',edit:b=>b.writeUInt16BE(b.readUInt16BE(6)+1,6)},
 {name:'plane',edit:b=>b[8]=1},
 {name:'asset item',edit:b=>{const e=savedFields(b).entries.find(e=>e.inv===94&&e.id>=0)!;b.writeUInt16BE(e.id+2,e.start);}},
 {name:'asset count',edit:b=>{const e=savedFields(b).entries.find(e=>e.inv===95&&e.id===995)!;b.writeInt32BE(b.readInt32BE(e.count)-1,e.count);}},
 {name:'asset slot',edit:b=>{
  const entries=savedFields(b).entries,e=entries.find(e=>e.inv===94&&e.slot===3)!,empty=entries.find(e=>e.inv===94&&e.slot===4)!;
  // Empty slots encode only the id. Remove and insert the count byte as the
  // equipped item moves one slot, preserving the serialized container length.
  const item=Buffer.from(b.subarray(e.start,e.end));
  Buffer.concat([b.subarray(0,e.start),Buffer.from([0,0]),item,b.subarray(empty.end)]).copy(b);
 }},
 {name:'unsupported varp',edit:b=>{const at=savedFields(b).vars.get(300)!;b[at]=b[at]!^1;}},
];

test('recorded initialization is CRC-read but final --verify rejects old food-free bundles',()=>{
 const {dir}=recordedCopy();
 try{
  const read=readFallSamples(dir).read('fall-1')!;
  expect(read.initialFiles!.sha256.after).toBe(read.sha256.before);
  expect(Object.values(read.initial.checks).every(Boolean)).toBe(true);
  const child=spawnSync(process.execPath,['packages/practice/src/agility-order-proof.ts','--verify'],
   {cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,DELIVERY_DIR:dir},encoding:'utf8',windowsHide:true,timeout:10000});
  expect(child.error).toBeUndefined();expect(child.status).toBe(1);
  const result=JSON.parse(child.stdout.trim());expect(result.ok).toBe(false);expect(result.checks['fall-1.initialized']).toBe(true);
  expect(result.checks['food.files']).toBe(false);
  // The final CLI must also reject the historical readable-only flags.
  const p=join(dir,'initial-5.json'),init=JSON.parse(readFileSync(p,'utf8'));init.checks={readable:true};writeFileSync(p,JSON.stringify(init));
  const rejected=spawnSync(process.execPath,['packages/practice/src/agility-order-proof.ts','--verify'],
   {cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,DELIVERY_DIR:dir},encoding:'utf8',windowsHide:true,timeout:10000});
  expect(rejected.status).toBe(1);expect(JSON.parse(rejected.stdout.trim()).checks['fall-1.initialized']).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
},30000);

test('final verifier rejects every missing initialization file, CRC failure, substitution and incomplete binding',()=>{
 const attacks:{name:string;edit:(dir:string,meta:any)=>void}[]=[
  ...['-before.sav','-after.sav','.log'].map(suffix=>({name:'missing '+suffix,edit:(dir:string)=>unlinkSync(join(dir,'initial-5'+suffix))})),
  ...['before','after'].map(which=>({name:'CRC '+which,edit:(dir:string)=>mutateSave(join(dir,'initial-5-'+which+'.sav'),b=>b[50]=b[50]!^1,false)})),
  {name:'unreadable log path',edit:dir=>{unlinkSync(join(dir,'initial-5.log')); /* Missing and EISDIR both fail closed. */
   // A directory cannot serve as the initialization log.
   require('node:fs').mkdirSync(join(dir,'initial-5.log'));}},
  {name:'foreign account log',edit:(dir,meta)=>{const p=join(dir,'initial-5.log');writeFileSync(p,readFileSync(p,'utf8').replace(meta.fall.samples[0].name,'otheragi5'));rebindCopy(dir,meta);}},
  {name:'foreign fixture metadata',edit:dir=>{const p=join(dir,'initial-5.json'),v=JSON.parse(readFileSync(p,'utf8'));v.index=8;writeFileSync(p,JSON.stringify(v));}},
  {name:'substituted save',edit:dir=>copyFileSync(join(fallDir,'initial-8-after.sav'),join(dir,'initial-5-after.sav'))},
  {name:'hash mismatch',edit:dir=>writeFileSync(join(dir,'initial-5.log'),readFileSync(join(dir,'initial-5.log'),'utf8')+'\n')},
  ...['checks','binding'].map(key=>({name:'missing '+key,edit:(dir:string)=>{const p=join(dir,'initial-5.json'),v=JSON.parse(readFileSync(p,'utf8'));delete v[key];writeFileSync(p,JSON.stringify(v));}})),
  {name:'sample binding missing',edit:(dir,meta)=>{delete meta.fall.samples[0].initialization;writeFileSync(join(dir,'native.json'),JSON.stringify(meta));}},
  {name:'source mismatch',edit:dir=>{const p=join(dir,'initial-5.json'),v=JSON.parse(readFileSync(p,'utf8'));v.binding.source.runtime='foreign';writeFileSync(p,JSON.stringify(v));}},
  {name:'configuration mismatch',edit:dir=>{const p=join(dir,'initial-5.json'),v=JSON.parse(readFileSync(p,'utf8'));v.binding.configuration.target=2;writeFileSync(p,JSON.stringify(v));}},
  ...['RESULT fail Error: already at target','LOGOUT logged-out'].map(line=>({name:'missing '+line,edit:(dir:string,meta:any)=>{const p=join(dir,'initial-5.log');writeFileSync(p,readFileSync(p,'utf8').replace(line,''));rebindCopy(dir,meta);}})),
  {name:'failed initialization child',edit:dir=>{const p=join(dir,'initial-5.json'),v=JSON.parse(readFileSync(p,'utf8'));v.child.timedOut=true;writeFileSync(p,JSON.stringify(v));}},
 ];
 for(const attack of attacks){const {dir,meta}=recordedCopy();try{
  attack.edit(dir,meta);const result=verify(dir);
  expect(result.ok,attack.name).toBe(false);expect(result.checks.fall,attack.name).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}}
},30000);

test('final verifier independently rejects CRC-valid raw mutations even with refreshed file hashes',()=>{
 for(const which of ['before','after'] as const)for(const mutation of rawMutations){const {dir,meta}=recordedCopy();try{
  mutateSave(join(dir,'initial-5-'+which+'.sav'),mutation.edit);rebindCopy(dir,meta);
  expect(readFallSamples(dir).read('fall-1'),which+' '+mutation.name).toBeDefined();
  const result=verify(dir);expect(result.ok,which+' '+mutation.name).toBe(false);
  expect(result.checks['fall-1.initialized'],which+' '+mutation.name).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}}
 // No additional session-varp transition is allowed across the initialized
 // after-save -> sample before-save boundary, even the ordinary logout clock.
 for(const mutation of [...rawMutations,{name:'logout clock',edit:(b:Buffer)=>{const at=savedFields(b).vars.get(134)!;b[at]=b[at]!^1;}}]){
  const {dir,meta}=recordedCopy();try{
   mutateSave(join(dir,'fall-1-before.sav'),mutation.edit);rebindCopy(dir,meta);
   const result=verify(dir);expect(result.checks['fall-1.initialBaseline'],mutation.name).toBe(false);
   expect(result.ok,mutation.name).toBe(false);
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
},30000);

test('baseline binding rejects mutation of raw fields outside the decoded projection',()=>{
 const {dir,meta}=recordedCopy();try{
  mutateSave(join(dir,'fall-1-before.sav'),b=>b[9]=b[9]!^1);rebindCopy(dir,meta);
  expect(verify(dir).checks['fall-1.initialBaseline']).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

// Synthetic Gnome delivery: unit evidence for the read-only verifier only, never a native receipt.
const gcrc=(b:Buffer)=>{b.writeUInt32BE(Bun.hash.crc32(b.subarray(0,-4))>>>0,b.length-4);return b;};
function gv9(input:Buffer){
 const count=input.readUInt16BE(133),entries:Buffer[]=[];
 for(let id=0;id<count;id++){
  let value=input.readInt32BE(135+id*4)>>>0;if(!value)continue;
  const bytes=[value&127];while((value>>>=7)>0)bytes.unshift((value&127)|128);
  const entry=Buffer.alloc(2);entry.writeUInt16BE(id);entries.push(Buffer.concat([entry,Buffer.from(bytes)]));
 }
 const n=Buffer.alloc(2);n.writeUInt16BE(entries.length);
 const out=Buffer.concat([input.subarray(0,133),n,...entries,input.subarray(135+count*4)]);out.writeUInt16BE(9,2);return gcrc(out);
}
const minXp=(level:number)=>{let lo=0,hi=2e8;while(lo<hi){const m=Math.floor((lo+hi)/2);if(trainedLevel(m)>=level)hi=m;else lo=m+1;}return lo;};
// Dense v6 edits before the v9 conversion.
const setVar=(b:Buffer,id:number,v:number)=>{b.writeInt32BE(v,135+id*4);return b;};
const setAgility=(b:Buffer,level:number)=>{b.writeInt32BE(minXp(level)*10,108);b[112]=level;return b;};
const setPos=(b:Buffer,p:{x:number;z:number;level:number})=>{b.writeUInt16BE(p.x,4);b.writeUInt16BE(p.z,6);b[8]=p.level;return b;};
function setSlot(b:Buffer,inv:number,slot:number,id:number|null,count=1){
 const e=savedFields(b).entries.find(v=>v.inv===inv&&v.slot===slot)!;
 const item=id===null?Buffer.from([0,0]):Buffer.concat([Buffer.from([(id+1)>>8,(id+1)&255]),count<255?Buffer.from([count]):Buffer.from([255,count>>>24,(count>>16)&255,(count>>8)&255,count&255])]);
 return Buffer.concat([b.subarray(0,e.start),item,b.subarray(e.end)]);
}
const gChild={code:0,timedOut:false,interrupted:false},gRefusal={code:1,timedOut:false,interrupted:false};
const tail=(name:string,ok:boolean,reason='')=>`LEDGER ticks=40 bot=${name}\nLOGOUT logged-out\nRESULT ${ok?'ok agility-order gnome':'fail Error: '+reason}\n`;
const gResult=(target:number,level:number,extra:Record<string,unknown>={})=>'AGILITY_ORDER_RESULT '+JSON.stringify({ok:true,course:'gnome',target,level,xpGained:minXp(level),...extra})+'\n';
const gDispatch=(tick:number,ops:number,step:string)=>'AGILITY_ACTION '+JSON.stringify({event:'dispatch',tick,at:'2474,3437,0',anim:-1,rejected:0,mapFlags:0,hp:70,xp:0,ops,messages:[],step,locId:1,x:1,z:1,speculative:false,actionId:ops})+'\n';
// Exact owned-food events: dispatch, the one food packet, reply, observations and effect per heal.
function gFoodLog(inventory:{slot:number;id:number;count:number}[],o:{heals:number;hp:number;base:number;heal:number;id:number}){
 let inv=structuredClone(inventory),out='',held=inv.filter(i=>i.id===o.id).length;
 for(let i=0;i<o.heals;i++){
  const at=10+i*4,sequence=i+1,hp=o.hp+i*o.heal,slot=inv.find(v=>v.id===o.id)!.slot;
  if(i)out+='AGILITY_FOOD '+JSON.stringify({event:'cooldown',sequence,tick:at-3,lastEffectTick:at-3,readyAfter:at-1})+'\n';
  const d={sequence,slot,id:o.id,held:held-i,tick:at,hp,baseHp:o.base,xp:0,count:held-i,inventory:structuredClone(inv),at:'2474,3437,0',workerOps:i,anim:-1,dialog:null,rejected:0,ops:0,messages:[]};
  out+='AGILITY_FOOD '+JSON.stringify({event:'dispatch',...d})+'\n';
  out+='AGILITY_ACTION '+JSON.stringify({event:'food',tick:at,at:'2474,3437,0',anim:-1,rejected:0,mapFlags:0,hp,xp:0,ops:i+1,messages:[],sequence,slot,id:o.id})+'\n';
  out+=['reply','observation'].map(event=>'AGILITY_FOOD '+JSON.stringify({event,...d,ops:1,workerOps:i+1,...(event==='reply'?{reply:{success:true}}:{})})).join('\n')+'\n';
  inv=inv.filter(v=>v.slot!==slot);
  const effect={...d,tick:at+1,hp:Math.min(o.base,hp+o.heal),count:held-i-1,inventory:structuredClone(inv),ops:1,workerOps:i+1,anim:829,messages:[{tick:at+1,text:'You eat.'}]};
  out+='AGILITY_FOOD '+JSON.stringify({event:'observation',...effect})+'\nAGILITY_FOOD '+JSON.stringify({event:'effect',...effect,hpTick:at+1,inventoryTick:at+1})+'\n';
 }
 return out;
}
type GRec=Record<string,any>;
// One case. A fixture case writes its CRC-valid initialization pair; the case before-save is its after-save.
function gCase(dir:string,source:unknown,o:{label:string;fixture:number|null;name:string;course?:string;target:number;preset?:any;hp?:number;raw?:Buffer;before?:Buffer;
 edit:(b:Buffer)=>Buffer;log:string|((before:Save)=>string);child?:typeof gChild;logout?:number}):{rec:GRec;final:Buffer}{
 const raw=o.raw??(()=>{const b=Buffer.from(createSaveData(agilityFixturePreset({...o.preset,varps:{...o.preset.varps,134:10}})));if(o.hp!==undefined)b[47]=o.hp;return gcrc(b);})();
 let initialization:unknown=null;
 if(o.fixture!==null){
  const init=Buffer.from(raw);init.writeInt32BE(9,135+134*4);
  writeFileSync(join(dir,`initial-${o.fixture}-before.sav`),gcrc(init));writeFileSync(join(dir,`initial-${o.fixture}-after.sav`),gv9(Buffer.from(raw)));
  const log=`LEDGER ticks=1 bot=${o.name}\nLOGOUT logged-out\nRESULT fail Error: already at target\n`;writeFileSync(join(dir,`initial-${o.fixture}.log`),log);
  initialization=bindInitialization(dir,o.fixture,o.name,source);
  writeFileSync(join(dir,`initial-${o.fixture}.json`),JSON.stringify({name:o.name,index:o.fixture,child:gRefusal,binding:initialization,
   checks:initializationEvidenceChecks(readPracticeSave(join(dir,`initial-${o.fixture}-before.sav`)),readPracticeSave(join(dir,`initial-${o.fixture}-after.sav`)),log,gRefusal,o.name)}));
  copyFileSync(join(dir,`initial-${o.fixture}-after.sav`),join(dir,o.label+'-before.sav'));
 }else writeFileSync(join(dir,o.label+'-before.sav'),o.before!);
 const final=setVar(o.edit(Buffer.from(raw)),134,o.logout??11);
 writeFileSync(join(dir,o.label+'-after.sav'),gv9(gcrc(Buffer.from(final))));
 writeFileSync(join(dir,o.label+'.log'),typeof o.log==='string'?o.log:o.log(readPracticeSave(join(dir,o.label+'-before.sav'))));
 return{final,rec:{label:o.label,fixture:o.fixture,course:o.course??'gnome',target:o.target,name:o.name,child:o.child??gChild,saveMatched:true,at:Date.now(),
  initialization,sha256:caseHashesOf(dir,o.label)}};
}
const caseHashesOf=(dir:string,label:string)=>({before:digest(readFileSync(join(dir,label+'-before.sav'))),after:digest(readFileSync(join(dir,label+'-after.sav'))),log:digest(readFileSync(join(dir,label+'.log')))});
const ASSETS={bank:[{id:995,count:12345},{id:1511,count:13}],equipment:[{id:1351,count:1,slot:3}]};
const AFTER_POS={x:2474,z:3428,level:0};
function gnomeDelivery(){
 const root=mkdtempSync(join(tmpdir(),'agility-gnome-unit-')),source=recoveryTestSource??=sources(),dirs:Record<string,string>={};
 for(const k of ['gnome-food','ardougne','gnome-consumer']){dirs[k]=join(root,k);mkdirSync(dirs[k]!);}
 const metas:Record<string,any>={};
 // Gnome food: the bound consecutive-heal fixture and its retained mid-course restart copy.
 const foodCases=[FOOD_RECOVERY_CONFIGURATION,GNOME_FOOD_RESTART_CONFIGURATION].map(C=>{
  const label=C===FOOD_RECOVERY_CONFIGURATION?'food':'food-restart',name='unitfood'+C.fixture,step=label==='food'?'log':'net';
  const preset={position:C.position,skills:{Hitpoints:C.baseHp},inventory:Array.from({length:C.foodCount},()=>({id:C.foodId,count:1})),...ASSETS};
  const log=(before:Save)=>gFoodLog(before.inventories[93]!,{heals:3,hp:C.currentHp,base:C.baseHp,heal:C.heal,id:C.foodId})+gDispatch(24,4,step)
   +`AGILITY_PROGRESS level=2 xp=${minXp(2)} tick=26 step=${step}\n`+gResult(2,2,{eats:3})+tail(name,true);
  return gCase(dirs['gnome-food']!,source,{label,fixture:C.fixture,name,target:2,preset,hp:C.currentHp,log,
   edit:b=>{b[47]=C.currentHp+3*C.heal;setAgility(b,2);for(const s of [2,1,0])b=setSlot(b,93,s,null);return b;}}).rec;
 });
 metas['gnome-food']={format:GNOME_FOOD_CONFIGURATION.format,source,configuration:GNOME_FOOD_CONFIGURATION,cases:foodCases,at:Date.now()};
 // Ordinary Ardougne-town entry: one owned-salmon heal from HP3, gate route, Femi, crossing, Agility10.
 const A=ARDOUGNE_ENTRY_CONFIGURATION,aname='unitardy14';
 const apreset={position:A.position,skills:A.skills,inventory:Array.from({length:A.foodCount},()=>({id:A.foodId,count:1})),bank:A.bank.map(i=>({...i})),equipment:[]};
 const walk=(label:string,at:{x:number;z:number})=>'AGILITY_ENTRY_WALK '+JSON.stringify({label,attempt:0,first:null,current:{ok:true,at:{...at,level:0}}})+'\n';
 const alog=(before:Save)=>'AGILITY_ENTRY_ROUTE '+JSON.stringify({route:'gate',at:'2654,3283,0',tick:5})+'\n'
  +gFoodLog(before.inventories[93]!,{heals:1,hp:A.currentHp,base:A.baseHp,heal:A.heal,id:A.foodId})+walk('walk to Stronghold gate',{x:2461,z:3382})
  +'AGILITY_ENTRY_GATE '+JSON.stringify(completedGate())+'\n'+walk('course approach',{x:2474,z:3437})
  +'AGILITY_ENTRY '+JSON.stringify({route:'walk',fares:0,foodBought:0,coinsSpent:0,eats:1,tick:300,at:'2474,3437,0'})+'\n'
  +gDispatch(301,2,'log')+`AGILITY_PROGRESS level=10 xp=${minXp(10)} tick=400 step=pipe\n`+gResult(10,10,{eats:1,finalHp:10})+tail(aname,true);
 const ardougne=gCase(dirs.ardougne!,source,{label:'ardougne-entry',fixture:14,name:aname,target:10,preset:apreset,hp:A.currentHp,log:alog,
  edit:b=>{b[47]=10;setAgility(b,10);setPos(b,AFTER_POS);setVar(b,152,2);setVar(b,264,6);return setSlot(b,93,0,null);}}).rec;
 metas.ardougne={format:ARDOUGNE_CONFIGURATION.format,source,configuration:ARDOUGNE_CONFIGURATION,cases:[ardougne],at:Date.now()};
 // Consumer cases: approach, abrupt interruption + no-reseed restart, and refusals.
 const C=dirs['gnome-consumer']!,cases:GRec[]=[];
 const plan=(label:string)=>GNOME_CONSUMER_PLAN.find(p=>p.label===label)!;
 const preset=(label:string)=>({...(plan(label).course==='wilderness'?PRESETS.agility_wilderness_49!:PRESETS.agility_gnome_1!),position:plan(label).start,...ASSETS});
 const progressLog=(name:string,level:number,xp=minXp(level))=>gDispatch(12,1,'log')+`AGILITY_PROGRESS level=${level} xp=${xp} tick=20 step=pipe\n`+gResult(level,level)+tail(name,true);
 const approach=gCase(C,source,{label:'approach',fixture:1,name:'unitgnome1',target:10,preset:preset('approach'),log:progressLog('unitgnome1',10),
  edit:b=>{setAgility(b,10);setPos(b,AFTER_POS);return setVar(b,264,6);}});
 cases.push(approach.rec);
 const rname='unitgnome2',rraw=gcrc(Buffer.from(createSaveData(agilityFixturePreset({...preset('restart'),varps:{134:10}}))));
 const middle=setVar(setVar(setPos(Buffer.from(rraw),{x:2474,z:3424,level:1}),264,2),134,12);
 middle.writeInt32BE(3750,108);middle[112]=trainedLevel(375);
 writeFileSync(join(C,'interrupted.sav'),gv9(gcrc(middle)));
 writeFileSync(join(C,'interrupted.log'),gDispatch(2,1,'log')+'AGILITY_PROGRESS level=3 xp=187 tick=13 step=log\n'
  +gDispatch(13,2,'net').replace('"xp":0','"xp":187').replace('2474,3437,0','2474,3429,0'));
 writeFileSync(join(C,'interrupted-engine.log'),`[LOGOUT DEBUG] Server requesting idle logout for ${rname} - ticksSinceConnected=500, timeout=500\n[LOGOUT DEBUG] Server removePlayer() called for ${rname}\n`);
 const restart=gCase(C,source,{label:'restart',fixture:2,name:rname,target:20,raw:rraw,logout:13,
  log:gDispatch(12,1,'net')+`AGILITY_PROGRESS level=20 xp=${minXp(20)} tick=20 step=net\n`+gResult(20,20)+tail(rname,true),edit:b=>setAgility(b,20)});
 cases.push({...restart.rec,interrupted:{code:1,timedOut:false,interrupted:true},middleSha256:digest(readFileSync(join(C,'interrupted.sav')))});
 copyFileSync(join(C,'restart-before.sav'),join(C,'interrupted-at-kill.sav'));
 copyFileSync(join(C,'interrupted.sav'),join(C,'restart-prelaunch.sav'));
 const initial='AGILITY_INITIAL '+JSON.stringify({name:rname,course:'gnome',target:20,tick:1,
  state:restartInitialProjection(readPracticeSave(join(C,'restart-prelaunch.sav')))})+'\n';
 writeFileSync(join(C,'restart.log'),initial+readFileSync(join(C,'restart.log'),'utf8'));
 cases.at(-1)!.sha256=caseHashesOf(C,'restart');
 const interruptedChecks=interruptionSaveChecks(readPracticeSave(join(C,'restart-before.sav')),readPracticeSave(join(C,'interrupted.sav')),20,
  readFileSync(join(C,'interrupted.log'),'utf8'),readFileSync(join(C,'interrupted-engine.log'),'utf8'),rname);
 const restartRecord=cases.at(-1)!;
 writeFileSync(join(C,'interrupted.log'),'AGILITY_INITIAL '+JSON.stringify({name:rname,course:'gnome',target:20,tick:1,
  state:restartInitialProjection(readPracticeSave(join(C,'restart-before.sav')))})+'\n'+readFileSync(join(C,'interrupted.log'),'utf8'));
 restartRecord.restartBinding={format:'agility-restart-2',name:rname,course:'gnome',target:20,source,configuration:GNOME_CONSUMER_CONFIGURATION,
  termination:restartRecord.interrupted,sha256:Object.fromEntries(['restart-before.sav','interrupted-at-kill.sav','interrupted.sav','restart-prelaunch.sav','interrupted.log','interrupted-engine.log']
   .map(p=>[p,digest(readFileSync(join(C,p)))]))};
 writeFileSync(join(C,'interruption.json'),JSON.stringify({name:rname,course:'gnome',target:20,interrupted:restartRecord.interrupted,
  interruption:{matched:true,checks:interruptedChecks},restartBinding:restartRecord.restartBinding}));
 restartRecord.interruptionSha256=digest(readFileSync(join(C,'interruption.json')));
 const rerun=gCase(C,source,{label:'rerun',fixture:null,name:'unitgnome1',target:10,raw:approach.final,before:readFileSync(join(C,'approach-after.sav')),
  logout:12,child:gRefusal,log:tail('unitgnome1',false,'already at target'),edit:b=>b});
 cases.push(rerun.rec);
 for(const [label,fixture,name] of [['wilderness-entry',4,'unitgnome4'],['region',15,'unitgnom15'],['plane',16,'unitgnom16']] as const){
  const p=plan(label);cases.push(gCase(C,source,{label,fixture,name,course:p.course,target:p.target,preset:preset(label),child:gRefusal,
   log:tail(name,false,p.reason!),edit:b=>b}).rec);
 }
 metas['gnome-consumer']={format:GNOME_CONSUMER_CONFIGURATION.format,source,configuration:GNOME_CONSUMER_CONFIGURATION,cases,at:Date.now()};
 // Existing Draynor gate evidence in the delivery root.
 const dname='unitdray6';
 const dlog=['AGILITY_ENTRY_PURCHASE {"item":"/^banana$/i","sdkSuccess":true,"bought":1,"spent":2,"coins":438,"tick":40}',
  'AGILITY_ENTRY_PURCHASE {"item":"/^banana$/i","sdkSuccess":true,"bought":1,"spent":2,"coins":436,"tick":41}',
  'AGILITY_ENTRY_PURCHASE {"item":"/^banana$/i","sdkSuccess":true,"bought":1,"spent":2,"coins":434,"tick":42}',
  'AGILITY_ENTRY_FARE {"leg":"sail to Karamja","paid":30,"coins":404,"tick":80}','AGILITY_ENTRY_FARE {"leg":"sail to Ardougne","paid":30,"coins":374,"tick":300}',
  'AGILITY_ENTRY_GATE '+JSON.stringify({...completedGate(),tick:600}),
  'AGILITY_ENTRY {"route":"draynor","fares":2,"foodBought":3,"coinsSpent":66,"eats":2,"tick":700,"at":"2474,3437,0"}',
  gDispatch(701,1,'log').trim(),`AGILITY_PROGRESS level=10 xp=${minXp(10)} tick=760 step=pipe`,
  gResult(10,10,{eats:2,entry:{route:'draynor',coinsSpent:66}}).trim()].join('\n')+'\n'+tail(dname,true);
 const draynor=gCase(root,source,{label:'draynor-entry',fixture:6,name:dname,target:10,preset:{position:DRAYNOR_START,coins:440,bank:[{id:995,count:15606},{id:1511,count:13}],equipment:[]},
  log:dlog,edit:b=>{setAgility(b,10);setPos(b,AFTER_POS);setVar(b,152,2);return setSlot(setSlot(b,93,0,995,374),93,1,1963,1);}}).rec;
 metas.draynor={at:Date.now(),source,case:draynor};
 // Existing retained eastern-entry gate: exact copied bytes from a separate retained file.
 const keep=mkdtempSync(join(tmpdir(),'agility-retained-')),original=join(keep,'draynor-entry-after.sav'),cname='unitretain7';
 const craw=setVar(gcrc(Buffer.from(createSaveData(agilityFixturePreset({position:{x:2494,z:3437,level:0},...ASSETS})))),134,500);
 writeFileSync(original,gv9(gcrc(craw)));
 const clog='AGILITY_ENTRY_GATE '+JSON.stringify(completedGate())+'\nAGILITY_ENTRY '+JSON.stringify({route:'walk',fares:0,foodBought:0,coinsSpent:0,eats:0})+'\n'
  +gDispatch(91,1,'log')+`AGILITY_PROGRESS level=10 xp=${minXp(10)} tick=120 step=pipe\n`+gResult(10,10)+tail(cname,true);
 const retainedCase=gCase(root,source,{label:'course-approach',fixture:null,name:cname,target:10,raw:craw,before:readFileSync(original),logout:188,log:clog,
  edit:b=>{setAgility(b,10);setPos(b,AFTER_POS);setVar(b,152,2);return setVar(b,264,6);}}).rec;
 metas.retained={...retainedCase,source,original,originalSha256:digest(readFileSync(original))};
 const g=gnomeHandle(root,keep,dirs,metas,source);g.write();return g;
}
// Each attack mutates its own byte copy of one built delivery.
let gnomeTemplate:ReturnType<typeof gnomeDelivery>|undefined;
afterAll(()=>gnomeTemplate?.cleanup());
function gnomeCopy(){
 const t=gnomeTemplate??=gnomeDelivery(),root=mkdtempSync(join(tmpdir(),'agility-gnome-copy-')),keep=mkdtempSync(join(tmpdir(),'agility-retained-copy-'));
 cpSync(t.root,root,{recursive:true});
 const dirs=Object.fromEntries(['gnome-food','ardougne','gnome-consumer'].map(k=>[k,join(root,k)]));
 const metas:Record<string,any>=Object.fromEntries(['gnome-food','ardougne','gnome-consumer'].map(k=>[k,JSON.parse(readFileSync(join(dirs[k]!,k+'.json'),'utf8'))]));
 metas.draynor=JSON.parse(readFileSync(join(root,'draynor.json'),'utf8'));
 metas.retained=JSON.parse(readFileSync(join(root,'course-approach.json'),'utf8'));
 const original=join(keep,'draynor-entry-after.sav');copyFileSync(metas.retained.original,original);metas.retained.original=original;
 const g=gnomeHandle(root,keep,dirs,metas,t.source);g.write();return g;
}
function gnomeHandle(root:string,keep:string,dirs:Record<string,string>,metas:Record<string,any>,source:unknown){
 const write=()=>{
  for(const k of ['gnome-food','ardougne','gnome-consumer'])writeFileSync(join(dirs[k]!,k+'.json'),JSON.stringify(metas[k]));
  writeFileSync(join(root,'draynor.json'),JSON.stringify(metas.draynor));
  const cb=readPracticeSave(join(root,'course-approach-before.sav')),ca=readPracticeSave(join(root,'course-approach-after.sav'));
  metas.retained.checks={saveMatched:true,originalPreserved:true,...retainedApproachChecks(cb,ca,10,readFileSync(join(root,'course-approach.log'),'utf8'),gChild)};
  metas.retained.ok=Object.values(metas.retained.checks).every(Boolean);
  writeFileSync(join(root,'course-approach.json'),JSON.stringify(metas.retained));
  const db=readPracticeSave(join(root,'draynor-entry-before.sav')),da=readPracticeSave(join(root,'draynor-entry-after.sav')),dl=readFileSync(join(root,'draynor-entry.log'),'utf8');
  writeFileSync(join(root,'draynor-consumer.json'),JSON.stringify({ok:true,checks:{saveMatched:true,...draynorEntryChecks(db,da,10,dl).checks,...childChecks(gChild,dl,'progress')}}));
  const now=Date.now();
  for(const [k,v] of [['gnome-food',verifyGnomeFood],['ardougne',verifyArdougneEntry],['gnome-consumer',verifyGnomeConsumer]] as const){
   const checks=v(dirs[k]!,source,now,false).checks;
   writeFileSync(join(dirs[k]!,'consumer.json'),JSON.stringify({ok:Object.values(checks).every(Boolean),at:now,scope:GNOME_SCOPE,source,checks}));
  }
 };
 // Refresh recorded hashes after a deliberate raw edit, so only the recomputed predicate can reject it.
 const rehash=()=>{
  for(const [k,list] of [['gnome-food',metas['gnome-food'].cases],['ardougne',metas.ardougne.cases],['gnome-consumer',metas['gnome-consumer'].cases]] as const)
   for(const r of list)r.sha256=caseHashesOf(dirs[k]!,r.label);
  metas.draynor.case.sha256=caseHashesOf(root,'draynor-entry');metas.retained.sha256=caseHashesOf(root,'course-approach');
 };
 return{root,dirs,metas,source,write,rehash,cleanup:()=>{rmSync(root,{recursive:true,force:true});rmSync(keep,{recursive:true,force:true});}};
}
const failed=(checks:Record<string,boolean>)=>Object.entries(checks).filter(([,v])=>!v).map(([k])=>k);
const gnomeCli=(dir:string)=>spawnSync(process.execPath,['packages/practice/src/agility-order-proof.ts','--verify-gnome'],
 {cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,DELIVERY_DIR:dir},encoding:'utf8',windowsHide:true,timeout:20000});

test('bound restart rejects substituted entry, missing artifacts and rehashed checkpoint mutations through Gnome verification',()=>{
 const rebind=(g:ReturnType<typeof gnomeCopy>)=>{
  const d=g.dirs['gnome-consumer']!,r=g.metas['gnome-consumer'].cases.find((c:any)=>c.label==='restart');
  const j=JSON.parse(readFileSync(join(d,'interruption.json'),'utf8'));
  for(const p of Object.keys(j.restartBinding.sha256))j.restartBinding.sha256[p]=digest(readFileSync(join(d,p)));
  r.restartBinding=j.restartBinding;
  writeFileSync(join(d,'interruption.json'),JSON.stringify(j));r.interruptionSha256=digest(readFileSync(join(d,'interruption.json')));
 };
 const attacks:{name:string;edit:(g:ReturnType<typeof gnomeCopy>,d:string)=>void}[]=[
  ...['interruption.json','interrupted-at-kill.sav','interrupted.sav','restart-prelaunch.sav','interrupted.log','interrupted-engine.log']
   .flatMap(p=>[
    {name:'missing '+p,edit:(_g:any,d:string)=>unlinkSync(join(d,p))},
    {name:'altered '+p,edit:(_g:any,d:string)=>writeFileSync(join(d,p),Buffer.concat([readFileSync(join(d,p)),Buffer.from('\n')]))},
   ]),
  {name:'higher XP initial substitution',edit:(_g,d)=>{
   const p=join(d,'restart.log'),log=readFileSync(p,'utf8'),i=JSON.parse(log.split('\n')[0]!.slice('AGILITY_INITIAL '.length));
   i.state.skills[16].experience+=500;i.state.skills[16].baseLevel=trainedLevel(i.state.skills[16].experience);
   writeFileSync(p,'AGILITY_INITIAL '+JSON.stringify(i)+'\n'+log.split('\n').slice(1).join('\n'));
  }},
  {name:'missing initial observation',edit:(_g,d)=>{const p=join(d,'restart.log');writeFileSync(p,readFileSync(p,'utf8').split('\n').slice(1).join('\n'));}},
  ...['position','inventory','equipment','skills','name','course','target'].map(k=>({name:'initial '+k+' substitution',edit:(_g:any,d:string)=>{
   const p=join(d,'restart.log'),lines=readFileSync(p,'utf8').split('\n'),i=JSON.parse(lines[0]!.slice('AGILITY_INITIAL '.length));
   if(['name','course','target'].includes(k))i[k]='foreign';else i.state[k]=null;
   lines[0]='AGILITY_INITIAL '+JSON.stringify(i);writeFileSync(p,lines.join('\n'));
  }})),
  {name:'initial observation after action',edit:(_g,d)=>{const p=join(d,'restart.log'),l=readFileSync(p,'utf8').split('\n');[l[0],l[1]]=[l[1]!,l[0]!];writeFileSync(p,l.join('\n'));}},
  ...['name','source','configuration','termination'].map(k=>({name:'wrong bound '+k,edit:(g:ReturnType<typeof gnomeCopy>,d:string)=>{
   const r=g.metas['gnome-consumer'].cases.find((c:any)=>c.label==='restart'),j=JSON.parse(readFileSync(join(d,'interruption.json'),'utf8'));
   j.restartBinding[k]='foreign';r.restartBinding=j.restartBinding;writeFileSync(join(d,'interruption.json'),JSON.stringify(j));r.interruptionSha256=digest(readFileSync(join(d,'interruption.json')));
  }})),
  {name:'changed prelaunch with refreshed binding',edit:(g,d)=>{mutateSave(join(d,'restart-prelaunch.sav'),b=>b[32]!--);rebind(g);}},
  ...['interrupted-at-kill.sav','interrupted.sav'].flatMap(p=>[
   {name:p+' raw skill mutation',edit:(g:ReturnType<typeof gnomeCopy>,d:string)=>{mutateSave(join(d,p),b=>b.writeInt32BE(b.readInt32BE(28)+1,28));rebind(g);}},
   {name:p+' current level mutation',edit:(g:ReturnType<typeof gnomeCopy>,d:string)=>{mutateSave(join(d,p),b=>b[32]!--);rebind(g);}},
   {name:p+' unsupported position',edit:(g:ReturnType<typeof gnomeCopy>,d:string)=>{mutateSave(join(d,p),b=>b.writeUInt16BE(3000,4));rebind(g);}},
   {name:p+' impossible raw Agility XP',edit:(g:ReturnType<typeof gnomeCopy>,d:string)=>{mutateSave(join(d,p),b=>{
    b.writeInt32BE(2000,108);b[112]=trainedLevel(200);b.writeUInt16BE(2474,4);b.writeUInt16BE(3429,6);b[8]=0;
   });rebind(g);}},
   {name:p+' asset deletion',edit:(g:ReturnType<typeof gnomeCopy>,d:string)=>{
    const path=join(d,p);writeFileSync(path,gcrc(setSlot(readFileSync(path),93,3,null)));rebind(g);}},
  ]),
 ];
 for(const attack of attacks){const g=gnomeCopy();try{
  attack.edit(g,g.dirs['gnome-consumer']!);g.rehash();g.write();
  const tree=evidenceTree(g.root),r=verifyGnome(g.root,g.source);
  expect(r.ok,attack.name).toBe(false);expect(evidenceTree(g.root),attack.name).toEqual(tree);
  if(attack.name==='higher XP initial substitution'){
   expect(r.checks['consumer.restart.initial']).toBe(false);
   const cli=gnomeCli(g.root);expect(cli.status).toBe(1);expect(evidenceTree(g.root)).toEqual(tree);
  }
 }finally{g.cleanup();}}
},60000);

test('Gnome content binding is required even when metadata agrees with an obsolete or changed source',()=>{
 const path='vendor/rs-sdk/server/content/scripts/skill_agility/scripts/gnome_course.rs2';
 expect(sources().files[path]).toBe(digest(readFileSync(resolve(import.meta.dir,'../../..',path))));
 for(const value of [undefined,'0'.repeat(64)]){const g=gnomeCopy();try{
  const source=structuredClone(g.source) as ReturnType<typeof sources>;
  if(value===undefined)delete source.files[path];else source.files[path]=value;
  g.metas['gnome-consumer'].source=source;g.write();
  const checks=verifyGnomeConsumer(g.dirs['gnome-consumer']!,source,Date.now(),false).checks;
  expect(checks.gnomeContent).toBe(false);
 }finally{g.cleanup();}}
});

test('Gnome step list matches the installed worker course and isolates other courses',()=>{
 expect([...GNOME_STEPS] as string[]).toEqual(COURSES.gnome.steps.map(s=>s.name));
 const ok=gDispatch(1,1,'log')+'AGILITY_PROGRESS level=2 xp=100 tick=2 step=log\n'+gResult(2,2);
 expect(gnomeScope(ok,'progress')).toBe(true);
 expect(gnomeScope(ok.replaceAll('step=log','step=stones'),'progress')).toBe(false);
 expect(gnomeScope(ok.replace('"step":"log"','"step":"ropeswing"'),'progress')).toBe(false);
 expect(gnomeScope(ok.replace('"course":"gnome"','"course":"wilderness"'),'progress')).toBe(false);
 expect(gnomeScope(ok+'AGILITY_RECOVERY fall tick=3 step=log hp=1 at=1,1 xp=1\n','progress')).toBe(false);
 expect(gnomeScope(tail('a',false,'already at target'),'refusal')).toBe(true);
 expect(gnomeScope(ok,'refusal')).toBe(false);
 // The Gnome-scoped modes carry no Wilderness or Barbarian configuration.
 for(const c of [GNOME_FOOD_CONFIGURATION,ARDOUGNE_CONFIGURATION])expect(JSON.stringify(c)).not.toMatch(/wilderness|barbarian/);
 expect(GNOME_CONSUMER_PLAN.filter(p=>p.course!=='gnome').map(p=>[p.label,p.reason])).toEqual([['wilderness-entry','wilderness requires entry level 52']]);
});

test('read-only Gnome verifier accepts the complete synthetic delivery through functions and the actual CLI',()=>{
 const g=gnomeCopy();try{
  const tree=evidenceTree(g.root);
  const r=verifyGnome(g.root,g.source);
  expect(failed(r.checks)).toEqual([]);expect(r.ok).toBe(true);expect(r.scope).toBe(GNOME_SCOPE);
  expect(evidenceTree(g.root)).toEqual(tree);
  const child=gnomeCli(g.root);
  expect(child.error).toBeUndefined();expect(child.status,child.stdout+child.stderr).toBe(0);expect(JSON.parse(child.stdout.trim()).ok).toBe(true);
  expect(evidenceTree(g.root)).toEqual(tree);
  // A failing delivery keeps its exact names and bytes too; the rejected report stays untouched.
  rmSync(g.dirs.ardougne!,{recursive:true,force:true});
  const rejected=evidenceTree(g.root),bad=gnomeCli(g.root);
  expect(bad.status).toBe(1);const out=JSON.parse(bad.stdout.trim());expect(out.ok).toBe(false);expect(out.checks['ardougne.files']).toBe(false);
  expect(evidenceTree(g.root)).toEqual(rejected);
  expect(verifyGnome(g.root,g.source).ok).toBe(false);expect(evidenceTree(g.root)).toEqual(rejected);
 }finally{g.cleanup();}
},60000);

test('Gnome food proof recomputes owned-food heals, debit, settlement and later XP for both fixtures',()=>{
 const g=gnomeCopy();try{
  for(const [label,C] of [['food',FOOD_RECOVERY_CONFIGURATION],['food-restart',GNOME_FOOD_RESTART_CONFIGURATION]] as const){
   const dir=g.dirs['gnome-food']!,b=readPracticeSave(join(dir,label+'-before.sav')),a=readPracticeSave(join(dir,label+'-after.sav'));
   const log=readFileSync(join(dir,label+'.log'),'utf8');
   expect(failed(gnomeFoodChecks(b,a,log,gChild,'unitfood'+C.fixture,C))).toEqual([]);
   // Wrong fixture configuration, missing debit or a dropped heal fail.
   expect(gnomeFoodChecks(b,a,log,gChild,'unitfood'+C.fixture,label==='food'?GNOME_FOOD_RESTART_CONFIGURATION:FOOD_RECOVERY_CONFIGURATION).start).toBe(false);
   const kept=structuredClone(a);kept.inventories[93]!.unshift({slot:0,id:379,count:1});
   expect(gnomeFoodChecks(b,kept,log,gChild,'unitfood'+C.fixture,C).debit).toBe(false);
   expect(gnomeFoodChecks(b,a,log.replace('"eats":3','"eats":2'),gChild,'unitfood'+C.fixture,C).debit).toBe(false);
  }
 }finally{g.cleanup();}
});

test('shared settlement evidence rejects missing, contradictory and attributed-packet cases',()=>{
 const g=gnomeCopy();try{
  const log=readFileSync(join(g.dirs['gnome-food']!,'food-restart.log'),'utf8');
  expect(sharedSettlementChecks(log)).toEqual({settlement:true,foodActions:true,actions:true});
  const lines=log.split('\n'),first=lines.findIndex(l=>l.startsWith('AGILITY_FOOD {"event":"dispatch"'));
  // A course dispatch before the eat leaves a pending obstacle: an eat without a settled report is missing evidence.
  const pending=[...lines.slice(0,first),gDispatch(9,1,'net').trim(),...lines.slice(first)].join('\n');
  expect(sharedSettlementChecks(pending).settlement).toBe(false);
  // A settle report with no pending obstacle, or with unsettled/incomplete observations, contradicts the stream.
  const settle='AGILITY_FOOD '+JSON.stringify({event:'settle',sequence:1,step:'net',settled:true,quiet:6,marks:[],observations:[]});
  expect(sharedSettlementChecks([...lines.slice(0,first),settle,...lines.slice(first)].join('\n')).settlement).toBe(false);
  expect(sharedSettlementChecks([...lines.slice(0,first),gDispatch(9,1,'net').trim(),settle,...lines.slice(first)].join('\n')).settlement).toBe(false);
  expect(sharedSettlementChecks(log+settle+'\n').settlement).toBe(false);
  // The eat must be the only packet between its dispatch and reply, with consecutive operation numbers.
  expect(sharedSettlementChecks(log.replace(/^AGILITY_ACTION \{"event":"food".*\n/m,'')).foodActions).toBe(false);
  expect(sharedSettlementChecks(log.replace('"event":"food","tick":10','"event":"modal","tick":10')).foodActions).toBe(false);
  expect(sharedSettlementChecks(log.replace('"ops":4,','"ops":5,')).actions).toBe(false);
  expect(sharedSettlementChecks(log+'AGILITY_FOOD {broken\n')).toEqual({settlement:false,actions:false,foodActions:false});
 }finally{g.cleanup();}
});

test('Ardougne entry needs town start, gate route, Femi crossing, real heals, exact food debit and Agility10',()=>{
 const g=gnomeCopy();try{
  const dir=g.dirs.ardougne!,b=readPracticeSave(join(dir,'ardougne-entry-before.sav')),a=readPracticeSave(join(dir,'ardougne-entry-after.sav'));
  const log=readFileSync(join(dir,'ardougne-entry.log'),'utf8'),check=(bb=b,aa=a,l=log)=>ardougneEntryChecks(bb,aa,l,gChild,'unitardy14');
  expect(failed(check())).toEqual([]);
  expect(b.position).toEqual({x:2654,z:3283,level:0});expect(b.skills[3]!.level).toBe(ARDOUGNE_ENTRY_CONFIGURATION.currentHp);
  // Dock, near-course and inside-Stronghold starts are not the ordinary town entry.
  for(const position of [{x:2683,z:3268,level:0},{x:2461,z:3382,level:0},{x:2474,z:3437,level:0}]){const s=structuredClone(b);s.position=position;expect(check(s).start).toBe(false);}
  const full=structuredClone(b);full.skills[3]!.level=10;expect(check(full).start).toBe(false);
  expect(check(b,a,log.replace('"route":"gate"','"route":"direct"')).route).toBe(false);
  expect(check(b,a,log.replace('2461,3385,0','2461,3384,0')).gate).toBe(false);
  expect(check(b,a,log.replaceAll('Thanks again friend!','Thanks traveller!')).femi).toBe(false);
  expect(check(b,a,log.replace('"label":"walk to Stronghold gate"','"label":"walk to Ardougne dock"')).walk).toBe(false);
  expect(check(b,a,log.replace(/^AGILITY_FOOD .*\n/gm,'').replace('"eats":1','"eats":0')).heals).toBe(false);
  expect(check(b,a,log.replace(/("event":"effect".*?"hp":)10/,'$15')).heals).toBe(false);
  const extra=structuredClone(a);extra.inventories[93]!.pop();expect(check(b,extra).assets).toBe(false);
  const coins=structuredClone(a);coins.inventories[95]![0]!.count--;expect(check(b,coins).assets).toBe(false);
  const declined=structuredClone(a);declined.vars[152]=1;expect(check(b,declined).femi).toBe(false);
  const thieving=structuredClone(a);thieving.skills[17]!.rawExperience++;expect(check(b,thieving).skills).toBe(false);
  expect(check(b,a,log.replace('LOGOUT logged-out','')).logout).toBe(false);
  expect(check(b,a,log+'AGILITY_ENTRY_FARE {"leg":"x","paid":30}\n').route).toBe(false);
 }finally{g.cleanup();}
});

test('heal sequence requires a real HP rise, one-item debit, exact inventory and the eat-delay cooldown',()=>{
 const inv=Array.from({length:4},(_,slot)=>({slot,id:379,count:1})),before={inventories:{93:inv}} as any;
 const C={baseHp:70,currentHp:10,foodId:379,heal:12,effectTicks:8,eatDelayTicks:2};
 const events=(text:string)=>text.split('\n').filter(l=>l.startsWith('AGILITY_FOOD ')).map(l=>JSON.parse(l.slice(13)));
 const two=events(gFoodLog(inv,{heals:2,hp:10,base:70,heal:12,id:379}));
 expect(healSequence(two,before,C)).toMatchObject({ok:true,count:2});
 const fast=structuredClone(two);fast.find(e=>e.sequence===2&&e.event==='dispatch').tick=12;
 expect(healSequence(fast,before,C).ok).toBe(false);
 expect(healSequence(two.filter(e=>!(e.sequence===2&&e.event==='effect')),before,C).ok).toBe(false);
 const stale=structuredClone(two);for(const e of stale)if(e.sequence===1&&e.event==='effect')e.hp=10;
 expect(healSequence(stale,before,C).ok).toBe(false);
 expect(healSequence([],before,C).ok).toBe(false);
});

test('Gnome verifier rejects omitted, substituted, stale, CRC-invalid, metadata-only and unbound evidence',()=>{
 const attacks:{name:string;key:string;edit:(g:ReturnType<typeof gnomeCopy>)=>void}[]=[
  {name:'absent Ardougne evidence',key:'ardougne.files',edit:g=>rmSync(g.dirs.ardougne!,{recursive:true,force:true})},
  {name:'absent food restart',key:'gnome-food.cases',edit:g=>{g.metas['gnome-food'].cases.pop();g.write();}},
  {name:'omitted initialization log',key:'consumer.region.initialization',edit:g=>unlinkSync(join(g.dirs['gnome-consumer']!,'initial-15.log'))},
  {name:'omitted initialization report',key:'gnome-food.food.initialization',edit:g=>unlinkSync(join(g.dirs['gnome-food']!,'initial-10.json'))},
  {name:'omitted Draynor initialization',key:'draynor.draynor-entry.initialization',edit:g=>unlinkSync(join(g.root,'initial-6-after.sav'))},
  {name:'unlisted retained case',key:'consumer.omitted',edit:g=>writeFileSync(join(g.dirs['gnome-consumer']!,'approach-2.log'),'x')},
  {name:'CRC-invalid save',key:'ardougne.ardougne-entry.files',edit:g=>mutateSave(join(g.dirs.ardougne!,'ardougne-entry-after.sav'),b=>b[47]=9,false)},
  {name:'substituted save',key:'consumer.plane.hashes',edit:g=>copyFileSync(join(g.dirs['gnome-consumer']!,'region-before.sav'),join(g.dirs['gnome-consumer']!,'plane-before.sav'))},
  {name:'stale case',key:'ardougne.ardougne-entry.fresh',edit:g=>{g.metas.ardougne.cases[0].at=Date.now()-2*3600000;g.write();}},
  {name:'foreign source',key:'gnome-food.source',edit:g=>{g.metas['gnome-food'].source={runtime:'foreign'};g.write();}},
  {name:'foreign account',key:'consumer.approach.identity',edit:g=>{const p=join(g.dirs['gnome-consumer']!,'approach.log');writeFileSync(p,readFileSync(p,'utf8').replace('bot=unitgnome1','bot=otheragi1'));g.rehash();g.write();}},
  {name:'false crossing',key:'ardougne.ardougne-entry.gate',edit:g=>{const p=join(g.dirs.ardougne!,'ardougne-entry.log');writeFileSync(p,readFileSync(p,'utf8').replace('2461,3385,0','2461,3384,0'));g.rehash();g.write();}},
  {name:'unconfirmed logout',key:'consumer.approach.logout',edit:g=>{const p=join(g.dirs['gnome-consumer']!,'approach.log');writeFileSync(p,readFileSync(p,'utf8').replace('LOGOUT logged-out','LOGOUT failed'));g.rehash();g.write();}},
  {name:'metadata-only published report',key:'ardougne.report',edit:g=>{const p=join(g.dirs.ardougne!,'ardougne-entry.log');writeFileSync(p,readFileSync(p,'utf8').replace(/^AGILITY_FOOD .*\n/gm,''));g.rehash();
   for(const k of ['gnome-food','ardougne','gnome-consumer'])writeFileSync(join(g.dirs[k]!,k+'.json'),JSON.stringify(g.metas[k]));}},
  {name:'missing food effect',key:'gnome-food.food.heals',edit:g=>{const p=join(g.dirs['gnome-food']!,'food.log');writeFileSync(p,readFileSync(p,'utf8').split('\n').filter(l=>!l.includes('"event":"effect"')).join('\n'));g.rehash();g.write();}},
  {name:'incorrect food cost',key:'gnome-food.food-restart.debit',edit:g=>{const p=join(g.dirs['gnome-food']!,'food-restart-after.sav'),b=readFileSync(p);
   writeFileSync(p,gcrc(setSlot(b,93,savedFields(b).entries.find(v=>v.inv===93&&v.id===379)!.slot,null)));g.rehash();g.write();}},
  {name:'incorrect Draynor fare',key:'draynor.draynor-entry.route',edit:g=>{const p=join(g.root,'draynor-entry.log');writeFileSync(p,readFileSync(p,'utf8').replace(/^AGILITY_ENTRY_FARE .*Ardougne.*\n/m,''));g.rehash();g.write();}},
  {name:'missing server removal',key:'consumer.restart.interruption.serverRemoval',edit:g=>writeFileSync(join(g.dirs['gnome-consumer']!,'interrupted-engine.log'),'')},
  {name:'reseeded restart',key:'consumer.restart.middleBinding',edit:g=>{const m=g.metas['gnome-consumer'].cases.find((c:any)=>c.label==='restart');m.middleSha256='0'.repeat(64);g.write();}},
  {name:'missing interruption',key:'consumer.restart.interrupted',edit:g=>{const m=g.metas['gnome-consumer'].cases.find((c:any)=>c.label==='restart');m.interrupted={code:0,timedOut:false,interrupted:false};g.write();}},
  {name:'rerun not bound to approach',key:'consumer.rerun.baseline',edit:g=>{mutateSave(join(g.dirs['gnome-consumer']!,'approach-after.sav'),b=>b[9]=b[9]!^1);g.rehash();g.write();}},
  {name:'Wilderness progress in a refusal',key:'consumer.wilderness-entry.reason',edit:g=>{const p=join(g.dirs['gnome-consumer']!,'wilderness-entry.log');writeFileSync(p,'AGILITY_PROGRESS level=52 xp=1 tick=1 step=pipe\n'+readFileSync(p,'utf8'));g.rehash();g.write();}},
  {name:'retained original changed',key:'course-approach.course-approach.baseline',edit:g=>{const p=g.metas.retained.original;writeFileSync(p,Buffer.concat([readFileSync(p),Buffer.from([0])]));}},
  {name:'duplicate account',key:'uniqueAccounts',edit:g=>{const m=g.metas['gnome-consumer'].cases.find((c:any)=>c.label==='region');m.name='unitgnome4';g.write();}},
 ];
 for(const attack of attacks){const g=gnomeCopy();try{
  attack.edit(g);const tree=evidenceTree(g.root),r=verifyGnome(g.root,g.source);
  expect(r.ok,attack.name).toBe(false);expect(r.checks[attack.key],attack.name).toBe(false);
  expect(evidenceTree(g.root),attack.name).toEqual(tree);
 }finally{g.cleanup();}}
},120000);

test('proof CLI rejects an unknown mode before any practice work',()=>{
 const child=spawnSync(process.execPath,['packages/practice/src/agility-order-proof.ts','--gnome-wilderness'],
  {cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,DELIVERY_DIR:tmpdir()},encoding:'utf8',windowsHide:true,timeout:10000});
 expect(child.status).toBe(1);expect(child.stderr).toContain('unknown agility proof mode');
});
