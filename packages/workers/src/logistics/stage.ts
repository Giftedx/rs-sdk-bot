// Staging, owned bank loadouts, bank sorting, supply chains, and zero-resource supply bootstrap.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { serverFromEnv } from '../../../core/src/bot';
import { equipmentObserved } from '../../../core/src/container-observation';
import { depositObserved } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { isLocalServer } from '../../../core/src/localserver';
import { componentId } from '../../../core/src/logout';
import { resultCounters } from '../../../core/src/status';
import { questFoodDefinitions } from '../../../core/src/sustain';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { ownedAccounts } from '../../../core/src/tradeguard';
import { sessionWalker, walkPath } from '../../../core/src/walk';
import { workerSourceRevision } from '../../../core/src/worker-release';
import { parseConfigs } from '../../../knowledge/src/config';
import nativeItems from '../../../../knowledge/items.json';
import nativeTools from '../../../../knowledge/skill-tools.json';
import nativeSkills from '../../../../knowledge/skills.json';
import { ClientProt } from '../../../../vendor/rs-sdk/server/webclient/src/io/ClientProt';
import { executionContext } from '../../../../vendor/rs-sdk/sdk/execution-context';
import { FUND_AMOUNT, FUND_BELOW, FUND_RESERVE } from './trade-helpers';
import { REPO_ROOT } from './types';
import { leaveRuneStarter } from './walk-helpers';

// --- Owned Loadout & Setup Compiler ---

type Count = { id: number; count: number };
type Worn = Count & { slot: number };
export type OwnedKit = { bank: { x: number; z: number; level: number }; pack: Count[]; wear: Worn[]; cap: number; maximumMoves: number };
const contentDir = resolve(REPO_ROOT, 'vendor/rs-sdk/server/content') + '/';
const whole = (n: unknown, min = 0, max = 2147483647) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const canonical = (a: readonly Count[]) => Object.entries(a.reduce((m, i) => (m[i.id] = (m[i.id] ?? 0) + i.count, m), {} as Record<number, number>)).map(([id, count]) => ({ id: Number(id), count })).sort((a, b) => a.id - b.id);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const wornView = (a: readonly Worn[]) => a.map(i => ({ id: i.id, count: i.count, slot: i.slot })).sort((a, b) => a.slot - b.slot);
const itemCache = new Map<number, ReturnType<typeof readNativeKitItem>>();

export function nativeKitItem(id: number) {
    const cached = itemCache.get(id);
    if (cached) return cached;
    const item = readNativeKitItem(id);
    itemCache.set(id, item);
    return item;
}

