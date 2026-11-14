import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const healthSource=shell.slice(shell.indexOf('  function recordedHp('),shell.indexOf('  const curLevel='));
function harness(permission='default',request:()=>Promise<string>=async()=>permission,available=true){
 const code=shell.slice(shell.indexOf("  const NOTIFY_KEY="),shell.indexOf('  let idleFor='));
 const storage=new Map<string,string>(),sent:any[]=[],toasts:string[]=[];let focused=false;
 const N:any=function(_title:string,options:any){sent.push(options);};N.permission=permission;N.requestPermission=async()=>{const result=await request();N.permission=result;return result;};
 const window:any=available?{Notification:N}:{},body={querySelectorAll:()=>[]};
 new Function('window','Notification','localStorage','document','body','asset','toast',code+';window.send=desktopNotify;')(window,available?N:undefined,{getItem:(k:string)=>storage.get(k),setItem:(k:string,v:string)=>storage.set(k,v)},{hasFocus:()=>focused},body,(s:string)=>s,(s:string)=>toasts.push(s));
 return {api:window.atlasNotify,send:window.send,sent,toasts,storage,N,focus:(v:boolean)=>focused=v};
}
test('notification switch waits for permission; dismissal does not enable it',async()=>{let resolve:any;const h=harness('default',()=>new Promise(r=>resolve=r));const pending=h.api.set(true);expect(h.api.on()).toBe(false);resolve('default');await pending;expect(h.api.on()).toBe(false);});
test('denied and unsupported notifications cannot remain enabled',async()=>{for(const h of [harness('denied'),harness('default',undefined,false)]){await h.api.set(true);expect(h.api.on()).toBe(false);}});
test('permission rejection is handled and reported',async()=>{const h=harness('default',async()=>{throw Error('blocked');});await expect(h.api.set(true)).resolves.toBeDefined();expect(h.api.on()).toBe(false);});
test('turning off while permission is pending cannot be undone by its completion',async()=>{let resolve:any;const h=harness('default',()=>new Promise(r=>resolve=r));const pending=h.api.set(true);await h.api.set(false);resolve('granted');await pending;expect(h.api.on()).toBe(false);});
test('granted notification delivery respects toggle and focus, test bypasses focus',async()=>{const h=harness('granted');await h.api.set(true);h.send('level');expect(h.sent).toHaveLength(1);h.focus(true);h.send('death');expect(h.sent).toHaveLength(1);expect(h.api.test()).toBe(true);expect(h.sent).toHaveLength(2);await h.api.set(false);h.focus(false);h.send('idle');expect(h.sent).toHaveLength(2);});
function idleHarness(){const code=shell.slice(shell.indexOf('  let idleFor='),shell.indexOf('  // Level-ups'));const notices:string[]=[];return {notices,run:new Function('notify','desktopNotify','safeName',healthSource+code+';return idleNotifier;')((s:string)=>notices.push(s),()=>{},String)};}
test('idle alert counts new observations rather than redraws',()=>{const h=idleHarness(),b={name:'Worker',fresh:true,at:1,action:'idle'};for(let i=0;i<5;i++)h.run(b);expect(h.notices).toHaveLength(0);h.run({...b,at:2});h.run({...b,at:3});expect(h.notices).toEqual(['Worker is now idle!']);h.run({...b,at:4});expect(h.notices).toHaveLength(1);});
test('practice does not send live health or idle alerts; fresh low health alerts immediately',()=>{const now=1_000_000,h=idleHarness(),b={name:'Worker',fresh:true,practice:true,inWorld:true,at:now-10,hpAt:now-10,action:'idle',hp:{now:1,max:20}};for(let at=now-10;at<=now-6;at++)h.run({...b,at,hpAt:at},now);expect(h.notices).toHaveLength(0);h.run({...b,practice:false,at:now-5,hpAt:now-5},now);expect(h.notices).toEqual(['Worker has low hitpoints: 1 / 20']);});
test('fresh presence and a newer heartbeat do not turn stale or unknown recorded health into a low-health alert',()=>{
 const now=1_000_000,b={name:'Worker',fresh:true,inWorld:true,snapshotOnly:true,at:now-100,hpAt:now-20_000,action:'working',hp:{now:1,max:20},live:{seen:now-1}};
 for(const change of [{},{hpAt:undefined},{hpAt:null},{hpAt:now+1},{hpAt:now-1},{at:undefined},{at:now+1},{inWorld:false}]){
  const h=idleHarness();h.run({...b,...change},now);expect(h.notices).toEqual([]);
 }
 const h=idleHarness();h.run(b,now);h.run({...b,at:now-1,live:{seen:now}},now);expect(h.notices).toEqual([]);
 h.run({...b,at:now,hpAt:now,hp:{now:0,max:20}},now);expect(h.notices).toEqual(['Worker has low hitpoints: 0 / 20']);
});
test('health alerts use new dated observations rather than redraws and can re-arm after a new healthy sample',()=>{
 const now=1_000_000,h=idleHarness(),b={name:'Worker',fresh:true,inWorld:true,at:now-3,hpAt:now-3,action:'working',hp:{now:1,max:20}};
 for(let i=0;i<5;i++)h.run(b,now);expect(h.notices).toEqual(['Worker has low hitpoints: 1 / 20']);
 h.run({...b,hp:{now:20,max:20}},now);h.run({...b,at:now-2,hpAt:now-2},now);expect(h.notices).toHaveLength(1);
 h.run({...b,at:now-1,hpAt:now-1,hp:{now:20,max:20}},now);
 h.run({...b,at:now,hpAt:now},now);expect(h.notices).toEqual(['Worker has low hitpoints: 1 / 20','Worker has low hitpoints: 1 / 20']);
});

test('pending permission exposes a cancel control wired to disable notifications',async()=>{
 let resolve:any;const controls:any={'[data-notify-cancel]':[{hidden:true}],'[data-notify]':[{checked:false}],'[data-notify-status]':[{textContent:''}],'[data-notify-test]':[{disabled:true}]};
 const code=shell.slice(shell.indexOf('  const NOTIFY_KEY='),shell.indexOf('  let idleFor='));
 const N:any={permission:'default',requestPermission:()=>new Promise(r=>resolve=r)},storage=new Map();
 const api=new Function('window','Notification','body','localStorage','toast',code+';return window.atlasNotify;')({Notification:N},N,{querySelectorAll:(s:string)=>controls[s]||[]},{getItem:(k:string)=>storage.get(k),setItem:(k:string,v:string)=>storage.set(k,v)},()=>{});
 const pending=api.set(true);expect(controls['[data-notify-cancel]'][0].hidden).toBe(false);
 const handlerCode=shell.slice(shell.indexOf("  body.addEventListener('click',e=>{if(e.target.closest('[data-notify-test]'))"),shell.indexOf('  hud.onclick='));
 let handler:any;new Function('body','setNotify','testNotify',handlerCode)({addEventListener:(_type:string,fn:any)=>handler=fn},api.set,()=>{});
 handler({target:{closest:(selector:string)=>selector==='[data-notify-cancel]'}});
 expect(controls['[data-notify-cancel]'][0].hidden).toBe(true);N.permission='granted';resolve('granted');await pending;expect(api.on()).toBe(false);
});
