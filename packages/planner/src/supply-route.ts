import {leg, type TravelModel} from './travel';
import {allocateTransport,validateRouteResources,type RouteGate,type RouteResources} from './transport-requirements';
export type {RouteGate,RouteResources} from './transport-requirements';

export type RouteBudget={coins:number;food:number};
// coins is other/base fare. Explicit gate coin charges are additional. A native
// observed route does not inherit gates from a possibly different modeled path.
export type RouteCost={coins:number|null;food:number|null;accessible:boolean|null;gates?:RouteGate[];observed?:{ticks:number;at:number;source:string;from:string;to:string;account:string;server:string;minCombat?:number}};
export type SupplyStop={holder:string;bank:string;available:number|null;reserved:number;outbound:RouteCost;onward:RouteCost};
export type SupplyRouteRequest={from:string;to:string;count:number;capacity:number;budget:RouteBudget;stops:SupplyStop[];resources?:RouteResources;context?:{account:string;server:string;at:number;maxAgeMs:number;combat?:number}};
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const gatesFor=(model:TravelModel,from:string,to:string,cost:RouteCost):RouteGate[]=>{
    if(cost.observed)return cost.gates??[];
    // Caller declarations can add a gate, never erase a modeled one. A receipt
    // may describe another path; its identity/time checks remain below.
    const combined=new Map<string,RouteGate>();
    for(const gate of [...leg(model,from,to).gates??[],...cost.gates??[]]){
        const key=gate.id+'\n'+gate.source;
        if(!combined.has(key))combined.set(key,gate);
    }
    return [...combined.values()];
};
export function routeGateRequirements(model:TravelModel,r:SupplyRouteRequest):RouteGate[]{
    return r.stops.flatMap(s=>[...gatesFor(model,r.from,s.bank,s.outbound),...gatesFor(model,s.bank,r.to,s.onward)]);
}

// Offline advice only. Costs/access must be supplied for both legs; a geometric
// path alone proves neither safety nor access. Budget is retained operating food,
// separate from cargo. Stock is available only at the pickup, never before it.
export function supplyRoute(model:TravelModel,r:SupplyRouteRequest) {
    if(![r.count,r.capacity,r.budget.coins,r.budget.food].every(count)||r.count<1)throw Error('Invalid route budget');
    validateRouteResources(r.resources);
    const candidates=r.stops.map(s=>{
        const blockers:string[]=[];
        if(!model.cache.banks[s.bank])throw Error('Unknown pickup bank');
        if(!count(s.reserved)|| (s.available!==null&&!count(s.available)))throw Error('Invalid supply stock');
        if(s.available===null)blockers.push('stock unknown');
        else if(s.available-s.reserved<r.count)blockers.push('unreserved stock short');
        if(r.count>r.capacity)blockers.push('cargo capacity short');
        let coins:number|null=r.budget.coins,food:number|null=r.budget.food;
        for(const [name,c] of [['outbound',s.outbound],['onward',s.onward]] as const){
            if(c.coins!==null&&!count(c.coins)||c.food!==null&&!count(c.food))throw Error('Invalid route cost');
            if(c.observed&&(!count(c.observed.ticks)||!count(c.observed.at)||c.observed.at===0||!c.observed.source))throw Error('Invalid route observation');
            if(c.observed){
                const o=c.observed,ctx=r.context;
                const from=name==='outbound'?r.from:s.bank,to=name==='outbound'?s.bank:r.to;
                if(o.from!==from||o.to!==to)blockers.push(`${name} evidence direction mismatch`);
                if(!ctx||ctx.account!==o.account||ctx.server!==o.server)blockers.push(`${name} evidence identity mismatch`);
                if(!ctx||!count(ctx.at)||!count(ctx.maxAgeMs)||ctx.at<o.at||ctx.at-o.at>ctx.maxAgeMs)blockers.push(`${name} evidence stale or future`);
                if(o.minCombat!==undefined&&(!count(o.minCombat)||!count(ctx?.combat)||ctx!.combat!<o.minCombat))blockers.push(`${name} combat requirement unmet`);
            }
            if(c.accessible!==true)blockers.push(`${name} access ${c.accessible===false?'blocked':'unknown'}`);
            if(c.coins===null)blockers.push(`${name} fare unknown`);
            if(c.coins!==null&&c.coins>0&&r.resources?.coinsKnown===false)blockers.push(`${name} fare coins unobserved`);
            if(c.food===null)blockers.push(`${name} food cost unknown`);
            coins=coins===null||c.coins===null?null:coins-c.coins;
            food=food===null||c.food===null?null:food-c.food;
            if(coins!==null&&coins<0)blockers.push(`${name} fare short`);
            if(coins!==null&&coins<(r.resources?.reserved?.coins??0))blockers.push(`${name} reserved coins short`);
            if(food!==null&&food<0)blockers.push(`${name} operating food short`);
        }
        const outward=leg(model,r.from,s.bank),onward=leg(model,s.bank,r.to);
        const gates=[...gatesFor(model,r.from,s.bank,s.outbound).map(g=>({...g,id:'outbound:'+g.id})),...gatesFor(model,s.bank,r.to,s.onward).map(g=>({...g,id:'onward:'+g.id}))];
        const transport=gates.length&&coins!==null&&coins>=0?allocateTransport(gates,coins,r.resources):null;
        if(transport){blockers.push(...transport.blockers);if(transport.state!==true&&!transport.blockers.length)blockers.push('transport requirements unresolved');if(transport.remaining)coins=transport.remaining.coins;}
        const costs=[s.outbound,s.onward],legs=[outward,onward];
        return {holder:s.holder,bank:s.bank,ticks:costs.reduce((n,c,i)=>n+(c.observed?.ticks??legs[i]!.ticks),0),methods:costs.map((c,i)=>c.observed?'receipt':legs[i]!.method),observations:costs.map(c=>c.observed??null),blockers,remaining:{coins,food},...(transport?{transport}:{})};
    }).sort((a,b)=>a.ticks-b.ticks||a.bank.localeCompare(b.bank)||a.holder.localeCompare(b.holder));
    return {scope:'Offline model; no reservation, safety proof or execution permission.',selected:candidates.find(c=>c.blockers.length===0)??null,candidates};
}