function readNativeKitItem(id: number) {
    const items = nativeItems as { id: number; name: string; debugname: string; src: string; members: boolean }[];
    const packed = readFileSync(contentDir + 'pack/obj.pack', 'utf8').split(/\r?\n/).find(l => l.startsWith(id + '='))?.split('=')[1];
    const noted = !!packed?.startsWith('cert_');
    const item = items.find(i => noted ? i.debugname === packed!.slice(5) : i.id === id);
    if (!item || !whole(id)) throw Error('unknown native kit item ' + id);
    const block = readFileSync(contentDir + item.src.replace(/:\d+$/, ''), 'utf8').split('[' + item.debugname + ']')[1]?.split('\n[')[0];
    if (!block) throw Error('native item definition absent ' + id);
    const fields = (key: string) => block.match(new RegExp('^' + key + '=([^\\r\\n]+)', 'm'))?.[1];
    const slots: Record<string, number> = { hat: 0, back: 1, front: 2, righthand: 3, torso: 4, lefthand: 5, arms: 6, legs: 7, head: 8, hands: 9, feet: 10, jaw: 11, ring: 12, quiver: 13 };
    const slot = fields('wearpos'), extra = [fields('wearpos2'), fields('wearpos3')].filter((x): x is string => !!x);
    const styles = readFileSync(contentDir + 'scripts/skill_combat/scripts/player/player_attackstyles.rs2', 'utf8');
    const category = fields('category');
    const tab = [...styles.matchAll(/case ([\w, ]+) : ~weapon_category_tab_attack\((combat_\w+):preview/g)].find(m => m[1]!.split(/,\s*/).includes(category ?? ''))?.[2] ?? 'combat_unarmed';
    const styleIndices = [...styles.matchAll(new RegExp('\\[if_button,' + tab + ':[^\\]]+\\] ~set_attackstyle\\((\\d+)\\);', 'g'))].map(m => Number(m[1]));
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

export function validateOwnedKit(value: unknown): OwnedKit {
    const j = value as OwnedKit;
    if (!j || typeof j !== 'object' || !j.bank || ![j.bank.x, j.bank.z, j.bank.level].every(n => whole(n)) || j.bank.x > 16383 || j.bank.z > 16383 || j.bank.level > 3
        || !Array.isArray(j.pack) || !Array.isArray(j.wear) || j.pack.length > 28 || j.wear.length > 14 || !whole(j.cap, 120, 2000) || !whole(j.maximumMoves, 64, 256)) {
        throw Error('invalid finite owned kit');
    }
    if (new Set(j.pack.map(i => i.id)).size !== j.pack.length || new Set(j.wear.map(i => i.slot)).size !== j.wear.length) {
        throw Error('duplicate kit item or worn slot');
    }
    for (const row of [...j.pack, ...j.wear]) {
        if (!row || !whole(row.id) || !whole(row.count, 1)) throw Error('invalid kit quantity');
    }
    const occupied = new Set<number>();
    for (const row of j.wear) {
        const item = nativeKitItem(row.id);
        if (!whole(row.slot, 0, 13) || item.slot !== row.slot || item.noted || !item.stackable && row.count !== 1) {
            throw Error('native worn slot/count mismatch ' + row.id);
        }
        for (const slot of item.occupies) {
            if (slot === undefined || occupied.has(slot)) throw Error('conflicting native worn slots/two-handed shield');
            occupied.add(slot);
        }
    }
    for (const row of j.pack) nativeKitItem(row.id);
    return j;
}

export function loadoutStopRequested(actor: string, stop: () => boolean = () => false, exists: (p: string) => boolean = existsSync) {
    return stop() || exists('.practice/stop-all') || exists(`.practice/stop-${actor}`) || !!process.env.STOP_FILE && exists(process.env.STOP_FILE);
}

async function withdrawObservedUnnoted(s: Session, id: number, amount: number) {
    const count = () => s.sdk.getInventory().filter(i => i.id === id).reduce((v, i) => v + i.count, 0);
    const before = count();
    const observed = s.bankObservation?.(), summary = observed?.items.find(i => i.id === id), item = s.sdk.getState()?.bank.items.find(i => i.id === id);
    if (!summary || !item || summary.count < amount || item.count < amount || summary.count !== item.count) {
        throw new Error(`owned bank item/count unknown ${id}:${amount}`);
    }
    if (!(await s.bot.withdrawItem(item, amount, { asNote: false })).success || !await waitUntil(s, () => count() === before + amount, { timeoutTicks: 10 })) {
        throw new Error(`owned withdrawal unobserved ${id}:${amount}`);
    }
}

export async function runOwnedLoadout(s: Session, value: unknown, requestStop: () => boolean = () => false) {
    const j = validateOwnedKit(value), start = s.tick(), state = () => s.sdk.getState(), inv = () => s.sdk.getInventory(), gear = () => s.sdk.getEquipment(), first = state()?.player;
    const life = first?.lifeId, respawns = first?.respawnCount ?? 0, hp = s.sdk.getSkill('Hitpoints')?.level ?? 0, client = s.client as any, executor = client.executeBotAction;
    const xpView = () => state()?.skills.map(i => ({ name: i.name, experience: i.experience, baseLevel: i.baseLevel }));
    const xp = JSON.stringify(xpView());
    const controls = () => ({ retaliate: state()?.autoRetaliateEnabled, prayers: state()?.prayers?.activePrayers, style: state()?.combatStyle?.currentStyle });
    const initialControls = JSON.parse(JSON.stringify(controls())), initialWear = wornView(gear());
    let ended = false, moves = 0, uncertain = false, baseline: Count[] | undefined, bankGeneration = -1, changed = false, failure = '', recovered = false, noOp = false, initialNote: boolean | undefined, bankModeRestored = false;
    void s.ended?.then(() => { ended = true; });
    const held = (id: number) => inv().filter(i => i.id === id).reduce((a, i) => a + i.count, 0);
    const stored = (id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((a, i) => a + i.count, 0);
    const here = () => { const p = state()?.player; return !!p && p.level === j.bank.level && Math.max(Math.abs(p.worldX - j.bank.x), Math.abs(p.worldZ - j.bank.z)) <= 3; };
    const fatal = () => ended || !first || !state()?.player || state()!.player!.isDead || state()!.player!.lifeId !== life || (state()!.player!.respawnCount ?? 0) !== respawns
        || !here() || (s.sdk.getSkill('Hitpoints')?.level ?? 0) !== hp || hp < 1 || s.sdk.getStateAge() > 5000 || client.executeBotAction !== executor || !equipmentObserved(client) || JSON.stringify(xpView()) !== xp;
    const guard = (cleanup = false) => {
        if (fatal() || s.tick() - start >= j.cap || moves >= j.maximumMoves || !cleanup && (loadoutStopRequested(s.name ?? '', requestStop) || s.tick() - start >= j.cap - 40 || moves >= j.maximumMoves - 32)) {
            throw Error('owned loadout life/state/stop/budget');
        }
    };
    const assets = () => {
        const bank = s.bankObservation?.();
        if (!state()?.bank.isOpen || !bank) throw Error('owned loadout fresh bank observation absent');
        return canonical([...inv(), ...gear(), ...bank.items].map(i => ({ id: client.objType(i.id)?.certtemplate >= 0 ? client.objType(i.id).certlink : i.id, count: i.count })));
    };
    const conserved = () => !!baseline && same(assets(), baseline);
    const close = async (cleanup = false) => {
        guard(cleanup);
        bankGeneration = Math.max(bankGeneration, s.bankObservation?.()?.generation ?? -1);
        await s.sdk.sendCloseModal();
        if (!await waitUntil(s, () => !state()?.bank.isOpen, { timeoutTicks: 8 })) throw Error('owned loadout bank close unobserved');
        guard(cleanup);
    };
    const open = async (cleanup = false) => {
        guard(cleanup);
        if (state()?.bank.isOpen) await close(cleanup);
        const result = await s.bot.openBank();
        if (!await waitUntil(s, () => { if (fatal()) throw Error('owned loadout lost original session'); return !!state()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > bankGeneration; }, { timeoutTicks: 12 }) || !state()?.bank.isOpen || !s.bankObservation?.()) {
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
        try { await action(); } catch (e) { error = e; }
        const remaining = 10 - (s.tick() - at);
        if (!effect() && remaining > 0) {
            await waitUntil(s, () => { if (fatal()) throw Error('owned loadout original life/input owner lost'); return effect(); }, { timeoutTicks: remaining });
        }
        if (!effect()) throw Error('owned loadout asset action unknown; no retry ' + String(error ?? ''));
        uncertain = false;
    };
    const deposit = async (cleanup = false) => {
        for (const id of new Set(inv().map(i => i.id))) {
            guard(cleanup);
            const row = inv().find(i => i.id === id)!;
            await move(() => depositObserved(s, row), () => held(id) === 0 && conserved(), cleanup);
        }
    };
    const withdraw = async (id: number, n: number, cleanup = false) => {
        guard(cleanup);
        const item = nativeKitItem(id), base = item.baseId, before = held(id), old = stored(base), generation = s.bankObservation!()!.generation;
        await move(async () => {
            if (!item.noted) return withdrawObservedUnnoted(s, id, n);
            const row = state()?.bank.items.find(i => i.id === base);
            if (!row || stored(base) !== row.count || row.count < n) throw Error('owned noted bank stock unknown');
            await s.bot.withdrawItem(row, n, { asNote: true });
        }, () => held(id) === before + n && stored(base) === old - n && (s.bankObservation?.()?.generation ?? -1) > generation && conserved(), cleanup);
    };
    const removeAll = async (cleanup = false) => {
        if (state()?.bank.isOpen) await close(cleanup);
        for (const row of [...gear()]) {
            const before = held(row.id), old = canonical([...inv(), ...gear()]);
            await move(() => s.bot.unequipItem(row), () => !gear().some(i => i.slot === row.slot) && held(row.id) === before + row.count && same(canonical([...inv(), ...gear()]), old), cleanup);
        }
        await open(cleanup);
        await deposit(cleanup);
    };
    const equip = async (row: Worn, cleanup = false) => {
        await withdraw(row.id, row.count, cleanup);
        await close(cleanup);
        const item = inv().find(i => i.id === row.id)!, before = held(row.id), old = canonical([...inv(), ...gear()]);
        await move(() => s.bot.equipItem(item), () => gear().some(i => i.slot === row.slot && i.id === row.id && i.count === row.count) && held(row.id) === before - row.count && same(canonical([...inv(), ...gear()]), old), cleanup);
        await open(cleanup);
        if (!conserved()) throw Error('owned loadout equip bank conservation failed');
    };
    const restoreStyle = async (cleanup = false) => {
        guard(cleanup);
        const expected = initialControls.style, style = () => state()?.combatStyle, weapon = gear().find(i => i.slot === 3), tab = weapon ? nativeKitItem(weapon.id).styleTab : componentId('combat_unarmed');
        const ready = () => { const observed = style(); return observed?.known === true && observed.tabInterfaceId === tab && observed.styles.some(i => i.index === expected); };
        if (!await waitUntil(s, () => fatal() || ready(), { timeoutTicks: 8 }) || fatal() || !ready()) throw Error('owned loadout target native combat style unavailable');
        if (style()?.currentStyle === expected) return;
        await close(cleanup);
        await s.sdk.sendSetCombatStyle(expected);
        if (!await waitUntil(s, () => fatal() || ready() && style()?.currentStyle === expected, { timeoutTicks: 8 }) || fatal() || !ready() || style()?.currentStyle !== expected) {
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
            const item = nativeKitItem(row.id), native = client.objType(row.id);
            if (item.noted && (!native || !Number.isSafeInteger(native.certtemplate) || native.certtemplate < 0 || native.certlink !== item.baseId)) {
                throw Error('native noted identity mismatch');
            }
        }
        const need = canonical([...j.pack, ...j.wear].map(i => ({ id: nativeKitItem(i.id).baseId, count: i.count })));
        if (need.some(i => (baseline!.find(x => x.id === i.id)?.count ?? 0) < i.count)) throw Error('owned loadout stock missing before withdrawals');
        const slots = j.pack.reduce((n, i) => {
            const t = client.objType(i.id);
            if (typeof t?.stackable !== 'boolean') throw Error('native stackability unknown');
            return n + (t.stackable ? 1 : i.count);
        }, 0);
        if (slots > 28) throw Error('owned loadout exact pack exceeds28 slots');
        if ([...j.pack, ...j.wear].some(i => nativeKitItem(i.id).members && client.membersAccount !== 1)) throw Error('owned loadout member item requires observed member account');
        const targetWeapon = j.wear.find(i => i.slot === 3), targetStyles = targetWeapon ? nativeKitItem(targetWeapon.id).styleIndices : [0, 1, 2];
        if (!targetStyles.includes(initialControls.style)) throw Error('owned loadout original style incompatible with target native weapon table');
        noOp = same(canonical(inv()), canonical(j.pack)) && same(wornView(gear()), wornView(j.wear));
        if (!noOp) {
            await deposit();
            await removeAll();
            for (const row of j.wear) await equip(row);
            await restoreStyle();
            for (const row of j.pack) await withdraw(row.id, row.count);
        }
        guard();
        if (!same(canonical(inv()), canonical(j.pack)) || !same(wornView(gear()), wornView(j.wear)) || !conserved() || !same(controls(), initialControls)) {
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
                if (!await waitUntil(s, () => fatal() || state()?.bank.noteMode === initialNote, { timeoutTicks: 8 }) || fatal()) {
                    throw Error('owned loadout original bank note mode unconfirmed');
                }
            }
            bankModeRestored = state()!.bank.noteMode === initialNote;
        }
    } catch (e) {
        failure ||= String(e);
    }
    let balanced = false;
    try { if (state()?.bank.isOpen && s.bankObservation?.() && baseline) balanced = conserved(); } catch { /* ignore */ }
    const exactPack = same(canonical(inv()), canonical(j.pack)), exactWear = same(wornView(gear()), wornView(j.wear)), controlsPreserved = same(controls(), initialControls);
    try { if (!fatal() && state()?.bank.isOpen) await close(true); } catch (e) { failure ||= String(e); }
    return { ok: !failure && !uncertain && balanced && exactPack && exactWear && controlsPreserved && bankModeRestored, failure, exactPack, exactWear, balanced, controlsPreserved, bankModeRestored, noOp, recovered, recoveryDeferred: uncertain, moves, ticks: s.tick() - start, scope: 'one declared owned exact bank kit, including native notes; no travel or acquisition' };
}

export interface SetupBindings {
    items: Record<string, number>;
    bank: OwnedKit['bank'];
    cap: number;
    maximumMoves: number;
    packPolicy: 'exact-counts';
    setupName?: string;
}

type ObjectRow = Record<string, unknown>;
const asObject = (value: unknown): ObjectRow => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('donor setup/bindings object required');
    return value as ObjectRow;
};
const isWhole = (value: unknown, min = 0, max = 2147483647): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const rowFields = new Set(['id', 'q', 'f', 'sc', 'l', 's', 'name']);
const setupFields = new Set(['inv', 'eq', 'rp', 'bp', 'qv', 'afi', 'name', 'notes', 'hc', 'hd', 'dc', 'fb', 'uh', 'sb', 'fv', 'iId']);

export function compileInventorySetup(input: unknown, nativeBindings: unknown): OwnedKit {
    const declaration = asObject(nativeBindings), items = asObject(declaration.items);
    if (declaration.packPolicy !== 'exact-counts' || Object.keys(items).length > 128) throw Error('native setup requires exact-counts policy and bounded item bindings');
    for (const [id, native] of Object.entries(items)) if (!/^(0|[1-9]\d*)$/.test(id) || !isWhole(Number(id)) || !isWhole(native)) throw Error('invalid explicit native item binding');
    if (declaration.setupName !== undefined && (typeof declaration.setupName !== 'string' || !declaration.setupName.trim() || declaration.setupName.length > 256)) throw Error('invalid setup name selector');
    if (Array.isArray(input)) {
        if (input.length > 64 || !declaration.setupName) throw Error('portable list requires an exact setup name');
        const matching = input.filter(value => { const row = asObject(value), setup = Object.hasOwn(row, 'setup') ? asObject(row.setup) : row; return setup.name === declaration.setupName; });
        if (matching.length !== 1) throw Error('setup name missing or ambiguous');
        input = matching[0];
    }
    const root = asObject(input), portable = Object.hasOwn(root, 'setup');
    if (portable && Object.keys(root).some(k => !['setup', 'layout'].includes(k))) throw Error('ambiguous portable setup fields');
    const setup = portable ? asObject(root.setup) : root;
    if (declaration.setupName !== undefined && setup.name !== declaration.setupName) throw Error('setup name does not match selector');
    for (const key of Object.keys(setup)) if (!setupFields.has(key)) throw Error('unsupported donor setup field ' + key);
    if (setup.sb != null && ![0, 4].includes(setup.sb as number)) throw Error('donor spellbook has no native loadout equivalent');

    const decode = (value: unknown) => {
        if (value === null) return null;
        const row = asObject(value);
        for (const key of Object.keys(row)) if (!rowFields.has(key)) throw Error('unsupported donor item field ' + key);
        if (row.f != null && row.f !== false || row.l != null && row.l !== false || row.sc != null && !['None', 'Standard'].includes(row.sc as string)) {
            throw Error('fuzzy, locked or inequality setup policy needs a native consumer');
        }
        if (row.s != null && !isWhole(row.s, -1, 27)) throw Error('invalid donor item slot');
        if (row.id === -1) { if (row.q != null && row.q !== 0) throw Error('invalid donor empty item'); return null; }
        if (!isWhole(row.id) || !isWhole(row.q ?? 1, 1)) throw Error('invalid donor item ID/quantity');
        return { id: row.id, count: (row.q ?? 1) as number, slot: (row.s ?? -1) as number };
    };
    for (const key of ['rp', 'bp', 'qv']) if (setup[key] != null) {
        const rows = setup[key];
        if (!Array.isArray(rows) || rows.length > 28 || rows.some(row => decode(row) !== null)) throw Error('unsupported native special container ' + key);
    }
    if (setup.afi != null && Object.keys(asObject(setup.afi)).length) throw Error('additional filtered items need a separate native policy');
    const pack: OwnedKit['pack'] = [], wear: OwnedKit['wear'] = [];
    for (const [kind, max] of [['inv', 28], ['eq', 14]] as const) {
        const rows = setup[kind];
        if (!Array.isArray(rows) || rows.length > max) throw Error('donor inventory/equipment list missing or too large');
        const occupied = new Set<number>();
        rows.forEach((value, index) => {
            const source = decode(value);
            if (!source) return;
            const sourceSlot = source.slot < 0 ? index : source.slot;
            if (sourceSlot >= max || occupied.has(sourceSlot)) throw Error('duplicate or invalid donor source slot');
            occupied.add(sourceSlot);
            if (!Object.hasOwn(items, String(source.id))) throw Error('donor item ' + source.id + ' needs explicit native binding');
            const id = items[String(source.id)] as number, item = nativeKitItem(id);
            if (kind === 'eq') {
                if (item.slot === undefined || item.noted) throw Error('native item cannot be worn ' + id);
                wear.push({ id, count: source.count, slot: item.slot });
            } else {
                const existing = pack.find(row => row.id === id);
                if (existing) existing.count += source.count;
                else pack.push({ id, count: source.count });
            }
        });
    }
    pack.sort((a, b) => a.id - b.id);
    wear.sort((a, b) => a.slot - b.slot);
    const kit = validateOwnedKit({ bank: declaration.bank, cap: declaration.cap, maximumMoves: declaration.maximumMoves, pack, wear });
    if (pack.reduce((n, row) => n + (nativeKitItem(row.id).stackable ? 1 : row.count), 0) > 28) throw Error('native setup exceeds28 inventory slots');
    return kit;
}

// --- Native Bank Sort ---

export type BankSortRow = { slot: number; id: number; name: string; count: number };
export type BankSortObservation = { generation: number; mode: 0 | 1; rows: BankSortRow[] };
export interface BankSortDriver {
    tick(): number;
    unsafe(): string;
    observe(): BankSortObservation | null;
    drag(from: number, to: number, before: BankSortRow[]): Promise<boolean>;
    wait(predicate: () => boolean, ticks: number): Promise<boolean>;
}
const order = (rows: readonly BankSortRow[]) => JSON.stringify([...rows].sort((a, b) => a.slot - b.slot).map(i => [i.slot, i.id, i.count]));
function validateSortRows(rows: readonly BankSortRow[]) {
    if (rows.length > 576 || new Set(rows.map(i => i.slot)).size !== rows.length || new Set(rows.map(i => i.id)).size !== rows.length
        || rows.some(i => !Number.isSafeInteger(i.slot) || i.slot < 0 || i.slot >= 576 || !Number.isSafeInteger(i.id) || i.id < 0 || !Number.isSafeInteger(i.count) || i.count < 1 || i.count > 2147483647 || typeof i.name !== 'string' || !i.name.trim())) {
        throw Error('bank rows unknown or ambiguous');
    }
}
export type BankSortPolicy = 'name' | 'donor';
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const categories = ['Currency', 'Teleportation', 'Potions', 'Food', 'Runes', 'Ammunition', 'Weapon-Melee', 'Weapon-Ranged', 'Weapon-Magic', 'Armour-Helmet', 'Armour-Cape', 'Armour-Amulet', 'Armour-Body', 'Armour-Legs', 'Armour-Shield', 'Armour-Gloves', 'Armour-Boots', 'Armour-Ring', 'Tool-Pickaxe', 'Tool-Axe', 'Tool-Fishing', 'Tool-Other', 'Skilling-Resource-Gem', 'Skilling-Resource-Log', 'Skilling-Resource-Ore', 'Skilling-Resource-Bar', 'Skilling-Resource-Herb', 'Skilling-Resource-Seed', 'Skilling-Resource-Fish', 'Skilling-Resource-Other', 'Clue-Scrolls', 'Quest-Items', 'Cosmetic/Holiday', 'Miscellaneous'];
const runeOrder = ['air', 'mind', 'water', 'earth', 'fire', 'body', 'cosmic', 'chaos', 'nature', 'law', 'death', 'blood', 'soul'].map(n => n + ' rune');
const pieces = ['helm', 'full helm', 'hood', 'coif', 'mask', 'cape', 'cloak', 'amulet', 'necklace', 'top', 'platebody', 'body', 'robe top', 'legs', 'platelegs', 'skirt', 'chaps', 'robe bottom', 'kiteshield', 'sq shield', 'shield', 'book', 'gloves', 'gauntlets', 'vambraces', 'boots', 'ring'];
type NativeSortData = { category: string; level: number; stage: number };
let nativeSortData: Map<number, NativeSortData> | undefined;

function sortData() {
    if (nativeSortData) return nativeSortData;
    const data = new Map<number, NativeSortData>();
    const names = new Map(nativeItems.map(i => [i.debugname, i.id]));
    const byId = new Map(nativeItems.map(i => [i.id, i]));
    const put = (id: number, category: string, level: number, stage: number) => {
        if (Number.isFinite(level)) data.set(id, { category, level, stage });
    };
    for (const r of nativeSkills) {
        for (const output of r.outputs) {
            const id = names.get(output);
            if (id === undefined || r.level === null) continue;
            if (r.skill === 'woodcutting') put(id, 'Skilling-Resource-Log', r.level, 0);
            if (r.skill === 'mining' && /ore|coal|clay/.test(output)) put(id, 'Skilling-Resource-Ore', r.level, 0);
        }
    }
    const smelting = resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/scripts/skill_smithing/configs/smelting/smelting.struct');
    for (const b of parseConfigs(readFileSync(smelting, 'utf8'), smelting)) {
        const p = Object.fromEntries((b.props.param ?? []).map(v => v.split(',', 2)));
        const id = names.get(p.product ?? '');
        if (id !== undefined) put(id, 'Skilling-Resource-Bar', Number(p.levelrequired), 1);
    }
    const gemLevels: readonly [string, number][] = [
        ['sapphire', 20], ['emerald', 27], ['ruby', 34], ['diamond', 43],
        ['dragonstone', 55], ['opal', 1], ['jade', 13], ['red_topaz', 16],
    ];
    for (const [gem, level] of gemLevels) {
        const uncut = names.get('uncut_' + gem), cut = names.get(gem);
        if (uncut !== undefined) put(uncut, 'Skilling-Resource-Gem', level, 0);
        if (cut !== undefined) put(cut, 'Skilling-Resource-Gem', level, 1);
    }
    const blocks = (file: string) => [...readFileSync(resolve(contentDir, file), 'utf8').matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)].map(m => ({ name: m[1]!, body: m[2]! }));
    const paramOf = (body: string, key: string) => body.match(new RegExp('^param=' + key + ',(.+)$', 'm'))?.[1]?.trim();
    const herbs = blocks('scripts/skill_herblore/configs/herbs.obj');
    const identifyText = readFileSync(resolve(contentDir, 'scripts/skill_herblore/scripts/identifying/identify.rs2'), 'utf8');
    for (const m of identifyText.matchAll(/\[opheld1,([^\]]+)\]\s*~attempt_identify_herb\((\w+),/g)) {
        const herb = herbs.find(r => r.name === m[2]);
        const level = Number(paramOf(herb?.body ?? '', 'identified_herb_level') ?? 3);
        const unidId = names.get(m[1]!), idId = names.get(m[2]!);
        if (unidId !== undefined) put(unidId, 'Skilling-Resource-Herb', level, 0);
        if (idId !== undefined) put(idId, 'Skilling-Resource-Herb', level, 1);
    }
    const brewing = resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/scripts/skill_herblore/configs/brewing/brew_potion');
    const params = (b: { props: Record<string, string[]> }) => Object.fromEntries((b.props.param ?? []).map(v => v.split(',', 2)));
    const defaultLevel = Number(parseConfigs(readFileSync(brewing + '.param', 'utf8'), brewing + '.param').find(b => b.name === 'brew_potion_level')?.props.default?.[0]);
    const families = new Map<string, NativeSortData>(), objects = new Map<string, ReturnType<typeof parseConfigs>>();
    const itemBlocks = (id: number) => {
        const path = resolve(REPO_ROOT, 'vendor/rs-sdk/server/content') + '/' + byId.get(id)!.src.replace(/:\d+$/, '');
        if (!objects.has(path)) objects.set(path, parseConfigs(readFileSync(path, 'utf8'), path));
        return objects.get(path)!;
    };
    for (const b of parseConfigs(readFileSync(brewing + '.struct', 'utf8'), brewing + '.struct')) {
        const p = params(b), id = names.get(p.brew_potion_mixture ?? '');
        if (id === undefined) continue;
        const level = Number(p.brew_potion_level ?? defaultLevel), stage = p.brew_potion_solvent === 'vial_water' ? 2 : 4;
        put(id, 'Potions', level, stage);
        const obj = itemBlocks(id).find(o => o.name === byId.get(id)!.debugname), family = obj && params(obj).decant_potion_enum;
        if (family) families.set(family, { category: 'Potions', level, stage });
    }
    for (const file of objects.values()) {
        for (const b of file) {
            const id = names.get(b.name), family = params(b).decant_potion_enum, value = family && families.get(family);
            if (id !== undefined && value && !data.has(id)) data.set(id, value);
        }
    }
    const byName = new Map<string, NativeSortData[]>();
    for (const [id, value] of data) {
        const name = byId.get(id)!.name.toLowerCase();
        byName.set(name, [...(byName.get(name) ?? []), value]);
    }
    for (const item of nativeItems) {
        const name = item.name.toLowerCase(), values = byName.get(name);
        if (values?.length && !data.has(item.id) && !/(?:^herb$|potion)/.test(name) && values.every(v => JSON.stringify(v) === JSON.stringify(values[0]))) {
            data.set(item.id, values[0]!);
        }
    }
    nativeSortData = data;
    return data;
}

export function bankDonorKey(row: BankSortRow) {
    const native = nativeItems.find(i => i.id === row.id);
    if (!native) throw Error('donor policy needs native item metadata');
    const name = native.name.toLowerCase().trim(), suffix = name.match(/^(.*?)\s*\((\d+)\)$/), base = suffix ? suffix[1]! : name, dose = suffix ? Number(suffix[2]) : -1;
    const has = (re: RegExp) => re.test(base), mapped = sortData().get(row.id);
    let category = mapped?.category ?? 'Miscellaneous';
    if (!mapped) {
        if (has(/coins/)) category = 'Currency';
        else if (has(/^(?:ring of dueling|games necklace|enchanted lyre)$/) || (base === 'amulet of glory' && dose > 0)) category = 'Teleportation';
        else if (has(/potion/) || /dose/.test(native.debugname)) category = 'Potions';
        else if (questFoodDefinitions().has(row.id) || has(/shark|karambwan|cake|pie|stew|pizza|bread/)) category = 'Food';
        else if (name.endsWith(' rune')) category = 'Runes';
        else if (has(/dart|arrow|bolts|javelin|throwing axe|knife|cannonball/)) category = 'Ammunition';
        else if (has(/pickaxe/)) category = 'Tool-Pickaxe';
        else if (has(/ axe/) && !has(/battleaxe|throwing axe/)) category = 'Tool-Axe';
        else if (has(/harpoon|fishing rod|lobster pot|fishing net|fishing bait|feather/)) category = 'Tool-Fishing';
        else if (has(/tinderbox|chisel|hammer|spade|glassblowing pipe/)) category = 'Tool-Other';
        else if (has(/staff|book of/)) category = 'Weapon-Magic';
        else if (has(/shortbow|longbow|crossbow/)) category = 'Weapon-Ranged';
        else if (has(/scimitar|sword|dagger|mace|warhammer|battleaxe|halberd|spear|claws/)) category = 'Weapon-Melee';
        else if (has(/helm|coif|hood|mask/)) category = 'Armour-Helmet';
        else if (has(/cape|cloak/)) category = 'Armour-Cape';
        else if (has(/amulet|necklace|symbol/)) category = 'Armour-Amulet';
        else if (has(/platebody|chainbody|body|robe top|apron/)) category = 'Armour-Body';
        else if (has(/platelegs|plateskirt|legs|skirt|chaps|robe bottom/)) category = 'Armour-Legs';
        else if (has(/shield/) && !has(/dwarf weed/)) category = 'Armour-Shield';
        else if (has(/gloves|gauntlets|vambraces/)) category = 'Armour-Gloves';
        else if (has(/boots/)) category = 'Armour-Boots';
        else if (has(/ring/) && !has(/ring of dueling/)) category = 'Armour-Ring';
        else if (has(/ logs$/)) category = 'Skilling-Resource-Log';
        else if (has(/ ore$/)) category = 'Skilling-Resource-Ore';
        else if (has(/ bar$/)) category = 'Skilling-Resource-Bar';
        else if (has(/ seeds?$/)) category = 'Skilling-Resource-Seed';
        else if (has(/^raw |^cooked /)) category = 'Skilling-Resource-Fish';
        else if (has(/bone|ashes|hide|fleece|essence|vial|eye of newt|limpwurt root|snape grass|bucket of/)) category = 'Skilling-Resource-Other';
        else if (has(/clue scroll/) || /^trail_clue_.*_casket/.test(native.debugname)) category = 'Clue-Scrolls';
        else if (has(/key/) && !has(/crystal key/)) category = 'Quest-Items';
        else if (has(/event|holiday|cosmetic|santa hat|partyhat/)) category = 'Cosmetic/Holiday';
    }
    const material = ['bronze', 'iron', 'steel', 'black', 'mithril', 'adamant', 'rune', 'dragon'].find(x => base.includes(x));
    const tiers: Record<string, number> = { bronze: 1, iron: 10, steel: 20, black: 25, mithril: 30, adamant: 40, rune: 50, dragon: 60 };
    const tool = [...nativeTools.axes.map(t => ({ id: t.id, level: t.paramLevelrequire })), ...nativeTools.pickaxes.map(t => ({ id: t.id, level: t.miningLevel }))].find(t => t.id === row.id);
    const tier = category === 'Tool-Axe' || category === 'Tool-Pickaxe' ? (tool?.level ?? (material ? tiers[material]! : -1)) : (material ? tiers[material]! : -1);
    return {
        row,
        name,
        base,
        dose,
        category,
        tier,
        level: mapped?.level ?? 0,
        stage: mapped?.stage ?? (category === 'Skilling-Resource-Fish' ? (base.startsWith('raw') ? 0 : 1) : ['Skilling-Resource-Ore', 'Skilling-Resource-Log', 'Skilling-Resource-Seed'].includes(category) ? 0 : category === 'Skilling-Resource-Bar' ? 1 : category === 'Potions' ? 4 : /eye of newt|limpwurt root/.test(base) ? 3 : 99),
        workflow: category === 'Potions' || category.startsWith('Skilling-Resource-'),
    };
}

export function bankNameSimilarity(a: string, b: string) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    const distance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1), x = new Set<number>(), y = new Set<number>();
    for (let i = 0; i < a.length; i++) for (let j = Math.max(0, i - distance); j < Math.min(b.length, i + distance + 1); j++) if (!y.has(j) && a[i] === b[j]) { x.add(i); y.add(j); break; }
    const matches = x.size;
    if (!matches) return 0;
    const right = [...y].sort((u, v) => u - v);
    let swaps = 0;
    [...x].forEach((i, k) => { if (a[i] !== b[right[k]!]) swaps++; });
    const jaro = (matches / a.length + matches / b.length + (matches - swaps / 2) / matches) / 3;
    if (jaro < .7) return jaro;
    let prefix = 0;
    while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
    return Math.min(1, jaro + prefix * .1 * (1 - jaro));
}

