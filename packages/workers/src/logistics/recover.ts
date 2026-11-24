// Prayer altar restoration, antipoison cure, amulet of glory recharge, and trapped account recovery.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD_PLANK_IDS, DISEMBARK_PLANK_IDS, disembark, pickDisembarkPlank, type BoatSession } from '../../../core/src/boat';
import { accountOf, getWorld, sessionDied } from '../../../core/src/bot';
import { readLabels, type Labels } from '../../../core/src/components';
import { depositObserved } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { pathfindingDataKey } from '../../../core/src/pathcache';
import { wildernessLevel } from '../../../core/src/prayer-guard';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { DECK_REACH, goTo, leaveDeck, sessionWalker, walkPath, type Walker } from '../../../core/src/walk';
import type { Tile } from '../../../core/src/world';
import { BANK_MEETS, classifyLocation, FLUFFS_FENCE, HUB_BANKS, hubTargetFor, inLumberYard, inPaterdomusTemple, isWildernessTile, type LocationClassification } from './location';
import { REPO_ROOT } from './types';
import { leaveTutorial, onTutorialIsland, walkTarget, walkTargetPersist } from './walk';

import {
    GLORY_UNCHARGED,
    PRAYER_ALTARS,
    SAFE_ALTARS,
    altarText,
    canEnterHeroesBasement,
    inWilderness,
    parseAltar,
    parseRecoveryTargetArg,
    type Altar,
} from './preflight';

export {
    GLORY_UNCHARGED,
    PRAYER_ALTARS,
    SAFE_ALTARS,
    altarText,
    canEnterHeroesBasement,
    inWilderness,
    parseAltar,
    parseRecoveryTargetArg,
    type Altar,
};

export const nearestAltar = (at: { x: number; z: number; level: number }, list: readonly Altar[] = SAFE_ALTARS): Altar => {
    let best = list[0]!;
    let bestDist = Infinity;
    for (let i = 0; i < list.length; i++) {
        const a = list[i]!;
        const dx = Math.abs(a.x - at.x);
        const dz = Math.abs(a.z - at.z);
        const d = (dx >= dz ? dx : dz) + (a.level === at.level ? 0 : 50);
        if (d < bestDist) {
            bestDist = d;
            best = a;
        }
    }
    return best;
};

export async function prayAtAltar(s: Session, altar: Altar): Promise<{ ok: boolean; detail: string }> {
    const points = () => s.sdk.getSkill('Prayer')?.level ?? 0, base = () => s.sdk.getSkill('Prayer')?.baseLevel ?? 1;
    if (points() >= base()) return { ok: true, detail: `prayer already full (${points()})` };
    const walk = await walkTarget(s, { x: altar.x, z: altar.z, level: altar.level }, false) as { ok: boolean; reason?: string; detail?: string };
    const p = s.sdk.getState()?.player;
    if (!walk.ok && !(p && p.level === altar.level && Math.max(Math.abs(p.worldX - altar.x), Math.abs(p.worldZ - altar.z)) <= 10)) {
        return { ok: false, detail: `walk to the ${altar.label}: ${walk.reason ?? ''} ${walk.detail ?? ''}`.trim() };
    }
    for (let i = 0; i < 4 && points() < base(); i++) {
        const loc = (s.sdk.getState()?.nearbyLocs ?? []).find(l => l.id === altar.id && l.x === altar.x && l.z === altar.z);
        const pray = loc?.optionsWithIndex.find(o => /^pray/i.test(o.text));
        if (!loc || !pray) return { ok: false, detail: `no Pray option on the ${altar.label} at ${altar.x},${altar.z}` };
        await s.direct({ type: 'interactLoc', x: loc.x, z: loc.z, locId: loc.id, optionIndex: pray.opIndex, reason: 'pray at altar' });
        await waitUntil(s, () => points() >= base(), { timeoutTicks: 15 });
    }
    return points() >= base() ? { ok: true, detail: `prayer ${points()} at the ${altar.label}` } : { ok: false, detail: `prayer ${points()} of ${base()} after praying` };
}

export type AntipoisonRow = { id: number; count: number };
export const ANTIPOISON_IDS: readonly number[] = [2448, 181, 183, 185, 2446, 175, 177, 179];
const ANTIPOISON_DOSE = new Map<number, number>(ANTIPOISON_IDS.map((id, i) => [id, 4 - (i % 4)]));
export const dosesOf = (id: number): number => ANTIPOISON_DOSE.get(id) ?? 4 - (-1 % 4);

