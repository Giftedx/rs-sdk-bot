import {beforeAll,expect,test} from 'bun:test';
import {loadPathfinding} from '../packages/core/src/pathcache';
import{BotSDK}from'../vendor/rs-sdk/sdk/index';import{BotActions}from'../vendor/rs-sdk/sdk/actions';
import {smeltRecipe,planSmeltLoad,smeltEffect,runSmeltBatch,validateSmeltOrder,smeltOwnedSession,validateSmeltRoute,deriveNearestSmeltRoute} from './smelt-batch';
import {runCannonballs} from './microbot-a-cannonballs';
import {readFileSync} from 'node:fs';
import {setEquipmentObserved} from '../packages/core/src/container-observation';
// initPathfinding() alone takes about 14 s for each process (packages/core/src/pathcache.ts). The snapshot loader makes
// the same grid first, so the call in the test returns at once.
beforeAll(async()=>{await loadPathfinding();},120_000);

test('pinned recipes and short stock produce feasible reserved loads, including mithril',()=>{
 const steel=smeltRecipe('steel');expect(steel.ingredients).toEqual([{id:440,units:1},{id:453,units:2}]);
 expect(planSmeltLoad(steel,[{id:440,count:20},{id:453,count:9}],25,10,{453:1})).toEqual({possible:4,planned:4,targetMet:false});
 const mithril=smeltRecipe('mithril');expect(mithril.product).toBe(2359);expect(mithril.ingredients).toEqual([{id:447,units:1},{id:453,units:4}]);
 expect(planSmeltLoad(steel,[{id:440,count:20}],28,10,{}).planned).toBe(0);
});
test('iron loss is an ore debit, not a bar or XP gain; wrong/missing secondary debits fail',()=>{
 const iron=smeltRecipe('iron'),steel=smeltRecipe('steel');
 expect(smeltEffect(iron,[{id:440,count:2}],[{id:440,count:1}],0,0)).toEqual({kind:'loss',made:0});
 expect(smeltEffect(steel,[{id:440,count:2},{id:453,count:4}],[{id:440,count:1},{id:453,count:2},{id:2353,count:1}],0,100)).toEqual({kind:'made',made:1});
 expect(()=>smeltEffect(steel,[{id:440,count:2},{id:453,count:4}],[{id:440,count:1},{id:453,count:4},{id:2353,count:1}],0,100)).toThrow();
});

function fake(bar='steel',stock=[{id:440,count:3},{id:453,count:6}],losses=0){
 const recipe=smeltRecipe(bar),names:Record<number,string>={2:'Cannonball',4:'Ammo mould',776:'Goldsmith gauntlets',2568:'Ring of forging',1059:'Leather gloves',1635:'Gold ring',444:'Gold ore',2357:'Gold bar',995:'Coins',436:'Copper ore',438:'Tin ore',440:'Iron ore',442:'Silver ore',453:'Coal',2349:'Bronze bar',2353:'Steel bar',2351:'Iron bar',2355:'Silver bar',447:'Mithril ore',2359:'Mithril bar',449:'Adamantite ore',2361:'Adamantite bar',451:'Runite ore',2363:'Runite bar',946:'Knife'};
 let tick=0,generation=1,xp=0,open=false,held:{id:number;name:string;count:number;slot:number}[]=[{id:946,name:'Knife',count:1,slot:0}];
 const messages:{text:string;tick:number;observationId:number}[]=[];
 const bank=stock.map(i=>({...i,name:names[i.id]!})),listeners=new Set<()=>void>();
 const player={worldX:3269,worldZ:3167,level:0,lifeId:1,respawnCount:0};
 const count=(id:number)=>held.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const add=(id:number,n:number)=>{for(let a=0;a<n;a++)held.push({id,name:names[id]!,count:1,slot:held.length});};
 const take=(id:number,n:number)=>{for(let a=0;a<n;a++){const at=held.findIndex(i=>i.id===id);if(at<0)throw Error('mock input short');held.splice(at,1);}held.forEach((v,n)=>v.slot=n);};
 const state=()=>({player,inventory:held,equipment:[],gameMessages:messages,bank:{isOpen:open,items:bank},skills:[{name:'Hitpoints',level:30,baseLevel:30},{name:'Smithing',level:99,baseLevel:99,experience:xp}]});
 const s:any={name:'fixture',client:{selfSlot:1,executeBotAction:()=>({success:true})},direct:async()=>{s.sdk.getDialog=()=>null;return{success:true};},sdk:{getState:state,getInventory:()=>held,getEquipment:()=>[],getDialog:()=>null,getSkill:(k:string)=>state().skills.find(v=>v.name===k),getSkillXp:()=>xp,findNearbyLoc:()=>({id:2781,x:3274,z:3186}),sendUseItemOnLoc:async()=>{
  for(const i of recipe.ingredients)take(i.id,i.units);if(losses>0){losses--;messages.push({text:'The ore is too impure and you fail to refine it.',tick,observationId:messages.length+1});}else{add(recipe.product,1);xp+=100;}return{success:true};
 }},tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},bankObservation:()=>open?{generation,at:Date.now(),items:bank.map(i=>({...i}))}:null,
 bot:{openBank:async()=>{open=true;generation++;return{success:true}},closeBank:async()=>{open=false;return{success:true}},depositItem:async(item:{id:number})=>{const n=count(item.id);take(item.id,n);const row=bank.find(i=>i.id===item.id);if(row)row.count+=n;else bank.push({id:item.id,name:names[item.id]!,count:n});generation++;return{success:true}},withdrawItem:async(item:{id:number},n:number)=>{const row=bank.find(i=>i.id===item.id)!;row.count-=n;add(item.id,n);generation++;return{success:true}}},ended:new Promise(()=>{})};
 const timer=setInterval(()=>{tick++;for(const f of listeners)f();},1);
 return {s,bank,held:()=>held,stop:()=>clearInterval(timer),walk:async(x:number,z:number)=>{player.worldX=x;player.worldZ=z;return true;}};
}

