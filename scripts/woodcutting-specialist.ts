import { existsSync } from 'node:fs';
import { levelForXp, xpForLevel } from '../packages/planner/src/curve';
import { componentId } from '../packages/core/src/logout';
import { finish } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitTicks } from '../packages/core/src/ticks';
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
    OBJ_GLORY_4,
    OBJ_KNIFE,
    OBJ_LOGS,
    SKILL_MULTI3_MAKE1_A,
} from './gathering-specialist-lib';

export { OBJ_KNIFE, OBJ_LOGS };
export const OBJ_RUNE_AXE = 1359;
export const OBJ_OAK_LOGS = 1521;
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

export const WOODCUTTING_GLORY_IDS = [OBJ_GLORY_4, 1710, 1708, 1706] as const;

// 24 items fit after 4-tick tutorial junk drop (keeping Shortbow + 24 supply slots = 25 occupied slots).
// 11 Dragon bones (22t -> Prayer 43) + Monk's robes (+11) + Holy symbol (+8 = +19 Prayer bonus) + Protect from Melee = 0 melee dmg.
export const WOODCUTTING_SPECIALIST_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_RUNE_AXE]: 1,
    [OBJ_KNIFE]: 1,
    [OBJ_LOGS]: 1,
    [OBJ_GLORY_4]: 1,
    [OBJ_MONK_ROBE_BOTTOM]: 1,
    [OBJ_MONK_ROBE_TOP]: 1,
    [OBJ_HOLY_SYMBOL]: 1,
    [OBJ_AIR_RUNE]: 150,
    [OBJ_MIND_RUNE]: 150,
    [OBJ_DRAGON_BONES]: 11,
    [OBJ_PRAYER_POTION_4]: 4,
};

// Keep Rune axe, Knife, Logs (normal for 3t knife-reset), Glory, Shortbow, Monk robes, Holy symbol, runes, bones, prayer pots.
const WC_KEEP_IDS = new Set<number>([
    OBJ_RUNE_AXE,
    OBJ_KNIFE,
    OBJ_LOGS,
    OBJ_OAK_LOGS,
    ...WOODCUTTING_GLORY_IDS,
    OBJ_SHORTBOW,
    OBJ_MONK_ROBE_BOTTOM,
    OBJ_MONK_ROBE_TOP,
    OBJ_HOLY_SYMBOL,
    OBJ_DRAGON_BONES,
    ...PRAYER_POTION_IDS,
    OBJ_AIR_RUNE,
    OBJ_MIND_RUNE,
]);

// trees.dbrow + 25x curve: normal = 625 XP (3 logs -> lv15 = 1,860 XP), oak = 937.5 XP (1,064 logs -> lv99 = 998,458 XP).
export const WC_NORMAL_XP_25X = 625;
export const WC_OAK_XP_25X = 937.5;

// Draynor Jail multiway cluster (multiway.csv 0_48_50): 5 Oaks surrounded by 4 aggressive attackrate-5 Jail guards (hp 32).
export const DRAYNOR_JAIL_SPOT = { x: 3115, z: 3244 } as const;
export const DRAYNOR_JAIL_OAK_CENTERS: readonly [number, number][] = [
    [3114, 3239],
    [3115, 3243],
    [3115, 3250],
    [3118, 3245],
    [3119, 3256],
];

// Kept for test imports; active runtime uses Draynor Jail aggressive Jail guards + nearby Oaks.
export const BARB_VILLAGE_SPOT = { x: 3126, z: 3434 } as const;
export const BARB_NORMAL_CENTERS: readonly [number, number][] = [
    [3121, 3433],
    [3121, 3438],
    [3128, 3429],
    [3132, 3437],
];
export const BARB_OAK_CENTERS: readonly [number, number][] = [
    [3126, 3437],
    [3131, 3432],
    [3120, 3428],
];

export function planWoodcuttingTotals(goalXp = xpForLevel(99)): {
    normalLogs: number;
    oakLogs: number;
    totalXp: number;
} {
    const lv15 = xpForLevel(15);
    const normalLogs = Math.ceil(lv15 / WC_NORMAL_XP_25X);
    const afterNormal = normalLogs * WC_NORMAL_XP_25X;
    const oakLogs = Math.ceil(Math.max(0, goalXp - afterNormal) / WC_OAK_XP_25X);
    return {
        normalLogs,
        oakLogs,
        totalXp: afterNormal + oakLogs * WC_OAK_XP_25X,
    };
}

