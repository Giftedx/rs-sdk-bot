// How scripts/foodcourier.ts may start its outbound leg to Port Sarim. Pure, so the unit test checks it offline.
//
// The overland walk between Ardougne and Port Sarim crosses White Wolf Mountain: research/route-danger.ts
// 2619,3332 3029,3217 lists 18 hunting spawns in reach (white wolves 25-38, wolf pack leader 73, ice warriors 57).
// A 10 HP courier took that walk on 2026-10-25 from the Ardougne North bank with 502 coins in its pack and died
// (.practice/swarm-logs/Bigpackage.log). So from Ardougne the courier always sails; it walks to Port Sarim only from
// east of the mountain (Varrock West bank -> Port Sarim: one level-2 spider in reach, and a live run survived it).
export type Tile = { x: number; z: number };
// Choose one live owned supplier. A dated bank is stock evidence; current activity is arrival evidence.
export function selectFoodSource(names: readonly string[], statuses: readonly any[], owned: ReadonlySet<string>, now: number, minimum = 1): string | undefined {
    if (!names.length || !Number.isSafeInteger(minimum) || minimum < 1
        || names.some(n => typeof n !== 'string' || !/^[A-Za-z0-9_ -]{1,12}$/.test(n) || !owned.has(n.toLowerCase()))) return undefined;
    const available = names.flatMap(name => {
        const s = statuses.find(s => typeof s?.name === 'string' && s.name.toLowerCase() === name.toLowerCase() && s.server === 'rs-sdk-demo.fly.dev');
        if (!s || s.result || !Number.isFinite(s.at) || now - s.at < 0 || now - s.at >= 30000
            || !Number.isFinite(s.bankAt) || s.bankAt <= 0 || s.bankAt > now || !Array.isArray(s.bank)
            || !s.bank.every((i:any) => Number.isSafeInteger(i?.id) && i.id >= 0 && Number.isSafeInteger(i.count) && i.count > 0)) return [];
        const stock = s.bank.reduce((n:number,i:any) => n + ([329,333,379].includes(i.id) ? i.count : 0), 0);
        return Number.isSafeInteger(stock) && stock >= minimum ? [{name,stock}] : [];
    });
    return available.sort((a,b) => b.stock-a.stock)[0]?.name;
}
export function featherPurchaseAmount(cap: number, name: string, status: any, now: number): number {
    if (typeof status?.name !== 'string' || status.name.toLowerCase() !== name.toLowerCase() || status.server !== 'rs-sdk-demo.fly.dev'
        || status.result || !Number.isFinite(status.at) || now - status.at < 0 || now - status.at >= 30000
        || !Array.isArray(status.inventory) || !status.inventory.every((i:any) => Number.isSafeInteger(i?.id) && i.id >= 0 && Number.isSafeInteger(i.count) && i.count > 0)) return cap;
    const stock = status.inventory.filter((i:any) => i.id === 314).reduce((n:number,i:any) => n + i.count, 0);
    return Number.isSafeInteger(stock) ? Math.min(cap, Math.max(0, 1000 - stock)) : cap;
}
export function foodDeficit(name: string, status: any, now: number, buffer = 80, server='rs-sdk-demo.fly.dev'): number | undefined {
    const rows = (v: any) => Array.isArray(v) && v.every(i => Number.isSafeInteger(i?.id) && i.id >= 0 && Number.isSafeInteger(i.count) && i.count > 0);
    if (!Number.isSafeInteger(buffer) || buffer < 1 || typeof status?.name !== 'string' || status.name.toLowerCase() !== name.toLowerCase()
        || status.server !== server || status.result || !Number.isFinite(status.at) || now - status.at < 0 || now - status.at >= 30000
        || !Number.isFinite(status.bankAt) || status.bankAt <= 0 || status.bankAt > now || !rows(status.bank) || !rows(status.inventory)) return undefined;
    const count = (v: any[], notes: boolean) => v.reduce((n, i) => n + ([329,333,379,...(notes ? [330,334,380] : [])].includes(i.id) ? i.count : 0), 0);
    const food = count(status.bank, false) + count(status.inventory, true);
    return Number.isSafeInteger(food) ? Math.max(0, buffer - food) : undefined;
}
// Keep wake and refill levels apart: a farm below 80 receives enough for 160, rather than one fish per login.
export function foodRestockAmount(name:string,status:any,now:number,server='rs-sdk-demo.fly.dev'):number|undefined {
    const deficit=foodDeficit(name,status,now,80,server);
    return deficit===undefined?undefined:deficit>0?deficit+80:0;
}
export function deliveryRecipientAtBank(p:{worldX:number;worldZ:number;level:number}|null|undefined,players:readonly {name:string;distance:number}[],name:string,bank:Tile):boolean {
    return p?.level===0&&Math.max(Math.abs(p.worldX-bank.x),Math.abs(p.worldZ-bank.z))<=2
        &&players.some(other=>other.name.toLowerCase()===name.toLowerCase()&&Number.isFinite(other.distance)&&other.distance>=0&&other.distance<=2);
}
export function deliveryResume(p: { worldX: number; worldZ: number; level: number } | null | undefined, notes: number, farmers: number): 'bank' | 'karamja' | null {
    if (!Number.isSafeInteger(notes) || notes < 1 || !Number.isSafeInteger(farmers) || farmers < 1) return null;
    if (onKaramja(p)) return 'karamja';
    if (p?.level === 0 && Math.max(Math.abs(p.worldX - 2653), Math.abs(p.worldZ - 3302)) <= 16) return 'bank';
    const start = outboundStart(p);
    if (start === 'boat-south' || start === 'boat-north') return 'bank';
    return null;
}
export const ARDY_BANK: Tile = { x: 2654, z: 3283 };
export const NORTH_BANK: Tile = { x: 2619, z: 3332 };
export const SARIM: Tile = { x: 3029, z: 3217 };
// The hand-out leg walks North bank <-> this tile on every Mightyrod delivery (alive, hpMin=10 on 2026-10-25).
export const NORTH_TO_SOUTH: Tile = { x: 2644, z: 3293 };
export const BOAT_FARES_OUT = 60;
export const BOAT_FARES_ROUND = 120;

