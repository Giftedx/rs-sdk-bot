// 1-tick action_delay PvP relog combat trainer at Deserted Keep (Attack, Strength, Defence, Ranged).
// Exploits rev-289 temporary [action_delay] & [com_mode] reset on logout while members potion boosts do not decay on login.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeWithin, finish, logoutSession, openBot } from '../packages/core/src/bot';
import { connectInProcess, type Session } from '../packages/core/src/inprocess';
import { formatLedger, startLedger } from '../packages/core/src/ledger';
import { isLocalServer } from '../packages/core/src/localserver';
import { componentId } from '../packages/core/src/logout';
import { simBotsDir } from '../packages/core/src/practice-paths';
import { startStatus } from '../packages/core/src/status';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import {
    ARDY_NORTH_BANK,
    CASTLE_WARS_BANK,
    CASTLE_WARS_LAND,
    DESERTED_KEEP,
    DUELING_RING_IDS,
    SPELLS,
    SUPER_ENERGY_IDS,
    assertNonReservedAccount,
    configureSpecialistGuardEnv,
    countById,
    d8,
    exactNameRe,
    openFreshBank,
    posOf,
    pullArdougneLeverToWildy,
    readServerHost,
    rubRingOfDueling,
    runCompanionRole,
    setAutoRetaliate,
    skillInfo,
    walkWaypoints,
    withdrawExactCount,
    closeBankClean,
} from './combat-quest-specialists';

export type PvpCombatSkill = 'Attack' | 'Strength' | 'Defence' | 'Ranged';

// Match ROUTE_HOLD_MS (45s) in packages/core/src/inprocess.ts so pathfinding in one tank does not trip wait timeouts.
const LOCKSTEP_WAIT_IDLE_MS = 60_000;

export async function connectWithRetry<T>(
    connect: () => Promise<T>,
    waitTick: () => Promise<void>,
    isStopped: () => boolean,
    maxAttempts = 12,
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await connect();
        } catch (err) {
            const msg = String(err instanceof Error ? err.message : err);
            const retryable = /already logged in|too many incorrect|try again/i.test(msg);
            if (!retryable || attempt + 1 >= maxAttempts || isStopped()) throw err;
            await waitTick();
        }
    }
}

export const BOW_TIERS: readonly { level: number; id: number; name: string }[] = [
    { level: 50, id: 861, name: 'Magic shortbow' },
    { level: 40, id: 857, name: 'Yew shortbow' },
    { level: 30, id: 853, name: 'Maple shortbow' },
    { level: 20, id: 849, name: 'Willow shortbow' },
    { level: 5, id: 843, name: 'Oak shortbow' },
    { level: 1, id: 841, name: 'Shortbow' },
];

export const ARROW_TIERS: readonly { level: number; id: number; name: string }[] = [
    { level: 40, id: 892, name: 'Rune arrow' },
    { level: 30, id: 890, name: 'Adamant arrow' },
    { level: 20, id: 888, name: 'Mithril arrow' },
    { level: 5, id: 886, name: 'Steel arrow' },
    { level: 1, id: 884, name: 'Iron arrow' },
    { level: 1, id: 882, name: 'Bronze arrow' },
];

export const RANGED_ARMOUR_TIERS: readonly { slot: string; items: readonly { id: number; ranged: number; defence?: number }[] }[] = [
    { slot: 'hat', items: [{ id: 1169, ranged: 20 }, { id: 1167, ranged: 1 }] },
    { slot: 'feet', items: [{ id: 1061, ranged: 1 }] },
    { slot: 'front', items: [{ id: 1704, ranged: 1 }, { id: 1731, ranged: 1 }] },
    { slot: 'hands', items: [{ id: 2491, ranged: 70 }, { id: 2489, ranged: 60 }, { id: 2487, ranged: 50 }, { id: 1065, ranged: 40 }, { id: 1063, ranged: 1 }] },
    { slot: 'legs', items: [{ id: 2497, ranged: 70 }, { id: 2495, ranged: 60 }, { id: 2493, ranged: 50 }, { id: 1099, ranged: 40 }, { id: 1097, ranged: 20 }, { id: 1095, ranged: 1 }] },
    { slot: 'torso', items: [{ id: 2503, ranged: 70, defence: 40 }, { id: 2501, ranged: 60, defence: 40 }, { id: 2499, ranged: 50, defence: 40 }, { id: 1133, ranged: 20, defence: 20 }, { id: 1129, ranged: 1 }] },
];

