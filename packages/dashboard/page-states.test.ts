import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const read=(name:string)=>readFileSync(new URL('./'+name,import.meta.url),'utf8');
const html=read('index.html'),shell=read('client-shell.js'),ops=read('operations.js'),shellCss=read('client-shell.css'),opsCss=read('operations.css');

// An element that counts the times its markup is written.
const counted=()=>{let value='',writes=0;return {get innerHTML(){return value;},set innerHTML(v:string){value=v;writes++;},writes:()=>writes};};

test('the overlay box is written once while its text stays the same',()=>{
 const code=shell.slice(shell.indexOf('  function overlay(){'),shell.indexOf('    const [,state]=st(b);'));
 const el=counted(),state:any={bots:[{name:'Worker',fresh:true,operation:'observed'}]};
 const overlay=new Function('S','account','hud','E','window','nf',`${code}};return overlay;`)(state,()=>null,{querySelector:()=>el},String,{atlasOperator:()=>false},String);
 overlay();overlay();
 expect(el.writes()).toBe(1);expect(el.innerHTML).toContain('<span>Playing</span><b>1 / 1</b>');
 state.bots.push({name:'Second',fresh:true,operation:'observed'});overlay();
 expect(el.writes()).toBe(2);expect(el.innerHTML).toContain('<b>2 / 2</b>');
});

test('the infoboxes are written once while they stay the same',()=>{
 const code=shell.slice(shell.indexOf('  function infoboxes(){'),shell.indexOf('  // Board progress'));
 const el=counted();
 const infoboxes=new Function('account','hud','E','asset','skillFile','dur','age','realSkill',code+';return infoboxes;')(()=>({name:'Worker',uptime:60000,skills:[]}),{querySelector:()=>el},String,(n:string)=>n,(n:string)=>n.toLowerCase(),String,String,()=>true);
 infoboxes();infoboxes();
 expect(el.writes()).toBe(1);expect(el.innerHTML).toContain('class="infobox"');
});

test('the Grand Exchange rows stay the same markup when only the price age changes',()=>{
 const code=shell.slice(shell.indexOf('  function geResults(){'),shell.indexOf('  // Pull requests plugin'));
 let old='1m';
 const state:any={bots:[],economy:{pricesAt:1,supplies:[{id:1,name:'Fire rune',ask:5,bid:4,stock:10}]}};
 const geResults=new Function('S','window','E','nf','icon','age',`let geQuery='',geAll=false,geOpen=null;${code};return geResults;`)(state,{atlasOperator:()=>false},String,String,()=>'<i/>',()=>old);
 const [head,rows]=geResults();old='2m';const [head2,rows2]=geResults();
 expect(head).toContain('prices 1m old');expect(head2).toContain('prices 2m old');
 expect(rows).toContain('Fire rune');expect(rows2).toBe(rows);
});

test('the enter animation starts again on each call and its class goes when it is over',()=>{
 const code=shell.slice(shell.indexOf('  const enterTimers=new WeakMap();'),shell.indexOf('  const syncSidebar='));
 const classes=new Set<string>(),timers:(()=>void)[]=[];
 const el={classList:{contains:(c:string)=>classes.has(c),add:(c:string)=>classes.add(c),remove:(...c:string[])=>c.forEach(x=>classes.delete(x))}};
 const enter=new Function('setTimeout','clearTimeout',code+';return enter;')((f:()=>void)=>timers.push(f),()=>{});
 enter(el);expect([...classes]).toEqual(['enter-a']);
 enter(el);expect([...classes]).toEqual(['enter-b']);
 enter(el);expect([...classes]).toEqual(['enter-a']);
 timers.at(-1)!();expect(classes.size).toBe(0);
 // Both names have the same keyframes, and the animated classes exist in the style sheet.
 for(const name of ['enter-a','enter-b']){expect(opsCss).toContain('.'+name+'>*{animation:'+name+' ');expect(opsCss).toContain('@keyframes '+name+'{from{opacity:0;transform:translateY(4px)}}');}
});

test('the Fleet page shows a waiting state, not zero counts, until the first snapshot',()=>{
 const code=ops.slice(ops.indexOf(' function fleet(){'),ops.indexOf(' function account(){'));
 const page=new Function('S','window','page','title',code+';return fleet();')(null,{atlasOperator:()=>false},(h:string)=>h,(...a:string[])=>a.join('|'));
 expect(page).toContain('role="status">Waiting for fleet data…');expect(page).toContain('op-skel');
 expect(page).not.toContain('No accounts match');expect(page).not.toContain('op-filter');
});

test('the connection label reads CONNECTING only before the first state and in the first 15 seconds',()=>{
 const code=html.slice(html.indexOf('function connectionState(){'),html.indexOf("$('#inspector').addEventListener"));
 const label=(state:unknown,lastReceived:number,now:number)=>{
  const hidden={textContent:'',className:'',title:''},visible={textContent:'',className:'connection',title:''};
  new Function('connected','lastReceived','S','document','$','performance',code+';connectionState();')(false,lastReceived,state,{body:{classList:{toggle:()=>{}}},querySelector:()=>visible},()=>hidden,{now:()=>now});
  return visible.textContent;
 };
 expect(label(null,0,2000)).toBe('CONNECTING');
 expect(label(null,0,20000)).toBe('FROZEN');
 expect(label({},Date.now()-60000,2000)).toBe('FROZEN');
});

test('motion uses the tokens, and reduced motion turns it off',()=>{
 expect(shellCss).toContain('--mo-1:120ms;--mo-2:180ms;--mo-3:240ms;--ease-out:cubic-bezier(.2,.7,.2,1);--ease-io:cubic-bezier(.45,0,.25,1)');
 // No literal duration is left in a transition outside the Fleet wall rules.
 const literal=/transition:[^;}]*(?<![\d.])\.\d+s/;
 for(const css of [shellCss,opsCss])for(const line of css.split('\n'))if(!/wall/i.test(line))expect(literal.test(line)).toBe(false);
 expect(opsCss).toContain('@media(prefers-reduced-motion:reduce){\n *:not(.xp-drop):not(.game-toast),*::before,*::after{animation-duration:.01ms!important');
 expect(opsCss).not.toContain('backdrop-filter');
});
