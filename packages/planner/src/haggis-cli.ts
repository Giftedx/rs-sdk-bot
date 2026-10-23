// Prints the Haggis 24-board schedule for the three trick scenarios.
// Usage: bun packages/planner/src/haggis-cli.ts [path/to/hiscores.json] [--order] [--supplies] [--evidence]
import { join, resolve } from 'node:path';
import { bestSet, haggisActivities, loadSnapshot, schedule, SCENARIOS, suppliesFor, type BoardResult, type Mode, type ScheduleOptions } from './haggis';

const args = process.argv.slice(2);
const root = resolve(import.meta.dir, '..', '..', '..');
const snap = args.find(a => !a.startsWith('--')) ?? join(root, 'research', 'hiscores-2026-10-22.json');
const boards = loadSnapshot(snap);
const activities = haggisActivities();
const fmt = (n: number | null) => (n === null ? '-' : n.toLocaleString('en-US'));
const sl = (r: BoardResult) => (r.slack === null ? (r.status === 'NO-CLOCK' ? 'no clock' : r.status === 'WIN' ? 'points' : '-') : (r.slack > 0 ? '+' : '') + r.slack.toLocaleString('en-US'));

for (const sc of SCENARIOS) {
    const tricks = new Set(sc.tricks);
    const run = (mode: Mode) => schedule(boards, activities, { mode, tricks });
    const floor = run('floor');
    const real = run('realistic');
    console.log(`\n## Scenario ${sc.id}: ${sc.label}\n`);
    console.log('| Board | Deadline | Finish (floor) | Slack (floor) | Finish (realistic) | Slack (realistic) |');
    console.log('|---|---|---|---|---|---|');
    for (const r of real.boards) {
        const f = floor.boards.find(x => x.id === r.id)!;
        console.log(`| ${r.label} | ${fmt(r.deadline)} | ${fmt(f.finish)} | ${sl(f)} ${f.status} | ${fmt(r.finish)} | ${sl(r)} ${r.status} |`);
    }
    console.log(`\nRoute: ${real.chosen.filter(id => ['cook-35', 'relog', 'fm-burn', 'fm-pyre', 'smith', 'superheat'].includes(id)).join(', ')}; QP at end ${real.qp}; idle ${real.idle}; blocked ${real.blocked.join(', ') || 'none'}`);
    for (const mode of ['floor', 'realistic'] as Mode[]) {
        const best = bestSet(boards, activities, { mode, tricks });
        const won = best.result.boards.filter(b => b.status === 'WIN').map(b => b.id);
        console.log(`Best set (${mode}): ${won.length} boards win: ${won.join(', ')}. Moved to the end: ${best.sacrificed.join(', ') || 'none'}`);
    }
    if (args.includes('--order')) {
        console.log('\n| # | Activity | Start | End | XP lands | Ticks | EDF deadline |');
        console.log('|---|---|---|---|---|---|---|');
        real.order.forEach((p, i) => console.log(`| ${i + 1} | ${p.label} | ${fmt(p.start)} | ${fmt(p.end)} | ${fmt(p.landsAt)} | ${fmt(p.ticks)} | ${p.deadline === Infinity ? 'none' : fmt(p.deadline)} |`));
    }
    if (args.includes('--supplies')) {
        console.log('\n| Supply | Count |');
        console.log('|---|---|');
        for (const s of suppliesFor(activities, { mode: 'realistic', tricks })) console.log(`| ${s.item} | ${fmt(s.count)} |`);
    }
}

// Route comparison: Magic and Smithing trained separately, or together by superheat.
console.log('\n## Route comparison: Magic + Smithing (scenario a)\n');
console.log('| Route | Mode | Smithing finish | Magic finish | Overall finish |');
console.log('|---|---|---|---|---|');
for (const option of ['separate', 'superheat']) for (const mode of ['floor', 'realistic'] as Mode[]) {
    const opts: ScheduleOptions = { mode, tricks: new Set(), force: { 'magic-smithing': option } };
    const r = schedule(boards, activities, opts).boards;
    const g = (id: string) => fmt(r.find(b => b.id === id)!.finish);
    console.log(`| ${option} | ${mode} | ${g('smithing')} | ${g('magic')} | ${g('overall')} |`);
}

if (args.includes('--evidence')) {
    console.log('\n## Inputs (packages/planner/src/haggis-boards.json)\n');
    console.log('| Activity | Ticks or rate (floor / realistic) | Evidence | Source |');
    console.log('|---|---|---|---|');
    for (const a of activities) {
        const r = a.ticks ?? a.train?.xpPerTick;
        const what = a.train ? `${fmt(a.train.xpPerTick.floor)} / ${fmt(a.train.xpPerTick.realistic)} XP/tick to ${a.train.skill} ${a.train.toLevel}` : `${fmt(r?.floor ?? 0)} / ${fmt(r?.realistic ?? 0)}${a.background ? ` + timer ${a.background.floor} / ${a.background.realistic}` : ''}`;
        console.log(`| ${a.label} | ${what} | ${r?.evidence ?? a.evidence}${a.pending ? ' (pending input)' : ''} | ${(r?.source ?? a.source).replace(/\|/g, '/')} |`);
    }
}

// Each clock board alone: it goes first (after the tutorial and its own prerequisites), everything else after.
console.log('\n## Each board alone, done first (scenario c, all tricks allowed)\n');
console.log('| Board | Deadline | Finish (floor) | Slack (floor) | Finish (realistic) | Slack (realistic) |');
console.log('|---|---|---|---|---|---|');
for (const b of boards) {
    if (b.rule.kind !== 'clock' || b.id === 'overall') continue;
    const others = new Set(boards.filter(x => x.id !== b.id).map(x => x.id));
    const one = (mode: Mode) => schedule(boards, activities, { mode, tricks: new Set(SCENARIOS[2]!.tricks), sacrificed: others }).boards.find(x => x.id === b.id)!;
    const f = one('floor'), r = one('realistic');
    console.log(`| ${b.label} | ${fmt(b.rule.deadline)} | ${fmt(f.finish)} | ${sl(f)} | ${fmt(r.finish)} | ${sl(r)} |`);
}
