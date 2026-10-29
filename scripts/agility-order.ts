// bun scripts/agility-order.ts <account> <gnome|barbarian|wilderness> <target-level> [--save=<own-save>]
// AGI_MAX_LAPS=1000, AGI_MAX_TICKS=10000, AGI_PROGRESS_TICKS=150, AGI_ENTRY_TICKS=2000.
// AGI_POTION=1 permits an owned potion for Wilderness entry. Server comes from openBot's account config.
// AGI_ENTRY_TICKS bounds the whole entry, including the Draynor boat route to the Gnome course.
// Source decision, 2026-10-28: measured agility-laps.ts course facts + pinned skill_agility scripts
// -> this order consumer. Adapt to observed per-obstacle effects and position-based restart;
// do not import the measurement CLI (it logs in at module load). Acceptance belongs to agility-order-proof.
import {basename} from 'node:path';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {sessionWalker,walkPath,type PathDeps} from '../packages/core/src/walk';
import {executionContext} from '../vendor/rs-sdk/sdk/execution-context';
import {sail as sailBoat,disembark as disembarkBoat,type BoatResult} from '../packages/core/src/boat';
import {readPracticeSave} from './measure/fleet-player-save';

export type Course='gnome'|'barbarian'|'wilderness';
type Pos={worldX:number;worldZ:number;level:number};
type Step={name:string;id:number;x:number;z:number;zero?:boolean};
export const COURSES:Record<Course,{start:{x:number;z:number};steps:Step[];pit?:Step}>={
 gnome:{start:{x:2474,z:3437},steps:[
  {name:'log',id:2295,x:2474,z:3435},{name:'net',id:2285,x:2473,z:3425},
  {name:'branch',id:2313,x:2473,z:3422},{name:'rope',id:2312,x:2478,z:3420},
  {name:'treedown',id:2314,x:2486,z:3419},{name:'net2',id:2286,x:2485,z:3426},
  {name:'pipe',id:154,x:2484,z:3431}]},
 barbarian:{start:{x:2552,z:3561},pit:{name:'pit',id:1755,x:2547,z:9951},steps:[
  {name:'ropeswing',id:2282,x:2551,z:3550},{name:'log',id:2294,x:2550,z:3546},
  {name:'net',id:2284,x:2538,z:3545},{name:'ledge',id:2302,x:2535,z:3547},
  {name:'ladder',id:3205,x:2532,z:3545,zero:true},{name:'wall1',id:1948,x:2536,z:3553},
  {name:'wall2',id:1948,x:2539,z:3553},{name:'wall3',id:1948,x:2542,z:3553}]},
 wilderness:{start:{x:2998,z:3916},pit:{name:'pit',id:1755,x:3005,z:10363},steps:[
  {name:'pipe',id:2288,x:3004,z:3938},{name:'ropeswing',id:2283,x:3005,z:3952},
  {name:'stones',id:2311,x:3001,z:3960},{name:'log',id:2297,x:3001,z:3945},
  {name:'rocks',id:2328,x:2994,z:3936,zero:true}]},
};
export interface AgilityOptions{course:Course;target:number;maxLaps:number;maxTicks:number;progressTicks:number;entryTicks:number;potion:boolean;barcrawl?:number}
export function agilityOptions(course:string,target:string,env:Record<string,string|undefined>=process.env):AgilityOptions{
 if(!Object.hasOwn(COURSES,course))throw Error('unknown agility course');
 const integer=(value:string|undefined,fallback:number,max:number)=>{const n=Number(value??fallback);if(!Number.isSafeInteger(n)||n<1||n>max)throw Error('invalid agility target or budget');return n;};
 return{course:course as Course,target:integer(target,0,99),maxLaps:integer(env.AGI_MAX_LAPS,1000,100000),
  maxTicks:integer(env.AGI_MAX_TICKS,10000,1000000),progressTicks:integer(env.AGI_PROGRESS_TICKS,150,10000),
  entryTicks:integer(env.AGI_ENTRY_TICKS,2000,100000),potion:env.AGI_POTION==='1'};
}
export function agilityPreflight(o:AgilityOptions,base:number,current:number){
 if(!Number.isFinite(base)||base<1||!Number.isFinite(current)||current<1)return 'agility state unknown';
 if(base>=o.target)return 'already at target';
 if(o.course==='barbarian'&&(current<35||o.barcrawl!==2))return 'barbarian requires level 35 and observed completed Barcrawl';
 if(o.course==='wilderness'&&current<52&&!(o.potion&&current>=49))return 'wilderness requires entry level 52';
 return null;
}
export function onCourse(c:Course,p:Pos){
 const [x,z,w,h]=c==='gnome'?[2465,3410,30,35]:c==='barbarian'?[2528,3540,30,18]:[2988,3930,22,40];
 return p.level>=0&&p.level<=(c==='gnome'?2:c==='barbarian'?1:0)&&p.worldX>=x&&p.worldX<=x+w&&p.worldZ>=z&&p.worldZ<=z+h;
}
// Read the next reachable obstacle from the actual landing tile, including saves after a fall.
// Transient obstacle tiles are never treated as a completed action; runAgility waits for effects.
export function resumeStep(c:Course,p:Pos):number{
 if(c==='gnome'){
  if(p.level===2)return p.worldX<2483?3:4;
  if(p.level===1)return 2;
  if(p.worldZ>=3433)return 0;
  if(p.worldZ>=3427)return p.worldX>=2480?6:1;
  return p.worldX>=2480?5:1;
 }
 if(c==='barbarian'){
  if(p.level===1)return p.worldX<=2533?4:3;
  if(p.worldZ>=3552){if(p.worldX<2537)return 5;if(p.worldX<2540)return 6;if(p.worldX<2543)return 7;return 0;}
  if(p.worldX<=2533)return 5;
  if(p.worldX<2546)return 2;
  return 1;
 }
 if(p.worldZ<=3938)return 0;
 if(p.worldX<=2994&&p.worldZ<=3946)return 4;
 if(p.worldZ>=3959)return p.worldX>=3002?2:3;
 if(p.worldZ>=3955)return 2;
 return 1;
}
const food=/^(lobster|swordfish|shark|trout|salmon|tuna|shrimp|shrimps|cooked meat|bread|banana|cheese)$/i;
// consume.rs2 player_consume_item: an eat sets %eat_delay=map_clock+2, and the server silently
// discards a later eat while %eat_delay>=map_clock. Delivery 1793228337659-LzzYtU
// ended at HP 34/70 with two lobsters missing. Its dispatch timing is unknown:
// a discarded immediate re-eat is an inference, not an observed historical cause.
export const EAT_DELAY_TICKS=2;
export function eatReady(lastEffectTick:number,now:number){return now>lastEffectTick+EAT_DELAY_TICKS;}
// Source decision, 2026-10-28 (build-agility-inflight-food-settlement-27): pinned OpHeldHandler.ts,
// OpLocHandler.ts, PlayerOps.ts P_EXACTMOVE and wilderness_course.rs2 -> runAgility health().
// While a course script holds p_delay, OpHeld returns without UNSET_MAP_FLAG: the eat is lost silently.
// Each stepping-stone jump calls p_exactmove (unsetMapFlag) then p_delay(1). Delivery 1793230520845-UVgqj1
// fall-1: eat sent at 550 mid-stones (anim 741 = human_spot_jump), no heal, opRejected +1 at 552/554/556/558
// with no other worker op; fall-1-after.sav holds varp 266=3 (stones completed). So the rises are scripted
// exactmove unsets, not food packets. A low-HP eat therefore waits until the dispatched obstacle is observed
// settled: same tile, anim -1 and no opRejected rise for quietTicks consecutive ticks. Ropeswing waits
// p_delay(distance) without anim or movement, so quietTicks exceeds that pause. Unsettled within maxTicks fails.
export const OBSTACLE_SETTLE={quietTicks:6,maxTicks:40};
// Source decision, 2026-10-28: scripts/foodcourier.ts boats + courier-route.ts lanes -> Gnome entry.
// The land path east of x 2760 crosses White Wolf Mountain (courier-route.ts: the 2026-10-25 death).
// A Draynor/Port Sarim start sails Port Sarim -> Musa Point, walks to Brimhaven, sails to Ardougne.
// research/route-danger.ts: Draynor -> Wydin -> dock and Ardougne dock -> course have 0 aggressive
// spawns in reach; Musa -> Brimhaven passes two level-14 scorpions and a level-5 snake, so a weak
// account carries food (wydinstore: banana 3, cheese 3) and eats through the existing health check.
export function gnomeEntry(p:Pos):'walk'|'draynor'|null{
 if(p.level!==0)return null;
 if(p.worldX<=2760)return 'walk';
 return p.worldX>=3000&&p.worldX<=3110&&p.worldZ>=3195&&p.worldZ<=3290?'draynor':null;
}
// Source decision, 2026-10-28 (build-agility-shop-approach-17): pinned m47_50.jm2 NPC 557 (Wydin) at 3014,3204,
// port_sarim.npc Trade op3 -> wydinstore, and scripts/shop-buyer.ts npcSpot -> this consumer. Adapt: the dock
// end 3029,3217 does not observe Wydin, so openShop failed. The vendor pathfinder plans the dock -> 3015,3206
// leg through the public east side; it never uses wydindoor 2069 (3012,3204, employee-only back room x<3012).
export const DRAYNOR_ENTRY={fare:30,fares:2,foodReserve:12,foods:[/^banana$/i,/^cheese$/i],foodMax:6,
 wydin:{id:557,name:/^wydin$/i},shop:{x:3015,z:3206,tol:1},dock:{x:3029,z:3217,tol:3},
 toSarim:[{x:3092,z:3250,tol:1},{x:3089,z:3266,tol:2},{x:3060,z:3265,tol:3},{x:3047,z:3237,tol:3},{x:3029,z:3217,tol:3}],
 toBrimhaven:[{x:2920,z:3160,tol:5},{x:2850,z:3175,tol:5},{x:2800,z:3200,tol:5},{x:2774,z:3228,tol:3}],
 toCourse:[{x:2461,z:3382,tol:3}],musaDeck:{x:2956,z:3143},ardougneDeck:{x:2683,z:3268}};
