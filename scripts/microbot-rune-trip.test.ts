import{test,expect}from'bun:test';
import{readFileSync}from'node:fs';
import{NATURE,naturePlanComplete,natureRouteJob,natureReceipt,insideNature,requireNatureEligibility,natureProfile,runNatureTrips,type NatureJob}from'./microbot-rune-trip';
const job=():NatureJob=>({target:4,batch:2,cap:2000,returnTicks:400,reserve:2,members:true});
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
 expect(natureRouteJob(job()).family).toBe('nature-runecraft');for(const change of [{members:false},{batch:28},{reserve:-1},{cap:400},{target:0}])expect(()=>natureRouteJob({...job(),...change})).toThrow();
});
function consumerFixture(){
 const player={worldX:2852,worldZ:2955,level:0,lifeId:1,respawnCount:0,isDead:false};let open=false,generation=0,opens=0,xp=0;
 let rows=[{id:1436,count:6},{id:1462,count:1},{id:995,count:15}];
 const s:any={client:{ingame:true,ifType:()=>({colour:0x00f800}),membersAccount:1},tick:()=>0,ended:new Promise(()=>{}),bankObservation:()=>open?{generation,items:rows}:null,sdk:{getState:()=>({player,bank:{isOpen:open},autoRetaliateEnabled:false}),getSkill:()=>({level:99}),getSkillXp:()=>xp,getEquipment:()=>[],getInventory:()=>[],sendCloseModal:async()=>{open=false;return{success:true};}},bot:{openBank:async()=>{opens++;open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};}}};
 const runner:any=async()=>{rows=[{id:1436,count:2},{id:1462,count:1},{id:995,count:15},{id:561,count:8}];xp=36;open=false;return{ok:true,completed:4,trips:2,atBank:true,banked:{561:8},failure:'-',ticks:1};};return{s,player,runner,opens:()=>opens};
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
test('Nature exact native multiplier changes at91 and XP remains nine per essence',()=>{
 expect(natureReceipt(2,2,18,44)).toBe(true);expect(natureReceipt(2,2,18,90)).toBe(true);expect(natureReceipt(2,4,18,91)).toBe(true);expect(natureReceipt(2,4,18,99)).toBe(true);expect(natureReceipt(2,2,18,99)).toBe(false);expect(natureReceipt(2,4,19,99)).toBe(false);expect(natureReceipt(0,0,0,99)).toBe(false);expect(insideNature({worldX:2400,worldZ:4835,level:0})).toBe(true);expect(insideNature({worldX:2865,worldZ:3022,level:0})).toBe(false);
 const row=readFileSync('vendor/rs-sdk/server/content/scripts/skill_runecraft/configs/runecraft.dbrow','utf8').split('[runecraft_nature]')[1]!.split('\n[')[0]!;for(const field of ['data=level,44','data=experience,90','data=multiplier,91','data=talisman,nature_talisman'])expect(row).toContain(field);
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
