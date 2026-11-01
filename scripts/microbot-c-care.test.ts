import {expect,test} from 'bun:test';
import {kittenCare,weedMiscellania} from './microbot-c-care';
test('native kitten feed selects explicit pet and confirms fresh message plus fish debit',async()=>{
 const items=[{id:317,slot:0,count:2}],messages:any[]=[];
 const s:any={tick:()=>0,sdk:{getInventory:()=>items,getSkill:()=>({level:10}),getState:()=>({player:{lifeId:1},nearbyNpcs:[{index:9,name:'Kitten'}],gameMessages:messages}),sendUseItemOnNpc:async(slot:number,npc:number)=>{expect([slot,npc]).toEqual([0,9]);items[0]!.count--;messages.push({type:0,observationId:1,tick:0,text:'The kitten gobbles up the raw shrimps.'});}}};
 expect(await kittenCare(s,9,'feed',20)).toMatchObject({ok:true,input:317});
});
test('Miscellania native weeding uses sickle and proves fresh weed message plus Herblore XP',async()=>{
 const messages:any[]=[];let xp=100;
 const s:any={tick:()=>0,sdk:{getInventory:()=>[],getEquipment:()=>[{id:3899,slot:3}],getSkill:()=>({level:35}),getSkillXp:()=>xp,getState:()=>({player:{lifeId:1},nearbyLocs:[{id:4678,x:2,z:3}],gameMessages:messages}),sendInteractLoc:async(x:number,z:number,id:number,op:number)=>{expect([x,z,id,op]).toEqual([2,3,4678,1]);xp++;messages.push({type:0,observationId:1,tick:0,text:'You manage to weed some herbs and give them to Gardener Gunnhild.'});}}};
 expect(await weedMiscellania(s,1,40)).toMatchObject({ok:true,made:1,preserved:true});
});
test('kitten wool attention confirms fresh dialogue and never consumes wool',async()=>{
 const items=[{id:1759,slot:0,count:1}],dialogs:any[]=[];
 const s:any={tick:()=>0,sdk:{getInventory:()=>items,getSkill:()=>({level:10}),getState:()=>({player:{lifeId:1},nearbyNpcs:[{index:9,name:'Kitten'}],recentDialogs:dialogs}),sendUseItemOnNpc:async()=>{dialogs.push({observationId:1,tick:0,text:['That kitten loves to play with that ball of wool.','I think it is its favourite.']});}}};
 expect(await kittenCare(s,9,'wool',20)).toMatchObject({ok:true,input:1759});expect(items[0]!.count).toBe(1);
});
test('public chat cannot impersonate native kitten attention receipt',async()=>{
 let tick=0;const messages:any[]=[];
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;queueMicrotask(()=>{if(active){tick++;cb();}});return()=>{active=false;};},sdk:{getInventory:()=>[{id:1759,slot:0,count:1}],getSkill:()=>({level:10}),getState:()=>({player:{lifeId:1},nearbyNpcs:[{index:9,name:'Kitten'}],gameMessages:messages}),sendUseItemOnNpc:async()=>{messages.push({type:2,observationId:1,tick:0,text:'That kitten loves to play with that ball of wool.'});}}};
 expect(await kittenCare(s,9,'wool',1)).toMatchObject({ok:false});
});
