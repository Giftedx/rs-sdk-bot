import {expect,test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertAccountOwnership} from '../../../scripts/handoff-inputs';
import {fleetStateFile} from '../../core/src/practice-paths';
import {coordinatorStateFixture,EMPTY_COORDINATOR_STATE} from '../src/coordinator-state-fixture';

test('the empty fleet state is made only where none exists, satisfies the ownership check, and goes when the proof ends',()=>{
 const base=mkdtempSync(join(tmpdir(),'stage-state-')),file=fleetStateFile(base);
 try{
  const restore=coordinatorStateFixture(base);
  expect(readFileSync(file,'utf8')).toBe(EMPTY_COORDINATOR_STATE);
  // The staging script reads this file: with it no fleet controller pauses any account.
  expect(()=>assertAccountOwnership(['flrs1','flrs1b'],JSON.parse(readFileSync(file,'utf8')),[],()=>false,'')).not.toThrow();
  restore();
  expect(existsSync(file)).toBe(false);
  restore(); // a second call changes nothing
  expect(existsSync(file)).toBe(false);
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('a fleet state that exists is never replaced or removed, and a state that was changed in the meantime stays',()=>{
 const base=mkdtempSync(join(tmpdir(),'stage-state-live-')),file=fleetStateFile(base);
 try{
  mkdirSync(join(base,'.practice/live'),{recursive:true});
  const live=JSON.stringify({schemaVersion:1,accounts:{moneyshot:{paused:true}}});
  writeFileSync(file,live);
  const restore=coordinatorStateFixture(base);
  expect(readFileSync(file,'utf8')).toBe(live);
  restore();
  expect(readFileSync(file,'utf8')).toBe(live);
  // A fixture that a controller rewrote during the proof stays: the controller owns it.
  rmSync(file);
  const second=coordinatorStateFixture(base);
  writeFileSync(file,JSON.stringify({schemaVersion:1,accounts:{moneyshot:{paused:true}}}));
  second();
  expect(existsSync(file)).toBe(true);
 }finally{rmSync(base,{recursive:true,force:true});}
});
