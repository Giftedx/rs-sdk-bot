import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const operations=readFileSync(new URL('./operations.js',import.meta.url),'utf8');
const slice=(start:string,end:string)=>operations.slice(operations.indexOf(start),operations.indexOf(end,operations.indexOf(start)));
const savedSource=slice(' const saved=',' let meta=');
const managerSource=slice(' function manager(){',' window.atlasPluginNames=');
const pinsSource=slice('function applyPins(){',' function setWidth(');
const changeSource=slice(" body.addEventListener('change',", " body.addEventListener('submit',async");
const submitSource=slice(" body.addEventListener('submit',async", " app.addEventListener('click',async");
const commandSource=slice(' async function command(',' function draftFromForm(){');
const draftSource=slice(' function draftFromForm(){'," body.addEventListener('input',");
const dispatchSource=slice(' function dispatch(){',' const defaultHidden=');
const escape=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const decode=(value:string)=>value.replaceAll('&quot;','"').replaceAll('&lt;','<').replaceAll('&amp;','&');
const attributes=(markup:string)=>Object.fromEntries([...markup.matchAll(/([\w-]+)="([^"]*)"/g)].map(match=>[match[1],decode(match[2]!)]));

function submissions(initialDraft:Record<string,string>={}){
 const savedDraft={kind:'override-account',account:'Worker',activityId:'fixture',durationMin:'30',reason:'Operator focus on fixture',...initialDraft};
 const storage=new Map<string,string>([['atlas.ops.draft',JSON.stringify(savedDraft)]]),toasts:string[]=[],requests:any[]=[],handlers:any={};
 let plugin='dispatch',view:any,api:any,uuid=0;
 const doc:any={body:{tagName:'BODY'},activeElement:null};
 const connect=(node:any)=>{node.isConnected=true;node.view=view;for(const child of node.children||[])connect(child);};
 const node=(tag:string,a:Record<string,string>={})=>{
  const n:any={tagName:tag,id:a.id||'',attributes:a,dataset:{},children:[],textContent:'',isConnected:false,removed:false,
   setAttribute:(key:string,value:string)=>{n.attributes[key]=value;},getAttribute:(key:string)=>n.attributes[key]??null,
   remove:()=>{n.removed=true;n.isConnected=false;},focus:()=>{if(n.isConnected)doc.activeElement=n;},
   contains:(target:any)=>target===n||n.children.some((child:any)=>child.contains?.(target)),
   append:(...children:any[])=>{n.children.push(...children);if(n.isConnected)for(const child of children)connect(child);},
   after:(...children:any[])=>{if(n.isConnected){view.nodes.push(...children);for(const child of children)connect(child);}}};
  return n;
 };
 const all=()=>{const collect=(n:any):any[]=>[n,...n.children.flatMap(collect)];return (view?.nodes||[]).flatMap(collect).filter((n:any)=>n.isConnected&&!n.removed);};
 const matches=(n:any,selector:string)=>{
  if(selector.startsWith('#'))return n.id===selector.slice(1);
  const attr=selector.match(/^\[([^=\]]+)(?:=["']?([^\]"']*)["']?)?\]$/);return !!attr&&Object.hasOwn(n.attributes,attr[1]!)&&(attr[2]===undefined||n.attributes[attr[1]!]===attr[2]);
 };
 const install=(html:string)=>{
  if(view){for(const n of all())n.isConnected=false;}view={html,nodes:[],appended:[]};body.dataset.plugin=plugin;
  if(plugin==='dispatch'){
   const form=node('FORM',{id:'op-dispatch'}),input=node('TEXTAREA',{name:'reason'}),match=html.match(/<button\b([^>]*type="submit"[^>]*)>([^<]*)<\/button>/)!;
   const submit=node('BUTTON',{type:'submit'});submit.disabled=/\bdisabled\b/.test(match[1]!);submit.textContent=match[2];form.fields={...api.state().draft};input.value=form.fields.reason;
   const selects=[...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)].map(match=>{
    const a=attributes(match[1]!),select=node('SELECT',a),options=[...match[2]!.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)];
    const selected=options.find(option=>/\bselected\b/.test(option[1]!))||options[0];select.name=a.name;select.value=selected?(attributes(selected[1]!).value??decode(selected[2]!)):'';select.closest=(selector:string)=>selector==='#op-dispatch'?form:null;return select;
   });
   form.submit=submit;form.input=input;form.selects=selects;form.children=[input,submit,...selects];form.querySelector=(selector:string)=>selector==='[type=submit]'?submit:selects.find(select=>matches(select,selector))||null;view.form=form;view.nodes.push(form);
   for(const status of html.matchAll(/<(?:div|p)\b([^>]*role="status"[^>]*)>([^<]*)/g)){const n=node('DIV',attributes(status[1]!));n.textContent=decode(status[2]!);view.nodes.push(n);}
  }else{
   const status=node('P',{id:'stock-count',role:'status'});status.textContent='Showing 80 of 81 item kinds';const input=node('INPUT',{id:'op-stock-search'});input.value='kept stock draft';view.nodes.push(status,input);view.input=input;
  }
  for(const n of view.nodes)connect(n);if(doc.activeElement===null)doc.activeElement=view.form?.input||view.input;
 };
 const body:any={dataset:{plugin},addEventListener:(type:string,handler:any)=>{handlers[type]=handler;},contains:(n:any)=>!!n?.isConnected&&n.view===view,
  querySelector:(selector:string)=>selector.startsWith('#op-dispatch ')?view.form?.querySelector(selector.slice('#op-dispatch '.length))||null:all().find((n:any)=>matches(n,selector))||null,
  append:(...nodes:any[])=>{view.appended.push(...nodes);view.nodes.push(...nodes);for(const n of nodes)connect(n);}};
 Object.defineProperty(body,'innerHTML',{get:()=>view?.html||'',set:(html:string)=>{if(body.contains(doc.activeElement))doc.activeElement=doc.body;install(html);}});
 const fakeFetch=(_url:string,init:any)=>new Promise<Response>((resolve,reject)=>{requests.push({input:JSON.parse(init.body),resolve,reject});});
 const env={body,document:{...doc,createElement:(tag:string)=>node(tag.toUpperCase())},$:body.querySelector,localStorage:{getItem:(key:string)=>storage.get(key),setItem:(key:string,value:string)=>storage.set(key,value)},
  FormData:class{constructor(public form:any){}*[Symbol.iterator](){yield* Object.entries({...this.form.fields,...Object.fromEntries(this.form.selects.map((select:any)=>[select.name,select.value]))});}},fetch:fakeFetch,crypto:{randomUUID:()=>String(++uuid).repeat(8)+'-1111-4111-8111-111111111111'},
  toast:(message:string)=>toasts.push(message),loadMeta:async()=>{},renderCurrent:()=>{if(plugin==='dispatch')body.innerHTML=api.html();},api:{selectedPlugin:()=>plugin},
  page:String,title:()=>'',E:escape,caps:()=>[{id:'fixture'},{id:'other-fixture'}],tasks:()=>[],bots:()=>[{name:'Worker',reserved:false,remote:false}],recentCommands:()=>'',library:()=>'<p id="fixture-library-status" role="status">1 fixture capability</p>'};
 Object.defineProperty(env.document,'activeElement',{get:()=>doc.activeElement});
 api=new Function(...Object.keys(env),`${savedSource}\nlet meta={nonce:'fixture',readOnly:false},submitting=false,message='',pendingQueue=saved('pending-queue',null),draft=saved('draft',{});\n${dispatchSource}${commandSource}${draftSource}${changeSource}${submitSource}\nreturn {html:dispatch,state:()=>({draft:{...draft},pendingQueue,submitting,message}),saveDraft:draftFromForm};`)(...Object.values(env));
 install(api.html());
 return {api,doc,requests,toasts,storage,form:()=>view.form,library:()=>all().find((n:any)=>n.id==='fixture-library-status'),stockStatus:()=>all().find((n:any)=>n.id==='stock-count'),appended:()=>view.appended,messages:()=>all().filter((n:any)=>n.attributes.role==='status'&&!['fixture-library-status','stock-count'].includes(n.id)).map((n:any)=>n.textContent),
  submit:()=>handlers.submit({target:view.form,preventDefault(){}}),open:(id:string)=>{plugin=id;install(id==='dispatch'?api.html():'Stock');doc.activeElement=view.form?.input||view.input;},
  select:(name:string)=>view.form.querySelector('[name="'+name+'"]'),change:(name:string,value:string,focused=true)=>{const target=view.form.querySelector('[name="'+name+'"]');target.value=value;if(focused)target.focus();handlers.change({target});},
  edit:(reason:string)=>{view.form.fields.reason=reason;view.form.input.value=reason;api.saveDraft();},
  succeed:(index:number)=>requests[index].resolve(Response.json({status:'submitted'})),fail:(index:number)=>requests[index].reject(Error('Fixture submission failed'))};
}

