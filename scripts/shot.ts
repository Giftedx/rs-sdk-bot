// Screenshot a page with the installed Edge over the DevTools protocol (no extra packages).
// Usage: bun scripts/shot.ts <url> <out.png> [width=1600] [height=1200] [waitMs=4000]
import { writeFileSync } from 'node:fs';

const [url, out, wArg, hArg, waitArg] = process.argv.slice(2);
const W = Number(wArg ?? 1600), H = Number(hArg ?? 1200), WAIT = Number(waitArg ?? 4000);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const proc = Bun.spawn([EDGE, '--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${process.env.TEMP}\\shot-${port}`, `--window-size=${W},${H}`, 'about:blank'], { stdout: 'ignore', stderr: 'ignore' ,windowsHide:true});
// The spawned msedge.exe is only a launcher: it starts the real browser and exits, so killing its pid or tree misses
// the browser (seen 2026-10-23: 11-16 headless Edge processes left after shots, about 70% CPU). Every exit path kills
// each Edge process that uses this shot's own profile folder.
// One pass can miss children Edge starts while it is being killed (seen: 9 left after a shot), so repeat until the
// query finds none, at most 5 passes.
const killTree = () => {
    for (let pass = 0; pass < 5; pass++) {
        try {
            const r = Bun.spawnSync(['powershell', '-NoProfile', '-Command',
                `$p = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match 'shot-${port}' }; $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; @($p).Count`],
                { stdout: 'pipe', stderr: 'ignore' ,windowsHide:true});
            if (Number(r.stdout.toString().trim()) === 0) return;
        } catch { return; }
        Bun.sleepSync(500);
    }
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { killTree(); process.exit(1); });
setTimeout(() => { console.log('shot: gave up after 90 s'); killTree(); process.exit(1); }, 90_000);
try {
    let wsUrl = '';
    for (let i = 0; i < 150 && !wsUrl; i++) {
        await Bun.sleep(200);
        try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as any[]; wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? ''; } catch { /* not up yet */ }
    }
    if (!wsUrl) throw new Error('no DevTools page target');
    const ws = new WebSocket(wsUrl);
    await new Promise(r => (ws.onopen = r));
    let id = 0;
    const pending = new Map<number, (v: any) => void>();
    ws.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); } };
    const call = (method: string, params: object = {}) => new Promise<any>(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await call('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url });
    await Bun.sleep(WAIT);
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(out!, Buffer.from(shot.data, 'base64'));
    console.log(`shot ${out}`);
    ws.close();
} finally { killTree(); }
process.exit(0);
