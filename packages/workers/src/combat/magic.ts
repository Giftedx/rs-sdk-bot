import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initPathfinding } from '../../../../vendor/rs-sdk/sdk/pathfinding';
import type { NearbyNpc } from '../../../../vendor/rs-sdk/sdk/types';
import * as rsmod from '../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder';
import { accountOf, finish, getWorld, openBot, randomEventsOf } from '../../../core/src/bot';
import { awaitLogoutQuiet, LOGOUT_QUIET_TICKS, logoutQuiet } from '../../../core/src/combat-end';
import { equipmentObserved } from '../../../core/src/container-observation';
import { objId } from '../../../core/src/content-facts';
import { depositObserved } from '../../../core/src/deposit';
import { componentId } from '../../../core/src/logout';
import { nativeNpcSpell, npcCastEffect, selectMagicTarget, type NpcSpell } from '../../../core/src/magic-data';
import { questFoodDefinitions, startQuestSustain } from '../../../core/src/sustain';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { loadTravel } from '../../../core/src/travel';
import { goTo, sessionWalker, walkPath, type PathPoint } from '../../../core/src/walk';
import { executeShopToolPurchase, reconcileBankTool, sessionToolHooks } from '../gather/tools';
import {
    approach,
    leaveTutorial,
    LUMBRIDGE_TO_DRAYNOR,
    NORTH_BANK,
    onTutorialIsland,
    walkTargetPersist,
} from '../logistics';
import { buyWithBudget, maximumUnitCost, PROFILES } from '../market';
import { chickenTrainingProfile } from './chickens';
import {
    bestElementalStaffForRunes,
    ELEMENTAL_STAFF_RUNES,
    planMagicStaffShopUpgrade,
    readSkillLevels,
    reconcileCombatLoadout,
} from './gear';
import {
    combatMagicRecipe,
    combatSpellCosts,
    eatBetweenCasts,
    elementalRuneCost,
    runHighAlch,
    type MagicRecipe,
} from './survivability';
import type { CombatSession } from './types';
import { xpForLevel } from './xp';

export { awaitLogoutQuiet, LOGOUT_QUIET_TICKS, logoutQuiet, nativeNpcSpell, npcCastEffect, selectMagicTarget, type NpcSpell };

export const AIR = 556;
export const MIND = 558;
export const EARTH = 557;
export const WATER = 555;
export const BODY = 559;
export const COINS = 995;

const CONTENT_ROOT = resolve(import.meta.dir, '../../../../vendor/rs-sdk/server/content/scripts');

export interface NativeCombatTeleport {
    name: string;
    component: string;
    level: number;
    members: boolean;
    runes: Record<number, number>;
    to: { x: number; z: number; level: number };
}

export function nativeCombatTeleport(name: string): NativeCombatTeleport {
    if (!/^(varrock|lumbridge|falador|camelot|ardougne|watchtower|trollheim)$/.test(name)) {
        throw Error('unsupported native teleport');
    }
    const text = readFileSync(resolve(CONTENT_ROOT, 'skill_magic/configs/magic_spells.dbrow'), 'utf8');
    const body = text.split('[magic_spell_teleport_' + name + ']')[1]?.split('\n[')[0];
    if (!body) throw Error('native teleport missing');
    const field = (key: string) => body.match(new RegExp('^data=' + key + ',(.+)$', 'm'))?.[1]?.trim();
    const parts = field('runesrequired')!.split(',');
    const runes: Record<number, number> = {};
    for (let i = 0; i < parts.length; i += 2) {
        if (parts[i] !== 'null') runes[objId(parts[i]!)] = Number(parts[i + 1]);
    }
    const [level, mx, mz, lx, lz] = field('tele_coord')!.split('_').map(Number);
    return {
        name,
        component: 'magic:' + name + '_teleport',
        level: Number(field('levelrequired')),
        members: field('members') === 'true',
        runes,
        to: { x: mx! * 64 + lx!, z: mz! * 64 + lz!, level: level! },
    };
}

function teleportLanded(
    t: NativeCombatTeleport,
    costs: Record<number, number>,
    before: Record<number, number>,
    after: Record<number, number>,
    xp0: number,
    xp1: number,
    p: { worldX: number; worldZ: number; level: number } | null | undefined,
) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(costs)]);
    return (
        xp1 > xp0 &&
        [...keys].every(k => (before[Number(k)] ?? 0) - (after[Number(k)] ?? 0) === (costs[Number(k)] ?? 0)) &&
        !!p &&
        p.level === t.to.level &&
        Math.max(Math.abs(p.worldX - t.to.x), Math.abs(p.worldZ - t.to.z)) <= 2
    );
}

export async function runCombatTeleport(
    s: CombatSession,
    t: NativeCombatTeleport,
    o: { casts: number; cap: number; members?: boolean; stop?: () => boolean },
) {
    if (!Number.isSafeInteger(o.casts) || o.casts < 1 || o.casts > 1000 || !Number.isSafeInteger(o.cap) || o.cap < 1 || o.cap > 100000) {
        throw Error('invalid finite teleport limits');
    }
    if (t.members && !o.members) throw Error('member teleport requires explicit member batch scope');
    const st = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const xp = () => s.sdk.getSkillXp('Magic') ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const counts = () => {
        const r: Record<number, number> = {};
        for (const i of inv()) r[i.id] = (r[i.id] ?? 0) + i.count;
        return r;
    };
    const p0 = st()?.player;
    const hp0 = hp();
    if (!p0 || hp0 < 10 || (s.sdk.getSkill('Magic')?.level ?? 0) < t.level) throw Error('teleport entry player/level unknown');
    let ended = false;
    let casts = 0;
    let failure = '';
    let stop = 'target';
    void s.ended.then(() => {
        ended = true;
    });
    const start = s.tick();
    const xp0 = xp();
    const over = () =>
        ended ||
        !!o.stop?.() ||
        s.tick() - start >= o.cap ||
        !st()?.player ||
        st()?.player?.lifeId !== p0.lifeId ||
        hp() < hp0;
    try {
        while (casts < o.casts && !over()) {
            await s.bot.dismissBlockingUI();
            if (over()) break;
            const costs = Object.fromEntries(
                Object.entries(t.runes).map(([id, n]) => [id, elementalRuneCost(Number(id), n, s.sdk.getEquipment(), o.members ?? false)]),
            ) as Record<number, number>;
            const b = counts();
            const x0 = xp();
            if (Object.entries(costs).some(([id, n]) => (b[Number(id)] ?? 0) < n)) {
                stop = 'runes';
                break;
            }
            const reply = (await s.direct({ type: 'clickComponent', componentId: componentId(t.component), reason: 'SDK' })) as {
                success?: boolean;
            };
            if (reply?.success === false) throw Error('teleport dispatch refused');
            await waitUntil(s, () => over() || teleportLanded(t, costs, b, counts(), x0, xp(), st()?.player), {
                timeoutTicks: Math.min(15, Math.max(1, o.cap - (s.tick() - start))),
            });
            if (!teleportLanded(t, costs, b, counts(), x0, xp(), st()?.player)) {
                throw Error('teleport rune/XP/destination effect missing; check native quest, scroll and member requirements');
            }
            casts++;
            for (let i = 0; i < 6 && !over(); i++) await waitTicks(s, 1);
        }
        if (casts !== o.casts && stop === 'target') stop = 'stopped/cap';
    } catch (e) {
        failure = String(e);
        stop = 'failure';
    }
    return {
        ok: !failure && !over() && casts === o.casts,
        stop,
        failure,
        casts,
        combos: 0,
        magicXp: xp() - xp0,
        ticks: s.tick() - start,
    };
}

export function magicStopRequested(
    actor: string,
    stopped = false,
    exists: (path: string) => boolean = existsSync,
    stopFile = process.env.STOP_FILE,
) {
    return (
        stopped ||
        ['.practice/stop-' + actor, '.practice/stop-all', '.practice/stop-microbot-magic', stopFile].some(path => !!path && exists(path))
    );
}

export interface NpcMagicOptions {
    npc: number;
    casts: number;
    cap: number;
    splashOnly?: boolean;
    combo?: MagicRecipe;
    teleport?: string;
    members?: boolean;
    hpFloor?: number;
    stop?: () => boolean;
    environmentDelta?: () => Readonly<Record<number, number>>;
    ownedPassiveTarget?: (target: NearbyNpc) => boolean;
    runComboItem?: (s: CombatSession, recipe: MagicRecipe, o: { count: number; cap: number; members?: boolean; stop?: () => boolean }) => Promise<{ ok: boolean; stop: string }>;
    runComboTeleport?: (s: CombatSession, tele: NativeCombatTeleport, o: { casts: number; cap: number; members?: boolean; stop?: () => boolean }) => Promise<{ ok: boolean; stop: string }>;
}

