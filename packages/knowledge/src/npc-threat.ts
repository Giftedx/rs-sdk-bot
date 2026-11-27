import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, parseConfigs } from './config';
import { parsePack } from './pack';
import { contentRoot } from './paths';
import { cachedRows } from './table-cache';

// The damage facts of each NPC that can attack, read from the pinned content.
//
// Melee max hit: npc_melee_maxhit (skill_combat/scripts/npc/npc_combat_melee.rs2:2-8) is
// floor(((strength + 9) * (strengthbonus + 64) + 320) / 640) (combat.rs2 combat_maxhit, combat_stat).
// Ranged max hit: npc_ranged_maxhit (npc_combat_ranged.rs2:7-13), the same formula with ranged and rangebonus.
// Magic max hit: the forced max hit of npc_cast_spell_with_forced_max_hit (npc_combat_magic.rs2:17-35), else the
// maxhit of the spell row (skill_combat/configs/magic/magic_combat_spells.dbrow), for each spell that the attack
// script of the NPC casts. The reader looks at the attack script and the procedures and labels that it calls, one
// call deep.
// Attack roll: npc_melee_attack_roll (npc_combat_melee.rs2:12-17) is (attack + 9) * (attackbonus + 64).
// Attack rate: param attackrate, default 4 (skill_combat/configs/combat.param).
export type NpcThreat = {
    readonly id: number;
    readonly maxHit: number;
    readonly meleeMaxHit: number;
    readonly rangedMaxHit: number;
    readonly magicMaxHit: number;
    readonly attackRoll: number;
    readonly attackRate: number;
    readonly hitpoints: number;
    readonly aggressive: boolean;
};

export const npcMaxHitFormula = (stat: number, bonus: number): number => Math.floor(((stat + 9) * (bonus + 64) + 320) / 640);

let cached: ReadonlyMap<number, NpcThreat> | undefined;

export function npcThreats(): ReadonlyMap<number, NpcThreat> {
    return cached ??= new Map(cachedRows('npc-threat', 1, () => [...buildNpcThreats()]));
}

export function npcThreat(id: number): NpcThreat | undefined {
    return npcThreats().get(id);
}

const num = (v: string | undefined, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
};

function spellMaxHits(): Map<string, number> {
    const out = new Map<string, number>();
    for (const file of listConfigFiles('.dbrow')) {
        for (const block of parseConfigs(readFileSync(join(contentRoot(), file), 'utf8'), file)) {
            if (block.props.table?.[0] !== 'magic_spell_table') continue;
            let spell: string | undefined, max: number | undefined;
            for (const d of block.props.data ?? []) {
                const [key, value] = d.split(',', 2);
                if (key === 'spell' && value) spell = value.replace(/^\^/, '');
                if (key === 'maxhit') max = num(value, 0);
            }
            if (spell && max !== undefined) out.set(spell, max);
        }
    }
    return out;
}

export function buildNpcThreats(): Map<number, NpcThreat> {
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
    const spells = spellMaxHits();
    const magicMax = (bodies: readonly string[]): number => {
        let max = 0;
        const read = (body: string) => {
            for (const m of body.matchAll(/npc_cast_spell_with_forced_max_hit\(\^(\w+),\s*\d+,\s*(\d+)\)/g)) max = Math.max(max, num(m[2], 0));
            for (const m of body.matchAll(/npc_cast_spell\(\^(\w+)/g)) max = Math.max(max, spells.get(m[1]!) ?? 0);
        };
        for (const body of bodies) {
            read(body);
            for (const m of body.matchAll(/(?:~|@|gosub\(|jump\()\.?([a-z0-9_]+)/g)) {
                const next = procedures.get(m[1]!);
                if (next !== undefined && !/^npc_(cast|spell)/.test(m[1]!)) read(next);
            }
        }
        return max;
    };
    const ids = new Map([...parsePack(readFileSync(join(root, 'pack/npc.pack'), 'utf8'))].map(([id, name]) => [name, id] as const));
    const out = new Map<number, NpcThreat>();
    const categoryOf = new Map<number, string>();
    const nameOf = new Map<number, string>();
    for (const file of listConfigFiles('.npc')) {
        for (const block of parseConfigs(readFileSync(join(root, file), 'utf8'), file)) {
            const id = ids.get(block.name);
            if (id === undefined) continue;
            const p = block.props;
            const params = new Map<string, string>();
            for (const line of p.param ?? []) {
                const comma = line.indexOf(',');
                if (comma > 0) params.set(line.slice(0, comma), line.slice(comma + 1));
            }
            const strength = num(p.strength?.[0], 1), ranged = num(p.ranged?.[0], 1), attack = num(p.attack?.[0], 1);
            const meleeMaxHit = npcMaxHitFormula(strength, num(params.get('strengthbonus'), 0));
            const rangedMaxHit = params.has('rangebonus') || p.ranged ? npcMaxHitFormula(ranged, num(params.get('rangebonus'), 0)) : 0;
            out.set(id, {
                id,
                maxHit: meleeMaxHit,
                meleeMaxHit,
                rangedMaxHit,
                magicMaxHit: 0,
                attackRoll: (attack + 9) * (num(params.get('attackbonus'), 0) + 64),
                attackRate: num(params.get('attackrate'), 4),
                hitpoints: num(p.hitpoints?.[0], 1),
                aggressive: /^aggressive/.test(p.huntmode?.[0] ?? ''),
            });
            const category = p.category?.[0];
            if (category) categoryOf.set(id, category);
            nameOf.set(id, block.name);
        }
    }
    // A script for one NPC replaces the script of its category.
    for (const [id, threat] of out) {
        const bodies = attacks.get(nameOf.get(id)!) ?? (categoryOf.has(id) ? attacks.get(`_${categoryOf.get(id)}`) : undefined);
        // No attack script of its own: the default script (skill_combat/scripts/npc/npc_combat.rs2:4) is melee.
        if (!bodies) {
            out.set(id, { ...threat, rangedMaxHit: 0 });
            continue;
        }
        const magicMaxHit = magicMax(bodies);
        const usesRanged = bodies.some(b => /npc_rangeattack|npc_ranged_/.test(b));
        const rangedMaxHit = usesRanged ? threat.rangedMaxHit : 0;
        const usesMelee = bodies.some(b => /npc_meleeattack|npc_default_attack|npc_melee_/.test(b)) || (magicMaxHit === 0 && rangedMaxHit === 0);
        const meleeMaxHit = usesMelee ? threat.meleeMaxHit : 0;
        out.set(id, { ...threat, meleeMaxHit, rangedMaxHit, magicMaxHit, maxHit: Math.max(meleeMaxHit, rangedMaxHit, magicMaxHit) });
    }
    return out;
}
