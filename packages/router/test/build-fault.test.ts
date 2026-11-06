import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildFailureEvidence,buildFault,faultOf} from '../src/build-fault';

test('a fault names the failed proof cases from either report shape',()=>{
 const cases=JSON.stringify({ok:false,cases:[{id:'vial-shortfall',ok:false},{id:'vial-budget',ok:true}]});
 const results=JSON.stringify({ok:false,results:[{id:'z',ok:false},{id:'a',ok:false},{id:'b',ok:true}]});
 expect(faultOf('practice','bot log\n'+cases+'\n','')).toBe('practice: vial-shortfall');
 expect(faultOf('practice',results,'')).toBe('practice: a,z');
});
test('a fault names the false predicates of a checks report',()=>{
 const report=JSON.stringify({ok:false,scope:'practice',checks:{'short.missing':false,uniqueAccounts:true,'rerun.sameAccount':false},magic:{varrock:5}});
 expect(faultOf('native',report,'')).toBe('native: rerun.sameAccount,short.missing');
});
test('a fault names the failed bun tests, not the test file heading',()=>{
 const run=(name:string)=>`\na.test.ts:\n1 | code\nerror: expect(received).toBe(expected)\n(fail) ${name} [0.23ms]\n\n 1 pass\n 1 fail\n`;
 expect(faultOf('unit','',run('bad one'))).toBe('unit: bad one');
 expect(faultOf('unit','',run('bad one'))).not.toBe(faultOf('unit','',run('bad two')));
 expect(faultOf('unit','','\nb.test.ts:\nerror: Cannot find module x\n')).toBe('unit: error: Cannot find module x');
 expect(faultOf('unit','','\nb.test.ts:\n')).toBeNull();
});
test('a fault falls back to the first error line with its numbers removed',()=>{
 expect(faultOf('native','','\nError: fallback: saved state unobserved \n at x')).toBe('native: Error: fallback: saved state unobserved');
 expect(faultOf('native','','Error: failed at tick 1234 run deadbeef01')).toBe(faultOf('native','','Error: failed at tick 987 run 0123abcd45'));
});
test('host faults and empty logs give no fault',()=>{
 expect(faultOf('native','','Error: port 8888 in use')).toBeNull();
 expect(faultOf('native','','Error: practice free memory below floor')).toBeNull();
 expect(faultOf('native','','')).toBeNull();
});
test('proof timing cannot hide a source fault or turn a host failure into one',()=>{
 const timing='IRON_PROOF_TIMING {"pid":27796,"mode":"native","phase":"cli","event":"start","at":1793923351457}\n';
 const end='IRON_PROOF_TIMING {"pid":27796,"mode":"native","phase":"process-exit","event":"end","at":1793923510306}';
 expect(faultOf('native','',timing+end)).toBeNull();
 expect(faultOf('native','',timing+'Error: saved state unobserved\n'+end)).toBe('native: Error: saved state unobserved');
 expect(faultOf('native','',timing+'Error: bank quantities differ\n'+end)).toBe('native: Error: bank quantities differ');
 for(const error of ['insufficient practice free memory floor','insufficient free memory: below the floor','insufficient practice memory: need 6.5 GiB free']){
  expect(faultOf('native','',timing+'Error: '+error+'\n'+end)).toBeNull();
 }
});
test('a build fault reads the failing check logs, from delivery or diagnostic',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fault-')),stdout=join(dir,'o.log'),stderr=join(dir,'e.log');
 writeFileSync(stdout,'');writeFileSync(stderr,'Error: boom\n');
 const checks=[{id:'unit',exitCode:0,detail:'{}'},{id:'native',exitCode:1,detail:JSON.stringify({stdout,stderr})}];
 expect(buildFault({ok:false,delivery:{checks}})).toBe('native: Error: boom');
 expect(buildFault({ok:false,diagnostic:{checks}})).toBe('native: Error: boom');
});
test('a native memory stop survives engine teardown output without becoming a source fault',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-floor-fault-')),stderr=join(dir,'e.log');
 const failure={id:'rune-carrier-practice',phase:'practice',exitCode:1,detail:JSON.stringify({stderr})};
 const output={ok:false,delivery:{checks:[failure]}};
 const stop='Error: insufficient practice free memory floor';
 writeFileSync(stderr,'08:11:02 ERROR logger thread exited with code 0\n'+stop+'\n');
 expect(buildFailureEvidence(output)).toEqual({hostInterrupted:'memory-floor'});
 expect(buildFailureEvidence(output,false)).toEqual({hostInterrupted:'memory-floor'});
 expect(buildFault(output)).toBeNull();
 expect(buildFailureEvidence({ok:false,delivery:{checks:[{...failure,phase:'regression'}]}},false)).toEqual({});
 writeFileSync(stderr,stop+'\nError: bank quantities differ\n');
 expect(buildFailureEvidence(output,false)).toEqual({});
});
test('a passed build, a timeout, no checks and an unreadable detail give no fault',()=>{
 expect(buildFault({ok:true,delivery:{checks:[{id:'a',exitCode:1,detail:'{}'}]}})).toBeNull();
 expect(buildFault({ok:false,delivery:{checks:[{id:'a',exitCode:1,timedOut:true,detail:'{}'}]}})).toBeNull();
 expect(buildFault({ok:false,error:'worker ended'})).toBeNull();
 expect(buildFault(null)).toBeNull();
 expect(buildFault({ok:false,delivery:{checks:[{id:'a',exitCode:1,detail:'not json'}]}})).toBeNull();
});
