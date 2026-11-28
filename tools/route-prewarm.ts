// Plans the slow walks that live bots planned again, in the background, so their legs are in the shared leg store
// (packages/core/src/leg-cache.ts) before a bot walks them. A cold plan costs a live walk 10 to 92 s (56 WALK_NO_ROUTE
// lines over 10 s in one day, 16 over 45 s); the same trip planned again in a new process with the store from the
// first takes 7.4 s against 107 s.
// Usage: bun tools/route-prewarm.ts [--logs <dir>] [--hours 24] [--min-ms 5000] [--budget-ms 1200000] [--store <file>] [--root <checkout for status rows>] [--force] [--dry]
// live-update (packages/fleet/src/live-update/reload.ts) starts it after an update that changes route code.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { freemem, setPriority } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Tile } from '../packages/core/src/world';

const root = resolve(import.meta.dir, '..');
export const PREWARM_FREE_GB = 7; // FREE_FLOOR_GB (4) plus one route world (about 2.5 GB) and a margin
export type SlowWalk = { bot: string; from: Tile; to: Tile; ms: number };

const LINE = /(?:^|\s)(WALK_NO_ROUTE|WALK_PLAN_SLOW) (\{.*\})\s*$/;
const tile = (t: unknown): t is Tile => !!t && typeof t === 'object' && ['x', 'z', 'level'].every(k => Number.isSafeInteger((t as Record<string, unknown>)[k]));
// The walks of one bot log that took at least `minMs` to plan, the slowest first, one row for each start and goal.
export function slowWalks(text: string, bot: string, minMs: number): SlowWalk[] {
    const best = new Map<string, SlowWalk>();
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(LINE);
        if (!m) continue;
        let d: { from?: unknown; to?: unknown; ms?: unknown };
        try { d = JSON.parse(m[2]!); } catch { continue; }
        if (!tile(d.from) || !tile(d.to) || typeof d.ms !== 'number' || d.ms < minMs) continue;
        const key = `${d.from.level},${d.from.x},${d.from.z}>${d.to.level},${d.to.x},${d.to.z}`, old = best.get(key);
        if (!old || old.ms < d.ms) best.set(key, { bot, from: d.from, to: d.to, ms: d.ms });
    }
    return [...best.values()].sort((a, b) => b.ms - a.ms);
}

// An account for the route search from a bot's status row: its levels and pack (door-policy.ts accountFromState).
export async function statusAccount(bot: string, dirs: readonly string[]) {
    const { accountFromState } = await import('../packages/core/src/door-policy');
    for (const dir of dirs) {
        try {
            const st = JSON.parse(readFileSync(join(dir, `${bot}.json`), 'utf8'));
            const skills = (st.skills ?? []).map((s: { name: string; level: number; currentLevel?: number }) => ({ name: s.name, level: s.currentLevel ?? s.level, baseLevel: s.level }));
            const acct = accountFromState({ skills, inventory: st.inventory ?? [], equipment: Array.isArray(st.equipment) ? st.equipment : undefined });
            // The quest stages, varps and unlocks the session observed (status.ts guildFacts, as accountForSdk adds them).
            const facts = st.guildFacts && typeof st.guildFacts === 'object' ? st.guildFacts : {};
            return { ...acct, ...facts, unlocks: Array.isArray(facts.unlocks) ? facts.unlocks : [] };
        } catch { /* the next status directory */ }
    }
    return null;
}

