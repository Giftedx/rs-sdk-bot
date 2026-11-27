import { existsSync } from 'node:fs';
import { isStopFilePresent } from '../stop';
import { initPathfinding } from '../../../../vendor/rs-sdk/sdk/pathfinding';
import type { BotWorldState, NearbyNpc } from '../../../../vendor/rs-sdk/sdk/types';
import { finish, openBot, sessionDied } from '../../../core/src/bot';
import { depositObserved } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { componentId } from '../../../core/src/logout';
import { holdSessionEater } from '../../../core/src/sustain';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { sessionWalker, walkPath } from '../../../core/src/walk';
import type { CombatSession, CombatTile } from './types';

let cachedRsmod: typeof import('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder') | undefined;
let cachedGearMod: typeof import('./gear') | undefined;
let cachedMeleeMod: typeof import('./melee-gather') | undefined;
let cachedRangedMod: typeof import('./ranged') | undefined;
let cachedSurvMod: typeof import('./survivability') | undefined;
let cachedTripKitMod: typeof import('./trip-kit') | undefined;

const loadRsmod = (): typeof import('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder') =>
    (cachedRsmod ??= require('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder'));
const loadGearMod = (): typeof import('./gear') => (cachedGearMod ??= require('./gear'));
const loadMeleeMod = (): typeof import('./melee-gather') => (cachedMeleeMod ??= require('./melee-gather'));
const loadRangedMod = (): typeof import('./ranged') => (cachedRangedMod ??= require('./ranged'));
const loadSurvMod = (): typeof import('./survivability') => (cachedSurvMod ??= require('./survivability'));
const loadTripKitMod = (): typeof import('./trip-kit') => (cachedTripKitMod ??= require('./trip-kit'));

const ATTACK_OP_RE = /^attack$/i;
const BAIL_WITH_RE = /^bail-with$/i;
const EMPTY_OP_RE = /^empty$/i;
const INSPECT_OP_RE = /^inspect$/i;
const FILL_OP_RE = /^fill$/i;
const NET_RIPPED_FAIL_RE = /^You fail to repair the net in the harsh conditions\.$/;
const NET_RIPPED_RE = /The net has ripped!/;
const FAIL_REPAIR_RE = /fail to repair the net/;

// ============================================================================
// 1. Black Dragon Safe-Corridor Camp (Taverley Dungeon)
// ============================================================================
type CampTile = { x: number; z: number };

export const BLACK_DRAGON = {
    npc: 54,
    size: 4,
    hitpoints: 190,
    hide: 1747,
    bones: 536,
    safe: { x: 2835, z: 9820 } as CampTile,
    range: 5,
    spawns: [{ x: 2829, z: 9826 }, { x: 2835, z: 9824 }] as CampTile[],
} as const;

export const CAMP_FOOD = [385, 373, 379] as const;
export const CAMP_ARROWS = [892, 890, 888, 886, 884, 882] as const;
export const PROTECT_MAGIC = 12;
export const EAT_AT = 60;
export const DASH_HP = 75;
export const MIN_ARROWS = 60;
export const OTHER_CLEAR = 5;
export const OTHER_WAIT = 40;
export const REATTACK = 6;

export function footprintDistance(sw: CampTile, tile: CampTile, size: number = BLACK_DRAGON.size): number {
    return Math.max(Math.max(sw.x - tile.x, tile.x - (sw.x + size - 1), 0), Math.max(sw.z - tile.z, tile.z - (sw.z + size - 1), 0));
}

export function canShoot(tile: CampTile, sw: CampTile, range: number = BLACK_DRAGON.range): boolean {
    initPathfinding();
    const rsmod = loadRsmod();
    return (
        Math.max(Math.abs(sw.x - tile.x), Math.abs(sw.z - tile.z)) <= range
        && rsmod.hasLineOfSight(0, tile.x, tile.z, sw.x, sw.z, 1, 1, 1, 1, 0)
        && rsmod.hasLineOfSight(0, tile.x, tile.z, sw.x, sw.z, 1, 1, BLACK_DRAGON.size, BLACK_DRAGON.size, 0)
    );
}

export const swTile = (n: Pick<NearbyNpc, 'x' | 'z' | 'tileX' | 'tileZ'>): CampTile => ({ x: n.tileX ?? n.x, z: n.tileZ ?? n.z });