export const MELEE_2H_TIERS: readonly { level: number; id: number; name: string }[] = [
    { level: 40, id: 1319, name: 'Rune 2h sword' },
    { level: 30, id: 1317, name: 'Adamant 2h sword' },
    { level: 20, id: 1315, name: 'Mithril 2h sword' },
    { level: 10, id: 1313, name: 'Black 2h sword' },
    { level: 5, id: 1311, name: 'Steel 2h sword' },
    { level: 1, id: 1309, name: 'Iron 2h sword' },
    { level: 1, id: 1307, name: 'Bronze 2h sword' },
];

export const MELEE_KIT_IDS = {
    weapon: 1319, // Rune 2h sword
    fallbackWeapon: 1333, // Rune scimitar
    neck: [1725, 1704, 1731] as const,
    feet: [3105] as const, // Climbing boots
} as const;

export function selectMeleeWeapon(attackLevel: number, heldIds: ReadonlySet<number>): { level: number; id: number; name: string } | undefined {
    return MELEE_2H_TIERS.find(w => attackLevel >= w.level && heldIds.has(w.id));
}

export function parsePvpSkill(raw: string): PvpCombatSkill {
    const key = raw.trim().toLowerCase();
    if (key === 'atk' || key === 'attack') return 'Attack';
    if (key === 'str' || key === 'strength') return 'Strength';
    if (key === 'def' || key === 'defence') return 'Defence';
    if (key === 'rng' || key === 'range' || key === 'ranged') return 'Ranged';
    throw Error(`unknown skill "${raw}" (expected attack|strength|defence|ranged)`);
}

export function selectRangedKit(
    rangedLevel: number,
    heldIds: ReadonlySet<number>,
): { bow?: { level: number; id: number; name: string }; arrow?: { level: number; id: number; name: string } } {
    const bow = BOW_TIERS.find(b => rangedLevel >= b.level && heldIds.has(b.id));
    // Rune and Adamant arrows require a tier >= 40 / 30 bow respectively (levelrequire/tier30, tier40).
    const maxArrowLevel = bow ? Math.max(1, bow.level) : rangedLevel;
    const arrow = ARROW_TIERS.find(a => maxArrowLevel >= a.level && heldIds.has(a.id));
    return { bow, arrow };
}

export function styleComponentFor(skill: PvpCombatSkill, weaponId: number): number | null {
    // %com_mode resets to 0 on every login (Attack Accurate on melee; Accurate +3 on bow).
    if (skill === 'Attack' || skill === 'Ranged') return null;
    if (weaponId === 1319) {
        return componentId(skill === 'Strength' ? 'combat_heavysword:heavy1' : 'combat_heavysword:heavy3');
    }
    return componentId(skill === 'Strength' ? 'combat_hacksword:hack1' : 'combat_hacksword:hack3');
}

export function rankTanksForSwing<T extends { index: number; name?: string; x?: number; z?: number; worldX?: number; worldZ?: number; hp?: number | null }>(
    players: readonly T[],
    tankNames: readonly string[],
    attackerPos: { x: number; z: number },
    lastHitSeq?: ReadonlyMap<string, number>,
    localTankState?: ReadonlyMap<string, { hp: number; banking: boolean }>,
): T[] {
    const reList = tankNames.map(n => exactNameRe(n));
    return players
        .filter(p => {
            const name = p.name ?? '';
            if (!reList.some(re => re.test(name))) return false;
            const z = p.z ?? p.worldZ ?? 0;
            if (z < 3900) return false;
            if (p.hp !== undefined && p.hp !== null && p.hp <= 0) return false;
            const local = localTankState?.get(name.toLowerCase());
            if (local && (local.banking || local.hp <= 38)) return false;
            return true;
        })
        .sort((a, b) => {
            const da = d8({ x: a.x ?? a.worldX ?? 0, z: a.z ?? a.worldZ ?? 0 }, attackerPos);
            const db = d8({ x: b.x ?? b.worldX ?? 0, z: b.z ?? b.worldZ ?? 0 }, attackerPos);
            const adjA = da <= 1 ? 0 : da;
            const adjB = db <= 1 ? 0 : db;
            if (adjA !== adjB) return adjA - adjB;
            const sa = lastHitSeq?.get((a.name ?? '').toLowerCase()) ?? 0;
            const sb = lastHitSeq?.get((b.name ?? '').toLowerCase()) ?? 0;
            if (sa !== sb) return sa - sb;
            const ha = localTankState?.get((a.name ?? '').toLowerCase())?.hp ?? 99;
            const hb = localTankState?.get((b.name ?? '').toLowerCase())?.hp ?? 99;
            return hb - ha;
        });
}

