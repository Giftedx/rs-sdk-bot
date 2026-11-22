// Learning report: reads every run record on disk (live and practice) and writes research/learning-report.md and
// .practice/learning.json. Deterministic, no network. Run: bun scripts/learn.ts  (env LEARN_SCRATCH = log folder).
// Status files and swarm logs are overwritten when a bot restarts, so each run of this script also archives the
// current status of every bot in .practice/learning.json (runs + snapshots); later runs read that archive back.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const T0 = performance.now();
const ROOT = join(import.meta.dir, '..');
const P = (...a: string[]) => join(ROOT, ...a);
const SCRATCH = process.env.LEARN_SCRATCH
    ?? 'E:/moved/temp/claude/F--dev-on-f-osrs-rs-research-rs-sdk-bot/72e3d252-d3cd-4626-9f3d-241dd42da82c/scratchpad';
const LIVE_SERVER = 'rs-sdk-demo.fly.dev';
const LIVE_HOUR = 9000;                    // 3600 s / 0.4 s
const KINDS = ['xp', 'inventory', 'move', 'anim', 'dialog', 'stun', 'idle'] as const;
type Kind = typeof KINDS[number];
type Ledger = Partial<Record<Kind, number>>;
type Env = 'live' | 'practice';

const readText = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const jsonl = (f: string) => readText(f).split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
const json = (f: string) => { try { return JSON.parse(readText(f)); } catch { return null; } };
const safe = (s: string) => s.replace(/PASSWORD=\S*/g, 'PASSWORD=<hidden>');
const kv = (text: string) => { const o: Record<string, string> = {}; for (const m of text.matchAll(/(\w+)=(\S+)/g)) o[m[1]!] = m[2]!; return o; };
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
const sum = (l: Ledger) => KINDS.reduce((n, k) => n + (l[k] ?? 0), 0);
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const f1 = (n: number) => Number.isFinite(n) ? n.toFixed(1) : '-';
const f0 = (n: number) => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '-';
const pct = (a: number, b: number) => b ? (100 * a) / b : NaN;
const iso = (ms?: number) => ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '-';

// ---------- inputs ----------
const swarm = json(P('.practice/swarm-state.json'));
const jobByAccount = new Map<string, any>((swarm?.jobs ?? []).map((j: any) => [j.account, j]));
const statusDir = P('.practice/status');
const statuses: any[] = existsSync(statusDir) ? readdirSync(statusDir).filter(f => f.endsWith('.json')).map(f => json(join(statusDir, f))).filter(Boolean) : [];
const prev = json(P('.practice/learning.json'));
const archive: Record<string, any> = prev?.runs ?? {};
const snapshots: Record<string, any[]> = prev?.snapshots ?? {};
const liveNames = new Set<string>([...jobByAccount.keys(), ...statuses.filter(s => s.server === LIVE_SERVER).map(s => s.name), ...Object.values(archive).filter((r: any) => r.server === LIVE_SERVER).map((r: any) => r.name)]);
const results = jsonl(P('.practice/results.jsonl'));
const statusByName = new Map(statuses.map(s => [s.name, s]));
const events = jsonl(P('.practice/events.jsonl'));
const alerts = jsonl(P('.practice/alerts.jsonl'));
const ranks = jsonl(P('.practice/rank-history.jsonl'));
const vault = jsonl(P('.practice/vault-log.jsonl'));

// Script key from a RESULT text, a goal or an account. "-stable" copies count as the same script.
function scriptKey(text: string, goal = '', name = ''): string {
    const t = text;
    if (/\bFLOOR (\w+)/.test(t)) return 'floor-' + t.match(/\bFLOOR (\w+)/)![1]!.toLowerCase();
    if (/\bLEVELUP\b/.test(t)) return 'floor-levelup';
    if (/coinsPerTick=/.test(t) || /^gold farm/i.test(goal)) return 'goldfarm';
    if (/lobsterNotes=/.test(t) || /^courier/i.test(goal)) return 'gecourier';
    if (/attackXp=/.test(t)) return 'waterfall';
    if (/\bwoodcutting=\d/.test(t) || /^woodcutting/i.test(goal)) return 'woodcutting';
    if (/\bfishing=\d/.test(t) || /^fishing/i.test(goal)) return 'fishing30';
    if (/\bthieving=\d/.test(t) && !/^banker/i.test(goal) || /^thieving/i.test(goal)) return 'thieving60';
    if (/^banker/i.test(goal)) return 'banker';
    const g = goal.replace(/\.ts$/, '').replace(/-stable$/, '').replace(/\s*\(.*\)$/, '').trim();
    if (g && !/\s/.test(g)) return g;
    const job = jobByAccount.get(name);
    if (job?.script) return basename(job.script).replace(/\.ts$/, '').replace(/-stable$/, '');
    return g || 'unknown';
}
function scriptFile(key: string, name = ''): string | undefined {
    const job = jobByAccount.get(name);
    // The editable source first; live bots may run a frozen "-stable" copy of it.
    for (const c of [`scripts/generated/${key}.ts`, `scripts/${key}.ts`, `scripts/measure/${key}.ts`]) if (existsSync(P(c))) return c;
    return job?.script && existsSync(P(job.script)) ? job.script : undefined;
}
const fileCache = new Map<string, string[]>();
function findLine(file: string | undefined, pats: (string | RegExp)[]): string | undefined {
    if (!file) return undefined;
    if (!fileCache.has(file)) fileCache.set(file, readText(P(file)).split('\n'));
    const lines = fileCache.get(file)!;
    for (const p of pats) {
        const i = lines.findIndex(l => typeof p === 'string' ? l.includes(p) : p.test(l));
        if (i >= 0) return `${file}:${i + 1} \`${lines[i]!.trim().slice(0, 110).replace(/`/g, "'")}\``;
    }
    return undefined;
}
const phaseKey = (p = '') => /^t=\d+/.test(p) ? 'loop' : (p.trim().split(/\s+/)[0] ?? '') || 'start';
function phaseLine(file: string | undefined, phase: string) {
    if (phase === 'start') return 'no milestone yet (run start or resume)';
    if (phase === 'loop') return findLine(file, ['MILESTONE t=']);
    if (/^level\d+$/.test(phase)) return findLine(file, ['mark(`level', 'MILESTONE level']);
    if (/^fishing\d+$/.test(phase)) return findLine(file, ['mark("fishing', 'mark(`fishing']);
    return findLine(file, [`MILESTONE ${phase}`, `mark('${phase}')`, `mark("${phase}")`, phase]);
}

