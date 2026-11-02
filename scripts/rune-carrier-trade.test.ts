import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {levelForXp} from '../packages/planner/src/curve';
test('polling preserves tick-stall failure with at most one wait per actor',()=>{
 const code=`
 import{mock}from'bun:test';import{resolve}from'node:path';let active=0,peak=0,requests=0;
 const s={name:'Crafter'},h={name:'Carrier'};
 for(const[a,o]of [[s,h],[h,s]]){a.tick=()=>0;a.direct=async()=>{requests++;return{success:true}};a.sdk={getInventory:()=>a===h?Array.from({length:27},(_,slot)=>({id:1436,count:1,slot})):[],getState:()=>({trade:{isOpen:false},gameMessages:[],nearbyPlayers:[{name:o.name,index:1}]}),scanGroundItems:async()=>{}};}
 mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{active++;peak=Math.max(peak,active);return new Promise((_,reject)=>setTimeout(()=>{active--;reject(Error('TickStallError: frozen tick stream'))},100));}}));
 const{transfer}=await import('./scripts/rune-carrier-trade');let error='';try{await transfer(s,h)}catch(e){error=String(e)}console.log(JSON.stringify({error,peak,requests}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:1500});
 if(child.exitCode!==0)throw Error('Transfer did not propagate frozen-tick failure: '+child.stderr.toString());
 const r=JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);expect(r.error).toContain('TickStallError');expect(r.peak).toBe(2);expect(r.requests).toBe(1);
});
test('a between-tick owned trade request is answered without waiting for another game tick',()=>{
 const code=`
 import{mock}from'bun:test';import{resolve}from'node:path';
 let tick=0,responseMs=-1,requests=0,raw=[];const started=performance.now();
 const s={name:'Crafter',messages:[]},h={name:'Carrier',messages:[]};
 for(const[a,o]of [[s,h],[h,s]]){
  a.tick=()=>tick;a.direct=async()=>{if(a===h){requests++;setTimeout(()=>raw=[{type:4,sender:'Carrier',text:'wishes to trade with you.',observationId:1}],30);}else responseMs=performance.now()-started;return{success:true}};
  a.sdk={getInventory:()=>a===h?Array.from({length:27},(_,slot)=>({id:1436,count:1,slot})):[],
   getState:()=>({trade:{isOpen:false},gameMessages:a.messages,nearbyPlayers:[{name:o.name,index:1}]}),
   scanGroundItems:async()=>{if(a===s)s.messages=raw;}};
 }
 mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>new Promise(r=>setTimeout(()=>{tick++;r()},400))}));
 const{transfer}=await import('./scripts/rune-carrier-trade');try{await transfer(s,h,()=>responseMs>=0)}catch{}
 console.log(JSON.stringify({responseMs,requests}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:5000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());const r=JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
 expect(r.requests).toBe(1);expect(r.responseMs).toBeGreaterThanOrEqual(25);expect(r.responseMs).toBeLessThan(200);
});
test('an offer acceptance is sent once while its published flag is delayed',()=>{
 const code=`
 import{mock}from'bun:test';import{resolve}from'node:path';let phase=0,pending,offerAccepts=0,confirmAccepts=0;
 const pack=()=>Array.from({length:27},(_,slot)=>({id:1436,count:1,slot}));
 const s={name:'Crafter'},h={name:'Carrier'};
 for(const[a,o]of [[s,h],[h,s]]){
  a.tick=()=>phase;a.trade={isOpen:true,screen:'offer',partner:o.name,myAccepted:false,myOffer:a===h?pack():[],theirOffer:a===s?pack():[]};
  a.sdk={getInventory:()=>a===s?(phase>=3?pack():[]):(phase>=3?[]:pack()),getState:()=>({trade:a.trade,nearbyPlayers:[]}),scanGroundItems:async()=>{},
   sendAcceptTrade:async()=>{if(a.trade.screen==='offer')offerAccepts++;else confirmAccepts++;return{success:true}}};
 }
 mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
  if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;if(phase===2)for(const a of[s,h])a.trade.screen='confirm';if(phase===3)for(const a of[s,h])a.trade={isOpen:false};pending=undefined;r()}));return pending;
 }}));
 const{transfer}=await import('./scripts/rune-carrier-trade');let error='';try{await transfer(s,h)}catch(e){error=String(e)}
 console.log(JSON.stringify({error,offerAccepts,confirmAccepts}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:5000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());const r=JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
 expect(r.error).toBe('');expect(r.offerAccepts).toBe(2);expect(r.confirmAccepts).toBe(2);
});
function delayedOffer(mode:'valid'|'empty'|'wrong-item'|'partial'){
 const code=`
 import{mock}from'bun:test';import{resolve}from'node:path';let phase=0,pending,offered=false,receiverAt=-1,confirms=0;
 const pack=(n=27,id=1436)=>Array.from({length:n},(_,slot)=>({id,count:1,slot}));
 const s={name:'Crafter'},h={name:'Carrier'};
 for(const[a,o]of[[s,h],[h,s]]){a.tick=()=>phase;a.trade={isOpen:true,screen:'offer',partner:o.name,myAccepted:false,myOffer:[],theirOffer:[]};
 a.sdk={getInventory:()=>a===h?(phase<4?pack():[]):(phase>=4?pack():[]),getState:()=>({trade:a.trade,nearbyPlayers:[]}),scanGroundItems:async()=>{},
 sendOfferItem:async()=>{offered=true;return{success:true}},sendAcceptTrade:async()=>{if(a.trade.screen==='confirm')confirms++;else if(a===s)receiverAt=phase;return{success:true}}};}
 mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
 if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;
 if(phase===1&&offered)h.trade.myAccepted=true;
 if(phase===2){const stock='${mode}'==='empty'?[]:pack('${mode}'==='partial'?26:27,'${mode}'==='wrong-item'?995:1436);h.trade.myOffer=stock;s.trade.theirOffer=stock;}
 if(phase===3)for(const a of[s,h]){a.trade.screen='confirm';a.trade.myAccepted=false;}
 if(phase===4)for(const a of[s,h])a.trade={isOpen:false};pending=undefined;r();}));return pending;}}));
 const{transfer}=await import('./scripts/rune-carrier-trade');let error='';try{await transfer(s,h)}catch(e){error=String(e)}console.log(JSON.stringify({error,receiverAt,confirms}));`;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:5000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}
test('a fresh server acceptance acknowledges the owned offer before item publication',()=>{
 const r=delayedOffer('valid');expect(r.error).toBe('');expect(r.receiverAt).toBe(1);expect(r.confirms).toBe(2);
});
test('early owned-offer acceptance cannot accept empty, partial or wrong-item confirmation',()=>{
 for(const mode of ['empty','partial','wrong-item'] as const){const r=delayedOffer(mode);expect(r.error).not.toBe('');expect(r.confirms).toBe(0);}
});

function acceptedCraftCase(mode:'fresh'|'stale'|'spoofed'|'no-movement'|'refused'|'stop'){
 const code=`import{mock}from'bun:test';import{resolve}from'node:path';let phase=0,pending,craftAt=-1,crafts=0;
 const pack=()=>Array.from({length:27},(_,slot)=>({id:1436,count:1,slot}));const s={name:'Crafter'},h={name:'Carrier'};
 for(const[a,o]of[[s,h],[h,s]]){a.tick=()=>phase;a.messages=[{type:0,sender:'',text:'Accepted trade.',observationId:1}];a.trade={isOpen:true,screen:'confirm',partner:o.name,myAccepted:false,myOffer:a===h?pack():[],theirOffer:a===s?pack():[]};
 a.sdk={getInventory:()=>a===h?(phase===0?pack():[]):(phase>=2&&craftAt<0&&'${mode}'!=='no-movement'?pack():[]),getState:()=>({trade:a.trade,gameMessages:a.messages,nearbyPlayers:[]}),scanGroundItems:async()=>{},sendAcceptTrade:async()=>{a.trade.myAccepted=true;return{success:true}}};}
 mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;if(phase===1)for(const a of[s,h]){a.trade={isOpen:false};if('${mode}'!=='stale')a.messages.push({type:'${mode}'==='spoofed'?2:0,sender:'${mode}'==='spoofed'?'Stranger':'',text:'Accepted trade.',observationId:2});}pending=undefined;r();}));return pending;}}));
 const{transfer}=await import('./scripts/rune-carrier-trade');let error='';try{await transfer(s,h,()=> '${mode}'==='stop'&&phase>=1,27,{send:async()=>{crafts++;craftAt=phase;if('${mode}'==='refused')throw Error('fixture altar refused');},complete:()=>craftAt>=0&&phase>=3&&'${mode}'!=='no-movement'});}catch(e){error=String(e)}console.log(JSON.stringify({error,craftAt,crafts,phase}));`;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:5000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}
test('combined crafting can start on both fresh server acceptance messages before credit publication',()=>{
 const r=acceptedCraftCase('fresh');expect(r.error).toBe('');expect(r.craftAt).toBe(1);expect(r.crafts).toBe(1);expect(r.phase).toBeGreaterThanOrEqual(3);
});
test('stale or spoofed acceptance cannot start a combined craft before observed credit',()=>{
 for(const mode of ['stale','spoofed'] as const){const r=acceptedCraftCase(mode);expect(r.error).toBe('');expect(r.craftAt).toBe(2);expect(r.crafts).toBe(1);}
});
test('combined handoff refuses missing effects, a refused altar action and stop without blind craft retries',()=>{
 const missing=acceptedCraftCase('no-movement');expect(missing.error).not.toBe('');expect(missing.crafts).toBe(1);
 const refused=acceptedCraftCase('refused');expect(refused.error).toContain('fixture altar refused');expect(refused.crafts).toBe(1);
 const stopped=acceptedCraftCase('stop');expect(stopped.error).not.toBe('');expect(stopped.crafts).toBe(0);
});

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

test('delayed carrier transfer opening avoids cancellation and reconciles27 essence on both actors',()=>{
 const code=`
 import{mock}from'bun:test';import{resolve}from'node:path';
 let phase=0,pending,duplicate=false,cancelled=false;
 const requests=[],closed=()=>({isOpen:false,screen:null,myOffer:[],theirOffer:[],myAccepted:false});
 const s={name:'Crafter',pack:[],trade:closed(),messages:[]},h={name:'Carrier',pack:Array.from({length:27},(_,slot)=>({id:1436,count:1,slot})),trade:closed(),messages:[]};
 const essence=a=>a.pack.filter(i=>i.id===1436).reduce((n,i)=>n+i.count,0),before=[essence(s),essence(h)];
 for(const [a,other]of [[s,h],[h,s]]){
  a.tick=()=>phase;a.direct=async()=>{if(requests.some(r=>r.name===a.name))duplicate=true;requests.push({name:a.name,tick:phase});return{success:true}};
  a.sdk={getInventory:()=>a.pack,getState:()=>({trade:a.trade,gameMessages:a.messages,nearbyPlayers:[{name:other.name,index:1}]}),scanGroundItems:async()=>{},sendOfferItem:async(slot,amount)=>{
   if(a!==h||amount!==-1||!a.pack.some(i=>i.slot===slot))throw Error('unexpected offer');
   a.trade.myOffer=a.pack.map(i=>({...i}));other.trade.theirOffer=a.trade.myOffer.map(i=>({...i}));a.trade.myAccepted=false;other.trade.myAccepted=false;return{success:true};
  },sendAcceptTrade:async()=>{a.trade.myAccepted=true;return{success:true}}};
 }
 mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
  if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;
   if(phase===1)s.messages.push({type:4,sender:h.name,text:'wishes to trade with you.',observationId:1});
   if(phase===3)for(const [a,o]of [[s,h],[h,s]])a.trade={...closed(),isOpen:true,screen:'offer',partner:o.name};
   if(phase===4){
    if(duplicate){cancelled=true;for(const [a,o]of [[s,h],[h,s]])a.trade={...closed(),isOpen:true,screen:'offer',partner:o.name};}
    else if(s.trade.myAccepted&&h.trade.myAccepted)for(const a of [s,h]){a.trade.screen='confirm';a.trade.myAccepted=false;}
   }
   if(phase===5&&!cancelled&&s.trade.screen==='confirm'&&h.trade.screen==='confirm'&&s.trade.myAccepted&&h.trade.myAccepted){s.pack=h.pack;h.pack=[];s.trade=closed();h.trade=closed();}
   pending=undefined;r();}));return pending;
 }}));
 const{transfer}=await import('./scripts/rune-carrier-trade');let error='';try{await transfer(s,h);}catch(e){error=String(e);}
 const after=[essence(s),essence(h)];console.log(JSON.stringify({error,requests,duplicate,cancelled,before,after,deltas:after.map((n,i)=>n-before[i])}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:10000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());const result=JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
 expect(result.error).toBe('');expect(result.duplicate).toBe(false);expect(result.cancelled).toBe(false);
 expect(result.requests).toEqual([{name:'Carrier',tick:0},{name:'Crafter',tick:1}]);
 expect(result.before).toEqual([0,27]);expect(result.after).toEqual([27,0]);expect(result.deltas).toEqual([27,-27]);
});

