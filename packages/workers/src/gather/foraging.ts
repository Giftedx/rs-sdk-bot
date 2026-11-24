// Consolidated foraging module: flax, wool, feathers, ground spawns, Cooks' Guild grapes, and Taverley crystal chests.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accountOf, countItems, finish, getWorld, openBot, randomEventsOf, sessionDied } from '../../../core/src/bot';
import { bankCargo, courierWaiting } from '../../../core/src/cargo';
import { depositObserved } from '../../../core/src/deposit';
import { gatherItems } from '../../../core/src/gather';
import type { Session } from '../../../core/src/inprocess';
import { wildernessLevel } from '../../../core/src/prayer-guard';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import type { Tile } from '../../../core/src/world';
import {
    awayFrom as defaultAwayFrom,
    defaultApproach,
    defaultNearestBanks,
    defaultWalkTargetPersist,
} from './runtime';
import type { GatherExternalDeps, GatherOutcome, NormalizedGatherConfig } from './types';
import { FALADOR_WEST_BANK } from '../logistics/recover';

const ROOT = resolve(import.meta.dir, '../../../..');

// ---------------------------------------------------------------------------
// 1. Seers' Village Flax (`foraging:flax`)
// ---------------------------------------------------------------------------
const FLAX_FIELD = { x: 2744, z: 3445 };
const SEERS_BANK = { x: 2727, z: 3492 };
const FLAX_APPROACH_FROM = 80;

export interface FlaxOptions {
    cap: number;
    bankAt: number;
    stop?: () => boolean;
    approach?: (stop: () => boolean) => Promise<boolean>;
    walk?: (x: number, z: number, tol: number, stop: () => boolean, remaining: number) => Promise<boolean>;
    cargo?: (s: Session, stopped: () => boolean) => Promise<void>;
    waiting?: () => boolean;
    deps?: GatherExternalDeps;
}

export async function runFlax(s: Session, o: FlaxOptions) {
    if (!Number.isInteger(o.cap) || o.cap < 1 || !Number.isInteger(o.bankAt) || o.bankAt < 1 || o.bankAt > 28) {
        throw new Error('invalid flax CAP/BANK_AT');
    }
    const CAP = o.cap;
    const BANK_AT = o.bankAt;
    const pos = () => s.sdk.getState()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const flaxCount = () => countItems(s, /^flax$/i);
    const freeSpace = () => 28 - s.sdk.getInventory().length;
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    let ended = false;
    let died = false;
    const life = pos()?.lifeId;
    const respawns = pos()?.respawnCount ?? 0;
    void s.ended.then(() => { ended = true; });
    let stopped = false;
    let cleanupDeadline: number | undefined;
    const terminal = () => ended || died || (stopped ||= !!o.stop?.());
    const over = () => used() >= CAP || terminal();
    const cleanupOver = () => terminal() || s.tick() >= (cleanupDeadline ?? s.tick());
    const waiting = o.waiting ?? (() => courierWaiting(s.name));
    let finalBankConfirmed = false;
    let bankObservedAt = 0;
    let failure = '';

    const hp0 = hp();
    let hpMin = hp0;
    const off = s.onTick(() => {
        if (hp0 > 0) hpMin = Math.min(hpMin, hp());
        stopped ||= !!o.stop?.();
        const p = pos();
        if (p?.isDead || (p?.respawnCount ?? 0) > respawns || (life !== undefined && (p?.lifeId ?? life) !== life)) {
            died = true;
        }
    });

    let picks = 0;
    let banked = 0;
    let bankTrips = 0;
    let walkTicks = 0;

    const walk = async (x: number, z: number, tol = 2, stop = over): Promise<boolean> => {
        const a = s.tick();
        for (let i = 0; i < 3 && !stop(); i++) {
            const p = pos();
            if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
            const remaining = Math.max(0, (cleanupDeadline ?? t0 + CAP) - s.tick());
            if (o.walk) {
                if (!(await o.walk(x, z, tol, stop, remaining))) break;
                continue;
            }
            const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop, maxTicks: remaining });
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                await waitTicks(s, 1);
            }
        }
        walkTicks += s.tick() - a;
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };

    const bank = async (final = false): Promise<boolean> => {
        const stop = final ? cleanupOver : over;
        const n = flaxCount();
        if (!final && n === 0 && !waiting()) return false;
        if (stop() || !(await walk(SEERS_BANK.x, SEERS_BANK.z, 2, stop)) || stop()) return false;
        await s.bot.dismissBlockingUI();
        if (stop()) return false;
        if (!s.sdk.getState()?.bank?.isOpen || !s.bankObservation?.()) {
            const generation = s.bankObservation?.()?.generation ?? 0;
            const b = await s.bot.openBank();
            if (
                !b.success
                || !(await waitUntil(s, () => stop() || (!!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation), {
                    timeoutTicks: 15,
                }))
                || stop()
            ) {
                return false;
            }
        }
        const before = s.bankObservation?.();
        if (!before || !s.sdk.getState()?.bank?.isOpen) return false;
        const bankFlax = () => (s.bankObservation?.()?.items ?? []).filter(i => /^flax$/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
        const original = bankFlax();
        if (n > 0) {
            if (!(await s.bot.depositItem(/^flax$/i, -1)).success) return false;
            await waitUntil(s, () => stop() || (flaxCount() === 0 && bankFlax() === original + n && (s.bankObservation?.()?.generation ?? 0) > before.generation), {
                timeoutTicks: 10,
            });
            if (stop() || flaxCount() !== 0 || bankFlax() !== original + n || (s.bankObservation?.()?.generation ?? 0) <= before.generation) {
                return false;
            }
            banked += n;
        }
        bankTrips++;
        if (stop()) return false;
        await (o.cargo ?? ((session, halt) => bankCargo(session, [/^flax$/i], 0, { stopped: halt })))(s, stop);
        const observed = s.bankObservation?.();
        const confirmed = !stop() && !!s.sdk.getState()?.bank?.isOpen && !!observed && flaxCount() === 0;
        if (confirmed) bankObservedAt = observed!.at;
        if (!stop()) await s.bot.closeInterface();
        console.log(`MILESTONE bank t=${used()} banked=${banked} totalPicks=${picks}`);
        return confirmed;
    };

    const awayFn = o.deps?.awayFrom ?? defaultAwayFrom;
    const field = { ...FLAX_FIELD, level: 0 };
    const away = () => awayFn(pos(), field, FLAX_APPROACH_FROM);
    console.log(`START flax gatherer ${s.name} at=${pos()?.worldX},${pos()?.worldZ},${pos()?.level ?? 0}`);
    try {
        if (away() && !over()) {
            const reached = o.approach ? await o.approach(over) : (await defaultApproach(s, field, over, o.deps)).ok;
            if (!reached && away() && !over()) failure = 'no flax progress: no route to the flax field';
            console.log(`MILESTONE approach t=${used()} at=${pos()?.worldX},${pos()?.worldZ},${pos()?.level ?? 0}`);
        }
        while (!over() && !failure) {
            if (flaxCount() >= BANK_AT || waiting() || (flaxCount() > 0 && freeSpace() === 0)) {
                if (!(await bank())) {
                    if (!over()) failure = 'no flax progress: production bank unconfirmed';
                    break;
                }
                await waitTicks(s, 1);
                continue;
            }
            const p = pos();
            if (!p) {
                await waitTicks(s, 1);
                continue;
            }
            if (Math.max(Math.abs(p.worldX - FLAX_FIELD.x), Math.abs(p.worldZ - FLAX_FIELD.z)) > 15) {
                await walk(FLAX_FIELD.x, FLAX_FIELD.z, 5);
                continue;
            }
            const loc = s.sdk.findNearbyLoc(/^flax$/i);
            if (!loc) {
                await walk(FLAX_FIELD.x, FLAX_FIELD.z, 4);
                await waitTicks(s, 2);
                continue;
            }
            const before = flaxCount();
            await s.bot.interactLoc(loc, 'Pick');
            await waitUntil(s, () => flaxCount() > before, { timeoutTicks: 6 });
            if (flaxCount() > before) picks++;
        }
    } catch (e) {
        failure = String(e);
    }
    if (!terminal()) {
        cleanupDeadline = s.tick() + 240;
        try {
            finalBankConfirmed = await bank(true);
        } catch (e) {
            failure ||= String(e);
        }
    }
    off();
    const held = flaxCount();
    const ok = picks > 0 && !terminal() && !failure && finalBankConfirmed && held === 0;
    if (!ok) failure ||= stopped ? 'stop-file' : died ? 'died' : ended ? 'session-ended' : 'no flax progress: final bank unconfirmed';
    return {
        ok,
        picks,
        banked,
        held,
        bankTrips,
        walkTicks,
        hpMin,
        died,
        ended,
        stopped,
        finalBankConfirmed,
        bankObservedAt,
        ticks: used(),
        failure,
        flaxPer1kTicks: ((picks * 1000) / Math.max(1, used())).toFixed(2),
    };
}

