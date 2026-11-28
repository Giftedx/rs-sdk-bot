// Unified crafting worker combining bowstrings, jewellery, jewellery-trip, legacy-jewelry, glass, and production.
// spins flax into bow strings | TIER: sapphire | emerald | ruby | diamond | dragonstone
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountOf, countItems, finish, getWorld, logoutSession, openBot, settle } from '../../../core/src/bot';
import { disembark, sail } from '../../../core/src/boat';
import { bankCargo } from '../../../core/src/cargo';
import { depositObserved } from '../../../core/src/deposit';
import { gatherItems } from '../../../core/src/gather';
import { componentId } from '../../../core/src/logout';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import { abortable, executionContext } from '../../../../vendor/rs-sdk/sdk/execution-context';
import type { BotWorldState } from '../../../../vendor/rs-sdk/sdk/types';
import { CONTENT_DIR, packMap } from './catalog';
import { itemMagicRecipe, jewelleryRecipes, type JewelleryRecipe } from './recipes';
import { runItemMagicBanked } from './magic';
import { cookingRecipes, runCookingBatch } from './cooking';
import {
    inventoryRecipes,
    productionEffect,
    runBlackDhideSetsCli,
    runInventoryBank,
    runProductionCli,
    runProgressiveProductionCli,
    runSoftenClayCli,
    runTanningCli,
    type InventoryRecipe,
    type ProductionSnapshot,
    type Tile,
} from './crafting-production';
import { actionSessionOwner, finishActionSession, productionStopRequested, watchProductionLife } from './runtime';
import type { ArtisanExternalDeps, Session } from './types';

export * from './crafting-production';

let defaultBankJobRunner: ((s: Session, j: any, stop?: () => boolean) => Promise<any>) | undefined;
export function registerDefaultJewelleryBankJobRunner(fn: (s: Session, j: any, stop?: () => boolean) => Promise<any>) {
    defaultBankJobRunner = fn;
}

// ---- Spin Bowstrings (spin-bowstrings.ts) ----

const SEERS_BANK = { x: 2727, z: 3492, level: 0 };
const WHEEL_HOUSE = { x: 2715, z: 3471, level: 0 };

export function spinLimits(maximum: number, reserve: number, cap: number, trips: number) {
    if (![maximum, reserve, cap, trips].every(Number.isSafeInteger) || maximum < 1 || reserve < 0 || cap < 1 || trips < 1) {
        throw Error('invalid finite spinning limits');
    }
    return { maximum, reserve, cap, trips };
}

export function spinAssets(items: readonly { id: number; count: number }[]) {
    const result: Record<number, number> = {};
    for (const row of items) {
        const id = row.id === 1780 ? 1779 : row.id === 1778 ? 1777 : row.id;
        result[id] = (result[id] ?? 0) + row.count;
    }
    return result;
}

export function spinConversion(before: { items: Record<number, number>; xp: number }, after: { items: Record<number, number>; xp: number }, remaining: number) {
    const made = (before.items[1779] ?? 0) - (after.items[1779] ?? 0);
    const valid =
        Number.isSafeInteger(made) &&
        made >= 0 &&
        made <= remaining &&
        [before.xp, after.xp].every(Number.isFinite) &&
        (made ? after.xp > before.xp : after.xp === before.xp) &&
        [...new Set([...Object.keys(before.items), ...Object.keys(after.items)])].every(k => {
            const id = +k;
            return (after.items[id] ?? 0) === (before.items[id] ?? 0) + (id === 1779 ? -made : id === 1777 ? made : 0);
        });
    if (!valid) throw Error('spinning conversion asset/XP mismatch');
    return made;
}

export function spinOwnedSession(
    raw: Session,
    requested: () => boolean = () => false,
    cleanupWithinDeadline: () => boolean = () => true,
    stopFile?: string,
) {
    const sdk = raw.sdk;
    const client = raw.client as { selfSlot?: number; executeBotAction?: unknown };
    const direct = raw.direct;
    const close = raw.close;
    const ended = raw.ended;
    const name = raw.name;
    const config = sdk.config;
    const endpoint = JSON.stringify([config?.host, config?.port, config?.gatewayUrl]);
    const slot = client?.selfSlot;
    const p = sdk.getState()?.player;
    const life = p?.lifeId;
    const respawns = p?.respawnCount ?? 0;
    const hp = sdk.getSkill('Hitpoints')?.level ?? 0;
    let lost = false;
    let cleaning = false;
    let endedNow = false;
    let loggedOut = false;
    let executor = client?.executeBotAction;
    void ended.then(e => {
        endedNow = true;
        loggedOut = e.reason === 'logged-out';
    });
    const owns = () => {
        const player = sdk.getState()?.player;
        if (
            raw.sdk !== sdk ||
            raw.client !== client ||
            (!cleaning && raw.direct !== direct) ||
            raw.close !== close ||
            raw.ended !== ended ||
            raw.name !== name ||
            sdk.config !== config ||
            JSON.stringify([config?.host, config?.port, config?.gatewayUrl]) !== endpoint ||
            client?.selfSlot !== slot ||
            client?.executeBotAction !== executor ||
            ((!loggedOut || player != null) && (player?.lifeId !== life || (player?.respawnCount ?? 0) !== respawns))
        ) {
            lost = true;
        }
        return !lost && typeof executor === 'function' && Number.isSafeInteger(slot) && Number.isSafeInteger(life);
    };
    const stopped = () =>
        !owns() ||
        endedNow ||
        productionStopRequested(name, requested, undefined, stopFile ?? process.env.STOP_FILE ?? '.practice/stop-spin-bowstrings') ||
        !sdk.getState()?.player ||
        sdk.getState()?.player?.isDead ||
        hp < 1 ||
        (sdk.getSkill('Hitpoints')?.level ?? 0) < hp ||
        !Number.isFinite(sdk.getStateAge()) ||
        sdk.getStateAge() < 0 ||
        sdk.getStateAge() > 5000;
    const cleanupUnsafe = () =>
        endedNow ||
        !cleanupWithinDeadline() ||
        !sdk.getState()?.player ||
        !!sdk.getState()?.player?.isDead ||
        (sdk.getSkill('Hitpoints')?.level ?? 0) < 7 ||
        !Number.isFinite(sdk.getStateAge()) ||
        sdk.getStateAge() < 0 ||
        sdk.getStateAge() > 5000;
    const guard = () => {
        if (!owns() || !cleanupWithinDeadline() || (cleaning ? cleanupUnsafe() : stopped())) {
            throw Error('spinning original session input unavailable');
        }
    };
    const guarded = new Proxy(sdk, {
        get(t, k, r) {
            const value = Reflect.get(t, k, r);
            return typeof value === 'function'
                ? function (...args: unknown[]) {
                      if (String(k).startsWith('send')) guard();
                      return value.apply(r, args);
                  }
                : value;
        },
    });
    const session = Object.create(raw) as Session;
    Object.defineProperties(session, {
        sdk: { value: guarded },
        bot: { value: new BotActions(guarded) },
        direct: {
            value: (a: Parameters<Session['direct']>[0]) => {
                guard();
                return direct.call(raw, a);
            },
        },
        close: {
            value: () => {
                if (!owns()) throw Error('spinning original close unavailable');
                return close.call(raw);
            },
        },
    });
    return {
        session,
        owns,
        stopped,
        cleanup: () => {
            cleaning = true;
        },
        settled: () => {
            if (cleaning) executor = client?.executeBotAction;
        },
    };
}

export function spinInputFailure(made: number, maximum: number, rawBank: number, reserve: number): string {
    return made < maximum && rawBank <= reserve ? 'no spinning progress: bank flax at reserve' : '';
}

