import {expect,spyOn,test} from 'bun:test';
import * as fs from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {readProgressionDeliveries,type ProgressionProofDelivery} from '../src/progression-proof-discovery';

const source='a'.repeat(64),runtime='b'.repeat(64),producer='packages/practice/src/ranged-progression-case.ts';
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const base=fs.mkdtempSync(join(tmpdir(),'progression-discovery-')),deliveries=join(base,'.practice/deliveries');fs.mkdirSync(deliveries,{recursive:true});
 function delivery(at=1700000000000,nonce='native'){
  const directory=join(deliveries,`ranged-train-${at}-${nonce}`);fs.mkdirSync(directory,{recursive:true});
  const report:ProgressionProofDelivery={id:'ranged-train',goal:'Finite current-state Ranged band',ok:true,stage:'delivered',evidence:'native',consumer:'Ranged85 before99',source,runtimeRevision:runtime,at:at+1,directory,reason:'native capability and named consumer verified',
   checks:['regression','practice','consumer'].map((phase,i)=>({id:'check-'+i,phase:phase as 'regression'|'practice'|'consumer',exitCode:0,timedOut:false,detail:'retained native check logs'})),files:[{path:producer,sha256:'c'.repeat(64)}]};
  const file=join(directory,'report.json'),save=()=>fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');save();return{directory,report,file,save};
 }
 return{base,deliveries,delivery,cleanup:()=>fs.rmSync(base,{recursive:true,force:true})};
}

test('discovery returns canonical local report records and the hash of their exact bytes without publishing',()=>{
 const f=fixture();try{const older=f.delivery(),newer=f.delivery(1700000000001),rows=readProgressionDeliveries(f.base);
  expect(rows.map(row=>row.directory)).toEqual([newer.directory,older.directory].map(d=>fs.realpathSync(d)));
  expect(rows[0]?.report).toEqual(newer.report);expect(rows[0]?.reportSha256).toBe(hash(fs.readFileSync(newer.file)));
  expect(fs.existsSync(join(f.base,'.practice/progression-system/qualifications.json'))).toBe(false);
  expect(readProgressionDeliveries(join(f.base,'missing'))).toEqual([]);
 }finally{f.cleanup();}
});

test('only the newest64 immediate protocol reports are opened even when they are all malformed',()=>{
 const f=fixture();try{
  const created=Array.from({length:70},(_,i)=>f.delivery(1700000000000+i)),nested=join(f.deliveries,'unrelated','ranged-train-1800000000000-nested');
  fs.mkdirSync(nested,{recursive:true});fs.writeFileSync(join(nested,'report.json'),'{}');fs.mkdirSync(join(f.deliveries,'ranged-train-not-a-timestamp-native'));
  const open=fs.openSync,opened:string[]=[];
  const spy=spyOn(fs,'openSync').mockImplementation(((path:any,...args:any[])=>{if(String(path).endsWith('report.json'))opened.push(String(path));return(open as any)(path,...args);}) as typeof fs.openSync);
  try{
   const rows=readProgressionDeliveries(f.base);expect(rows).toHaveLength(64);expect(opened).toHaveLength(64);
   expect(rows[0]?.directory).toBe(fs.realpathSync(created[69]!.directory));expect(rows[63]?.directory).toBe(fs.realpathSync(created[6]!.directory));
   for(const row of created.slice(6))fs.writeFileSync(row.file,'{partial');opened.length=0;
   expect(readProgressionDeliveries(f.base)).toEqual([]);expect(opened).toHaveLength(64);
   expect(opened).not.toContain(created[0]!.file);
  }finally{spy.mockRestore();}
 }finally{f.cleanup();}
});

test('partial, failed, unsupported and malformed delivery metadata is excluded',()=>{
 const mutations:((report:any)=>void)[]=[r=>r.ok=false,r=>r.stage='failed',r=>r.id='other',r=>r.evidence='unit',r=>r.diagnostic={complete:true},r=>r.hostDeferred=true,r=>r.failedCheck='practice',r=>r.source='missing',r=>r.runtimeRevision=null,r=>r.at=Infinity,r=>r.goal='',r=>r.consumer='',r=>r.checks.pop(),r=>r.checks[1].exitCode=1,r=>r.checks[1].timedOut='false',r=>r.files=[],r=>r.files[0].path='unrelated.ts',r=>r.files[0].sha256=null];
 for(const mutate of mutations){const f=fixture();try{const d=f.delivery();mutate(d.report);d.save();expect(readProgressionDeliveries(f.base)).toEqual([]);}finally{f.cleanup();}}
 const f=fixture();try{const d=f.delivery();fs.writeFileSync(d.file,'{partial');expect(readProgressionDeliveries(f.base)).toEqual([]);}finally{f.cleanup();}
});

