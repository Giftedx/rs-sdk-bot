import {test,expect} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {intakeRequests} from '../src/coordinator-cli';
import {addTasks,initialState} from '../src/coordinator';
import {capabilityDefinitionTransition,loadState,publishCapabilityChanges,saveState} from '../src/coordinator-store';
import type {DeliveryTask} from '../src/delivery';

const definition:DeliveryTask={id:'cook-order',goal:'Complete a quest',entry:'scripts/cook.ts',files:['scripts/cook.ts'],consumer:'Quest flag, XP and logout',
 checks:(['regression','practice','consumer'] as const).map(phase=>({id:phase,phase,command:['bun','check.ts'],timeoutMs:1000}))};
const task={id:'check',kind:'qualify',goal:'quests',capability:'cook-order',dependsOn:[],priority:10,estimatedMs:1000,why:'Qualify the quest'} as const;
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'queue-intake-')),directory=join(base,'.practice/coordinator'),requests=join(directory,'requests');
 const defs=join(base,'packages/router/tasks'),cap=join(defs,'cook-order.json'),bytes=JSON.stringify(definition);
 mkdirSync(defs,{recursive:true});mkdirSync(requests,{recursive:true});writeFileSync(cap,bytes);
 const path=join(requests,'one.request.json');
 const submit=(raw:unknown)=>writeFileSync(path,JSON.stringify(raw));
 submit({reason:'Quest qualification',tasks:[task],capabilities:[]});
 return {base,directory,path,submit,cap,defs,bytes,state:initialState()};
}
const expected=(f:ReturnType<typeof fixture>)=>({
 pending:existsSync(f.path),accepted:existsSync(f.path+'.accepted'),rejected:existsSync(f.path+'.rejected'),
 tasks:loadState(f.directory).tasks.map(r=>r.spec.id),
});

test('a failed queue save leaves the request pending and the in-memory queue untouched',()=>{
 const f=fixture();
 expect(()=>intakeRequests(f.state,f.base,{save:()=>{throw Error('queue write failed');}})).toThrow('queue write failed');
 expect(expected(f)).toEqual({pending:true,accepted:false,rejected:false,tasks:[]});
 expect(f.state.tasks).toEqual([]);
 intakeRequests(f.state,f.base);
 expect(expected(f)).toEqual({pending:false,accepted:true,rejected:false,tasks:['check']});
});

test('a restart retries an acknowledgement for a persisted request without applying it twice',()=>{
 const f=fixture();
 expect(()=>intakeRequests(f.state,f.base,{move:()=>{throw Error('rename failed');}})).toThrow('rename failed');
 expect(expected(f)).toEqual({pending:true,accepted:false,rejected:false,tasks:['check']});
 const recovered=loadState(f.directory),sequence=recovered.sequence;
 intakeRequests(recovered,f.base);
 expect(expected(f)).toEqual({pending:false,accepted:true,rejected:false,tasks:['check']});
 expect(recovered.sequence).toBe(sequence);
 // A restart after the final rename can clear the durable marker even before another state save.
 const acknowledged=loadState(f.directory);
 intakeRequests(acknowledged,f.base,{move:()=>{throw Error('acknowledgement already exists');}});
 expect(acknowledged.sequence).toBe(sequence);
 expect(acknowledged.pendingSubmission).toBeUndefined();
});

test('a rejected request leaves the durable queue unchanged',()=>{
 const f=fixture();
 f.submit({reason:'Bad dependency',tasks:[{...task,dependsOn:['missing']}],capabilities:[]});
 intakeRequests(f.state,f.base);
 expect(expected(f)).toEqual({pending:false,accepted:false,rejected:true,tasks:[]});
 expect(f.state.tasks).toEqual([]);
});

function promotion(f:ReturnType<typeof fixture>,capabilities:DeliveryTask[]=[]){
 const expectedSource=createHash('sha256').update(f.bytes).digest('hex');
 const changed={...definition,consumer:'Reconciled quest'};
 f.submit({reason:'Promote capability',capabilities,capabilityUpdates:[{expectedSource,definition:changed}],
  tasks:[{...task,id:'build',kind:'build'},{...task,id:'live',kind:'run',dependsOn:['build'],account:'Helper',accept:{quests:["Cook's Assistant"]}}]});
 return {expectedSource,changed};
}

test('capability promotion waits until the queue and its recovery data are saved',()=>{
 const f=fixture();promotion(f);
 expect(()=>intakeRequests(f.state,f.base,{save:()=>{throw Error('queue write failed');}})).toThrow('queue write failed');
 expect(readFileSync(f.cap,'utf8')).toBe(f.bytes);
 expect(expected(f)).toEqual({pending:true,accepted:false,rejected:false,tasks:[]});
});

test('a restart finishes a partially published definition batch and retains the original promotion base',()=>{
 const f=fixture(),added={...definition,id:'another-order'},addedPath=join(f.defs,added.id+'.json');
 addTasks(f.state,[{...task,id:'old-live',kind:'run',dependsOn:[],account:'Helper',accept:{quests:["Cook's Assistant"]}}]);
 const {expectedSource,changed}=promotion(f,[added]);
 expect(()=>intakeRequests(f.state,f.base,{publish:(base,changes)=>{
  publishCapabilityChanges(base,changes.slice(0,1));
  throw Error('stopped after first definition');
 }})).toThrow('stopped after first definition');
 expect(JSON.parse(readFileSync(addedPath,'utf8'))).toEqual(added);
 expect(readFileSync(f.cap,'utf8')).toBe(f.bytes);
 expect(expected(f)).toEqual({pending:true,accepted:false,rejected:false,tasks:['old-live','build','live']});
 const recovered=loadState(f.directory),sequence=recovered.sequence;
 intakeRequests(recovered,f.base);
 expect(expected(f)).toEqual({pending:false,accepted:true,rejected:false,tasks:['old-live','build','live']});
 expect(recovered.sequence).toBe(sequence);
 expect(recovered.tasks[0]!.spec.dependsOn).toEqual(['build']);
 const promoted=readFileSync(f.cap);
 expect(JSON.parse(promoted.toString())).toEqual(changed);
 const transition=capabilityDefinitionTransition(f.directory,definition.id,promoted);
 expect(transition?.priorHash).toBe(expectedSource);
 expect(transition?.prior?.toString()).toBe(f.bytes);
 saveState(recovered,f.directory);
 expect(loadState(f.directory).pendingSubmission).toBeUndefined();
});

test('recovery holds a changed request or definition instead of accepting different bytes',()=>{
 const f=fixture();promotion(f);
 const submitted=readFileSync(f.path);
 expect(()=>intakeRequests(f.state,f.base,{publish:()=>{throw Error('publication failed');}})).toThrow('publication failed');
 const recovered=loadState(f.directory);
 writeFileSync(f.path,'{}');
 expect(()=>intakeRequests(recovered,f.base)).toThrow('pending submission bytes changed');
 writeFileSync(f.path,submitted);
 writeFileSync(f.cap,'{}');
 expect(()=>intakeRequests(recovered,f.base)).toThrow('capability definition changed during proposal');
 expect(readFileSync(f.cap,'utf8')).toBe('{}');
 expect(expected(f)).toEqual({pending:true,accepted:false,rejected:false,tasks:['build','live']});
 writeFileSync(f.cap,f.bytes);
 intakeRequests(recovered,f.base);
 expect(expected(f)).toEqual({pending:false,accepted:true,rejected:false,tasks:['build','live']});
});
