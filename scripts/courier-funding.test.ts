import {expect,test} from 'bun:test';
import {fundingRequestValid} from './courier-funding';
const now=100000,token='00000000-0000-4000-8000-000000000001';
const owned=new Set(['payer','courier']);
const status={name:'Courier',server:'rs-sdk-demo.fly.dev',at:now,result:'',pos:{x:2654,z:3283,level:0},inventory:[{id:995,count:976}]};
const request={token,funder:'Payer',items:[{name:'Coins',count:5000}]};
test('only the named owned funder pays a fresh needy owned courier at the bank',()=>{
 expect(fundingRequestValid('Payer','Courier',status,request,now,'rs-sdk-demo.fly.dev',owned,now)).toBe(true);
 for(const patch of [{result:'ok offline'},{at:now-30000},{server:'localhost:8888'},{name:'Foreign'},{pos:{x:2654,z:3302,level:0}},{inventory:[{id:995,count:1500}]}])
  expect(fundingRequestValid('Payer','Courier',{...status,...patch},request,now,'rs-sdk-demo.fly.dev',owned,now)).toBe(false);
 for(const patch of [{funder:'Other'},{token:''},{items:[{name:'Coins',count:5001}]},{items:[{name:'Trout',count:5000}]}])
  expect(fundingRequestValid('Payer','Courier',status,{...request,...patch},now,'rs-sdk-demo.fly.dev',owned,now)).toBe(false);
 expect(fundingRequestValid('Payer','Courier',status,request,now,'rs-sdk-demo.fly.dev',new Set(['payer']),now)).toBe(false);
 expect(fundingRequestValid('Payer','Courier',status,request,now-180001,'rs-sdk-demo.fly.dev',owned,now)).toBe(false);
});

import {mkdtempSync,writeFileSync,existsSync,readFileSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serviceCourierFunding,requestCourierFunding} from './courier-funding';
function payoutFixture(bank=100000,outcome:'paid'|'failed'|'partial'='paid'){
 const dir=mkdtempSync(join(tmpdir(),'courier-funding-')),reqFile=join(dir,'Courier.json');
 const req={...request,token:'00000000-0000-4000-8000-000000000001'};writeFileSync(reqFile,JSON.stringify(req));
 // Give the fixture a valid past timestamp. Filesystem mtimes have finer precision than Date.now().
 const at=new Date(Date.now()-1000);utimesSync(reqFile,at,at);
 let cash=200,tick=0,calls=0,withdraws=0,open=false;const listeners=new Set<()=>void>();
 const timer=setInterval(()=>{tick++;for(const cb of listeners)cb();},1);
 const inv=()=>cash?[{id:995,name:'Coins',count:cash,slot:0}]:[];
 const s:any={name:'Payer',tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
  sdk:{getInventory:inv,getState:()=>({bank:{items:open&&bank?[{id:995,name:'Coins',count:bank,slot:0}]:[]}})},
  bot:{openBank:async()=>{open=true;return{success:true};},closeBank:async()=>{open=false;return{success:true};},
   withdrawItem:async(_r:any,n:number)=>{withdraws++;const v=Math.min(n,bank);cash+=v;bank-=v;return{success:v===n};},
   depositItem:async(_r:any,n:number)=>{const v=Math.min(n,cash);cash-=v;bank+=v;return{success:v===n};},
   serveTrades:async()=>{calls++;const paid=outcome==='paid'?5000:outcome==='partial'?3000:0;cash-=paid;
    return{message:outcome,trades:outcome==='failed'?[]:[{success:true,gave:[{name:'Coins',count:5000}]}]};}}};
 const options={dir,owned,readStatus:()=>({...status,at:Date.now()})};
 return{s,options,dir,reqFile,req,cash:()=>cash,bank:()=>bank,calls:()=>calls,withdraws:()=>withdraws,close:()=>clearInterval(timer)};
}
test('one claimed token pays exactly5000 from bank and cannot pay again after a replay',async()=>{
 const f=payoutFixture();try{
  const r=await serviceCourierFunding(f.s,'Courier','rs-sdk-demo.fly.dev',f.options);
  expect(r?.state).toBe('paid');expect(f.bank()).toBe(95000);expect(f.cash()).toBe(200);expect(f.calls()).toBe(1);
  expect(existsSync(join(f.dir,'Courier.claimed.json'))).toBe(false);
  writeFileSync(f.reqFile,JSON.stringify(f.req));
  expect(await serviceCourierFunding(f.s,'Courier','rs-sdk-demo.fly.dev',f.options)).toBeNull();expect(f.calls()).toBe(1);
 }finally{f.close();}
});
test('the source reserve blocks withdrawal; a failed trade refunds only the prepared coins',async()=>{
 for(const [bank,outcome,state] of [[14999,'paid','declined'],[100000,'failed','failed']] as const){
  const f=payoutFixture(bank,outcome);try{
   const r=await serviceCourierFunding(f.s,'Courier','rs-sdk-demo.fly.dev',f.options);
   expect(r?.state).toBe(state);expect(f.bank()).toBe(bank);expect(f.cash()).toBe(200);
   expect(f.withdraws()).toBe(outcome==='paid'?0:1);
  }finally{f.close();}
 }
});
test('uncertain debit keeps its claim and refuses another trade across calls',async()=>{
 const f=payoutFixture(100000,'partial');try{
  const r=await serviceCourierFunding(f.s,'Courier','rs-sdk-demo.fly.dev',f.options);
  expect(r?.state).toBe('unknown');expect(existsSync(join(f.dir,'Courier.claimed.json'))).toBe(true);
  expect(JSON.parse(readFileSync(join(f.dir,`${f.req.token}.result.json`),'utf8')).state).toBe('unknown');
  await expect(serviceCourierFunding(f.s,'Courier','rs-sdk-demo.fly.dev',f.options)).rejects.toThrow('unresolved funding claim');
  expect(f.calls()).toBe(1);
 }finally{f.close();}
});


test('malformed funder status leaves the wallet untouched and publishes no request',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'funding-invalid-status-'));
 const s:any={name:'Courier',sdk:{getInventory:()=>[{id:995,count:976}],getState:()=>({player:{worldX:2654,worldZ:3283,level:0}})}};
 const r=await requestCourierFunding(s,'Payer','rs-sdk-demo.fly.dev',{dir,owned,readStatus:()=>({name:17})});
 expect(r.reason).toBe('funder unavailable');expect(r.received).toBe(0);expect(existsSync(join(dir,'Courier.json'))).toBe(false);
});


test('a cancelled request cannot trigger a bank withdrawal or trade',async()=>{
 const f=payoutFixture();try{
  const {rmSync}=await import('node:fs');rmSync(f.reqFile);
  expect(await serviceCourierFunding(f.s,'Courier','rs-sdk-demo.fly.dev',f.options)).toBeNull();
  expect(f.withdraws()).toBe(0);expect(f.calls()).toBe(0);expect(f.bank()).toBe(100000);expect(f.cash()).toBe(200);
 }finally{f.close();}
});
