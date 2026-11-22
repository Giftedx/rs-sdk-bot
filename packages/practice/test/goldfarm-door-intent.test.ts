import {expect,test} from 'bun:test';
import {DOOR_BANKED,DOOR_CARRIED,DOOR_ENV,WORKER_ENV,doorCases} from '../src/goldfarm-order-proof';
import {loadProgressionCatalog,intentForEntry} from '../../planner/src/progression-catalog';
import {parentProgressionAccept} from '../../core/src/progression-session';

test('the doorway gate of the goldfarm proof states a finite goal, the bank of its carried cash, so the session does not end it as unmapped',()=>{
 const c=loadProgressionCatalog(),work={script:'scripts/aio-skiller.ts',args:['gather','thieving','knights-stable'] as string[],env:{...DOOR_ENV} as Record<string,string|undefined>};
 const accept=parentProgressionAccept(work,'flgoldfarm1');
 expect(accept).toEqual({bank:{995:DOOR_BANKED+DOOR_CARRIED}});
 expect(intentForEntry(work.script,work.args,work.env,accept,c)).toMatchObject({kind:'acquire',items:{995:DOOR_BANKED+DOOR_CARRIED}});
 // Without the stated consumer a zero bound is no finite goal (the rule that stopped the gate).
 const bare:Record<string,string|undefined>={...DOOR_ENV};delete bare.PROGRESSION_CONSUMER;
 expect(intentForEntry(work.script,work.args,bare,undefined,c)).toBeNull();
 // The earning cases state their own bound.
 expect(intentForEntry(work.script,work.args,{...WORKER_ENV},undefined,c)).toMatchObject({kind:'service'});
 // The fixture banks the amount that the consumer names.
 for(const k of doorCases)expect(k.preset.bank!.find(i=>i.id===995)!.count).toBe(DOOR_BANKED);
});
