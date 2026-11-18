import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const page=readFileSync(new URL('./index.html',import.meta.url),'utf8');
function section(text:string,start:string,end:string){const at=text.indexOf(start),to=text.indexOf(end,at);if(at<0||to<0)throw Error('Missing production section: '+start);return text.slice(at,to);}
function line(text:string,start:string){const at=text.indexOf(start);if(at<0)throw Error('Missing production line: '+start);return text.slice(at,text.indexOf('\n',at));}
const bot=(name:string)=>({name,inWorld:true,operation:'observed',fresh:true,pos:{x:3200,z:3200,level:0}});

// Production link, account pick, free/Watch and wall paths share one re-entrant render loop.
// Only unrelated page painting, viewer geometry and browser I/O are replaced here.
function linkedPage(hash:string,options:{restored?:boolean,state?:string}={}){
 const location={hash,pathname:'/dashboard',search:'?public=1',origin:'http://dashboard.test'},messages:any[]=[],moves:string[]=[],links:string[]=[];
 const window:any={atlasFreeCamera:false,atlasFollowOther:null,atlasDestination:null,atlasCamera:{goto:()=>{}}};
 const frame={postMessage:(message:any)=>messages.push(message)},element={classList:{remove:()=>{},add:()=>{}},focus:()=>{},blur:()=>{}};
 const history={replaceState:(_state:unknown,_title:string,url:string)=>{links.push(url);location.hash=new URL(url,location.origin).hash;}};
 const code=[
  line(page,'function pick(n){'),line(page,'window.atlasFollow3d='),
  section(page,'function render(){',"\n $('#pause')")+'}',
  section(shell,'  let linkedPluginRestored=false;','  let questAccount=null;'),
  section(shell,'  function refresh(){','    const b=account(),name=b?.name??null;')+'}',
  section(shell,'  const previousRender=render;','  rail.onclick='),
  line(shell,'  const focusLive='),line(shell,'  const focusTarget='),
  section(shell,'  const focusFree=','  // The viewer loads these places'),
  line(shell,'  function focusChoose('),
  line(shell,'  const wallIsName='),line(shell,'  const wallSame='),
  section(shell,'  function wallNames(){','  // The names of `names`'),
  section(shell,'  function wallOrdered(','  // The layout, the main view'),
  section(shell,'  function wallLinkRead(','  // After each choice:'),
  section(shell,'  function wallKeep(){','  // The views in the order'),
  section(shell,'  function wallStart(){','  // The tiling commands.'),
  section(shell,'  const previousSetMode=setMode;','  focusFind.addEventListener('),
  line(shell,'  window.atlasClient=')
 ].join('\n');
 const env={window,location,history,URLSearchParams,CSS:{escape:String},rail:{querySelector:()=>({})},
  $:()=>({contentWindow:frame}),focus:element,focusNote:element,focusNow:element,wallButton:element,hud:element,
  focusMoved:(_from:unknown,name:string)=>moves.push(name),focusOpen:()=>{},focusSay:()=>{},focusPaint:()=>{},wallPaint:()=>{},
  wallPost:(message:any)=>messages.push(message),wallDragEnd:()=>{},wallSizeEnd:()=>{},wallEdgeEnd:()=>{},wallHold:()=>null,wallStill:()=>true,
  openBank:()=>{},gamePanel:()=>{},minimap:()=>{},clearInterval:()=>{},setInterval:()=>0};
 const api=new Function(...Object.keys(env),`
  let S=null,sel=null,picked=false,mode='3d',view='world',detailPage=0,rswFor=null,selectedPlugin='fleet',selectedTab='inventory';
  let VIEWER={state:${JSON.stringify(options.state??'ready')},origin:location.origin},tourTimer=null,touring=false,focusRowsHtml='',flightTo=null,sentMaxLevel=null,warmSent='',depletedNow={list:[]};
  const MARK='MAIN',cam={user:false},WALL_MAX=16,WALL_NAME=/^[A-Za-z0-9_ -]{1,12}$/,WALL_LAYOUTS=['grid','main','focus','columns'],WALL_STORE='atlas-wall',WALL_GAP=4,WALL_GAP_COLOUR='#1e1e1e',WALL_RATIO=.62;
  const wallPrefs={layout:'grid',main:null,order:[],ratio:.62,locked:[],shares:{grid:{rows:[],cols:[]},columns:{rows:[],cols:[]}},strip:0};
  const localStorage={setItem:()=>{}},wallSharesOf=p=>({rows:p?.rows||[],cols:p?.cols||[]}),wallSizes=()=>({}),wallShown=()=>wall?[wall.main,...wall.names.filter(n=>n!==wall.main)]:[];
  const liveBots=()=>S?.bots||[],st=b=>['on',b.operation==='observed'?'playing':'in world'];
  let drawMap=()=>{},setMode=m=>{mode=m;};
  const tourSet=()=>{tourTimer=null;},tourStep=()=>{},showPlugin=id=>{selectedPlugin=id;};
  ${code}
  if(${options.restored!==false})restoreLinkedPlugin();
  return {receive:bots=>{S={bots};render();},stage:bots=>{S={bots};},refresh:()=>render(),
   plugin:id=>{selectedPlugin=id;writeLink();},restore:()=>{restoreLinkedPlugin();writeLink();},
   pick:name=>pick(name),follow:name=>window.atlasClient.follow(name),free:()=>focusChoose(''),watch:name=>window.atlasFollow3d(name),wall:()=>wallToggle(),
   viewerReady:()=>{VIEWER.state='ready';setMode('3d',true);render();},
   state:()=>({sel,picked,read:linkRead,free:window.atlasFreeCamera,watch:window.atlasFollowOther,wall:wall&&{names:[...wall.names],layout:wall.layout,main:wall.main},hash:location.hash})};
 `)(...Object.values(env));
 return {...api,messages,moves,links,query:()=>Object.fromEntries(new URLSearchParams(location.hash.slice(1)))};
}

