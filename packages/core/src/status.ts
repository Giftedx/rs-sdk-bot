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

export function startStatus(s: { name: string; sdk: { getState(): any }; onTick(cb: () => void): () => void; tick(): number }, server: string, ledgerCounts?: () => Record<string, number>, timeline?: () => string) {
    captureMilestones();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${s.name}.json`);
    let bank: { name: string; count: number }[] | null = null;
    const started = Date.now();
    const write = () => {
        const st = s.sdk.getState();
        if (st?.bank?.isOpen && Array.isArray(st.bank.items)) bank = st.bank.items.map((i: any) => ({ name: i.name, count: i.count }));
        const p = st?.player;
        const hp = (st?.skills ?? []).find((k: any) => k.name === 'Hitpoints');
        const doc = {
            name: s.name, server, role: roleOf(s.name), goal: process.env.BOT_GOAL ?? process.argv[1]?.split(/[\\/]/).pop() ?? '',
            phase: lastLine, result: lastResult, at: Date.now(), started, tick: s.tick(),
            pos: p ? { x: p.worldX, z: p.worldZ, level: p.level } : null,
            hp: hp ? { now: hp.level, max: hp.baseLevel } : null,
            combat: p?.combatLevel ?? null,
            skills: (st?.skills ?? []).map((k: any) => ({ name: k.name, level: k.baseLevel, xp: k.experience })),
            inventory: (st?.inventory ?? []).map((i: any) => ({ name: i.name, count: i.count })),
            bank, ledger: ledgerCounts?.() ?? null,
            // Last 300 ticks, one letter per tick: x xp, m move, a anim, d dialog, s stun, i idle.
            timeline: timeline?.() ?? '',
            // Every key=value counter from the last RESULT line (shopTicks, walkTicks, stuns, eaten, ...).
            counters: Object.fromEntries([...lastResult.matchAll(/([A-Za-z]+)=(-?[0-9.]+)/g)].map(m => [m[1], Number(m[2])])),
            env: { target: process.env.TARGET ?? null, cap: process.env.CAP ?? null },
        };
        try { writeFileSync(`${file}.tmp`, JSON.stringify(doc)); renameSync(`${file}.tmp`, file); } catch { /* the dashboard is optional */ }
    };
    write();
    let n = 0;
    const off = s.onTick(() => { if (++n % 5 === 0) write(); });
    return { stop: () => { write(); off(); } };
}
