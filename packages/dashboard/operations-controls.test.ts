import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const operations=readFileSync(new URL('./operations.js',import.meta.url),'utf8');
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const escape=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');

test('Fleet trims only its matching query and keeps the draft and selected filter',()=>{
 const source=operations.slice(operations.indexOf(' function fleet(){'),operations.indexOf(' function account(){'));
 const accounts=[{name:'PanelOne',operation:'observed'},{name:'PanelTwo',operation:'offline'},{name:'Other',operation:'observed'}];
 const render=(fleetQuery:string,fleetFilter='all')=>{
  const env:any={S:{},bots:()=>accounts,safeName:String,fleetQuery,fleetFilter,issues:()=>[],allocation:()=>'',idleOf:()=>null,isOwner:()=>false,window:{atlasOperator:()=>false},page:String,title:()=>'',E:escape,fleetDeck:()=>'',fleetRow:()=>'',publicRow:(b:any)=>'<b data-account="'+b.name+'">'+b.name+'</b>'};
  return new Function(...Object.keys(env),source+';return fleet();')(...Object.values(env)) as string;
 };
 const padded=render('  pAnEl  ','working');
 expect(padded).toContain('value="  pAnEl  "');
 expect(padded).toContain('data-account="PanelOne"');
 expect(padded).not.toContain('data-account="PanelTwo"');
 expect(padded).not.toContain('data-account="Other"');
 expect(render('   ')).toContain('data-account="Other"');
 expect(render(' missing ')).toContain('No accounts match this filter.');
});

function notifications(){
 const notifySource=shell.slice(shell.indexOf('  const NOTIFY_KEY='),shell.indexOf('  let idleFor='));
 const managerSource=operations.slice(operations.indexOf(' function manager(){'),operations.indexOf(' window.atlasPluginNames='));
 const renderSource=operations.slice(operations.indexOf(' function renderCurrent('),operations.indexOf(' function toast('));
 const doc:any={activeElement:{tagName:'BODY'}};
 let markup='',controls:Record<string,any[]>={},resolvePermission!:(value:string)=>void;
 const body={scrollTop:0,contains:(node:any)=>Object.values(controls).some(list=>list.includes(node)),querySelectorAll:(selector:string)=>selector==='button,summary,[id]'?Object.values(controls).flat():controls[selector]||[],get innerHTML(){return markup;},set innerHTML(value:string){
  if(Object.values(controls).some(list=>list.includes(doc.activeElement)))doc.activeElement={tagName:'BODY'};
  markup=value;controls={};
  for(const attribute of ['data-notify','data-notify-status','data-notify-test','data-notify-cancel']){
   const match=value.match(new RegExp('<[^>]*\\b'+attribute+'(?=[\\s>])[^>]*>'));
   if(match){const node:any={id:match[0].match(/\bid="([^"]*)"/)?.[1]||'',dataset:{},tagName:match[0].match(/^<([\w-]+)/)?.[1]?.toUpperCase(),hidden:/\bhidden\b/.test(match[0]),disabled:/\bdisabled\b/.test(match[0]),checked:/\bchecked\b/.test(match[0]),textContent:'',closest:(selector:string)=>selector==='['+attribute+']',focus:()=>{if(!node.hidden&&!node.disabled)doc.activeElement=node;}};controls['['+attribute+']']=[node];}
  }
 }};
 const storage=new Map<string,string>();
 const N:any=function(){};N.permission='default';
 N.requestPermission=()=>new Promise<string>(resolve=>{resolvePermission=value=>{N.permission=value;resolve(value);};});
 const window:any={Notification:N,atlasOperator:()=>true};
 new Function('window','Notification','localStorage','body','toast',notifySource)(window,N,{getItem:(key:string)=>storage.get(key),setItem:(key:string,value:string)=>storage.set(key,value)},body,()=>{});
 const env:any={window,body,document:doc,api:{selectedPlugin:()=> 'manager'},pluginNames:{fleet:'Fleet'},pluginQuery:'',saved:(_key:string,fallback:any)=>fallback,defaultHidden:[],hiddenHere:()=>false,page:String,title:()=>'',E:escape,button:()=>''};
 const panel=new Function(...Object.keys(env),managerSource+';const views={manager};'+renderSource+';return {open:()=>{body.innerHTML=manager();},refresh:()=>renderCurrent()};')(...Object.values(env));
 let click!:(event:any)=>void;
 const handler=shell.slice(shell.indexOf("  body.addEventListener('click',e=>{if(e.target.closest('[data-notify-test]'))"),shell.indexOf('  hud.onclick='));
 new Function('body','setNotify','testNotify',handler)({addEventListener:(_type:string,callback:any)=>{click=callback;}},window.atlasNotify.set,window.atlasNotify.test);
 return {api:window.atlasNotify,panel,body,active:()=>doc.activeElement,cancel:()=>controls['[data-notify-cancel]']?.[0],clickCancel:()=>click({target:controls['[data-notify-cancel]']?.[0]}),complete:()=>resolvePermission('granted')};
}

test('Configuration keeps pending notification Cancel visible after refresh and navigation',async()=>{
 const h=notifications();h.panel.open();expect(h.cancel().hidden).toBe(true);
 const permission=h.api.set(true);
 try{
  expect(h.cancel().hidden).toBe(false);
  h.cancel().focus();h.panel.refresh();expect(h.cancel().hidden).toBe(false);expect(h.active()).toBe(h.cancel());
  h.body.innerHTML='<p>Another plugin</p>';h.panel.open();expect(h.cancel().hidden).toBe(false);
  h.clickCancel();expect(h.cancel().hidden).toBe(true);expect(h.api.on()).toBe(false);
  h.complete();await permission;
  expect(h.api.on()).toBe(false);h.panel.refresh();expect(h.cancel().hidden).toBe(true);
 }finally{h.complete();await permission;}
});

test('Configuration hides Cancel after a pending permission request completes',async()=>{
 const h=notifications();h.panel.open();const permission=h.api.set(true);
 try{
  h.body.innerHTML='<p>Another plugin</p>';h.panel.open();expect(h.cancel().hidden).toBe(false);
  h.complete();await permission;
  expect(h.api.on()).toBe(true);h.panel.refresh();expect(h.cancel().hidden).toBe(true);
 }finally{h.complete();await permission;}
});
