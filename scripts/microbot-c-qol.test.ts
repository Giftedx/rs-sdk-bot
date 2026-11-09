import {setEquipmentObserved} from '../packages/core/src/container-observation';
import {expect,test} from 'bun:test';
import {enableSpecial,refillCannon,holdPrayer,dropQolItems,enableQolRun,qolDropSelection} from './microbot-c-qol';
test('special helper confirms transmitted native state after explicit specbar',async()=>{
 const vars:number[]=[];vars[300]=1000;vars[301]=0;
 const s:any={client:{var:vars},tick:()=>0,sdk:{getState:()=>({player:{lifeId:1}}),getSkill:()=>({level:10}),getEquipment:()=>[{id:1215,slot:3}],sendClickComponent:async()=>{vars[301]=1;}}};
 expect(await enableSpecial(s,'combat_stabsword:specbar',250,20)).toMatchObject({ok:true,changed:true,energy:1000});
});
test('cannon refill reconciles fresh explicit load count and ammo debit',async()=>{
 const items=[{id:2,slot:0,count:50}],messages:any[]=[];
 const s:any={tick:()=>0,sdk:{getState:()=>({player:{lifeId:1},nearbyLocs:[{id:6,x:20,z:30}],gameMessages:messages}),getSkill:()=>({level:10}),getInventory:()=>items,sendUseItemOnLoc:async(slot:number,x:number,z:number,id:number)=>{expect([slot,x,z,id]).toEqual([0,20,30,6]);items[0]!.count-=30;messages.push({type:0,observationId:1,tick:0,text:'You load the cannon with 30 cannonballs.'});}}};
 expect(await refillCannon(s,20,30,20)).toMatchObject({ok:true,loaded:30});
});
test('finite prayer hold restores originally inactive prayer',async()=>{
 let active=false,tick=0;
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{let run=true;const next=()=>queueMicrotask(()=>{if(run){tick++;cb();next();}});next();return()=>{run=false;};},sdk:{getState:()=>({player:{lifeId:1}}),getSkill:()=>({level:99}),isPrayerActive:()=>active},bot:{activatePrayer:async()=>{active=true;return{success:true};},deactivatePrayer:async()=>{active=false;return{success:true};}}};
 expect(await holdPrayer(s,0,3)).toMatchObject({ok:true,activated:true,restored:true});expect(active).toBe(false);
});
test('public chat plus ammo debit cannot impersonate native cannon load message',async()=>{
 let tick=0;const items=[{id:2,slot:0,count:50}],messages:any[]=[];
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;queueMicrotask(()=>{if(active){tick++;cb();}});return()=>{active=false;};},sdk:{getState:()=>({player:{lifeId:1},nearbyLocs:[{id:6,x:20,z:30}],gameMessages:messages}),getSkill:()=>({level:10}),getInventory:()=>items,sendUseItemOnLoc:async()=>{items[0]!.count-=30;messages.push({type:2,observationId:1,tick:0,text:'You load the cannon with 30 cannonballs.'});}}};
 expect(await refillCannon(s,20,30,1)).toMatchObject({ok:false,loaded:30});
});


