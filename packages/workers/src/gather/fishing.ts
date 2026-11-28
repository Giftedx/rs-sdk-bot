// Consolidated fishing module: Catherby sharks/lobsters/swordfish, staged native methods, Barbarian Village, and Lumbridge fly/cook.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    accountOf,
    countItems,
    finish,
    getWorld,
    openBot,
    randomEventsOf,
    serverFromEnv,
    sessionDied,
    settle,
} from '../../../core/src/bot';
import { depositObserved } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { componentId } from '../../../core/src/logout';
import { claimOrderJournal, settleOrderJournal } from '../../../core/src/order-journal';
import { resolveBotEnvPath } from '../../../core/src/practice-paths';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { type PathDeps, type PathPoint, type PathTile, goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import type { BotWorldState, NearbyNpc } from '../../../../vendor/rs-sdk/sdk/types';
import { type KnifeAction, knifeCut } from './knife-reset';
import { type GatherExternalDeps, type GatherOutcome, type NormalizedGatherConfig, resolveSetting } from './types';

const ROOT = resolve(import.meta.dir, '../../../..');
const CONTENT = resolve(ROOT, 'vendor/rs-sdk/server/content');

// ---------------------------------------------------------------------------
// 1. Staged Native Fishing (`fishing:staged`, 10 FISH_PROFILES)
// ---------------------------------------------------------------------------
export const FISH_PROFILES = {
    net: { category: 'saltfish', op: 1, label: 'Net', level: 1, tool: 303, bait: 0, products: [317, 321] },
    seaBait: { category: 'saltfish', op: 3, label: 'Bait', level: 5, tool: 307, bait: 313, products: [327, 345] },
    fly: { category: 'freshfish', op: 1, label: 'Lure', level: 20, tool: 309, bait: 314, products: [335, 331] },
    riverBait: { category: 'freshfish', op: 3, label: 'Bait', level: 25, tool: 307, bait: 313, products: [349] },
    cage: { category: 'rarefish', op: 1, label: 'Cage', level: 40, tool: 301, bait: 0, products: [377] },
    harpoon: { category: 'rarefish', op: 3, label: 'Harpoon', level: 35, tool: 311, bait: 0, products: [359, 371] },
    karambwanji: { category: 'category_632', op: 1, label: 'Net', level: 5, tool: 303, bait: 0, products: [3150, 317] },
    karambwan: { category: 'category_633', op: 1, label: 'Fish', level: 65, tool: 3157, bait: 3150, products: [3142] },
    bigNet: {
        category: 'memberfish',
        op: 1,
        label: 'Net',
        level: 16,
        tool: 305,
        bait: 0,
        products: [353, 341, 363],
        byproducts: [1061, 401, 1059, 407, 405],
    },
    lava: { category: null, names: ['0_45_152_lavafish'], op: 1, label: 'Bait', level: 53, tool: 1585, bait: 313, products: [2148] },
} as const;

export type FishMethod = keyof typeof FISH_PROFILES;
export type FishReset = 'same' | 'delayed';

export const FISH_KNIFE_RESET: Readonly<Record<FishMethod, FishReset | null>> = {
    net: 'delayed',
    seaBait: 'delayed',
    fly: 'same',
    riverBait: 'same',
    cage: 'delayed',
    harpoon: 'delayed',
    karambwanji: 'delayed',
    karambwan: null,
    bigNet: 'delayed',
    lava: 'same',
};

export type FishAction =
    | KnifeAction
    | { type: 'interactNpc'; npcIndex: number; optionIndex: number }
    | { type: 'dropItem'; slot: number };

type NativeFishProfile = { category: string | null; names?: readonly string[]; products: readonly number[]; byproducts?: readonly number[] };

export const BIG_NET_RAW_XP: Readonly<Record<number, number>> = {
    1061: 10,
    401: 1,
    1059: 10,
    353: 200,
    407: 100,
    405: 100,
    341: 450,
    363: 1000,
};
const BIG_NET_ROLL_MAX: Readonly<Record<number, number>> = {
    1061: 1,
    401: 1,
    1059: 1,
    353: 2,
    407: 1,
    405: 1,
    341: 1,
    363: 1,
};

export const fishingByproducts = (method: FishMethod): readonly number[] =>
    (FISH_PROFILES[method] as NativeFishProfile).byproducts ?? [];
export const fishingOutputs = (method: FishMethod) => [...FISH_PROFILES[method].products, ...fishingByproducts(method)];
export const fishingCapacityOutputs = (method: FishMethod): Record<number, number> =>
    method === 'bigNet' ? { ...BIG_NET_ROLL_MAX } : { [FISH_PROFILES[method].products[0]!]: 1 };

export function bigNetSnapshot(s: BotWorldState) {
    const items: Record<number, number> = {};
    for (const i of s.inventory) items[i.id] = (items[i.id] ?? 0) + i.count;
    return { items, xp: s.skills.find(k => k.name === 'Fishing')?.experience ?? 0 };
}

export function bigNetReceipt(
    b: ReturnType<typeof bigNetSnapshot>,
    a: ReturnType<typeof bigNetSnapshot>,
    rawBefore = 0,
    initialXp = b.xp,
    rolls = 1,
    xpRate = 25,
) {
    let rawXp = 0;
    let primary = 0;
    let changed = false;
    const byproducts: Record<number, number> = {};
    for (const id of new Set([...Object.keys(b.items), ...Object.keys(a.items)].map(Number))) {
        const n = (a.items[id] ?? 0) - (b.items[id] ?? 0);
        if (!n) continue;
        changed = true;
        if (n < 0 || !Number.isSafeInteger(n) || !BIG_NET_ROLL_MAX[id] || n > BIG_NET_ROLL_MAX[id]! * rolls) {
            return { kind: 'invalid' as const };
        }
        rawXp += n * BIG_NET_RAW_XP[id]!;
        if (FISH_PROFILES.bigNet.products.includes(id as never)) primary += n;
        else byproducts[id] = n;
    }
    const total = (rawBefore + rawXp) * xpRate;
    const publicDelta = a.xp - initialXp;
    if (publicDelta < Math.floor(total / 10) || publicDelta > Math.ceil(total / 10)) return { kind: 'pending' as const };
    return { kind: changed ? ('made' as const) : ('none' as const), rawXp, primary, byproducts };
}

let cachedNpcPack: Map<string, number> | undefined;
let cachedNpcDefs: string[] | undefined;
const spotIdsCache = new Map<FishMethod, number[]>();

function npcPackMap() {
    return (cachedNpcPack ??= new Map(
        readFileSync(resolve(CONTENT, 'pack/npc.pack'), 'utf8')
            .split(/\r?\n/)
            .map(l => {
                const at = l.indexOf('=');
                return [l.slice(at + 1), Number(l.slice(0, at))];
            }),
    ));
}

function npcDefBlocks() {
    return (cachedNpcDefs ??= readFileSync(resolve(CONTENT, 'scripts/skill_fishing/configs/fishing.npc'), 'utf8').split(/(?=^\[)/m));
}

export function fishSpotIds(method: FishMethod) {
    const hit = spotIdsCache.get(method);
    if (hit) return hit;
    const profile = FISH_PROFILES[method] as NativeFishProfile;
    const pack = npcPackMap();
    const ids = npcDefBlocks()
        .filter(block =>
            profile.names
                ? profile.names.includes(block.match(/^\[([^\]]+)\]/)?.[1] ?? '')
                : new RegExp(`^category=${profile.category}\\r?$`, 'm').test(block),
        )
        .map(block => pack.get(block.match(/^\[([^\]]+)\]/)?.[1] ?? ''))
        .filter((id): id is number => id !== undefined);
    spotIdsCache.set(method, ids);
    return ids;
}

export function pickFishSpot(s: BotWorldState, method: FishMethod, radius = 8): NearbyNpc | undefined {
    const p = FISH_PROFILES[method];
    const ids = fishSpotIds(method);
    return s.nearbyNpcs
        .filter(
            n =>
                ids.includes(n.id) &&
                n.reachable !== false &&
                n.distance <= radius &&
                n.optionsWithIndex.some(o => o.opIndex === p.op && o.text.toLowerCase() === p.label.toLowerCase()),
        )
        .sort((a, b) => a.distance - b.distance)[0];
}

export function catherbyFishingSearchPoints() {
    const body = readFileSync(resolve(CONTENT, 'scripts/skill_fishing/configs/fishing_movement.enum'), 'utf8')
        .split('[fishing_movement_catherby_enum]')[1]!
        .split('\n[')[0]!;
    const points = [...body.matchAll(/^val=\d+,(\d+)_(\d+)_(\d+)_(\d+)_(\d+)/gm)].map(m => ({
        x: Number(m[2]) * 64 + Number(m[4]),
        z: Number(m[3]) * 64 + Number(m[5]),
        level: Number(m[1]),
    }));
    return [points[0]!, points[Math.floor(points.length / 2)]!, points.at(-1)!];
}

export async function searchNativeCatherbyFishing(s: Session, method: FishMethod, pass: number, stop: () => boolean) {
    const player = s.sdk.getState()?.player;
    if (
        !player ||
        player.level !== 0 ||
        player.worldX < 2800 ||
        player.worldX > 2870 ||
        player.worldZ < 3410 ||
        player.worldZ > 3455 ||
        !['net', 'seaBait', 'cage', 'harpoon', 'bigNet'].includes(method) ||
        pass >= 3 ||
        stop()
    ) {
        return false;
    }
    const visible = pickFishSpot(s.sdk.getState()!, method, 16);
    const target = visible ?? catherbyFishingSearchPoints()[pass];
    if (!target) return false;
    let end: { x: number; z: number } | undefined;
    for (const distance of [2, 3, 4]) {
        for (const [x, z] of [
            [target.x, target.z + distance],
            [target.x - distance, target.z + distance],
            [target.x + distance, target.z + distance],
        ]) {
            const path = s.sdk.findPath(x!, z!);
            if (path.success && path.reachedDestination === true) {
                end = { x: x!, z: z! };
                break;
            }
        }
        if (end) break;
    }
    if (!end) return false;
    console.log('FISH_SEARCH ' + JSON.stringify({ method, pass, visible: visible?.index, target: { x: target.x, z: target.z }, shore: end }));
    const result = await walkPath(await sessionWalker(s), [{ ...end, tol: 0 }], { maxTicks: 20, stop });
    if (!result.ok || stop()) return false;
    return true;
}

const stateItemCount = (s: BotWorldState, id: number) => s.inventory.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const fishCount = (s: BotWorldState, method: FishMethod) =>
    FISH_PROFILES[method].products.reduce((n, id) => n + stateItemCount(s, id), 0);
const fishingStateXp = (s: BotWorldState) => s.skills.find(k => k.name === 'Fishing')?.experience ?? 0;
const fishingStateHp = (s: BotWorldState) => s.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;

const protectedKit = (s: BotWorldState, method: FishMethod) => {
    const p = FISH_PROFILES[method];
    const allow = new Set<number>([
        ...p.products,
        ...fishingByproducts(method),
        p.bait,
        ...(method === 'karambwan' ? [3157, 3159] : []),
    ]);
    return JSON.stringify(
        [
            ...s.inventory
                .filter(i => !allow.has(i.id))
                .reduce((m, i) => m.set(i.id, (m.get(i.id) ?? 0) + i.count), new Map<number, number>()),
        ].sort((a, b) => a[0] - b[0]),
    );
};

export interface FishBatchOptions {
    method: FishMethod;
    amount: number;
    cap: number;
    maxAttempts: number;
    progressTicks: number;
    xpRate?: number;
    untilLevel?: number;
    knife?: { make1: number; drop?: boolean };
}

export interface FishDriver {
    state: () => BotWorldState | null;
    tick: () => number;
    stopped: () => boolean;
    interact: (index: number, op: number) => Promise<{ success: boolean }>;
    combine: (a: number, b: number) => Promise<{ success: boolean }>;
    wait: (test: () => boolean, ticks: number) => Promise<boolean>;
    step: () => Promise<void>;
    search?: (pass: number, stop: () => boolean) => Promise<boolean>;
    send?: (actions: FishAction[]) => Promise<void>;
    stand?: (spot: NearbyNpc) => Promise<boolean>;
    closeDialog?: () => Promise<unknown>;
}

export function karambwanLoadEffect(before: BotWorldState, after: BotWorldState) {
    return (
        stateItemCount(before, 3157) - stateItemCount(after, 3157) === 1 &&
        stateItemCount(after, 3159) - stateItemCount(before, 3159) === 1 &&
        stateItemCount(before, 3150) - stateItemCount(after, 3150) === 1
    );
}

export function karambwanAttemptEffect(before: BotWorldState, after: BotWorldState) {
    if (stateItemCount(before, 3159) - stateItemCount(after, 3159) !== 1 || stateItemCount(after, 3157) - stateItemCount(before, 3157) !== 1) {
        throw Error('karambwan vessel debit does not reconcile');
    }
    const caught = stateItemCount(after, 3142) - stateItemCount(before, 3142);
    if ((caught !== 0 && caught !== 1) || (caught === 1 && fishingStateXp(after) <= fishingStateXp(before)) || (caught === 0 && fishingStateXp(after) !== fishingStateXp(before))) {
        throw Error('karambwan catch does not reconcile');
    }
    return caught;
}

async function knifeFishing(
    d: FishDriver,
    o: FishBatchOptions,
    state: () => BotWorldState,
    initial: BotWorldState,
    start: number,
) {
    const reset = FISH_KNIFE_RESET[o.method];
    const k = o.knife!;
    const profile = FISH_PROFILES[o.method];
    const outputs = new Set<number>(fishingOutputs(o.method));
    const products: readonly number[] = profile.products;
    if (!reset) throw Error(`no knife reset for fishing ${o.method}`);
    const send = d.send;
    const stand = d.stand;
    if (!send || !stand) throw Error('knife fishing needs send and stand');
    if (!knifeCut(initial.inventory, k.make1)) throw Error('knife fishing needs a knife and logs');
    const freeRequired = o.method === 'bigNet' ? 9 : 1;
    const bait0 = profile.bait ? stateItemCount(initial, profile.bait) : 0;
    let held = fishCount(initial, o.method);
    let seenXp = fishingStateXp(initial);
    let caught = 0;
    let dropped = 0;
    let cycles = 0;
    let stands = 0;
    let progress = start;
    let searches = 0;
    let missingSince = start;
    const cycleStats: Record<string, { cycles: number; catches: number }> = {};
    let lastLevel = initial.skills.find(s => s.name === 'Fishing')?.baseLevel ?? 0;
    const observe = (drops: number) => {
        const s = state();
        const now = fishCount(s, o.method);
        const x = fishingStateXp(s);
        if (now < held) dropped += Math.min(drops, held - now);
        if (x > seenXp) {
            caught += Math.max(0, now - held + drops);
            progress = d.tick();
        }
        held = now;
        seenXp = x;
        return s;
    };
    while (caught < o.amount && !(o.untilLevel && (state().skills.find(s => s.name === 'Fishing')?.level ?? 0) >= o.untilLevel)) {
        let s = state();
        if (d.tick() - progress >= o.progressTicks) throw Error('fishing no progress');
        if (profile.bait && stateItemCount(s, profile.bait) < 1) throw Error('fishing bait exhausted');
        const drop = k.drop ? s.inventory.find(i => outputs.has(i.id)) : undefined;
        if (!drop && 28 - s.inventory.length < freeRequired) throw Error('fishing pack capacity before next native roll');
        const spot = pickFishSpot(s, o.method, 15);
        if (!spot) {
            if (d.search) {
                if (searches >= 3 || !(await d.search(searches++, () => { state(); return false; }))) {
                    throw Error('fishing no compatible native spot after bounded search');
                }
            } else {
                if (d.tick() - missingSince >= Math.min(12, o.progressTicks)) throw Error('fishing no compatible native spot');
                await d.step();
            }
            observe(0);
            continue;
        }
        searches = 0;
        missingSince = d.tick();
        if (Math.abs(s.player!.worldX - spot.x) + Math.abs(s.player!.worldZ - spot.z) !== 1) {
            if (++stands > o.maxAttempts) throw Error('fishing dispatch limit');
            const t0 = d.tick();
            const dist = Math.max(Math.abs(s.player!.worldX - spot.x), Math.abs(s.player!.worldZ - spot.z));
            if (!(await stand(spot))) await d.step();
            observe(0);
            console.log(`FISH_STAND tick=${t0 - start} dist=${dist} ticks=${d.tick() - t0} sinceCatch=${t0 - progress}`);
            continue;
        }
        const cut = knifeCut(s.inventory, k.make1);
        if (!cut) throw Error('knife fishing needs a knife and logs');
        const drops: FishAction[] = drop ? [{ type: 'dropItem', slot: drop.slot }] : [];
        const n = drop && products.includes(drop.id) ? 1 : 0;
        const click: FishAction = { type: 'interactNpc', npcIndex: spot.index, optionIndex: profile.op };
        cycles++;
        const lv = s.skills.find(sk => sk.name === 'Fishing')?.baseLevel ?? 0;
        const x0 = fishingStateXp(s);
        const kind = lv > lastLevel ? 'levelUp' : 'steady';
        lastLevel = lv;
        const close: FishAction = { type: 'closeModal' };
        if (reset === 'same') {
            await send([...drops, ...cut, click, close]);
            await d.step();
            observe(n);
            await send([close]);
            await d.step();
            observe(0);
            await d.step();
        } else {
            await send(cut);
            await d.step();
            observe(0);
            await send([...drops, close]);
            await d.step();
            s = observe(n);
            if (s.nearbyNpcs.some(m => m.index === spot.index && m.x === spot.x && m.z === spot.z)) await send([click]);
            await d.step();
        }
        const e = observe(0);
        const moved = !e.nearbyNpcs.some(m => m.index === spot.index && m.x === spot.x && m.z === spot.z);
        const b = (cycleStats[moved ? 'moved' : kind] ??= { cycles: 0, catches: 0 });
        b.cycles++;
        if (fishingStateXp(e) > x0) b.catches++;
    }
    console.log(`FISH_CYCLES ${JSON.stringify(cycleStats)}`);
    const final = state();
    if (fishingStateXp(final) <= fishingStateXp(initial)) throw Error('fishing target unobserved');
    return {
        caught,
        baitUsed: profile.bait ? bait0 - stateItemCount(final, profile.bait) : 0,
        attempts: cycles,
        ticks: d.tick() - start,
        knife: { reset, dropped, stands },
    };
}

export interface FishBatchResult {
    caught: number;
    baitUsed: number;
    attempts: number;
    ticks: number;
    byproducts?: Record<number, number>;
    rawXp?: number;
    publicXpDelta?: number;
    knife?: { reset: FishReset; dropped: number; stands: number };
}

export function createFishingDriver(s: Session, stopped: () => boolean): FishDriver {
    return {
        state: () => s.sdk.getState(),
        tick: () => s.tick(),
        stopped,
        interact: (i, op) => s.sdk.sendInteractNpc(i, op),
        combine: (a, b) => s.sdk.sendUseItemOnItem(a, b),
        wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
        step: () => waitTicks(s, 1),
        closeDialog: () => s.direct({ type: 'closeModal', reason: 'SDK' }),
        send: async acts => {
            for (const a of acts) await s.direct({ ...a, reason: 'SDK' });
        },
        stand: async (spot: NearbyNpc) => {
            const p = s.sdk.getState()?.player;
            if (!p) return false;
            const tiles = [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
            ]
                .map(([dx, dz]) => ({ x: spot.x + dx!, z: spot.z + dz! }))
                .sort(
                    (a, b) =>
                        Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ)) -
                        Math.max(Math.abs(b.x - p.worldX), Math.abs(b.z - p.worldZ)),
                );
            for (const t of tiles) {
                const path = s.sdk.findPath(t.x, t.z);
                if (path.success && path.reachedDestination === true) {
                    return (await walkPath(await sessionWalker(s), [{ ...t, tol: 0 }], { maxTicks: 20, stop: stopped })).ok;
                }
            }
            return false;
        },
    };
}

