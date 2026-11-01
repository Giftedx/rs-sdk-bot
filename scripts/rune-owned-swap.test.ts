import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
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
 mock.module(resolve('packages/core/src/ticks'),()=>({waitTicks:()=>{
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
