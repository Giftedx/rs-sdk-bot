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
 const code=shell.slice(shell.indexOf("  $('#client-account').onchange="),shell.indexOf('  function toast('));
 const picker:any={},messages:any[]=[],window:any={atlasFollowOther:'Worker'};let renders=0;
 const selected=new Function('$','window','location','render',`let sel='Worker',picked=false,rswFor='Worker';const pick=()=>{},refresh=()=>{};${code};return()=>{$('#client-account').onchange({target:{value:''}});return sel;};`)((s:string)=>s==='#client-account'?picker:{contentWindow:{postMessage:(m:any)=>messages.push(m)}},window,{origin:'http://localhost'},()=>renders++);
 expect(selected()).toBeNull();expect(window.atlasFollowOther).toBeNull();expect(window.atlasFreeCamera).toBe(true);
 expect(messages).toEqual([{atlasFreeCamera:true}]);expect(renders).toBe(1);
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
 const choices=new Function('S','sel',code+';return accountChoices();')({bots:[{name:'Other',inWorld:true}]},'Chosen');
 expect(choices).toContainEqual({name:'Chosen',inWorld:false,missing:true});
 expect(choices.filter((b:any)=>b.name==='Chosen')).toHaveLength(1);
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
 return new Function('fetch','body','lookupCard',`let worldLookupName='',worldLookup=null,selectedPlugin='world';const showPlugin=()=>{};${code};return{lookup,value:()=>worldLookup};`)(fetch,{querySelector:()=>target},JSON.stringify);
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
