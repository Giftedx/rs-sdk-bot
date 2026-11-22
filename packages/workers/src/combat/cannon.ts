import { PRAYER_NAMES, type PrayerName } from '../../../../vendor/rs-sdk/sdk/types';
import { accountOf, countItems, finish, getWorld, openBot, sessionDied } from '../../../core/src/bot';
import type { Session } from '../../../core/src/inprocess';
import { componentId } from '../../../core/src/logout';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import { gearById, reconcileCombatLoadout } from './gear';
import { combatFerryWalk } from './survivability';
import type { CombatSession, CombatTile } from './types';

export type CannonSpot = {
    label: string;
    centre: CombatTile;
    target: string;
    prayer: PrayerName | 'none';
    near: number;
    clear?: CombatTile;
};

export const CANNON_SPOTS: Readonly<Record<string, CannonSpot>> = {
    spiders: {
        label: 'Wilderness poison spiders',
        centre: { x: 3287, z: 3810, level: 0 },
        target: '^poison spider$',
        prayer: 'protect_from_melee',
        near: 10,
        clear: { x: 3287, z: 3755, level: 0 },
    },
    battlefield: {
        label: 'Gnome battlefield troopers',
        centre: { x: 2525, z: 3242, level: 0 },
        target: '^khazard trooper$',
        prayer: 'none',
        near: 10,
    },
};

export const CANNON_PARTS = [/^cannon base$/i, /^cannon stand$/i, /^cannon barrels$/i, /^cannon furnace$/i] as const;
export const CANNON_BALL = /^cannonball$/i;
const FOOD = /^(shrimps|trout|salmon|tuna|lobster|swordfish|bass|pike|cooked karambwan|karambwan|anchovy pizza|pineapple pizza|shark)$/i;
const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

export function loadedBalls(text: string): number {
    const m = text.match(/^You load the cannon with (\d+) cannonballs\.$/);
    return m ? Number(m[1]) : 0;
}

export function reloadDue(o: { now: number; lastLoad: number; interval: number; empty: boolean }): boolean {
    return o.empty || o.now - o.lastLoad >= o.interval;
}

export type TargetNpc = {
    index: number;
    name: string;
    x: number;
    z: number;
    hp: number | null;
    distance: number;
    targetIndex: number;
    reachable?: boolean;
    optionsWithIndex: { text: string; opIndex: number }[];
};

export function pickTarget(
    npcs: readonly TargetNpc[],
    o: { target: RegExp; centre: { x: number; z: number }; me: { x: number; z: number }; near: number; reach: number; skip: (index: number) => boolean },
): TargetNpc | undefined {
    const close = (n: TargetNpc) => Number(cheb(n, o.me) <= 1);
    return npcs
        .filter(
            n =>
                o.target.test(n.name)
                && (n.hp ?? 1) > 0
                && n.reachable !== false
                && !o.skip(n.index)
                && n.optionsWithIndex.some(p => /^attack$/i.test(p.text))
                && cheb(n, o.centre) <= o.near
                && cheb(n, o.me) <= o.reach,
        )
        .sort((a, b) => close(b) - close(a) || (a.hp ?? 99) - (b.hp ?? 99) || a.distance - b.distance)[0];
}

export function bandTicks(levelAt: ReadonlyMap<number, number>, bands: readonly number[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i + 1 < bands.length; i++) {
        const a = levelAt.get(bands[i]!);
        const b = levelAt.get(bands[i + 1]!);
        if (a !== undefined && b !== undefined) out[`${bands[i]}-${bands[i + 1]}`] = b - a;
    }
    return out;
}

function messageFeed(s: CombatSession) {
    const seen = new Set<string>();
    const all: string[] = [];
    const off = s.onTick(() => {
        for (const m of s.sdk.getState()?.gameMessages ?? []) {
            const k = `${m.observationId ?? ''}:${m.tick}:${m.text}`;
            if (!seen.has(k)) {
                seen.add(k);
                all.push(m.text);
            }
        }
    });
    return { all, mark: () => all.length, saw: (re: RegExp, from: number) => all.slice(from).some(t => re.test(t)), off };
}

export type PlacedCannon = { x: number; z: number; id: number; centre: { x: number; z: number }; setupTicks: number };
const findCannon = (s: CombatSession) => (s.sdk.getState()?.nearbyLocs ?? []).filter(l => /cannon/i.test(l.name)).sort((a, b) => a.distance - b.distance)[0];

