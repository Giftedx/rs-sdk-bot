import Module from 'node:module';import{resolve}from'node:path';
import{test,expect}from 'bun:test';
import{readFileSync}from 'node:fs';
import{WATCH_CAVES,WATCH_ENTRY,WATCH_SUPPLIES,watchtowerEntry,watchtowerNativeBindings,madSkavidReply,runWatchtower,watchtowerOwnContext,finishWatchtowerOwned,watchtowerTowerEntry,watchtowerCakeOpening,watchtowerBridgeLoc,watchtowerCityExit,watchtowerShamanEffect,watchtowerEnchantPotion,WATCH_SHAMAN_ORDINALS}from './quest-itwatchtower-owned';
import{questDefinitions}from '../../packages/core/src/quest-status';
import type{Session}from '../../packages/core/src/inprocess';
const base='vendor/rs-sdk/server/content/';
test('surface return uses reachable native wall then wizard ladder, never the enclosed ground ladder',async()=>{
 const source=readFileSync(base+'scripts/quests/quest_itwatchtower/scripts/quest_itwatchtower.rs2','utf8');
 const wall=source.split('[oploc1,loc_2299]')[1]!.split('[oploc1,watchtowerbush]')[0]!;
 expect(wall).toContain('stat(agility) < 18');expect(wall).toContain('1_39_48_52_45');expect(wall).not.toContain('%itwatchtower');
 const map=readFileSync(base+'maps/m39_48.jm2','utf8').split('==== LOC ====')[1]!.split('==== NPC ====')[0]!;
 expect(map).toContain('0 52 47: 2299 4 3');expect(map).toContain('0 48 39: 2833 10');
 let level=0;const inputs:number[]=[];
 await watchtowerTowerEntry(()=>level,async(label,id,x,z,done)=>{inputs.push(id);expect(done()).toBe(false);if(id===2299){expect([x,z]).toEqual([2548,3119]);level=1;}else{expect([id,x,z]).toEqual([2796,2549,3111]);level=2;}expect(done()).toBe(true);});
 expect(inputs).toEqual([2299,2796]);expect(level).toBe(2);
 await watchtowerTowerEntry(()=>level,async()=>{throw Error('already upstairs must not input');});
});
test('unknown wall effect does not dispatch the wizard ladder or retry ground access',async()=>{
 const inputs:number[]=[];await expect(watchtowerTowerEntry(()=>0,async(_label,id)=>{inputs.push(id);throw Error('effect unknown');})).rejects.toThrow('effect unknown');expect(inputs).toEqual([2299]);
});
function fixture(){const state:any={player:{worldX:2548,worldZ:3119,level:0,lifeId:1,respawnCount:0},autoRetaliateEnabled:false,prayers:{activePrayers:Array(18).fill(false)}};const inventory=Object.entries(WATCH_SUPPLIES).flatMap(([id,n])=>+id===385||+id===954?Array.from({length:n},()=>({id:+id,count:1})):[{id:+id,count:n}]);let calls=0;const client:any={ingame:true,ifType:()=>({colour:0xf80000})};const s:any={client,sdk:{getState:()=>state,getInventory:()=>inventory,getSkill:()=>({level:99}),getEquipment:()=>[{id:1289,slot:3,count:1},{id:1540,slot:5,count:1}]},direct:async()=>{calls++;}};return{s:s as Session,state,inventory,client,calls:()=>calls};}
test('Native mapping and real Watch Tower reward bind to pinned handlers',()=>{expect(watchtowerNativeBindings()).toEqual({rawRewardMagic:153000,coins:5000,questPoints:4});const source=readFileSync(base+'scripts/quests/quest_itwatchtower/scripts/quest_itwatchtower.rs2','utf8');expect(source).toContain('stat_advance(magic, 153000)');expect(source).toContain('inv_add(inv, coins, 5000)');expect(source).toContain('if(%itwatchtower = ^itwatchtower_complete) %itwatchtower = ^itwatchtower_complete_read_scroll');});
test('all five Native language caves bind distinct entering and exiting map objects',()=>{const pack=new Map(readFileSync(base+'pack/loc.pack','utf8').split(/\r?\n/).map(l=>{const[i,n]=l.split('=');return[n,+i!];}));expect(WATCH_CAVES).toHaveLength(5);expect(new Set(WATCH_CAVES.map(c=>c.npc)).size).toBe(5);for(const c of WATCH_CAVES){expect([...pack.values()]).toContain(c.id);expect([...pack.values()]).toContain(c.out);}expect(WATCH_CAVES.map(c=>c.reply.test(['Okay, okay, I am not going to hurt you.','Cur.','Ar.','Ig.','Nod.'][WATCH_CAVES.indexOf(c)]!))).toEqual([true,true,true,true,true]);});
test('mad skavid selects each correct reply from actual incoming phrase and rejects unknown',()=>{for(const[phrase,answer]of[['Ar cur...','Gor.'],['Bidith ig...','Cur.'],['Cur tanath...','Bidith.'],['Gor nod...','Tanath.']])expect(madSkavidReply(phrase!).test(answer!)).toBe(true);expect(()=>madSkavidReply('???')).toThrow('unobserved');});
test('public quest flag and legitimate supplies admit the complete zero-progress consumer',()=>{const f=fixture();expect(questDefinitions().some(q=>q.name==='Watch Tower')).toBe(true);expect(()=>watchtowerEntry(f.s)).not.toThrow();expect(f.calls()).toBe(0);});
test('unknown/started/completed public quest cannot be guessed from private zero defaults',()=>{for(const colour of[0xff0000,0xf8f800,0x00f800]){const f=fixture();f.client.ifType=()=>({colour});expect(()=>watchtowerEntry(f.s)).toThrow('public not-started');expect(f.calls()).toBe(0);}});
test('each missing required supply refuses before input',async()=>{for(const id of Object.keys(WATCH_SUPPLIES)){const f=fixture();for(let i=f.inventory.length-1;i>=0;i--)if(f.inventory[i]!.id===+id)f.inventory.splice(i,1);await expect(runWatchtower(f.s)).rejects.toThrow('supply missing');expect(f.calls()).toBe(0);}});
test('quest progress items and active retaliation are not valid quest-zero staging',()=>{const f=fixture();f.inventory.push({id:2380,count:1});expect(()=>watchtowerEntry(f.s)).toThrow('progress items');f.inventory.pop();f.state.autoRetaliateEnabled=true;expect(()=>watchtowerEntry(f.s)).toThrow('controls');});
test('all five exact Native skill requirements are enforced before any quest input',()=>{for(const[key,minimum]of Object.entries(WATCH_ENTRY)){const f=fixture();f.s.sdk.getSkill=((name:string)=>({level:name===key?minimum-1:99}))as any;expect(()=>watchtowerEntry(f.s)).toThrow('skill required '+key);expect(f.calls()).toBe(0);}});