// ---------------------------------------------------------------------------
// 2. Lumbridge Wool (`foraging:wool`)
// ---------------------------------------------------------------------------
export async function runWool(
    s: Session,
    opts: { cap?: number; maxTrips?: number; stop?: () => boolean; deps?: GatherExternalDeps } = {},
) {
    const CAP = opts.cap ?? 15000;
    const MAX_TRIPS = opts.maxTrips ?? Infinity;
    if (opts.deps?.leaveRuneStarter) await opts.deps.leaveRuneStarter(s, () => !!opts.stop?.());
    await waitTicks(s, 3);
    const t0 = s.tick();
    let ended = false;
    let died = false;
    let gathered = 0;
    let spun = 0;
    let trips = 0;
    let rawBanked = 0;
    const initial = s.sdk.getState()?.player;
    void s.ended.then(() => { ended = true; });
    const over = () => !!opts.stop?.() || ended || died || s.tick() - t0 >= CAP;
    const off = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        if (p?.isDead || (p?.respawnCount ?? 0) > (initial?.respawnCount ?? 0) || (initial?.lifeId !== undefined && (p?.lifeId ?? initial.lifeId) !== initial.lifeId)) {
            died = true;
        }
    });
    const inv = () => s.sdk.getInventory();
    const cnt = (re: RegExp) => countItems(s, re);
    const walk = async (x: number, z: number, level = 0) => {
        if (over()) throw new Error('worker ended or cap');
        const p = s.sdk.getState()?.player;
        if (p?.level !== level) {
            const r = await goTo(s, await getWorld(), { x, z, level }, accountOf(s), { legTimeoutTicks: 100 });
            if (!r.ok) throw new Error(`route ${x},${z},${level}: ${r.detail}`);
        } else {
            const r = await walkPath(await sessionWalker(s), [{ x, z, tol: 2 }], { stop: over });
            if (!r.ok) throw new Error(`walk: ${r.detail}`);
        }
    };
    const bank = async () => {
        if (s.sdk.getState()?.player?.level !== 0) await walk(3218, 3256, 0);
        const px = s.sdk.getState()?.player?.worldX ?? 0;
        if (px > 3150) {
            for (const [x, z] of [[3218, 3256], [3180, 3258], [3140, 3270], [3100, 3270], [3089, 3266], [3092, 3250]]) {
                await walk(x!, z!);
            }
        }
        await walk(3092, 3243);
        const b = await s.bot.openBank();
        if (!b.success) throw new Error(`bank: ${b.message}`);
        for (const id of new Set(inv().filter(i => !/^(shears|bread|shrimps)$/i.test(i.name)).map(i => i.id))) {
            const item = inv().find(i => i.id === id);
            if (item) await s.bot.depositItem(item, -1);
        }
        await waitTicks(s, 1);
        rawBanked = s.sdk.getState()?.bank?.items.find(i => /^wool$/i.test(i.name))?.count ?? 0;
        if (!over()) await bankCargo(s, [/^wool$/i, /^ball of wool$/i], 0, { stopped: over });
        await s.bot.closeBank();
        trips++;
        console.log(`MILESTONE wool bank gathered=${gathered} spun=${spun} rawBanked=${rawBanked} trips=${trips}`);
    };
    try {
        if (!inv().some(i => /^shears$/i.test(i.name))) {
            if ((s.sdk.getState()?.player?.worldX ?? 0) < 3150) {
                for (const [x, z] of [[3092, 3250], [3089, 3266], [3100, 3270], [3140, 3270], [3180, 3258], [3218, 3256]]) {
                    await walk(x!, z!);
                }
            }
            await walk(3222, 3218);
            for (let i = 0; i < 8 && cnt(/^coins$/i) < 5; i++) {
                if ((s.sdk.getSkill('Hitpoints')?.level ?? 0) < 5) throw new Error('low HP during tool bootstrap');
                await s.bot.pickpocketNpc(/^man$/i);
                await waitTicks(s, 2);
            }
            await walk(3211, 3247);
            const shop = await s.bot.openShop(/^shop keeper$/i);
            if (!shop.success) throw new Error(`tool shop: ${shop.message}`);
            const buy = await s.bot.buyFromShop(/^shears$/i, 1);
            await s.bot.closeShop();
            if (!buy.success) throw new Error(`shears: ${buy.message}`);
        }
        await bank();
        while (!over() && trips < MAX_TRIPS) {
            if ((s.sdk.getState()?.player?.worldX ?? 0) < 3150) {
                for (const [x, z] of [[3092, 3250], [3089, 3266], [3100, 3270], [3140, 3270], [3180, 3258]]) {
                    await walk(x!, z!);
                }
            }
            await walk(3200, 3270, 0);
            let misses = 0;
            while (inv().length < 28 && !over()) {
                const sheep = s.sdk.getState()?.nearbyNpcs.filter(n => n.id === 43).sort((a, b) => a.distance - b.distance)[0];
                const shears = inv().find(i => /^shears$/i.test(i.name));
                if (!shears) throw new Error('missing shears');
                if (!sheep) {
                    const woolly = await waitUntil(s, st => st.nearbyNpcs.some((n: { id: number }) => n.id === 43), { timeoutTicks: 120 });
                    if (!woolly) throw new Error('no woolly sheep within 120 ticks');
                    continue;
                }
                const before = cnt(/^wool$/i);
                if (s.sdk.getState()?.dialog?.isOpen || s.sdk.getState()?.modalOpen) {
                    await s.direct({ type: 'closeModal', reason: 'SDK' });
                }
                const messageTick = s.sdk.getState()?.gameMessages.at(-1)?.tick ?? -1;
                await s.sdk.sendUseItemOnNpc(shears.slot, sheep.index);
                await waitUntil(
                    s,
                    st =>
                        cnt(/^wool$/i) > before
                        || st.gameMessages.some(
                            (m: { tick: number; text: string }) => m.tick > messageTick && /sheep manages to get away|already been shorn/i.test(m.text),
                        ),
                    { timeoutTicks: 12 },
                );
                const got = cnt(/^wool$/i) > before;
                if (got) {
                    gathered++;
                    misses = 0;
                } else if (++misses > 20) {
                    throw new Error('shearing made no progress');
                }
            }
            console.log(`MILESTONE shear t=${s.tick() - t0} gathered=${gathered} held=${cnt(/^wool$/i)}`);
            if (rawBanked < 25) {
                await bank();
                continue;
            }
            await walk(3209, 3213, 1);
            let failed = 0;
            while (cnt(/^wool$/i) > 0 && !over()) {
                const wheel = s.sdk.findNearbyLoc(/^spinning wheel$/i);
                const wool = inv().find(i => /^wool$/i.test(i.name));
                if (!wheel || !wool) throw new Error('missing wheel or wool');
                const before = cnt(/^ball of wool$/i);
                if (s.sdk.getState()?.dialog?.isOpen || s.sdk.getState()?.modalOpen) {
                    await s.direct({ type: 'closeModal', reason: 'SDK' });
                }
                await s.sdk.sendUseItemOnLoc(wool.slot, wheel.x, wheel.z, wheel.id);
                const made = await waitUntil(s, () => cnt(/^ball of wool$/i) > before, { timeoutTicks: 8 });
                if (made) {
                    spun++;
                    failed = 0;
                    await waitTicks(s, 3);
                } else if (++failed > 4) {
                    throw new Error('spinning made no progress');
                }
            }
            console.log(`MILESTONE spin t=${s.tick() - t0} spun=${spun}`);
            await bank();
        }
        return {
            ok: gathered > 0 && spun > 0 && !died && !ended,
            ticks: s.tick() - t0,
            gathered,
            spun,
            rawBanked,
            trips,
            died,
        };
    } finally {
        off();
    }
}

