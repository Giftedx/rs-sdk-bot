import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from './inprocess';
import { ownedAccounts } from './tradeguard';
import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';
import { AsyncLocalStorage } from 'node:async_hooks';
import { bindActionScope } from './action-scope';
import { simBotsDir } from './practice-paths';

const cargoRepoRoot = resolve(import.meta.dir, '../../..');
export const cargoDir = resolve(import.meta.dir, '../../../.practice/cargo');
export const exactItem = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
export interface Cargo { name: string; server?: string; at: number; bank: { x: number; z: number; level: number }; items: { id: number; name: string; count: number }[] }
export interface CargoRequest { worker: string; courier: string; server?: string; at: number; ready?: boolean }
export type CargoOptions = { dir?: string; owned?: ReadonlySet<string>; server?: string; stopped?: () => boolean };

// A caller without a Session can inspect configuration, but only authenticated
// ownership on that endpoint grants a request. A live Session's endpoint wins.
export function cargoAccountServer(name: string): string {
    if (!/^[A-Za-z0-9_ -]{1,12}$/.test(name)) throw Error('cargo: invalid account name');
    const lower = name.toLowerCase();
    for (const dir of [simBotsDir(cargoRepoRoot), resolve(import.meta.dir, '../../../vendor/rs-sdk/bots')]) {
        if (!existsSync(dir)) continue;
        const matches = readdirSync(dir).filter(candidate => candidate.toLowerCase() === lower && existsSync(join(dir, candidate, 'bot.env')));
        if (matches.length > 1) throw Error('cargo: unique account configuration required for ' + name);
        if (matches.length === 1) {
            const env = readFileSync(join(dir, matches[0]!, 'bot.env'), 'utf8');
            return env.match(/^SERVER=(.*)$/m)?.[1]?.trim() || 'localhost:8888';
        }
    }
    throw Error('cargo: unique account configuration required for ' + name);
}
function cargoServer(name: string, options: CargoOptions, actual?: string): string | undefined {
    if (actual && options.server && actual.toLowerCase() !== options.server.toLowerCase()) throw Error('cargo: session endpoint mismatch');
    return actual ?? options.server ?? (options.owned ? undefined : cargoAccountServer(name));
}
// Like a resumable bank operation's cursor, this records an attempted request
// before any withdrawal. It is not a transfer receipt or permission to retry an
// uncertain trade. A newer demand token is required after restart too.
function lastAttempt(dir: string, worker: string): number {
    let raw: string;
    try { raw = readFileSync(join(dir, `attempt-${worker.toLowerCase()}.json`), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
    const value = JSON.parse(raw);
    if (value?.version !== 1 || value.phase !== 'attempted' || typeof value.worker !== 'string'
        || value.worker.toLowerCase() !== worker.toLowerCase() || typeof value.courier !== 'string'
        || !Number.isSafeInteger(value.at) || value.at <= 0) throw Error(`cargo request history invalid: ${worker}`);
    return value.at;
}

function recordAttempt(dir: string, req: CargoRequest): void {
    const file = join(dir, `attempt-${req.worker.toLowerCase()}.json`), temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, phase: 'attempted', worker: req.worker, courier: req.courier, at: req.at }));
    renameSync(temp, file);
}

export function validCargoRequest(value: unknown, worker: string, owned: ReadonlySet<string>, now = Date.now(), server?: string): value is CargoRequest {
    const req = value as CargoRequest | null;
    return !!req && typeof req.worker === 'string' && req.worker.toLowerCase() === worker.toLowerCase()
        && typeof req.courier === 'string' && owned.has(req.courier.toLowerCase())
        && (server === undefined || typeof req.server === 'string' && req.server.toLowerCase() === server.toLowerCase())
        && req.courier.toLowerCase() !== worker.toLowerCase()
        && Number.isSafeInteger(req.at) && req.at > 0 && req.at <= now && now - req.at < 180_000;
}

export function courierWaiting(name: string, options: CargoOptions = {}): boolean {
    try {
        const server = cargoServer(name, options);
        const req = JSON.parse(readFileSync(join(options.dir ?? cargoDir, `request-${name}.json`), 'utf8'));
        return validCargoRequest(req, name, options.owned ?? ownedAccounts(server!), Date.now(), server) && req.ready === true
            && lastAttempt(options.dir ?? cargoDir, name) < req.at;
    } catch { return false; }
}

