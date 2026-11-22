import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const operations=readFileSync(new URL('./operations.js',import.meta.url),'utf8');
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const healthSource=shell.slice(shell.indexOf('  function recordedHp('),shell.indexOf('  const curLevel='));
const currentHp=new Function('window',`${healthSource};return currentHp;`)({});
const recordedHp=new Function('window',`${healthSource};return recordedHp;`)({});
const now=1_000_000;
const escapeText=(text:unknown)=>String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

test('script search trims the query and keeps the count and empty state inside the refreshed list',()=>{
 const code=operations.slice(operations.indexOf(' function library(){'),operations.indexOf(' function transfers(){'));
 const capabilities=[{id:'cook',goal:'Cook sharks',consumer:'Food',entry:'scripts/cook.ts',files:[],checks:[]},{id:'mine',goal:'Mine ore',consumer:'Bars',entry:'scripts/mine.ts',files:[],checks:[]}];
 const html=(query:string)=>new Function('caps','tasks','libraryQuery','E','badge','button','age',code+';return library();')(()=>capabilities,()=>[],query,escapeText,()=>'',()=>'',String) as string;
 const matched=html('  SHARK  '),refresh=matched.slice(matched.indexOf('id="op-library-list"'));
 expect(refresh).toContain('1 of 2 registered capabilities');expect(refresh).toContain('Cook sharks');expect(refresh).not.toContain('Mine ore');
 expect(html('no-match')).toContain('No scripts match your search.');
});

test('Configuration keeps its trimmed plugin filter when a periodic render rebuilds the panel',()=>{
 const manager=operations.slice(operations.indexOf(' function manager(){'),operations.indexOf(' window.atlasPluginNames='));
 const render=operations.slice(operations.indexOf(' function renderCurrent('),operations.indexOf(' function toast('));
 const body={scrollTop:37,innerHTML:'',contains:()=>false,querySelectorAll:()=>[]};
 const env:any={pluginQuery:'  XP  ',pluginNames:{xp:'XP Tracker',fleet:'Fleet',manager:'Configuration'},saved:(_k:string,f:any)=>f,defaultHidden:[],page:String,title:()=>'',hiddenHere:()=>false,window:{},E:escapeText,button:()=>'',document:{activeElement:{tagName:'BODY'}},api:{selectedPlugin:()=> 'manager'},body};
 new Function(...Object.keys(env),`${manager};const views={manager};${render};renderCurrent();`)(...Object.values(env));
 expect(body.innerHTML).toContain('value="  XP  "');expect(body.innerHTML).toContain('data-pin="xp"');expect(body.innerHTML).not.toContain('data-pin="fleet"');expect(body.scrollTop).toBe(37);
 const empty=new Function(...Object.keys(env),`${manager};return manager();`)(...Object.values({...env,pluginQuery:'no-match'}));
 expect(empty).toContain('No plugins match your search.');
});

function paletteHarness(){
 const code=operations.slice(operations.indexOf(' function openPalette('),operations.indexOf(" window.addEventListener('keydown',e=>{if((e.ctrlKey"));
 let removed=false;
 const doc:any={activeElement:null};
 const trigger:any={name:'trigger',isConnected:true,focus:()=>{doc.activeElement=trigger;}};
 const input:any={name:'input',value:'',isConnected:true,focus:()=>{doc.activeElement=input;}};
 const close:any={name:'close',focus:()=>{doc.activeElement=close;}};
 let buttons:any[]=[];
 const results:any={querySelectorAll:()=>buttons,querySelector:()=>buttons[0],set innerHTML(html:string){buttons=[...html.matchAll(/data-search-result="(\d+)"/g)].map(m=>{const b:any={name:'result'+m[1],dataset:{searchResult:m[1]},focus:()=>{doc.activeElement=b;},click:()=>results.onclick({target:{closest:()=>b}})};return b;});}};
 const overlay:any={className:'',remove:()=>{removed=true;},querySelector:(s:string)=>s==='input'?input:s==='.op-palette-results'?results:close,querySelectorAll:()=>[input,close,...buttons]};
 const opened:string[]=[];doc.activeElement=trigger;
 const env:any={$:()=>null,document:{...doc,createElement:()=>overlay},app:{append:()=>{removed=false;}},isOwner:()=>true,window:{atlasOperator:()=>true},pluginNames:{fleet:'Fleet',xp:'XP Tracker',world:'World'},hiddenHere:()=>false,bots:()=>[],caps:()=>[],tasks:()=>[],api:{openPlugin:(id:string)=>opened.push(id)},body:{querySelector:()=>null},E:escapeText,commandButton:trigger};
 env.window.atlasCommandPlugins=()=>Object.entries(env.pluginNames);
 Object.defineProperty(env.document,'activeElement',{get:()=>doc.activeElement});
 const open=new Function(...Object.keys(env),code+';return openPalette;')(...Object.values(env));
 const key=(key:string,shiftKey=false)=>overlay.onkeydown({key,shiftKey,preventDefault:()=>{},stopPropagation:()=>{}});
 return{open,key,overlay,input,close,trigger,buttons:()=>buttons,active:()=>doc.activeElement,removed:()=>removed,opened};
}