// ---------------------------------------------------------------------------
// 3. Chicken Pen Feathers (`foraging:feathers`)
// ---------------------------------------------------------------------------
export function parsePen(v: string | undefined): { x: number; z: number } {
    const m = (v ?? '').match(/^(\d+),(\d+)$/);
    return m ? { x: Number(m[1]), z: Number(m[2]) } : { x: 3229, z: 3298 };
}

export function penTiles(pen: { x: number; z: number }, spawns: { x: number; z: number; level: number }[]): { x: number; z: number }[] {
    const d = (t: { x: number; z: number }) => Math.max(Math.abs(t.x - pen.x), Math.abs(t.z - pen.z));
    return spawns
        .filter(t => t.level === 0 && d(t) <= 15)
        .sort((a, b) => d(a) - d(b))
        .map(({ x, z }) => ({ x, z }));
}

export async function finishPenEntry(
    s: { sdk: { getState(): any }; bot: { walkTo(x: number, z: number, tolerance?: number): Promise<unknown> } },
    tile: { x: number; z: number },
): Promise<boolean> {
    const inside = () => {
        const p = s.sdk.getState()?.player;
        return p?.level === 0 && p.worldX === tile.x && p.worldZ === tile.z;
    };
    if (inside()) return true;
    await s.bot.walkTo(tile.x, tile.z, 0);
    return inside();
}

