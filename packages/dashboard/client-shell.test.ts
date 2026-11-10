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
 new Function('account','document','hud','window','E','safeName','age','stackValue','gp','icon','qty','priceTip',`${code};openBank();`)(()=>current,{createElement:()=>modal},{querySelector:()=>null,append:()=>{}},{atlasOperator:()=>true},String,String,String,()=>({value:10,unpriced:0}),String,()=>'',String,()=> '');
 expect(node('.bank-items').innerHTML).toContain('× 10');
 current={...current,bankAt:2,bank:[{name:'Coins',count:25}]};node('input').oninput();
 expect(node('.bank-items').innerHTML).toContain('× 25');
 current={name:'Other',bank:[]};node('input').oninput();expect(removed).toBe(true);
});

function questPanel(bot:any,filter='all'){
 const code=shell.slice(shell.indexOf("    if(selectedTab==='quests'){"),shell.indexOf("    if(selectedTab==='friends')"));
 return new Function('b','questFilter','E','age',`const selectedTab='quests',questQuery='',questDetail='';let html='';${code};return html;`)(bot,filter,String,String);
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

function lookupHarness(fetch:typeof globalThis.fetch){
 const code=shell.slice(shell.indexOf('  function refreshWorldLookup(){'),shell.indexOf('  window.atlasLookup=lookup;'));
 const target={innerHTML:''};
 return new Function('fetch','body','lookupCard','put',`let worldLookupName='',worldLookup=null,worldLookupRequest=0,selectedPlugin='world';const showPlugin=()=>{};${code};return{lookup,value:()=>worldLookup};`)(fetch,{querySelector:()=>target},JSON.stringify,(el:{innerHTML:string},html:string)=>el.innerHTML=html);
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

// The Fleet wall code with the page state it reads. Every message to the viewer and every pick() lands in one log.
function fleetWall(bots:any[],start:{sel?:string|null,free?:boolean,other?:string|null,mode?:string,state?:string,touring?:boolean}={}){
 const live=shell.slice(shell.indexOf('  const focusLive='),shell.indexOf('  function focusState('));
 const state=shell.slice(shell.indexOf('  function focusState('),shell.indexOf('  function focusRows('));
 const code=shell.slice(shell.indexOf('  // Fleet wall:'),shell.indexOf("  focusFind.addEventListener('input',focusRows);"));
 const phone={matches:false},log:any[]=[],said:string[]=[],classes={add:()=>{},remove:()=>{}},window:any={atlasFreeCamera:!!start.free,atlasFollowOther:start.other??null,atlasFollow3d:()=>true};
 const S={bots},VIEWER={state:start.state??'ready',origin:'http://localhost'};
 const st=(b:any)=>b.inWorld&&b.fresh&&b.action!=='idle'?['on','playing']:['wd','in world'];
 const api=new Function('S','VIEWER','window','MARK','st','$','focusSay','focusOpen','focus','focusNote','log','safeName','phoneWidth',`
  let mode=${JSON.stringify(start.mode??'3d')},sel=${JSON.stringify(start.sel??null)},wall=null,wallLinked=false,tourTimer=${start.touring?'setInterval(()=>{},1e9)':'null'},focusRowsHtml='',flightTo=null,sentMaxLevel=2,warmSent='x',rswFor=sel,paints=0,renders=0;
  const TOUR_MS=45000,tourStep=()=>{},focusPaint=()=>{paints++;},render=()=>{renders++;};
  let pick=name=>{wallEnd(false);log.push({pick:name});sel=name;window.atlasFreeCamera=false;},setMode=m=>{mode=m;};
  ${live}${state}${code}
  return {start:wallStart,end:wallEnd,toggle:wallToggle,sync:wallSync,message:wallMessage,names:wallNames,on:()=>!!wall,label:()=>focusState(),link:()=>{wallLinked=true;},
   page:()=>({sel,free:window.atlasFreeCamera,other:window.atlasFollowOther,touring:!!tourTimer,sentMaxLevel,warmSent,rswFor,renders}),setMode:m=>setMode(m),stopTour:()=>clearInterval(tourTimer)};`)
  (S,VIEWER,window,'⟦MAIN⟧',st,()=>({contentWindow:{postMessage:(m:any)=>log.push(m)}}),(t:string)=>said.push(t),()=>{},{classList:classes},{classList:classes},log,(n:string)=>String(n).replaceAll('⟦MAIN⟧','Main · reserved'),phone);
 return {...api,log,said,S,VIEWER,window,phone};
}
const inWorld=(name:string,more:any={})=>({name,inWorld:true,...more});

test('the wall asks for our accounts in the world: playing ones first, then name order, at most 16',()=>{
 const bots=[inWorld('Zed'),inWorld('Ann'),{name:'Away',inWorld:false,fresh:true},inWorld('Lab',{practice:true}),inWorld('Mid',{fresh:true}),inWorld('Bee',{fresh:true,action:'idle'}),inWorld('Cat',{fresh:true}),inWorld('bad<name>'),inWorld('ThirteenChars')];
 expect(fleetWall(bots).names()).toEqual(['Cat','Mid','Ann','Bee','Zed']);
 const many=Array.from({length:20},(_,i)=>inWorld('Bot'+String(i).padStart(2,'0'),{fresh:i>=17}));
 const w=fleetWall(many);expect(w.names()).toHaveLength(16);expect(w.names().slice(0,4)).toEqual(['Bot17','Bot18','Bot19','Bot00']);
 expect(w.start()).toBe(true);expect(w.log).toEqual([{multi:w.names()}]);
 expect(w.label()[0]).toBe('Wall · 0 of 16 shown');expect(w.label()[2]).toContain('16 of our 20 accounts');
});

test('the wall does not open with none of our accounts in the world, in the 2D map, or before the viewer is ready',()=>{
 const none=fleetWall([{name:'Away',inWorld:false}]);
 expect(none.start()).toBe(false);expect(none.on()).toBe(false);expect(none.log).toEqual([]);expect(none.said).toEqual(['None of our accounts is in the world. The wall has nothing to show.']);
 for(const start of [{mode:'2d'},{state:'loading'},{state:'unavailable'}]){const w=fleetWall([inWorld('Ann')],start);expect(w.start()).toBe(false);expect(w.log).toEqual([]);expect(w.said).toEqual([]);}
});

test('the wall asks again only when an account enters or leaves the world',()=>{
 const w=fleetWall([inWorld('Ann'),inWorld('Bob')]);w.start();
 w.sync();w.S.bots[1].fresh=true;w.sync();w.S.bots.reverse();w.sync();
 expect(w.log).toEqual([{multi:['Ann','Bob']}]);
 w.S.bots.push(inWorld('Cat'));w.sync();w.sync();
 expect(w.log).toEqual([{multi:['Ann','Bob']},{multi:['Bob','Ann','Cat']}]);
 w.S.bots.find((b:any)=>b.name==='Ann').inWorld=false;w.sync();
 expect(w.log.at(-1)).toEqual({multi:['Bob','Cat']});expect(w.log).toHaveLength(3);
 // The last account leaves: the wall closes and says why.
 for(const b of w.S.bots)b.inWorld=false;w.sync();
 expect(w.on()).toBe(false);expect(w.log.slice(3)).toEqual([{multi:[]},{atlasFreeCamera:true}]);expect(w.said.at(-1)).toContain('The wall is closed');
});

test('the wall status counts the views that show their player, from a viewer status for the asked list only',()=>{
 const w=fleetWall([inWorld('Ann'),inWorld('Bob'),inWorld('Cat')]);w.start();
 w.message({viewerMulti:{names:['Ann','Bob','Cat'],shown:['Ann','Cat'],offline:[]}});expect(w.label()[0]).toBe('Wall · 2 of 3 shown');
 for(const bad of [{names:['Ann'],shown:['Ann'],offline:[]},{names:['Ann','Bob','Cat'],shown:'Ann',offline:[]},{names:['Ann','Bob','Cat'],shown:[1,2,3],offline:[]},{names:['Ann','Bob','Cat'],shown:['A','B','C','D'],offline:[]},null,'x'])w.message({viewerMulti:bad});
 expect(w.label()[0]).toBe('Wall · 2 of 3 shown');
 // A phone has a narrow switcher.
 w.phone.matches=true;expect(w.label()[0]).toBe('Wall · 2/3');
});

test('a click on a view closes the wall first, then follows that account through pick()',()=>{
 const w=fleetWall([inWorld('Ann'),inWorld('Bob')],{sel:'Ann'});w.start();
 // A reply that names another account, or no view of the wall, is not a click.
 for(const bad of [{viewerMultiPick:'Eve',index:1},{viewerMultiPick:'Bob',index:5},{viewerMultiPick:'Bob',index:'1'},{viewerMultiPick:1,index:1},{index:1}])w.message(bad);
 expect(w.on()).toBe(true);expect(w.log).toHaveLength(1);
 w.message({viewerMultiPick:'bob',index:1});
 expect(w.log).toEqual([{multi:['Ann','Bob']},{multi:[]},{pick:'Bob'}]);expect(w.on()).toBe(false);expect(w.said.at(-1)).toBe('Now watching Bob');
 // The viewer build's own report of the same click finds no wall.
 w.message({viewerMultiPick:'Bob',index:1});expect(w.log).toHaveLength(3);
 // The roof and prewarm messages start again from nothing.
 expect(w.page()).toMatchObject({sentMaxLevel:null,warmSent:''});
});

test('closing the wall returns to what the page followed, and the tour runs on',()=>{
 const followed=fleetWall([inWorld('Ann'),inWorld('Bob')],{sel:'Bob',touring:true});followed.start();
 expect(followed.page().touring).toBe(false);
 followed.window.atlasFreeCamera=true;followed.end();
 expect(followed.log).toEqual([{multi:['Ann','Bob']},{multi:[]},{follow:'Bob'}]);
 expect(followed.page()).toMatchObject({sel:'Bob',free:false,other:null,touring:true,rswFor:'Bob'});followed.stopTour();
 const free=fleetWall([inWorld('Ann')],{sel:'Ann',free:true});free.toggle();free.toggle();
 expect(free.log).toEqual([{multi:['Ann']},{multi:[]},{atlasFreeCamera:true}]);expect(free.page()).toMatchObject({free:true,renders:2});
 const other=fleetWall([inWorld('Ann')],{sel:'Ann',other:'Stranger'});other.start();other.end();
 expect(other.log.slice(1)).toEqual([{multi:[]},{follow:'Stranger'}]);
 // The 3D view went away: nothing is left to tell.
 const lost=fleetWall([inWorld('Ann')],{sel:'Ann'});lost.start();lost.setMode('2d');
 expect(lost.on()).toBe(false);expect(lost.log).toEqual([{multi:['Ann']}]);
});

test('a link with wall=1 opens the wall when the viewer is ready and an account is in the world',()=>{
 const w=fleetWall([inWorld('Ann')],{state:'loading'});w.link();w.sync();expect(w.on()).toBe(false);
 w.VIEWER.state='ready';w.sync();expect(w.on()).toBe(true);expect(w.log).toEqual([{multi:['Ann']}]);
 // With the live roster in and nobody of ours on it, the link opens no wall and the page says so once.
 const none=fleetWall([],{});none.window.atlasLiveRoster=()=>true;none.link();none.sync();none.sync();
 expect(none.on()).toBe(false);expect(none.said).toHaveLength(1);
 const link=shell.slice(shell.indexOf('  function writeLink(){'),shell.indexOf('  let questAccount=null;'));
 expect(link).toContain("if(wall||wallLinked)q.set('wall','1');");expect(link).toContain("['a','watch','cam','wall']");
});

test('the hidden account goes to the viewer and comes back as its mark only',()=>{
 const w=fleetWall([inWorld('⟦MAIN⟧',{fresh:true}),inWorld('Ann')]);w.start();
 expect(w.log).toEqual([{multi:['⟦MAIN⟧','Ann']}]);
 w.message({viewerMulti:{names:['⟦MAIN⟧','Ann'],shown:['⟦MAIN⟧'],offline:[]}});
 expect(w.label().join(' ')).not.toContain('MAIN');
 w.message({viewerMultiPick:'⟦MAIN⟧',index:0});
 expect(w.log.slice(1)).toEqual([{multi:[]},{pick:'⟦MAIN⟧'}]);
 // The page takes the name from its own list: text in a reply never becomes a follow target.
 const own=fleetWall([inWorld('Ann'),inWorld('Bob')]);own.start();own.message({viewerMultiPick:'⟦MAIN⟧',index:1});
 expect(own.log.at(-1)).toEqual({pick:'Bob'});
 expect(w.said.at(-1)).toBe('Now watching Main · reserved');
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