// ---------- run records ----------
interface Run {
    src: string; name: string; script: string; env: Env; ok: boolean | null; at: number; ticks: number;
    xp?: number; text: string; reason?: string; ledger?: Ledger; milestones: { name: string; tick: number }[];
    idle: { len: number; tick: number; x: number; z: number; phase: string }[]; combos?: any[]; strip?: string; role?: string;
}
const runs: Run[] = [];
function parseResult(text: string) {
    const o = kv(text);
    const ok = /^ok\b/.test(text);
    const reason = ok ? undefined : text.replace(/^fail\s*/, '').split(/\s\w+=/)[0]!.trim().slice(0, 60);
    const ticks = num(o.ticks) ?? 0;
    const xp = num(o.xp) ?? num(o.gained) ?? (num(o.attackXp) !== undefined ? (num(o.attackXp)! + (num(o.strengthXp) ?? 0)) : undefined);
    const ms = (o.milestones ?? '').split(',').flatMap(m => { const [n, t] = m.split('@'); return t && /^\d+$/.test(t) ? [{ name: n!, tick: +t }] : []; });
    return { ok, reason, ticks, xp, ms, o };
}
function ledgerFrom(line: string): { l: Ledger; ticks: number; streaks: { len: number; tick: number; x: number; z: number }[]; bot?: string } {
    const o = kv(line);
    const l: Ledger = {};
    for (const k of KINDS) l[k] = num(o[k]) ?? 0;
    const streaks = [...(o.longestIdle ?? '').matchAll(/(\d+)@t(\d+)\((\d+),(\d+)\)/g)].map(m => ({ len: +m[1]!, tick: +m[2]!, x: +m[3]!, z: +m[4]! }));
    return { l, ticks: num(o.ticks) ?? sum(l), streaks, bot: o.bot };
}
const milestoneOf = (line: string) => {
    const toks = line.replace(/^MILESTONE\s+/, '').split(/\s+/);
    if (/^t=\d+$/.test(toks[0] ?? '')) return { name: 'loop', tick: +toks[0]!.slice(2) };
    const i = toks.findIndex(t => /^\d+$/.test(t));
    return i > 0 ? { name: toks.slice(0, i).join(' '), tick: +toks[i]! } : { name: toks.join(' '), tick: -1 };
};
const phaseAt = (ms: { name: string; tick: number }[], t: number) => {
    let best = 'start', bt = -2;
    for (const m of ms) if (m.tick <= t && m.tick >= bt) { best = phaseKey(m.name); bt = m.tick; }
    return best;
};

// Script of a log run: the file name first (one log = one script), then the bot's status goal, then the RESULT text.
const LOG_MAP: [RegExp, string][] = [
    [/^(banker|moneyshot)/, 'banker'], [/^(courier|bigpackage|gecourier)/, 'gecourier'], [/^(woodpecker|woodcutting)/, 'woodcutting'],
    [/^(mightyrod|live-mr|fishing30|gated3|last-run)/, 'fishing30'], [/^(live-(th|pr|py)|th\d|th60|knights|kh-|gd-|gl-|wa-|es-|pc-|ph-|pl-)/, 'thieving60'],
    [/^waterfall/, 'waterfall'], [/^(proven|gather)/, 'gather'], [/^(floors|fl-)/, 'floors'], [/^(mi-|mj-)/, 'mining'],
    [/^cake/, 'cakestall'], [/^boat/, 'boat'], [/^travel/, 'travel'], [/^(force-|live-(wc|fish|mine))/, 'revents'],
];
function logScript(base: string, text: string, name: string) {
    const hit = LOG_MAP.find(([re]) => re.test(base));
    if (hit) return hit[1];
    const g = (statusByName.get(name) ?? (Object.values(archive) as any[]).find(a => a.name === name))?.goal;
    const k = scriptKey(text, g ?? '', name);
    return k === 'unknown' ? base.replace(/[-_]?[a-z]?\d*$/, '') : k;
}

// 1. Run logs (scratchpad *.log, swarm-logs). Only top-level *.log files: the scratchpad subfolders hold 100+ MB.
const logFiles: string[] = [];
for (const d of [SCRATCH, P('.practice/swarm-logs')]) if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith('.log')) logFiles.push(join(d, f));
let logLines = 0;
for (const f of logFiles) {
    const st = statSync(f);
    if (st.size > 5_000_000) continue;
    const lines = readText(f).split('\n');
    logLines += lines.length;
    const base = basename(f, '.log');
    const preset = lines.some(l => /^BOT .*preset=/.test(l));
    const fileLive = base.startsWith('live-') && !preset;
    let name = '', ms: { name: string; tick: number }[] = [], last: Run | undefined;
    const seen = new Set<string>();
    // Proof logs print one run per line as a tail: "PASS 323s ERR-TRACE opening x | START ... | RESULT ok ...".
    const segs: string[] = [];
    for (const raw of lines) {
        if (raw.includes(' | ') && /\b(PASS|FAIL) [\d.]+s\b/.test(raw)) {
            segs.push('#RUN');
            for (const p of raw.split(' | ')) segs.push(p.replace(/^.*?\b(PASS|FAIL) [\d.]+s\s*/, '').trim());
        } else segs.push(raw);
    }
    for (const raw of segs) {
        if (raw === '#RUN') { ms = []; last = undefined; name = ''; continue; }
        const line = raw.trimEnd();
        if (!line || seen.has(line) && /^(RESULT|LEDGER) /.test(line)) continue;
        seen.add(line);
        let m: RegExpMatchArray | null;
        if ((m = line.match(/^ERR-TRACE opening (\S+)/)) || (m = line.match(/^BOT (\S+)/)) || (m = line.match(/^\[lite\] (\S+?):/))) {
            name = m[1]!;
            if (last && !last.name) { last.name = name; if (liveNames.has(name)) last.env = 'live'; }
        }
        if (/^Pathfinding initialized|^START /.test(line) && last) { ms = []; last = undefined; }
        if (line.startsWith('MILESTONE ')) ms.push(milestoneOf(line));
        if (line.startsWith('RESULT ')) {
            const text = line.slice(7);
            const r = parseResult(text);
            const nm = name || (jobByAccount.has(base) ? base : '');
            last = {
                src: `log:${base}`, name: nm, script: logScript(base, text, nm), env: (liveNames.has(nm) || fileLive) ? 'live' : 'practice',
                ok: r.ok, at: st.mtimeMs, ticks: r.ticks, xp: r.xp, text, reason: r.reason, milestones: r.ms.length ? r.ms : [...ms], idle: [],
            };
            runs.push(last);
        }
        if (line.startsWith('LEDGER ')) {
            const L = ledgerFrom(line);
            const tgt = last && !last.ledger ? last : undefined;
            const nm = L.bot ?? name;
            const r: Run = tgt ?? { src: `log:${base}`, name: nm, script: logScript(base, '', nm), env: liveNames.has(nm) || fileLive ? 'live' : 'practice', ok: null, at: st.mtimeMs, ticks: L.ticks, text: '', milestones: [...ms], idle: [] };
            if (!tgt) runs.push(r);
            if (L.bot) { r.name = L.bot; if (liveNames.has(L.bot)) r.env = 'live'; }
            r.ledger = L.l;
            r.ticks ||= L.ticks;
            r.idle = L.streaks.map(s => ({ len: s.len, tick: s.tick, x: s.x, z: s.z, phase: phaseAt(r.milestones, s.tick) }));
        }
    }
}