type SortKey = ReturnType<typeof bankDonorKey>;
const baseOrder = (a: SortKey, b: SortKey) => compare(a.base, b.base) || b.dose - a.dose || compare(a.name, b.name) || a.row.slot - b.row.slot;
function fuzzyGroup(input: SortKey[]) {
    const cache = new Map<string, number>();
    const sim = (a: string, b: string) => { const key = a + '\0' + b; let v = cache.get(key); if (v === undefined) { v = bankNameSimilarity(a, b); cache.set(key, v); } return v; };
    const similarity = (a: SortKey, b: SortKey) => {
        let word = 0, matched = 0;
        const aa = a.base.split(/\s+/), bb = b.base.split(/\s+/);
        if (aa.length > 1 && bb.length > 1) for (const x of aa.filter(w => w.length > 2)) { const best = Math.max(0, ...bb.filter(w => w.length > 2).map(y => sim(x, y))); if (best > .95) matched++; word = Math.max(word, best); }
        if (matched >= 2) word = Math.min(1, word + .15);
        return Math.max(sim(a.name, b.name), sim(a.base, b.base), word);
    };
    const clusters: { centroid: SortKey; items: SortKey[] }[] = [];
    for (const item of [...input].filter(i => i.tier < 0).sort((a, b) => compare(a.name, b.name) || a.row.slot - b.row.slot)) {
        let best: typeof clusters[number] | undefined, score = 0;
        for (const c of clusters) {
            if (c.items.length >= 30 || !(item.dose >= 0 && item.base === c.centroid.base) && similarity(c.centroid, item) <= .95) continue;
            const match = Math.max(...c.items.map(i => similarity(i, item)));
            if (match > score) { best = c; score = match; }
        }
        if (best) best.items.push(item);
        else clusters.push({ centroid: item, items: [item] });
    }
    for (const item of input.filter(i => i.tier >= 0)) clusters.push({ centroid: item, items: [item] });
    for (const c of clusters) c.items.sort(baseOrder);
    return clusters.sort((a, b) => compare(a.items[0]!.base, b.items[0]!.base) || a.items[0]!.row.slot - b.items[0]!.row.slot).flatMap(c => c.items);
}

