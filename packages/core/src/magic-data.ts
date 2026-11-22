import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentRoot, knowledgeDir } from '../../knowledge/src/paths';
import type { NearbyNpc } from '../../../vendor/rs-sdk/sdk/types';
import { objId } from './content-facts';

export interface NpcSpell {
    name: string;
    component: string;
    level: number;
    runes: Record<number, number>;
    debuff: boolean;
    members: boolean;
    requiredWorn?: number;
}

export interface NativeTeleport {
    name: string;
    component: string;
    level: number;
    members: boolean;
    runes: Record<number, number>;
    to: { x: number; z: number; level: number };
}

function blocks(text: string) {
    return [...text.matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)].map((m) => ({ name: m[1]!, body: m[2]! }));
}

export function nativeNpcSpell(name: string): NpcSpell {
    if (
        !/^(?:(?:wind|water|earth|fire)_(?:strike|bolt|blast|wave)|confuse|weaken|curse|vulnerability|enfeeble|stun|bind|snare|entangle|crumble_undead|saradomin_strike|claws_of_guthix|flames_of_zamorak|iban_blast)$/.test(
            name,
        )
    ) {
        throw Error('unsupported standard NPC spell');
    }
    const text = readFileSync(join(contentRoot(), 'scripts', 'skill_combat', 'configs', 'magic', 'magic_combat_spells.dbrow'), 'utf8');
    const body = text.split('[magic_spell_' + name + ']')[1]?.split('\n[')[0];
    if (!body) throw Error('native NPC spell missing');
    const field = (key: string) => body.match(new RegExp('^data=' + key + ',(.+)$', 'm'))?.[1]?.trim();
    const runes = field('runesrequired')!.split(',');
    const costs: Record<number, number> = {};
    for (let i = 0; i < runes.length; i += 2) {
        if (runes[i] !== 'null') costs[objId(runes[i]!)] = Number(runes[i + 1]);
    }
    const worn = field('wornrequired');
    return {
        name,
        component: field('spellcom')!,
        level: Number(field('levelrequired')),
        runes: costs,
        debuff: /stat_change|freeze_time/.test(body),
        members: field('members') === 'true',
        ...(worn && worn !== 'null' ? { requiredWorn: objId(worn) } : {}),
    };
}

export function selectMagicTarget(
    npcs: readonly NearbyNpc[],
    id: number,
    avoid: ReadonlySet<number>,
    own: number,
    ownedPassiveTarget?: (target: NearbyNpc) => boolean,
) {
    return npcs
        .filter(
            (n) =>
                n.id === id &&
                !avoid.has(n.index) &&
                (n.hp === null || n.hp > 0) &&
                n.reachable !== false &&
                (!n.inCombat || n.targetIndex === 32768 + own || (n.targetIndex === -1 && ownedPassiveTarget?.(n) === true)) &&
                n.optionsWithIndex.some((o) => /^attack$/i.test(o.text)),
        )
        .sort((a, b) => a.distance - b.distance)[0];
}

export function npcCastEffect(
    costs: Record<number, number>,
    before: Record<number, number>,
    after: Record<number, number>,
    xp0: number,
    xp1: number,
    environment: Readonly<Record<number, number>> = {},
) {
    if (
        Object.entries(environment).some(
            ([id, n]) => !Number.isSafeInteger(+id) || +id < 0 || !Number.isSafeInteger(n) || (n !== 0 && Object.hasOwn(costs, id)),
        )
    ) {
        return 'invalid';
    }
    const keys = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(costs), ...Object.keys(environment)]);
    if (
        [...keys].every((k) => (before[Number(k)] ?? 0) === (after[Number(k)] ?? 0) - (environment[Number(k)] ?? 0)) &&
        xp0 === xp1
    ) {
        return 'none';
    }
    return xp1 > xp0 &&
        [...keys].every(
            (k) => (before[Number(k)] ?? 0) - (after[Number(k)] ?? 0) === (costs[Number(k)] ?? 0) - (environment[Number(k)] ?? 0),
        )
        ? 'cast'
        : 'invalid';
}

