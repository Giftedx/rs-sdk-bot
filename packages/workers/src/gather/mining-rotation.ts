// Rock rotation and 3-tick knife reset for at-site mining.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseConfigs } from '../../../knowledge/src/config';
import { parseJm2 } from '../../../knowledge/src/jm2';
import type { BotWorldState, NearbyLoc } from '../../../../vendor/rs-sdk/sdk/types';
import { KNIFE, knifeDelay, NORMAL_LOGS } from './knife-reset';
import type { MiningAction, MiningDriver, MiningProfile } from './types';

export { KNIFE, knifeDelay, NORMAL_LOGS, type MiningAction };

export type Tile = { x: number; z: number; level: number };

const content = resolve(import.meta.dir, '../../../../vendor/rs-sdk/server/content');
const locPack = () =>
    new Map(
        readFileSync(resolve(content, 'pack/loc.pack'), 'utf8')
            .split(/\r?\n/)
            .flatMap(l => {
                const m = l.match(/^(\d+)=(.+)$/);
                return m ? ([[Number(m[1]), m[2]!] as const]) : [];
            }),
    );

let fastIds: Set<number> | undefined;
export function oreLag(p: MiningProfile, rock = p.rocks[0]!): number {
    if (!fastIds) {
        const names = new Map([...locPack()].map(([id, n]) => [n, id]));
        const files = ['scripts/skill_mining/configs/rocks.loc', 'scripts/quests/quest_hauntedmine/configs/hauntedmine.loc'];
        fastIds = new Set(
            files
                .flatMap(f => parseConfigs(readFileSync(resolve(content, f), 'utf8'), f))
                .filter(b => (b.props.category ?? []).includes('mining_rock_fast'))
                .map(b => names.get(b.name)!)
                .filter(n => n !== undefined),
        );
    }
    return p.gemRock || fastIds.has(rock) ? 0 : 1;
}

export function respawnTicks(base: number, players = 1): number {
    return Math.trunc(((4000 - Math.min(players, 2000)) * base) / 4000);
}

export function firstRoll(delay: number, arrival: number, rate: number): { roll: number; delay: number } {
    return delay < arrival ? { roll: arrival + rate, delay: arrival + rate } : { roll: delay, delay };
}

let mapRocks: { id: number; x: number; z: number; level: number }[] | undefined;
function allRocks() {
    if (mapRocks) return mapRocks;
    const dir = resolve(content, 'maps');
    mapRocks = [];
    for (const f of readdirSync(dir).filter(f => f.endsWith('.jm2'))) {
        for (const l of parseJm2(f, readFileSync(resolve(dir, f), 'utf8')).locs) {
            mapRocks.push({ id: l.id, x: l.x, z: l.z, level: l.level });
        }
    }
    return mapRocks;
}

const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

export function siteRocks(p: MiningProfile, center: Tile, radius: number): Tile[] {
    return allRocks()
        .filter(r => p.rocks.includes(r.id) && r.level === center.level && cheb(r, center) <= radius)
        .map(r => ({ x: r.x, z: r.z, level: r.level }))
        .sort((a, b) => a.x - b.x || a.z - b.z);
}

export function contentSites(p: MiningProfile, gap = 3): { center: Tile; rocks: Tile[] }[] {
    const left = allRocks().filter(r => p.rocks.includes(r.id)).map(r => ({ x: r.x, z: r.z, level: r.level }));
    const out: { center: Tile; rocks: Tile[] }[] = [];
    while (left.length) {
        const site = [left.pop()!];
        for (let grew = true; grew;) {
            grew = false;
            for (let i = left.length - 1; i >= 0; i--) {
                if (site.some(r => r.level === left[i]!.level && cheb(r, left[i]!) <= gap)) {
                    site.push(left.splice(i, 1)[0]!);
                    grew = true;
                }
            }
        }
        const x = Math.round(site.reduce((n, r) => n + r.x, 0) / site.length);
        const z = Math.round(site.reduce((n, r) => n + r.z, 0) / site.length);
        out.push({ center: { x, z, level: site[0]!.level }, rocks: site.sort((a, b) => a.x - b.x || a.z - b.z) });
    }
    return out.sort((a, b) => b.rocks.length - a.rocks.length);
}