export async function runNpcMagic(s: CombatSession, spell: NpcSpell, o: NpcMagicOptions) {
    if (![o.npc, o.casts, o.cap].every(Number.isSafeInteger) || o.npc < 0 || o.casts < 1 || o.casts > 1000 || o.cap < 1 || o.cap > 100000) {
        throw Error('invalid finite NPC magic limits');
    }
    const st = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const xp = () => s.sdk.getSkillXp('Magic') ?? 0;
    const hpxp = () => s.sdk.getSkillXp('Hitpoints') ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const counts = () => {
        const r: Record<number, number> = {};
        for (const i of inv()) r[i.id] = (r[i.id] ?? 0) + i.count;
        return r;
    };
    if (spell.members && !o.members) throw Error('member NPC spell requires explicit member batch scope');
    const checkWorn = () => {
        if (spell.requiredWorn !== undefined && !s.sdk.getEquipment().some(i => i.slot === 3 && i.id === spell.requiredWorn)) {
            throw Error('NPC spell requires worn staff ' + spell.requiredWorn);
        }
    };
    checkWorn();
    const p0 = st()?.player;
    const hp0 = hp();
    const own = (s.client as { selfSlot?: number } | undefined)?.selfSlot;
    if (!p0 || hp0 < 10 || !Number.isInteger(own) || (s.sdk.getSkill('Magic')?.level ?? 0) < spell.level) {
        throw Error('NPC magic player/skill/owner state unknown');
    }
    const hpFloor = o.hpFloor ?? hp0;
    if (!Number.isSafeInteger(hpFloor) || hpFloor < 10 || hpFloor > hp0) {
        throw Error('NPC magic HP floor must be integer10..initialHP');
    }
    const life0 = p0.lifeId;
    const respawns0 = p0.respawnCount ?? 0;
    const level0 = p0.level;
    const x0 = p0.worldX;
    const z0 = p0.worldZ;
    const autocastMode = (s.client as { var?: number[] } | undefined)?.var?.[108];
    if (!Number.isSafeInteger(autocastMode)) throw Error('NPC magic autocast mode unknown');
    if (autocastMode === 3) throw Error('disable native autocast before finite NPC magic');
    const teleport = o.teleport ? nativeCombatTeleport(o.teleport) : undefined;
    if (teleport?.members && !o.members) throw Error('member combo teleport requires member scope');
    const start = s.tick();
    const xp0 = xp();
    const hpxp0 = hpxp();
    const avoid = new Set<number>();
    let ended = false;
    let casts = 0;
    let combos = 0;
    let attempts = 0;
    let failure = '';
    let stop = 'target';
    const environmentReceipts: { before: Record<number, number>; after: Record<number, number>; delta: Record<number, number> }[] = [];
    void s.ended.then(() => {
        ended = true;
    });
    const unsafe = () => {
        const p = st()?.player;
        return (
            !p ||
            p.isDead ||
            p.lifeId !== life0 ||
            (p.respawnCount ?? 0) > respawns0 ||
            hp() < hpFloor ||
            !(
                (p.level === level0 && Math.max(Math.abs(p.worldX - x0), Math.abs(p.worldZ - z0)) <= 10) ||
                (teleport && p.level === teleport.to.level && Math.max(Math.abs(p.worldX - teleport.to.x), Math.abs(p.worldZ - teleport.to.z)) <= 10)
            )
        );
    };
    const over = () => ended || unsafe() || !!o.stop?.() || s.tick() - start >= o.cap;
    const rest = async (n: number) => {
        for (let i = 0; i < n && !over(); i++) await waitTicks(s, 1);
    };
    const castItemCombo = async (recipe: MagicRecipe) => {
        if (o.runComboItem) return o.runComboItem(s, recipe, { count: 1, cap: Math.max(1, o.cap - (s.tick() - start)), members: o.members, stop: over });
        return runHighAlch(s, recipe, { count: 1, cap: Math.max(1, o.cap - (s.tick() - start)), members: o.members, stop: over });
    };
    try {
        while (casts < o.casts && attempts < o.casts * 3 && !over()) {
            checkWorn();
            await s.bot.dismissBlockingUI();
            if (over()) break;
            const target = selectMagicTarget(st()?.nearbyNpcs ?? [], o.npc, avoid, own!, o.ownedPassiveTarget);
            if (!target) {
                stop = 'no eligible target';
                break;
            }
            const costs = Object.fromEntries(
                Object.entries(spell.runes).map(([id, n]) => [id, elementalRuneCost(Number(id), n, s.sdk.getEquipment(), o.members ?? false)]),
            ) as Record<number, number>;
            const environmentBefore = { ...o.environmentDelta?.() };
            const before = counts();
            const castXp0 = xp();
            const hpXp0 = hpxp();
            if (Object.entries(costs).some(([id, n]) => (before[Number(id)] ?? 0) < n)) {
                stop = 'runes';
                break;
            }
            if (target.inCombat && target.targetIndex === -1) {
                const current = st()?.nearbyNpcs.find(n => n.index === target.index);
                if (!current || current.id !== target.id || current.targetIndex !== -1 || !o.ownedPassiveTarget?.(current)) {
                    throw Error('NPC passive target ownership changed before cast');
                }
            }
            attempts++;
            const result = (await s.direct({ type: 'spellOnNpc', npcIndex: target.index, spellComponent: componentId(spell.component), reason: 'SDK' })) as {
                success?: boolean;
            };
            if (result?.success === false) throw Error('NPC spell dispatch refused');
            await waitUntil(
                s,
                () => over() || xp() !== castXp0 || Object.keys(costs).some(id => (counts()[Number(id)] ?? 0) !== (before[Number(id)] ?? 0)),
                { timeoutTicks: Math.min(12, Math.max(1, o.cap - (s.tick() - start))) },
            );
            await rest(1);
            const environmentAfter = o.environmentDelta?.() ?? {};
            const environment = Object.fromEntries(
                [...new Set([...Object.keys(environmentBefore), ...Object.keys(environmentAfter)])].map(k => [
                    k,
                    (environmentAfter[+k] ?? 0) - (environmentBefore[+k] ?? 0),
                ]),
            );
            const after = counts();
            const effect = npcCastEffect(costs, before, after, castXp0, xp(), environment);
            if (o.environmentDelta) environmentReceipts.push({ before, after, delta: environment });
            if (effect === 'none') {
                if (Object.values(environment).some(Boolean)) throw Error('known environment settled without cast receipt; no repeated input');
                avoid.add(target.index);
                continue;
            }
            if (effect !== 'cast') throw Error('NPC spell debit/XP mismatch');
            casts++;
            await rest(8);
            if (o.splashOnly && hpxp() !== hpXp0) throw Error('splash-only cast dealt damage');
            if (o.combo && !over()) {
                const r = await castItemCombo(o.combo);
                if (!r.ok) throw Error('combo item cast ' + r.stop);
                combos++;
                await rest(6);
            }
            if (teleport && !over()) {
                const runTele = o.runComboTeleport ?? runCombatTeleport;
                const r = await runTele(s, teleport, { casts: 1, cap: Math.max(1, o.cap - (s.tick() - start)), members: o.members, stop: over });
                if (!r.ok) throw Error('NPC teleport combo ' + r.stop);
                await rest(6);
            }
            console.log('NPC_MAGIC_CAST ' + JSON.stringify({ casts, combos, target: target.index, spell: spell.name, tick: s.tick() }));
        }
        if (casts !== o.casts && stop === 'target') stop = over() ? 'stopped/cap' : 'attempt budget';
    } catch (e) {
        failure = String(e);
        stop = 'failure';
    }
    return {
        ok: !failure && !over() && casts === o.casts && (!o.combo || combos === casts),
        stop,
        failure,
        casts,
        combos,
        attempts,
        magicXp: xp() - xp0,
        hitpointsXp: hpxp() - hpxp0,
        ticks: s.tick() - start,
        environmentReceipts,
    };
}

export async function runNpcMagicCli(
    args: readonly string[],
    env: Record<string, string | undefined>,
    hooks: {
        comboRecipe?: (mode: string, item?: string) => MagicRecipe;
        runComboItem?: NpcMagicOptions['runComboItem'];
        runComboTeleport?: NpcMagicOptions['runComboTeleport'];
    } = {},
) {
    let s: CombatSession | undefined;
    let stopped = false;
    try {
        const [account, name, npc, casts, cap] = args;
        if (!account || !name || npc === undefined) throw Error('account, native spell and NPC ID required');
        const spell = nativeNpcSpell(name);
        const combo = env.COMBO_ALCH
            ? hooks.comboRecipe
                ? hooks.comboRecipe(env.COMBO_ALCH, env.ALCH_ITEM)
                : combatMagicRecipe(env.COMBO_ALCH as 'low-alch' | 'high-alch', env.ALCH_ITEM!)
            : undefined;
        s = await openBot(account, {
            onStop: async () => {
                stopped = true;
            },
        });
        const r = await runNpcMagic(s, spell, {
            npc: Number(npc),
            casts: Number(casts ?? 1),
            cap: Number(cap ?? 1200),
            splashOnly: env.SPLASH_ONLY === '1',
            combo,
            teleport: env.COMBO_TELEPORT,
            members: env.MEMBERS === '1',
            stop: () => magicStopRequested(account, stopped),
            runComboItem: hooks.runComboItem,
            runComboTeleport: hooks.runComboTeleport,
        });
        console.log('NPC_MAGIC_RESULT ' + JSON.stringify(r));
        await finish([s], r.ok, JSON.stringify(r));
    } catch (e) {
        await finish(s ? [s] : [], false, String(e));
    }
}

// --- Splash training (Ardougne cow fence & Lumbridge chicken coop) ---

type ItemCount = { id: number; count: number };
export const ALL_ELEMENTAL_STAFF_IDS = Object.keys(ELEMENTAL_STAFF_RUNES).map(Number);

export function freeRunesFromEquipment(equipment: readonly { id: number; slot: number }[] = []): Set<number> {
    const out = new Set<number>();
    const weapon = equipment.find(e => e.slot === 3);
    if (!weapon) return out;
    for (const r of ELEMENTAL_STAFF_RUNES[weapon.id] ?? []) out.add(r);
    return out;
}

export const SPLASH_SPELLS = [
    { level: 19, component: 'magic:curse', xp: 725, runes: { [BODY]: 1, [WATER]: 2, [EARTH]: 3 } },
    { level: 11, component: 'magic:weaken', xp: 525, runes: { [BODY]: 1, [WATER]: 3, [EARTH]: 2 } },
    { level: 3, component: 'magic:confuse', xp: 325, runes: { [BODY]: 1, [WATER]: 3, [EARTH]: 2 } },
    { level: 1, component: 'magic:wind_strike', xp: 137, runes: { [MIND]: 1, [AIR]: 1 } },
] as const;

export const SPLASH_RUNES = [BODY, WATER, EARTH, MIND, AIR] as const;
export const SPLASH_TILE = { x: 2664, z: 3339 };
export const COWS = [81, 397] as const;
export const COW_SIZE = 2;
export const CAST_RANGE = 9;

export interface SplashSite {
    tile: { x: number; z: number };
    target: (n: { id: number; name: string }) => boolean;
    size: number;
    bank: boolean;
    hpFloor?: number;
}

export const SPLASH_SITES: Readonly<Record<string, SplashSite>> = {
    ardougne: { tile: SPLASH_TILE, target: n => (COWS as readonly number[]).includes(n.id), size: COW_SIZE, bank: true },
    coop: { tile: { x: 3229, z: 3292 }, target: n => /^chicken$/i.test(n.name), size: 1, bank: false, hpFloor: 5 },
};

export function splashSite(name = 'ardougne'): SplashSite {
    const site = SPLASH_SITES[name];
    if (!site) throw Error(`SPLASH_SITE must be ${Object.keys(SPLASH_SITES).join(' or ')}, not ${name}`);
    return site;
}

export const WEAK_TICKS = 25;
export const MISS_TICKS = 10;
export const CAST_GAP = 5;
export const CAST_WAIT = 4;
const countItems = (items: readonly ItemCount[], id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

export const splashSpell = (level: number) => SPLASH_SPELLS.find(s => level >= s.level) ?? SPLASH_SPELLS[SPLASH_SPELLS.length - 1]!;
export const hasSpellRunes = (spell: (typeof SPLASH_SPELLS)[number], pack: readonly ItemCount[], freeRunes?: ReadonlySet<number>) =>
    Object.entries(spell.runes).every(([id, each]) => freeRunes?.has(Number(id)) || countItems(pack, Number(id)) >= each);
export const packSpell = (level: number, pack: readonly ItemCount[], freeRunes?: ReadonlySet<number>) =>
    SPLASH_SPELLS.find(s => level >= s.level && hasSpellRunes(s, pack, freeRunes)) ?? splashSpell(level);
export const splashDebuffSpells = (level: number, pack: readonly ItemCount[], freeRunes?: ReadonlySet<number>) =>
    SPLASH_SPELLS.filter(s => s.component !== 'magic:wind_strike' && level >= s.level && hasSpellRunes(s, pack, freeRunes));
export const bankedSplashSpells = (level: number, pack: readonly ItemCount[], freeRunes?: ReadonlySet<number>) => {
    const debuffs = splashDebuffSpells(level, pack, freeRunes);
    const strike = splashSpell(level);
    return debuffs.length || !hasSpellRunes(strike, pack, freeRunes) ? debuffs : [strike];
};

export function pickSplashTarget<T extends { index: number; distance: number }>(
    targets: readonly T[],
    spells: readonly (typeof SPLASH_SPELLS)[number][],
    rest: ReadonlyMap<string, number>,
    tick: number,
): { target: T; spell: (typeof SPLASH_SPELLS)[number] } | null {
    for (const spell of spells) {
        const ready = targets.filter(t => (rest.get(`${t.index}:${spell.component}`) ?? 0) <= tick).sort((a, b) => a.distance - b.distance);
        if (ready.length) return { target: ready[0]!, spell };
    }
    return null;
}

export function splashPlan(xp: number, target: number, freeRunes?: ReadonlySet<number>): { casts: number; runes: Record<number, number> } {
    const runes: Record<number, number> = Object.fromEntries(SPLASH_RUNES.map(id => [id, 0]));
    const goal = xpForLevel(target);
    let casts = 0;
    let at = xp;
    for (const spell of [...SPLASH_SPELLS].reverse()) {
        if (at < xpForLevel(spell.level)) continue;
        const better = SPLASH_SPELLS[SPLASH_SPELLS.indexOf(spell) - 1];
        const until = Math.min(goal, better ? xpForLevel(better.level) : goal);
        const n = Math.max(0, Math.ceil((until - at) / spell.xp));
        casts += n;
        at += n * spell.xp;
        for (const [id, each] of Object.entries(spell.runes)) {
            const runeId = Number(id);
            if (!freeRunes?.has(runeId)) runes[runeId]! += n * each;
        }
    }
    return { casts, runes };
}

export function selectSplashPriorityRunes(xp: number, target: number): number[] {
    const { runes } = splashPlan(xp, target);
    const ordered: number[] = [];
    const pairs = Object.entries(runes)
        .map(([id, n]) => [Number(id), n] as const)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]);
    for (const [id, n] of pairs) {
        const cap = Math.min(20, n);
        for (let k = 0; k < cap; k++) ordered.push(id);
    }
    return ordered;
}

const atNorthBank = (p: { worldX: number; worldZ: number; level: number } | null | undefined) =>
    !!p && p.level === 0 && Math.max(Math.abs(p.worldX - NORTH_BANK.x), Math.abs(p.worldZ - NORTH_BANK.z)) <= 3;

