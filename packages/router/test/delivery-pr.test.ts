import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stageDeliveryPr,processDeliveryPrs,committable,deliveryPrDir,retryDelayMs,PREREQUISITE_WAIT_MS,type Run} from '../src/delivery-pr';
import {prepareWorkspace,publishWorkspace} from '../src/build-workspace';

const lines=(...l:string[])=>l.join('\n')+'\n';
const FILE='scripts/smelt-batch.ts';
// A main checkout with one owned file, and a build of `capability` that changed its last line.
const setup=(capability='iron-progress-order')=>{
 const base=mkdtempSync(join(tmpdir(),'dpr-')),main=join(base,'repo'),coord=join(base,'coord');
 for(const [f,t] of [[FILE,lines('a','b','c')],['swarm.json','{}'],['.practice/status/x.json','{}']] as const){mkdirSync(join(main,f,'..'),{recursive:true});writeFileSync(join(main,f),t);}
 const build=(cap=capability,text=lines('a','b','C'))=>{const {root}=prepareWorkspace(main,cap,[FILE]);writeFileSync(join(root,FILE),text);return root;};
 return{base,main,coord,build};
};
const result={delivery:{ok:true,stage:'delivered',source:'abc',runtimeRevision:'rev1',directory:'.practice/deliveries/x'},review:{deferred:true,reason:'gate passed'}};
// A stub of git and gh. `master` is origin/master's content of FILE; `fail` names a command prefix that exits 1.
const stub=(opts:{master?:string;fail?:string;prState?:string}={})=>{
 const calls:string[][]=[],committed:Record<string,string>={};
 const run:Run=async(cmd,cwd)=>{
  calls.push(cmd);const line=cmd.join(' ');
  if(opts.fail&&line.startsWith(opts.fail))return{code:1,stdout:'',stderr:'HTTP 502'};
  if(cmd[0]==='git'&&cmd[1]==='worktree'&&cmd[2]==='add'){mkdirSync(join(cmd[4]!,'scripts'),{recursive:true});writeFileSync(join(cmd[4]!,FILE),opts.master??lines('a','b','c'));}
  if(line.startsWith('git add'))committed[FILE]=readFileSync(join(cwd,FILE),'utf8');
  if(line.startsWith('git diff --cached --quiet'))return{code:1,stdout:'',stderr:''};
  if(line.startsWith('gh pr view'))return{code:0,stdout:(opts.prState??'MERGED')+'\n',stderr:''};
  if(line.startsWith('gh pr create'))return{code:0,stdout:'https://github.com/Giftedx/rs-sdk-bot/pull/99\n',stderr:''};
  return{code:0,stdout:'',stderr:''};
 };
 return{calls,run,committed};
};
const stage=(s:ReturnType<typeof setup>,root:string,taskId:string,files=[FILE],now=1000)=>stageDeliveryPr({workspace:root,runDir:join(s.base,'runs',taskId),coordinationDir:s.coord,taskId,capability:'iron-progress-order',files,sourceSet:[FILE],result,now});

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

test('swarm.json and .practice never reach a delivery commit',()=>{
 expect(['swarm.json','.practice/coordinator/state.json','../x.ts','scripts/x.ts'].filter(committable)).toEqual(['scripts/x.ts']);
 const s=setup(),root=s.build();
 expect(stage(s,root,'build-two',['swarm.json'])).toBeNull();
 expect(existsSync(join(deliveryPrDir(s.coord),'build-two.json'))).toBe(false);
});
