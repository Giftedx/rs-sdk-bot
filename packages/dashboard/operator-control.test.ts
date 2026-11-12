import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOperatorControl} from './operator-control';
import {initialState} from '../router/src/coordinator';
function fixture(readOnly=false){
 const root=mkdtempSync(join(tmpdir(),'atlas-control-')),dir=join(root,'.practice/coordinator');mkdirSync(dir,{recursive:true});mkdirSync(join(root,'packages/router/tasks'),{recursive:true});
 writeFileSync(join(dir,'state.json'),JSON.stringify(initialState()));writeFileSync(join(root,'swarm.json'),JSON.stringify({coordination:{enabled:true}}));
 writeFileSync(join(root,'packages/router/tasks/food.json'),JSON.stringify({id:'food',goal:'Supply fish',entry:'scripts/fishcook.ts',files:['scripts/fishcook.ts'],consumer:'Feed earning accounts',checks:[]}));
 let starts=0;const handler=createOperatorControl({root,readOnly,nonce:'test-nonce',alive:()=>false,spawn:(()=>{starts++;return 7;}) as any});
 const send=(body:any,headers:any={})=>handler(new Request('http://127.0.0.1:3100/api/control',{method:'POST',headers:{origin:'http://127.0.0.1:3100','x-atlas-control':'test-nonce','content-type':'application/json',...headers},body:JSON.stringify(body)}),'127.0.0.1');
 return{root,dir,handler,send,starts:()=>starts,close:()=>rmSync(root,{recursive:true,force:true})};
}

test('read-only dashboards expose metadata but refuse every command before writing or spawning',async()=>{
 const f=fixture(true);try{
  const meta=await(await f.handler(new Request('http://127.0.0.1:3100/api/control'),'127.0.0.1')).json();
  expect(meta.readOnly).toBe(true);
  for(const action of ['pause','resume','plan','queue','account-pause','account-release','request','swarm-pause','swarm-resume','job-enable','job-disable'])expect((await f.send({id:randomUUID(),action})).status).toBe(403);
  expect(f.starts()).toBe(0);expect(existsSync(join(f.root,'.practice/stop-coordinator'))).toBe(false);
  expect(existsSync(join(f.root,'.practice/dashboard-controls'))).toBe(false);
 }finally{f.close();}
});

