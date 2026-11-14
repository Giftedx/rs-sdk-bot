import {test,expect} from 'bun:test';
import {miningProfiles,runAtSiteMining,type MiningDriver} from './microbot-b-mining';
import {respawnTicks,knifeDelay,firstRoll,siteRocks,siteTiles,contentSites,standTiles,oreLag,MINING_SITES,KNIFE,NORMAL_LOGS,type MiningAction,type Tile} from './mining-rotation';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';

const iron=()=>miningProfiles().find(p=>p.name==='iron_rock_table')!;
const IRON_ORE=iron().products[0]!,MAKE1=99;

test('server numbers: respawn scaling, the knife delay and the first swing',()=>{
 expect(respawnTicks(20,1)).toBe(19);expect(respawnTicks(20,1400)).toBe(13);expect(respawnTicks(20,5000)).toBe(10);
 expect(knifeDelay(5,10)).toBe(12);expect(knifeDelay(10,10)).toBe(10);expect(knifeDelay(12,10)).toBe(12);
 expect(firstRoll(5,10,2)).toEqual({roll:12,delay:12});expect(firstRoll(10,10,2)).toEqual({roll:10,delay:10});expect(firstRoll(11,10,6)).toEqual({roll:11,delay:11});
 expect(oreLag(iron())).toBe(0);expect(oreLag(miningProfiles().find(p=>p.name==='coal_rock_table')!)).toBe(1);
});

test('the Ardougne zoo site has its six iron rocks from the map files, and every iron site is found',()=>{
 const zoo=MINING_SITES.find(s=>s.key==='ardougne-zoo-iron')!;
 expect(siteRocks(iron(),zoo.center,zoo.radius).map(r=>`${r.x},${r.z}`)).toEqual(['2602,3233','2602,3234','2602,3236','2605,3233','2605,3235','2605,3237']);
 expect(siteTiles(iron(),MINING_SITES.find(s=>s.key==='ardougne-zoo-iron-9')!).map(r=>`${r.x},${r.z}`).slice(6)).toEqual(['2590,3230','2591,3232','2592,3234']);
 const sites=contentSites(iron());expect(sites.some(s=>s.rocks.length===6&&s.rocks.some(r=>r.x===2602&&r.z===3233))).toBe(true);
 expect(sites.reduce((n,s)=>n+s.rocks.length,0)).toBe(siteRocks(iron(),{x:0,z:0,level:0},99999).length);
 expect(standTiles({x:2602,z:3233,level:0},siteRocks(iron(),zoo.center,zoo.radius)).map(t=>`${t.x},${t.z}`)).toEqual(['2603,3233','2601,3233','2602,3232']);
});

