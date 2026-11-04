import {test,expect} from 'bun:test';
import {existsSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {supplyPlan,runWoodSupply} from './woodcut-supply';
test('retained log supply admits only a finite accounting-compatible headless batch',()=>{
 expect(supplyPlan(25,165,3000)).toEqual({logs:25,headless:165,shafts:375});
 for(const args of [[0,0,3000],[26,0,3000],[25,180,3000],[25,164,3000],[25,165,0],[NaN,0,3000]])expect(()=>supplyPlan(...args as [number,number,number])).toThrow();
});

test('a stop at the current bank permits no bank or inventory action',async()=>{
 const file='.practice/stop-Supplystop';mkdirSync('.practice',{recursive:true});writeFileSync(file,'unit-owned stop',{flag:'wx'});
 let calls=0,released=false;
 const session:any={name:'Supplystop',tick:()=>0,onTick:()=>()=>{released=true;},sdk:{getSkill:()=>({level:54}),getInventory:()=>[],getState:()=>({player:{worldX:3092,worldZ:3243,level:0,isDead:false}})},bot:{openBank:async()=>{calls++;throw Error('unexpected bank action');}}};
 try{const r=await runWoodSupply(session,1,0,3000);expect(r.ok).toBe(false);expect(r).toHaveProperty('error','Error: supply stopped, capped or damaged');expect(calls).toBe(0);expect(released).toBe(true);}
 finally{unlinkSync(file);}
});
test('a stop that lands while the bank opens permits no deposit',async()=>{
 const file='.practice/stop-Supplybank';mkdirSync('.practice',{recursive:true});if(existsSync(file))unlinkSync(file);
 let deposits=0;
 const inventory=[{id:1351,name:'Bronze axe',count:1,slot:0},{id:946,name:'Knife',count:1,slot:1}];
 const session:any={name:'Supplybank',tick:()=>0,onTick:()=>()=>{},sdk:{getSkill:()=>({level:54}),getInventory:()=>inventory,getState:()=>({player:{worldX:3092,worldZ:3243,level:0,isDead:false},bank:{isOpen:true,items:[]}})},
  bot:{openBank:async()=>{writeFileSync(file,'unit-owned stop',{flag:'wx'});return {success:true};},depositItem:async()=>{deposits++;return {success:true};},closeBank:async()=>({success:true})}};
 try{const r=await runWoodSupply(session,1,0,3000);expect(r.ok).toBe(false);expect(r).toHaveProperty('error','Error: supply stopped, capped or damaged');expect(deposits).toBe(0);}
 finally{if(existsSync(file))unlinkSync(file);}
});
