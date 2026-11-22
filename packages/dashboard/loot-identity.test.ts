import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {buildItemPrices,expectedLootPrices,projectItemPrices} from './item-prices';
import {MAIN_ACCOUNT,publicView} from './publish-relay';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const server=readFileSync(new URL('./server/state/build.ts',import.meta.url),'utf8');
const market=readFileSync(new URL('./server/market.ts',import.meta.url),'utf8');
const transpile=(text:string)=>new Bun.Transpiler({loader:'ts'}).transformSync(text);

function loot(rows:any[],economy:any){
 const pricing=shell.slice(shell.indexOf('  const priceName='),shell.indexOf('  // Item stats (RuneLite'));
 const code=shell.slice(shell.indexOf("  // Loot of a kill (RuneLite's loot tracker"),shell.indexOf('  function hourRates('));
 const sync=(value:any):any=>({then(fn:any){return sync(fn(value));}});
 return new Function('S','window','asset','fetch','nf',`${pricing}${code};return {lootText,lootTotal};`)(
  {economy},{},String,()=>sync({ok:true,json:()=>({'Test NPC':rows})}),(n:number)=>n.toLocaleString('en-GB'));
}

test('expected loot uses distinct exact prices and leaves unknown explicit identities unpriced',()=>{
 const p=loot([['Herb',2,199],['Herb',0.5,201],['Herb',10,999],['Herb',10,null],['Herb',10,-1],['Coins',3]],{
  itemPricesById:{199:{value:10},201:{value:100}},itemPricesByName:{herb:{value:9999}},itemValues:{Herb:9999}});
 expect(p.lootTotal('Test NPC')).toBe(73);
 expect(p.lootText('Test NPC')).toBe('Loot about 73 gp a kill (Herb, Herb, Coins) · 3 unpriced');
 expect(p.lootText('Unknown')).toBe('');
});

test('legacy expected-loot tuples retain safe name pricing',()=>{
 const p=loot([['Big bones',1],['Coins',3]],{itemPricesByName:{'big bones':{value:300}}});
 expect(p.lootTotal('Test NPC')).toBe(303);
 expect(p.lootText('Test NPC')).toContain('Loot about 303 gp a kill');
});

test('the actual state price projection includes expected drops that no account holds',()=>{
 const rows={'Test NPC':[['Herb',1,199],['Herb',1,201],['Herb',1,999],['Herb',1,null],['Big bones',1]]};
 const load=market.slice(market.indexOf('const npcLootPrices ='),market.indexOf('let pricesAt ='));
 const npcLootPrices=new Function('cached','join','dashboardDir','expectedLootPrices',transpile(load)+';return npcLootPrices;')(
  (_file:string,parse:(text:string)=>any)=>parse(JSON.stringify(rows)),join,import.meta.dir,expectedLootPrices);
 const itemPrices=buildItemPrices([{id:199,name:'Herb',basePrice:10},{id:201,name:'Herb',basePrice:100},
  {id:532,name:'Big bones',basePrice:300},{id:5555,name:'Private bank stock',basePrice:999}],
  [{id:199,name:'Herb'},{id:201,name:'Herb'},{id:532,name:'Big bones'},{id:5555,name:'Private bank stock'}]);
 const start=server.indexOf('    const visiblePrices:'),end=server.indexOf('    const economy =',start);
 const projected=new Function('npcLootPrices','itemPrices','projectItemPrices',transpile(
  'const bots=[],v={items:[],log:[],flow:[]},flows=new Map(),keySupplyIds=()=>[];'+server.slice(start,end))+';return projectedPrices;')(
  npcLootPrices,itemPrices,projectItemPrices);
 expect(projected.byId[199]?.value).toBe(10);expect(projected.byId[201]?.value).toBe(100);
 expect(projected.byId[999]).toBeUndefined();expect(projected.byName.herb).toBeUndefined();
 const shared=publicView({bots:[],economy:{itemPricesById:itemPrices.byId,itemPricesByName:itemPrices.byName}},MAIN_ACCOUNT,npcLootPrices());
 expect(shared.economy.itemPricesById[5555]).toBeUndefined();
 expect(shared.economy.itemPricesByName['private bank stock']).toBeUndefined();
 const p=loot(rows['Test NPC'],shared.economy);
 expect(p.lootTotal('Test NPC')).toBe(410);expect(p.lootText('Test NPC')).toContain('2 unpriced');
});

