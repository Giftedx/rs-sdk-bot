// Unified magic worker: item magic, teleports, magic-trip, orbs, orb-trip, bones-to-bananas, earth-production, and alch-train.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountOf, countItems, finish, getWorld, openBot, sessionDied, settle } from '../../../core/src/bot';
import { bankTravelTolerance, fittingBankBatch, validateBankRouteJob, type BankProfile, type BankRouteJob } from '../../../core/src/bank-trip';
import { objId } from '../../../core/src/content-facts';
import { equipmentObserved } from '../../../core/src/container-observation';
import { depositObserved } from '../../../core/src/deposit';
import { withDoorPolicy } from '../../../core/src/door-policy';
import { componentId } from '../../../core/src/logout';
import { nativeNpcSpell as coreNativeNpcSpell } from '../../../core/src/magic-data';
import { questFoodDefinitions, startQuestSustain } from '../../../core/src/sustain';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { loadTravel } from '../../../core/src/travel';
import { applyKnownDoorBlocks, goTo, sessionWalker, walkPath, walkRoute } from '../../../core/src/walk';
import { interactionApproach } from '../../../core/src/world';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import type { NearbyPlayer } from '../../../../vendor/rs-sdk/sdk/types';
import {
    alchCasts,
    bestElementalStaffForRunes,
    CAST_XP,
    CONTENT_DIR,
    FIRE_PER,
    HIGH_LEVEL,
    itemStackable,
    KNOWLEDGE_DIR,
    packMap,
    readSkillLevels,
    xpForLevel,
} from './catalog';
import {
    actionSessionOwner,
    atNorthBank,
    COW_NORTH_BANK,
    finishActionSession,
    installSpellLocBridge,
    nearestBank,
    productionStopRequested,
    runArtisanBankProfile,
    watchProductionLife,
} from './runtime';
import {
    BONES_PER_CAST,
    BONES_TO_BANANAS_RUNES,
    itemMagicRecipe,
    nativeTeleport,
    type ItemMagicRecipe,
    type NativeTeleport,
    type Recipe,
} from './recipes';
import type { ArtisanExternalDeps, Session } from './types';

export {
    alchCasts,
    BONES_PER_CAST,
    BONES_TO_BANANAS_RUNES,
    CAST_XP,
    HIGH_LEVEL,
    itemMagicRecipe,
    nativeTeleport,
    type ItemMagicRecipe,
    type NativeTeleport,
    type Recipe,
};

const textsCache = new Map<string, string>();
const parsedBlocksCache = new Map<string, { name: string; body: string }[]>();
const readCached = (file: string) => {
    let t = textsCache.get(file);
    if (t === undefined) {
        t = readFileSync(file, 'utf8');
        textsCache.set(file, t);
    }
    return t;
};
const parseCfgBlocks = (text: string) => [...text.matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)].map(m => ({ name: m[1]!, body: m[2]! }));
const blocksOf = (file: string) => {
    let b = parsedBlocksCache.get(file);
    if (!b) {
        b = parseCfgBlocks(readCached(file));
        parsedBlocksCache.set(file, b);
    }
    return b;
};

// ---- Item Magic (microbot-magic-items.ts) ----

const SPELL_SCRIPTS: Record<string, [string, string]> = {
    'low-alch': ['alchemy.rs2', 'magic_spell_low_alch'],
    'high-alch': ['alchemy.rs2', 'magic_spell_high_alch'],
    superheat: ['superheat.rs2', 'magic_spell_superheat'],
    enchant: ['enchant.rs2', 'magic_spell_enchant'],
};

export function spellDelay(mode: string): number {
    const [file, label] = SPELL_SCRIPTS[mode.split(':')[0]!] ?? [];
    if (!file) throw Error('unsupported item magic mode');
    const lines = readCached(join(CONTENT_DIR, 'scripts/skill_magic/scripts/spells', file)).split(/\r?\n/);
    const from = lines.findIndex(l => l.startsWith('[label,' + label + ']'));
    if (from < 0) throw Error('missing native spell script ' + label);
    for (let i = from + 1; i < lines.length && !lines[i]!.startsWith('['); i++) {
        const m = lines[i]!.match(/^p_delay\((\d+)\);/);
        if (m) return Number(m[1]);
    }
    throw Error('missing native spell delay ' + label);
}

let staffRunesCache: Map<number, { runes: Set<number>; members: boolean }> | undefined;
function nativeStaffRunes() {
    if (staffRunesCache) return staffRunesCache;
    staffRunesCache = new Map();
    const definitions = new Map<string, string>();
    const combatMagicDir = join(CONTENT_DIR, 'scripts/skill_combat/configs/magic');
    for (const file of ['staves.obj', 'battlestaves.obj', 'mysticstaves.obj']) {
        for (const row of parseCfgBlocks(readFileSync(join(combatMagicDir, file), 'utf8'))) definitions.set(row.name, row.body);
    }
    for (const row of parseCfgBlocks(readFileSync(join(CONTENT_DIR, 'scripts/skill_magic/configs/magic_staff.dbrow'), 'utf8'))) {
        const rune = row.body.match(/^data=rune,(\w+)/m)?.[1];
        if (!rune) continue;
        for (const match of row.body.matchAll(/^data=staff,(\w+)/gm)) {
            const name = match[1]!;
            const body = definitions.get(name);
            if (!body) throw Error('missing native staff object ' + name);
            const id = objId(name);
            const entry = staffRunesCache.get(id) ?? { runes: new Set<number>(), members: /^members=yes\s*$/m.test(body) };
            entry.runes.add(objId(rune));
            staffRunesCache.set(id, entry);
        }
    }
    return staffRunesCache;
}

export function elementalRuneCost(runeId: number, quantity: number, worn: readonly { id: number; slot: number }[], members = false) {
    const id = worn.find(i => i.slot === 3)?.id;
    const staff = id === undefined ? undefined : nativeStaffRunes().get(id);
    return staff && (!staff.members || members) && staff.runes.has(runeId) ? 0 : quantity;
}

export function itemSpellCosts(recipe: ItemMagicRecipe, worn: readonly { id: number; slot: number }[], members = false) {
    return Object.fromEntries(
        Object.entries(recipe.inputs)
            .map(([id, n]) => {
                const target = Number(id) === recipe.target ? 1 : 0;
                return [id, target + elementalRuneCost(Number(id), n - target, worn, members)];
            })
            .filter(([, n]) => Number(n) > 0),
    ) as Record<number, number>;
}

export function itemSpellEffect(
    recipe: ItemMagicRecipe,
    costs: Record<number, number>,
    before: Record<number, number>,
    after: Record<number, number>,
    xpBefore: number,
    xpAfter: number,
) {
    const ids = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(costs), String(recipe.product)]);
    if (xpAfter === xpBefore && [...ids].every(key => (after[Number(key)] ?? 0) === (before[Number(key)] ?? 0))) return 'none';
    for (const key of ids) {
        const id = Number(key);
        const delta = (after[id] ?? 0) - (before[id] ?? 0);
        const expected = (id === recipe.product ? recipe.output : 0) - (costs[id] ?? 0);
        if (delta !== expected) return 'invalid';
    }
    return xpAfter > xpBefore ? 'cast' : 'invalid';
}

// Wields the pack's best elemental staff for the spell's runes, so the spell costs no runes the staff gives.
export async function equipItemSpellStaff(s: Session, recipe: ItemMagicRecipe, members: boolean, over: () => boolean = () => false) {
    if (typeof s.bot?.equipItem !== 'function') return;
    const state = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const spellRunes: number[] = [];
    for (const [idStr, rawCount] of Object.entries(recipe.inputs)) {
        const id = Number(idStr);
        const used = rawCount - (id === recipe.target ? 1 : 0);
        for (let k = 0; k < used; k++) spellRunes.push(id);
    }
    const eq = (state()?.equipment ?? []) as readonly { id: number; slot: number }[];
    const staff = bestElementalStaffForRunes([...inv(), ...eq.filter(e => e.slot === 3).map(e => ({ id: e.id, count: 1 }))], readSkillLevels(s.sdk), {
        runeIds: spellRunes,
        members,
    }).current;
    if (staff && !eq.some(e => e.slot === 3 && e.id === staff.item.id)) {
        const held = inv().find(i => i.id === staff.item.id);
        if (held) {
            await s.bot.equipItem(held);
            await waitUntil(s, () => over() || (state()?.equipment ?? []).some(e => e.slot === 3 && e.id === staff.item.id), { timeoutTicks: 4 });
        }
    }
}

export async function runItemMagic(s: Session, recipe: ItemMagicRecipe, o: { count: number; cap: number; members?: boolean; stop?: () => boolean }) {
    if (!Number.isSafeInteger(o.count) || o.count < 1 || o.count > 10000 || !Number.isSafeInteger(o.cap) || o.cap < 1 || o.cap > 100000) {
        throw Error('invalid finite magic limits');
    }
    const state = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const counts = () => {
        const r: Record<number, number> = {};
        for (const i of inv()) r[i.id] = (r[i.id] ?? 0) + i.count;
        return r;
    };
    const xp = () => s.sdk.getSkillXp('Magic') ?? 0;
    const start = s.tick();
    const xp0 = xp();
    let casts = 0;
    let ended = false;
    let stop = 'target';
    void s.ended.then(() => { ended = true; });
    if (recipe.members && !o.members) throw Error('member spell requires explicit member batch scope');
    const p0 = state()?.player;
    if (!p0) throw Error('player state unknown');
    if ((s.sdk.getSkill('Magic')?.level ?? 0) < recipe.level || (s.sdk.getSkill('Smithing')?.level ?? 0) < recipe.smithing) {
        throw Error('spell skill requirement');
    }
    const life = watchProductionLife(s, o.stop);
    const over = () => ended || life.stopped() || s.tick() - start >= o.cap;
    await equipItemSpellStaff(s, recipe, o.members ?? false, over);
    while (casts < o.count) {
        if (over()) {
            stop = ended ? 'session ended' : life.stopped() ? 'stopped' : 'cap';
            break;
        }
        const p = state()?.player;
        if (!p || p.worldX !== p0.worldX || p.worldZ !== p0.worldZ || p.lifeId !== p0.lifeId || p.isDead) throw Error('unsafe player change');
        const ui = state();
        const onlyContinue = !!ui?.dialog?.isOpen && (ui.dialog.options?.length ?? 0) <= 1 && !ui.interface?.isOpen;
        if (process.env.ITEM_MAGIC_DISMISS === '1' || (!onlyContinue && (ui?.dialog?.isOpen || ui?.interface?.isOpen))) {
            await s.bot.dismissBlockingUI();
        }
        if (over()) {
            stop = 'stopped';
            break;
        }
        const before = counts();
        const x0 = xp();
        const costs = itemSpellCosts(recipe, state()?.equipment ?? [], o.members ?? false);
        if (Object.entries(costs).some(([id, n]) => (before[Number(id)] ?? 0) < n)) {
            stop = 'supplies';
            break;
        }
        if (recipe.name === 'superheat:iron' && (before[objId('coal')] ?? 0) > 1) throw Error('iron batch contains steel coal');
        const item = inv().find(i => i.id === recipe.target);
        if (!item) throw Error('target missing');
        const result = (await s.direct({ type: 'spellOnItem', slot: item.slot, spellComponent: componentId(recipe.spell), reason: 'SDK' })) as { success?: boolean };
        if (result?.success === false) throw Error('item spell dispatch refused');
        await waitUntil(s, () => over() || xp() !== x0 || Object.keys(counts()).some(id => counts()[Number(id)] !== before[Number(id)]), {
            timeoutTicks: Math.min(12, Math.max(1, o.cap - (s.tick() - start))),
        });
        await waitTicks(s, 1);
        const effect = itemSpellEffect(recipe, costs, before, counts(), x0, xp());
        if (effect !== 'cast') throw Error('item spell effect ' + effect);
        casts++;
        console.log('ITEM_MAGIC_CAST ' + JSON.stringify({ cast: casts, tick: s.tick(), mode: recipe.name, inputs: costs, product: recipe.product, output: recipe.output }));
        const gap = Number(process.env.ITEM_MAGIC_GAP ?? spellDelay(recipe.name));
        if (gap > 0 && casts < o.count && !over()) await waitTicks(s, Math.min(gap, Math.max(1, o.cap - (s.tick() - start))));
    }
    return { ok: casts === o.count, stop, casts, ticks: s.tick() - start, magicXp: xp() - xp0, product: recipe.product, produced: casts * recipe.output };
}

// ---- Bank staging for spells cast from the pack ----

// The client item type decides stackability. Without it the knowledge build decides: runes and
// coins stack, and other spell inputs (rings, amulets, ores, bones) take one slot each.
export const spellInputStackable = itemStackable;

const stackCount = (items: readonly { id: number; count: number }[], id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

export function spellCastsHeld(perCast: Record<number, number>, pack: readonly { id: number; count: number }[]): number {
    let n = Infinity;
    for (const [id, each] of Object.entries(perCast)) if (each > 0) n = Math.min(n, Math.floor(stackCount(pack, Number(id)) / each));
    return Number.isFinite(n) ? n : 0;
}

// The most whole casts, up to maximum, that the pack and the bank hold together and whose
// withdrawals fit the free pack slots.
export function stagedSpellCasts(
    perCast: Record<number, number>,
    maximum: number,
    pack: readonly { id: number; count: number }[],
    bank: readonly { id: number; count: number }[],
    freeSlots: number,
    stackable: (id: number) => boolean,
): number {
    const fits = (n: number) => {
        let slots = 0;
        for (const [key, each] of Object.entries(perCast)) {
            const id = Number(key);
            const held = stackCount(pack, id);
            const need = each * n;
            if (held + stackCount(bank, id) < need) return false;
            const take = Math.max(0, need - held);
            if (take > 0) slots += stackable(id) ? (held > 0 ? 0 : 1) : take;
        }
        return slots <= freeSlots;
    };
    let lower = 0;
    let upper = Math.max(0, Math.floor(maximum));
    while (lower < upper) {
        const n = Math.ceil((lower + upper) / 2);
        if (fits(n)) lower = n;
        else upper = n - 1;
    }
    return lower;
}

// Opens a bank in reach, banks the named products, and withdraws whole casts of the inputs.
// Returns 0 casts without a bank in reach, so the caller keeps its pack-only result.
export async function stageSpellInputs(
    s: Session,
    perCast: Record<number, number>,
    maximum: number,
    o: { deposit?: readonly number[]; stop?: () => boolean; settleTicks?: number } = {},
): Promise<{ casts: number; banked: boolean }> {
    const inv = () => s.sdk.getInventory();
    const observe = s.bankObservation?.bind(s);
    if (!observe || o.stop?.() || maximum < 1 || typeof s.bot?.openBank !== 'function') return { casts: 0, banked: false };
    // The engine refuses a bank booth click while the last spell's delay runs, and the SDK then
    // waits its whole timeout: the trace of bench extra:magic-enchant-banked has the last cast at
    // t=86 and "OpLoc ok=false delayed=true" at t=88. Wait out the delay, then close any modal
    // (a level-up message) as the bank trip runner does before each open.
    const state = () => s.sdk.getState();
    if ((o.settleTicks ?? 0) > 0) await waitTicks(s, o.settleTicks!);
    await s.sdk.sendCloseModal();
    const generation = observe()?.generation ?? 0;
    const opened = await s.bot.openBank().catch((e: unknown) => ({ success: false, message: String(e) }));
    const fresh = !!opened?.success && await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (observe()?.generation ?? 0) > generation, { timeoutTicks: 15 });
    if (!fresh) {
        const st = state() as { player?: { worldX: number; worldZ: number }; dialog?: unknown; interface?: unknown; nearbyLocs?: { name?: string; distance?: number }[]; gameMessages?: { text: string }[] } | undefined;
        console.log('SPELL_STAGE ' + JSON.stringify({
            opened: false,
            message: (opened as { message?: string } | undefined)?.message ?? '',
            bankOpen: !!s.sdk.getState()?.bank?.isOpen,
            at: st?.player ? [st.player.worldX, st.player.worldZ] : null,
            dialog: st?.dialog ?? null,
            interface: st?.interface ?? null,
            booths: (st?.nearbyLocs ?? []).filter(l => /bank/i.test(l.name ?? '')).map(l => [l.name, l.distance]).slice(0, 3),
            messages: (st?.gameMessages ?? []).slice(-3).map(m => m.text),
            tick: s.tick(),
        }));
        return { casts: 0, banked: false };
    }
    try {
        for (const id of o.deposit ?? []) {
            const row = inv().find(i => i.id === id);
            if (row) await depositObserved(s, row);
        }
        const bank = observe()?.items ?? [];
        const free = Math.max(0, 28 - inv().length);
        const n = stagedSpellCasts(perCast, maximum, inv(), bank, free, id => spellInputStackable(s.client, id));
        console.log('SPELL_STAGE ' + JSON.stringify({ opened: true, maximum, casts: n, free, bank: Object.fromEntries(Object.keys(perCast).map(id => [id, stackCount(bank, Number(id))])), tick: s.tick() }));
        for (const [key, each] of Object.entries(perCast)) {
            const id = Number(key);
            const before = stackCount(inv(), id);
            const want = n * each - before;
            if (want < 1) continue;
            const row = (s.sdk.getState()?.bank?.items ?? []).find(i => i.id === id);
            if (!row || !(await s.bot.withdrawItem(row, want, { asNote: false })).success || !await waitUntil(s, () => stackCount(inv(), id) >= before + want, { timeoutTicks: 10 })) {
                throw Error(`spell stage: withdraw ${want}x${id} failed`);
            }
        }
        return { casts: n, banked: true };
    } finally {
        await s.bot.closeBank();
        await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
    }
}

// Item spells (enchant, alchemy, superheat) with inputs staged from a bank in reach, one pack
// at a time. A run that casts and then empties the bank stock ends ok with stop=supplies.
export async function runItemMagicBanked(s: Session, recipe: ItemMagicRecipe, o: { count: number; cap: number; members?: boolean; stop?: () => boolean }) {
    if (!Number.isSafeInteger(o.count) || o.count < 1 || o.count > 10000 || !Number.isSafeInteger(o.cap) || o.cap < 1 || o.cap > 100000) {
        throw Error('invalid finite magic limits');
    }
    const counts = () => {
        const r: Record<number, number> = {};
        for (const i of s.sdk.getInventory()) r[i.id] = (r[i.id] ?? 0) + i.count;
        return Object.entries(r).map(([id, count]) => ({ id: Number(id), count }));
    };
    const xp = () => s.sdk.getSkillXp('Magic') ?? 0;
    const start = s.tick();
    const xp0 = xp();
    let casts = 0;
    let stages = 0;
    let stop = 'target';
    while (casts < o.count) {
        const left = o.cap - (s.tick() - start);
        if (left < 1) {
            stop = 'cap';
            break;
        }
        if (o.stop?.()) {
            stop = 'stopped';
            break;
        }
        // A pack staff pays its runes, so wield it before the costs decide what to stage.
        await equipItemSpellStaff(s, recipe, o.members ?? false, () => !!o.stop?.());
        const perCast = itemSpellCosts(recipe, s.sdk.getState()?.equipment ?? [], o.members ?? false);
        let held = spellCastsHeld(perCast, counts());
        if (held < 1) {
            stages++;
            const settleTicks = casts > 0 ? spellDelay(recipe.name) + 1 : 0;
            held = (await stageSpellInputs(s, perCast, o.count - casts, { deposit: [recipe.product], stop: o.stop, settleTicks })).casts;
            if (held < 1) {
                stop = 'supplies';
                break;
            }
        }
        const r = await runItemMagic(s, recipe, { count: Math.min(held, o.count - casts), cap: Math.max(1, o.cap - (s.tick() - start)), members: o.members, stop: o.stop });
        casts += r.casts;
        // runItemMagic keeps stop=target only when it cast its count; a pack that ran short after
        // some casts stages again, and every other stop (cap, stopped, session ended) ends the run.
        if (r.stop === 'supplies' && r.casts > 0) continue;
        if (r.stop !== 'target') {
            stop = r.stop;
            break;
        }
    }
    return {
        ok: casts === o.count || (casts > 0 && stop === 'supplies'),
        stop,
        casts,
        stages,
        ticks: s.tick() - start,
        magicXp: xp() - xp0,
        product: recipe.product,
        produced: casts * recipe.output,
    };
}

