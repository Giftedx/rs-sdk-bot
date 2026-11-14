import {test,expect} from 'bun:test';
import {ARRIVAL,BANK,BLOOD_RUNE,CHEST,CHESTS,COINS,DOOR,EXIT_TICKS,LADDER_DOWN,LADDER_FOOT,LADDER_UP,PICK_LIMIT,REGEN_TICKS,RESPAWN_TICKS,STAGE,TRAVEL_TICKS,bloodOptions,bloodRefusal,bloodZone,chestEffect,failureResult,runBloodChest,walkBloodDungeon,type BloodDeps} from './blood-chest';
import type {PathDeps} from '../packages/core/src/walk';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';

const options={maxLoots:2,cap:2000,idleTicks:700,bankEvery:50};
test('stranded dungeon step 2574,9742 reaches the chest stage despite an empty SDK plan',async()=>{
 const p={x:2574,z:9742,level:0},clicks:{x:number;z:number}[]=[],listeners=new Set<()=>void>();
 let tick=0,target={...p};
 const d:PathDeps={tick:()=>tick,pos:()=>p,onTick:cb=>{listeners.add(cb);return()=>{listeners.delete(cb);};},
  plan:()=>[],locs:()=>[],walk:(x,z)=>{clicks.push({x,z});target={x,z,level:0};return{success:true};},interactLoc:()=>{throw Error('no door on dungeon leg');}};
 const travel=walkBloodDungeon(d,STAGE.x,STAGE.z,1,()=>false);
 expect(clicks.length).toBeGreaterThan(0);
 for(let i=0;i<160&&listeners.size;i++){p.x+=Math.sign(target.x-p.x);p.z+=Math.sign(target.z-p.z);tick++;for(const cb of [...listeners])cb();}
 expect(await travel).toBe(true);
 expect(Math.max(Math.abs(p.x-STAGE.x),Math.abs(p.z-STAGE.z))).toBeLessThanOrEqual(1);
 expect(listeners.size).toBe(0);
 // An accepted click with no movement cannot count as arrival.
 p.x=2574;p.z=9742;tick=0;
 const stuck=walkBloodDungeon(d,STAGE.x,STAGE.z,1,()=>false);
 for(let i=0;i<160&&listeners.size;i++){tick++;for(const cb of [...listeners])cb();}
 expect(await stuck).toBe(false);expect(tick).toBeLessThanOrEqual(151);expect(listeners.size).toBe(0);
});
// A small model of the native route: door, ladders, chests with respawn, bank.
function world(p:{thieving?:number;x?:number;z?:number;pickAfter?:number;hp?:number;coins?:number;cake?:number;hitAt?:number;bankCake?:number;hitPerLoot?:number;base?:number;lobster?:number;bankLobster?:number;regen?:boolean}={}){
 const w={x:p.x??ARRIVAL.x,z:p.z??ARRIVAL.z,level:0,tick:0,xp:1000,hp:p.hp??56,base:p.base??56,runes:0,coins:p.coins??0,cake:p.cake??3,lobster:p.lobster??0,bankCake:p.bankCake??0,bankLobster:p.bankLobster??0,lifeId:1,
  bankRunes:0,bankCoins:0,bankCalls:0,fails:p.pickAfter??0,chestUntil:CHESTS.map(()=>0),acts:[] as {id:number;option:number;x:number;z:number;tick:number}[],
  messages:[] as {type:number;text:string;sender:string;tick:number}[],stopped:false,surfaceWalks:[] as string[],dungeonWalks:[] as string[],travels:[] as string[]};
 const state=()=>({player:{worldX:w.x,worldZ:w.z,level:w.level,lifeId:w.lifeId,isDead:false},
  skills:[{name:'Thieving',level:p.thieving??99,baseLevel:p.thieving??99,experience:w.xp},{name:'Hitpoints',level:w.hp,baseLevel:w.base,experience:1000}],
  inventory:[...(w.lobster?[{id:379,count:w.lobster,slot:3,name:'Lobster',optionsWithIndex:[{text:'Eat',opIndex:1}]}]:[]),...(w.cake?[{id:1895,count:w.cake,slot:0,name:'Slice of cake',optionsWithIndex:[{text:'Eat',opIndex:1}]}]:[]),...(w.coins?[{id:COINS,count:w.coins,slot:1,name:'Coins',optionsWithIndex:[]}]:[]),...(w.runes?[{id:BLOOD_RUNE,count:w.runes,slot:2,name:'Blood rune',optionsWithIndex:[]}]:[])],
  gameMessages:w.messages,nearbyNpcs:[],
  nearbyLocs:[{id:DOOR.id,x:DOOR.x,z:DOOR.z,level:0,optionsWithIndex:[{text:'Open',opIndex:1},{text:'Pick Lock',opIndex:2}]},
   ...CHESTS.filter((_,i)=>w.chestUntil[i]!<=w.tick).map(c=>({id:CHEST,x:c.x,z:c.z,level:0,optionsWithIndex:[{text:'Open',opIndex:1},{text:'Search for traps',opIndex:2}]}))]} as unknown as BotWorldState);
 // The server's health_regen timer: 1 Hitpoint each REGEN_TICKS from login.
 const step=async()=>{w.tick++;if(w.tick===p.hitAt)w.hp=20;if(p.regen&&w.tick%REGEN_TICKS===0)w.hp=Math.min(w.base,w.hp+1);};
 const d:BloodDeps={state,tick:()=>w.tick,stopped:()=>w.stopped,
  walkSurface:async(x,z)=>{w.surfaceWalks.push(`${x},${z}`);w.x=x;w.z=z;w.tick+=20;return true;},
  travel:async(x,z)=>{w.travels.push(`${x},${z}`);w.x=x;w.z=z;w.tick+=600;return true;},
  walkDungeon:async(x,z)=>{w.dungeonWalks.push(`${x},${z}`);w.x=x;w.z=z;w.tick+=15;return true;},
  act:async(x,z,id,option)=>{
   w.acts.push({id,option,x,z,tick:w.tick});
   if(id===DOOR.id&&option===2){
    if(w.fails-->0)w.messages.push({type:0,text:'You fail to pick the lock.',sender:'',tick:w.tick});
    else{w.x=DOOR.x-1;w.z=DOOR.z;w.xp+=375;}
   }
   else if(id===DOOR.id&&option===1){w.x=DOOR.x;w.z=DOOR.z;}
   else if(id===LADDER_DOWN.id){w.x=LADDER_FOOT.x;w.z=LADDER_FOOT.z;}
   else if(id===LADDER_UP.id){w.x=LADDER_DOWN.x+1;w.z=LADDER_DOWN.z;}
   else if(id===CHEST){
    const i=CHESTS.findIndex(c=>c.x===x&&c.z===z);
    if(w.chestUntil[i]!>w.tick)return{success:true};
    w.runes+=2;w.coins+=500;w.xp+=2500;w.hp-=p.hitPerLoot??0;w.chestUntil[i]=w.tick+300;w.x=ARRIVAL.x;w.z=ARRIVAL.z;
   }
   return{success:true};
  },
  wait:async(check,ticks)=>{for(let i=0;i<ticks;i++){if(check())return true;await step();}return check();},
  step,
  bank:async food=>{const cake=food?w.bankCake:0,lobster=food?w.bankLobster:0,r={runes:w.runes,coins:w.coins,food:cake+lobster};w.bankCalls++;w.bankRunes+=w.runes;w.bankCoins+=w.coins;w.runes=0;w.coins=0;w.cake+=cake;w.bankCake-=cake;w.lobster+=lobster;w.bankLobster-=lobster;return r;},
  eat:async item=>{if(item.id===379){w.lobster--;w.hp=Math.min(w.base,w.hp+12);}else{w.cake--;w.hp=Math.min(w.base,w.hp+20);}return{success:true};},
  log:()=>{}};
 return{w,d,state};
}