function bonusFake(bar:'iron'|'gold',meltFirst=false){
 const ore=bar==='gold'?444:440,id=bar==='gold'?776:2568,slot=bar==='gold'?9:12;
 const g=fake(bar,[{id:ore,count:4},{id,count:3}]),wear:any[]=[{id:bar==='gold'?1059:1635,count:1,slot}],state=g.s.sdk.getState;
 let rawXp=0,uses=0;const calls:string[]=[];g.s.client.membersAccount=1;setEquipmentObserved(g.s.client,true);g.s.sdk.getStateAge=()=>0;
 g.s.sdk.getState=()=>({...state(),equipment:wear});g.s.sdk.getEquipment=()=>wear;g.s.sdk.getSkillXp=()=>Math.floor(rawXp/10);
 g.s.bot.unequipItem=async(row:any)=>{calls.push('unequip');wear.splice(wear.indexOf(row),1);g.held().push({...row,name:'item'+row.id,slot:g.held().length});return{success:true};};
 g.s.bot.equipItem=async(row:any)=>{calls.push('equip'+row.id);g.held().splice(g.held().indexOf(row),1);wear.push({id:row.id,count:1,slot});return{success:true};};
 const use=g.s.sdk.sendUseItemOnLoc,bank=g.s.bot.openBank;g.s.bot.openBank=async()=>{calls.push('bank');return bank();};
 g.s.sdk.sendUseItemOnLoc=async()=>{calls.push('smelt');uses++;await use();rawXp+=(bar==='gold'&&wear.some(i=>i.id===776)?562:bar==='gold'?225:125)*25;if(meltFirst&&uses===1){const at=wear.findIndex(i=>i.id===2568);if(at>=0){wear.splice(at,1);state().gameMessages.push({type:0,sender:'',fromSelf:false,text:'Your Ring of Forging has melted.',tick:g.s.tick(),observationId:100} as any);}}return{success:true};};
 return{...g,wear,calls,uses:()=>uses};
}
const localRoute={bank:{x:2945,z:3369,level:0},stand:{x:2974,z:3369,level:0},furnace:{id:2781,x:2975,z:3368,level:0}};
const shiloRoute={bank:{x:2852,z:2955,level:0},stand:{x:2856,z:2965,level:0},furnace:{id:2781,x:2856,z:2966,level:0},access:'shilo-furnace' as const,maxEntries:2,coinReserve:37};
function shiloFake(bad='',bar='silver',stock=[{id:442,count:29},{id:995,count:77}]){
 const g=fake(bar,stock),read=g.s.sdk.getState,withdraw=g.s.bot.withdrawItem;
 const dialogs:any[]=[];let page:any=null,choice=0,exits=0,smelts=0;Object.assign(read().player,{worldX:2852,worldZ:2955});
 Object.assign(g.s.client,{membersAccount:1,ingame:true,ifType:()=>({colour:bad==='prereq'?0xff0000:0x00f800})});g.s.sdk.getStateAge=()=>0;
 g.s.sdk.getState=()=>({...read(),recentDialogs:dialogs,nearbyLocs:[{...shiloRoute.furnace,reachable:true,optionsWithIndex:[{text:'Smelt',opIndex:2}]},{id:2266,x:2856,z:2963,level:0,optionsWithIndex:[{text:'Open',opIndex:1}]}]});g.s.sdk.getDialog=()=>page;
 g.s.bot.withdrawItem=async(row:any,n:number)=>{if(row.id!==995)return withdraw(row,n);g.bank.find(r=>r.id===995)!.count-=n;g.held().push({id:995,name:'Coins',count:n,slot:g.held().length});return{success:true};};
 const use=g.s.sdk.sendUseItemOnLoc;g.s.sdk.sendUseItemOnLoc=async()=>{smelts++;return use();};
 g.s.direct=async(a:any)=>{
  if(a.type==='closeModal'){page=null;return{success:true};}
  if(a.type==='interactLoc'&&read().player.worldZ===2964){exits++;if(bad!=='exit')Object.assign(read().player,{worldX:2856,worldZ:2963});return{success:true};}
  if(a.type==='interactLoc'){page={isOpen:true,isWaiting:false,pageId:'choice'+choice,options:[{index:1,text:'Use Furnace - 20 Gold'}]};return{success:true};}
  if(a.type==='clickDialogOption'&&a.optionIndex===1){choice++;if(bad==='unknown')return{success:false};const c=g.held().find(i=>i.id===995)!;c.count-=20;if(!c.count)g.held().splice(g.held().indexOf(c),1);if(bad==='mixed')g.held().push({id:946,name:'Knife',count:1,slot:27});dialogs.push({text:[bad==='terminal'?'Old unrelated page':'Thanks Bwana! Enjoy the facilities!'],tick:g.s.tick(),observationId:choice,interfaceId:1});page={isOpen:true,isWaiting:false,pageId:'thanks'+choice,options:[{index:0,text:'Continue'}]};if(bad==='lost')throw Error('lost reply');return{success:true};}
  if(a.type==='clickDialogOption'&&a.optionIndex===0){page=null;Object.assign(read().player,{worldX:2856,worldZ:2964});return{success:true};}throw Error('unexpected action '+a.type);
 };
 return{...g,choices:()=>choice,exits:()=>exits,smelts:()=>smelts};
}
test('Shilo access makes two finite paid entries and free exits with exact fee reserves',async()=>{const g=shiloFake();try{const r=await runSmeltBatch(g.s,{bar:'silver',maximum:28,reserve:1,mode:'exact',cap:500,route:shiloRoute},{walk:g.walk});expect(r).toMatchObject({ok:true,made:28,banked:28,coinsSpent:40,finalCoins:37,conserved:true,reserveMet:true,shiloEntries:2,deferred:false});expect([g.choices(),g.exits()]).toEqual([2,2]);expect(r.accessReceipts?.map(x=>x.kind)).toEqual(['entry','exit','entry','exit']);}finally{g.stop();}});
test('Shilo paid entry reconciles lost acknowledgement once; known stop exits without another fare',async()=>{for(const mode of ['lost','stop']){const g=shiloFake(mode);try{const r=await runSmeltBatch(g.s,{bar:'silver',maximum:1,reserve:1,mode:'exact',cap:500,route:shiloRoute,stop:()=>mode==='stop'&&g.choices()===1},{walk:g.walk});expect(r).toMatchObject({coinsSpent:20,conserved:true,deferred:false});expect([g.choices(),g.exits()]).toEqual([1,1]);expect(g.smelts()).toBe(mode==='stop'?0:1);}finally{g.stop();}}});
test('Shilo uncertain payment, terminal page, mixed stock or exit never repeats or resumes work',async()=>{for(const bad of ['unknown','terminal','mixed','exit']){const g=shiloFake(bad);try{const r=await runSmeltBatch(g.s,{bar:'silver',maximum:1,reserve:1,mode:'exact',cap:500,route:shiloRoute},{walk:g.walk});expect(r.ok).toBe(false);expect(r.deferred).toBe(true);expect(g.choices()).toBe(1);expect(g.smelts()).toBe(bad==='exit'?1:0);expect(g.exits()).toBe(bad==='exit'?1:0);}finally{g.stop();}}});
test('Shilo missing public completion and invalid entry funding refuse before payment',async()=>{expect(()=>validateSmeltRoute({...shiloRoute,access:undefined})).toThrow();expect(()=>validateSmeltRoute({...shiloRoute,maxEntries:0})).toThrow();for(const bad of ['prereq','stock']){const g=shiloFake(bad);if(bad==='stock')g.bank.find(i=>i.id===995)!.count=76;try{const run=runSmeltBatch(g.s,{bar:'silver',maximum:1,reserve:1,mode:'exact',cap:500,route:shiloRoute},{walk:g.walk});if(bad==='prereq')await expect(run).rejects.toThrow('completed Shilo');else expect((await run).ok).toBe(false);expect(g.choices()).toBe(0);}finally{g.stop();}}});
test('Shilo payment owner replacement sends no terminal continuation, exit, bank or smelt',async()=>{const g=shiloFake(),direct=g.s.direct;let later=0;g.s.direct=async(a:any)=>{if(g.choices())later++;const r=await direct(a);if(g.choices())g.s.client.executeBotAction=()=>{throw Error('foreign');};return r;};Object.defineProperty(g.s.client,'varps',{get(){throw Error('private access state');}});try{const r=await runSmeltBatch(g.s,{bar:'silver',maximum:1,reserve:1,mode:'exact',cap:500,route:shiloRoute},{walk:g.walk});expect(r).toMatchObject({ok:false,deferred:true});expect([g.choices(),g.exits(),g.smelts(),later]).toEqual([1,0,0,0]);}finally{g.stop();}});
test('Shilo finite entry budget returns a known partial result without a further payment',async()=>{const g=shiloFake();try{const r=await runSmeltBatch(g.s,{bar:'silver',maximum:28,reserve:1,mode:'exact',cap:500,route:{...shiloRoute,maxEntries:1}},{walk:g.walk});expect(r).toMatchObject({ok:false,made:26,banked:26,coinsSpent:20,deferred:false,conserved:true});expect([g.choices(),g.exits()]).toEqual([1,1]);}finally{g.stop();}});
test('Shilo Native source binds paid terminal page then inside landing and a free exit',async()=>{const{readFileSync}=await import('node:fs'),source=readFileSync('vendor/rs-sdk/server/content/scripts/areas/area_shilo/scripts/yohnus.rs2','utf8');expect(source.indexOf('inv_del(inv, coins, 20)')).toBeLessThan(source.indexOf('Thanks Bwana! Enjoy the facilities!'));expect(source.indexOf('Thanks Bwana! Enjoy the facilities!')).toBeLessThan(source.indexOf('~forcemove(0_44_46_40_19)'));expect(source).toContain('p_teleport(movecoord(coord, 0, 0, 1))');expect(source.slice(source.indexOf('[oploc1,shilofurnacedoor]'))).toContain('if($entering = false)');expect(source.slice(source.indexOf('[oploc1,shilofurnacedoor]'))).not.toContain('inv_del');});
function localFake(bar='silver',stock=[{id:442,count:29}]){const g=fake(bar,stock),read=g.s.sdk.getState;Object.assign(read().player,{worldX:localRoute.bank.x,worldZ:localRoute.bank.z});g.s.sdk.getState=()=>({...read(),nearbyLocs:[{...localRoute.furnace,name:'Furnace',reachable:true,optionsWithIndex:[{text:'Smelt',opIndex:2}]}]});g.s.sdk.getStateAge=()=>0;return g;}
test('nearest observed ordinary furnace derives exact Native stand and existing indexed bank',async()=>{const g=localFake();Object.assign(g.s.sdk.getState().player,{worldX:2974,worldZ:3369});try{const r=await deriveNearestSmeltRoute(g.s,100,()=>false,{walker:async()=>({plan:(_level,_from,to)=>[{...to}]})});expect(r).toEqual({...localRoute,bank:{x:2947,z:3368,level:0}});expect(g.bank.find(i=>i.id===442)?.count).toBe(29);}finally{g.stop();}});
test('nearest selection enters the actual bounded smelt/refill worker with its fixed route',async()=>{const g=localFake(),visited:number[][]=[];Object.assign(g.s.sdk.getState().player,{worldX:2974,worldZ:3369});try{const r=await runSmeltBatch(g.s,{bar:'silver',cap:500,maximum:28,reserve:1,mode:'exact',nearest:true},{walk:async(x,z)=>{visited.push([x,z]);return g.walk(x,z);},nearest:{walker:async()=>({plan:(_l,_f,to)=>[{...to}]})}});expect(r).toMatchObject({ok:true,made:28,banked:28,coinsSpent:0,route:{bank:{x:2947,z:3368,level:0},furnace:localRoute.furnace}});expect(visited.filter(p=>p[0]===2974)).toHaveLength(2);expect(visited.every(p=>p[0]===2947||p[0]===2974)).toBe(true);}finally{g.stop();}});
test('nearest furnace requires complete outbound AND return paths and skips inaccessible indexed banks',async()=>{for(const bad of ['first','return','all']){const g=localFake();Object.assign(g.s.sdk.getState().player,{worldX:2974,worldZ:3369});const banks=[{x:2947,z:3368,level:0},{x:3013,z:3355,level:0}];try{const run=deriveNearestSmeltRoute(g.s,100,()=>false,{banks,walker:async()=>({plan:(_level,from,to)=>bad==='all'||bad==='first'&&to.x===2947||bad==='return'&&from.x===2974?[{x:to.x+5,z:to.z}]:[{...to}]})});if(bad==='first')expect((await run).bank).toEqual(banks[1]!);else await expect(run).rejects.toThrow('no observed ordinary');}finally{g.stop();}}});
test('nearest furnace refuses scripted Shilo access, absent observed options and beyond20',async()=>{for(const bad of ['shilo','option','far']){const g=localFake(),read=g.s.sdk.getState;Object.assign(read().player,{worldX:bad==='shilo'?2856:bad==='far'?3000:2974,worldZ:bad==='shilo'?2965:3369});g.s.sdk.getState=()=>{const s=read();if(bad==='shilo')s.nearbyLocs[0]={...s.nearbyLocs[0],...shiloRoute.furnace};if(bad==='option')s.nearbyLocs[0].optionsWithIndex=[];return s;};try{await expect(deriveNearestSmeltRoute(g.s,100,()=>false,{walker:async()=>({plan:(_l,_f,to)=>[{...to}]})})).rejects.toThrow('no observed ordinary');}finally{g.stop();}}});
test('nearest async path setup preserves original executor/client/life/HP/stock and refuses stop',async()=>{for(const bad of ['executor','client','life','hp','stock','stop']){const g=localFake();Object.assign(g.s.sdk.getState().player,{worldX:2974,worldZ:3369});let stopped=false,plans=0;try{await expect(deriveNearestSmeltRoute(g.s,100,()=>stopped,{walker:async()=>{if(bad==='executor')g.s.client.executeBotAction=()=>{};if(bad==='client')g.s.client={...g.s.client};if(bad==='life')g.s.sdk.getState().player.lifeId++;if(bad==='hp')g.s.sdk.getSkill=(name:string)=>({name,level:1});if(bad==='stock')g.held().push({id:995,name:'Coins',count:1,slot:1});if(bad==='stop')stopped=true;return{plan:(_l,_f,to)=>{plans++;return[{...to}];}};}})).rejects.toThrow('original observation');expect(plans).toBe(0);}finally{g.stop();}}});
test('declared ordinary local route refills at its own bank and never visits Al Kharid',async()=>{const g=localFake(),visited:number[][]=[];try{const r=await runSmeltBatch(g.s,{bar:'silver',maximum:28,reserve:1,mode:'exact',cap:500,route:localRoute},{walk:async(x,z)=>{visited.push([x,z]);return g.walk(x,z);}});expect(r).toMatchObject({ok:true,made:28,banked:28,entry:'declared-local-furnace',coinsSpent:0,conserved:true});expect(visited.every(([x,z])=>[[2945,3369],[2974,3369]].some(p=>p[0]===x&&p[1]===z))).toBe(true);expect(visited.filter(([x])=>x===2974)).toHaveLength(2);}finally{g.stop();}});
test('declared local bronze uses the existing paired-ore batch engine',async()=>{const g=localFake('bronze',[{id:436,count:16},{id:438,count:16}]);try{const r=await runSmeltBatch(g.s,{bar:'bronze',maximum:15,reserve:1,mode:'exact',cap:500,route:localRoute},{walk:g.walk});expect(r).toMatchObject({ok:true,made:15,banked:15,conserved:true,reserveMet:true});}finally{g.stop();}});
test('wrong observed local furnace or incomplete stand cannot authorize a smelt',async()=>{for(const bad of ['id','option','stand']){const g=localFake(),read=g.s.sdk.getState;let paid=0;g.s.sdk.sendUseItemOnLoc=async()=>{paid++;return{success:true};};g.s.sdk.getState=()=>{const s=read();if(bad==='id')s.nearbyLocs[0].id=2785;if(bad==='option')s.nearbyLocs[0].optionsWithIndex=[];return s;};try{const r=await runSmeltBatch(g.s,{bar:'silver',maximum:1,reserve:1,mode:'exact',cap:500,route:localRoute},{walk:async(x,z)=>g.walk(x,bad==='stand'&&x===2974?z+1:z)});expect(r.ok).toBe(false);expect(paid).toBe(0);}finally{g.stop();}}});
test('local route rejects quest furnaces, cross-plane routes and absent Fremennik completion before staging',async()=>{expect(()=>validateSmeltRoute({...localRoute,furnace:{...localRoute.furnace,id:2783}})).toThrow();expect(()=>validateSmeltRoute({...localRoute,bank:{...localRoute.bank,level:1}})).toThrow();const g=localFake();try{let banks=0;g.s.bot.openBank=async()=>{banks++;return{success:true};};await expect(runSmeltBatch(g.s,{bar:'silver',maximum:1,reserve:1,mode:'exact',cap:500,route:{bank:{x:2645,z:3675,level:0},stand:{x:2619,z:3667,level:0},furnace:{id:4304,x:2616,z:3666,level:0}}},{walk:g.walk})).rejects.toThrow('Fremennik');expect(banks).toBe(0);}finally{g.stop();}});

