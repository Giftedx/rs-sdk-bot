import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const server=readFileSync(new URL('./server.ts',import.meta.url),'utf8');
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const transpile=(source:string)=>new Bun.Transpiler({loader:'ts'}).transformSync(source);

test('the asset route serves the NPC table requested by opponent information',async()=>{
 const start=server.indexOf("if(url.pathname.startsWith('/client-assets/'))"),end=server.indexOf("if (url.pathname === '/api/player')",start);
 // Bind the real dashboard directory without importing the long-running server.
 const run=new Function('url','Bun','join','BASE',transpile(server.slice(start,end)).replaceAll('import.meta.dir','BASE'));
 const response=run(new URL('http://localhost/client-assets/npc-names.json'),Bun,join,import.meta.dir);
 expect(response.status).toBe(200);expect(Array.isArray(await response.json())).toBe(true);
 expect(run(new URL('http://localhost/client-assets/private.env'),Bun,join,import.meta.dir).status).toBe(400);
});

test('failed rank reads preserve the last observation and have a request deadline',async()=>{
 const code=transpile(server.slice(server.indexOf('let ranksRefreshing'),server.indexOf('setInterval(() => void refreshRanks()')));
 const previous={at:1,rows:[{board:'Mining',rank:2,level:50,time:'1m'}]},ranks=new Map([['Worker',previous]]);let signal:any;
 const run=new Function('fetch','Bun','ranks',`const liveAccounts=()=>['Worker'],remoteNames=()=>[],DEMO='http://example.test',SKILL_BOARDS=[],rankHist=new Map(),FILES={};const hiscoreRows=()=>[],append=()=>{};${code};return refreshRanks;`)(async(_url:any,options:any)=>{signal=options?.signal;return new Response('unavailable',{status:503});},{sleep:async()=>{}},ranks);
 await run();expect(ranks.get('Worker')).toEqual(previous);expect(signal).toBeInstanceOf(AbortSignal);
});

test('a failed market page cannot publish fresh prices or partial data',async()=>{
 const code=transpile(server.slice(server.indexOf('async function refreshPrices()'),server.indexOf('setInterval(() => void refreshPrices()')));
 const marketIds=new Map([['old',1]]),marketById=new Map(),prices=new Map([['old',10]]);let calls=0;
 const run=new Function('fetch','Bun','marketIds','marketById','prices',`const DEMO='http://example.test';let pricesAt=1;${code};return async()=>{await refreshPrices();return pricesAt;};`)(async()=>++calls===1?Response.json({total:200,items:[{id:2,name:'New',basePrice:20}]}):Response.json({error:'unavailable'},{status:503}),{sleep:async()=>{}},marketIds,marketById,prices);
 expect(await run()).toBe(1);expect(prices.has('new')).toBe(false);expect(marketIds.has('new')).toBe(false);
});

test('opponent information retries a failed NPC table load',async()=>{
 const code=shell.slice(shell.indexOf('  let npcNames=null'),shell.indexOf("  window.addEventListener('message'",shell.indexOf('  let npcNames=null')));
 const el={hidden:true,innerHTML:''};let calls=0;
 const run=new Function('fetch','asset','hud','window','$','E',`${code};return opponentBox;`)(async()=>++calls===1?new Response('unavailable',{status:503}):Response.json([['Goblin',2]]),(s:string)=>s,{querySelector:()=>el},{},()=>null,String);
 await run({kind:'npc',type:0,hp:[3,5]});await run({kind:'npc',type:0,hp:[2,5]});
 expect(calls).toBe(2);expect(el.innerHTML).toContain('Goblin');
});

test('slow rank refreshes cannot overlap on the minute timer',async()=>{
 const start=server.indexOf('let ranksRefreshing');
 const code=transpile(server.slice(start<0?server.indexOf('async function refreshRanks()'):start,server.indexOf('setInterval(() => void refreshRanks()')));
 let calls=0,release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
 const run=new Function('fetch','Bun',`const liveAccounts=()=>['Worker'],remoteNames=()=>[],ranks=new Map(),DEMO='http://example.test',SKILL_BOARDS=[],rankHist=new Map(),FILES={};const hiscoreRows=()=>[],append=()=>{};${code};return refreshRanks;`)(async()=>{calls++;await pending;return new Response('unavailable',{status:503});},{sleep:async()=>{}});
 const first=run(),second=run();release();await Promise.all([first,second]);expect(calls).toBe(1);
});

test('a complete market refresh replaces removed listings and publishes its timestamp',async()=>{
 const code=transpile(server.slice(server.indexOf('async function refreshPrices()'),server.indexOf('setInterval(() => void refreshPrices()')));
 const marketIds=new Map([['old',1]]),marketById=new Map([[1,{}]]),prices=new Map([['old',10]]);
 const run=new Function('fetch','Bun','marketIds','marketById','prices',`const DEMO='http://example.test';let pricesAt=1;${code};return async()=>{await refreshPrices();return pricesAt;};`)(async()=>Response.json({total:1,items:[{id:2,name:'New',basePrice:20}]}),{sleep:async()=>{}},marketIds,marketById,prices);
 expect(await run()).toBeGreaterThan(1);expect([...prices]).toEqual([['new',20]]);expect([...marketIds]).toEqual([['new',2]]);expect(marketById.has(1)).toBe(false);
});

test('market holdings keep different item IDs with the same display name separate',()=>{
 const code=shell.slice(shell.indexOf('  function gePanel(){'),shell.indexOf('  // Pull requests plugin'));
 const state:any={bots:[{bank:[{id:200,baseId:199,name:'Herb (noted)',count:2},{id:201,name:'Herb',count:9}]}],economy:{supplies:[{id:199,name:'Herb',ask:1},{id:201,name:'Herb',ask:2}]}};
 const run=new Function('S','window','E','nf','icon',`let geQuery='',geAll=true,geOpen=null;const age=()=>'';${code};return gePanel();`);
 const result=run(state,{atlasOperator:()=>true},String,String,()=>'<i/>');
 expect(result).toContain('class="ge-ours">2<');expect(result).toContain('class="ge-ours">9<');expect(result).not.toContain('class="ge-ours">11<');
 state.bots[0].bank=[{name:'Herb',count:4}];expect(run(state,{atlasOperator:()=>true},String,String,()=>'<i/>')).toContain('class="ge-ours">?<');
});

test('the asset route serves the item effect table that the item tooltip reads',()=>{
 const start=server.indexOf("if(url.pathname.startsWith('/client-assets/'))"),end=server.indexOf("if (url.pathname === '/api/player')",start);
 const run=new Function('url','Bun','join','BASE',transpile(server.slice(start,end)).replaceAll('import.meta.dir','BASE'));
 expect(run(new URL('http://localhost/client-assets/item-stats.json'),Bun,join,import.meta.dir).status).toBe(200);
});

test('the rank change of a day starts from the rank held 24 hours ago',()=>{
 const code=transpile(server.slice(server.indexOf('function rankDelta('),server.indexOf('// Live #1 per skill board')));
 const now=Date.now(),hour=3_600_000,rankHist=new Map<string,any[]>();
 const rankDelta=new Function('rankHist',`${code};return rankDelta;`)(rankHist);
 rankHist.set('A|Mining',[{at:now-72*hour,rank:50},{at:now-hour,rank:40}]);
 expect(rankDelta('A','Mining').delta).toBe(10);
 rankHist.set('B|Mining',[{at:now-72*hour,rank:50},{at:now-48*hour,rank:40}]);
 expect(rankDelta('B','Mining').delta).toBe(0);
});
