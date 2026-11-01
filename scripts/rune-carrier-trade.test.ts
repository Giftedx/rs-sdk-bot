import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
function handoff(mode:'publication'|'wrong-item'){
 const code=`
 import{mock}from'bun:test';import{resolve}from'node:path';
 let phase=0,accepts=0,pending;
 const pack=n=>Array.from({length:n},()=>({id:1436,count:1,slot:0}));
 const make=(name,giver)=>{const a={name,tick:()=>phase};a.trade={isOpen:true,screen:'confirm',partner:giver?'Crafter':'Carrier',myAccepted:false,myOffer:giver?pack(27):[],theirOffer:giver?[]:pack(27)};
 a.sdk={getInventory:()=>giver?pack(phase===0?27:0):pack(phase>=2?27:0),getState:()=>({trade:a.trade,nearbyPlayers:[]}),scanGroundItems:async()=>{},sendAcceptTrade:async()=>{accepts++;a.trade.myAccepted=true;return{success:true}}};return a;};
 const s=make('Crafter',false),h=make('Carrier',true);
 if('${mode}'==='wrong-item'){s.trade.theirOffer=[{id:995,count:27}];h.trade.myOffer=[{id:995,count:27}];}
 mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
  if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;if(phase===1){h.trade={isOpen:false};s.trade.myOffer=[];s.trade.theirOffer=[];}else{s.trade={isOpen:false};}pending=undefined;r();}));return pending;
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
