import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHandoff} from './courier-handoff';
import {exactOrder} from './payout-order';
import {parseHandoff,runExactHandoff} from './handoff-inputs';
const {receiveHandoff,sendHandoff}=createHandoff([40],join(tmpdir(),'iron-races'));

// Session-level regression cases. Native practice execution remains harness-owned.
for(const mode of ['fresh-multi','crash-prepared','withdrawal-crash','collection-timeout','banked-timeout','no-transfer','partial-transfer'])test('exact entry recovery '+mode,async()=>{
 const root=mkdtempSync(join(tmpdir(),'exact-session-'));
 const names=new Map([[40,'Iron arrowtips'],[41,'Steel arrowtips']]);
 const want=[{name:'Iron arrowtips',count:90},{name:'Steel arrowtips',count:15}];
 const expected=[{id:40,count:90},{id:41,count:15}];
 const baseline={donor:{bank:expected,pack:[]},receiver:{bank:[],pack:[]}};
 let trades=0,tick=0;
 const donorBank=new Map([[40,90],[41,15]]),donorPack=new Map<number,number>(),receiverBank=new Map<number,number>(),receiverPack=new Map<number,number>();
 const sessions:any[]=[];
 const make=(name:string,bank:Map<number,number>,pack:Map<number,number>)=>{
  let opened=false,generation=0;const listeners=new Set<()=>void>();
  const inventory=()=>[...pack].filter(([,count])=>count>0).map(([id,count],slot)=>({id,name:names.get(id)!,count,slot}));
  const s:any={name,tick:()=>tick,onTick:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},
   bankObservation:()=>opened?{generation,at:Date.now(),items:[...bank].map(([id,count])=>({id,count,name:names.get(id)!}))}:null,
   sdk:{getInventory:inventory,getState:()=>({player:{worldX:3253,worldZ:3421,level:0},bank:{isOpen:opened},inventory:inventory()})},
   bot:{walkTo:async()=>({success:true}),openBank:async()=>{opened=true;generation++;return {success:true};},closeBank:async()=>{opened=false;return {success:true};},
    withdrawItem:async(regex:RegExp,amount:number)=>{const id=[...names].find(([,name])=>regex.test(name))![0];bank.set(id,(bank.get(id)??0)-amount);pack.set(id,(pack.get(id)??0)+amount);generation++;return {success:true};},
    depositItem:async(item:{id:number})=>{bank.set(item.id,(bank.get(item.id)??0)+(pack.get(item.id)??0));pack.delete(item.id);generation++;return {success:true};},
    serveTrades:async()=>{trades++;if(mode!=='no-transfer')for(const i of expected){const count=mode==='partial-transfer'?i.count-1:i.count;donorPack.set(i.id,(donorPack.get(i.id)??0)-count);receiverPack.set(i.id,count);}throw Error('lost donor reply');},
    trade:async()=>{throw Error('collection timeout after items moved');}}
  };sessions.push({listeners});return s;
 };
 const timer=setInterval(()=>{tick++;for(const s of sessions)for(const fn of [...s.listeners] as (()=>void)[])fn();},1);
 try{
  const order=exactOrder('multi','Donor','Receiver','practice',want,root);
  if(mode!=='fresh-multi')order.prepare(expected,baseline);
  if(['withdrawal-crash','collection-timeout','banked-timeout'].includes(mode)){
   donorBank.clear();for(const i of expected)(mode==='withdrawal-crash'?donorPack:mode==='collection-timeout'?receiverPack:receiverBank).set(i.id,i.count);
  }
  const donor=make('Donor',donorBank,donorPack),receiver=make('Receiver',receiverBank,receiverPack);
  const c=parseHandoff(['Donor','Receiver',...want.map(i=>i.count+':'+i.name),'--bank-x=3253','--bank-z=3421']);
  if(['no-transfer','partial-transfer'].includes(mode)){
   await expect(runExactHandoff(c,donor,receiver,order,()=>{})).rejects.toThrow(mode==='no-transfer'?'no item moved':'uncertain');
   expect(order.read().state).toBe('prepared');expect(trades).toBe(1);return;
  }
  expect((await runExactHandoff(c,donor,receiver,order,()=>{})).ok).toBe(true);
  expect(trades).toBe(['collection-timeout','banked-timeout'].includes(mode)?0:1);
  expect([...receiverBank]).toEqual([[40,90],[41,15]]);expect([...receiverPack]).toEqual([]);
  expect(order.read().state).toBe('settled');
  expect(()=>exactOrder('multi','Donor','Receiver','practice',want,root)).toThrow('already settled');
 }finally{clearInterval(timer);rmSync(root,{recursive:true,force:true});}
},2000);

for(const mode of ['delayed-inventory','publication-race','no-transfer','wrong-amount','expired','foreign'])test(mode,async()=>{
 const root=mkdtempSync(join(tmpdir(),'handoff-race-')),file=join(root,'courier-farmer.json');
 let held=0,tick=0;const callbacks=new Set<()=>void>();
 const request={token:'new',from:'Courier',to:'Farmer',server:mode==='foreign'?'other':'practice',state:'prepared',at:Date.now()-(mode==='expired'?130000:10),expected:[{id:40,count:81}]};
 const s:any={name:'Farmer',tick:()=>tick,sdk:{getState:()=>({}),getInventory:()=>held?[{id:40,count:held}]:[]},onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);}};
 if(mode!=='publication-race')writeFileSync(file,JSON.stringify(request));
 const timer=setInterval(()=>{tick++;if(tick===2&&mode==='delayed-inventory')held=81;for(const cb of [...callbacks])cb();},2);
 try{
  await receiveHandoff(s,'Courier','practice',async()=>{
   if(mode==='publication-race')writeFileSync(file,JSON.stringify(request));
   if(mode!=='delayed-inventory'&&mode!=='no-transfer')held=mode==='wrong-amount'?80:81;
   return {success:true};
  },root);
  const expected=mode==='delayed-inventory'||mode==='publication-race';
  expect(existsSync(file+'.credit')).toBe(expected);
  if(expected){const credit=JSON.parse(readFileSync(file+'.credit','utf8'));expect(credit.token).toBe('new');expect(credit.after).toEqual([{id:40,count:81}]);}
 }finally{clearInterval(timer);rmSync(root,{recursive:true,force:true});}
},2000);

test('sender inventory can settle after the trade reply',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sender-race-'));let held=100,tick=0;
 const callbacks=new Set<()=>void>();
 const s:any={name:'Courier',tick:()=>tick,sdk:{getState:()=>({}),getInventory:()=>[{id:40,count:held}]},onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);}};
 const timer=setInterval(()=>{tick++;if(tick===2)held=19;for(const cb of [...callbacks])cb();},2);
 try{
  const amount=await sendHandoff(s,'Farmer','practice',[{id:40,count:81}],async()=>{
   const p=join(root,'courier-farmer.json'),r=JSON.parse(readFileSync(p,'utf8'));
   writeFileSync(p+'.credit',JSON.stringify({token:r.token,from:r.from,to:r.to,server:r.server,at:Date.now(),before:[],after:[{id:40,count:81}]}));
  },root);
  expect(amount).toBe(81);
  expect(JSON.parse(readFileSync(join(root,'courier-farmer.json'),'utf8')).after).toEqual([{id:40,count:19}]);
 }finally{clearInterval(timer);rmSync(root,{recursive:true,force:true});}
},2000);