function nativeQolActor(mode='paid',full=true){
 let tick=0,done=false,calls=0;const callbacks=new Set<()=>void>(),client:any={executeBotAction:()=>({success:true}),var:{173:0},localPlayer:{routeLength:0}},player={lifeId:1,respawnCount:0,isDead:false,worldX:3185,worldZ:3436,level:0,runEnergy:100,combat:{targetType:'none'}},inventory:any[]=[...Array.from({length:full?26:1},(_,slot)=>({id:440,name:'Iron ore',count:1,slot,optionsWithIndex:[]})),{id:995,name:'Coins',count:37,slot:26,optionsWithIndex:[]},{id:1275,name:'Rune pickaxe',count:1,slot:27,optionsWithIndex:[]}],state:any={player,inventory,equipment:[{id:1387,slot:3,count:1}],skills:[],bank:{isOpen:false},interface:{isOpen:false},dialog:{isOpen:false}};setEquipmentObserved(client,true);
 const s:any={client,name:'unit',tick:()=>tick,onTick:(f:()=>void)=>{callbacks.add(f);return()=>callbacks.delete(f);},ended:new Promise(()=>{}),sdk:{getState:()=>state,getInventory:()=>inventory,getStateAge:()=>0,getSkill:()=>({level:99,baseLevel:99})},direct:async(a:any)=>{calls++;if(mode==='missing')return{success:false};if(a.type==='dropItem'){const at=inventory.findIndex(i=>i.slot===a.slot);inventory.splice(at,1);}else{expect(a.componentId).toBe(153);client.var[173]=1;}if(mode==='wrong-stock')inventory.find(i=>i.id===995).count--;if(mode==='owner')client.executeBotAction=()=>({success:false});if(mode==='life')player.lifeId=2;if(mode==='lost')throw Error('lost reply');return{success:true};}};
 const run=async(f:()=>Promise<any>)=>{const pending=f().then(r=>{done=true;return r;});for(let i=0;i<120&&!done;i++){tick++;for(const cb of [...callbacks])cb();for(let n=0;n<20;n++)await Promise.resolve();}return pending;};return{s,run,inventory,client,stats:()=>({tick,calls})};
}
const dropOrder={ids:[440],names:[],mode:'listed' as const,order:'reverse' as const,maximumDrops:2,cap:40};
test('full-pack standalone drop uses explicit exact selection/order and retains unrelated stock',async()=>{
 const a=nativeQolActor();const r=await a.run(()=>dropQolItems(a.s,dropOrder));expect(r).toMatchObject({ok:true,slots:2,units:2,dropped:{440:2},uncertain:false});expect(a.inventory.filter(i=>i.id===440).length).toBe(24);expect(a.inventory.find(i=>i.id===995).count).toBe(37);expect(a.inventory.some(i=>i.slot===25||i.slot===24)).toBe(false);
 const b=nativeQolActor();expect((await b.run(()=>dropQolItems(b.s,{...dropOrder,ids:[],names:['coins','Rune pickaxe'],mode:'except',maximumDrops:26}))).slots).toBe(26);expect(b.inventory.map(i=>i.id)).toEqual([995,1275]);
});
test('standalone drops require full pack, explicit native Drop, and no preexisting stop',async()=>{
 const a=nativeQolActor('paid',false);expect(await dropQolItems(a.s,dropOrder)).toMatchObject({ok:true,slots:0,skipped:'pack not full'});expect(a.stats().calls).toBe(0);
 const b=nativeQolActor();b.inventory.find(i=>i.slot===25).optionsWithIndex=[{opIndex:5,text:'Destroy'}];expect((await dropQolItems(b.s,dropOrder)).ok).toBe(false);expect(b.stats().calls).toBe(0);
 const c=nativeQolActor();expect((await dropQolItems(c.s,dropOrder,()=>true)).ok).toBe(false);expect(c.stats().calls).toBe(0);
});
test('exact lost drop reconciles once; unknown stock/life/executor outcomes park before another drop',async()=>{
 const a=nativeQolActor('lost');expect((await a.run(()=>dropQolItems(a.s,dropOrder))).ok).toBe(true);expect(a.stats().calls).toBe(2);
 for(const mode of['missing','wrong-stock','life','owner']){const b=nativeQolActor(mode),r=await b.run(()=>dropQolItems(b.s,dropOrder));expect(r.ok).toBe(false);expect(r.uncertain).toBe(true);expect(b.stats().calls).toBe(1);}
});
test('finite run applies strict public threshold and one observed native enable; skip and unknown do not retry',async()=>{
 const a=nativeQolActor('lost');expect(await a.run(()=>enableQolRun(a.s,20,8))).toMatchObject({ok:true,changed:true,enabled:true,energyBefore:100,energyAfter:100});expect(a.stats().calls).toBe(1);
 const b=nativeQolActor();expect(await enableQolRun(b.s,100,8)).toMatchObject({ok:true,changed:false,enabled:false,skipped:'energy threshold'});expect(b.stats().calls).toBe(0);
 const c=nativeQolActor('missing');expect((await c.run(()=>enableQolRun(c.s,20,8))).ok).toBe(false);expect(c.stats().calls).toBe(1);
});
test('configured names match whole names, not substrings; column order is deterministic',()=>{
 const rows=[{id:1,name:'Iron ore',slot:4,count:1},{id:2,name:'Iron arrow',slot:1,count:1},{id:3,name:'Iron ore',slot:0,count:1}];expect(qolDropSelection(rows,{...dropOrder,ids:[],names:['IRON ORE'],order:'column',maximumDrops:3}).map(i=>i.slot)).toEqual([0,4]);expect(()=>qolDropSelection(rows,{...dropOrder,ids:[],names:[]})).toThrow('explicit');
});