export async function enterPen(
    s: Parameters<typeof finishPenEntry>[0],
    pen: { x: number; z: number },
    tiles: { x: number; z: number }[],
    walk: (to: { x: number; z: number; level: number }) => Promise<{ ok: boolean; reason?: string; detail?: string }>,
): Promise<string | null> {
    const far = () => {
        const p = s.sdk.getState()?.player;
        return p ? Math.max(Math.abs(p.worldX - pen.x), Math.abs(p.worldZ - pen.z)) : Infinity;
    };
    let fault = 'exact pen entry unobserved';
    let best = far();
    for (const t of tiles) {
        const there = await walk({ ...t, level: 0 });
        if (there.ok && (await finishPenEntry(s, t))) return null;
        fault = there.ok ? 'exact pen entry unobserved' : `${there.reason} ${there.detail}`;
        const d = far();
        if (!there.ok && d > 15 && d >= best) break;
        best = Math.min(best, d);
    }
    return fault;
}

export const featherRunOk = (gained: number, held: number, target: number): boolean => gained > 0 || held >= target;

let cachedChickenSpawns: { x: number; z: number; level: number }[] | undefined;
function chickenSpawns(): { x: number; z: number; level: number }[] {
    if (cachedChickenSpawns) return cachedChickenSpawns;
    const rows = JSON.parse(readFileSync(resolve(ROOT, 'knowledge/npcs.json'), 'utf8')) as {
        name: string;
        spawns?: { x: number; z: number; level: number }[];
    }[];
    const out: { x: number; z: number; level: number }[] = [];
    for (let i = 0; i < rows.length; i++) {
        const n = rows[i]!;
        if (n.name === 'Chicken' && n.spawns) {
            for (let si = 0; si < n.spawns.length; si++) out.push(n.spawns[si]!);
        }
    }
    cachedChickenSpawns = out;
    return out;
}

export async function runFeathers(
    s: Session,
    opts: { pen?: string; ticks?: number; target?: number; stop?: () => boolean; deps?: GatherExternalDeps } = {},
) {
    const PEN = parsePen(opts.pen);
    const TICKS = opts.ticks ?? 3000;
    const TARGET = opts.target ?? 2000;
    const FEATHER = /^feather$/i;
    const CHICKEN = /^chicken$/i;
    const st = () => s.sdk.getState() as any;
    const start = s.tick();
    const over = () => !!opts.stop?.() || s.tick() - start >= TICKS || countItems(s, FEATHER) >= TARGET;
    const f0 = countItems(s, FEATHER);
    let kills = 0;
    let idle = 0;
    const spawns = chickenSpawns();
    const fault = await enterPen(s, PEN, [...penTiles(PEN, spawns).slice(0, 4), PEN], to =>
        defaultApproach(s, to, () => !!opts.stop?.(), opts.deps),
    );
    if (fault) {
        throw Error(`travel to chickens ${PEN.x},${PEN.z} failed: ${fault}`);
    }
    console.log(`MILESTONE pen t=${s.tick() - start} at=${st()?.player?.worldX},${st()?.player?.worldZ},${st()?.player?.level ?? 0}`);
    while (!over()) {
        if (randomEventsOf(s)?.busy()) {
            await waitTicks(s, 1);
            continue;
        }
        const groundItems: any[] = st()?.groundItems ?? [];
        let loot: any;
        for (let i = 0; i < groundItems.length; i++) {
            const g = groundItems[i]!;
            if (g.distance <= 8 && g.reachable !== false && FEATHER.test(g.name) && (!loot || g.distance < loot.distance)) {
                loot = g;
            }
        }
        if (loot) {
            const n0 = countItems(s, FEATHER);
            await s.direct({ type: 'pickupItem', x: loot.x, z: loot.z, itemId: loot.id, reason: 'SDK' });
            await waitUntil(s, () => countItems(s, FEATHER) > n0, { timeoutTicks: Math.min(12, loot.distance + 3) });
            continue;
        }
        const npcs: any[] = st()?.nearbyNpcs ?? [];
        let c: any;
        for (let i = 0; i < npcs.length; i++) {
            const n = npcs[i]!;
            if (
                CHICKEN.test(n.name)
                && n.reachable !== false
                && (n.hp ?? 1) > 0
                && Math.abs(n.x - PEN.x) <= 10
                && Math.abs(n.z - PEN.z) <= 10
                && (!c || n.distance < c.distance)
            ) {
                c = n;
            }
        }
        const op = c?.optionsWithIndex?.find((o: any) => /^attack$/i.test(o.text))?.opIndex;
        if (!c || op === undefined) {
            idle++;
            await waitTicks(s, 1);
            continue;
        }
        await s.direct({ type: 'interactNpc', npcIndex: c.index, optionIndex: op, reason: 'SDK' });
        if (
            (await waitUntil(s, x => !(x?.nearbyNpcs ?? []).some((n: any) => n.index === c.index && (n.hp ?? 1) > 0), { timeoutTicks: 20 }))
            && ++kills % 25 === 0
        ) {
            console.log(`FEATHERS kills=${kills} feathers=${countItems(s, FEATHER)} idle=${idle} t=${s.tick() - start}`);
        }
    }
    await waitUntil(s, x => x?.player?.combat?.inCombat === false, { timeoutTicks: 30 });
    const held = countItems(s, FEATHER);
    const got = held - f0;
    const ok = featherRunOk(got, held, TARGET);
    return { ok, feathers: held, gained: got, kills, idle, ticks: s.tick() - start };
}

// ---------------------------------------------------------------------------
// 4. Ground Spawns (`foraging:spawn`)
// ---------------------------------------------------------------------------
export function tripSize(left: number, stackable: boolean, freeSlots: number): number {
    return Math.max(0, Math.min(left, stackable ? left : freeSlots));
}

