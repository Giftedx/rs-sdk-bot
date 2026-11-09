import {test,expect} from 'bun:test';
import {nativeTeleport,teleportReceipt,runTeleportMagic,magicStopRequested} from './microbot-magic-teleport';
test('seven pinned teleport recipes resolve coordinates, levels and member requirement',()=>{for(const name of ['varrock','lumbridge','falador','camelot','ardougne','watchtower','trollheim'])expect(nativeTeleport(name).to.x).toBeGreaterThan(0);expect(nativeTeleport('watchtower').to.level).toBe(2);expect(nativeTeleport('camelot').members).toBe(true);expect(()=>nativeTeleport('kourend')).toThrow();});
test('teleport confirms all rune debits, XP and radius-two destination',()=>{const t=nativeTeleport('varrock'),b={...t.runes},a={};const p={worldX:t.to.x+2,worldZ:t.to.z,level:0};expect(teleportReceipt(t,t.runes,b,a,0,35,p)).toBe(true);expect(teleportReceipt(t,t.runes,b,a,0,35,{...p,worldX:t.to.x+3})).toBe(false);expect(teleportReceipt(t,t.runes,b,b,0,35,p)).toBe(false);expect(teleportReceipt(t,t.runes,b,a,0,0,p)).toBe(false);});
test('member teleport scopes are explicit and invalid batches reject before session reads',async()=>{await expect(runTeleportMagic({} as any,nativeTeleport('camelot'),{casts:1,cap:100})).rejects.toThrow('member');await expect(runTeleportMagic({} as any,nativeTeleport('varrock'),{casts:Infinity,cap:100})).rejects.toThrow('invalid');});

test('teleport staged runner observes rune debit and actual destination before success',async()=>{
 const t=nativeTeleport('varrock');let tick=0,xp=0,stock={...t.runes},position={worldX:3200,worldZ:3200,lifeId:1,level:0};const listeners=new Set<()=>void>();
 const inventory=()=>Object.entries(stock).filter(([,n])=>n>0).map(([id,count],slot)=>({id:Number(id),count,slot}));
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f)},sdk:{getState:()=>({player:position,inventory:inventory()}),getInventory:inventory,getEquipment:()=>[],getSkillXp:()=>xp,getSkill:()=>({level:99})},bot:{dismissBlockingUI:async()=>{}},direct:async()=>{stock={};xp=35;position={...position,worldX:t.to.x,worldZ:t.to.z};return{success:true}}};
 const timer=setInterval(()=>{tick++;for(const f of listeners)f();},1);try{const r=await runTeleportMagic(s,t,{casts:1,cap:100});expect(r.ok).toBe(true);expect(r.casts).toBe(1);}finally{clearInterval(timer)}
});

test('shared CLI global stop prevents paid teleport dispatch',async()=>{
 let actions=0;const s:any={tick:()=>0,ended:new Promise(()=>{}),sdk:{getInventory:()=>[],getEquipment:()=>[],getSkill:()=>({level:99}),getSkillXp:()=>0,getState:()=>({player:{lifeId:1,level:0,worldX:3185,worldZ:3436}})},direct:async()=>{actions++;return{success:true};}},stop=()=>magicStopRequested('owned',false,path=>path==='.practice/stop-all','');
 const r=await runTeleportMagic(s,nativeTeleport('varrock'),{casts:1,cap:50,stop});expect(r.ok).toBe(false);expect(r.casts).toBe(0);expect(actions).toBe(0);
});
