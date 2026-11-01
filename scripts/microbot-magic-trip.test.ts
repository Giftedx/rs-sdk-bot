import {test,expect} from 'bun:test';
import {magicBankProfile,returnMagicTrip,validateMagicBankJob,type MagicBankJob} from './microbot-magic-trip';
const job=():MagicBankJob=>({family:'magic-npc',recipe:'wind_strike',npc:1,target:2,batch:1,cap:600,returnTicks:100,members:true,bank:{x:3185,z:3436,level:0},site:{x:3200,z:3436,level:0}});
test('magic refills add shared rune costs and keep the alchemy target distinct',()=>{
 const s:any={sdk:{getEquipment:()=>[{id:1381,slot:3}],getSkill:()=>({level:99})}};
 const p=magicBankProfile(s,{...job(),comboAlch:'low-alch',alchemyTarget:'bronze_dagger',comboTeleport:'varrock'});
 expect(p.inputs).toEqual({558:1,554:4,561:1,563:1,1205:1});expect(p.outputs).toEqual([995]);expect(p.bank).toEqual(job().bank!);expect(p.site).toEqual(job().site!);
});
test('bank magic refuses missing target/site, unknown spells and unsafe teleport-combo batches',()=>{
 for(const j of [{...job(),npc:-1},{...job(),site:undefined},{...job(),recipe:'vengeance'},{...job(),comboTeleport:'varrock',batch:2},{...job(),family:'magic-teleport',recipe:'camelot',members:false}])expect(()=>validateMagicBankJob(j as MagicBankJob)).toThrow();
});
test('bank profile invokes real finite NPC worker and disables retaliation before paid casts',async()=>{
 let tick=0,xp=0,retaliate=true;const calls:string[]=[],stock:Record<number,number>={556:2,558:2},listeners=new Set<()=>void>();
 const inventory=()=>Object.entries(stock).filter(([,n])=>n>0).map(([id,count],slot)=>({id:Number(id),count,slot}));
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),client:{selfSlot:1,var:Array(109).fill(0)},onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f)},sdk:{getEquipment:()=>[],getInventory:inventory,getSkill:()=>({level:99}),getSkillXp:(name:string)=>name==='Magic'?xp:0,getState:()=>({player:{lifeId:1,level:0,worldX:3200,worldZ:3436},autoRetaliateEnabled:retaliate,nearbyNpcs:[{id:1,index:4,hp:10,inCombat:false,reachable:true,distance:1,optionsWithIndex:[{text:'Attack',opIndex:2}]}]})},bot:{dismissBlockingUI:async()=>{}},direct:async(a:any)=>{calls.push(a.type);if(a.type==='clickComponent'){expect(a.componentId).toBe(151);retaliate=false;}else{expect(retaliate).toBe(false);stock[556]!--;stock[558]!--;xp+=6;}return{success:true};}};
 const p=magicBankProfile(s,job()),timer=setInterval(()=>{tick++;for(const f of listeners)f();},1);try{expect(await p.run(2,100,()=>false)).toBe(2);expect(calls).toEqual(['clickComponent','spellOnNpc','spellOnNpc']);expect(stock).toEqual({556:0,558:0});}finally{clearInterval(timer);}
});

test('remote teleports reserve an observed return spell per one-cast bank trip',()=>{
 const s:any={sdk:{getEquipment:()=>[],getSkill:()=>({level:99})}},j={...job(),family:'magic-teleport' as const,recipe:'trollheim',returnTeleport:'varrock'};
 expect(magicBankProfile(s,j).inputs).toEqual({554:3,556:3,563:3});expect(()=>validateMagicBankJob({...j,batch:2})).toThrow('one-cast');
});

test('special spell bank staging requires the actual native worn staff before withdrawing runes',()=>{
 const s:any={sdk:{getEquipment:()=>[],getSkill:()=>({level:99})}};expect(()=>magicBankProfile(s,{...job(),recipe:'iban_blast'})).toThrow('required staff');s.sdk.getEquipment=()=>[{id:1409,slot:3}];expect(magicBankProfile(s,{...job(),recipe:'iban_blast'}).inputs).toEqual({554:5,560:1});
});
test('protection and retaliation are observed before the bank runner approaches an undead target',async()=>{
 let ret=true,prayer=false;const actions:string[]=[],s:any={sdk:{getEquipment:()=>[],getSkill:()=>({level:99}),getState:()=>({autoRetaliateEnabled:ret,prayers:{prayerLevel:99,prayerPoints:99}}),isPrayerActive:()=>prayer,sendTogglePrayer:async(i:number)=>{expect(i).toBe(14);actions.push('protect');prayer=true;return{success:true};}},direct:async(a:any)=>{expect(a.componentId).toBe(151);actions.push('retaliation-off');ret=false;}};
 const p=magicBankProfile(s,{...job(),recipe:'crumble_undead',npc:92,protectPrayer:14});await p.prepare!(()=>false);expect(actions).toEqual(['retaliation-off','protect']);expect(ret).toBe(false);expect(prayer).toBe(true);
});

test('stopped NPC batch pays only its declared return and retains the original failure',async()=>{
 let tick=0,xp=0,stopped=false,teleports=0;let player={lifeId:1,level:0,worldX:3197,worldZ:3353};const stock:Record<number,number>={556:4,558:1,554:1,563:1},listeners=new Set<()=>void>();
 const inv=()=>Object.entries(stock).filter(([,count])=>count>0).map(([id,count],slot)=>({id:Number(id),count,slot}));
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),client:{selfSlot:1,var:Array(109).fill(0)},onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f)},sdk:{getEquipment:()=>[],getInventory:inv,getSkill:()=>({level:99}),getSkillXp:(name:string)=>name==='Magic'?xp:0,getState:()=>({player,autoRetaliateEnabled:false,nearbyNpcs:[]}),sendCloseModal:async()=>({success:true})},bot:{dismissBlockingUI:async()=>{stopped=true;}},direct:async(a:any)=>{expect(a.type).toBe('clickComponent');teleports++;stock[556]!-=3;stock[554]!--;stock[563]!--;xp+=35;player={...player,worldX:3213,worldZ:3424};return{success:true};}};
 const p=magicBankProfile(s,{...job(),returnTeleport:'varrock'}),timer=setInterval(()=>{tick++;for(const f of listeners)f();},1);try{await expect(p.run(1,100,()=>stopped)).rejects.toThrow('stopped/cap');expect(teleports).toBe(1);expect(stopped).toBe(true);expect(stock).toEqual({556:1,558:1,554:0,563:0});}finally{clearInterval(timer);}
});
test('configured return cannot bypass native high-Wilderness teleport restrictions',async()=>{
 let dispatches=0;const s:any={tick:()=>0,sdk:{getState:()=>({player:{lifeId:1,level:0,worldX:3000,worldZ:3800}}),getSkill:()=>({level:99})},direct:async()=>{dispatches++;}};
 await expect(returnMagicTrip(s,{name:'varrock',component:'magic:varrock_teleport',level:25,members:false,runes:{554:1,556:3,563:1},to:{x:3213,z:3424,level:0}},true,40)).rejects.toThrow('legal Wilderness exit');expect(dispatches).toBe(0);
});
