import {describe,it,expect} from 'bun:test';
import {herbloreHeadroom,herbloreSavedChecks} from '../src/herblore-order-proof';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
describe('herblore proof',()=>{
 it('defers before practice startup when reserve is short',()=>{
  expect(herbloreHeadroom(FREE_FLOOR_GB)).toMatchObject({status:'hostDeferred',requiredGiB:PRACTICE_STARTUP_GB});
  expect(herbloreHeadroom(PRACTICE_STARTUP_GB)).toBeNull();
 });
 const save=(items:{id:number;count:number}[],level=46,xp=1000)=>({position:{x:3092,z:3243,level:0},version:10,vars:{},skills:Array.from({length:21},(_,index)=>({index,level:index===15?level:50,xp:index===15?xp:1000,rawExperience:index===15?xp*10:10000})),inventories:{93:[],94:[],95:items.map((i,slot)=>({...i,slot}))}});
 it('accepts exact saved XP, purchases, banked output and logout',()=>{
  const before=save([{id:199,count:60},{id:995,count:2000},{id:952,count:1}]);
  const after=save([{id:199,count:54},{id:121,count:6},{id:227,count:6},{id:221,count:6},{id:995,count:1868},{id:952,count:1}],50,5000);
  const buys=[...Array.from({length:12},()=>({id:227,count:1,cost:3})),...Array.from({length:12},()=>({id:221,count:1,cost:3}))];
  const travel='\nHERBLORE_TRAVEL {"coins":-30}\nHERBLORE_TRAVEL {"coins":-30}\n';
  const log=buys.map(x=>'HERBLORE_BUY '+JSON.stringify(x)).join('\n')+travel+'HERBLORE_RESULT '+JSON.stringify({ok:true,assets:true,target:50,brewed:6})+'\nRESULT ok\nLOGOUT logged-out\n';
  expect(Object.values(herbloreSavedChecks('vial-shortfall',before,after,log,0)).every(Boolean)).toBe(true);
  expect(herbloreSavedChecks('vial-shortfall',before,after,log.replace('LOGOUT logged-out',''),0).logout).toBe(false);
  const lost=structuredClone(after);lost.inventories[95]=lost.inventories[95].filter(x=>x.id!==952);
  expect(herbloreSavedChecks('vial-shortfall',before,lost,log,0).assets).toBe(false);
  expect(herbloreSavedChecks('vial-shortfall',before,before,log,0).xp).toBe(false);
  expect(herbloreSavedChecks('vial-shortfall',before,after,log.replace(travel,'\n'),0).assets).toBe(false);
  expect(herbloreSavedChecks('vial-shortfall',before,after,log.replace('"coins":-30','"coins":30'),0).assets).toBe(false);
 });
 it('counts the unfinished potions that the target level leaves banked, up to one trip',()=>{
  // The run of a hosted runner: 27 vials and 27 eyes bought, 18 herbs used, 12 potions and 6 unfinished potions banked.
  const before=save([{id:199,count:60},{id:995,count:2000},{id:952,count:1}]);
  const buys=[...Array.from({length:27},()=>({id:227,count:1,cost:3})),...Array.from({length:27},()=>({id:221,count:1,cost:3}))];
  const travel='\nHERBLORE_TRAVEL {"coins":-30}\nHERBLORE_TRAVEL {"coins":-30}\n';
  const log=buys.map(x=>'HERBLORE_BUY '+JSON.stringify(x)).join('\n')+travel+'HERBLORE_RESULT '+JSON.stringify({ok:true,assets:true,target:50,brewed:12})+'\nRESULT ok\nLOGOUT logged-out\n';
  const items=(unf:number)=>[{id:199,count:60-12-unf},{id:121,count:12},{id:91,count:unf},{id:227,count:27-12-unf},{id:221,count:15},{id:995,count:2000-162-60},{id:952,count:1}].filter(i=>i.count>0);
  expect(Object.values(herbloreSavedChecks('vial-shortfall',before,save(items(6),50,5000),log,0)).every(Boolean)).toBe(true);
  // A herb that went missing is not an unfinished potion.
  const lost=save(items(6),50,5000);lost.inventories[95]=lost.inventories[95].filter(x=>x.id!==91);
  expect(herbloreSavedChecks('vial-shortfall',before,lost,log,0).assets).toBe(false);
  // More than one trip of unfinished potions is not what the worker leaves.
  expect(herbloreSavedChecks('vial-shortfall',before,save(items(10),50,5000),log,0).assets).toBe(false);
 });
 it('requires refusal logout and unchanged assets',()=>{
  const s=save([{id:995,count:2000}]);const log='RESULT fail herblore Error: herbs missing\nLOGOUT logged-out\n';
  expect(Object.values(herbloreSavedChecks('missing-herbs',s,s,log,1)).every(Boolean)).toBe(true);
  expect(herbloreSavedChecks('missing-herbs',s,s,log,0).child).toBe(false);
 });
});
