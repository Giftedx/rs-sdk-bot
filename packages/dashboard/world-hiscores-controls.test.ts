import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const section=(start:string,end:string)=>shell.slice(shell.indexOf(start),shell.indexOf(end,shell.indexOf(start)));
const escapeText=(value:unknown)=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

// A small DOM double for the extracted production renderers. Replacing connected content drops its focus,
// and every HTML write creates new controls; assertions resolve the current logical control after each write.
function page(){
 const doc:any={activeElement:null};
 class Node{
  tagName:string;parentElement:Node|null=null;children:Node[]=[];attrs:Record<string,string>={};dataset:Record<string,string>={};_h?:string;_html='';ownText='';value='';checked=false;scrollTop=0;hidden=false;open=false;
  constructor(tag:string){this.tagName=tag.toUpperCase();}
  get isConnected():boolean{return this===doc.body||!!this.parentElement?.isConnected;}
  get id(){return this.attrs.id||'';}set id(value:string){this.setAttribute('id',value);}
  get className(){return this.attrs.class||'';}set className(value:string){this.setAttribute('class',value);}
  get disabled(){return Object.hasOwn(this.attrs,'disabled');}
  get textContent():string{return this.ownText+this.children.map(child=>child.textContent).join('');}
  getAttribute(key:string){return this.attrs[key]??null;}
  hasAttribute(key:string){return Object.hasOwn(this.attrs,key);}
  setAttribute(key:string,value:string){this.attrs[key]=String(value);if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_m,c)=>c.toUpperCase())]=String(value);if(key==='value')this.value=String(value);if(key==='checked')this.checked=true;}
  contains(node:Node|null):boolean{return !!node&&(this===node||this.children.some(child=>child.contains(node)));}
  matches(selector:string):boolean{
   return selector.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).some(raw=>{
    const s=raw.trim(),attributes=[...s.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
    if(attributes.some(([,key,value])=>!this.hasAttribute(key)||(value!==undefined&&this.getAttribute(key)!==value)))return false;
    const base=s.replace(/\[[^\]]*\]/g,''),tag=/^[a-z]+/i.exec(base)?.[0],id=/#([\w-]+)/.exec(base)?.[1],classes=[...base.matchAll(/\.([\w-]+)/g)].map(match=>match[1]);
    return (!tag||this.tagName===tag.toUpperCase())&&(!id||this.id===id)&&classes.every(name=>this.className.split(/\s+/).includes(name));
   });
  }
  querySelectorAll(selector:string):Node[]{return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector:string){return this.querySelectorAll(selector)[0]||null;}
  closest(selector:string):Node|null{return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
  focus(_options?:unknown){if(this.isConnected&&!this.disabled&&!this.hidden)doc.activeElement=this;}
  remove(){if(this.contains(doc.activeElement))doc.activeElement=doc.body;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}
  append(...nodes:Node[]){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
  replaceChildren(...nodes:Node[]){for(const node of [...this.children])node.remove();this._html='';this.append(...nodes);}
  set innerHTML(value:string){
   this.replaceChildren();this._html=value;const stack:Node[]=[this];let last=0;
   for(const match of value.matchAll(/<\/?([\w-]+)([^>]*)>/g)){
    stack.at(-1)!.ownText+=value.slice(last,match.index);last=match.index!+match[0].length;
    if(match[0].startsWith('</')){if(stack.length>1)stack.pop();continue;}
    const node=new Node(match[1]);for(const attribute of match[2].matchAll(/([^\s=\/]+)(?:="([^"]*)")?/g))node.setAttribute(attribute[1],(attribute[2]||'').replaceAll('&quot;','"').replaceAll('&amp;','&'));
    stack.at(-1)!.append(node);if(!['INPUT','IMG','BR','HR'].includes(node.tagName)&&!match[2].endsWith('/'))stack.push(node);
   }
   stack.at(-1)!.ownText+=value.slice(last);
   for(const select of this.querySelectorAll('select'))select.value=(select.querySelector('option[selected]')||select.querySelector('option'))?.getAttribute('value')||'';
  }
  get innerHTML(){return this._html;}
 }
 doc.body=new Node('body');doc.activeElement=doc.body;doc.createElement=(tag:string)=>new Node(tag);
 doc.querySelector=(selector:string)=>doc.body.querySelector(selector);doc.querySelectorAll=(selector:string)=>doc.body.querySelectorAll(selector);
 const body=new Node('div'),chat=new Node('input');doc.body.append(body,chat);
 const putCode=html.slice(html.indexOf('function put('),html.indexOf("const MARK='"));
 const put=new Function('document','$','CSS',putCode+';return put;')(doc,(selector:string)=>body.querySelector(selector),{escape:(value:string)=>value});
 return {doc,body,chat,put};
}

function world(){
 const p=page();
 const builders=section('  function highlightsBox(){','  // Pickpocket (');
 const finder=section('  function finderFocusState(){','  function finderBox(){');
 const refresh=section('  function refreshWorld(){','  // Bot farms:');
 const marker=section('  function toggleMark(','  // Failure markers:');
 const actionStart=shell.indexOf("if('markHere' in d)"),actions=shell.slice(actionStart,shell.indexOf("else if('markGo' in d",actionStart));
 const hlStart=shell.indexOf('const hk=e.target.dataset?.hl;'),highlight=shell.slice(hlStart,shell.indexOf("if(e.target.matches?.('[data-hl-min]'))",hlStart));
 const colourStart=shell.indexOf("if(e.target.matches?.('[data-mark-colour]'))"),colour=shell.slice(colourStart,shell.indexOf('const sc=',colourStart));
 const env:any={body:p.body,document:p.doc,put:p.put,E:escapeText,nf:String,overlaySync:()=>{},minimap:()=>{},selectedPlugin:'world'};
 const api=new Function(...Object.keys(env),`
  let hl={players:true,groundMin:0},marks=[],markColour='#ffff00',bot={name:'Worker',pos:{x:3200,z:3200,level:0}};
  const MARK_COLOURS=[['#ffff00','Yellow'],['#00ffff','Cyan']],account=()=>bot,saveMarks=()=>{},saveHl=()=>{};
  const worldPanel=()=>highlightsBox()+markersBox()+'<div class="finder-results"></div><input data-finder>';
  ${builders}${finder}${refresh}${marker}
  return {render:refreshWorld,initial:()=>put(body,worldPanel()),setMarks:rows=>{marks=rows;marksChanged();},
   noPosition:()=>{bot={name:'Worker'};},change:e=>{${colour}${highlight}},
   click:control=>{const d=control.dataset,b=account(),p=b?.live||b?.pos;${actions}},
   marks:()=>marks};`)(...Object.values(env));
 api.initial();return {...p,api};
}
const tile=(x:number)=>({x,z:3200,l:0,c:'#ffff00'});

test('a Highlights checkbox retains its logical focus after its checked attribute changes on World refresh',()=>{
 const h=world(),old=h.body.querySelector('[data-hl="players"]')!;old.focus();old.checked=false;h.api.change({target:old});h.api.render();
 const current=h.body.querySelector('[data-hl="players"]')!;expect(current!==old).toBe(true);expect(current.checked).toBe(false);expect(h.doc.activeElement===current).toBe(true);
});

test('marker add and colour changes retain the current logical World control',()=>{
 const h=world(),add=h.body.querySelector('[data-mark-here]')!;add.focus();h.api.click(add);
 expect(h.api.marks()).toHaveLength(1);expect(h.doc.activeElement===h.body.querySelector('[data-mark-here]')).toBe(true);
 const colour=h.body.querySelector('[data-mark-colour]')!;colour.focus();colour.value='#00ffff';h.api.change({target:colour});h.api.render();
 expect(h.doc.activeElement===h.body.querySelector('[data-mark-colour]')).toBe(true);expect(h.doc.activeElement.value).toBe('#00ffff');
});

test('marker actions retain tile identity when array indices change instead of focusing another marker',()=>{
 for(const action of ['go','del']){
  const h=world();h.api.setMarks([tile(3201),tile(3202),tile(3203)]);h.body.querySelector('[data-mark-'+action+'="1"]')!.focus();
  h.api.setMarks([tile(3202),tile(3203)]);
  expect(h.doc.activeElement===h.body.querySelector('[data-mark-'+action+'="0"]')).toBe(true);
 }
});

test('deleting a focused marker or clearing all markers uses a safe surviving control',()=>{
 for(const action of ['del','clear']){
  const h=world();h.api.setMarks([tile(3201),tile(3202),tile(3203)]);
  const active=h.body.querySelector(action==='del'?'[data-mark-del="1"]':'[data-mark-clear]')!;active.focus();h.api.click(active);
  expect(h.doc.activeElement===h.body.querySelector('[data-mark-here]')).toBe(true);
  expect(h.api.marks()).toHaveLength(action==='del'?2:0);
 }
 const h=world();h.api.setMarks([tile(3201)]);h.api.noPosition();const remove=h.body.querySelector('[data-mark-del="0"]')!;remove.focus();h.api.click(remove);
 expect(h.body.querySelector('[data-mark-here]')!.disabled).toBe(true);expect(h.doc.activeElement===h.body.querySelector('[data-mark-colour]')).toBe(true);
});

test('World refresh never takes focus from an outside control',()=>{
 const h=world();h.chat.focus();h.api.setMarks([tile(3201)]);expect(h.doc.activeElement===h.chat).toBe(true);
});

function hiscores(){
 const p=page(),now=1_000_000,S:any={now,bots:[],roster:[['Other',3200,3200,0,50]],world:{connected:true}};
 const env:any={body:p.body,document:p.doc,put:p.put,S,window:{atlasLiveRoster:()=>false},E:escapeText,skills:[],reported:()=>true,realSkill:()=>true,safeName:String,nf:String,whereIs:(x:number,z:number)=>x+','+z,age:(at:number)=>String(now-at),icon:()=>'',Date:class extends Date{static now(){return now;}},boardSummary:()=>'',progressPanel:()=>'',boardGrid:()=>{},rivalsPanel:()=>'<p>Rivals</p>'};
 const results=(shell.split('\n').find(line=>line.startsWith('  const reportedTotal='))??'')+section('  function hiscoreResults(name){','  // Hiscores:');
 const mode=section('  function hiscores(){','  // Where a tile is,');
 const card=section('  function lookupCard(l){','  function refreshWorldLookup(){');
 const hmStart=shell.indexOf("const hm=e.target.closest('[data-hs-mode]')"),hm=shell.slice(hmStart,shell.indexOf("if(e.target.closest('[data-xp-reset]'))",hmStart));
 const api=new Function(...Object.keys(env),`
  let hiscoreName='Other',hiscoreSel=null,sel=null,hiscoresMode='fleet',worldLookup={name:'Other',rows:null,online:true,presenceObservedAt:${now-1000}};
  const boards=document.createElement('div'),parked=document.createElement('div');
  ${results}${mode}${card}
  return {render:mode=>{hiscoresMode=mode;hiscores();},activate:control=>{const e={target:control};${hm}},
   refresh:refreshHiscoreAccount,move:()=>{S.roster=[['Other',3300,3400,0,50]];refreshHiscoreAccount();},
   leave:()=>{S.roster=[];refreshHiscoreAccount();},other:()=>{hiscoreName='Different';worldLookup={...worldLookup,name:'Different'};S.roster=[['Different',3300,3400,0,50]];refreshHiscoreAccount();}};`)(...Object.values(env));
 api.render('fleet');return {...p,api};
}

test('keyboard activation of a Hiscores mode retains that logical mode after the panel is rebuilt',()=>{
 const h=hiscores();
 for(const mode of ['account','rivals','fleet']){
  const before=h.body.querySelector('[data-hs-mode="'+mode+'"]')!;expect(before.tagName).toBe('BUTTON');before.focus();h.api.activate(before);
  const current=h.body.querySelector('[data-hs-mode="'+mode+'"]')!;expect(current!==before).toBe(true);expect(h.doc.activeElement===current).toBe(true);
 }
});

test('an external player action retains its logical name and action when location refresh replaces the card',()=>{
 const h=hiscores();h.api.render('account');const before=h.body.querySelector('[data-world-follow="Other"]')!;before.focus();h.api.move();
 const current=h.body.querySelector('[data-world-follow="Other"]')!;expect(current!==before).toBe(true);expect(h.doc.activeElement===current).toBe(true);
});

test('a vanished or different player action falls back to the existing player-name input',()=>{
 for(const change of ['leave','other']){
  const h=hiscores();h.api.render('account');h.body.querySelector('[data-world-follow="Other"]')!.focus();h.api[change]();
  expect(h.doc.activeElement===h.body.querySelector('#hs-name')).toBe(true);expect(h.doc.activeElement.tagName).toBe('INPUT');
 }
});

test('Hiscores refresh and programmatic mode changes do not steal outside or player-name input focus',()=>{
 const h=hiscores();h.chat.focus();h.api.render('account');expect(h.doc.activeElement===h.chat).toBe(true);h.api.move();expect(h.doc.activeElement===h.chat).toBe(true);
 const input=h.body.querySelector('#hs-name')!;input.focus();input.value='typing';h.api.leave();expect(h.doc.activeElement===input).toBe(true);expect(input.value).toBe('typing');
});