export async function runStagedFishing(d: FishDriver, o: FishBatchOptions): Promise<FishBatchResult> {
    if (!FISH_PROFILES[o.method]) throw Error('unknown fishing method');
    for (const [k, n] of Object.entries(o)) {
        if (k !== 'method' && k !== 'knife' && (!Number.isSafeInteger(n) || Number(n) < 1)) throw Error(`invalid fishing ${k}`);
    }
    const xpRate = o.xpRate ?? 25;
    if (!Number.isSafeInteger(xpRate) || xpRate < 1 || xpRate > 1000) throw Error('invalid fishing XP rate');
    const initial = d.state();
    const profile = FISH_PROFILES[o.method];
    if (!initial?.player || fishingStateHp(initial) < 1) throw Error('fishing state unknown');
    if ((initial.skills.find(k => k.name === 'Fishing')?.level ?? 0) < profile.level) throw Error(`requires Fishing${profile.level}`);
    if (!stateItemCount(initial, profile.tool) && !(o.method === 'karambwan' && stateItemCount(initial, 3159))) {
        throw Error(`missing fishing tool ${profile.tool}`);
    }
    const freeRequired = o.method === 'bigNet' ? 9 : 1;
    if (28 - initial.inventory.length < freeRequired) throw Error('fishing requires free space for native roll');
    const start = d.tick();
    const base = fishCount(initial, o.method);
    let last = base;
    let progress = start;
    let attempts = 0;
    let baitUsed = 0;
    let active: number | undefined;
    let searches = 0;
    let missingSince = start;
    const originalLife = initial.player.lifeId;
    const originalPlane = initial.player.level;
    const originalRespawns = initial.player.respawnCount ?? 0;
    const originalHp = fishingStateHp(initial);
    const originalKit = protectedKit(initial, o.method);
    const initialXp = fishingStateXp(initial);
    let netRawXp = 0;
    const netByproducts: Record<number, number> = {};
    const state = () => {
        const s = d.state();
        if (!s?.player) throw Error('fishing session ended');
        if (d.stopped()) throw Error('fishing stopped');
        if (d.tick() - start >= o.cap) throw Error('fishing tick cap');
        if (
            s.player.level !== originalPlane ||
            s.player.lifeId !== originalLife ||
            (s.player.respawnCount ?? 0) !== originalRespawns ||
            fishingStateHp(s) !== originalHp ||
            s.player.isDead
        ) {
            throw Error('fishing health or plane changed');
        }
        if (protectedKit(s, o.method) !== originalKit) throw Error('fishing protected assets changed');
        return s;
    };
    if (o.knife) return knifeFishing(d, o, state, initial, start);
    while (last - base < o.amount) {
        let s = state();
        if (d.tick() - progress >= o.progressTicks) throw Error('fishing no progress');
        if (s.dialog?.isOpen || s.modalOpen) {
            active = undefined;
            const dialogTick = d.tick();
            if (d.closeDialog) {
                await d.closeDialog();
                await d.wait(
                    () => {
                        const now = state();
                        return !now.dialog?.isOpen && !now.modalOpen;
                    },
                    Math.min(2, Math.max(1, o.cap - (d.tick() - start))),
                );
            }
            if (d.tick() === dialogTick) await d.step();
            continue;
        }
        if (28 - s.inventory.length < freeRequired) throw Error('fishing pack capacity before next native roll');
        if (profile.bait && stateItemCount(s, profile.bait) < 1 && !(o.method === 'karambwan' && stateItemCount(s, 3159))) {
            throw Error('fishing bait exhausted');
        }
        const spot = pickFishSpot(s, o.method);
        if (!spot) {
            active = undefined;
            if (d.search) {
                if (searches >= 3 || !(await d.search(searches++, () => { state(); return false; }))) {
                    throw Error('fishing no compatible native spot after bounded search');
                }
                state();
            } else {
                if (d.tick() - missingSince >= Math.min(12, o.progressTicks)) throw Error('fishing no compatible native spot');
                await d.step();
            }
            continue;
        }
        searches = 0;
        missingSince = d.tick();
        if (o.method === 'karambwan') {
            if (attempts >= o.maxAttempts) throw Error('karambwan attempt limit');
            if (!stateItemCount(s, 3159)) {
                const vessel = s.inventory.find(i => i.id === 3157)!;
                const bait = s.inventory.find(i => i.id === 3150)!;
                if (bait.count !== 1) throw Error('native karambwanji must occupy single-item slots');
                if (!(await d.combine(vessel.slot, bait.slot)).success) throw Error('karambwan load refused');
                if (!(await d.wait(() => karambwanLoadEffect(s, state()), Math.min(8, o.cap - (d.tick() - start))))) {
                    throw Error('karambwan loading unobserved');
                }
                baitUsed++;
                s = state();
            }
            if (!(await d.interact(spot.index, profile.op)).success) throw Error('karambwan cast refused');
            attempts++;
            if (!(await d.wait(() => stateItemCount(state(), 3159) < stateItemCount(s, 3159), Math.min(20, o.cap - (d.tick() - start))))) {
                throw Error('karambwan attempt unobserved; check Lubufu vessel unlock');
            }
            karambwanAttemptEffect(s, state());
        } else if (o.method === 'bigNet') {
            const before = bigNetSnapshot(s);
            const began = d.tick();
            const x = spot.x;
            const z = spot.z;
            if (active !== spot.index) {
                if (++attempts > o.maxAttempts) throw Error('fishing dispatch limit');
                if (!(await d.interact(spot.index, profile.op)).success) throw Error('fishing action refused');
                active = spot.index;
            }
            await d.wait(() => {
                const now = state();
                return (
                    !!now.dialog?.isOpen ||
                    !!now.modalOpen ||
                    fishingOutputs('bigNet').some(id => stateItemCount(now, id) > (before.items[id] ?? 0)) ||
                    !now.nearbyNpcs.some(n => n.index === active && n.x === x && n.z === z)
                );
            }, Math.min(40, o.progressTicks - (d.tick() - progress), o.cap - (d.tick() - start)));
            const receipt = () =>
                bigNetReceipt(before, bigNetSnapshot(state()), netRawXp, initialXp, Math.max(1, Math.ceil((d.tick() - began) / 5)), xpRate);
            let effect = receipt();
            if (effect.kind === 'pending') {
                const nowState = state();
                if (nowState.dialog?.isOpen || nowState.modalOpen) {
                    active = undefined;
                    const dialogTick = d.tick();
                    if (d.closeDialog) {
                        await d.closeDialog();
                        await d.wait(
                            () => {
                                const now = state();
                                return !now.dialog?.isOpen && !now.modalOpen;
                            },
                            Math.min(2, Math.max(1, o.cap - (d.tick() - start))),
                        );
                    }
                    if (d.tick() === dialogTick) await d.step();
                    continue;
                }
                await d.wait(() => receipt().kind !== 'pending', Math.min(3, o.cap - (d.tick() - start)));
                effect = receipt();
            }
            if (effect.kind === 'invalid' || effect.kind === 'pending') throw Error('big-net whole-pack/native XP receipt unobserved');
            netRawXp += effect.rawXp;
            for (const [id, n] of Object.entries(effect.byproducts)) netByproducts[+id] = (netByproducts[+id] ?? 0) + n;
            if (!state().nearbyNpcs.some(n => n.index === active && n.x === x && n.z === z)) active = undefined;
        } else {
            if (active !== spot.index) {
                if (++attempts > o.maxAttempts) throw Error('fishing dispatch limit');
                if (!(await d.interact(spot.index, profile.op)).success) throw Error('fishing action refused');
                active = spot.index;
            }
            const before = s;
            const beforeBait = profile.bait ? stateItemCount(s, profile.bait) : 0;
            const beforeCatch = fishCount(s, o.method);
            const beforeXp = fishingStateXp(s);
            await d.wait(() => {
                const now = state();
                return (
                    !!now.dialog?.isOpen ||
                    !!now.modalOpen ||
                    fishCount(now, o.method) > last ||
                    !now.nearbyNpcs.some(n => n.index === active && n.x === spot.x && n.z === spot.z)
                );
            }, Math.min(40, o.progressTicks - (d.tick() - progress), o.cap - (d.tick() - start)));
            const after = state();
            const delta = fishCount(after, o.method) - (o.method === 'lava' ? beforeCatch : fishCount(before, o.method));
            const bait = profile.bait ? (o.method === 'lava' ? beforeBait : stateItemCount(before, profile.bait)) - stateItemCount(after, profile.bait) : 0;
            if (delta < 0 || (delta > 0 && fishingStateXp(after) <= (o.method === 'lava' ? beforeXp : fishingStateXp(before))) || bait < 0 || (profile.bait && bait !== delta)) {
                throw Error('fishing catch/bait does not reconcile');
            }
            if (o.method === 'lava' && fishingStateXp(after) - initialXp !== (fishCount(after, o.method) - base) * 60 * xpRate) {
                throw Error('lava eel native XP does not reconcile');
            }
            baitUsed += bait;
            if (!after.nearbyNpcs.some(n => n.index === active && n.x === spot.x && n.z === spot.z)) active = undefined;
        }
        const after = state();
        const previous = last;
        last = fishCount(after, o.method);
        if (last > (o.method === 'bigNet' || o.method === 'lava' ? previous : fishCount(s, o.method))) {
            progress = d.tick();
        }
        if (last - base < o.amount) {
            const pendingCatch = last;
            const pendingBait = profile.bait ? stateItemCount(after, profile.bait) : 0;
            const pendingXp = fishingStateXp(after);
            if (after.dialog?.isOpen || after.modalOpen) {
                active = undefined;
                const dialogTick = d.tick();
                if (d.closeDialog) {
                    await d.closeDialog();
                    await d.wait(
                        () => {
                            const now = state();
                            return !now.dialog?.isOpen && !now.modalOpen;
                        },
                        Math.min(2, Math.max(1, o.cap - (d.tick() - start))),
                    );
                }
                if (d.tick() === dialogTick) await d.step();
            } else {
                await d.step();
            }
            if (o.method !== 'bigNet' && o.method !== 'karambwan') {
                const next = state();
                const received = fishCount(next, o.method) - pendingCatch;
                const used = profile.bait ? pendingBait - stateItemCount(next, profile.bait) : 0;
                const gained = fishingStateXp(next) - pendingXp;
                if (
                    received < 0 ||
                    received > 1 ||
                    (profile.bait && used !== received) ||
                    (received === 0 && gained !== 0) ||
                    (received > 0 && gained <= 0) ||
                    (o.method === 'lava' && gained !== received * 60 * xpRate)
                ) {
                    throw Error('fishing step catch/bait/XP does not reconcile');
                }
                baitUsed += used;
                last += received;
                if (received) progress = d.tick();
            }
        }
    }
    const final = state();
    if (last - base < o.amount || fishingStateXp(final) <= initialXp) throw Error('fishing target unobserved');
    return {
        caught: last - base,
        baitUsed,
        attempts,
        ticks: d.tick() - start,
        ...(o.method === 'bigNet' ? { byproducts: netByproducts, rawXp: netRawXp, publicXpDelta: fishingStateXp(final) - initialXp } : {}),
    };
}

const MEMBERS_FISH_METHODS = new Set<FishMethod>(['bigNet', 'karambwanji', 'karambwan', 'lava']);
const CATHERBY_SHOP_TOOLS = new Set<number>([301, 303, 305, 307, 311, 313]);

export function fishingMethodRequirements(method: FishMethod) {
    const profile = FISH_PROFILES[method];
    return {
        method,
        level: profile.level,
        toolId: profile.tool,
        baitId: profile.bait,
        members: MEMBERS_FISH_METHODS.has(method),
        shop: CATHERBY_SHOP_TOOLS.has(profile.tool) ? ('fishingshop2' as const) : profile.tool === 309 ? ('fishingshop' as const) : null,
    };
}

export function bestFishingMethod(
    fishingLevel: number,
    stock: readonly { id: number; count: number }[],
    options: { members?: boolean; methods?: readonly FishMethod[]; requireTool?: boolean } = {},
) {
    const allowMembers = options.members !== false;
    const requireTool = options.requireTool !== false;
    const totals = new Map<number, number>();
    for (const row of stock) totals.set(row.id, (totals.get(row.id) ?? 0) + row.count);
    const has = (id: number) => (totals.get(id) ?? 0) > 0;
    const candidates = (options.methods ?? (Object.keys(FISH_PROFILES) as FishMethod[]))
        .map(fishingMethodRequirements)
        .filter(req => fishingLevel >= req.level && (allowMembers || !req.members))
        .sort((a, b) => b.level - a.level);

    for (const req of candidates) {
        const hasTool = has(req.toolId) || (req.method === 'karambwan' && has(3159));
        const hasBait = req.baitId === 0 || has(req.baitId) || (req.method === 'karambwan' && has(3159));
        if (!requireTool || (hasTool && hasBait)) {
            return { ...req, hasTool, hasBait };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// 2. Catherby Sharks, Lobsters & Swordfish/Tuna (`fishing:cage`, `fishing:harpoon`, `fishing:shark`)
// ---------------------------------------------------------------------------
export function sharkSpot(n: { id: number; name: string; optionsWithIndex: readonly { text: string; opIndex: number }[] }) {
    return (
        n.id === 322 &&
        /^fishing spot$/i.test(n.name) &&
        n.optionsWithIndex.some(o => o.opIndex === 1 && /^net$/i.test(o.text)) &&
        n.optionsWithIndex.some(o => o.opIndex === 3 && /^harpoon$/i.test(o.text))
    );
}

export function sharkFishingTrace(
    s: Session,
    emit: (row: unknown) => void = row => console.log('SHARK_FISH_TRACE ' + JSON.stringify(row)),
) {
    const key = (m: { observationId?: number; tick: number; type: number; text: string }) =>
        JSON.stringify([m.observationId ?? null, m.tick, m.type, m.text]);
    const seen = new Set<string>();
    const remember = (messages: { observationId?: number; tick: number; type: number; text: string }[]) => {
        for (const m of messages) if (m.type === 0) seen.add(key(m));
        while (seen.size > 500) seen.delete(seen.values().next().value!);
    };
    const npc = (n: NearbyNpc) => ({
        index: n.index,
        id: n.id,
        name: n.name,
        x: n.x,
        z: n.z,
        tileX: n.tileX ?? null,
        tileZ: n.tileZ ?? null,
        distance: n.distance,
        reachable: n.reachable ?? null,
        options: n.optionsWithIndex.map(o => ({ ...o })),
    });
    let selected: ReturnType<typeof npc> | undefined;
    let failed = false;
    const traceFailed = (error: unknown) => {
        if (failed) return;
        failed = true;
        try {
            console.warn('SHARK_FISH_TRACE_ERROR ' + String(error));
        } catch {}
    };
    try {
        remember(s.sdk.getState()?.gameMessages ?? []);
    } catch (error) {
        traceFailed(error);
    }
    const record = (event: string, detail?: unknown) => {
        if (failed) return;
        try {
            const st = s.sdk.getState();
            const p = st?.player;
            const messages = (st?.gameMessages ?? [])
                .filter(m => !seen.has(key(m)) && m.type === 0)
                .map(m => ({ tick: m.tick, observationId: m.observationId ?? null, text: m.text }));
            remember(st?.gameMessages ?? []);
            const fishing = s.sdk.getSkill('Fishing');
            emit({
                event,
                at: Date.now(),
                tick: s.tick(),
                stateTick: st?.tick ?? null,
                revision: st?.revision ?? null,
                stateAgeMs: s.sdk.getStateAge?.() ?? null,
                account: s.name,
                player: p ? { name: p.name, x: p.worldX, z: p.worldZ, level: p.level, hp: p.hp, animId: p.animId, spotanimId: p.spotanimId } : null,
                selected: selected ?? null,
                currentSelected: st?.nearbyNpcs.find(n => n.index === selected?.index)
                    ? npc(st.nearbyNpcs.find(n => n.index === selected?.index)!)
                    : null,
                candidates: (st?.nearbyNpcs ?? []).filter(sharkSpot).map(npc),
                rawSharks: s.sdk.getInventory().filter(i => i.id === 383).reduce((n, i) => n + i.count, 0),
                slots: s.sdk.getInventory().length,
                harpoons: s.sdk.getInventory().filter(i => i.id === 311).reduce((n, i) => n + i.count, 0),
                fishing: fishing ? { level: fishing.level, baseLevel: fishing.baseLevel, xp: fishing.experience } : null,
                opFeedback: st?.opFeedback ? { ...st.opFeedback } : null,
                dialog: st?.dialog ? { isOpen: st.dialog.isOpen } : null,
                actionSettlement: 'unknown',
                messages,
                detail: detail ?? null,
            });
        } catch (error) {
            traceFailed(error);
        }
    };
    return {
        record,
        select(n: NearbyNpc) {
            if (!failed) {
                try {
                    selected = npc(n);
                } catch (error) {
                    traceFailed(error);
                }
            }
        },
    };
}

const SHARK_START = /^You start Harpooning fish\.$/;
const messageKey = (m: { observationId?: number; tick: number; type: number; text: string }) =>
    JSON.stringify([m.observationId ?? null, m.tick, m.type, m.text]);

export const SHARK_HARPOON_ANIM = 618;
export const SHARK_IDLE_TICKS = 7;
export const SHARK_START_REFUSALS = 3;
export const SHARK_PROGRESS_TICKS = 420;

export async function catchSharks(s: Session, amount: number, stop: () => boolean, progressTicks = SHARK_PROGRESS_TICKS) {
    const count = () => s.sdk.getInventory().filter(i => i.id === 383).reduce((n, i) => n + i.count, 0);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 27) throw Error('invalid shark batch');
    if ((s.sdk.getSkill('Fishing')?.level ?? 0) < 76) throw Error('sharks require Fishing76');
    if (!s.sdk.getInventory().some(i => i.id === 311)) throw Error('sharks require harpoon');
    const before = count();
    let last = before;
    let progress = s.tick();
    let active: { index: number; x: number; z: number; at: number } | undefined;
    let refusals = 0;
    const same = (n: NearbyNpc, a: { index: number; x: number; z: number }) => n.index === a.index && n.x === a.x && n.z === a.z && sharkSpot(n);
    const trace = sharkFishingTrace(s);
    trace.record('begin', { amount, before, progressTicks, idleTicks: SHARK_IDLE_TICKS });
    let still = 0;
    const offStill = s.onTick(() => {
        still = s.sdk.getState()?.player?.animId === SHARK_HARPOON_ANIM ? 0 : still + 1;
    });
    const off = s.onTick(() => trace.record('tick'));
    try {
        while (count() - before < amount) {
            if (stop()) throw Error('shark fishing budget/health stop');
            if (s.sdk.getInventory().length >= 28) throw Error('shark fishing full pack');
            if (s.tick() - progress >= progressTicks) throw Error('shark fishing no progress');
            const npcs = s.sdk.getState()?.nearbyNpcs ?? [];
            const until = (end: number) => Math.max(1, Math.min(end, progress + progressTicks) - s.tick());
            if (s.sdk.getState()?.dialog?.isOpen) {
                await s.sdk.sendCloseModal?.();
                active = undefined;
            }
            if (active) {
                const a = active;
                if (!npcs.some(n => same(n, a))) {
                    trace.record('spot-lost', a);
                    active = undefined;
                    continue;
                }
                await waitUntil(
                    s,
                    st =>
                        stop() ||
                        count() > last ||
                        still >= SHARK_IDLE_TICKS ||
                        !!st.dialog?.isOpen ||
                        !st.nearbyNpcs.some((n: NearbyNpc) => same(n, a)),
                    {
                        timeoutTicks: until(progress + progressTicks),
                    },
                );
                if (count() > last) {
                    last = count();
                    progress = s.tick();
                    a.at = s.tick();
                } else if (s.sdk.getState()?.dialog?.isOpen) {
                    await s.sdk.sendCloseModal?.();
                    active = undefined;
                } else if (still >= SHARK_IDLE_TICKS) {
                    trace.record('action-ended', { ...a, still });
                    active = undefined;
                }
                continue;
            }
            const reachableSpots = npcs.filter(n => sharkSpot(n) && n.reachable !== false);
            const spot = (reachableSpots.length ? reachableSpots : npcs.filter(sharkSpot)).sort((a, b) => a.distance - b.distance)[0];
            if (!spot) {
                await waitTicks(s, 1);
                continue;
            }
            const x = spot.x;
            const z = spot.z;
            const seen = new Set((s.sdk.getState()?.gameMessages ?? []).map(messageKey));
            const started = () => (s.sdk.getState()?.gameMessages ?? []).some(m => m.type === 0 && SHARK_START.test(m.text) && !seen.has(messageKey(m)));
            trace.select(spot);
            trace.record('dispatch', { option: 3, last, progress, refusals });
            const reply = await s.sdk.sendInteractNpc(spot.index, 3);
            trace.record('dispatch-reply', reply);
            await waitUntil(s, st => stop() || started() || !st.nearbyNpcs.some((n: NearbyNpc) => same(n, { index: spot.index, x, z })), {
                timeoutTicks: until(s.tick() + 8 + Math.min(20, Math.ceil(spot.distance))),
            });
            const moved = !(s.sdk.getState()?.nearbyNpcs ?? []).some(n => same(n, { index: spot.index, x, z }));
            if (count() > last) {
                last = count();
                progress = s.tick();
                refusals = 0;
            }
            if (started() && !moved) {
                active = { index: spot.index, x, z, at: s.tick() };
                still = 0;
                refusals = 0;
                trace.record('started', active);
            } else if (!moved && !stop() && ++refusals >= SHARK_START_REFUSALS) {
                throw Error('shark fishing dispatch refused');
            } else {
                trace.record('unstarted', { moved, refusals });
            }
        }
        trace.record('complete', { caught: count() - before });
        return { caught: count() - before };
    } catch (error) {
        trace.record('failure', { cause: String(error), caught: count() - before, last, progress, progressTicks });
        throw error;
    } finally {
        off();
        offStill();
    }
}

const CATHERBY_BANK = { x: 2809, z: 3441 };
const BEACH_SPOT = { x: 2838, z: 3432 };

import { executeShopToolPurchase, sessionToolHooks } from './tools';

export async function ensureCatherbyFishingTool(
    s: Session,
    options: {
        toolId: number;
        maxCost?: number;
        coinReserve?: number;
        bankSpot?: { x: number; z: number; level?: number };
        walkTo: (spot: { x: number; z: number; level?: number }) => Promise<boolean>;
        openBank: () => Promise<unknown>;
        stop: () => boolean;
    },
): Promise<{ ok: boolean; bought: boolean; coinsSpent: number; reason?: string }> {
    const heldTool = () => s.sdk.getInventory().some(i => i.id === options.toolId);
    if (heldTool()) return { ok: true, bought: false, coinsSpent: 0 };

    await options.openBank();
    if (!(await waitUntil(s, () => options.stop() || !!s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 10 })) || options.stop()) {
        return { ok: false, bought: false, coinsSpent: 0, reason: 'bank unavailable' };
    }
    const bankItem = s.sdk.getState()?.bank?.items.find(i => i.id === options.toolId && i.count > 0);
    if (bankItem) {
        await s.bot.withdrawItem(bankItem, 1, { asNote: false });
        if ((await waitUntil(s, () => options.stop() || heldTool(), { timeoutTicks: 8 })) && heldTool()) {
            return { ok: true, bought: false, coinsSpent: 0 };
        }
    }

    const maxCost = options.maxCost ?? 50;
    const reserve = options.coinReserve ?? 0;
    const bankSpot = options.bankSpot ?? CATHERBY_BANK;
    const hooks = sessionToolHooks(s, {
        openBank: options.openBank,
        walkTo: options.walkTo,
        waitUntil: (pred, timeoutTicks) => waitUntil(s, pred, { timeoutTicks }),
        stop: options.stop,
    });
    const res = await executeShopToolPurchase(hooks, {
        targetId: options.toolId,
        shop: 'fishingshop2',
        maxBudget: maxCost + reserve,
        coinReserve: reserve,
        returnBankSpot: bankSpot,
    });
    if (!res.bought) {
        return { ok: false, bought: false, coinsSpent: 0, reason: res.reason };
    }
    await options.openBank();
    if ((await waitUntil(s, () => options.stop() || !!s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 10 })) && !options.stop()) {
        const spareCoins = s.sdk.getInventory().find(i => i.id === 995);
        if (spareCoins) await depositObserved(s, spareCoins);
    }
    return { ok: heldTool(), bought: true, coinsSpent: res.coinsSpent };
}

