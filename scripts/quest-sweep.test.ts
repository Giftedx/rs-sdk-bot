import {test,expect} from 'bun:test';
import {plan,needs,nearestBank,presetFor,leaveStronghold,walkCorridor,KARAMJA,gatherPlan,MILK,BUCKET,generalStores} from './quest-sweep';
import {equipment,questSweepChecks} from '../packages/practice/src/quest-sweep-proof';
import type {Session} from '../packages/core/src/inprocess';
import type {PathDeps,PathPoint,PathResult} from '../packages/core/src/walk';
import type {Tile} from '../packages/core/src/world';

// Retained bank-stage.log: goTo reported "no route to 2850,3175,0" after Brimhaven. The courier walks that tile
// as a tolerance-5 pass-by point of one walkPath call.
test('the Karamja corridor keeps courier waypoint tolerances and resumes from the unpassed point',async()=>{
 let pos={x:2800,z:3200,level:0};
 const calls:PathPoint[][]=[];
 const walk=(async(_d:PathDeps,points:PathPoint[])=>{
  calls.push(points);
  if(calls.length===1){pos={x:2851,z:3176,level:0};return{ok:false,next:3,detail:'stalled'} as PathResult;}
  pos={x:2954,z:3147,level:0};return{ok:true,next:points.length} as PathResult;
 }) as unknown as typeof import('../packages/core/src/walk').walkPath;
 const r=await walkCorridor({pos:()=>pos} as unknown as PathDeps,KARAMJA,walk);
 expect(calls[0]).toEqual([{x:2774,z:3228,tol:3},{x:2800,z:3200,tol:5},{x:2850,z:3175,tol:5},{x:2920,z:3160,tol:5},{x:2956,z:3146,tol:3}]);
 expect(calls[1]).toEqual([{x:2920,z:3160,tol:5},{x:2956,z:3146,tol:3}]);
 expect(r).toEqual({ok:true,at:{x:2954,z:3147,level:0}});
});

test('a corridor that never reaches the last point fails after three bounded tries',async()=>{
 let n=0;
 const walk=(async()=>{n++;return{ok:false,next:0,detail:'no path'} as PathResult;}) as unknown as typeof import('../packages/core/src/walk').walkPath;
 const r=await walkCorridor({pos:()=>({x:2800,z:3200,level:0})} as unknown as PathDeps,KARAMJA,walk);
 expect(n).toBe(3);
 expect(r.ok).toBe(false);
});

test('asset equality treats an empty worn row as absent and still sees a worn item',()=>{
 const pack={93:[{slot:0,id:995,count:362}]};
 expect(equipment({inventories:pack} as any)).toBe(equipment({inventories:{...pack,94:[],95:[]}} as any));
 expect(equipment({inventories:pack} as any)).not.toBe(equipment({inventories:{...pack,94:[{slot:3,id:1351,count:1}]}} as any));
});

test('Sheep Shearer proof requires completion 22 and 3750 decoded Crafting XP at 25x',()=>{
 const before:Parameters<typeof questSweepChecks>[1]={
  version:9,position:{x:2459,z:3385,level:0},vars:{179:0,101:3},inventories:{},
  skills:Array.from({length:21},(_,index)=>({index,rawExperience:1000,xp:100,level:10})),
 };
 const after=structuredClone(before);
 after.vars[179]=22;after.vars[101]=4;
 after.skills[12]!.rawExperience+=37500;after.skills[12]!.xp+=3750;
 const record={id:'bank-stage',exit:0,timedOut:false,saveMatched:true,seconds:0};
 const checks=()=>questSweepChecks('bank-stage',before,after,'',record);
 expect(checks()).toMatchObject({quest:true,reward:true});
 after.vars[179]=21;
 expect(checks()).toMatchObject({quest:false,reward:true});
 after.vars[179]=22;
 after.skills[12]!.rawExperience=before.skills[12]!.rawExperience+375000;
 after.skills[12]!.xp=before.skills[12]!.xp+37500;
 expect(checks()).toMatchObject({quest:true,reward:false});
});

test('retained Ghost verification requires the saved skull debit, exact Prayer reward and protected supplies',()=>{
 const before:Parameters<typeof questSweepChecks>[1]={version:10,position:{x:3113,z:9555,level:0},vars:{107:4,101:12},
  inventories:{93:[{slot:0,id:553,count:1},{slot:1,id:556,count:3}],94:[{slot:2,id:552,count:1}],95:[{slot:0,id:1436,count:243}]},
  skills:Array.from({length:21},(_,index)=>({index,rawExperience:0,xp:0,level:index===3?26:1}))};
 const after=structuredClone(before);after.position={x:3246,z:3193,level:0};after.vars[107]=5;after.vars[101]=13;after.inventories[93]!.shift();after.skills[5]!.rawExperience=281250;after.skills[5]!.xp=28125;
 const log='START 3113 9555 0\nQUEST_SWEEP_RETAINED_SKULL {}\nGHOST_RETAINED_SKULL {}\nQUEST_SWEEP_FLAG {"name":"The Restless Ghost","state":"complete"}\nRESULT ok qp=1\nLOGOUT logged-out\n';
 const verify=()=>questSweepChecks('retained-ghost',before,after,log,{id:'retained-ghost',exit:0,timedOut:false,saveMatched:true,seconds:0});
 expect(Object.values(verify()).every(Boolean)).toBe(true);
 after.skills[5]!.rawExperience=28125;expect(verify()).toMatchObject({reward:false});after.skills[5]!.rawExperience=281250;
 after.inventories[95]![0]!.count--;expect(verify().assets).toBe(false);after.inventories[95]![0]!.count++;
 after.inventories[93]!.push({slot:0,id:553,count:1});expect(verify()).toMatchObject({skull:false});
 after.inventories[93]!.pop();const banked=structuredClone(before);banked.position={x:3094,z:3491,level:0};banked.inventories[93]!.shift();banked.inventories[95]!.push({slot:1,id:553,count:1});
 const withdrawal='QUEST_SWEEP_WITHDRAW {"id":553,"count":1,"before":0,"after":1,"bankBefore":1,"bankAfter":0,"observed":true}\n';
 const bankVerify=(text:string)=>questSweepChecks('banked-ghost',banked,after,text,{id:'banked-ghost',exit:0,timedOut:false,saveMatched:true,seconds:0});
 expect(Object.values(bankVerify(log+withdrawal)).every(Boolean)).toBe(true);expect(bankVerify(log)).toMatchObject({bankedSkull:false});
});

