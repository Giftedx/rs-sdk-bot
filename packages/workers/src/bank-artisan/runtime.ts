// Shared session, life/stop guards, bank-trip runners, and LiteClient bridges for bank-artisan workers.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../../../core/src/inprocess';
import { finish, logoutSession } from '../../../core/src/bot';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { sessionWalker, walkPath } from '../../../core/src/walk';
import { depositObserved } from '../../../core/src/deposit';
import {
    bankTravelTolerance,
    fittingBankBatch,
    validateBankRouteJob,
    type BankProfile,
    type BankRouteJob,
    type Tile,
} from '../../../core/src/bank-trip';
import { knownBanks } from '../../../core/src/trip';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import { isItemStackable, REPO_ROOT } from './catalog';

export type BankSpot = Tile;
export const BANKS: readonly BankSpot[] = knownBanks();
export const COW_NORTH_BANK = { x: 2619, z: 3332 };

export const atNorthBank = (p: { worldX: number; worldZ: number; level: number } | null | undefined) =>
    !!p && p.level === 0 && Math.max(Math.abs(p.worldX - COW_NORTH_BANK.x), Math.abs(p.worldZ - COW_NORTH_BANK.z)) <= 3;

export function nearestBank(at: { x: number; z: number; level: number }): BankSpot {
    return (
        BANKS.filter(b => b.level === at.level)
            .sort((a, b) => Math.max(Math.abs(a.x - at.x), Math.abs(a.z - at.z)) - Math.max(Math.abs(b.x - at.x), Math.abs(b.z - at.z)))[0]
        ?? BANKS[0]!
    );
}

export function productionStopRequested(
    actor: string | undefined,
    stop: () => boolean = () => false,
    exists: (path: string) => boolean = existsSync,
    role: string | undefined = process.env.STOP_FILE,
): boolean {
    return stop() || exists('.practice/stop-all') || (!!actor && exists(`.practice/stop-${actor}`)) || (!!role && exists(role));
}

export function watchProductionLife(s: Session, stop: () => boolean = () => false, options: { allowDamage?: boolean } = {}) {
    const allowDamage = options.allowDamage === true;
    const initial = s.sdk.getState()?.player;
    const initialHp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    if (!initial || initialHp <= 0 || (allowDamage && !Number.isFinite(initialHp))) {
        throw Error('production life unobserved');
    }
    const initialRespawns = initial.respawnCount ?? 0;
    const initialLife = initial.lifeId;
    let ended = false;
    let why = '';
    void s.ended?.then(() => { ended = true; });
    const reason = () => {
        const p = s.sdk.getState()?.player;
        const hp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
        if (why) return why;
        if (ended) why = 'session ended';
        else if (productionStopRequested(s.name, stop)) why = 'stop requested';
        else if (!p || hp <= 0 || p.isDead || (allowDamage && !Number.isFinite(hp))) why = 'dead or player unavailable';
        else if (
            (allowDamage ? (p.respawnCount ?? 0) !== initialRespawns : (p.respawnCount ?? 0) > initialRespawns)
            || (initialLife !== undefined && p.lifeId !== initialLife)
        ) {
            why = 'life changed';
        } else if (!allowDamage && hp < initialHp) {
            why = 'damage observed';
        }
        return why;
    };
    return { reason, stopped: () => !!reason() };
}

export function actionSessionOwner(
    raw: Session,
    stop: () => boolean = () => false,
    exists: (path: string) => boolean = existsSync,
    options: { allowDamage?: boolean } = {},
) {
    const allowDamage = options.allowDamage === true;
    const client = raw.client as { executeBotAction?: unknown; selfSlot?: number } | undefined;
    const sdk = raw.sdk;
    const config = sdk.config;
    const origin = JSON.stringify([config?.gatewayUrl, config?.host, config?.port]);
    const player = raw.sdk.getState()?.player;
    const life = player?.lifeId;
    const respawns = player?.respawnCount ?? 0;
    const self = client?.selfSlot;
    const hp0 = raw.sdk.getSkill('Hitpoints')?.level ?? 0;
    let ended = false;
    let executor = client?.executeBotAction;
    void raw.ended?.then(() => { ended = true; });
    const identity = () =>
        !!client
        && raw.client === client
        && client.executeBotAction === executor
        && client.selfSlot === self
        && raw.sdk === sdk
        && sdk.config === config
        && JSON.stringify([config?.gatewayUrl, config?.host, config?.port]) === origin;
    const own = () => {
        const now = sdk.getState()?.player;
        const hp = sdk.getSkill('Hitpoints')?.level ?? 0;
        return (
            (!allowDamage || (Number.isFinite(hp0) && hp0 > 0 && Number.isFinite(hp) && hp > 0))
            && identity()
            && !ended
            && !!player
            && Number.isSafeInteger(life)
            && typeof executor === 'function'
            && Number.isSafeInteger(self)
            && !!now
            && !now.isDead
            && now.lifeId === life
            && (now.respawnCount ?? 0) === respawns
        );
    };
    const sameLife = () => {
        const now = sdk.getState()?.player;
        return !now || (now.lifeId === life && (now.respawnCount ?? 0) === respawns);
    };
    const lifeWatch = watchProductionLife(raw, stop, options);
    const stopped = () =>
        !own()
        || lifeWatch.stopped()
        || productionStopRequested(raw.name, stop, exists)
        || hp0 <= 0
        || (!allowDamage && (sdk.getSkill('Hitpoints')?.level ?? 0) < hp0);
    const view = (cleanup: boolean) => {
        const guard = () => {
            if (cleanup ? !own() : stopped()) throw Error('action original session owner unavailable');
        };
        const proxy = new Proxy(sdk, {
            get(t, k, r) {
                const v = Reflect.get(t, k, r);
                return typeof v === 'function'
                    ? function (this: unknown, ...args: unknown[]) {
                        if (typeof k === 'string' && k.startsWith('send')) guard();
                        return v.apply(r, args);
                    }
                    : v;
            },
        });
        const s = Object.create(raw) as Session;
        Object.defineProperties(s, {
            sdk: { value: proxy },
            bot: { value: new BotActions(proxy) },
            direct: {
                value: (a: Parameters<Session['direct']>[0]) => {
                    guard();
                    return raw.direct(a);
                },
            },
        });
        return s;
    };
    const guard = () => {
        if (stopped()) throw Error('action original session owner unavailable');
    };
    return {
        raw,
        identity,
        own,
        stopped,
        guard,
        session: view(false),
        cleanup: view(true),
        sameLife,
        settled: () => {
            executor = client?.executeBotAction;
        },
    };
}

