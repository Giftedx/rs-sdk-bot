import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {readNativeTrailBoard,dispatchTrailPuzzleMove,nativePuzzleRecipe,solveNativeCluePuzzle} from './microbot-c-clue-puzzle';
import {componentId} from '../packages/core/src/logout';
import {nativeClueSteps} from './microbot-c-clues';
const objs=new Map(readFileSync('vendor/rs-sdk/server/content/pack/obj.pack','utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(.+)$/);return m?[[m[2]!,Number(m[1])] as const]:[];}));
function boardRaw(){return Array.from({length:25},(_,i)=>i<24?objs.get('trail_slidingpuzzleb'+String(i+1).padStart(2,'0'))!+1:0);}
test('native puzzle board validates family/permutation and encodes OPHELD5',()=>{
 const raw=boardRaw();[raw[23],raw[24]]=[raw[24]!,raw[23]!];const calls:any[]=[];
 const c={mainModalId:componentId('trail_puzzle'),ifType:()=>({linkObjType:raw}),writeOpcode:(n:number)=>calls.push(['opcode',n]),out:{p2:(n:number)=>calls.push(['p2',n])}};
 expect(readNativeTrailBoard(c,'b')?.slice(23)).toEqual([0,24]);expect(readNativeTrailBoard(c,'c')).toBeNull();
 expect(dispatchTrailPuzzleMove(c,24,24,'b').expected.slice(23)).toEqual([24,0]);
 expect(calls).toEqual([['opcode',79],['p2',raw[24]!-1],['p2',24],['p2',componentId('trail_puzzle:com_2')]]);
 expect(()=>dispatchTrailPuzzleMove(c,0,1,'b')).toThrow('precondition');
 expect(readNativeTrailBoard({...c,mainModalId:-1},'b')).toBeNull();
});
test('all nine native puzzle NPC families resolve; glider is zone gated',()=>{
 for(const n of [14,16,17,18,19,20,21,25,26])expect(nativePuzzleRecipe(objs.get('trail_clue_hard_riddle'+String(n).padStart(3,'0')+'_puzzlebox')!).npc).toBeInteger();
 expect(nativePuzzleRecipe(objs.get('trail_clue_hard_riddle021_puzzlebox')!).zone).toEqual({level:0,x:2850,z:3497});
});
test('finite puzzle reuses solver, observes each slide, restores executor and retains box',async()=>{
 const puzzleId=objs.get('trail_clue_hard_riddle017_puzzlebox')!,raw=boardRaw();[raw[23],raw[24]]=[raw[24]!,raw[23]!];let fields:number[]=[];
 const original=(_:unknown)=>({success:true});
 const c={mainModalId:componentId('trail_puzzle'),executeBotAction:original,ifType:()=>({linkObjType:raw}),writeOpcode:()=>{fields=[];},out:{p2:(n:number)=>{fields.push(n);if(fields.length===3){const slot=fields[1]!,empty=raw.indexOf(0);raw[empty]=raw[slot]!;raw[slot]=0;}}}};
 const s:any={client:c,direct:(a:unknown)=>c.executeBotAction(a),tick:()=>0,sdk:{getInventory:()=>[{id:puzzleId,count:1,slot:0}],getSkill:()=>({level:10}),getState:()=>({player:{lifeId:1}}),sendUseItem:async()=>({success:true})}};
 expect(await solveNativeCluePuzzle(s,puzzleId,20)).toMatchObject({ok:true,moves:1,boardSolved:true,transition:false,preserved:true});expect(c.executeBotAction).toBe(original);
});
test('exact Bentnoze turn-in confirms puzzle+clue debit and next clue credit',async()=>{
 const puzzleId=objs.get('trail_clue_hard_riddle017_puzzlebox')!,r=nativePuzzleRecipe(puzzleId),items:any[]=[{id:puzzleId,count:1,slot:0},{id:r.clue,count:1,slot:1}],next=nativeClueSteps().find(v=>v.name==='trail_clue_easy_map001')!,raw=boardRaw();let dialog=false,tick=0;
 const c={mainModalId:componentId('trail_puzzle'),executeBotAction:(_:unknown)=>({success:true}),ifType:()=>({linkObjType:raw})};
 const s:any={client:c,direct:(a:unknown)=>c.executeBotAction(a),tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;cb();next();}});next();return()=>{active=false;};},sdk:{getInventory:()=>items,getSkill:()=>({level:10}),getState:()=>({player:{lifeId:1},nearbyNpcs:[{index:7,id:r.npc}],gameMessages:[]}),sendUseItem:async()=>({success:true}),sendInteractNpc:async()=>{dialog=true;},getDialog:()=>dialog?{isOpen:true,options:[{index:0,text:'Click here to continue'}]}:null,sendClickDialog:async()=>{items.splice(0,2,{id:next.id,count:1,slot:0});dialog=false;}}};
 expect(await solveNativeCluePuzzle(s,puzzleId,20,100,7)).toMatchObject({ok:true,boardSolved:true,transition:true,preserved:true});
});