export async function setupCannon(s: CombatSession, o: { centre?: { x: number; z: number }; avoidOld?: boolean } = {}): Promise<PlacedCannon> {
    const feed = messageFeed(s);
    const t0 = s.tick();
    const me = () => s.sdk.getState()!.player!;
    const slot = (re: RegExp) => s.sdk.getInventory().find(i => re.test(i.name));
    try {
        const base = slot(CANNON_PARTS[0]);
        if (!base) throw Error('no cannon base in pack');
        for (const part of CANNON_PARTS.slice(1)) if (!slot(part)) throw Error(`no ${part.source} in pack`);
        if (!slot(CANNON_BALL)) throw Error('no cannonballs in pack');
        const op = base.optionsWithIndex.find(p => /set-?up/i.test(p.text))?.opIndex ?? 1;
        if (o.centre && cheb({ x: me().worldX, z: me().worldZ }, o.centre) > 0) {
            await s.bot.walkTo(o.centre.x, o.centre.z, 0);
            await waitTicks(s, 1);
        }
        if (o.avoidOld) {
            const p0 = me();
            for (const [dx, dz] of [
                [0, 0],
                [8, 0],
                [-8, 4],
                [4, 8],
                [-6, -6],
                [10, 8],
            ]) {
                const c = findCannon(s);
                const sx = p0.worldX + dx!;
                const sz = p0.worldZ + dz!;
                if (!c || cheb({ x: c.x + 1, z: c.z + 1 }, { x: sx, z: sz }) >= 6) {
                    if (dx || dz) {
                        await s.bot.walkTo(sx, sz, 0);
                        await waitTicks(s, 1);
                    }
                    break;
                }
            }
        }
        const ring: number[][] = [[0, 0]];
        for (let r = 1; r <= 6; r++) {
            for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) ring.push([dx, dz]);
        }
        const p1 = me();
        let m0 = feed.mark();
        let placed = false;
        let tries = 0;
        for (const [dx, dz] of ring) {
            if (tries >= 30) break;
            if (dx || dz) {
                const w = await s.bot.walkTo(p1.worldX + dx!, p1.worldZ + dz!, 0);
                if (!w.success) continue;
                await waitTicks(s, 1);
            }
            m0 = feed.mark();
            tries++;
            const setupSlot = slot(CANNON_PARTS[0])!.slot;
            const sent = (await s.direct({ type: 'useInventoryItem', slot: setupSlot, optionIndex: op, reason: 'cannon set-up' })) as
                | { success?: boolean; message?: string; reason?: string }
                | undefined;
            if (sent?.success === false) {
                throw Error(`cannon set-up dispatch rejected: ${sent.message ?? sent.reason ?? 'unknown refusal'} (slot=${setupSlot} option=${op})`);
            }
            await waitUntil(s, () => feed.saw(/place the cannon base|can't|cannot|isn't enough|won't be happy|not permitted|too dank/i, m0), { timeoutTicks: 8 });
            if (feed.saw(/place the cannon base/i, m0)) {
                placed = true;
                break;
            }
            if (!feed.saw(/isn't enough space/i, m0)) break;
        }
        if (!placed) throw Error(`cannon base not placed after ${tries} tries: ${feed.all.slice(m0).join(' | ')}`);
        await waitTicks(s, 1);
        for (const part of CANNON_PARTS.slice(1)) {
            const item = slot(part);
            const l = findCannon(s);
            if (!item || !l) throw Error(`missing ${part.source} or cannon loc`);
            await s.direct({ type: 'useItemOnLoc', itemSlot: item.slot, x: l.x, z: l.z, locId: l.id, reason: 'cannon set-up' });
            if (
                !(await waitUntil(
                    s,
                    () => {
                        const n = findCannon(s);
                        return !!n && n.id !== l.id;
                    },
                    { timeoutTicks: 8 },
                ))
            ) {
                throw Error(`cannon part not added: ${part.source}`);
            }
        }
        const l = findCannon(s)!;
        const balls = slot(CANNON_BALL)!;
        m0 = feed.mark();
        await s.direct({ type: 'useItemOnLoc', itemSlot: balls.slot, x: l.x, z: l.z, locId: l.id, reason: 'cannon load' });
        if (!(await waitUntil(s, () => feed.saw(/load the cannon/i, m0), { timeoutTicks: 8 }))) throw Error('first cannon load unobserved');
        const fire = l.optionsWithIndex.find(p => /^fire$/i.test(p.text))?.opIndex ?? 1;
        await s.direct({ type: 'interactLoc', x: l.x, z: l.z, locId: l.id, optionIndex: fire, reason: 'cannon fire' });
        await waitTicks(s, 2);
        return { x: l.x, z: l.z, id: l.id, centre: { x: l.x + 1, z: l.z + 1 }, setupTicks: s.tick() - t0 };
    } finally {
        feed.off();
    }
}

export async function pickupCannon(s: CombatSession, c: { x: number; z: number }): Promise<boolean> {
    const l = (s.sdk.getState()?.nearbyLocs ?? []).find(n => n.x === c.x && n.z === c.z && /cannon/i.test(n.name));
    if (!l) return false;
    const op = l.optionsWithIndex.find(p => /pick-?up/i.test(p.text))?.opIndex ?? (/^dwarf multicannon$/i.test(l.name) ? 2 : 1);
    await s.direct({ type: 'interactLoc', x: c.x, z: c.z, locId: l.id, optionIndex: op, reason: 'cannon pick-up' });
    return waitUntil(s, () => !!s.sdk.getInventory().some(i => CANNON_PARTS[0].test(i.name)), { timeoutTicks: 12 });
}

export const CANNON_LIFE = 2500;
export const CANNON_REFRESH = CANNON_LIFE - 100;
export const NULODION = { x: 3011, z: 3453, level: 0 };
export const NULODION_DOOR = { id: 3, x: 3015, z: 3453 };

export type CannonPhase = { weapon?: number; style?: number; until?: Record<string, number> };

export function parseLevels(text: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const part of text
        .split(',')
        .map(p => p.trim())
        .filter(Boolean)) {
        const m = part.match(/^([A-Za-z]+)=(\d+)$/);
        if (!m || Number(m[2]) < 1 || Number(m[2]) > 99) throw Error(`bad level "${part}"`);
        out[m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase()] = Number(m[2]);
    }
    return out;
}

export function parsePhases(text: string): CannonPhase[] {
    return text
        .split(';')
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => {
            const [weapon, style, until] = p.split(':');
            const ph: CannonPhase = {};
            if (weapon) {
                if (!/^\d+$/.test(weapon)) throw Error(`bad phase weapon "${weapon}"`);
                ph.weapon = Number(weapon);
            }
            if (style) {
                if (!/^[0-3]$/.test(style)) throw Error(`bad phase style "${style}"`);
                ph.style = Number(style);
            }
            if (until) ph.until = parseLevels(until);
            return ph;
        });
}

export const levelsMet = (levels: (k: string) => number, want: Record<string, number> | undefined) =>
    !!want && Object.entries(want).every(([k, v]) => levels(k) >= v);

export const MSB = 861;
export const MSB_SPECIAL_COST = 350;
export const specialDue = (o: { special: boolean; weapon: number | undefined; energy: number | undefined; enabled: number | undefined; fighting: boolean }) =>
    o.special && o.weapon === MSB && o.fighting && o.enabled === 0 && (o.energy ?? 0) >= MSB_SPECIAL_COST;

type Walk = (to: CombatTile) => Promise<boolean>;

async function talkToNulodion(
    s: CombatSession,
    pick: RegExp,
    done: () => boolean,
    refuse: RegExp,
    reason: string,
): Promise<'done' | 'refused' | 'absent' | 'timeout'> {
    const me = () => s.sdk.getState()?.player;
    if ((me()?.worldX ?? NULODION_DOOR.x) >= NULODION_DOOR.x) {
        const door = (s.sdk.getState()?.nearbyLocs ?? []).find(l => l.id === NULODION_DOOR.id && l.x === NULODION_DOOR.x && l.z === NULODION_DOOR.z);
        const open = door?.optionsWithIndex.find(p => /^open$/i.test(p.text));
        if (door && open) {
            await s.direct({ type: 'interactLoc', x: door.x, z: door.z, locId: door.id, optionIndex: open.opIndex, reason: 'Nulodion door' });
            await waitTicks(s, 2);
        }
        await s.bot.walkTo(NULODION.x + 1, NULODION.z, 0);
        await waitUntil(s, () => (me()?.worldX ?? NULODION_DOOR.x) < NULODION_DOOR.x, { timeoutTicks: 10 });
    }
    const npc = (s.sdk.getState()?.nearbyNpcs ?? []).find(n => /^nulodion$/i.test(n.name));
    const talk = npc?.optionsWithIndex.find(p => /talk/i.test(p.text));
    if (!npc || !talk) return 'absent';
    await s.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: talk.opIndex, reason: `Nulodion: ${reason}` });
    for (let t = 0; t < 60 && !done(); t++) {
        await waitTicks(s, 1);
        const d = s.sdk.getDialog();
        if (!d?.isOpen || d.isWaiting) continue;
        const option = d.options.find(p => pick.test(p.text));
        if (option) await s.sdk.sendClickDialog(option.index);
        else if (refuse.test([d.text ?? '', ...(d.allComponents ?? []).map(c => c.text)].join(' '))) return 'refused';
        else await s.sdk.sendClickDialog(0);
    }
    return done() ? 'done' : 'timeout';
}