test('command search starts ArrowUp at the last result and traps Tab at both dialog edges',()=>{
 const p=paletteHarness();p.open();p.key('ArrowUp');expect(p.active()).toBe(p.buttons().at(-1));
 p.key('Tab');expect(p.active()).toBe(p.input);p.key('Tab',true);expect(p.active()).toBe(p.buttons().at(-1));
 p.open('no-match');p.key('ArrowDown');expect(p.active()).toBe(p.input);
});

test('command search cancel paths restore the prior control and padded queries still match',()=>{
 const p=paletteHarness();
 for(const close of [()=>p.key('Escape'),()=>p.close.onclick(),()=>p.overlay.onclick({target:p.overlay})]){
  p.trigger.focus();p.open('  XP  ');expect(p.buttons()).toHaveLength(1);close();expect(p.removed()).toBe(true);expect(p.active()).toBe(p.trigger);
 }
});

test('account coins distinguish a reported bank without coins from an absent bank observation',()=>{
 const code=operations.slice(operations.indexOf(' function account(){'),operations.indexOf(' function raw(){'));
 const html=(bank:any)=>{
  const env:any={bots:()=>[{name:'Worker',bank,bankAt:bank?1:null}],sel:'Worker',meta:null,tasks:()=>[],window:{atlasOperator:()=>true},page:String,title:()=>'',button:()=>'',jobButton:()=>'',badge:()=>'',issues:()=>[],E:escapeText,safeName:String,nf:String,gp:String,age:String};
  return new Function(...Object.keys(env),code+';return account();')(...Object.values(env)) as string;
 };
 for(const bank of [[],[{id:333,name:'Trout',count:3}]])expect(html(bank)).toContain('<b>0</b><span>coins in saved bank</span>');
 expect(html(undefined)).toContain('<b>—</b><span>coins in saved bank</span>');expect(html([{id:995,count:12}])).toContain('<b>12</b><span>coins in saved bank</span>');
});

test('recent operator command cards show refused and failed receipts and escaped diagnostic notes',()=>{
 const code=operations.slice(operations.indexOf(' function recentCommands(){'),operations.indexOf(' function dispatch(){'));
 const requests=[...['refused','failed','rejected','accepted','submitted','plan-requested','unknown'].map(status=>({id:status,action:'queue',status,at:1,note:'<b>source changed</b>'}))];
 const html=new Function('meta','E','badge','button','age',code+';return recentCommands();')({requests},escapeText,(tone:string,label:string)=>`<i class="${tone}">${label}</i>`,()=>'',String) as string;
 for(const status of ['refused','failed','rejected'])expect(html).toContain(`<i class="failed">${status}</i>`);
 expect(html).toContain('<i class="good">accepted</i>');expect(html).toContain('<i class="pending">submitted</i>');expect(html).toContain('<i class="pending">plan-requested</i>');expect(html).not.toContain('<i class="pending">unknown</i>');
 expect(html).toContain('&lt;b&gt;source changed&lt;/b&gt;');expect(html).not.toContain('<b>source changed</b>');
});

function evidenceHarness(){
 const start=operations.indexOf(' function showRowDetails('),code=operations.slice(start,operations.indexOf('\n window.addEventListener',start));
 const doc:any={activeElement:null};let removed=false,stopped=0,copyValue='';
 const makeRow=(key:string)=>{const row:any={dataset:{rowKey:key},title:'Observed on this PC',isConnected:true,querySelector:(s:string)=>({textContent:s==='.label'?key:'5'}),focus:()=>{doc.activeElement=row;}};return row;};
 let rows=[makeRow('CPU'),makeRow('CPU')];const trigger=rows[1];
 const fallback:any={focus:()=>{doc.activeElement=fallback;}};
 const close:any={focus:()=>{doc.activeElement=close;}},copy:any={focus:()=>{doc.activeElement=copy;}};
 const overlay:any={remove:()=>{removed=true;},querySelector:()=>close,querySelectorAll:()=>[close,copy]};
 const body={querySelectorAll:()=>rows};
 const env:any={$:()=>null,document:{createElement:()=>overlay},body,app:{append:()=>{}},E:escapeText,button:(_label:string,_action:string,value:string)=>{copyValue=value;return '<button>Copy evidence</button>';},commandButton:fallback};
 Object.defineProperty(env.document,'activeElement',{get:()=>doc.activeElement});
 new Function(...Object.keys({...env,row:trigger}),`${code};showRowDetails(row);`)(...Object.values({...env,row:trigger}));
 const key=(key:string,shiftKey=false)=>overlay.onkeydown({key,shiftKey,preventDefault:()=>{},stopPropagation:()=>{stopped++;}});
 return{key,overlay,close,copy,trigger,fallback,copyValue:()=>copyValue,active:()=>doc.activeElement,removed:()=>removed,stopped:()=>stopped,replace:()=>{trigger.isConnected=false;rows=[makeRow('CPU'),makeRow('CPU')];return rows;},removeRows:()=>{trigger.isConnected=false;rows=[];}};
}

