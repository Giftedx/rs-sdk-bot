import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
function section(start:string,end:string){const at=shell.indexOf(start),to=shell.indexOf(end,at);if(at<0||to<0)throw Error('Missing production section: '+start);return shell.slice(at,to);}
const now=1_000_000,Clock={now:()=>now};
const cached={name:'ProbeFriend',at:1,rows:[{board:'Overall',rank:23,level:72}],online:true,x:3200,z:3200,plane:0,combat:42,lastSeen:now-40_000,presenceObservedAt:now-40_000,worn:[{slot:'Weapon',name:'Sword',id:1}],wornAt:1};
const roster=[['pRoBeFrIeNd',3500,3600,2,50]];
const state=(extra:any={})=>({now,bots:[],world:{connected:true,tickAt:now},roster,lookups:{},...extra});
const escape=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');

function card(snapshot:any,receipt:any=cached,live:any=null){
 const env:any={S:snapshot,l:receipt,LIVE_ROSTER:live,window:{atlasLiveRoster:()=>!!live},Date:Clock,E:escape,age:String,nf:String,
  skills:[],reported:()=>true,asset:String,skillFile:String,safeName:String,icon:()=>'<i>Sword icon</i>',whereIs:(x:number,z:number)=>x+','+z};
 return new Function(...Object.keys(env),section('  function lookupCard(l){','  function refreshWorldLookup(){')+';return lookupCard(l);')(...Object.values(env)) as string;
}
function unknown(html:string){expect(html).toContain('presence not loaded');expect(html).not.toContain('Watch in 3D');expect(html).not.toContain('online 3500,3600');expect(html).not.toContain('online 3200,3200');expect(html).not.toContain('not seen online');expect(html).not.toContain('last seen ');expect(html).toContain('Overall <b>#23 · 72</b>');expect(html).toContain('Sword icon');}

test('Player presence uses explicit fresh world ticks for both presence and absence',()=>{
 for(const tickAt of [now,now-29_999]){
  const html=card(state({world:{connected:true,tickAt}}));expect(html).toContain('online 3500,3600');expect(html).toContain('Watch in 3D');
  const absent=card(state({world:{connected:true,tickAt},roster:[]}),{...cached,lastSeen:null});expect(absent).toContain('not seen online');expect(absent).not.toContain('Watch in 3D');expect(absent).not.toContain('presence not loaded');
 }
});

test('fresh collector heartbeats cannot turn stale, invalid or future tick observations into Player presence',()=>{
 for(const offset of [0,60_000])for(const tickAt of [now+offset-30_000,0,null,undefined,NaN,Infinity,String(now+offset),now+offset+1]){
  const snapshot=state({now:now+offset,clockOffset:offset,hostedAge:0,hosted:{at:now+offset},world:{connected:true,tickAt}});
  unknown(card(snapshot));unknown(card({...snapshot,roster:[]}));
 }
});

test('Player presence also guards cached lookup entries when no roster array is supplied',()=>{
 const entry={online:true,x:3500,z:3600,plane:2,combat:50,lastSeen:now};
 const snapshot=state({roster:undefined,lookups:{probefriend:entry}});
 expect(card(snapshot)).toContain('online 3500,3600');
 unknown(card({...snapshot,world:{connected:true,tickAt:now-40_000}}));
 unknown(card({...snapshot,world:{connected:true,tickAt:0},lookups:{probefriend:{online:false,lastSeen:now}}}));
});

test('only absent tick metadata may use the existing native or dated hosted legacy fallback',()=>{
 expect(card(state({world:{connected:true}}))).toContain('online 3500,3600');
 expect(card(state({now:now+60_000,clockOffset:60_000,hostedAge:1000,hosted:{at:now+59_000},world:{connected:true}}))).toContain('online 3500,3600');
 for(const hosted of [{at:0},{at:null},{at:undefined},{at:now-40_000},{at:now+1},{}])unknown(card(state({hostedAge:0,hosted,world:{connected:true}})));
 unknown(card(state({hostedAge:0,world:{connected:true}})));
 // An explicit invalid tick cannot borrow even a valid legacy hosted timestamp.
 unknown(card(state({hostedAge:0,hosted:{at:now},world:{connected:true,tickAt:undefined}})));
});

test('feed timestamps and collector receipts both use the browser clock and retain hosted age',()=>{
 const shifted=state({now:now+60_000,clockOffset:60_000,hostedAge:1000,hosted:{at:now+60_000},world:{connected:true,tickAt:now+59_000}});
 expect(card(shifted)).toContain('online 3500,3600');
 for(const extra of [{hostedAge:30_000},{hostedAge:-1},{hostedAge:NaN},{now:now+62_000},{world:{connected:true,tickAt:now+60_001}},{world:{connected:false,tickAt:now+59_000}},{stateError:'collector failed'}])unknown(card({...shifted,...extra}));
});

test('direct roster and newer API presence keep priority over stale or older snapshot feed evidence',()=>{
 const stale=state({world:{connected:true,tickAt:0}}),freshApi={...cached,presenceObservedAt:now-1000};
 expect(card(stale,freshApi)).toContain('online 3200,3200');expect(card(stale,freshApi)).toContain('Watch in 3D');
 const older=state({world:{connected:true,tickAt:now-2000},roster:[]});
 expect(card(older,freshApi)).toContain('online 3200,3200');expect(card(older,freshApi)).toContain('Watch in 3D');
 const newer=card(state(),freshApi);expect(newer).toContain('online 3500,3600');expect(newer).not.toContain('online 3200,3200');
 const direct=card(stale,{...freshApi,online:false},{players:[['ProbeFriend',3700,3800,3,80]]});expect(direct).toContain('online 3700,3800');expect(direct).toContain('Watch in 3D');
 const gone=card(state(),freshApi,{players:[]});expect(gone).not.toContain('Watch in 3D');expect(gone).not.toContain('online 3200,3200');expect(gone).not.toContain('online 3500,3600');
});