export async function runSpinBowstrings(
    botName: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
    io: {
        open?: typeof openBot;
        ready?: (s: Session) => Promise<boolean>;
        finalize?: Parameters<typeof finishActionSession>[3];
        session?: Session;
        stop?: () => boolean;
    } = {},
): Promise<{ ok: boolean; made: number; spunTotal: number; ticks: number; summary: string; failure?: string }> {
    const MAX_MAKE = Number(env.MAX_MAKE ?? 56);
    const RAW_RESERVE = Number(env.RAW_RESERVE ?? 50);
    const CAP = Number(restArgs[0] ?? env.CAP ?? 15000);
    const MAX_TRIPS = Number(env.MAX_TRIPS ?? MAX_MAKE + 2);
    spinLimits(MAX_MAKE, RAW_RESERVE, CAP, MAX_TRIPS);
    const externalSession = io.session;
    let requested = false;
    const stopRequested = () => requested || !!io.stop?.();
    const raw = externalSession
        ?? (await (io.open ?? openBot)(botName, { onStop: async () => { requested = true; } }).catch(e => finish([], false, `login: ${String(e)}`)));
    const entryTick = raw.tick();
    const owner = externalSession ? undefined : actionSessionOwner(raw, stopRequested);
    const owned = spinOwnedSession(raw, stopRequested, () => raw.tick() - entryTick < CAP, env.STOP_FILE);
    let unwatch: (() => void) | undefined;
    let recovery: (() => Promise<void>) | undefined;
    let cleaning = false;
    const complete = async (ok: boolean, detail: string) => {
        if (externalSession || !owner) return;
        if (!owned.owns()) {
            console.log('RESULT fail spinning original session replaced; cleanup refused');
            process.exitCode = 1;
            return;
        }
        owned.cleanup();
        await finishActionSession(owner, ok, detail, io.finalize ?? finish, async () => {
            owned.settled();
            if (!owned.owns()) throw Error('spinning cleanup owner unavailable');
            const result = await logoutSession(owner.cleanup);
            if (!owned.owns()) throw Error('spinning cleanup owner changed');
            return result;
        });
    };
    try {
        if (!await (io.ready ? io.ready(raw) : waitUntil(owned.session, st => ((st?.inGame ?? false) && !!st?.player) || !owned.owns(), { timeoutTicks: 10 })) || !owned.owns()) {
            throw Error('spinning initial state unavailable');
        }
        if (owned.stopped()) throw Error('spinning stopped before admission');
        const s = owned.session;
        const pos = () => s.sdk.getState()?.player;
        const flaxCount = () => s.sdk.getInventory().filter(i => i.id === 1779).reduce((n, i) => n + i.count, 0);
        const bowstringsCount = () => countItems(s, /^bow string$/i);
        const t0 = s.tick();
        const used = () => s.tick() - t0;
        let ended = false;
        void s.ended.then(() => { ended = true; });
        const over = () => used() >= CAP || ended || !owned.owns() || (cleaning ? hpMin < 7 || !!pos()?.isDead : owned.stopped());
        const snapshot = () => ({
            items: Object.fromEntries(s.sdk.getInventory().reduce((m, i) => m.set(i.id, (m.get(i.id) ?? 0) + i.count), new Map<number, number>())),
            xp: s.sdk.getSkillXp('Crafting') ?? 0,
        });
        const bankSnapshot = () => {
            const bank = s.bankObservation?.();
            if (!bank || !s.sdk.getState()?.bank.isOpen) throw Error('spinning bank stock unobserved');
            return { items: spinAssets([...bank.items, ...s.sdk.getInventory(), ...s.sdk.getEquipment()]), xp: s.sdk.getSkillXp('Crafting') ?? 0 };
        };
        let initialStock: ReturnType<typeof bankSnapshot> | undefined;
        const freshBank = async () => {
            if (s.sdk.getState()?.bank.isOpen) {
                await s.bot.closeBank();
                if (!await waitUntil(s, () => !s.sdk.getState()?.bank.isOpen, { timeoutTicks: 8 })) throw Error('spinning bank closure unobserved');
            }
            const generation = s.bankObservation?.()?.generation ?? -1;
            if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation, { timeoutTicks: 10 })) {
                throw Error('spinning fresh bank unobserved');
            }
        };
        const xp0 = s.sdk.getSkillXp('Crafting') ?? 0;
        const protectedKit = s.sdk.getInventory().filter(i => !/^flax$|^bow string$/i.test(i.name)).map(i => ({ id: i.id, count: i.count }));
        let hpMin = s.sdk.getSkill('Hitpoints')?.level ?? 10;
        const life = pos()?.lifeId;
        let died = false;
        const off = s.onTick(() => {
            hpMin = Math.min(hpMin, s.sdk.getSkill('Hitpoints')?.level ?? hpMin);
            if (pos()?.isDead || (life !== undefined && (pos()?.lifeId ?? life) !== life)) died = true;
        });
        unwatch = off;
        let made = 0;
        let spunTotal = 0;
        let bankTrips = 0;
        let walkTicks = 0;
        let cachedWalker: ReturnType<typeof sessionWalker> | undefined;
        const walk = async (x: number, z: number, tol = 2): Promise<boolean> => {
            const a = s.tick();
            const walker = await (cachedWalker ??= sessionWalker(s));
            for (let i = 0; i < 3 && !over(); i++) {
                const p = pos();
                if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
                const r = await walkPath(walker, [{ x, z, tol }], { stop: over });
                if (!r.ok) {
                    console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                    await waitTicks(s, 1);
                }
            }
            walkTicks += s.tick() - a;
            const p = pos();
            return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
        };
        const climbLadder = async (direction: 'up' | 'down'): Promise<boolean> => {
            const targetLevel = direction === 'up' ? 1 : 0;
            const opName = direction === 'up' ? 'Climb-up' : 'Climb-down';
            for (let attempt = 0; attempt < 3 && !over(); attempt++) {
                if (pos()?.level === targetLevel) return true;
                const ladder = s.sdk.findNearbyLoc(/^ladder$/i);
                if (ladder) {
                    await s.bot.interactLoc(ladder, opName);
                    if (await waitUntil(s, () => over() || pos()?.level === targetLevel, { timeoutTicks: 3 })) {
                        if (pos()?.level === targetLevel) return true;
                    }
                } else {
                    await waitTicks(s, 1);
                }
            }
            return pos()?.level === targetLevel;
        };
        const bank = async (withdraw = true) => {
            if (pos()?.level === 1) {
                if (!await climbLadder('down')) throw Error('spinning bank ladder descent unconfirmed');
            }
            if (!await walk(SEERS_BANK.x, SEERS_BANK.z, 2) || pos()?.level !== 0 || Math.max(Math.abs(pos()!.worldX - SEERS_BANK.x), Math.abs(pos()!.worldZ - SEERS_BANK.z)) > 2) {
                throw Error('spinning bank arrival unconfirmed');
            }
            await freshBank();
            initialStock ??= bankSnapshot();
            const note = s.sdk.getInventory().find(i => i.id === 1780);
            if (note) {
                const before = s.sdk.getState()?.bank?.items.filter(i => i.id === 1779).reduce((n, i) => n + i.count, 0) ?? 0;
                const amount = note.count;
                await s.bot.depositItem(note, -1);
                await waitUntil(s, () => over() || !s.sdk.getInventory().some(i => i.id === 1780), { timeoutTicks: 2 });
                const after = s.sdk.getState()?.bank?.items.filter(i => i.id === 1779).reduce((n, i) => n + i.count, 0) ?? 0;
                if (s.sdk.getInventory().some(i => i.id === 1780) || after !== before + amount) throw new Error('noted flax did not become raw bank stock');
                console.log(`SPIN_NOTES deposited=${amount} rawBank=${after}`);
            }
            if (bowstringsCount() > 0) {
                const before = bowstringsCount();
                await s.bot.depositItem(/^bow string$/i, -1);
                await waitUntil(s, () => bowstringsCount() === 0 || over(), { timeoutTicks: 4 });
                spunTotal += Math.max(0, before - bowstringsCount());
            }
            if (!cleaning && !over() && s.sdk.getInventory().some(i => i.id !== 1779 && i.id !== 1777)) {
                await bankCargo(s, [/^bow string$/i], 0, { stopped: over });
            }
            if (!withdraw) {
                const rawItem = s.sdk.getInventory().find(i => i.id === 1779);
                if (rawItem) await depositObserved(s, rawItem);
            }
            const stock = s.sdk.getState()?.bank?.items.find(i => /^flax$/i.test(i.name))?.count ?? 0;
            const held = s.sdk.getInventory().length;
            const free = 28 - held;
            const take = withdraw ? Math.min(free, MAX_MAKE - made, Math.max(0, stock - RAW_RESERVE)) : 0;
            if (take > 0) {
                const have0 = flaxCount();
                const r = await s.bot.withdrawItem(/^flax$/i, take);
                if (!r.success) throw new Error(`withdraw flax: ${r.message}`);
                await waitUntil(s, () => flaxCount() >= have0 + take || over(), { timeoutTicks: 4 });
            }
            await s.bot.closeInterface();
            bankTrips++;
            console.log(`MILESTONE bank t=${used()} spunTotal=${spunTotal} bankTrips=${bankTrips} flax=${flaxCount()}`);
        };
        recovery = async () => {
            if (!owned.owns() || ended || hpMin < 7 || pos()?.isDead || used() >= CAP || s.sdk.getStateAge() > 5000) return;
            cleaning = true;
            owned.cleanup();
            await bank(false);
        };
        const spin = async () => {
            if (pos()?.level === 0) {
                await walk(WHEEL_HOUSE.x, WHEEL_HOUSE.z, 1);
                await climbLadder('up');
            }
            const wheel = s.sdk.findNearbyLoc(/^spinning wheel$/i);
            if (!wheel) {
                console.log('WARN spinning wheel not found nearby');
                await waitUntil(s, () => over() || !!s.sdk.findNearbyLoc(/^spinning wheel$/i), { timeoutTicks: 3 });
                return;
            }
            if ((s.sdk.getSkill('Crafting')?.baseLevel ?? 1) < 10) throw new Error('flax requires Crafting 10');
            const clearLevelup = async () => {
                let lastPage = '';
                for (let i = 0; i < 12; i++) {
                    const d = s.sdk.getDialog();
                    if (!d?.isOpen) return;
                    const option = d.options.length === 1 && /continue/i.test(d.options[0]!.text) ? d.options[0] : null;
                    if (!option) throw new Error('unexpected dialog during batch spinning');
                    const key = d.pageId ?? JSON.stringify(d.options);
                    if (key !== lastPage) {
                        console.log(`SPIN_CONTINUE page=${key}`);
                        await s.sdk.sendClickDialog(option.index);
                        lastPage = key;
                    }
                    await waitUntil(
                        s,
                        () => {
                            if (over()) return true;
                            const cur = s.sdk.getDialog();
                            return !cur?.isOpen || (cur.pageId ?? JSON.stringify(cur.options)) !== lastPage;
                        },
                        { timeoutTicks: 2 },
                    );
                }
                throw new Error('level-up dialog did not clear');
            };
            let missed = 0;
            while (flaxCount() > 0 && made < MAX_MAKE && !over()) {
                if (s.sdk.getDialog()?.isOpen) await clearLevelup();
                await s.bot.interactLoc(wheel, 'Spin');
                const menu = await waitUntil(s, () => s.sdk.getDialog()?.options.some(o => o.componentId === 8875) ?? false, { timeoutTicks: 8 });
                const d = s.sdk.getDialog();
                console.log('SPIN_MENU ' + JSON.stringify(d));
                const makeX = d?.options.find(o => o.componentId === 8875);
                const flax = d?.options.find(o => o.componentId === 8878 && /flax/i.test(o.text));
                if (!menu || !makeX || !flax) throw new Error('fresh flax MakeX menu not observed');
                const amount = Math.min(flaxCount(), MAX_MAKE - made);
                const before = flaxCount();
                let observed = snapshot();
                let lastProgress = s.tick();
                await s.sdk.sendClickDialog(makeX.index);
                await s.sdk.sendCountDialog(amount);
                while (!over()) {
                    const next = snapshot();
                    const n = flaxCount();
                    const gain = spinConversion(observed, next, MAX_MAKE - made);
                    observed = next;
                    if (gain) {
                        made += gain;
                        lastProgress = s.tick();
                        missed = 0;
                    }
                    if (n <= before - amount) break;
                    const dialog = s.sdk.getDialog();
                    if (dialog?.isOpen && dialog.options.length === 1 && /continue/i.test(dialog.options[0]!.text)) {
                        await clearLevelup();
                        break;
                    }
                    if (s.tick() - lastProgress >= 8) {
                        if (++missed >= 3) throw new Error('batch flax spinning made no progress');
                        break;
                    }
                    await waitTicks(s, 1);
                }
            }
        };
        console.log(`START spin-bowstrings ${botName} at=${pos()?.worldX},${pos()?.worldZ},${pos()?.level}`);
        await bank();
        while (!over() && made < MAX_MAKE && bankTrips < MAX_TRIPS) {
            if (flaxCount() === 0) {
                await bank();
                if (flaxCount() === 0) break;
            }
            await spin();
        }
        if (over()) throw Error('spinning stop/life/session/budget limit');
        await bank(false);
        if (flaxCount() > 0) throw new Error('unprocessed flax remains after bound');
        await freshBank();
        const bankItems = s.sdk.getState()?.bank?.items ?? [];
        const rawBank = bankItems.filter(i => /^flax$/i.test(i.name)).reduce((n, i) => n + i.count, 0);
        const stringsBank = bankItems.filter(i => /^bow string$/i.test(i.name)).reduce((n, i) => n + i.count, 0);
        const finalStock = bankSnapshot();
        const reconciled = !!initialStock && spinConversion(initialStock, finalStock, MAX_MAKE) === made;
        spunTotal = initialStock ? stringsBank - (initialStock.items[1777] ?? 0) : 0;
        const preserved = protectedKit.every(i => s.sdk.getInventory().filter(j => j.id === i.id).reduce((n, j) => n + j.count, 0) === i.count);
        const xpGain = (s.sdk.getSkillXp('Crafting') ?? 0) - xp0;
        const ok = !over() && reconciled && made === MAX_MAKE && spunTotal === made && rawBank >= RAW_RESERVE && preserved && !died && hpMin >= 7 && xpGain > 0;
        const inputFailure = spinInputFailure(made, MAX_MAKE, rawBank, RAW_RESERVE);
        const stop = inputFailure ? 'input-wait' : ok ? 'target' : 'incomplete';
        console.log('SPIN_BANK ' + JSON.stringify({ ok, made, spunTotal, rawBank, stringsBank, reconciled, preserved, xpGain, hpMin, died, targetMet: ok, stop, inventory: s.sdk.getInventory(), bank: bankItems }));
        await s.bot.closeBank();
        off();
        const detail = `${inputFailure ? inputFailure + ' ' : ''}ticks=${used()} made=${made} spunTotal=${spunTotal} rawBank=${rawBank} xpGain=${xpGain} preserved=${preserved} hpMin=${hpMin} died=${died} targetMet=${ok ? 1 : 0} stop=${stop}`;
        await complete(ok, detail);
        return { ok, made, spunTotal, ticks: used(), summary: detail, failure: ok ? undefined : detail };
    } catch (e) {
        let detail = String(e);
        try {
            await recovery?.();
        } catch (recoveryError) {
            detail += '; original bank cleanup ' + String(recoveryError);
        }
        unwatch?.();
        await complete(false, detail);
        return { ok: false, made: 0, spunTotal: 0, ticks: raw.tick() - entryTick, summary: detail, failure: detail };
    }
}
export const spinMain = (
    io: { open?: typeof openBot; ready?: (s: Session) => Promise<boolean>; finalize?: Parameters<typeof finishActionSession>[3] } = {},
) => runSpinBowstrings(process.env.BOT ?? 'Ballspinner', [], process.env, io);