test('the plan withdraws what the pack lacks and names what the bank cannot cover',()=>{
 const need=needs({inventory:[{id:434,count:1},{id:434,count:5},{id:436,count:4},{id:440,count:2}]});
 expect(need.get(434)).toBe(6);
 const p=plan(need,[{id:434,count:2}],[{id:434,count:10},{id:436,count:1}]);
 expect(p.withdraw).toEqual([{id:434,count:4},{id:436,count:1}]);
 expect(p.missing).toEqual([{id:436,count:3},{id:440,count:2}]);
 expect(plan(need,[{id:434,count:6},{id:436,count:4},{id:440,count:2}],[])).toEqual({withdraw:[],missing:[]});
});

test('preset food is split from the quest items',()=>{
 const preset={inventory:[{id:434,count:6},{id:379,count:4}]};
 expect([...needs(preset)]).toEqual([[434,6]]);
 expect([...needs(preset,true)]).toEqual([[379,4]]);
 expect(needs({coins:200}).get(995)).toBe(200);
});

test('the nearest bank is on the same floor and closest by tiles',()=>{
 expect(nearestBank({x:3222,z:3218,level:0})).toMatchObject({x:3269,z:3167});
 expect(nearestBank({x:2930,z:3450,level:0})).toMatchObject({x:2947,z:3368});
});

test('Gnome entry selects Ardougne north; distance selection alone does not prove its approach',()=>{
 expect(nearestBank({x:2459,z:3385,level:0})).toMatchObject({x:2618,z:3332,level:0});
});

test('north-side bank entry opens gate190 at its loc tile and observes the southern landing',async()=>{
 let player={worldX:2459,worldZ:3385,level:0},tick=0;
 const clicks:unknown[]=[],walks:unknown[]=[];
 const listeners=new Set<()=>void>();
 const s={sdk:{getState:()=>({player})},tick:()=>tick,
  onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
  direct:async(a:any)=>{clicks.push(a);return{success:true};}} as unknown as Session;
 const timer=setInterval(()=>{tick++;if(clicks.length)player={worldX:2461,worldZ:3382,level:0};for(const cb of listeners)cb();},1);
 try{
  const result=await leaveStronghold(s,async(to)=>{walks.push(to);player={worldX:to.x,worldZ:to.z,level:0};return{ok:true};});
  expect(walks).toEqual([{x:2461,z:3385,level:0}]);
  expect(clicks).toEqual([{type:'interactLoc',x:2459,z:3383,locId:190,optionIndex:1,reason:'SDK'}]);
  expect(result.ok).toBe(true);
  expect(player.worldZ).toBe(3382);
 }finally{clearInterval(timer);}
});

test('every swept quest has a start tile, and an unknown quest refuses',()=>{
 expect(presetFor('doric').position).toMatchObject({level:0});
 expect(()=>presetFor('nosuchquest')).toThrow('no preset');
});

test('missing items a shop sells are bought with coins taken for them; unsold items stay missing', () => {
    const { shopPlan } = require('./quest-sweep');
    const item = (id: number) => ({ 1944: { debugname: 'egg', name: 'Egg', cost: 4 }, 1927: { debugname: 'bucket_milk', name: 'Bucket of milk', cost: 6 }, 753: { debugname: 'cadavaberries', name: 'Cadava berries', cost: 1 } } as any)[id];
    const seller = (d: string) => d === 'cadavaberries' ? null : { npc: 'Shop keeper', npcId: 1, tile: { x: 1, z: 1, level: 0 } };
    const p = shopPlan([{ id: 1944, count: 1 }, { id: 1927, count: 2 }, { id: 753, count: 1 }], { x: 0, z: 0, level: 0 }, item, seller);
    expect(p.buys.map((b: any) => [b.id, b.count])).toEqual([[1944, 1], [1927, 2]]);
    expect(p.unsold).toEqual([{ id: 753, count: 1 }]);
    expect(p.coins).toBe(3 * 4 + 3 * 6 * 2 + 100);
    expect(shopPlan([], { x: 0, z: 0, level: 0 }, item, seller).coins).toBe(0);
});

test('an unsold item is gathered from a ground spawn or, for milk, a cow and a bucket; the rest stays missing',()=>{
 const at={x:3200,z:3200,level:0},spawns=(id:number)=>id===753?[{x:3266,z:3361,level:0}]:[];
 const g=gatherPlan([{id:753,count:1},{id:MILK,count:1},{id:440,count:2}],at,spawns);
 expect(g.gathers).toEqual([{id:753,count:1,how:'spawn'},{id:MILK,count:1,how:'milk'}]);
 expect(g.tools).toEqual([{id:BUCKET,count:1}]);
 expect(g.still).toEqual([{id:440,count:2}]);
});