async function lookupResponse(snapshot:any,response:any={...cached,presenceObservedAt:undefined},hosted=true){
 const env:any={S:snapshot,window:hosted?{FleetShim:{}}:{},body:{querySelector:()=>({})},Date:Clock,fetch:async()=>Response.json(response),refreshHiscoreAccount:()=>{}};
 const code=section('  function lookup(name){','  window.atlasLookup=lookup;');
 const api=new Function(...Object.keys(env),`let worldLookupRequest=0,hiscoreName='',hiscoreSel=null,sel=null,hiscoresMode='account',worldLookup=null;const selectedPlugin='boards',refreshWorldLookup=()=>{};${code};return {lookup,value:()=>worldLookup};`)(...Object.values(env));
 api.lookup('ProbeFriend');await Bun.sleep(0);return api.value();
}

test('hosted legacy lookup responses date presence from the feed rather than minting a new collector receipt',async()=>{
 const snapshot=state({now:now+60_000,clockOffset:60_000,hostedAge:1000,hosted:{at:now+60_000},world:{connected:true,tickAt:now+55_000}});
 const receipt=await lookupResponse(snapshot);expect(receipt.presenceObservedAt).toBe(now-5000);expect(card(snapshot,receipt)).toContain('Watch in 3D');
 for(const extra of [{world:{connected:true,tickAt:0}},{world:{connected:true,tickAt:now+20_000}},{world:{connected:true,tickAt:now+60_001}},{hostedAge:40_000},{world:{connected:false,tickAt:now+55_000}},{stateError:'collector failed'}]){
  const frame={...snapshot,...extra},value=await lookupResponse(frame);unknown(card(frame,value));
 }
});

test('explicit API presence stamps and native API receipt behavior remain unchanged',async()=>{
 const stale=state({now:now-40_000,world:{connected:false,tickAt:0}});
 for(const presenceObservedAt of [null,now-40_000,now-1000]){
  const value=await lookupResponse(stale,{...cached,presenceObservedAt});expect(value.presenceObservedAt).toBe(presenceObservedAt);
  if(presenceObservedAt===now-1000)expect(card(stale,value)).toContain('Watch in 3D');else unknown(card(stale,value));
 }
 const native=await lookupResponse(stale,undefined,false);expect(native.presenceObservedAt).toBe(now);expect(native.at).toBe(1);
});

function rivalsControl(){
 const doc:any={body:{},activeElement:null},outside={focus:()=>{doc.activeElement=outside;}},handlers:Record<string,(event:any)=>void>={};let current:any=null,markup='';
 const panel:any={contains:(node:any)=>node===current,querySelector:(selector:string)=>selector==='#rival-board'?current:null,querySelectorAll:()=>current?[current]:[]};
 Object.defineProperty(panel,'innerHTML',{get:()=>markup,set:(value:string)=>{
  if(doc.activeElement===current)doc.activeElement=doc.body;markup=value;
  const select=value.match(/<select\b[^>]*id="rival-board"[^>]*>([\s\S]*?)<\/select>/);
  const options=select?[...select[1].matchAll(/<option([^>]*)>([^<]*)<\/option>/g)]:[];
  const node:any={id:'rival-board',dataset:{},value:(options.find(row=>/\bselected\b/.test(row[1]))||options[0])?.[2]||'',matches:(selector:string)=>selector==='#rival-board',focus:()=>{if(node===current)doc.activeElement=node;}};current=node;
 }});
 const body={contains:(node:any)=>node===current,querySelector:(selector:string)=>selector==='.rivals-wrap'?panel:selector==='#rival-board'?current:null,addEventListener:(type:string,handler:(event:any)=>void)=>{handlers[type]=handler;}};
 const S=state({rivals:['Overall','Attack','Magic'].map(board=>({board,at:now,ours:null,rows:[]}))});
 const env:any={S,body,document:doc,window:{atlasLiveRoster:()=>false},Date:Clock,E:escape,nf:String,age:String,safeName:String,boardTime:String,whereIs:()=>'',overtakeBox:()=>'',put:(el:any,value:string)=>{el.innerHTML=value;}};
 const render=section("  let rivalBoard='Overall';",'  // Overtake planner:');
 const change=section("  body.addEventListener('change',e=>{", "  body.addEventListener('pointerdown',e=>{");
 const api=new Function(...Object.keys(env),`${render}${change};body.querySelector('.rivals-wrap').innerHTML=rivalsPanel();return {selected:()=>rivalBoard};`)(...Object.values(env));
 return {doc,outside,panel,api,select:()=>current,change:(value:string,focus=true)=>{const target=current;target.value=value;if(focus)target.focus();handlers.change({target});}};
}

test('Rivals board changes retain the logical selector focus and allow continued closed-select keyboard changes',()=>{
 const ui=rivalsControl();
 for(const value of ['Attack','Magic','Overall']){ui.change(value);expect(ui.api.selected()).toBe(value);expect(ui.select().value).toBe(value);expect(ui.doc.activeElement).toBe(ui.select());expect(ui.panel.innerHTML).toContain('<span>'+value+'</span>');}
});

test('a Rivals board update never steals focus from outside the selector',()=>{
 const ui=rivalsControl();ui.outside.focus();ui.change('Magic',false);expect(ui.api.selected()).toBe('Magic');expect(ui.select().value).toBe('Magic');expect(ui.doc.activeElement).toBe(ui.outside);
});
