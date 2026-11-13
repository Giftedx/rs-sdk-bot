// Every wearable item of the content and its real numbers (knowledge/gear.json, from packages/knowledge/src/gear.ts:
// the item configs, levelrequire/scripts/tier*.rs2 and pvp_special_attack.rs2). Look here before naming the best
// item for a slot or saying an item does not exist.
// Usage:
//   bun scripts/gear.ts show <name|debugname ...>        every field of each item
//   bun scripts/gear.ts find <regex>                      items whose name or debugname match, with slot and id
//   bun scripts/gear.ts slots                             how many items each slot has
//   bun scripts/gear.ts best <slot> [--weights rangeAttack:1,magicDefence:0.5] [--levels attack=99,defence=40]
//                            [--quests "Dragon Slayer,Lost City"] [--top 10] [--all]
//        the slot's items ranked by the weighted sum of their bonuses; --levels and --quests drop what the account
//        cannot wear (default: all 99, every quest), and staff-only items are left out; --all keeps them
//   bun scripts/gear.ts compare <a> <b ...>               the bonuses side by side
//   bun scripts/gear.ts kit <kit ...>                     the summed bonuses of a scripts/pk-kits.ts kit's worn items
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Bonus, Gear, Skill } from '../packages/knowledge/src/gear';
import { BONUSES } from '../packages/knowledge/src/gear';

const root = resolve(import.meta.dir, '..');
export const loadGear = (): Gear[] => JSON.parse(readFileSync(join(root, 'knowledge', 'gear.json'), 'utf8'));
const MAXED: Record<Skill, number> = { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 };

export function canWear(g: Gear, levels: Partial<Record<Skill, number>>, quests: ReadonlySet<string> | null): boolean {
    for (const [s, n] of Object.entries(g.requires.skills)) if ((levels[s as Skill] ?? 1) < n!) return false;
    return !g.requires.quest || !quests || quests.has(g.requires.quest);
}
export const score = (g: Gear, weights: Partial<Record<Bonus, number>>) => Object.entries(weights).reduce((n, [k, w]) => n + (g.bonuses[k as Bonus] ?? 0) * w!, 0);
export function best(gear: readonly Gear[], slot: string, weights: Partial<Record<Bonus, number>>, levels: Partial<Record<Skill, number>> = MAXED, quests: ReadonlySet<string> | null = null, all = false): Gear[] {
    return gear.filter(g => g.slot === slot && (all || (!g.staffOnly && canWear(g, levels, quests)))).sort((a, b) => score(b, weights) - score(a, weights) || a.id - b.id);
}
export function sumBonuses(items: readonly Gear[]): Record<Bonus, number> {
    const sum = Object.fromEntries(BONUSES.map(b => [b, 0])) as Record<Bonus, number>;
    for (const g of items) for (const b of BONUSES) sum[b] += g.bonuses[b];
    return sum;
}

const short = (b: Partial<Record<Bonus, number>>) => Object.entries(b).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ');
const reqText = (g: Gear) => [Object.entries(g.requires.skills).map(([s, n]) => `${s} ${n}`).join(' '), g.requires.quest ?? ''].filter(Boolean).join(', ') || '-';

if (import.meta.main) {
    const [cmd, ...rest] = process.argv.slice(2);
    const flag = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
    const words = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1]!.startsWith('--') && rest[i - 1] !== '--all'));
    const gear = loadGear();
    const find = (q: string) => gear.find(g => g.debugname === q || g.name.toLowerCase() === q.toLowerCase());
    if (cmd === 'show') for (const q of words) console.log(JSON.stringify(find(q) ?? { missing: q }, null, 1));
    else if (cmd === 'find') { const re = new RegExp(words[0] ?? '.', 'i'); for (const g of gear.filter(g => re.test(g.name) || re.test(g.debugname))) console.log(`${g.id}\t${g.slot}\t${g.debugname}\t${g.name}`); }
    else if (cmd === 'slots') { const n = new Map<string, number>(); for (const g of gear) n.set(g.slot, (n.get(g.slot) ?? 0) + 1); console.log([...n].sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s} ${c}`).join('\n')); }
    else if (cmd === 'best') {
        const slot = words[0];
        if (!slot) { console.log('usage: bun scripts/gear.ts best <slot> [--weights b:w,...]'); process.exit(2); }
        const weights = Object.fromEntries((flag('--weights') ?? 'stabDefence:1,slashDefence:1,crushDefence:1,magicDefence:1,rangeDefence:1').split(',').map(p => { const [k, w] = p.split(':'); return [k, Number(w ?? 1)]; })) as Partial<Record<Bonus, number>>;
        for (const k of Object.keys(weights)) if (!(BONUSES as string[]).includes(k)) { console.log(`unknown bonus ${k}; bonuses: ${BONUSES.join(' ')}`); process.exit(2); }
        const levels = flag('--levels') ? { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1, ...Object.fromEntries(flag('--levels')!.split(',').map(p => { const [k, v] = p.split('='); return [k, Number(v)]; })) } : MAXED;
        const quests = flag('--quests') ? new Set(flag('--quests')!.split(',').map(q => q.trim())) : null;
        const ranked = best(gear, slot, weights, levels, quests, rest.includes('--all')).slice(0, Number(flag('--top') ?? 10));
        if (!ranked.length) console.log(`no item for slot ${slot}; slots: ${[...new Set(gear.map(g => g.slot))].join(' ')}`);
        for (const g of ranked) console.log(`${score(g, weights).toFixed(1).padStart(7)}  ${g.debugname.padEnd(28)} ${reqText(g).padEnd(30)} ${short(g.bonuses)}${g.attackRate ? ` | rate ${g.attackRate}` : ''}${g.special ? ` | special ${g.special.energy}${g.special.pvp ? ' pvp' : ''}` : ''}`);
    } else if (cmd === 'compare') {
        const items = words.map(q => find(q) ?? (console.log(`missing ${q}`), process.exit(2)));
        console.log(['bonus'.padEnd(14), ...items.map(g => g.debugname.slice(0, 22).padStart(23))].join(''));
        for (const b of BONUSES) console.log([b.padEnd(14), ...items.map(g => String(g.bonuses[b]).padStart(23))].join(''));
        console.log(['requires'.padEnd(14), ...items.map(g => reqText(g).slice(0, 22).padStart(23))].join(''));
    } else if (cmd === 'kit') {
        const { kitItems } = await import('./pk-kits');
        for (const k of words) {
            const worn = kitItems(k).equipment.map(e => gear.find(g => g.id === e.id)).filter((g): g is Gear => !!g);
            console.log(`${k}: ${worn.map(g => g.debugname).join(' ')}\n  ${short(sumBonuses(worn))}`);
        }
    } else { console.log('usage: bun scripts/gear.ts show|find|slots|best|compare|kit ...'); process.exit(2); }
}