// 2. results.jsonl (deduplicated), joined with the status file of the same run for its ledger and inputs.
const seenRes = new Set<string>();
for (const r of results) {
    const k = `${r.name}|${r.text}`;
    if (seenRes.has(k)) continue;
    seenRes.add(k);
    const p = parseResult(r.text ?? '');
    const s = statusByName.get(r.name) ?? Object.values(archive).find((a: any) => a.name === r.name && a.result && r.text.startsWith(a.result.slice(0, 40)));
    const joined = s && s.result && (s.result.slice(0, 60) === r.text.slice(0, 60));
    // Skip a results.jsonl row that a log already gave (same bot, same ticks, same verdict).
    if (runs.some(x => x.name === r.name && x.ticks === p.ticks && x.ok === p.ok && x.src.startsWith('log:'))) continue;
    runs.push({
        src: 'results', name: r.name, script: scriptKey(r.text, r.goal, r.name), env: liveNames.has(r.name) ? 'live' : 'practice', ok: p.ok, at: r.at, ticks: p.ticks, xp: p.xp,
        text: r.text, reason: p.reason, milestones: p.ms, idle: [], ledger: joined ? s.ledger : undefined, combos: joined ? s.inputs?.combos : undefined, strip: joined ? s.inputs?.strip : undefined,
    });
}

// 3. Status files: archive every bot's latest state, then add the in-progress (and archived) runs.
const nowMs = Date.now();
for (const s of statuses) {
    const key = `${s.name}|${s.started}`;
    const xpTotal = (s.skills ?? []).reduce((n: number, k: any) => n + (k.xp ?? 0), 0);
    archive[key] = {
        name: s.name, server: s.server, goal: s.goal, role: s.role, started: s.started, at: s.at, tick: s.tick, phase: s.phase, result: s.result ?? '',
        ledger: s.ledger, timeline: s.timeline, pos: s.pos, combos: s.inputs?.combos, strip: s.inputs?.strip, xpTotal,
        skills: Object.fromEntries((s.skills ?? []).filter((k: any) => k.xp > 0).map((k: any) => [k.name, k.xp])),
    };
    const snap = (snapshots[key] ??= []);
    const tl = String(s.timeline ?? '');
    const tlCount = Object.fromEntries(['x', 'v', 'm', 'a', 'd', 's', 'i'].map(c => [c, tl.split(c).length - 1]));
    if (!snap.length || snap[snap.length - 1].tick !== s.tick) snap.push({ at: s.at, tick: s.tick, phase: s.phase, xpTotal, skills: archive[key].skills, ledger: s.ledger, pos: s.pos, tl: { len: tl.length, ...tlCount } });
    if (snap.length > 400) snap.splice(0, snap.length - 400);
}
// Keep the archive bounded: the 600 newest runs.
const keys = Object.keys(archive).sort((a, b) => (archive[b].at ?? 0) - (archive[a].at ?? 0));
for (const k of keys.slice(600)) { delete archive[k]; delete snapshots[k]; }
const archived = Object.values(archive) as any[];
const timelineIdle: { name: string; script: string; env: Env; len: number; x: number; z: number; phase: string }[] = [];
for (const a of archived) {
    if (!a.ledger) continue;
    const env: Env = a.server === LIVE_SERVER ? 'live' : 'practice';
    const script = scriptKey(a.result ?? '', a.goal ?? '', a.name);
    const trail = (a.timeline ?? '').match(/i+$/)?.[0].length ?? 0;
    if (trail >= 3 && a.pos) timelineIdle.push({ name: a.name, script, env, len: trail, x: a.pos.x, z: a.pos.z, phase: phaseKey(a.phase) });
    // A run already counted from a log or results.jsonl keeps that record; attach the inputs data to it.
    const dup = runs.find(r => r.name === a.name && (Math.abs(r.ticks - a.tick) <= 20 || (!!a.result && r.text.slice(0, 50) === a.result.slice(0, 50))));
    if (dup) { dup.ledger ??= a.ledger; dup.combos ??= a.combos; dup.strip ??= a.strip; continue; }
    const res = a.result ? parseResult(a.result) : undefined;
    runs.push({
        src: a.result ? 'status' : 'status:running', name: a.name, script, env, ok: res ? res.ok : null, at: a.at, ticks: a.tick,
        xp: res?.xp ?? (a.combos ? a.combos.reduce((n: number, c: any) => n + (c.xp ?? 0), 0) : undefined),
        text: a.result ?? '', reason: res?.reason, ledger: a.ledger, milestones: [], idle: [], combos: a.combos, strip: a.strip, role: a.role,
    });
}
for (const r of runs) r.role ??= jobByAccount.get(r.name)?.role ?? statusByName.get(r.name)?.role;
// Alerts with an idle streak: live, located, with the phase in brackets.
const alertIdle = alerts.flatMap(a => {
    const m = String(a.text ?? '').match(/idle (\d+) ticks in a row at (\d+),(\d+) \(([^)]*)\)/);
    return m ? [{ name: a.bot as string, len: +m[1]!, x: +m[2]!, z: +m[3]!, phase: phaseKey(m[4]), at: a.at as number }] : [];
});