export async function prepareSplashStaffAtBank(
    s: CombatSession,
    options: {
        xp: number;
        target: number;
        bankSpot?: { x: number; z: number; level?: number };
        allowZaffShop?: boolean;
        members?: boolean;
        stop: () => boolean;
        walkTo?: (spot: { x: number; z: number; level?: number }) => Promise<boolean>;
    },
): Promise<{ activeId: number | null; bought?: number; freeRunes: Set<number> }> {
    const openBank = async () => {
        if (!s.sdk.getState()?.bank?.isOpen) await s.bot.openBank();
    };
    const hooks = sessionToolHooks(s as never, {
        openBank,
        walkTo: options.walkTo ?? (async spot => (await walkTargetPersist(s as never, { x: spot.x, z: spot.z, level: spot.level ?? 0 }, 4, t => approach(s as never, t, options.stop))).ok),
        waitUntil: (pred, timeoutTicks) => waitUntil(s, pred, { timeoutTicks }),
        stop: options.stop,
    });
    const runeIds = selectSplashPriorityRunes(options.xp, options.target);
    const levels = readSkillLevels(n => s.sdk.getSkill(n));
    const members = options.members ?? true;
    const eq = () => s.sdk.getEquipment?.() ?? s.sdk.getState()?.equipment ?? [];
    const bankItems = () => s.bankObservation?.()?.items ?? s.sdk.getState()?.bank?.items ?? [];

    await openBank();
    if (!(await waitUntil(s, () => options.stop() || !!s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 10 })) || options.stop()) {
        return { activeId: eq().find(e => e.slot === 3)?.id ?? null, freeRunes: freeRunesFromEquipment(eq()) };
    }

    let bought: number | undefined;
    if (options.allowZaffShop) {
        const stock = [...s.sdk.getInventory(), ...eq().filter(e => e.slot === 3), ...bankItems()];
        const totalCoins = stock.filter(i => i.id === COINS).reduce((n, i) => n + i.count, 0);
        const shopPlan = planMagicStaffShopUpgrade(stock, totalCoins, levels, {
            allowedShops: ['staffshop'],
            runeIds,
            members,
        });
        if (shopPlan && !options.stop()) {
            const res = await executeShopToolPurchase(hooks, {
                targetId: shopPlan.target.id,
                shop: 'staffshop',
                maxBudget: shopPlan.coinBudgetNeeded,
                returnBankSpot: options.bankSpot ?? NORTH_BANK,
            });
            if (res.bought) {
                bought = res.id;
                console.log(`SPLASH_SHOP_STAFF ${JSON.stringify(res)}`);
                await openBank();
                await waitUntil(s, () => options.stop() || !!s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 10 });
                const spareCoins = s.sdk.getInventory().find(i => i.id === COINS);
                if (spareCoins && !options.stop()) await depositObserved(s, spareCoins);
            }
        }
    }

    const rec = bestElementalStaffForRunes([...s.sdk.getInventory(), ...eq().filter(e => e.slot === 3), ...bankItems()], levels, [], runeIds, members);
    if (!rec) {
        return { activeId: eq().find(e => e.slot === 3)?.id ?? null, bought, freeRunes: freeRunesFromEquipment(eq()) };
    }
    const swapped = await reconcileBankTool(hooks, {
        targetId: rec.id,
        canWield: true,
        allowReplaceWeapon: true,
        toolGroupIds: ALL_ELEMENTAL_STAFF_IDS,
    });
    return { activeId: swapped.activeId, bought, freeRunes: freeRunesFromEquipment(eq()) };
}

export function castReaches(from: { x: number; z: number }, sw: { x: number; z: number }, range: number = CAST_RANGE, size: number = COW_SIZE): boolean {
    initPathfinding();
    return Math.max(Math.abs(sw.x - from.x), Math.abs(sw.z - from.z)) <= range && rsmod.hasLineOfSight(0, from.x, from.z, sw.x, sw.z, 1, 1, size, size, 0);
}

export const QUIET_TICKS = 300;
export const QUIET_STOP = `no cast in ${QUIET_TICKS} ticks`;
export const splashBatchDone = (stop: string, gained: number) => gained > 0 && (stop === 'supplies' || stop === 'cap' || stop === QUIET_STOP);

export async function runSplash(
    s: CombatSession,
    o: {
        target: number;
        cap: number;
        stop?: () => boolean;
        site?: SplashSite;
        allowZaffShop?: boolean;
        walkTo?: (spot: { x: number; z: number; level?: number }) => Promise<boolean>;
        leaveStarter?: (s: CombatSession, stop: () => boolean) => Promise<void>;
    },
) {
    const site = o.site ?? SPLASH_SITES.ardougne!;
    const TILE = site.tile;
    const st = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const level = () => s.sdk.getSkill('Magic')?.baseLevel ?? 0;
    const xp = () => s.sdk.getSkillXp('Magic') ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    if (!(await waitUntil(s, () => !!st()?.player && s.sdk.getSkillXp('Magic') !== null, { timeoutTicks: 15 }))) {
        throw Error('splash: position unknown');
    }
    const start = s.tick();
    const level0 = level();
    const xp0 = xp();
    const hp0 = hp();
    const startX = st()?.player?.worldX ?? 0;
    const allowZaffFromStart = o.allowZaffShop ?? startX >= 3040;
    const VARROCK_WEST_BANK = { x: 3185, z: 3436, level: 0 };
    const walkToSpot =
        o.walkTo ??
        (async (spot: { x: number; z: number; level?: number }) =>
            (await walkTargetPersist(s as never, { x: spot.x, z: spot.z, level: spot.level ?? 0 })).ok);
    let ended = false;
    void s.ended.then(() => {
        ended = true;
    });
    let casts = 0;
    let refused = 0;
    let missed = 0;
    let waited = 0;
    let stop = '';
    let hpMin = hp0;
    let quietNote = '';
    const result = () => ({
        ok: level() >= o.target || splashBatchDone(stop, level() - level0),
        level: level(),
        gained: level() - level0,
        xp: xp() - xp0,
        casts,
        refused,
        missed,
        waited,
        stop,
        quiet: quietNote,
        hpMin,
        ticks: s.tick() - start,
    });
    if (level() >= o.target) return result();
    const walker = await sessionWalker(s);
    const toBank = async () => {
        if (!site.bank) return;
        if (atNorthBank(st()?.player)) return;
        if (o.walkTo) {
            const ok = await o.walkTo({ ...NORTH_BANK, level: 0 });
            if (!ok || !atNorthBank(st()?.player)) throw Error('splash: walk to the Ardougne north bank failed');
            return;
        }
        const there = await walkTargetPersist(s as never, { ...NORTH_BANK, level: 0 });
        if (!there.ok || !atNorthBank(st()?.player)) throw Error(`splash: walk to the Ardougne north bank failed: ${there.reason ?? ''} ${there.detail ?? ''}`);
    };
    const observe = s.bankObservation?.bind(s);
    if (!observe) throw Error('splash: fresh bank observation unavailable');
    const openBank = async () => {
        const generation = observe()?.generation ?? 0;
        if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!st()?.bank?.isOpen && (observe()?.generation ?? 0) > generation, { timeoutTicks: 20 }))) {
            throw Error('splash: bank did not open');
        }
    };
    const closeBank = async () => {
        await s.bot.closeBank();
        if (!(await waitUntil(s, () => !st()?.bank?.isOpen, { timeoutTicks: 10 }))) throw Error('splash: bank did not close');
        await waitTicks(s, 2);
    };
    const depositAll = async (keep: ReadonlySet<number>) => {
        for (const id of new Set(inv().map(i => i.id))) {
            const row = inv().find(i => i.id === id);
            if (keep.has(id) || !row) continue;
            if (!(await s.bot.depositItem(row, countItems(inv(), id))).success || !(await waitUntil(s, () => countItems(inv(), id) === 0, { timeoutTicks: 10 }))) {
                throw Error(`splash: deposit ${id} failed`);
            }
        }
    };
    const runeIds = new Set<number>(SPLASH_RUNES);
    const eq = () => s.sdk.getEquipment?.() ?? st()?.equipment ?? [];
    const activeFreeRunes = () => freeRunesFromEquipment(eq());
    const spellNow = () => (site.bank ? splashSpell(level()) : packSpell(level(), inv(), activeFreeRunes()));
    const affordable = () =>
        site.bank ? bankedSplashSpells(level(), inv(), activeFreeRunes()).length > 0 : hasSpellRunes(spellNow(), inv(), activeFreeRunes());
    const runesHeld = () => SPLASH_RUNES.reduce((n, id) => n + countItems(inv(), id), 0);
    const onTile = () => {
        const p = st()?.player;
        return !!p && p.worldX === TILE.x && p.worldZ === TILE.z;
    };
    const reach = (n: { tileX?: number; tileZ?: number; x: number; z: number }) =>
        castReaches(TILE, { x: n.tileX ?? n.x, z: n.tileZ ?? n.z }, CAST_RANGE, site.size);
    const refusals = () => Math.max(-1, ...(st()?.gameMessages ?? []).filter(m => /already been (weakened|lowered)/i.test(m.text)).map(m => m.tick));
    if (site.bank) {
        if (allowZaffFromStart && startX >= 3040) {
            const nearVarrock = () => {
                const p = st()?.player;
                return !!p && Math.max(Math.abs(p.worldX - VARROCK_WEST_BANK.x), Math.abs(p.worldZ - VARROCK_WEST_BANK.z)) <= 4;
            };
            const alreadyCovered = bestElementalStaffForRunes(
                [...inv(), ...eq().filter(e => e.slot === 3)],
                readSkillLevels(n => s.sdk.getSkill(n)),
                [],
                selectSplashPriorityRunes(xp(), o.target),
            );
            if (!alreadyCovered && (nearVarrock() || (await walkToSpot(VARROCK_WEST_BANK)))) {
                await openBank();
                await depositAll(runeIds);
                await prepareSplashStaffAtBank(s, {
                    xp: xp(),
                    target: o.target,
                    bankSpot: VARROCK_WEST_BANK,
                    allowZaffShop: true,
                    walkTo: o.walkTo,
                    stop: () => ended || !!o.stop?.() || s.tick() - start >= o.cap,
                });
                if (st()?.bank?.isOpen) await closeBank();
            }
        }
        await toBank();
        await openBank();
        await depositAll(runeIds);
        const staffRes = await prepareSplashStaffAtBank(s, {
            xp: xp(),
            target: o.target,
            bankSpot: NORTH_BANK,
            allowZaffShop: allowZaffFromStart && startX < 3040,
            walkTo: o.walkTo,
            stop: () => ended || !!o.stop?.() || s.tick() - start >= o.cap,
        });
        const plan = splashPlan(xp(), o.target, staffRes.freeRunes);
        for (const id of runeIds) {
            const want = Math.min(Math.max(0, plan.runes[id]! - countItems(inv(), id)), countItems(observe()?.items ?? [], id));
            const before = countItems(inv(), id);
            if (want < 1) continue;
            const row = (st()?.bank?.items ?? []).find(i => i.id === id);
            if (!row || !(await s.bot.withdrawItem(row, want, { asNote: false })).success || !(await waitUntil(s, () => countItems(inv(), id) >= before + want, { timeoutTicks: 10 }))) {
                throw Error(`splash: withdraw ${want}x${id} failed`);
            }
        }
        await closeBank();
    } else if (typeof s.bot?.equipItem === 'function') {
        await reconcileCombatLoadout(s, {
            style: 'magic',
            trainSkill: 'magic',
            only: ['weapon'],
            runeIds: selectSplashPriorityRunes(xp(), o.target),
            label: 'splash staff',
        });
    }
    if (!site.bank && onTutorialIsland(st()?.player)) {
        const exitStop = () => ended || !!o.stop?.() || s.tick() - start >= o.cap;
        if (o.leaveStarter) {
            await o.leaveStarter(s, exitStop);
        } else {
            const out = await leaveTutorial(s as never, undefined, undefined, exitStop);
            if (out && !out.ok) throw Error(out.detail ?? 'splash: tutorial exit failed');
        }
        await waitTicks(s, 3);
        await s.direct({ type: 'closeModal', reason: 'SDK' });
    }
    if (!affordable()) {
        stop = 'supplies';
        return result();
    }
    const p0 = st()?.player;
    if (!site.bank && p0 && Math.max(Math.abs(p0.worldX - TILE.x), Math.abs(p0.worldZ - TILE.z)) > 10) {
        const there = await walkTargetPersist(s as never, { ...TILE, level: 0 });
        if (!there.ok) throw Error(`splash: walk to ${TILE.x},${TILE.z} failed: ${there.reason ?? ''} ${there.detail ?? ''}`);
    }
    try {
        const rest = new Map<string, number>();
        let quiet = s.tick();
        while (level() < o.target) {
            if (ended) {
                stop = 'session ended';
                break;
            }
            if (o.stop?.()) {
                stop = 'stopped';
                break;
            }
            if (s.tick() - start >= o.cap) {
                stop = 'cap';
                break;
            }
            hpMin = Math.min(hpMin, hp());
            if (site.hpFloor === undefined ? hp() < hp0 : hp() <= site.hpFloor) {
                stop = `lost hitpoints at the fence (${hp()} of ${hp0})`;
                break;
            }
            if (!affordable()) {
                stop = 'supplies';
                break;
            }
            if (s.tick() - quiet > QUIET_TICKS) {
                const cows = (st()?.nearbyNpcs ?? []).filter(n => site.target(n) && n.hp !== 0);
                const said = (st()?.gameMessages ?? []).slice(-1)[0]?.text ?? '';
                quietNote = `cows=${cows.length} reach=${cows.filter(reach).length} players=${(st()?.nearbyPlayers ?? []).length} said=${JSON.stringify(said.slice(0, 60))}`;
                stop = QUIET_STOP;
                break;
            }
            if (!onTile() && (!(await walkPath(walker, [{ ...TILE, tol: 0 }], { maxTicks: 200, stop: () => ended })).ok || !onTile())) {
                throw Error(`splash: fence tile ${TILE.x},${TILE.z} not reached`);
            }
            const inReach = (st()?.nearbyNpcs ?? []).filter(n => site.target(n) && n.hp !== 0 && reach(n));
            const spells = site.bank ? bankedSplashSpells(level(), inv(), activeFreeRunes()) : [spellNow()];
            const pick = pickSplashTarget(inReach, spells, rest, s.tick());
            if (!pick) {
                waited++;
                await waitTicks(s, 1);
                continue;
            }
            const { target: cow, spell } = pick;
            const before = xp();
            const runes = runesHeld();
            const said = refusals();
            await s.direct({ type: 'spellOnNpc', npcIndex: cow.index, spellComponent: componentId(spell.component), reason: 'SDK' });
            await waitUntil(s, () => xp() > before || runesHeld() < runes || refusals() > said || ended, { timeoutTicks: CAST_WAIT });
            if (xp() > before || runesHeld() < runes) {
                casts++;
                quiet = s.tick();
                rest.set(`${cow.index}:${spell.component}`, s.tick() + WEAK_TICKS);
                await waitTicks(s, CAST_GAP);
            } else if (refusals() > said) {
                refused++;
                rest.set(`${cow.index}:${spell.component}`, s.tick() + WEAK_TICKS);
            } else {
                missed++;
                rest.set(`${cow.index}:${spell.component}`, s.tick() + MISS_TICKS);
            }
        }
    } finally {
        if (!ended && site.bank) {
            try {
                await toBank();
                await openBank();
                await depositAll(new Set());
                await closeBank();
            } catch (e) {
                stop = stop ? `${stop}; cleanup ${String(e)}` : `cleanup ${String(e)}`;
            }
        }
    }
    return result();
}

