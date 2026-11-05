import {test,expect} from 'bun:test';
import {plan,needs,nearestBank,presetFor,leaveStronghold,walkCorridor,KARAMJA,gatherPlan,MILK,BUCKET,generalStores} from './quest-sweep';
import {equipment,questSweepChecks} from '../packages/practice/src/quest-sweep-proof';
import type {Session} from '../packages/core/src/inprocess';
import type {PathDeps,PathPoint,PathResult} from '../packages/core/src/walk';

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
 const {slotsFor,depositPlan}=await import('./quest-sweep');
 const pack=[{id:995,count:500},...Array.from({length:5},()=>({id:385,count:1})),{id:1351,count:1},{id:590,count:1},{id:1438,count:1}];
 expect(slotsFor([{id:995,count:190}],pack)).toBe(0);
 expect(slotsFor([{id:563,count:1},{id:556,count:5}],pack)).toBe(2);
 expect(slotsFor([{id:1933,count:3},{id:995,count:190}],pack)).toBe(3);
 const keep=(id:number)=>id===1438;
 expect(depositPlan(pack,3,keep)).toEqual([]);
 const full=[{id:995,count:500},...Array.from({length:20},()=>({id:385,count:1})),...Array.from({length:6},()=>({id:1351,count:1})),{id:1438,count:1}];
 expect(full.length).toBe(28);
 expect(depositPlan(full,3,keep)).toEqual([1351]);
 expect(depositPlan(full,10,keep)).toEqual([1351]);
});