test('a nearer spawn beats a far shop; a nearer shop keeps the item in the shop plan',()=>{
 const at={x:3222,z:3218,level:0},spawns=(id:number)=>id===1944?[{x:3226,z:3299,level:0}]:[];
 expect(gatherPlan([{id:1944,count:1}],at,spawns,()=>500).gathers).toEqual([{id:1944,count:1,how:'spawn'}]);
 expect(gatherPlan([{id:1944,count:1}],at,spawns,()=>20).still).toEqual([{id:1944,count:1}]);
 expect(gatherPlan([{id:MILK,count:1}],at,spawns,()=>30).still).toEqual([{id:MILK,count:1}]);
});

test('general stores come nearest first, one tile per keeper, and only general shops',()=>{
 const t=(x:number,z:number)=>({x,z,level:0});
 const sellers=new Map([['torch',[{shop:'generalshop7',npc:'Shop keeper',npcId:532,spawns:[t(2902,3146)],stock:1},{shop:'junglestore',npc:'Jiminua',npcId:560,spawns:[t(2767,3122)],stock:1}]],['pot',[{shop:'generalshop7',npc:'Shop keeper',npcId:532,spawns:[t(2902,3146)],stock:1},{shop:'generalshop1',npc:'Shop keeper',npcId:520,spawns:[t(3212,3246)],stock:1}]]]) as any;
 expect(generalStores(t(2768,3118),sellers).map(s=>s.npcId)).toEqual([532,520]);
});

test('garlic comes from the Draynor cupboard when the only seller is far away',()=>{
 const at={x:3092,z:3243,level:0};
 expect(gatherPlan([{id:1550,count:1}],at,()=>[],()=>600).gathers).toEqual([{id:1550,count:1,how:'loc'}]);
});

test('a quest keeps its own items and every untradeable item out of the unneeded deposit',async()=>{
 const {keepsItem}=await import('./quest-sweep');
 const tradeable=(id:number)=>id===1438?true:id===291?false:undefined;
 expect(keepsItem('runemysteries',1438,tradeable)).toBe(true);
 expect(keepsItem('runemysteries',291,tradeable)).toBe(true);
 expect(keepsItem('sheep',291,tradeable)).toBe(true);
 expect(keepsItem('sheep',1438,tradeable)).toBe(false);
 expect(keepsItem('sheep',995,tradeable)).toBe(false);
});

test('withdrawal slots count a stack once and nothing for a stack the pack already holds; deposits free whole kinds and spare coins, food and quest items',async()=>{
 const {slotsFor,depositPlan,QUEST_PICKUP_SLOTS,slotNeed}=await import('./quest-sweep');
 const pack=[{id:995,count:500},...Array.from({length:5},()=>({id:385,count:1})),{id:1351,count:1},{id:590,count:1},{id:1438,count:1}];
 expect(slotsFor([{id:995,count:190}],pack)).toBe(0);
 expect(slotsFor([{id:563,count:1},{id:556,count:5}],pack)).toBe(2);
 expect(slotsFor([{id:1933,count:3},{id:995,count:190}],pack)).toBe(3);
 const keep=(id:number)=>id===1438;
 expect(depositPlan(pack,3,keep)).toEqual([]);
 const full=[{id:995,count:500},...Array.from({length:20},()=>({id:385,count:1})),...Array.from({length:6},()=>({id:1351,count:1})),{id:1438,count:1}];
 expect(full.length).toBe(28);
 expect(depositPlan(full,3,keep)).toEqual([{id:1351,count:-1}]);
 // Six axes free six slots; the seventh to tenth come from food beyond the allowance of eight.
 expect(depositPlan(full,10,keep)).toEqual([{id:1351,count:-1},{id:385,count:4}]);
 // A pack of 27 sharks and coins: only food can go, and only as much as the slots need.
 const sharks=[{id:995,count:30},...Array.from({length:27},()=>({id:385,count:1}))];
 expect(depositPlan(sharks,3,keep)).toEqual([{id:385,count:3}]);
 // The allowance holds food back while the need and the coins leave room (seven units at a need of 20); a need of 28 leaves none.
 expect(depositPlan(sharks,20,keep)).toEqual([{id:385,count:20}]);
 expect(depositPlan(sharks,28,keep)).toEqual([{id:385,count:27}]);
 // Three pots of flour plus the pickup reserve: a full pack of sharks banks eleven and keeps sixteen.
 expect(depositPlan(sharks,slotsFor([{id:1933,count:3}],sharks)+QUEST_PICKUP_SLOTS,keep)).toEqual([{id:385,count:11}]);
 // An edible quest ingredient the preset needs (Family Crest's cooked fish, 5) is kept whatever the pressure.
 const fishy=[{id:995,count:30},...Array.from({length:5},()=>({id:333,count:1})),...Array.from({length:22},()=>({id:385,count:1}))];
 expect(depositPlan(fishy,27,id=>id===333)).toEqual([{id:385,count:22}]);
 // Twenty balls of wool beside the coins: the reserve gives way to two slots and five sharks stay.
 const nine=[{id:995,count:30},...Array.from({length:9},()=>({id:385,count:1}))];
 expect(slotNeed(20,1)).toBe(22);
 expect(depositPlan(nine,slotNeed(20,1),keep)).toEqual([{id:385,count:4}]);
 // Demon Slayer's 25 bones and two rune stacks beside the coins: 27 slots, no food, the reserve floor cannot fit.
 const cakes=[{id:995,count:21000},...Array.from({length:7},()=>({id:1895,count:1}))];
 expect(slotNeed(27,1)).toBe(27);
 expect(depositPlan(cakes,slotNeed(27,1),keep)).toEqual([{id:1895,count:7}]);
 // Three pots of flour beside the coins keep the whole reserve and allowance.
 expect(slotNeed(3,1)).toBe(11);
});

