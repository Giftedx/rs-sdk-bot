import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join,resolve} from 'node:path';
import {bankCargo,cargoAccountServer,courierWaiting,validCargoRequest} from '../src/cargo';
import type {Session} from '../src/inprocess';
import {simBotsDir} from '../src/practice-paths';

test('partner configuration lookup retains case-insensitive account names',()=>{
 const dir=mkdtempSync(join(resolve(import.meta.dir,'../../../vendor/rs-sdk/bots'),'cargoe'));
 try{
  writeFileSync(join(dir,'bot.env'),'SERVER=127.0.0.1:21000\nPASSWORD=fixture-never-authenticate\n');
  expect(cargoAccountServer(basename(dir).toLowerCase())).toBe('127.0.0.1:21000');
  expect(cargoAccountServer(basename(dir).toUpperCase())).toBe('127.0.0.1:21000');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('partner configuration lookup resolves simBotsDir credentials when vendor bots lacks the actor',()=>{
 const simRoot=simBotsDir();mkdirSync(simRoot,{recursive:true});
 const dir=mkdtempSync(join(simRoot,'csim'));
 try{
  writeFileSync(join(dir,'bot.env'),'SERVER=127.0.0.1:21005\nPASSWORD=fixture-never-authenticate\n');
  expect(cargoAccountServer(basename(dir).toLowerCase())).toBe('127.0.0.1:21005');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a server-scoped cargo request needs the same endpoint and current authenticated partner',()=>{
 const now=1000,server='127.0.0.1:21000',owned=new Set(['courier']);
 const request={worker:'Producer',courier:'Courier',server,at:now,ready:true};
 expect(validCargoRequest(request,'producer',owned,now,server)).toBe(true);
 expect(validCargoRequest({...request,server:'127.0.0.1:21010'},'producer',owned,now,server)).toBe(false);
 expect(validCargoRequest({...request,server:undefined},'producer',owned,now,server)).toBe(false);
 expect(validCargoRequest(request,'producer',new Set(),now,server)).toBe(false);
 expect(validCargoRequest({...request,at:now-180000},'producer',owned,now,server)).toBe(false);
 // An explicitly injected account set remains available to old fake-session consumers.
 expect(validCargoRequest({...request,server:undefined},'producer',owned,now)).toBe(true);
});

test('a current same-endpoint authenticated request transfers only its reserved surplus once',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cargo-scoped-')),server='127.0.0.1:21000',owned=new Set(['courier']);
 let bankOpen=true,stored=30,trades=0,tick=0;const inventory:{id:number;name:string;count:number}[]=[{id:995,name:'Coins',count:42}];
 const state=()=>({tick,trade:{isOpen:false},player:{worldX:2727,worldZ:3492,level:0},nearbyPlayers:[{name:'Courier',distance:1}],bank:{isOpen:bankOpen,items:[{id:1779,name:'Flax',count:stored}]}});
 const s={name:'Producer',lifecycle:{server},sdk:{getInventory:()=>inventory,getState:state,
  waitForCondition:async(test:(value:ReturnType<typeof state>)=>boolean)=>{tick+=2;if(!test(state()))throw Error('fixture closure unconfirmed');return state();},
 },bot:{
  withdrawItem:async(_item:RegExp,n:number)=>{stored-=n;const held=inventory.find(i=>i.id===1780);if(held)held.count+=n;else inventory.push({id:1780,name:'Flax',count:n});return{success:true};},
  closeBank:async()=>{bankOpen=false;},openBank:async()=>{bankOpen=true;return{success:true};},
  serveTrades:async()=>{trades++;const item=inventory.find(i=>i.id===1780)!;inventory.splice(inventory.indexOf(item),1);return{trades:[{success:true,gave:[item]}]};},
 }} as unknown as Session;
 try{
  writeFileSync(join(dir,'request-Producer.json'),JSON.stringify({worker:'Producer',courier:'Courier',server,at:Date.now(),ready:true}));
  await bankCargo(s,[/^Flax$/],2,{dir,owned});
  await bankCargo(s,[/^Flax$/],2,{dir,owned});
  expect(trades).toBe(1);expect(stored).toBe(2);expect(inventory).toEqual([{id:995,name:'Coins',count:42}]);
  expect(courierWaiting('Producer',{dir,owned,server})).toBe(false);
  expect(JSON.parse(readFileSync(join(dir,'Producer.json'),'utf8'))).toMatchObject({server,items:[]});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('waiting and bank handoff bind the actual session endpoint before any withdrawal',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cargo-endpoint-')),server='127.0.0.1:21000',owned=new Set(['courier']);
 const requestPath=join(dir,'request-Producer.json');let withdrawals=0;
 const s={name:'Producer',lifecycle:{server},sdk:{getState:()=>({player:{worldX:2727,worldZ:3492,level:0},
  bank:{isOpen:true,items:[{id:1779,name:'Flax',count:28}]},nearbyPlayers:[{name:'Courier',distance:1}]}),getInventory:()=>[]},
  bot:{withdrawItem:async()=>{withdrawals++;throw Error('unexpected withdrawal');}}} as unknown as Session;
 try{
  for(const value of ['127.0.0.1:21010',undefined]){
   writeFileSync(requestPath,JSON.stringify({worker:'Producer',courier:'Courier',server:value,at:Date.now(),ready:true}));
   expect(courierWaiting('Producer',{dir,owned,server})).toBe(false);
   await bankCargo(s,[/^Flax$/],0,{dir,owned});
   const manifest=JSON.parse(readFileSync(join(dir,'Producer.json'),'utf8'));
   expect(manifest.server).toBe(server);expect(manifest.items).toEqual([{id:1779,name:'Flax',count:28}]);
  }
  expect(withdrawals).toBe(0);
  await expect(bankCargo(s,[/^Flax$/],0,{dir,owned,server:'127.0.0.1:21010'})).rejects.toThrow('session endpoint mismatch');
  writeFileSync(requestPath,JSON.stringify({worker:'Producer',courier:'Courier',server,at:Date.now(),ready:true}));
  expect(courierWaiting('Producer',{dir,owned,server})).toBe(true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
