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
 const code=shell.slice(shell.indexOf('  function invWorth(items){'),shell.indexOf('  function itemCell(item,i){'));
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
});
test('Screenshot: a level-up, a death or valuable loot of the watched account asks the viewer for a picture and keeps it',()=>{
 const code=shell.slice(shell.indexOf("  // Screenshot (RuneLite's Screenshot plugin)"),shell.indexOf('  // Tick efficiency (one box under Overall'));
 const posted:any[]=[];const b:any={name:'Alpha',flow:{loot:[{name:'Rune scimitar',count:1}]}};
 const env:any={localStorage:{getItem:()=>null,setItem:()=>{}},indexedDB:{open:()=>{throw new Error('none');}},VIEWER:{state:'ready'},$:()=>({contentWindow:{postMessage:(m:any)=>posted.push(m)}}),location:{origin:''},account:()=>b,S:{economy:{itemValues:{'Rune scimitar':15000,'Dragon chainbody':500000}}},gp:(n:number)=>String(n),selectedPlugin:'xp',window:{},body:{}};
 const t=new Function(...Object.keys(env),`${code};return {shotFor,shotReply,lootShots,list:()=>shots};`)(...Object.values(env));
 t.shotFor(b,'level','Level 70 Woodcutting');t.shotFor({name:'Other'},'death','Death');
 expect(posted.length).toBe(1);expect(posted[0].capture.id).toMatch(/^[a-z0-9]+$/);
 t.shotReply({id:posted[0].capture.id,url:'data:image/jpeg;base64,AAAA'});
 expect(t.list()).toMatchObject([{name:'Alpha',kind:'level',text:'Level 70 Woodcutting',url:'data:image/jpeg;base64,AAAA'}]);
 t.shotReply({id:'unknown',url:'data:image/jpeg;base64,BBBB'});expect(t.list().length).toBe(1);
 t.lootShots();b.flow={loot:[{name:'Rune scimitar',count:2},{name:'Dragon chainbody',count:1}]};t.lootShots();
 expect(posted.length).toBe(2);
});