export const CANNON_PRICE = 750_000;

export async function buyCannon(s: CombatSession, o: { walk: Walk }): Promise<{ ok: boolean; detail: string }> {
    const missing = () => CANNON_PARTS.filter(re => !s.sdk.getInventory().some(i => re.test(i.name))).map(re => re.source.replace(/^\^|\$$/g, ''));
    const held = () => missing().length === 0;
    if (held()) return { ok: true, detail: 'cannon already in the pack' };
    if (missing().length < CANNON_PARTS.length) return { ok: false, detail: `incomplete cannon in the pack: missing ${missing().join(', ')}` };
    const coins = s.sdk.getInventory().filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
    if (coins < CANNON_PRICE) return { ok: false, detail: `${coins} coins in the pack, ${CANNON_PRICE} needed` };
    if (s.sdk.getInventory().length > 28 - 6) return { ok: false, detail: 'the cannon needs 6 free pack slots' };
    if (!(await o.walk({ x: NULODION_DOOR.x, z: NULODION_DOOR.z, level: 0 }))) return { ok: false, detail: 'walk to Nulodion failed' };
    const r = await talkToNulodion(s, /sell me a cannon|take a cannon please/i, held, /don't have enough money|doesn't seem interested/i, 'buy cannon');
    return held() ? { ok: true, detail: 'bought' } : { ok: false, detail: `no cannon: ${r}${missing().length < CANNON_PARTS.length ? `, missing ${missing().join(', ')}` : ''}` };
}

