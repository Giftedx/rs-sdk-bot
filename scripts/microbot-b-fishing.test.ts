import {test,expect} from 'bun:test';
import {FISH_PROFILES,FISH_KNIFE_RESET,fishSpotIds,pickFishSpot,runStagedFishing,searchNativeCatherbyFishing,catherbyFishingSearchPoints,karambwanLoadEffect,karambwanAttemptEffect,bigNetSnapshot,bigNetReceipt as nativeBigNetReceipt,fishingByproducts,fishingOutputs,fishingCapacityOutputs,type FishDriver,type FishAction,type FishMethod} from './microbot-b-fishing';
import {knifeDelay,knifeCut,KNIFE,NORMAL_LOGS} from './knife-reset';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';
const item=(id:number,count=1,slot=0)=>({id,count,slot,name:'native fixture item',optionsWithIndex:[]});
const state=(method:'fly'|'karambwan',inventory:ReturnType<typeof item>[],xp=0)=>({player:{worldX:2899,worldZ:3118,level:0,lifeId:1},inventory,skills:[{name:'Fishing',level:65,experience:xp},{name:'Hitpoints',level:10,baseLevel:10,experience:1000}],nearbyNpcs:[{index:1,id:fishSpotIds(method)[0],x:2900,z:3118,distance:1,optionsWithIndex:[{text:method==='fly'?'Lure':'Fish',opIndex:1}]}]} as unknown as BotWorldState);
const options={method:'fly' as const,amount:2,cap:100,maxAttempts:10,progressTicks:40};
test('native spot categories exclude lookalike shrimp and quest-only spots',()=>{
 expect(fishSpotIds('karambwan')).toEqual([1176,1177,1178]);
 expect(fishSpotIds('karambwanji')).toEqual([1174,1175]);
 const s=state('fly',[item(309),item(314,10,1)]);expect(pickFishSpot(s,'fly')?.index).toBe(1);
 s.nearbyNpcs[0]!.id=fishSpotIds('net')[0]!;expect(pickFishSpot(s,'fly')).toBeUndefined();
});
test('wrong-type-only window searches native shore then dispatches only a later compatible Cage spot',async()=>{
 let tick=0,searches=0,actions=0;const make=(correct=false,caught=0)=>({...state('fly',[item(301),...caught?[item(377,caught,1)]:[]],caught*90),nearbyNpcs:[{index:correct?7:1,id:correct?321:320,x:2860,z:3426,distance:2,reachable:true,optionsWithIndex:[{text:correct?'Cage':'Net',opIndex:1}]}]})as unknown as BotWorldState;let current=make();
 const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>false,interact:async(index,op)=>{expect(index).toBe(7);expect(op).toBe(1);actions++;return{success:true};},combine:async()=>({success:true}),step:async()=>{tick++;},wait:async(test)=>{tick++;current=make(true,1);return test();},search:async(pass,stop)=>{expect(stop()).toBe(false);searches++;tick+=3;if(pass===1)current=make(true);return true;}};
 const result=await runStagedFishing(d,{method:'cage',amount:1,cap:100,maxAttempts:5,progressTicks:40});expect(result.caught).toBe(1);expect(actions).toBe(1);expect(searches).toBe(2);expect(tick).toBeLessThan(12);expect(catherbyFishingSearchPoints()).toEqual([{x:2836,z:3431,level:0},{x:2846,z:3429,level:0},{x:2860,z:3426,level:0}]);
});
test('absent compatible type and cancellation bound searches without dispatching wrong categories',async()=>{
 for(const stoppedAt of [2,100]){let tick=0,searches=0,actions=0;const current=state('fly',[item(301)]);current.nearbyNpcs[0]!.id=320;const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>tick>=stoppedAt,interact:async()=>{actions++;return{success:true};},combine:async()=>({success:true}),step:async()=>{tick++;},wait:async()=>false,search:async(_pass,stop)=>{searches++;tick++;stop();return true;}};await expect(runStagedFishing(d,{method:'cage',amount:1,cap:100,maxAttempts:5,progressTicks:40})).rejects.toThrow();expect(actions).toBe(0);expect(searches).toBeLessThanOrEqual(3);expect(tick).toBeLessThanOrEqual(3);}
});
test('fly fishing counts native catches and exact feather debit without repeated clicks',async()=>{
 let current=state('fly',[item(309),item(314,10,1)]),tick=0,actions=0,caught=0;
 const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>false,interact:async()=>{actions++;return{success:true};},combine:async()=>({success:true}),step:async()=>{tick++;},wait:async(test)=>{tick++;caught++;current=state('fly',[item(309),item(314,10-caught,1),item(335,caught,2)],caught*50);return test();}};
 expect(await runStagedFishing(d,options)).toEqual({caught:2,baitUsed:2,attempts:1,ticks:3});expect(actions).toBe(1);
});
test('karambwan vessel transitions distinguish a missed roll from a catch',()=>{
 const before=state('karambwan',[item(3157),item(3150,1,1)]),loaded=state('karambwan',[item(3159)]);
 expect(karambwanLoadEffect(before,loaded)).toBe(true);
 expect(karambwanAttemptEffect(loaded,state('karambwan',[item(3157)]))).toBe(0);
 expect(karambwanAttemptEffect(loaded,state('karambwan',[item(3157),item(3142,1,1)],105))).toBe(1);
 expect(()=>karambwanAttemptEffect(loaded,state('karambwan',[item(3157),item(3142,1,1)]))).toThrow('reconcile');
});
test('karambwan finite job reloads each consumed single bait and limits missed attempts',async()=>{
 let current=state('karambwan',[item(3157),item(3150,1,1)]),tick=0;
 const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>false,interact:async()=>{current=state('karambwan',[item(3157),item(3142,1,1)],105);return{success:true};},combine:async()=>{current=state('karambwan',[item(3159)]);return{success:true};},step:async()=>{tick++;},wait:async(test)=>{tick++;return test();}};
 expect(await runStagedFishing(d,{...options,method:'karambwan',amount:1})).toEqual({caught:1,baitUsed:1,attempts:1,ticks:2});
});
test('stops, missing bait and no progress do not run forever',async()=>{
 let current=state('fly',[item(309),item(314,1,1)]),tick=0,actions=0;
 const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>true,interact:async()=>{actions++;return{success:true};},combine:async()=>({success:true}),step:async()=>{tick++;},wait:async()=>{tick+=10;return false;}};
 await expect(runStagedFishing(d,options)).rejects.toThrow('stopped');expect(actions).toBe(0);
 current=state('fly',[item(309)]);await expect(runStagedFishing({...d,stopped:()=>false},options)).rejects.toThrow('bait');
 current=state('fly',[item(309),item(314,1,1)]);await expect(runStagedFishing({...d,stopped:()=>false},options)).rejects.toThrow('no progress');
});

