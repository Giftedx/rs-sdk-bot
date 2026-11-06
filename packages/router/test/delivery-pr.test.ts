import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stageDeliveryPr,processDeliveryPrs,committable,deliveryPrDir,retryDelayMs,PREREQUISITE_WAIT_MS,deliverySourceSet,type Run} from '../src/delivery-pr';
import {resolve} from 'node:path';
import {prepareWorkspace,publishWorkspace} from '../src/build-workspace';
import {createHash} from 'node:crypto';
import {acceptProposal} from '../src/coordinator-planner';
import {initialState} from '../src/coordinator';
import {deliveryFingerprint} from '../src/delivery-cli';
import type {DeliveryTask} from '../src/delivery';

const lines=(...l:string[])=>l.join('\n')+'\n';
const FILE='scripts/smelt-batch.ts';
const DEF='packages/router/tasks/iron-progress-order.json';
// A main checkout with one owned file, and a build of `capability` that changed its last line.
const setup=(capability='iron-progress-order')=>{
 const base=mkdtempSync(join(tmpdir(),'dpr-')),main=join(base,'repo'),coord=join(base,'coord');
 for(const [f,t] of [[FILE,lines('a','b','c')],['swarm.json','{}'],['.practice/status/x.json','{}']] as const){mkdirSync(join(main,f,'..'),{recursive:true});writeFileSync(join(main,f),t);}
 const build=(cap=capability,text=lines('a','b','C'))=>{const {root}=prepareWorkspace(main,cap,[FILE]);writeFileSync(join(root,FILE),text);return root;};
 return{base,main,coord,build};
};
const result={delivery:{ok:true,stage:'delivered',source:'abc',runtimeRevision:'rev1',directory:'.practice/deliveries/x'},review:{deferred:true,reason:'gate passed'}};
// A stub of git and gh. `master` is origin/master's content of FILE; `fail` names a command prefix that exits 1.
const stub=(opts:{master?:string;definition?:string;fail?:string;prState?:string}={})=>{
 const calls:string[][]=[],committed:Record<string,string>={};
 const run:Run=async(cmd,cwd)=>{
  calls.push(cmd);const line=cmd.join(' ');
  if(opts.fail&&line.startsWith(opts.fail))return{code:1,stdout:'',stderr:'HTTP 502'};
  if(cmd[0]==='git'&&cmd[1]==='worktree'&&cmd[2]==='add'){
   mkdirSync(join(cmd[4]!,'scripts'),{recursive:true});writeFileSync(join(cmd[4]!,FILE),opts.master??lines('a','b','c'));
   if(opts.definition!==undefined){mkdirSync(join(cmd[4]!,DEF,'..'),{recursive:true});writeFileSync(join(cmd[4]!,DEF),opts.definition);}
  }
  if(line.startsWith('git add'))for(const file of cmd.slice(3))committed[file]=readFileSync(join(cwd,file),'utf8');
  if(line.startsWith('git diff --cached --quiet'))return{code:1,stdout:'',stderr:''};
  if(line.startsWith('gh pr view'))return{code:0,stdout:(opts.prState??'MERGED')+'\n',stderr:''};
  if(line.startsWith('gh pr create'))return{code:0,stdout:'https://github.com/Giftedx/rs-sdk-bot/pull/99\n',stderr:''};
  return{code:0,stdout:'',stderr:''};
 };
 return{calls,run,committed};
};
const stage=(s:ReturnType<typeof setup>,root:string,taskId:string,files=[FILE],now=1000)=>stageDeliveryPr({workspace:root,runDir:join(s.base,'runs',taskId),coordinationDir:s.coord,taskId,capability:'iron-progress-order',files,sourceSet:[FILE],result,now});

