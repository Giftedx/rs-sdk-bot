import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {workerSourceRevision} from '../../../core/src/worker-release';
import type {readPracticeSave} from '../fleet-player-save';
import type {SaveConfig} from '../presets';

export const repoRoot=resolve(import.meta.dir,'../../../..');

export type Save=ReturnType<typeof readPracticeSave>;
export type Child={code:number;timedOut:boolean;interrupted:boolean};
export type FallOutcome='proved'|'zero-fall'|'failed';
export type FallSample={index:number;fixture:number;label:string;outcome:FallOutcome;name?:string;at?:number;error?:string;
 child?:Child;checks?:Record<string,boolean>;sha256?:{before:string;after:string;log:string};[key:string]:unknown};
export type EvidenceHashes={before:string;after:string;log:string};
export type InitializationFiles={before:Save;after:Save;log:string;sha256:EvidenceHashes};
export type FallFiles={before:Save;after:Save;log:string;sha256:EvidenceHashes;initial:any;initialFiles?:InitializationFiles};

export const cases=['approach','restart','pit','rerun','wilderness-entry'] as const;
export type Case=typeof cases[number]|'fall'|'food'|'food-restart'|'ardougne-entry'|'region'|'plane';
export const refusalCases=new Set<Case>(['rerun','wilderness-entry','region','plane']);

const owned=['scripts/aio-skiller.ts','packages/workers/src/agility/index.ts','packages/workers/src/agility/runner.ts','packages/workers/src/agility/courses.ts','packages/workers/src/agility/entry.ts','packages/workers/test/agility.test.ts','packages/practice/src/agility-order-proof.ts',
 'packages/practice/src/agility-order-proof/contracts.ts',
 'packages/practice/src/agility-order-proof/save-checks.ts',
 'packages/practice/src/agility-order-proof/food-checks.ts',
 'packages/practice/src/agility-order-proof/verify.ts',
 'packages/practice/src/agility-order-proof/fixtures.ts',
 'packages/practice/src/agility-order-proof/runner.ts',
 'packages/practice/test/agility-order-proof.test.ts',
 'packages/core/src/boat.ts','packages/core/test/boat.test.ts','scripts/aio-logistics.ts','packages/workers/src/logistics/trade.ts'];

export function sources(){return{runtime:workerSourceRevision(),files:Object.fromEntries([...owned,
 'vendor/rs-sdk/server/engine/src/engine/World.ts','vendor/rs-sdk/server/engine/src/engine/entity/NetworkPlayer.ts',
 'vendor/rs-sdk/server/content/scripts/login_logout/logout.rs2',
 'vendor/rs-sdk/server/content/scripts/areas/area_gnome/scripts/gnome_gate.rs2',
 'vendor/rs-sdk/server/content/scripts/quests/quest_grandtree/scripts/femi.rs2',
 'vendor/rs-sdk/server/content/scripts/player/scripts/consumption/consume.rs2',
 'vendor/rs-sdk/server/content/scripts/player/scripts/consumption/effects/scripts/consume_effects.rs2',
 'vendor/rs-sdk/server/content/scripts/player/configs/consumption/consume_normal.dbrow',
 'vendor/rs-sdk/server/engine/src/network/game/client/handler/OpHeldHandler.ts',
 'vendor/rs-sdk/server/engine/src/network/game/client/handler/OpLocHandler.ts',
 'vendor/rs-sdk/server/engine/src/engine/script/handlers/PlayerOps.ts',
 'vendor/rs-sdk/server/content/scripts/skill_agility/scripts/wilderness_course.rs2',
 'vendor/rs-sdk/server/content/scripts/skill_agility/scripts/gnome_course.rs2',
 'vendor/rs-sdk/server/engine/src/engine/entity/Player.ts',
 'vendor/rs-sdk/server/engine/src/network/game/server/codec/UpdateStatEncoder.ts',
 'vendor/rs-sdk/server/webclient/src/client/Client.ts',
 'vendor/rs-sdk/server/webclient/src/bot/types.ts',
 'vendor/rs-sdk/server/content/scripts/skill_agility/scripts/agility.rs2',
 'vendor/rs-sdk/sdk/index.ts','vendor/rs-sdk/server/webclient/src/bot/dialog-page.ts',
 'vendor/rs-sdk/server/webclient/src/lite/LiteClient.ts',
 'vendor/rs-sdk/server/webclient/src/bot/StateCollector.ts',
].map(p=>[p,createHash('sha256').update(readFileSync(join(repoRoot,p))).digest('hex')]))};}