// A small copy of skill_mining/scripts/mining.rs2 and cut_logs.rs2 on an open floor: actions run in order at the
// start of a tick, then the queues, then the interaction (in range, else 2 steps of run and the swing in the next
// tick, as the bench trace shows), then respawns. A level-up window holds the swing until a click closes it.
function sim(o:{rate:number;respawn:number;rocks:Tile[];start:{x:number;z:number};dropLag?:number}){
 let lagged:{at:number;slot:number}[]=[];
 const rocks=o.rocks.map(r=>({...r,up:true,back:0}));
 let tick=0,delay=-1,xp=0,pending:MiningAction[]=[],fletches=0,dialog=false,close=false,levelUp=false,opensAt=-1,ores=0;
 let pos={...o.start},target:{x:number;z:number}|undefined,interaction:{rock:typeof rocks[number];first:boolean}|undefined,weak:number|undefined;
 const inv:({id:number;count:number}|undefined)[]=[{id:1275,count:1},{id:KNIFE,count:1},{id:NORMAL_LOGS,count:1}];
 const beside=(r:Tile)=>Math.abs(pos.x-r.x)+Math.abs(pos.z-r.z)===1;
 const clear=()=>{interaction=undefined;weak=undefined;dialog=false;levelUp=false;};
 const roll=(r:typeof rocks[number])=>{r.up=false;r.back=tick+o.respawn;const free=inv.findIndex(i=>!i);if(free>=0)inv[free]={id:IRON_ORE,count:1};else inv.push({id:IRON_ORE,count:1});xp+=875;interaction=undefined;if(++ores%8===0)opensAt=tick+1;};
 const op=()=>{const it=interaction!;if(!it.rock.up){interaction=undefined;return;}
  if(it.first){if(delay<tick)delay=tick+o.rate;else if(delay===tick)roll(it.rock);else it.first=false;return;}
  if(delay<tick)delay=tick+o.rate;else if(delay===tick)roll(it.rock);};
 const step=()=>{
  tick++;
  for(const a of pending){
   if(a.type==='dropItem'){if(o.dropLag)lagged.push({at:tick+o.dropLag,slot:a.slot});else inv[a.slot]=undefined;}
   else if(a.type==='useItemOnItem'){clear();dialog=true;}
   else if(a.type==='clickComponent'&&dialog){dialog=false;if(delay<tick)delay=tick+2;weak=tick+2;}
   else if(a.type==='interactLoc'){clear();const r=rocks.find(r=>r.x===a.x&&r.z===a.z)!;interaction={rock:r,first:true};target=standTiles(r,rocks).sort((p,q)=>Math.max(Math.abs(p.x-pos.x),Math.abs(p.z-pos.z))-Math.max(Math.abs(q.x-pos.x),Math.abs(q.z-pos.z)))[0];}
   else if(a.type==='walkTo'){clear();target={x:a.x,z:a.z};}
   else if(a.type==='closeModal')close=true;
  }
  pending=[];
  for(const l of lagged.filter(l=>l.at<=tick))inv[l.slot]=undefined;lagged=lagged.filter(l=>l.at>tick);
  if(close){weak=undefined;close=false;levelUp=false;}
  if(opensAt===tick)levelUp=true;
  if(weak===tick){weak=undefined;const l=inv.findIndex(i=>i?.id===NORMAL_LOGS);if(l>=0){inv[l]=undefined;fletches++;}}
  if(levelUp){/* the window holds the swing */}
  else if(interaction&&beside(interaction.rock))op();
  else{for(let k=0;k<2&&target&&(pos.x!==target.x||pos.z!==target.z);k++)pos={x:pos.x+Math.sign(target.x-pos.x),z:pos.z+Math.sign(target.z-pos.z)};}
  for(const r of rocks)if(!r.up&&r.back===tick)r.up=true;
 };
 const state=()=>({player:{worldX:pos.x,worldZ:pos.z,level:0,lifeId:1},skills:[{name:'Mining',level:64,experience:xp},{name:'Hitpoints',level:10}],
  inventory:inv.flatMap((i,slot)=>i?[{...i,slot}]:[]),equipment:[],nearbyPlayers:[],dialog:{isOpen:levelUp},interface:{isOpen:false},
  nearbyLocs:rocks.map(r=>({id:r.up?iron().rocks[0]:450,x:r.x,z:r.z,level:0,distance:0,optionsWithIndex:r.up?[{text:'Mine',opIndex:1}]:[]}))} as unknown as BotWorldState);
 const d:MiningDriver={state,tick:()=>tick,stop:()=>false,mine:async()=>true,wait:async()=>true,step:async()=>step(),send:async a=>{pending.push(...a);}};
 return{d,fletches:()=>fletches};
}
// The zoo shape: two columns of three rocks, two tiles apart.
const ZOO:Tile[]=[{x:0,z:0},{x:0,z:1},{x:0,z:3},{x:3,z:0},{x:3,z:2},{x:3,z:4}].map(t=>({...t,level:0}));
const run=async(knife:boolean,rate:number,respawn:number,rocks=ZOO,maximum=60,dropLag=0)=>{
 const s=sim({rate,respawn,rocks,start:{x:1,z:1},dropLag});
 const r=await runAtSiteMining(s.d,iron(),{maximum,cap:5000,idleTicks:500,rotation:{knife,drop:true,make1:MAKE1,players:1,rocks}}) as any;
 return{per:(r.rolls.at(-1)-r.rolls[0])/(r.rolls.length-1),r,fletches:s.fletches()};
};

// Each tile of the zoo shape touches one rock, so each ore needs a step to the next rock, and the swing starts the
// tick after the step: the knife cut in the click tick hides that tick.
test('rune pickaxe, plenty of rocks: 3 ticks an ore with the knife, over 4 without; the pack stays open',async()=>{
 const plain=await run(false,2,4),knife=await run(true,2,4);
 expect(knife.per).toBeCloseTo(3,2);expect(plain.per).toBeGreaterThan(4);
 for(const x of [plain,knife]){expect(x.r.made).toBe(60);expect(x.r.dropped).toBeGreaterThan(30);expect(x.fletches).toBe(0);}
});
test('adamant pickaxe (mining_rate 3): the knife holds 3 ticks an ore, plain mining takes over 5',async()=>{
 expect((await run(false,3,4)).per).toBeGreaterThan(5);expect((await run(true,3,4)).per).toBeCloseTo(3,2);
});
test('respawn 19 on six rocks: the knife cut 2 ticks before the respawn makes the click roll at once',async()=>{
 const plain=await run(false,2,19,ZOO,90),knife=await run(true,2,19,ZOO,90);
 expect(knife.per).toBeLessThan(plain.per);expect(knife.per).toBeLessThanOrEqual(20/6);expect(knife.r.preArms).toBeGreaterThan(5);expect(knife.fletches).toBe(0);expect(knife.r.respawn).toBe(19);
});
// The zoo with the three rocks 10 tiles west: the pick waits a tick for a zoo rock rather than walk 6 ticks west.
test('nine rocks with a 6-tick walk between the groups are no slower than six',async()=>{
 const NINE=[...ZOO,...[{x:-12,z:-3},{x:-11,z:-1},{x:-10,z:1}].map(t=>({...t,level:0}))];
 const six=await run(true,2,18,ZOO,90),nine=await run(true,2,18,NINE,90);
 expect(nine.per).toBeLessThanOrEqual(six.per+0.01);expect(nine.fletches).toBe(0);
});

// Live, a drop can show in the pack two ticks after it was sent (WeeQuickie: "mining item lost without a drop").
test('a drop that shows two ticks late is a drop, not a lost item; each slot drops once while it is pending',async()=>{
 const x=await run(true,2,4,ZOO,60,2);
 expect(x.r.made).toBe(60);expect(x.r.dropped).toBeGreaterThan(30);expect(x.per).toBeLessThan(3.2);
});