export async function runBlackDragonCamp(s: CombatSession, o: { cap: number; kills: number; stop?: () => boolean }) {
    if (!Number.isSafeInteger(o.cap) || o.cap < 1 || o.cap > 20000 || !Number.isSafeInteger(o.kills) || o.kills < 1) {
        throw Error('invalid camp cap or kills');
    }
    const sess = s as Session;
    const eatHold = holdSessionEater(s.sdk);
    try {
        const SAFE = BLACK_DRAGON.safe;
        const st = () => s.sdk.getState();
        const me = () => st()?.player;
        const at = (t: CampTile) => {
            const p = me();
            return !!p && p.level === 0 && p.worldX === t.x && p.worldZ === t.z;
        };
        const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
        const xp = () => s.sdk.getSkillXp('Ranged') ?? 0;
        const inv = () => s.sdk.getInventory();
        const eq = () => s.sdk.getEquipment();
        const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        const quiver = () => eq().find(i => i.slot === 13 && (CAMP_ARROWS as readonly number[]).includes(i.id));
        const points = () => st()?.prayers?.prayerPoints ?? 0;
        const praying = () => !!st()?.prayers?.activePrayers?.[PROTECT_MAGIC];
        const own = (s.client as { selfSlot?: number } | undefined)?.selfSlot;
        const p0 = me();
        if (!p0 || p0.level !== 0 || Math.abs(p0.worldX - SAFE.x) > 1 || p0.worldZ > SAFE.z || p0.worldZ < SAFE.z - 3) {
            throw Error(`stage in the corridor at or south of ${SAFE.x},${SAFE.z}`);
        }
        if (!eq().some(i => i.slot === 3) || (quiver()?.count ?? 0) < MIN_ARROWS) {
            throw Error(`stage with a bow wielded and ${MIN_ARROWS} arrows in the quiver`);
        }
        if (typeof st()?.autoRetaliateEnabled !== 'boolean') throw Error('auto-retaliate state unknown');
        const ammo = quiver()!.id;
        const ammo0 = quiver()!.count + held(ammo);
        const start = s.tick();
        const xp0 = xp();
        const initialRetaliate = st()!.autoRetaliateEnabled;
        let ended = false;
        void s.ended.then(() => {
            ended = true;
        });
        const alive = () => {
            const p = me();
            return !ended && !!p && !p.isDead && p.lifeId === p0.lifeId && hp() > 0;
        };
        const over = () => !alive() || !!o.stop?.() || s.tick() - start >= o.cap;
        let kills = 0;
        let hides = 0;
        let bones = 0;
        let strays = 0;
        let hpMin = hp();
        let foods = 0;
        let lostPiles = 0;
        let failure = '';
        let reason = '';
        let lastHp = hp();
        let hits = 0;
        const off = s.onTick(() => {
            const curHp = hp();
            const p = me();
            if (curHp < lastHp && hits++ < 20) {
                console.log(
                    `DRAGON_CAMP hit t=${s.tick() - start} hp=${lastHp}->${curHp} at=${p?.worldX},${p?.worldZ} pray=${praying() ? 1 : 0} by=${JSON.stringify((st()?.nearbyNpcs ?? []).filter(n => Number.isInteger(own) && n.targetIndex === 32768 + own!).map(n => `${n.name}@${swTile(n).x},${swTile(n).z}`))}`,
                );
            }
            lastHp = curHp;
            hpMin = Math.min(hpMin, curHp);
        });
        const dragons = () => (st()?.nearbyNpcs ?? []).filter(n => n.id === BLACK_DRAGON.npc && n.hp !== 0);
        const attackOp = (n: typeof dragons extends () => (infer U)[] ? U : never) => n.optionsWithIndex.find(v => ATTACK_OP_RE.test(v.text))?.opIndex;
        const backToSafe = async () => {
            if (at(SAFE)) return;
            strays++;
            await walkPath(await sessionWalker(sess), [{ ...SAFE, tol: 0 }], { maxTicks: 40, stop: () => !alive() });
            if (!at(SAFE)) throw Error('return to the safe tile failed');
        };
        const eat = async (below: number) => {
            while (hp() < below && alive()) {
                const food = inv().find(i => (CAMP_FOOD as readonly number[]).includes(i.id));
                if (!food) return;
                const before = hp();
                await s.sdk.sendUseItem(food.slot, 1);
                if (!(await waitUntil(s, () => hp() > before || !alive(), { timeoutTicks: 4 }))) return;
                foods++;
                await waitTicks(s, 2);
            }
        };
        const pray = async (on: boolean) => {
            if (praying() === on || (on && points() <= 0)) return;
            await s.sdk.sendTogglePrayer(PROTECT_MAGIC);
            await waitUntil(s, () => praying() === on, { timeoutTicks: 3 });
        };
        const pick = () => {
            const npcs = st()?.nearbyNpcs ?? [];
            let best: (typeof npcs)[number] | undefined;
            let bestCombat = false;
            let bestHp = 0;
            let bestDist = Infinity;
            for (let i = 0; i < npcs.length; i++) {
                const n = npcs[i]!;
                if (n.id !== BLACK_DRAGON.npc || n.hp === 0) continue;
                if (n.inCombat && !(Number.isInteger(own) && n.targetIndex === 32768 + own!)) continue;
                if (attackOp(n) === undefined || !canShoot(SAFE, swTile(n))) continue;
                const hpVal = n.hp ?? BLACK_DRAGON.hitpoints;
                if (
                    best === undefined
                    || (n.inCombat && !bestCombat)
                    || (n.inCombat === bestCombat && (hpVal < bestHp || (hpVal === bestHp && n.distance < bestDist)))
                ) {
                    best = n;
                    bestCombat = n.inCombat;
                    bestHp = hpVal;
                    bestDist = n.distance;
                }
            }
            return best;
        };
        const intruder = () =>
            (st()?.nearbyNpcs ?? []).find(
                n => n.id !== BLACK_DRAGON.npc && n.hp !== 0 && Number.isInteger(own) && n.targetIndex === 32768 + own! && attackOp(n) !== undefined,
            );
        const groundKey = (g: { id: number; x: number; z: number }) => `${g.id}:${g.x}:${g.z}`;
        const fetch = async (pile: CampTile) => {
            for (let t = 0; t < OTHER_WAIT && !over() && dragons().some(n => footprintDistance(swTile(n), pile) <= OTHER_CLEAR); t += 2) {
                await waitTicks(s, 2);
            }
            await eat(DASH_HP);
            if (over()) return;
            if (points() <= 0 && (hp() < DASH_HP || dragons().some(n => footprintDistance(swTile(n), pile) <= 2))) {
                lostPiles++;
                console.log(`DRAGON_CAMP pile left at ${pile.x},${pile.z}: no prayer and a dragon beside it`);
                return;
            }
            await pray(true);
            try {
                for (const id of [BLACK_DRAGON.hide, BLACK_DRAGON.bones, ammo]) {
                    const g = s.sdk.getGroundItems().find(i => i.id === id && i.x === pile.x && i.z === pile.z);
                    if (!g || (id === ammo && g.count < 5) || (id !== ammo && inv().length >= 28)) continue;
                    const before = held(id);
                    if (!(await s.sdk.sendPickup(g.x, g.z, g.id)).success) continue;
                    await waitUntil(s, () => held(id) > before || !alive(), { timeoutTicks: 14 });
                    if (id === BLACK_DRAGON.hide) hides += held(id) - before;
                    else if (id === BLACK_DRAGON.bones) bones += held(id) - before;
                }
            } finally {
                if (alive()) {
                    const left = !at(SAFE);
                    await backToSafe();
                    if (left) strays--;
                    await pray(false);
                }
            }
            const picked = inv().find(i => i.id === ammo);
            if (picked) {
                const { reconcileCombatLoadout } = loadGearMod();
                await reconcileCombatLoadout(sess, { style: 'ranged', trainSkill: 'ranged', pin: { weapon: eq().find(i => i.slot === 3)!.id, ammo }, label: 'camp ammo' });
                await waitUntil(s, () => held(ammo) === 0, { timeoutTicks: 5 });
            }
        };
        try {
            if (initialRetaliate) {
                await s.direct({ type: 'clickComponent', componentId: 151, reason: 'camp holds its tile' });
                if (!(await waitUntil(s, () => st()?.autoRetaliateEnabled === false, { timeoutTicks: 8 }))) throw Error('auto-retaliate off unobserved');
            }
            const { giantStyle } = loadMeleeMod();
            const style = giantStyle(st()?.combatStyle as Parameters<typeof giantStyle>[0], 'Ranged');
            if (st()?.combatStyle?.currentStyle !== style.index) {
                await s.sdk.sendSetCombatStyle(style.index);
                await waitUntil(s, () => st()?.combatStyle?.currentStyle === style.index, { timeoutTicks: 8 });
            }
            let idle = 0;
            while (!over() && kills < o.kills) {
                await backToSafe();
                await eat(EAT_AT);
                if (hp() < EAT_AT && !inv().some(i => (CAMP_FOOD as readonly number[]).includes(i.id))) {
                    reason = 'out of food';
                    break;
                }
                if ((quiver()?.count ?? 0) < MIN_ARROWS) {
                    reason = 'arrows low';
                    break;
                }
                if (inv().length > 26) {
                    reason = 'pack full';
                    break;
                }
                const foe = intruder();
                const target = foe ?? pick();
                if (!target) {
                    await waitTicks(s, 2);
                    idle += 2;
                    if (idle >= 400) {
                        reason = 'no dragon in sight for 400 ticks';
                        break;
                    }
                    continue;
                }
                idle = 0;
                const ground0 = new Set(s.sdk.getGroundItems().filter(g => g.id === BLACK_DRAGON.hide).map(groundKey));
                if (!(await s.sdk.sendInteractNpc(target.index, attackOp(target)!)).success) {
                    await waitTicks(s, 2);
                    continue;
                }
                let lastXp = xp();
                let lastHit = s.tick();
                let gone = false;
                while (!over()) {
                    await waitTicks(s, 1);
                    if (!at(SAFE)) {
                        const p = me();
                        const q = (st()?.nearbyNpcs ?? []).find(v => v.index === target.index);
                        console.log(`DRAGON_CAMP stray t=${s.tick() - start} at=${p?.worldX},${p?.worldZ} target=${q ? `${swTile(q).x},${swTile(q).z}` : 'gone'} hp=${hp()}`);
                        break;
                    }
                    const n = (st()?.nearbyNpcs ?? []).find(v => v.index === target.index && v.id === target.id);
                    if (!n || n.hp === 0) {
                        gone = true;
                        break;
                    }
                    if (target.id === BLACK_DRAGON.npc && !canShoot(SAFE, swTile(n))) {
                        await s.sdk.sendWalk(SAFE.x, SAFE.z);
                        break;
                    }
                    if (xp() > lastXp) {
                        lastXp = xp();
                        lastHit = s.tick();
                    }
                    if (hp() < EAT_AT) {
                        await eat(EAT_AT);
                        lastHit = s.tick() - REATTACK;
                    }
                    if (!foe && intruder()) break;
                    if (s.tick() - lastHit >= REATTACK) {
                        if (target.id === BLACK_DRAGON.npc && !canShoot(SAFE, swTile(n))) break;
                        await s.sdk.sendInteractNpc(n.index, attackOp(n) ?? attackOp(target)!);
                        lastHit = s.tick();
                    }
                }
                if (!gone || target.id !== BLACK_DRAGON.npc) continue;
                let pile: CampTile | undefined;
                await waitUntil(
                    s,
                    () => {
                        const g = s.sdk.getGroundItems().find(i => i.id === BLACK_DRAGON.hide && !ground0.has(groundKey(i)));
                        if (g) pile = { x: g.x, z: g.z };
                        return !!g || !alive();
                    },
                    { timeoutTicks: 8 },
                );
                if (!pile) continue;
                kills++;
                console.log(`DRAGON_CAMP kill ${kills} t=${s.tick() - start} pile=${pile.x},${pile.z} hp=${hp()} arrows=${quiver()?.count ?? 0}`);
                await fetch(pile);
            }
            if (!reason) reason = kills >= o.kills ? 'kills met' : o.stop?.() ? 'stopped' : !alive() ? 'life lost' : 'cap';
        } catch (e) {
            failure = String(e);
        } finally {
            off();
            if (alive()) {
                try {
                    await pray(false);
                    if (st()?.autoRetaliateEnabled !== initialRetaliate) {
                        await s.direct({ type: 'clickComponent', componentId: initialRetaliate ? 150 : 151, reason: 'restore camp auto-retaliate' });
                        await waitUntil(s, () => st()?.autoRetaliateEnabled === initialRetaliate, { timeoutTicks: 8 });
                    }
                } catch (e) {
                    failure += '; cleanup ' + String(e);
                }
            }
        }
        const ammoUsed = ammo0 - (quiver()?.count ?? 0) - held(ammo);
        return {
            ok: !failure && alive() && kills > 0,
            kills,
            hides,
            bones,
            lostPiles,
            reason,
            failure,
            strays,
            hpMin,
            foods,
            ammo,
            ammoUsed,
            drops: { [BLACK_DRAGON.hide]: hides, [BLACK_DRAGON.bones]: bones },
            rangedXp: xp() - xp0,
            ticks: s.tick() - start,
        };
    } finally {
        eatHold.release();
    }
}

export const VARROCK_WEST = { x: 3185, z: 3436 };
export const TELEPORT_RUNES = { 563: 1, 556: 3, 554: 1 } as const;
export const underground = (p: { worldZ: number } | null | undefined) => !!p && p.worldZ > 9000;

export async function leaveToVarrock(s: CombatSession): Promise<{ banked: Record<number, number> }> {
    const { varrockTeleport } = loadTripKitMod();
    const sess = s as Session;
    const st = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    for (const [id, n] of Object.entries(TELEPORT_RUNES)) {
        if (held(Number(id)) < n) throw Error(`black dragon leave: ${held(Number(id))} of rune ${id} in the pack, the Varrock teleport needs ${n}; a person decides the way out`);
    }
    if (!(await varrockTeleport(s))) throw Error('black dragon leave: the Varrock teleport did not take the account');
    const walked = await walkPath(await sessionWalker(sess), [{ ...VARROCK_WEST, tol: 1 }], { maxTicks: 200 });
    if (!walked.ok) throw Error(`black dragon leave: walk to the Varrock West bank: ${walked.detail}`);
    const generation = s.bankObservation?.()?.generation ?? 0;
    if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!st()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 20 }))) {
        throw Error('black dragon leave: bank did not open');
    }
    const banked: Record<number, number> = {};
    for (const id of new Set(inv().map(i => i.id))) {
        const row = inv().find(i => i.id === id);
        const n = held(id);
        if (!row || !(await s.bot.depositItem(row, n)).success || !(await waitUntil(s, () => held(id) === 0, { timeoutTicks: 10 }))) {
            throw Error(`black dragon leave: deposit of item ${id}`);
        }
        banked[id] = n;
    }
    await s.bot.closeBank();
    await waitUntil(s, () => !st()?.bank?.isOpen, { timeoutTicks: 10 });
    return { banked };
}