function readBotEnvCredentials(root: string, name: string): { password: string; server: string } {
    const envPath = [join(simBotsDir(root), name, 'bot.env'), join(root, 'vendor', 'rs-sdk', 'bots', name, 'bot.env')].find(p => existsSync(p));
    if (!envPath) throw Error(`missing bot.env for ${name} in simBotsDir or vendor/rs-sdk/bots`);
    const raw = readFileSync(envPath, 'utf8');
    const password = raw.match(/^PASSWORD=(.*)$/m)?.[1]?.trim() ?? '';
    const server = raw.match(/^SERVER=(.*)$/m)?.[1]?.trim() ?? '127.0.0.1:8888';
    if (!password) throw Error(`missing PASSWORD in bots/${name}/bot.env`);
    return { password, server };
}

function ownedIds(s: Session): Set<number> {
    const out = new Set<number>();
    for (const item of s.sdk.getInventory()) out.add(item.id);
    for (const item of s.sdk.getEquipment()) out.add(item.id);
    return out;
}

async function equipBestGear(s: Session, skill: PvpCombatSkill, stop: () => boolean): Promise<number> {
    const equipById = async (id: number) => {
        if (s.sdk.getEquipment().some(e => e.id === id)) return;
        const item = s.sdk.getInventory().find(i => i.id === id);
        if (!item) return;
        await s.bot.equipItem(item);
    };
    if (skill === 'Ranged') {
        const rng = skillInfo(s, 'Ranged').baseLevel;
        const def = skillInfo(s, 'Defence').baseLevel;
        const ids = ownedIds(s);
        const { bow, arrow } = selectRangedKit(rng, ids);
        if (bow) await equipById(bow.id);
        if (arrow) await equipById(arrow.id);
        for (const group of RANGED_ARMOUR_TIERS) {
            const best = group.items.find(item => rng >= item.ranged && def >= (item.defence ?? 1) && ids.has(item.id));
            if (best) await equipById(best.id);
        }
        if (stop()) return bow?.id ?? 841;
        return s.sdk.getEquipment().find(e => e.slot === 3)?.id ?? bow?.id ?? 841;
    }

    const ids = ownedIds(s);
    const atk = skillInfo(s, 'Attack').baseLevel;
    const weaponId = selectMeleeWeapon(atk, ids)?.id ?? (atk >= 40 && ids.has(MELEE_KIT_IDS.fallbackWeapon) ? MELEE_KIT_IDS.fallbackWeapon : MELEE_KIT_IDS.weapon);
    if (ids.has(weaponId)) await equipById(weaponId);
    const neckId = MELEE_KIT_IDS.neck.find(id => ids.has(id));
    if (neckId) await equipById(neckId);
    const feetId = MELEE_KIT_IDS.feet.find(id => ids.has(id));
    if (feetId) await equipById(feetId);
    return s.sdk.getEquipment().find(e => e.slot === 3)?.id ?? weaponId;
}

