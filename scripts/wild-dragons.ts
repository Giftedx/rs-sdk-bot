// Wilderness Green Dragons: farms Green dragons (NPC 941 at 3078..3118, 3810..3821, rev 289) for Dragon bones and
// green Dragonhide, banking at Edgeville with Dragonfire shield preflight, PKer threat retreat, and glory/teleport escape.
// Usage: bun scripts/wild-dragons.ts <bot> [CAP ticks=6000]
// Env: FOOD_COUNT=10, EAT_AT=45, ESCAPE_AT=30, MAX_TRIPS=10, STAGED=1 (skip initial bank restock).
import { existsSync } from 'node:fs';
import { openBot, finish, sessionDied } from '../packages/core/src/bot';
import { depositPack } from '../packages/core/src/deposit';
import type { Session } from '../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { eatBetweenCasts } from './magic-order';
import { attackable, ITEMS, wildernessLevel } from './pk';
import { EDGEVILLE_BANK, fleetNames } from '../packages/workers/src/pvp/hunt-kits';
import { hasVarrockTeleport, planWildernessEscape } from '../packages/workers/src/pvp/wild-rules';
import { componentId } from '../packages/core/src/logout';
import type { BotWorldState, NearbyNpc, NearbyPlayer } from '../vendor/rs-sdk/sdk/types';

export const GREEN_DRAGON_ID = 941;
export const DRAGONFIRE_SHIELD_ID = 1540;
export const DRAGON_BONES_ID = 536;
export const GREEN_DHIDE_ID = 1753;
export const GREEN_DRAGON_SPOT = { x: 3092, z: 3810 } as const;
export const SAFE_SOUTH_TILE = { x: 3092, z: 3518 } as const;
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

export function wildDragonPreflight(state: BotWorldState | null, requireFood = true): string | null {
    if (!state?.player) return 'state unknown';
    if (!state.equipment.some(i => i.slot === 5 && i.id === DRAGONFIRE_SHIELD_ID)) return 'Dragonfire shield (1540) must be worn in shield slot';
    if (!state.equipment.some(i => i.slot === 3)) return 'melee weapon must be worn in weapon slot';
    if (requireFood && !state.inventory.some(i => (DRAGON_FOOD_IDS as readonly number[]).includes(i.id))) return 'food required in inventory';
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
    if (state.inventory.length >= 28) return 'pack-full';
    if (wildDragonThreat(state, ours)) return 'pker-threat';
    return null;
}

export function wildDragonEscapeAction(state: BotWorldState) {
    const p = state.player;
    if (!p) return { kind: 'out' as const, distance: 0, detail: 'state unknown' };
    const magic = state.skills.find(k => k.name === 'Magic')?.level ?? 1;
    const hasPackGlory = state.inventory.some(i => (ITEMS.glory as readonly number[]).includes(i.id));
    const hasWornGlory = state.equipment.some(i => i.slot === 2 && (ITEMS.glory as readonly number[]).includes(i.id));
    const teleport = hasVarrockTeleport(magic, state.inventory, state.equipment);
    return planWildernessEscape({ x: p.worldX, z: p.worldZ }, { glory: hasPackGlory || (hasWornGlory && state.inventory.length < 28), teleport });
}

export function wildDragonEscapeKeep(item: { id: number }, escapeLawReserve = 0): boolean {
    if ((DRAGON_FOOD_IDS as readonly number[]).includes(item.id)) return true;
    if ((ITEMS.glory as readonly number[]).includes(item.id)) return true;
    if (item.id === ITEMS.airRune || item.id === ITEMS.fireRune) return true;
    if (item.id === ITEMS.lawRune && escapeLawReserve > 0) return true;
    return false;
}

const countId = (state: BotWorldState, id: number) => state.inventory.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const countFood = (state: BotWorldState) => state.inventory.filter(i => (DRAGON_FOOD_IDS as readonly number[]).includes(i.id)).reduce((n, i) => n + i.count, 0);