test('Deferred Jobs success leaves a focused Stock view untouched and restores the completed Jobs form on return',async()=>{
 const s=submissions(),pending=s.submit(),id=s.requests[0].input.id;s.open('stock');const status=s.stockStatus(),active=s.doc.activeElement;
 s.succeed(0);await pending;
 expect(status.isConnected).toBe(true);expect(s.appended()).toEqual([]);expect(s.doc.activeElement).toBe(active);expect(active.value).toBe('kept stock draft');
 expect(s.toasts.some(message=>message.includes('Submitted '+id))).toBe(true);expect(s.api.state().pendingQueue).toBeNull();
 expect(JSON.parse(s.storage.get('atlas.ops.draft')!)).toEqual(s.api.state().draft);
 s.open('dispatch');expect(s.form().submit.disabled).toBe(false);expect(s.form().submit.textContent).toBe('Send to Fleet Brain');expect(s.api.html()).toContain('Submitted '+id);
});

test('Deferred Jobs failure preserves the other panel, saved draft and stable pending identity for a retry',async()=>{
 const s=submissions(),pending=s.submit(),id=s.requests[0].input.id,draft=s.api.state().draft;s.open('stock');const status=s.stockStatus(),active=s.doc.activeElement;
 s.fail(0);await pending;
 expect(status.isConnected).toBe(true);expect(s.appended()).toEqual([]);expect(s.doc.activeElement).toBe(active);expect(s.toasts).toContain('Fixture submission failed');
 expect(s.api.state().draft).toEqual(draft);expect(s.api.state().pendingQueue.id).toBe(id);expect(JSON.parse(s.storage.get('atlas.ops.pending-queue')!).id).toBe(id);
 s.open('dispatch');expect(s.form().submit.disabled).toBe(false);expect(s.form().submit.textContent).toBe('Send to Fleet Brain');expect(s.api.html()).toContain('Fixture submission failed');
 const retry=s.submit();expect(s.requests[1].input.id).toBe(id);expect(s.requests[1].input).toEqual(s.requests[0].input);s.succeed(1);await retry;
});

