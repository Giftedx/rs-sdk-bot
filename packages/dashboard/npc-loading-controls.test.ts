import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
function section(start:string,end:string){
 const first=shell.indexOf(start),last=shell.indexOf(end,first);
 if(first<0||last<0)throw Error('Missing NPC test section: '+start);
 return shell.slice(first,last);
}
const escape=(value:unknown)=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const giant=[['Giant',3,3,[3200,3200,0]]],oldGiants=[['Giant obsolete',9,9,[3100,3100,0]]];
function deferred<T>(){
 let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
const response=(data:unknown)=>({ok:true,status:200,json:()=>Promise.resolve(data)});
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

function clock(){
 let now=0,next=0;
 const timers=new Map<number,{at:number;run:()=>void}>(),delays:number[]=[];
 return {delays,pending:()=>timers.size,
  setTimeout:(run:()=>void,delay=0)=>{delays.push(delay);const id=++next;timers.set(id,{at:now+delay,run});return id;},
  clearTimeout:(id:number)=>{timers.delete(id);},
  advance:(ms:number)=>{const end=now+ms;for(;;){const due=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].run();}now=end;}
 };
}

function harness(){
 const loader=section('  let npcSpawns=null','  // World Map icons');
 const train=section('  function trainInner(){','  function finderList(){');
 const finder=section('  function finderList(){','  // Respawn timers');
 const retry=shell.split('\n').find(line=>line.includes("if(e.target.closest('[data-finder-retry]'))loadSpawns(true)"));
 if(!retry)throw Error('Missing NPC Retry handler');
 const time=clock(),requests:Array<{reply:ReturnType<typeof deferred<any>>;signal:AbortSignal|null|undefined}>=[];
 const results={innerHTML:'',contains:()=>false,querySelectorAll:()=>[]};
 const training={innerHTML:'',contains:()=>false,querySelector:()=>null};
 let onRetry!:(event:any)=>void;
 const body={querySelector:(selector:string)=>selector==='.finder-results'?results:selector==='.train-box'?training:null,
  addEventListener:(_kind:string,handler:(event:any)=>void)=>{onRetry=handler;}};
 const api=new Function('fetch','asset','body','S','safeName','E','nf','document','setTimeout','clearTimeout','AbortController',`
  const selectedPlugin='world',miniView={};
  ${loader}
  const combatText=()=>'',teleText=()=>'',thieveText=()=>'',meleeHitText=()=>'',npcHitsText=()=>'',killXpText=()=>'',lootText=()=>'',hourText=()=>'',trainRows=()=>[];
  ${train}${finder}${retry}
  return {loadSpawns,finderList,setQuery:q=>{finderQuery=q;},read:()=>({data:npcSpawns,pending:npcSpawnsPending,error:npcSpawnsError})};
 `)((_url:string,init?:RequestInit)=>{const reply=deferred<any>();requests.push({reply,signal:init?.signal});return reply.promise;},String,body,
  {roster:[['Giantfan',3200,3200,0,3]]},String,escape,String,{activeElement:null},time.setTimeout,time.clearTimeout,AbortController);
 api.setQuery('gi');
 return {...api,time,requests,results,training,retry:()=>onRetry({target:{closest:(selector:string)=>selector==='[data-finder-retry]'?{}:null}})};
}

function expectPlayers(html:string){expect(html).toContain('data-finder-player="Giantfan"');}
function expectUnavailable(h:ReturnType<typeof harness>){
 expect(h.read().pending).toBe(false);expect(h.read().data).toBeNull();
 expect(h.finderList()).toContain('NPC spawns unavailable');expect(h.finderList()).toContain('data-finder-retry');
 expect(h.finderList()).not.toContain('Loading NPC spawns');expectPlayers(h.finderList());
 expect(h.results.innerHTML).toContain('NPC spawns unavailable');expect(h.training.innerHTML).toContain('NPC spawns unavailable');
 expect(h.time.pending()).toBe(0);
}