// Stages the runes of `casts` teleports from a bank in reach when the pack holds fewer.
export async function stageTeleportRunes(s: Session, t: NativeTeleport, casts: number, members = false, stop?: () => boolean) {
    const perCast = Object.fromEntries(
        Object.entries(t.runes)
            .map(([id, n]) => [id, elementalRuneCost(Number(id), n, s.sdk.getEquipment(), members)])
            .filter(([, n]) => Number(n) > 0),
    ) as Record<number, number>;
    const pack = s.sdk.getInventory().map(i => ({ id: i.id, count: i.count }));
    if (spellCastsHeld(perCast, pack) >= casts) return { casts, banked: false };
    return stageSpellInputs(s, perCast, casts, { stop });
}

// ---- Standard Teleports (microbot-magic-teleport.ts) ----

export function teleportReceipt(
    t: NativeTeleport,
    costs: Record<number, number>,
    b: Record<number, number>,
    a: Record<number, number>,
    xp0: number,
    xp1: number,
    p: { worldX: number; worldZ: number; level: number } | null | undefined,
) {
    if (xp1 <= xp0 || !p || p.level !== t.to.level || Math.abs(p.worldX - t.to.x) > 2 || Math.abs(p.worldZ - t.to.z) > 2) return false;
    for (const k in b) {
        const id = Number(k);
        if ((b[id] ?? 0) - (a[id] ?? 0) !== (costs[id] ?? 0)) return false;
    }
    for (const k in a) {
        if (k in b) continue;
        const id = Number(k);
        if (-(a[id] ?? 0) !== (costs[id] ?? 0)) return false;
    }
    for (const k in costs) {
        if (k in b || k in a) continue;
        if ((costs[Number(k)] ?? 0) !== 0) return false;
    }
    return true;
}

export async function runTeleportMagic(s: Session, t: NativeTeleport, o: { casts: number; cap: number; members?: boolean; combo?: ItemMagicRecipe; stop?: () => boolean }) {
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
    let combos = 0;
    let failure = '';
    let stop = 'target';
    void s.ended.then(() => { ended = true; });
    const start = s.tick();
    const xp0 = xp();
    const over = () => ended || !!o.stop?.() || s.tick() - start >= o.cap || !st()?.player || st()?.player?.lifeId !== p0.lifeId || hp() < hp0;
    const rest = async (n: number) => {
        for (let i = 0; i < n && !over(); i++) await waitTicks(s, 1);
    };
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
            const reply = (await s.direct({ type: 'clickComponent', componentId: componentId(t.component), reason: 'SDK' })) as { success?: boolean };
            if (reply?.success === false) throw Error('teleport dispatch refused');
            await waitUntil(s, () => over() || teleportReceipt(t, costs, b, counts(), x0, xp(), st()?.player), {
                timeoutTicks: Math.min(15, Math.max(1, o.cap - (s.tick() - start))),
            });
            if (!teleportReceipt(t, costs, b, counts(), x0, xp(), st()?.player)) {
                throw Error('teleport rune/XP/destination effect missing; check native quest, scroll and member requirements');
            }
            casts++;
            await rest(6);
            if (o.combo && !over()) {
                const r = await runItemMagic(s, o.combo, { count: 1, cap: Math.max(1, o.cap - (s.tick() - start)), members: o.members, stop: over });
                if (!r.ok) throw Error('teleport alch combo ' + r.stop);
                combos++;
                await rest(6);
            }
            console.log('TELEPORT_MAGIC_CAST ' + JSON.stringify({ casts, combos, destination: t.name, tick: s.tick() }));
        }
        if (casts !== o.casts && stop === 'target') stop = 'stopped/cap';
    } catch (e) {
        failure = String(e);
        stop = 'failure';
    }
    return { ok: !failure && !over() && casts === o.casts && (!o.combo || combos === casts), stop, failure, casts, combos, magicXp: xp() - xp0, ticks: s.tick() - start };
}

export function magicStopRequested(actor: string, stopped = false, exists: (path: string) => boolean = existsSync, stopFile = process.env.STOP_FILE) {
    return stopped || ['.practice/stop-' + actor, '.practice/stop-all', '.practice/stop-microbot-magic', stopFile].some(path => !!path && exists(path));
}

// ---- Magic Bank Trips (microbot-magic-trip.ts) ----

export type MagicBankJob = BankRouteJob & {
    family: 'magic-npc' | 'magic-teleport';
    npc?: number;
    splashOnly?: boolean;
    comboAlch?: 'low-alch' | 'high-alch';
    comboTeleport?: string;
    returnTeleport?: string;
    protectPrayer?: 12 | 13 | 14;
};

function defaultCombatTeleportAllowed(p: { worldX: number; worldZ: number; level: number }) {
    if (p.worldX < 2944 || p.worldX > 3391) return true;
    const bottom = p.worldZ >= 9920 && p.worldZ <= 12799 && p.level === 0 ? 9920 : p.worldZ >= 3520 && p.worldZ <= 6399 && p.level <= 3 ? 3520 : undefined;
    return bottom === undefined || Math.floor((p.worldZ - bottom) / 8) + 1 <= 20;
}

const DEFAULT_NPC_SPELLS: Readonly<Record<string, { name: string; component: string; level: number; runes: Record<number, number>; debuff: boolean; members: boolean; requiredWorn?: number }>> = {
    'wind-strike': { name: 'wind-strike', component: 'magic:wind_strike', level: 1, runes: { 556: 1, 558: 1 }, debuff: false, members: false },
    'water-strike': { name: 'water-strike', component: 'magic:water_strike', level: 5, runes: { 555: 1, 556: 1, 558: 1 }, debuff: false, members: false },
    'earth-strike': { name: 'earth-strike', component: 'magic:earth_strike', level: 9, runes: { 557: 2, 556: 1, 558: 1 }, debuff: false, members: false },
    'fire-strike': { name: 'fire-strike', component: 'magic:fire_strike', level: 13, runes: { 554: 3, 556: 2, 558: 1 }, debuff: false, members: false },
    'curse': { name: 'curse', component: 'magic:curse', level: 19, runes: { 555: 2, 557: 3, 559: 1 }, debuff: true, members: false },
};

export function validateMagicBankJob(j: MagicBankJob, deps?: ArtisanExternalDeps) {
    validateBankRouteJob(j);
    if (!['magic-npc', 'magic-teleport'].includes(j.family) || !j.bank || j.batch > 1000) {
        throw Error('magic bank job needs known family, bank and batch<=1000');
    }
    if (j.family === 'magic-npc' && (!j.site || !Number.isSafeInteger(j.npc) || j.npc! < 0)) {
        throw Error('NPC magic bank job needs exact site and native NPC ID');
    }
    if (j.protectPrayer !== undefined && (j.family !== 'magic-npc' || ![12, 13, 14].includes(j.protectPrayer))) {
        throw Error('unsupported magic protection prayer');
    }
    if (j.splashOnly !== undefined && typeof j.splashOnly !== 'boolean') throw Error('invalid splash-only scope');
    if (j.comboAlch !== undefined && !['low-alch', 'high-alch'].includes(j.comboAlch)) throw Error('unsupported finite alchemy combo');
    const resolveNpcSpell = deps?.nativeNpcSpell ?? (name => DEFAULT_NPC_SPELLS[name] ?? coreNativeNpcSpell(name));
    const spell = j.family === 'magic-npc' ? resolveNpcSpell(j.recipe) : nativeTeleport(j.recipe);
    if (spell.members && !j.members) throw Error('member magic job needs member scope');
    if (j.comboAlch) itemMagicRecipe(j.comboAlch, j.alchemyTarget);
    if (j.returnTeleport) {
        const t = nativeTeleport(j.returnTeleport);
        if (j.batch !== 1) throw Error('return teleport needs one-cast bank batches');
        if (t.members && !j.members) throw Error('member return teleport needs member scope');
    }
    if (j.comboTeleport) {
        const t = nativeTeleport(j.comboTeleport);
        if (j.family !== 'magic-npc' || j.batch !== 1) throw Error('NPC teleport combo needs one-cast bank batches');
        if (t.members && !j.members) throw Error('member combo needs member scope');
    }
}

export async function returnMagicTrip(s: Session, t: NativeTeleport, members: boolean, budget: number, deps?: ArtisanExternalDeps) {
    const initial = s.sdk.getState()?.player;
    const life = initial?.lifeId;
    const start = s.tick();
    const fatal = () => {
        const p = s.sdk.getState()?.player;
        return !p || p.isDead || p.lifeId !== life || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < 1 || s.tick() - start >= budget;
    };
    const landed = () => {
        const p = s.sdk.getState()?.player;
        return !!p && p.level === t.to.level && Math.max(Math.abs(p.worldX - t.to.x), Math.abs(p.worldZ - t.to.z)) <= 2;
    };
    if (!initial || fatal()) throw Error('magic return life/budget unavailable');
    if (landed()) return;
    const allowed = deps?.combatTeleportAllowed ? deps.combatTeleportAllowed(initial) : defaultCombatTeleportAllowed(initial);
    if (!allowed) throw Error('magic return needs legal Wilderness exit');
    for (let n = 0; n < 3; n++) {
        if (fatal()) throw Error('magic return life/budget changed');
        await waitTicks(s, 1);
    }
    const counts = () => {
        const out: Record<number, number> = {};
        for (const i of s.sdk.getInventory()) out[i.id] = (out[i.id] ?? 0) + i.count;
        return out;
    };
    const before = counts();
    const xp = s.sdk.getSkillXp('Magic') ?? 0;
    const costs = Object.fromEntries(Object.entries(t.runes).map(([id, n]) => [id, elementalRuneCost(Number(id), n, s.sdk.getEquipment(), members)]));
    if (Object.entries(costs).some(([id, n]) => (before[Number(id)] ?? 0) < n)) throw Error('magic return owned runes short');
    await s.sdk.sendCloseModal();
    try {
        await s.direct({ type: 'clickComponent', componentId: componentId(t.component), reason: 'bounded owned magic trip return' });
    } catch {}
    const paid = () => teleportReceipt(t, costs, before, counts(), xp, s.sdk.getSkillXp('Magic') ?? 0, s.sdk.getState()?.player);
    if (!await waitUntil(s, () => fatal() || paid(), { timeoutTicks: Math.max(1, Math.min(20, budget - (s.tick() - start))) }) || fatal() || !paid()) {
        throw Error('magic return rune/XP/landing unconfirmed');
    }
    for (let n = 0; n < 3; n++) {
        if (fatal()) throw Error('magic return settlement life/budget changed');
        await waitTicks(s, 1);
    }
}

export function magicBankProfile(s: Session, j: MagicBankJob, deps?: ArtisanExternalDeps): BankProfile {
    validateMagicBankJob(j, deps);
    const resolveNpcSpell = deps?.nativeNpcSpell ?? (name => DEFAULT_NPC_SPELLS[name] ?? coreNativeNpcSpell(name));
    const spell = j.family === 'magic-npc' ? resolveNpcSpell(j.recipe) : nativeTeleport(j.recipe);
    const combo = j.comboAlch ? itemMagicRecipe(j.comboAlch, j.alchemyTarget) : undefined;
    const tele = j.comboTeleport ? nativeTeleport(j.comboTeleport) : undefined;
    const back = j.returnTeleport ? nativeTeleport(j.returnTeleport) : undefined;
    if (j.protectPrayer !== undefined && ((s.sdk.getState()?.prayers.prayerLevel ?? 0) < { 12: 37, 13: 40, 14: 43 }[j.protectPrayer] || (s.sdk.getState()?.prayers.prayerPoints ?? 0) < 10)) {
        throw Error('magic trip protection level/points short');
    }
    if ('requiredWorn' in spell && spell.requiredWorn !== undefined && !s.sdk.getEquipment().some(i => i.slot === 3 && i.id === spell.requiredWorn)) {
        throw Error('magic trip needs native required staff');
    }
    const inputs: Record<number, number> = {};
    const add = (costs: Record<number, number>) => {
        for (const [id, n] of Object.entries(costs)) if (n) inputs[Number(id)] = (inputs[Number(id)] ?? 0) + n;
    };
    const costs = (r: Record<number, number>) => Object.fromEntries(Object.entries(r).map(([id, n]) => [id, elementalRuneCost(Number(id), n, s.sdk.getEquipment(), j.members)]));
    add(costs(spell.runes));
    if (combo) add(itemSpellCosts(combo, s.sdk.getEquipment(), j.members));
    if (tele) add(costs(tele.runes));
    if (back) add(costs(back.runes));
    if ((s.sdk.getSkill('Magic')?.level ?? 0) < Math.max(spell.level, combo?.level ?? 0, tele?.level ?? 0, back?.level ?? 0)) {
        throw Error('magic bank level short');
    }
    const prepare = async (stop: () => boolean) => {
        if (stop()) throw Error('magic trip stopped before preparation');
        if (s.sdk.getState()?.autoRetaliateEnabled !== false) {
            await s.direct({ type: 'clickComponent', componentId: 151, reason: 'finite magic trip ownership' });
            if (!await waitUntil(s, () => s.sdk.getState()?.autoRetaliateEnabled === false, { timeoutTicks: 8 })) throw Error('magic trip retaliation unobserved');
        }
        if (j.protectPrayer !== undefined && !s.sdk.isPrayerActive(j.protectPrayer)) {
            if (!(await s.sdk.sendTogglePrayer(j.protectPrayer)).success || !await waitUntil(s, () => s.sdk.isPrayerActive(j.protectPrayer!), { timeoutTicks: 8 })) {
                throw Error('magic trip protection unobserved');
            }
        }
    };
    return {
        inputs,
        tools: [],
        outputs: combo ? [combo.product] : [],
        bank: j.bank!,
        site: j.site ?? j.bank!,
        prepare,
        run: async (n, cap, stop) => {
            await prepare(stop);
            const guardedStop = () => stop() || (j.protectPrayer !== undefined && (!s.sdk.isPrayerActive(j.protectPrayer) || (s.sdk.getState()?.prayers.prayerPoints ?? 0) < 10));
            let failure = '';
            let result: { ok: boolean; casts: number; stop: string; failure: string } | undefined;
            try {
                if (j.family === 'magic-npc') {
                    if (!deps?.runNpcMagic) throw Error('magic-npc trip requires deps.runNpcMagic');
                    result = await deps.runNpcMagic(s, resolveNpcSpell(j.recipe), {
                        npc: j.npc!,
                        casts: n,
                        cap,
                        splashOnly: j.splashOnly,
                        combo,
                        teleport: j.comboTeleport,
                        members: j.members,
                        stop: guardedStop,
                    });
                } else {
                    result = await runTeleportMagic(s, nativeTeleport(j.recipe), { casts: n, cap, combo, members: j.members, stop });
                }
                if (!result.ok || result.casts !== n) failure = 'bank magic ' + result.stop + ': ' + result.failure;
            } catch (e) {
                failure = String(e);
            }
            const escape = back ?? (failure ? tele : undefined);
            if (escape) {
                try {
                    await returnMagicTrip(s, escape, j.members, Math.min(40, j.returnTicks), deps);
                } catch (e) {
                    failure += [failure ? '; ' : '', String(e)].join('');
                }
            }
            if (failure || !result) throw Error(failure || 'bank magic result absent');
            return result.casts;
        },
    };
}

export async function runMagicBankTrips(s: Session, j: MagicBankJob, stop: () => boolean = () => false, deps?: ArtisanExternalDeps) {
    const profile = magicBankProfile(s, j, deps);
    const prayer = j.protectPrayer === undefined ? undefined : s.sdk.isPrayerActive(j.protectPrayer);
    const retaliate = s.sdk.getState()?.autoRetaliateEnabled;
    if (typeof retaliate !== 'boolean') throw Error('magic trip retaliation unknown');
    const names = ['Attack', 'Strength', 'Defence', 'Ranged'];
    const before = names.map(n => s.sdk.getSkillXp(n) ?? 0);
    const bankProfileRunner = deps?.runBankProfile ?? ((sess, job, prof, reqStop) => runArtisanBankProfile(sess as Session, job as BankRouteJob, prof as BankProfile, reqStop));
    const result = await bankProfileRunner(s, j, profile, () => stop() || (j.protectPrayer !== undefined && (s.sdk.getState()?.prayers.prayerPoints ?? 0) < 10));
    let prayerRestored = j.protectPrayer === undefined || s.sdk.isPrayerActive(j.protectPrayer) === prayer;
    if (result.atBank && !prayerRestored) {
        await s.sdk.sendTogglePrayer(j.protectPrayer!);
        prayerRestored = await waitUntil(s, () => s.sdk.isPrayerActive(j.protectPrayer!) === prayer, { timeoutTicks: 8 });
    }
    let restored = s.sdk.getState()?.autoRetaliateEnabled === retaliate;
    if (result.atBank && !restored) {
        await s.direct({ type: 'clickComponent', componentId: retaliate ? 150 : 151, reason: 'restore finite magic trip ownership' });
        restored = await waitUntil(s, () => s.sdk.getState()?.autoRetaliateEnabled === retaliate, { timeoutTicks: 8 });
    }
    const combatPreserved = names.every((n, i) => (s.sdk.getSkillXp(n) ?? 0) === before[i]);
    return { ...result, ok: result.ok && restored && prayerRestored && combatPreserved, retaliateRestored: restored, prayerRestored, combatPreserved };
}

// ---- Orbs & Orb Trips (microbot-c-orbs.ts, microbot-orb-trip.ts) ----

export const orbRecipes = {
    air: { level: 66, rune: 556, loc: 2152, output: 573, spell: 1186 },
    water: { level: 56, rune: 555, loc: 2151, output: 571, spell: 1179 },
    earth: { level: 60, rune: 557, loc: 2150, output: 575, spell: 1182 },
    fire: { level: 63, rune: 554, loc: 2153, output: 569, spell: 1184 },
} as const;

