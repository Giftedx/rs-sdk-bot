import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { trackFlow } from '../../flow';
import { folderScan } from '../../folder-scan';
import { isLocalServer } from '../../../core/src/localserver';
import { append, FILES, MAIN, NL, ROLE_SKILL, SCRIPT_ROLE, statusDirs, tailJsonl, type Status } from '../config';
import { inferRole, NO_ROLE, ranks } from '../world';
import { trackResult } from './results';

// A status file is parsed again only when its mtime changes; track() runs once per new winning version. The scans
// cover live, legacy and practice status folders so live bots under .practice/live/status stay visible.
const statusScans = statusDirs.map(dir => ({ dir, scan: folderScan(dir) }));
const statusCache = new Map<string, { mtime: number; doc: Status }>();
let statusCacheVersion = 0;
let cachedPracticeVersion = -1;
let cachedPracticeSet = new Set<string>();
const trackedVersions = new Map<string, string>();
const flows = new Map<string, any>(); // loot and supplies per account and session (flow.ts)
function readStatuses(): Map<string, Status> {
    for (const { dir, scan } of statusScans) {
        const { check, gone } = scan();
        for (const f of gone) if (statusCache.delete(join(dir, f))) statusCacheVersion++;
        for (const f of check) {
            if (!f.endsWith('.json')) continue;
            const p = join(dir, f);
            try {
                const mtime = statSync(p).mtimeMs;
                if (statusCache.get(p)?.mtime === mtime) continue;
                const doc = JSON.parse(readFileSync(p, 'utf8'));
                if (!doc || typeof doc.name !== 'string' || !doc.name || typeof doc.server !== 'string'
                    || !Number.isFinite(doc.at) || doc.at < 0
                    || ['phase','role','goal','result','timeline'].some(k => doc[k] != null && typeof doc[k] !== 'string')
                    || ['skills','inventory','bank','equipment','quests'].some(k => doc[k] != null && !Array.isArray(doc[k]))
                    || (doc.skills ?? []).some((k: any) => !k || typeof k.name !== 'string')) { if (statusCache.delete(p)) statusCacheVersion++; continue; }
                statusCache.set(p, { mtime, doc });
                statusCacheVersion++;
            } catch { if (existsSync(p)) scan.retry(f); /* being written */ else if (statusCache.delete(p)) statusCacheVersion++; }
        }
    }
    const winners = new Map<string, { path: string; mtime: number; doc: Status }>(), now = Date.now();
    for (const [path, entry] of statusCache.entries()) {
        const s = entry.doc;
        if (isLocalServer(s.server) && now - s.at > 30 * 60_000) continue; // stale practice bots
        const key = s.name.toLowerCase();
        const other = winners.get(key);
        if (!other || s.at > other.doc.at) winners.set(key, { path, mtime: entry.mtime, doc: s });
    }
    const out = new Map<string, Status>();
    for (const [key, winner] of winners) {
        const version = `${winner.path}:${winner.mtime}`;
        if (trackedVersions.get(key) !== version) {
            track(winner.doc);
            trackedVersions.set(key, version);
        }
        out.set(winner.doc.name, winner.doc);
    }
    return out;
}