export function sortBankRows(rows: readonly BankSortRow[], policy: BankSortPolicy = 'name'): BankSortRow[] {
    validateSortRows(rows);
    if (!['name', 'donor'].includes(policy)) throw Error('unknown bank sort policy');
    let sorted: BankSortRow[];
    if (policy === 'name') {
        sorted = [...rows].sort((a, b) => compare(a.name.toLowerCase(), b.name.toLowerCase()) || a.slot - b.slot);
    } else {
        const keys = rows.map(bankDonorKey), workflow = keys.filter(k => k.workflow).sort((a, b) => a.level - b.level || a.stage - b.stage || baseOrder(a, b)), out: SortKey[] = [];
        for (const category of categories) {
            if (category === 'Potions') { out.push(...workflow); continue; }
            const group = keys.filter(k => !k.workflow && k.category === category);
            if (/^(Tool|Weapon|Armour)-/.test(category) || category === 'Runes') {
                group.sort((a, b) => {
                    if (category === 'Runes') {
                        const ai = runeOrder.indexOf(a.name), bi = runeOrder.indexOf(b.name);
                        if (ai !== bi) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
                    } else {
                        if (a.tier !== b.tier) return b.tier - a.tier;
                        if (category.startsWith('Armour-')) {
                            const ai = pieces.findIndex(p => a.base.includes(p)), bi = pieces.findIndex(p => b.base.includes(p));
                            if (ai !== bi) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
                        }
                    }
                    return baseOrder(a, b);
                });
            } else {
                group.splice(0, group.length, ...fuzzyGroup(group));
            }
            out.push(...group);
        }
        sorted = out.map(k => k.row);
        if (sorted.length !== rows.length) throw Error('bank policy omitted a native item');
    }
    return sorted.map((i, slot) => ({ ...i, slot }));
}

