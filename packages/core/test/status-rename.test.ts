import {test,expect} from 'bun:test';
import {renameRetry} from '../src/status';

test('a status rename blocked by a reader is retried, and other errors still throw',()=>{
 let fails=3,done=0;
 renameRetry('a','b',()=>{if(fails-->0)throw Object.assign(Error('busy'),{code:'EPERM'});done++;});
 expect(done).toBe(1);
 expect(()=>renameRetry('a','b',()=>{throw Object.assign(Error('gone'),{code:'ENOENT'});})).toThrow('gone');
});
