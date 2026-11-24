import { cpus } from 'node:os';
import { liveAccounts, NL } from '../config';

// ---------- machine: memory, CPU load, bun processes, pull requests, SSE clients ----------
let cpuPrev = cpus().map(c => c.times);
let cpuPct = 0;
function sampleCpu() {
    const now = cpus().map(c => c.times);
    let busy = 0, all = 0;
    now.forEach((t, i) => {
        const p = cpuPrev[i]!;
        const d = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq);
        busy += d; all += d + (t.idle - p.idle);
    });
    cpuPct = all ? 100 * busy / all : 0;
    cpuPrev = now;
}
const getCpuPct = () => cpuPct;
let buildMs = 0;
const getBuildMs = () => buildMs;
const setBuildMs = (ms: number) => { buildMs = ms; };

type ProcRow = { pid: number; script: string; started: number; mb: number; accounts: string[] };
const procs: ProcRow[] = [];
let procsAt = 0, procsScanning = false;
const clients = new Set<ReadableStreamDefaultController>();
const viewerTimings: { at: number; mode: string; ms: number; tiles: number; frames: number; blankFrames: number; holdFrames: number }[] = [];

function parseProcLines(text: string, windows: boolean, now: number, accounts: readonly string[]): ProcRow[] {
    const out: ProcRow[] = [];
    const accountEntries = accounts.map(name => ({ name, lower: name.toLowerCase() }));
    for (const line of text.split(/\r?\n/)) {
        let pid: number;
        let started: number;
        let mb: number;
        let cmdLine: string;
        if (windows) {
            const [pidRaw, created, ws, ...cmd] = line.trim().split('|');
            pid = Number(pidRaw);
            started = Date.parse(created ?? '');
            const wsNum = Number(ws);
            if (!pidRaw || !created || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(started) || !Number.isFinite(wsNum) || wsNum < 0) continue;
            mb = Math.round(wsNum / 2 ** 20);
            cmdLine = cmd.join('|');
        } else {
            const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(.*)$/.exec(line);
            if (!m || !/(?:^|\/)bun$/.test(m[4]!)) continue;
            pid = Number(m[1]);
            const elapsedSec = Number(m[2]), rssKb = Number(m[3]);
            if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(elapsedSec) || elapsedSec < 0 || !Number.isFinite(rssKb) || rssKb < 0) continue;
            started = now - elapsedSec * 1000;
            mb = Math.round(rssKb / 1024);
            cmdLine = m[4]! + m[5]!;
        }
        // Only the script file name: command lines never reach the page.
        const script = (cmdLine.match(/([\w.-]+\.(?:ts|js))\b/g) ?? []).pop() ?? 'bun';
        const tokens = (cmdLine.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map(t => t.replace(/^["']|["']$/g, '').toLowerCase());
        const matchedAccounts = accountEntries.filter(a => tokens.includes(a.lower)).map(a => a.name);
        out.push({ pid, script, started, mb, accounts: matchedAccounts });
    }
    out.sort((a, b) => a.started - b.started);
    return out;
}

async function scanProcs(force = false) {
    if (!clients.size && !force) return; // nobody watching: no process scan
    if (procsScanning) return; // a slow scan must not stack a second process
    procsScanning = true;
    procsAt = Date.now();
    try {
        const windows = process.platform === 'win32';
        const cmd = windows
            ? ['powershell', '-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.CreationDate.ToString('o'), $_.WorkingSetSize, $_.CommandLine }"]
            : ['ps', '-eo', 'pid=,etimes=,rss=,args='];
        const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
        let timedOut = false;
        const hung = setTimeout(() => { timedOut = true; try { p.kill(); } catch { /* exited */ } }, 20_000);
        const [text, exitCode] = await Promise.all([new Response(p.stdout).text(), p.exited]).finally(() => clearTimeout(hung));
        if (timedOut || exitCode !== 0) return;
        const next = parseProcLines(text, windows, Date.now(), liveAccounts());
        procs.length = 0;
        procs.push(...next);
    } catch { /* process scan unavailable */ } finally { procsScanning = false; }
}

function maybeScanProcs() {
    if (Date.now() - procsAt > 60_000) void scanProcs(true);
}

// ---------- pull requests: the bot repository's open and lately merged PRs (gh), every 5 minutes ----------
// The hosted publisher fetches the same list; the local page reads it from here.
let prRows: any[] = [];
const getPrRows = () => prRows;
async function refreshPrs() {
    const fields = 'number,title,headRefName,state,isDraft,updatedAt,author,url';
    const list = async (state: string, limit: string) => {
        const p = Bun.spawn(['gh', 'pr', 'list', '--repo', 'Giftedx/rs-sdk-bot', '--state', state, '--limit', limit, '--json', fields], { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
        const text = await new Response(p.stdout).text();
        if (await p.exited !== 0) throw Error(`gh pr list ${state} failed`);
        return JSON.parse(text) as any[];
    };
    try {
        prRows = [...await list('open', '50'), ...await list('merged', '15')].map(r => ({ number: r.number, title: String(r.title ?? ''), branch: String(r.headRefName ?? ''), state: String(r.state ?? ''), draft: r.isDraft === true, updatedAt: String(r.updatedAt ?? ''), author: String(r.author?.login ?? ''), url: String(r.url ?? '') }));
    } catch { /* gh missing or offline: keep the last list */ }
}

export {
    clients,
    getBuildMs,
    getCpuPct,
    getPrRows,
    maybeScanProcs,
    procs,
    refreshPrs,
    sampleCpu,
    scanProcs,
    setBuildMs,
    viewerTimings,
};
