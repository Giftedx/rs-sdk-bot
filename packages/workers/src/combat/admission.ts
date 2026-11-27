import {
    combatAdmission,
    crowdDanger,
    type CombatAdmission,
    type CombatThreat,
    type HitRecord,
} from '../../../core/src/combat-admission';
import { PLAIN_FOOD } from '../../../core/src/eat-guard';
import { defaultEatAt, questFoodDefinitions } from '../../../core/src/sustain';
import { npcThreat } from '../../../knowledge/src/npc-threat';
import { gearById, meleeDefenceMean } from './gear';
import type { CombatSession } from './types';

// The combat admission of one fight run: the shared survival math of packages/core/src/combat-admission.ts, fed from
// the session. A combat worker calls `entry` before its first walk, `beforeAttack` before each attack, and `tick` on
// each tick of a fight.

// The heal of one piece when the pack holds no food and the bank is not known: a lobster.
const UNKNOWN_HEAL = 12;

// The damage facts of the most dangerous NPC of a target.
export function targetThreat(ids: Iterable<number>): CombatThreat | undefined {
    let worst: CombatThreat | undefined;
    for (const id of ids) {
        const t = npcThreat(id);
        if (t && (!worst || t.maxHit > worst.maxHit || (t.maxHit === worst.maxHit && t.attackRoll > worst.attackRoll))) worst = t;
    }
    return worst;
}

export function wornDefenceBonus(equipment: readonly { id: number }[]): number {
    let sum = 0;
    for (const item of equipment) {
        const g = gearById(item.id);
        if (g) sum += meleeDefenceMean(g.bonuses);
    }
    return sum;
}

const heal = (id: number) => questFoodDefinitions().get(id)?.heal ?? 0;

// The food pieces and the mean heal of the PLAIN_FOOD in `items`.
export function plainFood(items: readonly { id: number; count: number }[]): { pieces: number; heal: number } {
    let pieces = 0, total = 0;
    for (const i of items) {
        if (!PLAIN_FOOD.includes(i.id) || i.count <= 0) continue;
        pieces += i.count;
        total += i.count * heal(i.id);
    }
    return { pieces, heal: pieces > 0 ? total / pieces : 0 };
}

// NPCs that attack the player of `selfSlot` now.
export function attackersOn(npcs: readonly { inCombat?: boolean; targetIndex?: number }[], selfSlot: number | undefined): number {
    if (selfSlot === undefined || !Number.isSafeInteger(selfSlot) || selfSlot < 0) return 0;
    return npcs.filter(n => n.inCombat === true && n.targetIndex === 32768 + selfSlot).length;
}

export const admissionRefusal = (target: string, a: CombatAdmission): string =>
    a.reason.startsWith('no food:') ? `no food: ${target} admission ${a.reason.slice('no food: '.length)}` : `no combat progress: ${target} admission refused: ${a.reason}`;

export type CombatAdmissionGuard = ReturnType<typeof createCombatAdmissionGuard>;

