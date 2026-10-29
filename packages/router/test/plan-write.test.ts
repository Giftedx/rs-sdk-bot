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
 expect(recoverPlanWrite(dir,()=>true)).toBe(false);expect(recoverPlanWrite(dir,()=>false)).toBe(true);
 const saved=readdirSync(join(dir,'plan-lock-recovery'));expect(JSON.parse(readFileSync(join(dir,'plan-lock-recovery',saved[0]!), 'utf8'))).toEqual(owner);
 await expect(withPlanWrite(()=>42,dir)).resolves.toBe(42);
});
test('a failed plan mutation releases its own lease without hiding the failure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-plan-failure-'));await expect(withPlanWrite(()=>{throw Error('preserved failure');},dir)).rejects.toThrow('preserved failure');expect(existsSync(join(dir,'plan-write-lock.json'))).toBe(false);
});
