import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import { MarketClient } from '../../../../vendor/rs-sdk/sdk/market';
import type { NearbyNpc } from '../../../../vendor/rs-sdk/sdk/types';
import { validateBankRouteJob, type BankProfile, type BankRouteJob } from '../../../core/src/bank-trip';
import { finish, openBot, releasePrayerGuard, sessionDied, settle } from '../../../core/src/bot';
import { equipmentObserved } from '../../../core/src/container-observation';
import { objId } from '../../../core/src/content-facts';
import { depositObserved } from '../../../core/src/deposit';
import { withDoorPolicy } from '../../../core/src/door-policy';
import type { Session } from '../../../core/src/inprocess';
import { componentId } from '../../../core/src/logout';
import { lootListed, lootMatches, lootNameMatches, validLootFilters, type LootPolicy } from '../../../core/src/loot-policy';
import { questFlags } from '../../../core/src/quest-status';
import { holdSessionEater } from '../../../core/src/sustain';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { applyKnownDoorBlocks, expandPath, sessionWalker, walkPath, type PathDeps, type PathPoint, type PathTile } from '../../../core/src/walk';
import { selectFireWeapon } from './gear';
import { equipCowKit, guardCowWalker } from './melee-gather';
import {
    combatPrayerLoss,
    createPotionCareSession,
    drinkOrbEnergy,
    ORB_ENERGY,
    potionCareRecipe,
    runCombatBankProfile,
    runVisibleGroundLoot,
    type LootQuoteSnapshot,
} from './survivability';
import { withdrawFireOwned } from './trip-kit';
import type { CombatSession } from './types';

// Shared Waterfall dialogue helper (keeps combat workers free of scripts/ imports)
async function waterfallDialogue(s: Session, opts: { proof: RegExp; choices?: RegExp[]; maxTicks: number; stop?: () => boolean }) {
    let proofSeen = false;
    const trace: unknown[] = [];
    let last = '';
    const observe = () => {
        const d: any = s.sdk.getDialog();
        const text = d?.isOpen ? [d.text ?? '', ...(d.allComponents ?? []).map((c: any) => c.text ?? '')].join(' ') : '';
        if (opts.proof.test(text)) proofSeen = true;
        const page = {
            tick: s.tick(),
            pageId: d?.pageId,
            open: !!d?.isOpen,
            waiting: !!d?.isWaiting,
            text,
            options: d?.options ?? [],
        };
        const key = JSON.stringify({ ...page, tick: 0 });
        if (key !== last) {
            trace.push(page);
            last = key;
        }
    };
    const off = s.onTick(observe);
    try {
        for (let tick = 0; tick < opts.maxTicks; tick++) {
            const d: any = s.sdk.getDialog();
            observe();
            if (opts.stop?.()) return { ok: false, proofSeen, reason: 'stopped', trace };
            if (proofSeen && !d?.isOpen && !d?.isWaiting) return { ok: true, proofSeen, reason: 'proved', trace };
            if (d?.isOpen && !d.isWaiting) {
                const options: any[] = d.options ?? [];
                const choices = options.filter(
                    o => o.buttonType === 1 || (!/^\s*(click here to )?continue\s*$/i.test(o.text ?? '') && o.buttonType !== 6),
                );
                const selected = choices.find(o => opts.choices?.some(re => re.test(o.text ?? '')));
                if (choices.length && !selected) return { ok: false, proofSeen, reason: 'unexpected choice', trace };
                const index = selected?.index ?? options.find(o => o.buttonType === 6)?.index ?? 0;
                const reply = await s.sdk.sendClickDialog(index);
                trace.push({ tick: s.tick(), index, reply });
            }
            await waitTicks(s, 1);
        }
        return { ok: false, proofSeen, reason: 'mandatory progress not observed', trace };
    } finally {
        off();
    }
}

// Guardian swamp helpers (used for Mort Myre ghast rot detection)
export function guardianSwampPoint(p: { x: number; z: number; level: number }) {
    return p.level === 0 && p.x >= 3392 && p.x <= 3519 && p.z >= 3328 && p.z <= 3455;
}

export function guardianFoodRotEffect(
    before: readonly { id: number; count: number }[],
    after: readonly { id: number; count: number }[],
    w: { freshSystem: boolean; nativeGhast: boolean; sameHpXpGear: boolean; sameLifeOwner: boolean; pairedAntidote?: boolean },
) {
    if (!w.freshSystem || !w.nativeGhast || !w.sameHpXpGear || !w.sameLifeOwner) return false;
    const sums = (rows: readonly { id: number; count: number }[]) => {
        const v: Record<number, number> = {};
        for (const r of rows) v[r.id] = (v[r.id] ?? 0) + r.count;
        return v;
    };
    const b = sums(before);
    const a = sums(after);
    return [...new Set([...Object.keys(b), ...Object.keys(a)])].every(
        k => (a[+k] ?? 0) - (b[+k] ?? 0) === (+k === 379 ? -1 : +k === 2959 ? 1 : w.pairedAntidote && +k === 2448 ? -1 : w.pairedAntidote && +k === 181 ? 1 : 0),
    );
}

// Pack equality helper used by energy upkeep
export function orbPackEffect(before: Record<number, number>, after: Record<number, number>, delta: Record<number, number>) {
    return [...new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(delta)])].every(
        k => (after[Number(k)] ?? 0) - (before[Number(k)] ?? 0) === (delta[Number(k)] ?? 0),
    );
}

// ============================================================================
// Owned kit loader (self-contained for shade trips, injectable via deps.loadout)
// ============================================================================
const ROOT = resolve(import.meta.dir, '../../../..');
const CONTENT_DIR = resolve(ROOT, 'vendor/rs-sdk/server/content') + '/';

type KitCount = { id: number; count: number };
type KitWorn = KitCount & { slot: number };
export type CombatOwnedKit = { bank: { x: number; z: number; level: number }; pack: KitCount[]; wear: KitWorn[]; cap: number; maximumMoves: number };

const wholeInt = (n: unknown, min = 0, max = 2147483647) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const canonicalKit = (a: readonly KitCount[]) =>
    Object.entries(a.reduce((m, i) => ((m[i.id] = (m[i.id] ?? 0) + i.count), m), {} as Record<number, number>))
        .map(([id, count]) => ({ id: Number(id), count }))
        .sort((a, b) => a.id - b.id);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const wornView = (a: readonly KitWorn[]) => a.map(i => ({ id: i.id, count: i.count, slot: i.slot })).sort((a, b) => a.slot - b.slot);
const kitItemCache = new Map<number, ReturnType<typeof readNativeCombatKitItem>>();

function nativeCombatKitItem(id: number) {
    const cached = kitItemCache.get(id);
    if (cached) return cached;
    const item = readNativeCombatKitItem(id);
    kitItemCache.set(id, item);
    return item;
}

function readNativeCombatKitItem(id: number) {
    const items = JSON.parse(readFileSync(resolve(ROOT, 'knowledge/items.json'), 'utf8')) as {
        id: number;
        name: string;
        debugname: string;
        src: string;
        members: boolean;
    }[];
    const packed = readFileSync(CONTENT_DIR + 'pack/obj.pack', 'utf8')
        .split(/\r?\n/)
        .find(l => l.startsWith(id + '='))
        ?.split('=')[1];
    const noted = !!packed?.startsWith('cert_');
    const item = items.find(i => (noted ? i.debugname === packed!.slice(5) : i.id === id));
    if (!item || !wholeInt(id)) throw Error('unknown native kit item ' + id);
    const block = readFileSync(CONTENT_DIR + item.src.replace(/:\d+$/, ''), 'utf8')
        .split('[' + item.debugname + ']')[1]
        ?.split('\n[')[0];
    if (!block) throw Error('native item definition absent ' + id);
    const fields = (key: string) => block.match(new RegExp('^' + key + '=([^\\r\\n]+)', 'm'))?.[1];
    const slots: Record<string, number> = {
        hat: 0,
        back: 1,
        front: 2,
        righthand: 3,
        torso: 4,
        lefthand: 5,
        arms: 6,
        legs: 7,
        head: 8,
        hands: 9,
        feet: 10,
        jaw: 11,
        ring: 12,
        quiver: 13,
    };
    const slot = fields('wearpos');
    const extra = [fields('wearpos2'), fields('wearpos3')].filter((x): x is string => !!x);
    const styles = readFileSync(CONTENT_DIR + 'scripts/skill_combat/scripts/player/player_attackstyles.rs2', 'utf8');
    const category = fields('category');
    const tab =
        [...styles.matchAll(/case ([\w, ]+) : ~weapon_category_tab_attack\((combat_\w+):preview/g)].find(m =>
            m[1]!.split(/,\s*/).includes(category ?? ''),
        )?.[2] ?? 'combat_unarmed';
    const styleIndices = [...styles.matchAll(new RegExp('\\[if_button,' + tab + ':[^\\]]+\\] ~set_attackstyle\\((\\d+)\\);', 'g'))].map(m =>
        Number(m[1]),
    );
    return {
        ...item,
        id,
        baseId: item.id,
        stackable: noted || fields('stackable') === 'yes',
        slot: noted || slot === undefined ? undefined : slots[slot],
        occupies: [slot, ...extra].filter((x): x is string => !!x).map(x => slots[x]),
        noted,
        styleIndices,
        styleTab: componentId(tab),
    };
}

export function validateCombatOwnedKit(value: unknown): CombatOwnedKit {
    const j = value as CombatOwnedKit;
    if (
        !j
        || typeof j !== 'object'
        || !j.bank
        || ![j.bank.x, j.bank.z, j.bank.level].every(n => wholeInt(n))
        || j.bank.x > 16383
        || j.bank.z > 16383
        || j.bank.level > 3
        || !Array.isArray(j.pack)
        || !Array.isArray(j.wear)
        || j.pack.length > 28
        || j.wear.length > 14
        || !wholeInt(j.cap, 120, 2000)
        || !wholeInt(j.maximumMoves, 64, 256)
    ) {
        throw Error('invalid finite owned kit');
    }
    if (new Set(j.pack.map(i => i.id)).size !== j.pack.length || new Set(j.wear.map(i => i.slot)).size !== j.wear.length) {
        throw Error('duplicate kit item or worn slot');
    }
    for (const row of [...j.pack, ...j.wear]) {
        if (!row || !wholeInt(row.id) || !wholeInt(row.count, 1)) throw Error('invalid kit quantity');
    }
    const occupied = new Set<number>();
    for (const row of j.wear) {
        const item = nativeCombatKitItem(row.id);
        if (!wholeInt(row.slot, 0, 13) || item.slot !== row.slot || item.noted || (!item.stackable && row.count !== 1)) {
            throw Error('native worn slot/count mismatch ' + row.id);
        }
        for (const slot of item.occupies) {
            if (slot === undefined || occupied.has(slot)) throw Error('conflicting native worn slots/two-handed shield');
            occupied.add(slot);
        }
    }
    for (const row of j.pack) nativeCombatKitItem(row.id);
    return j;
}

export async function runCombatOwnedLoadout(s: CombatSession, value: unknown, requestStop: () => boolean = () => false) {
    const sess = s as Session;
    const j = validateCombatOwnedKit(value);
    const start = s.tick();
    const state = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const gear = () => s.sdk.getEquipment();
    const first = state()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const hp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const client = s.client as any;
    const executor = client.executeBotAction;
    const xpView = () => state()?.skills.map(i => ({ name: i.name, experience: i.experience, baseLevel: i.baseLevel }));
    const xp = JSON.stringify(xpView());
    const controls = () => ({
        retaliate: state()?.autoRetaliateEnabled,
        prayers: state()?.prayers?.activePrayers,
        style: state()?.combatStyle?.currentStyle,
    });
    const initialControls = JSON.parse(JSON.stringify(controls()));
    const initialWear = wornView(gear());
    let ended = false;
    let moves = 0;
    let uncertain = false;
    let baseline: KitCount[] | undefined;
    let bankGeneration = -1;
    let changed = false;
    let failure = '';
    let recovered = false;
    let noOp = false;
    let initialNote: boolean | undefined;
    let bankModeRestored = false;
    void s.ended?.then(() => {
        ended = true;
    });
    const held = (id: number) => inv().filter(i => i.id === id).reduce((a, i) => a + i.count, 0);
    const stored = (id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((a, i) => a + i.count, 0);
    const here = () => {
        const p = state()?.player;
        return !!p && p.level === j.bank.level && Math.max(Math.abs(p.worldX - j.bank.x), Math.abs(p.worldZ - j.bank.z)) <= 3;
    };
    const fatal = () =>
        ended
        || !first
        || !state()?.player
        || state()!.player!.isDead
        || state()!.player!.lifeId !== life
        || (state()!.player!.respawnCount ?? 0) !== respawns
        || !here()
        || (s.sdk.getSkill('Hitpoints')?.level ?? 0) !== hp
        || hp < 1
        || s.sdk.getStateAge() > 5000
        || client.executeBotAction !== executor
        || !equipmentObserved(client)
        || JSON.stringify(xpView()) !== xp;
    const guard = (cleanup = false) => {
        const stopRequested =
            requestStop()
            || existsSync('.practice/stop-all')
            || (!!s.name && existsSync(`.practice/stop-${s.name}`))
            || (!!process.env.STOP_FILE && existsSync(process.env.STOP_FILE));
        if (
            fatal()
            || s.tick() - start >= j.cap
            || moves >= j.maximumMoves
            || (!cleanup && (stopRequested || s.tick() - start >= j.cap - 40 || moves >= j.maximumMoves - 32))
        ) {
            throw Error('owned loadout life/state/stop/budget');
        }
    };
    const assets = () => {
        const bank = s.bankObservation?.();
        if (!state()?.bank.isOpen || !bank) throw Error('owned loadout fresh bank observation absent');
        return canonicalKit(
            [...inv(), ...gear(), ...bank.items].map(i => ({
                id: client.objType(i.id)?.certtemplate >= 0 ? client.objType(i.id).certlink : i.id,
                count: i.count,
            })),
        );
    };
    const conserved = () => !!baseline && sameJson(assets(), baseline);
    const close = async (cleanup = false) => {
        guard(cleanup);
        bankGeneration = Math.max(bankGeneration, s.bankObservation?.()?.generation ?? -1);
        await s.sdk.sendCloseModal();
        if (!(await waitUntil(s, () => !state()?.bank.isOpen, { timeoutTicks: 8 }))) throw Error('owned loadout bank close unobserved');
        guard(cleanup);
    };
    const open = async (cleanup = false) => {
        guard(cleanup);
        if (state()?.bank.isOpen) await close(cleanup);
        const result = await s.bot.openBank();
        if (
            !(await waitUntil(
                s,
                () => {
                    if (fatal()) throw Error('owned loadout lost original session');
                    return !!state()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > bankGeneration;
                },
                { timeoutTicks: 12 },
            ))
            || !state()?.bank.isOpen
            || !s.bankObservation?.()
        ) {
            throw Error('owned loadout fresh bank generation unavailable ' + result.success);
        }
        bankGeneration = s.bankObservation!()!.generation;
        guard(cleanup);
    };
    const move = async (action: () => Promise<unknown>, effect: () => boolean, cleanup = false) => {
        guard(cleanup);
        moves++;
        uncertain = true;
        changed = true;
        const at = s.tick();
        let error: unknown;
        try {
            await action();
        } catch (e) {
            error = e;
        }
        const remaining = 10 - (s.tick() - at);
        if (!effect() && remaining > 0) {
            await waitUntil(
                s,
                () => {
                    if (fatal()) throw Error('owned loadout original life/input owner lost');
                    return effect();
                },
                { timeoutTicks: remaining },
            );
        }
        if (!effect()) throw Error('owned loadout asset action unknown; no retry ' + String(error ?? ''));
        uncertain = false;
    };
    const deposit = async (cleanup = false) => {
        for (const id of new Set(inv().map(i => i.id))) {
            guard(cleanup);
            const row = inv().find(i => i.id === id)!;
            await move(() => depositObserved(sess, row), () => held(id) === 0 && conserved(), cleanup);
        }
    };
    const withdraw = async (id: number, n: number, cleanup = false) => {
        guard(cleanup);
        const item = nativeCombatKitItem(id);
        const base = item.baseId;
        const before = held(id);
        const old = stored(base);
        const generation = s.bankObservation!()!.generation;
        await move(
            async () => {
                if (!item.noted) return withdrawFireOwned(s, id, n);
                const row = state()?.bank.items.find(i => i.id === base);
                if (!row || stored(base) !== row.count || row.count < n) throw Error('owned noted bank stock unknown');
                await s.bot.withdrawItem(row, n, { asNote: true });
            },
            () => held(id) === before + n && stored(base) === old - n && (s.bankObservation?.()?.generation ?? -1) > generation && conserved(),
            cleanup,
        );
    };
    const removeAll = async (cleanup = false) => {
        if (state()?.bank.isOpen) await close(cleanup);
        for (const row of [...gear()]) {
            const before = held(row.id);
            const old = canonicalKit([...inv(), ...gear()]);
            await move(
                () => s.bot.unequipItem(row),
                () => !gear().some(i => i.slot === row.slot) && held(row.id) === before + row.count && sameJson(canonicalKit([...inv(), ...gear()]), old),
                cleanup,
            );
        }
        await open(cleanup);
        await deposit(cleanup);
    };
    const equip = async (row: KitWorn, cleanup = false) => {
        await withdraw(row.id, row.count, cleanup);
        await close(cleanup);
        const item = inv().find(i => i.id === row.id)!;
        const before = held(row.id);
        const old = canonicalKit([...inv(), ...gear()]);
        await move(
            () => s.bot.equipItem(item),
            () =>
                gear().some(i => i.slot === row.slot && i.id === row.id && i.count === row.count)
                && held(row.id) === before - row.count
                && sameJson(canonicalKit([...inv(), ...gear()]), old),
            cleanup,
        );
        await open(cleanup);
        if (!conserved()) throw Error('owned loadout equip bank conservation failed');
    };
    const restoreStyle = async (cleanup = false) => {
        guard(cleanup);
        const expected = initialControls.style;
        const style = () => state()?.combatStyle;
        const weapon = gear().find(i => i.slot === 3);
        const tab = weapon ? nativeCombatKitItem(weapon.id).styleTab : componentId('combat_unarmed');
        const ready = () => {
            const observed = style();
            return observed?.known === true && observed.tabInterfaceId === tab && observed.styles.some(i => i.index === expected);
        };
        if (!(await waitUntil(s, () => fatal() || ready(), { timeoutTicks: 8 })) || fatal() || !ready()) {
            throw Error('owned loadout target native combat style unavailable');
        }
        if (style()?.currentStyle === expected) return;
        await close(cleanup);
        await s.sdk.sendSetCombatStyle(expected);
        if (!(await waitUntil(s, () => fatal() || (ready() && style()?.currentStyle === expected), { timeoutTicks: 8 })) || fatal() || !ready() || style()?.currentStyle !== expected) {
            throw Error('owned loadout original combat style restore unconfirmed');
        }
        await open(cleanup);
    };
    try {
        guard();
        if (!first || !Number.isSafeInteger(life) || !equipmentObserved(client) || state()?.combatStyle?.known !== true || initialControls.retaliate === undefined) {
            throw Error('owned loadout initial controls/gear unknown');
        }
        await open();
        baseline = assets();
        initialNote = state()?.bank.noteMode;
        if (typeof initialNote !== 'boolean') throw Error('owned loadout bank note control unknown');
        for (const row of [...j.pack, ...j.wear]) {
            const item = nativeCombatKitItem(row.id);
            const native = client.objType(row.id);
            if (item.noted && (!native || !Number.isSafeInteger(native.certtemplate) || native.certtemplate < 0 || native.certlink !== item.baseId)) {
                throw Error('native noted identity mismatch');
            }
        }
        const need = canonicalKit([...j.pack, ...j.wear].map(i => ({ id: nativeCombatKitItem(i.id).baseId, count: i.count })));
        if (need.some(i => (baseline!.find(x => x.id === i.id)?.count ?? 0) < i.count)) {
            throw Error('owned loadout stock missing before withdrawals');
        }
        const slots = j.pack.reduce((n, i) => {
            const t = client.objType(i.id);
            if (typeof t?.stackable !== 'boolean') throw Error('native stackability unknown');
            return n + (t.stackable ? 1 : i.count);
        }, 0);
        if (slots > 28) throw Error('owned loadout exact pack exceeds28 slots');
        if ([...j.pack, ...j.wear].some(i => nativeCombatKitItem(i.id).members && client.membersAccount !== 1)) {
            throw Error('owned loadout member item requires observed member account');
        }
        const targetWeapon = j.wear.find(i => i.slot === 3);
        const targetStyles = targetWeapon ? nativeCombatKitItem(targetWeapon.id).styleIndices : [0, 1, 2];
        if (!targetStyles.includes(initialControls.style)) {
            throw Error('owned loadout original style incompatible with target native weapon table');
        }
        noOp = sameJson(canonicalKit(inv()), canonicalKit(j.pack)) && sameJson(wornView(gear()), wornView(j.wear));
        if (!noOp) {
            await deposit();
            await removeAll();
            for (const row of j.wear) await equip(row);
            await restoreStyle();
            for (const row of j.pack) await withdraw(row.id, row.count);
        }
        guard();
        if (!sameJson(canonicalKit(inv()), canonicalKit(j.pack)) || !sameJson(wornView(gear()), wornView(j.wear)) || !conserved() || !sameJson(controls(), initialControls)) {
            throw Error('owned loadout exact final kit/assets/controls unconfirmed');
        }
    } catch (error) {
        failure = String(error);
        if (changed && !uncertain && !fatal()) {
            try {
                await open(true);
                await deposit(true);
                await removeAll(true);
                if (initialControls.style > 2) {
                    const originalWeapon = initialWear.find(i => i.slot === 3);
                    if (!originalWeapon) throw Error('original weapon needed for control recovery');
                    await equip(originalWeapon, true);
                }
                await restoreStyle(true);
                recovered = conserved() && inv().length === 0;
            } catch (e) {
                failure += '; recovery ' + String(e);
            }
        }
    }
    try {
        if (initialNote !== undefined && !fatal() && state()?.bank.isOpen) {
            if (state()!.bank.noteMode !== initialNote) {
                guard(true);
                await s.sdk.sendClickComponent(initialNote ? 5386 : 5387);
                if (!(await waitUntil(s, () => fatal() || state()?.bank.noteMode === initialNote, { timeoutTicks: 8 })) || fatal()) {
                    throw Error('owned loadout original bank note mode unconfirmed');
                }
            }
            bankModeRestored = state()!.bank.noteMode === initialNote;
        }
    } catch (e) {
        failure ||= String(e);
    }
    let balanced = false;
    try {
        if (state()?.bank.isOpen && s.bankObservation?.() && baseline) balanced = conserved();
    } catch {}
    const exactPack = sameJson(canonicalKit(inv()), canonicalKit(j.pack));
    const exactWear = sameJson(wornView(gear()), wornView(j.wear));
    const controlsPreserved = sameJson(controls(), initialControls);
    try {
        if (!fatal() && state()?.bank.isOpen) await close(true);
    } catch (e) {
        failure ||= String(e);
    }
    return {
        ok: !failure && !uncertain && balanced && exactPack && exactWear && controlsPreserved && bankModeRestored,
        failure,
        exactPack,
        exactWear,
        balanced,
        controlsPreserved,
        bankModeRestored,
        noOp,
        recovered,
        recoveryDeferred: uncertain,
        moves,
        ticks: s.tick() - start,
        scope: 'one declared owned exact bank kit, including native notes; no travel or acquisition',
    };
}

// ============================================================================
// 1. Waterfall Fire Giants: Glarial amulet reclaim + bounded giant kill
// ============================================================================
const FIRE_BANK = { x: 2619, z: 3332 };
const FIRE_FOOD = 329;
const FIRE_PEBBLE = 294;
const FIRE_AMULET = 295;
const FIRE_BONES = 532;

export function fireHomeEntryPoints(p: { x: number; z: number; level: number }): PathPoint[] {
    if (p.level !== 0) throw new Error('Fire reclaim entry requires a known surface bank');
    if (Math.max(Math.abs(p.x - FIRE_BANK.x), Math.abs(p.z - FIRE_BANK.z)) <= 3) return [];
    if (Math.max(Math.abs(p.x - 2655), Math.abs(p.z - 3283)) <= 3) return [{ x: 2644, z: 3293, tol: 0 }, { ...FIRE_BANK, tol: 0 }];
    throw new Error('Fire reclaim entry requires actual Ardy South or North bank');
}

export function reclaimAssetsValid(before: ReadonlyMap<number, number>, after: ReadonlyMap<number, number>, eaten: number) {
    return (
        Number.isSafeInteger(eaten)
        && eaten >= 0
        && [...new Set([...before.keys(), ...after.keys(), FIRE_AMULET])].every(
            id => (after.get(id) ?? 0) === (before.get(id) ?? 0) + (id === FIRE_AMULET ? 1 : 0) - (id === FIRE_FOOD ? eaten : 0),
        )
    );
}

export function reclaimInputs(items: readonly { id: number; count: number }[]) {
    const n = (id: number) => items.filter(i => i.id === id).reduce((a, i) => a + i.count, 0);
    return n(FIRE_PEBBLE) >= 1 && n(FIRE_FOOD) >= 16 && n(FIRE_AMULET) === 0;
}

export async function runFireReclaim(s: CombatSession, o: { cap: number; stop?: () => boolean }) {
    const sess = s as Session;
    const eatHold = holdSessionEater(s.sdk);
    const start = s.tick();
    const state = () => s.sdk.getState();
    const pos = () => state()?.player;
    const inv = () => s.sdk.getInventory();
    const eq = () => s.sdk.getEquipment();
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const n = (a: readonly { id: number; count: number }[], id: number) => a.filter(i => i.id === id).reduce((v, i) => v + i.count, 0);
    const held = (id: number) => n(inv(), id);
    const p0 = pos();
    if (!p0 || p0.level !== 0 || hp() < 60) {
        eatHold.release();
        throw new Error('no fire access progress: require mature Mighty surface HP>=60');
    }
    const originalHeld = inv().map(i => ({ id: i.id, count: i.count }));
    const originalWorn = eq().map(i => ({ id: i.id, count: i.count, slot: i.slot }));
    let ended = false;
    let died = false;
    let eaten = 0;
    let hpMin = hp();
    let failure = '';
    let banked = false;
    let amuletObserved = false;
    let kitRestored = false;
    let initial: Map<number, number> | undefined;
    let eating: Promise<void> | undefined;
    let foodFailure = '';
    void s.ended.then(() => {
        ended = true;
    });
    const over = () => ended || died || !!o.stop?.() || s.tick() - start >= o.cap;
    const totals = () => {
        const m = new Map<number, number>();
        for (const i of [...inv(), ...eq(), ...(s.bankObservation?.()?.items ?? [])]) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        return m;
    };
    const eat = async () => {
        const item = inv().find(i => i.id === FIRE_FOOD);
        const before = held(FIRE_FOOD);
        const h = hp();
        if (!item) throw new Error('no fire access progress: owned Salmon exhausted');
        await s.bot.eatFood(item);
        await waitUntil(s, () => (held(FIRE_FOOD) < before && hp() > h) || died || ended, { timeoutTicks: 6 });
        eaten += Math.max(0, before - held(FIRE_FOOD));
        if (held(FIRE_FOOD) !== before - 1 || hp() <= h) throw new Error('no fire access progress: Salmon debit/heal unobserved');
    };
    const off = s.onTick(() => {
        const p = pos();
        if (hp() > 0) hpMin = Math.min(hpMin, hp());
        if (sessionDied(p0, p)) died = true;
        if (hp() > 0 && hp() <= 40 && !eating && !ended && !died && held(FIRE_FOOD) > 0) {
            eating = eat()
                .catch(e => {
                    foodFailure = String(e);
                })
                .finally(() => {
                    eating = undefined;
                });
        }
    });
    const guard = async () => {
        if (eating) await eating;
        if (over() || foodFailure || hp() <= 20) {
            throw new Error(`no fire access progress: ${foodFailure || (died ? 'died' : over() ? 'stop/cap/session-ended' : 'unsafe HP')}`);
        }
    };
    const walk = async (x: number, z: number, tol = 1, entry?: PathPoint[]) => {
        await guard();
        const base = await sessionWalker(sess);
        const p = pos()!;
        const bearRoute = p.worldZ < 4000 && z < 4000 && (p.worldZ < 3390 || z < 3390);
        const plans: { level: number; from: { x: number; z: number }; to: { x: number; z: number }; corners: { x: number; z: number }[] }[] = [];
        const traced = {
            ...base,
            plan: (level: number, from: { x: number; z: number }, to: { x: number; z: number }) => {
                const corners = base.plan(level, from, to);
                plans.push({ level, from: { ...from }, to: { ...to }, corners: corners.map(c => ({ ...c })) });
                if (plans.length > 16) plans.shift();
                return corners;
            },
        };
        let deps = traced;
        let why: () => string | null = () => null;
        const points = entry ?? [{ x, z, tol }];
        if (bearRoute) {
            const g = guardCowWalker(traced, () => (over() || hp() <= 20 ? 'fire access stop/HP' : null));
            deps = g.deps;
            why = g.reason;
        }
        const r = await walkPath(deps, points, {
            maxTicks: Math.min(250, Math.max(1, o.cap - (s.tick() - start))),
            look: 4,
            stop: () => over() || hp() <= 20 || !!foodFailure,
        });
        if (!r.ok || why()) {
            console.log('FIRE_ROUTE_REFUSED ' + JSON.stringify({ from: [p.worldX, p.worldZ, p.level], points, reason: why() ?? r.detail, plans }));
            throw new Error(`no fire access progress: walk ${why() ?? r.detail}`);
        }
        await guard();
    };
    const open = async () => {
        await s.bot.dismissBlockingUI();
        const gen = s.bankObservation?.()?.generation ?? 0;
        if (!state()?.bank.isOpen) {
            if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!state()?.bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen, { timeoutTicks: 15 }))) {
                throw new Error('no fire access progress: fresh bank unavailable');
            }
        }
        if (!s.bankObservation?.()) throw new Error('no fire access progress: bank unknown');
    };
    const deposit = async () => {
        await open();
        for (const id of new Set(inv().map(i => i.id))) {
            const item = inv().find(i => i.id === id);
            if (!item) continue;
            const before = n(s.bankObservation!()!.items, id);
            const amount = held(id);
            if (
                !(await s.bot.depositItem(item, -1)).success
                || !(await waitUntil(s, () => held(id) === 0 && n(s.bankObservation!()!.items, id) === before + amount, { timeoutTicks: 10 }))
            ) {
                throw new Error(`no fire access progress: deposit mismatch ${id}`);
            }
        }
    };
    const withdraw = async (id: number, amount: number) => {
        await open();
        await withdrawFireOwned(s, id, amount);
    };
    const close = async () => {
        await s.bot.closeBank();
        if (!(await waitUntil(s, () => !state()?.bank.isOpen, { timeoutTicks: 5 }))) throw new Error('no fire access progress: bank close');
    };
    const prayer = () => state()?.prayers?.prayerPoints ?? 0;
    const setPrayer = async (active: boolean) => {
        await s.bot.dismissBlockingUI();
        if (state()?.prayers?.activePrayers[14] !== active) {
            await s.direct({ type: 'togglePrayer', prayerIndex: 14, reason: 'Fire access protection' });
        }
        if (!(await waitUntil(s, () => state()?.prayers?.activePrayers[14] === active, { timeoutTicks: 8 }))) {
            throw new Error('no fire access progress: protection unobserved');
        }
    };
    const loc = (id: number, x: number, z: number) => state()?.nearbyLocs.find(l => l.id === id && l.x === x && l.z === z);
    const op = async (l: { id: number; x: number; z: number }, re: RegExp) => {
        const current = loc(l.id, l.x, l.z);
        const option = current?.optionsWithIndex.find(o => re.test(o.text));
        if (!current || !option) throw new Error(`no fire access progress: observed loc/op missing ${l.id}`);
        await s.sdk.sendInteractLoc(l.x, l.z, l.id, option.opIndex);
    };
    const inTomb = () => !!pos() && pos()!.worldZ >= 9795 && pos()!.worldZ <= 9850 && pos()!.worldX >= 2520 && pos()!.worldX <= 2560;
    const leaveTomb = async () => {
        if (!inTomb()) return;
        await walk(2556, 9844, 1);
        const ladder = state()?.nearbyLocs.find(
            l => /ladder/i.test(l.name) && Math.max(Math.abs(l.x - 2556), Math.abs(l.z - 9844)) <= 2 && l.optionsWithIndex.some(o => /climb.up/i.test(o.text)),
        );
        if (!ladder) throw new Error('no fire access progress: tomb exit ladder absent');
        await op(ladder, /climb.up/i);
        if (!(await waitUntil(s, () => !!pos() && pos()!.worldZ < 4000, { timeoutTicks: 20 }))) throw new Error('no fire access progress: tomb exit unobserved');
    };
    const rawQuest = (s.client as { var?: number[] } | undefined)?.var?.[65];
    const questEvidence = {
        rawClient65: Number.isFinite(rawQuest) ? rawQuest : null,
        packetVerified: false,
        historicalCompleted: true,
        note: 'SDK has no quest varps; raw client slot can be default/untransmitted. Historical Waterfall milestones10 is the completion hypothesis, not fresh client proof.',
    };
    console.log('FIRE_ACCESS_INITIAL ' + JSON.stringify({ pos: p0, hp: hp(), originalHeld, originalWorn, questEvidence }));
    try {
        const entry = fireHomeEntryPoints({ x: p0.worldX, z: p0.worldZ, level: p0.level });
        console.log('FIRE_HOME_ENTRY ' + JSON.stringify({ home: FIRE_BANK, points: entry }));
        if (entry.length) await walk(FIRE_BANK.x, FIRE_BANK.z, 0, entry);
        await open();
        initial = totals();
        if (!reclaimInputs([...inv(), ...eq(), ...s.bankObservation!()!.items])) {
            throw new Error('no fire access progress: need OWN pebble+16Salmon and missing amulet');
        }
        await deposit();
        await close();
        for (const item of [...eq()]) {
            await s.bot.unequipItem(item);
            if (!(await waitUntil(s, () => !eq().some(i => i.id === item.id), { timeoutTicks: 8 }))) {
                throw new Error('no fire access progress: worn gear not removed');
            }
        }
        await deposit();
        await withdraw(FIRE_PEBBLE, 1);
        await withdraw(FIRE_FOOD, 16);
        await close();
        if (state()?.autoRetaliateEnabled === true) await s.direct({ type: 'clickComponent', componentId: 151, reason: 'Fire access auto-retaliate OFF' });
        if (!(await waitUntil(s, () => state()?.autoRetaliateEnabled === false, { timeoutTicks: 8 }))) {
            throw new Error('no fire access progress: auto-retaliate OFF absent');
        }
        await walk(2617, 3309, 1);
        const altar = state()?.nearbyLocs.find(l => l.id === 409 && Math.max(Math.abs(l.x - 2617), Math.abs(l.z - 3309)) <= 1);
        if (!altar) throw new Error('no fire access progress: altar409 absent');
        await op(altar, /pray/i);
        if (!(await waitUntil(s, () => prayer() >= (s.sdk.getSkill('Prayer')?.baseLevel ?? 43), { timeoutTicks: 10 }))) {
            throw new Error('no fire access progress: altar recharge unobserved');
        }
        await walk(2558, 3444, 1);
        await setPrayer(true);
        const pebble = inv().find(i => i.id === FIRE_PEBBLE);
        if (!pebble) throw new Error('owned pebble vanished');
        await s.sdk.sendUseItemOnLoc(pebble.slot, 2558, 3444, 1992);
        if (!(await waitUntil(s, () => inTomb() || died, { timeoutTicks: 20 })) || !inTomb()) {
            throw new Error('no fire access progress: pebble/tomb entry unobserved');
        }
        if (prayer() < 15) throw new Error('no fire access progress: Prayer reserve before chest');
        await walk(2530, 9845, 1);
        if (loc(1994, 2530, 9844)) {
            await op({ id: 1994, x: 2530, z: 9844 }, /^open$/i);
            if (!(await waitUntil(s, () => !!loc(1995, 2530, 9844), { timeoutTicks: 15 }))) throw new Error('no fire access progress: chest open absent');
        }
        await op({ id: 1995, x: 2530, z: 9844 }, /^search$/i);
        amuletObserved = await waitUntil(s, () => held(FIRE_AMULET) === 1, { timeoutTicks: 15 });
        if (!amuletObserved) throw new Error('no fire access progress: reclaimed amulet unobserved');
        console.log(`FIRE_ACCESS_AMULET tick=${s.tick() - start} id=295 actual=1 prayer=${prayer()}`);
    } catch (e) {
        failure = String(e);
    } finally {
        if (!ended && !died && !o.stop?.()) {
            try {
                await leaveTomb();
                await setPrayer(false);
                await walk(FIRE_BANK.x, FIRE_BANK.z, 1);
                await deposit();
                for (const item of originalWorn) await withdraw(item.id, item.count);
                await close();
                for (const item of originalWorn) {
                    const actual = inv().find(i => i.id === item.id);
                    if (!actual) throw new Error('restore worn item absent');
                    await s.bot.equipItem(actual);
                    if (!(await waitUntil(s, () => eq().some(i => i.slot === item.slot && i.id === item.id), { timeoutTicks: 8 }))) {
                        throw new Error('restore worn kit unobserved');
                    }
                }
                await open();
                for (const id of new Set(originalHeld.map(i => i.id))) await withdraw(id, n(originalHeld, id));
                kitRestored =
                    originalWorn.every(w => eq().some(i => i.id === w.id && i.slot === w.slot))
                    && [...new Set([...originalHeld.map(i => i.id), ...inv().map(i => i.id)])].every(id => held(id) === n(originalHeld, id));
                banked = n(s.bankObservation!()!.items, FIRE_AMULET) === (initial?.get(FIRE_AMULET) ?? 0) + 1;
            } catch (e) {
                failure = [failure, String(e)].filter(Boolean).join('; ');
            }
        }
        if (eating) await eating;
        off();
        eatHold.release();
    }
    const preserved = !!initial && reclaimAssetsValid(initial, totals(), eaten);
    const ok = !failure && !ended && !died && amuletObserved && banked && kitRestored && preserved;
    return {
        ok,
        phase: 'reclaim',
        amuletObserved,
        banked,
        kitRestored,
        preserved,
        eaten,
        foodId: FIRE_FOOD,
        hpMin,
        finalHp: hp(),
        died,
        ended,
        questEvidence,
        ticks: s.tick() - start,
        failure: failure || '-',
    };
}

