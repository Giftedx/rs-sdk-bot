// Harness only: real quest-sweep CLI, then saved quest flags, asset deltas and confirmed logout.
import {openSync,writeFileSync,rmSync,closeSync,mkdirSync,readFileSync,copyFileSync,existsSync,statSync,statfsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {freemem} from 'node:os';
import type {startStack} from './stack';
import {applyPreset} from './presets';
import {createBot} from './bots';
import {readPracticeSave,waitPracticeSave} from './fleet-player-save';
import {workerSourceRevision} from '../../core/src/worker-release';
import {PRACTICE_STARTUP_GB,FREE_FLOOR_GB} from '../../core/src/memory';
import {questSweepProofEndpoints,selectQuestSweepProofEndpoints,selectFreshQuestSweepProofName,questSweepProofAccountEnv,startQuestSweepProofStack,questSweepChildConfiguration,runQuestSweepProofCase,type ProofEndpoints} from './quest-sweep-proof/endpoints';
import {ELENA_DUST_BANK,FLUFFS_ENTRY,IMP_BEADS,QUEST_SWEEP_PROOF_CASE_IDS,QUEST_SWEEP_TICK_MS,SCORPION_BANK,SCORPION_COMPLETE,SCORPION_MELEE_BANK,SCORPION_RANGED_BANK,questSweepElenaPreset,selectQuestSweepProofCases,type CaseRecord} from './quest-sweep-proof/fixtures';
import {equipment} from './quest-sweep-proof/assets';
import {questSweepChecks} from './quest-sweep-proof/checks';

export {questSweepProofEndpoints,selectQuestSweepProofEndpoints,selectFreshQuestSweepProofName,questSweepProofAccountEnv,startQuestSweepProofStack,questSweepChildConfiguration,runQuestSweepProofCase,equipment,questSweepElenaPreset,QUEST_SWEEP_PROOF_CASE_IDS,questSweepChecks,selectQuestSweepProofCases};

const root=resolve(import.meta.dir,'../../..');

function verify(dir:string,selected:readonly string[]=QUEST_SWEEP_PROOF_CASE_IDS){
 const meta=JSON.parse(readFileSync(join(dir,'native.json'),'utf8')) as {source:string;cases:CaseRecord[];endpoints:ProofEndpoints};
 const endpoints=questSweepProofEndpoints(meta.endpoints?.ports,meta.endpoints?.instance??'');
 if(meta.endpoints.server!==endpoints.server||meta.endpoints.gateway!==endpoints.gateway)throw Error('retained practice endpoints mismatch');
 if(!selected.length)throw Error('no quest-sweep proof case selected');
 const results=selected.map(id=>{
  const record=meta.cases.find(c=>c.id===id);
  if(!record)throw Error(`missing retained case ${id}`);
  for(const file of [id+'-before.sav',id+'-after.sav',id+'.log'])if(!existsSync(join(dir,file)))throw Error(`missing retained evidence ${file}`);
  const checks=questSweepChecks(id,readPracticeSave(join(dir,id+'-before.sav')),readPracticeSave(join(dir,id+'-after.sav')),readFileSync(join(dir,id+'.log'),'utf8'),record);
  return{...record,ok:Object.values(checks).every(Boolean),checks};
 });
 const source=meta.source===workerSourceRevision();
 const report={ok:source&&results.every(r=>r.ok),source,cases:[...selected],results,scope:'Native practice at75ms/25xXP. scorpion-barcrawl starts at Ardougne south bank2655,3283,0 and requires the real account-parameterized scorpion CLI with worn rune scimitar1333, teleport runes, no ranged or strike kit and an observed melee Jailer fight. scorpion-ranged-barcrawl retains the Varrock bank entry and bow-and-arrows variant. Each completion case starts with Barcrawl incomplete, stages eight Law runes, completes Barcrawl and the outpost gate, reaches quest flag76=6 and QP+1, reconciles assets and confirms logout. A completed-quest entry refuses before input and confirms logout. Existing quest-sweep cases retain their own exact saved-state checks. No live or unattended claim.'};
 writeFileSync(join(dir,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}

async function run(dir:string,selected:readonly string[]=QUEST_SWEEP_PROOF_CASE_IDS){
 if(!process.env.DELIVERY_DIR||!existsSync(join(root,'.practice/delivery-native.lock')))throw Error('native turn required: run through delivery');
 // Reserve space for saves and logs before the stack can consume the remaining disk.
 // This is a storage reserve, not a measured size of a practice run.
 const disk=statfsSync(root),freeBytes=disk.bavail*disk.bsize;
 if(freeBytes<512*2**20)throw Error(`practice storage deferred: freeBytes=${freeBytes} requiredBytes=${512*2**20}; preserve failed evidence`);
 // Host memory waits occur before gameplay. Delivery holds the native turn through the saved consumer.
 const deadline=Date.now()+180000;
 while(freemem()/2**30<PRACTICE_STARTUP_GB){
  console.log(`QUEST_SWEEP_MEMORY freeGiB=${(freemem()/2**30).toFixed(2)} startupGiB=${PRACTICE_STARTUP_GB} floorGiB=${FREE_FLOOR_GB}`);
  if(Date.now()>=deadline)throw Error('practice startup headroom deadline');
  await Bun.sleep(1000);
 }
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,directory:dir,task:'quest-sweep'}));closeSync(fd);
 mkdirSync(dir,{recursive:true});
 const cases:CaseRecord[]=[],source=workerSourceRevision();
 let endpoints:ProofEndpoints|undefined;
 const retain=()=>writeFileSync(join(dir,'native.json'),JSON.stringify({source,tickMs:QUEST_SWEEP_TICK_MS,xpRate:25,endpoints,cases},null,2));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  endpoints=selectQuestSweepProofEndpoints();
  stack=await startQuestSweepProofStack(endpoints,undefined,QUEST_SWEEP_TICK_MS);
  for(const c of ([{id:'scorpion-barcrawl',quest:'scorpion',bank:SCORPION_BANK},{id:'scorpion-ranged-barcrawl',quest:'scorpion',bank:[...SCORPION_BANK,{id:882,count:40}]},{id:'scorpion-complete-refusal',quest:'scorpion',bank:[]},{id:'imp-surplus-beads',quest:'imp',bank:[...IMP_BEADS.map(id=>({id,count:3})),{id:995,count:723},{id:1478,count:1}]},{id:'ball-worn-kit',quest:'ball',bank:[{id:995,count:183752},{id:1059,count:1},{id:1331,count:1}]},{id:'ball-missing-gloves',quest:'ball',bank:[]},...['rj-pirate-letter','rj-pirate-started'].map(id=>({id,quest:'rj',bank:[{id:995,count:183752},{id:1891,count:7},{id:373,count:5}]})),{id:'hunt-crowded',quest:'hunt',bank:[{id:995,count:183752},{id:1891,count:7}]},{id:'totem-started-cakes',quest:'totem',bank:[{id:995,count:183752},{id:1891,count:15},{id:1893,count:1},{id:1895,count:2}]},{id:'clock-stage',quest:'cog',bank:[{id:995,count:183752},{id:1436,count:243}]},{id:'ernest-fortress',quest:'haunted',bank:[{id:273,count:1},{id:952,count:1},{id:379,count:4}]},{id:'vampire-started',quest:'vampire',bank:[{id:379,count:6}]},{id:'fishing-stage',quest:'fishingcompo',bank:[{id:952,count:1},{id:307,count:1},{id:313,count:2},{id:1550,count:1},{id:556,count:5}]},{id:'bank-stage',quest:'sheep',bank:[{id:1759,count:20}]},...['doric-self-supply','doric-no-cash'].map(id=>({id,quest:'doric',bank:[]})),...['retained-ghost','banked-ghost'].map(id=>({id,quest:'priest',bank:[{id:995,count:1127309},{id:1436,count:243},{id:1446,count:1},...(id==='banked-ghost'?[{id:553,count:1}]:[])]})),{id:'elena-heckel-dust',quest:'elena',bank:ELENA_DUST_BANK},{id:'blackknight-finish',quest:'blackknight',bank:[]},{id:'fluffs-yard-exit',quest:'fluffs',bank:[]}] as {id:string;quest:string;bank:{id:number;count:number}[]}[]).filter(c=>selected.includes(c.id))){
   const before=join(dir,c.id+'-before.sav');
   if(existsSync(before))throw Error(`preserve before snapshot: ${before}`);
   const name=selectFreshQuestSweepProofName(cases.length);
   const {envPath}=await createBot(name);
   if(c.id==='scorpion-barcrawl')c.bank=SCORPION_MELEE_BANK;
   if(c.id==='scorpion-ranged-barcrawl')c.bank=SCORPION_RANGED_BANK;
   writeFileSync(envPath,questSweepProofAccountEnv(readFileSync(envPath,'utf8'),endpoints));
   const scorpionMelee=c.id==='scorpion-barcrawl',scorpion=c.quest==='scorpion',scorpionRefused=c.id==='scorpion-complete-refusal',imp=c.quest==='imp',blackknight=c.quest==='blackknight',elena=c.quest==='elena',ball=c.quest==='ball',ballMissing=c.id==='ball-missing-gloves',rj=c.quest==='rj',hunt=c.quest==='hunt',ghost=c.quest==='priest',banked=c.id==='banked-ghost',fishing=c.quest==='fishingcompo',clock=c.quest==='cog',ernest=c.quest==='haunted',vampire=c.quest==='vampire',totem=c.quest==='totem',doric=c.id==='doric-self-supply',doricRefused=c.id==='doric-no-cash',fluffs=c.quest==='fluffs',long=scorpion||fluffs||doric||ball||rj||fishing||clock||ernest||vampire||totem||hunt;
   const save=await applyPreset(name,scorpion?{position:scorpionMelee?{x:2655,z:3283,level:0}:{x:3185,z:3436,level:0},skills:{Attack:65,Defence:10,Strength:scorpionMelee?65:11,Hitpoints:69,Ranged:99,Prayer:65,Magic:50},varps:{76:scorpionRefused?SCORPION_COMPLETE:0,77:0,101:scorpionRefused?1:0},equipment:[{id:1169,count:1,slot:0},{id:552,count:1,slot:2},{id:scorpionMelee?1333:861,count:1,slot:3},{id:1131,count:1,slot:4},{id:1097,count:1,slot:7},{id:1063,count:1,slot:9}],bank:c.bank,inventory:[]}:totem?{position:{x:2571,z:3250,level:0},skills:{Thieving:99,Hitpoints:40,Magic:1},varps:{200:1,10:8,101:1},bank:c.bank,inventory:[{id:995,count:552}]}:fluffs?{position:FLUFFS_ENTRY,skills:{Hitpoints:10,Magic:1},varps:{180:5},bank:c.bank,inventory:[{id:995,count:25}]}:imp?{position:{x:3104,z:3163,level:2},skills:{Hitpoints:40,Magic:1},bank:c.bank,inventory:[{id:1470,count:1},{id:1470,count:1},{id:1472,count:1},{id:1474,count:1},{id:1476,count:1},{id:995,count:91},{id:433,count:1},{id:1351,count:1}]}:blackknight?{position:{x:3016,z:3512,level:0},skills:{Hitpoints:10,Magic:1},varps:{130:3,101:12,144:100,226:7,178:3},bank:c.bank,inventory:[{id:995,count:490},{id:433,count:1}]}:elena?questSweepElenaPreset():ball?{position:{x:2947,z:3368,level:0},skills:{Attack:94,Strength:83,Defence:76,Hitpoints:77,Magic:1},equipment:[{id:589,count:1,slot:2},{id:1381,count:1,slot:3}],bank:c.bank,inventory:[{id:1985,count:1},...Array.from({length:4},()=>({id:379,count:1}))]}:rj?{position:c.id==='rj-pirate-started'?{x:3210,z:3423,level:0}:{x:2999,z:3383,level:0},skills:{Attack:55,Hitpoints:40,Magic:1},varps:{144:c.id==='rj-pirate-started'?30:0},equipment:[{id:1005,count:1,slot:4}],bank:c.bank,inventory:[{id:995,count:754},{id:433,count:1},{id:753,count:1},{id:555,count:2},{id:556,count:6},{id:952,count:1},{id:1635,count:1},{id:1605,count:1},...Array.from({length:8},()=>({id:1891,count:1})),{id:1893,count:1},{id:1895,count:1},{id:1895,count:1}]}:hunt?{position:{x:2907,z:3147,level:0},skills:{Attack:55,Hitpoints:40,Magic:1,Thieving:99,Cooking:30,Fishing:20,Crafting:51},varps:{200:5,10:8,101:2},bank:c.bank,inventory:[{id:995,count:402},{id:1925,count:1},{id:555,count:2},...Array.from({length:8},()=>({id:1891,count:1})),{id:1893,count:1},...Array.from({length:2},()=>({id:1895,count:1})),...Array.from({length:5},()=>({id:373,count:1})),{id:952,count:1},{id:556,count:6},...Array.from({length:7},()=>({id:1963,count:1}))]}:vampire?{position:{x:3097,z:3267,level:0},skills:{Attack:94,Strength:83,Defence:76,Hitpoints:75,Magic:1},varps:{178:1},equipment:[[1139,0],[552,2],[2402,3],[1101,4],[1171,5]].map(([id,slot])=>({id:id!,count:1,slot:slot!})),bank:c.bank,inventory:[{id:1917,count:1},{id:2347,count:1},{id:1550,count:1},{id:563,count:2}]}:ernest?{position:{x:3029,z:3505,level:1},skills:{Attack:94,Strength:83,Defence:76,Hitpoints:75,Magic:1},varps:{130:2},equipment:[[1139,0],[552,2],[2402,3],[1101,4],[1171,5]].map(([id,slot])=>({id:id!,count:1,slot:slot!})),bank:c.bank,inventory:[{id:995,count:490}]}:clock?{position:{x:3239,z:3275,level:0},skills:{Magic:1,Hitpoints:40,Attack:55},bank:c.bank,inventory:[{id:995,count:112},{id:1929,count:1},{id:1351,count:1},...Array.from({length:4},()=>({id:379,count:1}))]}:fishing?{position:{x:2615,z:3332,level:0},skills:{Fishing:20,Magic:1,Hitpoints:47,Attack:62,Defence:10,Strength:12},bank:c.bank,inventory:[{id:995,count:7350},{id:1351,count:1}]}:ghost?{position:banked?{x:3094,z:3491,level:0}:{x:3113,z:9555,level:0},skills:{Hitpoints:26,Attack:37,Magic:1,Prayer:1},varps:{107:4},equipment:[{id:552,count:1,slot:2}],bank:c.bank,inventory:[...(!banked?[{id:553,count:1}]:[]),{id:556,count:3},{id:557,count:1}]}:{position:c.id==='bank-stage'?{x:2459,z:3385,level:0}:{x:2965,z:3380,level:0},skills:{Hitpoints:10},bank:c.bank,inventory:[...(doricRefused?[]:[{id:995,count:362}]),{id:1351,count:1}]});
   copyFileSync(save,before);
   if(freemem()/2**30<FREE_FLOOR_GB)throw Error('practice free memory below floor');
   const stamp=statSync(save).mtimeMs;
   const record:CaseRecord={id:c.id,exit:-1,timedOut:false,saveMatched:false,seconds:0};cases.push(record);retain();
   await runQuestSweepProofCase({dir,record,save,retain,
    // CAP 6000 ticks at 75 ms is 450 s: the Vampire child must reach its own tick-cap failure before this kill.
    timeoutMs:elena?600000:scorpion&&!scorpionRefused||fluffs||ball||rj||hunt?5400000:vampire||totem||doric?1200000:long?900000:300000,
    spawn:()=>Bun.spawn({...questSweepChildConfiguration(name,c.quest,endpoints!,long||elena?{...process.env,CAP:'6000'}:process.env),windowsHide:true,stdout:'pipe',stderr:'pipe'}),
    matched:async()=>(await waitPracticeSave(save,s=>statSync(save).mtimeMs>stamp&&(scorpionRefused||doricRefused||ballMissing||(scorpion?s.vars[76]===SCORPION_COMPLETE&&s.vars[77]===2:fluffs?s.vars[180]===6:imp?s.vars[160]===2:doric?s.vars[31]===100:blackknight?s.vars[130]===4:elena?s.vars[165]===29:ball?s.vars[226]===7:rj?s.vars[144]===100:hunt?s.vars[71]===4:totem?s.vars[200]===5:clock?((s.vars[10]??0)&15)===8:ernest?s.vars[32]===3:vampire?s.vars[178]===3:ghost?s.vars[107]===5:fishing?s.vars[11]===5:s.vars[179]===22)),{timeoutMs:6000})).matched});
  }
  return verify(dir,selected);
 }finally{try{await stack?.stop();}finally{rmSync(lock,{force:true});retain();}}
}

if(import.meta.main){
 try{
  if(!process.env.DELIVERY_DIR)throw Error('run through delivery');
  const dir=resolve(process.env.DELIVERY_DIR),selected=selectQuestSweepProofCases(process.argv.slice(2));
  process.exitCode=(process.argv.includes('--verify')?verify(dir,selected):await run(dir,selected)).ok?0:1;
 }catch(error){console.error(String(error));process.exitCode=1;}
}
