import { existsSync } from 'node:fs';
import { waitTicks } from '../packages/core/src/ticks';
import { xpForLevel } from '../packages/planner/src/curve';
import { componentId } from '../packages/core/src/logout';
import { finish } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { miningProfiles, MINING_SITES, siteTiles } from '../packages/workers/src/gather';
import {
    openHelperAndMain,
    skipTutorialFast,
    startHelperTradeArm,
    receiveTradeFast,
    settleHelper,
    rubTeleport,
    walkWaypointsSafe,
    slotOfId,
    itemQty,
    chebDist,
    SKILL_MULTI3_MAKE1_A,
    OBJ_KNIFE,
    OBJ_LOGS,
    OBJ_GLORY_4,
} from './gathering-specialist-lib';

export const OBJ_BRONZE_PICKAXE = 1265;
export const OBJ_RUNE_PICKAXE = 1275;
export const OBJ_TIN_ORE = 438;
export const OBJ_IRON_ORE = 440;
export const OBJ_SHORTBOW = 841;
export const OBJ_MONK_ROBE_BOTTOM = 542;
export const OBJ_MONK_ROBE_TOP = 544;
export const OBJ_HOLY_SYMBOL = 1718;
export const OBJ_DRAGON_BONES = 536;
export const OBJ_PRAYER_POTION_4 = 2434;
export const PRAYER_POTION_IDS = [2434, 139, 141, 143] as const;
export const OBJ_AIR_RUNE = 556;
export const OBJ_MIND_RUNE = 558;
export const PROTECT_FROM_MELEE_PRAYER = 14;
export const IRON_ORE_XP_25X = 875;

export const MINING_GLORY_IDS = [OBJ_GLORY_4, 1710, 1708, 1706] as const;
export const BARBARIAN_TIN_CENTER = { x: 3087, z: 3417, level: 0 } as const;
export const WILDY_HOBGOBLIN_CENTER = { x: 3100, z: 3766, level: 0 } as const;

// 25 supply slots + kept tutorial Bronze pickaxe & Shortbow = 27 slots: 11 Dragon bones (Prayer 43) + Monk robes +
// Holy symbol + 4 Prayer pots allow zero-damage 2-tick Hobgoblin flinch + 3-tick knife mining at Wilderness 8-rock.
export const MINING_SPECIALIST_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_RUNE_PICKAXE]: 1,
    [OBJ_KNIFE]: 1,
    [OBJ_LOGS]: 2,
    [OBJ_GLORY_4]: 1,
    [OBJ_MONK_ROBE_BOTTOM]: 1,
    [OBJ_MONK_ROBE_TOP]: 1,
    [OBJ_HOLY_SYMBOL]: 1,
    [OBJ_AIR_RUNE]: 150,
    [OBJ_MIND_RUNE]: 150,
    [OBJ_DRAGON_BONES]: 11,
    [OBJ_PRAYER_POTION_4]: 4,
};

export const MINING_SPECIALIST_LIVE_SUPPLIES: Readonly<Record<number, number>> = MINING_SPECIALIST_SUPPLIES;

const MINING_KEEP_IDS = new Set<number>([
    OBJ_BRONZE_PICKAXE,
    OBJ_RUNE_PICKAXE,
    OBJ_KNIFE,
    OBJ_LOGS,
    ...MINING_GLORY_IDS,
    OBJ_SHORTBOW,
    OBJ_MONK_ROBE_BOTTOM,
    OBJ_MONK_ROBE_TOP,
    OBJ_HOLY_SYMBOL,
    OBJ_AIR_RUNE,
    OBJ_MIND_RUNE,
    OBJ_DRAGON_BONES,
    ...PRAYER_POTION_IDS,
]);

const WIND_STRIKE = componentId('magic:wind_strike');
const AUTO_RETALIATE_ON_COMP = 150;

export function remainingIronOresTo99(currentXp: number): number {
    return Math.max(0, Math.ceil((xpForLevel(99) - currentXp) / IRON_ORE_XP_25X));
}

function isProtectMeleeOn(st: ReturnType<Session['sdk']['getState']>): boolean {
    return Boolean((st as { prayers?: { activePrayers?: boolean[] } } | undefined)?.prayers?.activePrayers?.[PROTECT_FROM_MELEE_PRAYER]);
}

