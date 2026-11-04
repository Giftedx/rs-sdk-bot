import {expect,test} from 'bun:test';
import {nativeClueSteps} from './microbot-c-clues';
import {nativeGuardianClue,runGuardianClue} from './microbot-c-clue-guardian';
import {nativeTeleport} from './microbot-magic-teleport';
test('all thirty native guardian clues resolve exact instruments, NPC and casket',()=>{
 const rows=nativeClueSteps().filter(r=>r.gapType==='guardian').map(r=>nativeGuardianClue(r.id));expect(rows).toHaveLength(30);expect(new Set(rows.map(r=>r.guardian)).size).toBe(2);expect(rows.every(r=>r.tools.length===4&&r.point.level===0&&r.casket>0)).toBe(true);
});
function fixture(wrongOwner=false){
 const r=nativeGuardianClue(nativeClueSteps().find(r=>r.gapType==='guardian'&&r.nativeParams?.includes('trail_guardian,trail_hard'))!.id),tele=nativeTeleport('varrock');
 const items:any[]=[{id:r.id,count:1,slot:0},...r.tools.map((id,i)=>({id,count:1,slot:i+1})),{id:379,count:4,slot:5},...[556,558,554,563].map((id,i)=>({id,count:100,slot:i+6}))];
 const player:any={name:'Owned',lifeId:1,respawnCount:0,isDead:false,worldX:r.point.x,worldZ:r.point.z,level:r.point.level};let npcs:any[]=[],prayer=false,xp=100,digs=0,casts=0,tick=0;
 const s:any={client:{selfSlot:7,var:{108:0}},tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;cb();next();}});next();return()=>{active=false;};},sdk:{getInventory:()=>items,getEquipment:()=>[{id:1381,slot:3,count:1},{id:1540,slot:5,count:1}],getSkill:(name:string)=>({level:name==='Hitpoints'?70:name==='Prayer'?60:80}),getSkillXp:()=>xp,isPrayerActive:()=>prayer,getState:()=>({player,autoRetaliateEnabled:false,nearbyPlayers:[],nearbyNpcs:npcs}),sendUseItem:async()=>{digs++;if(digs===1)npcs=[{id:r.npc,index:50,hp:80,targetIndex:32768+(wrongOwner?8:7)}];else{items.splice(items.findIndex(i=>i.id===r.id),1);items.push({id:r.casket,count:1,slot:0});}}},bot:{activatePrayer:async()=>{prayer=true;return{success:true};},deactivatePrayer:async()=>{prayer=false;return{success:true};}}};
 const io={cast:async()=>{casts++;expect(npcs[0].targetIndex).toBe(32775);npcs=[];xp+=10;return{ok:true};},escape:async()=>{player.worldX=tele.to.x;player.worldZ=tele.to.z;player.level=tele.to.level;return{ok:true};}};
 return{s,io,r,casts:()=>casts};
}
test('guardian repeat-dig casket is final hero proof after exact owned spawn',async()=>{
 const f=fixture();expect(await runGuardianClue(f.s,f.r.id,{spell:'wind_strike',maximumCasts:2,cap:60},f.io)).toMatchObject({ok:true,owned:true,casts:1,casket:true,escaped:true,prayerRestored:true,preserved:true});expect(f.casts()).toBe(1);
});
test('foreign guardian target prevents every attack and recovers to Varrock',async()=>{
 const f=fixture(true);let polls=0;f.s.onTick=(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active&&polls++<12){cb();next();}});next();return()=>{active=false;};};
 const r=await runGuardianClue(f.s,f.r.id,{spell:'wind_strike',maximumCasts:2,cap:60},f.io);expect(r.ok).toBe(false);expect(r.detail).toContain('ownership');expect(f.casts()).toBe(0);expect(r.escaped).toBe(true);
});
