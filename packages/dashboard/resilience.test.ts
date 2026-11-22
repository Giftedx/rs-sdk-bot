import {expect,test} from 'bun:test';
import {readdirSync,readFileSync} from 'node:fs';
import {gameDialAddress} from '../core/src/websocket-proxy';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const server=readFileSync(new URL('./server/state/runtime.ts',import.meta.url),'utf8');
const world=readFileSync(new URL('./server/world.ts',import.meta.url),'utf8');

test('stream loss and collector errors reach the visible title indicator without another render',()=>{
 const code=html.slice(html.indexOf('function connectionState(){'),html.indexOf("$('#inspector').addEventListener"));
 for(const [connected,state,expected] of [[false,{},'FROZEN'],[true,{stateError:'unavailable'},'STATE ERROR']] as const){
  const hidden={textContent:'',className:'',title:''},visible={textContent:'● LIVE',className:'connection',title:''};
  new Function('connected','lastReceived','S','document','$',code+';connectionState();')(connected,Date.now(),state,{body:{classList:{toggle:()=>{}}},querySelector:()=>visible},()=>hidden);
  expect(visible.textContent).toBe(expected);expect(visible.className).toContain('warning-state');
 }
});

test('a chosen account cannot be replaced by another account when its snapshot disappears',()=>{
 const code=html.slice(html.indexOf('function render(){'),html.indexOf(" $('#pause').textContent"));
 const choose=new Function('S','window','picked','sel',`const liveBots=()=>S.bots;${code}};render();return sel;`);
 const state={bots:[{name:'Other',operation:'observed'}]};
 expect(choose(state,{},true,'Chosen')).toBe('Chosen');
 expect(choose(state,{},false,null)).toBe('Other');
 expect(choose(state,{atlasFreeCamera:true},false,null)).toBeNull();
});

test('map HTTP errors and truncated bodies stay retryable instead of becoming cached map pixels',async()=>{
 const code=html.slice(html.indexOf('async function loadMap(){'),html.indexOf('function drawMap(){'));
 for(const response of [()=>new Response('building',{status:503}),()=>new Response(new Uint8Array([1]))]){
  let calls=0,draws=0;
  const run=new Function('fetch','document','Image','drawMap',`let MAPI=null;const S={map:{ready:true,w:2,h:2}};${code};return {loadMap,value:()=>MAPI};`)(async()=>{calls++;return response();},{createElement:()=>({getContext:()=>({createImageData:()=>({data:new Uint8Array(16)}),putImageData:()=>{}})})},class{},()=>draws++);
  await run.loadMap();await run.loadMap();expect(calls).toBe(2);expect(run.value()).toBeNull();expect(draws).toBe(0);
 }
});