export function bankMove(rows: readonly BankSortRow[], from: number, to: number, mode: 0 | 1) {
    validateSortRows(rows);
    if (!Number.isSafeInteger(to) || to < 0 || to >= 576 || !rows.some(i => i.slot === from) || from === to || ![0, 1].includes(mode)) throw Error('invalid native bank move');
    return rows.map(i => ({ ...i, slot: i.slot === from ? to : mode === 0 ? (i.slot === to ? from : i.slot) : from > to && i.slot >= to && i.slot < from ? i.slot + 1 : from < to && i.slot > from && i.slot <= to ? i.slot - 1 : i.slot })).sort((a, b) => a.slot - b.slot);
}

export async function runFlatBankSort(d: BankSortDriver, o: { cap: number; maxMoves: number; policy?: BankSortPolicy }) {
    if (!Number.isSafeInteger(o.cap) || o.cap < 1 || !Number.isSafeInteger(o.maxMoves) || o.maxMoves < 1 || o.maxMoves > 576) throw Error('invalid finite bank sort budget');
    const began = d.tick(), check = () => { const reason = d.unsafe(); if (reason) throw Error('bank sort ' + reason); if (d.tick() - began >= o.cap) throw Error('bank sort tick budget'); };
    check();
    const first = d.observe();
    if (!first || !Number.isSafeInteger(first.generation) || first.generation < 1 || ![0, 1].includes(first.mode)) throw Error('bank state unobserved');
    const target = sortBankRows(first.rows, o.policy);
    let before = first.rows.map(i => ({ ...i })), moves = 0;
    for (const item of target) {
        check();
        const fresh = d.observe();
        if (!fresh || fresh.mode !== first.mode || order(fresh.rows) !== order(before)) throw Error('bank changed before drag');
        if (before.find(i => i.slot === item.slot)?.id === item.id) continue;
        if (moves >= o.maxMoves) throw Error('bank sort move budget');
        const source = before.find(i => i.id === item.id);
        if (!source) throw Error('bank source disappeared');
        const expected = bankMove(before, source.slot, item.slot, first.mode), tick = d.tick();
        moves++;
        if (!await d.drag(source.slot, item.slot, before)) throw Error('bank drag refused; no retry');
        const confirmed = () => {
            check();
            const now = d.observe();
            if (!now) return false;
            if (now.mode !== first.mode) throw Error('bank mode changed');
            if (now.generation <= fresh.generation || d.tick() <= tick) return false;
            if (order(now.rows) !== order(expected)) throw Error('bank drag differs from exact receipt');
            return true;
        };
        if (!await d.wait(confirmed, Math.min(8, Math.max(1, o.cap - (d.tick() - began)))) || !confirmed()) throw Error('bank drag unconfirmed; no retry');
        before = expected;
    }
    check();
    if (order(d.observe()?.rows ?? []) !== order(target)) throw Error('bank final order differs');
    return { policy: o.policy ?? 'name', moves, ticks: d.tick() - began, mode: first.mode, items: target.length, order: target.map(i => ({ id: i.id, count: i.count, slot: i.slot })), preserved: true };
}

export function dispatchBankDrag(client: unknown, from: number, to: number, mode: 0 | 1, before: BankSortRow[]) {
    const c = client as any, com = c?.ifType?.(componentId('bank_main:inv'));
    if (c?.mainModalId !== componentId('bank_main') || c.var?.[304] !== mode || !com?.linkObjType || !com?.linkObjNumber) throw Error('bank drag interface/mode unobserved');
    const rows: BankSortRow[] = [];
    for (let slot = 0; slot < com.linkObjType.length; slot++) {
        const id = Number(com.linkObjType[slot]) - 1, count = Number(com.linkObjNumber[slot]);
        if (id >= 0 && count > 0) rows.push({ slot, id, count, name: 'observed' });
    }
    if (order(rows) !== order(before)) throw Error('bank drag fresh slots differ');
    bankMove(before, from, to, mode);
    if (typeof c.writeOpcode !== 'function' || typeof c.out?.p2 !== 'function' || typeof c.out?.p1 !== 'function') throw Error('bank drag packet surface unavailable');
    c.writeOpcode(ClientProt.INV_BUTTOND);
    c.out.p2(componentId('bank_main:inv'));
    c.out.p2(from);
    c.out.p2(to);
    c.out.p1(mode);
    return { success: true };
}

function installBankDrag(client: unknown) {
    const c = client as any, original = c?.executeBotAction;
    if (typeof original !== 'function') throw Error('bank executor unavailable');
    const wrapper = function (a: any) { return a?.type === 'nativeBankDrag' ? dispatchBankDrag(c, a.from, a.to, a.mode, a.before) : original.call(c, a); };
    c.executeBotAction = wrapper;
    return () => { if (c.executeBotAction === wrapper) c.executeBotAction = original; };
}

function watchBankSortLife(s: Session, stop: () => boolean = () => false) {
    const initial = s.sdk.getState()?.player, initialHp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    if (!initial || initialHp <= 0) throw Error('production life unobserved');
    const initialRespawns = initial.respawnCount ?? 0, initialLife = initial.lifeId;
    let ended = false, why = '';
    void s.ended?.then(() => { ended = true; });
    const reason = () => {
        const p = s.sdk.getState()?.player, hp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
        if (why) return why;
        if (ended) why = 'session ended';
        else if (loadoutStopRequested(s.name, stop)) why = 'stop requested';
        else if (!p || hp <= 0 || p.isDead) why = 'dead or player unavailable';
        else if ((p.respawnCount ?? 0) > initialRespawns || (initialLife !== undefined && p.lifeId !== initialLife)) why = 'life changed';
        else if (hp < initialHp) why = 'damage observed';
        return why;
    };
    return { reason };
}

export async function sortNativeBank(s: Session, o: { cap: number; maxMoves: number; policy?: BankSortPolicy }, stop: () => boolean = () => false) {
    if (!Number.isSafeInteger(o.cap) || o.cap < 1 || !Number.isSafeInteger(o.maxMoves) || o.maxMoves < 1 || o.maxMoves > 576 || !['name', 'donor'].includes(o.policy ?? 'name')) {
        throw Error('invalid finite bank sort budget/policy');
    }
    const client = s.client;
    if (!client || typeof client !== 'object') throw Error('bank sort client unavailable');
    const initial = s.sdk.getState(), player = initial?.player;
    if (!player || player.lifeId === undefined || !equipmentObserved(client)) throw Error('bank sort life/gear unobserved');
    const canon = (rows: readonly { id: number; count: number; slot: number }[]) => JSON.stringify([...rows].sort((a, b) => a.slot - b.slot).map(i => [i.slot, i.id, i.count]));
    const x = player.worldX, z = player.worldZ, plane = player.level, name = player.name?.toLowerCase();
    const stopped = () => stop() || existsSync('.practice/stop-all') || !!name && existsSync(`.practice/stop-${name}`);
    const pack = canon(initial.inventory), gear = canon(initial.equipment), xp = JSON.stringify(initial.skills.map(i => i.experience)), life = watchBankSortLife(s, stopped), began = s.tick();
    const unsafe = () => {
        const st = s.sdk.getState();
        return life.reason() || (!st || s.client !== client || !equipmentObserved(client)
            ? 'state/gear unavailable'
            : canon(st.inventory) !== pack || canon(st.equipment) !== gear || JSON.stringify(st.skills.map(i => i.experience)) !== xp
                ? 'assets or XP changed'
                : st.player?.worldX !== x || st.player?.worldZ !== z || st.player?.level !== plane
                    ? 'position changed'
                    : st.nearbyPlayers.some(p => p.distance <= 3)
                        ? 'nearby peer'
                        : '');
    };
    if (unsafe()) throw Error('bank sort ' + unsafe());
    if (!initial.bank.isOpen) {
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!unsafe() || !!s.bankObservation?.(), { timeoutTicks: 8 }) || unsafe()) throw Error('bank open unconfirmed');
    }
    const c = s.client as any, uninstall = installBankDrag(c);
    try {
        return await runFlatBankSort({
            tick: () => s.tick(),
            unsafe: () => unsafe() || (s.tick() - began >= o.cap ? 'tick budget' : ''),
            observe: () => {
                const b = s.bankObservation?.(), mode = c.var?.[304];
                if (!b || !c.isBankOpen?.() || ![0, 1].includes(mode)) return null;
                return { generation: b.generation, mode, rows: c.getBankItems().map((i: BankSortRow) => ({ ...i })) };
            },
            drag: async (from, to, before) => !!(await s.direct({ type: 'nativeBankDrag', from, to, mode: c.var[304], before, reason: 'SDK' }) as any)?.success,
            wait: (p, ticks) => waitUntil(s, p, { timeoutTicks: ticks }),
        }, o);
    } finally {
        uninstall();
    }
}