export async function reclaimCannon(
    s: CombatSession,
    o: { at?: { x: number; z: number; level?: number }; walk: Walk; nulodion?: boolean; placedAt?: number; maxWait?: number },
): Promise<{ ok: boolean; how: string; detail: string }> {
    const held = () => s.sdk.getInventory().some(i => CANNON_PARTS[0].test(i.name));
    if (held()) return { ok: true, how: 'held', detail: 'cannon base already in the pack' };
    const me = () => s.sdk.getState()?.player;
    const nearCannon = () =>
        (s.sdk.getState()?.nearbyLocs ?? [])
            .filter(l => /cannon/i.test(l.name) && l.optionsWithIndex.some(p => /pick-?up/i.test(p.text)))
            .sort((a, b) => (o.at ? cheb(a, o.at) - cheb(b, o.at) : 0) || a.distance - b.distance)[0];
    if (o.at) {
        const p = me();
        if (!p || p.level !== (o.at.level ?? 0) || cheb({ x: p.worldX, z: p.worldZ }, o.at) > 12) {
            await o.walk({ x: o.at.x + 1, z: o.at.z - 1, level: o.at.level ?? 0 });
        }
    }
    const loc = nearCannon();
    if (loc && (await pickupCannon(s, loc))) return { ok: true, how: 'picked', detail: `picked up at ${loc.x},${loc.z}` };
    if (o.nulodion === false) return { ok: false, how: 'none', detail: loc ? `pick-up refused at ${loc.x},${loc.z}` : 'no cannon in view' };
    const feed = messageFeed(s);
    try {
        if (!(await o.walk({ x: NULODION_DOOR.x, z: NULODION_DOOR.z, level: 0 }))) return { ok: false, how: 'nulodion', detail: 'walk to Nulodion failed' };
        if (o.placedAt !== undefined) {
            const decay = o.placedAt + CANNON_LIFE + 10;
            const wait = decay - s.tick();
            if (wait > (o.maxWait ?? CANNON_LIFE)) return { ok: false, how: 'nulodion', detail: `cannon stands until tick ${decay}; ${wait} ticks to wait` };
            if (wait > 0) {
                console.log(`RECLAIM wait ${wait} ticks for the cannon loc to end (tick ${decay})`);
                const home = { x: me()?.worldX ?? NULODION_DOOR.x, z: me()?.worldZ ?? NULODION_DOOR.z };
                for (let i = 0; s.tick() < decay; i++) {
                    await waitUntil(s, () => s.tick() >= decay, { timeoutTicks: Math.min(200, decay - s.tick() + 1) });
                    if (s.tick() < decay) await s.bot.walkTo(home.x + (i % 2 ? 0 : 1), home.z, 0);
                }
            }
        }
        const m0 = feed.mark();
        const r = await talkToNulodion(s, /lost my cannon/i, held, /only allowed to replace|happily parked/i, 'lost cannon');
        if (r === 'absent') return { ok: false, how: 'nulodion', detail: 'Nulodion not in view' };
        if (r === 'refused') return { ok: false, how: 'nulodion', detail: 'refused: the cannon loc still stands' };
        return held() ? { ok: true, how: 'nulodion', detail: feed.all.slice(m0).join(' | ') || 'parts given' } : { ok: false, how: 'nulodion', detail: `no parts: ${feed.all.slice(m0).join(' | ')}` };
    } finally {
        feed.off();
    }
}

export type CannonFightOptions = {
    spot: CannonSpot;
    cap: number;
    stop: Record<string, number>;
    phases: CannonPhase[];
    reload: number;
    prayer: PrayerName | 'none';
    eatAt?: number;
    special?: boolean;
    halt?: () => boolean;
    walk?: Walk;
};

export function cannonWalker(s: CombatSession, spot: CannonSpot, walk?: Walk): Walk {
    const sess = s as Session;
    return (
        walk
        ?? (async to => {
            if (to === spot.clear) {
                if (s.sdk.getState()?.player?.level !== to.level) throw Error('ground walk requires a known start on the same plane');
                return (await walkPath(await sessionWalker(sess), [{ ...to, tol: 1 }], { maxTicks: 600 })).ok;
            }
            const world = await getWorld();
            return (
                await combatFerryWalk(s, to, (tile, planBudgetMs) => goTo(sess, world, tile, accountOf(sess), { legTimeoutTicks: 100, planBudgetMs }))
            ).ok;
        })
    );
}

