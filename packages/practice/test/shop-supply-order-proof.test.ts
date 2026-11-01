import{test,expect,spyOn}from'bun:test';
import * as coreBot from '../../core/src/bot';
import * as walking from '../../core/src/walk';
import {runEarthProduction} from '../../../scripts/earth-production';
import {setEquipmentObserved} from '../../core/src/container-observation';
import {createSaveData} from '../../../vendor/rs-sdk/sdk/test/utils/save-generator';
import {parsePracticeSave} from '../../../scripts/measure/fleet-player-save';
import{bettySupplyChecks,shopSupplyChecks,shopRepeatChecks,shopRefusalChecks}from'../src/shop-supply-order-proof';
const save=(earth=3,coins=352288)=>({position:{x:3252,z:3420,level:0},skills:{3:{level:35,xp:10000}},inventories:{93:[],94:[],95:[{id:557,count:earth},{id:554,count:1482},{id:995,count:coins},{id:1277,count:1}]}} as any);
const run=(bought=1136,spent=6816,target=1)=>({code:0,timedOut:false,hpMin:35,log:`LOGOUT logged-out\nRESULT ok ticks=500 boughtTotal=${bought} spentTotal=${spent} stop=stock-target targetMet=${target}\n`});

test('persisted hunt kit survives equip closing the bank; missing1171 still refuses',async()=>{
 const world=spyOn(coreBot,'getWorld').mockResolvedValue({} as any);
 const account=spyOn(coreBot,'accountOf').mockReturnValue({skills:{}} as any);
 const travel=spyOn(walking,'goTo').mockResolvedValue({ok:true} as any);
 try{for(const missing of [false,true]){
  const persisted=parsePracticeSave(createSaveData({position:{x:3185,z:3436},skills:{Attack:49,Strength:10,Defence:11,Hitpoints:35},
   bank:[{id:995,count:352288},{id:554,count:1482},{id:557,count:3},{id:1277,count:1},...missing?[]:[{id:1171,count:1}],{id:1115,count:1},{id:1891,count:8}]}));
  const stock=persisted.inventories[95]!.map(i=>({...i})),pack:any[]=[],equipment:any[]=[],client={};
  if(missing)equipment.push(stock.splice(stock.findIndex(i=>i.id===1277),1)[0]);
  setEquipmentObserved(client,true);
  let generation=0,stopped=false,styleSet=false;
  const state={player:{worldX:3185,worldZ:3436,level:0},bank:{isOpen:false,items:[] as any[]},combatStyle:{currentStyle:0},autoRetaliateEnabled:false};
  const visible=()=>{state.bank.items=state.bank.isOpen?stock:[];};
  const s={client,name:'flkitentry',tick:()=>0,ended:new Promise(()=>{}),onTick:()=>()=>{},
   bankObservation:()=>state.bank.isOpen?{generation,items:stock}:null,
   sdk:{getState:()=>state,getInventory:()=>pack,getEquipment:()=>equipment,getSkill:()=>({level:35,baseLevel:49}),
    sendSetCombatStyle:async(n:number)=>{styleSet=true;state.combatStyle.currentStyle=n;stopped=true;return{success:true};}},
   bot:{dismissBlockingUI:async()=>{},openBank:async()=>{state.bank.isOpen=true;generation++;visible();return{success:true};},
    withdrawItem:async(item:any,n:number)=>{expect(state.bank.isOpen).toBe(true);item.count-=n;generation++;pack.push({id:item.id,count:n});return{success:true};},
    equipItem:async(item:any)=>{state.bank.isOpen=false;visible();equipment.push(item);pack.splice(pack.indexOf(item),1);return{success:true};},
    closeBank:async()=>{state.bank.isOpen=false;visible();}},
  } as any;
  const result=await runEarthProduction(s,{mode:'talismans',cap:20000,target:103,reserve:30000,killsPerTarget:1,stop:()=>stopped});
  if(missing){
   expect(result.failure).toBe('Error: earth production missing owned 1171');
   expect(result.ok).toBe(false);
   expect(styleSet).toBe(false);
  }else{
   expect(result.failure).not.toContain('missing owned');
   expect(equipment.map(i=>i.id)).toEqual([1277,1171,1115]);
   expect(styleSet).toBe(true);
   expect(pack).toContainEqual({id:1891,count:8});
  }
 }}finally{travel.mockRestore();account.mockRestore();world.mockRestore();}
});
test('saved shop supply binds exact new stock, money, retained fire, assets and logout',()=>{
 const before=save(),after=save(1139,345472);
 expect(Object.values(shopSupplyChecks(before,after,run())).every(Boolean)).toBe(true);
 expect(Object.values(shopSupplyChecks(before,after,{...run(),log:'MILESTONE bank boughtTotal=0\n'+run().log})).every(Boolean)).toBe(true);
 for(const mutate of [(s:any)=>s.inventories[95][0].count--,(s:any)=>s.inventories[95][1].count--,(s:any)=>s.inventories[95][2].count--,(s:any)=>s.inventories[95][3].count--]){
  const bad=structuredClone(after);mutate(bad);expect(Object.values(shopSupplyChecks(before,bad,run())).every(Boolean)).toBe(false);
 }
 expect(shopSupplyChecks(before,after,{...run(),log:run().log.replace('LOGOUT logged-out','LOGOUT timeout')}).logout).toBe(false);
 expect(shopSupplyChecks(before,after,{...run(),hpMin:0}).health).toBe(false);
});
test('target repeat cannot buy again or debit coins; refusal retains every asset',()=>{
 const after=save(1139,345472);
 expect(Object.values(shopRepeatChecks(after,after,run(0,0))).every(Boolean)).toBe(true);
 expect(Object.values(shopRepeatChecks(after,save(1140,345470),run(1,2))).every(Boolean)).toBe(false);
 const poor=save(3,30000),refused={...run(0,0,0),log:run(0,0,0).log.replace('stock-target','stock-wait')};
 expect(Object.values(shopRefusalChecks(poor,poor,refused)).every(Boolean)).toBe(true);
 expect(Object.values(shopRefusalChecks(poor,save(3,29999),refused)).every(Boolean)).toBe(false);
});
test('alternate Betty profile proves its route, useful stock and the same conserved budget',()=>{
 const before=save(),after=save(53,351888);after.position={x:3092,z:3243,level:0};
 expect(Object.values(bettySupplyChecks(before,after,run(50,400))).every(Boolean)).toBe(true);
 after.inventories[95][0].count--;expect(Object.values(bettySupplyChecks(before,after,run(50,400))).every(Boolean)).toBe(false);
});
