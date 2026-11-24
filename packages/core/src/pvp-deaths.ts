import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeAtomicFile } from './atomic-file';
import { isLocalServer } from './localserver';

// The ledger of PvP deaths on a live server: .practice/pvp-deaths.json. A death that a run recovers from (the hunt and the squad re-kit)
// is recorded, and a run refuses to start when an account or its squad died too often in the last 24 hours. The refusal is
// `RESULT fail died ...`, which the supervisor reads as a death, so a losing squad stops for good and a person clears it (the file).
// Practice servers neither record nor count: a bench death never counts against a live account.
export const PVP_DEATH_SCHEMA = 'pvp-death/1';
export const DEFAULT_PVP_DEATHS_FILE = join(resolve(import.meta.dir, '..', '..', '..'), '.practice', 'pvp-deaths.json');
export const PVP_DEATH_WINDOW_MS = 24 * 3_600_000;
// The limits of the death ledger, in one place. The lead decided them: a squad stops after 2 deaths in one run (the second death ends the
// run as RESULT fail died) or 3 deaths in a day (the next run refuses to start), and an account stops after 2 deaths in a day. They stop
// until a person or the lead reads the cause and clears the ledger. The reason: a death drops the kit to the killer (content death.rs2),
// and a squad that loses a second member in a run, or a third in a day, is losing its fights. Re-kitting each death spends the bank
// with nobody reading why.
export const PVP_DEATH_LIMITS = { perRun: 2, perDay: 3, perAccountPerDay: 2 } as const;
export type PvpDeathLimits = { perRun: number; perDay: number; perAccountPerDay: number };
export type PvpDeath = { schema: typeof PVP_DEATH_SCHEMA; account: string; server: string; at: number; script: string; near: { x: number; z: number } | null };

const whole = (value: string | undefined, fallback: number) => { const n = Number(value); return value !== undefined && value.trim() !== '' && Number.isSafeInteger(n) && n >= 0 ? n : fallback; };
// PVP_MAX_DEATHS_PER_RUN, PVP_MAX_DEATHS_PER_DAY and PVP_MAX_DEATHS_PER_ACCOUNT: whole numbers of 0 or more, else PVP_DEATH_LIMITS.
export const pvpDeathLimits = (env: Record<string, string | undefined> = process.env): PvpDeathLimits => ({
    perRun: whole(env.PVP_MAX_DEATHS_PER_RUN, PVP_DEATH_LIMITS.perRun), perDay: whole(env.PVP_MAX_DEATHS_PER_DAY, PVP_DEATH_LIMITS.perDay),
    perAccountPerDay: whole(env.PVP_MAX_DEATHS_PER_ACCOUNT, PVP_DEATH_LIMITS.perAccountPerDay) });

// A limit of N refuses a run once N deaths are in the window (a limit of 0 refuses after the first death).
// A missing file is an empty ledger. A file that cannot be read stops the run (it throws): the ledger fails closed.
export function readPvpDeaths(file = DEFAULT_PVP_DEATHS_FILE): PvpDeath[] {
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(raw) || !raw.every(e => e?.schema === PVP_DEATH_SCHEMA && typeof e.account === 'string' && typeof e.server === 'string' && Number.isFinite(e.at))) throw new Error('invalid pvp death ledger');
    return raw;
}

// Adds one death. It returns false and writes nothing for a local (practice) server.
export function recordPvpDeath(entry: Omit<PvpDeath, 'schema'>, file = DEFAULT_PVP_DEATHS_FILE): boolean {
    if (isLocalServer(entry.server)) return false;
    const all = readPvpDeaths(file);
    all.push({ schema: PVP_DEATH_SCHEMA, ...entry });
    writeAtomicFile(file, JSON.stringify(all, null, 1) + '\n', { ensureDir: true });
    return true;
}

const times = (n: number) => n === 1 ? '1 time' : `${n} times`;

// The reason that a run of `accounts` on `server` must not start, or null. A local server never refuses.
export function pvpDeathRefusal(o: { accounts: readonly string[]; server: string; now?: number; limits?: PvpDeathLimits; windowMs?: number; file?: string }): string | null {
    if (isLocalServer(o.server)) return null;
    const now = o.now ?? Date.now(), limits = o.limits ?? pvpDeathLimits(), windowMs = o.windowMs ?? PVP_DEATH_WINDOW_MS;
    let all: PvpDeath[];
    try { all = readPvpDeaths(o.file); } catch (error) { return `death ledger unreadable: ${String(error)}`; }
    const key = (name: string) => name.toLowerCase(), names = new Set(o.accounts.map(key));
    const recent = all.filter(e => e.server.toLowerCase() === o.server.toLowerCase() && e.at <= now && now - e.at < windowMs && names.has(key(e.account)));
    const hours = Math.round(windowMs / 3_600_000);
    for (const name of o.accounts) {
        const n = recent.filter(e => key(e.account) === key(name)).length;
        if (n >= Math.max(1, limits.perAccountPerDay)) return `death ledger: ${name} died ${times(n)} in ${hours} h (limit ${limits.perAccountPerDay})`;
    }
    if (recent.length >= Math.max(1, limits.perDay)) return `death ledger: the squad died ${times(recent.length)} in ${hours} h (limit ${limits.perDay})`;
    return null;
}