export async function runSplashCli(
    args: readonly string[],
    env: Record<string, string | undefined>,
    defaultSite?: string,
    leaveStarter?: (s: CombatSession, stop: () => boolean) => Promise<void>,
) {
    let s: CombatSession | undefined;
    let stopped = false;
    try {
        const [account, targetArg, capArg] = args;
        const target = targetArg ?? env.TARGET_LEVEL;
        const cap = capArg ?? env.CAP;
        if (!account || !Number.isSafeInteger(Number(target)) || Number(target) < 2 || Number(target) > 99) {
            throw Error('usage: splash <account> <TARGET_LEVEL> [CAP ticks]');
        }
        s = await openBot(account, {
            onStop: async () => {
                stopped = true;
            },
        });
        const stop = () => stopped || existsSync(`.practice/stop-${account}`) || existsSync('.practice/stop-all');
        const r = await runSplash(s, {
            target: Number(target),
            cap: Number(cap ?? 6000),
            stop,
            site: splashSite(env.SPLASH_SITE || defaultSite || undefined),
            leaveStarter,
        });
        console.log('SPLASH_RESULT ' + JSON.stringify(r));
        await finish(
            [s],
            r.ok,
            `mode=splash level=${r.level} gained=${r.gained} xp=${r.xp} casts=${r.casts} refused=${r.refused} missed=${r.missed} waited=${r.waited} hpMin=${r.hpMin} ticks=${r.ticks}${r.stop ? ` stop=${r.stop}` : ''}${r.quiet ? ` ${r.quiet}` : ''}`,
        );
    } catch (e) {
        await finish(s ? [s] : [], false, String(e));
    }
}

// --- Magic order (teleports + Wind Strike NPC + authorized alchemy) ---

export const TELE_RUNE_IDS = { air: AIR, mind: MIND, earth: EARTH, water: WATER, fire: 554, law: 563 } as const;
export type Rune = keyof typeof TELE_RUNE_IDS;
export type RuneCounts = Record<Rune, number>;

export const TELEPORTS = [
    { name: 'camelot', level: 45, xp: 55.5, members: true },
    { name: 'falador', level: 37, xp: 48, members: false },
    { name: 'lumbridge', level: 31, xp: 41, members: false },
    { name: 'varrock', level: 25, xp: 35, members: false },
].map(t => {
    const component = `magic:${t.name}_teleport`;
    const edge = loadTravel().find(e => e.run.how === 'spell' && e.run.component === component);
    if (!edge) throw Error(`missing teleport travel ${component}`);
    const costs = Object.fromEntries(Object.keys(TELE_RUNE_IDS).map(k => [k, edge.runes.find(r => r.item === `${k}rune`)?.count ?? 0])) as RuneCounts;
    return { ...t, component, to: edge.to, costs };
});
export type Teleport = (typeof TELEPORTS)[number];

export function teleportCosts(t: Teleport, worn: readonly { slot: number; id: number }[], members = false): RuneCounts {
    const costs = { ...t.costs };
    const staff = worn.find(i => i.slot === 3)?.id;
    const substitutes: Record<number, Rune> = {
        1381: 'air',
        1383: 'water',
        1385: 'earth',
        1387: 'fire',
        1397: 'air',
        1395: 'water',
        1399: 'earth',
        1393: 'fire',
        1405: 'air',
        1403: 'water',
        1407: 'earth',
        1401: 'fire',
    };
    if (staff !== undefined && (staff <= 1387 || members) && substitutes[staff]) costs[substitutes[staff]!] = 0;
    return costs;
}

export function selectTeleport(level: number, target: number, owned: RuneCounts, worn: readonly { slot: number; id: number }[] = [], members = false) {
    if (level >= target) return undefined;
    return TELEPORTS.find(
        t => level >= t.level && (!t.members || members) && Object.entries(teleportCosts(t, worn, members)).every(([k, n]) => owned[k as Rune] >= n),
    );
}

const SHOP_RUNES = ['air', 'mind', 'earth', 'water', 'fire'] as const;

export function teleportShortfall(xp: number, target: number, maxCasts: number, t: Teleport, costs: RuneCounts, owned: RuneCounts): RuneCounts {
    const casts = Math.min(castsNeeded(xp, target, t.xp, maxCasts), costs.law ? Math.floor(owned.law / costs.law) : maxCasts);
    return Object.fromEntries(Object.keys(TELE_RUNE_IDS).map(k => [k, Math.max(0, casts * costs[k as Rune] - owned[k as Rune])])) as RuneCounts;
}

export function teleportPurchaseCost(
    missing: RuneCounts,
    stock: readonly { id: number; count: number; baseCost: number }[],
    config: { sellMultiplier: number } | undefined,
    allowance: number,
) {
    if (missing.law > 0) return null;
    let total = 0;
    for (const k of SHOP_RUNES) {
        if (!missing[k]) continue;
        const item = stock.find(i => i.id === TELE_RUNE_IDS[k]);
        if (!item || item.count < missing[k] || missing[k] > 1000) return null;
        total += missing[k] * maximumUnitCost(item, config);
    }
    return total <= allowance ? total : null;
}

export function purchaseEffect(
    rune: Rune,
    requested: number,
    before: RuneCounts & { coins: number },
    after: RuneCounts & { coins: number },
    got: { bought: number; spent: number },
    allowance: number,
) {
    return (
        got.bought === requested &&
        requested > 0 &&
        got.spent > 0 &&
        got.spent <= allowance &&
        before.coins - after.coins === got.spent &&
        (Object.keys(TELE_RUNE_IDS) as Rune[]).every(k => after[k] - before[k] === (k === rune ? requested : 0))
    );
}

export type CastEffect = 'cast' | 'none' | 'partial' | 'invalid';

export function teleportEffect(
    t: Teleport,
    costs: RuneCounts,
    before: RuneCounts & { xp: number },
    after: RuneCounts & { xp: number },
    position: { x: number; z: number; level: number },
): CastEffect {
    const deltas = Object.keys(TELE_RUNE_IDS).map(k => before[k as Rune] - after[k as Rune]);
    if (deltas.every(n => n === 0) && after.xp === before.xp) return 'none';
    if (deltas.some((n, i) => n < 0 || n > costs[Object.keys(TELE_RUNE_IDS)[i] as Rune])) return 'invalid';
    return deltas.every((n, i) => n === costs[Object.keys(TELE_RUNE_IDS)[i] as Rune]) &&
        after.xp > before.xp &&
        position.level === t.to.level &&
        Math.max(Math.abs(position.x - t.to.x), Math.abs(position.z - t.to.z)) <= 2
        ? 'cast'
        : 'partial';
}

export const WIND_STRIKE = { level: 1, air: 1, mind: 1, xp: 5.5, component: 'magic:wind_strike' } as const;
type Tile2d = { x: number; z: number };
export const BANKS = { draynor: { x: 3092, z: 3243 }, varrockWest: { x: 3185, z: 3436 }, varrockEast: { x: 3253, z: 3420 } } as const;
export const CLEANUP_BANKS = { falador: { x: 2946, z: 3370 }, seers: { x: 2725, z: 3491 } } as const;
export const CAST_SITE = { x: 3223, z: 3400, tol: 2 };
export const TARGET_AREA = { x0: 3216, x1: 3230, z0: 3391, z1: 3404 };
export const TARGET_NAMES = /^(man|woman|mugger)$/i;
export const PREFERRED_TARGETS = /^(man|woman)$/i;
export const AUBURY = { npc: PROFILES.aubury!.npc, outside: { x: 3253, z: 3398, tol: 1 }, inside: { x: PROFILES.aubury!.npcSpot.x, z: PROFILES.aubury!.npcSpot.z, tol: 1 } };
export const HEALTH = { eatAt: 6, hurtNoFood: 5, critical: 3 };
export const CAST = {
    effectTicks: 12,
    missLimit: 4,
    avoidTicks: 25,
    targetWaitTicks: 50,
    progressTicks: 120,
    bankTicks: 600,
    walkTicks: 900,
    eatTicks: 6,
    eatAttempts: 3,
    quietTicks: 200,
};

export function magicXpForLevel(level: number) {
    if (!Number.isSafeInteger(level) || level < 1 || level > 99) throw Error('invalid Magic level');
    return xpForLevel(level);
}

export interface MagicOptions {
    target: number;
    maxCasts: number;
    cap: number;
    budget: number;
    reserve: number;
    alchItemId?: number;
}

