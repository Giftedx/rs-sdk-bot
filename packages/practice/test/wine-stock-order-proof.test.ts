import {test,expect} from 'bun:test';
import {wineStockSaveChecks,type WineStockSaves} from '../src/wine-stock-order-proof';
import type {readPracticeSave} from '../../../scripts/measure/fleet-player-save';

type Save=ReturnType<typeof readPracticeSave>;
const save=(cooking:number,xp:number,bank:Record<number,number>,pack:Record<number,number>={}):Save=>({version:9,position:{x:3092,z:3243,level:0},vars:{281:1000},
 skills:Array.from({length:21},(_,index)=>({index,level:index===7?cooking:index===3?99:1,xp:index===7?xp:0,rawExperience:index===7?xp*10:0})),
 inventories:{93:Object.entries(pack).map(([id,count],slot)=>({slot,id:+id,count})),94:[{slot:3,id:1277,count:1}],95:Object.entries(bank).map(([id,count],slot)=>({slot,id:+id,count}))}});
function valid():WineStockSaves{
 const makerBefore=save(82,306987,{1987:14,1937:14,2347:1},{995:777}),makerProduced=save(82,306987,{1987:2,1937:2,2347:1},{995:777,1996:12});
 return{makerBefore,makerProduced,makerHeld:structuredClone(makerProduced),makerAfter:save(82,306987,{1987:2,1937:2,2347:1},{995:777}),
  consumerBefore:save(69,124256,{995:1234},{946:1}),consumerReady:save(69,124256,{995:1234,1995:12},{946:1}),consumerAfter:save(72,157256,{995:1234,1993:12},{946:1})};
}
test('saved produced notes survive the hold, move to the owned consumer and fund69 to72 exactly',()=>{
 expect(Object.values(wineStockSaveChecks(valid())).every(Boolean)).toBe(true);
});
test('seeded wine, fermented producer output and one missing input debit cannot qualify',()=>{
 const seeded=valid();seeded.makerBefore.inventories[95]!.push({slot:8,id:1995,count:1});expect(wineStockSaveChecks(seeded).unseeded).toBe(false);
 const fermented=valid();fermented.makerProduced.inventories[93]!.find(i=>i.id===1996)!.id=1993;expect(wineStockSaveChecks(fermented).production).toBe(false);
 const short=valid();short.makerProduced.inventories[95]!.find(i=>i.id===1987)!.count=3;expect(wineStockSaveChecks(short).production).toBe(false);
});
test('a substituted handoff, lost reserve or untouched consumer fails independent saved accounting',()=>{
 const missing=valid();missing.consumerReady.inventories[95]!.find(i=>i.id===1995)!.count=11;expect(wineStockSaveChecks(missing).handoff).toBe(false);
 const reserve=valid();reserve.makerAfter.inventories[95]!.find(i=>i.id===1937)!.count=1;expect(wineStockSaveChecks(reserve).assets).toBe(false);
 const idle=valid();idle.consumerAfter=structuredClone(idle.consumerReady);expect(wineStockSaveChecks(idle).consumer).toBe(false);
});
test('notes which disappear during relog and damaged equipment/health reject the proof',()=>{
 const hold=valid();hold.makerHeld.inventories[93]!.find(i=>i.id===1996)!.count=11;expect(wineStockSaveChecks(hold).held).toBe(false);
 const gear=valid();gear.consumerAfter.inventories[94]=[];expect(wineStockSaveChecks(gear).equipment).toBe(false);
 const hurt=valid();hurt.makerAfter.skills[3]!.level=98;expect(wineStockSaveChecks(hurt).health).toBe(false);
});