export async function runCatherbyGatherFish(s: Session, cfg: NormalizedGatherConfig, stop: () => boolean): Promise<GatherOutcome> {
    const method = (cfg.method === 'harpoon' ? 'harpoon' : 'cage').toLowerCase();
    const offset = /^(cage|harpoon)$/i.test(cfg.args[0] ?? '') ? 1 : 0;
    const cap = cfg.target?.capTicks ?? Number(cfg.args[offset] ?? resolveSetting(cfg, 'CAP') ?? 15000);
    const bankAt = Number(cfg.args[offset + 1] ?? resolveSetting(cfg, 'BANK_AT') ?? 27);
    const isCage = method === 'cage';
    const requiredTool = isCage ? /lobster pot/i : /harpoon/i;
    const targetOp = isCage ? 'Cage' : 'Harpoon';

    await waitUntil(s, st => (st?.inGame ?? false) && st?.player !== null && (st?.inventory?.length ?? 0) > 0, { timeoutTicks: 10 });

    const pos = () => s.sdk.getState()?.player;
    const inv = () => s.sdk.getInventory();
    const countFish = () => inv().filter(i => /raw (lobster|swordfish|tuna)/i.test(i.name)).reduce((n, i) => n + i.count, 0);
    const freeSpace = () => 28 - inv().length;
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => stop() || used() >= cap;

    let caughtTotal = 0;
    let bankTrips = 0;
    let walkTicks = 0;

    let cachedWalker: ReturnType<typeof sessionWalker> | undefined;
    const walk = async (x: number, z: number, tol = 2): Promise<boolean> => {
        const a = s.tick();
        const p0 = pos();
        if (p0 && (p0.level !== 0 || Math.max(Math.abs(p0.worldX - x), Math.abs(p0.worldZ - z)) > 40)) {
            const routed = await goTo(s, await getWorld(), { x, z, level: 0 }, accountOf(s), { legTimeoutTicks: 120 });
            walkTicks += s.tick() - a;
            if (!routed.ok) {
                const detail = routed.detail ?? 'unreachable';
                console.log(`WALK fail ${detail} ticks=${routed.ticks}`);
                if (/walk danger|no route|no path/i.test(detail)) throw Error(`gather-fish travel failed: ${detail}`);
                return false;
            }
            const p = pos();
            return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol + 2;
        }
        const walker = await (cachedWalker ??= sessionWalker(s));
        for (let i = 0; i < 3 && !over(); i++) {
            const p = pos();
            if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
            const r = await walkPath(walker, [{ x, z, tol }], { stop: over });
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                if (/walk danger|no path/i.test(r.detail ?? '')) throw Error(`gather-fish walk refused: ${r.detail}`);
                await waitTicks(s, 1);
            }
        }
        walkTicks += s.tick() - a;
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };

    let consecutiveBankFails = 0;
    const bank = async () => {
        const reached = await walk(CATHERBY_BANK.x, CATHERBY_BANK.z, 2);
        if (!reached) {
            if (++consecutiveBankFails >= 2) throw Error(`gather-fish bank unreachable from ${pos()?.worldX},${pos()?.worldZ}`);
            return;
        }
        const b = await s.bot.openBank();
        if (!b.success) {
            console.log(`WARN openBank failed: ${b.message}`);
            if (++consecutiveBankFails >= 3) throw Error(`gather-fish openBank failed: ${b.message}`);
            await waitTicks(s, 1);
            return;
        }
        consecutiveBankFails = 0;
        const currentFish = countFish();
        if (currentFish > 0) {
            for (const item of inv()) {
                if (/raw (lobster|swordfish|tuna)/i.test(item.name)) {
                    await s.bot.depositItem(item.name, -1);
                }
            }
            if (countFish() >= currentFish) await waitUntil(s, () => over() || countFish() < currentFish, { timeoutTicks: 3 });
        }
        if (!inv().some(i => requiredTool.test(i.name))) {
            const toolId = isCage ? 301 : 311;
            const toolName = isCage ? 'Lobster pot' : 'Harpoon';
            const ensured = await ensureCatherbyFishingTool(s, {
                toolId,
                maxCost: 50,
                bankSpot: CATHERBY_BANK,
                walkTo: async spot => walk(spot.x, spot.z, 2),
                openBank: () => s.bot.openBank(),
                stop: over,
            });
            if (!ensured.ok || !inv().some(i => requiredTool.test(i.name))) {
                throw Error(`no ${toolName} in the pack, bank, or Harry's shop (${ensured.reason ?? 'unavailable'})`);
            }
        }
        // Count only the fish that left the pack; a refused deposit keeps them in countFish().
        caughtTotal += Math.max(0, currentFish - countFish());
        await s.bot.closeInterface();
        bankTrips++;
        console.log(`MILESTONE bank t=${used()} caughtTotal=${caughtTotal} bankTrips=${bankTrips}`);
    };

    console.log(`START gather-fish ${s.name} method=${method} at=${pos()?.worldX},${pos()?.worldZ}`);
    let activeSpot: { index: number; x: number; z: number } | undefined;
    while (!over()) {
        if (countFish() >= bankAt || freeSpace() === 0 || !inv().some(i => requiredTool.test(i.name))) {
            activeSpot = undefined;
            await bank();
            continue;
        }
        const p = pos();
        if (!p || Math.max(Math.abs(p.worldX - BEACH_SPOT.x), Math.abs(p.worldZ - BEACH_SPOT.z)) > 12) {
            activeSpot = undefined;
            await walk(BEACH_SPOT.x, BEACH_SPOT.z, 3);
            continue;
        }
        const stNow = s.sdk.getState();
        if (stNow?.dialog?.isOpen) {
            await s.sdk.sendCloseModal?.();
            activeSpot = undefined;
        }
        const npcs = stNow?.nearbyNpcs ?? [];
        const sameActive = activeSpot && npcs.find(n => n.index === activeSpot!.index && n.x === activeSpot!.x && n.z === activeSpot!.z && n.options.includes(targetOp));
        const spot = sameActive ?? npcs
            .filter(n => /fishing spot/i.test(n.name) && n.options.includes(targetOp) && n.reachable !== false)
            .sort((a, b) => a.distance - b.distance)[0]
            ?? npcs.find(n => /fishing spot/i.test(n.name) && n.options.includes(targetOp));
        if (!spot) {
            activeSpot = undefined;
            await waitTicks(s, 1);
            continue;
        }
        const invBefore = inv().length;
        const opt = spot.optionsWithIndex.find(o => new RegExp(`^${targetOp}$`, 'i').test(o.text));
        if (!opt) {
            activeSpot = undefined;
            await waitTicks(s, 1);
            continue;
        }
        if (!sameActive) {
            await s.sdk.sendInteractNpc(spot.index, opt.opIndex);
            activeSpot = { index: spot.index, x: spot.x, z: spot.z };
        }
        let idleStreak = 0;
        await waitUntil(
            s,
            st => {
                if (over() || inv().length > invBefore || freeSpace() === 0 || !!st.dialog?.isOpen) return true;
                if (!st.nearbyNpcs.some((n: NearbyNpc) => n.index === spot.index && n.x === spot.x && n.z === spot.z)) {
                    activeSpot = undefined;
                    return true;
                }
                const anim = st.player?.animId ?? -1;
                if (anim !== -1) idleStreak = 0;
                else if (++idleStreak >= (spot.distance <= 1 ? 3 : 6)) {
                    activeSpot = undefined;
                    return true;
                }
                return false;
            },
            { timeoutTicks: 40 },
        );
    }

    const total = caughtTotal + countFish();
    const perK = ((total * 1000) / Math.max(1, used())).toFixed(2);
    const line = `ticks=${used()} totalCaught=${total} banked=${caughtTotal} held=${countFish()} bankTrips=${bankTrips} fishPer1kTicks=${perK}`;
    return {
        ok: total > 0,
        kind: total > 0 ? 'completed' : 'failed',
        detail: line,
        delta: { elapsedTicks: used() },
        recoverable: total <= 0,
        summary: { totalCaught: total, banked: caughtTotal, held: countFish(), bankTrips, walkTicks, ticks: used() },
        resultLine: line,
    };
}

// ---------------------------------------------------------------------------
// 3. Finite Cooked-Shark Order (`fishing:shark`)
// ---------------------------------------------------------------------------
type Row = { id: number; count: number };

export function sharkOrderConfig(args: readonly string[], env: Record<string, string | undefined>) {
    return {
        target: Number(args[0] ?? env.MAX_COOKED ?? env.SHARK_COUNT ?? 25),
        maxTicks: Number(args[1] ?? env.CAP ?? 9000),
        consumer: env.SHARK_CONSUMER ?? 'high-HP endgame combat staging',
        rawOnly: env.RAW_ONLY === '1' || env.SHARK_RAW_ONLY === '1',
    };
}

/** The shark order a run executes: cfg.target overrides the args and env values. */
export function effectiveSharkOrder(cfg: Pick<NormalizedGatherConfig, 'args' | 'env' | 'target'>) {
    const o = sharkOrderConfig(cfg.args, cfg.env);
    return { target: cfg.target?.count ?? o.target, maxTicks: cfg.target?.capTicks ?? o.maxTicks, consumer: o.consumer, rawOnly: o.rawOnly };
}

export function sharkOrderProblem(o: { target: number; maxTicks: number; consumer: string }): string | undefined {
    if (!Number.isSafeInteger(o.target) || o.target < 1 || o.target > 100 || !Number.isSafeInteger(o.maxTicks) || o.maxTicks < 1 || !o.consumer.trim()) {
        return 'invalid finite shark order/consumer';
    }
    return undefined;
}

export function sharkSummary(r: { banked: number; caught: number; cooked: number; burnt: number; coinsSpent: number; ticks: number }) {
    return `newBankedSharks=${r.banked} caught=${r.caught} cooked=${r.cooked} burnt=${r.burnt} coinsSpent=${r.coinsSpent} ticks=${r.ticks} detail=${JSON.stringify(r)}`;
}

export const SHARK_ORDER_DIR = resolve(ROOT, '.practice/shark-orders');

export function claimSharkOrder(
    dir: string,
    account: string,
    key: string,
    order: { target: number; maxTicks: number; consumer: string },
    now = Date.now(),
) {
    return claimOrderJournal(dir, account, key, order, now, 'shark order');
}

export function settleSharkOrder(
    path: string,
    r: { ok: boolean; banked: number; caught: number; cooked: number; burnt: number; failure: string },
    now = Date.now(),
) {
    settleOrderJournal(path, r, ({ banked, caught, cooked, burnt, failure }) => ({ banked, caught, cooked, burnt, failure }), now, 'shark order');
}

export const SHARK_BANK = { x: 2809, z: 3441 };
export const WEST_BANK = { x: 2619, z: 3332 };
const d8 = (a: PathTile, b: PathTile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
export const sharkCorridor = (p: PathTile) => p.x >= 2600 && p.x <= 2865 && p.z >= 3320 && p.z <= 3460;

export function sharkRoutePlan(level: number, from: PathTile, to: PathPoint, path: PathTile[]) {
    const end = path.at(-1) ?? from;
    if (level !== 0 || !sharkCorridor(from) || !path.every(sharkCorridor) || d8(end, to) > (to.tol ?? 2)) {
        throw Error('unsafe/incomplete shark route');
    }
    return path;
}

export function guardSharkRoute(deps: PathDeps, stop: () => boolean): PathDeps {
    const send = deps.walk.bind(deps);
    const plan = deps.plan.bind(deps);
    deps.plan = (level, from, to) => sharkRoutePlan(level, from, to, plan(level, from, to));
    deps.walk = (x, z) => {
        if (stop() || !sharkCorridor({ x, z })) throw Error('shark route stopped');
        return send(x, z);
    };
    return deps;
}

export function sharkEntry(p: { worldX: number; worldZ: number; level: number } | null | undefined) {
    if (!p || p.level !== 0) return null;
    if (Math.max(Math.abs(p.worldX - WEST_BANK.x), Math.abs(p.worldZ - WEST_BANK.z)) <= 8) return 'west-bank';
    if (p.worldX >= 2800 && p.worldX <= 2865 && p.worldZ >= 3420 && p.worldZ <= 3450) return 'catherby';
    return null;
}

export function sharkAssets(rows: readonly Row[]) {
    const out: Record<number, number> = {};
    for (const i of rows) out[i.id] = (out[i.id] ?? 0) + i.count;
    return out;
}

export function sharkAssetCheck(
    before: Record<number, number>,
    after: Record<number, number>,
    r: { caught: number; cooked: number; burnt: number; coinsSpent: number; toolBought: number; consumed: Record<number, number> },
) {
    const delta: Record<number, number> = {
        383: r.caught - r.cooked - r.burnt,
        385: r.cooked,
        387: r.burnt,
        995: -r.coinsSpent,
        311: r.toolBought,
    };
    for (const [id, n] of Object.entries(r.consumed)) delta[Number(id)] = (delta[Number(id)] ?? 0) - n;
    return [...new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(delta)])].every(k => {
        const id = Number(k);
        return (after[id] ?? 0) - (before[id] ?? 0) === (delta[id] ?? 0);
    });
}

export function fishingToolPurchase(price: number, stock: number, cash: number, maxCost = 200, reserve = 1000) {
    return Number.isSafeInteger(price) && price > 0 && price <= maxCost && Number.isSafeInteger(stock) && stock > 0 && cash - price >= reserve;
}

export function harpoonPurchase(price: number, stock: number, cash: number, maxCost = 200, reserve = 1000) {
    return fishingToolPurchase(price, stock, cash, maxCost, reserve);
}

export const SHARK_TRAVEL_FOOD_IDS = [333, 329, 379, 373, 385] as const;

export type SharkOptions = {
    target: number;
    maxTicks: number;
    consumer: string;
    rawOnly?: boolean;
    stop?: () => boolean;
    recoveryTicks?: number;
    walker?: (s: Session) => Promise<PathDeps>;
    cookSharks?: GatherExternalDeps['cookSharks'];
};

export async function supplySharks(s: Session, o: SharkOptions) {
    const problem = sharkOrderProblem(o);
    if (problem) throw Error(problem);
    const start = s.tick();
    const state = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const r = {
        ok: false,
        target: o.target,
        consumer: o.consumer,
        caught: 0,
        cooked: 0,
        burnt: 0,
        banked: 0,
        coinsSpent: 0,
        toolBought: 0,
        consumed: {} as Record<number, number>,
        hpStart: hp(),
        hpMin: hp(),
        died: false,
        damage: 0,
        ticks: 0,
        atBank: false,
        assets: false,
        recovery: 'not-needed',
        failure: '',
        unbanked: {} as Record<number, number>,
    };
    let initial: Record<number, number> | undefined;
    let first: any;
    let ended = false;
    let damageBase = hp();
    let lastHp = hp();
    let ready = false;
    let deadline = start + o.maxTicks;
    const safety = () => {
        const p = state()?.player;
        const h = hp();
        r.hpMin = Math.min(r.hpMin, h);
        r.damage += Math.max(0, lastHp - h);
        lastHp = h;
        r.died ||= (!!first && sessionDied(first, p)) || h <= 0;
        return ended || r.died || !p || p.level !== 0 || h < Math.max(20, damageBase - 12) || r.damage > 12;
    };
    const stop = () => safety() || s.tick() >= deadline || !!o.stop?.();
    void s.ended.then(() => {
        ended = true;
    });
    const off = s.onTick(() => {
        if (ready) safety();
    });
    const observe = () => s.bankObservation?.();
    const open = async () => {
        const generation = observe()?.generation ?? -1;
        if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!observe() && observe()!.generation > generation, { timeoutTicks: 15 }))) {
            throw Error('fresh shark bank unavailable');
        }
        return observe()!;
    };
    const assets = () => sharkAssets([...inv(), ...s.sdk.getEquipment(), ...(observe()?.items ?? [])]);
    const walk = async (points: { x: number; z: number; tol?: number }[]) => {
        if (stop()) throw Error('shark route budget/health stop');
        const deps = guardSharkRoute(await (o.walker ?? sessionWalker)(s), stop);
        const result = await walkPath(deps, points, { maxTicks: Math.max(1, Math.min(700, deadline - s.tick())), stop });
        const p = state()?.player;
        const end = points.at(-1)!;
        if (!result.ok || stop() || !p || Math.max(Math.abs(p.worldX - end.x), Math.abs(p.worldZ - end.z)) > (end.tol ?? 2)) {
            throw Error(`shark route failed ${result.detail}`);
        }
    };
    const withdraw = async (id: number, name: RegExp, amount: number) => {
        const b = observe();
        if (!b) throw Error('withdraw bank unknown');
        const bankBefore = b.items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        const packBefore = held(id);
        const gen = b.generation;
        if (bankBefore < amount) throw Error(`missing owned stock ${id}`);
        await s.bot.withdrawItem(name, amount);
        if (
            !(await waitUntil(
                s,
                () =>
                    held(id) === packBefore + amount &&
                    (observe()?.generation ?? 0) > gen &&
                    observe()!.items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0) === bankBefore - amount,
                { timeoutTicks: 12 },
            ))
        ) {
            throw Error(`withdraw mismatch ${id}`);
        }
    };
    const store = async (all = false, count = !all) => {
        const creditId = o.rawOnly ? 383 : 385;
        for (const item of [...new Map(inv().map(i => [i.id, i])).values()]) {
            if (all || [383, 385, 387].includes(item.id)) {
                const n = await depositObserved(s, item);
                if (count && item.id === creditId) r.banked += n;
            }
        }
    };
    const returnBank = async () => {
        await s.bot.closeInterface();
        await walk([{ ...SHARK_BANK, tol: 2 }]);
        await open();
        await store();
        r.atBank = true;
    };
    try {
        if (!(await waitUntil(s, st => !!st?.inGame && !!st.player && hp() > 0 && Array.isArray(st.equipment), { timeoutTicks: 20 }))) {
            throw Error('shark entry state deadline');
        }
        first = { ...state()!.player! };
        r.hpStart = hp();
        r.hpMin = hp();
        lastHp = hp();
        damageBase = hp();
        ready = true;
        // Verify skill and HP prerequisites before travelling across the map to Catherby.
        if ((s.sdk.getSkill('Fishing')?.level ?? 0) < 76 || (!o.rawOnly && (s.sdk.getSkill('Cooking')?.level ?? 0) < 80)) {
            throw Error(o.rawOnly ? 'shark order requires Fishing76' : 'shark order requires Fishing76 Cooking80');
        }
        const preMaxHp = s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0;
        if (preMaxHp < 40) throw Error('shark entry needs at least40 base HP');
        if (!sharkEntry(first)) {
            const there = await goTo(s, await getWorld(), { x: SHARK_BANK.x, z: SHARK_BANK.z, level: 0 }, accountOf(s), { legTimeoutTicks: 100 });
            if (!there.ok) throw Error(`shark travel to Catherby failed: ${there.detail}`);
            first = { ...state()!.player! };
        }
        const entry = sharkEntry(first);
        if (!entry) throw Error('shark entry requires west bank or Catherby ground floor');
        await open();
        initial = assets();
        await store(true);
        const maxHp = s.sdk.getSkill('Hitpoints')!.baseLevel;
        if (maxHp < 40) throw Error('shark entry needs at least40 base HP');
        let healsUsed = 0;
        while (hp() < maxHp - 3 && healsUsed < 12) {
            if (stop()) throw Error('shark entry budget/health stop');
            const food = observe()?.items.find(i => (SHARK_TRAVEL_FOOD_IDS as readonly number[]).includes(i.id) && i.count > 0);
            if (!food) throw Error('missing owned travel food');
            const healEst = food.id === 385 ? 20 : food.id === 373 ? 14 : food.id === 379 ? 12 : food.id === 329 ? 9 : 7;
            const want = Math.max(1, Math.min(12 - healsUsed, Math.ceil((maxHp - 3 - hp()) / healEst), food.count, 28 - inv().length));
            await withdraw(food.id, new RegExp(`^${food.name}$`, 'i'), want);
            await s.bot.closeInterface();
            for (let k = 0; k < want && hp() < maxHp - 3 && healsUsed < 12; k++) {
                if (stop()) throw Error('shark entry budget/health stop');
                const item = inv().find(i => i.id === food.id);
                if (!item) break;
                const before = held(food.id);
                const h = hp();
                await s.bot.eatFood(item);
                if (!(await waitUntil(s, () => held(food.id) === before - 1 && hp() > h, { timeoutTicks: 8 }))) {
                    throw Error('travel food debit/heal unobserved');
                }
                r.consumed[food.id] = (r.consumed[food.id] ?? 0) + 1;
                healsUsed++;
            }
            await open();
            if (held(food.id) > 0) await store(true);
        }
        if (hp() < maxHp - 3) throw Error('entry heal budget exhausted');
        damageBase = hp();
        lastHp = hp();
        if ((observe()?.items.find(i => i.id === 311)?.count ?? 0) > 0) await withdraw(311, /^harpoon$/i, 1);
        const travel = observe()?.items.find(i => (SHARK_TRAVEL_FOOD_IDS as readonly number[]).includes(i.id) && i.count >= 2);
        if (!travel) throw Error('missing return food reserve');
        await withdraw(travel.id, new RegExp(`^${travel.name}$`, 'i'), 2);
        if (!held(311)) {
            const cash = observe()?.items.find(i => i.id === 995)?.count ?? 0;
            if (cash < 1200) throw Error('harpoon requires200 budget and1000 reserve');
            await withdraw(995, /^coins$/i, 1200);
        }
        await s.bot.closeInterface();
        if (entry === 'west-bank') {
            await walk([
                { x: 2618, z: 3355, tol: 2 },
                { x: 2645, z: 3385, tol: 2 },
                { x: 2680, z: 3405, tol: 2 },
                { x: 2725, z: 3425, tol: 2 },
                { x: 2770, z: 3445, tol: 2 },
                { ...SHARK_BANK, tol: 2 },
            ]);
        }
        if (!held(311)) {
            await walk([{ x: 2834, z: 3445, tol: 2 }]);
            if (!(await s.bot.openShop(/^Harry$/i)).success) throw Error('Harry shop unavailable');
            const tool = state()?.shop.shopItems.find(i => i.id === 311);
            if (!tool || !harpoonPurchase(tool.buyPrice, tool.count, held(995))) throw Error('harpoon stock/price/reserve refused');
            const cash = held(995);
            const price = tool.buyPrice;
            await s.bot.buyFromShop(tool, 1);
            if (!(await waitUntil(s, () => held(311) === 1 && held(995) < cash, { timeoutTicks: 10 }))) {
                throw Error('harpoon purchase unobserved');
            }
            r.coinsSpent = cash - held(995);
            r.toolBought = 1;
            if (r.coinsSpent !== price || r.coinsSpent > 200 || held(995) < 1000) throw Error('harpoon purchase cost mismatch');
            await s.bot.closeShop();
        }
        await returnBank();
        const cash = inv().find(i => i.id === 995);
        if (cash) await depositObserved(s, cash);
        await s.bot.closeInterface();
        while (r.banked < o.target) {
            if (stop()) throw Error('shark order budget/health stop');
            r.atBank = false;
            const amount = Math.min(o.target - r.banked, 28 - inv().length);
            if (amount < 1) throw Error('shark full pack');
            await walk([{ x: 2845, z: 3431, tol: 2 }]);
            const rawBefore = held(383);
            try {
                await catchSharks(s, amount, stop);
                if (!o.rawOnly) await walk([{ x: 2816, z: 3443, tol: 1 }]);
            } finally {
                r.caught += held(383) - rawBefore;
            }
            if (!o.rawOnly) {
                const cookedBefore = held(385);
                const burntBefore = held(387);
                try {
                    if (!o.cookSharks) throw Error('supplySharks requires deps.cookSharks');
                    await o.cookSharks(s, stop);
                } finally {
                    r.cooked += held(385) - cookedBefore;
                    r.burnt += held(387) - burntBefore;
                }
            }
            await returnBank();
            if (r.banked < o.target) await s.bot.closeInterface();
            console.log('SHARK_PROGRESS ' + JSON.stringify(r));
        }
        if (!state()?.bank?.isOpen) await open();
        r.assets = sharkAssetCheck(initial, assets(), r);
        r.ok = o.rawOnly
            ? r.banked === o.target && r.caught === r.banked && r.cooked === 0 && r.burnt === 0 && r.assets && !stop()
            : r.banked === o.target && r.caught === r.cooked + r.burnt && r.assets && !stop();
        if (!r.ok) throw Error('shark final asset/life/target mismatch');
    } catch (error) {
        r.failure = String(error);
        r.ok = false;
        r.atBank = false;
        const p = state()?.player;
        const here = p && { x: p.worldX, z: p.worldZ };
        if (initial && !ended && !r.died && p?.level === 0 && here && sharkCorridor(here) && !o.stop?.()) {
            deadline = s.tick() + (o.recoveryTicks ?? 120);
            const bank = d8(here, WEST_BANK) < d8(here, SHARK_BANK) ? { ...WEST_BANK, tol: 8 } : { ...SHARK_BANK, tol: 2 };
            try {
                await s.bot.closeInterface();
                await walk([bank]);
                await open();
                await store(true, true);
                r.atBank = true;
                r.recovery = 'banked';
                r.assets = sharkAssetCheck(initial, assets(), r);
            } catch (e) {
                r.recovery = String(e);
            }
        } else {
            r.recovery = 'unsupported';
        }
        r.unbanked = sharkAssets(inv());
    } finally {
        off();
        r.ticks = s.tick() - start;
    }
    return r;
}

