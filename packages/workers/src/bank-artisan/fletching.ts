// Unified fletching worker combining fletch-shafts, fletch-arrows, and fletch-worker.
// Usage: [MODE: arrows | headless | steel | shafts | bows] [TIP_TYPE: rune | adamant | mithril | steel]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { accountOf, getWorld, openBot, finish, countItems, settle } from '../../../core/src/bot';
import { longbowIds } from '../../../core/src/content-facts';
import { depositObserved, depositPack } from '../../../core/src/deposit';
import { killTree } from '../../../core/src/proc';
import { statusReadDirs } from '../../../core/src/practice-paths';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { knownBanks } from '../../../core/src/trip';
import { goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import { CONTENT_DIR, packMap, REPO_ROOT } from './catalog';
import { productionStopRequested } from './runtime';
import type { Session } from './types';

// ---- BiS PvP Fletching Recipes (Magic shortbow & Rune arrows) ----
// Verified against vendor/rs-sdk/server/content/pack/obj.pack & cut_logs.dbrow / bows.dbrow.
export const PVP_FLETCH_RECIPES = {
    magic_shortbow: {
        key: 'magic_shortbow',
        logId: 1513,
        unstrungId: 72,
        bowStringId: 1777,
        productId: 861,
        level: 80,
        cutMode: 'cut-bow:unstrung_magic_shortbow',
        stringMode: 'bow-string:magic_shortbow',
    },
    rune_arrow: {
        key: 'rune_arrow',
        tipId: 44,
        headlessId: 53,
        productId: 892,
        level: 75,
        metal: 'rune' as const,
        batchSize: 15,
    },
} as const;

export function planMagicShortbowBatch(
    stock: Record<number, number>,
    fletchingLevel: number,
    target: number,
    reserves: { logs?: number; strings?: number } = {},
) {
    if (!Number.isSafeInteger(target) || target < 1) throw Error('invalid magic shortbow target');
    const r = PVP_FLETCH_RECIPES.magic_shortbow;
    if (fletchingLevel < r.level) throw Error(`magic shortbow requires Fletching ${r.level}, has ${fletchingLevel}`);
    const availLogs = Math.max(0, (stock[r.logId] ?? 0) - (reserves.logs ?? 0));
    const availUnstrung = Math.max(0, stock[r.unstrungId] ?? 0);
    const availStrings = Math.max(0, (stock[r.bowStringId] ?? 0) - (reserves.strings ?? 0));
    const canStringExisting = Math.min(target, availUnstrung, availStrings);
    const remainingAfterExisting = Math.max(0, target - canStringExisting);
    const cutLogs = Math.min(remainingAfterExisting, availLogs, Math.max(0, availStrings - canStringExisting));
    const stringTotal = canStringExisting + cutLogs;
    return {
        cutLogs,
        stringTotal,
        shortfallLogs: Math.max(0, target - availUnstrung - availLogs),
        shortfallStrings: Math.max(0, target - availStrings),
        cutMode: r.cutMode,
        stringMode: r.stringMode,
        productId: r.productId,
    };
}

export function planRuneArrowBatch(
    stock: Record<number, number>,
    fletchingLevel: number,
    target: number,
    reserves: { headless?: number; tips?: number } = {},
) {
    if (!Number.isSafeInteger(target) || target < 1) throw Error('invalid rune arrow target');
    const r = PVP_FLETCH_RECIPES.rune_arrow;
    if (fletchingLevel < r.level) throw Error(`rune arrows require Fletching ${r.level}, has ${fletchingLevel}`);
    const availHeadless = Math.max(0, (stock[r.headlessId] ?? 0) - (reserves.headless ?? 0));
    const availTips = Math.max(0, (stock[r.tipId] ?? 0) - (reserves.tips ?? 0));
    const craftable = Math.min(target, availHeadless, availTips);
    return {
        craftable,
        actions: Math.ceil(craftable / r.batchSize),
        shortfallHeadless: Math.max(0, target - availHeadless),
        shortfallTips: Math.max(0, target - availTips),
        metal: r.metal,
        productId: r.productId,
    };
}

// ---- Arrow Shafts (fletch-shafts.ts) ----

const LOG = 1511;
const SHAFT = 52;
const KNIFE = 946;

export async function runShafts(
    s: Session,
    o: {
        cap: number;
        maximum: number;
        reserve: number;
        bankKnife?: boolean;
        stop?: () => boolean;
        pause?: () => boolean;
        travel?: (to: { x: number; z: number; level: number }) => Promise<{ ok: boolean; detail?: string }>;
    },
) {
    if (![o.cap, o.maximum, o.reserve].every(Number.isSafeInteger) || o.cap < 1 || o.maximum < 1 || o.maximum > 25 || o.reserve < 0) {
        throw Error('shafts requires positive CAP, MAX_MAKE1..25 logs and nonnegative LOG_RESERVE');
    }
    if (!await waitUntil(s, () => !!s.sdk.getState()?.player && (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0, { timeoutTicks: 15 })) {
        throw Error('shafts skill sync failed');
    }
    const start = s.tick();
    const first = s.sdk.getState()!.player!;
    const initialXp = s.sdk.getSkillXp('Fletching') ?? 0;
    const inv = () => s.sdk.getInventory();
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const initialHp = hp();
    let hpMin = initialHp;
    let ended = false;
    let died = false;
    let damaged = false;
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        const now = hp();
        hpMin = Math.min(hpMin, now);
        damaged ||= now < initialHp;
        died ||= now <= 0 || (!!p && (p.isDead || p.lifeId !== first.lifeId || (p.respawnCount ?? 0) > (first.respawnCount ?? 0)));
    });
    const over = () => ended || died || damaged || !!o.stop?.() || !!o.pause?.() || s.tick() - start >= o.cap;
    const hold = () => {
        if (o.pause?.()) throw Error('shafts owner pause');
    };
    let snapshot: { id: number; count: number }[] = [];
    let known = false;
    let initial: Map<number, number> | undefined;
    let planned = 0;
    let logsUsed = 0;
    let made = 0;
    let actions = 0;
    let bankTrips = 0;
    let failure = '';
    let stop = 'input-insufficient';
    const capture = () => {
        const b = s.bankObservation?.();
        if (!b) throw Error('shafts bank observation missing');
        snapshot = b.items.map(i => ({ id: i.id, count: i.count }));
        known = true;
    };
    const bankCount = (id: number) => snapshot.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const totals = () => {
        const m = new Map<number, number>();
        for (const i of [...inv(), ...s.sdk.getEquipment(), ...snapshot]) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        return m;
    };
    const open = async () => {
        if (!s.sdk.getState()?.bank.isOpen) {
            const generation = s.bankObservation?.()?.generation ?? 0;
            if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 10 })) {
                throw Error('shafts bank unavailable');
            }
            bankTrips++;
        }
        capture();
    };
    const deposit = async () => {
        let deposited = false;
        for (const id of [LOG, SHAFT]) {
            if (held(id)) {
                hold();
                if (!(await s.bot.depositItem(inv().find(i => i.id === id)!, -1)).success || !await waitUntil(s, () => held(id) === 0, { timeoutTicks: 5 })) {
                    throw Error('shafts deposit incomplete');
                }
                deposited = true;
            }
        }
        if (deposited && !s.bankObservation?.()) await waitTicks(s, 1);
        capture();
    };
    try {
        if (inv().some(i => /logs/i.test(i.name) && i.id !== LOG)) throw Error('shafts unrelated held logs or notes');
        // A start away from a bank (for example a mine) walks to the nearest bank first. A stop during that walk is a
        // stop, and a failed walk is a refusal, not a log shortage.
        const p = s.sdk.getState()?.player;
        const bank = p && !s.sdk.getState()?.bank.isOpen ? nearestBankStand(p) : undefined;
        if (p && bank && cheb(bank, p) > 2) {
            const moved = await walkToShaftsBank(s, bank, () => over() || !!o.pause?.(), o.travel);
            if (o.stop?.() || o.pause?.()) {
                stop = 'stopped';
                throw Error('shafts stopped during the walk to the bank');
            }
            if (!moved.ok) {
                stop = 'refused';
                throw Error(`shafts walk to the bank at ${bank.x},${bank.z} failed: ${moved.detail ?? 'no detail'}`);
            }
        }
        try {
            await open();
        } catch (e) {
            stop = 'refused';
            throw e;
        }
        initial = totals();
        await deposit();
        planned = Math.max(0, Math.min(o.maximum, bankCount(LOG) - o.reserve));
        if (planned > 0) {
            if (!held(KNIFE)) {
                hold();
                const knife = s.sdk.getState()!.bank.items.find(i => i.id === KNIFE);
                if (!knife || !(await s.bot.withdrawItem(knife, 1, { asNote: false })).success || !await waitUntil(s, () => held(KNIFE) === 1, { timeoutTicks: 5 })) {
                    throw Error('shafts owned knife required');
                }
            }
            while (logsUsed < planned && !over()) {
                const batch = Math.min(planned - logsUsed, 27 - inv().length);
                if (batch < 1) throw Error('shafts kit leaves no input slots');
                hold();
                const logs = s.sdk.getState()!.bank.items.find(i => i.id === LOG);
                if (!logs || !(await s.bot.withdrawItem(logs, batch, { asNote: false })).success || !await waitUntil(s, () => held(LOG) === batch, { timeoutTicks: 5 })) {
                    throw Error('shafts withdrawal incomplete');
                }
                await s.bot.closeBank();
                for (let n = 0; n < batch && !over(); n++) {
                    let misses = 0;
                    while (!over()) {
                        const before = held(SHAFT);
                        const raw = held(LOG);
                        const xp = s.sdk.getSkillXp('Fletching') ?? 0;
                        await s.bot.fletchLogs('Arrow Shafts');
                        actions++;
                        await waitUntil(s, () => held(SHAFT) !== before || held(LOG) !== raw || over(), { timeoutTicks: 6 });
                        const debit = raw - held(LOG);
                        const gain = held(SHAFT) - before;
                        if (debit || gain) {
                            if (debit !== 1 || gain !== 15 || (s.sdk.getSkillXp('Fletching') ?? 0) <= xp) {
                                throw Error('shafts crafting accounting/XP mismatch');
                            }
                            logsUsed++;
                            made += gain;
                            break;
                        }
                        if (++misses >= 3) throw Error('no fletching progress: shafts unchanged after three calls');
                    }
                }
                if (o.pause?.()) break;
                await open();
                await deposit();
            }
            stop = logsUsed === o.maximum ? 'max-make' : over() ? (o.stop?.() || o.pause?.() ? 'stopped' : 'cap') : 'input-insufficient';
        }
    } catch (e) {
        failure = String(e);
    } finally {
        if (!ended && !died && known && !o.pause?.()) {
            try {
                await open();
                await deposit();
                if (o.bankKnife && held(KNIFE)) {
                    hold();
                    if (!(await s.bot.depositItem(inv().find(i => i.id === KNIFE)!, -1)).success || !await waitUntil(s, () => held(KNIFE) === 0, { timeoutTicks: 5 })) {
                        throw Error('shafts knife return incomplete');
                    }
                    if (!s.bankObservation?.()) await waitTicks(s, 1);
                    capture();
                }
                await s.bot.closeBank();
            } catch (e) {
                failure ||= String(e);
            }
        }
        off();
    }
    const final = totals();
    const changes = new Map([[LOG, -logsUsed], [SHAFT, made]]);
    const preserved = !!initial && [...new Set([...initial.keys(), ...final.keys(), ...changes.keys()])].every(id => (final.get(id) ?? 0) === (initial!.get(id) ?? 0) + (changes.get(id) ?? 0));
    const banked = initial ? bankCount(SHAFT) - (initial.get(SHAFT) ?? 0) : 0;
    const targetMet = logsUsed === o.maximum && banked === o.maximum * 15 && held(LOG) === 0 && held(SHAFT) === 0;
    const knifeStored = held(KNIFE) === 0 && bankCount(KNIFE) >= 1;
    return {
        ok: !failure && !ended && !died && !damaged && !o.stop?.() && !o.pause?.() && preserved && targetMet && (!o.bankKnife || knifeStored),
        ticks: s.tick() - start,
        planned,
        logsUsed,
        made,
        banked,
        actions,
        bankTrips,
        xpGain: (s.sdk.getSkillXp('Fletching') ?? 0) - initialXp,
        hpMin,
        died,
        damaged,
        preserved,
        targetMet,
        knifeStored,
        stop,
        failure: failure || '-',
    };
}

