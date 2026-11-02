import {test,expect} from 'bun:test';
import {resolve} from 'node:path';

function prewarmCase(late:boolean){
 const code=`
 import{mock}from'bun:test';import{resolve,join,dirname}from'node:path';import{mkdirSync,writeFileSync,rmSync}from'node:fs';
 const stem='flwarm'+Math.random().toString(36).slice(2,5),labels=['Fresh','Donor',...Array.from({length:15},(_,i)=>'Helper'+i)],names=labels.map((_,i)=>stem+i.toString(36)),role=n=>labels[names.indexOf(n)],opened=[],closed=[],created=[];let prefix=false,prefixOpened=[];
 const botRoot=resolve('vendor/rs-sdk/bots');mkdirSync(botRoot,{recursive:true});
 for(const name of names){const path=join(botRoot,name);mkdirSync(path);created.push(path);writeFileSync(join(path,'bot.env'),'SERVER=localhost:8910\\n');}
 const modules={
 '../packages/core/src/bot':{getWorld:async()=>({}),serverFromEnv:()=> 'localhost:8910',openBot:async name=>{opened.push(role(name));return{name,tick:()=>${late}&&role(name)==='Donor'?501:0,onTick:()=>()=>{},sdk:{getInventory:()=>[{id:1446,count:1}],getSkill:()=>({baseLevel:1}),getState:()=>({player:{},skills:[]})}}},settle:async actors=>{closed.push(...actors.map(a=>role(a.name)));return true}},
 '../packages/core/src/fleet':{assertSideOwns:()=>{}},
 '../packages/core/src/ticks':{waitTicks:async()=>{},waitUntil:async(_s,p)=>p()},
 './rune-carrier-roster':{runeCarrierRoster:a=>a.filter(n=>!n.startsWith('--')),assertRuneDonor:()=>{},assertFreshRuneSkills:()=>{}},
 './rune-carrier-start':{freshBodyStart:async(_s,_h,_stop,prepare)=>{prefix=true;prefixOpened=[...opened];await prepare();throw Error('fixture prefix stopped')}},
 './rune-carrier-trade':{state:a=>a.sdk.getState(),ess:()=>27,transfer:async()=>0,ownedSwap:async()=>({ticks:0})},
 './rune-carrier-bank':{inside:()=>true,stopCarriers:()=>{},restock:async()=>0,bankCarrier:async()=>({}),withdrawCarrier:async()=>{},closeCarrierBank:async()=>{},stageCarrier:async()=>{}}
 };
 for(const[p,m]of Object.entries(modules))mock.module(resolve('scripts',p),()=>m);
 try{const{runRuneCarriers}=await import('./scripts/rune-carriers');const result=await runRuneCarriers(names,2800);console.log(JSON.stringify({opened,closed,prefix,prefixOpened,result}));}
 finally{for(const path of created){if(dirname(path)!==botRoot)throw Error('fixture path escaped');rmSync(path,{recursive:true});}}
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:5000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}
test('the crafter logs in before carrier preparation overlaps its prefix',()=>{
 const r=prewarmCase(false);expect(r.prefixOpened).toEqual(['Donor','Fresh']);expect(r.opened).toEqual(['Donor','Fresh',...Array.from({length:15},(_,i)=>'Helper'+i)]);expect(r.prefix).toBe(true);expect(r.closed).toEqual(r.opened);
});
test('an exhausted donor budget stops before the fresh crafter login',()=>{
 const r=prewarmCase(true);expect(r.opened).toEqual(['Donor']);expect(r.prefix).toBe(false);expect(r.closed).toEqual(r.opened);expect(r.result.failure).toContain('fresh route budget');
});

// Module stubs run in their own process so they cannot change another test's SDK.
function prefixCase(which:'stop-walk'|'prefix-error'){
 const code=`
 import {mock} from 'bun:test';
 import {resolve} from 'node:path';
 let stopped=false,bankActions=0,helperLogins=0;
 const cancel=new AbortController(),delay=ms=>new Promise(r=>setTimeout(r,ms));
 const stop=()=>stopped||cancel.signal.aborted;
 const actor=name=>({name,tick:()=>1,xp:0,bankObservation:()=>({generation:1,items:[]}),inventory:[{id:1351,count:1}],state:{player:{worldX:3222,worldZ:3222,level:0},bank:{}},sdk:{getSkillXp(){return 0},getInventory(){return this.owner.inventory}},bot:{async openBank(){bankActions++;throw Error('bank action after stop')}}});
 const s=actor('crafter'),h=actor('donor');for(const a of [s,h])a.sdk.owner=a;
 const modules={
 '../packages/core/src/bot':{getWorld:async()=>({}),accountOf:()=>({})},
 '../packages/core/src/ticks':{waitUntil:async(_s,p)=>p()},
 '../packages/core/src/walk':{goTo:async a=>{if(a===h){if('${which}'==='stop-walk')stopped=true;else await delay(15);}return{ok:true}},walkPath:async()=>({ok:true}),sessionWalker:async()=>({})},
 '../packages/core/src/deposit':{depositObserved:async()=>{bankActions++}},
 '../packages/core/src/world':{interactionApproach:async()=>({})},
 './rune-supply':{leaveRuneStarter:async()=>{},runeSupplyAssets:()=>({1351:1})},
 './generated/rcair':{enterAirAltar:async()=>{},craftAirRunes:async()=>({}),exitAirAltar:async()=>{throw Error('portal rejected')}},
 './rune-bank-craft':{RUNE_ALTARS:[{name:'body',outside:{x:3050,z:3442}}],ruinTarget:()=>({}),dispatchRuneEntry:async()=>({})},
 './rune-carrier-trade':{ownedSwap:async()=>({}),state:a=>a.state,ess:()=>0}
 };
 for(const [path,value]of Object.entries(modules))mock.module(resolve('scripts',path),()=>value);
 const {freshBodyStart}=await import('./scripts/rune-carrier-start');
 try{await freshBodyStart(s,h,stop,async()=>{for(let i=0;i<3;i++){if(stop())break;await delay(5);helperLogins++;}},cancel);}catch{}
 console.log(JSON.stringify({bankActions,helperLogins,cancelled:cancel.signal.aborted}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe'});
 if(child.exitCode!==0)throw Error(child.stderr.toString());
 return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}
test('a stop during donor travel prevents bank actions',()=>{
 const result=prefixCase('stop-walk');expect(result.bankActions).toBe(0);expect(result.cancelled).toBe(true);
});
test('a prefix failure cancels helper setup before it drains',()=>{
 const result=prefixCase('prefix-error');expect(result.cancelled).toBe(true);expect(result.helperLogins).toBeLessThanOrEqual(1);expect(result.bankActions).toBe(0);
});