function findPrayerPotionSlot(s: Session): number | undefined {
    const inv = s.sdk.getInventory();
    for (const id of PRAYER_POTION_IDS) {
        const hit = inv.find(i => i.id === id);
        if (hit) return hit.slot;
    }
    return undefined;
}

function tryDrinkPrayerPotion(s: Session, minPts = 15): Promise<unknown> | null {
    const pts = s.sdk.getSkill('Prayer')?.level ?? 0;
    if (pts > minPts) return null;
    const slot = findPrayerPotionSlot(s);
    if (slot === undefined) return null;
    const item = s.sdk.getInventory().find(i => i.slot === slot);
    const op = item?.optionsWithIndex?.find(o => /^drink$/i.test(o.text))?.opIndex ?? 1;
    return s.direct({ type: 'useInventoryItem', slot, optionIndex: op, reason: 'SDK' });
}

async function buryPrayerBones(s: Session, stop: () => boolean, targetLevel = 43): Promise<void> {
    for (let i = 0; i < 24 && !stop(); i++) {
        if ((s.sdk.getSkill('Prayer')?.baseLevel ?? 1) >= targetLevel) break;
        const slot = slotOfId(s, OBJ_DRAGON_BONES);
        if (slot === undefined) break;
        const item = s.sdk.getInventory().find(it => it.slot === slot);
        const op = item?.optionsWithIndex?.find(o => /^bury$/i.test(o.text))?.opIndex ?? 1;
        const beforeXp = s.sdk.getSkill('Prayer')?.experience ?? 0;
        await s.direct({ type: 'useInventoryItem', slot, optionIndex: op, reason: 'SDK' });
        for (let t = 0; t < 3 && !stop(); t++) {
            await waitTicks(s, 1);
            if ((s.sdk.getSkill('Prayer')?.experience ?? 0) > beforeXp) break;
        }
    }
    const lvl = s.sdk.getSkill('Prayer')?.baseLevel ?? 1;
    if (lvl < targetLevel) throw Error(`buryPrayerBones: reached Prayer ${lvl} < ${targetLevel}`);
}

async function equipMiningGear(s: Session, ids: readonly number[]): Promise<void> {
    const pending = ids
        .map(id => s.sdk.getInventory().find(i => i.id === id))
        .filter((it): it is NonNullable<typeof it> => !!it);
    for (let i = 0; i < pending.length; i += 4) {
        const batch = pending.slice(i, i + 4).map(item => {
            const op = item.optionsWithIndex?.find(o => /^(wield|wear|equip)$/i.test(o.text))?.opIndex ?? 2;
            return s.direct({ type: 'useInventoryItem', slot: item.slot, optionIndex: op, reason: 'SDK' });
        });
        await Promise.all(batch);
        await waitTicks(s, 1);
    }
    const st = s.sdk.getState();
    const acts: Promise<unknown>[] = [];
    const curStyle = typeof st?.combatStyle === 'object' && st.combatStyle !== null ? st.combatStyle.currentStyle : 0;
    if (curStyle !== 1) acts.push(s.direct({ type: 'setCombatStyle', style: 1, reason: 'SDK' }));
    if (st?.autoRetaliateEnabled === false) acts.push(s.direct({ type: 'clickComponent', componentId: AUTO_RETALIATE_ON_COMP, reason: 'SDK' }));
    if (acts.length > 0) await Promise.all(acts);
}

type NearbyLoc = NonNullable<NonNullable<ReturnType<Session['sdk']['getState']>>['nearbyLocs']>[number];

const besideTile = (px: number, pz: number, r: { x: number; z: number }): boolean =>
    Math.abs(px - r.x) + Math.abs(pz - r.z) === 1;

const EAST_IRON_ROCK_COORDS = new Set<string>([
    '3099,3768',
    '3101,3768',
    '3099,3767',
    '3100,3766',
    '3101,3765',
    '3100,3765',
]);
const FALLBACK_EAST_ROCK_COORDS = new Set<string>([
    ...EAST_IRON_ROCK_COORDS,
    '3099,3765',
]);

const isEastHobgoblinStandTile = (x: number, z: number): boolean => x >= 3100 || z === 3764;