export async function runBlackDragonCli(args: readonly string[], env: Record<string, string | undefined> = process.env) {
    let s: CombatSession | undefined;
    let stopped = false;
    try {
        const [account, cap] = args;
        if (!account) throw Error('account required');
        s = await openBot(account, {
            onStop: async () => {
                stopped = true;
            },
        });
        const stop = () => stopped || existsSync(`.practice/stop-${account}`) || existsSync('.practice/stop-all');
        const kills = Number(env.KILLS ?? 9);
        if (env.STAGED === '1') {
            const r = await runBlackDragonCamp(s, { cap: Number(cap ?? 6000), kills, stop });
            console.log('BLACK_DRAGON_CAMP_RESULT ' + JSON.stringify(r));
            await finish(
                [s],
                r.ok,
                `black-dragon-camp kills=${r.kills} hides=${r.hides} bones=${r.bones} ammoUsed=${r.ammoUsed} foods=${r.foods} hpMin=${r.hpMin} strays=${r.strays} reason=${r.reason}${r.failure ? ' failure=' + r.failure : ''}`,
            );
        } else {
            const { combatWalkTargetPersist } = loadSurvMod();
            const { BLACK_BANK, blackKit, combatTrip } = loadTripKitMod();
            const live = s;
            await waitUntil(live, () => !!live.sdk.getState()?.player, { timeoutTicks: 15 });
            if (underground(live.sdk.getState()?.player)) {
                const out = await leaveToVarrock(live);
                console.log('DRAGON_CAMP left the dungeon ' + JSON.stringify(out));
                if (env.LEAVE === '1') {
                    await finish([s], true, `black-dragon-leave hides=${out.banked[BLACK_DRAGON.hide] ?? 0} bones=${out.banked[BLACK_DRAGON.bones] ?? 0} banked=true`);
                    return;
                }
            } else if (env.LEAVE === '1') {
                throw Error('black dragon leave: the account is not in the dungeon');
            }
            const here = live.sdk.getState()?.player;
            if (!here || here.level !== 0 || Math.max(Math.abs(here.worldX - BLACK_BANK.x), Math.abs(here.worldZ - BLACK_BANK.z)) > 3) {
                const there = await combatWalkTargetPersist(live, BLACK_BANK);
                if (!there.ok) throw Error(`route to the Falador west bank: ${there.reason ?? ''} ${there.detail ?? ''}`);
            }
            const kit = blackKit(env.ARROW ?? 'mithril_arrow', Number(env.ARROWS ?? 700));
            const r = await combatTrip(
                live,
                'black',
                async tripStop => {
                    const c = await runBlackDragonCamp(live, { cap: 5000, kills, stop: tripStop });
                    return { ...c, failure: c.failure };
                },
                { cap: Number(cap ?? 9000), stop, kit },
            );
            const c = r.result as Awaited<ReturnType<typeof runBlackDragonCamp>> | undefined;
            console.log('BLACK_DRAGON_TRIP_RESULT ' + JSON.stringify(r));
            await finish(
                [s],
                r.ok,
                `black-dragon-trip kills=${c?.kills ?? 0} hides=${c?.hides ?? 0} bones=${c?.bones ?? 0} ammoUsed=${c?.ammoUsed ?? 0} hpMin=${c?.hpMin ?? '-'} banked=${r.banked} ticks=${r.ticks}${r.failure ? ' failure=' + r.failure : ''}`,
            );
        }
    } catch (e) {
        await finish(s ? [s] : [], false, String(e));
    }
}

// ============================================================================
// 2. King Black Dragon (KBD)
// ============================================================================
export const KBD_DROP_IDS = [536, 1747] as const;

const kbdCount = (s: BotWorldState, id: number) => s.inventory.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const kbdHp = (s: BotWorldState) => s.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;
const kbdCombatXp = (s: BotWorldState) => s.skills.filter(k => ['Attack', 'Strength', 'Defence', 'Ranged', 'Magic'].includes(k.name)).reduce((n, k) => n + k.experience, 0);

export function inKbdLair(s: BotWorldState) {
    const p = s.player;
    return !!p && p.level === 0 && p.worldX >= 2688 && p.worldX < 2752 && p.worldZ >= 9792 && p.worldZ < 9856;
}

export function selectKbdTarget(s: BotWorldState, selfSlot?: number) {
    return s.nearbyNpcs.find(
        n =>
            n.id === 50
            && n.reachable !== false
            && ((n.hp === null && n.maxHp === null) || (n.hp === 240 && n.maxHp === 240))
            && (!n.inCombat || (Number.isInteger(selfSlot) && n.targetIndex === 32768 + selfSlot!)),
    );
}

export function kbdEntryFailure(s: BotWorldState | null, selfSlot?: number) {
    if (!s?.player || !inKbdLair(s)) return 'stage inside native KBD lair';
    if (kbdHp(s) < 70) return 'KBD needs at least 70 current HP';
    if (!s.equipment.some(i => i.id === 1540 && i.slot === 5)) return 'KBD needs worn anti-dragon shield';
    if (!s.equipment.some(i => i.slot === 3 && i.id === 1289)) return 'KBD needs native rune sword';
    if (!s.equipment.some(i => i.slot === 4 && i.id === 1113) || !s.equipment.some(i => i.slot === 7 && i.id === 1079)) {
        return 'KBD needs native rune chainbody and platelegs';
    }
    if ((s.skills.find(k => k.name === 'Attack')?.level ?? 0) < 40 || (s.skills.find(k => k.name === 'Defence')?.level ?? 0) < 40) {
        return 'KBD needs native Attack40 and Defence40';
    }
    if ((s.skills.find(k => k.name === 'Magic')?.level ?? 0) < 25) return 'KBD needs Magic25 emergency teleport';
    if ((s.prayers?.prayerLevel ?? 0) < 43 || (s.prayers?.prayerPoints ?? 0) < 30) return 'KBD needs Prayer43 and 30 points';
    if (kbdCount(s, 385) < 6) return 'KBD needs six staged sharks';
    if (!kbdCount(s, 2448) || !kbdCount(s, 2452)) return 'KBD needs super antipoison(4) and antifire(4)';
    if (!kbdCount(s, 2436) || !kbdCount(s, 2440) || kbdCount(s, 2434) < 2) return 'KBD needs native super attack, super strength and two prayer potions';
    if (kbdCount(s, 563) < 1 || kbdCount(s, 556) < 3 || kbdCount(s, 554) < 1) return 'KBD needs reserved Varrock runes';
    if (s.inventory.length > 26) return 'KBD needs two free drop slots';
    if (s.nearbyPlayers.length) return 'KBD needs an uncontested lair';
    const target = selectKbdTarget(s, selfSlot);
    if (!target) return 'KBD needs free native dragon50 without known damage';
    return null;
}

export function kbdKillCredit(gone: boolean, xpGain: number, drops: readonly number[]) {
    return gone && xpGain >= 240 * 4 && drops.length === 2 && drops.every(n => n === 1);
}

export function kbdRetreatReason(s: BotWorldState, used: number, cap: number) {
    if (!inKbdLair(s)) return 'left lair';
    if (kbdHp(s) < 35) return 'low HP';
    if ((s.prayers?.prayerPoints ?? 0) < 10) return 'low prayer';
    if (!s.equipment.some(i => i.id === 1540 && i.slot === 5)) return 'shield missing';
    if (s.nearbyPlayers.length) return 'another player entered';
    if (used >= cap) return 'combat cap';
    if (kbdHp(s) <= 50 && kbdCount(s, 385) === 0) return 'food exhausted';
    return null;
}

