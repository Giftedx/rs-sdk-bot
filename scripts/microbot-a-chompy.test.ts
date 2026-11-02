import {test,expect} from 'bun:test';
import {chompyHuntingTile,bellowsCharges,ownChompyNotches,runChompy} from './microbot-a-chompy';
test('native post-quest ogre zone excludes Rantz quest turf',()=>{
 expect(chompyHuntingTile({worldX:2600,worldZ:2970,level:0})).toBe(true);expect(chompyHuntingTile({worldX:2635,worldZ:2965,level:0})).toBe(false);expect(chompyHuntingTile({worldX:2600,worldZ:2970,level:1})).toBe(false);expect(chompyHuntingTile({worldX:2700,worldZ:2970,level:0})).toBe(false);
});
test('bellows charges and only fresh exact own-kill messages count',()=>{
 expect(bellowsCharges([{id:2871,count:1},{id:2872,count:2},{id:2873,count:1},{id:2874,count:1}])).toBe(9);
 const text='You scratch a notch on your bow for the chompy bird kill.';
 expect(ownChompyNotches([{text,tick:1,observationId:3},{text,tick:2,observationId:5},{text:'Other '+text,tick:3,observationId:6}],3)).toBe(1);
});
test('hunting rejects invalid unbounded request before session access',async()=>{await expect(runChompy({} as any,{kills:6,cap:2000,maxBaits:6})).rejects.toThrow('invalid');await expect(runChompy({} as any,{kills:2,cap:2000,maxBaits:1})).rejects.toThrow('invalid');});

test('inflation waits for native approach plus delayed inventory publication',async()=>{
 let tick=0,used=false,placed=false;const listeners=new Set<()=>void>(),inventory:any[]=[{id:2872,count:1,slot:0}],player={worldX:2596,worldZ:2962,level:0,lifeId:1,isDead:false};
 const s:any={client:{},ended:new Promise(()=>{}),tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},bot:{dismissBlockingUI:async()=>{}},sdk:{getState:()=>({player,gameMessages:[]}),getInventory:()=>inventory,getEquipment:()=>[{id:2883,slot:3},{id:2866,slot:13,count:32}],getSkill:()=>({level:99}),getSkillXp:()=>0,getNearbyNpcs:()=>[{id:1013,index:1,x:2596,z:2963,distance:1,reachable:true}],sendUseItemOnNpc:async()=>{used=true;return{success:true};}},direct:async()=>{placed=true;return{success:false};}};
 s.client.ingame=true;s.client.ifType=()=>({colour:0x00f800});
 const result=runChompy(s,{kills:1,cap:100,maxBaits:1});
 for(let n=0;n<40&&!placed;n++){tick++;if(used&&tick===20)inventory.splice(0,1,{id:2873,count:1,slot:0},{id:2875,count:1,slot:1});for(const cb of [...listeners])cb();for(let k=0;k<12;k++)await Promise.resolve();}
 const r=await result;expect(used).toBe(true);expect(placed).toBe(true);expect(r.failure).toContain('own bait placement missing');expect(r.failure).not.toContain('inflation');
});

test('own kill notch may publish before its corpse scene update',async()=>{
 let tick=0,deathAt=Infinity,plucked=false,done=false;const listeners=new Set<()=>void>(),inventory:any[]=[{id:2875,count:1,slot:0}],messages:any[]=[],player={worldX:2596,worldZ:2962,level:0,lifeId:1,isDead:false};let npcs:any[]=[];
 const bird={id:1015,index:7,x:2596,z:2963,distance:1};
 const s:any={client:{ingame:true,ifType:()=>({colour:0x00f800})},ended:new Promise(()=>{}),tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},bot:{dismissBlockingUI:async()=>{}},sdk:{getState:()=>({player,gameMessages:messages}),getInventory:()=>inventory,getEquipment:()=>[{id:2883,slot:3},{id:2866,slot:13,count:32}],getSkill:()=>({level:99}),getSkillXp:()=>0,getNearbyNpcs:()=>npcs,sendInteractNpc:async(_index:number,option:number)=>{if(option===5){messages.push({text:'You scratch a notch on your bow for the chompy bird kill.',observationId:tick+1});npcs=[];deathAt=tick+2;return{success:true};}plucked=true;return{success:false};}},direct:async()=>{inventory.splice(0);npcs=[{id:1014,index:6,x:2596,z:2962,distance:0},bird];return{success:true};}};
 const pending=runChompy(s,{kills:1,cap:100,maxBaits:1}).then(r=>{done=true;return r;});
 for(let n=0;n<40&&!done;n++){tick++;if(tick===deathAt)npcs=[{...bird,id:1016,index:8}];for(const cb of [...listeners])cb();for(let k=0;k<12;k++)await Promise.resolve();}
 const r=await pending;expect(plucked).toBe(true);expect(r.failure).toContain('pluck effect missing');expect(r.failure).not.toContain('corpse');
});

test('trip bait staging separates foreign protected combat before placing owned toad',async()=>{
 let tick=0,done=false,staged=false,placed=false;const listeners=new Set<()=>void>(),inventory:any[]=[{id:2875,count:1,slot:0}],player={worldX:2601,worldZ:2961,level:0,lifeId:1,isDead:false,combat:{inCombat:true}};
 const s:any={client:{ingame:true,ifType:()=>({colour:0x00f800})},ended:new Promise(()=>{}),tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},bot:{dismissBlockingUI:async()=>{}},sdk:{getState:()=>({player,gameMessages:[]}),getInventory:()=>inventory,getEquipment:()=>[{id:2883,slot:3},{id:2866,slot:13,count:32}],getSkill:()=>({level:99}),getSkillXp:()=>0,getNearbyNpcs:()=>[]},direct:async()=>{expect(staged).toBe(true);expect(player.combat.inCombat).toBe(false);expect(player.worldX).toBe(2588);placed=true;return{success:false};}};
 const result=runChompy(s,{kills:1,cap:100,maxBaits:1,stageBait:async stop=>{expect(inventory[0].id).toBe(2875);expect(stop()).toBe(false);player.worldX=2588;player.worldZ=2966;player.combat.inCombat=false;staged=true;}}).then(r=>{done=true;return r;});
 for(let n=0;n<40&&!done;n++){tick++;for(const cb of [...listeners])cb();for(let k=0;k<12;k++)await Promise.resolve();}
 const r=await result;expect(placed).toBe(true);expect(r.failure).toContain('own bait placement missing');
});