export function nativeTeleport(name: string): NativeTeleport {
    if (!/^(varrock|lumbridge|falador|camelot|ardougne|watchtower|trollheim)$/.test(name)) {
        throw Error('unsupported native teleport');
    }
    const text = readFileSync(join(contentRoot(), 'scripts', 'skill_magic', 'configs', 'magic_spells.dbrow'), 'utf8');
    const body = text.split('[magic_spell_teleport_' + name + ']')[1]?.split('\n[')[0];
    if (!body) throw Error('native teleport missing');
    const field = (key: string) => body.match(new RegExp('^data=' + key + ',(.+)$', 'm'))?.[1]?.trim();
    const parts = field('runesrequired')!.split(',');
    const runes: Record<number, number> = {};
    for (let i = 0; i < parts.length; i += 2) {
        if (parts[i] !== 'null') runes[objId(parts[i]!)] = Number(parts[i + 1]);
    }
    const [level, mx, mz, lx, lz] = field('tele_coord')!.split('_').map(Number);
    return {
        name,
        component: 'magic:' + name + '_teleport',
        level: Number(field('levelrequired')),
        members: field('members') === 'true',
        runes,
        to: { x: mx! * 64 + lx!, z: mz! * 64 + lz!, level: level! },
    };
}

export function teleportReceipt(
    t: NativeTeleport,
    costs: Record<number, number>,
    b: Record<number, number>,
    a: Record<number, number>,
    xp0: number,
    xp1: number,
    p: { worldX: number; worldZ: number; level: number } | null | undefined,
) {
    const keys = new Set([...Object.keys(b), ...Object.keys(a), ...Object.keys(costs)]);
    return (
        xp1 > xp0 &&
        [...keys].every((k) => (b[Number(k)] ?? 0) - (a[Number(k)] ?? 0) === (costs[Number(k)] ?? 0)) &&
        !!p &&
        p.level === t.to.level &&
        Math.max(Math.abs(p.worldX - t.to.x), Math.abs(p.worldZ - t.to.z)) <= 2
    );
}

let staffRunes: Map<number, { runes: Set<number>; members: boolean }> | undefined;

function nativeStaffRunes() {
    if (staffRunes) return staffRunes;
    staffRunes = new Map();
    const scriptsDir = join(contentRoot(), 'scripts');
    const definitions = new Map<string, string>();
    for (const file of ['staves.obj', 'battlestaves.obj', 'mysticstaves.obj']) {
        for (const row of blocks(readFileSync(join(scriptsDir, 'skill_combat', 'configs', 'magic', file), 'utf8'))) {
            definitions.set(row.name, row.body);
        }
    }
    for (const row of blocks(readFileSync(join(scriptsDir, 'skill_magic', 'configs', 'magic_staff.dbrow'), 'utf8'))) {
        const rune = row.body.match(/^data=rune,(\w+)/m)?.[1];
        if (!rune) continue;
        for (const match of row.body.matchAll(/^data=staff,(\w+)/gm)) {
            const name = match[1]!;
            const body = definitions.get(name);
            if (!body) throw Error('missing native staff object ' + name);
            const id = objId(name);
            const entry = staffRunes.get(id) ?? { runes: new Set<number>(), members: /^members=yes\s*$/m.test(body) };
            entry.runes.add(objId(rune));
            staffRunes.set(id, entry);
        }
    }
    return staffRunes;
}

export function elementalRuneCost(runeId: number, quantity: number, worn: readonly { id: number; slot: number }[], members = false) {
    const id = worn.find((i) => i.slot === 3)?.id;
    const staff = id === undefined ? undefined : nativeStaffRunes().get(id);
    return staff && (!staff.members || members) && staff.runes.has(runeId) ? 0 : quantity;
}

export function magicKnowledgeDir() {
    return knowledgeDir();
}
