// Writes two client assets from the pinned server's content:
// - client-assets/item-bonuses.json for the Worn Equipment tab's Equipment Stats: each item's combat bonuses from its
//   .obj config (param=stabattack,7 ...), by display name, as [stab, slash, crush, magic, range attack, stab, slash,
//   crush, magic, range defence, strength, ranged strength, prayer]; items with no bonus are left out.
// - client-assets/spellbook.json for the teleport casts: each teleport spell (knowledge/teleports.json, kind spell) as
//   [name, Magic level, [[rune, count], ...]], and the staffs that give each rune without limit.
// Run: bun packages/dashboard/gen-combat-data.ts
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BONUS = ['stabattack', 'slashattack', 'crushattack', 'magicattack', 'rangeattack', 'stabdefence', 'slashdefence', 'crushdefence', 'magicdefence', 'rangedefence', 'strengthbonus', 'rangebonus', 'prayerbonus'];

// One .obj file: each [debugname] block with its name= and its bonus params.
export function objBonuses(text: string): { debug: string; name: string | null; bonus: number[] }[] {
    const out: { debug: string; name: string | null; bonus: number[] }[] = [];
    let cur: { debug: string; name: string | null; bonus: number[] } | null = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim(), head = line.match(/^\[([^\]]+)\]$/);
        if (head) { cur = { debug: head[1]!, name: null, bonus: BONUS.map(() => 0) }; out.push(cur); continue; }
        if (!cur) continue;
        if (line.startsWith('name=')) cur.name = line.slice(5);
        const p = line.match(/^param=([a-z]+),(-?\d+)$/);
        if (p) { const i = BONUS.indexOf(p[1]!); if (i >= 0) cur.bonus[i] = Number(p[2]); }
    }
    return out;
}

export function itemBonuses(blocks: { debug: string; name: string | null; bonus: number[] }[], names: Map<string, string>): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const b of blocks) {
        const name = b.name ?? names.get(b.debug);
        if (!name || name === 'null' || b.bonus.every(v => v === 0) || out[name]) continue;
        out[name] = b.bonus;
    }
    return out;
}

export function spellbook(tp: { teleports: any[]; staffs?: any[] }, names: Map<string, string>) {
    const n = (d: string) => names.get(d) ?? d;
    const spells = tp.teleports.filter(t => t.kind === 'spell').map(t => {
        const lv = (t.requires ?? []).find((r: any) => r.type === 'skill' && r.skill === 'magic')?.level ?? 1;
        return [String(t.name), Number(lv), (t.runes ?? []).map((r: any) => [n(r.item), Number(r.count)])] as [string, number, [string, number][]];
    });
    const staffs: Record<string, string[]> = {};
    for (const s of tp.staffs ?? []) staffs[n(s.rune)] = (s.staffs ?? []).map(n);
    return { spells, staffs };
}

const objFiles = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? objFiles(p) : f.endsWith('.obj') ? [p] : []; });

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..'), content = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts');
    const items = JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')) as { debugname?: string; name?: string }[];
    const names = new Map(items.filter(i => i.debugname && i.name).map(i => [i.debugname!, i.name!]));
    const bonuses = itemBonuses(objFiles(content).flatMap(f => objBonuses(readFileSync(f, 'utf8'))), names);
    const book = spellbook(JSON.parse(readFileSync(join(root, 'knowledge', 'teleports.json'), 'utf8')), names);
    writeFileSync(join(import.meta.dir, 'client-assets', 'item-bonuses.json'), JSON.stringify(bonuses));
    writeFileSync(join(import.meta.dir, 'client-assets', 'spellbook.json'), JSON.stringify(book));
    console.log(`item-bonuses.json: ${Object.keys(bonuses).length} items; spellbook.json: ${book.spells.length} spells`);
}
