import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const start=shell.indexOf("  // Screenshot (RuneLite's Screenshot plugin)"),end=shell.indexOf('  // Tick efficiency (one box under Overall',start);
if(start<0||end<0)throw Error('Screenshot storage source section is missing');
const source=shell.slice(start,end);
type Shot={id:string;at:number;name:string;kind:string;text:string;url:string};
const shot=(id:string,at:number):Shot=>({id,at,name:'StorageProbe',kind:'level',text:'Level '+at,url:'data:image/jpeg;base64,AAAA'});
const ids=(rows:Shot[])=>rows.map(row=>row.id);
const latest=(rows:Shot[])=>[...new Map(rows.map(row=>[row.id,row])).values()].sort((a,b)=>b.at-a.at||(a.id<b.id?-1:a.id>b.id?1:0)).slice(0,60);

// Connections share one store. Request callbacks are asynchronous; overlapping write transactions serialize.
function storage(seed:Shot[]=[]){
 let records=new Map(seed.map(row=>[row.id,structuredClone(row)])),active:any=null,holdRead=false,blocked:(()=>void)|null=null;
 const jobs:Array<()=>void>=[],waiting:any[]=[],connections:any[]=[];
 const model={unavailable:false,failNextPut:false};
 const event=(target:any)=>({target,preventDefault(){},stopPropagation(){}});
 const sorted=(map:Map<string,Shot>)=>[...map.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(row=>structuredClone(row));
 const releaseConnection=(db:any)=>{if(db.closeRequested&&db.transactions.every((tx:any)=>tx.finished))db.closed=true;};
 function finish(tx:any,ok:boolean){
  if(tx.finished)return;
  tx.finished=true;if(ok&&tx.mode==='readwrite')records=tx.rows;
  active=null;if(ok)tx.oncomplete?.(event(tx));else tx.onabort?.(event(tx));
  releaseConnection(tx.db);kick();
 }
 function queue(tx:any){
  if(active!==tx||tx.finished||tx.scheduled||tx.busy)return;tx.scheduled=true;
  jobs.push(()=>{tx.scheduled=false;pump(tx);});
 }
 function pump(tx:any){
  if(active!==tx||tx.finished||tx.busy)return;
  const op=tx.requests.shift();
  if(!op){finish(tx,true);return;}
  tx.busy=true;
  const deliver=()=>{
   if(tx.finished)return;
   if(op.kind==='put'&&model.failNextPut){
    model.failNextPut=false;op.request.error=new Error('QuotaExceededError');tx.error=op.request.error;
    op.request.onerror?.(event(op.request));tx.onerror?.(event(tx));tx.busy=false;finish(tx,false);return;
   }
   if(op.kind==='getAll')op.request.result=sorted(tx.rows);
   else if(op.kind==='getAllKeys')op.request.result=sorted(tx.rows).map(row=>row.id);
   else if(op.kind==='put'){tx.rows.set(op.value.id,structuredClone(op.value));op.request.result=op.value.id;}
   else if(op.kind==='delete')tx.rows.delete(op.key);
   else if(op.kind==='clear')tx.rows.clear();
   op.request.onsuccess?.(event(op.request));tx.busy=false;queue(tx);
  };
  if(holdRead&&tx.mode==='readonly'&&op.kind==='getAll'){holdRead=false;blocked=deliver;}else deliver();
 }
 function kick(){
  if(active||!waiting.length)return;active=waiting.shift();active.rows=new Map([...records].map(([id,row])=>[id,structuredClone(row)]));queue(active);
 }
 const indexedDB={open:()=>{
  const request:any={};jobs.push(()=>{
   if(model.unavailable){request.error=new Error('IndexedDB unavailable');request.onerror?.(event(request));return;}
   const db:any={transactions:[],closeRequested:false,closed:false,close(){this.closeRequested=true;releaseConnection(this);},createObjectStore(){}};
   db.transaction=(_name:string,mode='readonly')=>{
    if(db.closeRequested)throw Error('Connection is closing');
    const tx:any={db,mode,requests:[],finished:false,busy:false,scheduled:false};
    const add=(kind:string,value?:any)=>{if(tx.finished)throw Error('Transaction is inactive');const r:any={};tx.requests.push({kind,request:r,...(kind==='put'?{value:structuredClone(value)}:kind==='delete'?{key:value}:{})});queue(tx);return r;};
    const store={getAll:()=>add('getAll'),getAllKeys:()=>add('getAllKeys'),put:(value:Shot)=>add('put',value),delete:(key:string)=>add('delete',key),clear:()=>add('clear')};
    tx.objectStore=()=>store;db.transactions.push(tx);waiting.push(tx);kick();return tx;
   };
   connections.push(db);request.result=db;request.onsuccess?.(event(request));
  });return request;
 }};
 return {indexedDB,model,connections,rows:()=>sorted(records),
  holdNextRead:()=>{holdRead=true;},held:()=>blocked!==null,
  releaseRead:()=>{if(!blocked)throw Error('No delayed IndexedDB read');const release=blocked;blocked=null;jobs.unshift(release);},
  flush:async()=>{let idle=0;for(let step=0;step<1000;step++){await Promise.resolve();const job=jobs.shift();if(job){idle=0;job();}else if(++idle>=20)return;}throw Error('IndexedDB model did not settle');}
 };
}

function gallery(db:ReturnType<typeof storage>){
 const body={},bot={name:'StorageProbe'},window:any={atlasOperator:()=>true,atlasPlugins:{activity:{render:()=>{}}}};
 const env:any={localStorage:{getItem:()=>null,setItem:()=>{}},indexedDB:db.indexedDB,VIEWER:{state:'ready'},$:()=>({contentWindow:{postMessage:()=>{}}}),location:{origin:'https://dashboard.invalid'},account:()=>bot,gp:String,selectedPlugin:'activity',window,body,price:()=>null,priceKey:(item:any)=>item.id,setTimeout:()=>0,clearTimeout:()=>{}};
 const api=new Function(...Object.keys(env),`${source};return {saveShot,shotReply,list:()=>shots,pending:(id,meta)=>pendingShots.set(id,meta)};`)(...Object.values(env));
 return {save:api.saveShot,list:api.list,capture:(s:Shot)=>{const {id,url,...meta}=s;api.pending(id,meta);api.shotReply({id,url});}};
}

test('delayed startup gallery hydration merges a capture received while IndexedDB is loading',async()=>{
 const old=shot('old',10),fresh=shot('fresh',20),db=storage([old]);db.holdNextRead();const ui=gallery(db);await db.flush();expect(db.held()).toBe(true);
 ui.capture(fresh);expect(ids(ui.list())).toEqual(['fresh']);db.releaseRead();await db.flush();
 expect(ui.list()).toEqual([fresh,old]);expect(latest(db.rows())).toEqual([fresh,old]);
});

test('a second tab saving a screenshot preserves the first tab capture in the shared store',async()=>{
 const old=shot('old',10),a=shot('tab-a',20),b=shot('tab-b',30),db=storage([old]),first=gallery(db),second=gallery(db);await db.flush();
 first.capture(a);await db.flush();expect(latest(db.rows())).toEqual([a,old]);
 second.capture(b);await db.flush();expect(latest(db.rows())).toEqual([b,a,old]);expect(second.list()).toEqual([b,a,old]);
 const reloaded=gallery(db);await db.flush();expect(reloaded.list()).toEqual([b,a,old]);
});

test('retention keeps the latest 60 from persisted and current captures rather than a stale tab cache',async()=>{
 const seed=Array.from({length:60},(_,i)=>shot('old-'+String(i).padStart(2,'0'),i+1)),a=shot('tab-a',61),b=shot('tab-b',62),db=storage(seed),first=gallery(db),second=gallery(db);await db.flush();
 first.save(a);await db.flush();second.save(b);await db.flush();const expected=latest([...seed,a,b]);
 expect(db.rows()).toHaveLength(60);expect(second.list()).toEqual(expected);expect(latest(db.rows())).toEqual(expected);
 expect(ids(db.rows())).toContain('tab-a');expect(ids(db.rows())).toContain('tab-b');expect(ids(db.rows())).not.toContain('old-00');expect(ids(db.rows())).not.toContain('old-01');
});

test('equal-time screenshots use the same stable ID order for live saves, retention and reload',async()=>{
 const seed=Array.from({length:60},(_,i)=>shot('tie-'+String(i).padStart(2,'0'),100)),extra=shot('tie-60',100),db=storage([...seed].reverse()),ui=gallery(db);await db.flush();
 ui.save(extra);await db.flush();const expected=latest([...seed,extra]);
 expect(ui.list()).toEqual(expected);expect(latest(db.rows())).toEqual(expected);const reloaded=gallery(db);await db.flush();expect(reloaded.list()).toEqual(expected);
});

test('successful screenshot reads and writes release their IndexedDB connections after transactions finish',async()=>{
 const db=storage([shot('old',1)]),ui=gallery(db);await db.flush();
 expect(db.connections.length).toBeGreaterThan(0);expect(db.connections.every(connection=>connection.closed)).toBe(true);
 ui.capture(shot('fresh',2));await db.flush();expect(db.connections.every(connection=>connection.transactions.every((tx:any)=>tx.finished)&&connection.closed)).toBe(true);
});

test('unavailable screenshot storage retains volatile capture replies',async()=>{
 const db=storage();db.model.unavailable=true;const ui=gallery(db),fresh=shot('volatile',20);await db.flush();ui.capture(fresh);await db.flush();
 expect(ui.list()).toEqual([fresh]);expect(db.rows()).toEqual([]);
});

test('an aborted screenshot write retains the volatile capture and releases the failed connection',async()=>{
 const old=shot('old',10),fresh=shot('volatile',20),db=storage([old]),ui=gallery(db);await db.flush();db.model.failNextPut=true;ui.capture(fresh);await db.flush();
 expect(ui.list()).toEqual([fresh,old]);expect(db.rows()).toEqual([old]);expect(db.connections.every(connection=>connection.closed)).toBe(true);
});