// --- Supply Chain ---

type SupplyRole = 'producer' | 'courier' | 'consumer';
export type SupplyActors = Record<SupplyRole, string>;
type Stock = { name: string; at: number; started: number; server: string; inventory: { id: number; count: number }[]; bank: { id: number; count: number }[] | null; bankAt: number; pos: { x: number; z: number; level: number } | null; result: string };
type SupplyChainOptions = { actors: SupplyActors; dir: string; cycles: number; server: string; reserveOpeningCash?: boolean; checkpoint?: (phase: string, active: SupplyRole[]) => Promise<void> };
const foodIds = [329, 330, 333, 334];
function needSupply(v: unknown, m: string): asserts v { if (!v) throw Error('supply chain: ' + m); }
const supplyRows = (v: unknown): v is { id: number; count: number }[] => Array.isArray(v) && v.every(i => Number.isSafeInteger(i?.id) && i.id >= 0 && Number.isSafeInteger(i.count) && i.count > 0);

export function supplyCount(s: Pick<Stock, 'inventory' | 'bank'>, ids: readonly number[], bank = true): number {
    needSupply(supplyRows(s.inventory) && (!bank || supplyRows(s.bank)), 'stock observation unavailable');
    return [...s.inventory, ...(bank ? s.bank! : [])].filter(i => ids.includes(i.id)).reduce((n, i) => n + i.count, 0);
}

export function supplyAdmission(food: number, bankCoins: number, courierCoins: number): 'earn-reserve' | 'drain-food' | 'cycle' {
    needSupply([food, bankCoins, courierCoins].every(n => Number.isSafeInteger(n) && n >= 0), 'invalid cycle stock');
    if (courierCoins < FUND_BELOW && bankCoins < FUND_RESERVE + FUND_AMOUNT) return 'earn-reserve';
    return food >= 80 ? 'drain-food' : 'cycle';
}

export function supplyRestock(feathers: number, target = 1000): number {
    needSupply(Number.isSafeInteger(feathers) && feathers >= 0 && Number.isSafeInteger(target) && target >= 50 && target <= 1000, 'invalid feather stock/target');
    return Math.max(0, target - feathers);
}

export async function runSupplyChain(o: SupplyChainOptions) {
    needSupply(Number.isSafeInteger(o.cycles) && o.cycles >= 1 && o.cycles <= 20, 'cycles must be1..20');
    const roles = ['producer', 'courier', 'consumer'] as const, names = roles.map(r => o.actors[r]);
    needSupply(names.every(n => /^[A-Za-z0-9]{1,12}$/.test(n)) && new Set(names.map(n => n.toLowerCase())).size === 3, 'three distinct owned actors required');
    const owned = ownedAccounts(o.server);
    for (const n of names) {
        needSupply(owned.has(n.toLowerCase()), 'actor ownership unavailable');
        const env = readFileSync(join(REPO_ROOT, 'vendor/rs-sdk/bots', n, 'bot.env'), 'utf8');
        needSupply(serverFromEnv(env) === o.server, 'actor endpoint mismatch');
    }
    needSupply(isLocalServer(o.server), 'local qualification required before live release');
    mkdirSync(o.dir, { recursive: true });
    const revision = workerSourceRevision(), source = () => needSupply(workerSourceRevision() === revision, 'worker source changed');
    const write = (p: string, v: unknown) => writeFileSync(join(o.dir, p), JSON.stringify(v, null, 2));
    needSupply(!existsSync(join(o.dir, 'controller.json')), 'existing controller evidence retained');
    write('controller.json', { pid: process.pid, at: Date.now(), actors: o.actors, cycles: o.cycles, server: o.server, revision });
    const capacity = (pair = false) => {
        const gib = freemem() / 2 ** 30;
        write('capacity-' + Date.now() + '.json', { gib, minimum: pair ? 11 : 8 });
        needSupply(gib >= (pair ? 11 : 8), 'host memory floor');
    };
    const stock = {} as Record<SupplyRole, Stock>;
    const snapshot = async (role: SupplyRole, started: number, requireBank = false): Promise<Stock> => {
        const deadline = Date.now() + 4000;
        do {
            try {
                const s = JSON.parse(readFileSync(join(REPO_ROOT, '.practice/status', o.actors[role] + '.json'), 'utf8'));
                if (s.name?.toLowerCase() === o.actors[role].toLowerCase() && s.server === o.server && s.started >= started - 1000 && s.at >= started && supplyRows(s.inventory) && typeof s.result === 'string' && s.result.startsWith('ok') && (!requireBank || supplyRows(s.bank) && s.bankAt >= started)) return s;
            } catch { /* retry */ }
            await Bun.sleep(100);
        } while (Date.now() < deadline);
        throw Error('supply chain: completed current-session stock missing: ' + role);
    };
    const start = (role: SupplyRole, script: string, env: Record<string, string>, label: string, extraArgs: readonly string[] = []) => {
        needSupply(!existsSync(join(o.dir, label + '.json')) && !existsSync(join(o.dir, label + '.log')), 'prior job evidence retained: ' + label);
        source();
        const started = Date.now(), name = o.actors[role];
        const p = Bun.spawn([process.execPath, script, name, ...extraArgs], {
            cwd: REPO_ROOT,
            env: { ...process.env, DEMO_OK: '', WORKER_RELEASE: '', RANDOM_EVENTS: '0', FROM: '', FARMERS: '', GIVE_TO: '', FOOD_FROM: '', FUND_FROM: '', FUND_COURIER: '', FUND_ONLY: '0', RESERVE_OPENING_CASH: '0', START: '', HOME_ONLY: '0', OUTBOUND_ONLY: '0', HANDOFF_ONLY: '0', TARGETED_COLLECTION: '0', FEATHERS: '0', TICK3: '0', ...env },
            stdout: 'pipe',
            stderr: 'pipe',
            windowsHide: true,
        });
        let output = '', done = false, timedOut = false;
        const timer = setTimeout(() => { timedOut = true; p.kill(); }, 360000);
        const collect = async (stream: ReadableStream<Uint8Array>) => { for await (const chunk of stream) { output += new TextDecoder().decode(chunk); writeFileSync(join(o.dir, label + '.log'), output); } };
        const result = (async () => {
            try {
                const [, , code] = await Promise.all([collect(p.stdout), collect(p.stderr), p.exited]);
                const res = { name, script, env, started, ended: Date.now(), code, timedOut, output };
                write(label + '.json', res);
                needSupply(code === 0 && !timedOut && /^RESULT ok\b/m.test(output) && /^LOGOUT logged-out\r?$/m.test(output), 'job failed: ' + label);
                stock[role] = await snapshot(role, started, role !== 'courier');
                const line = output.split(/\r?\n/).find(l => l.startsWith('RESULT ok '))!;
                return { ...res, counters: resultCounters(line.slice(7)) };
            } finally {
                clearTimeout(timer);
                done = true;
            }
        })();
        void result.catch(() => {});
        return {
            result,
            waitFor: async (pattern: RegExp, timeout = 120000) => {
                const end = Date.now() + timeout;
                while (!pattern.test(output)) {
                    if (done) { await result; throw Error('missing readiness ' + label); }
                    needSupply(Date.now() < end, 'readiness timeout ' + label);
                    await Bun.sleep(100);
                }
            },
        };
    };
    const checkpoint = async (label: string, active: readonly SupplyRole[]) => { source(); write(label + '-observed.json', stock); await o.checkpoint?.(label, [...active]); };
    for (const role of roles) { capacity(); await start(role, 'scripts/aio-logistics.ts', { REQUIRE_BANK: '1' }, 'inspect-' + role, ['inspect']).result; }
    needSupply(supplyCount(stock.producer, foodIds) === 0, 'opening producer food must be empty');
    await checkpoint('opening', roles);
    const held = supplyCount(stock.courier, foodIds, false);
    if (held > 0) {
        capacity(true);
        const farmer = start('consumer', 'scripts/goldfarm-stable.ts', { FOOD_FROM: o.actors.courier, TICKS: '1000', BANK_AT: '2000' }, 'recovery-consumer');
        await farmer.waitFor(/^GOLDFARM /m, 30000);
        const delivered = await start('courier', 'scripts/aio-logistics.ts', { FROM: o.actors.producer, FARMERS: o.actors.consumer, TOTAL_PER: String(held), CAP: '600' }, 'recovery-delivery', ['food-courier']).result;
        await farmer.result;
        needSupply(delivered.counters.handed === held && supplyCount(stock.courier, foodIds, false) === 0, 'held cargo recovery incomplete');
        await checkpoint('recovery-delivered', ['consumer', 'courier']);
    }
    const cycles = [];
    for (let cycle = 1; cycle <= o.cycles; cycle++) {
        const p = 'cycle' + cycle;
        capacity();
        for (let attempt = 0; ; attempt++) {
            const decision = supplyAdmission(supplyCount(stock.consumer, foodIds), supplyCount(stock.consumer, [995]), supplyCount(stock.courier, [995], false));
            if (decision === 'cycle') break;
            needSupply(attempt < 24, 'consumer admission budget exhausted');
            const beforeFood = supplyCount(stock.consumer, foodIds), beforeCash = supplyCount(stock.consumer, [995]);
            await start('consumer', 'scripts/goldfarm-stable.ts', { TICKS: '1000', BANK_AT: '2000' }, p + '-' + decision + '-' + attempt).result;
            needSupply(supplyCount(stock.consumer, [995]) > beforeCash && (decision !== 'drain-food' || supplyCount(stock.consumer, foodIds) < beforeFood), 'consumer admission made no useful progress');
            await checkpoint(p + '-admission-' + attempt, ['consumer']);
        }
        capacity(true);
        const funder = start('consumer', 'scripts/goldfarm-stable.ts', { TICKS: '200', BANK_AT: '2000', FUND_COURIER: o.actors.courier }, p + '-funder');
        await funder.waitFor(/^GOLDFARM /m, 30000);
        const fund = await start('courier', 'scripts/aio-logistics.ts', { FUND_ONLY: '1', FUND_FROM: o.actors.consumer, RESERVE_OPENING_CASH: cycle === 1 && o.reserveOpeningCash !== false ? '1' : '0', CAP: '400' }, p + '-funding', ['food-courier']).result;
        const earning = await funder.result;
        await checkpoint(p + '-funded', ['consumer', 'courier']);
        for (let attempt = 0; supplyCount(stock.consumer, foodIds) >= 80; attempt++) {
            needSupply(attempt < 24, 'food demand budget exhausted');
            capacity();
            await start('consumer', 'scripts/goldfarm-stable.ts', { TICKS: '1000', BANK_AT: '2000' }, p + '-drain-' + attempt).result;
            await checkpoint(p + '-drained-' + attempt, ['consumer']);
        }
        capacity();
        needSupply(supplyCount(stock.producer, foodIds) === 0, 'retained upstream cargo must settle before new production');
        await start('producer', 'scripts/fishcook.ts', { TICKS: '650', MAX_CATCHES: String(Math.max(1, 80 - supplyCount(stock.consumer, foodIds))), TICK3: '0', FEATHER_MIN: '1', FEATHER_FILL: '60', EXTERNAL_REFILL: '1' }, p + '-produce').result;
        const amount = supplyCount(stock.producer, foodIds), feathersBefore = supplyCount(stock.producer, [314]);
        needSupply(amount > 0 && amount <= 80, 'new bounded food lot missing');
        await checkpoint(p + '-produced', ['producer']);
        const wanted = supplyRestock(feathersBefore);
        capacity(true);
        const carrier = start('courier', 'scripts/aio-logistics.ts', { FROM: o.actors.producer, FEATHERS: String(wanted), WAIT: '600', CAP: '2000' }, p + '-collection', ['food-courier']);
        await carrier.waitFor(/^MILESTONE collecting /m);
        await Bun.sleep(300);
        await start('producer', 'scripts/fishcook.ts', { GIVE_TO: o.actors.courier, HANDOFF_ONLY: '1', WAIT: '900', TICKS: '1200' }, p + '-supplier').result;
        const collect = await carrier.result;
        needSupply(supplyCount(stock.producer, foodIds) === 0 && supplyCount(stock.courier, foodIds, false) === amount, 'collection stock mismatch');
        const purchased = collect.counters.feathersBought ?? NaN;
        needSupply(Number.isSafeInteger(purchased) && purchased >= 0 && (wanted === 0 || purchased > 0) && supplyCount(stock.producer, [314]) === feathersBefore + purchased, 'consumer-funded feather restock unconfirmed');
        await checkpoint(p + '-collected', ['producer', 'courier']);
        capacity(true);
        const farmer = start('consumer', 'scripts/goldfarm-stable.ts', { FOOD_FROM: o.actors.courier, TICKS: '1000', BANK_AT: '2000' }, p + '-consumer');
        await farmer.waitFor(/^GOLDFARM /m, 30000);
        const deliver = await start('courier', 'scripts/aio-logistics.ts', { FROM: o.actors.producer, FARMERS: o.actors.consumer, TOTAL_PER: String(amount), CAP: '600' }, p + '-delivery', ['food-courier']).result;
        const use = await farmer.result;
        needSupply(deliver.counters.handed === amount && supplyCount(stock.courier, foodIds, false) === 0 && use.counters.eaten! > 0 && use.counters.coinsGained! > 0, 'delivery/use/output unconfirmed');
        await checkpoint(p + '-completed', ['consumer', 'courier']);
        const record = { cycle, amount, wanted, purchased, fundingReceived: fund.counters.received, fundingEarnings: earning.counters.coinsGained, consumerEarnings: use.counters.coinsGained, eaten: use.counters.eaten, stock: JSON.parse(JSON.stringify(stock)) };
        write(p + '-result.json', record);
        cycles.push(record);
        console.log('SUPPLY_CYCLE ' + JSON.stringify({ cycle, amount, purchased, fundingReceived: record.fundingReceived, eaten: record.eaten, consumerEarnings: record.consumerEarnings }));
    }
    source();
    write('result.json', { ok: true, revision, actors: o.actors, cycles, scope: 'Bounded locally qualified consumer-funded cycles; ordinary workers and no preset/profile mutation. Initial courier cash reserved once. Not live activation.' });
    return { revision, cycles };
}