test('evidence dialog cancel paths restore the triggering row and keep its Tab trap',()=>{
 for(const cancel of [(h:any)=>h.key('Escape'),(h:any)=>h.close.onclick(),(h:any)=>h.overlay.onclick({target:h.overlay})]){
  const h=evidenceHarness();expect(h.active()).toBe(h.close);expect(h.copyValue()).toBe('CPU\n5\nObserved on this PC');
  h.key('Tab',true);expect(h.active()).toBe(h.copy);h.key('Tab');expect(h.active()).toBe(h.close);
  cancel(h);expect(h.removed()).toBe(true);expect(h.active()).toBe(h.trigger);
 }
});

test('evidence dialog resolves a refreshed row by key and duplicate occurrence or uses the command button',()=>{
 const h=evidenceHarness(),replacement=h.replace();h.key('Escape');
 expect(h.active()).toBe(replacement[1]);expect(h.active()).not.toBe(replacement[0]);
 const absent=evidenceHarness();absent.removeRows();absent.close.onclick();expect(absent.active()).toBe(absent.fallback);
});

test('modal keys do not bubble and Alt navigation leaves the background plugin alone',()=>{
 const h=evidenceHarness();h.key('ArrowLeft');expect(h.stopped()).toBe(1);
 const line=operations.split('\n').find(line=>line.includes("travel(e.key==='ArrowLeft'?-1:1)"))!;
 let handler:any;const directions:number[]=[];
 new Function('window','travel','document',line)({addEventListener:(_event:string,callback:any)=>{handler=callback;}},(direction:number)=>directions.push(direction),{querySelector:()=>null});
 for(const modal of ['.op-detail-overlay','.op-palette-overlay'])handler({altKey:true,key:'ArrowLeft',target:{closest:()=>modal},preventDefault:()=>{}});
 expect(directions).toEqual([]);
 handler({altKey:true,key:'ArrowRight',target:{closest:()=>null},preventDefault:()=>{}});expect(directions).toEqual([1]);
});

test('the command centre names owner goal gaps and opens Project goals',()=>{
 const source=operations.slice(operations.indexOf(' function operations(){'),operations.indexOf(' // Why a new bot'));
 const scoreboard={available:true,remaining:['Main rank unknown','Quest gap'],quests:{live:45,total:68},goals:{version:1,done:false}};
 const html=new Function('S','bots','issues','meta','page','title','startBlock','E','incidentCards','badge','button','age','metaError','message',`${source};return operations();`)
  ({scoreboard},()=>[],()=>[],null,(s:string)=>s,()=>'',()=>'',String,()=>'',()=>'',()=>'',String,'','');
 expect(html).toContain('goal gaps');expect(html).toContain('quests 45 / 68 live');
 expect(html).toContain('data-value="goals"');expect(html).not.toContain('board goals left');
});
function publicRow(bot:any,withHelper=true){
 const code=operations.slice(operations.indexOf(' function publicRow('),operations.indexOf(' function fleet(){'));
 const window=withHelper?{atlasCurrentHp:(b:any)=>currentHp(b,now)}:{};
 return new Function('window','S','sel','st','overallRank','totalLevel','E','nf','compactRate','safeName','skillIcon','age',`${code};return publicRow;`)
  (window,{results:[]},null,()=>['','observed'],()=>null,()=>0,String,String,String,String,()=>'/skill.png',String)(bot) as string;
}

test('public fleet injury bars use current dated health, including zero, from the shared browser guard',()=>{
 const bot={name:'Worker',operation:'observed',inWorld:true,at:now-1000,hpAt:now-1000,hp:{now:2,max:20}};
 expect(publicRow(bot)).toContain('class="fl-hp" title="Hitpoints 2 / 20"');
 expect(publicRow({...bot,hp:{now:0,max:20}})).toContain('width:0%');
 expect(publicRow({...bot,hp:{now:20,max:20}})).not.toContain('class="fl-hp"');
 expect(publicRow({...bot,hp:{now:24,max:20}})).not.toContain('class="fl-hp"');
});

test('fresh presence cannot turn old, missing or invalid recorded HP into a public injury bar',()=>{
 const bot={name:'Worker',operation:'observed',inWorld:true,fresh:true,at:now-1,hpAt:now-60_000,hp:{now:0,max:20},live:{seen:now-1}};
 for(const value of [bot,{...bot,hpAt:null},{...bot,hpAt:undefined},{...bot,hpAt:now+1},{...bot,hpAt:now-1,inWorld:false}])
  expect(publicRow(value)).not.toContain('class="fl-hp"');
 const {hpAt:_date,...legacy}=bot;
 expect(publicRow({...legacy,at:now-60_000})).not.toContain('class="fl-hp"');
 expect(publicRow({...bot,hpAt:now-1},false)).not.toContain('class="fl-hp"');
});

