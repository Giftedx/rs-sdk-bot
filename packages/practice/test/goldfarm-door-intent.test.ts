import {expect,test} from 'bun:test';
import {DOOR_BANKED,DOOR_CARRIED,DOOR_ENV,WORKER_ENV,doorCases} from '../src/goldfarm-order-proof';

test('the doorway fixture keeps bounded coin expectations and worker bounds',()=>{
 expect(DOOR_ENV).toMatchObject({...WORKER_ENV,TICKS:'0'});
 expect(JSON.parse(String(DOOR_ENV.PROGRESSION_CONSUMER))).toEqual({bank:{995:DOOR_BANKED+DOOR_CARRIED}});
 for(const k of doorCases)expect(k.preset.bank!.find(i=>i.id===995)!.count).toBe(DOOR_BANKED);
});