export async function runKbdOne(
    s: CombatSession,
    o: { cap: number; stop: () => boolean; wait?: (test: () => boolean, ticks: number) => Promise<boolean>; step?: () => Promise<void> },
) {
    if (!Number.isSafeInteger(o.cap) || o.cap < 1 || o.cap > 1000) throw Error('KBD CAP must be 1..1000 ticks');
    const { eatBetweenCasts } = loadSurvMod();
    const eatHold = holdSessionEater(s.sdk);
    try {
        const own = (s.client as { selfSlot?: number } | undefined)?.selfSlot;
        const initial = s.sdk.getState();
        const preflight = kbdEntryFailure(initial, own);
        if (preflight) throw Error(preflight);
        const start = s.tick();
        const life = initial!.player!.lifeId;
        const heldStart = new Map(initial!.inventory.map(i => [i.id, kbdCount(initial!, i.id)]));
        let ended = false;
        void s.ended.then(() => {
            ended = true;
        });
        let attacked = false;
        let credited = false;
        let looted = 0;
        let foods = 0;
        let failure = '';
        let escaped = false;
        let protectionTick = s.tick();
        let actionReadyAt = s.tick();
        let acquired: Record<number, number> = {};
        const potions: Record<number, number> = {};
        const wait = o.wait ?? ((test: () => boolean, ticks: number) => waitUntil(s, test, { timeoutTicks: ticks }));
        const step = o.step ?? (() => waitTicks(s, 1));
        const st = () => {
            const current = s.sdk.getState();
            if (ended || !current?.player) throw Error('KBD session ended');
            if (current.player.lifeId !== life || current.player.isDead || kbdHp(current) < 1) throw Error('KBD life changed');
            return current;
        };
        const pendingStop = () => ended || o.stop() || !!kbdRetreatReason(st(), s.tick() - start, o.cap);
        const eat = async () => {
            const food = await eatBetweenCasts(s, { food: [385], eatAt: 50, timeoutTicks: 5, attempts: 2 });
            if (food) {
                foods++;
                actionReadyAt = s.tick() + 3;
                while (s.tick() < actionReadyAt) {
                    await step();
                    st();
                }
            }
        };
        const usePotion = async (id: number, next: number) => {
            if (pendingStop()) throw Error('KBD stopped before potion');
            if (kbdHp(st()) <= 50) await eat();
            const before = st();
            const old = kbdCount(before, id);
            const oldNext = kbdCount(before, next);
            const item = before.inventory.find(i => i.id === id);
            const op = item?.optionsWithIndex.find(v => /^drink$/i.test(v.text));
            if (!item || !op) throw Error(`KBD potion ${id} unavailable`);
            const reply = (await s.direct({ type: 'useInventoryItem', slot: item.slot, optionIndex: op.opIndex, reason: 'SDK' })) as { success?: boolean } | undefined;
            if (reply?.success !== true) throw Error('KBD potion refused');
            if (
                !(await wait(() => {
                    if (kbdHp(st()) < 35) throw Error('KBD low HP during potion');
                    return kbdCount(st(), id) === old - 1 && kbdCount(st(), next) === oldNext + 1;
                }, 8))
            ) {
                throw Error('KBD potion transform unobserved');
            }
            potions[id] = (potions[id] ?? 0) - 1;
            potions[next] = (potions[next] ?? 0) + 1;
            actionReadyAt = s.tick() + 3;
            while (s.tick() < actionReadyAt) {
                await step();
                if (kbdHp(st()) < 35) throw Error('KBD low HP settling potion');
            }
        };
        const escape = async () => {
            if (ended) return;
            const before = st();
            if (!inKbdLair(before)) {
                escaped = before.player!.level === 0 && Math.max(Math.abs(before.player!.worldX - 3213), Math.abs(before.player!.worldZ - 3424)) <= 5;
                return;
            }
            while (s.tick() < actionReadyAt) {
                await step();
                st();
            }
            for (let n = 0; n < 2; n++) {
                await s.sdk.sendCloseModal();
                const r = (await s.direct({ type: 'clickComponent', componentId: componentId('magic:varrock_teleport'), reason: 'SDK' })) as { success?: boolean } | undefined;
                if (
                    r?.success === true
                    && (await wait(() => {
                        const p = s.sdk.getState()?.player;
                        return !!p && p.level === 0 && Math.max(Math.abs(p.worldX - 3213), Math.abs(p.worldZ - 3424)) <= 5;
                    }, 12))
                ) {
                    escaped = true;
                    break;
                }
            }
            if (!escaped) throw Error('KBD emergency teleport unobserved');
            const after = st();
            if (kbdCount(before, 563) - kbdCount(after, 563) !== 1) throw Error('KBD teleport law debit invalid');
        };
        try {
            if (o.stop()) throw Error('KBD stopped before combat');
            await s.sdk.sendCloseModal();
            if (
                !(await s.sdk.sendSetCombatStyle(0)).success
                || !(await wait(() => {
                    const c = st().combatStyle;
                    return !!c?.known && c.currentStyle === 0 && c.weaponName === 'Rune sword' && c.styles.some(v => v.index === 0 && v.damageType === 'Stab' && v.trainsSkills.includes('Attack'));
                }, 8))
            ) {
                throw Error('KBD accurate native Stab style unknown');
            }
            if (!st().prayers.activePrayers[14]) {
                if (!(await s.sdk.sendTogglePrayer(14)).success || !(await wait(() => !!st().prayers.activePrayers[14], 5))) {
                    throw Error('KBD melee protection unobserved');
                }
            }
            await usePotion(2448, 181);
            if (kbdHp(st()) <= 50) await eat();
            await usePotion(2452, 2454);
            protectionTick = s.tick();
            await usePotion(2436, 145);
            await usePotion(2440, 157);
            if (pendingStop()) throw Error('KBD stop before attack');
            const before = st();
            const xpBefore = kbdCombatXp(before);
            const target = selectKbdTarget(before, own);
            if (!target) throw Error('KBD target changed');
            const ground = (state: BotWorldState, id: number, x: number, z: number) => state.groundItems.filter(i => i.id === id && i.x === x && i.z === z).reduce((n, i) => n + i.count, 0);
            const beforeGround = new Map<string, number>();
            for (const item of before.groundItems) beforeGround.set(`${item.id}:${item.x}:${item.z}`, (beforeGround.get(`${item.id}:${item.x}:${item.z}`) ?? 0) + item.count);
            const attackOp = target.optionsWithIndex.find(v => /^attack$/i.test(v.text));
            if (!attackOp) throw Error('KBD attack option missing');
            if (!(await s.sdk.sendInteractNpc(target.index, attackOp.opIndex)).success) throw Error('KBD attack refused');
            attacked = true;
            let x = target.tileX ?? target.x;
            let z = target.tileZ ?? target.z;
            let progress = s.tick();
            let lastXp = xpBefore;
            let gone = false;
            let lastAttack = s.tick();
            while (true) {
                let current = st();
                const reason = kbdRetreatReason(current, s.tick() - start, o.cap);
                if (o.stop() || reason) throw Error(reason ?? 'KBD stopped');
                if (!current.prayers.activePrayers[14]) throw Error('KBD protection dropped');
                if (kbdHp(current) <= 50) {
                    await eat();
                    current = st();
                }
                if (current.prayers.prayerPoints <= 30) {
                    const stages = [2434, 139, 141, 143, 229];
                    const id = stages.slice(0, -1).find(pot => kbdCount(current, pot) > 0);
                    if (id === undefined) throw Error('KBD prayer refill exhausted');
                    const prevPoints = current.prayers.prayerPoints;
                    await usePotion(id, stages[stages.indexOf(id) + 1]!);
                    if (st().prayers.prayerPoints <= prevPoints) throw Error('KBD prayer refill effect missing');
                    current = st();
                }
                if (s.tick() - protectionTick >= 450) {
                    const potionChains: readonly (readonly number[])[] = [
                        [2448, 181, 183, 185, 229],
                        [2452, 2454, 2456, 2458, 229],
                    ];
                    for (const stages of potionChains) {
                        const id = stages.slice(0, -1).find(pot => kbdCount(st(), pot) > 0);
                        if (id === undefined) throw Error('KBD protection refill exhausted');
                        await usePotion(id, stages[stages.indexOf(id) + 1]!);
                    }
                    protectionTick = s.tick();
                    current = st();
                }
                const npc = current.nearbyNpcs.find(n => n.index === target.index && n.id === 50);
                if (npc && Number.isInteger(own) && loadRangedMod().campOwnershipConflict(npc, own!)) throw Error('KBD target ownership changed');
                if (npc) {
                    x = npc.tileX ?? npc.x;
                    z = npc.tileZ ?? npc.z;
                } else {
                    gone = true;
                }
                const gain = kbdCombatXp(current) - xpBefore;
                const drops = KBD_DROP_IDS.map(id => ground(current, id, x, z) - (beforeGround.get(`${id}:${x}:${z}`) ?? 0));
                if (kbdKillCredit(gone, gain, drops)) {
                    credited = true;
                    break;
                }
                if (kbdCombatXp(current) > lastXp) {
                    lastXp = kbdCombatXp(current);
                    progress = s.tick();
                }
                for (const event of current.combatEvents ?? []) {
                    if (
                        event.type === 'damage_dealt'
                        && event.sourceType === 'player'
                        && event.targetType === 'npc'
                        && event.targetIndex === target.index
                        && event.tick >= start
                        && event.tick <= s.tick()
                    ) {
                        progress = Math.max(progress, event.tick);
                    }
                }
                if (npc && npc.hp !== 0 && s.tick() - lastAttack >= 12 && (current.player!.combat?.targetIndex !== target.index || s.tick() - progress >= 24)) {
                    if (!(await s.sdk.sendInteractNpc(target.index, attackOp.opIndex)).success) throw Error('KBD resume attack refused');
                    lastAttack = s.tick();
                }
                if (s.tick() - progress >= 80) throw Error('KBD no observed attack or credited drop progress');
                await step();
            }
            const fresh = st().groundItems.filter(i => i.x === x && i.z === z);
            if (fresh.some(i => (beforeGround.get(`${i.id}:${x}:${z}`) ?? 0) > 0)) throw Error('KBD drop pile attribution ambiguous');
            const ids = [...new Set(fresh.map(i => i.id))];
            const units = fresh.reduce((n, i) => n + i.count, 0);
            const client = s.client as { objType?: (id: number) => { cost: number; stackable: boolean } } | undefined;
            const { runVisibleGroundLoot } = loadSurvMod();
            const loot = await runVisibleGroundLoot(
                {
                    state: () => {
                        const v = st();
                        return { ...v, groundItems: v.groundItems.filter(i => i.x === x && i.z === z && ids.includes(i.id)) };
                    },
                    tick: () => s.tick(),
                    stop: pendingStop,
                    definition: id => client?.objType?.(id),
                    pickup: async i => (await s.sdk.sendPickup(i.x, i.z, i.id)).success,
                    wait,
                    step,
                    clearModal: async () => {
                        await s.sdk.sendCloseModal();
                    },
                },
                { mode: 'list', ids, names: [], minimumValue: 0, maximumValue: 2147483647, radius: 12, maximumUnits: units, cap: 40, idleTicks: 12 },
            );
            acquired = loot.acquired;
            looted = KBD_DROP_IDS.filter(id => loot.acquired[id] === 1).length;
        } catch (e) {
            failure = String(e);
        } finally {
            try {
                await escape();
            } catch (e) {
                failure = [failure, String(e)].filter(Boolean).join('; ');
            }
        }
        if (escaped && st().prayers.activePrayers[14]) {
            await s.sdk.sendTogglePrayer(14);
            if (!(await wait(() => !st().prayers.activePrayers[14], 5))) failure += '; protection cleanup unobserved';
        }
        const final = st();
        const drops = acquired;
        if (!credited || looted !== 2 || !escaped || KBD_DROP_IDS.some(id => (drops[id] ?? 0) !== 1 || kbdCount(final, id) - (heldStart.get(id) ?? 0) !== 1)) {
            failure ||= 'KBD kill, loot and escape target incomplete';
        }
        return { ok: !failure, attacked, credited, looted, escaped, foods, potions, drops, ticks: s.tick() - start, failure };
    } finally {
        eatHold.release();
    }
}

export async function runKbdCli(args: readonly string[], env: Record<string, string | undefined> = process.env) {
    const name = args[0];
    const cap = Number(env.CAP ?? 1000);
    if (!name) throw Error('account required');
    let stopped = false;
    const s = await openBot(name, {
        onStop: async () => {
            stopped = true;
        },
    }).catch(e => finish([], false, `login: ${String(e)}`));
    try {
        const { combatTrip } = loadTripKitMod();
        const stop = () => stopped || existsSync(`.practice/stop-${name}`) || existsSync('.practice/stop-all');
        const result =
            env.STAGED === '1'
                ? await runKbdOne(s, { cap, stop })
                : await combatTrip(s, 'kbd', tripStop => runKbdOne(s, { cap, stop: tripStop }), { cap: Number(env.TRIP_CAP ?? 5000), stop });
        await finish([s], result.ok, JSON.stringify(result));
    } catch (e) {
        await finish([s], false, String(e));
    }
}

// ============================================================================
// 3. Wilderness Green Dragons
// ============================================================================
const WILD_GLORY_IDS = [1712, 1710, 1708, 1706] as const;
const WILD_LAW_RUNE_ID = 563;

