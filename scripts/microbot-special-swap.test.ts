import{expect,test}from'bun:test';
import{nativeSwapWeapon,runSpecialSwap,specialExit,finishSpecialExit,specialAttackBudget}from'./microbot-special-swap';
import{setEquipmentObserved}from'../packages/core/src/container-observation';
import{ClientProt}from'../vendor/rs-sdk/server/webclient/src/io/ClientProt';
function actor(id=1377,opts:{stop?:boolean;full?:boolean;unknown?:boolean;lostEquip?:boolean;unarmed?:boolean;newLife?:boolean;foreignAfterAttack?:boolean;foreignAfterCancel?:boolean;ammo?:number;chainHits?:number;nativeDelay?:boolean}={}){
 const recipe=nativeSwapWeapon(id),originalStyle={known:true,weaponName:opts.unarmed?'Unarmed':'Rune sword',currentStyle:1,styles:[],tabInterfaceId:2276};
 let tick=0,clicks=0,attacks=0,cancels=0,delayUntil=0,cancelAt=-1;const state:any={player:{lifeId:1,level:0,respawnCount:0,isDead:false,worldX:3200,worldZ:3200,combat:{targetType:'none'}},combatStyle:{...originalStyle},autoRetaliateEnabled:false,nearbyPlayers:[],nearbyNpcs:[{index:4,id:81,targetIndex:-1,optionsWithIndex:[{opIndex:2,text:'Attack'}]}]};
 let gear:any[]=[...opts.unarmed?[]:[{id:1289,slot:3,count:1}],{id:1540,slot:5,count:1}],pack:any[]=[{id,slot:0,count:1},{id:995,slot:1,count:37}];if(opts.full)for(let n=2;n<28;n++)pack.push({id:20000+n,slot:n,count:1});
 state.nearbyNpcs[0].x=3201;state.nearbyNpcs[0].z=3200;if(opts.ammo)gear.push({id:882,slot:13,count:opts.ammo});if(opts.chainHits===2)state.nearbyNpcs.push({...state.nearbyNpcs[0],index:5,x:3202});
 const vars:number[]=[];vars[300]=1000;vars[301]=0;const client:any={var:vars,selfSlot:1,mapBuildBaseX:0,mapBuildBaseZ:0,localPlayer:{routeX:[3200],routeZ:[3200]},executeBotAction:()=>{throw Error('unexpected original action');},writeOpcode:()=>{cancels++;state.player.combat.targetType='none';},out:{p1:()=>{},p2:()=>{}}};
 const s:any={name:'practice',client,tick:()=>tick,ended:new Promise(()=>{}),direct:async(a:any)=>client.executeBotAction(a),onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;cb();next();}});next();return()=>{active=false;};},sdk:{getState:()=>state,getStateAge:()=>0,getSkill:()=>({level:99}),getEquipment:()=>gear,getInventory:()=>pack,sendSetCombatStyle:async(n:number)=>{state.combatStyle={...state.combatStyle,currentStyle:n};return{success:true};},sendClickComponent:async()=>{clicks++;if(opts.unknown)return{success:false};if(recipe.self){vars[300]-=recipe.energy;vars[301]=0;}else vars[301]=vars[301]===1?0:1;return{success:true};},sendInteractNpc:async(index:number)=>{expect(index).toBe(4);attacks++;if(opts.nativeDelay)delayUntil=tick+2;state.player.combat.targetType='npc';vars[300]-=recipe.energy;vars[301]=0;return{success:true};}},bot:{equipItem:async(row:any)=>{const special=row.id===id,slot=3;pack=pack.filter(i=>i!==row);const displaced=gear.filter(i=>i.slot===slot||special&&recipe.twoHanded&&i.slot===5);gear=gear.filter(i=>!displaced.includes(i));for(const item of displaced)pack.push({...item,slot:100+pack.length});gear.push({...row,slot});if(row.id===1540){gear=gear.filter(i=>i.id!==1289);throw Error('shield fixture route error');}state.combatStyle=special?{...originalStyle,currentStyle:0,weaponName:recipe.name,tabInterfaceId:recipe.tab}:{...originalStyle,currentStyle:0};if(opts.lostEquip&&special)throw Error('lost equip reply');return{success:true,message:'equipped'};}}};
 // Shields restore to slot5 without replacing the restored weapon.
 const equip=s.bot.equipItem;s.bot.equipItem=async(row:any)=>{if(row.id!==1540)return equip(row);pack=pack.filter(i=>i!==row);gear.push({...row,slot:5});return{success:true,message:'equipped'};};
 client.mapBuildBaseX=3152;client.mapBuildBaseZ=3152;client.minusedlevel=0;client.localPlayer={routeX:[48],routeZ:[48],routeLength:0};client.collision=[{flags:new Int32Array(104*104)}];client.ensureCollision=()=>{};client.npc=[];for(const n of state.nearbyNpcs)client.npc[n.index]={type:{id:n.id,size:1},routeX:[n.x-3152],routeZ:[n.z-3152]};
 client.writeOpcode=(opcode:number)=>{if(opcode===ClientProt.MOVE_GAMECLICK){cancels++;cancelAt=tick;if(tick>=delayUntil)state.player.combat.targetType='none';}else if(opcode===ClientProt.OPNPC2)queueMicrotask(()=>{void s.sdk.sendInteractNpc(4);});else throw Error('unexpected protocol opcode');};
 setEquipmentObserved(client,true);
 if(recipe.ammo||opts.chainHits){const attack=s.sdk.sendInteractNpc;s.sdk.sendInteractNpc=async(index:number)=>{const reply=await attack(index);if(opts.chainHits&&opts.chainHits>1)vars[300]-=recipe.energy*(opts.chainHits-1);if(recipe.ammoSlot===13){const ammo=gear.find(i=>i.slot===13);ammo.count-=recipe.ammo;gear=gear.filter(i=>i.count>0);}else if(recipe.ammo)gear=gear.filter(i=>i.id!==id);return reply;};}
 s.bot.unequipItem=async(row:any)=>{gear=gear.filter(i=>i!==row);pack.push({...row,slot:100+pack.length});state.combatStyle={...originalStyle,currentStyle:0};return{success:true,message:'unequipped'};};
 if(opts.newLife){const click=s.sdk.sendClickComponent;s.sdk.sendClickComponent=async()=>{const result=await click();state.player.lifeId=2;return result;};}
 if(opts.foreignAfterAttack){const attack=s.sdk.sendInteractNpc;s.sdk.sendInteractNpc=async(index:number)=>{const result=await attack(index);client.executeBotAction=()=>({success:true});return result;};}
 if(opts.foreignAfterCancel){const subscribe=s.onTick;s.onTick=(cb:()=>void)=>subscribe(()=>{if(cancels)client.executeBotAction=()=>({success:true});cb();});}
 return{s,read:()=>({tick,clicks,attacks,cancels,cancelAt,gear,pack,state}),stop:()=>!!opts.stop};
}
test('native special metadata uses actual server costs and two-handed slots',()=>{
 expect(nativeSwapWeapon(1377)).toMatchObject({energy:1000,self:true,twoHanded:false});
 expect(nativeSwapWeapon(861)).toMatchObject({energy:350,self:false,twoHanded:true});
 expect(nativeSwapWeapon(3204)).toMatchObject({energy:300,twoHanded:true});
 expect(()=>nativeSwapWeapon(1289)).toThrow('no supported special');
});
test('self special swaps once, spends exact energy and restores owned weapon, shield and style',async()=>{
 const a=actor();expect(await runSpecialSwap(a.s,{weapon:1377,minimumEnergy:1000,cap:30})).toMatchObject({ok:true,consumed:true,restored:true,preserved:true,energyAfter:0});
 expect(a.read()).toMatchObject({clicks:1,attacks:0});expect(a.read().state.combatStyle.currentStyle).toBe(1);
});
test('two-handed attack special restores displaced shield and cancels our target before gear return',async()=>{
 const a=actor(3204);expect(await runSpecialSwap(a.s,{weapon:3204,minimumEnergy:300,cap:30,target:{id:81,index:4}})).toMatchObject({ok:true,consumed:true,restored:true,energyAfter:700});
 expect(a.read()).toMatchObject({clicks:1,attacks:1,cancels:1});expect(a.read().gear.map(i=>i.id).sort()).toEqual([1289,1540]);
});
test('lost equip reply reconciles exact owned swap without another input',async()=>{
 const a=actor(1377,{lostEquip:true});expect(await runSpecialSwap(a.s,{weapon:1377,minimumEnergy:1000,cap:30})).toMatchObject({ok:true,restored:true});expect(a.read().clicks).toBe(1);
});
test('unknown activation stops once and restores gear without pretending energy was spent',async()=>{
 const a=actor(1377,{unknown:true});expect(await runSpecialSwap(a.s,{weapon:1377,minimumEnergy:1000,cap:12})).toMatchObject({ok:false,consumed:false,restored:true});expect(a.read().clicks).toBe(1);
});
test('two-handed full pack and missing combat target refuse before equip or special input',async()=>{
 const a=actor(3204,{full:true});await expect(runSpecialSwap(a.s,{weapon:3204,minimumEnergy:300,cap:30,target:{id:81,index:4}})).rejects.toThrow('room');expect(a.read().clicks).toBe(0);
 const b=actor(1215);await expect(runSpecialSwap(b.s,{weapon:1215,minimumEnergy:250,cap:30})).rejects.toThrow('explicit observed target');expect(b.read().clicks).toBe(0);
});
test('stop before swap sends no special or equipment inputs',async()=>{
 const a=actor(1377,{stop:true});expect(await runSpecialSwap(a.s,{weapon:1377,minimumEnergy:1000,cap:30},a.stop)).toMatchObject({ok:false,attempted:false,restored:true});expect(a.read().clicks).toBe(0);
});
test('original unarmed state returns the special weapon to the pack',async()=>{
 const a=actor(1377,{unarmed:true});expect(await runSpecialSwap(a.s,{weapon:1377,minimumEnergy:1000,cap:30})).toMatchObject({ok:true,restored:true,preserved:true});expect(a.read().gear.map(i=>i.id)).toEqual([1540]);expect(a.read().pack.some(i=>i.id===1377)).toBe(true);
});
test('a new life receives no old-life restoration inputs',async()=>{
 const a=actor(1377,{newLife:true});expect(await runSpecialSwap(a.s,{weapon:1377,minimumEnergy:1000,cap:30})).toMatchObject({ok:false,restored:false});expect(a.read().gear.some(i=>i.id===1377)).toBe(true);expect(a.read().clicks).toBe(1);
});
test('a different active target cannot be taken over',async()=>{
 const a=actor(1215);a.read().state.player.combat={targetType:'npc',targetIndex:9};await expect(runSpecialSwap(a.s,{weapon:1215,minimumEnergy:250,cap:30,target:{id:81,index:4}})).rejects.toThrow('different active target');expect(a.read().clicks).toBe(0);
});
test('a new input owner after attack receives no old-owner cancellation or gear inputs',async()=>{
 const a=actor(3204,{foreignAfterAttack:true});expect(await runSpecialSwap(a.s,{weapon:3204,minimumEnergy:300,cap:30,target:{id:81,index:4}})).toMatchObject({ok:false,restored:false});expect(a.read()).toMatchObject({attacks:1,cancels:0,clicks:1});expect(a.read().gear.some(i=>i.id===3204)).toBe(true);
});
test('input ownership changing while own cancellation settles prevents later restoration inputs',async()=>{
 const a=actor(3204,{foreignAfterCancel:true});expect(await runSpecialSwap(a.s,{weapon:3204,minimumEnergy:300,cap:30,target:{id:81,index:4}})).toMatchObject({ok:false,restored:false});expect(a.read()).toMatchObject({attacks:1,cancels:1,clicks:1});expect(a.read().gear.some(i=>i.id===3204)).toBe(true);
});
test('bow restores original gear with the exact authorized two-arrow debit, including empty quiver',async()=>{
 for(const count of[2,20]){const a=actor(861,{ammo:count});expect(await runSpecialSwap(a.s,{weapon:861,minimumEnergy:350,cap:30,target:{id:81,index:4},costs:{882:2}})).toMatchObject({ok:true,restored:true,preserved:true,itemCosts:{882:2}});expect(a.read().gear.find(i=>i.id===882)?.count??0).toBe(count-2);}
});
test('bow ammunition must be declared before the owned swap or activation',async()=>{
 const a=actor(861,{ammo:2});await expect(runSpecialSwap(a.s,{weapon:861,minimumEnergy:350,cap:30,target:{id:81,index:4}})).rejects.toThrow('ammunition');expect(a.read().clicks).toBe(0);
});
test('rune thrownaxe refuses undeclared nearby chain targets before any input',async()=>{
 const a=actor(805,{chainHits:2});expect(await runSpecialSwap(a.s,{weapon:805,minimumEnergy:1000,cap:30,target:{id:81,index:4},costs:{805:1}})).toMatchObject({ok:false,attempted:false,restored:true});expect(a.read().clicks).toBe(0);
});
test('declared bounded rune thrownaxe chain spends per-hit energy and one owned projectile',async()=>{
 const a=actor(805,{chainHits:2});expect(await runSpecialSwap(a.s,{weapon:805,minimumEnergy:1000,cap:30,target:{id:81,index:4},chainTargets:[{id:81,index:5}],maximumHits:2,costs:{805:1}})).toMatchObject({ok:true,restored:true,preserved:true,energyAfter:800,itemCosts:{805:1},maximumHits:2});expect(a.read()).toMatchObject({attacks:1,cancels:2});
});
test('a distant Rune chain target cannot queue an approach before the declared chain',async()=>{
 const a=actor(805);a.s.client.npc[4].routeX[0]=57;a.read().state.nearbyNpcs[0].x=3209;expect(await runSpecialSwap(a.s,{weapon:805,minimumEnergy:1000,cap:30,target:{id:81,index:4},costs:{805:1}})).toMatchObject({ok:false,attempted:false,restored:true});expect(a.read()).toMatchObject({attacks:0,clicks:0});
});

