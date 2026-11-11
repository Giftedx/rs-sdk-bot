import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, parseConfigs } from './config';
import { parsePack } from './pack';
import { contentRoot } from './paths';

// The attack styles of each NPC that does not only use melee, read from the attack scripts of the pinned content.
//
// An NPC attacks through [ai_opplayer2,<npc>] or [ai_applayer2,<npc>]; a subject `_name` is an NPC category. The
// default script ([ai_opplayer2,_], skill_combat/scripts/npc/npc_combat.rs2:4) is melee. A script is ranged when it
// calls the ranged procedures of npc_combat_ranged.rs2, and magic when it calls the spell procedures of
// npc_combat_magic.rs2. The reader follows the script's own procedures and labels, three calls deep.
//
// The result names the styles a script can use, not the one it uses on a given tick. `magic` includes dragon breath.
export type AttackStyle = 'melee' | 'ranged' | 'magic';

const MAGIC = /npc_cast_spell|npc_spell_cast|playerhit_n_magic|npc_magic_attack_roll|npc_combat_spell/;
const RANGED = /npc_rangeattack|playerhit_n_ranged|npc_ranged_attack_roll|npc_ranged_maxhit/;
const MELEE = /npc_meleeattack|playerhit_n_melee|npc_default_attack|npc_melee_/;
// Shared combat procedures: their names give the style, so the reader does not follow them.
const SHARED = /^(npc_cast|npc_spell|npc_range|npc_melee|npc_default|playerhit|npc_magic|npc_ranged|npc_combat|npc_projectile)/;

let cached: ReadonlyMap<number, readonly AttackStyle[]> | undefined;

export function npcAttackStyles(): ReadonlyMap<number, readonly AttackStyle[]> {
    if (cached) return cached;
    const root = contentRoot();
    const attacks = new Map<string, string[]>();
    const procedures = new Map<string, string>();
    for (const file of listConfigFiles('.rs2')) {
        const parts = readFileSync(join(root, file), 'utf8').split(/^\[([a-z0-9_]+),([^\]]+)\]/m);
        for (let i = 1; i < parts.length; i += 3) {
            const trigger = parts[i]!, subject = parts[i + 1]!, body = parts[i + 2]!;
            if (trigger === 'proc' || trigger === 'label') procedures.set(subject, body);
            else if (trigger === 'ai_opplayer2' || trigger === 'ai_applayer2') attacks.set(subject, [...(attacks.get(subject) ?? []), body]);
        }
    }
    const styles = (body: string, depth: number, seen: Set<string>, out: Set<AttackStyle>) => {
        if (MAGIC.test(body)) out.add('magic');
        if (RANGED.test(body)) out.add('ranged');
        if (MELEE.test(body)) out.add('melee');
        if (depth >= 3) return;
        for (const m of body.matchAll(/(?:~|@|gosub\(|jump\()\.?([a-z0-9_]+)/g)) {
            const name = m[1]!, next = procedures.get(name);
            if (next === undefined || seen.has(name) || SHARED.test(name)) continue;
            seen.add(name);
            styles(next, depth + 1, seen, out);
        }
    };
    const ids = new Map([...parsePack(readFileSync(join(root, 'pack/npc.pack'), 'utf8'))].map(([id, name]) => [name, id] as const));
    const categories = new Map<string, number[]>();
    for (const file of listConfigFiles('.npc')) {
        for (const block of parseConfigs(readFileSync(join(root, file), 'utf8'), file)) {
            const id = ids.get(block.name), category = block.props.category?.[0];
            if (id !== undefined && category) categories.set(category, [...(categories.get(category) ?? []), id]);
        }
    }
    const out = new Map<number, AttackStyle[]>();
    const order: AttackStyle[] = ['melee', 'ranged', 'magic'];
    // A script for one NPC replaces the script of its category, so the named NPCs are set last.
    for (const named of [false, true]) {
        for (const [subject, bodies] of attacks) {
            if (subject === '_' || subject.startsWith('_') === named) continue;
            const found = new Set<AttackStyle>();
            for (const body of bodies) styles(body, 0, new Set(), found);
            const npcs = named ? [ids.get(subject)].filter((id): id is number => id !== undefined) : categories.get(subject.slice(1)) ?? [];
            for (const id of npcs) {
                if (found.has('ranged') || found.has('magic')) out.set(id, order.filter(s => found.has(s)));
                else out.delete(id);
            }
        }
    }
    cached = out;
    return out;
}
