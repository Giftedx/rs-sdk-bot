import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {bindCourierReturn} from './courier-route-evidence';

// Compact regression fixture for the saved receipt shape. The CLI separately
// replays the actual files and records their hashes; this fixture is not live proof.
function fixture(){
 const assets=(coins:number,fish:number)=>[{id:995,baseId:995,count:coins},{id:334,baseId:333,count:fish}];
 const start={name:'Bigpackage',server:'rs-sdk-demo.fly.dev',at:2000,bankAt:1900,combat:29,pos:{x:3092,z:3242,level:0},inventory:assets(5004,2150),bank:[{id:329,baseId:329,count:32}]};
 const receiver={...start,name:'Pocketrocket',inventory:assets(100,1),bank:[]};
 const counters={ticks:311,walkTicks:220,boatTicks:75,giveTicks:16,received:0,handed:159,fishNotes:1991,coins:4944,waitTicks:0,feathersBought:0};
 const result='ok '+Object.entries(counters).map(([k,v])=>`${k}=${v}`).join(' ')+' featherTicks=0 legs=draynor coins=5004@0,received0@0,ardougne@295 hpMin=27 died=false';
 const end={...structuredClone(start),started:3000,at:4000,pos:{x:2654,z:3283,level:0},inventory:assets(4944,1991),counters,result};
 const proof={ok:true,at:4200,result:{ok:true,result:{incoming:159}},after:[end,{...receiver,at:4100,inventory:assets(100,160)}]};
 const lines=['RESULT fail needs 60 coins for the boats home at=3092,3242,0 received=2150 handed=0 fishNotes=2150 coins=4'];
 const failed={name:'Bigpackage',server:start.server,started:500,at:1000,lines,source:{sha256:createHash('sha256').update(lines.join('\n')).digest('hex')}};
 return {before:[start,receiver],proof,failed};
}
const run=(f:ReturnType<typeof fixture>)=>bindCourierReturn(f.before,f.proof,f.failed,new Set(['bigpackage','pocketrocket']),5000);
test('recorded boat timing replaces geometric estimate and reserves fare before departure',()=>{
 const r=run(fixture());
 expect(r.funded.selected).toMatchObject({ticks:295,methods:['same','receipt'],remaining:{coins:4944,food:0}});
 expect(r.unfunded.selected).toBeNull();expect(r.unfunded.candidates[0]!.blockers).toContain('onward fare short');
 expect(r.gain).toMatchObject({cashShortfallDetected:56,measuredTicksSaved:null});
 expect(r.request.capacity).toBe(2150); // excludes untouched bank stock
});
test('wrong server, practice, dates, direction and weaker combat cannot borrow access',()=>{
 for(const mutate of [
  (f:ReturnType<typeof fixture>)=>{f.before[0]!.server='localhost:8888';},
  (f:ReturnType<typeof fixture>)=>{(f.before[0] as any).practice=true;},
  (f:ReturnType<typeof fixture>)=>{f.proof.after[0]!.at=6000;},
  (f:ReturnType<typeof fixture>)=>{f.before[0]!.at=3500;},
  (f:ReturnType<typeof fixture>)=>{f.before[0]!.pos.x=2654;},
  (f:ReturnType<typeof fixture>)=>{f.before[0]!.combat=28;},
 ]){const f=fixture();mutate(f);expect(()=>run(f)).toThrow();}
});
test('mismatched money, cargo, recipient, timing and changed raw logs reject the binding',()=>{
 for(const mutate of [
  (f:ReturnType<typeof fixture>)=>{f.before[0]!.inventory[0]!.count++;},
  (f:ReturnType<typeof fixture>)=>{f.before[0]!.bank[0]!.count++;},
  (f:ReturnType<typeof fixture>)=>{f.proof.after[1]!.inventory[1]!.count--;},
  (f:ReturnType<typeof fixture>)=>{(f.proof.after[0] as any).result=(f.proof.after[0] as any).result.replace('ardougne@295','ardougne@294');},
  (f:ReturnType<typeof fixture>)=>{f.failed.lines[0]+=' changed';},
  (f:ReturnType<typeof fixture>)=>{f.proof.ok=false;},
 ]){const f=fixture();mutate(f);expect(()=>run(f)).toThrow();}
});
