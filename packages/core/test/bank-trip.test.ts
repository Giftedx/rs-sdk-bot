import {test,expect} from 'bun:test';
import {planBankTripSchedule} from '../src/bank-trip';

test('bank schedule reserves a retained tool separately from consumed copies of the same item',()=>{
 const schedule=planBankTripSchedule({target:2,inputs:{436:1},tools:[436,436],bankStock:{436:3},reserve:1});
 expect(schedule.requiredInputs).toEqual({436:4});
 expect(schedule.shortfalls).toEqual({436:1});
 expect(schedule.feasibleUnits).toBe(1);
 expect(schedule.ready).toBe(false);
 expect(planBankTripSchedule({target:2,inputs:{436:1},tools:[436,436],bankStock:{436:4},reserve:1}).ready).toBe(true);
});

test('a missing retained tool prevents any feasible bank production even with sufficient inputs',()=>{
 const schedule=planBankTripSchedule({target:2,inputs:{436:1},tools:[2347,2347],bankStock:{436:10}});
 expect(schedule.missingTools).toEqual([2347]);
 expect(schedule.feasibleUnits).toBe(0);
 expect(schedule.feasibleTrips).toBe(0);
});
