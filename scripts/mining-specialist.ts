import { existsSync } from 'node:fs';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { xpForLevel } from '../packages/planner/src/curve';
import { finish } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import type { NearbyLoc } from '../vendor/rs-sdk/sdk/types';
import {
    openHelperAndMain,
    skipTutorialFast,
    dropTutorialJunk,
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

export const OBJ_RUNE_PICKAXE = 1275;
export const OBJ_SHORTBOW = 841;
export const OBJ_DRAGON_BONES = 536;
export const OBJ_CLAY = 434;
export const OBJ_COPPER_ORE = 436;
export const OBJ_IRON_ORE = 440;
export const IRON_ORE_XP_25X = 875;

const PROTECT_FROM_MELEE_PRAYER = 14;
const AUTO_RETALIATE_ON_COMP = 150;
const AUTO_RETALIATE_OFF_COMP = 151;

export const MINING_GLORY_IDS = [OBJ_GLORY_4, 1710, 1708, 1706] as const;

const EDGEVILLE_TO_HOBGOBLIN_WAYPOINTS: readonly [number, number, number][] = [
    [3087, 3521, 3],
    [3079, 3559, 4],
    [3079, 3628, 4],
    [3085, 3662, 4],
    [3087, 3697, 4],
    [3083, 3729, 4],
    [3100, 3767, 1],
];

const HOBGOBLIN_IRON_ROCKS: readonly { x: number; z: number }[] = [
    { x: 3099, z: 3765 },
    { x: 3099, z: 3766 },
    { x: 3099, z: 3767 },
    { x: 3099, z: 3768 },
    { x: 3100, z: 3765 },
    { x: 3100, z: 3766 },
    { x: 3101, z: 3765 },
    { x: 3101, z: 3768 },
];

const HOBGOBLIN_ROCK_SET = new Set(HOBGOBLIN_IRON_ROCKS.map(r => `${r.x},${r.z}`));

// 28 supply slots (no Super energy(4) — NODE_INFINITE_RUN=true): Doric's Quest (Mining 1->49) + Prayer 43 + Hobgoblin 8-rock hybrid 2.67t flinch/knife.
export const MINING_SPECIALIST_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_RUNE_PICKAXE]: 1,
    [OBJ_KNIFE]: 1,
    [OBJ_LOGS]: 1,
    [OBJ_SHORTBOW]: 1,
    [OBJ_CLAY]: 6,
    [OBJ_COPPER_ORE]: 4,
    [OBJ_IRON_ORE]: 2,
    [OBJ_GLORY_4]: 1,
    [OBJ_DRAGON_BONES]: 11,
};

export const MINING_SPECIALIST_LIVE_SUPPLIES: Readonly<Record<number, number>> = MINING_SPECIALIST_SUPPLIES;

function isProtectMeleeOn(st: ReturnType<Session['sdk']['getState']>): boolean {
    return Boolean((st as { prayers?: { activePrayers?: boolean[] } } | undefined)?.prayers?.activePrayers?.[PROTECT_FROM_MELEE_PRAYER]);
}

function isOrthogonalAdjacent(px: number, pz: number, rx: number, rz: number): boolean {
    return Math.abs(px - rx) + Math.abs(pz - rz) === 1;
}

function findLiveHobgoblinRocks(s: Session): Map<string, NearbyLoc> {
    const out = new Map<string, NearbyLoc>();
    const locs = s.sdk.getState()?.nearbyLocs ?? [];
    for (const l of locs) {
        if (l.level !== 0) continue;
        const k = `${l.x},${l.z}`;
        if (!HOBGOBLIN_ROCK_SET.has(k) || out.has(k)) continue;
        if (l.optionsWithIndex?.some(o => o.opIndex === 1 && /^mine$/i.test(o.text))) {
            out.set(k, l);
        }
    }
    return out;
}

