// Hunter aggression rules, Protect from Melee exceptions, and live NPC dodge squares.
import type { Account } from '../world-types';
import { npcAttackStyles } from '../../../knowledge/src/npc-attack-styles';
import { HUNTS_ALL, combatLevel, loadHunters, type Hunter } from './catalog';

export const hunts = (h: Hunter, combat: number) => (h.tooStrong === undefined ? HUNTS_ALL.has(h.mode) : !h.tooStrong) || combat <= 2 * h.combat;
// A hunter is a danger when it hunts the account and is strong enough to kill it: its combat level is above
// the account's combat level and at least 1.5 times the account's hitpoints. Rats and muggers stay walkable.
export const deadly = (h: Hunter, combat: number, hitpoints: number) => hunts(h, combat) && h.combat > combat && h.combat >= 1.5 * hitpoints;
// Protect from Melee (Prayer 43, vendor/rs-sdk/sdk/types.ts PRAYER_LEVELS) sets an NPC's melee damage to 0
// (skill_combat/scripts/npc/npc_combat_melee.rs2:44-46). Every bot session runs the prayer guard (bot.ts; PRAYER_GUARD=0
// turns it off), which turns protection on when a hunter can reach the player and flicks it free of point cost
// (prayer-guard.ts). So a hunter that attacks with melee only (no row in npc-attack-styles, or a melee-only row) is
// not deadly to an account with Prayer 43 or more. The guard needs prayer points above 0; the base level stands for them.
export const PROTECT_MELEE_LEVEL = 43;
export const meleeOnly = (h: Hunter, styles: ReadonlyMap<number, readonly string[]> = npcAttackStyles()) => {
    if (h.id === undefined) return false;
    const s = styles.get(h.id);
    if (!s) return true;
    for (let i = 0; i < s.length; i++) if (s[i] !== 'melee') return false;
    return true;
};
const guardProtects = () => process.env.PRAYER_GUARD !== '0';
export const deadlyTo = (h: Hunter, skills: Record<string, number>, styles?: ReadonlyMap<number, readonly string[]>) =>
    deadly(h, combatLevel(skills), skills.hitpoints ?? 10) && !((skills.prayer ?? 1) >= PROTECT_MELEE_LEVEL && guardProtects() && meleeOnly(h, styles));

export function isDeadlyWithCombat(
    h: Hunter,
    combat: number,
    hitpoints: number,
    prayerProtected: boolean,
    styles: ReadonlyMap<number, readonly string[]>,
): boolean {
    return deadly(h, combat, hitpoints) && !(prayerProtected && meleeOnly(h, styles));
}

// Visible monsters that hunt this account, deadly or not, each with the square a walk keeps out of: its huntrange
// from the tile it stands on now, plus its size and `margin` tiles. A Karamja scorpion (combat 14, huntrange 2) is
// not deadly to an HP 10 account, yet a run past 2 tiles from it took 2 damage (pvp:stage-kit seed 6).
// `meleeProtected` (see protectedFromMelee, read from the live state at each call): Protect from Melee is on and has
// points, so a melee-only hunter does 0 damage and gets no square. A dodge of the bats in the one corridor of the Grand
// Tree roots held a Prayer 99 account for 540 ticks (bench case extra:grandtree-roots).
// Protect from Melee (prayer index 14) is active in this state and the player has prayer points to drain.
export const protectedFromMelee = (state: { prayers?: { activePrayers?: readonly boolean[]; prayerPoints?: number } } | null | undefined): boolean =>
    state?.prayers?.activePrayers?.[14] === true && (state.prayers.prayerPoints ?? 0) > 0;
export type LiveHunter = { x: number; z: number; r: number; name: string };
type SeenNpc = { id: number; name: string; x: number; z: number; tileX?: number; tileZ?: number; size?: number; hp?: number | null };
let huntersById: Map<number, Hunter> | undefined;
export function liveHunters(npcs: readonly SeenNpc[], acct: Pick<Account, 'skills'>, margin = 2, list?: Hunter[], styles?: ReadonlyMap<number, readonly string[]>, meleeProtected = false): LiveHunter[] {
    const byId = list ? new Map(list.flatMap(h => h.id === undefined ? [] : [[h.id, h] as const])) : (huntersById ??= new Map(loadHunters().flatMap(h => h.id === undefined ? [] : [[h.id, h] as const])));
    const combat = combatLevel(acct.skills), out: LiveHunter[] = [];
    for (const n of npcs) {
        const h = byId.get(n.id);
        if (!h || n.hp === 0 || !hunts(h, combat) || (meleeProtected && meleeOnly(h, styles))) continue;
        out.push({ x: n.tileX ?? n.x, z: n.tileZ ?? n.z, r: (h.hunt ?? 0) + margin + Math.max(0, (n.size ?? 1) - 1), name: n.name });
    }
    return out;
}
