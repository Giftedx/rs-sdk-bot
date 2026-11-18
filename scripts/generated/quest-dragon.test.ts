import {expect, test} from 'bun:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

function finishDragon(destination: string, runes = true) {
 const root=resolve(import.meta.dir,'../..');
 const library=pathToFileURL(resolve(root,'scripts/generated/quest-lib.ts')).href;
 const script=pathToFileURL(resolve(root,'scripts/generated/quest-dragon.ts')).href;
 const code=`import {mock} from 'bun:test';
 const calls=[];
 const q={s:{onTick:cb=>{cb();return()=>{};}},msgCount:()=>1,
  canCast:()=>${JSON.stringify(runes)},
  teleport:async(...args)=>{calls.push(['teleport',...args]);},
  end:async(...args)=>{calls.push(['end',...args]);console.log('DRAGON_FINISH '+JSON.stringify(calls));process.exit(0);},
  fail:async(message)=>{calls.push(['fail',message]);console.log('DRAGON_FINISH '+JSON.stringify(calls));process.exit(2);}};
 mock.module(${JSON.stringify(library)},()=>({openQuest:async()=>q}));
 await import(${JSON.stringify(script)});`;
 const result=Bun.spawnSync(['bun','-e',code],{cwd:root,env:{...process.env,DS_FROM:'16',DS_STOP:'99',DS_RETURN:destination},stdout:'pipe',stderr:'pipe',windowsHide:true,timeout:10000});
 const stdout=result.stdout.toString(),stderr=result.stderr.toString();
 const json=stdout.match(/^DRAGON_FINISH (.*)$/m)?.[1];
 if(!json)throw Error(stderr+stdout);
 return{code:result.exitCode,calls:JSON.parse(json) as unknown[][]};
}

test('Dragon Slayer keeps its quest endpoint when no return is requested',()=>{
 expect(finishDragon('')).toEqual({code:0,calls:[['end',true,'qp=2 questMsg=true']]});
});

test('an explicit Varrock return uses the existing teleport before settlement',()=>{
 const result=finishDragon('varrock');
 expect(result.code).toBe(0);
 expect(result.calls).toEqual([['teleport','dragon return varrock','magic:varrock_teleport',3212,3424],['end',true,'qp=2 questMsg=true']]);
});

test('an explicit return without its runes fails instead of walking from Crandor',()=>{
 const result=finishDragon('varrock',false);
 expect(result.code).toBe(2);
 expect(result.calls).toHaveLength(1);
 expect(result.calls[0]![0]).toBe('fail');
 expect(String(result.calls[0]![1])).toContain('DS_RETURN varrock needs its teleport runes and Magic level');
});

test('an unknown return destination fails clearly',()=>{
 const result=finishDragon('unknown');
 expect(result.code).toBe(2);
 expect(String(result.calls[0]![1])).toContain('DS_RETURN must be varrock or empty');
});
