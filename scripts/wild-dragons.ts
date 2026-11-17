// Wilderness Green Dragons: farms Green dragons (NPC 941 at 3078..3118, 3810..3821, rev 289) for Dragon bones and
// green Dragonhide, banking at Edgeville with Dragonfire shield preflight and PKer threat retreat.
// Usage: bun scripts/wild-dragons.ts <bot> [CAP ticks=6000]
// Env: FOOD_COUNT=10, EAT_AT=45, ESCAPE_AT=30, MAX_TRIPS=10, STAGED=1 (skip initial bank restock).
import { existsSync } from 'node:fs';
import { openBot, finish, sessionDied } from '../packages/core/src/bot';
import { depositPack } from '../packages/core/src/deposit';
import type { Session } from '../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { eatBetweenCasts } from './magic-order';
import { attackable, wildernessLevel } from './pk';
import { EDGEVILLE_BANK, fleetNames } from './pk-hunt';
import type { BotWorldState, NearbyNpc, NearbyPlayer } from '../vendor/rs-sdk/sdk/types';

export const GREEN_DRAGON_ID = 941;
export const DRAGONFIRE_SHIELD_ID = 1540;
export const DRAGON_BONES_ID = 536;
export const GREEN_DHIDE_ID = 1753;
export const GREEN_DRAGON_SPOT = { x: 3092, z: 3810 } as const;
export const SAFE_SOUTH_TILE = { x: 3092, z: 3520 } as const;
export const DRAGON_FOOD_IDS = [385, 373, 379, 329, 333] as const;
export const DRAGON_LOOT_IDS = new Set<number>([DRAGON_BONES_ID, GREEN_DHIDE_ID, 561, 563, 995, 1213, 449, 447]);

export type WildDragonsOptions = {
    cap: number;
    foodCount: number;
    eatAt: number;
    escapeAt: number;
    maxTrips: number;
    staged?: boolean;
    stop?: () => boolean;
};

export function wildDragonPreflight(state: BotWorldState | null): string | null {
    if (!state?.player) return 'state unknown';
    if (!state.equipment.some(i => i.slot === 5 && i.id === DRAGONFIRE_SHIELD_ID)) return 'Dragonfire shield (1540) must be worn in shield slot';
    if (!state.equipment.some(i => i.slot === 3)) return 'melee weapon must be worn in weapon slot';
    if (!state.inventory.some(i => (DRAGON_FOOD_IDS as readonly number[]).includes(i.id))) return 'food required in inventory';
    return null;
}

export function wildDragonThreat(
    state: BotWorldState,
    ours: ReadonlySet<string> = fleetNames(),
): NearbyPlayer | null {
    const p = state.player;
    if (!p || wildernessLevel(p.worldZ) <= 0) return null;
    return state.nearbyPlayers.find(other =>
        !ours.has(other.name.toLowerCase()) && attackable({ z: p.worldZ, combatLevel: p.combatLevel }, other),
    ) ?? null;
}

export function selectGreenDragon(
    npcs: readonly NearbyNpc[],
    selfSlot?: number,
): NearbyNpc | undefined {
    const selfTarget = Number.isInteger(selfSlot) ? 32768 + selfSlot! : -1;
    return npcs
        .filter(n => n.id === GREEN_DRAGON_ID && n.reachable !== false && (n.hp ?? 1) > 0
            && (!n.inCombat || n.targetIndex === selfTarget))
        .sort((a, b) => Number(b.targetIndex === selfTarget) - Number(a.targetIndex === selfTarget) || a.distance - b.distance)[0];
}

export function wildDragonRetreatReason(
    state: BotWorldState,
    o: { eatAt: number; escapeAt: number },
    ours: ReadonlySet<string> = fleetNames(),
): string | null {
    const hp = state.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;
    const food = state.inventory.filter(i => (DRAGON_FOOD_IDS as readonly number[]).includes(i.id)).reduce((n, i) => n + i.count, 0);
    if (!state.equipment.some(i => i.slot === 5 && i.id === DRAGONFIRE_SHIELD_ID)) return 'shield-missing';
    if (hp <= o.escapeAt) return 'low-hp';
    if (food === 0 && hp <= o.eatAt) return 'out-of-food';
    if (state.inventory.length >= 28 && food === 0) return 'pack-full';
    if (state.inventory.length >= 28) return 'pack-full';
    if (wildDragonThreat(state, ours)) return 'pker-threat';
    return null;
}

const countId = (state: BotWorldState, id: number) => state.inventory.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

