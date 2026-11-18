import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const operations=readFileSync(new URL('./operations.js',import.meta.url),'utf8');
const stockSource=operations.slice(operations.indexOf(' function stock(){'),operations.indexOf(' function refreshStock(){'));
const renderSource=operations.slice(operations.indexOf(' function renderCurrent('),operations.indexOf(' function toast('));
const moneySource=operations.slice(operations.indexOf(' function moneyPrice('),operations.indexOf(' const stockTabs='));
const buttonSource=operations.slice(operations.indexOf(' const button='),operations.indexOf(' const tasks='));
const moreSource=operations.split('\n').find(line=>line.includes("if(action==='stock-more')"))!;
const escape=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const decode=(value:string)=>value.replaceAll('&quot;','"').replaceAll('&lt;','<').replaceAll('&amp;','&');
const attrs=(markup:string)=>Object.fromEntries([...markup.matchAll(/([\w-]+)="([^"]*)"/g)].map(match=>[match[1],decode(match[2]!)]));

function ledger(count:number){
 const doc:any={body:{tagName:'BODY'},activeElement:null},outside={tagName:'BUTTON'},accounts=[
  {name:'Worker',bankAt:1,bank:Array.from({length:count},(_,i)=>({id:i+100,name:'Supply '+String(i).padStart(3,'0'),count:count-i}))},
  {name:'Other',bankAt:1,bank:[{id:99999,name:'Supply from another account',count:1000}]}];
 let nodes:any[]=[],markup='',refreshes=0;
 const body:any={scrollTop:0,contains:(node:any)=>nodes.includes(node)&&node.isConnected,querySelectorAll:(selector:string)=>selector==='button,summary,[id]'?nodes.filter(node=>node.tagName==='BUTTON'||node.tagName==='SUMMARY'||node.id):[],querySelector:(selector:string)=>selector.startsWith('#')?nodes.find(node=>node.id===selector.slice(1))||null:null};
 Object.defineProperty(body,'innerHTML',{get:()=>markup,set:(html:string)=>{
  if(body.contains(doc.activeElement))doc.activeElement=doc.body;for(const node of nodes)node.isConnected=false;
  nodes=[];markup=html;body.scrollTop=0;
  for(const match of html.matchAll(/<(input|button|select|summary)\b([^>]*)>/g)){
   const a=attrs(match[2]!),tag=match[1]!.toUpperCase();let value=a.value||'';
   if(tag==='SELECT'){const end=html.indexOf('</select>',match.index),options=[...html.slice(match.index,end).matchAll(/<option([^>]*)>/g)],chosen=options.find(option=>/\bselected\b/.test(option[1]!))||options[0];value=chosen?attrs(chosen[1]!).value||'':'';}
   const node:any={tagName:tag,id:a.id||'',dataset:Object.fromEntries(Object.entries(a).filter(([key])=>key.startsWith('data-')).map(([key,v])=>[key.slice(5).replace(/-([a-z])/g,(_m,c)=>c.toUpperCase()),v])),value,isConnected:true,focus:({preventScroll=false}={})=>{if(node.isConnected){doc.activeElement=node;if(!preventScroll)body.scrollTop=0;}}};nodes.push(node);
  }
 }});
 const env={body,document:doc,S:{bots:accounts,economy:{}},window:{},bots:()=>accounts,E:escape,nf:String,gp:String,age:String,safeName:String,icon:()=>'',page:String,title:()=>'',stockTabs:()=>'',refreshStock:()=>{refreshes++;},bestInSlot:()=>'',collectionLog:()=>'',transfers:()=>''};
 const api=new Function(...Object.keys(env),`let stockView='stock',stockAccount='Worker',stockQuery='  Supply  ',stockSort='name',stockLimit=80;const api={selectedPlugin:()=> 'stock'},views={stock};${buttonSource}${moneySource}${stockSource}${renderSource};body.innerHTML=stock();return {more:()=>{const action='stock-more';${moreSource}},refresh:renderCurrent,state:()=>({stockView,stockAccount,stockQuery,stockSort,stockLimit})};`)(...Object.values(env));
 doc.activeElement=outside;
 return {api,doc,body,outside,refreshes:()=>refreshes,html:()=>markup,find:(id:string)=>nodes.find(node=>node.id===id),more:()=>nodes.find(node=>node.dataset.op==='stock-more'),owner:()=>nodes.find(node=>node.dataset.op==='bank-account'),clearBank:()=>{accounts[0]!.bank=[];}};
}

test('Stock final Show more focuses the existing search while keeping the revealed rows, scroll and filter drafts',()=>{
 const l=ledger(81),more=l.more();more.focus();l.body.scrollTop=315;l.api.more();
 expect(l.html()).toContain('Showing 81 of 81 item kinds');expect(l.html()).toContain('Supply 080');expect(l.more()).toBeUndefined();
 expect(l.doc.activeElement).toBe(l.find('op-stock-search'));expect(l.doc.activeElement.isConnected).toBe(true);
 expect(l.body.scrollTop).toBe(315);expect(l.find('op-stock-search').value).toBe('  Supply  ');
 expect(l.find('op-stock-account').value).toBe('Worker');expect(l.find('op-stock-sort').value).toBe('name');
 expect(l.api.state()).toEqual({stockView:'stock',stockAccount:'Worker',stockQuery:'  Supply  ',stockSort:'name',stockLimit:160});
});

test('Stock continues Show more on its logical replacement and uses search only after the final page',()=>{
 const l=ledger(161),first=l.more();first.focus();l.body.scrollTop=420;l.api.more();
 expect(l.html()).toContain('Showing 160 of 161 item kinds');expect(l.more()).toBeDefined();expect(l.more()).not.toBe(first);
 expect(l.doc.activeElement).toBe(l.more());expect(l.body.scrollTop).toBe(420);
 l.api.more();expect(l.html()).toContain('Showing 161 of 161 item kinds');expect(l.more()).toBeUndefined();
 expect(l.doc.activeElement).toBe(l.find('op-stock-search'));expect(l.body.scrollTop).toBe(420);
});

test('Stock pagination never takes focus from an outside control',()=>{
 const l=ledger(81);l.body.scrollTop=220;l.api.more();
 expect(l.doc.activeElement).toBe(l.outside);expect(l.body.scrollTop).toBe(220);expect(l.html()).toContain('Showing 81 of 81 item kinds');
});

test('Periodic Stock refresh leaves uncommitted search and account-filter drafts alone',()=>{
 const l=ledger(81),search=l.find('op-stock-search');search.focus();search.value=' unfinished draft ';l.body.scrollTop=120;l.api.refresh();
 expect(l.find('op-stock-search')).toBe(search);expect(search.value).toBe(' unfinished draft ');expect(l.doc.activeElement).toBe(search);expect(l.refreshes()).toBe(1);
 const account=l.find('op-stock-account');account.focus({preventScroll:true});account.value='Other';l.api.refresh();
 expect(l.find('op-stock-account')).toBe(account);expect(account.value).toBe('Other');expect(l.doc.activeElement).toBe(account);expect(l.body.scrollTop).toBe(120);
 expect(l.api.state().stockQuery).toBe('  Supply  ');expect(l.api.state().stockAccount).toBe('Worker');
});

test('The pagination fallback does not redirect a different removed Stock action',()=>{
 const l=ledger(81);l.owner().focus();l.clearBank();l.api.refresh(true);
 expect(l.doc.activeElement).toBe(l.doc.body);expect(l.doc.activeElement).not.toBe(l.find('op-stock-search'));
});
