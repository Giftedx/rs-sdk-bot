import {test,expect} from 'bun:test';
import {heckelDustNeed,groundShopNeeds,fetchHeckelDust,heckelIO,type HeckelIO} from './quest-sweep';
import {returnToAmik,finishBlackKnight,type AmikIO} from './quest-sweep';
import {scorpionBarcrawlNeeds} from './quest-sweep';
import {establishBarcrawlGate} from './generated/quest-barcrawl';
import {questScriptId} from './quest-sweep';
import {resolve} from 'node:path';

test('the Barcrawl script starts under the name the sweep gives it',()=>{
 const file=resolve(import.meta.dir,'generated','quest-barcrawl.ts');
 expect(questScriptId(file)).toBe('quest-barcrawl');
 expect(questScriptId('scripts/generated/quest-barcrawl.ts')).toBe('quest-barcrawl');
 const guard=/QUEST_SCRIPT_ID === '([^']+)'\) await main\(\)/.exec(readFileSync(file,'utf8'));
 expect(guard?.[1]).toBe(questScriptId(file));
});

test('Scorpion stages and establishes a missing Barcrawl gate before the outpost',async()=>{
 const base=needs(presetFor('scorpion'),false,'scorpion');
 expect([...scorpionBarcrawlNeeds(base,2)]).toEqual([...base]);
 expect([...scorpionBarcrawlNeeds(base,0)]).toEqual([[995,268],[563,3],[556,11],[555,1],[554,1]]);
 let gate=0,runs=0;
 await establishBarcrawlGate(()=>gate,async()=>{runs++;gate=2;});
 expect({gate,runs}).toEqual({gate:2,runs:1});
 await establishBarcrawlGate(()=>gate,async()=>{runs++;});
 expect(runs).toBe(1);
 gate=0;
 await expect(establishBarcrawlGate(()=>gate,async()=>{})).rejects.toThrow('Barcrawl gate state 2 unobserved');
});

test('only a started Black Knight journal selects the Amik return',()=>{
 expect(returnToAmik('blackknight','started')).toBe(true);
 for(const state of ['not started','unknown','complete'])expect(returnToAmik('blackknight',state)).toBe(false);
 expect(returnToAmik('priest','started')).toBe(false);
});

test('Amik return observes travel, both stairs and completion, or quotes his refusal',async()=>{
 let pos={x:3016,z:3512,level:0},done=false,finish=true;
 const calls:unknown[]=[];
 const io:AmikIO={pos:()=>pos,travel:async to=>{calls.push(to);pos=to;return{ok:true};},
  climb:async(loc,level)=>{calls.push(loc);pos={x:loc.x,z:loc.z,level};return true;},
  talk:async()=>{done=finish;return "I haven't managed to find what the secret weapon is yet.";},complete:()=>done};
 expect(await finishBlackKnight(io)).toEqual({ok:true});
 expect(calls).toEqual([{x:2955,z:3337,level:0},{id:1738,x:2954,z:3338},{id:1738,x:2960,z:3338}]);
 finish=false;
 expect(await finishBlackKnight(io)).toEqual({ok:false,detail:'Sir Amik did not complete quest; observed dialogue: "I haven\'t managed to find what the secret weapon is yet."'});
 io.climb=async()=>true;
 expect(await finishBlackKnight(io)).toMatchObject({ok:false,detail:expect.stringContaining('2954,3338 to level 1 unobserved')});
});

test('Black Knight saved proof requires three QP, 2500 coins, retained assets and logout',()=>{
 const before:Parameters<typeof questSweepChecks>[1]={version:10,position:{x:3016,z:3512,level:0},vars:{130:3,101:12},
  inventories:{93:[{id:995,slot:0,count:490},{id:433,slot:1,count:1}]},
  skills:Array.from({length:21},(_,index)=>({index,rawExperience:0,xp:0,level:index===3?10:1}))};
 const after=structuredClone(before);after.position={x:2960,z:3336,level:2};after.vars[130]=4;after.vars[101]=15;
 after.inventories[93]![0]!.count+=2500;
 const log='START 3016 3512 0\nQUEST_SWEEP_FLAG {"name":"Black Knight\'s Fortress","state":"complete"}\nLOGOUT logged-out\nRESULT ok quest-sweep blackknight quest complete qp=3\n';
 const verify=(text=log)=>questSweepChecks('blackknight-finish',before,after,text,{id:'blackknight-finish',exit:0,timedOut:false,saveMatched:true,seconds:1});
 expect(Object.values(verify()).every(Boolean)).toBe(true);
 after.vars[130]=3;expect(verify()).toMatchObject({quest:false});after.vars[130]=4;
 after.vars[101]=14;expect(verify()).toMatchObject({quest:false});after.vars[101]=15;
 after.inventories[93]![0]!.count--;expect(verify()).toMatchObject({assets:false,reward:false});after.inventories[93]![0]!.count++;
 after.inventories[93]![1]!.count=0;expect(verify().assets).toBe(false);after.inventories[93]![1]!.count=1;
 expect(verify(log.replace('LOGOUT logged-out','')).logout).toBe(false);
 expect(verify(log+'MILESTONE amik 1\n')).toMatchObject({skipped:false});
});

test('Heckel stages the southern gate, observes the north side, and names a failed gate leg',async()=>{
 let pos={x:2615,z:3332,level:0},gateFail=false,gateMoves=true;
 const calls:string[]=[];
 const io:HeckelIO={pos:()=>pos,held:()=>0,coins:()=>106,
  travel:async to=>{calls.push(`travel ${to.x},${to.z},${to.level}`);pos=to;return{ok:true};},
  gate:async()=>{calls.push('gate');if(gateFail)throw Error('Femi unresolved');if(gateMoves)pos={x:2461,z:3385,level:0};},
  walk:async()=>({ok:false}),climb:async()=>{},open:async()=>false,row:()=>undefined,buy:async()=>{},close:async()=>{},wait:async ok=>ok()};
 await fetchHeckelDust(io);
 expect(calls).toEqual(['travel 2461,3382,0','gate','travel 2493,3488,0']);
 calls.length=0;pos={x:2493,z:3488,level:0};await fetchHeckelDust(io);
 expect(calls).toEqual(['travel 2493,3488,0']);
 calls.length=0;pos={x:2615,z:3332,level:0};gateFail=true;
 expect(await fetchHeckelDust(io)).toMatchObject({ok:false,detail:expect.stringContaining('gate leg 2461,3382,0 -> 2461,3385,0 failed: Error: Femi unresolved')});
 expect(calls).toEqual(['travel 2461,3382,0','gate']);
 gateFail=false;gateMoves=false;pos={x:2615,z:3332,level:0};
 expect(await fetchHeckelDust(io)).toMatchObject({ok:false,detail:expect.stringContaining('north arrival unobserved')});
});
import {readFileSync} from 'node:fs';
import {leaveToManorTrip,plan,mealPlan,walkFar,needs,nearestBank,presetFor,leaveStronghold,leaveFortress,walkCorridor,KARAMJA,gatherPlan,MILK,BUCKET,generalStores,sweep,fetchManorFishFood,manorFoodNeed,manorPoisonNeed,reserveInputSlots,FOOD,type ManorIO} from './quest-sweep';
import {spawnsByDistance} from '../packages/core/src/spawn-index';

import {questDefinitions} from '../packages/core/src/quest-status';
import {BotSDK} from '../vendor/rs-sdk/sdk';
import {equipment,questSweepChecks} from '../packages/practice/src/quest-sweep-proof';
import type {Session} from '../packages/core/src/inprocess';
import type {PathDeps,PathPoint,PathResult} from '../packages/core/src/walk';
import type {Tile} from '../packages/core/src/world';
import {reachStart} from './quest-sweep';
import {findLongPath} from '../vendor/rs-sdk/sdk/pathfinding';
import {returnFishingContestTrophy} from './quest-walk';
import {downward} from './quest-sweep';
import {teleportRefusal} from './generated/quest-lib';
import {vampireOpening} from './generated/quest-vampire';
import {totemJournalStage,readTotemStage,totemBoat,completeTotem} from './generated/quest-totem';
import {componentId} from '../packages/core/src/logout';
import {questGatherPlan,shopPlan} from './quest-sweep';
import {nearestSeller,sellersByDistance} from '../packages/core/src/shop-index';
import {hasJulietMessage,rjJournalStage,readRjStage} from './generated/quest-rj';
import {wornKitPlan,wearQuestKit} from './quest-sweep';

test('ball stages required gloves through bank or shop, selects only owned scimitar and observes worn kit',async()=>{
 const base=needs(presetFor('ball')),bank=[{id:1059,count:1},{id:1331,count:1}];
 const kit=wornKitPlan('ball',base,[{id:1985,count:1}],bank,[{id:1381,count:1}]);
 expect(plan(kit.need,[{id:1985,count:1}],bank)).toEqual({withdraw:bank,missing:[]});
 const absent=wornKitPlan('ball',base,[{id:1985,count:1}],[],[]);
 expect(absent.wear).toEqual([{id:1059,required:true}]);
 const missing=plan(absent.need,[{id:1985,count:1}],[]).missing;
 expect(missing).toEqual([{id:1059,count:1}]);
 const items=JSON.parse(readFileSync(new URL('../knowledge/items.json',import.meta.url),'utf8'));
 const shop=shopPlan(missing,{x:2947,z:3368,level:0},id=>items.find((i:any)=>i.id===id),nearestSeller);
 expect(shop.unsold).toEqual([]);expect(shop.buys).toMatchObject([{id:1059,count:1}]);
 expect(shop.coins).toBeGreaterThan(0);
 expect(wornKitPlan('ball',base,[],[],[{id:1059,count:1}]).need.has(1059)).toBe(false);
 expect(wornKitPlan('rj',base,[],bank,[])).toEqual({need:base,wear:[]});
 const worn:{id:number;count:number}[]=[],inventory=[...bank];
 let apply=true;
 const s={sdk:{getState:()=>({inventory}),getEquipment:()=>worn},ended:Promise.resolve({reason:'fixture'}),onTick:()=>()=>{},
  bot:{equipItem:async(row:{id:number;count:number})=>{if(apply)worn.push(row);return{success:true};}}} as unknown as Session;
 expect(await wearQuestKit(s,kit.wear)).toBeNull();
 expect(worn.map(i=>i.id)).toEqual([1059,1331]);
 worn.length=0;apply=false;
 expect(await wearQuestKit(s,absent.wear)).toBe('required worn item 1059 equip unobserved');
 inventory.length=0;
 expect(await wearQuestKit(s,absent.wear)).toBe('required worn item 1059 unavailable');
});

test('Romeo and Juliet letter predicates ignore Pirate message before acquisition and after handover',()=>{
 const inventory=[{id:433,name:'Pirate message',count:1}];
 const msgItem=()=>hasJulietMessage(inventory);
 expect(msgItem()).toBe(false);
 inventory.push({id:755,name:'Message',count:1});
 expect(msgItem()).toBe(true);
 inventory.splice(inventory.findIndex(i=>i.id===755),1);
 expect(inventory).toEqual([{id:433,name:'Pirate message',count:1}]);
 expect(!msgItem()).toBe(true);
 expect(hasJulietMessage([{id:755,count:0}])).toBe(false);
});

test('ball saved proof requires worn gloves, retained staff, quest XP, four QP and logout',()=>{
 const before:Parameters<typeof questSweepChecks>[1]={version:10,position:{x:2947,z:3368,level:0},vars:{226:0,101:0},
  inventories:{93:[{slot:0,id:1985,count:1}],94:[{slot:2,id:589,count:1},{slot:3,id:1381,count:1}],95:[{slot:0,id:1059,count:1},{slot:1,id:1331,count:1}]},
  skills:Array.from({length:21},(_,index)=>({index,rawExperience:0,xp:0,level:index===3?77:1}))};
 const after=structuredClone(before);after.position={x:2928,z:3456,level:0};after.vars[226]=7;after.vars[101]=4;after.skills[3]!.rawExperience=1581250;
 after.inventories={93:[{slot:0,id:1381,count:1},{slot:1,id:2409,count:1},{slot:2,id:2411,count:1}],
  94:[{slot:2,id:589,count:1},{slot:3,id:1331,count:1},{slot:9,id:1059,count:1}],95:[]};
 const log='START 2947 3368 0\n'+[1059,1331].map(id=>`QUEST_SWEEP_WITHDRAW ${JSON.stringify({id,count:1,observed:true})}\nQUEST_SWEEP_WORN ${JSON.stringify({id,observed:true})}\n`).join('')
  +'QUEST_SWEEP_FLAG {"name":"Witch\'s House","state":"complete"}\nRESULT ok qp=4 eats=0\nLOGOUT logged-out\n';
 const verify=(text=log)=>questSweepChecks('ball-worn-kit',before,after,text,{id:'ball-worn-kit',exit:0,timedOut:false,saveMatched:true,seconds:0});
 expect(Object.values(verify()).every(Boolean)).toBe(true);
 after.skills[3]!.rawExperience--;expect(verify()).toMatchObject({reward:false});after.skills[3]!.rawExperience++;
 after.vars[101]=3;expect(verify()).toMatchObject({quest:false});after.vars[101]=4;
 after.inventories[93]!.shift();expect(verify().assets).toBe(false);
 expect(verify(log.replace('LOGOUT logged-out','')).logout).toBe(false);
 after.inventories[94]!.pop();expect(verify()).toMatchObject({worn:false});
});