// ---------- per script ----------
const XP_SCRIPTS = new Set(['fishing30', 'woodcutting', 'thieving60']);
type Unit = { name: string; value: number; better: 'low' | 'high' };
function unitOf(r: Run): Unit | undefined {
    const o = kv(r.text);
    if (num(o.coinsPerTick) !== undefined) return { name: 'coins/tick', value: num(o.coinsPerTick)!, better: 'high' };
    if (num(o.perTick) !== undefined && r.script !== 'floor-herblore') return { name: 'xp/tick', value: num(o.perTick)!, better: 'high' };
    if (XP_SCRIPTS.has(r.script) && r.xp && r.xp > 0 && r.ticks > 0) return { name: 'ticks/1k XP', value: (r.ticks * 1000) / r.xp, better: 'low' };
    if (r.ok && r.ticks > 0) return { name: 'ticks/run', value: r.ticks, better: 'low' };
    return undefined;
}
const byScript = new Map<string, Run[]>();
for (const r of runs) { if (!byScript.has(r.script)) byScript.set(r.script, []); byScript.get(r.script)!.push(r); }
interface Stat { script: string; env: Env; runs: number; done: number; pass: number; unit?: string; median?: number; best?: number; trend: string; shares: Ledger; ledgerTicks: number; regressions: string[]; values: number[] }
const stats: Stat[] = [];
for (const [script, rs] of byScript) for (const env of ['live', 'practice'] as Env[]) {
    const list = rs.filter(r => r.env === env).sort((a, b) => a.at - b.at);
    if (!list.length) continue;
    const done = list.filter(r => r.ok !== null);
    const units = done.map(r => ({ r, u: unitOf(r) })).filter(x => x.u);
    const uname = units.length ? (Object.entries(units.reduce((m: Record<string, number>, x) => (m[x.u!.name] = (m[x.u!.name] ?? 0) + 1, m), {})).sort((a, b) => b[1] - a[1])[0]![0]) : undefined;
    const vals = units.filter(x => x.u!.name === uname);
    const better = vals[0]?.u!.better ?? 'low';
    const v = vals.map(x => x.u!.value);
    const worse = (a: number, b: number) => better === 'low' ? a > b * 1.1 : a < b / 1.1;   // a worse than b by >10%
    const regressions: string[] = [];
    // Compare like with like: same variant (mode, bench route, target level), passed runs only.
    const variant = (r: Run) => { const o = kv(r.text); return o.mode ?? (r.script === 'bench' ? r.text.split(/\s+/).slice(1, 3).join(' ') : `${o.target ?? ''}`); };
    const groups = new Map<string, typeof vals>();
    for (const x of vals) if (x.r.ok) { const k = variant(x.r); groups.set(k, [...(groups.get(k) ?? []), x]); }
    for (const [k, g] of groups) for (let i = 3; i < g.length; i++) {
        const ref = median(g.slice(i - 3, i).map(x => x.u!.value));
        if (worse(g[i]!.u!.value, ref)) regressions.push(`${g[i]!.r.name} ${iso(g[i]!.r.at)}${k ? ` [${k}]` : ''}: ${f1(g[i]!.u!.value)} vs ${f1(ref)} (median of the 3 before)`);
    }
    let trend = 'n<4';
    if (v.length >= 4) {
        const h = v.length >> 1, a = median(v.slice(0, h)), b = median(v.slice(h));
        const ch = better === 'low' ? (a - b) / a : (b - a) / a;
        trend = Math.abs(ch) < 0.05 ? `flat (${f1(a)} -> ${f1(b)})` : `${ch > 0 ? 'better' : 'worse'} ${f0(Math.abs(ch) * 100)}% (${f1(a)} -> ${f1(b)})`;
    }
    const shares: Ledger = {}; let lt = 0;
    for (const r of list) if (r.ledger) { for (const k of KINDS) shares[k] = (shares[k] ?? 0) + (r.ledger[k] ?? 0); lt += sum(r.ledger); }
    stats.push({
        script, env, runs: list.length, done: done.length, pass: done.filter(r => r.ok).length, unit: uname, median: median(v),
        best: v.length ? (better === 'low' ? Math.min(...v) : Math.max(...v)) : undefined, trend, shares, ledgerTicks: lt, regressions, values: v,
    });
}
stats.sort((a, b) => b.ledgerTicks - a.ledgerTicks || b.runs - a.runs);

// ---------- idle hotspots (8x8 tile cells) ----------
interface Spot { cell: string; x: number; z: number; live: number; practice: number; n: number; phases: Map<string, number>; scripts: Set<string>; bots: Set<string>; helper: boolean; liveBy: Map<string, number>; liveBots: Set<string> }
const spots = new Map<string, Spot>();
const helperRole = (n: string, r?: string) => ['bank', 'helper'].includes(r ?? jobByAccount.get(n)?.role ?? '');
function addSpot(x: number, z: number, len: number, env: Env, phase: string, script: string, bot: string, role?: string) {
    if (len < 3) return;
    const cell = `${x >> 3 << 3},${z >> 3 << 3}`;
    const s = spots.get(cell) ?? { cell, x, z, live: 0, practice: 0, n: 0, phases: new Map(), scripts: new Set(), bots: new Set(), helper: false, liveBy: new Map(), liveBots: new Set() };
    s[env] += len; s.n++; s.phases.set(phase, (s.phases.get(phase) ?? 0) + len); s.scripts.add(script); s.bots.add(bot);
    if (env === 'live') { const k = `${script}|${phase}`; s.liveBy.set(k, (s.liveBy.get(k) ?? 0) + len); s.liveBots.add(bot); }
    if (helperRole(bot, role)) s.helper = true;
    spots.set(cell, s);
}
for (const r of runs) for (const i of r.idle) addSpot(i.x, i.z, i.len, r.env, i.phase, r.script, r.name, r.role);
for (const t of timelineIdle) addSpot(t.x, t.z, t.len, t.env, t.phase, t.script, t.name);
for (const a of alertIdle) addSpot(a.x, a.z, a.len, 'live', a.phase, scriptKey('', '', a.name), a.name);
const spotList = [...spots.values()].sort((a, b) => b.live - a.live || b.practice - a.practice);
const topPhase = (s: Spot) => [...s.phases].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-';