// ---- Arrows, Headless Arrows, and Oak Bows (fletch-arrows.ts) ----

export const BANK_WALK_LIMIT = 80;
function cheb(a: { x: number; z: number }, p: { worldX: number; worldZ: number }) {
    return Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
}

export function nearestBankStand(p: { worldX: number; worldZ: number; level: number }, banks = knownBanks()) {
    return banks.filter(b => b.level === p.level).sort((a, b) => cheb(a, p) - cheb(b, p))[0];
}

// A near bank is a local walk. A far bank takes the world route, which uses ships and other transport.
async function walkToShaftsBank(
    s: Session,
    bank: { x: number; z: number; level: number },
    halt: () => boolean,
    travel?: (to: { x: number; z: number; level: number }) => Promise<{ ok: boolean; detail?: string }>,
): Promise<{ ok: boolean; detail?: string }> {
    if (travel) return travel(bank);
    const p = s.sdk.getState()!.player!;
    if (cheb(bank, p) <= BANK_WALK_LIMIT) return walkPath(await sessionWalker(s), [{ ...bank, tol: 1 }], { maxTicks: 400, stop: halt });
    const ac = new AbortController();
    const off = s.onTick(() => {
        if (halt()) ac.abort('shafts travel stop');
    });
    try {
        return await goTo(s, await getWorld(), bank, accountOf(s), { legTimeoutTicks: 100, signal: ac.signal });
    } finally {
        off();
    }
}

export interface HeadlessOptions {
    cap: number;
    maximum: number;
    shaftReserve: number;
    featherReserve: number;
    stop?: () => boolean;
    pause?: () => boolean;
}

const HEADLESS = 53;
const FEATHER = 314;
const MATERIALS = new Set([SHAFT, HEADLESS, FEATHER]);

export function planHeadless(shafts: number, feathers: number, maximum = 390, shaftReserve = 200, featherReserve = 100): number {
    return Math.max(0, Math.floor(Math.min(maximum, shafts - shaftReserve, feathers - featherReserve) / 15) * 15);
}