test('a far start walks hub to hub in hops of at most 150 tiles that each bring the goal nearer; a near start has no hops',async()=>{
 const {hopsTo,MAX_HOP}=await import('./quest-sweep');
 const mansion={x:2740,z:3577,level:0},sarim={x:3013,z:3207,level:0};
 const hops=hopsTo(sarim,mansion);
 expect(hops.length).toBeGreaterThan(0);
 let at=sarim;
 for(const h of hops){expect(Math.max(Math.abs(h.x-at.x),Math.abs(h.z-at.z))).toBeLessThanOrEqual(MAX_HOP);at=h;}
 expect(Math.max(Math.abs(at.x-mansion.x),Math.abs(at.z-mansion.z))).toBeLessThanOrEqual(MAX_HOP);
 expect(hopsTo({x:3254,z:3420,level:0},{x:3185,z:3440,level:0})).toEqual([]);
 // A goal on another level gets no ground hubs.
 expect(hopsTo(sarim,{x:3209,z:3222,level:1})).toEqual([]);
});

test('an account left underground heads for the bank above it, and the sweep eats from 60 percent of its hitpoints',async()=>{
 const {nearestBanks,surfaceOf,eatAtFor}=await import('./quest-sweep');
 expect(surfaceOf({x:3120,z:9567,level:0})).toEqual({x:3120,z:3167,level:0});
 expect(surfaceOf({x:3120,z:3167,level:0})).toEqual({x:3120,z:3167,level:0});
 // The skull basement under the Wizards' Tower: Draynor, not Seers' Village.
 expect((nearestBanks({x:3120,z:9567,level:0})[0] as {site?:string})?.site).toBe('bank:draynor-bank:0');
 expect(eatAtFor(37)).toBe(22);expect(eatAtFor(99)).toBe(59);expect(eatAtFor(10)).toBe(10);
});

test('a seller across the water ranks behind one on the same landmass, and swordfish is food the deposit plan keeps',async()=>{
 const {sellersByTravel,travelDistance,SEA,depositPlan,isEdible}=await import('./quest-sweep');
 const alKharid={x:3269,z:3167,level:0},hamab={x:2781,z:2793,level:0},kortan={x:2615,z:3292,level:0};
 expect(travelDistance(alKharid,hamab)).toBe(488+SEA);
 expect(travelDistance(alKharid,kortan)).toBe(654);
 expect(sellersByTravel([{npc:'Hamab',tile:hamab},{npc:'Kortan',tile:kortan}],alKharid).map(s=>s.npc)).toEqual(['Kortan','Hamab']);
 // The Miscellania and Etceteria food shops lie across the water from Ardougne, past the seller limit; Rellekka does not.
 const ardougne={x:2655,z:3283,level:0},miscellania={x:2516,z:3864,level:0},etceteria={x:2602,z:3876,level:0},rellekka={x:2644,z:3680,level:0};
 expect(travelDistance(ardougne,miscellania)).toBe(581+SEA);expect(travelDistance(ardougne,etceteria)).toBe(593+SEA);
 expect(travelDistance(ardougne,rellekka)).toBe(397);expect(travelDistance(miscellania,etceteria)).toBe(86);
 expect(isEdible(373)).toBe(true);expect(isEdible(1895)).toBe(true);expect(isEdible(1387)).toBe(false);
 // TheFullMonty's pack: the staff, pots and talisman go; the allowance keeps five swordfish and two of four cake slices.
 const pack=[{id:995,count:17400},{id:1387,count:1},{id:1931,count:1},{id:1931,count:1},{id:1931,count:1},{id:1438,count:1},...Array.from({length:5},()=>({id:373,count:1})),...Array.from({length:4},()=>({id:1895,count:1}))];
 expect(depositPlan(pack,20,()=>false)).toEqual([{id:1387,count:-1},{id:1931,count:-1},{id:1438,count:-1},{id:1895,count:2}]);
});

test('a preset\'s trout and bread are optional food, its bananas and ale are quest items',async()=>{
 const {needs}=await import('./quest-sweep');
 const death={inventory:[...Array(10).fill({id:2309,count:1}),...Array(10).fill({id:333,count:1}),{id:1905,count:1},{id:2064,count:1}]} as any;
 expect([...needs(death).keys()]).toEqual([1905,2064]);
 expect(needs(death,true).get(333)).toBe(10);expect(needs(death,true).get(2309)).toBe(10);
 const hunt={inventory:[...Array(10).fill({id:1963,count:1})]} as any;
 expect(needs(hunt).get(1963)).toBe(10);
});

test('the hub chain toward an upstairs target is the chain toward the ground beneath it',async()=>{
 const {hopsTo}=await import('./quest-sweep');
 const ardougne={x:2684,z:3318,level:0},cupboard={x:3096,z:3268,level:1};
 expect(hopsTo(ardougne,cupboard)).toEqual([]);
 const hops=hopsTo(ardougne,{...cupboard,level:0});
 expect(hops.length).toBeGreaterThan(1);
 expect(hops.every(h=>h.level===0)).toBe(true);
});

