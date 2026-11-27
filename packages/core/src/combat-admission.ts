// Combat admission: the survival check that every combat worker and the brain run before a fight.
//
// The inputs are the damage facts of the target NPC (packages/knowledge/src/npc-threat.ts), the Hitpoints, Defence
// and worn defence bonus of the account, and the food that it holds or can withdraw. The result says whether the
// account can fight (admit), must take more food first (resupply), or must not fight this target (refuse). It also
// gives the retreat line: the Hitpoints at or below which an account with no food leaves the fight. The retreat line
// is one max hit of each attacker plus a margin, so one more round of hits cannot kill the account.

export type CombatThreat = {
    readonly maxHit: number;
    // npc_melee_attack_roll: (attack + 9) * (attackbonus + 64).
    readonly attackRoll: number;
    // Ticks between two attacks of the NPC.
    readonly attackRate: number;
};

export type CombatAccount = {
    readonly hp: number;
    readonly maxHp: number;
    readonly defence: number;
    // The mean of the worn stab, slash and crush defence bonuses. 0 when not known.
    readonly defenceBonus?: number;
    // Food pieces in the pack and the heal of one piece.
    readonly foodPieces: number;
    readonly healPerPiece: number;
    // Food pieces in the bank that the worker can withdraw. Undefined when the bank is not known.
    readonly bankFoodPieces?: number;
};

export type AdmissionOptions = {
    // NPCs that attack the account at the same time.
    readonly attackers?: number;
    // The most food pieces that the worker carries.
    readonly carryMax?: number;
};

export type CombatAdmission = {
    readonly verdict: 'admit' | 'resupply' | 'refuse';
    readonly reason: string;
    readonly retreatAt: number;
    readonly eatAt: number;
    readonly foodNeeded: number;
    readonly hitChance: number;
    readonly damagePerTick: number;
};

// Ticks of continuous fighting that the Hitpoints above the retreat line and the food must cover: 3 minutes.
export const ADMISSION_WINDOW_TICKS = 300;
// The expected damage is multiplied by this factor: the hits of one window vary.
export const ADMISSION_SAFETY = 1.25;
// Max hits that the full Hitpoints of the account must hold above the retreat line. An account with fewer cannot
// eat or walk away in time after a run of high hits.
export const MIN_HITS_ABOVE_RETREAT = 3;
export const DEFAULT_CARRY_MAX = 20;

export const retreatMargin = (maxHit: number): number => Math.max(2, Math.ceil(maxHit / 2));

// The Hitpoints at or below which an account with no food leaves the fight: one max hit of each attacker plus a margin.
export const retreatLine = (maxHit: number, attackers = 1): number => Math.max(1, attackers) * maxHit + retreatMargin(maxHit);

// The chance that one NPC attack hits: the accuracy formula of the server (randominc(attack roll) >
// randominc(defence roll), npc_combat_melee.rs2:27). The player defence roll is (defence + 9) * (bonus + 64).
export function npcHitChance(attackRoll: number, defence: number, defenceBonus = 0): number {
    const a = Math.max(0, attackRoll);
    const d = Math.max(0, (defence + 9) * (defenceBonus + 64));
    return a > d ? 1 - (d + 2) / (2 * (a + 1)) : a / (2 * (d + 1));
}

