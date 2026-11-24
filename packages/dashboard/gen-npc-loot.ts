// Writes client-assets/npc-loot.json: the expected drops of one kill of each attackable NPC of the pinned server, by its
// name, as [[item name, expected count, optional item id], ...] most first. From knowledge/drops.json: an entry's trigger is an NPC
// (debugname) or, with a leading _, an NPC category (category= of the .npc configs); `uses` names the shared drop proc
// whose entry holds the rolls. The expected count of an item is its chance times its count, summed: `always` items at
// chance 1, rolls at their chance, and a table's items at their own chance (already the table's chance times the item's);
// a ranged quantity (count to countMax) counts its mean.
// Only unconditional drops count (a members-only or quest branch is left out). An NPC with no drop handler drops its
// death drop alone (as item-sources.ts takes the default death). death_drop stands for the NPC's
// param=death_drop (default bones, npc_combat.param). One name keeps the variant with the most spawns.
// Run: bun packages/dashboard/gen-npc-loot.ts
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Roll = { item?: string; count?: number; countMax?: number; chance?: number; conditional?: boolean; table?: string; items?: Roll[] };
export type DropEntry = { trigger: string; always: Roll[]; rolls: Roll[]; uses?: string };
export type NpcBlock = { debug: string; name: string; category?: string; deathDrop: string; attackable: boolean };
// A resolver makes identity explicit: null is unresolved; only legacy calls omit the third field.
export type ExpectedLoot = [string, number, (number | null)?];

const LOOT_NAME_RE = /^name=(.*)$/m;
const LOOT_CAT_RE = /^category=(.*)$/m;
const LOOT_DEATH_DROP_RE = /^param=death_drop,(\S+)\s*$/m;
const LOOT_ATTACK_RE = /^op\d=Attack\s*$/m;

