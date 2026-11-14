// Writes client-assets/npc-loot.json: the expected drops of one kill of each attackable NPC of the pinned server, by its
// name, as [[item name, expected count], ...] most first. From knowledge/drops.json: an entry's trigger is an NPC
// (debugname) or, with a leading _, an NPC category (category= of the .npc configs); `uses` names the shared drop proc
// whose entry holds the rolls. The expected count of an item is its chance times its count, summed: `always` items at
// chance 1, rolls at their chance, and a table's items at their own chance (already the table's chance times the item's).
// Only unconditional drops count (a members-only or quest branch is left out). death_drop stands for the NPC's
// param=death_drop (default bones, npc_combat.param). One name keeps the variant with the most spawns.
// Run: bun packages/dashboard/gen-npc-loot.ts
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Roll = { item?: string; count?: number; chance?: number; conditional?: boolean; table?: string; items?: Roll[] };
export type DropEntry = { trigger: string; always: Roll[]; rolls: Roll[]; uses?: string };
export type NpcBlock = { debug: string; name: string; category?: string; deathDrop: string; attackable: boolean };

export function npcBlocks(files: string[]): NpcBlock[] {
    const out: NpcBlock[] = [];
    for (const text of files) for (const block of text.split(/^\[/m).slice(1)) {
        const field = (k: string) => block.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim(), name = field('name');
        if (!name) continue;
        out.push({ debug: block.slice(0, block.indexOf(']')), name, category: field('category'), deathDrop: block.match(/^param=death_drop,(\S+)\s*$/m)?.[1] ?? 'bones', attackable: /^op\d=Attack\s*$/m.test(block) });
    }
    return out;
}

export function npcLoot(drops: DropEntry[], npcs: NpcBlock[], itemName: (d: string) => string, spawns: Map<string, number> = new Map()): Record<string, [string, number][]> {
    const byTrigger = new Map(drops.map(d => [d.trigger, d]));
    const forNpc = new Map<string, DropEntry[]>();
    for (const d of drops) {
        const targets = d.trigger.startsWith('_') ? npcs.filter(n => n.category === d.trigger.slice(1)) : npcs.filter(n => n.debug === d.trigger);
        for (const n of targets) forNpc.set(n.debug, [...(forNpc.get(n.debug) ?? []), d]);
    }
    const out: Record<string, [string, number][]> = {}, kept = new Map<string, number>();
    // A shared proc or label is listed as `label:name` or `proc:name`.
    const shared = (u: string) => byTrigger.get(u) ?? byTrigger.get('label:' + u) ?? byTrigger.get('proc:' + u);
    for (const n of npcs.filter(n => n.attackable)) {
        const exp = new Map<string, number>(), add = (item: string | undefined, chance: number, count = 1) => { if (!item || item === 'null' || !(chance > 0)) return; const d = item === 'death_drop' ? n.deathDrop : item; if (d === 'null') return; exp.set(d, (exp.get(d) ?? 0) + chance * count); };
        const entries = (forNpc.get(n.debug) ?? []).flatMap(e => { const s = e.uses ? shared(e.uses) : undefined; return s ? [e, s] : [e]; });
        if (!entries.some(e => e.always.some(a => a.item === 'death_drop'))) add('death_drop', 1);
        for (const e of entries) {
            for (const a of e.always) if (!a.conditional) add(a.item, 1, a.count);
            for (const r of e.rolls) {
                if (r.conditional) continue;
                if (r.table) { for (const it of r.items ?? []) if (!it.conditional) add(it.item, it.chance ?? 0, it.count); }
                else add(r.item, r.chance ?? 0, r.count);
            }
        }
        if (!exp.size) continue;
        // Variants of one name keep the one with the most spawns in the world (the Canifis werewolves are named Man
        // too), then the one with the most drop items (a quest copy with no drop entry).
        const list = [...exp].map(([d, e]) => [itemName(d), Number(e.toPrecision(4))] as [string, number]).sort((a, b) => b[1] - a[1]);
        const sp = spawns.get(n.debug) ?? 0, cur = kept.get(n.name);
        if (!out[n.name] || sp > cur! || (sp === cur && list.length > out[n.name]!.length)) { out[n.name] = list; kept.set(n.name, sp); }
    }
    return out;
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..'), scripts = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts');
    const npcFiles = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? npcFiles(p) : f.endsWith('.npc') ? [readFileSync(p, 'utf8')] : []; });
    const items = JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')) as { debugname?: string; name?: string }[];
    const names = new Map(items.filter(i => i.debugname && i.name).map(i => [i.debugname!, i.name!]));
    const drops = JSON.parse(readFileSync(join(root, 'knowledge', 'drops.json'), 'utf8')) as DropEntry[];
    const npcs = JSON.parse(readFileSync(join(root, 'knowledge', 'npcs.json'), 'utf8')) as { debugname?: string; spawns?: unknown[] }[];
    const spawns = new Map(npcs.filter(n => n.debugname).map(n => [n.debugname!, n.spawns?.length ?? 0]));
    const out = npcLoot(drops, npcBlocks(npcFiles(scripts)), d => names.get(d) ?? d.replace(/_/g, ' '), spawns);
    writeFileSync(join(import.meta.dir, 'client-assets', 'npc-loot.json'), JSON.stringify(out));
    console.log(`npc-loot.json: ${Object.keys(out).length} NPC names`);
}
