import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');

test('the fleet search shortcut focuses the visible search control',()=>{
 const code=shell.slice(shell.lastIndexOf("  window.addEventListener('keydown'"),shell.indexOf('  window.atlasClient='));
 let handler:any,focused='',opened='';
 new Function('window','document','$','showPlugin',code)({addEventListener:(_t:string,f:any)=>handler=f},{body:{}},(s:string)=>({focus:()=>focused=s}),(id:string)=>opened=id);
 handler({key:'/',target:{tagName:'BODY'},preventDefault:()=>{},stopPropagation:()=>{}});
 expect(opened).toBe('fleet');expect(focused).toBe('#op-fleet-search');
});

test('Free camera clears the selected account and asks the 3D viewer to stop following',()=>{
 const code=shell.slice(shell.indexOf('  const focusFree='),shell.indexOf('  function focusStep('));
 const messages:any[]=[],window:any={atlasFollowOther:'Worker'};let renders=0;
 const selected=new Function('$','window','location','render',`let sel='Worker',picked=false,rswFor='Worker';${code};return()=>{focusFree();return sel;};`)(()=>({contentWindow:{postMessage:(m:any)=>messages.push(m)}}),window,{origin:'http://localhost'},()=>renders++);
 expect(selected()).toBeNull();expect(window.atlasFollowOther).toBeNull();expect(window.atlasFreeCamera).toBe(true);
 expect(messages).toEqual([{atlasFreeCamera:true}]);expect(renders).toBe(1);
});

function focusStepper(bots:any[],sel:string|null,window:any={}){
 const live=shell.slice(shell.indexOf('  const focusLive='),shell.indexOf('  function focusState('));
 const step=shell.slice(shell.indexOf('  function focusStep('),shell.indexOf('  function focusChoose('));
 const picks:string[]=[];
 return {picks,step:new Function('S','sel','window','pick',`${live}${step};return focusStep;`)({bots},sel,window,(n:string)=>picks.push(n))};
}

test('the step buttons walk only accounts in the world, in name order, and wrap round',()=>{
 const bots=[{name:'Zed',inWorld:true},{name:'Away',inWorld:false},{name:'Ann',inWorld:true},{name:'Lab',inWorld:true,practice:true}];
 const a=focusStepper(bots,'Zed');a.step(1);a.step(-1);expect(a.picks).toEqual(['Ann','Ann']);
 const b=focusStepper(bots,'Away',{atlasFreeCamera:true});b.step(1);b.step(-1);expect(b.picks).toEqual(['Ann','Zed']);
 const c=focusStepper([],null);c.step(1);expect(c.picks).toEqual([]);
});

function focusMoves(from:string|null,to:string|null,state='ready'){
 const code=shell.slice(shell.indexOf('  function focusMoved('),shell.indexOf('  const focusFree='));
 const said:string[]=[],classes=new Set<string>(),box={classList:{add:(c:string)=>classes.add(c),remove:(c:string)=>classes.delete(c)},offsetWidth:0};
 new Function('mode','VIEWER','focusTarget','safeName','focus','focusNote','focusSay','$','from','name',`let flightTo=null;${code};focusMoved(from,name);`)('3d',{state},()=>to,String,box,box,(s:string)=>said.push(s),()=>box,from,to??'Away');
 return {said,classes};
}

test('a switch shows a flight, also from free camera, or that the account is not in the world',()=>{
 expect(focusMoves('Ann','Zed').said).toEqual(['Flying to Zed']);expect(focusMoves('Ann','Zed').classes.has('flying')).toBe(true);
 expect(focusMoves(null,'Zed').said).toEqual(['Flying to Zed']);
 expect(focusMoves('Ann',null).said).toEqual(['Away is not in the world. The camera stays here.']);
 expect(focusMoves('Ann','Ann').said).toEqual([]);expect(focusMoves('Ann','Zed','loading').said).toEqual([]);
});

test('the switcher is the only follow control left on the page',()=>{
 const page=['client-shell.js','map-shell.js','operations.js','index.html'].map(f=>readFileSync(new URL('./'+f,import.meta.url),'utf8')).join('\n');
 for(const gone of ['atlas-locate',"'locate'",'data-act="follow"','data-world-go','id="bt"','TOUR_AT','client-account','dblclick'])expect(page).not.toContain(gone);
});

test('the tour steps through the switcher only while the 3D view is ready and shown',()=>{
 const code=shell.slice(shell.indexOf('  function tourStep(){'),shell.indexOf('  function tourSet('));
 const run=(mode:string,state:string,hidden:boolean)=>{const steps:number[]=[];new Function('mode','VIEWER','document','focusStep','let touring=false;'+code+';tourStep();')(mode,{state},{hidden},(n:number)=>steps.push(n));return steps;};
 expect(run('3d','ready',false)).toEqual([1]);
 expect(run('2d','ready',false)).toEqual([]);expect(run('3d','loading',false)).toEqual([]);expect(run('3d','ready',true)).toEqual([]);
});

test('a choice made in the 3D view ends the tour',()=>{
 expect(shell).toContain('window.atlasClient={follow:name=>{wallEnd(false);tourSet(false);previousPick(name);},');
 const code=shell.slice(shell.indexOf('  function tourStep(){'),shell.indexOf('  function tourSet('));
 const ended:boolean[]=[],steps:number[]=[];(globalThis as any).atlasFollowOther='Someone';
 try{new Function('mode','VIEWER','document','focusStep','tourSet','let touring=false;'+code+';tourStep();')('3d',{state:'ready'},{hidden:false},(n:number)=>steps.push(n),(on:boolean)=>ended.push(on));}finally{delete (globalThis as any).atlasFollowOther;}
 expect(ended).toEqual([false]);expect(steps).toEqual([]);
});

test('an open bank redraws newer observations and closes when its account changes',()=>{
 const code=shell.slice(shell.indexOf('  function openBank(){'),shell.indexOf('  // Orbs as RuneLite'));
 let current:any={name:'Worker',bankAt:1,bank:[{name:'Coins',count:10}]},removed=false;
 const nodes:any={};const node=(s:string)=>nodes[s]??=(s==='input'?{value:''}:{insertAdjacentHTML:()=>{},innerHTML:'',textContent:''});
 const modal:any={dataset:{},setAttribute:()=>{},querySelector:node,remove:()=>removed=true};
 new Function('account','document','hud','window','E','safeName','age','stackValue','gp','icon','qty','priceTip','statTip',`${code};openBank();`)(()=>current,{createElement:()=>modal},{querySelector:()=>null,append:()=>{}},{atlasOperator:()=>true},String,String,String,()=>({value:10,unpriced:0}),String,()=>'',String,()=> '',()=>'');
 expect(node('.bank-items').innerHTML).toContain('× 10');
 current={...current,bankAt:2,bank:[{name:'Coins',count:25}]};node('input').oninput();
 expect(node('.bank-items').innerHTML).toContain('× 25');
 current={name:'Other',bank:[]};node('input').oninput();expect(removed).toBe(true);
});

function questPanel(bot:any,filter='all'){
 const code=shell.slice(shell.indexOf("    if(selectedTab==='quests'&&questScope==='fleet')"),shell.indexOf("    if(selectedTab==='friends')"));
 return new Function('b','questFilter','E','age',`const selectedTab='quests',questQuery='',questDetail='',questScope='account',fleetQuests=()=>'',questScopeBar=()=>'';let html='';${code};return html;`)(bot,filter,String,String);
}

test('the account picker retains a missing chosen account instead of displaying Free camera',()=>{
 const code=shell.slice(shell.indexOf('  function accountChoices(){'),shell.indexOf('  function refresh(){'));
 const choices=new Function('S','sel','window',code+';return accountChoices();')({bots:[{name:'Other',inWorld:true}]},'Chosen',{});
 expect(choices).toContainEqual({name:'Chosen',inWorld:false,missing:true});
 expect(choices.filter((b:any)=>b.name==='Chosen')).toHaveLength(1);
 const followed=new Function('S','sel','window',code+';return accountChoices();')({bots:[]},null,{atlasFollowOther:'Stranger'});
 expect(followed).toContainEqual({name:'Stranger',inWorld:true,following:true});
});

test('quest points need a point observation, not the number of completed quests',()=>{
 const bot={quests:[{name:'One quest',state:'complete'}]};
 expect(questPanel(bot)).toContain('Quest Points: —');
 expect(questPanel({...bot,ranks:[{board:'Quest Points',level:4}]})).toContain('Quest Points: 4');
});

test('unknown quest flags stay separate from observed started quests',()=>{
 const bot={quests:[{name:'Unobserved quest',state:'unknown'},{name:'Observed quest',state:'started'}]};
 const panel=questPanel(bot,'in progress');
 expect(panel).toContain('Started 1');expect(panel).toContain('Unknown 1');expect(panel).not.toContain('data-quest="Unobserved quest"');
 expect(questPanel(bot,'unknown')).toContain('data-quest="Unobserved quest"');
});

test('a visitor reads job names as words and does not see housekeeping runs',()=>{
 const start=shell.indexOf('  window.atlasHousekeeping='),code=shell.slice(start,shell.indexOf('\n',shell.indexOf('  window.atlasJobName=')));
 const w:any={};new Function('window',code)(w);
 expect(w.atlasJobName('death-plateau-bread')).toBe('death plateau bread');
 expect(w.atlasJobName('feathers at the chicken pen 3017,3295')).toBe('feathers at the chicken pen');
 expect(w.atlasJobName('Grand Exchange trade')).toBe('Grand Exchange trade');
 for(const job of ['read-bank','recover-oreelse-mithril-qualified-entry','chain-herblore-order-mightyrod'])expect(w.atlasHousekeeping(job)).toBe(true);
 expect(w.atlasHousekeeping('fire and earth runes from Betty')).toBe(false);
});

test('friends use world presence rather than the age of the last status file',()=>{
 const code=shell.slice(shell.indexOf("    if(selectedTab==='friends')"),shell.indexOf("    if(selectedTab==='settings')"));
 const friends=(owner:boolean)=>new Function('S','E','safeName','window',`const selectedTab='friends';let html='';${code};return html;`)({bots:[{name:'Offline',fresh:true,inWorld:false},{name:'Online',fresh:false,inWorld:true}]},String,String,{atlasOperator:()=>owner});
 const html=friends(true);
 expect(html).toContain('<span>Offline</span><span class="friend-off">Offline</span>');
 expect(html).toContain('<span>Online</span><span class="friend-on">local</span>');
 expect(friends(false)).toContain('<span>Online</span><span class="friend-on">Online</span>');
 expect(html.indexOf('data-friend="Online"')).toBeLessThan(html.indexOf('data-friend="Offline"'));
});

test('the Playing overlay excludes a freshly logged-out account',()=>{
 const code=shell.slice(shell.indexOf('  function overlay(){'),shell.indexOf('    const [,state]=st(b);'));
 const element={innerHTML:''};
 new Function('S','account','hud','E','window',`${code}};overlay();`)({bots:[{name:'Stopped',fresh:true,operation:'offline'}]},()=>null,{querySelector:()=>element},String,{atlasOperator:()=>true});
 expect(element.innerHTML).toContain('<span>Playing</span><b>0 / 1</b>');
});

test('infoboxes: boosted and drained skills of the followed account; Hitpoints and Prayer stay in the orbs',()=>{
 const code=shell.slice(shell.indexOf('  function infoboxes(){'),shell.indexOf('  // Board progress'));
 const el={innerHTML:''};
 const run=new Function('account','hud','E','asset','skillFile','dur','age','realSkill',code+';infoboxes();');
 const skills=[{name:'Attack',level:60,currentLevel:65},{name:'Strength',level:50,currentLevel:45},{name:'Defence',level:40,currentLevel:40},{name:'Hitpoints',level:56,currentLevel:30},{name:'Prayer',level:43,currentLevel:0}];
 run(()=>({name:'Worker',skills}),{querySelector:()=>el},String,(n:string)=>n,(n:string)=>n.toLowerCase(),String,String,(k:any)=>k.name!=='Overall');
 expect(el.innerHTML).toContain('class="infobox boost-up" title="Attack boosted: 65 / 60"');
 expect(el.innerHTML).toContain('class="infobox boost-down" title="Strength drained: 45 / 50"');
 expect(el.innerHTML).not.toContain('Defence');expect(el.innerHTML).not.toContain('Hitpoints');expect(el.innerHTML).not.toContain('Prayer');
});

function lookupHarness(fetch:(url:any)=>Promise<unknown>){
 const code=shell.slice(shell.indexOf('  function refreshWorldLookup(){'),shell.indexOf('  window.atlasLookup=lookup;'));
 const target={innerHTML:''};
 return new Function('fetch','body','lookupCard','put',`let worldLookup=null,worldLookupRequest=0,selectedPlugin='boards',hiscoreName='',hiscoreSel=null,sel=null,hiscoresMode='fleet';const S=null,showPlugin=()=>{},refreshHiscoreAccount=()=>{};${code};return{lookup,value:()=>worldLookup};`)(fetch,{querySelector:()=>target},JSON.stringify,(el:{innerHTML:string},html:string)=>el.innerHTML=html);
}

test('player lookup shows HTTP errors instead of an unnamed empty player',async()=>{
 const h=lookupHarness(async()=>Response.json({error:'Player service unavailable'},{status:503}));
 h.lookup('Worker');await Bun.sleep(0);
 expect(h.value().name).toBe('Worker');expect(h.value().note).toContain('Player service unavailable');
});

test('an old lookup failure cannot overwrite the player chosen afterward',async()=>{
 let rejectOld!:(error:Error)=>void;
 const h=lookupHarness((url:any)=>String(url).includes('Old')?new Promise((_resolve,reject)=>{rejectOld=reject;}):Promise.resolve(Response.json({name:'New',rows:[]})));
 h.lookup('Old');h.lookup('New');await Bun.sleep(0);rejectOld(Error('Old lookup failed'));await Bun.sleep(0);
 expect(h.value().name).toBe('New');expect(h.value().rows).toEqual([]);
});

test('infoboxes: a reached goal has no goal box', () => {
 const code=shell.slice(shell.indexOf('  function infoboxes(){'),shell.indexOf('  // Board progress'));
 const el={innerHTML:''};
 const run=new Function('account','hud','E','asset','skillFile','dur','age','realSkill',code+';infoboxes();');
 const stubs=[{querySelector:()=>el},String,(n:string)=>n,(n:string)=>n.toLowerCase(),String,String,(k:any)=>k.name!=='Overall'] as const;
 run(()=>({name:'Worker',goalSkill:'Thieving',goalLevel:99,goalNow:99,eta:'0m 0s',skills:[]}),...stubs);expect(el.innerHTML).not.toContain('Thieving');
 run(()=>({name:'Worker',goalSkill:'Thieving',goalLevel:99,goalNow:60,eta:'2h',skills:[]}),...stubs);expect(el.innerHTML).toContain('Thieving 60 → 99 in 2h');
});

test('Connection lost stays off the 3D view while the hosted stale bar reports old data',()=>{
 const line=shell.split('\n').find(l=>l.startsWith('  function screens()'))!;
 const lostFor=(stale:boolean,age:number)=>{
  const lost={hidden:true},hud={querySelector:(s:string)=>s==='#game-lost'?lost:null};
  const document={documentElement:{classList:{contains:(c:string)=>stale&&c==='fleet-stale'}}};
  new Function('hud','document','S','connected','lastReceived',`${line};screens();`)(hud,document,{},true,Date.now()-age);
  return !lost.hidden;
 };
 expect(lostFor(false,60_000)).toBe(true);
 expect(lostFor(false,1000)).toBe(false);
 expect(lostFor(true,60_000)).toBe(false);
});

// A stand-in for the few DOM calls the wall makes: elements keep what the code sets on them.
function fakeDom(){
 const all:any[]=[];
 const createElement=(tag:string)=>{
  const el:any={tagName:tag.toUpperCase(),className:'',children:[] as any[],parent:null,next:null,dataset:{},attrs:{} as Record<string,string>,listeners:{} as Record<string,Function>,hidden:false,textContent:'',innerHTML:'',title:'',rect:{left:0,top:0,width:0,height:0},offsetWidth:0,
   style:{setProperty(k:string,v:string){this[k]=v;}} as any,
   classList:{contains:(c:string)=>el.className.split(' ').includes(c),add:(...c:string[])=>{for(const x of c)if(!el.classList.contains(x))el.className=(el.className+' '+x).trim();},remove:(...c:string[])=>{el.className=el.className.split(' ').filter((x:string)=>!c.includes(x)).join(' ');},toggle:(c:string,on:boolean)=>on?el.classList.add(c):el.classList.remove(c)},
   append:(...c:any[])=>{for(const x of c){x.parent=el;el.children.push(x);}},remove:()=>{if(el.parent)el.parent.children=el.parent.children.filter((x:any)=>x!==el);el.parent=null;},after:(x:any)=>{el.next=x;},
   setAttribute:(k:string,v:string)=>{el.attrs[k]=v;},getAttribute:(k:string)=>el.attrs[k]??null,addEventListener:(t:string,f:Function)=>{el.listeners[t]=f;},blur:()=>{},getBoundingClientRect:()=>el.rect};
  all.push(el);return el;
 };
 return {createElement,all,byClass:(c:string)=>all.filter(e=>e.className.split(' ').includes(c))};
}
const fakeStore=(start:Record<string,string>={})=>{const data={...start};return {data,getItem:(k:string)=>data[k]??null,setItem:(k:string,v:string)=>{data[k]=String(v);}};};
// The Fleet wall code with the page state it reads. Every message to the viewer and every pick() lands in one log.
function fleetWall(bots:any[],start:{sel?:string|null,free?:boolean,other?:string|null,mode?:string,state?:string,touring?:boolean,store?:any,still?:boolean}={}){
 const live=shell.slice(shell.indexOf('  const focusLive='),shell.indexOf('  function focusState('));
 const state=shell.slice(shell.indexOf('  function focusState('),shell.indexOf('  function focusRows('));
 const code=shell.slice(shell.indexOf('  // Fleet wall:'),shell.indexOf("  focusFind.addEventListener('input',focusRows);"));
 const phone={matches:false},log:any[]=[],said:string[]=[],classes={add:()=>{},remove:()=>{}},dom=fakeDom(),frames:Function[]=[],links:number[]=[];
 const window:any={atlasFreeCamera:!!start.free,atlasFollowOther:start.other??null,atlasFollow3d:()=>true,matchMedia:(q:string)=>({matches:!!start.still&&q.includes('reduce')})};
 const S={bots},VIEWER={state:start.state??'ready',origin:'http://localhost'},store=start.store??fakeStore();
 const st=(b:any)=>b.inWorld&&b.fresh&&b.action!=='idle'?['on','playing']:['wd','in world'];
 const frame={contentWindow:{postMessage:(m:any)=>log.push(m)},rect:{left:0,top:48,width:1048,height:757},getBoundingClientRect(){return this.rect;}};
 const hud=dom.createElement('div'),wallButton=dom.createElement('button');
 const api=new Function('S','VIEWER','window','MARK','st','$','focusSay','focusOpen','focus','focusNote','log','safeName','phoneWidth','document','hud','wallButton','localStorage','writeLink','requestAnimationFrame',`
  let keysOpened=0;window.atlasWallKeys=()=>{keysOpened++;};
  let mode=${JSON.stringify(start.mode??'3d')},sel=${JSON.stringify(start.sel??null)},wall=null,wallLinked=false,tourTimer=${start.touring?'setInterval(()=>{},1e9)':'null'},focusRowsHtml='',flightTo=null,sentMaxLevel=2,warmSent='x',rswFor=sel,paints=0,renders=0;
  const TOUR_MS=45000,tourStep=()=>{},focusPaint=()=>{paints++;},render=()=>{renders++;};
  let pick=name=>{wallEnd(false);log.push({pick:name});sel=name;window.atlasFreeCamera=false;},setMode=m=>{mode=m;};
  ${live}${state}${code}
  return {start:wallStart,end:wallEnd,toggle:wallToggle,sync:wallSync,message:wallMessage,names:wallNames,on:()=>!!wall,label:()=>focusState(),link:()=>{wallLinked=true;},
   press:wallPress,frameKey:wallFrameKey,neighbour:wallNeighbour,rects:wallRects,prefs:wallPrefs,prefsRead:wallPrefsRead,linkRead:wallLinkRead,linkWrite:wallLinkWrite,layoutTo:wallLayout,
   wall:()=>wall&&{layout:wall.layout,main:wall.main,focus:wall.focus,names:wall.names.slice(),hover:wall.hover},tiles:()=>new Map([...wallTiles].map(([n,t])=>[n,t])),root:wallRoot,tools:wallTools,keysOpened:()=>keysOpened,pin:wallPin,sharesAt:wallSharesAt,edges:wallEdges,ratioAt:wallRatioAt,grip:wallGrip,ghost:wallGhost,
   page:()=>({sel,free:window.atlasFreeCamera,other:window.atlasFollowOther,touring:!!tourTimer,sentMaxLevel,warmSent,rswFor,renders}),setMode:m=>setMode(m),stopTour:()=>clearInterval(tourTimer)};`)
  (S,VIEWER,window,'⟦MAIN⟧',st,()=>frame,(t:string)=>said.push(t),()=>{},{classList:classes},{classList:classes},log,(n:string)=>String(n).replaceAll('⟦MAIN⟧','Main · reserved'),phone,{createElement:dom.createElement},hud,wallButton,store,()=>links.push(1),(f:Function)=>frames.push(f));
 // The viewer's report of the layout for the asked names, and the frame that shows it. Times are ms after the page's time origin.
 const grid=(names:string[],cols=2,w=500,h=300)=>names.map((name,i)=>({name,x:(i%cols)*(w+4),y:Math.floor(i/cols)*(h+4),w,h}));
 const laid=(rects:any[],more:any={})=>{api.message({viewerMultiLayout:{mode:'grid',main:null,focus:null,rects,animating:false,ms:0,at:performance.timeOrigin,...more}});for(const f of frames.splice(0))f(more.frameAt??0);};
 // The frame of the 3D view starts 48 px down the page and the frames' box 28 px down: a view at y is drawn at y + 20.
 api.root.rect={left:0,top:28,width:0,height:0};
 return {...api,log,said,S,VIEWER,window,phone,dom,store,frame,frames,hud,wallButton,links,grid,laid,multis:()=>log.filter(m=>'multi' in m),since:(n:number)=>log.slice(n)};
}
const inWorld=(name:string,more:any={})=>({name,inWorld:true,...more});
const opening=(names:string[],layout='grid',main=names[0],animate=true)=>[{multiChrome:false},{multiLayout:{mode:layout,main,gap:4,color:'#1e1e1e',animate}},{multi:names},{multiFocus:main}];

