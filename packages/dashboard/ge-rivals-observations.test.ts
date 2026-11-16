import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const section=(start:string,end:string)=>shell.slice(shell.indexOf(start),shell.indexOf(end,shell.indexOf(start)));
const escape=(value:unknown)=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const coal={453:[['gather','Coal rock',[3200,3200,0]]]};

function sources(fetcher:(url:string,init?:RequestInit)=>Promise<Response>){
 const loader=section('  let itemSourcesData=','  // The teleport (cast from anywhere)');
 const render=section('  function geSourceCost(','  // The head (counts and the price age)');
 const retryStart=shell.indexOf("  body.addEventListener('click',e=>{if(e.target.closest('[data-ge-sources-retry]'))");
 const retry=retryStart<0?'':shell.slice(retryStart,shell.indexOf('\n',retryStart));
 let onRetry:((event:any)=>void)|null=null,calls=0,repaints=0;const signals:(AbortSignal|null|undefined)[]=[];
 const show=new Function('fetch','asset','E','geTele','refreshGe','body',`${loader}${render}${retry};return geSources;`)(
  (url:string,init?:RequestInit)=>{calls++;signals.push(init?.signal);return fetcher(url,init);},(name:string)=>name,escape,()=>'',()=>repaints++,{addEventListener:(_type:string,handler:(event:any)=>void)=>{onRetry=handler;}});
 return {show,calls:()=>calls,repaints:()=>repaints,signals,retry:()=>{if(!onRetry)throw Error('Missing GE source Retry action');onRetry({target:{closest:(selector:string)=>selector==='[data-ge-sources-retry]'?{}:null}});}};
}

test('GE source reads are bounded and shared while pending, then reused after success',async()=>{
 let answer!:(response:Response)=>void;const pending=new Promise<Response>(resolve=>{answer=resolve;}),h=sources(async()=>pending);
 expect(h.show('453')).toContain('Loading sources');expect(h.show('526')).toContain('Loading sources');expect(h.calls()).toBe(1);expect(h.signals[0]).toBeInstanceOf(AbortSignal);
 answer(Response.json(coal));await Bun.sleep(0);
 expect(h.show('453')).toContain('Coal rock');expect(h.show('526')).toContain('No source on record');expect(h.calls()).toBe(1);expect(h.repaints()).toBeGreaterThan(0);
});

for(const failure of ['HTTP','network','JSON'])test('GE source '+failure+' failure is visible and the actual Retry action recovers',async()=>{
 let recovered=false;
 const h=sources(async()=>{
  if(recovered)return Response.json(coal);
  if(failure==='network')throw Error('<temporary offline>');
  return failure==='HTTP'?new Response('temporary',{status:503}):new Response('{invalid JSON');
 });
 h.show('453');await Bun.sleep(0);const failed=h.show('453');
 expect(failed).toContain('Sources unavailable');expect(failed).toContain('data-ge-sources-retry');expect(failed).not.toContain('Loading sources');expect(failed).not.toContain('<temporary offline>');
 recovered=true;expect(h.show('453')).toContain('data-ge-sources-retry');expect(h.calls()).toBe(1);
 h.retry();h.retry();expect(h.calls()).toBe(2);await Bun.sleep(0);
 expect(h.show('453')).toContain('Coal rock');expect(h.show('453')).not.toContain('data-ge-sources-retry');
});

test('an empty completed source catalogue and an unlisted item are finished empty states',async()=>{
 for(const data of [{},{453:[]}]){
  const h=sources(async()=>Response.json(data));h.show('453');await Bun.sleep(0);
  expect(h.show('453')).toContain('No source on record');expect(h.show('453')).not.toContain('Loading sources');expect(h.calls()).toBe(1);
 }
});

test('the shipped producer catalogue reaches the same GE loader and source renderer',async()=>{
 const data=JSON.parse(readFileSync(new URL('./client-assets/item-sources.json',import.meta.url),'utf8'));
 const [id,rows]=Object.entries(data).find(([,rows])=>Array.isArray(rows)&&rows.length>0)! as [string,any[]];
 const h=sources(async()=>Response.json(data));h.show(id);await Bun.sleep(0);
 const html=h.show(id);expect(html).toContain(escape(rows[0][1]));expect(html).not.toContain('Sources unavailable');expect(html).not.toContain('Loading sources');expect(h.calls()).toBe(1);
});

test('invalid source catalogue shapes stay retryable instead of crashing or claiming no sources',async()=>{
 for(const data of [null,[],{453:'bad'},{453:[['gather','Coal rock',null]]}]){
  const h=sources(async()=>Response.json(data));h.show('453');await Bun.sleep(0);
  expect(h.show('453')).toContain('Sources unavailable');expect(h.show('453')).toContain('data-ge-sources-retry');
 }
});

