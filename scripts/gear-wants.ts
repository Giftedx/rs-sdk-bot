// The gear wants of an account, read from its status file: what the planner's gear pass (packages/planner/src/gear-want-jobs.ts)
// plans buys from. The choice is the one the workers' reconcile makes (gear-reconcile.ts loadoutFor and gearWants), run on
// the stock of the last observation: pack, worn gear and bank.
import {gearWants,loadoutFor,marketAsks,questPointsFloor,type GearWant} from './gear-reconcile';
import {readSkillLevels,type CombatFocus} from '../packages/planner/src/gear-progression';
import type {MarketAsks} from '../packages/planner/src/gear-sources';
import type {GearWantRow} from '../packages/planner/src/gear-want-jobs';
import {PROFILES,dataKey,derivedProfile} from '../packages/workers/src/market';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

type Row={id?:number;count?:number};
const CRAFT_SKILLS=['Smithing','Crafting','Fletching','Runecraft','Herblore','Cooking','Firemaking','Thieving'] as const;

let shopSpawns:Map<string,{x:number;z:number}[]>|undefined;
/**
 * The shop-buyer profile (scripts/shop-buyer.ts PROFILES) that serves a shop want: its NPC stands on a spawn of the content shop
 * (knowledge/gear-sources.json shopNpcs) and one of its items matches the wanted name. Else the profile that scripts/shop-profiles.ts derives from the content (`data:<shop>`). A shop behind a door that needs items (`realm`, `HAND_ONLY_SHOPS`) has none: its own template carries the setup.
 */
export function shopProfileFor(shop:string,itemName:string):string|undefined{
    if(!shopSpawns){
        shopSpawns=new Map();
        const rows=JSON.parse(readFileSync(resolve(import.meta.dir,'..','knowledge','gear-sources.json'),'utf8')).shopNpcs as {shop:string;spawns:{x:number;z:number}[]}[];
        for(const r of rows)shopSpawns.set(r.shop,[...(shopSpawns.get(r.shop)??[]),...r.spawns]);
    }
    const spawns=shopSpawns.get(shop)??[];
    const hand=Object.entries(PROFILES).find(([,p])=>!p.realm&&spawns.some(t=>t.x===p.npcSpot.x&&t.z===p.npcSpot.z)&&p.items.some(i=>i.re.test(itemName)))?.[0];
    if(hand)return hand;
    return derivedProfile(shop)?.items.some(i=>i.re.test(itemName))?dataKey(shop):undefined;
}

/** The wants of the account for its training style, from a status file, with the profile of each shop want. A status with no skills gives none. */
export function wantRowsFromStatus(account:string,status:any,style:CombatFocus,market?:MarketAsks,trainSkill?:string):GearWantRow[]{
    return wantsFromStatus(account,status,style,market,trainSkill).map(w=>{
        const profile=w.source.kind==='shop'?shopProfileFor(w.source.shop,w.name):undefined;
        return{style:w.style,slot:w.slot,id:w.id,name:w.name,current:w.current,source:w.source,...profile?{profile}:{}};
    });
}

/** The wants of the account for its training style, from a status file. A status with no skills gives none. */
export function wantsFromStatus(account:string,status:any,style:CombatFocus,market:MarketAsks=marketAsks(),trainSkill?:string):GearWant[]{
    const skills:{name:string;level:number}[]=Array.isArray(status?.skills)?status.skills.filter((k:any)=>typeof k?.name==='string'&&Number.isFinite(k.level)):[];
    if(!skills.length)return[];
    const level=(name:string)=>skills.find(k=>k.name===name);
    const stock=[status?.inventory,status?.equipment,status?.bank].flatMap(x=>Array.isArray(x)?x as Row[]:[])
        .filter(r=>Number.isSafeInteger(r?.id)&&Number.isFinite(r?.count)).map(r=>({id:r.id!,count:r.count!}));
    const levels={...readSkillLevels(n=>level(n)),
        ...Object.fromEntries(CRAFT_SKILLS.flatMap(n=>{const k=level(n);return k?[[n.toLowerCase(),k.level]]:[];}))};
    const quests=Array.isArray(status?.quests)?status.quests:null;
    const qp=status?.guildFacts?.varps?.qp,floor=questPointsFloor(quests);
    const p=status?.pos;
    const loadout=loadoutFor(style,stock,levels,quests,{trainSkill,market,questPoints:Number.isInteger(qp)&&qp>floor?qp:floor,
        position:Number.isFinite(p?.x)&&Number.isFinite(p?.z)?{x:p.x,z:p.z}:null});
    return gearWants(account,loadout);
}
