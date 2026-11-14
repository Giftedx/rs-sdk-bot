import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from './inprocess';
import { ownedAccounts } from './tradeguard';

export const cargoDir = resolve(import.meta.dir, '../../../.practice/cargo');
export const exactItem = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
export interface Cargo { name: string; server?: string; at: number; bank: { x: number; z: number; level: number }; items: { id: number; name: string; count: number }[] }
export interface CargoRequest { worker: string; courier: string; server?: string; at: number; ready?: boolean }
export type CargoOptions = { dir?: string; owned?: ReadonlySet<string>; server?: string };

// A caller without a Session can inspect configuration, but only authenticated
// ownership on that endpoint grants a request. A live Session's endpoint wins.
export function cargoAccountServer(name: string): string {
    if (!/^[A-Za-z0-9_ -]{1,12}$/.test(name)) throw Error('cargo: invalid account name');
    const dir=resolve(import.meta.dir, '../../../vendor/rs-sdk/bots');
    const matches=readdirSync(dir).filter(candidate=>candidate.toLowerCase()===name.toLowerCase());
    if(matches.length!==1)throw Error('cargo: unique account configuration required for '+name);
    const env = readFileSync(join(dir, matches[0]!, 'bot.env'), 'utf8');
    return env.match(/^SERVER=(.*)$/m)?.[1]?.trim() || 'localhost:8888';
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

// The options isolate filesystem and account lookup in deterministic fake-session tests.
export async function bankCargo(s: Session, patterns: RegExp[], reserve = 0,
    options: CargoOptions = {}): Promise<void> {
    const st = s.sdk.getState();
    if (!st?.bank?.isOpen || !st.player) return;
    const server = cargoServer(s.name, options, s.lifecycle?.server);
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
    recordAttempt(dir, req);
    const courier = st.nearbyPlayers.find(p => p.name.toLowerCase() === req.courier.toLowerCase() && p.distance <= 10);
    if (!courier || !manifest.items.length) return;
    const count = (name: string) => s.sdk.getInventory().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
    const baseline = new Map(manifest.items.map(i => [i.name, count(i.name)]));
    const give: { item: RegExp; amount: number }[] = [];
    // Invalidate advertised stock before any withdrawal, including a partial withdrawal or exception.
    publish(false);
    try {
        for (const item of manifest.items.slice(0, 20)) {
            if ((baseline.get(item.name) ?? 0) > 0) continue; // Name-based trade API cannot separate a held tool from its note.
            if (s.sdk.getInventory().length >= 28) break;
            await s.bot.withdrawItem(exactItem(item.name), item.count, { asNote: true });
            const withdrawn = Math.max(0, count(item.name) - (baseline.get(item.name) ?? 0));
            if (withdrawn > 0) give.push({ item: exactItem(item.name), amount: withdrawn });
        }
        if (!give.length) return;
        await s.bot.closeBank();
        const trade = await s.bot.serveTrades({ from: exactItem(courier.name), give, maxTrades: 1, timeout: 30_000 });
        const done = trade.trades.find(t => t.success && t.gave.length);
        if (done) console.log(`MILESTONE cargo to ${courier.name}: ${done.gave.map(i => `${i.count} ${i.name}`).join(', ')}`);
    } finally {
        // Return every untraded withdrawal. Preserve items held before this call, including tools.
        const opened = s.sdk.getState()?.bank?.isOpen || (await s.bot.openBank()).success;
        if (!opened) throw new Error('cargo cleanup: cannot reopen bank; withdrawn cargo remains in inventory');
        for (const [name, before] of baseline) {
            const remaining = count(name) - before;
            if (remaining > 0) {
                const deposited = await s.bot.depositItem(exactItem(name), remaining);
                if (!deposited.success || count(name) > before) throw new Error(`cargo cleanup: could not return ${name}`);
            }
        }
        publish(true);
    }
}