// ---- Furnace Jewellery (microbot-b-jewellery.ts) ----

const objIdByName = (name: string) => {
    const n = packMap('obj').get(name);
    if (n === undefined) throw Error('unknown native jewellery item ' + name);
    return n;
};

export { jewelleryRecipes, type JewelleryRecipe };

export function jewelleryMenu(r: JewelleryRecipe, items: Record<number, number>, members: boolean) {
    if (r.shape !== 'silver') {
        return { component: `crafting_jewelry:${r.shape === 'ring' ? 'rings' : r.shape === 'necklace' ? 'necklaces' : 'amulets'}_inv`, slot: r.slot, option: 1 };
    }
    const count = members && (items[objIdByName('sickle_mould')] ?? 0) > 0 ? 3 : 2;
    if (r.silverLetter === 'c' && count !== 3) throw Error('silver sickle needs members and sickle mould');
    return { component: `skill_multi${count}:make1_${r.silverLetter}`, slot: undefined, option: undefined };
}

export const jewellerySnapshot = (s: BotWorldState): ProductionSnapshot => ({
    items: Object.fromEntries([...s.inventory.reduce((m, i) => m.set(i.id, (m.get(i.id) ?? 0) + i.count), new Map<number, number>())]),
    xp: s.skills.find(k => k.name === 'Crafting')?.experience ?? 0,
});

export interface JewelleryDriver {
    state: () => BotWorldState | null;
    tick: () => number;
    stop: () => boolean;
    open: (barSlot: number) => Promise<boolean>;
    choose: (menu: ReturnType<typeof jewelleryMenu>) => Promise<boolean>;
    close: () => Promise<void>;
    wait: (test: () => boolean, ticks: number) => Promise<boolean>;
    step: () => Promise<void>;
}

export async function runJewellery(d: JewelleryDriver, r: JewelleryRecipe, o: { maximum: number; cap: number; members: boolean }) {
    if (!Number.isSafeInteger(o.maximum) || o.maximum < 1 || !Number.isSafeInteger(o.cap) || o.cap < 1) throw Error('invalid jewellery bounds');
    const initial = d.state();
    if (!initial?.player) throw Error('jewellery state unknown');
    const initialHp = initial.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;
    if (initialHp < 1) throw Error('jewellery health unknown');
    if ((initial.skills.find(k => k.name === 'Crafting')?.level ?? 0) < r.level) throw Error('jewellery Crafting level insufficient');
    if (r.members && !o.members) throw Error('jewellery needs confirmed members world');
    const first = jewellerySnapshot(initial);
    const start = d.tick();
    let made = 0;
    if (r.bar !== objIdByName('perfect_gold_bar') && (first.items[objIdByName('perfect_gold_bar')] ?? 0) > 0) {
        throw Error('remove perfect gold bars before ordinary jewellery; native precedence');
    }
    const state = () => {
        const s = d.state();
        if (!s?.player) throw Error('jewellery session ended');
        if (d.stop()) throw Error('jewellery stopped');
        if (d.tick() - start >= o.cap) throw Error('jewellery tick cap');
        if (
            s.player.lifeId !== initial.player!.lifeId ||
            s.player.level !== initial.player!.level ||
            s.player.isDead ||
            (s.skills.find(k => k.name === 'Hitpoints')?.level ?? 0) !== initialHp
        ) {
            throw Error('jewellery health or floor changed');
        }
        return s;
    };
    try {
        while (made < o.maximum) {
            const before = state();
            const snapshot = jewellerySnapshot(before);
            if (r.tools.some(tool => (snapshot.items[tool] ?? 0) < 1) || r.inputs.some(input => (snapshot.items[input.id] ?? 0) < input.units)) {
                throw Error('jewellery staged inputs or mould exhausted');
            }
            const bar = before.inventory.find(i => i.id === r.bar)!;
            await d.close();
            if (!(await d.open(bar.slot)) || (r.shape !== 'silver' && !await d.wait(() => !!state().interface?.isOpen, Math.min(8, o.cap - (d.tick() - start))))) {
                throw Error('jewellery furnace interface unobserved');
            }
            const menu = jewelleryMenu(r, snapshot.items, o.members);
            if (!(await d.choose(menu))) throw Error('jewellery menu refused');
            if (
                !await d.wait(() => {
                    const effect = productionEffect(r, snapshot, jewellerySnapshot(state()));
                    if (effect === 'invalid' || effect === 'loss') throw Error('jewellery assets do not reconcile');
                    return effect === 'made';
                }, Math.min(12, o.cap - (d.tick() - start)))
            ) {
                throw Error('jewellery product unobserved');
            }
            made++;
            if (made < o.maximum) await d.step();
        }
        const final = jewellerySnapshot(state());
        if ((final.items[r.product] ?? 0) - (first.items[r.product] ?? 0) !== made) throw Error('jewellery total output mismatch');
        return { made, ticks: d.tick() - start, product: r.product };
    } finally {
        await d.close();
    }
}

export async function runJewelleryCli(
    name: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
) {
    const recipeName = restArgs[0];
    const maximum = Number(restArgs[1] ?? 1);
    const cap = Number(restArgs[2] ?? 200);
    const r = jewelleryRecipes().find(r => r.name === recipeName);
    if (!name || !r) throw Error('account and native jewellery recipe name required');
    const s = await openBot(name).catch(e => finish([], false, `login: ${String(e)}`));
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const start = s.tick();
    const stop = () => ended || existsSync(`.practice/stop-${name}`) || existsSync('.practice/stop-all');
    try {
        const result = await runJewellery(
            {
                state: () => s.sdk.getState(),
                tick: () => s.tick(),
                stop,
                close: async () => { await s.sdk.sendCloseModal(); },
                open: async slot => {
                    if (stop() || s.tick() - start >= cap) return false;
                    const furnace = s.sdk.getState()?.nearbyLocs.find(l => /^furnace$/i.test(l.name) && l.distance <= 2 && l.reachable !== false);
                    if (!furnace) throw Error('stage beside observed furnace');
                    if (!(await s.sdk.sendUseItemOnLoc(slot, furnace.x, furnace.z, furnace.id)).success) return false;
                    return waitUntil(s, st => stop() || !!st.interface?.isOpen || !!st.dialog?.isOpen, { timeoutTicks: Math.min(8, Math.max(1, cap - (s.tick() - start))) });
                },
                choose: async menu => {
                    if (stop()) return false;
                    return (
                        menu.option === undefined
                            ? await s.sdk.sendClickComponent(componentId(menu.component))
                            : await s.sdk.sendClickComponentWithOption(componentId(menu.component), menu.option, menu.slot)
                    ).success;
                },
                wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
                step: () => waitTicks(s, 1),
            },
            r,
            { maximum, cap, members: env.MEMBERS === '1' },
        );
        await finish([s], true, JSON.stringify(result));
    } catch (e) {
        await finish([s], false, String(e));
    }
}

// ---- Jewellery Trip (microbot-jewellery-trip.ts) ----

export interface JewelleryOrder {
    recipe: string;
    target: number;
    batch: number;
    cap: number;
    returnTicks: number;
    reserve: number;
    members: boolean;
    stringAmulet: boolean;
    bank: Tile;
    furnace: Tile;
}

export interface JewellerySnapshot {
    assets: Record<number, number>;
    bank: Record<number, number>;
    pack: Record<number, number>;
    gear: { id: number; slot: number; count: number }[];
    xp: Record<string, number>;
}

type JewelleryStage = { family: 'inventory' | 'jewellery'; recipe: string; target: number; product: number; delta: Record<number, number> };
type JobReceipt = { ok: boolean; completed: number; atBank: boolean; banked: Record<number, number>; failure?: string };
type JewelleryClient = { executeBotAction?: unknown; membersAccount?: number; selfSlot?: number };
type ApproachResult = { ok: boolean; detail?: string };
export type JewelleryDeps = {
    audit?: () => Promise<JewellerySnapshot>;
    job?: (s: Session, j: any, stop: () => boolean) => Promise<JobReceipt>;
    approach?: (s: Session, to: Tile, maxTicks: number, stop: () => boolean) => Promise<ApproachResult>;
};

export async function approachJewelleryBank(s: Session, to: Tile, maxTicks: number, stop: () => boolean): Promise<ApproachResult> {
    const start = s.tick();
    const controller = new AbortController();
    const bounded = () => stop() || s.tick() - start >= maxTicks;
    const off = s.onTick(() => {
        if (bounded()) controller.abort('jewellery bank approach bound');
    });
    try {
        const r = await goTo(s, await getWorld(), to, accountOf(s), { signal: controller.signal, legTimeoutTicks: Math.max(1, Math.min(120, maxTicks)), maxRetriesPerLeg: 1 });
        if (controller.signal.aborted) return { ok: false, detail: 'bound ' + maxTicks + ' ticks or stop' };
        return r.ok ? { ok: true } : { ok: false, detail: r.detail };
    } finally {
        off();
    }
}

export function jewelleryCleanup(raw: Session, finalize: typeof settle = settle, logout: (session: Session) => Promise<string> = logoutSession) {
    const owner = actionSessionOwner(raw);
    const sdk = raw.sdk;
    const client = raw.client as JewelleryClient | undefined;
    const direct = raw.direct;
    const close = raw.close;
    const ended = raw.ended;
    const lifecycle = raw.lifecycle;
    const name = raw.name;
    const slot = client?.selfSlot;
    const config = sdk.config;
    const origin = JSON.stringify([config?.gatewayUrl, config?.host, config?.port]);
    const player = sdk.getState()?.player;
    const life = player?.lifeId;
    const respawns = player?.respawnCount ?? 0;
    let lost = false;
    let loggedOut = false;
    let executor = client?.executeBotAction;
    let ownDirect = direct;
    void ended.then(e => { loggedOut = e.reason === 'logged-out'; });
    const owns = () => {
        const p = sdk.getState()?.player;
        if (
            raw.sdk !== sdk ||
            raw.client !== client ||
            raw.direct !== ownDirect ||
            raw.close !== close ||
            raw.ended !== ended ||
            raw.lifecycle !== lifecycle ||
            raw.name !== name ||
            client?.executeBotAction !== executor ||
            sdk.config !== config ||
            JSON.stringify([config?.gatewayUrl, config?.host, config?.port]) !== origin ||
            client?.selfSlot !== slot ||
            ((!loggedOut || p != null) && (p?.lifeId !== life || (p?.respawnCount ?? 0) !== respawns))
        ) {
            lost = true;
        }
        return !lost && typeof executor === 'function' && Number.isSafeInteger(slot) && Number.isSafeInteger(life);
    };
    const guard = () => {
        if (!owns()) throw Error('jewellery cleanup original session replaced');
    };
    const settled = () => {
        executor = client?.executeBotAction;
        ownDirect = raw.direct;
    };
    const guarded = new Proxy(sdk, {
        get(t, k, r) {
            const value = Reflect.get(t, k, r);
            return typeof value === 'function'
                ? function (...args: unknown[]) {
                      if (String(k).startsWith('send')) guard();
                      return value.apply(r, args);
                  }
                : value;
        },
    });
    const session = Object.create(raw) as Session;
    Object.defineProperties(session, {
        sdk: { value: guarded },
        client: { value: client },
        bot: { value: new BotActions(guarded) },
        direct: {
            value: (a: Parameters<Session['direct']>[0]) => {
                guard();
                return direct.call(raw, a);
            },
        },
        close: {
            value: () => {
                guard();
                return close.call(raw);
            },
        },
        ended: { value: ended },
        lifecycle: { value: lifecycle },
        name: { value: name },
    });
    return {
        owns,
        finish: async (ok: boolean, detail: string) => {
            if (!owns()) return false;
            if (!owner.own()) {
                const end = await Promise.race([ended, Promise.resolve({ reason: '' })]);
                return end.reason === 'logged-out' && owns() && owner.identity() && owner.sameLife() ? finalize([raw], ok, detail) : false;
            }
            return (
                (await finishActionSession(
                    owner,
                    ok,
                    detail,
                    async (sessions, valid, message, options) => (owns() ? finalize(sessions, valid, message, options) : false),
                    async () => {
                        settled();
                        guard();
                        const outcome = await logout(session);
                        guard();
                        return outcome;
                    },
                )) === true
            );
        },
    };
}