// --- Zero-Resource Supply Bootstrap ---

export type BootstrapRole = 'producer' | 'courier' | 'receiver';
export type BootstrapPhase = 'all' | 'clean' | 'earn';
export type BootstrapCheckpoint = (stage: 'empty' | 'trained' | 'earned', evidence: unknown) => void | Promise<void>;
export interface BootstrapDeps {
    trainChickens?: (s: Session, maxTicks: number, bank: string, targetCombat: number) => Promise<{ ok: boolean; combat: number }>;
}

let registeredBootstrapDeps: BootstrapDeps = {};
export function registerBootstrapRuntime(deps: BootstrapDeps) {
    registeredBootstrapDeps = { ...registeredBootstrapDeps, ...deps };
}

const BOOTSTRAP_NORTH = [[3218, 3256], [3180, 3258], [3140, 3270], [3100, 3270], [3089, 3266], [3092, 3250], [3092, 3243]].map(([x, z]) => ({ x: x!, z: z!, tol: 0 }));
const BOOTSTRAP_MEN = [{ x: 3222, z: 3218, tol: 2 }];
function requireThat(v: unknown, m: string): asserts v { if (!v) throw Error('supply bootstrap: ' + m); }

export function bootstrapPracticeServer(env: string): string {
    const server = serverFromEnv(env);
    requireThat(isLocalServer(server), 'isolated loopback practice actor required');
    return server;
}

export function bootstrapAccountServer(name: string): string {
    requireThat(/^[A-Za-z0-9]{1,12}$/.test(name), 'valid practice account required');
    return bootstrapPracticeServer(readFileSync(resolve(REPO_ROOT, 'vendor/rs-sdk/bots', name, 'bot.env'), 'utf8'));
}

