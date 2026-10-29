import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beginSessionAttempt} from '../src/session-lifecycle';
import {withSessionAdmission} from '../src/session-admission';
const server='rs-sdk-demo.fly.dev';
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'launch-session-')),root=join(base,'.practice/session-lifecycle');
 mkdirSync(join(base,'.practice/status'),{recursive:true});
 return {base,attempt:(account:string)=>beginSessionAttempt({account,server},{root}),
  status:(account:string,value:any)=>writeFileSync(join(base,'.practice/status',account+'.json'),JSON.stringify({name:account,server,...value}))};
}
test('launch rereads the latest producer after earlier admission and never invokes spawn on a partial connection',()=>{
 const f=fixture();let launches=0;
 const old=f.attempt('Rod');old.record('ended','logged-out');
 expect(withSessionAdmission(['Rod'],f.base,()=>++launches)).toBe(1);
 const partial=f.attempt('Rod');old.record('closed');
 expect(()=>withSessionAdmission(['Rod'],f.base,()=>++launches)).toThrow('not confirmed');
 expect(launches).toBe(1);
 partial.record('ended','logged-out');
 expect(withSessionAdmission(['Rod'],f.base,()=>++launches)).toBe(2);
});
test('one unresolved hosted or composed participant keeps the whole spawn offline',()=>{
 const f=fixture();let launches=0;f.attempt('Rod').record('ended','logged-out');f.attempt('Partner');
 for(const accounts of [['Rod','Partner'],['Partner','Rod']])expect(()=>withSessionAdmission(accounts,f.base,()=>++launches)).toThrow('not confirmed');
 expect(launches).toBe(0);
});
test('historical live status and newer crossed status refuse; a fresh identity can launch',()=>{
 const f=fixture();let launches=0;
 expect(withSessionAdmission(['Fresh'],f.base,()=>++launches)).toBe(1);
 f.status('Old',{result:'ok'});expect(()=>withSessionAdmission(['Old'],f.base,()=>++launches)).toThrow('legacy');
 f.attempt('Rod').record('ended','logged-out');f.status('Rod',{started:Date.now()+10000,sessionAttemptId:'other'});
 expect(()=>withSessionAdmission(['Rod'],f.base,()=>++launches)).toThrow('not covered');expect(launches).toBe(1);
 f.status('Rod',{at:Date.now()+10000,result:''});expect(()=>withSessionAdmission(['Rod'],f.base,()=>++launches)).toThrow('not covered');expect(launches).toBe(1);
});