test('actual Watchtower consumer reaches the first owned direct action through standard stop helper',async()=>{const f=fixture();let tick=0,calls=0;const listeners=new Set<()=>void>();Object.assign(f.s,{name:'watchtest',tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),direct:async()=>{calls++;throw Error('first-owned-action');}});f.client.executeBotAction=()=>{};Object.assign(f.s.sdk,{getStateAge:()=>0,getSkillXp:()=>0});f.state.inventory=f.inventory;const timer=setInterval(()=>{tick++;for(const cb of listeners)cb();},1);try{await expect(runWatchtower(f.s)).rejects.toThrow('first-owned-action');expect(calls).toBe(1);}finally{clearInterval(timer);}});
test('actual Watchtower consumer observes stop before its first control or quest input',async()=>{const f=fixture();let tick=0,calls=0;const listeners=new Set<()=>void>();Object.assign(f.s,{name:'watchtest',tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),direct:async()=>{calls++;return{success:true};}});f.client.executeBotAction=()=>{};Object.assign(f.s.sdk,{getStateAge:()=>0,getSkillXp:()=>0});f.state.inventory=f.inventory;const timer=setInterval(()=>{tick++;for(const cb of listeners)cb();},1);try{await expect(runWatchtower(f.s,{stop:()=>true})).rejects.toThrow('owner/life/HP/gear/stop/cap');expect(calls).toBe(0);}finally{clearInterval(timer);}});

