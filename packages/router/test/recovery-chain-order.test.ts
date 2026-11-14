import {test,expect} from 'bun:test';
import {addTasks,chooseTask,deadRoots,dependencyMet,initialState,orderOnlyDependency,qualificationDemand,type CoordTask} from '../src/coordinator';

const qualify:CoordTask={id:'qualify-recovery',kind:'qualify',goal:'gear',capability:'session-recovery-only',dependsOn:[],priority:15,estimatedMs:1,why:'Qualify the recovery runner on the current source.'};
const recovery=(name:string,i:number,after:string[]):CoordTask=>({id:'recover-'+name.toLowerCase(),kind:'run',goal:'gear',capability:'session-recovery-only',account:name,
 dependsOn:['qualify-recovery',...after],priority:1,estimatedMs:1,why:'Recover one exact failed actor.',repairs:[{account:name,endedAt:i+1}],sessionRecovery:{account:name,endedAt:i+1},accept:{counters:{sessionChecked:1}}});

function chain(){
 const state=initialState();
 addTasks(state,[qualify,recovery('Bigchopper',0,[]),recovery('Bigpackage',1,['recover-bigchopper']),recovery('BowBeforeMe',2,['recover-bigpackage'])],1);
 const set=(id:string,status:'succeeded'|'failed'|'superseded')=>{const r=state.tasks.find(t=>t.spec.id===id)!;r.status=status;};
 return{state,set,record:(id:string)=>state.tasks.find(t=>t.spec.id===id)};
}

test('a failed recovery in a chain lets the next recovery start; the qualification must still succeed', () => {
 const c=chain();
 c.set('qualify-recovery','succeeded');c.set('recover-bigchopper','failed');
 // The failed head no longer makes the rest of the chain dead.
 expect([...deadRoots(c.state).keys()]).toEqual([]);
 expect(qualificationDemand(c.state).map(r=>r.spec.id)).toEqual(['recover-bigpackage']);
 expect(chooseTask(c.state,3,{sourceReady:true,nativeReady:true,liveLimit:5,preferLive:true})?.id).toBe('recover-bigpackage');
 // The next account in the chain still waits for Bigpackage to end.
 expect(dependencyMet(c.record('recover-bowbeforeme')!.spec,c.record('recover-bigpackage'))).toBe(false);
 // A failed qualification still stops every recovery behind it.
 const d=chain();d.set('qualify-recovery','failed');
 expect([...deadRoots(d.state).keys()].sort()).toEqual(['recover-bigchopper','recover-bigpackage','recover-bowbeforeme']);
});

test('only a recovery run after a recovery run is an order; other kinds still need success', () => {
 const c=chain();c.set('recover-bigchopper','failed');
 const run=c.record('recover-bigpackage')!.spec,dep=c.record('recover-bigchopper');
 expect(orderOnlyDependency(run,dep)).toBe(true);
 // A plain run after a failed recovery is not ordered: it waits for a success.
 expect(orderOnlyDependency({...run,sessionRecovery:undefined},dep)).toBe(false);
 // A recovery after a failed qualification or build is not ordered either.
 expect(orderOnlyDependency(run,c.record('qualify-recovery') && {...c.record('qualify-recovery')!,status:'failed'})).toBe(false);
 // A pending earlier recovery has not ended yet.
 expect(orderOnlyDependency(c.record('recover-bowbeforeme')!.spec,c.record('recover-bigpackage'))).toBe(false);
});