test('coordinator process presence is independent of queue freshness',async()=>{
 const f=fixture();try{
  const handler=createOperatorControl({root:f.root,alive:pid=>pid===42});
  const meta=async()=>await(await handler(new Request('http://127.0.0.1:3100/api/control'),'127.0.0.1')).json() as any;
  expect((await meta()).coordinatorRunning).toBe(false);
  writeFileSync(join(f.dir,'owner.json'),JSON.stringify({pid:42,at:1}));
  expect((await meta()).coordinatorRunning).toBe(true);
  writeFileSync(join(f.dir,'owner.json'),JSON.stringify({pid:43,at:1}));
  expect((await meta()).coordinatorRunning).toBe(false);
 }finally{f.close();}
});
test('the metadata names the fleet agent and the autopilot as never, down, running or stopped',async()=>{
 const f=fixture();try{
  const handler=createOperatorControl({root:f.root,alive:pid=>pid===42});
  const states=async()=>((await(await handler(new Request('http://127.0.0.1:3100/api/control'),'127.0.0.1')).json()) as any).controllers.map((c:any)=>c.name+' '+c.state);
  expect(await states()).toEqual(['fleet-agent never','autopilot never']);
  // The traces of a one-shot pass are not a daemon start. A launch record is.
  writeFileSync(join(f.root,'.practice/fleet-agent.log'),'ran');mkdirSync(join(f.root,'.practice/autopilot'));
  expect(await states()).toEqual(['fleet-agent never','autopilot never']);
  writeFileSync(join(f.root,'.practice/fleet-agent.launch.json'),JSON.stringify({args:[],env:{DEMO_OK:'1'}}));
  writeFileSync(join(f.root,'.practice/autopilot/launch.json'),JSON.stringify({args:[join(f.root,'swarm.json')],env:{}}));
  expect(await states()).toEqual(['fleet-agent down','autopilot down']);
  writeFileSync(join(f.root,'.practice/fleet-agent.lock'),'42');writeFileSync(join(f.root,'.practice/stop-autopilot'),'');
  expect(await states()).toEqual(['fleet-agent running','autopilot stopped']);
  // The lease of a process that ended: down again. No process id leaves the machine.
  writeFileSync(join(f.root,'.practice/fleet-agent.lock'),'43');
  const meta=(await(await handler(new Request('http://127.0.0.1:3100/api/control'),'127.0.0.1')).json()) as any;
  expect(meta.controllers[0]).toMatchObject({name:'fleet-agent',label:'Fleet agent',state:'down'});
  expect(Object.keys(meta.controllers[0]).sort()).toEqual(['label','name','seenAt','state']);
 }finally{f.close();}
});
test('operator controls require loopback, same origin and the current session nonce',async()=>{
 const f=fixture();try{expect((await f.handler(new Request('http://127.0.0.1:3100/api/control'),'10.0.0.1')).status).toBe(403);
 expect((await f.handler(new Request('http://rebound.invalid:3100/api/control'),'127.0.0.1')).status).toBe(403);
 for(const headers of [{origin:'https://other.test'},{'x-atlas-control':'old'}])expect((await f.send({id:randomUUID(),action:'plan'},headers)).status).toBe(403);
 expect(existsSync(join(f.dir,'plan-request'))).toBe(false);}finally{f.close();}
});
test('account controls only release dashboard holds and retain other owners and failure evidence',async()=>{
 const f=fixture();try{mkdirSync(join(f.root,'vendor/rs-sdk/bots/Worker'),{recursive:true});writeFileSync(join(f.root,'.practice/failure-Worker'),'retained');
 expect((await f.send({id:randomUUID(),action:'account-pause',account:'Worker'})).status).toBe(200);
 expect(readFileSync(join(f.root,'.practice/stop-Worker'),'utf8')).toStartWith('dashboard-stop:');
 expect((await f.send({id:randomUUID(),action:'account-release',account:'Worker'})).status).toBe(200);
 expect(readFileSync(join(f.root,'.practice/failure-Worker'),'utf8')).toBe('retained');
 writeFileSync(join(f.root,'.practice/stop-Worker'),'other owner');
 expect((await f.send({id:randomUUID(),action:'account-release',account:'Worker'})).status).toBe(400);
 expect((await f.send({id:randomUUID(),action:'account-pause',account:'../escape'})).status).toBe(400);
 expect(readFileSync(join(f.root,'.practice/stop-Worker'),'utf8')).toBe('other owner');
 }finally{f.close();}
});
test('accepted new-capability inbox entries recover after a lost audit write',async()=>{
 const f=fixture();try{const id=randomUUID(),task={id:'operator-'+id,kind:'build',goal:'wealth',capability:'new-food',why:'New useful supplier',dependsOn:[],priority:30,estimatedMs:60000},definition={id:'new-food',goal:'Useful food',entry:'scripts/new-food.ts',files:['scripts/new-food.ts'],consumer:'Earning accounts',checks:['regression','practice','consumer'].map(phase=>({id:phase,phase,command:['bun','scripts/new-food.ts'],timeoutMs:1000}))};
 const input={id,action:'queue',task,definition};expect((await f.send(input)).status).toBe(200);
 const inbox=join(f.dir,'requests',id+'.request.json');const proposal=JSON.parse(readFileSync(inbox,'utf8'));
 writeFileSync(inbox+'.accepted',JSON.stringify(proposal));rmSync(inbox);writeFileSync(join(f.root,'packages/router/tasks/new-food.json'),JSON.stringify(definition));rmSync(join(f.root,'.practice/dashboard-controls',id+'.json'));
 expect((await f.send(input)).status).toBe(200);expect(readdirSync(join(f.dir,'requests'))).toHaveLength(1);
 }finally{f.close();}
});
test('queue submission uses the existing inbox, retains state and is idempotent',async()=>{
 const f=fixture();try{const id=randomUUID(),before=readFileSync(join(f.dir,'state.json'),'utf8'),input={id,action:'queue',task:{id:'operator-'+id,kind:'qualify',goal:'wealth',capability:'food',why:'Qualify food supply',dependsOn:[],priority:30,estimatedMs:60000}};
 expect((await f.send(input)).status).toBe(200);expect((await f.send(input)).status).toBe(200);
 expect(readdirSync(join(f.dir,'requests'))).toHaveLength(1);expect(readFileSync(join(f.dir,'state.json'),'utf8')).toBe(before);
 expect((await f.send({...input,task:{...input.task,why:'Changed intent'}})).status).toBe(400);
 const metadata=await(await f.handler(new Request('http://127.0.0.1:3100/api/control'),'127.0.0.1')).json();expect(metadata.requests[0].status).toBe('submitted');expect(metadata.capabilities[0].consumer).toBe('Feed earning accounts');
 }finally{f.close();}
});
test('unknown capabilities, bad dependencies and unqualified live requests write no queue',async()=>{
 const f=fixture();try{for(const extra of [{capability:'missing'},{dependsOn:['missing']},{kind:'run',account:'Worker',launch:'ordinary',accept:{bank:{995:20}}}]){
 const id=randomUUID();expect((await f.send({id,action:'queue',task:{id:'operator-'+id,kind:'qualify',goal:'wealth',capability:'food',why:'Useful supply',dependsOn:[],priority:30,estimatedMs:60000,...extra}})).status).toBe(400);}
 expect(existsSync(join(f.dir,'requests'))).toBe(false);}finally{f.close();}
});
test('pause and resume retain account stops and never resume a stopped fleet',async()=>{
 const f=fixture();try{writeFileSync(join(f.root,'.practice/stop-Worker'),'owner hold');expect((await f.send({id:randomUUID(),action:'pause'})).status).toBe(200);
 expect((await f.send({id:randomUUID(),action:'plan'})).status).toBe(400);
 writeFileSync(join(f.root,'.practice/stop-swarm'),'owner pause');expect((await f.send({id:randomUUID(),action:'resume'})).status).toBe(400);expect(f.starts()).toBe(0);
 rmSync(join(f.root,'.practice/stop-swarm'));expect((await f.send({id:randomUUID(),action:'resume'})).status).toBe(200);expect(f.starts()).toBe(1);expect(readFileSync(join(f.root,'.practice/stop-Worker'),'utf8')).toBe('owner hold');
 }finally{f.close();}
});
