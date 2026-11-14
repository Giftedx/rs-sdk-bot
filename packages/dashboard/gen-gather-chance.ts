// Writes client-assets/gather-chance.json: the success roll of each tree and rock of the pinned server, by the name of
// the log or ore it gives, as {item: {tool: [[tool name, low, high], ...]}} for a tree (one roll for each axe,
// skill_woodcutting/configs/trees.dbrow successchance) and {item: {roll: [low, high]}} for a rock
// (skill_mining/configs/mine.dbrow rock_successchance). Both scripts roll stat_random (woodcut.rs2, mining.rs2):
// floor(low*(99-L)/98) + floor(high*(L-1)/98) + 1 beats a roll of 0-255. Two rows that give one item keep the first.
// Run: bun packages/dashboard/gen-gather-chance.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type GatherChance = { tool?: [string, number, number][]; roll?: [number, number] };

export function gatherChance(trees: string, rocks: string, names: Map<string, string>): Record<string, GatherChance> {
    const out: Record<string, GatherChance> = {}, name = (d: string) => names.get(d) ?? d.replace(/_/g, ' ');
    const blocks = (t: string) => t.split(/^\[/m).slice(1).map(b => (k: string) => [...b.matchAll(new RegExp(`^data=${k},(.*)$`, 'gm'))].map(m => m[1]!.trim()));
    for (const get of blocks(trees)) {
        const product = get('product')[0];
        const tool = get('successchance').map(v => v.split(',')).filter(v => v.length === 3 && Number.isFinite(+v[1]!) && Number.isFinite(+v[2]!)).map(v => [name(v[0]!), +v[1]!, +v[2]!] as [string, number, number]);
        if (product && tool.length && !out[name(product)]) out[name(product)] = { tool };
    }
    for (const get of blocks(rocks)) {
        const product = get('rock_output')[0], roll = get('rock_successchance')[0]?.split(',').map(Number);
        if (product && roll?.length === 2 && roll.every(Number.isFinite) && !out[name(product)]) out[name(product)] = { roll: [roll[0]!, roll[1]!] };
    }
    return out;
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..'), scripts = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts');
    const items = JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')) as { debugname?: string; name?: string }[];
    const names = new Map(items.filter(i => i.debugname && i.name).map(i => [i.debugname!, i.name!]));
    const out = gatherChance(readFileSync(join(scripts, 'skill_woodcutting', 'configs', 'trees.dbrow'), 'utf8'), readFileSync(join(scripts, 'skill_mining', 'configs', 'mine.dbrow'), 'utf8'), names);
    writeFileSync(join(import.meta.dir, 'client-assets', 'gather-chance.json'), JSON.stringify(out));
    console.log(`gather-chance.json: ${Object.keys(out).length} logs and ores`);
}
