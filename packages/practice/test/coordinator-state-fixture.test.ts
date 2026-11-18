import {expect,test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertAccountOwnership} from '../../../scripts/handoff-inputs';
import {coordinatorStateFixture,EMPTY_COORDINATOR_STATE} from '../src/coordinator-state-fixture';

test('the empty coordinator state is made only where none exists, satisfies the ownership check, and goes when the proof ends',()=>{
 const base=mkdtempSync(join(tmpdir(),'stage-state-')),file=join(base,'.practice/coordinator/state.json');
 try{
  const restore=coordinatorStateFixture(base);
  expect(readFileSync(file,'utf8')).toBe(EMPTY_COORDINATOR_STATE);
  // The staging script reads this file: with it no coordinator run owns any account.
  expect(()=>assertAccountOwnership(['flrs1','flrs1b'],JSON.parse(readFileSync(file,'utf8')),[],()=>false,'')).not.toThrow();
  restore();
  expect(existsSync(file)).toBe(false);
  restore(); // a second call changes nothing
  expect(existsSync(file)).toBe(false);
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('a coordinator state that exists is never replaced or removed, and a state that was changed in the meantime stays',()=>{
 const base=mkdtempSync(join(tmpdir(),'stage-state-live-')),file=join(base,'.practice/coordinator/state.json');
 try{
  mkdirSync(join(base,'.practice/coordinator'),{recursive:true});
  const live=JSON.stringify({version:1,tasks:[{status:'running',runId:'r1',spec:{id:'t',account:'Moneyshot'}}]});
  writeFileSync(file,live);
  const restore=coordinatorStateFixture(base);
  expect(readFileSync(file,'utf8')).toBe(live);
  restore();
  expect(readFileSync(file,'utf8')).toBe(live);
  // A fixture that a coordinator rewrote during the proof stays: the coordinator owns it.
  rmSync(file);
  const second=coordinatorStateFixture(base);
  writeFileSync(file,JSON.stringify({version:1,tasks:[{status:'running',runId:'r2',spec:{id:'u',account:'Moneyshot'}}]}));
  second();
  expect(existsSync(file)).toBe(true);
 }finally{rmSync(base,{recursive:true,force:true});}
});
