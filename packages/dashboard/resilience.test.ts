import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const server=readFileSync(new URL('./server.ts',import.meta.url),'utf8');

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
 const choose=new Function('S','window','picked','sel',`const TOUR=false,liveBots=()=>S.bots;${code}};render();return sel;`);
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
 const code=server.slice(server.indexOf('function current() {'),server.indexOf('setInterval(() => {',server.indexOf('function current() {')));
 const run=new Function('buildState','console',`const SECRET_RE=/Haggis/gi,SECRET_MARK='⟦MAIN⟧',MAP={};let latest={at:0,json:''};${code};return current;`)(()=>{throw Error('Haggis invalid status');},{error:()=>{}});
 expect(run()).not.toMatch(/haggis/i);expect(JSON.parse(run()).stateError).toContain('⟦MAIN⟧');
});

test('an upstream player service failure is not cached as an unranked player for thirty minutes',async()=>{
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(server.slice(server.indexOf('function lookupPlayer('),server.indexOf('let lookupWanted:')));
 let calls=0;
 const lookup=new Function('fetch','Bun',`const lookups=new Map(),roster=new Map(),DEMO='https://example.test',ONLINE_MS=30000,SKILL_BOARDS=[];let lookupChain=Promise.resolve();const hiscoreRows=()=>[{board:'Mining'}],wornOf=async()=>null;${code};return lookupPlayer;`)(async()=>++calls===1?new Response('unavailable',{status:503}):new Response('player rows'),{sleep:async()=>{}});
 expect(await lookup('Worker')).toBeNull();expect((await lookup('Worker')).rows).toEqual([{board:'Mining'}]);expect(calls).toBe(2);
});