export type OutboundStart = 'boat-south' | 'boat-north' | 'land' | 'refuse';
export type RoutePoint = [number, number, number];
export const DRAYNOR_BANK: Tile = { x: 3092, z: 3243 };
// Lumbridge side -> Draynor bank north of the jail guards (scripts/fishcook.ts FIRE_TO_BANK, walked every pack).
// research/route-danger.ts 3222,3218 ... 3092,3243 on this lane: 0 spawns in reach. The direct path passes two
// level-26 jail guards (3121,3249 and 3127,3248, reach 8), too much for a 10 HP account after a respawn.
export const LUMBRIDGE_TO_DRAYNOR: RoutePoint[] = [[3226, 3250, 2], [3180, 3258, 3], [3100, 3285, 3], [3089, 3266, 2], [3092, 3250, 1], [DRAYNOR_BANK.x, DRAYNOR_BANK.z, 2]];
// Musa Point <-> Brimhaven on Karamja (ground level). A session that ends there (2026-10-25: Pocketpython was
// disconnected at 2829,3190) resumes the home leg from here: walk to Brimhaven, sail to Ardougne.
export function onKaramja(p: { worldX: number; worldZ: number; level: number } | null | undefined): boolean {
    return !!p && p.level === 0 && p.worldX >= 2760 && p.worldX <= 2965 && p.worldZ >= 3130 && p.worldZ <= 3235;
}
export function draynorApproach(p: { worldX: number; worldZ: number; level: number } | null | undefined): RoutePoint[] {
    if (p && p.level === 0 && p.worldX >= 3110) return LUMBRIDGE_TO_DRAYNOR;
    return [[DRAYNOR_BANK.x, DRAYNOR_BANK.z, 2]];
}

const cheb = (a: Tile, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));

export function outboundStart(p: { worldX: number; worldZ: number; level: number } | null | undefined): OutboundStart {
    if (!p || p.level !== 0) return 'refuse';
    if (cheb(ARDY_BANK, p) <= 10) return 'boat-south';
    if (cheb(NORTH_BANK, p) <= 10) return 'boat-north';
    // East of the mountain: nearer Port Sarim than Ardougne, and east of Taverley (the wolves stand at x 2837-2872).
    if (p.worldX >= 2950 && cheb(SARIM, p) < cheb(ARDY_BANK, p)) return 'land';
    return 'refuse';
}