test('options need a tick cap, take the lower cap and keep finite limits',()=>{
 expect(()=>bloodOptions(undefined,{})).toThrow('tickCap');
 expect(()=>bloodOptions('nope',{})).toThrow('tickCap');
 expect(()=>bloodOptions('24000',{MAX_LOOTS:'0'})).toThrow('MAX_LOOTS');
 expect(()=>bloodOptions(String(EXIT_TICKS-1),{})).toThrow('tickCap');
 expect(()=>bloodOptions('24000',{IDLE_TICKS:'900'})).toThrow('IDLE_TICKS');
 expect(bloodOptions('24000',{MAX_LOOTS:'100',CAP:'24000'})).toEqual({maxLoots:100,cap:24000,idleTicks:700,bankEvery:50});
 expect(bloodOptions('24000',{CAP:'5000'}).cap).toBe(5000);
 expect(bloodOptions('5000',{CAP:'24000'}).cap).toBe(5000);
});
test('zones follow the native tiles on both sides of the door',()=>{
 const at=(x:number,z:number,level=0)=>({player:{worldX:x,worldZ:z,level}} as unknown as BotWorldState);
 expect(bloodZone(at(DOOR.x,DOOR.z))).toBe('surface');
 expect(bloodZone(at(DOOR.x-1,DOOR.z))).toBe('tower');
 expect(bloodZone(at(LADDER_FOOT.x,LADDER_FOOT.z))).toBe('dungeon');
 expect(bloodZone(at(ARRIVAL.x,ARRIVAL.z))).toBe('surface');
 expect(bloodZone(at(DOOR.x-1,DOOR.z,1))).toBe('other');
 expect(bloodZone(at(2900,9800))).toBe('other');
});
test('chest effect needs both rewards, XP, kept assets and the teleport',()=>{
 const {state,w}=world({x:STAGE.x,z:STAGE.z});
 const before=state();
 expect(chestEffect(before,state())).toBe(false);
 w.runes=2;w.coins=500;w.xp+=2500;
 expect(chestEffect(before,state())).toBe(false);
 w.x=ARRIVAL.x;w.z=ARRIVAL.z;
 expect(chestEffect(before,state())).toBe(true);
 w.coins=499;expect(()=>chestEffect(before,state())).toThrow('reconcile');
 w.coins=500;w.xp-=2500;expect(()=>chestEffect(before,state())).toThrow('reconcile');
 w.xp+=2500;w.cake=2;expect(()=>chestEffect(before,state())).toThrow('assets');
});
test('the reward first observed at 2584,3340 counts as a loot and keeps the reward and kit checks',async()=>{
 const {w,d,state}=world({coins:100}),act=d.act;
 d.act=async(...a)=>{const r=await act(...a);if(a[2]===CHEST)w.z=3340;return r;};
 const r=await runBloodChest(d,options);
 expect(r).toMatchObject({ok:true,stop:'target',conserved:true,loots:2,bankedRunes:4,bankedCoins:1100,entries:2});
 expect(w.acts.filter(a=>a.id===CHEST)).toHaveLength(2);
 w.x=STAGE.x;w.z=STAGE.z;w.runes=0;w.coins=0;
 const before=state();
 w.x=2584;w.z=3340;w.runes=2;w.coins=500;w.xp+=2500;
 expect(chestEffect(before,state())).toBe(true);
 w.coins=499;expect(()=>chestEffect(before,state())).toThrow('reconcile');
 w.coins=500;w.cake=2;expect(()=>chestEffect(before,state())).toThrow('assets');
});
test('two loots use op2 on both chests, bank the exact reward and reconcile',async()=>{
 const {w,d}=world({coins:100,pickAfter:3});
 const r=await runBloodChest(d,options);
 expect(r).toMatchObject({ok:true,stop:'target',targetMet:true,conserved:true,loots:2,runes:4,coins:1000,bankedRunes:4,bankedCoins:1100,startCoins:100,bankTrips:1,entries:2,died:false});
 expect(r.picks).toBeGreaterThanOrEqual(5);
 const chests=w.acts.filter(a=>a.id===CHEST);
 expect(chests.map(a=>a.option)).toEqual([2,2]);
 expect(chests.map(a=>a.z).sort()).toEqual(CHESTS.map(c=>c.z).sort());
 expect(w.bankRunes).toBe(4);expect(w.runes).toBe(0);expect(w.coins).toBe(0);expect(w.cake).toBe(3);
 expect(w.surfaceWalks.at(-1)).toBe(`${BANK.x},${BANK.z}`);
});
test('100 successful entries reset the door bound and bank 200 runes within the consumer cap',async()=>{
 const {w,d}=world({pickAfter:1}),act=d.act;
 // Each visit needs one failed pick and one observed entry.
 d.act=async(...a)=>{const r=await act(...a);if(a[2]===CHEST)w.fails=1;return r;};
 const r=await runBloodChest(d,bloodOptions('24000',{MAX_LOOTS:'100',CAP:'24000'}));
 expect(r).toMatchObject({ok:true,stop:'target',targetMet:true,conserved:true,loots:100,runes:200,coins:50000,bankedRunes:200,bankedCoins:50000,bankTrips:2,picks:200,entries:100,died:false});
 expect(w.acts.filter(a=>a.id===DOOR.id&&a.option===2)).toHaveLength(200);
 expect(w.acts.filter(a=>a.id===CHEST)).toHaveLength(100);
 expect(w.bankRunes).toBe(200);expect(w.bankCoins).toBe(50000);
 expect(w.runes).toBe(0);expect(w.coins).toBe(0);expect(w.cake).toBe(3);
 expect(w.surfaceWalks.at(-1)).toBe(`${BANK.x},${BANK.z}`);
 expect(r.ticks).toBeLessThan(24000);
});
test('below Thieving59 the run refuses before any action',async()=>{
 const {w,d,state}=world({thieving:58});
 await expect(runBloodChest(d,options)).rejects.toThrow('blood chest refused: Thieving 58 is below level 59');
 expect(w.acts).toEqual([]);expect(w.surfaceWalks).toEqual([]);
 expect(bloodRefusal(state(),options)).toContain('Thieving 58');
 expect(failureResult(Error('blood chest refused: Thieving 58 is below level 59')).stop).toBe('refused');
 expect(failureResult(Error('blood chest walk failed: door')).stop).toBe('failed');
 const full=world();full.w.cake=0;const pack=full.state();pack.inventory=Array.from({length:28},(_,slot)=>({id:1895,count:1,slot,name:'Slice of cake'})) as BotWorldState['inventory'];
 expect(bloodRefusal(pack,options)).toContain('no room');
});
test('the loop waits on the surface for the respawn and banks at the set interval',async()=>{
 const {w,d}=world();
 const r=await runBloodChest(d,{...options,maxLoots:4,bankEvery:2,cap:5000});
 expect(r).toMatchObject({ok:true,loots:4,bankedRunes:8,bankedCoins:2000,bankTrips:2});
 const loots=w.acts.filter(a=>a.id===CHEST);
 expect(loots.length).toBe(4);
 expect(loots[2]!.tick-loots[0]!.tick).toBeGreaterThan(RESPAWN_TICKS-80);
 expect(w.dungeonWalks.every(t=>t===`${STAGE.x},${STAGE.z}`)).toBe(true);
});
test('Hitpoints below half with no food leave by the ladder and the door, then bank the loot',async()=>{
 const {w,d}=world({hitAt:3,x:STAGE.x,z:STAGE.z,coins:40,cake:0});
 w.chestUntil=[100000,100000];
 const r=await runBloodChest(d,options);
 // The ladder climb reaches the tower tile without a door entry.
 expect(r).toMatchObject({ok:false,stop:'hp',targetMet:false,conserved:true,loots:0,bankedCoins:40,bankTrips:1,entries:0,hpMin:20});
 expect(w.acts.map(a=>[a.id,a.option])).toEqual([[LADDER_UP.id,1],[DOOR.id,1]]);
 expect(w.dungeonWalks.at(-1)).toBe(`${LADDER_FOOT.x},${LADDER_FOOT.z}`);
});
test('Hitpoints below half eat on the surface, restock at the bank and finish the target',async()=>{
 const {w,d}=world({cake:1,bankCake:20,hitPerLoot:10});
 const r=await runBloodChest(d,{...options,maxLoots:12,cap:20000});
 expect(r).toMatchObject({ok:true,stop:'target',conserved:true,loots:12,bankedRunes:24,bankedCoins:6000});
 expect(r.meals).toBeGreaterThan(1);expect(r.hpMin).toBeGreaterThanOrEqual(18);
 expect(w.bankCake).toBe(0);expect(w.cake).toBe(21-r.meals);
});
test('a food stock that runs out ends the run at the hp stop with the loot banked',async()=>{
 const {d}=world({cake:1,hitPerLoot:10});
 const r=await runBloodChest(d,{...options,maxLoots:12,cap:20000});
 expect(r).toMatchObject({ok:false,stop:'hp',targetMet:false,conserved:true,meals:1});
 expect(r.loots).toBeGreaterThan(0);expect(r.loots).toBeLessThan(12);
 expect(r.bankedRunes).toBe(r.loots*2);
});
// MineYourBiz death: one trip cost up to 12 of 47 Hitpoints, and three trips started at 25-26 Hitpoints.
test('a 47 Hitpoints account eats before the door at 25 and leaves the dungeon at 27',async()=>{
 const {w,d}=world({hp:25,base:47,cake:0,lobster:1}),order:string[]=[],act=d.act,eat=d.eat;
 d.act=async(...a)=>{order.push(a[2]===DOOR.id?'door':'act');return act(...a);};
 d.eat=async item=>{order.push(`eat ${w.hp}`);return eat(item);};
 const r=await runBloodChest(d,options);
 expect(order[0]).toBe('eat 25');expect(order.indexOf('door')).toBeGreaterThan(0);
 expect(r).toMatchObject({ok:true,stop:'target',conserved:true,loots:2,meals:1});
 expect(w.lobster).toBe(0);
 const low=world({hp:27,base:47,cake:0,x:STAGE.x,z:STAGE.z});
 const left=await runBloodChest(low.d,options);
 expect(left).toMatchObject({ok:false,stop:'hp',loots:0,hpMin:27});
 expect(low.w.acts.some(a=>a.id===CHEST)).toBe(false);
 expect(low.w.acts.map(a=>[a.id,a.option])).toEqual([[LADDER_UP.id,1],[DOOR.id,1]]);
});
// Magicwanda: Hitpoints base 39 at 2618,3332 beside the bank, no food in the pack, 80 Lobster in the bank.
test('a low Hitpoints surface start with no pack food banks for Lobster, eats and loots to the target',async()=>{
 const {w,d,state}=world({hp:15,base:39,cake:0,x:2618,z:3332,bankLobster:80}),order:string[]=[],bank=d.bank,eat=d.eat;
 expect(bloodRefusal(state(),options)).toBeNull();
 d.bank=async food=>{order.push(`bank ${food}`);return bank(food);};
 d.eat=async item=>{order.push(`eat ${item.name}`);return eat(item);};
 const r=await runBloodChest(d,options);
 expect(order.slice(0,3)).toEqual(['bank true','eat Lobster','eat Lobster']);
 expect(r).toMatchObject({ok:true,stop:'target',targetMet:true,conserved:true,loots:2,bankedRunes:4,bankedCoins:1000,meals:2});
 expect(w.acts.filter(a=>a.id===CHEST)).toHaveLength(2);
 expect(w.lobster).toBe(78);expect(w.runes).toBe(0);expect(w.coins).toBe(0);
 // Below the door no bank is in reach, so the same Hitpoints there still refuse.
 const tower=world({hp:15,base:39,cake:0,x:DOOR.x-1,z:DOOR.z,bankLobster:80});
 await expect(runBloodChest(tower.d,options)).rejects.toThrow('Hitpoints are below half');
 expect(tower.w.acts).toEqual([]);
});
test('a low Hitpoints surface start with no food in the bank ends at the hp stop and loses no loot',async()=>{
 const {w,d}=world({hp:15,base:39,cake:0,x:2618,z:3332,coins:40});
 w.runes=6;
 const r=await runBloodChest(d,options);
 expect(r).toMatchObject({ok:false,stop:'hp',targetMet:false,conserved:true,loots:0,meals:0,startRunes:6,startCoins:40,bankedRunes:6,bankedCoins:40});
 expect(w.acts).toEqual([]);
 expect(w.runes).toBe(0);expect(w.coins).toBe(0);expect(w.bankRunes).toBe(6);expect(w.bankCoins).toBe(40);
});
// CoinCock: Hitpoints 34 of base 47 beside the bank, no food in the pack or the bank, a 4000 tick cap.
test('a surface start below the fed level with no food waits for regeneration, then loots',async()=>{
 const {w,d}=world({hp:34,base:47,cake:0,x:2618,z:3332,regen:true});
 const r=await runBloodChest(d,{...options,cap:4000});
 expect(r).toMatchObject({ok:true,stop:'target',targetMet:true,conserved:true,loots:2,meals:0});
 expect(w.hp).toBeGreaterThanOrEqual(Math.ceil(47*0.75)-2);
 // A gap that the cap cannot cover still ends at the hp stop at once.
 const short=world({hp:15,base:39,cake:0,x:2618,z:3332,regen:true});
 expect(await runBloodChest(short.d,options)).toMatchObject({ok:false,stop:'hp',loots:0});
 expect(short.w.tick).toBeLessThan(REGEN_TICKS);
});
test('food with no observed effect fails the run',async()=>{
 const {d}=world({hp:20});
 d.eat=async()=>({success:true});
 await expect(runBloodChest(d,options)).rejects.toThrow('food effect unobserved');
 const refused=world({hp:20});refused.d.eat=async()=>({success:false});
 await expect(runBloodChest(refused.d,options)).rejects.toThrow('food refused');
});
test('the soft cap leaves the dungeon and keeps the hard cap for the exit',async()=>{
 const {w,d}=world({x:STAGE.x,z:STAGE.z,coins:7});
 const r=await runBloodChest(d,{...options,cap:EXIT_TICKS});
 expect(r).toMatchObject({ok:false,stop:'cap',loots:0,bankedCoins:7,conserved:true});
 expect(w.acts.some(a=>a.id===CHEST)).toBe(false);
 const late=world({x:STAGE.x,z:STAGE.z,coins:7});const walk=late.d.walkDungeon;
 late.d.walkDungeon=async(x,z,t)=>{await walk(x,z,t);late.w.tick+=EXIT_TICKS;return true;};
 await expect(runBloodChest(late.d,{...options,cap:EXIT_TICKS})).rejects.toThrow('tick cap');
});
test('a taken chest ends at the idle limit and still exits',async()=>{
 const {w,d}=world({x:STAGE.x,z:STAGE.z,coins:1});
 w.chestUntil=[100000,100000];
 expect(await runBloodChest(d,{...options,idleTicks:20})).toMatchObject({ok:false,stop:'idle',loots:0,bankedCoins:1});
});
test('a stop request, a death and a stuck door end the run',async()=>{
 const stopped=world();stopped.w.stopped=true;
 await expect(runBloodChest(stopped.d,options)).rejects.toThrow('stopped');
 expect(stopped.w.acts).toEqual([]);
 const dead=world({x:STAGE.x,z:STAGE.z});const act=dead.d.act;
 dead.d.act=async(...a)=>{const r=await act(...a);dead.w.lifeId=2;return r;};
 await expect(runBloodChest(dead.d,options)).rejects.toThrow('died');
 const door=world({pickAfter:PICK_LIMIT+5});
 await expect(runBloodChest(door.d,{...options,cap:100000,idleTicks:850})).rejects.toThrow('door not picked');
 expect(door.w.acts.filter(a=>a.id===DOOR.id).length).toBe(PICK_LIMIT);
});
test('a failed walk stops after the bound',async()=>{
 const {w,d}=world();
 d.walkSurface=async()=>false;
 await expect(runBloodChest(d,options)).rejects.toThrow('walk failed: door');
 expect(w.travels).toEqual([]);
});
// MagicWanda started at 3185,3436 after the GE food buy, and six door walks ended with no move.
test('a start at the Varrock GE 3185,3436 travels to the Ardougne bank once before the first door walk',async()=>{
 const {w,d}=world({x:3185,z:3436}),order:string[]=[],travel=d.travel,walk=d.walkSurface;
 d.travel=async(x,z,t)=>{order.push(`travel ${x},${z}`);expect(t).toBeLessThanOrEqual(TRAVEL_TICKS);return travel(x,z,t);};
 d.walkSurface=async(x,z)=>{order.push(`walk ${x},${z}`);return walk(x,z);};
 const r=await runBloodChest(d,options);
 expect(r).toMatchObject({ok:true,stop:'target',conserved:true,loots:2,bankedRunes:4});
 expect(w.travels).toEqual([`${BANK.x},${BANK.z}`]);
 expect(order[0]).toBe(`travel ${BANK.x},${BANK.z}`);expect(order[1]).toBe(`walk ${DOOR.x},${DOOR.z}`);
 const failed=world({x:3185,z:3436});failed.d.travel=async()=>false;
 await expect(runBloodChest(failed.d,options)).rejects.toThrow('blood chest travel failed: start 3185,3436,0');
 expect(failed.w.surfaceWalks).toEqual([]);expect(failed.w.acts).toEqual([]);
 // An accepted travel with no arrival near the bank fails the same way.
 const short=world({x:3185,z:3436});short.d.travel=async()=>{short.w.x=2900;return true;};
 await expect(runBloodChest(short.d,options)).rejects.toThrow('start 3185,3436,0');
});