test("NPC CLI exit is explicit and inside native plane bounds",()=>{expect(specialExit("2919,3538,0")).toEqual({x:2919,z:3538,level:0});for(const v of[undefined,"","2919,3538,4","16384,3538,0","2919,3538"])expect(()=>specialExit(v)).toThrow();});

test("escape cannot adopt a replacement input owner after the special",async()=>{const a=actor(1377),original={client:a.s.client,executor:a.s.client.executeBotAction,life:a.s.sdk.getState().player.lifeId,respawns:0,hp:99};a.s.client.executeBotAction=()=>{throw Error("foreign input")};await expect(finishSpecialExit(a.s,{x:3200,z:3200,level:0},100,()=>false,original)).rejects.toThrow("original actor");expect(a.read().clicks).toBe(0);});

test("NPC CLI reserves restoration and escape before a paid attack",()=>{expect(specialAttackBudget(180,true)).toBe(72);expect(specialAttackBudget(60,false)).toBe(60);expect(specialAttackBudget(180,false)).toBe(100);for(const cap of[20,80,106,107,108,NaN])expect(()=>specialAttackBudget(cap,true)).toThrow();});

test("dagger waits out native one-cycle suspension before its single cancellation",async()=>{const a=actor(1215,{nativeDelay:true});expect(nativeSwapWeapon(1215).suspensionTicks).toBe(1);expect(nativeSwapWeapon(861).suspensionTicks).toBe(0);expect(await runSpecialSwap(a.s,{weapon:1215,minimumEnergy:250,cap:30,target:{id:81,index:4}})).toMatchObject({ok:true,restored:true,consumed:true});expect(a.read()).toMatchObject({attacks:1,cancels:1,cancelAt:2});expect(a.read().cancelAt).toBeLessThan(4);});
