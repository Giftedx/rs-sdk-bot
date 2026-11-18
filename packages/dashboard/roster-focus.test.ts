import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const section=(start:string,end:string)=>shell.slice(shell.indexOf(start),shell.indexOf(end,shell.indexOf(start)));
const now=100_000;
const Clock={now:()=>now};
const cached={name:'ProbeFriend',at:1,rows:[{board:'Overall',rank:23,level:72}],online:true,x:3200,z:3200,plane:0,combat:42,lastSeen:90_000,worn:[{slot:'Weapon',name:'Sword',id:1}],wornAt:10};
const state=(extra:any={})=>({now,world:{connected:true},bots:[],roster:[],lookups:{},...extra});
function card(l:any,s:any,live:any=null){
 const env:any={l,S:s,window:{atlasLiveRoster:()=>!!live},LIVE_ROSTER:live,Date:Clock,E:String,age:String,nf:String,skills:[],reported:()=>true,asset:String,skillFile:String,safeName:String,icon:()=>'<i>Sword icon</i>',whereIs:(x:number,z:number)=>`${x},${z}`};
 return new Function(...Object.keys(env),section('  function lookupCard(l){','  function refreshWorldLookup(){')+';return lookupCard(l);')(...Object.values(env)) as string;
}

test('2D lookup presence follows newer snapshots through departure, movement and return while retaining details',()=>{
 const api={...cached,presenceObservedAt:now-2000};
 const absent=card(api,state({lookups:{probefriend:{online:false,lastSeen:now-60_000}}}));
 expect(absent).not.toContain('Watch in 3D');expect(absent).not.toContain('online 3200');expect(absent).toContain('last seen');
 expect(absent).toContain('Overall <b>#23 · 72</b>');expect(absent).toContain('Sword icon');
 const moved=card(api,state({roster:[['pRoBeFrIeNd',3300,3400,1,50]]}));
 expect(moved).toContain('online 3300,3400');expect(moved).toContain('Combat <b>50</b>');expect(moved).toContain('Watch in 3D');
 const returned=card({...api,online:false},state({roster:[['ProbeFriend',3400,3500,0,51]]}));
 expect(returned).toContain('online 3400,3500');
});

test('fresh API presence wins over an older snapshot, and unsupported or aged presence stays unknown',()=>{
 const api={...cached,presenceObservedAt:now-1000};
 expect(card(api,state({now:now-2000}))).toContain('online 3200,3200');
 for(const s of [state({now:now-31_000}),state({world:{connected:false}}),state({stateError:'collection failed'}),state({hostedAge:31_000}),state({now:now+10_000})]){
  const html=card({...api,presenceObservedAt:now-31_000},s);
  expect(html).toContain('presence not loaded');expect(html).not.toContain('Watch in 3D');expect(html).not.toContain('not seen online');
 }
 expect(card(api,state({world:{connected:false},now:now-60_000}))).toContain('Watch in 3D');
 const historical=card({...cached,at:now},state({roster:undefined,lookups:{}}));
 expect(historical).toContain('presence not loaded');expect(historical).not.toContain('Watch in 3D');
});

test('snapshot clocks and hosted ages date presence separately from the hiscore timestamp',()=>{
 const api={...cached,presenceObservedAt:now-2000};
 const shifted=state({now:now+60_000,clockOffset:60_000,lookups:{probefriend:{online:false,lastSeen:now-5000}}});
 expect(card(api,shifted)).not.toContain('Watch in 3D');
 const onlyLookup=state({roster:undefined,lookups:{probefriend:{online:true,x:3500,z:3600,plane:2,combat:60,lastSeen:now-1000}}});
 expect(card({...cached,at:1},onlyLookup)).toContain('online 3500,3600');
 expect(card({...cached,at:now},state({now:now-40_000}))).toContain('presence not loaded');
});

test('a fresh direct viewer roster remains authoritative over API and snapshot presence',()=>{
 const api={...cached,presenceObservedAt:now};
 expect(card(api,state({roster:[['ProbeFriend',3200,3200,0,42]]}),{players:[]})).not.toContain('Watch in 3D');
 expect(card({...api,online:false},state(),{players:[['ProbeFriend',3600,3700,3,80]]})).toContain('online 3600,3700');
});

async function lookupResponse(response:any,s:any={bots:[]},hosted=false){
 const code=section('  function lookup(name){','  window.atlasLookup=lookup;');
 const env:any={S:s,window:hosted?{FleetShim:{}}:{},body:{querySelector:()=>({})},Date:Clock,fetch:async()=>Response.json(response),refreshHiscoreAccount:()=>{}};
 const api=new Function(...Object.keys(env),`let worldLookupRequest=0,hiscoreName='',hiscoreSel=null,sel=null,hiscoresMode='account',worldLookup=null;const selectedPlugin='boards',refreshWorldLookup=()=>{};${code};return{lookup,value:()=>worldLookup};`)(...Object.values(env));
 api.lookup('ProbeFriend');await Bun.sleep(0);return api.value();
}
test('a successful player request stamps a client presence observation independent of old hiscores',async()=>{
 const value=await lookupResponse({...cached,at:1});expect(value.presenceObservedAt).toBe(now);expect(value.at).toBe(1);
});
test('hosted lookup receipts retain supplied or legacy snapshot dates instead of refreshing old presence',async()=>{
 for(const stamp of [now-40_000,null]){
  const value=await lookupResponse({...cached,presenceObservedAt:stamp},state(),true);expect(value.presenceObservedAt).toBe(stamp);
  expect(card(value,state({now:now-40_000}))).toContain('presence not loaded');
 }
 const legacy=await lookupResponse(cached,state({now:now+60_000,hostedAge:40_000,clockOffset:60_000}),true);
 expect(legacy.presenceObservedAt).toBeNull(); // Collector time cannot date an absent feed observation.
 const dated=await lookupResponse(cached,state({now:now+60_000,hostedAge:1000,clockOffset:60_000,world:{connected:true,tickAt:now+59_000}}),true);
 expect(dated.presenceObservedAt).toBe(now-1000);expect(dated.at).toBe(1);
 const fresh=await lookupResponse({...cached,presenceObservedAt:now-1000},state({now:now-60_000}),true);
 expect(card(fresh,state({now:now-60_000}))).toContain('Watch in 3D');
});

