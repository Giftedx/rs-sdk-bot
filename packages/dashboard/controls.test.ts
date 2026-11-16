import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const operations=readFileSync(new URL('./operations.js',import.meta.url),'utf8');
const mapShell=readFileSync(new URL('./map-shell.js',import.meta.url),'utf8');
const escape=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const attrs=(markup:string)=>Object.fromEntries([...markup.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2].replaceAll('&quot;','"').replaceAll('&amp;','&')]));

function bank(){
 const code=shell.slice(shell.indexOf('  function openBank('),shell.indexOf('  // Orbs as RuneLite'));
 const doc:any={activeElement:null};let current:any={name:'Worker',bankAt:1,bank:[{id:1,name:'Body',count:1},{id:2,name:'Body',count:2},{id:2,name:'Body',count:3}]},items:any[]=[],removed=false;
 const make=(dataset:any={},parent:any=null)=>{const node:any={dataset,parent,isConnected:true,value:'',hidden:false,disabled:false,focus:()=>{if(!node.hidden&&!node.disabled)doc.activeElement=node;}};return node;};
 const opener=make({op:'bank-window',value:'Worker'}),replacement=make({...opener.dataset}),outside=make(),fallback=make(),focusNow=make();let openers=[opener];
 const modal:any={attributes:{},setAttribute:(k:string,v:string)=>{modal.attributes[k]=v;},contains:(node:any)=>!!node&&(node===modal||node.parent===modal||node.parent===itemBox),remove:()=>{removed=true;if(modal.contains(doc.activeElement))doc.activeElement=null;},querySelectorAll:()=>items};
 const search=make({},modal),close=make({},modal),itemBox:any={parent:modal,querySelectorAll:()=>items};
 Object.defineProperty(itemBox,'innerHTML',{set:(html:string)=>{if(items.includes(doc.activeElement))doc.activeElement=null;items=[...html.matchAll(/<button([^>]*)>/g)].map(m=>{const a=attrs(m[1]!);return make({bankKey:a['data-bank-key']},itemBox);});}});
 const nodes:any={'input':search,'[aria-label="Close bank"]':close,'.bank-items':itemBox,'.bank-tabs':{}};
 modal.querySelector=(q:string)=>nodes[q]??=(make({},modal));
 Object.assign(doc,{createElement:()=>modal,querySelectorAll:()=>openers,querySelector:(q:string)=>q==='.op-command-button'?fallback:q==='.focus-now'?focusNow:null});doc.activeElement=opener;
 const env:any={account:()=>current,document:doc,hud:{querySelector:()=>null,append:()=>{removed=false;}},window:{atlasOperator:()=>true},E:escape,safeName:String,age:String,stackValue:()=>({value:0,unpriced:0}),gp:String,icon:()=>'',qty:String,priceTip:()=>'',statTip:()=>''};
 const open=new Function(...Object.keys(env),code+';return openBank;')(...Object.values(env));
 const key=(key:string)=>{let prevented=false;modal.onkeydown?.({key,preventDefault:()=>{prevented=true;},stopPropagation(){}});return prevented;};
 return {open:()=>open(opener),doc,modal,search,close,opener,replacement,outside,fallback,focusNow,key,items:()=>items,removed:()=>removed,replaceOpener:()=>{opener.isConnected=false;openers=[replacement];},addReplacement:()=>{openers=[opener,replacement];},removeOpeners:()=>{opener.isConnected=false;openers=[];},update:(b:any)=>{current=b;modal.refreshObservation();}};
}

test('Bank focuses search, stays non-modal and restores connected or replaced openers on close and Escape',()=>{
 for(const via of ['close','escape','replacement','fallback']){
  const b=bank();b.open();expect(b.doc.activeElement).toBe(b.search);expect(b.modal.attributes.role).toBe('dialog');expect(b.modal.attributes['aria-modal']).not.toBe('true');
  expect(b.key('Tab')).toBe(false);
  if(via==='replacement')b.replaceOpener();if(via==='fallback')b.removeOpeners();
  if(via==='escape')expect(b.key('Escape')).toBe(true);else b.close.onclick();
  expect(b.removed()).toBe(true);expect(b.doc.activeElement).toBe(via==='replacement'?b.replacement:via==='fallback'?b.fallback:b.opener);
 }
});

test('Bank refresh keeps exact item occurrence focus and falls back to search without stealing outside focus',()=>{
 const b=bank();b.open();b.items()[2].focus();
 b.update({name:'Worker',bankAt:2,bank:[{id:2,name:'Body',count:4},{id:1,name:'Body',count:1},{id:2,name:'Body',count:5}]});
 expect(b.doc.activeElement).toBe(b.items()[2]);
 b.update({name:'Worker',bank:[]});expect(b.doc.activeElement).toBe(b.search);
 b.outside.focus();b.update({name:'Other',bank:[]});expect(b.removed()).toBe(true);expect(b.doc.activeElement).toBe(b.outside);
 const close=bank();close.open();close.outside.focus();close.close.onclick();expect(close.doc.activeElement).toBe(close.outside);
});