test('bonus gold stages owned gloves and restores original wear with exact boosted public XP',async()=>{const g=bonusFake('gold');try{const r=await runSmeltBatch(g.s,{bar:'gold',cap:500,maximum:2,reserve:1,mode:'exact',bonusGear:{kind:'goldsmith',xpRate:25}},{walk:g.walk});expect(r).toMatchObject({ok:true,made:2,bonusRawXp:28100,gearRestored:true});expect(g.wear).toEqual([{id:1059,count:1,slot:9}]);expect(g.calls).toContain('equip776');}finally{g.stop();}});
test('unknown remaining forging charges may melt on first Make1; bank replacement precedes next smelt',async()=>{const g=bonusFake('iron',true);try{const r=await runSmeltBatch(g.s,{bar:'iron',cap:500,maximum:2,reserve:1,mode:'exact',bonusGear:{kind:'forging',xpRate:25,maximumRings:2,ringReserve:1}},{walk:g.walk});expect(r).toMatchObject({ok:true,made:2,ringBreaks:1,gearRestored:true,conserved:true});const first=g.calls.indexOf('smelt'),second=g.calls.indexOf('smelt',first+1);expect(g.calls.slice(first+1,second)).toContain('bank');expect(g.calls.slice(first+1,second)).toContain('equip2568');expect(g.wear).toEqual([{id:1635,count:1,slot:12}]);}finally{g.stop();}});
test('finite ring budget banks a known partial result without initiating an unprotected next bar',async()=>{const g=bonusFake('iron',true);try{const r=await runSmeltBatch(g.s,{bar:'iron',cap:500,maximum:2,reserve:1,mode:'exact',bonusGear:{kind:'forging',xpRate:25,maximumRings:1,ringReserve:1}},{walk:g.walk});expect(r).toMatchObject({ok:false,made:1,banked:1,ringBreaks:1,gearRestored:true});expect(g.uses()).toBe(1);}finally{g.stop();}});