export async function finishActionSession(
    owner: ReturnType<typeof actionSessionOwner> | undefined,
    ok: boolean,
    detail: string,
    settle: (sessions: Session[], ok: boolean, detail: string, opts?: { logout?: (raw: Session) => Promise<string> }) => Promise<unknown> = finish,
    logout: (session: Session) => Promise<string> = logoutSession,
) {
    const defer = () => {
        console.log('ACTION_SETTLEMENT_DEFERRED ' + detail);
        process.exitCode = 1;
        return { ok: false, recoveryDeferred: true };
    };
    if (!owner) return settle([], ok, detail);
    if (!owner.own()) return defer();
    try {
        return await settle([owner.raw], ok, detail, {
            logout: async raw => {
                owner.settled();
                if (raw !== owner.raw || !owner.own()) throw Error('action original settlement owner unavailable');
                const out = await logout(owner.cleanup);
                if (out !== 'logged-out' || !owner.identity() || !owner.sameLife()) throw Error('action owned logout unconfirmed');
                return out;
            },
        });
    } catch {
        return defer();
    }
}

// Native LiteClient bridge for OPLOCT = 218 (missing SDK spell-on-location action).
export function spellOnNativeLoc(client: unknown, x: number, z: number, locId: number, spellComponent: number) {
    const c = client as any;
    if (![x, z, locId, spellComponent].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 65535)) throw Error('invalid spell location');
    if (
        !c
        || typeof c.toSceneTile !== 'function'
        || typeof c.routeToLoc !== 'function'
        || typeof c.locSceneInfo !== 'function'
        || typeof c.writeOpcode !== 'function'
        || typeof c.out?.p2 !== 'function'
    ) {
        throw Error('spell-on-location requires native LiteClient');
    }
    if (!c.isInGame() || !c.localPlayer) throw Error('spell-on-location not in game');
    const dest = c.toSceneTile(x, z);
    if (!dest || !c.locSceneInfo(dest.x, dest.z, locId)) throw Error('spell-on-location target absent from scene');
    const routed = c.routeToLoc(dest.x, dest.z, locId);
    c.writeOpcode(218);
    c.out.p2(x);
    c.out.p2(z);
    c.out.p2(locId);
    c.out.p2(spellComponent);
    return { success: true, routed };
}

export function installSpellLocBridge(client: unknown) {
    const c = client as any;
    if (!c || typeof c.executeBotAction !== 'function') throw Error('spell-on-location native executor unavailable');
    const original = c.executeBotAction;
    const bridge = function (this: unknown, action: any) {
        return action?.type === 'spellOnLoc' ? spellOnNativeLoc(c, action.x, action.z, action.locId, action.spellComponent) : original.call(c, action);
    };
    c.executeBotAction = bridge;
    return () => { if (c.executeBotAction === bridge) c.executeBotAction = original; };
}

