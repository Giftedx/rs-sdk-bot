import {test,expect} from 'bun:test';
import {CHOMPY_TRIP,chompyEnergyUpkeep,chompyEnergyOption,drinkChompyEnergy,chompyRouteJob,chompyTripAssets,runChompyTrip,restoreChompyStyle,chompyPrayerReserve,chompyProtection,waitChompyPressure,drinkChompyPrayer,chompyReturnHandoff,chompyLocalReturn} from './microbot-chompy-trip';
test('Chompy route reserves return time and keeps batches within native hunter limits',()=>{
 expect(chompyRouteJob({kills:2,perTrip:1,cap:5000,returnTicks:800,protectMelee:true,prayerPotions:2})).toMatchObject({family:'chompy',target:2,batch:1,members:true});
 expect(()=>chompyRouteJob({kills:2,perTrip:6,cap:5000,returnTicks:800,protectMelee:true,prayerPotions:2})).toThrow();expect(()=>chompyRouteJob({kills:2,perTrip:1,cap:800,returnTicks:800,protectMelee:true,prayerPotions:2})).toThrow();
});
test('Chompy asset audit accounts for gas refill, bait charges, raw meat, feathers and net arrows',()=>{
 const before=new Map([[2871,1],[2883,1],[2866,32],[995,42]]),after=new Map([[2873,1],[2883,1],[2866,31],[2876,1],[314,10],[995,42]]),r={kills:1,baits:1,raw:1,feathers:10,rangedXp:40};
 expect(chompyTripAssets(before,after,r)).toEqual({ammoUsed:1,baits:1,fills:1,raw:1,feathers:10,rangedXp:40});
 for(const [id,n]of [[2873,2],[995,41],[2876,0],[314,30],[2866,33]]){const wrong=new Map(after);wrong.set(id!,n!);expect(()=>chompyTripAssets(before,wrong,r)).toThrow('reconcile');}
 expect(()=>chompyTripAssets(before,after,{...r,rangedXp:39})).toThrow('reconcile');
});
test('a partly used bellows is preserved rather than requiring a new empty pair each bank trip',()=>{
 const before=new Map([[2873,1],[2883,1],[2866,32]]),after=new Map([[2874,1],[2883,1],[2866,32],[CHOMPY_TRIP.raw,1],[314,29]]);
 expect(chompyTripAssets(before,after,{kills:1,baits:1,raw:1,feathers:29,rangedXp:40})).toMatchObject({ammoUsed:0,fills:0});
});

test('Chompy adapter rejects unknown retaliation before withdrawing any bank kit',async()=>{
 const s:any={tick:()=>0,client:{ingame:true,ifType:()=>({colour:0x00f800})},sdk:{getState:()=>({player:{name:'Owned',worldX:2613,worldZ:3092,level:0,lifeId:1}}),getSkill:()=>({level:99,baseLevel:99}),getInventory:()=>[],getEquipment:()=>[]}};
 await expect(runChompyTrip(s,{kills:2,perTrip:1,cap:5000,returnTicks:800,protectMelee:true,prayerPotions:2})).rejects.toThrow('auto-retaliate unknown');
});

test('after bank kit removal Chompy restores the original defensive unarmed style with observed acknowledgement',async()=>{
 const combatStyle={known:true,weaponName:'Unarmed',currentStyle:0,styles:[{index:0},{index:1},{index:2}]},sent:number[]=[];const s:any={sdk:{getState:()=>({combatStyle}),sendSetCombatStyle:async(index:number)=>{sent.push(index);combatStyle.currentStyle=index;return{success:true};}}};
 expect(await restoreChompyStyle(s,2,()=>true)).toBe(true);expect(sent).toEqual([2]);expect(combatStyle.currentStyle).toBe(2);
 combatStyle.weaponName='Ogre bow';expect(await restoreChompyStyle(s,2,()=>true)).toBe(false);expect(sent).toEqual([2]);
});

