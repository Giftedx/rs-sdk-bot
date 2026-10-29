import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {atomicJson} from '../src/coordinator-store';

test('a save retries a rename that a reader blocks for a moment, and rethrows other errors',()=>{
 const dir=mkdtempSync(join(tmpdir(),'store-')),file=join(dir,'state.json');
 let fails=2;
 atomicJson(file,{a:1},(from,to)=>{if(fails-->0)throw Object.assign(Error('busy'),{code:'EPERM'});renameSync(from,to);});
 expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({a:1});
 expect(()=>atomicJson(file,{a:2},()=>{throw Object.assign(Error('gone'),{code:'ENOENT'});})).toThrow('gone');
});