export function createCombatAdmissionGuard(s: CombatSession, target: string, ids: Iterable<number>, opts: { carryMax?: number; log?: (line: string) => void } = {}) {
    const threat = targetThreat(ids);
    const log = opts.log ?? ((line: string) => console.log(line));
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const maxHp = () => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0;
    const selfSlot = () => (s.client as { selfSlot?: number } | undefined)?.selfSlot;
    const onMe = () => attackersOn(s.sdk.getState()?.nearbyNpcs ?? [], selfSlot());
    const hits: HitRecord[] = [];
    let lastHp: number | undefined;
    let leaves = 0;
    const check = (extraAttackers = 0): CombatAdmission | undefined => {
        if (!threat) return undefined;
        const held = plainFood(s.sdk.getInventory());
        const bankItems = s.bankObservation?.()?.items;
        const banked = bankItems ? plainFood(bankItems) : undefined;
        const a = combatAdmission(
            threat,
            {
                hp: hp(),
                maxHp: maxHp(),
                defence: s.sdk.getSkill('Defence')?.level ?? 1,
                defenceBonus: wornDefenceBonus(s.sdk.getState()?.equipment ?? []),
                foodPieces: held.pieces,
                healPerPiece: held.pieces > 0 ? held.heal : banked && banked.pieces > 0 ? banked.heal : UNKNOWN_HEAL,
                ...(banked ? { bankFoodPieces: banked.pieces } : {}),
            },
            { attackers: Math.max(1, onMe() + extraAttackers), ...(opts.carryMax !== undefined ? { carryMax: opts.carryMax } : {}) },
        );
        // The eat guard eats at defaultEatAt (packages/core/src/sustain.ts). An eat level below the retreat line lets one
        // more round of hits kill the account before the guard eats.
        const eatLevel = defaultEatAt(maxHp());
        if (a.verdict !== 'refuse' && eatLevel < a.retreatAt) {
            return { ...a, verdict: 'refuse', reason: `too weak: eat level ${eatLevel} is below the retreat line ${a.retreatAt}` };
        }
        return a;
    };
    return {
        threat,
        check,
        // The food pieces that a bank trip takes: the worker's own count, or more when the admission needs more.
        foodWant(base: number): number {
            const a = check();
            if (!a || base === 0) return base;
            return Math.max(base, Math.min(opts.carryMax ?? 20, a.foodNeeded));
        },
        // The refusal of a run before its first walk: a target that the account cannot survive at any food.
        entry(): string | undefined {
            const a = check();
            if (!a) return undefined;
            log(`COMBAT_ADMISSION ${JSON.stringify({ target, verdict: a.verdict, reason: a.reason, retreatAt: a.retreatAt, foodNeeded: a.foodNeeded, maxHit: threat!.maxHit })}`);
            return a.verdict === 'refuse' && a.reason.startsWith('too weak') ? admissionRefusal(target, a) : undefined;
        },
        // Before an attack: `fight`, `bank` (take food first) or a refusal.
        beforeAttack(justBanked: boolean): { kind: 'fight' } | { kind: 'bank' } | { kind: 'refuse'; detail: string } {
            const a = check(1);
            if (!a || a.verdict === 'admit') return { kind: 'fight' };
            if (a.reason.startsWith('too weak') || justBanked) return { kind: 'refuse', detail: admissionRefusal(target, a) };
            log(`COMBAT_ADMISSION bank ${JSON.stringify({ target, verdict: a.verdict, reason: a.reason, hp: hp() })}`);
            return { kind: 'bank' };
        },
        // One tick of a fight. A reason to leave the fight: Hitpoints at the retreat line with no food, or the crowd rule.
        tick(now: number): string | undefined {
            const h = hp();
            if (lastHp !== undefined && h < lastHp) hits.push({ tick: now, damage: lastHp - h });
            lastHp = h;
            while (hits.length && now - hits[0]!.tick >= 200) hits.shift();
            const a = check();
            if (!a) return undefined;
            const held = plainFood(s.sdk.getInventory());
            if (held.pieces === 0 && h > 0 && h <= a.retreatAt) return `retreat: ${h} Hitpoints at the retreat line ${a.retreatAt} with no food`;
            const danger = crowdDanger(hits, now, { hp: h, retreatAt: a.retreatAt, foodHeal: held.pieces * held.heal, attackers: onMe() });
            return danger.leave ? `crowd: ${danger.reason}` : undefined;
        },
        // A crowd leave ends the run after `max` leaves: the spot stays dangerous.
        left(reason: string, max = 3): string | undefined {
            leaves++;
            hits.length = 0;
            lastHp = undefined;
            log(`COMBAT_DANGER leave ${leaves} ${reason}`);
            return reason.startsWith('crowd') && leaves >= max ? `no combat progress: ${target} danger at the spot: ${reason}` : undefined;
        },
    };
}