// ---------- action combos ----------
const combo = new Map<string, { script: string; k: string; n: number; xp: number; bots: Set<string> }>();
for (const r of runs) for (const c of r.combos ?? []) {
    const key = `${r.script}|${c.k}`;
    const e = combo.get(key) ?? { script: r.script, k: c.k, n: 0, xp: 0, bots: new Set() };
    e.n += c.n; e.xp += c.xp; e.bots.add(r.name); combo.set(key, e);
}
const comboList = [...combo.values()].filter(c => c.n >= 20 && c.k !== 'none').map(c => ({ ...c, perTick: c.xp / c.n })).sort((a, b) => b.perTick - a.perTick);
const stripStats = new Map<string, { ticks: number; zero: number; inputs: number }>();
for (const r of runs) if (r.strip) {
    const e = stripStats.get(r.script) ?? { ticks: 0, zero: 0, inputs: 0 };
    for (const ch of r.strip) { e.ticks++; if (ch === '0') e.zero++; e.inputs += +ch; }
    stripStats.set(r.script, e);
}

// ---------- milestone pace (ticks per level band) ----------
interface Pace { name: string; env: Env; script: string; from: string; to: string; ticks: number; src: string }
const pace: Pace[] = [];
function addPace(name: string, env: Env, script: string, ms: { name: string; tick: number }[], src: string) {
    const lv = ms.filter(m => /^(level|fishing)\d+$/.test(m.name) && m.tick > 0).sort((a, b) => a.tick - b.tick);
    // A resumed run marks every level it already has at its first check: skip the band that starts there.
    const resumed = lv.length > 0 && +lv[0]!.name.replace(/\D/g, '') > 30;
    for (let i = resumed ? 2 : 1; i < lv.length; i++) if (lv[i]!.tick > lv[i - 1]!.tick) pace.push({ name, env, script, from: lv[i - 1]!.name, to: lv[i]!.name, ticks: lv[i]!.tick - lv[i - 1]!.tick, src });
}
for (const r of runs) if (r.milestones.length) addPace(r.name || r.src, r.env, r.script, r.milestones, r.src);
{   // events.jsonl: split a bot's milestones into runs where the tick falls back.
    const per = new Map<string, { name: string; tick: number }[][]>();
    for (const e of events) {
        const m = milestoneOf('MILESTONE ' + e.text);
        if (m.tick < 0) continue;
        const l = per.get(e.name) ?? [[]]; const cur = l[l.length - 1]!;
        if (cur.length && m.tick < cur[cur.length - 1]!.tick) l.push([]);
        l[l.length - 1]!.push(m); per.set(e.name, l);
    }
    for (const [name, segs] of per) segs.forEach((s, i) => addPace(name, liveNames.has(name) ? 'live' : 'practice', scriptKey('', '', name), s, `events run ${i + 1}`));
}
// Gold farm live: coins per tick from the "t=N banked=B packCoins=P" milestones (start coins not subtracted).
const gold: { name: string; t: number; coins: number; perTick: number; at: number }[] = [];
for (const e of events) { const m = String(e.text).match(/^t=(\d+) banked=(\d+) packCoins=(\d+)/); if (m) gold.push({ name: e.name, t: +m[1]!, coins: +m[2]! + +m[3]!, perTick: (+m[2]! + +m[3]!) / +m[1]!, at: e.at }); }

// Per-phase XP rate from archived snapshots of the same run (phase unchanged between two snapshots).
const phaseRate = new Map<string, { name: string; phase: string; ticks: number; xp: number }>();
for (const [key, snap] of Object.entries(snapshots)) for (let i = 1; i < snap.length; i++) {
    const a = snap[i - 1], b = snap[i];
    if (phaseKey(a.phase) !== phaseKey(b.phase) || b.tick <= a.tick) continue;
    const k = `${key.split('|')[0]}|${phaseKey(b.phase)}`;
    const e = phaseRate.get(k) ?? { name: key.split('|')[0]!, phase: phaseKey(b.phase), ticks: 0, xp: 0 };
    e.ticks += b.tick - a.tick; e.xp += Math.max(0, b.xpTotal - a.xpTotal); phaseRate.set(k, e);
}

// ---------- data gaps ----------
const stamps = [...results.map(r => r.at), ...events.map(e => e.at), ...alerts.map(a => a.at), ...ranks.map(r => r.at), ...statuses.map(s => s.at)].filter(Boolean).sort((a, b) => a - b);
const gaps: { from: number; to: number; min: number }[] = [];
for (let i = 1; i < stamps.length; i++) if (stamps[i]! - stamps[i - 1]! > 8 * 60_000 && stamps[i]! - stamps[0]! > 0) gaps.push({ from: stamps[i - 1]!, to: stamps[i]!, min: (stamps[i]! - stamps[i - 1]!) / 60_000 });
gaps.sort((a, b) => b.min - a.min);