test('the wall asks for our accounts in the world: playing ones first, then name order, at most 16',()=>{
 const bots=[inWorld('Zed'),inWorld('Ann'),{name:'Away',inWorld:false,fresh:true},inWorld('Lab',{practice:true}),inWorld('Mid',{fresh:true}),inWorld('Bee',{fresh:true,action:'idle'}),inWorld('Cat',{fresh:true}),inWorld('bad<name>'),inWorld('ThirteenChars')];
 expect(fleetWall(bots).names()).toEqual(['Cat','Mid','Ann','Bee','Zed']);
 const many=Array.from({length:20},(_,i)=>inWorld('Bot'+String(i).padStart(2,'0'),{fresh:i>=17}));
 const w=fleetWall(many);expect(w.names()).toHaveLength(16);expect(w.names().slice(0,4)).toEqual(['Bot17','Bot18','Bot19','Bot00']);
 expect(w.start()).toBe(true);expect(w.multis()).toEqual([{multi:w.names()}]);
 expect(w.label()[0]).toBe('Wall · 0 of 16 shown');expect(w.label()[2]).toContain('16 of our 20 accounts');
});

test('the wall does not open with none of our accounts in the world, in the 2D map, or before the viewer is ready',()=>{
 const none=fleetWall([{name:'Away',inWorld:false}]);
 expect(none.start()).toBe(false);expect(none.on()).toBe(false);expect(none.log).toEqual([]);expect(none.said).toEqual(['None of our accounts is in the world. The wall has nothing to show.']);
 for(const start of [{mode:'2d'},{state:'loading'},{state:'unavailable'}]){const w=fleetWall([inWorld('Ann')],start);expect(w.start()).toBe(false);expect(w.log).toEqual([]);expect(w.said).toEqual([]);}
});

test('the wall opens with the layout first, then the names, then the focus; the viewer draws no names of its own',()=>{
 const w=fleetWall([inWorld('Ann'),inWorld('Bob')]);w.start();
 expect(w.log).toEqual(opening(['Ann','Bob']));
 expect(w.wall()).toEqual({layout:'grid',main:'Ann',focus:'Ann',names:['Ann','Bob'],hover:null});
 expect(w.tools.hidden).toBe(false);expect(w.said.at(-1)).toContain('double click to follow');
});

test('the wall asks again only when an account enters or leaves the world; the views that stay keep their order',()=>{
 const w=fleetWall([inWorld('Ann'),inWorld('Bob')]);w.start();
 w.sync();w.S.bots[1].fresh=true;w.sync();w.S.bots.reverse();w.sync();
 expect(w.multis()).toEqual([{multi:['Ann','Bob']}]);
 // A new account goes last, whatever its place in the page's own order.
 w.S.bots.push(inWorld('Aaa',{fresh:true}));w.sync();w.sync();
 expect(w.multis()).toEqual([{multi:['Ann','Bob']},{multi:['Ann','Bob','Aaa']}]);
 let mark=w.log.length;
 // The focused main view leaves: the next view in the order is the main view and has the focus.
 w.S.bots.find((b:any)=>b.name==='Ann').inWorld=false;w.sync();
 expect(w.since(mark)).toEqual([{multi:['Bob','Aaa']},{multiLayout:{main:'Bob'}},{multiFocus:'Bob'}]);
 expect(w.wall()).toMatchObject({main:'Bob',focus:'Bob',names:['Bob','Aaa']});
 // A view that is neither leaves: the main view and the focus stay.
 mark=w.log.length;w.S.bots.find((b:any)=>b.name==='Aaa').inWorld=false;w.sync();
 expect(w.since(mark)).toEqual([{multi:['Bob']}]);
 // The last account leaves: the wall closes and says why.
 mark=w.log.length;for(const b of w.S.bots)b.inWorld=false;w.sync();
 expect(w.on()).toBe(false);expect(w.since(mark)).toEqual([{multi:[]},{atlasFreeCamera:true}]);expect(w.said.at(-1)).toContain('The wall is closed');
});

test('when the last view of the order leaves as main, the view before it takes the main place',()=>{
 const w=fleetWall([inWorld('Ann'),inWorld('Bob'),inWorld('Cat')]);w.start();
 w.laid(w.grid(['Ann','Bob','Cat'],3));w.press('3',false);w.press('Enter',false);
 expect(w.wall()).toMatchObject({main:'Cat',focus:'Cat'});
 w.S.bots.pop();w.sync();
 expect(w.wall()).toMatchObject({main:'Bob',focus:'Bob',names:['Ann','Bob']});
});

test('the wall status counts the views that show their player, from a viewer status for the asked list only',()=>{
 const w=fleetWall([inWorld('Ann'),inWorld('Bob'),inWorld('Cat')]);w.start();
 w.message({viewerMulti:{names:['Ann','Bob','Cat'],shown:['Ann','Cat'],offline:[]}});expect(w.label()[0]).toBe('Wall · 2 of 3 shown');
 for(const bad of [{names:['Ann'],shown:['Ann'],offline:[]},{names:['Ann','Bob','Cat'],shown:'Ann',offline:[]},{names:['Ann','Bob','Cat'],shown:[1,2,3],offline:[]},{names:['Ann','Bob','Cat'],shown:['A','B','C','D'],offline:[]},null,'x'])w.message({viewerMulti:bad});
 expect(w.label()[0]).toBe('Wall · 2 of 3 shown');
 // A phone has a narrow switcher.
 w.phone.matches=true;expect(w.label()[0]).toBe('Wall · 2/3');
 // Each frame shows the state of its view: found, still being found, or not online.
 w.laid(w.grid(['Ann','Bob','Cat'],3));
 w.S.bots[0].fresh=true;w.S.bots[0].phaseShort='Fishing sharks';
 w.message({viewerMulti:{names:['Ann','Bob','Cat'],shown:['ann'],offline:['Cat','Eve']}});
 const t=w.tiles();
 expect([t.get('Ann').dot.className,t.get('Bob').dot.className,t.get('Cat').dot.className]).toEqual(['wall-dot on','wall-dot finding','wall-dot off']);
 expect([t.get('Ann').note.textContent,t.get('Bob').note.textContent,t.get('Cat').note.textContent]).toEqual(['Fishing sharks','finding…','not online']);
});

test('a click on a view focuses it; a second click on the same view follows that account through pick()',()=>{
 const w=fleetWall([inWorld('Ann'),inWorld('Bob')],{sel:'Ann'});w.start();const mark=w.log.length;
 // A reply that names another account, or no view of the wall, is not a click.
 for(const bad of [{viewerMultiPick:'Eve',index:1},{viewerMultiPick:'Bob',index:5},{viewerMultiPick:'Bob',index:'1'},{viewerMultiPick:1,index:1},{index:1}])w.message(bad);
 expect(w.on()).toBe(true);expect(w.since(mark)).toEqual([]);
 w.message({viewerMultiPick:'bob',index:1});
 expect(w.since(mark)).toEqual([{multiFocus:'Bob'}]);expect(w.on()).toBe(true);expect(w.wall()).toMatchObject({focus:'Bob',main:'Ann'});
 // A click on another view starts again: one click each is no double click.
 w.message({viewerMultiPick:'Ann',index:0});w.message({viewerMultiPick:'Bob',index:1});
 expect(w.on()).toBe(true);expect(w.since(mark)).toEqual([{multiFocus:'Bob'},{multiFocus:'Ann'},{multiFocus:'Bob'}]);
 // Two slow clicks are two clicks.
 const now=Date.now;try{Date.now=()=>now()+5000;w.message({viewerMultiPick:'Bob',index:1});}finally{Date.now=now;}
 expect(w.on()).toBe(true);
 // The double click: the viewer keeps that view as its single view, the wall closes, then the page follows.
 const at=w.log.length;w.message({viewerMultiPick:'Bob',index:1});w.message({viewerMultiPick:'Bob',index:1});
 expect(w.since(at)).toEqual([{multiFocus:'Bob'},{multi:[]},{pick:'Bob'}]);expect(w.on()).toBe(false);expect(w.said.at(-1)).toBe('Now watching Bob');
 // The viewer build's own report of the same click finds no wall.
 const end=w.log.length;w.message({viewerMultiPick:'Bob',index:1});expect(w.log).toHaveLength(end);
 // The roof and prewarm messages start again from nothing.
 expect(w.page()).toMatchObject({sentMaxLevel:null,warmSent:''});
});

test('closing the wall returns to what the page followed, and the tour runs on',()=>{
 const followed=fleetWall([inWorld('Ann'),inWorld('Bob')],{sel:'Bob',touring:true});followed.start();
 expect(followed.page().touring).toBe(false);
 followed.window.atlasFreeCamera=true;const mark=followed.log.length;followed.end();
 expect(followed.since(mark)).toEqual([{multi:[]},{follow:'Bob'}]);
 expect(followed.page()).toMatchObject({sel:'Bob',free:false,other:null,touring:true,rswFor:'Bob'});followed.stopTour();
 expect(followed.tools.hidden).toBe(true);expect(followed.tiles().size).toBe(0);
 const free=fleetWall([inWorld('Ann')],{sel:'Ann',free:true});free.toggle();free.toggle();
 expect(free.log).toEqual([...opening(['Ann']),{multi:[]},{atlasFreeCamera:true}]);expect(free.page()).toMatchObject({free:true,renders:2});
 const other=fleetWall([inWorld('Ann')],{sel:'Ann',other:'Stranger'});other.start();other.end();
 expect(other.log.slice(-2)).toEqual([{multi:[]},{follow:'Stranger'}]);
 // The 3D view went away: nothing is left to tell.
 const lost=fleetWall([inWorld('Ann')],{sel:'Ann'});lost.start();lost.setMode('2d');
 expect(lost.on()).toBe(false);expect(lost.log).toEqual(opening(['Ann']));
});

test('a link with wall=1 opens the wall when the viewer is ready and an account is in the world',()=>{
 const w=fleetWall([inWorld('Ann')],{state:'loading'});w.link();w.sync();expect(w.on()).toBe(false);
 w.VIEWER.state='ready';w.sync();expect(w.on()).toBe(true);expect(w.multis()).toEqual([{multi:['Ann']}]);
 // With the live roster in and nobody of ours on it, the link opens no wall and the page says so once.
 const none=fleetWall([],{});none.window.atlasLiveRoster=()=>true;none.link();none.sync();none.sync();
 expect(none.on()).toBe(false);expect(none.said).toHaveLength(1);
 const link=shell.slice(shell.indexOf('  function writeLink(){'),shell.indexOf('  let questAccount=null;'));
 expect(link).toContain('if(wall||wallLinked)wallLinkWrite(q);');expect(link).toContain("['a','watch','cam','wall','wl','wm']");
 expect(shell).toContain("wallLinked=q.get('wall')==='1';wallLinkRead(q);");
});

test('the share link carries the layout and the main view, and a load of it opens the wall the same way',()=>{
 const bots=()=>[inWorld('Ann'),inWorld('Bob'),inWorld('Cat')];
 const w=fleetWall(bots());w.start();w.laid(w.grid(['Ann','Bob','Cat'],3));
 w.press('ArrowRight',false);w.press('Enter',false);w.press(' ',false);
 expect(w.wall()).toMatchObject({layout:'main',main:'Bob'});expect(w.links.length).toBeGreaterThan(0);
 const q=new URLSearchParams({p:'fleet'});w.linkWrite(q);
 expect(q.toString()).toBe('p=fleet&wall=1&wl=main&wm=Bob');
 const loaded=fleetWall(bots());loaded.linkRead(new URLSearchParams(q.toString()));loaded.start();
 expect(loaded.log).toEqual(opening(['Ann','Bob','Cat'],'main','Bob'));
 // A value that is no layout or no name is dropped; a main view that is not in the world gives the first view.
 const bad=fleetWall(bots());bad.linkRead(new URLSearchParams('wall=1&wl=spiral&wm=%3Cb%3E'));bad.start();
 expect(bad.log).toEqual(opening(['Ann','Bob','Cat']));
 const gone=fleetWall(bots());gone.linkRead(new URLSearchParams('wall=1&wl=focus&wm=Zed'));gone.start();
 expect(gone.log).toEqual(opening(['Ann','Bob','Cat'],'focus','Ann'));
});

test('the layout, the main view and a hand-made order stay in the browser storage',()=>{
 const bots=()=>[inWorld('Ann'),inWorld('Bob'),inWorld('Cat'),inWorld('Dan')],store=fakeStore();
 const w=fleetWall(bots(),{store});w.start();w.laid(w.grid(['Ann','Bob','Cat','Dan']));
 expect(store.data['atlas-wall']).toBeUndefined();
 w.press('f',false);
 expect(JSON.parse(store.data['atlas-wall'])).toEqual({layout:'focus',main:'Ann',order:[],ratio:0.62,locked:[],shares:{grid:{rows:[],cols:[]},columns:{rows:[],cols:[]}},strip:0});
 w.press('f',false);w.laid(w.grid(['Ann','Bob','Cat','Dan']));
 // Dan goes to Bob's place: the order is now the user's.
 w.press('4',false);w.press('ArrowUp',true);
 expect(JSON.parse(store.data['atlas-wall'])).toEqual({layout:'grid',main:'Ann',order:['Ann','Dan','Cat','Bob'],ratio:0.62,locked:[],shares:{grid:{rows:[],cols:[]},columns:{rows:[],cols:[]}},strip:0});
 w.end();
 // The next wall, with one account gone and one new: the stored order, then the new account.
 const next=fleetWall([inWorld('Eve'),inWorld('Dan'),inWorld('Cat'),inWorld('Ann')],{store});next.start();
 expect(next.log).toEqual(opening(['Ann','Dan','Cat','Eve']));
 // Storage that fails, or holds something else, leaves the wall as a grid in the page's order.
 const broken=fleetWall(bots(),{store:{getItem(){throw Error('denied');},setItem(){throw Error('denied');}}});
 broken.start();broken.press(' ',false);expect(broken.wall()).toMatchObject({layout:'main'});
 for(const text of ['{','null','[1]','{"layout":"spiral","main":"<b>","order":["Ann",5,"<i>"]}']){
  const odd=fleetWall(bots(),{store:fakeStore({'atlas-wall':text})});odd.start();expect(odd.log).toEqual(opening(['Ann','Bob','Cat','Dan']));
 }
 expect(w.prefsRead('{"layout":"columns","main":"⟦MAIN⟧","order":["Bob","⟦MAIN⟧"]}')).toEqual({layout:'columns',main:'⟦MAIN⟧',order:['Bob','⟦MAIN⟧'],ratio:0.62,locked:[],shares:{grid:{rows:[],cols:[]},columns:{rows:[],cols:[]}},strip:0});
 expect(w.prefsRead('{"ratio":0.7,"locked":["Bob",5,"<i>"]}')).toMatchObject({ratio:0.7,locked:['bob']});
 expect(w.prefsRead('{"ratio":0.95}')).toMatchObject({ratio:0.62});
});

// A pointer on a title strip, at page coordinates. The frame of the 3D view starts 48 px down the page.
const stripDrag=(w:any,name:string,to:{x:number,y:number}|null,from={x:20,y:58})=>{
 const strip=w.tiles().get(name).strip,ev=(x:number,y:number)=>({button:0,pointerId:7,clientX:x,clientY:y,target:{closest:()=>null}});
 strip.listeners.pointerdown(ev(from.x,from.y));
 if(to){strip.listeners.pointermove(ev(to.x,to.y));strip.listeners.pointerup(ev(to.x,to.y));}else strip.listeners.pointerup(ev(from.x,from.y));
};

test('a drag of a title strip onto another view swaps the two views; a short move stays a click',()=>{
 const names=['Ann','Bob','Cat','Dan'],w=fleetWall(names.map(n=>inWorld(n)));w.start();w.laid(w.grid(names));
 // 3 px is not a drag: nothing is sent and the label stays hidden.
 let mark=w.log.length;stripDrag(w,'Ann',{x:22,y:60});
 expect(w.since(mark)).toEqual([]);expect(w.ghost.hidden).toBe(true);
 // Bob (top right) dragged onto Cat (bottom left): Bob and Cat change places and Bob has the focus.
 mark=w.log.length;stripDrag(w,'Bob',{x:100,y:48+304+100},{x:520,y:58});
 expect(w.since(mark)).toEqual([{multiFocus:'Bob'},{multiOrder:['Ann','Cat','Bob','Dan']}]);
 expect(w.wall()).toMatchObject({names:['Ann','Cat','Bob','Dan'],focus:'Bob',main:'Ann'});expect(w.ghost.hidden).toBe(true);
 // A view dropped on the first place becomes the main view.
 w.laid(w.grid(['Ann','Cat','Bob','Dan']));mark=w.log.length;stripDrag(w,'Dan',{x:100,y:48+100},{x:520,y:48+304+10});
 expect(w.since(mark)).toEqual([{multiFocus:'Dan'},{multiOrder:['Dan','Cat','Bob','Ann']},{multiLayout:{main:'Dan'}}]);
 // A drop outside every view moves nothing.
 w.laid(w.grid(['Dan','Cat','Bob','Ann']));mark=w.log.length;stripDrag(w,'Cat',{x:5000,y:5000},{x:520,y:58});
 expect(w.since(mark)).toEqual([]);
});

test('a pinned view keeps its place: no drag, swap or new main view moves it, and it returns to its place',()=>{
 const names=['Ann','Bob','Cat','Dan'],store=fakeStore(),w=fleetWall(names.map(n=>inWorld(n)),{store});w.start();w.laid(w.grid(names));
 w.press('2',false);w.press('p',false);
 expect(w.tiles().get('Bob').pin.attrs['aria-pressed']).toBe('true');expect(w.tiles().get('Bob').el.className).toContain('wall-locked');
 expect(JSON.parse(store.data['atlas-wall']).locked).toEqual(['bob']);
 // Bob does not move by a drag, as the source or as the target, by Shift and an arrow, or by Enter.
 let mark=w.log.length;stripDrag(w,'Bob',{x:100,y:48+304+100},{x:520,y:58});stripDrag(w,'Cat',{x:600,y:100},{x:20,y:48+304+10});
 w.press('ArrowLeft',true);w.press('Enter',false);
 expect(w.since(mark)).toEqual([]);expect(w.wall()!.names).toEqual(names);
 // Ann leaves the world: Bob stays the second view, and the next view takes the first place.
 w.S.bots.splice(0,1);mark=w.log.length;w.sync();
 expect(w.since(mark)).toEqual([{multi:['Cat','Bob','Dan']},{multiOrder:['Cat','Bob','Dan']},{multiLayout:{main:'Cat'}}]);
 // The pin on the title strip takes the pin off.
 w.tiles().get('Bob').strip.listeners.click({target:{closest:(q:string)=>q==='.wall-pin'?{}:null}});
 expect(JSON.parse(store.data['atlas-wall']).locked).toEqual([]);
});

test('the gap of the Main and stack layout sizes the main view between 50 and 80 percent, with stops',()=>{
 expect(w0.ratioAt(0,1000,false)).toBe(0.5);expect(w0.ratioAt(990,1000,false)).toBe(0.8);
 // 624 px of 1000 is within 1.2 percent of the first share; with Alt the pointer's own share is taken.
 expect(w0.ratioAt(626,1000,false)).toBe(0.62);expect(w0.ratioAt(700,1000,true)).toBe(0.701);expect(w0.ratioAt(668,1000,false)).toBe(0.667);
 const names=['Ann','Bob','Cat'],store=fakeStore(),w=fleetWall(names.map(n=>inWorld(n)),{store});w.start();w.press(' ',false);
 w.laid([{name:'Ann',x:0,y:0,w:647,h:757},{name:'Bob',x:651,y:0,w:397,h:376},{name:'Cat',x:651,y:380,w:397,h:377}]);
 expect(w.grip.hidden).toBe(false);expect(w.grip.dataset.side).toBe('col');expect(w.grip.style.left).toBe('644px');
 const ev=(x:number)=>({button:0,pointerId:3,clientX:x,clientY:300,altKey:false});
 let mark=w.log.length;w.grip.listeners.pointerdown(ev(649));w.grip.listeners.pointermove(ev(786));for(const f of w.frames.splice(0))f(0);w.grip.listeners.pointerup(ev(786));
 expect(w.since(mark)).toEqual([{multiLayout:{animate:false}},{multiLayout:{ratio:0.75}},{multiLayout:{ratio:0.75,animate:true}}]);
 expect(JSON.parse(store.data['atlas-wall']).ratio).toBe(0.75);
 // The next wall opens with that share. In another layout there is no grip.
 w.end();const next=fleetWall(names.map(n=>inWorld(n)),{store});next.start();
 expect(next.log[1]).toEqual({multiLayout:{mode:'main',main:'Ann',gap:4,ratio:0.75,color:'#1e1e1e',animate:true}});
 next.press(' ',false);next.laid(next.grid(names));expect(next.grip.hidden).toBe(true);
});
const w0=fleetWall([inWorld('Ann')]);