export async function runHeadless(s: Session, options: HeadlessOptions) {
    for (const [name, value] of Object.entries({ cap: options.cap, maximum: options.maximum, shaftReserve: options.shaftReserve, featherReserve: options.featherReserve })) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid headless ${name}`);
    }
    if (options.cap <= 0 || options.maximum <= 0 || options.maximum % 15 || options.shaftReserve < 100 || options.featherReserve < 100) {
        throw new Error('headless needs positive CAP, MAX_MAKE multiple15, SHAFT_RESERVE>=100 and FEATHER_RESERVE>=100');
    }
    const synced = await waitUntil(s, () => (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0 && (s.sdk.getSkill('Fletching')?.baseLevel ?? 0) > 0, { timeoutTicks: 15 });
    if (!synced) throw new Error('headless skill sync failed');
    const inv = () => s.sdk.getInventory();
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const xp = () => s.sdk.getSkillXp('Fletching') ?? 0;
    const initialXp = xp();
    const start = s.tick();
    const player = s.sdk.getState()?.player;
    let ended = false;
    let died = false;
    let hpMin = s.sdk.getSkill('Hitpoints')!.level;
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        hpMin = Math.min(hpMin, s.sdk.getSkill('Hitpoints')?.level ?? hpMin);
        if (p?.isDead || hpMin <= 0 || (p?.respawnCount ?? 0) > (player?.respawnCount ?? 0) || (player?.lifeId !== undefined && (p?.lifeId ?? player.lifeId) !== player.lifeId)) {
            died = true;
        }
    });
    const over = () => ended || died || options.stop?.() || options.pause?.() || s.tick() - start >= options.cap;
    const hold = () => {
        if (options.pause?.()) throw new Error('headless owner pause');
    };
    const protectedItems = new Map<number, number>();
    for (const item of inv()) if (!MATERIALS.has(item.id)) protectedItems.set(item.id, (protectedItems.get(item.id) ?? 0) + item.count);
    let made = 0;
    let banked = 0;
    let actions = 0;
    let bankTrips = 0;
    let planned = 0;
    let originalOutput: number | undefined;
    let stop = 'input-insufficient';
    let failure = '';
    let bankSnapshot: { id: number; count: number }[] | undefined;
    const open = async () => {
        if (!s.sdk.getState()?.bank?.isOpen) {
            const result = await s.bot.openBank();
            if (!result.success) throw new Error(`headless bank: ${result.message}`);
            bankTrips++;
            await waitTicks(s, 1);
        }
        if (!s.sdk.getState()?.bank?.isOpen) throw new Error('headless bank state not observed');
    };
    const deposit = async () => {
        for (const id of new Set(inv().filter(i => MATERIALS.has(i.id)).map(i => i.id))) {
            hold();
            const item = inv().find(i => i.id === id)!;
            await s.bot.depositItem(item, -1);
            if (held(id) > 0) throw new Error(`headless deposit incomplete: ${item.name}`);
        }
        await waitTicks(s, 1);
        bankSnapshot = (s.sdk.getState()?.bank?.items ?? []).map(i => ({ id: i.id, count: i.count }));
    };
    const bankCount = (id: number) => bankSnapshot?.filter(i => i.id === id).reduce((n, i) => n + i.count, 0) ?? 0;
    try {
        await open();
        await deposit();
        originalOutput = bankCount(HEADLESS);
        planned = planHeadless(bankCount(SHAFT), bankCount(FEATHER), options.maximum, options.shaftReserve, options.featherReserve);
        if (planned > 0 && !over()) {
            if (28 - inv().length < 3) throw new Error('headless needs three free slots; protected kit stays held');
            for (const id of [SHAFT, FEATHER]) {
                hold();
                const item = s.sdk.getState()!.bank.items.find(i => i.id === id)!;
                await s.bot.withdrawItem(item, planned, { asNote: false });
                if (held(id) !== planned) throw new Error(`no progress: headless withdrawal incomplete for ${item.name}`);
            }
            await s.bot.closeBank();
            let misses = 0;
            while (made < planned && !over()) {
                const shafts = inv().find(i => i.id === SHAFT);
                const feathers = inv().find(i => i.id === FEATHER);
                if (!shafts || !feathers || held(SHAFT) < 15 || held(FEATHER) < 15) throw new Error('headless input accounting shortfall');
                const beforeOutput = held(HEADLESS);
                const beforeShaft = held(SHAFT);
                const beforeFeather = held(FEATHER);
                if (s.sdk.getDialog()?.isOpen || s.sdk.getState()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                await s.sdk.sendUseItemOnItem(shafts.slot, feathers.slot);
                actions++;
                await waitUntil(s, () => held(HEADLESS) > beforeOutput || over(), { timeoutTicks: 5 });
                const gained = held(HEADLESS) - beforeOutput;
                if (gained > 0) {
                    if (gained !== 15 || beforeShaft - held(SHAFT) !== gained || beforeFeather - held(FEATHER) !== gained) {
                        throw new Error('headless input/output accounting mismatch');
                    }
                    made += gained;
                    misses = 0;
                } else if (++misses >= 3) {
                    stop = 'no-progress';
                    throw new Error('no progress: headless item-on-item failed three times');
                }
            }
            stop = made === options.maximum ? 'max-make' : over() ? (options.stop?.() || options.pause?.() ? 'stopped' : 'cap') : 'input-insufficient';
        }
    } catch (e) {
        failure = String(e);
    } finally {
        if (!ended && !died && !options.pause?.()) {
            try {
                await open();
                await deposit();
                banked = originalOutput === undefined ? 0 : Math.max(0, bankCount(HEADLESS) - originalOutput);
            } catch (e) {
                failure ||= `cleanup ${String(e)}`;
            }
        }
        off();
    }
    const preserved = [...protectedItems].every(([id, count]) => held(id) >= count);
    const reserveMet = !!bankSnapshot && bankCount(SHAFT) >= options.shaftReserve && bankCount(FEATHER) >= options.featherReserve;
    const xpGain = xp() - initialXp;
    if (!preserved) failure ||= 'headless protected asset shortfall';
    if (made > 0 && (!reserveMet || banked !== made || xpGain <= 0)) failure ||= 'headless final bank/reserve/XP proof failed';
    if (held(HEADLESS) > 0) failure ||= 'headless output remains unbanked';
    const targetMet = made === options.maximum && banked === made && reserveMet;
    return {
        ok: !failure && !died && !ended && stop !== 'stopped',
        ticks: s.tick() - start,
        made,
        banked,
        planned,
        actions,
        bankTrips,
        xpGain,
        shaftBank: bankCount(SHAFT),
        featherBank: bankCount(FEATHER),
        headlessBank: bankCount(HEADLESS),
        heldHeadless: held(HEADLESS),
        reserveMet,
        preserved,
        targetMet,
        stop,
        hpMin,
        died,
        failure: failure || '-',
    };
}

export const ARROW_METALS = ['bronze', 'iron', 'steel', 'mithril', 'adamant', 'rune'] as const;
export type ArrowMetal = (typeof ARROW_METALS)[number];
type ArrowProfile = { metal: ArrowMetal; tip: number; product: number; units: number; level: number; rawXpPerArrow: number; tipName: string };
const arrowProfiles = new Map<ArrowMetal, ArrowProfile>();
let cachedArrowsDbrow: string | undefined;
let cachedArrowsObj: string | undefined;

export function nativeArrowProfile(metal: ArrowMetal): ArrowProfile {
    if (!ARROW_METALS.includes(metal)) throw Error('unsupported arrow metal');
    const cached = arrowProfiles.get(metal);
    if (cached) return cached;
    const text = (cachedArrowsDbrow ??= readFileSync(join(CONTENT_DIR, 'scripts/skill_fletching/configs/arrows/arrows.dbrow'), 'utf8'));
    const body = text.split('[fletching_' + metal + '_arrow]')[1]?.split('\n[')[0];
    if (!body) throw Error('native arrow recipe absent');
    const field = (key: string) => body.match(new RegExp('^data=' + key + ',(.+)$', 'm'))?.[1]?.trim();
    const item = field('item')!;
    const [product, units] = field('product')!.split(',');
    const ids = packMap('obj');
    const obj = (cachedArrowsObj ??= readFileSync(join(CONTENT_DIR, 'scripts/skill_fletching/configs/arrows/arrows.obj'), 'utf8'))
        .split('[' + item + ']')[1]
        ?.split('\n[')[0];
    const tipName = obj?.match(/^name=(.+)$/m)?.[1]?.trim();
    const r: ArrowProfile = {
        metal,
        tip: ids.get(item)!,
        product: ids.get(product!)!,
        units: Number(units),
        level: Number(field('level')),
        rawXpPerArrow: Number(field('experience')),
        tipName: tipName!,
    };
    if (![r.tip, r.product, r.level, r.rawXpPerArrow].every(n => Number.isSafeInteger(n) && n > 0) || r.units !== 15 || !tipName) {
        throw Error('native arrow mapping invalid');
    }
    arrowProfiles.set(metal, Object.freeze(r));
    return r;
}

export interface SteelOptions {
    cap: number;
    maximum: number;
    headlessReserve: number;
    tipReserve: number;
    outputReserve: number;
    stop?: () => boolean;
    exact?: { xpRate: number; enterCleanup?: () => void };
}

export function planSteel(headless: number, tips: number, maximum = 15, headlessReserve = 200, tipReserve = 5): number {
    return Math.max(0, Math.floor(Math.min(maximum, headless - headlessReserve, tips - tipReserve) / 15) * 15);
}

export async function runSteel(s: Session, options: SteelOptions, metal: ArrowMetal = 'steel') {
    const profile = nativeArrowProfile(metal);
    if (options.exact && (!Number.isSafeInteger(options.exact.xpRate) || options.exact.xpRate < 1 || options.exact.xpRate > 1000)) {
        throw Error('invalid arrow XP rate');
    }
    const STEEL_TIP = profile.tip;
    const STEEL_ARROW = profile.product;
    const STEEL_MATERIALS = new Set([HEADLESS, STEEL_TIP, STEEL_ARROW]);
    const requiredLevel = profile.level;
    for (const [name, value] of Object.entries({ cap: options.cap, maximum: options.maximum, headlessReserve: options.headlessReserve, tipReserve: options.tipReserve, outputReserve: options.outputReserve })) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid steel ${name}`);
    }
    if (options.cap <= 0 || options.maximum <= 0 || options.maximum % 15 || options.headlessReserve < 0 || options.tipReserve < 0) {
        throw new Error('steel needs positive CAP, MAX_MAKE multiple15, nonnegative HEADLESS_RESERVE, TIP_RESERVE and OUTPUT_RESERVE');
    }
    const synced = await waitUntil(s, () => (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0 && (s.sdk.getSkill('Fletching')?.baseLevel ?? 0) > 0, { timeoutTicks: 15 });
    if (!synced) throw new Error('steel skill sync failed');
    const qualified = () => (s.sdk.getSkill('Fletching')?.level ?? 0) >= requiredLevel;
    const inv = () => s.sdk.getInventory();
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const xp = () => s.sdk.getSkillXp('Fletching') ?? 0;
    const initialXp = xp();
    const start = s.tick();
    const player = s.sdk.getState()?.player;
    let ended = false;
    let died = false;
    let hpMin = s.sdk.getSkill('Hitpoints')!.level;
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        hpMin = Math.min(hpMin, s.sdk.getSkill('Hitpoints')?.level ?? hpMin);
        if (p?.isDead || hpMin <= 0 || (p?.respawnCount ?? 0) > (player?.respawnCount ?? 0) || (player?.lifeId !== undefined && (p?.lifeId ?? player.lifeId) !== player.lifeId)) {
            died = true;
        }
    });
    const over = () => ended || died || options.stop?.() || s.tick() - start >= options.cap;
    const protectedItems = new Map<number, number>();
    for (const item of inv()) if (!STEEL_MATERIALS.has(item.id)) protectedItems.set(item.id, (protectedItems.get(item.id) ?? 0) + item.count);
    let headlessUsed = 0;
    let tipsUsed = 0;
    let made = 0;
    let banked = 0;
    let actions = 0;
    let bankTrips = 0;
    let planned = 0;
    let originalOutput: number | undefined;
    let stop = 'input-insufficient';
    let failure = '';
    let uncertain = false;
    let initialAssets: Map<number, number> | undefined;
    let bankSnapshot: { id: number; count: number }[] | undefined;
    const assets = () => {
        const rows = [...(bankSnapshot ?? []), ...inv()];
        const out = new Map<number, number>();
        for (const i of rows) out.set(i.id, (out.get(i.id) ?? 0) + i.count);
        return out;
    };
    const capture = () => {
        const observation = s.bankObservation?.();
        if (!observation) throw Error('arrow bank observation unknown');
        bankSnapshot = observation.items.map(i => ({ id: i.id, count: i.count }));
    };
    const open = async () => {
        if (!s.sdk.getState()?.bank?.isOpen) {
            const result = await s.bot.openBank();
            if (!result.success) throw new Error(`steel bank: ${result.message}`);
            bankTrips++;
            await waitTicks(s, 1);
        }
        if (!s.sdk.getState()?.bank?.isOpen) throw new Error('steel bank state not observed');
    };
    const deposit = async () => {
        for (const id of new Set(inv().filter(i => STEEL_MATERIALS.has(i.id) && i.count > 0).map(i => i.id))) {
            const item = inv().find(i => i.id === id)!;
            await depositObserved(s, item);
            if (held(id) > 0) throw new Error(`steel deposit incomplete: ${item.name}`);
        }
        await waitTicks(s, 1);
        capture();
    };
    const bankCount = (id: number) => bankSnapshot?.filter(i => i.id === id).reduce((n, i) => n + i.count, 0) ?? 0;
    try {
        await open();
        await deposit();
        originalOutput = bankCount(STEEL_ARROW);
        if (options.exact) initialAssets = assets();
        planned = qualified() ? planSteel(bankCount(HEADLESS), bankCount(STEEL_TIP), options.maximum, options.headlessReserve, options.tipReserve) : 0;
        if (!qualified()) stop = 'skill-required';
        if (planned > 0 && !over()) {
            if (28 - inv().length < 3) throw new Error('steel needs three free slots; protected kit stays held');
            for (const id of [HEADLESS, STEEL_TIP]) {
                const item = s.sdk.getState()!.bank.items.find(i => i.id === id)!;
                await s.bot.withdrawItem(item, planned, { asNote: false });
                if (held(id) !== planned) throw new Error(`no progress: steel withdrawal incomplete for ${item.name}`);
            }
            await s.bot.closeBank();
            let misses = 0;
            while (made < planned && !over()) {
                if (!qualified()) {
                    stop = 'skill-required';
                    break;
                }
                const headless = inv().find(i => i.id === HEADLESS);
                const tips = inv().find(i => i.id === STEEL_TIP);
                if (!headless || !tips || held(HEADLESS) < 15 || held(STEEL_TIP) < 15) throw new Error('steel input accounting shortfall');
                const beforePack = options.exact ? new Map(inv().map(i => [i.id, held(i.id)])) : undefined;
                const beforeOutput = held(STEEL_ARROW);
                const beforeHeadless = held(HEADLESS);
                const beforeTip = held(STEEL_TIP);
                if (s.sdk.getDialog()?.isOpen || s.sdk.getState()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                uncertain = !!options.exact;
                await s.sdk.sendUseItemOnItem(headless.slot, tips.slot);
                actions++;
                await waitUntil(s, () => held(STEEL_ARROW) > beforeOutput || over(), { timeoutTicks: 5 });
                const gained = held(STEEL_ARROW) - beforeOutput;
                const usedHeadless = beforeHeadless - held(HEADLESS);
                const usedTips = beforeTip - held(STEEL_TIP);
                headlessUsed += usedHeadless;
                tipsUsed += usedTips;
                if (gained > 0) {
                    if (gained !== 15 || usedHeadless !== gained || usedTips !== gained) throw new Error('steel input/output accounting mismatch');
                    if (beforePack) {
                        const ids = new Set([...beforePack.keys(), ...inv().map(i => i.id)]);
                        if ([...ids].some(id => held(id) - (beforePack.get(id) ?? 0) !== (id === STEEL_ARROW ? 15 : id === HEADLESS || id === STEEL_TIP ? -15 : 0))) {
                            throw Error('native arrows whole-pack effect differs');
                        }
                    }
                    if (options.exact) {
                        const raw = (made + gained) * profile.rawXpPerArrow * options.exact.xpRate;
                        const gain = xp() - initialXp;
                        if (gain < Math.floor(raw / 10) || gain > Math.ceil(raw / 10)) throw Error('native arrows exact XP differs');
                    }
                    uncertain = false;
                    made += gained;
                    misses = 0;
                } else if (usedHeadless !== 0 || usedTips !== 0) {
                    throw new Error('steel inputs debited without output');
                } else if (options.exact || ++misses >= 3) {
                    stop = 'no-progress';
                    throw new Error('no progress: steel item-on-item failed three times');
                }
            }
            stop = stop === 'skill-required' ? stop : made === options.maximum ? 'max-make' : over() ? (options.stop?.() ? 'stopped' : 'cap') : 'input-insufficient';
        }
    } catch (e) {
        failure = String(e);
    } finally {
        if (!ended && !died && !uncertain) {
            options.exact?.enterCleanup?.();
            try {
                await open();
                await deposit();
                banked = originalOutput === undefined ? 0 : Math.max(0, bankCount(STEEL_ARROW) - originalOutput);
            } catch (e) {
                failure ||= `cleanup ${String(e)}`;
            }
        }
        off();
    }
    if (initialAssets && !uncertain) {
        const finalAssets = assets();
        const ids = new Set([...initialAssets.keys(), ...finalAssets.keys()]);
        if ([...ids].some(id => (finalAssets.get(id) ?? 0) - (initialAssets!.get(id) ?? 0) !== (id === STEEL_ARROW ? made : id === HEADLESS || id === STEEL_TIP ? -made : 0))) {
            failure ||= 'native arrows whole-bank assets differ';
        }
    }
    const preserved = [...protectedItems].every(([id, count]) => held(id) >= count);
    const reserveMet = !!bankSnapshot && bankCount(HEADLESS) >= options.headlessReserve && bankCount(STEEL_TIP) >= options.tipReserve;
    const xpGain = xp() - initialXp;
    if (options.exact) {
        const raw = made * profile.rawXpPerArrow * options.exact.xpRate;
        if (xpGain < Math.floor(raw / 10) || xpGain > Math.ceil(raw / 10)) failure ||= 'native arrows exact XP differs';
    }
    if (!preserved) failure ||= 'steel protected asset shortfall';
    if (made > 0 && (!reserveMet || banked !== made || xpGain <= 0)) failure ||= 'steel final bank/reserve/XP proof failed';
    if (held(STEEL_ARROW) > 0) failure ||= 'steel output remains unbanked';
    const outputReserveMet = !!bankSnapshot && bankCount(STEEL_ARROW) >= options.outputReserve;
    const targetMet = made === options.maximum && banked === made && reserveMet && outputReserveMet;
    return {
        ok: !failure && !died && !ended && stop !== 'stopped',
        ticks: s.tick() - start,
        made,
        banked,
        planned,
        actions,
        bankTrips,
        xpGain,
        headlessUsed,
        tipsUsed,
        outputReserveMet,
        headlessBank: bankCount(HEADLESS),
        tipBank: bankCount(STEEL_TIP),
        arrowBank: bankCount(STEEL_ARROW),
        heldArrows: held(STEEL_ARROW),
        reserveMet,
        preserved,
        targetMet,
        stop,
        hpMin,
        died,
        ...(options.exact ? { uncertain } : {}),
        failure: failure || '-',
    };
}