if (import.meta.main) {
    const arg = (name: string, d: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? d : d; };
    const logs = resolve(arg('--logs', join(root, '.practice', 'swarm-logs'))), hours = Number(arg('--hours', '24'));
    const minMs = Number(arg('--min-ms', '5000')), budgetMs = Number(arg('--budget-ms', '1200000'));
    const dry = process.argv.includes('--dry'), force = process.argv.includes('--force');
    const base = resolve(arg('--root', root)), statusDirs = [join(base, '.practice', 'live', 'status'), join(base, '.practice', 'status')];
    const stampDir = join(root, '.practice', 'route-prewarm'), stamp = join(stampDir, 'last.json');
    const head = (() => { try { const h = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root, windowsHide: true }); return h.exitCode === 0 ? h.stdout.toString().trim() : 'unknown'; } catch { return 'unknown'; } })();
    if (!force && existsSync(stamp) && JSON.parse(readFileSync(stamp, 'utf8')).head === head) { console.log(`PREWARM skip: done for ${head.slice(0, 10)}`); process.exit(0); }
    const freeGB = freemem() / 2 ** 30;
    if (freeGB < PREWARM_FREE_GB) { console.log(`PREWARM skip: ${freeGB.toFixed(1)} GB free, under ${PREWARM_FREE_GB} GB`); process.exit(0); }
    try { setPriority(process.pid, 19); } catch { /* lowest priority is a courtesy */ }
    const since = Date.now() - hours * 3_600_000, walks: SlowWalk[] = [];
    for (const f of readdirSync(logs)) {
        if (!f.endsWith('.log') || f.startsWith('host-')) continue;
        const p = join(logs, f);
        if (statSync(p).mtimeMs < since) continue;
        walks.push(...slowWalks(readFileSync(p, 'utf8'), basename(f, '.log'), minMs));
    }
    walks.sort((a, b) => b.ms - a.ms);
    console.log(`PREWARM walks=${walks.length} minMs=${minMs} budgetMs=${budgetMs}${dry ? ' dry' : ''}`);
    if (dry) { for (const w of walks) console.log(`PREWARM walk ${w.bot} ${JSON.stringify(w.from)} -> ${JSON.stringify(w.to)} ${w.ms} ms`); process.exit(0); }
    const { bankStock } = await import('../packages/core/src/trip');
    type Acct = NonNullable<Awaited<ReturnType<typeof statusAccount>>>;
    // The plans go to the host route service (packages/core/src/route-service.ts). It writes the same shared leg store
    // and keeps its warm search state for the bots. A route world in this process held 2.4 GB private next to the
    // service's own. --store (another leg store file, for a proof run on an empty store) plans in this process.
    const planWalk = await (async () => {
        if (!process.argv.includes('--store')) {
            process.env.ROUTE_SERVICE = '1';
            const { planTripOffThread } = await import('../packages/core/src/route-plan');
            return (w: SlowWalk, acct: Acct, ms: number) => planTripOffThread(w.from, w.to, acct, bankStock(w.bot, { base }), ms);
        }
        const [{ loadPathfinding }, { createWorld, rsPathLength }, { planTrip }, { legCache }] = await Promise.all([
            import('../packages/core/src/pathcache'), import('../packages/core/src/world'), import('../packages/core/src/trip'), import('../packages/core/src/leg-cache'),
        ]);
        await loadPathfinding();
        const world = createWorld({ pathLength: await rsPathLength({ legs: legCache(resolve(arg('--store', ''))) }) });
        return async (w: SlowWalk, acct: Acct, ms: number) => planTrip(world, w.from, w.to, acct, bankStock(w.bot, { base }), undefined, undefined, { deadline: performance.now() + ms });
    })();
    const end = Date.now() + budgetMs;
    let done = 0;
    for (const w of walks) {
        const left = end - Date.now();
        if (left <= 0) break;
        const acct = await statusAccount(w.bot, statusDirs);
        if (!acct) continue;
        const t0 = performance.now(), plan = await planWalk(w, acct, Math.min(left, 120_000));
        done++;
        console.log(`PREWARM ${JSON.stringify({ bot: w.bot, from: w.from, to: w.to, liveMs: w.ms, ms: Math.round(performance.now() - t0), ok: !!plan })}`);
    }
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(stamp, JSON.stringify({ head, at: Date.now(), walks: walks.length, planned: done }));
    console.log(`PREWARM done planned=${done} of ${walks.length}`);
    process.exit(0);
}
