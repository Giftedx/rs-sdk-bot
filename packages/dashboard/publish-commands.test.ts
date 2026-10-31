import {describe,expect,test,beforeEach,afterEach} from 'bun:test';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateCommand,authorizeCommand,applyCommand,readReceipts,writeReceipt,type Command} from './publish-commands';

const ID='0f2e4a6c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const NOW=1_793_425_000_000;
const cmd=(over:Partial<Command>={}):Command=>({id:ID,action:'account-pause',account:'CoinCock',at:NOW-1000,...over});
const gate=(over:Partial<Parameters<typeof authorizeCommand>[2]>={})=>({owner:'Giftedx',now:NOW,owned:['CoinCock','Moneyshot','Haggis'],applied:()=>false,...over});
const owner={via:'github-commit' as const,login:'Giftedx'};

describe('validateCommand',()=>{
 test('accepts a well-formed command and drops unknown keys',()=>{
  expect(validateCommand({id:ID,action:'account-pause',account:'CoinCock',at:NOW,extra:1})).toEqual({id:ID,action:'account-pause',account:'CoinCock',at:NOW});
  expect(validateCommand({id:ID,action:'swarm-pause',at:NOW,note:'tea'})).toEqual({id:ID,action:'swarm-pause',at:NOW,note:'tea'});
 });
 test('rejects bad ids, actions, accounts and times',()=>{
  expect(()=>validateCommand({id:'operator-1',action:'account-pause',account:'CoinCock',at:NOW})).toThrow('UUID');
  expect(()=>validateCommand({id:ID,action:'delete-everything',at:NOW})).toThrow('unknown action');
  expect(()=>validateCommand({id:ID,action:'account-pause',account:'../etc',at:NOW})).toThrow('account name');
  expect(()=>validateCommand({id:ID,action:'swarm-pause',account:'CoinCock',at:NOW})).toThrow('takes no account');
  expect(()=>validateCommand({id:ID,action:'swarm-pause',at:'now'})).toThrow('time');
  expect(()=>validateCommand(null)).toThrow('object');
 });
});

describe('authorizeCommand',()=>{
 test('the owner, fresh, unapplied, on an owned account passes',()=>{expect(authorizeCommand(cmd(),owner,gate())).toEqual({ok:true});});
 test('another GitHub login is refused, whatever the command',()=>{
  expect(authorizeCommand(cmd(),{via:'github-commit',login:'someone'},gate())).toEqual({ok:false,reason:'committer someone is not the owner'});
  expect(authorizeCommand(cmd(),{via:'github-commit',login:null},gate()).ok).toBe(false);
 });
 test('login case does not matter; the local console needs no login',()=>{
  expect(authorizeCommand(cmd(),{via:'github-commit',login:'giftedx'},gate()).ok).toBe(true);
  expect(authorizeCommand(cmd(),{via:'local',login:null},gate()).ok).toBe(true);
 });
 test('a replayed id is refused',()=>{expect(authorizeCommand(cmd(),owner,gate({applied:id=>id===ID}))).toEqual({ok:false,reason:'already applied'});});
 test('old or future commands are refused',()=>{
  expect(authorizeCommand(cmd({at:NOW-16*60_000}),owner,gate())).toEqual({ok:false,reason:'command is 16 min old'});
  expect(authorizeCommand(cmd({at:NOW+120_000}),owner,gate()).ok).toBe(false);
  expect(authorizeCommand(cmd({at:NOW-16*60_000}),owner,gate({maxAgeMs:3_600_000})).ok).toBe(true);
 });
 test('the main account and foreign accounts are refused',()=>{
  expect(authorizeCommand(cmd({account:'Haggis'}),owner,gate())).toEqual({ok:false,reason:'the main account is not controlled from the dashboard'});
  expect(authorizeCommand(cmd({account:'haggis'}),owner,gate()).ok).toBe(false);
  expect(authorizeCommand(cmd({account:'CloudBot'}),owner,gate())).toEqual({ok:false,reason:'CloudBot is not an account of this side'});
 });
});