test('raw account evidence retains the original HP observation date separately from the response date',()=>{
 const code=operations.slice(operations.indexOf(' function raw(){'),operations.indexOf(' // Game results,'));
 const bot={name:'Worker',at:now-1,hp:{now:2,max:20},hpAt:now-60_000};
 let copied='';
 const html=new Function('bots','sel','S','tasks','safeName','page','title','button','E',`${code};return raw();`)
  (()=>[bot],'Worker',{now},()=>[],String,(s:string)=>s,()=>'',(_label:string,_action:string,json:string)=>{copied=json;return '';},String) as string;
 const data=JSON.parse(copied);
 expect(data.observedAt).toBe(now);expect(data.account.at).toBe(bot.at);expect(data.account.hpAt).toBe(bot.hpAt);
 expect(data.account.hp).toEqual(bot.hp);expect(html).toContain('"hpAt": 940000');
});

const moneySource=operations.slice(operations.indexOf(' function moneyPrice('),operations.indexOf(' const stockTabs='));
const itemPricesById={1:{name:'Ring',value:10,ask:15,bid:8},2:{name:'Ring',value:100,ask:150,bid:80},4:{name:'Zero',value:0,ask:null,bid:null}};
const economy={itemPricesById,itemPricesByName:{zero:itemPricesById[4]},itemValues:{Ring:9999,Coins:1}};

test('operations pricing cannot borrow legacy aliases for explicit unknown or malformed identities',()=>{
 const {moneyPrice,moneyKey}=new Function('S','window',`${moneySource};return {moneyPrice,moneyKey};`)({economy},{});
 expect(moneyPrice({id:1,name:'Ring'}).value).toBe(10);expect(moneyPrice({id:3,baseId:2,name:'Ring (noted)'}).value).toBe(100);
 expect(moneyKey({id:3,baseId:2,name:'Ring (noted)'})).toBe('id:2');expect(moneyKey({name:'Ring'})).toBe('name:ring');
 expect(moneyPrice({name:'Ring'})).toBeNull();expect(moneyPrice({name:'Zero'}).value).toBe(0);
 expect(moneyPrice({id:995,name:'Other'}).value).toBe(1);expect(moneyPrice({name:'Coins'}).value).toBe(1);
 for(const item of [{id:617,name:'Coins'},{id:-1,name:'Coins'},{id:undefined,name:'Coins'},{id:1,baseId:undefined,name:'Ring'},{id:1,baseId:-1,name:'Ring'}])expect(moneyPrice(item)).toBeNull();
 expect(moneyKey({id:-1,name:'Coins'})).toBe('invalid:coins');
 const legacy=new Function('S','window',`${moneySource};return moneyPrice;`)({economy:{itemValues:{Ring:20}}},{});
 expect(legacy('Ring').value).toBe(20);expect(legacy({id:1,name:'Ring'})).toBeNull();
});

test('operations name-price authority survives null tables and legacy values cannot hide visible variant ambiguity',()=>{
 const run=(S:any)=>new Function('S','window',`${moneySource};return moneyPrice;`)(S,{});
 for(const table of [null,undefined,{}]){
  const price=run({economy:{itemPricesByName:table,itemValues:{Ring:9999}}});
  expect(price({name:'Ring'})).toBeNull();
 }
 const legacy={economy:{itemValues:{Ring:20},supplies:[{id:1,name:'Ring'}]},bots:[{bank:[{id:3,baseId:1,name:'Ring (noted)',count:2}]}]};
 expect(run(legacy)('Ring').value).toBe(20);
 for(const place of ['inventory','bank','equipment']){
  const state={...legacy,bots:[{...legacy.bots[0],[place]:[{id:2,name:'Ring',count:1}]}]};
  expect(run(state)({name:'Ring'})).toBeNull();
 }
 expect(run({...legacy,economy:{...legacy.economy,supplies:[{id:1,name:'Ring'},{id:2,name:'Ring'}]}})('Ring')).toBeNull();
});

test('the displayed bank ledger retains exact variants, canonical notes and separate unpriced name-only stock',()=>{
 const code=operations.slice(operations.indexOf(' function stock(){'),operations.indexOf(' // Fleet deck:'));
 const bank=[{id:1,name:'Ring',count:2},{id:2,name:'Ring',count:3},{id:3,baseId:1,name:'Ring (noted)',count:5},
  {name:'Ring',count:9},{id:4,name:'Zero',count:1},{id:617,name:'Coins',count:100},{id:-1,name:'Coins',count:4},{name:'Odd',count:8}];
 const bots=[{name:'Worker',bankAt:1,bank}],env:any={S:{economy},window:{},stockView:'stock',stockAccount:'',stockQuery:'',stockSort:'quantity',stockLimit:80,bots:()=>bots,page:String,title:()=>'',stockTabs:()=>'',E:String,nf:String,gp:String,safeName:String,age:String,button:()=>'',icon:()=>''};
 const html=new Function(...Object.keys(env),`${moneySource}${code};return stock();`)(...Object.values(env)) as string;
 expect(html).toContain('<b>370 + ?</b>');expect(html).toContain('4 item kinds without a price');expect(html).toContain('<b>7</b><span>item kinds</span>');
 expect(html).toContain('<strong>7 <small class="op-sub">· 70</small>');expect(html).toContain('<strong>3 <small class="op-sub">· 300</small>');
 expect(html).toContain('<strong>9 <small class="op-sub">· unpriced</small>');expect(html).toContain('<strong>1 <small class="op-sub">· 0</small>');
 expect(html).not.toContain('9999');
});