function pickHobgoblinRock(
    px: number,
    pz: number,
    live: ReadonlyMap<string, NearbyLoc>,
    requireAdjacent: boolean,
): NearbyLoc | undefined {
    let best: { loc: NearbyLoc; score: number } | undefined;
    for (const r of HOBGOBLIN_IRON_ROCKS) {
        const loc = live.get(`${r.x},${r.z}`);
        if (!loc || loc.reachable === false) continue;
        const adj = isOrthogonalAdjacent(px, pz, r.x, r.z);
        if (requireAdjacent && !adj) continue;
        // Pick an adjacent tile for this rock that touches the most other live rocks so the next flinch needs 0 walk.
        let bestTileDist = adj ? 0 : 99;
        let maxTouchOther = 0;
        if (adj) {
            for (const o of HOBGOBLIN_IRON_ROCKS) {
                if ((o.x !== r.x || o.z !== r.z) && live.has(`${o.x},${o.z}`) && isOrthogonalAdjacent(px, pz, o.x, o.z)) {
                    maxTouchOther++;
                }
            }
        } else {
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
                const tx = r.x + dx;
                const tz = r.z + dz;
                if (HOBGOBLIN_ROCK_SET.has(`${tx},${tz}`)) continue;
                const d = Math.max(Math.abs(tx - px), Math.abs(tz - pz));
                let touch = 0;
                for (const o of HOBGOBLIN_IRON_ROCKS) {
                    if ((o.x !== r.x || o.z !== r.z) && live.has(`${o.x},${o.z}`) && isOrthogonalAdjacent(tx, tz, o.x, o.z)) {
                        touch++;
                    }
                }
                if (d < bestTileDist || (d === bestTileDist && touch > maxTouchOther)) {
                    bestTileDist = d;
                    maxTouchOther = touch;
                }
            }
        }
        const walkTicks = Math.ceil(bestTileDist / 2);
        const score = walkTicks * 100 - maxTouchOther * 10 + loc.distance;
        if (!best || score < best.score) best = { loc, score };
    }
    return best?.loc;
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
    if (lvl < targetLevel) {
        throw new Error(`buryPrayerBones: reached Prayer ${lvl} < ${targetLevel}`);
    }
}

async function clearPendingMiningAction(s: Session): Promise<void> {
    const pickSlot = slotOfId(s, OBJ_RUNE_PICKAXE);
    const glorySlot = MINING_GLORY_IDS.map(id => slotOfId(s, id)).find((v): v is number => v !== undefined);
    if (pickSlot !== undefined && glorySlot !== undefined) {
        await s.direct({ type: 'useItemOnItem', sourceSlot: pickSlot, targetSlot: glorySlot, reason: 'SDK' });
        return;
    }
    const p = s.sdk.getState()?.player;
    if (p) {
        await s.direct({ type: 'walkTo', x: p.worldX, z: p.worldZ, running: true, reason: 'SDK' });
    }
}

export function remainingIronOresTo99(currentXp: number): number {
    return Math.max(0, Math.ceil((xpForLevel(99) - currentXp) / IRON_ORE_XP_25X));
}