test('a far walk from the Ardougne side to anywhere east of x 2950 crosses by the boats, whatever the floor',async()=>{
 const {eastOfArdougne}=await import('./quest-sweep');
 const ardougne={x:2655,z:3283,level:0};
 expect(eastOfArdougne(ardougne,{x:3108,z:3356,level:1})).toBe(true);   // Draynor Manor upstairs
 expect(eastOfArdougne(ardougne,{x:3190,z:3272,level:0})).toBe(true);   // Fred's farm
 expect(eastOfArdougne(ardougne,{x:2684,z:3318,level:0})).toBe(false);  // Ardougne itself
 expect(eastOfArdougne({x:3092,z:3243,level:0},{x:3222,z:3218,level:0})).toBe(false); // Draynor to Lumbridge
 expect(eastOfArdougne({x:2655,z:3283,level:1},{x:3222,z:3218,level:0})).toBe(false); // from upstairs: climb down first
});

test('the edible part of a preset\'s needs is reserved for the eaters',async()=>{
 const {reservedEdible}=await import('./quest-sweep');
 // Pirate's Treasure: 10 bananas (edible) and a white apron; Family Crest: 5 cooked trout.
 expect(reservedEdible(new Map([[1963,10],[1005,1]]))).toEqual({1963:10});
 expect(reservedEdible(new Map([[333,5],[995,100]]))).toEqual({333:5});
 expect(reservedEdible(new Map())).toEqual({});
 // Black Knight's Fortress carries a cabbage to eat nowhere but the hole: the preset's own needs reserve it.
 const {PRESETS}=await import('../packages/practice/src/presets');
 expect(reservedEdible(needs(PRESETS.quest_blackknight!))).toEqual({1965:1});
});

test('a meat no shop sells is a kill from its animal; an item with no source stays missing',async()=>{
 const {killSpawns,KILL_SOURCES}=await import('../packages/core/src/gather');
 const lumbridge={x:3222,z:3218,level:0};
 const plan=gatherPlan([{id:2132,count:1},{id:2134,count:1},{id:1759,count:3}],lumbridge,()=>[],()=>Infinity,id=>id===2132?[{x:3200,z:3260,level:0}]:[]);
 expect(plan.gathers).toEqual([{id:2132,count:1,how:'kill'}]);
 expect(plan.still).toEqual([{id:2134,count:1},{id:1759,count:3}]);
 // A shop that sells the item wins over the kill when it is nearer; Rufus 850 tiles away loses to the cows at 42.
 expect(gatherPlan([{id:2132,count:1}],lumbridge,()=>[],()=>30,id=>[{x:3200,z:3260,level:0}]).gathers).toEqual([]);
 expect(gatherPlan([{id:2132,count:1}],lumbridge,()=>[],()=>850,id=>[{x:3200,z:3260,level:0}]).gathers).toEqual([{id:2132,count:1,how:'kill'}]);
 // Cows, chickens, giant rats, bears and goblins have spawns in the knowledge.
 for(const id of Object.keys(KILL_SOURCES).map(Number))expect(killSpawns(id).length).toBeGreaterThan(0);
 // A bear (combat 21) is a kill only above Attack 21; a giant rat (6) dies to anyone.
 const bearSpawn=(id:number)=>id===2136||id===2134?[{x:2500,z:3160,level:0}]:[];
 expect(gatherPlan([{id:2136,count:1},{id:2134,count:1}],lumbridge,()=>[],()=>Infinity,bearSpawn,6)).toMatchObject({gathers:[{id:2134,how:'kill'}],still:[{id:2136,count:1}]});
 expect(gatherPlan([{id:2136,count:1}],lumbridge,()=>[],()=>Infinity,bearSpawn,21).still).toEqual([{id:2136,count:1}]);
 expect(gatherPlan([{id:2136,count:1}],lumbridge,()=>[],()=>Infinity,bearSpawn,22).gathers).toEqual([{id:2136,count:1,how:'kill'}]);
});

test('a spawn on another floor is found, after a nearer one on the same floor',async()=>{
 const {spawnsByDistance,LEVEL_STEP}=await import('../packages/core/src/spawn-index');
 const list=new Map([[272,[{x:3108,z:3356,level:1}]],[273,[{x:3097,z:3366,level:0},{x:3100,z:3350,level:1}]]]);
 const manor={x:3100,z:3350,level:0};
 expect(spawnsByDistance(272,manor,list)).toEqual([{x:3108,z:3356,level:1}]);
 expect(spawnsByDistance(273,manor,list).map(t=>t.level)).toEqual([0,1]);
 // From upstairs the same-floor spawn comes first unless the ground one is more than LEVEL_STEP tiles nearer.
 expect(spawnsByDistance(273,{...manor,level:1},list).map(t=>t.level)).toEqual([1,0]);
 const far=new Map([[275,[{x:3097,z:3366,level:0},{x:3097+LEVEL_STEP+1,z:3366,level:1}]]]);
 expect(spawnsByDistance(275,{x:3097,z:3366,level:1},far).map(t=>t.level)).toEqual([0,1]);
});