function acknowledgedTransfer(busyUntil:number,mode:'fresh'|'missing'|'stop'|'levelup'|'level54'|'unrelated-dialog'|'levelup-stop'='fresh'){
 const code=`
 import{mock}from'bun:test';import{resolve}from'node:path';
 let phase=0,pending,outstanding=false,received=false,duplicate=false,premature=false,opening=-1,escrow=[];
 let modal=${['levelup','level54','unrelated-dialog','levelup-stop'].includes(mode)},closes=0,unlock=false;
 const requests=[],events=[],closed=()=>({isOpen:false,screen:null,myOffer:[],theirOffer:[],myAccepted:false});
 const s={name:'Crafter',pack:[{id:1446,count:1,slot:0}],trade:closed(),messages:[{type:4,sender:'Carrier',text:'wishes to trade with you.',observationId:7}],seq:7};
 const h={name:'Carrier',pack:[{id:1446,count:1,slot:0},...Array.from({length:27},(_,i)=>({id:1436,count:1,slot:i+1}))],trade:closed(),messages:[{type:0,sender:'',text:'Crafter is busy at the moment.',observationId:7}],seq:7};
 const message=(a,type,sender,text)=>a.messages.push({type,sender,text,observationId:++a.seq});
 for(const[a,other]of [[s,h],[h,s]]){
  a.tick=()=>phase;a.direct=async(action)=>{
   if(action.type==='closeModal'){
    if(a!==s)throw Error('wrong actor closed');closes++;events.push({at:phase+1,run:()=>{modal=false;}});return{success:true};
   }
   requests.push({name:a.name,tick:phase});
   if(a===h){
    if(outstanding)duplicate=true;outstanding=true;const busy=phase<${busyUntil}||modal;
    events.push({at:phase+1,run:()=>{if(busy){outstanding=false;message(h,0,'','Crafter is busy at the moment.');}else if('${mode}'!=='missing'){received=true;message(s,4,'cArRiEr','wishes to trade with you.');}}});
   }else if(!received||phase<${busyUntil})premature=true;
   else if(opening<0)opening=phase+1;
   return{success:true};
  };
  a.sdk={getInventory:()=>a.pack,getState:()=>({trade:a.trade,gameMessages:a.messages,dialog:a===s?{isOpen:modal,options:[{index:1,text:'Click here to continue',componentId:4270,buttonType:6}],allComponents:[{id:4268,text:unlock?'Members can now craft @dbl@Law Runes@bla@.':'${mode==='unrelated-dialog'?'Choose an option.':'@dbl@Congratulations, you just advanced a runecraft level.'}'}]}:undefined,nearbyPlayers:[{name:other.name,index:1}]}),scanGroundItems:async()=>{},clickDialogByText:async()=>{
   events.push({at:phase+1,run:()=>{if('${mode}'==='level54'&&!unlock)unlock=true;else modal=false;}});return{success:true};
  },sendOfferItem:async(slot,amount)=>{
   if(a!==h||amount!==-1||!h.pack.some(i=>i.slot===slot&&i.id===1436))throw Error('unexpected offer');
   escrow=h.pack.filter(i=>i.id===1436);h.pack=h.pack.filter(i=>i.id!==1436);h.trade.myOffer=escrow;s.trade.theirOffer=escrow;return{success:true};
  },sendAcceptTrade:async()=>{a.trade.myAccepted=true;return{success:true}}};
 }
 mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
  if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;
   if(phase===1){message(s,4,'Other','wishes to trade with you.');message(s,2,'Carrier','wishes to trade with you.');}
   for(const e of events.filter(e=>e.at===phase))e.run();
   if(phase===opening)for(const[a,o]of [[s,h],[h,s]])a.trade={...closed(),isOpen:true,screen:'offer',partner:o.name};
   else if(duplicate&&opening>=0&&phase===opening+1){h.pack.push(...escrow);escrow=[];for(const[a,o]of [[s,h],[h,s]])a.trade={...closed(),isOpen:true,screen:'offer',partner:o.name};}
   else if(!duplicate&&s.trade.screen==='offer'&&s.trade.myAccepted&&h.trade.myAccepted)for(const a of[s,h]){a.trade.screen='confirm';a.trade.myAccepted=false;}
   else if(!duplicate&&s.trade.screen==='confirm'&&s.trade.myAccepted&&h.trade.myAccepted){s.pack.push(...escrow);escrow=[];s.trade=closed();h.trade=closed();}
   pending=undefined;r();}));return pending;
 }}));
 const{transfer}=await import('./scripts/rune-carrier-trade');let error='';try{await transfer(s,h,()=> '${mode}'==='levelup-stop'||('${mode}'==='stop'&&phase>=2));}catch(e){error=String(e);}
 const count=(a,id)=>a.pack.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 console.log(JSON.stringify({error,phase,requests,duplicate,premature,closes,modal,after:[count(s,1436),count(h,1436)],talismans:[count(s,1446),count(h,1446)]}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:10000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}
test('carrier retries only acknowledged busy requests and responds once to a fresh exact-player request',()=>{
 for(const busy of [0,3,7]){
  const r=acknowledgedTransfer(busy);expect(r.error).toBe('');expect(r.duplicate).toBe(false);expect(r.premature).toBe(false);
  expect(r.requests.filter((a:any)=>a.name==='Carrier')).toHaveLength(busy+1);
  expect(r.requests.filter((a:any)=>a.name==='Crafter')).toEqual([{name:'Crafter',tick:busy+1}]);
  expect(r.phase).toBeLessThanOrEqual(busy+5);expect(r.after).toEqual([27,0]);expect(r.talismans).toEqual([1,1]);
 }
});

test('a Runecraft level-up dialog is dismissed before a fresh trade request can arrive',()=>{
 const r=acknowledgedTransfer(0,'levelup');expect(r.error).toBe('');expect(r.closes).toBe(1);
 expect(r.duplicate).toBe(false);expect(r.premature).toBe(false);expect(r.after).toEqual([27,0]);
 expect(r.talismans).toEqual([1,1]);expect(r.phase).toBeLessThanOrEqual(6);
});

test('the reachable level54 reward page cannot keep the next essence handoff busy',()=>{
 expect(levelForXp(3375+8*27*7.5*25)).toBe(54);
 const r=acknowledgedTransfer(0,'level54');expect(r.error).toBe('');expect(r.modal).toBe(false);
 expect(r.after).toEqual([27,0]);expect(r.talismans).toEqual([1,1]);
});

test('the handoff preserves unrelated dialogs and sends no dismissal after stop',()=>{
 const unrelated=acknowledgedTransfer(0,'unrelated-dialog');expect(unrelated.closes).toBe(0);
 expect(unrelated.error).toContain('essence transfer did not reconcile');expect(unrelated.after).toEqual([0,27]);
 const stopped=acknowledgedTransfer(0,'levelup-stop');expect(stopped.closes).toBe(0);expect(stopped.requests).toEqual([]);
 expect(stopped.after).toEqual([0,27]);
});
test('stale, wrong-player and player-chat requests cannot open a handoff or send a response after stop',()=>{
 const missing=acknowledgedTransfer(0,'missing');expect(missing.error).toContain('essence transfer did not reconcile');
 expect(missing.requests).toEqual([{name:'Carrier',tick:0}]);expect(missing.after).toEqual([0,27]);expect(missing.phase).toBeLessThanOrEqual(35);
 const stopped=acknowledgedTransfer(7,'stop');expect(stopped.error).toContain('essence transfer did not reconcile');
 expect(stopped.requests.every((a:any)=>a.name==='Carrier'&&a.tick<2)).toBe(true);expect(stopped.after).toEqual([0,27]);
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
