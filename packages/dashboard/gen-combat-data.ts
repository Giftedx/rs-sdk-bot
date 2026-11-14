// Writes combat assets from the pinned server's knowledge:
// - client-assets/item-bonuses.json for the Worn Equipment tab's Equipment Stats: every wearable item's combat bonuses
//   from knowledge/gear.json, by item ID, as [stab, slash, crush, magic, range attack, stab, slash, crush, magic, range
//   defence, strength, ranged strength, prayer]. Legacy name aliases are present only when all variants agree.
// - client-assets/weapon-speed.json: each weapon's attack rate from knowledge/gear.json, with the same identity rule.
// - client-assets/spellbook.json for the teleport casts and the magic max hit: each teleport spell (knowledge/teleports.json,
//   kind spell) as [name, Magic level, [[rune, count], ...]], the staffs that give each rune without limit, and the combat
//   spells (combatSpells below).
// Run: bun packages/dashboard/gen-combat-data.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BONUSES, type Gear } from '../knowledge/src/gear';

function byIdentity<G extends { id: number; name: string }, T>(gear: readonly G[], valueOf: (item: G) => T | undefined): Record<string, T> {
    const out: Record<string, T> = {}, aliases = new Map<string, { value: T; key: string } | null>();
    for (const item of gear) {
        const value = valueOf(item);
        if (!Number.isSafeInteger(item.id) || item.id < 0 || value === undefined) continue;
        out[item.id] = value;
        if (!item.name || item.name === 'null') continue;
        const key = JSON.stringify(value), prior = aliases.get(item.name);
        if (!aliases.has(item.name)) aliases.set(item.name, { value, key });
        else if (prior && prior.key !== key) aliases.set(item.name, null);
    }
    for (const [name, alias] of aliases) if (alias) out[name] = alias.value;
    return out;
}

export function itemBonuses(gear: readonly Pick<Gear, 'id' | 'name' | 'bonuses'>[]): Record<string, number[]> {
    return byIdentity(gear, item => BONUSES.map(b => item.bonuses[b]));
}

// The combat spells of skill_combat/configs/magic/magic_combat_spells.dbrow: each row with a maxhit, as [name, level,
// max hit, [[rune, count], ...], staff worn or null]. A row with no data=name takes its name from its header
// (magic_spell_iban_blast: Iban Blast; the staff spells have none). Crumble Undead is left out: it hits only undead,
// so it is no general best spell.
export function combatSpells(text: string, names: Map<string, string>): [string, number, number, [string, number][], string | null, number][] {
    const n = (d: string) => names.get(d) ?? d, out: [string, number, number, [string, number][], string | null, number][] = [];
    for (const block of text.split(/^\[/m).slice(1)) {
        const field = (k: string) => block.match(new RegExp(`^data=${k},(.*)$`, 'm'))?.[1]?.trim();
        const header = block.slice(0, block.indexOf(']')).replace(/^magic_spell_/, '').split('_').map((w, i) => i && w === 'of' ? w : w.replace(/^./, c => c.toUpperCase())).join(' ');
        const name = field('name') ?? header, max = Number(field('maxhit')), lv = Number(field('levelrequired'));
        // An NPC's spell (Nezikchened, the god spells an NPC casts) has no level requirement and no runes.
        if (!name || !(max > 0) || !(lv >= 1) || !field('runesrequired') || /^crumble undead$/i.test(name)) continue;
        const parts = (field('runesrequired') ?? '').split(','), runes: [string, number][] = [];
        for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i] && parts[i] !== 'null') runes.push([n(parts[i]!), Number(parts[i + 1])]);
        const worn = field('wornrequired');
        // The sixth field is the cast XP in tenths (experience): pvm_spell_cast gives it on every cast, hit or splash.
        out.push([name, lv, max, runes, worn && worn !== 'null' ? n(worn) : null, Number(field('experience')) || 0]);
    }
    return out.sort((a, b) => a[1] - b[1]);
}

export function spellbook(tp: { teleports: any[]; staffs?: any[] }, names: Map<string, string>, combatText = '') {
    const n = (d: string) => names.get(d) ?? d;
    const spells = tp.teleports.filter(t => t.kind === 'spell').map(t => {
        const lv = (t.requires ?? []).find((r: any) => r.type === 'skill' && r.skill === 'magic')?.level ?? 1;
        return [String(t.name), Number(lv), (t.runes ?? []).map((r: any) => [n(r.item), Number(r.count)])] as [string, number, [string, number][]];
    });
    const staffs: Record<string, string[]> = {};
    for (const s of tp.staffs ?? []) staffs[n(s.rune)] = (s.staffs ?? []).map(n);
    return { spells, staffs, combat: combatText ? combatSpells(combatText, names) : [] };
}

export function weaponSpeeds(gear: readonly Pick<Gear, 'id' | 'name' | 'attackRate'>[]): Record<string, number> {
    return byIdentity(gear, item => Number.isFinite(item.attackRate) && item.attackRate! > 0 ? item.attackRate : undefined);
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..'), content = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts');
    const items = JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')) as { debugname?: string; name?: string }[];
    const names = new Map(items.filter(i => i.debugname && i.name).map(i => [i.debugname!, i.name!]));
    const gear = JSON.parse(readFileSync(join(root, 'knowledge', 'gear.json'), 'utf8')) as Gear[];
    const bonuses = itemBonuses(gear);
    const book = spellbook(JSON.parse(readFileSync(join(root, 'knowledge', 'teleports.json'), 'utf8')), names, readFileSync(join(content, 'skill_combat', 'configs', 'magic', 'magic_combat_spells.dbrow'), 'utf8'));
    writeFileSync(join(import.meta.dir, 'client-assets', 'item-bonuses.json'), JSON.stringify(bonuses));
    writeFileSync(join(import.meta.dir, 'client-assets', 'spellbook.json'), JSON.stringify(book));
    const speeds = weaponSpeeds(gear);
    writeFileSync(join(import.meta.dir, 'client-assets', 'weapon-speed.json'), JSON.stringify(speeds));
    console.log(`item-bonuses.json: ${Object.keys(bonuses).length} ID/name entries; spellbook.json: ${book.spells.length} teleports, ${book.combat.length} combat spells; weapon-speed.json: ${Object.keys(speeds).length} ID/name entries`);
}