test('mutable cached life replacement during kit staging prevents the next owned bank withdrawal',async()=>{
 const player={name:'Owned',worldX:2613,worldZ:3092,level:0,lifeId:1,respawnCount:0,isDead:false},inventory:any[]=[],items=[{id:2883,count:1,name:'Ogre bow',slot:0},{id:2866,count:64,name:'Ogre arrow',slot:1},{id:2871,count:1,name:'Ogre bellows',slot:2},{id:2434,count:2,name:'Prayer potion(4)',slot:3}],bank={isOpen:true,items};let generation=1,withdrawals=0,closed=0;
 const state=()=>({player,inventory,bank,equipment:[],nearbyPlayers:[],combatStyle:{known:true,weaponName:'Unarmed',currentStyle:2,styles:[{index:0},{index:1},{index:2}]},autoRetaliateEnabled:false,prayers:{activePrayers:Array(15).fill(false),prayerPoints:99,prayerLevel:99}});
 const s:any={name:'fixture',tick:()=>0,ended:new Promise(()=>{}),client:{ingame:true,ifType:()=>({colour:0x00f800})},bankObservation:()=>({generation,items}),sdk:{getState:state,getSkill:()=>({level:99,baseLevel:99}),getInventory:()=>inventory,getEquipment:()=>[],sendCloseModal:async()=>{bank.isOpen=false;}},bot:{withdrawItem:async(item:any,n:number)=>{withdrawals++;item.count-=n;generation++;inventory.push({...item,count:n});player.lifeId=2;return{success:true};},closeBank:async()=>{closed++;bank.isOpen=false;},openBank:async()=>{bank.isOpen=true;generation++;return{success:true};}}};
 const result=await runChompyTrip(s,{kills:2,perTrip:1,cap:5000,returnTicks:300,protectMelee:true,prayerPotions:2});expect(result.ok).toBe(false);expect(withdrawals).toBe(1);expect(closed).toBe(0);expect(inventory[0].id).toBe(2883);
});

test('protection reserve counts discrete native five-tick drains and owned robe bonus',()=>{
 expect(chompyPrayerReserve(300,[])).toBe(62);expect(chompyPrayerReserve(300,[{id:544},{id:542},{id:1718}])).toBe(39);
 expect(()=>chompyRouteJob({kills:1,perTrip:1,cap:3000,returnTicks:300,prayerPotions:1})).toThrow('declared Protect');
});
test('lost prayer reply reconciles only observed transition and restores original protection',async()=>{
 const prayers={activePrayers:Array(15).fill(false)},sent:number[]=[];const s:any={sdk:{getState:()=>({prayers}),sendTogglePrayer:async(i:number)=>{sent.push(i);prayers.activePrayers[i]=!prayers.activePrayers[i];throw Error('reply lost');}}};
 const p=chompyProtection(s,()=>true);await p.set(true);await p.set(false);expect(sent).toEqual([14,14]);expect(p.uncertain).toBe(false);
});
test('observation failure after prayer dispatch parks helper with no cleanup toggle',async()=>{
 let calls=0,reads=0;const s:any={sdk:{getState:()=>{if(++reads>1)throw Error('publication lost');return{prayers:{activePrayers:Array(15).fill(false)}};},sendTogglePrayer:async()=>{calls++;return{success:true};}}};
 const p=chompyProtection(s,()=>true);await expect(p.set(true)).rejects.toThrow('publication lost');expect(p.uncertain).toBe(true);await expect(p.set(false)).rejects.toThrow('uncertain');expect(calls).toBe(1);
});

async function pressureFixture(mode:'stale'|'hits'|'attacker'){
 let tick=0,done=false;const callbacks=new Set<()=>void>(),combat={inCombat:true,targetType:'none',lastDamageTick:253},npcs:any[]=mode==='attacker'?[{targetIndex:32769,optionsWithIndex:[{text:'Attack'}]}]:[];
 const s:any={client:{selfSlot:1},tick:()=>tick,onTick:(f:()=>void)=>{callbacks.add(f);return()=>callbacks.delete(f);},ended:new Promise(()=>{}),sdk:{getState:()=>({player:{combat},nearbyNpcs:npcs})}};
 const pending=waitChompyPressure(s,()=>false).then(clear=>{done=true;return clear;});
 for(let i=0;i<30&&!done;i++){tick++;if(mode==='hits'&&tick===6)combat.lastDamageTick=999;for(const cb of [...callbacks])cb();for(let k=0;k<12;k++)await Promise.resolve();}
 return{clear:await pending,tick};
}
test('native eight-tick pressure clearance ignores stale zero-explosion health bar but retains fresh hits and attackers',async()=>{
 const stale=await pressureFixture('stale');expect(stale.clear).toBe(true);expect(stale.tick).toBe(8);
 const hit=await pressureFixture('hits');expect(hit.clear).toBe(true);expect(hit.tick).toBe(14);
 const attacker=await pressureFixture('attacker');expect(attacker.clear).toBe(false);expect(attacker.tick).toBe(24);
});