const WIND_STRIKE = componentId('magic:wind_strike');
const AUTO_RETALIATE_ON_COMP = 150;

const inDraynorJail = (p: { level: number; worldX: number; worldZ: number }): boolean =>
    p.level === 0 && p.worldX >= 3075 && p.worldX <= 3115 && p.worldZ >= 3230 && p.worldZ <= 3260;

type NearbyLoc = NonNullable<NonNullable<ReturnType<Session['sdk']['getState']>>['nearbyLocs']>[number];

function treeSizeForLoc(locName: string): number {
    return /^oak$/i.test(locName) ? 3 : 2;
}

function isBesideTree(px: number, pz: number, tx: number, tz: number, size: number): boolean {
    return (
        ((px === tx - 1 || px === tx + size) && pz >= tz && pz <= tz + size - 1)
        || ((pz === tz - 1 || pz === tz + size) && px >= tx && px <= tx + size - 1)
    );
}

function treeFootprintDist(px: number, pz: number, tx: number, tz: number, size: number): number {
    const dx = px < tx ? tx - px : px > tx + size - 1 ? px - (tx + size - 1) : 0;
    const dz = pz < tz ? tz - pz : pz > tz + size - 1 ? pz - (tz + size - 1) : 0;
    return Math.max(dx, dz);
}

function findBestTree(
    s: Session,
    wantOak: boolean,
    activeTree: { x: number; z: number } | null,
    safeWillow = false,
): NearbyLoc | undefined {
    const st = s.sdk.getState();
    const px = st?.player?.worldX ?? DRAYNOR_JAIL_SPOT.x;
    const pz = st?.player?.worldZ ?? DRAYNOR_JAIL_SPOT.z;
    const locs = st?.nearbyLocs ?? [];
    const nameRe = safeWillow ? /^willow$/i : (wantOak ? /^oak$/i : /^tree$/i);
    const cands = locs
        .filter(l => {
            if (!nameRe.test(l.name)) return false;
            if (!l.optionsWithIndex?.some(o => /chop/i.test(o.text))) return false;
            if (safeWillow) return l.x >= 3078 && l.x <= 3098 && l.z >= 3224 && l.z <= 3242;
            if (!wantOak) {
                // Allow all 4 fence-free inner normal trees (never stall waiting on a 120-200t single-tree respawn).
                return l.x >= 3113 && l.x <= 3120 && l.z >= 3238 && l.z <= 3251 && l.reachable !== false;
            }
            // Southern Draynor Jail clearing keeps all 3 yard Jail guards within maxrange+1 (=8) of hub (3117, 3242).
            return l.x >= 3114 && l.x <= 3119 && l.z >= 3238 && l.z <= 3246 && l.reachable !== false;
        });
    if (activeTree) {
        const cur = cands.find(l => l.x === activeTree.x && l.z === activeTree.z);
        if (cur && isBesideTree(px, pz, cur.x, cur.z, treeSizeForLoc(cur.name))) return cur;
    }
    const isHubOak = (l: NearbyLoc) => (l.x === 3114 && l.z === 3239) || (l.x === 3115 && l.z === 3243);
    return cands.sort((a, b) => {
        const sizeA = treeSizeForLoc(a.name);
        const sizeB = treeSizeForLoc(b.name);
        const adjDiff = (isBesideTree(px, pz, a.x, a.z, sizeA) ? 0 : 1) - (isBesideTree(px, pz, b.x, b.z, sizeB) ? 0 : 1);
        if (adjDiff !== 0) return adjDiff;
        const distDiff = treeFootprintDist(px, pz, a.x, a.z, sizeA) - treeFootprintDist(px, pz, b.x, b.z, sizeB);
        if (distDiff !== 0) return distDiff;
        if (wantOak && !safeWillow) {
            const hubDiff = (isHubOak(a) ? 0 : 1) - (isHubOak(b) ? 0 : 1);
            if (hubDiff !== 0) return hubDiff;
        }
        return a.distance - b.distance;
    })[0];
}