export async function runWildDragons(s: Session, o: WildDragonsOptions) {
    const st = () => s.sdk.getState();
    const hp = () => st()?.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;
    if (!await waitUntil(s, () => !!st()?.player && hp() > 0, { timeoutTicks: 15 })) {
        throw Error('wild-dragons: initial state unknown');
    }
    const p0 = st()!.player!;
    const start = s.tick();
    const ours = fleetNames();
    const magic0 = st()!.skills.find(k => k.name === 'Magic')?.level ?? 1;
    const escapeLawReserve = hasVarrockTeleport(magic0, st()!.inventory, st()!.equipment)
        ? Math.min(countId(st()!, ITEMS.lawRune), 5)
        : 0;
    const inWild0 = wildernessLevel(p0.worldZ) > 0;
    const preflight = wildDragonPreflight(st(), !!o.staged || inWild0);
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

    const retreatToSafety = async () => {
        for (let step = 0; step < 30 && !over(); step++) {
            const cur = st();
            if (!cur?.player) break;
            if (wildernessLevel(cur.player.worldZ) === 0) return true;
            if (hp() <= o.eatAt) {
                const ate = await eatBetweenCasts(s, { food: [...DRAGON_FOOD_IDS], eatAt: o.eatAt, timeoutTicks: 4, attempts: 1 });
                if (ate) eaten++;
            }
            const plan = wildDragonEscapeAction(st()!);
            if (plan.kind === 'glory') {
                const glory = st()!.inventory.find(i => (ITEMS.glory as readonly number[]).includes(i.id));
                const wornGlory = !glory ? st()!.equipment.find(i => i.slot === 2 && (ITEMS.glory as readonly number[]).includes(i.id)) : undefined;
                if (!glory && wornGlory && st()!.inventory.length < 28 && typeof s.sdk.sendUseEquipmentItem === 'function') {
                    await s.sdk.sendUseEquipmentItem(wornGlory.slot, 1);
                    await waitTicks(s, 1);
                    continue;
                }
                if (glory) {
                    const op = glory.optionsWithIndex?.find(x => /^Rub$/i.test(x.text));
                    if (op) await s.sdk.sendUseItem(glory.slot, op.opIndex);
                    for (let t = 0; t < 15 && !over() && wildernessLevel(st()?.player?.worldZ ?? 0) > 0; t++) {
                        await waitTicks(s, 1);
                        if (st()?.dialog?.isOpen) await s.sdk.clickDialogByText(/^Edgeville/i);
                    }
                    if (wildernessLevel(st()?.player?.worldZ ?? 0) === 0) return true;
                }
            }
            if (plan.kind === 'teleport') {
                await s.sdk.sendClickComponent(componentId('magic:varrock_teleport'));
                await waitTicks(s, 6);
                if (wildernessLevel(st()?.player?.worldZ ?? 0) === 0) return true;
            }
            const nextSouthZ = Math.max(SAFE_SOUTH_TILE.z, cur.player.worldZ - 48);
            await walkSafe({ x: cur.player.worldX, z: nextSouthZ }, 120);
        }
        const cur = st()?.player;
        return !!cur && wildernessLevel(cur.worldZ) === 0;
    };

    const bankAndRestock = async (depositOnly = false) => {
        const p = st()?.player;
        if (p && wildernessLevel(p.worldZ) > 0 && !(await retreatToSafety())) return false;
        if (over()) return false;
        if (!(await walkSafe(EDGEVILLE_BANK, 500)).ok) return false;
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!st()?.bank?.isOpen, { timeoutTicks: 15 })) return false;
        const inv = st()!;
        bonesBanked += countId(inv, DRAGON_BONES_ID);
        hidesBanked += countId(inv, GREEN_DHIDE_ID);
        // Bank any looted law runes above the initial escape teleport reserve before depositPack keeps the reserve.
        const excessLaws = Math.max(0, countId(inv, ITEMS.lawRune) - escapeLawReserve);
        if (excessLaws > 0 && escapeLawReserve > 0) {
            const lawItem = inv.inventory.find(i => i.id === ITEMS.lawRune);
            if (lawItem) {
                await s.bot.depositItem(lawItem, excessLaws);
                await waitTicks(s, 1);
            }
        }
        await depositPack(s, i => wildDragonEscapeKeep(i, escapeLawReserve));
        if (!depositOnly) {
            let remaining = Math.max(0, o.foodCount - countFood(st()!));
            for (const id of DRAGON_FOOD_IDS) {
                if (remaining <= 0) break;
                const row = st()?.bank?.items.find(i => i.id === id && i.count > 0);
                if (!row) continue;
                const before = countFood(st()!);
                const take = Math.min(remaining, row.count, 28 - st()!.inventory.length);
                if (take <= 0) break;
                await s.bot.withdrawItem(row, take, { asNote: false });
                await waitTicks(s, 1);
                const gained = Math.max(0, countFood(st()!) - before);
                remaining = Math.max(0, remaining - gained);
            }
        }
        await s.bot.closeBank();
        trips++;
        return true;
    };

    try {
        if (!o.staged) {
            const cur = st()!;
            if (wildernessLevel(cur.player!.worldZ) === 0 && (cur.inventory.some(i => i.id === DRAGON_BONES_ID || i.id === GREEN_DHIDE_ID) || countFood(cur) < o.foodCount)) {
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