export function chooseAntipoison(pack: readonly AntipoisonRow[], bank: readonly AntipoisonRow[]): { where: 'pack' | 'bank'; id: number } | null {
    for (const [where, rows] of [['pack', pack], ['bank', bank]] as const) {
        let bestId = -1;
        let bestDose = Infinity;
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i]!;
            if (r.count <= 0) continue;
            const dose = ANTIPOISON_DOSE.get(r.id);
            if (dose !== undefined && dose < bestDose) {
                bestDose = dose;
                bestId = r.id;
            }
        }
        if (bestId !== -1) return { where, id: bestId };
    }
    return null;
}

export function nearestBank(at: { x: number; z: number }) {
    let best = BANK_MEETS[0]!;
    let bestDist = Infinity;
    for (let i = 0; i < BANK_MEETS.length; i++) {
        const b = BANK_MEETS[i]!;
        const t = b.meet[0];
        const dx = Math.abs(t.x - at.x);
        const dz = Math.abs(t.z - at.z);
        const d = dx >= dz ? dx : dz;
        if (d < bestDist) {
            bestDist = d;
            best = b;
        }
    }
    return best;
}

export async function cureWithAntipoison(s: Session): Promise<{ ok: boolean; detail: string }> {
    const hp = () => s.sdk.getState()?.player?.hp ?? 0;
    const held = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    let choice = chooseAntipoison(s.sdk.getInventory(), []);
    if (!choice) {
        const p = s.sdk.getState()?.player, bank = nearestBank({ x: p?.worldX ?? 0, z: p?.worldZ ?? 0 });
        const meet = bank.meet[0];
        if (!p || p.level !== meet.level || p.worldX !== meet.x || p.worldZ !== meet.z) {
            const walk = await walkTarget(s, meet, false) as { ok: boolean; reason?: string; detail?: string };
            if (!walk.ok) return { ok: false, detail: `walk to the ${bank.bank} bank: ${walk.reason ?? ''} ${walk.detail ?? ''}`.trim() };
        }
        if (!(await s.bot.openBank()).success) return { ok: false, detail: `the ${bank.bank} bank did not open` };
        choice = chooseAntipoison([], s.sdk.getBankItems());
        const row = choice ? s.sdk.getBankItems().find(r => r.id === choice!.id && r.count > 0) : undefined;
        if (!choice || !row) {
            await s.bot.closeBank();
            return { ok: false, detail: 'no antipoison in the pack or in the bank' };
        }
        await s.bot.withdrawItem(row, 1, { asNote: false });
        await s.bot.closeBank();
        if (!held(choice.id)) return { ok: false, detail: `the withdrawal of the antipoison ${choice.id} failed` };
    }
    const potion = s.sdk.getInventory().find(i => i.id === choice!.id), drink = potion?.optionsWithIndex?.find(o => /^drink$/i.test(o.text));
    if (!potion || !drink) return { ok: false, detail: `no Drink option on the antipoison ${choice.id}` };
    const hp0 = hp(), before = held(potion.id);
    await s.sdk.sendUseItem(potion.slot, drink.opIndex);
    const drunk = await waitUntil(s, () => held(potion.id) < before, { timeoutTicks: 8 });
    return drunk
        ? { ok: true, detail: `drank ${potion.name} from the ${choice.where} (hp ${hp0}, then ${hp()})` }
        : { ok: false, detail: `the ${potion.name} was not drunk` };
}

export const GLORY_4 = 1712;
export const FOUNTAIN_ID = 2638;
export const FALADOR_WEST_BANK: Tile = { x: 2946, z: 3368, level: 0 };
export const HEROES_FOUNTAIN_STAND: Tile = { x: 2916, z: 9893, level: 0 };
export const HEROES_FOUNTAIN_TILE: Tile = { x: 2917, z: 9893, level: 0 };

