import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {liveUpdateFile,readLiveUpdate,reloadDue,writeLiveUpdate} from '../src/live-reload';

test('a later unrelated update cannot clear an earlier dashboard reload request',()=>{
 const root=mkdtempSync(join(tmpdir(),'daemon-reload-'));
 try{
  mkdirSync(join(root,'.practice'));
  writeFileSync(liveUpdateFile(root),JSON.stringify({at:100,from:'a',to:'b',files:1,reload:['dashboard','dashboard-publish']}));
  expect(reloadDue(root,'dashboard',50)).toBe(true);
  writeFileSync(liveUpdateFile(root),JSON.stringify({at:200,from:'b',to:'c',files:1,reload:['fleet-agent'],reloadAt:{dashboard:100,'dashboard-publish':100,'fleet-agent':200}}));
  expect(reloadDue(root,'dashboard',50)).toBe(true);
  expect(reloadDue(root,'dashboard-publish',50)).toBe(true);
  expect(reloadDue(root,'dashboard',150)).toBe(false);
  expect(reloadDue(root,'fleet-agent',150)).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('the writer preserves legacy reload times without aging them into a new request',()=>{
 const root=mkdtempSync(join(tmpdir(),'daemon-reload-writer-'));
 try{
  mkdirSync(join(root,'.practice'));
  writeFileSync(liveUpdateFile(root),JSON.stringify({at:100,from:'a',to:'b',files:1,reload:['dashboard','dashboard-publish','swarm']}));
  writeLiveUpdate(root,{at:200,from:'b',to:'c',files:1,reload:['fleet-agent']});
  expect(readLiveUpdate(root)?.reloadAt).toEqual({dashboard:100,'dashboard-publish':100,swarm:100,'fleet-agent':200});
  expect(reloadDue(root,'dashboard-publish',50)).toBe(true);
  expect(reloadDue(root,'dashboard-publish',150)).toBe(false);
  writeLiveUpdate(root,{at:300,from:'c',to:'d',files:1,reload:[]});
  expect(readLiveUpdate(root)?.reload).toEqual([]);
  expect(reloadDue(root,'dashboard',50)).toBe(true);
  expect(reloadDue(root,'fleet-agent',150)).toBe(true);
  expect(reloadDue(root,'swarm',150)).toBe(false);
  writeLiveUpdate(root,{at:400,from:'d',to:'e',files:1,reload:['dashboard-publish']});
  expect(reloadDue(root,'dashboard-publish',350)).toBe(true);
  expect(reloadDue(root,'dashboard-publish',400)).toBe(false);
  expect(reloadDue(root,'watchdog',0)).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
