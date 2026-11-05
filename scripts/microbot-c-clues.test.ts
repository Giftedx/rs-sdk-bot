import {expect,test} from 'bun:test';
import {nativeCluePoint,nativeClueSteps,nativeClueSearchLocs,clueEffect,runNativeClueStep} from './microbot-c-clues';
test('native coordinate syntax resolves map square and local tile',()=>{expect(nativeCluePoint('1_50_50_9_18')).toEqual({level:1,x:3209,z:3218});});
test('native clue definitions derive exact dig/search/open and explicit guardian gaps',()=>{
 const rows=nativeClueSteps();expect(rows.length).toBeGreaterThan(50);
 expect(rows.find(v=>v.name==='trail_clue_easy_map001')).toMatchObject({kind:'dig',point:{level:0,x:3177,z:3360}});
 expect(rows.find(v=>v.name==='trail_clue_easy_simple001')).toMatchObject({kind:'search',point:{level:1,x:3209,z:3218}});
 expect(rows.find(v=>v.name==='trail_clue_hard_sextant001')).toMatchObject({kind:'unsupported'});
 expect(rows.find(v=>v.name==='trail_clue_hard_sextant001')!.gap).toContain('guardian');
 expect(nativeClueSearchLocs().length).toBeGreaterThan(10);
 expect(rows.filter(r=>r.kind==='talk')).toHaveLength(32);expect(rows.filter(r=>r.kind==='challenge')).toHaveLength(6);
 expect(rows.filter(r=>r.kind==='search')).toHaveLength(68);expect(rows.filter(r=>r.consumedInputs?.length)).toHaveLength(7);
 expect(rows.find(r=>r.name==='trail_clue_medium_riddle001')?.point).toEqual({level:0,x:3256,z:3487});
});
test('native Cook challenge collects scroll then submits configured answer at owned prompt',async()=>{
 const r=nativeClueSteps().find(v=>v.name==='trail_clue_medium_anagram002')!,next=nativeClueSteps().find(v=>v.name==='trail_clue_easy_map001')!;
 expect(r.answer).toBe(9);const items:any[]=[{id:r.id,count:1,slot:0}];let tick=0,talks=0,prompt=false;
 const s:any={client:{isChatBackInputOpen:()=>prompt},tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;cb();next();}});next();return()=>{active=false;};},sdk:{getInventory:()=>items,getSkill:()=>({level:10}),getState:()=>({player:{lifeId:1,worldX:r.point!.x,worldZ:r.point!.z,level:r.point!.level},nearbyNpcs:[{id:r.npc,index:3}],gameMessages:[]}),getDialog:()=>null,sendInteractNpc:async(index:number,op:number)=>{expect([index,op]).toEqual([3,1]);talks++;if(talks===1)items.push({id:r.challengeItem,count:1,slot:1});else prompt=true;},sendCountDialog:async(value:number)=>{expect(value).toBe(9);prompt=false;items.splice(0,2,{id:next.id,count:1,slot:0});}}};
 expect(await runNativeClueStep(s,r.id,30,()=>false,async()=>true)).toMatchObject({ok:true,kind:'challenge',preserved:true,effect:{outcome:'next-clue-or-casket'}});expect(talks).toBe(2);
});
test('dig step requires selected clue debit and exact mapped casket credit',()=>{
 const r=nativeClueSteps().find(v=>v.name==='trail_clue_easy_map001')!;
 expect(clueEffect(r,[{id:r.id,count:1}],[{id:r.casket!,count:1}],false).ok).toBe(true);
 expect(clueEffect(r,[{id:r.id,count:1}],[{id:995,count:100}],true).ok).toBe(false);
 expect(clueEffect(r,[{id:r.id,count:1}],[{id:r.id,count:1},{id:r.casket!,count:1}],false).ok).toBe(false);
});
test('finite staged dig skips routing from the exact tile and records one conversion',async()=>{
 const r=nativeClueSteps().find(v=>v.name==='trail_clue_easy_map001')!,items:any[]=[{id:r.id,count:1,slot:0},{id:r.tools[0],count:1,slot:1}];let tick=0;
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;cb();next();}});next();return()=>{active=false;};},sdk:{getSkill:()=>({level:10}),getInventory:()=>items,getDialog:()=>null,getState:()=>({player:{lifeId:1,worldX:r.point!.x,worldZ:r.point!.z,level:r.point!.level},gameMessages:[]}),sendUseItem:async(slot:number,op:number)=>{expect([slot,op]).toEqual([1,1]);items[0]={id:r.casket,count:1,slot:0};}}};
 expect(await runNativeClueStep(s,r.id,20,()=>false,async()=>{throw Error("already at the dig tile");})).toMatchObject({ok:true,kind:'dig',preserved:true,effect:{outcome:'casket'}});
});
