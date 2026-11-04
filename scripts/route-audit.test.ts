import {expect,test} from 'bun:test';
import {AUDIT_PROFILES,auditOne,fixedTiles,unreachableFirst,type AuditRow} from './route-audit';
import type {World} from '../packages/core/src/world';
test('audit profiles retain their separate combat and fare budgets',()=>{
 expect(AUDIT_PROFILES.weak!.skills).toEqual({attack:1,strength:1,defence:1,hitpoints:10});expect(AUDIT_PROFILES.weak!.coins).toBe(30);
 expect(AUDIT_PROFILES.strong!.skills).toEqual({attack:70,strength:70,defence:70,hitpoints:70});expect(AUDIT_PROFILES.strong!.coins).toBe(20000);
});
test('literal discovery reads profiles, calls and documented pens without executing scripts',()=>{
 const rows=fixedTiles("throw Error('must never execute'); const PROFILES={shop:{x:3013,z:3225}}; walk(2809,3441,2); // knight spawns 2652,3318\nconst floor={x:3208,z:3220,level:2}; const moving={x:actor.x,z:actor.z};",'fixture.ts');
 expect(rows.map(({x,z,level})=>[x,z,level])).toEqual([[3013,3225,0],[2809,3441,0],[3208,3220,2],[2652,3318,0]]);
});
test('audit preserves failed routes and labels, with unreachable results first',()=>{
 const from={x:3222,z:3218,level:0},target={x:2809,z:3441,level:0,sources:['fixture']};
 const fail=auditOne({route:()=>({ok:false,reason:'no_route'})} as unknown as World,'weak','lumbridge',from,target,AUDIT_PROFILES.weak!,()=>['danger rule: White wolf']);
 expect(fail).toMatchObject({reachable:false,cost:null,cause:['danger rule: White wolf']});
 const pass=auditOne({route:()=>({ok:true,cost:7,legs:[]})} as unknown as World,'strong','bank',from,target,AUDIT_PROFILES.strong!,()=>{throw Error('no failure diagnosis on success');});
 expect(unreachableFirst([pass,fail] as AuditRow[])[0]).toBe(fail);expect(pass.cost).toBe(7);
});

test('indirect smelting corridors retain each fixed tuple and its source line',()=>{
 const rows=fixedTiles('const route = [[3272,3227],[3275,3212],[3273,3194],[3269,3167]];\nfor(const [x,z] of route) walk(x!,z!);','smelt-batch.ts');
 expect(rows.map(({x,z,level})=>[x,z,level])).toEqual([[3272,3227,0],[3275,3212,0],[3273,3194,0],[3269,3167,0]]);
 expect(rows.every(r=>r.sources[0]==='smelt-batch.ts:1')).toBe(true);
});