// Save.level is the CURRENT level; an agility potion must never satisfy the trained target.
// Player.ts:77-98 uses level/10 on this server, and stores XP in tenths.
export function trainedLevel(xp:number){let points=0;for(let level=1;level<99;level++){points+=Math.floor(level+300*2**(level/10));if(xp<Math.floor(points/4))return level;}return 99;}

export const foodIds=new Set([379,373,385,333,329,361,315,2142,2309,1963,1985]);
export const musicVarps=new Set([20,21,22,23,24,25,298,311,346]);

export function items(s:Save){const out=new Map<string,number>();for(const [inv,list] of Object.entries(s.inventories))for(const i of list){const k=`${inv}:${i.id}`;out.set(k,(out.get(k)??0)+i.count);}return out;}

// Source decision: save-generator.ts writes dense v6 zeros (0..308).
// Player's constructor initializes non-int varps to -1; PlayerLoading overwrites
// them with those zeros, then Player.save omits them in v9. The SECOND login
// therefore restores the typed nulls. Seed them before either session instead.
// IDs: content/pack/varp.pack; types: their content/scripts/**/*.varp definitions.
// sa_login starts a 50-tick +100 timer at zero. Start the ordinary fixture at
// sa_max_energy=1000 (skill_combat/configs/combat.constant), not partway to full.
export function agilityFixturePreset(preset:SaveConfig):SaveConfig{
 return {...preset,varps:{4:-1,9:-1,13:-1,16:-1,28:-1,64:-1,181:-1,209:-1,300:1000,...preset.varps}};
}

export const lastLine=(log:string,tag:string)=>{try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith(tag+' ')).at(-1)?.slice(tag.length+1)??'null');}catch{return null;}};

// Source decision: World.processLogouts + NetworkPlayer.decodeIn
// -> restart proof. A killed socket remains owned for 500 ticks (idle), up to
// 1000 ticks (no response). At 150ms the old 30s disk predicate preceded logout.
// Adapt the deadline, require removal AND a saved logout/XP effect, retain failures.
// Do not send a graceful logout or reconnect over that still-owned session.
export function interruptionDeadlineMs(tickMs:number){return 1000*tickMs+15000;}

export const NATIVE_DEADLINE_MS=900000;
export const CHILD_TIMEOUT_MS=180000,SAVE_WAIT_MS=15000;
export const FALL_SAMPLE_PLAN={limit:3,fixtures:[5,8,9],course:'wilderness',startLevel:52,target:70,
 childTimeoutMs:CHILD_TIMEOUT_MS,saveWaitMs:SAVE_WAIT_MS,sampleWorstMs:2*(CHILD_TIMEOUT_MS+SAVE_WAIT_MS),
 cleanupReserveMs:30000,deadlineMs:NATIVE_DEADLINE_MS} as const;
export const NATIVE_FORMAT='agility-native-fall-sample-2';
export const INITIALIZATION_CONFIGURATION={server:'localhost:8888',tickMs:150,course:'gnome',target:1,
 childTimeoutMs:CHILD_TIMEOUT_MS,saveWaitMs:SAVE_WAIT_MS,
 env:{RANDOM_EVENTS:'0',AGI_POTION:'0',AGI_MAX_LAPS:'100',AGI_MAX_TICKS:'2500',AGI_PROGRESS_TICKS:'150',AGI_ENTRY_TICKS:'400'}} as const;

export function fallSampleAdmitted(elapsedMs:number){
 return Number.isFinite(elapsedMs)&&elapsedMs>=0&&elapsedMs+FALL_SAMPLE_PLAN.sampleWorstMs+FALL_SAMPLE_PLAN.cleanupReserveMs<=FALL_SAMPLE_PLAN.deadlineMs;
}

export function initializationBinding(name:string,index:number,source:unknown,hashes:EvidenceHashes){
 return{format:'agility-initialization-1',name,index,source,configuration:INITIALIZATION_CONFIGURATION,sha256:hashes};
}

export function sha256(bytes:Buffer|string){return createHash('sha256').update(bytes).digest('hex');}

export const DRAYNOR_START={x:3092,z:3242,level:0};
export const FOOD_RECOVERY_CONFIGURATION={...INITIALIZATION_CONFIGURATION,course:'gnome',target:2,
 label:'depleted-HP recovery fixture; not default entry',fixture:10,position:{x:2474,z:3437,level:0},
 currentHp:10,baseHp:70,foodId:379,foodCount:5,heal:12,effectTicks:8,eatDelayTicks:2,deadlineMs:300000,cleanupReserveMs:30000} as const;