test('a bow and arrows let the Ranged level count against an animal, and the plan asks for the kit',async()=>{
 const {killStyle,rangedKit,BOWS,ARROWS_PER_KILL}=await import('../packages/core/src/gather');
 expect(killStyle(2136,6,1)).toBeNull();            // bear, Attack 6, no kit
 expect(killStyle(2136,6,97)).toBe('ranged');       // bear, Ranged 97 with a kit
 expect(killStyle(2134,6,97)).toBe('melee');        // a giant rat dies to anyone
 expect(killStyle(2136,22,97)).toBe('ranged');      // the bow when Ranged is the higher level: melee is bare-handed
 expect(killStyle(2136,68,97)).toBe('ranged');      // UnderMyKilt live: Attack 68, Ranged 97, a bow in the bank
 expect(killStyle(2136,70,40)).toBe('melee');       // melee when Attack is the higher level and beats the animal
 // A series of goblin kills for their mail takes the bow when Ranged beats Attack, and melee without a kit.
 expect(killStyle(288,6,97)).toBe('ranged');expect(killStyle(288,6,1)).toBe('melee');expect(killStyle(288,40,30)).toBe('melee');
 const {arrowsFor,killAttempts:attempts}=await import('../packages/core/src/gather');
 expect(arrowsFor(288,3)).toBe(2*attempts(288,3));expect(arrowsFor(2136,1)).toBe(6);
 // The arrow kind owned in the greatest number: UnderMyKilt's 21 bronze over 19 iron.
 expect(rangedKit([{id:841,count:1},{id:884,count:19},{id:882,count:21}])).toEqual({bow:841,arrows:882});
 expect(rangedKit([{id:841,count:1},{id:884,count:19}])).toEqual({bow:841,arrows:884});
 expect(rangedKit([{id:841,count:1},{id:882,count:3}])).toBeNull();   // too few arrows
 expect(rangedKit([{id:884,count:50}])).toBeNull();                   // no bow
 expect(BOWS).toContain(841);expect(ARROWS_PER_KILL).toBeGreaterThan(0);
 // Every-kill drops get a few misses' worth of attempts; goblin mail at 5 in 128 gets half again its expected kills.
 const {killAttempts}=await import('../packages/core/src/gather');
 expect(killAttempts(2132,1)).toBe(5);
 expect(killAttempts(288,3)).toBe(Math.ceil(3/(5/128)*1.5)+3);
 const bearSpawn=(id:number)=>id===2136?[{x:2500,z:3160,level:0}]:[];
 const lumbridge={x:3222,z:3218,level:0};
 expect(gatherPlan([{id:2136,count:1}],lumbridge,()=>[],()=>Infinity,bearSpawn,6,97).gathers).toEqual([{id:2136,count:1,how:'kill',kit:'ranged'}]);
 expect(gatherPlan([{id:2136,count:1}],lumbridge,()=>[],()=>Infinity,bearSpawn,6,1).still).toEqual([{id:2136,count:1}]);
});

test('a spawn across the Karamja water ranks a sea farther',async()=>{
 const {spawnsByDistance,onKaramja,SEA}=await import('../packages/core/src/spawn-index');
 const musaPoint={x:2796,z:3165,level:0};
 expect(onKaramja(musaPoint)).toBe(true);expect(onKaramja({x:2684,z:3318})).toBe(false);
 const list=new Map([[2347,[{x:2934,z:3286,level:0},{x:2684,z:3318,level:0}]]]);
 // From Musa Point both hammer spawns lie across the water: the nearer by straight line still comes first.
 expect(spawnsByDistance(2347,musaPoint,list)[0]).toEqual({x:2934,z:3286,level:0});
 // From the Karamja shore a spawn on the island beats one on the mainland that is nearer by straight line.
 const list2=new Map([[1917,[{x:2970,z:3150,level:0},{x:2800,z:3180,level:0}]]]);
 expect(spawnsByDistance(1917,{x:2940,z:3150,level:0},list2)[0]).toEqual({x:2800,z:3180,level:0});
 expect(SEA).toBe(1000);
});

test('a dye is a recipe: its ingredients are planned first, its dialogue step follows, and its coins are counted',async()=>{
 const {NPC_SOURCES,COMBINE_SOURCES,PICK_SOURCES}=await import('../packages/core/src/gather');
 const draynor={x:3092,z:3243,level:0};
 const spawns=(id:number)=>id===1951?[{x:3267,z:3371,level:0}]:[];           // redberries lie near Varrock
 const seller=(id:number)=>id===1957?300:Infinity;                           // onions from Hudo's shop
 const plan=gatherPlan([{id:1769,count:1},{id:1767,count:1}],draynor,spawns,seller,()=>[],6,1,()=>[]);
 expect(plan.gathers).toEqual([
  {id:1951,count:3,how:'spawn'},          // red dye's berries
  {id:1763,count:1,how:'npc'},            // red dye at Aggie
  {id:1765,count:1,how:'npc'},            // yellow dye at Aggie (onions come from the shop)
  {id:1769,count:1,how:'combine'},        // orange = red on yellow
  {id:1793,count:2,how:'npc'},            // 2 woad leaves from Wyson
  {id:1767,count:1,how:'npc'},            // blue dye at Aggie
 ]);
 expect(plan.still).toEqual([{id:1957,count:2}]);
 expect(plan.coins).toBe(5+5+20+5);
 expect(NPC_SOURCES[1763]!.needs).toEqual([{id:1951,count:3}]);expect(COMBINE_SOURCES[1769]).toEqual([1763,1765]);expect(PICK_SOURCES[1957]!.loc).toBe(3366);
 // A plant nearer than any seller is picked.
 const picked=gatherPlan([{id:1957,count:2}],{x:2600,z:3000,level:0},()=>[],()=>Infinity,()=>[],6,1,()=>[{x:2581,z:2968,level:0}]);
 expect(picked.gathers).toEqual([{id:1957,count:2,how:'pick'}]);
});

test('plant tiles come from the knowledge and rank by distance',async()=>{
 const {locsByDistance,pickableTiles}=await import('../packages/core/src/spawn-index');
 const m=new Map([[3366,[{x:2581,z:2984,level:0},{x:2583,z:2981,level:0}]]]);
 expect(locsByDistance(3366,{x:2584,z:2980,level:0},m)[0]).toEqual({x:2583,z:2981,level:0});
 expect(pickableTiles(3366).length).toBeGreaterThan(0);   // onions
 expect(pickableTiles(1161).length).toBeGreaterThan(0);   // cabbages
 expect(pickableTiles(999999)).toEqual([]);
});

