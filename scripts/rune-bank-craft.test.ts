import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {settleRuneEntryModal,dispatchRuneEntry,runeEntryWarning,runeEntrySnapshot,runeBankTarget,runeBankBalanced,runeBankDone,runeBankOk,chooseRuneAltar,RUNE_ALTARS,ruinTarget,inRuinFootprint,runeAltarStaging,RUINS,type RuneBankLedger} from './rune-bank-craft';
import type {Session} from '../packages/core/src/inprocess';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';
import {parseJm2} from '../packages/knowledge/src/jm2';
import {runeBankCraftFixture} from '../packages/practice/src/rune-bank-craft-proof';
import {combatLevel,deadly,type Hunter} from '../packages/core/src/danger';

test('mind ruins wait for wilderness warning closure and refuse an unsettled modal',async()=>{
 for(const mode of ['closed','stuck','refused','stop'] as const){
  let tick=0,closes=0,stopped=false;
  const state={modalOpen:true,modalInterface:1908,interface:{isOpen:true,interfaceId:1908},dialog:{isOpen:false}};
  const s={tick:()=>tick,sdk:{getState:()=>state,sendCloseModal:async()=>{
   closes++;return {success:mode!=='refused'};
  }},onTick:(cb:()=>void)=>{
   let active=true;
   const next=()=>{if(!active)return;tick++;
    if(tick===2&&mode==='closed'){state.modalOpen=false;state.modalInterface=-1;state.interface.isOpen=false;}
    if(mode==='stop')stopped=true;
    cb();if(active)queueMicrotask(next);
   };
   queueMicrotask(next);return ()=>{active=false;};
  }} as unknown as Session;
  expect(await settleRuneEntryModal(s,()=>stopped)).toBe(mode==='closed');
  expect(closes).toBe(1);
  expect(tick).toBe(mode==='closed'?2:mode==='stuck'?10:mode==='stop'?1:0);
  if(mode==='closed'){
   expect(await settleRuneEntryModal(s,()=>false)).toBe(true);
   expect(closes).toBe(1);
  }
 }
});

test('a wilderness warning opened after dispatch is closed and the canceled entry is sent again',async()=>{
 let tick=0,closes=0,inside=false;const dispatched:number[]=[];
 const state={modalOpen:false,modalInterface:-1,interface:{isOpen:false,interfaceId:-1},dialog:{isOpen:false}};
 const s={tick:()=>tick,sdk:{getState:()=>state,sendCloseModal:async()=>{closes++;return {success:true};}},
  onTick:(cb:()=>void)=>{
   let active=true;
   const next=()=>{if(!active)return;tick++;
    // Server order: the first dispatch is canceled two ticks later and the warning opens; the close lands next tick.
    if(dispatched.length===1&&tick===dispatched[0]!+2){state.modalOpen=true;state.modalInterface=1908;state.interface={isOpen:true,interfaceId:1908};}
    if(closes===1&&state.modalOpen){state.modalOpen=false;state.modalInterface=-1;state.interface={isOpen:false,interfaceId:-1};}
    if(dispatched.length===2&&tick===dispatched[1]!+1)inside=true;
    cb();if(active)queueMicrotask(next);
   };
   queueMicrotask(next);return ()=>{active=false;};
  }} as unknown as Session;
 const r=await dispatchRuneEntry(s,{stop:()=>false,entered:()=>inside,dispatch:async attempt=>{
  expect(state.modalOpen).toBe(false);dispatched.push(tick);expect(attempt).toBe(dispatched.length);return {success:true};
 }});
 expect(r).toEqual({entered:true,dispatches:2,warnings:1});
 expect(closes).toBe(1);
 expect(runeEntryWarning({modalOpen:true,modalInterface:1908,interface:{isOpen:true,interfaceId:1908}} as BotWorldState)).toBe(true);
 expect(runeEntryWarning({modalOpen:false,modalInterface:-1,interface:{isOpen:false,interfaceId:-1}} as BotWorldState)).toBe(false);
});

test('entry observer preserves blocking UI and feedback but excludes stale messages',()=>{
 const state={tick:286,revision:90,inventory:[{id:1448,slot:0,count:1}],
  dialog:{isOpen:true},interface:{isOpen:false,interfaceId:-1},modalOpen:true,modalInterface:233,
  bank:{isOpen:false},shop:{isOpen:false},opFeedback:{opRejectedCount:2},gameMessages:[
   {text:'old',tick:285,observationId:88},{text:'fresh same tick',tick:286,observationId:91},
   {text:'old without cursor',tick:286},{text:'fresh without cursor',tick:287}]} as BotWorldState;
 const before=JSON.stringify(state),snapshot=runeEntrySnapshot(state,90,286);
 expect(snapshot.messages.map(m=>m.text)).toEqual(['fresh same tick','fresh without cursor']);
 expect(snapshot).toMatchObject({inventory:state.inventory,dialog:{isOpen:true},modalOpen:true,modalInterface:233,
  opFeedback:{opRejectedCount:2},bankOpen:false,shopOpen:false,tradeOpen:null});
 expect(JSON.stringify(state)).toBe(before);
 expect(runeEntrySnapshot(null,90,286)).toMatchObject({dialog:null,modalOpen:null,opFeedback:null,messages:[]});
});

