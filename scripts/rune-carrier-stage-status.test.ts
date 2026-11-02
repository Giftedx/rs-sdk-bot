import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
test('one staged helper can finish while its peer remains active',()=>{
 const code=`
 import{mock}from'bun:test';import{resolve}from'node:path';import{readFileSync,rmSync}from'node:fs';
 mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:async()=>{}}));
 const{startStatus}=await import('./packages/core/src/status');const{runeStageStatus}=await import('./scripts/rune-carrier-stage-status');
 const names=['StageA'+process.pid,'StageB'+process.pid],log=runeStageStatus(names);
 const file=name=>resolve('.practice/status',name+'.json');
 const handles=names.map(name=>startStatus({name,sdk:{getState:()=>({inventory:[],equipment:[],skills:[]})},tick:()=>1,onTick:()=>()=>{}},'localhost:8910'));
 try{
  log(names[0],'RESULT ok staged carrier');handles.forEach(h=>h.stop());
  const first=JSON.parse(readFileSync(file(names[0]),'utf8')).result,peer=JSON.parse(readFileSync(file(names[1]),'utf8')).result;
  log(names[1],'RESULT fail stopped');handles[1].stop();
  console.log(JSON.stringify({first,peer,second:JSON.parse(readFileSync(file(names[1]),'utf8')).result}));
 }finally{handles.forEach(h=>h.stop());for(const name of names){rmSync(file(name),{force:true});rmSync(file(name)+'.tmp',{force:true});}}
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe'});
 if(child.exitCode!==0)throw Error(child.stderr.toString());
 const result=JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
 expect(result.first).toBe('ok staged carrier');expect(result.peer).toBe('');expect(result.second).toBe('fail stopped');
});