const equalRec = (a: Record<number, number>, b: Record<number, number>) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)].map(Number))].every(id => (a[id] ?? 0) === (b[id] ?? 0));
const addRec = (to: Record<number, number>, delta: Record<number, number>) => {
    for (const [id, n] of Object.entries(delta)) to[Number(id)] = (to[Number(id)] ?? 0) + n;
};

export function validateJewelleryOrder(o: JewelleryOrder) {
    if (
        !o ||
        !Number.isSafeInteger(o.target) ||
        o.target < 1 ||
        o.target > 10000 ||
        !Number.isSafeInteger(o.batch) ||
        o.batch < 1 ||
        o.batch > 27 ||
        !Number.isSafeInteger(o.cap) ||
        o.cap < 1 ||
        o.cap > 100000 ||
        !Number.isSafeInteger(o.returnTicks) ||
        o.returnTicks < 40 ||
        o.returnTicks >= o.cap - 100 ||
        !Number.isSafeInteger(o.reserve) ||
        o.reserve < 0 ||
        typeof o.members !== 'boolean' ||
        typeof o.stringAmulet !== 'boolean'
    ) {
        throw Error('invalid finite jewellery order');
    }
    for (const tile of [o.bank, o.furnace]) {
        if (!tile || ![tile.x, tile.z, tile.level].every(Number.isSafeInteger) || tile.x < 0 || tile.x > 16383 || tile.z < 0 || tile.z > 16383 || tile.level < 0 || tile.level > 3) {
            throw Error('jewellery bank/furnace unknown');
        }
    }
    const recipe = jewelleryRecipes().find(r => r.name === o.recipe);
    if (!recipe) throw Error('unknown native jewellery recipe');
    if (o.stringAmulet && (recipe.shape !== 'amulet' || !inventoryRecipes().some(r => r.name.startsWith('string-') && r.inputs.some(i => i.id === recipe.product)))) {
        throw Error('native amulet stringing unavailable');
    }
    if (recipe.members && !o.members) throw Error('jewellery member recipe unavailable');
    return recipe;
}

export function jewelleryOrderFromEnv(env: Record<string, string | undefined>): JewelleryOrder {
    const n = (key: string, fallback: number) => (env[key] === undefined || env[key] === '' ? fallback : Number(env[key]));
    return {
        recipe: env.RECIPE ?? '',
        target: n('TARGET', NaN),
        batch: n('BATCH', 13),
        cap: n('CAP', 1500),
        returnTicks: n('RETURN_TICKS', 100),
        reserve: n('RESERVE', 0),
        members: env.MEMBERS === '1',
        stringAmulet: env.STRING_AMULET === '1',
        bank: { x: 3269, z: 3167, level: 0 },
        furnace: { x: 3275, z: 3186, level: 0 },
    };
}

export function planJewelleryOrder(o: JewelleryOrder, stock: Record<number, number>, level: number) {
    const recipe = validateJewelleryOrder(o);
    const inventory = inventoryRecipes();
    if (!Number.isSafeInteger(level) || level < recipe.level || Object.values(stock).some(n => !Number.isSafeInteger(n) || n < 0)) {
        throw Error('jewellery base level/owned stock unknown');
    }
    const simulated = { ...stock };
    const floor = Object.fromEntries(Object.entries(stock).map(([id, n]) => [id, Math.min(n, o.reserve)]));
    const stages: JewelleryStage[] = [];
    const available = (id: number) => Math.max(0, (simulated[id] ?? 0) - (floor[id] ?? 0));
    const stage = (family: JewelleryStage['family'], r: Pick<InventoryRecipe, 'name' | 'inputs' | 'tools' | 'product' | 'level' | 'members'>, n: number) => {
        if (level < r.level || (r.members && !o.members) || r.tools.some(id => (simulated[id] ?? 0) < 1)) {
            throw Error('jewellery stage level/tool/member unavailable ' + r.name);
        }
        const delta: Record<number, number> = {};
        for (const input of r.inputs) {
            const cost = input.units * n;
            if (available(input.id) < cost) throw Error('owned jewellery ingredient/reserve unavailable ' + input.id);
            delta[input.id] = (delta[input.id] ?? 0) - cost;
        }
        delta[r.product] = (delta[r.product] ?? 0) + n;
        addRec(simulated, delta);
        stages.push({ family, recipe: r.name, target: n, product: r.product, delta });
    };
    const gem = recipe.inputs.find(i => i.id !== recipe.bar);
    if (gem && available(gem.id) < o.target) {
        const cut = inventory.find(r => r.name.startsWith('cut-') && r.product === gem.id && !r.lossProduct && (r.productUnits ?? 1) === 1);
        if (!cut) throw Error('native lossless gem preparation unavailable');
        stage('inventory', cut, o.target - available(gem.id));
    }
    stage('jewellery', recipe, o.target);
    let product = recipe.product;
    if (o.stringAmulet) {
        const string = inventory.find(r => r.name.startsWith('string-') && r.inputs.some(i => i.id === recipe.product) && (r.productUnits ?? 1) === 1);
        if (!string || recipe.shape !== 'amulet') throw Error('native amulet stringing unavailable');
        stage('inventory', string, o.target);
        product = string.product;
    }
    const delta: Record<number, number> = {};
    for (const s of stages) addRec(delta, s.delta);
    return { stages, delta, product, floor };
}