test('a restored plugin preserves the full pending link through empty snapshots and plugin changes',()=>{
 const ui=linkedPage('#p=world&a=Target&watch=Visitor&cam=free&wall=1&wl=main&wm=Target',{restored:false});
 ui.plugin('boards');expect(ui.links).toEqual([]);ui.restore();ui.receive([]);ui.plugin('boards');ui.receive([]);
 expect(ui.query()).toEqual({p:'boards',a:'Target',watch:'Visitor',cam:'free',wall:'1',wl:'main',wm:'Target'});
 expect(ui.moves).toEqual([]);expect(ui.messages).toEqual([]);
});

test('an account link waits through an empty first snapshot, then selects its exact target once',()=>{
 const ui=linkedPage('#p=world&a=Target');ui.receive([]);expect(ui.query().a).toBe('Target');expect(ui.state().read).toBe(false);
 ui.receive([bot('Target')]);expect(ui.state()).toMatchObject({sel:'Target',picked:true,read:true});expect(ui.moves).toEqual(['Target']);
 ui.receive([bot('Target')]);ui.refresh();expect(ui.moves).toEqual(['Target']);expect(ui.query()).toEqual({p:'world',a:'Target'});
});

test('an unrelated automatic selection does not replace a missing linked target',()=>{
 const ui=linkedPage('#p=world&a=Target');ui.receive([bot('Other')]);expect(ui.state().sel).toBe('Other');expect(ui.query().a).toBe('Target');
 ui.receive([bot('Other'),bot('Another')]);expect(ui.query().a).toBe('Target');expect(ui.moves).toEqual([]);
 ui.receive([bot('Other'),bot('Target')]);expect(ui.state().sel).toBe('Target');expect(ui.moves).toEqual(['Target']);
});

test('linked account names retain the existing exact-case selection contract',()=>{
 const ui=linkedPage('#p=world&a=target');ui.receive([bot('Target')]);expect(ui.state().sel).toBe('Target');expect(ui.query().a).toBe('target');expect(ui.moves).toEqual([]);
 ui.receive([bot('target')]);expect(ui.state().sel).toBe('target');expect(ui.moves).toEqual(['target']);
});

test('a pending linked free camera is applied after its account resolves and is not repeated',()=>{
 const ui=linkedPage('#p=world&a=Target&cam=free');ui.receive([bot('Other')]);expect(ui.query()).toEqual({p:'world',a:'Target',cam:'free'});expect(ui.state().free).toBe(false);
 ui.receive([bot('Other'),bot('Target')]);expect(ui.state()).toMatchObject({sel:'Target',free:true,watch:null});expect(ui.moves).toEqual(['Target']);
 const freeMessages=()=>ui.messages.filter((m:any)=>m.atlasFreeCamera===true);expect(freeMessages()).toHaveLength(1);
 ui.refresh();ui.receive([bot('Target')]);expect(freeMessages()).toHaveLength(1);expect(ui.query()).toEqual({p:'world',a:'Target',cam:'free'});
});

