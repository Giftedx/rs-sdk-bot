// Watchdog: every 30 s checks the machine and the swarm, and writes .practice/monitor.json (latest state) plus
// .practice/alerts.jsonl (one line per new alert). The launch gate (packages/core/src/haggisgate.ts) reads
// monitor.json. scripts/learn.ts and the lead session read alerts.jsonl. The dashboard reads neither file.
// Fixes on its own only what is always safe: headless Edge left by a screenshot (profile folder shot-<port>) older
// than 2 minutes is killed (leaks of 5, 11 and 16 Edge processes, up to 70% CPU).
// Alerts: low RAM, stray `python -` processes, live bots that died, stalled (no status for 2 min without a RESULT)
// or idle 20+ ticks in a row, and too many practice bots at once.
// Usage: bun scripts/monitor.ts
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { freemem, totalmem } from 'node:os';
import { simStatusDir, statusReadDirs } from '../packages/core/src/practice-paths';

const defaultRoot = resolve(import.meta.dir, '..');

type Alert = { at: number; level: 'warn' | 'error' | 'fixed'; key: string; text: string; bot?: string };
const active = new Map<string, Alert>();
// Death and fixed-leak alerts stay for 60 minutes, then retire for good (a dead bot's status keeps saying "died").
const retired = new Set<string>();

function procs(): { pid: number; name: string; ageSec: number; mb: number; cpuSec: number; cmd: string }[] {
    // One CIM query per cycle; tasklist has no command lines.
    const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='python.exe' OR Name='bun.exe'" | ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.ProcessId, $_.Name, [int]((Get-Date) - $_.CreationDate).TotalSeconds, [int]($_.WorkingSetSize/1MB), [int](($_.KernelModeTime + $_.UserModeTime) / 1e7),($_.CommandLine -replace '\\|',' ') }`;
    const r = Bun.spawnSync(['powershell', '-NoProfile', '-Command', ps], { stdout: 'pipe', stderr: 'ignore' ,windowsHide:true});
    return r.stdout.toString().split(/\r?\n/).filter(Boolean).map(l => {
        const [pid, name, age, mb, cpu, ...cmd] = l.split('|');
        return { pid: Number(pid), name: name!, ageSec: Number(age), mb: Number(mb), cpuSec: Number(cpu), cmd: cmd.join('|') };
    });
}

export function readStatusSnapshots(root = defaultRoot): any[] {
    const byName = new Map<string, any>();
    const dirs = [...statusReadDirs(root), simStatusDir(root)];
    for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
            let s: any;
            try { s = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
            const key = String(s?.name || f.slice(0, -5)).toLowerCase();
            const prev = byName.get(key);
            const sAt = typeof s?.at === 'number' && Number.isFinite(s.at) ? s.at : 0;
            const prevAt = typeof prev?.at === 'number' && Number.isFinite(prev.at) ? prev.at : -1;
            if (!prev || sAt > prevAt) byName.set(key, s);
        }
    }
    return [...byName.values()];
}