test('the way down from an upstairs shop is the nearest descending transport, and the tile beneath when there is none',async()=>{
 const {wayDown}=await import('./quest-sweep');
 const t=(name:string,from:{x:number;z:number;level:number},to:{x:number;z:number;level:number})=>({locName:name,option:'op1',from,to,exact:false,src:'',toSrc:'',handler:''}) as any;
 // Hudo's counter on the Grand Tree's first floor: the ladder at 2466,3495 (knowledge/transports.json), not the wall
 // beneath; a ladder up, one on another floor and one 100 tiles away do not count.
 const transports=[t('ladder',{x:2466,z:3495,level:1},{x:2466,z:3495,level:0}),t('grandtree_laddermiddle',{x:2466,z:3495,level:1},{x:2466,z:3495,level:2}),
  t('ladder',{x:2466,z:3495,level:2},{x:2466,z:3495,level:1}),t('stairs',{x:2549,z:3508,level:1},{x:2549,z:3508,level:0})];
 expect(wayDown(transports,{x:2449,z:3508,level:1})).toEqual({x:2466,z:3495,level:0});
 expect(wayDown([],{x:2449,z:3508,level:1})).toEqual({x:2449,z:3508,level:0});
});

test('arrows stack in the slot count, and a destination east of Ardougne adds the boat fares to the coin budget',async()=>{
 const {slotsFor,fares,BOAT_FARES}=await import('./quest-sweep');
 // 238 bronze arrows with none in the pack: one slot; a pack stack of them: none.
 expect(slotsFor([{id:882,count:238}],[])).toBe(1);
 expect(slotsFor([{id:882,count:217}],[{id:882,count:21}])).toBe(0);
 const ardougne={x:2655,z:3283,level:0},wyson={x:3027,z:3379,level:0},aggie={x:3086,z:3259,level:0},hudo={x:2448,z:3509,level:1};
 expect(fares(ardougne,[wyson,aggie])).toBe(BOAT_FARES);
 expect(fares(ardougne,[hudo])).toBe(0);
 expect(fares({x:3092,z:3243,level:0},[wyson,aggie])).toBe(0);
});

test('a strike spell kit is the strongest strike the runes allow, and the highest level that beats the animal picks the style',async()=>{
 const {magicKit,castsFor,killStyle,gatherPlan,killAttempts}=await import('../packages/core/src/gather');
 // TheFullMonty: Magic 99, a staff of fire, 500 air and 500 mind runes: Fire Strike at 2 air and 1 mind a cast.
 const monty=[{id:1387,count:1},{id:556,count:500},{id:558,count:500}];
 expect(magicKit(monty,99)).toEqual({staff:1387,component:'magic:fire_strike',level:13,maxhit:8,runes:{558:1,556:2}});
 // Without the staff the fire runes are missing: Wind Strike from air and mind alone; nothing below six casts' worth.
 expect(magicKit([{id:556,count:500},{id:558,count:500}],99)?.component).toBe('magic:wind_strike');
 expect(magicKit([{id:556,count:5},{id:558,count:5}],99)).toBeNull();
 expect(magicKit(monty,12)?.component).toBe('magic:wind_strike');
 // Attack 69 with Strength 1 and Ranged 1 does not beat a goblin series bare-handed; Magic 99 does. A rat stays melee.
 expect(killStyle(288,69,1,1,1)).toBeNull();
 expect(killStyle(288,69,1,99,1)).toBe('magic');
 expect(killStyle(2134,69,1,99,1)).toBe('melee');
 expect(killStyle(2136,68,97,99,68)).toBe('magic');
 expect(killStyle(2136,68,97,1,68)).toBe('ranged');
 // Casts: the combat level over the max hit at three in five, plus one: two Fire Strikes or six Wind Strikes a goblin.
 expect(castsFor(288,3,8)).toBe(3*killAttempts(288,3));
 expect(castsFor(288,3,2)).toBe(6*killAttempts(288,3));
 expect(castsFor(2136,1,8)).toBe(Math.ceil(21/8/0.6)+1);
 const plan=gatherPlan([{id:288,count:3}],{x:3014,z:3204,level:0},()=>[],()=>Infinity,undefined,69,1,undefined,99,1);
 expect(plan.gathers).toEqual([{id:288,count:3,how:'kill',kit:'magic'}]);
});

test('a kill series keeps to dense spawn clusters',async()=>{
 const {denseSpawns,killSpawns}=await import('../packages/core/src/gather');
 const goblins=killSpawns(288),dense=denseSpawns(goblins);
 const near=(x:number,z:number,list:readonly {x:number;z:number}[])=>list.some(t=>Math.max(Math.abs(t.x-x),Math.abs(t.z-z))<=5);
 // Lumbridge, Port Sarim and the Goblin Village stay; the lone goblins east of Varrock go.
 expect(near(3250,3240,dense)).toBe(true);expect(near(3004,3201,dense)).toBe(true);expect(near(2955,3500,dense)).toBe(true);
 expect(near(3259,3338,goblins)).toBe(true);expect(near(3259,3338,dense)).toBe(false);expect(near(3311,3375,dense)).toBe(false);
});

test('a cabbage is picked from a field nearer than any seller',async()=>{
 const {gatherPlan,PICK_SOURCES}=await import('../packages/core/src/gather');
 const {locsByDistance}=await import('../packages/core/src/spawn-index');
 expect(PICK_SOURCES[1965]?.loc).toBe(1161);
 // From the Falador east bank a cabbage field lies within 100 tiles; Hudo's shop in the Grand Tree is 470 away.
 const falador={x:3013,z:3355,level:0};
 expect(Math.max(Math.abs(locsByDistance(1161,falador)[0]!.x-falador.x),Math.abs(locsByDistance(1161,falador)[0]!.z-falador.z))).toBeLessThan(100);
 expect(gatherPlan([{id:1965,count:1}],falador,()=>[],()=>470).gathers).toEqual([{id:1965,count:1,how:'pick'}]);
});