function findReachableTreeStandTile(
    s: Session,
    tree: NearbyLoc,
    size: number,
    safeWillow: boolean,
): { x: number; z: number } | undefined {
    const p = s.sdk.getState()?.player;
    const px = p?.worldX ?? DRAYNOR_JAIL_SPOT.x;
    const pz = p?.worldZ ?? DRAYNOR_JAIL_SPOT.z;
    const perimeter: { x: number; z: number }[] = [];
    for (let i = 0; i < size; i++) {
        perimeter.push(
            { x: tree.x + i, z: tree.z - 1 },
            { x: tree.x + i, z: tree.z + size },
            { x: tree.x - 1, z: tree.z + i },
            { x: tree.x + size, z: tree.z + i },
        );
    }
    const filtered = safeWillow
        ? perimeter
        : perimeter.filter(t => t.x >= 3113 && t.x <= 3119 && t.z >= 3237 && t.z <= 3253);
    const pool = filtered.length > 0 ? filtered : perimeter;
    const reachable: { x: number; z: number; wp: number; cheb: number; hub: number }[] = [];
    for (const t of pool) {
        const path = s.sdk.findPath(t.x, t.z);
        if (!path.success || path.reachedDestination !== true) continue;
        // Prefer (3117, 3242) with 3 open cardinal melee tiles (E/S/W) around player so all 3 Jail guards surround and hit cleanly.
        const hub = Math.max(Math.abs(t.x - 3117), Math.abs(t.z - 3242));
        reachable.push({
            x: t.x,
            z: t.z,
            wp: path.waypoints.length,
            cheb: Math.max(Math.abs(t.x - px), Math.abs(t.z - pz)),
            hub,
        });
    }
    reachable.sort((a, b) => (a.cheb - b.cheb) || (a.hub - b.hub) || (a.wp - b.wp));
    return reachable[0] ? { x: reachable[0].x, z: reachable[0].z } : undefined;
}

function targetsPlayer(s: Session, targetIndex: number): boolean {
    if (targetIndex < 32768) return false;
    const otherPlayers = new Set((s.sdk.getState()?.nearbyPlayers ?? []).map(p => p.index));
    return !otherPlayers.has(targetIndex - 32768);
}

function countAttackingGoblins(s: Session): number {
    const npcs = s.sdk.getState()?.nearbyNpcs ?? [];
    let count = 0;
    for (const n of npcs) {
        if (!/^(jail guard|goblin)$/i.test(n.name) || n.hp === 0) continue;
        if (targetsPlayer(s, n.targetIndex) || (n.inCombat && n.distance <= 2)) count++;
    }
    return count;
}

function findUntaggedGoblin(s: Session, taggedAt: ReadonlyMap<number, number>, now: number) {
    const npcs = s.sdk.getState()?.nearbyNpcs ?? [];
    const candidates = npcs.filter(n => {
        if (!/^(jail guard|goblin)$/i.test(n.name) || n.hp === 0 || n.distance > 9) return false;
        if (n.x < 3107 || n.x > 3123 || n.z < 3235 || n.z > 3251) return false;
        if ((n as { reachable?: boolean }).reachable === false) return false;
        if ((taggedAt.get(n.index) ?? -999) >= now - 50) return false;
        if (targetsPlayer(s, n.targetIndex)) return false;
        return n.targetIndex < 0;
    });
    // Prefer level 26 Jail guards (aggressive_melee, attackrate 5, 32 HP).
    candidates.sort((a, b) => (b.combatLevel - a.combatLevel) || (a.distance - b.distance));
    return candidates[0];
}

async function equipWcGear(s: Session, ids: readonly number[]): Promise<void> {
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
    if (curStyle !== 1) {
        acts.push(s.direct({ type: 'setCombatStyle', style: 1, reason: 'SDK' }));
    }
    if (st?.autoRetaliateEnabled === false) {
        acts.push(s.direct({ type: 'clickComponent', componentId: AUTO_RETALIATE_ON_COMP, reason: 'SDK' }));
    }
    if (acts.length > 0) await Promise.all(acts);
}