export async function runChargeGlory(
    s: Session,
    opts: { cap?: number; maxGlories?: number; stop?: () => boolean; walk?: (to: Tile) => Promise<{ ok: boolean; reason?: string; detail?: string }> } = {},
) {
    const cap = opts.cap ?? 2000, maxGlories = opts.maxGlories ?? 0;
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('invalid charge-glory tick cap');
    if (!Number.isSafeInteger(maxGlories) || maxGlories < 0) throw Error('invalid MAX_GLORIES');
    const start = s.tick(), st = () => s.sdk.getState(), pos = () => st()?.player, initialLife = pos();
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const stopped = () => ended || !!opts.stop?.() || sessionDied(initialLife, pos()) || existsSync(`.practice/stop-${s.name}`) || s.tick() - start >= cap;
    const inv = () => s.sdk.getInventory();
    const count = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const totalUnchargedInv = () => GLORY_UNCHARGED.reduce((n, id) => n + count(id), 0);
    const bankCount = (id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const totalUnchargedBank = () => GLORY_UNCHARGED.reduce((n, id) => n + bankCount(id), 0);

    if (!await waitUntil(s, () => stopped() || (!!pos() && Array.isArray(st()?.inventory)), { timeoutTicks: 20 })) {
        throw Error('charge-glory startup state unavailable');
    }
    const stateQuests = ((st() as { quests?: readonly { name?: string; state?: string }[] } | undefined)?.quests ?? [])
        .filter(q => typeof q.name === 'string' && q.state === 'complete')
        .map(q => q.name!.toLowerCase());
    const acct = accountOf(s);
    const gate = canEnterHeroesBasement({ ...acct, quests: new Set(stateQuests) });
    if (!gate.ok) throw Error(`next acquisition: ${gate.reason}`);

    const openBank = async () => {
        const gen = s.bankObservation?.()?.generation ?? 0;
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => stopped() || (!!st()?.bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen), { timeoutTicks: 15 })) {
            throw Error('charge-glory bank observation unavailable');
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
        const row = st()?.bank.items.find(i => i.id === id), before = count(id), stored = bankCount(id), gen = s.bankObservation?.()?.generation ?? 0;
        if (!row || stored < n) throw Error(`charge-glory withdraw short: item ${id} needs ${n}, bank holds ${stored}`);
        await s.bot.withdrawItem(row, n, { asNote: false });
        if (!await waitUntil(s, () => stopped() || (count(id) === before + n && bankCount(id) === stored - n && (s.bankObservation?.()?.generation ?? 0) > gen), { timeoutTicks: 10 })) {
            throw Error(`charge-glory withdraw unobserved for item ${id}`);
        }
    };
    const walkTo = async (to: Tile, label: string) => {
        const res = await walkTargetPersist(s, to, 4, opts.walk);
        if (!res.ok) throw Error(`charge-glory walk to ${label} failed: ${res.reason ?? ''} ${res.detail ?? ''}`);
    };

    await walkTo(FALADOR_WEST_BANK, 'Falador West Bank');
    await openBank();
    await depositAll();
    const totalAvailable = totalUnchargedBank();
    if (totalAvailable < 1) {
        await closeBank();
        throw Error('next acquisition: no uncharged Amulet of glory (1704/1706/1708/1710) in bank');
    }

    const goal = maxGlories > 0 ? Math.min(totalAvailable, maxGlories) : totalAvailable;
    let charged = 0;
    while (charged < goal && !stopped()) {
        let want = Math.min(28, goal - charged);
        for (const id of GLORY_UNCHARGED) {
            if (want <= 0) break;
            const take = Math.min(want, bankCount(id));
            if (take > 0) {
                await withdraw(id, take);
                want -= take;
            }
        }
        if (totalUnchargedInv() < 1) break;
        await closeBank();
        await walkTo(HEROES_FOUNTAIN_STAND, 'Fountain of Heroes');
        if (!opts.walk && (pos()?.worldX !== HEROES_FOUNTAIN_STAND.x || pos()?.worldZ !== HEROES_FOUNTAIN_STAND.z)) {
            await walkPath(await sessionWalker(s), [{ ...HEROES_FOUNTAIN_STAND, tol: 0 }], { maxTicks: 30, stop: stopped });
        }
        const fountain = (st()?.nearbyLocs ?? []).find(l => l.id === FOUNTAIN_ID || /fountain of heroes/i.test(l.name));
        if (!fountain) throw Error('fountain of heroes unobserved');
        while (totalUnchargedInv() > 0 && !stopped()) {
            await s.bot.dismissBlockingUI?.();
            const glory = inv().find(i => (GLORY_UNCHARGED as readonly number[]).includes(i.id));
            if (!glory) break;
            const before4 = count(GLORY_4);
            const res = await s.bot.useItemOnLoc(glory, fountain);
            if (!await waitUntil(s, () => stopped() || count(GLORY_4) > before4, { timeoutTicks: 12 })) {
                const cur = pos();
                const msgs = (st()?.gameMessages ?? []).slice(-4).map((m: { text?: string }) => m.text ?? '').join('|');
                throw Error(`glory recharge at Fountain of Heroes unobserved (res=${JSON.stringify(res)} pos=${cur?.worldX},${cur?.worldZ} loc=${fountain.x},${fountain.z},${fountain.id} msgs=${msgs})`);
            }
            await s.bot.dismissBlockingUI?.();
            charged += Math.max(1, count(GLORY_4) - before4);
        }
        await walkTo(FALADOR_WEST_BANK, 'Falador West Bank');
        await openBank();
        await depositAll();
    }
    const bankGlory4 = bankCount(GLORY_4);
    await closeBank();
    return { ok: charged > 0 && !stopped(), charged, bankGlory4, ticks: s.tick() - start };
}

