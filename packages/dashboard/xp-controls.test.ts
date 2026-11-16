import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
require('./xp-tracker.js');const X=(globalThis as any).atlasXp;
const escape=(v:any)=>String(v??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const extract=(start:string,end:string)=>shell.slice(shell.indexOf(start),shell.indexOf(end,shell.indexOf(start)));

function tracker(){
 let now=1000,stored='{}',bot:any={name:'RangedA',started:1,goalSkill:'Ranged',goalLevel:99,xpPerHour:1000,timeline:'x',skills:[{name:'Ranged',xp:X.xpForLevel(72)+10}]};
 const documentHandlers:any={},windowHandlers:any={},frames=new Map<number,Function>();let frameId=0;
 const doc:any={activeElement:null,addEventListener:(kind:string,fn:any)=>{documentHandlers[kind]=fn;}},outside:any={tagName:'BUTTON'},handlers:any={};let api:any;
 const create=(name:string,parent:any=null)=>{
  const node:any={name,parent,dataset:{},_h:null,markup:'',controls:[],children:{},attributes:{},textContent:'',value:'',isConnected:true};
  Object.defineProperty(node,'defaultValue',{get:()=>node.attributes.value??''});
  node.contains=(target:any)=>{if(target?.isConnected===false)return false;for(let t=target;t;t=t.parent)if(t===node)return true;return false;};
  node.getAttribute=(key:string)=>node.attributes[key]??null;node.hasAttribute=(key:string)=>Object.hasOwn(node.attributes,key);
  node.matches=(selector:string)=>selector.split(',').some(s=>s==='.xp-tracker'?node.name==='panel':s.startsWith('[')&&node.hasAttribute(s.slice(1,-1)));
  node.closest=(selector:string)=>node.matches(selector)?node:node.parent?.closest?.(selector)??null;
  node.focus=()=>{if(node.isConnected&&(node.tagName!=='DIV'||Number(node.attributes.tabindex)>=0))doc.activeElement=node;};
  node.click=()=>api.click({target:node});
  node.querySelectorAll=(selector:string)=>[...node.controls,...Object.values(node.children).flatMap((n:any)=>n.querySelectorAll(selector))].filter((n:any)=>n.matches(selector));
  node.querySelector=(selector:string)=>selector.startsWith('.')?(node.children[selector]??=create(selector,node)):node.querySelectorAll(selector)[0]??null;
  Object.defineProperty(node,'innerHTML',{get:()=>node.markup,set:(html:string)=>{
   if(node.contains(doc.activeElement))doc.activeElement=outside;const disconnect=(n:any)=>{n.isConnected=false;for(const c of n.controls)disconnect(c);for(const c of Object.values(n.children))disconnect(c);};for(const c of node.controls)disconnect(c);for(const c of Object.values(node.children))disconnect(c);node.markup=html;node.controls=[];node.children={};
   for(const m of html.matchAll(/<(button|input|div)\b([^>]*)>/g)){
    const a=Object.fromEntries([...m[2]!.matchAll(/([\w-]+)="([^"]*)"/g)].map(x=>[x[1],x[2]]));
    for(const bare of m[2]!.matchAll(/\s(data-[\w-]+)(?=\s|$|>)/g))a[bare[1]!]='';
    if(!Object.keys(a).some(k=>/^data-(?:calc|xp|best)-/.test(k)))continue;
    const control=create('control',node);control.tagName=m[1]!.toUpperCase();control.attributes=a;control.value=a.value??'';
    control.dataset=Object.fromEntries(Object.entries(a).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_m,c)=>c.toUpperCase()),v]));node.controls.push(control);
   }
  }});return node;
 };
 const panel=create('panel');panel.dataset={};const body={querySelector:()=>panel,addEventListener:(kind:string,fn:any)=>{handlers[kind]=fn;}};
 const xp=extract("  const XP_STORE='atlas-xp-baselines';",'  // Hiscore plugin'),calc=extract('  function calcBox(b,row){',"  const XP_STORE='atlas-xp-baselines';");
 const actions=extract("if(e.target.closest('[data-xp-reset]'))", "const f=e.target.closest('[data-xp-focus]')");
 const bestStart=shell.indexOf("const bp=e.target.closest('[data-best-pin]');"),best=shell.slice(bestStart,shell.indexOf("const pin=e.target.closest('[data-src-pin]')",bestStart));
 const gestures=shell.split('\n').filter(l=>l.startsWith("  body.addEventListener('pointerdown',")||l.startsWith("  document.addEventListener('pointerup',")||l.startsWith("  document.addEventListener('pointercancel',")||l.includes("document.addEventListener('click',finishXpPointer")||l.includes("window.addEventListener('blur',finishXpPointer")).join('\n');
 const change=shell.split('\n').find(l=>l.startsWith("  body.addEventListener('change',e=>"))!,keys=shell.split('\n').find(l=>l.startsWith("  body.addEventListener('keydown',"))!;
 const env:any={body,account:()=>bot,window:{atlasXp:X,atlasOperator:()=>true,addEventListener:(kind:string,fn:any)=>{windowHandlers[kind]=fn;}},Date:{now:()=>now},localStorage:{getItem:()=>stored,setItem:(_k:string,v:string)=>{stored=v;}},document:doc,
  requestAnimationFrame:(fn:Function)=>{frames.set(++frameId,fn);return frameId;},cancelAnimationFrame:(id:number)=>frames.delete(id),bestSpot:()=>({name:'Iron rock',tiles:[{x:3000,z:3000,l:0}]}),overlaySync:()=>{},minimap:()=>{},toast:()=>{},
  put:(node:any,html:string)=>{if(node._h!==html){node._h=html;node.innerHTML=html;}},E:escape,safeName:String,nf:String,dur:String,efficiencyBox:()=>'<div>'+bot.timeline+'</div>',asset:String,skillFile:String,
  icon:()=>'',bestSpotLine:()=>'<button data-best-pin="Iron rock">Show on map</button>',S:{bots:[]}};
 api=new Function(...Object.keys(env),`let calcSkill=null,calcTarget=null,calcAccount=null,xpHideMaxed=false,xpSort='rate',sel='RangedA',sourcePin=null,finderPick=null,finderPlayer=null;const skillActions=null;${calc}${xp}${change}${keys}${gestures};return {refreshXp,click:e=>{if(e.target.closest('[data-best-pin]')){(e=>{${best}})(e);return;}${actions}},pick:s=>{calcSkill=s;refreshXp();},selected:()=>({calcSkill,calcTarget,sourcePin})};`)(...Object.values(env));
 const find=(attr:string,value?:string)=>panel.querySelectorAll('['+attr+']').find((n:any)=>value===undefined||n.getAttribute(attr)===value);
 const key=(node:any,key:string)=>{let prevented=false;handlers.keydown({target:node,key,preventDefault:()=>{prevented=true;}});return prevented;};
 const update=(next:any)=>{bot=next;now+=60_000;api.refreshXp();};
 doc.activeElement=outside;api.refreshXp();return{api,panel,doc,outside,find,key,bot:()=>bot,update,stored:()=>JSON.parse(stored),frame:()=>{const pending=[...frames.values()];frames.clear();for(const fn of pending)fn();},down:(target:any)=>handlers.pointerdown?.({button:0,isPrimary:true,pointerId:1,target}),up:(target:any,click=true)=>{documentHandlers.pointerup?.({pointerId:1});if(click){if(target.isConnected)target.click();documentHandlers.click?.();}},cancel:()=>documentHandlers.pointercancel?.({pointerId:1}),blur:()=>windowHandlers.blur?.(),focus:(attr:string,value?:string)=>{const n=find(attr,value);n?.focus();return n;},change:(node:any)=>handlers.change({target:node})};
}