test('native search rejects unwalkable shore and stop without sending an NPC action',async()=>{
 let paths=0;const s:any={sdk:{getState:()=>({player:{worldX:2839,worldZ:3432,level:0},nearbyNpcs:[]}),findPath:()=>{paths++;return{success:false,reachedDestination:false};}}};
 expect(await searchNativeCatherbyFishing(s,'cage',0,()=>false)).toBe(false);expect(paths).toBe(9);paths=0;expect(await searchNativeCatherbyFishing(s,'cage',0,()=>true)).toBe(false);expect(paths).toBe(0);expect(await searchNativeCatherbyFishing(s,'cage',3,()=>false)).toBe(false);
});
test('original eight native profiles remain exact; BigNet and lava resolve only their actual NPC categories/names',()=>{
 const old=Object.fromEntries(Object.entries(FISH_PROFILES).slice(0,8));expect(createHash('sha256').update(JSON.stringify(old)).digest('hex')).toBe('a0a851241eedc584d99cf5aba276dd8f3f7f83fd62ff489385085b75b3c93aab');for(const m of Object.keys(old))expect(fishingByproducts(m as keyof typeof FISH_PROFILES)).toEqual([]);expect(fishSpotIds('lava')).toEqual([800]);expect(fishSpotIds('bigNet')).toContain(322);expect(fishSpotIds('bigNet')).not.toContain(320);expect(fishingOutputs('bigNet')).toEqual([353,341,363,1061,401,1059,407,405]);expect(Object.values(fishingCapacityOutputs('bigNet')).reduce((a,b)=>a+b,0)).toBe(9);
});
const bigNetReceipt=(b:Parameters<typeof nativeBigNetReceipt>[0],a:Parameters<typeof nativeBigNetReceipt>[1],raw=0,xp=b.xp,rolls=1)=>nativeBigNetReceipt(b,a,raw,xp,rolls,1);
const netState=(inventory:ReturnType<typeof item>[],xp=0)=>({...state('fly',inventory,xp),skills:[{name:'Fishing',level:99,baseLevel:99,experience:xp},{name:'Hitpoints',level:10,baseLevel:10,experience:1000}],nearbyNpcs:[{index:7,id:322,x:2846,z:3429,distance:1,reachable:true,optionsWithIndex:[{text:'Net',opIndex:1}]}]})as unknown as BotWorldState;
test('BigNet fractional seaweed XP keeps a shared public-floor phase; exact known raw costs reject unknown items, debits and excess growth',()=>{
 const b=bigNetSnapshot(netState([item(305)])),first=bigNetSnapshot(netState([item(305),item(401,1,1)]));expect(bigNetReceipt(b,first)).toMatchObject({kind:'made',primary:0,rawXp:1,byproducts:{401:1}});const next=bigNetSnapshot(netState([item(305),item(401,2,1)],1));expect(bigNetReceipt(first,next,1,0)).toMatchObject({kind:'made',primary:0,rawXp:1});expect(bigNetReceipt(first,{...next,xp:2},1,0).kind).toBe('pending');expect(bigNetReceipt(b,bigNetSnapshot(netState([item(305),item(995,1,1)]))).kind).toBe('invalid');expect(bigNetReceipt(b,bigNetSnapshot(netState([item(353,1,1)],20))).kind).toBe('invalid');expect(bigNetReceipt(b,bigNetSnapshot(netState([item(305),item(353,3,1)],60))).kind).toBe('invalid');
});
test('BigNet counts only primary fish, preserves every Native byproduct and does not reclick for junk-only rolls',async()=>{
 let tick=0,actions=0,roll=0,current=netState([item(305)]);const batches=[netState([item(305),item(401,1,1)],0),netState([item(305),item(401,1,1),item(407,1,2)],10),netState([item(305),item(401,1,1),item(407,1,2),item(353,2,3),item(341,1,4),item(363,1,5)],195)];const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>false,interact:async(i,op)=>{expect(i).toBe(7);expect(op).toBe(1);actions++;return{success:true};},combine:async()=>({success:true}),step:async()=>{tick++;},wait:async(test)=>{tick++;current=batches[roll++]!;return test();}};const r=await runStagedFishing(d,{method:'bigNet',xpRate:1,amount:1,cap:100,maxAttempts:5,progressTicks:40});expect(r.caught).toBe(4);expect(r.byproducts).toEqual({401:1,407:1});expect(r.rawXp).toBe(1951);expect(r.publicXpDelta).toBe(195);expect(actions).toBe(1);expect(roll).toBe(3);
});
test('BigNet reserves nine free slots and junk-only catches cannot postpone the primary no-progress deadline',async()=>{
 let actions=0,tick=0,junk=0,current=netState([item(305),...Array.from({length:19},(_,i)=>item(9000+i,1,i+1))]);const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>false,interact:async()=>{actions++;return{success:true};},combine:async()=>({success:true}),step:async()=>{tick++;},wait:async(test)=>{tick++;current=netState([item(305),item(401,++junk,1)],0);return test();}};await expect(runStagedFishing(d,{method:'bigNet',xpRate:1,amount:1,cap:100,maxAttempts:5,progressTicks:4})).rejects.toThrow('free space');expect(actions).toBe(0);current=netState([item(305)]);await expect(runStagedFishing(d,{method:'bigNet',xpRate:1,amount:1,cap:100,maxAttempts:5,progressTicks:4})).rejects.toThrow('no progress');expect(actions).toBe(1);
});
test('BigNet unknown XP cannot authorize another input or a primary credit',async()=>{
 let tick=0,actions=0,current=netState([item(305)]);const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>false,interact:async()=>{actions++;return{success:true};},combine:async()=>({success:true}),step:async()=>{tick++;},wait:async(test)=>{tick++;current=netState([item(305),item(353,1,1)],999);return test();}};await expect(runStagedFishing(d,{method:'bigNet',xpRate:1,amount:1,cap:100,maxAttempts:5,progressTicks:40})).rejects.toThrow('XP receipt');expect(actions).toBe(1);
});
test('Lava uses exact oily rod/native800/Bait1 and reconciles one bait per60XP eel',async()=>{
 for(const badXp of[false,true]){let tick=0,actions=0,current=({...netState([item(1585),item(313,3,1)]),nearbyNpcs:[{index:8,id:800,x:2890,z:9766,distance:1,optionsWithIndex:[{text:'Bait',opIndex:1}]}]})as unknown as BotWorldState;const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>false,interact:async(i,op)=>{expect(i).toBe(8);expect(op).toBe(1);actions++;return{success:true};},combine:async()=>({success:true}),step:async()=>{tick++;},wait:async(test)=>{tick++;current={...current,inventory:[item(1585),item(313,2,1),item(2148,1,2)],skills:[{name:'Fishing',level:99,baseLevel:99,experience:badXp?59:60},{name:'Hitpoints',level:10,baseLevel:10,experience:1000}]}as unknown as BotWorldState;return test();}};const run=runStagedFishing(d,{method:'lava',xpRate:1,amount:1,cap:100,maxAttempts:5,progressTicks:40});if(badXp)await expect(run).rejects.toThrow('lava eel native XP');else expect(await run).toMatchObject({caught:1,baitUsed:1});expect(actions).toBe(1);}
});
test('BigNet keeps scalar XP and progress baselines when the SDK mutates one live snapshot',async()=>{
 let tick=0,actions=0,catches=0;const current=netState([item(305)]);const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>false,interact:async()=>{actions++;return{success:true};},combine:async()=>({success:true}),step:async()=>{tick++;},wait:async(test)=>{tick+=2;catches++;current.inventory=[item(305),item(353,catches,1)];current.skills[0]!.experience=catches*20;return test();}};const r=await runStagedFishing(d,{method:'bigNet',xpRate:1,amount:2,cap:20,maxAttempts:3,progressTicks:4});expect(r.caught).toBe(2);expect(r.rawXp).toBe(400);expect(actions).toBe(1);
});
test('new fishing methods honor declared native1/25 XP rates and park wrong-rate effects without another paid input',async()=>{
 for(const method of ['bigNet','lava'] as const)for(const rate of[1,25])for(const wrong of[false,true]){let tick=0,actions=0;const tool=method==='lava'?1585:305;let current=netState([item(tool),...method==='lava'?[item(313,3,1)]:[]]);if(method==='lava')current.nearbyNpcs=[{index:8,id:800,x:2890,z:9766,distance:1,optionsWithIndex:[{text:'Bait',opIndex:1}]}]as any;const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>false,interact:async()=>{actions++;return{success:true};},combine:async()=>({success:true}),step:async()=>{tick++;},wait:async(test)=>{tick++;current={...current,inventory:[item(tool),...method==='lava'?[item(313,2,1),item(2148,1,2)]:[item(353,1,1)]],skills:[{name:'Fishing',level:99,baseLevel:99,experience:(method==='lava'?60:20)*rate},{name:'Hitpoints',level:10,baseLevel:10,experience:1000}]}as BotWorldState;return test();}};const p=runStagedFishing(d,{method,xpRate:wrong?(rate===1?25:1):rate,amount:1,cap:30,maxAttempts:3,progressTicks:20});if(wrong)await expect(p).rejects.toThrow();else expect((await p).caught).toBe(1);expect(actions).toBe(1);}
});
test('Lava catch after a spot change during step credits the final bait before another dispatch',async()=>{for(const mode of ['ok','free-fish','wrong-xp','extra-fish']){let tick=0,actions=0;let current=netState([item(1585),item(313,1,1)]);current.nearbyNpcs=[{index:8,id:800,x:2890,z:9766,distance:1,optionsWithIndex:[{text:'Bait',opIndex:1}]}]as any;const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>false,interact:async()=>{actions++;return{success:true};},combine:async()=>({success:true}),wait:async(test)=>{tick++;current={...current,nearbyNpcs:[]};return test();},step:async()=>{tick++;current={...current,inventory:[item(1585),item(2148,mode==='extra-fish'?2:1,1),...mode==='free-fish'?[item(313,1,2)]:[]],skills:[{name:'Fishing',level:99,baseLevel:99,experience:mode==='wrong-xp'?59:60},{name:'Hitpoints',level:10,baseLevel:10,experience:1000}]}as any;}};const run=runStagedFishing(d,{method:'lava',xpRate:1,amount:1,cap:30,maxAttempts:3,progressTicks:20});if(mode==='ok')expect(await run).toMatchObject({caught:1,baitUsed:1});else await expect(run).rejects.toThrow('step catch/bait/XP');expect(actions).toBe(1);}});
for(const method of ['net','seaBait','fly','riverBait','cage','harpoon','karambwanji']as const)test(method+' credits a catch received in the inter-iteration tick before the next input',async()=>{const p=FISH_PROFILES[method];let tick=0,actions=0,current=netState([item(p.tool),...p.bait?[item(p.bait,1,1)]:[]]);current.nearbyNpcs=[{index:8,id:fishSpotIds(method)[0]!,x:2890,z:9766,distance:1,optionsWithIndex:[{text:p.label,opIndex:p.op}]}]as any;const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>false,interact:async()=>{actions++;return{success:true};},combine:async()=>({success:true}),wait:async(test)=>{tick++;current={...current,nearbyNpcs:[]};return test();},step:async()=>{tick++;current={...current,inventory:[item(p.tool),item(p.products[0],1,1)],skills:[{name:'Fishing',level:99,baseLevel:99,experience:60},{name:'Hitpoints',level:10,baseLevel:10,experience:1000}]}as any;}};expect(await runStagedFishing(d,{method,xpRate:1,amount:1,cap:30,maxAttempts:3,progressTicks:20})).toMatchObject({caught:1,baitUsed:p.bait?1:0});expect(actions).toBe(1);});

