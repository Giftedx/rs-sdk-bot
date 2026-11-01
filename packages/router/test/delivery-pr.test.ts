import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stageDeliveryPr,processDeliveryPrs,committable,deliveryPrDir,retryDelayMs,type Run} from '../src/delivery-pr';

const setup=()=>{
 const base=mkdtempSync(join(tmpdir(),'dpr-')),main=join(base,'main'),coord=join(base,'coord'),runDir=join(base,'run');
 for(const [f,t] of [['scripts/smelt-batch.ts','delivered'],['swarm.json','{}'],['.practice/status/x.json','{}']] as const){mkdirSync(join(main,f,'..'),{recursive:true});writeFileSync(join(main,f),t);}
 return{base,main,coord,runDir};
};
const result={delivery:{ok:true,stage:'delivered',source:'abc',runtimeRevision:'rev1',directory:'.practice/deliveries/x'},review:{deferred:true,reason:'gate passed'}};
// A stub of git and gh. `fail` names a command prefix that exits 1.
const stub=(fail?:string)=>{
 const calls:string[][]=[];
 const run:Run=async(cmd)=>{
  calls.push(cmd);const line=cmd.join(' ');
  if(fail&&line.startsWith(fail))return{code:1,stdout:'',stderr:'HTTP 502'};
  if(cmd[0]==='git'&&cmd[1]==='worktree'&&cmd[2]==='add')mkdirSync(cmd[4]!,{recursive:true});
  if(line.startsWith('git diff --cached --quiet'))return{code:1,stdout:'',stderr:''};
  if(line.startsWith('gh pr create'))return{code:0,stdout:'https://github.com/Giftedx/rs-sdk-bot/pull/99\n',stderr:''};
  return{code:0,stdout:'',stderr:''};
 };
 return{calls,run};
};

test('a delivery commits only its files to coordinator/<task id> from current master and opens a PR',async()=>{
 const {base,main,coord,runDir}=setup();
 const pr=stageDeliveryPr({mainRoot:main,runDir,coordinationDir:coord,taskId:'build-iron-owned-anvil-unlock85-repair-2',capability:'iron-progress-order',files:['scripts/smelt-batch.ts','swarm.json','.practice/status/x.json'],result,now:1000})!;
 expect(pr.files).toEqual(['scripts/smelt-batch.ts']);
 expect(pr.branch).toBe('coordinator/build-iron-owned-anvil-unlock85-repair-2');
 expect(pr.body).toContain('build-iron-owned-anvil-unlock85-repair-2');expect(pr.body).toContain('"source": "abc"');expect(pr.body).toContain('gate passed');
 writeFileSync(join(main,'scripts/smelt-batch.ts'),'a later publish');
 expect(readFileSync(join(pr.snapshot,'scripts/smelt-batch.ts'),'utf8')).toBe('delivered');
 const {calls,run}=stub(),out=await processDeliveryPrs(coord,main,run,1000,base);
 expect(out.opened.map(p=>p.url)).toEqual(['https://github.com/Giftedx/rs-sdk-bot/pull/99']);
 const lines=calls.map(c=>c.join(' '));
 expect(lines.some(l=>l.includes('worktree add --detach')&&l.endsWith('origin/master'))).toBe(true);
 expect(lines).toContain('git add -- scripts/smelt-batch.ts');
 expect(lines).toContain('git push origin HEAD:refs/heads/coordinator/build-iron-owned-anvil-unlock85-repair-2');
 expect(lines.filter(l=>l.startsWith('git push')).every(l=>!/\s(-f|--force)/.test(l)&&!l.endsWith(':refs/heads/master'))).toBe(true);
 expect(lines.some(l=>/\smerge(\s|$)/.test(l))).toBe(false);
 expect(JSON.parse(readFileSync(join(deliveryPrDir(coord),pr.taskId+'.json'),'utf8')).state).toBe('opened');
 expect((await processDeliveryPrs(coord,main,stub().run,2000,base)).opened).toEqual([]); // opened once only
});

test('a gh failure stays pending, is retried after its delay and reuses the pushed branch',async()=>{
 const {base,main,coord,runDir}=setup();
 stageDeliveryPr({mainRoot:main,runDir,coordinationDir:coord,taskId:'build-one',capability:'iron-progress-order',files:['scripts/smelt-batch.ts'],result,now:0});
 const failed=await processDeliveryPrs(coord,main,stub('gh pr create').run,0,base);
 expect(failed.failed[0]).toMatchObject({state:'pending',attempts:1,nextAt:retryDelayMs(1)});
 expect(failed.failed[0]!.lastError).toContain('HTTP 502');
 expect((await processDeliveryPrs(coord,main,stub().run,retryDelayMs(1)-1,base)).opened).toEqual([]);
 // The branch reached the remote on the first attempt: the retry opens the PR without a new commit or push.
 const retry=stub(),remote:Run=async(cmd,cwd)=>cmd[1]==='ls-remote'?{code:0,stdout:'abc\trefs/heads/coordinator/build-one\n',stderr:''}:retry.run(cmd,cwd);
 const out=await processDeliveryPrs(coord,main,remote,retryDelayMs(1),base);
 expect(out.opened[0]).toMatchObject({state:'opened',attempts:2});
 expect(retry.calls.some(c=>c[1]==='push'||c[1]==='commit')).toBe(false);
});

test('swarm.json and .practice never reach a delivery commit',()=>{
 expect(['swarm.json','.practice/coordinator/state.json','../x.ts','scripts/x.ts'].filter(committable)).toEqual(['scripts/x.ts']);
 const {main,coord,runDir}=setup();
 expect(stageDeliveryPr({mainRoot:main,runDir,coordinationDir:coord,taskId:'build-two',capability:'c',files:['swarm.json'],result})).toBeNull();
 expect(existsSync(join(deliveryPrDir(coord),'build-two.json'))).toBe(false);
});