test('the tool plan keeps the quest its own runes beside the casts',async()=>{
 const {toolPlan}=await import('./quest-sweep');
 const need=new Map([[556,3]]),tools=[{id:556,count:714}];
 // The quest plan takes its 3 air from a bank of 714: the casts get the other 711 and 3 are short for the shop plan.
 expect(toolPlan(tools,need,[],[],[{id:556,count:714}],[{id:556,count:3}])).toEqual({withdraw:[{id:556,count:711}],missing:[{id:556,count:3}]});
 // The quest's 3 air already in the pack are not the casts': all 714 come out of the bank.
 expect(toolPlan(tools,need,[{id:556,count:3}],[],[{id:556,count:714}],[])).toEqual({withdraw:[{id:556,count:714}],missing:[]});
 // A tool the quest does not need is planned as before, a worn bow counts as held.
 expect(toolPlan([{id:841,count:1},{id:882,count:40}],need,[],[{id:841,count:1}],[{id:882,count:21}],[])).toEqual({withdraw:[{id:882,count:21}],missing:[{id:882,count:19}]});
});

test('the way up to an upstairs target is the ground foot of the nearest ascending transport, followed down from a middle floor',async()=>{
 const {wayUp}=await import('./quest-sweep');
 const t=(from:{x:number;z:number;level:number},to:{x:number;z:number;level:number})=>({locName:'ladder',option:'op1',from,to,exact:false,src:'',toSrc:'',handler:''}) as any;
 // Hudo's counter on the Grand Tree's first floor: the ladder base at 2466,3495, not the wall beneath the counter; a way
 // down, one onto another floor and one 100 tiles off do not count. A second-floor target follows the middle ladder down.
 const transports=[t({x:2466,z:3495,level:0},{x:2466,z:3495,level:1}),t({x:2466,z:3495,level:1},{x:2466,z:3495,level:0}),
  t({x:2466,z:3495,level:1},{x:2466,z:3495,level:2}),t({x:2549,z:3508,level:0},{x:2549,z:3508,level:1})];
 expect(wayUp(transports,{x:2448,z:3509,level:1})).toEqual({x:2466,z:3495,level:0});
 expect(wayUp(transports,{x:2460,z:3500,level:2})).toEqual({x:2466,z:3495,level:0});
 expect(wayUp([],{x:2448,z:3509,level:1})).toEqual({x:2448,z:3509,level:0});
 expect(wayUp(transports,{x:3000,z:3000,level:0})).toEqual({x:3000,z:3000,level:0});
});

test('a field on the tour of the other sellers and the quest start replaces a purchase; a field off it does not',async()=>{
 const {pickInstead,detour,tourOrder}=await import('./quest-sweep');
 const ard={x:2655,z:3283,level:0},mso={x:2595,z:3087,level:1},wydin={x:3014,z:3204,level:0},hudo={x:2448,z:3509,level:1},start={x:3047,z:3256,level:0};
 const lumbridge={x:3188,z:3266,level:0},yanille={x:2581,z:2968,level:0};
 const fields=(id:number,at:Tile)=>id===1957?[lumbridge,yanille].sort((a,b)=>Math.max(Math.abs(a.x-at.x),Math.abs(a.z-at.z))-Math.max(Math.abs(b.x-at.x),Math.abs(b.z-at.z))):[];
 const buy=(id:number,count:number,npc:string,tile:Tile)=>({id,count,name:npc,npcId:1,npc,tile});
 // TheFullMonty's Goblin Diplomacy from the Ardougne bank: an air rune in Yanille, redberries from Wydin, onions from
 // Hudo. The purchases run Yanille, Port Sarim (419 from Yanille against Hudo's 422), then 566 tiles back west: the
 // onion field adds far less to the tour, so the onions are picked and the shop list keeps the other two.
 const buys=[buy(1951,3,'Wydin',wydin),buy(1957,2,'Hudo',hudo),buy(556,1,'Magic store owner',mso)];
 expect(tourOrder(ard,buys.map(b=>b.tile))).toEqual([mso,wydin,hudo]);
 const r=pickInstead(buys,ard,start,fields);
 expect(r.buys.map(b=>b.npc)).toEqual(['Wydin','Magic store owner']);
 expect(r.picks.map(p=>({id:p.id,count:p.count}))).toEqual([{id:1957,count:2}]);
 expect(r.picks[0]!.detours.field).toBeLessThan(r.picks[0]!.detours.seller);
 expect(r.picks[0]!.detours.seller).toBe(detour([ard,mso,wydin,start],hudo));
 // Onions alone from the Ardougne bank for a quest starting in Ardougne: Hudo is the smaller detour and stays a purchase.
 const alone=pickInstead([buy(1957,2,'Hudo',hudo)],ard,{x:2662,z:3305,level:0},fields);
 expect(alone.buys.map(b=>b.npc)).toEqual(['Hudo']);
 expect(alone.picks).toEqual([]);
 // An item no field grows is never switched.
 expect(pickInstead([buy(1951,3,'Wydin',wydin)],ard,start,fields)).toEqual({buys:[buy(1951,3,'Wydin',wydin)],picks:[]});
 expect(detour([ard],hudo)).toBe(226);
 expect(detour([],hudo)).toBe(0);
});