async function potionFixture(change:boolean,lostReply=false){
 let tick=0,done=false,calls=0;const callbacks=new Set<()=>void>(),inventory:any[]=[{id:2434,count:1,slot:0,optionsWithIndex:[{text:'Drink',opIndex:1}]},{id:995,count:42,slot:1}],prayers={prayerPoints:40,prayerLevel:99};
 const s:any={tick:()=>tick,onTick:(f:()=>void)=>{callbacks.add(f);return()=>callbacks.delete(f);},ended:new Promise(()=>{}),sdk:{getInventory:()=>inventory,getState:()=>({prayers}),getSkill:()=>({level:99,baseLevel:99})},direct:async()=>{calls++;if(change){inventory[0].id=139;prayers.prayerPoints=71;}if(lostReply)throw Error('reply lost');return{success:true};}};
 const pending=drinkChompyPrayer(s,()=>false).then(value=>({value,error:''}),error=>({value:undefined,error:String(error)})).then(r=>{done=true;return r;});
 for(let n=0;n<20&&!done;n++){tick++;for(const cb of [...callbacks])cb();for(let k=0;k<12;k++)await Promise.resolve();}
 return{...await pending,calls,tick};
}
test('owned native prayer dose needs exact transform and point receipt, then three-tick settle even after lost reply',async()=>{
 const paid=await potionFixture(true,true);expect(paid.error).toBe('');expect(paid.value).toEqual({id:2434,next:139,pointsBefore:40,pointsAfter:71});expect(paid.calls).toBe(1);expect(paid.tick).toBeGreaterThanOrEqual(3);
 const absent=await potionFixture(false);expect(absent.error).toContain('unconfirmed');expect(absent.calls).toBe(1);
});
test('trip assets reject an unreceipted prayer dose and preserve exact unused doses',()=>{
 const before=new Map([[2871,1],[2883,1],[2866,32],[2434,1]]),after=new Map([[2873,1],[2883,1],[2866,31],[139,1],[2876,1],[314,10]]),hunt={kills:1,baits:1,raw:1,feathers:10,rangedXp:40};
 expect(()=>chompyTripAssets(before,after,hunt)).toThrow('potion');expect(chompyTripAssets(before,after,hunt,new Map([[2434,-1],[139,1]]))).toMatchObject({potionChanges:{2434:-1,139:1}});
});

test('post-catch handoff moves outside-threshold loot position back onto the bounded bank walk',async()=>{
 let tick=0,done=false;const callbacks=new Set<()=>void>(),player={worldX:2590,worldZ:2960,level:0},sent:any[]=[];
 const s:any={sdk:{getState:()=>({player})}},deps:any={tick:()=>tick,pos:()=>({x:player.worldX,z:player.worldZ,level:0}),plan:(_level:number,_from:any,to:any)=>[to],onTick:(f:()=>void)=>{callbacks.add(f);return()=>callbacks.delete(f);},walk:async(x:number,z:number)=>{sent.push({x,z});player.worldX=x;player.worldZ=z;return{success:true};},runOn:async()=>{},locs:()=>[],messages:()=>[]};
 expect(chompyLocalReturn(player)).toBe(false);const pending=chompyReturnHandoff(s,()=>false,async()=>deps).then(()=>{done=true;});
 for(let i=0;i<45&&!done;i++){tick++;for(const f of [...callbacks])f();for(let n=0;n<12;n++)await Promise.resolve();}await pending;
 expect(sent.length).toBeGreaterThan(0);expect(chompyLocalReturn(player)).toBe(true);expect(player.worldZ).toBe(2966);
});


test('optional Chompy energy stock is finite and supports only native consumables',()=>{
 expect(chompyEnergyOption({CHOMPY_ENERGY_ID:'3008',CHOMPY_ENERGY_USES:'2',CHOMPY_ENERGY_BELOW:'90'})).toEqual({id:3008,maximumUses:2,below:90});
 expect(chompyEnergyOption({})).toBeUndefined();
 for(const energy of [{id:12625,maximumUses:1,below:20},{id:464,maximumUses:3,below:20},{id:3008,maximumUses:9,below:20}])expect(()=>chompyRouteJob({kills:2,perTrip:1,cap:3000,returnTicks:300,protectMelee:true,prayerPotions:2,energy})).toThrow('energy');
});