// ---------- next fixes ----------
const MIN_LEDGER = 500;   // a script needs this many live ledger ticks before its shares rank as fixes
const timelineIdleByPhase = new Map<string, number>();
for (const a of archived) if (a.server === LIVE_SERVER && a.timeline) {
    const k = `${scriptKey(a.result ?? '', a.goal ?? '', a.name)}|${phaseKey(a.phase)}`;
    timelineIdleByPhase.set(k, (timelineIdleByPhase.get(k) ?? 0) + (a.timeline.match(/i/g)?.length ?? 0));
}
interface Fix { title: string; script: string; perHour: number; evidence: string; line?: string; accepted?: boolean }
const fixes: Fix[] = [];
for (const st of stats.filter(s => s.env === 'live' && s.ledgerTicks > 0)) {
    const liveRuns = runs.filter(r => r.script === st.script && r.env === 'live');
    if (liveRuns.every(r => helperRole(r.name, r.role))) continue;   // helpers and the banker have no board clock
    if (st.ledgerTicks < MIN_LEDGER) continue;
    const file = scriptFile(st.script, liveRuns.find(r => jobByAccount.has(r.name))?.name);
    const T = st.ledgerTicks, h = (n: number) => (n / T) * LIVE_HOUR;
    const bots = [...new Set(liveRuns.map(r => r.name).filter(Boolean))].join(', ');
    // Located idle (live hotspots of this script, split by phase) and the rest.
    const mine = spotList.flatMap(s => s.helper ? [] : [...s.liveBy].filter(([k]) => k.startsWith(st.script + '|')).map(([k, t]) => ({ s, phase: k.split('|')[1]!, t })))
        .sort((a, b) => b.t - a.t).slice(0, 3);
    let located = 0;
    for (const { s, phase, t: t0 } of mine) {
        const t = Math.min(t0, (st.shares.idle ?? 0) - located);
        if (t <= 0) break;
        located += t;
        fixes.push({ title: `idle at ${s.cell} (+8 tiles) in phase "${phase}"`, script: st.script, perHour: h(t), evidence: `${t} live idle ticks in streaks >= 3 there; live bots ${[...s.liveBots].join(', ')}; ${T} live ledger ticks`, line: phaseLine(file, phase) });
    }
    const rest = Math.max(0, (st.shares.idle ?? 0) - located);
    const tlPhase = [...timelineIdleByPhase].filter(([k]) => k.startsWith(st.script + '|')).sort((a, b) => b[1] - a[1])[0];
    if (rest > 0) fixes.push({
        title: `idle in short streaks${tlPhase ? ` (timelines: most in phase "${tlPhase[0].split('|')[1]}")` : ''}`, script: st.script, perHour: h(rest),
        evidence: `ledger idle ${st.shares.idle} of ${T} (${f1(pct(st.shares.idle ?? 0, T))}%), ${located} located${tlPhase ? `; ${tlPhase[1]} idle of the last-300-tick timelines in that phase` : ''}; bots ${bots}`,
        line: tlPhase ? phaseLine(file, tlPhase[0].split('|')[1]!) : undefined,
    });
    if ((st.shares.dialog ?? 0) > 0) fixes.push({ title: 'dialog open (level-up pages, random events, NPC chat)', script: st.script, perHour: h(st.shares.dialog!), evidence: `ledger dialog ${st.shares.dialog} of ${T} (${f1(pct(st.shares.dialog!, T))}%)`, line: findLine(file, [/closeModal|continueDialog|clickDialog|dialog\??\.isOpen/]) ?? 'packages/core/src/randomevents.ts (not verified as the cause)' });
    const prac = stats.find(s => s.script === st.script && s.env === 'practice' && s.ledgerTicks > 0);
    const liveMove = pct(st.shares.move ?? 0, T), pracMove = prac ? pct(prac.shares.move ?? 0, prac.ledgerTicks) : NaN;
    if (prac && liveMove > pracMove) fixes.push({ title: `move share ${f1(liveMove)}% live vs ${f1(pracMove)}% practice`, script: st.script, perHour: ((liveMove - pracMove) / 100) * LIVE_HOUR, evidence: `ledger move ${st.shares.move} of ${T} live; practice ${prac.shares.move} of ${prac.ledgerTicks}`, line: findLine(file, ['walkTo(', 'walk(']) });
    if ((st.shares.stun ?? 0) > 0) fixes.push({ title: 'stun wait (accepted mechanic; only RELOG or eat-in-stun can cut it)', script: st.script, perHour: h(st.shares.stun!), evidence: `ledger stun ${st.shares.stun} of ${T}`, line: findLine(file, [/stun/i]), accepted: true });
}
fixes.sort((a, b) => Number(!!a.accepted) - Number(!!b.accepted) || b.perHour - a.perHour);
// Failed live runs, by reason. Not ticks lost (the XP of a failed run still counts); a stop file is an operator stop.
const failures: { script: string; reason: string; runs: number; ticks: number; total: number; example: string; line?: string }[] = [];
for (const [script, rs] of byScript) {
    const live = rs.filter(r => r.env === 'live' && r.ok !== null && !helperRole(r.name, r.role));
    const total = live.reduce((n, r) => n + r.ticks, 0);
    const byReason = new Map<string, Run[]>();
    for (const r of live.filter(r => r.ok === false && !/^stop file/.test(r.reason ?? ''))) { const k = (r.reason ?? '?').replace(/\d+/g, 'N'); byReason.set(k, [...(byReason.get(k) ?? []), r]); }
    for (const [reason, l] of byReason) {
        const word = reason.split(/\s+/).slice(0, 2).join(' ').replace(/\s*N\s*/g, ' ').trim();
        failures.push({ script, reason, runs: l.length, ticks: l.reduce((n, r) => n + r.ticks, 0), total, example: safe(l[0]!.text).slice(0, 140), line: findLine(scriptFile(script, l[0]!.name), [`'${word}`, `\`${word}`, word]) });
    }
}
failures.sort((a, b) => b.ticks - a.ticks);