test('Romeo and Juliet saved proof requires exact berry cost, five QP, retained Pirate message and logout',()=>{
 const before:Parameters<typeof questSweepChecks>[1]={version:10,position:{x:3210,z:3423,level:0},vars:{144:30,101:0},
  inventories:{93:[{slot:0,id:433,count:1},{slot:1,id:753,count:1},{slot:2,id:995,count:754},{slot:3,id:952,count:1}],95:[{slot:0,id:995,count:183752}],94:[{slot:4,id:1005,count:1}]},
  skills:Array.from({length:21},(_,index)=>({index,rawExperience:0,xp:0,level:index===3?40:index===0?55:1}))};
 const after=structuredClone(before);after.vars[144]=100;after.vars[101]=5;
 after.inventories[93]!.splice(1,1);
 const log='START 3210 3423 0\nRJ_STAGE {"stage":30}\nQUEST_SWEEP_FLAG {"name":"Romeo & Juliet","state":"complete"}\nRESULT ok qp=5 eats=0\nLOGOUT logged-out\n';
 const verify=(text=log)=>questSweepChecks('rj-pirate-started',before,after,text,{id:'rj-pirate-started',exit:0,timedOut:false,saveMatched:true,seconds:0});
 expect(Object.values(verify()).every(Boolean)).toBe(true);
 after.vars[144]=30;expect(verify()).toMatchObject({quest:false});after.vars[144]=100;
 after.vars[101]=4;expect(verify()).toMatchObject({quest:false});after.vars[101]=5;
 after.inventories[93]!.push({slot:1,id:753,count:1});expect(verify()).toMatchObject({assets:false,questItems:false});after.inventories[93]!.pop();
 after.inventories[93]![0]!.count=0;expect(verify()).toMatchObject({assets:false,pirateMessage:false});after.inventories[93]![0]!.count=1;
 after.inventories[93]![1]!.count--;expect(verify()).toMatchObject({assets:false});after.inventories[93]![1]!.count++;
 expect(verify(log.replace('LOGOUT logged-out',''))).toMatchObject({logout:false});
 expect(verify(log.replace('"state":"complete"','"state":"started"'))).toMatchObject({questList:false});
});

test('RJ reads the fresh journal and refuses an unobserved stage instead of treating missing letters as completion',async()=>{
 const texts=['I can start this quest by talking to @dre@Romeo', 'I should go and speak to @dre@Juliet',
  'I should take the @dre@message@dbl@ from @dre@Juliet@dbl@ to @dre@Romeo',
  'I should find @dre@Father Lawrence@dbl@ and see how we can help',
  'I need to find the @dre@Apothecary@dbl@ to make a @dre@cadava potion',
  'I should take these @dre@cadava berries@dbl@ to the @dre@Apothecary',
  "I have to find @dre@Romeo@dbl@ and tell him what's happened.",'QUEST COMPLETE!'];
 texts.forEach((text,i)=>expect(rjJournalStage(text)).toBe([0,10,20,30,40,50,60,100][i]));
 expect(rjJournalStage('I should take this @dre@cadava potion@dbl@ to @dre@Juliet')).toBe(50);
 expect(rjJournalStage('I will have to find some @dre@cadava berries')).toBe(50);
 expect(rjJournalStage('started')).toBeUndefined();
 let allowOpen=true,body=texts[6]!;
 const commands:string[]=[],client={mainModalId:8134,ifType:(id:number)=>({text:id===8144?'Romeo & Juliet':id===8145?body:''})};
 const q={s:{client,sdk:{getDialog:()=>({isOpen:false})},direct:async(a:any)=>{
  commands.push(a.type);if(a.type==='closeModal')client.mainModalId=-1;
  if(a.type==='clickComponent'){expect(a.componentId).toBe(componentId('questlist:romeojuliet'));if(allowOpen){client.mainModalId=8134;body=texts[3]!;}}
  return{success:true};
 }},waitUntil:async(f:()=>boolean)=>f()} as unknown as Parameters<typeof readRjStage>[0];
 expect(await readRjStage(q)).toBe(30);
 expect(commands).toEqual(['closeModal','clickComponent','closeModal']);
 allowOpen=false;await expect(readRjStage(q)).rejects.toThrow('stage unobserved');
});

test('Hunt buys its missing apron from Thessalia instead of selecting Wydin back-room spawn',()=>{
 const at={x:3092,z:3243,level:0},missing=[{id:1963,count:3},{id:1005,count:1}];
 const items=JSON.parse(readFileSync(new URL('../knowledge/items.json',import.meta.url),'utf8'));
 const item=(id:number)=>items.find((i:any)=>i.id===id);
 const distance=(id:number)=>{const s=nearestSeller(item(id).debugname,at)!;return Math.max(Math.abs(s.tile.x-at.x),Math.abs(s.tile.z-at.z));};
 expect(spawnsByDistance(1005,at)).toContainEqual(expect.objectContaining({x:3010,z:3208,level:0}));
 expect(gatherPlan(missing,at,spawnsByDistance,distance).gathers).toContainEqual({id:1005,count:1,how:'spawn'});
 const gather=questGatherPlan('hunt',missing,at,distance);
 expect(gather.gathers).toEqual([]);
 const shop=shopPlan(gather.still,at,item,nearestSeller);
 expect(shop.unsold).toEqual([]);
 expect(shop.buys).toMatchObject([{id:1963,count:3,npcId:557},{id:1005,count:1,npcId:548,npc:'Thessalia',tile:{x:3204,z:3417,level:0}}]);
 expect(questGatherPlan('cog',[{id:1005,count:1}],at,distance).gathers).toEqual([{id:1005,count:1,how:'spawn'}]);
});

test('hunt reserves ten nonstackable bananas and a bought apron before gathering from a crowded pack',async()=>{
 const inventory=[{id:995,count:402},{id:1925,count:1},{id:555,count:2},
  ...Array.from({length:8},()=>({id:1891,count:1})),{id:1893,count:1},
  ...Array.from({length:2},()=>({id:1895,count:1})),...Array.from({length:5},()=>({id:373,count:1})),
  {id:952,count:1},{id:556,count:6},...Array.from({length:7},()=>({id:1963,count:1}))];
 const bank:{id:number;count:number}[]=[],deposits:number[]=[];
 const s={client:{objType:(id:number)=>({stackable:[995,555,556].includes(id)})},sdk:{getState:()=>({inventory,bank:{items:bank}})},
  bot:{depositItem:async(row:{id:number})=>{
   deposits.push(row.id);const count=inventory.filter(i=>i.id===row.id).reduce((n,i)=>n+i.count,0);
   for(let i=inventory.length-1;i>=0;i--)if(inventory[i]!.id===row.id)inventory.splice(i,1);
   bank.push({id:row.id,count});return{success:true};
  }}} as unknown as Session;
 expect(inventory).toHaveLength(28);
 const inputs=[{id:1963,count:3},{id:1005,count:1},{id:995,count:100},{id:556,count:5}];
 const keep=new Set([...needs(presetFor('hunt')).keys(),555,556,1891,1893,1895,...inputs.map(i=>i.id)]);
 expect(await reserveInputSlots(s,inputs,keep)).toBeNull();
 expect(deposits).toEqual([1925,373]);
 expect(bank).toEqual([{id:1925,count:1},{id:373,count:5}]);
 expect(inventory.filter(i=>i.id===1963)).toHaveLength(7);
 expect(inventory.filter(i=>i.id===1891)).toHaveLength(8);
 inventory.push(...Array.from({length:3},()=>({id:1963,count:1})),{id:1005,count:1});
 expect(inventory.filter(i=>i.id===1963)).toHaveLength(10);
 expect(inventory.length).toBeLessThanOrEqual(28);
});

test('Totem reads fresh journal text instead of guessing a stage from the started colour',async()=>{
 const texts=['I can start this quest by speaking to @dre@Kangai Mau',
  'I need to get into @dre@Lord Handelmorts Mansion',
  'I should get the R.P.D.T. men to deliver the crate now.',
  'I should get Wizard Cromperty to teleport me inside now.',
  'I got the R.P.D.T. men to deliver the teleport block to Lord Handelmort and teleported myself inside.',
  'QUEST COMPLETE!'];
 texts.forEach((text,stage)=>expect(totemJournalStage(text)).toBe(stage));
 expect(totemJournalStage('started')).toBeUndefined();
 let body=texts[3]!,allowOpen=true;
 const commands:string[]=[],client={mainModalId:8134,ifType:(id:number)=>({text:id===8144?'@dre@Tribal Totem':id===8145?body:''})};
 const q={s:{client,sdk:{getDialog:()=>({isOpen:false})},direct:async(a:any)=>{
  commands.push(a.type);if(a.type==='closeModal')client.mainModalId=-1;
  if(a.type==='clickComponent'){expect(a.componentId).toBe(componentId('questlist:totem'));if(allowOpen){client.mainModalId=8134;body=texts[1]!;}}
  return{success:true};
 }},waitUntil:async(f:()=>boolean)=>f()} as unknown as Parameters<typeof readTotemStage>[0];
 expect(await readTotemStage(q)).toBe(1);
 expect(commands).toEqual(['closeModal','clickComponent','closeModal']);
 allowOpen=false;
 await expect(readTotemStage(q)).rejects.toThrow('stage unobserved');
});

test('Totem customs crossing requires the paid fare and observed mainland landing',async()=>{
 let coins=60,position={x:2791,z:3183,level:0},land=true;
 const q={s:{} as Session,cnt:()=>coins,lvl:()=>position.level,near:(x:number,z:number,tol:number)=>Math.max(Math.abs(position.x-x),Math.abs(position.z-z))<=tol,
  guard:async()=>{},walk:async(_label:string,points:PathPoint[])=>{position={...points.at(-1)!,level:0};}};
 const route=(async(_s,legs)=>{
  const leg=legs[0]!;if(leg.kind!=='travel')throw Error('expected travel');
  expect(leg.travel.id).toBe('npc:customs_officer:ardougne@2772,3231');
  expect(leg.travel.coins).toBe(30);coins-=30;
  if(land)position=leg.to;
  return{ok:true,ticks:1};
 }) as typeof import('../packages/core/src/walk').walkRoute;
 await totemBoat(q,'npc:customs_officer:ardougne@2772,3231',route);
 expect(coins).toBe(30);expect(position.x).toBeLessThan(2745);
 coins=29;await expect(totemBoat(q,'npc:customs_officer:ardougne@2772,3231',route)).rejects.toThrow('missing fare');
 coins=60;land=false;await expect(totemBoat(q,'npc:customs_officer:ardougne@2772,3231',route)).rejects.toThrow('arrival/fare unobserved');
});

test('Totem stages owned cakes and all three fares from the mainland without buying food',()=>{
 const preset=presetFor('totem'),required=needs(preset),optional=needs(preset,true);
 expect(required.get(995)).toBe(90);
 expect(required.has(1891)).toBe(false);
 const meals=plan(optional,[],[{id:1891,count:15},{id:1893,count:1},{id:1895,count:2}]);
 expect(meals.withdraw).toContainEqual({id:1891,count:8});
 expect(meals.withdraw).toContainEqual({id:1893,count:1});
 expect(meals.withdraw).toContainEqual({id:1895,count:2});
});

test('Totem mainland entry uses Barnaby and preserves both remaining fares without whole-world planning',async()=>{
 const player={worldX:2571,worldZ:3250,level:0},listeners=new Set<()=>void>(),boats:string[]=[];
 let tick=0,coins=90;
 const s={sdk:{getState:()=>({player,inventory:[{id:995,count:coins}]})},tick:()=>tick,
  onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);}} as unknown as Session;
 const deps:PathDeps={pos:()=>({x:player.worldX,z:player.worldZ,level:0}),onTick:s.onTick,locs:()=>[],
  interactLoc:()=>{throw Error('unexpected interaction');},plan:(level,from,to)=>findLongPath(level,from.x,from.z,to.x,to.z),
  walk:(x,z)=>{player.worldX=x;player.worldZ=z;}};
 const world={route:()=>{throw Error('whole-world planning must not delay Totem entry');},blockedDoors:()=>[]};
 const route=(async(_s,legs)=>{
  const leg=legs[0]!;if(leg.kind!=='travel')throw Error('expected travel');boats.push(leg.travel.id);coins-=leg.travel.coins;
  player.worldX=leg.to.x;player.worldZ=leg.to.z;return{ok:true,ticks:1};
 }) as typeof import('../packages/core/src/walk').walkRoute;
 const timer=setInterval(()=>{tick++;for(const cb of listeners)cb();},1);
 try{
  await reachStart(s,world,presetFor('totem').position,'totem',async()=>deps,route);
  expect(boats).toEqual(['npc:captain_barnaby:brimhaven@2679,3275']);expect(coins).toBe(60);
  expect(Math.max(Math.abs(player.worldX-2791),Math.abs(player.worldZ-3183))).toBeLessThanOrEqual(3);
  player.worldX=2571;player.worldZ=3250;coins=89;
  await expect(reachStart(s,world,presetFor('totem').position,'totem',async()=>deps,route)).rejects.toThrow('missing 995:90');
 }finally{clearInterval(timer);}
},30000);

test('Totem keeps the unstarted opening and skips finished crate steps for each observed started stage',async()=>{
 for(const initial of [0,1,2,3,4]){
  let stage=initial,label=false;
  const actions:string[]=[],texts=['I can start this quest by speaking to Kangai Mau','I need to get into Lord Handelmorts Mansion','to deliver the crate now','I should get Wizard Cromperty to teleport me inside now','teleported myself inside'];
  const client={ingame:true,mainModalId:-1,ifType:(id:number)=>({colour:id===componentId('questlist:totem')?(stage===0?0xf80000:0xf8f800):undefined,
   text:id===8144?'Tribal Totem':id===8145?texts[stage]:''})};
  const q={s:{client,sdk:{getDialog:()=>({isOpen:false}),getSkill:(name:string)=>({level:name==='Magic'?1:99})},direct:async(a:any)=>{
   client.mainModalId=a.type==='closeModal'?-1:8134;return{success:true};
  }},waitUntil:async(f:()=>boolean)=>f(),pos:()=>({worldX:2791,worldZ:3183,level:0}),st:()=>({inventory:[]}),
   xp:()=>0,cnt:(id:number)=>id===995?60:0,has:(id:number)=>id===1858&&label,
   talk:async(name:string)=>{actions.push(name);stage=name==='kangai 1'?1:3;},milestone:()=>{},
   walk:async(name:string)=>{if(name==='to cromperty')throw Error('reached wizard');},
   step:async(name:string,act:()=>Promise<void>,observed:()=>boolean)=>{actions.push(name);await act();expect(observed()).toBe(true);},
   opLoc:async()=>{label=true;},locAt:()=>undefined,useOnLoc:async()=>{label=false;stage=2;},
   converse:async()=>{},dialogOpen:()=>false,
   inv:()=>[{id:995,count:100}],
  } as unknown as Parameters<typeof completeTotem>[0];
  await expect(completeTotem(q,async(_q,id)=>{actions.push(id);})).rejects.toThrow('reached wizard');
  expect(actions.includes('kangai 1')).toBe(initial===0);
  expect(actions.includes('take label')).toBe(initial<2);
  expect(actions.includes('label on crate')).toBe(initial<2);
  expect(actions.includes('rpdt')).toBe(initial<3);
  expect(actions).toContain('npc:customs_officer:ardougne@2772,3231');
 }
});

