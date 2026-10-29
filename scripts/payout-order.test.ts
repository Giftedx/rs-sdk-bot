import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {payoutOrder, exactOrder} from './payout-order';
import {reconcileOrder} from './courier-handoff';

test('claim persists entry before a baseline and compares the originally read owner',()=>{
 const base=mkdtempSync(join(tmpdir(),'claim-cas-'));
 const goal=process.env.BOT_GOAL;process.env.BOT_GOAL='claim-cas-test';
 try{
  const args:Parameters<typeof exactOrder>=['cas','Donor','Receiver','practice',[{name:'Iron arrowtips',count:90}],base];
  const first=exactOrder(...args),racer=exactOrder(...args);
  first.claim();
  expect(first.read()).toMatchObject({state:'entering',owner:{pid:process.pid},recoveryOwner:null});
  expect(()=>racer.claim()).toThrow('owner changed');
  const resumed=exactOrder(...args);
  resumed.claim();
  expect(resumed.read().recoveryOwner.pid).toBe(process.pid);
  resumed.prepare([{id:40,count:90}],{donor:{bank:[{id:40,count:90}],pack:[]},receiver:{bank:[],pack:[]}});
  expect(resumed.read().state).toBe('prepared');
 }finally{if(goal===undefined)delete process.env.BOT_GOAL;else process.env.BOT_GOAL=goal;rmSync(base,{recursive:true,force:true});}
});

test('named order requires a key before any login and binds the entire multi-tier request',()=>{
 expect(()=>exactOrder('', 'Donor','Receiver','practice',[{name:'Iron arrowtips',count:90}])).toThrow('HANDOFF_ORDER');
 const base=mkdtempSync(join(tmpdir(),'exact-order-'));
 try {
  const want=[{name:'Iron arrowtips',count:90},{name:'Steel arrowtips',count:15}];
  const order=exactOrder('multi','Donor','Receiver','practice',want,base);
  const baseline={donor:{bank:[{id:40,count:90},{id:41,count:15}],pack:[]},receiver:{bank:[],pack:[]}};
  order.prepare([{id:40,count:90},{id:41,count:15}],baseline);
  expect(reconcileOrder(order.read(),baseline)).toBe('resume'); // crash after prepared
  const moved={donor:{bank:[],pack:[]},receiver:{bank:[],pack:[{id:40,count:90},{id:41,count:15}]}};
  expect(reconcileOrder(order.read(),moved)).toBe('bank'); // collection timed out after transfer
  const banked={...moved,receiver:{bank:moved.receiver.pack,pack:[]}};
  expect(reconcileOrder(order.read(),banked)).toBe('settle');
  order.settle(banked);
  expect(()=>exactOrder('multi','Donor','Receiver','practice',want,base)).toThrow('already settled');
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('uncertain or changed request refuses with the actual counts; never authorizes a resend',()=>{
 const base=mkdtempSync(join(tmpdir(),'exact-order-'));
 try{
  const order=exactOrder('one','Donor','Receiver','practice',[{name:'Iron arrowtips',count:90}],base);
  const baseline={donor:{bank:[{id:40,count:90}],pack:[]},receiver:{bank:[],pack:[]}};
  order.prepare([{id:40,count:90}],baseline);
  expect(()=>reconcileOrder(order.read(),{...baseline,donor:{bank:[{id:40,count:1}],pack:[]}})).toThrow('"donorDebit":89');
  expect(()=>exactOrder('one','Donor','Receiver','practice',[{name:'Iron arrowtips',count:91}],base)).toThrow('identity/items');
  expect(()=>reconcileOrder({state:'prepared'},baseline)).toThrow('baseline');
 }finally{rmSync(base,{recursive:true,force:true});}
});
test('exact payout config, IDs and quantities fail closed',()=>{
 expect(payoutOrder({})).toBeUndefined();
 for(const env of [{HANDOFF_ORDER:'../bad',HANDOFF_ITEM_ID:'40'},{HANDOFF_ORDER:'a'},{HANDOFF_ITEM_ID:'40'},{HANDOFF_ORDER:'a',HANDOFF_ITEM_ID:'0'}])expect(()=>payoutOrder(env)).toThrow();
 const order=payoutOrder({HANDOFF_ORDER:'a',HANDOFF_ITEM_ID:'40'})!;
 expect(order.expected([{name:'Iron arrowtips',count:90}],[{id:40,name:'Iron arrowtips',count:90}])).toEqual([{id:40,count:90}]);
 for(const inv of [[],[{id:39,name:'Iron arrowtips',count:90}],[{id:40,name:'Iron arrowtips',count:89}]])expect(()=>order.expected([{name:'Iron arrowtips',count:90}],inv)).toThrow();
});
for(const state of ['prepared','settled'])test('exact order restart refuses '+state,()=>{
 const base=mkdtempSync(join(tmpdir(),'payout-order-'));try {
 const order=payoutOrder({HANDOFF_ORDER:'one',HANDOFF_ITEM_ID:'40'},base)!;
 order.preflight('Donor','Receiver');mkdirSync(order.root,{recursive:true});
 writeFileSync(join(order.root,'donor-receiver.json'),JSON.stringify({state}));
 expect(()=>order.preflight('Donor','Receiver')).toThrow(state==='settled'?'already settled':'unresolved');
 }finally{rmSync(base,{recursive:true,force:true});}
});
