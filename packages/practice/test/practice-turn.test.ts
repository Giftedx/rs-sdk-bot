import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,existsSync,readFileSync,readdirSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observePracticeTurn,withPracticeTurn} from '../src/proof-lock';

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

test('an owner stop withdraws a waiting ticket without touching the holder',async()=>{
 const file=join(mkdtempSync(join(tmpdir(),'turn-')),'turn.lock'),owner=JSON.stringify({pid:999999,at:0});
 writeFileSync(file,owner);
 let stopped=false,starts=0;
 await expect(withPracticeTurn(file,async()=>++starts,{
  ...deps(()=>true),stopped:()=>stopped,sleep:async()=>{stopped=true;},
 })).rejects.toThrow('practice turn owner stopped');
 expect(starts).toBe(0);
 expect(readFileSync(file,'utf8')).toBe(owner);
 expect(readdirSync(file+'.queue')).toEqual([]);
});

test('practice observation distinguishes a live queue from stale or unclear files without writing',()=>{
 const file=join(mkdtempSync(join(tmpdir(),'turn-observe-')),'turn.lock'),queue=file+'.queue';
 const now=10_000,alive=(pid:number)=>pid===12||pid===14;
 expect(observePracticeTurn(file,now,alive)).toEqual({observedAt:now,holder:'no-lock',liveWaiters:0,oldestWaitMs:null,unknownTickets:0});
 mkdirSync(queue);
 const owner=JSON.stringify({pid:12,at:8000});writeFileSync(file,owner);
 for(const name of ['000000000006000-14-live','000000000003000-99-stale','invalid-ticket'])writeFileSync(join(queue,name),'');
 expect(observePracticeTurn(file,now,alive)).toEqual({observedAt:now,holder:'pid-present',liveWaiters:1,oldestWaitMs:4000,unknownTickets:1});
 expect(readFileSync(file,'utf8')).toBe(owner);
 expect(readdirSync(queue)).toHaveLength(3);
 writeFileSync(file,'{');
 expect(observePracticeTurn(file,now,alive).holder).toBe('unknown');
 writeFileSync(file,JSON.stringify({pid:99,at:8000}));
 expect(observePracticeTurn(file,now,alive).holder).toBe('pid-gone');
});