test('ladder fixture uses the consumer combat baseline and retains starter Runecraft stock',()=>{
 expect(runeBankCraftFixture.skills).toEqual({Attack:47,Hitpoints:33,Runecraft:1});
 expect(runeBankCraftFixture.varps[63]).toBe(6);
 expect(runeBankCraftFixture.bank).toEqual([{id:1436,count:30},{id:556,count:25},{id:1438,count:1},{id:1448,count:1}]);
 expect(runeBankCraftFixture.inventory).toEqual([{id:556,count:5}]);
 const skills=Object.fromEntries(Object.entries(runeBankCraftFixture.skills).map(([name,level])=>[name.toLowerCase(),level]));
 const bear:Hunter={name:'Bear',combat:19,mode:'cowardly',reach:13,spawns:[{x:2979,z:3501,level:0}]};
 expect(deadly(bear,combatLevel({}),10)).toBe(true);
 expect(combatLevel(skills)).toBe(24);
 expect(deadly(bear,combatLevel(skills),skills.hitpoints!)).toBe(false);
});

const ledger=(o:Partial<RuneBankLedger>={}):RuneBankLedger=>({essence0:30,essence:0,air0:30,air:60,consumed:30,crafted:30,...o});
const base={level0:1,level:2,target:99,bankEssence:0,held:{essence:0,air:0},stopped:false};

test('altar follows level and owned access items on each bank visit',()=>{
 const owned=new Set([1438,1448,1444,1440,1442,1446]);
 for(const [level,name] of [[1,'air'],[2,'mind'],[5,'water'],[9,'earth'],[14,'fire'],[20,'body']] as const)
  expect(chooseRuneAltar(level,owned).altar?.name).toBe(name);
 expect(chooseRuneAltar(5,new Set([1438])).wanted).toEqual(['water','mind']);
 expect(chooseRuneAltar(5,new Set([1438])).altar?.name).toBe('air');
 expect(chooseRuneAltar(1,new Set()).altar).toBeUndefined();
 expect(chooseRuneAltar(1,new Set()).wanted).toEqual(['air']);
 expect(chooseRuneAltar(27,new Set([...owned,1454])).altar?.name).toBe('body');
 expect(RUNE_ALTARS.map(a=>a.name)).toEqual(['air','mind','water','earth','fire','body']);
 // A tiara and a locked method's talisman cannot grant access.
 expect(chooseRuneAltar(1,new Set([5527,1448])).altar).toBeUndefined();
 expect(chooseRuneAltar(66,new Set([1446])).altar?.name).toBe('body');
 expect(chooseRuneAltar(66,new Set([1446])).wanted).toEqual([]);
});

test('mixed altar output reconciles every rune type, not just the total',()=>{
 const mixed=ledger({air:57,crafted:30,runes:{556:{before:30,after:57,crafted:27},558:{before:0,after:3,crafted:3}}});
 expect(runeBankBalanced(mixed)).toBe(true);
 expect(runeBankBalanced({...mixed,runes:{556:{before:30,after:56,crafted:27},558:{before:0,after:4,crafted:3}}})).toBe(false);
 expect(runeBankOk({...base,ledger:mixed,held:{essence:0,air:0,runes:3}})).toBe(false);
});

