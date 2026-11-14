// Writes client-assets/runecraft.json: each rune of the pinned server's runecraft table, by its name, as
// [level, multiplier] (skill_runecraft/configs/runecraft.dbrow). runecraft.rs2 crafts floor(level / multiplier) + 1 runes
// from each essence; a row with no multiplier crafts 1, written as multiplier 0.
// Run: bun packages/dashboard/gen-runecraft.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function runecraftTable(dbrow: string, names: Map<string, string>): Record<string, [number, number]> {
    const out: Record<string, [number, number]> = {};
    for (const block of dbrow.split(/^\[/m).slice(1)) {
        const get = (k: string) => block.match(new RegExp(`^data=${k},(.*)$`, 'm'))?.[1]?.trim();
        const rune = get('rune');
        if (!rune) continue;
        out[names.get(rune) ?? rune] = [Number(get('level')) || 1, Number(get('multiplier')) || 0];
    }
    return out;
}

// The runes that one essence gives at a Runecraft level, as runecraft.rs2 counts them.
export const runesPerEssence = (level: number, multiplier: number) => multiplier > 0 ? Math.floor(level / multiplier) + 1 : 1;

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const items = JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')) as { debugname?: string; name?: string }[];
    const names = new Map(items.filter(i => i.debugname && i.name).map(i => [i.debugname!, i.name!]));
    const out = runecraftTable(readFileSync(join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts', 'skill_runecraft', 'configs', 'runecraft.dbrow'), 'utf8'), names);
    writeFileSync(join(import.meta.dir, 'client-assets', 'runecraft.json'), JSON.stringify(out));
    console.log(`runecraft.json: ${Object.keys(out).length} runes`);
}