export async function runNativeArrows(original: Session, options: SteelOptions & { xpRate?: number }, metal: ArrowMetal) {
    const profile = nativeArrowProfile(metal);
    const client = original.client as any;
    const owner = client.executeBotAction;
    const p = original.sdk.getState()?.player;
    const life = p?.lifeId;
    const respawns = p?.respawnCount ?? 0;
    const plane = p?.level;
    const hp = original.sdk.getSkill('Hitpoints')?.level ?? 0;
    const start = original.tick();
    let ended = false;
    let cleanup = false;
    void original.ended.then(() => { ended = true; });
    const gear = JSON.stringify(original.sdk.getEquipment());
    const otherXP = () => JSON.stringify(original.sdk.getState()?.skills.filter(k => k.name !== 'Fletching').map(k => [k.name, k.experience]));
    const initialXP = otherXP();
    const guard = () => {
        const now = original.sdk.getState()?.player;
        if (
            ended ||
            original.client !== client ||
            client.executeBotAction !== owner ||
            typeof owner !== 'function' ||
            !Number.isSafeInteger(life) ||
            !now ||
            now.isDead ||
            now.lifeId !== life ||
            (now.respawnCount ?? 0) !== respawns ||
            now.level !== plane ||
            hp < 1 ||
            original.sdk.getSkill('Hitpoints')?.level !== hp ||
            original.sdk.getStateAge() > 5000 ||
            JSON.stringify(original.sdk.getEquipment()) !== gear ||
            otherXP() !== initialXP ||
            (!cleanup && productionStopRequested(original.name, options.stop)) ||
            original.tick() - start >= options.cap
        ) {
            throw Error('native arrows original owner/life/HP/XP/stop/cap');
        }
    };
    guard();
    const sdk = new Proxy(original.sdk, {
        get(t, k, r) {
            const v = Reflect.get(t, k, r);
            return typeof v === 'function'
                ? function (...a: unknown[]) {
                      if (typeof k === 'string' && k.startsWith('send')) guard();
                      return v.apply(r, a);
                  }
                : v;
        },
    });
    const s = {
        ...original,
        sdk,
        bot: new BotActions(sdk),
        direct: async (a: Parameters<Session['direct']>[0]) => {
            guard();
            return original.direct(a);
        },
    } as Session;
    const result = await runSteel(
        s,
        {
            ...options,
            exact: { xpRate: options.xpRate ?? 25, enterCleanup: () => { cleanup = true; } },
            stop: () => {
                try {
                    guard();
                    return false;
                } catch {
                    return true;
                }
            },
        },
        metal,
    );
    guard();
    return { ...result, ok: result.ok && result.targetMet, metal, profile };
}

export function nativeArrowDetail(r: Awaited<ReturnType<typeof runNativeArrows>>, o: Pick<SteelOptions, 'maximum' | 'headlessReserve' | 'tipReserve'>) {
    const json = JSON.stringify(r);
    if (r.ok) return json;
    if (r.stop === 'input-insufficient' && r.made === 0 && r.actions === 0) {
        return `native arrows missing owned inputs: MAX_MAKE ${o.maximum} needs ${r.profile.tipName} above ${o.tipReserve} (bank ${r.tipBank}) and Headless arrow above ${o.headlessReserve} (bank ${r.headlessBank}); ` + json;
    }
    return `native arrows incomplete: stop=${r.stop} made=${r.made}/${o.maximum} failure=${r.failure}; ` + json;
}

export interface OakBowOptions {
    cap: number;
    maximum: number;
    logReserve: number;
    stringReserve: number;
    stop?: () => boolean;
}

const OAK_LOG = 1521;
const BOW_STRING = 1777;
const OAK_UNSTRUNG = 56;
export const OAK_BOW = 845;
const OAK_MATERIALS = new Set([OAK_LOG, BOW_STRING, OAK_UNSTRUNG, OAK_BOW]);
const OAK_NOTES = new Map([[1522, OAK_LOG], [1778, BOW_STRING]]);

export function planOakBows(logs: number, strings: number, maximum: number, logReserve: number, stringReserve: number) {
    return Math.max(0, Math.min(450, maximum, logs - logReserve, strings - stringReserve));
}

