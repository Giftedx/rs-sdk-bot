// Browser integration fixture. Uses production UI/control code and an isolated inbox.
// It accepts tasks but never runs a model, registers an account or sends game input.
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync,copyFileSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createOperatorControl} from './operator-control';
import {initialState,addTasks} from '../router/src/coordinator';
import {atomicJson,spawnDetached} from '../router/src/coordinator-store';
import {coordinationView} from './coordination';
const project=resolve(import.meta.dir,'../..'),root=resolve(process.argv[3]??join(project,'.practice/osrs-client/control-fixture'));
const directory=join(root,'.practice/coordinator'),read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
if(process.argv[2]==='--child'){
 mkdirSync(directory,{recursive:true});atomicJson(join(directory,'owner.json'),{pid:process.pid,nonce:'fixture',at:Date.now()});
 while(!existsSync(join(root,'.practice/stop-coordinator'))){
  const inbox=join(directory,'requests');mkdirSync(inbox,{recursive:true});
  for(const file of readdirSync(inbox).filter(n=>n.endsWith('.request.json'))){const path=join(inbox,file);try{
   const proposal=read(path),state=read(join(directory,'state.json'));addTasks(state,proposal.tasks);
   for(const definition of proposal.capabilities)atomicJson(join(root,'packages/router/tasks',definition.id+'.json'),definition);
   atomicJson(join(directory,'state.json'),state);renameSync(path,path+'.accepted');
  }catch(error){writeFileSync(path+'.error',String(error));renameSync(path,path+'.rejected');}}
  if(existsSync(join(directory,'plan-request'))){renameSync(join(directory,'plan-request'),join(directory,'plan-observed'));}
  await Bun.sleep(150);
 }
 writeFileSync(join(directory,'stopped'),'fixture coordinator exited');
}else{
 mkdirSync(directory,{recursive:true});mkdirSync(join(root,'packages/router/tasks'),{recursive:true});
 mkdirSync(join(root,'vendor/rs-sdk/bots/Bigpackage'),{recursive:true});
 for(const file of readdirSync(join(project,'packages/router/tasks')).filter(n=>n.endsWith('.json')))copyFileSync(join(project,'packages/router/tasks',file),join(root,'packages/router/tasks',file));
 writeFileSync(join(root,'swarm.json'),JSON.stringify({coordination:{enabled:true}}));
 if(!existsSync(join(directory,'state.json'))){const state=initialState();addTasks(state,[{id:'fixture-native-wine',kind:'qualify',goal:'skills',capability:'wine-order',dependsOn:[],priority:30,estimatedMs:60000,why:'Isolated UI qualification dependency; no game proof'}]);state.tasks[0]!.status='succeeded';state.tasks[0]!.receipt={taskId:'fixture-native-wine',runId:'fixture',at:Date.now(),ok:true,output:{evidence:'native',delivery:{ok:true,id:'wine-order',source:'fixture-only'}}};atomicJson(join(directory,'state.json'),state);}
 const child=()=>spawnDetached([process.execPath,import.meta.path,'--child',root],project,join(directory,'child.out.log'),join(directory,'child.err.log'));
 const controls=createOperatorControl({root,spawn:(()=>child()) as any});
 if(!existsSync(join(root,'.practice/stop-coordinator')))child();
 async function state(){const live=await(await fetch('http://127.0.0.1:3100/api/state')).json();live.now=Date.now();live.coordination=coordinationView(read(join(directory,'state.json')),Date.now(),Date.now(),existsSync(join(root,'.practice/stop-coordinator')));return live;}
 const server=Bun.serve({hostname:'127.0.0.1',port:3101,idleTimeout:0,async fetch(req,host){
  const url=new URL(req.url);if(url.pathname==='/api/control')return controls(req,host.requestIP(req)?.address??'');
  if(url.pathname==='/api/state')return Response.json(await state());
  if(url.pathname==='/events'){let timer:any;return new Response(new ReadableStream({start(c){const emit=async()=>{try{c.enqueue('data: '+JSON.stringify(await state())+'\n\n');}catch{clearInterval(timer);}};void emit();timer=setInterval(emit,1500);},cancel(){clearInterval(timer);}}),{headers:{'content-type':'text/event-stream'}});}
  if(req.method!=='GET')return new Response('Fixture accepts commands only through /api/control',{status:405});
  const response=await fetch('http://127.0.0.1:3100'+url.pathname+url.search);
  if(url.pathname==='/'){const html=(await response.text()).replace('</head>','<style>.client-title:after{content:"CONTROL TEST FIXTURE · NO GAME ACTIONS";color:#eeb665;font:10px Tahoma;margin-left:8px}</style></head>');return new Response(html,{headers:response.headers});}
  return new Response(response.body,{status:response.status,headers:response.headers});
 }});console.log(JSON.stringify({url:'http://127.0.0.1:'+server.port,root,pid:process.pid}));
}