test('XP skill disclosures work with Enter and Space and retain focus through a live redraw',()=>{
 const t=tracker(),row=t.focus('data-calc-skill','Ranged');expect(row.attributes.tabindex).toBe('0');expect(row.attributes.role).toBe('button');expect(row.attributes['aria-expanded']).toBe('false');
 expect(t.key(row,'Enter')).toBe(true);expect(t.find('data-calc-close')).toBeDefined();expect(t.doc.activeElement).toBe(t.find('data-calc-skill','Ranged'));
 t.update({...t.bot(),timeline:'xx',skills:[{name:'Ranged',xp:t.bot().skills[0].xp+50}]});expect(t.doc.activeElement).toBe(t.find('data-calc-skill','Ranged'));
 expect(t.key(t.find('data-calc-skill','Ranged'),' ')).toBe(true);expect(t.find('data-calc-close')).toBeUndefined();
});

test('calculator draft survives periodic refresh but native Enter and change recompute committed targets at once',()=>{
 const t=tracker();t.api.pick('Ranged');const input=t.focus('data-calc-target');input.value='74';
 t.update({...t.bot(),timeline:'xx'});expect(t.doc.activeElement).toBe(input);expect(input.value).toBe('74');
 expect(t.key(input,'Enter')).toBe(true);expect(t.panel.querySelector('.xp-calc').markup).toContain('<b>'+String(X.xpForLevel(74)-t.bot().skills[0].xp)+'</b> xp left');expect(t.doc.activeElement).toBe(t.find('data-calc-target'));
 const changed=t.find('data-calc-target');changed.value='75';t.change(changed);expect(t.panel.querySelector('.xp-calc').markup).toContain('<b>'+String(X.xpForLevel(75)-t.bot().skills[0].xp)+'</b> xp left');expect(t.doc.activeElement).toBe(t.find('data-calc-target'));
});