test('the hidden account goes to the viewer and comes back as its mark only',()=>{
 const store=fakeStore(),w=fleetWall([inWorld('⟦MAIN⟧',{fresh:true}),inWorld('Ann')],{store});w.start();
 expect(w.log).toEqual(opening(['⟦MAIN⟧','Ann']));
 w.message({viewerMulti:{names:['⟦MAIN⟧','Ann'],shown:['⟦MAIN⟧'],offline:[]}});
 expect(w.label().join(' ')).not.toContain('MAIN');
 // The frame of that view shows the reserved label. A reply that puts another name in its place is not taken.
 w.laid([{name:'Secret',x:0,y:0,w:500,h:300},{name:'Ann',x:504,y:0,w:500,h:300}]);expect(w.tiles().size).toBe(0);
 w.laid(w.grid(['⟦MAIN⟧','Ann']));
 expect([...w.tiles().values()].map((t:any)=>t.name.textContent)).toEqual(['Main · reserved','Ann']);
 // The keys, the storage and the link hold the mark and nothing else for that account.
 w.press('ArrowRight',false);w.press('ArrowLeft',true);w.press(' ',false);
 const q=new URLSearchParams();w.linkWrite(q);
 expect(q.get('wm')).toBe('Ann');expect(JSON.parse(store.data['atlas-wall']).order).toEqual(['Ann','⟦MAIN⟧']);
 const seen=JSON.stringify([w.log,store.data,q.toString(),w.dom.all.map((e:any)=>[e.textContent,e.title,e.innerHTML,e.dataset,e.attrs])]);
 expect(seen).not.toContain('Secret');expect(seen.replaceAll('⟦MAIN⟧','')).not.toMatch(/MAIN/);
 w.message({viewerMultiPick:'⟦MAIN⟧',index:1});w.message({viewerMultiPick:'⟦MAIN⟧',index:1});
 expect(w.log.slice(-3)).toEqual([{multiFocus:'⟦MAIN⟧'},{multi:[]},{pick:'⟦MAIN⟧'}]);
 expect(w.said.at(-1)).toBe('Now watching Main · reserved');
 // The page takes the name from its own list: text in a reply never becomes a follow target.
 const own=fleetWall([inWorld('Ann'),inWorld('Bob')]);own.start();own.message({viewerMultiPick:'⟦MAIN⟧',index:1});own.message({viewerMultiPick:'⟦MAIN⟧',index:1});
 expect(own.log.at(-1)).toEqual({pick:'Bob'});
});

test('the focus moves to the view next to it in the direction of the key',()=>{
 const w=fleetWall([inWorld('Ann')]);
 // 3 x 3 grid of 300 x 200 views, 4 px apart. Views: 0 1 2 / 3 4 5 / 6 7 8.
 const g=Array.from({length:9},(_,i)=>({x:(i%3)*304,y:Math.floor(i/3)*204,w:300,h:200}));
 expect([w.neighbour(g,4,'left'),w.neighbour(g,4,'right'),w.neighbour(g,4,'up'),w.neighbour(g,4,'down')]).toEqual([3,5,1,7]);
 expect([w.neighbour(g,0,'left'),w.neighbour(g,0,'up'),w.neighbour(g,8,'right'),w.neighbour(g,8,'down')]).toEqual([-1,-1,-1,-1]);
 expect(w.neighbour(g,9,'left')).toBe(-1);
 // Main and stack: a 600 px main view, then two columns of three views. Right of the main view is the stack view
 // level with its centre; left of any stack view in the first column is the main view.
 const m=[{x:0,y:0,w:600,h:608},...Array.from({length:6},(_,i)=>({x:604+(i%2)*154,y:Math.floor(i/2)*204,w:150,h:200}))];
 expect(w.neighbour(m,0,'right')).toBe(3);expect([1,3,5].map(i=>w.neighbour(m,i,'left'))).toEqual([0,0,0]);
 expect(w.neighbour(m,2,'left')).toBe(1);expect(w.neighbour(m,2,'down')).toBe(4);expect(w.neighbour(m,0,'down')).toBe(-1);
 // A stretched last row: down from the middle column goes to the view under it, and up comes back to a view over it.
 const s=[...g.slice(0,6),{x:0,y:408,w:452,h:200},{x:456,y:408,w:452,h:200}];
 expect([w.neighbour(s,3,'down'),w.neighbour(s,4,'down'),w.neighbour(s,5,'down')]).toEqual([6,6,7]);
 expect(w.neighbour(s,7,'up')).toBe(5);
 // With no view level with the start, the nearest view past the edge is taken.
 expect(w.neighbour([{x:0,y:0,w:100,h:100},{x:104,y:104,w:100,h:100}],0,'right')).toBe(1);
});

test('the keys of the wall: each command is one message, in the order the viewer needs',()=>{
 const names=['Ann','Bob','Cat','Dan'],w=fleetWall(names.map(n=>inWorld(n)));w.start();w.laid(w.grid(names));
 const sent=(act:()=>void)=>{const mark=w.log.length;act();return w.since(mark);};
 // Arrows and h j k l move the focus; an edge stops it; 1 to 9 pick a view by its place.
 expect(sent(()=>w.press('ArrowRight',false))).toEqual([{multiFocus:'Bob'}]);
 expect(sent(()=>w.press('j',false))).toEqual([{multiFocus:'Dan'}]);
 expect(sent(()=>w.press('h',false))).toEqual([{multiFocus:'Cat'}]);
 expect(sent(()=>w.press('k',false))).toEqual([{multiFocus:'Ann'}]);
 expect(sent(()=>w.press('ArrowLeft',false))).toEqual([]);expect(sent(()=>w.press('l',false))).toEqual([{multiFocus:'Bob'}]);
 expect(sent(()=>w.press('3',false))).toEqual([{multiFocus:'Cat'}]);expect(sent(()=>w.press('9',false))).toEqual([]);
 // Enter makes the focused view the main view.
 expect(sent(()=>w.press('Enter',false))).toEqual([{multiLayout:{main:'Cat'}}]);
 // Space steps through the layouts, Shift+Space steps back.
 expect(sent(()=>w.press(' ',false))).toEqual([{multiLayout:{mode:'main'}}]);
 expect(sent(()=>w.press(' ',false))).toEqual([{multiLayout:{mode:'focus'}}]);
 expect(sent(()=>w.press(' ',true))).toEqual([{multiLayout:{mode:'main'}}]);
 // f puts the focused view at full size in the same move, and returns to the layout before.
 w.press('2',false);
 expect(sent(()=>w.press('f',false))).toEqual([{multiLayout:{mode:'focus',main:'Ann'}}]);
 expect(sent(()=>w.press('F',false))).toEqual([{multiLayout:{mode:'main'}}]);
 expect(w.wall()).toMatchObject({layout:'main',main:'Ann',focus:'Ann',names});
 // Shift and a direction swap two views. Order first, then the main view when the first place changed.
 w.laid([{name:'Ann',x:0,y:0,w:600,h:600},{name:'Bob',x:604,y:0,w:300,h:198},{name:'Cat',x:604,y:202,w:300,h:198},{name:'Dan',x:604,y:404,w:300,h:196}]);
 w.press('ArrowRight',false);
 expect(w.wall()!.focus).toBe('Cat');
 expect(sent(()=>w.press('ArrowUp',true))).toEqual([{multiOrder:['Ann','Cat','Bob','Dan']}]);
 // The rectangles are those of the old order until the viewer reports: a second swap waits for them.
 expect(sent(()=>w.press('ArrowLeft',true))).toEqual([]);
 w.laid([{name:'Ann',x:0,y:0,w:600,h:600},{name:'Cat',x:604,y:0,w:300,h:198},{name:'Bob',x:604,y:202,w:300,h:198},{name:'Dan',x:604,y:404,w:300,h:196}]);
 expect(sent(()=>w.press('H',true))).toEqual([{multiOrder:['Cat','Ann','Bob','Dan']},{multiLayout:{main:'Cat'}}]);
 expect(w.wall()).toMatchObject({main:'Cat',focus:'Cat',names:['Cat','Ann','Bob','Dan']});
 // Other keys are not the wall's, and no key is while the wall is closed.
 expect(w.press('x',false)).toBe(false);expect(w.press('Tab',false)).toBe(false);
 // Enter on the main view follows that account.
 expect(sent(()=>w.press('Enter',false))).toEqual([{multiFocus:'Cat'},{multi:[]},{pick:'Cat'}]);
 expect(w.on()).toBe(false);expect(w.press('Enter',false)).toBe(false);expect(w.press(' ',false)).toBe(false);
});

test('keys pressed in the viewer frame do the same, and \\ and Escape open and close the wall',()=>{
 const w=fleetWall([inWorld('Ann'),inWorld('Bob')]);
 w.frameKey({key:'\\'});expect(w.on()).toBe(true);w.laid(w.grid(['Ann','Bob']));
 w.message({atlasWallKey:{key:'ArrowRight',shift:false}});expect(w.wall()!.focus).toBe('Bob');
 w.message({atlasWallKey:{key:' ',shift:false}});expect(w.wall()!.layout).toBe('main');
 for(const bad of [{key:5},{key:'ArrowLeftArrowLeft'},null,'ArrowLeft',{shift:true}])w.message({atlasWallKey:bad});
 expect(w.wall()).toMatchObject({focus:'Bob',layout:'main'});
 // The open and close keys are the page's own: wallMessage leaves them to the one handler.
 w.message({atlasWallKey:{key:'Escape'}});w.message({atlasWallKey:{key:'\\'}});expect(w.on()).toBe(true);
 w.frameKey({key:'Escape'});expect(w.on()).toBe(false);
 w.frameKey(undefined);w.frameKey({key:'Enter'});expect(w.on()).toBe(false);
 // A wall button that is hidden (2D map) or disabled (viewer loading) does not open by key.
 w.wallButton.disabled=true;w.frameKey({key:'\\'});expect(w.on()).toBe(false);
 expect(shell).toContain("if(window.atlasWallOn?.()&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&!/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)&&!(/^(?:BUTTON|A|SUMMARY)$/.test(e.target.tagName)&&(e.key==='Enter'||e.key===' '))&&wallPress(e.key,e.shiftKey)){e.preventDefault();e.stopPropagation();return;}");
 expect(shell).toContain('wallMessage(e.data);wallFrameKey(e.data.atlasWallKey);');
});

test('the page draws a frame over each view at the rectangle the viewer reports, moved to page pixels',()=>{
 const w=fleetWall([inWorld('Ann'),inWorld('Bob'),inWorld('Cat')]);w.start();
 expect(w.tiles().size).toBe(0);
 // The harness puts the 3D view 20 px under the top of the frames' box: a view at y is drawn at y + 20.
 const rects=[{name:'Ann',x:0,y:0,w:522,h:376},{name:'Bob',x:526,y:0,w:522,h:376},{name:'Cat',x:0,y:380,w:1048,h:377}];
 w.laid(rects);
 const tile=(n:string)=>w.tiles().get(n).el.style,box=(n:string)=>[tile(n).left,tile(n).top,tile(n).width,tile(n).height];
 expect(box('Ann')).toEqual(['0px','20px','522px','376px']);expect(box('Bob')).toEqual(['526px','20px','522px','376px']);expect(box('Cat')).toEqual(['0px','400px','1048px','377px']);
 expect(w.root.children.filter((e:any)=>e.className.includes('wall-tile'))).toHaveLength(3);
 expect(w.root.className).toContain('still');
 // The marks: the focused view, the main view, the place numbers, and the view under the pointer.
 expect(w.tiles().get('Ann').el.className).toBe('wall-tile wall-focus wall-main');expect(w.tiles().get('Bob').el.className).toBe('wall-tile');
 expect(['Ann','Bob','Cat'].map(n=>w.tiles().get(n).num.textContent)).toEqual(['1','2','3']);
 w.message({viewerMultiHover:1});expect(w.tiles().get('Bob').el.className).toBe('wall-tile wall-hover');
 w.message({viewerMultiHover:-1});expect(w.tiles().get('Bob').el.className).toBe('wall-tile');
 w.message({viewerMultiHover:'1'});w.message({viewerMultiHover:1.5});expect(w.wall()!.hover).toBe(null);
 // A report is taken only whole: every asked name in the asked order, numbers in range, the flags of a report.
 const before=tile('Ann').left,moved=rects.map(r=>({...r,x:r.x+7}));
 for(const bad of [moved.slice(0,2),[moved[1],moved[0],moved[2]],moved.map((r,i)=>i?r:{...r,x:NaN}),moved.map((r,i)=>i?r:{...r,w:-5}),moved.map((r,i)=>i?r:{...r,y:1e6}),moved.map((r,i)=>i?r:{...r,name:5}),'x',null])w.laid(bad as any);
 w.laid(moved,{animating:'yes'});w.laid(moved,{ms:-1});w.laid(moved,{ms:5000,animating:true});w.laid(moved,{at:'now'});
 expect(tile('Ann').left).toBe(before);
 // A strip takes the pointer: a click focuses the view, a second click or the open button follows the account.
 const strip=w.tiles().get('Cat').strip;
 strip.listeners.click({target:{closest:()=>null}});expect(w.wall()!.focus).toBe('Cat');expect(w.on()).toBe(true);
 strip.listeners.click({target:{closest:()=>null}});expect(w.on()).toBe(false);expect(w.log.at(-1)).toEqual({pick:'Cat'});
 w.start();w.laid(rects);
 w.tiles().get('Bob').strip.listeners.click({target:{closest:(q:string)=>q==='.wall-open'?{}:null}});expect(w.log.slice(-3)).toEqual([{multiFocus:'Bob'},{multi:[]},{pick:'Bob'}]);
 expect(w.tiles().size).toBe(0);
});

test('a frame moves with the viewer: the same time and curve, started as far in as the move is at that frame',()=>{
 const w=fleetWall([inWorld('Ann'),inWorld('Bob')]);w.start();
 w.laid(w.grid(['Ann','Bob']));
 // The viewer started a 240 ms move 1000 ms after the page's time origin; the next page frame is at 1050 ms.
 const to=[{name:'Ann',x:504,y:0,w:500,h:300},{name:'Bob',x:0,y:0,w:500,h:300}];
 w.laid(to,{animating:true,ms:240,at:performance.timeOrigin+1000,frameAt:1050});
 const ann=w.tiles().get('Ann').el.style;
 expect(w.root.className).not.toContain('still');expect(w.root.style['--wall-ms']).toBe('240ms');
 expect([ann.left,ann.top,ann.transitionDelay]).toEqual(['504px','20px','-50ms']);
 // A report that is older than the move is long, or from a clock ahead of the page's, stays inside the move.
 w.laid(to,{animating:true,ms:240,at:performance.timeOrigin,frameAt:9000});expect(ann.transitionDelay).toBe('-240ms');
 w.laid(to,{animating:true,ms:240,at:performance.timeOrigin+500,frameAt:100});expect(ann.transitionDelay).toBe('-0ms');
 // The end of the move: the frames are set on the rectangles with no transition.
 w.laid(to,{animating:false,ms:0,at:performance.timeOrigin+1240,frameAt:1250});
 expect(w.root.className).toContain('still');expect(ann.transitionDelay).toBe('');
 // Two reports before one frame: the frame shows the last one.
 w.message({viewerMultiLayout:{mode:'grid',main:null,focus:null,rects:w.grid(['Ann','Bob']),animating:true,ms:240,at:performance.timeOrigin+2000}});
 w.laid(to,{animating:true,ms:240,at:performance.timeOrigin+2010,frameAt:2020});
 expect([ann.left,ann.transitionDelay]).toEqual(['504px','-10ms']);
});

test('a new view gets a frame that grows in, and the frame of a view that left shrinks out',()=>{
 const w=fleetWall([inWorld('Ann'),inWorld('Bob')]);w.start();w.laid(w.grid(['Ann','Bob']));
 const bob=w.tiles().get('Bob').el;
 w.S.bots[1].inWorld=false;w.S.bots.push(inWorld('Cat'));w.sync();
 expect(w.multis().at(-1)).toEqual({multi:['Ann','Cat']});
 // Until the viewer reports the new layout the frames stay.
 expect(bob.parent).toBe(w.root);
 w.laid(w.grid(['Ann','Cat']),{animating:true,ms:240,at:performance.timeOrigin+100,frameAt:110});
 // Bob's frame (504, 20, 500 x 300) shrinks to 0.6 of its size about its centre and fades, as the view does.
 expect(w.tiles().has('Bob')).toBe(false);expect(bob.className).toContain('out');
 expect([bob.style.left,bob.style.top,bob.style.width,bob.style.height,bob.style['--wall-fade'],bob.style.transitionDelay]).toEqual(['604px','80px','300px','180px','0','-10ms']);
 const cat=w.tiles().get('Cat').el;
 expect([cat.style.left,cat.style.top,cat.style.width,cat.style['--wall-fade'],cat.style.transitionDelay]).toEqual(['504px','20px','500px','1','-10ms']);
 expect(w.tiles().get('Cat').name.textContent).toBe('Cat');
});

test('with reduced motion the viewer is told not to move the views and the frames have no transition',()=>{
 const w=fleetWall([inWorld('Ann'),inWorld('Bob')],{still:true});w.start();
 expect(w.log).toEqual(opening(['Ann','Bob'],'grid','Ann',false));
 w.laid(w.grid(['Ann','Bob']),{animating:true,ms:240,at:performance.timeOrigin+100,frameAt:110});
 expect(w.root.className).toContain('still');expect(w.tiles().get('Ann').el.style.transitionDelay).toBe('');
 const css=readFileSync(new URL('./client-shell.css',import.meta.url),'utf8');
 expect(css).toContain('@media(prefers-reduced-motion:reduce){.wall-tile,.wall-tile::after{transition:none!important}}');
 expect(css).toContain('--wall-ease:cubic-bezier(.3333,1,.6667,1)');expect(css).toContain('.wall-chrome.still .wall-tile{transition:none}');
 // The frames move with properties that the page's own frames drive, so the move starts in the frame it is set in.
 expect(css).toContain("@property --wall-fade{syntax:'<number>';inherits:false;initial-value:1}");
 expect(css).toMatch(/\.wall-tile\{[^}]*transition:left var\(--wall-ms\) var\(--wall-ease\),top [^}]*,--wall-fade var\(--wall-ms\) var\(--wall-ease\)\}/);
});

test('the layout switcher shows the layout, and one button steps through the layouts on a narrow title bar',()=>{
 const w=fleetWall([inWorld('Ann'),inWorld('Bob')]);
 expect(w.tools.hidden).toBe(true);expect(w.wallButton.next).toBe(w.tools);
 w.start();
 const buttons=w.dom.byClass('wall-layout'),cycle=w.dom.byClass('wall-cycle')[0],helpButton=w.dom.byClass('wall-help-button')[0];
 expect(buttons.map((b:any)=>[b.dataset.wallLayout,b.attrs['aria-pressed']])).toEqual([['grid','true'],['main','false'],['focus','false'],['columns','false']]);
 const click=(b:any)=>w.tools.listeners.click({target:{closest:()=>b},stopPropagation:()=>{}});
 let mark=w.log.length;click(buttons[3]);
 expect(w.since(mark)).toEqual([{multiLayout:{mode:'columns'}}]);expect(buttons.map((b:any)=>b.attrs['aria-pressed'])).toEqual(['false','false','false','true']);
 mark=w.log.length;click(buttons[3]);expect(w.since(mark)).toEqual([]);
 click(cycle);expect(w.wall()!.layout).toBe('grid');expect(cycle.title).toContain('Grid');
 // The key list is in the Info plugin. Its button and ? open it there while the wall is on.
 expect(w.keysOpened()).toBe(0);click(helpButton);expect(w.keysOpened()).toBe(1);
 w.press('?',false);expect(w.keysOpened()).toBe(2);w.end();w.press('?',false);expect(w.keysOpened()).toBe(2);
 expect(shell).not.toContain('wall-help\'');
 for(const row of ["keys('Shift','Arrow')","keys('Enter')","keys('Space')","ptr('Double click')","keys('Esc')"])expect(shell).toContain('infoRow('+row);
 const css=readFileSync(new URL('./client-shell.css',import.meta.url),'utf8');
 expect(css).toContain('@media(max-width:740px){.client-title .focus .wall-tools .wall-layout{display:none}.client-title .focus .wall-tools .wall-cycle{display:grid}');
 expect(shell).toContain("infoRow(keys('\\\\'),'our accounts side by side',true)");
});

test('while the wall is open the page sends no step, roof, prewarm or follow message',()=>{
 const step=focusStepper([{name:'Ann',inWorld:true},{name:'Bob',inWorld:true}],'Ann',{atlasWallOn:()=>true});step.step(1);step.step(-1);expect(step.picks).toEqual([]);
 const page=readFileSync(new URL('./index.html',import.meta.url),'utf8');
 expect(page).toContain("function syncRoofs(){if(mode!=='3d'||VIEWER.state!=='ready'||window.atlasWallOn?.())return;");
 expect(page.match(/&&!window\.atlasWallOn\?\.\(\)\)\{(?:rswFor|followedLive)=sel;/g)).toHaveLength(2);
 expect(shell).toContain("  function warmPlaces(first){\n    if(wall||mode!=='3d'||VIEWER.state!=='ready')return;");
 expect(shell).toContain('if(e.data?.viewerTiming&&!wall)focusLanded();');
 expect(shell).toContain('const stuck=!!wall||');
 expect(readFileSync(new URL('./map-shell.js',import.meta.url),'utf8')).toContain("if(typeof name!=='string'||!S?.bots||window.atlasWallOn?.())return;");
});

test('a gap between rows or columns of the grid sizes its two neighbours; the strip of the focus layout has a gap too',()=>{
 // The neighbours share their space again, the others keep theirs; near the middle the gap stops there.
 expect(w0.sharesAt([300,300,300],0,150,false)).toEqual([0.5,0.1667,0.3333]);
 expect(w0.sharesAt([500,500],0,8,false)).toEqual([0.5,0.5]);expect(w0.sharesAt([500,500],0,8,true)).toEqual([0.508,0.492]);
 expect(w0.sharesAt([500,500],0,900,false)).toEqual([0.85,0.15]);
 const names=['Ann','Bob','Cat','Dan'],store=fakeStore(),w=fleetWall(names.map(n=>inWorld(n)),{store});w.start();w.laid(w.grid(names));
 // Two rows and two columns: one gap of each kind.
 const shown=()=>w.edges.filter((e:any)=>!e.hidden).map((e:any)=>[e.gap.kind,e.dataset.side,e.style.left,e.style.top]);
 expect(shown()).toEqual([['rows','row','0px','317px'],['cols','col','497px','20px']]);
 const col=w.edges[1],ev=(x:number,y:number)=>({button:0,pointerId:4,clientX:x,clientY:y,altKey:false});
 let mark=w.log.length;col.listeners.pointerdown(ev(502,200));col.listeners.pointermove(ev(602,200));for(const f of w.frames.splice(0))f(0);col.listeners.pointerup(ev(602,200));
 expect(w.since(mark)).toEqual([{multiLayout:{animate:false}},{multiLayout:{cols:[0.6,0.4]}},{multiLayout:{cols:[0.6,0.4],animate:true}}]);
 expect(JSON.parse(store.data['atlas-wall']).shares.grid).toEqual({rows:[],cols:[0.6,0.4]});
 // Another layout gets its own sizes, and the grid gets its sizes back.
 mark=w.log.length;w.press(' ',false);
 expect(w.since(mark)).toEqual([{multiLayout:{mode:'main',rows:[],cols:[],strip:0}}]);
 mark=w.log.length;w.layoutTo('grid');
 expect(w.since(mark)).toEqual([{multiLayout:{mode:'grid',rows:[],cols:[0.6,0.4],strip:0}}]);
 // The focus layout: the gap over the strip gives the strip 10 to 45 percent of the height.
 w.layoutTo('focus');w.laid([{name:'Ann',x:0,y:0,w:1048,h:632},{name:'Bob',x:0,y:636,w:346,h:121},{name:'Cat',x:350,y:636,w:347,h:121},{name:'Dan',x:701,y:636,w:347,h:121}]);
 expect(shown()).toEqual([['strip','row','0px','649px']]);
 const strip=w.edges[0];mark=w.log.length;strip.listeners.pointerdown(ev(300,682));strip.listeners.pointermove(ev(300,48+757-229));for(const f of w.frames.splice(0))f(0);strip.listeners.pointerup(ev(300,48+757-229));
 expect(w.since(mark)).toEqual([{multiLayout:{animate:false}},{multiLayout:{strip:0.3}},{multiLayout:{strip:0.3,animate:true}}]);
 // The next wall opens with the stored sizes.
 w.end();const next=fleetWall(names.map(n=>inWorld(n)),{store});next.start();
 expect(next.log[1]).toEqual({multiLayout:{mode:'focus',main:'Ann',gap:4,rows:[],cols:[],strip:0.3,color:'#1e1e1e',animate:true}});
});

