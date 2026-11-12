import {test,expect} from 'bun:test';
import {courierFoodReady,incomingCookedFood,receiveFoodAtBank,FOOD_ORDER,FRAIL_FLOOR,FRAIL_HP,FRAIL_RESERVE,foodReserve,guardHit,noKnightReason} from './goldfarm';
import {selectFoodToEat,calcEatAt} from './goldfarm-stable';
import {GOLDFARM_FOOD,GOLDFARM_FRAIL} from '../packages/planner/src/autopilot';
test('an idle pass names the first thing that keeps every knight from a pick',()=>{
    const k=(inRange:boolean,reachable=true,banned=false,avoided=false)=>({inRange,reachable,banned,avoided});
    expect(noKnightReason([])).toBe('none');
    expect(noKnightReason([k(false),k(false)])).toBe('far');
    expect(noKnightReason([k(true,false),k(false)])).toBe('unreachable');
    expect(noKnightReason([k(true,true,true),k(true,false)])).toBe('banned');
    expect(noKnightReason([k(true,true,false,true),k(true,true,true)])).toBe('avoided');
});
test('incoming sharks and shark notes count as food, raw and burnt do not',()=>{
    expect(incomingCookedFood([{id:385,count:5}],[{id:385,count:8},{id:386,count:20},{id:383,count:30},{id:387,count:3}])).toBe(23);
});
test('a thief with few Hitpoints restocks while it still holds a reserve, and any other thief at the floor',()=>{
    expect(foodReserve(10)).toBe(FRAIL_RESERVE);
    expect(foodReserve(FRAIL_HP-1)).toBe(FRAIL_RESERVE);
    expect(foodReserve(FRAIL_HP)).toBe(FRAIL_FLOOR);
    expect(foodReserve(99)).toBe(FRAIL_FLOOR);
    expect(FRAIL_RESERVE).toBeGreaterThan(FRAIL_FLOOR);
});
test('a fall in Hitpoints with no pick of its own is a guard hit',()=>{
    expect(guardHit(10,7,false)).toBe(true);
    // A failed pick in the pass explains the fall.
    expect(guardHit(10,7,true)).toBe(false);
    expect(guardHit(7,7,false)).toBe(false);
    // A bite raised it.
    expect(guardHit(6,10,false)).toBe(false);
});
test('the planner keeps a frail thief off the knights by the numbers and the foods of this worker',()=>{
    expect(GOLDFARM_FRAIL.hitpoints).toBe(FRAIL_HP);
    expect(GOLDFARM_FRAIL.count).toBe(FRAIL_FLOOR);
    expect(GOLDFARM_FRAIL.of).toBe(GOLDFARM_FOOD);
    // Each food of the planner's list is one food that the worker eats, and each food of the worker is on the list.
    expect(GOLDFARM_FOOD.every(name=>FOOD_ORDER.filter(re=>re.test(name)).length===1)).toBe(true);
    expect(FOOD_ORDER.every(re=>GOLDFARM_FOOD.filter(name=>re.test(name)).length===1)).toBe(true);
});
import type {Session} from '../packages/core/src/inprocess';
const now=100000,owners=new Set(['courier']),live={name:'Courier',server:'rs-sdk-demo.fly.dev',at:now-1000,result:'',pos:{x:2654,z:3283,level:0},inventory:[{id:330,name:'Salmon',count:50}]};
test('only configured authenticated same-server fresh active bank-near courier with real cooked notes wakes healthy farm',()=>{
    const ready=(status:any,owned=owners,tick=120,last=0)=>courierFoodReady(status,'Courier','rs-sdk-demo.fly.dev',owned,now,tick,last);
    expect(ready(live)).toBe(true);
    for(const change of [{name:'Foreign'},{server:'localhost:8888'},{server:undefined},{at:now-30000},{at:now+1},{result:'ok stopped'},
        {pos:{x:2654,z:3300,level:0}},{pos:{x:2654,z:3283,level:1}},
        {inventory:[{id:329,name:'Salmon',count:50}]},{inventory:[{id:333,name:'Trout',count:2}]},
        {inventory:[{id:331,name:'Raw salmon',count:50}]},{inventory:[{id:330,name:'Salmon',count:0}]}])expect(ready({...live,...change})).toBe(false);
    expect(ready(live,new Set())).toBe(false);expect(ready(live,owners,119,0)).toBe(false);expect(ready(live,owners,120,0)).toBe(true);
});
test('trade accounting counts only new actual incoming food, never the existing healthy pack',()=>{
    const pack=[{id:333,count:26},{id:330,count:5}];
    expect(incomingCookedFood(pack,pack)).toBe(0);expect(incomingCookedFood(pack,[{id:333,count:26},{id:330,count:15}])).toBe(10);
    expect(incomingCookedFood(pack,[{id:333,count:26},{id:330,count:5},{id:331,count:100}])).toBe(0);
});
test('receiver banks earned coins before accepting two cooked note stacks into a26food pack',async()=>{
    let tick=0;const pack:any[]=[...Array.from({length:26},()=>({id:333,count:1})),{id:995,count:100}];
    const s:any={tick:()=>tick,sdk:{getInventory:()=>pack},bot:{serveTrades:async()=>{
        expect(28-pack.length).toBeGreaterThanOrEqual(2);
        pack.push({id:330,count:15},{id:334,count:11});tick++;
        return{reason:'complete',message:'received'};
    }}};
    const r=await receiveFoodAtBank(s,'Courier',20000,async()=>{const i=pack.findIndex(i=>i.id===995);if(i>=0)pack.splice(i,1);},()=>true);
    expect(r.incoming).toBe(26);
});

