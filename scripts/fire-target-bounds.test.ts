import {test,expect} from 'bun:test';
import {selectFireTarget} from './gather-fire-combat';
import type {NearbyNpc} from '../vendor/rs-sdk/sdk/types';
const npc=(p:Partial<NearbyNpc>={})=>({id:110,index:8,x:2566,z:9888,tileX:2565,tileZ:9887,size:2,distance:2,inCombat:false,reachable:true,hp:null,maxHp:null,targetIndex:-1,...p}) as NearbyNpc;
test('render centre inside cannot admit an outside route tile',()=>{
 for(const p of [{tileX:2559,x:2560},{tileZ:9881,z:9883},{tileX:2583,x:2582},{tileZ:9900,z:9899}])expect(selectFireTarget([npc(p)],1)).toBeUndefined();
});
test('valid route tile stays eligible when render centre is offset beyond rectangle',()=>{
 expect(selectFireTarget([npc({tileX:2582,x:2583})],1)?.index).toBe(8);
 expect(selectFireTarget([npc({tileZ:9899,z:9900})],1)?.index).toBe(8);
});
test('first room tile north of the closed door is valid for the giant route',()=>{
 expect(selectFireTarget([npc({tileX:2564,tileZ:9882,x:2565,z:9883})],1)?.index).toBe(8);
});
test('unknown route coordinates do not borrow rendered coordinates',()=>{
 expect(selectFireTarget([npc({tileX:undefined})],1)).toBeUndefined();
 expect(selectFireTarget([npc({tileZ:undefined})],1)).toBeUndefined();
});
