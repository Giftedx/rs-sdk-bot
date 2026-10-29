import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {withPracticeTurn} from '../src/proof-lock';

const deps=(alive:(pid:number)=>boolean)=>({alive,sleep:(ms:number)=>Bun.sleep(1),now:()=>Date.now(),waitMs:5000});

test('two native checks take turns and the turn file is removed after each',async()=>{
 const file=join(mkdtempSync(join(tmpdir(),'turn-')),'turn.lock'),order:string[]=[];
 const job=(id:string)=>withPracticeTurn(file,async()=>{order.push(id+'>');await Bun.sleep(20);order.push('<'+id);},deps(()=>true));
 await Promise.all([job('a'),job('b')]);
 expect(order).toEqual(['a>','<a','b>','<b']);
 expect(existsSync(file)).toBe(false);
});

test('a dead holder gives up its turn; a live holder past the wait budget refuses',async()=>{
 const file=join(mkdtempSync(join(tmpdir(),'turn-')),'turn.lock');
 writeFileSync(file,JSON.stringify({pid:999999,at:0}));
 expect(await withPracticeTurn(file,async()=>'ran',deps(()=>false))).toBe('ran');
 writeFileSync(file,JSON.stringify({pid:999999,at:0}));
 await expect(withPracticeTurn(file,async()=>'ran',{...deps(()=>true),waitMs:0})).rejects.toThrow('practice turn wait expired');
});

test('a holder that asks again waits behind a check that queued while it ran',async()=>{
 const file=join(mkdtempSync(join(tmpdir(),'turn-')),'turn.lock'),order:string[]=[];
 const d=deps(()=>true);
 const first=withPracticeTurn(file,async()=>{order.push('long-1');await Bun.sleep(30);},d)
  .then(()=>withPracticeTurn(file,async()=>{order.push('long-2');},d));
 await Bun.sleep(5);
 const quick=withPracticeTurn(file,async()=>{order.push('quick');},d);
 await Promise.all([first,quick]);
 expect(order).toEqual(['long-1','quick','long-2']);
});