test('expected-drop projection preserves unknown explicit identities and ignores malformed asset rows',()=>{
 expect(expectedLootPrices({Test:[['Legacy',1],['Exact',1,0],['Unknown',1,null],['Bad',1,-1],['',1,2],['Zero',0,3],null,{},['Invalid',Infinity,4]]}))
  .toEqual(['Legacy',{id:0,name:'Exact'},{id:null,name:'Unknown'},{id:-1,name:'Bad'}] as any);
 expect(expectedLootPrices(null)).toEqual([]);expect(expectedLootPrices([])).toEqual([]);
});

const E=(value:any)=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
async function opponent(drops:any,names:any){
 const code=shell.slice(shell.indexOf('  let npcNames=null'),shell.indexOf("  window.addEventListener('message'",shell.indexOf('  let npcNames=null')));
 const el={hidden:true,innerHTML:''};
 const draw=new Function('fetch','asset','hud','window','$','E',`${code};return opponentBox;`)(
  async(file:string)=>Response.json(file==='npc-drops.json'?drops:names),String,{querySelector:()=>el},{},()=>null,E);
 await draw({kind:'npc',type:113,hp:[10,30]});
 return {el,draw};
}

test('opponent drops use the exact NPC type and preserve escaped conditional branch details',async()=>{
 const detail='3 per entry · conditional · $random < 77 · source "jogre.rs2"';
 const {el,draw}=await opponent({byId:{113:[{id:532,name:'Big bones',summary:'multiple table entries',facts:[{text:'1 per entry · conditional'},{text:detail}]}],
  114:[{id:532,name:'Big bones',summary:'1 per entry · always',facts:[]}]},byName:{jogre:[{name:'Unsafe sibling',summary:'always',facts:[]}]}},
  {113:['Jogre',53],114:['Jogre',53],115:['Jogre',53]});
 expect(el.innerHTML).toContain('multiple table entries');expect(el.innerHTML).toContain(E(detail));
 expect(el.innerHTML).not.toContain('$random <');expect(el.innerHTML).not.toContain('Unsafe sibling');
 await draw({kind:'npc',type:114,hp:[10,30]});expect(el.innerHTML).toContain('1 per entry · always');
 await draw({kind:'npc',type:115,hp:[10,30]});expect(el.innerHTML).not.toContain('opponent-drops');
 await draw({kind:'player',name:'Player',hp:[10,30]});expect(el.innerHTML).not.toContain('opponent-drops');
});

test('opponent information can still read legacy flat drop assets',async()=>{
 const {el}=await opponent({Jogre:[['Big bones','1/2']]},{113:['Jogre',53]});
 expect(el.innerHTML).toContain('Big bones <small>1/2</small>');
});

test('opponent drop details remain reachable beyond the four visible rows',async()=>{
 const rows=Array.from({length:6},(_,id)=>({id,name:'Item '+id,summary:'conditional',facts:[{text:'condition < '+id}]}));
 const {el}=await opponent({byId:{113:rows},byName:{}},{113:['Jogre',53]});
 expect(el.innerHTML).toContain('+2 drops');expect(el.innerHTML).toContain('Item 5 · condition &lt; 5');
 const css=readFileSync(new URL('./client-shell.css',import.meta.url),'utf8');
 expect(css.match(/\.opponent-drops\{[^}]+\}/)?.[0]).toContain('pointer-events:auto');
});