export function safeSpawnWalk(
    s: Parameters<typeof accountOf>[0] & Parameters<typeof goTo>[0],
    world: Parameters<typeof goTo>[1],
    allowWilderness = process.env.ALLOW_WILDERNESS === '1',
    move: (
        session: Parameters<typeof goTo>[0],
        w: Parameters<typeof goTo>[1],
        to: Tile,
        acct: ReturnType<typeof accountOf>,
        opts: { legTimeoutTicks: number },
    ) => Promise<{ ok: boolean; reason?: string; detail?: string }> = goTo,
): (to: Tile) => Promise<{ ok: boolean; reason?: string; detail?: string }> {
    return async (to: Tile) => {
        if (!allowWilderness && wildernessLevel(to.x, to.z) > 0) {
            return { ok: false, reason: 'wilderness', detail: `refused Wilderness spawn ${to.x},${to.z},${to.level}` };
        }
        return move(s, world, to, accountOf(s), { legTimeoutTicks: 100 });
    };
}

export function nonWildernessBanks<T extends { x: number; z: number }>(
    banks: readonly T[],
    allowWilderness = process.env.ALLOW_WILDERNESS === '1',
): T[] {
    return banks.filter(b => allowWilderness || wildernessLevel(b.x, b.z) === 0);
}

export async function runSpawn(
    s: Session,
    opts: { id: number; target?: number; ticks?: number; allowWilderness?: boolean; stop?: () => boolean; deps?: GatherExternalDeps },
) {
    const id = opts.id;
    const target = opts.target ?? 27;
    const TICKS = opts.ticks ?? 6000;
    const allowWilderness = opts.allowWilderness ?? false;
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(target) || target < 1) {
        throw Error('usage: gather-spawn <item id> [target]');
    }
    let start = s.tick();
    const inv = () => s.sdk.getInventory();
    const held = () => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const here = () => {
        const p = s.sdk.getState()!.player!;
        return { x: p.worldX, z: p.worldZ, level: p.level };
    };
    let banked = 0;
    let trips = 0;
    let last = '';
    let failed = '';
    try {
        const world = await getWorld();
        start = s.tick();
        const walkSpawn = safeSpawnWalk(s, world, allowWilderness);
        while (banked < target && s.tick() - start < TICKS && !opts.stop?.()) {
            if (!allowWilderness && wildernessLevel(here().x, here().z) > 0) {
                last = `refused Wilderness position ${here().x},${here().z}`;
                break;
            }
            const stack = inv().find(i => i.id === id);
            const stackable =
                (stack?.count ?? 0) > 1
                || /rune$/i.test(stack?.name ?? '')
                || [554, 555, 556, 557, 558, 559, 560, 561, 562, 563, 564, 565, 566].includes(id);
            const n = tripSize(target - banked - held(), stackable, 28 - inv().length);
            if (n > 0) last = (await gatherItems(s, world, [{ id, count: n, how: 'spawn' }], walkSpawn)) ?? '';
            const got = held();
            if (!got) break;
            let deposited = false;
            for (const bank of nonWildernessBanks(defaultNearestBanks(here(), opts.deps), allowWilderness).slice(0, 4)) {
                if (!(await goTo(s, world, bank, accountOf(s), { legTimeoutTicks: 100 })).ok) continue;
                if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!s.bankObservation?.(), { timeoutTicks: 20 }))) continue;
                const item = inv().find(i => i.id === id);
                const credited = item ? await depositObserved(s, item) : 0;
                if (credited > 0) {
                    banked += credited;
                    trips++;
                }
                await s.bot.closeBank();
                deposited = held() === 0 && credited === got;
                break;
            }
            if (!deposited) {
                last = 'no bank in reach';
                break;
            }
            console.log(`GATHER_SPAWN trip=${trips} banked=${banked}/${target} t=${s.tick() - start} ${last}`);
        }
    } catch (e) {
        failed = String(e);
    }
    const targetMet = banked >= target;
    return {
        ok: !failed && targetMet,
        item: id,
        banked,
        target,
        targetMet,
        remaining: Math.max(0, target - banked),
        trips,
        ticks: s.tick() - start,
        last: failed || last,
    };
}

// ---------------------------------------------------------------------------
// 5. Cooks' Guild Grapes (`foraging:grapes`)
// ---------------------------------------------------------------------------
const GRAPE_SPAWN = { x: 3144, z: 3450, level: 2 };
const GRAPE_DOOR_OUT = { x: 3143, z: 3443 };
const GRAPE_BANK = { x: 3185, z: 3436 };

