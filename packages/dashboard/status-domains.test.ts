import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {isLocalServer} from '../core/src/localserver';

const server=readFileSync(new URL('./server.ts',import.meta.url),'utf8');
const transpile=(code:string)=>new Bun.Transpiler({loader:'ts'}).transformSync(code);

test('expired practice status is excluded for every supported loopback address',()=>{
 const code=transpile(server.slice(server.indexOf('function readStatuses()'),server.indexOf('// XP rate samples')));
 const now=Date.now(),docs=[
  ...['localhost:8888','127.0.0.1:21345','127.1.2.3:8888','[::1]:8888'].map((address,i)=>({name:'Practice'+i,server:address,at:now-31*60_000})),
  {name:'Live',server:'rs-sdk-demo.fly.dev',at:now-31*60_000},
  {name:'Recent',server:'127.0.0.1:21345',at:now},
 ];
 const run=new Function('isLocalServer','docs',`const statusDir='',statusCache=new Map(),existsSync=()=>true,readdirSync=()=>docs.map((_,i)=>i+'.json'),join=(_a,b)=>b,statSync=()=>({mtimeMs:1}),readFileSync=p=>JSON.stringify(docs[Number(p.split('.')[0])]),track=()=>{};${code};return readStatuses;`)(isLocalServer,docs);
 expect([...run().keys()]).toEqual(['Live','Recent']);
});

test('the wealth ledger excludes practice banks on IPv4 and IPv6 loopback',()=>{
 const code=transpile(server.slice(server.indexOf('function vault('),server.indexOf('// ---------- swarm controller')));
 const run=new Function('isLocalServer',`const cached=()=>[],FILES={},NL=String.fromCharCode(10),keyName=n=>n.toLowerCase(),BANKER='Banker',priceOf=()=>1,liveAccounts=()=>['Live'],existsSync=()=>false,pricesAt=0;${code};return vault;`)(isLocalServer);
 const bots=['rs-sdk-demo.fly.dev','127.0.0.1:21345','[::1]:8888'].map((server,i)=>({name:i?'Practice'+i:'Live',server,at:1,bank:[{name:'Coins',count:100}]}));
 expect(run(bots,Date.now()).coins).toBe(100);
});

test('practice alerts and results use the same server domain as the runtime',()=>{
 const start=server.indexOf('const practiceNames ='),end=server.indexOf('function alerts(',start);
 const run=new Function('isLocalServer',`const statusCache=new Map([['p',{doc:{name:'Practice',server:'127.0.0.1:21345'}}],['l',{doc:{name:'Live',server:'rs-sdk-demo.fly.dev'}}]]);${transpile(server.slice(start,end))};return practiceNames;`)(isLocalServer);
 expect([...run()]).toEqual(['Practice']);
});

test('a malformed status cannot poison the cache and freeze later state builds',()=>{
 const code=transpile(server.slice(server.indexOf('function readStatuses()'),server.indexOf('// XP rate samples')));
 const good={name:'Healthy',server:'rs-sdk-demo.fly.dev',at:Date.now(),skills:[]};
 for(const bad of [{name:'Broken',server:'rs-sdk-demo.fly.dev',at:Date.now(),skills:{}},{...good,name:'Broken',skills:[null]},{...good,name:'Broken',inventory:{}},{...good,name:'Broken',server:null},{...good,name:'Broken',at:'tomorrow'},{...good,name:null},{...good,name:'Broken',phase:123}]){
  const run=new Function('isLocalServer','docs',`const statusDir='',statusCache=new Map(),existsSync=()=>true,readdirSync=()=>docs.map((_,i)=>i+'.json'),join=(_a,b)=>b,statSync=()=>({mtimeMs:1}),readFileSync=p=>JSON.stringify(docs[Number(p.split('.')[0])]),track=s=>(s.skills??[]).reduce((n,k)=>n+k.xp,0);${code};return readStatuses;`)(isLocalServer,[good,bad]);
  expect([...run().keys()]).toEqual(['Healthy']);
  expect([...run().keys()]).toEqual(['Healthy']);
 }
});
