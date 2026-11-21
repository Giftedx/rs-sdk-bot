import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {marketRows,writeMarketCache,MARKET_FILE} from '../core/src/market-cache';
import {buildItemPrices,itemPrice,priceItemKey} from './item-prices';
import {createVaultItems} from './vault-items';
import {isLocalServer} from '../core/src/localserver';
import {gameDialAddress} from '../core/src/websocket-proxy';

const routes=readFileSync(new URL('./server/routes.ts',import.meta.url),'utf8');
const world=readFileSync(new URL('./server/world.ts',import.meta.url),'utf8');
const market=readFileSync(new URL('./server/market.ts',import.meta.url),'utf8');
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const transpile=(source:string)=>new Bun.Transpiler({loader:'ts'}).transformSync(source);

test('the asset route serves the NPC table requested by opponent information',async()=>{
 const start=routes.indexOf("if(url.pathname.startsWith('/client-assets/'))"),end=routes.indexOf("if (url.pathname === '/api/player')",start);
 // Bind the real dashboard directory without importing the long-running server.
 const run=new Function('url','Bun','join','dashboardDir','req',transpile(routes.slice(start,end)));
 const response=run(new URL('http://localhost/client-assets/npc-names.json'),Bun,join,import.meta.dir,new Request('http://localhost/'));
 expect(response.status).toBe(200);expect(Array.isArray(await response.json())).toBe(true);
 expect(run(new URL('http://localhost/client-assets/private.env'),Bun,join,import.meta.dir,new Request('http://localhost/')).status).toBe(400);
});

test('failed rank reads preserve the last observation and have a request deadline',async()=>{
 const code=transpile(world.slice(world.indexOf('let ranksRefreshing'),world.indexOf('function rankDelta(')));
 const previous={at:1,rows:[{board:'Mining',rank:2,level:50,time:'1m'}]},ranks=new Map([['Worker',previous]]);let signal:any;
 const run=new Function('fetch','Bun','ranks','gameDialAddress',`const liveAccounts=()=>['Worker'],remoteNames=()=>[],DEMO='http://example.test',SKILL_BOARDS=[],rankHist=new Map(),FILES={};const hiscoreRows=()=>[],append=()=>{};${code};return refreshRanks;`)(async(_url:any,options:any)=>{signal=options?.signal;return new Response('unavailable',{status:503});},{sleep:async()=>{}},ranks,gameDialAddress);
 await run();expect(ranks.get('Worker')).toEqual(previous);expect(signal).toBeInstanceOf(AbortSignal);
});

