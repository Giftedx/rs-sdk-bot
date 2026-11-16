import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const slice=(start:string,end:string)=>shell.slice(shell.indexOf(start),shell.indexOf(end,shell.indexOf(start)));
const journal=slice("  let questScope='account';",'  function gamePanel(');
const requirements=slice("  // Quest requirements (RuneLite's Quest Helper)",'  // The third list is XP');
const escape=(v:unknown)=>String(v??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const decode=(v:string)=>v.replaceAll('&quot;','"').replaceAll('&lt;','<').replaceAll('&amp;','&');
const sync=(v:any):any=>({then:(fn:Function)=>sync(fn(v))});

function questData(bots:any[]){
 const reqs={Gate:{s:[],q:[['Prerequisite',1]]},Free:{s:[],q:[]}};
 return new Function('S','E','safeName','asset','fetch',`let questDetail=null,questFilter='all',questQuery='';${journal}${requirements};return {questReqs,questReady,reqHtml,list:()=>fleetQuests(),filter:v=>{questFilter=v;return fleetQuests();},detail:v=>{questDetail=v;return fleetQuests();}};`)
  ({bots},escape,String,String,()=>sync({ok:true,json:()=>reqs}));
}

test('unknown and unrecognized quest flags stay unknown in Fleet filters, counts and details',()=>{
 const t=questData([{name:'Alpha',quests:[{name:'Gate',state:'complete'},{name:'Free',state:'unknown'}]},{name:'Bravo',quests:[{name:'Gate',state:'unknown'},{name:'Free',state:'unexpected'}]}]);
 expect(t.list()).toContain('0 by all 2');expect(t.list()).toContain('Unknown 2');
 expect(t.filter('completed')).not.toContain('data-quest="Gate"');expect(t.filter('not started')).not.toContain('data-quest="Free"');
 expect(t.filter('unknown')).toContain('data-quest="Gate"');expect(t.filter('unknown')).toContain('color:#aaa');
 expect(t.detail('Gate')).toContain('<span style="color:#aaa" title="unknown">Bravo</span>');
 expect(t.detail('Free')).not.toContain('title="not started"');
});

test('a partial reported journal cannot make a quest complete for every reporting account',()=>{
 const t=questData([{name:'Alpha',quests:[{name:'Gate',state:'completed'}]},{name:'Bravo',quests:[{name:'Free',state:'started'}]}]);
 expect(t.list()).toContain('0 by all 2');expect(t.list()).toContain('<span>Gate</span><span>1/2</span>');
 expect(t.detail('Gate')).toContain('title="unknown">Bravo</span>');
});

test('unknown prerequisite and own quest flags never imply missing or Ready',()=>{
 const t=questData([]);
 for(const state of ['unknown','unexpected',undefined]){
  const b={quests:[{name:'Prerequisite',state}]};
  expect(t.questReqs(b,'Gate')).toEqual([{text:'Prerequisite',ok:null,have:null,src:1}]);
  expect(t.reqHtml(b,'Gate')).toContain('class="req-unknown"');
  expect(t.questReady(b,{name:'Free',state})).toBe(false);
 }
 for(const state of ['complete','completed'])expect(t.questReqs({quests:[{name:'Prerequisite',state}]},'Gate')[0].ok).toBe(true);
 for(const state of ['started','not started']){
  expect(t.questReqs({quests:[{name:'Prerequisite',state}]},'Gate')[0].ok).toBe(false);
  expect(t.questReady({}, {name:'Free',state})).toBe(true);
 }
});

function controls(){
 let bot:any={name:'Alpha',questsAt:1,quests:[{name:'Gate',state:'not started'},{name:'Free',state:'started'}],equipment:[],inventory:[]};
 const doc:any={activeElement:null},outside:any={isConnected:true},handlers:any={};let api:any;
 const panel:any={dataset:{},_h:null,markup:'',controls:[],contains:(node:any)=>node?.isConnected&&node.parent===panel};
 const make=(tag:string,attributes:any)=>{
  const node:any={parent:panel,isConnected:true,tagName:tag.toUpperCase(),attributes,value:attributes.value??'',selectionStart:0,selectionEnd:0};
  node.dataset=Object.fromEntries(Object.entries(attributes).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_m,c)=>c.toUpperCase()),v]));
  node.matches=(q:string)=>q.split(',').some(s=>{const m=s.trim().match(/^\[([^=\]]+)(?:="(.*)")?\]$/);return m&&Object.hasOwn(attributes,m[1]!)&&(m[2]===undefined||attributes[m[1]!]===m[2]);});
  node.closest=(q:string)=>node.matches(q)?node:null;node.focus=()=>{if(node.isConnected)doc.activeElement=node;};node.setSelectionRange=(a:number,b:number)=>{node.selectionStart=a;node.selectionEnd=b;};
  node.click=()=>hud.onclick({target:node});return node;
 };
 Object.defineProperty(panel,'innerHTML',{get:()=>panel.markup,set:(html:string)=>{
  if(panel.contains(doc.activeElement))doc.activeElement=outside;for(const n of panel.controls)n.isConnected=false;
  panel.markup=html;panel.controls=[...html.matchAll(/<(button|input|select)\b([^>]*)>/g)].map(m=>{
   const a=Object.fromEntries([...m[2]!.matchAll(/([\w-]+)="([^"]*)"/g)].map(x=>[x[1],decode(x[2]!) ]));
   for(const bare of m[2]!.matchAll(/\s(data-[\w-]+)(?=\s|$|>)/g))a[bare[1]!]='';return make(m[1]!,a);
  });
 }});
 panel.querySelectorAll=(q:string)=>panel.controls.filter((n:any)=>n.matches(q));panel.querySelector=(q:string)=>panel.querySelectorAll(q)[0]??null;
 const hud:any={querySelectorAll:()=>[],classList:{toggle(){},remove(){}},addEventListener:(kind:string,fn:any)=>{handlers[kind]=fn;}};
 const env:any={document:doc,hud,account:()=>bot,$:()=>panel,put:(el:any,html:string)=>{if(el._h!==html){el._h=html;el.innerHTML=html;}},CSS:{escape:(s:string)=>s},E:escape,safeName:String,age:String,S:{bots:[bot]},window:{atlasOperator:()=>true},app:{classList:{contains:()=>false}},placesBox:{hidden:true},location:{origin:'https://example.test'},
  questPointsOf:()=>null,deathMarks:()=>null,deathCls:()=>'',setupSlot:()=>({cls:'',tip:''}),icon:()=>'',qty:String,chargeTag:()=>'',equipStats:()=>'',setupPanel:()=>'<select data-setup-kit aria-label="Inventory setup"><option>'+setup()+'</option></select>',localStorage:{setItem(){}},toast(){}
 };
 const panelCode=slice('  function gamePanel(',"  // The XP Tracker plugin"),click=shell.split('\n').find(l=>l.startsWith('  hud.onclick='))!,change=shell.split('\n').find(l=>l.startsWith("  hud.addEventListener('change',e=>{if(e.target.matches?.('[data-setup-kit]')"))!,input=shell.split('\n').find(l=>l.startsWith("  hud.addEventListener('input',e=>{if(!e.target.matches('[data-quest-search]')"))!;
 const accountReset=slice('    const b=account(),name=b?.name??null;','    app.classList.toggle(\'public-view\'');
 api=new Function(...Object.keys(env),`let selectedTab='quests',questDetail=null,questFilter='all',questQuery='',questAccount='Alpha',setupKit='';${journal}${panelCode}${click}${change}${input};return {gamePanel,setup:()=>setupKit,tab:v=>{selectedTab=v;gamePanel();},refresh:()=>{${accountReset}gamePanel();}};`)(...Object.values(env));
 function setup(){return api?.setup()??'';}
 const find=(key:string,value?:string)=>panel.controls.find((n:any)=>Object.hasOwn(n.dataset,key)&&(value===undefined||n.dataset[key]===value));
 const focus=(key:string,value?:string)=>{const n=find(key,value);expect(n).toBeDefined();n.focus();return n;};
 doc.activeElement=outside;api.gamePanel();return {api,doc,panel,outside,find,focus,click:(key:string,value?:string)=>focus(key,value).click(),change:(node:any)=>handlers.change({target:node}),input:(node:any)=>handlers.input({target:node}),update:(b:any)=>{bot=b;api.refresh();},bot:()=>bot};
}