test('actual consumer failure settles only the login owner, never a replacement during its first await',async()=>{
 for(const mode of ['unchanged','executor','client','life','respawn']as const){const f=fixture();let tick=0,inputs=0,logouts=0;const listeners=new Set<()=>void>();
  f.client.executeBotAction=()=>{};f.client.selfSlot=1;Object.assign(f.s,{name:'watchtest',tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),direct:async()=>{inputs++;throw Error('first owned failure');}});Object.assign(f.s.sdk,{getStateAge:()=>0,getSkillXp:()=>0});f.state.inventory=f.inventory;
  const owns=watchtowerOwnContext(f.s),timer=setInterval(()=>{tick++;if(tick===1){if(mode==='executor')f.client.executeBotAction=()=>{};if(mode==='client')(f.s as any).client={...f.client};if(mode==='life')f.state.player.lifeId++;if(mode==='respawn')f.state.player.respawnCount++;}for(const cb of listeners)cb();},1);
  try{let failure='';try{await runWatchtower(f.s);}catch(e){failure=String(e);}expect(failure).not.toBe('');const settled=await finishWatchtowerOwned(f.s,owns,false,failure,async(sessions,ok)=>{expect(sessions).toEqual([f.s]);expect(ok).toBe(false);logouts++;});expect(settled).toBe(mode==='unchanged');expect(inputs).toBe(mode==='unchanged'?1:0);expect(logouts).toBe(mode==='unchanged'?1:0);}finally{clearInterval(timer);}
 }
});

test('observed raw trader positions behind solid counter are safe LINEOFWALK openings despite distance below five',()=>{
 const file=resolve(base+'../vendor/rsmod-pathfinder/rsmod-pathfinder.js'),m:any=new Module(file);m.filename=file;m._compile(readFileSync(file,'utf8'),file);const ray=m.exports;
 for(let x=2504;x<=2510;x++)for(let z=3016;z<=3025;z++){ray.allocateIfAbsent(x,z,0);ray.__set(x,z,0,0);}
 const p={worldX:2506,worldZ:3024,level:0},locs=[{id:2793,x:2506,z:3023}];
 for(const z of[3021,3022]){
  const trader={id:875,x:2507,z};expect(Math.max(Math.abs(trader.x-p.worldX),Math.abs(trader.z-p.worldZ))).toBeLessThanOrEqual(3);
  expect(ray.hasLineOfWalk(0,2506,3024,2507,z,1,1,1,1,0)).toBe(true);
  ray.changeLoc(2506,3023,0,2,1,true,false,true);
  expect(ray.hasLineOfWalk(0,2506,3024,2507,z,1,1,1,1,0)).toBe(false);
  expect(watchtowerCakeOpening(p,locs,[trader])).toBe(true);
  ray.changeLoc(2506,3023,0,2,1,true,false,false);
 }
 const source=readFileSync(base+'scripts/areas/area_yanille/scripts/ogre_trader.rs2','utf8');expect(source).toContain('npc_find(coord, ogre_trader2, 3, 2)');
 const config=readFileSync(base+'scripts/quests/quest_itwatchtower/configs/quest_itwatchtower.loc','utf8').split('[rockcounter_withcakes]')[1]!.split('[')[0]!;expect(config).toContain('width=2');expect(config).not.toContain('blockwalk=no');
 expect(watchtowerCakeOpening(p,[],[{id:875,x:2507,z:3021}])).toBe(false);
 expect(watchtowerCakeOpening(p,locs,[{id:875,x:2505,z:3023}])).toBe(false);
 expect(watchtowerCakeOpening({...p,level:1},locs,[{id:875,x:2507,z:3021}])).toBe(false);
 expect(watchtowerCakeOpening(p,locs,[])).toBe(false);
});

