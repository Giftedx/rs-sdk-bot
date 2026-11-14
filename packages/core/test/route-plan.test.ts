import {expect,test} from 'bun:test';
import {resolve} from 'node:path';

test('route planning cancels the caller and stops a worker with no surviving requests',async()=>{
 const probe=`
  import assert from 'node:assert/strict';
  import {executionContext} from './vendor/rs-sdk/sdk/execution-context';
  const workers=[];
  globalThis.Worker=class {
   constructor(){workers.push(this);this.requests=[];this.terminated=false;}
   ref(){} unref(){}
   postMessage(request){this.requests.push(request);}
   terminate(){this.terminated=true;}
   reply(id,plan){this.onmessage({data:{id,plan}});}
  };
  const {planTripOffThread}=await import('./packages/core/src/route-plan');
  const tile={x:1,z:1,level:0};
  const plan=controller=>executionContext.run({signal:controller.signal},()=>planTripOffThread(tile,tile,{}));
  const stopped=new AbortController(),active=new AbortController();
  const cancelled=plan(stopped).catch(e=>e.message),survivor=plan(active),first=workers[0];
  assert.equal(workers.length,1);
  stopped.abort(Error('caller stopped'));
  assert.equal(await Promise.race([cancelled,Bun.sleep(100).then(()=>null)]),'caller stopped');
  assert.equal(first.terminated,false);
  first.reply(first.requests[0].id,{cost:99,legs:[]});
  first.reply(first.requests[1].id,{cost:2,legs:[]});
  assert.equal((await survivor).cost,2);

  const last=new AbortController(),pending=plan(last).catch(e=>e.message);
  last.abort(Error('last caller stopped'));
  assert.equal(await pending,'last caller stopped');
  assert.equal(first.terminated,true);

  await assert.rejects(plan(last),/last caller stopped/);
  assert.equal(workers.length,1);
  const later=plan(new AbortController()),second=workers[1];
  first.onerror({message:'late error from stopped worker'});
  second.reply(second.requests[0].id,{cost:3,legs:[]});
  assert.equal((await later).cost,3);
 `;
 const child=Bun.spawn([process.execPath,'-e',probe],{cwd:resolve(import.meta.dir,'../../..'),stdout:'pipe',stderr:'pipe',windowsHide:true});
 const deadline=setTimeout(()=>child.kill(),5000);
 try{
  const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(stderr).toBe('');expect(code).toBe(0);
 }finally{clearTimeout(deadline);}
});

test('route worker can retry after native initialization fails',async()=>{
 const probe=`
  import assert from 'node:assert/strict';
  import {mock} from 'bun:test';
  import {resolve} from 'node:path';
  let loads=0;
  mock.module(resolve('packages/core/src/pathcache.ts'),()=>({loadPathfinding:async()=>{if(++loads===1)throw Error('native initialization failed');}}));
  mock.module(resolve('packages/core/src/world.ts'),()=>({rsPathLength:async()=>()=>1,createWorld:()=>({})}));
  mock.module(resolve('packages/core/src/trip.ts'),()=>({planTrip:()=>({cost:7,legs:[]})}));
  const messages=[];
  globalThis.self={onmessage:null,postMessage:message=>messages.push(message)};
  await import('./packages/core/src/route-worker');
  const data={from:{x:1,z:1,level:0},to:{x:2,z:2,level:0},acct:{}};
  await self.onmessage({data:{...data,id:1}});
  assert.match(messages[0].error,/native initialization failed/);
  await self.onmessage({data:{...data,id:2}});
  assert.deepEqual(messages[1],{id:2,plan:{cost:7,legs:[]}});
  assert.equal(loads,2);
 `;
 const child=Bun.spawn([process.execPath,'-e',probe],{cwd:resolve(import.meta.dir,'../../..'),stdout:'pipe',stderr:'pipe',windowsHide:true});
 const deadline=setTimeout(()=>child.kill(),5000);
 try{
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({code,stdout,stderr}).toEqual({code:0,stdout:'',stderr:''});
 }finally{clearTimeout(deadline);}
});