export function combatAdmission(threat: CombatThreat, acct: CombatAccount, opts: AdmissionOptions = {}): CombatAdmission {
    const attackers = Math.max(1, opts.attackers ?? 1);
    const carryMax = opts.carryMax ?? DEFAULT_CARRY_MAX;
    const maxHit = Math.max(0, threat.maxHit);
    const retreatAt = maxHit > 0 ? retreatLine(maxHit, attackers) : 0;
    const eatAt = maxHit > 0 ? Math.min(Math.max(1, acct.maxHp - 1), retreatAt + maxHit) : 0;
    const hitChance = npcHitChance(threat.attackRoll, acct.defence, acct.defenceBonus ?? 0);
    const damagePerTick = (attackers * hitChance * (maxHit / 2)) / Math.max(1, threat.attackRate);
    const base = { retreatAt, eatAt, hitChance, damagePerTick };
    if (maxHit === 0) return { verdict: 'admit', reason: 'the target cannot damage the account', foodNeeded: 0, ...base };
    const needHp = retreatAt + MIN_HITS_ABOVE_RETREAT * maxHit;
    if (acct.maxHp < needHp) {
        return {
            verdict: 'refuse',
            reason: `too weak: ${acct.maxHp} Hitpoints is below ${needHp} (retreat ${retreatAt} + ${MIN_HITS_ABOVE_RETREAT} max hits of ${maxHit})`,
            foodNeeded: 0,
            ...base,
        };
    }
    const expected = damagePerTick * ADMISSION_WINDOW_TICKS * ADMISSION_SAFETY;
    const spare = Math.max(0, acct.hp - retreatAt);
    const heal = Math.max(1, acct.healPerPiece);
    const cover = spare + acct.foodPieces * heal;
    if (cover >= expected) {
        return { verdict: 'admit', reason: `covers ${Math.round(expected)} expected damage with ${Math.round(cover)}`, foodNeeded: 0, ...base };
    }
    const foodNeeded = Math.ceil((expected - spare) / heal);
    const owned = acct.foodPieces + (acct.bankFoodPieces ?? Number.POSITIVE_INFINITY);
    if (foodNeeded > carryMax || owned < foodNeeded) {
        return {
            verdict: 'refuse',
            reason: `no food: ${Math.round(expected)} expected damage needs ${foodNeeded} food of ${heal} heal and ${acct.foodPieces} held, ${acct.bankFoodPieces ?? '?'} banked`,
            foodNeeded,
            ...base,
        };
    }
    return {
        verdict: acct.foodPieces >= foodNeeded ? 'admit' : 'resupply',
        reason: `needs ${foodNeeded} food of ${heal} heal for ${Math.round(expected)} expected damage`,
        foodNeeded,
        ...base,
    };
}

// The first candidate target that the account may fight, with the refusal of each target before it.
export function pickAdmittedTarget<T>(
    candidates: readonly T[],
    admit: (candidate: T) => CombatAdmission,
): { target?: T; admission?: CombatAdmission; refused: { target: T; reason: string }[] } {
    const refused: { target: T; reason: string }[] = [];
    for (const target of candidates) {
        const admission = admit(target);
        if (admission.verdict !== 'refuse') return { target, admission, refused };
        refused.push({ target, reason: admission.reason });
    }
    return { refused };
}

export type HitRecord = { readonly tick: number; readonly damage: number };

export type CrowdOptions = {
    // The window over which the damage rate is measured: one minute.
    readonly windowTicks?: number;
    // Minutes of the measured damage rate that the Hitpoints above the retreat line and the food must cover.
    readonly coverMinutes?: number;
    // More attackers than this end the fight at this spot.
    readonly maxAttackers?: number;
};

export const CROWD_WINDOW_TICKS = 100;
export const CROWD_COVER_MINUTES = 3;
export const CROWD_MAX_ATTACKERS = 2;

// The crowd and danger rule: leave the spot when the damage of the last minute, kept up for `coverMinutes`, is more
// than the Hitpoints above the retreat line and the food can heal, or when more NPCs attack than `maxAttackers`.
export function crowdDanger(
    hits: readonly HitRecord[],
    now: number,
    state: { readonly hp: number; readonly retreatAt: number; readonly foodHeal: number; readonly attackers: number },
    opts: CrowdOptions = {},
): { leave: boolean; reason: string; damagePerMinute: number } {
    const windowTicks = opts.windowTicks ?? CROWD_WINDOW_TICKS;
    const coverMinutes = opts.coverMinutes ?? CROWD_COVER_MINUTES;
    const maxAttackers = opts.maxAttackers ?? CROWD_MAX_ATTACKERS;
    const recent = hits.filter(h => now - h.tick < windowTicks);
    const damage = recent.reduce((n, h) => n + Math.max(0, h.damage), 0);
    const damagePerMinute = (damage * CROWD_WINDOW_TICKS) / windowTicks;
    if (state.attackers > maxAttackers) {
        return { leave: true, reason: `${state.attackers} attackers is more than ${maxAttackers}`, damagePerMinute };
    }
    const cover = Math.max(0, state.hp - state.retreatAt) + Math.max(0, state.foodHeal);
    if (damagePerMinute * coverMinutes > cover) {
        return { leave: true, reason: `${damagePerMinute} damage a minute for ${coverMinutes} minutes is more than ${cover} cover`, damagePerMinute };
    }
    return { leave: false, reason: '', damagePerMinute };
}