test('quest filters and scopes retain their logical control after their real click handlers redraw',()=>{
 const t=controls();t.click('questFilter','in progress');expect(t.doc.activeElement).toBe(t.find('questFilter','in progress'));
 t.click('questScope','fleet');expect(t.doc.activeElement).toBe(t.find('questScope','fleet'));
 t.click('questScope','account');expect(t.doc.activeElement).toBe(t.find('questScope','account'));
});

test('quest detail focuses Back, periodic refresh retains it, and Back returns to the original row or search',()=>{
 const t=controls();t.click('quest','Gate');expect(t.doc.activeElement).toBe(t.find('questBack'));
 t.update({...t.bot(),questsAt:2});expect(t.doc.activeElement).toBe(t.find('questBack'));
 t.click('questBack');expect(t.doc.activeElement).toBe(t.find('quest','Gate'));
 t.click('quest','Gate');t.update({...t.bot(),quests:[{name:'Free',state:'started'}]});t.click('questBack');expect(t.doc.activeElement).toBe(t.find('questSearch'));
});

test('HUD redraw keeps quest rows, typed search selection and setup selection without stealing outside focus',()=>{
 const t=controls();t.focus('quest','Gate');t.update({...t.bot(),questsAt:2});expect(t.doc.activeElement).toBe(t.find('quest','Gate'));
 const search=t.focus('questSearch');search.value='Free';search.selectionStart=1;search.selectionEnd=3;t.input(search);expect(t.doc.activeElement).toBe(t.find('questSearch'));expect(t.find('questSearch').selectionStart).toBe(1);expect(t.find('questSearch').selectionEnd).toBe(3);
 t.api.tab('equipment');const setup=t.focus('setupKit');setup.value='Kit';t.change(setup);expect(t.api.setup()).toBe('Kit');expect(t.doc.activeElement).toBe(t.find('setupKit'));
 t.doc.activeElement=t.outside;t.update({...t.bot(),at:3});expect(t.doc.activeElement).toBe(t.outside);
});

test('an external account change clears quest detail and does not focus an identically named control',()=>{
 const t=controls();t.click('quest','Gate');t.doc.activeElement=t.outside;t.update({...t.bot(),name:'Bravo'});expect(t.find('questBack')).toBeUndefined();expect(t.doc.activeElement).toBe(t.outside);
 t.click('quest','Gate');t.update({...t.bot(),name:'Charlie'});expect(t.find('questBack')).toBeUndefined();expect(t.doc.activeElement).toBe(t.outside);
});
