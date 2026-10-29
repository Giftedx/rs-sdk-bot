import {expect,test} from 'bun:test';
import {featherBatchAmount,featherPurchaseEffect,courierIslandProblem} from './courier-purchase';

test('an island courier must exceed twice the level14 scorpion before crossing',()=>{
    for(const n of [undefined,NaN,3,13,28,28.5])expect(courierIslandProblem(n)).toMatch(/combat29/);
    expect(courierIslandProblem(29)).toBeNull();
    expect(courierIslandProblem(74)).toBeNull();
});

test('shop settlement needs a matching feather credit, bounded coin debit and retained return fares',()=>{
    expect(featherPurchaseEffect(500,20,380,30,10)).toEqual({bought:10,cost:120});
    expect(featherPurchaseEffect(500,20,490,25,10)).toEqual({bought:5,cost:10});
    expect(featherPurchaseEffect(500,20,500,20,10)).toEqual({bought:0,cost:0});
    for(const row of [[500,20,490,20,10],[500,20,500,21,10],[500,20,487,21,10],[500,20,501,21,10],[500,20,480,31,10],[72,20,59,21,1],[500,20,480,19,10],[500,20,480,21,NaN]])
        expect(()=>featherPurchaseEffect(...row as [number,number,number,number,number])).toThrow();
});

test('a depleted public shop cannot spend the two return fares',()=>{
    // Gerrant: cost2, sell1000, haggle10. Stock can change between quote and checkout.
    for(const stock of [1000,750,500,50,0])for(const initial of [4,59,60,61,71,72,120,3014]){
        let coins=initial,bought=0;
        for(let batch=0;batch<20&&bought<500;batch++){
            const n=featherBatchAmount(coins,500-bought);
            if(n===0)break;
            for(let i=0;i<n;i++){
                const diff=Math.max(-5000,Math.min(1000,(stock-bought-i-1000)*10));
                coins-=Math.max(1,Math.floor(2*Math.max(100,1000-diff)/1000));
            }
            bought+=n;
            expect(coins).toBeGreaterThanOrEqual(60);
        }
        expect(bought).toBeLessThanOrEqual(500);
        if(initial<72)expect(bought).toBe(0);
    }
});

test('feather batches respect the remainder and reject unknown budgets',()=>{
    expect(featherBatchAmount(1000,3)).toBe(3);
    expect(featherBatchAmount(1000,500)).toBe(50);
    for(const value of [NaN,Infinity,-1,1.5]){
        expect(featherBatchAmount(value,500)).toBe(0);
        expect(featherBatchAmount(1000,value)).toBe(0);
    }
});
