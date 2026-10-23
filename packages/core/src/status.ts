import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NAMES } from './names';

// Live status for the dashboard (packages/dashboard): every bot writes .practice/status/<name>.json every few ticks.
// Role: env BOT_ROLE, else the names list the account comes from. Goal: env BOT_GOAL, else the script file.
// Phase: the last "MILESTONE <name>" line the script printed. The bank is kept from the last time it was open.

const dir = join(resolve(import.meta.dir, '..', '..', '..'), '.practice', 'status');

export function roleOf(name: string): string {
    if (process.env.BOT_ROLE) return process.env.BOT_ROLE;
    for (const [role, list] of Object.entries(NAMES)) if ((list as readonly string[]).some(n => n.toLowerCase() === name.toLowerCase())) return role;
    return 'test';
}

let lastLine = '';
let lastResult = '';
let patched = false;
// Per-bot MILESTONE and RESULT lines, for processes that run several bots (packages/core/src/host.ts). A bot with no
// entry here uses the process-wide lines above, as before.
const perBot = new Map<string, { line: string; result: string }>();
export function noteStatusLine(name: string, line: string): void {
    const e = perBot.get(name) ?? { line: '', result: '' };
    if (line.startsWith('MILESTONE ')) e.line = line.slice(10);
    if (line.startsWith('RESULT ')) e.result = line.slice(7, 300);
    perBot.set(name, e);
}
function captureMilestones() {
    if (patched) return;
    patched = true;
    const orig = console.log.bind(console);
    console.log = (...args: unknown[]) => {
        const line = args.map(String).join(' ');
        if (line.startsWith('MILESTONE ')) lastLine = line.slice(10);
        if (line.startsWith('RESULT ')) lastResult = line.slice(7, 300);
        orig(...args);
    };
}

// Inputs per tick (owner request #8): wraps the session's direct() and the SDK's send() (the in-process shim's
// action queue) to count the actions each tick sends, and credits the XP gained on the next tick to that action set.
// Waits are not inputs. Output: one digit per tick (0-9, last 300 ticks) and the most used action sets with XP/tick.
function recordInputs(s: { tick(): number; onTick(cb: () => void): () => void; sdk: { getState(): any } }) {
    const sent: string[] = [];
    const note = (type: unknown) => { if (typeof type === 'string' && type !== 'wait') sent.push(type); };
    const sess = s as any, sdk = s.sdk as any;
    if (typeof sess.direct === 'function') {
        const orig = sess.direct.bind(sess);
        sess.direct = (a: { type: string }) => { note(a?.type); return orig(a); };
    }
    if (typeof sdk.send === 'function') {
        const orig = sdk.send.bind(sdk);
        sdk.send = (msg: { type: string; action?: { type: string } }) => { if (msg?.type === 'sdk_action') note(msg.action?.type); return orig(msg); };
    }
    const xpNow = () => (s.sdk.getState()?.skills ?? []).reduce((n: number, k: any) => n + (k.experience ?? 0), 0);
    let lastXp = xpNow();
    let pending = '';
    let strip = '';
    const combos = new Map<string, { n: number; xp: number }>();
    s.onTick(() => {
        const xp = xpNow();
        if (pending) { const c = combos.get(pending)!; c.xp += Math.max(0, xp - lastXp); }
        lastXp = xp;
        strip = (strip + String(Math.min(9, sent.length))).slice(-300);
        // The action set sent during the tick that just ended; its XP shows up on the next tick.
        pending = sent.length ? [...new Set(sent)].sort().join('+') : 'none';
        const c = combos.get(pending) ?? { n: 0, xp: 0 };
        c.n++; combos.set(pending, c);
        sent.length = 0;
    });
    return () => ({
        strip,
        combos: [...combos].sort((a, b) => b[1].n - a[1].n).slice(0, 10).map(([k, v]) => ({ k, n: v.n, xp: v.xp })),
    });
}

export function startStatus(s: { name: string; sdk: { getState(): any }; onTick(cb: () => void): () => void; tick(): number }, server: string, ledgerCounts?: () => Record<string, number>, timeline?: () => string) {
    captureMilestones();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${s.name}.json`);
    let bank: { name: string; count: number }[] | null = null;
    let bankAt: number | null = null;
    const started = Date.now();
    const inputs = recordInputs(s);
    const write = () => {
        const st = s.sdk.getState();
        if (st?.bank?.isOpen && Array.isArray(st.bank.items)) { bank = st.bank.items.map((i: any) => ({ name: i.name, count: i.count })); bankAt = Date.now(); }
        const p = st?.player;
        const hp = (st?.skills ?? []).find((k: any) => k.name === 'Hitpoints');
        const own = perBot.get(s.name);
        const phaseNow = own ? own.line : lastLine;
        const resultNow = own ? own.result : lastResult;
        const doc = {
            name: s.name, server, role: roleOf(s.name), goal: process.env.BOT_GOAL ?? process.argv[1]?.split(/[\\/]/).pop() ?? '',
            phase: phaseNow, result: resultNow, at: Date.now(), started, tick: s.tick(),
            pos: p ? { x: p.worldX, z: p.worldZ, level: p.level } : null,
            hp: hp ? { now: hp.level, max: hp.baseLevel } : null,
            combat: p?.combatLevel ?? null,
            skills: (st?.skills ?? []).map((k: any) => ({ name: k.name, level: k.baseLevel, xp: k.experience })),
            inventory: (st?.inventory ?? []).map((i: any) => ({ name: i.name, count: i.count })),
            bank, bankAt, ledger: ledgerCounts?.() ?? null,
            // Last 300 ticks, one letter per tick: x xp, m move, a anim, d dialog, s stun, i idle.
            timeline: timeline?.() ?? '',
            // Inputs sent per tick (last 300 ticks, one digit each) and the top action sets with the XP they gained.
            inputs: inputs(),
            // Every key=value counter from the last RESULT line (shopTicks, walkTicks, stuns, eaten, ...).
            counters: Object.fromEntries([...resultNow.matchAll(/([A-Za-z]+)=(-?[0-9.]+)/g)].map(m => [m[1], Number(m[2])])),
            env: { target: process.env.TARGET ?? null, cap: process.env.CAP ?? null },
        };
        try { writeFileSync(`${file}.tmp`, JSON.stringify(doc)); renameSync(`${file}.tmp`, file); } catch { /* the dashboard is optional */ }
    };
    write();
    let n = 0;
    const off = s.onTick(() => { if (++n % 5 === 0) write(); });
    return { stop: () => { write(); off(); } };
}