export async function runJewelleryOrder(
    raw: Session,
    o: JewelleryOrder,
    requested: () => boolean = () => false,
    deps: JewelleryDeps = {},
    extDeps?: ArtisanExternalDeps,
) {
    const recipe = validateJewelleryOrder(o);
    const originalSdk = raw.sdk;
    const originalDirect = raw.direct;
    const config = originalSdk.config;
    const origin = JSON.stringify([config?.gatewayUrl, config?.host, config?.port]);
    const initialPlayer = raw.sdk.getState()?.player;
    const life = initialPlayer?.lifeId;
    const respawns = initialPlayer?.respawnCount ?? 0;
    const hp = raw.sdk.getSkill('Hitpoints')?.level ?? 0;
    const client = raw.client as JewelleryClient | undefined;
    const executor = client?.executeBotAction;
    const slot = client?.selfSlot;
    const start = raw.tick();
    let ended = false;
    let lost = false;
    let uncertain = false;
    let failure = '';
    let made = 0;
    void raw.ended.then(() => { ended = true; });
    const fatal = () => {
        const p = raw.sdk.getState()?.player;
        const age = raw.sdk.getStateAge();
        if (
            raw.sdk !== originalSdk ||
            raw.direct !== originalDirect ||
            raw.client !== client ||
            client?.executeBotAction !== executor ||
            client?.selfSlot !== slot ||
            originalSdk.config !== config ||
            JSON.stringify([config?.gatewayUrl, config?.host, config?.port]) !== origin
        ) {
            lost = true;
        }
        return (
            lost ||
            typeof executor !== 'function' ||
            !Number.isSafeInteger(slot) ||
            ended ||
            !p ||
            !Number.isSafeInteger(life) ||
            p.lifeId !== life ||
            (p.respawnCount ?? 0) !== respawns ||
            p.isDead ||
            hp < 1 ||
            (raw.sdk.getSkill('Hitpoints')?.level ?? 0) !== hp ||
            !Number.isFinite(age) ||
            age < 0 ||
            age > 5000
        );
    };
    const stop = () => fatal() || productionStopRequested(raw.name, requested, existsSync, process.env.STOP_FILE ?? '.practice/stop-microbot-jewellery') || raw.tick() - start >= o.cap - o.returnTicks;
    const guard = () => {
        if (fatal() || raw.tick() - start >= o.cap) throw Error('jewellery original owner/life/budget unavailable');
    };
    const invRecipes = inventoryRecipes();
    const gem = recipe.inputs.find(i => i.id !== recipe.bar);
    const cut = gem && invRecipes.find(r => r.name.startsWith('cut-') && r.product === gem.id && !r.lossProduct);
    const string = o.stringAmulet && invRecipes.find(r => r.name.startsWith('string-') && r.inputs.some(i => i.id === recipe.product));
    const productionItems = new Set([recipe, ...(cut ? [cut] : []), ...(string ? [string] : [])].flatMap(r => [...r.inputs.map(i => i.id), ...r.tools]));
    const sickle = jewelleryRecipes().find(r => r.name === 'silver_sickle')?.tools[0];
    const tools = Object.fromEntries(recipe.tools.map(id => [id, 1]));
    const paidComponents = new Set(
        [jewelleryMenu(recipe, tools, o.members), jewelleryMenu(recipe, { ...tools, ...(sickle === undefined ? {} : { [sickle]: 1 }) }, o.members)].map(m => componentId(m.component)),
    );
    for (const r of [cut, string]) if (r && r.menu) paidComponents.add(componentId(r.menu));
    const newProduction = (key: PropertyKey, args: unknown[]): boolean => {
        if (key === 'send' || key === 'sendAction') {
            const envelope = args[0];
            if (!envelope || typeof envelope !== 'object') return false;
            const value = key === 'send' ? (envelope as Record<string, unknown>).action : envelope;
            if (!value || typeof value !== 'object') return false;
            const a = value as Record<string, unknown>;
            if (a.type === 'clickComponent' || a.type === 'clickComponentWithOption') return newProduction(a.type === 'clickComponent' ? 'sendClickComponent' : 'sendClickComponentWithOption', [a.componentId]);
            if (a.type === 'useInventoryItem') return newProduction('sendUseItem', [a.slot]);
            if (a.type === 'useItemOnItem') return newProduction('sendUseItemOnItem', [a.sourceSlot, a.targetSlot]);
            if (a.type === 'useItemOnLoc') return newProduction('sendUseItemOnLoc', [a.itemSlot]);
            return false;
        }
        const item = (slotNum: unknown) => raw.sdk.getInventory().find(i => i.slot === slotNum)?.id;
        if ((key === 'sendClickComponent' || key === 'sendClickComponentWithOption') && paidComponents.has(Number(args[0]))) return true;
        if (key === 'sendUseItemOnLoc') return item(args[0]) === recipe.bar;
        if (key === 'sendUseItem' || key === 'sendUseItemOnItem') {
            return [item(args[0]), ...(key === 'sendUseItemOnItem' ? [item(args[1])] : [])].some(id => id !== undefined && productionItems.has(id));
        }
        return false;
    };
    const sdk = new Proxy(raw.sdk, {
        get(t, k, r) {
            const value = Reflect.get(t, k, r);
            return typeof value === 'function'
                ? function (...args: unknown[]) {
                      if (String(k).startsWith('send')) {
                          guard();
                          if (newProduction(k, args) && stop()) throw Error('jewellery stopped before new production input');
                      }
                      return value.apply(r, args);
                  }
                : value;
        },
    });
    const s = Object.create(raw) as Session;
    Object.defineProperties(s, {
        sdk: { value: sdk },
        client: { value: client },
        bot: { value: new BotActions(sdk) },
        direct: {
            value: (action: Parameters<Session['direct']>[0]) => {
                guard();
                if (newProduction('sendAction', [action]) && stop()) throw Error('jewellery stopped before new production input');
                return raw.direct(action);
            },
        },
    });
    const audit =
        deps.audit ??
        (async (): Promise<JewellerySnapshot> => {
            guard();
            const p = s.sdk.getState()?.player;
            if (!p || p.level !== o.bank.level || Math.max(Math.abs(p.worldX - o.bank.x), Math.abs(p.worldZ - o.bank.z)) > 3 || o.cap - (s.tick() - start) < 30) {
                throw Error('jewellery fresh bank position/budget absent');
            }
            const tick = s.tick();
            await s.sdk.sendCloseModal();
            if (!await waitUntil(s, () => fatal() || (s.tick() > tick && !s.sdk.getState()?.bank.isOpen && !s.sdk.getState()?.interface.isOpen && !s.sdk.getDialog()?.isOpen), { timeoutTicks: 10 }) || fatal()) {
                throw Error('jewellery modal closure unobserved');
            }
            const generation = s.bankObservation?.()?.generation ?? -1;
            if (!(await s.bot.openBank()).success || !await waitUntil(s, () => fatal() || (!!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation), { timeoutTicks: 10 }) || fatal()) {
                throw Error('jewellery fresh bank unavailable');
            }
            const cnt = (rows: readonly { id: number; count: number }[]) => {
                const out: Record<number, number> = {};
                for (const row of rows) out[row.id] = (out[row.id] ?? 0) + row.count;
                return out;
            };
            const gear = s.sdk.getEquipment().map(i => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot);
            const bank = cnt(s.bankObservation!()!.items);
            const pack = cnt(s.sdk.getInventory());
            const assets = { ...bank };
            addRec(assets, pack);
            addRec(assets, cnt(gear));
            const snapshot = { assets, bank, pack, gear, xp: Object.fromEntries((s.sdk.getState()?.skills ?? []).map(k => [k.name, k.experience])) };
            if (!Object.keys(snapshot.xp).length) throw Error('jewellery skill observation absent');
            if (!(await s.bot.closeBank()).success || !await waitUntil(s, () => fatal() || !s.sdk.getState()?.bank.isOpen, { timeoutTicks: 8 }) || fatal()) {
                throw Error('jewellery bank closure unobserved');
            }
            return snapshot;
        });
    let initial: JewellerySnapshot | undefined;
    let final: JewellerySnapshot | undefined;
    let expected: Record<number, number> = {};
    let product = -1;
    const receipts: { stage: JewelleryStage; result: JobReceipt }[] = [];
    try {
        if (stop() || (o.members && client?.membersAccount !== 1)) throw Error('jewellery entry stop/member/life unavailable');
        const away = () => {
            const p = raw.sdk.getState()?.player;
            return !p || p.level !== o.bank.level || Math.max(Math.abs(p.worldX - o.bank.x), Math.abs(p.worldZ - o.bank.z)) > 3;
        };
        if (away()) {
            const bound = o.cap - o.returnTicks - 100 - (raw.tick() - start);
            const approached = async (): Promise<ApproachResult> => {
                if (bound < 1) return { ok: false, detail: 'no tick budget' };
                guard();
                try {
                    const r = await (deps.approach ?? approachJewelleryBank)(s, o.bank, bound, stop);
                    guard();
                    return r.ok && away() ? { ok: false, detail: 'arrival unobserved' } : r;
                } catch (error) {
                    return { ok: false, detail: String(error) };
                }
            };
            const r = await approached();
            if (!r.ok) throw Error('jewellery bank approach failed: ' + (r.detail ?? '-'));
        }
        initial = await audit();
        const plan = planJewelleryOrder(o, initial.assets, raw.sdk.getSkill('Crafting')?.baseLevel ?? 0);
        product = plan.product;
        expected = { ...initial.assets };
        const jobRunner = deps.job ?? (extDeps?.runBankJob as JewelleryDeps['job']) ?? (defaultBankJobRunner as JewelleryDeps['job']);
        if (!jobRunner) throw Error('jewellery trip requires runBankJob dependency');
        for (const stage of plan.stages) {
            if (stop()) throw Error('jewellery stopped before next stage');
            const before = await audit();
            if (!equalRec(before.assets, expected) || JSON.stringify(before.gear) !== JSON.stringify(initial.gear)) {
                throw Error('jewellery stock/gear drift before stage');
            }
            const cap = o.cap - (raw.tick() - start) - 40;
            if (cap <= o.returnTicks + 40) throw Error('jewellery stage/return budget unavailable');
            uncertain = true;
            const result = await jobRunner(
                s,
                {
                    family: stage.family,
                    recipe: stage.recipe,
                    target: stage.target,
                    batch: o.batch,
                    cap,
                    returnTicks: o.returnTicks,
                    members: o.members,
                    reserve: 0,
                    bank: o.bank,
                    site: stage.family === 'jewellery' ? o.furnace : o.bank,
                },
                stop,
            );
            receipts.push({ stage, result });
            if (!result.ok || !result.atBank || result.completed !== stage.target || result.banked[stage.product] !== stage.target) {
                throw Error('jewellery child receipt incomplete');
            }
            addRec(expected, stage.delta);
            final = await audit();
            if (
                !equalRec(final.assets, expected) ||
                JSON.stringify(final.gear) !== JSON.stringify(initial.gear) ||
                Object.keys(initial.xp).some(skill => skill !== 'Crafting' && final!.xp[skill] !== initial!.xp[skill]) ||
                (final.xp.Crafting ?? 0) <= (before.xp.Crafting ?? 0)
            ) {
                throw Error('jewellery stage asset/XP/gear reconciliation failed');
            }
            uncertain = false;
        }
        made = o.target;
    } catch (error) {
        failure = String(error);
    }
    const preserved = !!initial && !!final && equalRec(final.assets, expected) && JSON.stringify(final.gear) === JSON.stringify(initial.gear);
    const banked = initial && final ? (final.bank[product] ?? 0) - (initial.bank[product] ?? 0) : 0;
    const ok = !failure && !stop() && !uncertain && preserved && made === o.target && banked >= made && (final?.pack[product] ?? 0) === 0;
    return { ok, recipe: o.recipe, product, made, banked, preserved, uncertain, receipts, ticks: raw.tick() - start, failure: failure || '-' };
}

export async function runJewelleryTripCli(
    actor: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
    deps?: ArtisanExternalDeps,
) {
    const path = restArgs[0];
    if (!actor || (!path && !env.RECIPE)) throw Error('account and finite jewellery order JSON, or RECIPE and TARGET, required');
    const order = path ? (JSON.parse(readFileSync(path, 'utf8')) as JewelleryOrder) : jewelleryOrderFromEnv(env);
    validateJewelleryOrder(order);
    let stopped = false;
    const s = await openBot(actor, { onStop: async () => { stopped = true; } });
    const cleanup = jewelleryCleanup(s);
    try {
        const result = await runJewelleryOrder(s, order, () => stopped, {}, deps);
        if (!cleanup.owns()) {
            result.ok = false;
            result.failure = 'jewellery original session replaced; cleanup refused';
        }
        console.log('JEWELLERY_ORDER ' + JSON.stringify(result));
        process.exitCode = (await cleanup.finish(result.ok, JSON.stringify(result))) ? 0 : 1;
    } catch (error) {
        await cleanup.finish(false, String(error));
        throw error;
    }
}

export type PvpJewelleryKey =
    | 'ring_of_recoil'
    | 'amulet_of_magic'
    | 'amulet_of_defence'
    | 'amulet_of_strength'
    | 'amulet_of_power'
    | 'ring_of_life'
    | 'amulet_of_glory';

export interface PvpJewellerySpec {
    key: PvpJewelleryKey;
    gem: 'sapphire' | 'emerald' | 'ruby' | 'diamond' | 'dragonstone';
    shape: 'ring' | 'amulet';
    uncutGem: number;
    cutGem: number;
    mould: number;
    jewelleryRecipe: string;
    mouldedItem: number;
    stringRecipe?: string;
    enchantTargetName: string;
    enchantTargetId: number;
    enchantMode: string;
    productId: number;
    craftLevel: number;
    magicLevel: number;
    members: boolean;
}

// Pinned content/pack/obj.pack & jewellery.struct & magic_spells.dbrow IDs for PvP jewelry chains.
export const PVP_JEWELLERY_PIPELINES: Readonly<Record<PvpJewelleryKey, PvpJewellerySpec>> = {
    ring_of_recoil: {
        key: 'ring_of_recoil',
        gem: 'sapphire',
        shape: 'ring',
        uncutGem: 1623,
        cutGem: 1607,
        mould: 1592,
        jewelleryRecipe: 'sapphire_ring',
        mouldedItem: 1637,
        enchantTargetName: 'sapphire_ring',
        enchantTargetId: 1637,
        enchantMode: 'enchant:sapphire_ring',
        productId: 2550,
        craftLevel: 20,
        magicLevel: 7,
        members: true,
    },
    amulet_of_magic: {
        key: 'amulet_of_magic',
        gem: 'sapphire',
        shape: 'amulet',
        uncutGem: 1623,
        cutGem: 1607,
        mould: 1595,
        jewelleryRecipe: 'unstrung_sapphire_amulet',
        mouldedItem: 1675,
        stringRecipe: 'string-sapphire-amulet',
        enchantTargetName: 'strung_sapphire_amulet',
        enchantTargetId: 1694,
        enchantMode: 'enchant:strung_sapphire_amulet',
        productId: 1727,
        craftLevel: 24,
        magicLevel: 7,
        members: false,
    },
    amulet_of_defence: {
        key: 'amulet_of_defence',
        gem: 'emerald',
        shape: 'amulet',
        uncutGem: 1621,
        cutGem: 1605,
        mould: 1595,
        jewelleryRecipe: 'unstrung_emerald_amulet',
        mouldedItem: 1677,
        stringRecipe: 'string-emerald-amulet',
        enchantTargetName: 'strung_emerald_amulet',
        enchantTargetId: 1696,
        enchantMode: 'enchant:strung_emerald_amulet',
        productId: 1729,
        craftLevel: 31,
        magicLevel: 27,
        members: false,
    },
    amulet_of_strength: {
        key: 'amulet_of_strength',
        gem: 'ruby',
        shape: 'amulet',
        uncutGem: 1619,
        cutGem: 1603,
        mould: 1595,
        jewelleryRecipe: 'unstrung_ruby_amulet',
        mouldedItem: 1679,
        stringRecipe: 'string-ruby-amulet',
        enchantTargetName: 'strung_ruby_amulet',
        enchantTargetId: 1698,
        enchantMode: 'enchant:strung_ruby_amulet',
        productId: 1725,
        craftLevel: 50,
        magicLevel: 49,
        members: false,
    },
    amulet_of_power: {
        key: 'amulet_of_power',
        gem: 'diamond',
        shape: 'amulet',
        uncutGem: 1617,
        cutGem: 1601,
        mould: 1595,
        jewelleryRecipe: 'unstrung_diamond_amulet',
        mouldedItem: 1681,
        stringRecipe: 'string-diamond-amulet',
        enchantTargetName: 'strung_diamond_amulet',
        enchantTargetId: 1700,
        enchantMode: 'enchant:strung_diamond_amulet',
        productId: 1731,
        craftLevel: 70,
        magicLevel: 57,
        members: false,
    },
    ring_of_life: {
        key: 'ring_of_life',
        gem: 'diamond',
        shape: 'ring',
        uncutGem: 1617,
        cutGem: 1601,
        mould: 1592,
        jewelleryRecipe: 'diamond_ring',
        mouldedItem: 1643,
        enchantTargetName: 'diamond_ring',
        enchantTargetId: 1643,
        enchantMode: 'enchant:diamond_ring',
        productId: 2570,
        craftLevel: 43,
        magicLevel: 57,
        members: true,
    },
    amulet_of_glory: {
        key: 'amulet_of_glory',
        gem: 'dragonstone',
        shape: 'amulet',
        uncutGem: 1631,
        cutGem: 1615,
        mould: 1595,
        jewelleryRecipe: 'unstrung_dragonstone_amulet',
        mouldedItem: 1683,
        stringRecipe: 'string-dragonstone-amulet',
        enchantTargetName: 'strung_dragonstone_amulet',
        enchantTargetId: 1702,
        enchantMode: 'enchant:strung_dragonstone_amulet',
        productId: 1704,
        craftLevel: 80,
        magicLevel: 68,
        members: true,
    },
};