export interface MiningSite {
    key: string;
    profile: string;
    center: Tile;
    radius: number;
    bank: Tile;
    more?: readonly { center: Tile; radius: number }[];
}

export const MINING_SITES: readonly MiningSite[] = [
    { key: 'ardougne-zoo-iron', profile: 'iron_rock_table', center: { x: 2603, z: 3235, level: 0 }, radius: 3, bank: { x: 2655, z: 3283, level: 0 } },
    {
        key: 'ardougne-zoo-iron-9',
        profile: 'iron_rock_table',
        center: { x: 2603, z: 3235, level: 0 },
        radius: 3,
        bank: { x: 2655, z: 3283, level: 0 },
        more: [{ center: { x: 2591, z: 3232, level: 0 }, radius: 2 }],
    },
    { key: 'wilderness-hobgoblin-iron', profile: 'iron_rock_table', center: { x: 3100, z: 3766, level: 0 }, radius: 2, bank: { x: 3094, z: 3493, level: 0 } },
    { key: 'varrock-east-iron', profile: 'iron_rock_table', center: { x: 3286, z: 3368, level: 0 }, radius: 3, bank: { x: 3253, z: 3420, level: 0 } },
];

export function siteTiles(p: MiningProfile, site: MiningSite): Tile[] {
    return [site, ...(site.more ?? [])].flatMap(a => siteRocks(p, a.center, a.radius));
}

export function standTiles(rock: Tile, rocks: readonly Tile[]): Tile[] {
    return [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dz]) => ({ x: rock.x + dx!, z: rock.z + dz!, level: rock.level }))
        .filter(t => !rocks.some(r => r.x === t.x && r.z === t.z && r.level === t.level));
}

const beside = (p: { x: number; z: number }, rock: Tile) => Math.abs(p.x - rock.x) + Math.abs(p.z - rock.z) === 1;

export function pathSteps(p: { x: number; z: number }, rock: Tile, rocks: readonly Tile[]): number {
    const goals = new Set(standTiles(rock, rocks).map(t => `${t.x},${t.z}`));
    const blocked = new Set(rocks.map(r => `${r.x},${r.z}`));
    const free = (x: number, z: number) => !blocked.has(`${x},${z}`);
    const seen = new Set([`${p.x},${p.z}`]);
    let front = [{ x: p.x, z: p.z }];
    for (let steps = 0; front.length && steps <= 24; steps++) {
        if (front.some(t => goals.has(`${t.x},${t.z}`))) return steps;
        const next: { x: number; z: number }[] = [];
        for (const t of front) {
            for (let dx = -1; dx <= 1; dx++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const x = t.x + dx;
                    const z = t.z + dz;
                    const k = `${x},${z}`;
                    if ((!dx && !dz) || seen.has(k) || !free(x, z) || (dx && dz && (!free(t.x + dx, t.z) || !free(t.x, t.z + dz)))) continue;
                    seen.add(k);
                    next.push({ x, z });
                }
            }
        }
        front = next;
    }
    return Math.min(...standTiles(rock, rocks).map(t => cheb(p, t)));
}

const runTicks = (p: { x: number; z: number }, rock: Tile, rocks: readonly Tile[]) =>
    beside(p, rock) ? 0 : Math.ceil(pathSteps(p, rock, rocks) / 2);

export interface RotationOptions {
    maximum: number;
    cap: number;
    idleTicks: number;
    knife: boolean;
    drop: boolean;
    keep?: readonly number[];
    make1: number;
    players?: number;
    rocks?: readonly Tile[];
    pick?: 'roll' | 'nearest';
}

export interface RotationResult {
    made: number;
    sideGems: number;
    attempts: number;
    outputs: Record<number, number>;
    xp: number;
    ticks: number;
    banked: 0;
    dropped: number;
    knifeCuts: number;
    preArms: number;
    fletches: number;
    respawn: number;
    rolls: number[];
    waitTicks: number;
}