test('Totem saved proof rejects missing reward, fare, transformed food, completion or logout',()=>{
 const before:Parameters<typeof questSweepChecks>[1]={version:10,position:{x:2571,z:3250,level:0},vars:{200:1,101:20},
  inventories:{93:[{slot:0,id:995,count:552}],95:[{slot:0,id:995,count:183752},{slot:1,id:1891,count:15},{slot:2,id:1893,count:1},{slot:3,id:1895,count:2}]},
  skills:Array.from({length:21},(_,index)=>({index,rawExperience:0,xp:0,level:index===3?40:index===17?99:1}))};
 const after=structuredClone(before);after.position={x:2791,z:3182,level:0};after.vars[200]=5;after.vars[101]=21;
 after.skills[17]!.rawExperience=443750;
 after.inventories[93]![0]!.count-=90;after.inventories[93]!.push({slot:1,id:373,count:5});
 after.inventories[95]![1]!.count--;after.inventories[95]![2]!.count++;
 const log='START 2571 3250 0\nTOTEM_STAGE {"stage":1}\nTOTEM_TELEPORT_REFUSED Magic 1 < 51\n'
  +[[1891,8],[1893,1],[1895,2]].map(([id,count])=>'QUEST_SWEEP_WITHDRAW '+JSON.stringify({id,count,observed:true})).join('\n')
  +'\nTOTEM_BOAT {"id":"npc:customs_officer:ardougne@2772,3231","coins":30,"before":522,"after":492}\nTOTEM_BOAT {"id":"npc:captain_barnaby:brimhaven@2679,3275","coins":30,"before":492,"after":462}\n'
  +'QUEST_SWEEP_FLAG {"name":"Tribal Totem","state":"complete"}\nRESULT ok eats=1\nLOGOUT logged-out\n';
 const verify=(text=log)=>questSweepChecks('totem-started-cakes',before,after,text,{id:'totem-started-cakes',exit:0,timedOut:false,saveMatched:true,seconds:0});
 expect(Object.values(verify()).every(Boolean)).toBe(true);
 after.skills[17]!.rawExperience=0;expect(verify()).toMatchObject({reward:false});after.skills[17]!.rawExperience=443750;
 after.inventories[95]![2]!.count--;expect(verify()).toMatchObject({food:false});after.inventories[95]![2]!.count++;
 after.inventories[93]![0]!.count++;expect(verify()).toMatchObject({assets:false});after.inventories[93]![0]!.count--;
 after.vars[200]=1;expect(verify()).toMatchObject({quest:false});after.vars[200]=5;
 expect(verify(log.replace('LOGOUT logged-out',''))).toMatchObject({logout:false});
});

test('a started Vampire Slayer entry skips Morgan, whose started branch sets nothing, and still talks to Harlow',()=>{
 expect(vampireOpening('started',false)).toEqual({morgan:false,harlow:true});
 expect(vampireOpening('started',true)).toEqual({morgan:false,harlow:false});
 expect(vampireOpening('not started',false)).toEqual({morgan:true,harlow:true});
 expect(()=>vampireOpening('unknown',false)).toThrow('quest state unknown');
 expect(()=>vampireOpening('complete',false)).toThrow('already complete');
});

test('Vampire proof needs the started entry, completion 3, three QP and 120625 decoded Attack XP',()=>{
 const before:Parameters<typeof questSweepChecks>[1]={version:10,position:{x:3097,z:3267,level:0},vars:{178:1,101:17},
  inventories:{93:[{slot:0,id:1917,count:1},{slot:1,id:2347,count:1},{slot:2,id:1550,count:1},{slot:3,id:563,count:2}],94:[{slot:3,id:2402,count:1}]},
  skills:Array.from({length:21},(_,index)=>({index,rawExperience:0,xp:0,level:index===3?75:index===6?1:50}))};
 const after=structuredClone(before);after.position={x:3078,z:9774,level:0};after.vars[178]=3;after.vars[101]=20;after.inventories[93]!.shift();
 // Retained Count fight: 25 damage at multiplier 100 yields 2,500 raw Attack tenths, plus the quest reward.
 before.skills[0]!.rawExperience=7059210;
 after.skills[0]!.rawExperience=8267960;after.skills[3]!.rawExperience=775;
 const log='START 3097 3267 0\nMILESTONE 2 400\nMILESTONE stake 420\nQUEST_SWEEP_FLAG {"name":"Vampire Slayer","state":"complete"}\nRESULT ok qp=3 eats=0\nLOGOUT logged-out\n';
 const verify=(text=log)=>questSweepChecks('vampire-started',before,after,text,{id:'vampire-started',exit:0,timedOut:false,saveMatched:true,seconds:0});
 expect(Object.values(verify()).every(Boolean)).toBe(true);
 expect(verify('MILESTONE 1 10\n'+log)).toMatchObject({opening:false});
 after.skills[0]!.rawExperience=before.skills[0]!.rawExperience+2500;expect(verify()).toMatchObject({reward:false});
 after.skills[0]!.rawExperience=8267961;expect(verify()).toMatchObject({reward:false});
 after.skills[0]!.rawExperience=before.skills[0]!.rawExperience+120625;expect(verify()).toMatchObject({reward:false});
 after.skills[0]!.rawExperience=before.skills[0]!.rawExperience+1206250;
 after.vars[101]=19;expect(verify()).toMatchObject({quest:false});after.vars[101]=20;
 after.inventories[93]!.pop();expect(verify()).toMatchObject({assets:false,budget:false});
});

test('teleport walks when law runes are held below the pinned spell Magic level',()=>{
 // Mightyrod (Magic1, two law runes) cast Varrock Teleport at 3097,3267,0 and got the Magic-level refusal.
 expect(teleportRefusal('magic:varrock_teleport',1,2)).toBe('Magic 1 < 25');
 expect(teleportRefusal('magic:varrock_teleport',25,2)).toBeUndefined();
 expect(teleportRefusal('magic:varrock_teleport',25,0)).toBe('no law rune');
 expect(teleportRefusal('magic:lumbridge_teleport',30,1)).toBe('Magic 30 < 31');
 expect(teleportRefusal('magic:trollheim_teleport',61,1)).toBeUndefined();
});

test('upstairs descent accepts the Draynor Manor Walk-down staircase at its real opIndex',()=>{
 // Mightyrod stopped at 3106,3363,1 with 'no way down from level 1' beside spookystairstop (op1=Walk-down).
 const stairs={id:1731,distance:3,optionsWithIndex:[{text:'Walk-down',opIndex:1}]};
 const door={id:134,distance:1,optionsWithIndex:[{text:'Open',opIndex:1}]};
 expect(downward([door,stairs])).toEqual({loc:stairs,opIndex:1});
 const ladder={id:1746,distance:2,optionsWithIndex:[{text:'Climb-up',opIndex:1},{text:'Climb-down',opIndex:3}]};
 expect(downward([stairs,ladder])).toEqual({loc:ladder,opIndex:3});
 expect(downward([door,{id:1722,distance:1,optionsWithIndex:[{text:'Climb-up',opIndex:1}]}])).toBeUndefined();
});

test('Clock Tower mainland entry sends bounded corridor clicks before any whole-world planning wait',async()=>{
 for(const entry of [{x:3239,z:3275},{x:3305,z:3126}]){
  let tick=0,player={worldX:entry.x,worldZ:entry.z,level:0};
  const listeners=new Set<()=>void>(),boats:string[]=[],clicks:number[]=[];
  const s={sdk:{getState:()=>({player,inventory:[{id:995,count:112},{id:1929,count:1}]})},tick:()=>tick,
   onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);}} as unknown as Session;
  const deps:PathDeps={pos:()=>({x:player.worldX,z:player.worldZ,level:player.level}),onTick:s.onTick,locs:()=>[],
   interactLoc:()=>{throw Error('unexpected interaction');},plan:(level,from,to)=>findLongPath(level,from.x,from.z,to.x,to.z),
   walk:(x,z)=>{clicks.push(tick);player.worldX=x;player.worldZ=z;}};
  const world={route:()=>{throw Error('whole-world planning must not delay this entry');},blockedDoors:()=>[]};
  const sail=(async(_s,legs)=>{
   const leg=legs[0]!;expect(leg.kind).toBe('travel');if(leg.kind!=='travel')throw Error('not travel');
   boats.push(leg.travel.id);player={worldX:leg.to.x,worldZ:leg.to.z,level:leg.to.level};return{ok:true,ticks:0};
  }) as typeof import('../packages/core/src/walk').walkRoute;
  const timer=setInterval(()=>{tick++;for(const cb of listeners)cb();},1);
  try{await reachStart(s,world,presetFor('cog').position,'cog',async()=>deps,sail);}
  finally{clearInterval(timer);}
  expect(clicks[0]).toBeLessThan(10);
  expect(boats).toEqual(['npc:captain_tobias:karamja-musa-point@3028,3216','npc:customs_officer:ardougne@2772,3231']);
  expect(Math.max(Math.abs(player.worldX-2568),Math.abs(player.worldZ-3249))).toBeLessThanOrEqual(3);
 }
},30000);

test('Magic1 trophy holder leaves the controlled contest gate before walking to the west dwarf',async()=>{
 let player={worldX:2642,worldZ:3444,level:0},cross=true;
 const actions:string[]=[];
 const q:Parameters<typeof returnFishingContestTrophy>[0]={
  pos:()=>player,
  dash:async(_label:string,x:number,z:number)=>{player={worldX:x,worldZ:z,level:0};},
  locAt:()=>undefined,
  opLoc:async(loc,op=1)=>{
   expect(loc).toEqual({id:47,x:2642,z:3442});expect(op).toBe(1);
   actions.push('gate');if(cross)player={worldX:2643,worldZ:3442,level:0};
  },
  step:async(_label:string,act:()=>unknown,arrived:()=>boolean,ticks=8,tries=4)=>{
   expect(ticks).toBe(8);expect(tries).toBe(4);
   for(let i=0;i<tries&&!arrived();i++)await act();
   if(!arrived())throw Error('gate exit unobserved');
  },
  walk:async(_label:string,points:PathPoint[])=>{
   expect(player.worldX).toBeGreaterThan(2642);actions.push('return');
   for(const point of points){
    const path=findLongPath(0,player.worldX,player.worldZ,point.x,point.z);
    const end=path.at(-1)!;
    expect(Math.max(Math.abs(end.x-point.x),Math.abs(end.z-point.z))).toBeLessThanOrEqual(point.tol??2);
    player={worldX:end.x,worldZ:end.z,level:0};
   }
  },
 };
 await returnFishingContestTrophy(q);
 expect(actions).toEqual(['gate','return']);
 expect(Math.max(Math.abs(player.worldX-2820),Math.abs(player.worldZ-3487))).toBeLessThanOrEqual(2);
 // An accepted click without the east landing must not start the return walk.
 cross=false;actions.length=0;player={worldX:2642,worldZ:3444,level:0};
 await expect(returnFishingContestTrophy(q)).rejects.toThrow('gate exit unobserved');
 expect(actions).toEqual(['gate','gate','gate','gate']);
},30000);

test('Fishing Contest reaches the west dwarf from the retained bank endpoint without the failed world goal',async()=>{
 let player={worldX:2615,worldZ:3332,level:0},tick=0,plans=0;
 const listeners=new Set<()=>void>();
 const state={player,nearbyNpcs:[{id:232,name:'Mountain Dwarf',x:2820,z:3487}]};
 const s={sdk:{getState:()=>state},tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);}} as unknown as Session;
 const deps:PathDeps={pos:()=>({x:player.worldX,z:player.worldZ,level:player.level}),onTick:s.onTick,
  interactLoc:()=>{throw Error('unexpected location interaction');},
  locs:()=>[],walk:(x:number,z:number)=>{player.worldX=x;player.worldZ=z;},
  plan:(level:number,from:{x:number;z:number},to:{x:number;z:number})=>{
   plans++;const path=findLongPath(level,from.x,from.z,to.x,to.z);
   expect(path.at(-1)).toMatchObject({x:to.x,z:to.z});return path;
  }};
 const world={route:()=>{throw Error('precondition no route to 2822,3489,0');},blockedDoors:()=>[]};
 const timer=setInterval(()=>{tick++;for(const cb of listeners)cb();},1);
 try{
  await reachStart(s,world,presetFor('fishingcompo').position,'fishingcompo',async()=>deps);
  expect(plans).toBeGreaterThan(0);
  expect(Math.max(Math.abs(player.worldX-2820),Math.abs(player.worldZ-3487))).toBeLessThanOrEqual(6);
  // A successful walk result without the matching observed NPC must not hand off the session.
  state.nearbyNpcs=[];
  await expect(reachStart(s,world,presetFor('fishingcompo').position,'fishingcompo',async()=>deps)).rejects.toThrow('west dwarf unobserved');
 }finally{clearInterval(timer);}
},30000);