export async function runGrapes(s: Session, opts: { cap?: number; bankAt?: number; stop?: () => boolean } = {}) {
    const CAP = opts.cap ?? 1500;
    const BANK_AT = opts.bankAt ?? 26;
    const pos = () => s.sdk.getState()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const grapes = () => countItems(s, /^grapes$/i);
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => !!opts.stop?.() || used() >= CAP;
    let hp0 = 0;
    let hpMin = 99;
    const off = s.onTick(() => { if (hp0 > 0) hpMin = Math.min(hpMin, hp()); });
    let picks = 0;
    let banked = 0;
    let bankTrips = 0;
    let walkTicks = 0;
    let waitTicksN = 0;
    let tries = 0;
    let lost = 0;
    const gaps: number[] = [];
    let lastPick = -1;
    const counters = () =>
        `picks=${picks} banked=${banked} held=${grapes()} bankTrips=${bankTrips} tries=${tries} lost=${lost} walkTicks=${walkTicks} waitTicks=${waitTicksN} gaps=${gaps.join(',')} hpMin=${hpMin}`;
    const fail = (why: string): never => {
        const p = pos();
        throw Error(`${why} at=${p?.worldX},${p?.worldZ},${p?.level} ticks=${used()} ${counters()}`);
    };
    const walk = async (x: number, z: number, tol = 1): Promise<boolean> => {
        const a = s.tick();
        for (let i = 0; i < 3 && !over(); i++) {
            const p = pos();
            if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
            const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop: over });
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                await waitTicks(s, 1);
            }
        }
        walkTicks += s.tick() - a;
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };
    const climb = async (re: RegExp, op: string, toLevel: number): Promise<boolean> => {
        const a = s.tick();
        for (let i = 0; i < 3 && pos()?.level !== toLevel && !over(); i++) {
            const loc = s.sdk.findNearbyLoc(re);
            if (!loc) {
                await waitTicks(s, 1);
                continue;
            }
            await s.bot.interactLoc(loc, op);
            await waitUntil(s, st => st?.player?.level === toLevel, { timeoutTicks: 10 });
        }
        walkTicks += s.tick() - a;
        return pos()?.level === toLevel;
    };
    const goUp = async () => {
        if ((pos()?.level ?? 0) === 0) {
            if (!(await walk(GRAPE_DOOR_OUT.x, GRAPE_DOOR_OUT.z, 0))) fail('walk to guild door');
            if (!(await walk(3143, 3448, 1))) fail('enter guild');
            if (!(await climb(/^staircase$/i, 'Climb-up', 1))) fail('stairs up');
        }
        if (pos()?.level === 1 && !(await climb(/^ladder$/i, 'Climb-up', 2))) fail('ladder up');
    };
    const goDown = async () => {
        if (pos()?.level === 2 && !(await climb(/^ladder$/i, 'Climb-down', 1))) fail('ladder down');
        if (pos()?.level === 1 && !(await climb(/^staircase$/i, 'Climb-down', 0))) fail('stairs down');
    };
    const bank = async () => {
        await goDown();
        if (!(await walk(GRAPE_BANK.x, GRAPE_BANK.z, 2))) fail('walk to bank');
        const o = await s.bot.openBank();
        if (!o.success) fail(`openBank ${o.message}`);
        const n = grapes();
        await s.bot.depositItem(/^grapes$/i, -1);
        await waitTicks(s, 1);
        banked += n - grapes();
        bankTrips++;
        await s.bot.closeInterface();
        await waitTicks(s, 1);
        console.log(`MILESTONE bank ${used()} banked=${banked}`);
        await goUp();
    };
    try {
        await waitTicks(s, 2);
        hp0 = hp();
        hpMin = hp0;
        console.log(`HP start ${hp0}`);
        await goUp();
        console.log(`MILESTONE spawn ${used()}`);
        while (!over()) {
            if (hp() < hp0) fail(`hp loss ${hp0}->${hp()}`);
            if (grapes() >= BANK_AT) {
                await bank();
                continue;
            }
            const p = pos();
            if (!p || p.level !== 2) {
                await goUp();
                continue;
            }
            const g = s.sdk.getGroundItems().find((i: { name: string; x: number; z: number }) => /^grapes$/i.test(i.name) && i.x === GRAPE_SPAWN.x && i.z === GRAPE_SPAWN.z);
            if (!g) {
                waitTicksN++;
                await waitTicks(s, 1);
                continue;
            }
            tries++;
            const before = grapes();
            await s.bot.pickupItem(g);
            await waitTicks(s, 1);
            if (grapes() > before) {
                picks++;
                if (lastPick >= 0) gaps.push(used() - lastPick);
                lastPick = used();
            } else {
                lost++;
                await waitTicks(s, 3);
            }
        }
        const perK = ((picks * 1000) / Math.max(1, used())).toFixed(2);
        return {
            ok: picks > 0,
            picks,
            banked,
            bankTrips,
            ticks: used(),
            summaryText: `ticks=${used()} ${counters()} grapesPer1kTicks=${perK}`,
        };
    } finally {
        off();
    }
}

// ---------------------------------------------------------------------------
// 6. Taverley Crystal Chest (`foraging:crystal-chest`)
// ---------------------------------------------------------------------------
export const KEY_TOOTH = 985;
export const KEY_LOOP = 987;
export const CRYSTAL_KEY = 989;
export const UNCUT_DRAGONSTONE = 1631;
export const CHEST_CLOSED = 172;
export const CHEST_OPEN = 173;
export const MIN_FREE_SLOTS = 12;
export const TAVERLEY_CHEST_STAND: Tile = { x: 2914, z: 3451, level: 0 };
export const TAVERLEY_CHEST_TILE: Tile = { x: 2914, z: 3452, level: 0 };

export function planCrystalChest(
    heldKeys: number,
    heldTooth: number,
    heldLoop: number,
    bankKeys: number,
    bankTooth: number,
    bankLoop: number,
    maxKeys = 0,
): { combinePairs: number; keysToOpen: number } {
    const clean = [heldKeys, heldTooth, heldLoop, bankKeys, bankTooth, bankLoop, maxKeys];
    if (clean.some(n => !Number.isSafeInteger(n) || n < 0)) return { combinePairs: 0, keysToOpen: 0 };
    const totalPairs = Math.min(heldTooth + bankTooth, heldLoop + bankLoop);
    const totalKeys = heldKeys + bankKeys + totalPairs;
    const keysToOpen = maxKeys > 0 ? Math.min(totalKeys, maxKeys) : totalKeys;
    const combinePairs = maxKeys > 0 ? Math.min(totalPairs, Math.max(0, keysToOpen - heldKeys - bankKeys)) : totalPairs;
    return { combinePairs, keysToOpen };
}

