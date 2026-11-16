import {test,expect} from 'bun:test';
import {renameRetry} from '../src/status';

test('a status rename blocked by a reader is retried, and other errors still throw',()=>{
 let fails=3,done=0;
 renameRetry('a','b',()=>{if(fails-->0)throw Object.assign(Error('busy'),{code:'EPERM'});done++;});
 expect(done).toBe(1);
 expect(()=>renameRetry('a','b',()=>{throw Object.assign(Error('gone'),{code:'ENOENT'});})).toThrow('gone');
});

test('rename retry preserves the default bound and validates an explicit limit before any rename',()=>{
 let calls=0;const busy=()=>{calls++;throw Object.assign(Error('busy'),{code:'EBUSY'});};
 expect(()=>renameRetry('a','b',busy)).toThrow('busy');expect(calls).toBe(21);
 calls=0;expect(()=>renameRetry('a','b',busy,0)).toThrow('busy');expect(calls).toBe(1);
 for(const limit of [-1,1.5,101,NaN,Infinity]){
  calls=0;expect(()=>renameRetry('a','b',busy,limit)).toThrow('rename retry limit');expect(calls).toBe(0);
 }
});