const countId = (s: BotWorldState, id: number) => {
    let n = 0;
    const inv = s.inventory;
    for (let i = 0; i < inv.length; i++) {
        if (inv[i]!.id === id) n += inv[i]!.count;
    }
    return n;
};
const countDragonFood = (s: BotWorldState) => {
    const { DRAGON_FOOD_IDS } = loadSurvMod();
    let n = 0;
    const inv = s.inventory;
    for (let i = 0; i < inv.length; i++) {
        const item = inv[i]!;
        if ((DRAGON_FOOD_IDS as readonly number[]).includes(item.id)) n += item.count;
    }
    return n;
};

export interface WildDragonOptions {
    cap: number;
    foodCount: number;
    eatAt: number;
    escapeAt: number;
    maxTrips: number;
    staged?: boolean;
    stop?: () => boolean;
}

export async function runWildDragons(s: CombatSession, o: WildDragonOptions) {
    const {
        depositPack,
        DRAGON_BONES_ID,
        DRAGON_FOOD_IDS,
        DRAGON_LOOT_IDS,
        eatBetweenCasts,
        EDGEVILLE_BANK,
        fleetNames,
        GREEN_DHIDE_ID,
        GREEN_DRAGON_SPOT,
        hasVarrockTeleport,
        SAFE_SOUTH_TILE,
        selectGreenDragon,
        wildDragonEscapeAction,
        wildDragonEscapeKeep,
        wildDragonPreflight,
        wildDragonRetreatReason,
        wildDragonWalkHalt,
        wildernessLevel,
    } = loadSurvMod();
    const sess = s as Session;
    const eatHold = holdSessionEater(s.sdk);
    try {
        const st = () => s.sdk.getState();
        const hp = () => st()?.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;
        if (!(await waitUntil(s, () => !!st()?.player && hp() > 0, { timeoutTicks: 15 }))) {
            throw Error('wild-dragons: initial state unknown');
        }
        const p0 = st()!.player!;
        const start = s.tick();
        const ours = fleetNames();
        const magic0 = st()!.skills.find(k => k.name === 'Magic')?.level ?? 1;
        const escapeLawReserve = hasVarrockTeleport(magic0, st()!.inventory, st()!.equipment) ? Math.min(countId(st()!, WILD_LAW_RUNE_ID), 5) : 0;
        const inWild0 = wildernessLevel(p0.worldZ) > 0;
        const preflight = wildDragonPreflight(st(), !!o.staged || inWild0);
        if (preflight) throw Error(`wild-dragons preflight: ${preflight}`);
        let ended = false;
        let died = false;
        let hpMin = hp();
        let kills = 0;
        let bonesBanked = 0;
        let hidesBanked = 0;
        let eaten = 0;
        let escapes = 0;
        let trips = 0;
        let stop = 'cap';
        void s.ended.then(() => {
            ended = true;
        });
        const off = s.onTick(() => {
            const cur = st();
            hpMin = Math.min(hpMin, hp());
            if (sessionDied(p0, cur?.player)) died = true;
        });
        const over = () => ended || died || !!o.stop?.() || s.tick() - start >= o.cap;
        const walker = await sessionWalker(sess);
        const walkSafe = async (target: { x: number; z: number }, maxTicks = 450, halt: () => boolean = over) =>
            walkPath(walker, [{ ...target, tol: 2 }], { maxTicks, stop: halt });
        const baseHp = () => st()?.skills.find(k => k.name === 'Hitpoints')?.baseLevel ?? hp();
        const inWild = () => wildernessLevel(st()?.player?.worldZ ?? 0) > 0;
        const danger = () => { const cur = st(); return !!cur && wildDragonWalkHalt(cur, o, ours); };
        // Eat to within one shark of full before the walk in. A shark heals 20.
        const healBeforeWild = async () => {
            for (let i = 0; i < 28 && !over() && !inWild() && hp() < baseHp() - 12; i++) {
                const ate = await eatBetweenCasts(s, { food: [...DRAGON_FOOD_IDS], eatAt: baseHp() - 12, timeoutTicks: 4, attempts: 1 });
                if (!ate) break;
                eaten++;
            }
        };
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
                    const glory = st()!.inventory.find(i => (WILD_GLORY_IDS as readonly number[]).includes(i.id));
                    const wornGlory = !glory ? st()!.equipment.find(i => i.slot === 2 && (WILD_GLORY_IDS as readonly number[]).includes(i.id)) : undefined;
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
            if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!st()?.bank?.isOpen, { timeoutTicks: 15 }))) return false;
            const inv = st()!;
            bonesBanked += countId(inv, DRAGON_BONES_ID);
            hidesBanked += countId(inv, GREEN_DHIDE_ID);
            const excessLaws = Math.max(0, countId(inv, WILD_LAW_RUNE_ID) - escapeLawReserve);
            if (excessLaws > 0 && escapeLawReserve > 0) {
                const lawItem = inv.inventory.find(i => i.id === WILD_LAW_RUNE_ID);
                if (lawItem) {
                    await s.bot.depositItem(lawItem, excessLaws);
                    await waitTicks(s, 1);
                }
            }
            await depositPack(sess, i => wildDragonEscapeKeep(i, escapeLawReserve));
            if (!depositOnly) {
                let remaining = Math.max(0, o.foodCount - countDragonFood(st()!));
                for (const id of DRAGON_FOOD_IDS) {
                    if (remaining <= 0) break;
                    const row = st()?.bank?.items.find(i => i.id === id && i.count > 0);
                    if (!row) continue;
                    const before = countDragonFood(st()!);
                    const take = Math.min(remaining, row.count, 28 - st()!.inventory.length);
                    if (take <= 0) break;
                    await s.bot.withdrawItem(row, take, { asNote: false });
                    await waitTicks(s, 1);
                    const gained = Math.max(0, countDragonFood(st()!) - before);
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
                if (wildernessLevel(cur.player!.worldZ) === 0 && (cur.inventory.some(i => i.id === DRAGON_BONES_ID || i.id === GREEN_DHIDE_ID) || countDragonFood(cur) < o.foodCount)) {
                    await bankAndRestock();
                }
            }
            while (!over() && trips < o.maxTrips) {
                const cur = st();
                if (!cur?.player) break;
                if (Math.max(Math.abs(cur.player.worldX - GREEN_DRAGON_SPOT.x), Math.abs(cur.player.worldZ - GREEN_DRAGON_SPOT.z)) > 25) {
                    if (!inWild()) {
                        await healBeforeWild();
                        if (countDragonFood(st()!) < o.foodCount) {
                            if (!(await bankAndRestock()) || over()) break;
                            await healBeforeWild();
                        }
                        if (hp() < Math.ceil(baseHp() * 0.75)) {
                            stop = 'low-hp-before-wild';
                            break;
                        }
                    }
                    const res = await walkSafe(GREEN_DRAGON_SPOT, 600, () => over() || danger());
                    if (over()) break;
                    if (!res.ok && !danger()) break;
                }
                const reason = wildDragonRetreatReason(st()!, o, ours);
                if (reason) {
                    if (reason === 'pker-threat') escapes++;
                    if (!(await bankAndRestock())) {
                        stop = reason;
                        break;
                    }
                    // A player who made the account leave twice still camps the route: the next walk in meets them.
                    if (escapes >= 2) {
                        stop = 'pker-threat';
                        break;
                    }
                    continue;
                }
                if (hp() <= o.eatAt) {
                    const ate = await eatBetweenCasts(s, { food: [...DRAGON_FOOD_IDS], eatAt: o.eatAt, timeoutTicks: 4, attempts: 2 });
                    if (ate) eaten++;
                }
                const state = st()!;
                const ground = state.groundItems.find(
                    g => DRAGON_LOOT_IDS.has(g.id) && Math.max(Math.abs(g.x - state.player!.worldX), Math.abs(g.z - state.player!.worldZ)) <= 8,
                );
                if (ground && state.inventory.length < 28) {
                    await s.bot.pickupItem(ground);
                    await waitTicks(s, 2);
                    continue;
                }
                const selfSlot = (s.client as { selfSlot?: number } | undefined)?.selfSlot;
                const dragon = selectGreenDragon(state.nearbyNpcs, selfSlot);
                if (!dragon) {
                    await waitTicks(s, 2);
                    continue;
                }
                const xpBefore = state.skills.filter(k => ['Attack', 'Strength', 'Defence', 'Hitpoints'].includes(k.name)).reduce((n, k) => n + k.experience, 0);
                await s.bot.attack(dragon);
                await waitUntil(
                    s,
                    () => {
                        const curState = st();
                        if (!curState || over()) return true;
                        if (wildDragonRetreatReason(curState, o, ours)) return true;
                        return !curState.nearbyNpcs.some(n => n.index === dragon.index && (n.hp ?? 1) > 0);
                    },
                    { timeoutTicks: 60 },
                );
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
            const refused = stop === 'pker-threat' || stop === 'low-hp-before-wild';
            return { ok: !died && !ended && !refused, kills, bonesBanked, hidesBanked, eaten, escapes, trips, hpMin, died, stop, ticks: s.tick() - start };
        } finally {
            off();
        }
    } finally {
        eatHold.release();
    }
}