test('a failed market page cannot publish fresh prices or partial data',async()=>{
 const code=transpile(market.slice(market.indexOf('async function refreshPrices()'),market.indexOf('const priceOf =')));
 const marketIds=new Map([['old',1]]),marketById=new Map(),prices=new Map([['old',10]]);let calls=0;
 const root=mkdtempSync(join(tmpdir(),'dashboard-market-failure-'));
 try{
  const items=marketRows([{id:1,name:'Old',ask:10,bid:5,sellQuantity:2}]);writeMarketCache(root,items,1);
  const run=new Function('fetch','Bun','marketIds','marketById','prices','marketRows','writeMarketCache','root','buildItemPrices','gameDialAddress',`const DEMO='http://example.test',priceCatalogue=[{id:2,name:'New'}];let pricesAt=1,itemPrices;${code};return async()=>{await refreshPrices();return pricesAt;};`)(async()=>++calls===1?Response.json({total:200,items:[{id:2,name:'New',basePrice:20}]}):Response.json({error:'unavailable'},{status:503}),{sleep:async()=>{}},marketIds,marketById,prices,marketRows,writeMarketCache,root,buildItemPrices,gameDialAddress);
  expect(await run()).toBe(1);expect(calls).toBe(2);expect(prices.has('new')).toBe(false);expect(marketIds.has('new')).toBe(false);
  expect(JSON.parse(readFileSync(join(root,MARKET_FILE),'utf8'))).toEqual({at:1,items});
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('opponent information retries a failed NPC table load',async()=>{
 const code=shell.slice(shell.indexOf('  let npcNames=null'),shell.indexOf("  window.addEventListener('message'",shell.indexOf('  let npcNames=null')));
 const el={hidden:true,innerHTML:''};let calls=0;
 const run=new Function('fetch','asset','hud','window','$','E',`${code};return opponentBox;`)(async(url:any)=>String(url).includes('npc-drops.json')?Response.json({}):++calls===1?new Response('unavailable',{status:503}):Response.json([['Goblin',2]]),(s:string)=>s,{querySelector:()=>el},{},()=>null,String);
 await run({kind:'npc',type:0,hp:[3,5]});await run({kind:'npc',type:0,hp:[2,5]});
 expect(calls).toBe(2);expect(el.innerHTML).toContain('Goblin');
});

test('slow rank refreshes cannot overlap on the minute timer',async()=>{
 const start=world.indexOf('let ranksRefreshing');
 const code=transpile(world.slice(start<0?world.indexOf('async function refreshRanks()'):start,world.indexOf('function rankDelta(')));
 let calls=0,release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
 const run=new Function('fetch','Bun','gameDialAddress',`const liveAccounts=()=>['Worker'],remoteNames=()=>[],ranks=new Map(),DEMO='http://example.test',SKILL_BOARDS=[],rankHist=new Map(),FILES={};const hiscoreRows=()=>[],append=()=>{};${code};return refreshRanks;`)(async()=>{calls++;await pending;return new Response('unavailable',{status:503});},{sleep:async()=>{}},gameDialAddress);
 const first=run(),second=run();release();await Promise.all([first,second]);expect(calls).toBe(1);
});

test('a complete market refresh replaces removed listings and publishes its timestamp',async()=>{
 const code=transpile(market.slice(market.indexOf('async function refreshPrices()'),market.indexOf('const priceOf =')));
 const marketIds=new Map([['old',1]]),marketById=new Map([[1,{}]]),prices=new Map([['old',10]]);
 const root=mkdtempSync(join(tmpdir(),'dashboard-market-success-'));
 try{
  const row={id:2,name:'New',basePrice:20,vwap:999,trades:1,ask:20,bid:15,sellQuantity:0,buyQuantity:3};
  const run=new Function('fetch','Bun','marketIds','marketById','prices','marketRows','writeMarketCache','root','buildItemPrices','gameDialAddress',`const DEMO='http://example.test',priceCatalogue=[{id:2,name:'New'}];let pricesAt=1,itemPrices;${code};return async()=>{await refreshPrices();return pricesAt;};`)(async()=>Response.json({total:1,items:[row]}),{sleep:async()=>{}},marketIds,marketById,prices,marketRows,writeMarketCache,root,buildItemPrices,gameDialAddress);
  const at=await run();expect(at).toBeGreaterThan(1);expect([...prices]).toEqual([['new',20]]);expect([...marketIds]).toEqual([['new',2]]);expect(marketById.has(1)).toBe(false);
  expect(JSON.parse(readFileSync(join(root,MARKET_FILE),'utf8'))).toEqual({at,items:marketRows([row])});
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('a shared-cache write failure does not hide a successful dashboard market refresh',async()=>{
 const code=transpile(market.slice(market.indexOf('async function refreshPrices()'),market.indexOf('const priceOf =')));
 const marketIds=new Map(),marketById=new Map(),prices=new Map();let writes=0;
 const run=new Function('fetch','Bun','marketIds','marketById','prices','marketRows','writeMarketCache','root','buildItemPrices','gameDialAddress',`const DEMO='http://example.test',priceCatalogue=[{id:2,name:'New'}];let pricesAt=1,itemPrices;${code};return async()=>{await refreshPrices();return pricesAt;};`)(async()=>Response.json({total:1,items:[{id:2,name:'New',basePrice:20}]}),{sleep:async()=>{}},marketIds,marketById,prices,marketRows,()=>{writes++;throw Error('read-only cache');},'/unused',buildItemPrices,gameDialAddress);
 expect(await run()).toBeGreaterThan(1);expect(writes).toBe(1);expect([...prices]).toEqual([['new',20]]);
});

test('the complete dashboard scrape publishes exact variant values without a last-name alias',async()=>{
 const code=transpile(market.slice(market.indexOf('async function refreshPrices()'),market.indexOf('const priceOf =')));
 const rows=[{id:1135,name:'Dragonhide body',basePrice:7800,ask:8000},{id:2503,name:'Dragonhide body',basePrice:13480,vwap:15000,trades:3,ask:16000}];
 const run=new Function('fetch','Bun','marketRows','buildItemPrices','priceCatalogue','gameDialAddress',`const DEMO='http://example.test',root='',marketIds=new Map(),marketById=new Map(),prices=new Map(),writeMarketCache=()=>{};let pricesAt=1,itemPrices;${code};return async()=>{await refreshPrices();return {itemPrices,prices};};`)
  (async()=>Response.json({total:2,items:rows}),{sleep:async()=>{}},marketRows,buildItemPrices,rows,gameDialAddress);
 const result=await run();expect(result.itemPrices.byId[1135]).toMatchObject({value:7800,ask:8000});expect(result.itemPrices.byId[2503]).toMatchObject({value:15000,ask:16000});
 expect(result.itemPrices.byName['dragonhide body']).toBeUndefined();expect(result.prices.has('dragonhide body')).toBe(false);
});

test('the exact ID and alias tables replace together only after a complete market scrape',async()=>{
 const code=transpile(market.slice(market.indexOf('async function refreshPrices()'),market.indexOf('const priceOf =')));
 const previous=buildItemPrices([{id:1,name:'Old',basePrice:10}],[{id:1,name:'Old'}]);
 let fail=true,calls=0;
 const run=new Function('fetch','Bun','marketRows','buildItemPrices','previous','gameDialAddress',`const DEMO='http://example.test',root='',marketIds=new Map(),marketById=new Map(),prices=new Map(),writeMarketCache=()=>{},priceCatalogue=[{id:2,name:'New'}];let pricesAt=1,itemPrices=previous;${code};return async()=>{await refreshPrices();return itemPrices;};`)
  (async()=>++calls%2===1?Response.json({total:200,items:[{id:2,name:'New',basePrice:20}]}):fail?new Response('',{status:503}):Response.json({total:200,items:[]}),{sleep:async()=>{}},marketRows,buildItemPrices,previous,gameDialAddress);
 expect(await run()).toBe(previous);expect(previous.byId[1]?.value).toBe(10);expect(previous.byName.old?.value).toBe(10);
 fail=false;const next=await run();expect(next.byId[1]).toBeUndefined();expect(next.byName.old).toBeUndefined();expect(next.byId[2]?.value).toBe(20);expect(next.byName.new?.value).toBe(20);
});

test('vault valuation retains exact variants and marks historical name-only outgoing stock unconfirmed',()=>{
 const code=transpile(market.slice(market.indexOf('function vault('),market.indexOf('// ---------- gear catalog')));
 const table=buildItemPrices([{id:1135,name:'Dragonhide body',basePrice:7800},{id:2503,name:'Dragonhide body',basePrice:13480}],
  [{id:1135,name:'Dragonhide body'},{id:2503,name:'Dragonhide body'}]);
 const log:any[]=[];
 const vault=new Function('isLocalServer','createVaultItems','priceItemKey','priceOf','log',`const cached=()=>log,FILES={},NL='\\n',keyName=n=>n.toLowerCase(),BANKER='Banker',liveAccounts=()=>['Worker','Receiver'],existsSync=()=>true,pricesAt=1;${code};return vault;`)
  (isLocalServer,createVaultItems,priceItemKey,(i:any)=>itemPrice(table,i)?.value??null,log);
 const bots=[{name:'Worker',server:'rs-sdk-demo.fly.dev',at:1,inventory:[],bank:[{id:1135,name:'Dragonhide body',count:4},{id:2504,baseId:2503,name:'Dragonhide body (noted)',count:2},{id:-1,name:'Coins',count:100}]}];
 const exact=vault(bots,4);expect(exact.value).toBe(4*7800+2*13480);expect(exact.items.map((i:any)=>i.id).sort((a:number,b:number)=>a-b)).toEqual([-1,1135,2504]);expect(exact.coins).toBe(0);expect(exact.unpriced).toBe(1);expect(exact.valueComplete).toBe(false);
 log.push({at:2,from:'Worker',to:'Receiver',items:[{name:'Dragonhide body',count:3}]});
 const uncertain=vault(bots,4),owner=uncertain.holders.find((h:any)=>h.name==='Worker');
 expect(owner.items.find((i:any)=>i.name==='Dragonhide body')).toEqual({name:'Dragonhide body',count:3,unconfirmed:true});
 expect(owner.value).toBe(0);expect(owner.valueComplete).toBe(false);expect(owner.countsComplete).toBe(false);
 expect(uncertain.value).toBe(0);expect(uncertain.valueComplete).toBe(false);expect(uncertain.log[0]).toEqual(log[0]);expect(uncertain.flow[0].items[0]).toEqual(log[0].items[0]);
});

test('market holdings keep different item IDs with the same display name separate',()=>{
 const identity=shell.slice(shell.indexOf('  const priceName='),shell.indexOf('  function price(item)'));
 const code=shell.slice(shell.indexOf('  function gePanel(){'),shell.indexOf('  // Pull requests plugin'));
 const state:any={bots:[{bank:[{id:200,baseId:199,name:'Herb (noted)',count:2},{id:201,name:'Herb',count:9}]}],economy:{supplies:[{id:199,name:'Herb',ask:1},{id:201,name:'Herb',ask:2}]}};
 const run=new Function('S','window','E','nf','icon',`${identity}\nlet geQuery='',geAll=true,geLimit=80,geOpen=null;const age=()=>'';${code};return gePanel();`);
 const result=run(state,{atlasOperator:()=>true},String,String,()=>'<i/>');
 expect(result).toContain('class="ge-ours">2<');expect(result).toContain('class="ge-ours">9<');expect(result).not.toContain('class="ge-ours">11<');
 state.bots[0].bank=[{name:'Herb',count:4}];expect(run(state,{atlasOperator:()=>true},String,String,()=>'<i/>')).toContain('class="ge-ours">?<');
});

test('the asset route serves the item effect table that the item tooltip reads',()=>{
 const start=routes.indexOf("if(url.pathname.startsWith('/client-assets/'))"),end=routes.indexOf("if (url.pathname === '/api/player')",start);
 const run=new Function('url','Bun','join','dashboardDir','req',transpile(routes.slice(start,end)));
 const first=run(new URL('http://localhost/client-assets/item-stats.json'),Bun,join,import.meta.dir,new Request('http://localhost/'));
 expect(first.status).toBe(200);expect(first.headers.get('cache-control')).toBe('no-cache');
 // The same ETag back gets a 304 with no body; an image keeps the hour.
 const again=run(new URL('http://localhost/client-assets/item-stats.json'),Bun,join,import.meta.dir,new Request('http://localhost/',{headers:{'if-none-match':first.headers.get('etag')!}}));
 expect(again.status).toBe(304);
 expect(run(new URL('http://localhost/client-assets/runelite.png'),Bun,join,import.meta.dir,new Request('http://localhost/')).headers.get('cache-control')).toBe('public,max-age=3600');
});

test('the rank change of a day starts from the rank held 24 hours ago',()=>{
 const code=transpile(world.slice(world.indexOf('function rankDelta('),world.indexOf('// Live #1 per skill board')));
 const now=Date.now(),hour=3_600_000,rankHist=new Map<string,any[]>();
 const rankDelta=new Function('rankHist',`${code};return rankDelta;`)(rankHist);
 rankHist.set('A|Mining',[{at:now-72*hour,rank:50},{at:now-hour,rank:40}]);
 expect(rankDelta('A','Mining').delta).toBe(10);
 rankHist.set('B|Mining',[{at:now-72*hour,rank:50},{at:now-48*hour,rank:40}]);
 expect(rankDelta('B','Mining').delta).toBe(0);
});