// ---------- checks (hand-verified facts) ----------
const checks: { fact: string; data: string; pass: boolean; note?: string }[] = [];
{
    const g = gold.filter(x => liveNames.has(x.name));
    // The mark with the largest t per bot: the longest run. A restarted run starts again at t=1000 with its start coins in the pack.
    const lastPer = new Map<string, typeof g[0]>(); for (const x of g) if (!lastPer.has(x.name) || x.t > lastPer.get(x.name)!.t) lastPer.set(x.name, x);
    const vals = [...lastPer.values()].filter(x => x.t >= 2000);
    const lo = Math.min(...vals.map(x => x.perTick)), hi = Math.max(...vals.map(x => x.perTick));
    const goldRuns = runs.filter(r => r.script === 'goldfarm' && r.env === 'live' && r.ledger);
    const idleP = goldRuns.map(r => pct(r.ledger!.idle ?? 0, sum(r.ledger!)));
    // Agree when each measured value is within 0.5 coins/tick and 2 points of idle of the stated range.
    const coinOk = vals.length > 0 && lo >= 13.3 && hi <= 15.2, idleOk = idleP.length > 0 && idleP.every(p => p >= 14 && p <= 20);
    checks.push({ fact: 'Gold farm live: 13.8-14.7 coins per tick, idle 16-18%', data: `coins/tick (banked + pack, start coins not subtracted) ${vals.map(x => `${x.name} ${f1(x.perTick)} (t=${x.t})`).join(', ') || 'no t>=2000 lines'}; ledger idle ${goldRuns.map((r, i) => `${r.name} ${f1(idleP[i]!)}% of ${sum(r.ledger!)}`).join(', ')}`, pass: coinOk && idleOk, note: coinOk !== idleOk ? 'partly' : undefined });
    const bc = pace.filter(p => p.name === 'Bigchopper');
    const bcRun = archived.filter(a => a.name === 'Bigchopper').sort((a, b) => b.tick - a.tick)[0];
    checks.push({ fact: 'Bigchopper woodcutting rate', data: `milestone bands ${bc.map(p => `${p.from}->${p.to} ${p.ticks}`).join(', ') || 'none'}; largest archived status: WC xp ${bcRun?.skills?.Woodcutting ?? '-'} at tick ${bcRun?.tick ?? '-'}`, pass: bc.length > 0 });
    const mr = archived.filter(a => a.name === 'Mightyrod').sort((a, b) => b.at - a.at)[0];
    const xs = (mr?.timeline ?? '').split('').filter((c: string) => c === 'x').length;
    const pr = phaseRate.get(`Mightyrod|${phaseKey(mr?.phase)}`);
    // The feather trip starts at "MILESTONE junk-sold <tick>". Ledger xp counts ticks with any XP gain.
    const trips = Object.entries(snapshots).filter(([k]) => k.startsWith('Mightyrod|')).map(([k, l]) => {
        const inPhase = l.filter(s => phaseKey(s.phase) === 'junk-sold');
        if (!inPhase.length) return undefined;
        const start = num(String(inPhase[0].phase).split(/\s+/)[1]) ?? 0, last = inPhase[inPhase.length - 1];
        return { run: k.split('|')[1], start, last: last.tick, xpTicks: last.ledger?.xp ?? NaN, xpGain: last.xpTotal - inPhase[0].xpTotal, firstTick: inPhase[0].tick, pts: inPhase.map((s: any) => `t${s.tick} xpTicks=${s.ledger?.xp}`).join(' ') };
    }).filter(Boolean) as any[];
    const zeroTrip = trips.find(t => t.last - t.start >= 300 && t.xpTicks <= 5);
    checks.push({
        fact: 'Mightyrod 0 XP/h on a feather trip',
        data: trips.map(t => `run ${iso(+t.run)}: phase junk-sold from tick ${t.start} to >= ${t.last} (${t.last - t.start} ticks); ${t.pts}; XP +${f0(t.xpGain)} between t${t.firstTick} and t${t.last}`).join('; ') +
            ` (latest status: phase "${mr?.phase}" tick ${mr?.tick}, ${xs} xp ticks in the last ${(mr?.timeline ?? '').length}). The label stays "junk-sold" until the next milestone, so the trip end is not marked.`,
        pass: !!zeroTrip,
    });
}

// ---------- write ----------
const liveTicks = stats.filter(s => s.env === 'live').reduce((n, s) => n + s.ledgerTicks, 0);
const out: string[] = [];
const row = (...c: (string | number)[]) => out.push(`| ${c.join(' | ')} |`);
out.push('# Learning report', '', `Generated by \`bun scripts/learn.ts\` at ${new Date(nowMs).toISOString()}. Do not edit by hand; run the script again.`, '',
    'Sources: `.practice/results.jsonl`, `.practice/status/*.json` (archived into `.practice/learning.json` on every run), `.practice/events.jsonl`,',
    '`.practice/alerts.jsonl`, `.practice/rank-history.jsonl`, `.practice/vault-log.jsonl`, the session scratchpad `*.log` and `.practice/swarm-logs/*.log`.',
    `Read: ${results.length} result rows, ${statuses.length} status files, ${events.length} events, ${alerts.length} alerts, ${ranks.length} rank rows, ${vault.length} vault rows, ${logFiles.length} logs (${logLines} lines). ` +
    `Archive: ${archived.length} runs, ${Object.values(snapshots).reduce((n, s) => n + s.length, 0)} snapshots.`, '',
    'Units are ticks (live 400 ms, practice 150 ms). One live hour = 9,000 ticks. Evidence level: MEASURED live for `live`, MEASURED practice for `practice`.',
    'Ledger shares come from `LEDGER` lines and status ledgers; a run without one counts in runs and pass rate only. "Script line" is a text match on the phase name or the fail reason: a lead, not a proof.', '');