test('logins, logouts and rank moves become chat lines after the first snapshot',()=>{
 const code=shell.slice(shell.indexOf('  const worldSeen=new Map()'),shell.indexOf('  function levelUps(){'));
 const chat:any[]=[],S:any={bots:[{name:'A',inWorld:true},{name:'B',inWorld:false}],boards:[{board:'Fishing',best:{rank:5,name:'A'}}]};
 let renders=0;
 const moments=new Function('S','chat','safeName','renderChat',`${code};return moments;`)(S,chat,String,()=>renders++);
 moments();expect(chat).toEqual([]);
 S.bots[0].inWorld=false;S.bots[1].inWorld=true;S.boards[0].best.rank=3;moments();
 expect(chat.map(r=>r.kind+':'+r.text)).toEqual(['Private:B has logged in.','Private:A has logged out.','Game:A is now rank 3 on Fishing (up from 5).']);
 expect(renders).toBe(1);
 moments();expect(chat.length).toBe(3);
 S.bots=['a','b','c','d','e'].map(name=>({name,inWorld:false}));moments();for(const b of S.bots)b.inWorld=true;moments();
 expect(chat.at(-1).text).toBe('5 accounts have logged in.');
});

test('!price answers from the market, then from the item value',()=>{
 const code=shell.slice(shell.indexOf('  function priceLine(q){'),shell.indexOf('  function chatLookup(text){'));
 const S={economy:{supplies:[{name:'Cannonball',ask:7320,bid:null,stock:18118},{name:'Law rune',ask:900,bid:800,stock:5}],itemValues:{'Rune scimitar':25600}}};
 const priceLine=new Function('S','nf',`${code};return priceLine;`)(S,(n:number)=>n.toLocaleString('en-US'));
 expect(priceLine('cannon')).toBe('Cannonball: ask 7,320 gp · bid none · 18,118 in stock.');
 expect(priceLine('LAW RUNE')).toBe('Law rune: ask 900 gp · bid 800 gp · 5 in stock.');
 expect(priceLine('rune scimitar')).toBe('Rune scimitar: value 25,600 gp · no market offer.');
 expect(priceLine('nothing')).toBe('No price for nothing.');
 expect(priceLine(' ')).toContain('Usage: !price');
 // With the alchemy table: the high alch value on each answer, and an item that only has an alch value.
 const itemAlch={'Cannonball':5,'Rune scimitar':25600,'Rune platebody':65000};
 const alchOf=(n:string)=>itemAlch[n as keyof typeof itemAlch]?Math.max(Math.floor(itemAlch[n as keyof typeof itemAlch]*6/10),1):null;
 const withHa=new Function('S','nf','alchOf','itemAlch',`${code};return priceLine;`)(S,(n:number)=>n.toLocaleString('en-US'),alchOf,itemAlch);
 expect(withHa('cannon')).toBe('Cannonball: ask 7,320 gp · bid none · 18,118 in stock · high alch 3 gp.');
 expect(withHa('rune scimitar')).toBe('Rune scimitar: value 25,600 gp · high alch 15,360 gp · no market offer.');
 expect(withHa('RUNE PLATEBODY')).toBe('Rune platebody: high alch 39,000 gp · no market offer.');
 expect(withHa('law rune')).toBe('Law rune: ask 900 gp · bid 800 gp · 5 in stock.');
});

test('pickpocket: the followed account\'s chance, the XP a try and the stun, or the level it needs',()=>{
 const code=shell.slice(shell.indexOf("  // Pickpocket (RuneLite's Thieving overlay"),shell.indexOf('  function finderList(){'));
 const sync=(v:any)=>({then(f:any){return sync(f(v));}});
 let lv:any=40;
 const env:any={asset:(n:string)=>n,fetch:()=>sync({ok:true,json:()=>({Man:[1,200,180,240,8,1],Hero:[80,6832.5,6,100,10,4]})}),account:()=>({}),curLevel:()=>lv,nf:(n:number)=>n.toLocaleString('en-GB')};
 const t=new Function(...Object.keys(env),`${code};return thieveText;`)(...Object.values(env));
 // Man at 40: floor(180*59/98) + floor(240*39/98) + 1 = 108 + 95 + 1 = 204 of 256: 80%, 159 XP a try.
 expect(t('Man')).toBe('Pickpocket at Thieving 40: 80% · 159 XP a try · a fail stuns 8 ticks and hits 1');
 expect(t('Hero')).toBe('Pickpocket: Thieving 80 needed (has 40)');
 lv=null;expect(t('Man')).toBe('Pickpocket: Thieving 1 · 200 XP');
 expect(t('Goblin')).toBe('');
});

test('gather chance: the best held axe on a tree, the roll of a rock, or no axe held',()=>{
 const code=shell.slice(shell.indexOf("  // Gather chance (RuneLite's Woodcutting and Mining overlays"),shell.indexOf('  const bestSpotLine=(b,lvl)=>{'));
 const sync=(v:any)=>({then(f:any){return sync(f(v));}});
 const env:any={asset:(n:string)=>n,fetch:()=>sync({ok:true,json:()=>({'Willow logs':{tool:[['Bronze axe',16,50],['Rune axe',56,175]]},'Iron ore':{roll:[96,350]}})})};
 const t=new Function(...Object.keys(env),`${code};return gatherText;`)(...Object.values(env));
 // Rune axe at 40: floor(56*59/98) + floor(175*39/98) + 1 = 33 + 69 + 1 = 103 of 256: 40%.
 expect(t({equipment:[{name:'Rune axe',count:1}],inventory:[{name:'Bronze axe',count:1}]},'Willow logs',40)).toBe('40% a try with the rune axe');
 // Iron ore at 40: floor(96*59/98) + floor(350*39/98) + 1 = 57 + 139 + 1 = 197 of 256: 77%.
 expect(t({},'Iron ore',40)).toBe('77% a try');
 expect(t({inventory:[]},'Willow logs',40)).toBe('no axe held');
 expect(t({},'Magic logs',75)).toBe('');
 // A boosted or drained level counts: Mining current 40 over a base of 30.
 const withCur=new Function(...Object.keys(env),'curLevel',`${code};return gatherText;`)(...Object.values(env),()=>40);
 expect(withCur({},'Iron ore',30,'Mining')).toBe('77% a try');
});

test('agility label: the fail chance at the current Agility level, none when the roll always passes',()=>{
 const start=shell.indexOf('  // An obstacle that can fail carries [low, high]'),code=shell.slice(start,shell.indexOf('\n',shell.indexOf('% fail',start)));
 let lv:any=52;
 const label=new Function('curLevel',`${code};return agilityLabel;`)(()=>lv);
 // Agility 52 on [200, 250]: floor(200*47/98) + floor(250*51/98) + 1 = 95 + 130 + 1 = 226 of 256: 12% fail.
 expect(label('Swing-on',[200,250],{})).toBe('Swing-on · 12% fail');
 lv=99;expect(label('Swing-on',[200,250],{})).toBe('Swing-on · 2% fail');
 // [65, 355] passes every roll at 72: floor(65*27/98) + floor(355*71/98) + 1 = 17 + 257 + 1 of 256.
 lv=72;expect(label('Walk-across',[65,355],{})).toBe('Walk-across');
 expect(label('Climb',undefined,{})).toBe('Climb');
 lv=null;expect(label('Swing-on',[200,250],{})).toBe('Swing-on');
});

test('runes per essence: the count at the current level and the next step, 1 with no multiplier',()=>{
 const code=shell.slice(shell.indexOf("  // Runes per essence (RuneLite's Runecraft overlay"),shell.indexOf("  // Skill guide (RuneLite's Skill Calculator,"));
 const sync=(v:any)=>({then(f:any){return sync(f(v));}});
 const t=new Function('asset','fetch',`${code};return perEssence;`)((n:string)=>n,()=>sync({ok:true,json:()=>({'Air rune':[1,11],'Nature rune':[44,91],'Law rune':[54,0]})}));
 expect(t('Air rune',33)).toBe('4 per essence (5 at 44)');
 expect(t('Air rune',99)).toBe('10 per essence');
 expect(t('Nature rune',60)).toBe('1 per essence (2 at 91)');
 expect(t('Law rune',80)).toBe('1 per essence');
 expect(t('Blood rune',80)).toBe('');
});

test('melee hit chance: the best style from the worn bonuses, and the range over variants',()=>{
 const code=shell.slice(shell.indexOf("  // Melee hit chance (RuneLite's opponent information"),shell.indexOf('  function finderList(){'));
 const sync=(v:any)=>({then(f:any){return sync(f(v));}});
 let bon:any=[0,67,0];
 const env:any={asset:(n:string)=>n,fetch:()=>sync({ok:true,json:()=>({'Moss giant':[[42,30,1,0,0,0,0,0]],'Giant spider':[[2,1,1,-10,-10,-10,-10,-10],[27,21,1,0,0,0,0,0]]})}),account:()=>({}),wornBonuses:()=>bon,curLevel:()=>60};
 const t=new Function(...Object.keys(env),`${code};return meleeHitText;`)(...Object.values(env));
 // Slash 67 at Attack 60: A = 68 x 131 = 8,908; Moss giant D = 39 x 64 = 2,496: 1 - 2,498 / 17,818 = 86%.
 expect(t('Moss giant')).toBe('Melee hit at Attack 60: 86% with slash');
 // Giant spider: D = 10 x 54 = 540 (level 2) or 30 x 64 = 1,920 (level 27): 97% and 89%.
 expect(t('Giant spider')).toBe('Melee hit at Attack 60: 89–97% with slash');
 // A range attack bonus of 50 adds ranged at Ranged 60: A = 68 x 114 = 7,752 against 2,496: 84%. Magic 30 at Magic 60:
 // A = 69 x 94 = 6,486 against the giant's (1 + 9) x 64 = 640: 95%.
 bon=[0,67,0,30,50];
 expect(t('Moss giant')).toBe('Melee hit at Attack 60: 86% with slash · ranged 84% · magic 95%');
 bon=null;expect(t('Moss giant')).toBe('');
 expect(t('Banker')).toBe('');
});

test('NPC hits: its max hit and its chance through the account\'s Defence and worn defence of its damage type',()=>{
 const code=shell.slice(shell.indexOf("  // Melee hit chance (RuneLite's opponent information"),shell.indexOf('  function finderList(){'));
 const sync=(v:any)=>({then(f:any){return sync(f(v));}});
 const bon=[0,0,0,0,0,30,35,40,0,0,0,0,0];
 const env:any={asset:(n:string)=>n,fetch:()=>sync({ok:true,json:()=>({'Moss giant':[[42,30,1,0,0,0,0,0,30,30,33,31,2]],'Archer':[[30,20,1,0,0,0,0,0,25,25,0,0,-1]],'Old row':[[5,3,1,0,0,0,0,0]]})}),account:()=>({}),wornBonuses:()=>bon,curLevel:()=>60};
 const t=new Function(...Object.keys(env),`${code};return npcHitsText;`)(...Object.values(env));
 // Crush 40 at Defence 60: D = 68 x 104 = 7,072; A = 39 x 97 = 3,783: 3,783 / 14,146 = 27%. Max floor((39 x 95 + 320) / 640) = 6.
 expect(t('Moss giant')).toBe('It hits up to 6 · lands 27% on your Defence 60');
 expect(t('Archer')).toBe('');
 expect(t('Old row')).toBe('');
});

test('kill XP: one style and Hitpoints from the hitpoints and the multiplier, and the kills to the next Hitpoints level',()=>{
 const code=shell.slice(shell.indexOf("  // Melee hit chance (RuneLite's opponent information"),shell.indexOf('  function finderList(){'));
 const sync=(v:any)=>({then(f:any){return sync(f(v));}});
 require('./xp-tracker.js');const X=(globalThis as any).atlasXp;
 const row=(hp:number,m:number)=>[42,30,1,0,0,0,0,0,30,30,33,31,2,hp,m];
 const env:any={asset:(n:string)=>n,fetch:()=>sync({ok:true,json:()=>({'Moss giant':[row(60,1000)],'Zombie':[row(22,1000),row(30,1000),row(120,25)],'Swarm':[row(10,25)]})}),
  account:()=>({skills:[{name:'Hitpoints',level:50,xp:X.xpForLevel(50)}]}),wornBonuses:()=>null,curLevel:()=>50,nf:(n:number)=>n.toLocaleString('en-GB'),window:{atlasXp:X}};
 const t=new Function(...Object.keys(env),`${code};return killXpText;`)(...Object.values(env));
 const left=X.xpForLevel(51)-X.xpForLevel(50);
 // Moss giant: 60 x 100 = 6,000 in one style, 60 x 33.25 = 1,995 Hitpoints.
 const k=Math.ceil(left/1995);
 expect(t('Moss giant')).toBe('A kill: 6,000 XP in one style + about 1,995 Hitpoints · '+k.toLocaleString('en-GB')+(k===1?' kill':' kills')+' to Hitpoints 51');
 // The event Zombie (multiplier 25) is left out beside the normal ones.
 expect(t('Zombie')).toContain('A kill: 2,200–3,000 XP in one style + about 732–998 Hitpoints');
 // A name with only event variants keeps them: 10 x 100 x 25 / 1000 = 25.
 expect(t('Swarm')).toContain('A kill: 25 XP in one style');
 // A row with the respawn rate: 60 ticks x 0.6 = 36 s.
 const t2=new Function(...Object.keys(env),`${code};return killXpText;`)(...Object.values({...env,fetch:()=>sync({ok:true,json:()=>({'Giant spider':[[27,21,1,0,0,0,0,0,20,24,0,0,0,30,1000,60]]})})}));
 expect(t2('Giant spider')).toContain('A kill: 3,000 XP in one style + about 998 Hitpoints · respawns in 36 s');
 // A 400 ms server: 60 ticks are 24 s.
 const t3=new Function(...Object.keys(env),'S',`${code};return killXpText;`)(...Object.values({...env,fetch:()=>sync({ok:true,json:()=>({'Giant spider':[[27,21,1,0,0,0,0,0,20,24,0,0,0,30,1000,60]]})})}),{world:{tickMs:400}});
 expect(t3('Giant spider')).toContain('respawns in 24 s');
});

test('loot of a kill: expected count times the item value, the top items, and the unpriced count',()=>{
 const code=shell.slice(shell.indexOf("  // Loot of a kill (RuneLite's loot tracker"),shell.indexOf('  function finderList(){'));
 const sync=(v:any)=>({then(f:any){return sync(f(v));}});
 const values:Record<string,number>={'Coins':1,'Big bones':300,'Earth rune':4};
 const env:any={asset:(n:string)=>n,fetch:()=>sync({ok:true,json:()=>({'Moss giant':[['Coins',19.6],['Big bones',1],['Earth rune',0.6328],['Herb',0.01]]})}),price:(n:string)=>values[n]!=null?{value:values[n]}:null,nf:(n:number)=>n.toLocaleString('en-GB')};
 const t=new Function(...Object.keys(env),`${code};return lootText;`)(...Object.values(env));
 // 19.6 + 300 + 2.53 = 322; the Herb has no price.
 expect(t('Moss giant')).toBe('Loot about 322 gp a kill (Big bones, Coins, Earth rune) · 1 unpriced');
 expect(t('Nobody')).toBe('');
});