test('empty Enter restores the visible goal target when the calculator markup is already cached',()=>{
 const t=tracker();t.api.pick('Ranged');const input=t.focus('data-calc-target');
 expect(input.value).toBe('99');
 const initial=t.panel.querySelector('.xp-calc').markup;
 input.value='';expect(t.panel.querySelector('.xp-calc').markup).toBe(initial);
 expect(t.key(input,'Enter')).toBe(true);
 const visible=t.find('data-calc-target');
 expect(visible).toBe(input);expect(visible.value).toBe('99');expect(visible.isConnected).toBe(true);expect(t.doc.activeElement).toBe(visible);
 expect(t.panel.querySelector('.xp-calc').markup).toContain('<b>'+String(X.xpForLevel(99)-t.bot().skills[0].xp)+'</b> xp left');
});

test('a focused draft cannot retain another account or a removed or unreported XP skill',()=>{
 const t=tracker();t.api.pick('Ranged');t.focus('data-calc-target').value='74';
 t.update({name:'RangedB',started:1,timeline:'x',goalSkill:'Ranged',xpPerHour:100,skills:[{name:'Ranged',xp:0}]});
 expect(t.panel.querySelector('.xp-account').textContent).toBe('RangedB');expect(t.panel.querySelector('.xp-calc').markup).toContain('Current <b>1</b>');expect(t.find('data-calc-target').value).not.toBe('74');
 for(const skills of [[],[{name:'Ranged'}],[{name:'Ranged',xp:NaN}]]){
  const u=tracker();u.api.pick('Ranged');u.focus('data-calc-target');u.update({...u.bot(),skills});expect(u.find('data-calc-target')).toBeUndefined();expect(u.doc.activeElement).toBe(u.find('data-xp-pause'));
 }
 for(const hidden of [false,true]){
  const u=tracker();u.api.pick('Ranged');if(hidden){const h=u.focus('data-xp-hide-maxed');h.checked=true;h.click();}u.focus('data-calc-target').value='74';
  u.update({...u.bot(),skills:[{name:'Ranged',xp:X.xpForLevel(99)+10}]});expect(u.find('data-calc-target')).toBeUndefined();expect(u.panel.querySelector('.xp-calc').markup).toContain('99 · complete');expect(u.doc.activeElement).toBe(u.find(hidden?'data-xp-pause':'data-calc-skill'));
 }
});

test('reopening the same account calculator retains its committed target after its view is rebuilt',()=>{
 const t=tracker();t.api.pick('Ranged');const target=t.focus('data-calc-target');target.value='74';t.key(target,'Enter');
 t.doc.activeElement=t.outside;t.panel.innerHTML='';t.panel._h=null;t.panel.dataset={};t.api.refreshXp();expect(t.find('data-calc-target').value).toBe('74');expect(t.doc.activeElement).toBe(t.outside);
});