export async function runCannonFight(s: CombatSession, o: CannonFightOptions) {
    if (!Number.isSafeInteger(o.cap) || o.cap < 1 || !Number.isSafeInteger(o.reload) || o.reload < 1 || o.reload > 30) {
        throw Error('cannon fight: cap >= 1 and reload 1..30');
    }
    if (!Object.keys(o.stop).length) throw Error('cannon fight: no stop levels');
    const sess = s as Session;
    const st = () => s.sdk.getState()!;
    const me = () => st().player!;
    const inv = () => s.sdk.getInventory();
    const slot = (re: RegExp) => inv().find(i => re.test(i.name));
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const maxHp = s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    const xp = (k: string) => s.sdk.getSkillXp(k) ?? 0;
    const level = (k: string) => s.sdk.getSkill(k)?.baseLevel ?? 0;
    const ammo = () => s.sdk.getEquipment().filter(i => i.slot === 13).reduce((n, i) => n + i.count, 0);
    const weapon = () => s.sdk.getEquipment().find(i => i.slot === 3);
    const cvar = (i: number) => (s.client as { var?: number[] } | undefined)?.var?.[i];
    const target = new RegExp(o.spot.target, 'i');
    const prayerIndex = o.prayer === 'none' ? -1 : PRAYER_NAMES.indexOf(o.prayer);
    const eatAt = o.eatAt ?? Math.max(Math.floor(maxHp * 0.4), Math.min(maxHp - 12, 8));
    const walk = cannonWalker(s, o.spot, o.walk);
    const life0 = { respawn: me().respawnCount, life: me().lifeId };
    const died = () => sessionDied({ respawnCount: life0.respawn, lifeId: life0.life }, s.sdk.getState()?.player);
    const feed = messageFeed(s);
    let phase = o.phases.findIndex((ph, i) => i === o.phases.length - 1 || !levelsMet(level, ph.until));
    let targetIndex = -1;
    const applyPhase = async () => {
        const ph = o.phases[phase];
        if (!ph) return;
        if (ph.weapon !== undefined && weapon()?.id !== ph.weapon) {
            if (!inv().some(i => i.id === ph.weapon)) throw Error(`phase weapon ${ph.weapon} is not in the pack`);
            const g = gearById(ph.weapon);
            await reconcileCombatLoadout(s, {
                style: g && (g.bonuses.rangeAttack > 0 || g.bonuses.rangeStrength > 0) ? 'ranged' : 'melee',
                trainSkill: 'all-melee',
                pin: { weapon: ph.weapon },
                stop: () => died(),
                strict: true,
                label: 'cannon phase',
            });
            if (!(await waitUntil(s, () => weapon()?.id === ph.weapon, { timeoutTicks: 6 }))) throw Error(`phase weapon ${ph.weapon} not wielded`);
        }
        if (ph.style !== undefined && st().combatStyle?.currentStyle !== ph.style) {
            await s.direct({ type: 'setCombatStyle', style: ph.style, reason: 'cannon fight style' });
            await waitUntil(s, () => st().combatStyle?.currentStyle === ph.style, { timeoutTicks: 6 });
        }
        targetIndex = -1;
        console.log(`PHASE ${phase} weapon=${weapon()?.name ?? '-'} style=${st().combatStyle?.currentStyle} t=${s.tick()}`);
    };
    await applyPhase();
    const reach = () => (/bow/i.test(weapon()?.name ?? '') && ammo() > 0 ? 7 : 3);
    const prayerOn = () => prayerIndex >= 0 && !!st().prayers?.activePrayers?.[prayerIndex];
    if (prayerIndex >= 0 && !prayerOn() && level('Prayer') > 0) {
        await s.direct({ type: 'togglePrayer', prayerIndex, reason: 'cannon fight prayer' });
        await waitTicks(s, 1);
    }
    let reclaimed = '-';
    const place = async () => {
        try {
            return await setupCannon(s, { centre: o.spot.centre, avoidOld: true });
        } catch (e) {
            if (!/more than one Cannon/i.test(String(e))) throw e;
            const r = await reclaimCannon(s, { walk });
            reclaimed = `${r.how}:${r.ok}`;
            if (!r.ok) throw Error(`cannon held by the server and not reclaimed: ${r.detail}`);
            if (cheb({ x: me().worldX, z: me().worldZ }, o.spot.centre) > 0) await walk(o.spot.centre);
            return setupCannon(s, { centre: o.spot.centre, avoidOld: true });
        }
    };
    let cannon = await place();
    let placedAt = s.tick();
    let refreshes = 0;
    console.log(`CANNON up at ${cannon.x},${cannon.z} centre ${cannon.centre.x},${cannon.centre.z} setupTicks=${cannon.setupTicks} stand ${me().worldX},${me().worldZ}`);

    const skills = ['Ranged', 'Hitpoints', 'Defence', 'Attack', 'Strength'];
    const x0 = Object.fromEntries(skills.map(k => [k, xp(k)])) as Record<string, number>;
    const balls = () => countItems(sess, CANNON_BALL);
    const food = () => countItems(sess, FOOD);
    const balls0 = balls();
    const ammo0 = ammo();
    const food0 = food();
    const t0 = s.tick();
    const wall0 = Date.now();
    const track = Object.keys(o.stop);
    const levelAt = new Map<number, number>([[level(track[0]!), 0]]);
    const doneAt: Record<string, number> = {};
    let reloads = 0;
    let refires = 0;
    let attacks = 0;
    let eats = 0;
    let potions = 0;
    let antis = 0;
    let dialogs = 0;
    let idle = 0;
    let kills = 0;
    let dmgTaken = 0;
    let specials = 0;
    let hpMin = hp();
    let lastLoad = t0;
    let loadPending = -1;
    let loadMark = 0;
    let needFire = false;
    let firePending = -1;
    let emptyMark = feed.mark();
    let poisonMark = 0;
    let antiAt = -999;
    let specAt = -99;
    let attackAt = -99;
    let lastGain = -99;
    let lastHpXp = xp('Hitpoints');
    let stopped = '';
    const skip = new Map<number, number>();
    const seenEvents = new Set<string>();
    let ended = false;
    void s.ended.then(() => {
        ended = true;
    });
    type Step = 'go' | 'stop' | 'phase' | 'refresh';
    const step = (): Step => {
        const now = s.tick();
        const lv = level(track[0]!);
        hpMin = Math.min(hpMin, hp());
        if (!levelAt.has(lv)) {
            levelAt.set(lv, now - t0);
            console.log(
                `LEVEL ${track[0]}=${lv} t=${now - t0} ranged=${xp('Ranged') - x0.Ranged!} hpXp=${xp('Hitpoints') - x0.Hitpoints!} defXp=${xp('Defence') - x0.Defence!} balls=${balls0 - balls()} ammo=${ammo0 - ammo()} dialogs=${dialogs}`,
            );
        }
        for (const k of track) {
            if (doneAt[k] === undefined && level(k) >= o.stop[k]!) {
                doneAt[k] = now - t0;
                console.log(`DONE ${k}=${level(k)} t=${now - t0}`);
            }
        }
        if (o.halt?.()) stopped = 'stop';
        if (died()) {
            stopped = 'died';
            return 'stop';
        }
        if (now - t0 >= o.cap || stopped || levelsMet(level, o.stop)) return 'stop';
        for (const e of st().combatEvents ?? []) {
            const k = `${e.observationId ?? ''}:${e.tick}:${e.type}:${e.sourceIndex}:${e.targetIndex}:${e.damage}`;
            if (seenEvents.has(k)) continue;
            seenEvents.add(k);
            if (e.type === 'damage_taken') dmgTaken += e.damage;
            if (e.type === 'kill') kills++;
        }
        if (st().dialog?.isOpen || st().modalOpen) {
            void s.direct({ type: 'closeModal', reason: 'level-up message holds the cannon' });
            dialogs++;
            targetIndex = -1;
            return 'go';
        }
        if (phase < o.phases.length - 1 && levelsMet(level, o.phases[phase]!.until)) {
            phase++;
            return 'phase';
        }
        if (hp() <= eatAt) {
            const f = slot(FOOD);
            if (f) {
                void s.direct({ type: 'useInventoryItem', slot: f.slot, optionIndex: 1, reason: 'eat' });
                eats++;
                targetIndex = -1;
                return 'go';
            }
        }
        if (prayerIndex >= 0) {
            const pray = s.sdk.getSkill('Prayer')?.level ?? 0;
            const pot = pray <= 10 ? slot(/^prayer potion/i) : undefined;
            if (pot) {
                void s.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'prayer potion' });
                potions++;
                targetIndex = -1;
                return 'go';
            }
            if (pray > 0 && !prayerOn()) void s.direct({ type: 'togglePrayer', prayerIndex, reason: 'prayer back on' });
        }
        if (feed.saw(/^You have been poisoned!$/, poisonMark) && now - antiAt >= 150) {
            const a = slot(/^antipoison/i);
            if (a) {
                poisonMark = feed.mark();
                void s.direct({ type: 'useInventoryItem', slot: a.slot, optionIndex: 1, reason: 'antipoison' });
                antis++;
                antiAt = now;
                targetIndex = -1;
                return 'go';
            }
        }
        if (loadPending >= 0) {
            if (!feed.saw(/load the cannon|already full/i, loadMark) && now - loadPending < 6) return 'go';
            loadPending = -1;
            if (needFire) {
                needFire = false;
                void s.direct({ type: 'interactLoc', x: cannon.x, z: cannon.z, locId: cannon.id, optionIndex: 1, reason: 'cannon fire' });
                refires++;
                firePending = now;
                targetIndex = -1;
                return 'go';
            }
        }
        if (firePending >= 0 && now - firePending < 2) return 'go';
        firePending = -1;
        if (now - placedAt >= CANNON_REFRESH) return 'refresh';
        const empty = feed.saw(/out of ammo/i, emptyMark);
        if (reloadDue({ now, lastLoad, interval: o.reload, empty })) {
            const b = slot(CANNON_BALL);
            if (b) {
                if (empty) {
                    needFire = true;
                    emptyMark = feed.mark();
                }
                loadMark = feed.mark();
                loadPending = now;
                lastLoad = now;
                reloads++;
                targetIndex = -1;
                void s.direct({ type: 'useItemOnLoc', itemSlot: b.slot, x: cannon.x, z: cannon.z, locId: cannon.id, reason: 'cannon top-up' });
                return 'go';
            }
        }
        const npcs = (st().nearbyNpcs ?? []) as TargetNpc[];
        const cur = npcs.find(n => n.index === targetIndex);
        const hx = xp('Hitpoints');
        if (hx > lastHpXp) {
            lastHpXp = hx;
            lastGain = now;
        }
        const fighting = !!cur && (cur.hp ?? 1) > 0 && (now - lastGain < 10 || now - attackAt < 10);
        if (fighting && now - specAt >= 3 && specialDue({ special: !!o.special, weapon: weapon()?.id, energy: cvar(300), enabled: cvar(301), fighting })) {
            specAt = now;
            specials++;
            void s.sdk.sendClickComponent(componentId('combat_bow:specbar'));
            return 'go';
        }
        if (fighting) return 'go';
        if (cur && now - attackAt >= 10) skip.set(cur.index, now + 30);
        const p = me();
        const next = pickTarget(npcs, { target, centre: cannon.centre, me: { x: p.worldX, z: p.worldZ }, near: o.spot.near, reach: reach(), skip: i => (skip.get(i) ?? 0) > now });
        if (!next) {
            idle++;
            targetIndex = -1;
            return 'go';
        }
        void s.direct({
            type: 'interactNpc',
            npcIndex: next.index,
            optionIndex: next.optionsWithIndex.find(q => /^attack$/i.test(q.text))!.opIndex,
            reason: 'cannon fight attack',
        });
        targetIndex = next.index;
        attackAt = now;
        attacks++;
        return 'go';
    };
    for (;;) {
        if (ended) break;
        const r = step();
        if (r === 'stop') break;
        if (r === 'phase') await applyPhase();
        if (r === 'refresh') {
            if (!(await pickupCannon(s, cannon))) throw Error('cannon refresh: pick-up failed');
            cannon = await setupCannon(s, { centre: o.spot.centre, avoidOld: false });
            placedAt = s.tick();
            lastLoad = placedAt;
            refreshes++;
            emptyMark = feed.mark();
            targetIndex = -1;
            console.log(`CANNON refresh at ${cannon.x},${cannon.z} setupTicks=${cannon.setupTicks}`);
        }
        await waitTicks(s, 1);
    }
    const ticks = s.tick() - t0;
    const dead = stopped === 'died';
    const gain = Object.fromEntries(skills.map(k => [k, xp(k) - x0[k]!])) as Record<string, number>;
    const used = { balls: balls0 - balls(), ammo: ammo0 - ammo(), food: food0 - food() };
    let picked = false;
    let clear = false;
    if (dead && !ended) {
        await waitUntil(s, () => hp() > 0 && !me().isDead, { timeoutTicks: 30 });
        const r = await reclaimCannon(s, { at: { x: cannon.x, z: cannon.z, level: o.spot.centre.level }, walk, placedAt });
        reclaimed = `${r.how}:${r.ok}`;
        picked = r.ok;
        console.log(`RECLAIM ${JSON.stringify(r)}`);
    } else if (!ended) {
        picked = await pickupCannon(s, cannon);
    }
    if (!ended) {
        const from = { x: me().worldX, z: me().worldZ };
        if (!dead || reclaimed.startsWith('picked')) {
            if (o.spot.clear) await walk(o.spot.clear);
            else {
                for (const [dx, dz] of [
                    [18, 0],
                    [-18, 0],
                    [0, 18],
                    [0, -18],
                    [12, 12],
                    [-12, -12],
                ]) {
                    if ((await s.bot.walkTo(from.x + dx!, from.z + dz!, 2)).success) break;
                }
            }
        }
        clear = await waitUntil(
            s,
            () => {
                const lt = me().combat?.lastDamageTick ?? -1;
                return lt < 0 || s.tick() - lt >= 17;
            },
            { timeoutTicks: 60 },
        );
        if (prayerOn()) await s.direct({ type: 'togglePrayer', prayerIndex, reason: 'prayer off' });
    }
    feed.off();
    const bands = bandTicks(levelAt, [1, 50, 55, 60, 70, 80, 90, 95, 99].filter(l => levelAt.has(l)));
    return {
        ok: !dead && !stopped && picked && (levelsMet(level, o.stop) || ticks >= o.cap),
        died: dead,
        stopped: stopped || '-',
        ticks,
        setupTicks: cannon.setupTicks,
        msPerTick: Math.round((Date.now() - wall0) / Math.max(1, ticks)),
        startLevel: [...levelAt.keys()][0],
        endLevels: Object.fromEntries(track.map(k => [k, level(k)])),
        doneAt,
        gain,
        used,
        reloads,
        refires,
        refreshes,
        attacks,
        eats,
        potions,
        antis,
        dialogs,
        specials,
        idle,
        kills,
        dmgTaken,
        hpMin,
        picked,
        clear,
        reclaimed,
        bands,
        levelAt: Object.fromEntries(levelAt),
    };
}

