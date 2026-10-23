// Haggis go/no-go: checks the 5 gates and writes .practice/haggis-go.json, the only file that lets the main account
// log in (packages/core/src/haggisgate.ts). Usage: bun scripts/haggis-gate.ts [live-hiscores.json]
// 1 plan wins: realistic schedule, no tricks, every board WIN with slack >= 2% of its deadline, every input MEASURED.
// 2 rehearsed: the last 3 files in .practice/rehearsals/ are ok, with no death, within 2% of the plan's ticks.
// 3 supplies staged: .practice/haggis-supplies.json says staged, written within the last hour.
// 4 fresh targets: the hiscores file used for gate 1 was written within the last hour.
// 5 machine clear: .practice/monitor.json is under 2 minutes old, has no open warn/error alert, and >= 8 GB is free.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { haggisActivities, loadSnapshot, schedule } from '../packages/planner/src/haggis';
import { GATE_FILE } from '../packages/core/src/haggisgate';

const root = resolve(import.meta.dir, '..');
const prac = join(root, '.practice');
const snap = process.argv[2] ?? join(root, 'research', 'hiscores-live.json');
const now = Date.now();
const HOUR = 3600_000;
const gates: { name: string; pass: boolean; detail: string }[] = [];
const age = (p: string) => (existsSync(p) ? now - statSync(p).mtimeMs : Infinity);

// 1
try {
    const boardsFile = join(root, 'packages', 'planner', 'src', 'haggis-boards.json');
    const unmeasured = (readFileSync(boardsFile, 'utf8').match(/"evidence":\s*"(ESTIMATE|CODE-READ)"/g) ?? []).length;
    const snapFile = existsSync(snap) ? snap : join(root, 'research', 'hiscores-2026-10-22.json');
    const r = schedule(loadSnapshot(snapFile), haggisActivities(), { mode: 'realistic', tricks: new Set() }).boards;
    const short = r.filter(b => b.status !== 'WIN' || (b.deadline !== null && (b.slack ?? -1) < Math.ceil(b.deadline * 0.02)));
    const worst = [...r].filter(b => b.slack !== null).sort((a, b) => a.slack! - b.slack!)[0];
    gates.push({ name: 'plan wins', pass: short.length === 0 && unmeasured === 0, detail: `${r.length - short.length}/${r.length} boards win with 2% margin; ${unmeasured} inputs not MEASURED; worst ${worst?.label} ${worst?.slack}` });
} catch (e) { gates.push({ name: 'plan wins', pass: false, detail: `error: ${String(e)}` }); }

// 2
const rdir = join(prac, 'rehearsals');
const reh = existsSync(rdir) ? readdirSync(rdir).filter(f => f.endsWith('.json')).sort().slice(-3).map(f => JSON.parse(readFileSync(join(rdir, f), 'utf8'))) : [];
const rehOk = reh.length === 3 && reh.every((x: any) => x.ok && !x.died && Math.abs(x.ticks - x.planTicks) <= x.planTicks * 0.02);
gates.push({ name: 'rehearsed', pass: rehOk, detail: `${reh.length} recent rehearsals; ${reh.filter((x: any) => x.ok).length} ok` });

// 3
const supFile = join(prac, 'haggis-supplies.json');
const sup = existsSync(supFile) ? JSON.parse(readFileSync(supFile, 'utf8')) : null;
gates.push({ name: 'supplies staged', pass: !!sup?.staged && now - (sup.at ?? 0) < HOUR, detail: sup ? `staged=${sup.staged}, ${Math.round((now - sup.at) / 60_000)} min old` : 'no supply manifest' });

// 4
gates.push({ name: 'fresh targets', pass: age(snap) < HOUR, detail: existsSync(snap) ? `${snap} is ${Math.round(age(snap) / 60_000)} min old` : `${snap} missing (re-read the live boards)` });

// 5
const monFile = join(prac, 'monitor.json');
const mon = existsSync(monFile) ? JSON.parse(readFileSync(monFile, 'utf8')) : null;
const open = (mon?.alerts ?? []).filter((a: any) => a.level !== 'fixed');
gates.push({ name: 'machine clear', pass: !!mon && now - mon.at < 120_000 && open.length === 0 && mon.freeGB >= 8, detail: mon ? `${open.length} open alerts, ${mon.freeGB.toFixed(1)} GB free, ${Math.round((now - mon.at) / 1000)} s old` : 'watchdog not running' });

const go = gates.every(g => g.pass);
writeFileSync(GATE_FILE, JSON.stringify({ go, at: now, gates }, null, 2));
for (const g of gates) console.log(`${g.pass ? 'PASS' : 'FAIL'}  ${g.name.padEnd(16)} ${g.detail}`);
console.log(go ? 'GO: Haggis may log in (HAGGIS_RUN=1) within 10 minutes' : 'NO-GO: Haggis stays logged out');
process.exit(go ? 0 : 1);