function stockView(bank:any[],options:Record<string,unknown>={}){
 const code=operations.slice(operations.indexOf(' function stock(){'),operations.indexOf(' // Fleet deck:'));
 const env:any={S:{economy:{itemPricesById:{1:{value:10},2:{value:100}}}},window:{},stockView:'stock',stockAccount:'',stockQuery:'',stockSort:'quantity',stockLimit:80,bots:()=>[{name:'Worker',bankAt:1,bank}],page:String,title:()=>'',stockTabs:()=>'',E:String,nf:String,gp:String,safeName:String,age:String,button:(label:string,action:string)=>`<button data-op="${action}">${label}</button>`,icon:()=>'',...options};
 return new Function(...Object.keys(env),`${moneySource}${code};return stock();`)(...Object.values(env)) as string;
}

test('supply search trims whitespace and the summary counts every matching item',()=>{
 const html=stockView([{id:1,name:'Air rune',count:2},{id:2,name:'Shark',count:5}],{stockQuery:'  SHARK  '});
 expect(html).toContain('<b>500</b>');expect(html).toContain('<b>1</b><span>item kinds</span>');
 expect(html).toContain('Shark');expect(html).not.toContain('Air rune');expect(html).toContain('id="op-stock-summary"');
 expect(html).toContain('1 of 1 item kinds');
});

test('supply ledger exposes the render limit and show more reaches the remaining stock',()=>{
 const bank=Array.from({length:81},(_,n)=>({id:n+10,name:'Supply '+n,count:100-n}));
 const first=stockView(bank),more=stockView(bank,{stockLimit:160});
 expect(first).toContain('80 of 81 item kinds');expect(first).toContain('data-op="stock-more"');
 expect(first).not.toContain('> Supply 80<');expect(more).toContain('> Supply 80<');
 expect(more).toContain('81 of 81 item kinds');expect(more).not.toContain('data-op="stock-more"');
});

test('stock sort uses stack value, keeps unpriced stock last and sorts names predictably',()=>{
 const bank=[{id:1,name:'Zamorak rune',count:2},{id:2,name:'Air rune',count:1},{id:9,name:'Unpriced',count:100}];
 const value=stockView(bank,{stockSort:'value'}),name=stockView(bank,{stockSort:'name'});
 expect(value.indexOf('> Air rune<')).toBeLessThan(value.indexOf('> Zamorak rune<'));
 expect(value.indexOf('> Zamorak rune<')).toBeLessThan(value.indexOf('> Unpriced<'));
 expect(name.indexOf('> Air rune<')).toBeLessThan(name.indexOf('> Unpriced<'));
});

test('supply ledger distinguishes an empty bank, missing observations and a search with no match',()=>{
 expect(stockView([])).toContain('The reported banks are empty.');
 expect(stockView([],{bots:()=>[]})).toContain('No bank snapshots have been reported.');
 expect(stockView([{id:1,name:'Air rune',count:2}],{stockQuery:'shark'})).toContain('No items match');
});

test('stock input refreshes both totals and rows without replacing the search field',()=>{
 const start=operations.indexOf("if(e.target.id==='op-stock-search')"),handler=operations.slice(start,operations.indexOf('\n',start));
 const refresh=operations.slice(operations.indexOf(' function refreshStock(){'),operations.indexOf(' // Fleet deck:'));
 const replaced:string[]=[];
 new Function('document','$','stock',`${refresh};refreshStock();`)({createElement:()=>({set innerHTML(_v:string){},querySelector:(id:string)=>({id})})},(id:string)=>({replaceWith:()=>replaced.push(id)}),()=>'');
 expect(replaced).toEqual(['#op-stock-summary','#op-stock-list']);
 expect(handler).toContain('refreshStock()');expect(handler).toContain('stockLimit=80');
});

test('activity flow totals and tooltips price retained IDs and mark unknown historical names as partial',()=>{
 const code=operations.slice(operations.indexOf('  function flowBoxes(kind){'),operations.indexOf("if(activityFilter==='shots')"));
 const flow={at:now,since:now-3_600_000,loot:[{id:1,name:'Ring',count:2},{id:2,name:'Ring',count:3},{id:3,baseId:1,name:'Ring (noted)',count:2},{name:'Ring',count:7},{id:617,name:'Coins',count:4}],used:[{id:1,name:'Ring',count:1}]};
 const env:any={S:{economy},window:{},bots:()=>[{name:'Worker',flow}],E:String,nf:String,gp:String,safeName:String,age:String,icon:()=>''};
 const html=new Function(...Object.keys(env),`${moneySource}${code};return flowBoxes('loot');`)(...Object.values(env)) as string;
 expect(html).toContain('<strong>340 gp + ?');expect(html).toContain('Ring × 2 · 20 gp');expect(html).toContain('Ring × 3 · 300 gp');
 expect(html).toContain('Ring (noted) × 2 · 20 gp');expect(html).toContain('Ring × 7 · unpriced');expect(html).toContain('Coins × 4 · unpriced');
 expect(html).toContain('net 330 gp (priced items only; 2 unpriced item kinds)');
});

