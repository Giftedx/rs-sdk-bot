import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {withPlanWrite,recoverPlanWrite} from '../src/coordinator-store';

test('independent processes retain every account plan update instead of racing atomic rename',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-plan-')),plan=join(dir,'plan.json'),worker=join(dir,'writer.ts');writeFileSync(plan,'[]');
 const store=resolve(import.meta.dir,'../src/coordinator-store.ts').replaceAll('\\','/');
 writeFileSync(worker,`import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {withPlanWrite} from ${JSON.stringify(store)};const [dir,name]=process.argv.slice(2);for(let n=0;n<3;n++)await withPlanWrite(async()=>{const file=join(dir!,'plan.json'),v=JSON.parse(readFileSync(file,'utf8'));await Bun.sleep(15);v.push(name+'-'+n);writeFileSync(file,JSON.stringify(v));},dir);`);
 const writers=Array.from({length:4},(_,i)=>Bun.spawn([process.execPath,worker,dir,String(i)],{windowsHide:true,stdout:'pipe',stderr:'pipe'}));
 const results=await Promise.all(writers.map(async p=>({exit:await p.exited,error:await new Response(p.stderr).text()})));
 expect(results).toEqual(Array.from({length:4},()=>({exit:0,error:''})));const data=JSON.parse(readFileSync(plan,'utf8'));expect(new Set(data).size).toBe(12);expect(data.length).toBe(12);expect(existsSync(join(dir,'plan-write-lock.json'))).toBe(false);
},15000);
test('dispatcher recovers only a dead known owner and retains its lease evidence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-plan-recovery-')),file=join(dir,'plan-write-lock.json'),owner={pid:123,nonce:'old',at:1};writeFileSync(file,JSON.stringify(owner));
 expect(recoverPlanWrite(dir,()=>true,()=>null)).toBe(false);expect(recoverPlanWrite(dir,()=>false)).toBe(true);
 const saved=readdirSync(join(dir,'plan-lock-recovery'));expect(JSON.parse(readFileSync(join(dir,'plan-lock-recovery',saved[0]!), 'utf8'))).toEqual(owner);
 await expect(withPlanWrite(()=>42,dir)).resolves.toBe(42);
});
test('dispatcher recovers a lock whose owner id a later process holds',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-plan-reuse-')),file=join(dir,'plan-write-lock.json'),at=1_000_000;writeFileSync(file,JSON.stringify({pid:123,nonce:'old',at}));
 // The id answers a signal, but its process started after the owner wrote the record: a different process.
 expect(recoverPlanWrite(dir,()=>true,()=>new Map([[123,at+60_000]]),at+120_000)).toBe(true);
 expect(existsSync(file)).toBe(false);expect(readdirSync(join(dir,'plan-lock-recovery'))).toHaveLength(1);
});
test('the start time of a lock owner is read for an old lock only, one time in a minute, and a failed read proves nothing',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-plan-reads-')),file=join(dir,'plan-write-lock.json'),at=1_000_000;writeFileSync(file,JSON.stringify({pid:123,nonce:'old',at}));
 let reads=0;const read=(start:number|null)=>(pids:readonly number[])=>{reads++;expect(pids).toEqual([123]);return start===null?null:new Map([[123,start]]);};
 // A young lock is a write in progress.
 expect(recoverPlanWrite(dir,()=>true,read(at+60_000),at+1000)).toBe(false);expect(reads).toBe(0);
 expect(recoverPlanWrite(dir,()=>true,read(null),at+10_000)).toBe(false);expect(reads).toBe(1);
 // The same owner record in the same minute: no second read.
 expect(recoverPlanWrite(dir,()=>true,read(at+60_000),at+20_000)).toBe(false);expect(reads).toBe(1);
 // The owner started before it wrote the record, and stays the owner.
 expect(recoverPlanWrite(dir,()=>true,read(at-40),at+80_000)).toBe(false);expect(reads).toBe(2);
 // A table without the id proves nothing.
 expect(recoverPlanWrite(dir,()=>true,()=>{reads++;return new Map([[456,at+60_000]]);},at+150_000)).toBe(false);expect(reads).toBe(3);
 expect(existsSync(file)).toBe(true);
 expect(recoverPlanWrite(dir,()=>true,read(at+60_000),at+220_000)).toBe(true);expect(reads).toBe(4);
 // A record with no time cannot prove a different process.
 writeFileSync(file,JSON.stringify({pid:123,nonce:'old'}));
 expect(recoverPlanWrite(dir,()=>true,read(at+60_000),at+500_000)).toBe(false);expect(reads).toBe(4);
});
test('a failed plan mutation releases its own lease without hiding the failure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-plan-failure-'));await expect(withPlanWrite(()=>{throw Error('preserved failure');},dir)).rejects.toThrow('preserved failure');expect(existsSync(join(dir,'plan-write-lock.json'))).toBe(false);
});
