import {test,expect} from 'bun:test';
import {pickpocketProfiles,pocketEffect,validatePocketOptions,runPickpockets,type PocketOptions} from './microbot-a-pickpocket';
const profiles=pickpocketProfiles(),options:PocketOptions={successes:1,attempts:3,cap:100,maxNoProgress:3,hpFloor:10,eatAt:15,food:0,foodReserve:0,xpRate:1,members:true};
test('all12 native target rows have exact trigger-mapped NPCs and loot ranges',()=>{
 expect(profiles.length).toBe(12);expect(profiles.every(p=>p.npcs.length>0&&p.loot.length>0&&p.level>0&&p.xp>0&&p.damage>0&&p.stunTicks>=8)).toBe(true);expect(profiles.find(p=>p.name==='hero')!.loot.length).toBe(7);expect(profiles.find(p=>p.name==='viking')!.level).toBe(45);
});
test('native multi-row loot, item-free XP success and exact failure damage are distinct',()=>{
 const p=profiles.find(p=>p.name==='watchman')!,b={items:{590:1},xp:100,hp:30},a={items:{590:1,995:60,2309:1},xp:100+p.xp,hp:30};
 expect(pocketEffect(p,b,a,'success',1)).toBe('success');expect(pocketEffect(p,b,{...a,items:{590:1}},'success',1)).toBe('success');
 expect(pocketEffect(p,b,{...b,hp:27},'failure',1)).toBe('failure');expect(pocketEffect(p,b,{...b,hp:26},'failure',1)).toBe('invalid');expect(pocketEffect(p,b,{...a,items:{995:60,2309:1}},'success',1)).toBe('invalid');expect(pocketEffect(p,b,a,'none',1)).toBe('invalid');
});
test('unsafe and unbounded pickpocket options fail before session actions',()=>{expect(()=>validatePocketOptions({...options,members:false})).toThrow();expect(()=>validatePocketOptions({...options,attempts:0})).toThrow();expect(()=>validatePocketOptions({...options,food:995})).toThrow();});
for(const initialHp of [30,12])test('native failure damage is accounted; staged HP'+initialHp+' bounds the next pocket',async()=>{
 const p=profiles.find(p=>p.name==='man')!;let tick=0,xp=0,hp=initialHp,coins=0,calls=0,lastAttempt=-100,revision=0;const messages:any[]=[];const listeners=new Set<()=>void>();
 const pack=()=>[{id:590,count:1,slot:0},{id:995,count:coins,slot:1}].filter(i=>i.count>0);
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f)},sdk:{getInventory:pack,getSkill:(name:string)=>({level:name==='Hitpoints'?hp:99}),getSkillXp:()=>xp,
  getState:()=>({player:{lifeId:1,worldX:3200,worldZ:3200,level:0,combat:{inCombat:false}},inventory:pack(),gameMessages:messages,nearbyNpcs:[{id:p.npcs[0],index:4,distance:1,inCombat:false,reachable:true,optionsWithIndex:[{text:'Pickpocket',opIndex:3}]}]}),
  sendInteractNpc:async(index:number,op:number)=>{expect(index).toBe(4);expect(op).toBe(3);calls++;if(calls===1){hp-=p.damage;messages.push({text:'You fail to pick the '+p.pocket+'.',tick,observationId:++revision});lastAttempt=tick;}else{expect(tick-lastAttempt).toBeGreaterThanOrEqual(p.stunTicks);xp+=p.xp;coins+=3;messages.push({text:'You pick the '+p.pocket+'.',tick,observationId:++revision});}return{success:true}}},bot:{dismissBlockingUI:async()=>{}}};
 const timer=setInterval(()=>{tick++;for(const f of listeners)f();},1);try{const result=await runPickpockets(s,p,options);if(initialHp===30){expect(result).toMatchObject({ok:true,successes:1,failures:1,attempts:2,hp:29,kitPreserved:true});expect(result.loot[995]).toBe(3);expect(calls).toBe(2);}else{expect(result).toMatchObject({ok:false,stop:'health/food',successes:0,failures:1,attempts:1,hp:11,kitPreserved:true});expect(calls).toBe(1);}}finally{clearInterval(timer)}
});