test('reports larger than1MiB and redirected directory claims are excluded before acceptance',()=>{
 const f=fixture();try{const d=f.delivery(),other=f.delivery(1700000000001,'other');
  fs.writeFileSync(d.file,JSON.stringify({...d.report,reason:'x'.repeat(1024*1024)}));expect(readProgressionDeliveries(f.base).map(r=>r.directory)).toEqual([other.directory]);
  d.report.directory=other.directory;d.save();expect(readProgressionDeliveries(f.base).map(r=>r.directory)).toEqual([other.directory]);
  d.report.directory=resolve(d.directory,'../..','outside');d.save();expect(readProgressionDeliveries(f.base).map(r=>r.directory)).toEqual([other.directory]);
 }finally{f.cleanup();}
});

test('symlinked delivery directories, report files and delivery storage are excluded',()=>{
 const f=fixture();try{
  const d=f.delivery(),outside=join(f.base,'outside'),report=join(outside,'report.json');fs.mkdirSync(outside);fs.writeFileSync(report,JSON.stringify(d.report));
  fs.rmSync(d.file);fs.symlinkSync(report,d.file,'file');expect(readProgressionDeliveries(f.base)).toEqual([]);
  fs.rmSync(d.directory,{recursive:true,force:true});fs.symlinkSync(outside,d.directory,process.platform==='win32'?'junction':'dir');expect(readProgressionDeliveries(f.base)).toEqual([]);
  fs.rmSync(f.deliveries,{recursive:true,force:true});
  const nativeFolder=join(outside,d.directory.split(/[\\/]/).at(-1)!);fs.mkdirSync(nativeFolder);fs.writeFileSync(join(nativeFolder,'report.json'),JSON.stringify(d.report));
  fs.symlinkSync(outside,f.deliveries,process.platform==='win32'?'junction':'dir');expect(readProgressionDeliveries(f.base)).toEqual([]);
 }finally{f.cleanup();}
});

test('the selected physical practice root permits its workspace junction but no alternate directory alias',()=>{
 const f=fixture();try{
  const d=f.delivery(),workspace=join(f.base,'workspace');fs.mkdirSync(workspace);fs.symlinkSync(join(f.base,'.practice'),join(workspace,'.practice'),process.platform==='win32'?'junction':'dir');
  d.report.directory=join(workspace,'.practice/deliveries',d.directory.split(/[\\/]/).at(-1)!);d.save();
  expect(readProgressionDeliveries(workspace).map(r=>r.directory)).toEqual([fs.realpathSync(d.directory)]);
  const alias=join(f.base,'alias');fs.symlinkSync(d.directory,alias,process.platform==='win32'?'junction':'dir');d.report.directory=alias;d.save();
  expect(readProgressionDeliveries(workspace)).toEqual([]);
 }finally{f.cleanup();}
});

test('a report replaced or grown during its bounded read is rejected and its descriptor closes',()=>{
 for(const change of ['replace','grow']){const f=fixture();try{const d=f.delivery(),nativeRead=fs.readSync,nativeClose=fs.closeSync;
  let altered=false,fd:number|undefined;const closed:number[]=[];
  const read=spyOn(fs,'readSync').mockImplementation(((descriptor:number,...args:any[])=>{
   if(!altered){altered=true;fd=descriptor;
    if(change==='replace'){fs.renameSync(d.file,d.file+'.retained');fs.writeFileSync(d.file,JSON.stringify({...d.report,goal:'X'.repeat(d.report.goal.length)},null,2)+'\n');}
    else fs.appendFileSync(d.file,' '.repeat(1024*1024));
   }
   return(nativeRead as any)(descriptor,...args);
  }) as typeof fs.readSync);
  const close=spyOn(fs,'closeSync').mockImplementation(((descriptor:number)=>{closed.push(descriptor);return nativeClose(descriptor);}) as typeof fs.closeSync);
  try{expect(readProgressionDeliveries(f.base)).toEqual([]);expect(altered).toBe(true);expect(closed).toContain(fd!);expect(()=>fs.fstatSync(fd!)).toThrow();}finally{read.mockRestore();close.mockRestore();}
 }finally{f.cleanup();}}
});