// XP rate samples, xp/tick history (sparkline), phase start times.
// Each sample keeps every skill's XP, so a rate can be taken for one skill (the goal) and not the sum of all.
type Sample = { at: number; tick: number; xp: number; sk: Record<string, number>; coins: number; food: number; bank: boolean };
// Food a gold farmer eats: the pack items the thieving scripts eat (lobsters, cakes, bread, chocolate, fish).
const FOOD_RE = /lobster|cake|bread|chocolate|shrimp|anchov|trout|salmon|tuna|swordfish|pike|herring|sardine|meat|chicken/i;
const NOTED_RE = /noted/i;
function coinsOf(s: Status): number {
    let total = 0;
    const inv = s.inventory;
    if (Array.isArray(inv)) for (let i = 0; i < inv.length; i++) if (inv[i]?.name === 'Coins') total += inv[i].count;
    const bank = s.bank;
    if (Array.isArray(bank)) for (let i = 0; i < bank.length; i++) if (bank[i]?.name === 'Coins') total += bank[i].count;
    return total;
}
function foodOf(l: any[] | null | undefined): number {
    if (!Array.isArray(l)) return 0;
    let total = 0;
    for (let i = 0; i < l.length; i++) {
        const it = l[i];
        if (it?.name && FOOD_RE.test(it.name) && !NOTED_RE.test(it.name)) total += it.count;
    }
    return total;
}
// Coins at the first status of each run (name + started), so "made this run" survives a dashboard restart only
// within one process; it restarts from the next status after that.
const runStartCoins = new Map<string, number>();
const sampleSessions = new Map<string, string>();
const samples = new Map<string, Sample[]>();
const spark = new Map<string, number[]>();
type Ev = { at: number; name: string; text: string };
const events: Ev[] = tailJsonl<Ev>(FILES.events, 200).reverse();
const lastPhase = new Map<string, string>();
const phaseSince = new Map<string, { at: number; exact: boolean }>();
for (const e of [...events].reverse()) phaseSince.set(e.name + NL + e.text, { at: e.at, exact: true });
function track(s: Status) {
    trackFlow(flows, s);
    const session = JSON.stringify([s.server, s.started ?? null]);
    if (sampleSessions.get(s.name) !== session) {
        samples.delete(s.name);
        spark.delete(s.name);
        sampleSessions.set(s.name, session);
    }
    const xp = (s.skills ?? []).reduce((n: number, k: any) => n + (k.xp ?? 0), 0);
    const sk: Record<string, number> = {};
    for (const k of s.skills ?? []) sk[k.name] = k.xp ?? 0;
    const list = samples.get(s.name) ?? [];
    // A status written before the game state loaded has 0 XP in every skill; as a sample it would make the next
    // real one look like a jump of the account's whole XP (214M xp/h on a level-99 thief).
    if (xp > 0 && (!list.length || list[list.length - 1]!.tick !== s.tick)) {
        const coins = coinsOf(s);
        list.push({ at: s.at, tick: s.tick, xp, sk, coins, food: foodOf(s.inventory) + foodOf(s.bank), bank: s.bank != null });
        const rk = s.name + '|' + s.started;
        // Only a status that lists the bank: before the first bank view, the whole old bank would count as "made".
        if (!runStartCoins.has(rk) && s.bank != null) runStartCoins.set(rk, coins);
        const r = rate(s.name, goalSkillOf(s), list);
        if (r != null && Date.now() - s.at < 20_000) { const sp = spark.get(s.name) ?? []; sp.push(Math.round(r * 10) / 10); if (sp.length > 60) sp.shift(); spark.set(s.name, sp); }
    }
    while (list.length > 2 && list[0]!.at < s.at - 120_000) list.shift();
    samples.set(s.name, list);
    const ph = s.phase ?? '';
    if (ph && lastPhase.get(s.name) !== ph) {
        if (lastPhase.has(s.name)) {
            phaseSince.delete(s.name + NL + lastPhase.get(s.name));
            const ev = { at: s.at, name: s.name, text: ph };
            events.unshift(ev);
            append(FILES.events, ev);
            phaseSince.set(s.name + NL + ph, { at: s.at, exact: true });
        } else if (!phaseSince.has(s.name + NL + ph)) phaseSince.set(s.name + NL + ph, { at: s.at, exact: false });
        lastPhase.set(s.name, ph);
        events.length = Math.min(events.length, 200);
    }
    trackResult(s);
}
// XP per tick over the last 2 minutes: of the goal skill when there is one, else of all skills.
function rate(name: string, skill: string | null, l = samples.get(name) ?? []) {
    if (l.length < 2) return null;
    const a = l[0]!, b = l[l.length - 1]!;
    const xa = skill ? a.sk[skill] ?? 0 : a.xp, xb = skill ? b.sk[skill] ?? 0 : b.xp;
    return b.tick > a.tick ? (xb - xa) / (b.tick - a.tick) : null;
}
// Coins and food per tick over the last 2 minutes (food is eaten: a positive number is food used per tick).
function flowRate(name: string, key: 'coins' | 'food') {
    const l = samples.get(name) ?? [];
    if (l.length < 2) return null;
    const a = l[0]!, b = l[l.length - 1]!;
    if (b.tick <= a.tick) return null;
    // Food is counted in the pack and the bank; a rise means a trade or a new bank view, not negative eating.
    if (key === 'food') return a.food >= b.food ? (a.food - b.food) / (b.tick - a.tick) : null;
    // Coins are counted in the pack and the bank; a bank that is known in only one sample is not income.
    if (a.bank !== b.bank) return null;
    return (b.coins - a.coins) / (b.tick - a.tick);
}
function goalSkillOf(s: Status): string | null {
    const known = SCRIPT_ROLE[String(s.goal ?? '')]?.skill ?? ROLE_SKILL[s.role];
    if (known) return known;
    if (NO_ROLE.has(s.role) && s.name.toLowerCase() !== MAIN.toLowerCase()) return inferRole(s, ranks.get(s.name)?.rows ?? []);
    return null;
}

// Practice bots: every status file that ever named a localhost server, including ones too old for the roster.
const practiceNames = (): Set<string> => {
    if (typeof statusCacheVersion === 'number') {
        if (cachedPracticeVersion !== statusCacheVersion) {
            const next = new Set<string>();
            for (const c of statusCache.values()) if (isLocalServer(c.doc.server)) next.add(c.doc.name);
            cachedPracticeSet = next;
            cachedPracticeVersion = statusCacheVersion;
        }
        return cachedPracticeSet;
    }
    const next = new Set<string>();
    for (const c of statusCache.values()) if (isLocalServer(c.doc.server)) next.add(c.doc.name);
    return next;
};

export {
    coinsOf,
    events,
    flowRate,
    flows,
    foodOf,
    phaseSince,
    practiceNames,
    rate,
    readStatuses,
    runStartCoins,
    spark,
};