async function rebankManagedTank(s: Session, stop: () => boolean): Promise<boolean> {
    const p0 = posOf(s);
    if (!p0) return false;
    if (p0.worldZ >= 3800) {
        const outLever = (s.sdk.getState()?.nearbyLocs ?? [])
            .filter((l: any) => l.id === 1815 || (/lever/i.test(l.name ?? '') && d8(l, DESERTED_KEEP) <= 3))
            .sort((a: any, b: any) => d8(a, DESERTED_KEEP) - d8(b, DESERTED_KEEP))[0];
        if (!outLever) return false;
        const op = (outLever.optionsWithIndex ?? [])[0];
        await s.sdk.sendInteractLoc(outLever.x, outLever.z, outLever.id, op?.opIndex ?? 1);
        const left = await waitUntil(s, () => (posOf(s)?.worldZ ?? 9999) < 3800 || stop(), { timeoutTicks: 10, idleMs: LOCKSTEP_WAIT_IDLE_MS });
        if (!left || stop() || (posOf(s)?.worldZ ?? 9999) >= 3800) return false;

        await walkWaypoints(s, [{ x: ARDY_NORTH_BANK.x, z: ARDY_NORTH_BANK.z, tol: 1 }], 120, stop, 'tank ardy bank', {
            onTickExtra: () => {
                const energy = (posOf(s) as any)?.runEnergy ?? 100;
                if (energy <= 65) {
                    const ep = s.sdk.getInventory().find(i => (SUPER_ENERGY_IDS as readonly number[]).includes(i.id));
                    if (ep) void s.direct({ type: 'useInventoryItem', slot: ep.slot, optionIndex: 1, reason: 'SDK' });
                }
            },
        });
        await openFreshBank(s, stop);
        for (const vial of s.sdk.getInventory().filter(i => i.id === 229)) {
            await s.bot.depositItem(vial, -1);
        }
        if (!s.sdk.getInventory().some(i => (SUPER_ENERGY_IDS as readonly number[]).includes(i.id))) {
            const hasSuper = s.sdk.getState()?.bank?.items?.some((i: any) => i.id === 3016 && i.count > 0);
            if (hasSuper) await withdrawExactCount(s, 3016, 1, stop, 'Super energy(4)');
        }
        const free = Math.max(0, 28 - s.sdk.getInventory().length);
        if (free > 0) await withdrawExactCount(s, 391, free, stop, 'Manta ray');
        await closeBankClean(s, stop);
        await pullArdougneLeverToWildy(s, stop);
        return true;
    }

    // Outside wildy at startup or recovery: stock via Castle Wars / Camelot if carrying ring, else Ardy North Bank.
    const hasRing = s.sdk.getInventory().some(i => (DUELING_RING_IDS as readonly number[]).includes(i.id))
        || s.sdk.getEquipment().some(e => (DUELING_RING_IDS as readonly number[]).includes(e.id));
    if (hasRing) {
        await rubRingOfDueling(s, /castle wars/i, CASTLE_WARS_LAND, stop);
        await walkWaypoints(s, [{ x: CASTLE_WARS_BANK.x, z: CASTLE_WARS_BANK.z, tol: 1 }], 40, stop, 'tank cw bank');
        await openFreshBank(s, stop);
        const free = Math.max(0, 28 - s.sdk.getInventory().length);
        if (free > 0) await withdrawExactCount(s, 391, free, stop, 'Manta ray');
        await closeBankClean(s, stop);
        for (let attempt = 0; attempt < 5 && !stop(); attempt++) {
            const cur = posOf(s);
            if (cur && cur.level === 0 && cur.worldX <= 2800 && cur.worldZ >= 3440) break;
            await s.direct({ type: 'clickComponent', componentId: SPELLS.camelotTeleport, reason: 'SDK' });
            await waitUntil(s, () => {
                const p = posOf(s);
                return (!!p && p.level === 0 && p.worldX <= 2800 && p.worldZ >= 3440) || stop();
            }, { timeoutTicks: 8, idleMs: LOCKSTEP_WAIT_IDLE_MS });
        }
    }
    await pullArdougneLeverToWildy(s, stop);
    return true;
}

