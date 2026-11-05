import {expect,test} from 'bun:test';
import {run} from './publish';

test('a command that outlives its limit is stopped and reported as a failure',async()=>{
 const start=Date.now();
 const r=await run([process.execPath,'-e','await Bun.sleep(30000)'],undefined,500);
 expect(r.ok).toBe(false);expect(r.out).toContain('stopped after');
 expect(Date.now()-start).toBeLessThan(10_000);
});

test('a stuck grandchild holding the output pipes does not hold the caller',async()=>{
 const code="Bun.spawn([process.execPath,'-e','await Bun.sleep(30000)'],{stdout:'inherit',stderr:'inherit'});await Bun.sleep(30000)";
 const start=Date.now();
 const r=await run([process.execPath,'-e',code],undefined,1000);
 expect(r.ok).toBe(false);expect(Date.now()-start).toBeLessThan(10_000);
});

test('a finished command gives its output, and a failed one its error text',async()=>{
 expect(await run([process.execPath,'-e','console.log("hello")'])).toEqual({ok:true,out:'hello'});
 const r=await run([process.execPath,'-e','console.error("broken");process.exit(3)']);
 expect(r.ok).toBe(false);expect(r.out).toBe('broken');
});
