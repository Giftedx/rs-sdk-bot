// Writes client-assets/skill-actions.json for the XP Tracker's Skill Calculator (RuneLite's Skill Calculator): the
// actions of each skill that the pinned server's tables define (knowledge/skills.json), as {skill: [[name, level, xp,
// inputs, outputs], ...]} with item display names. An action is named after its first output, or after its table row
// when several rows of the skill give the same first output (each pickpocket target gives Coins). (knowledge/items.json). The XP is the XP that one action gives on this
// server: the table's base XP times the server's XP rate (XP_RATE, 25).
// Run: bun packages/dashboard/gen-skill-actions.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { XP_RATE } from '../knowledge/src/method-model';

export type SkillRow = { skill: string; row: string; level: number; xp: number; inputs?: string[]; outputs?: string[] };
export type Action = [string, number, number, string[], string[]];

// "limestone_rock1_table" is "Limestone rock": a rock or tree number is a map variant, not a different action.
const label = (row: string) => row.replace(/_table$/, '').replace(/(rock|tree)\d+$/, '$1').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

export function skillActions(rows: SkillRow[], names: Map<string, string>, rate = XP_RATE): Record<string, Action[]> {
    const name = (debug: string) => names.get(debug) ?? debug.replace(/_/g, ' ');
    const out: Record<string, Action[]> = {};
    const firstOut = (r: SkillRow) => r.skill + '|' + (r.outputs?.[0] ?? '');
    const uses = new Map<string, number>();
    for (const r of rows) if (r.outputs?.[0]) uses.set(firstOut(r), (uses.get(firstOut(r)) ?? 0) + 1);
    for (const r of rows) {
        if (!r.skill || !Number.isFinite(r.level) || !(r.xp > 0)) continue;
        const outputs = (r.outputs ?? []).map(name), inputs = (r.inputs ?? []).map(name);
        const action: Action = [outputs[0] && uses.get(firstOut(r)) === 1 ? outputs[0] : label(r.row), Math.max(1, r.level), Math.round(r.xp * rate * 10) / 10, inputs, outputs];
        // Map variants of one action (Limestone rock 1 to 3) give one row.
        const list = (out[r.skill] ??= []);
        if (!list.some(a => a[0] === action[0] && a[1] === action[1] && a[2] === action[2])) list.push(action);
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
