import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
export interface DemandNear { x:number; z:number; radius:number }
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
export function hasPayout(name: string, status: any, request: any, requestAt: number, now=Date.now(), near?: DemandNear): boolean {
    return /^[A-Za-z0-9_ -]{1,12}$/.test(name) && typeof status?.name === 'string' && status.name.toLowerCase() === name.toLowerCase()
        && status.server === 'rs-sdk-demo.fly.dev' && !status.result && Number.isFinite(status.at)
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