export async function runOakBows(s: Session, options: OakBowOptions) {
    for (const value of [options.cap, options.maximum, options.logReserve, options.stringReserve]) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid oak-bows limit');
    }
    if (!options.cap || options.maximum < 1 || options.maximum > 450) throw new Error('oak-bows requires MAX_MAKE1..450 and positive CAP');
    if (!await waitUntil(s, () => (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0 && (s.sdk.getSkill('Fletching')?.baseLevel ?? 0) > 0, { timeoutTicks: 15 })) {
        throw new Error('oak-bows skill sync failed');
    }
    const inv = () => s.sdk.getInventory();
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const xp = () => s.sdk.getSkillXp('Fletching') ?? 0;
    const qualified = () => (s.sdk.getSkill('Fletching')?.level ?? 0) >= 25;
    const start = s.tick();
    const initialXp = xp();
    const player = s.sdk.getState()?.player;
    let hpMin = s.sdk.getSkill('Hitpoints')!.level;
    let died = false;
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        hpMin = Math.min(hpMin, s.sdk.getSkill('Hitpoints')?.level ?? hpMin);
        if (p?.isDead || hpMin <= 0 || (p?.respawnCount ?? 0) > (player?.respawnCount ?? 0) || (player?.lifeId !== undefined && (p?.lifeId ?? player.lifeId) !== player.lifeId)) {
            died = true;
        }
    });
    const over = () => ended || died || !!options.stop?.() || s.tick() - start >= options.cap;
    let snapshot: { id: number; count: number }[] | undefined;
    const bankCount = (id: number) => snapshot?.filter(i => i.id === id).reduce((n, i) => n + i.count, 0) ?? 0;
    const capture = () => {
        const b = s.bankObservation?.();
        snapshot = b?.items.map(i => ({ id: i.id, count: i.count }));
        if (!snapshot) throw new Error('oak-bows bank unknown');
    };
    const open = async () => {
        const generation = s.bankObservation?.()?.generation ?? 0;
        if (!s.sdk.getState()?.bank?.isOpen) {
            if (!(await s.bot.openBank()).success) throw new Error('oak-bows bank open failed');
            if (!await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 10 })) {
                throw new Error('oak-bows bank data not ready');
            }
        }
        capture();
    };
    const deposit = async () => {
        for (const id of new Set(inv().filter(i => OAK_MATERIALS.has(i.id)).map(i => i.id))) {
            await s.bot.depositItem(inv().find(i => i.id === id)!, -1);
            if (!await waitUntil(s, () => held(id) === 0, { timeoutTicks: 5 })) throw new Error(`oak-bows deposit failed ${id}`);
        }
        await waitTicks(s, 1);
        capture();
    };
    const totals = () => {
        const counts = new Map<number, number>();
        for (const i of [...(snapshot ?? []), ...inv()]) counts.set(i.id, (counts.get(i.id) ?? 0) + i.count);
        return counts;
    };
    let initial: Map<number, number> | undefined;
    let shaped = 0;
    let made = 0;
    let banked = 0;
    let planned = 0;
    let actions = 0;
    let shapeXp = 0;
    let stringXp = 0;
    let logsUsed = 0;
    let stringsUsed = 0;
    let notesConverted = 0;
    let failure = '';
    let stop = 'input-insufficient';
    try {
        if (inv().some(i => /logs/i.test(i.name) && i.id !== OAK_LOG && !OAK_NOTES.has(i.id))) throw new Error('oak-bows unrelated held logs');
        await open();
        for (const [noteId, rawId] of OAK_NOTES) {
            const note = inv().find(i => i.id === noteId);
            if (!note) continue;
            const amount = held(noteId);
            const before = totals();
            const rawBank = bankCount(rawId);
            if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('oak-bows invalid note conversion amount');
            const result = await s.bot.depositItem(note, -1);
            const ready = await waitUntil(
                s,
                () => {
                    const observation = s.bankObservation?.();
                    return held(noteId) === 0 && !!observation && observation.items.filter(i => i.id === rawId).reduce((n, i) => n + i.count, 0) === rawBank + amount;
                },
                { timeoutTicks: 10 },
            );
            if (!result.success || !ready) throw new Error(`oak-bows note conversion failed ${noteId}`);
            capture();
            const after = totals();
            if (
                ![...new Set([...before.keys(), ...after.keys(), noteId, rawId])].every(
                    id => (after.get(id) ?? 0) === (before.get(id) ?? 0) + (id === rawId ? amount : id === noteId ? -amount : 0),
                )
            ) {
                throw new Error(`oak-bows note conversion conservation failed ${noteId}`);
            }
            notesConverted += amount;
        }
        initial = totals();
        await deposit();
        if (!qualified()) {
            stop = 'skill-required';
        } else {
            if (!held(KNIFE)) {
                const knife = s.sdk.getState()!.bank.items.find(i => i.id === KNIFE);
                if (!knife) throw new Error('oak-bows owned knife required');
                await s.bot.withdrawItem(knife, 1, { asNote: false });
                if (!await waitUntil(s, () => held(KNIFE) === 1, { timeoutTicks: 5 })) throw new Error('oak-bows knife withdrawal failed');
            }
            planned = planOakBows(bankCount(OAK_LOG), bankCount(BOW_STRING), options.maximum, options.logReserve, options.stringReserve);
            while (made < planned && !over() && qualified()) {
                const batch = Math.min(planned - made, Math.floor((28 - inv().length) / 2));
                if (batch < 1) throw new Error('oak-bows kit leaves no input slots');
                for (const id of [OAK_LOG, BOW_STRING]) {
                    const item = s.sdk.getState()!.bank.items.find(i => i.id === id);
                    if (!item) throw new Error('oak-bows input missing');
                    await s.bot.withdrawItem(item, batch, { asNote: false });
                    if (!await waitUntil(s, () => held(id) === batch, { timeoutTicks: 5 })) throw new Error(`oak-bows withdrawal incomplete ${id}`);
                }
                await s.bot.closeBank();
                for (let n = 0; n < batch && !over() && qualified(); n++) {
                    let misses = 0;
                    while (!over()) {
                        const before = held(OAK_UNSTRUNG);
                        const logs = held(OAK_LOG);
                        const beforeXp = xp();
                        await s.bot.fletchLogs('Long Bow');
                        actions++;
                        await waitUntil(s, () => held(OAK_UNSTRUNG) !== before || held(OAK_LOG) !== logs || over(), { timeoutTicks: 6 });
                        const gain = held(OAK_UNSTRUNG) - before;
                        const debit = logs - held(OAK_LOG);
                        if (gain || debit) {
                            logsUsed += debit;
                            shapeXp += xp() - beforeXp;
                            if (gain !== 1 || debit !== 1 || xp() <= beforeXp) throw new Error('oak-bows shaping accounting/XP mismatch');
                            shaped++;
                            break;
                        }
                        if (++misses >= 3) {
                            stop = 'no-progress';
                            throw new Error('no progress: oak-bows shaping failed three times');
                        }
                    }
                    if (over()) break;
                    misses = 0;
                    while (!over()) {
                        const bow = inv().find(i => i.id === OAK_UNSTRUNG);
                        const string = inv().find(i => i.id === BOW_STRING);
                        if (!bow || !string) throw new Error('oak-bows stringing inputs missing');
                        const before = held(OAK_BOW);
                        const beforeU = held(OAK_UNSTRUNG);
                        const strings = held(BOW_STRING);
                        const beforeXp = xp();
                        if (s.sdk.getDialog()?.isOpen || s.sdk.getState()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                        await s.sdk.sendUseItemOnItem(bow.slot, string.slot);
                        actions++;
                        await waitUntil(s, () => held(OAK_BOW) !== before || held(OAK_STRING_SAFE(BOW_STRING)) !== strings || over(), { timeoutTicks: 6 });
                        const gain = held(OAK_BOW) - before;
                        const debit = strings - held(BOW_STRING);
                        if (gain || debit || held(OAK_UNSTRUNG) !== beforeU) {
                            stringsUsed += debit;
                            stringXp += xp() - beforeXp;
                            if (gain !== 1 || debit !== 1 || beforeU - held(OAK_UNSTRUNG) !== 1 || xp() <= beforeXp) {
                                throw new Error('oak-bows stringing accounting/XP mismatch');
                            }
                            made++;
                            break;
                        }
                        if (++misses >= 3) {
                            stop = 'no-progress';
                            throw new Error('no progress: oak-bows stringing failed three times');
                        }
                    }
                }
                await open();
                await deposit();
            }
            stop = made === options.maximum ? 'max-make' : !qualified() ? 'skill-required' : over() ? (options.stop?.() ? 'stopped' : 'cap') : 'input-insufficient';
        }
    } catch (e) {
        failure = String(e);
    } finally {
        if (!ended && !died) {
            try {
                await open();
                await deposit();
            } catch (e) {
                failure ||= `cleanup ${String(e)}`;
            }
        }
        off();
    }
    const final = totals();
    banked = initial ? Math.max(0, bankCount(OAK_BOW) - (initial.get(OAK_BOW) ?? 0)) : 0;
    const changes = new Map([[OAK_LOG, -logsUsed], [BOW_STRING, -stringsUsed], [OAK_UNSTRUNG, shaped - made], [OAK_BOW, made]]);
    const preserved = !!initial && [...new Set([...initial.keys(), ...final.keys(), ...changes.keys()])].every(id => (final.get(id) ?? 0) === (initial!.get(id) ?? 0) + (changes.get(id) ?? 0));
    const reserveMet = !!snapshot && bankCount(OAK_LOG) >= options.logReserve && bankCount(BOW_STRING) >= options.stringReserve;
    if (!preserved) failure ||= 'oak-bows asset conservation failed';
    if (made && (banked !== made || !reserveMet || shapeXp <= 0 || stringXp <= 0)) failure ||= 'oak-bows final output/reserve/XP proof failed';
    const targetMet = made === options.maximum && banked === made && reserveMet && preserved && !failure;
    return {
        ok: !failure && !died && !ended && stop !== 'stopped',
        ticks: s.tick() - start,
        made,
        shaped,
        banked,
        planned,
        actions,
        xpGain: xp() - initialXp,
        shapeXp,
        stringXp,
        logsUsed,
        stringsUsed,
        notesConverted,
        logBank: bankCount(OAK_LOG),
        stringBank: bankCount(BOW_STRING),
        bowBank: bankCount(OAK_BOW),
        unstrungBank: bankCount(OAK_UNSTRUNG),
        reserveMet,
        preserved,
        targetMet,
        hpMin,
        died,
        stop,
        failure: failure || '-',
    };
}

function OAK_STRING_SAFE(id: number): number {
    return id;
}

// ---- Wood Processing Cycle & Worker (fletch-worker.ts) ----

type Run = { exit: number; output: string };

export type WoodProcessingJob = {
    tree: 'normal' | 'oak' | 'willow' | 'maple' | 'yew' | 'magic';
    product: 'shortbow' | 'longbow' | 'burn';
    string: boolean;
    finish: 'bank' | 'drop';
    maximum: number;
    minimumHP: number;
    cap: number;
    reserve: number;
};

type WoodRunner = {
    run: (script: string, env: Record<string, string>, args?: string[]) => Promise<Run>;
    stopped: () => boolean;
};

export function validateWoodProcessingJob(j: WoodProcessingJob) {
    if (
        !j ||
        !['normal', 'oak', 'willow', 'maple', 'yew', 'magic'].includes(j.tree) ||
        !['shortbow', 'longbow', 'burn'].includes(j.product) ||
        typeof j.string !== 'boolean' ||
        !['bank', 'drop'].includes(j.finish) ||
        (j.product === 'burn' && (j.string || j.finish === 'drop')) ||
        !Number.isSafeInteger(j.maximum) ||
        j.maximum < 1 ||
        j.maximum > 24 ||
        !Number.isSafeInteger(j.minimumHP) ||
        j.minimumHP < 10 ||
        j.minimumHP > 99 ||
        !Number.isSafeInteger(j.cap) ||
        j.cap < 1000 ||
        j.cap > 20000 ||
        !Number.isSafeInteger(j.reserve) ||
        j.reserve < 0
    ) {
        throw Error('invalid finite gathered wood processing');
    }
    return j;
}

