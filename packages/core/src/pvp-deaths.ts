import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isLocalServer } from './localserver';

// The ledger of PvP deaths on a live server: .practice/pvp-deaths.json. A death that a run recovers from (the hunt and the squad re-kit)
// is recorded, and a run refuses to start when an account or its squad died too often in the last 24 hours. The refusal is
// `RESULT fail died ...`, which the supervisor reads as a death, so a losing squad stops for good and a person clears it (the file).
// Practice servers neither record nor count: a bench death never counts against a live account.
export const PVP_DEATH_SCHEMA = 'pvp-death/1';
export const DEFAULT_PVP_DEATHS_FILE = join(resolve(import.meta.dir, '..', '..', '..'), '.practice', 'pvp-deaths.json');
export const PVP_DEATH_WINDOW_MS = 24 * 3_600_000;
export type PvpDeathLimits = { perAccount: number; squad: number };
export const DEFAULT_PVP_DEATH_LIMITS: PvpDeathLimits = { perAccount: 2, squad: 3 };
export type PvpDeath = { schema: typeof PVP_DEATH_SCHEMA; account: string; server: string; at: number; script: string; near: { x: number; z: number } | null };

const whole = (value: string | undefined, fallback: number) => { const n = Number(value); return value !== undefined && value.trim() !== '' && Number.isSafeInteger(n) && n >= 0 ? n : fallback; };
// PVP_MAX_DEATHS_PER_ACCOUNT and PVP_MAX_DEATHS_SQUAD: whole numbers of 0 or more, else the defaults.
export const pvpDeathLimits = (env: Record<string, string | undefined> = process.env): PvpDeathLimits =>
    ({ perAccount: whole(env.PVP_MAX_DEATHS_PER_ACCOUNT, DEFAULT_PVP_DEATH_LIMITS.perAccount), squad: whole(env.PVP_MAX_DEATHS_SQUAD, DEFAULT_PVP_DEATH_LIMITS.squad) });

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
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    try { writeFileSync(temporary, JSON.stringify(all, null, 1) + '\n'); renameSync(temporary, file); }
    catch (error) { try { rmSync(temporary, { force: true }); } catch { /* keep the first error */ } throw error; }
    return true;
}

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
        if (n >= Math.max(1, limits.perAccount)) return `death ledger: ${name} died ${n} times in ${hours} h (limit ${limits.perAccount})`;
    }
    if (recent.length >= Math.max(1, limits.squad)) return `death ledger: the squad died ${recent.length} times in ${hours} h (limit ${limits.squad})`;
    return null;
}
