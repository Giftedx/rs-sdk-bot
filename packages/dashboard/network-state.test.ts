import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const now=2_000_000,Clock={now:()=>now};
const section=(start:string,end:string)=>shell.slice(shell.indexOf(start),shell.indexOf(end,shell.indexOf(start)));
const ago=(ms:number)=>ms<60_000?Math.floor(ms/1000)+'s':Math.floor(ms/60_000)+'m';
const snapshot=(extra:any={})=>({now,bots:[{name:'Worker'}],roster:[['Worker',3200,3200,0,50],['Visitor',3201,3201,0,3]],world:{connected:true,tickAt:now-1000},...extra});

function world(S:any,options:any={}){
 const {owner=false,mode='2d',viewer={state:'idle',feed:null},live=null}=options;
 const env:any={S,Date:Clock,mode,VIEWER:viewer,LIVE_ROSTER:live,window:{atlasOperator:()=>owner,atlasLiveRoster:()=>!!live&&now-live.at<=30_000},
  worldSpots:()=>[],partyBox:()=>'',wildLevel:()=>false,respawnBox:()=>'',highlightsBox:()=>'',markersBox:()=>'',finderBox:()=>'<div>Retained finder rows</div>',farmsBox:()=>'',E:String,nf:String,ago};
 return new Function(...Object.keys(env),section('  function worldPanel(){','  // A new snapshot rewrites')+';return worldPanel();')(...Object.values(env)) as string;
}

function lostScreen(options:any={}){
 const {mode='3d',viewer={state:'ready',feed:true},live=true,connected=false,lastReceived=now-60_000,hostedStale=false}=options;
 const loading={hidden:false},lost={hidden:true};
 const env:any={S:snapshot(),Date:Clock,mode,VIEWER:viewer,window:{atlasLiveRoster:()=>live},connected,lastReceived,
  hud:{querySelector:(id:string)=>id==='#game-lost'?lost:loading},document:{documentElement:{classList:{contains:()=>hostedStale}}}};
 new Function(...Object.keys(env),section('  function screens(){','  setInterval(screens,')+';screens();')(...Object.values(env));
 return {loading:!loading.hidden,lost:!lost.hidden};
}

test('a healthy live 3D scene stays visible during either form of snapshot-stream loss',()=>{
 expect(lostScreen()).toEqual({loading:false,lost:false});
 expect(lostScreen({connected:true})).toEqual({loading:false,lost:false});
});

test('the classic warning still covers 2D and combined losses while hosted stale bars keep ownership',()=>{
 for(const snapshotLive of [false,true])for(const feedLive of [false,true]){
  expect(lostScreen({connected:snapshotLive,lastReceived:snapshotLive?now:now-60_000,viewer:{state:'ready',feed:feedLive},live:feedLive}).lost).toBe(!snapshotLive&&!feedLive);
 }
 for(const viewer of [{state:'ready',feed:false},{state:'ready',feed:null},{state:'loading',feed:true}])expect(lostScreen({viewer}).lost).toBe(true);
 expect(lostScreen({live:false}).lost).toBe(true);
 expect(lostScreen({mode:'2d'}).lost).toBe(true);
 expect(lostScreen({viewer:{state:'ready',feed:false},connected:true,lastReceived:now}).lost).toBe(false);
 expect(lostScreen({viewer:{state:'ready',feed:false},hostedStale:true}).lost).toBe(false);
});

test('fresh native feed observations and a fresh direct roster show current counts to both roles',()=>{
 for(const owner of [false,true]){
  const native=world(snapshot(),{owner});expect(native).toContain('Online now');expect(native).toContain('Live feed connected');expect(native).toContain('As of 1s ago');
  const direct=world(snapshot({now:1,hostedAge:600_000,stateError:'snapshot unavailable',world:{connected:false,tickAt:1}}),{owner,mode:'3d',viewer:{state:'ready',feed:true},live:{at:now-2000}});
  expect(direct).toContain('Online now');expect(direct).toContain('As of 2s ago');expect(direct).toContain('Retained finder rows');
 }
});

test('aged hosted feed times keep their true age on moving and frozen snapshot clocks',()=>{
 for(const frozen of [false,true]){
  const frame=snapshot({now:frozen?now-600_000:now,hostedAge:600_000,hosted:{at:now-600_000},world:{connected:true,tickAt:now-601_000}});
  const html=world(frame);expect(html).not.toContain('Online now');expect(html).toContain('Last observed players');expect(html).toContain('As of 10m ago');expect(html).toContain('>2</span>');expect(html).toContain('Retained finder rows');
 }
 const shifted=world(snapshot({clockOffset:60_000,now:now+60_000,world:{connected:true,tickAt:now+59_000}}));
 expect(shifted).toContain('Online now');expect(shifted).toContain('As of 1s ago');
});

