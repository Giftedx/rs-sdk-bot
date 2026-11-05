import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8'),shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const worldCode=html.slice(html.indexOf('function mapWorld(){'),html.indexOf('function drawMap(){'));
const bots=[{name:'Live',practice:false,pos:{x:50,z:50}},{name:'Practice',practice:true,pos:{x:52,z:50}}];
function canvas(){const dots:number[][]=[];const g:any=new Proxy({fillRect:(...args:number[])=>{if(args[2]===3&&args[3]===3)dots.push(args);}}, {get:(o,k)=>k in o?o[k]:()=>{}});return {dots,clientWidth:800,clientHeight:800,width:146,height:146,getContext:()=>g};}
test('the live world map excludes practice markers and their click targets',()=>{
 const code=html.slice(html.indexOf('function drawMap(){'),html.indexOf("$('#map').onclick")),c=canvas();
 const run=new Function('S','sel','$',`const mode='2d',MAPI=null,window={},PLACES=[],st=()=>['off'],MARK='main';${worldCode}${code};drawMap();`);
 run({bots,map:{x0:0,z0:0,w:100,h:100,scale:1}},null,()=>c);
 expect((c as any)._p.map((p:any)=>p[2])).toEqual(['Live']);
 run({bots,map:{x0:0,z0:0,w:100,h:100,scale:1}},'Practice',()=>c);
 expect((c as any)._p.map((p:any)=>p[2])).toEqual(['Practice']);
});
test('the live minimap excludes practice markers',()=>{
 const start=shell.indexOf('  function minimap(){'),code=shell.slice(start,shell.indexOf('  // A click on the minimap',start)),c=canvas();
 const run=new Function('S','hud','selected',`const account=()=>S.bots[selected],sel=account().name,window={},mode='2d',st=()=>['off'];let miniView;${worldCode}${code};minimap();`);
 run({bots,map:{x0:0,z0:0,w:100,h:100,scale:1}},{querySelector:(s:string)=>s.endsWith('canvas')?c:null},0);
 expect(c.dots).toHaveLength(0);
 run({bots,map:{x0:0,z0:0,w:100,h:100,scale:1}},{querySelector:(s:string)=>s.endsWith('canvas')?c:null},1);
 expect(c.dots).toHaveLength(0);
});

test('practice selection cannot open or retain the live-only 3D viewer',async()=>{
 const request=html.slice(html.indexOf('async function request3D(){'),html.indexOf("$('#b3').onclick"));
 let calls=0;const reasons:string[]=[];
 const run=new Function('S','sel','fetch','viewerUnavailable',`let VIEWER_REQUEST=0,VIEWER_TIMER,VIEWER;const showViewerStatus=()=>{};${request};return request3D;`)({bots},'Practice',async()=>{calls++;return Response.json({available:false,reason:'upstream'});},(s:string)=>reasons.push(s));
 await run();expect(calls).toBe(0);expect(reasons[0]).toContain('Practice');
 const sync=html.slice(html.indexOf('function syncWorld(){'),html.indexOf('function chainHud('));
 const update=new Function('S','sel','viewerUnavailable',`const mode='3d',window={},VIEWER={url:null},$=()=>({}),showViewerStatus=()=>{};${sync};return syncWorld;`)({bots},'Practice',(s:string)=>reasons.push(s));
 update();expect(reasons).toHaveLength(2);
});

function squareHarness(){
 const code=shell.slice(shell.indexOf('  const squares=new Map()'),shell.indexOf('  // The 2D camera'));
 const images:any[]=[];let time=100;
 class Tile {complete=false;naturalWidth=0;src='';onload=()=>{};onerror=()=>{};constructor(){images.push(this);}}
 const api=new Function('window','Image','Date','minimap','drawMap',code+';return window.atlasSquare;')({},Tile,{now:()=>time},()=>{},()=>{});
 return {api,images,advance:()=>time+=30001};
}
test('a missing first map square does not disable other squares',()=>{
 const h=squareHarness();h.api(1,1);h.images[0].onerror();h.api(2,2);
 expect(h.images).toHaveLength(2);h.images[1].complete=true;h.images[1].naturalWidth=256;h.images[1].onload();
 expect(h.api(2,2)).toBe(h.images[1]);
});
test('failed map squares retry after a cooldown without a request on every redraw',()=>{
 const h=squareHarness();h.api(1,1);h.images[0].onerror();h.api(1,1);expect(h.images).toHaveLength(1);
 h.advance();h.api(1,1);expect(h.images).toHaveLength(2);
});