test('Bank close tries usable fallbacks when a connected opener or command button cannot take focus',()=>{
 for(const blocked of ['hidden','disabled']){
  const b=bank();b.open();b.opener[blocked]=true;b.close.onclick();expect(b.doc.activeElement).toBe(b.fallback);
  const replacement=bank();replacement.open();replacement.opener[blocked]=true;replacement.addReplacement();replacement.key('Escape');expect(replacement.doc.activeElement).toBe(replacement.replacement);
  const title=bank();title.open();title.opener[blocked]=true;title.fallback[blocked]=true;title.close.onclick();expect(title.doc.activeElement).toBe(title.focusNow);
 }
});

test('the bank-window action passes its original opener across the account redraw',()=>{
 const start=operations.indexOf("else if(action==='bank-window'){")+"else if(action==='bank-window'){".length,end=operations.indexOf("}else if(action==='stock-view')",start);
 const opener:any={isConnected:true};let received:any;
 new Function('pick','api','v','el',operations.slice(start,end))(()=>{opener.isConnected=false;},{openBank:(el:any)=>{received=el;}},'Worker',opener);
 expect(received).toBe(opener);expect(received.isConnected).toBe(false);
});

function market(){
 const code=shell.slice(shell.indexOf("  let geQuery='',geOpen=null"),shell.indexOf('  // Pull requests plugin'));
 const clicks=shell.slice(shell.indexOf("  body.addEventListener('click',e=>{const bp="),shell.indexOf("  body.addEventListener('click',e=>{const mk="));
 const keys=shell.split('\n').find(l=>l.startsWith("  body.addEventListener('keydown',"))||'';
 const handlers:any={},focused:string[]=[],nodes:any={},doc:any={activeElement:null},missing=new Set<string>();
 const node=(q:string)=>nodes[q]??={innerHTML:'',focus:()=>{focused.push(q);doc.activeElement={inside:true};}};
 const results={contains:(el:any)=>!!el?.inside,querySelector:(q:string)=>missing.has(q)?null:node(q)};
 const body={querySelector:(q:string)=>q==='#ge-search'?node(q):results,addEventListener:(kind:string,fn:any)=>{handlers[kind]=fn;}};
 const env:any={S:{bots:[],economy:{supplies:[{id:1,name:'Coal',ask:100,stock:10}]}},window:{atlasOperator:()=>false},E:escape,nf:String,icon:()=>'',age:()=> '1m',body,document:doc,put:(el:any,html:string)=>{if(el.innerHTML!==html){el.innerHTML=html;doc.activeElement=null;}},loadItemSources:()=>{},itemSourcesData:{1:[['gather','Coal rock',[3000,3000,0]]]},geTele:()=>'',sourcePin:null};
 const api=new Function(...Object.keys(env),`${code}${clicks}${keys};return {geResults,refreshGe};`)(...Object.values(env));
 const row:any={inside:true,dataset:{geSrc:'1',geName:'Coal'},matches:(q:string)=>q.split(',').includes('[data-ge-src]'),closest:(q:string)=>q==='[data-ge-src]'?row:null,click:()=>handlers.click({target:{closest:(q:string)=>q==='[data-ge-src]'?row:null}})};
 return {...api,doc,focused,row,omit:(selector:string)=>missing.add(selector),key:(key:string)=>{let prevented=false;handlers.keydown?.({key,target:row,preventDefault:()=>{prevented=true;}});return prevented;},pin:()=>({inside:true,dataset:{srcPin:'0'},matches:(q:string)=>q==='[data-src-pin]',closest:(q:string)=>q==='[data-ge-sources]'?{dataset:{geSources:'1'}}:null})};
}

test('GE rows disclose sources with Enter and Space and expose expanded state without losing row focus',()=>{
 const m=market();expect(m.geResults()[1]).toContain('tabindex="0"');expect(m.geResults()[1]).toContain('role="button"');expect(m.geResults()[1]).toContain('aria-expanded="false"');
 m.doc.activeElement=m.row;expect(m.key('Enter')).toBe(true);expect(m.geResults()[1]).toContain('aria-expanded="true"');expect(m.geResults()[1]).toContain('Show on map');expect(m.focused.at(-1)).toBe('[data-ge-src="1"]');
 m.doc.activeElement=m.row;expect(m.key(' ')).toBe(true);expect(m.geResults()[1]).toContain('aria-expanded="false"');
});

test('GE periodic redraw keeps source button identity and returns to its disclosure when it disappears',()=>{
 const m=market();m.row.click();m.doc.activeElement=m.pin();m.refreshGe();expect(m.focused.at(-1)).toBe('[data-ge-sources="1"] [data-src-pin="0"]');
 m.omit('[data-ge-sources="1"] [data-src-pin="0"]');m.doc.activeElement=m.pin();m.refreshGe();expect(m.focused.at(-1)).toBe('[data-ge-src="1"]');
 m.omit('[data-ge-src="1"]');m.doc.activeElement=m.pin();m.refreshGe();expect(m.focused.at(-1)).toBe('#ge-search');
});

