import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {initialState,addTasks,startTask,qualificationDemand,chooseTask,type CoordTask} from '../src/coordinator';
import {acceptProposal} from '../src/coordinator-planner';
import {deliveryFingerprint,importClosure} from '../src/delivery-cli';
import type {DeliveryTask} from '../src/delivery';
const definition={id:'cook-order',goal:'Complete a quest',entry:'scripts/cook.ts',files:['scripts/cook.ts'],consumer:'Quest flag, XP and logout',checks:['regression','practice','consumer'].map(phase=>({id:phase,phase,command:['bun','check.ts'],timeoutMs:1000}))};
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'cap-promote-'));
 mkdirSync(join(base,'packages/router/tasks'),{recursive:true});
 mkdirSync(join(base,'packages/router/src'),{recursive:true});
 const file=join(base,'packages/router/tasks/cook-order.json'),bytes=JSON.stringify(definition);
 const policy=join(base,'packages/router/src/saved-proof-verifiers.json');
 writeFileSync(file,bytes);writeFileSync(policy,'{}');
 return{base,file,bytes,policy,hash:createHash('sha256').update(bytes).digest('hex')};
}
const build:CoordTask={id:'promote-cook',kind:'build',goal:'quests',capability:'cook-order',dependsOn:[],priority:80,estimatedMs:60000,why:'Promote existing helpers through an actual live worker entry'};
const proposal=(hash:string)=>({reason:'Complete reusable live quest',capabilities:[],tasks:[build,{id:'live-quest',kind:'run',goal:'quests',capability:'cook-order',account:'Helper',dependsOn:[build.id],priority:90,estimatedMs:10000,why:'Complete actual quest',accept:{quests:["Cook's Assistant"]}}],capabilityUpdates:[{expectedSource:hash,definition:{...definition,entry:'scripts/cook-live.ts',files:['scripts/cook.ts','scripts/cook-live.ts']}}]});

test('agents can promote an existing capability scope while retaining its original definition bytes',()=>{
 const f=fixture(),s=initialState();acceptProposal(s,proposal(f.hash),f.base);
 expect(JSON.parse(readFileSync(f.file,'utf8')).entry).toBe('scripts/cook-live.ts');
 expect(readFileSync(join(f.base,'.practice/coordinator/capability-history/cook-order-'+f.hash+'.json'),'utf8')).toBe(f.bytes);
 expect(s.tasks[0]!.spec.why).toBe(build.why);
});
test('promotion reconnects a ready old consumer before the new entry exists, allowing its builder to dispatch',()=>{
 const f=fixture(),s=initialState();addTasks(s,[{id:'old-ready',goal:'quests',kind:'run',capability:'cook-order',account:'Helper',dependsOn:[],priority:90,estimatedMs:1000,why:'Existing live consumer',accept:{quests:["Cook's Assistant"]}}]);
 expect(qualificationDemand(s)).toHaveLength(1);acceptProposal(s,proposal(f.hash),f.base);
 expect(existsSync(join(f.base,'scripts/cook-live.ts'))).toBe(false);expect(qualificationDemand(s)).toHaveLength(0);expect(chooseTask(s,Date.now())?.id).toBe(build.id);
});
test('stale updates and active ownership cannot overwrite definitions or queue work',()=>{
 const f=fixture(),s=initialState();expect(()=>acceptProposal(s,proposal('0'.repeat(64)),f.base)).toThrow('changed');expect(s.tasks).toHaveLength(0);expect(readFileSync(f.file,'utf8')).toBe(f.bytes);
 addTasks(s,[{...build,id:'owned'}]);startTask(s,'owned',1,'run');expect(()=>acceptProposal(s,proposal(f.hash),f.base)).toThrow('current owner');expect(s.tasks).toHaveLength(1);expect(readFileSync(f.file,'utf8')).toBe(f.bytes);
});
test('scope updates cannot edit harness rules or skip their own build',()=>{
 const f=fixture(),s=initialState(),p=proposal(f.hash);p.capabilityUpdates[0]!.definition.files.push('packages/router/src/coordinator.ts');expect(()=>acceptProposal(s,p,f.base)).toThrow('scope');
 const q=proposal(f.hash);q.tasks=[];expect(()=>acceptProposal(s,q,f.base)).toThrow('own build');expect(readFileSync(f.file,'utf8')).toBe(f.bytes);
});
test('changing the consumer command invalidates old qualification even when worker bytes are unchanged',()=>{
 const f=fixture();for(const dir of ['scripts','vendor/rs-sdk/sdk','vendor/rs-sdk/server/webclient/src','packages/router/src'])mkdirSync(join(f.base,dir),{recursive:true});
 for(const file of ['scripts/cook.ts','packages/router/src/delivery.ts','packages/router/src/delivery-cli.ts','package.json','bun.lock','tsconfig.json'])writeFileSync(join(f.base,file),'// unchanged fixture bytes');
 const d=structuredClone(definition) as DeliveryTask,changed=structuredClone(d);changed.checks[1]!.command.push('--changed-scenario');
 expect(deliveryFingerprint(changed,f.base)).not.toBe(deliveryFingerprint(d,f.base));
});
test('only admission changes that apply to a declared check affect its qualification',()=>{
 const f=fixture(),d=structuredClone(definition) as DeliveryTask;
 const saved=d.checks.find(c=>c.phase==='consumer')!;
 saved.command=['bun','check.ts','--verify'];
 const before=deliveryFingerprint(d,f.base);
 writeFileSync(f.policy,JSON.stringify({unrelated:['other.ts'],[saved.id]:['another.ts']}));
 expect(deliveryFingerprint(d,f.base)).toBe(before);
 writeFileSync(f.policy,JSON.stringify({[saved.id]:['check.ts']}));
 const admitted=deliveryFingerprint(d,f.base);
 expect(admitted).not.toBe(before);
 writeFileSync(f.policy,JSON.stringify({[saved.id]:['check.ts'],unrelated:['other.ts']},null,2));
 expect(deliveryFingerprint(d,f.base)).toBe(admitted);
 writeFileSync(f.policy,JSON.stringify({[saved.id]:'check.ts'}));
 expect(()=>deliveryFingerprint(d,f.base)).toThrow('invalid saved proof verifier policy');
});
test('import scans recheck missing paths and same-size source edits on every pass',()=>{
 const f=fixture(),entry='scripts/cook.ts',scan=()=>importClosure([entry],f.base);
 mkdirSync(join(f.base,'scripts'),{recursive:true});
 writeFileSync(join(f.base,entry),"import './old';");
 expect(scan()).toEqual([entry]);
 writeFileSync(join(f.base,'scripts/old.ts'),'export const old = 1;');
 expect(scan()).toEqual([entry,'scripts/old.ts']);
 writeFileSync(join(f.base,'scripts/new.ts'),'export const newer = 1;');
 writeFileSync(join(f.base,entry),"import './new';");
 expect(scan()).toEqual([entry,'scripts/new.ts']);
 unlinkSync(join(f.base,'scripts/new.ts'));
 expect(scan()).toEqual([entry]);
});
