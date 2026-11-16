import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const extract=(a:string,b:string)=>shell.slice(shell.indexOf(a),shell.indexOf(b,shell.indexOf(a)));
const attrs=(s:string)=>Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
const empty=()=>'';

function inventory(items:any[]){
 const env:any={b:{inventory:items,equipment:[]},E:String,icon:(i:any)=>'['+i.id+']',qty:String,invTag:empty,statTip:empty,priceTip:empty,chargeTag:empty,idTag:empty,deathMarks:()=>null,deathCls:empty,invWorth:empty,teleLine:empty};
 const code=extract('  function itemCell(', '  // The combat level line')+extract("    if(selectedTab==='inventory')", "    if(selectedTab==='skills')");
 const html=new Function(...Object.keys(env),`const selectedTab='inventory';let html='';${code};return html;`)(...Object.values(env));
 const cells=[...html.matchAll(/<button([^>]*)>/g)].map(m=>attrs(m[1]!));
 const contextCode=extract("  hud.addEventListener('contextmenu',e=>{const cell=", "  document.addEventListener('click',e=>{if(context");
 let handler:any,menu:any,prevented=false;const contextEnv:any={hud:{addEventListener:(_k:string,fn:any)=>{handler=fn;}},account:()=>({inventory:items}),document:{createElement:()=>({style:{},remove(){}}),body:{append:(el:any)=>{menu=el;}}},innerWidth:800,innerHeight:600,E:String};
 new Function(...Object.keys(contextEnv),`let context=null;${contextCode}`)(...Object.values(contextEnv));
 const open=(cell:any)=>{menu=null;prevented=false;const dataset:any={};if(Object.hasOwn(cell,'data-item'))dataset.item=cell['data-item'];
  const node:any={dataset,closest:(selector:string)=>selector.includes('[data-item]')&&Object.hasOwn(dataset,'item')||selector.split(',').includes('.inventory-cell')&&cell.class?.split(' ').includes('inventory-cell')?node:null};handler({target:node,clientX:10,clientY:10,preventDefault(){prevented=true;}});return menu?.innerHTML??'';};
 return {html,cells,open,prevented:()=>prevented};
}

test('the 28-cell inventory uses verified SDK positions and menus resolve the same exact row',()=>{
 const items=[{slot:27,id:2503,name:'Black body',count:1},{slot:0,id:1135,name:'Green body',count:2}],t=inventory(items);
 expect(t.cells).toHaveLength(28);expect(t.cells[0]!.title).toContain('Green body');expect(t.cells[27]!.title).toContain('Black body');
 expect(t.open(t.cells[0])).toContain('Green body');expect(t.open(t.cells[27])).toContain('Black body');
 expect(t.cells[1]!['aria-label']).toBe('Empty inventory slot 2');expect(t.open(t.cells[1])).toBe('');expect(t.prevented()).toBe(true);
 expect(t.html).not.toContain('positions are not reported');
});

test('legacy and mixed, invalid or duplicate position rows retain every item without inventing empty slots',()=>{
 for(const items of [
  [{id:1,name:'One',count:1},{id:2,name:'Two',count:2}],
  [{slot:27,id:1,name:'One',count:1},{id:2,name:'Two',count:2}],
  [{slot:27,id:1,name:'One',count:1},{slot:27,id:2,name:'Two',count:2}],
  [{slot:-1,id:1,name:'One',count:1},{slot:28,id:2,name:'Two',count:2}],
  Array.from({length:30},(_,n)=>({slot:n%28,id:n,name:'Item'+n,count:1})),
 ]){
  const t=inventory(items);expect(t.cells).toHaveLength(items.length);expect(t.html).toMatch(/positions are (?:not reported|unverified)/);
  expect(t.html).not.toContain('Empty slot');for(let n=0;n<items.length;n++){expect(t.cells[n]!.title).toContain(items[n]!.name);expect(t.open(t.cells[n])).toContain(items[n]!.name);}
 }
});

function equipment(b:any){
 const code=extract("    if(selectedTab==='equipment'&&", "    if(selectedTab==='quests'&&");
 return new Function('b','E','age','window','deathMarks','deathCls','setupSlot','icon','qty','chargeTag','equipStats','setupPanel',`const selectedTab='equipment';let html='';${code};return html;`)
  (b,String,()=> '1m',{atlasOperator:()=>true},()=>null,empty,()=>({cls:'',tip:''}),(it:any)=>'['+it.id+']',String,empty,empty,empty);
}

test('equipment marked unobserved is neither an empty doll nor an observed worn list',()=>{
 for(const items of [[],[{id:1277,name:'Bronze sword',count:1,slot:3}],[{id:1277,name:'Bronze sword',count:1}]]){
  const html=equipment({equipment:items,equipmentObserved:false,at:1});expect(html).toContain('Equipment is not reported');expect(html).toContain('Head · not reported');
  expect(html).not.toContain('Head · empty');expect(html).not.toContain('Observed 1m');expect(html).not.toContain('[1277]');
 }
 const known=equipment({equipment:[],equipmentObserved:true,at:1});expect(known).toContain('Head · empty');expect(known).toContain('Observed 1m');
});