async function runManagedTank(
    name: string,
    index: number,
    totalTanks: number,
    stopFn: () => boolean,
    localTankState: Map<string, { hp: number; banking: boolean }>,
    bankLocks: Set<string>,
): Promise<Session> {
    const s = await openBot(name, { log: () => {}, onStop: async () => {} });
    await setAutoRetaliate(s, false);
    const postTile = index % 2 === 0
        ? { x: DESERTED_KEEP.x + 1, z: DESERTED_KEEP.z }
        : { x: DESERTED_KEEP.x, z: DESERTED_KEEP.z - 1 };
    const maxBankers = Math.max(1, totalTanks - 2);
    const key = name.toLowerCase();
    localTankState.set(key, { hp: skillInfo(s, 'Hitpoints').level, banking: false });

    void (async () => {
        let lastEatTick = -10;
        while (!stopFn()) {
            try {
                const p = posOf(s);
                const mantaCount = countById(s.sdk.getInventory(), 391);
                const hp = skillInfo(s, 'Hitpoints').level;
                const atKeep = !!p && !p.isDead && p.worldZ >= 3900;
                localTankState.set(key, { hp: atKeep ? hp : 0, banking: !atKeep || bankLocks.has(key) });

                if (!p || p.isDead) {
                    await waitTicks(s, 2, { idleMs: LOCKSTEP_WAIT_IDLE_MS });
                    continue;
                }
                if (p.worldZ < 3800) {
                    bankLocks.add(key);
                    localTankState.set(key, { hp: 0, banking: true });
                    await setAutoRetaliate(s, false);
                    await rebankManagedTank(s, stopFn);
                    bankLocks.delete(key);
                    continue;
                }
                if (d8({ x: p.worldX, z: p.worldZ }, postTile) > 0) {
                    await walkWaypoints(s, [{ x: postTile.x, z: postTile.z, tol: 0 }], 20, stopFn, 'tank post');
                }
                if (hp > 0 && hp <= 76 && mantaCount > 0 && s.tick() - lastEatTick >= 3) {
                    const food = s.sdk.getInventory().find(i => i.id === 391);
                    if (food) {
                        lastEatTick = s.tick();
                        await s.direct({ type: 'useInventoryItem', slot: food.slot, optionIndex: 1, reason: 'SDK' });
                    }
                }
                const shouldBank = mantaCount <= 1 || (mantaCount <= 12 && bankLocks.size < maxBankers);
                if (shouldBank) {
                    bankLocks.add(key);
                    localTankState.set(key, { hp: 0, banking: true });
                    const okBank = await rebankManagedTank(s, stopFn);
                    bankLocks.delete(key);
                    if (okBank) continue;
                }
                await waitTicks(s, 1, { idleMs: LOCKSTEP_WAIT_IDLE_MS });
            } catch (err) {
                bankLocks.delete(key);
                if (stopFn()) break;
                const msg = String(err);
                if (/TickStallError|tick stream stalled/i.test(msg)) {
                    console.log(`WARN tank ${name}: ${msg}`);
                    await waitTicks(s, 1, { idleMs: LOCKSTEP_WAIT_IDLE_MS }).catch(() => {});
                    continue;
                }
                throw err;
            }
        }
    })().catch(err => {
        if (!stopFn()) console.log(`WARN tank ${name}: ${String(err)}`);
    });

    return s;
}

async function runCompanionMain(args: string[]): Promise<void> {
    const [tankName, attackerName, offsetArg = '0', capArg = '4000', stopFile] = args;
    if (!tankName || !attackerName) {
        throw Error('usage: bun scripts/pvp-relog-combat.ts --companion-tank <tank> <attacker> [offsetX] [cap] [stopFile]');
    }
    configureSpecialistGuardEnv();
    let stopFlag = false;
    const s = await openBot(tankName, { onStop: async () => { stopFlag = true; } });
    const res = await runCompanionRole(s, {
        role: 'tank',
        specialistName: attackerName,
        postTileOffsetX: Number(offsetArg),
        cap: Number(capArg),
        stopFile,
    });
    await finish([s], res.ok || stopFlag, res.detail);
}