export async function runCrystalChest(
    s: Session,
    opts: {
        cap?: number;
        maxKeys?: number;
        stop?: () => boolean;
        walk?: (to: Tile) => Promise<{ ok: boolean; reason?: string; detail?: string }>;
        deps?: GatherExternalDeps;
    } = {},
) {
    const cap = opts.cap ?? 2000;
    const maxKeys = opts.maxKeys ?? 0;
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('invalid crystal chest tick cap');
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 0) throw Error('invalid crystal chest MAX_KEYS');
    const start = s.tick();
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const initialLife = pos();
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const stopped = () => ended || !!opts.stop?.() || sessionDied(initialLife, pos()) || existsSync(`.practice/stop-${s.name}`) || s.tick() - start >= cap;
    const inv = () => s.sdk.getInventory();
    const count = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const bankCount = (id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

    const openBank = async () => {
        const gen = s.bankObservation?.()?.generation ?? 0;
        if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => stopped() || (!!st()?.bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen), { timeoutTicks: 15 }))) {
            throw Error('crystal chest bank observation unavailable');
        }
    };
    const closeBank = async () => {
        await s.bot.closeBank();
        await waitUntil(s, () => stopped() || !st()?.bank.isOpen, { timeoutTicks: 10 });
    };
    const depositAll = async () => {
        for (const id of new Set(inv().map(i => i.id))) {
            const item = inv().find(i => i.id === id);
            if (item) await depositObserved(s, item);
        }
    };
    const withdraw = async (id: number, n: number) => {
        if (n < 1) return;
        const row = st()?.bank.items.find(i => i.id === id);
        const before = count(id);
        const stored = bankCount(id);
        const gen = s.bankObservation?.()?.generation ?? 0;
        if (!row || stored < n) throw Error(`crystal chest withdraw short: item ${id} needs ${n}, bank holds ${stored}`);
        await s.bot.withdrawItem(row, n, { asNote: false });
        if (!(await waitUntil(s, () => stopped() || (count(id) === before + n && bankCount(id) === stored - n && (s.bankObservation?.()?.generation ?? 0) > gen), { timeoutTicks: 10 }))) {
            throw Error(`crystal chest withdraw unobserved for item ${id}`);
        }
    };
    const walkTo = async (to: Tile, label: string) => {
        const res = await defaultWalkTargetPersist(s, to, 4, opts.deps, opts.walk);
        if (!res.ok) throw Error(`crystal chest walk to ${label} failed: ${res.reason ?? ''} ${res.detail ?? ''}`);
    };

    if (!(await waitUntil(s, () => stopped() || (!!pos() && Array.isArray(st()?.inventory)), { timeoutTicks: 20 }))) {
        throw Error('crystal chest startup state unavailable');
    }
    await walkTo(FALADOR_WEST_BANK, 'Falador West Bank');
    await openBank();
    await depositAll();

    const plan = planCrystalChest(0, 0, 0, bankCount(CRYSTAL_KEY), bankCount(KEY_TOOTH), bankCount(KEY_LOOP), maxKeys);
    if (plan.keysToOpen < 1) {
        await closeBank();
        throw Error('next acquisition: no crystal_key (989) or keyhalf1+keyhalf2 (985+987) in bank');
    }

    let combined = 0;
    let opened = 0;
    let dragonstones = 0;
    while (combined < plan.combinePairs && !stopped()) {
        const batch = Math.min(14, plan.combinePairs - combined);
        await withdraw(KEY_TOOTH, batch);
        await withdraw(KEY_LOOP, batch);
        await closeBank();
        while (count(KEY_TOOTH) > 0 && count(KEY_LOOP) > 0 && !stopped()) {
            const tooth = inv().find(i => i.id === KEY_TOOTH);
            const loop = inv().find(i => i.id === KEY_LOOP);
            if (!tooth || !loop) break;
            const beforeKeys = count(CRYSTAL_KEY);
            await s.sdk.sendUseItemOnItem(tooth.slot, loop.slot);
            if (!(await waitUntil(s, () => stopped() || count(CRYSTAL_KEY) > beforeKeys, { timeoutTicks: 8 }))) {
                throw Error('crystal key half combination unobserved');
            }
            combined++;
        }
        await openBank();
        await depositAll();
    }

    const totalGoal = Math.min(plan.keysToOpen, bankCount(CRYSTAL_KEY));
    while (opened < totalGoal && !stopped()) {
        const carry = Math.min(2, totalGoal - opened, bankCount(CRYSTAL_KEY));
        if (carry < 1) break;
        await withdraw(CRYSTAL_KEY, carry);
        await closeBank();
        await walkTo(TAVERLEY_CHEST_STAND, 'Taverley Crystal Chest');
        while (count(CRYSTAL_KEY) > 0 && opened < totalGoal && !stopped()) {
            if (28 - inv().length + 1 < MIN_FREE_SLOTS) break;
            const findClosedChest = () =>
                (st()?.nearbyLocs ?? []).find(l => l.id === CHEST_CLOSED)
                ?? (st()?.nearbyLocs ?? []).find(l => /crystal chest/i.test(l.name) && l.id !== CHEST_OPEN);
            if (!(await waitUntil(s, () => stopped() || !!findClosedChest(), { timeoutTicks: 15 }))) {
                throw Error('crystal chest closed loc unobserved');
            }
            const chest = findClosedChest();
            const keyItem = inv().find(i => i.id === CRYSTAL_KEY);
            if (!chest || !keyItem) break;
            const keysBefore = count(CRYSTAL_KEY);
            const stoneBefore = count(UNCUT_DRAGONSTONE);
            await s.bot.useItemOnLoc(keyItem.name, chest);
            if (!(await waitUntil(s, () => stopped() || (count(CRYSTAL_KEY) < keysBefore && count(UNCUT_DRAGONSTONE) > stoneBefore), { timeoutTicks: 15 }))) {
                throw Error('crystal chest unlock/dragonstone unobserved');
            }
            opened++;
            dragonstones += count(UNCUT_DRAGONSTONE) - stoneBefore;
        }
        await walkTo(FALADOR_WEST_BANK, 'Falador West Bank');
        await openBank();
        await depositAll();
    }
    const bankDragonstones = bankCount(UNCUT_DRAGONSTONE);
    await closeBank();
    return { ok: opened > 0 && !stopped(), opened, combined, dragonstones, bankDragonstones, ticks: s.tick() - start };
}

