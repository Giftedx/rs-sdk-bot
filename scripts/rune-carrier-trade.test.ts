import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
function handoff(mode:'publication'|'reset-publication'|'wrong-item'|'refused'|'no-credit'){
 const code=`
 import{mock}from'bun:test';import{resolve}from'node:path';
 let phase=0,accepts=0,pending;
 const pack=n=>Array.from({length:n},()=>({id:1436,count:1,slot:0}));
 const make=(name,giver)=>{const a={name,tick:()=>phase};a.trade={isOpen:true,screen:'confirm',partner:giver?'Crafter':'Carrier',myAccepted:false,myOffer:giver?pack(27):[],theirOffer:giver?[]:pack(27)};
 a.sdk={getInventory:()=>giver?pack(phase===0?27:0):pack(phase>=2&&'${mode}'!=='no-credit'?27:0),getState:()=>({trade:a.trade,nearbyPlayers:[]}),scanGroundItems:async()=>{},sendAcceptTrade:async()=>{accepts++;if('${mode}'==='refused')return{success:false,message:'declined'};a.trade.myAccepted=true;return{success:true}}};return a;};
 const s=make('Crafter',false),h=make('Carrier',true);
 if('${mode}'==='wrong-item'){s.trade.theirOffer=[{id:995,count:27}];h.trade.myOffer=[{id:995,count:27}];}
 mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
  if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;if(phase===1){h.trade={isOpen:false};s.trade.myOffer=[];s.trade.theirOffer=[];if('${mode}'==='reset-publication')s.trade.myAccepted=false;}else{s.trade={isOpen:false};}pending=undefined;r();}));return pending;
 }}));
 const{transfer}=await import('./scripts/rune-carrier-trade');let error='';try{await transfer(s,h);}catch(e){error=String(e);}
 console.log(JSON.stringify({error,accepts,phase,received:s.sdk.getInventory().length}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe'});
 if(child.exitCode!==0)throw Error(child.stderr.toString());return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}
test('accepted confirmation may clear before recipient inventory is published',()=>{
 const result=handoff('publication');expect(result.error).toBe('');expect(result.accepts).toBe(2);expect(result.received).toBe(27);
});
test('wrong confirmation stock still refuses before either accept',()=>{
 const result=handoff('wrong-item');expect(result.error).toContain('unexpected carrier trade stock');expect(result.accepts).toBe(0);
});
test('sent confirmation survives an acceptance flag reset before inventory publication',()=>{
 const result=handoff('reset-publication');expect(result.error).toBe('');expect(result.accepts).toBe(2);expect(result.received).toBe(27);
});
test('a refused confirmation does not count as sent',()=>{
 const result=handoff('refused');expect(result.error).toContain('carrier confirmation refused declined');expect(result.received).toBe(0);
});
test('sent confirmations still require both inventory publications',()=>{
 const result=handoff('no-credit');expect(result.error).toContain('essence transfer did not reconcile');expect(result.received).toBe(0);
});

test('a delayed walking handshake is not cancelled by repeated trade requests',()=>{
 const code=`
 import{mock}from'bun:test';import{resolve}from'node:path';
 let phase=0,pending,requests=0,duplicate=false;
 const closed=()=>({isOpen:false,screen:null,myOffer:[],theirOffer:[],myAccepted:false});
 const a={name:'Supplier',pack:[{id:1437,count:405,slot:0},{id:1447,count:1,slot:1}],trade:closed()},b={name:'Carrier',pack:[],trade:closed()};
 for(const [s,other]of [[a,b],[b,a]]){
  s.tick=()=>phase;s.direct=async()=>{requests++;if(phase>0&&phase<3)duplicate=true;return{success:true}};
  s.sdk={getInventory:()=>s.pack,getState:()=>({nearbyPlayers:[{name:other.name,index:1}]}),getTradeState:()=>s.trade,scanGroundItems:async()=>{},sendOfferItem:async slot=>{s.trade.myOffer.push({...s.pack.find(i=>i.slot===slot)});other.trade.theirOffer=s.trade.myOffer.map(i=>({...i}));return{success:true}},sendAcceptTrade:async()=>{s.trade.myAccepted=true;return{success:true}}};
 }
 mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
  if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;
   if(phase===3)for(const [s,o]of [[a,b],[b,a]])s.trade={...closed(),isOpen:true,screen:'offer',partner:o.name};
   if(phase===4){if(duplicate){a.trade.myOffer=[];a.trade.theirOffer=[];b.trade.myOffer=[];b.trade.theirOffer=[];a.trade.myAccepted=false;b.trade.myAccepted=false;}else if(a.trade.myAccepted&&b.trade.myAccepted){a.trade.screen='confirm';b.trade.screen='confirm';a.trade.myAccepted=false;b.trade.myAccepted=false;}}
   if(phase===5&&!duplicate&&a.trade.myAccepted&&b.trade.myAccepted){b.pack=a.pack;a.pack=[];a.trade=closed();b.trade=closed();}
   pending=undefined;r();}));return pending;
 }}));
 const{ownedSwap}=await import('./scripts/rune-carrier-trade');let error='';try{await ownedSwap(a,b,{1437:405,1447:1},{});}catch(e){error=String(e);}console.log(JSON.stringify({error,requests,duplicate,received:b.pack.reduce((n,i)=>n+i.count,0)}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe'});
 if(child.exitCode!==0)throw Error(child.stderr.toString());const result=JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
 expect(result.error).toBe('');expect(result.duplicate).toBe(false);expect(result.requests).toBe(2);expect(result.received).toBe(406);
});