async function runAttackerMain(args: string[]): Promise<void> {
    const positional = args.filter(a => !a.includes('=') && !a.startsWith('-'));
    const flags = new Set(args.filter(a => a.startsWith('--')));
    const kv = new Map<string, string>();
    for (const a of args) {
        const eq = a.indexOf('=');
        if (eq > 0) kv.set(a.slice(0, eq).toUpperCase(), a.slice(eq + 1));
    }

    const account = assertNonReservedAccount(positional[0] ?? '', 'attacker');
    const skill = parsePvpSkill(positional[1] ?? kv.get('SKILL') ?? process.env.SKILL ?? 'strength');
    const targetLevel = Number(positional[2] ?? kv.get('TARGET') ?? process.env.TARGET ?? 99);
    const tanksRaw = kv.get('TANKS') ?? positional[3] ?? process.env.PRACTICE_TANKS ?? process.env.TANKS ?? `${account}t,${account}u,${account}v,${account}w`;
    const tankNames = tanksRaw.split(',').map(s => s.trim()).filter(Boolean);
    if (!tankNames.length) throw Error('at least one tank name is required (TANKS=t1,t2,...)');
    for (const t of tankNames) assertNonReservedAccount(t, 'tank');

    const ownTanks = flags.has('--own-tanks') || kv.get('OWN_TANKS') === '1' || process.env.OWN_TANKS === '1';
    const debug = kv.get('DEBUG') === '1' || process.env.PVP_DEBUG === '1';
    const cap = Number(process.env.CAP ?? kv.get('CAP') ?? 3000);
    const root = resolve(import.meta.dir, '..');

    configureSpecialistGuardEnv();

    let stopFlag = false;
    let stopTanks = false;
    let totalTicks = 0;
    let swings = 0;
    const isStopped = () =>
        stopFlag ||
        totalTicks >= cap ||
        existsSync(join(root, '.practice', `stop-${account}`)) ||
        existsSync(join(root, '.practice', 'stop-all'));
    const isTankStopped = () => stopTanks || isStopped();

    const localTankState = new Map<string, { hp: number; banking: boolean }>();
    const bankLocks = new Set<string>();
    const tankSessions: Session[] = ownTanks
        ? await Promise.all(tankNames.map((t, i) => runManagedTank(t, i, tankNames.length, isTankStopped, localTankState, bankLocks)))
        : [];
    if (tankSessions[0]) await waitTicks(tankSessions[0], 2);

    const creds = readBotEnvCredentials(root, account);
    const members = isLocalServer(creds.server) || process.env.NODE_MEMBERS === 'true';
    const logoutCom = componentId('logout:try_logout');
    const ultStrCom = componentId('prayer:prayer_ultimatestrength');
    const incRefCom = componentId('prayer:prayer_incrediblereflexes');

    let intentionalRelog = false;
    const initSess = await openBot(account, {
        onStop: async (_sess, detail) => {
            if (!intentionalRelog && !detail.startsWith('progression')) stopFlag = true;
        },
        onSessionEnd: async (sess, detail) => {
            if (intentionalRelog) return;
            stopTanks = true;
            await finish([sess, ...tankSessions], false, `unexpected end: ${detail}`);
        },
    });
    const startXp = skillInfo(initSess, skill).experience;
    let canPray = false;
    let currentWeaponId = 0;
    let lastCheckedGearLevel = -1;
    const lastHitSeq = new Map<string, number>();

    try {
        // Move to Deserted Keep if started outside Wildy, equip kit, drink initial potion, and end setup session.
        const initTick0 = initSess.tick();
        const p0 = posOf(initSess);
        if (!p0 || p0.worldZ < 3900) {
            await pullArdougneLeverToWildy(initSess, isStopped);
            await walkWaypoints(initSess, [{ ...DESERTED_KEEP, tol: 1 }], 30, isStopped, 'walk to deserted keep');
        } else if (d8({ x: p0.worldX, z: p0.worldZ }, DESERTED_KEEP) > 1) {
            await walkWaypoints(initSess, [{ ...DESERTED_KEEP, tol: 1 }], 20, isStopped, 'recenter keep');
        }
        await setAutoRetaliate(initSess, false);
        currentWeaponId = await equipBestGear(initSess, skill, isStopped);
        lastCheckedGearLevel = skillInfo(initSess, skill).baseLevel;
        canPray = skill !== 'Ranged' && (initSess.sdk.getSkill('Prayer')?.baseLevel ?? 0) >= 34;
        const initEnd = initSess.tick();
        totalTicks += Math.max(0, initEnd - initTick0) + 1;
        intentionalRelog = true;
        await logoutSession(initSess);
        await closeWithin([initSess], 5000);
    } catch (error) {
        intentionalRelog = false;
        stopTanks = true;
        await finish([initSess, ...tankSessions], false, `setup failed: ${String(error)} totalTicks=${totalTicks}`);
    }

    const styleCom = styleComponentFor(skill, currentWeaponId);

    while (!isStopped()) {
        let s: Session | undefined;
        let led: ReturnType<typeof startLedger> | undefined;
        let status: ReturnType<typeof startStatus> | undefined;
        const stopMonitors = (emitLedger: boolean) => {
            if (led) {
                const sum = led.stop();
                led = undefined;
                if (emitLedger && sum.ticks > 0) console.log(`${formatLedger(sum)} bot=${account}`);
            }
            if (status) { status.stop(); status = undefined; }
        };
        try {
            s = await connectWithRetry(
                () => connectInProcess({ name: account, password: creds.password, server: creds.server, members }),
                async () => {
                    totalTicks += 1;
                    if (tankSessions[0]) {
                        await waitTicks(tankSessions[0], 1, { idleMs: LOCKSTEP_WAIT_IDLE_MS });
                    } else {
                        await new Promise(resolve => setTimeout(resolve, 150));
                    }
                },
                isStopped,
            );
            await waitUntil(s, st => !!(st?.inGame && st?.player), { timeoutTicks: 30, idleMs: LOCKSTEP_WAIT_IDLE_MS });
            led = startLedger(s as any, () => null, 300, { script: 'pvp-relog-combat' });
            status = startStatus(
                s as any,
                creds.server,
                led.counts,
                () => led!.rows.slice(-300).map(r => r.kind === 'inventory' ? 'v' : r.kind[0]).join(''),
                { tickStats: () => led!.snapshot() },
            );
        } catch (err) {
            stopMonitors(true);
            if (s) await closeWithin([s], 3000);
            if (isStopped()) break;
            stopTanks = true;
            await finish(tankSessions, false, `reconnect failed skill=${skill} totalTicks=${totalTicks}: ${String(err)}`);
            throw err;
        }

        const tick0 = s.tick();
        if (s.sdk.getState()?.player?.isDead) {
            stopMonitors(true);
            stopTanks = true;
            await logoutSession(s);
            await closeWithin([s], 5000);
            await finish(tankSessions, false, `attacker died skill=${skill} totalTicks=${totalTicks} swings=${swings}`);
        }
        const curStat = skillInfo(s, skill);
        if (debug) {
            const nearby = (s.sdk.getState()?.nearbyPlayers ?? []).map((p: any) => `${p.name}:${p.index}@${p.x ?? p.worldX},${p.z ?? p.worldZ}`);
            console.log(`DBG_LOGIN tick0=${tick0} total=${totalTicks} lvl=${curStat.baseLevel}/${curStat.level} xp=${curStat.experience} nearby=${JSON.stringify(nearby)}`);
        }
        if (curStat.baseLevel >= targetLevel) {
            const finalXp = curStat.experience;
            stopMonitors(true);
            await logoutSession(s);
            await closeWithin([s], 5000);
            totalTicks += 1;
            stopTanks = true;
            const elapsedStr = `skill=${skill} level=${curStat.baseLevel} xp=${finalXp} xpGain=${finalXp - startXp} totalTicks=${totalTicks} swings=${swings}`;
            await finish(tankSessions, true, elapsedStr);
        }
        if (swings >= 50 && curStat.experience === startXp) {
            stopMonitors(true);
            stopTanks = true;
            await logoutSession(s);
            await closeWithin([s], 5000);
            await finish(tankSessions, false, `zero XP after ${swings} swings skill=${skill} totalTicks=${totalTicks}`);
        }

        // PlayerLoading clamps boosted stats on login; only Ranged bow/arrow/armour or Attack 2h tier upgrades need mid-run equip.
        const needTierUpgrade = curStat.baseLevel !== lastCheckedGearLevel && (
            (skill === 'Ranged' && [5, 20, 30, 40, 50, 60, 70].some(lvl => curStat.baseLevel >= lvl && lastCheckedGearLevel < lvl))
            || (skill === 'Attack' && [5, 10, 20, 30, 40].some(lvl => curStat.baseLevel >= lvl && lastCheckedGearLevel < lvl))
        );
        if (needTierUpgrade) {
            currentWeaponId = await equipBestGear(s, skill, isStopped);
            lastCheckedGearLevel = curStat.baseLevel;
            const maintEnd = s.tick();
            stopMonitors(true);
            await logoutSession(s);
            await closeWithin([s], 5000);
            totalTicks += Math.max(0, maintEnd - tick0) + 1;
            continue;
        }

        let target = rankTanksForSwing(
            s.sdk.getState()?.nearbyPlayers ?? [],
            tankNames,
            DESERTED_KEEP,
            lastHitSeq,
            ownTanks ? localTankState : undefined,
        )[0];

        if (!target) {
            await waitUntil(s, st => rankTanksForSwing(
                st?.nearbyPlayers ?? [],
                tankNames,
                DESERTED_KEEP,
                lastHitSeq,
                ownTanks ? localTankState : undefined,
            ).length > 0 || isStopped(), { timeoutTicks: 80, idleMs: LOCKSTEP_WAIT_IDLE_MS });
            target = rankTanksForSwing(
                s.sdk.getState()?.nearbyPlayers ?? [],
                tankNames,
                DESERTED_KEEP,
                lastHitSeq,
                ownTanks ? localTankState : undefined,
            )[0];
        }
        if (!target) {
            const tOut = s.tick();
            stopMonitors(true);
            await logoutSession(s);
            await closeWithin([s], 5000);
            totalTicks += Math.max(0, tOut - tick0) + 1;
            continue;
        }

        lastHitSeq.set((target.name ?? '').toLowerCase(), swings + 1);
        if (canPray) {
            void s.direct({ type: 'clickComponent', componentId: ultStrCom, reason: 'SDK' });
            void s.direct({ type: 'clickComponent', componentId: incRefCom, reason: 'SDK' });
        }
        if (styleCom !== null) {
            void s.direct({ type: 'clickComponent', componentId: styleCom, reason: 'SDK' });
        }
        void s.direct({ type: 'interactPlayer', playerIndex: target.index, optionIndex: 2, reason: 'SDK' });
        void s.direct({ type: 'clickComponent', componentId: logoutCom, reason: 'SDK' });

        const endReason = await Promise.race([
            s.ended.then(e => e.reason),
            waitTicks(s, 4, { idleMs: LOCKSTEP_WAIT_IDLE_MS }).then(() => 'timeout'),
        ]);
        if (endReason === 'timeout') {
            await logoutSession(s);
        } else if (endReason !== 'logged-out') {
            const endTick = s.tick();
            totalTicks += Math.max(0, endTick - tick0) + 1;
            stopMonitors(true);
            stopTanks = true;
            await closeWithin([s], 5000);
            await finish(tankSessions, false, `unexpected end (${endReason}) skill=${skill} totalTicks=${totalTicks} swings=${swings}`);
        }
        const endTick = s.tick();
        if (debug) {
            const postXp = skillInfo(s, skill).experience;
            console.log(`DBG_SWING target=${target.name}(${target.index}) styleCom=${styleCom} end=${endReason} dt=${endTick - tick0} xp=${curStat.experience}->${postXp}`);
        }
        stopMonitors(swings < 3 || (swings + 1) % 100 === 0 || endReason === 'timeout');
        await closeWithin([s], 5000);
        swings++;
        totalTicks += Math.max(0, endTick - tick0) + 1;

        if (swings % 100 === 0) {
            console.log(`PVP_RELOG_PROGRESS skill=${skill} lvl=${curStat.baseLevel} xp=${curStat.experience} swings=${swings} totalTicks=${totalTicks}`);
        }
    }

    stopTanks = true;
    await finish(tankSessions, false, `stopped/capped skill=${skill} totalTicks=${totalTicks} swings=${swings}`);
}

// The tank arguments: `--companion-tank <tank> <attacker> ...`, or `<tank> --companion-tank <attacker> ...` from a swarm
// job (supervise puts the account first).
export function companionTankArgs(args: readonly string[]): string[] | null {
    if (args[0] === '--companion-tank') return args.slice(1);
    if (args[1] === '--companion-tank' && args[0]) return [args[0], ...args.slice(2)];
    return null;
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const tankArgs = companionTankArgs(args);
    const entry = tankArgs ? runCompanionMain(tankArgs) : runAttackerMain(args);
    entry.catch(err => {
        console.log(`RESULT fail ${String(err instanceof Error ? err.message : err)}`);
        process.exit(1);
    });
}
