import {test,expect} from 'bun:test';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rotateLog,SWARM_LOG_MAX_BYTES} from '../src/log-rotate';
import {neverStarted,JOB_START_GRACE_MS} from '../../../scripts/autopilot';

test('a log over the cap moves to .1 and the next run starts a new file',()=>{
 const dir=mkdtempSync(join(tmpdir(),'log-rotate-')),log=join(dir,'Acct.log');
 try{
  expect(rotateLog(log,10)).toBe(false);
  writeFileSync(log,'x'.repeat(10));expect(rotateLog(log,10)).toBe(false);expect(statSync(log).size).toBe(10);
  writeFileSync(log,'y'.repeat(11));expect(rotateLog(log,10)).toBe(true);
  expect(existsSync(log)).toBe(false);expect(readFileSync(log+'.1','utf8')).toBe('y'.repeat(11));
  writeFileSync(log,'z'.repeat(12));expect(rotateLog(log,10)).toBe(true);
  expect(readFileSync(log+'.1','utf8')).toBe('z'.repeat(12));
  expect(existsSync(log+'.2')).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the cap is one constant of 8 MiB',()=>{expect(SWARM_LOG_MAX_BYTES).toBe(8*1024*1024);});

test('a started job on a rotated log is not never-started, and an untouched log still is',()=>{
 const dir=mkdtempSync(join(tmpdir(),'log-rotate-')),log=join(dir,'Acct.log');
 try{
  writeFileSync(log,'x'.repeat(100));const assigned={offset:100,at:1000},late=1000+JOB_START_GRACE_MS+1;
  expect(neverStarted(assigned,{active:false,logSize:100,now:late})).toBe(true);    // size equal to the offset: no start
  expect(rotateLog(log,10)).toBe(true);writeFileSync(log,'header\n');              // the new run wrote a header
  expect(neverStarted(assigned,{active:false,logSize:statSync(log).size,now:late})).toBe(false);
  expect(neverStarted(assigned,{active:false,logSize:150,now:late})).toBe(false);   // grown
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a failed move keeps the log and the earlier .1',()=>{
 const dir=mkdtempSync(join(tmpdir(),'log-rotate-')),log=join(dir,'Acct.log');
 try{
  writeFileSync(log+'.1','older');writeFileSync(log,'y'.repeat(20));
  // A directory where the .1 must go makes the second move fail.
  rmSync(log+'.1');mkdirSync(log+'.1');writeFileSync(join(log+'.1','keep'),'older');
  rotateLog(log,10);
  expect(existsSync(log)).toBe(true);expect(existsSync(join(log+'.1','keep'))).toBe(true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