test('kills an hour: hit chance x max hit / 2 a swing, the weapon speed, the hitpoints, then XP and gold an hour',()=>{
 const code=shell.slice(shell.indexOf("  // Melee hit chance (RuneLite's opponent information"),shell.indexOf('  function finderList(){'));
 const sync=(v:any)=>({then(f:any){return sync(f(v));}});
 const data:any={'npc-defence.json':{'Moss giant':[[42,30,1,0,0,0,0,0,30,30,33,31,2,60,1000,60]]},'npc-loot.json':{'Moss giant':[['Coins',20]]},'weapon-speed.json':{'Rune longsword':5}};
 const bon=[0,67,0,0,0,0,0,0,0,0,66,0,0];
 const env:any={asset:(n:string)=>n,fetch:(n:string)=>sync({ok:true,json:()=>data[n]??{}}),account:()=>({equipment:[{name:'Rune longsword',slot:3}]}),wornBonuses:()=>bon,curLevel:()=>60,
  maxHit:(l:number,b:number,st:number)=>Math.floor(((l+8+st)*(b+64)+320)/640),price:(n:string)=>n==='Coins'?{value:1}:null,nf:(n:number)=>n.toLocaleString('en-GB'),S:{world:{tickMs:600}},window:{}};
 const t=new Function(...Object.keys(env),`${code};return hourText;`)(...Object.values(env));
 // Max floor((68 x 130 + 320) / 640) = 14; slash hit 86% (A = 68 x 131 = 8,908 against 2,496): 0.86 x 7 = 6.02 a swing;
 // 60 / 6.02 = 9.97 swings x 5 ticks x 0.6 s = 29.9 s, plus 2 ticks (1.2 s) for the death and the next target: 31.1 s a
 // kill, 116 kills an hour, 116 x 6,000 = 694k XP, 116 x 20 gp.
 const out=t('Moss giant');
 expect(out).toMatch(/^About 116 kills an hour \(max hit 14, speed 5\) · 69\d,\d{3} XP\/h in one style · 2,3\d\d gp\/h$/);
 expect(new Function(...Object.keys(env),`${code};return hourText;`)(...Object.values({...env,wornBonuses:()=>null}))('Moss giant')).toBe('');
 // Two variants: a weak one with few hitpoints (many kills, little XP) and a strong one (few kills, much XP). XP/h is
 // each variant's own product, so the range is narrow, not the product of the two extremes.
 data['npc-defence.json']={'Goblin':[[2,1,1,0,0,0,0,0,1,1,0,0,2,5,1000,60],[13,10,1,0,0,0,0,0,10,10,0,0,2,16,1000,60]]};
 const g=new Function(...Object.keys(env),`${code};return hourText;`)(...Object.values(env))('Goblin');
 const xp=(g.match(/· ([\d,]+)–([\d,]+) XP\/h/)||[]).slice(1).map((x:string)=>Number(x.replace(/,/g,'')));
 // The 5 hitpoint variant loses most of a 14 hit to overkill, so its XP is lower; the range stays far from the product
 // of the two extremes (about 10x).
 expect(xp.length).toBe(2);expect(xp[1]/xp[0]).toBeLessThan(2);
 // A ranged weapon (range attack bonus above 0) rolls ranged, not melee: with Ranged 60, range attack 0 and ranged
 // strength 0 the max is floor((68 x 64 + 320) / 640) = 7; the roll 68 x 64 = 4,352 meets Moss giant's 39 x 64 = 2,496:
 // 71%, 2.5 a swing, 24 swings x 4 ticks x 0.6 s = 57.7 s plus 1.2 s a kill: 61 kills an hour.
 data['npc-defence.json']={'Moss giant':[[42,30,1,0,0,0,0,0,30,30,33,31,2,60,1000,60]]};
 const ranged=new Function(...Object.keys(env),'itemBonusData',`${code};return hourText;`)(...Object.values({...env,account:()=>({equipment:[{name:'Bronze dart',slot:3}]})}),{'Bronze dart':[0,0,0,0,1,0,0,0,0,0,0,1,0]});
 expect(ranged('Moss giant')).toMatch(/^About 61 kills an hour \(ranged, max hit 7, speed 4\) · /);
 // A staff with a castable spell casts it: Fire Bolt max 12 at Magic 60 with magic attack 10: the roll 69 x 74 = 5,106
 // meets Moss giant's (1 + 9) x 64 = 640: 94%, 5.6 a cast, 10.7 casts x 5 ticks x 0.6 s = 32 s plus 1.2 s: 108 kills an hour.
 const mage=new Function(...Object.keys(env),'itemBonusData','bestSpell',`${code};return hourText;`)(...Object.values({...env,account:()=>({equipment:[{name:'Staff of fire',slot:3}]}),wornBonuses:()=>[0,0,0,10,0,0,0,0,0,0,0,0,0]}),{'Staff of fire':[0,0,0,10,0,0,0,0,0,0,0,0,0]},()=>({name:'Fire Bolt',max:12,casts:50}));
 expect(mage('Moss giant')).toMatch(/^About 10\d kills an hour \(magic, Fire Bolt, max hit 12, speed 5\) · /);
 const mageXp=new Function(...Object.keys(env),'itemBonusData','bestSpell',`${code};return hourText;`)(...Object.values({...env,account:()=>({equipment:[{name:'Staff of fire',slot:3}]}),wornBonuses:()=>[0,0,0,10,0,0,0,0,0,0,0,0,0]}),{'Staff of fire':[0,0,0,10,0,0,0,0,0,0,0,0,0]},()=>({name:'Fire Bolt',max:12,casts:50,xp:22.5}));
 // 720 casts x 22.5 = 16,200 cast XP plus kills x 60 x 50 damage XP, in Magic.
 const mx=Number((mageXp('Moss giant').match(/· ([\d,]+) XP\/h in Magic/)||[])[1]?.replace(/,/g,''));
 expect(mx).toBeGreaterThan(16200+100*3000);expect(mx).toBeLessThan(16200+115*3000);
 // One spawn with a 700-tick respawn: the fight (33 s) and then the respawn (420 s), 453 s a kill, 7.9 kills an hour.
 // The cast XP is that of those kills' casts (7.9 x 10.7 x 22.5 = 1,910), not of a full hour of casting (16,200):
 // about 1,910 + 7.9 x 3,000 = 25,700.
 data['npc-defence.json']={'Moss giant':[[42,30,1,0,0,0,0,0,30,30,33,31,2,60,1000,700]]};
 const slow=new Function(...Object.keys(env),'itemBonusData','bestSpell','npcSpawns',`${code};return hourText;`)(...Object.values({...env,account:()=>({equipment:[{name:'Staff of fire',slot:3}]}),wornBonuses:()=>[0,0,0,10,0,0,0,0,0,0,0,0,0]}),{'Staff of fire':[0,0,0,10,0,0,0,0,0,0,0,0,0]},()=>({name:'Fire Bolt',max:12,casts:50,xp:22.5}),[['Moss giant',42,42,[3000,3000,0]]]);
 const sx=Number((slow('Moss giant').match(/· ([\d,]+) XP\/h in Magic/)||[])[1]?.replace(/,/g,''));
 expect(slow('Moss giant')).toMatch(/^About 8 kills an hour/);expect(sx).toBeGreaterThan(24500);expect(sx).toBeLessThan(27000);
 // A dagger has magic attack +1 too, but it is no staff: it stays melee with runes in the pack.
 const dagger=new Function(...Object.keys(env),'itemBonusData','bestSpell',`${code};return hourText;`)(...Object.values({...env,account:()=>({equipment:[{name:'Rune dagger',slot:3}]})}),{'Rune dagger':[25,12,-4,1,0,0,0,0,1,0,24,0,0]},()=>({name:'Wind Strike',max:2,casts:50,xp:137.5}));
 expect(dagger('Moss giant')).not.toContain('magic,');expect(dagger('Moss giant')).toMatch(/^About \d+ kills an hour \(max hit/);
 // A staff with no castable spell falls back to melee.
 const noSpell=new Function(...Object.keys(env),'itemBonusData','bestSpell',`${code};return hourText;`)(...Object.values({...env,account:()=>({equipment:[{name:'Staff of fire',slot:3}]})}),{'Staff of fire':[0,0,0,10,0,0,0,0,0,0,0,0,0]},()=>null);
 expect(noSpell('Moss giant')).not.toContain('magic,');
});

test('combat training: the NPCs with the most XP an hour that spawn, leaving out the ones that hit too hard',()=>{
 const code=shell.slice(shell.indexOf("  // Melee hit chance (RuneLite's opponent information"),shell.indexOf('  function finderList(){'));
 const sync=(v:any)=>({then(f:any){return sync(f(v));}});
 const row=(hp:number,str:number,sb:number)=>[10,1,1,0,0,0,0,0,1,str,0,sb,2,hp,1000,60];
 const cow=row(8,1,0);cow[1]=20;
 const data:any={'npc-defence.json':{'Cow':[cow],'Moss giant':[row(60,30,31)],'Ogre':[row(60,60,80)],'Ghost town':[row(30,1,0)],'Wild giant':[row(60,30,31)]},'npc-loot.json':{},'weapon-speed.json':{}};
 const env:any={asset:(n:string)=>n,fetch:(n:string)=>sync({ok:true,json:()=>data[n]??{}}),account:()=>({equipment:[]}),wornBonuses:()=>[0,50,0,0,0,0,0,0,0,0,50,0,0],curLevel:()=>40,
  maxHit:(l:number,b:number,st:number)=>Math.floor(((l+8+st)*(b+64)+320)/640),price:()=>null,nf:(n:number)=>n.toLocaleString('en-GB'),S:{world:{tickMs:600}},window:{},E:(x:string)=>x,
  wildLevel:(p:any)=>p.x>=2944&&p.x<=3391&&p.z>=3520&&p.z<=6399?Math.floor((p.z-3520)/8)+1:0,
  npcSpawns:[['Cow',0,0,[3253,3270,0]],['Moss giant',0,0,[3100,3927,0,2550,3405,0]],['Ogre',0,0,[2500,3000,0]],['Wild giant',0,0,[3100,3927,0]]]};
 const t=new Function(...Object.keys(env),`${code};return {trainRows,trainBox,hourRates};`)(...Object.values(env));
 // The training rate counts only Moss giant's safe spawn: one spawn, so the respawn wait counts in full.
 expect(t.hourRates('Moss giant',true).lo).toBeLessThan(t.hourRates('Moss giant').lo);
 const rows=t.trainRows();
 // Ogre max floor((69 x 144 + 320) / 640) = 16: 48 is over 40 Hitpoints, left out. Ghost town does not spawn. Wild giant
 // spawns only in the Wilderness, left out. Moss giant has one spawn outside it, kept. The Cow
 // (8 hitpoints, defence 20) wastes most of each hit and is harder to hit, so the Moss giant ranks first.
 expect(rows.map((r:any)=>r.name)).toEqual(['Moss giant','Cow']);
 expect(rows[0].xp).toBeGreaterThan(rows[1].xp);
 expect(t.trainBox()).toContain('data-finder-pick="Moss giant" data-finder-safe');
});

test('a safe pick (a Combat training row) keeps only the spawns outside the Wilderness',()=>{
 const code=shell.slice(shell.indexOf('  let finderSafe=false;'),shell.indexOf('  const finderRow=')).concat(shell.slice(shell.indexOf('  const finderRow='),shell.indexOf('\n',shell.indexOf('    const pts=[];'))));
 const wildLevel=(p:any)=>p.x>=2944&&p.x<=3391&&p.z>=3520&&p.z<=6399?1:0;
 const f=new Function('npcSpawns','finderPick','wildLevel',`${code};return (s:boolean)=>{finderSafe=s;return finderRow();};`.replace('(s:boolean)','(s)'))([['Moss giant',42,42,[3100,3927,0,2550,3405,0]]],'Moss giant',wildLevel);
 expect(f(false)[3]).toEqual([3100,3927,0,2550,3405,0]);
 expect(f(true)[3]).toEqual([2550,3405,0]);
});

test('NPC aggression timer: two 21 x 21 areas, 1,000 ticks, the hunters that spawn near and would attack',()=>{
 const code=shell.slice(shell.indexOf("  // NPC aggression timer (RuneLite's"),shell.indexOf('  function infoboxes(){'));
 const sync=(v:any)=>({then(f:any){return sync(f(v));}});
 // npc-hunt.json rows: [name, kind, vislevel, tiles]. Worker has a never-stopping variant far away and a kind-1 one near.
 const hunt=[['Moss giant',1,42,[3170,9900,0]],['Dark wizard',1,7,[3175,9905,1]],['Worker',1,10,[3168,9898,0]],['Worker',3,10,[3300,9900,0]]];
 const env:any={asset:(n:string)=>n,fetch:()=>sync({ok:true,json:()=>hunt}),wildLevel:()=>0,S:{world:{tickMs:400}}};
 const t=new Function(...Object.keys(env),`${code};return {aggroTrack,aggroText,aggroHunters};`)(...Object.values(env));
 const b:any={name:'A',inWorld:true,combat:60,pos:{x:3170,z:9900,level:0}};
 // Combat 20: Moss giant (up to 84) and the near Worker (up to 20) hunt it, with a timer, not the far Worker's never.
 expect(t.aggroHunters({...b,combat:20})).toEqual([{name:'Moss giant',never:false},{name:'Worker',never:false}]);
 // Combat 60: Moss giant only. Dark wizard is on another plane.
 expect(t.aggroHunters(b).map((h:any)=>h.name)).toEqual(['Moss giant']);
 // 1,000 ticks x 400 ms = 400 s. The first read gives the most time left.
 expect(t.aggroText(b,0)).toMatchObject({text:'6:40',red:true});
 expect(t.aggroText(b,0).title).toContain('at most 6:40');
 // 10 tiles east is still in the first area: the count goes on. 100 s later, 5:00 left.
 b.pos.x=3180;expect(t.aggroText(b,100e3).text).toBe('5:00');
 // One more tile east leaves the area: a new count, no longer "at most".
 b.pos.x=3181;const a=t.aggroText(b,150e3);expect(a.text).toBe('6:40');expect(a.title).not.toContain('at most');
 // Back west into the old area (kept as the second area): the count goes on.
 b.pos.x=3165;expect(t.aggroText(b,200e3).text).toBe('5:50');
 expect(t.aggroText(b,550e3)).toMatchObject({text:'safe',red:false});
 // A logout drops the record: back at the same tile much later, a new "at most" count, not "safe".
 t.aggroTrack({...b,inWorld:false},600e3);const back=t.aggroText(b,5000e3);expect(back.text).toBe('6:40');expect(back.title).toContain('at most');
 // A teleport is measured from the last seen tile: 3170 -> 3181 (new area) -> 3165 (old area) -> 3206 (41 tiles from
 // 3165) makes both areas new, so a return to 3181 starts the count again.
 const c:any={name:'C',inWorld:true,combat:20,pos:{x:3170,z:9900,level:0}};
 for(const [x,at] of [[3170,0],[3181,10e3],[3165,20e3],[3206,30e3]] as const){c.pos.x=x;t.aggroTrack(c,at);}
 c.pos.x=3181;expect(t.aggroText(c,40e3).text).toBe('6:40');
 // A replayed snapshot: the last read (at) is 0, so the clock stops at 10 s, however late the page draws.
 const d:any={name:'D',inWorld:true,combat:20,at:1,pos:{x:3170,z:9900,level:0}};t.aggroTrack(d,1);
 expect(t.aggroText(d,900e3).text).toBe('6:30');
 // An old snapshot (read at 1 ms), then the live roster at 600 s: the unseen gap starts a new "at most" count.
 d.live={seen:600e3};const r1=t.aggroText(d,600e3);expect(r1.text).toBe('6:40');expect(r1.title).toContain('at most');
 // The roster keeps seeing it every 2 s: the clock runs, and after 400 s the account is safe.
 for(let s=602e3;s<=1000e3;s+=2e3){d.live={seen:s};t.aggroTrack(d,s);}
 expect(t.aggroText(d,1000e3)).toMatchObject({text:'safe'});
 // The live tile goes with the live sight: the status file keeps b.pos at 3170, the roster sees 3182 (out of both
 // areas, still 12 tiles from the Moss giant): a new count, not "safe".
 d.live={seen:1002e3,x:3182,z:9900,level:0};expect(t.aggroText(d,1002e3).text).toBe('6:40');
 // An offline practice row of the same name keeps its own key: the live record stays.
 t.aggroTrack({name:'C',practice:true,inWorld:false},1003e3);expect(t.aggroText(c,1004e3).title).not.toContain('at most');
 // Combat 85 is too strong for the Moss giant outside the Wilderness.
 expect(t.aggroText({...b,name:'B',combat:85},0)).toBeNull();
});

test('regeneration meter: the heal and restore timers, their phase from a 1-point step, at most until seen',()=>{
 const code=shell.slice(shell.indexOf("  // Regeneration meter (RuneLite's"),shell.indexOf('  function infoboxes(){'));
 const t=new Function('S','trackKey',`${code};return {regenTrack,regenHpText,regenStatText};`)({world:{tickMs:400}},(b:any)=>(b?.practice?'practice:':'')+b?.name);
 const b:any={name:'A',inWorld:true,hp:{now:20,max:30},skills:[{name:'Attack',currentLevel:50,level:60},{name:'Prayer',currentLevel:1,level:40}]};
 t.regenTrack(b,0);
 // 10 missing x 100 ticks x 400 ms = 400 s; the phase is not seen yet.
 expect(t.regenHpText(b,0)).toBe(' · full in at most 6:40');
 // Hitpoints 20 -> 21 at 10 s: the timer ticked. At 25 s the next heal is 40 - 15 = 25 s away, then 8 more x 40 s.
 b.hp.now=21;t.regenTrack(b,10e3);expect(t.regenHpText(b,25e3)).toBe(' · next heal in 0:25 · full in 5:45');
 // +1 with a changed pack (a hit and a cake bite) is no timer tick: the phase stays.
 const e:any={...b,name:'E',hp:{now:20,max:30},inventory:[{name:'Cake',count:1}]};t.regenTrack(e,0);
 e.hp={now:21,max:30};e.inventory=[{name:'2/3 cake',count:1}];t.regenTrack(e,10e3);expect(t.regenHpText(e,10e3)).toBe(' · full in at most 6:00');
 // +1 while coins come in (loot only adds) is a timer tick.
 e.inventory=[{name:'2/3 cake',count:1},{name:'Coins',count:50}];e.hp={now:22,max:30};t.regenTrack(e,20e3);expect(t.regenHpText(e,20e3)).toBe(' · next heal in 0:40 · full in 5:20');
 // A heal of 5 (food) is no timer tick: the phase stays. 4 missing: 20 s, then 3 more x 40 s.
 b.hp.now=26;t.regenTrack(b,30e3);expect(t.regenHpText(b,30e3)).toBe(' · next heal in 0:20 · full in 2:20');
 // Attack 50 / 60: at most 400 s; 51 at 12 s sets the phase: at 12 s, 40 s to the next and 8 more.
 expect(t.regenStatText(b,b.skills[0],0)).toBe(' · back to 60 in at most 6:40');
 b.skills[0].currentLevel=51;t.regenTrack(b,12e3);expect(t.regenStatText(b,b.skills[0],12e3)).toBe(' · back to 60 in 6:00');
 // Rapid Heal: heals at 0 s and 20 s (50 ticks) set a 50-tick period: at 20 s the next heal is 20 s away, then 17 x 20 s.
 const f:any={name:'F',inWorld:true,hp:{now:10,max:30},skills:[]};t.regenTrack(f,-5e3);
 f.hp={now:11,max:30};t.regenTrack(f,0);f.hp={now:12,max:30};t.regenTrack(f,20e3);
 expect(t.regenHpText(f,20e3)).toBe(' · next heal in 0:20 · full in 6:00');
 // A drained and a boosted stat use two timers: a rise of the drained one does not set the boosted one's phase.
 const g:any={name:'G',inWorld:true,hp:{now:30,max:30},skills:[{name:'Attack',currentLevel:50,level:60},{name:'Strength',currentLevel:70,level:60}]};t.regenTrack(g,0);
 g.skills[0].currentLevel=51;t.regenTrack(g,10e3);
 expect(t.regenStatText(g,g.skills[0],10e3)).toBe(' · back to 60 in 6:00');expect(t.regenStatText(g,g.skills[1],10e3)).toBe(' · back to 60 in at most 6:40');
 // An offline practice row of the same name does not delete the live record.
 t.regenTrack({...b,practice:true,inWorld:false},30e3);expect(t.regenHpText(b,30e3)).not.toBe('');
 // The clock stops 10 s after the stat read (b.at); a live sight (b.live.seen) does not move it. Heal at 2 s, clock
 // stopped at 12 s: the next heal 30 s away, then 8 x 40 s.
 const h:any={name:'H',inWorld:true,at:1,live:{seen:200e3},hp:{now:20,max:30},skills:[]};t.regenTrack(h,1);
 h.hp={now:21,max:30};h.at=2e3;t.regenTrack(h,2e3);expect(t.regenHpText(h,200e3)).toBe(' · next heal in 0:30 · full in 5:50');
 // Logged out: the record goes.
 t.regenTrack({...b,inWorld:false},40e3);expect(t.regenHpText(b,40e3)).toBe('');
});

test('prayer time left: the server drain counter, the resistance from the prayer bonus',()=>{
 const code=shell.slice(shell.indexOf("  // Prayer time left (RuneLite's"),shell.indexOf('  function infoboxes(){'));
 const bon=(p:number)=>[0,0,0,0,0,0,0,0,0,0,0,0,p];
 const t=new Function('S','wornBonuses',`${code};return {prayerLasts,prayerText};`)({world:{tickMs:400}},(b:any)=>b.bon);
 // Bonus 0: resistance 60, a protect prayer (12) adds 60 each 5 ticks: one point each 5 ticks; 43 points = 215 ticks.
 expect(t.prayerLasts(43,0,12)).toBe(215);
 // Bonus +5: resistance 70; 60 a cycle: a point most cycles, 43 points in 51 cycles = 255 ticks.
 expect(t.prayerLasts(43,5,12)).toBe(255);
 // 36 a tick x 5 = 180 a cycle at resistance 60: 3 points a cycle; 43 points in 15 cycles = 75 ticks.
 expect(t.prayerLasts(43,0,36)).toBe(75);
 const b:any={skills:[{name:'Prayer',currentLevel:43,level:43}],bon:bon(5)};
 // 255 x 400 ms = 102 s = 1:42. The set of 36: 180 a cycle at 70, 43 points in 17 cycles = 85 ticks = 34 s.
 expect(t.prayerText(b)).toBe(' · lasts (prayer bonus +5): a protect prayer 1:42 · with Ultimate Strength and Incredible Reflexes 0:34');
 // Prayer 36: no protect prayer yet (Protect from Magic is 37), no text.
 expect(t.prayerText({...b,skills:[{name:'Prayer',currentLevel:36,level:36}]})).toBe('');
 // Unseen gear: no bonus, no text.
 expect(t.prayerText({...b,bon:null})).toBe('');
});

test('banked XP line: every skill the bank holds XP for, the most first, with the levels gained',()=>{
 const code=shell.slice(shell.indexOf("  // Banked XP line (RuneLite's Banked Experience panel)"),shell.indexOf("  // Death recap (RuneLite's Death Indicator"));
 const banked:any={Prayer:{xp:4725,level:20},Firemaking:{xp:4000,level:22},Cooking:null};
 const b:any={bank:[{name:'Bones',count:1}],skills:[{name:'Prayer',level:1},{name:'Firemaking',level:22}]};
 const line=new Function('skills','bankedXp','nf','E',`${code};return bankedLine;`)(['Prayer','Firemaking','Cooking'],(_b:any,n:string)=>banked[n],(n:number)=>n.toLocaleString('en-GB'),(x:string)=>x);
 const html=line(b);
 expect(html).toContain('Banked XP: 8,725 <small>Prayer +4,725 (+19 levels) · Firemaking +4,000</small>');
 expect(html).toContain('title="Banked XP: Prayer +4,725 (+19 levels), Firemaking +4,000. The bank as last observed."');
 expect(line({skills:b.skills})).toBe('');
});

test('GE sort: the flip margin after the 5% tax, and the high alch profit after a nature rune',()=>{
 const code=shell.slice(shell.indexOf('  // GE sort (RuneLite'),shell.indexOf("  function gePanel(){"));
 const S:any={economy:{supplies:[{name:'Nature rune',ask:260,bid:240}]}};
 const alchOf=(n:string)=>({'Rune platebody':39000} as any)[n]??null;
 const geProfit=new Function('S','alchOf','price',`${code};return geProfit;`)(S,alchOf,()=>null);
 // Sell at 1,999: 99 tax, 1,900 net; buy at 1,501: 399 a flip.
 expect(geProfit({ask:2000,bid:1500,vwap:2500},'flip')).toBe(399);
 // A thin market: the sale is capped at the 7-day average (1,800: 90 tax), and no average gives no flip.
 expect(geProfit({ask:9000,bid:1500,vwap:1800},'flip')).toBe(209);
 expect(geProfit({ask:2000,bid:1500},'flip')).toBe(null);
 expect(geProfit({ask:2000,bid:null,vwap:2000},'flip')).toBe(null);
 // 39,000 - 37,000 - 260 = 1,740 a cast; no alch value or no ask gives none.
 expect(geProfit({name:'Rune platebody',ask:37000},'alch')).toBe(1740);
 expect(geProfit({name:'Cabbage',ask:5},'alch')).toBe(null);
 expect(geProfit({name:'Rune platebody',ask:null},'alch')).toBe(null);
 expect(geProfit({ask:2000,bid:1500},'stock')).toBe(null);
});

test('banked XP: bank items that are the one input of an action, at the best action the level allows',()=>{
 const code=shell.slice(shell.indexOf("  // Banked XP (RuneLite's Banked Experience)"),shell.indexOf('  // Best training spot (Skill Calculator):'));
 require('./xp-tracker.js');const X=(globalThis as any).atlasXp;
 const t=new Function('window',`let skillActions=null;${code};return {bankedXp,set:a=>{skillActions=a;}};`)({atlasXp:X});
 t.set({prayer:[['Bones',1,112.5,['Bones'],[],[526]],['Dragon bones',1,1800,['Dragon bones'],[],[536]]],
  fletching:[['Shortbow',5,125,['Shortbow'],['Shortbow'],[841]],['Bronze arrow',1,32.5,['Bronze arrowtips'],['Bronze arrow'],[39]]],
  cooking:[['Shrimps',1,75,['Raw shrimps'],['Shrimps'],[317]],['Shark',80,5250,['Raw shark'],['Shark'],[383]]],
  crafting:[['Dragonhide body',63,4650,['Dragon leather','Dragon leather','Dragon leather'],['Dragonhide body'],[1745,1745,1745]],['Dragon vambraces',57,1550,['Dragon leather'],['Dragon vambraces'],[1745]],
   ['Black body',84,6450,['Dragon leather','Dragon leather','Dragon leather'],['Black body'],[2509,2509,2509]],['Black vambraces',79,2150,['Dragon leather'],['Black vambraces'],[2509]]]});
 const b:any={skills:[{name:'Prayer',level:1,xp:0},{name:'Fletching',level:10,xp:X.xpForLevel(10)},{name:'Cooking',level:1,xp:0}],
  bank:[{id:526,name:'Bones',count:10},{id:536,name:'Dragon bones',count:2},{id:841,name:'Shortbow',count:5},{id:383,name:'Raw shark',count:100},{id:317,name:'Raw shrimps',count:4}]};
 const p=t.bankedXp(b,'Prayer');
 expect(p).toEqual({xp:4725,items:12,level:X.levelForXp(4725)});
 // A bow named as its own input is not banked XP; a raw shark at Cooking 1 is above the level.
 expect(t.bankedXp(b,'Fletching')).toBe(null);
 expect(t.bankedXp(b,'Cooking')).toEqual({xp:300,items:4,level:X.levelForXp(300)});
 expect(t.bankedXp({skills:b.skills},'Prayer')).toBe(null);
 // Fishing bait is no banked XP.
 t.set({fishing:[['Raw salmon',30,1750,['Feather'],['Raw salmon'],[314]]]});
 expect(t.bankedXp({skills:[{name:'Fishing',level:40,xp:X.xpForLevel(40)}],bank:[{id:314,name:'Feather',count:500}]},'Fishing')).toBe(null);
 t.set({prayer:[['Bones',1,112.5,['Bones'],[],[526]],['Dragon bones',1,1800,['Dragon bones'],[],[536]]],
  fletching:[['Shortbow',5,125,['Shortbow'],['Shortbow'],[841]],['Bronze arrow',1,32.5,['Bronze arrowtips'],['Bronze arrow'],[39]]],
  cooking:[['Shrimps',1,75,['Raw shrimps'],['Shrimps'],[317]],['Shark',80,5250,['Raw shark'],['Shark'],[383]]],
  crafting:[['Dragonhide body',63,4650,['Dragon leather','Dragon leather','Dragon leather'],['Dragonhide body'],[1745,1745,1745]],['Dragon vambraces',57,1550,['Dragon leather'],['Dragon vambraces'],[1745]],
   ['Black body',84,6450,['Dragon leather','Dragon leather','Dragon leather'],['Black body'],[2509,2509,2509]],['Black vambraces',79,2150,['Dragon leather'],['Black vambraces'],[2509]]]});
 // Dragon leather: matched by id, at the most XP per leather the level allows, in whole actions. At Crafting 84 green
 // leather: 7 make 2 bodies (4,650 for 3, 1,550 a leather) and leave 1, as vambraces give 1,550 a leather too;
 // black leather: 4 make 1 body (6,450) and leave 1. At Crafting 70 black leather counts nothing.
 const c:any={skills:[{name:'Crafting',level:84,xp:X.xpForLevel(84)}],bank:[{id:1745,name:'Dragon leather',count:7},{id:2509,name:'Dragon leather',count:4}]};
 expect(t.bankedXp(c,'Crafting')).toEqual({xp:2*4650+6450,items:9,level:X.levelForXp(X.xpForLevel(84)+2*4650+6450)});
 c.skills[0]={name:'Crafting',level:70,xp:X.xpForLevel(70)};c.bank=[{id:2509,name:'Dragon leather',count:4}];
 expect(t.bankedXp(c,'Crafting')).toBe(null);
});

test('quest requirements: met, missing with the level held, unknown, and the Ready test',()=>{
 const code=shell.slice(shell.indexOf("  // Quest requirements (RuneLite's Quest Helper)"),shell.indexOf('  // The third list is XP that is one of several outcomes'));
 const data={"Hero's Quest":{s:[['Mining',52,1],['Cooking',53,0]],qp:[55,1],q:[['Lost City',1],['Dragon Slayer',0]]},'Lost City':{s:[['Woodcutting',36,1]],q:[]}};
 const sync=(v:any)=>({then(f:any){return sync(f(v));}});
 const env:any={asset:(n:string)=>n,fetch:()=>sync({ok:true,json:()=>data}),E:(x:string)=>x};
 const t=new Function(...Object.keys(env),`${code};return {questReqs,questReady,reqHtml};`)(...Object.values(env));
 const b:any={skills:[{name:'Mining',level:60},{name:'Cooking',level:40},{name:'Woodcutting',level:36}],ranks:[{board:'Quest Points',level:60}],
  quests:[{name:'Lost City',state:'complete'},{name:"Hero's Quest",state:'not started'}]};
 expect(t.questReqs(b,"Hero's Quest").map((x:any)=>[x.text,x.ok])).toEqual([['52 Mining',true],['53 Cooking',false],['55 quest points',true],['Lost City',true],['Dragon Slayer',null]]);
 expect(t.reqHtml(b,"Hero's Quest")).toContain('<span class="req-miss req-soft" title="only the wiki lists this · has 40">53 Cooking (40)</span>');
 expect(t.questReady(b,b.quests[1])).toBe(false);
 // Done quests are never ready; a quest with no listed requirement is ready.
 expect(t.questReady(b,b.quests[0])).toBe(false);
 expect(t.questReady(b,{name:"Cook's Assistant",state:'not started'})).toBe(true);
 b.skills[1].level=53;b.quests.push({name:'Dragon Slayer',state:'complete'});
 expect(t.questReady(b,b.quests[1])).toBe(true);
 expect(t.reqHtml(b,'Nothing')).toBe('');
 // Before the data loads (or when it fails), no quest is ready.
 const pending=new Function(...Object.keys(env),`${code};return questReady;`)(...Object.values({...env,fetch:()=>({then:()=>({then:()=>{}})})}));
 expect(pending(b,{name:"Cook's Assistant",state:'not started'})).toBe(false);
 expect(shell).toContain(".filter(([id])=>id!=='ready'||(typeof questReqData!=='undefined'&&questReqData))");
 // Items: held across the pack, worn gear and the bank.
 data['Lost City']={s:[],q:[],i:[['Knife',1,1],['Plank',3,0]]} as any;
 const t2=new Function(...Object.keys(env),`${code};return {questItems,itemHtml};`)(...Object.values(env));
 const c:any={inventory:[{name:'Plank',count:1}],equipment:[],bank:[{name:'Knife',count:1},{name:'Plank',count:1}],bankAt:1};
 expect(t2.questItems(c,'Lost City').map((x:any)=>[x.text,x.ok,x.have])).toEqual([['Knife',true,1],['3 Plank',false,2]]);
 expect(t2.itemHtml(c,'Lost City')).toContain('<span class="req-miss req-soft" title="only the wiki lists this · holds 2">3 Plank (2)</span>');
});

test('cooking: the burn chance of the followed account on a fire, a range and with gauntlets, and the no-burn level',()=>{
 const code=shell.slice(shell.indexOf('  // Cooking burn chance (RuneLite'),shell.indexOf("  // High alchemy (RuneLite's item prices"));
 const data={'Raw shark':{c:'Shark',lv:80,f:[1,202],r:[1,232],g:[15,270]},'Raw lobster':{c:'Lobster',lv:40,f:[38,332],g:[55,368]}};
 const sync=(v:any)=>({then(f:any){return sync(f(v));}});
 let lv:any=85;
 const env:any={asset:(n:string)=>n,fetch:()=>sync({ok:true,json:()=>data}),account:()=>({}),curLevel:()=>lv};
 const t=new Function(...Object.keys(env),`${code};return {cookTip,cookOk};`)(...Object.values(env));
 // Shark at 85: fire 174/256 cooks, range 199/256, gauntlets 234/256; a range burns it even at 99 (233/256).
 expect(t.cookTip({name:'Raw shark'})).toBe(' · burn at Cooking 85: fire 32%, range 22%, gauntlets 9% · a range burns it even at 99');
 lv=50;
 expect(t.cookTip({name:'Raw lobster'})).toBe(' · burn at Cooking 50: fire or range 27%, gauntlets 17% · no burns on a range from 74');
 lv=74;expect(t.cookTip({name:'Raw lobster'})).toContain('fire or range 0%, gauntlets 0% · no burns on a range');
 lv=60;expect(t.cookTip({name:'Raw shark'})).toBe(' · Cooking 80 needed to cook');
 lv=null;expect(t.cookTip({name:'Raw shark'})).toBe(' · cooks to Shark at Cooking 80');
 expect(t.cookTip({name:'Shark'})).toBe('');
});

test('the skilling session box shows the burn rate of the cooked foods',()=>{
 const start=shell.indexOf('    const sessionLine=b=>{'),code=shell.slice(start,shell.indexOf('\n',shell.indexOf('% burn rate',start)));
 const cookData={'Raw shark':{c:'Shark'}};
 const sessionLine=new Function('cookData','line','nf','SESSION_VERB',`${code};return sessionLine;`)(cookData,(k:string,v:string)=>k+': '+v+'\n',(n:number)=>String(n),{cooking:'Food cooked'});
 const b:any={goalSkill:'Cooking',flow:{since:0,at:3.6e6,loot:[{name:'Raw shark',count:100},{name:'Shark',count:75},{name:'Burnt shark',count:25}]}};
 expect(sessionLine(b)).toBe('Food cooked: Raw shark 100 · 100/hr\nBurnt: 25 · 25% burn rate\n');
 b.flow.loot=[{name:'Shark',count:10}];
 expect(sessionLine(b)).toBe('Food cooked: Shark 10 · 10/hr\n');
});

test('high alch: the server value, the profit of a cast after the market buy and a nature rune, no coins',()=>{
 const code=shell.slice(shell.indexOf("  // High alchemy (RuneLite's item prices"),shell.indexOf('  function stackValue(items){'));
 const data={'Rune platebody':65000,'Coins':1,'Steel arrow':12,'Cabbage':1};
 const sync=(v:any)=>({then(f:any){const r=f(v);return sync(r);}});
 const prices:Record<string,any>={'Rune platebody':{value:38000,ask:37000,bid:36000},'Nature rune':{value:250,ask:260,bid:240},'Steel arrow':{value:5,ask:null,bid:null}};
 const env:any={asset:(n:string)=>n,fetch:()=>sync({ok:true,json:()=>data}),price:(n:string)=>/^coins$/i.test(n)?{value:1}:prices[n]??null,nf:(n:number)=>n.toLocaleString('en-US'),gp:(n:number)=>n.toLocaleString('en-US')+' gp'};
 const t=new Function(...Object.keys(env),`${code};return {alchOf,alchTip,priceTip};`)(...Object.values(env));
 expect(t.alchOf('Rune platebody')).toBe(39000);
 expect(t.alchOf('Cabbage')).toBe(1);
 expect(t.alchOf('Coins')).toBe(null);
 expect(t.alchOf('Unknown')).toBe(null);
 // 39,000 - 37,000 - 260 = 1,740 profit a cast.
 expect(t.alchTip({name:'Rune platebody',count:1})).toBe(' · high alch 39,000 · alch profit +1,740 a cast after the market buy and a nature rune');
 // No market ask: the alch value against the item value.
 expect(t.alchTip({name:'Steel arrow',count:100})).toBe(' · high alch 7 (700 gp for 100) · alch pays 2 more than the value');
 // A loss shows no profit text.
 prices['Rune platebody']={value:40000,ask:39500,bid:39000};
 expect(t.alchTip({name:'Rune platebody',count:1})).toBe(' · high alch 39,000');
 expect(t.priceTip({name:'Coins',count:5})).toBe('');
 expect(t.priceTip({name:'Cabbage',count:1})).toBe(' · high alch 1');
 expect(t.priceTip({name:'Rune platebody',count:1})).toContain('market buy 39,500 / sell 39,000 · high alch 39,000');
});

test('the Wilderness level counts 8 tiles for each level from the south edge of each zone',()=>{
 const code=shell.slice(shell.indexOf('  const wildLevel=p=>'),shell.indexOf('  function infoboxes(){'));
 const wildLevel=new Function(`${code};return wildLevel;`)();
 expect(wildLevel({x:3100,z:3519})).toBe(0);
 expect(wildLevel({x:3100,z:3520})).toBe(1);
 expect(wildLevel({x:3100,z:3527})).toBe(1);
 expect(wildLevel({x:3100,z:3528})).toBe(2);
 expect(wildLevel({x:3100,z:9920})).toBe(1);
 expect(wildLevel({x:2666,z:3600})).toBe(0);
 expect(wildLevel(null)).toBe(0);
});

test('the inventory value is the sum of the item values, and the tooltip counts the items with no value',()=>{
 const code=shell.slice(shell.indexOf('  function invWorth(items){'),shell.indexOf("  // Equipment Stats (the game's"));
 const vals:any={Coins:1,Lobster:150};
 const invWorth=new Function('price','gp',`${code};return invWorth;`)((n:string)=>vals[n]!=null?{value:vals[n]}:null,(n:number)=>String(n));
 expect(invWorth([{name:'Coins',count:1000},{name:'Lobster',count:2},undefined,{name:'Odd thing',count:1}])).toBe('<p class="game-muted inv-worth" title="The sum of the item values · 1 item has no value">Worth 1300 gp</p>');
 expect(invWorth([{name:'Odd thing',count:1}])).toBe('');
});

test('one of our names in a public chat line is marked, and the mark does not touch other text',()=>{
 const code=shell.slice(shell.indexOf('  function mention(html){'),shell.indexOf('  function renderChat(){'));
 const S={bots:[{name:'Woodenstaff'},{name:'Amp'},{name:'Practice1',practice:true},{name:'Main'}]};
 const mention=new Function('S','safeName',`${code};return mention;`)(S,(n:string)=>n==='Main'?'Hidden':n);
 expect(mention('is woodenstaff a bot? &amp; Main, Practice1')).toBe('is <span class="chat-hl">woodenstaff</span> a bot? &amp; Main, Practice1');
 expect(mention('Woodenstaffs')).toBe('Woodenstaffs');
});

test('a line with key=value pairs keeps the words between them, and a marked name stays out of the tooltip',()=>{
 const code=shell.slice(shell.indexOf('  const KV='),shell.indexOf('  function renderChat(){'));
 const E=(s:unknown)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!));
 const {pretty,mention}=new Function('S','safeName','E',`${code};return {pretty,mention};`)({bots:[{name:'Woodenstaff'}]},(n:string)=>n,E);
 expect(pretty('t=1200 mined iron ore total=57 done')).toBe('<span title="t=1200 mined iron ore total=57 done">tick 1,200 mined iron ore · total 57 done</span>');
 expect(mention(pretty('Woodenstaff hp=10 str=20'))).toBe('<span title="Woodenstaff hp=10 str=20"><span class="chat-hl">Woodenstaff</span> hp 10 · str 20</span>');
});
test('the Quest Journal fleet view counts each quest over our accounts and colours it',()=>{
 const src=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
 const code=src.slice(src.indexOf("  let questScope='account';"),src.indexOf('  function gamePanel(){'));
 const bots=[{name:'Alpha',quests:[{name:'Cook\'s Assistant',state:'complete'},{name:'Imp Catcher',state:'started'}]},{name:'Bravo',quests:[{name:'Cook\'s Assistant',state:'complete'},{name:'Imp Catcher',state:'not started'}]},{name:'Prac',practice:true,quests:[{name:'Imp Catcher',state:'complete'}]}];
 const run=(detail:string|null,filter='all')=>new Function('S','E','safeName',`let questDetail=${JSON.stringify(detail)},questFilter=${JSON.stringify(filter)},questQuery='';${code};return fleetQuests();`)({bots},(s:any)=>String(s),(s:any)=>s);
 const list=run(null);
 expect(list).toContain('1 of 2 done by an account · 1 by all 2');
 expect(list).toMatch(/color:#00ff00" data-quest="Cook's Assistant"[^>]*><span>Cook's Assistant<\/span><span>2\/2/);
 expect(list).toMatch(/color:#ffff00" data-quest="Imp Catcher"[^>]*><span>Imp Catcher<\/span><span>0\/2/);
 const detail=run('Imp Catcher');
 expect(detail).toContain('<span style="color:#ffff00" title="started">Alpha</span><span style="color:#ff0000" title="not started">Bravo</span>');
 expect(run(null,'completed')).not.toContain('Imp Catcher');
});
test('PvP Tools: risk, the 3 kept items, and only the players the server lets attack',()=>{
 const code=shell.slice(shell.indexOf('  const wildLevel=p=>'),shell.indexOf('  function infoboxes(){'));
 const S={economy:{itemValues:{'Rune scimitar':15000,'Shark':800,'Amulet of power':3000}},bots:[{name:'Ours1'},{name:'Mate'}],
  roster:[['Near',3100,3700,0,72],['Far',3100,3740,0,72],['Strong',3101,3701,0,95],['Mate',3100,3701,0,70],['Outside',3100,3500,0,70],['Upstairs',3100,3700,1,70]]};
 const {pvpState}=new Function('S',`${code};return {pvpState};`)(S);
 // Wilderness level at z 3700 is 23: combat 70 can fight 47-93.
 const p=pvpState({name:'Ours1',inWorld:true,combat:70,pos:{x:3102,z:3702,level:0},equipment:[{name:'Rune scimitar',count:1},{name:'Amulet of power',count:1}],inventory:[{name:'Shark',count:20}]});
 expect(p.wild).toBe(23);
 expect(p.risk).toBe(15000+3000+16000);
 expect(p.kept.map((k:any)=>k.name)).toEqual(['Rune scimitar','Amulet of power','Shark']);
 expect(p.keptValue).toBe(18800);expect(p.lost).toBe(34000-18800);
 // Far is 38 tiles away, Strong is 25 levels apart, Mate is ours, Outside is not in the Wilderness, Upstairs is on another floor.
 expect(p.threats.map((t:any)=>t.name)).toEqual(['Near']);
 expect(pvpState({name:'Ours1',inWorld:false})).toBeNull();
});
test('the death recap card shows the tile, the last hit, hitsplats and what the death took',()=>{
 const code=shell.slice(shell.indexOf('  let recap={name:null'),shell.indexOf('  // Quest Journal, Fleet view'));
 const wild=shell.slice(shell.indexOf('  const wildLevel=p=>'),shell.indexOf('  const canAttack='));
 const {recapHtml}=new Function('E','safeName','age','icon','qty','document','window','put','minimap',`${wild};${code};return {recapHtml};`)(String,(s:any)=>s,()=>'5m',(n:string)=>`[${n}]`,(n:number)=>`(${n})`,{createElement:()=>({})},{atlasOperator:()=>true},()=>{},()=>{});
 const html=recapHtml({name:'Alpha',state:'ok',data:{at:1,pos:{x:3100,z:3700,level:0},killer:'Goondelf (level 80)',hits:[{tick:11,damage:6,source:'Goondelf (level 80)'},{tick:12,damage:0,source:'Goondelf (level 80)'}],hp:[[10,10],[11,4],[12,0]],actions:[{tick:11,type:'eatFood'}],carried:[{name:'Shark',count:5}],kept:[],lost:[{name:'Shark',count:5}],script:'scripts/pk.ts',tick:12}});
 expect(html).toContain('Tile 3100, 3700');expect(html).toContain('Wilderness 23');
 expect(html).toContain('Last hit: <b>Goondelf (level 80)</b>');
 expect(html).toContain('<span class="hitsplat" title="tick 11 · Goondelf (level 80)">6</span><span class="hitsplat zero"');
 expect(html).toContain('Lost</div><div class="recap-items"><span class="recap-item" title="Shark × 5">[Shark](5)</span>');
 expect(html).toContain('pk.ts · tick 12');
 expect(recapHtml({name:'Alpha',state:'none'})).toContain('No death in the newest tick records');
});
test('the death recap is read again for a newer death, and while it waits for the respawn after 30 s',()=>{
 const code=shell.slice(shell.indexOf('  // A recap belongs to one reported death'),shell.indexOf('  function recapHtml(r){'));
 const t=new Function('window','S','paintRecap','minimap','fetch',`${code};return {recapStale,set:(r)=>{recap=r;}};`)({atlasOperator:()=>true},{bots:[]},()=>{},()=>{},()=>new Promise(()=>{}));
 const b={name:'Alpha',death:{at:100}};
 t.set({name:'Alpha',state:'ok',data:{kept:[]},deathAt:100,at:Date.now()});expect(t.recapStale(b)).toBe(false);
 const D=1_000_000_000,b2={name:'Alpha',death:{at:D}};
 t.set({name:'Alpha',state:'ok',data:{kept:[],at:D-60_000},deathAt:D,at:Date.now()-31_000});expect(t.recapStale(b2)).toBe(false);
 t.set({name:'Alpha',state:'ok',data:{kept:[],at:D-20*60_000},deathAt:D,at:Date.now()-31_000});expect(t.recapStale(b2)).toBe(true);
 t.set({name:'Alpha',state:'ok',data:{kept:[],at:D-20*60_000},deathAt:D,at:Date.now()});expect(t.recapStale(b2)).toBe(false);
 expect(t.recapStale({...b,death:{at:200}})).toBe(true);
 t.set({name:'Alpha',state:'ok',data:{kept:null},deathAt:100,at:Date.now()-31_000});expect(t.recapStale(b)).toBe(true);
 t.set({name:'Alpha',state:'ok',data:{kept:null},deathAt:100,at:Date.now()});expect(t.recapStale(b)).toBe(false);
 for(const state of ['none','error']){t.set({name:'Alpha',state,data:null,deathAt:100,at:Date.now()-31_000});expect(t.recapStale(b)).toBe(true);t.set({name:'Alpha',state,data:null,deathAt:100,at:Date.now()});expect(t.recapStale(b)).toBe(false);}
 expect(t.recapStale({name:'Alpha'})).toBe(false);expect(t.recapStale({...b,practice:true})).toBe(false);
});
test('Party: a card per PK account with hitpoints, prayer, run, food and a red edge when hurt',()=>{
 const code=shell.slice(shell.indexOf('  const PK_GOAL='),shell.indexOf('  function worldPanel(){'));
 const S={bots:[
  {name:'Tribrid1',inWorld:true,combat:90,goal:'pk roam edgeville',pos:{x:3093,z:3500,level:0},hp:{now:30,max:99},runEnergy:55,skills:[{name:'Prayer',level:70,currentLevel:40}],inventory:[{name:'Shark',count:1},{name:'Shark',count:1},{name:'Rune scimitar',count:1}]},
  {name:'Fisher',inWorld:true,goal:'fish sharks',pos:{x:2600,z:3400,level:0}},
  {name:'Offline',inWorld:false,goal:'pk'},
 ]};
 const {partyBox}=new Function('S','E','safeName','itemStats','wildLevel','pvpState',`${code};return {partyBox};`)(S,String,(s:any)=>s,{Shark:'heals 20'},()=>0,()=>null);
 const html=partyBox();
 expect(html).toContain('1 PK account');expect(html).toContain('Tribrid1');expect(html).not.toContain('Fisher');expect(html).not.toContain('Offline');
 expect(html).toContain('party-card party-alert');
 expect(html).toContain('<span>30 / 99</span>');expect(html).toContain('<span>40 / 70</span>');
 expect(html).toContain('Run <b>55%</b>');expect(html).toContain('Food <b>2</b>');
});
test('respawn timers: the time left is the base scaled by the players online, less the time since the rock was taken',()=>{
 const code=shell.slice(shell.indexOf("  // Respawn timers (RuneLite's Mining"),shell.indexOf("  // Party (RuneLite's Party panel)"));
 const S={world:{tickMs:400},roster:Array.from({length:2000},(_,i)=>['p'+i,0,0,0,3])};
 const t=new Function('S','asset','fetch','setInterval','E','$','location',`${code};return {respawnRows,set:(d,r)=>{depletedNow=d;resources=r;}};`)(S,(n:string)=>n,()=>new Promise(()=>{}),()=>0,String,()=>null,{origin:''});
 const res={kinds:{2106:{name:'Runite rock',base:1200,min:null,max:null},1281:{name:'Oak tree',base:null,min:120,max:199}},depleted:[450],byTile:new Map([['3059,3884,0',2106],['3000,3000,0',1281]])};
 t.set({tick:110,at:1000,list:[[3059,3884,0,450,100],[3000,3000,0,1342,null],[1,1,0,450,100]]},res);
 const rows=t.respawnRows(1000);
 // 2,000 players halve the base: 600 ticks of 0.4 s = 240 s, less 10 ticks = 4 s.
 expect(rows[0]).toEqual({name:'Runite rock',x:3059,z:3884,l:0,left:236,range:null,total:240});
 // A start the view did not see has no countdown; a tile with no resource is left out.
 expect(rows[1]).toMatchObject({name:'Oak tree',left:null,range:null});
 expect(rows.length).toBe(2);
});
test('the XP Tracker account list sorts by XP an hour, or by idle ticks',()=>{
 const line=shell.split('\n').find(l=>l.includes("live.sort(xpSort==='waste'"))!.trim();
 const run=(xpSort:string)=>{const live=[{name:'A',xpPerHour:10,timeline:'xxxx'},{name:'B',xpPerHour:30,timeline:'iiii'},{name:'C',timeline:'xxii'}];const idle=(x:any)=>window.efficiency(x.timeline);new Function('live','xpSort','idle',line)(live,xpSort,idle);return live.map(x=>x.name).join('');};
 const window:any={efficiency:(t:string)=>t.split('').filter(c=>c==='i').length};
 expect(run('rate')).toBe('BAC');expect(run('waste')).toBe('BCA');
});
test('3D highlights: one overlay message with threats, rivals, fought npcs, labels, lines, the death tile and pies',()=>{
 const code=shell.slice(shell.indexOf('  // Highlights in the 3D view'),shell.indexOf("  // Respawn timers (RuneLite's Mining"));
 const b={name:'Alpha',inWorld:true,pos:{x:3100,z:3700,level:0},combat:70};
 const env={S:{economy:{itemValues:{'Rune scimitar':15000}},rivals:[{rows:[{name:'Goondelf'},{name:'Bad Name!'},{name:'Ours',fleet:true}]}]},account:()=>b,asset:(n:string)=>n,fetch:()=>new Promise(()=>{}),localStorage:{getItem:()=>null,setItem:()=>{}},window:{atlasCam3d:{x:3100,z:3700,at:Date.now()}},
  wildLevel:()=>23,pvpState:()=>({threats:[{name:'Near'}]}),recap:{state:'ok',name:'Alpha',data:{pos:{x:3101,z:3702,level:0}}},respawnRows:()=>[{x:3059,z:3884,l:0,left:30,total:120},{x:1,z:1,l:0,left:null,total:null}],VIEWER:{state:'loading'},$:()=>null,nf:String,location:{origin:''}};
 const t=new Function(...Object.keys(env),`${code};return {overlayMessage,setLines:(l)=>{multiLines=l;},setTargets:(t,who='Alpha')=>{recentTargets=t;targetsFor=who;}};`)(...Object.values(env));
 t.setLines([[3120,3712,3120,3720,0],[100,100,108,100,0],[3130,3520,3130,3968,0]]);t.setTargets([2181]);
 const o=t.overlayMessage();
 expect(o.players).toEqual({goondelf:'#00ffff',near:'#ff0000'});
 expect(o.npcs).toEqual([{types:[2181],colour:'#00ffff'}]);
 expect(o.ground).toEqual({prices:{'Rune scimitar':15000},min:1000});
 expect(o.lines).toContainEqual({x0:3120,z0:3712,x1:3120,z1:3720,l:0,colour:'#ff0000'});
 // A long edge through the camera area keeps its part near the camera, though its middle is 204 tiles away.
 expect(o.lines).toContainEqual({x0:3130,z0:3640,x1:3130,z1:3760,l:0,colour:'#ff0000'});
 expect(o.lines.some((l:any)=>l.x0===100)).toBe(false);
 expect(o.lines).toContainEqual({x0:3040,z0:3672,x1:3160,z1:3672,l:0,colour:'#ffff00',label:'Level 20'});
 expect(o.tiles).toEqual([{x:3101,z:3702,l:0,colour:'#ff0000',fill:true,label:'Death'}]);
 // Another watched account starts with no fought npcs.
 t.setTargets([2181],'Other');expect(t.overlayMessage().npcs).toEqual([]);
 expect(o.pies).toEqual([{x:3059,z:3884,l:0,p:0.75}]);
});
test('Skill Calculator: XP left to the target, the time at the rate, and each action with its count',()=>{
 const code=shell.slice(shell.indexOf('  // Skill Calculator (RuneLite\'s)'),shell.indexOf("  const XP_STORE='atlas-xp-baselines';"));
 require('./xp-tracker.js');const X=(globalThis as any).atlasXp;
 const t=new Function('window','asset','fetch','E','icon','nf','dur',`${code};return {calcBox,set:(s,t,a)=>{calcSkill=s;calcTarget=t;skillActions=a;}};`)({atlasXp:X},(n:string)=>n,()=>new Promise(()=>{}),String,(n:string)=>`[${n}]`,(n:number)=>String(n),(ms:number)=>Math.round(ms/60000)+'m');
 const xp=X.xpForLevel(60)+10;
 t.set('Woodcutting',61,{woodcutting:[['Willow logs',30,67.5,[],['Willow logs']],['Yew logs',60,175,[],['Yew logs']],['Magic logs',75,250,[],['Magic logs']]]});
 const left=X.xpForLevel(61)-xp,html=t.calcBox({skills:[{name:'Woodcutting',xp}]},{rate:left});
 expect(html).toContain('Current <b>60</b>');expect(html).toContain('value="61"');
 expect(html).toContain(`<b>${left}</b> xp left`);expect(html).toContain('TTL 60m');
 expect(html).toContain(`<span class="calc-count">${Math.ceil(left/175)}</span>`);
 expect(html).toMatch(/calc-row calc-locked"[^>]*>\[Magic logs\]/);
 t.set(null,null,null);expect(t.calcBox({skills:[]},null)).toBe('');
});
test('skilling highlights and the trail: the resource of the top loot item near the account, fishing spots, the walked path',()=>{
 const code=shell.slice(shell.indexOf('  // Highlights in the 3D view'),shell.indexOf("  // Respawn timers (RuneLite's Mining"));
 const b:any={name:'Alpha',inWorld:true,pos:{x:3100,z:3400,level:0},goalSkill:'Woodcutting',flow:{since:0,at:3_600_000,loot:[{name:'Logs',count:3},{name:'Yew logs',count:40}]}};
 const S:any={economy:{itemValues:{}},bots:[b]};
 const env:any={S,D:{rival:new Set()},account:()=>b,asset:(n:string)=>n,fetch:()=>new Promise(()=>{}),localStorage:{getItem:()=>null,setItem:()=>{}},window:{},
  wildLevel:()=>0,pvpState:()=>null,recap:{state:'none'},respawnRows:()=>[],VIEWER:{state:'loading'},$:()=>null,nf:String,location:{origin:''},
  resources:{kinds:{1:{name:'Yew tree'},2:{name:'Oak tree'},3:{name:'Iron rock'}},tiles:[[3105,3402,0,1],[3104,3400,0,2],[3130,3400,0,1],[3101,3401,0,3]]}};
 const t=new Function(...Object.keys(env),`${code};return {overlayMessage,trackTrails,resourceOf,setFish:(f)=>{fishingTypes=f;}};`)(...Object.values(env));
 expect([t.resourceOf('Yew logs'),t.resourceOf('Achey tree logs'),t.resourceOf('Iron ore'),t.resourceOf('Coal'),t.resourceOf('Shark')]).toEqual(['Yew tree','Achey tree','Iron rock','Coal rock',null]);
 t.trackTrails();b.pos={x:3101,z:3400,level:0};t.trackTrails();b.pos={x:3102,z:3401,level:0};t.trackTrails();
 let o=t.overlayMessage();
 // Only the yew within 15 tiles: not the oak, not the yew 30 tiles away, not the rock.
 expect(o.tiles).toEqual([{x:3105,z:3402,l:0,colour:'#00ffff'}]);
 expect(o.lines.filter((l:any)=>l.colour==='#ffff00').length).toBe(2);
 b.goalSkill='Fishing';b.flow={since:0,at:1,loot:[]};t.setFish([233,309]);o=t.overlayMessage();
 expect(o.npcs).toContainEqual({types:[233,309],colour:'#00ffff'});
});
test('agility obstacles, Ground markers, failure markers and the NPC finder in the 3D view',()=>{
 const code=shell.slice(shell.indexOf('  // Highlights in the 3D view'),shell.indexOf("  // Respawn timers (RuneLite's Mining"));
 const b:any={name:'Alpha',inWorld:true,pos:{x:2474,z:3436,level:0},goalSkill:'Agility'};
 const failed:any={name:'Beta',inWorld:false,pos:{x:2480,z:3440,level:0},lastRes:{at:Date.now()-60_000,ok:false,died:false,text:'fail travel to Ardougne failed: timeout far walk: tick stream stalled'}};
 const old:any={name:'Gamma',inWorld:false,pos:{x:2481,z:3441,level:0},lastRes:{at:Date.now()-2*86_400_000,ok:false,text:'fail x'}};
 const S:any={economy:{itemValues:{}},bots:[b,failed,old]},saved:Record<string,string>={'atlas-ground-marks':JSON.stringify([{x:2470,z:3430,l:0,c:'#00ff00'},{x:2700,z:3430,l:0,c:'#00ff00'}])};
 const env:any={S,D:{rival:new Set()},account:()=>b,asset:(n:string)=>n,fetch:()=>new Promise(()=>{}),localStorage:{getItem:(k:string)=>saved[k]??null,setItem:(k:string,v:string)=>{saved[k]=v;}},window:{},
  wildLevel:()=>0,pvpState:()=>null,recap:{state:'none'},respawnRows:()=>[],VIEWER:{state:'loading'},$:()=>null,nf:String,E:String,location:{origin:''},resources:null,safeName:String,miniView:{cx:2474,cz:3436,PX:4}};
 const t=new Function(...Object.keys(env),`${code};return {overlayMessage,toggleMark,finderMatches,finderList,failReason,set:(a,n,p)=>{agilityTiles=a;npcSpawns=n;finderPick=p;}};`)(...Object.values(env));
 t.set([[2474,3435,0,'Walk-across'],[2474,3435,1,'Climb'],[2500,3435,0,'Climb-over']],[['Hill Giant',28,28,[2470,3440,0,3100,9840,0]],['Giant rat',3,3,[3200,3200,0]]],null);
 let o=t.overlayMessage();
 // The obstacle within 15 tiles on the account's floor; the near marker; the recent failure, not the 2-day-old one.
 expect(o.tiles).toContainEqual({x:2474,z:3435,l:0,colour:'#00ff00',label:'Walk-across'});
 expect(o.tiles.filter((x:any)=>x.label==='Climb'||x.label==='Climb-over')).toEqual([]);
 expect(o.tiles).toContainEqual({x:2470,z:3430,l:0,colour:'#00ff00'});
 expect(o.tiles.some((x:any)=>x.x===2700)).toBe(false);
 expect(o.tiles).toContainEqual({x:2480,z:3440,l:0,colour:'#ff9900',fill:true,label:'Beta: travel to Ardougne failed · tick stream stalled'});
 expect(o.tiles.some((x:any)=>x.x===2481)).toBe(false);
 // A marker toggles off and on, and stays in this browser.
 expect(t.toggleMark(2470,3430,0)).toBe(false);expect(JSON.parse(saved['atlas-ground-marks']!).length).toBe(1);
 expect(t.toggleMark(2471,3431,0)).toBe(true);expect(t.overlayMessage().tiles).toContainEqual({x:2471,z:3431,l:0,colour:'#ffff00'});
 // The finder: names that start with the text first, then the pick's near spawns in pink.
 expect(t.finderMatches('gi').map((r:any)=>r[0])).toEqual(['Giant rat','Hill Giant']);
 expect(t.finderMatches('g')).toEqual([]);
 t.set(null,[['Hill Giant',28,28,[2470,3440,0,3100,9840,0]]],'Hill Giant');
 expect(t.overlayMessage().tiles).toContainEqual({x:2470,z:3440,l:0,colour:'#ff66ff',label:'Hill Giant (28)'});
 expect(t.overlayMessage().tiles.some((x:any)=>x.z===9840)).toBe(false);
 expect(t.finderList()).toContain('level 28 · 2 spawns');expect(t.finderList()).toContain('data-finder-go="2470,3440"');
 expect(t.failReason('fail')).toBe('failed');
 expect(t.failReason('fail TickStallError: tick stream stalled: no new game tick for 15000ms')).toBe('tick stream stalled');
 expect(t.failReason('fail fleet-trade 17-a-b-bones reconcile 0/94: Error: transfer requires reconciliation')).toBe('fleet-trade: transfer requires reconciliation');
 expect(t.failReason('fail mode=giant ok=false creditedKills=16 banked={"bigBones":0}')).toBe('giant: run ended, not ok');
 expect(t.failReason('fail {"ok":false,"phase":"settled","targetMet":false,"banked":true')).toBe('target not met');
 // Two accounts on one tile share one marker.
 S.bots.push({name:'Delta',inWorld:false,pos:{x:2480,z:3440,level:0},lastRes:{at:Date.now(),ok:false,text:'fail TickStallError: tick stream stalled'}});
 const spot=t.overlayMessage().tiles.filter((x:any)=>x.colour==='#ff9900');
 expect(spot).toEqual([{x:2480,z:3440,l:0,colour:'#ff9900',fill:true,label:'2 accounts: travel to Ardougne failed · tick stream stalled'}]);
});
test('Inventory Tags: food, potions, teleports and runes get their group class; the switch turns them off',()=>{
 const code=shell.slice(shell.indexOf('  // Inventory Tags (RuneLite'),shell.indexOf("  // Equipment Stats (the game's"));
 const hl:any={invTags:true};
 const invTag=new Function('hl','itemStats',`${code};return invTag;`)(hl,{Shark:'heals 20','Jug of wine':'Attack -2 · heals 11','Strength potion(3)':'Strength +3 + 10%'});
 expect(['Shark','Jug of wine','Strength potion(3)','Amulet of glory(4)','Varrock teleport','Fire rune','Coins'].map(n=>invTag({name:n,count:1})))
  .toEqual([' tag-food',' tag-food',' tag-potion',' tag-tele',' tag-tele',' tag-rune','']);
 hl.invTags=false;expect(invTag({name:'Shark'})).toBe('');expect(invTag(null)).toBe('');
});
test('GE item sources: a row opens its sources, and a source with places has Show on map',()=>{
 const code=shell.slice(shell.indexOf('  function gePanel(){'),shell.indexOf('  // Pull requests plugin'));
 const state:any={bots:[],economy:{supplies:[{id:1,name:'Coal',ask:150}]}};
 const run=new Function('S','window','E','nf','icon','loadItemSources','data',`const geTele=()=>'';let geQuery='',geAll=true,geOpen='1',geOpenName='Coal',sourcePin=null,itemSourcesData=data;const age=()=>'';${code};return gePanel();`);
 const html=run(state,{atlasOperator:()=>false},String,String,()=>'<i/>',()=>{},{1:[['gather','Mining 30: Coal rock',[3000,3000,0,3001,3001,0]],['drop','Drop: Giant (level 28) · always',[]]]});
 expect(html).toContain('class="ge-row ge-open" data-ge-src="1" data-ge-name="Coal"');
 expect(html).toContain('<span class="ge-label">Mining 30: Coal rock</span><button class="xp-reset" data-src-pin="0" title="2 places">Show on map</button>');
 expect(html).not.toContain('data-src-pin="1"');
 expect(run(state,{atlasOperator:()=>false},String,String,()=>'<i/>',()=>{},{})).toContain('Loading sources');
 expect(run(state,{atlasOperator:()=>false},String,String,()=>'<i/>',()=>{},{2:[]})).toContain('No source on record');
});
test('skill guide: the best action now with its count to the next level, and the next unlocks',()=>{
 const code=shell.slice(shell.indexOf("  // Skill guide (RuneLite's Skill Calculator"),shell.indexOf('  function calcBox(b,row){'));
 require('./xp-tracker.js');const X=(globalThis as any).atlasXp;
 const acts={woodcutting:[['Logs',1,625,[],['Logs']],['Oak logs',15,937.5,[],['Oak logs']],['Willow logs',30,1687.5,[],['Willow logs']],['Maple logs',45,2500,[],['Maple logs']],['Yew logs',60,4375,[],['Yew logs']]]};
 const t=new Function('window','nf',`let skillActions=${JSON.stringify(acts)};${code};return {skillGuide,guideText};`)({atlasXp:X},String);
 const xp=X.xpForLevel(31),left=X.xpForLevel(32)-xp,g=t.skillGuide('Woodcutting',xp);
 expect(g).toEqual({best:{name:'Willow logs',count:Math.ceil(left/1687.5),item:'Willow logs'},next:[{name:'Maple logs',level:45},{name:'Yew logs',level:60}]});
 expect(t.guideText(g)).toBe(' · '+Math.ceil(left/1687.5)+' × Willow logs to level · next: Maple logs at 45');
 expect(t.skillGuide('Cooking',xp)).toBe(null);
});
test('idle markers and the closest teleport',()=>{
 const code=shell.slice(shell.indexOf('  // Highlights in the 3D view'),shell.indexOf("  // Respawn timers (RuneLite's Mining"));
 let now=1_000_000;const b:any={name:'Alpha',inWorld:true,pos:{x:3200,z:3200,level:0},action:'idle'};
 const S:any={economy:{itemValues:{}},bots:[b]};
 const env:any={S,D:{rival:new Set()},account:()=>b,asset:(n:string)=>n,fetch:()=>new Promise(()=>{}),localStorage:{getItem:()=>null,setItem:()=>{}},window:{},
  wildLevel:()=>0,pvpState:()=>null,recap:{state:'none'},respawnRows:()=>[],VIEWER:{state:'loading'},$:()=>null,nf:String,E:String,location:{origin:''},resources:null,safeName:String,miniView:{cx:3200,cz:3200,PX:4},Date:{now:()=>now}};
 const t=new Function(...Object.keys(env),`${code};return {overlayMessage,trackTrails,nearestTeleport,setIcons:(i)=>{mapIcons=i;}};`)(...Object.values(env));
 t.trackTrails();now+=170_000;t.trackTrails();
 expect(t.overlayMessage().tiles.filter((x:any)=>x.colour==='#ffff00')).toEqual([]);
 now+=20_000;t.trackTrails();
 expect(t.overlayMessage().tiles).toContainEqual({x:3200,z:3200,l:0,colour:'#ffff00',label:'Alpha: idle 3m'});
 // A step or a non-idle action starts the clock again.
 b.pos={x:3201,z:3200,level:0};t.trackTrails();expect(t.overlayMessage().tiles.some((x:any)=>x.colour==='#ffff00')).toBe(false);
 t.setIcons([[3213,3424,0,'t','Varrock teleport'],[3221,3218,0,'t','Lumbridge teleport'],[3222,3218,1,'t','Upstairs'],[3200,3205,0,'a','Shortcut']]);
 expect(t.nearestTeleport([{x:3200,z:3200,l:0}])).toEqual({label:'Lumbridge teleport',d:21});
 expect(t.nearestTeleport([{x:3200,z:9600,l:0}])).toBe(null);
 // Farther than 80 tiles: no hint.
 expect(t.nearestTeleport([{x:3000,z:3000,l:0}])).toBe(null);
});
test('minimap right-click: only the names of players look up, not floor items or markers',()=>{
 const line=shell.split('\n').find(l=>l.includes('const playerNames=()=>'))!;
 const playerNames=new Function('S',`${line};return playerNames;`)({roster:[['Goondelf',1,2,0]],bots:[{name:'Alpha'}]});
 const names=playerNames();
 expect(['goondelf','alpha'].every(n=>names.has(n))).toBe(true);
 expect(names.has('floor item')).toBe(false);expect(names.has('death tile')).toBe(false);
});
test('items kept on death: in the Wilderness the 3 kept items are green, other items of value red, worn items counted first',()=>{
 const code=shell.slice(shell.indexOf("  // Items kept on death (RuneLite's"),shell.indexOf('  function itemCell(item,i,extra'));
 const S:any={economy:{itemValues:{'Rune scimitar':15000,'Shark':800,'Coins':1}}};
 const b:any={inWorld:true,pos:{x:3100,z:3600},equipment:[{name:'Rune scimitar',count:1}],inventory:[{name:'Shark',count:1},{name:'Shark',count:1},{name:'Shark',count:1},{name:'Bones',count:1}]};
 const env:any={S,wildLevel:()=>5,pvpState:()=>({kept:[{name:'Rune scimitar'},{name:'Shark'},{name:'Shark'}]})};
 const t=new Function(...Object.keys(env),`${code};return {deathMarks,deathCls};`)(...Object.values(env));
 const m=t.deathMarks(b);
 expect(t.deathCls(m,b.equipment[0])).toBe(' death-kept');
 expect(b.inventory.map((i:any)=>t.deathCls(m,i))).toEqual([' death-kept',' death-kept',' death-lost','']);
 expect(new Function('S','wildLevel','pvpState',`${code};return deathMarks;`)(S,()=>0,()=>null)(b)).toBe(null);
 // A stack keeps only the counted units: 3 of 100,000 coins is part kept, and a second stack keeps nothing.
 const coins:any={inWorld:true,pos:{x:3100,z:3600},equipment:[],inventory:[{name:'Coins',count:100000},{name:'Coins',count:5}]};
 const c=new Function('S','wildLevel','pvpState',`${code};return {deathMarks,deathCls};`)(S,()=>5,()=>({kept:[{name:'Coins'},{name:'Coins'},{name:'Coins'}]}));
 const cm=c.deathMarks(coins);
 expect(coins.inventory.map((i:any)=>c.deathCls(cm,i))).toEqual([' death-part',' death-lost']);
});
test('best training spot: the best rock the account can mine now, and the nearest one on its floor',()=>{
 const code=shell.slice(shell.indexOf('  // Best training spot (Skill Calculator)'),shell.indexOf('  const guideText=g=>'));
 const acts={mining:[['Copper ore',1,437.5,[],['Copper ore']],['Iron ore',15,875,[],['Iron ore']],['Coal',30,1250,[],['Coal']]]};
 const resources={kinds:{1:{name:'Copper rock'},2:{name:'Iron rock'},3:{name:'Coal rock'}},tiles:[[3000,3000,0,1],[3010,3000,0,2],[3050,3000,0,2],[3011,3000,1,2],[3020,3000,0,3]]};
 const resourceOf=(i:string)=>/ ore$/i.test(i)?i.replace(/ ore$/i,'')+' rock':/^coal$/i.test(i)?'Coal rock':null;
 const t=new Function('resources','skillActions','resourceOf','calcSkill','E','nf','sourcePin',`${code};return {bestSpot,bestSpotLine};`)(resources,acts,resourceOf,'Mining',String,String,null);
 const b={pos:{x:3000,z:3000,level:0}};
 expect(t.bestSpot(b,'Mining',20)).toMatchObject({name:'Iron rock',level:15,near:{x:3010,z:3000,l:0,d:10}});
 expect(t.bestSpot(b,'Mining',20).tiles.length).toBe(3);
 expect(t.bestSpot(b,'Mining',35).name).toBe('Coal rock');
 // An action named after its rock, or named for an output item, finds its rock too.
 const acts2={mining:[['Copper ore',1,437.5,[],['Copper ore']],['Limestone rock',10,662.5,[],[]],['Gem rock',12,500,[],['Uncut gem']]]};
 const res2={kinds:{1:{name:'Copper rock'},4:{name:'Limestone rock'}},tiles:[[3000,3000,0,1],[3005,3000,0,4]]};
 const t2=new Function('resources','skillActions','resourceOf','calcSkill','E','nf','sourcePin',`${code};return {bestSpot};`)(res2,acts2,resourceOf,'Mining',String,String,null);
 expect(t2.bestSpot(b,'Mining',12)).toMatchObject({name:'Limestone rock',level:10,near:{x:3005,d:5}});
 expect(t.bestSpot(b,'Fishing',35)).toBe(null);
 expect(t.bestSpotLine(b,20)).toContain('Best now: <b>Iron rock</b> (level 15) · nearest 10 tiles');
});
test('Equipment Stats: worn bonuses, the server max hit, and teleport casts from the pack',()=>{
 const code=shell.slice(shell.indexOf("  // Equipment Stats (the game's"),shell.indexOf("  // Items kept on death (RuneLite's"));
 const t=new Function('asset','fetch','E',`${code};return {wornBonuses,maxHit,equipStats,teleCasts,set:(i,s)=>{itemBonusData=i;spellbookData=s;}};`)((n:string)=>n,()=>new Promise(()=>{}),String);
 t.set({'Rune scimitar':[7,45,-2,0,0,0,1,0,0,0,44,0,0],'Amulet of strength':[0,0,0,0,0,0,0,0,0,0,10,0,0]},
  {spells:[['Varrock teleport',25,[['Fire rune',1],['Air rune',3],['Law rune',1]]],['Falador teleport',37,[['Water rune',1],['Air rune',3],['Law rune',1]]]],staffs:{'Fire rune':['Staff of fire']}});
 const b:any={skills:[{name:'Strength',level:99,currentLevel:99},{name:'Magic',level:30}],equipment:[{slot:3,name:'Rune scimitar'},{slot:2,name:'Amulet of strength'}],
  inventory:[{name:'Air rune',count:30},{name:'Law rune',count:4},{name:'Fire rune',count:2},{name:'Water rune',count:9}]};
 expect(t.wornBonuses(b)).toEqual([7,45,-2,0,0,0,1,0,0,0,54,0,0]);
 // Unobserved equipment is unknown, not empty: no panel.
 expect(t.wornBonuses({equipment:[],equipmentObserved:false})).toBe(null);expect(t.equipStats({equipment:[],equipmentObserved:false})).toBe('');
 // The server's formula: floor(((99 + 8 + style) × (54 + 64) + 320) / 640).
 expect([t.maxHit(99,54,0),t.maxHit(99,54,3),t.maxHit(99,0,3)]).toEqual([20,20,11]);
 // With the +15% prayer: floor(99 × 115 / 100) = 113, so floor(((113 + 8 + 3) × 118 + 320) / 640) = 23.
 expect(t.maxHit(99,54,3,115)).toBe(23);
 const html=t.equipStats(b);expect(html).toContain('<i title="Slash">+45</i>');expect(html).toContain('Str +54');expect(html).toContain('Melee 20–20 · prayer 23');
 // Varrock: min(2 fire, 30/3 air, 4 law) = 2; Falador: 4 law, Magic 30 is below 37.
 expect(t.teleCasts(b)).toEqual([{name:'Varrock teleport',lv:25,casts:2,can:true},{name:'Falador teleport',lv:37,casts:4,can:false}]);
 // A wielded Staff of fire gives fire runes without limit.
 b.equipment[0]={slot:3,name:'Staff of fire'};expect(t.teleCasts(b)[0].casts).toBe(4);
 // The magic max hit: the best combat spell for the current Magic level, runes and worn staff.
 const t2=new Function('asset','fetch','E',`${code};return {bestSpell,equipStats,set:(i,s)=>{itemBonusData=i;spellbookData=s;}};`)((n:string)=>n,()=>new Promise(()=>{}),String);
 t2.set({'Staff of fire':[0,0,0,10,0,0,0,0,10,0,0,0,0]},{spells:[],staffs:{'Fire rune':['Staff of fire']},combat:[['Fire Strike',13,8,[['Mind rune',1],['Fire rune',3],['Air rune',2]],null],['Fire Bolt',35,12,[['Chaos rune',1],['Fire rune',4],['Air rune',3]],null],['Iban Blast',50,25,[['Death rune',1],['Fire rune',5]],"Iban's staff"],['Fire Blast',59,16,[['Death rune',1],['Fire rune',5],['Air rune',4]],null]]});
 const mage:any={skills:[{name:'Magic',level:55,currentLevel:55}],equipment:[{slot:3,name:'Staff of fire'}],inventory:[{name:'Air rune',count:30},{name:'Chaos rune',count:6},{name:'Mind rune',count:50},{name:'Death rune',count:20}]};
 // Fire Blast needs 59; Iban Blast needs Iban's staff; Fire Bolt: 6 chaos, 30/3 air, fire from the staff = 6.
 expect(t2.bestSpell(mage)).toEqual({name:'Fire Bolt',max:12,casts:6,xp:0});
 expect(t2.equipStats(mage)).toContain('Magic Fire Bolt 12 ×6');
 // Against the shipped spellbook: the pure-iban loadout (Magic 50, Staff of iban, death and fire runes, no air) casts Iban Blast.
 const book=JSON.parse(readFileSync(new URL('./client-assets/spellbook.json',import.meta.url),'utf8'));
 t2.set({},book);
 expect(t2.bestSpell({skills:[{name:'Magic',level:50}],equipment:[{slot:3,name:'Staff of iban'}],inventory:[{name:'Death rune',count:30},{name:'Fire rune',count:100}]})).toEqual({name:'Iban Blast',max:25,casts:20,xp:750});
 // Without the staff, no spell: Fire Blast needs 59 and the elemental spells need air runes.
 expect(t2.bestSpell({skills:[{name:'Magic',level:50}],equipment:[],inventory:[{name:'Death rune',count:30},{name:'Fire rune',count:100}]})).toBe(null);
});
test('logout line: the session length, the most XP gained and the top loot with its value',()=>{
 const code=shell.slice(shell.indexOf('  const worldSeen=new Map(),rankSeen=new Map();'),shell.indexOf('  function levelUps(){'));
 const chat:any[]=[],b:any={name:'Alpha',inWorld:true,uptime:600_000,skills:[{name:'Woodcutting',xp:1000},{name:'Firemaking',xp:50}],flow:{loot:[]}};
 const env:any={S:{bots:[b],boards:[],economy:{itemValues:{'Yew logs':200}}},chat,renderChat:()=>{},safeName:String,nf:(n:number)=>n.toLocaleString('en-GB'),gp:(n:number)=>String(n),dur:(ms:number)=>Math.round(ms/60000)+'m'};
 const moments=new Function(...Object.keys(env),`${code};return moments;`)(...Object.values(env));
 moments();
 b.uptime=4_200_000;b.skills=[{name:'Woodcutting',xp:46000},{name:'Firemaking',xp:150}];b.flow={loot:[{name:'Yew logs',count:412},{name:'Logs',count:3}]};moments();
 b.inWorld=false;b.flow=null;moments();
 expect(chat.map(c=>c.text)).toEqual(['Alpha has logged out after 70m: +45,000 Woodcutting XP, 412 Yew logs, ≈ 82400 gp of loot.']);
});
test('rank lines: a move of the same account, and another account taking the best rank, never "up from" another account',()=>{
 const code=shell.slice(shell.indexOf('  const worldSeen=new Map(),rankSeen=new Map();'),shell.indexOf('  function levelUps(){'));
 const chat:any[]=[],S:any={bots:[],boards:[{board:'Overall',best:{name:'Alpha',rank:1619}}]};
 const moments=new Function('S','chat','renderChat','safeName','nf','gp','dur',`${code};return moments;`)(S,chat,()=>{},String,String,String,String);
 moments();
 S.boards=[{board:'Overall',best:{name:'Alpha',rank:1500}}];moments();
 S.boards=[{board:'Overall',best:{name:'Beta',rank:616}}];moments();
 expect(chat.map(c=>c.text)).toEqual(['Alpha is now rank 1500 on Overall (up from 1619).','Beta now holds our best Overall rank: 616.']);
});
test('item identification: unidentified herbs by id, potions by type; other items have no label',()=>{
 const start=shell.indexOf("  // Item identification (RuneLite's"),code=shell.slice(start,shell.indexOf('  const idTag=',start));
 const hl:any={itemIds:true};
 const idLabel=new Function('hl',`${code};return idLabel;`)(hl);
 expect([{name:'Herb',id:207},{name:'Herb',id:199},{name:'Herb',id:1},{name:'Strength potion(3)'},{name:'Super attack(4)'},{name:'Prayer potion(1)'},{name:'Superantipoison(2)'},{name:'Ranging potion(4)'},{name:'Amulet of glory(4)'},{name:'Shark'}].map(i=>idLabel(i)))
  .toEqual(['Ran','Gua','','Str','SAtt','Pra','SAP','Rng','','']);
 hl.itemIds=false;expect(idLabel({name:'Herb',id:207})).toBe('');
});
test('GE price change: no change before a base snapshot is 20 hours old, then the change from it; snapshots rotate daily',()=>{
 const start=shell.indexOf('  // GE price change:'),code=shell.slice(start,shell.indexOf("  let geQuery=",start));
 const store:Record<string,string>={},ls={getItem:(k:string)=>store[k]??null,setItem:(k:string,v:string)=>{store[k]=v;}};
 const geTrend=new Function('localStorage',`${code};return geTrend;`)(ls);
 const H=3_600_000;
 // A refresh before the market is fetched (no price) saves nothing.
 expect(geTrend([],0).change.size).toBe(0);expect(store['atlas-ge-prices']).toBeUndefined();
 expect(geTrend([{id:1,ask:100}],0).change.size).toBe(0);
 // An empty refresh later does not replace the history.
 geTrend([],1*H);expect(JSON.parse(store['atlas-ge-prices']).next.p['1']).toBe(100);
 // Before 24 hours there is no base yet.
 expect(geTrend([{id:1,ask:105}],10*H).change.size).toBe(0);
 // At 24 hours the first snapshot becomes the base (24 hours old): +10%.
 expect(geTrend([{id:1,ask:110}],24*H).change.get('1')).toBe(10);
 // The base stays until the next snapshot is 24 hours old.
 const r=geTrend([{id:1,ask:150},{id:2,vwap:50}],46*H);
 expect(r.change.get('1')).toBe(50);expect(r.at).toBe(0);
 // Under 1% shows nothing.
 expect(geTrend([{id:1,ask:100.4}],46*H).change.has('1')).toBe(false);
});
test('player finder: online players by name, a hidden name never offered, the live position pinned',()=>{
 const code=shell.slice(shell.indexOf('  // Highlights in the 3D view'),shell.indexOf("  // Respawn timers (RuneLite's Mining"));
 const S:any={economy:{itemValues:{}},bots:[],roster:[['Goondelf',3078,3640,0,87],['Goonie',3000,3000,0,40],['Secret',3100,3100,0,99]]};
 const env:any={S,D:{rival:new Set()},account:()=>null,asset:(n:string)=>n,fetch:()=>new Promise(()=>{}),localStorage:{getItem:()=>null,setItem:()=>{}},window:{},
  wildLevel:()=>0,pvpState:()=>null,recap:{state:'none'},respawnRows:()=>[],VIEWER:{state:'loading'},$:()=>null,nf:String,E:String,location:{origin:''},resources:null,
  safeName:(n:string)=>n==='Secret'?'Hidden':n,miniView:{cx:3078,cz:3600,PX:4}};
 const t=new Function(...Object.keys(env),`${code};return {playerMatches,pinned,finderList,setPlayer:(p)=>{finderPlayer=p;},setQuery:(q)=>{finderQuery=q;},setSpawns:(n)=>{npcSpawns=n;}};`)(...Object.values(env));
 expect(t.playerMatches('goon').map((r:any)=>r[0])).toEqual(['Goondelf','Goonie']);
 expect(t.playerMatches('secret')).toEqual([]);
 t.setSpawns([]);t.setQuery('goon');expect(t.finderList()).toContain('data-finder-player="Goondelf"');
 t.setPlayer('goondelf');
 expect(t.pinned()).toEqual({label:'Goondelf (87)',tip:'Goondelf (combat 87)',tiles:[{x:3078,z:3640,l:0}]});
 expect(t.finderList()).toContain('combat 87 · 3078, 3640 · 40 tiles away');
 // The pin follows the roster; an absent player is not online.
 S.roster=[];expect(t.pinned()).toBe(null);expect(t.finderList()).toContain('not online');
 // A new query, a best-spot pin and a GE source pin each replace the target, so each drops the player pick.
 expect(shell).toContain('finderQuery=e.target.value.slice(0,40);finderPick=null;finderPlayer=null;');
 expect(shell).toContain('tiles:s.tiles};finderPick=null;finderPlayer=null;');
 expect(shell).toContain('tiles:flatTiles(src[2])};finderPick=null;finderPlayer=null;');
});
test('food: the healing items in the pack, most first',()=>{
 const code=shell.slice(shell.indexOf("  // The food items in an account's pack"),shell.indexOf('  function idleNotifier(b){'));
 const foodOf=new Function('itemStats',`${code};return foodOf;`)({Shark:'heals 20',Lobster:'heals 12','Jug of wine':'Attack -2 · heals 11','Prayer potion(4)':'restores 7 + 25% Prayer'});
 expect(foodOf({inventory:[{name:'Shark',count:1},{name:'Lobster',count:1},{name:'Shark',count:1},{name:'Prayer potion(4)',count:1},{name:'Coins',count:500}]}))
  .toEqual({items:[{name:'Shark',count:2},{name:'Lobster',count:1}],total:3});
 // A healing effect after another effect counts too.
 expect(foodOf({inventory:[{name:'Jug of wine',count:1},{name:'Jug of wine',count:1}]}).total).toBe(2);
 expect(foodOf({inventory:[]}).total).toBe(0);
});
test('Inventory Setups: worn slots green, red or yellow against the kit, and the pack list against the kit',()=>{
 const code=shell.slice(shell.indexOf("  // Inventory Setups (RuneLite's) in the Equipment tab:"),shell.indexOf("  // Screenshot (RuneLite's Screenshot plugin)"));
 const t=new Function('localStorage','fetch','asset','E','icon','nf',`${code};return {setupSlot,setupPanel,set:(k,s)=>{pkKits=k;setupKit=s;}};`)({getItem:()=>null},()=>new Promise(()=>{}),(n:string)=>n,String,(n:string)=>`[${n}]`,String);
 t.set([{name:'tribrid',worn:{0:['Rune full helm',1],13:['Rune arrow',300]},carried:[['Shark',18],['Blood rune',100]]}],'tribrid');
 const b={equipment:[{slot:0,name:'Rune full helm',count:1},{slot:13,name:'Rune arrow',count:120},{slot:5,name:'Wooden shield',count:1}],inventory:[{name:'Shark',count:1},{name:'Shark',count:1},{name:'Blood rune',count:100}]};
 expect(t.setupSlot(b,0,b.equipment[0]).cls).toBe(' setup-ok');
 expect(t.setupSlot(b,13,b.equipment[1])).toEqual({cls:' setup-miss',tip:' · kit wants Rune arrow × 300'});
 expect(t.setupSlot(b,5,b.equipment[2]).cls).toBe(' setup-extra');
 const html=t.setupPanel(b);
 expect(html).toContain('1 worn slot differs from the kit'.replace('differs','differ'));
 expect(html).toContain('setup-row setup-short');expect(html).toContain('<span>2 / 18</span>');
 expect(html).toContain('setup-row setup-have');expect(html).toContain('<span>100 / 100</span>');
 // With an observed bank, each row gives the bank count; short when pack and bank together miss the kit.
 const withBank=t.setupPanel({...b,bank:[{name:'Shark',count:10}]});
 expect(withBank).toContain('2 / 18 <small class="setup-bank setup-bank-short">bank 10</small>');
 expect(withBank).toContain('100 / 100 <small class="setup-bank">bank 0</small>');
 // The restock line: 18 sharks less 2 in the pack and 10 in the bank leave 6.
 expect(withBank).toContain('Restock: 6 Shark');
 const rt=shell.split('\n').find(l=>l.includes('const rewardText=name=>'))!;
 const rewardText=new Function('nf',`let questRewardData={"Dragon Slayer":[2,[["Strength",466250],["Defence",466250]]],"Rune Mysteries Quest":[1,[]]};${rt};return rewardText;`)((n:number)=>n.toLocaleString('en-GB'));
 expect(rewardText('Dragon Slayer')).toBe('2 quest points · 466,250 Strength XP · 466,250 Defence XP');
 expect(rewardText('Rune Mysteries Quest')).toBe('1 quest point');expect(rewardText('Unknown')).toBe('');
 const rewardText2=new Function('nf',`let questRewardData={"Observatory Quest":[2,[["Crafting",56250]],[["Strength",21875],["Defence",21875]]]};${rt};return rewardText;`)((n:number)=>n.toLocaleString('en-GB'));
 expect(rewardText2('Observatory Quest')).toBe('2 quest points · 56,250 Crafting XP · one of: 21,875 Strength, 21,875 Defence XP');
});
test('map icons by requirement: true or false with the account level, null with no level',()=>{
 const line=shell.split('\n').find(l=>l.includes('const iconCan=(b,req)=>'))!;
 const iconCan=new Function(`${line};return iconCan;`)();
 const b={skills:[{name:'Agility',level:40},{name:'Magic',level:20}]};
 expect([iconCan(b,['agility',40]),iconCan(b,['agility',41]),iconCan(b,['magic',25]),iconCan(b,null),iconCan({},['agility',1]),iconCan(b,['mining',1])]).toEqual([true,false,false,null,null,null]);
 // A boost or a drain counts: the game checks the current level.
 expect(iconCan({skills:[{name:'Magic',level:22,currentLevel:25}]},['magic',25])).toBe(true);
 expect(iconCan({skills:[{name:'Magic',level:25,currentLevel:22}]},['magic',25])).toBe(false);
});
test('Screenshot: a level-up, a death or valuable loot of the watched account asks the viewer for a picture and keeps it',()=>{
 const code=shell.slice(shell.indexOf("  // Screenshot (RuneLite's Screenshot plugin)"),shell.indexOf('  // Tick efficiency (one box under Overall'));
 const posted:any[]=[];const b:any={name:'Alpha',flow:{loot:[{name:'Rune scimitar',count:1}]}};
 const env:any={localStorage:{getItem:()=>null,setItem:()=>{}},indexedDB:{open:()=>{throw new Error('none');}},VIEWER:{state:'ready'},$:()=>({contentWindow:{postMessage:(m:any)=>posted.push(m)}}),location:{origin:''},account:()=>b,S:{economy:{itemValues:{'Rune scimitar':15000,'Dragon chainbody':500000}}},gp:(n:number)=>String(n),selectedPlugin:'xp',window:{atlasOperator:()=>false},body:{}};
 const t=new Function(...Object.keys(env),`${code};return {shotFor,shotReply,lootShots,list:()=>shots};`)(...Object.values(env));
 // A signed-out viewer takes no picture: it has no Activity plugin to see them.
 t.shotFor(b,'level','Level 70 Woodcutting');expect(posted.length).toBe(0);
 env.window.atlasOperator=()=>true;
 t.shotFor(b,'level','Level 70 Woodcutting');t.shotFor({name:'Other'},'death','Death');
 expect(posted.length).toBe(1);expect(posted[0].capture.id).toMatch(/^[a-z0-9]+$/);
 t.shotReply({id:posted[0].capture.id,url:'data:image/jpeg;base64,AAAA'});
 expect(t.list()).toMatchObject([{name:'Alpha',kind:'level',text:'Level 70 Woodcutting',url:'data:image/jpeg;base64,AAAA'}]);
 t.shotReply({id:'unknown',url:'data:image/jpeg;base64,BBBB'});expect(t.list().length).toBe(1);
 t.lootShots();b.flow={loot:[{name:'Rune scimitar',count:2},{name:'Dragon chainbody',count:1}]};t.lootShots();
 expect(posted.length).toBe(2);
});