test('a stalled NPC fetch has a 10s deadline; actual Retry stays pending when the old fetch arrives',async()=>{
 const h=harness();h.loadSpawns();h.loadSpawns();
 expect(h.requests).toHaveLength(1);expect(h.requests[0]!.signal).toBeInstanceOf(AbortSignal);
 expect(h.finderList()).toContain('Loading NPC spawns');expectPlayers(h.finderList());
 h.time.advance(9999);await flush();expect(h.read().pending).toBe(true);expect(h.finderList()).not.toContain('data-finder-retry');
 h.time.advance(1);await flush();expectUnavailable(h);expect(h.requests[0]!.signal?.aborted).toBe(true);
 h.loadSpawns();expect(h.requests).toHaveLength(1);
 h.retry();h.retry();expect(h.requests).toHaveLength(2);expect(h.read().pending).toBe(true);expectPlayers(h.finderList());
 h.requests[0]!.reply.resolve(response(oldGiants));await flush();
 expect(h.read().pending).toBe(true);expect(h.read().data).toBeNull();expect(h.finderList()).toContain('Loading NPC spawns');expectPlayers(h.finderList());
 h.requests[1]!.reply.resolve(response(giant));await flush();
 expect(h.read().data).toEqual(giant);expect(h.finderList()).toContain('data-finder-pick="Giant"');
 expect(h.finderList()).not.toContain('obsolete');expect(h.finderList()).not.toContain('unavailable');expect(h.time.pending()).toBe(0);
});

test('the NPC deadline covers a stalled JSON body and its late completion cannot replace a successful Retry',async()=>{
 const h=harness(),body=deferred<unknown>();h.loadSpawns();
 h.requests[0]!.reply.resolve({ok:true,status:200,json:()=>body.promise});await flush();
 expect(h.read().pending).toBe(true);expectPlayers(h.finderList());
 h.time.advance(9999);await flush();expect(h.read().pending).toBe(true);
 h.time.advance(1);await flush();expectUnavailable(h);expect(h.requests[0]!.signal?.aborted).toBe(true);
 h.retry();expect(h.requests).toHaveLength(2);h.requests[1]!.reply.resolve(response(giant));await flush();
 expect(h.read().data).toEqual(giant);const rendered=h.results.innerHTML;
 body.resolve(oldGiants);await flush();
 expect(h.read().data).toEqual(giant);expect(h.read().pending).toBe(false);expect(h.read().error).toBe('');
 expect(h.results.innerHTML).toBe(rendered);expect(h.time.pending()).toBe(0);expectPlayers(h.finderList());
});

for(const [label,data] of [['populated',giant],['empty',[]]] as const)test('a successful '+label+' NPC table clears its deadline and is reused without a later abort',async()=>{
 const h=harness();h.loadSpawns();h.requests[0]!.reply.resolve(response(data));await flush();
 expect(h.read()).toEqual({data,pending:false,error:''});expect(h.requests[0]!.signal).toBeInstanceOf(AbortSignal);
 expect(h.time.delays).toContain(10000);expect(h.time.pending()).toBe(0);expect(h.requests[0]!.signal?.aborted).toBe(false);
 const rendered=h.results.innerHTML;h.time.advance(20_000);await flush();h.loadSpawns();h.retry();
 expect(h.requests).toHaveLength(1);expect(h.read()).toEqual({data,pending:false,error:''});
 expect(h.requests[0]!.signal?.aborted).toBe(false);expect(h.results.innerHTML).toBe(rendered);expectPlayers(h.finderList());
 expect(h.finderList()).not.toContain('Loading NPC spawns');expect(h.finderList()).not.toContain('data-finder-retry');
});

test('NPC HTTP, network, JSON and invalid-shape failures clear the deadline and keep the real Retry usable',async()=>{
 for(const failure of ['HTTP','network','JSON','shape']){
  const h=harness();h.loadSpawns();
  if(failure==='network')h.requests[0]!.reply.reject(Error('offline'));
  else if(failure==='HTTP')h.requests[0]!.reply.resolve({ok:false,status:503});
  else if(failure==='JSON')h.requests[0]!.reply.resolve({ok:true,status:200,json:()=>Promise.reject(Error('bad JSON'))});
  else h.requests[0]!.reply.resolve(response({wrong:[]}));
  await flush();expectUnavailable(h);h.time.advance(20_000);await flush();expectUnavailable(h);
  h.retry();expect(h.requests).toHaveLength(2);h.requests[1]!.reply.resolve(response(giant));await flush();
  expect(h.read()).toEqual({data:giant,pending:false,error:''});expect(h.time.pending()).toBe(0);expectPlayers(h.finderList());
 }
});
