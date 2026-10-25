// How scripts/foodcourier.ts may start its outbound leg to Port Sarim. Pure, so the unit test checks it offline.
//
// The overland walk between Ardougne and Port Sarim crosses White Wolf Mountain: research/route-danger.ts
// 2619,3332 3029,3217 lists 18 hunting spawns in reach (white wolves 25-38, wolf pack leader 73, ice warriors 57).
// A 10 HP courier took that walk on 2026-10-25 from the Ardougne North bank with 502 coins in its pack and died
// (.practice/swarm-logs/Bigpackage.log). So from Ardougne the courier always sails; it walks to Port Sarim only from
// east of the mountain (Varrock West bank -> Port Sarim: one level-2 spider in reach, and a live run survived it).
export type Tile = { x: number; z: number };
export const ARDY_BANK: Tile = { x: 2654, z: 3283 };
export const NORTH_BANK: Tile = { x: 2619, z: 3332 };
export const SARIM: Tile = { x: 3029, z: 3217 };
// The hand-out leg walks North bank <-> this tile on every Mightyrod delivery (alive, hpMin=10 on 2026-10-25).
export const NORTH_TO_SOUTH: Tile = { x: 2644, z: 3293 };
export const BOAT_FARES_OUT = 60;
export const BOAT_FARES_ROUND = 120;

export type OutboundStart = 'boat-south' | 'boat-north' | 'land' | 'refuse';

const cheb = (a: Tile, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));

export function outboundStart(p: { worldX: number; worldZ: number; level: number } | null | undefined): OutboundStart {
    if (!p || p.level !== 0) return 'refuse';
    if (cheb(ARDY_BANK, p) <= 10) return 'boat-south';
    if (cheb(NORTH_BANK, p) <= 10) return 'boat-north';
    // East of the mountain: nearer Port Sarim than Ardougne, and east of Taverley (the wolves stand at x 2837-2872).
    if (p.worldX >= 2950 && cheb(SARIM, p) < cheb(ARDY_BANK, p)) return 'land';
    return 'refuse';
}