test('transfer summaries retain known values and aggregate unpriced coverage without claiming a complete zero',()=>{
 const code=operations.slice(operations.indexOf(' function transfers(){'),operations.indexOf(' // Best in slot (Supply ledger tab):'));
 const flow=[
  {from:'Worker',to:'Banker',value:20,coins:0,valueComplete:true,unpriced:0,items:[{id:1,name:'Ring',count:2}]},
  {from:'Worker',to:'Banker',value:0,coins:0,valueComplete:false,unpriced:1,items:[{id:2,name:'Ring',count:3}]},
  {from:'Worker',to:'Banker',value:0,coins:0,valueComplete:false,unpriced:2,items:[{name:'Ring',count:4}]},
  {from:'Banker',to:'Worker',value:0,coins:0,valueComplete:false,items:[{name:'Unknown',count:1}]},
 ];
 const env:any={S:{vault:{flow}},window:{},bots:()=>[{name:'Worker'},{name:'Banker'}],E:String,nf:String,gp:String,safeName:String,age:String};
 const html=new Function(...Object.keys(env),`${moneySource}${code};return transfers();`)(...Object.values(env)) as string;
 expect(html).toContain('<strong>20 + 3 unpriced</strong>');expect(html).toContain('<strong>0 + ? unpriced</strong>');
 expect(html).toContain('Ring × 4 · Ring × 3 · Ring × 2');expect(html).not.toContain('Ring × 9');
 expect(html).not.toContain('<strong>0</strong>');
});

test('the account HP KPI dates recorded health and labels it current only while the current guard passes',()=>{
 const code=operations.slice(operations.indexOf(' function account(){'),operations.indexOf(' function raw(){'));
 const html=(bot:any,helpers=true)=>{
  const window=helpers?{atlasOperator:()=>false,atlasRecordedHp:(b:any)=>recordedHp(b,now),atlasCurrentHp:(b:any)=>currentHp(b,now)}:{atlasOperator:()=>false};
  const env:any={window,bots:()=>[bot],sel:'Worker',meta:null,tasks:()=>[],page:String,title:()=>'',button:()=>'',safeName:String,age:(at:number)=>String(now-at),badge:()=>'',issues:()=>[],E:String,nf:String,gp:String};
  return new Function(...Object.keys(env),`${code};return account();`)(...Object.values(env)) as string;
 };
 const bot={name:'Worker',operation:'observed',inWorld:true,at:now-1,hpAt:now-60_000,hp:{now:2,max:20}};
 expect(html(bot)).toContain('<b>2 / 20</b><span>recorded hitpoints</span><small>60000 old</small>');
 expect(html({...bot,hpAt:now-1})).toContain('<b>2 / 20</b><span>current hitpoints</span><small>1 old</small>');
 for(const b of [{...bot,hpAt:null},{...bot,hp:{now:NaN,max:20}},{...bot,hpAt:now+1}])expect(html(b)).toContain('<b>—</b><span>recorded hitpoints</span><small>Not reported</small>');
 expect(html(bot,false)).toContain('<b>—</b><span>recorded hitpoints</span>');
 expect(html({...bot,pos:{x:3060,z:3880,level:0}})).toContain('3060, 3880 · floor 0 · Wilderness 46');
 expect(html({...bot,pos:{x:3185,z:3436,level:0}})).not.toContain('Wilderness');
});

test('fleet Wilderness filter counts and isolates playing accounts in the Wilderness',()=>{
 const code=operations.slice(operations.indexOf(' function fleet(){'),operations.indexOf(' function account(){'));
 const list=[
  {name:'WildOne',operation:'observed',inWorld:true,pos:{x:3060,z:3880,level:0}},
  {name:'SafeOne',operation:'observed',inWorld:true,pos:{x:3185,z:3436,level:0}},
 ];
 const render=(fleetFilter:string)=>new Function('S','window','bots','fleetQuery','fleetFilter','issues','idleOf','isOwner','fleetDeck','fleetRow','publicRow','safeName','page','title','E',`${code};return fleet();`)(
  {fleetSides:{sides:[],orders:[]}},{atlasOperator:()=>false},()=>list,'',fleetFilter,()=>[],()=>null,()=>false,()=>'',()=>'',(b:any)=>`[ROW:${b.name}]`,String,(s:string)=>s,()=>'',String) as string;
 const all=render('all');
 expect(all).toContain('Wilderness<span class="op-count">1</span>');
 const wild=render('wildy');
 expect(wild).toContain('[ROW:WildOne]');
 expect(wild).not.toContain('[ROW:SafeOne]');
 const rowCode=operations.slice(operations.indexOf(' function fleetRow(b){'),operations.indexOf(' function publicRow(b){'));
 const rowHtml=new Function('window','issues','overallRank','totalLevel','st','resultSummary','safeName','skillIcon','compactRate','idleOf','button','E','nf',`${rowCode};return fleetRow({name:'WildOne',operation:'observed',inWorld:true,pos:{x:3060,z:3880,level:0}});`)(
  {atlasOperator:()=>true},()=>[],()=>null,()=>0,()=>['','observed'],()=>'',String,()=>'',String,()=>null,()=>'',String,String) as string;
 expect(rowHtml).toContain('Observed · wildy 46');
});

