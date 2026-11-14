import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const read=(name:string)=>readFileSync(new URL('./'+name,import.meta.url),'utf8'),html=read('index.html'),shell=read('client-shell.js'),operations=read('operations.js');
const names=JSON.parse(read('items.json')),count=Number(html.match(/const ITEM_SPRITE_COUNT=(\d+);/)?.[1]);
const icon=new Function('S','LOCAL_ITEMS','ITEM_SPRITE_COUNT','E',html.slice(html.indexOf('function icon('),html.indexOf('// Stack numbers'))+';return icon;')({icons:{}},names,count,String);
const green={id:1135,name:'Dragonhide body',count:1},black={id:2503,name:'Dragonhide body',count:1},note={id:2504,baseId:2503,name:'Dragonhide body (noted)',count:2};
const run=(code:string,env:Record<string,any>)=>new Function(...Object.keys(env),code)(...Object.values(env));
const position=(id:number,size=32)=>`background-position:-${id%64*size}px -${Math.floor(id/64)*size}px`;
function containsItems(output:string,items= [green,black,note],size=32){for(const item of items)expect(output).toContain(position(item.id,size));expect(output).not.toContain('ico none');}
const empty=()=>'',E=String,nf=String,gp=String,age=()=> '1m';

test('held inventory and equipment render raw variant and noted IDs through the shared icon helper',()=>{
 const cell=html.slice(html.indexOf('function cell('),html.indexOf('function goalOf('));
 const renderCell=run(`${cell};return cell;`,{icon,E,nf,qty:(n:number)=>['y',String(n)]});
 const itemCell=shell.slice(shell.indexOf('  function itemCell('),shell.indexOf('  // The combat level line'));
 const renderItem=run(`${itemCell};return itemCell;`,{icon,E,invTag:empty,statTip:empty,priceTip:empty,qty:empty,chargeTag:empty,idTag:empty});
 containsItems([green,black,note].map(item=>renderCell(item)+renderItem(item,0)).join(''));
 const equipment=shell.slice(shell.indexOf("    if(selectedTab==='equipment'&&"),shell.indexOf("    if(selectedTab==='quests'&&"));
 const env={selectedTab:'equipment',icon,E,qty:empty,chargeTag:empty,age,window:{atlasOperator:()=>true},deathMarks:()=>null,deathCls:empty,setupSlot:()=>({cls:'',tip:''}),equipStats:empty,setupPanel:empty};
 containsItems(run(`let html='';${equipment};return html;`,{...env,b:{equipment:[{...green,slot:0},{...black,slot:4},{...note,slot:7}],at:1}}));
 containsItems(run(`let html='';${equipment};return html;`,{...env,b:{equipment:[green,black,note],side:'cloud',at:1}}));
});

test('the bank window and GE rows keep item identity even when the safe name table has no alias',()=>{
 const bank=shell.slice(shell.indexOf('  function openBank(){'),shell.indexOf('  // Orbs as RuneLite'));
 const nodes:any={},node=(selector:string)=>nodes[selector]??=(selector==='input'?{value:''}:{innerHTML:'',textContent:''});
 const modal={setAttribute:()=>{},querySelector:node,remove:()=>{}},bot={name:'Worker',bankAt:1,bank:[green,black,note]};
 run(`${bank};openBank();`,{account:()=>bot,document:{createElement:()=>modal},hud:{querySelector:()=>null,append:()=>{}},window:{atlasOperator:()=>true},toast:empty,E,safeName:String,age,stackValue:()=>({value:0,unpriced:0}),gp,icon,qty:empty,statTip:empty,priceTip:empty});
 containsItems(node('.bank-items').innerHTML);
 const ge=shell.slice(shell.indexOf('  function geResults(){'),shell.indexOf('  // Pull requests plugin'));
 const rows=run(`${ge};return geResults()[1];`,{S:{icons:{},bots:[],economy:{supplies:[green,black,note]}},window:{atlasOperator:()=>false},geQuery:'',geSort:'stock',geAll:true,geOpen:null,E,nf,age,icon,geSources:empty});
 containsItems(rows,[green,black,note],24);
});

test('decoded worn lookup IDs reach their actual lookup card icons',()=>{
 const lookup=shell.slice(shell.indexOf('  function lookupCard(l){'),shell.indexOf('  function refreshWorldLookup(){'));
 const output=run(`${lookup};return lookupCard(l);`,{l:{name:'Worker',worn:[{...green,slot:'Head'},{...black,slot:'Body'}]},S:{bots:[]},window:{},icon,E,nf,age,safeName:String});
 containsItems(output,[green,black]);
});

test('stock, collection and observed loot renders pass their retained IDs to icons',()=>{
 const stock=operations.slice(operations.indexOf(' function stock(){'),operations.indexOf(' // Fleet deck:'));
 const env={page:(s:string)=>s,title:empty,button:empty,stockTabs:empty,bots:()=>[{name:'Worker',bankAt:1,bank:[green,black]}],stockView:'stock',stockAccount:'',stockQuery:'',moneyKey:(i:any)=>'id:'+i.id,moneyPrice:()=>null,S:{},window:{atlasOperator:()=>true},E,nf,gp,age,safeName:String,icon};
 containsItems(run(`${stock};return stock();`,env),[green,black],20);
 const collection=operations.slice(operations.indexOf(' function heldIds(){'),operations.indexOf(' function moneyPrice('));
 const log=run(`${collection};return collectionLog();`,{bots:env.bots,itemList:[[1135,green.name,'Armour'],[2503,black.name,'Armour']],itemListError:'',logCat:'Armour',logQuery:'',E,nf,safeName:String,icon});
 containsItems(log,[green,black]);
 const flow=operations.slice(operations.indexOf('  function flowBoxes(kind){'),operations.indexOf("\nif(activityFilter==='shots')"));
 const loot=run(`${flow};return flowBoxes('loot');`,{bots:()=>[{name:'Worker',flow:{at:2,since:1,loot:[green,black,note],used:[]}}],moneyPrice:()=>null,E,nf,gp,age,safeName:String,icon});
 containsItems(loot);
});