const HUB_BANK_TILES = [HUB_BANKS.varrockWest, HUB_BANKS.ardougneNorth, HUB_BANKS.faladorEast] as const;
const LUMBER_YARD_CRATES = [
    { x: 3305, z: 3500 }, { x: 3310, z: 3499 }, { x: 3307, z: 3507 },
    { x: 3303, z: 3506 }, { x: 3298, z: 3514 }, { x: 3311, z: 3511 },
] as const;

const mainRootCache = new Map<string, string>();
const cachedLabelsByFile = new Map<string, { mtimeMs: number; size: number; key: string; context: { labels?: Labels; hubAreas?: ReadonlySet<number> } }>();

function resolveMainRoot(fromDir: string): string {
    const cached = mainRootCache.get(fromDir);
    if (cached !== undefined) return cached;
    let resolved = fromDir;
    try {
        const list = Bun.spawnSync(['git', '-C', fromDir, 'worktree', 'list', '--porcelain'], { stdout: 'pipe', stderr: 'ignore', windowsHide: true }).stdout.toString();
        const main = /^worktree (.+)$/m.exec(list)?.[1];
        if (main && existsSync(join(main, '.practice'))) resolved = main;
    } catch { /* fall back to fromDir */ }
    mainRootCache.set(fromDir, resolved);
    return resolved;
}

function readCompatibleHeaderSource(file: string, currentKey: string): string | null {
    let fd: number | undefined;
    try {
        fd = openSync(file, 'r');
        const head = Buffer.alloc(4);
        if (readSync(fd, head, 0, 4, 0) !== 4) return null;
        const hl = head.readUInt32LE(0);
        if (hl <= 0 || hl > 65_536) return null;
        const headerBytes = Buffer.alloc(hl);
        if (readSync(fd, headerBytes, 0, hl, 4) !== hl) return null;
        const hdr = JSON.parse(headerBytes.toString('utf8')) as { source?: string };
        if (typeof hdr?.source !== 'string') return null;
        const cur = JSON.parse(currentKey) as { v?: number; wasm?: string; data?: string };
        const stored = JSON.parse(hdr.source) as { v?: number; wasm?: string; data?: string };
        if (cur.v === stored.v && cur.wasm === stored.wasm && cur.data === stored.data) return hdr.source;
        return null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

function loadCachedLabels(rootDir: string, key: string): Labels | undefined {
    const file = join(rootDir, '.practice', 'cache', 'route-areas.bin');
    if (!existsSync(file)) return undefined;
    const direct = readLabels(file, key);
    if (direct) return direct;
    const fallbackSource = readCompatibleHeaderSource(file, key);
    return fallbackSource ? (readLabels(file, fallbackSource) ?? undefined) : undefined;
}

export function loadRecoveryLocationContext(
    rootDir = resolveMainRoot(REPO_ROOT),
): { labels?: Labels; hubAreas?: ReadonlySet<number> } {
    const file = join(rootDir, '.practice', 'cache', 'route-areas.bin');
    let mtimeMs = -1;
    let size = -1;
    try {
        const st = statSync(file);
        mtimeMs = st.mtimeMs;
        size = st.size;
    } catch {
        cachedLabelsByFile.delete(file);
        return {};
    }
    const key = pathfindingDataKey();
    const cached = cachedLabelsByFile.get(file);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size && cached.key === key) {
        return cached.context;
    }
    const labels = loadCachedLabels(rootDir, key);
    if (!labels) {
        const empty = {};
        cachedLabelsByFile.set(file, { mtimeMs, size, key, context: empty });
        return empty;
    }
    const hubAreas = new Set<number>();
    for (const h of HUB_BANK_TILES) {
        const id = labels.area(h.level, h.x, h.z);
        if (id >= 0) hubAreas.add(id);
    }
    const context = { labels, hubAreas: hubAreas.size > 0 ? hubAreas : undefined };
    cachedLabelsByFile.set(file, { mtimeMs, size, key, context });
    return context;
}

function isHealthyHubLoc(classification: LocationClassification): boolean {
    return classification.kind === 'ok';
}

async function climbOutOfHold(s: Session, stop: () => boolean): Promise<boolean> {
    const locs = (s.sdk.getState()?.nearbyLocs ?? []) as any[];
    const ladder = locs
        .filter(l => /ladder/i.test(l.name ?? '') && (l.optionsWithIndex ?? []).some((o: any) => /^climb-?up$/i.test(o.text)))
        .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))[0];
    if (!ladder) return false;
    await s.bot.interactLoc(ladder, 'Climb-up');
    await waitUntil(s, () => stop() || (s.sdk.getState()?.player?.level ?? 0) === 1, { timeoutTicks: 15 });
    return (s.sdk.getState()?.player?.level ?? 0) === 1;
}