test('Command centre shows unused bot slots, RAM headroom, fast-fail loops and stale controller leases',()=>{
 const code=operations.slice(operations.indexOf(' function operations(){'),operations.indexOf(' // Why a new bot cannot start now'));
 const S={
  coordination:{counts:{running:2,pending:1},fresh:true,available:true,agents:[]},
  wilderness:[],
  capacity:{fresh:true,active:14,cap:25,queued:1,freeGB:6.8,floorGB:4.0,headroomGB:2.8},
  scoreboard:{available:false},
  fleetSides:{sides:[]},
  diagnostics:{
   failLoops:[{name:'⟦MAIN⟧',goal:'thieving',error:'stall timeout',runs:5,medianSec:11,lastAt:1000}],
   leases:[{side:'local',host:'pc',pid:10,at:1000,ageMs:60_000,stale:false},{side:'cloud',host:'c1',pid:20,at:100,ageMs:1_200_000,stale:true}],
  },
 };
 const safeName=(s:string)=>String(s).replaceAll('⟦MAIN⟧','Main · reserved');
 const env={S,meta:{controllers:[]},bots:()=>[{name:'Bot1',operation:'observed',inWorld:true}],issues:()=>[],incidentCards:()=>'',startBlock:()=>'',page:String,title:String,button:()=>'',badge:(_s:string,l:string)=>`[${l}]`,E:String,safeName,age:(at:number)=>at<1e9?'BAD_EPOCH_ARG':'0m',ago:(ms:number)=>Math.round(ms/60_000)+'m',metaError:'',message:''};
 const html=new Function(...Object.keys(env),`${code};return operations();`)(...Object.values(env)) as string;
 expect(html).toContain('14 / 25');
 expect(html).toContain('11 unused · 1 queued');
 expect(html).toContain('GiB RAM headroom');
 expect(html).toContain('Fast-fail loops (2 h)');
 expect(html).toContain('Main · reserved');
 expect(html).toContain('5× · 11s');
 expect(html).toContain('Controller leases');
 expect(html).toContain('STALE 20m');
 expect(html).not.toContain('Haggis');
});

test('Command centre lists the jobs that ended orphaned, blocked or gave-up, and never the reserved account',()=>{
 const code=operations.slice(operations.indexOf(' function operations(){'),operations.indexOf(' // Why a new bot cannot start now'));
 const list=[
  {name:'Stuck',job:{state:'ended: blocked after 3 runs'}},
  {name:'Gone',job:{state:'ended: exit orphaned: attempt 1794962132674-0000026264-0000000001 owner 26264 gone'}},
  {name:'Quit',planJob:{state:'gave-up after 1 run'}},
  {name:'Held',job:{state:'waiting: memory'}},
  {name:'Off',job:{state:'blocked after 9 runs',enabled:false}},
  {name:'Reserved',reserved:true,job:{state:'exit orphaned'}},
  {name:'Fine',job:{state:'running'}},
 ];
 const S={coordination:{counts:{},fresh:true,available:true,agents:[]},wilderness:[],capacity:{},scoreboard:{available:false},fleetSides:{sides:[]},diagnostics:{failLoops:[],leases:[]}};
 const env={S,meta:{controllers:[]},bots:()=>list,issues:()=>[],incidentCards:()=>'',startBlock:()=>'',page:String,title:String,button:()=>'',badge:(_s:string,l:string)=>`[${l}]`,E:String,safeName:String,age:()=>'0m',ago:()=>'0m',metaError:'',message:''};
 const t=new Function(...Object.keys(env),`${code};return {rows:recoveryRows(),html:operations()};`)(...Object.values(env)) as {rows:{name:string;kind:string;runs:number|null}[];html:string};
 // Order: orphaned, blocked, gave-up, waiting. A disabled job and the reserved account are not listed.
 expect(t.rows.map(r=>[r.name,r.kind,r.runs])).toEqual([['Gone','orphaned',null],['Stuck','blocked',3],['Quit','gave-up',1],['Held','waiting',null]]);
 expect(t.html).toContain('jobs need recovery');
 expect(t.html).toContain('1 worker gone · 1 blocked · 1 gave up · 1 waiting');
 expect(t.html).toContain('Job recovery');
 expect(t.html).toContain('[4 to review]');
 expect(t.html).toContain('The worker process 26264 is gone.');
 expect(t.html).toContain('Ended blocked after 3 runs.');
 expect(t.html).toContain('Ended as gave-up after 1 run.');
 expect(t.html).not.toContain('Reserved');
 expect(t.html).not.toContain('data-value="Off"');
 // No such job: the card says so and the count is 0.
 const none=new Function(...Object.keys(env),`${code};return operations();`)(...Object.values({...env,bots:()=>[{name:'Fine',job:{state:'running'}}]})) as string;
 expect(none).toContain('[Clear]');
 expect(none).toContain('No orphaned, blocked or waiting job.');
});