export async function bootstrapSupplyActor(
    s: Session,
    role: BootstrapRole,
    checkpoint?: BootstrapCheckpoint,
    phase: BootstrapPhase = 'all',
    deps: BootstrapDeps = registeredBootstrapDeps,
) {
    requireThat(['producer', 'courier', 'receiver'].includes(role) && ['all', 'clean', 'earn'].includes(phase), 'unknown role/phase');
    bootstrapAccountServer(s.name);
    const parent = executionContext.getStore(), ac = new AbortController(), start = s.tick();
    let ended = false;
    const signal = parent?.signal ? AbortSignal.any([parent.signal, ac.signal]) : ac.signal;
    const timer = setTimeout(() => ac.abort(Error('bootstrap30minute wall deadline')), 30 * 60 * 1000);
    timer.unref?.();
    void s.ended.then(() => { ended = true; ac.abort(Error('bootstrap session ended')); });
    const initialLife = s.sdk.getState()?.player, off = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        if (s.tick() - start >= 20000) ac.abort(Error('bootstrap20000tick deadline'));
        if (p?.isDead || (p?.respawnCount ?? 0) > (initialLife?.respawnCount ?? 0) || (initialLife?.lifeId !== undefined && (p?.lifeId ?? initialLife.lifeId) !== initialLife.lifeId)) {
            ac.abort(Error('bootstrap actor died/respawned'));
        }
    });
    const state = () => s.sdk.getState(), pack = () => s.sdk.getInventory(), worn = () => s.sdk.getEquipment();
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0, fullHp = () => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0;
    const count = (id: number) => pack().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const check = () => { signal.throwIfAborted(); requireThat(!ended && hp() > 0, 'session/death boundary'); };
    const snapshot = () => ({ account: s.name, role, phase, tick: s.tick(), pos: state()?.player, inventory: pack().map(i => ({ id: i.id, count: i.count, slot: i.slot })), equipment: worn().map(i => ({ id: i.id, count: i.count, slot: i.slot })), skills: state()?.skills });
    const mark = async (stage: 'empty' | 'trained' | 'earned', evidence: unknown) => {
        check();
        console.log('BOOTSTRAP_CHECKPOINT ' + JSON.stringify({ stage, ...snapshot(), evidence }));
        await checkpoint?.(stage, evidence);
        check();
    };
    const walk = async (points: { x: number; z: number; tol: number }[]) => {
        check();
        const r = await walkPath(await sessionWalker(s), points, { maxTicks: 700, stop: () => signal.aborted || ended || hp() < 3 });
        requireThat(r.ok, 'safe route ' + r.detail);
        check();
    };
    const toBank = async () => {
        const p = state()?.player;
        requireThat(p?.level === 0, 'ground-floor route required');
        if (p.worldX > 3150) await walk(BOOTSTRAP_NORTH);
        else await walk(BOOTSTRAP_NORTH.slice(-2));
    };
    const toMen = async () => { await walk([...BOOTSTRAP_NORTH.slice(0, -1)].reverse()); await walk(BOOTSTRAP_MEN); };
    const openBank = async () => {
        check();
        requireThat((await s.bot.openBank()).success, 'bank open failed');
        requireThat(await waitUntil(s, () => !!s.bankObservation?.(), { timeoutTicks: 12 }), 'complete bank packet absent');
        check();
        return s.bankObservation!()!;
    };
    const freshSkills = () => { const skills = state()?.skills; return skills?.length === 21 && skills.every(k => k.baseLevel === (k.name === 'Hitpoints' ? 10 : 1)); };
    const dropAll = async (label: string) => {
        const before = pack().map(i => ({ id: i.id, count: i.count, slot: i.slot })), debits = [];
        for (let i = 0; pack().length && i < 28; i++) {
            check();
            const item = pack()[0]!, prior = count(item.id);
            await s.sdk.sendDropItem(item.slot);
            requireThat(await waitUntil(s, () => count(item.id) < prior, { timeoutTicks: 8 }), 'ordinary drop not observed');
            debits.push({ id: item.id, slot: item.slot, before: prior, after: count(item.id) });
        }
        requireThat(pack().length === 0, 'gift inventory not empty');
        console.log('BOOTSTRAP_DISCARD ' + JSON.stringify({ account: s.name, label, before, debits, after: pack(), tick: s.tick() }));
    };
    const regen = async () => {
        check();
        let progress = s.tick(), last = hp(), waited = 0;
        while (hp() < fullHp() && waited < 2200) {
            check();
            await waitTicks(s, 1);
            waited++;
            if (hp() > last) { last = hp(); progress = s.tick(); }
            requireThat(s.tick() - progress <= 150, 'natural HP regeneration stalled');
        }
        requireThat(hp() === fullHp(), 'bounded natural regeneration incomplete');
        if (waited) console.log('BOOTSTRAP_REGEN ' + JSON.stringify({ account: s.name, ticks: waited, hp: hp(), tick: s.tick() }));
    };
    const earn = async (target: number, cap: number) => {
        const t = s.tick(), before = count(995), xp = s.sdk.getSkillXp('Thieving') ?? 0;
        let attempts = 0, lastProgress = s.tick(), lastCoins = before;
        while (count(995) < target && s.tick() - t < cap) {
            check();
            if (hp() <= Math.max(4, Math.ceil(fullHp() * .35))) await regen();
            const man = state()?.nearbyNpcs.filter(n => /^man$/i.test(n.name) && n.x >= 3210 && n.x <= 3234 && n.z >= 3205 && n.z <= 3235).sort((a, b) => a.distance - b.distance)[0];
            requireThat(man, 'ordinary Lumbridge man unavailable');
            const held = count(995), h = hp();
            await s.bot.pickpocketNpc(man);
            attempts++;
            await waitTicks(s, 2);
            check();
            const gain = count(995) - held;
            requireThat(gain >= 0 && gain % 3 === 0, `man coin gain differs from pinned3GP: ${gain}`);
            if (count(995) > lastCoins) { lastCoins = count(995); lastProgress = s.tick(); }
            if (hp() < h) { await waitTicks(s, 8); check(); }
            requireThat(s.tick() - lastProgress <= 1800, 'no earned coins for1800ticks');
        }
        requireThat(count(995) >= target, 'bounded ordinary earning target incomplete');
        const p = state()?.player;
        requireThat(p, 'earning position absent');
        await s.sdk.sendWalk(p.worldX, p.worldZ);
        await waitTicks(s, 4);
        check();
        const result = { before, after: count(995), earned: count(995) - before, attempts, thievingXp: (s.sdk.getSkillXp('Thieving') ?? 0) - xp, ticks: s.tick() - t, hp: hp() };
        requireThat(result.earned * 200 === result.thievingXp * 3, 'earned cash/XP reconciliation failed');
        console.log('BOOTSTRAP_EARN ' + JSON.stringify({ account: s.name, ...result }));
        return result;
    };
    try {
        return await executionContext.run({ ...parent, signal }, async () => {
            await waitTicks(s, 3);
            check();
            const client = s.client;
            requireThat(client && typeof client === 'object', 'native client required');
            requireThat(await waitUntil(s, () => equipmentObserved(client), { timeoutTicks: 20 }), 'known equipment packet required');
            if (phase !== 'earn') {
                const p = state()?.player;
                requireThat(p && p.worldX < 3160 && p.worldZ < 3130 && freshSkills(), 'fresh registered tutorial actor with untrained skills required');
                check();
                await leaveRuneStarter(s, () => signal.aborted || ended || hp() <= 0);
                check();
                const landed = state()?.player, mainland = !!landed && landed.level === 0 && landed.worldX >= 3180 && landed.worldZ >= 3180;
                requireThat(mainland && freshSkills(), 'tutorial did not yield fresh mainland actor');
                for (const item of [...worn()]) {
                    requireThat((await s.bot.unequipItem(item)).success, 'gift equipment removal failed');
                    requireThat(await waitUntil(s, () => !worn().some(i => i.slot === item.slot), { timeoutTicks: 8 }), 'gift equipment removal unobserved');
                }
                await dropAll('all tutorial inventory gifts');
                await toBank();
                const before = await openBank();
                requireThat(before.items.length === 1 && before.items[0]!.id === 995 && before.items[0]!.count === 25, 'tutorial bank must contain exactly25giftcoins');
                await s.bot.withdrawItem(/^coins$/i, 25);
                requireThat(await waitUntil(s, () => { const after = s.bankObservation?.(); return count(995) === 25 && !!after && after.generation > before.generation && after.items.length === 0; }, { timeoutTicks: 12 }), 'gift25coin withdrawal not paired');
                console.log('BOOTSTRAP_GIFT_BANK ' + JSON.stringify({ account: s.name, before, after: s.bankObservation?.(), held: count(995) }));
                await s.bot.closeBank();
                await dropAll('all25tutorial bank coins');
            } else {
                await toBank();
            }
            const empty = await openBank();
            requireThat(empty.items.length === 0 && pack().length === 0 && worn().length === 0 && freshSkills() && hp() === 10, 'empty untrained Draynor checkpoint failed');
            await s.bot.closeBank();
            await mark('empty', { bank: empty, starterGiftsUsed: false });
            if (phase === 'clean') return { ok: true, role, phase, ticks: s.tick() - start };
            await toMen();
            const firstEarn = await earn(3, 500);
            await walk([{ x: 3231, z: 3203, tol: 2 }]);
            const beforeCoins = count(995);
            requireThat((await s.bot.openShop(/^bob$/i)).success, 'Bob shop unavailable');
            await s.bot.buyFromShop(/^bronze pickaxe$/i, 1);
            await s.bot.closeShop();
            requireThat(await waitUntil(s, () => count(1265) === 1 && count(995) === beforeCoins - 1, { timeoutTicks: 12 }), 'owned1GP bronze pick purchase not observed');
            console.log('BOOTSTRAP_PURCHASE ' + JSON.stringify({ account: s.name, itemId: 1265, amount: 1, coinsBefore: beforeCoins, coinsAfter: count(995), cost: 1 }));
            await toBank();
            await regen();
            const train = deps.trainChickens ?? registeredBootstrapDeps.trainChickens;
            if (!train) throw Error('supply bootstrap: trainChickens runtime handler missing');
            const training = await train(s, 9000, 'draynor', 29);
            requireThat(training.ok && training.combat >= 29, 'natural chicken qualification failed');
            await mark('trained', { training, firstEarn, pickCost: 1 });
            await toMen();
            const earned = await earn(role === 'producer' ? 200 : role === 'courier' ? 240 : 120, 12000);
            await toBank();
            requireThat(earned.earned * 200 === earned.thievingXp * 3, 'earned cash/XP reconciliation failed');
            const bank = await openBank(), pick = pack().find(i => i.id === 1265);
            requireThat(pick, 'owned trained pick not returned');
            await depositObserved(s, pick);
            const afterBank = s.bankObservation!()!;
            requireThat(afterBank.items.filter(i => i.id === 1265).reduce((n, i) => n + i.count, 0) === 1, 'owned pick bank credit missing');
            await s.bot.closeBank();
            requireThat(pack().every(i => i.id === 995) && worn().length === 0 && hp() >= 8 && (state()?.player?.combatLevel ?? 0) >= 29, 'final cash/kit/HP checkpoint failed');
            requireThat((count(995) + 1) * 200 === (s.sdk.getSkillXp('Thieving') ?? 0) * 3, 'final cash plus1GP pick cost must equal all earned man XP');
            const result = { ok: true, role, phase, training, firstEarn, earned, heldCoins: count(995), bankBefore: bank, bankAfter: afterBank, ticks: s.tick() - start, hp: hp() };
            await mark('earned', result);
            return result;
        });
    } finally {
        off();
        clearTimeout(timer);
    }
}