test('pre-equipped goldsmith gear receives the Native boost without gear movement',async()=>{const g=bonusFake('gold');g.wear[0].id=776;try{const r=await runSmeltBatch(g.s,{bar:'gold',cap:500,maximum:2,reserve:1,mode:'exact',bonusGear:{kind:'goldsmith',xpRate:25}},{walk:g.walk});expect(r).toMatchObject({ok:true,made:2,bonusRawXp:28100,gearRestored:true});expect(g.calls.filter(x=>x.startsWith('equip')||x==='unequip')).toEqual([]);}finally{g.stop();}});
test('an original worn forging ring can melt and is restored from a protected owned spare',async()=>{const g=bonusFake('iron',true);g.wear[0].id=2568;try{const r=await runSmeltBatch(g.s,{bar:'iron',cap:500,maximum:1,reserve:1,mode:'exact',bonusGear:{kind:'forging',xpRate:25,maximumRings:1,ringReserve:1}},{walk:g.walk});expect(r).toMatchObject({ok:true,made:1,ringBreaks:1,gearRestored:true,conserved:true,reserveMet:true});expect(g.wear).toEqual([{id:2568,count:1,slot:12}]);expect(g.bank.find(i=>i.id===2568)?.count).toBe(2);}finally{g.stop();}});
test('forging melt without fresh system evidence parks after one bar and never banks or retries',async()=>{for(const bad of ['chat','stale','missing']){const g=bonusFake('iron',true),use=g.s.sdk.sendUseItemOnLoc;g.s.sdk.sendUseItemOnLoc=async()=>{const r=await use(),m=g.s.sdk.getState().gameMessages.at(-1);if(bad==='chat')m.type=2;else if(bad==='stale')m.observationId=-1;else g.s.sdk.getState().gameMessages.length=0;return r;};try{const r=await runSmeltBatch(g.s,{bar:'iron',cap:500,maximum:2,reserve:1,mode:'exact',bonusGear:{kind:'forging',xpRate:25,maximumRings:2,ringReserve:1}},{walk:g.walk});expect(r.ok).toBe(false);expect(r.deferred).toBe(true);expect(g.uses()).toBe(1);expect(g.calls.slice(g.calls.indexOf('smelt')+1)).toEqual([]);}finally{g.stop();}}});
test('known stop after a protected bar still banks and restores original gloves',async()=>{const g=bonusFake('gold');try{const r=await runSmeltBatch(g.s,{bar:'gold',cap:500,maximum:2,reserve:1,mode:'exact',stop:()=>g.uses()>0,bonusGear:{kind:'goldsmith',xpRate:25}},{walk:g.walk});expect(r).toMatchObject({ok:false,made:1,banked:1,gearRestored:true,conserved:true});expect(g.wear).toEqual([{id:1059,count:1,slot:9}]);expect(g.uses()).toBe(1);}finally{g.stop();}});
test('bonus no-effect and foreign whole-pack changes are uncertain, with no repeated paid call',async()=>{for(const bad of ['none','pack']){const g=bonusFake('gold'),use=g.s.sdk.sendUseItemOnLoc;let calls=0;g.s.sdk.sendUseItemOnLoc=async()=>{calls++;if(bad==='none')return{success:true};const reply=await use();g.held().push({id:995,name:'Coins',count:1,slot:27});return reply;};try{const r=await runSmeltBatch(g.s,{bar:'gold',cap:500,maximum:2,reserve:1,mode:'exact',bonusGear:{kind:'goldsmith',xpRate:25}},{walk:g.walk});expect(r).toMatchObject({ok:false,deferred:true});expect(calls).toBe(1);}finally{g.stop();}}});
test('forging reserves and original-ring replacement are funded before any furnace input without reading private charges',async()=>{for(const worn of [false,true]){const g=bonusFake('iron',true);g.bank.find(i=>i.id===2568)!.count=1;if(worn)g.wear[0].id=2568;Object.defineProperty(g.s.client,'varps',{get(){throw Error('private charge read');}});try{const r=await runSmeltBatch(g.s,{bar:'iron',cap:500,maximum:1,reserve:1,mode:'exact',bonusGear:{kind:'forging',xpRate:25,maximumRings:1,ringReserve:1}},{walk:g.walk});expect(r).toMatchObject({ok:false,made:0,ringsUsed:0,gearRestored:true,conserved:true});expect(g.uses()).toBe(0);}finally{g.stop();}}});
test('bonus gear ownership loss after equip dispatch sends no bank, smelt or restoration into a replacement executor',async()=>{const g=bonusFake('gold'),equip=g.s.bot.equipItem;g.s.bot.equipItem=async(row:any)=>{const r=await equip(row);g.s.client.executeBotAction=()=>{throw Error('foreign input');};return r;};try{const r=await runSmeltBatch(g.s,{bar:'gold',cap:500,maximum:1,reserve:1,mode:'exact',bonusGear:{kind:'goldsmith',xpRate:25}},{walk:g.walk});expect(r.ok).toBe(false);expect(g.uses()).toBe(0);expect(g.calls.slice(g.calls.indexOf('equip776')+1)).toEqual([]);}finally{g.stop();}});
test('Native ore-on-furnace uses Make1 and forging charge loss belongs to the same successful bar',async()=>{const{readFileSync}=await import('node:fs'),smelt=readFileSync('vendor/rs-sdk/server/content/scripts/skill_smithing/scripts/smelting/smelting.rs2','utf8'),ring=readFileSync('vendor/rs-sdk/server/content/scripts/general/scripts/enchanted_jewellry/ring_of_forging.rs2','utf8');expect(smelt).toContain('smelt_ore_weakqueue($bar, 1, 2)');expect(smelt.indexOf('~lose_charge_ring_of_forging')).toBeLessThan(smelt.indexOf('inv_add(inv, $product, 1)'));expect(ring).toContain('Your Ring of Forging has melted.');expect(ring).toContain('inv_del(worn, ring_of_forging, 1)');});

