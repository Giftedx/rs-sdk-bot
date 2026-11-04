import {test,expect} from 'bun:test';
import{settle,watchUnexpectedEnd}from'../packages/core/src/bot';
import {spinInputFailure,spinConversion,spinLimits,spinOwnedSession,spinAssets,main} from './spin-bowstrings';
import {isNoProgressFailure,supervise} from '../packages/practice/src/supervise';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
test('empty and partial bank-at-reserve batches stop the supervisor after one run',async()=>{
 for(const made of [0,25]) {
  const reason=spinInputFailure(made,500,50,50);let runs=0;
  const end=await supervise({run:async()=>{runs++;return{exitCode:1,stdout:`RESULT fail ${reason} made=${made} rawBank=50 targetMet=0 stop=input-wait`};},stopped:()=>false,pause:async()=>{throw new Error('empty input must not log in again');},maxRestarts:20});
  expect(end).toEqual({reason:'blocked',runs:1});expect(runs).toBe(1);
 }
 expect(spinInputFailure(0,500,49,50)).toContain('no spinning progress');
});
test('a complete backed batch remains successful even when its last flax is the reserve',async()=>{
 expect(spinInputFailure(500,500,50,50)).toBe('');
 const stdout='RESULT ok made=500 rawBank=50 targetMet=1 stop=target';expect(isNoProgressFailure(stdout)).toBe(false);
 expect(await supervise({run:async()=>({exitCode:0,stdout}),stopped:()=>false,pause:async()=>{throw new Error('must finish once');},maxRestarts:20})).toEqual({reason:'done',runs:1});
});
test('a target shortfall with stock still above reserve keeps its other failure cause',()=>{
 expect(spinInputFailure(25,500,550,50)).toBe('');
});

test('spinning counts only matched flax, bow string and Crafting XP changes',()=>{
 const before={items:{1779:3,1777:2,995:17},xp:1000};
 expect(spinConversion(before,{items:{1779:1,1777:4,995:17},xp:1750},3)).toBe(2);
 expect(spinConversion(before,before,3)).toBe(0);
 for(const after of [{items:{1779:1,1777:2,995:17},xp:1750},{items:{1779:1,1777:4,995:16},xp:1750},{items:{1779:1,1777:4,995:17},xp:1000},{items:{1779:4,1777:1,995:17},xp:625}])expect(()=>spinConversion(before,after,3)).toThrow('spinning conversion');
 expect(()=>spinConversion(before,{items:{1777:5,995:17},xp:2125},2)).toThrow('spinning conversion');
});

test('whole-stock spinning ledger includes kit and canonical flax/string certificates',()=>{
 const before={items:spinAssets([{id:1779,count:50},{id:1780,count:2},{id:1778,count:7},{id:995,count:13},{id:1735,count:1}]),xp:100};
 const after={items:spinAssets([{id:1779,count:50},{id:1777,count:9},{id:995,count:13},{id:1735,count:1}]),xp:850};
 expect(spinConversion(before,after,2)).toBe(2);
 expect(()=>spinConversion(before,{...after,items:{...after.items,995:12}},2)).toThrow();
});

test('finite spin limits reject invalid caps and trip limits before login',()=>{
 expect(spinLimits(56,50,15000,8)).toEqual({maximum:56,reserve:50,cap:15000,trips:8});
 for(const values of [[0,0,300,4],[1,-1,300,4],[1,0,NaN,4],[1,0,300,Infinity],[1,0,0,4],[1,0,300,0]])expect(()=>spinLimits(...values as [number,number,number,number])).toThrow('finite spinning');
});

test('actual spin CLI rejects an unbounded trip setting before login',()=>{
 const result=spawnSync(process.execPath,[join(import.meta.dir,'spin-bowstrings.ts'),'__spin_preflight__'],{encoding:'utf8',timeout:10000,windowsHide:true,env:{...process.env,MAX_TRIPS:'Infinity',DEMO_OK:''}});
 expect(result.status).toBe(1);expect(result.stderr).toContain('invalid finite spinning limits');expect(result.stdout).not.toContain('START spin-bowstrings');
});

test('spinning input stays bound to original owner and stop requests still permit owned logout',async()=>{
 for(const change of ['sdk','client','direct','close','executor','slot','life','respawns','endpoint','ended','stale','stop']){
  const player={lifeId:1,respawnCount:0,isDead:false},client={selfSlot:1,executeBotAction:()=>{}};let sent=0,stopped=false;
  const sdk={config:{host:'local'},getState:()=>({player}),getSkill:()=>({level:99}),getStateAge:()=>0,sendCloseModal:async()=>{sent++;}};
  const raw:any={name:'fixture',sdk,client,direct:async()=>{sent++;},close:async()=>{},ended:new Promise(()=>{})};
  const owned=spinOwnedSession(raw,()=>stopped);await owned.session.sdk.sendCloseModal();expect(sent).toBe(1);sent=0;
  if(change==='sdk')raw.sdk={...sdk};if(change==='client')raw.client={...client};if(change==='direct')raw.direct=async()=>{};
  if(change==='close')raw.close=async()=>{};if(change==='executor')client.executeBotAction=()=>{};if(change==='respawns')player.respawnCount++;if(change==='stale')sdk.getStateAge=()=>6000;
  if(change==='slot')client.selfSlot++;if(change==='life')player.lifeId++;if(change==='endpoint')sdk.config.host='foreign';if(change==='ended')raw.ended=new Promise(()=>{});if(change==='stop')stopped=true;
  expect(()=>owned.session.sdk.sendCloseModal()).toThrow();expect(sent).toBe(0);
  if(change==='stop'){owned.cleanup();await owned.session.direct({type:'clickComponent',componentId:1,reason:'cleanup'});expect(sent).toBe(1);}
  else{owned.cleanup();expect(()=>owned.session.direct({type:'clickComponent',componentId:1,reason:'cleanup'})).toThrow();expect(sent).toBe(0);}
 }
});


