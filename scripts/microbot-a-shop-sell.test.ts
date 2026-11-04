import {test,expect} from 'bun:test';
import {validateShopSale,shopSaleEffect,runShopSale,type ShopSaleOptions} from './microbot-a-shop-sell';
const o:ShopSaleOptions={item:1205,quantity:2,minimumUnit:2,reserve:3,shopTitle:'General Store',cap:40};
test('sale price, explicit quantity and reserve limits validate before login',()=>{expect(()=>validateShopSale({...o,quantity:Infinity})).toThrow();expect(()=>validateShopSale({...o,item:995})).toThrow();expect(()=>validateShopSale({...o,minimumUnit:0})).toThrow();});
test('merchant receipt preserves unrelated kit and exact coins',()=>{expect(shopSaleEffect(1205,3,{1205:5,995:7,590:1},{1205:4,995:10,590:1})).toBe(true);expect(shopSaleEffect(1205,3,{1205:5,995:7,590:1},{1205:4,995:10})).toBe(false);});
test('staged native wrapper sells unitwise at observed prices and preserves reserve',async()=>{
 let tick=0,held=5,coins=7,open=true,sold=0;const p={lifeId:1},inventory=()=>[{id:1205,count:held,slot:0},{id:995,count:coins,slot:1},{id:590,count:1,slot:2}];
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),sdk:{getInventory:inventory,getSkill:()=>({level:30}),getState:()=>({player:p,inventory:inventory(),shop:{isOpen:open,title:'General Store',playerItems:[{id:1205,slot:0,count:held,sellPrice:3}]}})},bot:{sellToShop:async(item:any,n:number)=>{expect(item.id).toBe(1205);expect(n).toBe(1);held--;coins+=3;sold++;tick++;return{success:true,amountSold:1}},closeShop:async()=>{open=false;return{success:true}}}};
 expect(await runShopSale(s,o)).toMatchObject({ok:true,sold:2,coins:6,remaining:3,conserved:true});expect(sold).toBe(2);
 held=5;coins=7;open=true;sold=0;expect(await runShopSale(s,{...o,minimumUnit:4})).toMatchObject({ok:false,sold:0,stop:'price floor'});expect(sold).toBe(0);
});
