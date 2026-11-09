import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseConfigs} from '../packages/knowledge/src/config';
import {solve,solved,applyClick} from './generated/mm-puzzle';
import {openBot,settle} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {componentId} from '../packages/core/src/logout';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {watchProductionLife} from './microbot-c-lifetime';
import {nativeClueSteps,nativeCluePoint,clueEffect} from './microbot-c-clues';
const root=resolve(import.meta.dir,'../vendor/rs-sdk/server/content');
function pack(file:string){return new Map(readFileSync(resolve(root,'pack',file),'utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(.+)$/);return m?[[m[2]!,Number(m[1])] as const]:[];}));}
let pieces:Map<number,{tile:number;family:string}>|undefined;
function nativePieces(){
 if(pieces)return pieces;pieces=new Map();const ids=pack('obj.pack');
 for(const b of parseConfigs(readFileSync(resolve(root,'scripts/minigames/game_trail/configs/trail.obj'),'utf8'),'trail.obj')){
  if(b.props.category?.[0]!=='trail_puzzle_piece')continue;
  const family=b.name.match(/^trail_slidingpuzzle([bcd])\d+$/)?.[1],id=ids.get(b.name),value=b.props.param?.find(v=>v.startsWith('puzzle_piece_id,'))?.split(',')[1];
  if(family&&id!==undefined&&value!==undefined)pieces.set(id,{family,tile:Number(value)+1});
 }
 return pieces;
}
export function readNativeTrailBoard(client:unknown,family:string):number[]|null{
 const c=client as any;if(c?.mainModalId!==componentId('trail_puzzle'))return null;
 const com=c?.ifType?.(componentId('trail_puzzle:com_2')),raw=com?.linkObjType;
 if(!raw||raw.length<25)return null;
 const b:number[]=[];for(let i=0;i<25;i++){const id=Number(raw[i]??0)-1;if(id<0)b.push(0);else{const piece=nativePieces().get(id);if(!piece||piece.family!==family)return null;b.push(piece.tile);}}
 return new Set(b).size===25&&b.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=24)?b:null;
}
export function dispatchTrailPuzzleMove(client:unknown,slot:number,expectedTile:number,family:string){
 const c=client as any,b=readNativeTrailBoard(c,family),before=b?.slice();
 if(!b||!Number.isSafeInteger(slot)||slot<0||slot>24||b[slot]!==expectedTile||!applyClick(b,slot))throw Error('native trail puzzle move precondition');
 const raw=c.ifType(componentId('trail_puzzle:com_2')).linkObjType[slot];
 if(typeof c.writeOpcode!=='function'||typeof c.out?.p2!=='function')throw Error('native trail puzzle packet surface unavailable');
 // Native [opheld5,_trail_puzzle_piece], matching quest-mm.ts, not INV_BUTTON5.
 c.writeOpcode(79);c.out.p2(raw-1);c.out.p2(slot);c.out.p2(componentId('trail_puzzle:com_2'));
 return{success:true,before,expected:b};
}
function install(client:unknown){
 const c=client as any,original=c?.executeBotAction;if(typeof original!=='function')throw Error('native puzzle executor unavailable');
 const wrapper=function(a:any){return a?.type==='trailPuzzleMove'?dispatchTrailPuzzleMove(c,a.slot,a.tile,a.family):original.call(c,a);};c.executeBotAction=wrapper;
 return()=>{if(c.executeBotAction===wrapper)c.executeBotAction=original;};
}
export function nativePuzzleRecipe(puzzleId:number){
 const ids=pack('obj.pack'),npcs=pack('npc.pack');
 const boxes=['trail.obj','trail_hard.obj'].flatMap(file=>parseConfigs(readFileSync(resolve(root,'scripts/minigames/game_trail/configs',file),'utf8'),file));
 const b=boxes.find(b=>ids.get(b.name)===puzzleId&&b.props.category?.[0]==='trail_puzzle');
 if(!b)throw Error('unknown native puzzle box');
 const family=b.props.param?.find(v=>v.startsWith('trail_puzzle,'))?.match(/trail_puzzle([bcd])$/)?.[1];if(!family)throw Error('native puzzle family unresolved');
 const clueName=b.name.replace(/_puzzlebox$/,''),clue=ids.get(clueName);if(clue===undefined)throw Error('native puzzle clue unresolved');
 const turnins:Record<string,{npc:string;file:string;zone?:string}>={
  trail_clue_hard_riddle014:{npc:'oziach',file:'scripts/areas/area_edgeville/scripts/oziach.rs2'},
  trail_clue_hard_riddle016:{npc:'wilough',file:'scripts/areas/area_varrock/scripts/wilough.rs2'},
  trail_clue_hard_riddle017:{npc:'general_bentnoze',file:'scripts/areas/area_falador/scripts/goblin_village/general_bentnoze.rs2'},
  trail_clue_hard_riddle018:{npc:'lord_iorwerth',file:'scripts/quests/quest_regicide/scripts/lord_iorwerth.rs2'},
  trail_clue_hard_riddle019:{npc:'examiner',file:'scripts/quests/quest_itexam/scripts/examiner.rs2'},
  trail_clue_hard_riddle020:{npc:'duel_monk',file:'scripts/minigames/game_duelarena/scripts/hamid.rs2'},
  trail_clue_hard_riddle021:{npc:'gnomepilot',file:'scripts/areas/area_gnome/scripts/gnome_glider.rs2',zone:'sindarpos'},
  trail_clue_hard_riddle025:{npc:'gnome_heckelfunch',file:'scripts/areas/area_gnome/scripts/heckel_funch.rs2'},
  trail_clue_hard_riddle026:{npc:'gnometrainer',file:'scripts/areas/area_gnome/scripts/gnome_trainer.rs2'},
 };
 const turn=turnins[clueName];let zone:ReturnType<typeof nativeCluePoint>|undefined;
 if(turn){
  const text=readFileSync(resolve(root,turn.file),'utf8'),expectedBox=text.match(/~trail_puzzle_complete\((trail_clue_\w+_puzzlebox)\)/)?.[1];
  const expectedFamily=boxes.find(b=>b.name===expectedBox)?.props.param?.find(v=>v.startsWith('trail_puzzle,'))?.match(/trail_puzzle([bcd])$/)?.[1];
  // Oziach/Wilough reference Bentnoze's box but native validation reads only
  // its family param; all three are family b. Preserve the pinned semantics.
  if(expectedFamily!==family||!text.includes('~progress_clue_hard('+clueName+',')||!text.includes('~give_trail_puzzle('+b.name+',')||!text.includes('[opnpc1,'+turn.npc+']'))throw Error('native puzzle turn-in handler/family changed');
  if(turn.zone){const constant=readFileSync(resolve(root,'scripts/areas/area_gnome/configs/glider.constant'),'utf8').match(new RegExp('\\^'+turn.zone+'\\s*=\\s*(\\d+_\\d+_\\d+_\\d+_\\d+)'))?.[1];if(!constant)throw Error('native glider clue zone unmapped');zone=nativeCluePoint(constant);}
 }
 return{puzzleId,name:b.name,family,clue,npc:turn?npcs.get(turn.npc):undefined,turninSource:turn?.file??null,zone};
}
// Reuses the existing 5x5 solver with an explicit node limit. Stage the puzzle
// box; optional turn-in requires the original clue and one exact mapped NPC.
export async function solveNativeCluePuzzle(s:Session,puzzleId:number,cap:number,maxNodes=25000,turnInNpcIndex?:number,stop:()=>boolean=()=>false){
 if(!Number.isSafeInteger(puzzleId)||!Number.isSafeInteger(cap)||cap<1||!Number.isSafeInteger(maxNodes)||maxNodes<1||maxNodes>100000||turnInNpcIndex!==undefined&&(!Number.isSafeInteger(turnInNpcIndex)||turnInNpcIndex<0))throw Error('invalid native puzzle order');
 const r=nativePuzzleRecipe(puzzleId),life=watchProductionLife(s,stop),start=s.tick(),over=()=>life.stopped()||s.tick()-start>=cap,stock=()=>s.sdk.getInventory().map(i=>({id:i.id,count:i.count}));
 const before=stock();let box=s.sdk.getInventory().find(i=>i.id===puzzleId);
 let moves=0,detail='',boardSolved=false,transition=false,collected=false,restore:(()=>void)|undefined;
 try{
  if(over())throw Error(life.reason()||'native puzzle budget');
  const target=()=>s.sdk.getState()?.nearbyNpcs.find(n=>n.index===turnInNpcIndex&&n.id===r.npc&&(!r.zone||(s.sdk.getState()?.player?.level===r.zone.level&&Math.max(Math.abs((n.tileX??n.x)-r.zone.x),Math.abs((n.tileZ??n.z)-r.zone.z))<=8)));
  if(turnInNpcIndex!==undefined){
   if(before.filter(i=>i.id===r.clue).reduce((n,i)=>n+i.count,0)!==1||!target())throw Error('stage one original clue beside exact native puzzle NPC/zone');
   if(s.sdk.getInventory().length>19)throw Error('native puzzle requires nine reward slots');
  }
  if(before.some(i=>i.id!==puzzleId&&i.id!==r.clue&&nativeClueSteps().some(v=>v.id===i.id)))throw Error('stage only selected native clue and puzzle; board storage is shared');
  if(!box){
   if(turnInNpcIndex===undefined||!target())throw Error('stage native puzzle box or exact collection NPC');
   if(s.sdk.getDialog()?.isOpen||(s.client as any)?.isChatBackInputOpen?.())throw Error('native puzzle collection requires closed existing dialogue');
   await s.sdk.sendInteractNpc(target()!.index,1);
   while(!over()&&!s.sdk.getInventory().some(i=>i.id===puzzleId)){
    const d=s.sdk.getDialog();if(d?.isOpen){if(d.options.length===1&&/continue/i.test(d.options[0]!.text))await s.sdk.sendClickDialog(d.options[0]!.index);else throw Error('native puzzle collection dialogue choice unmapped');}await waitTicks(s,1);
   }
   box=s.sdk.getInventory().find(i=>i.id===puzzleId);if(!box)throw Error('native puzzle collection debit/credit unobserved');collected=true;
   await s.direct({type:'closeModal',reason:'SDK'});
  }
  if(stock().filter(i=>i.id===puzzleId).reduce((n,i)=>n+i.count,0)!==1)throw Error('stage exactly one native puzzle box');
  restore=install(s.client);await s.sdk.sendUseItem(box.slot,1);
  if(!await waitUntil(s,()=>!!readNativeTrailBoard(s.client,r.family)||over(),{timeoutTicks:Math.min(10,cap)}))throw Error('native puzzle board not observed');
  if(over())throw Error(life.reason()||'native puzzle budget');
  const board=readNativeTrailBoard(s.client,r.family);if(!board)throw Error('native puzzle board invalid');
  const path=solve(board,1.6,maxNodes);if(!path)throw Error('native puzzle search node budget; board remains unchanged');
  if(path.length>cap-(s.tick()-start))throw Error('native puzzle path exceeds tick budget; no moves dispatched');
  const sim=board.slice();
  for(const slot of path){
   if(over())throw Error(life.reason()||'native puzzle tick budget');
   const observed=readNativeTrailBoard(s.client,r.family);if(!observed||observed.join()!==sim.join())throw Error('native puzzle board drift');
   await s.direct({type:'trailPuzzleMove',slot,tile:sim[slot],family:r.family,reason:'SDK'});applyClick(sim,slot);moves++;
   if(!await waitUntil(s,()=>readNativeTrailBoard(s.client,r.family)?.join()===sim.join()||over(),{timeoutTicks:Math.min(6,Math.max(1,cap-(s.tick()-start)))}))throw Error('native puzzle slide unobserved');
  }
  boardSolved=!!readNativeTrailBoard(s.client,r.family)&&solved(readNativeTrailBoard(s.client,r.family)!);if(!boardSolved)throw Error('native puzzle solved board not observed');
  if(turnInNpcIndex!==undefined){
   if(r.npc===undefined)throw Error('native puzzle NPC turn-in mapping missing for '+r.name);
   if(s.sdk.getInventory().length>19)throw Error('native puzzle turn-in requires nine reward slots');
   const npc=target();if(!npc)throw Error('exact native puzzle turn-in NPC/zone not nearby');
   const step=nativeClueSteps().find(v=>v.id===r.clue)!;if(before.filter(i=>i.id===r.clue).reduce((n,i)=>n+i.count,0)!==1)throw Error('stage exactly one original native puzzle clue');
   const cursor=Math.max(-1,...(s.sdk.getState()?.gameMessages??[]).map(m=>m.observationId??m.tick));
   await s.direct({type:'closeModal',reason:'SDK'});await s.sdk.sendInteractNpc(npc.index,1);
   while(!over()){
    const completed=(s.sdk.getState()?.gameMessages??[]).some(m=>m.type===0&&(m.observationId??m.tick)>cursor&&/completed the Treasure Trail/.test(m.text));
    transition=clueEffect(step,before,stock(),completed).ok&&!stock().some(i=>i.id===puzzleId&&i.count>0);if(transition)break;
    const d=s.sdk.getDialog();if(d?.isOpen){if(d.options.length===1&&/continue/i.test(d.options[0]!.text))await s.sdk.sendClickDialog(d.options[0]!.index);else throw Error('native puzzle turn-in dialogue choice unmapped');}await waitTicks(s,1);
   }
   if(!transition)throw Error('native puzzle clue/reward transition unobserved');
  }
 }catch(error){detail=String(error);}finally{restore?.();}
 detail ||= life.reason();const preserved=before.every(i=>i.id===puzzleId&&turnInNpcIndex!==undefined||i.id===r.clue&&turnInNpcIndex!==undefined||stock().filter(j=>j.id===i.id).reduce((n,j)=>n+j.count,0)>=before.filter(j=>j.id===i.id).reduce((n,j)=>n+j.count,0));
 return{ok:!detail&&boardSolved&&preserved&&(turnInNpcIndex===undefined||transition),puzzle:r.name,moves,boardSolved,transition,collected,preserved,ticks:s.tick()-start,detail};
}
if(import.meta.main){
 const name=process.argv[2]??'',puzzle=Number(process.argv[3]),cap=Number(process.argv[4]??200),npc=process.argv[5]===undefined?undefined:Number(process.argv[5]);if(!name||!Number.isSafeInteger(puzzle)||!Number.isSafeInteger(cap)||cap<1||npc!==undefined&&(!Number.isSafeInteger(npc)||npc<0))throw Error('Usage (members): bun scripts/microbot-c-clue-puzzle.ts <account> <puzzle-id> [ticks] [exact-turn-in-npc-index]');
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(name);let ok=false;try{const r=await solveNativeCluePuzzle(s,puzzle,cap,25000,npc,()=>stopped);console.log('NATIVE_PUZZLE_RESULT '+JSON.stringify(r));ok=r.ok;}finally{ok=await settle([s],ok,'finite native clue puzzle');}process.exitCode=ok?0:1;
}