async function energyFixture(id:number,publication:'fresh'|'stale'|'wrong-stock',initialEnergy=20,extraRecovery=0){
 let tick=0,done=false,calls=0;const callbacks=new Set<()=>void>(),inventory:any[]=[{id,count:1,slot:0},{id:995,count:42,slot:1}],player={runEnergy:initialEnergy};const messages:any[]=[{type:0,text:'You have 3 doses of potion left.',observationId:1,tick:0}];
 const s:any={tick:()=>tick,onTick:(f:()=>void)=>{callbacks.add(f);return()=>callbacks.delete(f);},ended:new Promise(()=>{}),sdk:{getInventory:()=>inventory,getSkill:()=>({level:99,baseLevel:99}),getState:()=>({player,gameMessages:messages}),sendUseItem:async()=>{calls++;if(id===464){inventory.shift();player.runEnergy=50;}else{inventory[0].id=id===3008?3010:3018;player.runEnergy=initialEnergy+(id===3008?10:20)+extraRecovery;}if(publication==='wrong-stock')inventory[1].count--;return{success:true};}}};
 const pending=drinkChompyEnergy(s,id,()=>true).then(value=>({value,error:''}),error=>({value:undefined,error:String(error)})).then(r=>{done=true;return r;});
 for(let i=0;i<15&&!done;i++){tick++;if(tick===3&&publication==='fresh'&&id!==464)messages.push({type:0,text:'You have 3 doses of potion left.',observationId:2,tick});for(const f of [...callbacks])f();for(let k=0;k<20;k++)await Promise.resolve();}
 return{...await pending,calls,tick};
}
test('Chompy energy waits for fresh native potion completion and exact stock; fruit consumes exactly once',async()=>{
 for(const id of [3008,3016,464]){const r=await energyFixture(id,'fresh');expect(r.error).toBe('');expect(r.calls).toBe(1);expect(r.value?.delta[id]).toBe(-1);}
 const stale=await energyFixture(3008,'stale');expect(stale.error).toContain('unconfirmed');expect(stale.calls).toBe(1);
 const wrong=await energyFixture(3008,'wrong-stock');expect(wrong.error).toContain('unconfirmed');expect(wrong.calls).toBe(1);
});


test('energy is an exact declared trip cost; unrelated supply drift still fails',()=>{
 const before=new Map([[2871,1],[2883,1],[2866,32],[3008,1],[995,42]]),after=new Map([[2873,1],[2883,1],[2866,31],[3010,1],[2876,1],[314,10],[995,42]]),hunt={kills:1,baits:1,raw:1,feathers:10,rangedXp:40};
 expect(()=>chompyTripAssets(before,after,hunt)).toThrow('energy');
 expect(chompyTripAssets(before,after,hunt,new Map(),new Map([[3008,-1],[3010,1]]))).toMatchObject({energyChanges:{3008:-1,3010:1}});
 after.set(995,41);expect(()=>chompyTripAssets(before,after,hunt,new Map(),new Map([[3008,-1],[3010,1]]))).toThrow('reconcile');
});


test('repeated actual energy upkeep after receipted local fruit depletion waits for next bank refill; unknown loss still rejects',async()=>{
 let tick=0,done=false,calls=0;const callbacks=new Set<()=>void>(),inventory:any[]=[{id:464,slot:0,count:1}],player={runEnergy:20};
 const s:any={tick:()=>tick,onTick:(f:()=>void)=>{callbacks.add(f);return()=>callbacks.delete(f);},ended:new Promise(()=>{}),sdk:{getInventory:()=>inventory,getSkill:()=>({level:99,baseLevel:99}),getState:()=>({player}),sendUseItem:async()=>{calls++;inventory.splice(0);player.runEnergy+=30;return{success:true};}}};
 const receipts:any[]=[],policy={id:464,maximumUses:2,below:99},upkeep=chompyEnergyUpkeep(s,policy,receipts,()=>true);
 const pending=(async()=>{await upkeep.run();player.runEnergy=20;await upkeep.run();await upkeep.run();expect(calls).toBe(1);expect(receipts.length).toBe(1);inventory.push({id:464,slot:0,count:1});await chompyEnergyUpkeep(s,policy,receipts,()=>true).run();expect(calls).toBe(2);expect(receipts.length).toBe(2);})().finally(()=>{done=true;});
 for(let i=0;i<20&&!done;i++){tick++;for(const f of [...callbacks])f();for(let k=0;k<20;k++)await Promise.resolve();}await pending;
 inventory.push({id:464,slot:0,count:1});const unknown=chompyEnergyUpkeep(s,policy,[],()=>true);inventory.splice(0);await expect(unknown.run()).rejects.toThrow('without receipt');expect(calls).toBe(2);
});


test('fresh native energy receipt admits only observed-interval passive recovery above dose credit',async()=>{
 const native=await energyFixture(3008,'fresh',39,1);expect(native.error).toBe('');expect(native.value).toMatchObject({energyBefore:39,energyAfter:50,gain:10,passiveMaximum:1});expect(native.calls).toBe(1);
 const excessive=await energyFixture(3008,'fresh',39,3);expect(excessive.error).toContain('energy/HP unconfirmed');expect(excessive.calls).toBe(1);
});
