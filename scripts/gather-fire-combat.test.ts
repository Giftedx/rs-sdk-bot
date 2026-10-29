import {test,expect} from 'bun:test';
import {selectFireWeapon,fireMaxHit,fireFightSafe,fireDeathCredit,fireStartRoute} from './gather-fire-combat';
import {sealFireRoom,selectFireTarget} from './gather-fire-combat';
import type {NearbyNpc} from '../vendor/rs-sdk/sdk/types';
import type {Session} from '../packages/core/src/inprocess';

test('a disconnected Fire room start uses the guarded exit before bank preparation',()=>{
 expect(fireStartRoute({worldX:2564,worldZ:9883,level:0})).toBe('dungeon');
 expect(fireStartRoute({worldX:2575,worldZ:9862,level:0})).toBe('dungeon');
 expect(fireStartRoute({worldX:2619,worldZ:3332,level:0})).toBe('bank');
 expect(fireStartRoute({worldX:2511,worldZ:3463,level:0})).toBe('surface');
 expect(()=>fireStartRoute({worldX:3200,worldZ:9883,level:0})).toThrow('known Waterfall');
 expect(()=>fireStartRoute({worldX:2564,worldZ:9883,level:1})).toThrow('known Waterfall');
});
test('actual Fire110 maximum is11; mandatory retreat bounds are strict',()=>{expect(fireMaxHit).toBe(11);expect(fireFightSafe(31,8,249)).toBe(true);expect(fireFightSafe(30,8,249)).toBe(false);expect(fireFightSafe(71,7,1)).toBe(false);expect(fireFightSafe(71,16,250)).toBe(false);});
test('no partial XP, disappearance-only or unrelated excess bones counts as full Fire kill',()=>{expect(fireDeathCredit(11100,true,1)).toBe(true);expect(fireDeathCredit(11000,true,1)).toBe(false);expect(fireDeathCredit(11100,false,1)).toBe(false);expect(fireDeathCredit(11100,true,0)).toBe(false);expect(fireDeathCredit(11100,true,2)).toBe(false);});
test('Fire room closes the observed open door and requires the real closed door update',async()=>{
 const state={player:{worldX:2564,worldZ:9883,level:0},nearbyLocs:[{id:1517,x:2563,z:9882,optionsWithIndex:[{text:'Close',opIndex:1}]}],nearbyNpcs:[]};
 const calls:unknown[]=[];
 const s={sdk:{getState:()=>state,sendInteractLoc:async(...args:unknown[])=>{calls.push(args);state.nearbyLocs=[{id:1516,x:2564,z:9881,optionsWithIndex:[{text:'Open',opIndex:1}]}];return{success:true};}}} as unknown as Session;
 await sealFireRoom(s,()=>false);expect(calls).toEqual([[2563,9882,1517,1]]);
});
test('Fire room rejects a spider at the entry instead of waiting for impossible giant credit',async()=>{
 const state={player:{worldX:2564,worldZ:9883,level:0},nearbyLocs:[{id:1516,x:2564,z:9881}],nearbyNpcs:[{id:58,tileX:2564,tileZ:9883}]};
 const s={sdk:{getState:()=>state}} as unknown as Session;
 await expect(sealFireRoom(s,()=>false)).rejects.toThrow('spider at Fire entry');
 state.nearbyNpcs=[{id:58,tileX:2568,tileZ:9884}];
 await sealFireRoom(s,()=>false);
 state.nearbyNpcs=[{id:58,tileX:2564,tileZ:9881}];
 await sealFireRoom(s,()=>false); // South of the observed closed room door.
});
test('Fire target is the giant attacking this client, ahead of an idle giant; another player is excluded',()=>{
 const idle={id:110,index:1,x:2566,z:9888,tileX:2565,tileZ:9887,size:2,distance:1,inCombat:false,reachable:true,hp:null,maxHp:null,targetIndex:-1} as NearbyNpc;
 const other={...idle,index:2,inCombat:true,targetIndex:32770};
 const own={...idle,index:3,inCombat:true,targetIndex:32769,distance:2};
 expect(selectFireTarget([idle,other,own],1)?.index).toBe(3);
 expect(selectFireTarget([other],1)).toBeUndefined();
 expect(selectFireTarget([idle],1)?.index).toBe(1);
 expect(selectFireTarget([idle],-1)).toBeUndefined();
 expect(selectFireTarget([{...own,hp:40,maxHp:111}],1)).toBeUndefined();
 const spider={id:58,tileX:2564,tileZ:9888} as NearbyNpc;
 expect(selectFireTarget([idle,spider],1)).toBeUndefined();
 expect(selectFireTarget([idle,{...spider,tileX:2568,tileZ:9884}],1)?.index).toBe(1);
 const atDoor={...idle,z:9883,tileZ:9882};
 expect(selectFireTarget([atDoor,{...spider,tileX:2564,tileZ:9881}],1)?.index).toBe(1);
});

test('actual south-bank checkpoint reaches observed bank preparation without held recovery food',()=>{
 expect(fireStartRoute({worldX:2655,worldZ:3283,level:0})).toBe('bank');
 expect(fireStartRoute({worldX:2655,worldZ:3289,level:0})).toBe('surface');
 expect(()=>fireStartRoute({worldX:2655,worldZ:3283,level:1})).toThrow('known Waterfall');
});
test('owned scimitar is selected ahead of the Bronze fallback and existing sword choices',()=>{
 expect(selectFireWeapon(new Map([[1277,1],[1287,1],[1331,1]]))).toBe(1331);
});

test('Fire weapon readiness requires actual Attack and unreserved owned quantity',()=>{
 const stock=new Map([[1277,1],[1287,1],[1331,1]]);
 expect(selectFireWeapon(stock,1)).toBe(1277);
 expect(selectFireWeapon(stock,null)).toBe(0);
 expect(selectFireWeapon(stock,30,new Map([[1331,1]]))).toBe(1287);
});
test('a noted scimitar cannot be equipped and unknown weapons do not qualify',()=>{
 expect(selectFireWeapon(new Map([[1332,2],[1277,1]]))).toBe(1277);
 expect(selectFireWeapon(new Map([[1333,1],[1331,0]]))).toBe(0);
 expect(selectFireWeapon(new Map())).toBe(0);
});
test('prior sword ordering still applies when no normal scimitar is owned',()=>{
 expect(selectFireWeapon(new Map([[1287,1],[1301,1],[1277,1]]))).toBe(1287);
 expect(selectFireWeapon(new Map([[1301,1],[1277,1]]))).toBe(1301);
});