async function completeDoricQuest(main: Awaited<ReturnType<typeof openHelperAndMain>>['main'], stop: () => boolean): Promise<void> {
    const converse = async (pats: readonly RegExp[], done: () => boolean, maxTicks = 25): Promise<void> => {
        for (let i = 0; i < maxTicks && !stop(); i++) {
            if (done()) return;
            const d = main.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opt = d.options.find(o => pats.some(re => re.test(o.text)));
                await main.direct({ type: 'clickDialogOption', optionIndex: opt ? opt.index : 0, reason: 'SDK' });
            }
            await waitTicks(main, 1);
        }
    };

    const talkDoric = async () => {
        for (let t = 0; t < 4 && !stop(); t++) {
            const npc = main.sdk.findNearbyNpc(/^doric$/i);
            if (npc && chebDist({ x: npc.x, z: npc.z }, { x: main.sdk.getState()!.player!.worldX, z: main.sdk.getState()!.player!.worldZ }) <= 5) {
                const r = await main.bot.talkTo(/^doric$/i);
                if (r.success || main.sdk.getDialog()?.isOpen) return;
            }
            await main.bot.walkTo(2952, 3451, 1);
            await waitTicks(main, 1);
        }
        throw Error('could not talk to Doric');
    };

    await talkDoric();
    let part1Open = false;
    await converse(
        [/wanted to use your anvils/i, /yes, i will get you materials/i],
        () => {
            const open = !!main.sdk.getDialog()?.isOpen;
            if (open) part1Open = true;
            return part1Open && !open;
        },
        25,
    );

    await talkDoric();
    await converse(
        [/have my materials/i, /yes/i],
        () => (main.sdk.getSkill('Mining')?.baseLevel ?? 1) >= 49,
        35,
    );
    if ((main.sdk.getSkill('Mining')?.baseLevel ?? 1) < 49) {
        throw Error(`Doric's Quest did not grant Mining 49 (level=${main.sdk.getSkill('Mining')?.baseLevel})`);
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

    const supplies = MINING_SPECIALIST_SUPPLIES;
    let readyForTrade = false;
    const arm = startHelperTradeArm(helper, main.name, isStopped, () => readyForTrade);
    try {
        const tutTicks = await skipTutorialFast(main, isStopped);
        await dropTutorialJunk(main, isStopped, 18);
        readyForTrade = true;
        const tradeTicks = await receiveTradeFast(main, helper, supplies, isStopped, arm, { [OBJ_GLORY_4]: MINING_GLORY_IDS });
        helperDone = settleHelper(helper).catch(err => {
            console.log(`WARN helper settle: ${String(err)}`);
        });

        await buryPrayerBones(main, isStopped, 43);

        await rubTeleport(
            main,
            MINING_GLORY_IDS,
            1,
            p => p.worldX >= 3070 && p.worldX <= 3110 && p.worldZ >= 3480 && p.worldZ <= 3515,
            isStopped,
        );
        await walkWaypointsSafe(main, [[3020, 3425, 4], [2952, 3451, 2]], isStopped);

        await completeDoricQuest(main, isStopped);
        const doricTicks = main.tick() - t0;

        await rubTeleport(
            main,
            MINING_GLORY_IDS,
            1,
            p => p.worldX >= 3070 && p.worldX <= 3110 && p.worldZ >= 3480 && p.worldZ <= 3515,
            isStopped,
        );

        // Yield PrayerGuard via double-toggle once Prayer 43 is unlocked, keeping Protect from Melee ON via manual flicks.
        let lastFlickTick = -99;
        if ((main.sdk.getSkill('Prayer')?.baseLevel ?? 1) >= 43) {
            const wasOn = isProtectMeleeOn(main.sdk.getState());
            await Promise.all([
                main.direct({ type: 'togglePrayer', prayerIndex: PROTECT_FROM_MELEE_PRAYER, reason: 'SDK' }),
                main.direct({ type: 'togglePrayer', prayerIndex: PROTECT_FROM_MELEE_PRAYER, reason: 'SDK' }),
                ...(!wasOn ? [main.direct({ type: 'togglePrayer', prayerIndex: PROTECT_FROM_MELEE_PRAYER, reason: 'SDK' })] : []),
            ]);
            lastFlickTick = main.tick();
        }
        const prayerFlickActs = (stNow: ReturnType<Session['sdk']['getState']>, nowTick: number, minGap = 2): Promise<unknown>[] => {
            if ((main.sdk.getSkill('Prayer')?.level ?? 0) < 1 || (main.sdk.getSkill('Prayer')?.baseLevel ?? 1) < 43) return [];
            if (!isProtectMeleeOn(stNow)) {
                lastFlickTick = nowTick;
                return [main.direct({ type: 'togglePrayer', prayerIndex: PROTECT_FROM_MELEE_PRAYER, reason: 'SDK' })];
            }
            if (nowTick - lastFlickTick >= minGap) {
                lastFlickTick = nowTick;
                return [
                    main.direct({ type: 'togglePrayer', prayerIndex: PROTECT_FROM_MELEE_PRAYER, reason: 'SDK' }),
                    main.direct({ type: 'togglePrayer', prayerIndex: PROTECT_FROM_MELEE_PRAYER, reason: 'SDK' }),
                ];
            }
            return [];
        };

        // Keep Shortbow unequipped on the walk north so we can punch-tag one Hobgoblin immediately upon arrival.
        for (const [wx, wz, tol] of EDGEVILLE_TO_HOBGOBLIN_WAYPOINTS) {
            while (!isStopped()) {
                const stW = main.sdk.getState();
                const pw = stW?.player;
                if (pw && chebDist({ x: pw.worldX, z: pw.worldZ }, { x: wx, z: wz }) <= tol) break;
                const acts: Promise<unknown>[] = [...prayerFlickActs(stW, main.tick(), 3)];
                acts.push(main.direct({ type: 'walkTo', x: wx, z: wz, running: true, reason: 'SDK' }));
                await Promise.all(acts);
                await waitTicks(main, 1);
            }
        }

        const mineStart = main.tick() - t0;
        const targetXp = xpForLevel(99);
        const seenHitKeys = new Set<string>();
        const npcLastHit = new Map<number, { tick: number; period: number }>();
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
                    if (typeof e.sourceIndex === 'number') {
                        const prev = npcLastHit.get(e.sourceIndex);
                        let period = prev?.period ?? 4;
                        if (prev) {
                            const diff = e.tick - prev.tick;
                            if (diff >= 4 && diff <= 5) period = diff;
                        }
                        npcLastHit.set(e.sourceIndex, { tick: e.tick, period });
                    }
                    if (e.tick > maxHitTick) maxHitTick = e.tick;
                }
            }
            return maxHitTick;
        };

        // Tag one Hobgoblin bare-handed on arrival so it chases/hits every 4t, then equip Shortbow on Rapid (1t flinch delay).
        let tagged = false;
        for (let t = 0; t < 18 && !isStopped() && !tagged; t++) {
            const st = main.sdk.getState();
            const ht = drainHitEvents(st);
            const hobs = (st?.nearbyNpcs ?? [])
                .filter(n => /^hobgoblin$/i.test(n.name) && (n.hp ?? 1) > 0 && n.reachable !== false)
                .sort((a, b) => a.distance - b.distance);
            const alreadyTargeting = hobs.some(n => n.targetIndex >= 32768);
            if (alreadyTargeting || ht >= 0) {
                tagged = true;
                break;
            }
            const target = hobs[0];
            const acts: Promise<unknown>[] = [...prayerFlickActs(st, main.tick(), 3)];
            if (target) {
                const op = target.optionsWithIndex?.find(o => /^attack$/i.test(o.text))?.opIndex ?? 2;
                acts.push(main.direct({ type: 'interactNpc', npcIndex: target.index, optionIndex: op, reason: 'SDK' }));
            }
            await Promise.all(acts);
            await waitTicks(main, 1);
        }

        const bowItem = main.sdk.getInventory().find(i => i.id === OBJ_SHORTBOW);
        if (bowItem) {
            const op = bowItem.optionsWithIndex?.find(o => /^(wield|wear|equip)$/i.test(o.text))?.opIndex ?? 2;
            await main.direct({ type: 'useInventoryItem', slot: bowItem.slot, optionIndex: op, reason: 'SDK' });
            await waitTicks(main, 1);
        }
        {
            const st = main.sdk.getState();
            const acts: Promise<unknown>[] = [...prayerFlickActs(st, main.tick(), 3)];
            const curStyle = typeof st?.combatStyle === 'object' && st.combatStyle !== null ? st.combatStyle.currentStyle : 0;
            if (curStyle !== 1) acts.push(main.direct({ type: 'setCombatStyle', style: 1, reason: 'SDK' }));
            if (st?.autoRetaliateEnabled === false) acts.push(main.direct({ type: 'clickComponent', componentId: AUTO_RETALIATE_ON_COMP, reason: 'SDK' }));
            if (acts.length > 0) {
                await Promise.all(acts);
                await waitTicks(main, 1);
            }
        }

        let actionDelayApprox = 0;
        let clearSentForTick = -99;
        let ores = 0;
        let flinchRolls = 0;
        let knifeRolls = 0;
        let lastXp = main.sdk.getSkillXp('Mining') ?? 0;
        let traceCount = 0;

        while (!isStopped()) {
            const lvl = main.sdk.getSkill('Mining')?.baseLevel ?? 1;
            const xp = main.sdk.getSkillXp('Mining') ?? 0;
            const xpDelta = xp - lastXp;
            if (xpDelta > 0) {
                ores += Math.max(1, Math.round(xpDelta / IRON_ORE_XP_25X));
                lastXp = xp;
            }
            if (lvl >= 99 || xp >= targetXp) break;

            const now = main.tick();
            const st = main.sdk.getState();
            const hitTick = drainHitEvents(st);
            const me = st?.player;
            const px = me?.worldX ?? 3100;
            const pz = me?.worldZ ?? 3767;
            const modalOpen = Boolean(st?.dialog?.isOpen || st?.modalOpen);
            const liveRocks = findLiveHobgoblinRocks(main);
            if (traceCount < 28) {
                traceCount++;
                console.log(`MINING_TRACE t=${now - t0} srv=${now} pos=${px},${pz} xp=${xp}(+${xpDelta}) hit=${hitTick === now ? 1 : 0} clr=${clearSentForTick === now ? 1 : 0} dly=${actionDelayApprox - now} autoRet=${st?.autoRetaliateEnabled} pray=${main.sdk.getSkill('Prayer')?.level} inv=${main.sdk.getInventory().length}`);
            }

            const validFlinchHit = hitTick === now && clearSentForTick === now && now >= actionDelayApprox;
            if (validFlinchHit) {
                const rock = pickHobgoblinRock(px, pz, liveRocks, true);
                if (rock) {
                    // Turn auto_retaliate OFF here (<= 5 USER_EVENT packets/tick) so subsequent knife ticks stay <= 5 events.
                    const flicks = prayerFlickActs(st, now, 3);
                    const offActs = st?.autoRetaliateEnabled !== false
                        ? [main.direct({ type: 'clickComponent', componentId: AUTO_RETALIATE_OFF_COMP, reason: 'SDK' })]
                        : [];
                    const acts: Promise<unknown>[] = [
                        ...flicks,
                        ...offActs,
                        ...(modalOpen && offActs.length === 0 && flicks.length === 0 ? [main.direct({ type: 'closeModal', reason: 'SDK' })] : []),
                        main.direct({ type: 'interactLoc', x: rock.x, z: rock.z, locId: rock.id, optionIndex: 1, reason: 'SDK' }),
                    ];
                    await Promise.all(acts);
                    flinchRolls++;
                    actionDelayApprox = now + 1;
                    clearSentForTick = -99;
                    await waitTicks(main, 1);
                    continue;
                }
            }

            if (now < actionDelayApprox) {
                await waitTicks(main, 1);
                continue;
            }

            const nearbyNpcs = st?.nearbyNpcs ?? [];
            let nextHitEta = Infinity;
            for (const [npcIdx, info] of npcLastHit) {
                if (now - info.tick > 10) {
                    npcLastHit.delete(npcIdx);
                    continue;
                }
                const npc = nearbyNpcs.find(n => n.index === npcIdx);
                if (!npc || npc.hp === 0 || npc.distance > 4 || npc.targetIndex < 32768) continue;
                for (let k = 1; k <= 2; k++) {
                    const rawEta = info.tick + k * info.period - now;
                    const eta = rawEta === 0 && npc.distance <= 2 ? 1 : rawEta;
                    if (eta >= 1 && eta < nextHitEta) {
                        nextHitEta = eta;
                        break;
                    }
                }
            }

            const inv = main.sdk.getInventory();
            const oreSlots = inv.filter(i => i.id === OBJ_IRON_ORE || (i.id >= 1617 && i.id <= 1623)).map(i => i.slot);

            if (nextHitEta === 1) {
                const acts: Promise<unknown>[] = [...prayerFlickActs(st, now, 3)];
                const toggled = st?.autoRetaliateEnabled === false;
                if (toggled) {
                    acts.push(main.direct({ type: 'clickComponent', componentId: AUTO_RETALIATE_ON_COMP, reason: 'SDK' }));
                } else if (modalOpen && acts.length === 0) {
                    acts.push(main.direct({ type: 'closeModal', reason: 'SDK' }));
                }
                const adjRock = pickHobgoblinRock(px, pz, liveRocks, true);
                if (!adjRock) {
                    const nearRock = pickHobgoblinRock(px, pz, liveRocks, false);
                    if (nearRock) {
                        const dest = [[1, 0], [-1, 0], [0, 1], [0, -1]]
                            .map(([dx, dz]) => ({ x: nearRock.x + dx!, z: nearRock.z + dz! }))
                            .filter(t => !HOBGOBLIN_ROCK_SET.has(`${t.x},${t.z}`))
                            .sort((a, b) => chebDist(a, { x: px, z: pz }) - chebDist(b, { x: px, z: pz }))[0];
                        if (dest) acts.push(main.direct({ type: 'walkTo', x: dest.x, z: dest.z, running: true, reason: 'SDK' }));
                    }
                } else if (oreSlots.length > 0) {
                    const maxDrop = Math.max(1, 5 - acts.length);
                    for (const slot of oreSlots.slice(0, maxDrop)) {
                        acts.push(main.direct({ type: 'dropItem', slot, reason: 'SDK' }));
                    }
                } else if (acts.length === 0) {
                    await clearPendingMiningAction(main);
                }
                if (acts.length > 0) await Promise.all(acts);
                clearSentForTick = now + 1;
                await waitTicks(main, 1);
                continue;
            }

            if (inv.length >= 27 && oreSlots.length > 0) {
                const acts: Promise<unknown>[] = [
                    ...prayerFlickActs(st, now, 3),
                    ...oreSlots.slice(0, 4).map(slot => main.direct({ type: 'dropItem', slot, reason: 'SDK' })),
                ];
                await Promise.all(acts);
                clearSentForTick = -99;
                await waitTicks(main, 1);
                continue;
            }

            const rock = pickHobgoblinRock(px, pz, liveRocks, false);
            const knifeSlot = slotOfId(main, OBJ_KNIFE);
            const logSlot = slotOfId(main, OBJ_LOGS);
            if (!rock || knifeSlot === undefined || logSlot === undefined) {
                if (modalOpen) await main.direct({ type: 'closeModal', reason: 'SDK' });
                await waitTicks(main, 1);
                continue;
            }

            // Keep knife ticks strictly 3 pure actions (useItemOnItem + clickComponent + interactLoc) with NO togglePrayer/if_close.
            const acts: Promise<unknown>[] = [
                ...(modalOpen ? [main.direct({ type: 'closeModal', reason: 'SDK' })] : []),
                main.direct({ type: 'useItemOnItem', sourceSlot: knifeSlot, targetSlot: logSlot, reason: 'SDK' }),
                main.direct({ type: 'clickComponent', componentId: SKILL_MULTI3_MAKE1_A, reason: 'SDK' }),
                main.direct({ type: 'interactLoc', x: rock.x, z: rock.z, locId: rock.id, optionIndex: 1, reason: 'SDK' }),
            ];
            await Promise.all(acts);
            knifeRolls++;
            actionDelayApprox = now + 3;
            clearSentForTick = -99;
            await waitTicks(main, 1);
        }

        if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
            await main.direct({ type: 'closeModal', reason: 'SDK' });
        }
        const totalTicks = main.tick() - t0;
        const lvl = main.sdk.getSkill('Mining')?.baseLevel ?? 0;
        const xp = main.sdk.getSkillXp('Mining') ?? 0;
        ok = lvl >= 99;
        detail = `level=${lvl} xp=${xp} ticks=${totalTicks} tut=${tutTicks} trade=${tradeTicks} doric=${doricTicks} mineStart=${mineStart} ores=${ores} flinch=${flinchRolls} knife=${knifeRolls} hits=${hitEventsTotal}`;
    } catch (error) {
        detail = String(error);
    } finally {
        arm.close();
    }

    await helperDone;
    await finish([main], ok, detail);
}