async function descendToGround(s: Session, stop: () => boolean): Promise<boolean> {
    for (let step = 0; step < 4 && !stop(); step++) {
        const p = s.sdk.getState()?.player;
        if (!p) return false;
        if (p.level === 0) return true;
        if (p.level === 1 && pickDisembarkPlank(s as unknown as BoatSession, DECK_REACH + 4)) {
            const off = await disembark(s as unknown as BoatSession, { stop });
            if (off.ok) continue;
        }
        const locs = (s.sdk.getState()?.nearbyLocs ?? []) as any[];
        const down = locs
            .filter(l => l.id !== 273 && l.id !== 287 && !/ship'?s?\s*ladder/i.test(l.name ?? ''))
            .map(l => {
                const opts = (l.optionsWithIndex ?? []) as Array<{ text: string; opIndex: number }>;
                const cross = /(gang)?plank/i.test(l.name ?? '') && !BOARD_PLANK_IDS.has(l.id ?? -1)
                    ? opts.find(o => /^cross$/i.test(o.text))
                    : undefined;
                const climb = cross ?? opts.find(o => /^(?:climb|walk)-?down$/i.test(o.text));
                const rank = cross ? (DISEMBARK_PLANK_IDS.has(l.id ?? -1) ? 0 : 1) : 2;
                return climb ? { loc: l, op: climb, rank, dist: l.distance ?? 0 } : null;
            })
            .filter((entry): entry is NonNullable<typeof entry> => !!entry && entry.dist <= 24)
            .sort((a, b) => a.rank - b.rank || a.dist - b.dist)[0];
        if (!down) return false;
        const beforeLevel = p.level;
        await s.bot.interactLoc(down.loc, down.op.opIndex);
        await waitUntil(s, () => stop() || (s.sdk.getState()?.player?.level ?? beforeLevel) !== beforeLevel, { timeoutTicks: 20 });
    }
    return (s.sdk.getState()?.player?.level ?? 1) === 0;
}

async function tryOpenBlockingExitDoor(s: Session, stop: () => boolean): Promise<void> {
    const p = s.sdk.getState()?.player;
    if (!p || !inPaterdomusTemple(p.worldX, p.worldZ, p.level)) return;
    const doors = ((s.sdk.getState()?.nearbyLocs ?? []) as any[])
        .filter(l => /door|gate/i.test(l.name ?? '') && (l.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text)))
        .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    for (const door of doors.slice(0, 2)) {
        if (stop()) break;
        await s.bot.interactLoc(door, 'Open');
        await waitTicks(s, 3);
        const cur = s.sdk.getState()?.player;
        if (cur && !inPaterdomusTemple(cur.worldX, cur.worldZ, cur.level)) return;
    }
}