for(const success of [true,false])test('A replacement Jobs form retains its draft, focus and independent status after deferred '+(success?'success':'failure'),async()=>{
 const s=submissions(),original=s.form(),pending=s.submit();s.open('stock');s.open('dispatch');
 const replacement=s.form(),library=s.library(),active=s.doc.activeElement;expect(replacement).not.toBe(original);expect(replacement.submit.disabled).toBe(true);expect(replacement.submit.textContent).toBe('Submitting…');
 s.edit('A different unsent draft in the replacement form');
 if(success)s.succeed(0);else s.fail(0);await pending;
 expect(s.form()).toBe(replacement);expect(replacement.input.value).toBe('A different unsent draft in the replacement form');expect(s.doc.activeElement).toBe(active);
 expect(library.isConnected).toBe(true);expect(library.textContent).toBe('1 fixture capability');
 expect(replacement.submit.disabled).toBe(false);expect(replacement.submit.textContent).toBe('Send to Fleet Brain');expect(s.api.state().message).toContain(success?'Submitted':'Fixture submission failed');
 expect(s.messages().some((message:string)=>message.includes(success?'Submitted':'Fixture submission failed'))).toBe(true);
 expect(JSON.parse(s.storage.get('atlas.ops.draft')!).reason).toBe('A different unsent draft in the replacement form');
});

test('Jobs Work type changes retain the logical selector focus and unsent draft through consecutive rebuilds',()=>{
 const s=submissions(),reason=s.api.state().draft.reason;
 for(const kind of ['clear-defect','override-account']){
  const previous=s.select('kind');s.change('kind',kind);
  expect(s.select('kind')).not.toBe(previous);expect(s.select('kind').value).toBe(kind);expect(s.doc.activeElement).toBe(s.select('kind'));
  expect(s.api.state().draft).toMatchObject({kind,activityId:'fixture',reason});
  expect(JSON.parse(s.storage.get('atlas.ops.draft')!)).toMatchObject({kind,activityId:'fixture',reason});
 }
});