export async function waitWoodChild(
    child: { pid: number; exited: Promise<number> },
    o: { stop: () => boolean; kill: (pid: number) => Promise<unknown>; timeoutMs: number },
) {
    let interrupted = false;
    let termination: Promise<unknown> | undefined;
    const cancel = () => {
        if (!termination) {
            interrupted = true;
            termination = o.kill(child.pid);
        }
    };
    const monitor = setInterval(() => {
        if (o.stop()) cancel();
    }, 50);
    const deadline = setTimeout(cancel, o.timeoutMs);
    try {
        if (o.stop()) cancel();
        const exit = await child.exited;
        await termination;
        return interrupted ? 1 : exit;
    } finally {
        clearInterval(monitor);
        clearTimeout(deadline);
        await termination;
    }
}

export async function runWoodProcessingCycle(d: WoodRunner, value: WoodProcessingJob) {
    const j = validateWoodProcessingJob(value);
    const { inventoryRecipes } = await import('./crafting-production');
    const recipes = inventoryRecipes();
    const stem = (j.tree === 'normal' ? '' : j.tree + '_') + j.product;
    const cut = j.product === 'burn' ? undefined : recipes.find(r => r.name === 'cut-bow:unstrung_' + stem);
    const strung = j.string ? recipes.find(r => r.name === 'bow-string:' + stem) : undefined;
    if ((j.product !== 'burn' && !cut) || (j.string && !strung)) throw Error('selected native bow recipe absent');
    let used = 0;
    let logsBanked = 0;
    let processed = 0;
    let stage = 'gather';
    let failure = '';
    const receipts: unknown[] = [];
    const call = async (script: string, env: Record<string, string>, args: string[] = [], reserve = 0) => {
        if (d.stopped() || j.cap - used - reserve < 100) throw Error('wood composition stopped or stage budget absent');
        const result = await d.run(script, { ...env, CAP: String(j.cap - used - reserve) }, args);
        if (result.exit !== 0 || !/^RESULT ok\b/m.test(result.output) || !/^LOGOUT logged-out\s*$/m.test(result.output)) {
            throw Error('wood child failed ' + script + ' ' + result.output.slice(-500));
        }
        return result.output;
    };
    const credit = (r: any) => {
        if (!Number.isSafeInteger(r?.ticks) || r.ticks < 0 || used + r.ticks > j.cap) throw Error('wood child tick receipt absent or exceeded');
        used += r.ticks;
        receipts.push(r);
    };
    try {
        const text = await call(
            'scripts/aio-skiller.ts',
            {
                REGION: ['normal', 'oak'].includes(j.tree) ? 'draynor' : 'seers',
                TREE: j.tree,
                ...(!['normal', 'oak'].includes(j.tree) ? { WOOD_GROVE: 'native-processing' } : {}),
                MAX_TRIPS: '1',
                BANK_AT: String(j.maximum),
                MAX_MAKE: String(j.maximum),
            },
            ['gather', 'woodcutting', 'yews'],
            600,
        );
        const line = text.split(/\r?\n/).filter(l => l.startsWith('RESULT ')).at(-1) ?? '';
        const n = Number(line.match(/\bbanked=(\d+)/)?.[1]);
        const hp = Number(line.match(/\bhpMin=(\d+)/)?.[1]);
        const ticks = Number(line.match(/\bticks=(\d+)/)?.[1]);
        if (n !== j.maximum || hp < j.minimumHP || !Number.isFinite(hp) || !line.includes('died=false')) {
            throw Error('gathered banked count/HP receipt differs');
        }
        credit({ stage: 'gather', ticks, banked: n, hpMin: hp });
        logsBanked = n;
        if (j.product === 'burn') {
            stage = 'burn';
            const out = await call(
                'scripts/aio-skiller.ts',
                { LOG: j.tree, BURN_ONLY: '1', PROGRESSIVE: '0', TARGET_LEVEL: '99', MAX_LOGS: String(j.maximum), TOOL_BUDGET: '0', CASH_RESERVE: '0' },
                ['artisan', 'firemaking', 'order'],
            );
            const r = JSON.parse(out.match(/^FIREMAKING_ORDER_RESULT (.+)$/m)?.[1] ?? 'null');
            if (!r?.ok || r.logsBurnt !== j.maximum) throw Error('gathered burn receipt incomplete');
            credit(r);
            processed = j.maximum;
        } else {
            for (const recipe of [cut!, ...(strung ? [strung] : [])]) {
                stage = recipe.name;
                const out = await call(
                    'scripts/aio-skiller.ts',
                    {
                        MAX_MAKE: String(j.maximum),
                        MAX_ATTEMPTS: String(j.maximum),
                        RAW_RESERVE: String(j.reserve),
                        INPUT_RESERVES: JSON.stringify(recipe === strung ? { [cut!.product]: 0 } : {}),
                        MEMBERS: '1',
                    },
                    ['artisan', 'crafting', 'inventory', recipe.name],
                    j.finish === 'drop' ? 120 : 0,
                );
                const r = JSON.parse(out.match(/^MICROBOT_PRODUCTION (.+)$/m)?.[1] ?? 'null');
                if (!r?.ok || r.recipe !== recipe.name || r.attempts !== j.maximum || r.made !== j.maximum || r.banked !== j.maximum || r.losses !== 0) {
                    throw Error('gathered bow exact production receipt incomplete');
                }
                credit(r);
            }
            processed = j.maximum;
            if (j.finish === 'drop') {
                stage = 'drop';
                const id = (strung ?? cut)!.product;
                const out = await call('scripts/aio-skiller.ts', {}, ['artisan', 'fletching', 'worker', '--drop-product', String(id), String(j.maximum)]);
                const r = JSON.parse(out.match(/^WOOD_PRODUCT_DROP (.+)$/m)?.[1] ?? 'null');
                if (!r?.ok || !r.preserved || r.id !== id || r.dropped !== j.maximum) throw Error('declared produced bow drop unconfirmed');
                credit(r);
            }
        }
    } catch (e) {
        failure = String(e);
    }
    return {
        ok: !failure && !d.stopped(),
        stage,
        logsBanked,
        processed,
        finish: j.finish,
        ticks: used,
        receipts,
        failure,
        scope: 'finite existing gather route followed by native bow/string/bank-or-drop or owned-line burn; no campfire or automatic tree-route discovery',
    };
}

export async function runWoodProductDrop(original: Session, id: number, amount: number, cap: number, stop: () => boolean = () => false) {
    if (![id, amount, cap].every(Number.isSafeInteger) || id < 0 || amount < 1 || amount > 24 || cap < 40 || cap > 20000) {
        throw Error('invalid finite produced-item drop');
    }
    const client = original.client as any;
    const executor = client.executeBotAction;
    const first = original.sdk.getState()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const hp = original.sdk.getSkill('Hitpoints')?.level;
    const plane = first?.level;
    const started = original.tick();
    let ended = false;
    let lost = false;
    void original.ended.then(() => { ended = true; });
    const view = () => original.sdk.getState();
    const pack = () => original.sdk.getInventory();
    const count = () => pack().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const gear0 = JSON.stringify(original.sdk.getEquipment());
    const xp0 = JSON.stringify(view()?.skills.map(k => [k.name, k.experience]));
    const guard = () => {
        const p = view()?.player;
        if (original.client !== client || client.executeBotAction !== executor) lost = true;
        if (
            lost ||
            typeof executor !== 'function' ||
            ended ||
            !first ||
            !p ||
            !Number.isSafeInteger(life) ||
            p.lifeId !== life ||
            (p.respawnCount ?? 0) !== respawns ||
            p.isDead ||
            p.level !== plane ||
            !Number.isFinite(hp) ||
            !(hp! > 0) ||
            original.sdk.getSkill('Hitpoints')?.level !== hp ||
            original.sdk.getStateAge() > 5000 ||
            original.tick() - started >= cap ||
            productionStopRequested(original.name, stop) ||
            JSON.stringify(original.sdk.getEquipment()) !== gear0 ||
            JSON.stringify(view()?.skills.map(k => [k.name, k.experience])) !== xp0
        ) {
            throw Error('produced-drop original life/owner/HP/XP/stop/cap changed');
        }
    };
    const sdk = new Proxy(original.sdk, {
        get(t, k, r) {
            const v = Reflect.get(t, k, r);
            return typeof v === 'function'
                ? function (...a: unknown[]) {
                      if (typeof k === 'string' && k.startsWith('send')) guard();
                      return v.apply(r, a);
                  }
                : v;
        },
    });
    const s = { ...original, sdk, bot: new BotActions(sdk) } as Session;
    const totals = (rows: readonly { id: number; count: number }[]) => {
        const out: Record<number, number> = {};
        for (const i of rows) out[i.id] = (out[i.id] ?? 0) + i.count;
        return out;
    };
    const effect = (a: Record<number, number>, b: Record<number, number>, n: number) =>
        [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => (b[+k] ?? 0) - (a[+k] ?? 0) === (+k === id ? -n : 0));
    const open = async () => {
        guard();
        const generation = s.bankObservation?.()?.generation ?? -1;
        await s.sdk.sendCloseModal();
        if (
            !await waitUntil(
                s,
                () => {
                    guard();
                    return !view()?.bank.isOpen && !view()?.interface.isOpen && !view()?.dialog.isOpen;
                },
                { timeoutTicks: 8 },
            )
        ) {
            throw Error('produced-drop modal closure unconfirmed');
        }
        await s.bot.openBank();
        if (
            !await waitUntil(
                s,
                () => {
                    guard();
                    return !!view()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation;
                },
                { timeoutTicks: 12 },
            )
        ) {
            throw Error('produced-drop fresh bank absent');
        }
    };
    const assets = () => {
        const b = s.bankObservation?.();
        if (!view()?.bank.isOpen || !b) throw Error('produced-drop bank unknown');
        return totals([...pack(), ...original.sdk.getEquipment(), ...b.items]);
    };
    let dropped = 0;
    let uncertain = false;
    let failure = '';
    let preserved = false;
    try {
        guard();
        if (count() !== 0) throw Error('produced-drop requires target absent from starting pack');
        const native = client.objType?.(id);
        if (!native || native.certtemplate !== -1 || native.stackable !== false) throw Error('produced-drop native unnoted bow identity absent');
        await open();
        const before = assets();
        const row = view()!.bank.items.find(i => i.id === id);
        if (!row || row.count < amount || 28 - pack().length < amount) throw Error('produced-drop owned bank stock/space absent');
        const held = totals(pack());
        const stored = row.count;
        const g = s.bankObservation!()!.generation;
        uncertain = true;
        await s.bot.withdrawItem(row, amount, { asNote: false });
        if (
            !await waitUntil(
                s,
                () => {
                    guard();
                    return (
                        count() === amount &&
                        (s.bankObservation?.()?.generation ?? -1) > g &&
                        (s.bankObservation?.()?.items.find(i => i.id === id)?.count ?? 0) === stored - amount
                    );
                },
                { timeoutTicks: 10 },
            )
        ) {
            throw Error('produced-drop withdrawal unknown');
        }
        if (!effect(held, totals(pack()), -amount) || !effect(before, assets(), 0)) throw Error('produced-drop withdrawal changed other assets');
        uncertain = false;
        await s.bot.closeBank();
        if (
            !await waitUntil(
                s,
                () => {
                    guard();
                    return !view()?.bank.isOpen && !view()?.interface.isOpen && !view()?.dialog.isOpen;
                },
                { timeoutTicks: 8 },
            )
        ) {
            throw Error('produced-drop inventory not ready');
        }
        for (let n = 0; n < amount; n++) {
            guard();
            const item = pack().find(i => i.id === id);
            const custom = item?.optionsWithIndex?.filter(o => o.opIndex === 5) ?? [];
            if (!item || item.count !== 1 || custom.length > 1 || custom.some(o => !/^drop$/i.test(o.text))) {
                throw Error('produced-drop exact native slot absent');
            }
            const prior = totals(pack());
            uncertain = true;
            try {
                await s.sdk.sendDropItem(item.slot);
            } catch {}
            if (
                !await waitUntil(
                    s,
                    () => {
                        guard();
                        return effect(prior, totals(pack()), 1);
                    },
                    { timeoutTicks: 8 },
                )
            ) {
                throw Error('produced-drop exact effect unknown; no retry');
            }
            uncertain = false;
            dropped++;
        }
        await open();
        preserved = effect(before, assets(), amount);
        if (!preserved) throw Error('produced-drop final whole-assets differ');
        await s.bot.closeBank();
        guard();
    } catch (e) {
        failure = String(e);
    }
    return { ok: !failure && !uncertain && preserved && dropped === amount, id, dropped, uncertain, preserved, ticks: original.tick() - started, failure };
}