async function clearInteraction(s: Session): Promise<void> {
    const axeSlot = slotOfId(s, OBJ_RUNE_AXE);
    const airSlot = slotOfId(s, OBJ_AIR_RUNE);
    if (axeSlot !== undefined && airSlot !== undefined) {
        // Neither rune_axe nor airrune has an [opheldu] script; OpHeldUHandler calls clearPendingAction() cleanly.
        await s.direct({ type: 'useItemOnItem', sourceSlot: axeSlot, targetSlot: airSlot, reason: 'SDK' });
        return;
    }
    const p = s.sdk.getState()?.player;
    if (p) {
        await s.direct({ type: 'walkTo', x: p.worldX, z: p.worldZ, running: true, reason: 'SDK' });
    }
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
    for (let i = 0; i < 20 && !stop(); i++) {
        if ((s.sdk.getSkill('Prayer')?.baseLevel ?? 1) >= targetLevel) break;
        const slot = slotOfId(s, OBJ_DRAGON_BONES);
        if (slot === undefined) break;
        const item = s.sdk.getInventory().find(it => it.slot === slot);
        const op = item?.optionsWithIndex?.find(o => /^bury$/i.test(o.text))?.opIndex ?? 1;
        await s.direct({ type: 'useInventoryItem', slot, optionIndex: op, reason: 'SDK' });
        await waitTicks(s, 2);
    }
}

async function dropExcessOaks(s: Session, maxKeep = 22): Promise<boolean> {
    const inv = s.sdk.getInventory();
    if (inv.length < maxKeep) return false;
    const oakSlots = inv.filter(i => i.id === OBJ_OAK_LOGS).map(i => i.slot).slice(0, 4);
    if (oakSlots.length === 0) return false;
    await Promise.all(oakSlots.map(slot => s.direct({ type: 'dropItem', slot, reason: 'SDK' })));
    return true;
}