test('a linked Watch and wall retain their directives and existing order while the account is pending',()=>{
 const ui=linkedPage('#p=world&a=Target&watch=Visitor&cam=free&wall=1&wl=main&wm=Target');ui.receive([]);ui.receive([bot('Other')]);
 expect(ui.query()).toEqual({p:'world',a:'Target',watch:'Visitor',cam:'free',wall:'1',wl:'main',wm:'Target'});expect(ui.messages).toEqual([]);
 ui.receive([bot('Other'),bot('Target')]);expect(ui.state()).toMatchObject({sel:'Target',free:false,watch:'Visitor',wall:{layout:'main',main:'Target'}});
 expect(ui.query()).toEqual({p:'world',a:'Target',watch:'Visitor',wall:'1',wl:'main',wm:'Target'});
 const follow=ui.messages.findIndex((m:any)=>m.follow==='Visitor'),multi=ui.messages.findIndex((m:any)=>Array.isArray(m.multi));expect(follow).toBeGreaterThanOrEqual(0);expect(multi).toBeGreaterThan(follow);
 ui.refresh();expect(ui.moves).toEqual(['Target']);expect(ui.messages.filter((m:any)=>m.follow==='Visitor')).toHaveLength(1);expect(ui.messages.filter((m:any)=>Array.isArray(m.multi))).toHaveLength(1);
});

test('viewer readiness and preserved mode callbacks do not consume a missing account link',()=>{
 const ui=linkedPage('#p=world&a=Target&watch=Visitor',{state:'loading'});ui.receive([bot('Other')]);ui.viewerReady();ui.refresh();
 expect(ui.query()).toEqual({p:'world',a:'Target',watch:'Visitor'});expect(ui.moves).toEqual([]);expect(ui.state().watch).toBeNull();
 ui.receive([bot('Other'),bot('Target')]);expect(ui.state()).toMatchObject({sel:'Target',watch:'Visitor'});expect(ui.moves).toEqual(['Target']);
});

test('links without an account keep their immediate camera, Watch and wall behavior',()=>{
 const free=linkedPage('#p=world&cam=free');free.receive([]);expect(free.state()).toMatchObject({sel:null,free:true,read:true});free.refresh();expect(free.messages.filter((m:any)=>m.atlasFreeCamera===true)).toHaveLength(1);
 const watch=linkedPage('#p=world&watch=Visitor&cam=free');watch.receive([]);expect(watch.state()).toMatchObject({watch:'Visitor',free:false,read:true});watch.refresh();expect(watch.messages.filter((m:any)=>m.follow==='Visitor')).toHaveLength(1);
 const wall=linkedPage('#p=world&wall=1&wl=main&wm=Other');wall.receive([bot('Other')]);expect(wall.state().wall).toMatchObject({layout:'main',main:'Other'});
});

test('a rejected Watch request does not consume a pending linked account',()=>{
 for(const state of ['ready','loading']){
  const ui=linkedPage('#p=world&a=Target',{state});ui.receive([bot('Other')]);
  expect(ui.watch(state==='ready'?'invalid<name>':'Visitor')).toBe(false);
  expect(ui.state().read).toBe(false);expect(ui.query().a).toBe('Target');
  ui.receive([bot('Other'),bot('Target')]);expect(ui.state().sel).toBe('Target');
 }
});

for(const action of ['pick','follow','free','watch','wall'] as const)test('manual '+action+' consumes pending intent before its re-entrant render',()=>{
 const ui=linkedPage('#p=world&a=Target&cam=free');ui.receive([bot('Other')]);
 // The next state is already present when the manual action triggers its first render.
 // Cancelling only after that render would briefly apply Target and the old camera directive.
 ui.stage([bot('Other'),bot('Target')]);
 if(action==='pick')ui.pick('Other');else if(action==='follow')ui.follow('Other');else if(action==='watch')expect(ui.watch('Visitor')).toBe(true);else if(action==='free')ui.free();else ui.wall();
 expect(ui.moves).not.toContain('Target');expect(ui.state().read).toBe(true);
 if(action==='free')expect(ui.state()).toMatchObject({sel:null,free:true,watch:null});
 else if(action==='watch')expect(ui.state()).toMatchObject({sel:'Other',watch:'Visitor',free:false});
 else if(action==='wall')expect(ui.state().wall).toMatchObject({names:['Other','Target']});
 else expect(ui.state()).toMatchObject({sel:'Other',free:false,watch:null});
 const chosen=ui.state();ui.receive([bot('Other'),bot('Target')]);ui.refresh();expect(ui.moves).not.toContain('Target');
 expect(ui.state()).toEqual(chosen);expect(ui.query().a).not.toBe('Target');
});