test('a level-up continue yields to incoming ticks before another furnace action',async()=>{
 const g=fake(),use=g.s.sdk.sendUseItemOnLoc;let dialog=false,clicked=false,clicks=0,waitingTicks=0;
 g.s.sdk.sendUseItemOnLoc=async()=>{const r=await use();dialog=true;return r;};
 g.s.sdk.getDialog=()=>dialog?{isOpen:true,isWaiting:clicked,options:[{index:0,text:'Click here to continue'}]}:null;
 g.s.sdk.sendClickDialog=async()=>{if(clicked)throw Error('dialog clicked twice before incoming tick');clicked=true;clicks++;return{success:true};};
 const off=g.s.onTick(()=>{if(clicked&&++waitingTicks>=2){dialog=false;clicked=false;waitingTicks=0;}});
 try{const r=await runSmeltBatch(g.s,{bar:'steel',cap:200,maximum:3,reserve:0,mode:'exact'},{walk:g.walk});expect(r).toMatchObject({ok:true,made:3,banked:3});expect(clicks).toBe(2);}finally{off();g.stop();}
});

test('Varrock entry pays the observed toll and includes travel in asset reconciliation',async()=>{
 const g=fake('iron',[{id:440,count:30},{id:995,count:24}],2);
 const p=g.s.sdk.getState().player;p.worldX=3252;p.worldZ=3420;
 let dialog=false,paid=false;
 g.s.sdk.getNearbyNpcs=()=>[{id:925,index:1,distance:1}];
 g.s.sdk.sendInteractNpc=async()=>{dialog=true;return{success:true};};
 g.s.sdk.getDialog=()=>dialog?{isOpen:true,isWaiting:false,options:[{text:'Yes, ok.',index:3}]}:null;
 g.s.sdk.clickDialogByText=async()=>{const coins=g.held().filter(i=>i.id===995);expect(coins.length).toBe(10);for(const coin of coins)g.held().splice(g.held().indexOf(coin),1);dialog=false;paid=true;p.worldX=3268;p.worldZ=3227;return{success:true};};
 const points:number[][]=[],retries:number[][]=[];let first=true;
 try{const r=await runSmeltBatch(g.s,{bar:'iron',cap:500,maximum:6,reserve:1,mode:'exact'},{walk:async(x,z)=>{points.push([x,z]);if(first){first=false;throw Error('transient corridor plan');}return g.walk(x,z);},recover:async(x,z)=>{retries.push([x,z]);return g.walk(x,z);}});
  expect(r).toMatchObject({ok:true,made:6,banked:6,consumedOre:8,losses:2,coinsSpent:10,initialCoins:24,finalCoins:14,conserved:true,entry:'varrock-east-toll'});
  expect(paid).toBe(true);expect(points).toContainEqual([3308,3370]);expect(points).toContainEqual([3266,3227]);
  expect(retries).toEqual([[3290,3404]]);
 }finally{g.stop();}
});

test('a failed entry point retries once from observed position, then retreats with coins accounted',async()=>{
 const g=fake('iron',[{id:440,count:30},{id:995,count:24}]);
 const p=g.s.sdk.getState().player;p.worldX=3252;p.worldZ=3420;
 const recovered:number[][]=[];let calls=0;
 try{
  const r=await runSmeltBatch(g.s,{bar:'iron',cap:500,maximum:6,reserve:1,mode:'exact'},{
   walk:async(x,z)=>{calls++;if(calls===1)return g.walk(x,z);return false;},
   recover:async(x:number,z:number)=>{recovered.push([x,z]);return recovered.length===1?false:g.walk(x,z);},
  });
  expect(recovered[0]).toEqual([3308,3404]);
  expect(recovered.at(-1)).toEqual([3252,3420]);
  expect(r).toMatchObject({ok:false,attempts:0,initialCoins:24,finalCoins:24,coinsSpent:0,conserved:true});
  expect(r.failure).toContain('entry corridor incomplete');
  expect(p).toMatchObject({worldX:3252,worldZ:3420});
 }finally{g.stop();}
});

test('entry failure without a final bank still retains the observed bank coins in the ledger',async()=>{
 const g=fake('iron',[{id:440,count:30},{id:995,count:24}]);
 const p=g.s.sdk.getState().player;p.worldX=3252;p.worldZ=3420;
 try{
  const r=await runSmeltBatch(g.s,{bar:'iron',cap:500,maximum:6,reserve:1,mode:'exact'},{walk:async()=>{p.worldX=3290;p.worldZ=3404;return false;},recover:async()=>false});
  expect(g.s.bankObservation()).toBeNull();
  expect(r).toMatchObject({ok:false,attempts:0,banked:null,initialCoins:24,finalCoins:24,coinsSpent:0,conserved:true});
 }finally{g.stop();}
});

test('every worker leg plans to within one tile on the pinned collision map, outside the spiders reach',async()=>{
 const pf:any=await import('../vendor/rs-sdk/sdk/pathfinding'),{smeltEntryRoute,SPIDER_REACH:r}=await import('../packages/planner/src/travel');
 pf.initPathfinding();
 const d8=(a:{x:number;z:number},b:{x:number;z:number})=>Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z));
 const tiles=(a:number[][])=>a.map(([x,z])=>({x:x!,z:z!}));
 const exposed=(t:{x:number;z:number})=>t.x>=r.minX-r.huntRange&&t.x<=r.maxX+r.huntRange&&t.z>=r.minZ-r.huntRange&&t.z<=r.maxZ+r.huntRange;
 const chains=[
  [{x:3252,z:3420},...smeltEntryRoute({worldX:3252,worldZ:3420,level:0}).points],
  tiles([[3268,3227],[3272,3227],[3275,3212],[3273,3194],[3269,3167],[3274,3186],[3269,3167]]),
  tiles([[3269,3167],[3269,3167]]),
 ];
 const walked:{x:number;z:number}[]=[];
 for(const chain of chains){let at=chain[0]!;for(const goal of chain.slice(1)){
  const path:{x:number;z:number}[]=pf.findLongPath(0,at.x,at.z,goal.x,goal.z,500),end=path.at(-1)??at;
  // Corners are joined by straight or diagonal steps.
  for(const c of path){const n=d8(at,c);for(let k=1;k<=n;k++)walked.push({x:at.x+Math.sign(c.x-at.x)*k,z:at.z+Math.sign(c.z-at.z)*k});at={x:c.x,z:c.z};}
  expect({goal,near:d8(end,goal)<=1}).toEqual({goal,near:true});at={x:end.x,z:end.z};
 }}
 expect(walked.length).toBeGreaterThan(100);expect(walked.filter(exposed)).toEqual([]);
},60000);