out.push('## Next fixes, ranked by ticks lost per live hour', '', `Per bot: the share of that script's live ledger ticks (${f0(liveTicks)} live ledger ticks in all), times 9,000. Accepted mechanics (stun) are listed last.`, '');
row('#', 'Script', 'Cause', 'Ticks / live h', 'Evidence', 'Script line (lead)'); row('---', '---', '---', '---', '---', '---');
fixes.slice(0, 15).forEach((f, i) => row(i + 1, f.script, f.title, f0(f.perHour), f.evidence.replace(/\|/g, '/'), (f.line ?? 'not found').replace(/\|/g, '/')));
out.push('', '## Checks against hand-verified facts', '');
row('Fact', 'What the data gives', 'Agrees'); row('---', '---', '---');
for (const c of checks) row(c.fact, c.data.replace(/\|/g, '/'), c.pass ? 'yes' : c.note ?? 'NO');
out.push('', '## Failed live runs (ticks in the failed runs; not all of them are lost, the XP stays)', '');
row('Script', 'Reason', 'Runs', 'Ticks', 'Of live ticks', 'Example', 'Script line (lead)'); row(...Array(7).fill('---'));
for (const f of failures) row(f.script, f.reason, f.runs, f.ticks, f.total, `\`${f.example.replace(/\|/g, '/')}\``, (f.line ?? 'not found').replace(/\|/g, '/'));
out.push('', '## Per script', '', 'items% = observed inventory ID/count changes, including buys, banks, trades and item use. This is not net new output. Old ledgers did not record this category and remain unchanged.', '');
row('Script', 'Env', 'Runs', 'Pass', 'Unit', 'Median', 'Best', 'Trend', 'xp%', 'items%', 'move%', 'anim%', 'dialog%', 'stun%', 'idle%', 'Ledger ticks'); row(...Array(16).fill('---'));
for (const s of stats) row(s.script, s.env, s.runs, s.done ? `${s.pass}/${s.done}` : '-', s.unit ?? '-', f1(s.median ?? NaN), f1(s.best ?? NaN), s.trend, ...KINDS.map(k => s.ledgerTicks ? f1(pct(s.shares[k] ?? 0, s.ledgerTicks)) : '-'), s.ledgerTicks || '-');
out.push('', '### Live vs practice (same script, same unit)', '', 'Ticks per 1,000 XP falls as the level rises (more XP per action). Live and practice runs cover different level ranges, so a ratio far from 1 can be range, not speed.', '');
row('Script', 'Unit', 'Live median', 'Practice median', 'Live / practice', 'Live n', 'Practice n'); row(...Array(7).fill('---'));
for (const l of stats.filter(s => s.env === 'live')) { const p = stats.find(s => s.script === l.script && s.env === 'practice'); if (p && p.unit === l.unit && l.values.length && p.values.length) row(l.script, l.unit!, f1(l.median!), f1(p.median!), f1(l.median! / p.median!), l.values.length, p.values.length); }
out.push('', '### Regressions (a run >10% worse than the median of the 3 before it)', '');
const regs = stats.flatMap(s => s.regressions.length ? [`- ${s.script} (${s.env}, ${s.unit}): ${s.regressions.length} of ${s.values.length} runs. Latest: ${s.regressions.slice(-3).join('; ')}`] : []);
out.push(...(regs.length ? regs : ['- none']));
out.push('', '### Level pace (ticks between milestones)', '');
row('Bot', 'Env', 'Script', 'Band', 'Ticks', 'Source'); row(...Array(6).fill('---'));
for (const p of pace.filter(p => p.env === 'live' || /woodcutting|fishing30/.test(p.script)).slice(0, 60)) row(p.name, p.env, p.script, `${p.from}->${p.to}`, p.ticks, p.src);
out.push('', '## Top 10 idle hotspots (8x8 tile cells)', '', 'From `LEDGER longestIdle`, idle alerts and the trailing idle run of each status timeline (streaks of 3+ ticks). Sorted by live idle, then practice idle. Helper rows (banker, courier) have no board clock.', '');
row('#', 'Cell (x,z)', 'Live idle', 'Practice idle', 'Streaks', 'Main phase', 'Scripts', 'Bots'); row(...Array(8).fill('---'));
spotList.slice(0, 10).forEach((s, i) => row(i + 1, s.cell + (s.helper ? ' (helper)' : ''), s.live, s.practice, s.n, topPhase(s), [...s.scripts].join(', '), [...s.bots].slice(0, 4).join(', ')));
out.push('', '## Best action sets by XP per tick (n >= 20 ticks)', '', 'XP of a tick is credited to the action set sent on the tick before (`packages/core/src/status.ts:35-66`). "none" ticks are left out; they collect delayed XP.', '');
row('#', 'Script', 'Action set', 'Ticks', 'XP', 'XP / tick', 'Bots'); row(...Array(7).fill('---'));
comboList.slice(0, 10).forEach((c, i) => row(i + 1, c.script, c.k, c.n, f0(c.xp), f1(c.perTick), c.bots.size));
out.push('', '### Inputs per tick', '');
row('Script', 'Strip ticks', 'Ticks with 0 inputs', 'Mean inputs / tick'); row('---', '---', '---', '---');
for (const [s, e] of [...stripStats].sort((a, b) => b[1].ticks - a[1].ticks)) row(s, e.ticks, `${f1(pct(e.zero, e.ticks))}%`, (e.inputs / e.ticks).toFixed(2));
out.push('', '## Gold farm coins per tick (events)', '');
row('Bot', 'Env', 't', 'Banked + pack coins', 'Coins / tick', 'At'); row(...Array(6).fill('---'));
for (const g of gold) row(g.name, liveNames.has(g.name) ? 'live' : 'practice', g.t, g.coins, f1(g.perTick), iso(g.at));
out.push('', '## Per-phase XP rate (from archived snapshots)', '');
if (phaseRate.size) { row('Bot', 'Phase', 'Ticks', 'XP', 'XP / tick'); row('---', '---', '---', '---', '---'); for (const p of phaseRate.values()) row(p.name, p.phase, p.ticks, f0(p.xp), f1(p.xp / p.ticks)); }
else out.push('No two snapshots of one run in one phase yet. Each run of this script adds one snapshot per bot.');
out.push('', '## Data gaps (> 8 min with no record)', '');
out.push(...(gaps.length ? gaps.slice(0, 5).map(g => `- ${iso(g.from)} to ${iso(g.to)}: ${f0(g.min)} min`) : ['- none']));
out.push('', `Run time: ${(performance.now() - T0).toFixed(0)} ms.`, '');
writeFileSync(P('research/learning-report.md'), out.join('\n'));
writeFileSync(P('.practice/learning.json'), JSON.stringify({
    generatedAt: nowMs, stats: stats.map(({ values, ...s }) => s), fixes: fixes.slice(0, 20), checks,
    hotspots: spotList.slice(0, 20).map(s => ({ cell: s.cell, live: s.live, practice: s.practice, n: s.n, phase: topPhase(s), scripts: [...s.scripts], bots: [...s.bots], helper: s.helper })),
    combos: comboList.slice(0, 20).map(c => ({ script: c.script, k: c.k, n: c.n, xp: c.xp, perTick: c.perTick })), pace, gold, gaps: gaps.slice(0, 10),
    runs: archive, snapshots,
}));
console.log(`learn: ${runs.length} runs, ${fixes.length} fixes, ${spotList.length} hotspot cells, checks ${checks.map(c => c.pass ? 'ok' : c.note ?? 'NO').join('/')}, ${(performance.now() - T0).toFixed(0)} ms`);
