import {test,expect} from 'bun:test';
import {resolve} from 'node:path';

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
