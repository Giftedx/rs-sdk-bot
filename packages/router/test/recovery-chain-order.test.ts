import {test,expect} from 'bun:test';
import {addTasks,chooseTask,coveredQualification,deadRoots,dependencyMet,initialState,needsFreshQualification,orderOnlyDependency,qualificationDemand,recoverySlotBusy,type CoordTask} from '../src/coordinator';

test('a recovery run waits while another recovery run of any chain is running', () => {
 const state=initialState();
 addTasks(state,[qualify,recovery('Shaftmaker',0,[]),recovery('Woodenstaff',1,[]),{...qualify,id:'qualify-other',capability:'cow-progress'}],1);
 const rec=(id:string)=>state.tasks.find(t=>t.spec.id===id)!;
 expect(recoverySlotBusy(rec('recover-woodenstaff').spec,state.tasks)).toBe(false);
 rec('recover-shaftmaker').status='running';
 expect(recoverySlotBusy(rec('recover-woodenstaff').spec,state.tasks)).toBe(true);
 // The running recovery itself and tasks that are not recoveries are not held.
 expect(recoverySlotBusy(rec('recover-shaftmaker').spec,state.tasks)).toBe(false);
 expect(recoverySlotBusy(rec('qualify-other').spec,state.tasks)).toBe(false);
 rec('recover-shaftmaker').status='failed';
 expect(recoverySlotBusy(rec('recover-woodenstaff').spec,state.tasks)).toBe(false);
});

test('a run with no qualification on the current source is held; one with it is not', () => {
 const state=initialState();
 addTasks(state,[qualify,recovery('Woodpecker',0,[])],1);
 const q=state.tasks.find(t=>t.spec.id==='qualify-recovery')!,run=state.tasks.find(t=>t.spec.id==='recover-woodpecker')!.spec;
 q.status='succeeded';q.receipt={taskId:'qualify-recovery',runId:'r',ok:true,at:1,output:{delivery:{ok:true,id:'session-recovery-only',source:'old'}}} as any;
 const records=()=>new Map(state.tasks.map(r=>[r.spec.id,r]));
 expect(needsFreshQualification(run,records(),'new')).toBe(true);
 expect(needsFreshQualification(run,records(),'old')).toBe(false);
 // No fingerprint now: hold.
 expect(needsFreshQualification(run,records(),null)).toBe(true);
 // A qualification of another capability does not count.
 (q.receipt as any).output.delivery.id='other';
 expect(needsFreshQualification(run,records(),'old')).toBe(true);
 expect(needsFreshQualification(qualify,records(),'new')).toBe(false);
});

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

test('a failed qualification is covered when another of the recovery passed and none is pending', () => {
 const state=initialState();
 const q=(id:string):CoordTask=>({...qualify,id});
 addTasks(state,[q('qualify-a'),q('qualify-b'),q('qualify-c'),{...recovery('Woodpecker',0,[]),dependsOn:['qualify-a','qualify-b','qualify-c']}],1);
 const set=(id:string,status:'succeeded'|'failed'|'pending')=>{state.tasks.find(t=>t.spec.id===id)!.status=status;};
 set('qualify-a','succeeded');set('qualify-b','failed');
 // A newer qualification still pending: the run waits for it.
 expect(qualificationDemand(state).map(r=>r.spec.id)).toEqual([]);
 expect([...deadRoots(state).keys()]).toEqual([]);
 set('qualify-c','succeeded');
 expect(qualificationDemand(state).map(r=>r.spec.id)).toEqual(['recover-woodpecker']);
 expect([...deadRoots(state).keys()]).toEqual([]);
 // No qualification passed: the failure kills the run.
 set('qualify-a','failed');set('qualify-c','failed');
 expect([...deadRoots(state).keys()]).toEqual(['recover-woodpecker']);
 // A plain run gets no such cover.
 const plain={...state.tasks.find(t=>t.spec.id==='recover-woodpecker')!.spec,sessionRecovery:undefined};
 set('qualify-a','succeeded');
 expect(coveredQualification(plain,state.tasks.find(t=>t.spec.id==='qualify-b'),new Map(state.tasks.map(r=>[r.spec.id,r])))).toBe(false);
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