test('short rendezvous timeout preserves existing food and returns normal-work availability; legacy timeout remains selectable',async()=>{
    for(const timeout of [20000,180000]){
        let tick=0,seen=0,refills=0;const pack:any[]=[{id:333,name:'Trout',count:26}];
        const s:any={tick:()=>tick,sdk:{getInventory:()=>pack},bot:{serveTrades:async(o:any)=>{seen=o.timeout;expect(o.from.test('Courier')).toBe(true);tick++;return{reason:'timeout',message:'no trade'};}}};
        const r=await receiveFoodAtBank(s as Session,'Courier',timeout,async()=>{refills++;},()=>pack[0].count>=2);
        expect(r.incoming).toBe(0);expect(r.available).toBe(true);expect(seen).toBe(timeout);expect(refills).toBe(2);expect(pack[0].count).toBe(26);
    }
});

test('food rendezvous yields to a pending cash request from its same partner',async()=>{
    let tick=0,pending=false,refills=0;
    const s:any={tick:()=>tick,sdk:{getInventory:()=>[]},bot:{serveTrades:async(o:any)=>{
        expect(o.until()).toBe(false);pending=true;expect(o.until()).toBe(true);tick++;
        return{reason:'until',message:'funding pending'};
    }}};
    const r=await receiveFoodAtBank(s,'Courier',45000,async()=>{refills++;},()=>false,()=>pending);
    expect(r.incoming).toBe(0);expect(r.reason).toBe('until');expect(refills).toBe(2);
});

test('selectFoodToEat matches HP deficit to best food avoiding overheal waste', () => {
    const makeFood = (name: string, count = 1) => ({ name, count, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] });
    const items = [
        makeFood('Lobster'), // heals 12
        makeFood('Salmon'),  // heals 9
        makeFood('Trout'),   // heals 7
        makeFood('Bread'),   // heals 5
        makeFood('Cake'),    // heals 4
        makeFood('Chocolate slice'), // heals 2
    ];

    // Loss = 4: Cake heals 4, exactly matches deficit with 0 waste
    expect(selectFoodToEat(items, 4)?.name).toBe('Cake');

    // Loss = 5: Bread heals 5, exactly matches deficit with 0 waste
    expect(selectFoodToEat(items, 5)?.name).toBe('Bread');

    // Loss = 6: Bread heals 5 <= 6, best food under deficit
    expect(selectFoodToEat(items, 6)?.name).toBe('Bread');

    // Loss = 7: Trout heals 7, matches deficit
    expect(selectFoodToEat(items, 7)?.name).toBe('Trout');

    // Loss = 10: Salmon heals 9 <= 10, best under deficit
    expect(selectFoodToEat(items, 10)?.name).toBe('Salmon');

    // Loss = 12: Lobster heals 12, matches deficit
    expect(selectFoodToEat(items, 12)?.name).toBe('Lobster');

    // Loss = 1: All foods heal more than 1, picks smallest food (Chocolate slice 2)
    expect(selectFoodToEat(items, 1)?.name).toBe('Chocolate slice');

    // Only big food available: loss = 6, only lobster -> picks lobster rather than starving
    expect(selectFoodToEat([makeFood('Lobster')], 6)?.name).toBe('Lobster');

    // Non-food items ignored
    expect(selectFoodToEat([{ name: 'Coins', count: 100 }], 6)).toBeUndefined();
});

test('calcEatAt guarantees never dying from Knight fail damage (DMG=3) while maximizing food efficiency', () => {
    // For 10 HP thieves:
    // eatAt = 4. Taking 3 damage leaves 1 HP (never dies).
    // Loss is 6 HP, so 4 HP cakes or 5 HP bread heal with 0 waste.
    expect(calcEatAt(10)).toBe(4);
    expect(calcEatAt(9)).toBe(4);

    // For higher HP thieves (e.g. 20 HP, 50 HP):
    expect(calcEatAt(20)).toBe(8);
    expect(calcEatAt(50)).toBe(20);
});

