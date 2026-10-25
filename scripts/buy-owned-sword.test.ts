import {test,expect} from 'bun:test';
import {runOwnedSword,swordQuote,swordTileSafe} from './buy-owned-sword';
import type {Session} from '../packages/core/src/inprocess';
import {expandPath} from '../packages/core/src/walk';
const config={sellMultiplier:1000,buyMultiplier:600,haggle:20};
const shelf=(count=2)=>({id:1287,name:'Adamant sword',count,slot:5,baseCost:2080,buyPrice:2080,sellPrice:1248});
test('actual shop formula prices one sword at2080/full or2121/one left, rather than generic six-unit budget',()=>{
    expect(swordQuote(shelf(),config).price).toBe(2080);expect(swordQuote(shelf(1),config)).toEqual({price:2121,reportedBuyPrice:2080});
    expect(()=>swordQuote(shelf(0),config)).toThrow();expect(()=>swordQuote(shelf(),undefined)).toThrow();
});
test('corridor permits known bank/shop and excludes southern thief/dark-wizard shortcuts and other floors',()=>{
    expect(swordTileSafe({x:3185,z:3436})).toBe(true);expect(swordTileSafe({x:3203,z:3397})).toBe(true);
    expect(swordTileSafe({x:3185,z:3395})).toBe(false);expect(swordTileSafe({x:3220,z:3380})).toBe(false);expect(swordTileSafe({x:3203,z:3397,level:1})).toBe(false);
});
test('reviewed actual SDK eastern shop approach and return are permitted, adjacent unreviewed cells stay refused',()=>{
    const forward=[{x:3197,z:3418},{x:3202,z:3413},{x:3202,z:3412},{x:3210,z:3404},{x:3210,z:3400},{x:3209,z:3399},{x:3206,z:3399},{x:3205,z:3398},{x:3203,z:3398},{x:3203,z:3400}];
    const backward=[{x:3203,z:3399},{x:3203,z:3398},{x:3207,z:3398},{x:3208,z:3399},{x:3209,z:3399},{x:3210,z:3400},{x:3210,z:3405},{x:3198,z:3417},{x:3196,z:3417},{x:3195,z:3418}];
    expect(expandPath({x:3195,z:3418},forward).every(swordTileSafe)).toBe(true);
    expect(expandPath({x:3203,z:3399},backward).every(swordTileSafe)).toBe(true);
    expect(swordTileSafe({x:3211,z:3404})).toBe(false);expect(swordTileSafe({x:3210,z:3398})).toBe(false);expect(swordTileSafe({x:3209,z:3407})).toBe(false);
});
function fixture(o:{stock?:number;fakeBuy?:boolean}={}){
    let tick=0,open=false,shop=false,generation=0,buyCalls=0;const listeners=new Set<()=>void>();
    const inv:any[]=[{id:333,name:'Trout',count:1,slot:0},{id:333,name:'Trout',count:1,slot:1}];
    const bank:any[]=[{id:995,name:'Coins',count:2600,slot:7},{id:329,name:'Salmon',count:30,slot:8},{id:1277,name:'Bronze sword',count:1,slot:9}];
    const state=()=>({player:{worldX:3185,worldZ:3436,level:0,lifeId:1,respawnCount:0},equipment:[],bank:{isOpen:open,items:bank},shop:{isOpen:shop,shopItems:[shelf(o.stock??1)],shopConfig:config},nearbyNpcs:[{id:551,index:10,x:3203,z:3397,distance:1,optionsWithIndex:[{text:'Trade',opIndex:3}]}]});
    const timer=setInterval(()=>{tick++;for(const f of [...listeners])f();},1),walks:number[][]=[];
    const s:any={name:'fixture',tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},ended:new Promise(()=>{}),bankObservation:()=>open?{generation,at:tick+1,items:bank}:null,
        sdk:{getState:state,getInventory:()=>inv,getSkill:()=>({level:10})},
        bot:{dismissBlockingUI:async()=>{},openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},
            withdrawItem:async(item:any,n:number,options:any)=>{expect(typeof item).toBe('object');expect(item).toBe(bank[0]);expect(item.slot).toBe(7);expect(options.asNote).toBe(false);item.count-=n;inv.push({id:995,name:'Coins',count:n,slot:2});generation++;return{success:true};},
            depositItem:async(item:any)=>{let row=bank.find(i=>i.id===item.id);if(!row){row={...item,count:0};bank.push(row);}row.count+=item.count;inv.splice(inv.indexOf(item),1);generation++;return{success:true};},
            openShop:async(npc:any)=>{expect(npc.id).toBe(551);shop=true;return{success:true};},closeShop:async()=>{shop=false;return{success:true};},
            buyFromShop:async(item:any,n:number)=>{buyCalls++;expect(item.id).toBe(1287);expect(n).toBe(1);if(!o.fakeBuy){inv.find(i=>i.id===995).count-=swordQuote(item,config).price;inv.push({id:1287,name:'Adamant sword',count:1,slot:3});}return{success:true,amountBought:1};}}};
    return{s:s as Session,bank,inv,walks,walk:async(x:number,z:number,tol:number)=>{walks.push([x,z,tol]);return true;},buyCalls:()=>buyCalls,dispose:()=>clearInterval(timer)};
}
test('one observed sword at2121 is banked,479coins remain, and original food/kit are preserved',async()=>{
    const f=fixture();try{const r=await runOwnedSword(f.s,{cap:100,maximumSpend:2500,walk:f.walk});
        expect(r).toMatchObject({ok:true,targetMet:true,bought:1,banked:1,spent:2121,price:2121,coinsRemaining:479,preserved:true,hpMin:10});
        expect(f.buyCalls()).toBe(1);expect(f.bank.find(i=>i.id===329).count).toBe(30);expect(f.bank.find(i=>i.id===1277).count).toBe(1);
        expect(f.inv.filter(i=>i.id===333).length).toBe(2);expect(f.inv.some(i=>i.id===995||i.id===1287)).toBe(false);
        expect(f.walks[0]).toEqual([3185,3420,1]);expect(f.walks.at(-1)).toEqual([3185,3436,2]);
    }finally{f.dispose();}
});
test('over-budget shelf or empty shelf makes no purchase and returns all owned cash',async()=>{
    for(const stock of [0,1]){const f=fixture({stock});try{const r=await runOwnedSword(f.s,{cap:100,maximumSpend:2000,walk:f.walk});expect(r.ok).toBe(false);expect(f.buyCalls()).toBe(0);expect(r.coinsRemaining).toBe(2600);expect(r.preserved).toBe(true);}finally{f.dispose();}}
});
test('a success-shaped shop reply without actual sword and coin deltas cannot pass',async()=>{
    const f=fixture({fakeBuy:true});try{const r=await runOwnedSword(f.s,{cap:100,maximumSpend:2500,walk:f.walk});expect(r.ok).toBe(false);expect(r.banked).toBe(0);expect(r.coinsRemaining).toBe(2600);expect(r.preserved).toBe(true);expect(f.buyCalls()).toBe(1);}finally{f.dispose();}
});