// ---------------------------------------------------------------------------
// 4. Barbarian Village Fly/Bait Fishing (`fishing:village`)
// ---------------------------------------------------------------------------
export type VillageMode = 'DROP_RAW' | 'COOK_AND_DROP' | 'COOK_AND_BANK' | 'BANK_RAW';
export type VillageOrder = {
    method: 'fly' | 'riverBait';
    mode: VillageMode;
    target: number;
    batch: number;
    reserve: number;
    cap: number;
    returnTicks: number;
    xpRate: number;
};

export const VILLAGE_BANK = { x: 3094, z: 3491, level: 0 };
export const VILLAGE_SPOT = { x: 3107, z: 3430, level: 0 };
export const VILLAGE_HEAT = { x: 3160, z: 3427, level: 0, id: 2728 };
export const VILLAGE_HEAT_STAND = { x: 3160, z: 3428 };

type NativeCookRecipe = {
    name: string;
    raw: number;
    products: number[];
    burnt?: number;
    level: number;
    xp: number;
    range: boolean;
    fire: boolean;
    source: string;
};

let cachedNativeCookRecipes: NativeCookRecipe[] | undefined;
let cachedHeatLocs: Map<number, 'range' | 'fire'> | undefined;

function parsePackNameMap(file: string): Map<string, number> {
    const text = readFileSync(file, 'utf8');
    const out = new Map<string, number>();
    let pos = 0;
    while (pos < text.length) {
        let end = text.indexOf('\n', pos);
        if (end < 0) end = text.length;
        const lineEnd = end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
        const eq = text.indexOf('=', pos);
        if (eq > pos && eq < lineEnd) {
            const id = Number(text.slice(pos, eq));
            if (Number.isInteger(id) && id >= 0) out.set(text.slice(eq + 1, lineEnd), id);
        }
        pos = end + 1;
    }
    return out;
}

function readNativeVillageRecipes(): readonly NativeCookRecipe[] {
    if (cachedNativeCookRecipes) return cachedNativeCookRecipes;
    const objPack = parsePackNameMap(resolve(CONTENT, 'pack/obj.pack'));
    const dbFile = 'scripts/skill_cooking/configs/cooking_source/cooking_generic.dbrow';
    const text = readFileSync(resolve(CONTENT, dbFile), 'utf8');
    const out: NativeCookRecipe[] = [];
    for (const m of text.matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)) {
        const name = m[1]!;
        const body = m[2]!;
        const field = (k: string) => body.match(new RegExp('^data=' + k + ',(.+)$', 'm'))?.[1]?.trim();
        const raw = field('uncooked');
        const product = field('cooked');
        if (!raw || !product || product === 'null' || raw === product) continue;
        const rawId = objPack.get(raw);
        const prodId = objPack.get(product);
        if (rawId === undefined || prodId === undefined) continue;
        const burntName = field('burnt');
        const burntId = field('successchance') !== '1,1' && burntName && burntName !== 'null' ? objPack.get(burntName) : undefined;
        out.push({
            name,
            raw: rawId,
            products: [prodId],
            burnt: burntId,
            level: Number(field('levelrequired') ?? 0),
            xp: Number(field('experience') ?? 0),
            range: !field('cantcookmessage_range'),
            fire: !field('cantcookmessage_fire'),
            source: 'vendor/rs-sdk/server/content/' + dbFile,
        });
    }
    cachedNativeCookRecipes = out;
    return out;
}

function readNativeHeatMap(): ReadonlyMap<number, 'range' | 'fire'> {
    if (cachedHeatLocs) return cachedHeatLocs;
    const locPack = parsePackNameMap(resolve(CONTENT, 'pack/loc.pack'));
    const out = new Map<number, 'range' | 'fire'>();
    const walkDir = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (entry.name !== '_unpack') walkDir(resolve(dir, entry.name));
            } else if (entry.name.endsWith('.loc')) {
                const text = readFileSync(resolve(dir, entry.name), 'utf8');
                if (!text.includes('cooking_oven') && !text.includes('cooking_fire')) continue;
                for (const m of text.matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)) {
                    const cat = m[2]!.match(/^category=(cooking_oven|cooking_fire)\r?$/m)?.[1];
                    const id = locPack.get(m[1]!);
                    if (cat && id !== undefined) out.set(id, cat === 'cooking_oven' ? 'range' : 'fire');
                }
            }
        }
    };
    walkDir(resolve(CONTENT, 'scripts'));
    cachedHeatLocs = out;
    return out;
}

export function villagePolicy(o: VillageOrder, recipesOverride?: readonly NativeCookRecipe[]) {
    if (
        !o ||
        !['fly', 'riverBait'].includes(o.method) ||
        !['DROP_RAW', 'COOK_AND_DROP', 'COOK_AND_BANK', 'BANK_RAW'].includes(o.mode) ||
        ![o.target, o.batch, o.cap, o.returnTicks, o.xpRate].every(n => Number.isSafeInteger(n) && n > 0) ||
        o.target > 10000 ||
        o.batch > 24 ||
        o.cap > 100000 ||
        o.returnTicks < 100 ||
        o.cap <= o.returnTicks ||
        o.xpRate > 1000 ||
        !Number.isSafeInteger(o.reserve) ||
        o.reserve < 0
    ) {
        throw Error('invalid finite village fishing order');
    }
    const fish = FISH_PROFILES[o.method];
    const cook = o.mode.startsWith('COOK_');
    const drop = o.mode.endsWith('DROP') || o.mode === 'DROP_RAW';
    const recipes = (recipesOverride ?? readNativeVillageRecipes()).filter(r => fish.products.includes(r.raw as never));
    if (recipes.length !== fish.products.length || recipes.some(r => !r.range || r.products.length !== 1 || r.burnt !== 343)) {
        throw Error('native village cooking recipes absent');
    }
    return { fish, cook, drop, recipes, outputs: [...fish.products, ...new Set(recipes.flatMap(r => [...r.products, r.burnt!]))] };
}

const VILLAGE_FISH_XP: Readonly<Record<number, number>> = { 335: 50, 331: 70, 349: 60 };
const villagePack = (s: Session) => {
    const out: Record<number, number> = {};
    for (const i of s.sdk.getInventory()) out[i.id] = (out[i.id] ?? 0) + i.count;
    return out;
};

export function villagePackEffect(
    before: Record<number, number>,
    after: Record<number, number>,
    expected: Record<number, number>,
) {
    return [...new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(expected)])].every(
        id => (after[+id] ?? 0) - (before[+id] ?? 0) === (expected[+id] ?? 0),
    );
}

export async function dropVillageOutput(s: Session, ids: readonly number[], maximum: number, stop: () => boolean) {
    const initial = villagePack(s);
    const dropped: Record<number, number> = {};
    let slots = 0;
    while (slots < maximum) {
        if (stop()) throw Error('village drop stopped');
        const row = s.sdk.getInventory().find(i => ids.includes(i.id));
        if (!row) break;
        const before = villagePack(s);
        const id = row.id;
        const count = row.count;
        const slot = row.slot;
        if (!Number.isSafeInteger(row.count) || row.count < 1 || row.optionsWithIndex.some(v => v.opIndex === 5 && !/^drop$/i.test(v.text))) {
            throw Error('village fresh native drop unknown');
        }
        await s.direct({ type: 'dropItem', slot, reason: 'finite village owned catch output' });
        if (
            !(await waitUntil(s, () => stop() || villagePackEffect(before, villagePack(s), { [id]: -count }), { timeoutTicks: 8 })) ||
            stop() ||
            !villagePackEffect(before, villagePack(s), { [id]: -count })
        ) {
            throw Error('village drop effect unresolved');
        }
        dropped[id] = (dropped[id] ?? 0) + count;
        slots++;
    }
    if (
        s.sdk.getInventory().some(i => ids.includes(i.id)) ||
        !villagePackEffect(initial, villagePack(s), Object.fromEntries(Object.entries(dropped).map(([id, n]) => [id, -n])))
    ) {
        throw Error('village drop stock mismatch');
    }
    return dropped;
}

async function fallbackVillageCookBatch(
    d: {
        state: () => BotWorldState | null;
        tick: () => number;
        stop: () => boolean;
        heat: (slot: number, source: 'range' | 'fire', r: NativeCookRecipe) => Promise<boolean>;
        wait: (test: () => boolean, ticks: number) => Promise<boolean>;
        step: () => Promise<void>;
        close: () => Promise<void>;
    },
    r: NativeCookRecipe,
    o: { maximum: number; cap: number; heat: 'range' | 'fire' },
) {
    const snap = (s: BotWorldState) => {
        const items: Record<number, number> = {};
        for (const i of s.inventory) items[i.id] = (items[i.id] ?? 0) + i.count;
        return { items, xp: s.skills.find(k => k.name === 'Cooking')?.experience ?? 0 };
    };
    const initial = d.state();
    if (!initial?.player) throw Error('cooking state unknown');
    const initialHp = initial.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;
    if (initialHp < 1) throw Error('cooking health unknown');
    if ((initial.skills.find(k => k.name === 'Cooking')?.level ?? 0) < r.level) throw Error('Cooking level insufficient');
    const start = d.tick();
    let cooked = 0;
    let burnt = 0;
    const products: Record<number, number> = {};
    const state = () => {
        const st = d.state();
        if (!st?.player) throw Error('cooking session ended');
        if (d.stop()) throw Error('cooking stopped');
        if (d.tick() - start >= o.cap) throw Error('cooking cap');
        if (
            st.player.lifeId !== initial.player!.lifeId ||
            st.player.level !== initial.player!.level ||
            st.player.isDead ||
            (st.skills.find(k => k.name === 'Hitpoints')?.level ?? 0) !== initialHp
        ) {
            throw Error('cooking life, floor or health changed');
        }
        return st;
    };
    try {
        while (cooked + burnt < o.maximum) {
            const before = state();
            const raw = before.inventory.find(i => i.id === r.raw);
            if (!raw) throw Error('staged cooking input exhausted');
            const b = snap(before);
            await d.close();
            if (!(await d.heat(raw.slot, o.heat, r))) throw Error('cooking heat action refused');
            let outcome: { kind: 'cooked' | 'burnt'; product: number } | null = null;
            const ok = await d.wait(() => {
                const a = snap(state());
                const keys = new Set([...Object.keys(b.items), ...Object.keys(a.items)].map(Number));
                if ([...keys].every(id => (a.items[id] ?? 0) === (b.items[id] ?? 0)) && a.xp >= b.xp) return false;
                for (const [kind, list] of [
                    ['cooked', r.products],
                    ['burnt', r.burnt === undefined ? [] : [r.burnt]],
                ] as const) {
                    for (const prod of list) {
                        const expected = new Map<number, number>([[r.raw, -1]]);
                        expected.set(prod, (expected.get(prod) ?? 0) + 1);
                        if (![...new Set([...keys, ...expected.keys()])].every(id => (a.items[id] ?? 0) - (b.items[id] ?? 0) === (expected.get(id) ?? 0))) continue;
                        if (kind === 'cooked' ? (r.xp > 0 ? a.xp <= b.xp : a.xp < b.xp) : a.xp !== b.xp) continue;
                        outcome = { kind, product: prod };
                        return true;
                    }
                }
                throw Error('cooking raw, product, returned container or XP does not reconcile');
            }, Math.min(12, o.cap - (d.tick() - start)));
            if (!ok || !outcome) throw Error('cooking effect unobserved');
            const obs = outcome as { kind: 'cooked' | 'burnt'; product: number };
            if (obs.kind === 'cooked') cooked++;
            else burnt++;
            products[obs.product] = (products[obs.product] ?? 0) + 1;
            if (cooked + burnt < o.maximum) await d.step();
        }
        return { processed: cooked + burnt, cooked, burnt, products, xp: snap(state()).xp - snap(initial).xp, ticks: d.tick() - start };
    } finally {
        await d.close();
    }
}

export type VillageDeps = {
    bank?: GatherExternalDeps['runBankProfile'];
    walk?: (s: Session, to: { x: number; z: number }, stop: () => boolean) => Promise<void>;
    cookingRecipes?: GatherExternalDeps['cookingRecipes'];
    nativeHeatSources?: GatherExternalDeps['nativeHeatSources'];
    runCookingBatch?: GatherExternalDeps['runCookingBatch'];
};