test('a failed walk east of the paid gate banks at Al Kharid instead of paying to retreat west',async()=>{
 const g=fake('iron',[{id:440,count:30},{id:995,count:24}]);
 const p=g.s.sdk.getState().player;p.worldX=3252;p.worldZ=3420;
 let dialog=false;
 g.s.sdk.getNearbyNpcs=()=>[{id:925,index:1,distance:1}];
 g.s.sdk.sendInteractNpc=async()=>{dialog=true;return{success:true};};
 g.s.sdk.getDialog=()=>dialog?{isOpen:true,isWaiting:false,options:[{text:'Yes, ok.',index:3}]}:null;
 g.s.sdk.clickDialogByText=async()=>{for(const coin of g.held().filter(i=>i.id===995))g.held().splice(g.held().indexOf(coin),1);dialog=false;p.worldX=3268;p.worldZ=3227;return{success:true};};
 const walks:number[][]=[],recovered:number[][]=[];
 try{const r=await runSmeltBatch(g.s,{bar:'iron',cap:500,maximum:6,reserve:1,mode:'exact'},{
   walk:async(x,z)=>{walks.push([x,z]);return x===3272&&z===3227?false:g.walk(x,z);},
   recover:async(x,z)=>{recovered.push([x,z]);return g.walk(x,z);}});
  expect(r).toMatchObject({ok:false,made:0,attempts:0,banked:0,coinsSpent:10,initialCoins:24,finalCoins:14,conserved:true});
  expect(r.failure).toContain('destination corridor incomplete');expect(r.failure).not.toContain('final bank');
  expect(recovered).toEqual([]);expect(walks.at(-1)).toEqual([3269,3167]);expect(p).toMatchObject({worldX:3269,worldZ:3167});
  expect(g.bank.find(i=>i.id===995)?.count).toBe(14);expect(g.bank.find(i=>i.id===440)?.count).toBe(30);
 }finally{g.stop();}
});

test('limited iron keeps reserve and banks partial output without an exact pass',async()=>{
 const g=fake('iron',[{id:440,count:3}],1);try{
  expect(await runSmeltBatch(g.s,{bar:'iron',cap:200,maximum:6,reserve:1,mode:'exact'},{walk:g.walk})).toMatchObject({ok:false,made:1,banked:1,losses:1,consumedOre:2,reserveMet:true,conserved:true});
 }finally{g.stop();}
});

test('an interrupted batch returns unspent ore and output to bank',async()=>{
 const g=fake('iron',[{id:440,count:30}]);let stopped=false;const use=g.s.sdk.sendUseItemOnLoc;
 g.s.sdk.sendUseItemOnLoc=async()=>{const r=await use();stopped=true;return r;};
 try{expect(await runSmeltBatch(g.s,{bar:'iron',cap:200,maximum:6,reserve:1,mode:'exact',stop:()=>stopped},{walk:g.walk})).toMatchObject({ok:false,made:1,banked:1,conserved:true,reserveMet:true});expect(g.held().map(i=>i.id)).toEqual([946]);}finally{g.stop();}
});

test('unfunded entry fails at the observed starting bank before travel or smelting',async()=>{
 const g=fake('iron',[{id:440,count:30}]),p=g.s.sdk.getState().player;p.worldX=3252;p.worldZ=3420;
 let walks=0;
 try{const r=await runSmeltBatch(g.s,{bar:'iron',cap:200,maximum:6,reserve:1,mode:'exact'},{walk:async()=>{walks++;return true;}});
  expect(r.ok).toBe(false);expect(r.failure).toContain('10 coins');expect(r.attempts).toBe(0);expect(walks).toBe(0);expect(r.conserved).toBe(true);
 }finally{g.stop();}
});

test('successful travel acknowledgement without arrival cannot dispatch furnace work',async()=>{
 const g=fake('iron',[{id:440,count:30}]);
 try{const r=await runSmeltBatch(g.s,{bar:'iron',cap:200,maximum:6,reserve:1,mode:'exact'},{walk:async()=>true});
  expect(r.ok).toBe(false);expect(r.attempts).toBe(0);expect(r.failure).toContain('furnace route incomplete');expect(g.held().map(i=>i.id)).toEqual([946]);expect(r.conserved).toBe(true);
 }finally{g.stop();}
});
test('real worker banks a partial feasible steel batch and leaves protected kit/reserves intact',async()=>{
 const g=fake();try{const r=await runSmeltBatch(g.s,{bar:'steel',cap:200,maximum:4,reserve:0,mode:'best-effort'},{walk:g.walk});expect(r).toMatchObject({ok:true,made:3,banked:3,consumedOre:3,losses:0,stop:'depleted',preserved:true,conserved:true});expect(g.held().map(i=>i.id)).toEqual([946]);}finally{g.stop();}
});
test('iron impurity losses cannot manufacture target completion',async()=>{
 const g=fake('iron',[{id:440,count:3}],2);try{const r=await runSmeltBatch(g.s,{bar:'iron',cap:200,maximum:3,reserve:0,mode:'exact'},{walk:g.walk});expect(r).toMatchObject({ok:false,made:1,banked:1,consumedOre:3,losses:2,stop:'depleted',conserved:true});}finally{g.stop();}
});
test('mithril reaches the real worker recipe path instead of an empty withdrawal branch',async()=>{
 const g=fake('mithril',[{id:447,count:3},{id:453,count:9}]);try{
  const r=await runSmeltBatch(g.s,{bar:'mithril',cap:200,maximum:2,reserve:1,mode:'exact'},{walk:g.walk});
  expect(r).toMatchObject({ok:true,made:2,banked:2,consumedOre:2,stop:'target',reserveMet:true,conserved:true});
  expect(g.bank.find(i=>i.id===453)?.count).toBe(1);
 }finally{g.stop();}
});
test('missing secondary stock stops before furnace input; unready bank is not depletion',async()=>{
 const g=fake('steel',[{id:440,count:5}]);try{
  expect(await runSmeltBatch(g.s,{bar:'steel',cap:200,maximum:2,reserve:0,mode:'best-effort'},{walk:g.walk})).toMatchObject({ok:false,attempts:0,made:0,stop:'depleted',conserved:true});
 }finally{g.stop();}
 const unready=fake();unready.s.bankObservation=()=>null;try{
  const r=await runSmeltBatch(unready.s,{bar:'steel',cap:200,maximum:2,reserve:0,mode:'best-effort'},{walk:unready.walk});
  expect(r.ok).toBe(false);expect(r.failure).toContain('observation unready');expect(r.stop).not.toBe('depleted');
 }finally{unready.stop();}
});
test('accepted no-effect furnace calls stop after three attempts and return all held inputs',async()=>{
 const g=fake();g.s.sdk.sendUseItemOnLoc=async()=>({success:true});try{
  const r=await runSmeltBatch(g.s,{bar:'steel',cap:200,maximum:2,reserve:0,mode:'best-effort'},{walk:g.walk});
  expect(r).toMatchObject({ok:false,attempts:3,made:0,banked:0,preserved:true,conserved:true});expect(r.failure).toContain('bounded attempts');expect(g.held().map(i=>i.id)).toEqual([946]);
 }finally{g.stop();}
});
test('false-success withdrawal cannot start work and its earlier inputs return to bank',async()=>{
 const g=fake(),withdraw=g.s.bot.withdrawItem;g.s.bot.withdrawItem=async(i:{id:number},n:number)=>i.id===453?{success:true}:withdraw(i,n);
 try{const r=await runSmeltBatch(g.s,{bar:'steel',cap:200,maximum:2,reserve:0,mode:'best-effort'},{walk:g.walk});expect(r).toMatchObject({ok:false,attempts:0,conserved:true,preserved:true});expect(r.failure).toContain('withdrawal unobserved 453');expect(g.held().map(i=>i.id)).toEqual([946]);}finally{g.stop();}
});

