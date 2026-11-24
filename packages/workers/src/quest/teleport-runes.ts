// Whether a teleport spell can be cast from what the pack holds, the staff worn and the Magic level: every rune the
// spell costs (knowledge/teleports.json, from magic_spells.dbrow), a worn elemental staff standing in for its rune
// (magic_staff.dbrow), and the spell's level against the current Magic level (stat(magic), teleport.rs2).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Tele = { trigger?: string; runes?: { id: number; count: number; item: string }[]; requires?: { type: string; skill?: string; level?: number }[] };
type Staff = { rune: string; staffs: string[] };

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
let data: { teleports: Tele[]; staffs: Staff[] } | undefined;
let teleportByTrigger: Map<string, Tele> | undefined;
let names: Map<number, string> | undefined;

const load = () => {
    if (!data) {
        data = JSON.parse(readFileSync(resolve(REPO_ROOT, 'knowledge/teleports.json'), 'utf8'));
        teleportByTrigger = new Map();
        for (const t of data!.teleports) if (t.trigger) teleportByTrigger.set(t.trigger, t);
    }
    return data!;
};
const debugname = (id: number) => {
    if (!names) {
        const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, 'knowledge/items.json'), 'utf8')) as { id: number; debugname: string }[];
        names = new Map();
        for (let i = 0; i < raw.length; i++) names.set(raw[i]!.id, raw[i]!.debugname);
    }
    return names.get(id);
};

function findTeleport(comp: string, teleports?: readonly Tele[]): Tele | undefined {
    const trigger = `[if_button,${comp}]`;
    if (!teleports) {
        load();
        return teleportByTrigger!.get(trigger);
    }
    if (data && teleports === data.teleports) return teleportByTrigger!.get(trigger);
    return teleports.find(t => t.trigger === trigger);
}

// The runes a spell component costs, by item id; null for a component no teleport spell has.
export function spellRunes(comp: string, teleports?: readonly Tele[]): Record<number, number> | null {
    const t = findTeleport(comp, teleports);
    if (!t) return null;
    const out: Record<number, number> = {};
    for (const r of t.runes ?? []) out[r.id] = (out[r.id] ?? 0) + r.count;
    return out;
}

// The rune debugnames a set of worn staffs stands in for.
export function staffRunes(worn: readonly string[], staffs: readonly Staff[] = load().staffs): Set<string> {
    const out = new Set<string>();
    if (!worn.length) return out;
    for (let i = 0; i < staffs.length; i++) {
        const s = staffs[i]!;
        if (s.staffs.some(n => worn.includes(n))) out.add(s.rune);
    }
    return out;
}

const RUNE_NAMES: Record<number, string> = { 554: 'firerune', 555: 'waterrune', 556: 'airrune', 557: 'earthrune', 563: 'lawrune' };

// The Magic level a spell needs; null for a component no teleport spell has.
export function spellLevel(comp: string, teleports?: readonly Tele[]): number | null {
    const t = findTeleport(comp, teleports);
    if (!t) return null;
    return t.requires?.find(r => r.type === 'skill' && r.skill === 'magic')?.level ?? 1;
}

export function castable(
    comp: string,
    count: (id: number) => number,
    wornIds: readonly number[] = [],
    magic = 99,
    teleports?: readonly Tele[],
    staffs: readonly Staff[] = load().staffs,
): boolean {
    const t = findTeleport(comp, teleports);
    if (!t) return false;
    const level = t.requires?.find(r => r.type === 'skill' && r.skill === 'magic')?.level ?? 1;
    if (magic < level) return false;
    let covered: Set<string> | undefined;
    if (wornIds.length) {
        const wornNames: string[] = [];
        for (let i = 0; i < wornIds.length; i++) {
            const dn = debugname(wornIds[i]!);
            if (dn) wornNames.push(dn);
        }
        if (wornNames.length) covered = staffRunes(wornNames, staffs);
    }
    const runes: Record<number, number> = {};
    for (const r of t.runes ?? []) runes[r.id] = (runes[r.id] ?? 0) + r.count;
    for (const key in runes) {
        const id = Number(key);
        if (covered?.has(RUNE_NAMES[id] ?? '')) continue;
        if (count(id) < runes[key]!) return false;
    }
    return true;
}
