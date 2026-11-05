import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';

export const GATE_NAMES=['plan wins','rehearsed','supplies staged','fresh targets','machine clear'];
export const fresh=(at:unknown,now:number,age:number)=>typeof at==='number'&&Number.isFinite(at)&&at>0&&at<=now&&now-at<age;
const need=(ok:unknown,message:string)=>{if(!ok)throw Error(message)};
const qty=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>0;
const key=(s:string)=>s.trim().toLowerCase().replace(/\s*\(noted\)$/,'').replace(/^feathers$/,'feather').replace(/^headless arrows$/,'headless arrow');
export type Binding={path:string;sha256:string};
export const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
export function localFile(root:string,path:string){
 need(typeof path==='string'&&!isAbsolute(path),'Evidence path must be repo relative');
 const file=realpathSync(resolve(root,path)),rel=relative(realpathSync(root),file);
 need(rel!== '..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')&&!isAbsolute(rel),'Evidence outside repository');return file;
}
export function readBound(root:string,ref:Binding,bindings:Binding[],json=true):any{
 need(ref&&/^[a-f0-9]{64}$/i.test(ref.sha256),'Missing evidence hash');
 const raw=readFileSync(localFile(root,ref.path));need(sha(raw)===ref.sha256,'Evidence changed: '+ref.path);
 bindings.push(ref);return json?JSON.parse(raw.toString()):raw.toString();
}
// Bind the actual runnable source, planner data, catalog, pin and target snapshot.
// Added or removed source files change this fingerprint too.
export function launchContext(root:string,snapshot:string){
 const files=['package.json','bun.lock','rs-sdk.pin','knowledge/items.json',snapshot];
 const walk=(dir:string)=>{for(const e of readdirSync(resolve(root,dir),{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())walk(p);else if(/\.(ts|json)$/.test(p)&&!p.endsWith('.test.ts'))files.push(p)}};
 for(const dir of ['scripts','packages/core/src','packages/planner/src'])walk(dir);
 const bindings=[...new Set(files)].sort().map(path=>({path,sha256:sha(readFileSync(localFile(root,path)))}));
 const targets=JSON.parse(readFileSync(localFile(root,snapshot),'utf8'));
 const rules={base:targets.base,tickMs:targets.tickMs,boards:targets.boards.map((b:any)=>({board:b.board,category:b.category,leader:b.rows?.[0]})).sort((a:any,b:any)=>a.board.localeCompare(b.board))};
 // Refreshing an unchanged leaderboard must not invalidate hours of rehearsal.
 const semantic=bindings.map(b=>b.path===snapshot?{...b,sha256:sha(JSON.stringify(rules))}:b);
 return {context:sha(JSON.stringify(semantic)),bindings};
}
type Read=(ref:any,json?:boolean)=>any;
export function validateSupplies(s:any,context:string,requirements:{item:string;count:number}[],catalog:any[],owned:string[],now:number,read:Read){
 need(s?.version===2&&s.context===context&&fresh(s.at,now,3600000),'Missing, stale or mismatched staging manifest');
 need(Array.isArray(s.allocations)&&s.allocations.length>0&&requirements.length>0,'No item allocations');
 // Several route stages can draw from one base stock pool. Compare allocations to the sum for that pool.
 const demand=new Map<string,number>();
 for(const r of requirements){
  need(typeof r.item==='string'&&qty(r.count),'Invalid supply requirement');
  const item=key(r.item),total=(demand.get(item)??0)+r.count;
  need(item&&qty(total),'Invalid supply requirement total');
  demand.set(item,total);
 }
 let expiresAt=s.at+3600000;
 const owners=new Set(owned.map(n=>n.toLowerCase())),totals=new Map<string,number>(),stock=new Map<string,number>(),deliveries=new Map<string,number>();
 for(const a of s.allocations){
  need(typeof a.item==='string'&&qty(a.count)&&Number.isSafeInteger(a.itemId)&&a.itemId>=0,'Invalid allocation');
  need(demand.has(key(a.item)),'Unexpected supply');
  need(catalog.some(i=>i.id===a.itemId&&key(i.name)===key(a.item)),'Unresolved supply item ID: '+a.item);
  need(typeof a.holder==='string'&&owners.has(a.holder.toLowerCase())&&a.recipient==='haggis','Unowned holder or wrong recipient');
  const b=read(a.bank),d=read(a.delivery);
  need(b.name?.toLowerCase()===a.holder.toLowerCase()&&b.server==='rs-sdk-demo.fly.dev'&&fresh(b.bankAt,now,3600000),'Invalid staging bank observation');
  need(d.ok===true&&d.server==='rs-sdk-demo.fly.dev'&&d.observed===true,'Delivery must record a successful observed live transfer');
  expiresAt=Math.min(expiresAt,b.bankAt+3600000,d.at+3600000);
  need(d.to?.toLowerCase()===a.holder.toLowerCase()&&owners.has(d.from?.toLowerCase())&&d.from.toLowerCase()!==d.to.toLowerCase()&&fresh(d.at,now,3600000)&&d.at<=b.bankAt,'Invalid delivery receipt');
  const count=(items:any[])=>{need(Array.isArray(items),'Missing receipt items');return items.reduce((n,i)=>{need(qty(i.count)&&Number.isSafeInteger(i.baseId??i.id),'Invalid receipt quantity/ID');return n+((i.baseId??i.id)===a.itemId?i.count:0)},0)};
  const sk=a.holder.toLowerCase()+':'+a.itemId,dk=sha(JSON.stringify(d))+':'+a.itemId;
  stock.set(sk,(stock.get(sk)??0)+a.count);deliveries.set(dk,(deliveries.get(dk)??0)+a.count);
  need(count(d.after)-count(d.before)===count(d.items),'Delivery lacks matching observed recipient delta');
  need(stock.get(sk)!<=count(b.bank)&&deliveries.get(dk)!<=count(d.items),'Stock or delivery double-counted/short');
  totals.set(key(a.item),(totals.get(key(a.item))??0)+a.count);
 }
 for(const [item,count] of demand)need(totals.get(item)===count,'Missing or excess reservation: '+item);
 return expiresAt;
}
export function validateRehearsals(runs:any[],context:string,expected:Record<string,number>,now:number,read:Read){
 need(runs.length===3&&Object.keys(expected).length>0,'Need three complete rehearsals');
 const ids=new Set(),actors=new Set(),logs=new Set();
 for(const r of runs){
  need(r?.version===2&&r.context===context&&fresh(r.at,now,7*86400000),'Stale or mismatched rehearsal');
  need(typeof r.runId==='string'&&r.runId&&typeof r.actor==='string'&&r.actor&&r.actor.toLowerCase()!=='haggis'&&/^localhost:\d+$/.test(r.server),'Invalid practice identity');
  need(!ids.has(r.runId)&&!actors.has(r.actor.toLowerCase())&&!logs.has(r.log?.path),'Repeated rehearsal');ids.add(r.runId);actors.add(r.actor.toLowerCase());logs.add(r.log?.path);
  need(r.ok===true&&r.died===false&&r.logout==='logged-out'&&r.startPlaytime===0&&qty(r.endPlaytime),'Incomplete whole-clock run');
  need(Object.keys(r.boardTicks??{}).length===Object.keys(expected).length,'Missing board stamps');
  for(const [id,ticks] of Object.entries(expected))need(Number.isFinite(ticks)&&ticks>0&&qty(r.boardTicks?.[id])&&r.boardTicks[id]<=r.endPlaytime&&Math.abs(r.boardTicks[id]-ticks)<=ticks*.02,'Rehearsal board mismatch: '+id);
  need(r.planTicks===Math.max(...Object.values(expected))&&Math.abs(r.endPlaytime-r.planTicks)<=r.planTicks*.02,'Rehearsal clock mismatch');
  const log=read(r.log,false);need(typeof log==='string'&&/^RESULT ok\b/m.test(log),'Missing successful raw log');
  const stamp=log.split(/\r?\n/).filter((line:string)=>line.startsWith('REHEARSAL '));
  need(stamp.length===1,'Need one raw whole-clock receipt');
  const raw=JSON.parse(stamp[0]!.slice(10));
  for(const field of ['context','runId','actor','server','at','startPlaytime','endPlaytime','planTicks','ok','died','logout','boardTicks'])need(JSON.stringify(raw[field])===JSON.stringify(r[field]),'Raw rehearsal differs: '+field);
 }
 return Math.min(...runs.map(r=>r.at+7*86400000));
}
export function gateProblem(g:any,now=Date.now(),authorization=true):string|null{
 if(g?.version!==2||(authorization&&g.go!==true))return 'not authorized by evidence gate v2';
 if(!fresh(g.at,now,600000)||!Number.isFinite(g.expiresAt)||g.expiresAt<=now||g.expiresAt>g.at+600000)return 'expired or future gate check';
 if(!Array.isArray(g.gates)||g.gates.length!==GATE_NAMES.length||GATE_NAMES.some(name=>g.gates.filter((x:any)=>x?.name===name&&typeof x.pass==='boolean'&&(!authorization||x.pass===true)).length!==1))return 'missing or failed gates';
 if(!/^[a-f0-9]{64}$/.test(g.context)||!Array.isArray(g.bindings)||!g.bindings.length||g.bindings.some((b:any)=>typeof b?.path!=='string'||!b.path||!/^[a-f0-9]{64}$/.test(b.sha256)))return 'missing evidence bindings';
 return null;
}