export function planPvpJewelleryChain(
    key: PvpJewelleryKey,
    stock: Record<number, number>,
    levels: { crafting: number; magic: number },
    target: number,
    members = true,
) {
    const spec = PVP_JEWELLERY_PIPELINES[key];
    if (!Number.isSafeInteger(target) || target < 1) throw Error('invalid PvP jewellery target');
    if (levels.crafting < spec.craftLevel) throw Error(`${key} requires Crafting ${spec.craftLevel}, has ${levels.crafting}`);
    if (levels.magic < spec.magicLevel) throw Error(`${key} requires Magic ${spec.magicLevel}, has ${levels.magic}`);
    if (spec.members && !members) throw Error(`${key} requires members world`);
    const enchantRecipe = itemMagicRecipe(spec.enchantMode);
    const haveReadyToEnchant = stock[spec.enchantTargetId] ?? 0;
    const needCraft = Math.max(0, target - haveReadyToEnchant);
    const craftPlan =
        needCraft > 0
            ? planJewelleryOrder(
                  {
                      recipe: spec.jewelleryRecipe,
                      target: needCraft,
                      batch: 13,
                      cap: 1500,
                      returnTicks: 100,
                      reserve: 0,
                      members,
                      stringAmulet: spec.shape === 'amulet',
                      bank: { x: 3269, z: 3167, level: 0 },
                      furnace: { x: 3275, z: 3186, level: 0 },
                  },
                  stock,
                  levels.crafting,
              )
            : { stages: [], delta: {} as Record<number, number>, product: spec.enchantTargetId, floor: {} };
    const runeShortfalls: Record<number, number> = {};
    for (const [idStr, perCast] of Object.entries(enchantRecipe.inputs)) {
        const id = Number(idStr);
        if (id === enchantRecipe.target) continue;
        const need = perCast * target;
        const have = stock[id] ?? 0;
        if (have < need) runeShortfalls[id] = need - have;
    }
    return {
        spec,
        target,
        needCraft,
        craftStages: craftPlan.stages,
        enchantRecipe,
        runeShortfalls,
        canEnchantNow: Object.keys(runeShortfalls).length === 0,
    };
}

// Heroes' Guild basement Fountain of Heroes (m45_154.jm2: 2638 @ 2917,9893,0; fountain_of_heroes.rs2:1-8).
export const FOUNTAIN_OF_HEROES = {
    locId: 2638,
    x: 2917,
    z: 9893,
    level: 0,
    stand: { x: 2918, z: 9894, level: 0 },
} as const;
export const UNCHARGED_GLORY_IDS = [1704, 1706, 1708, 1710] as const;
export const CHARGED_GLORY_ID = 1712;

export async function rechargeGloriesAtFountain(
    s: Pick<Session, 'sdk' | 'bot' | 'tick' | 'onTick'>,
    o: { cap?: number; stop?: () => boolean } = {},
): Promise<{ ok: boolean; recharged: number; remaining: number; ticks: number; failure?: string }> {
    const cap = o.cap ?? 120;
    const stop = o.stop ?? (() => false);
    const start = s.tick();
    const over = () => stop() || s.tick() - start >= cap;
    const unchargedSet = new Set<number>(UNCHARGED_GLORY_IDS);
    const nextUncharged = () => s.sdk.getInventory().find(i => unchargedSet.has(i.id));
    const countCharged = () => s.sdk.getInventory().filter(i => i.id === CHARGED_GLORY_ID).reduce((n, i) => n + i.count, 0);
    const countUncharged = () => s.sdk.getInventory().filter(i => unchargedSet.has(i.id)).reduce((n, i) => n + i.count, 0);
    let recharged = 0;
    let failure = '';
    try {
        while (!over()) {
            const item = nextUncharged();
            if (!item) break;
            const fountain = s.sdk.getState()?.nearbyLocs.find(l => l.id === FOUNTAIN_OF_HEROES.locId || /fountain of heroes/i.test(l.name));
            if (!fountain) throw Error('fountain of heroes not nearby');
            const before = countCharged();
            const used = await s.sdk.sendUseItemOnLoc(item.slot, fountain.x, fountain.z, fountain.id);
            if (!used.success) throw Error(`fountain recharge refused: ${used.message ?? 'unknown'}`);
            const settled = await waitUntil(s, () => countCharged() > before || over(), {
                timeoutTicks: Math.min(8, Math.max(1, cap - (s.tick() - start))),
            });
            if (!settled || countCharged() <= before) throw Error('fountain recharge unobserved');
            recharged += countCharged() - before;
            if (s.sdk.getState()?.dialog?.isOpen) await s.sdk.sendClickDialog(0).catch(() => {});
        }
    } catch (error) {
        failure = String(error);
    }
    const remaining = countUncharged();
    return { ok: !failure && remaining === 0 && recharged > 0, recharged, remaining, ticks: s.tick() - start, failure: failure || undefined };
}

// ---- Legacy Jewelry Crafter (craft-jewelry.ts) ----

export async function runLegacyCraftJewelryCli(
    botName: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
    io?: {
        openBot?: typeof openBot;
        finish?: typeof finish;
        countItems?: typeof countItems;
        waitTicks?: typeof waitTicks;
        waitUntil?: typeof waitUntil;
        walkPath?: typeof walkPath;
        sessionWalker?: typeof sessionWalker;
        session?: Session;
        stop?: () => boolean;
    },
): Promise<{ ok: boolean; crafted: number; ticks: number; summary: string; failure?: string }> {
    const openBotFn = io?.openBot ?? openBot;
    const finishFn = io?.finish ?? finish;
    const countItemsFn = io?.countItems ?? countItems;
    const waitTicksFn = io?.waitTicks ?? waitTicks;
    const waitUntilFn = io?.waitUntil ?? waitUntil;
    const walkPathFn = io?.walkPath ?? walkPath;
    const sessionWalkerFn = io?.sessionWalker ?? sessionWalker;
    const FURNACE_SPOT = { x: 3275, z: 3186 };
    const BANK_SPOT = { x: 3269, z: 3167 };
    const CAP = Number(restArgs[0] ?? env.CAP ?? 15000);
    const ACTION = (restArgs[1] ?? env.ACTION ?? 'cut').toLowerCase();
    const TIER = (restArgs[2] ?? env.TIER ?? 'sapphire').toLowerCase();
    if (!botName) {
        throw Error('Usage: bun scripts/aio-skiller.ts <botName> artisan crafting legacy-jewelry [CAP] [ACTION: cut | smelt | enchant] [TIER]');
    }
    const externalSession = io?.session;
    const s = externalSession ?? (await openBotFn(botName).catch(e => finishFn([], false, `login: ${String(e)}`)));
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    try {
        const inv = () => s.sdk.getInventory();
        const pos = () => s.sdk.getState()?.player;
        const over = () => used() >= CAP || !!io?.stop?.();
        let crafted = 0;
        let bankTrips = 0;
        let walkTicks = 0;
        const findItem = (re: RegExp) => inv().find(i => re.test(i.name));
        const countRe = (re: RegExp) => countItemsFn(s, re);
        const uncutRe = new RegExp(`uncut ${TIER}`, 'i');
        const cutRe = new RegExp(`^${TIER}$`, 'i');
        const walk = async (x: number, z: number, tol = 2): Promise<boolean> => {
            const a = s.tick();
            for (let i = 0; i < 3 && !over(); i++) {
                const p = pos();
                if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
                const r = await walkPathFn(await sessionWalkerFn(s), [{ x, z, tol }], { stop: over });
                if (!r.ok) {
                    console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                    await waitTicksFn(s, 1);
                }
            }
            walkTicks += s.tick() - a;
            const p = pos();
            return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
        };
        const SHAPE = (env.SHAPE ?? 'ring').toLowerCase() === 'amulet' ? 'amulet' : 'ring';
        const bank = async () => {
            await walk(BANK_SPOT.x, BANK_SPOT.z, 2);
            const b = await s.bot.openBank();
            if (!b.success) {
                await waitTicksFn(s, 1);
                return;
            }
            if (ACTION === 'cut') {
                await s.bot.depositItem(cutRe, -1);
                if (!findItem(/^chisel$/i)) await s.bot.withdrawItem(/^chisel$/i, 1);
                await s.bot.withdrawItem(uncutRe, 27);
            } else if (ACTION === 'smelt') {
                await s.bot.depositItem(/ring|amulet|necklace/i, -1);
                const mouldRe = SHAPE === 'amulet' ? /amulet mould/i : /ring mould/i;
                if (!findItem(mouldRe)) await s.bot.withdrawItem(mouldRe, 1);
                await s.bot.withdrawItem(/gold bar/i, 13);
                await s.bot.withdrawItem(cutRe, 13);
            }
            bankTrips++;
            await s.bot.closeInterface();
        };
        console.log(`START jewelry crafter ${botName} action=${ACTION} tier=${TIER} shape=${SHAPE}`);
        if (ACTION === 'enchant') {
            const enchantTarget = SHAPE === 'amulet' ? `strung_${TIER}_amulet` : `${TIER}_ring`;
            const enchantRecipe = itemMagicRecipe(`enchant:${enchantTarget}`);
            const maxCasts = Number(env.MAX_MAKE ?? 1000);
            const r = await runItemMagicBanked(s, enchantRecipe, {
                count: maxCasts,
                cap: Math.max(1, CAP - used()),
                members: env.MEMBERS !== '0',
                stop: over,
            });
            crafted = r.casts;
            const perK = ((crafted * 1000) / Math.max(1, used())).toFixed(2);
            const summary = `ticks=${used()} crafted=${crafted} action=${ACTION} tier=${TIER} shape=${SHAPE} product=${r.product} craftPer1kTicks=${perK}`;
            if (!externalSession) await finishFn([s], r.ok, summary);
            return { ok: r.ok, crafted, ticks: used(), summary, failure: r.ok ? undefined : `legacy-jewelry enchant ${r.stop}` };
        }
        let walkFails = 0;
        while (!over()) {
            if (ACTION === 'cut') {
                const chisel = findItem(/^chisel$/i);
                const uncut = inv().filter(i => uncutRe.test(i.name));
                if (!chisel || uncut.length === 0) {
                    await bank();
                    if (inv().filter(i => uncutRe.test(i.name)).length === 0) {
                        await waitTicksFn(s, 2);
                        continue;
                    }
                }
                const ch = findItem(/^chisel$/i)!;
                const toCut = inv().filter(i => uncutRe.test(i.name));
                const uncutCount = () => inv().filter(i => uncutRe.test(i.name)).reduce((n, i) => n + i.count, 0);
                const before = uncutCount();
                for (const g of toCut) void s.sdk.sendUseItemOnItem(ch.slot, g.slot).catch(() => {});
                await waitUntilFn(s, () => uncutCount() < before, { timeoutTicks: 15 });
                const after = uncutCount();
                const diff = before - after;
                if (diff > 0) crafted += diff;
            } else if (ACTION === 'smelt') {
                const gold = findItem(/gold bar/i);
                const gem = findItem(cutRe);
                if (!gold || !gem) {
                    await bank();
                    if (!findItem(/gold bar/i) || !findItem(cutRe)) {
                        await waitTicksFn(s, 2);
                        continue;
                    }
                }
                const cur = pos();
                if (!cur || Math.max(Math.abs(cur.worldX - FURNACE_SPOT.x), Math.abs(cur.worldZ - FURNACE_SPOT.z)) > 3) {
                    const arrived = await walk(FURNACE_SPOT.x, FURNACE_SPOT.z, 2);
                    if (!arrived) {
                        if (++walkFails >= 5) break;
                        await waitTicksFn(s, 1);
                    } else {
                        walkFails = 0;
                    }
                    continue;
                }
                walkFails = 0;
                const before = countRe(/ring|amulet/i);
                await s.bot.craftJewelry({ product: SHAPE, gem: TIER });
                const made = countRe(/ring|amulet/i) - before;
                if (made > 0) crafted += made;
                else await waitTicksFn(s, 1);
            }
        }
        const perK = ((crafted * 1000) / Math.max(1, used())).toFixed(2);
        const summary = `ticks=${used()} crafted=${crafted} action=${ACTION} tier=${TIER} bankTrips=${bankTrips} craftPer1kTicks=${perK}`;
        if (!externalSession) await finishFn([s], crafted > 0, summary);
        return { ok: crafted > 0, crafted, ticks: used(), summary, failure: crafted > 0 ? undefined : 'legacy-jewelry crafted 0' };
    } catch (e) {
        const msg = String(e);
        if (!externalSession) await finishFn([s], false, msg);
        return { ok: false, crafted: 0, ticks: used(), summary: msg, failure: msg };
    }
}

