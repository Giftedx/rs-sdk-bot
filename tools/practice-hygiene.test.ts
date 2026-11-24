import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,utimesSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {classify,scan,counts,archiveThenDelete,GRACE_MS,scanFleetOrders,applyFleetMoves,fleetOrdersDir} from './practice-hygiene';

const now=1_800_000_000_000,old=now-2*GRACE_MS,named=new Set(['flrcvxkeep','trousersnake']);

test('a scratch folder matches only the mkdtemp name of a known writer',()=>{
 expect(classify('recovery-permit-002UoO',false,undefined,old,now,named)).toBe('scratch-dir');
 expect(classify('session-recovery-01Xl5H',false,undefined,old,now,named)).toBe('scratch-dir');
 expect(classify('recovery-cli-refusal-13AfK5',false,undefined,old,now,named)).toBe('scratch-dir');
 expect(classify('recovery-stop-01iTpd',false,undefined,old,now,named)).toBe('scratch-dir');
 for(const keep of ['recovery-tmp','session-recovery-tmp1','recovery-permit-','session-recovery'])expect(classify(keep,false,undefined,old,now,named)).toBeNull();
 expect(classify('recovery-permit-002UoO',true,'x',old,now,named)).toBeNull();
});

test('an entry newer than the grace period stays',()=>{
 expect(classify('recovery-permit-002UoO',false,undefined,now-1000,now,named)).toBeNull();
 expect(classify('stop-flrcvx070j16',true,'native recovery proof stop 1 u',now-1000,now,named)).toBeNull();
});

test('a stop file goes only for a generated fixture account with plain test text',()=>{
 for(const n of ['stop-flrcvx04wf16','stop-flcowx14g34','stop-fb1x28k11','stop-rngex0z601'])expect(classify(n,true,'native recovery proof stop 3156 id',old,now,named)).toBe('fixture-stop');
 // An owner stop: a real account name, JSON text, a name in a plan, or a name outside the fixture pattern.
 expect(classify('stop-UnloadMe',true,'{"owner":"codex"}',old,now,named)).toBeNull();
 expect(classify('stop-flrcvx04wf16',true,'{"owner":"codex","reason":"keep"}',old,now,named)).toBeNull();
 expect(classify('stop-flrcvxkeep',true,'native recovery proof stop 1 u',old,now,named)).toBeNull();
 expect(classify('stop-TrouserSnake',true,'swarm stopped',old,now,named)).toBeNull();
 expect(classify('stop-coordinator',true,'owner pause',old,now,named)).toBeNull();
 expect(classify('stop-swarm',true,'owner pause',old,now,named)).toBeNull();
 expect(classify('stop-flrcvx04wf16',false,undefined,old,now,named)).toBeNull();
 // Owner text on a fixture-pattern name stays: only a proof-generated first string goes.
 for(const [n,t] of [['stop-flrngxtry01','Owner stops this isolated qualification fixture because the run is obsolete'],['stop-flrcxf4g00','Root ends obsolete private PR163 proof'],['stop-flprocxtd001','Practice route defect: already at target'],['stop-fb1x28k11','native fixture allocation mismatch; stop owned test']])
  expect(classify(n!,true,t!,old,now,named)).toBeNull();
 for(const [n,t] of [['stop-flcowx14g34','cow-progress-order proof stop F:\\x'],['stop-flrcvx070j16','native recovery proof stop 12 id'],['stop-flrcvx0a1f16','native completed stop id']])
  expect(classify(n!,true,t!,old,now,named)).toBe('fixture-stop');
});

function fixtureRoot(){
 const root=mkdtempSync(join(tmpdir(),'practice-hygiene-')),prac=join(root,'.practice'),aged=Date.now()-2*GRACE_MS,age=(p:string)=>utimesSync(p,new Date(aged),new Date(aged));
 mkdirSync(prac);writeFileSync(join(root,'swarm.json'),JSON.stringify({jobs:[{account:'Planned',enabled:true}]}));
 for(const d of ['recovery-permit-aaaaaa','session-recovery-bbbbbb','recovery-tmp'])mkdirSync(join(prac,d));
 writeFileSync(join(prac,'recovery-permit-aaaaaa','x.json'),'{}');
 writeFileSync(join(prac,'stop-flrcvxaaa01'),'native recovery proof stop 1 u');
 writeFileSync(join(prac,'stop-Planned'),'swarm stopped');
 writeFileSync(join(prac,'stop-UnloadMe'),'{"owner":"x"}');
 writeFileSync(join(root,'fleet-note'),'');
 for(const f of readdirSync(prac))age(join(prac,f));
 return root;
}

