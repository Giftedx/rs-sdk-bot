import {test,expect} from 'bun:test';
import {miningProfiles,eligiblePickaxe,miningEffect,selectMiningRock,inPerfectMine,runAtSiteMining,type MiningDriver} from './microbot-b-mining';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';
const profile=()=>miningProfiles().find(p=>p.name==='runite_rock_table')!;
const state=()=>({player:{worldX:3000,worldZ:3500,level:0,lifeId:1},skills:[{name:'Mining',level:85,experience:1000},{name:'Hitpoints',level:99}],inventory:[{id:1275,count:1,slot:0}],equipment:[],nearbyPlayers:[],nearbyLocs:[{id:profile().rocks[0],x:3001,z:3500,level:0,distance:1,optionsWithIndex:[{text:'Mine',opIndex:1}]}]} as unknown as BotWorldState);
test('native profiles resolve remaining metals, gems, limestone and perfect gold without gas/approval nodes',()=>{
 const profiles=miningProfiles();for(const name of ['coal_rock_table','gold_rock_table','silver_rock_table','mithril_rock_table','adamantite_rock_table','runite_rock_table','blurite_rock','gem_rock','desertrescue_rock','limestone_rock1','limestone_rock2','limestone_rock3','perfect_gold_rock_table']){const p=profiles.find(p=>p.name===name)!;expect(p.rocks.length).toBeGreaterThan(0);expect(p.products.length).toBeGreaterThan(0);}
 expect(profile().level).toBe(85);expect(profiles.find(p=>p.name==='gem_rock')!.products.length).toBe(7);
 const s=state();expect(eligiblePickaxe(s)?.id).toBe(1275);s.skills[0]!.level=40;expect(eligiblePickaxe(s)).toBeUndefined();s.inventory[0]!.id=1265;expect(eligiblePickaxe(s)?.id).toBe(1265);
 s.inventory=[];s.equipment=[{id:1275,slot:5,count:1} as any];s.skills[0]!.level=99;expect(eligiblePickaxe(s)).toBeUndefined();s.equipment[0]!.slot=3;expect(eligiblePickaxe(s)?.id).toBe(1275);
});
test('mine selection requires exact reachable floor, Mine1 and no nearby competing player',()=>{
 const s=state();expect(selectMiningRock(s,profile())?.id).toBe(profile().rocks[0]!);s.nearbyPlayers=[{x:3001,z:3500} as any];expect(selectMiningRock(s,profile())).toBeUndefined();s.nearbyPlayers=[];s.nearbyLocs[0]!.level=1;expect(selectMiningRock(s,profile())).toBeUndefined();
 s.player!.worldX=2736;s.player!.worldZ=9684;expect(inPerfectMine(s)).toBe(true);
});
test('mining receipt distinguishes XP-producing ore, XP-free incidental gem and unexplained stock loss',()=>{
 const b=state(),a=structuredClone(b);a.inventory.push({id:profile().products[0]!,count:1,slot:1} as any);expect(miningEffect(profile(),b,a)).toBeNull();a.skills[0]!.experience+=125;expect(miningEffect(profile(),b,a)).toEqual({kind:'ore',id:profile().products[0]!});
 const gem=structuredClone(b);gem.inventory.push({id:1623,count:1,slot:1} as any);expect(miningEffect(profile(),b,gem)).toEqual({kind:'incidental',id:1623});a.inventory[0]!.count=0;expect(()=>miningEffect(profile(),b,a)).toThrow('inventory');
});
test('finite at-site worker retains side gems and counts only own ore+XP',async()=>{
 let current=state(),tick=0,dispatch=0,rolls=0;
 const d:MiningDriver={state:()=>current,tick:()=>tick,stop:()=>false,mine:async()=>{dispatch++;return true;},step:async()=>{tick++;},wait:async test=>{rolls++;current=structuredClone(current);current.inventory.push({id:rolls===1?1623:profile().products[0]!,count:1,slot:rolls} as any);if(rolls>1)current.skills[0]!.experience+=125;return test();}};
 expect(await runAtSiteMining(d,profile(),{maximum:1,cap:100,idleTicks:50})).toMatchObject({made:1,sideGems:1,attempts:1,banked:0,xp:125});expect(dispatch).toBe(1);
});
test('a depleted rock without own ore/XP does not count; stop prevents action',async()=>{
 let current=state(),tick=0,dispatch=0;
 const d:MiningDriver={state:()=>current,tick:()=>tick,stop:()=>false,mine:async()=>{dispatch++;return true;},step:async()=>{tick++;},wait:async test=>{current={...current,nearbyLocs:[]};return test();}};
 await expect(runAtSiteMining(d,profile(),{maximum:1,cap:100,idleTicks:3})).rejects.toThrow('no useful ore');expect(dispatch).toBe(1);
 await expect(runAtSiteMining({...d,stop:()=>true},profile(),{maximum:1,cap:100,idleTicks:3})).rejects.toThrow('stopped');expect(dispatch).toBe(1);
});