test('altar levels, XP, access items and destinations match pinned content',()=>{
 const root=new URL('../vendor/rs-sdk/server/content/',import.meta.url);
 const rows=readFileSync(new URL('scripts/skill_runecraft/configs/runecraft.dbrow',root),'utf8');
 const pack=readFileSync(new URL('pack/obj.pack',root),'utf8');
 const locPack=readFileSync(new URL('pack/loc.pack',root),'utf8');
 const entry=readFileSync(new URL('scripts/skill_runecraft/scripts/runecraft.rs2',root),'utf8');
 expect(entry).toContain('oc_category(last_useitem) = talismans');
 expect(entry).toContain('db_getfield($data, runecraft_table:talisman, 0) ! last_useitem');
 const coord=(value:string)=>{const [level,mx,mz,x,z]=value.split(',')[0]!.split('_').map(Number);return {x:mx!*64+x!,z:mz!*64+z!,level:level!};};
 for(const a of RUNE_ALTARS){
  const row=rows.split(`[runecraft_${a.name}]`)[1]!.split('[')[0]!;
  const field=(name:string)=>row.match(new RegExp(`^data=${name},(.+)$`,'m'))![1]!.trim();
  expect(Number(field('level'))).toBe(a.level);expect(Number(field('experience'))/10).toBe(a.xp);
  expect(pack).toContain(`${a.talisman}=${a.name}_talisman`);
  expect(pack).toContain(`${a.rune}=${a.name}rune`);
  expect(Number(field('members'))).toBe(0);
  expect(field('talisman')).toBe(`${a.name}_talisman`);
  expect(locPack).toContain(`${2452+RUNE_ALTARS.indexOf(a)}=${a.name}temple_ruined`);
  expect(locPack).toContain(`${a.portal}=${a.name}temple_exit_portal`);
  expect(coord(field('altar_coord'))).toEqual(a.ruins);
  expect(coord(field('enter_coord'))).toEqual(a.inside);
  expect(coord(field('exit_coord'))).toEqual(a.outside);
 }
});

test('non-air ruins stage outside the blocked centre and approach the pinned placement',()=>{
 const root=new URL('../vendor/rs-sdk/server/content/',import.meta.url);
 const config=readFileSync(new URL('scripts/skill_runecraft/configs/runecraft.loc',root),'utf8');
 for(const a of RUNE_ALTARS){
  const {at,q}=ruinTarget(a),file=q.src.slice('maps/'.length);
  const placed=parseJm2(file,readFileSync(new URL(q.src,root),'utf8')).locs.filter(l=>l.id===q.id);
  expect(placed.map(({x,z,level,shape,angle})=>({x,z,level,shape,angle}))).toEqual([{...at,shape:q.shape,angle:q.angle}]);
  const block=config.split(`[${a.name}temple_ruined]`)[1]!.split('\n[')[0]!;
  expect(block).toContain(`width=${q.width}`);expect(block).toContain(`length=${q.height}`);expect(block).not.toContain('forceapproach');
  // altar_coord is the footprint centre, which the walk router refuses as a tile destination.
  expect(inRuinFootprint(a,a.ruins)).toBe(true);
  expect(inRuinFootprint(a,runeAltarStaging(a))).toBe(false);
  if(a.name!=='air')expect(runeAltarStaging(a)).toEqual(a.outside);
 }
 const mind=RUNE_ALTARS.find(a=>a.name==='mind')!;
 expect(mind.ruins).toEqual({x:2982,z:3514,level:0});
 expect(ruinTarget(mind).at).toEqual({x:2981,z:3513,level:0});
 expect(runeAltarStaging(mind)).toEqual({x:2980,z:3511,level:0});
 expect(runeAltarStaging(RUNE_ALTARS[0]!)).toEqual(RUINS);
});

test('target is a bounded Runecraft level',()=>{
 expect(runeBankTarget()).toBe(99);expect(runeBankTarget(20)).toBe(20);
 for(const v of [1,100,NaN,2.5])expect(()=>runeBankTarget(v)).toThrow('Runecraft target');
});
test('essence spent equals the essence debit; banked runes equal the crafted output',()=>{
 expect(runeBankBalanced(ledger())).toBe(true);
 // Level 11+ makes two runes per essence.
 expect(runeBankBalanced(ledger({air:90,crafted:60}))).toBe(true);
 expect(runeBankBalanced(ledger({essence:1}))).toBe(false);
 expect(runeBankBalanced(ledger({air:59}))).toBe(false);
 expect(runeBankBalanced(ledger({crafted:29,air:59}))).toBe(false);
});
test('the order ends at the target level or when the bank has no essence',()=>{
 expect(runeBankDone(20,20,500)).toBe(true);expect(runeBankDone(5,20,0)).toBe(true);expect(runeBankDone(5,20,1)).toBe(false);
});
test('pass needs observed progress, an empty pack, no stop and a finished order',()=>{
 expect(runeBankOk({...base,ledger:ledger()})).toBe(true);
 expect(runeBankOk({...base,ledger:undefined})).toBe(false);
 expect(runeBankOk({...base,ledger:ledger(),stopped:true})).toBe(false);
 expect(runeBankOk({...base,ledger:ledger(),held:{essence:0,air:3}})).toBe(false);
 expect(runeBankOk({...base,ledger:ledger(),bankEssence:5})).toBe(false);
 // No essence at entry is acquisition work, not a pass.
 expect(runeBankOk({...base,ledger:ledger({essence0:0,consumed:0,crafted:0,air:30})})).toBe(false);
 expect(runeBankOk({...base,level0:99,level:99,bankEssence:7,ledger:ledger({essence0:7,essence:7,consumed:0,crafted:0,air:30})})).toBe(true);
});