describe('applyCommand',()=>{
 let root:string;
 beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'fleet-cmd-'));mkdirSync(join(root,'.practice','coordinator'),{recursive:true});
  writeFileSync(join(root,'swarm.json'),JSON.stringify({maxBots:17,jobs:[{account:'CoinCock',script:'scripts/goldfarm.ts',enabled:true},{account:'Haggis',script:'',enabled:false},{account:'Moneyshot',script:'scripts/banker.ts',enabled:false}]},null,2)+'\n');});
 afterEach(()=>rmSync(root,{recursive:true,force:true}));
 const stop=(n:string)=>join(root,'.practice','stop-'+n);
 const planWrite=<T,>(a:()=>T|Promise<T>)=>Promise.resolve(a());

 test('account-pause writes the stop file with the dashboard prefix, once',async()=>{
  expect(await applyCommand(cmd(),{root,now:NOW})).toEqual({status:'stop-requested',note:'the bot finishes its step and logs out'});
  expect(readFileSync(stop('CoinCock'),'utf8')).toBe('dashboard-stop:'+ID);
  expect((await applyCommand(cmd(),{root,now:NOW})).status).toBe('already-held');
 });
 test('account-resume releases only a dashboard hold',async()=>{
  expect((await applyCommand(cmd({action:'account-resume'}),{root})).status).toBe('not-held');
  writeFileSync(stop('CoinCock'),'death review 1792955012008');
  expect((await applyCommand(cmd({action:'account-resume'}),{root})).status).toBe('refused');
  expect(existsSync(stop('CoinCock'))).toBe(true);
  writeFileSync(stop('CoinCock'),'dashboard-stop:other');
  expect((await applyCommand(cmd({action:'account-resume'}),{root})).status).toBe('hold-released');
  expect(existsSync(stop('CoinCock'))).toBe(false);
 });
 test('swarm pause and resume use .practice/stop-swarm and respect a hand-set stop',async()=>{
  expect((await applyCommand(cmd({action:'swarm-pause',account:undefined}),{root,now:NOW})).status).toBe('stop-requested');
  expect(readFileSync(stop('swarm'),'utf8')).toStartWith('dashboard-stop:'+ID);
  expect((await applyCommand(cmd({action:'swarm-resume',account:undefined}),{root})).status).toBe('stop-cleared');
  writeFileSync(stop('swarm'),'owner stop by hand');
  expect((await applyCommand(cmd({action:'swarm-resume',account:undefined}),{root})).status).toBe('refused');
  expect(existsSync(stop('swarm'))).toBe(true);
 });
 test('coordinator-pause writes the pause file the coordinator honours',async()=>{
  expect((await applyCommand(cmd({action:'coordinator-pause',account:undefined}),{root,now:NOW})).status).toBe('stop-requested');
  expect(readFileSync(stop('coordinator'),'utf8')).toContain(ID);
  expect((await applyCommand(cmd({action:'coordinator-pause',account:undefined}),{root})).status).toBe('already-paused');
 });
 test('job-disable and job-enable flip only that account under the plan-write lock',async()=>{
  let locked=0;const pw=<T,>(a:()=>T|Promise<T>)=>{locked++;return Promise.resolve(a());};
  expect(await applyCommand(cmd({action:'job-disable'}),{root,planWrite:pw})).toEqual({status:'job-disabled',note:'1 job(s) in swarm.json'});
  const plan=JSON.parse(readFileSync(join(root,'swarm.json'),'utf8'));
  expect(plan.jobs.map((j:any)=>j.enabled)).toEqual([false,false,false]);
  expect(plan.maxBots).toBe(17);
  expect((await applyCommand(cmd({action:'job-disable'}),{root,planWrite:pw})).status).toBe('unchanged');
  expect((await applyCommand(cmd({action:'job-enable',account:'Moneyshot'}),{root,planWrite:pw})).status).toBe('job-enabled');
  expect((await applyCommand(cmd({action:'job-enable',account:'Nobody'}),{root,planWrite:pw})).status).toBe('no-job');
  expect(locked).toBe(4);
 });
 test('the real plan-write lock is taken and released',async()=>{
  expect((await applyCommand(cmd({action:'job-disable'}),{root})).status).toBe('job-disabled');
  expect(existsSync(join(root,'.practice','coordinator','plan-write-lock.json'))).toBe(false);
  void planWrite;
 });
 test('receipts round-trip through the shared ledger',()=>{
  writeReceipt(root,{id:ID,action:'account-pause',account:'CoinCock',at:NOW,status:'stop-requested',source:'remote'});
  writeFileSync(join(root,'.practice','dashboard-controls','junk.txt'),'x');
  expect(readReceipts(root)).toEqual([{id:ID,action:'account-pause',account:'CoinCock',at:NOW,status:'stop-requested',source:'remote'}]);
 });
});

describe('owner requests',()=>{
 test('a request command needs text, and other actions take none',()=>{
  expect(validateCommand({id:ID,action:'request',at:NOW,text:'  make the map fly  '})).toEqual({id:ID,action:'request',at:NOW,text:'make the map fly'});
  expect(()=>validateCommand({id:ID,action:'request',at:NOW})).toThrow('needs text');
  expect(()=>validateCommand({id:ID,action:'request',at:NOW,text:'x'.repeat(501)})).toThrow('needs text');
  expect(()=>validateCommand({id:ID,action:'swarm-pause',at:NOW,text:'no'})).toThrow('takes no text');
 });
 test('the request lands as the next numbered row of the ledger table, pipes made safe',async()=>{
  const root=mkdtempSync(join(tmpdir(),'fleet-req-'));mkdirSync(join(root,'research'),{recursive:true});
  writeFileSync(join(root,'research','owner-requests.md'),'# Open owner requests\n\nIntro.\n\n| # | Request | Status | Evidence | Next action |\n|---|---|---|---|---|\n| 1 | "first" | PARTIAL | e | n |\n| 7 | "seventh" | NOT STARTED | e | n |\n\n## Done\n\n| # | Request | Status |\n|---|---|---|\n| 9 | "old" | DONE |\n');
  const out=await applyCommand({id:ID,action:'request',at:NOW,text:'map | fly\nbetween bots'},{root});
  expect(out).toEqual({status:'request-recorded',note:'row 8 in research/owner-requests.md'});
  const lines=readFileSync(join(root,'research','owner-requests.md'),'utf8').split('\n');
  expect(lines[7]).toBe('| 7 | "seventh" | NOT STARTED | e | n |');
  expect(lines[8]).toBe('| 8 | "map / fly between bots" | NOT STARTED | Sent from the hosted dashboard | Triage: name the goal, the useful output and its consumer |');
  expect(lines[9]).toBe('');
  expect(lines.at(-2)).toBe('| 9 | "old" | DONE |');
  rmSync(root,{recursive:true,force:true});
 });
});
