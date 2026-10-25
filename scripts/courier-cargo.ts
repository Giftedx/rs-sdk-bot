import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {hasDelivery, type DemandNear} from '../packages/core/src/bank-demand';

type Item={id?:number;name:string;count:number};
type SlotItem={id:number;name:string;count:number;slot:number};
export interface SeparationDeps {
    inventory():readonly SlotItem[];
    bank():readonly SlotItem[]|null;
    openBank():Promise<boolean>;
    closeBank():Promise<boolean>;
    deposit(item:SlotItem):Promise<boolean>;
    withdraw(item:SlotItem,count:number):Promise<boolean>;
    tradeNotes(count:number):Promise<{success:boolean;given:number}>;
    observed(predicate:()=>boolean):Promise<boolean>;
}

// Temporarily bank the unnoted form, making the existing name-only trade API
// unambiguous. Restore the exact original held count even after a failed trade.
// Every step checks observed IDs/counts, not just the action's success reply.
export async function separateTroutNotes(d:SeparationDeps):Promise<number> {
    const count=(items:readonly SlotItem[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const food=count(d.inventory(),333),notes=count(d.inventory(),334);
    const fail=(why:string)=>new Error(`no delivery progress: need-bank-separation ${why}`);
    if(!food||!notes||d.inventory().some(i=>/^trout$/i.test(i.name)&&i.id!==333&&i.id!==334)) throw fail('identity unknown');
    if(!await d.openBank()||!d.bank()) throw fail('bank readiness unknown');
    const bankBefore=count(d.bank()!,333);
    let problem:unknown;
    try {
        const item=d.inventory().find(i=>i.id===333);
        if(!item||!await d.deposit(item)||!await d.observed(()=>count(d.inventory(),333)===0
            &&count(d.inventory(),334)===notes&&!!d.bank()&&count(d.bank()!,333)===bankBefore+food)) throw fail('deposit not conserved');
        if(!await d.closeBank()) throw fail('cannot close bank');
        const trade=await d.tradeNotes(notes);
        if(!trade.success||trade.given!==notes||!await d.observed(()=>count(d.inventory(),333)===0&&count(d.inventory(),334)===0)) throw fail('notes transfer not verified');
    } catch(e) {problem=e;}
    finally {
        const missing=food-count(d.inventory(),333);
        if(missing<0) throw fail('restore inventory changed');
        if(missing>0) {
            if(!await d.openBank()||!d.bank()||count(d.bank()!,333)!==bankBefore+missing) throw fail('restore bank delta unknown; food remains banked');
            const item=d.bank()!.find(i=>i.id===333);
            if(!item||!await d.withdraw(item,missing)||!await d.observed(()=>count(d.inventory(),333)===food
                &&!!d.bank()&&count(d.bank()!,333)===bankBefore)) throw fail('restore incomplete; inspect banked working food');
        } else if(!d.bank()||count(d.bank()!,333)!==bankBefore) throw fail('bank conservation unknown');
        if(!await d.closeBank()) throw fail('restore cannot close bank');
    }
    if(problem) throw problem;
    return notes;
}
type DeliveryJob={account?:string;accounts?:string[];script?:string;goal?:string;env?:Record<string,string>};
export function retainedTrout(env:Record<string,string|undefined>={}):number {
    const raw=env.RETAIN_TROUT??'2';
    if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))) throw new Error('invalid RETAIN_TROUT');
    return Number(raw);
}

// ID333 is unnoted cooked Trout. Retain a count, not the whole food family.
// The SDK trade API selects by name then first matching slot; mixed note/food
// with the same display name cannot safely express this working-kit reserve.
export function courierCargo(inventory:readonly Item[], reserve:number):{items:{name:string;count:number}[];blocked:string[]} {
    const valid=inventory.filter(i=>i&&typeof i.name==='string'&&Number.isSafeInteger(i.count)&&i.count>0&&!/^coins$/i.test(i.name));
    const food=valid.filter(i=>/^trout$/i.test(i.name));
    if(reserve>0&&food.some(i=>!Number.isSafeInteger(i.id))) return {items:[],blocked:['Trout: identity unknown']};
    const unnoted=food.filter(i=>i.id===333).reduce((n,i)=>n+i.count,0);
    if(reserve>0&&unnoted>0&&food.some(i=>i.id!==333)) return {items:[],blocked:['Trout: need-bank-separation']};
    const amounts=new Map<string,{name:string;count:number}>();
    let left=reserve;
    for(const i of valid) {
        const kept=i.id===333?Math.min(left,i.count):0;
        left-=kept;
        const count=i.count-kept;
        if(count<=0) continue;
        const key=i.name.toLowerCase(), prior=amounts.get(key);
        amounts.set(key,{name:prior?.name??i.name,count:(prior?.count??0)+count});
    }
    return {items:[...amounts.values()],blocked:[]};
}

// General incoming food donors keep the core default semantics; outbound-only
// transports do not deliver to this banker. Configured note couriers project
// their reserve only when the observed run matches that job. The banker
// reads the same live plan as swarm; a missing/corrupt plan is unknown demand.
export function courierDeliveryWaiting(names:readonly string[], near?:DemandNear, jobs?:readonly DeliveryJob[],
    readStatus=(name:string):any=>JSON.parse(readFileSync(resolve(import.meta.dir,'../.practice/status',`${name}.json`),'utf8')),
    now=Date.now()):boolean {
    if(!jobs) {
        try {
            const plan=JSON.parse(readFileSync(resolve(import.meta.dir,'../swarm.json'),'utf8'));
            if(!Array.isArray(plan.jobs)) throw new Error('missing jobs');
            jobs=plan.jobs;
        } catch {console.warn('DELIVERY demand unknown: cannot read swarm plan');return false;}
    }
    return names.some(name=>{
        if(!/^[A-Za-z0-9_ -]{1,12}$/.test(name)) return false;
        try {
            const status=readStatus(name);
            const job=jobs!.find(j=>[...(j.accounts??[]),j.account??''].some(a=>a.toLowerCase()===name.toLowerCase()));
            const file=(path:string)=>path.replaceAll('\\','/').split('/').at(-1);
            const script=job?.script&&file(job.script);
            if(script==='foodcourier.ts'&&job?.env?.OUTBOUND_ONLY==='1') return false;
            if(script!=='note-courier.ts') return hasDelivery(status,now,near);
            // Account names outlive their jobs. A disabled note-courier plan can
            // coexist with a manually run outbound supplier carrying the same
            // banknotes. Bind its reserve/delivery policy to the observed run:
            // status publishes BOT_GOAL (swarm's job.goal), else the script name.
            const goal=typeof status?.goal==='string'?status.goal.trim():'';
            if(!goal || !(file(goal)===script || (!goal.endsWith('.ts')&&goal===job?.goal?.trim()))) return false;
            const cargo=courierCargo(status?.inventory??[],retainedTrout(job?.env));
            return cargo.blocked.length===0&&hasDelivery({...status,inventory:cargo.items},now,near);
        } catch {return false;}
    });
}
