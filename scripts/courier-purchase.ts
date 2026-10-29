import {BOAT_FARES_OUT} from './courier-route';

// Npc.checkNotTooStrong excludes a player above twice the scorpion's level14.
// The route crosses its wander12+hunt2+size2 bounds, and a live starter took damage.
export function courierIslandProblem(combat:number|undefined):string|null {
    return Number.isSafeInteger(combat)&&(combat??0)>=29?null
        :'Courier prerequisite: combat29 required for the Karamja scorpion crossing';
}

// Gerrant's public stock may already be depleted, or change during checkout.
// shop.rs2 clamps stock adjustment at -5000; sell1000 and base cost2 cap each
// feather at12GP. Bound the whole batch by that cap, then read the new wallet.
export function featherBatchAmount(coins:number,remaining:number):number {
    if(!Number.isSafeInteger(coins)||coins<0||!Number.isSafeInteger(remaining)||remaining<0)return 0;
    return Math.max(0,Math.min(50,remaining,Math.floor((coins-BOAT_FARES_OUT)/12)));
}

// A shop reply may lag its item/coin packets. Only the matched asset changes
// justify continuing to another batch; an ambiguous debit must stop the route.
export function featherPurchaseEffect(beforeCoins:number,beforeFeathers:number,afterCoins:number,afterFeathers:number,requested:number){
    if([beforeCoins,beforeFeathers,afterCoins,afterFeathers,requested].some(n=>!Number.isSafeInteger(n)||n<0)||requested<1||requested>50)
        throw Error('Feather purchase observation unavailable');
    const bought=afterFeathers-beforeFeathers,cost=beforeCoins-afterCoins;
    if(bought<0||bought>requested||cost<0||(bought===0?cost!==0:cost<1||cost>bought*12)||afterCoins<BOAT_FARES_OUT)
        throw Error('Feather purchase debit/credit or return fares unconfirmed');
    return{bought,cost};
}