test('a qualified proposal update delivers the exact definition and refuses a different master definition',async()=>{
 const s=setup(),coord=join(s.main,'.practice/coordinator'),id='iron-progress-order';
 const prior:DeliveryTask={id,goal:'Bank iron bars',entry:FILE,files:[FILE],consumer:'Bank one bar',
  checks:(['regression','practice','consumer'] as const).map(phase=>({id:phase,phase,command:['bun',FILE],timeoutMs:1000}))};
 const before=JSON.stringify(prior),definition={...prior,consumer:'Bank two bars'};
 mkdirSync(join(s.main,DEF,'..'),{recursive:true});writeFileSync(join(s.main,DEF),before);
 mkdirSync(join(s.main,'packages/router/src'),{recursive:true});writeFileSync(join(s.main,'packages/router/src/saved-proof-verifiers.json'),'{}');
 const build={id:'build-two-bars',kind:'build',goal:'skills',capability:id,priority:5,estimatedMs:1000,why:'Qualify two bars',dependsOn:[]};
 const run={...build,id:'run-two-bars',kind:'run',account:'Helper',dependsOn:[build.id],accept:{bank:{2351:2}}};
 acceptProposal(initialState(),{reason:'Bank two bars',capabilities:[],tasks:[build,run],
  capabilityUpdates:[{expectedSource:createHash('sha256').update(before).digest('hex'),definition}]},s.main);
 const root=s.build(),qualified={...result,delivery:{...result.delivery,id,source:deliveryFingerprint(definition,root)}};
 publishWorkspace(s.main,id,[FILE]);
 const staged=stageDeliveryPr({workspace:root,runDir:join(s.base,'runs',build.id),coordinationDir:coord,taskId:build.id,
  capability:id,files:[FILE],sourceSet:[FILE],result:qualified,now:1000})!;
 expect(staged.files).toEqual([FILE,DEF]);
 expect(readFileSync(join(staged.base,DEF),'utf8')).toBe(before);
 expect(readFileSync(join(staged.snapshot,DEF),'utf8')).toBe(readFileSync(join(s.main,DEF),'utf8'));
 expect(()=>stageDeliveryPr({workspace:root,runDir:join(s.base,'runs','wrong-proof'),coordinationDir:coord,
  taskId:'wrong-proof',capability:id,files:[FILE],sourceSet:[FILE],result:{...qualified,delivery:{...qualified.delivery,source:'stale'}}}))
  .toThrow('capability definition differs from qualified delivery');

 const other=stub({definition:JSON.stringify({...prior,goal:'Keep newer master contract'})});
 const failed=await processDeliveryPrs(coord,s.main,other.run,1000,s.base);
 expect(failed.conflicts[0]?.lastError).toContain(DEF);
 expect(other.calls.some(c=>c[1]==='push'||c[1]==='commit')).toBe(false);

 writeFileSync(join(deliveryPrDir(coord),build.id+'.json'),JSON.stringify(staged));
 const git=stub({definition:before}),passed=await processDeliveryPrs(coord,s.main,git.run,1000,s.base);
 expect(passed.opened.map(p=>p.taskId)).toEqual([build.id]);
 expect(git.committed[DEF]).toBe(JSON.stringify(definition,null,2));
});

test('a new qualified definition can publish without an additional worker edit',async()=>{
 const s=setup(),coord=join(s.main,'.practice/coordinator'),id='iron-progress-order';
 const definition:DeliveryTask={id,goal:'Bank iron bars',entry:FILE,files:[FILE],consumer:'Bank one bar',
  checks:(['regression','practice','consumer'] as const).map(phase=>({id:phase,phase,command:['bun',FILE],timeoutMs:1000}))};
 mkdirSync(join(s.main,DEF,'..'),{recursive:true});
 mkdirSync(join(s.main,'packages/router/src'),{recursive:true});writeFileSync(join(s.main,'packages/router/src/saved-proof-verifiers.json'),'{}');
 acceptProposal(initialState(),{reason:'Add the iron order',capabilities:[definition],tasks:[]},s.main);
 const root=prepareWorkspace(s.main,id,[FILE]).root;
 const pr=stageDeliveryPr({workspace:root,runDir:join(s.base,'runs','build-new-iron'),coordinationDir:coord,taskId:'build-new-iron',
  capability:id,files:[],sourceSet:[FILE],result:{...result,delivery:{...result.delivery,id,source:deliveryFingerprint(definition,root)}},now:1000})!;
 expect(pr.files).toEqual([DEF]);expect(pr.definitionBase).toBeNull();
 const git=stub(),out=await processDeliveryPrs(coord,s.main,git.run,1000,s.base);
 expect(out.opened.map(p=>p.taskId)).toEqual(['build-new-iron']);
 expect(git.committed[DEF]).toBe(JSON.stringify(definition,null,2));
});