export const GNOME_FOOD_RESTART_CONFIGURATION={...FOOD_RECOVERY_CONFIGURATION,
 label:'depleted-HP retained mid-course restart fixture; not default entry',fixture:13,position:{x:2474,z:3429,level:0}} as const;
export type FoodConfig=typeof FOOD_RECOVERY_CONFIGURATION|typeof GNOME_FOOD_RESTART_CONFIGURATION;

export function traceLines(log:string,prefix:string){return log.split(/\r?\n/).filter(l=>l.startsWith(prefix)).map(l=>{
 const value=JSON.parse(l.slice(prefix.length));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid evidence record');return value;
});}
export function foodLines(log:string){return traceLines(log,'AGILITY_FOOD ');}
export function actionLines(log:string){return traceLines(log,'AGILITY_ACTION ');}

export const INFLIGHT_FOOD_CONFIGURATION={...INITIALIZATION_CONFIGURATION,course:'wilderness',target:53,startLevel:52,
 label:'active stones timing fixture; ordinary log approach at reduced HP; natural falls only; not default entry',
 fixtures:[11,12],position:{x:2996,z:3960,level:0},currentHp:40,baseHp:70,foodId:379,foodCount:15,heal:12,
 effectTicks:8,quietTicks:6,settleMaxTicks:40,sampleMinMs:120000} as const;
export const INFLIGHT_BASE=['target','assets','skills','vars','alive','hpExperience','exit','logout','result','readable','start','identity','savedLogout','position'] as const;
export const integer=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;

export function foodBinding(name:string,source:unknown,child:Child,hashes:EvidenceHashes,initialization:unknown){
 return{name,source,child,configuration:FOOD_RECOVERY_CONFIGURATION,sha256:hashes,initialization};
}

export const GNOME_SCOPE='Gnome course only. Native fixture Agility orders at 150ms. No Wilderness or Barbarian qualification, live, record, speed or unattended claim.';
export const GNOME_FRESH_MS=3600000;
export const GNOME_STEPS=['log','net','branch','rope','treedown','net2','pipe'] as const;

export const ARDOUGNE_ENTRY_CONFIGURATION={server:'localhost:8888',tickMs:150,course:'gnome',target:10,fixture:14,
 label:'labelled reduced-HP recovery fixture at ordinary Ardougne-town entry; helper dated state; not default entry',
 state:'run-overnight-earn-pickpockdick-20261028 status 1793191661950',
 position:{x:2654,z:3283,level:0},baseHp:10,currentHp:3,foodId:329,foodCount:16,heal:9,effectTicks:8,eatDelayTicks:2,
 skills:{Hitpoints:10,Thieving:99},
 bank:[{id:995,count:836624},{id:1351,count:1},{id:590,count:1},{id:303,count:1},{id:315,count:1},{id:1925,count:1},{id:1931,count:1},
  {id:1265,count:1},{id:1205,count:1},{id:1277,count:1},{id:1171,count:1},{id:841,count:1},{id:882,count:25},{id:556,count:25},
  {id:558,count:15},{id:555,count:6},{id:557,count:4},{id:559,count:2}],
 budget:{entryTicks:1300,maxTicks:1600,timeoutMs:240000}} as const;
export type HealConfig={baseHp:number;currentHp:number;foodId:number;heal:number;effectTicks:number;eatDelayTicks:number};

export const savedLogoutOf=(before:Save,after:Save)=>(after.vars[134]??0)>(before.vars[134]??0);
export const singleIdentity=(log:string,name:string)=>/^[a-z0-9]{1,12}$/i.test(name)&&(log.match(/^LEDGER .* bot=([^\r\n]+)\r?$/gm)??[]).length===1
 &&log.split(/\r?\n/).some(l=>l.replace(/\r$/,'').startsWith('LEDGER ')&&l.replace(/\r$/,'').endsWith(` bot=${name}`));
export const STRONGHOLD_SOUTH={x:2461,z:3382},GNOME_START={x:2474,z:3437};
export const d8=(p:{x:number;z:number},q:{x:number;z:number})=>Math.max(Math.abs(p.x-q.x),Math.abs(p.z-q.z));

