import{test,expect}from'bun:test';
import{readFileSync}from'node:fs';
import{NATURE,NATURE_XP_CAP,naturePlanComplete,natureRouteJob,natureReceipt,natureXpReceipt,insideNature,requireNatureEligibility,natureProfile,runNatureTrips,createShiloTransit,type NatureJob}from'./microbot-rune-trip';
const job=():NatureJob=>({target:4,batch:2,cap:2000,returnTicks:400,reserve:2,members:true,xpRate:1});

test('shared actual Shilo gate engine records unknown dispatch until exact landing settles',async()=>{
 for(const unknown of[false,true]){let tick=0,inputs=0;const player={worldX:2866,worldZ:2953,level:0},listeners=new Set<()=>void>();const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},sdk:{getState:()=>({player,modalOpen:false,interface:{isOpen:false},dialog:{isOpen:false},nearbyLocs:[{id:2261,x:2867,z:2953,level:0,optionsWithIndex:[{text:'Open',opIndex:1}]}]}),sendInteractLoc:async()=>{inputs++;if(unknown)throw Error('transport unknown');player.worldX=2868;return{success:true};}}},transit=createShiloTransit(s,{},()=>true),timer=setInterval(()=>{tick++;for(const cb of listeners)cb();},1);
  try{const action=transit.cross({id:2261,x:2867,z:2953},{x:2866,z:2953},{x:2868,z:2953},()=>false);if(unknown){await expect(action).rejects.toThrow('transport unknown');expect(transit.pending()).toBe(true);}else{await action;expect(transit.pending()).toBe(false);expect(tick).toBeGreaterThanOrEqual(2);}expect(inputs).toBe(1);}finally{clearInterval(timer);}
 }
});
test('Nature rejects the native partial fence endpoint instead of authorizing a straight fallback',()=>{expect(naturePlanComplete({x:2852,z:2955},{x:2865,z:3022},[{x:2859,z:3006}])).toBe(false);expect(naturePlanComplete({x:2880,z:2952},{x:2865,z:3022},[{x:2796,z:2960},{x:2815,z:3002},{x:2865,z:3022}])).toBe(true);expect(naturePlanComplete({x:2852,z:2955},{x:2865,z:3022},[])).toBe(false);});
test('declared native undead-stockade protection requires real prayer points and base level before staging',()=>{
 const f=consumerFixture();f.s.sdk.getState=()=>({player:f.player,prayers:{prayerPoints:99}});f.s.sdk.getSkill=()=>({level:99,baseLevel:42});expect(()=>requireNatureEligibility(f.s,{...job(),protectMelee:true})).toThrow('protection');f.s.sdk.getSkill=()=>({level:99,baseLevel:99});f.s.sdk.getState=()=>({player:f.player,prayers:{prayerPoints:5}});expect(()=>requireNatureEligibility(f.s,{...job(),protectMelee:true})).toThrow('protection');
 const native=readFileSync('vendor/rs-sdk/server/content/scripts/quests/quest_zombiequeen/configs/quest_zombiequeen.npc','utf8');expect(native.split('[zqzombie_unarmed]')[1]!.split('\n[')[0]).toContain('param=damagetype,^slash_style');
});
test('native Shilo transit requires wooden gate,metal gate and the broken-cart Search hop',()=>{
 const map=readFileSync('vendor/rs-sdk/server/content/maps/m44_46.jm2','utf8'),source=readFileSync('vendor/rs-sdk/server/content/scripts/quests/quest_zombiequeen/scripts/quest_zombiequeen.rs2','utf8');for(const row of ['0 51 9: 2261 0 2','0 59 9: 2260 0','0 61 7: 2216 10'])expect(map).toContain(row);expect(source).toContain('[oploc2,shilo_brokencart]');expect(source).toContain('p_telejump(movecoord(loc_coord, 3, 0, 1))');expect(source).toContain('p_telejump(movecoord(loc_coord, -1, 0, 1))');expect(source).toContain('^zombiequeen_complete');
});
test('Nature binds explicit native loc IDs/anchors and real Shilo banker, without table index arithmetic',()=>{
 const pack=readFileSync('vendor/rs-sdk/server/content/pack/loc.pack','utf8');expect(pack).toContain('2460=naturetemple_ruined');expect(pack).toContain('2473=naturetemple_exit_portal');expect(pack).toContain('2486=nature_altar');
 expect(readFileSync('vendor/rs-sdk/server/content/maps/m44_47.jm2','utf8').split('==== LOC ====')[1]).toContain('0 52 10: 2460 10');expect(readFileSync('vendor/rs-sdk/server/content/maps/m37_75.jm2','utf8').split('==== LOC ====')[1]).toContain('0 31 40: 2486 10 1');expect(readFileSync('vendor/rs-sdk/server/content/maps/m44_46.jm2','utf8')).toContain('0 35 10: 499');expect(NATURE.bank).toEqual({x:2852,z:2955,level:0});
 expect(natureRouteJob(job()).family).toBe('nature-runecraft');for(const change of [{members:false},{batch:28},{reserve:-1},{cap:400},{target:0},...[-1,0,NaN,Infinity,1.5,1001].map(xpRate=>({xpRate}))])expect(()=>natureRouteJob({...job(),...change})).toThrow();
});
function consumerFixture(options:{xpRate?:number;initialXp?:number;gain?:number}={}){
 const player={worldX:2852,worldZ:2955,level:0,lifeId:1,respawnCount:0,isDead:false};let open=false,generation=0,opens=0,xp=options.initialXp??0;
 let rows=[{id:1436,count:6},{id:1462,count:1},{id:995,count:15}];
 const s:any={client:{ingame:true,ifType:()=>({colour:0x00f800}),membersAccount:1},tick:()=>0,ended:new Promise(()=>{}),bankObservation:()=>open?{generation,items:rows}:null,sdk:{getState:()=>({player,bank:{isOpen:open},autoRetaliateEnabled:false}),getSkill:()=>({level:99}),getSkillXp:()=>xp,getEquipment:()=>[],getInventory:()=>[],sendCloseModal:async()=>{open=false;return{success:true};}},bot:{openBank:async()=>{opens++;open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};}}};
 const runner:any=async()=>{rows=[{id:1436,count:2},{id:1462,count:1},{id:995,count:15},{id:561,count:8}];xp=Math.min(NATURE_XP_CAP,xp+(options.gain??36*(options.xpRate??1)));open=false;return{ok:true,completed:4,trips:2,atBank:true,banked:{561:8},failure:'-',ticks:1};};return{s,player,runner,opens:()=>opens};
}
test('actual trip consumer reopens the closed/null final bank before its conserved asset audit',async()=>{
 const f=consumerFixture();const result=await runNatureTrips(f.s,job(),()=>false,f.runner);expect(result.ok).toBe(true);expect(result.balanced).toBe(true);expect(result.preserved).toBe(true);expect(f.opens()).toBe(2);expect(f.s.bankObservation()).toBeNull();
});
test('replaced life or respawn in same player object cannot reopen bank or authorize portal cleanup',async()=>{
 for(const field of ['lifeId','respawnCount']as const){const f=consumerFixture(),runner:any=async()=>{const result=await f.runner();f.player[field]++;return result;};const result=await runNatureTrips(f.s,job(),()=>false,runner);expect(result.ok).toBe(false);expect(result.auditFailure).toContain('original life');expect(f.opens()).toBe(1);
  const g=consumerFixture(),p=natureProfile(g.s,job());let actions=0;g.s.sdk.getInventory=()=>[{id:1436,count:2},{id:1462,count:1}];g.s.sdk.sendCloseModal=async()=>{actions++;return{success:true};};g.player.worldX=2400;g.player.worldZ=4835;g.player[field]++;await expect(p.run(2,100,()=>false)).rejects.toThrow();expect(actions).toBe(0);
 }
});
test('failed fresh final bank stays incomplete rather than trusting a closed snapshot',async()=>{
 const f=consumerFixture(),runner:any=async()=>{const result=await f.runner();f.s.bot.openBank=async()=>({success:false});return result;};const result=await runNatureTrips(f.s,job(),()=>false,runner);expect(result.ok).toBe(false);expect(result.balanced).toBe(false);expect(result.auditFailure).toContain('fresh bank unavailable');
});
test('Nature transit refuses further movement after an observed first HP drop',async()=>{
 const f=consumerFixture();let hp=99,inputs=0;
 f.s.sdk.getSkill=(name:string)=>({level:name==='Hitpoints'?hp:99});
 f.s.direct=async()=>{inputs++;return{success:true};};
 const profile=natureProfile(f.s,job());hp=98;
 await expect(profile.prepare!(()=>false)).rejects.toThrow('Nature native walk stopped');
 expect(inputs).toBe(0);
});
test('Nature native multiplier changes at91 independently of the declared world XP rate',()=>{
 for(const rate of[1,25]){expect(natureReceipt(2,2,18*rate,44,rate)).toBe(true);expect(natureReceipt(2,2,18*rate,90,rate)).toBe(true);expect(natureReceipt(2,4,18*rate,91,rate)).toBe(true);expect(natureReceipt(2,4,18*rate,99,rate)).toBe(true);expect(natureReceipt(2,2,18*rate,99,rate)).toBe(false);expect(natureReceipt(2,4,19*rate,99,rate)).toBe(false);}
 expect(natureReceipt(2,4,450,99)).toBe(true);expect(natureReceipt(2,4,18,99)).toBe(false);expect(natureReceipt(0,0,0,99)).toBe(false);expect(insideNature({worldX:2400,worldZ:4835,level:0})).toBe(true);expect(insideNature({worldX:2865,worldZ:3022,level:0})).toBe(false);
 const row=readFileSync('vendor/rs-sdk/server/content/scripts/skill_runecraft/configs/runecraft.dbrow','utf8').split('[runecraft_nature]')[1]!.split('\n[')[0]!;for(const field of ['data=level,44','data=experience,90','data=multiplier,91','data=talisman,nature_talisman'])expect(row).toContain(field);
});
test('capped accounts still require exact essence and rune output without fictional XP gain',()=>{
 expect(natureReceipt(2,4,50,99,25,NATURE_XP_CAP-50)).toBe(true);
 expect(natureReceipt(2,4,0,99,25,NATURE_XP_CAP)).toBe(true);
 expect(natureReceipt(2,3,0,99,25,NATURE_XP_CAP)).toBe(false);
 expect(natureReceipt(2,4,450,99,25,NATURE_XP_CAP-50)).toBe(false);
 for(const before of[-1,NaN,Infinity,NATURE_XP_CAP+1])expect(natureXpReceipt(2,0,25,before)).toBe(false);
 for(const rate of[0,-1,NaN,Infinity,1.5,1001])expect(natureXpReceipt(2,450,rate)).toBe(false);
 const engine=readFileSync('vendor/rs-sdk/server/engine/src/engine/entity/Player.ts','utf8');expect(engine).toContain('this.stats[stat] = 2_000_000_000');
});
test('whole-trip XP audit rejects wrong-rate success and accepts exact capped totals',async()=>{
 for(const initialXp of[0,NATURE_XP_CAP-50,NATURE_XP_CAP]){
  const f=consumerFixture({xpRate:25,initialXp}),result=await runNatureTrips(f.s,{...job(),xpRate:undefined},()=>false,f.runner);
  expect(result.ok).toBe(true);expect(result.xpBalanced).toBe(true);expect(result.runecraftXp).toBe(Math.min(900,NATURE_XP_CAP-initialXp));
 }
 const wrong=consumerFixture();const result=await runNatureTrips(wrong.s,{...job(),xpRate:25},()=>false,wrong.runner);
 expect(result.balanced).toBe(true);expect(result.preserved).toBe(true);expect(result.ok).toBe(false);expect(result.xpBalanced).toBe(false);expect(result.auditFailure).toContain('whole-trip XP receipt failed');
});
test('unknown starting XP refuses before any batch can consume owned essence',async()=>{
 const f=consumerFixture();f.s.sdk.getSkillXp=()=>null;let consumed=false;
 await expect(runNatureTrips(f.s,job(),()=>false,async()=>{consumed=true;return f.runner();})).rejects.toThrow('initial Runecraft XP unavailable');expect(consumed).toBe(false);
 const g=consumerFixture();g.s.sdk.getInventory=()=>[{id:1436,count:2},{id:1462,count:1}];g.s.sdk.getSkillXp=()=>null;let sent=0;g.s.sdk.sendUseItemOnLoc=async()=>{sent++;return{success:true};};
 const p=natureProfile(g.s,job());await expect(p.run(2,100,()=>false)).rejects.toThrow('pre-craft XP unavailable');expect(sent).toBe(0);
});
test('quest, member and level preflight rejects before owned withdrawals or loc actions',()=>{
 let actions=0;const client:any={ingame:true,ifType:()=>({colour:0x00f800}),membersAccount:1},s:any={client,sdk:{getSkill:()=>({level:99})},bot:{withdrawItem:()=>{actions++;}}};
 expect(()=>requireNatureEligibility(s,job())).not.toThrow();client.ifType=()=>({colour:0xff0000});expect(()=>natureProfile(s,job())).toThrow('observed completed');client.ifType=()=>({colour:0x00f800});client.membersAccount=0;expect(()=>natureProfile(s,job())).toThrow('member connection');client.membersAccount=1;s.sdk.getSkill=()=>({level:43});expect(()=>natureProfile(s,job())).toThrow('Runecraft44');expect(actions).toBe(0);
});
test('LiteClient membership uses the received account flag rather than full-client static configuration',()=>{
 const f=consumerFixture();expect(()=>requireNatureEligibility(f.s,job())).not.toThrow();
 f.s.client.constructor={memServer:true};delete f.s.client.membersAccount;
 expect(()=>requireNatureEligibility(f.s,job())).toThrow('member connection');
 f.s.client.membersAccount=0;expect(()=>requireNatureEligibility(f.s,job())).toThrow('member connection');
 f.s.client.membersAccount=1;f.s.client.constructor.memServer=false;expect(()=>requireNatureEligibility(f.s,job())).not.toThrow();
});
