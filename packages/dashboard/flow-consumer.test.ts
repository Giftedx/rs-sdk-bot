import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {flowView,trackFlow} from './flow';
import {buildItemPrices,projectItemPrices} from './item-prices';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const operations=readFileSync(new URL('./operations.js',import.meta.url),'utf8');
const pricingSource=shell.slice(shell.indexOf('  const priceName='),shell.indexOf('  // Item stats (RuneLite'));
const moneySource=operations.slice(operations.indexOf(' function moneyPrice('),operations.indexOf(' const stockTabs='));
const flowBoxesSource=operations.slice(operations.indexOf('  function flowBoxes(kind){'),operations.indexOf("if(activityFilter==='shots')"));
const status=(name:string,at:number,inventory:any[])=>({name,server:'demo',started:1,at,inventory,equipment:[],equipmentObserved:true,bankAt:50,hp:{now:50,max:99}});

test('observed flow identities reach activity value, screenshots and logout while legacy variants stay unpriced',()=>{
 const flows=new Map();
 const spent={id:104,baseId:103,name:'Ring (noted)',count:1};
 trackFlow(flows,status('Exact',100,[spent]));
 trackFlow(flows,status('Exact',103,[{id:101,name:'Ring',count:2}]));
 const before=structuredClone(flowView(flows,'Exact'))!;
 const inventory=[{id:101,name:'Ring',count:3},{id:102,name:'Ring',count:2}];
 trackFlow(flows,status('Exact',106,inventory));
 trackFlow(flows,status('Legacy',100,[]));
 trackFlow(flows,status('Legacy',106,[{name:'Ring',count:4}]));
 const exact=flowView(flows,'Exact')!,legacy=flowView(flows,'Legacy')!;
 expect(exact.loot).toEqual(expect.arrayContaining([{id:101,name:'Ring',count:3},{id:102,name:'Ring',count:2}]));
 expect(exact.used).toEqual([{id:104,baseId:103,name:'Ring',count:1}]);
 expect(legacy.loot).toEqual([{name:'Ring',count:4}]);

 const catalogue=[{id:101,name:'Ring'},{id:102,name:'Ring'},{id:103,name:'Ring'}];
 const allPrices=buildItemPrices(catalogue.map((item,index)=>({...item,basePrice:[100,900,3000][index]})),catalogue);
 expect(allPrices.byName.ring).toBeUndefined();
 // The spent item has left the pack. Its retained flow row must still request its exact value.
 expect(projectItemPrices(allPrices,inventory).byId[103]).toBeUndefined();
 const projected=projectItemPrices(allPrices,[...inventory,...exact.loot,...exact.used,...legacy.loot]);
 expect(projected.byId[101]?.value).toBe(100);expect(projected.byId[102]?.value).toBe(900);expect(projected.byId[103]?.value).toBe(3000);
 const exactBot={name:'Exact',inventory,flow:exact},legacyBot={name:'Legacy',inventory:[{name:'Ring',count:4}],flow:legacy};
 const S={bots:[exactBot,legacyBot],economy:{itemPricesById:projected.byId,itemPricesByName:projected.byName,itemValues:{Ring:99999},supplies:[]}};
 const window:any={};
 const browser=new Function('S','window',`${pricingSource};return {price,priceKey};`)(S,window);
 expect(browser.price(exact.used[0])?.value).toBe(3000);expect(browser.price(legacy.loot[0])).toBeNull();
 const env:any={S,window,bots:()=>S.bots,E:String,nf:String,gp:String,safeName:String,age:String,icon:()=>''};
 const flowBoxes=new Function(...Object.keys(env),`${moneySource}${flowBoxesSource};return flowBoxes;`)(...Object.values(env));
 const loot=flowBoxes('loot'),used=flowBoxes('supplies');
 expect(loot).toContain('<strong>2100 gp ');expect(loot).toContain('Ring × 3 · 300 gp');expect(loot).toContain('Ring × 2 · 1800 gp');
 expect(loot).toContain('net −900 gp (loot less supplies)');expect(used).toContain('<strong>3000 gp ');expect(used).toContain('Ring × 1 · 3000 gp');
 expect(loot).toContain('Ring × 4 · unpriced');expect(loot).toContain('<strong>0 gp + ?');expect(loot).toContain('1 unpriced item kinds');expect(loot).not.toContain('99999');

 const shots:string[]=[],watched:any={name:'Exact',flow:before};
 const shotsSource=shell.slice(shell.indexOf('  function lootShots(){'),shell.indexOf('  window.atlasShots='));
 const lootShots=new Function('account','lootSeen','shotCfg','price','priceKey','shotFor','gp',`${shotsSource};return lootShots;`)
  (()=>watched,new Map(),{loot:500},browser.price,browser.priceKey,(_bot:any,_kind:any,text:string)=>shots.push(text),String);
 lootShots();watched.flow=exact;lootShots();expect(shots).toEqual(['Ring × 2 (1800)']);
 watched.name='Legacy';watched.flow={...legacy,loot:[]};lootShots();watched.flow=legacy;lootShots();expect(shots.length).toBe(1);

 const sessionSource=shell.slice(shell.indexOf('  function sessionText(name){'),shell.indexOf('  function moments(){'));
 const sessionText=new Function('sessionXp','sessionLast','price','nf','gp','dur',`${sessionSource};return sessionText;`)
  (new Map([['Exact',{}],['Legacy',{}]]),new Map([['Exact',{xp:{},loot:exact.loot}],['Legacy',{xp:{},loot:legacy.loot}]]),browser.price,String,String,String);
 expect(sessionText('Exact')).toBe(': 3 Ring, ≈ 2100 gp of loot');expect(sessionText('Legacy')).toBe(': 4 Ring, ≈ 0 gp of loot + 1 unpriced');
});
