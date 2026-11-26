import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fetchBoard, observeProfile, type BoardRow } from './scout';

// Usage: bun packages/planner/src/scout-cli.ts [base=https://rs-sdk-demo.fly.dev] [--out=path] [--fresh-account=name ...] [--max-age-ms=N]
// Saves a complete snapshot of the time-ranked boards. One request per board,
// one second apart. Category ids: skill index + 1 from server/engine/src/web/utils.ts:80 SKILL_NAMES
// (indices 18 and 19 are empty); Quest Points is 100 (utils.ts:91).
// --max-age-ms=N exits with no request when the --out file holds a snapshot of the same base under N ms old (and a
// profile observation of each --fresh-account under N ms old), so a scheduled caller can run it often.
// The profile observations of an earlier --out file of the same base stay for each account that this run does not
// observe: each keeps its own `at`, and its reader checks that age.
const SKILLS = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', null, null, 'Runecraft'];

export type ScoutArgs = { base: string; output?: string; freshAccounts: string[]; maxAgeMs?: number };

export function parseScoutArgs(args: readonly string[]): ScoutArgs {
    const base = args.find(a => !a.startsWith('--')) ?? 'https://rs-sdk-demo.fly.dev';
    const freshAccounts = [...new Set(args.filter(a => a.startsWith('--fresh-account=')).map(a => a.slice('--fresh-account='.length).toLowerCase()))];
    if (freshAccounts.some(name => !/^[a-z0-9]{1,12}$/.test(name))) throw Error('invalid fresh account name');
    const output = args.find(a => a.startsWith('--out='))?.slice('--out='.length);
    const age = args.find(a => a.startsWith('--max-age-ms='))?.slice('--max-age-ms='.length);
    const maxAgeMs = age === undefined ? undefined : Number(age);
    if (maxAgeMs !== undefined && (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0)) throw Error('invalid --max-age-ms');
    return { base, ...(output ? { output } : {}), freshAccounts, ...(maxAgeMs !== undefined ? { maxAgeMs } : {}) };
}

export type SnapshotFile = { base?: unknown; takenAt?: unknown; boards?: unknown; profiles?: unknown };

export function readSnapshotFile(file: string): SnapshotFile | null {
    try {
        const json = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
        return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
    } catch { return null; }
}

const profileList = (s: SnapshotFile | null): any[] => (Array.isArray(s?.profiles) ? s.profiles : []);

// True when `previous` is a snapshot of `base` with boards, taken under `maxAgeMs` before `now`, that holds a profile
// observation of each of `freshAccounts` under `maxAgeMs` old.
export function snapshotIsFresh(previous: SnapshotFile | null, base: string, freshAccounts: readonly string[], maxAgeMs: number, now: number): boolean {
    if (!previous || previous.base !== base || !Array.isArray(previous.boards) || previous.boards.length === 0) return false;
    const fresh = (at: number) => Number.isFinite(at) && now - at >= 0 && now - at < maxAgeMs;
    if (!fresh(typeof previous.takenAt === 'string' ? Date.parse(previous.takenAt) : NaN)) return false;
    const profiles = profileList(previous);
    return freshAccounts.every(name => profiles.some(p => p?.name === name && fresh(typeof p.at === 'number' ? p.at : NaN)));
}

// The profile observations to save: those of `previous` (when it is a snapshot of `base`) for the accounts that
// `observed` does not hold, then `observed`.
export function keptProfiles(previous: SnapshotFile | null, base: string, observed: readonly { name: string }[]): unknown[] {
    const names = new Set(observed.map(p => p.name));
    const old = previous?.base === base ? profileList(previous) : [];
    return [...old.filter(p => typeof p?.name === 'string' && !names.has(p.name)), ...observed];
}

if (import.meta.main) {
    const { base, output, freshAccounts, maxAgeMs } = parseScoutArgs(process.argv.slice(2));
    const tickMs = 400;
    const boards: { board: string; category: number }[] = [{ board: 'Overall', category: 0 }];
    SKILLS.forEach((s, i) => { if (s) boards.push({ board: s, category: i + 1 }); });
    boards.push({ board: 'Quest Points', category: 100 });

    const takenAt = new Date().toISOString();
    const file = output ? resolve(output) : join(resolve(import.meta.dir, '..', '..', '..'), 'research', `hiscores-${takenAt.slice(0, 10)}.json`);
    const previous = readSnapshotFile(file);
    if (maxAgeMs !== undefined && snapshotIsFresh(previous, base, freshAccounts, maxAgeMs, Date.now())) {
        console.log(`kept ${file}: taken at ${String(previous!.takenAt)}, under ${maxAgeMs} ms old`);
        process.exit(0);
    }
    const out: { board: string; category: number; rows: BoardRow[] }[] = [];
    for (const b of boards) {
        out.push({ ...b, rows: await fetchBoard(base, b.category, 'main', tickMs) });
        await Bun.sleep(1000);
    }
    const observed: { name: string }[] = [];
    for (const name of freshAccounts) observed.push(await observeProfile(base, name));
    const profiles = keptProfiles(readSnapshotFile(file), base, observed);
    mkdirSync(dirname(file), { recursive: true });
    const temporary = file + '.' + process.pid + '.tmp';
    try {
        writeFileSync(temporary, JSON.stringify({ base, takenAt, tickMs, boards: out, ...(profiles.length ? { profiles } : {}) }, null, 2) + '\n');
        renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
    for (const b of out) {
        const top = b.rows[0];
        console.log(`${b.board.padEnd(12)} #1 ${top ? `${top.name} lvl ${top.level} ${top.ticks} ticks (${(top.ticks * tickMs / 60_000).toFixed(1)} min at ${tickMs} ms)` : 'empty'}`);
    }
    console.log(`saved ${file}`);
}