test('the visible observations bar cannot label a failed state build live',()=>{
 const source=readFileSync(new URL('./operations.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf(' function statusBar(){'),source.indexOf(' const oldRender=render;'));
 const status={innerHTML:'',classList:{toggle:()=>{}}};
 new Function('S','status','E','age',`${code};statusBar();`)({now:Date.now(),stateError:'state unavailable'},status,String,String);
 expect(status.innerHTML).toContain('State error');expect(status.innerHTML).not.toContain('Observations live');
});

test('a delivered state whose clock is far behind reads FROZEN, not LIVE',()=>{
 const code=html.slice(html.indexOf('function connectionState(){'),html.indexOf("$('#inspector').addEventListener"));
 const hidden={textContent:'',className:'',title:''},visible={textContent:'',className:'connection',title:''};
 new Function('connected','lastReceived','S','document','$',code+';connectionState();')(true,Date.now(),{now:Date.now()-20*60000},{body:{classList:{toggle:()=>{}}},querySelector:()=>visible},()=>hidden);
 expect(visible.textContent).toBe('FROZEN');
});

test('the hosted page labels a published file as a snapshot and gives its real age',()=>{
 const source=readFileSync(new URL('./operations.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf(' function statusBar(){'),source.indexOf(' const oldRender=render;'));
 const status={innerHTML:'',classList:{toggle:()=>{}}},now=Date.now();
 new Function('S','status','E','age',`${code};statusBar();`)({now,hostedAge:420000},status,String,(t:number)=>String(now-t));
 expect(status.innerHTML).toContain('Published snapshot');expect(status.innerHTML).toContain('420000 old');
});

test('an account in the world whose last action is idle reads idle, not playing',()=>{
 const line=html.split('\n').find(l=>l.includes('const st=b=>'))!;
 const st=new Function(line.trim()+';return st;')();
 expect(st({inWorld:true,fresh:true,action:'idle'})).toEqual(['wd','idle']);
 expect(st({inWorld:true,fresh:true,action:'xp'})).toEqual(['on','playing']);
});

test('state-build failures keep retained data private even when an exception names the protected account',()=>{
 const code=server.slice(server.indexOf('function current() {'),server.indexOf('// ---------- SSE broadcast',server.indexOf('function current() {')));
 const run=new Function('buildState','console',`const SECRET_RE=/Haggis/gi,SECRET_MARK='⟦MAIN⟧',MAP={};let latest={at:0,json:''};${code};return current;`)(()=>{throw Error('Haggis invalid status');},{error:()=>{}});
 expect(run()).not.toMatch(/haggis/i);expect(JSON.parse(run()).stateError).toContain('⟦MAIN⟧');
});

function playerLookupHarness(fetcher:(url:string,init?:RequestInit)=>Promise<Response>,sleep:(ms:number)=>Promise<void>=async()=>{}){
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(world.slice(world.indexOf('let lookupChain:'),world.indexOf('// Equipment, Bank and Runite boards:')));
 let round!:()=>void,period=0;
 const api=new Function('fetch','Bun','gameDialAddress','setInterval',`const lookups=new Map(),roster=new Map(),DEMO='https://example.test',ONLINE_MS=30000,SKILL_BOARDS=[];const hiscoreRows=()=>[{board:'Mining'}],wornOf=async()=>null;${code};return {lookup:lookupPlayer,cache:lookups,wanted:names=>{lookupWanted=names;}};`)(fetcher,{sleep},gameDialAddress,(fn:()=>void,ms:number)=>{round=fn;period=ms;});
 return {...api,round,period};
}
function lookupGate<T>(){
 let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};
}

test('an upstream player service failure is not cached as an unranked player for thirty minutes',async()=>{
 let calls=0;const {lookup}=playerLookupHarness(async()=>++calls===1?new Response('unavailable',{status:503}):new Response('player rows'));
 expect(await lookup('Worker')).toBeNull();expect((await lookup('Worker')).rows).toEqual([{board:'Mining'}]);expect(calls).toBe(2);
});

for(const failure of ['503','exception'])test('concurrent case-folded player lookups share an uncached '+failure+' and allow a later retry',async()=>{
 const gate=lookupGate<Response>();let calls=0;
 const h=playerLookupHarness(async()=>++calls===1?gate.promise:new Response('player rows'));
 const first=h.lookup('Worker'),same=h.lookup('wOrKeR'),shared=first===same;
 if(failure==='503')gate.resolve(new Response('unavailable',{status:503}));else gate.reject(Error('upstream unavailable'));
 const results=await Promise.all([first,same]);
 expect(shared).toBe(true);expect(results).toEqual([null,null]);expect(calls).toBe(1);expect(h.cache.has('worker')).toBe(false);
 const retried=await h.lookup('WORKER');expect(retried.rows).toEqual([{board:'Mining'}]);expect(calls).toBe(2);expect(h.cache.get('worker')).toBe(retried);
});

test('distinct player lookups stay serial through cooldown while a fresh hit bypasses pending work',async()=>{
 const firstReply=lookupGate<Response>(),cooldowns:ReturnType<typeof lookupGate<void>>[]=[],waits:number[]=[],calls:string[]=[];
 let releaseAll=false;
 const h=playerLookupHarness(async url=>{calls.push(new URL(url).pathname.split('/').at(-1)!);return calls.length===1?firstReply.promise:new Response('player rows');},async ms=>{
  waits.push(ms);if(releaseAll)return;const gate=lookupGate<void>();cooldowns.push(gate);await gate.promise;
 });
 const first=h.lookup('First'),second=h.lookup('Second');
 try{
  await Bun.sleep(0);expect(calls).toEqual(['first']);
  firstReply.resolve(new Response('player rows'));await Bun.sleep(0);
  expect(waits).toEqual([1200]);expect(calls).toEqual(['first']);
  let fresh:any=null;const hit=h.lookup('FIRST').then((value:any)=>{fresh=value;});await Bun.sleep(0);
  expect(fresh?.rows).toEqual([{board:'Mining'}]);expect(fresh).toBe(h.cache.get('first'));
  cooldowns[0].resolve(undefined);await first;await hit;await Bun.sleep(0);
  expect(calls).toEqual(['first','second']);expect(waits).toEqual([1200,1200]);
  cooldowns[1].resolve(undefined);expect((await second).rows).toEqual([{board:'Mining'}]);
 }finally{
  releaseAll=true;firstReply.resolve(new Response('player rows'));for(const gate of cooldowns)gate.resolve(undefined);await Promise.allSettled([first,second]);
 }
});

test('the state carries no lookups and the server has no background lookup round',()=>{
 const stateParts=readdirSync(new URL('./server/state/',import.meta.url)).filter(f=>f.endsWith('.ts')).sort().map(f=>readFileSync(new URL('./server/state/'+f,import.meta.url),'utf8'));
 for(const src of [readFileSync(new URL('./server/state.ts',import.meta.url),'utf8'),...stateParts,world,readFileSync(new URL('./server.ts',import.meta.url),'utf8'),readFileSync(new URL('./server/routes.ts',import.meta.url),'utf8')]){expect(src).not.toContain('lookupWanted');expect(src).not.toContain('lookups: looked');}
});

test('an upstream 404 remains a cached unranked lookup with the same cooldown',async()=>{
 let calls=0;const waits:number[]=[],h=playerLookupHarness(async()=>{calls++;return new Response('not found',{status:404});},async ms=>{waits.push(ms);});
 const first=await h.lookup('Nobody'),same=await h.lookup('NOBODY');
 expect(first.rows).toEqual([]);expect(same).toBe(first);expect(calls).toBe(1);expect(waits).toEqual([1200]);
});

test('a fresh live roster overrules the published snapshot, and a stale one does not',()=>{
 const code=html.slice(html.indexOf('function withLiveRoster('),html.indexOf('window.atlasLiveRoster='));
 const withLiveRoster=new Function('const LIVE_ROSTER_MS=30000;'+code+';return withLiveRoster;')();
 const state={world:{players:9},worldPlayers:9,roster:[],bots:[
  {name:'Gone',operation:'observed',inWorld:true,fresh:true,pos:{x:1,z:1,level:0}},
  {name:'Back',operation:'offline',inWorld:false,fresh:false},
  {name:'Failed',operation:'failed',inWorld:false},
  {name:'Practice',operation:'observed',practice:true,inWorld:true}]};
 const live={at:1000,players:[['back',3200,3200,0,50],['Stranger',1,2,0,3]]};
 const out=withLiveRoster(state,live,2000),by=(n:string)=>out.bots.find((b:any)=>b.name===n);
 expect(by('Gone')).toMatchObject({inWorld:false,fresh:false,operation:'offline',live:null,pos:{x:1,z:1,level:0}});
 expect(by('Back')).toMatchObject({inWorld:true,operation:'observed',pos:{x:3200,z:3200,level:0}});
 expect(by('Failed').operation).toBe('failed');expect(by('Practice').inWorld).toBe(true);
 expect(out.worldPlayers).toBe(2);expect(out.world.players).toBe(2);expect(out.roster).toBe(live.players);
 expect(state.bots[0]!.inWorld).toBe(true);
 expect(withLiveRoster(state,live,31001)).toBe(state);expect(withLiveRoster(state,null,2000)).toBe(state);
});

test('a follow is asked again once the feed has the account, and only once',()=>{
 const code=html.slice(html.indexOf('function liveRosterIn('),html.indexOf('window.atlasRosterIn='));
 const sent:any[]=[];const frame={contentWindow:{postMessage:(m:any)=>sent.push(m)}};
 const run=new Function('$','window',`let LIVE_ROSTER=null,followedLive=null,rswFor=null,sel='Worker',SNAPSHOT=null;const STATIC=false,mode='3d',VIEWER={state:'ready',origin:'o'};${code};return liveRosterIn;`)(()=>frame,{});
 run({players:[['Other',1,2,0,3]]});expect(sent).toEqual([]);
 run({players:[['Worker',1,2,0,3]]});run({players:[['Worker',1,3,0,3]]});expect(sent).toEqual([{follow:'Worker'}]);
 run({players:[]});run({players:[['worker',1,2,0,3]]});expect(sent).toHaveLength(2);
});

test('fleet filters count each account once and the total level leaves out unnamed skills',()=>{
 const ops=readFileSync(new URL('./operations.js',import.meta.url),'utf8');
 const fleetHelpers=ops.slice(ops.indexOf(' // Fleet deck:'),ops.indexOf(' function account(){'));
 const run=new Function('S','window','E','nf','age','dur','safeName',
  `let fleetFilter='all',fleetQuery='',sel=null;const isOwner=()=>true,bots=()=>S.bots.filter(b=>!b.practice),issues=()=>bots().filter(b=>['blocked','failed','died','active-stale','unobserved'].includes(b.operation)),page=h=>h,title=()=>'',button=()=>'',allocation=()=>'unknown',resultSummary=E,st=b=>['on',b.operation||'offline'];${fleetHelpers};return fleet();`,
 )(
  {bots:[{name:'A',operation:'observed',inWorld:true},{name:'B',operation:'failed'},{name:'C',operation:'paused'},{name:'D',operation:'offline',inWorld:true},{name:'E',operation:'offline'}],world:{players:2},results:[]},
  {atlasOperator:()=>true},String,String,()=>'1s',()=>'1m',String,
 );
 const counts=Object.fromEntries([...run.matchAll(/data-value="([^"]+)"[^>]*>[^<]*<span class="op-count">(\d+)<\/span>/g)].map(m=>[m[1],Number(m[2])]));
 expect(counts.working+counts.attention+counts.paused+counts.held).toBe(counts.all);
 expect(counts.held).toBe(2);
 expect(counts.inworld).toBe(2);
 const line=ops.slice(ops.indexOf('const totalLevel='),ops.indexOf('\n',ops.indexOf('const totalLevel=')));
 const total=new Function(line+';return totalLevel;')();
 expect(total({skills:[{name:'Attack',level:99},{name:'Stat18',level:1},{name:'Overall',level:100}]})).toBe(99);
});

test('a static page applies each roster, because it reads its state only once',()=>{
 const code=html.slice(html.indexOf('function withLiveRoster('),html.indexOf('window.atlasLiveRoster='))+html.slice(html.indexOf('function liveRosterIn('),html.indexOf('window.atlasRosterIn='));
 let rendered=0;const snapshot={bots:[{name:'Gone',operation:'observed',inWorld:true}]};
 const run=new Function('$','window','render','snapshot',`const LIVE_ROSTER_MS=30000,STATIC=true,mode='2d',VIEWER={};let LIVE_ROSTER=null,followedLive=null,rswFor=null,sel=null,SNAPSHOT=snapshot,S=snapshot;${code};return r=>{liveRosterIn(r);return S;};`)(()=>null,{},()=>rendered++,snapshot);
 const shown=run({players:[['Other',1,2,0,3]]});
 expect(shown.bots[0].inWorld).toBe(false);expect(shown.worldPlayers).toBe(1);expect(rendered).toBe(1);expect(snapshot.bots[0]!.inWorld).toBe(true);
});
