// Consolidated thieving module: native pickpockets, bank-staged pickpocket trips, stalls + sight check,
// Ardougne nature chest, Chaos Druid Tower blood chest, and Knights of Ardougne goldfarms.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { accountOf, finish, getWorld, openBot, randomEventsOf, serverFromEnv, sessionDied, settle } from '../../../core/src/bot';
import { validateBankRouteJob, type BankProfile, type BankRouteJob } from '../../../core/src/bank-trip';
import { equipmentObserved } from '../../../core/src/container-observation';
import { depositObserved, depositPack } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { questFlags } from '../../../core/src/quest-status';
import { resolveBotEnvPath } from '../../../core/src/practice-paths';
import { objIdByDebugName, questFoodDefinitions } from '../../../core/src/sustain';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { ownedAccounts } from '../../../core/src/tradeguard';
import { type PathDeps, goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import { parseConfigs } from '../../../knowledge/src/config';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import type { BotWorldState } from '../../../../vendor/rs-sdk/sdk/types';
import { defaultWalkTargetPersist, productionStopRequested, watchProductionLife } from './runtime';
import { type GatherExternalDeps, type GatherOutcome, type NormalizedGatherConfig, resolveSetting } from './types';

const ROOT = resolve(import.meta.dir, '../../../..');
const CONTENT = resolve(ROOT, 'vendor/rs-sdk/server/content');

// ---------------------------------------------------------------------------
// 1. Native At-Site Pickpocketing (`thieving:pickpocket-at-site`)
// ---------------------------------------------------------------------------
export interface PocketProfile {
    name: string;
    npcs: number[];
    level: number;
    xp: number;
    stunTicks: number;
    damage: number;
    pocket: string;
    loot: { id: number; min: number; max: number }[];
    source: string;
    line: number;
}

export function pickpocketProfiles(): PocketProfile[] {
    const path = resolve(CONTENT, 'scripts/skill_thieving/configs/pickpocking/pickpocket.dbrow');
    const text = readFileSync(path, 'utf8');
    const ids = new Map(
        readFileSync(resolve(CONTENT, 'pack/npc.pack'), 'utf8')
            .split(/\r?\n/)
            .flatMap(l => {
                const m = l.match(/^(\d+)=(\w+)$/);
                return m ? ([[m[2]!, Number(m[1])] as const]) : [];
            }),
    );
    const triggers = readFileSync(resolve(CONTENT, 'scripts/skill_thieving/scripts/pickpocketing/pickpocket.rs2'), 'utf8');
    return [...text.matchAll(/^\[pickpocket_([^\]]+)\]\r?\n([^\[]*)/gm)].map(m => {
        const body = m[2]!;
        const field = (key: string) => body.match(new RegExp('^data=' + key + ',(.+)$', 'm'))?.[1]?.trim();
        const npcs = [...body.matchAll(/^data=npc,(\w+)/gm)].map(n => {
            if (!triggers.includes('[opnpc3,' + n[1] + ']')) throw Error('native pickpocket trigger missing ' + n[1]);
            const id = ids.get(n[1]!);
            if (id === undefined) throw Error('native NPC ID missing');
            return id;
        });
        const loot = [...body.matchAll(/^data=loot,(\w+),(\d+),(\d+),(\d+)/gm)].map(n => {
            const id = objIdByDebugName(n[1]!);
            if (id === undefined) throw Error('native loot item missing ' + n[1]);
            return { id, min: Number(n[2]), max: Number(n[3]) };
        });
        return {
            name: m[1]!,
            npcs,
            level: Number(field('level')),
            xp: Number(field('experience')) / 10,
            stunTicks: Number(field('stun_ticks')),
            damage: Number(field('stun_damage')),
            pocket: field('pocket')!,
            loot,
            source: path,
            line: text.slice(0, m.index).split('\n').length,
        };
    });
}

export interface PocketSnapshot {
    items: Record<number, number>;
    xp: number;
    hp: number;
}

export function pocketEffect(
    p: PocketProfile,
    b: PocketSnapshot,
    a: PocketSnapshot,
    event: 'success' | 'failure' | 'none',
    rate: number,
) {
    const ids = new Set([...Object.keys(b.items), ...Object.keys(a.items)].map(Number));
    const unchanged = [...ids].every(id => (b.items[id] ?? 0) === (a.items[id] ?? 0));
    if (event === 'failure') return unchanged && a.xp === b.xp && a.hp === b.hp - p.damage ? 'failure' : 'invalid';
    if (event === 'success') {
        if (a.hp !== b.hp || Math.round((a.xp - b.xp) * 10) !== Math.round(p.xp * rate * 10)) return 'invalid';
        return [...ids].every(id => {
            const n = (a.items[id] ?? 0) - (b.items[id] ?? 0);
            const loot = p.loot.find(i => i.id === id);
            return loot ? n === 0 || (Number.isSafeInteger(n) && n >= loot.min && n <= loot.max) : n === 0;
        })
            ? 'success'
            : 'invalid';
    }
    return unchanged && a.xp === b.xp && a.hp === b.hp ? 'none' : 'invalid';
}

export interface PocketOptions {
    successes: number;
    attempts: number;
    cap: number;
    maxNoProgress: number;
    hpFloor: number;
    eatAt: number;
    food: number;
    foodReserve: number;
    xpRate: number;
    members: boolean;
    stop?: () => boolean;
}

export function validatePocketOptions(o: PocketOptions) {
    if (
        ![o.successes, o.attempts, o.cap, o.maxNoProgress, o.hpFloor, o.eatAt, o.food, o.foodReserve].every(Number.isSafeInteger) ||
        o.successes < 1 ||
        o.successes > 1000 ||
        o.attempts < o.successes ||
        o.attempts > 10000 ||
        o.cap < 1 ||
        o.cap > 100000 ||
        o.maxNoProgress < 1 ||
        o.maxNoProgress > 100 ||
        o.hpFloor < 1 ||
        o.eatAt < o.hpFloor ||
        o.food < 0 ||
        o.foodReserve < 0 ||
        !Number.isFinite(o.xpRate) ||
        o.xpRate <= 0 ||
        o.xpRate > 1000
    ) {
        throw Error('invalid finite pickpocket limits');
    }
    if (!o.members) throw Error('native pickpocketing requires member scope');
    if (o.food) {
        const f = questFoodDefinitions().get(o.food);
        if (!f || f.next !== undefined) throw Error('stage a native whole food with no returned item');
    }
    return o;
}

export async function runPickpockets(s: Session, p: PocketProfile, o: PocketOptions) {
    validatePocketOptions(o);
    const st = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const read = (): PocketSnapshot => {
        const items: Record<number, number> = {};
        for (const i of inv()) items[i.id] = (items[i.id] ?? 0) + i.count;
        return { items, xp: s.sdk.getSkillXp('Thieving') ?? 0, hp: hp() };
    };
    const p0 = st()?.player;
    if (!p0 || hp() <= o.hpFloor + p.damage || (s.sdk.getSkill('Thieving')?.level ?? 0) < p.level) {
        throw Error('pickpocket entry state/level/health missing');
    }
    if (p.name === 'viking' && !questFlags(s.client)?.some(q => /fremennik/i.test(q.name) && q.state === 'complete')) {
        throw Error('Fremennik Trials completion unobserved');
    }
    const start = s.tick();
    const initial = read();
    let ended = false;
    let successes = 0;
    let failures = 0;
    let attempts = 0;
    let eaten = 0;
    let noProgress = 0;
    let stop = 'target';
    let failure = '';
    void s.ended.then(() => {
        ended = true;
    });
    const dead = () => {
        const q = st()?.player;
        return !q || q.isDead || q.lifeId !== p0.lifeId || (q.respawnCount ?? 0) > (p0.respawnCount ?? 0) || hp() <= 0;
    };
    const over = () =>
        ended || dead() || !!o.stop?.() || (!!process.env.STOP_FILE && existsSync(process.env.STOP_FILE)) || s.tick() - start >= o.cap;
    const wait = async (predicate: () => boolean, n: number) =>
        (await waitUntil(s, () => over() || predicate(), { timeoutTicks: Math.min(n, Math.max(1, o.cap - (s.tick() - start))) })) &&
        !over() &&
        predicate();
    const rest = async (n: number) => {
        for (let i = 0; i < n && !over(); i++) await waitTicks(s, 1);
    };
    const cursor = () => Math.max(-1, ...(st()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
    try {
        while (successes < o.successes && attempts < o.attempts && !over()) {
            const q = st()?.player;
            if (!q || q.level !== p0.level || Math.max(Math.abs(q.worldX - p0.worldX), Math.abs(q.worldZ - p0.worldZ)) > 8 || q.combat?.inCombat) {
                throw Error('pickpocket site/combat changed');
            }
            if (hp() <= o.eatAt && o.food && (read().items[o.food] ?? 0) > o.foodReserve) {
                await s.bot.dismissBlockingUI();
                if (over()) break;
                const item = inv().find(i => i.id === o.food);
                const b = read();
                const option = item?.optionsWithIndex.find(v => /^(eat|drink)$/i.test(v.text));
                if (!item || !option) throw Error('whole food Eat option absent');
                if (
                    !(await s.sdk.sendUseItem(item.slot, option.opIndex)).success ||
                    !(await wait(() => hp() > b.hp && (read().items[o.food] ?? 0) === (b.items[o.food] ?? 0) - 1, 8))
                ) {
                    throw Error('food debit/heal missing');
                }
                const a = read();
                const keys = new Set([...Object.keys(b.items), ...Object.keys(a.items)].map(Number));
                if ([...keys].some(id => (a.items[id] ?? 0) - (b.items[id] ?? 0) !== (id === o.food ? -1 : 0)) || a.xp !== b.xp) {
                    throw Error('food changed unrelated assets');
                }
                eaten++;
                await rest(3);
                continue;
            }
            if (hp() <= o.hpFloor + p.damage) {
                stop = 'health/food';
                break;
            }
            if (inv().length > 28 - p.loot.length) {
                stop = 'inventory space';
                break;
            }
            await s.bot.dismissBlockingUI();
            if (over()) break;
            const npc = st()
                ?.nearbyNpcs.filter(
                    n =>
                        p.npcs.includes(n.id) &&
                        n.reachable !== false &&
                        !n.inCombat &&
                        n.distance <= 5 &&
                        n.optionsWithIndex.some(v => v.opIndex === 3 && /^pick.?pocket$/i.test(v.text)),
                )
                .sort((a, b) => a.distance - b.distance)[0];
            if (!npc) {
                stop = 'target missing';
                break;
            }
            const b = read();
            const c = cursor();
            attempts++;
            if (!(await s.sdk.sendInteractNpc(npc.index, 3)).success) throw Error('pickpocket dispatch refused');
            const event = () => {
                const messages = (st()?.gameMessages ?? []).filter(m => (m.observationId ?? m.tick) > c).map(m => m.text);
                const good = messages.includes('You pick the ' + p.pocket + '.');
                const bad = messages.includes('You fail to pick the ' + p.pocket + '.');
                return good && !bad ? 'success' : bad && !good ? 'failure' : 'none';
            };
            await wait(() => event() !== 'none', 12);
            const e = event();
            if (e === 'failure') await wait(() => hp() === b.hp - p.damage, 5);
            else if (e === 'success') await wait(() => pocketEffect(p, b, read(), e, o.xpRate) === 'success', 4);
            const effect = pocketEffect(p, b, read(), e, o.xpRate);
            if (effect === 'success') {
                successes++;
                noProgress = 0;
                await rest(2);
            } else if (effect === 'failure') {
                failures++;
                if (++noProgress >= o.maxNoProgress) {
                    stop = 'no useful progress';
                    break;
                }
                await rest(p.stunTicks + 2);
            } else if (effect === 'none') {
                if (++noProgress >= Math.min(3, o.maxNoProgress)) {
                    stop = 'no effect';
                    break;
                }
                await rest(2);
            } else {
                throw Error('pickpocket XP/loot/stun/health receipt mismatch');
            }
            console.log(
                'PICKPOCKET_RECEIPT ' +
                    JSON.stringify({ profile: p.name, npc: npc.id, effect, successes, failures, attempts, hp: hp(), tick: s.tick() }),
            );
        }
        if (successes !== o.successes && stop === 'target') stop = over() ? 'stopped/cap' : 'attempt budget';
    } catch (e) {
        failure = String(e);
        stop = 'failure';
    }
    const final = read();
    const allowed = new Set([...p.loot.map(i => i.id), o.food]);
    const all = new Set([...Object.keys(initial.items), ...Object.keys(final.items)].map(Number));
    const kitPreserved = [...all].every(id => allowed.has(id) || (final.items[id] ?? 0) === (initial.items[id] ?? 0));
    const loot = Object.fromEntries(p.loot.map(i => [i.id, (final.items[i.id] ?? 0) - (initial.items[i.id] ?? 0) + (i.id === o.food ? eaten : 0)]));
    return {
        ok: !failure && !over() && successes === o.successes && kitPreserved,
        profile: p.name,
        stop,
        failure,
        successes,
        failures,
        attempts,
        eaten,
        hp: hp(),
        xp: final.xp - initial.xp,
        loot,
        kitPreserved,
        ticks: s.tick() - start,
    };
}

// ---------------------------------------------------------------------------
// 2. Bank-Staged Native Pickpocket Trip (`thieving:pickpocket`)
// ---------------------------------------------------------------------------
export type PickpocketTrip = Omit<BankRouteJob, 'family' | 'recipe'> & {
    profile: string;
    food: number;
    foodPerSuccess: number;
    attemptsPerSuccess: number;
    hpFloor: number;
    eatAt: number;
    xpRate: number;
};

export function validatePickpocketTrip(j: PickpocketTrip) {
    validateBankRouteJob({ ...j, family: 'pickpocket', recipe: j.profile });
    const p = pickpocketProfiles().find(x => x.name === j.profile);
    const food = questFoodDefinitions().get(j.food);
    if (
        !p ||
        !j.bank ||
        !j.site ||
        !j.members ||
        j.target > 1000 ||
        j.batch > 16 ||
        j.returnTicks < 120 ||
        ![j.food, j.foodPerSuccess, j.attemptsPerSuccess, j.hpFloor, j.eatAt].every(Number.isSafeInteger) ||
        j.foodPerSuccess < 1 ||
        j.foodPerSuccess > 28 ||
        j.attemptsPerSuccess < 1 ||
        j.attemptsPerSuccess > 20 ||
        j.hpFloor < 1 ||
        j.eatAt < j.hpFloor + p.damage ||
        !Number.isFinite(j.xpRate) ||
        j.xpRate <= 0 ||
        j.xpRate > 1000 ||
        !food ||
        food.next !== undefined
    ) {
        throw Error('invalid finite native pickpocket trip/food budget');
    }
    const spawns = JSON.parse(readFileSync(resolve(ROOT, 'knowledge/npcs.json'), 'utf8')) as {
        id: number;
        spawns: { x: number; z: number; level: number }[];
    }[];
    if (!spawns.some(n => p.npcs.includes(n.id) && n.spawns.some(s => s.level === j.site!.level && Math.max(Math.abs(s.x - j.site!.x), Math.abs(s.z - j.site!.z)) <= 8))) {
        throw Error('pickpocket site lacks declared native profile spawn');
    }
    return { profile: p, food };
}

export function pocketTripStop(
    actor: string,
    stop: () => boolean = () => false,
    exists: (p: string) => boolean = existsSync,
) {
    return (
        stop() ||
        exists('.practice/stop-all') ||
        exists(`.practice/stop-${actor}`) ||
        exists('.practice/stop-microbot-pickpocket-trip') ||
        (!!process.env.STOP_FILE && exists(process.env.STOP_FILE))
    );
}

export function pocketOwnedActions(s: Session, allowed: () => boolean) {
    const requireOwner = () => {
        if (!allowed()) throw Error('pickpocket dispatch original client/life/input owner absent');
    };
    const sdk = new Proxy(s.sdk, {
        get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            return typeof value === 'function'
                ? function (...args: unknown[]) {
                      if (typeof key === 'string' && key.startsWith('send')) requireOwner();
                      return value.apply(receiver, args);
                  }
                : value;
        },
    });
    const bot = new BotActions(sdk);
    const view = Object.create(s) as Session;
    Object.defineProperties(view, {
        sdk: { value: sdk },
        bot: { value: bot },
        direct: {
            value: (...args: unknown[]) => {
                requireOwner();
                return (s.direct as any)(...args);
            },
        },
    });
    return view;
}

type PickpocketTripDeps = {
    bank?: GatherExternalDeps['runBankProfile'];
    pocket?: typeof runPickpockets;
};

export async function runPickpocketTrips(
    s: Session,
    j: PickpocketTrip,
    requestStop: () => boolean = () => false,
    deps: PickpocketTripDeps = {},
) {
    const { profile: p, food } = validatePickpocketTrip(j);
    const start = s.tick();
    const state = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const gear = () => s.sdk.getEquipment();
    const initial = state()?.player;
    const life = initial?.lifeId;
    const respawns = initial?.respawnCount ?? 0;
    const hp0 = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const baseHp = s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0;
    const client = s.client as any;
    const owner = client.executeBotAction;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const stock = (rows: readonly { id: number; count: number }[]) => {
        const out: Record<number, number> = {};
        for (const i of rows) {
            const t = client.objType?.(i.id);
            const id = t?.certtemplate >= 0 ? t.certlink : i.id;
            out[id] = (out[id] ?? 0) + i.count;
        }
        return out;
    };
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const pack = () => stock(inv());
    const xp = () => s.sdk.getSkillXp('Thieving') ?? 0;
    const controls = () => ({
        retaliate: state()?.autoRetaliateEnabled,
        style: state()?.combatStyle?.currentStyle,
        prayers: state()?.prayers?.activePrayers,
    });
    const controls0 = JSON.parse(JSON.stringify(controls()));
    const loot: Record<number, number> = {};
    const gear0 = gear().map(i => ({ id: i.id, count: i.count, slot: i.slot }));
    const xp0 = xp();
    const otherXp = () => JSON.stringify(state()?.skills.filter(i => i.name !== 'Thieving').map(i => ({ name: i.name, experience: i.experience })));
    const other0 = otherXp();
    let ended = false;
    let uncertain = false;
    let eaten = 0;
    let verifiedSuccesses = 0;
    let verifiedFailures = 0;
    let bankGeneration = -1;
    const receipts: Awaited<ReturnType<typeof runPickpockets>>[] = [];
    void s.ended?.then(() => {
        ended = true;
    });
    const alive = () => {
        const at = state()?.player;
        return (
            s.client === client &&
            !ended &&
            !!initial &&
            !!at &&
            !at.isDead &&
            at.lifeId === life &&
            (at.respawnCount ?? 0) === respawns &&
            hp() > 0 &&
            client.executeBotAction === owner &&
            s.sdk.getStateAge() <= 5000 &&
            otherXp() === other0
        );
    };
    s = pocketOwnedActions(s, alive);
    const stop = () => !alive() || pocketTripStop(s.name ?? '', requestStop) || s.tick() - start >= j.cap - j.returnTicks;
    const cleanupStop = () => !alive() || s.tick() - start >= j.cap - 25;
    const atBank = () => {
        const at = state()?.player;
        return alive() && !!at && at.level === j.bank!.level && Math.max(Math.abs(at.worldX - j.bank!.x), Math.abs(at.worldZ - j.bank!.z)) <= 3;
    };
    const open = async () => {
        if (cleanupStop() || !atBank()) throw Error('pickpocket bank original life/site unavailable');
        bankGeneration = Math.max(bankGeneration, s.bankObservation?.()?.generation ?? -1);
        await s.sdk.sendCloseModal();
        if (!(await waitUntil(s, () => state()?.bank.isOpen === false && state()?.interface.isOpen === false && state()?.dialog.isOpen === false, { timeoutTicks: 8 }))) {
            throw Error('pickpocket bank closure unobserved');
        }
        if (cleanupStop() || !atBank()) throw Error('pickpocket bank owner lost during closure');
        await s.bot.openBank();
        if (
            !(await waitUntil(s, () => cleanupStop() || (!!state()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > bankGeneration), { timeoutTicks: 12 })) ||
            cleanupStop() ||
            !state()?.bank.isOpen ||
            !s.bankObservation?.()
        ) {
            throw Error('pickpocket fresh bank unobserved');
        }
        bankGeneration = s.bankObservation!()!.generation;
    };
    const all = () => {
        const b = s.bankObservation?.();
        if (!state()?.bank.isOpen || !b) throw Error('pickpocket fresh bank ledger unavailable');
        return stock([...inv(), ...gear(), ...b.items]);
    };
    if (
        !initial ||
        !Number.isSafeInteger(life) ||
        !equipmentObserved(client) ||
        state()?.combatStyle?.known !== true ||
        controls0.retaliate === undefined ||
        !Array.isArray(controls0.prayers) ||
        client.membersAccount !== 1 ||
        (s.sdk.getSkill('Thieving')?.level ?? 0) < p.level ||
        hp0 <= j.hpFloor + p.damage ||
        baseHp < hp0 ||
        j.eatAt >= baseHp
    ) {
        throw Error('pickpocket observed member/level/original HP/kit controls missing');
    }
    if (p.name === 'viking' && !questFlags(client)?.some(q => /fremennik/i.test(q.name) && q.state === 'complete')) {
        throw Error('Fremennik Trials completion unobserved before owned withdrawal');
    }
    const minimumHeal = Math.min(food.heal, baseHp - j.eatAt);
    const requiredPerSuccess = Math.ceil((p.damage * j.attemptsPerSuccess) / minimumHeal) + 1;
    if (j.foodPerSuccess < requiredPerSuccess) throw Error('declared food budget cannot fund native failure damage and return healing');
    const heal = async (goal: number, continuity: () => boolean = () => true) => {
        const guarded = () => {
            if (!continuity()) {
                uncertain = true;
                return false;
            }
            return alive();
        };
        const foodSession = pocketOwnedActions(s, guarded);
        while (hp() < goal) {
            if (!guarded()) throw Error('pickpocket healing damage/ownership continuity changed');
            if (cleanupStop() || hp() <= j.hpFloor || uncertain) throw Error('pickpocket healing life/budget/unknown input');
            const row = inv().find(i => i.id === j.food);
            const before = pack();
            const old = hp();
            const beforeXp = xp();
            if (!row) throw Error('pickpocket owned return food exhausted');
            uncertain = true;
            let reply: unknown;
            try {
                reply = await foodSession.bot.eatFood(row);
            } catch (e) {
                reply = e;
            }
            if (!guarded()) throw Error('pickpocket healing damage/ownership continuity changed');
            const expected = Math.min(baseHp, old + food.heal);
            const effect = () => {
                const after = pack();
                const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
                return hp() === expected && xp() === beforeXp && [...ids].every(id => (after[Number(id)] ?? 0) - (before[Number(id)] ?? 0) === (Number(id) === j.food ? -1 : 0));
            };
            if (!(await waitUntil(s, () => !guarded() || effect(), { timeoutTicks: 8 })) || !guarded() || !effect()) {
                throw Error('pickpocket return food unknown; no retry ' + String(reply));
            }
            uncertain = false;
            eaten++;
            for (let settled = 0; settled < 3; settled++) {
                await waitTicks(s, 1);
                if (!guarded() || !effect()) {
                    uncertain = true;
                    throw Error('pickpocket food settlement life/stock/HP/XP changed');
                }
            }
        }
    };
    if (stop()) return { ok: false, failure: 'pickpocket stopped before bank input', verifiedSuccesses: 0, verifiedFailures: 0, eaten: 0, balanced: false, recoveryDeferred: false };
    await open();
    const baseline = all();
    if ((baseline[j.food] ?? 0) < j.target * j.foodPerSuccess + (j.reserve ?? 0)) {
        await s.bot.closeBank();
        return { ok: false, failure: 'pickpocket owned food stock short before withdrawals', verifiedSuccesses: 0, verifiedFailures: 0, eaten: 0, balanced: true, recoveryDeferred: false };
    }
    const profile: BankProfile = {
        bank: j.bank!,
        site: j.site!,
        inputs: { [j.food]: j.foodPerSuccess },
        tools: [],
        outputs: p.loot.map(i => i.id),
        capacityOutputs: Object.fromEntries(p.loot.map(i => [i.id, i.max])),
        deferBankRecovery: () => uncertain,
        run: async (n, cap) => {
            let made = 0;
            try {
                for (let attempts = 0; made < n && attempts < n * j.attemptsPerSuccess; attempts++) {
                    if (stop()) throw Error('pickpocket stopped before next owned attempt');
                    if (hp() <= j.hpFloor + p.damage) await heal(Math.min(hp0, j.eatAt + 1));
                    const cursor = Math.max(-1, ...(state()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
                    const at = s.tick();
                    const packBefore = pack();
                    const xpBefore = xp();
                    const hpBefore = hp();
                    uncertain = true;
                    let r = await (deps.pocket ?? runPickpockets)(s, p, {
                        successes: 1,
                        attempts: 1,
                        maxNoProgress: 2,
                        cap: Math.max(1, Math.min(cap, j.cap - j.returnTicks - (s.tick() - start))),
                        hpFloor: j.hpFloor,
                        eatAt: j.eatAt,
                        food: j.food,
                        foodReserve: 0,
                        xpRate: j.xpRate,
                        members: true,
                        stop,
                    });
                    const freshMessages = (state()?.gameMessages ?? []).filter(
                        m => m.type === 0 && m.sender === '' && m.fromSelf === false && Number.isSafeInteger(m.observationId) && m.observationId! > cursor && m.tick >= at && m.tick <= s.tick(),
                    );
                    const success = freshMessages.some(m => m.text === 'You pick the ' + p.pocket + '.');
                    const failed = freshMessages.some(m => m.text === 'You fail to pick the ' + p.pocket + '.');
                    if (r.attempts === 1 && r.eaten === 0 && success !== failed) {
                        const event = success ? 'success' : 'failure';
                        const effect = pocketEffect(p, { items: packBefore, xp: xpBefore, hp: hpBefore }, { items: pack(), xp: xp(), hp: hp() }, event, j.xpRate);
                        if (effect === event) r = { ...r, successes: success ? 1 : 0, failures: failed ? 1 : 0, xp: xp() - xpBefore, kitPreserved: true, failure: '' };
                    }
                    receipts.push(r);
                    if (r.attempts === 0 && r.eaten === 0 && !r.failure && r.kitPreserved && same(pack(), packBefore) && xp() === xpBefore && hp() === hpBefore) {
                        uncertain = false;
                        throw Error('pickpocket no submitted attempt: ' + r.stop);
                    }
                    const known =
                        r.attempts === 1 &&
                        r.kitPreserved &&
                        !r.failure &&
                        ((r.successes === 1 && r.failures === 0 && r.xp === p.xp * j.xpRate) || (r.failures === 1 && r.successes === 0 && r.xp === 0));
                    const text = r.successes === 1 ? 'You pick the ' + p.pocket + '.' : 'You fail to pick the ' + p.pocket + '.';
                    const native = freshMessages.some(m => m.text === text);
                    if (!known || !native) throw Error('pickpocket attempted outcome unknown; no repeat or bank mutation');
                    uncertain = false;
                    for (const [id, num] of Object.entries(r.loot)) loot[Number(id)] = (loot[Number(id)] ?? 0) + num;
                    eaten += r.eaten;
                    verifiedSuccesses += r.successes;
                    verifiedFailures += r.failures;
                    made += r.successes;
                    const settleAt = at + (r.failures ? p.stunTicks + 2 : 2);
                    while (s.tick() < settleAt) {
                        if (cleanupStop()) throw Error('pickpocket native stun/action settlement stopped');
                        await waitTicks(s, 1);
                    }
                    if (r.failures) {
                        if (state()?.player?.combat.targetType !== 'none' || state()?.nearbyPlayers.length !== 0) {
                            uncertain = true;
                            throw Error('pickpocket known failure healing target/peer changed');
                        }
                        const knownDamage = state()?.player?.combat.lastDamageTick;
                        const knownCombatCycle = (client.localPlayer as any)?.combatCycle;
                        const knownContinuity = () =>
                            state()?.player?.combat.lastDamageTick === knownDamage &&
                            (client.localPlayer as any)?.combatCycle === knownCombatCycle &&
                            state()?.nearbyPlayers.length === 0 &&
                            state()?.player?.combat.targetType === 'none' &&
                            same(controls(), controls0) &&
                            same(gear().map(i => ({ id: i.id, count: i.count, slot: i.slot })), gear0);
                        await heal(hp0, knownContinuity);
                        if (!knownContinuity()) {
                            uncertain = true;
                            throw Error('pickpocket known failure damage changed during healing');
                        }
                        const after = pack();
                        const afterHp = hp();
                        const afterXp = xp();
                        const damage = state()?.player?.combat.lastDamageTick;
                        const combatCycle = (client.localPlayer as any)?.combatCycle;
                        const quietChecks = () => ({
                            alive: alive(),
                            budget: !cleanupStop(),
                            pack: same(pack(), after),
                            hp: hp() === afterHp,
                            xp: xp() === afterXp,
                            controls: same(controls(), controls0),
                            gear: same(gear().map(i => ({ id: i.id, count: i.count, slot: i.slot })), gear0),
                            peers: state()?.nearbyPlayers.length === 0,
                            target: state()?.player?.combat.targetType === 'none',
                            damage: state()?.player?.combat.lastDamageTick === damage,
                            combatCycle: (client.localPlayer as any)?.combatCycle === combatCycle,
                        });
                        const quietValid = () => Object.values(quietChecks()).every(Boolean);
                        const cycle = client.getClientCycle?.();
                        if (!Number.isSafeInteger(cycle) || !Number.isSafeInteger(combatCycle) || combatCycle - cycle > 400) {
                            uncertain = true;
                            throw Error('pickpocket known damage native combat clock unavailable');
                        }
                        const quietTicks = Math.max(2, Math.min(402, combatCycle - cycle + 2, j.cap - 25 - (s.tick() - start)));
                        if (
                            !(await waitUntil(
                                s,
                                () => {
                                    if (!quietValid()) {
                                        uncertain = true;
                                        throw Error('pickpocket known failure quiet settlement changed ' + JSON.stringify({ checks: quietChecks(), tick: s.tick() }));
                                    }
                                    return state()?.player?.combat.inCombat === false;
                                },
                                { timeoutTicks: quietTicks },
                            )) ||
                            !quietValid() ||
                            state()?.player?.combat.inCombat !== false
                        ) {
                            uncertain = true;
                            throw Error('pickpocket known failure combat grace unconfirmed; no next attempt');
                        }
                    }
                }
                if (made !== n) throw Error('pickpocket finite success/attempt budget unmet');
                await heal(hp0);
                console.log('PICKPOCKET_TRIP_BANK_HANDOFF ' + JSON.stringify({ made, verifiedSuccesses, verifiedFailures, eaten, hp: hp(), tick: s.tick() }));
                return made;
            } catch (error) {
                if (!uncertain && alive()) {
                    try {
                        await heal(hp0);
                    } catch (recovery) {
                        throw Error(String(error) + '; healing ' + String(recovery));
                    }
                }
                throw error;
            }
        },
    };
    const bankRunner = deps.bank;
    if (!bankRunner) throw Error('pickpocket trip requires deps.bank or deps.runBankProfile');
    const result = await bankRunner(
        s,
        { ...j, family: 'pickpocket', recipe: j.profile, cap: j.cap - 20, returnTicks: j.returnTicks - 20 },
        profile,
        () => pocketTripStop(s.name ?? '', requestStop) || !alive(),
    );
    let balanced = false;
    let bankAudit: Record<number, number> | undefined;
    if (!result.recoveryDeferred && !uncertain && result.atBank && atBank()) {
        await open();
        const actual = all();
        const ids = new Set([...Object.keys(baseline), ...Object.keys(actual), ...Object.keys(loot)]);
        balanced = [...ids].every(id => (actual[Number(id)] ?? 0) - (baseline[Number(id)] ?? 0) === (loot[Number(id)] ?? 0) - (Number(id) === j.food ? eaten : 0));
        bankAudit = stock(s.bankObservation!()!.items);
        await s.bot.closeBank();
    }
    const preserved = same(gear().map(i => ({ id: i.id, count: i.count, slot: i.slot })), gear0) && same(controls(), controls0) && alive();
    const paidXp = xp() - xp0;
    const exactXp = paidXp === verifiedSuccesses * p.xp * j.xpRate;
    return {
        ...result,
        ok: result.ok && balanced && preserved && exactXp && hp() >= hp0,
        verifiedSuccesses,
        verifiedFailures,
        eaten,
        loot,
        balanced,
        preserved,
        exactXp,
        paidXp,
        bankAudit,
        receipts,
        recoveryDeferred: result.recoveryDeferred || uncertain,
        scope: 'finite declared native pickpocket profile, owned bank food/refills, single-attempt known receipts and final fresh bank audit',
    };
}

// ---------------------------------------------------------------------------
// 3. Thieving Stalls + Line of Sight (`thieving:stalls`)
// ---------------------------------------------------------------------------
export type StallRecipe = { name: string; loc: number; level: number; respawn: number; loot: number[]; questGate: boolean; owners: number[]; guards: number[] };
let cachedStallRecipes: StallRecipe[] | undefined;

export function stallRecipes(): StallRecipe[] {
    if (cachedStallRecipes) return cachedStallRecipes;
    const pack = (file: string) =>
        new Map(
            readFileSync(resolve(CONTENT, 'pack', file), 'utf8')
                .split(/\r?\n/)
                .flatMap(l => {
                    const m = l.match(/^(\d+)=(.+)$/);
                    return m ? ([[m[2]!, Number(m[1])] as const]) : [];
                }),
        );
    const locs = pack('loc.pack');
    const objs = pack('obj.pack');
    const npcs = pack('npc.pack');
    cachedStallRecipes = parseConfigs(readFileSync(resolve(CONTENT, 'scripts/skill_thieving/configs/stalls/stealing.dbrow'), 'utf8'), 'stealing.dbrow').map(
        b => {
            const fields = b.props.data ?? [];
            const one = (key: string) => fields.find(v => v.startsWith(key + ','))?.slice(key.length + 1);
            const locName = one('loc')!;
            const actors = (key: string) =>
                fields
                    .filter(v => v.startsWith(key + ','))
                    .map(v => {
                        const name = v.slice(key.length + 1);
                        const id = npcs.get(name);
                        if (id === undefined) throw Error('native stall actor unresolved ' + name);
                        return id;
                    });
            const r = {
                name: b.name,
                loc: locs.get(locName)!,
                level: Number(one('level')),
                respawn: Number(one('respawn_ticks')),
                loot: fields.filter(v => v.startsWith('loot,')).map(v => objs.get(v.split(',')[1]!)!),
                questGate: locName === 'viking_fish_market' || locName === 'viking_fur_market',
                owners: actors('owner'),
                guards: actors('guard'),
            };
            if (!Number.isSafeInteger(r.loc) || !Number.isSafeInteger(r.level) || !Number.isSafeInteger(r.respawn) || !r.loot.length || !r.loot.every(Number.isSafeInteger)) {
                throw Error('native stall recipe unresolved: ' + b.name);
            }
            return r;
        },
    );
    return cachedStallRecipes;
}

export function stallWatched(
    r: StallRecipe,
    p: { worldX: number; worldZ: number; level: number },
    npcs: readonly { id: number; x: number; z: number; inCombat: boolean }[],
    sight: (x: number, z: number, toX: number, toZ: number, level: number) => boolean,
) {
    return npcs.some(
        n =>
            (r.owners.includes(n.id) || (r.guards.includes(n.id) && !n.inCombat)) &&
            Math.max(Math.abs(n.x - p.worldX), Math.abs(n.z - p.worldZ)) <= 5 &&
            sight(n.x, n.z, p.worldX, p.worldZ, p.level),
    );
}

export function withStallSightBlocker<T>(
    grid: { isFlagged(x: number, z: number, level: number, mask: number): boolean; __set(x: number, z: number, level: number, mask: number): void },
    loc: { x: number; z: number; level: number; width: number; length: number },
    query: () => T,
): T {
    const saved: { x: number; z: number; mask: number }[] = [];
    for (let x = loc.x; x < loc.x + loc.width; x++) {
        for (let z = loc.z; z < loc.z + loc.length; z++) {
            let mask = 0;
            for (let bit = 0; bit < 32; bit++) if (grid.isFlagged(x, z, loc.level, 1 << bit)) mask |= 1 << bit;
            saved.push({ x, z, mask });
            grid.__set(x, z, loc.level, mask | 131072);
        }
    }
    try {
        return query();
    } finally {
        for (const t of saved) grid.__set(t.x, t.z, loc.level, t.mask);
    }
}

export function withStallSightBlockers<T>(
    grid: Parameters<typeof withStallSightBlocker>[0],
    locs: readonly Parameters<typeof withStallSightBlocker>[1][],
    query: () => T,
): T {
    return locs.reduce<() => T>((inner, loc) => () => withStallSightBlocker(grid, loc, inner), query)();
}

export type StallSight = (x: number, z: number, toX: number, toZ: number, level: number) => boolean;

export async function stallSight(s: Session, r: StallRecipe): Promise<StallSight | undefined> {
    if (!s.client) return undefined;
    const { loadPathfinding } = await import('../../../core/src/pathcache');
    await loadPathfinding();
    const pf = await import('../../../../vendor/rs-sdk/sdk/pathfinding');
    const grid = await import('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
    return (x, z, toX, toZ, level) => {
        for (const a of [x, toX]) for (const b of [z, toZ]) pf.isTileWalkable(level, a, b);
        const type = (s.client as { locTypeOf(id: number): { width: number; length: number; blockrange: boolean } }).locTypeOf(r.loc);
        const query = () => grid.hasLineOfSight(level, x, z, toX, toZ, 1, 1, 1, 1, 0);
        const stalls = type.blockrange ? (s.sdk.getState()?.nearbyLocs ?? []).filter(l => l.id === r.loc).map(l => ({ ...l, width: type.width, length: type.length })) : [];
        return withStallSightBlockers(grid, stalls, query);
    };
}

type Stock = readonly { id: number; count: number }[];
const stockCount = (items: Stock, id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

export function stallEffect(recipe: StallRecipe, before: Stock, after: Stock, xpBefore: number, xpAfter: number) {
    const gains = recipe.loot.map(id => ({ id, amount: stockCount(after, id) - stockCount(before, id) }));
    return gains.filter(x => x.amount === 1).length === 1 && gains.every(x => x.amount === 0 || x.amount === 1) && xpAfter > xpBefore;
}

export async function stealStall(s: Session, name: string, maximum: number, cap: number, stop: () => boolean = () => false) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(cap) || cap < 1) throw Error('invalid stall order');
    const r = stallRecipes().find(x => x.name === name);
    if (!r) throw Error('unknown native stall');
    const life = watchProductionLife(s, stop);
    const start = s.tick();
    const over = () => life.stopped() || s.tick() - start >= cap;
    const inv = () => s.sdk.getInventory().map(i => ({ id: i.id, count: i.count }));
    const xp = () => s.sdk.getSkillXp('Thieving') ?? 0;
    const initial = inv();
    const xp0 = xp();
    let made = 0;
    let detail = '';
    let attempts = 0;
    const loot: Record<number, number> = {};
    const sight = (await stallSight(s, r)) ?? (() => true);
    const watched = () => {
        const st = s.sdk.getState();
        return !!st?.player && stallWatched(r, st.player, st.nearbyNpcs ?? [], sight);
    };
    try {
        if ((s.sdk.getSkill('Thieving')?.level ?? 0) < r.level) throw Error('stall thieving level short');
        while (made < maximum && !over()) {
            if (s.sdk.getInventory().length >= 28) throw Error('stall inventory full; bank retained outputs');
            const loc = () => s.sdk.getState()?.nearbyLocs.find(l => l.id === r.loc);
            if (!loc()) await waitUntil(s, () => !!loc() || over(), { timeoutTicks: Math.min(r.respawn + 10, Math.max(1, cap - (s.tick() - start))) });
            if (over()) break;
            const target = loc();
            if (!target) throw Error('native stall absent after respawn budget');
            if (watched()) {
                await waitUntil(s, () => !watched() || over(), { timeoutTicks: Math.min(32, Math.max(1, cap - (s.tick() - start))) });
                if (over()) break;
                if (watched()) continue;
            }
            const before = inv();
            const beforeXp = xp();
            attempts++;
            const sent = await s.sdk.sendInteractLoc(target.x, target.z, target.id, 2);
            if (!sent.success) throw Error('native stall interaction rejected');
            await waitUntil(s, () => stallEffect(r, before, inv(), beforeXp, xp()) || over(), {
                timeoutTicks: Math.min(12, Math.max(1, cap - (s.tick() - start))),
            });
            if (!stallEffect(r, before, inv(), beforeXp, xp())) {
                if (!r.questGate && !over() && attempts < maximum * 4 + 8) {
                    await waitTicks(s, 2);
                    continue;
                }
                throw Error(r.questGate ? 'stall no progress; check Fremennik Trials gate/owner/guard visibility' : 'stall no progress; owner/guard state did not settle');
            }
            for (const id of r.loot) {
                const n = stockCount(inv(), id) - stockCount(before, id);
                if (n) loot[id] = (loot[id] ?? 0) + n;
            }
            made++;
            if (made < maximum && !over()) await waitTicks(s, Math.min(2, Math.max(1, cap - (s.tick() - start))));
        }
        if (made !== maximum) throw Error(life.reason() || 'stall tick budget');
    } catch (error) {
        detail = String(error);
    }
    const final = inv();
    const preserved = initial.every(i => stockCount(final, i.id) === stockCount(initial, i.id) + (loot[i.id] ?? 0));
    detail ||= life.reason();
    return { ok: !detail && made === maximum && preserved, made, attempts, loot, preserved, xpGain: xp() - xp0, ticks: s.tick() - start, detail };
}

// ---------------------------------------------------------------------------
// 4. Nature Chest (`thieving:nature-chest`)
// ---------------------------------------------------------------------------
export const NATURE_CHEST = 2567;
export const NATURE_RUNE = 561;
export const THIEVING_COINS_ID = 995;

export interface ChestOptions {
    x: number;
    z: number;
    level: number;
    maxLoots: number;
    cap: number;
    idleTicks: number;
}

export function chestOptions(env: Record<string, string | undefined> = process.env): ChestOptions {
    const read = (k: string, fallback: number | undefined, min: number, max: number) => {
        const n = env[k] === undefined ? fallback : Number(env[k]);
        if (n === undefined || !Number.isSafeInteger(n) || n < min || n > max) throw Error(`invalid ${k}`);
        return n;
    };
    return {
        x: read('CHEST_X', undefined, 1, 16383),
        z: read('CHEST_Z', undefined, 1, 16383),
        level: read('CHEST_LEVEL', undefined, 0, 3),
        maxLoots: read('MAX_LOOTS', 10, 1, 10000),
        cap: read('CAP', 1000, 1, 100000),
        idleTicks: read('IDLE_TICKS', 100, 1, 1000),
    };
}

const totalStateId = (s: BotWorldState, id: number) => s.inventory.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const stateThievingXp = (s: BotWorldState) => s.skills.find(k => k.name === 'Thieving')?.experience ?? 0;
const stateHpLevel = (s: BotWorldState) => s.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;
const natureKit = (s: BotWorldState) =>
    JSON.stringify(
        [...s.inventory.filter(i => i.id !== NATURE_RUNE && i.id !== THIEVING_COINS_ID).reduce((m, i) => m.set(i.id, (m.get(i.id) ?? 0) + i.count), new Map<number, number>())].sort(
            (a, b) => a[0] - b[0],
        ),
    );

export function natureChestEffect(before: BotWorldState, after: BotWorldState) {
    const nature = totalStateId(after, NATURE_RUNE) - totalStateId(before, NATURE_RUNE);
    const coins = totalStateId(after, THIEVING_COINS_ID) - totalStateId(before, THIEVING_COINS_ID);
    if (natureKit(before) !== natureKit(after) || stateHpLevel(after) !== stateHpLevel(before)) throw Error('chest assets or health changed');
    if (nature === 0 && coins === 0 && stateThievingXp(after) === stateThievingXp(before)) return false;
    if (nature !== 1 || coins !== 3 || stateThievingXp(after) <= stateThievingXp(before)) throw Error('nature chest effect does not reconcile');
    return true;
}

export async function runNatureChest(
    d: {
        state: () => BotWorldState | null;
        tick: () => number;
        stopped: () => boolean;
        act: (x: number, z: number, id: number, option: number) => Promise<{ success: boolean }>;
        wait: (test: () => boolean, ticks: number) => Promise<boolean>;
        step: () => Promise<void>;
    },
    o: ChestOptions,
) {
    if (!Number.isSafeInteger(o.maxLoots) || o.maxLoots < 1 || !Number.isSafeInteger(o.cap) || o.cap < 1 || !Number.isSafeInteger(o.idleTicks) || o.idleTicks < 1) {
        throw Error('invalid chest bounds');
    }
    const initial = d.state();
    if (!initial?.player || stateHpLevel(initial) < 1) throw Error('chest state unknown');
    if ((initial.skills.find(k => k.name === 'Thieving')?.level ?? 0) < 28) throw Error('nature chest requires Thieving28');
    if (initial.inventory.length + Number(totalStateId(initial, NATURE_RUNE) === 0) + Number(totalStateId(initial, THIEVING_COINS_ID) === 0) > 28) {
        throw Error('nature chest needs reward space');
    }
    const start = d.tick();
    let progress = start;
    let loots = 0;
    const state = () => {
        const s = d.state();
        if (!s?.player) throw Error('chest session ended');
        if (d.stopped()) throw Error('chest stopped');
        if (d.tick() - start >= o.cap) throw Error('chest tick cap');
        if (s.player.level !== o.level || Math.max(Math.abs(s.player.worldX - o.x), Math.abs(s.player.worldZ - o.z)) > 2) {
            throw Error('start beside chest on its floor');
        }
        if (s.player.isDead || s.player.lifeId !== initial.player!.lifeId || stateHpLevel(s) !== stateHpLevel(initial)) {
            throw Error('chest health or life changed');
        }
        return s;
    };
    while (loots < o.maxLoots) {
        const s = state();
        if (d.tick() - progress >= o.idleTicks) throw Error('nature chest no progress');
        const chest = s.nearbyLocs.find(l => l.id === NATURE_CHEST && l.x === o.x && l.z === o.z && l.level === o.level && l.reachable !== false);
        const option = chest?.optionsWithIndex.find(v => /^Search for traps$/i.test(v.text));
        if (!chest || !option) {
            await d.step();
            continue;
        }
        if (!(await d.act(chest.x, chest.z, chest.id, option.opIndex)).success) throw Error('nature chest action refused');
        const hit = await d.wait(() => natureChestEffect(s, state()), Math.min(20, o.cap - (d.tick() - start)));
        if (!hit) throw Error('nature chest reward unobserved');
        loots++;
        progress = d.tick();
        if (loots < o.maxLoots) await d.step();
    }
    const final = state();
    if (
        totalStateId(final, NATURE_RUNE) - totalStateId(initial, NATURE_RUNE) !== loots ||
        totalStateId(final, THIEVING_COINS_ID) - totalStateId(initial, THIEVING_COINS_ID) !== loots * 3 ||
        natureKit(final) !== natureKit(initial)
    ) {
        throw Error('nature chest total does not reconcile');
    }
    return { loots, natureRunes: loots, coins: loots * 3, ticks: d.tick() - start };
}

// ---------------------------------------------------------------------------
// 5. Blood Chest (`thieving:blood-chest`)
// ---------------------------------------------------------------------------
export const CHEST = 2569;
export const BLOOD_RUNE = 565;
export const THIEVING_LEVEL = 59;
export const RUNES_PER_LOOT = 2;
export const COINS_PER_LOOT = 500;
export const CHESTS = [
    { x: 2586, z: 9734 },
    { x: 2586, z: 9737 },
];
export const ARRIVAL = { x: 2584, z: 3337 };
export const BLOOD_BANK = { x: 2615, z: 3332 };
export const BLOOD_STAGE = { x: 2585, z: 9736 };
export const DOOR = { id: 2554, x: 2565, z: 3356 };
export const LADDER_DOWN = { id: 1754, x: 2562, z: 3356 };
export const LADDER_UP = { id: 1755, x: 2562, z: 9756 };
export const LADDER_FOOT = { x: 2563, z: 9756 };
export const RESPAWN_TICKS = 406;
export const EXIT_TICKS = 400;
export const PICK_LIMIT = 80;
const WALK_FAILS = 6;
export const FAR_RADIUS = 100;
export const TRAVEL_TICKS = 3000;
export const BANK_FOOD = ['Shark', 'Swordfish', 'Lobster', 'Tuna', 'Salmon', 'Trout', 'Cake'];
export const FED_SHARE = 0.75;
export const LEAVE_SHARE = 0.6;
export const MEAL_LIMIT = 40;
export const REGEN_TICKS = 100;
const EAT_DELAY_TICKS = 3;
const PACK_SLOTS = 28;

export interface BloodOptions {
    maxLoots: number;
    cap: number;
    idleTicks: number;
    bankEvery: number;
}
export type BloodStop = 'target' | 'cap' | 'hp' | 'idle';
export interface BloodResult {
    ok: boolean;
    stop: BloodStop;
    targetMet: boolean;
    conserved: boolean;
    loots: number;
    runes: number;
    coins: number;
    bankedRunes: number;
    bankedCoins: number;
    startRunes: number;
    startCoins: number;
    bankTrips: number;
    picks: number;
    entries: number;
    meals: number;
    ticks: number;
    hpMin: number;
    died: false;
}
export interface BloodDeps {
    state(): BotWorldState | null;
    tick(): number;
    stopped(): boolean;
    walkSurface(x: number, z: number): Promise<boolean>;
    travel(x: number, z: number, ticks: number): Promise<boolean>;
    walkDungeon(x: number, z: number, tolerance: number): Promise<boolean>;
    act(x: number, z: number, id: number, option: number): Promise<{ success: boolean }>;
    wait(test: () => boolean, ticks: number): Promise<boolean>;
    step(): Promise<void>;
    bank(food: boolean): Promise<{ runes: number; coins: number; food: number }>;
    eat(item: BotWorldState['inventory'][number]): Promise<{ success: boolean }>;
    log(line: string): void;
}

export function bloodOptions(tickCap: string | undefined, env: Record<string, string | undefined> = process.env): BloodOptions {
    const read = (k: string, raw: string | undefined, fallback: number | undefined, min: number, max: number) => {
        const n = raw === undefined ? fallback : Number(raw);
        if (n === undefined || !Number.isSafeInteger(n) || n < min || n > max) throw Error(`invalid ${k}`);
        return n;
    };
    const argument = read('tickCap', tickCap, undefined, EXIT_TICKS, 1000000);
    const cap = Math.min(argument, read('CAP', env.CAP, argument, EXIT_TICKS, 1000000));
    return {
        maxLoots: read('MAX_LOOTS', env.MAX_LOOTS, 2, 1, 10000),
        cap,
        idleTicks: read('IDLE_TICKS', env.IDLE_TICKS, 700, 1, 850),
        bankEvery: read('BANK_EVERY', env.BANK_EVERY, 50, 1, 10000),
    };
}

const bloodSkill = (s: BotWorldState, name: string) => s.skills.find(k => k.name === name);
const bloodHp = (s: BotWorldState) => bloodSkill(s, 'Hitpoints')?.level ?? 0;
const bloodBaseHp = (s: BotWorldState) => bloodSkill(s, 'Hitpoints')?.baseLevel ?? 0;
const bloodFed = (s: BotWorldState) => bloodHp(s) >= Math.ceil(bloodBaseHp(s) * FED_SHARE);
const bloodEdible = (s: BotWorldState) => s.inventory.find(i => i.optionsWithIndex.some(v => /^Eat$/i.test(v.text)));
const bloodCheb = (s: BotWorldState, t: { x: number; z: number }) => Math.max(Math.abs(s.player!.worldX - t.x), Math.abs(s.player!.worldZ - t.z));
const bloodKit = (s: BotWorldState) =>
    s.inventory.filter(i => i.id !== BLOOD_RUNE && i.id !== THIEVING_COINS_ID).reduce((m, i) => m.set(i.id, (m.get(i.id) ?? 0) + i.count), new Map<number, number>());
const bloodKitKept = (before: BotWorldState, after: BotWorldState) => {
    const now = bloodKit(after);
    return [...bloodKit(before)].every(([id, count]) => (now.get(id) ?? 0) >= count);
};

export type BloodZone = 'dungeon' | 'tower' | 'surface' | 'other';
export function bloodZone(s: BotWorldState): BloodZone {
    const p = s.player;
    if (!p || p.level !== 0) return 'other';
    if (p.worldZ >= 9700 && p.worldZ <= 9770 && p.worldX >= 2550 && p.worldX <= 2600) return 'dungeon';
    if (p.worldX >= 2555 && p.worldX < DOOR.x && p.worldZ >= 3352 && p.worldZ <= 3360) return 'tower';
    return p.worldZ < 6400 ? 'surface' : 'other';
}

export function bloodChestEffect(before: BotWorldState, after: BotWorldState) {
    const runes = totalStateId(after, BLOOD_RUNE) - totalStateId(before, BLOOD_RUNE);
    const coins = totalStateId(after, THIEVING_COINS_ID) - totalStateId(before, THIEVING_COINS_ID);
    const gained = (bloodSkill(after, 'Thieving')?.experience ?? 0) > (bloodSkill(before, 'Thieving')?.experience ?? 0);
    if (runes === 0 && coins === 0 && !gained) return false;
    if (runes !== RUNES_PER_LOOT || coins !== COINS_PER_LOOT || !gained) throw Error('blood chest effect does not reconcile');
    if (!bloodKitKept(before, after)) throw Error('blood chest assets changed');
    return bloodZone(after) === 'surface';
}

export function bloodRefusal(s: BotWorldState, o: BloodOptions) {
    const thieving = bloodSkill(s, 'Thieving')?.level ?? 0;
    if (thieving < THIEVING_LEVEL) return `blood chest refused: Thieving ${thieving} is below level ${THIEVING_LEVEL}`;
    const zone = bloodZone(s);
    if (zone === 'other') return 'blood chest refused: start on the ground floor, or in the chest dungeon';
    if (zone !== 'surface' && bloodHp(s) * 2 < bloodBaseHp(s) && !bloodEdible(s)) return 'blood chest refused: Hitpoints are below half';
    if (s.inventory.length + Number(totalStateId(s, BLOOD_RUNE) === 0) + Number(totalStateId(s, THIEVING_COINS_ID) === 0) > 28) {
        return 'blood chest refused: the pack has no room for the reward';
    }
    if (o.maxLoots * COINS_PER_LOOT + totalStateId(s, THIEVING_COINS_ID) > 2147483647) return 'blood chest refused: the coin stack would overflow';
    return null;
}

class BloodHalt extends Error {
    constructor(readonly stop: Exclude<BloodStop, 'target'>) {
        super(stop);
    }
}

export async function runBloodChest(d: BloodDeps, o: BloodOptions): Promise<BloodResult> {
    const initial = d.state();
    if (!initial?.player || bloodHp(initial) < 1) throw Error('blood chest state unknown');
    const refused = bloodRefusal(initial, o);
    if (refused) throw Error(refused);
    const start = d.tick();
    const startRunes = totalStateId(initial, BLOOD_RUNE);
    const startCoins = totalStateId(initial, THIEVING_COINS_ID);
    const ready = CHESTS.map(() => 0);
    let progress = start;
    let loots = 0;
    let sinceBank = 0;
    let picks = 0;
    let entries = 0;
    let seen = bloodZone(initial);
    let entryPicks = 0;
    let hpMin = bloodHp(initial);
    let trip = 0;
    let tripStart: number | null = null;
    let walkFails = 0;
    let bankedRunes = 0;
    let bankedCoins = 0;
    let bankTrips = 0;
    let meals = 0;
    let stop: BloodStop = 'target';
    const eaten = new Map<number, number>();
    const observe = () => {
        const s = d.state();
        if (!s?.player) throw Error('blood chest session ended');
        if (d.stopped()) throw Error('blood chest stopped');
        if (s.player.isDead || s.player.lifeId !== initial.player!.lifeId) throw Error('blood chest died');
        if (d.tick() - start >= o.cap) throw Error('blood chest tick cap');
        const zone = bloodZone(s);
        if (zone === 'tower') {
            entryPicks = 0;
            if (seen === 'surface') entries++;
        }
        seen = zone;
        hpMin = Math.min(hpMin, bloodHp(s));
        return s;
    };
    const checkpoint = () => {
        const s = observe();
        if (bloodHp(s) < Math.ceil(bloodBaseHp(s) * LEAVE_SHARE)) throw new BloodHalt('hp');
        if (d.tick() - start >= o.cap - EXIT_TICKS) throw new BloodHalt('cap');
        if (d.tick() - progress >= o.idleTicks) throw new BloodHalt('idle');
        return s;
    };
    const moved = async (ok: boolean, what: string) => {
        if (ok) {
            walkFails = 0;
            return;
        }
        if (++walkFails >= WALK_FAILS) throw Error(`blood chest walk failed: ${what}`);
        await d.step();
    };
    const bank = async (food = false) => {
        const s = observe();
        if (!food && totalStateId(s, BLOOD_RUNE) === 0 && totalStateId(s, THIEVING_COINS_ID) === 0) return;
        for (let i = 0; bloodCheb(observe(), BLOOD_BANK) > 2; i++) {
            if (i >= WALK_FAILS) throw Error('blood chest walk failed: bank');
            await d.walkSurface(BLOOD_BANK.x, BLOOD_BANK.z);
        }
        const r = await d.bank(food);
        const after = observe();
        if (totalStateId(after, BLOOD_RUNE) !== 0 || totalStateId(after, THIEVING_COINS_ID) !== 0) throw Error('blood chest bank left loot in the pack');
        bankedRunes += r.runes;
        bankedCoins += r.coins;
        bankTrips++;
        sinceBank = 0;
        d.log(`BLOOD_BANK ${JSON.stringify({ trip: bankTrips, runes: r.runes, coins: r.coins, food: r.food, tick: d.tick() - start })}`);
    };
    const enter = async (s: BotWorldState) => {
        if (bloodCheb(s, DOOR) > 1) {
            await moved(await d.walkSurface(DOOR.x, DOOR.z), 'door');
            return;
        }
        if (!s.nearbyLocs.some(l => l.id === DOOR.id && l.x === DOOR.x && l.z === DOOR.z)) {
            await d.step();
            return;
        }
        if (entryPicks >= PICK_LIMIT) throw Error('blood chest door not picked');
        entryPicks++;
        picks++;
        const sent = d.tick();
        if (!(await d.act(DOOR.x, DOOR.z, DOOR.id, 2)).success) {
            await d.step();
            return;
        }
        await d.wait(
            () => {
                const n = observe();
                return bloodZone(n) === 'tower' || n.gameMessages.some(m => m.tick >= sent && /fail to pick|activated a trap/i.test(m.text));
            },
            6,
        );
        await d.step();
    };
    const climb = async (at: { id: number; x: number; z: number }, to: BloodZone) => {
        if (!(await d.act(at.x, at.z, at.id, 1)).success) {
            await moved(false, `ladder ${at.id}`);
            return;
        }
        await moved(await d.wait(() => bloodZone(observe()) === to, 30), `ladder ${at.id}`);
    };
    const loot = async (s: BotWorldState) => {
        if (bloodCheb(s, BLOOD_STAGE) > 2) {
            await moved(await d.walkDungeon(BLOOD_STAGE.x, BLOOD_STAGE.z, 1), 'chest stage');
            return;
        }
        if (tripStart !== null) {
            trip = d.tick() - tripStart;
            tripStart = null;
            d.log(`BLOOD_TRIP ${JSON.stringify({ ticks: trip, picks, hp: bloodHp(s), npcs: s.nearbyNpcs.filter(n => n.name !== '').map(n => n.name) })}`);
        }
        const index = CHESTS.findIndex(c => s.nearbyLocs.some(l => l.id === CHEST && l.x === c.x && l.z === c.z && l.level === 0 && l.reachable !== false));
        if (index < 0) {
            await d.step();
            return;
        }
        const chest = CHESTS[index]!;
        const option = s.nearbyLocs.find(l => l.id === CHEST && l.x === chest.x && l.z === chest.z)?.optionsWithIndex.find(v => /^Search for traps$/i.test(v.text));
        if (!option) {
            await d.step();
            return;
        }
        if (!(await d.act(chest.x, chest.z, CHEST, option.opIndex)).success) {
            await d.step();
            return;
        }
        if (!(await d.wait(() => bloodChestEffect(s, observe()), 30))) return;
        loots++;
        sinceBank++;
        progress = d.tick();
        ready[index] = progress + RESPAWN_TICKS;
        d.log(`BLOOD_LOOT ${JSON.stringify({ loot: loots, chest, tick: d.tick() - start, hp: bloodHp(observe()) })}`);
    };
    const heal = async () => {
        let stocked = false;
        for (let i = 0; i < MEAL_LIMIT; i++) {
            const s = observe();
            const food = bloodEdible(s);
            if (bloodFed(s)) return true;
            if (!food && !stocked) {
                stocked = true;
                await bank(true);
                continue;
            }
            if (!food) {
                const need = Math.ceil(bloodBaseHp(s) * FED_SHARE) - bloodHp(s);
                const ticks = (need + 1) * REGEN_TICKS;
                if (d.tick() - start + ticks > o.cap - EXIT_TICKS) break;
                d.log(`BLOOD_REGEN ${JSON.stringify({ hp: bloodHp(s), need, ticks, tick: d.tick() - start })}`);
                const healed = await d.wait(() => bloodFed(observe()), ticks);
                progress = d.tick();
                return healed;
            }
            const before = bloodHp(s);
            const held = totalStateId(s, food.id);
            if (!(await d.eat(food)).success) throw Error('blood chest food refused');
            if (!(await d.wait(() => { const n = observe(); return bloodHp(n) > before && totalStateId(n, food.id) < held; }, 8))) {
                throw Error('blood chest food effect unobserved');
            }
            meals++;
            eaten.set(food.id, (eaten.get(food.id) ?? 0) + 1);
            d.log(`BLOOD_MEAL ${JSON.stringify({ meal: meals, id: food.id, before, hp: bloodHp(observe()), tick: d.tick() - start })}`);
            const next = d.tick() + EAT_DELAY_TICKS;
            await d.wait(() => d.tick() >= next, EAT_DELAY_TICKS + 1);
        }
        return bloodFed(observe());
    };
    const from = initial.player!;
    const where = `${from.worldX},${from.worldZ},${from.level}`;
    if (bloodZone(initial) === 'surface' && bloodCheb(initial, BLOOD_BANK) > FAR_RADIUS && bloodCheb(initial, DOOR) > FAR_RADIUS) {
        const budget = Math.min(TRAVEL_TICKS, o.cap - EXIT_TICKS);
        d.log(`BLOOD_TRAVEL ${JSON.stringify({ from: where, to: BLOOD_BANK, budget })}`);
        const ok = await d.travel(BLOOD_BANK.x, BLOOD_BANK.z, budget);
        const s = observe();
        if (!ok || bloodCheb(s, BLOOD_BANK) > FAR_RADIUS) {
            throw Error(`blood chest travel failed: start ${where} did not reach the Ardougne bank, stopped at ${s.player!.worldX},${s.player!.worldZ},${s.player!.level}`);
        }
        d.log(`BLOOD_TRAVEL_ARRIVED ${JSON.stringify({ at: `${s.player!.worldX},${s.player!.worldZ}`, tick: d.tick() - start })}`);
        progress = d.tick();
    }
    for (let again = true; again; ) {
        stop = 'target';
        try {
            while (loots < o.maxLoots) {
                const s = checkpoint();
                const zone = bloodZone(s);
                if (zone === 'surface') {
                    if (sinceBank >= o.bankEvery) {
                        await bank();
                        continue;
                    }
                    if (!bloodFed(s)) {
                        if (!(await heal())) throw new BloodHalt('hp');
                        tripStart = null;
                        continue;
                    }
                    if (d.tick() < Math.min(...ready) - trip) {
                        await d.step();
                        continue;
                    }
                    tripStart ??= d.tick();
                    await enter(s);
                } else if (zone === 'tower') {
                    tripStart ??= d.tick();
                    await climb(LADDER_DOWN, 'dungeon');
                } else if (zone === 'dungeon') await loot(s);
                else throw Error('blood chest left its route');
            }
        } catch (e) {
            if (!(e instanceof BloodHalt)) throw e;
            stop = e.stop;
        }
        for (let i = 0; i < WALK_FAILS * 2 && bloodZone(observe()) === 'dungeon'; i++) {
            if (bloodCheb(observe(), LADDER_FOOT) > 2) await d.walkDungeon(LADDER_FOOT.x, LADDER_FOOT.z, 1);
            else await climb(LADDER_UP, 'tower');
        }
        for (let i = 0; i < WALK_FAILS && bloodZone(observe()) === 'tower'; i++) {
            if ((await d.act(DOOR.x, DOOR.z, DOOR.id, 1)).success) await d.wait(() => bloodZone(observe()) === 'surface', 12);
            else await d.step();
        }
        if (bloodZone(observe()) !== 'surface') throw Error('blood chest exit failed');
        again = stop === 'hp' && (await heal());
    }
    await bank();
    const final = observe();
    const runes = loots * RUNES_PER_LOOT;
    const coins = loots * COINS_PER_LOOT;
    const kept = bloodKit(final);
    const conserved =
        bankedRunes === startRunes + runes &&
        bankedCoins === startCoins + coins &&
        [...bloodKit(initial)].every(([id, count]) => (kept.get(id) ?? 0) + (eaten.get(id) ?? 0) >= count);
    if (!conserved) throw Error('blood chest total does not reconcile');
    const targetMet = stop === 'target' && loots === o.maxLoots;
    return {
        ok: targetMet,
        stop,
        targetMet,
        conserved,
        loots,
        runes,
        coins,
        bankedRunes,
        bankedCoins,
        startRunes,
        startCoins,
        bankTrips,
        picks,
        entries,
        meals,
        ticks: d.tick() - start,
        hpMin,
        died: false,
    };
}

export function failureResult(error: unknown) {
    const failure = String(error);
    return { ok: false, stop: /refused/.test(failure) ? 'refused' : 'failed', failure };
}

export async function walkBloodDungeon(d: PathDeps, x: number, z: number, tolerance: number, stopped: () => boolean) {
    return (await walkPath(d, [{ x, z, tol: tolerance }], { maxTicks: 150, stop: stopped })).ok;
}

export async function runBloodChestSession(
    s: Session,
    o: BloodOptions,
    stop: () => boolean,
    log: (line: string) => void = console.log,
    deps?: GatherExternalDeps,
) {
    let ended = false;
    void s.ended.then(() => {
        ended = true;
    });
    const held = (id: number) => s.sdk.getState()?.inventory.find(i => i.id === id);
    const deposit = async (id: number) => {
        const item = held(id);
        return item ? depositObserved(s, { id, name: item.name }) : 0;
    };
    const pack = (id: number) => (s.sdk.getState()?.inventory ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const restock = async () => {
        await waitUntil(s, () => (s.sdk.getState()?.bank?.items.length ?? 0) > 0, { timeoutTicks: 10 });
        let taken = 0;
        for (const name of BANK_FOOD) {
            const room = PACK_SLOTS - 2 - (s.sdk.getState()?.inventory.length ?? PACK_SLOTS);
            const row = s.sdk.getState()?.bank?.items.find(i => i.name === name);
            const n = Math.min(room, row?.count ?? 0);
            if (!row || n <= 0) continue;
            const before = pack(row.id);
            await s.bot.withdrawItem(row, n);
            if (!(await waitUntil(s, () => pack(row.id) >= before + n, { timeoutTicks: 8 }))) throw Error(`blood chest food withdraw unobserved: ${name}`);
            taken += n;
        }
        return taken;
    };
    return runBloodChest(
        {
            state: () => s.sdk.getState(),
            tick: () => s.tick(),
            stopped: () => ended || stop(),
            walkSurface: async (x, z) => (await goTo(s, await getWorld(), { x, z, level: 0 }, accountOf(s), { legTimeoutTicks: 150 })).ok,
            travel: async (x, z, ticks) => {
                if (!deps?.walkFar) throw Error('blood chest far travel requires deps.walkFar');
                const ac = new AbortController();
                const end = s.tick() + ticks;
                const off = s.onTick(() => {
                    if (s.tick() >= end || ended || stop()) ac.abort('blood chest travel budget');
                });
                try {
                    return (await deps.walkFar(s, await getWorld(), { x, z, level: 0 }, 150, { signal: ac.signal })).ok && !ac.signal.aborted;
                } finally {
                    off();
                }
            },
            walkDungeon: async (x, z, tolerance) => {
                const life = s.sdk.getState()?.player?.lifeId;
                return walkBloodDungeon(await sessionWalker(s), x, z, tolerance, () => {
                    const p = s.sdk.getState()?.player;
                    return ended || !p || p.isDead || p.lifeId !== life || stop();
                });
            },
            act: (x, z, id, option) => s.sdk.sendInteractLoc(x, z, id, option),
            wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
            step: () => waitTicks(s, 1),
            bank: async food => {
                const open = await s.bot.openBank();
                if (!open.success) throw Error(`blood chest bank: ${open.message}`);
                const runes = await deposit(BLOOD_RUNE);
                const coins = await deposit(THIEVING_COINS_ID);
                const taken = food ? await restock() : 0;
                await s.bot.closeBank();
                return { runes, coins, food: taken };
            },
            eat: item => s.bot.eatFood(item),
            log,
        },
        o,
    );
}

// ---------------------------------------------------------------------------
// 6. Goldfarm Helpers & Knights (`thieving:knights`, `thieving:knights-stable`)
// ---------------------------------------------------------------------------
export type Tile = { x: number; z: number };
export const KNIGHT_SPOT: Tile = { x: 2653, z: 3302 };
export const BANK_SPOT: Tile = { x: 2654, z: 3283 };
export const KNIGHT = /^knight of ardougne$/i;
export const COINS_RE = /^coins$/i;
export const RANGE = 16;
export const KEEP_FREE = 2;
export const DMG = 3;

const COOKED_IDS = new Set([329, 333, 379, 330, 334, 380, 385, 386]);
const NOTED_COOKED_IDS = new Set([330, 334, 380, 386]);

export function incomingCookedFood(
    before: readonly { id: number; count: number }[],
    after: readonly { id: number; count: number }[],
) {
    const count = (rows: typeof before, id: number) => rows.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    return [...COOKED_IDS].reduce((n, id) => n + Math.max(0, count(after, id) - count(before, id)), 0);
}

export function courierFoodReady(
    status: any,
    from: string,
    server: string,
    owned: ReadonlySet<string>,
    now = Date.now(),
    tick = 0,
    lastAttempt = -120,
) {
    return (
        /^[A-Za-z0-9_ -]{1,12}$/.test(from) &&
        owned.has(from.toLowerCase()) &&
        typeof status?.name === 'string' &&
        status.name.toLowerCase() === from.toLowerCase() &&
        status.server === server &&
        !status.result &&
        Number.isFinite(status.at) &&
        now - status.at >= 0 &&
        now - status.at < 30000 &&
        tick - lastAttempt >= 120 &&
        status.pos?.level === 0 &&
        Math.max(Math.abs(status.pos.x - 2654), Math.abs(status.pos.z - 3283)) <= 8 &&
        Array.isArray(status.inventory) &&
        status.inventory.some((i: any) => NOTED_COOKED_IDS.has(i.id) && Number.isSafeInteger(i.count) && i.count > 0)
    );
}

export async function receiveFoodAtBank(
    s: Session,
    from: string,
    timeout: number,
    refill: () => Promise<void>,
    available: () => boolean,
    until?: () => boolean,
    server?: string,
    receiveHandoffFn?: GatherExternalDeps['receiveHandoff'],
) {
    if (!/^[A-Za-z0-9_ -]{1,12}$/.test(from)) throw Error('invalid configured food supplier');
    await refill();
    const before = s.sdk.getInventory().map(i => ({ ...i }));
    const start = s.tick();
    const serve = () => s.bot.serveTrades({ from: new RegExp(`^${from}$`, 'i'), maxTrades: 1, timeout, until });
    const result = server
        ? receiveHandoffFn
            ? await receiveHandoffFn(s, from, server, serve)
            : (() => {
                  throw Error('receiveFoodAtBank with server requires deps.receiveHandoff');
              })()
        : await serve();
    const ticks = s.tick() - start;
    const incoming = incomingCookedFood(before, s.sdk.getInventory());
    if (s.tick() === start) await waitTicks(s, 1);
    await refill();
    return { incoming, available: available(), ticks, reason: result.reason, message: result.message };
}

export const REFUGE_WINDOW = 500;
export const REFUGE_NONE = 0.06;
export const refugeDue = (v: { ticks: number; none: number; moved: boolean; atRefuge: boolean }) =>
    !v.moved && !v.atRefuge && v.ticks >= REFUGE_WINDOW && v.none >= REFUGE_NONE * v.ticks;

const LOBSTER_RE = /^lobster$/i;
const BANK_FOOD_PATTERNS = [/^trout$/i, /^salmon$/i, LOBSTER_RE, /^shark$/i, /^cake$/i, /^2\/3 cake$/i, /^slice of cake$/i, /^bread$/i, /^chocolate slice$/i];
const BIG_FOOD = /^(trout|salmon|lobster|shark)$/i;
const STALL_SPOT: Tile = { x: 2655, z: 3310 };
const STALL = /^baker'?s stall$/i;
const GUARD = /^guard$/i;
const BAKER = /^baker$/i;
const GUARD_SAFE = 6;
export const FOOD_ORDER = [/^slice of cake$/i, /^2\/3 cake$/i, /^cake$/i, /^chocolate slice$/i, /^bread$/i, /^trout$/i, /^salmon$/i, LOBSTER_RE, /^shark$/i];
const foodRank = (i: { name: string }) => FOOD_ORDER.findIndex(re => re.test(i.name));
export const foodBiteHeal = (i: { id: number }): number | undefined => questFoodDefinitions().get(i.id)?.heal;

export function pickFoodForLoss<T extends { id: number; name: string }>(foods: readonly T[], loss: number): T | undefined {
    const sorted = [...foods].sort((a, b) => (foodBiteHeal(a) ?? Infinity) - (foodBiteHeal(b) ?? Infinity) || foodRank(a) - foodRank(b));
    return [...sorted].reverse().find(i => (foodBiteHeal(i) ?? Infinity) <= loss) ?? sorted[0];
}

export const FRAIL_HP = 20;
export const FRAIL_RESERVE = 6;
export const FRAIL_FLOOR = 2;
export const foodReserve = (maxHp: number) => (maxHp < FRAIL_HP ? FRAIL_RESERVE : FRAIL_FLOOR);
export const foodTripDue = (v: { low: boolean; bankEmpty: boolean; tradeOnly: boolean; rested: boolean; shopOk: boolean; emptyTrips: number }) =>
    !v.tradeOnly && v.low && v.bankEmpty && v.rested && (v.shopOk || v.emptyTrips < 3);
export const guardHit = (before: number, after: number, picked: boolean) => after < before && !picked;
const STALL_REST = 200;

export const ownerSeesTile = (
    recipe: StallRecipe,
    tile: { x: number; z: number },
    level: number,
    npcs: readonly { id: number; x: number; z: number; inCombat: boolean }[],
    sight: StallSight,
) => stallWatched({ ...recipe, guards: [] }, { worldX: tile.x, worldZ: tile.z, level }, npcs, sight);

export type KnightView = { inRange: boolean; reachable: boolean; banned: boolean; avoided: boolean };
export type NoKnight = 'none' | 'far' | 'unreachable' | 'banned' | 'avoided';
export function noKnightReason(knights: readonly KnightView[]): NoKnight {
    if (!knights.length) return 'none';
    const near = knights.filter(k => k.inRange);
    if (!near.length) return 'far';
    const open = near.filter(k => k.reachable);
    if (!open.length) return 'unreachable';
    return open.some(k => !k.banned) ? 'avoided' : 'banned';
}

type FarmNpc = { index: number; name: string; x: number; z: number; distance: number; reachable?: boolean; optionsWithIndex: readonly { text: string; opIndex: number }[] };
export function farmPickTarget<T extends FarmNpc>(
    npcs: readonly T[],
    p: { worldX: number; worldZ: number } | null | undefined,
    avoid?: ReadonlySet<number>,
    pattern = KNIGHT,
): { npc: T | undefined; recenter: boolean; tol: number } {
    const candidates = npcs.filter(
        n =>
            pattern.test(n.name) &&
            !avoid?.has(n.index) &&
            Math.max(Math.abs(n.x - KNIGHT_SPOT.x), Math.abs(n.z - KNIGHT_SPOT.z)) <= RANGE &&
            n.optionsWithIndex.some(o => /^pickpocket$/i.test(o.text)) &&
            (!p || Math.max(Math.abs(n.x - p.worldX), Math.abs(n.z - p.worldZ)) <= RANGE),
    );
    const npc = candidates.filter(n => n.reachable !== false).sort((a, b) => a.distance - b.distance)[0];
    const away = p ? Math.max(Math.abs(KNIGHT_SPOT.x - p.worldX), Math.abs(KNIGHT_SPOT.z - p.worldZ)) : 0;
    if (!npc && away > 0 && away <= 3 && candidates.length > 0) return { npc, recenter: true, tol: 0 };
    return { npc, recenter: !npc && away > 3, tol: 3 };
}

export async function farmWalk(s: Session, t: Tile, tol: number, stop: () => boolean = () => false) {
    if (stop()) throw Error('no farm route progress: stopped');
    const p = s.sdk.getState()?.player;
    if (p?.level === 0 && p.worldX >= 2662 && p.worldX <= 2672 && p.worldZ >= 3315 && p.worldZ <= 3325) {
        const exit = s.sdk.getState()?.nearbyLocs.find(l => l.x === 2669 && l.z === 3316 && l.name === 'Door' && l.optionsWithIndex.some(o => o.text === 'Open'));
        if (exit) {
            if (!(await s.bot.interactLoc(exit, 'Open')).success) throw Error('no farm route progress: room exit refused');
            if (!(await waitUntil(s, () => !s.sdk.getState()?.nearbyLocs.some(l => l.x === exit.x && l.z === exit.z && l.id === exit.id && l.optionsWithIndex.some(o => o.text === 'Open')), { timeoutTicks: 8 }))) {
                throw Error('no farm route progress: room exit unconfirmed');
            }
        }
    }
    const result = await walkPath(await sessionWalker(s), [{ ...t, tol }], { maxTicks: 180, stop });
    if (!result.ok) throw Error(`no farm route progress: ${result.detail}`);
    return result;
}

export async function farmEatReceipt(d: {
    itemId: number;
    count: () => number;
    hp: () => number;
    tick: () => number;
    eat: () => Promise<{ success: boolean }>;
    wait: () => Promise<unknown>;
    log: (line: string) => void;
}): Promise<boolean> {
    const before = d.count();
    const hpBefore = d.hp();
    const tickBefore = d.tick();
    let sdkSuccess = false;
    let error: string | undefined;
    try {
        sdkSuccess = (await d.eat()).success;
    } catch {
        error = 'dispatch-or-observation-failed';
    }
    if (d.count() === before) {
        try {
            await d.wait();
        } catch {
            error ??= 'observation-timeout';
        }
    }
    const after = d.count();
    const consumed = before - after;
    const confirmed = before > 0 && consumed === 1;
    d.log(
        'EAT_RECEIPT ' +
            JSON.stringify({
                itemId: d.itemId,
                before,
                after,
                consumed,
                confirmed,
                sdkSuccess,
                hpBefore,
                hpAfter: d.hp(),
                tickBefore,
                tickAfter: d.tick(),
                ...(error ? { error } : {}),
            }),
    );
    return confirmed;
}

export async function farmFinishCheckpoint(d: { ok: boolean; died: () => boolean; coins: () => number; bank: () => Promise<void> }): Promise<void> {
    if (!d.ok || d.died()) return;
    await d.bank();
    if (d.died() || d.coins() !== 0) throw Error(`no goldfarm progress: final coin deposit unobserved died=${d.died()}`);
}

export async function farmErrorCheckpoint(error: unknown, supported: () => boolean, bank: () => Promise<void>) {
    const reason = String(error);
    if (!supported()) return { reason, recovery: 'unsupported' };
    try {
        await bank();
        return { reason, recovery: 'banked' };
    } catch (recoveryError) {
        return { reason, recovery: `failed: ${String(recoveryError)}` };
    }
}

type FarmSettlement = { tick: number; coins: number; xp: number; busy: boolean; inFlight: boolean; available: boolean };

export function farmPickCancellation(
    s: Pick<Session, 'sdk' | 'direct'>,
    planner: () => Promise<{ plan: (level: number, from: Tile, to: Tile) => Tile[] }>,
) {
    let target: Tile | undefined;
    let sent = false;
    let confirmed = false;
    return async (): Promise<boolean> => {
        const p = s.sdk.getState()?.player;
        if (!p || p.level !== 0) return false;
        if (confirmed) return true;
        if (sent && target && p.worldX === target.x && p.worldZ === target.z) {
            confirmed = true;
            return true;
        }
        if (!target) {
            const from = { x: p.worldX, z: p.worldZ };
            const route = await planner();
            for (const [dx, dz] of [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
            ]) {
                const to = { x: from.x + dx!, z: from.z + dz! };
                if (Math.max(Math.abs(to.x - KNIGHT_SPOT.x), Math.abs(to.z - KNIGHT_SPOT.z)) > ARDOUGNE_RADIUS) continue;
                const path = route.plan(p.level, from, to);
                if (path.length === 1 && path[0]!.x === to.x && path[0]!.z === to.z) {
                    target = to;
                    break;
                }
            }
        }
        if (!target) return false;
        const reply = (await s.direct({ type: 'walkTo', x: target.x, z: target.z, running: false, reason: 'SDK' })) as { success?: boolean };
        sent ||= reply?.success === true;
        return false;
    };
}

export async function farmSettlePicks(d: {
    read: () => FarmSettlement;
    cancel: () => Promise<boolean>;
    wait: () => Promise<boolean>;
}): Promise<FarmSettlement & { exact: boolean }> {
    let previous = d.read();
    let quiet = 0;
    const started = previous.tick;
    try {
        for (let elapsed = 0; elapsed < 32; elapsed++) {
            if (!previous.available) break;
            const cancelled = await d.cancel();
            if (!(await d.wait())) break;
            const current = d.read();
            if (current.tick <= previous.tick || current.tick - started > 32 || !current.available) {
                previous = current;
                break;
            }
            quiet =
                current.tick === previous.tick + 1 &&
                cancelled &&
                !previous.busy &&
                !previous.inFlight &&
                !current.busy &&
                !current.inFlight &&
                Number.isSafeInteger(current.coins) &&
                Number.isFinite(current.xp) &&
                current.coins === previous.coins &&
                current.xp === previous.xp
                    ? quiet + 1
                    : 0;
            previous = current;
            if (quiet >= 10) return { ...current, exact: true };
        }
    } catch {}
    return { ...previous, exact: false };
}

export const FOOD_NAMES: readonly RegExp[] = [
    /^chocolate slice$/i,
    /^cooked (meat|chicken)$/i,
    /^(slice of cake|2\/3 cake|cake)$/i,
    /^bread$/i,
    /^trout$/i,
    /^salmon$/i,
    /^lobster$/i,
    /^shark$/i,
];
export const WITHDRAW_FOOD = [/^trout$/i, /^salmon$/i, /^lobster$/i, /^bread$/i, /^(slice of cake|2\/3 cake|cake)$/i, /^shark$/i];
export const isFoodItem = (i: any) => FOOD_NAMES.some(re => re.test(i.name)) && (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text));
export const healOf = (item: any): number => questFoodDefinitions().get(item.id)?.heal ?? Infinity;

export function selectFoodToEat(items: readonly any[], loss: number): any | undefined {
    const foodList = items.filter(isFoodItem);
    if (foodList.length === 0) return undefined;
    foodList.sort((a, b) => healOf(a) - healOf(b));
    const exactOrUnder = [...foodList].reverse().find(i => healOf(i) <= loss);
    return exactOrUnder ?? foodList[0];
}

export const calcEatAt = (maxHp: number): number => (maxHp <= 10 ? 4 : Math.max(4, Math.min(maxHp - 6, Math.floor(maxHp * 0.4))));
export const ARDOUGNE_RADIUS = 40;

export function farmStartProblem(p: { worldX: number; worldZ: number; level: number } | null | undefined, thieving: number): string | null {
    if (!p) return 'no goldfarm progress: position unknown';
    if (p.level !== 0 || [BANK_SPOT, KNIGHT_SPOT].every(spot => Math.max(Math.abs(p.worldX - spot.x), Math.abs(p.worldZ - spot.z)) > ARDOUGNE_RADIUS)) {
        return `no goldfarm progress: start in Ardougne market, not ${p.worldX},${p.worldZ},${p.level}`;
    }
    if (thieving < 55) return `no goldfarm progress: Thieving ${thieving} is below 55 for the knights`;
    return null;
}

export async function replenishFarmFood(refill: () => Promise<void>, food: () => number, receive: () => Promise<void>): Promise<void> {
    await refill();
    if (food() < 2) await receive();
}

export const IDLE_LIMIT = 300;
export function foodWaitLimit(courier: string, status: any, now: number, service?: any): number {
    if (!courier) return 0;
    const active =
        courier &&
        typeof status?.name === 'string' &&
        status.name.toLowerCase() === courier.toLowerCase() &&
        status.server === 'rs-sdk-demo.fly.dev' &&
        status.role === 'courier' &&
        !status.result &&
        Number.isFinite(status.at) &&
        now - status.at >= 0 &&
        now - status.at < 30_000;
    const scheduled =
        courier &&
        Number.isFinite(service?.at) &&
        now - service.at >= 0 &&
        now - service.at < 30_000 &&
        Array.isArray(service.jobs) &&
        service.jobs.some(
            (j: any) =>
                typeof j?.account === 'string' &&
                j.account.toLowerCase() === courier.toLowerCase() &&
                j.script === 'scripts/aio-logistics.ts' && j.args?.[0] === 'food-courier' &&
                j.enabled === true &&
                typeof j.state === 'string' &&
                /^(running|starting|waiting[: ])/.test(j.state),
        );
    return active || scheduled ? 1500 : IDLE_LIMIT;
}

type FarmProgress = { picks: number; fails: number; food: number };
export function farmProgressTick(last: number, tick: number, before: FarmProgress, after: FarmProgress): number {
    const successes = (p: FarmProgress) => p.picks - p.fails;
    return successes(after) > successes(before) || after.food > before.food ? tick : last;
}

export const COURIER_COOLDOWN = 60;
export const COURIER_WANT_BELOW = 8;
export function courierCheckDue(tick: number, lastCheck: number, courier: string, players: readonly { name?: string }[]): boolean {
    if (!courier || tick - lastCheck < COURIER_COOLDOWN) return false;
    return players.some(p => typeof p?.name === 'string' && p.name.toLowerCase() === courier.toLowerCase());
}

class GoldfarmEnd extends Error {
    constructor(readonly ok: boolean, readonly detail: string, readonly summary?: Record<string, unknown>) {
        super(detail);
    }
}

export async function runGoldfarmKnights(s: Session, cfg: NormalizedGatherConfig, stop: () => boolean): Promise<GatherOutcome> {
    const spotArg = cfg.spot ?? resolveSetting(cfg, 'KNIGHT_SPOT') ?? '';
    const spotMatch = spotArg.match(/^(\d+),(\d+)$/);
    const knightSpot: Tile = spotMatch ? { x: Number(spotMatch[1]), z: Number(spotMatch[2]) } : { x: 2653, z: 3302 };
    const refugeArg = resolveSetting(cfg, 'KNIGHT_REFUGE') ?? '2582,3297';
    const refugeMatch = refugeArg.match(/^(\d+),(\d+)$/);
    const knightRefuge: Tile | null = refugeMatch ? { x: Number(refugeMatch[1]), z: Number(refugeMatch[2]) } : null;
    const FOOD_ONLY_TRADE = resolveSetting(cfg, 'FOOD_ONLY_TRADE') === '1';
    const TICKS = cfg.target?.capTicks ?? Number(resolveSetting(cfg, 'TICKS') ?? resolveSetting(cfg, 'CAP') ?? 9000);
    const BANK_AT = Number(resolveSetting(cfg, 'BANK_AT') ?? 25000);
    const FOOD_FROM = resolveSetting(cfg, 'FOOD_FROM')?.trim() || '';
    const STALL_FILL = Number(resolveSetting(cfg, 'STALL_FILL') ?? 10);
    const STALL_SIGHT = resolveSetting(cfg, 'STALL_SIGHT') !== '0';
    const PICK_TICKS = Number(resolveSetting(cfg, 'PICK_TICKS') ?? 2);
    const foodWake = resolveSetting(cfg, 'CURIER_FOOD_WAKE') === '1';
    const farmServer = FOOD_FROM ? serverFromEnv(readFileSync(resolveBotEnvPath(s.name, ROOT), 'utf8')) : '';

    console.log(`KNIGHT_SPOT ${knightSpot.x},${knightSpot.z}`);
    await waitTicks(s, 5);
    const p0 = s.sdk.getState()?.player;
    if (!p0 || p0.level !== 0 || Math.max(Math.abs(p0.worldX - 2655), Math.abs(p0.worldZ - 3300)) > 60) {
        const there = await defaultWalkTargetPersist(s, { x: 2654, z: 3283, level: 0 }, 4, cfg.deps);
        if (!there.ok) throw Error(`travel to Ardougne from ${p0?.worldX},${p0?.worldZ},${p0?.level ?? 0} failed: ${there.reason} ${there.detail}`);
    }
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const maxHp = () => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    const inv = () => st()?.inventory ?? [];
    const edible = (i: any) => BIG_FOOD.test(i.name) && (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text));
    const bigFood = () => inv().filter(edible).reduce((n, i) => n + i.count, 0);
    const isFood = (i: any) => FOOD_ORDER.some(re => re.test(i.name)) && (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text));
    const food = () => inv().filter(isFood).reduce((n, i) => n + i.count, 0);
    const notes = () => inv().filter(i => BIG_FOOD.test(i.name) && !edible(i));
    const coins = () => inv().filter(i => COINS_RE.test(i.name)).reduce((n, i) => n + i.count, 0);
    const cheb = (a: Tile, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const eatAt = () => Math.max(2 * DMG, maxHp() - 12);
    const frail = () => maxHp() < FRAIL_HP;
    const reserve = () => foodReserve(maxHp());
    let stallRestUntil = 0;
    let stallFled = false;
    const t0 = s.tick();
    const now = () => s.tick() - t0;
    const coins0 = coins();
    const stopFile = `.practice/stop-${s.name}`;

    let picks = 0;
    let noops = 0;
    let fails = 0;
    let eaten = 0;
    let bankTrips = 0;
    let bankTicks = 0;
    let walkTicks = 0;
    let idleTicks = 0;
    let eatTicks = 0;
    let banked = 0;
    let bankFails = 0;
    let emptyTrips = 0;
    let stallTrips = 0;
    let stallTicks = 0;
    let stolen = 0;
    let refused = 0;
    let stallEmptyTrips = 0;
    let stallPickTicks = 0;
    let stallOwnerWaits = 0;
    const banned = new Map<number, number>();
    let noopRun = 0;
    let noopTarget = -1;
    let bans = 0;
    let stunUntil = 0;
    const idleWhy = { none: 0, far: 0, unreachable: 0, banned: 0, avoided: 0, option: 0, hp: 0, stall: 0 };
    let noopStun = 0;
    let noopFar = 0;
    let noopNear = 0;
    let knightPasses = 0;
    let knightsSeen = 0;
    let spot = knightSpot;
    let refugeAt = -1;
    const refugeWindow = { ticks: 0, none: 0 };
    let shopTrips = 0;
    let shopTicks = 0;
    let bought = 0;
    let shopRetryAt = 0;
    let lastSteal = -1_000_000;
    const stealFile = join(ROOT, '.practice', 'goldfarm', `steal-${s.name}.json`);
    let lastStealAt = 0;
    try {
        lastStealAt = JSON.parse(readFileSync(stealFile, 'utf8')).at ?? 0;
    } catch {}
    const saveSteal = () => {
        lastStealAt = Date.now();
        try {
            mkdirSync(dirname(stealFile), { recursive: true });
            writeFileSync(stealFile, JSON.stringify({ at: lastStealAt }));
        } catch {}
    };
    let hpMin = hp();
    let died = false;
    let bankEmpty = false;
    let warned = false;
    let lastFail = '';
    let ended = '';
    void s.ended.then(e => {
        ended = e.reason || 'ended';
    });
    const life0 = (({ isDead, respawnCount, lifeId }: any = {}) => ({ isDead, respawnCount, lifeId }))(s.sdk.getState()?.player);
    const off = s.onTick(() => {
        hpMin = Math.min(hpMin, hp());
        if (sessionDied(life0, s.sdk.getState()?.player)) died = true;
    });

    let lastTradeOk = true;
    let tradeTicks = 0;
    let tradesIn = 0;
    let lastCourierAttempt = -120;

    const end = (ok: boolean, why: string): never => {
        const ticks = now();
        const gained = banked + coins() - coins0;
        const p = pos();
        const detail =
            `ticks=${ticks} picks=${picks} fails=${fails} noops=${noops} bans=${bans} coinsGained=${gained} coinsPerTick=${(gained / Math.max(1, ticks)).toFixed(2)} ` +
            `eaten=${eaten} bankTrips=${bankTrips} bankTicks=${bankTicks} walkTicks=${walkTicks} idleTicks=${idleTicks} eatTicks=${eatTicks} stallTrips=${stallTrips} stallTicks=${stallTicks} stallPickTicks=${stallPickTicks} stolen=${stolen} refused=${refused} stallOwnerWaits=${stallOwnerWaits} shopTrips=${shopTrips} shopTicks=${shopTicks} bought=${bought} ` +
            `foodTicksPct=${((100 * (bankTicks + stallTicks + shopTicks + eatTicks)) / Math.max(1, ticks)).toFixed(1)} ` +
            `hpMin=${hpMin} died=${died} banked=${banked} packCoins=${coins()} bigFood=${bigFood()} food=${food()} tradesIn=${tradesIn} tradeTicks=${tradeTicks} hp=${hp()} at=${p?.worldX},${p?.worldZ},${p?.level} ` +
            `idleNone=${idleWhy.none} idleFar=${idleWhy.far} idleUnreach=${idleWhy.unreachable} idleBanned=${idleWhy.banned} idleAvoid=${idleWhy.avoided} idleOption=${idleWhy.option} idleHp=${idleWhy.hp} idleStall=${idleWhy.stall} ` +
            `noopStun=${noopStun} noopFar=${noopFar} noopNear=${noopNear} knightsInView=${(knightsSeen / Math.max(1, knightPasses)).toFixed(2)} spot=${spot.x},${spot.z} refugeAt=${refugeAt}`;
        const finalLine = ok ? detail : `${why} ${detail} last=${lastFail}`;
        throw new GoldfarmEnd(ok, finalLine, { ticks, picks, fails, coinsGained: gained, banked, died, hpMin });
    };

    const eat = async (): Promise<boolean> => {
        const e0 = s.tick();
        const pick = pickFoodForLoss(inv().filter(isFood), maxHp() - hp());
        if (!pick) {
            lastFail = 'eat: no edible item';
            await waitTicks(s, 1);
            return false;
        }
        const r = await s.bot.eatFood(pick);
        eatTicks += s.tick() - e0;
        if (r.success) eaten++;
        else {
            lastFail = `eat:${r.message}`;
            if (s.tick() === e0) await waitTicks(s, 1);
        }
        return r.success;
    };

    const walk = async (t: Tile, tol: number) => {
        const w0 = s.tick();
        for (let i = 0; i < 3 && !died; i++) {
            const p = pos();
            if (p && p.level === 0 && cheb(t, p) <= tol + 1) break;
            if (p && p.level !== 0) {
                const routeRes = await defaultWalkTargetPersist(s, { x: t.x, z: t.z, level: 0 }, 4, cfg.deps);
                if (!routeRes.ok) lastFail = `walkRoute:${routeRes.reason ?? ''} ${routeRes.detail ?? ''}`.trim();
                continue;
            }
            const r = await s.bot.walkTo(t.x, t.z, tol);
            if (!r.success) lastFail = `walk:${r.message}`;
        }
        walkTicks += s.tick() - w0;
    };

    const refill = async () => {
        bankTrips++;
        await walk(BANK_SPOT, 2);
        const b0 = s.tick();
        try {
            const o = await s.bot.openBank();
            if (!o.success) {
                lastFail = `bank:${o.message}`;
                if (++bankFails >= 3) bankEmpty = true;
                return;
            }
            const c = coins();
            if (c > 0) {
                const d = await s.bot.depositItem(COINS_RE, -1);
                if (d.success) banked += d.amountDeposited ?? c;
                else lastFail = `deposit coins:${d.message}`;
            }
            for (const n of notes()) {
                const d = await s.bot.depositItem(n, -1);
                if (!d.success) lastFail = `deposit notes:${d.message}`;
            }
            if (28 - inv().length - KEEP_FREE <= 0) {
                await depositPack(s, i => /^coins$/i.test(i.name) || FOOD_ORDER.some(re => re.test(i.name)));
            }
            const food0 = inv().length;
            for (const re of BANK_FOOD_PATTERNS) {
                const inBank = s.sdk.findBankItem(re);
                const room = 28 - inv().length - KEEP_FREE;
                if (!inBank || inBank.count <= 0 || room <= 0) continue;
                const w = await s.bot.withdrawItem(inBank, Math.min(room, inBank.count));
                if (!w.success) lastFail = `withdraw:${w.message}`;
            }
            const left = BANK_FOOD_PATTERNS.reduce((n, re) => n + (s.sdk.findBankItem(re)?.count ?? 0), 0);
            bankEmpty = left === 0;
            const bankCoins = s.sdk.findBankItem(COINS_RE);
            if (bankEmpty && !FOOD_ONLY_TRADE && coins() < 300 && bankCoins && bankCoins.count > 0) {
                const n = Math.min(300 - coins(), bankCoins.count);
                const w = await s.bot.withdrawItem(bankCoins, n);
                if (w.success) banked -= w.amountWithdrawn ?? n;
            }
            console.log(`BANK trip=${bankTrips} banked=${banked} bigFood=${bigFood()} bankFood=${left} t=${now()}`);
            emptyTrips = c > 0 || inv().length > food0 ? 0 : emptyTrips + 1;
            if (emptyTrips >= 3) {
                end(
                    banked > 0,
                    `goldfarm no progress: ${emptyTrips} bank trips gained no coins or food; pack=${inv().length} bankFood=${left} ${lastFail}`,
                );
            }
            await s.bot.closeBank();
        } finally {
            bankTicks += s.tick() - b0;
        }
    };

    const foodByTrade = async (timeout = 180_000): Promise<boolean> => {
        console.log(`MILESTONE waiting for food trade from ${FOOD_FROM} t=${now()}`);
        await walk(BANK_SPOT, 2);
        const r = await receiveFoodAtBank(s, FOOD_FROM, timeout, refill, () => food() >= 2 || !bankEmpty, undefined, farmServer, cfg.deps?.receiveHandoff);
        tradeTicks += r.ticks;
        console.log(
            `TRADE ${r.reason} ${r.message} incomingFood=${r.incoming} notes=${notes().reduce((n, i) => n + i.count, 0)} bigFood=${bigFood()} t=${now()}`,
        );
        if (r.incoming > 0) tradesIn++;
        lastTradeOk = r.available;
        return lastTradeOk;
    };

    const onStun = async () => {
        if (food() > 0 && hp() <= eatAt()) {
            await eat();
            return;
        }
        await waitTicks(s, 1);
    };

    const steal = async (range = RANGE) => {
        const p = pos();
        const avoid = randomEventsOf(s)?.avoid().npcs;
        const away = (n: any) => (p ? Math.max(Math.abs(n.x - p.worldX), Math.abs(n.z - p.worldZ)) : 0);
        const knights = ((st()?.nearbyNpcs ?? []) as any[]).filter(n => KNIGHT.test(n.name));
        knightPasses++;
        knightsSeen += knights.length;
        const view = (n: any): KnightView => ({
            inRange: away(n) <= range,
            reachable: n.reachable !== false,
            banned: (banned.get(n.index) ?? 0) > s.tick(),
            avoided: !!avoid?.has(n.index),
        });
        const npc = knights
            .filter(n => {
                const v = view(n);
                return v.inRange && v.reachable && !v.banned && !v.avoided;
            })
            .sort((a, b) => a.distance - b.distance)[0];
        if (!npc) {
            if (range === RANGE && p && cheb(spot, p) > RANGE) await walk(spot, 3);
            else {
                const why = noKnightReason(knights.map(view));
                idleTicks++;
                idleWhy[why]++;
                if (range === RANGE && why === 'none') refugeWindow.none++;
                await waitTicks(s, 1);
            }
            return;
        }
        const op = npc.optionsWithIndex.find((o: any) => /pickpocket/i.test(o.text))?.opIndex;
        if (op === undefined) {
            idleTicks++;
            idleWhy.option++;
            await waitTicks(s, 1);
            return;
        }
        const hp0 = hp();
        const c0 = coins();
        const gap = away(npc);
        await s.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: op, reason: 'SDK' } as any);
        await waitTicks(s, PICK_TICKS);
        if (hp() < hp0) {
            picks++;
            fails++;
            noopRun = 0;
            stunUntil = s.tick() + 8;
            await onStun();
        } else if (coins() > c0) {
            picks++;
            noopRun = 0;
        } else if (s.tick() <= stunUntil) {
            noops++;
            noopStun++;
        } else {
            noops++;
            if (gap > 1) noopFar++;
            else noopNear++;
            noopRun = noopTarget === npc.index ? noopRun + 1 : 1;
            noopTarget = npc.index;
            if (noopRun >= 3) {
                banned.set(npc.index, s.tick() + 15);
                noopRun = 0;
                bans++;
            }
        }
    };

    const stallTrip = async () => {
        stallTrips++;
        const f0 = food();
        await walk(STALL_SPOT, 2);
        const s0 = s.tick();
        const badUntil = new Map<string, number>();
        const pick0 = stallPickTicks;
        const key = (t: Tile) => `${t.x},${t.z}`;
        const d = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
        let seen = hp();
        let picked = false;
        const watch = new Map<number, { recipe: StallRecipe; sight: StallSight } | null>();
        const watchOf = async (locId: number) => {
            if (!watch.has(locId)) {
                let found: { recipe: StallRecipe; sight: StallSight } | null = null;
                if (STALL_SIGHT) {
                    try {
                        const recipe = stallRecipes().find(r => r.loc === locId);
                        const sight = recipe && (await stallSight(s, recipe));
                        if (recipe && sight) found = { recipe, sight };
                    } catch (e) {
                        console.log(`WARN stall sight unavailable: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
                    }
                }
                watch.set(locId, found);
            }
            return watch.get(locId)!;
        };
        try {
            while (food() < STALL_FILL && 28 - inv().length > 0 && s.tick() - s0 < 400 && !died && now() < TICKS) {
                if (existsSync(stopFile) || stop()) return;
                const hurt = guardHit(seen, hp(), picked);
                seen = hp();
                picked = false;
                if (frail() && hurt) {
                    console.log(`STALL left: a guard hit, hp=${hp()} food=${food()} t=${now()}`);
                    if (hp() <= eatAt() && food() > 0) await eat();
                    stallRestUntil = s.tick() + STALL_REST;
                    stallFled = true;
                    break;
                }
                if (randomEventsOf(s)?.busy()) {
                    await waitTicks(s, 1);
                    continue;
                }
                if (hp() <= eatAt() && food() > 0) {
                    await eat();
                    continue;
                }
                const npcs = (st()?.nearbyNpcs ?? []) as any[];
                const guards = npcs.filter(n => GUARD.test(n.name)).map(n => ({ x: n.x, z: n.z }));
                const bakers = npcs.filter(n => BAKER.test(n.name)).map(n => ({ x: n.x, z: n.z }));
                const locs = (st()?.nearbyLocs ?? []) as any[];
                const blocked = new Set<string>();
                for (const l of locs) if (/stall/i.test(l.name)) for (const dx of [0, 1]) for (const dz of [0, 1]) blocked.add(key({ x: l.x + dx, z: l.z + dz }));
                const me = pos();
                if (!me) {
                    await waitTicks(s, 1);
                    continue;
                }
                const here = { x: me.worldX, z: me.worldZ };
                const opts: { tile: Tile; loc: any; score: number }[] = [];
                let ownerSees = 0;
                for (const l of locs) {
                    if (!STALL.test(l.name) || !(l.options ?? []).some((o: string) => /steal/i.test(o))) continue;
                    const o = { x: l.x, z: l.z };
                    const w = await watchOf(l.id);
                    const sides = [
                        { x: o.x - 1, z: o.z },
                        { x: o.x - 1, z: o.z + 1 },
                        { x: o.x + 2, z: o.z },
                        { x: o.x + 2, z: o.z + 1 },
                        { x: o.x, z: o.z - 1 },
                        { x: o.x + 1, z: o.z - 1 },
                        { x: o.x, z: o.z + 2 },
                        { x: o.x + 1, z: o.z + 2 },
                    ];
                    for (const t of sides) {
                        if (blocked.has(key(t)) || (badUntil.get(key(t)) ?? 0) > s.tick()) continue;
                        if (guards.some(g => d(g, t) <= GUARD_SAFE)) continue;
                        const sees = w ? ownerSeesTile(w.recipe, t, me.level ?? 0, npcs, w.sight) : null;
                        if (sees) {
                            ownerSees++;
                            continue;
                        }
                        const bakerD = Math.min(99, ...bakers.map(b => d(b, t)));
                        opts.push({ tile: t, loc: l, score: (sees === false || bakerD > 5 ? 0 : 100 - bakerD * 10) + d(t, here) });
                    }
                }
                if (opts.length === 0 && ownerSees > 0) stallOwnerWaits++;
                if (opts.length === 0) {
                    const k = npcs.some(n => KNIGHT.test(n.name) && d({ x: n.x, z: n.z }, here) <= 6);
                    if (k && hp() > 2 * DMG && !(frail() && food() < FRAIL_FLOOR)) {
                        const k0 = s.tick();
                        picked = true;
                        await steal(6);
                        stallPickTicks += s.tick() - k0;
                    } else {
                        idleTicks++;
                        idleWhy.stall++;
                        await waitTicks(s, 1);
                    }
                    continue;
                }
                opts.sort((a, b) => a.score - b.score);
                const best = opts[0]!;
                if (d(best.tile, here) > 0) {
                    await s.bot.walkTo(best.tile.x, best.tile.z, 0, { timeout: 8000 });
                    const p = pos();
                    if (!p || p.worldX !== best.tile.x || p.worldZ !== best.tile.z) badUntil.set(key(best.tile), s.tick() + 30);
                    continue;
                }
                const op = best.loc.optionsWithIndex.find((o: any) => /steal/i.test(o.text))?.opIndex ?? 2;
                const before = food();
                await s.direct({ type: 'interactLoc', x: best.loc.x, z: best.loc.z, locId: best.loc.id, optionIndex: op, reason: 'SDK' } as any);
                let got = false;
                for (let i = 0; i < 3 && !got; i++) {
                    await waitTicks(s, 1);
                    got = food() > before;
                }
                if (got) {
                    stolen++;
                    lastSteal = s.tick();
                    saveSteal();
                } else {
                    refused++;
                    badUntil.set(key(best.tile), s.tick() + 6);
                }
            }
        } finally {
            stallTicks += s.tick() - s0 - (stallPickTicks - pick0);
            if (food() <= f0) stallEmptyTrips++;
            else stallEmptyTrips = 0;
            console.log(`STALL trip=${stallTrips} food=${food()} stolen=${stolen} refused=${refused} t=${now()}`);
        }
    };

    const SHOP_FOOD = /^(bread|cake|chocolate slice)$/i;
    const shopOk = () =>
        (resolveSetting(cfg, 'SHOP') === '1' || resolveSetting(cfg, 'DEMO_OK') !== '1') &&
        Date.now() - lastStealAt > (1500 + 20) * 400 &&
        s.tick() - lastSteal > 1500 + 20 &&
        s.tick() >= shopRetryAt &&
        coins() >= 12;

    const shopTrip = async () => {
        shopTrips++;
        const before = food();
        await walk(STALL_SPOT, 3);
        const q0 = s.tick();
        try {
            const o = await s.bot.openShop(BAKER);
            if (!o.success) {
                lastFail = `shop:${o.message}`;
                shopRetryAt = s.tick() + 100;
                return;
            }
            let free = 28 - inv().length - 1;
            let money = coins();
            let sent = 0;
            for (const item of st()?.shop?.shopItems ?? []) {
                if (!SHOP_FOOD.test(item.name) || item.count <= 0) continue;
                const price = Math.max(1, item.buyPrice || 12);
                let n = Math.min(item.count, free, Math.floor(money / price));
                free -= n;
                money -= n * price;
                for (const chunk of [10, 5, 1]) {
                    while (n >= chunk) {
                        await s.direct({ type: 'shopBuy', slot: item.slot, amount: chunk, reason: 'SDK' } as any);
                        n -= chunk;
                        if (++sent % 5 === 0) await waitTicks(s, 1);
                    }
                }
                if (free <= 0) break;
            }
            await waitTicks(s, 1);
            await s.direct({ type: 'closeShop', reason: 'SDK' } as any);
            const got = food() - before;
            bought += Math.max(0, got);
            if (got < 2) shopRetryAt = s.tick() + 100;
        } finally {
            shopTicks += s.tick() - q0;
            console.log(`SHOP trip=${shopTrips} food=${food()} bought=${bought} t=${now()}`);
        }
    };

    try {
        console.log(
            `GOLDFARM ticks=${TICKS} pickTicks=${PICK_TICKS} eatAt=${eatAt()} maxHp=${maxHp()} bigFood=${bigFood()} notes=${notes().length} coins=${coins0} foodFrom=${FOOD_FROM || '-'}`,
        );
        if (bigFood() < 2 || notes().length > 0) {
            await refill();
            if (bigFood() === 0 && bankEmpty && FOOD_FROM) await foodByTrade();
        }
        let nextMark = 1000;
        while (now() < TICKS && !died && !ended && !stop()) {
            if (existsSync(stopFile)) end(false, 'stop file');
            if (now() >= nextMark) {
                console.log(
                    `MILESTONE t=${now()} banked=${banked} packCoins=${coins()} bigFood=${bigFood()} food=${food()} picks=${picks} fails=${fails} eaten=${eaten}`,
                );
                nextMark += 1000;
            }
            if (randomEventsOf(s)?.busy()) {
                idleTicks++;
                await waitTicks(s, 1);
                continue;
            }
            const l = food();
            const low = l < reserve();
            if (hp() <= eatAt() && l > 0) {
                if (!(await eat())) await waitTicks(s, 1);
                continue;
            }
            if (foodWake && /^[A-Za-z0-9_ -]{1,12}$/.test(FOOD_FROM) && (l >= 2 || !bankEmpty)) {
                let courier: any;
                try {
                    courier = JSON.parse(readFileSync(join(ROOT, '.practice/status', `${FOOD_FROM}.json`), 'utf8'));
                } catch {}
                if (courierFoodReady(courier, FOOD_FROM, farmServer, ownedAccounts(farmServer), Date.now(), s.tick(), lastCourierAttempt)) {
                    lastCourierAttempt = s.tick();
                    await foodByTrade(20_000);
                    await walk(spot, 3);
                    continue;
                }
            }
            if ((bigFood() < 2 && low && !bankEmpty) || coins() >= BANK_AT || notes().length > 0) {
                await refill();
                await walk(spot, 3);
                continue;
            }
            if (l < FRAIL_FLOOR && bankEmpty && (FOOD_ONLY_TRADE || frail())) {
                if (FOOD_FROM && lastTradeOk && (await foodByTrade())) {
                    await walk(spot, 3);
                    continue;
                }
                end(false, FOOD_ONLY_TRADE ? 'no food (FOOD_ONLY_TRADE)' : `no food (frail: ${maxHp()} Hitpoints)`);
            }
            if (foodTripDue({ low, bankEmpty, tradeOnly: FOOD_ONLY_TRADE, rested: s.tick() >= stallRestUntil, shopOk: shopOk(), emptyTrips: stallEmptyTrips })) {
                if (shopOk()) await shopTrip();
                if (food() < reserve() && stallEmptyTrips < 3) await stallTrip();
                await walk(stallFled ? BANK_SPOT : spot, 3);
                stallFled = false;
                continue;
            }
            if (l === 0) {
                if (!warned) {
                    console.log('WARN no food in the pack, the bank or the stall; picking on while HP > 6');
                    warned = true;
                }
                if (hp() <= 6) end(false, 'no food');
            }
            if (hp() <= DMG) {
                idleTicks++;
                idleWhy.hp++;
                await waitTicks(s, 1);
                continue;
            }
            const k0 = s.tick();
            await steal();
            refugeWindow.ticks += s.tick() - k0;
            if (knightRefuge && refugeDue({ ...refugeWindow, moved: refugeAt >= 0, atRefuge: cheb(knightRefuge, { worldX: spot.x, worldZ: spot.z }) <= RANGE })) {
                console.log(
                    `REFUGE no knight in view on ${refugeWindow.none} of ${refugeWindow.ticks} ticks at ${spot.x},${spot.z}: moving to ${knightRefuge.x},${knightRefuge.z} t=${now()}`,
                );
                spot = knightRefuge;
                refugeAt = now();
                await walk(spot, 3);
            }
            if (refugeWindow.ticks >= REFUGE_WINDOW) {
                refugeWindow.ticks = 0;
                refugeWindow.none = 0;
            }
        }
        return end(!died && !ended && !stop(), died ? 'died' : ended ? `session ended: ${ended}` : stop() ? 'stopped' : 'ticks');
    } catch (e) {
        if (e instanceof GoldfarmEnd) {
            return {
                ok: e.ok,
                kind: e.ok ? 'completed' : 'failed',
                detail: e.detail,
                delta: { coins: banked + coins() - coins0, elapsedTicks: now() },
                recoverable: !e.ok,
                summary: e.summary,
                resultLine: e.detail,
            };
        }
        throw e;
    } finally {
        off();
    }
}

export async function runGoldfarmStableSession(
    s: Session,
    cfg: NormalizedGatherConfig,
    stop: () => boolean,
): Promise<GatherOutcome & { formatFinish?: (finalOk: boolean) => string }> {
    const TICKS = cfg.target?.capTicks ?? Number(resolveSetting(cfg, 'TICKS') ?? resolveSetting(cfg, 'CAP') ?? 9000);
    const BANK_AT = Number(resolveSetting(cfg, 'BANK_AT') ?? 25000);
    const FOOD_FROM = resolveSetting(cfg, 'FOOD_FROM')?.trim() || '';
    const FUND_COURIER = resolveSetting(cfg, 'FUND_COURIER')?.trim() || '';
    const farmServer = serverFromEnv(readFileSync(resolveBotEnvPath(s.name, ROOT), 'utf8'));

    if (!(await waitUntil(s, () => !!s.sdk.getState()?.player && (s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0) > 0, { timeoutTicks: 40 }))) {
        throw Error('no goldfarm progress: entry state deadline');
    }
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const maxHp = () => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    const inv = () => st()?.inventory ?? [];
    const foodItems = () => inv().filter(isFoodItem);
    const foodCount = () => foodItems().reduce((n, i) => n + i.count, 0);
    const notes = () => inv().filter(i => FOOD_NAMES.some(re => re.test(i.name)) && !isFoodItem(i));
    const coins = () => inv().filter(i => COINS_RE.test(i.name)).reduce((n, i) => n + i.count, 0);
    const cheb = (a: Tile, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const eatAt = () => calcEatAt(maxHp());
    const t0 = s.tick();
    const now = () => s.tick() - t0;
    const coins0 = coins();
    const stopFile = `.practice/stop-${s.name}`;

    const eatenById: Record<number, number> = {};
    let picks = 0;
    let unsettledChecks = 0;
    let fails = 0;
    let eaten = 0;
    let bankTrips = 0;
    let bankTicks = 0;
    let walkTicks = 0;
    let idleTicks = 0;
    let eatTicks = 0;
    let banked = 0;
    let bankFails = 0;
    let knownBankFood: number | undefined;
    let lastProactiveTrade = -120;
    let hpMin = hp();
    let died = false;
    let bankEmpty = false;
    let lastFail = '';
    let lastPickTick = s.tick();
    let lastCourierCheck = -100_000;
    let progress = { picks, fails, food: foodCount() };
    const life0 = (({ isDead, respawnCount, lifeId }: any = {}) => ({ isDead, respawnCount, lifeId }))(s.sdk.getState()?.player);
    const off = s.onTick(() => {
        const next = { picks, fails, food: foodCount() };
        lastPickTick = farmProgressTick(lastPickTick, s.tick(), progress, next);
        progress = next;
        hpMin = Math.min(hpMin, hp());
        if (sessionDied(life0, s.sdk.getState()?.player)) died = true;
    });

    let stoppingPicks = false;
    let pickInFlight = false;
    const tail: unknown[] = [];
    const trace = (event: string) => {
        const p = pos();
        const row = {
            event,
            tick: s.tick(),
            coins: coins(),
            xp: s.sdk.getSkill('Thieving')?.experience,
            hp: hp(),
            anim: p?.animId,
            spotanim: p?.spotanimId,
            x: p?.worldX,
            z: p?.worldZ,
            pickInFlight,
        };
        tail.push(row);
        if (tail.length > 24) tail.shift();
        return row;
    };

    const eat = async (): Promise<boolean> => {
        const e0 = s.tick();
        const loss = maxHp() - hp();
        const pick = selectFoodToEat(inv(), loss);
        if (!pick) {
            lastFail = 'eat: no food in inventory';
            await waitTicks(s, 1);
            return false;
        }
        const count = () => inv().filter(i => i.id === pick.id).reduce((sum, i) => sum + i.count, 0);
        const before = count();
        const consumed = await farmEatReceipt({
            itemId: pick.id,
            count,
            hp,
            tick: () => s.tick(),
            eat: () => s.bot.eatFood(pick),
            wait: () => s.sdk.waitForCondition(st => st.inventory.filter(i => i.id === pick.id).reduce((sum, i) => sum + i.count, 0) < before, 2000),
            log: line => console.log(line),
        });
        eatTicks += s.tick() - e0;
        if (consumed) {
            eaten++;
            eatenById[pick.id] = (eatenById[pick.id] ?? 0) + 1;
        } else {
            lastFail = 'eat: consumption unconfirmed';
            if (s.tick() === e0) await waitTicks(s, 1);
        }
        return consumed;
    };

    const walk = async (t: Tile, tol: number) => {
        trace(`walk:${t.x},${t.z}`);
        const w0 = s.tick();
        try {
            await farmWalk(s, t, tol, () => died);
        } finally {
            walkTicks += s.tick() - w0;
        }
    };

    const refill = async (bankOnly = false) => {
        bankTrips++;
        await walk(BANK_SPOT, 2);
        const b0 = s.tick();
        try {
            const o = await s.bot.openBank();
            if (!o.success) {
                lastFail = `bank:${o.message}`;
                if (bankOnly) throw Error(`no recovery bank progress: ${o.message}`);
                if (++bankFails >= 3) bankEmpty = true;
                return;
            }
            bankFails = 0;
            const c = coins();
            if (c > 0) {
                const item = inv().find(i => COINS_RE.test(i.name));
                if (!item) throw Error('no deposit progress: coins missing');
                banked += await depositObserved(s, item);
            }
            if (bankOnly) {
                await s.bot.closeBank();
                return;
            }
            for (const n of notes()) await depositObserved(s, n);
            const junk = inv().filter(i => !COINS_RE.test(i.name) && !isFoodItem(i) && !notes().some(n => n.slot === i.slot));
            for (const item of [...new Set(junk.map(i => i.name as string))]) {
                const d = await s.bot.depositItem(new RegExp(`^${item}$`, 'i'), -1);
                if (d.success) console.log(`BANKED unneeded item: ${item}`);
            }
            for (const re of WITHDRAW_FOOD) {
                const inBank = s.sdk.findBankItem(re);
                const room = 28 - inv().length - KEEP_FREE;
                if (!inBank || inBank.count <= 0 || room <= 0) continue;
                const w = await s.bot.withdrawItem(inBank, Math.min(room, inBank.count));
                if (!w.success) lastFail = `withdraw:${w.message}`;
            }
            const totalBankFood = WITHDRAW_FOOD.reduce((n, re) => n + (s.sdk.findBankItem(re)?.count ?? 0), 0);
            knownBankFood = totalBankFood;
            bankEmpty = totalBankFood === 0;
            console.log(`BANK trip=${bankTrips} banked=${banked} food=${foodCount()} bankFood=${totalBankFood} coins=${coins()} t=${now()}`);
            await s.bot.closeBank();
        } finally {
            bankTicks += s.tick() - b0;
        }
    };

    const quickCourierCheck = async () => {
        if (!FOOD_FROM) return;
        const courierNpc = (st()?.nearbyPlayers ?? []).find((p: any) => new RegExp(`^${FOOD_FROM}$`, 'i').test(p.name));
        if (!courierNpc) return;
        console.log(`COURIER trade check from ${FOOD_FROM} t=${now()}`);
        const re = new RegExp(`^${FOOD_FROM}$`, 'i');
        const inView = () => (st()?.nearbyPlayers ?? []).some((p: any) => re.test(p.name));
        await refill();
        if (!cfg.deps?.receiveHandoff) throw Error('goldfarm courier check requires deps.receiveHandoff');
        const r = await cfg.deps.receiveHandoff(s, FOOD_FROM, farmServer, () =>
            s.bot.serveTrades({ from: re, maxTrades: 1, timeout: 45_000, until: () => !inView() || existsSync(stopFile) || stop() }),
        );
        lastProactiveTrade = s.tick();
        lastCourierCheck = s.tick();
        const got = r.trades.some(t => t.success);
        console.log(`COURIER ${got ? 'received' : 'no trade'} food=${foodCount()} notes=${notes().length} t=${now()}`);
        if (got) await refill();
    };

    const replenishFood = () => replenishFarmFood(refill, foodCount, quickCourierCheck);
    const onStun = async () => {
        if (foodCount() > 0 && hp() <= eatAt()) {
            await eat();
            return;
        }
        await waitTicks(s, 1);
    };

    const steal = async () => {
        if (stoppingPicks) return;
        if (hp() <= DMG) {
            if (foodCount() > 0) {
                await eat();
                return;
            }
            await replenishFood();
            if (foodCount() === 0) await walk(BANK_SPOT, 2);
            return;
        }
        const p = pos();
        const avoid = randomEventsOf(s)?.avoid().npcs;
        const thiev = s.sdk.getSkill('Thieving')?.level ?? 1;
        const targetPattern = thiev >= 55 ? KNIGHT : /^(man|woman)$/i;
        const { npc, recenter, tol } = farmPickTarget(st()?.nearbyNpcs ?? [], p, avoid, targetPattern);
        if (!npc) {
            if (recenter) await walk(KNIGHT_SPOT, tol);
            else {
                idleTicks++;
                await waitTicks(s, 1);
            }
            return;
        }
        const op = npc.optionsWithIndex.find((o: any) => /pickpocket/i.test(o.text))?.opIndex;
        if (op === undefined) {
            idleTicks++;
            await waitTicks(s, 1);
            return;
        }
        const hp0 = hp();
        const c0 = coins();
        if (stoppingPicks) return;
        pickInFlight = true;
        trace('pick-dispatch');
        try {
            await s.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: op, reason: 'SDK' } as any);
            await waitTicks(s, 2);
            if (hp() < hp0) {
                picks++;
                fails++;
                await onStun();
            } else if (coins() > c0) {
                picks++;
                lastPickTick = s.tick();
            } else {
                unsettledChecks++;
            }
        } finally {
            pickInFlight = false;
            trace(hp() < hp0 ? 'pick-stun' : 'pick-observed');
        }
    };

    const finalize = async (ok: boolean, why: string, thrown = false) => {
        stoppingPicks = true;
        trace('end');
        let recovery = 'not-needed';
        try {
            await farmFinishCheckpoint({ ok, died: () => died, coins, bank: () => refill() });
        } catch (error) {
            ok = false;
            why = String(error);
            thrown = true;
        }
        if (thrown) {
            ok = false;
            const outcome = await farmErrorCheckpoint(
                why,
                () => !died && hp() > 0 && !existsSync(stopFile) && farmStartProblem(pos(), s.sdk.getSkill('Thieving')?.baseLevel ?? 0) === null,
                async () => {
                    const p = pos();
                    if (p && cheb(BANK_SPOT, p) > 4) await walk(KNIGHT_SPOT, 0);
                    await refill(true);
                    if (coins() !== 0) throw Error('recovery coin deposit unobserved');
                },
            );
            recovery = outcome.recovery;
        }
        trace('recovery-complete');
        console.log('GOLDFARM_TAIL ' + JSON.stringify(tail));
        const cancelPick = farmPickCancellation(s, () => sessionWalker(s));
        const settlement = await farmSettlePicks({
            read: () => {
                const p = pos();
                const xp = s.sdk.getSkill('Thieving')?.experience;
                return {
                    tick: s.tick(),
                    coins: coins(),
                    xp: xp ?? NaN,
                    inFlight: pickInFlight,
                    busy: !p || p.animId !== -1 || p.spotanimId !== -1,
                    available: st()?.inGame === true && !!p && !died && hp() > 0,
                };
            },
            cancel: cancelPick,
            wait: async () => {
                const before = s.tick();
                const fresh = await waitUntil(s, () => s.tick() > before, { timeoutTicks: 1 });
                console.log('GOLDFARM_SETTLE ' + JSON.stringify(trace('settle')));
                return fresh;
            },
        });
        if (!settlement.exact && ok) {
            ok = false;
            why = 'pick settlement unconfirmed';
        }
        if (ok && coins() !== 0) {
            ok = false;
            why = 'final coin deposit unobserved after settlement';
        }
        const packCoins = coins();
        const gained = banked + packCoins - coins0;
        const formatFinish = (finalOk: boolean) => {
            off();
            const ticks = now();
            const p = pos();
            const detail =
                `ticks=${ticks} picks=${picks} fails=${fails} unsettledChecks=${unsettledChecks} coinsGained=${settlement.exact ? gained : 'unknown'} coinsPerTick=${
                    settlement.exact ? (gained / Math.max(1, ticks)).toFixed(2) : 'unknown'
                } ` +
                `eaten=${eaten} bankTrips=${bankTrips} bankTicks=${bankTicks} walkTicks=${walkTicks} idleTicks=${idleTicks} eatTicks=${eatTicks} ` +
                `stallTrips=0 stallTicks=0 stolen=0 refused=0 shopTrips=0 shopTicks=0 bought=0 ` +
                `hpMin=${hpMin} died=${died} banked=${banked} packCoins=${packCoins} coinsExact=${settlement.exact} food=${foodCount()} hp=${hp()} at=${p?.worldX},${p?.worldZ},${p?.level} recovery=${recovery}`;
            console.log(
                'GOLDFARM_RESULT ' +
                    JSON.stringify({
                        ok: finalOk,
                        reason: ok && !finalOk ? 'logout or session close failed' : ok ? '' : why,
                        ticks,
                        picks,
                        fails,
                        coinsGained: settlement.exact ? gained : null,
                        banked,
                        packCoins,
                        coinsExact: settlement.exact,
                        coinsGainedObserved: gained,
                        coins0,
                        newBankedCoins: Math.max(0, banked - coins0),
                        recovery,
                        unbankedCoins: packCoins,
                        eaten,
                        eatenById,
                        food: foodCount(),
                        idleTicks,
                        bankTrips,
                        hpMin,
                        hp: hp(),
                        died,
                        randomEvents: resolveSetting(cfg, 'RANDOM_EVENTS') !== '0',
                        at: p ? { x: p.worldX, z: p.worldZ, level: p.level } : null,
                    }),
            );
            return ok ? detail : `${why} ${detail} last=${lastFail}`;
        };
        const resultDetail = `${ok ? '' : why + ' '}ticks=${now()} picks=${picks} fails=${fails} coinsGained=${settlement.exact ? gained : 'unknown'} recovery=${recovery}`.trim();
        return {
            ok,
            kind: (ok ? 'completed' : died ? 'died' : 'failed') as GatherOutcome['kind'],
            detail: resultDetail,
            delta: { coins: gained, elapsedTicks: now() },
            recoverable: !ok,
            summary: { ticks: now(), picks, fails, coinsGained: gained, banked, recovery, died, hpMin },
            resultLine: resultDetail,
            formatFinish,
        };
    };

    try {
        console.log(`GOLDFARM ticks=${TICKS} eatAt=${eatAt()} maxHp=${maxHp()} food=${foodCount()} notes=${notes().length} coins=${coins0}`);
        const startProblem = farmStartProblem(pos(), s.sdk.getSkill('Thieving')?.baseLevel ?? 0);
        if (startProblem) return await finalize(false, startProblem);
        lastPickTick = s.tick();
        const hasJunk = () => inv().some(i => !COINS_RE.test(i.name) && !isFoodItem(i) && !notes().some(n => n.slot === i.slot));
        if (hasJunk() || foodCount() < 2 || notes().length > 0) {
            await refill();
            if (foodCount() < 2) await replenishFood();
        }
        let nextMark = 1000;
        let foodWaitingSince: number | undefined;
        while (now() < TICKS && !died && !stoppingPicks && !stop()) {
            if (existsSync(stopFile)) return await finalize(false, 'stop file');
            if (now() >= nextMark) {
                console.log(
                    `MILESTONE t=${now()} banked=${banked} packCoins=${coins()} food=${foodCount()} picks=${picks} fails=${fails} eaten=${eaten}`,
                );
                nextMark += 1000;
            }
            if (randomEventsOf(s)?.busy()) {
                idleTicks++;
                await waitTicks(s, 1);
                continue;
            }
            if (FUND_COURIER && cfg.deps?.pendingCourierFunding?.(s.name, FUND_COURIER, farmServer)) {
                await walk(BANK_SPOT, 2);
                const funded = await cfg.deps.serviceCourierFunding?.(s, FUND_COURIER, farmServer);
                if (funded?.state === 'unknown') throw Error('no courier progress: funding settlement uncertain');
                await refill();
            }
            if (FOOD_FROM && (knownBankFood === undefined || knownBankFood + foodCount() < 80)) {
                let courier: any;
                if (/^[A-Za-z0-9_ -]{1,12}$/.test(FOOD_FROM)) {
                    try {
                        courier = JSON.parse(readFileSync(join(ROOT, '.practice', 'status', `${FOOD_FROM}.json`), 'utf8'));
                    } catch {}
                }
                if (courierFoodReady(courier, FOOD_FROM, farmServer, ownedAccounts(farmServer), Date.now(), s.tick(), lastProactiveTrade)) {
                    await walk(BANK_SPOT, 2);
                    const fundingPending = () => !!FUND_COURIER && !!cfg.deps?.pendingCourierFunding?.(s.name, FUND_COURIER, farmServer);
                    const receipt = await receiveFoodAtBank(
                        s,
                        FOOD_FROM,
                        45_000,
                        refill,
                        () => foodCount() >= 2,
                        fundingPending,
                        farmServer,
                        cfg.deps?.receiveHandoff,
                    );
                    if (fundingPending()) continue;
                    lastProactiveTrade = s.tick();
                    lastCourierCheck = s.tick();
                    console.log(`COURIER proactive incoming=${receipt.incoming} food=${foodCount()} t=${now()}`);
                    if (receipt.available) await walk(KNIGHT_SPOT, 3);
                }
            }
            if (foodCount() < COURIER_WANT_BELOW && courierCheckDue(s.tick(), lastCourierCheck, FOOD_FROM, st()?.nearbyPlayers ?? [])) {
                await quickCourierCheck();
                lastCourierCheck = s.tick();
            }
            if (foodCount() < 2 && bankEmpty) {
                if (foodWaitingSince === undefined) {
                    foodWaitingSince = s.tick();
                    console.log(`MILESTONE waiting-for-food food=${foodCount()} t=${now()}`);
                }
                if (hp() <= eatAt() && foodCount() > 0) await eat();
                await walk(BANK_SPOT, 2);
                let courierStatus: any;
                let courierService: any;
                if (/^[A-Za-z0-9_ -]{1,12}$/.test(FOOD_FROM)) {
                    try {
                        courierStatus = JSON.parse(readFileSync(join(ROOT, '.practice', 'status', `${FOOD_FROM}.json`), 'utf8'));
                    } catch {}
                    try {
                        courierService = JSON.parse(readFileSync(join(ROOT, '.practice', 'swarm-state.json'), 'utf8'));
                    } catch {}
                }
                const limit = foodWaitLimit(FOOD_FROM, courierStatus, Date.now(), courierService);
                if (s.tick() - foodWaitingSince >= limit) {
                    if (coins() > 0) await refill();
                    return await finalize(false, `no food supply: waited ${limit} ticks at bank`);
                }
                await waitTicks(s, 2);
                continue;
            }
            foodWaitingSince = undefined;
            if (s.tick() - lastPickTick >= IDLE_LIMIT) {
                return await finalize(
                    false,
                    foodCount() === 0
                        ? `no food: waited ${IDLE_LIMIT} ticks with no useful work and no food`
                        : `no goldfarm progress: idle ${IDLE_LIMIT} ticks with no pickpocket or food gained`,
                );
            }
            const f = foodCount();
            if (hp() <= eatAt() && f > 0) {
                if (!(await eat())) await waitTicks(s, 1);
                continue;
            }
            if (hp() <= DMG) {
                if (f > 0) {
                    await eat();
                    continue;
                }
                await replenishFood();
                await walk(KNIGHT_SPOT, 3);
                continue;
            }
            if (hasJunk() || (f < 2 && !bankEmpty) || coins() >= BANK_AT || notes().length > 0) {
                await refill();
                if (foodCount() === 0 && hp() <= 6) {
                    await walk(BANK_SPOT, 2);
                    await waitTicks(s, 2);
                    continue;
                }
                await walk(KNIGHT_SPOT, 3);
                continue;
            }
            if (f < 2 && bankEmpty) {
                await replenishFood();
                if (foodCount() === 0) {
                    await walk(BANK_SPOT, 2);
                    await waitTicks(s, 2);
                    continue;
                }
                await walk(KNIGHT_SPOT, 3);
                continue;
            }
            await steal();
        }
        return await finalize(!died && !stop(), died ? 'died' : stop() ? 'stopped' : 'ticks');
    } catch (e) {
        return await finalize(false, String(e), true);
    } finally {
        off();
    }
}

// ---------------------------------------------------------------------------
// 7. Unified Thieving Session & CLI
// ---------------------------------------------------------------------------
export async function runThievingSession(
    s: Session,
    cfg: NormalizedGatherConfig,
    stop: () => boolean,
): Promise<GatherOutcome> {
    switch (cfg.method) {
        case 'knights':
            return runGoldfarmKnights(s, cfg, stop);
        case 'knights-stable':
            return runGoldfarmStableSession(s, cfg, stop);
        case 'pickpocket': {
            const rawPath = cfg.args[0];
            if (!rawPath) throw Error('usage: thieving pickpocket job.json');
            const raw = rawPath.startsWith('{') ? rawPath : readFileSync(rawPath, 'utf8');
            if (raw.length > 32768) throw Error('pickpocket trip file too large');
            const j = JSON.parse(raw) as PickpocketTrip;
            const r = await runPickpocketTrips(s, j, stop, { bank: cfg.deps?.runBankProfile });
            const line = 'PICKPOCKET_TRIP ' + JSON.stringify(r);
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
        case 'pickpocket-at-site': {
            const name = cfg.spot ?? cfg.args[0] ?? resolveSetting(cfg, 'PROFILE') ?? '';
            const p = pickpocketProfiles().find(x => x.name === name);
            if (!p) throw Error('account and native pickpocket profile required');
            const o = validatePocketOptions({
                successes: cfg.target?.count ?? Number(cfg.args[1] ?? resolveSetting(cfg, 'SUCCESSES') ?? 10),
                attempts: Number(cfg.args[2] ?? resolveSetting(cfg, 'ATTEMPTS') ?? 40),
                cap: cfg.target?.capTicks ?? Number(cfg.args[3] ?? resolveSetting(cfg, 'CAP') ?? 2000),
                maxNoProgress: Number(resolveSetting(cfg, 'NO_PROGRESS') ?? 10),
                hpFloor: Number(resolveSetting(cfg, 'HP_FLOOR') ?? 10),
                eatAt: Number(resolveSetting(cfg, 'EAT_AT') ?? 20),
                food: cfg.tool?.baitId ?? Number(resolveSetting(cfg, 'FOOD_ID') ?? 0),
                foodReserve: Number(resolveSetting(cfg, 'FOOD_RESERVE') ?? 0),
                xpRate: Number(resolveSetting(cfg, 'XP_RATE') ?? 25),
                members: resolveSetting(cfg, 'MEMBERS') === '1',
                stop: () => stop() || productionStopRequested(s.name),
            });
            const r = await runPickpockets(s, p, o);
            const line = 'PICKPOCKET_RESULT ' + JSON.stringify(r);
            console.log(line);
            return {
                ok: r.ok,
                kind: r.ok ? 'completed' : 'failed',
                detail: line,
                delta: { xp: { Thieving: r.xp }, elapsedTicks: r.ticks },
                recoverable: !r.ok,
                summary: r,
                resultLine: line,
            };
        }
        case 'stalls': {
            const stall = cfg.spot ?? cfg.args[0] ?? resolveSetting(cfg, 'STALL') ?? '';
            const quantity = cfg.target?.count ?? Number(cfg.args[1] ?? resolveSetting(cfg, 'QUANTITY') ?? 1);
            const cap = cfg.target?.capTicks ?? Number(cfg.args[2] ?? resolveSetting(cfg, 'CAP') ?? 120);
            if (!stallRecipes().some(r => r.name === stall) || !Number.isSafeInteger(quantity) || quantity < 1 || !Number.isSafeInteger(cap) || cap < 1) {
                throw Error('Usage: stalls <native stealing dbrow name> [quantity] [ticks]');
            }
            const r = await stealStall(s, stall, quantity, cap, stop);
            const line = 'STALL_RESULT ' + JSON.stringify(r);
            console.log(line);
            return {
                ok: r.ok,
                kind: r.ok ? 'completed' : 'failed',
                detail: line,
                delta: { xp: { Thieving: r.xpGain }, elapsedTicks: r.ticks },
                recoverable: !r.ok,
                summary: r,
                resultLine: line,
            };
        }
        case 'blood-chest': {
            const o = bloodOptions(cfg.args[0] ?? (cfg.target?.capTicks ? String(cfg.target.capTicks) : undefined), cfg.env);
            const r = await runBloodChestSession(s, o, stop, console.log, cfg.deps);
            const line = 'BLOOD_CHEST_RESULT ' + JSON.stringify(r);
            console.log(line);
            return {
                ok: r.ok,
                kind: r.ok ? 'completed' : 'failed',
                detail: line,
                delta: { coins: r.coins, items: { [BLOOD_RUNE]: r.runes }, elapsedTicks: r.ticks },
                recoverable: !r.ok,
                summary: r,
                resultLine: line,
            };
        }
        case 'nature-chest': {
            const o = chestOptions(cfg.env);
            const r = await runNatureChest(
                {
                    state: () => s.sdk.getState(),
                    tick: () => s.tick(),
                    stopped: stop,
                    act: (x, z, id, option) => s.sdk.sendInteractLoc(x, z, id, option),
                    wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
                    step: () => waitTicks(s, 1),
                },
                o,
            );
            const line = JSON.stringify(r);
            return {
                ok: true,
                kind: 'completed',
                detail: line,
                delta: { coins: r.coins, items: { [NATURE_RUNE]: r.natureRunes }, elapsedTicks: r.ticks },
                recoverable: false,
                summary: r,
                resultLine: line,
            };
        }
        default:
            return {
                ok: false,
                kind: 'refused',
                detail: `unknown thieving method: ${cfg.method}`,
                delta: { elapsedTicks: 0 },
                recoverable: false,
            };
    }
}

export async function runThievingCli(account: string, cfg: NormalizedGatherConfig): Promise<number> {
    if (cfg.method === 'knights-stable') {
        console.log(`ERR-TRACE opening ${account}`);
        let errorEnd: ((error: unknown) => Promise<void>) | undefined;
        let stopRequested = false;
        const s = await openBot(account, {
            onStop: (_session, detail) => {
                stopRequested = true;
                return errorEnd ? errorEnd(detail) : finish([_session], false, detail);
            },
            onSessionEnd: (_session, detail) => {
                stopRequested = true;
                return errorEnd ? errorEnd(detail) : finish([_session], false, detail);
            },
        }).catch(e => finish([], false, `login: ${String(e)}`));
        let settled = false;
        errorEnd = async () => {
            stopRequested = true;
        };
        try {
            const outcome = await runGoldfarmStableSession(s, cfg, () => stopRequested);
            settled = true;
            await finish([s], outcome.ok, outcome.formatFinish ?? outcome.detail ?? '');
            return outcome.ok ? 0 : 1;
        } catch (e) {
            if (!settled) await finish([s], false, String(e));
            return 1;
        }
    }

    if (cfg.method === 'pickpocket' || cfg.method === 'stalls') {
        if (cfg.method === 'pickpocket') {
            const rawPath = cfg.args[0];
            if (!rawPath) throw Error('usage: thieving pickpocket job.json');
            const raw = readFileSync(rawPath);
            if (raw.length > 32768) throw Error('pickpocket trip file too large');
            validatePickpocketTrip(JSON.parse(raw.toString('utf8')) as PickpocketTrip);
        } else {
            const stall = cfg.spot ?? cfg.args[0] ?? '';
            const quantity = Number(cfg.args[1] ?? 1);
            const cap = Number(cfg.args[2] ?? 120);
            if (!stallRecipes().some(r => r.name === stall) || !Number.isSafeInteger(quantity) || quantity < 1 || !Number.isSafeInteger(cap) || cap < 1) {
                throw Error('Usage: stalls <account> <native stealing dbrow name> [quantity] [ticks]');
            }
        }
        let stopped = false;
        process.once('SIGINT', () => { stopped = true; });
        process.once('SIGTERM', () => { stopped = true; });
        const s = await openBot(account);
        let ok = false;
        try {
            const outcome = await runThievingSession(s, cfg, () => stopped);
            ok = outcome.ok;
        } finally {
            ok = await settle([s], ok, cfg.method === 'pickpocket' ? 'finite owned pickpocket bank trips' : 'finite native stall order');
        }
        process.exitCode = ok ? 0 : 1;
        return ok ? 0 : 1;
    }

    if (cfg.method === 'blood-chest') {
        const o = bloodOptions(cfg.args[0], cfg.env);
        const s = await openBot(account).catch(e => finish([], false, `login: ${String(e)}`));
        const stop = () => existsSync(`.practice/stop-${account}`) || existsSync('.practice/stop-all');
        try {
            const outcome = await runThievingSession(s, { ...cfg, target: { ...cfg.target, capTicks: o.cap } }, stop);
            await finish([s], outcome.ok, outcome.summary ? JSON.stringify(outcome.summary) : (outcome.detail ?? ''));
            return outcome.ok ? 0 : 1;
        } catch (e) {
            console.log('BLOOD_CHEST_RESULT ' + JSON.stringify(failureResult(e)));
            await finish([s], false, String(e));
            return 1;
        }
    }

    let stopped = false;
    const stopFile = `.practice/stop-${account}`;
    const s = await openBot(account, {
        onStop: async () => {
            stopped = true;
        },
    }).catch(e => finish([], false, `login: ${String(e)}`));
    let ended = false;
    void s.ended.then(() => {
        ended = true;
    });
    const stop = () => ended || stopped || existsSync(stopFile) || existsSync('.practice/stop-all');
    try {
        const outcome = await runThievingSession(s, cfg, stop);
        await finish([s], outcome.ok, outcome.resultLine ?? outcome.detail ?? '');
        return outcome.ok ? 0 : 1;
    } catch (e) {
        await finish([s], false, String(e));
        return 1;
    }
}