export async function runFireReclaimCli(args: readonly string[], env: Record<string, string | undefined> = process.env) {
    const name = args[0];
    if (!name) throw new Error('Fire access actor required');
    if ((env.FIRE_MODE ?? 'reclaim') !== 'reclaim') throw new Error('Fire combat phase not admitted: reclaim native gate first');
    let stopped = false;
    const s = await openBot(name, {
        onStop: async () => {
            stopped = true;
        },
    }).catch(e => finish([], false, `login ${String(e)}`));
    try {
        const r = await runFireReclaim(s, { cap: Number(env.CAP ?? 1000), stop: () => stopped });
        console.log('FIRE_ACCESS_BANK ' + JSON.stringify(r));
        await finish([s], r.ok, `fire-access ${JSON.stringify(r)}`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

export function fireStartRoute(p: { worldX: number; worldZ: number; level: number } | null | undefined) {
    if (!p || p.level !== 0) throw Error('no Fire progress: known Waterfall or surface start required');
    if (Math.max(Math.abs(p.worldX - FIRE_BANK.x), Math.abs(p.worldZ - FIRE_BANK.z)) <= 4) return 'bank';
    try {
        fireHomeEntryPoints({ x: p.worldX, z: p.worldZ, level: p.level });
        return 'bank';
    } catch {}
    if (p.worldX >= 2560 && p.worldX <= 2590 && p.worldZ >= 9860 && p.worldZ <= 9899) return 'dungeon';
    if (p.worldZ < 4000) return 'surface';
    throw Error('no Fire progress: known Waterfall or surface start required');
}

export const fireMaxHit = Math.floor(((65 + 9) * (31 + 64) + 320) / 640);
export const fireFightSafe = (hp: number, food: number, ticks: number) => hp > 30 && food >= 8 && ticks < 250;

export function fireWalkOptions(worldZ: number): Pick<PathPoint extends never ? never : { look?: number; maxTicks?: number }, 'look' | 'maxTicks'> {
    return worldZ < 4000 ? {} : { look: 4, maxTicks: 180 };
}

export const FIRE_ROOM_ENTRY = { x: 2564, z: 9882, tol: 0 };
export const fireDeathCredit = (ownXp: number, witness: boolean, bones: number) => ownXp >= 11100 && witness && bones === 1;

export function fireTargetInRoom(n: Pick<NearbyNpc, 'tileX' | 'tileZ'>): boolean {
    const x = n.tileX;
    const z = n.tileZ;
    return typeof x === 'number' && typeof z === 'number' && Number.isInteger(x) && Number.isInteger(z) && x >= 2560 && x <= 2582 && z >= 9882 && z <= 9899;
}

export function selectFireTarget(npcs: readonly NearbyNpc[], selfSlot: number) {
    if (!Number.isSafeInteger(selfSlot) || selfSlot < 0) return;
    const own = 32768 + selfSlot;
    const spiders = npcs.filter(n => n.id === 58 && (n.tileZ ?? n.z) >= 9882);
    return npcs
        .filter(
            n =>
                n.id === 110
                && n.reachable !== false
                && (!n.inCombat || n.targetIndex === own)
                && spiders.every(a => Math.max(Math.abs((a.tileX ?? a.x) - ((n.tileX ?? n.x) - 1)), Math.abs((a.tileZ ?? a.z) - (n.tileZ ?? n.z))) > 2)
                && (n.hp === null || n.maxHp === null || n.hp >= n.maxHp)
                && fireTargetInRoom(n),
        )
        .sort((a, b) => Number(b.inCombat && b.targetIndex === own) - Number(a.inCombat && a.targetIndex === own) || a.distance - b.distance)[0];
}

export async function sealFireRoom(s: CombatSession, stop: () => boolean) {
    const state = () => s.sdk.getState();
    const p = state()?.player;
    if (!p || p.level !== 0 || p.worldX < 2560 || p.worldX > 2582 || p.worldZ < 9882 || p.worldZ > 9899) {
        throw Error('no Fire progress: room entry unobserved');
    }
    const closed = () => state()?.nearbyLocs.some(l => [1516, 1519].includes(l.id) && l.z === 9881 && l.x >= 2563 && l.x <= 2565) ?? false;
    const door = state()?.nearbyLocs.find(l => [1517, 1520].includes(l.id) && Math.abs(l.z - 9881) <= 1 && l.x >= 2562 && l.x <= 2566);
    if (!closed()) {
        const option = door?.optionsWithIndex.find(o => /^close$/i.test(o.text));
        if (
            stop()
            || !door
            || !option
            || !(await s.sdk.sendInteractLoc(door.x, door.z, door.id, option.opIndex)).success
            || !(await waitUntil(s, () => closed() || stop(), { timeoutTicks: 12 }))
            || stop()
            || !closed()
        ) {
            throw Error('no Fire progress: closed room door unobserved');
        }
    }
    const here = state()?.player;
    if (
        !here
        || state()?.nearbyNpcs.some(
            n => n.id === 58 && (n.tileZ ?? n.z) >= 9882 && Math.max(Math.abs((n.tileX ?? n.x) - here.worldX), Math.abs((n.tileZ ?? n.z) - here.worldZ)) <= 2,
        )
    ) {
        throw Error('no Fire progress: spider at Fire entry');
    }
}

export async function runFireCombat(s: CombatSession, o: { cap: number; stop?: () => boolean; recoverOnly?: boolean }) {
    const sess = s as Session;
    const eatHold = holdSessionEater(s.sdk);
    const start = s.tick();
    const st = () => s.sdk.getState();
    const p = () => st()?.player;
    const inv = () => s.sdk.getInventory();
    const eq = () => s.sdk.getEquipment();
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const xp = () => s.sdk.getSkillXp('Attack') ?? 0;
    const points = () => st()?.prayers?.prayerPoints ?? 0;
    const n = (a: readonly { id: number; count: number }[], id: number) => a.filter(i => i.id === id).reduce((v, i) => v + i.count, 0);
    const held = (id: number) => n(inv(), id);
    const p0 = p();
    let ended = false;
    let died = false;
    let hpMin = hp();
    let eaten = 0;
    let eating: Promise<void> | undefined;
    let healFailure = '';
    let failure = '';
    let creditedKills = 0;
    let banked = false;
    let weapon = 0;
    let baseline: Map<number, number> | undefined;
    let phase = 'prepare';
    let fightTicks = 0;
    let entryPrayer = 0;
    let initialPrayer = points();
    let recharged = false;
    let death: { x: number; z: number; hp0: boolean; anim: boolean } | undefined;
    let targetIndex: number | undefined;
    let startRoute: string;
    try {
        startRoute = fireStartRoute(p0);
        if (!p0) throw Error('no Fire progress: position unknown');
    } catch (e) {
        eatHold.release();
        throw e;
    }
    let returnStart: number | undefined;
    let recoveryEaten = 0;
    const loot: Record<number, number> = {};
    const trace: unknown[] = [];
    const attack0 = xp();
    const life = p0.lifeId;
    const respawns = p0.respawnCount ?? 0;
    void s.ended.then(() => {
        ended = true;
    });
    const over = () => ended || died || !!o.stop?.() || (returnStart === undefined ? s.tick() - start >= o.cap : s.tick() - returnStart >= 600);
    const capture = (event: string) => {
        const q = p();
        trace.push({
            event,
            tick: s.tick() - start,
            phase,
            pos: q ? [q.worldX, q.worldZ, q.level] : null,
            hp: hp(),
            food: held(FIRE_FOOD),
            prayer: points(),
            runEnergy: q?.runEnergy ?? null,
            spiders: st()
                ?.nearbyNpcs.filter(npc => npc.id === 58 && npc.distance <= 15)
                .map(npc => ({ index: npc.index, x: npc.tileX ?? npc.x, z: npc.tileZ ?? npc.z, distance: npc.distance, inCombat: npc.inCombat })),
            target: targetIndex,
            targetPosition: (() => {
                const npc = st()?.nearbyNpcs.find(row => row.index === targetIndex && row.id === 110);
                return npc ? { render: [npc.x, npc.z], route: [npc.tileX ?? null, npc.tileZ ?? null], size: npc.size ?? null } : null;
            })(),
        });
        if (trace.length > 80) trace.splice(1, 1);
    };
    const totals = () => {
        const m = new Map<number, number>();
        for (const i of [...inv(), ...eq(), ...(s.bankObservation?.()?.items ?? [])]) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        return m;
    };
    const eat = async () => {
        const item = inv().find(i => i.id === FIRE_FOOD);
        const before = held(FIRE_FOOD);
        const h = hp();
        if (!item || before <= 8) throw new Error('food retreat reserve reached');
        await s.bot.eatFood(item);
        await waitUntil(s, () => (held(FIRE_FOOD) < before && hp() > h) || died || ended, { timeoutTicks: 6 });
        eaten += Math.max(0, before - held(FIRE_FOOD));
        if (held(FIRE_FOOD) !== before - 1 || hp() <= h) throw new Error('actual Salmon debit/heal not observed');
        capture('eat');
        await waitTicks(s, 3);
    };
    const off = s.onTick(() => {
        const q = p();
        if (hp() > 0) hpMin = Math.min(hpMin, hp());
        if (sessionDied({ lifeId: life, respawnCount: respawns }, q)) died = true;
        if (targetIndex !== undefined) {
            const npc = st()?.nearbyNpcs.find(row => row.id === 110 && row.index === targetIndex);
            if (npc && (npc.hp === 0 || npc.animId === 131)) death = { x: npc.tileX ?? npc.x, z: npc.tileZ ?? npc.z, hp0: npc.hp === 0, anim: npc.animId === 131 };
        }
        if (phase !== 'prepare' && phase !== 'bank' && hp() > 0 && hp() <= 40 && held(FIRE_FOOD) > 8 && !eating && !over()) {
            eating = eat()
                .catch(e => {
                    healFailure = String(e);
                })
                .finally(() => {
                    eating = undefined;
                });
        }
        if (s.tick() % 5 === 0 && phase === 'dungeon') capture('entry-observation');
    });
    const guard = async () => {
        if (eating) await eating;
        if (over() || hp() <= 30 || healFailure) throw new Error(`no Fire progress: ${healFailure || 'HP/stop/cap/life guard'}`);
    };
    const walk = async (x: number, z: number, tol = 1, cleanup = false) => {
        if (!cleanup) await guard();
        const q = p();
        if (!q) throw new Error('no Fire progress: walk position unknown');
        const r = await walkPath(await sessionWalker(sess), [{ x, z, tol }], {
            ...fireWalkOptions(q.worldZ),
            stop: () => over() || (!cleanup && (hp() <= 30 || !!healFailure)),
        });
        if (!r.ok) throw new Error(`no Fire progress: route ${r.detail}`);
    };
    const open = async () => {
        await s.bot.dismissBlockingUI();
        const gen = s.bankObservation?.()?.generation ?? 0;
        if (!st()?.bank.isOpen) {
            if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!st()?.bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen, { timeoutTicks: 15 }))) {
                throw new Error('fresh bank unavailable');
            }
        }
        if (!s.bankObservation?.()) throw new Error('bank unknown');
    };
    const deposit = async () => {
        await open();
        for (const id of new Set(inv().map(i => i.id))) {
            const item = inv().find(i => i.id === id);
            if (!item) continue;
            const before = n(s.bankObservation!()!.items, id);
            const amount = held(id);
            if (
                !(await s.bot.depositItem(item, -1)).success
                || !(await waitUntil(s, () => held(id) === 0 && n(s.bankObservation!()!.items, id) === before + amount, { timeoutTicks: 10 }))
            ) {
                throw new Error(`deposit mismatch ${id}`);
            }
        }
    };
    const withdraw = async (id: number, amount: number) => {
        await open();
        await withdrawFireOwned(s, id, amount);
    };
    const close = async () => {
        await s.bot.closeBank();
        await waitUntil(s, () => !st()?.bank.isOpen, { timeoutTicks: 5 });
    };
    const prayer = async (active: boolean) => {
        if (active && points() <= 0) return;
        if (st()?.prayers?.activePrayers[14] !== active) await s.direct({ type: 'togglePrayer', prayerIndex: 14, reason: 'one Fire pilot protection' });
        if (!(await waitUntil(s, () => st()?.prayers?.activePrayers[14] === active, { timeoutTicks: 8 }))) throw new Error('Prayer effect unknown');
    };
    const loc = (id: number, x: number, z: number) => st()?.nearbyLocs.find(l => l.id === id && l.x === x && l.z === z);
    const op = async (id: number, x: number, z: number, re = /./) => {
        const l = loc(id, x, z);
        const option = l?.optionsWithIndex.find(o => re.test(o.text));
        if (!l || !option) throw new Error(`observed loc/op absent ${id}`);
        return s.sdk.sendInteractLoc(x, z, id, option.opIndex);
    };
    const step = async (label: string, act: () => Promise<unknown>, arrived: () => boolean, ticks = 20) => {
        for (let i = 0; i < 2; i++) {
            await guard();
            if (arrived()) return;
            await act();
            if ((await waitUntil(s, () => arrived() || over(), { timeoutTicks: ticks })) && arrived()) return;
            await waitTicks(s, 1);
        }
        throw new Error(`no Fire progress: ${label} effect absent`);
    };
    const near = (x: number, z: number, r = 2) => !!p() && Math.max(Math.abs(p()!.worldX - x), Math.abs(p()!.worldZ - z)) <= r;
    const useRope = async (id: number, x: number, z: number) => {
        const rope = inv().find(i => i.id === 954);
        if (!rope) throw new Error('owned rope absent');
        return s.sdk.sendUseItemOnLoc(rope.slot, x, z, id);
    };
    const returnBank = async () => {
        phase = 'return';
        returnStart ??= s.tick();
        const q = p();
        if (q && q.worldZ > 9800 && q.worldZ < 9950) {
            const door = st()?.nearbyLocs.find(l => [1516, 1519].includes(l.id) && l.z === 9881);
            if (door) {
                await walk(2564, 9882, 1, true);
                await op(door.id, door.x, door.z, /open/i);
                await waitTicks(s, 1);
            }
            await walk(2564, 9880, 1, true);
            await walk(2584, 9876, 1, true);
            await walk(2575, 9863, 1, true);
            await op(2000, 2575, 9861);
            if (!(await waitUntil(s, () => near(2511, 3463, 3), { timeoutTicks: 20 }))) throw new Error('falls exit not observed');
        }
        if (near(2511, 3463, 5)) {
            await s.direct({ type: 'interactLoc', x: 2512, z: 3463, locId: 2022, optionIndex: 1, reason: 'barrel return' } as any);
            if (!(await waitUntil(s, () => near(2527, 3413, 4), { timeoutTicks: 25 }))) throw new Error('barrel return not observed');
        }
        if (p() && p()!.worldZ < 4000) {
            await prayer(false);
            await walk(FIRE_BANK.x, FIRE_BANK.z, 1, true);
            if (eating) await eating;
            phase = 'bank';
            await deposit();
            banked = true;
        } else {
            throw new Error('not on safe surface return');
        }
    };
    try {
        if (startRoute !== 'bank' || o.recoverOnly) {
            if (hp() <= 30 || held(FIRE_FOOD) < 9) throw Error('no Fire progress: recovered start needs HP>30 and9Salmon');
            capture('start-recovery');
            await returnBank();
            if (o.recoverOnly) {
                return { ok: banked && !died && !ended && !healFailure, recoveryOnly: true, banked, eaten, hpMin, finalHp: hp(), died, ticks: s.tick() - start, failure: healFailure || '-', trace };
            }
            recoveryEaten = eaten;
            eaten = 0;
            returnStart = undefined;
            banked = false;
            phase = 'prepare';
        }
        await open();
        baseline = totals();
        const foodFrom = process.env.FOOD_FROM?.trim() || '';
        if ((baseline.get(FIRE_FOOD) ?? 0) < 16 && foodFrom) {
            console.log(`MILESTONE waiting for food trade from ${foodFrom}`);
            await close();
            const re = new RegExp(`^${foodFrom.replace(/[^a-zA-Z0-9 _-]/g, '')}$`, 'i');
            const r = await s.bot.serveTrades({ from: re, maxTrades: 1, timeout: 180_000 });
            console.log(`TRADE ${r.reason} ${r.message}`);
            await open();
            for (const item of inv().filter(i => [330, 334, 380, 329, 333, 379].includes(i.id))) {
                await s.bot.depositItem(item, -1);
            }
            baseline = totals();
        }
        if ((baseline.get(FIRE_AMULET) ?? 0) < 1 || (baseline.get(954) ?? 0) < 1 || (baseline.get(FIRE_FOOD) ?? 0) < 16) {
            throw new Error('OWN amulet/rope/16Salmon required');
        }
        weapon = selectFireWeapon(baseline, s.sdk.getSkill('Attack')?.baseLevel ?? null);
        if (!weapon || (baseline.get(1171) ?? 0) < 1) throw new Error('owned equippable sword/shield absent or Attack unknown');
        await deposit();
        await close();
        for (const item of [...eq()]) await s.bot.unequipItem(item);
        await deposit();
        for (const [id, amount] of [[FIRE_AMULET, 1], [954, 1], [FIRE_FOOD, 16], [weapon, 1], [1171, 1]] as const) await withdraw(id, amount);
        await close();
        for (const id of [weapon, 1171]) {
            const item = inv().find(i => i.id === id);
            if (!item) throw new Error('equip item absent');
            await s.bot.equipItem(item);
            if (!(await waitUntil(s, () => eq().some(i => i.id === id), { timeoutTicks: 8 }))) throw new Error('equipment effect absent');
        }
        const fullHp = s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0;
        if (fullHp < 60) throw new Error('no Fire progress: mature Hitpoints required');
        while (hp() < fullHp && !over()) await eat();
        if (over() || hp() !== fullHp) throw new Error('no Fire progress: bank healing incomplete');
        if (held(FIRE_FOOD) < 16) {
            await withdraw(FIRE_FOOD, 16 - held(FIRE_FOOD));
            await close();
        }
        if (held(FIRE_FOOD) !== 16) throw new Error('no Fire progress: departure food unobserved');
        phase = 'travel';
        if (st()?.autoRetaliateEnabled === true) await s.direct({ type: 'clickComponent', componentId: 151, reason: 'Fire pilot OFF' });
        if (!(await waitUntil(s, () => st()?.autoRetaliateEnabled === false, { timeoutTicks: 8 }))) throw new Error('auto-retaliate OFF absent');
        await s.sdk.sendSetCombatStyle(0);
        if (!(await waitUntil(s, () => st()?.combatStyle?.known === true && st()?.combatStyle?.currentStyle === 0, { timeoutTicks: 8 }))) {
            throw new Error('accurate style unknown');
        }
        await walk(2617, 3309, 1);
        initialPrayer = points();
        await op(409, 2617, 3309, /pray/i);
        if (!(await waitUntil(s, () => points() >= 43, { timeoutTicks: 10 }))) throw new Error('altar full43 not observed');
        recharged = initialPrayer < 43 && points() >= 43;
        capture('altar');
        await walk(2522, 3494, 2);
        await s.bot.talkTo(/^Almera$/i);
        const dialogue = await waterfallDialogue(sess, {
            proof: /you are kind|small raft out back|too careful these days|tourist centre|need to use the raft|Thanks Almera|Good for all/i,
            choices: [/How can I help/i],
            maxTicks: 60,
            stop: over,
        });
        if (!dialogue.ok) throw new Error('Almera legitimate entry dialogue unproved');
        await walk(2511, 3494, 1);
        await step('raft', () => op(1987, 2509, 3493), () => near(2512, 3481, 4), 25);
        await waitTicks(s, 5);
        if (s.sdk.getDialog()?.isOpen) {
            const hudon = await waterfallDialogue(sess, { proof: /fine alone|leave me alone|do I know you/i, maxTicks: 60, stop: over });
            if (!hudon.ok) throw new Error('forced Hudon page not settled');
        }
        await walk(2512, 3477, 0);
        await step('rope rock', () => useRope(1996, 2512, 3468), () => near(2513, 3468, 0), 25);
        await waitTicks(s, 1);
        await step('rope tree', () => useRope(2020, 2512, 3465), () => near(2511, 3463, 2), 20);
        await step('ledge door', () => op(2010, 2511, 3464), () => near(2575, 9861, 2), 20);
        phase = 'dungeon';
        capture('dungeon-entry');
        await walk(2584, 9876, 1);
        await waitTicks(s, 2);
        await walk(2564, 9880, 0);
        const shut = st()?.nearbyLocs.find(l => [1516, 1519].includes(l.id) && l.z === 9881);
        if (shut) {
            await step('double door', () => op(shut.id, shut.x, shut.z, /open/i), () => !st()?.nearbyLocs.some(l => [1516, 1519].includes(l.id) && l.z === 9881), 12);
        }
        await walk(FIRE_ROOM_ENTRY.x, FIRE_ROOM_ENTRY.z, FIRE_ROOM_ENTRY.tol);
        await sealFireRoom(s, over);
        capture('door-sealed');
        await waitTicks(s, 9);
        await guard();
        for (let i = 0; i < 20 && hp() < 60 && held(FIRE_FOOD) > 8 && !over(); i++) {
            await eat();
            await waitTicks(s, 1);
        }
        if (hp() < 60 || held(FIRE_FOOD) < 9) throw new Error('refuse fight: HP<60 or food<9');
        entryPrayer = points();
        if (points() > 0) await prayer(true);
        capture('fight-ready');
        const selfSlot = (s.client as { selfSlot?: number } | undefined)?.selfSlot ?? -1;
        const target = selectFireTarget(st()?.nearbyNpcs ?? [], selfSlot);
        if (!target) throw new Error('no fresh owned/idle Fire giant in room');
        targetIndex = target.index;
        capture('target-selected');
        if (st()!.nearbyPlayers.some(v => Math.max(Math.abs(v.x - target.x), Math.abs(v.z - target.z)) <= 12)) {
            throw new Error('another player near target');
        }
        const fresh = st()?.nearbyNpcs.find(row => row.index === targetIndex && row.id === 110);
        const q = p();
        if (!fresh || !fireTargetInRoom(fresh) || !q || q.worldX < 2560 || q.worldX > 2582 || q.worldZ < 9882 || q.worldZ > 9899) {
            capture('target-dispatch-refused');
            throw new Error('no Fire progress: room attack dispatch unproved');
        }
        const ground = () => {
            const m = new Map<string, number>();
            for (const i of st()?.groundItems ?? []) m.set(`${i.id}:${i.x}:${i.z}`, (m.get(`${i.id}:${i.x}:${i.z}`) ?? 0) + i.count);
            return m;
        };
        const old = ground();
        const fightStart = s.tick();
        const ownXp = xp();
        const option = fresh.optionsWithIndex.find(opt => /^attack$/i.test(opt.text));
        if (!option || !(await s.sdk.sendInteractNpc(fresh.index, option.opIndex)).success) throw new Error('attack dispatch failed');
        phase = 'fight';
        let lastAttack = s.tick();
        let lastProgress = s.tick();
        let observedXp = ownXp;
        let foodAtAttack = held(FIRE_FOOD);
        while (!over()) {
            fightTicks = s.tick() - fightStart;
            await guard();
            if (!fireFightSafe(hp(), held(FIRE_FOOD), fightTicks)) throw new Error('fight time/food/HP retreat');
            const current = st()?.nearbyNpcs.find(row => row.id === 110 && row.index === targetIndex);
            const here = p();
            if (!here || here.level !== 0 || here.worldX < 2560 || here.worldX > 2582 || here.worldZ < 9882 || here.worldZ > 9899) {
                throw Error('no Fire progress: attack approach left room');
            }
            if (st()!.nearbyPlayers.some(v => Math.max(Math.abs(v.x - (current?.x ?? fresh.x)), Math.abs(v.z - (current?.z ?? fresh.z))) <= 12)) {
                throw new Error('public hero ambiguity');
            }
            if (!death && current) {
                for (const i of st()?.groundItems ?? []) {
                    if (i.x === (current.tileX ?? current.x) && i.z === (current.tileZ ?? current.z)) old.set(`${i.id}:${i.x}:${i.z}`, i.count);
                }
            }
            if (death) {
                const d = death;
                const counts = ground();
                const newBone = (counts.get(`${FIRE_BONES}:${d.x}:${d.z}`) ?? 0) - (old.get(`${FIRE_BONES}:${d.x}:${d.z}`) ?? 0);
                if (fireDeathCredit(xp() - ownXp, true, newBone)) {
                    const drops = (st()?.groundItems ?? []).filter(i => i.x === d.x && i.z === d.z && i.count > (old.get(`${i.id}:${i.x}:${i.z}`) ?? 0));
                    if (new Set(drops.map(i => i.id)).size > 2) throw new Error('unattributed corpse extras');
                    await walk(d.x, d.z, 0);
                    for (const item of drops) {
                        const amount = item.count - (old.get(`${item.id}:${item.x}:${item.z}`) ?? 0);
                        let got = 0;
                        while (got < amount) {
                            const before = held(item.id);
                            await s.sdk.sendPickup(d.x, d.z, item.id);
                            if (!(await waitUntil(s, () => held(item.id) > before, { timeoutTicks: 6 }))) {
                                throw new Error('actual corpse pickup not observed');
                            }
                            const delta = held(item.id) - before;
                            if (delta > amount - got) throw new Error('corpse attribution excess');
                            got += delta;
                            loot[item.id] = (loot[item.id] ?? 0) + delta;
                        }
                    }
                    creditedKills = 1;
                    capture('credited-corpse');
                    break;
                }
            }
            if (current && !fireTargetInRoom(current)) {
                capture('target-outside-room');
                throw new Error('target left bounded room');
            }
            if (xp() > observedXp) {
                observedXp = xp();
                lastProgress = s.tick();
            }
            if (!death && s.tick() - lastProgress >= 60) throw new Error('no Fire progress: no own damage for60 ticks');
            const me = p()?.combat;
            const needsAttack = held(FIRE_FOOD) !== foodAtAttack || me?.targetType !== 'npc' || me.targetIndex !== targetIndex || s.tick() - lastProgress >= 8;
            if (current && !death && needsAttack && s.tick() - lastAttack >= 8) {
                const attack = current.optionsWithIndex.find(opt => /^attack$/i.test(opt.text));
                if (!attack || !(await s.sdk.sendInteractNpc(current.index, attack.opIndex)).success) {
                    throw Error('no Fire progress: resumed attack dispatch failed');
                }
                lastAttack = s.tick();
                foodAtAttack = held(FIRE_FOOD);
                capture('attack-resumed');
            }
            await s.bot.dismissBlockingUI();
            await waitTicks(s, 1);
        }
        if (creditedKills !== 1) throw new Error('no complete hero corpse');
    } catch (e) {
        failure = String(e);
    } finally {
        if (eating) await eating;
        if (!banked && !ended && !died && !o.stop?.()) {
            try {
                await returnBank();
            } catch (e) {
                failure = [failure, String(e)].filter(Boolean).join('; ');
            }
        }
        off();
        eatHold.release();
    }
    const final = totals();
    const preserved =
        !!baseline && [...new Set([...baseline.keys(), ...final.keys()])].every(id => (final.get(id) ?? 0) === (baseline!.get(id) ?? 0) + (loot[id] ?? 0) - (id === FIRE_FOOD ? eaten : 0));
    const outputsBanked =
        banked
        && Object.entries(loot).every(([id, amount]) => held(Number(id)) === 0 && n(s.bankObservation?.()?.items ?? [], Number(id)) >= (baseline?.get(Number(id)) ?? 0) + amount);
    const ok = creditedKills === 1 && !failure && banked && outputsBanked && preserved && !died && !ended;
    return {
        ok,
        creditedKills,
        loot,
        banked,
        outputsBanked,
        preserved,
        eaten,
        recoveryEaten,
        hpMin,
        finalHp: hp(),
        weapon,
        entryPrayer,
        initialPrayer,
        recharged,
        finalPrayer: points(),
        fightTicks,
        attackXp: xp() - attack0,
        death,
        ticks: s.tick() - start,
        died,
        failure: failure || '-',
        trace,
        qualification: 'ONE finite pilot, observed food tank and Prayer; no Spider immunity or perpetual farming claim',
    };
}