export async function runFletchingCycle(d: { run: (script: string, env: Record<string, string>, args?: readonly string[]) => Promise<Run>; stopped: () => boolean; minimumHP: number }) {
    const failure = (stage: string, detail: string) => ({
        ok: false,
        stage: /^RESULT fail (?:session ended:|login(?::| ))/.test(detail) ? 'disconnected' : stage,
        logsBanked: 0,
        shaftsBanked: 0,
        detail,
    });
    if (!Number.isSafeInteger(d.minimumHP) || d.minimumHP < 10) return failure('prerequisite', 'known HP maximum required');
    if (d.stopped()) return failure('stopped', 'stop file');
    const last = (r: Run) => r.output.split(/\r?\n/).filter(l => l.startsWith('RESULT ')).pop() ?? 'no RESULT';
    const collect = await d.run('scripts/aio-skiller.ts', { REGION: 'draynor', TREE: 'normal', MAX_TRIPS: '1', BANK_AT: '25', CAP: '1800', MAX_MAKE: '25' }, ['gather', 'woodcutting', 'yews']);
    const summary = last(collect);
    const banked = Number(summary.match(/\bbanked=(\d+)/)?.[1]);
    const hp = Number(summary.match(/\bhpMin=(\d+)/)?.[1]);
    if (collect.exit !== 0 || !/^RESULT ok\b/.test(summary) || !summary.includes('died=false') || banked !== 25 || !(hp >= d.minimumHP)) {
        return failure('gather', summary);
    }
    if (d.stopped()) return { ...failure('stopped', 'stop file'), logsBanked: 25 };
    const craft = await d.run('scripts/aio-skiller.ts', { MODE: 'shafts', MAX_MAKE: '25', LOG_RESERVE: '0', BANK_KNIFE: '1', CAP: '600' }, ['artisan', 'fletching', 'arrows']);
    let report: any;
    try {
        report = JSON.parse(craft.output.match(/^SHAFT_BANK (.+)$/m)?.[1] ?? 'null');
    } catch {}
    if (
        craft.exit !== 0 ||
        !/^RESULT ok\b/.test(last(craft)) ||
        report?.ok !== true ||
        report.logsUsed !== 25 ||
        report.made !== 375 ||
        report.banked !== 375 ||
        report.preserved !== true ||
        report.died !== false ||
        report.damaged !== false ||
        report.targetMet !== true ||
        report.knifeStored !== true ||
        !(report.hpMin >= d.minimumHP)
    ) {
        return { ...failure('shafts', last(craft)), logsBanked: 25 };
    }
    return { ok: true, stage: 'done', logsBanked: 25, shaftsBanked: 375, detail: 'died=false' };
}

// ---- Legacy Fletch Loop + CLI Runners ----