export type OrbKind = keyof typeof orbRecipes;
type OrbAssets = { raw: number; product: number; cosmic: number; element: number; xp: number };

export function orbEffect(a: OrbAssets, b: OrbAssets, elementCost = 30) {
    return a.raw - b.raw === 1 && b.product - a.product === 1 && a.cosmic - b.cosmic === 3 && a.element - b.element === elementCost && b.xp > a.xp;
}

export async function chargeInventory(s: Session, kind: OrbKind, maximum: number, cap: number, stop: () => boolean = () => false, scopedBridge?: () => () => void) {
    if (!Object.hasOwn(orbRecipes, kind) || !Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(cap) || cap < 1) {
        throw Error('invalid orb order');
    }
    const r = orbRecipes[kind];
    const start = s.tick();
    const count = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const assets = (): OrbAssets => ({ raw: count(567), product: count(r.output), cosmic: count(564), element: count(r.rune), xp: s.sdk.getSkillXp('Magic') ?? 0 });
    const initial = assets();
    const protectedItems = new Map<number, number>();
    const elementCost = () => elementalRuneCost(r.rune, 30, s.sdk.getEquipment(), true);
    for (const i of s.sdk.getInventory()) if (![567, r.output, 564, r.rune].includes(i.id)) protectedItems.set(i.id, count(i.id));
    const life = watchProductionLife(s, stop);
    const over = () => life.stopped() || s.tick() - start >= cap;
    let made = 0;
    let detail = '';
    let restore: (() => void) | undefined;
    try {
        if ((s.sdk.getSkill('Magic')?.baseLevel ?? 0) < r.level) throw Error('orb magic level short');
        if (initial.raw < maximum || initial.cosmic < maximum * 3 || initial.element < maximum * elementCost()) throw Error('staged orb supplies short');
        restore = scopedBridge ? scopedBridge() : installSpellLocBridge(s.client);
        while (made < maximum && !over()) {
            const loc = s.sdk.getState()?.nearbyLocs.find(l => l.id === r.loc);
            if (!loc) throw Error('required obelisk not nearby');
            const before = assets();
            const cost = elementCost();
            await s.direct({ type: 'spellOnLoc', x: loc.x, z: loc.z, locId: loc.id, spellComponent: r.spell, reason: 'SDK' });
            await waitUntil(s, () => orbEffect(before, assets(), cost) || over(), { timeoutTicks: Math.min(12, Math.max(1, cap - (s.tick() - start))) });
            if (!orbEffect(before, assets(), cost)) throw Error('orb input/product/rune/XP reconciliation failed');
            made++;
            if (made < maximum && !over()) await waitTicks(s, Math.min(3, Math.max(1, cap - (s.tick() - start))));
        }
        if (made !== maximum) throw Error('orb budget or stop');
    } catch (error) {
        detail = String(error);
    } finally {
        restore?.();
    }
    const final = assets();
    const preserved = [...protectedItems].every(([id, n]) => count(id) === n);
    detail ||= life.reason();
    return { ok: !detail && preserved && made === maximum, made, preserved, ticks: s.tick() - start, detail, initial, final };
}

export function orbStopRequested(name: string, stopped = false, exists: (path: string) => boolean = existsSync, stopFile = process.env.STOP_FILE) {
    return stopped || ['.practice/stop-' + name, '.practice/stop-all', '.practice/stop-microbot-orbs', stopFile].some(path => !!path && exists(path));
}

export const orbSites = { air: { x: 3088, z: 3569 }, earth: { x: 3086, z: 9932 }, water: { x: 2844, z: 3422 }, fire: { x: 2819, z: 9828 } };
export const orbInteractions = {
    earth: { shape: 10, angle: 0, width: 3, height: 3, src: 'maps/m48_155.jm2' },
    air: { shape: 10, angle: 1, width: 1, height: 1, src: 'maps/m48_55.jm2' },
    water: { shape: 11, angle: 1, width: 2, height: 2, src: 'maps/m44_53.jm2' },
    fire: { shape: 11, angle: 3, width: 2, height: 2, src: 'maps/m44_153.jm2' },
} as const;

export type OrbPlayerPolicy = { radius: number; unknownAppearance: 'escape' | 'ignore' };
export type OrbOptions = { playerDetection?: OrbPlayerPolicy; staff?: 'owned' | number; energy?: { id: number; maximumDoses: number; below: number }; returnMode?: 'spell' | 'glory' };
export const ORB_ENERGY = [
    { id: 3008, next: 3010, doses: 4, gain: 10 },
    { id: 3010, next: 3012, doses: 3, gain: 10 },
    { id: 3012, next: 3014, doses: 2, gain: 10 },
    { id: 3014, next: 229, doses: 1, gain: 10 },
    { id: 3016, next: 3018, doses: 4, gain: 20 },
    { id: 3018, next: 3020, doses: 3, gain: 20 },
    { id: 3020, next: 3022, doses: 2, gain: 20 },
    { id: 3022, next: 229, doses: 1, gain: 20 },
] as const;

export function validateOrbOptions(o: OrbOptions) {
    if (o.playerDetection && (!Number.isSafeInteger(o.playerDetection.radius) || o.playerDetection.radius < 1 || o.playerDetection.radius > 14 || !['escape', 'ignore'].includes(o.playerDetection.unknownAppearance))) {
        throw Error('invalid explicit orb player policy');
    }
    if (o.staff !== undefined && o.staff !== 'owned' && (!Number.isSafeInteger(o.staff) || o.staff < 0)) throw Error('invalid owned orb staff');
    if (o.returnMode !== undefined && !['spell', 'glory'].includes(o.returnMode)) throw Error('native orb return must be spell or Glory');
    if (o.energy && (!ORB_ENERGY.some(e => e.id === o.energy!.id) || !Number.isSafeInteger(o.energy.maximumDoses) || o.energy.maximumDoses < 1 || o.energy.maximumDoses > 1000 || !Number.isSafeInteger(o.energy.below) || o.energy.below < 1 || o.energy.below > 100)) {
        throw Error('invalid finite native energy potion option');
    }
}

export function orbOptions(env: Record<string, string | undefined> = process.env): OrbOptions {
    const o: OrbOptions = {};
    if (env.ORB_PLAYER_DETECTION !== undefined) {
        if (env.ORB_PLAYER_DETECTION !== '1') throw Error('ORB_PLAYER_DETECTION must be1 when declared');
        o.playerDetection = { radius: Number(env.ORB_PLAYER_RADIUS ?? 14), unknownAppearance: (env.ORB_PLAYER_UNKNOWN ?? 'escape') as OrbPlayerPolicy['unknownAppearance'] };
    } else if (env.ORB_PLAYER_RADIUS !== undefined || env.ORB_PLAYER_UNKNOWN !== undefined) {
        throw Error('orb player options need ORB_PLAYER_DETECTION=1');
    }
    if (env.ORB_STAFF !== undefined) o.staff = env.ORB_STAFF === 'owned' ? 'owned' : Number(env.ORB_STAFF);
    if (env.ORB_RETURN !== undefined) o.returnMode = env.ORB_RETURN as 'spell' | 'glory';
    if (env.ORB_ENERGY_ID !== undefined) o.energy = { id: Number(env.ORB_ENERGY_ID), maximumDoses: Number(env.ORB_ENERGY_DOSES ?? 1), below: Number(env.ORB_ENERGY_BELOW ?? 50) };
    else if (env.ORB_ENERGY_DOSES !== undefined || env.ORB_ENERGY_BELOW !== undefined) throw Error('orb energy policy needs native potion ID');
    validateOrbOptions(o);
    return o;
}

export function ownedOrbStaff(items: readonly { id: number; count: number }[], rune: number, want: 'owned' | number) {
    const staves = nativeStaffRunes();
    let bestId: number | undefined;
    for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (item.count <= 0 || (want !== 'owned' && item.id !== want)) continue;
        const staff = staves.get(item.id);
        if (staff && staff.runes.has(rune) && (bestId === undefined || item.id < bestId)) {
            bestId = item.id;
        }
    }
    return bestId;
}

let cachedOrbGlory: { item: string; id: number; charges: number; next: string; nextId: number }[] | undefined;
export function orbGloryList() {
    if (cachedOrbGlory) return cachedOrbGlory;
    const objPack = packMap('obj');
    const entry = JSON.parse(readFileSync(join(KNOWLEDGE_DIR, 'teleports.json'), 'utf8')).teleports.find((t: any) => t.id === 'jewellery:amulet_of_glory');
    cachedOrbGlory = (entry.charges as { item: string; id: number; charges: number; next: string }[]).map(g => {
        const next = objPack.get(g.next);
        if (next === undefined) throw Error('native Glory charge chain absent');
        return { ...g, nextId: next };
    });
    return cachedOrbGlory;
}

const orbPack = (s: Session) => {
    const out: Record<number, number> = {};
    for (const i of s.sdk.getInventory()) out[i.id] = (out[i.id] ?? 0) + i.count;
    return out;
};

export function orbPackEffect(before: Record<number, number>, after: Record<number, number>, delta: Record<number, number>) {
    for (const k in before) {
        const id = Number(k);
        if ((after[id] ?? 0) - (before[id] ?? 0) !== (delta[id] ?? 0)) return false;
    }
    for (const k in after) {
        if (k in before) continue;
        const id = Number(k);
        if ((after[id] ?? 0) !== (delta[id] ?? 0)) return false;
    }
    for (const k in delta) {
        if (k in before || k in after) continue;
        if ((delta[Number(k)] ?? 0) !== 0) return false;
    }
    return true;
}

export async function equipOrbStaff(s: Session, id: number, alive: () => boolean) {
    const row = s.sdk.getInventory().find(i => i.id === id);
    if (!row || !alive()) throw Error('orb owned staff absent');
    const before = [...s.sdk.getInventory(), ...s.sdk.getEquipment()].filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    await s.bot.equipItem(row);
    if (
        !await waitUntil(s, () => !alive() || s.sdk.getEquipment().some(i => i.id === id && i.slot === 3), { timeoutTicks: 8 }) ||
        !alive() ||
        !s.sdk.getEquipment().some(i => i.id === id && i.slot === 3) ||
        [...s.sdk.getInventory(), ...s.sdk.getEquipment()].filter(i => i.id === id).reduce((n, i) => n + i.count, 0) !== before
    ) {
        throw Error('orb owned staff equip unobserved');
    }
}

