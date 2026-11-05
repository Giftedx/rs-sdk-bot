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

test('friends use world presence rather than the age of the last status file',()=>{
 const code=shell.slice(shell.indexOf("    if(selectedTab==='friends')"),shell.indexOf("    if(selectedTab==='settings')"));
 const html=new Function('S','E','safeName',`const selectedTab='friends';let html='';${code};return html;`)({bots:[{name:'Offline',fresh:true,inWorld:false},{name:'Online',fresh:false,inWorld:true}]},String,String);
 expect(html).toContain('<span>Offline</span><span class="friend-off">Offline</span>');
 expect(html).toContain('<span>Online</span><span class="friend-on">local</span>');
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
 const code=shell.slice(shell.indexOf('  function lookup(name){'),shell.indexOf('  window.atlasLookup=lookup;'));
 const target={innerHTML:''};
 return new Function('fetch','body','lookupCard',`let worldLookupName='',worldLookup=null,worldLookupRequest=0,selectedPlugin='world';const showPlugin=()=>{};${code};return{lookup,value:()=>worldLookup};`)(fetch,{querySelector:()=>target},JSON.stringify);
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
