// Solo banked essence crafting across free altars and members Cosmic altar.
import { existsSync } from 'node:fs';
import { accountOf as defaultAccountOf, getWorld as defaultGetWorld, sessionDied } from '../../../core/src/bot';
import { depositObserved } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { waitUntil } from '../../../core/src/ticks';
import { goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import { interactionApproach, type Tile } from '../../../core/src/world';
import type { BotWorldState } from '../../../../vendor/rs-sdk/sdk/types';
import { craftAirRunes, enterAirAltar, exitAirAltar } from './air';
import {
    AIR,
    ALL_ALTARS,
    ALL_ALTARS_BY_NAME,
    BANK,
    COSMIC_ALTAR,
    COSMIC_EXIT_APPROACH,
    DRAMEN_STAFF,
    DRAYNOR_BANK,
    ESSENCE,
    RUNE_ALTARS,
    ZANARIS_BANK,
    type RuneAltar,
    chooseRuneAltar,
    inZanarisCosmic,
    insideRuneAltar,
    ruinTarget,
    runeAltarStaging,
} from './altars';
import type { RunecraftExternalDeps } from './types';

const USE_PORTAL_RE = /^use$/i;

export function runeEntrySnapshot(state: BotWorldState | null, revision: number, tick: number) {
    return {
        tick: state?.tick ?? null,
        revision: state?.revision ?? null,
        player: state?.player ?? null,
        inventory: state?.inventory ?? null,
        dialog: state?.dialog ?? null,
        recentDialogs: state?.recentDialogs ?? null,
        interface: state?.interface ?? null,
        modalOpen: state?.modalOpen ?? null,
        modalInterface: state?.modalInterface ?? null,
        bankOpen: state?.bank.isOpen ?? null,
        shopOpen: state?.shop.isOpen ?? null,
        tradeOpen: state?.trade?.isOpen ?? null,
        opFeedback: state?.opFeedback ?? null,
        messages: state?.gameMessages.filter(m => (m.observationId !== undefined ? m.observationId > revision : m.tick > tick)) ?? [],
    };
}

export async function settleRuneEntryModal(s: Session, stop: () => boolean): Promise<boolean> {
    const closed = () => {
        const st = s.sdk.getState();
        return !!st && st.modalOpen === false && !st.interface.isOpen && !st.dialog.isOpen;
    };
    if (stop()) return false;
    if (closed()) return true;
    if (!(await s.sdk.sendCloseModal()).success || stop()) return false;
    return (await waitUntil(s, () => stop() || closed(), { timeoutTicks: 10 })) && !stop() && closed();
}

export const WILDERNESS_WARNING = 1908;

export const runeEntryWarning = (
    st: Pick<BotWorldState, 'modalOpen' | 'modalInterface' | 'interface'> | null | undefined,
): boolean => !!st && st.modalOpen === true && (st.modalInterface === WILDERNESS_WARNING || st.interface?.interfaceId === WILDERNESS_WARNING);

export type RuneEntryResult = { entered: boolean; dispatches: number; warnings: number; failure?: string };

export async function dispatchRuneEntry(
    s: Session,
    p: {
        dispatch: (attempt: number) => Promise<{ success: boolean }>;
        entered: () => boolean;
        stop: () => boolean;
        attempts?: number;
        timeoutTicks?: number;
    },
): Promise<RuneEntryResult> {
    const attempts = p.attempts ?? 3, timeoutTicks = p.timeoutTicks ?? 20;
    let dispatches = 0, warnings = 0;
    const result = (failure?: string): RuneEntryResult => ({
        entered: !failure && p.entered(),
        dispatches,
        warnings,
        ...(failure ? { failure } : {}),
    });
    while (dispatches < attempts) {
        if (p.stop()) return result('stopped');
        dispatches++;
        if (!(await p.dispatch(dispatches)).success) return result('ruins action refused');
        await waitUntil(s, () => p.stop() || p.entered() || runeEntryWarning(s.sdk.getState()), { timeoutTicks });
        if (p.entered()) return result();
        if (p.stop()) return result('stopped');
        if (!runeEntryWarning(s.sdk.getState())) return result('altar entry unobserved');
        warnings++;
        if (!await settleRuneEntryModal(s, p.stop)) return result('entry warning closure unobserved');
    }
    return result('entry warning retries exhausted');
}

export function runeBankTarget(value = 99): number {
    if (!Number.isSafeInteger(value) || value < 2 || value > 99) throw Error('Runecraft target must be2..99');
    return value;
}

export type RuneBankOptions = {
    cap?: number;
    stop?: () => boolean;
    altar?: string;
    essenceTarget?: number;
    deps?: Pick<RunecraftExternalDeps, 'getWorld' | 'accountOf'>;
};

export function runeBankOptions(options: RuneBankOptions = {}) {
    const cap = options.cap ?? 20000;
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('invalid rune bank craft tick cap');
    if (options.altar !== undefined && !ALL_ALTARS.some(a => a.name === options.altar)) throw Error(`unknown rune altar: ${options.altar}`);
    if (options.essenceTarget !== undefined && (!Number.isSafeInteger(options.essenceTarget) || options.essenceTarget < 1)) {
        throw Error('rune essence target must be a positive safe integer');
    }
    return { ...options, cap };
}

export const RUNE_BANK_XP_CAP = 200_000_000;
export const RUNE_BANK_XP_RATE = 25;

export function runeBankXpBalanced(initial: number, current: number, baseGain: number): boolean {
    if (
        !Number.isSafeInteger(initial)
        || initial < 0
        || initial > RUNE_BANK_XP_CAP
        || !Number.isSafeInteger(current)
        || current < initial
        || !Number.isFinite(baseGain)
        || baseGain < 0
    ) {
        return false;
    }
    const gain = baseGain * RUNE_BANK_XP_RATE;
    return current === Math.min(RUNE_BANK_XP_CAP, initial + Math.floor(gain))
        || current === Math.min(RUNE_BANK_XP_CAP, initial + Math.ceil(gain));
}

export type RuneBankLedger = {
    essence0: number;
    essence: number;
    air0: number;
    air: number;
    consumed: number;
    crafted: number;
    runes?: Record<number, { before: number; after: number; crafted: number }>;
};

export function runeBankBalanced(l: RuneBankLedger): boolean {
    let products: boolean;
    if (l.runes) {
        let totalCrafted = 0;
        products = true;
        for (const k in l.runes) {
            const r = l.runes[k]!;
            if (r.after - r.before !== r.crafted) {
                products = false;
                break;
            }
            totalCrafted += r.crafted;
        }
        if (products && totalCrafted !== l.crafted) products = false;
    } else {
        products = l.air - l.air0 === l.crafted;
    }
    return l.essence0 - l.essence === l.consumed && products && l.crafted >= l.consumed;
}

export const runeBankDone = (level: number, target: number, bankEssence: number, essenceTarget?: number, consumed = 0): boolean =>
    essenceTarget === undefined ? level >= target || bankEssence === 0 : consumed === essenceTarget;

export function runeBankOk(p: {
    ledger: RuneBankLedger | undefined;
    level0: number;
    level: number;
    target: number;
    bankEssence: number;
    held: { essence: number; air: number; runes?: number };
    stopped: boolean;
    essenceTarget?: number;
}): boolean {
    return !p.stopped
        && !!p.ledger
        && runeBankBalanced(p.ledger)
        && p.held.essence === 0
        && p.held.air === 0
        && (p.held.runes ?? 0) === 0
        && runeBankDone(p.level, p.target, p.bankEssence, p.essenceTarget, p.ledger.consumed)
        && (p.ledger.consumed > 0 || (p.essenceTarget === undefined && p.level0 >= p.target));
}

const tile = (x: number, z: number, level = 0): Tile => ({ x, z, level });

export async function runRuneBankCraft(s: Session, target = 99, options: RuneBankOptions = {}) {
    runeBankTarget(target);
    const { cap, altar: forced, essenceTarget, deps } = runeBankOptions(options);
    const production = essenceTarget !== undefined;
    const getWorldFn = deps?.getWorld ?? defaultGetWorld;
    const accountOfFn = deps?.accountOf ?? defaultAccountOf;
    const start = s.tick(), state = () => s.sdk.getState(), pos = () => state()?.player, initialLife = pos();
    let ended = false, stage = 'entry';
    void s.ended.then(() => { ended = true; });
    let stoppedFor: string | undefined;
    const stopReason = () => stoppedFor ??= sessionDied(initialLife, pos())
        ? 'died'
        : ended
            ? 'session-ended'
            : options.stop?.()
                ? 'operator'
                : existsSync(`.practice/stop-${s.name}`)
                    ? 'stop-file'
                    : s.tick() - start >= cap
                        ? 'tick-cap'
                        : undefined;
    const stop = () => stopReason() !== undefined;
    const check = () => { if (stop()) throw Error(`rune bank craft stopped at ${stage}: ${stopReason()}`); };
    const inv = () => s.sdk.getInventory();
    const count = (id: number) => {
        const items = inv();
        let n = 0;
        for (let i = 0; i < items.length; i++) if (items[i]!.id === id) n += items[i]!.count;
        return n;
    };
    const bankCount = (id: number) => {
        const items = s.bankObservation?.()?.items;
        if (!items) return 0;
        let n = 0;
        for (let i = 0; i < items.length; i++) if (items[i]!.id === id) n += items[i]!.count;
        return n;
    };
    const level = () => s.sdk.getSkill('Runecraft')?.baseLevel ?? 0;
    const currentLevel = () => s.sdk.getSkill('Runecraft')?.level ?? NaN;
    const xp = () => s.sdk.getSkillXp('Runecraft') ?? NaN;
    let ledger: RuneBankLedger | undefined, consumed = 0, crafted = 0, trips = 0, level0 = 0, xp0 = 0;
    const tripResults: { altar: string; level: number; consumed: number; crafted: number; xp: number }[] = [];
    let chosen: RuneAltar | undefined;
    const activeAltars = forced === 'cosmic' ? [COSMIC_ALTAR] : RUNE_ALTARS;
    const bankSpot = forced === 'cosmic' ? ZANARIS_BANK : BANK;
    const runeCount = () => {
        let n = 0;
        for (let i = 0; i < activeAltars.length; i++) n += count(activeAltars[i]!.rune);
        return n;
    };
    const action = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
        const record = (phase: string) => console.log('RUNE_BANK_ACTION ' + JSON.stringify({
            tick: s.tick(),
            stage,
            action: name,
            phase,
            position: pos() ? { x: pos()!.worldX, z: pos()!.worldZ, level: pos()!.level } : null,
            essence: count(ESSENCE),
            air: count(AIR),
            bankEssence: bankCount(ESSENCE),
            bankAir: bankCount(AIR),
            runecraftXp: xp(),
        }));
        record('start');
        try {
            const r = await work();
            record('end');
            return r;
        } catch (error) {
            record('error');
            throw error;
        }
    };
    const travel = async (to: Tile) => {
        check();
        const r = await action(`walk:${to.x},${to.z}`, async () => goTo(s, await getWorldFn(), to, accountOfFn(s)));
        if (!r.ok) throw Error(`route refusal ${stage}: ${JSON.stringify(r)}`);
        check();
    };
    const open = async () => {
        check();
        const generation = s.bankObservation?.()?.generation ?? 0;
        if (!(await action('open-bank', () => s.bot.openBank())).success || !await waitUntil(s, () => !!state()?.bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 15 })) {
            throw Error(`bank observation unavailable at ${stage}`);
        }
    };
    const close = () => action('close-bank', () => s.bot.closeBank());
    const withdraw = async (id: number, n: number) => {
        const item = state()?.bank.items.find(i => i.id === id), stored = bankCount(id), held = count(id), generation = s.bankObservation?.()?.generation ?? 0;
        if (!item || stored < n) throw Error(`next acquisition: item${id} needs${n}, bank has${stored}`);
        await action(`withdraw:${id}:${n}`, () => s.bot.withdrawItem(item, n));
        if (!await waitUntil(s, () => count(id) === held + n && bankCount(id) === stored - n && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 10 })) {
            throw Error(`withdraw debit/credit unobserved item${id}`);
        }
    };
    const secure = async () => {
        for (const id of new Set(inv().map(i => i.id))) {
            check();
            const item = inv().find(i => i.id === id);
            if (id !== chosen?.talisman && item) await action(`deposit:${id}`, () => depositObserved(s, item));
        }
    };
    const craft = async (a: RuneAltar) => {
        check();
        const before = { essence: count(ESSENCE), runes: count(a.rune), xp: xp(), level: production ? currentLevel() : level() };
        if (!insideRuneAltar(a, pos()) || before.essence < 1) throw Error(`${a.name} craft entry unobserved`);
        if (forced !== undefined && a.name !== forced) throw Error(`requested ${forced} altar, observed ${a.name}`);
        if (production && before.essence > essenceTarget! - consumed) throw Error('carried essence exceeds remaining production target');
        if (a.name === 'air' && !production) await action('craft-air', () => craftAirRunes(s, stop));
        else {
            await s.bot.dismissBlockingUI();
            check();
            let altar = s.sdk.findNearbyLoc(/^altar$/i, { withOption: /craft/i });
            if (!altar) {
                await action(`approach-${a.name}-altar`, async () => walkPath(await sessionWalker(s), [{ x: a.inside.x, z: a.inside.z, tol: 5 }], { maxTicks: 60, stop }));
                check();
                altar = s.sdk.findNearbyLoc(/^altar$/i, { withOption: /craft/i });
            }
            if (!altar) throw Error(`${a.name} craft altar unobserved`);
            await action(`craft-${a.name}`, () => s.bot.interactLoc(altar, /craft/i));
            if (!await waitUntil(s, () => stop() || (count(ESSENCE) === 0 && count(a.rune) > before.runes && (production || xp() > before.xp)), { timeoutTicks: 15 })) {
                throw Error(`${a.name} craft effects unobserved`);
            }
        }
        check();
        const used = before.essence - count(ESSENCE), made = count(a.rune) - before.runes;
        const receipt = production
            ? made === used * (Math.floor(before.level / a.multiplier) + 1) && runeBankXpBalanced(before.xp, xp(), used * a.xp)
            : made >= used && xp() > before.xp;
        if (count(ESSENCE) !== 0 || used !== before.essence || !receipt) throw Error(`${a.name} craft debit/credit/XP mismatch`);
        consumed += used;
        crafted += made;
        if (ledger?.runes) ledger.runes[a.rune]!.crafted += made;
        tripResults.push({ altar: a.name, level: before.level, consumed: used, crafted: made, xp: xp() - before.xp });
    };
    const enter = async (a: RuneAltar) => {
        check();
        if (a.name === 'air') { await action('enter-air', () => enterAirAltar(s)); return; }
        const { at, q } = ruinTarget(a);
        const observed = () => state()?.nearbyLocs.find(l => l.id === q.id && l.x === at.x && l.z === at.z && l.level === at.level);
        if (!observed() || count(a.talisman) < 1) throw Error(`${a.name} ruins/talisman unobserved`);
        const face = await interactionApproach(s.sdk, at, q);
        check();
        if (!face) throw Error(`${a.name} ruins approach unavailable`);
        const atFace = () => pos()?.worldX === face.x && pos()?.worldZ === face.z && pos()?.level === face.level;
        if (!atFace()) {
            const walked = await action(`approach-${a.name}-ruins`, async () => walkPath(await sessionWalker(s), [{ x: face.x, z: face.z, tol: 0 }], { maxTicks: 60, stop }));
            check();
            if (!walked.ok || !atFace()) throw Error(`${a.name} ruins approach unobserved: ${walked.detail ?? 'off face'}`);
        }
        const settled = await action(`close-${a.name}-entry-modal`, () => settleRuneEntryModal(s, stop));
        check();
        if (!settled) throw Error(`${a.name} entry modal closure unobserved`);
        const baseline = state(), revision = baseline?.revision ?? 0, entryTick = baseline?.tick ?? s.tick();
        let request: object | null = null;
        const observe = (phase: string, extra: object = {}) => console.log('RUNE_ENTRY_OBSERVATION ' + JSON.stringify({
            phase,
            altar: a.name,
            request,
            state: runeEntrySnapshot(state(), revision, entryTick),
            ...extra,
        }));
        observe('before');
        const off = s.onTick(() => observe('tick'));
        let entry: RuneEntryResult;
        try {
            entry = await dispatchRuneEntry(s, {
                stop,
                entered: () => insideRuneAltar(a, pos()),
                dispatch: async attempt => {
                    const fresh = await interactionApproach(s.sdk, at, q), item = inv().find(i => i.id === a.talisman);
                    check();
                    if (!fresh || fresh.x !== face.x || fresh.z !== face.z || !atFace() || !observed() || !item) {
                        throw Error(`${a.name} ruins approach or talisman changed`);
                    }
                    request = { attempt, itemSlot: item.slot, itemId: item.id, itemCount: item.count, x: at.x, z: at.z, level: at.level, locId: q.id, inventoryComponent: 3214 };
                    const reply = await action(`enter-${a.name}`, () => s.sdk.sendUseItemOnLoc(item.slot, at.x, at.z, q.id));
                    observe('reply', { reply });
                    return reply;
                },
            });
        } finally {
            off();
            observe('end');
        }
        check();
        if (!entry.entered || !insideRuneAltar(a, pos())) {
            throw Error(`${a.name} ${entry.failure ?? 'altar entry stopped'} after ${entry.dispatches} dispatches, ${entry.warnings} warnings`);
        }
    };
    const exit = async (a: RuneAltar) => {
        check();
        if (a.name === 'air') { await action('exit-air', () => exitAirAltar(s, stop)); return; }
        const findPortals = () => {
            const nearby = state()?.nearbyLocs ?? [];
            const found: typeof nearby = [];
            for (let i = 0; i < nearby.length; i++) {
                const l = nearby[i]!;
                if (l.id !== a.portal) continue;
                const opts = l.optionsWithIndex;
                for (let j = 0; j < opts.length; j++) {
                    const o = opts[j]!;
                    if (o.opIndex === 1 && USE_PORTAL_RE.test(o.text)) {
                        found.push(l);
                        break;
                    }
                }
            }
            if (found.length > 1) found.sort((x, y) => x.distance - y.distance);
            return found;
        };
        let portals = findPortals();
        if (!portals.length && a.name === 'cosmic') {
            await action('approach-cosmic-portal', async () => walkPath(await sessionWalker(s), [{ x: COSMIC_EXIT_APPROACH.x, z: COSMIC_EXIT_APPROACH.z, tol: 4 }], { maxTicks: 40, stop }));
            check();
            portals = findPortals();
        }
        let portal: typeof portals[number] | undefined, edge: Tile | undefined;
        for (const cand of portals) {
            const edges = [tile(cand.x, cand.z + 1, a.inside.level), tile(cand.x + 1, cand.z, a.inside.level), tile(cand.x, cand.z - 1, a.inside.level), tile(cand.x - 1, cand.z, a.inside.level)];
            const found = edges.find(e => { const p = s.sdk.findPath(e.x, e.z); return p.success && p.reachedDestination === true; });
            if (found) { portal = cand; edge = found; break; }
        }
        if (!portals.length) throw Error(`${a.name} exit portal unobserved`);
        if (!portal || !edge) throw Error(`${a.name} exit approach unavailable`);
        const walked = await action(`approach-${a.name}-portal`, () => s.bot.walkTo(edge.x, edge.z, 0, { timeout: 10000 }));
        check();
        if (!walked.success || pos()?.worldX !== edge.x || pos()?.worldZ !== edge.z || pos()?.level !== edge.level) throw Error(`${a.name} exit approach unobserved`);
        const reply = await action(`exit-${a.name}`, () => s.sdk.sendInteractLoc(portal.x, portal.z, portal.id, 1));
        if (!reply.success) throw Error(`${a.name} exit action refused`);
        const outside = () => !!pos() && pos()!.level === a.outside.level && Math.max(Math.abs(pos()!.worldX - a.outside.x), Math.abs(pos()!.worldZ - a.outside.z)) <= 2;
        if (!await waitUntil(s, () => stop() || outside(), { timeoutTicks: 20 })) throw Error(`${a.name} exit unobserved`);
        check();
        if (!outside()) throw Error(`${a.name} exit stopped`);
    };
    const xpBalanced = () => {
        let expected = 0;
        for (let i = 0; i < tripResults.length; i++) {
            const t = tripResults[i]!;
            expected += t.consumed * ALL_ALTARS_BY_NAME.get(t.altar)!.xp;
        }
        return runeBankXpBalanced(xp0, xp(), expected);
    };
    const summary = () => ({
        target,
        essenceTarget,
        stage,
        trips,
        consumed,
        crafted,
        ledger,
        tripResults,
        altar: chosen?.name,
        level0,
        level: level(),
        xp: xp() - xp0,
        ...(production ? { xpBalanced: xpBalanced() } : {}),
        held: { essence: count(ESSENCE), air: count(AIR), runes: runeCount() },
        ticks: s.tick() - start,
        position: pos(),
    });
    try {
        if (!await waitUntil(s, () => !!pos() && level() > 0 && Array.isArray(state()?.inventory), { timeoutTicks: 30 })) {
            throw Error('entry position, skills or pack unobserved');
        }
        level0 = level();
        xp0 = xp();
        if (production && !runeBankXpBalanced(xp0, xp0, 0)) throw Error('entry Runecraft XP unobserved or outside pinned cap');
        if (production && (!Number.isSafeInteger(currentLevel()) || currentLevel() < 1)) throw Error('entry current Runecraft level unobserved');
        const held0 = { essence: count(ESSENCE), air: count(AIR) };
        const initialRunes = Object.fromEntries(activeAltars.map(a => [a.rune, count(a.rune)]));
        const resumed = activeAltars.find(a => insideRuneAltar(a, pos()));
        if (resumed) {
            stage = 'altar-resume';
            chosen = resumed;
            const requested = forced === undefined || resumed.name === forced;
            const bounded = !production || count(ESSENCE) <= essenceTarget!;
            const accessible = forced === undefined || (currentLevel() >= resumed.level && count(resumed.talisman) > 0);
            if (count(ESSENCE) > 0 && requested && bounded && accessible) await craft(resumed);
            await exit(resumed);
        }
        if (forced === 'cosmic' && !inZanarisCosmic(pos())) {
            stage = 'zanaris-entry';
            const wornStaff = () => (state()?.equipment ?? []).some(e => e.id === DRAMEN_STAFF);
            if (!wornStaff() && count(DRAMEN_STAFF) < 1) {
                await travel(DRAYNOR_BANK);
                await open();
                for (const id of new Set(inv().map(i => i.id))) {
                    if (id !== COSMIC_ALTAR.talisman && id !== DRAMEN_STAFF) {
                        const item = inv().find(i => i.id === id);
                        if (item) await action(`deposit:${id}`, () => depositObserved(s, item));
                    }
                }
                if (bankCount(DRAMEN_STAFF) < 1) throw Error('next acquisition: dramen staff 772 required for cosmic altar');
                await withdraw(DRAMEN_STAFF, 1);
                await close();
            }
            const staff = inv().find(i => i.id === DRAMEN_STAFF);
            if (!wornStaff() && staff) {
                await s.bot.equipItem(staff);
                if (!await waitUntil(s, () => stop() || wornStaff(), { timeoutTicks: 8 })) throw Error('cosmic zanaris entry: dramen staff equip failed');
            }
            if (!wornStaff()) throw Error('next acquisition: dramen staff 772 required for cosmic altar');
            await travel({ x: 3201, z: 3169, level: 0 });
            for (let i = 0; i < 4 && !inZanarisCosmic(pos()) && !stop(); i++) {
                await s.direct({ type: 'interactLoc', x: 3202, z: 3169, locId: 2406, optionIndex: 1, reason: 'SDK' });
                await waitUntil(s, () => stop() || inZanarisCosmic(pos()), { timeoutTicks: 10 });
            }
            if (!inZanarisCosmic(pos())) throw Error('cosmic zanaris entry: shed door 2406 did not enter Zanaris');
        }
        let bankEssence = NaN;
        while (true) {
            check();
            stage = 'bank';
            await travel(bankSpot);
            await open();
            ledger ??= {
                essence0: held0.essence + bankCount(ESSENCE),
                essence: 0,
                air0: held0.air + bankCount(AIR),
                air: 0,
                consumed: 0,
                crafted: 0,
                runes: Object.fromEntries(activeAltars.map(a => [a.rune, {
                    before: initialRunes[a.rune]! + bankCount(a.rune),
                    after: 0,
                    crafted: tripResults.filter(t => t.altar === a.name).reduce((n, t) => n + t.crafted, 0),
                }])),
            };
            const owned = new Set([...inv(), ...(s.bankObservation?.()?.items ?? [])].filter(i => i.count > 0).map(i => i.id));
            const selection = chooseRuneAltar(forced === undefined ? level() : currentLevel(), owned, forced);
            chosen = selection.altar;
            for (const name of selection.wanted) console.log(`TALISMAN_WANTED ${name}`);
            await secure();
            bankEssence = bankCount(ESSENCE);
            if (runeBankDone(level(), target, bankEssence, essenceTarget, consumed)) {
                if (level() < target && consumed === 0) throw Error('next acquisition: rune essence1436 exhausted before any crafting');
                break;
            }
            if (production && bankEssence < essenceTarget! - consumed) {
                throw Error(`next acquisition: rune essence1436 needs${essenceTarget! - consumed}, bank has${bankEssence}; production target${essenceTarget} incomplete`);
            }
            if (!chosen) throw Error('next acquisition: no accessible altar talisman in pack or bank');
            console.log('RUNE_BANK_ALTAR ' + JSON.stringify({ trip: trips + 1, altar: chosen.name, level: level(), xpPerEssence: chosen.xp }));
            if (count(chosen.talisman) < 1) await withdraw(chosen.talisman, 1);
            const n = Math.min(bankEssence, 28 - inv().length, production ? essenceTarget! - consumed : Infinity);
            if (n < 1) throw Error('next acquisition: free pack slots for rune essence');
            await withdraw(ESSENCE, n);
            await close();
            stage = 'altar';
            await travel(runeAltarStaging(chosen));
            await enter(chosen);
            check();
            await craft(chosen);
            await exit(chosen);
            trips++;
            console.log('RUNE_BANK_PROGRESS ' + JSON.stringify({ at: new Date().toISOString(), target, trips, altar: chosen.name, level: level(), consumed, crafted }));
        }
        stage = 'final';
        Object.assign(ledger!, { essence: bankCount(ESSENCE) + count(ESSENCE), air: bankCount(AIR) + count(AIR), consumed, crafted });
        for (const a of activeAltars) if (ledger?.runes) ledger.runes[a.rune]!.after = bankCount(a.rune) + count(a.rune);
        const result = summary();
        await close();
        if (production && !xpBalanced()) throw Error('rune bank whole-order XP receipt failed');
        const ok = runeBankOk({ ledger, level0, level: result.level, target, bankEssence, held: result.held, stopped: stop(), essenceTarget });
        return { ok, ...result, bankEssence };
    } catch (error) {
        return { ok: false, ...summary(), stopReason: stopReason(), failure: String(error) };
    }
}