function swapWindow(mode:'late'|'stuck'|'stop'){
 const code=`
 import{mock}from'bun:test';import{resolve}from'node:path';
 let phase=0,pending,accepts=0;
 const stock=[{id:1437,count:405,slot:0},{id:1447,count:1,slot:1}],closed=()=>({isOpen:false,screen:null,myOffer:[],theirOffer:[],myAccepted:false});
 const a={name:'Supplier',pack:stock,trade:{...closed(),isOpen:true,screen:'confirm',partner:'Carrier',myOffer:stock}},b={name:'Carrier',pack:[],trade:{...closed(),isOpen:true,screen:'confirm',partner:'Supplier',theirOffer:stock}};
 for(const s of [a,b]){s.tick=()=>phase;s.sdk={getInventory:()=>s.pack,getState:()=>({nearbyPlayers:[]}),getTradeState:()=>s.trade,scanGroundItems:async()=>{},sendAcceptTrade:async()=>{accepts++;s.trade.myAccepted=true;return{success:true}}};}
 mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
  if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;
   if(phase===1&&a.trade.myAccepted&&b.trade.myAccepted){b.pack=stock;a.pack=[];for(const s of [a,b]){s.trade.myOffer=[];s.trade.theirOffer=[];s.trade.myAccepted=false;}}
   if(phase===2)a.trade=closed();
   if(phase===3&&'${mode}'!=='stuck')b.trade=closed();
   pending=undefined;r();}));return pending;
 }}));
 const{ownedSwap}=await import('./scripts/rune-carrier-trade');let error='';try{await ownedSwap(a,b,{1437:405,1447:1},{},()=> '${mode}'==='stop'&&phase>=2);}catch(e){error=String(e);}
 console.log(JSON.stringify({error,phase,accepts,received:b.pack.reduce((n,i)=>n+i.count,0),bankReady:!a.trade.isOpen&&!b.trade.isOpen}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe'});
 if(child.exitCode!==0)throw Error(child.stderr.toString());return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}

test('paired inventory settlement waits for both trade windows before the bank consumer',()=>{
 const r=swapWindow('late');expect(r.error).toBe('');expect(r.received).toBe(406);expect(r.accepts).toBe(2);expect(r.bankReady).toBe(true);expect(r.phase).toBe(3);
});
test('a stuck trade window refuses within the existing50tick budget despite settled stock',()=>{
 const r=swapWindow('stuck');expect(r.error).toContain('trade windows stayed open');expect(r.received).toBe(406);expect(r.phase).toBe(50);expect(r.accepts).toBe(2);
});
test('stop after inventory settlement prevents a new bank action',()=>{
 const r=swapWindow('stop');expect(r.error).toContain('owned swap stopped');expect(r.received).toBe(406);expect(r.phase).toBe(2);expect(r.bankReady).toBe(false);
});