function findAvailableRocks(
    s: Session,
    rockCoords: ReadonlySet<string>,
    rockIds: ReadonlySet<number>,
): { x: number; z: number; id: number; op: number }[] {
    const out: { x: number; z: number; id: number; op: number }[] = [];
    for (const l of s.sdk.getState()?.nearbyLocs ?? []) {
        if (!rockIds.has(l.id) || !rockCoords.has(`${l.x},${l.z}`)) continue;
        if (l.reachable === false) continue;
        const op = l.optionsWithIndex?.find(o => /^mine$/i.test(o.text))?.opIndex;
        if (op === undefined) continue;
        out.push({ x: l.x, z: l.z, id: l.id, op });
    }
    return out;
}

function pickBestIronStandTile(
    s: Session,
    avail: readonly { x: number; z: number }[],
    allRockCoords: ReadonlySet<string>,
    eastOnly = false,
): { x: number; z: number } | undefined {
    const p = s.sdk.getState()?.player;
    const px = p?.worldX ?? WILDY_HOBGOBLIN_CENTER.x;
    const pz = p?.worldZ ?? WILDY_HOBGOBLIN_CENTER.z;
    const cands = new Map<string, { x: number; z: number; adjAvail: number; adjTotal: number; dist: number }>();
    for (const r of avail) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const x = r.x + dx;
            const z = r.z + dz;
            if (allRockCoords.has(`${x},${z}`)) continue;
            if (eastOnly && !isEastHobgoblinStandTile(x, z)) continue;
            const k = `${x},${z}`;
            if (cands.has(k)) continue;
            const adjAvail = avail.filter(a => besideTile(x, z, a)).length;
            let adjTotal = 0;
            for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
                if (allRockCoords.has(`${x + ax},${z + az}`)) adjTotal++;
            }
            cands.set(k, { x, z, adjAvail, adjTotal, dist: Math.max(Math.abs(x - px), Math.abs(z - pz)) });
        }
    }
    const sorted = [...cands.values()].sort((a, b) => {
        // Stay on 2-rock hubs when within a 1-tick run step (dist <= 2) instead of chasing a single edge rock.
        const aRun = a.dist <= 2 ? 1 : a.dist;
        const bRun = b.dist <= 2 ? 1 : b.dist;
        return (aRun - bRun) || (b.adjAvail - a.adjAvail) || (b.adjTotal - a.adjTotal) || (a.dist - b.dist);
    });
    for (const c of sorted) {
        const path = s.sdk.findPath(c.x, c.z);
        if (path.success && path.reachedDestination === true) return { x: c.x, z: c.z };
    }
    return sorted[0];
}

function targetsPlayer(s: Session, targetIndex: number): boolean {
    if (targetIndex < 32768) return false;
    const otherPlayers = new Set((s.sdk.getState()?.nearbyPlayers ?? []).map(p => p.index));
    return !otherPlayers.has(targetIndex - 32768);
}

function countAttackingHobgoblins(s: Session): number {
    let count = 0;
    for (const n of s.sdk.getState()?.nearbyNpcs ?? []) {
        if (!/^hobgoblin$/i.test(n.name) || n.hp === 0) continue;
        if (targetsPlayer(s, n.targetIndex) || (n.inCombat && n.distance <= 2)) count++;
    }
    return count;
}

function findUntaggedHobgoblin(s: Session, taggedAt: ReadonlyMap<number, number>, now: number) {
    const cands = (s.sdk.getState()?.nearbyNpcs ?? []).filter(n => {
        if (!/^hobgoblin$/i.test(n.name) || n.hp === 0 || n.distance > 6) return false;
        if ((n as { reachable?: boolean }).reachable === false) return false;
        if ((taggedAt.get(n.index) ?? -999) >= now - 25) return false;
        if (targetsPlayer(s, n.targetIndex)) return false;
        return n.targetIndex < 0;
    });
    // Prefer lvl 28 unarmed hobgoblins (attackrate=4, wanderrange=15) over lvl 42 armed (attackrate=6, wanderrange=3).
    cands.sort((a, b) =>
        ((a.combatLevel > 35 ? 1 : 0) - (b.combatLevel > 35 ? 1 : 0))
        || (a.distance - b.distance)
        || (a.combatLevel - b.combatLevel),
    );
    return cands[0];
}