test('Jobs activityId changes retain selector focus and unsent draft',()=>{
 const s=submissions(),reason=s.api.state().draft.reason;
 s.change('activityId','other-fixture');
 expect(s.doc.activeElement).toBe(s.select('activityId'));expect(s.select('activityId').value).toBe('other-fixture');
 expect(s.api.state().draft).toMatchObject({kind:'override-account',activityId:'other-fixture',reason});
 s.change('activityId','fixture');expect(s.doc.activeElement).toBe(s.select('activityId'));expect(s.select('activityId').value).toBe('fixture');
});

test('Jobs selector changes do not steal outside focus when the changed field did not hold it',()=>{
 const s=submissions(),outside={id:'outside-control'};s.doc.activeElement=outside;
 s.change('kind','clear-defect',false);expect(s.api.state().draft.kind).toBe('clear-defect');expect(s.doc.activeElement).toBe(outside);
 s.change('activityId','other-fixture',false);expect(s.api.state().draft.activityId).toBe('other-fixture');expect(s.doc.activeElement).toBe(outside);
});

function preferences(hidden:any){
 const draft={kind:'run',account:'Worker',extra:'{"args":["kept"]}',why:'Existing unsent draft'},storage=new Map([['atlas.ops.hidden',JSON.stringify(hidden)],['atlas.ops.draft',JSON.stringify(draft)]]);
 const buttons=['ge','raw','future-plugin'].map(id=>({dataset:{clientPlugin:id},hidden:false}));let change:any;
 const env={localStorage:{getItem:(key:string)=>storage.get(key),setItem:(key:string,value:string)=>storage.set(key,value)},defaultHidden:['raw'],pluginQuery:'',pluginNames:{ge:'Grand Exchange',raw:'Raw evidence',manager:'Configuration'},
  page:String,title:()=>'',hiddenHere:()=>false,window:{atlasOperator:()=>true},E:escape,button:()=>'',rail:{querySelectorAll:()=>buttons},api:{selectedPlugin:()=> 'manager'},body:{addEventListener:(_type:string,handler:any)=>{change=handler;}}};
 const api=new Function(...Object.keys(env),`${savedSource}${managerSource}${pinsSource}${changeSource};return {manager,applyPins,draft:()=>saved('draft',{})};`)(...Object.values(env));
 return {api,buttons,draft,storage,pin:(id:string,checked:boolean)=>change({target:{dataset:{pin:id},checked,closest:()=>null}})};
}

test('Wrong-shaped hidden-plugin preferences fall back safely in Configuration, startup pins and pin changes only',()=>{
 for(const hidden of [{},'ge',42]){
  const p=preferences(hidden);expect(()=>p.api.manager()).not.toThrow();expect(()=>p.api.applyPins()).not.toThrow();
  expect(p.buttons.map(button=>[button.dataset.clientPlugin,button.hidden])).toEqual([['ge',false],['raw',true],['future-plugin',false]]);
  expect(p.api.manager()).toMatch(/data-pin="ge" checked/);expect(p.api.manager()).not.toMatch(/data-pin="raw" checked/);
  expect(()=>p.pin('ge',false)).not.toThrow();expect(JSON.parse(p.storage.get('atlas.ops.hidden')!)).toEqual(['raw','ge']);
  expect(p.api.draft()).toEqual(p.draft);expect(JSON.parse(p.storage.get('atlas.ops.draft')!)).toEqual(p.draft);
 }
});

test('Valid hidden-plugin arrays retain string IDs, including unknown future plugins, without changing saved drafts',()=>{
 const p=preferences(['ge','future-plugin']);p.api.applyPins();
 expect(p.buttons.map(button=>button.hidden)).toEqual([true,false,true]);expect(p.api.manager()).not.toMatch(/data-pin="ge" checked/);
 p.pin('raw',false);expect(JSON.parse(p.storage.get('atlas.ops.hidden')!)).toEqual(['ge','future-plugin','raw']);
 p.pin('ge',true);expect(JSON.parse(p.storage.get('atlas.ops.hidden')!)).toEqual(['future-plugin','raw']);expect(p.api.draft()).toEqual(p.draft);
});