async function exitLumberYard(s: Session, stop: () => boolean): Promise<void> {
    const cur = () => {
        const p = s.sdk.getState()?.player;
        return p ? { worldX: p.worldX, worldZ: p.worldZ, level: p.level } : undefined;
    };
    const p0 = cur();
    if (!p0 || p0.level !== 0 || !inLumberYard(p0)) return;
    const approachTile = { x: FLUFFS_FENCE.x, z: FLUFFS_FENCE.z + 1, level: 0, tol: 1 };
    const dist = () => {
        const p = cur();
        return p ? Math.max(Math.abs(p.worldX - approachTile.x), Math.abs(p.worldZ - approachTile.z)) : Infinity;
    };
    if (dist() > 1) {
        if ((s as any).client) {
            const pfm = await import('../../../../vendor/rs-sdk/sdk/pathfinding');
            const grid = await import('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
            pfm.initPathfinding();
            const crateTiles = new Map<string, { x: number; z: number; prevMask: number }>();
            const npcs = ((s.sdk.getState()?.nearbyNpcs ?? []) as Array<{ x: number; z: number; name?: string }>)
                .filter(n => /^crate$/i.test(n.name ?? ''));
            for (const c of [...LUMBER_YARD_CRATES, ...npcs]) {
                const key = `${c.x},${c.z}`;
                if (crateTiles.has(key)) continue;
                pfm.isTileWalkable(0, c.x, c.z);
                let prevMask = 0;
                for (let bit = 0; bit < 32; bit++) if (grid.isFlagged(c.x, c.z, 0, 1 << bit)) prevMask |= 1 << bit;
                crateTiles.set(key, { x: c.x, z: c.z, prevMask });
                grid.__set(c.x, c.z, 0, prevMask | 2097152);
            }
            try {
                const walker = await sessionWalker(s);
                await walkPath(walker, [approachTile], { maxTicks: 60, stop });
            } finally {
                for (const { x, z, prevMask } of crateTiles.values()) grid.__set(x, z, 0, prevMask);
            }
        } else {
            await s.bot.walkTo(approachTile.x, approachTile.z, 0);
        }
    }

    for (let tries = 0; tries < 4 && !stop() && inLumberYard(cur()); tries++) {
        const fence = ((s.sdk.getState()?.nearbyLocs ?? []) as any[]).find(
            l => l.id === FLUFFS_FENCE.id || (l.x === FLUFFS_FENCE.x && l.z === FLUFFS_FENCE.z),
        );
        if (fence) {
            const op = (fence.optionsWithIndex ?? []).find((o: any) => /climb|squeeze|cross/i.test(o.text ?? ''))
                ?? fence.optionsWithIndex?.[0];
            await s.bot.interactLoc(fence, op?.opIndex ?? 1);
        } else if (typeof (s as any).direct === 'function') {
            await s.direct({ type: 'interactLoc', x: FLUFFS_FENCE.x, z: FLUFFS_FENCE.z, locId: FLUFFS_FENCE.id, optionIndex: 1, reason: 'SDK' });
        } else {
            await waitTicks(s, 1);
            continue;
        }
        await waitUntil(s, () => stop() || !inLumberYard(cur()), { timeoutTicks: 8 });
    }
}

export async function recoverSessionToHub(
    s: Session,
    options: {
        capTicks?: number;
        target?: { x: number; z: number; level: number };
        stop?: () => boolean;
        labels?: Labels;
        hubAreas?: ReadonlySet<number>;
        rootDir?: string;
        walkToHub?: (s: Session, target: { x: number; z: number; level: number }) => Promise<{ ok: boolean; reason?: string; detail?: string }>;
    } = {},
): Promise<{ ok: boolean; kind: string; detail: string; from: string; to: string }> {
    const cap = options.capTicks ?? 900;
    const t0 = s.tick();
    const p0 = s.sdk.getState()?.player;
    const from = p0 ? `${p0.worldX},${p0.worldZ},${p0.level}` : 'unknown';
    const stop = () => !!options.stop?.() || s.tick() - t0 >= cap || (!!p0 && sessionDied(p0, s.sdk.getState()?.player));
    const classOpts = options.labels !== undefined || options.hubAreas !== undefined
        ? { labels: options.labels, hubAreas: options.hubAreas }
        : loadRecoveryLocationContext(options.rootDir);

    const cur = () => {
        const p = s.sdk.getState()?.player;
        return p ? { worldX: p.worldX, worldZ: p.worldZ, level: p.level } : undefined;
    };
    const pos = cur();
    if (!pos) return { ok: false, kind: 'unknown', detail: 'no player state on login', from, to: from };

    const initial = classifyLocation(pos, classOpts);
    const target = options.target ?? initial.targetHub ?? hubTargetFor(pos);
    if (isWildernessTile(pos) || !initial.autoFixable) {
        return { ok: false, kind: initial.kind, detail: initial.summary, from, to: from };
    }
    if (isWildernessTile({ worldX: target.x, worldZ: target.z, level: target.level })) {
        return { ok: false, kind: 'wilderness', detail: `refusing Wilderness recovery target ${target.x},${target.z}`, from, to: from };
    }

    if (onTutorialIsland(s.sdk.getState()?.player)) {
        const tut = await leaveTutorial(s, () => s.bot.skipTutorial(), () => Promise.resolve(), stop);
        if (tut && !tut.ok) {
            const end = cur();
            return { ok: false, kind: initial.kind, detail: `tutorial skip failed: ${tut.reason ?? ''} ${tut.detail ?? ''}`.trim(), from, to: end ? `${end.worldX},${end.worldZ},${end.level}` : from };
        }
    }

    const afterTut = cur();
    if (afterTut?.level === 0 && classifyLocation(afterTut, classOpts).kind === 'ship_hold') {
        await climbOutOfHold(s, stop);
    }

    const afterHold = cur();
    if (afterHold && afterHold.level > 0) {
        if (afterHold.level === 1 && pickDisembarkPlank(s as unknown as BoatSession, DECK_REACH + 4)) {
            await leaveDeck(s as unknown as Walker, stop);
        }
        const now = cur();
        if (now && now.level > 0) await descendToGround(s, stop);
    }

    const afterFloor = cur();
    if (afterFloor && inPaterdomusTemple(afterFloor.worldX, afterFloor.worldZ, afterFloor.level)) {
        await tryOpenBlockingExitDoor(s, stop);
    }
    await exitLumberYard(s, stop);

    const beforeRoute = cur();
    if (!beforeRoute) return { ok: false, kind: initial.kind, detail: 'lost player state during recovery', from, to: from };

    const distToTarget = beforeRoute.level === target.level ? Math.max(Math.abs(beforeRoute.worldX - target.x), Math.abs(beforeRoute.worldZ - target.z)) : Infinity;
    const curClass = classifyLocation(beforeRoute, classOpts);
    if (beforeRoute.level !== 0 || !isHealthyHubLoc(curClass) || distToTarget > 20) {
        if (options.walkToHub) {
            const routed = await options.walkToHub(s, target);
            if (!routed.ok) {
                const end = cur();
                const at = end ? `${end.worldX},${end.worldZ},${end.level}` : 'unknown';
                return { ok: false, kind: initial.kind, detail: `route failed: ${routed.reason ?? ''} ${routed.detail ?? ''}`.trim(), from, to: at };
            }
        } else {
            const res = await walkTargetPersist(s, target, 4, t => walkTarget(s, t, false, undefined, { noJewelry: true }));
            if (!res.ok) {
                const world = await getWorld();
                const fallback = await goTo(s, world, target, { skills: {}, varps: {}, items: [] }, { legTimeoutTicks: 120, noJewelry: true });
                if (!fallback.ok) {
                    const end = cur();
                    const at = end ? `${end.worldX},${end.worldZ},${end.level}` : 'unknown';
                    return { ok: false, kind: initial.kind, detail: `route failed: ${fallback.reason ?? res.reason ?? ''} ${fallback.detail ?? res.detail ?? ''}`.trim(), from, to: at };
                }
            }
        }
    }

    const end = cur();
    const to = end ? `${end.worldX},${end.worldZ},${end.level}` : 'unknown';
    const finalClass = end ? classifyLocation(end, classOpts) : initial;
    const ok = !!end && end.level === 0 && isHealthyHubLoc(finalClass);
    return {
        ok,
        kind: initial.kind,
        detail: ok ? `recovered from ${initial.kind} (${from}) to ${to}` : `ended still ${finalClass.kind} at ${to}`,
        from,
        to,
    };
}