export async function runWildDragons(s: Session, o: WildDragonsOptions) {
    const st = () => s.sdk.getState();
    const hp = () => st()?.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;
    if (!await waitUntil(s, () => !!st()?.player && hp() > 0, { timeoutTicks: 15 })) {
        throw Error('wild-dragons: initial state unknown');
    }
    const p0 = st()!.player!;
    const start = s.tick();
    const ours = fleetNames();
    const preflight = wildDragonPreflight(st());
    if (preflight) throw Error(`wild-dragons preflight: ${preflight}`);

    let ended = false, died = false, hpMin = hp(), kills = 0, bonesBanked = 0, hidesBanked = 0, eaten = 0, escapes = 0, trips = 0, stop = 'cap';
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => {
        const cur = st();
        hpMin = Math.min(hpMin, hp());
        if (sessionDied(p0, cur?.player)) died = true;
    });

    const over = () => ended || died || !!o.stop?.() || s.tick() - start >= o.cap;
    const walker = await sessionWalker(s);

    const walkSafe = async (target: { x: number; z: number }, maxTicks = 450) =>
        walkPath(walker, [{ ...target, tol: 2 }], { maxTicks, stop: over });

    const bankAndRestock = async (depositOnly = false) => {
        const p = st()?.player;
        if (p && wildernessLevel(p.worldZ) > 0) await walkSafe(SAFE_SOUTH_TILE, 500);
        if (over()) return false;
        if (!(await walkSafe(EDGEVILLE_BANK, 400)).ok) return false;
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!st()?.bank?.isOpen, { timeoutTicks: 15 })) return false;
        const inv = st()!;
        bonesBanked += countId(inv, DRAGON_BONES_ID);
        hidesBanked += countId(inv, GREEN_DHIDE_ID);
        await depositPack(s, i => (DRAGON_FOOD_IDS as readonly number[]).includes(i.id));
        if (!depositOnly) {
            const heldFood = st()!.inventory.filter(i => (DRAGON_FOOD_IDS as readonly number[]).includes(i.id)).reduce((n, i) => n + i.count, 0);
            const wantFood = Math.max(0, o.foodCount - heldFood);
            if (wantFood > 0) {
                for (const id of DRAGON_FOOD_IDS) {
                    const row = st()?.bank?.items.find(i => i.id === id && i.count > 0);
                    if (!row) continue;
                    const take = Math.min(wantFood, row.count);
                    await s.bot.withdrawItem(row, take, { asNote: false });
                    await waitTicks(s, 1);
                    break;
                }
            }
        }
        await s.bot.closeBank();
        trips++;
        return true;
    };

    try {
        if (!o.staged) {
            const cur = st()!;
            if (wildernessLevel(cur.player!.worldZ) === 0 && cur.inventory.some(i => i.id === DRAGON_BONES_ID || i.id === GREEN_DHIDE_ID)) {
                await bankAndRestock();
            }
        }
        while (!over() && trips < o.maxTrips) {
            const cur = st();
            if (!cur?.player) break;
            if (Math.max(Math.abs(cur.player.worldX - GREEN_DRAGON_SPOT.x), Math.abs(cur.player.worldZ - GREEN_DRAGON_SPOT.z)) > 25) {
                const res = await walkSafe(GREEN_DRAGON_SPOT, 600);
                if (!res.ok || over()) break;
            }
            const reason = wildDragonRetreatReason(st()!, o, ours);
            if (reason) {
                if (reason === 'pker-threat') escapes++;
                if (!await bankAndRestock()) { stop = reason; break; }
                continue;
            }
            if (hp() <= o.eatAt) {
                const ate = await eatBetweenCasts(s, { food: [...DRAGON_FOOD_IDS], eatAt: o.eatAt, timeoutTicks: 4, attempts: 2 });
                if (ate) eaten++;
            }
            const state = st()!;
            const ground = state.groundItems.find(g => DRAGON_LOOT_IDS.has(g.id) && Math.max(Math.abs(g.x - state.player!.worldX), Math.abs(g.z - state.player!.worldZ)) <= 8);
            if (ground && state.inventory.length < 28) {
                await s.bot.pickupItem(ground);
                await waitTicks(s, 2);
                continue;
            }
            const selfSlot = (s.client as { selfSlot?: number } | undefined)?.selfSlot;
            const dragon = selectGreenDragon(state.nearbyNpcs, selfSlot);
            if (!dragon) { await waitTicks(s, 2); continue; }
            const xpBefore = state.skills.filter(k => ['Attack', 'Strength', 'Defence', 'Hitpoints'].includes(k.name)).reduce((n, k) => n + k.experience, 0);
            await s.bot.attack(dragon);
            await waitUntil(s, () => {
                const now = st();
                if (!now || over()) return true;
                if (wildDragonRetreatReason(now, o, ours)) return true;
                const alive = now.nearbyNpcs.some(n => n.index === dragon.index && (n.hp ?? 1) > 0);
                return !alive;
            }, { timeoutTicks: 60 });
            const after = st();
            if (after) {
                const xpAfter = after.skills.filter(k => ['Attack', 'Strength', 'Defence', 'Hitpoints'].includes(k.name)).reduce((n, k) => n + k.experience, 0);
                if (xpAfter > xpBefore && !after.nearbyNpcs.some(n => n.index === dragon.index && (n.hp ?? 1) > 0)) {
                    kills++;
                }
            }
        }
        if (ended) stop = 'session-ended';
        else if (died) stop = 'died';
        else if (o.stop?.()) stop = 'stop-file';
        else if (trips >= o.maxTrips) stop = 'max-trips';
        return { ok: !died && !ended, kills, bonesBanked, hidesBanked, eaten, escapes, trips, hpMin, died, stop, ticks: s.tick() - start };
    } finally {
        off();
    }
}

if (import.meta.main) {
    const [bot, capArg] = process.argv.slice(2);
    if (!bot) { console.log('usage: bun scripts/wild-dragons.ts <bot> [CAP ticks]'); process.exit(2); }
    const stop = () => existsSync(`.practice/stop-${bot}`) || existsSync('.practice/stop-wild-dragons');
    const s = await openBot(bot);
    try {
        const r = await runWildDragons(s, {
            cap: Number(capArg ?? 6000),
            foodCount: Number(process.env.FOOD_COUNT ?? 10),
            eatAt: Number(process.env.EAT_AT ?? 45),
            escapeAt: Number(process.env.ESCAPE_AT ?? 30),
            maxTrips: Number(process.env.MAX_TRIPS ?? 10),
            staged: process.env.STAGED === '1',
            stop,
        });
        console.log('WILD_DRAGONS ' + JSON.stringify(r));
        await finish([s], r.ok, `wild-dragons kills=${r.kills} bones=${r.bonesBanked} hides=${r.hidesBanked} escapes=${r.escapes} stop=${r.stop}`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}