test('an unobserved worn slot cannot open a menu for hidden gear while an observed item still can',()=>{
 const code=extract("  hud.addEventListener('contextmenu',e=>{const cell=", "  document.addEventListener('click',e=>{if(context");
 let handler:any,menu:any;const b:any={equipment:[{slot:3,id:1277,name:'Bronze sword',count:1}],equipmentObserved:false};
 const env:any={hud:{addEventListener:(_k:string,fn:any)=>{handler=fn;}},account:()=>b,document:{createElement:()=>({style:{},remove(){}}),body:{append:(el:any)=>{menu=el;}}},innerWidth:800,innerHeight:600,E:String};
 new Function(...Object.keys(env),`let context=null;${code}`)(...Object.values(env));
 const cell:any={dataset:{equipment:'3'},closest:()=>cell},open=()=>handler({target:cell,clientX:10,clientY:10,preventDefault(){}});
 open();expect(menu).toBeUndefined();b.equipmentObserved=true;open();expect(menu.innerHTML).toContain('Bronze sword');
});

function pvp(){
 const S={bots:[{name:'Worker'}],roster:[['Threat',3101,3700,0,70]]},code=extract('  const wildLevel=p=>','  function infoboxes(){')+extract("  // Items kept on death (RuneLite's",'  function itemCell(');
 return new Function('S','price','priceKey',`${code};return {pvpState,deathMarks,deathCls};`)(S,(it:any)=>it.id===385?{value:800}:null,(it:any)=>'id:'+it.id);
}

test('unknown worn equipment leaves known pack value and threats useful but never definite keep/loss claims or marks',()=>{
 const ui=pvp(),b:any={name:'Worker',inWorld:true,combat:70,pos:{x:3100,z:3700,level:0},equipment:[],equipmentObserved:false,inventory:[{id:385,name:'Shark',count:4}]};
 const p=ui.pvpState(b);expect(p.risk).toBe(3200);expect(p.threats.map((x:any)=>x.name)).toEqual(['Threat']);expect(p.incomplete).toBe(true);expect(p.unobserved).toContain('equipment');
 expect(p.kept).toEqual([]);expect(p.keptValue).toBeNull();expect(p.lost).toBeNull();expect(ui.deathMarks(b)).toBeNull();
 b.equipmentObserved=true;const known=ui.pvpState(b);expect(known.incomplete).toBe(false);expect(known.kept).toHaveLength(3);expect(known.lost).toBe(800);expect(ui.deathMarks(b)).not.toBeNull();
 b.inventory=null;expect(ui.pvpState(b).incomplete).toBe(true);expect(ui.pvpState(b).unobserved).toContain('inventory');expect(ui.deathMarks(b)).toBeNull();
});

test('PvP risk consumers label partial known value and unknown keep/loss while retaining threats',()=>{
 const ui=pvp(),b:any={name:'Worker',inWorld:true,combat:70,pos:{x:3100,z:3700,level:0},equipment:[],equipmentObserved:false,inventory:[{id:385,name:'Shark',count:4}]},p=ui.pvpState(b);
 const line=shell.split('\n').find(l=>l.startsWith('    const wildLine='))!;
 const text=new Function('pvpState','wildLevel','gp','line',`${line};return wildLine;`)(()=>p,()=>23,String,(label:string,value:string)=>label+': '+value+'|')(b);
 expect(text).toContain('Known risk: 3200 · equipment not reported');expect(text).toContain('Kept · lost: unknown');expect(text).toContain('Can attack: 1: Threat (70)');
 const cardLine=shell.split('\n').find(l=>l.startsWith('    const pvp=wild.length?'))!;
 const card=new Function('wild','E','safeName','gp',`${cardLine};return pvp;`)([{b,p}],String,String,String);
 expect(card).toContain('known risk 3200');expect(card).toContain('equipment not reported');expect(card).toContain('kept unknown');expect(card).toContain('Threat');
});

test('setup summaries count extra worn slots as a difference rather than claiming every slot matches',()=>{
 const kit={name:'black',worn:{4:['Body',1,2503]},carried:[]},code=extract('  let pkKits=', '  // Screenshot');
 const ui=new Function('localStorage','fetch','asset','E','icon','nf','kit',`${code};pkKits=[kit];setupKit=kit.name;return {setupPanel,setupSlot};`)
  ({getItem:()=>''},()=>new Promise(()=>{}),String,String,empty,String,kit);
 const body={id:2503,name:'Body',count:1,slot:4},shield={id:1171,name:'Shield',count:1,slot:5},b={equipment:[body,shield],inventory:[]};
 expect(ui.setupSlot(b,5,shield).cls).toBe(' setup-extra');const html=ui.setupPanel(b);expect(html).not.toContain('Every worn slot matches');expect(html).toContain('1 worn slot');expect(html).toContain('differ');
 expect(ui.setupPanel({...b,equipment:[body]})).toContain('Every worn slot matches');
});