export async function drinkOrbEnergy(s: Session, id: number, alive: () => boolean) {
    const recipe = ORB_ENERGY.find(e => e.id === id);
    const row = s.sdk.getInventory().find(i => i.id === id);
    const before = orbPack(s);
    const cursor = Math.max(-1, ...(s.sdk.getState()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
    const energy = s.sdk.getState()?.player?.runEnergy;
    if (!recipe || !row || typeof energy !== 'number' || energy >= 100 || !alive()) throw Error('orb native energy input/state absent');
    await s.sdk.sendUseItem(row.slot, 1);
    const delta = { [id]: -1, [recipe.next]: 1 };
    const remaining = recipe.doses - 1;
    const completion = remaining === 0 ? 'You have finished your potion.' : `You have ${remaining} dose${remaining === 1 ? '' : 's'} of potion left.`;
    const settled = () => (s.sdk.getState()?.gameMessages ?? []).some(m => m.type === 0 && (m.observationId ?? m.tick) > cursor && m.text === completion);
    const paid = () => orbPackEffect(before, orbPack(s), delta) && (s.sdk.getState()?.player?.runEnergy ?? -1) >= Math.min(100, energy + recipe.gain) - 1 && settled();
    if (!await waitUntil(s, () => !alive() || paid(), { timeoutTicks: 8 }) || !alive() || !paid()) throw Error('orb energy dose/energy receipt unconfirmed');
    console.log('ORB_ENERGY ' + JSON.stringify({ id, next: recipe.next, before: energy, after: s.sdk.getState()?.player?.runEnergy, gain: recipe.gain }));
    return delta;
}

const orbSupplyFamilies = [
    { ids: [2448, 181, 183, 185], prayer: false },
    { ids: [2434, 139, 141, 143], prayer: true },
] as const;

function orbSupplyRecipe(id: number) {
    const family = orbSupplyFamilies.find(f => f.ids.some(n => n === id));
    if (!family) throw Error('orb native supply potion unknown');
    const index = family.ids.findIndex(n => n === id);
    return { next: family.ids[index + 1] ?? 229, remaining: 3 - index, prayer: family.prayer };
}

export async function drinkOrbSupplyPotion(s: Session, id: number, alive: () => boolean) {
    const recipe = orbSupplyRecipe(id);
    const before = orbPack(s);
    const row = s.sdk.getInventory().find(i => i.id === id);
    const client = s.client;
    const executor = (client as any).executeBotAction;
    const initial = s.sdk.getState()?.player;
    const life = initial?.lifeId;
    const respawns = initial?.respawnCount ?? 0;
    const prayer = s.sdk.getState()?.prayers.prayerPoints;
    const cursor = Math.max(-1, ...(s.sdk.getState()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
    const delta = { [id]: -1, [recipe.next]: 1 };
    const valid = () => {
        const p = s.sdk.getState()?.player;
        return alive() && s.client === client && (client as any).executeBotAction === executor && typeof executor === 'function' && Number.isSafeInteger(life) && !!p && !p.isDead && p.lifeId === life && (p.respawnCount ?? 0) === respawns && s.sdk.getStateAge() <= 5000;
    };
    const completion = recipe.remaining === 0 ? 'You have finished your potion.' : `You have ${recipe.remaining} dose${recipe.remaining === 1 ? '' : 's'} of potion left.`;
    const paid = () =>
        orbPackEffect(before, orbPack(s), delta) &&
        (s.sdk.getState()?.gameMessages ?? []).some(m => m.type === 0 && (m.observationId ?? m.tick) > cursor && m.text === completion) &&
        (!recipe.prayer || (typeof prayer === 'number' && (s.sdk.getState()?.prayers.prayerPoints ?? -1) > prayer));
    if (!row || !valid() || (recipe.prayer && (typeof prayer !== 'number' || prayer < 0))) throw Error('orb supply potion owned state absent');
    try {
        await s.sdk.sendUseItem(row.slot, 1);
    } catch {}
    if (!await waitUntil(s, () => !valid() || paid(), { timeoutTicks: 8 }) || !valid() || !paid()) throw Error('orb supply potion paired/fresh completion unconfirmed');
    for (let n = 0; n < 3; n++) {
        await waitTicks(s, 1);
        if (!valid() || !orbPackEffect(before, orbPack(s), delta)) throw Error('orb supply potion settlement owner/life/stock changed');
    }
    console.log(
        'ORB_SUPPLY_POTION ' +
            JSON.stringify({ id, next: recipe.next, remaining: recipe.remaining, prayerBefore: recipe.prayer ? prayer : null, prayerAfter: recipe.prayer ? s.sdk.getState()?.prayers.prayerPoints : null, settledTicks: 3 }),
    );
    return delta;
}

export async function returnOrbGlory(s: Session, alive: () => boolean, runner = walkRoute) {
    const ORB_GLORY = orbGloryList();
    const edge = loadTravel().find(t => t.id === 'jewellery:amulet_of_glory:Edgeville');
    if (!edge) throw Error('native Glory Edgeville route absent');
    const p = s.sdk.getState()?.player;
    if (!p || !alive()) throw Error('orb Glory original life absent');
    if (p.level === 0 && Math.max(Math.abs(p.worldX - edge.to.x), Math.abs(p.worldZ - edge.to.z)) <= 8) return {} as Record<number, number>;
    const bottom = p.worldZ >= 9920 && p.worldZ <= 12799 && p.level === 0 ? 9920 : p.worldZ >= 3520 && p.worldZ <= 6399 ? 3520 : undefined;
    if (p.worldX >= 2944 && p.worldX <= 3391 && bottom !== undefined && Math.floor((p.worldZ - bottom) / 8) + 1 > 30) throw Error('orb Glory beyond native Wilderness30');
    const row = s.sdk.getInventory().find(i => ORB_GLORY.some(g => g.id === i.id));
    const g = ORB_GLORY.find(g => g.id === row?.id);
    if (!row || !g) throw Error('orb owned charged Glory absent');
    const before = orbPack(s);
    const xp = s.sdk.getSkillXp('Magic');
    const delta = { [g.id]: -1, [g.nextId]: 1 };
    const closeTick = s.tick();
    await s.sdk.sendCloseModal();
    if (!await waitUntil(s, () => !alive() || (s.tick() > closeTick && s.sdk.getState()?.interface.isOpen === false && s.sdk.getState()?.bank.isOpen === false && !s.sdk.getState()?.dialog.isOpen), { timeoutTicks: 8 }) || !alive()) {
        throw Error('orb Glory interface closure unconfirmed');
    }
    const controller = new AbortController();
    const off = s.onTick(() => {
        if (!alive()) controller.abort('orb Glory life');
    });
    try {
        await runner(s, [{ kind: 'travel', travel: edge, at: null, to: edge.to }], { maxRetriesPerLeg: 1, legTimeoutTicks: 30, signal: controller.signal });
    } catch {} finally {
        off();
    }
    const paid = () => {
        const at = s.sdk.getState()?.player;
        return !!at && at.level === edge.to.level && Math.max(Math.abs(at.worldX - edge.to.x), Math.abs(at.worldZ - edge.to.z)) <= 2 && orbPackEffect(before, orbPack(s), delta) && s.sdk.getSkillXp('Magic') === xp;
    };
    if (!await waitUntil(s, () => !alive() || paid(), { timeoutTicks: 8 }) || !alive() || !paid()) throw Error('orb Glory exact charge/landing receipt unconfirmed');
    console.log('ORB_GLORY_RETURN ' + JSON.stringify({ id: g.id, next: g.nextId, to: edge.to }));
    return delta;
}

export const orbHome = (kind: OrbKind, returnMode?: 'spell' | 'glory') =>
    returnMode === 'glory' ? { x: 3094, z: 3491 } : kind === 'air' || kind === 'earth' ? { x: 3185, z: 3436 } : { x: 2945, z: 3369 };

export function orbTripBudget(target: number, batch: number, cap: number) {
    if (![target, batch, cap].every(n => Number.isSafeInteger(n) && n > 0) || batch > 10 || target > 1000 || cap > 100000) throw Error('invalid finite orb trip');
    return Math.ceil(target / batch);
}

export function orbPlanEndsAt(from: { x: number; z: number }, to: { x: number; z: number }, corners: readonly { x: number; z: number }[], tol = 1) {
    const end = corners.at(-1) ?? from;
    return Math.max(Math.abs(end.x - to.x), Math.abs(end.z - to.z)) <= tol;
}

export function orbPeerEquipment(client: unknown, peer: Pick<NearbyPlayer, 'index' | 'name' | 'combatLevel'>): number[] | undefined {
    const p = (client as any)?.players?.[peer.index];
    if (!p || p.ready !== true || p.transmog || p.name?.toLowerCase() !== peer.name.toLowerCase() || p.combatLevel !== peer.combatLevel || p.appearance?.length !== 12) return;
    const raw = Array.from(p.appearance) as number[];
    if (raw.some(v => !Number.isSafeInteger(v) || v < 0 || v > 65534)) return;
    return raw.filter(v => v >= 512).map(v => v - 512);
}

function defaultWildernessLevel(p: { worldX: number; worldZ: number; level: number }) {
    if (![p.worldX, p.worldZ, p.level].every(Number.isSafeInteger) || p.worldX < 0 || p.worldZ < 0 || p.level < 0 || p.level > 3) return undefined;
    if (p.worldX >= 2944 && p.worldX <= 3391) {
        if (p.worldZ >= 3520 && p.worldZ <= 6399) return Math.trunc((p.worldZ - 3520) / 8) + 1;
        if (p.worldZ >= 9920 && p.worldZ <= 12799 && p.level === 0) return Math.trunc((p.worldZ - 9920) / 8) + 1;
    }
    return 0;
}

export function classifyOrbPeer(
    own: { worldX: number; worldZ: number; level: number; combatLevel: number },
    peer: NearbyPlayer,
    gear: readonly number[] | undefined,
    policy: OrbPlayerPolicy,
    wildernessFn?: (p: { worldX: number; worldZ: number; level: number }) => number | undefined,
) {
    const wildy = wildernessFn ?? defaultWildernessLevel;
    const mine = wildy(own);
    const theirs = wildy({ worldX: peer.worldX ?? peer.x, worldZ: peer.worldZ ?? peer.z, level: own.level });
    if (!Number.isFinite(peer.distance) || peer.distance > policy.radius || mine === 0 || theirs === 0) return 'ignore';
    if (mine === undefined || theirs === undefined || !Number.isSafeInteger(own.combatLevel) || own.combatLevel < 3 || own.combatLevel > 126 || !Number.isSafeInteger(peer.combatLevel) || peer.combatLevel < 3 || peer.combatLevel > 126) {
        return policy.unknownAppearance === 'escape' ? 'unknown' : 'ignore';
    }
    if (Math.abs(own.combatLevel - peer.combatLevel) > Math.min(mine, theirs)) return 'ignore';
    if (gear === undefined) return policy.unknownAppearance === 'escape' ? 'unknown' : 'ignore';
    return gear.some(id => [1381, 1397, 1405].includes(id)) ? 'air-staff' : 'danger';
}

export function orbPlayerDetection(s: Session, policy: OrbPlayerPolicy, wildernessFn?: (p: { worldX: number; worldZ: number; level: number }) => number | undefined) {
    let trigger: { name: string; index: number; combatLevel: number; reason: string; tick: number; publicEquipment: number[] | null } | undefined;
    return {
        get trigger() {
            return trigger;
        },
        check: () => {
            if (trigger) return true;
            const st = s.sdk.getState();
            if (!st?.player || s.sdk.getStateAge() > 5000) throw Error('orb player observation unavailable');
            for (const peer of st.nearbyPlayers) {
                if (peer.name.toLowerCase() === s.name.toLowerCase()) continue;
                const gear = orbPeerEquipment(s.client, peer);
                const reason = classifyOrbPeer(st.player, peer, gear, policy, wildernessFn);
                if (reason === 'danger' || reason === 'unknown') {
                    trigger = { name: peer.name, index: peer.index, combatLevel: peer.combatLevel, reason, tick: s.tick(), publicEquipment: gear ?? null };
                    console.log('ORB_PLAYER_TRIGGER ' + JSON.stringify(trigger));
                    return true;
                }
            }
            return false;
        },
    };
}

export function orbOwnedActions(s: Pick<Session, 'sdk'>, allowed: () => boolean) {
    const sdk = new Proxy(s.sdk, {
        get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            return typeof value === 'function'
                ? function (...args: unknown[]) {
                      if (typeof key === 'string' && key.startsWith('send') && !allowed()) throw Error('orb dispatch original life/input owner absent');
                      return value.apply(receiver, args);
                  }
                : value;
        },
    });
    return { sdk, bot: new BotActions(sdk) };
}

export function orbInputOwner(s: Pick<Session, 'client'>) {
    const client = s.client as any;
    const original = client?.executeBotAction;
    if (typeof original !== 'function') throw Error('orb input executor unknown');
    let expected = original;
    let lost = false;
    const valid = () => {
        if (s.client !== client || client.executeBotAction !== expected) lost = true;
        return !lost;
    };
    const requireOwner = () => {
        if (!valid()) throw Error('orb input owner replaced');
    };
    return {
        valid,
        requireOwner,
        scoped: (install: () => () => void) => {
            requireOwner();
            const prior = expected;
            const restore = install();
            const bridge = client.executeBotAction;
            if (typeof bridge !== 'function') {
                lost = true;
                throw Error('orb scoped executor absent');
            }
            expected = bridge;
            return () => {
                if (!valid()) return;
                restore();
                if (client.executeBotAction !== prior) {
                    lost = true;
                    return;
                }
                expected = prior;
            };
        },
    };
}

async function defaultWithdrawBankOwned(s: Session, id: number, amount: number) {
    const n = () => s.sdk.getInventory().filter(i => i.id === id).reduce((v, i) => v + i.count, 0);
    const before = n();
    const observed = s.bankObservation?.();
    const summary = observed?.items.find(i => i.id === id);
    const item = s.sdk.getState()?.bank.items.find(i => i.id === id);
    if (!summary || !item || summary.count < amount || item.count < amount || summary.count !== item.count) {
        throw Error(`orb OWN bank item/count unknown ${id}:${amount}`);
    }
    if (!(await s.bot.withdrawItem(item, amount, { asNote: false })).success || !await waitUntil(s, () => n() === before + amount, { timeoutTicks: 10 })) {
        throw Error(`orb OWN withdrawal unobserved ${id}:${amount}`);
    }
}

type Charge = (s: Session, kind: OrbKind, n: number, cap: number, stop: () => boolean, scopedBridge?: () => () => void) => Promise<{ ok: boolean; made: number; detail: string }>;

export async function runOrbTrips(
    s: Session,
    kind: OrbKind,
    recipe: (typeof orbRecipes)[OrbKind],
    charge: Charge,
    o: { target: number; batch: number; cap: number; stop: () => boolean } & OrbOptions,
    deps?: ArtisanExternalDeps,
) {
    const ORB_GLORY = orbGloryList();
    orbTripBudget(o.target, o.batch, o.cap);
    validateOrbOptions(o);
    if ((o.staff !== undefined || o.energy || o.returnMode === 'glory') && (s.client as any).membersAccount !== 1) {
        throw Error('orb options need observed member connection');
    }
    const home = orbHome(kind, o.returnMode);
    const deep = kind === 'water' || kind === 'fire';
    const tele = nativeTeleport(deep ? 'falador' : 'varrock');
    const state = () => s.sdk.getState();
    const pos = () => state()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const pack = () => s.sdk.getInventory();
    const held = (id: number) => pack().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const start = s.tick();
    const p0 = pos();
    if (!p0 || p0.level !== 0 || Math.max(Math.abs(p0.worldX - home.x), Math.abs(p0.worldZ - home.z)) > 4 || hp() < 70 || (s.sdk.getSkill('Magic')?.baseLevel ?? 0) < recipe.level || (s.sdk.getSkill('Prayer')?.baseLevel ?? 0) < 43) {
        throw Error('orb trip needs exact home bank, HP70, native orb Magic and Prayer43');
    }
    const initialRetaliate = state()?.autoRetaliateEnabled;
    if (typeof initialRetaliate !== 'boolean') throw Error('orb auto-retaliate state unknown');
    const inputOwner = orbInputOwner(s);
    const initialLife = p0.lifeId;
    const initialRespawns = p0.respawnCount ?? 0;
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const alive = () => inputOwner.valid() && !!pos() && !ended && !pos()!.isDead && pos()!.lifeId === initialLife && (pos()!.respawnCount ?? 0) === initialRespawns && hp() > 0;
    const basicOver = () => !alive() || o.stop() || s.tick() - start >= o.cap;
    const wildyFn = deps?.monitorWildernessLevel ? (p: { worldX: number; worldZ: number; level: number }) => deps.monitorWildernessLevel!(p) : undefined;
    const playerMonitor = o.playerDetection ? orbPlayerDetection(s, o.playerDetection, wildyFn) : undefined;
    const over = () => basicOver() || !!playerMonitor?.check();
    const bound = orbOwnedActions(s, alive);
    const view = Object.create(s) as Session;
    Object.defineProperties(view, { sdk: { value: bound.sdk }, bot: { value: bound.bot } });
    s = view;
    const ownedInput = async <T>(action: () => Promise<T> | T) => {
        if (!alive()) throw Error('orb original life/input owner absent');
        const result = await action();
        if (!alive()) throw Error('orb original life/input owner lost during input');
        return result;
    };
    let made = 0;
    let trips = 0;
    let failure = '';
    let banked = false;
    let escaped = 0;
    let antidoteAt = -10000;
    let energyDoses = 0;
    let energyAttempts = 0;
    let gloryReturns = 0;
    let gloryUncertain = false;
    let energyUncertain = false;
    let supplyPotionUncertain = false;
    let selectedStaff: number | undefined;
    const delta: Record<number, number> = {};
    const trace: unknown[] = [];
    const change = (id: number, n: number) => {
        delta[id] = (delta[id] ?? 0) + n;
    };
    const totals = () => {
        const out: Record<number, number> = {};
        for (const i of [...pack(), ...s.sdk.getEquipment(), ...(s.bankObservation?.()?.items ?? [])]) out[i.id] = (out[i.id] ?? 0) + i.count;
        return out;
    };
    const mark = (phase: string) => {
        const p = pos();
        const v = { phase, tick: s.tick() - start, position: p && [p.worldX, p.worldZ, p.level], hp: hp(), prayer: state()?.prayers.prayerPoints, made };
        trace.push(v);
        console.log('ORB_TRIP ' + JSON.stringify(v));
    };
    const snapshot = () => new Map(pack().map(i => [i.id, held(i.id)]));
    const potion = async (ids: number[]) => {
        if (supplyPotionUncertain) throw Error('orb prior supply potion outcome unresolved');
        const row = pack().find(i => ids.includes(i.id));
        if (!row) throw Error('orb owned potion exhausted');
        const before = orbPack(s);
        const rec = orbSupplyRecipe(row.id);
        const d = { [row.id]: -1, [rec.next]: 1 };
        supplyPotionUncertain = true;
        try {
            await drinkOrbSupplyPotion(s, row.id, alive);
            supplyPotionUncertain = false;
        } finally {
            if (orbPackEffect(before, orbPack(s), d)) for (const [id, n] of Object.entries(d)) change(Number(id), n);
        }
    };
    const guard = async (cleanup = false) => {
        if (o.energy && !cleanup && !over() && hp() >= 25 && !energyUncertain && energyAttempts < o.energy.maximumDoses && (state()?.player?.runEnergy ?? 101) < o.energy.below) {
            const family = ORB_ENERGY.find(e => e.id === o.energy!.id)!.gain;
            const row = pack().find(i => ORB_ENERGY.some(e => e.id === i.id && e.gain === family));
            if (row) {
                energyAttempts++;
                energyUncertain = true;
                const effect = await drinkOrbEnergy(s, row.id, alive);
                for (const [id, n] of Object.entries(effect)) change(Number(id), n);
                energyDoses++;
                energyUncertain = false;
            }
        }
        if (antidoteAt >= 0 && s.tick() - antidoteAt > 400) {
            await potion([2448, 181, 183, 185]);
            antidoteAt = s.tick();
        }
        if (!alive() || (!cleanup && over()) || hp() < 25) throw Error('orb stop/life/HP floor');
        if (hp() < 70) {
            const row = pack().find(i => i.id === 385);
            const n = held(385);
            const h = hp();
            if (!row) throw Error('orb owned food exhausted');
            await ownedInput(() => s.bot.eatFood(row));
            if (!await waitUntil(s, () => (held(385) === n - 1 && hp() > h) || !alive(), { timeoutTicks: 8 }) || held(385) !== n - 1 || hp() <= h) {
                throw Error('orb food effect absent');
            }
            change(385, -1);
        }
        if ((state()?.prayers.prayerPoints ?? 0) < 20) {
            const p = state()?.prayers.prayerPoints ?? 0;
            await potion([2434, 139, 141, 143]);
            if ((state()?.prayers.prayerPoints ?? 0) <= p) throw Error('orb prayer restoration absent');
        }
    };
    const setRetaliate = async (value: boolean) => {
        if (state()?.autoRetaliateEnabled === value) return;
        await ownedInput(() => s.direct({ type: 'clickComponent', componentId: value ? 150 : 151, reason: 'finite orb transit ownership' }));
        if (!await waitUntil(s, () => state()?.autoRetaliateEnabled === value, { timeoutTicks: 8 })) throw Error('orb auto-retaliate state unobserved');
    };
    const protect = async (on: boolean) => {
        if (state()?.prayers.activePrayers[14] !== on) {
            await ownedInput(() => s.direct({ type: 'togglePrayer', prayerIndex: 14, reason: 'orb trip route protection' }));
            if (!await waitUntil(s, () => state()?.prayers.activePrayers[14] === on, { timeoutTicks: 8 })) throw Error('orb protection effect absent');
        }
    };
    const walk = async (x: number, z: number, cleanup = false, tol = 1) => {
        await guard(cleanup);
        mark('walk ' + x + ',' + z);
        let routeFailure = '';
        const walker = await sessionWalker(s);
        const originalPlan = walker.plan;
        const underground = pos()!.worldZ > 9000;
        const boxed = (p: { x: number; z: number }) => (deep ? p.x >= 2810 && p.x <= 2935 && p.z >= 9750 && p.z <= 9840 : p.x >= 3078 && p.x <= 3140 && p.z >= 9850 && p.z <= 9980);
        if (underground && boxed({ x: pos()!.worldX, z: pos()!.worldZ }) && boxed({ x, z })) {
            const pf = await import('../../../../vendor/rs-sdk/sdk/pathfinding');
            const grid = await import('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
            walker.plan = (level, from, to) => {
                if (level !== 0 || !boxed(from) || !boxed(to) || !state()?.prayers.activePrayers[14] || (state()?.prayers.prayerPoints ?? 0) < 5 || hp() < 50 || held(385) < 1 || s.tick() - antidoteAt > 600) {
                    throw Error('orb protected corridor requirements lost');
                }
                pf.initPathfinding();
                const blocks = applyKnownDoorBlocks(s.sdk, level, from, to).map(b => (b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b));
                const corners = withDoorPolicy(grid, blocks, () => pf.findLongPath(level, from.x, from.z, to.x, to.z, 500, (s.sdk as any).temporaryDoorBlocks?.active?.() ?? []));
                console.log('ORB_PLAN ' + JSON.stringify({ from, to, protected: true, corners }));
                if (!orbPlanEndsAt(from, to, corners, tol)) {
                    routeFailure = 'orb native collision plan stops short ' + JSON.stringify({ from, to, end: corners.at(-1) ?? from, tol });
                    return [];
                }
                return corners;
            };
        } else {
            walker.plan = (level, from, to) => {
                const corners = originalPlan(level, from, to);
                console.log('ORB_PLAN ' + JSON.stringify({ from, to, protected: false, corners }));
                if (!orbPlanEndsAt(from, to, corners, tol)) {
                    routeFailure = 'orb native collision plan stops short ' + JSON.stringify({ from, to, end: corners.at(-1) ?? from, tol });
                    return [];
                }
                return corners;
            };
        }
        if (!orbPlanEndsAt({ x: pos()!.worldX, z: pos()!.worldZ }, { x, z }, walker.plan(pos()!.level, { x: pos()!.worldX, z: pos()!.worldZ }, { x, z }), tol)) {
            throw Error(routeFailure || 'orb native collision goal unavailable');
        }
        const r = await walkPath(walker, [{ x, z, tol }], {
            maxTicks: 400,
            stop: () => !!routeFailure || !alive() || hp() < 50 || (underground && (!state()?.prayers.activePrayers[14] || (state()?.prayers.prayerPoints ?? 0) < 5)) || (!cleanup && over()),
        });
        if (!r.ok) throw Error(routeFailure || 'orb route ' + r.detail);
        await guard(cleanup);
    };
    const open = async () => {
        await ownedInput(() => s.sdk.sendCloseModal());
        if (!await waitUntil(s, () => !state()?.interface.isOpen && !state()?.bank.isOpen, { timeoutTicks: 8 })) throw Error('orb interface close absent');
        const gen = s.bankObservation?.()?.generation ?? -1;
        if (!(await ownedInput(() => s.bot.openBank())).success || !await waitUntil(s, () => !!state()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > gen, { timeoutTicks: 15 }) || !s.bankObservation?.()) {
            throw Error('orb fresh bank absent');
        }
    };
    const deposit = async () => {
        await open();
        for (const id of new Set(pack().map(i => i.id))) {
            const row = pack().find(i => i.id === id);
            if (row) await ownedInput(() => depositObserved(s, row));
        }
    };
    const close = async () => {
        await ownedInput(() => s.bot.closeBank());
        if (!await waitUntil(s, () => !state()?.bank.isOpen && !state()?.interface.isOpen, { timeoutTicks: 8 })) throw Error('orb bank close absent');
    };
    const interact = async (id: number, x: number, z: number, to: () => boolean, key?: number) => {
        await guard();
        const loc = state()?.nearbyLocs.find(l => l.id === id && l.x === x && l.z === z);
        const op = loc?.optionsWithIndex[0];
        const row = key ? pack().find(i => i.id === key) : undefined;
        if (!loc || !op || (key && !row)) throw Error('orb native entry absent ' + id);
        mark('interact ' + id);
        if ([1568, 1570].includes(id)) {
            const approach = await interactionApproach(s.sdk, { x, z, level: 0 }, { id, shape: 22, angle: 2, width: 1, height: 1, blockAccessFlags: 0, src: 'maps/m48_54.jm2', configSrc: 'general_use/scripts/trapdoors.rs2' });
            if (!approach) throw Error('orb floor native approach absent');
            await walk(approach.x, approach.z, false, 0);
            if (!deps?.installOrbFloorBridge) throw Error('orb trapdoor bridge requires deps.installOrbFloorBridge');
            const restore = inputOwner.scoped(() => deps.installOrbFloorBridge!(s.client, approach));
            try {
                await ownedInput(() => s.direct({ type: 'orbFloorLoc', x, z, locId: id, reason: 'observed orb dungeon trapdoor' }));
            } finally {
                restore();
            }
        } else if (row) {
            await ownedInput(() => s.sdk.sendUseItemOnLoc(row.slot, x, z, id));
        } else {
            await ownedInput(() => s.sdk.sendInteractLoc(x, z, id, op.opIndex));
        }
        if (!await waitUntil(s, () => to() || !alive(), { timeoutTicks: 20 }) || !to()) {
            throw Error('orb native entry effect absent ' + id + ' ' + JSON.stringify({ position: pos(), loc, messages: state()?.gameMessages.slice(-5) }));
        }
        if ([1755, 1759].includes(id)) {
            if (!await waitUntil(s, () => !alive() || (pos()?.animId ?? -1) === -1, { timeoutTicks: 12 }) || !alive()) throw Error('orb ladder animation did not settle');
            await waitTicks(s, 3);
            if (!to()) throw Error('orb ladder landing changed during scene settle');
        }
        mark('entered ' + id);
    };
    const approachObelisk = async () => {
        const at = orbSites[kind];
        const q = orbInteractions[kind];
        if (!state()?.nearbyLocs.some(l => l.id === recipe.loc && l.x === at.x && l.z === at.z && l.level === 0)) {
            throw Error('orb exact native obelisk observation absent');
        }
        const end = await interactionApproach(s.sdk, { ...at, level: 0 }, { id: recipe.loc, ...q, blockAccessFlags: 0, configSrc: 'scripts/_unpack/225/all.loc' });
        if (!end) throw Error('orb native footprint approach unavailable');
        console.log('ORB_APPROACH ' + JSON.stringify({ kind, loc: recipe.loc, anchor: at, interaction: q, end }));
        await walk(end.x, end.z, false, 0);
    };
    const near = (x: number, z: number, n = 3) => !!pos() && pos()!.level === 0 && Math.max(Math.abs(pos()!.worldX - x), Math.abs(pos()!.worldZ - z)) <= n;
    let initial: Record<number, number> | undefined;
    let final: Record<number, number> | undefined;
    const escape = async () => {
        if (!alive()) throw Error('orb escape life absent');
        if (o.returnMode === 'glory') {
            if (gloryUncertain) throw Error('orb prior Glory outcome unresolved');
            const at = pos()!;
            const landed = at.level === 0 && Math.max(Math.abs(at.worldX - 3087), Math.abs(at.worldZ - 3496)) <= 8;
            if (!landed && gloryReturns >= Math.ceil(o.target / o.batch)) throw Error('orb finite Glory return budget exhausted');
            gloryUncertain = true;
            const effect = await returnOrbGlory(s, alive);
            gloryUncertain = false;
            if (Object.keys(effect).length) {
                for (const [id, n] of Object.entries(effect)) change(Number(id), n);
                gloryReturns++;
                escaped++;
            }
            await protect(false);
            await walk(home.x, home.z, true);
            return;
        }
        await ownedInput(() => s.sdk.sendCloseModal());
        const costs = Object.fromEntries(Object.entries(tele.runes).map(([id, n]) => [id, elementalRuneCost(Number(id), n, s.sdk.getEquipment(), true)]));
        const before = Object.fromEntries(snapshot());
        const xp = s.sdk.getSkillXp('Magic') ?? 0;
        const result = await runTeleportMagic(s, tele, { casts: 1, cap: 50, members: true, stop: () => !alive() });
        if (!result.ok && !teleportReceipt(tele, costs, before, Object.fromEntries(snapshot()), xp, s.sdk.getSkillXp('Magic') ?? 0, pos())) {
            throw Error('orb native escape ' + result.failure);
        }
        for (const [id, n] of Object.entries(costs)) change(Number(id), -n);
        escaped++;
        await protect(false);
        await walk(home.x, home.z, true);
    };
    const withdrawFn = deps?.withdrawFireOwned ? (sess: Session, id: number, q: number) => deps.withdrawFireOwned!(sess, id, q) : defaultWithdrawBankOwned;
    try {
        await open();
        initial = totals();
        if (o.staff !== undefined) {
            selectedStaff = ownedOrbStaff(Object.entries(initial).map(([id, count]) => ({ id: Number(id), count })), recipe.rune, o.staff);
            if (selectedStaff === undefined) throw Error('orb owned elemental staff unavailable');
        }
        if (o.returnMode === 'glory' && ORB_GLORY.reduce((n, g) => n + (initial![g.id] ?? 0) * g.charges, 0) < Math.ceil(o.target / o.batch)) {
            throw Error('orb owned Glory charges short');
        }
        if (o.energy) {
            const family = ORB_ENERGY.find(e => e.id === o.energy!.id)!.gain;
            if (ORB_ENERGY.filter(e => e.gain === family).reduce((n, e) => n + (initial![e.id] ?? 0) * e.doses, 0) < o.energy.maximumDoses) {
                throw Error('orb owned energy doses short');
            }
        }
        await setRetaliate(false);
        await deposit();
        await close();
        for (const row of [...s.sdk.getEquipment()]) {
            await ownedInput(() => s.bot.unequipItem(row));
            if (!await waitUntil(s, () => !s.sdk.getEquipment().some(i => i.slot === row.slot), { timeoutTicks: 8 })) throw Error('orb equipment deposit absent');
        }
        await deposit();
        await close();
        while (made < o.target && !over()) {
            const n = Math.min(o.batch, o.target - made);
            const elementCost = selectedStaff === undefined ? 30 : elementalRuneCost(recipe.rune, 30, [{ id: selectedStaff, slot: 3 }], true);
            const needs: Record<number, number> = { 567: n, 564: n * 3, 385: 6, 2434: 1, 2448: 1 };
            if (elementCost) needs[recipe.rune] = n * elementCost;
            if (o.returnMode !== 'glory') {
                for (const [id, q] of Object.entries(tele.runes)) {
                    const cost = selectedStaff === undefined ? q : elementalRuneCost(Number(id), q, [{ id: selectedStaff, slot: 3 }], true);
                    if (cost) needs[Number(id)] = (needs[Number(id)] ?? 0) + cost;
                }
            }
            if (selectedStaff !== undefined && !s.sdk.getEquipment().some(i => i.id === selectedStaff && i.slot === 3)) needs[selectedStaff] = 1;
            if (deep) {
                needs[1590] = 1;
                needs[1540] = 1;
                needs[1113] = 1;
                needs[1079] = 1;
            }
            await open();
            if (o.returnMode === 'glory') {
                const row = s.bankObservation?.()?.items.filter(i => i.count > 0 && ORB_GLORY.some(g => g.id === i.id)).sort((a, b) => ORB_GLORY.find(g => g.id === b.id)!.charges - ORB_GLORY.find(g => g.id === a.id)!.charges)[0];
                if (!row) throw Error('orb owned charged Glory unavailable');
                needs[row.id] = 1;
            }
            if (o.energy && energyAttempts < o.energy.maximumDoses) {
                const family = ORB_ENERGY.find(e => e.id === o.energy!.id)!.gain;
                const row = s.bankObservation?.()?.items.filter(i => i.count > 0 && ORB_ENERGY.some(e => e.id === i.id && e.gain === family)).sort((a, b) => a.id - b.id)[0];
                if (!row) throw Error('orb owned energy potion unavailable');
                needs[row.id] = 1;
            }
            for (const [id, q] of Object.entries(needs)) {
                if (over()) throw Error('orb staging stopped');
                await ownedInput(() => withdrawFn(s, Number(id), q));
            }
            await close();
            if (selectedStaff !== undefined && !s.sdk.getEquipment().some(i => i.id === selectedStaff && i.slot === 3)) await equipOrbStaff(s, selectedStaff, alive);
            if (deep) {
                for (const [id, slot] of [
                    [1540, 5],
                    [1113, 4],
                    [1079, 7],
                ]) {
                    const row = pack().find(i => i.id === id);
                    if (!row) throw Error('orb armour stock absent');
                    await ownedInput(() => s.bot.equipItem(row));
                    if (!await waitUntil(s, () => s.sdk.getEquipment().some(i => i.id === id && i.slot === slot), { timeoutTicks: 8 })) throw Error('orb native armour equip absent');
                }
            }
            if (s.tick() - antidoteAt > 400) {
                await potion([2448, 181, 183, 185]);
                antidoteAt = s.tick();
            }
            await guard();
            await protect(true);
            mark('staged');
            if (!deep) {
                await walk(3097, 3468);
                if (state()?.nearbyLocs.some(l => l.id === 1568 && l.x === 3097 && l.z === 3468)) {
                    await interact(1568, 3097, 3468, () => !!state()?.nearbyLocs.some(l => l.id === 1570 && l.x === 3097 && l.z === 3468));
                }
                await interact(1570, 3097, 3468, () => near(3096, 9867));
                await walk(3131, 9916);
                await walk(3131, 9921);
                await walk(3086, 9932);
                if (kind === 'air') {
                    await walk(3088, 9971);
                    await interact(1755, 3088, 9971, () => near(3088, 3571));
                }
            } else {
                await walk(2884, 3397);
                await interact(1759, 2884, 3397, () => near(2884, 9797));
                for (const [x, z] of [
                    [2886, 9817],
                    [2889, 9831],
                    [2910, 9830],
                    [2924, 9803],
                ]) {
                    await walk(x!, z!);
                }
                const x0 = pos()!.worldX;
                await interact(2623, 2924, 9803, () => pos()!.worldX !== x0 && [2923, 2924].includes(pos()!.worldX) && pos()!.worldZ === 9803, 1590);
                await waitTicks(s, 3);
                for (const [x, z] of [
                    [2904, 9803],
                    [2895, 9792],
                    [2850, 9809],
                    [2842, 9824],
                ]) {
                    await walk(x!, z!);
                }
                if (kind === 'water') await interact(1755, 2842, 9824, () => near(2842, 3424));
                else await walk(2819, 9828);
            }
            await approachObelisk();
            mark('obelisk');
            for (let i = 0; i < n; i++) {
                await guard();
                const chargeStop = playerMonitor
                    ? () => {
                          playerMonitor.check();
                          return basicOver();
                      }
                    : over;
                const r = await charge(s, kind, 1, 40, chargeStop, () => inputOwner.scoped(() => installSpellLocBridge(s.client)));
                made += r.made;
                change(567, -r.made);
                change(recipe.output, r.made);
                change(564, -3 * r.made);
                change(recipe.rune, -elementCost * r.made);
                if (!r.ok) throw Error('orb native charge ' + r.detail);
                await waitTicks(s, 3);
                if (playerMonitor?.check()) throw Error('orb player policy interrupted after exact paid charge');
            }
            await escape();
            await deposit();
            await close();
            trips++;
            mark('refilled');
            if (deep) {
                for (const row of [...s.sdk.getEquipment()]) {
                    await ownedInput(() => s.bot.unequipItem(row));
                    await waitUntil(s, () => !s.sdk.getEquipment().some(i => i.slot === row.slot), { timeoutTicks: 8 });
                }
                await deposit();
                await close();
            }
        }
        if (made !== o.target) throw Error('orb finite target incomplete');
    } catch (e) {
        failure = String(e);
    } finally {
        if (alive()) {
            try {
                if (!near(home.x, home.z, 4) && (o.returnMode === 'glory' ? !gloryUncertain && (pack().some(i => ORB_GLORY.some(g => g.id === i.id)) || near(3087, 3496, 8)) : held(563) > 0)) {
                    await escape();
                }
                await protect(false);
                if (near(home.x, home.z, 4)) {
                    await deposit();
                    for (const row of [...s.sdk.getEquipment()]) {
                        await close();
                        await ownedInput(() => s.bot.unequipItem(row));
                        await waitUntil(s, () => !s.sdk.getEquipment().some(i => i.slot === row.slot), { timeoutTicks: 8 });
                        await deposit();
                    }
                    final = totals();
                    banked = true;
                    await close();
                    await setRetaliate(initialRetaliate);
                }
            } catch (e) {
                failure += [failure ? '; ' : '', String(e)].join('');
            }
        }
    }
    const issues =
        initial && final
            ? [...new Set([...Object.keys(initial), ...Object.keys(final), ...Object.keys(delta)].map(Number))]
                  .filter(id => (final![id] ?? 0) - (initial![id] ?? 0) !== (delta[id] ?? 0))
                  .map(id => ({ id, actual: (final![id] ?? 0) - (initial![id] ?? 0), expected: delta[id] ?? 0 }))
            : ['bank asset snapshot absent'];
    if (issues.length) failure += '; orb asset mismatch ' + JSON.stringify(issues);
    return {
        inputOwnershipLost: !inputOwner.valid(),
        supplyPotionUncertain,
        playerDetection: playerMonitor ? { policy: o.playerDetection, trigger: playerMonitor.trigger, interrupted: !!playerMonitor.trigger } : null,
        targetMet: made === o.target,
        options: o.staff !== undefined || o.energy || o.returnMode ? { staff: o.staff ?? null, energy: o.energy ?? null, returnMode: o.returnMode ?? 'spell' } : null,
        selectedStaff: selectedStaff ?? null,
        energyDoses,
        energyAttempts,
        gloryReturns,
        ok: !failure && banked && alive() && made === o.target,
        kind,
        made,
        trips,
        banked,
        escaped,
        initialRetaliate,
        retaliateRestored: state()?.autoRetaliateEnabled === initialRetaliate,
        initial,
        final,
        delta,
        issues,
        trace,
        ticks: s.tick() - start,
        failure,
    };
}

// ---- Bones to Bananas (microbot-bones.ts) ----

export type BonesSnapshot = { bones: number; bananas: number; earth: number; water: number; nature: number; xp: number };
export type BonesCosts = { earth: number; water: number; nature: number };

export interface BonesIO {
    tick(): number;
    stopped(): boolean;
    level(): number;
    read(): BonesSnapshot;
    costs?(): BonesCosts;
    prepare(maximum: number): Promise<boolean>;
    cast(): Promise<unknown>;
    wait(done: () => boolean): Promise<unknown>;
    deposit(): Promise<number>;
    close(): Promise<void>;
}

export function bonesEffect(b: BonesSnapshot, a: BonesSnapshot, costs: BonesCosts = { earth: 2, water: 2, nature: 1 }): boolean {
    return b.bones > 0 && a.bones === 0 && a.bananas - b.bananas === b.bones && b.earth - a.earth === costs.earth && b.water - a.water === costs.water && b.nature - a.nature === costs.nature && a.xp > b.xp;
}

export async function runBonesConversion(io: BonesIO, o: { maximum: number; cap: number }) {
    if (!Number.isSafeInteger(o.maximum) || o.maximum < 1 || !Number.isSafeInteger(o.cap) || o.cap < 1) throw Error('invalid bones conversion limits');
    const start = io.tick();
    let made = 0;
    let banked = 0;
    let casts = 0;
    let failure = '';
    const over = () => io.stopped() || io.tick() - start >= o.cap;
    try {
        if (io.level() < 15) throw Error('bones conversion requires Magic 15');
        if (io.read().bananas) throw Error('bank existing bananas before conversion');
        while (made < o.maximum && !over()) {
            if (!(await io.prepare(o.maximum - made))) throw Error('bones conversion inputs unavailable');
            if (over()) break;
            const before = io.read();
            const costs = io.costs?.() ?? { earth: 2, water: 2, nature: 1 };
            if (before.bones < 1 || before.bones > o.maximum - made || before.earth < costs.earth || before.water < costs.water || before.nature < costs.nature) {
                throw Error('bones conversion input bound failed');
            }
            casts++;
            await io.cast();
            await io.wait(() => over() || bonesEffect(before, io.read(), costs));
            if (!bonesEffect(before, io.read(), costs)) throw Error('bones conversion receipt mismatch');
            made += before.bones;
            banked += await io.deposit();
            if (banked !== made) throw Error('bones conversion bank receipt mismatch');
        }
        if (made !== o.maximum || over()) throw Error('bones conversion stopped before target or budget');
    } catch (e) {
        failure = String(e);
    } finally {
        try {
            await io.close();
        } catch (e) {
            failure ||= String(e);
        }
    }
    return { ok: !failure, made, banked, casts, ticks: io.tick() - start, failure: failure || '-' };
}

// Bones to Bananas: the runes of one cast, and the bones one cast converts (a pack holds 28 less the three rune stacks).
// BONES_TO_BANANAS_RUNES and BONES_PER_CAST are re-exported from ./recipes.

export async function runBonesBank(s: Session, o: { maximum: number; cap: number; members?: boolean; reserve?: number; stop?: () => boolean }) {
    const reserve = o.reserve ?? 0;
    if (!Number.isSafeInteger(reserve) || reserve < 0) throw Error('invalid bones reserve');
    const ids = { bones: 526, bananas: 1963, earth: 557, water: 555, nature: 561 } as const;
    const inv = () => s.sdk.getInventory();
    const count = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const state = () => s.sdk.getState();
    if (!await waitUntil(s, () => !!state()?.player && !!s.sdk.getSkill('Magic') && !!s.sdk.getSkill('Hitpoints'), { timeoutTicks: 10 })) {
        throw Error('bones conversion initial state unavailable');
    }
    const p0 = state()!.player;
    const costs = (): BonesCosts => ({ earth: elementalRuneCost(557, BONES_TO_BANANAS_RUNES[557], s.sdk.getEquipment(), !!o.members), water: elementalRuneCost(555, BONES_TO_BANANAS_RUNES[555], s.sdk.getEquipment(), !!o.members), nature: BONES_TO_BANANAS_RUNES[561] });
    const protectedItems = new Map(inv().filter(i => !Object.values(ids).includes(i.id as any)).map(i => [i.id, count(i.id)]));
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const stopped = () => {
        const p = state()?.player;
        return ended || !!o.stop?.() || !p || p.isDead || (s.sdk.getSkill('Hitpoints')?.level ?? 0) <= 0 || (p.respawnCount ?? 0) > (p0?.respawnCount ?? 0) || (p0?.lifeId !== undefined && p.lifeId !== p0.lifeId);
    };
    const open = async () => {
        if (stopped()) throw Error('bones conversion session stopped');
        const ready = () => !!state()?.bank?.isOpen && !!s.bankObservation?.();
        if (ready()) return;
        if (state()?.dialog?.isOpen || state()?.interface?.isOpen) {
            await s.direct({ type: 'closeModal', reason: 'bones bank access' });
            if (!await waitUntil(s, () => !state()?.dialog?.isOpen && !state()?.interface?.isOpen, { timeoutTicks: 8 })) throw Error('bones conversion blocking interface remains');
        }
        const generation = s.bankObservation?.()?.generation ?? -1;
        if (stopped() || !(await s.bot.openBank()).success) throw Error('bones conversion bank unavailable');
        if (!await waitUntil(s, () => ready() && (s.bankObservation?.()?.generation ?? -1) > generation, { timeoutTicks: 10 })) throw Error('bones conversion fresh bank unknown');
    };
    const read = (): BonesSnapshot => ({ ...(Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, count(id)])) as Omit<BonesSnapshot, 'xp'>), xp: s.sdk.getSkillXp('Magic') ?? 0 });
    const conversionStart = s.tick();
    const result = await runBonesConversion(
        {
            tick: () => s.tick(),
            stopped,
            level: () => s.sdk.getSkill('Magic')?.level ?? 0,
            read,
            costs,
            prepare: async maximum => {
                await open();
                if (stopped()) return false;
                if ((s.bankObservation?.()?.items ?? []).filter(i => i.id === ids.bones).reduce((n, i) => n + i.count, 0) + count(ids.bones) - reserve < maximum) return false;
                for (const [name, need] of Object.entries(costs()) as [keyof BonesCosts, number][]) {
                    const id = ids[name];
                    const missing = Math.max(0, need - count(id));
                    if (missing) {
                        const stock = (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
                        if (stock - missing < reserve || stopped()) return false;
                        const before = count(id);
                        const r = await s.bot.withdrawItem(new RegExp(`^${name} rune$`, 'i'), missing, { asNote: false });
                        if (!r.success || !await waitUntil(s, () => count(id) === before + missing, { timeoutTicks: 10 })) return false;
                    }
                }
                const owned = count(ids.bones);
                if (owned > maximum) return false;
                if (!owned) {
                    const available = (s.bankObservation?.()?.items ?? []).filter(i => i.id === ids.bones).reduce((n, i) => n + i.count, 0);
                    if (available - reserve < maximum) return false;
                    const amount = Math.min(maximum, available - reserve, 28 - inv().length);
                    if (amount < 1 || stopped()) return false;
                    const r = await s.bot.withdrawItem(/^bones$/i, amount, { asNote: false });
                    if (!r.success || !await waitUntil(s, () => count(ids.bones) === amount, { timeoutTicks: 10 })) return false;
                }
                if (stopped()) return false;
                await s.bot.closeBank();
                if (!await waitUntil(s, () => !state()?.bank?.isOpen, { timeoutTicks: 8 })) return false;
                return !stopped();
            },
            cast: () => s.direct({ type: 'clickComponent', componentId: componentId('magic:bones_to_bananas'), reason: 'SDK' }),
            wait: done => waitUntil(s, done, { timeoutTicks: 12 }),
            deposit: async () => {
                if (o.cap - (s.tick() - conversionStart) <= 3) throw Error('bones conversion bank budget exhausted');
                await waitTicks(s, 3);
                if (stopped() || s.tick() - conversionStart >= o.cap) throw Error('bones conversion stopped before bank');
                await open();
                if (stopped()) throw Error('bones conversion session stopped');
                const item = inv().find(i => i.id === ids.bananas);
                return item ? depositObserved(s, item) : 0;
            },
            close: async () => {
                if (!stopped()) await s.bot.closeBank();
            },
        },
        o,
    );
    if (stopped()) {
        result.ok = false;
        result.failure = 'bones conversion session stopped';
    }
    if ([...protectedItems].some(([id, n]) => count(id) !== n)) {
        result.ok = false;
        result.failure = 'bones conversion protected inventory changed';
    }
    console.log('MICROBOT_BONES ' + JSON.stringify(result));
    return result;
}

// ---- Earth Production (earth-production.ts, self-contained Air Altar without scripts/generated/rcair.ts) ----

const EARTH = 557;
const ESSENCE = 1436;
const AIR = 556;
const EARTH_WEST = { x: 3185, z: 3436 };
const EARTH_EAST = { x: 3253, z: 3420 };
const EARTH_DRAYNOR = { x: 3092, z: 3243 };
const EARTH_FOOD = [1891, 1893, 1895, 1985, 329, 333, 379];

export function earthProductionBatch(level: number, xp: number, missing: number, available: number) {
    if (!Number.isSafeInteger(level) || level < 1 || level > 99 || ![xp, missing, available].every(n => Number.isFinite(n) && n >= 0) || ![missing, available].every(Number.isSafeInteger)) {
        throw Error('earth production quantities unknown');
    }
    const air = level < 9;
    const multiple = air ? Math.floor(level / 11) + 1 : Math.floor(level / 26) + 1;
    const needed = air ? Math.max(0, Math.ceil((xpForLevel(9) - xp) / 125)) : Math.ceil(missing / multiple);
    return { rune: air ? AIR : EARTH, talisman: air ? 1438 : 1440, essence: missing ? Math.min(27, available, needed) : 0, multiple };
}

export function talismanTarget(id: number) {
    if (id === 1440) return { id, npcIds: [1, 2, 3, 4, 5, 6], spot: { x: 3221, z: 3219 } };
    if (id === 1438) return { id, npcIds: [100], spot: { x: 3255, z: 3226 } };
    throw Error('unsupported earth access drop');
}

export const productionMode = (profile: string) => (profile === 'owned-talismans' ? 'talismans' : profile === 'owned-craft' ? 'craft' : undefined);

export async function stageOwnedEquipment(
    ids: readonly number[],
    worn: () => readonly number[],
    withdraw: (id: number, n: number) => Promise<void>,
    close: () => Promise<unknown>,
    equip: (id: number) => Promise<void>,
) {
    for (const id of ids) if (!worn().includes(id)) await withdraw(id, 1);
    await close();
    for (const id of ids) if (!worn().includes(id)) await equip(id);
}

export async function collectHuntLoot(s: Session, stop: () => boolean, afterKill = false) {
    const loot = () => s.sdk.getState()?.groundItems.find(i => [1438, 1440, 557].includes(i.id) && i.distance <= 10);
    if (stop()) throw Error('earth hunt pickup stopped');
    if (afterKill) await waitUntil(s, () => stop() || !!loot(), { timeoutTicks: 6 });
    if (stop()) throw Error('earth hunt pickup stopped');
    const item = loot();
    if (!item) return null;
    const count = () => s.sdk.getInventory().filter(i => i.id === item.id).reduce((n, i) => n + i.count, 0);
    const before = count();
    await s.bot.pickupItem(item);
    const observed = await waitUntil(s, () => stop() || count() === before + item.count, { timeoutTicks: 10 });
    if (stop() || !observed || count() !== before + item.count) throw Error('earth hunt pickup settlement unobserved');
    return { id: item.id, count: item.count };
}

export async function huntFight(s: Session, npc: { id: number; index: number }, stop: () => boolean, foodEpoch: () => number) {
    const before = s.sdk.getSkillXp('Strength');
    const start = s.tick();
    let sent = start;
    let food = foodEpoch();
    let retries = 0;
    if (before == null || !Number.isFinite(before)) throw Error('earth hunt strength XP unknown');
    const revision = s.sdk.getState()?.revision ?? start;
    let engaged = false;
    let dead = false;
    const observe = () => {
        const st = s.sdk.getState();
        const combat = st?.player?.combat;
        if (combat?.inCombat && combat.targetType === 'npc' && combat.targetIndex === npc.index) engaged = true;
        if (st?.combatEvents?.some(e => (e.observationId ?? e.tick) > revision && e.type === 'damage_dealt' && e.targetType === 'npc' && e.targetIndex === npc.index)) engaged = true;
        if (st?.nearbyNpcs.some(n => n.index === npc.index && n.id === npc.id && n.hp === 0)) dead = true;
    };
    const attack = async (target: Parameters<typeof s.bot.attack>[0]) => {
        const result = await s.bot.attack(target);
        observe();
        if (stop()) throw Error('earth hunt fight stopped');
        if (s.tick() - start >= 100) throw Error('earth hunt fight credit deadline');
        if (result.success) {
            engaged = true;
            return true;
        }
        const missing = result.reason === 'npc_not_found' || (result.reason === 'timeout' && /\btarget_not_found\b/.test(result.message));
        const st = s.sdk.getState();
        if (missing && engaged) return true;
        if (missing && dead && !engaged && st && !st.nearbyNpcs.some(n => n.index === npc.index && n.id === npc.id) && s.sdk.getSkillXp('Strength') === before) return false;
        throw Error('earth hunt attack refused: ' + result.reason + '; ' + result.message);
    };
    const off = s.onTick(observe);
    try {
        observe();
        if (!await attack(npc as Parameters<typeof s.bot.attack>[0])) return 'uncredited' as const;
        while (s.tick() - start < 100) {
            if (stop()) throw Error('earth hunt fight stopped');
            const current = s.sdk.getState()?.nearbyNpcs.find(n => n.index === npc.index && n.id === npc.id && (n.hp ?? 1) > 0);
            if (!current && (s.sdk.getSkillXp('Strength') ?? 0) > before) return 'credited' as const;
            const epoch = foodEpoch();
            if (current && retries < 3 && (epoch !== food || s.tick() - sent >= 16)) {
                food = epoch;
                sent = s.tick();
                retries++;
                if (!await attack(current)) return 'uncredited' as const;
            }
            await waitTicks(s, 1);
        }
        throw Error('earth hunt fight credit deadline');
    } finally {
        off();
    }
}

type EarthLedger = { consumed: number; crafted: number; air: number; eaten: Record<number, number>; found?: Record<number, number> };

export function productionConserved(before: ReadonlyMap<number, number>, after: ReadonlyMap<number, number>, l: EarthLedger) {
    const expected = new Map(before);
    const add = (id: number, n: number) => expected.set(id, (expected.get(id) ?? 0) + n);
    add(ESSENCE, -l.consumed);
    add(EARTH, l.crafted);
    add(AIR, l.air);
    for (const [id, n] of Object.entries(l.found ?? {})) add(Number(id), n);
    for (const [id, n] of Object.entries(l.eaten)) {
        const def = questFoodDefinitions().get(Number(id));
        if (!def || !Number.isSafeInteger(n) || n < 0) return false;
        add(Number(id), -n);
        if (def.next) add(def.next, n);
    }
    return [...new Set([...expected.keys(), ...after.keys()])].every(id => (expected.get(id) ?? 0) === (after.get(id) ?? 0) && (expected.get(id) ?? 0) >= 0);
}

export async function depositEarthInventory(s: Session, check: () => void) {
    for (const id of new Set(s.sdk.getInventory().map(i => i.id))) {
        check();
        const item = s.sdk.getInventory().find(i => i.id === id);
        if (item) await depositObserved(s, item);
    }
}

function insideAirAltarDefault(p: { worldX: number; worldZ: number; level: number } | null | undefined): boolean {
    return !!p && p.level === 0 && p.worldX >= 2830 && p.worldX <= 2855 && p.worldZ >= 4820 && p.worldZ <= 4845;
}
const outsideAirAltarDefault = (p: { worldX: number; worldZ: number; level: number } | null | undefined) => !!p && p.level === 0 && p.worldX === 2983 && p.worldZ === 3288;

async function enterAirAltarDefault(s: Session) {
    if (insideAirAltarDefault(s.sdk.getState()?.player)) return;
    const ruins = s.sdk.getState()?.nearbyLocs.find(l => /mysterious ruins/i.test(l.name) && Math.max(Math.abs(l.x - 2985), Math.abs(l.z - 3292)) <= 3);
    const talisman = s.sdk.getInventory().find(i => i.id === 1438);
    if (!ruins || !talisman) throw Error('air entry requires earned air talisman1438 at ruins2985,3292');
    await s.bot.useItemOnLoc(talisman, ruins);
    if (!await waitUntil(s, () => insideAirAltarDefault(s.sdk.getState()?.player), { timeoutTicks: 20 })) throw Error('air altar entry unobserved');
}

async function craftAirRunesDefault(s: Session, stop: () => boolean = () => false) {
    if (!await waitUntil(s, () => s.sdk.getInventory().length > 0 && !!s.sdk.getSkill('Runecraft'), { timeoutTicks: 30 })) throw Error('air inventory/skills unobserved');
    if (!insideAirAltarDefault(s.sdk.getState()?.player)) throw Error('air craft requires observed inside-altar position');
    const ess = () => countItems(s, /^rune essence$/i);
    const runes = () => countItems(s, /^air rune$/i);
    const xp = () => s.sdk.getSkillXp('Runecraft') ?? 0;
    const ess0 = ess();
    const runes0 = runes();
    const xp0 = xp();
    const start = s.tick();
    for (let attempt = 0; attempt < 3 && ess() > 0 && !stop(); attempt++) {
        await s.bot.dismissBlockingUI();
        const altar = s.sdk.findNearbyLoc(/^altar$/i, { withOption: /craft/i });
        if (!altar) throw Error('air altar with craft option unobserved');
        await s.bot.interactLoc(altar, /craft/i);
        await waitUntil(s, () => stop() || ess() === 0, { timeoutTicks: 12 });
    }
    const result = { ok: !stop() && ess0 > 0 && ess() === 0 && runes() - runes0 >= ess0 && xp() > xp0, consumed: ess0 - ess(), runes: runes() - runes0, xp: xp() - xp0, ticks: s.tick() - start };
    if (!result.ok) throw Error('air craft effects unobserved ' + JSON.stringify(result));
    return result;
}

async function exitAirAltarDefault(s: Session, stop: () => boolean = () => false) {
    const check = () => {
        if (stop()) throw Error('air exit stopped');
    };
    check();
    if (!insideAirAltarDefault(s.sdk.getState()?.player)) return;
    const portal = s.sdk.findNearbyLoc(/^portal$/i, { withOption: /^use$/i });
    if (!portal || portal.id !== 2465 || portal.x !== 2841 || portal.z !== 4828 || !portal.optionsWithIndex.some(o => o.opIndex === 1 && /^use$/i.test(o.text))) {
        throw Error('air exit portal identity/option differs from pinned content');
    }
    const messages = () => s.sdk.getState()?.gameMessages ?? [];
    const cursor = () => Math.max(0, ...messages().map(m => m.observationId ?? m.tick));
    let baseline = cursor();
    const idle = () => {
        const st = s.sdk.getState();
        return st?.player?.animId === -1 && !st.dialog.isOpen && !st.interface.isOpen && !st.modalOpen;
    };
    const settleWait = async (ready: () => boolean, reason: string, quietTicks = 1, recover?: (dismissed: boolean) => Promise<boolean>) => {
        let last = '';
        let lastTick = -1;
        let stable = 0;
        let quietAt = -1;
        let dismissed = false;
        for (let observation = 0; observation < 20; observation++) {
            check();
            const st = s.sdk.getState();
            const blocked = !!(st?.dialog.isOpen || st?.interface.isOpen || st?.modalOpen);
            await s.bot.dismissBlockingUI();
            check();
            if (blocked) {
                stable = 0;
                last = '';
                quietAt = -1;
                dismissed = true;
            }
            const p = s.sdk.getState()?.player;
            const now = s.tick();
            const key = p ? `${p.level}:${p.worldX}:${p.worldZ}` : '';
            if (now !== lastTick) {
                stable = idle() && key ? (key === last ? stable + 1 : 1) : 0;
                last = stable ? key : '';
                lastTick = now;
                if (stable === 1) quietAt = now;
            }
            if (stable >= 2 && now - quietAt >= quietTicks) {
                if (ready()) return;
                if (recover && (await recover(dismissed))) {
                    stable = 0;
                    last = '';
                    quietAt = -1;
                    dismissed = false;
                }
            }
            if (!await waitUntil(s, () => stop() || s.tick() > now, { timeoutTicks: 1 })) {
                check();
                break;
            }
        }
        check();
        throw Error(reason);
    };
    await settleWait(() => insideAirAltarDefault(s.sdk.getState()?.player), 'air craft/modal did not settle', 4);
    const edges = [
        { x: 2841, z: 4829 },
        { x: 2842, z: 4828 },
        { x: 2841, z: 4827 },
        { x: 2840, z: 4828 },
    ];
    const edge = edges.find(c => {
        check();
        const path = s.sdk.findPath(c.x, c.z);
        return path.success && path.reachedDestination === true;
    });
    if (!edge) throw Error('air portal approach unavailable');
    const approachCursor = cursor();
    const approachRejected = s.sdk.getState()?.opFeedback?.opRejectedCount;
    let retried = false;
    const approach = async () => {
        check();
        const walk = await s.sdk.sendWalk(edge.x, edge.z);
        check();
        if (!walk.success) throw Error('air portal approach refused ' + JSON.stringify(walk));
    };
    await approach();
    const atEdge = () => {
        const p = s.sdk.getState()?.player;
        return p?.level === 0 && p.worldX === edge.x && p.worldZ === edge.z;
    };
    await settleWait(atEdge, 'air portal approach unobserved', 1, async dismissed => {
        const levelup = messages().some(m => (m.observationId ?? m.tick) > approachCursor && /^Congratulations, you just advanced a runecraft level\.$/i.test(m.text));
        const rejected = approachRejected !== undefined && (s.sdk.getState()?.opFeedback?.opRejectedCount ?? approachRejected) > approachRejected;
        if (retried || !dismissed || !levelup || !rejected) return false;
        const path = s.sdk.findPath(edge.x, edge.z);
        if (!path.success || path.reachedDestination !== true) throw Error('air portal recovery approach unavailable');
        retried = true;
        await approach();
        return true;
    });
    check();
    if (!atEdge() || !idle()) throw Error('air portal approach changed before dispatch');
    baseline = cursor();
    const rejected = s.sdk.getState()?.opFeedback?.opRejectedCount;
    const reply = await s.sdk.sendInteractLoc(portal.x, portal.z, portal.id, 1);
    check();
    if (!reply.success) throw Error('air portal action refused ' + JSON.stringify(reply));
    const refusal = () =>
        messages().some(m => (m.observationId ?? m.tick) > baseline && /can(?:not|'t) reach/i.test(m.text)) ||
        (rejected !== undefined && (s.sdk.getState()?.opFeedback?.opRejectedCount ?? rejected) > rejected);
    await waitUntil(s, () => stop() || outsideAirAltarDefault(s.sdk.getState()?.player) || refusal(), { timeoutTicks: 20 });
    check();
    if (outsideAirAltarDefault(s.sdk.getState()?.player)) return;
    if (refusal()) throw Error('air portal rejected after dispatch; no unchanged retry');
    throw Error('air portal exit unobserved');
}

function retainedEarthBankLocal(read: () => { items: readonly { id: number; count: number }[] } | null | undefined) {
    let confirmed: { id: number; count: number }[] = [];
    return () => {
        const live = read();
        if (live) confirmed = live.items.map(i => ({ id: i.id, count: i.count }));
        return confirmed;
    };
}

async function openEarthBankObservedLocal(s: Session) {
    const previous = s.bankObservation?.();
    if (s.sdk.getState()?.bank.isOpen && previous) return;
    const generation = previous?.generation ?? 0;
    if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 15 })) {
        throw Error('earth refill bank unobserved');
    }
}

export async function runEarthProduction(
    s: Session,
    o: { mode: 'talismans' | 'craft'; cap: number; target: number; batch?: number; reserve: number; killsPerTarget?: number; stop: () => boolean },
    deps?: ArtisanExternalDeps,
) {
    if (!['talismans', 'craft'].includes(o.mode) || ![o.cap, o.target, o.reserve, o.batch ?? 0].every(n => Number.isSafeInteger(n) && n >= 0) || o.cap < 1 || o.cap > 20000 || o.target < 1) {
        throw Error('invalid earth production bounds');
    }
    let target = o.target;
    if (o.killsPerTarget !== undefined && (!Number.isSafeInteger(o.killsPerTarget) || o.killsPerTarget < 0 || o.killsPerTarget > 3)) {
        throw Error('invalid finite hunt pilot');
    }
    const insideAir = deps?.insideAirAltar ?? insideAirAltarDefault;
    const enterAir = deps?.enterAirAltar ?? (sess => enterAirAltarDefault(sess as Session));
    const craftAir = deps?.craftAirRunes ?? ((sess, stop) => craftAirRunesDefault(sess as Session, stop));
    const exitAir = deps?.exitAirAltar ?? ((sess, stop) => exitAirAltarDefault(sess as Session, stop));
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const inv = () => s.sdk.getInventory();
    const eq = () => s.sdk.getEquipment();
    const start = s.tick();
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const banks = retainedEarthBankLocal(() => s.bankObservation?.());
    const owned = () => {
        const m = new Map<number, number>();
        for (const i of [...inv(), ...eq(), ...banks()]) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        return m;
    };
    const banked = (id: number) => banks().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    if (!await waitUntil(s, () => !!pos() && hp() > 12 && !!s.client && equipmentObserved(s.client as object), { timeoutTicks: 25 })) {
        throw Error('earth production entry life/equipment unknown');
    }
    const life = pos();
    const originalEquipment = eq().map(i => i.id);
    const style = st()?.combatStyle?.currentStyle;
    const retaliate = st()?.autoRetaliateEnabled;
    let ended = false;
    let cleanup = false;
    let foodActive = false;
    let hpMin = hp();
    let failure = '';
    let kills = 0;
    let trips = 0;
    let lastOutput = start;
    let initial: Map<number, number> | undefined;
    void s.ended.then(() => { ended = true; });
    const ledger: EarthLedger = { consumed: 0, crafted: 0, air: 0, eaten: {}, found: {} };
    const terminal = () => ended || sessionDied(life, pos()) || hp() <= 0;
    const stopped = () => o.stop() || existsSync(`.practice/stop-${s.name}`);
    const over = () => terminal() || stopped() || s.tick() - start >= o.cap + (cleanup ? 1500 : 0);
    const off = s.onTick(() => { hpMin = Math.min(hpMin, hp()); });
    const sustain = startQuestSustain(
        {
            sdk: s.sdk,
            tick: () => s.tick(),
            onTick: cb => s.onTick(cb),
            ended: s.ended,
            direct: async a => {
                const r = await s.direct(a);
                return { success: !!r && typeof r === 'object' && 'success' in r && r.success === true };
            },
        },
        {
            food: EARTH_FOOD,
            eatAt: 25,
            reserved: () => (foodActive && !st()?.bank.isOpen ? {} : Object.fromEntries(EARTH_FOOD.map(id => [id, held(id)]))),
            onConsumed: e => {
                ledger.eaten[e.id] = (ledger.eaten[e.id] ?? 0) + 1;
            },
        },
    );
    const check = () => {
        if (over() || sustain.failure() || hp() <= 6) throw Error('earth production stop/life/deadline: ' + (sustain.failure() ?? ''));
    };
    const travel = async (to: { x: number; z: number }) => {
        check();
        const ac = new AbortController();
        const guard = () => {
            if (over() || sustain.failure() || hp() <= 6) ac.abort();
        };
        const offGuard = s.onTick(guard);
        const a = accountOf(s);
        const actor = { ...a, skills: { ...a.skills, magic: 0 }, items: [], counts: {}, worn: [], coins: 0 };
        try {
            const r = await goTo(s, await getWorld(), { ...to, level: 0 }, actor, { legTimeoutTicks: 150, signal: ac.signal });
            if (!r.ok) throw Error('earth production route: ' + JSON.stringify(r));
        } finally {
            offGuard();
        }
        check();
    };
    const open = async () => {
        check();
        await s.bot.dismissBlockingUI();
        await openEarthBankObservedLocal(s);
        banks();
    };
    const deposit = async () => {
        await depositEarthInventory(s, check);
        banks();
    };
    const withdraw = async (id: number, n: number) => {
        if (!n) return;
        await open();
        const item = st()?.bank.items.find(i => i.id === id);
        const b = banked(id);
        const p = held(id);
        if (!item || b < n) throw Error('earth production missing owned ' + id);
        await s.bot.withdrawItem(item, n);
        if (!await waitUntil(s, () => over() || (held(id) === p + n && banked(id) === b - n), { timeoutTicks: 12 }) || over()) {
            throw Error('earth production withdrawal unobserved ' + id);
        }
    };
    const equip = async (id: number) => {
        if (eq().some(i => i.id === id)) return;
        const item = inv().find(i => i.id === id);
        if (!item) throw Error('earth production kit missing ' + id);
        await s.bot.equipItem(item);
        if (!await waitUntil(s, () => over() || eq().some(i => i.id === id), { timeoutTicks: 10 }) || over()) throw Error('earth production equip unobserved');
    };
    const insideEarth = () => !!pos() && pos()!.level === 0 && pos()!.worldX >= 2645 && pos()!.worldX <= 2670 && pos()!.worldZ >= 4820 && pos()!.worldZ <= 4845;
    const exitEarth = async () => {
        const p = st()?.nearbyLocs.find(l => l.id === 2468 && l.optionsWithIndex.some(o => o.opIndex === 1 && /^use$/i.test(o.text)));
        if (!p) throw Error('earth exit portal unobserved');
        const edge = [{ x: p.x, z: p.z + 1 }, { x: p.x + 1, z: p.z }, { x: p.x, z: p.z - 1 }, { x: p.x - 1, z: p.z }].find(
            t => s.sdk.findPath(t.x, t.z).reachedDestination === true,
        );
        if (!edge) throw Error('earth exit face unavailable');
        await s.bot.walkTo(edge.x, edge.z, 0, { timeout: 10000 });
        check();
        if (pos()?.worldX !== edge.x || pos()?.worldZ !== edge.z) throw Error('earth exit face unobserved');
        if (!(await s.sdk.sendInteractLoc(p.x, p.z, p.id, 1)).success || !await waitUntil(s, () => over() || !insideEarth(), { timeoutTicks: 20 }) || insideEarth()) {
            throw Error('earth exit unobserved');
        }
        check();
    };
    const enterEarth = async () => {
        await travel({ x: 3303, z: 3477 });
        await s.bot.dismissBlockingUI();
        const at = { x: 3305, z: 3473, level: 0 };
        const q = { id: 2455, shape: 10, angle: 0, width: 3, height: 3, blockAccessFlags: 0, src: 'maps/m51_54.jm2', configSrc: 'scripts/skill_runecraft/configs/runecraft.loc' };
        const loc = st()?.nearbyLocs.find(l => l.id === q.id && l.x === at.x && l.z === at.z);
        const item = inv().find(i => i.id === 1440);
        if (!loc || !item) throw Error('earth ruins/talisman unobserved');
        const face = await interactionApproach(s.sdk, at, q);
        if (!face) throw Error('earth ruins face unavailable');
        const w = await walkPath(await sessionWalker(s), [{ x: face.x, z: face.z, tol: 0 }], { maxTicks: 60, stop: over });
        check();
        if (!w.ok || pos()?.worldX !== face.x || pos()?.worldZ !== face.z) throw Error('earth ruins face unobserved');
        if (!(await s.sdk.sendUseItemOnLoc(item.slot, at.x, at.z, q.id)).success || !await waitUntil(s, () => over() || insideEarth(), { timeoutTicks: 20 }) || !insideEarth()) {
            throw Error('earth entry unobserved');
        }
        check();
    };
    try {
        const p = pos()!;
        const near = [EARTH_DRAYNOR, EARTH_WEST, EARTH_EAST].sort(
            (a, b) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ)) - Math.max(Math.abs(b.x - p.worldX), Math.abs(b.z - p.worldZ)),
        )[0]!;
        await travel(near);
        await open();
        await deposit();
        initial = owned();
        // A brain batch asks for that many new runes. Against the default stock target alone, an account that holds
        // more earth runes than the target met it at once: OreElse ended ok with crafted=0 in 39 runs in a row.
        if (o.batch) target = Math.max(o.target, (initial.get(EARTH) ?? 0) + o.batch);
        if ((initial.get(995) ?? 0) < o.reserve) throw Error('earth production reserve unavailable');
        if (o.mode === 'talismans') {
            if (!Number.isSafeInteger(style) || typeof retaliate !== 'boolean') throw Error('earth production combat controls unknown');
            if (s.sdk.getSkill('Attack')!.baseLevel < 30 || s.sdk.getSkill('Defence')!.baseLevel < 10) throw Error('earth hunt combat prerequisites');
            let slots = 0;
            for (const id of EARTH_FOOD) {
                const n = Math.min(banked(id), Math.max(0, 12 - slots));
                await withdraw(id, n);
                slots += n;
            }
            if (!slots) throw Error('earth hunt owned food required');
            await stageOwnedEquipment([1277, 1171, 1115], () => eq().map(i => i.id), withdraw, () => s.bot.closeBank(), equip);
            foodActive = true;
            if (!(await s.sdk.sendSetCombatStyle(1)).success || !await waitUntil(s, () => st()?.combatStyle?.currentStyle === 1, { timeoutTicks: 8 })) {
                throw Error('earth hunt strength style unobserved');
            }
            if (retaliate) {
                await s.direct({ type: 'clickComponent', componentId: 151, reason: 'owned talisman hunt controls' });
                if (!await waitUntil(s, () => st()?.autoRetaliateEnabled === false, { timeoutTicks: 8 })) throw Error('earth hunt auto-retaliate unobserved');
            }
            for (const id of [1440, 1438]) {
                const target = talismanTarget(id);
                if ((initial.get(id) ?? 0) > 0 && !o.killsPerTarget) continue;
                await travel(target.spot);
                lastOutput = s.tick();
                const firstKill = kills;
                while (o.killsPerTarget ? kills - firstKill < o.killsPerTarget : !held(id)) {
                    check();
                    if (kills >= 500 || s.tick() - lastOutput > 240) throw Error('earth hunt no kill progress');
                    if (hp() < 18 && !inv().some(i => EARTH_FOOD.includes(i.id))) throw Error('earth hunt food exhausted; retreat');
                    const loot = await collectHuntLoot(s, over);
                    if (loot) ledger.found![loot.id] = (ledger.found![loot.id] ?? 0) + loot.count;
                    if (held(id) && !o.killsPerTarget) break;
                    const npc = st()?.nearbyNpcs
                        .filter(
                            n =>
                                target.npcIds.includes(n.id) &&
                                !n.inCombat &&
                                (n.hp ?? 1) > 0 &&
                                n.reachable !== false &&
                                Math.max(Math.abs(n.x - target.spot.x), Math.abs(n.z - target.spot.z)) <= 18,
                        )
                        .sort((a, b) => a.distance - b.distance)[0];
                    if (!npc) {
                        await waitTicks(s, 1);
                        continue;
                    }
                    const outcome = await huntFight(s, npc, () => over() || !!sustain.failure() || hp() <= 6, () => Object.values(ledger.eaten).reduce((n, v) => n + v, 0));
                    if (outcome === 'uncredited') continue;
                    kills++;
                    lastOutput = s.tick();
                    const dropped = await collectHuntLoot(s, over, true);
                    if (dropped) ledger.found![dropped.id] = (ledger.found![dropped.id] ?? 0) + dropped.count;
                    console.log('EARTH_PRODUCTION_KILL ' + JSON.stringify({ kills, target: id, hp: hp(), tick: s.tick() }));
                }
            }
        } else {
            while ((owned().get(EARTH) ?? 0) < target) {
                check();
                const level = s.sdk.getSkill('Runecraft')?.baseLevel ?? 0;
                const xp = s.sdk.getSkillXp('Runecraft') ?? 0;
                const batch = earthProductionBatch(level, xp, target - (owned().get(EARTH) ?? 0), banked(ESSENCE));
                if (!batch.essence) throw Error('earth production essence exhausted before target');
                await withdraw(batch.talisman, 1);
                await withdraw(ESSENCE, batch.essence);
                await s.bot.closeBank();
                const before = held(batch.rune);
                const beforeXp = s.sdk.getSkillXp('Runecraft') ?? 0;
                if (batch.rune === AIR) {
                    await travel({ x: 2983, z: 3288 });
                    await enterAir(s);
                    check();
                    await craftAir(s, over);
                } else {
                    await enterEarth();
                    const altar = st()?.nearbyLocs.find(l => l.id === 2481 && l.optionsWithIndex.some(o => /craft/i.test(o.text)));
                    if (!altar) throw Error('earth craft altar unobserved');
                    await s.bot.interactLoc(altar, /craft/i);
                }
                if (!await waitUntil(s, () => over() || (held(ESSENCE) === 0 && held(batch.rune) === before + batch.essence * batch.multiple && (s.sdk.getSkillXp('Runecraft') ?? 0) > beforeXp), { timeoutTicks: 15 })) {
                    throw Error('earth craft paired effects unobserved');
                }
                check();
                if (held(ESSENCE) !== 0 || held(batch.rune) !== before + batch.essence * batch.multiple) throw Error('earth craft accounting mismatch');
                ledger.consumed += batch.essence;
                if (batch.rune === AIR) ledger.air += batch.essence * batch.multiple;
                else ledger.crafted += batch.essence * batch.multiple;
                if (batch.rune === AIR) await exitAir(s, over);
                else await exitEarth();
                trips++;
                await travel(EARTH_EAST);
                await open();
                await deposit();
                console.log(
                    'EARTH_PRODUCTION_BATCH ' +
                        JSON.stringify({ trips, ...batch, crafted: ledger.crafted, consumed: ledger.consumed, earth: banked(EARTH), level: s.sdk.getSkill('Runecraft')?.baseLevel, tick: s.tick() }),
                );
            }
        }
    } catch (e) {
        failure = String(e);
    } finally {
        cleanup = true;
        try {
            if (!terminal() && !stopped()) {
                if (insideAir(pos())) await exitAir(s, over);
                if (insideEarth()) await exitEarth();
                await travel(o.mode === 'talismans' ? EARTH_WEST : EARTH_EAST);
                await sustain.settle();
                if (sustain.failure()) throw Error(sustain.failure()!);
                for (const item of [...eq()]) {
                    if (!originalEquipment.includes(item.id)) {
                        await s.bot.unequipItem(item);
                        if (!await waitUntil(s, () => !eq().some(i => i.id === item.id), { timeoutTicks: 10 })) throw Error('earth kit unequip unobserved');
                    }
                }
                await open();
                await deposit();
                await stageOwnedEquipment(originalEquipment, () => eq().map(i => i.id), withdraw, async () => {
                    banks();
                    await s.bot.closeBank();
                }, equip);
                if (o.mode === 'talismans') {
                    if (style !== undefined && st()?.combatStyle?.currentStyle !== style) {
                        await s.sdk.sendSetCombatStyle(style);
                        if (!await waitUntil(s, () => st()?.combatStyle?.currentStyle === style, { timeoutTicks: 8 })) throw Error('earth style restore unobserved');
                    }
                    if (retaliate !== undefined && st()?.autoRetaliateEnabled !== retaliate) {
                        await s.direct({ type: 'clickComponent', componentId: retaliate ? 150 : 151, reason: 'restore earth hunt controls' });
                        if (!await waitUntil(s, () => st()?.autoRetaliateEnabled === retaliate, { timeoutTicks: 8 })) throw Error('earth auto-retaliate restore unobserved');
                    }
                }
            }
        } catch (e) {
            failure += '; cleanup ' + String(e);
        }
        await sustain.stop();
        off();
    }
    const final = owned();
    const conserved = !!initial && productionConserved(initial, final, ledger);
    const equipmentRestored = JSON.stringify(eq().map(i => i.id).sort()) === JSON.stringify(originalEquipment.sort());
    const talismansReady = banked(1438) >= 1 && banked(1440) >= 1;
    const targetMet = banked(EARTH) >= target;
    const pilotReady = !!o.killsPerTarget && kills >= 2 * o.killsPerTarget;
    const ok = !failure && !terminal() && !stopped() && conserved && equipmentRestored && (o.mode === 'talismans' ? (o.killsPerTarget ? pilotReady : talismansReady) : targetMet);
    return {
        ok,
        mode: o.mode,
        talismansReady: talismansReady ? 1 : 0,
        pilotReady: pilotReady ? 1 : 0,
        targetMet: targetMet ? 1 : 0,
        finalEarth: banked(EARTH),
        fire: banked(554),
        finalCoins: final.get(995) ?? 0,
        spentTotal: 0,
        seeded: 0,
        conserved,
        equipmentRestored,
        kills,
        trips,
        hpMin,
        hp: hp(),
        ticks: s.tick() - start,
        ...ledger,
        failure: failure || '-',
    };
}