test('actual three bridge-probe tags admit only the observed linked upper scene loc',()=>{
 const nativeType={name:'Rock',op:['Jump-From']},frames=[1120114994,1120114994,1120114994];
 for(const tag of frames){const f=fixture();Object.assign(f.state.player,{worldX:2530,worldZ:3025,level:0});Object.assign(f.client,{mapBuildBaseX:2480,mapBuildBaseZ:2976,minusedlevel:0,selfSlot:1,executeBotAction:()=>{},world:{sceneType:(l:number,x:number,z:number)=>l===1&&x===50&&z===50?tag:0}});f.s.sdk.getStateAge=()=>0;const owns=watchtowerOwnContext(f.s);expect(watchtowerBridgeLoc(f.s,owns,nativeType)).toMatchObject({id:2830,x:2530,z:3026,level:0,optionsWithIndex:[{text:'Jump-From',opIndex:1}]});}
 const source=readFileSync(base+'scripts/quests/quest_itwatchtower/scripts/quest_itwatchtower.rs2','utf8').split('[oploc1,tanothjump1]')[1]!.split('[oploc1,tanothjump2]')[0]!;expect(source).toContain('inv_del(inv, coins, 20)');expect(source).toContain('stat_advance(agility, 50)');expect(source).toContain('p_teleport(0_39_47_34_21)');
 const map=readFileSync(base+'maps/m39_47.jm2','utf8');expect(map).toContain('1 34 18: h115 o42 f2');expect(map).toContain('1 34 18: 2830 10 2');
});
test('unknown bridge scene, wrong tag identity/anchor/plane, stale or replaced owner produces zero inputs',()=>{
 for(const mode of ['unknown','id','anchor','marker','plane','client','executor','life','respawn','stale','option']as const){const f=fixture();Object.assign(f.state.player,{worldX:2530,worldZ:3025,level:0});let tag=1120114994;Object.assign(f.client,{mapBuildBaseX:2480,mapBuildBaseZ:2976,minusedlevel:0,selfSlot:1,executeBotAction:()=>{},world:{sceneType:()=>tag}});f.s.sdk.getStateAge=()=>0;const owns=watchtowerOwnContext(f.s),type={name:'Rock',op:['Jump-From']};
 if(mode==='unknown')tag=0;if(mode==='id')tag^=1<<14;if(mode==='anchor')tag^=1;if(mode==='marker')tag^=1<<29;if(mode==='plane')f.state.player.level=1;if(mode==='client')(f.s as any).client={...f.client};if(mode==='executor')f.client.executeBotAction=()=>{};if(mode==='life')f.state.player.lifeId++;if(mode==='respawn')f.state.player.respawnCount++;if(mode==='stale')f.s.sdk.getStateAge=()=>5001;if(mode==='option')type.op=['Examine'];const loc=watchtowerBridgeLoc(f.s,owns,type);if(loc)void f.s.direct({type:'interactLoc',locId:loc.id});expect(loc).toBeUndefined();expect(f.calls()).toBe(0);
 }
});

test('actual city exit crosses all three native components before cave production',async()=>{
 const source=readFileSync(base+'scripts/quests/quest_itwatchtower/scripts/quest_itwatchtower.rs2','utf8'),reverse=source.split('[oploc1,tanothjump2]')[1]!.split('[label,enter_gutanoth]')[0]!;expect(reverse).toContain('p_teleport(0_39_47_35_18)');expect(reverse).not.toContain('inv_del');expect(reverse).not.toContain('stat_advance');
 const map=readFileSync(base+'maps/m39_47.jm2','utf8');for(const line of['0 35 21: 2831 10 2','0 11 3: 2832 10 1','0 8 55: 2789 0'])expect(map).toContain(line);
 expect(source).toContain('[oploc1,ogreguardgate2right] @open_gutanoth_gate(^right, ogre_guard2)');expect(source).toContain('$end = movecoord(loc_coord, -1, 0, 0)');
 const doors=readFileSync(base+'scripts/doors/scripts/open_and_close_double_doors.rs2','utf8').split('[proc,open_and_close_double_door2]')[1]!.split('[proc,open_and_close_double_door3]')[0]!;expect(doors).toContain('def_coord $dest = $loc_coord');expect(doors).toContain('p_teleport($dest)');
 let state={x:2539,z:3032,level:0,coins:0,agilityXP:125};const sequence:(number|string)[]=[];
 await watchtowerCityExit(()=>state,async(_label,id,x,z,done)=>{sequence.push(id);expect(done()).toBe(false);if(id===2831){expect([x,z]).toEqual([2531,3029]);state={...state,x:2531,z:3026};}else if(id===2832){expect([x,z]).toEqual([2507,3011]);state={...state,x:2506,z:3011};}else{expect([id,x,z]).toEqual([2789,2504,3063]);expect(state.x).toBe(2503);state={...state,x:2504,z:3063};}expect(done()).toBe(true);},async()=>{sequence.push('inside gate');state={...state,x:2503,z:3063};});expect(sequence).toEqual([2831,2832,'inside gate',2789]);expect(state).toEqual({x:2504,z:3063,level:0,coins:0,agilityXP:125});
});
test('unknown middle crossing or wrong gate approach prevents all later inputs and cave production',async()=>{
 for(const failure of['bridge','wall','approach']as const){let state={x:2539,z:3032,level:0,coins:0,agilityXP:125},cave=false;const inputs:number[]=[];
 await expect((async()=>{await watchtowerCityExit(()=>state,async(_l,id,_x,_z,done)=>{inputs.push(id);if(failure==='bridge'&&id===2831||failure==='wall'&&id===2832)throw Error('effect unknown');state={...state,x:id===2831?2531:2506,z:id===2831?3026:3011};expect(done()).toBe(true);},async()=>{});cave=true;})()).rejects.toThrow();expect(cave).toBe(false);expect(inputs).toEqual(failure==='bridge'?[2831]:[2831,2832]);}
});

