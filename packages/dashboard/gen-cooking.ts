// Writes client-assets/cooking.json: the burn roll of each raw food of the pinned server, by the raw item's name, from
// skill_cooking/configs/cooking_source/cooking_generic.dbrow. Each entry is {c: cooked name, lv: level required,
// f: [low, high] on a fire, r: [low, high] on a range when it differs, g: [low, high] with cooking gauntlets}.
// The engine (PlayerOps.ts STAT_RANDOM) cooks when floor(low*(99-L)/98) + floor(high*(L-1)/98) + 1 beats a roll of
// 0-255, with L the current Cooking level up to 99. [0, 0] always burns and [1, 1] never burns (cooking.rs2).
// Rows that make a burnt item or never burn are left out.
// Run: bun packages/dashboard/gen-cooking.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type CookRow = { c: string; lv: number; f: [number, number]; r?: [number, number]; g?: [number, number] };

export function parseCooking(dbrow: string, names: Map<string, string>): Record<string, CookRow> {
    const out: Record<string, CookRow> = {};
    for (const block of dbrow.split(/^\[/m).slice(1)) {
        const field = new Map<string, string>();
        for (const line of block.split(/\r?\n/)) {
            const m = line.match(/^data=([a-z_]+),(.*)$/);
            if (m) field.set(m[1]!, m[2]!.trim());
        }
        const pair = (k: string): [number, number] | undefined => {
            const v = field.get(k)?.split(',').map(Number);
            return v && v.length === 2 && v.every(Number.isFinite) ? [v[0]!, v[1]!] : undefined;
        };
        const raw = names.get(field.get('uncooked') ?? ''), cooked = names.get(field.get('cooked') ?? ''), f = pair('successchance');
        if (!raw || !cooked || !f) continue;
        const row: CookRow = { c: cooked, lv: Number(field.get('levelrequired') ?? 1) || 1, f };
        const r = pair('successchance_range'), g = pair('successchance_gauntlets');
        // A row that makes a burnt item, or that never burns, has no burn chance to show.
        if (/^burnt /i.test(cooked) || [f, r].every(p => !p || (p[0] === 1 && p[1] === 1))) continue;
        if (r) row.r = r;
        if (g) row.g = g;
        out[raw] = row;
    }
    return out;
}

// The chance (0-1) that one cook succeeds at a Cooking level, as the engine rolls it.
export function cookChance([low, high]: [number, number], level: number): number {
    if (low === 0 && high === 0) return 0;
    if (low === 1 && high === 1) return 1;
    const L = Math.min(level, 99), value = Math.floor(low * (99 - L) / 98) + Math.floor(high * (L - 1) / 98) + 1;
    return Math.min(value, 256) / 256;
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const items = JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')) as { debugname: string; name: string }[];
    const names = new Map(items.filter(i => i.debugname && i.name).map(i => [i.debugname, i.name]));
    const dbrow = readFileSync(join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts', 'skill_cooking', 'configs', 'cooking_source', 'cooking_generic.dbrow'), 'utf8');
    const out = parseCooking(dbrow, names);
    writeFileSync(join(import.meta.dir, 'client-assets', 'cooking.json'), JSON.stringify(out));
    console.log(`cooking.json: ${Object.keys(out).length} raw foods`);
}