test('a delivery commits the build change to coordinator/<task id> from current master and opens a PR',async()=>{
 const s=setup(),root=s.build();publishWorkspace(s.main,'iron-progress-order',[FILE]);
 const pr=stage(s,root,'build-iron-owned-anvil-unlock85-repair-2',[FILE,'swarm.json','.practice/status/x.json'])!;
 expect(pr.files).toEqual([FILE]);expect(pr.branch).toBe('coordinator/build-iron-owned-anvil-unlock85-repair-2');
 expect(pr.body).toContain('"source": "abc"');expect(pr.body).toContain('gate passed');
 // master gained an unrelated first-line fix after the build started; the PR keeps it.
 const git=stub({master:lines('A','b','c')}),out=await processDeliveryPrs(s.coord,s.main,git.run,1000,s.base);
 expect(out.opened.map(p=>p.url)).toEqual(['https://github.com/Giftedx/rs-sdk-bot/pull/99']);
 expect(git.committed[FILE]).toBe(lines('A','b','C'));
 const calls=git.calls.map(c=>c.join(' '));
 expect(calls.some(l=>l.includes('worktree add --detach')&&l.endsWith('origin/master'))).toBe(true);
 expect(calls).toContain('git push origin HEAD:refs/heads/coordinator/build-iron-owned-anvil-unlock85-repair-2');
 expect(calls.filter(l=>l.startsWith('git push')).every(l=>!/\s(-f|--force)/.test(l)&&!l.endsWith(':refs/heads/master'))).toBe(true);
 expect(calls.some(l=>/\smerge(\s|$)/.test(l))).toBe(false);
 expect((await processDeliveryPrs(s.coord,s.main,stub().run,2000,s.base)).opened).toEqual([]); // opened once only
});

test('a master edit that overlaps the build change stops the PR as a conflict instead of reverting master',async()=>{
 const s=setup(),root=s.build();publishWorkspace(s.main,'iron-progress-order',[FILE]);stage(s,root,'build-one');
 const git=stub({master:lines('a','b','master fix')}),out=await processDeliveryPrs(s.coord,s.main,git.run,1000,s.base);
 expect(out.conflicts[0]).toMatchObject({state:'conflict'});
 expect(out.conflicts[0]!.lastError).toContain('delivery conflicts with origin/master: scripts/smelt-batch.ts (master lines 3-3, build lines 3-3)');
 expect(git.calls.some(c=>c[1]==='push'||c[1]==='commit')).toBe(false);
 expect((await processDeliveryPrs(s.coord,s.main,stub().run,retryDelayMs(10),s.base)).opened).toEqual([]); // no retry
});

test('a Windows delivery keeps unrelated master edits when the snapshots use CRLF',async()=>{
 const s=setup();
 writeFileSync(join(s.main,FILE),'a\r\nb\r\nc\r\n');
 const root=s.build('iron-progress-order','a\r\nb\r\nC\r\n');
 stage(s,root,'build-windows');
 const git=stub({master:lines('A','b','c')});
 const out=await processDeliveryPrs(s.coord,s.main,git.run,1000,s.base);
 expect(out.conflicts).toEqual([]);
 expect(out.opened.map(p=>p.taskId)).toEqual(['build-windows']);
 expect(git.committed[FILE]).toBe(lines('A','b','C'));
});

