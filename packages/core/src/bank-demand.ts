import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
export interface DemandNear { x:number; z:number; radius:number }
// Cooked/noted forms only. Raw and burnt sharks never satisfy food demand.
export const COOKED_FOOD_IDS = new Set([329,330,333,334,379,380,385,386]);
export const COOKED_FOOD = /^(trout|salmon|lobster|shark)$/i;
export function foodStock(rows:readonly {id:number;count:number}[]) {
    return rows.reduce((n,i)=>n+(COOKED_FOOD_IDS.has(i.id)?i.count:0),0);
}
export function selectCookedFoodSource(names:readonly string[],statuses:readonly any[],owned:ReadonlySet<string>,now:number,minimum=1,server='rs-sdk-demo.fly.dev'):string|undefined {
    if(!Number.isSafeInteger(minimum)||minimum<1||names.some(n=>!owned.has(n.toLowerCase())||!/^[A-Za-z0-9_ -]{1,12}$/.test(n)))return;
    return names.flatMap(name=>{
        const s=statuses.find(s=>typeof s?.name==='string'&&s.name.toLowerCase()===name.toLowerCase()&&s.server===server);
        if(!s||s.result||!Number.isFinite(s.at)||now-s.at<0||now-s.at>=30000||!Number.isFinite(s.bankAt)||s.bankAt<=0||s.bankAt>now
            ||!Array.isArray(s.bank)||!s.bank.every((i:any)=>Number.isSafeInteger(i?.id)&&i.id>=0&&Number.isSafeInteger(i.count)&&i.count>0))return [];
        const stock=foodStock(s.bank);return Number.isSafeInteger(stock)&&stock>=minimum?[{name,stock}]:[];
    }).sort((a,b)=>b.stock-a.stock)[0]?.name;
}
export function cookedFoodRestock(name:string,s:any,now:number,server='rs-sdk-demo.fly.dev'):number|undefined {
    const rows=(v:any)=>Array.isArray(v)&&v.every(i=>Number.isSafeInteger(i?.id)&&i.id>=0&&Number.isSafeInteger(i.count)&&i.count>0);
    if(typeof s?.name!=='string'||s.name.toLowerCase()!==name.toLowerCase()||s.server!==server||s.result||!Number.isFinite(s.at)||now-s.at<0||now-s.at>=30000
        ||!Number.isFinite(s.bankAt)||s.bankAt<=0||s.bankAt>now||!rows(s.bank)||!rows(s.inventory))return;
    const stock=foodStock(s.bank)+foodStock(s.inventory);return Number.isSafeInteger(stock)?stock>=80?0:160-stock:undefined;
}
export function hasDelivery(status: any, now=Date.now(), near?: DemandNear): boolean {
    return !!status && !status.result && Number.isFinite(status.at) && now-status.at>=0 && now-status.at<30_000
        && (!near || (status.pos?.level===0 && Math.max(Math.abs(status.pos.x-near.x),Math.abs(status.pos.z-near.z))<=near.radius))
        && (status.inventory??[]).some((i:any)=>i.count>0&&!/^coins$/i.test(i.name));
}
export function deliveryWaiting(names: string[], near?: DemandNear): boolean {
    return names.some(name=>{
        if(!/^[A-Za-z0-9_ -]{1,12}$/.test(name)) return false;
        try { return hasDelivery(JSON.parse(readFileSync(resolve(import.meta.dir,'../../../.practice/status',`${name}.json`),'utf8')),Date.now(),near); }
        catch { return false; }
    });
}

// A payout recipient may carry only coins, so it has no incoming delivery.
// Its request is demand only while that exact live account is active at the bank.
export function hasPayout(name: string, status: any, request: any, requestAt: number, now=Date.now(), near?: DemandNear, server='rs-sdk-demo.fly.dev'): boolean {
    return /^[A-Za-z0-9_ -]{1,12}$/.test(name) && typeof status?.name === 'string' && status.name.toLowerCase() === name.toLowerCase()
        && status.server === server && !status.result && Number.isFinite(status.at)
        && now-status.at>=0 && now-status.at<30_000
        && !!near && [near.x,near.z,near.radius].every(Number.isFinite) && near.radius>=0
        && status.pos?.level===0 && Math.max(Math.abs(status.pos.x-near.x),Math.abs(status.pos.z-near.z))<=near.radius
        && Number.isFinite(requestAt) && requestAt>0 && now-requestAt>=0 && now-requestAt<=180_000
        && Array.isArray(request?.items) && request.items.length>0 && request.items.every((i:any)=>
            i && typeof i.name==='string' && i.name.trim().length>0 && Number.isSafeInteger(i.count) && i.count>0);
}

export function payoutWaiting(names: string[], near?: DemandNear): boolean {
    return names.some(name=>{
        if(!/^[A-Za-z0-9_ -]{1,12}$/.test(name)) return false;
        try {
            const request = resolve(import.meta.dir,'../../../.practice/withdraw',`${name}.json`);
            const status = resolve(import.meta.dir,'../../../.practice/status',`${name}.json`);
            return hasPayout(name, JSON.parse(readFileSync(status,'utf8')), JSON.parse(readFileSync(request,'utf8')), statSync(request).mtimeMs, Date.now(), near);
        } catch { return false; }
    });
}