// ---- Furnace & Banked Glass Supply (microbot-glass.ts) ----

export const furnaceGlassRecipe: InventoryRecipe = {
    name: 'furnace-glass',
    inputs: [{ id: 1783, units: 1 }, { id: 1781, units: 1 }],
    tools: [],
    product: 1775,
    byproducts: [{ id: 1925, units: 1 }],
    skill: 'Crafting',
    level: 1,
    xp: true,
    members: true,
    source: 'vendor/rs-sdk/server/content/scripts/skill_crafting/scripts/glass/glass.rs2',
};

export async function runFurnaceGlass(s: Session, maximum: number, cap: number, stop: () => boolean = () => false) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(cap) || cap < 1) throw Error('invalid glass order');
    const life = watchProductionLife(s, stop);
    const start = s.tick();
    const over = () => life.stopped() || s.tick() - start >= cap;
    const read = (): ProductionSnapshot => {
        const items: Record<number, number> = {};
        for (const i of s.sdk.getInventory()) items[i.id] = (items[i.id] ?? 0) + i.count;
        return { items, xp: s.sdk.getSkillXp('Crafting') ?? 0 };
    };
    let made = 0;
    let failure = '';
    try {
        const initial = read();
        if (furnaceGlassRecipe.inputs.some(i => (initial.items[i.id] ?? 0) < maximum)) throw Error('glass supplies not staged');
        while (made < maximum && !over()) {
            const p = s.sdk.getState()?.player;
            const furnace = s.sdk.getState()?.nearbyLocs.find(l => /^furnace$/i.test(l.name) && l.reachable !== false && l.distance <= 3 && l.level === p?.level);
            if (!furnace) throw Error('stage beside observed native furnace');
            if (s.sdk.getDialog()?.isOpen || s.sdk.getState()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
            const before = read();
            const sand = s.sdk.getInventory().find(i => i.id === 1783);
            if (!sand) throw Error('glass sand missing');
            await s.sdk.sendUseItemOnLoc(sand.slot, furnace.x, furnace.z, furnace.id);
            await waitUntil(s, () => over() || productionEffect(furnaceGlassRecipe, before, read()) !== 'none', {
                timeoutTicks: Math.min(8, Math.max(1, cap - (s.tick() - start))),
            });
            if (productionEffect(furnaceGlassRecipe, before, read()) !== 'made') throw Error('glass ingredient/product/container/XP receipt failed');
            made++;
            if (made < maximum && !over()) await waitTicks(s, 1);
        }
        if (made !== maximum || over()) throw Error('glass target incomplete');
    } catch (e) {
        failure = String(e);
    }
    return { ok: !failure, made, ticks: s.tick() - start, failure: failure || '-', output: 'held molten glass and returned empty buckets; no bank claim' };
}

export type GlassStock = Record<number, number>;
export type GlassSupplyOptions = { maximum: number; cap: number; maxSpend: number; cashReserve: number; members: boolean };
export const GLASS_BANK = { x: 3185, z: 3436 };
export const GLASS_RETURN_BANK = { x: 3092, z: 3243 };
export const GLASS_BEAR = { x: 2809, z: 3376, range: 13 };
export const SEAWEED_TILES = [{ x: 2810, z: 3387 }, { x: 2809, z: 3385 }];
export const GLASS_BEAR_EXIT = { x: 2821, z: 3351 };

export const inGlassBearArea = (p: { x: number; z: number; level: number }) =>
    p.level === 0 && Math.max(Math.abs(p.x - GLASS_BEAR.x), Math.abs(p.z - GLASS_BEAR.z)) <= GLASS_BEAR.range;

export function glassDamageTolerated(r: { hp: number; initialHp: number; alive: boolean; sameLife: boolean; at: { x: number; z: number; level: number } }) {
    return r.alive && r.sameLife && r.hp > 0 && r.hp >= Math.ceil(r.initialHp / 2) && inGlassBearArea(r.at);
}

export function glassSupplyOptions(env: Record<string, string | undefined>): GlassSupplyOptions {
    const o = {
        maximum: Number(env.MAX_MAKE ?? 1),
        cap: Number(env.CAP ?? 4000),
        maxSpend: Number(env.MAX_SPEND ?? 0),
        cashReserve: Number(env.CASH_RESERVE ?? 0),
        members: env.MEMBERS === '1',
    };
    if (!Number.isSafeInteger(o.maximum) || o.maximum < 1 || o.maximum > 10 || !Number.isSafeInteger(o.cap) || o.cap < 1 || ![o.maxSpend, o.cashReserve].every(n => Number.isSafeInteger(n) && n >= 0)) {
        throw Error('invalid glass supply bounds');
    }
    return o;
}

export function planGlassSupply(stock: GlassStock, maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10) throw Error('invalid glass supply target');
    const make = Math.max(0, maximum - (stock[1775] ?? 0));
    const sand = Math.min(make, stock[1783] ?? 0);
    const ash = Math.min(make, stock[1781] ?? 0);
    const cook = make - ash;
    return {
        make,
        sand,
        ash,
        fill: make - sand,
        cook,
        seaweed: Math.min(cook, stock[401] ?? 0),
        gatherSeaweed: Math.max(0, cook - (stock[401] ?? 0)),
        gatherBucket: make > sand && sand === 0 && (stock[1925] ?? 0) < 1 ? 1 : 0,
    };
}

export function glassSupplyLedger(
    before: GlassStock,
    after: GlassStock,
    r: { made: number; filled: number; cooked: number; seaweed: number; buckets: number; spent: number },
    o: GlassSupplyOptions,
) {
    const delta: GlassStock = {
        1775: r.made,
        1783: r.filled - r.made,
        1781: r.cooked - r.made,
        401: r.seaweed - r.cooked,
        1925: r.buckets + r.made - r.filled,
        995: -r.spent,
    };
    return (
        Number.isSafeInteger(r.spent) &&
        r.spent === 0 &&
        r.spent <= o.maxSpend &&
        (after[995] ?? 0) >= Math.min(o.cashReserve, before[995] ?? 0) &&
        [...new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(delta)])].every(k => (after[+k] ?? 0) - (before[+k] ?? 0) === (delta[+k] ?? 0))
    );
}

export interface GlassSupplyIO {
    tick(): number;
    check(): void;
    bank(): Promise<GlassStock>;
    take(id: number, n: number): Promise<void>;
    close(): Promise<void>;
    gather(id: number, n: number): Promise<void>;
    island(): Promise<void>;
    fill(): Promise<void>;
    cook(n: number): Promise<void>;
    smelt(n: number): Promise<number>;
    returnBank(): Promise<void>;
}

export async function runGlassSupply(d: GlassSupplyIO, o: GlassSupplyOptions) {
    const start = d.tick();
    let made = 0;
    let filled = 0;
    let cooked = 0;
    let seaweed = 0;
    let buckets = 0;
    let banked = 0;
    let conserved = false;
    let failure = '';
    const check = () => {
        d.check();
        if (d.tick() - start >= o.cap) throw Error('glass supply CAP reached');
    };
    try {
        if (!o.members) throw Error('glass supply refused: MEMBERS=1 required');
        check();
        const before = await d.bank();
        const p = planGlassSupply(before, o.maximum);
        check();
        console.log('GLASS_SUPPLY_PLAN ' + JSON.stringify({ target: o.maximum, ...p, spent: 0, maxSpend: o.maxSpend, cashReserve: o.cashReserve }));
        if (p.make) {
            await d.take(1783, p.sand);
            await d.take(1781, p.ash);
            await d.take(401, p.seaweed);
            if (p.fill && p.sand === 0 && !p.gatherBucket) await d.take(1925, 1);
            await d.close();
            check();
            if (p.gatherBucket) {
                await d.gather(1925, 1);
                buckets = 1;
                check();
            }
            await d.island();
            check();
            if (p.gatherSeaweed) {
                await d.gather(401, p.gatherSeaweed);
                seaweed = p.gatherSeaweed;
                check();
            }
            if (p.cook) {
                await d.cook(p.cook);
                cooked = p.cook;
                check();
            }
            for (let i = 0; i < p.make; i++) {
                check();
                if (i >= p.sand) {
                    await d.fill();
                    filled++;
                    check();
                }
                if ((await d.smelt(1)) !== 1) throw Error('glass supply furnace shortfall');
                made++;
                check();
            }
            await d.returnBank();
            check();
        }
        const after = await d.bank();
        check();
        banked = after[1775] ?? 0;
        conserved = glassSupplyLedger(before, after, { made, filled, cooked, seaweed, buckets, spent: 0 }, o);
        if (!conserved) throw Error('glass supply assets/costs/buckets do not reconcile');
        if (banked < o.maximum || made !== p.make) throw Error('glass supply bank target unobserved');
        await d.close();
        check();
    } catch (e) {
        failure = String(e);
    }
    return { ok: !failure, target: o.maximum, made, filled, cooked, seaweed, buckets, spent: 0, banked, conserved, ticks: d.tick() - start, failure: failure || '-', output: 'banked molten glass for finite named consumer' };
}

