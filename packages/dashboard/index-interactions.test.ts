import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const html=readFileSync(process.env.DASH_PAGE||new URL('./index.html',import.meta.url),'utf8');

function rosterPage(){
 const code=html.slice(html.indexOf('const LIVE_ROSTER_MS='),html.indexOf('// A published state can hold'));
 const expiry=html.split('\n').find(line=>line.includes('setInterval(')&&line.includes('SNAPSHOT&&LIVE_ROSTER'))!;
 const snapshot={now:1000,hostedAge:600000,hosted:{at:1000},world:{connected:false,players:1},roster:[['Old',1,2,0,3]],bots:[{name:'Worker',inWorld:false,operation:'offline',at:900,hp:{now:12,max:20},hpAt:800}]};
 let now=10000,renders=0;const timers:Array<()=>void>=[],window:any={};
 const run=new Function('snapshot','window','Date','setInterval','render',`let S=snapshot,connected=false,lastReceived=123,rswFor=null,sel=null;const STATIC=false,mode='2d',VIEWER={};${code}\nSNAPSHOT=snapshot;${expiry};return {feed:liveRosterIn,state:()=>({S,SNAPSHOT,connected,lastReceived})};`)
  (snapshot,window,{now:()=>now},(fn:()=>void)=>timers.push(fn),()=>renders++);
 return {...run,snapshot,timers,renders:()=>renders,advance:(ms:number)=>{now+=ms;}};
}

test('fresh rosters update the retained snapshot during a failed non-static snapshot stream',()=>{
 const page=rosterPage(),players=[['Worker',3200,3210,1,50],['Visitor',3201,3211,1,20]];
 page.feed({players});const {S,SNAPSHOT,connected,lastReceived}=page.state();
 expect(S.roster).toEqual(players);expect(S.worldPlayers).toBe(2);
 expect(S.bots[0]).toMatchObject({inWorld:true,pos:{x:3200,z:3210,level:1},at:900,hp:{now:12,max:20},hpAt:800});
 expect(S.now).toBe(1000);expect(S.hostedAge).toBe(600000);
 expect(connected).toBe(false);expect(lastReceived).toBe(123);expect(SNAPSHOT).toBe(page.snapshot);
 expect(page.snapshot.roster).toEqual([['Old',1,2,0,3]]);expect(page.renders()).toBe(1);
});

test('the retained snapshot returns when live roster updates expire during a non-static outage',()=>{
 const page=rosterPage();page.feed({players:[['Worker',3200,3210,0,50]]});
 expect(page.timers).toHaveLength(1);page.advance(30001);page.timers[0]!();
 const state=page.state();expect(state.S).toBe(page.snapshot);expect(state.connected).toBe(false);expect(state.lastReceived).toBe(123);
 expect(page.renders()).toBe(2);
});

test('picking an account retains the active shell panel and the standalone account default',()=>{
 const code=html.slice(html.indexOf('function pick(n){'),html.indexOf('// Any online player, followed'));
 for(const shell of [false,true]){
  const window:any=shell?{atlasClient:{selectedPlugin:()=> 'machine'}}:{};let renders=0;
  const state=new Function('window','render',`const S={bots:[{name:'Worker',inWorld:true}]},MARK='main',mode='2d',VIEWER={};let sel='Old',picked=false,view='machine',detailPage=4,rswFor='Old';${code};pick('Worker');return {sel,picked,view,detailPage,rswFor};`)(window,()=>renders++);
  expect(state).toEqual({sel:'Worker',picked:true,view:shell?'machine':'account',detailPage:0,rswFor:null});
  expect(window.atlasFreeCamera).toBe(false);expect(renders).toBe(1);
 }
});

const escapeText=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const decodeText=(value:string)=>value.replaceAll('&quot;','"').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');

function tablePage(){
 const code=html.slice(html.indexOf('function put(el,html){'),html.indexOf('const MARK='));
 const rowCode=html.split('\n').find(line=>line.startsWith('const row='))!;
 const document:any={activeElement:null},table:any={_h:null,rows:[],contains:(node:any)=>table.rows.includes(node)};
 table.querySelectorAll=()=>table.rows;
 table.querySelector=(selector:string)=>table.rows.find((row:any)=>selector.includes('data-row-key')&&row.dataset.rowKey===selector.split('="')[1]?.split('"')[0]);
 Object.defineProperty(table,'innerHTML',{set(markup:string){
  if(table.contains(document.activeElement))document.activeElement=null;
  table.rows=[...markup.matchAll(/<div class="data-row"([^>]*)>/g)].map(match=>{
   const attributes=Object.fromEntries([...match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map(attr=>[attr[1],decodeText(attr[2]!)]));
   const row:any={dataset:attributes['data-row-key']===undefined?{}:{rowKey:attributes['data-row-key']},tabIndex:Number(attributes.tabindex??-1),focus:()=>{if(row.tabIndex>=0)document.activeElement=row;}};
   return row;
  });
 }});
 const api=new Function('document','E','$','CSS',`${rowCode}\n${code};return {put,row};`)(document,escapeText,()=>table,{escape:(value:string)=>value});
 return {...api,table,document};
}

test('live table refreshes retain the same label occurrence when other rows move',()=>{
 const page=tablePage(),markup=(rows:Array<[string,number]>)=>rows.map(([label,value])=>page.row(label,value)).join('');
 page.put(page.table,markup([['CPU',1],['Process',2],['Memory',3],['Process',4]]));
 const original=page.table.rows[3];page.document.activeElement=original;
 page.put(page.table,markup([['New field',0],['Process',20],['CPU',10],['Memory',30],['Process',40]]));
 expect(page.document.activeElement).not.toBe(original);expect(page.document.activeElement).toBe(page.table.rows[4]);
 expect(page.document.activeElement.dataset.rowKey).toBe('Process');expect(page.document.activeElement.tabIndex).toBe(0);
});

test('a removed duplicate table row cannot silently send focus to another occurrence',()=>{
 const page=tablePage();page.put(page.table,page.row('Process',1)+page.row('Process',2));page.document.activeElement=page.table.rows[1];
 page.put(page.table,page.row('Process',3)+page.row('CPU',4));expect(page.document.activeElement).toBeNull();
 const escaped=page.row('CPU "main" & memory',5);
 expect(escaped).toContain('data-row-key="CPU &quot;main&quot; &amp; memory"');expect(escaped).toContain('tabindex="0"');
});