test('unknown, invalid and future feed dates do not become fresh through snapshot fallback',()=>{
 for(const tickAt of [0,null,undefined,NaN,now+1000]){
  const html=world(snapshot({world:{connected:true,tickAt}}));expect(html).not.toContain('Online now');expect(html).toContain('Observation time unknown');
 }
 const absent=world(snapshot({now:undefined,world:{connected:true}}));expect(absent).not.toContain('Online now');expect(absent).toContain('Observation time unknown');
 const undatedHosted=world(snapshot({hostedAge:600_000,world:{connected:true}}));expect(undatedHosted).not.toContain('Online now');expect(undatedHosted).toContain('Observation time unknown');
});

test('legacy observations use dated snapshots only when the feed date field is absent',()=>{
 expect(world(snapshot({world:{connected:true}}))).toContain('Online now');
 for(const frozen of [false,true]){
  const html=world(snapshot({now:frozen?now-600_000:now,hostedAge:600_000,hosted:{at:now-600_000},world:{connected:true}}));
  expect(html).not.toContain('Online now');expect(html).toContain('As of 10m ago');
 }
});

test('disconnected and waiting viewer feeds remain visible in the World card for both roles',()=>{
 for(const owner of [false,true]){
  for(const live of [null,{at:now-1000}]){
   const html=world(snapshot(),{owner,mode:'3d',viewer:{state:'ready',feed:false},live});
   expect(html).not.toContain('Online now');expect(html).toContain('Live feed disconnected');expect(html).toContain('Last observed players');expect(html).toContain('>2</span>');expect(html).toContain('Retained finder rows');
  }
  const waiting=world(snapshot(),{owner,mode:'3d',viewer:{state:'ready',feed:null}});expect(waiting).not.toContain('Online now');expect(waiting).toContain('Waiting for live feed');
 }
 for(const extra of [{world:{connected:false,tickAt:now-1000}},{world:{tickAt:now-1000}},{stateError:'collector failed'}])expect(world(snapshot(extra))).not.toContain('Online now');
});

function titleState(options:any={}){
 const {mode='3d',viewer={state:'ready',feed:false},fresh=true,stateError=null,live=true}=options;
 const raw={textContent:'',className:'',title:''},visible={textContent:'',className:'',title:''};let frozen=false;
 const env:any={mode,VIEWER:viewer,Date:Clock,S:snapshot({now:fresh?now:now-60_000,stateError}),connected:fresh,lastReceived:fresh?now:now-60_000,
  document:{body:{classList:{toggle:(_key:string,value:boolean)=>{frozen=value;}}},querySelector:()=>visible},$:()=>raw,window:{atlasOperator:()=>true,atlasLiveRoster:()=>live},performance:{now:()=>20_000}};
 const code=html.slice(html.indexOf('function connectionState(){'),html.indexOf("$('#inspector').addEventListener"));
 new Function(...Object.keys(env),code+';connectionState();')(...Object.values(env));return {raw,visible,frozen};
}

test('the visible title separates an offline 3D world from a healthy snapshot stream',()=>{
 const state=titleState();expect(state.raw.textContent).toBe('● LIVE');expect(state.raw.className).toBe('good');expect(state.frozen).toBe(false);
 expect(state.visible.textContent).toBe('● LIVE · WORLD OFFLINE');expect(state.visible.className).toContain('warning-state');
 expect(state.visible.title).toContain('Snapshot updates continue');expect(state.visible.title).toContain('reconnecting');
});

test('a live world cannot hide a stale snapshot title, and 2D keeps its snapshot-only status',()=>{
 const stale=titleState({fresh:false,viewer:{state:'ready',feed:true}});expect(stale.raw.textContent).toBe('FROZEN');expect(stale.visible.textContent).toBe('FROZEN · WORLD LIVE');expect(stale.frozen).toBe(true);expect(stale.visible.className).toContain('warning-state');
 const silent=titleState({fresh:false,viewer:{state:'ready',feed:true},live:false});expect(silent.visible.textContent).toBe('FROZEN');
 const flat=titleState({mode:'2d'});expect(flat.visible.textContent).toBe('● LIVE');expect(flat.visible.className).toBe('connection good');expect(flat.frozen).toBe(false);
 const both=titleState({fresh:false});expect(both.raw.textContent).toBe('FROZEN');expect(both.visible.textContent).toBe('FROZEN · WORLD OFFLINE');expect(both.frozen).toBe(true);
 const error=titleState({stateError:'collector failed'});expect(error.raw.textContent).toBe('STATE ERROR');expect(error.visible.textContent).toBe('STATE ERROR · WORLD OFFLINE');expect(error.frozen).toBe(true);
});