async function corpseBindingFixture(mode:'owned'|'wrong-tile'|'ambiguous'){
 let tick=0,deathAt=Infinity,plucked=false,done=false;const listeners=new Set<()=>void>(),inventory:any[]=[{id:2875,count:1,slot:0}],messages:any[]=[],player={worldX:2587,worldZ:2966,level:0,lifeId:1,isDead:false};let npcs:any[]=[];
 const bird={id:1015,index:7,x:2588,z:2966,distance:1,hp:10};
 const s:any={client:{ingame:true,ifType:()=>({colour:0x00f800})},ended:new Promise(()=>{}),tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},bot:{dismissBlockingUI:async()=>{}},sdk:{getState:()=>({player,gameMessages:messages}),getInventory:()=>inventory,getEquipment:()=>[{id:2883,slot:3},{id:2866,slot:13,count:32}],getSkill:()=>({level:99}),getSkillXp:()=>0,getNearbyNpcs:()=>npcs,sendInteractNpc:async(_index:number,option:number)=>{if(option===5){bird.x=2577;bird.z=2965;bird.distance=10;bird.hp=0;messages.push({text:'You scratch a notch on your bow for the chompy bird kill.',observationId:tick+1});deathAt=tick+3;return{success:true};}plucked=true;return{success:false};}},direct:async()=>{inventory.splice(0);npcs=[{id:1014,index:6,x:2587,z:2966,distance:0},bird];return{success:true};}};
 const pending=runChompy(s,{kills:1,cap:100,maxBaits:1}).then(r=>{done=true;return r;});
 for(let n=0;n<40&&!done;n++){tick++;if(tick===deathAt){npcs=[{...bird,id:1016,index:8,x:mode==='wrong-tile'?2578:2577}];if(mode==='ambiguous')npcs.push({...npcs[0],index:9});}for(const cb of [...listeners])cb();for(let k=0;k<12;k++)await Promise.resolve();}
 return{result:await pending,plucked};
}
test('fresh own notch binds delayed new corpse to final live position beyond eight tiles and rejects wrong or ambiguous corpses',async()=>{
 const owned=await corpseBindingFixture('owned');expect(owned.plucked).toBe(true);expect(owned.result.failure).toContain('pluck effect missing');
 for(const mode of ['wrong-tile','ambiguous']as const){const r=await corpseBindingFixture(mode);expect(r.plucked).toBe(false);expect(r.result.failure).toContain('corpse missing or ambiguous');}
});

async function movingToadFixture(intro:boolean){
 let tick=0,used=false,placed=false,done=false;const listeners=new Set<()=>void>(),inventory:any[]=[{id:2873,count:1,slot:0}],messages:any[]=[],calls:number[]=[],player={worldX:2587,worldZ:2966,level:0,lifeId:1,isDead:false};
 const old={id:1013,index:1,x:2595,z:2969,distance:8,reachable:true},adjacent={id:1013,index:2,x:2594,z:2968,distance:1,reachable:true};
 const effect=()=>inventory.splice(0,1,{id:2874,count:1,slot:0},{id:2875,count:1,slot:1});
 const s:any={client:{ingame:true,ifType:()=>({colour:0x00f800})},ended:new Promise(()=>{}),tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},bot:{dismissBlockingUI:async()=>{}},sdk:{getState:()=>({player,gameMessages:messages}),getInventory:()=>inventory,getEquipment:()=>[{id:2883,slot:3},{id:2866,slot:13,count:32}],getSkill:()=>({level:99}),getSkillXp:()=>0,getNearbyNpcs:()=>tick<5?[old]:[old,adjacent],sendUseItemOnNpc:async(slot:number,index:number)=>{expect(slot).toBe(0);calls.push(index);used=true;if(intro||index===2)messages.push({type:0,text:'You manage to catch the toad and inflate it with the swamp gas.',observationId:tick+1});if(index===2)effect();return{success:true};}},direct:async()=>{placed=true;expect(bellowsCharges(inventory)).toBe(1);expect(inventory.filter(i=>i.id===2875).reduce((n,i)=>n+i.count,0)).toBe(1);return{success:false};}};
 const pending=runChompy(s,{kills:1,cap:100,maxBaits:1}).then(r=>{done=true;return r;});
 for(let n=0;n<45&&!done;n++){tick++;if(used&&tick===4){old.x=2596;old.z=2971;old.distance=9;player.worldX=2595;player.worldZ=2969;}if(intro&&used&&tick===20)effect();for(const cb of [...listeners])cb();for(let k=0;k<12;k++)await Promise.resolve();}
 return{r:await pending,calls,placed};
}
test('moving unstarted toad approach retargets adjacent current NPC within original budget but native intro locks out redispatch',async()=>{
 const moving=await movingToadFixture(false);expect(moving.calls).toEqual([1,2]);expect(moving.placed).toBe(true);expect(moving.r.failure).toContain('bait placement');
 const begun=await movingToadFixture(true);expect(begun.calls).toEqual([1]);expect(begun.placed).toBe(true);expect(begun.r.failure).not.toContain('inflation');
});