// ---- Alchemy Training (alch-train.ts) ----

type AlchItem = { id: number; count: number };
export const NATURE = 561;
export const FIRE = 554;
export const FIRE_STAVES = [1387, 1393, 1401];
export const STRIKE = { level: 21, xp: 137, mind: 558, air: 556, npc: 99, spot: { x: 2621, z: 3327 }, spare: 8, wait: 200 } as const;
export const strikeCasts = (xp: number, target: number) =>
    xp >= xpForLevel(Math.min(STRIKE.level, target)) ? 0 : Math.ceil((xpForLevel(Math.min(STRIKE.level, target)) - xp) / STRIKE.xp);
const invCount = (items: readonly AlchItem[], id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

export function alchStagePlan(casts: { low: number; high: number; strike?: number }, carried: readonly AlchItem[], bank: readonly AlchItem[], item: number) {
    const staff = FIRE_STAVES.find(id => invCount(carried, id) > 0) ?? FIRE_STAVES.find(id => invCount(bank, id) > 0);
    const strikes = casts.strike ? casts.strike + STRIKE.spare : 0;
    const want: AlchItem[] = [
        { id: STRIKE.mind, count: strikes },
        { id: STRIKE.air, count: strikes },
        { id: NATURE, count: casts.low + casts.high },
        { id: item, count: casts.low + casts.high },
    ];
    if (staff === undefined) want.push({ id: FIRE, count: casts.low * FIRE_PER['low-alch'] + casts.high * FIRE_PER['high-alch'] });
    const take: AlchItem[] = [];
    if (staff !== undefined && invCount(carried, staff) < 1) take.push({ id: staff, count: 1 });
    for (const w of want) {
        const n = Math.min(Math.max(0, w.count - invCount(carried, w.id)), invCount(bank, w.id));
        if (n > 0) take.push({ id: w.id, count: n });
    }
    return { staff, take };
}

export function castsHeld(mode: 'low-alch' | 'high-alch', carried: readonly AlchItem[], item: number, staff: boolean) {
    return Math.min(invCount(carried, NATURE), invCount(carried, item), staff ? Infinity : Math.floor(invCount(carried, FIRE) / FIRE_PER[mode]));
}

// A stop requested while the alch run stages. runAlch reports it as stop=stopped, not as a failure.
export class AlchStopError extends Error {}

// The bank where the alch run stages. The Wind Strike phase casts at STRIKE.spot beside the Ardougne north bank, so an
// account that still needs strike casts stages there. Any other account alchs where it stands: it stages at the bank it
// stands at (an upper-floor bank too), else at the nearest ground-floor bank, because the stage walk has no floor.
export function alchStageBank(p: { worldX: number; worldZ: number; level: number }, magicXp: number, target: number) {
    if (strikeCasts(magicXp, target) > 0) return { x: COW_NORTH_BANK.x, z: COW_NORTH_BANK.z, level: 0, name: 'Ardougne north' };
    const here = nearestBank({ x: p.worldX, z: p.worldZ, level: p.level });
    const b = atBank(p, here) ? here : nearestBank({ x: p.worldX, z: p.worldZ, level: 0 });
    return { x: b.x, z: b.z, level: b.level, name: `${b.x},${b.z}` };
}

function atBank(p: { worldX: number; worldZ: number; level: number } | null | undefined, b: { x: number; z: number; level: number }) {
    return !!p && p.level === b.level && Math.max(Math.abs(p.worldX - b.x), Math.abs(p.worldZ - b.z)) <= 3;
}

export async function stageAlch(
    s: Session,
    o: { target: number; item: number; walk: (x: number, z: number) => Promise<boolean>; stop?: () => boolean },
    deps?: ArtisanExternalDeps,
) {
    const state = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const carried = () => [...inv(), ...(state()?.equipment ?? [])];
    if (!await waitUntil(s, () => !!state()?.player && s.sdk.getSkillXp('Magic') !== null, { timeoutTicks: 15 })) throw new Error('alch stage: position unknown');
    const stageBank = alchStageBank(state()!.player!, s.sdk.getSkillXp('Magic') ?? 0, o.target);
    if (!atBank(state()?.player, stageBank)) {
        if (o.stop?.()) throw new AlchStopError('alch stage: stop requested');
        const walked = await o.walk(stageBank.x, stageBank.z);
        if (o.stop?.()) throw new AlchStopError('alch stage: stop requested');
        if (!walked || !atBank(state()?.player, stageBank)) throw new Error(`alch stage: walk to the ${stageBank.name} bank failed`);
    }
    const observe = s.bankObservation?.bind(s);
    const generation = observe?.()?.generation ?? 0;
    if (!observe) throw new Error('alch stage: fresh bank observation unavailable');
    if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!state()?.bank?.isOpen && (observe()?.generation ?? 0) > generation, { timeoutTicks: 20 })) {
        throw new Error('alch stage: bank did not open');
    }
    const keep = new Set<number>([NATURE, FIRE, o.item, STRIKE.mind, STRIKE.air, ...FIRE_STAVES]);
    for (const row of [...inv()].filter(i => !keep.has(i.id))) {
        if (o.stop?.()) throw new AlchStopError('alch stage: stop requested');
        const id = row.id;
        const before = invCount(inv(), id);
        if (before < 1) continue;
        if (!(await s.bot.depositItem(row, before)).success || !await waitUntil(s, () => invCount(inv(), id) === 0, { timeoutTicks: 10 })) {
            throw new Error(`alch stage: deposit ${id} failed`);
        }
    }
    const magicXp = s.sdk.getSkillXp('Magic') ?? 0;
    const plan = alchStagePlan({ ...alchCasts(magicXp, o.target), strike: strikeCasts(magicXp, o.target) }, carried(), observe()?.items ?? [], o.item);
    for (const want of plan.take) {
        if (o.stop?.()) throw new AlchStopError('alch stage: stop requested');
        const row = (state()?.bank?.items ?? []).find(i => i.id === want.id);
        const before = invCount(inv(), want.id);
        if (!row || !(await s.bot.withdrawItem(row, want.count, { asNote: false })).success || !await waitUntil(s, () => invCount(inv(), want.id) >= before + want.count, { timeoutTicks: 10 })) {
            throw new Error(`alch stage: withdraw ${want.count}x${want.id} failed`);
        }
    }
    if (deps?.reconcileLoadout) {
        await deps.reconcileLoadout(s, {
            style: 'magic',
            trainSkill: 'magic',
            bankOpen: true,
            leaveBankOpen: true,
            runeIds: [FIRE],
            pin: plan.staff !== undefined ? { weapon: plan.staff } : {},
            stop: o.stop,
            label: 'alch stage',
        });
    }
    await s.bot.closeBank();
    if (!await waitUntil(s, () => !state()?.bank?.isOpen, { timeoutTicks: 10 })) throw new Error('alch stage: bank did not close');
    await waitTicks(s, 1);
    if (!deps?.reconcileLoadout && plan.staff !== undefined && !(state()?.equipment ?? []).some(i => FIRE_STAVES.includes(i.id))) {
        const heldStaff = inv().find(i => i.id === plan.staff);
        if (heldStaff && typeof s.bot.equipItem === 'function') {
            await s.bot.equipItem(heldStaff);
            await waitUntil(s, () => (state()?.equipment ?? []).some(i => FIRE_STAVES.includes(i.id)), { timeoutTicks: 8 });
        }
    }
    const worn = () => (state()?.equipment ?? []).some(i => FIRE_STAVES.includes(i.id));
    if (plan.staff !== undefined && !worn()) throw new Error('alch stage: fire staff not wielded');
    return { took: plan.take, staff: worn() };
}

