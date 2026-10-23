// Screenshot a page with the installed Edge over the DevTools protocol (no extra packages).
// Usage: bun scripts/shot.ts <url> <out.png> [width=1600] [height=1200] [waitMs=4000]
import { writeFileSync } from 'node:fs';

const [url, out, wArg, hArg, waitArg] = process.argv.slice(2);
const W = Number(wArg ?? 1600), H = Number(hArg ?? 1200), WAIT = Number(waitArg ?? 4000);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const proc = Bun.spawn([EDGE, '--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${process.env.TEMP}\\shot-${port}`, `--window-size=${W},${H}`, 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
try {
    let wsUrl = '';
    for (let i = 0; i < 50 && !wsUrl; i++) {
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
} finally { proc.kill(); }
process.exit(0);