test('scan, dry run and apply act on the leaked entries only and archive them first',()=>{
 const root=fixtureRoot(),archiveDir=join(root,'archive');
 try{
  const entries=scan(root,Date.now());
  expect(entries.map(e=>e.name).sort()).toEqual(['recovery-permit-aaaaaa','session-recovery-bbbbbb','stop-flrcvxaaa01'].sort());
  expect(counts(entries)).toEqual({'recovery-permit-*':1,'session-recovery-*':1,'stop-fixture':1});
  const r=archiveThenDelete(root,entries,archiveDir,'t');
  expect(r.deleted).toBe(3);expect(existsSync(r.archive)).toBe(true);
  const left=readdirSync(join(root,'.practice')).sort();
  expect(left).toEqual(['recovery-tmp','stop-Planned','stop-UnloadMe']);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("the recovery tests keep their scratch folders under one removed subfolder, not the .practice root",()=>{
 for(const file of ["session-recovery.test.ts","session-recovery-permit.test.ts"]){
  const text=readFileSync(join(import.meta.dir,"../packages/core/test",file),"utf8");
  expect(text).toContain("useScratch()");expect(text).not.toMatch(/mkdtempSync\(join\(fixtureRoot/);
 }
 const helper=readFileSync(join(import.meta.dir,"../packages/core/test/recovery-scratch.ts"),"utf8");
 expect(helper).toContain(".practice/recovery-tmp");expect(helper).toContain("afterAll");
});

test('fleet orders past their window move by month with their receipts; open and recent ones stay',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-orders-')),now=Date.parse('2026-11-18T00:00:00Z'),day=86_400_000;
 try{
  for(const d of ['orders','receipts'])mkdirSync(join(dir,d),{recursive:true});
  const order=(id:string,end:number)=>writeFileSync(join(dir,'orders',id+'.json'),JSON.stringify({id,from:'A',to:'B',start:end-1000,end}));
  order('old',now-30*day);order('recent',now-2*day);order('open',now+day);
  for(const f of ['old.from','old.to','recent.from','open.to','stray.from'])writeFileSync(join(dir,'receipts',f+'.json'),'{}');
  writeFileSync(join(dir,'orders','broken.json'),'not json');
  const r=scanFleetOrders(dir,now);
  expect(r.moves.map(m=>m.id)).toEqual(['old']);expect(r.moves[0]!.month).toBe('2026-10');
  expect(r.kept).toBe(3);expect(r.receiptsMoved).toBe(2);expect(r.orphanReceipts).toBe(3);
  expect(applyFleetMoves(dir,r.moves)).toBe(3);
  expect(readdirSync(join(dir,'orders')).sort()).toEqual(['broken.json','open.json','recent.json']);
  expect(readdirSync(join(dir,'archive','2026-10','receipts')).sort()).toEqual(['old.from.json','old.to.json']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a read-back that misses a name deletes nothing, and a missing archive drive throws before any delete',()=>{
 const root=fixtureRoot(),archiveDir=join(root,'archive'),entries=scan(root,Date.now()),before=readdirSync(join(root,'.practice')).sort();
 try{
  const real=spawnSync;
  const lying=((cmd:string,args:string[],opts:any)=>args[0]==='-tzf'?{status:0,stdout:'recovery-permit-aaaaaa/\n',stderr:''}:real(cmd,args,opts)) as typeof spawnSync;
  expect(()=>archiveThenDelete(root,entries,archiveDir,'m',lying)).toThrow('archive misses');
  expect(readdirSync(join(root,'.practice')).sort()).toEqual(before);
  const failing=((cmd:string,args:string[],opts:any)=>args[0]==='-czf'?{status:2,stdout:'',stderr:'no space'}:real(cmd,args,opts)) as typeof spawnSync;
  expect(()=>archiveThenDelete(root,entries,archiveDir,'f',failing)).toThrow('archive failed');
  expect(readdirSync(join(root,'.practice')).sort()).toEqual(before);
  // The root check runs through an injected exists, so it does not depend on the system's drive letters.
  const seen:string[]=[];
  expect(()=>archiveThenDelete(root,entries,join(root,'no-such-drive','x'),'d',real,p=>{seen.push(p);return false;})).toThrow('archive parent is missing');
  expect(seen).toHaveLength(1);
  // A real path whose parent is a file, and a Windows-style path (its parent does not exist on Linux, and no drive Q: exists here).
  writeFileSync(join(root,'a-file'),'x');
  expect(()=>archiveThenDelete(root,entries,join(root,'a-file','x'),'p')).toThrow('archive parent is not a directory');
  expect(()=>archiveThenDelete(root,entries,join(root,'no-parent','deeper','x'),'q')).toThrow('archive parent is missing');
  expect(existsSync(join(root,'no-parent'))).toBe(false);
  expect(readdirSync(join(root,'.practice')).sort()).toEqual(before);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('fleetOrdersDir prefers .practice/live/fleet-data/fleet and falls back to legacy .practice/fleet-data/fleet',()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-orders-dir-'));
 try{
  expect(fleetOrdersDir(root)).toBe(join(root,'.practice','live','fleet-data','fleet'));
  mkdirSync(join(root,'.practice','fleet-data','fleet'),{recursive:true});
  expect(fleetOrdersDir(root)).toBe(join(root,'.practice','fleet-data','fleet'));
  mkdirSync(join(root,'.practice','live','fleet-data','fleet'),{recursive:true});
  expect(fleetOrdersDir(root)).toBe(join(root,'.practice','live','fleet-data','fleet'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
