import {readFileSync} from 'node:fs';
import type {Account,DoorBlock,Door} from './world';
import {guildActorFacts} from './guild-observation';
import {equipmentObserved} from './container-observation';
const clients=new WeakMap<object,unknown>();
export function registerRouteActor(sdk:object,client:unknown):void {if(client&&typeof client==='object')clients.set(sdk,client);}
export function accountForSdk(sdk:any):Account {
    const state=sdk.getState(),client=clients.get(sdk),actor=accountFromState(state);
    if(client&&typeof client==='object'){
        if(!equipmentObserved(client))delete actor.worn;
        if((client as {ingame?:boolean}).ingame!==true)delete actor.doorStates;
    }
    const result={...actor,...guildActorFacts(client,state)};
    // A retained account object must not retain a vanished dynamic world object.
    Object.defineProperty(result,'visibleLocs',{enumerable:true,get:()=>{if(!client||typeof client!=='object')return undefined;const c=client as {ingame?:boolean;isInGame?:()=>boolean};return (typeof c.isInGame==='function'?c.isInGame()===true:c.ingame===true)?visibleLocs(sdk.getState()):undefined;}});
    return result;
}

let names:Map<number,string>|undefined;
let stateRules:Door[]|undefined;
// These are current visible loc witnesses, never a remembered opening receipt.
// Closed at the original anchor wins over an inconsistent/stale open variant.
export function observedDoorStates(state:any,doors?:readonly Door[]):Record<string,boolean>{
    const result:Record<string,boolean>={};if(state?.inGame===false||!Array.isArray(state?.nearbyLocs))return result;
    const rules=doors??(stateRules??=JSON.parse(readFileSync(new URL('../../../knowledge/doors.json',import.meta.url),'utf8')).filter((d:Door)=>d.kind==='team'));
    for(const d of rules){if(d.kind!=='team'||!d.open)continue;const at=(l:any,t:{id:number;x:number;z:number;level:number})=>l.id===t.id&&l.x===t.x&&l.z===t.z&&l.level===t.level;
        const key=`${d.level},${d.x},${d.z}`;
        if(state.nearbyLocs.some((l:any)=>at(l,d)))result[key]=false;
        else if(state.nearbyLocs.some((l:any)=>at(l,d.open!)))result[key]=true;
    }
    return result;
}
export function visibleLocs(state:any):ReadonlyArray<{id:number;x:number;z:number;level:number}>|undefined {
    const p=state?.player;if(state?.inGame===false||!p||!Number.isInteger(p.level)||!Array.isArray(state?.nearbyLocs))return undefined;
    return state.nearbyLocs.filter((l:any)=>l&&[l.id,l.x,l.z,l.level].every(Number.isSafeInteger)&&l.id>=0&&l.x>=0&&l.x<16384&&l.z>=0&&l.z<16384&&l.level===p.level).map((l:any)=>({id:l.id,x:l.x,z:l.z,level:l.level}));
}
export function accountFromState(state:any):Account {
    names??=new Map((JSON.parse(readFileSync(new URL('../../../knowledge/items.json',import.meta.url),'utf8')) as {id:number;debugname:string}[]).map(i=>[i.id,i.debugname]));
    const identify=(i:any)=>Number.isInteger(i?.id)?names!.get(i.id):typeof i?.name==='string'?i.name.toLowerCase().replace(/ /g,'_'):undefined;
    const skills:Record<string,number>={};
    for(const s of state?.skills??[])if(typeof s.name==='string'&&Number.isSafeInteger(s.level)&&s.level>=0)skills[s.name.toLowerCase()]=s.level;
    const held=(Array.isArray(state?.inventory)?state.inventory:[]).filter((i:any)=>i.count>0);
    const equipment=Array.isArray(state?.equipment)?state.equipment.filter((i:any)=>i.count>0):undefined;
    const worn=equipment?.map(identify);
    const doorStates=observedDoorStates(state);
    const coins=held.filter((i:any)=>identify(i)==='coins').reduce((n:number,i:any)=>n+i.count,0);
    return {visibleLocs:visibleLocs(state),skills,coins,items:held.map(identify).filter((s:unknown):s is string=>typeof s==='string'),varps:{},...(worn?.every((s:unknown)=>typeof s==='string')?{worn:worn as string[]}:{}),...(Object.keys(doorStates).length?{doorStates}:{})};
}

export interface FlagGrid {isFlagged(x:number,z:number,level:number,mask:number):boolean;__set(x:number,z:number,level:number,mask:number):void;changeWall?(x:number,z:number,level:number,angle:number,shape:number,blockrange:boolean,route:boolean,add:boolean):void}
// These are the exact native CollisionFlag wall aliases, not movement masks.
const WALL=[128,2,8,32] as const;
const DELTA=[[-1,0],[0,1],[1,0],[0,-1]] as const;
export function directionalMasks(blocks:readonly DoorBlock[]):{x:number;z:number;level:number;mask:number}[]{
    return blocks.flatMap(b=>{
        if(b.whenAxis===undefined||!Number.isInteger(b.angle)||b.angle!<0||b.angle!>3)return [];
        const angle=b.angle!,d=DELTA[angle]!;
        // check_axis=true is the owner tile. For a true-side refusal block the
        // opposite tile's destination-facing bit; the reverse move stays open.
        return [{x:b.x+(b.whenAxis?d[0]:0),z:b.z+(b.whenAxis?d[1]:0),level:b.level,mask:WALL[b.whenAxis?(angle+2)%4:angle]!}];
    });
}
export function withDoorPolicy<T>(grid:FlagGrid,blocks:readonly DoorBlock[],query:()=>T):T {
    const saved=new Map<string,{x:number;z:number;level:number;mask:number}>();
    const read=(x:number,z:number,level:number)=>{let mask=0;for(let bit=0;bit<32;bit++)if(grid.isFlagged(x,z,level,1<<bit))mask|=1<<bit;return mask;};
    const save=(x:number,z:number,level:number)=>{const key=`${level},${x},${z}`;if(!saved.has(key))saved.set(key,{x,z,level,mask:read(x,z,level)});};
    try {
        for(const b of blocks)if(b.whenAxis===undefined&&Number.isInteger(b.angle)&&Number.isInteger(b.shape)&&grid.changeWall){
            for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)save(b.x+dx,b.z+dz,b.level);
            grid.changeWall(b.x,b.z,b.level,b.angle!,b.shape!,!!b.blockrange,false,true);
        }
        for(const b of directionalMasks(blocks)){
            save(b.x,b.z,b.level);
            grid.__set(b.x,b.z,b.level,read(b.x,b.z,b.level)|b.mask);
        }
        const result=query();
        if(result&&typeof(result as any).then==='function')throw Error('Door policy queries must be synchronous');
        return result;
    } finally {
        for(const b of saved.values())grid.__set(b.x,b.z,b.level,b.mask);
    }
}