async function mineTinTo15(main: Session, stop: () => boolean): Promise<void> {
    const tinProf = miningProfiles().find(p => p.name === 'tin_rock_table');
    if (!tinProf) throw Error('missing tin_rock_table profile');
    const tinIds = new Set(tinProf.rocks);
    const tinTiles = siteTiles(tinProf, { key: 'barb-tin', profile: 'tin_rock_table', center: BARBARIAN_TIN_CENTER, radius: 6, bank: BARBARIAN_TIN_CENTER });
    const tinCoords = new Set(tinTiles.map(t => `${t.x},${t.z}`));
    let delay = 0;
    while (!stop() && (main.sdk.getSkill('Mining')?.baseLevel ?? 1) < 15) {
        if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
            await main.direct({ type: 'closeModal', reason: 'SDK' });
        }
        const now = main.tick();
        if (now < delay) {
            await waitTicks(main, 1);
            continue;
        }
        const avail = findAvailableRocks(main, tinCoords, tinIds);
        const p = main.sdk.getState()?.player;
        if (!avail.length || !p) {
            await waitTicks(main, 1);
            continue;
        }
        avail.sort((a, b) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ)) - Math.max(Math.abs(b.x - p.worldX), Math.abs(b.z - p.worldZ)));
        const rock = avail[0]!;
        if (!besideTile(p.worldX, p.worldZ, rock)) {
            const st = pickBestIronStandTile(main, [rock], tinCoords);
            if (st) await main.direct({ type: 'walkTo', x: st.x, z: st.z, running: true, reason: 'SDK' });
            await waitTicks(main, 1);
            continue;
        }
        const knifeSlot = slotOfId(main, OBJ_KNIFE);
        const logSlot = slotOfId(main, OBJ_LOGS);
        const acts: Promise<unknown>[] = [];
        const tinDrop = slotOfId(main, OBJ_TIN_ORE);
        if (tinDrop !== undefined && main.sdk.getInventory().length >= 26) {
            acts.push(main.direct({ type: 'dropItem', slot: tinDrop, reason: 'SDK' }));
        }
        if (knifeSlot !== undefined && logSlot !== undefined) {
            acts.push(
                main.direct({ type: 'useItemOnItem', sourceSlot: knifeSlot, targetSlot: logSlot, reason: 'SDK' }),
                main.direct({ type: 'clickComponent', componentId: SKILL_MULTI3_MAKE1_A, reason: 'SDK' }),
            );
        }
        acts.push(main.direct({ type: 'interactLoc', x: rock.x, z: rock.z, locId: rock.id, optionIndex: rock.op, reason: 'SDK' }));
        await Promise.all(acts);
        delay = now + 4;
        await waitTicks(main, 1);
    }
    if ((main.sdk.getSkill('Mining')?.baseLevel ?? 1) < 15) {
        throw Error(`Barbarian Village tin failed reaching Mining 15 (lvl=${main.sdk.getSkill('Mining')?.baseLevel})`);
    }
    for (const it of main.sdk.getInventory().filter(i => i.id === OBJ_TIN_ORE).slice(0, 5)) {
        await main.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' });
    }
}

async function clearMiningInteraction(s: Session): Promise<void> {
    const p = s.sdk.getState()?.player;
    if (p) {
        await s.direct({ type: 'walkTo', x: p.worldX, z: p.worldZ, running: true, reason: 'SDK' });
    }
}

