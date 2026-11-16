import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const source=shell.slice(shell.indexOf('  // A recap belongs to one reported death'),shell.indexOf('  // Quest Journal, Fleet view'));
const escape=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));

function activity(options:{bDeath?:boolean;owner?:boolean}={}){
 let now=1_000_000,selected:string|null=null;
 const deathAt=now-60_000,bots:any[]=[{name:'Alpha',death:{at:deathAt}},{name:'Bravo',...(options.bDeath?{death:{at:deathAt}}:{})},{name:'Practice',practice:true,death:{at:deathAt}}];
 const body={innerHTML:''},requests:{name:string;resolve:(response:any)=>void}[]=[],window:any={atlasOperator:()=>options.owner!==false};
 window.atlasPlugins={activity:{render:()=>{body.innerHTML=window.atlasRecapHtml();}}};
 const fetch=(url:string)=>new Promise(resolve=>{requests.push({name:new URL(url,'http://localhost').searchParams.get('name')!,resolve});});
 const env={window,S:{bots},account:()=>bots.find(bot=>bot.name===selected)||null,selectedPlugin:'activity',body,fetch,Date:{now:()=>now},E:escape,safeName:String,age:String,icon:()=>'',qty:()=>'',wildLevel:()=>0,minimap:()=>{}};
 const api=new Function(...Object.keys(env),source+';return {draw:()=>{body.innerHTML=window.atlasRecapHtml();return body.innerHTML;}};')(...Object.values(env));
 const data=(killer:string,extra:any={})=>({at:deathAt,pos:{x:3200,z:3200,level:0},killer,hits:[],hp:[[1,10],[2,0]],actions:[],carried:[],lost:[],kept:[],script:'scripts/recap-fixture.ts',tick:2,...extra});
 return {requests,data,draw:api.draw,pick:(name:string)=>{selected=name;return api.draw() as string;},html:()=>body.innerHTML,names:()=>requests.map(request=>request.name),
  complete:async(index:number,recap:any)=>{requests[index]!.resolve({ok:true,json:async()=>({recap})});await settle();},
  advance:(ms:number)=>{now+=ms;},newDeath:(name:string)=>{bots.find(bot=>bot.name===name).death={at:now-1000};}};
}

test('Activity hides a loaded recap when the selected account has no reported death',async()=>{
 const a=activity();a.pick('Alpha');await a.complete(0,a.data('Alpha recorded hit'));
 expect(a.html()).toContain('Death · Alpha');expect(a.html()).toContain('Alpha recorded hit');
 const other=a.pick('Bravo');
 expect(other).not.toContain('Death · Alpha');expect(other).not.toContain('Alpha recorded hit');
 expect(a.names()).toEqual(['Alpha']);
});

test('Activity starts the new account recap while another account request is still pending',async()=>{
 const a=activity({bDeath:true});a.pick('Alpha');
 expect(a.names()).toEqual(['Alpha']);
 const other=a.pick('Bravo');
 expect(a.names()).toEqual(['Alpha','Bravo']);expect(other).toContain('Death · Bravo');expect(other).not.toContain('Death · Alpha');
 await a.complete(1,a.data('Bravo current hit'));
 expect(a.html()).toContain('Bravo current hit');
 await a.complete(0,a.data('Alpha obsolete hit'));
 expect(a.html()).toContain('Death · Bravo');expect(a.html()).toContain('Bravo current hit');expect(a.html()).not.toContain('Alpha obsolete hit');
});

test('Frozen-clock A to B to A selection keeps the latest A response instead of the earlier A request',async()=>{
 const a=activity({bDeath:true});a.pick('Alpha');a.pick('Bravo');a.pick('Alpha');
 expect(a.names()).toEqual(['Alpha','Bravo','Alpha']);
 await a.complete(2,a.data('Latest Alpha hit'));
 expect(a.html()).toContain('Latest Alpha hit');
 await a.complete(0,a.data('Obsolete Alpha hit'));
 expect(a.html()).toContain('Latest Alpha hit');expect(a.html()).not.toContain('Obsolete Alpha hit');
 await a.complete(1,a.data('Obsolete Bravo hit'));
 expect(a.html()).toContain('Death · Alpha');expect(a.html()).toContain('Latest Alpha hit');expect(a.html()).not.toContain('Obsolete Bravo hit');
 expect(a.names()).toEqual(['Alpha','Bravo','Alpha']);
});

test('A newer death starts a new same-account request while the earlier death is still loading',async()=>{
 const a=activity();a.pick('Alpha');a.newDeath('Alpha');a.draw();
 expect(a.names()).toEqual(['Alpha','Alpha']);
 await a.complete(1,a.data('New death hit',{at:999_000}));
 expect(a.html()).toContain('New death hit');
 await a.complete(0,a.data('Earlier death hit'));
 expect(a.html()).toContain('New death hit');expect(a.html()).not.toContain('Earlier death hit');
 expect(a.names()).toEqual(['Alpha','Alpha']);
});

test('Activity keeps current-account caching, the respawn retry and newer-death refresh',async()=>{
 const a=activity();a.pick('Alpha');await a.complete(0,a.data('Pending respawn',{kept:null,lost:null}));
 a.draw();a.advance(30_000);a.draw();expect(a.names()).toEqual(['Alpha']);
 a.advance(1);a.draw();expect(a.names()).toEqual(['Alpha','Alpha']);
 await a.complete(1,a.data('Respawn recorded'));
 a.advance(31_000);a.draw();expect(a.names()).toEqual(['Alpha','Alpha']);
 a.newDeath('Alpha');a.draw();expect(a.names()).toEqual(['Alpha','Alpha','Alpha']);
});

test('Activity keeps public recap reads off and does not request practice tick records',()=>{
 const publicView=activity({owner:false});
 expect(publicView.pick('Alpha')).toContain('only the dashboard on the PC shows it');
 publicView.draw();expect(publicView.names()).toEqual([]);
 const practice=activity();expect(practice.pick('Practice')).not.toContain('death-recap');expect(practice.names()).toEqual([]);
});