export async function strikeStart(s: Session, o: { target: number; cap: number; stop?: () => boolean }) {
    const state = () => s.sdk.getState();
    const level = () => s.sdk.getSkill('Magic')?.baseLevel ?? 0;
    const xp = () => s.sdk.getSkillXp('Magic') ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const held = (id: number) => invCount(s.sdk.getInventory(), id);
    const at = (x: number, z: number) => {
        const p = state()?.player;
        return !!p && p.level === 0 && p.worldX === x && p.worldZ === z;
    };
    const start = s.tick();
    const hp0 = hp();
    const component = componentId('magic:wind_strike');
    let casts = 0;
    let landed = s.tick();
    let stop = '';
    const walker = await sessionWalker(s);
    const toSpot = async () => at(STRIKE.spot.x, STRIKE.spot.z) || ((await walkPath(walker, [{ ...STRIKE.spot, tol: 0 }], { maxTicks: 60 })).ok && at(STRIKE.spot.x, STRIKE.spot.z));
    if (held(STRIKE.mind) < 1 || held(STRIKE.air) < 1) return { casts, stop: 'supplies' };
    if (!await toSpot()) throw new Error('alch: strike tile 2621,3327 not reached');
    try {
        while (level() < o.target) {
            if (s.tick() - start >= o.cap) {
                stop = 'cap';
                break;
            }
            if (o.stop?.()) {
                stop = 'stopped';
                break;
            }
            if (hp() < hp0) throw new Error(`alch: lost Hitpoints at the strike tile (${hp()} of ${hp0})`);
            if (held(STRIKE.mind) < 1 || held(STRIKE.air) < 1) {
                stop = 'supplies';
                break;
            }
            if (s.tick() - landed >= STRIKE.wait) throw new Error(`no alch progress: no Wind Strike landed in ${STRIKE.wait} ticks (one player at a time can fight the dog)`);
            if (!await toSpot()) throw new Error('alch: strike tile 2621,3327 lost');
            await s.bot.dismissBlockingUI();
            const dog = (state()?.nearbyNpcs ?? [])
                .filter(n => n.id === STRIKE.npc && n.reachable === false && n.distance <= 8)
                .sort((a, b) => a.distance - b.distance)[0];
            if (!dog) {
                if ((s.tick() - landed) % 30 < 3) {
                    console.log(
                        `STRIKE_WAIT ${JSON.stringify(
                            (state()?.nearbyNpcs ?? [])
                                .filter(n => n.id === STRIKE.npc)
                                .map(n => ({ at: [n.tileX ?? n.x, n.tileZ ?? n.z], distance: n.distance, reachable: n.reachable, hp: n.hp })),
                        )}`,
                    );
                }
                await waitTicks(s, 3);
                continue;
            }
            const before = xp();
            await s.direct({ type: 'spellOnNpc', npcIndex: dog.index, spellComponent: component, reason: 'alch strike start' });
            if (await waitUntil(s, () => xp() > before, { timeoutTicks: 8 })) {
                casts++;
                landed = s.tick();
            }
            await waitTicks(s, 3);
        }
    } finally {
        await walkPath(walker, [{ x: COW_NORTH_BANK.x, z: COW_NORTH_BANK.z, tol: 2 }], { maxTicks: 80 });
        for (let n = 0; n < 5 && state()?.dialog?.isOpen; n++) {
            await s.bot.dismissBlockingUI();
            await waitTicks(s, 2);
        }
    }
    if (!atNorthBank(state()?.player)) throw new Error('alch: walk back to the bank from the strike tile failed');
    for (let n = 0, last = ''; n < 10; n++) {
        const p = state()?.player;
        const here = `${p?.worldX},${p?.worldZ}`;
        await waitTicks(s, 2);
        const q = state()?.player;
        if (here === `${q?.worldX},${q?.worldZ}` && here === last) break;
        last = here;
    }
    return { casts, stop };
}