export async function runVillageFishing(
    original: Session,
    o: VillageOrder,
    requestStop: () => boolean = () => false,
    deps: VillageDeps = {},
) {
    const recipesList = deps.cookingRecipes ? deps.cookingRecipes().recipes : undefined;
    const policy = villagePolicy(o, recipesList);
    const heatMapFn = deps.nativeHeatSources ?? readNativeHeatMap;
    const cookBatchFn = deps.runCookingBatch ?? fallbackVillageCookBatch;
    const client = original.client;
    const executor = (client as any)?.executeBotAction;
    const first = original.sdk.getState()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const hp = original.sdk.getSkill('Hitpoints')?.level ?? 0;
    const start = original.tick();
    let ended = false;
    let lost = false;
    let phase = 'admission';
    void original.ended.then(() => {
        ended = true;
    });
    const gear = () =>
        JSON.stringify(
            (original.sdk.getState()?.equipment ?? [])
                .map(i => ({ slot: i.slot, id: i.id, count: i.count }))
                .sort((a, b) => a.slot - b.slot),
        );
    const otherXp = () =>
        JSON.stringify(
            (original.sdk.getState()?.skills ?? [])
                .filter(k => !['Fishing', 'Cooking'].includes(k.name))
                .map(k => [k.name, k.experience]),
        );
    const initialGear = gear();
    const initialOtherXp = otherXp();
    const fatal = () => {
        const p = original.sdk.getState()?.player;
        if (original.client !== client || (client as any)?.executeBotAction !== executor) lost = true;
        return (
            lost ||
            typeof executor !== 'function' ||
            ended ||
            life === undefined ||
            !p ||
            p.isDead ||
            p.lifeId !== life ||
            (p.respawnCount ?? 0) !== respawns ||
            p.level !== 0 ||
            (original.sdk.getSkill('Hitpoints')?.level ?? 0) !== hp ||
            gear() !== initialGear ||
            otherXp() !== initialOtherXp ||
            original.tick() - start >= o.cap
        );
    };
    const stopped = () => fatal() || (existsSync('.practice/stop-all') || (!!original.name && existsSync(`.practice/stop-${original.name}`)) || requestStop());
    const guard = () => {
        if (fatal()) throw Error('village original life/owner/health/gear unavailable');
        if (phase === 'produce' && (existsSync('.practice/stop-all') || (!!original.name && existsSync(`.practice/stop-${original.name}`)) || requestStop())) {
            phase = 'return';
            throw Error('village work stopped; owned return permitted');
        }
    };
    const sdk = new Proxy(original.sdk, {
        get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            return typeof value === 'function'
                ? function (...args: unknown[]) {
                      if (typeof key === 'string' && key.startsWith('send')) guard();
                      return value.apply(receiver, args);
                  }
                : value;
        },
    });
    const s = {
        ...original,
        sdk,
        bot: new BotActions(sdk),
        direct: async (action: Parameters<Session['direct']>[0]) => {
            guard();
            return original.direct(action);
        },
    } as Session;
    if (hp < 1 || stopped()) throw Error('village admission stopped');
    const receipts: { caught: Record<number, number>; cooked: Record<number, number>; burnt: number; dropped: Record<number, number> }[] = [];
    const move = async (to: { x: number; z: number }, stop: () => boolean, tol = 1) => {
        if (stop()) throw Error('village route stopped');
        if (deps.walk) {
            await deps.walk(s, to, stop);
            if (stop()) throw Error('village route owner changed');
            const p = s.sdk.getState()?.player;
            if (!p || p.level !== 0 || Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) > tol) {
                throw Error('village cooking arrival unobserved');
            }
            return;
        }
        const result = await walkPath(await sessionWalker(s), [{ ...to, tol }], {
            stop,
            maxTicks: Math.min(250, o.cap - (s.tick() - start) - o.returnTicks),
        });
        if (!result.ok || stop()) throw Error('village cooking route ' + result.detail);
    };
    const bankFn = deps.bank;
    if (!bankFn) throw Error('village-fishing requires deps.runBankProfile or deps.bank');
    const profile = {
        bank: VILLAGE_BANK,
        site: VILLAGE_SPOT,
        inputs: { [policy.fish.bait]: 1 },
        tools: [policy.fish.tool],
        outputs: policy.outputs,
        capacityOutputs: { [policy.fish.products[0]!]: 1 },
        prepare: async () => {
            phase = 'produce';
            if (stopped()) throw Error('village stopped before travel');
        },
        run: async (n: number, cap: number, stop: () => boolean) => {
            phase = 'produce';
            try {
                const over = () => stop() || stopped();
                const before = villagePack(s);
                const xpBefore = s.sdk.getSkillXp('Fishing') ?? 0;
                await runStagedFishing(
                    {
                        state: () => s.sdk.getState(),
                        tick: () => s.tick(),
                        stopped: over,
                        interact: (i, op) => s.sdk.sendInteractNpc(i, op),
                        combine: (a, b) => s.sdk.sendUseItemOnItem(a, b),
                        wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
                        step: () => waitTicks(s, 1),
                        closeDialog: () => s.direct({ type: 'closeModal', reason: 'SDK' }),
                    },
                    { method: o.method, amount: n, cap, maxAttempts: 10, progressTicks: Math.min(300, cap), xpRate: o.xpRate },
                );
                const at = s.sdk.getState()?.player;
                if (!at || over()) throw Error('village stopped after fishing');
                await s.sdk.sendWalk(at.worldX, at.worldZ);
                await waitTicks(s, 3);
                if (over()) throw Error('village fishing settlement stopped');
                const after = villagePack(s);
                const caught = Object.fromEntries(policy.fish.products.map(id => [id, (after[id] ?? 0) - (before[id] ?? 0)]));
                const total = Object.values(caught).reduce((a, b) => a + b, 0);
                const fishingXp = Object.entries(caught).reduce((a, [id, cnt]) => a + cnt * (VILLAGE_FISH_XP[+id] ?? NaN) * o.xpRate, 0);
                const expected = { ...caught, [policy.fish.bait]: -total };
                if (
                    total < n ||
                    total > n + 1 ||
                    !villagePackEffect(before, after, expected) ||
                    (s.sdk.getSkillXp('Fishing') ?? 0) - xpBefore !== fishingXp
                ) {
                    throw Error('village fishing exact stock/XP mismatch');
                }
                const receipt = {
                    caught,
                    cooked: {} as Record<number, number>,
                    burnt: 0,
                    dropped: {} as Record<number, number>,
                };
                if (policy.cook) {
                    await move(VILLAGE_HEAT_STAND, over, 0);
                    for (const r of policy.recipes) {
                        const amount = caught[r.raw] ?? 0;
                        if (!amount) continue;
                        const cookingXp = s.sdk.getSkillXp('Cooking') ?? 0;
                        const cooked = await cookBatchFn(
                            {
                                state: () => s.sdk.getState(),
                                tick: () => s.tick(),
                                stop: over,
                                close: async () => {
                                    if (over()) throw Error('village cooking stopped');
                                    await s.sdk.sendCloseModal();
                                },
                                heat: async (slot, kind) => {
                                    if (over()) return false;
                                    const heat = s.sdk
                                        .getState()
                                        ?.nearbyLocs.find(
                                            l =>
                                                l.id === VILLAGE_HEAT.id &&
                                                l.x === VILLAGE_HEAT.x &&
                                                l.z === VILLAGE_HEAT.z &&
                                                heatMapFn().get(l.id) === kind &&
                                                l.distance <= 2 &&
                                                l.reachable !== false,
                                        );
                                    if (!heat) throw Error('native village substitute range unobserved');
                                    return (await s.sdk.sendUseItemOnLoc(slot, heat.x, heat.z, heat.id)).success;
                                },
                                wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
                                step: () => waitTicks(s, 1),
                            },
                            r,
                            { maximum: amount, cap: Math.max(1, o.cap - o.returnTicks - (s.tick() - start)), heat: 'range' },
                        );
                        if ((s.sdk.getSkillXp('Cooking') ?? 0) - cookingXp !== (cooked.cooked * r.xp * o.xpRate) / 10) {
                            throw Error('village cooking native XP mismatch');
                        }
                        receipt.burnt += cooked.burnt;
                        for (const [id, cnt] of Object.entries(cooked.products)) receipt.cooked[+id] = (receipt.cooked[+id] ?? 0) + cnt;
                    }
                }
                if (policy.drop) {
                    receipt.dropped = await dropVillageOutput(
                        s,
                        policy.cook ? policy.outputs.filter(id => !policy.fish.products.includes(id as never)) : policy.fish.products,
                        28,
                        over,
                    );
                }
                receipts.push(receipt);
                return total;
            } finally {
                phase = 'return';
            }
        },
    };
    try {
        const result = await bankFn(
            s,
            {
                family: 'village-fishing',
                recipe: o.method + ':' + o.mode,
                target: o.target,
                batch: o.batch,
                reserve: o.reserve,
                cap: o.cap,
                returnTicks: o.returnTicks,
                members: false,
            },
            profile as any,
            stopped,
        );
        return { ...result, mode: o.mode, receipts };
    } finally {
        phase = 'return';
    }
}

