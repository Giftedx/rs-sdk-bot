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

const procs: { pid: number; script: string; started: number; mb: number; accounts: string[] }[] = [];
let procsAt = 0, procsScanning = false;
const clients = new Set<ReadableStreamDefaultController>();
const viewerTimings: { at: number; mode: string; ms: number; tiles: number; frames: number; blankFrames: number; holdFrames: number }[] = [];

async function scanProcs(force = false) {
    if (!clients.size && !force) return; // nobody watching: no PowerShell
    if (procsScanning) return; // a slow scan must not stack a second PowerShell
    procsScanning = true;
    procsAt = Date.now();
    try {
        const ps = "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.CreationDate.ToString('o'), $_.WorkingSetSize, $_.CommandLine }";
        const p = Bun.spawn(['powershell', '-NoProfile', '-Command', ps], { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
        const hung = setTimeout(() => p.kill(), 20_000);
        const text = await new Response(p.stdout).text().finally(() => clearTimeout(hung));
        procs.length = 0;
        for (const line of text.split(NL)) {
            const [pid, created, ws, ...cmd] = line.trim().split('|');
            if (!pid || !created) continue;
            // Only the script file name: command lines never reach the page.
            const script = (cmd.join('|').match(/([\w.-]+\.(?:ts|js))\b/g) ?? []).pop() ?? 'bun';
            const tokens = (cmd.join('|').match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map(t => t.replace(/^["']|["']$/g, '').toLowerCase());
            const accounts = liveAccounts().filter(name => tokens.includes(name.toLowerCase()));
            procs.push({ pid: Number(pid), script, started: Date.parse(created), mb: Math.round(Number(ws) / 2 ** 20), accounts });
        }
        procs.sort((a, b) => a.started - b.started);
    } catch { /* not Windows */ } finally { procsScanning = false; }
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
