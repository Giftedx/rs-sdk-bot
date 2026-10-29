// Prices Cairn's published record route (cairn-route.json) against our scenario-a realistic schedule.
// Usage: bun packages/planner/src/cairn-cli.ts [path/to/hiscores.json]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { haggisActivities, haggisTravel, loadSnapshot, schedule, TRICKS, type Placed } from './haggis';

export interface CairnStep { id: string; label: string; skills: string; plan: number; took: number; ours: string[]; scripts: string[]; capability?: string; note?: string }
export const CAIRN_ROUTE: { source: string; steps: CairnStep[] } = JSON.parse(readFileSync(join(import.meta.dir, 'cairn-route.json'), 'utf8'));

export interface StepPrice { step: CairnStep; ours: number | null; late: string[]; unplaced: string[]; missingScripts: string[] }

// Our ticks for a step are the foreground ticks of its rows plus the walk into each row.
export function priceSteps(order: Placed[], overallFinish: number, steps: CairnStep[], root: string): StepPrice[] {
    return steps.map(step => {
        const rows = step.ours.map(id => ({ id, placed: order.find(p => p.id === id) }));
        const placed = rows.filter(r => r.placed);
        return {
            step,
            ours: placed.length ? placed.reduce((n, r) => n + r.placed!.ticks + (r.placed!.travel ?? 0), 0) : null,
            late: placed.filter(r => r.placed!.end > overallFinish).map(r => r.id),
            unplaced: rows.filter(r => !r.placed).map(r => r.id),
            missingScripts: step.scripts.filter(s => !existsSync(join(root, s))),
        };
    });
}

// Capabilities with a succeeded build or qualify in the coordinator queue. A passed delivery covers only its own consumer.
export function deliveredCapabilities(statePath: string): Set<string> {
    if (!existsSync(statePath)) return new Set();
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    return new Set((state.tasks ?? []).filter((r: any) => (r.spec?.kind === 'build' || r.spec?.kind === 'qualify') && r.status === 'succeeded').map((r: any) => r.spec.capability));
}

if (import.meta.main) {
    const root = resolve(import.meta.dir, '..', '..', '..');
    const snap = process.argv.slice(2).find(a => !a.startsWith('--')) ?? join(root, 'research', 'hiscores-live.json');
    const real = schedule(loadSnapshot(snap), haggisActivities(), { mode: 'realistic', tricks: new Set(TRICKS), travel: haggisTravel() });
    const finish = real.overallFinish ?? real.endTick;
    const prices = priceSteps(real.order, finish, CAIRN_ROUTE.steps, root);
    const delivered = deliveredCapabilities(join(root, '.practice', 'coordinator', 'state.json'));
    const fmt = (n: number | null) => (n === null ? '-' : n.toLocaleString('en-US'));

    console.log(`# Cairn route against our model\n\nSource: ${CAIRN_ROUTE.source}. Ours: scenario a, realistic, travel on, snapshot ${snap}.\n`);
    console.log('| Step | Skills | Cairn plan | Cairn took | Ours | Ours - plan | Our rows | Worker script | Delivered capability |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const p of prices) {
        const rows = p.step.ours.length ? p.step.ours.map(id => id + (p.late.includes(id) ? ' (after Overall)' : p.unplaced.includes(id) ? ' (not placed)' : '')).join(', ') : 'none';
        const scripts = p.step.scripts.length ? p.step.scripts.map(s => s.replace(/^scripts\//, '') + (p.missingScripts.includes(s) ? ' (no file)' : '')).join(', ') : 'none';
        const cap = p.step.capability ? `${p.step.capability}${delivered.has(p.step.capability) ? '' : ' (no passed delivery)'}` : 'none';
        const diff = p.ours === null ? '-' : (p.ours - p.step.plan > 0 ? '+' : '') + fmt(p.ours - p.step.plan);
        console.log(`| ${p.step.label}${p.step.note ? ` (${p.step.note})` : ''} | ${p.step.skills} | ${fmt(p.step.plan)} | ${fmt(p.step.took)} | ${fmt(p.ours)} | ${diff} | ${rows} | ${scripts} | ${cap} |`);
    }
    const mapped = new Set(CAIRN_ROUTE.steps.flatMap(s => s.ours));
    const extra = real.order.filter(p => !mapped.has(p.id) && p.end <= finish && p.ticks + (p.travel ?? 0) > 0);
    console.log('\n## Our rows before our Overall finish that Cairn\'s route does not have\n\n| Row | Ticks incl. walk |\n|---|---|');
    for (const p of extra) console.log(`| ${p.id}: ${p.label.slice(0, 70)} | ${fmt(p.ticks + (p.travel ?? 0))} |`);
    const sum = (f: (s: CairnStep) => number) => CAIRN_ROUTE.steps.reduce((n, s) => n + f(s), 0);
    console.log(`\n## Totals\n\n- Cairn plan ${fmt(sum(s => s.plan))}, Cairn took ${fmt(sum(s => s.took))}.`);
    console.log(`- Our Overall finish ${fmt(finish)}, of which walking ${fmt(real.travel)}. Extra rows ${fmt(extra.reduce((n, p) => n + p.ticks + (p.travel ?? 0), 0))}.`);
    const blocked = prices.filter(p => !p.step.scripts.length || p.missingScripts.length || !p.step.ours.length);
    console.log(`\n## Steps we cannot run or price yet (${blocked.length} of ${prices.length})\n`);
    for (const p of blocked) {
        const why = [!p.step.ours.length && 'no planner row', !p.step.scripts.length && 'no worker script', p.missingScripts.length && `missing file ${p.missingScripts.join(', ')}`].filter(Boolean).join('; ');
        console.log(`- ${p.step.label}: ${why}`);
    }
}
