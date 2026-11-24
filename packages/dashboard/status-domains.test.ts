import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isLocalServer} from '../core/src/localserver';
import {resolveFleetDataDir,simStatusDir,statusReadDirs} from '../core/src/practice-paths';
import {priceItemKey} from './item-prices';
import {createVaultItems} from './vault-items';

const server=readFileSync(new URL('./server/state/statuses.ts',import.meta.url),'utf8');
const market=readFileSync(new URL('./server/market.ts',import.meta.url),'utf8');
const configSource=readFileSync(new URL('./server/config.ts',import.meta.url),'utf8');
const transpile=(code:string)=>new Bun.Transpiler({loader:'ts'}).transformSync(code);

function buildReadStatuses(entries:{dir:string;file:string;doc:any;mtime?:number}[],trackFn:(s:any)=>void=()=>{}){
 const code=transpile(server.slice(server.indexOf('function readStatuses()'),server.indexOf('// XP rate samples')));
 const byDir=new Map<string,{file:string;doc:any;mtime:number}[]>();
 const byPath=new Map<string,{doc:any;mtime:number}>();
 for(const e of entries){
  const list=byDir.get(e.dir)??[];
  const mtime=e.mtime??1;
  list.push({file:e.file,doc:e.doc,mtime});
  byDir.set(e.dir,list);
  byPath.set(`${e.dir}/${e.file}`,{doc:e.doc,mtime});
 }
 const statusScans=[...byDir.entries()].map(([dir,list])=>({
  dir,
  scan:Object.assign(()=>({check:list.map(x=>x.file),gone:[]}),{retry(){}}),
 }));
 return new Function('isLocalServer','statusScans','byPath','track',`const statusCache=new Map(),trackedVersions=new Map(),existsSync=p=>byPath.has(p),join=(a,b)=>a+'/'+b,statSync=p=>({mtimeMs:byPath.get(p).mtime}),readFileSync=p=>JSON.stringify(byPath.get(p).doc);${code};return readStatuses;`)(isLocalServer,statusScans,byPath,trackFn) as ()=>Map<string,any>;
}

test('expired practice status is excluded for every supported loopback address',()=>{
 const now=Date.now(),docs=[
  ...['localhost:8888','127.0.0.1:21345','127.1.2.3:8888','[::1]:8888'].map((address,i)=>({name:'Practice'+i,server:address,at:now-31*60_000})),
  {name:'Live',server:'rs-sdk-demo.fly.dev',at:now-31*60_000},
  {name:'Recent',server:'127.0.0.1:21345',at:now},
 ];
 const run=buildReadStatuses(docs.map((doc,i)=>({dir:'status',file:`${i}.json`,doc})));
 expect([...run().keys()]).toEqual(['Live','Recent']);
});

test('readStatuses merges live, legacy and sim status dirs, preferring the newest live row without regressing track()',()=>{
 const now=Date.now(),tracked:any[]=[];
 const run=buildReadStatuses([
  {dir:'.practice/live/status',file:'LiveOnly.json',doc:{name:'LiveOnly',server:'rs-sdk-demo.fly.dev',at:now-500,phase:'live-only'},mtime:20},
  {dir:'.practice/live/status',file:'Both.json',doc:{name:'Both',server:'rs-sdk-demo.fly.dev',at:now-100,phase:'new-live'},mtime:30},
  {dir:'.practice/status',file:'Both.json',doc:{name:'Both',server:'rs-sdk-demo.fly.dev',at:now-5000,phase:'old-legacy'},mtime:10},
  {dir:'.practice/sim/status',file:'SimBot.json',doc:{name:'SimBot',server:'127.0.0.1:21000',at:now-100,phase:'sim'},mtime:15},
 ],doc=>tracked.push({name:doc.name,phase:doc.phase}));
 const out=run();
 expect(out.get('LiveOnly')?.phase).toBe('live-only');
 expect(out.get('Both')?.phase).toBe('new-live');
 expect(out.get('SimBot')?.phase).toBe('sim');
 expect(tracked).toEqual([
  {name:'LiveOnly',phase:'live-only'},
  {name:'Both',phase:'new-live'},
  {name:'SimBot',phase:'sim'},
 ]);
});

