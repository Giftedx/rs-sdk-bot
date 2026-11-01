import {test,expect} from 'bun:test';
import {nativeNpcSpell,npcCastEffect,selectMagicTarget,runNpcMagic} from './microbot-magic-npc';
test('native standard strike/bolt/blast/wave and six debuffs resolve exact costs',()=>{
 for(const el of ['wind','water','earth','fire'])for(const tier of ['strike','bolt','blast','wave'])expect(nativeNpcSpell(el+'_'+tier).level).toBeGreaterThan(0);
 for(const name of ['confuse','weaken','curse','vulnerability','enfeeble','stun','bind','snare','entangle'])expect(nativeNpcSpell(name).debuff).toBe(true);
 expect(nativeNpcSpell('stun').runes[566]).toBe(1);expect(()=>nativeNpcSpell('ice_barrage')).toThrow();
});
test('NPC magic exact rune debit and XP receipt rejects unexplained input loss',()=>{
 const costs={555:3,557:2,566:1},b={555:6,557:4,566:2,995:99},a={555:3,557:2,566:1,995:99};
 expect(npcCastEffect(costs,b,a,0,90)).toBe('cast');expect(npcCastEffect(costs,b,b,0,0)).toBe('none');expect(npcCastEffect(costs,b,{...a,995:98},0,90)).toBe('invalid');expect(npcCastEffect(costs,b,a,0,0)).toBe('invalid');
});
test('NPC selection excludes exhausted and foreign targets, permits own combat',()=>{
 const n:any={id:1,index:3,hp:3,inCombat:false,reachable:true,distance:1,optionsWithIndex:[{text:'Attack',opIndex:2}]};expect(selectMagicTarget([n],1,new Set(),2)?.index).toBe(3);expect(selectMagicTarget([n],1,new Set([3]),2)).toBeUndefined();expect(selectMagicTarget([{...n,inCombat:true,targetIndex:32770}],1,new Set(),2)?.index).toBe(3);expect(selectMagicTarget([{...n,inCombat:true,targetIndex:32771}],1,new Set(),2)).toBeUndefined();
});
test('NPC magic rejects an unbounded request before reading session',async()=>{await expect(runNpcMagic({} as any,nativeNpcSpell('stun'),{npc:1,casts:1001,cap:20})).rejects.toThrow('invalid');});
import {itemMagicRecipe} from './microbot-magic-items';

test('NPC staged runner executes debit, XP and serial alch combo with finite completion',async()=>{
 const spell=nativeNpcSpell('confuse');let tick=0,xp=0,calls:string[]=[];
 const combo=itemMagicRecipe('high-alch','bronze_dagger'),stock:Record<number,number>={};for(const [id,n] of [...Object.entries(spell.runes),...Object.entries(combo.inputs)])stock[Number(id)]=(stock[Number(id)]??0)+n;
 const inventory=()=>Object.entries(stock).filter(([,n])=>n>0).map(([id,count],slot)=>({id:Number(id),count,slot}));
 const p={worldX:3200,worldZ:3200,lifeId:1,level:0,isDead:false};const target:any={id:1,index:2,hp:3,inCombat:false,reachable:true,distance:1,optionsWithIndex:[{text:'Attack',opIndex:2}]};const listeners=new Set<()=>void>();
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),client:{selfSlot:3,var:Array(109).fill(0)},onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f)},sdk:{getState:()=>({player:p,inventory:inventory(),equipment:[],nearbyNpcs:[target]}),getInventory:inventory,getEquipment:()=>[],getSkillXp:(name:string)=>name==='Magic'?xp:0,getSkill:()=>({level:99})},bot:{dismissBlockingUI:async()=>{}},direct:async(a:any)=>{calls.push(a.type);const costs=a.type==='spellOnNpc'?spell.runes:combo.inputs;for(const [id,n] of Object.entries(costs))stock[Number(id)]!-=n;if(a.type==='spellOnItem')stock[combo.product]=(stock[combo.product]??0)+combo.output;xp+=50;return{success:true}}};
 const timer=setInterval(()=>{tick++;for(const f of listeners)f();},1);try{const r=await runNpcMagic(s,spell,{npc:1,casts:1,cap:100,combo});expect(r.ok).toBe(true);expect(r.combos).toBe(1);expect(calls).toEqual(['spellOnNpc','spellOnItem']);}finally{clearInterval(timer)}
});
test('finite NPC magic refuses native repeating autocast or unknown mode before any action',async()=>{
 let actions=0;const vars=Array(109).fill(0);vars[108]=3;
 const s:any={client:{selfSlot:3,var:vars},sdk:{getState:()=>({player:{lifeId:1}}),getSkill:()=>({level:99})},direct:async()=>{actions++;}};
 await expect(runNpcMagic(s,nativeNpcSpell('wind_strike'),{npc:1,casts:1,cap:100})).rejects.toThrow('disable native autocast');expect(actions).toBe(0);
 delete s.client.var;await expect(runNpcMagic(s,nativeNpcSpell('wind_strike'),{npc:1,casts:1,cap:100})).rejects.toThrow('autocast mode unknown');expect(actions).toBe(0);
});
