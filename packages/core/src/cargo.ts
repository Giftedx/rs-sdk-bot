import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from './inprocess';
import { ownedAccounts } from './tradeguard';

export const cargoDir = resolve(import.meta.dir, '../../../.practice/cargo');
export const exactItem = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
export interface Cargo { name: string; at: number; bank: { x: number; z: number; level: number }; items: { id: number; name: string; count: number }[] }
export interface CargoRequest { worker: string; courier: string; at: number; ready?: boolean }
const checkedRequests = new Map<string, number>();

export function validCargoRequest(value: unknown, worker: string, owned: ReadonlySet<string>, now = Date.now()): value is CargoRequest {
    const req = value as CargoRequest | null;
    return !!req && typeof req.worker === 'string' && req.worker.toLowerCase() === worker.toLowerCase()
        && typeof req.courier === 'string' && owned.has(req.courier.toLowerCase())
        && req.courier.toLowerCase() !== worker.toLowerCase()
        && Number.isFinite(req.at) && req.at <= now && now - req.at < 180_000;
}

export function courierWaiting(name: string, options: { dir?: string; owned?: ReadonlySet<string> } = {}): boolean {
    try {
        const req = JSON.parse(readFileSync(join(options.dir ?? cargoDir, `request-${name}.json`), 'utf8'));
        return validCargoRequest(req, name, options.owned ?? ownedAccounts('rs-sdk-demo.fly.dev')) && req.ready === true
            && checkedRequests.get(name.toLowerCase()) !== req.at;
    } catch { return false; }
}

// The options isolate filesystem and account lookup in deterministic fake-session tests.
export async function bankCargo(s: Session, patterns: RegExp[], reserve = 0,
    options: { dir?: string; owned?: ReadonlySet<string> } = {}): Promise<void> {
    const st = s.sdk.getState();
    if (!st?.bank?.isOpen || !st.player) return;
    const dir = options.dir ?? cargoDir;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${s.name}.json`);
    const matches = (name: string) => !/^coins$/i.test(name) && patterns.some(p => p.test(name));
    const publish = (known: boolean) => {
        const state = s.sdk.getState();
        const manifest: Cargo = { name: s.name, at: Date.now(),
            bank: { x: st.player!.worldX, z: st.player!.worldZ, level: st.player!.level },
            items: known && state?.bank?.isOpen ? state.bank.items.filter(i => matches(i.name) && i.count > reserve)
                .map(i => ({ id: i.id, name: i.name, count: i.count - reserve })) : [] };
        writeFileSync(file, JSON.stringify(manifest));
        return manifest;
    };
    const manifest = publish(true);
    let req: unknown;
    try { req = JSON.parse(readFileSync(join(dir, `request-${s.name}.json`), 'utf8')); } catch { return; }
    if (!validCargoRequest(req, s.name, options.owned ?? ownedAccounts('rs-sdk-demo.fly.dev')) || req.ready !== true) return;
    // A single request gets one bank visit, even when a courier left or a trade failed.
    if (checkedRequests.get(s.name.toLowerCase()) === req.at) return;
    checkedRequests.set(s.name.toLowerCase(), req.at);
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
