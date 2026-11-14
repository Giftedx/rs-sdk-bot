import {test,expect} from 'bun:test';
import {resolve} from 'node:path';

// Keep mocked engine boundaries in a child so other workers retain their real modules.
function productionCase(config:{inside?:'air'|'body';altar?:'air'|'body';heldEssence?:number;bankEssence?:number;target?:number;
 currentLevel?:number;xp?:number|null;rate?:number;airTalisman?:boolean}={}){
 const code=`
 import {mock} from 'bun:test';import {resolve} from 'node:path';
 const config=${JSON.stringify(config)},actions=[],withdrawals=[],recipes=[];
 let inventory=[],stored=new Map([[1436,config.bankEssence??40],[1438,config.airTalisman===false?0:1],[1446,1],[995,42],[556,3],[559,7]]),generation=1;
 let xp=config.xp===null?undefined:config.xp??200000000,currentLevel=config.currentLevel??99;
 const player={worldX:config.inside==='body'?2523:config.inside==='air'?2841:3013,worldZ:config.inside?4830:3355,level:0};
 const held=id=>inventory.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const slots=()=>inventory.forEach((i,slot)=>i.slot=slot);
 const add=(id,n)=>{if(id===1436)for(let i=0;i<n;i++)inventory.push({id,count:1});else{const item=inventory.find(i=>i.id===id);if(item)item.count+=n;else inventory.push({id,count:n});}slots();};
 add(1436,config.heldEssence??0);
 if(config.inside&&config.airTalisman!==false){const talisman=config.altar==='body'?1446:1438;stored.set(talisman,0);add(talisman,1);}
 const items=()=>[...stored].filter(([,count])=>count>0).map(([id,count])=>({id,count}));
 const st={player,bank:{isOpen:false,get items(){return items();}},get inventory(){return inventory;},nearbyLocs:[{id:2470,x:2523,z:4837,level:0,optionsWithIndex:[{opIndex:1,text:'Use'}]}]};
 const deposit=async(_s,item)=>{const n=held(item.id);inventory=inventory.filter(i=>i.id!==item.id);stored.set(item.id,(stored.get(item.id)??0)+n);generation++;slots();return n;};
 const craft=async()=>{
  const altar=player.worldX===2841?'air':'body',n=held(1436);recipes.push({altar,n});
  inventory=inventory.filter(i=>i.id!==1436);add(altar==='air'?556:559,n*(Math.floor(currentLevel/(altar==='air'?11:46))+1));
  xp=Math.min(200000000,xp+n*(altar==='air'?5:7.5)*(config.rate??25));return {success:true};
 };
 const s={name:'finite-rune-fixture',tick:()=>0,ended:new Promise(()=>{}),onTick:()=>()=>{},bankObservation:()=>({generation,items:items()}),
  sdk:{getState:()=>st,getInventory:()=>inventory,getSkill:()=>({baseLevel:99,level:currentLevel}),getSkillXp:()=>xp===undefined?undefined:Math.floor(xp),
   findNearbyLoc:()=>({id:2478,name:'Altar'}),findPath:()=>({success:true,reachedDestination:true}),
   sendInteractLoc:async()=>{actions.push('exit-body');player.worldX=3050;player.worldZ=3442;return {success:true};}},
  bot:{openBank:async()=>{actions.push('open-bank');st.bank.isOpen=true;generation++;return {success:true};},
   closeBank:async()=>{actions.push('close-bank');st.bank.isOpen=false;return {success:true};},
   withdrawItem:async(item,n)=>{withdrawals.push({id:item.id,n});stored.set(item.id,stored.get(item.id)-n);add(item.id,n);generation++;return {success:true};},
   dismissBlockingUI:async()=>{},interactLoc:craft,
   walkTo:async(x,z)=>{player.worldX=x;player.worldZ=z;return {success:true};}}};
 const modules={
  '../packages/core/src/bot':{openBot:()=>{},finish:()=>{},getWorld:async()=>({}),accountOf:()=>({}),sessionDied:()=>false},
  '../packages/core/src/ticks':{waitUntil:async(_s,p)=>p()},
  '../packages/core/src/walk':{goTo:async(_s,_w,to)=>{player.worldX=to.x;player.worldZ=to.z;return {ok:true};},walkPath:async()=>({ok:true}),sessionWalker:async()=>({})},
  '../packages/core/src/deposit':{depositObserved:deposit},
  '../packages/core/src/world':{interactionApproach:async()=>({})},
  './generated/rcair':{insideAirAltar:p=>p.worldX===2841,enterAirAltar:async()=>{actions.push('enter-air');player.worldX=2841;player.worldZ=4830;},
   exitAirAltar:async()=>{actions.push('exit-air');player.worldX=2983;player.worldZ=3288;},craftAirRunes:async()=>{throw Error('XP-positive training action used for finite production');}}
 };
 for(const [path,module]of Object.entries(modules))mock.module(resolve('scripts',path),()=>module);
 console.log=()=>{};
 const {runRuneBankCraft}=await import('./scripts/rune-bank-craft');
 const result=await runRuneBankCraft(s,99,{altar:config.altar??'air',essenceTarget:config.target??28});
 process.stdout.write(JSON.stringify({result,withdrawals,recipes,actions,bank:Object.fromEntries(stored),held:inventory}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:5000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());
 return JSON.parse(child.stdout.toString());
}

test('RC99 and XP-capped suppliers produce the requested air quantity with a higher altar owned',()=>{
 const r=productionCase();
 expect(r.result).toMatchObject({ok:true,altar:'air',essenceTarget:28,consumed:28,crafted:280,xp:0,xpBalanced:true,bankEssence:12,held:{essence:0,runes:0}});
 expect(r.withdrawals.filter((w:{id:number})=>w.id===1436)).toEqual([{id:1436,n:27},{id:1436,n:1}]);
 expect(r.recipes).toEqual([{altar:'air',n:27},{altar:'air',n:1}]);
 expect(r.bank).toMatchObject({1436:12,1446:1,995:42,556:283,559:7});
 expect(r.held).toEqual([{id:1438,count:1,slot:0}]);
});

test('production uses current Runecraft for the native output multiplier and clips XP to the cap',()=>{
 const r=productionCase({target:2,currentLevel:21,xp:199_999_900});
 expect(r.result).toMatchObject({ok:true,consumed:2,crafted:4,xp:100,xpBalanced:true});
});

test('odd body production accepts both native hidden phases while conserving exact rune output',()=>{
 for(const [phase,gain] of [[0,562],[0.5,563]] as const){
  const r=productionCase({altar:'body',inside:'body',heldEssence:3,target:3,xp:13_034_431+phase});
  expect(r.result).toMatchObject({ok:true,altar:'body',consumed:3,crafted:9,xp:gain,xpBalanced:true});
  expect(r.recipes).toEqual([{altar:'body',n:3}]);
  expect(r.result.ledger.runes[559]).toEqual({before:7,after:16,crafted:9});
 }
});

test('a resumed wrong altar exits with its essence intact and crafts only the requested rune',()=>{
 const r=productionCase({inside:'body',heldEssence:3,target:2});
 expect(r.actions[0]).toBe('exit-body');
 expect(r.recipes).toEqual([{altar:'air',n:2}]);
 expect(r.result).toMatchObject({ok:true,consumed:2,crafted:20,bankEssence:41});
 expect(r.bank[559]).toBe(7);
});

test('oversized resumed essence is banked before an exact production batch',()=>{
 const r=productionCase({inside:'air',heldEssence:5,target:2});
 expect(r.actions[0]).toBe('exit-air');
 expect(r.recipes).toEqual([{altar:'air',n:2}]);
 expect(r.result).toMatchObject({ok:true,consumed:2,bankEssence:43});
});

test('a valid resumed production batch contributes to the aggregate debit and output',()=>{
 const r=productionCase({inside:'air',heldEssence:2,target:2});
 expect(r.recipes).toEqual([{altar:'air',n:2}]);
 expect(r.withdrawals.filter((w:{id:number})=>w.id===1436)).toEqual([]);
 expect(r.result).toMatchObject({ok:true,consumed:2,crafted:20,xpBalanced:true});
 expect(r.result.ledger.runes[556]).toEqual({before:3,after:23,crafted:20});
});

test('insufficient stock or a missing requested talisman cannot pass at RC99 or spend essence',()=>{
 for(const config of [{bankEssence:27},{airTalisman:false}]){
  const r=productionCase(config);
  expect(r.result.ok).toBe(false);expect(r.recipes).toEqual([]);
  expect(r.withdrawals).toEqual([]);
  expect(r.result.failure).toContain('next acquisition:');
 }
});

test('missing XP blocks production before bank actions, and a wrong rate fails the receipt',()=>{
 const unknown=productionCase({xp:null});
 expect(unknown.result.ok).toBe(false);expect(unknown.actions).toEqual([]);expect(unknown.recipes).toEqual([]);
 expect(unknown.result.failure).toContain('entry Runecraft XP');
 const wrongRate=productionCase({target:2,xp:13_034_431,rate:1});
 expect(wrongRate.result.ok).toBe(false);expect(wrongRate.result.failure).toContain('craft debit/credit/XP mismatch');
});