test('a source Retry repaint returns keyboard focus to its item row without taking outside focus',()=>{
 const code=section('  function refreshGe(){','  // The sources of one item,');
 const doc:any={body:{},activeElement:null},group={dataset:{geSources:'453'}},outside={},row={dataset:{geSrc:'453'},focus:()=>{doc.activeElement=row;}},search={focus:()=>{doc.activeElement=search;}};
 const retry:any={dataset:{},matches:(selector:string)=>selector==='[data-ge-sources-retry]',closest:(selector:string)=>selector==='[data-ge-sources]'?group:null};
 const results={contains:(node:any)=>node===retry||node===row,querySelector:(selector:string)=>selector==='[data-ge-src="453"]'?row:selector==='.ge-head'||selector==='.ge-rows'?{}:null};
 const body={querySelector:(selector:string)=>selector==='.ge-results'?results:selector==='#ge-search'?search:null};
 const repaint=new Function('body','document','geResults','put',code+';return refreshGe;')(body,doc,()=>['head','loading'],()=>{if(doc.activeElement===retry)doc.activeElement=doc.body;});
 doc.activeElement=retry;repaint();expect(doc.activeElement===row).toBe(true);
 doc.activeElement=outside;repaint();expect(doc.activeElement===outside).toBe(true);
});

const now=1_000_000;
const snapshot=(extra:any={})=>({now,bots:[],world:{connected:true,tickAt:now},roster:[],rivals:[{board:'Overall',at:now-900_000,ours:null,rows:[{rank:7,name:'ProbeFriend',level:72,ticks:100,online:true,x:3200,z:3200,fleet:false}]}],...extra});
function rivals(state:any,live:any=null){
 const env:any={S:state,LIVE_ROSTER:live,window:{atlasLiveRoster:()=>!!live&&now-live.at>=0&&now-live.at<=30_000},Date:class extends Date{static now(){return now;}},E:escape,nf:String,age:(at:number)=>String(now-at),safeName:String,boardTime:String,whereIs:(x:number,z:number)=>x+','+z,overtakeBox:()=>''};
 return new Function(...Object.keys(env),section('  let rivalBoard=','  // Overtake planner:')+';return rivalsPanel();')(...Object.values(env)) as string;
}

test('a fresh direct roster overrules cached rival departure and movement while rank facts keep their dates',()=>{
 const state=snapshot(),before=structuredClone(state.rivals);
 const gone=rivals(state,{at:now-1000,players:[]});expect(gone).toContain('Online now <b>0 of 1');expect(gone).not.toContain('3200,3200');
 state.rivals[0].rows[0].online=false;
 const moved=rivals(state,{at:now-1000,players:[['pRoBeFrIeNd',3300,3400,1,50]]});
 expect(moved).toContain('Online now <b>1 of 1');expect(moved).toContain('3300,3400');expect(moved).toContain('#7');expect(moved).toContain('>72<');expect(moved).toContain('read 900000 ago');
 expect(state.rivals[0].at).toBe(before[0].at);expect(state.rivals[0].rows[0]).toEqual({...before[0].rows[0],online:false});
});

test('fresh dated snapshot presence is used when a direct roster is absent or expired',()=>{
 const state=snapshot({now:now+60_000,clockOffset:60_000,hostedAge:0,hosted:{at:now+60_000},world:{connected:true,tickAt:now+60_000},roster:[['ProbeFriend',3500,3600,2,50]]});
 for(const live of [null,{at:now-31_000,players:[]}]){
  const html=rivals(state,live);expect(html).toContain('Online now <b>1 of 1');expect(html).toContain('3500,3600');expect(html).not.toContain('3200,3200');
 }
});

test('a fresh collector snapshot cannot refresh stale, invalid or future world-tick presence',()=>{
 for(const offset of [0,60_000]){
  const host=offset?{now:now+offset,clockOffset:offset,hosted:{at:now+offset},hostedAge:0}:{};
  for(const tickAt of [now+offset-40_000,0,null,undefined,NaN,Infinity,String(now+offset),now+offset+1000]){
   const state=snapshot({...host,world:{connected:true,tickAt},roster:[['ProbeFriend',3500,3600,2,50]]});
   const html=rivals(state);expect(html).toContain('Presence unknown');expect(html).not.toContain('Online now');expect(html).not.toContain('3500,3600');expect(html).not.toContain(', offline');
   const direct=rivals(state,{at:now-1000,players:[['ProbeFriend',3700,3800,0,50]]});
   expect(direct).toContain('Online now <b>1 of 1');expect(direct).toContain('3700,3800');
  }
 }
});

test('only absent tick metadata may use the existing native or dated hosted legacy fallback',()=>{
 const roster=[['ProbeFriend',3500,3600,2,50]],world={connected:true};
 for(const extra of [{world,roster},{world,roster,now:now+60_000,clockOffset:60_000,hosted:{at:now+60_000},hostedAge:0}]){
  const html=rivals(snapshot(extra));expect(html).toContain('Online now <b>1 of 1');expect(html).toContain('3500,3600');
 }
 for(const hosted of [{at:0},{at:undefined},{}]){
  const html=rivals(snapshot({world,roster,hosted,hostedAge:0}));expect(html).toContain('Presence unknown');expect(html).not.toContain('Online now');
 }
});

test('historical, disconnected, invalid-clock and collector-error rivals do not assert current presence',()=>{
 for(const extra of [{now:now-40_000},{now:now+1000},{hostedAge:40_000},{hostedAge:-1},{hostedAge:NaN},{world:{connected:false}},{world:{}},{stateError:'collector failed'}]){
  const html=rivals(snapshot(extra));expect(html).toContain('Presence unknown');expect(html).not.toContain('Online now');expect(html).not.toContain('3200,3200');expect(html).not.toContain(', offline');expect(html).toContain('#7');expect(html).toContain('>72<');
 }
});