test('legacy line-ending conflicts retry through the normal merge, with complete bases only',async()=>{
 for(const scenario of ['clean','overlap','missing-base','lf-only']){
  const s=setup(),eol=scenario==='lf-only'?'\n':'\r\n';
  writeFileSync(join(s.main,FILE),['a','b','c',''].join(eol));
  const root=s.build('iron-progress-order',['a','b','C',''].join(eol));
  const pr=stage(s,root,'build-one')!;
  const lastError='delivery conflicts with origin/master: '+FILE;
  writeFileSync(join(deliveryPrDir(s.coord),'build-one.json'),JSON.stringify({...pr,state:'conflict',lastError}));
  if(scenario==='missing-base')unlinkSync(join(pr.base,FILE));
  const git=stub({master:scenario==='overlap'?lines('a','b','master edit'):lines('A','b','c')});
  const out=await processDeliveryPrs(s.coord,s.main,git.run,1000,s.base);
  if(scenario==='clean'){
   expect(out.opened.map(p=>p.taskId)).toEqual(['build-one']);
   expect(git.committed[FILE]).toBe(lines('A','b','C'));
  }else{
   expect(out.opened).toEqual([]);
   if(scenario==='overlap')expect(out.conflicts[0]?.lastError).toContain('master lines 3-3');
   else expect(git.calls).toEqual([]);
  }
  const next=stub();
  await processDeliveryPrs(s.coord,s.main,next.run,1000+PREREQUISITE_WAIT_MS,s.base);
  expect(next.calls).toEqual([]);
 }
});

test('a build that started on an earlier unmerged delivery opens its PR after that delivery merges',async()=>{
 const s=setup(),first=s.build('first',lines('a','B','c'));publishWorkspace(s.main,'first',[FILE]);stage(s,first,'build-first',[FILE],10);
 const second=s.build('second',lines('a','B','C'));publishWorkspace(s.main,'second',[FILE]);
 const pr=stage(s,second,'build-second',[FILE],Date.now()+1)!;
 expect(pr.prerequisites).toEqual(['build-first']);
 // The first delivery fails to open, so the second waits without counting a failure.
 let out=await processDeliveryPrs(s.coord,s.main,stub({fail:'gh pr create'}).run,Date.now()+2,s.base);
 expect(out.failed.map(p=>p.taskId)).toEqual(['build-first']);
 expect(out.waiting[0]).toMatchObject({taskId:'build-second',attempts:0});
 expect(out.waiting[0]!.lastError).toContain('coordinator/build-first (pending)');
 const later=Date.now()+retryDelayMs(1)+PREREQUISITE_WAIT_MS;
 out=await processDeliveryPrs(s.coord,s.main,stub({prState:'OPEN'}).run,later,s.base);
 expect(out.opened.map(p=>p.taskId)).toEqual(['build-first']);
 expect(out.waiting[0]!.lastError).toContain('to merge (OPEN)');
 // After the first merges, master holds its change and the second PR carries only its own.
 const git=stub({master:lines('a','B','c')});
 out=await processDeliveryPrs(s.coord,s.main,git.run,later+PREREQUISITE_WAIT_MS,s.base);
 expect(out.opened.map(p=>p.taskId)).toEqual(['build-second']);
 expect(git.committed[FILE]).toBe(lines('a','B','C'));
});

test('a gh failure stays pending, is retried after its delay and reuses the pushed branch',async()=>{
 const s=setup(),root=s.build();publishWorkspace(s.main,'iron-progress-order',[FILE]);stage(s,root,'build-one',[FILE],0);
 const failed=await processDeliveryPrs(s.coord,s.main,stub({fail:'gh pr create'}).run,0,s.base);
 expect(failed.failed[0]).toMatchObject({state:'pending',attempts:1,nextAt:retryDelayMs(1)});
 expect(failed.failed[0]!.lastError).toContain('HTTP 502');
 expect((await processDeliveryPrs(s.coord,s.main,stub().run,retryDelayMs(1)-1,s.base)).opened).toEqual([]);
 const retry=stub(),remote:Run=async(cmd,cwd)=>cmd[1]==='ls-remote'?{code:0,stdout:'abc\trefs/heads/coordinator/build-one\n',stderr:''}:retry.run(cmd,cwd);
 const out=await processDeliveryPrs(s.coord,s.main,remote,retryDelayMs(1),s.base);
 expect(out.opened[0]).toMatchObject({state:'opened',attempts:2});
 expect(retry.calls.some(c=>c[1]==='push'||c[1]==='commit')).toBe(false);
});