export function magicOptions(env: Record<string, string | undefined> = process.env): MagicOptions {
    const int = (key: string, fallback: number | undefined, min: number, max: number) => {
        const raw = env[key];
        const n = raw === undefined || raw === '' ? fallback : Number(raw);
        if (n === undefined || !Number.isSafeInteger(n) || n < min || n > max) throw Error(`invalid ${key}`);
        return n;
    };
    return {
        target: int('TARGET_LEVEL', undefined, 2, 99),
        maxCasts: int('MAX_CASTS', 1000, 1, 100000),
        cap: int('CAP', 6000, 1, 1000000),
        budget: int('RUNE_BUDGET', 0, 0, 1_000_000_000),
        reserve: int('CASH_RESERVE', 0, 0, 2_000_000_000),
        ...(env.ALCH_ITEM_ID === undefined ? {} : { alchItemId: int('ALCH_ITEM_ID', undefined, 1, 65535) }),
    };
}

export const ALCH_VALUES: Readonly<Record<number, number>> = { 845: 96 };
export type AlchemyState = { item: number; nature: number; fire: number; coins: number; xp: number };

export function alchemyRefusal(level: number, itemId: number, items: number, nature: number, fire: number, fireCost = 5) {
    if (level < 55) return 'high alchemy requires Magic 55';
    if (!ALCH_VALUES[itemId]) return 'unpriced alchemy item';
    return items < 1 || nature < 1 || fire < fireCost ? 'short alchemy supplies' : null;
}

export function alchemyEffect(itemId: number, b: AlchemyState, a: AlchemyState, fireCost = 5): CastEffect {
    if (Object.keys(b).every(k => b[k as keyof AlchemyState] === a[k as keyof AlchemyState])) return 'none';
    return !!ALCH_VALUES[itemId] &&
        b.item - a.item === 1 &&
        b.nature - a.nature === 1 &&
        b.fire - a.fire === fireCost &&
        a.coins - b.coins === ALCH_VALUES[itemId] &&
        Number.isFinite(a.xp) &&
        a.xp > b.xp
        ? 'cast'
        : 'partial';
}

export function magicPreflight(o: Pick<MagicOptions, 'target'>, level: number, plane: number) {
    if (!Number.isSafeInteger(level) || level < 1) return 'Magic state unknown';
    if (level >= o.target) return 'already at target';
    if (plane !== 0) return 'off plane 0';
    return null;
}

const d8 = (a: Tile2d, b: Tile2d) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
export type Region = 'draynor' | 'varrock-west' | 'varrock-east' | 'varrock' | 'falador' | 'seers';

export function startRegion(p: { x: number; z: number; level: number }): Region | null {
    if (p.level !== 0) return null;
    if (d8(p, BANKS.draynor) <= 8) return 'draynor';
    if (d8(p, BANKS.varrockWest) <= 6) return 'varrock-west';
    if (d8(p, BANKS.varrockEast) <= 6) return 'varrock-east';
    if (d8(p, CLEANUP_BANKS.falador) <= 6) return 'falador';
    if (d8(p, CLEANUP_BANKS.seers) <= 6) return 'seers';
    return p.x >= 3170 && p.x <= 3270 && p.z >= 3380 && p.z <= 3450 ? 'varrock' : null;
}

export function draynorToVarrock(): PathPoint[] {
    const draynor = chickenTrainingProfile('draynor').route.map(p => (p.x === 3088 && p.z === 3320 ? { x: 3089, z: 3320, tol: 1 } : p));
    const east = chickenTrainingProfile('varrock').route;
    return [...draynor.slice(1, -1), ...east.slice(0, -2).reverse()];
}

export function spendAllowance(budget: number, spent: number, coins: number, reserve: number) {
    return Math.max(0, Math.min(budget - spent, coins - reserve));
}

export interface CastObservation {
    magic: number;
    hp: number;
}

export function baseXpEstimate(casts: readonly CastObservation[]): number | null {
    const clean = casts.filter(c => c.hp === 0).map(c => c.magic);
    const all = casts.map(c => c.magic);
    const pick = clean.length ? clean : all;
    return pick.length ? Math.min(...pick) : null;
}

export function castsNeeded(xp: number, target: number, base: number | null, castsLeft: number) {
    const missing = magicXpForLevel(target) - xp;
    if (missing <= 0 || castsLeft <= 0) return 0;
    if (base === null || !(base > 0)) return 1;
    return Math.min(castsLeft, Math.ceil(Math.round(missing * 10) / Math.round(base * 10)));
}

export function runeShortfall(casts: number, air: number, mind: number, airCost: number = WIND_STRIKE.air) {
    return { air: Math.max(0, casts * airCost - air), mind: Math.max(0, casts * WIND_STRIKE.mind - mind) };
}

export function affordablePurchase(
    casts: number,
    air: number,
    mind: number,
    unit: { air: number; mind: number },
    allowance: number,
    airCost: number = WIND_STRIKE.air,
) {
    for (let n = casts; n > 0; n--) {
        const s = runeShortfall(n, air, mind, airCost);
        if ((s.air && s.air * unit.air) + (s.mind && s.mind * unit.mind) <= allowance) return { casts: n, ...s };
    }
    return { casts: 0, air: 0, mind: 0 };
}

export function classifyCast(before: { air: number; mind: number; xp: number }, after: { air: number; mind: number; xp: number }, airCost: number = WIND_STRIKE.air): CastEffect {
    const air = before.air - after.air;
    const mind = before.mind - after.mind;
    const xp = after.xp > before.xp;
    if (air === 0 && mind === 0 && !xp) return 'none';
    if (air === airCost && mind === WIND_STRIKE.mind && xp) return 'cast';
    if (air < 0 || mind < 0 || air > airCost || mind > WIND_STRIKE.mind) return 'invalid';
    return 'partial';
}

type MagicNpc = {
    index: number;
    name: string;
    x: number;
    z: number;
    distance: number;
    hp: number | null;
    inCombat: boolean;
    targetIndex?: number;
    reachable?: boolean;
    optionsWithIndex?: { text: string; opIndex: number }[];
};

export function pickMagicTarget(npcs: readonly MagicNpc[], engaged: number, avoid: ReadonlySet<number>, ownPlayer?: number) {
    const A = TARGET_AREA;
    const fit = (n: MagicNpc) =>
        TARGET_NAMES.test(n.name) &&
        (n.hp === null || n.hp > 0) &&
        n.reachable !== false &&
        n.x >= A.x0 &&
        n.x <= A.x1 &&
        n.z >= A.z0 &&
        n.z <= A.z1 &&
        (n.optionsWithIndex ?? []).some(o => /^attack$/i.test(o.text));
    const own = npcs.find(n => (n.index === engaged || (Number.isSafeInteger(ownPlayer) && n.inCombat && n.targetIndex === 32768 + ownPlayer!)) && fit(n));
    if (own) return own;
    const free = npcs.filter(n => fit(n) && !n.inCombat && !avoid.has(n.index)).sort((a, b) => a.distance - b.distance);
    return free.find(n => PREFERRED_TARGETS.test(n.name)) ?? free[0];
}

const AIR_STAFF = /^(staff of air|air battlestaff|mystic air staff)$/i;

export interface MagicResult {
    ok: boolean;
    stop: string;
    target: number;
    level: number;
    casts: number;
    runesUsed: { air: number; mind: number };
    bought: { air: number; mind: number };
    coinsSpent: number;
    magicXpGained: number;
    hpXpGained: number;
    hpMin: number;
    eats: number;
    missing?: { air: number; mind: number };
    banked?: { air: number; mind: number; coins: number };
    failure?: string;
    ticks: number;
    teleportRunesUsed?: RuneCounts;
    teleportRunesBought?: RuneCounts;
    alchemy?: { itemId: number; itemsUsed: number; natureUsed: number; fireUsed: number; coinsGained: number };
}