test('sixth shaman disappearance is not terminal until actual Native potion conversion at1898',()=>{
 const before={2395:1,385:8,2376:1};let sends=0;const frames:{tick:number;gone:boolean;signal:boolean;pack:Record<number,number>}[]=[{tick:1896,gone:true,signal:false,pack:before},{tick:1897,gone:true,signal:false,pack:before},{tick:1898,gone:true,signal:true,pack:{229:1,2382:1,385:8,2376:1}}];
 sends++;const ready=frames.map(f=>watchtowerShamanEffect(before,f.pack,6,f.gone,f.signal));expect(ready).toEqual([false,false,true]);expect(sends).toBe(1);
 expect(watchtowerShamanEffect(before,{...frames[2]!.pack,385:7},6,true,true)).toBe(false);expect(watchtowerShamanEffect(before,frames[2]!.pack,6,false,true)).toBe(false);expect(watchtowerShamanEffect(before,frames[2]!.pack,6,true,false)).toBe(false);
 const source=readFileSync(base+'scripts/quests/quest_itwatchtower/scripts/ogre_shaman.rs2','utf8');expect(source.indexOf('npc_del;')).toBeLessThan(source.indexOf('p_delay(1);'));expect(source.indexOf('p_delay(1);')).toBeLessThan(source.indexOf('inv_add(inv, powering_crystal3, 1)'));expect(source).toContain('mes("You snatch it up quickly.")');for(const text of WATCH_SHAMAN_ORDINALS)expect(source).toContain(text);
});
test('first five shaman effects require their post-delay ordinal and unchanged whole stock',()=>{const before={2395:1,385:8};for(let n=1;n<=5;n++){expect(watchtowerShamanEffect(before,before,n,true,false)).toBe(false);expect(watchtowerShamanEffect(before,before,n,true,true)).toBe(true);expect(watchtowerShamanEffect(before,{2395:0,385:8},n,true,true)).toBe(false);}});

test('enchant consumer waits past early potion credit and three closed frames for the terminal wizard page',async()=>{
 let stock:Record<number,number>={2394:1,385:8},paid=0,ladder=0,finished=-1;const checks:number[]=[];
 await watchtowerEnchantPotion({pack:()=>stock,give:async done=>{
  paid++;let seen='',quiet=0;
  for(let tick=1696;tick<=1705;tick++){
   stock={2395:1,385:8};const page=tick===1696?'I have made the potion.':tick===1697?"That's great news; let me infuse it with magic...":tick===1702?'Here it is - a dangerous substance. I must remind you that this potion can only be used if your magic ability is high enough.':'';
   seen+=' '+page;quiet=page?0:quiet+1;
   if(quiet>=3){checks.push(tick);if(done(seen)){finished=tick;return;}}
  }throw Error('bounded enchant failure');
 }});ladder++;
 expect(checks).toContain(1700);expect(finished).toBe(1705);expect(paid).toBe(1);expect(ladder).toBe(1);
});
test('enchant consumer refuses absent terminal page or unrelated stock changes without another paid input',async()=>{
 for(const mode of['missing-page','foreign-stock','missing-conversion']){
  let stock:Record<number,number>={2394:1,385:8},paid=0,ladder=0;
  await expect(watchtowerEnchantPotion({pack:()=>stock,give:async done=>{paid++;if(mode!=='missing-conversion')stock={2395:1,385:mode==='foreign-stock'?7:8};const text=mode==='missing-page'?'I have made the potion.':'Here it is - a dangerous substance. if your magic ability is high enough.';if(!done(text))throw Error('bounded enchant failure');}}).then(()=>{ladder++;})).rejects.toThrow('bounded enchant failure');
  expect(paid).toBe(1);expect(ladder).toBe(0);
 }
});