// Knife reset (FISH_KNIFE_RESET). The family of each method follows its attempt label in the server scripts: 'same'
// when the label re-ops on %action_delay = clock + 2 (a clock + 2 branch, or an else that re-ops), 'delayed' when it
// only rolls on %action_delay = map_clock, null when it never reads %action_delay.
test('knife reset family of each method matches its server attempt label',()=>{
 const dir=resolve(import.meta.dir,'../vendor/rs-sdk/server/content/scripts/skill_fishing/scripts/fishing_spots');
 const labels:Record<FishMethod,[string,string]>={net:['saltfish','attempt_fish_shrimp'],seaBait:['saltfish','attempt_fish_sardine'],fly:['freshfish','attempt_fish_trout_salmon'],riverBait:['freshfish','attempt_fish_pike'],cage:['rarefish','attempt_fish_lobster'],harpoon:['rarefish','attempt_fish_swordfish'],karambwanji:['tbwt','attempt_fish_karambwanji'],karambwan:['tbwt','attempt_fish_karambwan'],bigNet:['memberfish','attempt_fish_mackerel'],lava:['lavafish','attempt_fish_lava_eel']};
 expect(Object.keys(labels).sort()).toEqual(Object.keys(FISH_PROFILES).sort());
 for(const [method,[file,name]] of Object.entries(labels)){
  const text=readFileSync(resolve(dir,file+'.rs2'),'utf8').replace(/\r/g,''),at=text.indexOf(`[label,${name}]`),end=text.indexOf('\n[',at+1);
  expect(at).toBeGreaterThanOrEqual(0);
  const body=text.slice(at,end<0?undefined:end);
  const family=!/%action_delay/.test(body)?null:/map_clock \+ 2\)/.test(body)||/\}\s*else\s*\{\s*p_opnpc/.test(body)?'same':/%action_delay = map_clock\)/.test(body)?'delayed':'none';
  expect([method,family]).toEqual([method,FISH_KNIFE_RESET[method as FishMethod]]);
 }
});
test('knife cut sets the delay two ticks ahead only when it is past, and needs a knife and a log',()=>{
 expect(knifeDelay(5,10)).toBe(12);expect(knifeDelay(10,10)).toBe(10);expect(knifeDelay(13,10)).toBe(13);
 expect(knifeCut([item(KNIFE,1,4),item(NORMAL_LOGS,1,7)],99)).toEqual([{type:'useItemOnItem',sourceSlot:4,targetSlot:7},{type:'clickComponent',componentId:99}]);
 expect(knifeCut([item(KNIFE,1,4)],99)).toBeUndefined();
});
// A fake server: the cut sets %action_delay (cut_logs.rs2:83-84); a 'same' click rolls at the delay, a 'delayed' click
// rolls only when the delay is the click tick. Each roll catches one fish (50 XP) and uses one bait.
function knifeServer(method:FishMethod,spot:{x:number;z:number},player:{x:number;z:number}){
 const p=FISH_PROFILES[method],reset=FISH_KNIFE_RESET[method];
 const w={tick:0,delay:-10,rollAt:-1,xp:0,inv:[item(p.tool,1,0),item(KNIFE,1,1),item(NORMAL_LOGS,1,2),...p.bait?[item(p.bait,20,3)]:[]],player:{...player},sent:[] as {tick:number;types:string[]}[],stands:0};
 const st=()=>({player:{worldX:w.player.x,worldZ:w.player.z,level:0,lifeId:1},inventory:w.inv.map(i=>({...i})),dialog:{isOpen:false},skills:[{name:'Fishing',level:99,baseLevel:99,experience:w.xp},{name:'Hitpoints',level:10,baseLevel:10,experience:1000}],nearbyNpcs:[{index:8,id:fishSpotIds(method)[0]!,x:spot.x,z:spot.z,distance:1,reachable:true,optionsWithIndex:[{text:p.label,opIndex:p.op}]}]})as unknown as BotWorldState;
 const free=()=>[...Array(28).keys()].find(s=>!w.inv.some(i=>i.slot===s))!;
 const d:FishDriver={state:st,tick:()=>w.tick,stopped:()=>false,interact:async()=>{throw Error('knife mode clicks through send');},combine:async()=>({success:true}),wait:async()=>false,
  step:async()=>{w.tick++;if(w.rollAt===w.tick){w.xp+=50;w.inv.push(item(p.products[0]!,1,free()));if(p.bait)w.inv.find(i=>i.id===p.bait)!.count--;}},
  send:async(acts:FishAction[])=>{w.sent.push({tick:w.tick,types:acts.map(a=>a.type)});for(const a of acts){
   if(a.type==='dropItem')w.inv=w.inv.filter(i=>i.slot!==a.slot);
   if(a.type==='clickComponent')w.delay=knifeDelay(w.delay,w.tick);
   if(a.type==='interactNpc'){if(reset==='same'&&w.delay>=w.tick)w.rollAt=w.delay;if(reset==='delayed'&&w.delay===w.tick)w.rollAt=w.tick+1;}}},
  stand:async()=>{w.stands++;w.tick+=2;w.player={x:spot.x+1,z:spot.z};return true;}};
 return{w,d};
}
test('fly knife reset: drop, knife, Make 1, Lure and a close in one tick, one roll each 3 ticks',async()=>{
 const {w,d}=knifeServer('fly',{x:3238,z:3252},{x:3239,z:3252});
 const r=await runStagedFishing(d,{method:'fly',amount:4,cap:100,maxAttempts:5,progressTicks:40,knife:{make1:99,drop:true}});
 expect(r).toMatchObject({caught:4,baitUsed:4,attempts:4,knife:{reset:'same',dropped:3,stands:0}});
 expect(w.sent.map(s=>s.tick)).toEqual([0,3,6,9]);
 expect(w.sent[0]!.types).toEqual(['useItemOnItem','clickComponent','interactNpc','closeModal']);
 expect(w.sent[1]!.types).toEqual(['dropItem','useItemOnItem','clickComponent','interactNpc','closeModal']);
 expect(w.inv.filter(i=>i.id===NORMAL_LOGS).length).toBe(1);
});
test('cage knife reset: knife in T, close in T+1, click in T+2; a corner start stands beside the spot first',async()=>{
 const {w,d}=knifeServer('cage',{x:2924,z:3180},{x:2925,z:3181});
 const r=await runStagedFishing(d,{method:'cage',amount:3,cap:100,maxAttempts:5,progressTicks:40,knife:{make1:99}});
 expect(r).toMatchObject({caught:3,attempts:3,knife:{reset:'delayed',dropped:0,stands:1}});
 expect(w.sent.slice(0,3)).toEqual([{tick:2,types:['useItemOnItem','clickComponent']},{tick:3,types:['closeModal']},{tick:4,types:['interactNpc']}]);
 expect(w.sent[3]!.tick).toBe(5);
});
test('knife reset refuses karambwan, a missing log and a driver without send',async()=>{
 const base={amount:1,cap:100,maxAttempts:5,progressTicks:40,knife:{make1:99}};
 const {w,d}=knifeServer('fly',{x:3238,z:3252},{x:3239,z:3252});
 await expect(runStagedFishing({...d,send:undefined},{...base,method:'fly'})).rejects.toThrow('send and stand');
 w.inv=w.inv.filter(i=>i.id!==NORMAL_LOGS);await expect(runStagedFishing(d,{...base,method:'fly'})).rejects.toThrow('knife and logs');
 const k=knifeServer('karambwan',{x:2899,z:3118},{x:2900,z:3118});k.w.inv.push(item(3159,1,9));
 await expect(runStagedFishing(k.d,{...base,method:'karambwan'})).rejects.toThrow('no knife reset');
});