function spinEntryFixture(){let end!:(value:{reason:string})=>void,inputs=0,closed=0;const player={lifeId:1,respawnCount:0,isDead:false},client={selfSlot:1,executeBotAction:()=>({success:true})};const raw:any={name:'spinOwned',tick:()=>0,client,ended:new Promise(r=>{end=r;}),sdk:{config:{host:'localhost'},getState:()=>({player,inGame:true}),getSkill:()=>({level:99}),getStateAge:()=>0},direct:async()=>{inputs++;end({reason:'logged-out'});return{success:true};},close:async()=>{closed++;}};return{raw,player,client,stats:()=>({inputs,closed})};}

test('actual main captures ownership BEFORE initial sync await; replacements cannot send or finalize',async()=>{
 const previous=process.exitCode;try{for(const replacement of ['executor','client','life','respawn']){const f=spinEntryFixture();let final=0;await main({open:async()=>f.raw,ready:async()=>{await Promise.resolve();if(replacement==='executor')f.client.executeBotAction=()=>({success:true});if(replacement==='client')f.raw.client={...f.client};if(replacement==='life')f.player.lifeId++;if(replacement==='respawn')f.player.respawnCount++;return true;},finalize:async()=>{final++;}});expect(f.stats()).toEqual({inputs:0,closed:0});expect(final).toBe(0);}}finally{process.exitCode=previous??0;}
});

test('actual main finalizes original raw under Core settlement before owned logout and does not trigger unexpected-end cleanup',async()=>{
 const f=spinEntryFixture();let reported=false,unexpected=0,final=0;watchUnexpectedEnd(f.raw,()=>reported,()=>false,async()=>{unexpected++;});await main({open:async()=>f.raw,ready:async()=>false,finalize:async(rows,ok,detail,options)=>{final++;expect(rows[0]).toBe(f.raw);expect(typeof options?.logout).toBe('function');return settle(rows,ok,detail,{...options,onReported:()=>{reported=true;},log:()=>{}});}});expect(final).toBe(1);expect(f.stats()).toEqual({inputs:1,closed:1});expect(unexpected).toBe(0);
});

test('known original stop permits guarded bank cleanup but never reopens production',async()=>{
 const f=spinEntryFixture();let stopped=true,banks=0;f.raw.sdk.sendInteractLoc=async()=>{banks++;return{success:true};};const owned=spinOwnedSession(f.raw,()=>stopped);expect(()=>owned.session.sdk.sendInteractLoc(2727,3492,2213,1)).toThrow();owned.cleanup();await owned.session.sdk.sendInteractLoc(2727,3492,2213,1);expect(banks).toBe(1);expect(owned.stopped()).toBe(true);
});


test('cleanup deadline, HP and stale flips during an awaited SDK continuation block all later bank/deposit wires',async()=>{
 for(const mode of ['deadline','hp','stale']){const f=spinEntryFixture();let allowed=true,hp=99,age=0,wire=0,release!:()=>void;f.raw.sdk.getSkill=()=>({level:hp});f.raw.sdk.getStateAge=()=>age;f.raw.sdk.send=()=>{wire++;return{success:true};};f.raw.sdk.sendInteractLoc=async function(){await new Promise<void>(r=>{release=r;});return this.send();};f.raw.sdk.sendBankDeposit=async()=>{wire++;return{success:true};};const owned=spinOwnedSession(f.raw,()=>true,()=>allowed);owned.cleanup();const pending=owned.session.sdk.sendInteractLoc(2727,3492,2213,1);if(mode==='deadline')allowed=false;if(mode==='hp')hp=6;if(mode==='stale')age=5001;release();await expect(pending).rejects.toThrow('original');expect(()=>owned.session.sdk.sendBankDeposit(0,1)).toThrow('original');expect(wire).toBe(0);}
});


test('actual main cap expiry blocks gameplay but permits one owned terminal logout',async()=>{
 const f=spinEntryFixture();let tick=0,final=0;f.raw.tick=()=>tick;await main({open:async()=>f.raw,ready:async()=>{tick=1000000;return false;},finalize:async(rows,ok,detail,options)=>{final++;expect(rows[0]).toBe(f.raw);return settle(rows,ok,detail,{...options,log:()=>{}});}});expect(f.stats()).toEqual({inputs:1,closed:1});expect(final).toBe(1);
});

test('a stop received during initial sync ends actual main before stock setup or bank recovery',async()=>{
 const f=spinEntryFixture();let stop!:()=>Promise<void>,stockReads=0,finalDetail='';
 f.raw.sdk.getSkillXp=()=>0;f.raw.sdk.getInventory=()=>{stockReads++;throw Error('production setup reached after stop');};
 await main({open:async(_name,options)=>{stop=options!.onStop! as ()=>Promise<void>;return f.raw;},ready:async()=>{await stop();return true;},finalize:async(rows,ok,detail,options)=>{finalDetail=detail;expect(ok).toBe(false);return settle(rows,ok,detail,{...options,log:()=>{}});}});
 expect(finalDetail).toContain('spinning stopped before admission');expect(stockReads).toBe(0);expect(f.stats()).toEqual({inputs:1,closed:1});
});
