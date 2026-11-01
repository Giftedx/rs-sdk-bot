import{test,expect}from'bun:test';
import{nativeMerchant,validateShopTrip,shopTripProfile,shopTripStop,type ShopTripJob}from'./microbot-shop-trip';
const job=():ShopTripJob=>({merchant:'alkharid-general',item:1205,minimumUnit:1,target:4,batch:2,cap:1000,returnTicks:200,members:false,reserve:2});
function fixture(title=nativeMerchant('alkharid-general').title,price=4){
 let tick=0,sales=0,opened=0;const inventory=[{id:1205,count:2,slot:0},{id:995,count:0,slot:1},{id:2357,count:1,slot:2}],shop={isOpen:false,title,playerItems:[{id:1205,slot:0,sellPrice:price}]};
 const s:any={name:'fixture',tick:()=>tick,ended:new Promise(()=>{}),onTick:(fn:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;fn();next();}});next();return()=>{active=false;};},sdk:{getInventory:()=>inventory,getSkill:()=>({level:50}),getState:()=>({player:{lifeId:1},shop,nearbyNpcs:[{id:524,index:7,distance:1,reachable:true}]}),sendCloseModal:async()=>{shop.isOpen=false;return{success:true};}},bot:{openShop:async(n:any)=>{expect(n.id).toBe(524);opened++;shop.isOpen=true;return{success:true};},closeShop:async()=>{shop.isOpen=false;return{success:true};},sellToShop:async()=>{sales++;inventory[0]!.count--;inventory[1]!.count+=price;return{amountSold:1};}}};return{s,inventory,counts:()=>({sales,opened}),shop};
}
test('merchant profile preserves explicit bank reserve and native route, rejects unsupported inputs',()=>{
 const j=job();expect(()=>validateShopTrip(j)).not.toThrow();const p=shopTripProfile({}as any,j);expect(p.inputs).toEqual({1205:1});expect(p.outputs).toEqual([995]);expect(p.bank).toEqual({x:3269,z:3167,level:0});expect(p.site).toEqual({x:3314,z:3180,level:0});expect(j.reserve).toBe(2);
 for(const change of [{merchant:'eval'},{item:1206},{item:950},{item:995},{minimumUnit:0},{batch:1001},{reserve:-1},{cap:200}])expect(()=>validateShopTrip({...j,...change}as ShopTripJob)).toThrow();
});
test('profile opens exact merchant and uses real staged seller exact stock/coin conservation',async()=>{const f=fixture();expect(await shopTripProfile(f.s,job()).run(2,100,()=>false)).toBe(2);expect(f.counts()).toEqual({sales:2,opened:1});expect(f.inventory.map(i=>i.count)).toEqual([0,8,1]);expect(f.shop.isOpen).toBe(false);});
test('wrong title, price floor and stop prevent surplus dispatch',async()=>{
 for(const [title,price,stop]of [['Other shop',4,false],[nativeMerchant('alkharid-general').title,0,false],[nativeMerchant('alkharid-general').title,4,true]]as const){const f=fixture(title,price);await expect(shopTripProfile(f.s,job()).run(2,100,()=>stop)).rejects.toThrow();expect(f.counts().sales).toBe(0);expect(f.inventory[0]!.count).toBe(2);}
 expect(shopTripStop('fixture',false,p=>p==='.practice/stop-all')).toBe(true);expect(shopTripStop('fixture',false,()=>false)).toBe(false);
});
test('caller-declared native merchants bind config, inventory and exact spawn, with AK-only silk rule',()=>{
 const bank={x:3208,z:3220,level:2},site={x:3231,z:3203,level:0};
 const bob=validateShopTrip({...job(),merchant:'bob',item:1351,bank,site});expect(bob.npc).toBe(519);expect(bob.title).toBe("Bob's Brilliant Axes.");expect(bob.inventory).toBe('axeshop');expect(bob.bank).toEqual(bank);
 const varrock={...job(),merchant:'generalshopkeeper2',item:950,bank:{x:3185,z:3436,level:0},site:{x:3218,z:3415,level:0}};
 expect(validateShopTrip(varrock).inventory).toBe('generalshop2');
 for(const change of [{merchant:'bob'},{merchant:'hans',bank,site},{merchant:'made_up',bank,site},{merchant:'bob;eval',bank,site},{merchant:'bob',bank,site:{x:3300,z:3203,level:0}},{merchant:'bob',bank,site:{...site,level:1}},{merchant:'bob',bank,site,item:1205}])expect(()=>validateShopTrip({...job(),...change})).toThrow();
});