export async function runAlch(
    s: Session,
    o: { target: number; cap: number; item: string; stop?: () => boolean; walk: (x: number, z: number) => Promise<boolean> },
    deps?: ArtisanExternalDeps,
) {
    if (!Number.isSafeInteger(o.target) || o.target < 2 || o.target > 99 || !Number.isSafeInteger(o.cap) || o.cap < 1 || o.cap > 100000) {
        throw new Error('alch: invalid target or cap');
    }
    const item = itemMagicRecipe('high-alch', o.item).target;
    const start = s.tick();
    const level = () => s.sdk.getSkill('Magic')?.baseLevel ?? 0;
    const xp = () => s.sdk.getSkillXp('Magic') ?? 0;
    const casts = { 'low-alch': 0, 'high-alch': 0, strike: 0 };
    let stop = 'target';
    let failure = '';
    let startLevel: number | undefined;
    let startXp: number | undefined;
    try {
        const staged = await stageAlch(s, { target: o.target, item, walk: o.walk, stop: o.stop }, deps);
        console.log(`ALCH_STAGE ${JSON.stringify(staged)}`);
        startLevel = level();
        startXp = xp();
        if (level() < Math.min(STRIKE.level, o.target)) {
            const r = await strikeStart(s, { target: Math.min(STRIKE.level, o.target), cap: o.cap - (s.tick() - start), stop: o.stop });
            casts.strike = r.casts;
            if (r.stop) stop = r.stop;
        }
        while (stop === 'target' && level() < o.target) {
            const mode = level() < HIGH_LEVEL ? 'low-alch' : 'high-alch';
            const left = o.cap - (s.tick() - start);
            if (left < 1) {
                stop = 'cap';
                break;
            }
            if (o.stop?.()) {
                stop = 'stopped';
                break;
            }
            const carried = [...s.sdk.getInventory(), ...(s.sdk.getState()?.equipment ?? [])];
            const need = alchCasts(xp(), o.target);
            const n = Math.min(mode === 'low-alch' ? need.low : need.high, castsHeld(mode, carried, item, staged.staff));
            if (n < 1) {
                stop = 'supplies';
                break;
            }
            const r = await runItemMagic(s, itemMagicRecipe(mode, o.item), { count: n, cap: left, stop: o.stop });
            casts[mode] += r.casts;
            if (!r.ok) {
                stop = r.stop;
                break;
            }
            await waitUntil(s, () => !!s.sdk.getState()?.dialog?.isOpen, { timeoutTicks: 2 });
            for (let k = 0; k < 5 && s.sdk.getState()?.dialog?.isOpen; k++) {
                await s.bot.dismissBlockingUI();
                await waitTicks(s, 2);
            }
            if (s.sdk.getState()?.dialog?.isOpen) throw new Error('alch: level-up dialog stayed open');
        }
    } catch (e) {
        if (e instanceof AlchStopError) stop = 'stopped';
        else {
            failure = e instanceof Error ? e.message : String(e);
            stop = 'failure';
        }
    }
    if (!failure && stop === 'supplies' && casts['low-alch'] + casts['high-alch'] + casts.strike === 0) {
        failure = 'no alch progress: the bank holds no supplies for one cast';
    }
    const gained = startLevel === undefined ? 0 : level() - startLevel;
    const met = level() >= o.target;
    return {
        ok: met || (!failure && stop === 'supplies' && gained > 0),
        stop: met ? 'target' : stop,
        failure,
        level: level(),
        gained,
        magicXp: startXp === undefined ? 0 : xp() - startXp,
        casts,
        ticks: s.tick() - start,
    };
}

