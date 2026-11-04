import {test,expect} from 'bun:test';
import {runeStageRoster,runeCarrierShortfall,runeStageAuthenticate,runeStageRequirement,exitRuneStageBasement,runeStageBankApproach} from './rune-carrier-stage-contract';

test('tower and Lumbridge staging entries approach the bank west of the jail guards',()=>{
 for(const p of [{worldX:3109,worldZ:3167,level:0},{worldX:3223,worldZ:3218,level:0},{worldX:3248,worldZ:3193,level:0}])
  expect(runeStageBankApproach(p)).toEqual([{x:3097,z:3225},{x:3097,z:3247}]);
 for(const p of [{worldX:3094,worldZ:3491,level:0},{worldX:3050,worldZ:3442,level:0},{worldX:3113,worldZ:9555,level:0},{worldX:3109,worldZ:3167,level:1}])
  expect(runeStageBankApproach(p)).toEqual([]);
});
import {runeCohortAssetsPreserved} from '../packages/practice/src/rune-carrier-stage-proof';
import {parsePracticeSave} from './measure/fleet-player-save';
import {createSaveData} from '../vendor/rs-sdk/sdk/test/utils/save-generator';

test('cohort assets accept omitted empty fixture equipment but reject item or equipment changes',()=>{
 const before=parsePracticeSave(createSaveData({bank:[{id:1436,count:469},{id:995,count:4321},{id:590,count:1}]}));
 expect(before.inventories[94]).toBeUndefined();
 for(const moved of [0,162]){
  const after=structuredClone(before);after.inventories[93]=[];after.inventories[94]=[];after.inventories[95]![0]!.count-=moved;
  expect(runeCohortAssetsPreserved(before,after,-moved)).toBe(true);
  const lost=structuredClone(after);lost.inventories[95]![1]!.count--;
  expect(runeCohortAssetsPreserved(before,lost,-moved)).toBe(false);
  const extra=structuredClone(after);extra.inventories[94]=[{slot:2,id:552,count:1}];
  expect(runeCohortAssetsPreserved(before,extra,-moved)).toBe(false);
 }
 const worn=parsePracticeSave(createSaveData({equipment:[{slot:2,id:552,count:1}]}));
 expect(runeCohortAssetsPreserved(worn,structuredClone(worn),0)).toBe(true);
 const banked=structuredClone(worn);banked.inventories[94]=[];banked.inventories[95]=[{slot:0,id:552,count:1}];
 expect(runeCohortAssetsPreserved(worn,banked,0)).toBe(false);
 const shifted=structuredClone(worn);shifted.inventories[94]![0]!.slot=3;
 expect(runeCohortAssetsPreserved(worn,shifted,0)).toBe(false);
});
test('observed skull-room entry exits upward before surface staging with only the finite reserve',async()=>{
 const shortfall=runeCarrierShortfall([{id:1436,count:243},{id:1446,count:1}]);
 const required=runeStageRequirement('existing-cohort',[shortfall]);
 expect(shortfall).toEqual({essence:162,talismans:0});
 expect(required).toEqual({essence:162,talismans:0,airTalismans:0});
 expect(469-required.essence).toBe(307);
 expect(runeStageRequirement(undefined,[shortfall])).toEqual({essence:594,talismans:2,airTalismans:1});
 expect(()=>runeStageRequirement('existing',[])).toThrow('RUNE_STAGE_PURPOSE');
 let p={worldX:3113,worldZ:9555,level:0};const calls:string[]=[];
 const io={position:()=>p,openDoor:async(_label:string,x:number,z:number)=>{calls.push(`door ${x},${z}`);},
  dash:async(_label:string,x:number,z:number,_tol:number)=>{calls.push(`walk ${x},${z}`);p={worldX:x,worldZ:z,level:0};},
  climb:async()=>{calls.push('climb 2148');p={worldX:3105,worldZ:3162,level:0};},waitForLanding:async()=>true};
 await exitRuneStageBasement(io);
 expect(calls).toEqual(['door 3111,9559','walk 3110,9559','walk 3109,9570','door 3108,9570','walk 3104,9576','climb 2148','door 3107,3162','walk 3108,3164','door 3109,3166','walk 3109,3167']);
 p={worldX:3113,worldZ:9555,level:0};calls.length=0;
 await expect(exitRuneStageBasement({...io,climb:async()=>{}})).rejects.toThrow('landing unobserved');
 expect(calls.some(c=>c.includes('316'))).toBe(false);
 p={worldX:3113,worldZ:9555,level:1};calls.length=0;
 await expect(exitRuneStageBasement(io)).rejects.toThrow('entry unsupported');expect(calls).toEqual([]);
});
test('a staging job owns its supplier and one to four carriers',()=>{
 expect(runeStageRoster(['Supplier','Carrier','--rune-carriers'])).toEqual({mode:'carriers',names:['Supplier','Carrier']});
 expect(runeStageRoster(['Supplier','A','B','C','D','--rune-carriers']).names).toHaveLength(5);
 for(const args of [['Supplier','--rune-carriers'],['S','A','B','C','D','E','--rune-carriers'],['S','s','--rune-carriers'],['S','Haggis','--rune-carriers']])expect(()=>runeStageRoster(args)).toThrow();
});
test('first login establishes authenticated ownership before staging can trade',async()=>{
 const owned=new Set<string>(),order:string[]=[];
 const result=await runeStageAuthenticate('Fresh',async()=>{order.push('login');owned.add('fresh');return {name:'Fresh'};},()=>{order.push('owned');return owned;});
 expect(result.name).toBe('Fresh');expect(order).toEqual(['login','owned']);
});
test('failed authentication and an unproved session cannot stage',async()=>{
 let checks=0;
 await expect(runeStageAuthenticate('Fresh',async()=>{throw Error('login refused');},()=>{checks++;return new Set(['fresh']);})).rejects.toThrow('login refused');expect(checks).toBe(0);
 await expect(runeStageAuthenticate('Fresh',async()=>({name:'Fresh'}),()=>new Set())).rejects.toThrow('authenticated owned');
 await expect(runeStageAuthenticate('Fresh',async()=>({name:'Other'}),()=>new Set(['fresh']))).rejects.toThrow('authenticated owned');
});
test('opening preparation owns only the supplier',()=>{
 expect(runeStageRoster(['Supplier','--rune-opening'])).toEqual({mode:'opening',names:['Supplier']});
 expect(()=>runeStageRoster(['Supplier','Other','--rune-opening'])).toThrow();
});
test('banked stock reduces the exact kit shortfall and retained surplus is not spent',()=>{
 expect(runeCarrierShortfall([])).toEqual({essence:405,talismans:1});
 expect(runeCarrierShortfall([{id:1436,count:100},{id:1446,count:1}])).toEqual({essence:305,talismans:0});
 expect(runeCarrierShortfall([{id:1436,count:900},{id:1446,count:2}])).toEqual({essence:0,talismans:0});
 expect(()=>runeCarrierShortfall([{id:1436,count:NaN}])).toThrow();
});