// ---------------------------------------------------------------------------
// Unified foraging dispatcher (`GatherConfig` & CLI runner)
// ---------------------------------------------------------------------------
export async function runForagingSession(s: Session, cfg: NormalizedGatherConfig, stop: () => boolean): Promise<GatherOutcome> {
    const start = s.tick();
    const env = cfg.env;
    const args = cfg.args;
    const posArgs = args.filter(a => !/^[A-Z0-9_]+=/.test(a));

    switch (cfg.method) {
        case 'flax': {
            const cap = cfg.target?.capTicks ?? Number(posArgs[0] ?? env.CAP ?? 15000);
            const bankAt = Number(posArgs[1] ?? env.BANK_AT ?? 28);
            const r = await runFlax(s, { cap, bankAt, stop, deps: cfg.deps });
            const line = Object.entries(r).map(([k, v]) => `${k}=${v}`).join(' ');
            return {
                ok: r.ok,
                kind: r.ok ? 'completed' : r.died ? 'died' : r.stopped ? 'aborted' : 'failed',
                detail: line,
                delta: { items: { 1779: r.banked }, elapsedTicks: r.ticks },
                recoverable: !r.ok,
                summary: r,
                resultLine: line,
            };
        }
        case 'wool': {
            const cap = cfg.target?.capTicks ?? Number(posArgs[0] ?? env.CAP ?? 15000);
            const maxTrips = cfg.target?.trips ?? (env.MAX_TRIPS ? Number(env.MAX_TRIPS) : Infinity);
            const r = await runWool(s, { cap, maxTrips, stop, deps: cfg.deps });
            const line = `ticks=${r.ticks} gathered=${r.gathered} spun=${r.spun} rawBanked=${r.rawBanked} trips=${r.trips} died=${r.died}`;
            return {
                ok: r.ok,
                kind: r.ok ? 'completed' : r.died ? 'died' : 'failed',
                detail: line,
                delta: { items: { 1759: r.spun }, elapsedTicks: r.ticks },
                recoverable: !r.ok,
                summary: r,
                resultLine: line,
            };
        }
        case 'feathers': {
            const pen = cfg.spot ?? env.PEN;
            const ticks = cfg.target?.capTicks ?? Number(env.TICKS ?? env.CAP ?? 3000);
            const target = cfg.target?.count ?? Number(env.TARGET ?? 2000);
            const r = await runFeathers(s, { pen, ticks, target, stop, deps: cfg.deps });
            const line = `feathers=${r.feathers} gained=${r.gained} kills=${r.kills} idle=${r.idle} ticks=${r.ticks}`;
            return {
                ok: r.ok,
                kind: r.ok ? 'completed' : 'failed',
                detail: line,
                delta: { items: { 314: Math.max(0, r.gained) }, elapsedTicks: r.ticks },
                recoverable: !r.ok,
                summary: r,
                resultLine: line,
            };
        }
        case 'spawn': {
            const id = Number(cfg.spot ?? posArgs[0]);
            const target = cfg.target?.count ?? Number(posArgs[1] ?? env.TARGET ?? 27);
            const ticks = cfg.target?.capTicks ?? Number(env.TICKS ?? env.CAP ?? 6000);
            const allowWilderness = env.ALLOW_WILDERNESS === '1';
            const r = await runSpawn(s, { id, target, ticks, allowWilderness, stop, deps: cfg.deps });
            const line = `item=${r.item} banked=${r.banked} target=${r.target} targetMet=${r.targetMet} remaining=${r.remaining} trips=${r.trips} ticks=${r.ticks} ${r.last}`;
            return {
                ok: r.ok,
                kind: r.ok ? 'completed' : 'failed',
                detail: line,
                delta: { items: { [id]: r.banked }, elapsedTicks: r.ticks },
                recoverable: !r.ok,
                summary: r,
                resultLine: line,
            };
        }
        case 'grapes': {
            const cap = cfg.target?.capTicks ?? Number(posArgs[0] ?? env.CAP ?? 1500);
            const bankAt = Number(posArgs[1] ?? env.BANK_AT ?? 26);
            const r = await runGrapes(s, { cap, bankAt, stop });
            return {
                ok: r.ok,
                kind: r.ok ? 'completed' : 'failed',
                detail: r.summaryText,
                delta: { items: { 1987: r.banked }, elapsedTicks: r.ticks },
                recoverable: !r.ok,
                summary: r,
                resultLine: r.summaryText,
            };
        }
        case 'crystal-chest': {
            const cap = cfg.target?.capTicks ?? Number(posArgs[0] ?? env.CAP ?? 2000);
            const maxKeys = cfg.target?.count ?? Number(env.MAX_KEYS ?? 0);
            const r = await runCrystalChest(s, { cap, maxKeys, stop, deps: cfg.deps });
            const line = `opened=${r.opened} combined=${r.combined} dragonstones=${r.dragonstones} bankDragonstones=${r.bankDragonstones} ticks=${r.ticks}`;
            return {
                ok: r.ok,
                kind: r.ok ? 'completed' : 'failed',
                detail: line,
                delta: { items: { [UNCUT_DRAGONSTONE]: r.dragonstones }, elapsedTicks: r.ticks },
                recoverable: !r.ok,
                summary: r,
                resultLine: line,
            };
        }
        default:
            return {
                ok: false,
                kind: 'refused',
                detail: `unknown foraging method: ${cfg.method}`,
                delta: { elapsedTicks: s.tick() - start },
                recoverable: false,
            };
    }
}

export async function runForagingCli(account: string, cfg: NormalizedGatherConfig): Promise<number> {
    let stopped = false;
    const onStop =
        cfg.method === 'wool'
            ? (session: Session, reason: string) => {
                  stopped = true;
                  return finish([session], false, reason);
              }
            : async () => {
                  stopped = true;
              };
    const s = await openBot(account, { onStop }).catch(e => finish([], false, `login: ${String(e)}`));
    try {
        const outcome = await runForagingSession(s, cfg, () => stopped);
        await finish([s], outcome.ok, outcome.resultLine ?? outcome.detail ?? '');
        return outcome.ok ? 0 : 1;
    } catch (e) {
        await finish([s], false, String(e));
        return 1;
    }
}