async function runLegacyFletchArrowsOrBows(
    s: Session,
    botName: string,
    mode: string,
    tipType: string,
    cap: number,
) {
    try {
        const inv = () => s.sdk.getInventory();
        const t0 = s.tick();
        const used = () => s.tick() - t0;
        const over = () => used() >= cap;

        let fletched = 0;
        let bankTrips = 0;

        const findItem = (re: RegExp) => inv().find(i => re.test(i.name));
        const countRe = (re: RegExp) => countItems(s, re);
        const BOWS = longbowIds();
        const findId = (ids: readonly number[]) => inv().find(i => ids.includes(i.id));
        const countIds = (ids: readonly number[]) => inv().filter(i => ids.includes(i.id)).reduce((n, i) => n + i.count, 0);

        const bank = async () => {
            const b = await s.bot.openBank();
            if (!b.success) {
                await waitTicks(s, 2);
                return;
            }
            if (mode === 'arrows') {
                await s.bot.depositItem(/arrow$/i, -1);
                await waitTicks(s, 1);
                const tipRe = new RegExp(`${tipType} arrowtip`, 'i');
                await s.bot.withdrawItem(/headless arrow/i, 1000);
                await s.bot.withdrawItem(tipRe, 1000);
            } else if (mode === 'bows') {
                for (const item of inv().filter(i => BOWS.strung.includes(i.id))) await s.bot.depositItem(item, -1);
                await waitTicks(s, 1);
                for (const wanted of [[BOWS.string], BOWS.unstrung]) {
                    const item = s.sdk.getState()!.bank.items.find(i => wanted.includes(i.id));
                    if (item) await s.bot.withdrawItem(item, 14);
                }
            }
            bankTrips++;
            await s.bot.closeInterface();
            await waitTicks(s, 1);
        };

        // A bank visit that leaves the pack without both inputs ends the run at once: waiting cannot refill the bank,
        // and the session stall cutoff would otherwise spend its whole window on repeated bank visits.
        let exhausted = '';
        console.log(`START fletch assembler ${botName} mode=${mode} tip=${tipType}`);
        while (!over()) {
            if (mode === 'arrows') {
                const headless = findItem(/headless arrow/i);
                const tips = findItem(new RegExp(`${tipType} arrowtip`, 'i'));
                if (!headless || !tips) {
                    await bank();
                    if (!findItem(/headless arrow/i) || !findItem(new RegExp(`${tipType} arrowtip`, 'i'))) {
                        exhausted = `bank holds no headless arrows or ${tipType} arrowtips`;
                        break;
                    }
                }
                const finishedRe = new RegExp(`^${tipType} arrow$`, 'i');
                const h = findItem(/headless arrow/i)!;
                const t = findItem(new RegExp(`${tipType} arrowtip`, 'i'))!;
                const before = countRe(finishedRe);
                await s.sdk.sendUseItemOnItem(h.slot, t.slot);
                await waitTicks(s, 2);
                const gained = countRe(finishedRe) - before;
                if (gained > 0) fletched += gained;
            } else if (mode === 'bows') {
                const strings = findId([BOWS.string]);
                const unstrung = findId(BOWS.unstrung);
                if (!strings || !unstrung) {
                    await bank();
                    if (!findId([BOWS.string]) || !findId(BOWS.unstrung)) {
                        exhausted = 'bank holds no bow strings or unstrung bows';
                        break;
                    }
                }
                const st = findId([BOWS.string])!;
                const un = findId(BOWS.unstrung)!;
                const before = countIds(BOWS.strung);
                await s.sdk.sendUseItemOnItem(st.slot, un.slot);
                await waitTicks(s, 2);
                const gained = countIds(BOWS.strung) - before;
                if (gained > 0) fletched += gained;
            }
        }
        const perK = ((fletched * 1000) / Math.max(1, used())).toFixed(2);
        const detail = `ticks=${used()} fletched=${fletched} mode=${mode} bankTrips=${bankTrips} fletchPer1kTicks=${perK}${exhausted ? ` stop=input-exhausted` : ''}`;
        await finish([s], fletched > 0, fletched > 0 || !exhausted ? detail : `no progress: ${exhausted}; ${detail}`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

export async function runFletchArrowsCli(
    botName: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
) {
    const CAP = Number(restArgs[0] ?? env.CAP ?? 15000);
    const MODE = (restArgs[1] ?? env.MODE ?? 'arrows').toLowerCase();
    const TIP_TYPE = (restArgs[2] ?? env.TIP_TYPE ?? 'rune').toLowerCase();
    if (!botName) {
        throw Error('Usage: bun scripts/aio-skiller.ts <botName> artisan fletching arrows [CAP] [MODE] [TIP_TYPE]');
    }
    if (MODE === 'native-arrows') nativeArrowProfile(TIP_TYPE as ArrowMetal);
    let stopped = false;
    const stopOpt = ['native-arrows', 'headless', 'iron', 'steel', 'oak-bows', 'shafts'].includes(MODE)
        ? { onStop: async () => { stopped = true; } }
        : {};
    const s = await openBot(botName, stopOpt).catch(e => finish([], false, `login: ${String(e)}`));
    if (MODE === 'native-arrows') {
        try {
            const o = {
                cap: CAP,
                maximum: Number(env.MAX_MAKE ?? 30),
                headlessReserve: Number(env.HEADLESS_RESERVE ?? 200),
                tipReserve: Number(env.TIP_RESERVE ?? 5),
                outputReserve: Number(env.OUTPUT_RESERVE ?? 0),
                xpRate: Number(env.FLETCHING_XP_RATE ?? 25),
                stop: () => stopped,
            };
            const r = await runNativeArrows(s, o, TIP_TYPE as ArrowMetal);
            console.log('NATIVE_ARROW_BANK ' + JSON.stringify(r));
            await finish([s], r.ok, nativeArrowDetail(r, o));
        } catch (e) {
            await finish([s], false, String(e));
        }
        return;
    }
    if (MODE === 'shafts') {
        try {
            const r = await runShafts(s, {
                cap: CAP,
                maximum: Number(env.MAX_MAKE ?? 25),
                reserve: Number(env.LOG_RESERVE ?? 0),
                bankKnife: env.BANK_KNIFE === '1',
                stop: () => stopped,
            });
            console.log('SHAFT_BANK ' + JSON.stringify(r));
            await finish([s], r.ok, `${r.ok || r.stop === 'stopped' ? '' : 'no fletching progress: '}mode=shafts ${Object.entries(r).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        } catch (e) {
            await finish([s], false, `no fletching progress: ${String(e)}`);
        }
        return;
    }
    if (MODE === 'oak-bows') {
        try {
            const r = await runOakBows(s, {
                cap: CAP,
                maximum: Number(env.MAX_MAKE ?? 25),
                logReserve: Number(env.LOG_RESERVE ?? 0),
                stringReserve: Number(env.STRING_RESERVE ?? 0),
                stop: () => stopped,
            });
            console.log(`OAK_BOW_BANK ${JSON.stringify(r)}`);
            await finish([s], r.ok, `mode=oak-bows ${Object.entries(r).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        } catch (e) {
            await finish([s], false, String(e));
        }
        return;
    }
    if (MODE === 'iron') {
        try {
            const r = await runSteel(
                s,
                {
                    cap: CAP,
                    maximum: Number(env.MAX_MAKE ?? 90),
                    headlessReserve: Number(env.HEADLESS_RESERVE ?? 200),
                    tipReserve: Number(env.TIP_RESERVE ?? 0),
                    outputReserve: Number(env.OUTPUT_RESERVE ?? 0),
                    stop: () => stopped,
                },
                'iron',
            );
            console.log('IRON_BANK ' + JSON.stringify(r));
            const accepted = r.ok && r.targetMet;
            await finish([s], accepted, (accepted ? '' : 'arrow prerequisite: exact order incomplete; ') + 'mode=iron ' + Object.entries(r).map(([k, v]) => k + '=' + v).join(' '));
        } catch (e) {
            await finish([s], false, 'arrow prerequisite: ' + String(e));
        }
        return;
    }
    if (MODE === 'steel') {
        try {
            const r = await runSteel(s, {
                cap: CAP,
                maximum: Number(env.MAX_MAKE ?? 15),
                headlessReserve: Number(env.HEADLESS_RESERVE ?? 200),
                tipReserve: Number(env.TIP_RESERVE ?? 5),
                outputReserve: Number(env.OUTPUT_RESERVE ?? 0),
                stop: () => stopped,
            });
            console.log(`STEEL_BANK ${JSON.stringify(r)}`);
            await finish([s], r.ok, `mode=steel ${Object.entries(r).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        } catch (e) {
            await finish([s], false, String(e));
        }
        return;
    }
    if (MODE === 'headless') {
        try {
            const p = s.sdk.getState()?.player;
            if (!p) throw new Error('headless: no player state');
            const bank = nearestBankStand(p);
            if (bank && cheb(bank, p) > 2) {
                if (cheb(bank, p) > BANK_WALK_LIMIT) throw new Error(`headless: nearest bank ${bank.x},${bank.z} is ${cheb(bank, p)} tiles away`);
                const walked = await walkPath(await sessionWalker(s), [{ ...bank, tol: 1 }], { maxTicks: 400, stop: () => stopped });
                if (!walked.ok) throw new Error(`headless: walk to the bank at ${bank.x},${bank.z} failed: ${walked.detail ?? ''}`);
            }
            if (env.BANK_PACK === '1') {
                if (!(await s.bot.openBank()).success) throw new Error('headless BANK_PACK: bank did not open');
                await waitTicks(s, 1);
                await depositPack(s);
                await s.bot.closeBank();
            }
            const r = await runHeadless(s, {
                cap: CAP,
                maximum: Number(env.MAX_MAKE ?? 390),
                shaftReserve: Number(env.SHAFT_RESERVE ?? 200),
                featherReserve: Number(env.FEATHER_RESERVE ?? 100),
                stop: () => stopped,
            });
            console.log(`HEADLESS_BANK ${JSON.stringify(r)}`);
            await finish([s], r.ok, `mode=headless ${Object.entries(r).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        } catch (e) {
            await finish([s], false, String(e));
        }
        return;
    }
    await runLegacyFletchArrowsOrBows(s, botName, MODE, TIP_TYPE, CAP);
}

export async function runFletchWorkerCli(
    actor: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
) {
    if (!/^[A-Za-z0-9_ -]{1,12}$/.test(actor ?? '')) throw Error('invalid fletching account');
    const root = REPO_ROOT;
    const stopped = () => existsSync(join(root, `.practice/stop-${actor}`));
    const flag = restArgs[0];
    if (flag === '--wood-job' || flag === '--drop-product') {
        let signalled = false;
        process.once('SIGINT', () => { signalled = true; });
        process.once('SIGTERM', () => { signalled = true; });
        const stop = () => productionStopRequested(actor, () => signalled);
        try {
            if (flag === '--drop-product') {
                const id = Number(restArgs[1]);
                const amount = Number(restArgs[2]);
                const cap = Number(env.CAP ?? 200);
                const { inventoryRecipes } = await import('./crafting-production');
                if (!inventoryRecipes().some(r => (r.name.startsWith('cut-bow:') || r.name.startsWith('bow-string:')) && r.product === id)) {
                    throw Error('drop must name a canonical native bow product');
                }
                const s = await openBot(actor, { onStop: async () => { signalled = true; } });
                try {
                    const r = await runWoodProductDrop(s, id, amount, cap, stop);
                    console.log('WOOD_PRODUCT_DROP ' + JSON.stringify(r));
                    if (!await settle([s], r.ok, JSON.stringify(r))) process.exitCode = 1;
                } catch (e) {
                    await settle([s], false, String(e));
                    process.exitCode = 1;
                }
            } else {
                const job = validateWoodProcessingJob(JSON.parse(readFileSync(resolve(restArgs[1] ?? ''), 'utf8')));
                const r = await runWoodProcessingCycle(
                    {
                        stopped: stop,
                        run: async (script, childEnv, args = []) => {
                            if (stop()) return { exit: 1, output: 'RESULT fail stop file' };
                            const child = Bun.spawn(['bun', script, actor, ...args], {
                                cwd: root,
                                env: { ...env, ...childEnv },
                                stdout: 'pipe',
                                stderr: 'pipe',
                                windowsHide: true,
                            });
                            let output = '';
                            const completion = waitWoodChild(child, { stop, kill: killTree, timeoutMs: Math.min(1500000, Number(childEnv.CAP) * 650 + 90000) });
                            const pump = async (stream: ReadableStream<Uint8Array>, error = false) => {
                                for await (const b of stream) {
                                    const text = new TextDecoder().decode(b);
                                    if (!error) output += text;
                                    (error ? process.stderr : process.stdout).write(text);
                                }
                            };
                            const [exit] = await Promise.all([completion, pump(child.stdout), pump(child.stderr, true)]);
                            return { exit, output };
                        },
                    },
                    job,
                );
                console.log('WOOD_PROCESSING ' + JSON.stringify(r));
                console.log('RESULT ' + (r.ok ? 'ok' : 'fail') + ' ' + JSON.stringify(r));
                process.exitCode = r.ok ? 0 : 1;
            }
        } catch (e) {
            console.log('RESULT fail gathered wood ' + String(e));
            process.exitCode = 1;
        }
        return;
    }
    try {
        const statusPath = statusReadDirs(root).map(dir => join(dir, `${actor}.json`)).find(p => existsSync(p))
            ?? join(root, `.practice/status/${actor}.json`);
        const status = JSON.parse(readFileSync(statusPath, 'utf8'));
        const result = await runFletchingCycle({
            minimumHP: status.hp?.max,
            stopped,
            run: async (script, childEnv, args = []) => {
                const p = Bun.spawn(['bun', script, actor, ...args], {
                    cwd: root,
                    env: { ...env, ...childEnv },
                    stdout: 'pipe',
                    stderr: 'pipe',
                    windowsHide: true,
                });
                let output = '';
                let timedOut = false;
                const timer = setTimeout(() => {
                    timedOut = true;
                    p.kill();
                }, script.includes('gather') || args.includes('gather') ? 800000 : 280000);
                const pump = async (stream: ReadableStream<Uint8Array>, error = false) => {
                    for await (const b of stream) {
                        const text = new TextDecoder().decode(b);
                        if (!error) output += text;
                        (error ? process.stderr : process.stdout).write(text);
                    }
                };
                await Promise.all([pump(p.stdout), pump(p.stderr, true)]);
                const exit = await p.exited;
                clearTimeout(timer);
                return { exit: timedOut ? 1 : exit, output: output + (timedOut ? '\nRESULT fail no fletching progress: child deadline' : '') };
            },
        });
        console.log(`RESULT ${result.ok ? 'ok' : result.stage === 'stopped' ? 'fail stop file' : result.stage === 'disconnected' ? 'fail session ended:' : 'fail no fletching progress:'} cycle ${JSON.stringify(result)}`);
        process.exitCode = result.ok ? 0 : 1;
    } catch (e) {
        console.log('RESULT fail no fletching progress: cycle ' + String(e));
        process.exitCode = 1;
    }
}

export async function runFletchingCli(
    method: string,
    botName: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
) {
    if (method === 'worker') return runFletchWorkerCli(botName, restArgs, env);
    if (method === 'shafts') return runFletchArrowsCli(botName, [restArgs[0] ?? env.CAP ?? '15000', 'shafts', ...restArgs.slice(1)], env);
    return runFletchArrowsCli(botName, restArgs, env);
}
