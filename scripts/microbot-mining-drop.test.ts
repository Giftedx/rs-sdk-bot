import{test,expect}from'bun:test';
import{runDropMining,type MiningDropDriver}from'./microbot-mining-drop';
import{miningProfiles}from'./microbot-b-mining';
const p=miningProfiles().find(p=>p.name==='iron_rock_table')!;
function fixture(mode:'normal'|'lost'|'unknown'|'foreign'='normal'){
 let tick=0,drops=0,mines=0;let s:any={player:{worldX:3000,worldZ:3500,level:0,lifeId:1},skills:[{name:'Mining',level:99,experience:0},{name:'Hitpoints',level:99}],inventory:[{id:1275,count:1,slot:0},...Array.from({length:26},(_,i)=>({id:440,count:1,slot:i+1,optionsWithIndex:[{text:'Drop',opIndex:5}]}))],equipment:[],nearbyPlayers:[],nearbyLocs:[{id:p.rocks[0],x:3001,z:3500,level:0,distance:1,optionsWithIndex:[{text:'Mine',opIndex:1}]}]};
 const d:MiningDropDriver={state:()=>s,tick:()=>tick,stop:()=>false,drop:async slot=>{drops++;if(mode==='unknown')return false;s=structuredClone(s);s.inventory=s.inventory.filter((i:any)=>i.slot!==slot);if(mode==='foreign')s.inventory[0].count++;if(mode==='lost')throw Error('lost reply');return true;},mine:async()=>{mines++;return true;},wait:async test=>{tick++;if(mines&&drops>=26){s=structuredClone(s);s.inventory.push({id:440,count:1,slot:s.inventory.length,optionsWithIndex:[{text:'Drop',opIndex:5}]});s.skills[0].experience+=35;}return test();},step:async()=>{tick++;}};
 return{d,stats:()=>({drops,mines,s})};
}
test('drop mode preserves configured pickaxe, resumes existing miner and reconciles all discarded units',async()=>{
 const f=fixture(),r=await runDropMining(f.d,p,{maximum:2,cap:100,idleTicks:50,keep:[1275]});expect(r).toMatchObject({made:2,xp:70,dropped:{440:26},outputs:{440:2},banked:0});expect(f.stats().drops).toBe(26);expect(f.stats().mines).toBe(2);expect(f.stats().s.inventory[0].id).toBe(1275);
});
test('lost drop reply uses one exact receipt while unknown and foreign deltas never retry',async()=>{
 const lost=fixture('lost');expect((await runDropMining(lost.d,p,{maximum:1,cap:100,idleTicks:50,keep:[1275]})).made).toBe(1);
 for(const mode of ['unknown','foreign']as const){const f=fixture(mode);await expect(runDropMining(f.d,p,{maximum:1,cap:100,idleTicks:50,keep:[1275]})).rejects.toThrow('unconfirmed');expect(f.stats().drops).toBe(1);expect(f.stats().mines).toBe(0);}
});
test('retained-only pack, custom fifth action and omitted owned pickaxe stop before spending input',async()=>{
 const f=fixture();await expect(runDropMining(f.d,p,{maximum:1,cap:100,idleTicks:50,keep:[]})).rejects.toThrow('pickaxe');
 await expect(runDropMining(f.d,p,{maximum:1,cap:100,idleTicks:50,keep:[1275,440]})).rejects.toThrow('only retained');expect(f.stats().drops).toBe(0);
 f.stats().s.inventory[1].optionsWithIndex=[{text:'Destroy',opIndex:5}];await expect(runDropMining(f.d,p,{maximum:1,cap:100,idleTicks:50,keep:[1275]})).rejects.toThrow('Drop');expect(f.stats().drops).toBe(0);
});
test('ordinary native ore omits generic Drop from object-specific menu yet uses dedicated drop receipt',async()=>{const f=fixture();for(const i of f.stats().s.inventory)i.optionsWithIndex=[];expect((await runDropMining(f.d,p,{maximum:1,cap:100,idleTicks:50,keep:[1275]})).dropped[440]).toBe(26);expect(f.stats().drops).toBe(26);});
