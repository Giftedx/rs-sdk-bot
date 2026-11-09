import {expect,test} from 'bun:test';
import {stallRecipes,stallEffect,stealStall,stallWatched,withStallSightBlocker} from './microbot-c-stalls';
import {watchProductionLife} from './microbot-c-lifetime';
import {monitoredPlayer} from './microbot-c-player-monitor';
test('all thirteen native stall rows resolve location and loot IDs',()=>{
 const rows=stallRecipes();expect(rows).toHaveLength(13);expect(new Set(rows.map(r=>r.loc)).size).toBe(13);
 expect(rows.find(r=>r.name==='stealing_silk_stall')).toMatchObject({level:20,respawn:16});
 expect(rows.filter(r=>r.questGate)).toHaveLength(2);
});
test('stall progress requires one declared loot item and XP',()=>{
 const r=stallRecipes().find(r=>r.name==='stealing_silk_stall')!,before=[{id:r.loot[0]!,count:2}];
 expect(stallEffect(r,before,[{id:r.loot[0]!,count:3}],20,44)).toBe(true);
 expect(stallEffect(r,before,[{id:r.loot[0]!,count:3}],20,20)).toBe(false);
 expect(stallEffect(r,before,[{id:995,count:3}],20,44)).toBe(false);
});
test('stall approach waits for the exact native owner and guard sight rules',()=>{
 const tea=stallRecipes().find(r=>r.name==='stealing_tea_stall')!;
 expect(tea.owners).toContain(595);
 const player={worldX:3268,worldZ:3410,level:0};
 expect(stallWatched(tea,player,[{id:595,x:3271,z:3411,inCombat:false}],()=>true)).toBe(true);
 expect(stallWatched(tea,player,[{id:595,x:3271,z:3411,inCombat:false}],()=>false)).toBe(false);
 expect(stallWatched(tea,player,[{id:595,x:3274,z:3411,inCombat:false}],()=>true)).toBe(false);
 expect(stallWatched(tea,player,[{id:1,x:3269,z:3410,inCombat:false}],()=>true)).toBe(false);
});
test('native stall projectile clipping is scoped to its sight query and restores walk flags on error',()=>{
 let mask=256;const grid={isFlagged:(_x:number,_z:number,_l:number,bits:number)=>(mask&bits)!==0,__set:(_x:number,_z:number,_l:number,bits:number)=>{mask=bits;}};
 expect(withStallSightBlocker(grid,{x:1,z:2,level:0,width:1,length:1},()=>mask)).toBe(256|131072);
 expect(mask).toBe(256);expect(()=>withStallSightBlocker(grid,{x:1,z:2,level:0,width:1,length:1},()=>{throw Error('query');})).toThrow('query');expect(mask).toBe(256);
});
test('finite silk worker retains declared loot and unrelated inventory',async()=>{
 const r=stallRecipes().find(r=>r.name==='stealing_silk_stall')!,items=[{id:r.loot[0]!,count:2},{id:995,count:9}];let xp=1;
 const s:any={tick:()=>0,sdk:{getInventory:()=>items,getSkill:()=>({level:99}),getSkillXp:()=>xp,getState:()=>({player:{lifeId:1},nearbyLocs:[{id:r.loc,x:1,z:2}]}),sendInteractLoc:async(_x:number,_z:number,id:number,op:number)=>{expect([id,op]).toEqual([r.loc,2]);items[0]!.count++;xp+=24;return{success:true};}}};
 expect(await stealStall(s,r.name,1,40)).toMatchObject({ok:true,made:1,preserved:true});expect(items[1]!.count).toBe(9);
});
test('life guard snapshots mutable respawn identity and latches death',()=>{
 const state:any={player:{lifeId:7,respawnCount:1}},s:any={sdk:{getState:()=>state,getSkill:()=>({level:10})}};
 const life=watchProductionLife(s);state.player.respawnCount=2;expect(life.reason()).toBe('life changed');state.player.respawnCount=1;expect(life.stopped()).toBe(true);
});
test('production life stops on damage, requested stop and ended session',async()=>{
 let hp=10,stop=false,end!:()=>void;const s:any={ended:new Promise<void>(r=>{end=r;}),sdk:{getState:()=>({player:{lifeId:1}}),getSkill:()=>({level:hp})}};
 const a=watchProductionLife(s);hp=9;expect(a.reason()).toBe('damage observed');hp=10;
 const b=watchProductionLife(s,()=>stop);stop=true;expect(b.reason()).toBe('stop requested');stop=false;
 const c=watchProductionLife(s);end();await Promise.resolve();expect(c.reason()).toBe('session ended');
});
test('player monitor filters baseline, radius and explicitly ignored owners',()=>{
 const players=[{name:'Owned',index:1,distance:2},{name:'Old',index:2,distance:3},{name:'New',index:3,distance:4}],p={radius:5,ignore:['owned'],onlyNew:true,action:'stop' as const};
 expect(monitoredPlayer(players,p,new Set(['old']))?.name).toBe('New');expect(monitoredPlayer(players,{...p,radius:1},new Set())).toBeUndefined();
});