test('dashboard server config uses practice-paths live status dirs and resolveFleetDataDir',()=>{
 expect(configSource).toContain('resolveFleetDataDir');
 expect(configSource).toContain('statusReadDirs(root)');
 expect(configSource).toContain('simStatusDir(root)');
 const root=mkdtempSync(join(tmpdir(),'dash-paths-'));
 try{
  mkdirSync(join(root,'.practice','fleet-data','fleet'),{recursive:true});
  expect(join(resolveFleetDataDir(root),'fleet')).toBe(join(root,'.practice','fleet-data','fleet'));
  mkdirSync(join(root,'.practice','live','fleet-data','fleet'),{recursive:true});
  expect(join(resolveFleetDataDir(root),'fleet')).toBe(join(root,'.practice','live','fleet-data','fleet'));
  expect([...new Set([...statusReadDirs(root),simStatusDir(root)])]).toEqual([
   join(root,'.practice','live','status'),
   join(root,'.practice','status'),
   join(root,'.practice','sim','status'),
  ]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('the wealth ledger excludes practice banks on IPv4 and IPv6 loopback',()=>{
 const code=transpile(market.slice(market.indexOf('function vault('),market.indexOf('// ---------- gear catalog')));
 const run=new Function('isLocalServer','createVaultItems','priceItemKey',`const cached=()=>[],FILES={},NL=String.fromCharCode(10),keyName=n=>n.toLowerCase(),BANKER='Banker',priceOf=()=>1,liveAccounts=()=>['Live'],existsSync=()=>false,pricesAt=0;${code};return vault;`)(isLocalServer,createVaultItems,priceItemKey);
 const bots=['rs-sdk-demo.fly.dev','127.0.0.1:21345','[::1]:8888'].map((server,i)=>({name:i?'Practice'+i:'Live',server,at:1,bank:[{name:'Coins',count:100}]}));
 expect(run(bots,Date.now()).coins).toBe(100);
});

test('practice alerts and results use the same server domain as the runtime',()=>{
 const start=server.indexOf('const practiceNames ='),end=server.indexOf('\nexport {',start);
 const run=new Function('isLocalServer',`const statusCache=new Map([['p',{doc:{name:'Practice',server:'127.0.0.1:21345'}}],['l',{doc:{name:'Live',server:'rs-sdk-demo.fly.dev'}}]]);${transpile(server.slice(start,end))};return practiceNames;`)(isLocalServer);
 expect([...run()]).toEqual(['Practice']);
});

test('a malformed status cannot poison the cache and freeze later state builds',()=>{
 const good={name:'Healthy',server:'rs-sdk-demo.fly.dev',at:Date.now(),skills:[]};
 for(const bad of [{name:'Broken',server:'rs-sdk-demo.fly.dev',at:Date.now(),skills:{}},{...good,name:'Broken',skills:[null]},{...good,name:'Broken',inventory:{}},{...good,name:'Broken',server:null},{...good,name:'Broken',at:'tomorrow'},{...good,name:null},{...good,name:'Broken',phase:123}]){
  const run=buildReadStatuses([{dir:'status',file:'0.json',doc:good},{dir:'status',file:'1.json',doc:bad}],s=>(s.skills??[]).reduce((n:number,k:any)=>n+k.xp,0));
  expect([...run().keys()]).toEqual(['Healthy']);
  expect([...run().keys()]).toEqual(['Healthy']);
 }
});

test('readStatuses deduplicates account status winners case-insensitively',()=>{
 const now=Date.now(),tracked:string[]=[];
 const run=buildReadStatuses([
  {dir:'.practice/live/status',file:'worker.json',doc:{name:'worker',server:'rs-sdk-demo.fly.dev',at:now-500,phase:'old'},mtime:10},
  {dir:'.practice/status',file:'Worker.json',doc:{name:'Worker',server:'rs-sdk-demo.fly.dev',at:now-100,phase:'new'},mtime:20},
 ],doc=>tracked.push(doc.phase));
 const out=run();
 expect([...out.entries()].map(([k,v])=>[k,v.phase])).toEqual([['Worker','new']]);
 expect(tracked).toEqual(['new']);
});