const activeCargo = new WeakSet<object>();
type CargoExecution = { scope: symbol; phase: 'work' | 'cleanup'; controller: AbortController; open: boolean };
const cargoExecution = new AsyncLocalStorage<CargoExecution>();
const cargoTerminals = new WeakMap<object, { ended: boolean }>();
function cargoTerminal(ended: Promise<unknown>) {
    let terminal = cargoTerminals.get(ended);
    if (!terminal) {
        terminal = { ended: false }; cargoTerminals.set(ended, terminal);
        const flag = terminal; void ended.then(() => { flag.ended = true; });
    }
    return terminal;
}

// The supplied bot and SDK retain the caller's ownership and execution guards.
export async function bankCargo(s: Session, patterns: RegExp[], reserve = 0,
    options: CargoOptions = {}): Promise<void> {
    if (!Number.isSafeInteger(reserve) || reserve < 0) throw Error('cargo reserve invalid');
    const name = s.name, stopped = () => !!options.stopped?.()
        || existsSync(resolve(cargoDir, '..', 'stop-all')) || existsSync(resolve(cargoDir, '..', `stop-${name}`));
    if (stopped()) throw Error('cargo stopped');
    const st = s.sdk.getState();
    if (!st?.bank?.isOpen || !st.player) return;
    const lifecycle = s.lifecycle, authenticatedServer = lifecycle?.server;
    const server = cargoServer(name, options, authenticatedServer);
    const sdk = s.sdk, bot = s.bot, client = s.client as { executeBotAction?: unknown; selfSlot?: unknown } | undefined, direct = s.direct, ended = s.ended;
    const config = sdk.config, endpoint = JSON.stringify(config && [config.host, config.port, config.gatewayUrl]);
    const executor = client?.executeBotAction, self = client?.selfSlot, life = st.player.lifeId, respawns = st.player.respawnCount ?? 0;
    let terminal: { ended: boolean } | undefined, lost = false, guardsOwned = () => true;
    const own = () => {
        const p = sdk.getState()?.player;
        if (s.name !== name || s.sdk !== sdk || s.bot !== bot || s.client !== client || s.direct !== direct || s.ended !== ended || !guardsOwned()
            || s.lifecycle !== lifecycle || s.lifecycle?.server !== authenticatedServer
            || sdk.config !== config || JSON.stringify(config && [config.host, config.port, config.gatewayUrl]) !== endpoint
            || client?.executeBotAction !== executor || client?.selfSlot !== self || terminal?.ended || !p || p.isDead
            || life !== undefined && p.lifeId !== life || (p.respawnCount ?? 0) !== respawns) lost = true;
        return !lost;
    };
    if (!own()) throw Error('cargo original session unavailable');
    const dir = options.dir ?? cargoDir;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${s.name}.json`);
    const matches = (name: string) => !/^coins$/i.test(name) && patterns.some(p => p.test(name));
    const publish = (known: boolean) => {
        const state = s.sdk.getState();
        const manifest: Cargo = { name: s.name, ...(server ? {server} : {}), at: Date.now(),
            bank: { x: st.player!.worldX, z: st.player!.worldZ, level: st.player!.level },
            items: known && state?.bank?.isOpen ? state.bank.items.filter(i => matches(i.name) && i.count > reserve)
                .map(i => ({ id: i.id, name: i.name, count: i.count - reserve })) : [] };
        writeFileSync(file, JSON.stringify(manifest));
        return manifest;
    };
    const manifest = publish(true);
    let req: unknown;
    try { req = JSON.parse(readFileSync(join(dir, `request-${s.name}.json`), 'utf8')); } catch { return; }
    if (!validCargoRequest(req, s.name, options.owned ?? ownedAccounts(server!), Date.now(), server) || req.ready !== true) return;
    // A single request gets one bank visit, even when a courier left or a trade failed.
    if (lastAttempt(dir, s.name) >= req.at) return;
    const courier = st.nearbyPlayers.find(p => p.name.toLowerCase() === req.courier.toLowerCase() && p.distance <= 10);
    if (!courier || !manifest.items.length) return;
    const count = (name: string) => s.sdk.getInventory().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
    const baseline = new Map(manifest.items.map(i => [i.name, count(i.name)]));
    const confirmed = new Map<string, number>();
    const request = req;
    const requestCurrent = () => {
        try {
            const current = JSON.parse(readFileSync(join(dir, `request-${s.name}.json`), 'utf8'));
            return validCargoRequest(current, s.name, options.owned ?? ownedAccounts(server!), Date.now(), server) && current.ready === true
                && current.at === request.at && current.courier.toLowerCase() === request.courier.toLowerCase()
                && (current.server ?? '').toLowerCase() === (request.server ?? '').toLowerCase();
        } catch { return false; }
    };
    const parent = executionContext.getStore(), controller = new AbortController(), scope = Symbol('cargo');
    const abortParent = () => controller.abort(parent?.signal.reason);
    const deadline = Math.min(Date.now() + 30_000, request.at + 180_000);
    let phase: 'work' | 'cleanup' = 'work', cleanupDeadline = 0, active = true, failure: unknown;
    let workTimer: ReturnType<typeof setTimeout> | undefined;
    const workContext: CargoExecution = { scope, phase: 'work', controller, open: true };
    let cleanupContext: CargoExecution | undefined;
    let tradeEntered = false, tradeSettled = false, withdrawalUncertain = false;
    let intent: { id: number; name: string; bank: number; held: number; amount: number } | undefined;
    let depositIntent: { name: string; held: number; bank: number } | undefined;
    const raw = sdk as unknown as { send?: (message: any) => unknown; getTradeState?: () => any; pendingActions?: Map<string, unknown> };
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'send'), send = raw.send;
    const tradeDescriptor = Object.getOwnPropertyDescriptor(raw, 'getTradeState'), getTradeState = raw.getTradeState;
    let scopeController = controller;
    const reject: (message: string) => never = message => {
        const error = Error(message); scopeController.abort(error); throw error;
    };
    const check = () => {
        if (!own()) reject('cargo original session unavailable');
        if (parent?.signal.aborted) reject('cargo parent execution stopped');
        if (scopeController.signal.aborted) throw scopeController.signal.reason;
        if (phase === 'cleanup') {
            if (Date.now() >= cleanupDeadline) reject('cargo cleanup deadline exceeded');
        } else {
            if (stopped()) reject('cargo stopped');
            if (Date.now() >= deadline) reject('cargo deadline exceeded');
            if (!requestCurrent()) reject('cargo request changed');
        }
    };
    const validateAction = (action: any, withdrawal = intent, deposit = depositIntent) => {
            if (phase === 'cleanup' && (action?.type === 'bankWithdraw' || action?.type === 'interactPlayer' && action.optionIndex === 4
                || action?.type === 'clickComponentWithOption' && action.componentId === 3322
                || action?.type === 'clickComponent' && [3420, 3546].includes(action.componentId))) reject('cargo cleanup cannot start a transfer');
            if (phase === 'work' && action?.type === 'bankWithdraw') {
                const row = sdk.getState()?.bank?.items.find(i => i.slot === action.slot);
                if (!withdrawal || !row || row.id !== withdrawal.id || row.count !== withdrawal.bank || count(withdrawal.name) !== withdrawal.held
                    || action.amount !== withdrawal.amount || action.amount === -1 && withdrawal.bank <= reserve)
                    reject('cargo withdrawal stock changed');
            }
            if (phase === 'work' && action?.type === 'clickComponentWithOption' && action.componentId === 3322) {
                const item = sdk.getInventory().find(i => i.slot === action.slot);
                if (action.optionIndex !== 4 || !item || count(item.name) !== confirmed.get(item.name)) reject('cargo offer stock changed');
            }
            if (phase === 'work' && action?.type === 'interactPlayer' && action.optionIndex === 4) {
                const player = sdk.getState()?.nearbyPlayers.find(p => p.index === action.playerIndex);
                if (!player || player.name.toLowerCase() !== courier.name.toLowerCase() || player.distance > 10) reject('cargo courier changed');
            }
            if (phase === 'work' && action?.type === 'clickComponent' && [3420, 3546].includes(action.componentId)) {
                const trade = getTradeState?.call(sdk) ?? sdk.getState()?.trade;
                const offered = new Map<string, number>();
                for (const item of trade?.myOffer ?? []) offered.set(item.name, (offered.get(item.name) ?? 0) + item.count);
                if (!trade?.isOpen || trade.partner?.toLowerCase() !== courier.name.toLowerCase() || offered.size !== confirmed.size
                    || [...confirmed].some(([name, amount]) => offered.get(name) !== amount)) reject('cargo trade offer changed');
            }
            if (phase === 'cleanup' && action?.type === 'bankDeposit') {
                const item = sdk.getInventory().find(i => i.slot === action.slot);
                const stored = (sdk.getState()?.bank?.items ?? []).filter(i => i.name === deposit?.name).reduce((n, i) => n + i.count, 0);
                if (!deposit || !item || item.name !== deposit.name || action.amount !== -1 || count(deposit.name) !== deposit.held || stored !== deposit.bank)
                    reject('cargo cleanup stock changed');
            }
    };
    const currentContext = () => {
        const context = cargoExecution.getStore();
        if (context?.scope !== scope) return;
        if (!context.open || context.phase !== phase || context.controller !== scopeController) throw Error('cargo action scope closed');
        return context;
    };
    const guardedSend = function (this: unknown, message: any) {
        const context = active ? currentContext() : undefined;
        if (context && message?.type === 'sdk_action') {
            check();
            const action = message.action, issuedIntent = intent && { ...intent }, issuedDeposit = depositIntent && { ...depositIntent };
            validateAction(action, issuedIntent, issuedDeposit);
            if (action && typeof action === 'object') {
                const pending = raw.pendingActions, id = message.actionId;
                // Deferred gates and the shim queue retain this exact action object. A completed SDK wait or a
                // closed issuing phase cannot authorize its later dispatch, including while cleanup is active.
                bindActionScope(action, () => {
                    if (!active || !context.open || phase !== context.phase || context.controller.signal.aborted
                        || pending instanceof Map && !pending.has(id)) throw Error('cargo action scope closed');
                    check();
                    validateAction(action, issuedIntent, issuedDeposit);
                });
            }
        }
        return send!.call(this, message);
    };
    const guardedTradeState = function (this: unknown) {
        if (active && currentContext()) check();
        return getTradeState!.call(this);
    };
    check();
    if (activeCargo.has(sdk)) throw Error('cargo already active on this session');
    activeCargo.add(sdk);
    try {
        if (ended) terminal = cargoTerminal(ended);
        parent?.signal.addEventListener('abort', abortParent, { once: true });
        workTimer = setTimeout(() => controller.abort(Error('cargo deadline exceeded')), Math.max(1, deadline - Date.now()));
        if (send) Object.defineProperty(raw, 'send', { configurable: true, writable: true, value: guardedSend });
        if (getTradeState) Object.defineProperty(raw, 'getTradeState', { configurable: true, writable: true, value: guardedTradeState });
        guardsOwned = () => (!send || Object.getOwnPropertyDescriptor(raw, 'send')?.value === guardedSend)
            && (!getTradeState || Object.getOwnPropertyDescriptor(raw, 'getTradeState')?.value === guardedTradeState);
        check(); recordAttempt(dir, request);
        // Invalidate advertised stock before any withdrawal, including a partial withdrawal or exception.
        publish(false);
        await cargoExecution.run(workContext, () => executionContext.run({ ...parent, signal: controller.signal }, async () => {
            for (const item of manifest.items.slice(0, 20)) {
                if ((baseline.get(item.name) ?? 0) > 0 || confirmed.has(item.name)) continue;
                if (sdk.getInventory().length >= 28) break;
                if (!Number.isSafeInteger(item.count) || item.count < 1 || item.count > 2147483647) reject('cargo stock count invalid');
                let remaining = item.count;
                while (remaining > 0) {
                    check();
                    const row = sdk.getState()?.bank?.items.find(i => i.id === item.id);
                    if (!row || row.count !== remaining + reserve) reject('cargo withdrawal stock changed');
                    // Native quantities avoid the executor's delayed Bank-X count submission.
                    const amount = reserve === 0 ? -1 : remaining >= 10 ? 10 : remaining >= 5 ? 5 : 1;
                    intent = { id: item.id, name: item.name, bank: row.count, held: count(item.name), amount };
                    withdrawalUncertain = true;
                    await bot.withdrawItem(exactItem(item.name), amount, { asNote: true });
                    const after = sdk.getState()?.bank?.items.find(i => i.id === item.id)?.count ?? 0;
                    const received = count(item.name) - intent.held;
                    if (!Number.isSafeInteger(received) || received < 1 || received > (amount === -1 ? remaining : amount)
                        || after !== intent.bank - received || after < reserve) reject('cargo withdrawal receipt unconfirmed');
                    withdrawalUncertain = false;
                    confirmed.set(item.name, (confirmed.get(item.name) ?? 0) + received);
                    remaining -= received;
                    check();
                    if (reserve === 0) break; // A paired partial withdrawal is useful cargo too.
                }
            }
            intent = undefined;
            if (!confirmed.size) return;
            check(); await bot.closeBank(); check();
            tradeEntered = true;
            // Every offered name started absent: All offers exactly its confirmed withdrawal, without Offer-X.
            const give = [...confirmed].map(([name]) => ({ item: exactItem(name), amount: -1 }));
            const serving = deadline - Date.now() - 2000;
            if (serving < 1) reject('cargo trade closure budget unavailable');
            const trade = await bot.serveTrades({ from: exactItem(courier.name), give, maxTrades: 1, timeout: serving, tradeTimeout: serving });
            if (trade.trades.some(t => !t.success && t.reason !== 'declined')) reject('cargo trade outcome unconfirmed');
            if ((sdk.getTradeState?.() ?? sdk.getState()?.trade)?.isOpen !== false) reject('cargo trade closure unconfirmed');
            let closedAt = sdk.getState()?.tick;
            // A closed snapshot can be the offer-to-confirm transition. Require two observed game ticks of closure;
            // failed waits and reopened screens never authorize a bank input.
            await sdk.waitForCondition(state => {
                check();
                if (state.trade?.isOpen !== false) { closedAt = undefined; return false; }
                if (!Number.isSafeInteger(state.tick)) return false;
                closedAt ??= state.tick;
                return Number.isSafeInteger(closedAt) && state.tick >= closedAt! + 2;
            }, Math.max(1, Math.min(2000, deadline - Date.now())));
            tradeSettled = true;
            check();
            const done = trade.trades.find(t => t.success && t.gave.length);
            if (done) console.log(`MILESTONE cargo to ${courier.name}: ${done.gave.map(i => `${i.count} ${i.name}`).join(', ')}`);
        }));
    } catch (error) { failure = error; }
    clearTimeout(workTimer);
    workContext.open = false;
    controller.abort(Error('cargo work scope closed'));
    try {
        if (!own() || parent?.signal.aborted || withdrawalUncertain || tradeEntered && !tradeSettled)
            throw Error('cargo cleanup deferred: original session or transfer outcome unconfirmed');
        phase = 'cleanup'; cleanupDeadline = Date.now() + 5000;
        const cleanup = new AbortController(), timer = setTimeout(() => cleanup.abort(Error('cargo cleanup deadline exceeded')), 5000);
        scopeController = cleanup;
        cleanupContext = { scope, phase, controller: cleanup, open: true };
        const abortCleanup = () => cleanup.abort(parent?.signal.reason);
        parent?.signal.addEventListener('abort', abortCleanup, { once: true });
        try {
            await cargoExecution.run(cleanupContext, () => executionContext.run({ ...parent, signal: cleanup.signal }, async () => {
                const remaining = [...confirmed].filter(([name]) => count(name) > 0);
                if (!remaining.length && failure) return;
                check();
                const opened = sdk.getState()?.bank?.isOpen || (await bot.openBank()).success;
                if (!opened) throw Error('cargo cleanup: cannot reopen bank; withdrawn cargo remains in inventory');
                for (const [name, amount] of remaining) {
                    check();
                    if (count(name) !== amount) throw Error('cargo cleanup: retained stock changed');
                    const stored = () => (sdk.getState()?.bank?.items ?? []).filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
                    const before = stored();
                    depositIntent = { name, held: amount, bank: before };
                    const deposited = await bot.depositItem(exactItem(name), -1);
                    if (!deposited.success || count(name) !== 0 || stored() !== before + amount) throw Error(`cargo cleanup: could not return ${name}`);
                }
                check();
            }));
        } finally {
            cleanupContext.open = false; cleanup.abort(Error('cargo cleanup scope closed'));
            clearTimeout(timer); parent?.signal.removeEventListener('abort', abortCleanup);
        }
        if (!failure) publish(true);
    } catch (error) {
        failure = Error(String(failure ?? 'cargo transfer incomplete') + '; ' + String(error));
    } finally {
        clearTimeout(workTimer);
        if (cleanupContext) cleanupContext.open = false;
        active = false;
        parent?.signal.removeEventListener('abort', abortParent);
        activeCargo.delete(sdk);
        if (send && Object.getOwnPropertyDescriptor(raw, 'send')?.value === guardedSend) {
            if (descriptor) Object.defineProperty(raw, 'send', descriptor);
            else delete raw.send;
        }
        if (getTradeState && Object.getOwnPropertyDescriptor(raw, 'getTradeState')?.value === guardedTradeState) {
            if (tradeDescriptor) Object.defineProperty(raw, 'getTradeState', tradeDescriptor);
            else delete raw.getTradeState;
        }
    }
    if (failure) throw failure;
}