// ---------------------------------------------------------------------------
// 5. Lumbridge Fly Fishing + Cooking (`fishing:fishcook`)
// ---------------------------------------------------------------------------
const starterCount = (s: Session, id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

export function starterCookingStock(s: Session) {
    return {
        raw: starterCount(s, 2138),
        cooked: starterCount(s, 2140),
        burnt: starterCount(s, 2144),
        xp: s.sdk.getSkillXp('Cooking') ?? 0,
    };
}

export class StarterCookingUnresolved extends Error {}

export async function cookStarterChicken(s: Session, stop: () => boolean = () => false) {
    const before = starterCookingStock(s);
    const start = s.tick();
    const fire = s.sdk.getState()?.nearbyLocs.find(l => /^fireplace$/i.test(l.name) && l.x === 3214 && l.z === 3249);
    const chicken = s.sdk.getInventory().find(i => i.id === 2138);
    let last = '';
    let dispatchReply: unknown;
    let accepted = false;
    let stopped = false;
    const isStopped = () => (stopped ||= stop());
    const record = (phase: string, action?: unknown) => {
        const state = s.sdk.getState();
        const observation = {
            phase,
            action,
            dispatchReply,
            loc: fire,
            position: state?.player,
            modalOpen: state?.modalOpen,
            modalInterface: state?.modalInterface,
            interface: state?.interface,
            dialog: s.sdk.getDialog(),
            messages: state?.gameMessages?.slice(-8),
            eventBusy: randomEventsOf(s)?.busy() ?? false,
            ...starterCookingStock(s),
        };
        const value = JSON.stringify(observation);
        if (value !== last) {
            last = value;
            console.log('STARTER_COOKING ' + JSON.stringify({ tick: s.tick(), ...observation }));
        }
    };
    record('entry');
    if (isStopped()) throw Error('bootstrap cooking stopped; ' + last);
    if (!fire || !chicken) throw Error('bootstrap chicken/fireplace unobserved; ' + last);
    const off = s.onTick(() => record('observation'));
    const send = s.sdk.sendUseItemOnLoc;
    const traced: typeof send = async (...args) => {
        if (isStopped()) return { success: false, message: 'bootstrap cooking stopped before dispatch' };
        const reply = await send.apply(s.sdk, args);
        accepted ||= reply.success;
        dispatchReply = reply;
        record('dispatch', reply);
        return reply;
    };
    s.sdk.sendUseItemOnLoc = traced;
    try {
        let action: Awaited<ReturnType<Session['bot']['useItemOnLoc']>> | undefined;
        let actionError: unknown;
        try {
            action = await s.bot.useItemOnLoc(chicken, fire);
        } catch (error) {
            actionError = error;
        }
        record('action', action);
        isStopped();
        if (!accepted) {
            if (stopped) throw Error('bootstrap cooking stopped; ' + last);
            if (actionError) throw actionError;
            throw Error('bootstrap cooking action rejected: ' + JSON.stringify(action) + '; ' + last);
        }
        const unresolved = (why: string) =>
            new StarterCookingUnresolved(`bootstrap cooking settlement unresolved: ${why}; stopped=${isStopped()}; ` + last);
        let observed: boolean;
        try {
            observed = await waitUntil(
                s,
                () => {
                    isStopped();
                    const now = starterCookingStock(s);
                    const cooked = now.cooked - before.cooked;
                    const burnt = now.burnt - before.burnt;
                    return now.raw < before.raw && cooked + burnt > 0 && (cooked === 0 || now.xp > before.xp);
                },
                { timeoutTicks: 8 },
            );
        } catch (error) {
            throw unresolved('observation failed: ' + String(error));
        }
        record('conversion', action);
        const after = starterCookingStock(s);
        const consumed = before.raw - after.raw;
        const cooked = after.cooked - before.cooked;
        const burnt = after.burnt - before.burnt;
        const xp = after.xp - before.xp;
        if (!observed && consumed === 0) throw unresolved('conversion unobserved');
        if (consumed !== 1 || cooked < 0 || burnt < 0 || cooked + burnt !== consumed) throw unresolved('output mismatch');
        if (cooked > 0 ? xp <= 0 : xp !== 0) throw unresolved('Cooking XP unobserved or inconsistent');
        if (isStopped()) throw Error('bootstrap cooking stopped after settled conversion; ' + last);
        if (actionError) throw actionError;
        if (!action?.success) throw Error('bootstrap cooking action failed after settled conversion: ' + JSON.stringify(action) + '; ' + last);
        return { consumed, cooked, burnt, xp, ticks: s.tick() - start };
    } finally {
        off();
        if (s.sdk.sendUseItemOnLoc === traced) s.sdk.sendUseItemOnLoc = send;
    }
}

export async function cookStarterChickens(
    s: Session,
    stop: () => boolean = () => false,
    options: { requiredFood?: number } = {},
) {
    const initial = starterCookingStock(s);
    const start = s.tick();
    const requiredFood = options.requiredFood ?? 1;
    if (!Number.isSafeInteger(requiredFood) || requiredFood < 0 || requiredFood > 28) throw Error('invalid starter food requirement');
    const result = () => {
        const now = starterCookingStock(s);
        return {
            ok: true,
            raw: initial.raw,
            consumed: initial.raw - now.raw,
            cooked: now.cooked - initial.cooked,
            burnt: now.burnt - initial.burnt,
            xp: now.xp - initial.xp,
            remainingRaw: now.raw,
            ticks: s.tick() - start,
        };
    };
    if (stop()) throw Error('bootstrap cooking stopped');
    if (!initial.raw) {
        if (initial.cooked >= requiredFood) return result();
        throw Error(`food acquisition: train chickens and collect raw chicken2138; cooked chicken2140 needs${requiredFood - initial.cooked}`);
    }
    const r = await walkPath(
        await sessionWalker(s),
        [
            { x: 3092, z: 3250, tol: 1 },
            { x: 3089, z: 3266, tol: 1 },
            { x: 3100, z: 3285, tol: 2 },
            { x: 3180, z: 3258, tol: 2 },
            { x: 3215, z: 3249, tol: 1 },
        ],
        { maxTicks: 500, stop },
    );
    if (!r.ok) throw Error('bootstrap food route: ' + r.detail);
    const boundedStop = () => stop() || s.tick() - start >= 650;
    while (starterCount(s, 2138) > 0 && !boundedStop()) {
        if (randomEventsOf(s)?.busy()) {
            if (!(await waitUntil(s, () => boundedStop() || !randomEventsOf(s)?.busy(), { timeoutTicks: 12 }))) {
                throw Error('bootstrap cooking event still busy; retain stock');
            }
            if (boundedStop()) break;
        }
        await cookStarterChicken(s, boundedStop);
    }
    const need = Math.max(0, requiredFood - starterCount(s, 2140));
    const final = { ...result(), ok: !boundedStop() && need === 0 };
    console.log('STARTER_COOKING_RESULT ' + JSON.stringify(final));
    if (boundedStop()) throw Error('bootstrap cooking stopped; ' + JSON.stringify(final));
    if (need) {
        throw Error(
            `food acquisition: cooked chicken2140 needs${need}; collect at least${need} raw chicken2138 (burns may require another finite batch); ` +
                JSON.stringify(final),
        );
    }
    return final;
}

export function cookCourierReady(c: any, courier: string, cook: string, now: number, requireTarget = false): boolean {
    return (
        typeof c?.name === 'string' &&
        c.name.toLowerCase() === courier.toLowerCase() &&
        c.server === 'rs-sdk-demo.fly.dev' &&
        !c.result &&
        Number.isFinite(c.at) &&
        now - c.at >= 0 &&
        now - c.at < 30000 &&
        c.pos?.level === 0 &&
        Math.max(Math.abs(c.pos.x - 3092), Math.abs(c.pos.z - 3243)) <= 12 &&
        (!requireTarget || (typeof c.phase === 'string' && c.phase.toLowerCase() === `collecting ${cook.toLowerCase()}`))
    );
}

export async function fundFishingTool(s: Session, limit = 25, allowSale = true): Promise<number> {
    const held = () => countItems(s, /^coins$/i);
    const before = held();
    if (before >= 5 || countItems(s, /^fly fishing rod$/i) > 0) return 0;
    const bank = s.sdk.findBankItem(/^coins$/i);
    if (bank && Number.isSafeInteger(bank.count) && bank.count > 0) {
        await s.bot.withdrawItem(bank, Math.min(bank.count, limit - before));
    }
    if (allowSale && held() < 5) {
        for (const raw of [/^raw shrimps$/i, /^raw anchovies$/i]) {
            const fish = s.sdk.findBankItem(raw);
            if (fish && Number.isSafeInteger(fish.count) && fish.count > 0) {
                await s.bot.withdrawItem(fish, fish.count, { asNote: true });
            }
        }
    }
    return Math.max(0, held() - before);
}

export async function buyFishingSupplies(s: Session, feathers: number): Promise<number> {
    if (countItems(s, /^fly fishing rod$/i) === 0) {
        if (countItems(s, /^coins$/i) < 5) {
            for (const raw of [/^raw shrimps$/i, /^raw anchovies$/i]) {
                if (countItems(s, raw) > 0) await s.bot.sellToShop(raw, 'all');
            }
        }
        if (!(await s.bot.buyFromShop(/^fly fishing rod$/i, 1)).success) return 0;
    }
    const before = countItems(s, /^feather$/i);
    if (feathers > 0) await s.bot.buyFromShop(/^feather$/i, feathers);
    return Math.max(0, countItems(s, /^feather$/i) - before);
}

export type FiniteFoodProfile = {
    target: number;
    netCap: number;
    flyCap: number;
    catchCap: number;
    noProgressTicks: number;
    singleKind?: true;
};

export function finiteFoodProfile(raw: string | undefined, singleRaw?: string): FiniteFoodProfile | undefined {
    if (singleRaw !== undefined && !['0', '1'].includes(singleRaw)) throw Error('FOOD_SINGLE_KIND must be0 or1');
    if (raw === undefined) {
        if (singleRaw === '1') throw Error('FOOD_SINGLE_KIND needs FOOD_TARGET');
        return undefined;
    }
    const target = Number(raw);
    if (!Number.isSafeInteger(target) || target < 1 || target > 28) throw Error('FOOD_TARGET must be1..28 new banked trout/salmon');
    if (singleRaw === '1' && target > 16) throw Error('single-kind FOOD_TARGET must be1..16');
    const flyCap = singleRaw === '1' ? Math.max(3, target * 3) : target * 2;
    return { target, netCap: 16, flyCap, catchCap: 16 + flyCap, noProgressTicks: 240, ...(singleRaw === '1' ? { singleKind: true as const } : {}) };
}

export function finiteFoodEntryPosition(p: { worldX: number; worldZ: number; level: number } | null | undefined) {
    return (
        !!p &&
        p.level === 0 &&
        (Math.max(Math.abs(p.worldX - 3092), Math.abs(p.worldZ - 3243)) <= 4 ||
            (p.worldX >= 3217 && p.worldX <= 3253 && p.worldZ >= 3190 && p.worldZ <= 3255))
    );
}

export function finiteFoodWork(profile: FiniteFoodProfile, banked: number, packCooked: number, raw: number) {
    const needed = Math.max(0, profile.target - banked - packCooked);
    return { needed, cook: needed > 0 && raw > 0, fish: raw < needed, done: banked === profile.target };
}

export type FoodKinds = { trout: number; salmon: number };

export function finiteFoodKindsWork(profile: FiniteFoodProfile, bank: FoodKinds, pack: FoodKinds, raw: FoodKinds) {
    if (!profile.singleKind) return finiteFoodWork(profile, bank.trout + bank.salmon, pack.trout + pack.salmon, raw.trout + raw.salmon);
    const trout = bank.trout + pack.trout;
    const salmon = bank.salmon + pack.salmon;
    const progress = Math.max(trout, salmon);
    return {
        needed: Math.max(0, profile.target - progress),
        cook: progress < profile.target && raw.trout + raw.salmon > 0,
        fish: progress < profile.target && trout + raw.trout < profile.target && salmon + raw.salmon < profile.target,
        done: Math.max(bank.trout, bank.salmon) >= profile.target,
    };
}

export function finiteFoodPreferredRaw(profile: FiniteFoodProfile, bank: FoodKinds, pack: FoodKinds, raw: FoodKinds): number | undefined {
    if (!profile.singleKind || Math.max(bank.trout + pack.trout, bank.salmon + pack.salmon) >= profile.target) return undefined;
    const candidates = (
        [
            { kind: 'trout', rawId: 335 },
            { kind: 'salmon', rawId: 331 },
        ] as const
    )
        .map(k => ({ ...k, need: profile.target - bank[k.kind] - pack[k.kind] }))
        .filter(k => k.need > 0 && raw[k.kind] >= k.need)
        .sort((a, b) => a.need - b.need || a.rawId - b.rawId);
    return candidates[0]?.rawId;
}

const WHIRLPOOL = new Set([403, 404, 405, 406]);
const FINITE_RIVER_TILES = new Set(['3239,3241', '3239,3242', '3239,3243', '3239,3244', '3238,3251', '3238,3252', '3238,3254', '3238,3255']);

export function finiteFoodSpotAllowed(n: any, finite = false): boolean {
    if (!n || !/fishing spot/i.test(n.name) || WHIRLPOOL.has(n.id) || !n.optionsWithIndex?.some((o: any) => /^lure$/i.test(o.text))) {
        return false;
    }
    return finite ? n.id === 329 && n.reachable === true && FINITE_RIVER_TILES.has(`${n.x},${n.z}`) : n.z >= 3248;
}

export function finiteFoodCanCatch(profile: FiniteFoodProfile, net: number, fly: number, phase: 'net' | 'fly') {
    return net + fly < profile.catchCap - 1 && (phase === 'net' ? net < profile.netCap - 1 : fly < profile.flyCap - 1);
}

export function finiteFoodExitReady(
    profile: FiniteFoodProfile,
    done: boolean,
    net: number,
    fly: number,
    blocked: boolean,
    p: { worldX: number; worldZ: number; level: number } | null | undefined,
) {
    return (
        done &&
        !blocked &&
        net <= profile.netCap &&
        fly <= profile.flyCap &&
        net + fly <= profile.catchCap &&
        !!p &&
        p.level === 0 &&
        Math.max(Math.abs(p.worldX - 3092), Math.abs(p.worldZ - 3243)) <= 4
    );
}

type Pt = [number, number, number];
const FLY_SPOT = { x: 3239, z: 3251 };
const FIREPLACE = { x: 3214, z: 3249 };
const FC_BANK = { x: 3092, z: 3243 };
const CHICKENS = { x: 3230, z: 3298 };
const NET_STAND = { x: 3088, z: 3227 };
const GERRANT = { x: 3014, z: 3224 };
const LOGS_AT = { x: 3089, z: 3266 };

const TO_FIRE: Pt[] = [[3226, 3250, 2], [FIREPLACE.x + 1, FIREPLACE.z, 1]];
const FIRE_TO_BANK: Pt[] = [[3180, 3258, 3], [3100, 3285, 3], [3089, 3266, 2], [3092, 3250, 1], [FC_BANK.x, FC_BANK.z, 2]];
const FLY_TO_BANK: Pt[] = [[3226, 3250, 2], ...FIRE_TO_BANK];
const BANK_TO_FLY: Pt[] = [[3092, 3250, 1], [3089, 3266, 2], [3100, 3285, 3], [3180, 3258, 3], [3226, 3250, 2], [FLY_SPOT.x, FLY_SPOT.z, 1]];
const FIRE_TO_FLY: Pt[] = [[3226, 3250, 2], [FLY_SPOT.x, FLY_SPOT.z, 1]];
const FLY_TO_CHICKENS: Pt[] = [[3226, 3262, 2], [3232, 3285, 2], [CHICKENS.x, CHICKENS.z, 3]];
const CHICKENS_TO_FIRE: Pt[] = [[3232, 3285, 2], [3226, 3262, 2], [FIREPLACE.x + 1, FIREPLACE.z, 1]];
const EAST_LANE: Pt[] = [[3094, 3247, 1], [3095, 3236, 1], [3093, 3228, 1]];
const BANK_TO_NET: Pt[] = [[3092, 3247, 1], ...EAST_LANE, [NET_STAND.x, NET_STAND.z, 1]];
const NET_TO_BANK: Pt[] = [[3093, 3228, 1], [3095, 3236, 1], [3094, 3247, 1], [3092, 3247, 1], [FC_BANK.x, FC_BANK.z, 2]];
const BANK_TO_SARIM: Pt[] = [[3092, 3250, 1], [LOGS_AT.x, LOGS_AT.z, 1], [3060, 3265, 3], [3047, 3237, 3], [3029, 3217, 3], [GERRANT.x, GERRANT.z, 2]];
const SARIM_TO_BANK: Pt[] = [[3029, 3217, 3], [3047, 3237, 3], [3060, 3265, 3], [LOGS_AT.x, LOGS_AT.z, 1], [3092, 3250, 1], [FC_BANK.x, FC_BANK.z, 2]];

const ROD = /^fly fishing rod$/i;
const FEATHER = /^feather$/i;
const RAW_FISH = /^raw (trout|salmon)$/i;
const RAW_ANY = /^raw (trout|salmon|chicken)$/i;
const COOKED = /^(trout|salmon)$/i;
const BURNT = /^burnt (fish|chicken)$/i;
const CHICKEN = /^chicken$/i;
const LURE = /^lure$/i;
const NEED: Record<string, number> = { 'raw trout': 15, 'raw salmon': 25, 'raw chicken': 1 };

class FishcookEnd extends Error {
    constructor(
        readonly outcome: {
            ok: boolean;
            detail: string;
            banked: number;
            ticks: number;
            summary: Record<string, unknown>;
        },
    ) {
        super(outcome.detail);
    }
}

export async function runFishcook(s: Session, cfg: NormalizedGatherConfig, stop: () => boolean): Promise<GatherOutcome> {
    const foodTarget = resolveSetting(cfg, 'FOOD_TARGET') ?? (cfg.target?.count ? String(cfg.target.count) : undefined);
    const FINITE = finiteFoodProfile(foodTarget, resolveSetting(cfg, 'FOOD_SINGLE_KIND'));
    const TICKS = cfg.target?.capTicks ?? Number(resolveSetting(cfg, 'TICKS') ?? resolveSetting(cfg, 'CAP') ?? 1500);
    const GIVE_TO = resolveSetting(cfg, 'GIVE_TO')?.trim() || '';
    const TARGETED_COLLECTION = resolveSetting(cfg, 'TARGETED_COLLECTION') === '1';
    const HANDOFF_ONLY = resolveSetting(cfg, 'HANDOFF_ONLY') === '1';
    const EXTERNAL_REFILL = resolveSetting(cfg, 'EXTERNAL_REFILL') === '1';
    if (
        FINITE &&
        (!Number.isSafeInteger(TICKS) || TICKS < 1 || TICKS > 6000 || GIVE_TO || HANDOFF_ONLY || EXTERNAL_REFILL)
    ) {
        throw Error('finite food needs TICKS1..6000 and no handoff/external refill');
    }
    const MAX_CATCHES = Number(resolveSetting(cfg, 'MAX_CATCHES') ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(MAX_CATCHES) || MAX_CATCHES < 1) throw Error('MAX_CATCHES must be a positive safe integer');
    const FEATHER_MIN = Number(resolveSetting(cfg, 'FEATHER_MIN') ?? 3);
    const FEATHER_FILL = Number(resolveSetting(cfg, 'FEATHER_FILL') ?? 60);
    const CHICKEN_CAP = Number(resolveSetting(cfg, 'CHICKEN_CAP') ?? 400);
    const WAIT = Number(resolveSetting(cfg, 'WAIT') ?? 900);
    const TICK3 = !FINITE && resolveSetting(cfg, 'TICK3') !== '0';
    const cookMode = resolveSetting(cfg, 'COOK_MODE') ?? 'wait';

    await waitUntil(s, () => !!s.sdk.getState()?.player && (s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0) > 0, { timeoutTicks: 3 });
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const inv = () => (st()?.inventory ?? []) as any[];
    const invLen = () => inv().length;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const cook = () => s.sdk.getSkill('Cooking')?.baseLevel ?? 1;
    const fish = () => s.sdk.getSkill('Fishing')?.baseLevel ?? 1;
    const cookXp = () => s.sdk.getSkillXp('Cooking') ?? 0;
    const fishXp = () => s.sdk.getSkillXp('Fishing') ?? 0;
    const cheb = (a: { x: number; z: number }, p: { worldX: number; worldZ: number }) =>
        Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const edible = (i: any) => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text));
    const cookedInPack = () => inv().filter(i => COOKED.test(i.name) && edible(i)).reduce((n, i) => n + i.count, 0);
    const cookable = () => inv().filter(i => RAW_ANY.test(i.name) && cook() >= (NEED[i.name.toLowerCase()] ?? 99));
    const slotOf = (re: RegExp) => inv().find(i => re.test(i.name))?.slot as number | undefined;
    const t0 = s.tick();
    const now = () => s.tick() - t0;
    const stopFile = `.practice/stop-${s.name}`;
    const make1 = componentId('skill_multi3:make1_a');

    let died = false;
    let hpMin = hp();
    let lastFail = '';
    const initialHp = hp();
    const initialLife = pos()?.lifeId;
    const initialRespawns = pos()?.respawnCount;
    let finiteHurt = false;
    let netCaught = 0;
    let flyCaught = 0;
    const rawIds = (ids: number[]) => {
        let n = 0;
        for (const i of inv()) if (ids.includes(i.id)) n += i.count;
        return n;
    };
    const rawNet = () => {
        let n = 0;
        for (const i of inv()) if (i.id === 317 || i.id === 321) n += i.count;
        return n;
    };
    const rawFly = () => {
        let n = 0;
        for (const i of inv()) if (i.id === 335 || i.id === 331) n += i.count;
        return n;
    };
    let lastRawNet = rawNet();
    let lastRawFly = rawFly();
    let lastCatchTick = s.tick();
    let activeFishingIndex: number | undefined;
    const life0 = (({ isDead, respawnCount, lifeId }: any = {}) => ({ isDead, respawnCount, lifeId }))(s.sdk.getState()?.player);
    const off = s.onTick(() => {
        const p = pos();
        hpMin = Math.min(hpMin, hp());
        if (FINITE) {
            finiteHurt ||= hp() < initialHp || p?.isDead === true || p?.lifeId !== initialLife || p?.respawnCount !== initialRespawns;
            let net = 0, fly = 0;
            for (const i of inv()) {
                if (i.id === 317 || i.id === 321) net += i.count;
                else if (i.id === 335 || i.id === 331) fly += i.count;
            }
            const a = Math.max(0, net - lastRawNet);
            const b = Math.max(0, fly - lastRawFly);
            netCaught += a;
            flyCaught += b;
            if (a + b > 0) lastCatchTick = s.tick();
            if (b > 0) {
                const state = st();
                console.log(
                    'FINITE_CATCH ' +
                        JSON.stringify({
                            tick: s.tick(),
                            delta: b,
                            player: p,
                            spot: state?.nearbyNpcs.find(n => n.index === activeFishingIndex) ?? null,
                            spiders: state?.nearbyNpcs.filter(n => n.id === 59).slice(0, 8),
                        }),
                );
            }
            lastRawNet = net;
            lastRawFly = fly;
        }
        if (sessionDied(life0, s.sdk.getState()?.player)) died = true;
    });

    let fishTicks = 0;
    let cookTicks = 0;
    let walkTicks = 0;
    let bankTicks = 0;
    let chickenTicks = 0;
    let idleTicks = 0;
    let giveTicks = 0;
    let noSpot = 0;
    let spotWaits = 0;
    let reclicks = 0;
    let caught = 0;
    let cooked = 0;
    let burnt = 0;
    let banked = 0;
    let bankFish = 0;
    let packs = 0;
    let cycles = 0;
    let kills = 0;
    let feathersGot = 0;
    let given = 0;
    let events = 0;
    let eats = 0;
    const cook0 = cook();
    const fishXp0 = fishXp();
    const newBankKinds: FoodKinds = { trout: 0, salmon: 0 };
    const packKinds = (): FoodKinds => ({ trout: rawIds([333]), salmon: rawIds([329]) });
    const rawKinds = (): FoodKinds => ({ trout: rawIds([335]), salmon: rawIds([331]) });
    const finiteWork = () => finiteFoodKindsWork(FINITE!, newBankKinds, packKinds(), rawKinds());
    let noSpotLogs = 0;
    const logNoSpot = (reason: string, final = false) => {
        if (!FINITE || noSpotLogs >= (final ? 2 : 1)) return;
        noSpotLogs++;
        console.log(
            'FINITE_NO_SPOT ' +
                JSON.stringify({
                    reason,
                    tick: s.tick(),
                    player: pos(),
                    hp: hp(),
                    newBankKinds,
                    npcs: (st()?.nearbyNpcs ?? []).slice(0, 32).map(n => ({
                        id: n.id,
                        index: n.index,
                        name: n.name,
                        x: n.x,
                        z: n.z,
                        distance: n.distance,
                        reachable: n.reachable,
                        options: n.optionsWithIndex?.slice(0, 6),
                        eligible: finiteFoodSpotAllowed(n, true),
                    })),
                }),
        );
    };

    const end = (ok: boolean, why: string): never => {
        const ticks = now();
        const p = pos();
        const tries = cooked + burnt;
        const detail =
            (FINITE
                ? `foodTarget=${FINITE.target} singleKind=${FINITE.singleKind ?? false} bankedTrout=${newBankKinds.trout} bankedSalmon=${newBankKinds.salmon} netCaught=${netCaught} flyCaught=${flyCaught} catchCap=${FINITE.catchCap} `
                : '') +
            `ticks=${ticks} caught=${caught} cooked=${cooked} burnt=${burnt} burnPct=${((100 * burnt) / Math.max(1, tries)).toFixed(1)} banked=${banked} bankFish=${bankFish} given=${given} ` +
            `foodPerKTicks=${((1000 * banked) / Math.max(1, ticks)).toFixed(1)} cooking=${cook0}->${cook()} fishXp=${fishXp() - fishXp0} packs=${packs} cycles=${cycles} kills=${kills} feathersGot=${feathersGot} ` +
            `fishTicks=${fishTicks} cookTicks=${cookTicks} walkTicks=${walkTicks} bankTicks=${bankTicks} chickenTicks=${chickenTicks} giveTicks=${giveTicks} idleTicks=${idleTicks} spotWaits=${spotWaits} reclicks=${reclicks} ` +
            `events=${events} eats=${eats} feathers=${countItems(s, FEATHER)} packCooked=${cookedInPack()} hp=${hp()} hpMin=${hpMin} died=${died} at=${p?.worldX},${p?.worldZ},${p?.level}`;
        const finalLine = ok ? detail : `${why} ${detail} last=${lastFail}`;
        throw new FishcookEnd({
            ok,
            detail: finalLine,
            banked,
            ticks,
            summary: { caught, cooked, burnt, banked, bankFish, given, ticks, died, hpMin },
        });
    };

    const over = () => stop() || died || (!!FINITE && finiteHurt) || now() >= TICKS || existsSync(stopFile);

    const walk = async (points: Pt[]): Promise<boolean> => {
        const w0 = s.tick();
        try {
            const [gx, gz, gtol] = points[points.length - 1]!;
            let left = points.map(([x, z, tol]) => ({ x, z, tol }));
            for (let i = 0; i < 3 && !died && !(FINITE && over()); i++) {
                const p = pos();
                if (p && cheb({ x: gx, z: gz }, p) <= gtol + 1) return true;
                const r = await walkPath(await sessionWalker(s), left, {
                    stop: () => died || (!!FINITE && over()),
                    ...(FINITE ? { maxTicks: Math.max(1, Math.min(600, TICKS - now())) } : {}),
                });
                if (!r.ok) {
                    lastFail = `walk ${r.detail}`;
                    await waitTicks(s, 1);
                }
                left = left.slice(Math.min(r.next, left.length - 1));
            }
            const p = pos();
            return !died && !!p && cheb({ x: gx, z: gz }, p) <= gtol + 1;
        } finally {
            walkTicks += s.tick() - w0;
        }
    };

    const go = async (points: Pt[], where: string) => {
        if (points === BANK_TO_FLY && (over() || (FINITE && finiteWork().done))) return;
        if (!(await walk(points))) end(false, `walk ${where}`);
        if (FINITE && (points === BANK_TO_FLY || points === BANK_TO_NET)) lastCatchTick = s.tick();
    };

    const eatIfLow = async (): Promise<boolean> => {
        if (FINITE) return false;
        if (hp() >= 5) return false;
        const f = inv().find(i => /^(trout|salmon|cooked chicken)$/i.test(i.name) && edible(i));
        if (!f) return false;
        const e0 = s.tick();
        const r = await s.bot.eatFood(f);
        if (r.success) eats++;
        else lastFail = `eat:${r.message}`;
        if (s.tick() === e0) await waitTicks(s, 1);
        return true;
    };

    const troll = async (): Promise<boolean> => {
        const t = (st()?.nearbyNpcs ?? []).find((n: any) => /river troll/i.test(n.name) && n.distance <= 10);
        if (!t) return false;
        events++;
        await eatIfLow();
        await walk([[FLY_SPOT.x - 14, FLY_SPOT.z + 8, 2]]);
        await waitTicks(s, 3);
        return true;
    };

    const cookAll = async () => {
        if (cookable().length === 0) return;
        await go(TO_FIRE, 'to fireplace');
        const c0 = s.tick();
        try {
            const waitMode = cookMode === 'wait';
            let stall = 0;
            const raw0 = countItems(s, RAW_ANY);
            const burnt0 = countItems(s, BURNT);
            let rawPrev = raw0;
            while (cookable().length > 0 && stall < 12 && !died && !(FINITE && over()) && (!FINITE || finiteWork().cook)) {
                if (randomEventsOf(s)?.busy()) {
                    await waitTicks(s, 1);
                    continue;
                }
                const fire = (st()?.nearbyLocs ?? []).find((l: any) => /^fireplace$/i.test(l.name) && l.x === FIREPLACE.x && l.z === FIREPLACE.z) as any;
                if (!fire) {
                    lastFail = 'no fireplace';
                    stall++;
                    await waitTicks(s, 1);
                    continue;
                }
                const preferred = FINITE ? finiteFoodPreferredRaw(FINITE, newBankKinds, packKinds(), rawKinds()) : undefined;
                const items = cookable().sort(
                    (a, b) =>
                        (preferred === undefined ? 0 : Number(b.id === preferred) - Number(a.id === preferred)) ||
                        (NEED[b.name.toLowerCase()] ?? 0) - (NEED[a.name.toLowerCase()] ?? 0),
                );
                const item = items[0]!;
                if (s.sdk.getDialog()?.isOpen || st()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                await s.direct({ type: 'useItemOnLoc', itemSlot: item.slot, x: fire.x, z: fire.z, locId: fire.id, reason: 'SDK' });
                if (waitMode) {
                    for (let i = 0; i < 5 && countItems(s, RAW_ANY) >= rawPrev && !died; i++) await waitTicks(s, 1);
                } else {
                    await waitTicks(s, 1);
                }
                const raw = countItems(s, RAW_ANY);
                if (raw < rawPrev) stall = 0;
                else stall++;
                rawPrev = raw;
            }
            if (stall >= 12) {
                if (FINITE) end(false, 'finite cooking no progress');
                console.log(`WARN cooking stalled: ${lastFail}`);
            }
            const b = countItems(s, BURNT) - burnt0;
            burnt += b;
            cooked += raw0 - countItems(s, RAW_ANY) - b;
        } finally {
            cookTicks += s.tick() - c0;
        }
        console.log(`COOK cooked=${cooked} burnt=${burnt} cooking=${cook()} t=${now()}`);
    };

    const chickenTrip = async (feathers: number, raw: number) => {
        await go(FLY_TO_CHICKENS, 'to chickens');
        const k0 = s.tick();
        const f0 = countItems(s, FEATHER);
        try {
            while (!over() && s.tick() - k0 < CHICKEN_CAP && (countItems(s, FEATHER) < feathers || countItems(s, /^raw chicken$/i) < raw)) {
                if (randomEventsOf(s)?.busy()) {
                    await waitTicks(s, 1);
                    continue;
                }
                if (await eatIfLow()) continue;
                const wantRaw = countItems(s, /^raw chicken$/i) < raw && invLen() < 28;
                const loot = (st()?.groundItems ?? [])
                    .filter(
                        (g: any) =>
                            g.distance <= 8 &&
                            g.reachable !== false &&
                            (FEATHER.test(g.name) || (wantRaw && /^raw chicken$/i.test(g.name))),
                    )
                    .sort((a: any, b: any) => a.distance - b.distance)[0] as any;
                if (loot && (FEATHER.test(loot.name) ? true : invLen() < 28)) {
                    const n0 = countItems(s, new RegExp(`^${loot.name}$`, 'i'));
                    await s.direct({ type: 'pickupItem', x: loot.x, z: loot.z, itemId: loot.id, reason: 'SDK' });
                    await waitUntil(s, () => countItems(s, new RegExp(`^${loot.name}$`, 'i')) > n0, {
                        timeoutTicks: Math.min(12, loot.distance + 3),
                    });
                    continue;
                }
                const me = pos();
                const c = (st()?.nearbyNpcs ?? [])
                    .filter(
                        (n: any) =>
                            CHICKEN.test(n.name) &&
                            n.reachable !== false &&
                            (n.hp ?? 1) > 0 &&
                            me &&
                            Math.max(Math.abs(n.x - CHICKENS.x), Math.abs(n.z - CHICKENS.z)) <= 10,
                    )
                    .sort((a: any, b: any) => a.distance - b.distance)[0] as any;
                if (!c) {
                    idleTicks++;
                    await waitTicks(s, 1);
                    continue;
                }
                const op = c.optionsWithIndex?.find((o: any) => /^attack$/i.test(o.text))?.opIndex;
                if (op === undefined) {
                    await waitTicks(s, 1);
                    continue;
                }
                await s.direct({ type: 'interactNpc', npcIndex: c.index, optionIndex: op, reason: 'SDK' });
                const gone = await waitUntil(s, x => !(x?.nearbyNpcs ?? []).some((n: any) => n.index === c.index && (n.hp ?? 1) > 0), {
                    timeoutTicks: 20,
                });
                if (gone) {
                    kills++;
                    await waitUntil(s, x => (x?.groundItems ?? []).some((g: any) => FEATHER.test(g.name) && g.distance <= 8), {
                        timeoutTicks: 1,
                    });
                }
            }
        } finally {
            chickenTicks += s.tick() - k0;
            feathersGot += Math.max(0, countItems(s, FEATHER) - f0);
            console.log(`CHICKENS kills=${kills} feathers=${countItems(s, FEATHER)} raw=${countItems(s, /^raw chicken$/i)} t=${now()}`);
        }
        if (cookable().length) {
            await go(CHICKENS_TO_FIRE, 'chickens to fireplace');
            await cookAll();
        }
    };

    const readCourierStatus = () => {
        if (!/^[A-Za-z0-9_ -]{1,12}$/.test(GIVE_TO)) return undefined;
        try {
            return JSON.parse(readFileSync(join(ROOT, '.practice', 'status', `${GIVE_TO}.json`), 'utf8'));
        } catch {
            return undefined;
        }
    };

    const handOff = async (waitFor: number) => {
        const who = new RegExp(`^${GIVE_TO.replace(/[^a-zA-Z0-9 _-]/g, '')}$`, 'i');
        const near = () =>
            (!TARGETED_COLLECTION || cookCourierReady(readCourierStatus(), GIVE_TO, s.name, Date.now(), true)) &&
            (st()?.nearbyPlayers ?? []).some((p: any) => who.test(p.name) && p.distance <= 12);
        const g0 = s.tick();
        try {
            if (!near() && waitFor > 0) await waitUntil(s, () => near() || existsSync(stopFile), { timeoutTicks: waitFor });
            if (!near()) return;
            const o = await s.bot.openBank();
            if (!o.success) {
                lastFail = `bank:${o.message}`;
                return;
            }
            for (const name of ['Trout', 'Salmon']) {
                const b = s.sdk.findBankItem(new RegExp(`^${name}$`, 'i'));
                if (b && b.count > 0) {
                    const w = await s.bot.withdrawItem(b, b.count, { asNote: true });
                    if (!w.success) lastFail = `withdraw note ${name}:${w.message}`;
                }
            }
            await s.bot.closeBank();
            const notes = inv().filter(i => COOKED.test(i.name) && !edible(i));
            const n = notes.reduce((a, i) => a + i.count, 0);
            if (n === 0) {
                lastFail = 'no notes to give';
                return;
            }
            if (!cfg.deps?.sendHandoff) throw Error('fishcook GIVE_TO requires deps.sendHandoff');
            const server = serverFromEnv(readFileSync(resolveBotEnvPath(s.name, ROOT), 'utf8'));
            const delivered = await cfg.deps.sendHandoff(
                s,
                GIVE_TO,
                server,
                notes.map(i => ({ id: i.id, count: i.count })),
                () =>
                    s.bot.trade(who, {
                        give: notes.map(i => ({ item: new RegExp(`^${i.name}$`, 'i'), amount: i.count })),
                        timeout: 60_000,
                        retryOnBusy: false,
                    }),
            );
            given += delivered;
            console.log(`MILESTONE gave ${delivered} verified food t=${now()}`);
        } finally {
            giveTicks += s.tick() - g0;
        }
    };

    const restockFeathersFromShop = async () => {
        if (over() || EXTERNAL_REFILL || FINITE) return;
        console.log('MILESTONE restocking feathers from Gerrant\'s shop (Port Sarim)...');
        const p = pos();
        if (!p || cheb(FC_BANK, p) > 4) await go(FIRE_TO_BANK, 'to Draynor bank');
        if (countItems(s, /^coins$/i) < 200) {
            const o = await s.bot.openBank();
            if (o.success) {
                const coinsBank = s.sdk.findBankItem(/^coins$/i);
                if (coinsBank && coinsBank.count > 0) {
                    await s.bot.withdrawItem(coinsBank, Math.min(2000, coinsBank.count));
                }
                await fundFishingTool(s, FINITE ? 5 : 25, !FINITE);
                await s.bot.closeBank();
            }
        }
        if (countItems(s, /^coins$/i) < 10 && countItems(s, /^raw (shrimps|anchovies)$/i) === 0) {
            console.log('WARN no coins to buy feathers; falling back to chickens');
            await chickenTrip(FEATHER_FILL, 0);
            await go(CHICKENS_TO_FIRE, 'from chicken refill to fireplace');
            await go(FIRE_TO_BANK, 'from chicken refill to Draynor bank');
            return;
        }
        await go(BANK_TO_SARIM, 'to Gerrant at Port Sarim');
        const sh = await s.bot.openShop(/^gerrant$/i);
        if (sh.success) {
            const f0 = countItems(s, FEATHER);
            await buyFishingSupplies(s, 1000);
            await s.bot.closeShop();
            const bought = countItems(s, FEATHER) - f0;
            feathersGot += bought;
            console.log(`MILESTONE bought ${bought} feathers from Gerrant! Total held: ${countItems(s, FEATHER)}`);
        } else {
            lastFail = `openShop: ${sh.message}`;
        }
        await go(SARIM_TO_BANK, 'back to Draynor bank');
    };

    const bankTrip = async () => {
        await go(FIRE_TO_BANK, 'to Draynor bank');
        const b0 = s.tick();
        try {
            const o = await s.bot.openBank();
            if (!o.success) {
                if (FINITE) end(false, 'finite bank open failed');
                lastFail = `bank:${o.message}`;
                await waitTicks(s, 1);
                return;
            }
            const finiteDeposit = FINITE ? { food: cookedInPack(), banked } : null;
            const KEEP = TICK3 ? /^(fly fishing rod|feather|coins|knife|logs)$/i : /^(fly fishing rod|feather|coins)$/i;
            const toDeposit = [...new Set(inv().filter(i => !KEEP.test(i.name)).map(i => i.name as string))];
            for (const name of toDeposit) {
                const re = new RegExp(`^${name}$`, 'i');
                const before = countItems(s, re);
                if (before === 0) continue;
                if (COOKED.test(name)) {
                    const ids = [...new Set(inv().filter(i => re.test(i.name)).map(i => i.id))];
                    for (const id of ids) {
                        const deposited = await depositObserved(s, { id, name });
                        banked += deposited;
                        if (id === 333) newBankKinds.trout += deposited;
                        if (id === 329) newBankKinds.salmon += deposited;
                    }
                } else {
                    const d = await s.bot.depositItem(re, -1);
                    if (!d.success) lastFail = `deposit ${name}:${d.message}`;
                }
            }
            if (finiteDeposit && (cookedInPack() !== 0 || banked - finiteDeposit.banked !== finiteDeposit.food)) {
                end(false, 'finite cooked deposit unresolved');
            }
            bankFish = ['Trout', 'Salmon'].reduce((n, name) => n + (s.sdk.findBankItem(new RegExp(`^${name}$`, 'i'))?.count ?? 0), 0);
            packs++;
            console.log(`BANK pack=${packs} banked=${banked} bankFish=${bankFish} t=${now()}`);
            const fInBank = s.sdk.findBankItem(FEATHER);
            if (!FINITE && fInBank && fInBank.count > 0 && countItems(s, FEATHER) < 100) {
                await s.bot.withdrawItem(fInBank, fInBank.count);
            }
            await s.bot.closeBank();
        } finally {
            bankTicks += s.tick() - b0;
        }
        if (GIVE_TO) await handOff(0);
        if (countItems(s, FEATHER) < 50) await restockFeathersFromShop();
    };

    const trainNetFishing = async () => {
        console.log(`MILESTONE Training Fishing from ${fish()} to 20 with Small fishing net at Draynor coast...`);
        const p = pos();
        if (!p || cheb(FC_BANK, p) > 4) await go(FLY_TO_BANK, 'to Draynor bank');
        let o = await s.bot.openBank();
        if (FINITE && !o.success) end(false, 'finite net bank unavailable');
        if (o.success) {
            for (const it of inv().filter(i => /^(fly fishing rod|raw chicken|cooked chicken|burnt chicken|trout|salmon|burnt fish)$/i.test(i.name))) {
                await s.bot.depositItem(new RegExp(`^${it.name}$`, 'i'), -1);
            }
            if (countItems(s, /^small fishing net$/i) === 0) {
                const netInBank = s.sdk.findBankItem(/^small fishing net$/i);
                if (netInBank) await s.bot.withdrawItem(netInBank, 1);
            }
            await s.bot.closeBank();
        }
        if (FINITE && countItems(s, /^small fishing net$/i) === 0) end(false, 'finite food requires owned small fishing net');
        if (countItems(s, /^small fishing net$/i) === 0) {
            console.log('Buying small fishing net at Port Sarim...');
            await go(BANK_TO_SARIM, 'to Gerrant');
            const sh = await s.bot.openShop(/^gerrant$/i);
            if (FINITE && !sh.success) end(false, 'finite rod shop unavailable');
            if (sh.success) {
                await s.bot.buyFromShop(/^small fishing net$/i, 1);
                await s.bot.closeShop();
            }
            await go(SARIM_TO_BANK, 'back to Draynor');
        }
        if (countItems(s, /^small fishing net$/i) === 0) end(false, 'no small fishing net');
        let stall = 0;
        let activeNet: { index: number; x: number; z: number } | undefined;
        while (!over() && fish() < 20 && (!FINITE || finiteFoodCanCatch(FINITE, netCaught, flyCaught, 'net'))) {
            if (FINITE && s.tick() - lastCatchTick > FINITE.noProgressTicks) end(false, 'finite net no progress');
            if (randomEventsOf(s)?.busy()) {
                activeNet = undefined;
                await waitTicks(s, 1);
                continue;
            }
            if (await eatIfLow()) {
                activeNet = undefined;
                continue;
            }
            if (s.sdk.getDialog()?.isOpen || st()?.interface?.isOpen) {
                activeNet = undefined;
                await s.direct({ type: 'closeModal', reason: 'SDK' });
            }
            if (invLen() >= 28) {
                activeNet = undefined;
                await go(NET_TO_BANK, 'to Draynor bank');
                const ob = await s.bot.openBank();
                if (FINITE && !ob.success) end(false, 'finite net deposit bank unavailable');
                if (ob.success) {
                    for (const name of ['Raw shrimps', 'Raw anchovies']) {
                        const cnt = countItems(s, new RegExp(`^${name}$`, 'i'));
                        if (cnt > 0) await s.bot.depositItem(new RegExp(`^${name}$`, 'i'), -1);
                    }
                    await s.bot.closeBank();
                }
                if (fish() >= 20) break;
                await go(BANK_TO_NET, 'to Draynor net spot');
                continue;
            }
            const curPos = pos();
            if (!curPos || cheb(NET_STAND, curPos) > 4) {
                activeNet = undefined;
                await go(BANK_TO_NET, 'to Draynor net spot');
            }
            const wiz = (st()?.nearbyNpcs ?? []).some((n: any) => /dark wizard/i.test(n.name) && n.distance <= 4);
            if (wiz) {
                activeNet = undefined;
                lastFail = 'dark wizard near net spot';
                await walk([[3093, 3228, 1]]);
                await waitUntil(s, () => over() || !(st()?.nearbyNpcs ?? []).some((n: any) => /dark wizard/i.test(n.name) && n.distance <= 4), {
                    timeoutTicks: 3,
                });
                continue;
            }
            const sp = (st()?.nearbyNpcs ?? [])
                .filter(
                    (n: any) =>
                        /fishing spot/i.test(n.name) &&
                        !WHIRLPOOL.has(n.id) &&
                        n.z <= 3228 &&
                        n.optionsWithIndex?.some((op: any) => /^net$/i.test(op.text)),
                )
                .sort((a: any, b: any) => a.distance - b.distance)[0] as any;
            if (!sp) {
                activeNet = undefined;
                stall++;
                if (stall % 5 === 0) await walk([[NET_STAND.x, NET_STAND.z, 1]]);
                await waitTicks(s, 1);
                continue;
            }
            stall = 0;
            const netOp = sp.optionsWithIndex.find((op: any) => /^net$/i.test(op.text))?.opIndex ?? 1;
            const invBefore = invLen();
            const sameNet = !!activeNet && activeNet.index === sp.index && activeNet.x === sp.x && activeNet.z === sp.z;
            if (!sameNet) {
                await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: netOp, reason: 'SDK' });
                activeNet = { index: sp.index, x: sp.x, z: sp.z };
            }
            let idleNet = 0;
            for (let t = 0; t < 12 && !over() && fish() < 20; t++) {
                await waitTicks(s, 1);
                if (s.sdk.getDialog()?.isOpen || st()?.interface?.isOpen) {
                    activeNet = undefined;
                    await s.direct({ type: 'closeModal', reason: 'SDK' });
                    break;
                }
                if (invLen() > invBefore || invLen() >= 28) break;
                if (!(st()?.nearbyNpcs ?? []).some((n: any) => n.index === sp.index && n.x === sp.x && n.z === sp.z)) {
                    activeNet = undefined;
                    break;
                }
                if ((pos()?.animId ?? -1) !== -1) idleNet = 0;
                else if (++idleNet >= (sp.distance <= 1 ? 3 : 6)) {
                    activeNet = undefined;
                    break;
                }
            }
        }
        if (FINITE && fish() < 20) end(false, 'finite net bootstrap budget/stop');
        console.log(`MILESTONE Fishing reached ${fish()}! Transitioning to fly fishing...`);
        await go(NET_TO_BANK, 'to Draynor bank');
        o = await s.bot.openBank();
        if (FINITE && !o.success) end(false, 'finite bank unavailable');
        if (o.success) {
            await s.bot.depositItem(/^small fishing net$/i, 1);
            for (const name of ['Raw shrimps', 'Raw anchovies']) {
                if (countItems(s, new RegExp(`^${name}$`, 'i')) > 0) await s.bot.depositItem(new RegExp(`^${name}$`, 'i'), -1);
            }
            const rodItem = s.sdk.findBankItem(ROD);
            if (rodItem) await s.bot.withdrawItem(rodItem, 1);
            const fItem = s.sdk.findBankItem(FEATHER);
            if (!FINITE && fItem) await s.bot.withdrawItem(fItem, fItem.count);
            await fundFishingTool(s, FINITE ? 5 : 25, !FINITE);
            await s.bot.closeBank();
        }
        if (countItems(s, FEATHER) < 200) await restockFeathersFromShop();
    };

    try {
        console.log(
            `FISHCOOK ticks=${TICKS} cooking=${cook()} fishing=${s.sdk.getSkill('Fishing')?.baseLevel} feathers=${countItems(s, FEATHER)} rod=${slotOf(ROD) !== undefined} giveTo=${GIVE_TO || '-'} handoffOnly=${HANDOFF_ONLY}`,
        );
        if (HANDOFF_ONLY) {
            if (!GIVE_TO) end(false, 'HANDOFF_ONLY needs GIVE_TO');
            const p = pos();
            if (p && cheb(FC_BANK, p) > 4) await go(FIRE_TO_BANK, 'to Draynor bank');
            await handOff(WAIT);
            end(given > 0, 'no hand-off');
        }
        if (FINITE) {
            const p = pos();
            if (
                !finiteFoodEntryPosition(p) ||
                !p ||
                !Number.isSafeInteger(p.combatLevel) ||
                p.combatLevel < 29 ||
                !Number.isSafeInteger(initialLife) ||
                !Number.isSafeInteger(initialRespawns) ||
                initialHp < 27 ||
                hp() !== (s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0) ||
                cook() < 25
            ) {
                end(false, 'finite food needs audited Draynor/Lumbridge combat29 fullHP27 Cooking25 entry');
            }
            if (inv().some(i => [317, 318, 321, 322, 335, 336, 331, 332, 333, 334, 329, 330, 379, 380].includes(i.id))) {
                end(false, 'finite food requires clean raw/cooked entry pack');
            }
            if (cheb(FC_BANK, p!) > 4) await go(FLY_TO_BANK, 'finite Lumbridge entry to Draynor bank');
            if (!(await s.bot.openBank()).success) end(false, 'finite food entry bank unavailable');
            const f = s.sdk.findBankItem(FEATHER);
            const heldFeathers = countItems(s, FEATHER);
            if (heldFeathers + (f?.count ?? 0) < FINITE.flyCap) end(false, 'finite food missing owned feather budget');
            if (heldFeathers > FINITE.flyCap) await s.bot.depositItem(FEATHER, heldFeathers - FINITE.flyCap);
            if (heldFeathers < FINITE.flyCap) await s.bot.withdrawItem(FEATHER, FINITE.flyCap - heldFeathers);
            if (countItems(s, FEATHER) !== FINITE.flyCap) end(false, 'finite feather withdrawal unobserved');
            if (!countItems(s, ROD) && !s.sdk.findBankItem(ROD) && countItems(s, /^coins$/i) + (s.sdk.findBankItem(/^coins$/i)?.count ?? 0) < 5) {
                end(false, 'finite food missing5 coins for rod');
            }
            if (fish() < 20 && !countItems(s, /^small fishing net$/i) && !s.sdk.findBankItem(/^small fishing net$/i)) {
                end(false, 'finite food requires owned small fishing net');
            }
            await s.bot.closeBank();
            lastCatchTick = s.tick();
        }
        if (EXTERNAL_REFILL && (fish() < 20 || cook() < 25)) end(false, 'external refill requires Fishing20 and Cooking25');
        if (fish() < 20) await trainNetFishing();
        if (slotOf(ROD) === undefined) {
            const o = await s.bot.openBank();
            if (FINITE && !o.success) end(false, 'finite bank unavailable');
            if (o.success) {
                await s.bot.withdrawItem(ROD, 1);
                await fundFishingTool(s, FINITE ? 5 : 25, !FINITE);
                await s.bot.closeBank();
            }
            if (slotOf(ROD) === undefined && (countItems(s, /^coins$/i) >= 5 || countItems(s, /^raw (shrimps|anchovies)$/i) > 0)) {
                console.log('MILESTONE buying fly fishing rod at Port Sarim');
                await go(BANK_TO_SARIM, 'to Gerrant');
                const sh = await s.bot.openShop(/^gerrant$/i);
                if (FINITE && !sh.success) end(false, 'finite rod shop unavailable');
                if (sh.success) {
                    await buyFishingSupplies(s, FINITE ? 0 : Math.max(0, 200 - countItems(s, FEATHER)));
                    if (FINITE && countItems(s, ROD) !== 1) end(false, 'finite rod purchase unobserved');
                    await s.bot.closeShop();
                }
                await go(SARIM_TO_BANK, 'back to Draynor');
            }
        }
        if (slotOf(ROD) === undefined) end(false, 'no fly fishing rod');
        const KEEP_FLY = TICK3 ? /^(fly fishing rod|feather|coins|knife|logs)$/i : /^(fly fishing rod|feather|coins)$/i;
        if (inv().some(i => !KEEP_FLY.test(i.name) && !RAW_FISH.test(i.name))) {
            console.log('MILESTONE cleaning up unneeded starter/junk items at Draynor bank');
            const p = pos();
            if (p && cheb(FC_BANK, p) > 4) await go(FIRE_TO_BANK, 'to Draynor bank for cleanup');
            const o = await s.bot.openBank();
            if (FINITE && !o.success) end(false, 'finite bank unavailable');
            if (o.success) {
                for (const item of [...new Set(inv().filter(i => !KEEP_FLY.test(i.name)).map(i => i.name as string))]) {
                    await s.bot.depositItem(new RegExp(`^${item}$`, 'i'), -1);
                }
                await s.bot.closeBank();
            }
            if (!FINITE) await go(BANK_TO_FLY, 'back to Lumbridge river');
        }
        if (FINITE) await go(BANK_TO_FLY, 'finite initial safe river route');
        let chain: { index: number } | null = null;
        let stillAnim = 0;
        let lastCourierTrip = -1e9;
        const courierWaiting = () => {
            if (!GIVE_TO || s.tick() - lastCourierTrip < 600) return false;
            return cookCourierReady(readCourierStatus(), GIVE_TO, s.name, Date.now(), TARGETED_COLLECTION);
        };
        while (!over() && caught < MAX_CATCHES && (!FINITE || !finiteWork().done)) {
            if (FINITE) {
                if (s.tick() - lastCatchTick > FINITE.noProgressTicks) {
                    logNoSpot('finite fly no progress', true);
                    end(false, 'finite fly no progress');
                }
                const work = finiteWork();
                if (!work.fish || !finiteFoodCanCatch(FINITE, netCaught, flyCaught, 'fly')) {
                    await cookAll();
                    await bankTrip();
                    lastCatchTick = s.tick();
                    if (finiteWork().done) break;
                    if (!finiteFoodCanCatch(FINITE, netCaught, flyCaught, 'fly')) break;
                    await go(BANK_TO_FLY, 'finite refill trip');
                    chain = null;
                    lastCatchTick = s.tick();
                    continue;
                }
            }
            if (randomEventsOf(s)?.busy()) {
                idleTicks++;
                await waitTicks(s, 1);
                continue;
            }
            if (await eatIfLow()) continue;
            if (await troll()) continue;
            if (courierWaiting()) {
                lastCourierTrip = s.tick();
                console.log(`MILESTONE courier waiting at Draynor t=${now()}`);
                await cookAll();
                await bankTrip();
                await handOff(150);
                await go(BANK_TO_FLY, 'back to the river');
                chain = null;
                continue;
            }
            const feathers = countItems(s, FEATHER);
            if (cook() < 15 && cookable().length === 0 && invLen() <= 20) {
                await chickenTrip(Math.max(feathers, FEATHER_MIN), 8);
                await go(FIRE_TO_FLY, 'back to the river');
                continue;
            }
            if (feathers < (FINITE ? 1 : FEATHER_MIN)) {
                if (countItems(s, RAW_FISH) > 0 || cookedInPack() > 0) {
                    await cookAll();
                    await bankTrip();
                    await go(BANK_TO_FLY, 'back to the river');
                    continue;
                }
                if (EXTERNAL_REFILL || FINITE) break;
                await restockFeathersFromShop();
                await go(BANK_TO_FLY, 'back to the river');
                continue;
            }
            if (invLen() >= 28) {
                await cookAll();
                await bankTrip();
                await go(BANK_TO_FLY, 'back to the river');
                chain = null;
                continue;
            }
            const f0 = s.tick();
            const raw0 = countItems(s, RAW_FISH);
            const sp = (st()?.nearbyNpcs ?? [])
                .filter((n: any) => finiteFoodSpotAllowed(n, !!FINITE))
                .sort((a: any, b: any) => a.distance - b.distance)[0] as any;
            if (!sp) {
                logNoSpot('no allowed lure NPC');
                const p = pos();
                if (!p || cheb(FLY_SPOT, p) > 3) await walk([[FLY_SPOT.x, FLY_SPOT.z, 1]]);
                else if (++noSpot > 5 && countItems(s, RAW_FISH) > 0) {
                    noSpot = 0;
                    spotWaits++;
                    await cookAll();
                    await bankTrip();
                    await go(BANK_TO_FLY, 'back to the river');
                    chain = null;
                    continue;
                } else if (noSpot > 5 && invLen() <= 18) {
                    noSpot = 0;
                    spotWaits++;
                    if (feathers < 50) await restockFeathersFromShop();
                    else {
                        idleTicks++;
                        await waitTicks(s, 2);
                    }
                    chain = null;
                    continue;
                } else {
                    idleTicks++;
                    await waitTicks(s, 1);
                }
                fishTicks += s.tick() - f0;
                continue;
            }
            noSpot = 0;
            const lure = sp.optionsWithIndex.find((o: any) => LURE.test(o.text)).opIndex;
            if (s.sdk.getDialog()?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
            if (sp.distance > 1) {
                activeFishingIndex = sp.index;
                await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: lure, reason: 'SDK' });
                await waitUntil(s, () => ((st()?.nearbyNpcs ?? []).find((n: any) => n.index === sp.index)?.distance ?? 99) <= 1, {
                    timeoutTicks: 10,
                });
                chain = { index: sp.index };
            } else {
                const knife = slotOf(/^knife$/i);
                const log = slotOf(/^logs$/i);
                if (TICK3 && knife !== undefined && log !== undefined) {
                    await s.direct({ type: 'useItemOnItem', sourceSlot: knife, targetSlot: log, reason: 'SDK' });
                    await s.direct({ type: 'clickComponent', componentId: make1, reason: 'SDK' });
                    activeFishingIndex = sp.index;
                    await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: lure, reason: 'SDK' });
                    cycles++;
                    await waitTicks(s, 3);
                } else {
                    stillAnim = (pos()?.animId ?? -1) === -1 ? stillAnim + 1 : 0;
                    if (chain?.index !== sp.index || stillAnim >= 2) {
                        activeFishingIndex = sp.index;
                        await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: lure, reason: 'SDK' });
                        chain = { index: sp.index };
                        stillAnim = 0;
                        reclicks++;
                    }
                    await waitTicks(s, 1);
                }
            }
            caught += Math.max(0, countItems(s, RAW_FISH) - raw0);
            fishTicks += s.tick() - f0;
        }
        if (FINITE && finiteWork().done) {
            end(finiteFoodExitReady(FINITE, finiteWork().done, netCaught, flyCaught, over(), pos()), 'finite exact food output');
        }
        if (died) end(false, 'died');
        if (FINITE && over()) end(false, finiteHurt ? 'finite damage/death guard' : 'finite tick/stop budget');
        if (existsSync(stopFile)) end(false, 'stopped');
        if (cookable().length > 0 || chain !== null) {
            const rawAtLimit = countItems(s, RAW_FISH);
            await go(TO_FIRE, 'final cooking checkpoint');
            caught += Math.max(0, countItems(s, RAW_FISH) - rawAtLimit);
            await cookAll();
        }
        await bankTrip();
        if (FINITE) return end(finiteFoodExitReady(FINITE, finiteWork().done, netCaught, flyCaught, over(), pos()), 'finite food target/catch budget');
        return end(true, 'ticks');
    } catch (e) {
        if (e instanceof FishcookEnd) {
            return {
                ok: e.outcome.ok,
                kind: e.outcome.ok ? 'completed' : 'failed',
                detail: e.outcome.detail,
                delta: { elapsedTicks: e.outcome.ticks },
                recoverable: !e.outcome.ok,
                summary: e.outcome.summary,
                resultLine: e.outcome.detail,
            };
        }
        throw e;
    } finally {
        off();
    }
}

