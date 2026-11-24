// Prices Cairn's published record route (cairn-route.json) against our scenario-a realistic schedule.
// Usage: bun packages/planner/src/cairn-cli.ts [path/to/hiscores.json]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { haggisActivities, haggisTravel, loadSnapshot, scheduleOverall, TRICKS, type Placed } from './haggis';

// `pricedWith`: the id of the step whose rows cover this step too (one row of ours for two steps of Cairn). The step
// has no rows of its own, and its plan and record ticks count in the comparison of the other step.
export interface CairnStep { id: string; label: string; skills: string; plan: number; took: number; ours: string[]; scripts: string[]; capability?: string; pricedWith?: string; note?: string }
export const CAIRN_ROUTE: { source: string; steps: CairnStep[] } = JSON.parse(readFileSync(join(import.meta.dir, 'cairn-route.json'), 'utf8'));

// `plan` and `took` are Cairn's ticks for the step and for each step priced with it. `joined` lists those steps.
export interface StepPrice { step: CairnStep; ours: number | null; plan: number; took: number; joined: string[]; late: string[]; unplaced: string[]; missingScripts: string[] }

// Our ticks for a step are the foreground ticks of its rows plus the walk into each row.
export function priceSteps(order: Placed[], overallFinish: number, steps: CairnStep[], root: string): StepPrice[] {
    const orderById = new Map<string, Placed>();
    for (const p of order) if (!orderById.has(p.id)) orderById.set(p.id, p);
    const joinedByTarget = new Map<string, CairnStep[]>();
    for (const s of steps) {
        if (!s.pricedWith) continue;
        let list = joinedByTarget.get(s.pricedWith);
        if (!list) joinedByTarget.set(s.pricedWith, list = []);
        list.push(s);
    }
    const scriptExists = new Map<string, boolean>();
    const hasScript = (s: string) => {
        const cached = scriptExists.get(s);
        if (cached !== undefined) return cached;
        const ok = existsSync(join(root, s));
        scriptExists.set(s, ok);
        return ok;
    };
    return steps.map(step => {
        const rows = step.ours.map(id => ({ id, placed: orderById.get(id) }));
        const placed = rows.filter(r => r.placed);
        const joined = joinedByTarget.get(step.id) ?? [];
        return {
            step,
            ours: placed.length ? placed.reduce((n, r) => n + r.placed!.ticks + (r.placed!.travel ?? 0), 0) : null,
            plan: joined.reduce((n, s) => n + s.plan, step.plan),
            took: joined.reduce((n, s) => n + s.took, step.took),
            joined: joined.map(s => s.id),
            late: placed.filter(r => r.placed!.end > overallFinish).map(r => r.id),
            unplaced: rows.filter(r => !r.placed).map(r => r.id),
            missingScripts: step.scripts.filter(s => !hasScript(s)),
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
    const real = scheduleOverall(loadSnapshot(snap), haggisActivities(), { mode: 'realistic', tricks: new Set(TRICKS), travel: haggisTravel() });
    const finish = real.overallFinish ?? real.endTick;
    const prices = priceSteps(real.order, finish, CAIRN_ROUTE.steps, root);
    const delivered = deliveredCapabilities(join(root, '.practice', 'coordinator', 'state.json'));
    const fmt = (n: number | null) => (n === null ? '-' : n.toLocaleString('en-US'));

    console.log(`# Cairn route against our model\n\nSource: ${CAIRN_ROUTE.source}. Ours: scenario a, realistic, travel on, snapshot ${snap}.\n`);
    console.log('| Step | Skills | Cairn plan | Cairn took | Ours | Ours - plan | Our rows | Worker script | Delivered capability |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const p of prices) {
        const rows = p.step.pricedWith ? `rows of ${p.step.pricedWith}`
            : p.step.ours.length ? p.step.ours.map(id => id + (p.late.includes(id) ? ' (after Overall)' : p.unplaced.includes(id) ? ' (not placed)' : '')).join(', ') : 'none';
        const scripts = p.step.scripts.length ? p.step.scripts.map(s => s.replace(/^scripts\//, '') + (p.missingScripts.includes(s) ? ' (no file)' : '')).join(', ') : 'none';
        const cap = p.step.capability ? `${p.step.capability}${delivered.has(p.step.capability) ? '' : ' (no passed delivery)'}` : 'none';
        const diff = p.ours === null ? '-' : (p.ours - p.plan > 0 ? '+' : '') + fmt(p.ours - p.plan) + (p.joined.length ? ` (plan ${fmt(p.plan)} with ${p.joined.join(', ')})` : '');
        console.log(`| ${p.step.label}${p.step.note ? ` (${p.step.note})` : ''} | ${p.step.skills} | ${fmt(p.step.plan)} | ${fmt(p.step.took)} | ${p.step.pricedWith ? `in ${p.step.pricedWith}` : fmt(p.ours)} | ${diff} | ${rows} | ${scripts} | ${cap} |`);
    }
    const mapped = new Set(CAIRN_ROUTE.steps.flatMap(s => s.ours));
    const extra = real.order.filter(p => !mapped.has(p.id) && p.end <= finish && p.ticks + (p.travel ?? 0) > 0);
    console.log('\n## Our rows before our Overall finish that Cairn\'s route does not have\n\n| Row | Ticks incl. walk |\n|---|---|');
    for (const p of extra) console.log(`| ${p.id}: ${p.label.slice(0, 70)} | ${fmt(p.ticks + (p.travel ?? 0))} |`);
    const sum = (f: (s: CairnStep) => number) => CAIRN_ROUTE.steps.reduce((n, s) => n + f(s), 0);
    console.log(`\n## Totals\n\n- Cairn plan ${fmt(sum(s => s.plan))}, Cairn took ${fmt(sum(s => s.took))}.`);
    console.log(`- Our Overall finish ${fmt(finish)}, of which walking ${fmt(real.travel)}. Extra rows ${fmt(extra.reduce((n, p) => n + p.ticks + (p.travel ?? 0), 0))}.`);
    const blocked = prices.filter(p => !p.step.scripts.length || p.missingScripts.length || (!p.step.ours.length && !p.step.pricedWith));
    console.log(`\n## Steps we cannot run or price yet (${blocked.length} of ${prices.length})\n`);
    for (const p of blocked) {
        const why = [!p.step.ours.length && !p.step.pricedWith && 'no planner row', !p.step.scripts.length && 'no worker script', p.missingScripts.length && `missing file ${p.missingScripts.join(', ')}`].filter(Boolean).join('; ');
        console.log(`- ${p.step.label}: ${why}`);
    }
}
