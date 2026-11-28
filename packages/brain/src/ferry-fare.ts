// The coins the worker's ferry fallback needs before it walks (walkWithFerryFallback in workers/src/logistics/walk.ts
// and workers/src/market/walk.ts). Between the east mainland and Ardougne it takes two boats: Port Sarim to Karamja,
// then Brimhaven to Ardougne, or the reverse. Before it walks it needs both fares, plus the Al Kharid toll from east of
// the gate. With fewer coins in the pack it takes the rest from the nearest bank, or it stops with
// "ferry needs N coins and the bank holds B". Preflight charges this fare, so a launch it passes can pay for the trip.
// This copy keeps worker releases unchanged; test/ferry-fare.test.ts fails when it differs from either walker.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Travel } from '../../core/src/travel';
import type { Tile } from '../../core/src/world-types';

const PORT_SARIM_FERRY = 'npc:captain_tobias:karamja-musa-point@3028,3216';
const ARDOUGNE_FERRY = 'npc:customs_officer:ardougne@2772,3225';
const BRIMHAVEN_FERRY = 'npc:captain_barnaby:brimhaven@2679,3275';
const MUSA_POINT_FERRY = 'npc:customs_officer:port-sarim@2953,3147';
const AL_KHARID_TOLL = 'npc:borderguard2:lumbridge-side-west-of-the-toll-gate@3268,3226';
const FERRY_IDS = new Set([PORT_SARIM_FERRY, ARDOUGNE_FERRY, BRIMHAVEN_FERRY, MUSA_POINT_FERRY, AL_KHARID_TOLL]);
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

type FerryEdge = Pick<Travel, 'id' | 'from' | 'coins'>;
let cachedFerryEdges: readonly FerryEdge[] | undefined;

// Reads only the 5 boat/toll entries from knowledge/npc-travel.json so Brain preflight never pins shortcuts.json/ladders.json.
export function loadFerryTravelEdges(root = REPO_ROOT): readonly FerryEdge[] {
    if (root === REPO_ROOT && cachedFerryEdges) return cachedFerryEdges;
    const out: FerryEdge[] = [];
    try {
        const parsed = JSON.parse(readFileSync(join(root, 'knowledge', 'npc-travel.json'), 'utf8')) as {
            records?: Array<{
                id?: string;
                destination?: string;
                to?: Tile | null;
                from?: Tile[];
                fare?: { coins?: number | null; rule?: string };
                items?: { item: string; use: string }[];
            }>;
        };
        const records = Array.isArray(parsed?.records) ? parsed.records : [];
        for (const r of records) {
            if (!r?.id || !r.to || !Array.isArray(r.from)) continue;
            if (/entrana|jail/i.test(`${r.id} ${r.destination ?? ''}`)) continue;
            if (r.items?.some(i => i.use === 'forbidden')) continue;
            const held = (r.items ?? []).some(i => i.use === 'consumed' && /^[a-z0-9_]+$/.test(i.item));
            const coins = r.fare?.coins ?? (r.fare?.rule && !held ? 200 : 0);
            for (const f of r.from) {
                const edgeId = `npc:${r.id}@${f.x},${f.z}`;
                if (!FERRY_IDS.has(edgeId)) continue;
                out.push({ id: edgeId, from: { x: f.x, z: f.z, level: f.level }, coins });
            }
        }
    } catch { /* missing knowledge/npc-travel.json leaves out empty */ }
    if (root === REPO_ROOT) cachedFerryEdges = out;
    return out;
}

const inEast = (t: Tile) => t.level === 0 && t.x >= 2870 && t.x <= 3280 && t.z >= 3150 && t.z <= 3510;
const inArdougne = (t: Tile) => t.level === 0 && t.x >= 2550 && t.x <= 2700 && t.z >= 3240 && t.z <= 3400;
const inKandarin = (t: Tile) => t.level === 0 && t.x >= 2440 && t.x < 2870 && t.z >= 3040 && t.z <= 3530;
const inZanaris = (t: Tile) => t.level === 0 && t.x >= 3136 && t.x < 3264 && t.z >= 9536 && t.z < 9600;
const ARDOUGNE_NORTH: Tile = { x: 2619, z: 3332, level: 0 };
const ZANARIS_SHED: Tile = { x: 3201, z: 3169, level: 0 };

// Coins the fallback needs (pack and bank together) before it walks from `from` to `to`. 0 when it takes no boat.
// `reachable` says whether the account has a route to a tile. With no route to Ardougne North, the fallback walks its
// own route from where the account stands.
export function ferryFallbackFare(
    from: Tile,
    to: Tile,
    travel: () => readonly FerryEdge[] = loadFerryTravelEdges,
    reachable: (t: Tile) => boolean = () => true,
): number {
    // The fallback first leaves Zanaris by the shed, then goes to Ardougne north bank from an Ardougne upper floor or
    // from Kandarin when the target is east.
    if (inZanaris(from) && !inZanaris(to) && !(to.x === ZANARIS_SHED.x && to.z === ZANARIS_SHED.z)) from = ZANARIS_SHED;
    if (((from.level > 0 && inArdougne({ ...from, level: 0 })) || (!inArdougne(from) && inKandarin(from))) && inEast(to) && reachable(ARDOUGNE_NORTH)) from = ARDOUGNE_NORTH;
    const west = inEast(from) && to.level === 0 && to.x >= 2600 && to.x <= 2690 && to.z >= 3260 && to.z <= 3360;
    const east = !west && inArdougne(from) && inEast(to);
    if (!west && !east) return 0;
    const all = travel();
    const first = all.find(t => t.id === (west ? PORT_SARIM_FERRY : BRIMHAVEN_FERRY));
    const second = all.find(t => t.id === (west ? ARDOUGNE_FERRY : MUSA_POINT_FERRY));
    if (!first?.from || !second?.from) return 0;
    const toll = west && from.x >= 3250 && from.z <= 3230 ? all.find(t => t.id === AL_KHARID_TOLL) : undefined;
    return first.coins + second.coins + (toll?.coins ?? 0);
}
