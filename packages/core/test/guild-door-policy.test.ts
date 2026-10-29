import {test,expect} from 'bun:test';
import {doorBlocks,doorBlock,transportAllowed,createWorld,type Door,type Account} from '../src/world';
import {directionalMasks,withDoorPolicy,accountFromState,accountForSdk,registerRouteActor} from '../src/door-policy';
import {setEquipmentObserved} from '../src/container-observation';
const door={id:2647,loc:'crafting_guild_door',x:2933,z:3289,level:0,angle:1,shape:0,kind:'skill',need:{skill:'crafting',level:40,worn:'brown_apron',whenAxis:true},trigger:'crafting_guild.rs2:1',src:'map:1'} as Door;
test('empty worn list is unknown until this native client received its full equipment packet',()=>{
 const state={inventory:[],equipment:[],skills:[]},sdk={getState:()=>state},peer={getState:()=>state},client={},other={};
 registerRouteActor(sdk,client);registerRouteActor(peer,other);
 const rule={requires:{notOwnBanner:{team:0 as const,item:'banner'}}};
 expect(accountForSdk(sdk).worn).toBeUndefined();expect(transportAllowed(rule,accountForSdk(sdk))).toBe(false);
 setEquipmentObserved(client,true);expect(accountForSdk(sdk).worn).toEqual([]);expect(transportAllowed(rule,accountForSdk(sdk))).toBe(true);
 expect(accountForSdk(peer).worn).toBeUndefined();
 setEquipmentObserved(client,false);expect(accountForSdk(sdk).worn).toBeUndefined();
});
test('started quests and one QP cannot pass completion or 32QP guards',()=>{
 const actor:Account={skills:{},items:[],varps:{qp:1},questStages:{heroquest:1,legendsquest:1}};
 for(const [varp,minimum] of [['qp',32],['heroquest',15],['legendsquest',50]] as const){const d={...door,kind:'quest',need:{varp,minimum}};expect(doorBlocks(d,actor)).toBe(true);expect(doorBlocks(d,{...actor,varps:{qp:32},questStages:{heroquest:15,legendsquest:50}})).toBe(false);}
 expect(doorBlocks({...door,kind:'quest',need:{varp:'unparsed'}},{...actor,varps:{unparsed:99}})).toBe(true);
});
test('transport guards use actual membership, current skill and team plus worn banner',()=>{
 const a:Account={skills:{mining:59},varps:{},items:[],worn:[]};
 expect(transportAllowed({requires:{unlock:'prayer-guild'}},a)).toBe(false);
 expect(transportAllowed({requires:{unlock:'prayer-guild'}},{...a,unlocks:['prayer-guild']})).toBe(true);
 expect(transportAllowed({requires:{skill:{name:'mining',level:60}}},a)).toBe(false);
 const guarded={requires:{notOwnBanner:{team:0 as const,item:'banner'}}};
 expect(transportAllowed(guarded,a)).toBe(true);
 expect(transportAllowed(guarded,{...a,worn:['banner']})).toBe(false);
 expect(transportAllowed(guarded,{...a,worn:['banner'],castlewarsTeam:1})).toBe(true);
 expect(transportAllowed(guarded,{...a,worn:['banner'],castlewarsTeam:0})).toBe(false);
});
test('world retains guarded exact-side entries and refuses unknown membership',()=>{
 const t={locName:'ladder',option:'op1',from:{x:10,z:10,level:0},entry:{x:11,z:10,level:0},to:{x:20,z:20,level:1},exact:true,src:'map:1',toSrc:'script:2',handler:'script:1',requires:{unlock:'prayer-guild'}};
 const tolerances:number[]=[];const w=createWorld({transports:[t],doors:[],pathLength:(a,b,_d,tol)=>{tolerances.push(tol);return a.level===b.level?Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z)):null;}});
 const a:Account={skills:{},varps:{},items:[]};
 expect(w.route({x:9,z:10,level:0},t.to,a).ok).toBe(false);
 const r=w.route({x:9,z:10,level:0},t.to,{...a,unlocks:['prayer-guild']});expect(r.ok).toBe(true);if(r.ok){expect(r.legs[0]).toMatchObject({kind:'walk',to:t.entry,tolerance:0});expect(r.legs[1]).toMatchObject({entry:t.entry,requires:t.requires});}expect(tolerances).toContain(0);
});
test('carried apron does not substitute for actually worn apron',()=>{
 const actor={skills:{crafting:40},items:['brown_apron'],varps:{},worn:[]} as Account;
 expect(doorBlocks(door,actor)).toBe(true);
 expect(doorBlocks(door,{...actor,worn:['brown_apron']} as Account)).toBe(false);
 expect(doorBlocks(door,{...actor,worn:['brown_apron'],skills:{crafting:39}} as Account)).toBe(true);
});
test('native destination-wall bits block only the required entry side and restore every actor/exception',()=>{
 const values=new Map<string,number>();const k=(x:number,z:number,l:number)=>`${l},${x},${z}`;
 const grid={isFlagged:(x:number,z:number,l:number,m:number)=>!!((values.get(k(x,z,l))??0)&m),__set:(x:number,z:number,l:number,m:number)=>{values.set(k(x,z,l),m);}};
 const actor={skills:{crafting:40},items:[],varps:{},worn:[]} as Account;
 for(let angle=0;angle<4;angle++)for(const whenAxis of [false,true]){
  const d={...door,angle,need:{...door.need,whenAxis}};
  const b=doorBlock(d);const mask=directionalMasks([b])[0]!;
  values.set(k(mask.x,mask.z,mask.level),0x10000);
  withDoorPolicy(grid,doorBlocks(d,actor)?[b]:[],()=>{
   expect(grid.isFlagged(mask.x,mask.z,mask.level,mask.mask)).toBe(true);
   const opposite=directionalMasks([{...b,whenAxis:!whenAxis}])[0]!;
   expect(grid.isFlagged(opposite.x,opposite.z,opposite.level,opposite.mask)).toBe(false);
  });
  expect(values.get(k(mask.x,mask.z,mask.level))).toBe(0x10000);
  withDoorPolicy(grid,doorBlocks(d,{...actor,worn:['brown_apron']})?[b]:[],()=>expect(grid.isFlagged(mask.x,mask.z,mask.level,mask.mask)).toBe(false));
  expect(()=>withDoorPolicy(grid,[b],()=>{throw Error('query failed');})).toThrow('query failed');
  expect(values.get(k(mask.x,mask.z,mask.level))).toBe(0x10000);
  values.clear();
 }
});
test('actor adapter uses current stats and exact worn IDs; held apron and unknown gear never pass',()=>{
 const base={skills:[{name:'Crafting',level:39,baseLevel:99}],inventory:[{id:1757,name:'Brown apron',count:1}],equipment:[]};
 expect(doorBlocks(door,accountFromState(base))).toBe(true);
 expect(doorBlocks(door,accountFromState({...base,skills:[{name:'Crafting',level:40,baseLevel:39}],equipment:[{id:1757,name:'spoofed',count:1}]}))).toBe(false);
 expect(accountFromState({...base,equipment:[{id:999999,name:'Brown apron',count:1}]}).worn).toBeUndefined();
});