// ballspinner.log:5017-5024: from the plank spawn at 3291,3652 the far walk stopped at 2790,3502, the client refused the
// straight fallback click to 2779,3491, and walkFar found no route to 2439,3187. Each leg here is planned as
// sessionWalker plans it, on pinned collision with the combat-19 account's deadly ground closed.
test('Observatory entry east of the closed pass takes Port Sarim boats and the pinned Ardougne path, never walkFar',async()=>{
 const grid=await import('../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
 const {guardWalk}=await import('../packages/core/src/danger');
 const weak={skills:{attack:37,strength:1,defence:1,hitpoints:26,ranged:1,magic:1,prayer:1},items:[],counts:{}} as unknown as import('../packages/core/src/world').Account;
 const start=presetFor('itgronigen').position,karamja=new Set([...KARAMJA,[2772,3231]].map(([x,z])=>`${x},${z}`));
 expect(start).toEqual({level:0,x:2439,z:3187});
 for(const entry of [{x:2790,z:3502},{x:3291,z:3652}]){
  let tick=0,coins=116,player={worldX:entry.x,worldZ:entry.z,level:0};
  const listeners=new Set<()=>void>(),boats:string[]=[],clicks:{x:number;z:number}[]=[];
  const s={sdk:{getState:()=>({player,inventory:[{id:995,count:coins}]})},tick:()=>tick,
   onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);}} as unknown as Session;
  const deps:PathDeps={pos:()=>({x:player.worldX,z:player.worldZ,level:player.level}),onTick:s.onTick,locs:()=>[],
   interactLoc:()=>{throw Error('unexpected interaction');},
   plan:(level,from,to)=>{
    const path=guardWalk(grid as never,weak,{...from,level},{...to,level},32,()=>findLongPath(level,from.x,from.z,to.x,to.z));
    // An empty or short plan is the straight-line fallback that the client refused at 2779,3491. The courier's
    // Karamja corridor keeps its proven straight clicks (2850,3175 and 2772,3231 plan empty without the guard too).
    // The reception tile 2439,3187 is itself blocked; its path ends beside it at 2440,3187.
    const end=path.at(-1);
    if(!karamja.has(`${to.x},${to.z}`))expect(end&&Math.max(Math.abs(end.x-to.x),Math.abs(end.z-to.z))).toBeLessThanOrEqual(1);
    return path;
   },
   walk:(x,z)=>{clicks.push({x,z});player.worldX=x;player.worldZ=z;}};
  const world={route:()=>{throw Error('walkFar must not plan the Observatory leg');},blockedDoors:()=>[]};
  const sail=(async(_s,legs)=>{
   const leg=legs[0]!;if(leg.kind!=='travel')throw Error('not travel');
   boats.push(leg.travel.id);coins-=leg.travel.coins;player={worldX:leg.to.x,worldZ:leg.to.z,level:leg.to.level};return{ok:true,ticks:0};
  }) as typeof import('../packages/core/src/walk').walkRoute;
  const timer=setInterval(()=>{tick++;for(const cb of listeners)cb();},1);
  try{await reachStart(s,world,start,'itgronigen',async()=>deps,sail,()=>weak);}
  finally{clearInterval(timer);}
  expect(boats).toEqual(['npc:captain_tobias:karamja-musa-point@3028,3216','npc:customs_officer:ardougne@2772,3231']);
  expect(coins).toBe(56);
  // No click lands in the Big Wolf's reach (22 tiles round 2840,3497) or the refused tile.
  expect(clicks.some(c=>Math.max(Math.abs(c.x-2840),Math.abs(c.z-3497))<=22)).toBe(false);
  expect(clicks).not.toContainEqual({x:2779,z:3491});
  expect(Math.max(Math.abs(player.worldX-start.x),Math.abs(player.worldZ-start.z))).toBeLessThanOrEqual(3);
 }
 // Below both fares the entry refuses before any click.
 const player={worldX:2790,worldZ:3502,level:0};
 const s={sdk:{getState:()=>({player,inventory:[{id:995,count:59}]})},tick:()=>0} as unknown as Session;
 await expect(reachStart(s,{} as never,start,'itgronigen',async()=>{throw Error('no walk below the fares');},undefined,()=>weak)).rejects.toThrow('missing 995:60 for Observatory boat route');
},60000);

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