test('all eight ordinary native smelts use their pinned product, level and ingredient ratios',()=>{
 for(const [bar,product,level,ingredients] of [
  ['bronze',2349,1,[{id:436,units:1},{id:438,units:1}]],
  ['silver',2355,20,[{id:442,units:1}]],
  ['adamantite',2361,70,[{id:449,units:1},{id:453,units:6}]],
  ['runite',2363,85,[{id:451,units:1},{id:453,units:8}]],
 ] as const)expect(smeltRecipe(bar)).toEqual({product,level,ingredients:[...ingredients],iron:false});
 expect(()=>smeltRecipe('blurite')).toThrow('unsupported smelt recipe');
 expect(()=>smeltRecipe('perfect_gold')).toThrow('unsupported smelt recipe');
});

test('new native metal orders refill across capacity-limited batches and preserve kit and reserves',async()=>{
 for(const [bar,ore,product,target,coal] of [['silver',442,2355,28,0],['adamantite',449,2361,6,6],['runite',451,2363,5,8],['bronze',436,2349,15,0]] as const){
  const stock=[{id:ore,count:target+1},...(coal?[{id:453,count:target*coal+1}]:[]),...(bar==='bronze'?[{id:438,count:target+1}]:[])];
  const g=fake(bar,stock),withdrawals:{id:number;count:number}[]=[],withdraw=g.s.bot.withdrawItem;
  g.s.bot.withdrawItem=async(item:{id:number},count:number)=>{withdrawals.push({id:item.id,count});return withdraw(item,count);};
  try{
   const r=await runSmeltBatch(g.s,{bar,cap:500,maximum:target,reserve:1,mode:'exact'},{walk:g.walk});
   expect(r).toMatchObject({ok:true,made:target,banked:target,consumedOre:target,losses:0,preserved:true,reserveMet:true,conserved:true,stop:'target'});
   expect(g.bank.find(i=>i.id===ore)?.count).toBe(1);expect(g.bank.find(i=>i.id===product)?.count).toBe(target);expect(g.held().map(i=>i.id)).toEqual([946]);
   expect(withdrawals.filter(i=>i.id===ore).length).toBeGreaterThan(1);
   if(coal)expect(g.bank.find(i=>i.id===453)?.count).toBe(1);
   if(bar==='runite')expect(withdrawals).toEqual([{id:451,count:3},{id:453,count:24},{id:451,count:2},{id:453,count:16}]);
  }finally{g.stop();}
 }
});

test('a runite order cannot consume its reserved eighth coal or use short secondary stock',async()=>{
 const r=smeltRecipe('runite');expect(planSmeltLoad(r,[{id:451,count:2},{id:453,count:8}],27,1,{453:1}).planned).toBe(0);
 const g=fake('runite',[{id:451,count:2},{id:453,count:8}]);try{
  expect(await runSmeltBatch(g.s,{bar:'runite',cap:100,maximum:1,reserve:1,mode:'exact'},{walk:g.walk})).toMatchObject({ok:false,attempts:0,made:0,conserved:true,reserveMet:true});
 }finally{g.stop();}
});

test('smelt order admission validates recipe and finite bounds without a session',()=>{
 const order={bar:'silver',cap:200,maximum:2,reserve:1,mode:'exact' as const};
 expect(validateSmeltOrder(order).product).toBe(2355);
 for(const change of [{bar:'blurite'},{maximum:0},{cap:NaN},{reserve:-1},{mode:'forever'}])expect(()=>validateSmeltOrder({...order,...change} as any)).toThrow();
});


test('same mutable player life or respawn changes after first paid bar prevent every later bank or furnace input',async()=>{
 for(const field of ['lifeId','respawnCount']){const g=fake(),player=g.s.sdk.getState().player,use=g.s.sdk.sendUseItemOnLoc;let furnaces=0,withdrawals=0,banks=0;const withdraw=g.s.bot.withdrawItem,open=g.s.bot.openBank;g.s.bot.withdrawItem=async(...args:any[])=>{withdrawals++;return withdraw(...args);};g.s.bot.openBank=async()=>{banks++;return open();};g.s.sdk.sendUseItemOnLoc=async()=>{furnaces++;const result=await use();player[field]++;return result;};try{const result=await runSmeltBatch(g.s,{bar:'steel',cap:100,maximum:3,reserve:0,mode:'exact'},{walk:g.walk});expect(result.ok).toBe(false);expect(g.s.sdk.getState().player).toBe(player);expect(furnaces).toBe(1);expect(withdrawals).toBe(2);expect(banks).toBe(1);}finally{g.stop();}}
});

test('ownership is pinned before initial readiness await and prevents first bank input',async()=>{
 const g=fake();let banks=0;g.s.bot.openBank=async()=>{banks++;return{success:true};};queueMicrotask(()=>{g.s.client.executeBotAction=()=>({success:true});});try{await expect(runSmeltBatch(g.s,{bar:'steel',cap:100,maximum:1,reserve:0,mode:'exact'},{walk:g.walk})).rejects.toThrow('entry');expect(banks).toBe(0);}finally{g.stop();}
});


test('real SDK reconnect and actual BotActions dismissal recheck smelter ownership before paid sends',async()=>{
 const g=fake();try{let wires=0;const sdk:any=new BotSDK({botUsername:'fixture',actionTimeout:20});Object.assign(sdk,{getState:g.s.sdk.getState,getInventory:g.s.sdk.getInventory,getSkill:g.s.sdk.getSkill});sdk.connectionState='reconnecting';sdk.ws={readyState:WebSocket.OPEN,send:()=>{wires++;}};sdk.waitForConnection=async()=>{await Promise.resolve();g.s.client.executeBotAction=()=>({success:true});sdk.connectionState='connected';};g.s.sdk=sdk;const owner=smeltOwnedSession(g.s);expect((await owner.session.sdk.sendUseItemOnLoc(0,3274,3186,2781)).success).toBe(false);expect(wires).toBe(0);}finally{g.stop();}
 const f=fake();try{let paid=0,closed=0,modal=true;const read=f.s.sdk.getState;f.s.sdk.getState=()=>({...read(),dialog:{isOpen:false,options:[]},interface:{isOpen:modal,interfaceId:1005},shop:{isOpen:false},ge:{isOpen:false}});Object.assign(f.held()[0]!,{optionsWithIndex:[{text:'Wield',opIndex:2}]});f.s.sdk.sendCloseModal=async()=>{closed++;modal=false;return{success:true};};f.s.sdk.waitForStateChange=async()=>{await Promise.resolve();f.s.client.executeBotAction=()=>({success:true});};f.s.sdk.findInventoryItem=()=>f.held()[0];f.s.sdk.sendUseItem=async()=>{paid++;return{success:true};};f.s.bot=new BotActions(f.s.sdk);const owner=smeltOwnedSession(f.s);await expect(owner.session.bot.equipItem(/^knife$/i)).rejects.toThrow('original');expect(closed).toBe(1);expect(paid).toBe(0);}finally{f.stop();}
});

