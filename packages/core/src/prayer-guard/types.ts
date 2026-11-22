export interface GuardSession {
    sdk: { getState(): any };
    tick(): number;
    onTick(cb: () => void): () => void;
    direct(action: { type: string; [k: string]: unknown }): Promise<unknown>;
    client?: unknown;
    ended?: Promise<unknown>;
}

export type AttackStyle = 'melee' | 'ranged' | 'magic';

// One NPC that attacks first (packages/knowledge/src/npc-hunters.ts).
export interface Hunter { range: number; wander: number; level: number; tooStrong: boolean }

export interface PrayerGuardOptions {
    // The NPCs that attack first. With a table, the guard turns protection on when such an NPC can reach the player:
    // the player is within the NPC's hunt range plus its wander range, and the NPC's too-strong rule does not
    // exclude the player's combat level. Without a table, the guard waits for an NPC that targets the player.
    hunters?: ReadonlyMap<number, Hunter>;
    // Players in the Wilderness. With this value, a player in view is a threat when the level rule lets that player
    // attack: the combat level difference is not above the lower Wilderness level of the two tiles
    // (skill_combat/scripts/pvp/pvp_combat.rs2:32, pvp_level_check). The guard then also turns Protect Item on.
    // `ignore`: account names in lower case that are never a threat. `style`: the attack style of one player, null
    // when it is not known; the guard then uses melee for a player on the next tile and magic for a farther one.
    players?: { ignore?: ReadonlySet<string>; style?: (player: any) => AttackStyle | null };
    // false: never turn a protection prayer on; only keep the script's prayers free.
    // A function: the protection prayer for one attacking NPC (null when only a hit was seen). Default: melee.
    protect?: false | ((npc: any | null) => number | null);
    // true: while the script attacks an NPC with a melee weapon, turn the strongest Strength and Attack prayers on.
    // `melee` says if the worn weapon is a melee weapon; without it each weapon counts as melee.
    offence?: boolean;
    melee?: (state: any) => boolean;
    // Ticks between two flicks. 3 leaves one tick of delay before the 5-tick timer can fire.
    every?: number;
    // Ticks without a threat before the guard turns its own protection prayer off.
    calmTicks?: number;
    // Receives one PRAYER_GUARD line with the counts and the prayer points when the guard stops.
    log?: (line: string) => void;
    // Receives one line for each prayer input the guard sends (the tick, the prayer and the reason), for each hit the
    // player dealt or took, for each change of the Attack and Strength levels and for each new game message.
    trace?: (line: string) => void;
}

export interface PrayerGuardStats {
    // Flicks in all, and those sent right before a script input.
    flicks: number; early: number;
    // Ticks with a prayer on and no flick possible, in all and for each cause: `window`, `five` (five prayers or
    // more) or the type of the script input whose action runs.
    holds: number; holdsBy: Record<string, number>;
    // Damage the player took, for each source and the protection prayer that was on: `<NPC name or player>/<prayer
    // index or none>`. The source is the NPC that had the player as its target on the tick of the hit.
    takenFrom: Record<string, number>;
    protects: number; repairs: number; resends: number;
    // Prayer points the state showed going down.
    spent: number;
    manual: boolean; yielded: boolean;
}

export type Action = { type: string; [k: string]: unknown };
export type Pending = { kind: 'none' } | { kind: 'attack'; action: Action } | { kind: 'other'; type: string; still: number; need: number; item?: number; had?: number };

export interface PrayerIntent {
    on: boolean;
    at: number;
}

export interface ThreatAssessment {
    threatNow: boolean;
    rival: { player: any; attacks: boolean } | null;
    npc: any | null;
}