// ---------------------------------------------------------------------------
// 6. Unified Fishing Session & CLI
// ---------------------------------------------------------------------------
function parseVillageOrder(cfg: NormalizedGatherConfig): VillageOrder {
    const rawPath = cfg.args[0];
    if (rawPath && rawPath.startsWith('{')) return JSON.parse(rawPath) as VillageOrder;
    if (rawPath && existsSync(rawPath)) return JSON.parse(readFileSync(rawPath, 'utf8')) as VillageOrder;
    const method = ((cfg.spot === 'riverBait' || resolveSetting(cfg, 'VILLAGE_METHOD') === 'riverBait') ? 'riverBait' : 'fly') as 'fly' | 'riverBait';
    const mode = (resolveSetting(cfg, 'VILLAGE_MODE') ?? (cfg.handling === 'drop' ? 'DROP_RAW' : cfg.handling === 'cook' ? 'COOK_AND_BANK' : 'COOK_AND_BANK')) as VillageMode;
    return {
        method,
        mode,
        target: cfg.target?.count ?? Number(resolveSetting(cfg, 'TARGET') ?? 10),
        batch: Number(resolveSetting(cfg, 'BATCH') ?? 10),
        reserve: Number(resolveSetting(cfg, 'RESERVE') ?? 0),
        cap: cfg.target?.capTicks ?? Number(resolveSetting(cfg, 'CAP') ?? 3000),
        returnTicks: Number(resolveSetting(cfg, 'RETURN_TICKS') ?? 400),
        xpRate: Number(resolveSetting(cfg, 'FISHING_XP_RATE') ?? 25),
    };
}