export const alchResultLine = (r: Awaited<ReturnType<typeof runAlch>>) =>
    `alch level=${r.level} gained=${r.gained} xp=${r.magicXp} strike=${r.casts.strike} low=${r.casts['low-alch']} high=${r.casts['high-alch']} stop=${r.stop} ticks=${r.ticks}${r.failure ? ` failure=${r.failure}` : ''}`;

// ---- Unified Magic CLI Router ----

export async function runMagicCli(
    method: string,
    botName: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
    deps?: ArtisanExternalDeps,
) {
    if (method === 'items') {
        let s: Session | undefined;
        let stopped = false;
        try {
            const [mode, target, count, cap] = restArgs;
            if (!botName || !mode) throw Error('account and mode required');
            const recipe = itemMagicRecipe(mode, target);
            s = await openBot(botName, { onStop: async () => { stopped = true; } });
            const result = await runItemMagicBanked(s, recipe, {
                count: Number(count ?? 1),
                cap: Number(cap ?? 200),
                members: env.MEMBERS === '1',
                stop: () => stopped || existsSync('.practice/stop-microbot-magic'),
            });
            console.log('ITEM_MAGIC_RESULT ' + JSON.stringify(result));
            await finish([s], result.ok, JSON.stringify(result));
        } catch (e) {
            await finish(s ? [s] : [], false, String(e));
        }
        return;
    }
    if (method === 'teleport') {
        let s: Session | undefined;
        let stopped = false;
        try {
            const [name, casts, cap] = restArgs;
            if (!botName || !name) throw Error('account and native destination required');
            const t = nativeTeleport(name);
            const combo = env.COMBO_ALCH ? itemMagicRecipe(env.COMBO_ALCH, env.ALCH_ITEM) : undefined;
            s = await openBot(botName, { onStop: async () => { stopped = true; } });
            await stageTeleportRunes(s, t, Number(casts ?? 1), env.MEMBERS === '1', () => magicStopRequested(botName, stopped));
            const r = await runTeleportMagic(s, t, {
                casts: Number(casts ?? 1),
                cap: Number(cap ?? 1200),
                members: env.MEMBERS === '1',
                combo,
                stop: () => magicStopRequested(botName, stopped),
            });
            console.log('TELEPORT_MAGIC_RESULT ' + JSON.stringify(r));
            await finish([s], r.ok, JSON.stringify(r));
        } catch (e) {
            await finish(s ? [s] : [], false, String(e));
        }
        return;
    }
    if (method === 'trip') {
        const path = restArgs[0];
        if (!botName || !path) throw Error('usage: microbot-magic-trip.ts account job.json');
        const job = JSON.parse(readFileSync(path, 'utf8')) as MagicBankJob;
        validateMagicBankJob(job, deps);
        let stopped = false;
        const s = await openBot(botName, { onStop: async () => { stopped = true; } });
        try {
            const result = await runMagicBankTrips(s, job, () => magicStopRequested(botName, stopped), deps);
            await finish([s], result.ok, JSON.stringify(result));
        } catch (e) {
            await finish([s], false, String(e));
        }
        return;
    }
    if (method === 'orbs' || method === 'orbs-at-site') {
        const orbTripFlag = method === 'orbs' ? env.ORB_TRIP === '1' : false;
        const kind = restArgs[0] as OrbKind;
        const maximum = Number(restArgs[1] ?? 1);
        const cap = Number(restArgs[2] ?? (orbTripFlag ? 6000 : 80));
        if (!botName || !Object.hasOwn(orbRecipes, kind) || !Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(cap) || cap < 1) {
            throw Error('Usage (members world): bun scripts/aio-skiller.ts <account> artisan magic orbs <air|water|earth|fire> [quantity] [ticks]');
        }
        let stopped = false;
        process.once('SIGINT', () => { stopped = true; });
        process.once('SIGTERM', () => { stopped = true; });
        const stop = () => orbStopRequested(botName, stopped);
        const s = await openBot(botName);
        let ok = false;
        try {
            const result = orbTripFlag
                ? await runOrbTrips(
                      s,
                      kind,
                      orbRecipes[kind],
                      chargeInventory,
                      { target: maximum, batch: Number(env.ORB_BATCH ?? 1), cap, stop, ...orbOptions(env) },
                      deps,
                  )
                : await chargeInventory(s, kind, maximum, cap, stop);
            console.log('ORB_RESULT ' + JSON.stringify(result));
            ok = result.ok;
        } finally {
            ok = await settle([s], ok, 'finite orb order');
        }
        process.exitCode = ok ? 0 : 1;
        return;
    }
    if (method === 'bones') {
        const maximum = Number(env.MAX_MAKE ?? 25);
        const cap = Number(env.CAP ?? 500);
        if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(cap) || cap < 1) {
            throw Error('invalid bones conversion limits');
        }
        let stopped = false;
        const s = await openBot(botName, { onStop: async () => { stopped = true; } });
        try {
            const r = await runBonesBank(s, { maximum, cap, members: env.MEMBERS === '1', stop: () => stopped });
            await finish([s], r.ok, JSON.stringify(r));
        } catch (e) {
            await finish([s], false, String(e));
        }
        return;
    }
    if (method === 'earth-production') {
        let stopped = false;
        const s = await openBot(botName, { onStop: async () => { stopped = true; } });
        try {
            const r = await runEarthProduction(
                s,
                {
                    mode: restArgs[0] as 'talismans' | 'craft',
                    cap: Number(restArgs[1] ?? 4000),
                    target: Number(env.STOCK_TARGET ?? 100),
                    ...(env.STOCK_TARGET ? {} : { batch: Number(env.BATCH_UNITS ?? 0) }),
                    reserve: Number(env.COIN_RESERVE ?? 0),
                    killsPerTarget: Number(env.HUNT_KILLS_PER_TARGET ?? 0),
                    stop: () => stopped,
                },
                deps,
            );
            console.log('EARTH_PRODUCTION ' + JSON.stringify(r));
            process.exitCode = (await settle(
                [s],
                r.ok,
                Object.entries(r)
                    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
                    .join(' '),
            ))
                ? 0
                : 1;
        } catch (e) {
            await settle([s], false, String(e));
            process.exitCode = 1;
        }
        return;
    }
    if (method === 'alch-train') {
        let s: Session | undefined;
        let stopped = false;
        try {
            const [target, cap] = restArgs;
            if (!botName || !target) throw new Error('usage: alch-train <account> <TARGET_LEVEL> [CAP]');
            s = await openBot(botName, { onStop: async () => { stopped = true; } });
            const session = s;
            const r = await runAlch(
                s,
                {
                    target: Number(target),
                    cap: Number(cap ?? 5000),
                    item: env.ALCH_ITEM ?? 'feather',
                    stop: () => stopped,
                    walk: async (x, z) =>
                        deps?.walkTargetPersist
                            ? (await deps.walkTargetPersist(session, { x, z, level: 0 })).ok
                            : (await walkPath(await sessionWalker(session), [{ x, z, tol: 2 }])).ok,
                },
                deps,
            );
            console.log(`ALCH_RESULT ${JSON.stringify(r)}`);
            await finish([s], r.ok, alchResultLine(r));
        } catch (e) {
            await finish(s ? [s] : [], false, String(e));
        }
        return;
    }
    throw Error(`unsupported artisan magic method: ${method}`);
}