test.each(['branch','pull request'] as const)('reusing a %s requires the staged qualified definition at its exact head',async(kind)=>{
 for(const match of ['missing','changed','exact'] as const){
  const s=setup(),pr=stage(s,s.build(),'build-reuse')!;
  const definition='{"id":"iron-progress-order","consumer":"Bank two bars"}';
  mkdirSync(join(pr.snapshot,DEF,'..'),{recursive:true});writeFileSync(join(pr.snapshot,DEF),definition);
  writeFileSync(join(deliveryPrDir(s.coord),pr.taskId+'.json'),JSON.stringify({...pr,definitionBase:null,files:[...pr.files,DEF]}));
  const git=stub(),head='a'.repeat(40),url='https://github.com/Giftedx/rs-sdk-bot/pull/99';
  const run:Run=async(cmd,cwd)=>{
   if(cmd[0]==='gh'&&cmd[1]==='pr'&&cmd[2]==='list')return {code:0,stdout:kind==='pull request'?url+'\t'+head+'\n':'',stderr:''};
   if(cmd[1]==='ls-remote')return {code:0,stdout:head+'\trefs/heads/'+pr.branch+'\n',stderr:''};
   if(cmd[1]==='ls-tree'){
    expect(cmd).toContain(head);
    return {code:0,stdout:match==='missing'?'':'100644 blob '+'b'.repeat(40)+'\t'+DEF+'\n',stderr:''};
   }
   if(cmd[1]==='show'){
    expect(cmd.at(-1)).toBe(head+':'+DEF);
    return {code:0,stdout:match==='exact'?definition:'{"id":"iron-progress-order","consumer":"Other work"}',stderr:''};
   }
   return git.run(cmd,cwd);
  };
  const out=await processDeliveryPrs(s.coord,s.main,run,1000,s.base);
  if(match==='exact')expect(out.opened[0]).toMatchObject({url,state:'opened'});
  else {
   expect(out.opened).toEqual([]);
   expect(out.conflicts[0]?.lastError).toContain(DEF);
   expect(git.calls.some(c=>c[0]==='gh'&&c[2]==='create')).toBe(false);
  }
  expect(git.calls.some(c=>c[1]==='push'||c[1]==='commit')).toBe(false);
 }
});

test('swarm.json and .practice never reach a delivery commit',()=>{
 expect(['swarm.json','.practice/coordinator/state.json','../x.ts','scripts/x.ts'].filter(committable)).toEqual(['scripts/x.ts']);
 const s=setup(),root=s.build();
 expect(stage(s,root,'build-two',['swarm.json'])).toBeNull();
 expect(existsSync(join(deliveryPrDir(s.coord),'build-two.json'))).toBe(false);
});

test('a request staged without base snapshots stops as a conflict instead of copying whole files',async()=>{
 const s=setup(),root=s.build();publishWorkspace(s.main,'iron-progress-order',[FILE]);
 const pr:any=stage(s,root,'build-old',[FILE],0)!;delete pr.base;delete pr.prerequisites;
 writeFileSync(join(deliveryPrDir(s.coord),'build-old.json'),JSON.stringify(pr));
 const git=stub(),out=await processDeliveryPrs(s.coord,s.main,git.run,0,s.base);
 expect(out.conflicts[0]!.lastError).toContain('staged without base snapshots');
 expect(git.calls.some(c=>c[1]==='push'||c[1]==='commit')).toBe(false);
});

test('the source set follows a worker that the entry starts as a subprocess',()=>{
 const set=deliverySourceSet('scripts/quest-order.ts',[],resolve(import.meta.dir,'../../..'));
 expect(set).toContain('scripts/generated/quest-cook.ts');
 expect(set).toContain('scripts/quest-order.ts');
});