export async function runMagicOrder(s: CombatSession, o: MagicOptions, stopRequested: () => boolean = () => false): Promise<MagicResult> {
    const start = s.tick();
    let ended = false;
    void s.ended.then(() => {
        ended = true;
    });
    const state = () => s.sdk.getState();
    const pos = () => state()?.player;
    const pack = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const runeCounts = (countFn: (id: number) => number) => Object.fromEntries(Object.entries(TELE_RUNE_IDS).map(([k, id]) => [k, countFn(id)])) as RuneCounts;
    const banked = (id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const magicXp = () => s.sdk.getSkillXp('Magic') ?? NaN;
    const hpXp = () => s.sdk.getSkillXp('Hitpoints') ?? NaN;
    const level = () => s.sdk.getSkill('Magic')?.baseLevel ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const at = () => {
        const p = pos();
        return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null;
    };
    const food = [...questFoodDefinitions().keys()];
    const foodHeld = () => s.sdk.getInventory().some(i => food.includes(i.id));
    const r: MagicResult = {
        ok: false,
        stop: 'entry',
        target: o.target,
        level: 0,
        casts: 0,
        runesUsed: { air: 0, mind: 0 },
        bought: { air: 0, mind: 0 },
        coinsSpent: 0,
        magicXpGained: 0,
        hpXpGained: 0,
        hpMin: 0,
        eats: 0,
        ticks: 0,
    };
    const ready = () => {
        const p = pos();
        const m = s.sdk.getSkill('Magic');
        const h = s.sdk.getSkill('Hitpoints');
        return (
            !!p &&
            p.worldX > 0 &&
            !!m &&
            m.baseLevel > 0 &&
            !!h &&
            h.baseLevel > 0 &&
            Number.isFinite(magicXp()) &&
            Number.isFinite(hpXp()) &&
            Array.isArray(state()?.inventory) &&
            !!s.client &&
            typeof s.client === 'object' &&
            equipmentObserved(s.client)
        );
    };
    if (!(await waitUntil(s, ready, { timeoutTicks: 30 }))) {
        r.stop = 'entry';
        r.failure = 'entry state unobserved';
        return r;
    }
    const xp0 = magicXp();
    const hpXp0 = hpXp();
    r.level = level();
    r.hpMin = hp();
    const project = (list: readonly { slot: number; id: number; count: number }[]) => list.map(({ slot, id, count }) => ({ slot, id, count }));
    console.log(
        'MAGIC_ORDER_INITIAL ' +
            JSON.stringify({
                name: s.name,
                options: o,
                tick: s.tick(),
                position: at(),
                hp: hp(),
                hpBase: s.sdk.getSkill('Hitpoints')?.baseLevel,
                magic: { level: level(), xp: xp0 },
                pack: { air: pack(AIR), mind: pack(MIND), coins: pack(COINS) },
                inventory: project(s.sdk.getInventory()),
                equipment: project(s.sdk.getEquipment()),
            }),
    );
    const refusal = magicPreflight(o, level(), pos()!.level);
    if (refusal) {
        r.stop = refusal;
        r.ticks = s.tick() - start;
        return r;
    }
    let region = startRegion(at()!);
    if (!region) {
        r.stop = 'unsupported start region';
        r.failure = `no checked route from ${JSON.stringify(at())}`;
        return r;
    }
    const airCost = s.sdk.getEquipment().some(i => AIR_STAFF.test(i.name)) ? 0 : WIND_STRIKE.air;
    let stop: string | undefined;
    let eats = 0;
    let coinsWithdrawn = 0;
    let entryCoins = 0;
    let spent = 0;
    let bankOpen = false;
    let moved = false;
    const sustain = startQuestSustain(
        {
            sdk: s.sdk,
            tick: () => s.tick(),
            onTick: cb => s.onTick(cb),
            ended: s.ended,
            direct: async action => (await s.direct(action)) as { success: boolean; message?: string },
        },
        { food, eatAt: 0 },
    );
    const fed = async () => {
        if (ended) return null;
        const e = await eatBetweenCasts(s, { food, eatAt: HEALTH.eatAt, timeoutTicks: CAST.eatTicks, attempts: CAST.eatAttempts });
        if (e) {
            eats++;
            console.log('MAGIC_ORDER_EAT ' + JSON.stringify({ tick: s.tick(), ...e }));
        }
        return e;
    };
    let lastHit = -Infinity;
    let hpPrev = hp();
    const offHp = s.onTick(() => {
        const h = hp();
        const d = pos()?.combat?.lastDamageTick ?? -1;
        r.hpMin = Math.min(r.hpMin, h);
        if (d >= 0 && d > lastHit) lastHit = d;
        if (h < hpPrev) lastHit = Math.max(lastHit, s.tick());
        hpPrev = h;
    });
    const over = () => ended || stopRequested() || s.tick() - start >= o.cap;
    const reason = () => (ended ? 'session ended' : stopRequested() ? 'stop requested' : s.tick() - start >= o.cap ? 'cap' : undefined);
    const hurt = () => {
        const h = hp();
        return h <= HEALTH.critical || (h <= HEALTH.hurtNoFood && !foodHeld());
    };
    let cleanup = false;
    const unsafe = () => (cleanup ? hp() <= HEALTH.critical : hurt());
    const check = () => {
        if (ended) throw Error('session ended');
        if (sustain.failure()) throw Error(sustain.failure()!);
        if (unsafe()) throw Object.assign(Error(`hurt: HP ${hp()} at floor (food ${foodHeld() ? 'held' : 'none'})`), { stop: 'hurt' });
    };
    const walk = async (points: PathPoint[], label: string, budget = CAST.walkTicks, stopOn = over) => {
        check();
        const res = await walkPath(await sessionWalker(s), points, { maxTicks: budget, stop: () => stopOn() || unsafe() || !!sustain.failure() });
        check();
        if (!res.ok) {
            const why = stopOn() ? reason() ?? 'cleanup deadline' : undefined;
            throw Object.assign(Error(`route refusal ${label}: ${res.detail ?? 'walk failed'} at ${JSON.stringify(at())}`), why ? { stop: why } : {});
        }
    };
    let lastBankGeneration = 0;
    let alchemyBankRequested = false;
    let alchemyBankRequestedAt = -Infinity;
    const pendingAlchemyBank = () => state()?.modalInterface === 5292 || !!state()?.bank?.isOpen;
    const alchemyBlocked = () => !pendingAlchemyBank() && (!!state()?.dialog?.isOpen || !!state()?.modalOpen);
    const alchemyInterrupted = () => ended || (!cleanup && over());
    const checkAlchemy = () => {
        check();
        if (alchemyInterrupted()) throw Object.assign(Error(reason() ?? 'stopped'), { stop: reason() });
    };
    const clearAlchemyModal = async (deadline = s.tick() + CAST.effectTicks) => {
        checkAlchemy();
        if (alchemyBlocked()) {
            if (alchemyBankRequested) throw Error('alchemy bank request still pending');
            const sentAt = s.tick();
            await s.direct({ type: 'closeModal', reason: 'SDK' });
            const cleared = await waitUntil(s, () => (s.tick() > sentAt && !alchemyBlocked()) || alchemyInterrupted(), {
                timeoutTicks: Math.max(1, deadline - s.tick()),
            });
            checkAlchemy();
            if (!cleared) throw Error('alchemy modal remained open');
        }
    };
    const openBank = async () => {
        if (r.alchemy && r.casts > 0) {
            const generation = lastBankGeneration;
            const deadline = s.tick() + CAST.effectTicks;
            const fresh = () => !!state()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation;
            while (s.tick() < deadline) {
                checkAlchemy();
                bankOpen = fresh();
                if (bankOpen) {
                    const observedAt = s.tick();
                    await waitUntil(s, () => s.tick() > observedAt || alchemyInterrupted(), { timeoutTicks: Math.max(1, deadline - s.tick()) });
                    checkAlchemy();
                    if (fresh()) {
                        alchemyBankRequested = false;
                        return;
                    }
                    bankOpen = false;
                    alchemyBankRequested = false;
                    continue;
                }
                if (pendingAlchemyBank()) {
                    await waitUntil(s, () => fresh() || !pendingAlchemyBank() || alchemyInterrupted(), {
                        timeoutTicks: Math.max(1, deadline - s.tick()),
                    });
                    checkAlchemy();
                    continue;
                }
                if (alchemyBankRequested && s.tick() < alchemyBankRequestedAt + 3) {
                    await waitUntil(s, () => fresh() || pendingAlchemyBank() || alchemyInterrupted() || s.tick() >= alchemyBankRequestedAt + 3, {
                        timeoutTicks: Math.max(1, deadline - s.tick()),
                    });
                    continue;
                }
                if (!alchemyBankRequested) await clearAlchemyModal(deadline);
                if (!(await waitUntil(s, () => pendingAlchemyBank() || alchemyBankRequested || !alchemyBlocked() || alchemyInterrupted(), { timeoutTicks: Math.max(1, deadline - s.tick()) }))) {
                    break;
                }
                checkAlchemy();
                if (s.tick() >= deadline) break;
                if (pendingAlchemyBank()) continue;
                const booth = state()
                    ?.nearbyLocs.filter(l => l.distance <= 2 && /bank booth|bank chest/i.test(l.name) && !/^closed/i.test(l.name))
                    .sort((a, b) => a.distance - b.distance)
                    .find(l => l.optionsWithIndex.some(opt => /^(bank|use-quickly)$/i.test(opt.text)));
                const option = booth?.optionsWithIndex.find(opt => /^(bank|use-quickly)$/i.test(opt.text));
                const banker = state()?.nearbyNpcs.find(n => n.distance <= 2 && /banker/i.test(n.name) && n.optionsWithIndex.some(opt => /^bank$/i.test(opt.text)));
                const bankOption = banker?.optionsWithIndex.find(opt => /^bank$/i.test(opt.text));
                let reply: { success?: boolean } | undefined;
                if (booth && option) {
                    reply = (await s.direct({ type: 'interactLoc', x: booth.x, z: booth.z, locId: booth.id, optionIndex: option.opIndex, reason: 'SDK' })) as typeof reply;
                } else if (banker && bankOption) {
                    reply = (await s.direct({ type: 'interactNpc', npcIndex: banker.index, optionIndex: bankOption.opIndex, reason: 'SDK' })) as typeof reply;
                } else {
                    throw Error('alchemy bank interaction unavailable');
                }
                alchemyBankRequested = reply?.success !== false;
                alchemyBankRequestedAt = s.tick();
                await waitUntil(s, () => fresh() || pendingAlchemyBank() || alchemyInterrupted() || s.tick() >= alchemyBankRequestedAt + 3, {
                    timeoutTicks: Math.max(1, deadline - s.tick()),
                });
                checkAlchemy();
            }
            throw Error('alchemy bank readiness unobserved within bounded interactions');
        }
        check();
        const generation = s.bankObservation?.()?.generation ?? 0;
        const reply = await s.bot.openBank();
        if (!reply.success || !(await waitUntil(s, () => !!state()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 15 }))) {
            throw Error(`bank observation unavailable: ${reply.message ?? 'open unobserved'}`);
        }
        bankOpen = true;
    };
    const closeBank = async () => {
        if (bankOpen) {
            lastBankGeneration = s.bankObservation?.()?.generation ?? lastBankGeneration;
            await s.bot.closeBank();
            bankOpen = false;
        }
    };
    const withdraw = async (id: number, n: number) => {
        if (n <= 0) return;
        if (r.alchemy && (!state()?.bank?.isOpen || !s.bankObservation?.())) {
            bankOpen = false;
            await openBank();
        }
        const item = state()?.bank?.items.find(i => i.id === id);
        const stored = banked(id);
        const held = pack(id);
        const generation = s.bankObservation?.()?.generation ?? 0;
        if (!item || stored < n) throw Error(`withdraw item${id}: needs ${n}, bank has ${stored}`);
        await s.bot.withdrawItem(item, n);
        if (!(await waitUntil(s, () => pack(id) === held + n && banked(id) === stored - n && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 10 }))) {
            throw Error(`withdraw debit/credit unobserved item${id}`);
        }
    };
    const deposit = async (id: number) => {
        const item = s.sdk.getInventory().find(i => i.id === id);
        return item ? await depositObserved(s, item) : 0;
    };
    const casts: CastObservation[] = [];
    const remaining = () => castsNeeded(magicXp(), o.target, baseXpEstimate(casts), o.maxCasts - r.casts);
    const secure = async () => {
        if (r.alchemy) {
            if (!moved || ended || hp() <= HEALTH.critical) return;
            cleanup = true;
            bankOpen = !!state()?.bank?.isOpen && !!s.bankObservation?.();
            if (!bankOpen || r.casts > 0) await openBank();
            for (const id of [r.alchemy.itemId, 561, 554, COINS]) await deposit(id);
            await closeBank();
            return;
        }
        const carried = (r.teleportRunesUsed ? Object.values(TELE_RUNE_IDS) : [AIR, MIND]).reduce((n, id) => n + pack(id), 0) + (coinsWithdrawn > 0 ? pack(COINS) : 0);
        if (!moved || !carried || ended || hp() <= HEALTH.critical) return;
        cleanup = true;
        const deadline = s.tick() + CAST.bankTicks;
        const late = () => ended || s.tick() >= deadline;
        if (!bankOpen) {
            if (s.sdk.getState()?.shop?.isOpen) await s.bot.closeShop();
            let p = at()!;
            if (r.teleportRunesUsed) {
                const landing = TELEPORTS.find(t => p.level === t.to.level && d8(p, t.to) <= 2);
                if (landing?.name === 'lumbridge') {
                    await walk(LUMBRIDGE_TO_DRAYNOR.map(([x, z, tol]) => ({ x, z, tol })), 'Lumbridge to Draynor bank', CAST.bankTicks, late);
                    p = at()!;
                } else if (landing?.name === 'falador') {
                    await walk([{ x: 2946, z: 3368, tol: 2 }, { x: 2946, z: 3370, tol: 2 }], 'Falador bank', CAST.bankTicks, late);
                    await openBank();
                } else if (landing?.name === 'camelot') {
                    await walk([{ x: 2726, z: 3485, tol: 2 }, { x: 2725, z: 3491, tol: 2 }], 'Seers bank', CAST.bankTicks, late);
                    await openBank();
                }
            }
            const home = d8(p, BANKS.draynor) <= 30 ? BANKS.draynor : !startRegion(p) ? undefined : d8(p, BANKS.varrockWest) <= 6 ? BANKS.varrockWest : BANKS.varrockEast;
            if (!bankOpen) {
                if (!home) {
                    r.failure = (r.failure ? r.failure + '; ' : '') + 'leftover runes carried: no checked route to a bank';
                    return;
                }
                if (d8(p, home) > 2) await walk([{ ...home, tol: 2 }], 'bank leftovers', CAST.bankTicks, late);
                await openBank();
            }
        }
        const b = { air: await deposit(AIR), mind: await deposit(MIND), coins: coinsWithdrawn > 0 ? await deposit(COINS) : 0 };
        if (r.teleportRunesUsed) for (const id of [EARTH, WATER, 554, 563]) await deposit(id);
        r.banked = b;
        console.log('MAGIC_ORDER_BANKED ' + JSON.stringify({ tick: s.tick(), ...b, bank: { air: banked(AIR), mind: banked(MIND), coins: banked(COINS) } }));
        await closeBank();
    };
    const disengage = async () => {
        if (ended) return;
        const q = await awaitLogoutQuiet(s, {
            lastHit: () => lastHit,
            timeoutTicks: CAST.quietTicks,
            between: async () => {
                if (!ended && foodHeld()) await fed();
            },
            retreat: async () => {
                if (state()?.shop?.isOpen) await s.bot.closeShop();
                await closeBank();
                const p = at();
                if (!p || !startRegion(p) || startRegion(p) === 'draynor' || d8(p, BANKS.varrockEast) <= 2) return;
                const deadline = s.tick() + CAST.walkTicks;
                await walkPath(await sessionWalker(s), [{ ...BANKS.varrockEast, tol: 2 }], { maxTicks: CAST.walkTicks, stop: () => ended || s.tick() >= deadline });
            },
        });
        console.log('MAGIC_ORDER_DISENGAGE ' + JSON.stringify({ tick: s.tick(), ...q, lastHit: Number.isFinite(lastHit) ? lastHit : null, position: at(), hp: hp() }));
        if (!q.quiet && !ended) throw Error(`combat continued ${q.ticks} ticks: last hit at tick ${lastHit}, logout window not reached`);
    };
    try {
        r.stop = 'entry-bank';
        if (o.alchItemId === undefined && (region === 'falador' || region === 'seers')) {
            const movedWorld = await goTo(s, await getWorld(), { ...BANKS.varrockEast, level: 0 }, accountOf(s), { legTimeoutTicks: 100 });
            if (!movedWorld.ok) throw Error(`no route from the ${region} cleanup bank to Varrock East bank: ${JSON.stringify(movedWorld)}`);
            region = 'varrock-east';
        }
        if (region === 'varrock') await walk([{ ...BANKS.varrockEast, tol: 2 }], 'entry bank');
        await openBank();
        const owned = { air: pack(AIR) + banked(AIR), mind: pack(MIND) + banked(MIND), coins: pack(COINS) + banked(COINS) };
        entryCoins = owned.coins;
        const allowance0 = spendAllowance(o.budget, 0, owned.coins, o.reserve);
        console.log(
            'MAGIC_ORDER_ENTRY ' +
                JSON.stringify({
                    tick: s.tick(),
                    region,
                    position: at(),
                    hp: hp(),
                    magic: { level: level(), xp: xp0 },
                    owned,
                    pack: { air: pack(AIR), mind: pack(MIND), coins: pack(COINS) },
                    bank: { air: banked(AIR), mind: banked(MIND), coins: banked(COINS) },
                    allowance: allowance0,
                    airCost,
                }),
        );
        if (o.alchItemId !== undefined) {
            const itemId = o.alchItemId;
            const members = (s.client as { membersAccount?: number } | undefined)?.membersAccount === 1;
            const fireCost = teleportCosts({ ...TELEPORTS[0]!, costs: { air: 0, mind: 0, earth: 0, water: 0, fire: 5, law: 0 } }, s.sdk.getEquipment(), members).fire;
            const why = alchemyRefusal(Math.min(level(), s.sdk.getSkill('Magic')?.level ?? 0), itemId, pack(itemId) + banked(itemId), pack(561) + banked(561), pack(554) + banked(554), fireCost);
            if (why) {
                r.stop = why;
                await closeBank();
                return r;
            }
            r.alchemy = { itemId, itemsUsed: 0, natureUsed: 0, fireUsed: 0, coinsGained: 0 };
            const assetTotals = () => {
                const m = new Map<number, number>();
                for (const i of [...s.sdk.getInventory(), ...(s.bankObservation?.()?.items ?? []), ...s.sdk.getEquipment()]) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
                return m;
            };
            const assets = assetTotals();
            const equipment = JSON.stringify(project(s.sdk.getEquipment()));
            moved = true;
            for (const id of new Set(s.sdk.getInventory().map(i => i.id))) await deposit(id);
            const limit = Math.min(o.maxCasts, castsNeeded(magicXp(), o.target, 65, o.maxCasts), banked(itemId), banked(561), fireCost ? Math.floor(banked(554) / fireCost) : o.maxCasts);
            await withdraw(561, limit);
            if (fireCost) await withdraw(554, limit * fireCost);
            await closeBank();
            const snapshot = (): AlchemyState => ({ item: pack(itemId), nature: pack(561), fire: pack(554), coins: pack(COINS), xp: magicXp() });
            while (level() < o.target) {
                if (over()) {
                    stop = reason();
                    break;
                }
                check();
                if (r.casts >= o.maxCasts) {
                    stop = 'max casts';
                    break;
                }
                if (randomEventsOf(s)?.busy()) {
                    await waitTicks(s, 1);
                    continue;
                }
                if (pack(561) < 1 || pack(554) < fireCost) {
                    stop = 'alchemy supply exhaustion';
                    break;
                }
                if (!pack(itemId)) {
                    await openBank();
                    if (banked(itemId) < 1) {
                        stop = 'alchemy supply exhaustion';
                        await closeBank();
                        break;
                    }
                    await withdraw(itemId, 1);
                    await closeBank();
                }
                await clearAlchemyModal();
                if (over()) {
                    stop = reason();
                    break;
                }
                check();
                const item = s.sdk.getInventory().find(i => i.id === itemId);
                if (!item) throw Error('selected alchemy item unobserved');
                const before = snapshot();
                const reply = (await s.direct({ type: 'spellOnItem', slot: item.slot, spellComponent: componentId('magic:highlvl_alchemy'), reason: 'SDK' })) as { success?: boolean } | undefined;
                if (reply?.success === false) throw Error('alchemy dispatch refused');
                await waitUntil(s, () => ended || over() || (alchemyEffect(itemId, before, snapshot(), fireCost) !== 'none' && pos()?.animId === -1), { timeoutTicks: CAST.effectTicks });
                check();
                const after = snapshot();
                const effect = alchemyEffect(itemId, before, after, fireCost);
                if (effect !== 'cast' || pos()?.animId !== -1) throw Error(`alchemy effect ${effect}: ${JSON.stringify({ before, after, animation: pos()?.animId })}`);
                r.casts++;
                r.alchemy.itemsUsed++;
                r.alchemy.natureUsed++;
                r.alchemy.fireUsed += fireCost;
                r.alchemy.coinsGained += ALCH_VALUES[itemId]!;
                console.log('MAGIC_ORDER_CAST ' + JSON.stringify({ tick: s.tick(), cast: r.casts, spell: 'highlvl_alchemy', itemId, fireCost, before, after, position: at(), magic: { level: level(), xp: after.xp } }));
            }
            r.stop = level() >= o.target ? 'target' : stop ?? 'stopped';
            await openBank();
            for (const id of [itemId, 561, 554, COINS]) await deposit(id);
            const final = assetTotals();
            const debits = new Map([[itemId, r.casts], [561, r.casts], [554, r.alchemy.fireUsed], [COINS, -r.alchemy.coinsGained]]);
            if ([...new Set([...assets.keys(), ...final.keys()])].some(id => (assets.get(id) ?? 0) - (final.get(id) ?? 0) !== (debits.get(id) ?? 0)) || equipment !== JSON.stringify(project(s.sdk.getEquipment()))) {
                throw Error('alchemy asset reconciliation failed');
            }
            await closeBank();
            moved = false;
        } else {
            let members = (s.client as { membersAccount?: number } | undefined)?.membersAccount === 1;
            const worn = () => s.sdk.getEquipment();
            const totalRunes = runeCounts(id => pack(id) + banked(id));
            const availableLevel = Math.min(level(), s.sdk.getSkill('Magic')?.level ?? 0);
            const first =
                selectTeleport(availableLevel, o.target, totalRunes, worn(), members) ??
                (allowance0 > 0 ? TELEPORTS.find(t => availableLevel >= t.level && (!t.members || members) && totalRunes.law >= teleportCosts(t, worn(), members).law) : undefined);
            if (first) {
                const missing = teleportShortfall(magicXp(), o.target, o.maxCasts, first, teleportCosts(first, worn(), members), totalRunes);
                const shopNeeded = allowance0 > 0 && SHOP_RUNES.some(k => missing[k] > 0);
                r.teleportRunesUsed = runeCounts(() => 0);
                r.teleportRunesBought = runeCounts(() => 0);
                moved = true;
                for (const id of new Set(s.sdk.getInventory().map(i => i.id))) {
                    if (!(Object.values(TELE_RUNE_IDS) as number[]).includes(id)) {
                        if (over()) throw Object.assign(Error(reason() ?? 'stopped'), { stop: reason() });
                        const item = s.sdk.getInventory().find(i => i.id === id);
                        if (item) await depositObserved(s, item);
                    }
                }
                for (const id of Object.values(TELE_RUNE_IDS)) await withdraw(id, banked(id));
                if (shopNeeded) {
                    coinsWithdrawn = Math.min(banked(COINS), Math.max(0, allowance0 - pack(COINS)));
                    await withdraw(COINS, coinsWithdrawn);
                }
                await closeBank();
                r.stop = 'casting';
                if (shopNeeded) {
                    r.stop = 'teleport supplies';
                    if (region === 'draynor') await walk(draynorToVarrock(), 'Draynor to Varrock East bank');
                    await walk([AUBURY.outside, AUBURY.inside], 'Aubury shop');
                    check();
                    const npc = state()?.nearbyNpcs.find(n => AUBURY.npc.test(n.name));
                    const opened = npc ? await s.bot.openShop(npc) : undefined;
                    if (!opened?.success) throw Error('Aubury shop unavailable');
                    try {
                        await waitUntil(
                            s,
                            stCur => {
                                check();
                                return (
                                    over() ||
                                    (!!stCur.shop?.isOpen &&
                                        teleportPurchaseCost(missing, stCur.shop.shopItems, stCur.shop.shopConfig, spendAllowance(o.budget, spent, entryCoins - spent, o.reserve)) !== null)
                                );
                            },
                            { timeoutTicks: 10 },
                        );
                        check();
                        const shop = state()?.shop;
                        const allowance = spendAllowance(o.budget, spent, entryCoins - spent, o.reserve);
                        const cost = shop?.isOpen ? teleportPurchaseCost(missing, shop.shopItems, shop.shopConfig, allowance) : null;
                        console.log('MAGIC_ORDER_QUOTE ' + JSON.stringify({ tick: s.tick(), missing, allowance, cost, isOpen: !!shop?.isOpen, shelf: shop?.shopItems ?? [], shopConfig: shop?.shopConfig }));
                        if (over()) throw Object.assign(Error(reason() ?? 'stopped'), { stop: reason() });
                        if (cost === null) throw Error('Aubury teleport stock or budget shortfall');
                        for (const k of SHOP_RUNES) {
                            const amount = missing[k];
                            if (amount <= 0) continue;
                            check();
                            const before = { ...runeCounts(pack), coins: pack(COINS) };
                            const left = spendAllowance(o.budget, spent, entryCoins - spent, o.reserve);
                            const name = k[0]!.toUpperCase() + k.slice(1) + ' rune';
                            const got = await buyWithBudget(s.bot, s.sdk, name, amount, Math.max(0, pack(COINS) - left), left);
                            const after = { ...runeCounts(pack), coins: pack(COINS) };
                            spent += got.spent;
                            r.coinsSpent = spent;
                            r.teleportRunesBought[k] += got.bought;
                            if (k === 'air' || k === 'mind') r.bought[k] += got.bought;
                            console.log(
                                'MAGIC_ORDER_PURCHASE ' +
                                    JSON.stringify({
                                        tick: s.tick(),
                                        rune: name,
                                        requested: amount,
                                        ...got,
                                        packBefore: before,
                                        packAfter: after,
                                        coinsAfter: after.coins,
                                        missing,
                                        allowance: left,
                                        totalSpent: spent,
                                    }),
                            );
                            if (!purchaseEffect(k, amount, before, after, got, left)) throw Error(`${name} exact purchase accounting failed`);
                        }
                    } finally {
                        await s.bot.closeShop();
                    }
                    await walk([AUBURY.outside], 'Aubury exit');
                    r.stop = 'casting';
                }
                let misses = 0;
                while (level() < o.target) {
                    if (over()) {
                        stop = reason();
                        break;
                    }
                    check();
                    if (r.casts >= o.maxCasts) {
                        stop = 'max casts';
                        break;
                    }
                    if (randomEventsOf(s)?.busy()) {
                        await waitTicks(s, 1);
                        continue;
                    }
                    if (await fed()) continue;
                    const spell = selectTeleport(Math.min(level(), s.sdk.getSkill('Magic')?.level ?? 0), o.target, runeCounts(pack), worn(), members);
                    if (!spell) {
                        stop = 'teleport rune exhaustion';
                        break;
                    }
                    let costs = teleportCosts(spell, worn(), members);
                    if (state()?.dialog?.isOpen || state()?.modalOpen) {
                        await s.direct({ type: 'closeModal', reason: 'SDK' });
                        if (!(await waitUntil(s, stCur => !stCur?.dialog?.isOpen && !stCur?.modalOpen, { timeoutTicks: CAST.effectTicks }))) {
                            throw Error('teleport modal remained open');
                        }
                    }
                    if (over()) {
                        stop = reason();
                        break;
                    }
                    check();
                    const before = { ...runeCounts(pack), xp: magicXp() };
                    const reply = (await s.direct({ type: 'clickComponent', componentId: componentId(spell.component), reason: 'SDK' })) as { success?: boolean } | undefined;
                    if (reply?.success === false) throw Error('teleport dispatch refused');
                    await waitUntil(s, () => ended || over() || (teleportEffect(spell, costs, before, { ...runeCounts(pack), xp: magicXp() }, at()!) === 'cast' && pos()?.animId === -1), {
                        timeoutTicks: CAST.effectTicks,
                    });
                    check();
                    const after = { ...runeCounts(pack), xp: magicXp() };
                    let effect = teleportEffect(spell, costs, before, after, at()!);
                    if (effect !== 'cast' && members && !spell.members) {
                        const freeCosts = teleportCosts(spell, worn(), false);
                        if (teleportEffect(spell, freeCosts, before, after, at()!) === 'cast') {
                            costs = freeCosts;
                            members = false;
                            effect = 'cast';
                        }
                    }
                    if (effect === 'none' && members && !over()) {
                        members = false;
                        continue;
                    }
                    if (effect === 'none' && !over() && ++misses < CAST.missLimit) continue;
                    if (effect !== 'cast' || pos()?.animId !== -1) throw Error(`teleport effect ${effect}: ${JSON.stringify({ spell: spell.name, before, after, position: at() })}`);
                    misses = 0;
                    r.casts++;
                    for (const k of Object.keys(TELE_RUNE_IDS) as Rune[]) r.teleportRunesUsed[k] += costs[k];
                    r.runesUsed.air += costs.air;
                    r.runesUsed.mind += costs.mind;
                    console.log(
                        'MAGIC_ORDER_CAST ' +
                            JSON.stringify({ tick: s.tick(), cast: r.casts, spell: spell.name, costs, before, after, position: at(), gain: { magic: after.xp - before.xp, hp: 0 }, magic: { level: level(), xp: after.xp } }),
                    );
                }
                r.stop = level() >= o.target ? 'target' : stop ?? 'stopped';
            } else {
                const short = runeShortfall(1, owned.air, owned.mind, airCost);
                if ((short.air || short.mind) && (o.budget === 0 || allowance0 <= 0)) {
                    r.stop = 'short runes';
                    r.missing = short;
                    await closeBank();
                    return r;
                }
                r.stop = 'withdraw';
                moved = true;
                await withdraw(AIR, banked(AIR));
                await withdraw(MIND, banked(MIND));
                coinsWithdrawn = Math.min(banked(COINS), Math.max(0, allowance0 - pack(COINS)));
                await withdraw(COINS, coinsWithdrawn);
                await closeBank();
                r.stop = 'travel';
                if (region === 'draynor') await walk(draynorToVarrock(), 'Draynor to Varrock East bank');
                await walk([CAST_SITE], 'cast site');
                const buy = async () => {
                    const need = remaining();
                    const air = pack(AIR);
                    const mind = pack(MIND);
                    const allowance = spendAllowance(o.budget, spent, entryCoins - spent, o.reserve);
                    const missing = runeShortfall(need, air, mind, airCost);
                    if (allowance <= 0) {
                        r.missing = missing;
                        return false;
                    }
                    await walk([AUBURY.outside, AUBURY.inside], 'Aubury shop');
                    const npc = state()?.nearbyNpcs.find(n => AUBURY.npc.test(n.name));
                    const opened = npc ? await s.bot.openShop(npc) : undefined;
                    if (!opened?.success || !(await waitUntil(s, () => !!state()?.shop?.isOpen, { timeoutTicks: 10 }))) {
                        throw Error(`Aubury shop unavailable: ${opened?.message ?? 'Aubury unobserved'}`);
                    }
                    try {
                        const shop = state()!.shop!;
                        const line = (name: string) => shop.shopItems.find(i => i.name.toLowerCase() === name);
                        const unitOf = (name: string) => {
                            const l = line(name);
                            return l && l.count > 0 ? maximumUnitCost(l, shop.shopConfig) : Infinity;
                        };
                        const plan = affordablePurchase(need, air, mind, { air: unitOf('air rune'), mind: unitOf('mind rune') }, allowance, airCost);
                        if (plan.casts <= Math.min(airCost ? air / airCost : Infinity, mind)) {
                            r.missing = missing;
                            return false;
                        }
                        for (const [id, name, amount] of [[MIND, 'Mind rune', plan.mind], [AIR, 'Air rune', plan.air]] as const) {
                            if (amount <= 0) continue;
                            check();
                            const before = { air: pack(AIR), mind: pack(MIND), coins: pack(COINS) };
                            const left = spendAllowance(o.budget, spent, entryCoins - spent, o.reserve);
                            const got = await buyWithBudget(s.bot, s.sdk, name, amount, pack(COINS) - Math.min(pack(COINS), left), left);
                            spent += got.spent;
                            r.coinsSpent = spent;
                            if (id === AIR) r.bought.air += got.bought;
                            else r.bought.mind += got.bought;
                            console.log(
                                'MAGIC_ORDER_PURCHASE ' +
                                    JSON.stringify({ tick: s.tick(), rune: name, requested: amount, bought: got.bought, spent: got.spent, packBefore: before, coinsAfter: pack(COINS), need, estimate: baseXpEstimate(casts), allowance: left, totalSpent: spent }),
                            );
                            if (got.bought <= 0) throw Error(`${name} purchase effect unobserved`);
                        }
                    } finally {
                        await s.bot.closeShop();
                    }
                    await walk([AUBURY.outside, CAST_SITE], 'cast site after shop');
                    return true;
                };
                const avoid = new Map<number, number>();
                let misses = 0;
                let idle = 0;
                let lastCast = s.tick();
                const castOnce = async () => {
                    check();
                    for (const [index, until] of avoid) if (s.tick() >= until) avoid.delete(index);
                    const p = at()!;
                    if (d8(p, CAST_SITE) > 8) await walk([CAST_SITE], 'return to cast site');
                    if (state()?.dialog?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                    const combat = pos()?.combat;
                    const engaged = combat?.targetType === 'npc' ? combat.targetIndex : -1;
                    const target = pickMagicTarget((state()?.nearbyNpcs ?? []) as MagicNpc[], engaged, new Set(avoid.keys()), (s.client as { selfSlot?: number })?.selfSlot);
                    if (!target) {
                        if (++idle >= CAST.targetWaitTicks) {
                            console.log(
                                'MAGIC_ORDER_TARGET_STALL ' +
                                    JSON.stringify({
                                        tick: s.tick(),
                                        position: at(),
                                        idle,
                                        engaged,
                                        ownPlayer: (s.client as { selfSlot?: number })?.selfSlot ?? null,
                                        avoid: [...avoid.keys()],
                                        area: TARGET_AREA,
                                        nearbyNpcs: (state()?.nearbyNpcs ?? []).map(n => ({
                                            index: n.index,
                                            name: n.name,
                                            x: n.x,
                                            z: n.z,
                                            hp: n.hp,
                                            inCombat: n.inCombat,
                                            reachable: n.reachable ?? null,
                                            optionsWithIndex: n.optionsWithIndex ?? null,
                                        })),
                                    }),
                            );
                            throw Object.assign(Error('combat stall: no safe target near the cast site'), { stop: 'combat stall' });
                        }
                        await waitTicks(s, 1);
                        return;
                    }
                    idle = 0;
                    if (await fed()) return;
                    const before = { air: pack(AIR), mind: pack(MIND), xp: magicXp() };
                    const hp0 = hpXp();
                    const reply = (await s.direct({ type: 'spellOnNpc', npcIndex: target.index, spellComponent: componentId(WIND_STRIKE.component), reason: 'SDK' })) as { success?: boolean } | undefined;
                    if (reply && reply.success === false) throw Error(`cast dispatch refused ${JSON.stringify(reply)}`);
                    await waitUntil(s, () => ended || classifyCast(before, { air: pack(AIR), mind: pack(MIND), xp: magicXp() }, airCost) !== 'none', { timeoutTicks: CAST.effectTicks });
                    await waitTicks(s, 1);
                    check();
                    const after = { air: pack(AIR), mind: pack(MIND), xp: magicXp() };
                    const effect = classifyCast(before, after, airCost);
                    if (effect === 'cast') {
                        const gain = { magic: Math.round((after.xp - before.xp) * 10) / 10, hp: Math.round((hpXp() - hp0) * 10) / 10 };
                        casts.push(gain);
                        r.casts++;
                        r.runesUsed.air += airCost;
                        r.runesUsed.mind++;
                        misses = 0;
                        lastCast = s.tick();
                        console.log(
                            'MAGIC_ORDER_CAST ' +
                                JSON.stringify({ tick: s.tick(), cast: r.casts, position: at(), target: { index: target.index, name: target.name }, gain, magic: { level: level(), xp: after.xp }, pack: { air: after.air, mind: after.mind }, hp: hp(), purchased: r.bought.air + r.bought.mind > 0 }),
                        );
                        return;
                    }
                    if (effect !== 'none') throw Error(`cast effect ${effect}: ${JSON.stringify({ before, after })}`);
                    avoid.set(target.index, s.tick() + CAST.avoidTicks);
                    if (++misses >= CAST.missLimit || s.tick() - lastCast >= CAST.progressTicks) {
                        throw Object.assign(Error(`combat stall: ${misses} casts without effect, last target ${target.name}`), { stop: 'combat stall' });
                    }
                };
                r.stop = 'casting';
                while (level() < o.target) {
                    if (over()) {
                        stop = reason();
                        break;
                    }
                    check();
                    if (r.casts >= o.maxCasts) {
                        stop = 'max casts';
                        break;
                    }
                    if (randomEventsOf(s)?.busy()) {
                        await waitTicks(s, 1);
                        continue;
                    }
                    if (await fed()) continue;
                    if (pack(MIND) < WIND_STRIKE.mind || pack(AIR) < airCost) {
                        if (!(await buy())) {
                            stop = 'rune exhaustion';
                            break;
                        }
                        continue;
                    }
                    await castOnce();
                }
                r.stop = level() >= o.target ? 'target' : stop ?? 'stopped';
                if (r.stop === 'rune exhaustion') r.missing = runeShortfall(remaining(), pack(AIR), pack(MIND), airCost);
            }
        }
    } catch (error) {
        r.failure = String(error);
        r.stop = (error as { stop?: string }).stop ?? (ended ? 'session ended' : 'failure');
    } finally {
        try {
            await secure();
        } catch (error) {
            r.failure = (r.failure ? r.failure + '; ' : '') + 'secure: ' + String(error);
        }
        try {
            await disengage();
        } catch (error) {
            r.failure = (r.failure ? r.failure + '; ' : '') + 'disengage: ' + String(error);
        }
        try {
            await sustain.settle();
        } catch {}
        offHp();
    }
    r.eats = eats;
    r.level = level();
    r.magicXpGained = Math.round((magicXp() - xp0) * 10) / 10;
    r.hpXpGained = Math.round((hpXp() - hpXp0) * 10) / 10;
    r.ticks = s.tick() - start;
    r.ok =
        r.stop === 'target' &&
        r.level >= o.target &&
        r.casts > 0 &&
        !r.failure &&
        (r.alchemy ? [r.alchemy.itemId, 561, 554, COINS] : r.teleportRunesUsed ? Object.values(TELE_RUNE_IDS) : [AIR, MIND]).every(id => pack(id) === 0);
    return r;
}

export async function runMagicOrderCli(account: string, env: Record<string, string | undefined>) {
    let s: CombatSession | undefined;
    let stopped = false;
    try {
        if (!account || !/^[a-z0-9]{1,12}$/i.test(account)) throw Error('usage: magic-order <account>');
        const o = magicOptions(env);
        s = await openBot(account, {
            onStop: async () => {
                stopped = true;
            },
        });
        const r = await runMagicOrder(s, o, () => stopped);
        console.log('MAGIC_ORDER_RESULT ' + JSON.stringify(r));
        await finish(
            [s],
            r.ok,
            `magic-order ${r.stop} level=${r.level} target=${r.target} casts=${r.casts} spent=${r.coinsSpent}${r.missing ? ` missing air=${r.missing.air} mind=${r.missing.mind}` : ''}${r.failure ? ` failure=${r.failure}` : ''}`,
        );
    } catch (error) {
        await finish(s ? [s] : [], false, String(error));
    }
}