export async function runWildDragonsCli(args: readonly string[], env: Record<string, string | undefined> = process.env) {
    const [bot, capArg] = args;
    if (!bot) {
        throw Error('usage: bun scripts/aio-boss.ts green-dragon <bot> [CAP ticks]');
    }
    let stopped = false;
    const stop = () => stopped || isStopFilePresent(bot, ['.practice/stop-wild-dragons']);
    const s = await openBot(bot, {
        onStop: async () => {
            stopped = true;
        },
    });
    try {
        const r = await runWildDragons(s, {
            cap: Number(capArg ?? 6000),
            foodCount: Number(env.FOOD_COUNT ?? 10),
            eatAt: Number(env.EAT_AT ?? 45),
            escapeAt: Number(env.ESCAPE_AT ?? 30),
            maxTrips: Number(env.MAX_TRIPS ?? 10),
            staged: env.STAGED === '1',
            stop,
        });
        console.log('WILD_DRAGONS ' + JSON.stringify(r));
        await finish([s], r.ok, `wild-dragons kills=${r.kills} bones=${r.bonesBanked} hides=${r.hidesBanked} escapes=${r.escapes} stop=${r.stop}`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

// ============================================================================
// 4. Fishing Trawler (Effects, Trip, At-Site Support)
// ============================================================================
export type TrawlerMode = 'net' | 'leak' | 'bail';

const craftingXp = (s: BotWorldState) => s.skills.find(k => k.name === 'Crafting')?.experience ?? 0;

export function insideLegacyTrawler(s: BotWorldState) {
    const p = s.player;
    return !!p && [0, 1].includes(p.level) && Math.floor(p.worldZ / 64) === 75 && [29, 31].includes(Math.floor(p.worldX / 64));
}

export function trawlerEffect(before: BotWorldState, after: BotWorldState, mode: TrawlerMode, phase: 'fill' | 'empty' = 'fill') {
    const delta = new Map<number, number>();
    for (const i of before.inventory) delta.set(i.id, (delta.get(i.id) ?? 0) - i.count);
    for (const i of after.inventory) delta.set(i.id, (delta.get(i.id) ?? 0) + i.count);
    const expected =
        mode === 'net'
            ? new Map([[954, -1]])
            : mode === 'leak'
                ? new Map([[1941, -1]])
                : phase === 'fill'
                    ? new Map([[583, -1], [585, 1]])
                    : new Map([[585, -1], [583, 1]]);
    const keys = new Set([...delta.keys(), ...expected.keys()]);
    const noChange = [...delta.values()].every(n => n === 0) && craftingXp(after) === craftingXp(before);
    if (noChange) return false;
    if (![...keys].every(id => (delta.get(id) ?? 0) === (expected.get(id) ?? 0)) || (mode === 'net' && craftingXp(after) <= craftingXp(before)) || (mode !== 'net' && craftingXp(after) !== craftingXp(before))) {
        throw Error('trawler asset or XP effect does not reconcile');
    }
    return true;
}

export function trawlerInterruption(before: BotWorldState, after: BotWorldState) {
    if (after.dialog?.isOpen && (after.dialog.text === 'The net has ripped!' || after.dialog.allComponents?.some(c => c.text === 'The net has ripped!'))) {
        return 'net-rip' as const;
    }
    if (insideLegacyTrawler(before) && insideLegacyTrawler(after) && Math.floor(before.player!.worldX / 64) !== Math.floor(after.player!.worldX / 64)) {
        return 'flood-form' as const;
    }
    return null;
}

export function trawlerNetWindow(ripped: boolean, water: number, activeLeaks: number) {
    return ripped && Number.isInteger(water) && water >= 0 && water <= 10 && activeLeaks === 0;
}

export function trawlerCatchRows(component: { linkObjType: ArrayLike<number> | null; linkObjNumber: ArrayLike<number> | null } | undefined) {
    if (!component?.linkObjType || !component.linkObjNumber) throw Error('owned trawler reward inventory unavailable');
    const types = component.linkObjType;
    const nums = component.linkObjNumber;
    const out: { id: number; slot: number; count: number }[] = [];
    for (let slot = 0; slot < types.length; slot++) {
        const id = types[slot]! - 1;
        const count = nums[slot] ?? 0;
        if (id >= 0 && count > 0) out.push({ id, slot, count });
    }
    return out;
}

export function trawlerAssetsReconcile(
    initial: ReadonlyMap<number, number>,
    banked: Readonly<Record<number, number>>,
    rewards: Readonly<Record<number, number>>,
    paste: number,
    ropes: number,
) {
    const checkId = (id: number) =>
        (banked[id] ?? 0) === (initial.get(id) ?? 0) + (rewards[id] ?? 0) - (id === 1941 ? paste : 0) - (id === 954 ? ropes : 0);
    for (const id of initial.keys()) {
        if (!checkId(id)) return false;
    }
    for (const k in banked) {
        const id = Number(k);
        if (!initial.has(id) && !checkId(id)) return false;
    }
    for (const k in rewards) {
        const id = Number(k);
        if (!initial.has(id) && !(k in banked) && !checkId(id)) return false;
    }
    return true;
}

export interface TrawlerDriver {
    state: () => BotWorldState | null;
    tick: () => number;
    stop: () => boolean;
    object: (x: number, z: number, id: number, op: number) => Promise<boolean>;
    item: (slot: number, op: number) => Promise<boolean>;
    wait: (test: () => boolean, ticks: number) => Promise<boolean>;
    step: () => Promise<void>;
}

const trawlerCount = (s: BotWorldState, id: number) => s.inventory.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const trawlerHp = (s: BotWorldState) => s.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;

export async function runTrawlerSupport(d: TrawlerDriver, o: { mode: TrawlerMode; maximum: number; cap: number; maxAttempts: number }) {
    if (!['net', 'leak', 'bail'].includes(o.mode) || ![o.maximum, o.cap, o.maxAttempts].every(n => Number.isSafeInteger(n) && n > 0)) {
        throw Error('invalid trawler job');
    }
    const initial = d.state();
    if (!initial?.player || !insideLegacyTrawler(initial) || trawlerHp(initial) < 1) throw Error('stage inside native Trawler boat');
    const start = d.tick();
    let completed = 0;
    let attempts = 0;
    const state = () => {
        const s = d.state();
        if (!s?.player) throw Error('trawler session ended');
        if (d.stop()) throw Error('trawler stopped');
        if (d.tick() - start >= o.cap) throw Error('trawler cap');
        if (!insideLegacyTrawler(s)) throw Error('trawler trip ended before support target');
        if (s.player.lifeId !== initial.player!.lifeId || trawlerHp(s) !== trawlerHp(initial) || s.player.isDead) throw Error('trawler health changed');
        return s;
    };
    const useBucket = async (phase: 'fill' | 'empty') => {
        const before = state();
        const id = phase === 'fill' ? 583 : 585;
        const item = before.inventory.find(i => i.id === id);
        const op = item?.optionsWithIndex.find(v => (phase === 'fill' ? /^bail-with$/i.test(v.text) : /^empty$/i.test(v.text)));
        if (!item || !op) throw Error('native bailing bucket/action unavailable');
        if (!(await d.item(item.slot, op.opIndex))) throw Error('trawler bailing refused');
        if (!(await d.wait(() => trawlerEffect(before, state(), 'bail', phase), Math.min(8, o.cap - (d.tick() - start))))) {
            throw Error('trawler bucket effect unobserved');
        }
    };
    while (completed < o.maximum) {
        const before = state();
        if (attempts >= o.maxAttempts) throw Error('trawler attempt limit');
        if (o.mode === 'bail') {
            if (before.player!.level !== 0 || Math.floor(before.player!.worldX / 64) !== 31) throw Error('bail only in flooded hold');
            if (trawlerCount(before, 585) !== 0) throw Error('start bail cycle with empty bucket');
            attempts++;
            await useBucket('fill');
            await useBucket('empty');
            completed++;
        } else {
            const need = o.mode === 'net' ? 954 : 1941;
            if (trawlerCount(before, need) < 1) throw Error('trawler repair supply exhausted');
            const locs = before.nearbyLocs;
            let target: (typeof locs)[number] | undefined;
            for (let i = 0; i < locs.length; i++) {
                const l = locs[i]!;
                if (
                    (o.mode === 'net' ? l.id === 2172 || l.id === 2173 : l.id === 2167)
                    && l.distance <= 2
                    && l.level === before.player!.level
                    && l.reachable !== false
                    && (!target || l.distance < target.distance)
                ) {
                    target = l;
                }
            }
            const option = target?.optionsWithIndex.find(v => (o.mode === 'net' ? INSPECT_OP_RE.test(v.text) : FILL_OP_RE.test(v.text)));
            if (!target || !option) {
                await d.step();
                continue;
            }
            attempts++;
            const seen = new Set(before.gameMessages.map(m => m.observationId ?? `${m.tick}:${m.text}`));
            if (!(await d.object(target.x, target.z, target.id, option.opIndex))) throw Error('trawler repair refused');
            let made = false;
            let miss = false;
            await d.wait(() => {
                const current = state();
                made = trawlerEffect(before, current, o.mode);
                miss =
                    o.mode === 'net'
                    && current.gameMessages.some(
                        m => m.type === 0 && !seen.has(m.observationId ?? `${m.tick}:${m.text}`) && /^You fail to repair the net in the harsh conditions\.$/.test(m.text),
                    );
                return made || miss;
            }, Math.min(10, o.cap - (d.tick() - start)));
            if (made) completed++;
            else if (!miss) throw Error('trawler repair effect unobserved');
        }
        if (completed < o.maximum) await d.step();
    }
    return { mode: o.mode, completed, attempts, ticks: d.tick() - start };
}

export async function runTrawlerTrip(s: CombatSession, o: { cap: number; stop?: () => boolean; collectOnly?: boolean }) {
    if (!Number.isSafeInteger(o.cap) || o.cap < (o.collectOnly ? 100 : 1200) || o.cap > 10000) throw Error('invalid trawler trip cap');
    const sess = s as Session;
    const eatHold = holdSessionEater(s.sdk);
    try {
        const st = () => s.sdk.getState()!;
        const inv = () => s.sdk.getInventory();
        const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        const initialStock = new Map<number, number>();
        for (const i of inv()) initialStock.set(i.id, (initialStock.get(i.id) ?? 0) + i.count);
        const paste0 = held(1941);
        const rope0 = held(954);
        const first = st();
        const p0 = first.player;
        if (
            !p0
            || p0.level !== 0
            || Math.max(Math.abs(p0.worldX - 2675), Math.abs(p0.worldZ - 3170)) > 20
            || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < 3
            || (s.sdk.getSkill('Fishing')?.level ?? 0) < 15
            || (!o.collectOnly && (held(1941) < 100 || held(954) < 10 || held(583) !== 1))
        ) {
            throw Error('stage trawler at Port Khazard with Fishing15, 100 paste, 10 ropes and bailing bucket');
        }
        const initialMessages = new Set(first.gameMessages.map(m => m.observationId ?? `${m.tick}:${m.text}`));
        const won = () => st().gameMessages.some(m => !initialMessages.has(m.observationId ?? `${m.tick}:${m.text}`) && /Murphy turns the boat towards shore\./.test(m.text));
        let ended = false;
        let securing = false;
        let secureStart = 0;
        void s.ended.then(() => {
            ended = true;
        });
        const start = s.tick();
        const hp = s.sdk.getSkill('Hitpoints')?.level;
        let leaks = 0;
        let nets = 0;
        let bails = 0;
        const check = () => {
            if (ended || (!securing && o.stop?.()) || (securing ? s.tick() - secureStart >= 500 : s.tick() - start >= o.cap)) {
                throw Error('trawler stopped/cap/session');
            }
            const p = st().player;
            if (!p || p.isDead || p.lifeId !== p0.lifeId || s.sdk.getSkill('Hitpoints')?.level !== hp) throw Error('trawler health changed');
        };
        const step = async () => {
            check();
            await waitTicks(s, 1);
            check();
        };
        const wait = async (test: () => boolean, n: number) =>
            waitUntil(
                s,
                () => {
                    check();
                    return test();
                },
                { timeoutTicks: Math.min(n, Math.max(1, securing ? 500 - (s.tick() - secureStart) : o.cap - (s.tick() - start))) },
            );
        const walk = async (x: number, z: number) => {
            check();
            const r = await walkPath(await sessionWalker(sess), [{ x, z, tol: 1 }], { maxTicks: 180, stop: () => ended || (!securing && !!o.stop?.()) });
            if (!r.ok) throw Error('trawler walking ' + JSON.stringify(r));
            check();
        };
        const loc = async (id: number, west = false) => {
            check();
            await s.bot.dismissBlockingUI();
            const locs = st().nearbyLocs;
            let found: (typeof locs)[number] | undefined;
            const curLevel = st().player!.level;
            for (let i = 0; i < locs.length; i++) {
                const l = locs[i]!;
                if (l.id === id && l.level === curLevel) {
                    if (!found || (west ? l.x < found.x : l.distance < found.distance)) found = l;
                }
            }
            const l = found ?? (id === 2178 ? { x: 2674, z: 3170, id } : id === 2166 ? { x: 2666, z: 3167, id } : undefined);
            if (!l) throw Error('trawler object absent ' + id);
            if (!(await s.sdk.sendInteractLoc(l.x, l.z, l.id, 1)).success) throw Error('trawler object refused ' + id);
            return l;
        };
        const ladder = async (level: number) => {
            const before = st();
            await loc(level === 1 ? 2174 : 2175, level === 1);
            if (!(await wait(() => st().player?.level === level || won() || !!trawlerInterruption(before, st()), 15))) throw Error('trawler ladder timeout');
            if (trawlerInterruption(before, st()) && !won()) {
                await s.bot.dismissBlockingUI();
                await waitTicks(s, 3);
                check();
            }
        };
        const effectWait = async (before: ReturnType<typeof st>, mode: 'net' | 'leak' | 'bail', phase: 'fill' | 'empty', ticks: number) => {
            let effect = false;
            await wait(() => {
                effect = trawlerEffect(before, st(), mode, phase);
                return effect || won() || !!trawlerInterruption(before, st());
            }, ticks);
            const interrupted = !!trawlerInterruption(before, st());
            if (interrupted && !won()) {
                await s.bot.dismissBlockingUI();
                await waitTicks(s, 3);
                check();
                effect = trawlerEffect(before, st(), mode, phase);
            }
            return { effect, interrupted };
        };
        await walk(2613, 3094);
        await s.bot.dismissBlockingUI();
        const initialGeneration = s.bankObservation?.()?.generation ?? -1;
        if (!(await s.bot.openBank()).success || !(await wait(() => !!st().bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > initialGeneration, 15))) {
            throw Error('trawler initial bank unavailable');
        }
        for (const i of s.bankObservation!()!.items) initialStock.set(i.id, (initialStock.get(i.id) ?? 0) + i.count);
        await s.bot.closeBank();
        if (!o.collectOnly) {
            await walk(2675, 3170);
            console.log('TRAWLER_PHASE boarding');
            await loc(2178);
            if (!(await wait(() => insideLegacyTrawler(st()), 160))) throw Error('trawler boarding timeout');
            console.log('TRAWLER_PHASE sea');
            await waitTicks(s, 25);
            let ripped = false;
            let lastMessage = 0;
            let lastReport = 0;
            const overlay = s.client as { var: Int32Array; ifType: (id: number) => { text: string | null } };
            while (insideLegacyTrawler(st())) {
                if (won()) break;
                check();
                ripped = overlay.ifType(11936)?.text === 'Ripped!' || ripped;
                const water = overlay.var[391];
                if (!Number.isInteger(water) || water < 0 || water > 100) throw Error('native trawler water unknown');
                if (s.tick() - lastReport >= 100) {
                    console.log('TRAWLER_CONTROL ' + JSON.stringify({ tick: s.tick(), position: st().player, water, ripped, leaks, nets, bails }));
                    lastReport = s.tick();
                }
                for (const m of st().gameMessages) {
                    if ((m.observationId ?? m.tick) > lastMessage && /The net has ripped!/.test(m.text)) ripped = true;
                    lastMessage = Math.max(lastMessage, m.observationId ?? m.tick);
                }
                await s.bot.dismissBlockingUI();
                const state = st();
                const p = state.player!;
                const flooded = Math.floor(p.worldX / 64) === 31;
                if (held(585)) {
                    const before = st();
                    const bucket = inv().find(i => i.id === 585)!;
                    if (!(await s.sdk.sendUseItem(bucket.slot, 1)).success) throw Error('trawler empty bucket refused');
                    const result = await effectWait(before, 'bail', 'empty', 8);
                    if (won()) break;
                    if (!result.effect && !result.interrupted) throw Error('trawler empty bucket unobserved');
                    continue;
                }
                if (p.level === 1) {
                    const target = state.nearbyLocs.find(l => [2172, 2173].includes(l.id));
                    if (target) {
                        if (held(954) < 1) throw Error('trawler rope exhausted');
                        const before = st();
                        await loc(target.id);
                        let effect = false;
                        await wait(() => {
                            effect = trawlerEffect(before, st(), 'net');
                            return won() || effect || st().gameMessages.some(m => m.tick > before.tick && /fail to repair the net/.test(m.text));
                        }, 10);
                        if (won()) break;
                        if (effect) {
                            nets++;
                            ripped = false;
                        }
                    } else {
                        ripped = false;
                    }
                    await ladder(0);
                } else {
                    let leak: (typeof state.nearbyLocs)[number] | undefined;
                    let activeLeaks = 0;
                    const locs = state.nearbyLocs;
                    for (let i = 0; i < locs.length; i++) {
                        const l = locs[i]!;
                        if (l.id === 2167) {
                            activeLeaks++;
                            if (!leak || l.distance < leak.distance) leak = l;
                        }
                    }
                    if (trawlerNetWindow(ripped, water, activeLeaks)) {
                        console.log('TRAWLER_NET_WINDOW ' + JSON.stringify({ tick: s.tick(), water, activeLeaks: 0 }));
                        await ladder(1);
                    } else if (leak) {
                        if (held(1941) < 1) throw Error('trawler paste exhausted');
                        const before = st();
                        await loc(2167);
                        const result = await effectWait(before, 'leak', 'fill', 12);
                        if (result.effect) leaks++;
                        if (won()) break;
                        if (!result.effect && !result.interrupted) throw Error('trawler leak effect absent');
                    } else if (flooded) {
                        const before = st();
                        const bucket = inv().find(i => i.id === 583);
                        if (!bucket) throw Error('bailing bucket absent');
                        if (!(await s.sdk.sendUseItem(bucket.slot, 1)).success) throw Error('trawler bailing refused');
                        const result = await effectWait(before, 'bail', 'fill', 8);
                        if (result.effect) bails++;
                        if (won()) break;
                        if (!result.effect && !result.interrupted) throw Error('trawler bailing failed');
                    } else {
                        await step();
                    }
                }
            }
            if (!(await wait(() => st().player?.level === 0 && Math.floor(st().player!.worldZ / 64) === 49, 40)) || !won()) {
                throw Error('trawler win unobserved');
            }
        }
        if (held(585)) {
            const before = st();
            const bucket = inv().find(i => i.id === 585)!;
            if (!(await s.sdk.sendUseItem(bucket.slot, 1)).success || !(await wait(() => trawlerEffect(before, st(), 'bail', 'empty'), 8))) {
                throw Error('trawler return bucket empty failed');
            }
        }
        leaks = paste0 - held(1941);
        nets = rope0 - held(954);
        let finalBank: { id: number; count: number }[] = [];
        const bank = async () => {
            await walk(2613, 3094);
            await s.bot.dismissBlockingUI();
            const gen = s.bankObservation?.()?.generation ?? -1;
            if (!(await s.bot.openBank()).success || !(await wait(() => !!st().bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > gen, 15))) {
                throw Error('trawler bank unavailable');
            }
            for (const id of new Set(inv().map(i => i.id))) {
                const item = inv().find(i => i.id === id);
                if (item) await depositObserved(sess, item);
            }
            finalBank = s.bankObservation!()!.items.map(i => ({ ...i }));
            await s.bot.closeBank();
        };
        await bank();
        await walk(2667, 3167);
        check();
        const catchApproach = { x: st().player!.worldX, z: st().player!.worldZ };
        const relayTile = { x: catchApproach.x - 1, z: catchApproach.z };
        for (const at of [relayTile, catchApproach]) {
            const preflight = await walkPath(await sessionWalker(sess), [{ ...at, tol: 0 }], { maxTicks: 10, stop: () => ended || !!o.stop?.() });
            if (!preflight.ok || st().player!.worldX !== at.x || st().player!.worldZ !== at.z) throw Error('trawler relay preflight ' + JSON.stringify({ at, preflight }));
        }
        securing = true;
        secureStart = s.tick();
        await loc(2166);
        if (!(await wait(() => st().modalInterface === 4564, 15))) throw Error('owned trawler catch absent');
        const client = s.client as { ifType: (id: number) => { linkObjType: Int32Array | null; linkObjNumber: Int32Array | null } };
        const rewards = trawlerCatchRows(client.ifType(4640));
        if (!rewards.length) throw Error('trawler reward empty');
        const total = (rows: readonly { id: number; count: number }[]) => {
            const n: Record<number, number> = {};
            for (const i of rows) n[i.id] = (n[i.id] ?? 0) + i.count;
            return n;
        };
        const expected = total(rewards);
        const catchAt = { x: st().player!.worldX, z: st().player!.worldZ };
        console.log('TRAWLER_CATCH ' + JSON.stringify({ component: 4640, modal: st().modalInterface, rewards, at: catchAt, peers: st().nearbyPlayers, baseline: st().groundItems.filter(i => i.x === catchAt.x && i.z === catchAt.z) }));
        const overflow = rewards.reduce((n, i) => n + i.count, 0) > 28;
        if (overflow && (st().nearbyPlayers.length || st().groundItems.some(i => i.x === catchAt.x && i.z === catchAt.z && expected[i.id]))) {
            throw Error('trawler overflow ownership baseline ambiguous');
        }
        for (const r of rewards) {
            let left = r.count;
            while (left && inv().length < 28) {
                const free = 28 - inv().length;
                const n = left <= free ? left : 1;
                const before = held(r.id);
                if (!(await s.sdk.sendClickComponentWithOption(4640, n === left ? 2 : 1, r.slot)).success || !(await wait(() => held(r.id) === before + n, 8))) {
                    throw Error('trawler catch withdrawal mismatch');
                }
                left -= n;
            }
            if (left) break;
        }
        const remaining = trawlerCatchRows(client.ifType(4640));
        let overflowTicks = 0;
        const overflowReceipts: unknown[] = [];
        if (remaining.length) {
            const urgent = total(remaining);
            const urgentTick = s.tick();
            console.log('TRAWLER_URGENT_ESCROW ' + JSON.stringify({ at: catchAt, escrow: urgent, tick: urgentTick, lifetime: 100 }));
            await s.bot.dismissBlockingUI();
            const pile = (at: { x: number; z: number }, id: number) => st().groundItems.filter(i => i.id === id && i.x === at.x && i.z === at.z).reduce((n, i) => n + i.count, 0);
            if (!(await wait(() => Object.entries(urgent).every(([id, n]) => pile(catchAt, Number(id)) === n), 5))) throw Error('trawler catch dump escrow absent');
            const relay = relayTile;
            const exact = async (at: { x: number; z: number }) => {
                const r = await walkPath(await sessionWalker(sess), [{ ...at, tol: 0 }], { maxTicks: 10, stop: () => ended || (!securing && !!o.stop?.()) });
                if (!r.ok || st().player!.worldX !== at.x || st().player!.worldZ !== at.z) throw Error('trawler relay tile unavailable ' + JSON.stringify({ at, r, player: st().player }));
            };
            await exact(relay);
            if (st().nearbyPlayers.length || st().groundItems.some(i => i.x === relay.x && i.z === relay.z && expected[i.id])) {
                throw Error('trawler relay baseline ambiguous');
            }
            const relayEscrow: Record<number, number> = {};
            const relayTick = s.tick();
            const need = remaining.reduce((n, i) => n + i.count, 0);
            while (28 - inv().length < need) {
                check();
                if (st().nearbyPlayers.length) throw Error('trawler relay peers');
                const item = inv()[0];
                if (!item || !expected[item.id]) throw Error('trawler relay requires owned catch');
                const before = total(inv());
                const groundBefore = pile(relay, item.id);
                if (
                    !(await s.sdk.sendDropItem(item.slot)).success
                    || !(await wait(() => held(item.id) === (before[item.id] ?? 0) - item.count && pile(relay, item.id) === groundBefore + item.count, 8))
                ) {
                    throw Error('trawler owned relay drop unobserved');
                }
                const after = total(inv());
                for (const id of new Set([...Object.keys(before), ...Object.keys(after)].map(Number))) {
                    if ((after[id] ?? 0) - (before[id] ?? 0) !== (id === item.id ? -item.count : 0)) throw Error('trawler relay drop debit mismatch');
                }
                relayEscrow[item.id] = (relayEscrow[item.id] ?? 0) + item.count;
                console.log(
                    'TRAWLER_RELAY_DROP '
                        + JSON.stringify({
                            at: relay,
                            id: item.id,
                            units: item.count,
                            packBefore: before[item.id],
                            packAfter: after[item.id] ?? 0,
                            pileBefore: groundBefore,
                            pileAfter: pile(relay, item.id),
                            tick: s.tick(),
                            privateTicks: 100,
                            lifetime: 300,
                            peers: st().nearbyPlayers,
                        }),
                );
            }
            const recover = async (at: { x: number; z: number }, escrow: Record<number, number>, began: number, lifetime: number) => {
                check();
                if (st().nearbyPlayers.length || s.tick() - began >= lifetime - 5 || !Object.entries(escrow).every(([id, n]) => pile(at, Number(id)) === n)) {
                    throw Error('trawler escrow peers, expiry or quantity');
                }
                const owned = () => {
                    check();
                    if (st().nearbyPlayers.length || s.tick() - began >= lifetime - 5) throw Error('trawler escrow peers or expiry');
                    return { ...st(), groundItems: st().groundItems.filter(i => i.x === at.x && i.z === at.z && escrow[i.id]) };
                };
                const definition = (s.client as { objType: (id: number) => { cost: number; stackable: boolean } }).objType.bind(s.client);
                const { runVisibleGroundLoot } = loadSurvMod();
                const result = await runVisibleGroundLoot(
                    { state: owned, tick: () => s.tick(), stop: () => !securing && !!o.stop?.(), definition, pickup: async i => (await s.sdk.sendPickup(i.x, i.z, i.id)).success, wait, step },
                    {
                        mode: 'list',
                        ids: Object.keys(escrow).map(Number),
                        names: [],
                        minimumValue: 0,
                        maximumValue: 2147483647,
                        radius: 2,
                        maximumUnits: Object.values(escrow).reduce((n, i) => n + i, 0),
                        cap: Math.max(1, lifetime - 5 - (s.tick() - began)),
                        idleTicks: 5,
                    },
                );
                if (JSON.stringify(Object.entries(result.acquired).sort()) !== JSON.stringify(Object.entries(escrow).sort())) {
                    throw Error('trawler escrow inventory mismatch');
                }
                console.log(
                    'TRAWLER_ESCROW_RECOVERED '
                        + JSON.stringify({ at, escrow, elapsed: s.tick() - began, lifetime, inventoryReceipt: result.acquired, peers: st().nearbyPlayers }),
                );
                overflowReceipts.push({ at, escrow, elapsed: s.tick() - began, lifetime, privateTicks: 100, publicAfter: 100, inventoryReceipt: result.acquired });
            };
            await exact(catchAt);
            await recover(catchAt, urgent, urgentTick, 100);
            if (trawlerCatchRows(client.ifType(4640)).length) throw Error('trawler GUI escrow remains');
            await bank();
            await walk(relay.x, relay.z);
            await recover(relay, relayEscrow, relayTick, 300);
            overflowTicks = s.tick() - relayTick;
        }
        await bank();
        const banked = total(finalBank);
        if (!trawlerAssetsReconcile(initialStock, banked, expected, leaks, nets)) throw Error('trawler final asset reconciliation');
        return { ok: !o.stop?.(), stopped: !!o.stop?.(), wholeTrip: !o.collectOnly, leaks, nets, bails, rewards, overflowTicks, overflowReceipts, conserved: true, ticks: s.tick() - start };
    } finally {
        eatHold.release();
    }
}

export async function runTrawlerTripCli(args: readonly string[]) {
    let s: CombatSession | undefined;
    try {
        const name = args[0];
        const cap = args.slice(1).find(a => !a.startsWith('--'));
        if (!name) throw Error('account required');
        s = await openBot(name);
        const result = await runTrawlerTrip(s, {
            cap: Number(cap ?? 2200),
            collectOnly: args.includes('--collect-only'),
            stop: () => existsSync('.practice/stop-all') || existsSync(`.practice/stop-${name}`),
        });
        console.log('TRAWLER_TRIP ' + JSON.stringify(result));
        await finish([s], result.ok, JSON.stringify(result));
    } catch (e) {
        if (s) {
            const state = s.sdk.getState();
            console.log(
                'TRAWLER_ERROR_STATE '
                    + JSON.stringify({
                        player: state?.player,
                        locs: state?.nearbyLocs,
                        ground: state?.groundItems,
                        inventory: state?.inventory,
                        messages: state?.gameMessages,
                        modal: state?.modalInterface,
                    }),
            );
        }
        await finish(s ? [s] : [], false, String(e));
    }
}

export async function runTrawlerSupportCli(args: readonly string[], env: Record<string, string | undefined> = process.env) {
    if (args[1] === 'trip') {
        await runTrawlerTripCli([args[0]!, ...args.slice(2)]);
        return;
    }
    const name = args[0];
    const mode = args[1] as TrawlerMode;
    const maximum = Number(args[2] ?? 1);
    const cap = Number(args[3] ?? 200);
    if (!name) throw Error('account required');
    const s = await openBot(name).catch(e => finish([], false, `login: ${String(e)}`));
    const eatHold = holdSessionEater(s.sdk);
    let ended = false;
    void s.ended.then(() => {
        ended = true;
    });
    try {
        const result = await runTrawlerSupport(
            {
                state: () => s.sdk.getState(),
                tick: () => s.tick(),
                stop: () => ended || existsSync(`.practice/stop-${name}`) || existsSync('.practice/stop-all'),
                object: async (x, z, id, op) => (await s.sdk.sendInteractLoc(x, z, id, op)).success,
                item: async (slot, op) => (await s.sdk.sendUseItem(slot, op)).success,
                wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
                step: () => waitTicks(s, 1),
            },
            { mode, maximum, cap, maxAttempts: Number(env.MAX_ATTEMPTS ?? 100) },
        );
        await finish([s], true, JSON.stringify(result));
    } catch (e) {
        await finish([s], false, String(e));
    } finally {
        eatHold.release();
    }
}

export type BossTile = CombatTile;