if (import.meta.main) {
    const account = process.argv[2];
    const helperName = process.argv.slice(3).find(a => !a.includes('=') && !a.startsWith('-')) ?? process.env.HELPER ?? `${account}b`;
    const cap = Number(process.env.CAP ?? 4400);
    if (!account) throw Error('usage: bun scripts/mining-specialist.ts <account> [helperAccount]');

    const { main, helper, stopped } = await openHelperAndMain(account, helperName);
    const t0 = main.tick();
    const isStopped = () => stopped() || existsSync(`.practice/stop-${account}`) || existsSync('.practice/stop-all') || main.tick() - t0 >= cap;
    let helperDone: Promise<void> | undefined;
    let ok = false;
    let detail = '';

    let readyForTrade = false;
    const arm = startHelperTradeArm(helper, main.name, isStopped, () => readyForTrade);
    try {
        const tutTicks = await skipTutorialFast(main, isStopped);
        for (let b = 0; b < 4 && !isStopped(); b++) {
            const junk = main.sdk.getInventory().filter(i => !MINING_KEEP_IDS.has(i.id)).slice(0, 5);
            if (junk.length === 0) break;
            await Promise.all(junk.map(it => main.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' })));
            await waitTicks(main, 1);
        }
        readyForTrade = true;
        const tradeTicks = await receiveTradeFast(
            main,
            helper,
            MINING_SPECIALIST_SUPPLIES,
            isStopped,
            arm,
            { [OBJ_GLORY_4]: MINING_GLORY_IDS },
        );
        helperDone = settleHelper(helper).catch(err => {
            console.log(`WARN helper settle: ${String(err)}`);
        });

        await buryPrayerBones(main, isStopped, 43);
        await equipMiningGear(main, [
            OBJ_MONK_ROBE_TOP,
            OBJ_MONK_ROBE_BOTTOM,
            OBJ_SHORTBOW,
            OBJ_HOLY_SYMBOL,
        ]);

        // Edgeville Glory -> Barbarian Village Tin (39t walk, 6 tin -> Mining 15) -> Edgeville Glory -> Wilderness Hobgoblin 8-rock.
        await rubTeleport(
            main,
            MINING_GLORY_IDS,
            1,
            p => p.worldX >= 3070 && p.worldX <= 3110 && p.worldZ >= 3480 && p.worldZ <= 3515,
            isStopped,
        );
        await walkWaypointsSafe(main, [[3087, 3417, 2]], isStopped);
        await mineTinTo15(main, isStopped);
        const tinTicks = main.tick() - t0;

        await rubTeleport(
            main,
            MINING_GLORY_IDS,
            1,
            p => p.worldX >= 3070 && p.worldX <= 3110 && p.worldZ >= 3480 && p.worldZ <= 3515,
            isStopped,
        );
        if ((main.sdk.getSkill('Prayer')?.baseLevel ?? 1) >= 43 && !isProtectMeleeOn(main.sdk.getState())) {
            await main.direct({ type: 'togglePrayer', prayerIndex: PROTECT_FROM_MELEE_PRAYER, reason: 'SDK' });
        }
        await walkWaypointsSafe(main, [[3100, 3767, 1]], isStopped);
        const arriveTick = main.tick() - t0;

        const ironProfile = miningProfiles().find(p => p.name === 'iron_rock_table');
        if (!ironProfile) throw Error('missing iron_rock_table profile');
        const wildySite = MINING_SITES.find(s => s.key === 'wilderness-hobgoblin-iron');
        if (!wildySite) throw Error('missing wilderness-hobgoblin-iron site');
        const rockTiles = siteTiles(ironProfile, wildySite).filter(t => EAST_IRON_ROCK_COORDS.has(`${t.x},${t.z}`));
        const rockCoords = new Set(rockTiles.map(t => `${t.x},${t.z}`));
        const fallbackRockTiles = siteTiles(ironProfile, wildySite).filter(t => FALLBACK_EAST_ROCK_COORDS.has(`${t.x},${t.z}`));
        const fallbackRockCoords = new Set(fallbackRockTiles.map(t => `${t.x},${t.z}`));
        const allWildyRockCoords = new Set(siteTiles(ironProfile, wildySite).map(t => `${t.x},${t.z}`));
        const rockIds = new Set(ironProfile.rocks);

        let rolls = 0;
        let flinchRolls = 0;
        let knifeRolls = 0;
        let moveTicks = 0;
        let lastTagTick = -99;
        let tagCount = 0;
        let actionDelayApprox = 0;
        let clearSentForTick = -99;
        let droppedBronze = false;
        const taggedAt = new Map<number, number>();
        const seenHitKeys = new Set<string>();
        const recentHitTicks: number[] = [];
        const npcLastHit = new Map<number, { tick: number; period: number }>();
        let hitEventsTotal = 0;

        const drainHitEvents = (st: ReturnType<Session['sdk']['getState']>): number => {
            let maxHitTick = -1;
            const events = (st as {
                combatEvents?: Array<{ observationId?: number; tick?: number; type?: string; sourceType?: string; targetType?: string; sourceIndex?: number; damage?: number }>;
            } | undefined)?.combatEvents ?? [];
            const npcs = st?.nearbyNpcs ?? [];
            for (const e of events) {
                if (e.type !== 'damage_taken' || e.sourceType !== 'npc') continue;
                if (e.targetType && e.targetType !== 'player') continue;
                const k = `${e.observationId ?? ''}:${e.tick ?? ''}:${e.sourceIndex ?? ''}:${e.damage ?? ''}`;
                if (seenHitKeys.has(k)) continue;
                seenHitKeys.add(k);
                hitEventsTotal++;
                if (typeof e.tick === 'number') {
                    if (!recentHitTicks.includes(e.tick)) recentHitTicks.push(e.tick);
                    if (typeof e.sourceIndex === 'number') {
                        const prev = npcLastHit.get(e.sourceIndex);
                        const npc = npcs.find(n => n.index === e.sourceIndex);
                        const defaultPeriod = npc && npc.combatLevel > 35 ? 6 : 4;
                        let period = prev?.period ?? defaultPeriod;
                        if (prev) {
                            const diff = e.tick - prev.tick;
                            if (diff >= 4 && diff <= 6) period = diff;
                        }
                        if (!prev || e.tick > prev.tick) {
                            npcLastHit.set(e.sourceIndex, { tick: e.tick, period });
                        }
                    }
                    if (e.tick > maxHitTick) maxHitTick = e.tick;
                }
            }
            return maxHitTick;
        };
        drainHitEvents(main.sdk.getState());

        const traceLimit = 35;
        let traceCount = 0;

        while (!isStopped()) {
            const mineLvl = main.sdk.getSkill('Mining')?.baseLevel ?? 1;
            const mineXp = main.sdk.getSkillXp('Mining') ?? 0;
            if (mineLvl >= 99 || mineXp >= xpForLevel(99)) {
                ok = true;
                break;
            }
            if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
                await main.direct({ type: 'closeModal', reason: 'SDK' });
            }
            if (!droppedBronze && mineLvl >= 41) {
                const bronzeSlot = slotOfId(main, OBJ_BRONZE_PICKAXE);
                if (bronzeSlot !== undefined) await main.direct({ type: 'dropItem', slot: bronzeSlot, reason: 'SDK' });
                droppedBronze = true;
            }

            const now = main.tick();
            const st = main.sdk.getState();
            const hitTick = drainHitEvents(st);
            const prayPts = main.sdk.getSkill('Prayer')?.level ?? 0;
            const outOfPrayer = prayPts === 0 && findPrayerPotionSlot(main) === undefined;
            if (!outOfPrayer && !isProtectMeleeOn(st) && prayPts === 0 && (main.sdk.getSkill('Prayer')?.baseLevel ?? 1) >= 43) {
                const potAct = tryDrinkPrayerPotion(main, 99);
                if (potAct) {
                    await potAct;
                    clearSentForTick = -99;
                    await waitTicks(main, 1);
                    continue;
                }
            }

            const validFlinchHit = !outOfPrayer && hitTick === now && clearSentForTick === now && now >= actionDelayApprox;
            let avail = findAvailableRocks(main, rockCoords, rockIds);
            if (!avail.length) avail = findAvailableRocks(main, fallbackRockCoords, rockIds);
            const p = st?.player;
            if (!avail.length || !p) {
                const acts: Promise<unknown>[] = [];
                const potAct = outOfPrayer ? null : tryDrinkPrayerPotion(main, 15);
                if (potAct) acts.push(potAct);
                if (now >= actionDelayApprox) {
                    acts.push(clearMiningInteraction(main));
                    clearSentForTick = now + 1;
                }
                if (acts.length > 0) await Promise.all(acts);
                await waitTicks(main, 1);
                continue;
            }

            const adjRocks = avail.filter(r => besideTile(p.worldX, p.worldZ, r));
            if (adjRocks.length === 0) {
                const stand = pickBestIronStandTile(main, avail, allWildyRockCoords, true);
                const standDist = stand ? Math.max(Math.abs(stand.x - p.worldX), Math.abs(stand.z - p.worldZ)) : 99;
                const stepRock = stand
                    ? avail.find(r => besideTile(stand.x, stand.z, r) && EAST_IRON_ROCK_COORDS.has(`${r.x},${r.z}`))
                    : undefined;
                const knifeSlot = slotOfId(main, OBJ_KNIFE);
                const logSlot = slotOfId(main, OBJ_LOGS);
                if (stand && standDist <= 2 && stepRock && now >= actionDelayApprox && knifeSlot !== undefined && logSlot !== undefined && main.sdk.getInventory().length < 28) {
                    // Combine 1-tick step + knife3 + interactLoc so arrival & swing overlap without an idle walk tick.
                    await Promise.all([
                        main.direct({ type: 'useItemOnItem', sourceSlot: knifeSlot, targetSlot: logSlot, reason: 'SDK' }),
                        main.direct({ type: 'clickComponent', componentId: SKILL_MULTI3_MAKE1_A, reason: 'SDK' }),
                        main.direct({ type: 'interactLoc', x: stepRock.x, z: stepRock.z, locId: stepRock.id, optionIndex: stepRock.op, reason: 'SDK' }),
                    ]);
                    knifeRolls++;
                    rolls++;
                    moveTicks++;
                    actionDelayApprox = now + 3;
                    clearSentForTick = -99;
                    await waitTicks(main, 1);
                    continue;
                }
                const acts: Promise<unknown>[] = [];
                if (stand) acts.push(main.direct({ type: 'walkTo', x: stand.x, z: stand.z, running: true, reason: 'SDK' }));
                const potAct = outOfPrayer ? null : tryDrinkPrayerPotion(main, 15);
                if (potAct) acts.push(potAct);
                const dropSlot = main.sdk.getInventory().length >= 18 ? (slotOfId(main, OBJ_IRON_ORE) ?? slotOfId(main, OBJ_TIN_ORE)) : undefined;
                if (dropSlot !== undefined) acts.push(main.direct({ type: 'dropItem', slot: dropSlot, reason: 'SDK' }));
                if (acts.length > 0) await Promise.all(acts);
                moveTicks++;
                clearSentForTick = -99;
                await waitTicks(main, 1);
                continue;
            }
            const rock = adjRocks[0]!;

            if (validFlinchHit) {
                const acts: Promise<unknown>[] = [];
                const potAct = outOfPrayer ? null : tryDrinkPrayerPotion(main, 15);
                if (potAct) acts.push(potAct);
                if (!potAct && main.sdk.getInventory().length >= 26) {
                    const oreSlot = slotOfId(main, OBJ_IRON_ORE) ?? slotOfId(main, OBJ_TIN_ORE);
                    if (oreSlot !== undefined) acts.push(main.direct({ type: 'dropItem', slot: oreSlot, reason: 'SDK' }));
                }
                acts.push(main.direct({ type: 'interactLoc', x: rock.x, z: rock.z, locId: rock.id, optionIndex: rock.op, reason: 'SDK' }));
                await Promise.all(acts);
                flinchRolls++;
                rolls++;
                actionDelayApprox = now + 1;
                clearSentForTick = -99;
                if (traceCount < traceLimit) {
                    traceCount++;
                    console.log(`MINE_TRACE flinch t=${now - t0} pos=${p.worldX},${p.worldZ} hits=${hitEventsTotal} gobs=${countAttackingHobgoblins(main)}`);
                }
                await waitTicks(main, 1);
                continue;
            }

            if (now < actionDelayApprox) {
                await waitTicks(main, 1);
                continue;
            }

            while (recentHitTicks.length > 0 && recentHitTicks[0]! <= now - 10) recentHitTicks.shift();
            const nearbyNpcs = st?.nearbyNpcs ?? [];
            let activeHitIn1t = false;
            for (const [npcIdx, info] of npcLastHit) {
                if (now - info.tick > 10) {
                    npcLastHit.delete(npcIdx);
                    continue;
                }
                const npc = nearbyNpcs.find(n => n.index === npcIdx);
                if (!npc || npc.hp === 0 || npc.distance > 3) continue;
                if (npc.targetIndex >= 0 && !targetsPlayer(main, npc.targetIndex)) continue;
                if (now + 1 - info.tick === info.period || now + 1 - info.tick === info.period * 2) {
                    activeHitIn1t = true;
                    break;
                }
            }

            const gobs = !outOfPrayer ? countAttackingHobgoblins(main) : 0;
            const canTag = !outOfPrayer
                && !activeHitIn1t
                && tagCount < 45
                && gobs < 3
                && now - lastTagTick >= 10
                && now >= actionDelayApprox
                && itemQty(main, OBJ_AIR_RUNE) > 1
                && itemQty(main, OBJ_MIND_RUNE) > 0;
            if (canTag) {
                const target = findUntaggedHobgoblin(main, taggedAt, now);
                if (target) {
                    lastTagTick = now;
                    tagCount++;
                    taggedAt.set(target.index, now);
                    actionDelayApprox = now + 3;
                    const acts: Promise<unknown>[] = [
                        main.direct({ type: 'spellOnNpc', npcIndex: target.index, spellComponent: WIND_STRIKE, reason: 'SDK' }),
                    ];
                    const potAct = tryDrinkPrayerPotion(main, 15);
                    if (potAct) acts.push(potAct);
                    await Promise.all(acts);
                    clearSentForTick = -99;
                    await waitTicks(main, 1);
                    continue;
                }
            }

            const keepFlinchWindow = !outOfPrayer && activeHitIn1t;
            if (!keepFlinchWindow) {
                if (traceCount < traceLimit) {
                    traceCount++;
                    const tracked = [...npcLastHit.entries()].map(([id, inf]) => {
                        const n = nearbyNpcs.find(x => x.index === id);
                        return `${id}:dt=${now - inf.tick}/p=${inf.period}/d=${n?.distance ?? '?'}/t=${n?.targetIndex ?? '?'}`;
                    }).join(',');
                    console.log(`MINE_TRACE knife3 t=${now - t0} pos=${p.worldX},${p.worldZ} gobs=${gobs} hits=${hitEventsTotal} tracked=[${tracked}]`);
                }
                const knifeSlot = slotOfId(main, OBJ_KNIFE);
                const logSlot = slotOfId(main, OBJ_LOGS);
                if (knifeSlot !== undefined && logSlot !== undefined) {
                    if (main.sdk.getInventory().length >= 28) {
                        const oreSlots = main.sdk.getInventory().filter(i => i.id === OBJ_IRON_ORE || i.id === OBJ_TIN_ORE).slice(0, 4);
                        if (oreSlots.length > 0) {
                            await Promise.all(oreSlots.map(it => main.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' })));
                            await waitTicks(main, 1);
                            continue;
                        }
                    }
                    await Promise.all([
                        main.direct({ type: 'useItemOnItem', sourceSlot: knifeSlot, targetSlot: logSlot, reason: 'SDK' }),
                        main.direct({ type: 'clickComponent', componentId: SKILL_MULTI3_MAKE1_A, reason: 'SDK' }),
                        main.direct({ type: 'interactLoc', x: rock.x, z: rock.z, locId: rock.id, optionIndex: rock.op, reason: 'SDK' }),
                    ]);
                    knifeRolls++;
                    rolls++;
                    actionDelayApprox = now + 3;
                    clearSentForTick = -99;
                    await waitTicks(main, 1);
                    continue;
                }
            }

            const oreDropSlot = main.sdk.getInventory().length >= 10
                ? (slotOfId(main, OBJ_IRON_ORE) ?? slotOfId(main, OBJ_TIN_ORE))
                : undefined;
            const potAct = tryDrinkPrayerPotion(main, 15);
            if (oreDropSlot !== undefined) {
                await Promise.all([
                    ...(potAct ? [potAct] : []),
                    main.direct({ type: 'dropItem', slot: oreDropSlot, reason: 'SDK' }),
                ]);
            } else {
                await Promise.all([
                    ...(potAct ? [potAct] : []),
                    clearMiningInteraction(main),
                ]);
            }
            clearSentForTick = now + 1;
            await waitTicks(main, 1);
        }

        if ((main.sdk.getSkill('Mining')?.baseLevel ?? 1) >= 99) ok = true;
        if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
            await main.direct({ type: 'closeModal', reason: 'SDK' });
        }

        const totalTicks = main.tick() - t0;
        const lvl = main.sdk.getSkill('Mining')?.baseLevel ?? 0;
        const xp = main.sdk.getSkillXp('Mining') ?? 0;
        const hp = main.sdk.getSkill('Hitpoints')?.level ?? 0;
        detail = `level=${lvl} xp=${xp} ticks=${totalTicks} tut=${tutTicks} trade=${tradeTicks} tin=${tinTicks} arrive=${arriveTick} rolls=${rolls} flinch=${flinchRolls} knife=${knifeRolls} move=${moveTicks} tags=${tagCount} hits=${hitEventsTotal} hp=${hp}`;
    } catch (error) {
        detail = String(error);
    } finally {
        arm.close();
    }

    await helperDone;
    await finish([main], ok, detail);
}