test('server diagnostics mark stale leases cleanly and exclude protected main account loops',async()=>{
 const {mkdtempSync,rmSync,writeFileSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {failLoops,LOOP_WINDOW_MS}=await import('../core/src/fail-loops');
 const {LEASE_MAX_AGE_MS,SIDE_NAME}=await import('../core/src/fleet');
 const server=readFileSync(new URL('./server/state/results.ts',import.meta.url),'utf8');
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(server.slice(server.indexOf('function readLeaseDiagnostics('),server.indexOf('\nexport {',server.indexOf('function readLeaseDiagnostics('))));
 const dir=mkdtempSync(join(tmpdir(),'dash-leases-'));
 try{
  const now=10_000_000;
  writeFileSync(join(dir,'cloud.json'),JSON.stringify({side:'cloud',host:'cloud-box',pid:101,at:now-LEASE_MAX_AGE_MS}));
  writeFileSync(join(dir,'local.json'),JSON.stringify({side:'local',host:'pc-box',pid:202,at:now-60_000}));
  writeFileSync(join(dir,'bad.json'),'{corrupt');
  writeFileSync(join(dir,'mismatch.json'),JSON.stringify({side:'other',host:'x',pid:1,at:now}));
  const fn=new Function('existsSync','readdirSync','readFileSync','join','SIDE_NAME','LEASE_MAX_AGE_MS','FILES','root','allResults','MAIN','failLoops','LOOP_WINDOW_MS',`${code};return {readLeaseDiagnostics,fleetDiagnostics};`)(
   (await import('node:fs')).existsSync,(await import('node:fs')).readdirSync,readFileSync,join,SIDE_NAME,LEASE_MAX_AGE_MS,{fleet:dir},dir,
   [
    {started:now-5000,at:now-1000,name:'Haggis',goal:'thieving',ok:false,text:'fail no food'},
    {started:now-5000,at:now-1000,name:'Haggis',goal:'thieving',ok:false,text:'fail no food'},
    {started:now-5000,at:now-1000,name:'Haggis',goal:'thieving',ok:false,text:'fail no food'},
    {started:now-5000,at:now-1000,name:'WorkerA',goal:'woodcutting',ok:false,text:'fail stall'},
    {started:now-5000,at:now-1000,name:'WorkerA',goal:'woodcutting',ok:false,text:'fail stall'},
    {started:now-5000,at:now-1000,name:'WorkerA',goal:'woodcutting',ok:false,text:'fail stall'},
   ],
   'Haggis',failLoops,LOOP_WINDOW_MS);
  const leases=fn.readLeaseDiagnostics(dir,now);
  expect(leases.map((l:any)=>[l.side,l.stale])).toEqual([['bad',null],['cloud',true],['local',false],['mismatch',null]]);
  const diag=fn.fleetDiagnostics(now);
  expect(diag.failLoops.map((l:any)=>l.name)).toEqual(['WorkerA']);
 }finally{
  rmSync(dir,{recursive:true,force:true});
 }
});

test('Supply bill tab calculates route fulfillment for operators only and stays redacted for spectators',()=>{
 require('./xp-tracker.js');
 const atlasXp=(globalThis as any).atlasXp;
 const stockFn=operations.slice(operations.indexOf(' const stockTabs='),operations.indexOf(' function refreshStock('));
 const make=(owner:boolean,stockView='bill',billBatches=1,billQuery='')=>{
  const env:any={
   stockView,billQuery,billBatches,stockAccount:'',stockQuery:'',stockSort:'quantity',stockLimit:80,
   isOwner:()=>owner,
   S:{race:{supplies:[{item:'Dragon bones',itemId:536,count:100},{item:'Shark',itemId:385,count:40}]},scoreboard:{goals:{collection:{missing:[{item:'Super restore(4)',need:10,consumer:'pk'}]}}},economy:{}},
   window:{atlasXp},
   bots:()=>[{name:'⟦MAIN⟧',bank:[{id:536,name:'Dragon bones',count:500}]},{name:'Supply1',bank:[{id:536,name:'Dragon bones',count:25},{id:385,name:'Shark',count:40}],inventory:[{id:536,name:'Dragon bones',count:5}]}],
   page:(s:string)=>s,title:()=>'',E:String,nf:String,gp:String,safeName:(n:string)=>String(n).replaceAll('⟦MAIN⟧','Main · reserved'),age:String,button:()=>'',icon:()=>'',bestInSlot:()=>'',collectionLog:()=>'',transfers:()=>'',
   moneyKey:()=>'',moneyPrice:()=>null,
  };
  return new Function(...Object.keys(env),`${stockFn};return {tabs:stockTabs(),html:stock()};`)(...Object.values(env));
 };
 const op=make(true,'bill',2);
 expect(op.tabs).toContain('data-value="bill"');
 expect(op.html).toContain('Supply bill');
 expect(op.html).toContain('bill fulfilled (2× route)');
 expect(op.html).toContain('30 / 200');
 expect(op.html).toContain('40 / 80');
 expect(op.html).toContain('Supply1');
 expect(op.html).not.toContain('Main · reserved');
 expect(op.html).not.toContain('Haggis');
 const pub=make(false,'bill');
 expect(pub.tabs).not.toContain('data-value="bill"');
 expect(pub.html).toContain('operator view only');
 expect(pub.html).not.toContain('Dragon bones');
});
