// Writes client-assets/skill-actions.json for the XP Tracker's Skill Calculator (RuneLite's Skill Calculator): the
// actions of each skill that the pinned server's tables define (knowledge/skills.json), as {skill: [[name, level, xp,
// inputs, outputs], ...]} with item display names (knowledge/items.json). The XP is the server's own per action.
// Run: bun packages/dashboard/gen-skill-actions.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SkillRow = { skill: string; row: string; level: number; xp: number; inputs?: string[]; outputs?: string[] };
export type Action = [string, number, number, string[], string[]];

const label = (row: string) => row.replace(/_table$/, '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

export function skillActions(rows: SkillRow[], names: Map<string, string>): Record<string, Action[]> {
    const name = (debug: string) => names.get(debug) ?? debug.replace(/_/g, ' ');
    const out: Record<string, Action[]> = {};
    for (const r of rows) {
        if (!r.skill || !Number.isFinite(r.level) || !(r.xp > 0)) continue;
        const outputs = (r.outputs ?? []).map(name), inputs = (r.inputs ?? []).map(name);
        (out[r.skill] ??= []).push([outputs[0] ?? label(r.row), Math.max(1, r.level), r.xp, inputs, outputs]);
    }
    for (const list of Object.values(out)) list.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0].localeCompare(b[0]));
    return out;
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const items: { debugname?: string; name?: string }[] = JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8'));
    const names = new Map(items.filter(i => i.debugname && i.name).map(i => [i.debugname!, i.name!]));
    const actions = skillActions(JSON.parse(readFileSync(join(root, 'knowledge', 'skills.json'), 'utf8')), names);
    writeFileSync(join(import.meta.dir, 'client-assets', 'skill-actions.json'), JSON.stringify(actions));
    console.log(`skill-actions.json: ${Object.values(actions).reduce((n, l) => n + l.length, 0)} actions in ${Object.keys(actions).length} skills`);
}