export const KARAMBWANJI_LAKE = { x: 2801, z: 3009, level: 0 } as const;
export const KARAMBWAN_POINT = { x: 2901, z: 3113, level: 0 } as const;
export const SHILO_FISH_BANK = { x: 2852, z: 2955, level: 0 } as const;
export const DRAYNOR_FISH_BANK = { x: 3092, z: 3243, level: 0 } as const;

export function karambwanBankTile(
    completedQuests: ReadonlySet<string> = new Set(),
    bankOverride?: string,
): { x: number; z: number; level: number } {
    const override = bankOverride?.trim().toLowerCase();
    if (override === 'draynor') return { ...DRAYNOR_FISH_BANK };
    if (override === 'shilo') return { ...SHILO_FISH_BANK };
    for (const q of completedQuests) {
        if (/shilo|zombiequeen/i.test(q)) return { ...SHILO_FISH_BANK };
    }
    return { ...DRAYNOR_FISH_BANK };
}

export function karambwanTripCapacity(freeSlots: number, hasLoadedVessel: boolean): number {
    return Math.max(0, freeSlots - (hasLoadedVessel ? 1 : 0));
}

export async function runBankedKarambwanFishing(
    s: Session,
    method: 'karambwanji' | 'karambwan',
    cfg: NormalizedGatherConfig,
    stop: () => boolean,
): Promise<GatherOutcome> {
    const rawTarget =
        cfg.target?.count ??
        (cfg.args[1] !== undefined && /^[0-9]+$/.test(cfg.args[1]) ? Number(cfg.args[1]) : undefined) ??
        Number(resolveSetting(cfg, 'AMOUNT') ?? resolveSetting(cfg, 'TARGET_COUNT') ?? resolveSetting(cfg, 'BATCH_UNITS') ?? 27);
    const target = Number(rawTarget);
    const cap =
        cfg.target?.capTicks ??
        (cfg.args[2] !== undefined && /^[0-9]+$/.test(cfg.args[2]) ? Number(cfg.args[2]) : undefined) ??
        Number(resolveSetting(cfg, 'CAP') ?? 3000);
    if (!Number.isSafeInteger(target) || target < 1 || !Number.isSafeInteger(cap) || cap < 1) {
        throw Error(`invalid banked ${method} fishing target/cap`);
    }
    const profile = FISH_PROFILES[method];
    const primaryId = profile.products[0]!;
    const start = s.tick();
    const used = () => s.tick() - start;
    let ended = false;
    void s.ended?.then(() => { ended = true; });
    const firstPlayer = s.sdk.getState()?.player;
    const over = () => ended || stop() || sessionDied(firstPlayer, s.sdk.getState()?.player) || used() >= cap;
    const pos = () => s.sdk.getState()?.player;
    const inv = () => s.sdk.getInventory();
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const freeSpace = () => 28 - inv().length;
    const bankCount = (id: number) =>
        (s.bankObservation?.()?.items ?? s.sdk.getState()?.bank?.items ?? [])
            .filter(i => i.id === id)
            .reduce((n, i) => n + i.count, 0);

    await waitUntil(s, () => over() || (!!pos() && (s.sdk.getSkill('Fishing')?.level ?? 0) > 0), { timeoutTicks: 20 });
    const fishingLevel = s.sdk.getSkill('Fishing')?.level ?? 0;
    if (fishingLevel < profile.level) {
        const msg = `no fishing progress: ${method} requires Fishing ${profile.level}, observed ${fishingLevel}`;
        return { ok: false, kind: 'refused', detail: msg, delta: { elapsedTicks: used() }, recoverable: false, resultLine: msg };
    }
    const completedQuests = new Set<string>(
        (((s.sdk.getState() as { quests?: readonly { name?: string; state?: string }[] } | undefined)?.quests) ?? [])
            .filter(q => typeof q.name === 'string' && q.state === 'complete')
            .map(q => q.name!.toLowerCase()),
    );
    const bankSpot = karambwanBankTile(completedQuests, resolveSetting(cfg, 'KARAMBWAN_BANK'));
    const fishSpot = method === 'karambwanji' ? KARAMBWANJI_LAKE : KARAMBWAN_POINT;
    const xpRate = Number(resolveSetting(cfg, 'FISHING_XP_RATE') ?? 25);
    const progressTicks = Number(resolveSetting(cfg, 'PROGRESS_TICKS') ?? 420);

    const travel = async (to: { x: number; z: number; level: number }, label: string) => {
        if (over()) throw Error(`banked ${method} stopped before travel to ${label}`);
        const p = pos();
        if (p && p.level === to.level && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= 3) return;
        if (cfg.deps?.walkTargetPersist) {
            const res = await cfg.deps.walkTargetPersist(s, to);
            if (!res.ok) throw Error(`banked ${method} walk to ${label} failed: ${res.detail ?? res.reason ?? 'unreachable'}`);
            return;
        }
        if (p && p.level === to.level && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= 20) {
            const res = await walkPath(await sessionWalker(s), [{ x: to.x, z: to.z, tol: 2 }], { stop: over });
            if (res.ok) return;
        }
        const world = await getWorld();
        const res = await goTo(s, world, to, accountOf(s));
        if (!res.ok) throw Error(`banked ${method} route to ${label} failed: ${res.detail ?? 'unreachable'}`);
    };

    const openBank = async () => {
        const gen = s.bankObservation?.()?.generation ?? 0;
        if (!(await s.bot.openBank()).success) throw Error(`banked ${method}: openBank failed`);
        await waitUntil(
            s,
            () => over() || (!!s.sdk.getState()?.bank?.isOpen && (!s.bankObservation || (s.bankObservation()?.generation ?? 0) > gen)),
            { timeoutTicks: 15 },
        );
        if (!s.sdk.getState()?.bank?.isOpen) throw Error(`banked ${method}: bank did not open`);
    };

    const closeBank = async () => {
        await s.bot.closeBank();
        await waitUntil(s, () => over() || !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 10 });
    };

    const withdrawOne = async (id: number, n: number) => {
        if (n < 1) return;
        const row = (s.sdk.getState()?.bank?.items ?? []).find(i => i.id === id);
        const before = held(id);
        if (!row || bankCount(id) < n) throw Error(`next acquisition: item ${id} needs ${n}, bank holds ${bankCount(id)}`);
        if (!(await s.bot.withdrawItem(row, n, { asNote: false })).success) {
            throw Error(`banked ${method}: withdraw item ${id} refused`);
        }
        await waitUntil(s, () => over() || held(id) >= before + n, { timeoutTicks: 10 });
    };

    let banked = 0;
    let trips = 0;
    let failure = '';
    const keepSet = method === 'karambwanji' ? new Set([303]) : new Set([3157, 3159, 3150]);
    try {
        while (banked < target && !over()) {
            await travel(bankSpot, 'bank');
            await openBank();
            const primaryBeforeDeposit = held(primaryId);
            for (const id of new Set(inv().map(i => i.id))) {
                if (keepSet.has(id)) continue;
                const item = inv().find(i => i.id === id);
                if (item) await depositObserved(s, item);
            }
            if (method === 'karambwanji') {
                // Also deposit any pre-existing karambwanji before starting a fresh trip.
                const heldBait = inv().find(i => i.id === 3150);
                if (heldBait) await depositObserved(s, heldBait);
            }
            banked += Math.max(0, primaryBeforeDeposit - held(primaryId));
            if (banked >= target || over()) {
                await closeBank();
                break;
            }
            if (method === 'karambwanji') {
                if (held(303) < 1) {
                    if (bankCount(303) < 1) throw Error('next acquisition: small fishing net 303 required for karambwanji');
                    await withdrawOne(303, 1);
                }
            } else {
                if (held(3157) < 1 && held(3159) < 1) {
                    if (bankCount(3159) > 0) await withdrawOne(3159, 1);
                    else if (bankCount(3157) > 0) await withdrawOne(3157, 1);
                    else throw Error('next acquisition: karambwan vessel 3157 required for karambwan');
                }
                const hasLoaded = held(3159) > 0;
                const capSlots = karambwanTripCapacity(freeSpace(), hasLoaded);
                const remaining = Math.max(0, target - banked - (hasLoaded ? 1 : 0) - held(3150));
                const wantBait = Math.min(capSlots, remaining, bankCount(3150));
                if (wantBait > 0) await withdrawOne(3150, wantBait);
                if (held(3150) === 0 && !hasLoaded) {
                    await closeBank();
                    if (banked > 0) break;
                    throw Error('next acquisition: raw karambwanji 3150 required for karambwan');
                }
            }
            await closeBank();

            const tripAmount =
                method === 'karambwanji'
                    ? Math.min(target - banked, freeSpace())
                    : Math.min(target - banked, held(3150) + (held(3159) > 0 ? 1 : 0));
            if (tripAmount < 1) break;

            await travel(fishSpot, `${method} fishing spot`);
            const remainingTicks = Math.max(1, cap - used());
            try {
                await runStagedFishing(createFishingDriver(s, over), {
                    method,
                    amount: tripAmount,
                    cap: remainingTicks,
                    maxAttempts: Math.max(40, tripAmount * 4),
                    progressTicks,
                    xpRate,
                });
            } catch (fishErr) {
                // Karambwan casts can miss and consume bait before hitting tripAmount; bank the caught fish and resupply.
                if (!(method === 'karambwan' && /fishing bait exhausted/i.test(String(fishErr)) && held(primaryId) > 0)) {
                    throw fishErr;
                }
            }

            await travel(bankSpot, 'bank');
            await openBank();
            const beforeBank = held(primaryId);
            for (const id of new Set(inv().map(i => i.id))) {
                if (method === 'karambwanji' && id === 303) continue;
                if (method === 'karambwan' && (id === 3157 || id === 3159)) continue;
                const item = inv().find(i => i.id === id);
                if (item) await depositObserved(s, item);
            }
            const deposited = Math.max(0, beforeBank - held(primaryId));
            banked += deposited;
            trips++;
            await closeBank();
        }
    } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
    }
    const ok = !failure && banked > 0 && !sessionDied(firstPlayer, s.sdk.getState()?.player);
    const line = `banked_${method} ok=${ok} banked=${banked} target=${target} trips=${trips} ticks=${used()}${failure ? ` failure=${failure}` : ''}`;
    return {
        ok,
        kind: ok ? 'completed' : sessionDied(firstPlayer, s.sdk.getState()?.player) ? 'died' : 'failed',
        detail: line,
        delta: { items: { [primaryId]: banked }, elapsedTicks: used() },
        recoverable: !ok,
        summary: { method, banked, target, trips, ticks: used(), ...(failure ? { failure } : {}) },
        resultLine: line,
    };
}

export async function runFishingSession(s: Session, cfg: NormalizedGatherConfig, stop: () => boolean): Promise<GatherOutcome> {
    switch (cfg.method) {
        case 'karambwanji':
        case 'karambwan':
            return runBankedKarambwanFishing(s, cfg.method, cfg, stop);
        case 'shark': {
            const r = await supplySharks(s, {
                ...effectiveSharkOrder(cfg),
                stop,
                cookSharks: cfg.deps?.cookSharks,
            });
            console.log('SHARK_ORDER_RESULT ' + JSON.stringify(r));
            const line = sharkSummary(r);
            return {
                ok: r.ok,
                kind: r.ok ? 'completed' : r.died ? 'died' : 'failed',
                detail: line,
                delta: { items: { 385: r.banked }, elapsedTicks: r.ticks },
                recoverable: !r.ok,
                summary: r,
                resultLine: line,
            };
        }
        case 'cage':
        case 'harpoon':
            return runCatherbyGatherFish(s, cfg, stop);
        case 'fishcook':
            return runFishcook(s, cfg, stop);
        case 'village': {
            const o = parseVillageOrder(cfg);
            const r = await runVillageFishing(s, o, stop, {
                bank: cfg.deps?.runBankProfile,
                cookingRecipes: cfg.deps?.cookingRecipes,
                nativeHeatSources: cfg.deps?.nativeHeatSources,
                runCookingBatch: cfg.deps?.runCookingBatch,
            });
            const line = 'VILLAGE_FISHING ' + JSON.stringify(r);
            console.log(line);
            return {
                ok: r.ok,
                kind: r.ok ? 'completed' : 'failed',
                detail: line,
                delta: { elapsedTicks: r.ticks ?? 0 },
                recoverable: !r.ok,
                summary: r,
                resultLine: line,
            };
        }
        case 'staged': {
            const rawMethod = cfg.spot ?? cfg.args[0] ?? resolveSetting(cfg, 'METHOD') ?? 'fly';
            if ((rawMethod === 'karambwanji' || rawMethod === 'karambwan') && (resolveSetting(cfg, 'BANKED') === '1' || cfg.handling === 'bank')) {
                return runBankedKarambwanFishing(s, rawMethod, cfg, stop);
            }
            const amount = cfg.target?.count ?? Number(cfg.args[1] ?? resolveSetting(cfg, 'AMOUNT') ?? 10);
            const cap = cfg.target?.capTicks ?? Number(cfg.args[2] ?? resolveSetting(cfg, 'CAP') ?? 1000);
            if (!(rawMethod in FISH_PROFILES) && rawMethod !== 'shark') throw Error('account method amount cap required');
            if (!Number.isSafeInteger(amount) || amount < 1 || !Number.isSafeInteger(cap) || cap < 1) {
                throw Error('account method amount cap required');
            }
            const start = s.tick();
            const entry = s.sdk.getState();
            const entryHp = entry ? fishingStateHp(entry) : 0;
            const knife =
                resolveSetting(cfg, 'FISH_KNIFE') === '1'
                    ? { make1: componentId('skill_multi3:make1_a'), drop: resolveSetting(cfg, 'FISH_DROP') === '1' }
                    : undefined;
            const catches: { tick: number; xp: number }[] = [];
            let seen = entry ? fishingStateXp(entry) : 0;
            const offRate = s.onTick(() => {
                const now = s.sdk.getState();
                const x = now ? fishingStateXp(now) : seen;
                if (x > seen) catches.push({ tick: s.tick(), xp: x });
                seen = x;
            });
            try {
                const result =
                    rawMethod === 'shark'
                        ? await catchSharks(s, amount, () => {
                              const current = s.sdk.getState();
                              return (
                                  stop() ||
                                  s.tick() - start >= cap ||
                                  !current?.player ||
                                  entryHp < 1 ||
                                  fishingStateHp(current) !== entryHp ||
                                  current.player.lifeId !== entry?.player?.lifeId ||
                                  current.player.level !== entry?.player?.level
                              );
                          })
                        : await runStagedFishing(createFishingDriver(s, stop), {
                              method: rawMethod as FishMethod,
                              amount,
                              cap,
                              maxAttempts: Number(resolveSetting(cfg, 'MAX_ATTEMPTS') ?? 100),
                              progressTicks: Number(resolveSetting(cfg, 'PROGRESS_TICKS') ?? 420),
                              xpRate: Number(resolveSetting(cfg, 'FISHING_XP_RATE') ?? 25),
                              ...(resolveSetting(cfg, 'FISH_UNTIL_LEVEL') ? { untilLevel: Number(resolveSetting(cfg, 'FISH_UNTIL_LEVEL')) } : {}),
                              knife,
                          });
                offRate();
                if (catches.length > 1) {
                    const a = catches[0]!;
                    const b = catches.at(-1)!;
                    const per = (b.tick - a.tick) / (catches.length - 1);
                    console.log(
                        `FISH_RATE method=${rawMethod} knife=${knife ? 1 : 0} catches=${catches.length} ticksPerCatch=${per.toFixed(2)} xpPerTick=${((b.xp - a.xp) / (b.tick - a.tick)).toFixed(1)} runTicks=${s.tick() - start}`,
                    );
                }
                const line = JSON.stringify(result);
                return {
                    ok: true,
                    kind: 'completed',
                    detail: line,
                    delta: { elapsedTicks: s.tick() - start },
                    recoverable: false,
                    summary: result,
                    resultLine: line,
                };
            } finally {
                offRate();
            }
        }
        default:
            return {
                ok: false,
                kind: 'refused',
                detail: `unknown fishing method: ${cfg.method}`,
                delta: { elapsedTicks: 0 },
                recoverable: false,
            };
    }
}

export async function runFishingCli(account: string, cfg: NormalizedGatherConfig): Promise<number> {
    if (cfg.method === 'village') {
        const order = parseVillageOrder(cfg);
        villagePolicy(order, cfg.deps?.cookingRecipes?.().recipes);
        let stopped = false;
        const s = await openBot(account, { onStop: async () => { stopped = true; } });
        let ok = false;
        try {
            const outcome = await runFishingSession(s, cfg, () => stopped);
            ok = outcome.ok;
        } finally {
            ok = await settle([s], ok, 'finite village fishing order');
        }
        process.exitCode = ok ? 0 : 1;
        return ok ? 0 : 1;
    }

    let journal: string | undefined;
    if (cfg.method === 'shark') {
        const orderKey = resolveSetting(cfg, 'ORDER_KEY');
        if (orderKey) {
            const config = effectiveSharkOrder(cfg);
            const problem = sharkOrderProblem(config);
            if (problem) {
                await finish([], false, problem);
                return 1;
            }
            try {
                journal = claimSharkOrder(SHARK_ORDER_DIR, account, orderKey, config);
            } catch (e) {
                await finish([], false, String(e));
                return 1;
            }
        }
    }

    let stopped = false;
    const s = await openBot(account, {
        onStop: async () => {
            stopped = true;
        },
    }).catch(e => finish([], false, `login: ${String(e)}`));
    try {
        const outcome = await runFishingSession(s, cfg, () => stopped);
        if (cfg.method === 'shark' && journal && outcome.summary) {
            settleSharkOrder(journal, outcome.summary as any);
        }
        await finish([s], outcome.ok, outcome.resultLine ?? outcome.detail ?? '');
        return outcome.ok ? 0 : 1;
    } catch (e) {
        await finish([s], false, String(e));
        return 1;
    }
}
