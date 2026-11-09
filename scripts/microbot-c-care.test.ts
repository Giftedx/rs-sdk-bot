import {expect,test} from 'bun:test';
import {kittenCare,weedMiscellania,druidPouchFillDelta,fillDruidPouch} from './microbot-c-care';
test('native kitten feed selects explicit pet and confirms fresh message plus fish debit',async()=>{
 const items=[{id:317,slot:0,count:2}],messages:any[]=[];
 const s:any={tick:()=>0,sdk:{getInventory:()=>items,getSkill:()=>({level:10}),getState:()=>({player:{lifeId:1},nearbyNpcs:[{index:9,name:'Kitten'}],gameMessages:messages}),sendUseItemOnNpc:async(slot:number,npc:number)=>{expect([slot,npc]).toEqual([0,9]);items[0]!.count--;messages.push({type:0,observationId:1,tick:0,text:'The kitten gobbles up the raw shrimps.'});}}};
 expect(await kittenCare(s,9,'feed',20)).toMatchObject({ok:true,input:317});
});
import{setEquipmentObserved}from'../packages/core/src/container-observation';
function weedSession(effect:(f:any)=>void){
 let tick=0,calls=0;const messages:any[]=[],inventory:any[]=[{id:995,count:37,slot:0}],skills=Array.from({length:21},(_,i)=>({name:String(i),experience:100})),player:any={lifeId:1,respawnCount:0},client:any={var:{361:50<<18},executeBotAction:()=>({success:true})};setEquipmentObserved(client,true);
 const f:any={messages,inventory,skills,player,client,get calls(){return calls;},s:{name:'weedunit',client,ended:new Promise(()=>{}),tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;cb();next();}});next();return()=>{active=false;};},sdk:{getInventory:()=>inventory,getEquipment:()=>[{id:3899,slot:3,count:1}],getSkill:(name:string)=>({level:name==='Herblore'?35:99}),getStateAge:()=>0,getState:()=>({player,skills,nearbyLocs:[{id:4678,x:2,z:3}],gameMessages:messages})},direct:async(a:any)=>{calls++;expect(a).toMatchObject({type:'interactLoc',x:2,z:3,locId:4678,optionIndex:1});effect(f);return{success:true};}}};return f;
}
function weedSuccess(f:any){f.client.var[361]+=1<<18;f.messages.push({type:0,observationId:f.messages.length+1,tick:0,text:'You manage to weed some herbs and give them to Gardener Gunnhild.'});}
test('actual Miscellania weeding accepts native fractional XP floor zero and whole-XP crossing with public approval',async()=>{
 for(const crossing of[false,true]){const f=weedSession(f=>{weedSuccess(f);if(crossing)f.skills[15].experience++;}),r=await weedMiscellania(f.s,1,40,()=>false,1);expect(r).toMatchObject({ok:true,made:1,preserved:true,herblorePublicXpDelta:crossing?1:0,approval:{before:50,after:51}});expect(f.calls).toBe(1);}
});
test('approval decoder preserves unrelated signed affection bits in the same public varp',async()=>{const f=weedSession(weedSuccess);f.client.var[361]|=0x80000000;expect((await weedMiscellania(f.s,1,40,()=>false,1)).ok).toBe(true);});
test('weeding declared native XP multiplier handles both default25 rounding phases and rejects wrong rate',async()=>{for(const delta of[2,3]){const f=weedSession(f=>{weedSuccess(f);f.skills[15].experience+=delta;});const r=await weedMiscellania(f.s,1,40);expect(r).toMatchObject({ok:true,xpMultiplier:25,herblorePublicXpDelta:delta});}const bad=weedSession(f=>{weedSuccess(f);});expect((await weedMiscellania(bad.s,1,40)).ok).toBe(false);});
test('weeding exact system success requires the exact public approval increment',async()=>{
 for(const change of[0,2]){const f=weedSession(f=>{weedSuccess(f);f.client.var[361]=(50+change)<<18;}),r=await weedMiscellania(f.s,1,40,()=>false,1);expect(r.ok).toBe(false);expect(f.calls).toBe(1);}
});
test('weeding public chat cannot supply the fresh native receipt',async()=>{
 const f=weedSession(f=>{weedSuccess(f);f.messages[0].type=2;});expect((await weedMiscellania(f.s,1,40,()=>false,1)).ok).toBe(false);expect(f.calls).toBe(1);
});
test('weeding retains whole stock and all other XP and prevents another input after life or executor replacement',async()=>{
 for(const mode of['stock','XP','life','owner']){const f=weedSession(f=>{weedSuccess(f);if(mode==='stock')f.inventory.push({id:440,count:1,slot:1});if(mode==='XP')f.skills[0].experience++;if(mode==='life')f.player.lifeId++;if(mode==='owner')f.client.executeBotAction=()=>({success:false});});expect((await weedMiscellania(f.s,2,80,()=>false,1)).ok).toBe(false);expect(f.calls).toBe(1);}
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


test('Druid pouch consumes exactly three harvests in native pear/stem/mushroom priority',()=>{
 expect(druidPouchFillDelta([{id:2957,count:1},{id:2974,count:2},{id:2972,count:2},{id:2970,count:5}])).toEqual({input:2957,charges:8,delta:{2957:-1,2958:8,2974:-2,2972:-1}});
 expect(druidPouchFillDelta([{id:2958,count:9},{id:2970,count:3}])).toEqual({input:2958,charges:3,delta:{2958:3,2970:-3}});expect(()=>druidPouchFillDelta([{id:2957,count:1},{id:2970,count:2}])).toThrow('three');
});
test('actual Druid fill requires native exact fresh credit, preserves unrelated stock, no repeated unknown action',async()=>{
 for(const wrong of[false,true]){let tick=0,done=false,calls=0;const cb=new Set<()=>void>(),inventory:any[]=[{id:2957,count:1,slot:0},{id:2974,count:2,slot:1},{id:2972,count:1,slot:2},{id:995,count:37,slot:3}],messages:any[]=[];
 const s:any={name:'unit',tick:()=>tick,onTick:(f:()=>void)=>{cb.add(f);return()=>cb.delete(f);},ended:new Promise(()=>{}),client:{ingame:true,ifType:()=>({colour:0x00f800}),executeBotAction:()=>({success:true})},sdk:{getState:()=>({player:{lifeId:1},gameMessages:messages,skills:[]}),getSkill:()=>({level:99}),getInventory:()=>inventory,getEquipment:()=>[],sendUseItem:async()=>{calls++;inventory.splice(0,3,{id:2958,count:wrong?9:8,slot:0});messages.push({type:0,text:'You add 8 natures harvests to your druid pouch.',observationId:1,tick});return{success:true};}}};
 s.direct=async(a:any)=>s.sdk.sendUseItem(a.slot,1);
 const pending=fillDruidPouch(s,1,12).then(r=>{done=true;return r;});for(let i=0;i<20&&!done;i++){tick++;for(const f of [...cb])f();for(let n=0;n<20;n++)await Promise.resolve();}const r=await pending;expect(r.ok).toBe(!wrong);expect(calls).toBe(1);expect(inventory.find(i=>i.id===995)?.count).toBe(37);}
});


test('Druid executor replacement after first paid fill prevents the second fill',async()=>{
 let calls=0;const inventory:any[]=[{id:2957,count:1,slot:0},{id:2970,count:6,slot:1}],messages:any[]=[],client:any={ingame:true,ifType:()=>({colour:0x00f800}),executeBotAction:()=>({success:true})};
 const s:any={client,name:'unit',tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player:{lifeId:1},gameMessages:messages,skills:[]}),getSkill:()=>({level:99}),getInventory:()=>inventory,getEquipment:()=>[]},direct:async()=>{calls++;inventory[0]={id:2958,count:3,slot:0};inventory[1].count-=3;messages.push({type:0,text:'You add 3 natures harvests to your druid pouch.',observationId:1,tick:0});client.executeBotAction=()=>({success:false});return{success:true};}};
 const r=await fillDruidPouch(s,2,20);expect(r.ok).toBe(false);expect(calls).toBe(1);expect(inventory[1].count).toBe(3);
});

test('weeding multiplier receipts use cumulative raw-floor bounds at phase0 and9',async()=>{for(const rate of[1,25])for(const phase of[0,9]){let raw=1000+phase;const f=weedSession(f=>{raw+=rate;f.skills[15].experience=Math.floor(raw/10);weedSuccess(f);});const r=await weedMiscellania(f.s,2,80,()=>false,rate);expect(r.ok).toBe(true);expect(r.herblorePublicXpDelta).toBe(Math.floor((phase+rate*2)/10));expect(f.calls).toBe(2);}const bad=weedSession(f=>{f.skills[15].experience+=3;weedSuccess(f);});expect((await weedMiscellania(bad.s,2,80,()=>false,25)).ok).toBe(false);expect(bad.calls).toBe(2);});