if (import.meta.main) {
    const account = process.argv[2];
    const helperName = process.argv.slice(3).find(a => !a.includes('=') && !a.startsWith('-')) ?? process.env.HELPER ?? `${account}b`;
    const cap = Number(process.env.CAP ?? 3400);
    const traceMode = process.env.WC_TRACE === '1';
    if (!account) throw Error('usage: bun scripts/woodcutting-specialist.ts <account> [helperAccount]');

    const { main, helper, stopped } = await openHelperAndMain(account, helperName);
    const t0 = main.tick();
    const isStopped = () => stopped() || existsSync(`.practice/stop-${account}`) || existsSync('.practice/stop-all') || main.tick() - t0 >= cap;
    let ok = false;
    let detail = '';
    let helperSettled = false;

    const arm = startHelperTradeArm(helper, main.name, isStopped);
    try {
        const tutTicks = await skipTutorialFast(main, isStopped);
        // Drop all non-essential starter items (keeping Shortbow) in <= 4 ticks so 24 supplies fit cleanly.
        for (let b = 0; b < 4 && !isStopped(); b++) {
            const junk = main.sdk.getInventory().filter(i => !WC_KEEP_IDS.has(i.id)).slice(0, 5);
            if (junk.length === 0) break;
            await Promise.all(junk.map(it => main.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' })));
            await waitTicks(main, 1);
        }
        const tradeTicks = await receiveTradeFast(
            main,
            helper,
            WOODCUTTING_SPECIALIST_SUPPLIES,
            isStopped,
            arm,
            { [OBJ_GLORY_4]: WOODCUTTING_GLORY_IDS },
        );
        const helperDone = settleHelper(helper).then(() => { helperSettled = true; }).catch(() => {});

        await buryPrayerBones(main, isStopped, 43);
        await equipWcGear(main, [
            OBJ_MONK_ROBE_TOP,
            OBJ_MONK_ROBE_BOTTOM,
            OBJ_SHORTBOW,
        ]);
        await rubTeleport(main, WOODCUTTING_GLORY_IDS, /draynor/i, inDraynorJail, isStopped);
        await equipWcGear(main, [OBJ_HOLY_SYMBOL]);
        await walkWaypointsSafe(main, [[3108, 3242, 2], [3117, 3242, 2]], isStopped);
        if ((main.sdk.getSkill('Prayer')?.baseLevel ?? 1) >= 43 && !isProtectMeleeOn(main.sdk.getState())) {
            // Single toggle chooses Protect from Melee while letting PrayerGuard 1t-flick with 0 Prayer drain.
            await main.direct({ type: 'togglePrayer', prayerIndex: PROTECT_FROM_MELEE_PRAYER, reason: 'SDK' });
            await waitTicks(main, 1);
        }
        const arriveTick = main.tick() - t0;

        let rolls = 0;
        let flinchRolls = 0;
        let knifeRolls = 0;
        let lastHitTick = -99;
        let lastTagTick = -99;
        let tagCount = 0;
        let noStaggerTicks = 0;
        let knifeStreakSinceFlinch = 0;
        let lastPhaseTick = -99;
        let phaseAttempts = 0;
        let actionDelayApprox = 0;
        let lastRollServerTick = -99;
        let clearSentForTick = -99;
        let activeTree: { x: number; z: number } | null = null;
        const taggedAt = new Map<number, number>();
        const seenHitKeys = new Set<string>();
        const recentHitTicks: number[] = [];
        let hitEventsTotal = 0;

        const drainHitEvents = (st: ReturnType<Session['sdk']['getState']>): number => {
            let maxHitTick = -1;
            const events = (st as {
                combatEvents?: Array<{ observationId?: number; tick?: number; type?: string; sourceType?: string; targetType?: string; sourceIndex?: number; damage?: number }>;
            } | undefined)?.combatEvents ?? [];
            for (const e of events) {
                if (e.type !== 'damage_taken' || e.sourceType !== 'npc') continue;
                if (e.targetType && e.targetType !== 'player') continue;
                const k = `${e.observationId ?? ''}:${e.tick ?? ''}:${e.sourceIndex ?? ''}:${e.damage ?? ''}`;
                if (seenHitKeys.has(k)) continue;
                seenHitKeys.add(k);
                hitEventsTotal++;
                if (typeof e.tick === 'number') {
                    if (!recentHitTicks.includes(e.tick)) {
                        recentHitTicks.push(e.tick);
                    }
                    if (e.tick > maxHitTick) maxHitTick = e.tick;
                }
            }
            return maxHitTick;
        };
        drainHitEvents(main.sdk.getState());

        while (!isStopped()) {
            const wcLvl = main.sdk.getSkill('Woodcutting')?.baseLevel ?? 1;
            const wcXp = main.sdk.getSkillXp('Woodcutting') ?? 0;
            if (wcLvl >= 99 || wcXp >= xpForLevel(99)) {
                ok = true;
                break;
            }

            if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
                await main.direct({ type: 'closeModal', reason: 'SDK' });
            }

            const now = main.tick();
            const st = main.sdk.getState();
            const hitTick = drainHitEvents(st);
            if (hitTick >= 0) lastHitTick = Math.max(lastHitTick, hitTick);

            const wantOak = wcLvl >= 15;
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

            // playerhit_n_retaliate only sets %action_delay = map_clock + 1 when busy2 = false and %action_delay < map_clock.
            const validFlinchHit = !outOfPrayer && hitTick === now && clearSentForTick === now && now + 1 >= actionDelayApprox;
            const gobs = !outOfPrayer && wantOak ? countAttackingGoblins(main) : 0;
            const needNormalLog = wantOak && slotOfId(main, OBJ_LOGS) === undefined;
            const safeWillow = outOfPrayer && wcLvl >= 30;
            const tree: NearbyLoc | undefined = (needNormalLog ? findBestTree(main, false, null) : undefined)
                ?? findBestTree(main, wantOak, activeTree, safeWillow);
            activeTree = tree ? { x: tree.x, z: tree.z } : null;

            if (!tree) {
                if (safeWillow) {
                    await walkWaypointsSafe(main, [[3086, 3233, 2]], isStopped);
                    continue;
                }
                const acts: Promise<unknown>[] = [];
                const potAct = outOfPrayer ? null : tryDrinkPrayerPotion(main, 15);
                if (potAct) acts.push(potAct);
                if (now >= actionDelayApprox) {
                    acts.push(clearInteraction(main));
                    clearSentForTick = now + 1;
                }
                if (acts.length > 0) await Promise.all(acts);
                await waitTicks(main, 1);
                continue;
            }
            const chopOp = tree.optionsWithIndex.find(o => /chop/i.test(o.text))?.opIndex ?? 1;
            const treeSize = treeSizeForLoc(tree.name);
            const meNow = st?.player;
            const besideTree = !!meNow && isBesideTree(meNow.worldX, meNow.worldZ, tree.x, tree.z, treeSize);

            if (!besideTree) {
                const standTile = findReachableTreeStandTile(main, tree, treeSize, safeWillow);
                const destX = standTile?.x ?? tree.x;
                const destZ = standTile?.z ?? tree.z;
                const acts: Promise<unknown>[] = [
                    main.direct({ type: 'walkTo', x: destX, z: destZ, running: true, reason: 'SDK' }),
                ];
                const potAct = outOfPrayer ? null : tryDrinkPrayerPotion(main, 15);
                if (potAct) acts.push(potAct);
                await Promise.all(acts);
                clearSentForTick = -99;
                await waitTicks(main, 1);
                continue;
            }

            if (validFlinchHit && !needNormalLog) {
                // playerhit_n_retaliate set %action_delay = now + 1; interactLoc runs in processClientsIn of now + 1 and rolls immediately!
                const acts: Promise<unknown>[] = [];
                if (main.sdk.getInventory().length >= 25) {
                    const oakSlot = slotOfId(main, OBJ_OAK_LOGS);
                    if (oakSlot !== undefined) acts.push(main.direct({ type: 'dropItem', slot: oakSlot, reason: 'SDK' }));
                }
                const potAct = outOfPrayer ? null : tryDrinkPrayerPotion(main, 15);
                if (potAct) acts.push(potAct);
                acts.push(main.direct({ type: 'interactLoc', x: tree.x, z: tree.z, locId: tree.id, optionIndex: chopOp, reason: 'SDK' }));
                await Promise.all(acts);
                flinchRolls++;
                knifeStreakSinceFlinch = 0;
                rolls++;
                lastRollServerTick = now + 1;
                actionDelayApprox = now + 1;
                clearSentForTick = -99;
                if (traceMode && rolls <= 35) {
                    console.log(`WC_TRACE flinch roll=${rolls} t=${now + 1 - t0} xp=${wcXp} gobs=${gobs} pray=${prayPts}`);
                }
                await waitTicks(main, 1);
                continue;
            }

            if (now < actionDelayApprox) {
                // Pending 3-tick knife roll: never send clearInteraction until now >= actionDelayApprox.
                const potAct = outOfPrayer ? null : tryDrinkPrayerPotion(main, 15);
                if (potAct) await potAct;
                await waitTicks(main, 1);
                continue;
            }

            // Count non-adjacent staggered hits in strict 10-tick span [now-9..now] (2 cycles of attackrate=5 -> 1 or in-phase = <=2, staggered >=2 = 3..5).
            while (recentHitTicks.length > 0 && recentHitTicks[0]! <= now - 10) recentHitTicks.shift();
            let spacedHits10 = 0;
            let prevSpaced = -99;
            for (const ht of recentHitTicks) {
                if (ht - prevSpaced >= 2) {
                    spacedHits10++;
                    prevSpaced = ht;
                }
            }
            const staggeredHits10 = recentHitTicks.length;
            if (wantOak && !needNormalLog && gobs >= 2 && spacedHits10 < 3) {
                noStaggerTicks++;
            } else {
                noStaggerTicks = 0;
            }
            // Perturb coincided or adjacent guard timers 1 tile along the south edge of Oak (3115, 3243) so hits separate by >=2t.
            const needPhaseShift = noStaggerTicks >= 15 || knifeStreakSinceFlinch >= 3;
            if (!outOfPrayer && wantOak && !needNormalLog && gobs >= 2 && meNow.worldZ === 3242 && (meNow.worldX === 3116 || meNow.worldX === 3117) && needPhaseShift && phaseAttempts < 6 && now - lastPhaseTick >= 35) {
                noStaggerTicks = 0;
                knifeStreakSinceFlinch = 0;
                lastPhaseTick = now;
                phaseAttempts++;
                const stepX = meNow.worldX === 3116 ? 3117 : 3116;
                await main.direct({ type: 'walkTo', x: stepX, z: 3242, running: true, reason: 'SDK' });
                clearSentForTick = -99;
                await waitTicks(main, 1);
                continue;
            }
            const canTag = !outOfPrayer
                && wantOak
                && !needNormalLog
                && tagCount < 16
                && gobs < 3
                && spacedHits10 < 4
                && now - lastTagTick >= 15
                && now >= actionDelayApprox
                && itemQty(main, OBJ_AIR_RUNE) > 1
                && itemQty(main, OBJ_MIND_RUNE) > 0;
            if (canTag) {
                const target = findUntaggedGoblin(main, taggedAt, now);
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

            // Hold busy2 clear for <=2t only when >=2 spaced attackers hit cleanly (>=3 spaced hit ticks/10t); else pure 3t knife.
            const flinchViable = gobs >= 2 || spacedHits10 >= 3;
            const keepFlinchWindow = !outOfPrayer && wantOak && !needNormalLog && flinchViable && spacedHits10 >= 3 && now - lastRollServerTick < 2;
            if (!keepFlinchWindow) {
                const knifeSlot = slotOfId(main, OBJ_KNIFE);
                const logSlot = slotOfId(main, OBJ_LOGS);
                if (knifeSlot !== undefined && logSlot !== undefined && !needNormalLog) {
                    // Single-tick wc-3tick burst (drop -> knife -> Make 1 -> Chop in strict order): rolls at now + 3 without consuming OBJ_LOGS.
                    if (main.sdk.getInventory().length >= 25) {
                        const dropSlots = main.sdk.getInventory().filter(i => i.id === OBJ_OAK_LOGS || i.id === 1519).map(i => i.slot).slice(0, 1);
                        for (const slot of dropSlots) await main.direct({ type: 'dropItem', slot, reason: 'SDK' });
                    }
                    await main.direct({ type: 'useItemOnItem', sourceSlot: knifeSlot, targetSlot: logSlot, reason: 'SDK' });
                    await main.direct({ type: 'clickComponent', componentId: SKILL_MULTI3_MAKE1_A, reason: 'SDK' });
                    await main.direct({ type: 'interactLoc', x: tree.x, z: tree.z, locId: tree.id, optionIndex: chopOp, reason: 'SDK' });
                    knifeRolls++;
                    if (wantOak && spacedHits10 >= 3) knifeStreakSinceFlinch++;
                    rolls++;
                    lastRollServerTick = now + 3;
                    actionDelayApprox = now + 3;
                    clearSentForTick = -99;
                    if (traceMode && rolls <= 35) {
                        console.log(`WC_TRACE knife3 roll=${rolls} t=${now + 3 - t0} xp=${wcXp} gobs=${gobs} pray=${prayPts}`);
                    }
                    await waitTicks(main, 1);
                    continue;
                }
                // Plain chop (1-log normal tree replenishment or missing knife) without cancelling pending woodcut action.
                if (main.sdk.getInventory().length >= 27) {
                    const oakSlot = slotOfId(main, OBJ_OAK_LOGS);
                    if (oakSlot !== undefined) await main.direct({ type: 'dropItem', slot: oakSlot, reason: 'SDK' });
                }
                await main.direct({ type: 'interactLoc', x: tree.x, z: tree.z, locId: tree.id, optionIndex: chopOp, reason: 'SDK' });
                rolls++;
                lastRollServerTick = now + 3;
                actionDelayApprox = now + 3;
                clearSentForTick = -99;
                await waitTicks(main, 1);
                continue;
            }

            const idleActs: Promise<unknown>[] = [];
            if (main.sdk.getInventory().length >= 24) {
                const oakSlots = main.sdk.getInventory().filter(i => i.id === OBJ_OAK_LOGS).map(i => i.slot).slice(0, 3);
                for (const slot of oakSlots) idleActs.push(main.direct({ type: 'dropItem', slot, reason: 'SDK' }));
            }
            const potAct = tryDrinkPrayerPotion(main, 15);
            if (potAct) idleActs.push(potAct);
            idleActs.push(clearInteraction(main));
            await Promise.all(idleActs);
            clearSentForTick = now + 1;
            await waitTicks(main, 1);
        }

        if ((main.sdk.getSkill('Woodcutting')?.baseLevel ?? 1) >= 99) ok = true;
        if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
            await main.direct({ type: 'closeModal', reason: 'SDK' });
        }
        if (!helperSettled) await Promise.race([helperDone, waitTicks(main, 4)]);
        const totalTicks = main.tick() - t0;
        const finalLvl = main.sdk.getSkill('Woodcutting')?.baseLevel ?? 0;
        const finalXp = main.sdk.getSkillXp('Woodcutting') ?? 0;
        ok = ok && finalLvl >= 99;
        detail = `level=${finalLvl} xp=${finalXp} ticks=${totalTicks} tut=${tutTicks} trade=${tradeTicks} arrive=${arriveTick} rolls=${rolls} flinch=${flinchRolls} knife=${knifeRolls} hits=${hitEventsTotal} hp=${main.sdk.getState()?.player?.hp ?? '?'}`;
    } catch (error) {
        detail = String(error);
    } finally {
        arm.close();
    }

    await finish(helper ? [main, helper] : [main], ok, detail);
}
