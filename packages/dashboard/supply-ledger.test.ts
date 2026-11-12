import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
// The fleet bank's pure part: stockName and stockItems, sliced out of the page.
const code=html.slice(html.indexOf('const stockName='),html.indexOf('const stockPrice='));
const {stockItems}=new Function(`${code};return {stockItems};`)();

test('the fleet bank adds each item over banks, packs and worn gear, and lists each holder',()=>{
 const bots=[
  {name:'Alpha',side:'local',bankAt:10,at:20,bank:[{id:385,name:'Shark',count:100},{id:995,name:'Coins',count:5000}],inventory:[{id:385,name:'Shark',count:3},null],equipment:[{id:1333,name:'Rune scimitar',count:1}]},
  {name:'Bravo',side:'cloud',bankAt:5,at:6,bank:[{id:386,baseId:385,name:'Shark (noted)',count:50}],inventory:[],equipment:[]},
  {name:'Practice1',practice:true,bank:[{id:385,name:'Shark',count:999}]},
 ];
 const items=stockItems(bots),shark=items.find((i:any)=>i.name==='Shark');
 expect(shark.total).toBe(153);
 expect([...shark.ids]).toEqual([385]);
 expect(shark.holders).toEqual([
  {name:'Alpha',side:'local',bank:100,pack:3,worn:0,bankAt:10,at:20},
  {name:'Bravo',side:'cloud',bank:50,pack:0,worn:0,bankAt:5,at:6},
 ]);
 expect(items.find((i:any)=>i.name==='Rune scimitar').holders[0].worn).toBe(1);
 expect(items.some((i:any)=>i.holders.some((h:any)=>h.name==='Practice1'))).toBe(false);
});
