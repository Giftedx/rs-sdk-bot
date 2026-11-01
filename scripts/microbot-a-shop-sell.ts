// Finite staged merchant sale: bun scripts/microbot-a-shop-sell.ts <account> <item-id> <quantity> <minimum-unit-gp> <item-reserve> <exact-shop-title> [cap=600].
// Uses native SDK sellToShop, one observed unit per price check. No world hopping, travel or implicit surplus policy.
import {existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {watchProductionLife} from './microbot-c-lifetime';
export interface ShopSaleOptions{item:number;quantity:number;minimumUnit:number;reserve:number;shopTitle:string;cap:number;stop?:()=>boolean}
export function validateShopSale(o:ShopSaleOptions){
 if(![o.item,o.quantity,o.minimumUnit,o.reserve,o.cap].every(Number.isSafeInteger)||o.item<1||o.item===995||o.quantity<1||o.quantity>1000||o.minimumUnit<1||o.minimumUnit>2147483647||o.reserve<0||o.cap<1||o.cap>100000||!o.shopTitle||o.shopTitle.length>100)throw Error('invalid finite merchant sale');return o;
}
export function shopSaleEffect(item:number,quote:number,b:Record<number,number>,a:Record<number,number>){
 const ids=new Set([...Object.keys(b),...Object.keys(a)].map(Number));
 return [...ids].every(id=>(a[id]??0)-(b[id]??0)===(id===item?-1:id===995?quote:0));
}
export async function runShopSale(s:Session,o:ShopSaleOptions){
 validateShopSale(o);const life=watchProductionLife(s,o.stop),start=s.tick();
 const state=()=>s.sdk.getState(),counts=()=>{const r:Record<number,number>={};for(const i of s.sdk.getInventory())r[i.id]=(r[i.id]??0)+i.count;return r;};
 const over=()=>life.stopped()||s.tick()-start>=o.cap;
 const initial=counts();if((initial[o.item]??0)-o.quantity<o.reserve)throw Error('sale quantity would spend reserved stock');
 let sold=0,coins=0,failure='',stop='target';
 try{
 while(sold<o.quantity&&!over()){
  const shop=state()?.shop;if(!shop?.isOpen||shop.title!==o.shopTitle)throw Error('exact staged shop is not open');
  const item=shop.playerItems.find(i=>i.id===o.item),quote=item?.sellPrice;
  if(!item||!Number.isSafeInteger(quote)||quote!<o.minimumUnit){stop='price floor';break;}
  const before=counts();if((before[o.item]??0)<=o.reserve){stop='reserve';break;}
  const result=await s.bot.sellToShop(item,1);
  await waitUntil(s,()=>over()||(counts()[o.item]??0)===(before[o.item]??0)-1&&(counts()[995]??0)===(before[995]??0)+quote!,{timeoutTicks:Math.min(10,Math.max(1,o.cap-(s.tick()-start)))});
  if(result.amountSold!==1||!shopSaleEffect(o.item,quote!,before,counts()))throw Error('merchant exact item debit/coin credit missing');
  sold++;coins+=quote!;console.log('MERCHANT_SALE '+JSON.stringify({item:o.item,sold,unitPrice:quote,coins,tick:s.tick()}));
 }
 if(sold!==o.quantity&&stop==='target')stop=life.reason()||'cap';
 }catch(e){failure=String(e);stop='failure';}
 finally{try{if(!life.stopped()){await s.bot.closeShop();if(!await waitUntil(s,()=>!state()?.shop.isOpen,{timeoutTicks:8}))throw Error('merchant shop close missing');}}catch(e){failure+='; '+String(e);}}
 const final=counts(),ids=new Set([...Object.keys(initial),...Object.keys(final)].map(Number));
 const conserved=[...ids].every(id=>(final[id]??0)-(initial[id]??0)===(id===o.item?-sold:id===995?coins:0));
 return{ok:!failure&&!life.stopped()&&sold===o.quantity&&conserved,stop,failure,item:o.item,requested:o.quantity,sold,coins,reserve:o.reserve,remaining:final[o.item]??0,conserved,ticks:s.tick()-start};
}
if(import.meta.main){let s:Session|undefined,stopped=false;try{
 const [account,item,quantity,floor,reserve,shopTitle,cap]=process.argv.slice(2);if(!account)throw Error('account required');
 const o=validateShopSale({item:Number(item),quantity:Number(quantity),minimumUnit:Number(floor),reserve:Number(reserve),shopTitle:shopTitle??'',cap:Number(cap??600),stop:()=>stopped||existsSync('.practice/stop-microbot-shop-sale')});
 s=await openBot(account,{onStop:async()=>{stopped=true;}});const r=await runShopSale(s,o);console.log('MERCHANT_SALE_RESULT '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));
 }catch(e){await finish(s?[s]:[],false,String(e));}}