function shortcuts(nativeDialog:boolean,bankTarget=false,wall=false){
 const start=shell.lastIndexOf("  window.addEventListener('keydown',e=>{"),client=shell.slice(start,shell.indexOf('  window.atlasClient=',start));
 const command=operations.split('\n').find(l=>l.startsWith(" window.addEventListener('keydown',e=>{if((e.ctrlKey"))!;
 const travel=operations.split('\n').find(l=>l.startsWith(" window.addEventListener('keydown',e=>{if(e.target"))!;
 const listeners:any[]=[],wallKeys:string[]=[],counts={plugins:0,palette:0,travel:0,removed:0,tab:0};
 const env:any={window:{atlasWallOn:()=>wall,addEventListener:(_kind:string,fn:any)=>listeners.push(fn)},document:{body:{},querySelector:()=>nativeDialog?{}:null},focus:{classList:{contains:()=>false}},focusOpen:()=>{},wallEnd:()=>false,wallPress:(key:string)=>{wallKeys.push(key);return true;},context:null,hud:{querySelector:()=>({remove:()=>{counts.removed++;}}),classList:{remove(){}}},gamePanel:()=>{counts.tab++;},showPlugin:()=>{counts.plugins++;},$:()=>({focus(){}}),openPalette:()=>{counts.palette++;},travel:()=>{counts.travel++;}};
 new Function(...Object.keys(env),`let selectedTab='inventory';${client}${command}${travel}`)(...Object.values(env));
 const key=(key:string,more:any={})=>{let prevented=false;const event={key,target:{tagName:'BUTTON',closest:(q:string)=>bankTarget&&q.includes('.game-bank')?{}:null},preventDefault:()=>{prevented=true;},stopPropagation(){},...more};for(const listener of listeners)listener(event);return prevented;};
 return {key,counts,wallKeys};
}

test('native open dialogs retain slash, Escape, Tab, Enter and command keys without background shortcuts',()=>{
 const s=shortcuts(true);for(const key of ['/','Escape','Tab','Enter'])expect(s.key(key)).toBe(false);expect(s.key('k',{ctrlKey:true})).toBe(false);expect(s.key('ArrowLeft',{altKey:true})).toBe(false);
 expect(s.counts).toEqual({plugins:0,palette:0,travel:0,removed:0,tab:0});
});

test('Bank-owned keyboard input avoids background shortcuts while outside controls remain usable',()=>{
 const s=shortcuts(false,true);for(const key of ['/','Escape','F2'])s.key(key);s.key('k',{ctrlKey:true});s.key('ArrowLeft',{altKey:true});expect(s.counts).toEqual({plugins:0,palette:0,travel:0,removed:0,tab:0});
 const outside=shortcuts(false);outside.key('/');expect(outside.counts.plugins).toBe(1);
});

test('GE role buttons retain Enter and Space while the fleet wall keeps its canvas keys',()=>{
 const s=shortcuts(false,false,true),target={tagName:'DIV',closest:()=>null,getAttribute:()=> 'button'};
 expect(s.key('Enter',{target})).toBe(false);expect(s.key(' ',{target})).toBe(false);expect(s.wallKeys).toEqual([]);
 expect(s.key('Enter',{target:{tagName:'CANVAS',closest:()=>null}})).toBe(true);expect(s.wallKeys).toEqual(['Enter']);
});

test('the legacy document listener also leaves native dialogs and Bank keyboard events alone',()=>{
 const code=mapShell.split('\n').find(line=>line.includes("document.addEventListener('keydown'"))!;
 for(const where of ['dialog','bank','plain']){
  let handler:any,mutations=0,focuses=0;
  const body={tagName:'BODY',closest:()=>null},env:any={document:{body,querySelector:()=>where==='dialog'?{}:null,addEventListener:(_kind:string,fn:any)=>{handler=fn;}},focusMap:()=>{mutations++;},app:{classList:{contains:()=>true,add:()=>{mutations++;},remove:()=>{mutations++;},toggle:()=>{mutations++;}}},$:(q:string)=>({focus:()=>{focuses++;},select:()=>{}}),innerWidth:600};
  new Function(...Object.keys(env),code)(...Object.values(env));
  for(const key of ['/','Escape'])handler({key,target:{tagName:'BUTTON',closest:(q:string)=>where==='bank'&&q.includes('.game-bank')?{}:null},preventDefault(){}});
  if(where!=='bank')handler({key:'Tab',target:body,preventDefault(){}});
  if(where==='plain'){expect(mutations).toBeGreaterThan(0);expect(focuses).toBeGreaterThan(0);}else{expect(mutations).toBe(0);expect(focuses).toBe(0);}
 }
});