export function npcBlocks(files: string[]): NpcBlock[] {
    const out: NpcBlock[] = [];
    for (const text of files) for (const block of text.split(/^\[/m).slice(1)) {
        const name = block.match(LOOT_NAME_RE)?.[1]?.trim();
        if (!name) continue;
        out.push({
            debug: block.slice(0, block.indexOf(']')),
            name,
            category: block.match(LOOT_CAT_RE)?.[1]?.trim(),
            deathDrop: block.match(LOOT_DEATH_DROP_RE)?.[1] ?? 'bones',
            attackable: LOOT_ATTACK_RE.test(block),
        });
    }
    return out;
}

export function npcLoot(drops: DropEntry[], npcs: NpcBlock[], itemName: (d: string) => string, spawns: Map<string, number> = new Map(), itemId?: (d: string) => number | undefined): Record<string, ExpectedLoot[]> {
    const byTrigger = new Map(drops.map(d => [d.trigger, d]));
    const npcsByCategory = new Map<string, NpcBlock[]>();
    const npcsByDebug = new Map<string, NpcBlock[]>();
    for (let i = 0; i < npcs.length; i++) {
        const n = npcs[i]!;
        if (n.category) {
            let list = npcsByCategory.get(n.category);
            if (!list) { list = []; npcsByCategory.set(n.category, list); }
            list.push(n);
        }
        let dList = npcsByDebug.get(n.debug);
        if (!dList) { dList = []; npcsByDebug.set(n.debug, dList); }
        dList.push(n);
    }
    // A ranged quantity (count to countMax) counts its mean.
    const mean = (r: Roll) => r.countMax != null && r.countMax > (r.count ?? 1) ? ((r.count ?? 1) + r.countMax) / 2 : (r.count ?? 1);
    const forNpc = new Map<string, DropEntry[]>();
    for (const d of drops) {
        const targets = d.trigger.startsWith('_') ? npcsByCategory.get(d.trigger.slice(1)) : npcsByDebug.get(d.trigger);
        if (!targets) continue;
        for (const n of targets) {
            let list = forNpc.get(n.debug);
            if (!list) { list = []; forNpc.set(n.debug, list); }
            list.push(d);
        }
    }
    const out: Record<string, ExpectedLoot[]> = {}, kept = new Map<string, number>();
    // A shared proc or label is listed as `label:name` or `proc:name`.
    // The explicit label: or proc: entry comes first: a label can share its name with an NPC handler (skeleton_armed),
    // and the bare name would read the empty handler again.
    const shared = (u: string) => byTrigger.get('label:' + u) ?? byTrigger.get('proc:' + u) ?? byTrigger.get(u);
    for (const n of npcs) {
        if (!n.attackable) continue;
        const exp = new Map<string, number>(), add = (item: string | undefined, chance: number, count = 1) => { if (!item || item === 'null' || !(chance > 0)) return; const d = item === 'death_drop' ? n.deathDrop : item; if (d === 'null') return; exp.set(d, (exp.get(d) ?? 0) + chance * count); };
        const rawEntries = forNpc.get(n.debug);
        const entries: DropEntry[] = [];
        if (rawEntries) {
            for (const e of rawEntries) {
                entries.push(e);
                const s = e.uses ? shared(e.uses) : undefined;
                if (s) entries.push(s);
            }
        }
        // An NPC with no drop handler drops its death drop (the default death); a handler drops what it lists.
        if (!entries.length) add('death_drop', 1);
        for (const e of entries) {
            for (const a of e.always) if (!a.conditional) add(a.item, 1, mean(a));
            for (const r of e.rolls) {
                if (r.conditional) continue;
                if (r.table) { for (const it of r.items ?? []) if (!it.conditional) add(it.item, it.chance ?? 0, mean(it)); }
                else add(r.item, r.chance ?? 0, mean(r));
            }
        }
        if (!exp.size) continue;
        // Variants of one name keep the one with the most spawns in the world (the Canifis werewolves are named Man
        // too), then the one with the most drop items (a quest copy with no drop entry).
        const list = [...exp].map(([d, e]): ExpectedLoot => {
            const row: ExpectedLoot = [itemName(d), Number(e.toPrecision(4))], id = itemId?.(d);
            if (itemId) row[2] = Number.isSafeInteger(id) && id! >= 0 ? id! : null;
            return row;
        }).sort((a, b) => b[1] - a[1]);
        const sp = spawns.get(n.debug) ?? 0, cur = kept.get(n.name);
        if (!out[n.name] || sp > cur! || (sp === cur && list.length > out[n.name]!.length)) { out[n.name] = list; kept.set(n.name, sp); }
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..'), scripts = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts');
    const npcFiles = (d: string): string[] => readdirSync(d).sort().flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? npcFiles(p) : f.endsWith('.npc') ? [readFileSync(p, 'utf8')] : []; });
    const items = JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')) as { id?: number; debugname?: string; name?: string }[];
    const names = new Map(items.filter(i => i.debugname && i.name).map(i => [i.debugname!, i.name!]));
    const ids = new Map(items.filter(i => i.debugname && Number.isSafeInteger(i.id) && i.id! >= 0).map(i => [i.debugname!, i.id!]));
    const drops = JSON.parse(readFileSync(join(root, 'knowledge', 'drops.json'), 'utf8')) as DropEntry[];
    const npcs = JSON.parse(readFileSync(join(root, 'knowledge', 'npcs.json'), 'utf8')) as { debugname?: string; spawns?: unknown[] }[];
    const spawns = new Map(npcs.filter(n => n.debugname).map(n => [n.debugname!, n.spawns?.length ?? 0]));
    const out = npcLoot(drops, npcBlocks(npcFiles(scripts)), d => names.get(d) ?? d.replace(/_/g, ' '), spawns, d => ids.get(d));
    writeFileSync(join(import.meta.dir, 'client-assets', 'npc-loot.json'), JSON.stringify(out));
    console.log(`npc-loot.json: ${Object.keys(out).length} NPC names`);
}