function finderHarness(){
 const start=shell.indexOf('  function finderFocusState('),code=shell.slice(start<0?shell.indexOf('  function finderResults('):start,shell.indexOf('  function finderBox(){'));
 const refresh=section('  function refreshWorld(){','  // Bot farms:');
 const branchStart=shell.indexOf("else if('finderPlayer' in d)"),branch=shell.slice(branchStart,shell.indexOf('\n      return;}',branchStart));
 const doc:any={activeElement:null};let controls:any[]=[],writes=0,coords='3200,3200';
 const input:any={dataset:{finder:''},matches:(s:string)=>s==='[data-finder]',focus:()=>{doc.activeElement=input;}};
 const list:any={contains:(el:any)=>controls.includes(el),querySelectorAll:()=>controls,set innerHTML(value:string){writes++;controls=value==='picked'?[button({finderClear:''}),button({finderGo:coords})]:[button({finderPick:'Goblin'})];doc.activeElement=body;}};
 const body:any={scrollTop:37,contains:(el:any)=>el===input||controls.includes(el),querySelector:(s:string)=>s==='.finder-results'?list:s==='[data-finder]'?input:s==='[data-finder-clear]'?controls.find(c=>Object.hasOwn(c.dataset,'finderClear')):null,querySelectorAll:()=>[]};
 function button(dataset:any){const node:any={dataset,closest:(s:string)=>s==='.finder-results'?list:null,focus:()=>{doc.activeElement=node;}};return node;}
 const env:any={body,document:doc,put:(_el:any,html:string)=>{list.innerHTML=html;},worldPanel:()=>api.picked()?'picked':'choices',overlaySync:()=>{},minimap:()=>{}};
 const api=new Function(...Object.keys(env),`let finderPick=null,finderPlayer=null,sourcePin=null,finderSafe=false;const finderList=()=>finderPick||finderPlayer?'picked':'choices';${code}${refresh};return{picked:()=>finderPick||finderPlayer,dispatch:d=>{if(false){}${branch}},refreshWorld};`)(...Object.values(env));
 list.innerHTML='choices';controls[0].focus();
 return{api,input,focusResult:()=>controls[0].focus(),move:(next:string)=>{coords=next;},active:()=>doc.activeElement,controls:()=>controls,writes:()=>writes};
}

test('finder selection focuses its Clear control and clearing returns focus to search',()=>{
 for(const data of [{finderPick:'Goblin'},{finderPlayer:'ProbeFriend'}]){
  const h=finderHarness();h.api.dispatch(data);expect(h.active()?.dataset).toEqual({finderClear:''});
  h.api.dispatch({finderClear:''});expect(h.active()).toBe(h.input);
 }
});

test('periodic World redraw keeps finder control focus and typing keeps the input intact',()=>{
 const h=finderHarness();h.api.dispatch({finderPick:'Goblin'});h.controls()[0].focus();h.api.refreshWorld();expect(h.active()?.dataset).toEqual({finderClear:''});
 h.api.dispatch({finderClear:''});const before=h.writes();h.api.refreshWorld();expect(h.active()).toBe(h.input);expect(h.writes()).toBe(before);
});

test('finder Go retains focus when the same player moves or the same NPC nearest tile changes',()=>{
 for(const selection of [{finderPlayer:'ProbeFriend'},{finderPick:'Goblin'}]){
  const h=finderHarness();h.api.dispatch(selection);h.controls()[1].focus();h.move('3300,3400');h.api.refreshWorld();
  expect(h.active()?.dataset).toEqual({finderGo:'3300,3400'});
 }
});

test('a focused Combat training retry returns to search when its loading repaint removes the button',()=>{
 const code=section('  const paintSpawns=','  const loadSpawns=');
 const doc:any={activeElement:null};
 const retry:any={matches:(s:string)=>s==='[data-finder-retry]'},input={focus:()=>{doc.activeElement=input;}};
 const train:any={contains:(el:any)=>el===retry,querySelector:()=>null,set innerHTML(_html:string){if(doc.activeElement===retry)doc.activeElement=body;}};
 const body={querySelector:(s:string)=>s==='.train-box'?train:s==='[data-finder]'?input:null};
 const paint=new Function('selectedPlugin','body','document','finderResults','trainInner',`${code};return paintSpawns;`)('world',body,doc,()=>{},()=> 'Loading NPC spawns…');
 doc.activeElement=retry;paint();expect(doc.activeElement).toBe(input);
});