const stockOf = (s: BotWorldState) => {
    const r: Record<number, number> = {};
    for (const i of s.inventory) r[i.id] = (r[i.id] ?? 0) + i.count;
    return r;
};
const xpOf = (s: BotWorldState) => s.skills.find(k => k.name === 'Mining')?.experience ?? 0;
const hpOf = (s: BotWorldState) => s.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;

export async function runRotationMining(
    d: MiningDriver,
    p: MiningProfile,
    o: RotationOptions,
    rate: number,
    gems: readonly number[],
): Promise<RotationResult> {
    const send = d.send;
    if (!send) throw Error('rotation mining needs a driver that sends actions in one tick');
    const initial = d.state();
    if (!initial?.player) throw Error('mining state unknown');
    const start = d.tick();
    const me = initial.player;
    const keep = new Set([...(o.keep ?? []), KNIFE, NORMAL_LOGS]);
    const rocks = (o.rocks ?? siteRocks(p, { x: me.worldX, z: me.worldZ, level: me.level }, 3)).filter(r => r.level === me.level);
    if (!rocks.length) throw Error('no ' + p.name + ' rocks at this site in the map files');
    const key = (t: Tile) => `${t.x},${t.z}`;
    const equipment = JSON.stringify(initial.equipment.map(i => ({ id: i.id, slot: i.slot })).sort((a, b) => a.slot - b.slot));
    const state = () => {
        const s = d.state();
        if (!s?.player) throw Error('mining session ended');
        if (d.stop()) throw Error('mining stopped');
        if (d.tick() - start >= o.cap) throw Error('mining tick cap');
        if (s.player.isDead || s.player.lifeId !== me.lifeId || s.player.level !== me.level || hpOf(s) < hpOf(initial)) {
            throw Error('mining health or life changed');
        }
        if (JSON.stringify(s.equipment.map(i => ({ id: i.id, slot: i.slot })).sort((a, b) => a.slot - b.slot)) !== equipment) {
            throw Error('mining equipment changed');
        }
        return s;
    };
    let respawn = respawnTicks(p.respawn, o.players ?? 1);
    const depleted = new Map<string, number>();
    const seen = new Map<string, boolean>();
    let delay = -Infinity;
    let made = 0;
    let sideGems = 0;
    let attempts = 0;
    let dropped = 0;
    let knifeCuts = 0;
    let preArms = 0;
    let fletches = 0;
    let progress = start;
    let waitTicks = 0;
    const outputs: Record<number, number> = {};
    const rolls: number[] = [];
    let active: { rock: Tile; loc: NearbyLoc; sent: number; arrival?: number; roll?: number } | undefined;
    let walkingTo: string | undefined;
    let armedFor: number | undefined;
    const side = gems.filter(id => !p.products.includes(id));
    const watched = [...new Set([...p.products, ...side])];
    const pend = new Map<number, { id: number; count: number; tick: number }>();
    const pendingOf = (id: number) => [...pend.values()].filter(v => v.id === id).reduce((a, v) => a + v.count, 0);
    const settle = (id: number, lost: number) => {
        for (const [slot, v] of pend) {
            if (lost <= 0) break;
            if (v.id !== id) continue;
            const t = Math.min(lost, v.count);
            v.count -= t;
            lost -= t;
            if (!v.count) pend.delete(slot);
        }
    };
    const first = state();
    let prevXp = xpOf(first);
    let prevInv = stockOf(first);
    const locAt = (s: BotWorldState, t: Tile) =>
        s.nearbyLocs.find(l => l.x === t.x && l.z === t.z && l.level === t.level && p.rocks.includes(l.id) && l.optionsWithIndex.some(v => v.opIndex === 1 && /^mine$/i.test(v.text)));

    for (;;) {
        const s = state();
        const n = d.tick();
        const pos = { x: s.player!.worldX, z: s.player!.worldZ };
        const xp = xpOf(s);
        const inv = stockOf(s);
        const delta = (id: number) => (inv[id] ?? 0) - (prevInv[id] ?? 0);
        if (delta(NORMAL_LOGS) < 0) fletches -= delta(NORMAL_LOGS);
        let oreId: number | undefined;
        if (xp > prevXp) {
            oreId = p.products.find(id => delta(id) === 1) ?? p.products.find(id => delta(id) <= 1 && 1 - delta(id) <= pendingOf(id));
            if (oreId === undefined) throw Error('mining XP without one own ore');
            made++;
            rolls.push(n);
            outputs[oreId] = (outputs[oreId] ?? 0) + 1;
            progress = n;
            delay = n - oreLag(p, active?.loc.id);
            active = undefined;
        }
        for (const id of watched) {
            const g = delta(id) - (id === oreId ? 1 : 0);
            if (g > 0) {
                if (!side.includes(id) || (xp > prevXp && id !== oreId && p.products.includes(id))) {
                    throw Error('mining ore without XP');
                }
                sideGems += g;
                outputs[id] = (outputs[id] ?? 0) + g;
            } else if (-g > pendingOf(id)) {
                throw Error('mining item lost without a drop');
            } else if (g < 0) {
                dropped -= g;
                settle(id, -g);
            }
        }
        prevXp = xp;
        prevInv = inv;
        if (made >= o.maximum) break;
        if (n - progress >= o.idleTicks) throw Error('mining no useful ore progress');
        for (const r of rocks) {
            const k = key(r);
            const up = !!locAt(s, r);
            const was = seen.get(k);
            if (was === true && !up) depleted.set(k, n);
            if (was === false && up && depleted.has(k)) {
                respawn = n - depleted.get(k)!;
                depleted.delete(k);
            }
            seen.set(k, up);
        }
        const actions: MiningAction[] = [];
        const ticksTo = (r: Tile) => runTicks(pos, r, rocks);
        const slot = (id: number) => s.inventory.find(i => i.id === id)?.slot;
        const knifeSlots = o.knife ? { k: slot(KNIFE), l: slot(NORMAL_LOGS) } : undefined;
        const canCut = !!knifeSlots && knifeSlots.k !== undefined && knifeSlots.l !== undefined;
        const cut = () => {
            actions.push(
                { type: 'useItemOnItem', sourceSlot: knifeSlots!.k!, targetSlot: knifeSlots!.l! },
                { type: 'clickComponent', componentId: o.make1 },
            );
            delay = knifeDelay(delay, n + 1);
            knifeCuts++;
        };
        const drops = (most: number) => {
            if (!o.drop) return;
            for (const i of s.inventory
                .filter(i => !keep.has(i.id) && (p.products.includes(i.id) || gems.includes(i.id)))
                .filter(i => {
                    const v = pend.get(i.slot);
                    return !v || v.id !== i.id || n - v.tick >= 3;
                })
                .slice(0, most)) {
                actions.push({ type: 'dropItem', slot: i.slot });
                const v = pend.get(i.slot);
                if (v && v.id === i.id) v.tick = n;
                else pend.set(i.slot, { id: i.id, count: i.count, tick: n });
            }
        };
        if (!o.drop && s.inventory.length >= 28) throw Error('mining pack full; retain ore for owned bank route');
        if (active && !locAt(s, active.rock)) active = undefined;
        const modal = !!(s.dialog?.isOpen || s.interface?.isOpen);
        if (active && ((modal && n >= active.sent) || (active.arrival === undefined && n >= active.sent + 8))) active = undefined;
        if (active) {
            if (active.arrival === undefined && n >= active.sent && beside(pos, active.rock)) {
                active.arrival = n + 1;
                const f = firstRoll(delay, n + 1, rate);
                active.roll = f.roll;
                delay = f.delay;
            }
            if (active.roll !== undefined && n >= active.roll) {
                if (canCut) {
                    cut();
                    actions.push({ type: 'interactLoc', x: active.loc.x, z: active.loc.z, locId: active.loc.id, optionIndex: 1 });
                    attempts++;
                    active.roll = Math.max(delay, n + 1);
                } else {
                    delay = n + 1 + rate;
                    active.roll = delay;
                }
            }
        }
        if (!active) {
            const free = rocks
                .map(r => ({ r, loc: locAt(s, r) }))
                .filter(v => v.loc && v.loc.reachable !== false && !s.nearbyPlayers.some(q => cheb(q, v.r) <= 1));
            const freeRoll = (r: Tile) => {
                const op = n + 1 + ticksTo(r);
                return delay >= op ? delay : canCut ? Math.max(op, n + 3) : op + rate;
            };
            const waitRoll = (r: Tile, back: number) => {
                const click = Math.max(back + 1, n + 1 + ticksTo(r));
                return canCut ? Math.max(click, n + 3) : click + rate;
            };
            const byRoll = (o.pick ?? (canCut ? 'roll' : 'nearest')) === 'roll';
            const stepsTo = (r: Tile) => pathSteps(pos, r, rocks);
            const best = free
                .map(v => ({ ...v, roll: freeRoll(v.r) }))
                .sort((a, b) => (byRoll ? a.roll - b.roll : 0) || stepsTo(a.r) - stepsTo(b.r))[0];
            const soon = rocks
                .filter(r => depleted.has(key(r)))
                .map(r => ({ r, back: depleted.get(key(r))! + respawn }))
                .map(v => ({ ...v, roll: waitRoll(v.r, v.back) }))
                .sort((a, b) => a.roll - b.roll || a.back - b.back)[0];
            if (best && !(byRoll && soon && soon.roll < best.roll)) {
                const pick = best;
                if (s.inventory.length >= 27) drops(1);
                if (canCut && delay < n + 1) cut();
                actions.push({ type: 'interactLoc', x: pick.loc!.x, z: pick.loc!.z, locId: pick.loc!.id, optionIndex: 1 });
                attempts++;
                active = { rock: pick.r, loc: pick.loc!, sent: n + 1 };
                walkingTo = undefined;
                armedFor = undefined;
                if (beside(pos, pick.r)) {
                    active.arrival = n + 1;
                    const f = firstRoll(delay, n + 1, rate);
                    active.roll = f.roll;
                    delay = f.delay;
                }
            } else {
                waitTicks++;
                const next = soon;
                const arm = !!next && canCut && n + 2 === next.back && delay < n + 1 && armedFor !== next.back;
                const stands = next ? standTiles(next.r, rocks).sort((a, b) => cheb(pos, a) - cheb(pos, b)) : [];
                const walk = !!next && !stands.some(t => t.x === pos.x && t.z === pos.z) && walkingTo !== key(stands[0]!);
                drops(arm && walk ? 0 : arm || walk ? 1 : 2);
                if (walk) {
                    actions.push({ type: 'walkTo', x: stands[0]!.x, z: stands[0]!.z });
                    walkingTo = key(stands[0]!);
                }
                if (arm) {
                    cut();
                    preArms++;
                    armedFor = next!.back;
                }
                if (arm || modal) actions.push({ type: 'closeModal' });
            }
        }
        if (process.env.MINING_DEBUG === '1') {
            console.log(
                `MDBG n=${n} logs=${inv[NORMAL_LOGS] ?? 0} pos=${pos.x},${pos.z} made=${made} delay=${delay} active=${
                    active ? `${active.rock.x},${active.rock.z} a=${active.arrival} r=${active.roll}` : '-'
                } up=${rocks.map(r => (locAt(s, r) ? 1 : 0)).join('')} locs=${s.nearbyLocs.length} dlg=${!!s.dialog?.isOpen}/${!!s.interface?.isOpen}/${!!(s as any).modalOpen} acts=${actions.map(a => a.type).join(',')}`,
            );
        }
        if (actions.length) await send(actions);
        await d.step();
    }
    return {
        made,
        sideGems,
        attempts,
        outputs,
        xp: xpOf(state()) - xpOf(initial),
        ticks: d.tick() - start,
        banked: 0,
        dropped,
        knifeCuts,
        preArms,
        fletches,
        respawn,
        rolls,
        waitTicks,
    };
}