test('Close, Pause, Reset, Hide maxed and best-pin redraws retain meaningful focus when rows vanish',()=>{
 const t=tracker();t.api.pick('Ranged');t.focus('data-calc-close').click();expect(t.doc.activeElement).toBe(t.find('data-calc-skill','Ranged'));
 t.api.pick('Ranged');const pin=t.focus('data-best-pin');t.update({...t.bot(),timeline:'xxx'});expect(t.doc.activeElement).toBe(t.find('data-best-pin'));expect(t.doc.activeElement).not.toBe(pin);
 for(const attr of ['data-xp-pause','data-xp-reset']){t.focus(attr).click();expect(t.doc.activeElement).toBe(t.find(attr));}
 expect(t.panel.querySelector('.xp-calc').markup).toContain('Current <b>72</b>');
 const max=tracker();max.update({...max.bot(),skills:[{name:'Ranged',xp:X.xpForLevel(99)+10}]});max.api.pick('Ranged');const hide=max.focus('data-xp-hide-maxed');hide.checked=true;hide.click();expect(max.doc.activeElement).toBe(max.find('data-xp-hide-maxed'));expect(max.find('data-calc-skill','Ranged')).toBeUndefined();
 max.focus('data-calc-close').click();expect(max.doc.activeElement).toBe(max.find('data-xp-pause'));
});

test('outside focus stays outside during XP context changes and a known no-gain skill still has a calculator',()=>{
 const t=tracker();t.api.pick('Ranged');t.focus('data-xp-reset').click();expect(t.panel.querySelector('.xp-calc').markup).toContain('Current <b>72</b>');
 t.doc.activeElement=t.outside;t.update({...t.bot(),timeline:'xxx',goalSkill:null,xpPerHour:0});expect(t.find('data-calc-skill','Ranged')).toBeUndefined();expect(t.panel.querySelector('.xp-calc').markup).toContain('Current <b>72</b>');expect(t.doc.activeElement).toBe(t.outside);
});

test('dirty-input mouse actions survive blur and a refresh while the pointer stays held',()=>{
 for(const action of ['data-calc-close','data-xp-pause','data-xp-reset','data-best-pin']){
  const t=tracker();t.api.pick('Ranged');const input=t.focus('data-calc-target'),button=t.find(action);input.value='74';
  t.down(button);t.change(input);button.focus();t.update({...t.bot(),timeline:'held pointer'});t.frame();expect(button.isConnected).toBe(true);expect(t.find(action)).toBe(button);
  t.up(button);t.frame();
  if(action==='data-calc-close'){expect(t.find('data-calc-close')).toBeUndefined();expect(t.doc.activeElement).toBe(t.find('data-calc-skill','Ranged'));}
  else{
   expect(t.panel.querySelector('.xp-calc').markup).toContain('<b>'+String(X.xpForLevel(74)-t.bot().skills[0].xp)+'</b> xp left');expect(t.doc.activeElement).toBe(t.find(action));
   if(action==='data-xp-pause')expect(t.find(action).textContent).toBe('Resume');
   if(action==='data-xp-reset')expect(t.stored().RangedA.at).toBe(61_000);
   if(action==='data-best-pin')expect(t.api.selected().sourcePin?.key).toBe('best|Iron rock');
  }
 }
});

test('pointer cancellation, window blur or release without a click leaves XP ready for later input',()=>{
 for(const finish of ['cancel','release','blur']){
  const t=tracker();t.api.pick('Ranged');const input=t.focus('data-calc-target'),button=t.find('data-calc-close');input.value='74';t.down(button);t.change(input);button.focus();
  if(finish==='cancel')t.cancel();else if(finish==='blur')t.blur();else t.up(button,false);t.frame();
  expect(t.panel.querySelector('.xp-calc').markup).toContain('<b>'+String(X.xpForLevel(74)-t.bot().skills[0].xp)+'</b> xp left');t.update({...t.bot(),timeline:'after release'});expect(t.find('data-calc-close').isConnected).toBe(true);
 }
});