// Core-backed standalone BankProfile executor (fallback when external deps.runBankProfile is omitted).
export async function runArtisanBankProfile(
    s: Session,
    j: BankRouteJob,
    p: BankProfile,
    requestStop: () => boolean = () => false,
): Promise<{ ok: boolean; completed: number; trips: number; atBank: boolean; failure: string; ticks: number }> {
    validateBankRouteJob(j);
    const start = s.tick();
    const stop = () => productionStopRequested(s.name, requestStop) || s.tick() - start >= j.cap;
    const inv = () => s.sdk.getInventory();
    const bankItems = () => s.bankObservation?.()?.items ?? [];
    const countInv = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const countBank = (id: number) => bankItems().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const at = (tile: Tile, tol = 2) => {
        const pos = s.sdk.getState()?.player;
        return !!pos && pos.level === tile.level && Math.max(Math.abs(pos.worldX - tile.x), Math.abs(pos.worldZ - tile.z)) <= tol;
    };
    const walkTile = async (tile: Tile, tol = 1, budget = Math.max(10, j.cap - (s.tick() - start))) => {
        if (at(tile, tol)) return true;
        const res = await walkPath(await sessionWalker(s), [{ ...tile, tol }], { maxTicks: budget, stop });
        return res.ok && at(tile, tol);
    };
    const openFreshBank = async () => {
        if (!await walkTile(p.bank, bankTravelTolerance(j.family, false) + 2)) throw Error('failed to reach bank');
        const gen = s.bankObservation?.()?.generation ?? 0;
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen, { timeoutTicks: 15 })) {
            throw Error('bank did not open');
        }
    };
    const depositOutputs = async () => {
        const keep = new Set(p.tools);
        for (const row of [...inv()]) {
            if (keep.has(row.id) || (row.id in p.inputs && countInv(row.id) > 0)) continue;
            if (inv().some(i => i.id === row.id)) await depositObserved(s, row);
        }
    };

    let completed = 0;
    let trips = 0;
    let failure = '';
    try {
        while (completed < j.target && !stop()) {
            const remTicks = j.cap - (s.tick() - start);
            if (remTicks <= j.returnTicks) break;
            await openFreshBank();
            await depositOutputs();
            for (const tool of p.tools) {
                if (countInv(tool) > 0) continue;
                const row = bankItems().find(i => i.id === tool);
                if (!row || !(await s.bot.withdrawItem(row.id, 1, { asNote: false })).success || !await waitUntil(s, () => countInv(tool) >= 1, { timeoutTicks: 8 })) {
                    throw Error(`missing bank tool ${tool}`);
                }
            }
            const free = Math.max(0, 28 - inv().length);
            const batch = Math.min(
                j.target - completed,
                fittingBankBatch(p.inputs, p.tools, j.batch, free, isItemStackable, p.outputs),
            );
            if (batch < 1) throw Error('no fitting bank batch capacity');
            for (const [idStr, perUnit] of Object.entries(p.inputs)) {
                const id = Number(idStr);
                const need = batch * perUnit - countInv(id);
                if (need <= 0) continue;
                const avail = countBank(id) - (j.reserve ?? 0);
                if (avail < need) throw Error(`short bank input ${id}: need ${need}, available ${Math.max(0, avail)}`);
                const row = bankItems().find(i => i.id === id);
                if (!row || !(await s.bot.withdrawItem(row.id, need, { asNote: false })).success || !await waitUntil(s, () => countInv(id) >= batch * perUnit, { timeoutTicks: 8 })) {
                    throw Error(`withdraw input ${id} failed`);
                }
            }
            await s.bot.closeBank();
            await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 6 });
            if (p.site.x !== p.bank.x || p.site.z !== p.bank.z || p.site.level !== p.bank.level) {
                if (!await walkTile(p.site, bankTravelTolerance(j.family, true))) throw Error('failed to reach production site');
            }
            const made = (await p.run(batch, Math.max(1, j.cap - (s.tick() - start) - j.returnTicks), stop)) ?? batch;
            completed += made;
            trips++;
            await openFreshBank();
            await depositOutputs();
            for (const idStr of Object.keys(p.inputs)) {
                const id = Number(idStr);
                const left = inv().find(i => i.id === id);
                if (left) await depositObserved(s, left);
            }
            await s.bot.closeBank();
            await waitTicks(s, 1);
            if (made === 0) break;
        }
    } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
    } finally {
        try {
            if (!s.sdk.getState()?.bank?.isOpen && at(p.bank, 4)) {
                await openFreshBank();
                await depositOutputs();
                await s.bot.closeBank();
            }
        } catch {
            // Preserve original error
        }
    }
    const atBank = at(p.bank, 4);
    const ok = !failure && completed >= j.target && atBank;
    return { ok, completed, trips, atBank, failure: failure || '-', ticks: s.tick() - start };
}

export function resolveArgSetting(args: readonly string[], env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
    if (env[key] !== undefined && env[key] !== '') return env[key];
    const hit = args.find(a => a.startsWith(`${key}=`));
    return hit ? hit.slice(key.length + 1) : undefined;
}

export function readJobJson(arg: string): Record<string, unknown> {
    if (arg.startsWith('--job=')) return JSON.parse(decodeURIComponent(arg.slice(6)));
    return JSON.parse(readFileSync(arg.startsWith('.') || arg.startsWith('/') || /^[A-Za-z]:/.test(arg) ? arg : join(REPO_ROOT, arg), 'utf8'));
}