export type GnomeCase={label:string;fixture:number|null;course:'gnome'|'wilderness';target:number;start?:{x:number;z:number;level:number};agility?:number;reason?:string;baseline?:string};
export const GNOME_FOOD_PLAN:readonly GnomeCase[]=[{label:'food',fixture:10,course:'gnome',target:2},{label:'food-restart',fixture:13,course:'gnome',target:2}];
export const GNOME_FOOD_CONFIGURATION={format:'agility-gnome-food-1',initialization:INITIALIZATION_CONFIGURATION,
 cases:{food:FOOD_RECOVERY_CONFIGURATION,'food-restart':GNOME_FOOD_RESTART_CONFIGURATION}} as const;
export const ARDOUGNE_PLAN:readonly GnomeCase[]=[{label:'ardougne-entry',fixture:14,course:'gnome',target:10}];
export const ARDOUGNE_CONFIGURATION={format:'agility-ardougne-entry-1',initialization:INITIALIZATION_CONFIGURATION,entry:ARDOUGNE_ENTRY_CONFIGURATION} as const;
export const GNOME_CONSUMER_PLAN:readonly GnomeCase[]=[
 {label:'approach',fixture:1,course:'gnome',target:10,start:{x:2460,z:3445,level:0},agility:1},
 {label:'restart',fixture:2,course:'gnome',target:20,start:{x:2474,z:3437,level:0},agility:1},
 {label:'rerun',fixture:null,course:'gnome',target:10,baseline:'approach',reason:'already at target'},
 {label:'wilderness-entry',fixture:4,course:'wilderness',target:60,start:{x:2998,z:3916,level:0},agility:49,reason:'wilderness requires entry level 52'},
 // Lumbridge (fresh-account region) has no supported Gnome route; the Grand Tree upper floor is an unsupported plane.
 {label:'region',fixture:15,course:'gnome',target:10,start:{x:3222,z:3218,level:0},agility:1,reason:'unsupported gnome entry region: no safe route from here'},
 {label:'plane',fixture:16,course:'gnome',target:10,start:{x:2466,z:3495,level:1},agility:1,reason:'unsupported entry plane'},
];
export const GNOME_CONSUMER_CONFIGURATION={format:'agility-gnome-consumer-2',xpRate:25,initialization:INITIALIZATION_CONFIGURATION,cases:GNOME_CONSUMER_PLAN,
 interruptionDeadlineMs:interruptionDeadlineMs(INITIALIZATION_CONFIGURATION.tickMs)} as const;
export const DRAYNOR_PLAN:readonly GnomeCase[]=[{label:'draynor-entry',fixture:6,course:'gnome',target:10}];
export const RETAINED_PLAN:readonly GnomeCase[]=[{label:'course-approach',fixture:null,course:'gnome',target:10}];
export type CaseFiles={before:Save;after:Save;log:string;sha256:EvidenceHashes};
export type ModeEvidence={checks:Record<string,boolean>;cases:{label:string;name:unknown;before?:string;after?:string}[]};
export type Mode='full'|'draynor'|'course-approach'|'food-recovery'|'gnome-food'|'ardougne'|'gnome-consumer';

export function readJson(path:string){try{return JSON.parse(readFileSync(path,'utf8'));}catch{return undefined;}}

export const INTERRUPTION_FILES=['interrupted.log','interrupted.err','interrupted.sav','interrupted-at-kill.sav','interrupted-engine.log','interruption.json','restart-prelaunch.sav'];
export const RESTART_RAW=['restart-before.sav','interrupted-at-kill.sav','interrupted.sav','restart-prelaunch.sav','interrupted.log','interrupted-engine.log'] as const;
export function restartHashes(directory:string){return Object.fromEntries(RESTART_RAW.map(p=>[p,sha256(readFileSync(join(directory,p)))]));}

export function restartInitialProjection(save:Save){
 // UPDATE_STAT truncates XP/10. Keep exact raw XP bound by the CRC-checked
 // prelaunch bytes; compare every transmitted skill, including current levels.
 return {position:save.position,skills:save.skills.map(s=>({experience:s.xp,level:s.level,baseLevel:trainedLevel(s.xp)})),
  inventory:save.inventories[93]??[],equipment:save.inventories[94]??[]};
}

export function restartBinding(directory:string,name:string,target:number,source:unknown,termination:Child){
 return {format:'agility-restart-2',name,course:'gnome',target,source,configuration:GNOME_CONSUMER_CONFIGURATION,
  termination,sha256:restartHashes(directory)};
}