export function cycle(
    root = defaultRoot,
    opts: { now?: number; list?: ReturnType<typeof procs>; alertLog?: boolean } = {},
) {
    const prac = join(root, '.practice');
    mkdirSync(prac, { recursive: true });
    const now = opts.now ?? Date.now();
    const seen = new Set<string>();
    const raise = (a: Omit<Alert, 'at'>) => {
        seen.add(a.key);
        if (active.has(a.key) || retired.has(a.key)) return;
        const full = { ...a, at: now };
        active.set(a.key, full);
        if (opts.alertLog !== false) appendFileSync(join(prac, 'alerts.jsonl'), JSON.stringify(full) + '\n');
        console.log(`ALERT ${a.level} ${a.text}`);
    };

    const list = opts.list ?? procs();
    const stale = list.filter(p => p.name === 'msedge.exe' && /shot-\d+/.test(p.cmd) && p.ageSec > 120);
    if (stale.length) {
        for (const p of stale) Bun.spawnSync(['taskkill', '/PID', String(p.pid), '/F'], { stdout: 'ignore', stderr: 'ignore' ,windowsHide:true});
        raise({ level: 'fixed', key: `edge-${now}`, text: `killed ${stale.length} leaked screenshot Edge processes (${[...new Set(stale.map(p => p.cmd.match(/shot-\d+/)![0]))].join(', ')})` });
    }
    // A `python -` (script piped from a Bash heredoc) still alive after 10 minutes is stuck; two such processes burned
    // about one CPU core each (589 and 655 CPU-seconds in 11 minutes). Kill those that use CPU.
    for (const p of list.filter(p => p.name === 'python.exe' && /python(3|\.exe)?"? -\s*$/.test(p.cmd) && p.ageSec > 600)) {
        if (p.cpuSec > 60) {
            Bun.spawnSync(['taskkill', '/PID', String(p.pid), '/F'], { stdout: 'ignore', stderr: 'ignore' ,windowsHide:true});
            raise({ level: 'fixed', key: `py-${p.pid}`, text: `killed stuck python - (pid ${p.pid}, ${Math.round(p.ageSec / 60)} min, ${p.cpuSec} CPU-s)` });
        } else raise({ level: 'warn', key: `py-${p.pid}`, text: `python reading stdin for ${Math.round(p.ageSec / 60)} min (pid ${p.pid}), likely stuck` });
    }
    // Zombie bots: a bot process whose session was replaced keeps running and leaks memory (an old
    // mmtha0205 goldfarm reached 8.5 GB and another 2.6 GB, each beside the live process for the same account).
    // Two processes running the same script for the same account: the older one is the zombie; kill it. A bot process
    // over 2 GB is an alert either way.
    const botKey = (cmd: string) => cmd.match(/(\S+\.ts)\s+([A-Za-z0-9]{1,12})\s*$/)?.slice(1).join(' ') ?? null;
    const byKey = new Map<string, typeof list>();
    for (const p of list.filter(p => p.name === 'bun.exe' && !/supervise\.ts|host\.ts|swarm\.ts/.test(p.cmd))) {
        const k = botKey(p.cmd);
        if (k) byKey.set(k, [...(byKey.get(k) ?? []), p]);
    }
    for (const [k, ps] of byKey) {
        if (ps.length < 2) continue;
        for (const old of ps.sort((a, b) => b.ageSec - a.ageSec).slice(0, -1)) {
            Bun.spawnSync(['taskkill', '/PID', String(old.pid), '/F'], { stdout: 'ignore', stderr: 'ignore' ,windowsHide:true});
            raise({ level: 'fixed', key: `zombie-${old.pid}`, text: `killed zombie bot process ${old.pid} (${k}, ${old.mb} MB, ${Math.round(old.ageSec / 60)} min old; a newer one runs)` });
        }
    }
    for (const p of list.filter(p => p.name === 'bun.exe' && p.mb > 2048)) raise({ level: 'warn', key: `bigproc-${p.pid}`, text: `bun ${p.pid} uses ${p.mb} MB: ${p.cmd.slice(-60)}` });
    const freeGB = freemem() / 2 ** 30;
    if (freeGB < 3) raise({ level: 'error', key: 'ram', text: `only ${freeGB.toFixed(1)} GB RAM free` });

    // openBot writes a live death to alerts.jsonl itself (death-recovery.ts deathAlert): such a session gets no
    // second died- alert here; the bot's own alert goes into the active list of monitor.json instead.
    let logged: Alert[] | undefined;
    const botAlert = (name: string, since: number): Alert | undefined => {
        if (!logged) {
            try {
                logged = readFileSync(join(prac, 'alerts.jsonl'), 'utf8').split(/\r?\n/).slice(-2000)
                    .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
            } catch { logged = []; }
        }
        return logged.filter(a => a?.bot === name && String(a.key ?? '').startsWith('died-') && typeof a.at === 'number' && a.at >= since).at(-1);
    };
    let practiceBots = 0;
    const bots: Record<string, unknown>[] = [];
    for (const s of readStatusSnapshots(root)) {
        const age = now - s.at;
        const live = s.practice !== true && !/^localhost|^127\.0\.0\.1/.test(s.server ?? '');
        if (!live) { if (age < 60_000) practiceBots++; continue; }
        if (age > 6 * 3600_000) continue;
        const tail = String(s.timeline ?? '').slice(-40);
        const idleRun = tail.length - tail.replace(/i+$/, '').length;
        bots.push({ name: s.name, ageSec: Math.round(age / 1000), idleRun, result: s.result ?? '', phase: s.phase ?? '' });
        if (/died=true|fail died/.test(s.result ?? '')) {
            const own = botAlert(s.name, Number(s.started) || 0);
            if (own) { seen.add(own.key); if (!active.has(own.key) && !retired.has(own.key)) active.set(own.key, own); }
            else raise({ level: 'error', key: `died-${s.name}-${s.started}`, bot: s.name, text: `${s.name} died: ${String(s.result).slice(0, 120)}` }); }
        else if (!s.result && age > 120_000 && age < 3600_000) raise({ level: 'error', key: `stalled-${s.name}-${s.started}`, bot: s.name, text: `${s.name}: no status for ${Math.round(age / 60_000)} min and no RESULT (crashed or frozen)` });
        if (age < 30_000 && idleRun >= 20) raise({ level: 'warn', key: `idle-${s.name}-${s.tick - idleRun}`, bot: s.name, text: `${s.name} idle ${idleRun} ticks in a row at ${s.pos?.x},${s.pos?.z} (${s.phase})` });
    }
    if (practiceBots > 6) raise({ level: 'warn', key: 'practice-load', text: `${practiceBots} practice bots at once (limit 6)` });

    for (const [k, a] of [...active]) {
        const sticky = k.startsWith('died-') || k.startsWith('edge-') || k.startsWith('py-');
        if (sticky ? now - a.at > 3600_000 : !seen.has(k)) { active.delete(k); if (sticky) retired.add(k); }
    }
    const bunMB = list.filter(p => p.name === 'bun.exe').reduce((n, p) => n + p.mb, 0);
    const snapshot = {
        at: now, freeGB, totalGB: totalmem() / 2 ** 30, bunProcs: list.filter(p => p.name === 'bun.exe').length, bunMB,
        edgeProcs: list.filter(p => p.name === 'msedge.exe').length, practiceBots, bots, alerts: [...active.values()].sort((a, b) => b.at - a.at),
    };
    writeFileSync(join(prac, 'monitor.json'), JSON.stringify(snapshot));
    return snapshot;
}

if (import.meta.main) {
    console.log('monitor: every 30 s -> .practice/monitor.json, .practice/alerts.jsonl');
    cycle();
    setInterval(cycle, 30_000);
}
