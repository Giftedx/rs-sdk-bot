import {test,expect} from 'bun:test';
import {doorBlocks,doorBlock,type Door,type Account} from '../src/world';
import {observedDoorStates,directionalMasks,accountForSdk,registerRouteActor} from '../src/door-policy';
import {readFileSync} from 'node:fs';
const doors:Door[]=[
 {id:4423,loc:'castlewars_saradomin_maindoorr',x:2426,z:3088,level:0,angle:3,shape:0,kind:'team',need:{team:0,whenAxis:true},open:{id:4425,x:2426,z:3087,level:0,angle:0},trigger:'maindoor.rs2:22',src:'map:1'},
 {id:4424,loc:'castlewars_saradomin_maindoorl',x:2427,z:3088,level:0,angle:3,shape:0,kind:'team',need:{team:0,whenAxis:true},open:{id:4426,x:2427,z:3087,level:0,angle:2},trigger:'maindoor.rs2:15',src:'map:2'},
 {id:4427,loc:'castlewars_zamorak_maindoorr',x:2373,z:3119,level:0,angle:1,shape:0,kind:'team',need:{team:1,whenAxis:true},open:{id:4429,x:2373,z:3120,level:0,angle:2},trigger:'maindoor.rs2:8',src:'map:3'},
 {id:4428,loc:'castlewars_zamorak_maindoorl',x:2372,z:3119,level:0,angle:1,shape:0,kind:'team',need:{team:1,whenAxis:true},open:{id:4430,x:2372,z:3120,level:0,angle:0},trigger:'maindoor.rs2:1',src:'map:4'},
];
const actor:Account={skills:{},varps:{},items:[]};
test('all four closed main doors admit owner, deny enemy/unknown entry, and mask only the refused direction',()=>{
 for(const d of doors){expect(doorBlocks(d,{...actor,castlewarsTeam:d.need!.team})).toBe(false);expect(doorBlocks(d,{...actor,castlewarsTeam:d.need!.team===0?1:0})).toBe(true);expect(doorBlocks(d,actor)).toBe(true);
  const mask=directionalMasks([doorBlock(d)]);expect(mask).toHaveLength(1);expect(mask[0]).toMatchObject({x:d.x,z:d.z+(d.angle===1?1:-1),level:0,mask:d.angle===1?32:2});
 }
});
test('only exact currently visible open variants release the static closed masks; closure wins',()=>{
 for(const d of doors){const key=`${d.level},${d.x},${d.z}`,opened=d.open!;
  const read=(nearbyLocs:unknown[])=>observedDoorStates({inGame:true,nearbyLocs},[d]);
  expect(read([opened])).toEqual({[key]:true});expect(doorBlocks(d,{...actor,doorStates:read([opened])})).toBe(false);
  expect(read([{...opened,id:d.id}])).toEqual({});expect(read([{...opened,x:opened.x+1}])).toEqual({});expect(read([{...opened,level:1}])).toEqual({});
  expect(read([opened,d])).toEqual({[key]:false});expect(doorBlocks(d,{...actor,doorStates:read([opened,d])})).toBe(true);
  expect(read([])).toEqual({});expect(observedDoorStates({inGame:false,nearbyLocs:[opened]},[d])).toEqual({});
 }
});
test('actual generated variants flow through the current actor adapter without retaining an opening',()=>{
 const actual=JSON.parse(readFileSync(new URL('../../../knowledge/doors.json',import.meta.url),'utf8')) as Door[];
 const team=actual.filter(d=>d.kind==='team');expect(team).toHaveLength(4);
 for(const d of team){const key=`${d.level},${d.x},${d.z}`,state:any={inGame:true,skills:[],inventory:[],equipment:[],nearbyLocs:[d.open]},sdk={getState:()=>state};
  expect(accountForSdk(sdk).doorStates?.[key]).toBe(true);expect(doorBlocks(d,accountForSdk(sdk))).toBe(false);
  state.nearbyLocs=[d];expect(accountForSdk(sdk).doorStates?.[key]).toBe(false);expect(doorBlocks(d,accountForSdk(sdk))).toBe(true);
  state.nearbyLocs=[];expect(accountForSdk(sdk).doorStates).toBeUndefined();expect(doorBlocks(d,accountForSdk(sdk))).toBe(true);
 }
});
test('an ended native client cannot grant opening from its cached last in-game SDK snapshot',()=>{
 const actual=JSON.parse(readFileSync(new URL('../../../knowledge/doors.json',import.meta.url),'utf8')) as Door[],d=actual.find(x=>x.kind==='team')!,key=`${d.level},${d.x},${d.z}`;
 const state={inGame:true,skills:[],inventory:[],equipment:[],nearbyLocs:[d.open]},sdk={getState:()=>state},client={ingame:true};registerRouteActor(sdk,client);
 expect(accountForSdk(sdk).doorStates?.[key]).toBe(true);client.ingame=false;expect(accountForSdk(sdk).doorStates).toBeUndefined();
});
