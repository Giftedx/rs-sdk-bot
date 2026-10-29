// Independent rewrite of the AND/OR and consistent-inventory-choice patterns in
// Skretzo/shortest-path@142e73e2 TransportItems/ItemRequirement. Unlike that
// readiness predicate, this spends counted resources across the complete trip.
// Game tokens/data come from the pinned rev289 world index, never modern IDs.
export type RouteGate={id:string;source:string;requires:string[][]};
export type RouteResources={
    held:Record<string,number|null>|null;
    coinsKnown?:boolean;
    worn?:Record<string,number|null>|null;
    reserved?:Record<string,number>;
    facts?:Record<string,true|false|null>;
};
type Choice={gate:string;source:string;alternative:number;tokens:string[]};
type State={coins:number;held:Record<string,number|null>|null;choices:Choice[]};
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const own=(map:Record<string,number|null>|null|undefined,key:string)=>map===null||map===undefined?null:Object.hasOwn(map,key)?map[key]!:0;

export function validateRouteResources(resources:RouteResources|undefined):void {
    if(!resources)return;
    if(resources.coinsKnown!==undefined&&typeof resources.coinsKnown!=='boolean')throw Error('Invalid transport coin observation');
    for(const map of [resources.held,resources.worn])if(map!==null&&map!==undefined){
        if(typeof map!=='object'||Array.isArray(map)||Object.values(map).some(v=>v!==null&&!count(v)))throw Error('Invalid carried transport items');
    }
    if(resources.reserved&&(typeof resources.reserved!=='object'||Array.isArray(resources.reserved)||Object.values(resources.reserved).some(v=>!count(v))))throw Error('Invalid transport reservations');
    if(resources.facts&&(typeof resources.facts!=='object'||Array.isArray(resources.facts)||Object.values(resources.facts).some(v=>v!==true&&v!==false&&v!==null)))throw Error('Invalid transport facts');
}

// Enough for small route requirement sets, without an unbounded combinatorial
// search in an advisory report. Exceeding the bound is explicit unknown; no
// state is silently dropped while claiming infeasibility or a proved optimum.
const MAX_STATES=4096;
export function allocateTransport(gates:RouteGate[],coins:number,resources?:RouteResources){
    validateRouteResources(resources);
    if(!count(coins))throw Error('Invalid transport coins');
    const reserved=resources?.reserved??{},reservedCoins=reserved.coins??0;
    let states:State[]=[{coins,held:resources?.held?{...resources.held}:null,choices:[]}];
    const reasons=new Set<string>();let unknown=false;
    for(const gate of gates){
        if(!gate||typeof gate.id!=='string'||!gate.id||typeof gate.source!=='string'||!gate.source||!Array.isArray(gate.requires)
            ||gate.requires.some(a=>!Array.isArray(a)||a.some(t=>typeof t!=='string'||!t)))throw Error('Invalid transport gate');
        if(!gate.requires.length){unknown=true;reasons.add(gate.id+' prerequisites unknown');states=[];break;}
        const next=new Map<string,State>();
        for(const state of states)for(const [alternative,tokens] of gate.requires.entries()){
            let spendCoins=0,unmet=false,unobserved=false;
            const spend:Record<string,number>={};
            const mark=(truth:true|false|null,token:string)=>{
                if(truth===false){unmet=true;reasons.add(gate.id+' unmet '+token);}
                if(truth!==true&&truth!==false){unobserved=true;reasons.add(gate.id+' unknown '+token);}
            };
            for(const token of tokens){
                const item=token.match(/^item:([^:]+):(held|worn)$/),consume=token.match(/^consume:([^:]+):(\d+)$/),fare=token.match(/^coins:(\d+)$/);
                if(item){
                    const quantity=own(item[2]==='held'?state.held:resources?.worn,item[1]!);
                    mark(quantity===null?null:quantity>=1,token);
                }else if(consume||fare){
                    const quantity=Number((consume??fare)![consume?2:1]);
                    if(!count(quantity)||quantity===0){mark(null,token);continue;}
                    if(fare||consume![1]==='coins')spendCoins+=quantity;
                    else spend[consume![1]!]=(spend[consume![1]!]??0)+quantity;
                }else if(token.startsWith('consume:')||token.startsWith('coins:')||token.startsWith('item:'))mark(null,token);
                else mark(resources?.facts?.[token]??null,token);
            }
            if(!count(spendCoins)||state.coins-spendCoins<reservedCoins)mark(false,'coin budget/reserve');
            if(spendCoins>0&&resources?.coinsKnown===false)mark(null,'carried coins unobserved');
            for(const [item,quantity] of Object.entries(spend)){
                const available=own(state.held,item);
                mark(available===null?null:count(quantity)&&available-quantity>=(reserved[item]??0),'consume:'+item+':'+quantity);
            }
            if(unmet)continue;
            if(unobserved){unknown=true;continue;}
            const held=state.held?{...state.held}:null;
            for(const [item,quantity] of Object.entries(spend))held![item]=Number(held![item])-quantity;
            const candidate:State={coins:state.coins-spendCoins,held,choices:[...state.choices,{gate:gate.id,source:gate.source,alternative,tokens:[...tokens]}]};
            const key=JSON.stringify([candidate.coins,held===null?null:Object.entries(held).sort(([a],[b])=>a.localeCompare(b))]);
            if(!next.has(key))next.set(key,candidate);
            if(next.size>MAX_STATES)return {state:null as true|false|null,blockers:['transport alternative search bound exceeded'],remaining:null,choices:[] as Choice[]};
        }
        states=[...next.values()];
        if(!states.length)break;
    }
    states.sort((a,b)=>b.coins-a.coins||a.choices.map(c=>c.alternative).join(',').localeCompare(b.choices.map(c=>c.alternative).join(',')));
    const selected=states[0];
    if(selected)return {state:true as true|false|null,blockers:[] as string[],remaining:{coins:selected.coins,held:selected.held},choices:selected.choices};
    return {state:(unknown?null:false) as true|false|null,blockers:[...reasons],remaining:null,choices:[] as Choice[]};
}