test('Fishing Contest proof requires completion 5 and 60925 decoded Fishing XP at 25x',()=>{
 const before:Parameters<typeof questSweepChecks>[1]={
  version:9,position:{x:2615,z:3332,level:0},vars:{11:0,101:3},inventories:{},
  skills:Array.from({length:21},(_,index)=>({index,rawExperience:1000,xp:100,level:10})),
 };
 const after=structuredClone(before);
 after.vars[11]=5;after.vars[101]=4;
 after.skills[10]!.rawExperience+=609250;after.skills[10]!.xp+=60925;
 const record={id:'fishing-stage',exit:0,timedOut:false,saveMatched:true,seconds:0};
 const checks=()=>questSweepChecks('fishing-stage',before,after,'',record);
 expect(checks()).toMatchObject({quest:true,reward:true});
 after.vars[11]=4;
 expect(checks()).toMatchObject({quest:false,reward:true});
 after.vars[11]=5;
 after.skills[10]!.rawExperience=before.skills[10]!.rawExperience+6092500;
 after.skills[10]!.xp=before.skills[10]!.xp+609250;
 expect(checks()).toMatchObject({quest:true,reward:false});
 before.inventories={93:[{slot:0,id:995,count:7350},{slot:1,id:313,count:2},{slot:2,id:1550,count:1}]};
 after.inventories={93:[{slot:0,id:995,count:7345},{slot:1,id:27,count:1}]};
 expect(checks().assets).toBe(true);
 after.inventories[93]!.pop();
 expect(checks().assets).toBe(false);
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

test('Heckel ladder return leaves the Grand Tree before the north gate approach',async()=>{
 let player={worldX:2466,worldZ:3494,level:0},tick=0,cross=true,walkOk=true;
 const actions:any[]=[],walks:unknown[]=[],listeners=new Set<()=>void>();
 const s={sdk:{getState:()=>({player})},tick:()=>tick,
  onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
  direct:async(a:any)=>{actions.push(a);return{success:true};}} as unknown as Session;
 const timer=setInterval(()=>{
  tick++;
  if(cross&&actions.at(-1)?.locId===1968)player={worldX:2466,worldZ:3491,level:0};
  if(actions.at(-1)?.locId===190)player={worldX:2461,worldZ:3382,level:0};
  for(const cb of listeners)cb();
 },1);
 const approach=async(to:{x:number;z:number;level:number})=>{
  walks.push(to);
  // The client refuses southbound clicks while still inside the closed tree doors.
  if(player.worldZ>3492||!walkOk)return{ok:false};
  player={worldX:to.x,worldZ:to.z,level:to.level};return{ok:true};
 };
 try{
  expect(await leaveStronghold(s,approach)).toMatchObject({ok:true});
  expect(actions.map(a=>[a.locId,a.x,a.z,a.optionIndex])).toEqual([[1968,2466,3492,1],[190,2459,3383,1]]);
  expect(walks).toEqual([{x:2461,z:3385,level:0}]);
  actions.length=0;walks.length=0;cross=false;player={worldX:2466,worldZ:3494,level:0};
  expect(await leaveStronghold(s,approach)).toMatchObject({ok:false,detail:'Grand Tree southern landing unobserved'});
  expect(walks).toEqual([]);expect(actions.map(a=>a.locId)).toEqual([1968]);
  actions.length=0;cross=true;walkOk=false;player={worldX:2466,worldZ:3494,level:0};
  expect(await leaveStronghold(s,approach)).toMatchObject({ok:false,detail:expect.stringContaining('Stronghold north gate approach failed')});
  expect(actions.map(a=>a.locId)).toEqual([1968]);
 }finally{clearInterval(timer);}
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

test('a run resumed in the Hazeel cave climbs its stairs before the bank walk; above ground nothing is clicked',async()=>{
 const {leaveHazeelCave}=await import('./quest-sweep');
 let player={worldX:2570,worldZ:9680,level:0},tick=0;
 const clicks:any[]=[],walks:unknown[]=[];
 const listeners=new Set<()=>void>();
 const s={sdk:{getState:()=>({player})},tick:()=>tick,
  onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
  direct:async(a:any)=>{clicks.push(a);return{success:true};}} as unknown as Session;
 const timer=setInterval(()=>{tick++;
  const last=clicks[clicks.length-1];
  if(last?.locId===2853&&player.worldZ>9000)player={worldX:2587,worldZ:3237,level:0};
  for(const cb of listeners)cb();},1);
 try{
  const result=await leaveHazeelCave(s,async(to)=>{walks.push(to);const t=to[to.length-1]!;player={worldX:t.x,worldZ:t.z,level:t.level};return{ok:true};});
  expect(result).toEqual({ok:true});
  expect(clicks.map(c=>[c.locId,c.x,c.z])).toEqual([[2853,2570,9683]]);
  expect(walks).toEqual([[{x:2570,z:9682,level:0}]]);
  expect(player).toEqual({worldX:2587,worldZ:3237,level:0});
  clicks.length=0;walks.length=0;
  expect(await leaveHazeelCave(s,async(to)=>{walks.push(to);return{ok:true};})).toEqual({ok:true});
  expect(clicks).toEqual([]);expect(walks).toEqual([]);
  player={worldX:2606,worldZ:9692,level:0};
  const stuck=await leaveHazeelCave(s,async()=>({ok:true}));
  expect(stuck).toEqual({ok:false,detail:'hazeel cave stairs foot 2570,9682,0 unobserved at 2606,9692,0'});
 }finally{clearInterval(timer);}
});

test('Mightyrod fortress box-room entry pushes the secret wall and descends the hall ladder before bank selection',async()=>{
 let player={worldX:3029,worldZ:3505,level:1},tick=0;
 const clicks:any[]=[],walks:unknown[]=[];
 const listeners=new Set<()=>void>();
 const s={sdk:{getState:()=>({player})},tick:()=>tick,
  onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
  direct:async(a:any)=>{clicks.push(a);return{success:true};}} as unknown as Session;
 const timer=setInterval(()=>{tick++;
  const last=clicks[clicks.length-1];
  if(last?.locId===2341&&player.worldZ===3509)player={worldX:3030,worldZ:3510,level:1};
  if(last?.locId===1749&&player.level===1)player={worldX:3022,worldZ:3517,level:0};
  for(const cb of listeners)cb();},1);
 try{
  const result=await leaveFortress(s,async(to)=>{walks.push(to);const t=to[to.length-1]!;player={worldX:t.x,worldZ:t.z,level:t.level};return{ok:true};});
  expect(result).toEqual({ok:true});
  expect(clicks.map(c=>[c.locId,c.x,c.z])).toEqual([[2341,3030,3510],[1749,3022,3518]]);
  expect(clicks.some(c=>c.locId===2339)).toBe(false);
  expect(walks).toEqual([[{x:3030,z:3509,level:1}],[{x:3030,z:3516,level:1},{x:3029,z:3517,level:1},{x:3022,z:3517,level:1}],[{x:3016,z:3512,level:0}]]);
  expect(player).toEqual({worldX:3016,worldZ:3512,level:0});
  expect(nearestBank({x:player.worldX,z:player.worldZ,level:player.level}).level).toBe(0);
  // An unobserved wall tile refuses with its position instead of selecting a level-1 bank.
  player={worldX:3029,worldZ:3505,level:1};clicks.length=0;
  const stuck=await leaveFortress(s,async()=>({ok:true}));
  expect(stuck).toEqual({ok:false,detail:'fortress secret wall tile 3030,3509,1 unobserved at 3029,3505,1'});
  expect(clicks).toEqual([]);
 }finally{clearInterval(timer);}
});

// mightyrod.log: after the fortress exit and the Edgeville bank, QUEST_SWEEP_GATHER_PLAN planned 273 and 952 and left
// 272:1, so the run ended "missing 272:1". The only fish food spawn is on level 1 and spawn-index keeps one plane.
test('Ernest fish food has only a level-1 Manor spawn, so the ground-floor gather plan leaves it to the Manor trip',()=>{
 const bank={x:3094,z:3491,level:0};
 expect(spawnsByDistance(272,{...bank,level:1})).toContainEqual(expect.objectContaining({x:3108,z:3356,level:1}));
 const gathers=gatherPlan([{id:272,count:1}],bank,spawnsByDistance,()=>Infinity).gathers;
 expect(gathers).toEqual([{id:272,count:1,how:'spawn'}]);
 expect(leaveToManorTrip(gathers,true)).toEqual([]);
 expect(leaveToManorTrip(gathers,false)).toEqual(gathers);
 expect(manorFoodNeed('haunted',[{id:272,count:1},{id:273,count:1}])).toBe(true);
 expect(manorFoodNeed('haunted',[{id:272,count:2}])).toBe(false);
 expect(manorFoodNeed('cog',[{id:272,count:1}])).toBe(false);
});

const manorWorld=()=>{
 const s={pos:{x:3094,z:3491,level:0},held:0,ground:true as boolean,frontOpens:true,ops:[] as string[],walks:[] as string[],picks:0,poisonHeld:0,poisonGround:true,travels:[] as string[]};
 const io:ManorIO={
  pos:()=>({...s.pos}),held:item=>item.id===273?s.poisonHeld:s.held,
  ground:item=>item.id===273?(s.poisonGround&&s.pos.level===0&&s.pos.x===3097?{x:3097,z:3366}:undefined):(s.ground&&s.pos.level===1?{x:3108,z:3356}:undefined),
  travel:async to=>{s.travels.push(`${to.x},${to.z},${to.level}`);s.pos={...to};return{ok:true};},
  walk:async to=>{const t=to[to.length-1]!;
   // Each leg is a real level-local route in the pinned collision.
   if(t.level===s.pos.level&&(t.x!==s.pos.x||t.z!==s.pos.z))expect(findLongPath(t.level,s.pos.x,s.pos.z,t.x,t.z).at(-1)).toMatchObject({x:t.x,z:t.z});
   s.walks.push(`${t.x},${t.z},${t.level}`);if(t.level===s.pos.level)s.pos={...t};return{ok:true};},
  op:async loc=>{s.ops.push(`${loc.id}@${loc.x},${loc.z}`);
   if(loc.id===134&&s.frontOpens&&s.pos.z===3352)s.pos={x:3108,z:3354,level:0};
   if(loc.id===1730&&s.pos.level===0)s.pos={x:s.pos.x,z:s.pos.z+4,level:1};
   if(loc.id===1731&&s.pos.level===1)s.pos={x:s.pos.x,z:s.pos.z-4,level:0};},
  pickup:async(_g,item)=>{s.picks++;if(item.id===273){if(s.poisonGround){s.poisonGround=false;s.poisonHeld++;}}else if(s.ground){s.ground=false;s.held++;}},
  wait:async ok=>ok(),
 };
 return{s,io};
};
test('the Manor trip enters by the front door, picks up exactly one fish food upstairs and leaves by the back door',async()=>{
 const {s,io}=manorWorld();
 expect(await fetchManorFishFood(io,presetFor('haunted').position)).toEqual({ok:true});
 expect(s.ops).toEqual(['134@3108,3353','1730@3108,3363','1731@3108,3364']);
 expect(s.walks).toEqual(['3108,3352,0','3108,3362,0','3108,3356,1','3108,3366,1','3123,3361,0']);
 expect([s.held,s.picks]).toEqual([1,1]);
 expect(s.pos).toEqual({x:3123,z:3361,level:0});
});
test('the Manor trip takes the poison from the west room on the way to the stairs, or alone',async()=>{
 const both=manorWorld();
 expect(await fetchManorFishFood(both.io,presetFor('haunted').position,{food:true,poison:true})).toEqual({ok:true});
 expect(both.s.travels.slice(1)).toEqual(['3097,3366,0','3108,3362,0']);
 expect([both.s.poisonHeld,both.s.held,both.s.picks]).toEqual([1,1,2]);
 expect(both.s.pos).toEqual({x:3123,z:3361,level:0});
 const alone=manorWorld();
 expect(await fetchManorFishFood(alone.io,presetFor('haunted').position,{food:false,poison:true})).toEqual({ok:true});
 expect(alone.s.ops).toEqual(['134@3108,3353']);
 expect([alone.s.poisonHeld,alone.s.held]).toEqual([1,0]);
 const gone=manorWorld();gone.s.poisonGround=false;
 expect(await fetchManorFishFood(gone.io,presetFor('haunted').position,{food:false,poison:true})).toEqual({ok:false,detail:'manor fish food ground poison unobserved at 3097,3366,0'});
 expect(leaveToManorTrip([{id:272},{id:273},{id:952}],true,true)).toEqual([{id:952}]);
 expect(manorPoisonNeed('haunted',[{id:273,count:1}])).toBe(true);expect(manorPoisonNeed('haunted',[{id:272,count:1}])).toBe(false);
});
test('the Manor trip refuses with its position when the door, the spawn or the inventory credit is unobserved',async()=>{
 const shut=manorWorld();shut.s.frontOpens=false;
 expect(await fetchManorFishFood(shut.io,presetFor('haunted').position)).toEqual({ok:false,detail:'manor fish food front door entry unobserved at 3108,3352,0'});
 expect(shut.s.ops).toEqual(['134@3108,3353']);
 const taken=manorWorld();taken.s.ground=false;
 expect(await fetchManorFishFood(taken.io,presetFor('haunted').position)).toEqual({ok:false,detail:'manor fish food ground fish food unobserved at 3108,3356,1'});
 expect([taken.s.picks,taken.s.held]).toEqual([0,0]);
 const uncredited=manorWorld();uncredited.io.pickup=async()=>{uncredited.s.picks++;};
 expect(await fetchManorFishFood(uncredited.io,presetFor('haunted').position)).toEqual({ok:false,detail:'manor fish food inventory credit unobserved: 0 -> 0 at 3108,3356,1'});
 expect(uncredited.s.picks).toBe(3);
 expect(uncredited.s.ops).not.toContain('1731@3108,3364');
},30000);

test('the Ernest proof needs the observed Manor pickup and no banked fish food',()=>{
 const before:Parameters<typeof questSweepChecks>[1]={version:10,position:{x:3029,z:3505,level:1},vars:{32:0,101:0},
  inventories:{93:[{slot:0,id:995,count:490}],95:[{slot:0,id:273,count:1},{slot:1,id:952,count:1}]},
  skills:Array.from({length:21},(_,index)=>({index,rawExperience:0,xp:0,level:index===3?75:1}))};
 const after=structuredClone(before);after.position={x:3110,z:3367,level:2};after.vars[32]=3;after.vars[101]=4;
 after.inventories={93:[{slot:0,id:995,count:790},{slot:1,id:275,count:1},{slot:2,id:952,count:1}]};
 const fort=['secret wall','hall ladder','front'].map(step=>`QUEST_SWEEP_FORTRESS {"step":"${step}","ok":true,"at":"0,0,0"}`).join('\n');
 const manor='QUEST_SWEEP_MANOR {"step":"pickup","ok":true,"at":"3108,3356,1","before":0,"after":1}\nQUEST_SWEEP_MANOR {"step":"back door","ok":true,"at":"3123,3361,0"}';
 const log=(extra:string)=>`START 3029 3505 1\n${fort}\n${extra}\nQUEST_SWEEP_FLAG {"name":"Ernest the Chicken","state":"complete"}\nRESULT ok qp=4 eats=0\nLOGOUT logged-out\n`;
 const verify=(text:string)=>questSweepChecks('ernest-fortress',before,after,text,{id:'ernest-fortress',exit:0,timedOut:false,saveMatched:true,seconds:0});
 expect(Object.values(verify(log(manor))).every(Boolean)).toBe(true);
 expect(verify(log(''))).toMatchObject({exit:false});
 expect(verify(log(manor.replace('"ok":true,"at":"3123','"ok":false,"at":"3123')))).toMatchObject({exit:false});
 before.inventories[95]!.push({slot:2,id:272,count:1});
 expect(verify(log(manor))).toMatchObject({entry:false});
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
 const g=gatherPlan([{id:753,count:1},{id:MILK,count:1},{id:1205,count:2}],at,spawns);
 expect(g.gathers).toEqual([{id:753,count:1,how:'spawn'},{id:MILK,count:1,how:'milk'}]);
 expect(g.tools).toEqual([{id:BUCKET,count:1}]);
 expect(g.still).toEqual([{id:1205,count:2}]);
});

test('a nearer spawn beats a far shop; a nearer shop keeps the item in the shop plan',()=>{
 const at={x:3222,z:3218,level:0},spawns=(id:number)=>id===1944?[{x:3226,z:3299,level:0}]:[];
 expect(gatherPlan([{id:1944,count:1}],at,spawns,()=>500).gathers).toEqual([{id:1944,count:1,how:'spawn'}]);
 expect(gatherPlan([{id:1944,count:1}],at,spawns,()=>20).still).toEqual([{id:1944,count:1}]);
 expect(gatherPlan([{id:MILK,count:1}],at,spawns,()=>30).still).toEqual([{id:MILK,count:1}]);
});
test('milk is milked from a cow when the cow is nearer than both the milk spawn and the seller',()=>{
 const lumbridge={x:3222,z:3218,level:0};
 const farSpawn=(id:number)=>id===MILK?[{x:2685,z:3683,level:0}]:[];
 const g=gatherPlan([{id:MILK,count:1}],lumbridge,farSpawn,()=>700);
 expect(g.gathers).toEqual([{id:MILK,count:1,how:'milk'}]);expect(g.tools).toEqual([{id:BUCKET,count:1}]);expect(g.still).toEqual([]);
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

function apiSweepFixture(mode='normal'){
 let tick=0,stopped=false,opens=0,stages=0,runs=0,sends=0;const finished:any[]=[],goals:any[]=[],callbacks=new Set<()=>void>(),inventory:any[]=[],equipment:any[]=[],player={worldX:3185,worldZ:3436,level:0,lifeId:1,respawnCount:0,isDead:false},green=new Set(questDefinitions().filter(q=>['Jungle Potion','Shilo Village'].includes(q.name)).map(q=>q.id));
 const client:any={ingame:true,membersAccount:1,selfSlot:1,var:{108:0,320:0,321:0},executeBotAction:()=>({success:true}),ifType:(id:number)=>({colour:green.has(id)?0x00f800:0xf80000})};
 const prayers={activePrayers:Array(15).fill(false),prayerPoints:99};
 const state=()=>({player,inventory,equipment,skills:[],nearbyNpcs:[],nearbyPlayers:[],nearbyLocs:[],inGame:true,prayers,autoRetaliateEnabled:false});
 const s:any={name:'SweepOwned',client,ended:new Promise(()=>{}),tick:()=>tick,onTick:(f:()=>void)=>{callbacks.add(f);return()=>callbacks.delete(f);},sdk:{getState:state,getStateAge:()=>0,getInventory:()=>inventory,getEquipment:()=>equipment,getSkill:()=>({level:99,baseLevel:99})},direct:async()=>{sends++;return{success:true};}};
 if(mode==='sdk-reconnect'){const sdk:any=new BotSDK({botUsername:'SweepOwned',actionTimeout:50});Object.assign(sdk,s.sdk);sdk.connectionState='reconnecting';sdk.ws={readyState:WebSocket.OPEN,send:()=>{sends++;}};sdk.waitForConnection=async()=>{await Promise.resolve();client.executeBotAction=()=>({success:true});sdk.connectionState='connected';};s.sdk=sdk;}
 if(mode==='no-shilo')for(const q of questDefinitions())if(q.name==='Shilo Village')green.delete(q.id);
 if(mode==='prayer-low')s.sdk.getSkill=(name:string)=>({level:name==='Prayer'?42:99,baseLevel:name==='Prayer'?42:99});
 if(mode==='unknown-journal')client.ifType=()=>({colour:0xff0000});
 const deps:any={transit:()=>({pending:()=>mode==='transit-pending',returnVillage:async(stop:()=>boolean)=>{if(stop())throw Error('cleanup stopped');goals.push({cleanup:true});Object.assign(player,{worldX:2852,worldZ:2955});prayers.activePrayers[14]=false;},outbound:async(stop:()=>boolean)=>{if(mode==='transit-owner')client.executeBotAction=()=>({success:true});if(mode==='transit-stop')stopped=true;if(stop())throw Error('stopped');if(['transit-wood','transit-metal','transit-pending','transit-partial-owner','transit-deadline'].includes(mode)){Object.assign(player,{worldX:mode==='transit-wood'?2868:2876,worldZ:2953});prayers.activePrayers[14]=true;if(mode==='transit-partial-owner')client.executeBotAction=()=>({success:true});if(mode==='transit-deadline')tick=550;else stopped=true;throw Error('partial stockade');}goals.push({x:2880,z:2952,level:0,shilo:true});Object.assign(player,{worldX:2880,worldZ:2952});}}),exists:()=>false,stop:()=>stopped,open:async()=>{opens++;return s;},world:async()=>{if(mode==='owner-world')client.executeBotAction=()=>({success:true});if(mode==='client-world')s.client={...client};if(mode==='life-world')player.lifeId++;if(mode==='stop-world')stopped=true;return{};},go:async(_s:any,_world:any,to:any)=>{goals.push(to);Object.assign(player,{worldX:to.x,worldZ:to.z,level:to.level});tick+=mode==='deadline'?1000:2;for(const f of callbacks)f();return{ok:true};},loadout:async(view:any,kit:any)=>{stages++;if(mode==='sdk-reconnect'){const result=await view.sdk.sendUseItem(0);return{ok:false,failure:result.message};}if(mode==='missing')return{ok:false,failure:'owned stock missing'};if(mode==='false-stage')return{ok:true};if(mode==='owner-stage'){client.executeBotAction=()=>({success:true});await view.direct({type:'walkTo',x:1,z:1});}inventory.splice(0,inventory.length,...kit.pack.map((i:any,slot:number)=>({...i,slot})));equipment.splice(0,equipment.length,...kit.wear.map((i:any)=>({...i})));if(mode==='stop-stage')stopped=true;return{ok:true};},load:async(path:string)=>{const m:any=await import(path);const run=async(view:any)=>{runs++;if(mode==='throw')throw Error('native API failure');if(mode==='unknown')return undefined;return{ok:true,complete:true,scrollRead:true,inventory:view.sdk.getInventory()};};return{...m,runWatchtower:run,runTaiBwoWannaiTrio:run};},finish:async(sessions:any[],ok:boolean,detail:any)=>{finished.push({sessions,ok,detail});return{ok};}};
 return{s,client,inventory,equipment,finished,goals,deps,stats:()=>({opens,stages,runs,sends}),stop:()=>{stopped=true;}};
}
const apiOptions={cap:6000,xpRate:25,prepareTicks:1000,maximumCasts:25};
test('actual sweep explicitly dispatches imported non-main APIs on one strictly staged owned session',async()=>{for(const quest of ['tbwt','itwatchtower']){const f=apiSweepFixture();const options=quest==='tbwt'?apiOptions:{cap:6000,xpRate:25,prepareTicks:1000};const g=globalThis as any,old=g.QUEST_SESSION;try{g.QUEST_SESSION={name:'Unrelated'};await sweep('SweepOwned',quest,'fixture',options,f.deps);expect(f.stats()).toMatchObject({opens:1,stages:1,runs:1});expect(f.finished).toHaveLength(1);expect(f.finished[0].ok).toBe(true);expect(f.finished[0].sessions[0].client).toBe(f.client);expect(g.QUEST_SESSION.name).toBe('Unrelated');if(quest==='tbwt'){expect(f.goals[0]).toMatchObject({x:2852,z:2955});expect(f.goals.some(g=>g.shilo)).toBe(true);expect(f.inventory.find(i=>i.id===3150).count).toBe(21);expect(f.inventory.find(i=>i.id===379).count).toBe(1);expect(f.equipment.find(i=>i.slot===3).id).toBe(1381);}else{expect(f.inventory.find(i=>i.id===385).count).toBe(8);expect(f.inventory.find(i=>i.id===995).count).toBe(20);expect(f.equipment.find(i=>i.slot===3).id).toBe(1289);}}finally{if(old===undefined)delete g.QUEST_SESSION;else g.QUEST_SESSION=old;}}});
test('API options, Hero single-actor mode and an initial stop are rejected before login',async()=>{for(const [quest,options]of [['hero',apiOptions],['tbwt',undefined],['tbwt',{...apiOptions,maximumCasts:0}],['itwatchtower',{cap:6000,xpRate:0,prepareTicks:1000}]]){const f=apiSweepFixture();await expect(sweep('SweepOwned',quest as string,undefined,options as any,f.deps)).rejects.toThrow();expect(f.stats().opens).toBe(0);}const f=apiSweepFixture();f.stop();await expect(sweep('SweepOwned','tbwt',undefined,apiOptions,f.deps)).rejects.toThrow('stop');expect(f.stats().opens).toBe(0);});
test('mandatory stock failure, API throws and unknown results settle the original session once',async()=>{for(const mode of ['missing','false-stage','throw','unknown','stop-stage','stop-world','deadline','unknown-journal','no-shilo','prayer-low','transit-stop']){const f=apiSweepFixture(mode);await sweep('SweepOwned','tbwt',undefined,apiOptions,f.deps);expect(f.finished).toHaveLength(1);expect(f.finished[0].ok).toBe(false);expect(f.stats().runs).toBe(mode==='throw'||mode==='unknown'?1:0);}});
test('original owner is pinned before world/loadout awaits and foreign continuations cannot send or settle',async()=>{for(const mode of ['owner-world','owner-stage','client-world','life-world','sdk-reconnect','transit-owner']){const f=apiSweepFixture(mode);await sweep('SweepOwned','tbwt',undefined,apiOptions,f.deps);expect(f.stats()).toMatchObject({runs:0,sends:0});expect(f.finished).toHaveLength(0);if(!['owner-stage','sdk-reconnect','transit-owner'].includes(mode))expect(f.stats().stages).toBe(0);}});

test('known partial Shilo gates return under protection despite ordinary stop; unknown crossing and foreign ownership defer',async()=>{for(const mode of ['transit-wood','transit-metal','transit-deadline']){const f=apiSweepFixture(mode);await sweep('SweepOwned','tbwt',undefined,apiOptions,f.deps);expect(f.goals.some(g=>g.cleanup)).toBe(true);expect(f.finished).toHaveLength(1);expect(f.finished[0].ok).toBe(false);expect(f.s.sdk.getState().prayers.activePrayers[14]).toBe(false);expect(f.stats().runs).toBe(0);}for(const mode of ['transit-pending','transit-partial-owner']){const f=apiSweepFixture(mode);const result:any=await sweep('SweepOwned','tbwt',undefined,apiOptions,f.deps);expect(result.recoveryDeferred).toBe(true);expect(f.goals.some(g=>g.cleanup)).toBe(false);expect(f.finished).toHaveLength(0);expect(f.stats().runs).toBe(0);}});

test('Fishing Contest trains Fishing 10 with a small net; other quests and Fishing 10 train nothing',async()=>{
 const {questSkillTraining,NET}=await import('./quest-sweep');
 expect(questSkillTraining('fishingcompo',()=>1)).toMatchObject({skill:'Fishing',level:10,tools:[{id:NET,count:1}]});
 expect(questSkillTraining('fishingcompo',()=>10)).toBeNull();
 expect(questSkillTraining('imp',()=>1)).toBeNull();
});

test("Merlin's Crystal: the wax comes off a Catherby beehive after its repellent and bucket; bat bones from a giant bat by bow",async()=>{
 const {gatherPlan,USE_SOURCES,KILL_SOURCES}=await import('../packages/core/src/gather');
 const {spawnsByDistance}=await import('../packages/core/src/spawn-index');
 // Bread is food for every other quest; Merlin's Crystal gives it to the beggar, so it is a need and not a meal.
 const need=needs(presetFor('merlin'),false,'merlin');
 expect([...need.keys()].sort()).toEqual([30,530,590,995,2309].sort());
 expect(needs(presetFor('merlin'),true,'merlin').has(2309)).toBe(false);expect(needs(presetFor('merlin')).has(2309)).toBe(false);
 expect(needs(presetFor('hazeelcult'),true,'hazeelcult').get(385)).toBe(4);
 expect(USE_SOURCES[30]?.uses).toEqual([28,1925]);expect(KILL_SOURCES[530]).toMatchObject({npcs:[78],chance:1});
 const catherby={x:2809,z:3441,level:0};
 const r=gatherPlan([{id:30,count:1},{id:530,count:1}],catherby,spawnsByDistance,()=>Infinity,undefined,6,97);
 // The repellent and the bucket are spawns in Catherby, gathered before the hive; the bat falls to the bow.
 expect(r.gathers.map(g=>`${g.id}:${g.how}`)).toEqual(['28:spawn','1925:spawn','30:use','530:kill']);
 expect(r.gathers.find(g=>g.id===530)?.kit).toBe('ranged');expect(r.still).toEqual([]);
 // A giant bat takes fifteen arrows a kill (six ran out on practice); a bear keeps the six.
 const {arrowsFor}=await import('../packages/core/src/gather');
 expect(arrowsFor(530,1)).toBe(15);expect(arrowsFor(2136,1)).toBe(6);
 // The quest's own fight, Sir Mordred, takes forty arrows more from a bow account.
 const {QUEST_ARROWS}=await import('./quest-sweep');
 expect(QUEST_ARROWS['merlin']).toBe(40);expect(QUEST_ARROWS['prince']).toBe(30);expect(QUEST_ARROWS['hazeelcult']).toBe(20);expect(QUEST_ARROWS['scorpion']).toBe(40);expect(QUEST_ARROWS['imp']).toBeUndefined();
 const {QUEST_CASTS}=await import('./quest-sweep');expect(QUEST_CASTS['hazeelcult']).toBe(12);expect(QUEST_CASTS['scorpion']).toBe(30);expect(QUEST_CASTS['imp']).toBeUndefined();
});

test("Pirate's Treasure needs no bananas from the sweep: the script picks them on Karamja, and the bank pass keeps their slots",async()=>{
 const {QUEST_PICKUPS,slotsFor}=await import('./quest-sweep');
 const hunt=needs(presetFor('hunt')),hazeel=needs(presetFor('hazeelcult'));
 expect(hunt.has(1963)).toBe(false);expect(hunt.get(1005)).toBe(1);expect(hunt.get(952)).toBe(1);
 // Ten bananas and the rum are held at once before the crate: eleven slots beyond the supplies, none for other quests.
 expect(slotsFor([{id:1005,count:1},...(QUEST_PICKUPS['hunt']??[])],[])).toBe(12);
 expect(QUEST_PICKUPS['imp']).toBeUndefined();
 expect(hazeel.has(385)).toBe(false);expect(needs(presetFor('hazeelcult'),true).get(385)).toBe(4);   // sharks are food
 expect(needs(presetFor('imp')).get(1470)).toBe(1);
});

test('a quest keeps its own items and every untradeable item out of the unneeded deposit',async()=>{
 const {keepsItem}=await import('./quest-sweep');
 const tradeable=(id:number)=>id===1438?true:id===291?false:undefined;
 expect(keepsItem('runemysteries',1438,tradeable)).toBe(true);
 expect(keepsItem('runemysteries',291,tradeable)).toBe(true);
 expect(keepsItem('sheep',291,tradeable)).toBe(true);
 // Murder Mystery's dagger and evidence come back out of the bank: the server counts them there and refuses the pickup.
 expect(keepsItem('murder',1813,tradeable)).toBe(true);expect(keepsItem('murder',1796,tradeable)).toBe(true);expect(keepsItem('cook',1813,tradeable)).toBe(tradeable(1813)===false);
 expect(keepsItem('sheep',1438,tradeable)).toBe(false);
 expect(keepsItem('sheep',995,tradeable)).toBe(false);
 // Sheep Herder's banked suit, prod and feed come back out for a resumed run: Orbon sells his suit at stage 1 only.
 for(const id of [278,279,284,285])expect(keepsItem('sheepherder',id,tradeable)).toBe(true);
 for(const id of [431,432,433])expect(keepsItem('hunt',id,tradeable)).toBe(true);
 expect(keepsItem('sheep',284,tradeable)).toBe(false);
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
 // Another quest's untradeable leftovers (eight kinds) are kept until the food is gone and the inputs still want
 // slots; then whole kinds go, as few as free the slots. Without `spare` they all stay.
 const spareIds=[901,902,903,904,905,906,907,908],spare=(id:number)=>spareIds.includes(id);
 const cluttered=[{id:995,count:300},...spareIds.map(id=>({id,count:1})),...Array(6).fill({id:385,count:1})];
 expect(depositPlan(cluttered,20,spare)).toEqual([{id:385,count:6}]);
 expect(depositPlan(cluttered,20,spare,spare)).toEqual([{id:385,count:6},{id:901,count:-1}]);
 expect(depositPlan(cluttered,22,spare,spare)).toEqual([{id:385,count:6},{id:901,count:-1},{id:902,count:-1},{id:903,count:-1}]);
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

test('a Taverley-side target is east of Ardougne for an account the Big Wolf would kill, and over the pass for a stronger one',async()=>{
 const {eastOfArdougne,mountainClosed,TAVERLEY_SIDE,fares,BOAT_FARES}=await import('./quest-sweep');
 const ardougne={x:2655,z:3283,level:0},kaqemeex={x:2925,z:3487,level:0};
 const monty={skills:{attack:69,strength:1,defence:1,hitpoints:37,magic:99}},strong={skills:{attack:90,strength:90,defence:90,hitpoints:82}};
 expect(TAVERLEY_SIDE(kaqemeex)).toBe(true);
 expect(TAVERLEY_SIDE({x:2946,z:3368,level:0})).toBe(false); // Falador bank: no mountain between
 expect(TAVERLEY_SIDE({x:2951,z:3450,level:0})).toBe(true);  // Doric's house, north of Falador
 expect(mountainClosed(monty)).toBe(true);
 expect(mountainClosed(strong)).toBe(false);
 expect(eastOfArdougne(ardougne,kaqemeex)).toBe(false);
 expect(eastOfArdougne(ardougne,kaqemeex,monty)).toBe(true);
 expect(eastOfArdougne(ardougne,kaqemeex,strong)).toBe(false);
 expect(eastOfArdougne({x:2946,z:3368,level:0},kaqemeex,monty)).toBe(false); // from Falador: the road
 // Catherby is on the Ardougne side for the weak account only: bound for Doric's house or Varrock it takes the boats.
 const catherby={x:2807,z:3441,level:0},doric={x:2951,z:3450,level:0},varrock={x:3210,z:3424,level:0};
 expect(eastOfArdougne(catherby,doric,monty)).toBe(true);
 expect(eastOfArdougne(catherby,varrock,monty)).toBe(true);
 expect(eastOfArdougne(catherby,doric,strong)).toBe(false);
 expect(eastOfArdougne(catherby,varrock,strong)).toBe(false);
 expect(eastOfArdougne(catherby,varrock)).toBe(false);
 expect(fares(ardougne,[kaqemeex],monty)).toBe(BOAT_FARES);
 expect(fares(ardougne,[kaqemeex],strong)).toBe(0);
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
 expect(killStyle(2134,6,97)).toBe('ranged');       // a giant rat dies to anyone, but a bow account's bow fires anyway: its arrows are budgeted
 expect(killStyle(2134,6,1)).toBe('melee');         // bare hands with no kit
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
 expect(NPC_SOURCES[1763]!.needs).toEqual([{id:1951,count:3}]);expect(COMBINE_SOURCES[1769]).toEqual([1763,1765]);expect(COMBINE_SOURCES[1552]).toEqual([327,1573]);expect(PICK_SOURCES[1957]!.loc).toBe(3366);
 // A plant nearer than any seller is picked.
 const picked=gatherPlan([{id:1957,count:2}],{x:2600,z:3000,level:0},()=>[],()=>Infinity,()=>[],6,1,()=>[{x:2581,z:2968,level:0}]);
 expect(picked.gathers).toEqual([{id:1957,count:2,how:'pick'}]);
});

test('Prince Ali: soft clay is clay on water, clay is mined with a pickaxe, ashes come from a lit log',async()=>{
 const {MINE_SOURCES,BURN_SOURCES,COMBINE_SOURCES,BRONZE_PICKAXE,TINDERBOX,LOGS}=await import('../packages/core/src/gather');
 const draynor={x:3092,z:3243,level:0};
 const spawns=(id:number)=>id===LOGS?[{x:3089,z:3265,level:0}]:[];           // logs lie in Draynor
 const seller=(id:number)=>id===1929?250:Infinity;                           // water buckets at Shantay's
 const plan=gatherPlan([{id:1761,count:1},{id:592,count:1}],draynor,spawns,seller,()=>[],6,1,()=>[]);
 expect(plan.gathers).toEqual([
  {id:434,count:1,how:'mine'},            // clay from the Varrock south-west mine, 128 tiles off
  {id:1761,count:1,how:'combine'},        // clay on the bucket of water (the bucket is bought)
  {id:LOGS,count:1,how:'spawn'},          // the ashes' logs
  {id:592,count:1,how:'burn'},
 ]);
 expect(plan.still).toEqual([{id:1929,count:1}]);
 expect(plan.tools).toEqual([{id:BRONZE_PICKAXE,count:1},{id:TINDERBOX,count:1}]);
 expect(COMBINE_SOURCES[1761]).toEqual([434,1929]);
 expect(MINE_SOURCES[434]!.locs).toEqual([2108,2109]);expect(MINE_SOURCES[434]!.tiles.length).toBe(27);
 expect(MINE_SOURCES[434]!.tiles.some(t=>t.x>=2937&&t.x<=2943&&t.z>=3282&&t.z<=3285)).toBe(false); // the Crafting Guild's
 // Doric's ores from the Falador bank: three mines, one pickaxe; the iron rocks ask Mining 15.
 const doric=gatherPlan([{id:434,count:6},{id:436,count:4},{id:440,count:2}],{x:2946,z:3368,level:0},()=>[],()=>Infinity,()=>[],6,1,()=>[]);
 expect(doric.gathers).toEqual([{id:434,count:6,how:'mine'},{id:436,count:4,how:'mine'},{id:440,count:2,how:'mine'}]);
 expect(doric.tools).toEqual([{id:BRONZE_PICKAXE,count:1}]);
 expect(MINE_SOURCES[440]!.level).toBe(15);expect(MINE_SOURCES[436]!.level).toBe(1);
 expect(BURN_SOURCES[592]!.logs).toBe(LOGS);
 // Witch's Potion: burnt meat is cooked meat on a fire of gathered logs; the cooked meat lies in the Barbarian hall.
 const hetty=gatherPlan([{id:1957,count:1},{id:221,count:1},{id:2146,count:1}],{x:2655,z:3283,level:0},(id)=>id===LOGS?[{x:3089,z:3265,level:0}]:id===2142?[{x:3077,z:3441,level:0}]:[],(id)=>id===221?400:id===1957?300:Infinity,()=>[],6,1,()=>[{x:2600,z:3300,level:0}]);
 expect(hetty.gathers).toEqual([{id:1957,count:1,how:'pick'},{id:LOGS,count:1,how:'spawn'},{id:2142,count:1,how:'spawn'},{id:2146,count:1,how:'burn'}]);
 expect(hetty.still).toEqual([{id:221,count:1}]);
 expect(hetty.tools).toEqual([{id:TINDERBOX,count:1}]);
 // A clay seller nearer than any rock keeps clay in the shop plan.
 expect(gatherPlan([{id:434,count:1}],draynor,()=>[],()=>50).still).toEqual([{id:434,count:1}]);
});

test('Scorpion Catcher\'s antipoison is neither a need nor food: no shop sells it and the script never drinks it',async()=>{
 const {OPTIONAL}=await import('./quest-sweep');
 expect(OPTIONAL.has(2446)).toBe(true);
 const preset=presetFor('scorpion');
 expect((preset.inventory??[]).some(i=>i.id===2446)).toBe(true);
 expect(needs(preset,false,'scorpion').has(2446)).toBe(false);
 expect(needs(preset,true,'scorpion').has(2446)).toBe(false);
 expect(needs(preset,true,'scorpion').get(379)).toBe(4);
});

test("Gertrude's seasoned sardine is doogle leaves from the spawn by her house on a sardine bought from Gerrant",()=>{
 const gertrude={x:3150,z:3410,level:0};
 const spawns=(id:number)=>id===1573?[{x:3152,z:3401,level:0}]:[];
 const seller=(id:number)=>id===327?190:Infinity;
 const plan=gatherPlan([{id:1552,count:1}],gertrude,spawns,seller,()=>[],12,1,()=>[]);
 expect(plan.gathers).toEqual([{id:1573,count:1,how:'spawn'},{id:1552,count:1,how:'combine'}]);
 expect(plan.still).toEqual([{id:327,count:1}]);
});

test('bound for Rimmington, the eye of newt comes from Betty in Port Sarim, not Taverley or Gu\'Tanoth',async()=>{
 const {sellersByTravel}=await import('./quest-sweep');
 const ardougne={x:2655,z:3283,level:0},hetty={x:2966,z:3206,level:0};
 const sellers=[{npc:'Ogre merchant',tile:{x:2528,z:3048,level:0}},{npc:'Jatix',tile:{x:2899,z:3427,level:0}},{npc:'Betty',tile:{x:3012,z:3259,level:0}}];
 expect(sellersByTravel(sellers,ardougne).map(s=>s.npc)).toEqual(['Ogre merchant','Jatix','Betty']);
 expect(sellersByTravel(sellers,ardougne,hetty).map(s=>s.npc)).toEqual(['Betty','Jatix','Ogre merchant']);
});

test('bound for Doric, a Big Wolf account buys its pickaxe from Bob on foot, not Arhein past the refused 2855,3430 step',async()=>{
 const {sellersByTravel,eastOfArdougne}=await import('./quest-sweep');
 const bank={x:2946,z:3368,level:0},doric={x:2951,z:3450,level:0},weak={skills:{attack:1,strength:1,defence:1,hitpoints:10}};
 const sellers=sellersByDistance('bronze_pickaxe',bank);
 // The rejected leg: Arhein's detour is the least, and the way back from Catherby takes both boats.
 const arhein=sellersByTravel(sellers,bank,doric)[0]!;
 expect(arhein).toMatchObject({npc:'Arhein',tile:{x:2803,z:3430,level:0}});
 expect(eastOfArdougne(arhein.tile,doric,weak)).toBe(true);
 // The valid leg: Bob in Lumbridge, reached and left by the Falador road with no boat.
 const bob=sellersByTravel(sellers,bank,doric,weak)[0]!;
 expect(bob).toMatchObject({npc:'Bob',tile:{x:3232,z:3203,level:0}});
 expect(eastOfArdougne(bank,bob.tile,weak)||eastOfArdougne(bob.tile,doric,weak)).toBe(false);
 expect(sellersByTravel(sellers,bank,doric,{skills:{attack:90,strength:90,defence:90,hitpoints:82}})[0]!.npc).toBe('Arhein');
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
 const {magicKit,castsFor,castsPerKill,killStyle,gatherPlan,killAttempts}=await import('../packages/core/src/gather');
 // TheFullMonty: Magic 99, a staff of fire, 500 air and 500 mind runes: Fire Strike at 2 air and 1 mind a cast.
 const monty=[{id:1387,count:1},{id:556,count:500},{id:558,count:500}];
 expect(magicKit(monty,99)).toEqual({staff:1387,component:'magic:fire_strike',level:13,maxhit:8,runes:{558:1,556:2}});
 // Without the staff the fire runes are missing: Wind Strike from air and mind alone; nothing below six casts' worth.
 expect(magicKit([{id:556,count:500},{id:558,count:500}],99)?.component).toBe('magic:wind_strike');
 expect(magicKit([{id:556,count:5},{id:558,count:5}],99)).toBeNull();
 // A fight asks only for one more kill's casts: two mind runes and four air still cast Fire Strike with the staff.
 expect(magicKit([{id:1387,count:1},{id:556,count:4},{id:558,count:2}],99,2)?.component).toBe('magic:fire_strike');
 expect(magicKit([{id:1387,count:1},{id:556,count:4},{id:558,count:2}],99)).toBeNull();
 expect(magicKit(monty,12)?.component).toBe('magic:wind_strike');
 // A seller covers the runes the account lacks: fire runes owned, air and mind from a shop.
 expect(magicKit([{id:554,count:150}],29,6,id=>id===556||id===558)).toEqual({staff:undefined,component:'magic:fire_strike',level:13,maxhit:8,runes:{558:1,554:3,556:2}});
 expect(magicKit([],5,6,id=>id===556||id===558)?.component).toBe('magic:wind_strike');
 expect(magicKit([],29,6,()=>false)).toBeNull();
 // Attack 69 with Strength 1 and Ranged 1 does not beat a goblin series bare-handed; Magic 99 does. A rat is the staff's
 // kill too: a wielded staff with autocast casts on every attack, so its runes are budgeted.
 expect(killStyle(288,69,1,1,1)).toBeNull();
 expect(killStyle(288,69,1,99,1)).toBe('magic');
 expect(killStyle(2134,69,1,99,1)).toBe('magic');expect(killStyle(2134,69,1,1,1)).toBe('melee');
 expect(killStyle(2136,68,97,99,68)).toBe('magic');
 expect(killStyle(2136,68,97,1,68)).toBe('ranged');
 // Casts: the hitpoints over half the max hit at three in five, plus one: four Fire Strikes or ten Wind Strikes a
 // goblin (5 hitpoints), thirteen Fire Strikes a bear (27), three a chicken (3), four a giant rat (5).
 expect(castsFor(288,3,8)).toBe(4*killAttempts(288,3));
 expect(castsFor(288,3,2)).toBe(10*killAttempts(288,3));
 expect(castsFor(2136,1,8)).toBe(13);expect(castsFor(2138,1,8)).toBe(3);expect(castsFor(2134,1,8)).toBe(4);
 // A chance drop's fight asks one goblin's casts, not the series' (one goblin mail: a series of casts planned, four a fight).
 expect(castsPerKill(288,8)).toBe(4);expect(castsFor(288,1,8)).toBe(4*killAttempts(288,1));expect(castsFor(288,1,8)).toBeGreaterThan(100);
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

test('an imp series takes every bead colour still short, and a kill of another animal takes only its own drop',async()=>{
 const {sharedDrops,KILL_SOURCES,killAttempts,denseSpawns,killSpawns}=await import('../packages/core/src/gather');
 // The four beads (imp.rs2) come from the same imps: a red bead lying by a black-bead kill is picked up.
 for(const id of [1470,1472,1474,1476]){expect(KILL_SOURCES[id]?.npcs).toEqual([708]);expect(KILL_SOURCES[id]?.chance).toBeCloseTo(5/128);}
 expect(killAttempts(1470,1)).toBe(42);
 const gathers=[{id:1470,count:1,how:'kill' as const},{id:1472,count:1,how:'kill' as const},{id:1474,count:1,how:'kill' as const},{id:288,count:1,how:'kill' as const}];
 const targets=new Map(gathers.map(g=>[g.id,g.count]));
 const held=(id:number)=>id===1474?1:0;
 expect(sharedDrops(gathers,gathers[0]!,held,targets)).toEqual([1470,1472]);   // white already held, goblin mail is another animal
 expect(sharedDrops(gathers,gathers[1]!,held,targets)).toEqual([1472,1470]);
 expect(sharedDrops(gathers,gathers[3]!,held,targets)).toEqual([288]);
 // Imps cluster north of Yanille and on Karamja.
 const dense=denseSpawns(killSpawns(1470));
 expect(dense.some(t=>Math.max(Math.abs(t.x-2605),Math.abs(t.z-3125))<=20)).toBe(true);
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

test('a kit consumable bought nine in ten short still serves',async()=>{
 const {STACKS}=await import('./quest-sweep');
 // Arrows and runes stack; the bank pass marks their shop buys with atLeast = ceil(0.9 * count).
 expect(STACKS.has(556)).toBe(true);expect(STACKS.has(882)).toBe(true);expect(STACKS.has(1951)).toBe(false);
 expect(Math.ceil(18*0.9)).toBe(17);
});


test('elena dust need excludes only its single missing dust from the ground-floor shop plan',()=>{
 const missing=[{id:1975,count:1},{id:1927,count:1}];
 expect(heckelDustNeed('elena',missing)).toBe(true);
 expect(heckelDustNeed('rj',missing)).toBe(false);
 expect(heckelDustNeed('elena',[])).toBe(false);
 expect(heckelDustNeed('elena',plan(needs(presetFor('elena')),[{id:1975,count:1}],[]).missing)).toBe(false);
 expect(heckelDustNeed('elena',plan(new Map([[1975,1]]),[],[{id:1975,count:1}]).missing)).toBe(false);
 expect(groundShopNeeds('elena',missing)).toEqual([{id:1927,count:1}]);
 expect(groundShopNeeds('rj',missing)).toEqual(missing);
 const items=JSON.parse(readFileSync(new URL('../knowledge/items.json',import.meta.url),'utf8'));
 const item=(id:number)=>items.find((i:any)=>i.id===id),at={x:2615,z:3332,level:0};
 const planned=shopPlan(groundShopNeeds('elena',missing),at,item,nearestSeller);
 expect([...planned.buys,...planned.unsold].map(i=>i.id)).toEqual([1927]);
 expect(questGatherPlan('elena',missing,at,()=>Infinity).gathers.some(i=>i.id===1975)).toBe(false);
});

test('Heckel dust purchase observes travel, both floors, one item and coin debit',async()=>{
 let pos={x:2615,z:3332,level:0},held=0,coins=106,credit=true,travel=true,stock=0;
 const ops:number[]=[],waits:number[]=[];
 const io:HeckelIO={pos:()=>pos,held:()=>held,coins:()=>coins,
  gate:async()=>{pos={x:2461,z:3385,level:0};},
  travel:async to=>{if(travel)pos=to;return{ok:travel,detail:'fixture route'};},
  walk:async to=>{pos={...to};return{ok:true};},
  climb:async up=>{ops.push(up?1:3);pos={x:2466,z:3494,level:up?1:0};},
  open:async()=>true,row:()=>stock?{id:1975,count:stock}:undefined,
  buy:async row=>{expect(row.id).toBe(1975);if(credit){held++;coins-=2;}},close:async()=>{},
  wait:async(ok,ticks)=>{waits.push(ticks);if(ticks===110)stock=1;return ok();}};
 expect(await fetchHeckelDust(io)).toEqual({ok:true});
 expect(held).toBe(1);expect(coins).toBe(104);expect(pos.level).toBe(0);expect(ops).toEqual([1,3]);expect(waits).toContain(110);
 held=0;credit=false;
 expect(await fetchHeckelDust(io)).toMatchObject({ok:false,detail:expect.stringContaining('inventory credit unobserved')});
 travel=false;pos={x:2493,z:3488,level:0};
 expect(await fetchHeckelDust(io)).toMatchObject({ok:false,detail:expect.stringContaining('Stronghold ground leg to 2493,3488,0 failed')});
});


test('Heckel adapter uses the pinned Grand Tree ladder and its direct down option',async()=>{
 const actions:any[]=[];
 const s={direct:async(a:any)=>{actions.push(a);}} as unknown as Session;
 const io=heckelIO(s,{} as Parameters<typeof heckelIO>[1]);
 await io.climb(true);await io.climb(false);
 expect(actions).toEqual([
  {type:'interactLoc',x:2466,z:3495,locId:1747,optionIndex:1,reason:'SDK'},
  {type:'interactLoc',x:2466,z:3495,locId:1748,optionIndex:3,reason:'SDK'},
 ]);
 const map=readFileSync(new URL('../vendor/rs-sdk/server/content/maps/m38_54.jm2',import.meta.url),'utf8').split('==== LOC ====')[1]!;
 expect(map).toMatch(/^0 34 39: 1747 10\r?$/m);expect(map).toMatch(/^1 34 39: 1748 10\r?$/m);
});

test('Elena saved proof requires bought dust, exact coins/assets, completion, XP and logout',()=>{
 const before:Parameters<typeof questSweepChecks>[1]={version:10,position:{x:2615,z:3332,level:0},vars:{165:0,101:0},
  inventories:{93:[2126,1929,1929,1929,1929,952,954,1927,231].map((id,slot)=>({id,slot,count:1})),95:[{id:995,slot:0,count:106}]},
  skills:Array.from({length:21},(_,index)=>({index,rawExperience:0,xp:0,level:index===3?40:1}))};
 const after=structuredClone(before);after.vars[165]=29;after.vars[101]=1;after.skills[14]!.rawExperience=606250;
 after.inventories={93:[{id:995,slot:0,count:104},{id:952,slot:1,count:1},{id:1925,slot:2,count:4},{id:1505,slot:6,count:1}],94:[{id:1506,slot:0,count:1}],95:[]};
 const log='START 2615 3332 0\nQUEST_SWEEP_HECKEL {"item":1975,"before":0,"after":1,"coinsBefore":106,"coins":104,"observed":true}\nQUEST_SWEEP_TREE_EXIT {"ok":true,"at":{"x":2466,"z":3491,"level":0}}\nQUEST_SWEEP_GATE {"ok":true}\nMILESTONE quest-sweep elena staged at {}\nQUEST_SWEEP_FLAG {"name":"Plague City","state":"complete"}\nRESULT ok qp=1\nLOGOUT logged-out\n';
 const verify=(text=log)=>questSweepChecks('elena-heckel-dust',before,after,text,{id:'elena-heckel-dust',exit:0,timedOut:false,saveMatched:true,seconds:1});
 expect(Object.values(verify()).every(Boolean)).toBe(true);
 after.inventories[93]![0]!.count--;expect(verify().assets).toBe(false);after.inventories[93]![0]!.count++;
 after.vars[165]=28;expect(verify()).toMatchObject({quest:false});after.vars[165]=29;
 after.skills[14]!.rawExperience--;expect(verify()).toMatchObject({reward:false});after.skills[14]!.rawExperience++;
 expect(verify(log.replace('LOGOUT logged-out','')).logout).toBe(false);
 expect(verify(log.replace('"observed":true','"observed":false'))).toMatchObject({bought:false});
 expect(verify(log.replace('QUEST_SWEEP_TREE_EXIT','OMITTED_TREE_EXIT'))).toMatchObject({treeExit:false});
 expect(verify(log.replace('"z":3491','"z":3494'))).toMatchObject({treeExit:false});
});

test('a far walk whose quest guard has already aborted takes no leg and reports stopped',async()=>{
 const s:any={sdk:{getState:()=>({player:{worldX:2655,worldZ:3283,level:0},inventory:[]})},tick:()=>0};
 const r=await walkFar(s,{} as any,{x:3222,z:3218,level:0},150,{signal:AbortSignal.abort('quest guard')});
 expect(r).toEqual({ok:false,reason:'stopped',detail:'quest guard'});
});

test('the meal takes the preset food kinds first, then the best other edibles the bank holds for the units still short',()=>{
 const food=new Map([[379,4],[563,5]]);
 // No lobsters banked: four sharks stand in; the law runes are not edible and stay missing.
 expect(mealPlan(food,[],[{id:385,count:16},{id:1895,count:3}])).toEqual([{id:385,count:4}]);
 // One lobster banked and two sharks in the pack: the lobster, then one more edible unit.
 expect(mealPlan(food,[{id:385,count:2}],[{id:379,count:1},{id:333,count:5}])).toEqual([{id:379,count:1},{id:333,count:1}]);
 // Enough lobsters: nothing else.
 expect(mealPlan(food,[],[{id:379,count:9},{id:385,count:9}])).toEqual([{id:379,count:4}]);
 // Merlin's Crystal: the one bread banked is the beggar's (the quest plan withdraws it) and is no meal; a bread the pack
 // holds for the quest does not count as food carried either.
 const beggar=new Map([[2309,1]]);
 expect(mealPlan(food,[],[{id:2309,count:1}],[{id:2309,count:1}],beggar)).toEqual([]);
 expect(mealPlan(food,[{id:2309,count:1}],[{id:385,count:2}],[],beggar)).toEqual([{id:385,count:2}]);
});

test('a rune the quest needs and the preset also carries is planned once against the same bank stock',()=>{
 // Scorpion Catcher before the Barcrawl: the quest needs 3 law and 11 air runes, and the preset carries 5 law and 20 air.
 const need=new Map([[563,3],[556,11]]),food=new Map([[563,5],[556,20]]);
 const withdrawn=(bank:{id:number;count:number}[])=>{const quest=plan(need,[],bank).withdraw;return{quest,meal:mealPlan(food,[],bank,quest,need)};};
 // Three law runes banked: the quest takes all three and the meal asks for none, so no withdrawal meets an empty row.
 expect(withdrawn([{id:563,count:3},{id:556,count:40}])).toEqual({quest:[{id:563,count:3},{id:556,count:11}],meal:[{id:556,count:20}]});
 // Six banked: the quest's three, then the three that are left toward the preset's five.
 expect(withdrawn([{id:563,count:6},{id:556,count:25}]).meal).toEqual([{id:563,count:3},{id:556,count:14}]);
 // Enough banked: the preset's count on top of the quest's.
 expect(withdrawn([{id:563,count:50},{id:556,count:50}]).meal).toEqual([{id:563,count:5},{id:556,count:20}]);
 // Runes the pack holds count toward the quest first, then toward the preset.
 expect(mealPlan(food,[{id:563,count:4}],[{id:563,count:50}],[],need)).toEqual([{id:563,count:4}]);
});

test('Plague City\'s buckets of water are filled at the sink by the Ardougne bank, not fetched from the Catherby spawn',()=>{
 const ardougne={x:2655,z:3283,level:0};
 // One empty-bucket spawn by the bank cannot give four buckets: they come from the shop.
 const spawns=(id:number)=>id===1929?[{x:2823,z:3449,level:0}]:id===1925?[{x:2650,z:3290,level:0}]:[];
 const seller=(id:number)=>id===1925?300:id===1929?700:Infinity;
 const plan=gatherPlan([{id:1929,count:4}],ardougne,spawns,seller,()=>[],6,97,()=>[]);
 expect(plan.gathers).toEqual([{id:1929,count:4,how:'use'}]);
 expect(plan.still).toEqual([{id:1925,count:4}]);
});

import {fluffsExit,fluffsKittenGiven,inLumberYard,FLUFFS_FENCE} from './quest-sweep';
test('Gertrude\'s Cat without Varrock Teleport climbs the yard fence, and a kitten-given journal resumes at the exit',()=>{
 const stuck={worldX:3296,worldZ:3497,level:0},upstairs={worldX:3306,worldZ:3511,level:1},outside={worldX:3305,worldZ:3492,level:0};
 expect(FLUFFS_FENCE).toEqual({id:2618,x:3305,z:3493});
 expect([stuck,upstairs].every(inLumberYard)).toBe(true);
 expect([outside,{worldX:3212,worldZ:3424,level:0},{worldX:3296,worldZ:3497,level:2}].some(inLumberYard)).toBe(false);
 // Magic 1 or no runes inside the yard: the fence. A castable teleport, or an account already out, keeps the teleport path.
 expect(fluffsExit(false,stuck)).toBe('fence');expect(fluffsExit(false,upstairs)).toBe('fence');
 expect(fluffsExit(true,stuck)).toBe('teleport');expect(fluffsExit(false,outside)).toBe('teleport');
 // %fluffs 5: started, inside the yard, no milk, sardine or kitten held.
 expect(fluffsKittenGiven('started',[{id:995}],stuck)).toBe(true);
 expect(fluffsKittenGiven('started',[],upstairs)).toBe(true);
 for(const id of [1927,1552,1554])expect(fluffsKittenGiven('started',[{id}],stuck)).toBe(false);
 for(const state of ['not started','complete','unknown',undefined])expect(fluffsKittenGiven(state,[],stuck)).toBe(false);
 expect(fluffsKittenGiven('started',[],outside)).toBe(false);
 // The quest script skips steps 1-4 on the resume and takes the fence before the teleport's walk; the sweep hands a
 // resumed run over before any bank pass.
 const fluffs=readFileSync(new URL('./generated/quest-fluffs.ts',import.meta.url),'utf8');
 const resume=fluffs.indexOf('if (fluffsKittenGiven('),step1=fluffs.indexOf("q.talk('gertrude 1'"),fence=fluffs.indexOf("=== 'fence'"),teleport=fluffs.indexOf("q.teleport('varrock teleport'");
 expect(resume).toBeGreaterThan(0);expect(step1).toBeGreaterThan(resume);expect(fence).toBeGreaterThan(step1);expect(teleport).toBeGreaterThan(fence);
 expect(fluffs.slice(fence,teleport)).toMatch(/worldZ \?\? FENCE\.z\) < FENCE\.z/);
 const sweep=readFileSync(new URL('./quest-sweep.ts',import.meta.url),'utf8');
 expect(sweep.indexOf('QUEST_SWEEP_FLUFFS_RESUME')).toBeGreaterThan(0);
 expect(sweep.indexOf('QUEST_SWEEP_FLUFFS_RESUME')).toBeLessThan(sweep.indexOf('QUEST_SWEEP_BANK '));
});

import {BARE,bareDeposits,needs as questNeeds,presetFor as questPreset} from './quest-sweep';
test('a quest that boards the Entrana ship banks every pack row it does not use', () => {
    expect(BARE.has('zanaris')).toBe(true);
    const preset = questPreset('zanaris'), need = questNeeds(preset, false, 'zanaris'), food = questNeeds(preset, true, 'zanaris');
    // The quest's own pack: bronze axe, knife and prayer potions are needed; the teleport runes and lobsters ride as food.
    expect([...need.keys()].sort((a, b) => a - b)).toEqual([946, 1351, 2434]);
    expect([...food.keys()].sort((a, b) => a - b)).toEqual([379, 556, 557, 563]);
    const tradeable = (id: number) => id === 771 || id === 772 ? false : true;
    // An army account's pack: scimitar, shortbow, arrows and a staff go; the quest pack, coins, a meal and the
    // untradeable dramen branch of a resumed run stay.
    const pack = [1331, 841, 882, 1387, 1351, 946, 2434, 563, 556, 379, 385, 995, 771].map(id => ({ id, count: 1 }));
    expect(bareDeposits('zanaris', pack, need, food, tradeable)).toEqual([1331, 841, 882, 1387]);
});

import {shopCoinTake} from './quest-sweep';
test('the shop money of a pass comes on top of the coins the quest itself asks for',()=>{
 // Practice: Merlin's Crystal asks 500 coins; bread and a tinderbox cost 13. The pass took 500, paid 13 and failed its own check.
 expect(shopCoinTake(13,0,500,500)).toBe(13);
 // A quest that asks no coins: the coins carried and planned pay for the shops first.
 expect(shopCoinTake(25,0,0,0)).toBe(25);
 expect(shopCoinTake(25,40,0,0)).toBe(0);
 expect(shopCoinTake(25,10,0,0)).toBe(15);
 // Coins carried beyond the quest's own are shop money; coins short of it are not.
 expect(shopCoinTake(60,520,0,500)).toBe(40);
 expect(shopCoinTake(60,200,300,500)).toBe(60);
 expect(shopCoinTake(60,100,0,500)).toBe(60);
});

import {PRAYER_QUESTS,SEERS_ALTAR,prayerShort,BARE as BARE_QUESTS} from './quest-sweep';
test('an account short of prayer points prays at the Seers altar before the Camelot quests, and Holy Grail goes bare',()=>{
 // Practice: with no points Merlin's Crystal ended `step protect from melee on` in Keep Le Faye.
 expect(Object.keys(PRAYER_QUESTS).sort()).toEqual(['grail','merlin']);
 expect(prayerShort(0,77,PRAYER_QUESTS.merlin!)).toBe(true);
 expect(prayerShort(PRAYER_QUESTS.merlin!-1,77,PRAYER_QUESTS.merlin!)).toBe(true);
 expect(prayerShort(PRAYER_QUESTS.merlin!,77,PRAYER_QUESTS.merlin!)).toBe(false);
 // The Titan's three prayers want more than Merlin's one; an account whose level is under the mark is full at its level.
 expect(PRAYER_QUESTS.grail!).toBeGreaterThan(PRAYER_QUESTS.merlin!);
 expect(prayerShort(45,45,PRAYER_QUESTS.grail!)).toBe(false);
 expect(prayerShort(44,45,PRAYER_QUESTS.grail!)).toBe(true);
 // The altar is prayed at from the tile east of it.
 expect([SEERS_ALTAR.id,SEERS_ALTAR.x,SEERS_ALTAR.z]).toEqual([409,2694,3462]);
 expect([SEERS_ALTAR.stand.x as number,SEERS_ALTAR.stand.z as number]).toEqual([SEERS_ALTAR.x+1,SEERS_ALTAR.z]);
 // The Entrana ship of Holy Grail takes nothing worn.
 expect(BARE_QUESTS.has('grail')).toBe(true);
});


import {BUILD_PACK,BUILD_MEALS,buildPack} from './quest-sweep';
test('a Defence 1 build that fights with the bow takes the bow pack for Underground Pass and Regicide',()=>{
 const level=(skills:Record<string,number>)=>(skill:string)=>skills[skill]??1;
 // The halberd pure before its route: Attack 11, Ranged 99, Defence 1.
 const hally=level({Attack:11,Ranged:99,Defence:1});
 expect(buildPack('upass',hally)).toEqual([{id:861,count:1},{id:892,count:600},{id:2434,count:2}]);
 expect(buildPack('regicide',level({Attack:61,Ranged:99,Defence:1}))).toEqual([{id:861,count:1},{id:892,count:600}]);
 expect(BUILD_MEALS).toEqual({upass:12,regicide:8});
 // A quest with no bow pack, an account that wears rune armour, a melee account and one under the bow's level: none.
 expect(buildPack('cook',hally)).toEqual([]);
 expect(buildPack('upass',level({Attack:11,Ranged:99,Defence:40}))).toEqual([]);
 expect(buildPack('upass',level({Attack:99,Ranged:99,Defence:1}))).toEqual([]);
 expect(buildPack('upass',level({Attack:1,Ranged:49,Defence:1}))).toEqual([]);
 expect(Object.keys(BUILD_PACK).sort()).toEqual(['regicide','upass']);
});
