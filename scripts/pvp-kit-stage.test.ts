import {expect,test} from 'bun:test';
import {kitStageAccounting} from './pvp-kit-stage';
const before=[{id:995,count:8352},{id:44,count:3},{id:882,count:25}];
const after=[{id:995,count:8284},{id:44,count:3},{id:882,count:25},{id:1985,count:2}];
test('staging counts only paid cheese and fares, preserving protected stock',()=>{
 expect(kitStageAccounting(before,after,68)).toBe(true);
 expect(kitStageAccounting(before,after,8)).toBe(false);
 expect(kitStageAccounting(before,after.filter(i=>i.id!==44),68)).toBe(false);
 expect(kitStageAccounting(before,[...after,{id:557,count:1}],68)).toBe(false);
 expect(kitStageAccounting(before,after.map(i=>i.id===882?{...i,count:24}:i),68)).toBe(false);
 expect(kitStageAccounting(before,after.map(i=>i.id===995?{...i,count:8152}:i),200)).toBe(false);
});