// Coins needed before the first step. A refusal leaves the saved state unchanged.
export function draynorFunds(coins:number,ownedFood:number){
 const need=DRAYNOR_ENTRY.fare*DRAYNOR_ENTRY.fares+(ownedFood>0?0:DRAYNOR_ENTRY.foodReserve);
 return coins>=need?null:`draynor entry needs ${need} carried coins for boat fares${ownedFood>0?'':' and food'}`;
}
type Point={x:number;z:number;tol?:number};
// Source decision, 2026-10-28 (build-agility-public-entry-19): pinned SDK collision + gnome_gate.rs2 ->
// course approach. The course lies in the closed Stronghold interior (level-0 flood fill x2369..2505,
// z3385..3524). The retained 2494,3437 strip is outside gnomefence 1982, and every plan to 2474,3437 from
// outside ends there. The public link is gnome_areagate 190 (m38_52 LOC 0 27 55 = 2459,3383, op1 Open):
// from the south it walks to 2461,3382 and force-moves 3 north to 2461,3385. Femi (676, spawned 2459,3382)
// takes the first southern Open while femi_help (varp 152) is 0. "OK then." sets 2 (femi.rs2), which also
// keeps her later Grand Tree help free. Pipes 154 and net 2286 are course obstacles, not an entrance.
export const STRONGHOLD_GATE={id:190,x:2459,z:3383,south:{x:2461,z:3382},north:{x:2461,z:3385},
 femi:/^ok then\.?$/i,attempts:4,waitTicks:30,quietTicks:8,
 // Source decision, 2026-10-28 (femi-settlement-21): femi.rs2 grandtree_femi_boxes + agility.rs2
 // forcewalk2/clipped_telewalk -> this gate consumer. After "Thanks traveller!" the server closes UI and runs
 // forcewalk2 to 0_38_52_29_52 (2461,3380): 1 delay, then 1 delay per tile (2 from 2461,3382), then 6
 // facesquare/anim delays before femi_help=2 and "Thanks again friend!". Retained CLI (agixavn07): UI closed
 // at tick65, moved 3381/3380 at66-67; dispatch-to-publish lag was 2 ticks. Bound = 1+2+6+2.
 femiSettle:{box:{x:2461,z:3380},ticks:11}};