function cannonFake(shilo=false,bad='',rate=25){
 const stock=[{id:2353,count:29},{id:4,count:1},{id:995,count:shilo?77:37}],g=shilo?shiloFake('', 'cannonballs',stock):fake('cannonballs',stock),read=g.s.sdk.getState;
 let raw=0,paid=0,loads:number[]=[],afterUnknownInputs=0;g.s.client.membersAccount=1;setEquipmentObserved(g.s.client,true);g.s.sdk.getStateAge=()=>0;
 g.s.sdk.getSkillXp=(name:string)=>name==='Smithing'?Math.floor(raw/10):0;
 g.s.sdk.getState=()=>{const state=read();return{...state,skills:state.skills.map((k:any)=>k.name==='Smithing'?{...k,experience:Math.floor(raw/10)}:k)};};
 const withdraw=g.s.bot.withdrawItem,deposit=g.s.bot.depositItem;g.s.bot.withdrawItem=async(row:any,n:number)=>{if(row.id===2353)loads.push(n);return withdraw(row,n);};
 g.s.sdk.sendUseItemOnLoc=async()=>{paid++;const begun=g.s.tick();let applied=false;const off=g.s.onTick(()=>{if(!applied&&g.s.tick()-begun>=9){applied=true;const inv=g.held(),bar=inv.findIndex(i=>i.id===2353);inv.splice(bar,1);const balls=inv.find(i=>i.id===2);if(balls)balls.count+=4;else inv.push({id:2,name:'Cannonball',count:4,slot:inv.length});inv.forEach((i,n)=>i.slot=n);raw+=375*rate;if(bad==='stock')inv.push({id:995,name:'Coins',count:1,slot:27});if(bad==='xp')raw+=20;if(bad!=='terminal')read().gameMessages.push({type:0,sender:'',fromSelf:false,text:'You remove the cannonballs from the mould.',tick:g.s.tick(),observationId:paid}as any);off();}});return{success:true};};
 // This fake models stack-aware deposits, including four cannonballs per operation.
 g.s.bot.depositItem=async(row:any)=>{if(paid&&bad==='terminal')afterUnknownInputs++;const rows=g.held(),amount=rows.filter(i=>i.id===row.id).reduce((n,i)=>n+i.count,0);for(let i=rows.length-1;i>=0;i--)if(rows[i]!.id===row.id)rows.splice(i,1);for(let n=0;n<amount;n++)rows.push({id:row.id,name:row.name,count:1,slot:rows.length});return deposit(row);};
 return{...g,paid:()=>paid,loads:()=>loads,raw:()=>raw,afterUnknownInputs:()=>afterUnknownInputs};
}
test('cannon Native source binds one steel, reusable mould, four products and375 raw XP without quest-stage requirement',()=>{
 const native=readFileSync('vendor/rs-sdk/server/content/scripts/skill_smithing/scripts/smelting/cannonballs.rs2','utf8');
 for(const text of['map_members','stat(smithing) < 35','inv_total(inv, ammo_mould) < 1','p_delay(4)','p_delay(0)','p_delay(2)','inv_del(inv, steel_bar, 1)','inv_add(inv, mcannonball, 4)','stat_advance(smithing, 375)'])expect(native).toContain(text);
 expect(native).not.toContain('%mcannon');expect(smeltRecipe('cannonballs')).toMatchObject({product:2,productUnits:4,tools:[4],receiptTicks:24,rawXp:375});
 for(const bar of['bronze','iron','silver','steel','gold','mithril','adamantite','runite'])expect(smeltRecipe(bar).productUnits).toBeUndefined();
});
test('actual cannon adapter refills28 steel as two loads and restores a bank-owned mould with exact fractional XP',async()=>{const g=cannonFake();try{const r=await runCannonballs(g.s,{bars:28,cap:1000,reserve:1,xpRate:25},{walk:g.walk});expect(r).toMatchObject({ok:true,bars:28,balls:112,banked:112,consumedOre:28,cannonRawXp:262500,conserved:true,reserveMet:true,gearRestored:true,deferred:false});expect(g.loads()).toEqual([26,2]);expect(g.paid()).toBe(28);expect(g.bank.find(i=>i.id===4)?.count).toBe(1);expect(g.held().map(i=>i.id)).toEqual([946]);expect(r.cannonReceipts).toHaveLength(28);}finally{g.stop();}});
test('actual cannon adapter preserves default three-bar Al Kharid rate1 and an originally held mould',async()=>{const g=cannonFake(false,'',1);g.bank.find(i=>i.id===4)!.count=0;g.held().push({id:4,name:'Ammo mould',count:1,slot:1});try{const r=await runCannonballs(g.s,{bars:3,cap:200},{walk:g.walk});expect(r).toMatchObject({ok:true,bars:3,balls:12,banked:12,cannonRawXp:1125,xp:112,gearRestored:true});expect(g.held().some(i=>i.id===4)).toBe(true);expect(g.paid()).toBe(3);}finally{g.stop();}});
test('cannon missing member/level/mould and unknown terminal/XP/stock never start another paid input',async()=>{for(const bad of['member','level','mould','terminal','xp','stock']){const g=cannonFake(false,bad);if(bad==='member')g.s.client.membersAccount=0;if(bad==='level'){const skill=g.s.sdk.getSkill;g.s.sdk.getSkill=(k:string)=>k==='Smithing'?{level:34,baseLevel:99}:skill(k);}if(bad==='mould')g.bank.find(i=>i.id===4)!.count=0;try{const run=runCannonballs(g.s,{bars:2,cap:200,xpRate:25},{walk:g.walk});if(['member','level'].includes(bad))await expect(run).rejects.toThrow('Smithing35');else{const r=await run;expect(r.ok).toBe(false);if(bad!=='mould')expect(r.deferred).toBe(true);}expect(g.paid()).toBe(['member','level','mould'].includes(bad)?0:1);expect(g.afterUnknownInputs()).toBe(0);}finally{g.stop();}}});
test('cannon Shilo composes existing two paid entries and free exits with112 balls and40coin debit',async()=>{const g=cannonFake(true);try{const r=await runCannonballs(g.s,{bars:28,cap:1000,xpRate:25,reserve:1,route:shiloRoute},{walk:g.walk});expect(r).toMatchObject({ok:true,bars:28,balls:112,banked:112,coinsSpent:40,shiloEntries:2,finalCoins:37,cannonRawXp:262500,conserved:true,gearRestored:true});expect(g.loads()).toEqual([25,3]);expect(r.accessReceipts?.map(x=>x.kind)).toEqual(['entry','exit','entry','exit']);}finally{g.stop();}});