export async function runFireCombatCli(args: readonly string[], env: Record<string, string | undefined> = process.env) {
    let stopped = false;
    const s = await openBot(args[0]!, {
        onStop: async () => {
            stopped = true;
        },
        onSessionEnd: async (session, detail) => finish([session], false, `no Fire progress: ${detail}; recover the owned dungeon kit before retry`),
    });
    try {
        const r = await runFireCombat(s, { cap: Number(env.CAP ?? 1600), stop: () => stopped });
        console.log('FIRE_COMBAT_BANK ' + JSON.stringify(r));
        await finish([s], r.ok, `Fire-pilot ${JSON.stringify(r)}`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

// ============================================================================
// 2. Ardougne Imps: bounded Imp 708 bead pilot
// ============================================================================
const IMP_NPC = 708;
const IMP_ASH = 592;
const IMP_FOOD = 333;
export const IMP_LOOT = [IMP_ASH, 1470, 1472, 1474, 1476] as const;
const IMP_BANK = { x: 2655, z: 3283 };
const IMP_ENTRY = { x: 2644, z: 3250 };
const IMP_TURN = { x: 2649, z: 3267 };
const IMP_HUNT = { x: 2633, z: 3243 };
type ImpTile = PathTile & { level?: number };
export const IMP_ROUTE_READY = true;
const IMP_THREATS = [
    [2632, 3274, 2633, 3280, 7],
    [2602, 3267, 2607, 3270, 16],
    [2601, 3269, 2601, 3269, 6],
    [2604, 3268, 2606, 3272, 6],
    [2622, 3272, 2622, 3272, 7],
    [2622, 3277, 2622, 3277, 7],
    [2616, 3283, 2620, 3283, 10],
    [2610, 3275, 2616, 3276, 7],
    [2610, 3193, 2610, 3193, 5],
    [2607, 3183, 2614, 3193, 5],
    [2671, 3240, 2671, 3240, 13],
] as const;
const impHazard = (p: PathTile) => IMP_THREATS.some(([x1, z1, x2, z2, r]) => Math.max(Math.max(x1 - p.x, 0, p.x - x2), Math.max(z1 - p.z, 0, p.z - z2)) <= r);
export const impInsideFence = (p: ImpTile) => (p.level ?? 0) === 0 && p.x >= 2627 && p.x <= 2645 && p.z >= 3222 && p.z <= 3253;
const impInterior = (p: PathTile, margin: number) => impInsideFence(p) && Math.min(p.x - 2627, 2645 - p.x, p.z - 3222, 3253 - p.z) >= margin;
const impAllowed = (p: ImpTile) => !impHazard(p) && (impInsideFence(p) || ((p.level ?? 0) === 0 && p.x >= 2637 && p.x <= 2658 && p.z >= 3248 && p.z <= 3287));

export function impGroundCounts(items: readonly { id: number; x: number; z: number; count: number }[]) {
    const counts = new Map<string, number>();
    for (const i of items) {
        const k = `${i.id}:${i.x}:${i.z}`;
        counts.set(k, (counts.get(k) ?? 0) + i.count);
    }
    return counts;
}

export const impCredit = (observedDeath: boolean, ownXp: number, newAshes: number) =>
    observedDeath && ownXp > 0 && Number.isSafeInteger(newAshes) && newAshes >= 1 && newAshes <= 2;

export function guardImpWalker(base: PathDeps, threat: () => string | null, hunt = false) {
    let why: string | null = null;
    const check = () => (why ??= threat());
    const valid = (level: number, from: PathTile, to: PathTile, path: PathTile[]) => {
        const inside = hunt ? impInsideFence : impAllowed;
        if (level !== 0 || !inside(from) || !inside(to)) {
            why = 'imp route outside fixed bounds';
            return false;
        }
        if (from.x === to.x && from.z === to.z && path.length === 0) return true;
        const end = path.at(-1);
        if (!end || end.x !== to.x || end.z !== to.z || expandPath(from, path).some(p => !inside(p))) {
            why = 'imp route incomplete or outside fixed bounds';
            return false;
        }
        return true;
    };
    const refused = () => ({ success: false, phase: 'dispatch', reason: 'imp_route_guard', message: why ?? 'imp route unknown' });
    const deps: PathDeps = {
        ...base,
        plan: (level, from, to) => {
            const path = base.plan(level, from, to);
            return valid(level, from, to, path) ? path : [];
        },
        walk: (x, z) => {
            if (check()) return refused();
            const p = base.pos();
            if (!p || !valid(p.level, p, { x, z }, base.plan(p.level, p, { x, z }))) return refused();
            return base.walk(x, z);
        },
        interactLoc: (loc, op) => (check() ? refused() : base.interactLoc(loc, op)),
        ...(base.runOn ? { runOn: () => (check() ? refused() : base.runOn!()) } : {}),
    };
    return { deps, reason: check };
}

export function chooseImpCancelStep(planner: Pick<PathDeps, 'plan'>, from: PathTile): PathTile | null {
    if (!impInterior(from, 2) || impHazard(from)) return null;
    const candidates: PathTile[] = [];
    for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) if (dx || dz) candidates.push({ x: from.x + dx, z: from.z + dz });
    const margin = (p: PathTile) => Math.min(p.x - 2627, 2645 - p.x, p.z - 3222, 3253 - p.z);
    candidates.sort((a, b) => margin(b) - margin(a) || a.x - b.x || a.z - b.z);
    for (const to of candidates) {
        if (!impInterior(to, 2) || impHazard(to)) continue;
        const path = planner.plan(0, from, to);
        const end = path.at(-1);
        const tiles = expandPath(from, path);
        if (end?.x === to.x && end.z === to.z && tiles.length === 1 && tiles[0].x === to.x && tiles[0].z === to.z) return to;
    }
    return null;
}

export async function cancelImpTarget(s: CombatSession, planner: Pick<PathDeps, 'plan'>, stop: () => boolean = () => false) {
    const from = s.sdk.getState()?.player;
    if (stop() || !from || from.level !== 0 || (s.sdk.getSkill('Hitpoints')?.level ?? 0) <= 6 || s.sdk.getState()?.autoRetaliateEnabled !== false) {
        throw new Error('no imp progress: unsafe cancellation state');
    }
    const step = chooseImpCancelStep(planner, { x: from.worldX, z: from.worldZ });
    if (!step) throw new Error('no imp progress: no verified adjacent cancel step');
    if (stop()) throw new Error('no imp progress: cancellation stopped before dispatch');
    const tick = s.tick();
    const reply = (await s.direct({ type: 'walkTo', x: step.x, z: step.z, running: false, reason: 'imp cancel step' })) as {
        success?: boolean;
        message?: string;
    };
    if (reply?.success !== true) throw new Error(`no imp progress: adjacent cancel dispatch failed ${reply?.message ?? 'unknown'}`);
    const arrived = await waitUntil(
        s,
        () => {
            const p = s.sdk.getState()?.player;
            return (
                (s.tick() > tick
                    && !!p
                    && p.level === 0
                    && p.worldX === step.x
                    && p.worldZ === step.z
                    && p.combat?.targetType === 'none'
                    && p.combat.targetIndex === -1
                    && s.sdk.getState()?.autoRetaliateEnabled === false)
                || stop()
            );
        },
        { timeoutTicks: 6 },
    );
    const currentPlayer = s.sdk.getState()?.player;
    if (
        !arrived
        || stop()
        || !currentPlayer
        || currentPlayer.worldX !== step.x
        || currentPlayer.worldZ !== step.z
        || currentPlayer.combat?.targetType !== 'none'
        || currentPlayer.combat.targetIndex !== -1
        || (s.sdk.getSkill('Hitpoints')?.level ?? 0) <= 6
    ) {
        throw new Error('no imp progress: adjacent cancellation unobserved');
    }
    return {
        from: [from.worldX, from.worldZ],
        to: [step.x, step.z],
        dispatchTick: tick,
        observedTick: s.tick(),
        dispatchAccepted: true,
        movementObserved: true,
        targetNoneObserved: true,
        recentHitInCombat: currentPlayer.combat.inCombat,
    };
}

export interface ImpOptions {
    cap: number;
    maximum: number;
    noProgress?: number;
    deferredNpcIndices?: readonly number[];
    stop?: () => boolean;
    walk?: (points: PathPoint[], cleanup: boolean) => Promise<boolean>;
    cancelPlanner?: Pick<PathDeps, 'plan'>;
}

export async function runImps(s: CombatSession, o: ImpOptions) {
    const sess = s as Session;
    const noProgress = o.noProgress ?? 120;
    if (
        !Number.isSafeInteger(o.cap)
        || o.cap < 1
        || o.cap > 1500
        || !Number.isSafeInteger(o.maximum)
        || o.maximum < 1
        || o.maximum > 3
        || !Number.isSafeInteger(noProgress)
        || noProgress < 1
        || noProgress > 120
    ) {
        throw new Error('no imp progress: invalid bounded limits');
    }
    const initialDeferredNpcIndices = [...(o.deferredNpcIndices ?? [])];
    if (initialDeferredNpcIndices.length > 8 || initialDeferredNpcIndices.some(v => !Number.isSafeInteger(v) || v < 0 || v > 65535)) {
        throw new Error('no imp progress: invalid initial deferred NPC indices');
    }
    if (!IMP_ROUTE_READY && !o.walk) throw new Error('no imp progress: offline route not admitted');
    const state = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const count = (items: readonly { id: number; count: number }[], id: number) => items.filter(i => i.id === id).reduce((v, i) => v + i.count, 0);
    const held = (id: number) => count(inv(), id);
    const xp = () => s.sdk.getSkillXp('Attack') ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    if (!(await waitUntil(s, () => hp() > 0 && (s.sdk.getSkill('Attack')?.baseLevel ?? 0) > 0, { timeoutTicks: 15 }))) {
        throw new Error('no imp progress: skills unknown');
    }
    const initialPlayer = state()?.player;
    const start = s.tick();
    const initialXp = xp();
    const foodHeldInitial = held(IMP_FOOD);
    if (!initialPlayer || initialPlayer.level !== 0 || Math.max(Math.abs(initialPlayer.worldX - IMP_BANK.x), Math.abs(initialPlayer.worldZ - IMP_BANK.z)) > 3 || held(IMP_FOOD) < 2) {
        throw new Error('no imp progress: stage Ardy bank with2working Trout');
    }
    let ended = false;
    let died = false;
    let hpMin = hp();
    let eaten = 0;
    let creditedKills = 0;
    let attacks = 0;
    let reengagements = 0;
    let failure = '';
    let stop = 'cap';
    let activeIndex: number | undefined;
    let activeX = 0;
    let activeZ = 0;
    const loot: Record<number, number> = {};
    const banked: Record<number, number> = {};
    const diagnostics: Record<string, unknown>[] = [];
    const credits: Record<string, unknown>[] = [];
    const abandoned: Record<string, unknown>[] = [];
    const deferred = new Set<number>(initialDeferredNpcIndices);
    let activeBeforeXp: number | undefined;
    let corpse: { x: number; z: number; hp0: boolean; deathAnim: boolean } | undefined;
    let activeBaseline: Map<string, number> | undefined;
    let combatHalt = '';
    let combatHaltKind: 'actor' | 'target' = 'actor';
    const liveAnchors = new Set<string>();
    const cancellations: Awaited<ReturnType<typeof cancelImpTarget>>[] = [];
    let movement: PathDeps | undefined;
    let cancelPending: Promise<Awaited<ReturnType<typeof cancelImpTarget>>> | undefined;
    let snapshot: { id: number; count: number }[] | undefined;
    let initial: Map<number, number> | undefined;
    const bankCount = (id: number) => count(snapshot ?? [], id);
    const totals = () => {
        const m = new Map<number, number>();
        for (const i of [...(snapshot ?? []), ...inv(), ...s.sdk.getEquipment()]) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        return m;
    };
    const capture = (phase: string) => {
        const n = state()?.nearbyNpcs.find(row => row.index === activeIndex);
        if (diagnostics.length >= 24) diagnostics.splice(2, 1);
        diagnostics.push({
            tick: s.tick() - start,
            phase,
            index: activeIndex,
            anchor: [activeX, activeZ],
            corpse,
            xp: xp() - initialXp,
            hp: hp(),
            npc: n ? { id: n.id, x: n.tileX ?? n.x, z: n.tileZ ?? n.z, hp: n.hp, anim: n.animId, inCombat: n.inCombat } : null,
            ground: (state()?.groundItems ?? []).filter(i => IMP_LOOT.includes(i.id as any)).map(i => ({ id: i.id, x: i.x, z: i.z, count: i.count })),
            players: (state()?.nearbyPlayers ?? []).map(p => ({ index: p.index, x: p.x, z: p.z })),
        });
    };
    const observe = () => {
        const p = state()?.player;
        hpMin = Math.min(hpMin, hp());
        if (sessionDied(initialPlayer, p)) died = true;
        const n = state()?.nearbyNpcs.find(row => row.index === activeIndex && row.id === IMP_NPC);
        const targetJump = !!n && Math.max(Math.abs((n.tileX ?? n.x) - activeX), Math.abs((n.tileZ ?? n.z) - activeZ)) > 2;
        if (
            activeBaseline
            && !corpse
            && p
            && !combatHalt
            && ((n && !impInterior({ x: n.tileX ?? n.x, z: n.tileZ ?? n.z }, 3)) || targetJump || !impInterior({ x: p.worldX, z: p.worldZ }, 2))
        ) {
            combatHaltKind = impInterior({ x: p.worldX, z: p.worldZ }, 2) ? 'target' : 'actor';
            combatHalt =
                targetJump && combatHaltKind === 'target'
                    ? 'target jumped beyond observed approach; no chase'
                    : `${combatHaltKind === 'target' ? 'target' : 'player'} reached interior margin; no chase`;
            if (!ended && !died) void cancel().catch(() => {});
            capture('combat-halt');
        }
        if (n && activeBaseline && !corpse) {
            const x = n.tileX ?? n.x;
            const z = n.tileZ ?? n.z;
            if (n.hp === 0 || n.animId === 172) {
                corpse = { x, z, hp0: n.hp === 0, deathAnim: n.animId === 172 };
                capture('death-observed');
            } else {
                liveAnchors.add(`${x}:${z}`);
                const ground = impGroundCounts(state()?.groundItems ?? []);
                for (const id of IMP_LOOT) {
                    const key = `${id}:${x}:${z}`;
                    activeBaseline.set(key, ground.get(key) ?? 0);
                }
            }
        }
    };
    void s.ended.then(() => {
        ended = true;
    });
    const off = s.onTick(observe);
    const over = () => {
        observe();
        return ended || died || !!o.stop?.() || s.tick() - start >= o.cap;
    };
    const cancel = () =>
        (cancelPending ??= (async () => {
            const proof = await cancelImpTarget(s, o.cancelPlanner ?? movement ?? (await sessionWalker(sess)), () => ended || died || !!o.stop?.() || !!threat());
            cancellations.push(proof);
            return proof;
        })());
    const threat = () => {
        const p = state()?.player;
        if (ended || died) return 'imp session ended/dead';
        if (!p || !impAllowed({ x: p.worldX, z: p.worldZ, level: p.level })) return 'imp player outside route bounds';
        const radii: Record<number, number> = { 105: 4, 107: 4, 109: 2, 113: 4, 116: 4, 95: 4, 128: 2 };
        if (
            (state()?.nearbyNpcs ?? []).some(
                n => radii[n.id] !== undefined && Math.max(Math.abs((n.tileX ?? n.x) - p.worldX), Math.abs((n.tileZ ?? n.z) - p.worldZ)) <= radii[n.id]!,
            )
        ) {
            return 'imp nearby known threat';
        }
        return null;
    };
    const recordAbandoned = (reason: string, cancellationObserved: boolean) => {
        if (activeBeforeXp === undefined) return;
        abandoned.push({
            npcIndex: activeIndex,
            anchor: [activeX, activeZ],
            partialDamageXp: Math.max(0, xp() - activeBeforeXp),
            reason,
            cancellationObserved,
        });
        if (activeIndex !== undefined) deferred.add(activeIndex);
        activeBeforeXp = undefined;
        activeBaseline = undefined;
        capture('abandoned');
    };
    const cancelObserved = async () => {
        const p = state()?.player;
        if (threat() || !p || !impInterior({ x: p.worldX, z: p.worldZ }, 2) || hp() <= 6) {
            throw new Error('no imp progress: player/threat unsafe during target abandonment');
        }
        await cancel();
        if (threat() || over()) throw new Error('no imp progress: target cancellation unobserved or player unsafe');
    };
    const abandonTarget = async (reason: string) => {
        await cancelObserved();
        recordAbandoned(reason, true);
        combatHalt = '';
        corpse = undefined;
        liveAnchors.clear();
        if (abandoned.length >= 3) {
            stop = 'abandon-limit';
            throw new Error('no imp progress: three target abandons');
        }
    };
    const eat = async () => {
        if (hp() > 8) return;
        const food = inv().find(i => i.id === IMP_FOOD);
        const before = held(IMP_FOOD);
        const beforeHp = hp();
        if (!food || before <= 2) throw new Error('no imp progress: working food reserve reached');
        await s.bot.eatFood(food);
        await waitUntil(s, () => (held(IMP_FOOD) < before && hp() > beforeHp) || ended || died, { timeoutTicks: 6 });
        eaten += Math.max(0, before - held(IMP_FOOD));
        if (held(IMP_FOOD) !== before - 1 || hp() <= beforeHp || hp() <= 6) throw new Error('no imp progress: food debit/heal not observed');
    };
    const walk = async (points: PathPoint[], cleanup = false) => {
        const settleCancellation = async () => {
            const prior = cancelPending;
            cancelPending = undefined;
            if (prior) await prior.catch(() => {});
        };
        await settleCancellation();
        try {
            if (o.walk) {
                if (!(await o.walk(points, cleanup))) throw new Error('no imp progress: test route failed');
                return;
            }
            const p = state()?.player;
            const hunt = !!p && impInsideFence({ x: p.worldX, z: p.worldZ, level: p.level }) && points.every(impInsideFence);
            movement ??= await sessionWalker(sess);
            const g = guardImpWalker(movement, () => threat() ?? (hp() <= 6 ? 'imp low HP' : null), hunt);
            const r = await walkPath(g.deps, points, { look: 4, maxTicks: 220, stop: () => !!g.reason() || (!cleanup && over()) });
            if (!r.ok || g.reason()) {
                await cancel();
                throw new Error(`no imp progress: route ${g.reason() ?? r.detail}`);
            }
        } finally {
            await settleCancellation();
        }
    };
    const open = async () => {
        const before = s.bankObservation?.()?.generation ?? 0;
        if (!state()?.bank?.isOpen) {
            if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!state()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > before, { timeoutTicks: 15 }))) {
                throw new Error('no imp progress: bank readiness unknown');
            }
        }
        const b = s.bankObservation?.();
        if (!b) throw new Error('no imp progress: bank data unknown');
        snapshot = b.items.map(i => ({ id: i.id, count: i.count }));
    };
    const deposit = async () => {
        for (const id of IMP_LOOT) {
            const item = inv().find(i => i.id === id);
            if (!item) continue;
            const before = bankCount(id);
            const amount = held(id);
            if (
                !(await s.bot.depositItem(item, -1)).success
                || !(await waitUntil(s, () => held(id) === 0 && count(s.bankObservation?.()?.items ?? [], id) === before + amount, { timeoutTicks: 15 }))
            ) {
                throw new Error('no imp progress: loot bank delta mismatch');
            }
            await open();
        }
    };
    const returnBank = async () => {
        activeBaseline = undefined;
        const p = state()?.player;
        if (p && Math.max(Math.abs(p.worldX - IMP_BANK.x), Math.abs(p.worldZ - IMP_BANK.z)) > 3) {
            await eat();
            await walk([{ ...IMP_ENTRY, tol: 0 }, { ...IMP_TURN, tol: 0 }, { ...IMP_BANK, tol: 2 }], true);
        }
        await open();
        await deposit();
    };
    try {
        await open();
        initial = totals();
        await deposit();
        if (!(await s.bot.closeBank()).success) throw new Error('no imp progress: bank close failed');
        await equipCowKit(s, over);
        if (state()?.autoRetaliateEnabled === true) await s.direct({ type: 'clickComponent', componentId: 151, reason: 'imp auto-retaliate off' });
        if (!(await waitUntil(s, () => state()?.autoRetaliateEnabled === false, { timeoutTicks: 10 }))) {
            throw new Error('no imp progress: auto-retaliate OFF unobserved');
        }
        if (
            !(await s.sdk.sendSetCombatStyle(0)).success
            || !(await waitUntil(
                s,
                () => {
                    const c = state()?.combatStyle;
                    return (
                        !!c?.known
                        && c.weaponName === state()?.equipment?.find(i => i.slot === 3)?.name
                        && c.currentStyle === 0
                        && c.styles.some(v => v.index === 0 && v.trainsSkills.length === 1 && v.trainsSkills[0] === 'Attack')
                    );
                },
                { timeoutTicks: 10 },
            ))
        ) {
            throw new Error('no imp progress: Attack style unobserved');
        }
        await eat();
        await walk([{ ...IMP_TURN, tol: 0 }, { ...IMP_ENTRY, tol: 0 }, { ...IMP_HUNT, tol: 0 }]);
        let progress = s.tick();
        let dispatchFailures = 0;
        while (creditedKills < o.maximum && !over()) {
            if (abandoned.length >= 3) {
                stop = 'abandon-limit';
                throw new Error('no imp progress: three target abandons');
            }
            await eat();
            const danger = threat();
            if (danger) throw new Error(`no imp progress: ${danger}`);
            if (s.tick() - progress >= noProgress) throw new Error('no imp progress: no eligible target');
            const target = state()?.nearbyNpcs.find(
                row =>
                    row.id === IMP_NPC
                    && !deferred.has(row.index)
                    && impInterior({ x: row.tileX ?? row.x, z: row.tileZ ?? row.z }, 3)
                    && row.reachable !== false
                    && !row.inCombat
                    && (row.hp === null || row.maxHp === null || row.hp >= row.maxHp),
            );
            if (!target) {
                await waitTicks(s, 1);
                continue;
            }
            activeIndex = target.index;
            activeX = target.tileX ?? target.x;
            activeZ = target.tileZ ?? target.z;
            if ((state()?.nearbyPlayers ?? []).some(p => Math.max(Math.abs(p.x - activeX), Math.abs(p.z - activeZ)) <= 12)) {
                throw new Error('no imp progress: another player near target');
            }
            await walk([{ x: activeX, z: activeZ, tol: 1 }]);
            const current = state()?.nearbyNpcs.find(row => row.index === target.index && row.id === IMP_NPC);
            const p = state()?.player;
            if (
                !current
                || !p
                || !impInterior({ x: current.tileX ?? current.x, z: current.tileZ ?? current.z }, 3)
                || !impInterior({ x: p.worldX, z: p.worldZ }, 2)
                || Math.max(Math.abs((current.tileX ?? current.x) - p.worldX), Math.abs((current.tileZ ?? current.z) - p.worldZ)) > 1
            ) {
                await waitTicks(s, 1);
                continue;
            }
            const option = current.optionsWithIndex.find(op => /^attack$/i.test(op.text));
            if (!option) throw new Error('no imp progress: attack option unknown');
            const baseline = impGroundCounts(state()?.groundItems ?? []);
            const beforeXp = xp();
            activeBeforeXp = beforeXp;
            activeBaseline = baseline;
            corpse = undefined;
            combatHalt = '';
            cancelPending = undefined;
            liveAnchors.clear();
            activeX = current.tileX ?? current.x;
            activeZ = current.tileZ ?? current.z;
            liveAnchors.add(`${activeX}:${activeZ}`);
            capture('attack');
            const result = await s.sdk.sendInteractNpc(current.index, option.opIndex);
            attacks++;
            if (!result.success) {
                recordAbandoned('attack dispatch refused', false);
                if (++dispatchFailures >= 3) throw new Error(`no imp progress: three attack dispatch refusals ${result.message}`);
                await waitTicks(s, 1);
                continue;
            }
            dispatchFailures = 0;
            let observedXp = beforeXp;
            let lastDamage = s.tick();
            let credited = false;
            let lost = false;
            let retarget = false;
            let lostAt: number | undefined;
            let disengagedAt: number | undefined;
            let reattempts = 0;
            while (!over()) {
                if (combatHalt) {
                    if (combatHaltKind === 'actor') throw new Error(`no imp progress: ${combatHalt}`);
                    await abandonTarget(combatHalt);
                    retarget = true;
                    progress = s.tick();
                    break;
                }
                await eat();
                const loopDanger = threat();
                if (loopDanger) throw new Error(`no imp progress: ${loopDanger}`);
                const n = state()?.nearbyNpcs.find(row => row.index === activeIndex && row.id === IMP_NPC);
                const death = corpse as { x: number; z: number; hp0: boolean; deathAnim: boolean } | undefined;
                if (death) {
                    activeX = death.x;
                    activeZ = death.z;
                } else if (n) {
                    lost = false;
                    lostAt = undefined;
                    const nx = n.tileX ?? n.x;
                    const nz = n.tileZ ?? n.z;
                    if (nx !== activeX || nz !== activeZ) {
                        activeX = nx;
                        activeZ = nz;
                        capture('target-moved');
                    }
                    if (n.hp !== 0 && n.animId !== 172) {
                        const groundNow = impGroundCounts(state()?.groundItems ?? []);
                        for (const id of IMP_LOOT) {
                            const key = `${id}:${activeX}:${activeZ}`;
                            baseline.set(key, groundNow.get(key) ?? 0);
                        }
                    }
                } else if (!lost) {
                    lost = true;
                    lostAt = s.tick();
                    capture('lost-target-await-ashes');
                }
                if (!impInsideFence({ x: activeX, z: activeZ })) throw new Error('no imp progress: target left fence; no chase');
                if ((state()?.nearbyPlayers ?? []).some(player => Math.max(Math.abs(player.x - activeX), Math.abs(player.z - activeZ)) <= 12)) {
                    throw new Error('no imp progress: player entered target area');
                }
                if (xp() > observedXp) {
                    observedXp = xp();
                    lastDamage = s.tick();
                    capture('damage');
                }
                const counts = impGroundCounts(state()?.groundItems ?? []);
                const newAsh = (counts.get(`${IMP_ASH}:${activeX}:${activeZ}`) ?? 0) - (baseline.get(`${IMP_ASH}:${activeX}:${activeZ}`) ?? 0);
                if (impCredit(!!corpse && liveAnchors.has(`${activeX}:${activeZ}`), xp() - beforeXp, newAsh)) {
                    const beads = IMP_LOOT.filter(id => id !== IMP_ASH).map(
                        id => (counts.get(`${id}:${activeX}:${activeZ}`) ?? 0) - (baseline.get(`${id}:${activeX}:${activeZ}`) ?? 0),
                    );
                    if (beads.some(b => b < 0 || b > 1) || beads.reduce((a, b) => a + b, 0) > 1) {
                        throw new Error('no imp progress: corpse bead attribution unknown');
                    }
                    capture('hero-ashes');
                    await cancel();
                    await walk([{ x: activeX, z: activeZ, tol: 0 }]);
                    for (const id of IMP_LOOT) {
                        const amount = (counts.get(`${id}:${activeX}:${activeZ}`) ?? 0) - (baseline.get(`${id}:${activeX}:${activeZ}`) ?? 0);
                        if (amount <= 0) continue;
                        let picked = 0;
                        while (picked < amount) {
                            const pile = state()?.groundItems.find(i => i.id === id && i.x === activeX && i.z === activeZ);
                            const before = held(id);
                            if (!pile || inv().length >= 28) throw new Error('no imp progress: credited loot missing or inventory full');
                            await s.sdk.sendPickup(activeX, activeZ, id);
                            if (!(await waitUntil(s, () => held(id) > before || ended || died, { timeoutTicks: 6 }))) {
                                throw new Error('no imp progress: loot pickup unobserved');
                            }
                            const gain = held(id) - before;
                            if (gain < 1 || gain > amount - picked) throw new Error('no imp progress: loot pickup amount mismatch');
                            picked += gain;
                            loot[id] = (loot[id] ?? 0) + gain;
                        }
                    }
                    credits.push({
                        npcIndex: activeIndex,
                        anchor: [activeX, activeZ],
                        ownAttackXp: xp() - beforeXp,
                        observedHp0: corpse!.hp0,
                        deathAnim: corpse!.deathAnim,
                        freshAshCount: newAsh,
                        guaranteedAshes: 1,
                        extraAshes: newAsh - 1,
                        beadCounts: Object.fromEntries(
                            IMP_LOOT.filter(id => id !== IMP_ASH).map(
                                id => [id, (counts.get(`${id}:${activeX}:${activeZ}`) ?? 0) - (baseline.get(`${id}:${activeX}:${activeZ}`) ?? 0)],
                            ),
                        ),
                    });
                    creditedKills++;
                    activeBeforeXp = undefined;
                    activeBaseline = undefined;
                    progress = s.tick();
                    credited = true;
                    break;
                }
                if (!n && !death && lostAt !== undefined && s.tick() - lostAt >= 6) {
                    await abandonTarget('target lost without witnessed death');
                    retarget = true;
                    progress = s.tick();
                    break;
                }
                const combat = state()?.player?.combat;
                const disengaged = !!n && !death && xp() > beforeXp && combat?.targetType === 'none' && combat.targetIndex === -1 && !n.inCombat;
                if (disengaged) {
                    disengagedAt ??= s.tick();
                    if (s.tick() - disengagedAt >= 6) {
                        if (reattempts >= 4) {
                            await abandonTarget('four guarded re-engagements exhausted');
                            retarget = true;
                            progress = s.tick();
                            break;
                        }
                        await cancelObserved();
                        const eligible = () => {
                            const tgt = state()?.nearbyNpcs.find(v => v.id === IMP_NPC && v.index === activeIndex);
                            if (
                                !tgt
                                || tgt.hp === 0
                                || tgt.animId === 172
                                || tgt.inCombat
                                || tgt.reachable === false
                                || !impInterior({ x: tgt.tileX ?? tgt.x, z: tgt.tileZ ?? tgt.z }, 3)
                            ) {
                                return null;
                            }
                            if (
                                (state()?.nearbyPlayers ?? []).some(
                                    pl => Math.max(Math.abs(pl.x - (tgt.tileX ?? tgt.x)), Math.abs(pl.z - (tgt.tileZ ?? tgt.z))) <= 12,
                                )
                            ) {
                                return null;
                            }
                            return tgt;
                        };
                        let tgt = eligible();
                        if (!tgt) {
                            await abandonTarget('visible target no longer eligible');
                            retarget = true;
                            progress = s.tick();
                            break;
                        }
                        await walk([{ x: tgt.tileX ?? tgt.x, z: tgt.tileZ ?? tgt.z, tol: 1 }]);
                        tgt = eligible();
                        const actor = state()?.player;
                        if (
                            !tgt
                            || !actor
                            || !impInterior({ x: actor.worldX, z: actor.worldZ }, 2)
                            || Math.max(Math.abs((tgt.tileX ?? tgt.x) - actor.worldX), Math.abs((tgt.tileZ ?? tgt.z) - actor.worldZ)) > 1
                        ) {
                            await abandonTarget('guarded re-engagement unavailable');
                            retarget = true;
                            progress = s.tick();
                            break;
                        }
                        const atkOp = tgt.optionsWithIndex.find(op => /^attack$/i.test(op.text));
                        if (!atkOp) throw new Error('no imp progress: re-engagement attack option unknown');
                        capture('re-engage');
                        cancelPending = undefined;
                        const sent = await s.sdk.sendInteractNpc(tgt.index, atkOp.opIndex);
                        attacks++;
                        reattempts++;
                        reengagements++;
                        if (!sent.success) {
                            await abandonTarget(`re-engagement refused ${sent.message}`);
                            retarget = true;
                            progress = s.tick();
                            break;
                        }
                        disengagedAt = undefined;
                    }
                } else {
                    disengagedAt = undefined;
                }
                if (s.tick() - lastDamage >= noProgress) throw new Error('no imp progress: target damage/hero-loot timeout');
                await waitTicks(s, 1);
            }
            if (retarget) continue;
            if (!credited) break;
        }
        stop = creditedKills === o.maximum ? 'max-kills' : o.stop?.() ? 'stop-file' : died ? 'died' : 'cap';
    } catch (e) {
        failure = String(e);
        capture('failure');
    } finally {
        if (activeBeforeXp !== undefined) recordAbandoned('job ended without completed kill proof', false);
        if (!ended && !died) {
            try {
                await returnBank();
            } catch (e) {
                failure = [failure, String(e)].filter(Boolean).join('; ');
            }
        }
        off();
    }
    for (const id of IMP_LOOT) banked[id] = initial ? bankCount(id) - (initial.get(id) ?? 0) : 0;
    const final = totals();
    const preserved =
        !!initial
        && [...new Set([...initial.keys(), ...final.keys(), ...IMP_LOOT])].every(
            id => (final.get(id) ?? 0) === (initial!.get(id) ?? 0) + (loot[id] ?? 0) - (id === IMP_FOOD ? eaten : 0),
        );
    if (!preserved) failure ||= 'no imp progress: asset conservation failed';
    if (IMP_LOOT.some(id => held(id) > 0 || banked[id] !== (loot[id] ?? 0))) failure ||= 'no imp progress: final bank proof failed';
    const attributedAshes = credits.reduce((n, c) => n + Number(c.freshAshCount), 0);
    const bonusAshes = credits.reduce((n, c) => n + Number(c.extraAshes), 0);
    const creditedAttackXp = credits.reduce((n, c) => n + Number(c.ownAttackXp), 0);
    const abandonedAttackXp = abandoned.reduce((n, c) => n + Number(c.partialDamageXp), 0);
    if (creditedAttackXp + abandonedAttackXp !== xp() - initialXp) failure ||= 'no imp progress: Attack XP attribution mismatch';
    const targetMet = creditedKills === o.maximum && !failure && !ended && !died && preserved;
    console.log(`IMP_DIAGNOSTIC ${JSON.stringify(diagnostics)}`);
    return {
        ok: targetMet,
        creditedKills,
        attacks,
        reengagements,
        loot,
        banked,
        credits,
        abandoned,
        cancellations,
        initialDeferredNpcIndices,
        creditedAttackXp,
        abandonedAttackXp,
        mandatoryAshes: creditedKills,
        bonusAshes,
        unexplainedAshes: (banked[IMP_ASH] ?? 0) - attributedAshes,
        attackXp: xp() - initialXp,
        eaten,
        foodHeldInitial,
        foodHeldFinal: held(IMP_FOOD),
        hpMin,
        died,
        preserved,
        targetMet,
        stop,
        ticks: s.tick() - start,
        failure: failure || (!targetMet ? 'no imp progress: bounded target unmet' : '-'),
        diagnostics,
    };
}