export async function runCannonCli(bot: string, env: Record<string, string | undefined> = process.env) {
    const spot = CANNON_SPOTS[env.SPOT ?? 'spiders'];
    if (!bot || !spot) throw Error(`RESULT fail usage: cannon-fight <account> SPOT=${Object.keys(CANNON_SPOTS).join('|')} [MODE=reclaim CANNON_AT=x,z | MODE=buy]`);
    const prayer = (env.PRAYER ?? spot.prayer) as PrayerName | 'none';
    if (prayer !== 'none' && !PRAYER_NAMES.includes(prayer)) throw Error(`RESULT fail unknown PRAYER ${prayer}`);
    let halted = false;
    const s = await openBot(bot, {
        onStop: async (_s, detail) => {
            if (detail !== 'died') halted = true;
        },
    }).catch(e => finish([], false, `login: ${String(e)}`));
    const walk = cannonWalker(s, spot);
    try {
        await waitTicks(s, 2);
        if (env.MODE === 'reclaim') {
            const at = env.CANNON_AT ? env.CANNON_AT.split(',').map(Number) : undefined;
            const r = await reclaimCannon(s, { ...(at && at.length === 2 && at.every(Number.isSafeInteger) ? { at: { x: at[0]!, z: at[1]! } } : {}), walk });
            await finish([s], r.ok, `cannon-reclaim how=${r.how} detail=${r.detail}`);
            return r;
        }
        if (env.MODE === 'buy') {
            const r = await buyCannon(s, { walk });
            await finish([s], r.ok, `cannon-buy ${r.detail}`);
            return r;
        }
        const stop = env.STOP ? parseLevels(env.STOP) : { [env.STOP_SKILL ?? 'Ranged']: Number(env.STOP_LEVEL ?? 99) };
        const phases = env.PHASES ? parsePhases(env.PHASES) : [{ ...(env.STYLE === undefined ? {} : { style: Number(env.STYLE) }) }];
        const r = await runCannonFight(s, {
            spot,
            cap: Number(env.CAP ?? 3000),
            stop,
            phases,
            reload: Number(env.RELOAD ?? 20),
            prayer,
            eatAt: env.EAT_AT === undefined ? undefined : Number(env.EAT_AT),
            special: env.SPECIAL !== '0',
            halt: () => halted,
            walk,
        });
        const per = (n: number) => (n / Math.max(1, r.ticks)).toFixed(1);
        const kv = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k}:${v}`).join(',') || '-';
        const ok = r.ok || (env.OK_ON_RECLAIM === '1' && r.died && r.picked);
        await finish(
            [s],
            ok,
            `cannon-fight spot=${env.SPOT ?? 'spiders'} ticks=${r.ticks} ${Object.keys(stop)[0]}=${r.startLevel}->${r.endLevels[Object.keys(stop)[0]!]} levels=${kv(r.endLevels)} done=${kv(r.doneAt)} `
                + `rangedXp=${r.gain.Ranged} rangedXpPerTick=${per(r.gain.Ranged!)} hpXp=${r.gain.Hitpoints} hpXpPerTick=${per(r.gain.Hitpoints!)} defXp=${r.gain.Defence} defXpPerTick=${per(r.gain.Defence!)} `
                + `balls=${r.used.balls} ammo=${r.used.ammo} food=${r.used.food} potions=${r.potions} antis=${r.antis} reloads=${r.reloads} refires=${r.refires} refreshes=${r.refreshes} dialogs=${r.dialogs} specials=${r.specials} attacks=${r.attacks} idle=${r.idle} kills=${r.kills} hpMin=${r.hpMin} `
                + `died=${r.died} picked=${r.picked} reclaimed=${r.reclaimed} clear=${r.clear} setupTicks=${r.setupTicks} msPerTick=${r.msPerTick} bands=${kv(r.bands)} stop=${r.stopped}`,
        );
        return r;
    } catch (e) {
        await finish([s], false, `cannon-fight: ${String(e)}`);
        throw e;
    }
}