export async function runBankedGlass(s: Session, o: GlassSupplyOptions, stop: () => boolean = () => false) {
    const start = s.tick();
    const ac = new AbortController();
    const parent = executionContext.getStore();
    let life = watchProductionLife(s, stop);
    const first = s.sdk.getState()?.player;
    const initialHp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const here = () => {
        const p = s.sdk.getState()?.player;
        return { x: p?.worldX ?? 0, z: p?.worldZ ?? 0, level: p?.level ?? -1 };
    };
    const check = () => {
        let why = life.reason();
        if (why === 'damage observed') {
            const p = s.sdk.getState()?.player;
            const hp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
            if (glassDamageTolerated({ hp, initialHp, alive: !!p && !p.isDead, sameLife: !!p && p.lifeId === first?.lifeId && (p.respawnCount ?? 0) === (first?.respawnCount ?? 0), at: here() })) {
                console.log('GLASS_SUPPLY_DAMAGE ' + JSON.stringify({ hp, initialHp, at: here() }));
                life = watchProductionLife(s, stop);
                why = '';
            }
        }
        if (why) throw Error('glass supply ' + why);
        if (s.tick() - start >= o.cap) throw Error('glass supply CAP reached');
        ac.signal.throwIfAborted();
    };
    const guard = () => {
        try {
            check();
        } catch (e) {
            ac.abort(e);
        }
    };
    const off = s.onTick(guard);
    const cancel = () => ac.abort(parent?.signal.reason);
    parent?.signal.addEventListener('abort', cancel, { once: true });
    if (parent?.signal.aborted) cancel();
    const inv = () => s.sdk.getInventory();
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const wait = async (test: () => boolean, n = 12) => {
        check();
        if (!await waitUntil(s, test, { timeoutTicks: Math.min(n, o.cap - (s.tick() - start)), signal: ac.signal })) throw Error('glass supply effect deadline');
        check();
    };
    const close = async () => {
        check();
        await s.sdk.sendCloseModal();
        await wait(() => !s.sdk.getState()?.bank.isOpen && !s.sdk.getState()?.interface?.isOpen && !s.sdk.getDialog()?.isOpen);
    };
    const walk = async (to: { x: number; z: number; level?: number }) => {
        check();
        if (to.level && to.level !== s.sdk.getState()?.player?.level) throw Error('glass supply walk floor');
        const r = await walkPath(await sessionWalker(s), [{ x: to.x, z: to.z, tol: 1 }], { maxTicks: Math.min(700, o.cap - (s.tick() - start)), stop: () => ac.signal.aborted });
        check();
        const p = s.sdk.getState()?.player;
        if (!r.ok || !p || p.level !== 0 || Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) > 1) {
            throw Error('glass supply travel failed ' + JSON.stringify({ to, r }));
        }
        console.log('GLASS_SUPPLY_ARRIVE ' + JSON.stringify(to));
        return { ok: true };
    };
    const deposit = async () => {
        for (let tries = 0; inv().length && tries < 60; tries++) {
            check();
            const item = inv()[0]!;
            const n = held(item.id);
            const b = s.sdk.getBankItems().filter(i => i.id === item.id).reduce((v, i) => v + i.count, 0);
            await s.bot.depositItem(item, -1);
            await wait(() => held(item.id) === 0 && s.sdk.getBankItems().filter(i => i.id === item.id).reduce((v, i) => v + i.count, 0) === b + n);
        }
        if (inv().length) throw Error('glass supply inventory not banked');
    };
    const bank = async () => {
        check();
        if (!(await s.bot.openBank()).success) throw Error('glass supply ordinary bank unavailable');
        await wait(() => s.sdk.isBankOpen());
        await deposit();
        const equipment = s.sdk.getEquipment();
        if (equipment.length) {
            await close();
            for (const item of equipment) {
                check();
                await s.bot.unequipItem(item.name);
                await wait(() => !s.sdk.getEquipment().some(i => i.id === item.id));
            }
            check();
            if (!(await s.bot.openBank()).success) throw Error('glass supply kit bank unavailable');
            await wait(() => s.sdk.isBankOpen());
            await deposit();
        }
        await wait(() => !!s.bankObservation?.());
        const observed = s.bankObservation?.();
        if (!observed) throw Error('glass supply fresh bank unobserved');
        const stock: GlassStock = {};
        for (const i of observed.items) stock[i.id] = (stock[i.id] ?? 0) + i.count;
        return stock;
    };
    const take = async (id: number, n: number) => {
        if (!n) return;
        check();
        const row = s.sdk.getBankItems().find(i => i.id === id);
        const b = held(id);
        if (!row || row.count < n) throw Error('glass supply bank short ' + id);
        await s.bot.withdrawItem(row, n, { asNote: false });
        await wait(() => held(id) === b + n);
    };
    const gatherSeaweed = async (n: number) => {
        await walk(SEAWEED_TILES[0]!);
        for (let got = 0; got < n; got++) {
            const before = held(401);
            const spot = () => s.sdk.getState()?.groundItems.find(i => i.id === 401 && SEAWEED_TILES.some(t => t.x === i.x && t.z === i.z));
            await wait(() => !!spot(), 200);
            const item = spot()!;
            check();
            await s.bot.pickupItem(item);
            await wait(() => held(401) === before + 1, 20);
        }
    };
    const gather = async (id: number, n: number) => {
        check();
        if (id === 401) return gatherSeaweed(n);
        await walk({ x: 3026, z: 3289 });
        const before = held(id);
        const why = await gatherItems(s, await getWorld(), [{ id, count: n, how: 'spawn' }], async at => {
            check();
            if (!(at.level === 0 && at.x >= 3020 && at.x <= 3026 && at.z >= 3289 && at.z <= 3291)) {
                return { ok: false, reason: 'outside pinned supply spawn area' };
            }
            return walk(at);
        });
        check();
        if (why || held(id) !== before + n) throw Error('glass supply acquisition ' + (why ?? 'wrong item delta'));
    };
    const island = async () => {
        await walk({ x: 3046, z: 3236 });
        check();
        const r = await sail(s, { npc: /^monk of entrana$/i, choices: [/^yes, okay/i], deck: { x: 2834, z: 3331 }, attempts: 2, converseTicks: 80, stop: () => ac.signal.aborted, deadline: start + o.cap, before: check });
        if (!r.ok) throw Error('glass supply outward boat ' + r.detail);
        if (!(await disembark(s, { stop: () => ac.signal.aborted, deadline: start + o.cap, before: check })).ok) throw Error('glass supply outward gangplank');
        check();
    };
    const fill = async () => {
        await close();
        await walk({ x: 2815, z: 3341 });
        const b = held(1925);
        const sand = held(1783);
        const item = inv().find(i => i.id === 1925);
        const pit = s.sdk.getState()?.nearbyLocs.find(l => l.id === 2645 && l.x === 2816 && l.z === 3341);
        if (!item || !pit) throw Error('glass supply bucket/pinned sandpit missing');
        check();
        await s.sdk.sendUseItemOnLoc(item.slot, pit.x, pit.z, pit.id);
        await wait(() => held(1925) === b - 1 && held(1783) === sand + 1);
    };
    const cook = async (n: number) => {
        await close();
        await walk({ x: 2821, z: 3351 });
        const recipe = cookingRecipes().recipes.find(r => r.raw === 401 && r.products.includes(1781));
        if (!recipe) throw Error('glass supply pinned ash recipe missing');
        const r = await runCookingBatch(
            {
                state: () => s.sdk.getState(),
                tick: () => s.tick(),
                stop: () => ac.signal.aborted,
                close,
                step: () => waitTicks(s, 1),
                wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks, signal: ac.signal }),
                heat: async slot => {
                    check();
                    const loc = s.sdk.getState()?.nearbyLocs.find(l => l.id === 2728 && l.x === 2822 && l.z === 3351 && l.distance <= 3);
                    if (!loc) throw Error('glass supply pinned range missing');
                    return (await s.sdk.sendUseItemOnLoc(slot, loc.x, loc.z, loc.id)).success;
                },
            },
            recipe,
            { maximum: n, cap: Math.max(1, o.cap - (s.tick() - start)), heat: 'range', expectedProduct: 1781 },
        );
        if (r.cooked !== n || r.burnt) throw Error('glass supply ash conversion incomplete');
        check();
    };
    const smelt = async (n: number) => {
        await close();
        await walk({ x: 2832, z: 3351 });
        const r = await runFurnaceGlass(s, n, Math.max(1, o.cap - (s.tick() - start)), () => ac.signal.aborted);
        check();
        if (!r.ok) throw Error(r.failure);
        return r.made;
    };
    const returnBank = async () => {
        await close();
        await walk({ x: 2830, z: 3335 });
        const r = await sail(s, { npc: /^monk of entrana$/i, choices: [/^yes, i'm ready/i], deck: { x: 3048, z: 3231 }, attempts: 2, converseTicks: 80, stop: () => ac.signal.aborted, deadline: start + o.cap, before: check });
        if (!r.ok) throw Error('glass supply return boat ' + r.detail);
        if (!(await disembark(s, { stop: () => ac.signal.aborted, deadline: start + o.cap, before: check })).ok) throw Error('glass supply return gangplank');
        await walk(GLASS_RETURN_BANK);
    };
    const leaveBear = async () => {
        const p = s.sdk.getState()?.player;
        if (!p || p.isDead || !inGlassBearArea(here()) || parent?.signal.aborted) return;
        const t = s.tick();
        const r = await walkPath(await sessionWalker(s), [{ ...GLASS_BEAR_EXIT, tol: 1 }], { maxTicks: 100, stop: () => s.tick() - t >= 100 || !!parent?.signal.aborted }).catch(e => ({
            ok: false,
            error: String(e),
        }));
        console.log('GLASS_SUPPLY_LEAVE_BEAR ' + JSON.stringify({ ok: r.ok, at: here() }));
    };
    let result: { ok: boolean; failure: string; ticks: number } & Record<string, unknown>;
    try {
        result = await executionContext.run({ ...parent, signal: ac.signal }, () =>
            abortable(runGlassSupply({ tick: () => s.tick(), check, bank, take, close, gather, island, fill, cook, smelt, returnBank }, o)),
        );
    } catch (e) {
        result = { ok: false, failure: String(e), ticks: s.tick() - start };
    } finally {
        off();
        parent?.signal.removeEventListener('abort', cancel);
    }
    if (!result.ok) await leaveBear();
    return result;
}

export async function runGlassCli(
    botName: string,
    _restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
) {
    const supply = env.SUPPLY_MODE === '1';
    let stopped = false;
    const maximum = Number(env.MAX_MAKE ?? 1);
    const cap = Number(env.CAP ?? 200);
    if (!supply && env.MEMBERS !== '1') throw Error('furnace glass requires explicit MEMBERS=1 scope');
    const s = await openBot(botName, { onStop: async () => { stopped = true; } });
    const stop = () => stopped || existsSync('.practice/stop-all') || existsSync(`.practice/stop-${s.name}`);
    try {
        const result = supply ? await runBankedGlass(s, glassSupplyOptions(env), stop) : await runFurnaceGlass(s, maximum, cap, stop);
        if (supply) console.log('GLASS_SUPPLY_RESULT ' + JSON.stringify(result));
        await finish([s], result.ok, JSON.stringify(result));
    } catch (e) {
        await finish([s], false, String(e));
    }
}

// ---- Unified Crafting CLI Router ----

export async function runCraftingCli(
    method: string,
    botName: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
    deps?: ArtisanExternalDeps,
) {
    if (method === 'bowstrings') return runSpinBowstrings(botName, restArgs, env);
    if (method === 'jewellery') return runJewelleryCli(botName, restArgs, env);
    if (method === 'jewellery-trip') return runJewelleryTripCli(botName, restArgs, env, deps);
    if (method === 'legacy-jewelry') return runLegacyCraftJewelryCli(botName, restArgs, env);
    if (method === 'glass') return runGlassCli(botName, restArgs, env);
    if (method === 'tanning') return runTanningCli(botName, restArgs);
    if (method === 'black-dhide-sets') return runBlackDhideSetsCli(botName, restArgs, env, deps);
    if (method === 'soften-clay') return runSoftenClayCli(botName, restArgs, env);
    if (method === 'progressive') return runProgressiveProductionCli(botName, restArgs, deps);
    return runProductionCli(botName, restArgs, env);
}