export async function runImpsCli(args: readonly string[], env: Record<string, string | undefined> = process.env) {
    const name = args[0];
    if (!name) throw new Error('imp account required');
    if (!IMP_ROUTE_READY) await finish([], false, 'no imp progress: offline route not admitted');
    let stopped = false;
    const s = await openBot(name, {
        onStop: async () => {
            stopped = true;
        },
    }).catch(e => finish([], false, `login: ${String(e)}`));
    try {
        const r = await runImps(s, {
            cap: Number(env.CAP ?? 900),
            maximum: Number(env.MAX_KILLS ?? 1),
            noProgress: Number(env.NO_PROGRESS ?? 120),
            stop: () => stopped,
        });
        await finish([s], r.ok, `mode=imp ${Object.entries(r).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')}`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

// ============================================================================
// 3. Mort'ton Shades: Fiyr shade tomb trips
// ============================================================================
const parseShadeCoord = (raw: string) => {
    const [level, mx, mz, lx, lz] = raw.split('_').map(Number);
    return { level: level!, x: mx! * 64 + lx!, z: mz! * 64 + lz! };
};

export const SHADE_INCOMING_TICKS = 125;
export const SHADE_ROUTE = {
    bank: { x: 3510, z: 3480, level: 0 },
    site: { x: 3485, z: 3322, level: 0 },
    entry: { x: 3485, z: 3320, level: 0 },
    landing: parseShadeCoord('0_54_151_37_61'),
    hunt: { x: 3464, z: 9715, level: 0 },
    exit: parseShadeCoord('0_54_151_37_62'),
    surface: parseShadeCoord('0_54_51_29_58'),
    key: 3465,
    shadow: 1249,
    shade: 1250,
    remains: 3404,
    death: 1287,
    hp: 110,
} as const;

export type ShadeJob = {
    xpRate: number;
    target: number;
    cap: number;
    returnTicks: number;
    foodPerKill: number;
    potionsPerKill: number;
    pouchChargesPerTrip: number;
    maximumDoses: number;
    reserve: number;
    wear: CombatOwnedKit['wear'];
};

export function validateShadeJob(j: ShadeJob) {
    validateBankRouteJob({ ...j, family: 'shade', recipe: 'fiyr', batch: 1, members: true, bank: SHADE_ROUTE.bank, site: SHADE_ROUTE.site });
    if (
        !Number.isSafeInteger(j.xpRate)
        || j.xpRate < 1
        || j.xpRate > 1000
        || j.target > 4
        || j.cap < 2000
        || j.cap > 20000
        || j.returnTicks < 600
        || ![j.foodPerKill, j.potionsPerKill, j.maximumDoses].every(Number.isSafeInteger)
        || j.foodPerKill < 1
        || j.foodPerKill > 4
        || j.potionsPerKill < 1
        || j.potionsPerKill > 3
        || j.maximumDoses < 1
        || j.maximumDoses > 40
        || j.maximumDoses > j.target * j.potionsPerKill * 4
        || !j.wear?.some(i => i.id === 1289 && i.slot === 3 && i.count === 1)
        || !j.wear.some(i => i.slot === 5 && i.count === 1)
    ) {
        throw Error('invalid finite owned Shade kit/food/prayer budget');
    }
    if (!Number.isSafeInteger(j.pouchChargesPerTrip) || j.pouchChargesPerTrip <= Math.ceil(j.returnTicks / 26) + 1 || j.pouchChargesPerTrip > 1000) {
        throw Error('Shade owned charged pouch must fund outward use plus native26tick return reserve');
    }
    validateCombatOwnedKit({ bank: SHADE_ROUTE.bank, pack: [], wear: j.wear, cap: 200, maximumMoves: 96 });
    return j;
}

export function shadeStopRequested(name: string, stop: () => boolean = () => false, exists: (p: string) => boolean = existsSync) {
    return (
        stop()
        || exists('.practice/stop-all')
        || exists(`.practice/stop-${name}`)
        || exists('.practice/stop-microbot-shade-trip')
        || (!!process.env.STOP_FILE && exists(process.env.STOP_FILE))
    );
}

export function shadeDeathReceipt(v: {
    sameNative: boolean;
    id: number;
    owner: number | undefined;
    self: number;
    hp: number | null | undefined;
    anim: number;
    gone: boolean;
    damage: number;
    corpseWitness: boolean;
    regenOpportunities?: number;
}) {
    const regen = v.regenOpportunities ?? 0;
    return (
        Number.isSafeInteger(regen)
        && regen >= 0
        && Number.isSafeInteger(v.damage)
        && v.sameNative
        && [1249, 1250].includes(v.id)
        && v.owner === 32768 + v.self
        && v.corpseWitness
        && v.gone
        && v.damage >= 110
        && v.damage <= 110 + regen
    );
}

type GhastFrame = {
    tick: number;
    x: number;
    z: number;
    level: number;
    isolated: boolean;
    original: boolean;
    ghosts: { id: number; index: number; tileX?: number; tileZ?: number; size?: number; targetIndex: number; animId: number; native: unknown; nativeType?: number }[];
};

export function shadeMovingGhastWitness(before: GhastFrame, after: GhastFrame, ownerUid: number) {
    if (
        ![before.tick, after.tick, before.x, before.z, after.x, after.z, before.level, after.level].every(Number.isSafeInteger)
        || !Number.isSafeInteger(ownerUid)
        || ownerUid < 32768
        || ownerUid >= 34816
        || !before.original
        || !after.original
        || !before.isolated
        || !after.isolated
        || after.tick !== before.tick + 1
        || before.level !== after.level
        || before.level !== 0
        || Math.max(Math.abs(after.x - before.x), Math.abs(after.z - before.z)) > 2
    ) {
        return false;
    }
    return after.ghosts.some(n => {
        const old = before.ghosts.find(v => v.index === n.index);
        if (
            !old
            || old.id !== 1052
            || n.id !== 1052
            || old.nativeType !== 1052
            || n.nativeType !== 1052
            || !old.native
            || typeof old.native !== 'object'
            || old.native !== n.native
            || old.size !== 2
            || n.size !== 2
            || old.targetIndex !== ownerUid
            || (n.targetIndex !== -1 && n.targetIndex !== ownerUid)
            || n.animId !== 1093
            || ![old.tileX, old.tileZ, n.tileX, n.tileZ].every(Number.isSafeInteger)
        ) {
            return false;
        }
        const gap = Math.max(old.tileX! - before.x, before.x - (old.tileX! + 1), old.tileZ! - before.z, before.z - (old.tileZ! + 1), 0);
        return gap <= 1 && Math.max(Math.abs(n.tileX! - old.tileX!), Math.abs(n.tileZ! - old.tileZ!)) <= 1;
    });
}

export function shadePouchGhastWitness(before: GhastFrame, after: GhastFrame, ownerUid: number) {
    const elapsed = after.tick - before.tick;
    if (
        !Number.isSafeInteger(elapsed)
        || elapsed < 1
        || elapsed > 2
        || !before.original
        || !after.original
        || !before.isolated
        || !after.isolated
        || before.level !== 0
        || after.level !== 0
        || Math.max(Math.abs(after.x - before.x), Math.abs(after.z - before.z)) > 2 * elapsed
    ) {
        return false;
    }
    return after.ghosts.some(n => {
        const old = before.ghosts.find(v => v.index === n.index);
        if (
            !old
            || old.id !== 1052
            || old.nativeType !== 1052
            || ![1052, 1053].includes(n.id)
            || n.nativeType !== n.id
            || !old.native
            || old.native !== n.native
            || old.size !== 2
            || n.size !== 2
            || ![old.tileX, old.tileZ, n.tileX, n.tileZ].every(Number.isSafeInteger)
            || ![old.targetIndex, n.targetIndex].every(v => v === -1 || v === ownerUid)
            || (old.targetIndex !== ownerUid && n.targetIndex !== ownerUid)
            || (n.id === 1052 && n.animId !== 1093)
        ) {
            return false;
        }
        const gap = (v: typeof n, p: GhastFrame) => Math.max(v.tileX! - p.x, p.x - (v.tileX! + 1), v.tileZ! - p.z, p.z - (v.tileZ! + 1), 0);
        return (Math.min(gap(old, before), gap(n, after)) <= 1 || (elapsed === 1 && gap(n, before) <= 1))
            && Math.max(Math.abs(n.tileX! - old.tileX!), Math.abs(n.tileZ! - old.tileZ!)) <= elapsed;
    });
}

export function shadePouchEffect(before: readonly { id: number; count: number }[], after: readonly { id: number; count: number }[], proof: { fresh: boolean; ghast: boolean; quiet: boolean }) {
    const sum = (rows: typeof before) => {
        const out: Record<number, number> = {};
        for (const r of rows) out[r.id] = (out[r.id] ?? 0) + r.count;
        return out;
    };
    const b = sum(before);
    const a = sum(after);
    const charges = b[2958] ?? 0;
    if (!proof.fresh || !proof.ghast || !proof.quiet || !Number.isSafeInteger(charges) || charges < 1) return false;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(
        k => (a[+k] ?? 0) - (b[+k] ?? 0) === (+k === 2958 ? -1 : +k === 2957 && charges === 1 ? 1 : 0),
    );
}

type ShadeDeps = {
    bank?: typeof runCombatBankProfile;
    loadout?: typeof runCombatOwnedLoadout;
    walker?: typeof sessionWalker;
};

export function shadeOwnContext(s: CombatSession) {
    const client = s.client as any;
    const owner = client.executeBotAction;
    const self = client.selfSlot;
    const p = s.sdk.getState()?.player;
    const life = p?.lifeId;
    const respawns = p?.respawnCount ?? 0;
    return () => {
        const cur = s.sdk.getState()?.player;
        return (
            !!p
            && typeof owner === 'function'
            && s.client === client
            && client.executeBotAction === owner
            && client.selfSlot === self
            && !!cur
            && !cur.isDead
            && cur.lifeId === life
            && (cur.respawnCount ?? 0) === respawns
        );
    };
}

export async function runShadeTrips(original: CombatSession, value: ShadeJob, requestStop: () => boolean = () => false, deps: ShadeDeps = {}) {
    const eatHold = holdSessionEater(original.sdk);
    try {
        const origSess = original as Session;
        const j = validateShadeJob(value);
        const nature = questFlags(original.client)?.find(q => q.name === 'Nature Spirit');
        if (!nature || !['started', 'complete'].includes(nature.state)) {
            throw Error('Shade Mort Myre route requires observed Nature Spirit started or complete; acquire through quest-druidspirit before this trip');
        }
        const start = original.tick();
        const client = original.client as any;
        const executor = client.executeBotAction;
        const selfSlot = client.selfSlot;
        const first = original.sdk.getState()?.player;
        const life = first?.lifeId;
        const respawns = first?.respawnCount ?? 0;
        const hp0 = original.sdk.getSkill('Hitpoints')?.level ?? 0;
        let ended = false;
        let returning = false;
        let inside = false;
        let entryAttempted = false;
        let entryCursor = -1;
        let entryRefused = false;
        let exitAttempted = false;
        let uncertain = false;
        let baseline: Record<number, number> | undefined;
        let bankGeneration = -1;
        let completed = 0;
        let failure = '';
        let bankResult: any;
        let controlsRestored = false;
        void original.ended.then(() => {
            ended = true;
        });
        const state = () => original.sdk.getState();
        const hp = () => original.sdk.getSkill('Hitpoints')?.level ?? 0;
        const inv = () => original.sdk.getInventory();
        const gear = () => original.sdk.getEquipment();
        const count = (id: number) => inv().filter(i => i.id === id).reduce((v, i) => v + i.count, 0);
        const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
        const skillXp = (name: string) => original.sdk.getSkillXp(name) ?? 0;
        const xpView = () => Object.fromEntries((state()?.skills ?? []).map(i => [i.name, i.experience]));
        const xp0 = xpView();
        const controls = () => ({ style: state()?.combatStyle?.currentStyle, retaliate: state()?.autoRetaliateEnabled, prayers: state()?.prayers.activePrayers });
        const controls0 = structuredClone(controls());
        const key0 = () => count(SHADE_ROUTE.key);
        const lootReceipts: any[] = [];
        const combatReceipts: any[] = [];
        const damageCredits: number[] = [];
        const ownContext = shadeOwnContext(original);
        const alive = () => !ended && ownContext() && hp() > 0 && original.sdk.getStateAge() <= 5000;
        const fatal = () => !alive() || hp() < 35 || original.tick() - start >= j.cap - 25;
        const stopped = () => fatal() || (!returning && (uncertain || shadeStopRequested(original.name, requestStop) || original.tick() - start >= j.cap - j.returnTicks || hp() < hp0));
        const at = (p: { x: number; z: number; level: number }, r = 0) => {
            const me = state()?.player;
            return !!me && me.level === p.level && Math.max(Math.abs(me.worldX - p.x), Math.abs(me.worldZ - p.z)) <= r;
        };
        if (
            !first
            || !Number.isSafeInteger(life)
            || typeof executor !== 'function'
            || !Number.isSafeInteger(client.selfSlot)
            || client.membersAccount !== 1
            || hp0 < 90
            || (original.sdk.getSkill('Prayer')?.baseLevel ?? 0) < 43
            || (original.sdk.getSkill('Attack')?.baseLevel ?? 0) < 40
            || !at(SHADE_ROUTE.bank, 3)
            || controls0.retaliate !== false
            || !state()?.combatStyle?.known
            || !Array.isArray(controls0.prayers)
            || controls0.prayers.some(Boolean)
        ) {
            throw Error('Shade needs observed member bank, original HP90, Prayer43, retaliation off and known all-off controls');
        }
        let foodRot = 0;
        let pouchUsed = 0;
        let pouchEmpties = 0;
        type PouchReceipt = { tick: number; message: number; before: number; after: number; empty: boolean; index: number; morphed: boolean };
        const rotReceipts: { tick: number; slot: number; message: number }[] = [];
        const pouchReceipts: PouchReceipt[] = [];
        const pouchReturnReserve = Math.ceil(j.returnTicks / 26) + 1;
        let pouchPending: { native: unknown; until: number; receipt: PouchReceipt } | undefined;
        let care: ReturnType<typeof createPotionCareSession> | undefined;
        let polling = false;
        let pendingCare: Promise<void> | undefined;
        let careAt = 0;
        let lastDoseSettled = -1;
        const careSessions: ReturnType<typeof createPotionCareSession>[] = [];
        const careDoses = () => careSessions.reduce((v, c) => v + c.doses, 0);
        const careBlocked = () => careSessions.some(c => c.blocked);
        const prayerEffect = potionCareRecipe(2434).effects.find(e => e.skill === 'Prayer')!;
        const prayerBase = original.sdk.getSkill('Prayer')?.baseLevel ?? 0;
        const prayerRestore = Math.min(prayerEffect.constant + Math.floor((prayerBase * prayerEffect.percent) / 100), Math.max(0, prayerBase - 39));
        const returnFunded = (extraTicks = 0) => {
            const active = state()?.prayers.activePrayers ?? [];
            const points = state()?.prayers.prayerPoints ?? 0;
            const heldDoses = [2434, 139, 141, 143].reduce((v, id, i) => v + count(id) * (4 - i), 0);
            const doses = Math.min(heldDoses, Math.max(0, j.maximumDoses - careDoses()));
            return active.length === 15 && points + doses * prayerRestore >= combatPrayerLoss(active, j.returnTicks + extraTicks) + 2;
        };
        const renewCare = () => {
            if (careBlocked() || polling || original.tick() < lastDoseSettled) throw Error('Shade prior care not known settled');
            const remaining = j.maximumDoses - careDoses();
            if (remaining <= 0) {
                care = undefined;
                return;
            }
            care = createPotionCareSession(
                careSession,
                { policies: [{ id: 2434, below: 40 }], maximumDoses: remaining, maximumVials: 0, cap: 1000 },
                () => alive() && hp() >= (returning ? 35 : hp0) && gear().some(i => i.id === 1289 && i.slot === 3),
                () => fatal() || (!returning && shadeStopRequested(original.name, requestStop)),
                undefined,
                (skill, elapsed) => (skill === 'Prayer' ? combatPrayerLoss(state()?.prayers.activePrayers ?? [], elapsed) : Math.ceil((elapsed + 1) / 100)),
            );
            careSessions.push(care);
            careAt = original.tick();
        };
        let combatHitPending = false;
        let combatHitUnknown = false;
        const firstHitReceipts: any[] = [];
        const morphResumeReceipts: any[] = [];
        const setupReceipts: any[] = [];
        const guard = (kind = '', args: unknown[] = []) => {
            if (combatHitPending || combatHitUnknown) throw Error('Shade first hit phase unresolved');
            const action = args[0] as any;
            if (
                pouchPending
                && (/Withdraw|UseItem|InteractNpc/.test(kind) || (kind === 'sendAction' && ['bankWithdraw', 'useInventoryItem', 'attackNpc', 'interactNpc'].includes(action?.type)))
            ) {
                throw Error('Shade pouch morph pending before new paid input');
            }
            if (
                !returning
                && stopped()
                && (/Withdraw|UseItem|InteractNpc/.test(kind) || (kind === 'sendAction' && ['bankWithdraw', 'useInventoryItem', 'attackNpc'].includes(action?.type)))
            ) {
                throw Error('Shade stop before new owned input');
            }
            if (fatal() || (uncertain && !(returning && ['sendWalk', 'sendInteractLoc', 'sendCloseModal', 'walk', 'walkTo', 'interactLoc'].includes(kind)))) {
                throw Error('Shade original input owner/life or uncertain input');
            }
        };
        const poll = (): Promise<void> => {
            if (pendingCare) return pendingCare;
            const task = (async () => {
                if (fatal()) throw Error('Shade original life/HP/return cap');
                if (pouchPending) {
                    await waitUntil(original, () => fatal() || !pouchPending || uncertain, { timeoutTicks: 2 });
                    if (pouchPending) uncertain = true;
                }
                if (returning && careBlocked()) {
                    if ((state()?.prayers.prayerPoints ?? 0) < 20) throw Error('Shade uncertain potion lacks safe exit prayer');
                    return;
                }
                if (stopped()) throw Error('Shade care/route stopped');
                if (!returning && !at(SHADE_ROUTE.bank, 3) && !returnFunded()) throw Error('Shade prayer return reserve reached');
                if (!returning && !at(SHADE_ROUTE.bank, 3) && count(2958) <= pouchReturnReserve) throw Error('Shade pouch return reserve reached; no new production');
                if (care && original.tick() - careAt >= 988) renewCare();
                polling = true;
                try {
                    const before = careDoses();
                    await care?.poll();
                    if (careDoses() > before) lastDoseSettled = original.tick();
                    if (careBlocked()) uncertain = true;
                    if ((state()?.prayers.prayerPoints ?? 0) < 20 && !at(SHADE_ROUTE.bank, 3)) throw Error('Shade declared prayer supply exhausted');
                } finally {
                    polling = false;
                }
            })();
            pendingCare = task;
            return task.finally(() => {
                if (pendingCare === task) pendingCare = undefined;
            });
        };
        let entryDispatch: { valid: () => boolean; attempt: () => void } | undefined;
        let attackDispatch: (() => boolean) | undefined;
        const sdk = new Proxy(original.sdk, {
            get(t, k, r) {
                const v = Reflect.get(t, k, r);
                if (typeof v !== 'function') return v;
                if (k === 'send') {
                    return function (...a: unknown[]) {
                        if (pendingCare) throw Error('Shade care pending at final dispatch');
                        guard(String(k), a);
                        if (attackDispatch && (a[0] as any)?.type === 'interactNpc' && !attackDispatch()) throw Error('Shade original attack dispatch changed');
                        if (entryDispatch && (a[0] as any)?.type === 'interactLoc' && !entryDispatch.valid()) throw Error('Shade entry stand changed at final dispatch');
                        return v.apply(r, a);
                    };
                }
                return function (...a: unknown[]) {
                    if (typeof k === 'string' && k.startsWith('send')) {
                        return (async () => {
                            await poll();
                            guard(k, a);
                            if (k === 'sendInteractNpc' && attackDispatch && !attackDispatch()) throw Error('Shade original attack dispatch changed');
                            if (k === 'sendInteractLoc' && entryDispatch) {
                                if (!entryDispatch.valid()) throw Error('Shade entry stand changed during care settlement');
                                entryDispatch.attempt();
                            }
                            return v.apply(r, a);
                        })();
                    }
                    return v.apply(r, a);
                };
            },
        });
        const s = Object.create(original) as Session;
        const careSession = Object.create(original) as CombatSession;
        Object.defineProperty(careSession, 'direct', {
            value: async (a: any) => {
                guard(a?.type);
                const row = inv().find(i => i.slot === a?.slot);
                if (!polling || a?.type !== 'useInventoryItem' || a.optionIndex !== 1 || !row || ![2434, 139, 141, 143].includes(row.id)) {
                    throw Error('Shade private care input not declared');
                }
                return original.direct(a);
            },
        });
        Object.defineProperties(s, {
            sdk: { value: sdk },
            bot: { value: new BotActions(sdk) },
            direct: {
                value: async (a: any) => {
                    await poll();
                    guard(a?.type);
                    return original.direct(a);
                },
            },
        });
        const rotFrame = (): GhastFrame => {
            const p = state()?.player;
            return {
                tick: original.tick(),
                x: p?.worldX ?? NaN,
                z: p?.worldZ ?? NaN,
                level: p?.level ?? -1,
                isolated: state()?.nearbyPlayers.length === 0,
                original: alive(),
                ghosts: (state()?.nearbyNpcs ?? []).filter(n => [1052, 1053].includes(n.id)).map(n => ({ ...n, native: client.npc?.[n.index], nativeType: client.npc?.[n.index]?.type?.id })),
            };
        };
        const rotSnapshot = () => ({
            frame: rotFrame(),
            pack: inv().map(i => ({ ...i })),
            hp: hp(),
            xp: JSON.stringify(state()?.skills?.map(i => i.experience)),
            gear: JSON.stringify(gear()),
            tick: original.tick(),
            cursor: Math.max(-1, ...(state()?.gameMessages ?? []).map(m => m.observationId ?? -1)),
        });
        let priorRot = rotSnapshot();
        const observeRot = () => {
            const cur = rotSnapshot();
            if (pouchPending) {
                const n = cur.frame.ghosts.find(row => row.index === pouchPending!.receipt.index);
                if (n && n.native === pouchPending.native && n.id === 1053 && n.nativeType === 1053 && (n.targetIndex === -1 || n.targetIndex === 32768 + selfSlot)) {
                    pouchPending.receipt.morphed = true;
                    pouchPending = undefined;
                } else if (original.tick() > pouchPending.until || (n && (n.native !== pouchPending.native || (n.targetIndex !== -1 && n.targetIndex !== 32768 + selfSlot)))) {
                    uncertain = true;
                }
            }
            const totalRot = (rows: readonly { id: number; count: number }[]) => rows.filter(i => i.id === 2959).reduce((v, i) => v + i.count, 0);
            if (totalRot(cur.pack) !== totalRot(priorRot.pack) && !state()?.bank.isOpen) {
                const p = state()?.player;
                const message = state()?.gameMessages.find(
                    m =>
                        m.type === 0
                        && m.sender === ''
                        && m.fromSelf === false
                        && Number.isSafeInteger(m.observationId)
                        && m.observationId! > priorRot.cursor
                        && m.tick >= priorRot.tick
                        && m.tick <= original.tick()
                        && m.text === 'You feel something attacking your backpack, and smell a terrible stench.',
                );
                const ghost = state()?.nearbyNpcs.some(n => n.id === 1052 && n.distance <= 1 && n.animId === 1093 && client.npc?.[n.index]?.type?.id === 1052);
                const valid = guardianFoodRotEffect(priorRot.pack, cur.pack, {
                    freshSystem: !!message,
                    nativeGhast: !!ghost || shadeMovingGhastWitness(priorRot.frame, cur.frame, 32768 + selfSlot),
                    sameHpXpGear: cur.hp === priorRot.hp && cur.xp === priorRot.xp && cur.gear === priorRot.gear,
                    sameLifeOwner: alive() && !!p && guardianSwampPoint({ x: p.worldX, z: p.worldZ, level: p.level }) && !state()?.nearbyPlayers.length,
                });
                if (!valid || foodRot >= j.target * j.foodPerKill) uncertain = true;
                else {
                    const row = cur.pack.find(i => i.id === 2959 && !priorRot.pack.some(b => b.slot === i.slot && b.id === 2959));
                    if (!row) uncertain = true;
                    else {
                        foodRot++;
                        rotReceipts.push({ tick: original.tick(), slot: row.slot, message: message!.observationId! });
                    }
                }
            }
            if (!state()?.bank.isOpen) {
                const total = (rows: typeof cur.pack, id: number) => rows.filter(r => r.id === id).reduce((v, r) => v + r.count, 0);
                const before = total(priorRot.pack, 2958);
                const after = total(cur.pack, 2958);
                if (before !== after) {
                    const message = state()?.gameMessages.find(
                        m =>
                            m.type === 0
                            && m.sender === ''
                            && m.fromSelf === false
                            && Number.isSafeInteger(m.observationId)
                            && m.observationId! > priorRot.cursor
                            && m.tick >= priorRot.tick
                            && m.tick <= original.tick()
                            && m.text === 'The druid pouch makes the Ghast visible.',
                    );
                    const valid = shadePouchEffect(priorRot.pack, cur.pack, {
                        fresh: !!message,
                        ghast: shadePouchGhastWitness(priorRot.frame, cur.frame, 32768 + selfSlot),
                        quiet: alive() && cur.hp === priorRot.hp && cur.xp === priorRot.xp && cur.gear === priorRot.gear,
                    });
                    if (!valid || pouchUsed >= j.target * j.pouchChargesPerTrip) uncertain = true;
                    else {
                        pouchUsed++;
                        const empty = before === 1;
                        if (empty) pouchEmpties++;
                        const n = cur.frame.ghosts.find(g => shadePouchGhastWitness(priorRot.frame, { ...cur.frame, ghosts: [g] }, 32768 + selfSlot))!;
                        const receipt: PouchReceipt = {
                            tick: original.tick(),
                            message: message!.observationId!,
                            before,
                            after,
                            empty,
                            index: n.index,
                            morphed: n.id === 1053,
                        };
                        pouchReceipts.push(receipt);
                        if (!receipt.morphed) pouchPending = { native: n.native, until: original.tick() + 2, receipt };
                    }
                }
            }
            priorRot = cur;
        };
        const offRot = original.onTick(observeRot);
        const canonical = (rows: readonly { id: number; count: number }[]) => {
            const out: Record<number, number> = {};
            for (const i of rows) {
                const t = client.objType?.(i.id);
                if (!t || !Number.isSafeInteger(t.certtemplate)) throw Error('Shade native item metadata unknown');
                const id = t.certtemplate >= 0 ? t.certlink : i.id;
                out[id] = (out[id] ?? 0) + i.count;
            }
            return out;
        };
        const open = async () => {
            if (fatal() || !at(SHADE_ROUTE.bank, 3)) throw Error('Shade fresh bank site/life unavailable');
            bankGeneration = Math.max(bankGeneration, s.bankObservation?.()?.generation ?? -1);
            await s.sdk.sendCloseModal();
            if (!(await waitUntil(s, () => fatal() || (!state()?.bank.isOpen && !state()?.interface.isOpen && !state()?.dialog.isOpen), { timeoutTicks: 8 })) || fatal()) {
                throw Error('Shade bank closure unconfirmed');
            }
            await s.bot.openBank();
            if (
                !(await waitUntil(s, () => fatal() || (!!state()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > bankGeneration), { timeoutTicks: 12 }))
                || fatal()
                || !state()?.bank.isOpen
                || !s.bankObservation?.()
            ) {
                throw Error('Shade fresh bank unobserved');
            }
            bankGeneration = s.bankObservation!()!.generation;
        };
        const all = () => {
            const b = s.bankObservation?.();
            if (!state()?.bank.isOpen || !b) throw Error('Shade current bank ledger unavailable');
            return canonical([...inv(), ...gear(), ...b.items]);
        };
        const protection = async (on: boolean) => {
            if (fatal() || (on && stopped())) throw Error('Shade prayer original life/budget unavailable');
            if (s.sdk.isPrayerActive(14) === on) return;
            let reply: any;
            try {
                reply = await s.sdk.sendTogglePrayer(14);
            } catch (e) {
                reply = e;
            }
            if (!(await waitUntil(s, () => !alive() || s.sdk.isPrayerActive(14) === on, { timeoutTicks: 8 })) || !alive() || s.sdk.isPrayerActive(14) !== on) {
                uncertain = true;
                throw Error('Shade prayer transition unknown ' + String(reply));
            }
        };
        const walker = async () => {
            const d = await (deps.walker ?? sessionWalker)(s);
            if (deps.walker || !inside || key0() !== 1) return d;
            const pf = await import('../../../../vendor/rs-sdk/sdk/pathfinding');
            const grid = await import('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
            const doors = JSON.parse(readFileSync(resolve(ROOT, 'knowledge/doors.json'), 'utf8')) as { id: number; x: number; z: number; level: number }[];
            const allowed = new Set(
                doors
                    .filter(v => [4106, 4107, 4108, 4109].includes(v.id) && v.level === 0 && v.x >= 3450 && v.x <= 3510 && v.z >= 9690 && v.z <= 9730)
                    .map(v => `${v.level}:${v.x}:${v.z}`),
            );
            return {
                ...d,
                plan: (level: number, from: { x: number; z: number }, to: { x: number; z: number }) => {
                    pf.initPathfinding();
                    const temporary = doors.flatMap(v => {
                        if (!s.sdk.isDoorTemporarilyBlocked(v.level, v.x, v.z)) return [];
                        const info = pf.getDoorAt(v.level, v.x, v.z);
                        return info ? [info] : [];
                    });
                    const blocks = applyKnownDoorBlocks(s.sdk, level, from, to)
                        .filter(b => !allowed.has(`${b.level}:${b.x}:${b.z}`))
                        .map(b => (b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b));
                    return withDoorPolicy(grid, blocks, () => pf.findLongPath(level, from.x, from.z, to.x, to.z, 500, temporary));
                },
            } as PathDeps;
        };
        const walk = async (to: { x: number; z: number; level: number }, budget: number) => {
            if (stopped()) throw Error('Shade route stopped');
            await poll();
            const d = await walker();
            const from = d.pos();
            if (!from) throw Error('Shade route observation absent');
            const path = d.plan(from.level, from, to);
            const end = path.at(-1) ?? from;
            if (end.x !== to.x || end.z !== to.z) throw Error(`Shade complete native route unavailable ${from.x},${from.z}->${to.x},${to.z}`);
            const r = await walkPath(d, [{ ...to, tol: 0 }], {
                maxTicks: Math.min(budget, j.cap - 25 - (original.tick() - start)),
                stop: () => stopped() || (!returning && !returnFunded()),
            });
            if (!r.ok || stopped() || !at(to)) throw Error('Shade exact route ' + r.detail);
        };
        const cursor = () => Math.max(-1, ...(state()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
        const fresh = (c: number, re: RegExp) =>
            (state()?.gameMessages ?? []).some(m => m.type === 0 && !m.sender && !m.fromSelf && (m.observationId ?? m.tick) > c && re.test(m.text));
        let entryStockValid = () => false;
        const entryReceipts: any[] = [];
        const entryRefusal = /^(?:The door seems locked(?:\.|$)|I can't reach that!$)/;
        const received = () => {
            const p = client.localPlayer;
            return { x: client.mapBuildBaseX + p?.routeX?.[0], z: client.mapBuildBaseZ + p?.routeZ?.[0], level: client.minusedlevel, routeLength: p?.routeLength };
        };
        const entry = async () => {
            const leaves =
                state()?.nearbyLocs.filter(
                    l => ((l.id === 4133 && l.x === 3484) || (l.id === 4132 && l.x === 3485)) && l.z === 3320 && l.level === 0 && l.optionsWithIndex.some(o => o.opIndex === 1),
                ) ?? [];
            const l = leaves.find(row => row.id === 4132) ?? leaves.find(row => row.id === 4133);
            if (!l || key0() !== 1 || stopped()) throw Error('Shade exact native entry/key unavailable');
            const stand = { x: l.x, z: 3322, level: 0 };
            const began = original.tick();
            const receipt = {
                kind: 'SHADE_ENTRY',
                leaf: { id: l.id, x: l.x, z: l.z },
                stand,
                before: received(),
                attempted: false,
                outcome: 'approach',
                received: received(),
                freshStandFrames: 0,
                settledAt: -1,
            };
            entryReceipts.push(receipt);
            await walk(stand, 40);
            const coherent = () => {
                const h = received();
                return at(stand) && h.x === stand.x && h.z === stand.z && h.level === 0;
            };
            if (original.tick() - began >= 38 || stopped()) throw Error('Shade entry approach budget/stop');
            await s.sdk.sendWalk(stand.x, stand.z);
            let last = state()?.tick;
            let stable = 0;
            const settled = () => {
                const tick = state()?.tick;
                if (!coherent()) {
                    stable = 0;
                    last = tick;
                    return false;
                }
                if (Number.isSafeInteger(tick) && Number.isSafeInteger(last) && tick! > last!) {
                    stable++;
                    last = tick;
                }
                return stable >= 2;
            };
            if (!(await waitUntil(s, () => stopped() || settled(), { timeoutTicks: 40 - (original.tick() - began) })) || stopped() || !coherent()) {
                receipt.received = received();
                receipt.outcome = 'unsettled';
                throw Error('Shade native received entry stand unconfirmed');
            }
            receipt.freshStandFrames = stable;
            receipt.settledAt = last!;
            if (!state()?.nearbyLocs.some(v => v.id === l.id && v.x === l.x && v.z === l.z && v.level === 0 && v.optionsWithIndex.some(o => o.opIndex === 1)) || key0() !== 1 || stopped()) {
                throw Error('Shade native entry approach changed');
            }
            receipt.received = received();
            const stock = JSON.stringify(canonical(inv()));
            const worn = JSON.stringify(canonical(gear()));
            const xp = JSON.stringify(xpView());
            entryStockValid = () =>
                key0() === 1
                && !fatal()
                && !uncertain
                && !pouchPending
                && !careBlocked()
                && JSON.stringify(canonical(inv())) === stock
                && JSON.stringify(canonical(gear())) === worn
                && JSON.stringify(xpView()) === xp;
            const c = cursor();
            entryCursor = c;
            entryRefused = false;
            entryDispatch = {
                valid: () => coherent() && !stopped() && key0() === 1 && !!state()?.nearbyLocs.some(v => v.id === l.id && v.x === l.x && v.z === l.z && v.level === 0),
                attempt: () => {
                    entryAttempted = true;
                    receipt.attempted = true;
                },
            };
            try {
                await s.sdk.sendInteractLoc(l.x, l.z, l.id, 1);
            } catch {
                // Entry waits for arrival or explicit lock refusal below.
            } finally {
                entryDispatch = undefined;
            }
            if (!entryAttempted) {
                receipt.outcome = 'pre-dispatch-refused';
                throw Error('Shade entry stand changed before dispatch');
            }
            const arrived = await waitUntil(s, () => fatal() || at(SHADE_ROUTE.landing) || fresh(c, entryRefusal), { timeoutTicks: 16 });
            entryRefused = fresh(c, entryRefusal) && entryStockValid();
            if (entryRefused) entryAttempted = false;
            if (at(SHADE_ROUTE.landing)) inside = true;
            receipt.outcome = inside ? 'arrived' : entryRefused ? 'refused' : 'unknown';
            if (!arrived || fatal() || !inside || key0() !== 1) throw Error('Shade native quest/unlock/entry refused or unobserved; no retry');
            entryAttempted = false;
            exitAttempted = false;
        };
        const leave = async () => {
            returning = true;
            if (combatHitPending || combatHitUnknown) throw Error('Shade first hit unresolved; no cleanup input');
            if (exitAttempted) {
                if (at(SHADE_ROUTE.surface) && key0() === 1) {
                    inside = false;
                    entryAttempted = false;
                    return;
                }
                throw Error('Shade prior exit outcome unresolved; no repeated exit');
            }
            if (!inside && entryAttempted) {
                await waitUntil(s, () => fatal() || at(SHADE_ROUTE.landing) || fresh(entryCursor, entryRefusal), { timeoutTicks: 8 });
                inside = at(SHADE_ROUTE.landing);
                entryRefused = fresh(entryCursor, entryRefusal) && entryStockValid();
                if (!inside && !entryRefused) throw Error('Shade uncertain entry outcome; outside is not refusal, no bank fallback');
                if (entryRefused) entryAttempted = false;
            }
            if (!inside) return;
            await walk(SHADE_ROUTE.landing, 180);
            const l = state()?.nearbyLocs.find(row => row.id === 4106 && row.x === SHADE_ROUTE.exit.x && row.z === SHADE_ROUTE.exit.z && row.optionsWithIndex.some(o => o.opIndex === 1));
            if (!l || fatal()) throw Error('Shade exact bronze exit unavailable');
            exitAttempted = true;
            try {
                await s.sdk.sendInteractLoc(l.x, l.z, l.id, 1);
            } catch {}
            if (!(await waitUntil(s, () => fatal() || at(SHADE_ROUTE.surface), { timeoutTicks: 16 })) || fatal() || !at(SHADE_ROUTE.surface) || key0() !== 1) {
                throw Error('Shade native surface return unobserved');
            }
            inside = false;
            entryAttempted = false;
        };
        const kill = async (cap: number) => {
            await walk(SHADE_ROUTE.hunt, 100);
            await poll();
            if (stopped() || !s.sdk.isPrayerActive(14)) throw Error('Shade protection/site unavailable');
            const setupStart = original.tick();
            const setup = {
                began: setupStart,
                anchor: undefined as number | undefined,
                walk: undefined as { x: number; z: number } | undefined,
                selected: undefined as number | undefined,
                frames: 0,
                ended: -1,
            };
            setupReceipts.push(setup);
            const initialGearForSetup = gear().map(i => ({ id: i.id, slot: i.slot, count: i.count }));
            const setupSafe = () =>
                !stopped()
                && !state()?.nearbyPlayers.length
                && s.sdk.isPrayerActive(14)
                && returnFunded()
                && same(gear().map(i => ({ id: i.id, slot: i.slot, count: i.count })), initialGearForSetup);
            const eligible = () =>
                state()?.nearbyNpcs.filter(
                    row =>
                        [1249, 1250].includes(row.id)
                        && (row.hp === null || row.hp === 110)
                        && (row.maxHp == null || row.maxHp === 110)
                        && row.reachable !== false
                        && row.distance <= 8
                        && (!row.inCombat || row.targetIndex === 32768 + selfSlot)
                        && row.optionsWithIndex.some(o => /^attack$/i.test(o.text)),
                ) ?? [];
            const incoming = () =>
                eligible()
                    .filter(row => row.id === 1250 && row.targetIndex === 32768 + selfSlot && client.npc?.[row.index]?.type?.id === 1250)
                    .sort((a, b) => a.distance - b.distance);
            if (!setupSafe()) throw Error('Shade incoming setup life/peer/protection/funding unavailable');
            if (!incoming().length) {
                const anchor = eligible()
                    .filter(row => row.id === 1249 && row.targetIndex === -1 && client.npc?.[row.index]?.type?.id === 1249)
                    .sort((a, b) => a.distance - b.distance)[0];
                if (!anchor) throw Error('Shade no original shadow anchor for incoming setup');
                setup.anchor = anchor.index;
                const x = anchor.tileX ?? anchor.x;
                const z = anchor.tileZ ?? anchor.z;
                const d = await walker();
                const from = d.pos();
                if (!from || !setupSafe()) throw Error('Shade incoming approach context lost');
                const occupied = (tx: number, tz: number) =>
                    (state()?.nearbyNpcs ?? []).some(row => {
                        const nx = row.tileX ?? row.x;
                        const nz = row.tileZ ?? row.z;
                        const size = row.size ?? 1;
                        return tx >= nx && tx < nx + size && tz >= nz && tz < nz + size;
                    });
                const goals = [{ x: x - 1, z }, { x: x + 1, z }, { x, z: z - 1 }, { x, z: z + 1 }]
                    .flatMap(to => {
                        if (occupied(to.x, to.z) || (to.x === from.x && to.z === from.z)) return [];
                        const path = d.plan(0, from, to);
                        const end = path.at(-1) ?? from;
                        if (end.x !== to.x || end.z !== to.z) return [];
                        return [{ ...to, cost: path.reduce((v, p, i) => v + Math.max(Math.abs(p.x - (i ? path[i - 1]!.x : from.x)), Math.abs(p.z - (i ? path[i - 1]!.z : from.z))), 0) }];
                    })
                    .sort((a, b) => a.cost - b.cost);
                const goal = goals[0];
                if (!goal) throw Error('Shade incoming anchor lacks complete legal adjacent path');
                setup.walk = { x: goal.x, z: goal.z };
                await walk({ ...setup.walk, level: 0 }, Math.max(1, 38 - (original.tick() - setupStart)));
            }
            let lastFrame = state()?.tick;
            let n: ReturnType<typeof incoming>[number] | undefined;
            const stable = new Map<number, { native: unknown; frames: number }>();
            while (original.tick() - setupStart < SHADE_INCOMING_TICKS) {
                if (!setupSafe()) throw Error('Shade incoming setup life/peer/protection/funding changed');
                const tick = state()?.tick;
                if (Number.isSafeInteger(tick) && Number.isSafeInteger(lastFrame) && tick! > lastFrame!) {
                    lastFrame = tick;
                    const candidates = incoming();
                    const present = new Set(candidates.map(row => row.index));
                    for (const idx of stable.keys()) if (!present.has(idx)) stable.delete(idx);
                    for (const row of candidates) {
                        const native = client.npc?.[row.index];
                        const old = stable.get(row.index);
                        const frames = old && old.native === native ? old.frames + 1 : 1;
                        stable.set(row.index, { native, frames });
                        if (frames >= 2 && !n) {
                            n = row;
                            setup.selected = row.index;
                            setup.frames = frames;
                        }
                    }
                    if (n) break;
                }
                await poll();
                await waitTicks(s, 1);
            }
            setup.ended = original.tick();
            if (!n || !setupSafe()) throw Error('Shade no stable owned incoming target within' + SHADE_INCOMING_TICKS + 'ticks');
            const native = client.npc?.[n.index];
            if (!native || native.type?.id !== 1250 || n.targetIndex !== 32768 + selfSlot) {
                throw Error('Shade received stable incoming NPC identity absent');
            }
            if (!returnFunded()) throw Error('Shade combat lacks funded return');
            const initialId = n.id;
            const index = n.index;
            const began = original.tick();
            const skills = ['Attack', 'Strength', 'Defence'];
            const before = skills.map(skillXp);
            const hpXp = skillXp('Hitpoints');
            const combat = state()?.combatStyle;
            const style = combat?.styles.find(v => v.index === combat?.currentStyle);
            const trained = style?.trainsSkills;
            if (!trained || trained.length !== 1 || !skills.includes(trained[0]!)) throw Error('Shade requires observed single-skill Rune sword style');
            const selected = trained[0]!;
            const xpBefore = skillXp(selected);
            const initialPile = state()?.groundItems.filter(i => i.id === 3404).map(i => `${i.x}:${i.z}:${i.count}`) ?? [];
            let previous = xpBefore;
            let damage = 0;
            let rawHp = 0;
            let corpse = false;
            let gone = false;
            let own = false;
            let pos = { x: n.x, z: n.z };
            let changed = false;
            let problem = '';
            let lastHealth: number | null = n.hp;
            const regenWitnesses: { tick: number; before: number; after: number }[] = [];
            const eventCursor = Math.max(-1, ...(state()?.combatEvents ?? []).map(e => e.observationId ?? -1));
            const combatPack = canonical(inv());
            const combatGear = JSON.stringify(canonical(gear()));
            const careOffset = careSessions.reduce((v, c) => v + c.receipts.length, 0);
            let playerAttackSeen = false;
            let morphResume = false;
            let zeroWitness: number | undefined;
            let lastDamageAt = began;
            const morphReceipts: any[] = [];
            const combatStockKnown = () => {
                const expected = { ...combatPack };
                for (const r of careSessions.flatMap(c => c.receipts).slice(careOffset)) {
                    for (const [id, delta] of Object.entries(r.delta as Record<string, number>)) expected[+id] = (expected[+id] ?? 0) + delta;
                }
                const known = same(canonical(inv()), Object.fromEntries(Object.entries(expected).filter(([, v]) => v !== 0))) && JSON.stringify(canonical(gear())) === combatGear && !careBlocked();
                if (!known) {
                    combatHitUnknown = true;
                    uncertain = true;
                }
                return known;
            };
            let firstHit: { tick: number; xp: number; damage: number; pack: string; gear: string; receipt: any } | undefined;
            const credit = (hit: number) => {
                lastDamageAt = original.tick();
                damage += hit;
                rawHp += Math.floor((hit * 133) / 10) * j.xpRate;
                damageCredits.push(hit);
            };
            const observe = () => {
                const me = state()?.player;
                if (me?.combat?.targetType === 'npc' && me.combat.targetIndex === index) playerAttackSeen = true;
                if (!alive() || state()?.nearbyPlayers.length) {
                    problem = 'Shade life/peer changed';
                    return;
                }
                const v = state()?.nearbyNpcs.find(row => row.index === index);
                if (v) {
                    if (initialId === 1250 && v.id !== 1250) {
                        problem = 'Shade admitted incoming target reverted to Shadow';
                        return;
                    }
                    if (client.npc?.[index] !== native || ![1249, 1250].includes(v.id) || native.type?.id !== v.id) {
                        problem = 'Shade original NPC family/object replaced';
                        return;
                    }
                    if (v.targetIndex !== -1 && v.targetIndex !== 32768 + client.selfSlot) {
                        problem = 'Shade private owner changed';
                        return;
                    }
                    own ||= v.targetIndex === 32768 + client.selfSlot;
                    changed ||= v.id !== initialId;
                    if (initialId === 1249 && playerAttackSeen && v.id === 1250 && v.hp === 110 && v.targetIndex === 32768 + selfSlot && damage === 0) {
                        const event = state()?.combatEvents?.find(
                            e =>
                                e.type === 'damage_dealt'
                                && e.sourceType === 'player'
                                && e.targetType === 'npc'
                                && e.targetIndex === index
                                && e.damage === 0
                                && Number.isSafeInteger(e.observationId)
                                && e.observationId! > eventCursor
                                && e.tick >= began
                                && e.tick <= began + 4,
                        );
                        if (event) zeroWitness = event.observationId;
                    }
                    pos = { x: v.x, z: v.z };
                    if (v.hp !== null && lastHealth !== null && v.hp > lastHealth) {
                        const restored = v.hp - lastHealth;
                        if (regenWitnesses.reduce((sum, w) => sum + w.after - w.before, 0) + restored > Math.ceil((original.tick() - began) / 100) || v.hp > 110) {
                            problem = 'Shade health reset exceeds native regeneration';
                            return;
                        }
                        regenWitnesses.push({ tick: original.tick(), before: lastHealth, after: v.hp });
                    }
                    if (v.hp !== null) lastHealth = v.hp;
                    corpse ||= v.hp === 0 || v.animId === 1287;
                } else if (corpse) {
                    gone = true;
                } else {
                    problem = 'Shade vanished/transformed without corpse';
                }
                const current = skillXp(selected);
                const delta = current - previous;
                if (firstHit) {
                    const age = original.tick() - firstHit.tick;
                    if (
                        !v
                        || current !== firstHit.xp
                        || hp() !== hp0
                        || JSON.stringify(canonical(inv())) !== firstHit.pack
                        || JSON.stringify(canonical(gear())) !== firstHit.gear
                        || skills.some((k, i) => k !== selected && skillXp(k) !== before[i])
                        || age > 2
                    ) {
                        problem = 'Shade first hit phase changed or timed out';
                        return;
                    }
                    if (
                        age >= 1
                        && v.id === 1250
                        && v.targetIndex === 32768 + selfSlot
                        && v.hp === 110 - firstHit.damage
                        && skillXp('Hitpoints') - hpXp >= Math.floor((Math.floor((firstHit.damage * 133) / 10) * j.xpRate) / 10)
                        && skillXp('Hitpoints') - hpXp <= Math.ceil((Math.floor((firstHit.damage * 133) / 10) * j.xpRate) / 10)
                    ) {
                        credit(firstHit.damage);
                        firstHit.receipt.confirmed = true;
                        firstHit.receipt.confirmedAt = original.tick();
                        firstHit = undefined;
                        combatHitPending = false;
                    } else if (age >= 2) {
                        problem = 'Shade first hit ownership/HP confirmation absent';
                    }
                    return;
                }
                if (delta) {
                    const hit = delta / (4 * j.xpRate);
                    if (!Number.isSafeInteger(hit) || hit <= 0 || damage + hit > 110 + Math.ceil((original.tick() - began) / 100)) {
                        problem = 'Shade exact attributed combat XP changed';
                        return;
                    }
                    if (!own) {
                        const player = state()?.player;
                        if (
                            initialId !== 1249
                            || damage !== 0
                            || !v
                            || v.id !== 1249
                            || v.targetIndex !== -1
                            || player?.combat?.targetType !== 'npc'
                            || player.combat.targetIndex !== index
                            || (v.hp !== null && v.hp !== 110)
                        ) {
                            problem = 'Shade first hit lacks original own attack target';
                            return;
                        }
                        const receipt = { index, initialId, tick: original.tick(), damage: hit, xp: delta, confirmed: false };
                        firstHitReceipts.push(receipt);
                        firstHit = { tick: original.tick(), xp: current, damage: hit, pack: JSON.stringify(canonical(inv())), gear: JSON.stringify(canonical(gear())), receipt };
                        combatHitPending = true;
                    } else {
                        credit(hit);
                    }
                    previous = current;
                }
                for (let i = 0; i < skills.length; i++) {
                    if (skills[i] !== selected && skillXp(skills[i]!) !== before[i]) problem = 'Shade foreign melee style XP';
                }
            };
            const off = s.onTick(observe);
            try {
                const option = n.optionsWithIndex.find(o => /^attack$/i.test(o.text))!;
                attackDispatch = () =>
                    !stopped()
                    && client.npc?.[index] === native
                    && native.type?.id === 1250
                    && !!state()?.nearbyNpcs.some(v => v.index === index && v.id === 1250 && v.targetIndex === 32768 + selfSlot)
                    && !state()?.nearbyPlayers.length
                    && combatStockKnown();
                try {
                    await s.sdk.sendInteractNpc(index, option.opIndex);
                } finally {
                    attackDispatch = undefined;
                }
                while (!gone) {
                    observe();
                    if (problem && firstHit) {
                        combatHitUnknown = true;
                        uncertain = true;
                        firstHit.receipt.failure = problem;
                    }
                    if (problem || stopped() || original.tick() - began >= cap) throw Error(problem || 'Shade finite combat stop/cap');
                    if (!s.sdk.isPrayerActive(14)) throw Error('Shade melee protection lost');
                    if (!combatHitPending) {
                        if (!returnFunded()) throw Error('Shade prayer return reserve reached');
                        if (original.tick() - lastDamageAt >= 80) throw Error('Shade no credited damage within80ticks; funded return');
                        const v = state()?.nearbyNpcs.find(row => row.index === index);
                        const me = state()?.player;
                        const phaseKnown = firstHitReceipts.some(r => r.index === index && r.tick >= began && r.confirmed) || zeroWitness !== undefined;
                        if (
                            !morphResume
                            && initialId === 1249
                            && changed
                            && own
                            && phaseKnown
                            && playerAttackSeen
                            && v?.id === 1250
                            && v.hp !== 0
                            && v.targetIndex === 32768 + selfSlot
                            && me?.combat?.targetType === 'none'
                            && me.combat.targetIndex === -1
                        ) {
                            if (!combatStockKnown()) {
                                combatHitUnknown = true;
                                uncertain = true;
                                throw Error('Shade morph resume stock/gear unknown');
                            }
                            await poll();
                            const current = state()?.nearbyNpcs.find(row => row.index === index);
                            const p = state()?.player;
                            if (
                                stopped()
                                || client.npc?.[index] !== native
                                || native.type?.id !== 1250
                                || current?.id !== 1250
                                || current.targetIndex !== 32768 + selfSlot
                                || p?.combat?.targetType !== 'none'
                                || p.combat.targetIndex !== -1
                            ) {
                                throw Error('Shade morph resume context changed');
                            }
                            attackDispatch = () => {
                                const player = state()?.player;
                                const curNpc = state()?.nearbyNpcs.find(row => row.index === index);
                                return (
                                    !stopped()
                                    && client.npc?.[index] === native
                                    && native.type?.id === 1250
                                    && curNpc?.id === 1250
                                    && curNpc.targetIndex === 32768 + selfSlot
                                    && player?.combat?.targetType === 'none'
                                    && player.combat.targetIndex === -1
                                    && !state()?.nearbyPlayers.length
                                    && returnFunded()
                                    && combatStockKnown()
                                );
                            };
                            morphResume = true;
                            const resumeReceipt = {
                                tick: original.tick(),
                                index,
                                zeroHitObservation: zeroWitness,
                                kind: zeroWitness !== undefined ? 'confirmed-zero' : 'confirmed-positive',
                            };
                            morphReceipts.push(resumeReceipt);
                            morphResumeReceipts.push(resumeReceipt);
                            try {
                                await s.sdk.sendInteractNpc(index, option.opIndex);
                            } finally {
                                attackDispatch = undefined;
                            }
                        } else {
                            await poll();
                        }
                    }
                    await waitTicks(s, 1);
                }
                if (
                    !shadeDeathReceipt({
                        sameNative: !problem,
                        id: n.id,
                        owner: own ? 32768 + client.selfSlot : undefined,
                        self: client.selfSlot,
                        hp: 0,
                        anim: 1287,
                        gone,
                        damage,
                        corpseWitness: corpse,
                        regenOpportunities: Math.ceil((original.tick() - began) / 100),
                    })
                ) {
                    throw Error('Shade transform is not an attributed kill');
                }
                if (
                    !(await waitUntil(
                        s,
                        () => stopped() || !!state()?.groundItems.some(i => i.id === 3404 && i.x === pos.x && i.z === pos.z && i.count === 1 && !initialPile.includes(`${i.x}:${i.z}:${i.count}`)),
                        { timeoutTicks: 12 },
                    ))
                    || stopped()
                ) {
                    throw Error('Shade fresh exact remains pile unavailable');
                }
                const pile = state()!.groundItems.filter(i => i.id === 3404 && i.x === pos.x && i.z === pos.z);
                if (pile.length !== 1 || pile[0]!.count !== 1) throw Error('Shade ambiguous remains pile');
                const r = await runVisibleGroundLoot(
                    {
                        state: () => {
                            const st = state();
                            return st ? { ...st, groundItems: st.groundItems.filter(i => i.id === 3404 && i.x === pos.x && i.z === pos.z && i.count === 1) } : null;
                        },
                        tick: () => original.tick(),
                        stop: () => fatal() || hp() !== hp0,
                        definition: id => {
                            const t = client.objType(id);
                            return t && { cost: t.cost, stackable: t.stackable };
                        },
                        pickup: async i => {
                            if (stopped()) throw Error('Shade stopped before remains pickup');
                            return (await s.sdk.sendPickup(i.x, i.z, i.id)).success;
                        },
                        wait: (pred, ticks) => waitUntil(s, pred, { timeoutTicks: ticks }),
                        step: () => waitTicks(s, 1),
                        clearModal: async () => {
                            await s.sdk.sendCloseModal();
                        },
                    },
                    { mode: 'list', ids: [3404], names: [], minimumValue: 0, maximumValue: 2147483647, radius: 12, maximumUnits: 1, cap: 30, idleTicks: 12 },
                );
                lootReceipts.push(r);
                combatReceipts.push({
                    index,
                    initialId,
                    morphReceipts,
                    transformed: changed,
                    corpse,
                    gone,
                    damage,
                    fightTicks: original.tick() - began,
                    regenOpportunities: Math.ceil((original.tick() - began) / 100),
                    regenWitnesses,
                    selected,
                    xp: skillXp(selected) - xpBefore,
                    expectedRawHpXp: rawHp,
                    publicHpXp: skillXp('Hitpoints') - hpXp,
                    position: pos,
                });
                return 1;
            } finally {
                off();
            }
        };
        try {
            if (stopped()) throw Error('Shade stopped before owned bank input');
            await open();
            baseline = all();
            if (
                (baseline[3465] ?? 0) < 1
                || (baseline[2963] ?? 0) < 1
                || (baseline[379] ?? 0) < j.target * j.foodPerKill + j.reserve
                || (baseline[2434] ?? 0) < j.target * j.potionsPerKill + j.reserve
                || (baseline[2958] ?? 0) < j.target * j.pouchChargesPerTrip + j.reserve
            ) {
                throw Error('Shade declared owned key/food/prayer stock short before withdrawals');
            }
            await s.bot.closeBank();
            const kit = await (deps.loadout ?? runCombatOwnedLoadout)(s, { bank: SHADE_ROUTE.bank, pack: [], wear: j.wear, cap: 200, maximumMoves: 96 }, stopped);
            if (!kit.ok) throw Error('Shade owned loadout ' + kit.failure);
            const profile: BankProfile = {
                bank: SHADE_ROUTE.bank,
                site: SHADE_ROUTE.site,
                inputs: { 379: j.foodPerKill, 2434: j.potionsPerKill, 2958: j.pouchChargesPerTrip },
                tools: [3465, 2963],
                outputs: [3404, 139, 141, 143, 229, 2959, 2957],
                capacityOutputs: { 2957: 1, 2959: 1, 3404: 1, 139: 1, 141: 1, 143: 1, 229: 1 },
                deferBankRecovery: () => {
                    returning = true;
                    return fatal() || inside || entryAttempted || uncertain || !!pouchPending || careBlocked();
                },
                prepare: async stop => {
                    returning = false;
                    if (stop() || stopped()) throw Error('Shade stopped before route preparation');
                    renewCare();
                    await protection(true);
                    await poll();
                },
                run: async (_n, cap) => {
                    let made = 0;
                    try {
                        await entry();
                        made = await kill(Math.max(1, cap - 220));
                        completed += made;
                        return made;
                    } finally {
                        await leave();
                    }
                },
            };
            bankResult = await (deps.bank ?? runCombatBankProfile)(
                s,
                { family: 'shade', recipe: 'fiyr', target: j.target, batch: 1, cap: j.cap - (original.tick() - start) - 100, returnTicks: j.returnTicks - 100, members: true, reserve: j.reserve, bank: SHADE_ROUTE.bank, site: SHADE_ROUTE.site },
                profile,
                () => fatal() || shadeStopRequested(original.name, requestStop) || (!returning && !at(SHADE_ROUTE.bank, 3) && !returnFunded()),
            );
            if (!bankResult.ok) failure = bankResult.failure;
        } catch (e) {
            failure = String(e);
            if (inside || entryAttempted) {
                try {
                    await leave();
                } catch (exit) {
                    failure += '; exit ' + String(exit);
                }
            }
        }
        let balanced = false;
        let final: Record<number, number> | undefined;
        let foodUsed = 0;
        let bankDoseDebit: number | null = null;
        if (baseline && !inside && !entryAttempted && !uncertain && !pouchPending && !careBlocked() && at(SHADE_ROUTE.bank, 3) && alive()) {
            try {
                care = undefined;
                await protection(false);
                await open();
                final = all();
                if (baseline) {
                    foodUsed = (baseline[379] ?? 0) - (final[379] ?? 0);
                    const ids = new Set([...Object.keys(baseline), ...Object.keys(final)]);
                    const potionIds = new Set([2434, 139, 141, 143, 229]);
                    balanced =
                        [...ids].every(k => {
                            const id = +k;
                            return potionIds.has(id) || id === 379
                                ? true
                                : (final![id] ?? 0) - (baseline![id] ?? 0) === (id === 3404 ? completed : id === 2959 ? foodRot : id === 2958 ? -pouchUsed : id === 2957 ? pouchEmpties : 0);
                        }) && foodUsed === foodRot;
                    const bottles = (v: Record<number, number>) => [2434, 139, 141, 143, 229].reduce((a, id) => a + (v[id] ?? 0), 0);
                    const doses = (v: Record<number, number>) => [2434, 139, 141, 143].reduce((a, id, i) => a + (v[id] ?? 0) * (4 - i), 0);
                    bankDoseDebit = doses(baseline) - doses(final);
                    balanced &&= bankDoseDebit === careDoses() && bottles(baseline) === bottles(final) && careDoses() <= j.maximumDoses;
                }
                await s.bot.closeBank();
                controlsRestored = same(controls(), controls0);
            } catch (e) {
                failure += '; bank audit ' + String(e);
            }
        }
        const doseUsed = careDoses();
        const afterXp = xpView();
        const meleeXp = ['Attack', 'Strength', 'Defence'].reduce((v, k) => v + (afterXp[k] ?? 0) - (xp0[k] ?? 0), 0);
        const exactCombatXp = meleeXp === damageCredits.reduce((a, d) => a + d, 0) * 4 * j.xpRate;
        const otherXp = Object.keys(xp0).every(k => ['Attack', 'Strength', 'Defence', 'Hitpoints'].includes(k) || afterXp[k] === xp0[k]);
        offRot();
        return {
            identity: { selfSlot, life, respawns },
            ok: !failure && !!bankResult?.ok && completed === j.target && balanced && pouchReceipts.every(r => r.morphed) && controlsRestored && otherXp && exactCombatXp && alive(),
            failure,
            completed,
            bankResult,
            balanced,
            controlsRestored,
            otherXp,
            exactCombatXp,
            foodUsed,
            foodRot,
            rotReceipts,
            doseUsed,
            bankDoseDebit,
            careReceipts: careSessions.flatMap(c => c.receipts),
            careWindows: careSessions.length,
            pouchUsed,
            pouchEmpties,
            pouchReceipts,
            pouchReturnReserve,
            entryReceipts,
            setupReceipts,
            firstHitReceipts,
            morphResumeReceipts,
            combatReceipts,
            lootReceipts,
            damageCredits,
            expectedRawHpXp: damageCredits.reduce((v, d) => v + Math.floor((d * 133) / 10) * j.xpRate, 0),
            initial: baseline,
            final,
            recoveryDeferred: fatal() || inside || entryAttempted || uncertain || !!pouchPending || careBlocked(),
            ticks: original.tick() - start,
            scope: 'finite owned Fiyr tomb entry/combat/remains/exit and common bank refill; no private varps, modern coffin or acquisition',
        };
    } finally {
        eatHold.release();
    }
}

export async function runShadeTripCli(args: readonly string[]) {
    const [name, path] = args;
    if (!name || !path) throw Error('usage: aio-fighter.ts shade actor explicit-job.json');
    const raw = readFileSync(path);
    if (raw.length > 32768) throw Error('Shade job too large');
    const j = validateShadeJob(JSON.parse(raw.toString('utf8')));
    let stop = false;
    process.once('SIGINT', () => {
        stop = true;
    });
    process.once('SIGTERM', () => {
        stop = true;
    });
    const s = await openBot(name);
    const own = shadeOwnContext(s);
    let ok = false;
    try {
        const r = await runShadeTrips(s, j, () => stop);
        console.log('SHADE_TRIP ' + JSON.stringify(r));
        ok = r.ok;
    } finally {
        if (own()) process.exitCode = (await settle([s], ok, 'finite owned Shade bank trips')) ? 0 : 1;
        else {
            console.log('SHADE_SETTLEMENT_DEFERRED original client/life/input owner lost');
            process.exitCode = 1;
        }
    }
}

// ============================================================================
// 4. Chompy birds: at-site hunting and full Yanille bank-backed trips
// ============================================================================
export function chompyHuntingTile(p: { worldX: number; worldZ: number; level: number }) {
    return (
        p.level === 0
        && p.worldX >= 2496
        && p.worldX <= 2687
        && p.worldZ >= 2944
        && p.worldZ <= 3007
        && !(p.worldX >= 2631 && p.worldX <= 2639 && p.worldZ >= 2962 && p.worldZ <= 2971)
    );
}

export const CHOMPY = {
    live: 1015,
    dead: 1016,
    toad: 1013,
    bait: 2875,
    bow: 2883,
    arrow: 2866,
    empty: 2871,
    full: 2872,
    one: 2874,
    two: 2873,
    feather: 314,
} as const;

export function bellowsCharges(rows: readonly { id: number; count: number }[]) {
    return rows.reduce((n, i) => n + i.count * (i.id === CHOMPY.full ? 3 : i.id === CHOMPY.two ? 2 : i.id === CHOMPY.one ? 1 : 0), 0);
}

export function ownChompyNotches(messages: readonly { text: string; tick: number; type?: number; observationId?: number }[], cursor: number) {
    return messages.filter(m => m.type === 0 && (m.observationId ?? m.tick) > cursor && /^You scratch a notch on your bow for the chompy bird kill\.$/.test(m.text)).length;
}

export async function runChompy(
    s: CombatSession,
    o: { kills: number; cap: number; maxBaits: number; stop?: () => boolean; stageBait?: (stop: () => boolean) => Promise<void>; upkeep?: () => Promise<void> },
) {
    if (![o.kills, o.cap, o.maxBaits].every(Number.isSafeInteger) || o.kills < 1 || o.kills > 5 || o.cap < 1 || o.cap > 20000 || o.maxBaits < o.kills || o.maxBaits > 15) {
        throw Error('invalid finite chompy limits');
    }
    const eatHold = holdSessionEater(s.sdk);
    try {
        const st = () => s.sdk.getState();
        const inv = () => s.sdk.getInventory();
        const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        const npcs = () => s.sdk.getNearbyNpcs();
        const p0 = st()?.player;
        const hp0 = s.sdk.getSkill('Hitpoints')?.level ?? 0;
        if (!p0 || !chompyHuntingTile(p0) || hp0 < 7) throw Error('stage at post-quest ogre swamp outside Rantz bait turf');
        if (!questFlags(s.client)?.some(q => /chompy/i.test(q.name) && q.state === 'complete')) throw Error('Chompy quest completion unobserved');
        const worn = s.sdk.getEquipment();
        if (!worn.some(i => i.slot === 3 && i.id === CHOMPY.bow) || !worn.some(i => i.slot === 13 && i.id === CHOMPY.arrow && i.count > 0)) {
            throw Error('wear ogre bow and ogre arrows');
        }
        if (npcs().some(n => n.id === CHOMPY.live || n.id === CHOMPY.dead)) throw Error('start without existing chompy targets');
        const life0 = p0.lifeId;
        const start = s.tick();
        const raw = objId('raw_chompy');
        const raw0 = held(raw);
        const feathers0 = held(CHOMPY.feather);
        const xp0 = s.sdk.getSkillXp('Ranged') ?? 0;
        let ended = false;
        let kills = 0;
        let baits = 0;
        let plucked = 0;
        let failure = '';
        let stop = 'target';
        void s.ended.then(() => {
            ended = true;
        });
        const unsafe = () => {
            const p = st()?.player;
            return !p || p.isDead || p.lifeId !== life0 || !chompyHuntingTile(p) || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < hp0;
        };
        const over = () => ended || unsafe() || !!o.stop?.() || s.tick() - start >= o.cap;
        const cursor = () => Math.max(-1, ...(st()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
        const wait = async (predicate: () => boolean, ticks: number) =>
            (await waitUntil(s, () => over() || predicate(), { timeoutTicks: Math.min(ticks, Math.max(1, o.cap - (s.tick() - start))) })) && !over() && predicate();
        const near = (x: number, z: number) => {
            const p = st()?.player;
            return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= 8;
        };
        try {
            while (kills < o.kills && baits < o.maxBaits && !over()) {
                await o.upkeep?.();
                await s.bot.dismissBlockingUI();
                if (over()) break;
                if (held(CHOMPY.bait) === 0) {
                    if (held(CHOMPY.bait) >= 3) throw Error('too many carried toads');
                    let bellow = inv().find(i => [CHOMPY.full, CHOMPY.two, CHOMPY.one].includes(i.id as any));
                    if (!bellow) {
                        const empty = inv().find(i => i.id === CHOMPY.empty);
                        const bubble = st()?.nearbyLocs.find(l => /^swamp bubbles$/i.test(l.name) && l.reachable !== false && near(l.x, l.z));
                        if (!empty || !bubble) throw Error('stage bellows and reachable swamp bubbles');
                        const n = held(CHOMPY.full);
                        const empty0 = held(CHOMPY.empty);
                        if (!(await s.sdk.sendUseItemOnLoc(empty.slot, bubble.x, bubble.z, bubble.id)).success || !(await wait(() => held(CHOMPY.full) === n + 1 && held(CHOMPY.empty) === empty0 - 1, 12))) {
                            throw Error('bellows fill not observed');
                        }
                        bellow = inv().find(i => i.id === CHOMPY.full);
                    }
                    const toad = npcs()
                        .filter(n => n.id === CHOMPY.toad && n.reachable !== false && near(n.x, n.z))
                        .sort((a, b) => a.distance - b.distance)[0];
                    if (!bellow || !toad || inv().length >= 28) throw Error('toad/bellows/free slot missing');
                    const inflationStock = () => JSON.stringify(inv().map(i => ({ id: i.id, count: i.count, slot: i.slot })).sort((a, b) => a.slot - b.slot));
                    const stock0 = inflationStock();
                    const charges = bellowsCharges(inv());
                    const bait0 = held(CHOMPY.bait);
                    const inflationCursor = cursor();
                    const deadline = s.tick() + 30;
                    const effect = () => held(CHOMPY.bait) === bait0 + 1 && bellowsCharges(inv()) === charges - 1;
                    const begun = () =>
                        (st()?.gameMessages ?? []).some(
                            m => m.type === 0 && (m.observationId ?? m.tick) > inflationCursor && m.text === 'You manage to catch the toad and inflate it with the swamp gas.',
                        );
                    let selected = toad;
                    let last = { x: st()!.player!.worldX, z: st()!.player!.worldZ };
                    let lastMove = s.tick();
                    const paid = () => {
                        const at = st()?.player;
                        if (at && (at.worldX !== last.x || at.worldZ !== last.z)) {
                            last = { x: at.worldX, z: at.worldZ };
                            lastMove = s.tick();
                        }
                        return effect();
                    };
                    for (let attempt = 0; attempt < 3 && !effect() && !over(); attempt++) {
                        const origin = { x: selected.x, z: selected.z };
                        const currentBellows = inv().find(i => i.id === bellow!.id);
                        if (over()) break;
                        if (!currentBellows || (attempt > 0 && (begun() || inflationStock() !== stock0))) throw Error('toad inflation changed before retarget');
                        if (!(await s.sdk.sendUseItemOnNpc(currentBellows.slot, selected.index)).success) throw Error('toad inflation dispatch refused');
                        if (deadline > s.tick() && (await wait(paid, Math.min(10, deadline - s.tick())))) break;
                        const current = npcs().find(n => n.id === CHOMPY.toad && n.index === selected.index);
                        const uncharged = held(CHOMPY.bait) === bait0 && bellowsCharges(inv()) === charges && inflationStock() === stock0;
                        if (!begun() && !uncharged && !effect()) throw Error('toad inflation inventory changed without native intro');
                        const replacement =
                            !begun() && uncharged && current && (current.x !== origin.x || current.z !== origin.z) && s.tick() - lastMove >= 3
                                ? npcs()
                                      .filter(n => n.id === CHOMPY.toad && n.reachable !== false && near(n.x, n.z))
                                      .sort((a, b) => a.distance - b.distance)[0]
                                : undefined;
                        if (!replacement || attempt === 2 || s.tick() >= deadline) {
                            if (deadline > s.tick()) await wait(paid, deadline - s.tick());
                            break;
                        }
                        selected = replacement;
                    }
                    if (!effect()) throw Error('toad inflation effect missing');
                }
                await o.stageBait?.(over);
                if (over()) break;
                if (npcs().some(n => n.id === CHOMPY.live)) throw Error('unowned pre-bait chompy appeared');
                const bait = inv().find(i => i.id === CHOMPY.bait);
                const p = st()?.player;
                if (!bait || !p || !chompyHuntingTile(p)) throw Error('bait stage missing');
                const b0 = held(CHOMPY.bait);
                const placed = { x: p.worldX, z: p.worldZ };
                const c = cursor();
                const reply = (await s.direct({ type: 'useInventoryItem', slot: bait.slot, optionIndex: 1, reason: 'SDK' })) as { success?: boolean };
                if (reply?.success === false || !(await wait(() => held(CHOMPY.bait) === b0 - 1 && npcs().some(n => n.id === 1014 && n.x === placed.x && n.z === placed.z), 12))) {
                    throw Error('own bait placement missing');
                }
                baits++;
                if (!(await wait(() => npcs().some(n => n.id === CHOMPY.live && near(n.x, n.z)), 110))) {
                    if (over()) break;
                    continue;
                }
                const bird = npcs()
                    .filter(n => n.id === CHOMPY.live && near(n.x, n.z))
                    .sort((a, b) => a.distance - b.distance)[0];
                if (!bird) throw Error('spawn target lost');
                await o.upkeep?.();
                if (over()) break;
                const corpseBaseline = new Set(npcs().filter(n => n.id === CHOMPY.dead).map(n => n.index));
                let lastLive = { x: bird.tileX ?? bird.x, z: bird.tileZ ?? bird.z };
                let ambiguous = false;
                const observe = () => {
                    const rows = npcs();
                    const live = rows.find(n => n.id === CHOMPY.live && n.index === bird.index);
                    if (live) lastLive = { x: live.tileX ?? live.x, z: live.tileZ ?? live.z };
                    if (rows.some(n => n.id === CHOMPY.live && n.index !== bird.index)) ambiguous = true;
                };
                const ownCorpse = () => {
                    observe();
                    const fresh = npcs().filter(n => n.id === CHOMPY.dead && !corpseBaseline.has(n.index));
                    return !ambiguous && fresh.length === 1 && (fresh[0]!.tileX ?? fresh[0]!.x) === lastLive.x && (fresh[0]!.tileZ ?? fresh[0]!.z) === lastLive.z
                        ? fresh[0]
                        : undefined;
                };
                const unwatch = s.onTick(observe);
                let corpse: ReturnType<typeof npcs>[number] | undefined;
                try {
                    if (!(await s.sdk.sendInteractNpc(bird.index, 5)).success) throw Error('chompy attack refused');
                    if (!(await wait(() => ownChompyNotches(st()?.gameMessages ?? [], c) > 0, 160))) throw Error('own chompy kill notch not observed');
                    if (ambiguous || ownChompyNotches(st()?.gameMessages ?? [], c) !== 1) throw Error('ambiguous chompy kill count');
                    kills++;
                    if (!(await wait(() => !!ownCorpse(), 8))) throw Error('own kill corpse missing or ambiguous');
                    corpse = ownCorpse();
                } finally {
                    unwatch();
                }
                if (!corpse) throw Error('own kill corpse missing or ambiguous');
                const f0 = held(CHOMPY.feather);
                if (
                    !(await s.sdk.sendInteractNpc(corpse.index, 4)).success
                    || !(await wait(() => held(CHOMPY.feather) >= f0 + 10 && !npcs().some(n => n.index === corpse!.index && n.id === CHOMPY.dead), 12))
                ) {
                    throw Error('pluck effect missing');
                }
                plucked++;
                const meat = s.sdk.getGroundItems().find(i => i.id === raw && i.x === corpse!.x && i.z === corpse!.z);
                if (!meat) throw Error('raw chompy loot missing');
                const r0 = held(raw);
                if (!(await s.sdk.sendPickup(meat.x, meat.z, raw)).success || !(await wait(() => held(raw) === r0 + 1, 12))) {
                    throw Error('raw chompy pickup missing');
                }
                console.log('CHOMPY_KILL ' + JSON.stringify({ kills, baits, plucked, raw: held(raw) - raw0, tick: s.tick() }));
                await waitTicks(s, 1);
            }
            if (kills < o.kills) stop = over() ? 'stopped/cap' : 'bait budget';
        } catch (e) {
            failure = String(e);
            stop = 'failure';
        }
        const rawGained = held(raw) - raw0;
        return {
            ok: !failure && !ended && !unsafe() && !o.stop?.() && kills === o.kills && plucked === kills && rawGained === kills,
            stop,
            failure,
            kills,
            baits,
            plucked,
            raw: rawGained,
            feathers: held(CHOMPY.feather) - feathers0,
            rangedXp: (s.sdk.getSkillXp('Ranged') ?? 0) - xp0,
            ticks: s.tick() - start,
        };
    } finally {
        eatHold.release();
    }
}

export async function runChompyCli(args: readonly string[]) {
    let s: CombatSession | undefined;
    let stopped = false;
    try {
        const [account, kills, cap, baits] = args;
        if (!account) throw Error('account required');
        s = await openBot(account, {
            onStop: async () => {
                stopped = true;
            },
        });
        const r = await runChompy(s, {
            kills: Number(kills ?? 1),
            cap: Number(cap ?? 2000),
            maxBaits: Number(baits ?? 5),
            stop: () => stopped || existsSync('.practice/stop-microbot-chompy'),
        });
        console.log('CHOMPY_RESULT ' + JSON.stringify(r));
        await finish([s], r.ok, JSON.stringify(r));
    } catch (e) {
        await finish(s ? [s] : [], false, String(e));
    }
}

export const CHOMPY_TRIP = { bank: { x: 2614, z: 3093, level: 0 }, site: { x: 2594, z: 2966, level: 0 }, raw: 2876, arrowsPerKill: 32, bellows: [2871, 2872, 2873, 2874] } as const;
export type ChompyTripJob = {
    kills: number;
    perTrip: number;
    cap: number;
    returnTicks: number;
    protectMelee?: boolean;
    prayerPotions?: number;
    energy?: { id: number; maximumUses: number; below: number };
};

export function chompyRouteJob(o: ChompyTripJob): BankRouteJob {
    if (!Number.isSafeInteger(o.kills) || o.kills < 1 || o.kills > 20 || !Number.isSafeInteger(o.perTrip) || o.perTrip < 1 || o.perTrip > 5) {
        throw Error('Chompy trip kills1..20 and batch1..5 required');
    }
    if (!Number.isSafeInteger(o.prayerPotions) || o.prayerPotions !== o.kills) throw Error('declare one bank-owned four-dose prayer potion per kill');
    if (o.protectMelee !== true) throw Error('Chompy trip requires declared Protect from Melee');
    if (
        o.energy
        && (![3008, 3016, 464].includes(o.energy.id)
            || !Number.isSafeInteger(o.energy.maximumUses)
            || o.energy.maximumUses < 1
            || o.energy.maximumUses > o.kills * (o.energy.id === 464 ? 1 : 4)
            || !Number.isSafeInteger(o.energy.below)
            || o.energy.below < 1
            || o.energy.below > 99)
    ) {
        throw Error('invalid finite owned Chompy energy policy');
    }
    const job: BankRouteJob = { family: 'chompy', recipe: 'post-quest-swamp', target: o.kills, batch: o.perTrip, cap: o.cap, returnTicks: o.returnTicks, members: true };
    validateBankRouteJob(job);
    return job;
}

export const CHOMPY_ENERGY_IDS = [...ORB_ENERGY.map(r => r.id), 464, 229];

export function chompyEnergyOption(env: Record<string, string | undefined> = process.env): ChompyTripJob['energy'] {
    if (env.CHOMPY_ENERGY_ID === undefined) {
        if (env.CHOMPY_ENERGY_USES !== undefined || env.CHOMPY_ENERGY_BELOW !== undefined) throw Error('Chompy energy policy needs native input ID');
        return;
    }
    return { id: Number(env.CHOMPY_ENERGY_ID), maximumUses: Number(env.CHOMPY_ENERGY_USES ?? 1), below: Number(env.CHOMPY_ENERGY_BELOW ?? 20) };
}

export async function drinkChompyEnergy(s: CombatSession, id: number, alive: () => boolean) {
    const pack = () => {
        const out: Record<number, number> = {};
        for (const r of s.sdk.getInventory()) out[r.id] = (out[r.id] ?? 0) + r.count;
        return out;
    };
    const before = pack();
    const began = s.tick();
    const agility = s.sdk.getSkill('Agility')?.baseLevel;
    const energy = s.sdk.getState()?.player?.runEnergy;
    const hp = s.sdk.getSkill('Hitpoints')?.level;
    if (!alive() || typeof energy !== 'number' || energy < 0 || energy >= 100 || !Number.isSafeInteger(agility) || agility! < 1 || agility! > 99) {
        throw Error('Chompy native energy state absent');
    }
    let delta: Record<number, number>;
    if (id === 464) {
        const row = s.sdk.getInventory().find(i => i.id === id);
        if (!row) throw Error('Chompy owned strange fruit absent');
        delta = { [id]: -1 };
        try {
            await s.sdk.sendUseItem(row.slot, 1);
        } catch {}
        if (
            !(await waitUntil(
                s,
                () => !alive() || (orbPackEffect(before, pack(), delta) && (s.sdk.getState()?.player?.runEnergy ?? -1) >= Math.min(100, energy + 30) - 1),
                { timeoutTicks: 8 },
            ))
            || !alive()
            || !orbPackEffect(before, pack(), delta)
        ) {
            throw Error('Chompy fruit stock/energy unconfirmed');
        }
    } else {
        delta = await drinkOrbEnergy(s, id, alive);
    }
    const elapsed = s.tick() - began;
    const passiveMaximum = Math.ceil(((Math.floor(agility! / 6) + 8) * (elapsed + 1)) / 100);
    const after = s.sdk.getState()?.player?.runEnergy;
    const gain = id === 464 ? 30 : ORB_ENERGY.find(r => r.id === id)?.gain;
    if (
        !alive()
        || s.sdk.getSkill('Hitpoints')?.level !== hp
        || gain === undefined
        || typeof after !== 'number'
        || after < Math.min(100, energy + gain) - 1
        || after > Math.min(100, energy + gain + passiveMaximum)
    ) {
        throw Error('Chompy energy/HP unconfirmed');
    }
    for (let i = 0; i < 3; i++) {
        if (!alive()) throw Error('Chompy energy settle stopped');
        await waitTicks(s, 1);
    }
    if (!alive() || s.sdk.getSkill('Hitpoints')?.level !== hp) throw Error('Chompy energy settle health/stop');
    return { id, energyBefore: energy, energyAfter: after, gain, receiptTicks: elapsed, passiveMaximum, delta };
}

export function chompyEnergyUpkeep(
    s: CombatSession,
    policy: NonNullable<ChompyTripJob['energy']>,
    receipts: Awaited<ReturnType<typeof drinkChompyEnergy>>[],
    alive: () => boolean,
) {
    const family = policy.id === 464 ? [464] : ORB_ENERGY.filter(r => r.gain === ORB_ENERGY.find(e => e.id === policy.id)!.gain).map(r => r.id as number);
    const stock = () => Object.fromEntries(family.map(id => [id, s.sdk.getInventory().filter(i => i.id === id).reduce((v, i) => v + i.count, 0)]));
    const expected = stock();
    let uncertain = false;
    return {
        get uncertain() {
            return uncertain;
        },
        run: async () => {
            if (uncertain || !alive()) throw Error('Chompy energy stopped or uncertain');
            const cur = stock();
            if (family.some(id => cur[id] !== expected[id])) throw Error('Chompy staged energy stock changed without receipt');
            if (receipts.length >= policy.maximumUses || (s.sdk.getState()?.player?.runEnergy ?? 101) >= policy.below) return;
            const row = s.sdk.getInventory().find(i => family.includes(i.id));
            if (!row) return;
            uncertain = true;
            const receipt = await drinkChompyEnergy(s, row.id, alive);
            receipts.push(receipt);
            for (const id of family) expected[id] += receipt.delta[id] ?? 0;
            uncertain = false;
            console.log('CHOMPY_ENERGY ' + JSON.stringify(receipt));
        },
    };
}

export const CHOMPY_POTIONS = [2434, 139, 141, 143, 229] as const;

export function chompyTripAssets(
    before: ReadonlyMap<number, number>,
    after: ReadonlyMap<number, number>,
    r: { kills: number; baits: number; raw: number; feathers: number; rangedXp: number },
    potionChanges: ReadonlyMap<number, number> = new Map(),
    energyChanges: ReadonlyMap<number, number> = new Map(),
) {
    const delta = (id: number) => (after.get(id) ?? 0) - (before.get(id) ?? 0);
    const rows = (a: ReadonlyMap<number, number>) => [...a].map(([id, count]) => ({ id, count }));
    const bellows = (a: ReadonlyMap<number, number>) => CHOMPY_TRIP.bellows.reduce((v, id) => v + (a.get(id) ?? 0), 0);
    const fills = (bellowsCharges(rows(after)) + r.baits - bellowsCharges(rows(before))) / 3;
    const ammoUsed = (before.get(CHOMPY.arrow) ?? 0) - (after.get(CHOMPY.arrow) ?? 0);
    const allowed = new Set<number>([...CHOMPY_TRIP.bellows, CHOMPY.arrow, CHOMPY_TRIP.raw, CHOMPY.feather, ...CHOMPY_POTIONS, ...CHOMPY_ENERGY_IDS]);
    const changes = new Map(potionChanges);
    for (const [id, v] of energyChanges) changes.set(id, (changes.get(id) ?? 0) + v);
    if (CHOMPY_ENERGY_IDS.some(id => delta(id) !== (changes.get(id) ?? 0))) throw Error('Chompy energy assets do not reconcile');
    if (CHOMPY_POTIONS.some(id => delta(id) !== (changes.get(id) ?? 0))) throw Error('Chompy potion assets do not reconcile');
    if (
        bellows(before) !== 1
        || bellows(after) !== 1
        || !Number.isSafeInteger(fills)
        || fills < 0
        || delta(CHOMPY.bait) !== 0
        || r.baits < r.kills
        || r.baits > 15
        || r.raw !== r.kills
        || delta(CHOMPY_TRIP.raw) !== r.kills
        || delta(CHOMPY.feather) !== r.feathers
        || r.feathers < 10 * r.kills
        || r.feathers > 29 * r.kills
        || r.rangedXp < 40 * r.kills
        || ammoUsed < 0
        || ammoUsed > CHOMPY_TRIP.arrowsPerKill * r.kills
        || [...new Set([...before.keys(), ...after.keys()])].some(id => !allowed.has(id) && delta(id) !== 0)
    ) {
        throw Error('Chompy trip assets or native output do not reconcile');
    }
    return {
        ammoUsed,
        baits: r.baits,
        fills,
        raw: r.raw,
        feathers: r.feathers,
        rangedXp: r.rangedXp,
        ...(potionChanges.size ? { potionChanges: Object.fromEntries(potionChanges) } : {}),
        ...(energyChanges.size ? { energyChanges: Object.fromEntries(energyChanges) } : {}),
    };
}

export async function restoreChompyStyle(s: CombatSession, style: number, alive: () => boolean) {
    const value = () => s.sdk.getState()?.combatStyle;
    const matched = () => value()?.known === true && value()?.weaponName === 'Unarmed' && value()?.currentStyle === style;
    if (!alive() || value()?.known !== true || value()?.weaponName !== 'Unarmed' || !Number.isSafeInteger(style) || style < 0 || style > 2 || !value()?.styles.some(v => v.index === style)) {
        return false;
    }
    if (matched()) return true;
    if (!(await s.sdk.sendSetCombatStyle(style)).success) return false;
    await waitUntil(s, () => !alive() || matched(), { timeoutTicks: 8 });
    return alive() && matched();
}

export function chompyPrayerReserve(returnTicks: number, gear: readonly { id: number }[]) {
    const bonus = gear.reduce((n, i) => n + (({ 544: 6, 542: 5, 1718: 8 } as Record<number, number>)[i.id] ?? 0), 0);
    return Math.ceil((Math.ceil(returnTicks / 5) * 60) / (60 + 2 * bonus)) + 2;
}

export function chompyProtection(s: CombatSession, alive: () => boolean) {
    let uncertain = false;
    const active = () => s.sdk.getState()?.prayers?.activePrayers[14];
    return {
        get uncertain() {
            return uncertain;
        },
        set: async (on: boolean) => {
            if (uncertain || !alive()) throw Error('Chompy prayer uncertain or original life unavailable');
            if (active() === on) return;
            try {
                try {
                    await s.sdk.sendTogglePrayer(14);
                } catch {}
                if (!(await waitUntil(s, () => !alive() || active() === on, { timeoutTicks: 8 })) || !alive() || active() !== on) {
                    throw Error('Chompy protection transition unobserved');
                }
            } catch (error) {
                uncertain = true;
                throw error;
            }
        },
    };
}

export async function drinkChompyPrayer(s: CombatSession, stop: () => boolean) {
    const pack = () => new Map(s.sdk.getInventory().map(i => [i.id, s.sdk.getInventory().filter(r => r.id === i.id).reduce((v, r) => v + r.count, 0)]));
    const before = pack();
    const prayer = s.sdk.getState()?.prayers;
    const points = prayer?.prayerPoints;
    const hp = s.sdk.getSkill('Hitpoints')?.level;
    const id = CHOMPY_POTIONS.slice(0, -1).find(pot => (before.get(pot) ?? 0) > 0);
    const item = s.sdk.getInventory().find(i => i.id === id);
    const op = item?.optionsWithIndex.find(o => /^drink$/i.test(o.text));
    if (stop() || id === undefined || !item || !op || points === undefined || !prayer || points >= prayer.prayerLevel) {
        throw Error('Chompy owned prayer dose unavailable');
    }
    const next = CHOMPY_POTIONS[CHOMPY_POTIONS.indexOf(id) + 1]!;
    const expected = Math.min(prayer.prayerLevel, points + 7 + Math.floor(prayer.prayerLevel / 4));
    const paid = () => {
        const cur = pack();
        return [...new Set([...before.keys(), ...cur.keys()])].every(key => (cur.get(key) ?? 0) - (before.get(key) ?? 0) === (key === id ? -1 : key === next ? 1 : 0));
    };
    let dispatchError: unknown;
    try {
        await s.direct({ type: 'useInventoryItem', slot: item.slot, optionIndex: op.opIndex, reason: 'owned Chompy prayer dose' });
    } catch (e) {
        dispatchError = e;
    }
    if (
        !(await waitUntil(s, () => stop() || (paid() && (s.sdk.getState()?.prayers.prayerPoints ?? 0) >= expected - 2), { timeoutTicks: 8 }))
        || stop()
        || !paid()
        || (s.sdk.getState()?.prayers.prayerPoints ?? 0) > expected
        || s.sdk.getSkill('Hitpoints')?.level !== hp
    ) {
        throw Error('Chompy prayer dose/points/HP unconfirmed ' + String(dispatchError ?? ''));
    }
    const receipt = { id, next, pointsBefore: points, pointsAfter: s.sdk.getState()!.prayers.prayerPoints };
    for (let i = 0; i < 3; i++) {
        if (stop()) throw Error('Chompy potion settle stopped');
        await waitTicks(s, 1);
    }
    if (stop() || s.sdk.getSkill('Hitpoints')?.level !== hp) throw Error('Chompy potion settle health/stop');
    return receipt;
}

export async function waitChompyPressure(s: CombatSession, stopped: () => boolean) {
    const own = (s.client as { selfSlot?: number }).selfSlot;
    if (!Number.isSafeInteger(own)) throw Error('Chompy own native player slot unknown');
    let quietSince = s.tick();
    let damage = s.sdk.getState()?.player?.combat.lastDamageTick;
    if (!Number.isSafeInteger(damage)) throw Error('Chompy damage publication unknown');
    const clear = () => {
        const state = s.sdk.getState();
        const combat = state?.player?.combat;
        if (!combat || !Number.isSafeInteger(combat.lastDamageTick)) throw Error('Chompy damage publication lost');
        if (combat.lastDamageTick !== damage) {
            damage = combat.lastDamageTick;
            quietSince = s.tick();
        }
        if (combat.targetType === 'player' || state!.nearbyNpcs.some(n => n.targetIndex === 32768 + own! && n.optionsWithIndex.some(o => /^attack$/i.test(o.text)))) {
            quietSince = s.tick();
        }
        return s.tick() - quietSince >= 8;
    };
    return (await waitUntil(s, () => stopped() || clear(), { timeoutTicks: 24 })) && !stopped() && clear();
}

export function chompyLocalReturn(p: { worldX: number; worldZ: number; level: number } | null | undefined) {
    return !!p && p.level === 0 && Math.max(Math.abs(p.worldX - CHOMPY_TRIP.bank.x), Math.abs(p.worldZ - CHOMPY_TRIP.bank.z)) <= 128;
}

export async function chompyReturnHandoff(s: CombatSession, stopped: () => boolean, walker = () => sessionWalker(s as Session)) {
    if (stopped()) throw Error('Chompy local return handoff stopped');
    const result = await walkPath(await walker(), [{ ...CHOMPY_TRIP.site, tol: 0 }], { maxTicks: 40, stop: stopped });
    if (!result.ok || stopped() || !chompyLocalReturn(s.sdk.getState()?.player)) throw Error('Chompy local return handoff ' + result.detail);
}

export async function runChompyTrip(s: CombatSession, o: ChompyTripJob, requestStop: () => boolean = () => false) {
    const sess = s as Session;
    const eatHold = holdSessionEater(s.sdk);
    try {
        const job = chompyRouteJob(o);
        const state = () => s.sdk.getState();
        const first = state()?.player;
        const hp0 = s.sdk.getSkill('Hitpoints')?.level ?? 0;
        const start = s.tick();
        if (
            !first
            || hp0 < 30
            || (s.sdk.getSkill('Ranged')?.level ?? 0) < 30
            || !questFlags(s.client)?.some(q => /chompy/i.test(q.name) && q.state === 'complete')
            || first.level !== 0
            || Math.max(Math.abs(first.worldX - CHOMPY_TRIP.bank.x), Math.abs(first.worldZ - CHOMPY_TRIP.bank.z)) > 3
        ) {
            throw Error('stage HP30, Ranged30 and observed completed Chompy quest at owned Yanille bank');
        }
        if (s.sdk.getInventory().some(i => [CHOMPY.bow, CHOMPY.arrow, CHOMPY.bait, ...CHOMPY_TRIP.bellows, ...CHOMPY_POTIONS, ...CHOMPY_ENERGY_IDS].includes(i.id as any))) {
            throw Error('stage the ogre kit in owned bank stock');
        }
        const retaliate = state()?.autoRetaliateEnabled;
        if (typeof retaliate !== 'boolean') throw Error('Chompy initial auto-retaliate unknown');
        const style = state()?.combatStyle;
        if (!style?.known || style.weaponName !== 'Unarmed' || !Number.isSafeInteger(style.currentStyle) || style.currentStyle < 0 || style.currentStyle > 2 || !style.styles.some(v => v.index === style.currentStyle)) {
            throw Error('Chompy initial native unarmed style unknown');
        }
        const initialStyle = style.currentStyle;
        const initialGear = s.sdk.getEquipment().map(i => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot);
        if (initialGear.some(i => [3, 5, 13].includes(i.slot))) throw Error('stage free weapon, shield and ammo slots for bank-owned ogre kit');
        // Release passive prayer guard before managing explicit prayer toggles.
        await releasePrayerGuard(sess);
        const prayer0 = state()?.prayers;
        if (!prayer0 || typeof prayer0.activePrayers[14] !== 'boolean' || prayer0.activePrayers.some((v, i) => v && i !== 14) || prayer0.prayerLevel < 43) {
            throw Error('Chompy requires observed Prayer43 and no other active prayers');
        }
        const prayerInitial = prayer0.activePrayers[14];
        const pointsBefore = prayer0.prayerPoints;
        const prayerReserve = chompyPrayerReserve(o.returnTicks, initialGear);
        if (pointsBefore < prayerReserve + 12) throw Error('Chompy owned prayer return budget short');
        const firstLife = first.lifeId;
        const firstRespawns = first.respawnCount ?? 0;
        let ended = false;
        void s.ended.then(() => {
            ended = true;
        });
        const life = () => {
            const player = state()?.player;
            return !ended && !!player && player.lifeId === firstLife && (player.respawnCount ?? 0) <= firstRespawns && !player.isDead && (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0;
        };
        const protection = chompyProtection(s, life);
        let protectionStarted = false;
        const prayerSafe = () =>
            !protection.uncertain
            && !state()?.prayers.activePrayers.some((v, i) => v && i !== 14)
            && (!protectionStarted || state()?.prayers.activePrayers[14] === true)
            && ((state()?.prayers.prayerPoints ?? 0) > prayerReserve
                || (!!state()?.player && Math.max(Math.abs(state()!.player!.worldX - CHOMPY_TRIP.bank.x), Math.abs(state()!.player!.worldZ - CHOMPY_TRIP.bank.z)) <= 3));
        const stop = () =>
            !life()
            || !prayerSafe()
            || requestStop()
            || existsSync('.practice/stop-microbot-chompy')
            || existsSync('.practice/stop-all')
            || existsSync(`.practice/stop-${s.name}`)
            || s.tick() - start >= o.cap;
        const energyReceipts: Awaited<ReturnType<typeof drinkChompyEnergy>>[] = [];
        let energyUncertain = false;
        const potions: Awaited<ReturnType<typeof drinkChompyPrayer>>[] = [];
        const peers = () => state()?.nearbyPlayers.some(p => p.name.toLowerCase() !== first.name.toLowerCase()) ?? true;
        const receipts: ReturnType<typeof chompyTripAssets>[] = [];
        const assets = () => {
            const a = new Map<number, number>();
            for (const i of [...s.sdk.getInventory(), ...s.sdk.getEquipment()]) a.set(i.id, (a.get(i.id) ?? 0) + i.count);
            return a;
        };
        const count = (id: number) => assets().get(id) ?? 0;
        const open = async () => {
            if (!life() || s.tick() - start >= o.cap) throw Error('Chompy kit bank cleanup bound');
            if (state()?.bank.isOpen && s.bankObservation?.()) return;
            await s.sdk.sendCloseModal();
            const generation = s.bankObservation?.()?.generation ?? -1;
            if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !life() || (!!state()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation), { timeoutTicks: 12 })) || !life()) {
                throw Error('Chompy kit fresh bank unavailable');
            }
        };
        let result: Awaited<ReturnType<typeof runCombatBankProfile>> | undefined;
        let cleanup = '';
        let kitStaged = false;
        try {
            if (stop()) throw Error('Chompy stopped before kit staging');
            await open();
            if (o.energy && (s.bankObservation?.()?.items.find(i => i.id === o.energy!.id)?.count ?? 0) < o.kills) {
                throw Error('declared owned Chompy energy bank stock short');
            }
            if ((s.bankObservation?.()?.items.find(i => i.id === 2434)?.count ?? 0) < o.prayerPotions!) {
                throw Error('declared owned prayer potion bank stock short');
            }
            const bellows = [CHOMPY.full, CHOMPY.two, CHOMPY.one, CHOMPY.empty].find(id => (s.bankObservation?.()?.items ?? []).some(i => i.id === id && i.count >= 1));
            if (bellows === undefined) throw Error('owned bank bellows missing');
            for (const [id, n] of [[CHOMPY.bow, 1], [CHOMPY.arrow, CHOMPY_TRIP.arrowsPerKill * o.kills]] as const) {
                if (stop()) throw Error('Chompy stopped before kit withdrawal');
                const item = state()!.bank.items.find(i => i.id === id);
                const before = count(id);
                const stored = (s.bankObservation?.()?.items ?? []).find(i => i.id === id)?.count ?? 0;
                const generation = s.bankObservation!()!.generation;
                if (!item || stored < n) throw Error('owned bank ogre kit stock short');
                await s.bot.withdrawItem(item, n, { asNote: false });
                kitStaged = true;
                if (
                    !(await waitUntil(
                        s,
                        () => !life() || (count(id) === before + n && (s.bankObservation?.()?.items.find(i => i.id === id)?.count ?? 0) === stored - n && (s.bankObservation?.()?.generation ?? -1) > generation),
                        { timeoutTicks: 10 },
                    ))
                    || !life()
                ) {
                    throw Error('owned ogre kit withdrawal does not reconcile');
                }
            }
            await s.bot.closeBank();
            if (!(await waitUntil(s, () => !state()?.bank.isOpen, { timeoutTicks: 8 }))) throw Error('Chompy kit bank remains open');
            if (retaliate) {
                await s.direct({ type: 'clickComponent', componentId: 151, reason: 'Chompy route disables automatic foreign attacks' });
                if (!(await waitUntil(s, () => state()?.autoRetaliateEnabled === false, { timeoutTicks: 8 }))) throw Error('Chompy auto-retaliate off unobserved');
            }
            for (const [id, slot] of [[CHOMPY.bow, 3], [CHOMPY.arrow, 13]] as const) {
                if (stop()) throw Error('Chompy stopped before kit wield');
                const item = s.sdk.getInventory().find(i => i.id === id);
                if (!item) throw Error('bank-owned ogre kit missing ' + id);
                await s.bot.equipItem(item);
                if (!(await waitUntil(s, () => !life() || s.sdk.getEquipment().some(i => i.id === id && i.slot === slot), { timeoutTicks: 8 })) || !life()) {
                    throw Error('native ogre kit wield unobserved');
                }
            }
            if (!(await s.sdk.sendSetCombatStyle(0)).success || !(await waitUntil(s, () => state()?.combatStyle?.known === true && state()?.combatStyle?.currentStyle === 0 && state()?.combatStyle?.weaponName === 'Ogre bow', { timeoutTicks: 8 }))) {
                throw Error('native accurate ogre bow style unobserved');
            }
            const replenish = async (halt: () => boolean) => {
                while ((state()?.prayers.prayerPoints ?? 0) < Math.min(state()?.prayers.prayerLevel ?? 0, Math.max(prayerReserve + 12, 75))) {
                    if (potions.length >= 4 * o.prayerPotions!) throw Error('Chompy declared dose budget exhausted');
                    const receipt = await drinkChompyPrayer(s, () => !life() || halt() || protection.uncertain || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < hp0);
                    potions.push(receipt);
                    console.log('CHOMPY_PRAYER_DOSE ' + JSON.stringify(receipt));
                }
            };
            const profile: BankProfile = {
                bank: CHOMPY_TRIP.bank,
                site: CHOMPY_TRIP.site,
                deferBankRecovery: () => !chompyLocalReturn(state()?.player),
                inputs: { 2434: 1, ...(o.energy ? { [o.energy.id]: 1 } : {}) },
                tools: [bellows],
                outputs: [CHOMPY_TRIP.raw, CHOMPY.feather, ...CHOMPY_TRIP.bellows, ...CHOMPY_POTIONS, ...CHOMPY_ENERGY_IDS],
                prepare: async halt => {
                    await replenish(halt);
                    if (halt() || (state()?.prayers.prayerPoints ?? 0) < prayerReserve + 12) throw Error('Chompy outbound prayer budget short');
                    await protection.set(true);
                    protectionStarted = true;
                },
                capacityOutputs: { [CHOMPY_TRIP.raw]: 1, [CHOMPY.feather]: 29, [CHOMPY.arrow]: CHOMPY_TRIP.arrowsPerKill },
                run: async (n, cap, halt) => {
                    if (cap <= 45 || peers() || state()?.groundItems.some(i => i.id === CHOMPY.arrow)) {
                        throw Error('Chompy hunt needs isolated site, empty arrow baseline and cleanup budget');
                    }
                    const energyUpkeep = o.energy ? chompyEnergyUpkeep(s, o.energy, energyReceipts, () => life() && !halt() && (s.sdk.getSkill('Hitpoints')?.level ?? 0) === hp0) : undefined;
                    const upkeep = async () => {
                        await replenish(halt);
                        try {
                            await energyUpkeep?.run();
                        } finally {
                            energyUncertain = energyUpkeep?.uncertain ?? false;
                        }
                    };
                    const before = assets();
                    const potionStart = potions.length;
                    const energyStart = energyReceipts.length;
                    const positions = new Set<string>();
                    const off = s.onTick(() => {
                        for (const bird of state()?.nearbyNpcs ?? []) if (bird.id === CHOMPY.live) positions.add(`${bird.x},${bird.z}`);
                    });
                    try {
                        const hunt = await runChompy(s, {
                            upkeep,
                            stageBait: async halted => {
                                const safe = { x: 2588, z: 2966, level: 0 };
                                if (halted()) throw Error('Chompy bait staging stopped');
                                const walk = await walkPath(await sessionWalker(sess), [{ ...safe, tol: 0 }], { maxTicks: 60, stop: halted });
                                if (!walk.ok || halted()) throw Error('Chompy wolf separation ' + walk.detail);
                                if (!(await waitChompyPressure(s, halted))) {
                                    throw Error(
                                        'Chompy wolf combat cooldown unavailable '
                                            + JSON.stringify({
                                                player: state()?.player,
                                                messages: state()?.gameMessages.filter(m => m.type === 0).slice(-3),
                                                attackers: state()?.nearbyNpcs.filter(row => row.inCombat).map(row => ({ id: row.id, index: row.index, target: row.targetIndex })),
                                            }),
                                    );
                                }
                            },
                            kills: n,
                            cap: Math.min(20000, cap - 45),
                            maxBaits: Math.min(15, n * 5),
                            stop: () => halt() || peers() || !prayerSafe(),
                        });
                        if (!hunt.ok) throw Error('staged Chompy hunt ' + hunt.failure + ' ' + hunt.stop);
                        await waitTicks(s, 3);
                        const spent = (before.get(CHOMPY.arrow) ?? 0) - count(CHOMPY.arrow);
                        if (spent < 1 || spent > CHOMPY_TRIP.arrowsPerKill * n) throw Error('native ogre arrow debit absent');
                        if (peers()) throw Error('Chompy arrow attribution changed');
                        const arrows = state()!.groundItems.filter(i => i.id === CHOMPY.arrow);
                        if (arrows.some(i => !positions.has(`${i.x},${i.z}`)) || arrows.reduce((a, i) => a + i.count, 0) > spent) {
                            throw Error('Chompy ground arrow attribution ambiguous');
                        }
                        const units = arrows.reduce((a, i) => a + i.count, 0);
                        if (units) {
                            const client = s.client as { objType: (id: number) => { cost: number; stackable: boolean } };
                            const recovered = await runVisibleGroundLoot(
                                {
                                    state: () => {
                                        const st = state();
                                        return st && { ...st, groundItems: st.groundItems.filter(i => i.id === CHOMPY.arrow && positions.has(`${i.x},${i.z}`)) };
                                    },
                                    tick: () => s.tick(),
                                    stop: () => !life() || peers() || halt(),
                                    definition: id => client.objType(id),
                                    pickup: async i => (await s.sdk.sendPickup(i.x, i.z, i.id)).success,
                                    wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
                                    step: () => waitTicks(s, 1),
                                    clearModal: async () => {
                                        await s.sdk.sendCloseModal();
                                    },
                                },
                                { mode: 'list', ids: [CHOMPY.arrow], names: [], minimumValue: 0, maximumValue: 2147483647, radius: 12, maximumUnits: units, cap: 35, idleTicks: 5 },
                            );
                            if (recovered.units !== units) throw Error('Chompy visible arrows remain');
                        }
                        const potionChanges = new Map<number, number>();
                        for (const r of potions.slice(potionStart)) {
                            potionChanges.set(r.id, (potionChanges.get(r.id) ?? 0) - 1);
                            potionChanges.set(r.next, (potionChanges.get(r.next) ?? 0) + 1);
                        }
                        const energyChanges = new Map<number, number>();
                        for (const r of energyReceipts.slice(energyStart)) {
                            for (const [id, v] of Object.entries(r.delta)) energyChanges.set(Number(id), (energyChanges.get(Number(id)) ?? 0) + v);
                        }
                        const receipt = chompyTripAssets(before, assets(), hunt, potionChanges, energyChanges);
                        receipts.push(receipt);
                        console.log('CHOMPY_TRIP_KILL ' + JSON.stringify(receipt));
                        return hunt.raw;
                    } finally {
                        off();
                        const rows = s.sdk.getInventory().filter(i => CHOMPY_TRIP.bellows.includes(i.id as any));
                        if (rows.length === 1 && rows[0]!.count === 1) profile.tools[0] = rows[0]!.id;
                        await chompyReturnHandoff(s, () => !life() || s.tick() - start >= o.cap - 100 || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < hp0);
                    }
                },
            };
            result = await runCombatBankProfile(s, { ...job, cap: o.cap - (s.tick() - start) - 100 }, profile, stop);
        } catch (error) {
            cleanup = String(error);
        } finally {
            if (kitStaged && life()) {
                try {
                    const at = state()?.player;
                    if (!at || at.level !== 0 || Math.max(Math.abs(at.worldX - CHOMPY_TRIP.bank.x), Math.abs(at.worldZ - CHOMPY_TRIP.bank.z)) > 3) {
                        throw Error('Chompy kit return bank unobserved');
                    }
                    await s.bot.closeBank();
                    if (!(await waitUntil(s, () => !state()?.bank.isOpen, { timeoutTicks: 8 }))) throw Error('Chompy kit bank remains open');
                    for (const slot of [13, 3]) {
                        const item = s.sdk.getEquipment().find(i => i.slot === slot);
                        if (item) {
                            const total = count(item.id);
                            const held = s.sdk.getInventory().filter(i => i.id === item.id).reduce((a, i) => a + i.count, 0);
                            await s.bot.unequipItem(item);
                            if (
                                !(await waitUntil(
                                    s,
                                    () => !life() || (!s.sdk.getEquipment().some(i => i.slot === slot) && s.sdk.getInventory().filter(i => i.id === item.id).reduce((a, i) => a + i.count, 0) === held + item.count),
                                    { timeoutTicks: 8 },
                                ))
                                || !life()
                                || count(item.id) !== total
                            ) {
                                throw Error('Chompy return kit unequip does not reconcile');
                            }
                        }
                    }
                    await open();
                    for (const id of [CHOMPY.arrow, CHOMPY.bow, ...CHOMPY_POTIONS, ...CHOMPY_ENERGY_IDS]) {
                        const item = s.sdk.getInventory().find(i => i.id === id);
                        if (item) await depositObserved(sess, item);
                    }
                    await s.bot.closeBank();
                    await protection.set(prayerInitial);
                    if (!(await restoreChompyStyle(s, initialStyle, life))) throw Error('Chompy initial unarmed style restore unobserved');
                    if (retaliate && state()?.autoRetaliateEnabled !== true) {
                        await s.direct({ type: 'clickComponent', componentId: 150, reason: 'restore Chompy route auto-retaliate at bank' });
                        if (!(await waitUntil(s, () => state()?.autoRetaliateEnabled === true, { timeoutTicks: 8 }))) throw Error('Chompy auto-retaliate restore unobserved');
                    }
                } catch (error) {
                    cleanup += '; kit recovery ' + String(error);
                }
            }
        }
        const prayerRestored = !protection.uncertain && life() && state()?.prayers.activePrayers[14] === prayerInitial;
        const prayerPointsAfter = state()?.prayers.prayerPoints;
        const retaliateRestored = state()?.autoRetaliateEnabled === retaliate;
        const styleRestored = state()?.combatStyle?.known === true && state()?.combatStyle?.weaponName === 'Unarmed' && state()?.combatStyle?.currentStyle === initialStyle;
        const banked = { raw: result?.banked[CHOMPY_TRIP.raw] ?? 0, feathers: result?.banked[CHOMPY.feather] ?? 0 };
        const gearPreserved = JSON.stringify(initialGear) === JSON.stringify(s.sdk.getEquipment().map(i => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot));
        return {
            ...result,
            ok: !!(result?.ok) && !cleanup && gearPreserved && prayerRestored && styleRestored && retaliateRestored && banked.raw === o.kills && banked.feathers === receipts.reduce((n, r) => n + r.feathers, 0),
            banked,
            receipts,
            potions,
            energy: energyReceipts,
            energyStateUncertain: energyUncertain,
            maximumEnergyUses: o.energy?.maximumUses ?? 0,
            maximumDoses: 4 * o.prayerPotions!,
            ammoUsed: receipts.reduce((n, r) => n + r.ammoUsed, 0),
            gearPreserved,
            prayerRestored,
            prayerStateUncertain: protection.uncertain,
            prayerReserve,
            prayerPointsBefore: pointsBefore,
            prayerPointsAfter,
            styleRestored,
            retaliateRestored,
            cleanup: cleanup || '-',
            ticks: s.tick() - start,
        };
    } finally {
        eatHold.release();
    }
}

export async function runChompyTripCli(args: readonly string[], env: Record<string, string | undefined> = process.env) {
    const account = args[0];
    if (!account) throw Error('usage: aio-fighter.ts chompy account [kills=2] [per-trip=1] [cap=5000]');
    let stopped = false;
    const s = await openBot(account, {
        onStop: async () => {
            stopped = true;
        },
    });
    try {
        const result = await runChompyTrip(
            s,
            {
                kills: Number(args[1] ?? 2),
                perTrip: Number(args[2] ?? 1),
                cap: Number(args[3] ?? 5000),
                returnTicks: 300,
                protectMelee: true,
                prayerPotions: Number(args[1] ?? 2),
                energy: chompyEnergyOption(env),
            },
            () => stopped,
        );
        console.log('CHOMPY_TRIP ' + JSON.stringify(result));
        await finish([s], result.ok, JSON.stringify(result));
    } catch (error) {
        await finish([s], false, String(error));
    }
}

// ============================================================================
// 5. Ground Loot Trips
// ============================================================================
export interface LootTripJob {
    target: number;
    batch: number;
    cap: number;
    returnTicks: number;
    members: boolean;
    bank: { x: number; z: number; level: number };
    site: { x: number; z: number; level: number };
    policy: Omit<LootPolicy, 'maximumUnits' | 'cap'>;
    valuation?: { source: 'native-ge-last-trade'; ids: number[]; thresholds?: 'donor' };
}

const LOOT_IDS = readFileSync(resolve(ROOT, 'vendor/rs-sdk/server/content/pack/obj.pack'), 'utf8')
    .split(/\r?\n/)
    .flatMap(l => {
        const m = l.match(/^(\d+)=/);
        return m ? [Number(m[1])] : [];
    });

type LootDefFn = (id: number) => { name: string; cost: number; stackable: boolean } | undefined;

export async function fetchLootQuotes(
    origin: string,
    scope: readonly number[],
    stop: () => boolean,
    market: Pick<MarketClient, 'item'> = new MarketClient(origin),
    now: () => number = Date.now,
): Promise<LootQuoteSnapshot> {
    if (!scope.length || scope.length > 16 || new Set(scope).size !== scope.length || scope.some(id => !Number.isSafeInteger(id) || id < 1 || !LOOT_IDS.includes(id))) {
        throw Error('invalid finite native quote scope');
    }
    if (stop()) throw Error('loot quotes stopped');
    const began = now();
    const quotes = await Promise.all(scope.map(id => market.item(id)));
    if (stop()) throw Error('loot quotes stopped');
    if (now() - began > 15000) throw Error('loot quote collection deadline');
    const prices: Record<number, { price: number; lastTradeAt: number }> = {};
    for (const [index, q] of quotes.entries()) {
        if (q.id !== scope[index] || !Number.isSafeInteger(q.lastPrice) || q.lastPrice! <= 0 || q.lastPrice! > 2147483647 || !Number.isSafeInteger(q.lastTradeAt) || q.lastTradeAt! < 0 || q.lastTradeAt! > now()) {
            throw Error('native GE last trade unavailable');
        }
        prices[q.id] = Object.freeze({ price: q.lastPrice!, lastTradeAt: q.lastTradeAt! });
    }
    return Object.freeze({ origin: new URL(origin).origin, observedAt: now(), prices: Object.freeze(prices) });
}

export function lootQuoteDefinition(
    snapshot: LootQuoteSnapshot,
    origin: string,
    definition: LootDefFn,
    now: () => number = Date.now,
    policy?: LootTripJob['policy'],
): LootDefFn {
    if (snapshot.origin !== new URL(origin).origin) throw Error('loot quote origin differs from session');
    if (!Number.isSafeInteger(snapshot.observedAt) || now() < snapshot.observedAt || now() - snapshot.observedAt > 60000) {
        throw Error('loot quote admission stale');
    }
    const prices = Object.fromEntries(
        Object.entries(snapshot.prices).map(([id, q]) => {
            if (!Number.isSafeInteger(q.price) || q.price < 1) throw Error('invalid native quote');
            return [id, q.price];
        }),
    );
    return id => {
        const d = definition(id);
        const cost = prices[id];
        if (!d) return undefined;
        if (cost !== undefined) return { ...d, cost };
        const listed = policy && policy.mode !== 'value' && lootListed({ id, name: d.name }, policy);
        return listed ? d : undefined;
    };
}

export function donorLootEligible(item: { id: number; name: string; count: number }, p: LootTripJob['policy'], definition: LootDefFn) {
    return lootMatches(item, p, definition(item.id), { donor: true });
}

export function lootTripOutputs(p: LootTripJob['policy'], definition: (id: number) => { name: string; cost: number; stackable: boolean } | undefined, donor = false) {
    if (
        !validLootFilters(p)
        || !Number.isSafeInteger(p.minimumValue)
        || p.minimumValue < 0
        || !Number.isSafeInteger(p.maximumValue)
        || p.maximumValue < 0
        || (!donor && p.maximumValue < p.minimumValue)
        || !Number.isSafeInteger(p.radius)
        || p.radius < 1
        || p.radius > 12
        || !Number.isSafeInteger(p.idleTicks)
        || p.idleTicks < 1
        || [...p.ids, ...(p.ignoredIds ?? [])].some(id => !LOOT_IDS.includes(id))
    ) {
        throw Error('invalid native bank-loot policy');
    }
    const names = new Set(p.names.map(n => n.toLowerCase()));
    const globs = new Set(p.nameGlobs ?? []);
    const found = new Set<string>();
    const outputs = LOOT_IDS.filter(id => {
        const d = definition(id);
        if (!d || typeof d.name !== 'string' || !Number.isSafeInteger(d.cost) || d.cost < 0 || typeof d.stackable !== 'boolean') return false;
        for (const name of names) if (name === d.name.toLowerCase()) found.add(name);
        for (const glob of globs) if (lootNameMatches(d.name, glob)) found.add(glob);
        return lootMatches({ id, name: d.name, count: 1 }, p, d, { donor, potential: true });
    });
    if ([...names, ...globs].some(n => !found.has(n)) || !outputs.length) throw Error('native loot names or outputs unresolved');
    return outputs;
}

export async function runLootTrip(s: CombatSession, j: LootTripJob, stop: () => boolean = () => false, quotes?: LootQuoteSnapshot) {
    const eatHold = holdSessionEater(s.sdk);
    try {
        const route: BankRouteJob = {
            family: 'looting',
            recipe: j.policy.mode,
            target: j.target,
            batch: j.batch,
            cap: j.cap,
            returnTicks: j.returnTicks,
            members: j.members,
            bank: j.bank,
            site: j.site,
        };
        validateBankRouteJob(route);
        const client = s.client as { objType: (id: number) => { name: string; cost: number; stackable: boolean } };
        let definition: LootDefFn = id => client.objType(id);
        if (j.valuation) {
            if (
                j.valuation.source !== 'native-ge-last-trade'
                || (j.valuation.thresholds !== undefined && j.valuation.thresholds !== 'donor')
                || !quotes
                || JSON.stringify([...j.valuation.ids].sort((a, b) => a - b)) !== JSON.stringify(Object.keys(quotes.prices).map(Number).sort((a, b) => a - b))
            ) {
                throw Error('prelogin quote snapshot must cover declared value scope');
            }
            definition = lootQuoteDefinition(quotes, s.sdk.config.browserLaunchUrl, definition, Date.now, j.policy);
        }
        const donor = j.valuation?.thresholds === 'donor';
        const outputs = lootTripOutputs(j.policy, definition, donor);
        const capacity = outputs.find(id => !definition(id)!.stackable) ?? outputs[0]!;
        const valueSource = j.valuation
            ? 'native GE last-trade snapshot for value branch; native static cost only for explicit unquoted list entries'
            : 'native static item cost; not GE price';
        const receipts: (Omit<Awaited<ReturnType<typeof runVisibleGroundLoot>>, 'staticValue'> & {
            staticValue?: number;
            quotedValue?: number;
            listedStaticValue?: number;
        })[] = [];
        const result = await runCombatBankProfile(
            s,
            route,
            {
                bank: j.bank,
                site: j.site,
                inputs: {},
                tools: [],
                outputs,
                capacityOutputs: { [capacity]: 1 },
                run: async (n, cap, halt) => {
                    const r = await runVisibleGroundLoot(
                        {
                            state: () => {
                                const st = s.sdk.getState();
                                return st ? { ...st, groundItems: st.groundItems.filter(i => outputs.includes(i.id) && (!donor || donorLootEligible(i, j.policy, definition))) } : st;
                            },
                            tick: () => s.tick(),
                            stop: halt,
                            definition,
                            pickup: async i => (await s.sdk.sendPickup(i.x, i.z, i.id)).success,
                            wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
                            step: () => waitTicks(s, 1),
                            clearModal: async () => {
                                await s.sdk.sendCloseModal();
                            },
                        },
                        { ...j.policy, ...(donor ? { mode: 'list' as const, ids: outputs, names: [], minimumValue: 0, maximumValue: 2147483647 } : {}), maximumUnits: n, cap },
                    );
                    const quotedValue = j.valuation ? Object.entries(r.acquired).reduce((sum, [id, v]) => sum + v * (quotes!.prices[Number(id)]?.price ?? 0), 0) : undefined;
                    receipts.push({
                        ...r,
                        valueSource,
                        staticValue: j.valuation ? undefined : r.staticValue,
                        quotedValue,
                        listedStaticValue: j.valuation ? r.staticValue - quotedValue! : undefined,
                    });
                    return r.units;
                },
            },
            () => stop() || existsSync('.practice/stop-all') || existsSync(`.practice/stop-${s.name}`),
        );
        const acquired: Record<number, number> = {};
        for (const r of receipts) for (const [id, v] of Object.entries(r.acquired)) acquired[Number(id)] = (acquired[Number(id)] ?? 0) + v;
        const reconciled = new Set([...Object.keys(acquired), ...Object.keys(result.banked)]);
        const exact = [...reconciled].every(id => (acquired[Number(id)] ?? 0) === (result.banked[Number(id)] ?? 0));
        return {
            ...result,
            ok: result.ok && exact,
            acquired,
            receipts,
            bankReconciled: exact,
            valueSource,
            thresholds: donor ? 'strict pile minimum and strict unit maximum' : 'inclusive whole-pile bounds',
            valuation: j.valuation ? quotes : undefined,
            attribution: 'visible native pickup and owned bank receipts; no kill-credit claim',
        };
    } finally {
        eatHold.release();
    }
}

export async function runLootTripCli(args: readonly string[], env: Record<string, string | undefined> = process.env) {
    const [name, file] = args;
    if (!name || !file) throw Error('usage: aio-fighter.ts loot-trip account job.json');
    const job = JSON.parse(readFileSync(file, 'utf8')) as LootTripJob;
    let stopped = false;
    process.once('SIGINT', () => {
        stopped = true;
    });
    process.once('SIGTERM', () => {
        stopped = true;
    });
    const stop = () => stopped || existsSync('.practice/stop-all') || existsSync(`.practice/stop-${name}`) || (!!env.STOP_FILE && existsSync(env.STOP_FILE));
    let quotes: LootQuoteSnapshot | undefined;
    if (job.valuation) {
        if (job.valuation.source !== 'native-ge-last-trade') throw Error('unsupported loot valuation');
        const { serverFromEnv } = await import('../../../core/src/bot');
        const { inProcessSdkConfig } = await import('../../../core/src/inprocess');
        const server = serverFromEnv(readFileSync(resolve(ROOT, `vendor/rs-sdk/bots/${name}/bot.env`), 'utf8'));
        const config = inProcessSdkConfig({ name, password: 'unused-read-only', server });
        quotes = await fetchLootQuotes(new URL(config.browserLaunchUrl!).origin, job.valuation.ids, stop);
    }
    if (stop()) throw Error('looter stopped before login');
    const s = await openBot(name);
    void s.ended.then(() => {
        stopped = true;
    });
    try {
        const r = await runLootTrip(s, job, stop, quotes);
        console.log('LOOT_TRIP ' + JSON.stringify(r));
        await finish([s], r.ok, JSON.stringify(r));
    } catch (error) {
        await finish([s], false, String(error));
    }
}