const d8=(a:{x:number;z:number},b:{x:number;z:number})=>Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z));
// A partial plan endpoint is never accepted: the route must end within one tile of its goal.
export function gnomeApproachRoute(plan:(from:{x:number;z:number},to:{x:number;z:number})=>{x:number;z:number}[],p:{x:number;z:number}):'direct'|'gate'|null{
 const G=STRONGHOLD_GATE,start=COURSES.gnome.start;
 const reaches=(from:{x:number;z:number},to:{x:number;z:number})=>{if(d8(from,to)<=1)return true;const end=plan(from,to).at(-1);return !!end&&d8(end,to)<=1;};
 if(reaches(p,start))return 'direct';
 return reaches(p,G.south)&&reaches(G.north,start)?'gate':null;
}
export interface GateDeps{left:(label:string)=>void;live:()=>void;health:()=>Promise<void>}
// Source decision, 2026-10-28 (femi-observation-20): pinned femi.rs2 final thanks + SDK
// dialog-page.ts / clickDialogByText -> this entry consumer. Adapt guarded choice and
// observed retirement; reject per-tick unguarded redispatch. Retained copies are negative
// regressions. Native page/timing evidence belongs to the unchanged harness gates.
// Pinned SDK dialog-page.ts includes resumedPauseButton in pageId. A changed token alone
// can therefore still describe the unresolved option page. Compare its published contents too.
type GatePage={pageId:string|null;isOpen:boolean;isWaiting:boolean;text:string;options:{index:number;text:string;componentId?:number}[]};
type GateObservation={tick:number;page:GatePage};
type FemiSettle={start:number;end?:number;marks:SettleMark[]};
type FemiChoice={tick:number;page:GatePage;index:number;reply:{success:boolean;reason?:string;message?:string};advanced?:GateObservation;accepted?:GateObservation;settle?:FemiSettle;completed?:GateObservation};
const gatePageKey=(p:GatePage)=>JSON.stringify([p.isOpen,p.text,p.options]);
const femiThanks=(p:GatePage)=>p.isOpen&&p.text.split('\n').some(t=>t==='Thanks again friend!');
const femiAccepted=(p:GatePage)=>p.isOpen&&p.text.split('\n').some(t=>t==='Thanks traveller!');
type SettleMark={tick:number;at:string;anim:number;open:boolean;text:string};
// Open the gate from its south side until the north entrance is observed. Femi's dialogue is answered
// only with "OK then."; any other choice fails with the observed text. Bounded by attempts and the entry budget.
export async function crossStrongholdGate(s:Session,d:GateDeps){
 const G=STRONGHOLD_GATE,label='open Stronghold gate';
 const pos=()=>s.sdk.getState()?.player;
 const inside=()=>{const p=pos();return !!p&&p.level===0&&p.worldX===G.north.x&&p.worldZ===G.north.z;};
 let opens=0,femi=0,choiceAttempts=0;const dialog:string[]=[],choices:FemiChoice[]=[];
 let pending:{key:string;choice?:FemiChoice}|undefined;
 const page=():GatePage=>{
  const dlg=s.sdk.getState()?.dialog;
  const clean=(v:string)=>v.replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
  return{pageId:dlg?.pageId??null,isOpen:!!dlg?.isOpen,isWaiting:!!dlg?.isWaiting,
   text:[...new Set([dlg?.text??'',...(dlg?.allComponents??[]).map(c=>c.text)].flatMap(t=>t.split(/\n|\|/)).map(clean).filter(Boolean))].join('\n'),
   options:(dlg?.options??[]).map(o=>({index:o.index,text:o.text,componentId:o.componentId}))};
 };
 const trace=(event:string,detail:unknown)=>{const p=pos();console.log(`AGILITY_ENTRY_GATE_DIALOG ${JSON.stringify({event,tick:s.tick(),at:p?`${p.worldX},${p.worldZ},${p.level}`:'unknown',detail})}`);};
 const fail=(why:string):never=>{
  const p=pos(),st=s.sdk.getState();
  const info={at:p?`${p.worldX},${p.worldZ},${p.level}`:'unknown',opens,femi,choiceAttempts,choices,dialog:dialog.slice(-8),
   npcs:(st?.nearbyNpcs??[]).filter(n=>d8(n,G)<=8).map(n=>({id:n.id,name:n.name,x:n.x,z:n.z})),
   locs:(st?.nearbyLocs??[]).filter(l=>d8(l,G)<=4).map(l=>({id:l.id,name:l.name,x:l.x,z:l.z})),
   messages:(st?.gameMessages??[]).slice(-10).map(m=>m.text)};
  console.log(`AGILITY_ENTRY_GATE_FAIL ${JSON.stringify({why,...info})}`);
  throw Error(`${label}: ${why} ${JSON.stringify(info)}`);
 };
 for(let attempt=0;attempt<G.attempts&&!inside();attempt++){
  d.left(label);d.live();await d.health();d.live();
  opens++;const openReply=await s.direct({type:'interactLoc',x:G.x,z:G.z,locId:G.id,optionIndex:1,reason:'SDK'});
  trace('open-reply',{opens,reply:openReply});d.live();d.left(label);
  if(openReply&&typeof openReply==='object'&&'success' in openReply&&openReply.success===false)fail(`gate dispatch rejected ${JSON.stringify(openReply)}`);
  let talked=false,quiet=0;
  // The scripted box action has its own source-derived bound; it is never cut by waitTicks or a new Open.
  const settling=()=>{const st=choices[0]?.settle;return !!st&&st.end===undefined;};
  for(let i=0;(i<G.waitTicks||settling())&&!inside();i++){
   d.left(label);await waitTicks(s,1);d.live();
   d.left(label);const observed={tick:s.tick(),page:page()},p=observed.page,key=gatePageKey(p);
   trace('observe',observed);
   if(pending){
    if(key===pending.key||pending.choice&&p.isOpen&&p.options.some(o=>G.femi.test(o.text))){quiet=0;continue;}
    trace('advanced',observed);
    if(pending.choice)pending.choice.advanced=observed;
    pending=undefined;
   }
   if(choices.length===1&&choices[0]!.advanced&&femiThanks(p)&&!choices[0]!.completed){
    choices[0]!.completed=observed;femi=1;trace('femi-completed',observed);
    if(choices[0]!.settle)choices[0]!.settle.end=observed.tick;
   }
   const help=choices.length===1?choices[0]!:undefined;
   // "Thanks traveller!" retired: femi.rs2 closes UI and starts the box action. UI closure is expected here.
   if(help?.accepted&&!help.settle&&!help.completed&&!p.isOpen){
    help.settle={start:observed.tick,marks:[]};trace('settle-start',{tick:observed.tick});
   }
   if(help&&settling()){
    const pl=pos(),st=help.settle!,last=st.marks.at(-1);
    const mark:SettleMark={tick:observed.tick,at:pl?`${pl.worldX},${pl.worldZ},${pl.level}`:'unknown',anim:pl?.animId??-1,open:p.isOpen,text:p.text};
    if(!last||last.at!==mark.at||last.anim!==mark.anim||last.open!==mark.open||last.text!==mark.text){st.marks.push(mark);trace('settle',mark);}
    if(p.isOpen)fail('unexpected dialogue during Femi settlement');
    if(observed.tick-st.start>=G.femiSettle.ticks)fail('Femi settlement unresolved');
    continue;
   }
   if(p.isOpen&&!p.isWaiting){
    if(p.text&&dialog.at(-1)!==p.text)dialog.push(p.text);
    const pick=p.options.find(o=>G.femi.test(o.text));
    const continuation=p.options.length===1&&/^click here to continue[.!]?$/i.test(p.options[0]!.text);
    if(!pick&&p.options.length&&!continuation)fail(`unexpected dialogue choice ${p.options.map(o=>o.text).join(' | ')}`);
    if(pick&&(p.options.length!==2||!p.options.some(o=>o.text==="Sorry, I'm a bit busy.")))fail('unexpected Femi choice page');
    if(!p.pageId)fail('dialogue page identity unavailable');
    if(pick&&choices.length)fail('repeated Femi choice after advancement');
    trace('dispatch',{page:p,index:pick?.index??0});
    if(pick)choiceAttempts++;
    const reply=pick?await s.sdk.clickDialogByText(G.femi):await s.sdk.sendClickDialog(0);
    trace('dispatch-reply',{page:p,index:pick?.index??0,reply});
    const choice: FemiChoice|undefined=pick?{tick:observed.tick,page:p,index:pick.index,reply}:undefined;
    if(choice)choices.push(choice);
    else if(help?.advanced&&!help.accepted&&!help.completed&&femiAccepted(p))help.accepted=observed;
    d.live();d.left(label);
    if(!reply?.success)fail(`dialogue dispatch rejected ${reply?.reason??reply?.message??'missing reply'}`);
    pending={key,choice};talked=true;quiet=0;continue;
   }
   // The gate script ended in dialogue (Femi) without crossing; open again after it settles.
   if(talked&&++quiet>=G.quietTicks)break;
  }
  // Do not interrupt an unresolved page with a new Open or mistake UI closure for help.
  if(page().isOpen)fail('dialogue advancement unobserved');
  if(choices.length&&femi!==1)fail('Femi completion unobserved');
 }
 if(!inside())fail('north entrance unobserved');
 const p=pos()!,r={opens,femi,choiceAttempts,choices,at:`${p.worldX},${p.worldZ},${p.level}`,tick:s.tick()};
 console.log(`AGILITY_ENTRY_GATE ${JSON.stringify(r)}`);
 return r;
}
export function needsCourseApproach(c:Course,p:Pos){
 if(!onCourse(c,p))return true;
 // The broad course bounds include the retained 2494,3437 tile. A fresh
 // ground-level log start must reach its approach, even on a restarted order.
 return c==='gnome'&&p.level===0&&resumeStep(c,p)===0
  &&Math.max(Math.abs(p.worldX-COURSES[c].start.x),Math.abs(p.worldZ-COURSES[c].start.z))>1;
}
interface EntryTravelControls{
 left:(label:string)=>void;live:()=>void;health:()=>Promise<void>;
 low:()=>boolean;heals:()=>number;interrupted:()=>boolean;idleMs?:number;
}
// Source decision, 2026-10-28: sessionWalker + pinned collision/course rules ->
// installed Agility entry. Preserve the actual walk result before any recovery;
// an endpoint or onCourse bound is not entry proof. The Stronghold gate step
// (crossStrongholdGate) precedes this walk when the course start is unreachable.
export async function travelAgilityEntry(w:PathDeps,points:Point[],label:string,deadline:number,d:EntryTravelControls){
 const goal=points.at(-1);if(!goal)throw Error(`${label}: missing entry goal`);
 let rest=points,first:unknown;
 for(let attempt=0;attempt<20;attempt++){
  d.left(label);d.live();await d.health();d.live();
  let lowStopped=false;const trace:string[]=[];
  const r=await walkPath(w,rest,{maxTicks:Math.max(1,deadline-(w.tick?.()??0)),idleMs:d.idleMs,
   stop:()=>{if(d.interrupted())return true;if(d.low()){lowStopped=true;return true;}return false;},
   log:message=>{trace.push(message);if(trace.length>20)trace.shift();}});
  const p=w.pos(),current={...r,at:p?{...p}:null,goal:{...goal},nextPoint:rest[r.next]??null,
   nearby:w.locs().map(l=>({id:l.id,name:l.name,x:l.x,z:l.z,options:l.optionsWithIndex})),
   messages:(w.messages?.()??[]).slice(-20).map(m=>({...m})),trace};
  first??=current;
  const evidence={label,attempt,first,current};
  console.log(`AGILITY_ENTRY_WALK ${JSON.stringify(evidence)}`);
  const fail=(why:string):never=>{throw Error(`${label}: ${why} ${JSON.stringify(evidence)}`);};
  // Preserve the walk cause even when the owner's current state also refuses.
  try{d.live();}catch(e){fail(`${r.detail??'walk result'}; ${String(e)}`);}
  if(d.interrupted())fail(`${r.detail??'walk result'}; session interrupted`);
  if(r.ok){
   if(p&&p.level===0&&Math.max(Math.abs(p.x-goal.x),Math.abs(p.z-goal.z))<=(goal.tol??2))return;
   fail('walk reported success without observed entry position');
  }
  if(r.detail!=='stopped'||!lowStopped||!d.low())fail(r.detail??'walk failed without detail');
  const heals=d.heals();
  try{await d.health();d.live();}catch(e){fail(`${r.detail}; ${String(e)}`);}
  if(d.interrupted())fail(`${r.detail}; session interrupted`);
  if(d.heals()<=heals||d.low())fail(`${r.detail}; food effect unobserved`);
  // Only a demonstrated food effect permits resuming the unfinished route.
  rest=rest.slice(Math.min(r.next,rest.length-1));
 }
 throw Error(`${label}: low-HP recovery limit exhausted ${JSON.stringify({first,goal})}`);
}
export interface EntryFoodDeps{approach:(points:Point[],label:string)=>Promise<void>;left:(label:string)=>void;live:()=>void;coins:()=>number;owned:()=>number;deadline:number}
// Walk into Wydin's public shop, observe NPC 557 with Trade, then buy supported food above the fare reserve.
// A failure reports the first boundary with the position and every nearby NPC with its options.
export async function buyEntryFood(s:Session,d:EntryFoodDeps){
 const E=DRAYNOR_ENTRY,reserve=E.fare*E.fares;
 const wydin=()=>(s.sdk.getState()?.nearbyNpcs??[]).find(n=>n.id===E.wydin.id&&E.wydin.name.test(n.name));
 const fail=(why:string):never=>{
  const p=s.sdk.getState()?.player,nearby=(s.sdk.getState()?.nearbyNpcs??[]).map(n=>({name:n.name,id:n.id,x:n.x,z:n.z,options:(n.optionsWithIndex??[]).map(o=>o.text)}));
  const info={at:p?`${p.worldX},${p.worldZ},${p.level}`:'unknown',coins:d.coins(),nearby};
  console.log(`AGILITY_ENTRY_SHOP_FAIL ${JSON.stringify({why,...info})}`);
  throw Error(`food shop unavailable: ${why} ${JSON.stringify(info)}`);
 };
 if(!wydin())await d.approach([E.shop],'walk to Wydin');
 d.live();
 if(!wydin()&&!await waitUntil(s,()=>!!wydin(),{timeoutTicks:Math.max(1,Math.min(10,d.deadline-s.tick()))}))fail('Wydin unobserved');
 d.live();const npc=wydin()!;
 if(!(npc.optionsWithIndex??[]).some(o=>/^trade$/i.test(o.text)))fail('Wydin Trade option unobserved');
 let bought=0,spent=0;
 try{
  const shop=await s.bot.openShop(npc);d.live();
  if(!shop.success||!s.sdk.getState()?.shop?.isOpen)fail(`open: ${shop.message}`);
  for(const item of E.foods)for(let i=0;i<3&&bought<E.foodMax;i++){
   d.left('food purchase');
   const line=s.sdk.getState()?.shop?.shopItems?.find(x=>item.test(x.name));
   if(!line||line.count<=0||!Number.isFinite(line.buyPrice)||line.buyPrice<0||d.coins()-line.buyPrice<reserve)break;
   const c0=d.coins(),f0=d.owned(),r=await s.bot.buyFromShop(line,1);d.live();
   const cost=c0-d.coins(),got=d.owned()-f0;
   console.log(`AGILITY_ENTRY_PURCHASE ${JSON.stringify({item:line.name,sdkSuccess:r.success,bought:got,spent:cost,coins:d.coins(),tick:s.tick()})}`);
   if(got!==1||cost<=0)break;bought++;spent+=cost;
  }
 }finally{await s.bot.closeShop();}
 if(bought<1)fail('food purchase effect unobserved');
 if(d.coins()<reserve)throw Error('food purchase left too few coins for boat fares');
 return{bought,spent};
}
// V2 click timing from the measured runner: scripts reject packets while delayed. These tiles
// show an obstacle has started. A following click may be sent but is never counted as an effect.
export function wildernessStarted(name:string,p:Pos){
 if(p.level!==0)return false;
 switch(name){
  case 'pipe':return p.worldX===3004&&p.worldZ>=3940&&p.worldZ<=3950;
  case 'ropeswing':return p.worldX===3005&&p.worldZ>=3953&&p.worldZ<=3958;
  case 'stones':return p.worldZ===3960&&p.worldX>=2996&&p.worldX<=3001;
  case 'log':return p.worldZ===3945&&p.worldX>=2994&&p.worldX<=3002;
  default:return false;
 }
}
export async function runAgility(s:Session,o:AgilityOptions){
 const start=s.tick(),end=start+o.maxTicks;let ended=false;
 void s.ended.then(()=>{ended=true;});
 const pos=()=>s.sdk.getState()!.player!;
 const xp=()=>s.sdk.getSkillXp('Agility')!;
 const base=()=>s.sdk.getSkill('Agility')!.baseLevel;
 const hp=()=>s.sdk.getSkill('Hitpoints')!.level;
 const live=()=>{if(ended)throw Error('session interrupted');if(s.tick()>=end)throw Error('agility tick budget exhausted');if(hp()<=0)throw Error('died');};
 let observeAction=()=>{};
 const tick=async()=>{live();await waitTicks(s,1);live();observeAction();};
 const ready=()=>{const p=s.sdk.getState()?.player,a=s.sdk.getSkill('Agility'),h=s.sdk.getSkill('Hitpoints');return !!p&&p.worldX>0&&p.worldZ>0&&!!a&&a.baseLevel>0&&!!h&&h.baseLevel>0&&Number.isFinite(s.sdk.getSkillXp('Agility'))&&Array.isArray(s.sdk.getState()?.inventory);};
 if(!await waitUntil(s,ready,{timeoutTicks:Math.min(20,o.maxTicks)}))throw Error('entry state unobserved');
 live();
 // Read-only client projection before any worker action, including health/entry.
 // Closed-bank assets stay bound by the harness's exact prelaunch save bytes.
 const initial=s.sdk.getState()!,project=(list:{slot:number;id:number;count:number}[])=>(list??[]).map(({slot,id,count})=>({slot,id,count}));
 console.log('AGILITY_INITIAL '+JSON.stringify({name:s.name,course:o.course,target:o.target,tick:s.tick(),state:{
  position:{x:pos().worldX,z:pos().worldZ,level:pos().level},
  skills:(initial.skills??[]).map(({experience,level,baseLevel})=>({experience,level,baseLevel})),
  inventory:project(initial.inventory),equipment:project(initial.equipment)}}));
 const refusal=agilityPreflight(o,base(),s.sdk.getSkill('Agility')!.level);if(refusal)throw Error(refusal);
 const beforeXp=xp(),beforeLevel=base(),C=COURSES[o.course];let laps=0,falls=0,pitExits=0,eats=0;
 const tile=()=>`${pos().worldX},${pos().worldZ},${pos().level}`;
 const anim=()=>s.sdk.getState()?.player?.animId??-1;
 const rejectedTotal=()=>s.sdk.getState()?.opFeedback?.opRejectedCount??0;
 const low=()=>hp()<Math.max(8,s.sdk.getSkill('Hitpoints')!.baseLevel*0.5);
 // ops counts every worker packet, so a later opRejected rise can be attributed against it.
 type Observation={tick:number;at:string;anim:number;rejected:number;mapFlags:number;hp:number;xp:number;ops:number;messages:{tick:number;text:string}[]};
 let ops=0,pending:{step:string;tick:number;xp:number;at:string;rejected:number;ops:number;observations:Observation[]}|null=null;
 const observation=():Observation=>({tick:s.tick(),at:tile(),anim:s.sdk.getState()?.player?.animId??NaN,
  rejected:s.sdk.getState()?.opFeedback?.opRejectedCount??NaN,mapFlags:s.sdk.getState()?.opFeedback?.mapFlagUnsetCount??NaN,hp:hp(),xp:xp(),ops,
  messages:(s.sdk.getState()?.gameMessages??[]).map(m=>({tick:m.tick,text:m.text}))});
 const actionTrace=(event:string,extra:Record<string,unknown>)=>console.log('AGILITY_ACTION '+JSON.stringify({event,...observation(),...extra}));
 observeAction=()=>{
  if(pending?.step!=='stones')return;
  const v=observation(),last=pending.observations.at(-1);
  if(last?.tick===v.tick)return;
  pending.observations.push(v);
  actionTrace('observation',{actionId:pending.ops});
 };
 // A speculative packet is not a new observed action. Keep the stones dispatch identity through
 // the crossing, including the exactmove UNSET_MAP_FLAG feedback (retained ticks 550..558).
 const click=async(step:Step,speculative=false)=>{
  if(!speculative&&pending?.step==='stones'&&xp()===pending.xp
   &&(wildernessStarted('stones',pos())||tile()==='3002,3960,0'&&anim()===741))return;
  live();if(s.sdk.getState()?.dialog?.isOpen){ops++;actionTrace('modal',{});await s.direct({type:'closeModal',reason:'SDK'});}
  ops++;
  if(!speculative)pending={step:step.name,tick:s.tick(),xp:xp(),at:tile(),rejected:rejectedTotal(),ops,observations:[observation()]};
  actionTrace('dispatch',{step:step.name,locId:step.id,x:step.x,z:step.z,speculative,actionId:pending?.ops??null});
  await s.direct({type:'interactLoc',x:step.x,z:step.z,locId:step.id,optionIndex:1,reason:'SDK'});
 };
 const fallText=(t:string)=>/slip|lose your footing|lost your balance|fall|bites you|stumble/i.test(t)&&!/carefully|safely|skillfully|skilfully/i.test(t);
 // Observe the last dispatched obstacle until it is settled. Terminal XP or fall ticks are recorded as
 // evidence; settlement itself needs the full quiet window. No packet is sent while settling.
 const settleObstacle=async(sequence:number)=>{
  const p=pending;if(!p)return;
  const start=s.tick(),ops0=ops,marks:Observation[]=[];
  let quiet=0,last:typeof marks[number]|undefined,xpTick:number|undefined,fallTick:number|undefined;
  const report=(event:string)=>({event,sequence,step:p.step,dispatchTick:p.tick,dispatchAt:p.at,start,tick:s.tick(),
   actionId:p.ops,observations:p.observations,quiet,xpTick,fallTick,rejected:rejectedTotal()-p.rejected,opsSinceDispatch:ops-p.ops,opsWhileSettling:ops-ops0,marks});
  for(;;){
   const v=observation();
   if(v.xp>p.xp)xpTick??=v.tick;
   if((s.sdk.getState()?.gameMessages??[]).some(m=>m.tick>=p.tick&&fallText(m.text)))fallTick??=v.tick;
   quiet=last&&v.tick===last.tick+1&&v.at===last.at&&v.anim===-1&&last.anim===-1&&v.rejected===last.rejected
    &&Number.isFinite(v.rejected)&&Number.isFinite(v.mapFlags)&&v.mapFlags===last.mapFlags
    &&v.ops===last.ops&&v.hp===last.hp&&v.xp===last.xp?quiet+1:0;
   marks.push(v);
   last=v;
   if(quiet>=OBSTACLE_SETTLE.quietTicks){pending=null;console.log('AGILITY_FOOD '+JSON.stringify({...report('settle'),settled:true}));return;}
   if(v.tick-start>=OBSTACLE_SETTLE.maxTicks){
    const r={...report('settle'),settled:false};console.log('AGILITY_FOOD '+JSON.stringify(r));
    throw Error(`obstacle settlement unresolved before food: ${JSON.stringify(r)}`);
   }
   await tick();
  }
 };
 let lastEat=-Infinity;
 const health=async()=>{
  live();if(!low())return;
  // Never send an eat into a running course script: OpHeld would drop it without feedback.
  await settleObstacle(eats+1);live();if(!low())return;
  if(!eatReady(lastEat,s.tick())){
   console.log('AGILITY_FOOD '+JSON.stringify({event:'cooldown',sequence:eats+1,tick:s.tick(),lastEffectTick:lastEat,readyAfter:lastEat+EAT_DELAY_TICKS}));
   await waitUntil(s,()=>eatReady(lastEat,s.tick()),{timeoutTicks:Math.max(0,Math.min(EAT_DELAY_TICKS+1,end-s.tick()))});
   live();if(!eatReady(lastEat,s.tick()))throw Error('food effect unobserved: eat delay unexpired at deadline');
  }
  const f=s.sdk.getInventory().find(i=>food.test(i.name));if(!f)throw Error('low HP: no owned food');
  const oldHp=hp(),held=s.sdk.getInventory().filter(i=>i.id===f.id).reduce((n,i)=>n+i.count,0),sentAt=s.tick();
  const seen=new Set((s.sdk.getState()?.gameMessages??[]).map(m=>`${m.observationId}:${m.tick}:${m.text}`));
  const rejected=rejectedTotal,rejected0=rejected(),ops0=ops;
  const observe=()=>{
   const st=s.sdk.getState(),inventory=s.sdk.getInventory().map(i=>({slot:i.slot,id:i.id,count:i.count}));
   return{tick:s.tick(),hp:hp(),baseHp:s.sdk.getSkill('Hitpoints')!.baseLevel,xp:xp(),
    count:inventory.filter(i=>i.id===f.id).reduce((n,i)=>n+i.count,0),inventory,
    at:tile(),workerOps:ops,anim:st?.player?.animId??null,dialog:st?.dialog??null,rejected:rejected()-rejected0,ops:ops-ops0,
    messages:(st?.gameMessages??[]).filter(m=>!seen.has(`${m.observationId}:${m.tick}:${m.text}`)).map(m=>({tick:m.tick,text:m.text}))};
  };
  const trace=(event:string,extra:Record<string,unknown>={})=>console.log('AGILITY_FOOD '+JSON.stringify({event,sequence:eats+1,slot:f.slot,id:f.id,held,...observe(),...extra}));
  trace('dispatch');
  ops++;actionTrace('food',{sequence:eats+1,slot:f.slot,id:f.id});
  const sent:any=await s.direct({type:'useInventoryItem',slot:f.slot,optionIndex:1,reason:'SDK'});
  trace('reply',{reply:sent});
  if(sent?.success!==true)throw Error(`food dispatch refused: ${JSON.stringify({sent,tick:s.tick(),hp:hp(),slot:f.slot,id:f.id,held})}`);
  let hpTick:number|undefined,inventoryTick:number|undefined;
  if(!await waitUntil(s,()=>{
   const v=observe();trace('observation');
   if(v.hp>oldHp)hpTick??=v.tick;if(v.count===held-1)inventoryTick??=v.tick;
   return v.hp>oldHp&&v.count===held-1;
  },{timeoutTicks:Math.max(0,Math.min(8,end-s.tick()))})){
   live();const st=s.sdk.getState();
   const count=s.sdk.getInventory().filter(i=>i.id===f.id).reduce((n,i)=>n+i.count,0);
   const messages=(st?.gameMessages??[]).filter(m=>!seen.has(`${m.observationId}:${m.tick}:${m.text}`)).map(m=>m.text);
   throw Error(`food effect unobserved: ${JSON.stringify({sentAt,tick:s.tick(),lastEat,oldHp,hp:hp(),slot:f.slot,id:f.id,held,count,
    anim:st?.player?.animId,dialog:!!st?.dialog?.isOpen,rejected:rejected()-rejected0,ops:ops-ops0,messages})}`);
  }
  trace('effect',{hpTick,inventoryTick});
  eats++;lastEat=s.tick();live();
  if(low())await health();
 };
 const pit=()=>!!C.pit&&pos().level===0&&Math.abs(pos().worldX-C.pit.x)<15&&Math.abs(pos().worldZ-C.pit.z)<20;
 const recoverPit=async()=>{
  const deadline=Math.min(end,s.tick()+o.progressTicks);await health();
  while(pit()&&s.tick()<deadline){await click(C.pit!);await tick();}
  if(pit()||!onCourse(o.course,pos()))throw Error('pit exit unobserved');
  pitExits++;console.log(`AGILITY_RECOVERY pit tick=${s.tick()} at=${pos().worldX},${pos().worldZ}`);
 };
 if(o.course==='wilderness'&&s.sdk.getSkill('Agility')!.level<52){
  const pot=s.sdk.getInventory().find(i=>/^agility potion/i.test(i.name));if(!o.potion||!pot)throw Error('missing owned agility potion');
  ops++;await s.direct({type:'useInventoryItem',slot:pot.slot,optionIndex:1,reason:'SDK'});
  if(!await waitUntil(s,()=>s.sdk.getSkill('Agility')!.level>=52,{timeoutTicks:Math.min(8,end-s.tick())}))throw Error('agility boost unobserved');
  live();
 }
 // A restart may begin in a pit or on a raised platform. Never walk it back through a course wall.
 if(pit())await recoverPit();
 const entry={route:'none' as 'none'|'walk'|'draynor',fares:0,foodBought:0,coinsSpent:0,eats:0,
  gate:null as null|{opens:number;femi:number;at:string;tick:number}};
 if(needsCourseApproach(o.course,pos())){
  if(pos().level!==0)throw Error('unsupported entry plane');
  const region=o.course==='gnome'?gnomeEntry(pos()):'walk';
  if(!region)throw Error('unsupported gnome entry region: no safe route from here');
  const coins=()=>s.sdk.getInventory().filter(i=>i.id===995).reduce((n,i)=>n+i.count,0);
  const owned=()=>s.sdk.getInventory().filter(i=>food.test(i.name)).reduce((n,i)=>n+i.count,0);
  if(region==='draynor'){const short=draynorFunds(coins(),owned());if(short)throw Error(short);}
  entry.route=region;const coins0=coins(),eats0=eats,entryEnd=Math.min(end,s.tick()+o.entryTicks);
  const left=(label:string)=>{live();if(s.tick()>=entryEnd)throw Error(`${label}: entry tick budget exhausted`);};
  // Low HP stops the walk, the existing health check eats, and the walk resumes from the observed tile.
  const travel=async(points:{x:number;z:number;tol?:number}[],label:string)=>{
   await travelAgilityEntry(await sessionWalker(s),points,label,entryEnd,{left,live,health,low,heals:()=>eats,
    interrupted:()=>ended||hp()<=0||executionContext.getStore()?.signal.aborted===true});
  };
  // packages/core/src/boat.ts owns the boat legs. This caller keeps health, fare accounting and the entry budget.
  const boatStop=()=>ended||hp()<=0;
  const boatFailed=(r:BoatResult,label:string)=>{live();if(r.outcome==='deadline')throw Error(`${label}: entry tick budget exhausted`);throw Error(`${label}: ${r.detail}`);};
  const sail=async(npc:RegExp,choices:RegExp[],deck:{x:number;z:number},label:string)=>{
   left(label);const before=coins();
   const r=await sailBoat(s,{npc,choices,deck,stop:boatStop,deadline:entryEnd,before:health,retryTicks:1});
   if(!r.ok)boatFailed(r,`${label} unobserved`);
   live();const paid=before-coins();if(paid!==DRAYNOR_ENTRY.fare)throw Error(`${label} fare effect unobserved: paid ${paid}`);
   entry.fares++;console.log(`AGILITY_ENTRY_FARE ${JSON.stringify({leg:label,paid,coins:coins(),tick:s.tick()})}`);
   const g=await disembarkBoat(s,{stop:boatStop,deadline:entryEnd,attempts:6,missTicks:1});
   if(!g.ok)boatFailed(g,`${label} gangplank unobserved`);live();
  };
  if(region==='draynor'){
   await travel(DRAYNOR_ENTRY.toSarim,'walk to Port Sarim');
   if(owned()===0){
    entry.foodBought=(await buyEntryFood(s,{approach:travel,left,live,coins,owned,deadline:entryEnd})).bought;
    await travel([DRAYNOR_ENTRY.dock],'walk to Port Sarim dock');
   }
   await sail(/^(seaman|captain tobias)/i,[/^yes please/i],DRAYNOR_ENTRY.musaDeck,'sail to Karamja');
   await travel(DRAYNOR_ENTRY.toBrimhaven,'walk to Brimhaven');
   await sail(/^customs officer$/i,[/journey on this ship/i,/search away/i,/^ok\.?$/i],DRAYNOR_ENTRY.ardougneDeck,'sail to Ardougne');
   await travel(DRAYNOR_ENTRY.toCourse,'walk to Gnome Stronghold');
  }
  if(o.course==='gnome'){
   const w=await sessionWalker(s),p=pos(),at=`${p.worldX},${p.worldZ},${p.level}`;
   const route=gnomeApproachRoute((a,b)=>w.plan(0,a,b),{x:p.worldX,z:p.worldZ});
   console.log(`AGILITY_ENTRY_ROUTE ${JSON.stringify({route,at,tick:s.tick()})}`);
   if(!route)throw Error(`course approach: no supported public route from ${at}`);
   if(route==='gate'){
    await travel([{...STRONGHOLD_GATE.south,tol:1}],'walk to Stronghold gate');
    entry.gate=await crossStrongholdGate(s,{left,live,health});
   }
  }
  await travel([{...C.start,tol:1}],'course approach');
  entry.coinsSpent=coins0-coins();entry.eats=eats-eats0;
  console.log(`AGILITY_ENTRY ${JSON.stringify({...entry,tick:s.tick(),at:`${pos().worldX},${pos().worldZ},${pos().level}`})}`);
 }
 if(o.course==='barbarian'&&!onCourse(o.course,pos())){
  // m39_55.jm2 LOC 0 56 39:2287; enter from north after the Barcrawl gate.
  const deadline=Math.min(end,s.tick()+o.progressTicks);
  while(!onCourse(o.course,pos())&&s.tick()<deadline){await click({name:'entry-pipe',id:2287,x:2552,z:3559});await tick();}
 }
 if(o.course==='wilderness'&&!onCourse(o.course,pos())){
  const deadline=Math.min(end,s.tick()+o.progressTicks),gateXp=xp();let last='';
  while((!onCourse(o.course,pos())||xp()<=gateXp)&&s.tick()<deadline){
   await health();if(s.sdk.getSkill('Agility')!.level<52)throw Error('wilderness entry boost expired');
   const p=`${pos().worldX},${pos().worldZ},${pos().level}`;if(p===last||!last)await click({name:'ridge',id:2309,x:2998,z:3917});last=p;await tick();
  }
  if(xp()<=gateXp)throw Error('ridge XP effect unobserved');
 }
 if(!onCourse(o.course,pos()))throw Error('course entry unobserved');
 let i=resumeStep(o.course,pos()),stepXp=xp(),stepStart=s.tick(),previous=tile(),still=0,preBlocked=false;
 // Every course dispatch first completes any required health recovery. An obstacle that settled with
 // XP, or a pit landing, during that recovery is left to the loop instead of being clicked again.
 const advance=async(step:Step)=>{await health();if(pit()||xp()>stepXp)return;await click(step);};
 const seen=new Set<string>();
 for(const m of s.sdk.getState()?.gameMessages??[])seen.add(`${m.observationId}:${m.tick}:${m.text}`);
 if(base()<o.target)await advance(C.steps[i]!);
 while(base()<o.target){
  await tick();const p=pos();let fell=false;
  for(const m of s.sdk.getState()?.gameMessages??[]){const key=`${m.observationId}:${m.tick}:${m.text}`;if(seen.has(key))continue;seen.add(key);if(fallText(m.text))fell=true;}
  if(fell){falls++;preBlocked=true;console.log(`AGILITY_RECOVERY fall tick=${s.tick()} step=${C.steps[i]!.name} hp=${hp()} at=${p.worldX},${p.worldZ} xp=${xp()}`);}
  if(low())await health();
  // ladders.rs2 ladder_from_cellar exits at the pit tile minus 6400 z: north-east of the lava, so
  // a Wilderness pit exit resumes at the stones. A Barbarian pit exit repeats the rope swing.
  // Published HP can trail the fall message, so advance() re-checks health after the climb.
  if(pit()){await recoverPit();i=o.course==='wilderness'?resumeStep(o.course,pos()):0;stepXp=xp();stepStart=s.tick();preBlocked=false;await advance(C.steps[i]!);continue;}
  if(!onCourse(o.course,p))throw Error('left course or died');
  const position=tile();still=position===previous?still+1:0;previous=position;
  const step=C.steps[i]!,gain=xp()-stepXp;
  const zeroDone=step.zero&&still>=1&&(step.name==='ladder'?p.level===0&&p.worldX<=2533:p.worldZ<=3933);
  if(gain>0||zeroDone){
   if(i===C.steps.length-1){laps++;if(laps>=o.maxLaps&&base()<o.target)throw Error('agility lap budget exhausted');}
   console.log(`AGILITY_PROGRESS level=${base()} xp=${xp()} tick=${s.tick()} step=${step.name}`);
   i=(i+1)%C.steps.length;stepXp=xp();stepStart=s.tick();still=0;preBlocked=false;
   if(base()>=o.target)break;
   await advance(C.steps[i]!);continue;
  }
  // Barbarian ledge falls return to the ground below the net; retry from that net.
  if(o.course==='barbarian'&&i===3&&p.level===0&&still>=1){i=2;await advance(C.steps[i]!);}
  if(s.tick()-stepStart>=o.progressTicks)throw Error(`no observed progress at ${step.name}`);
  // No speculative next-obstacle click while health recovery is due: settle and eat first.
  if(o.course==='wilderness'&&!preBlocked&&wildernessStarted(step.name,p)){
   if(low())await health();else{if(step.name==='stones')preBlocked=true;await click(C.steps[(i+1)%C.steps.length]!,step.name==='stones');}continue;
  }
  if(still>=1)await advance(C.steps[i]!);
 }
 live();if(base()<o.target||xp()<=beforeXp)throw Error('agility goal or XP effect absent');
 return{ok:true,at:new Date().toISOString(),course:o.course,target:o.target,beforeLevel,level:base(),xpGained:xp()-beforeXp,laps,falls,pitExits,eats,finalHp:hp(),entry,ticks:s.tick()-start};
}
if(import.meta.main){
 let s:Session|undefined;
 try{
  const [name,course,target]=process.argv.slice(2);if(!name||!course||!target||!/^[a-z0-9]{1,12}$/i.test(name))throw Error('usage: agility-order.ts <account> <course> <target> [--save=<own-save>]');
  const o=agilityOptions(course,target),path=process.argv.find(a=>a.startsWith('--save='))?.slice(7);
  if(path){if(basename(path).toLowerCase()!==name.toLowerCase()+'.sav')throw Error('save must belong to account');const saved=readPracticeSave(path);o.barcrawl=saved.vars[77]??0;
   // Saved levels can be boosted. XP determines the trained target in the live observation after login.
  }
  s=await openBot(name);const result=await runAgility(s,o);
  console.log('AGILITY_ORDER_RESULT '+JSON.stringify(result));await finish([s],true,`agility-order ${result.course} level=${result.level} target=${result.target} xp=${result.xpGained}`);
 }catch(error){await finish(s?[s]:[],false,String(error));}
}
