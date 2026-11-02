import {magicStopRequested} from './microbot-magic-teleport';
import {test,expect} from 'bun:test';
import{readFileSync}from'node:fs';
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

test('all thirty real player spells resolve exact native component, level, membership, costs and worn item',()=>{
 const names=[...['wind','water','earth','fire'].flatMap(e=>['strike','bolt','blast','wave'].map(t=>e+'_'+t)),...['confuse','weaken','curse','vulnerability','enfeeble','stun','bind','snare','entangle','crumble_undead','saradomin_strike','claws_of_guthix','flames_of_zamorak','iban_blast']];expect(names).toHaveLength(30);
 const db=readFileSync('vendor/rs-sdk/server/content/scripts/skill_combat/configs/magic/magic_combat_spells.dbrow','utf8'),items=new Map(readFileSync('vendor/rs-sdk/server/content/pack/obj.pack','utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(.+)$/);return m?[[m[2]!,Number(m[1])]as const]:[];}));
 for(const name of names){const spell=nativeNpcSpell(name),body=db.split('[magic_spell_'+name+']')[1]!.split('\n[')[0]!,field=(key:string)=>body.match(new RegExp('^data='+key+',(.+)$','m'))?.[1]?.trim(),runes=field('runesrequired')!.split(','),expected:Record<number,number>={};for(let i=0;i<runes.length;i+=2)if(runes[i]!=='null')expected[items.get(runes[i]!)!]=Number(runes[i+1]);expect(spell.component).toBe(field('spellcom')!);expect(spell.level).toBe(Number(field('levelrequired')));expect(spell.members).toBe(field('members')==='true');expect(spell.runes).toEqual(expected);expect(spell.requiredWorn).toBe(field('wornrequired')?items.get(field('wornrequired')!):undefined);}
 expect(nativeNpcSpell('crumble_undead')).toMatchObject({level:39,members:false,runes:{562:1,556:2,557:2}});
 for(const [name,id]of [['saradomin_strike',2415],['claws_of_guthix',2416],['flames_of_zamorak',2417],['iban_blast',1409]]as const)expect(nativeNpcSpell(name).requiredWorn).toBe(id);
 for(const name of ['skeleton_mage','skeleton_mage_attack','nezikchened','saradomin_strike_npc','claws_of_guthix_npc','flames_of_zamorak_npc','ice_barrage'])expect(()=>nativeNpcSpell(name)).toThrow('unsupported');
});
test('required staves and member scope reject before any UI or paid spell action',async()=>{
 let actions=0;const s:any={sdk:{getEquipment:()=>[{slot:3,id:1381}],getState:()=>{actions++;throw Error('should not inspect player');}},bot:{dismissBlockingUI:async()=>{actions++;}},direct:async()=>{actions++;}};
 for(const name of ['saradomin_strike','claws_of_guthix','flames_of_zamorak','iban_blast']){const spell=nativeNpcSpell(name);await expect(runNpcMagic(s,spell,{npc:1,casts:1,cap:30,members:true})).rejects.toThrow('requires worn staff');await expect(runNpcMagic({}as any,spell,{npc:1,casts:1,cap:30})).rejects.toThrow('member NPC spell');}
 s.sdk.getEquipment=()=>[{slot:0,id:1409}];await expect(runNpcMagic(s,nativeNpcSpell('iban_blast'),{npc:1,casts:1,cap:30,members:true})).rejects.toThrow('requires worn staff');expect(actions).toBe(0);
});

test('shared CLI global stop prevents a paid staged NPC cast',async()=>{
 let actions=0;const s:any={tick:()=>0,ended:new Promise(()=>{}),client:{selfSlot:1,var:Array(109).fill(0)},sdk:{getInventory:()=>[],getEquipment:()=>[],getSkill:()=>({level:99}),getSkillXp:()=>0,getState:()=>({player:{lifeId:1,level:0,worldX:3197,worldZ:3353},nearbyNpcs:[]})},direct:async()=>{actions++;return{success:true};}},stop=()=>magicStopRequested('owned',false,path=>path==='.practice/stop-all','');
 const r=await runNpcMagic(s,nativeNpcSpell('wind_strike'),{npc:41,casts:1,cap:50,stop});expect(r.ok).toBe(false);expect(r.casts).toBe(0);expect(actions).toBe(0);
});

async function hpFloorFixture(floor:number|undefined,change:'hit'|'below'|'life'|'respawn'|'move'='hit'){
 let tick=0,xp=0,hp=99,actions=0,done=false;const listeners=new Set<()=>void>(),player={lifeId:1,respawnCount:0,isDead:false,level:0,worldX:3197,worldZ:3353},inventory=[{id:556,count:10},{id:558,count:10}];
 const s:any={client:{selfSlot:1,var:Array(109).fill(0)},ended:new Promise(()=>{}),tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},bot:{dismissBlockingUI:async()=>{}},sdk:{getState:()=>({player,nearbyNpcs:[{id:41,index:7,hp:10,reachable:true,inCombat:false,distance:1,optionsWithIndex:[{text:'Attack'}]}]}),getInventory:()=>inventory,getEquipment:()=>[],getSkill:(name:string)=>({level:name==='Hitpoints'?hp:99}),getSkillXp:(name:string)=>name==='Magic'?xp:0},direct:async()=>{actions++;inventory.forEach(i=>i.count--);xp+=5;if(actions===1){if(change==='hit')hp=95;if(change==='below')hp=89;if(change==='life')player.lifeId=2;if(change==='respawn')player.respawnCount=1;if(change==='move')player.worldX+=11;}return{success:true};}};
 const pending=runNpcMagic(s,nativeNpcSpell('wind_strike'),{npc:41,casts:2,cap:80,...floor===undefined?{}:{hpFloor:floor}}).then(r=>{done=true;return r;});
 for(let n=0;n<85&&!done;n++){tick++;for(const f of [...listeners])f();for(let k=0;k<12;k++)await Promise.resolve();}
 return{result:await pending,actions};
}
test('NPC magic keeps strict initial HP by default and permits only a declared bounded floor',async()=>{
 const strict=await hpFloorFixture(undefined);expect(strict.result.ok).toBe(false);expect(strict.actions).toBe(1);
 const bounded=await hpFloorFixture(90);expect(bounded.result.ok).toBe(true);expect(bounded.actions).toBe(2);
 const below=await hpFloorFixture(90,'below');expect(below.result.ok).toBe(false);expect(below.actions).toBe(1);
});
test('scalar initial life, respawn and position prevent a second paid action after mutable cached state changes',async()=>{
 for(const change of ['life','respawn','move']as const){const r=await hpFloorFixture(90,change);expect(r.result.ok).toBe(false);expect(r.actions).toBe(1);}
});
test('declared HP floor rejects unknown, fractional, too low and above initial HP before paid input',async()=>{
 for(const floor of [NaN,9,90.5,100])await expect(hpFloorFixture(floor)).rejects.toThrow('HP floor');
});
