import type { Action, Hunter, PrayerGuardOptions, ThreatAssessment } from './types';

// The Wilderness level of a tile, 0 outside: one level for each 8 tiles north of the south edge of a zone
// (area_wilderness/scripts/wilderness_levels.rs2; zones in area_wilderness/configs/wilderness_zones.dbrow).
export const wildernessLevel = (x: number, z: number): number => x < 2944 || x >= 3392 ? 0
    : z >= 3520 && z < 6400 ? Math.floor((z - 3520) / 8) + 1
    : z >= 9920 && z < 12800 ? Math.floor((z - 9920) / 8) + 1 : 0;

// The farthest NPC the guard treats as a threat before it attacks.
const HUNT_VIEW = 15;

// The state keeps `hp` 0 on an NPC slot after a death, until the next NPC in that slot shows its health. An NPC with
// `hp` 0 is dead only when the state saw damage on it in the last DEAD_TICKS ticks.
const DEAD_TICKS = 10;
export const npcDead = (n: any, st: any): boolean => n?.hp === 0 && n.lastCombatTick != null && (st?.tick ?? 0) - n.lastCombatTick <= DEAD_TICKS;

// True while the target of an attack input is in view and alive.
export const attackTarget = (a: Action, st: any): boolean => {
    if (a.type === 'interactPlayer') return a.optionIndex === 2 && (st?.nearbyPlayers ?? []).some((p: any) => p.index === a.playerIndex);
    if (a.type !== 'interactNpc') return false;
    const n = (st?.nearbyNpcs ?? []).find((n: any) => n.index === a.npcIndex);
    return !!n && !npcDead(n, st) && (n.optionsWithIndex ?? []).some((op: any) => op.opIndex === a.optionIndex && /^Attack$/i.test(op.text));
};

export function rivalPlayer(st: any, p: any, self: unknown, players?: PrayerGuardOptions['players']): { player: any; attacks: boolean } | null {
    const mine = players ? wildernessLevel(p.worldX, p.worldZ) : 0;
    if (mine < 1) return null;
    let best: { player: any; attacks: boolean } | null = null;
    for (const q of st.nearbyPlayers ?? []) {
        if (players!.ignore?.has(String(q.name).toLowerCase())) continue;
        const level = Math.min(mine, wildernessLevel(q.worldX ?? q.x, q.worldZ ?? q.z));
        if (level < 1 || Math.abs(q.combatLevel - p.combatLevel) > level) continue;
        const attacks = q.combatTargetType === 'player' && q.combatTargetIndex === self;
        if (!best || (attacks && !best.attacks) || (attacks === best.attacks && q.distance < best.player.distance)) best = { player: q, attacks };
    }
    return best;
}

export function nearestHunter(st: any, p: any, hunters?: ReadonlyMap<number, Hunter>): any | null {
    if (!hunters) return null;
    const wild = wildernessLevel(p.worldX, p.worldZ) > 0;
    let best: any | null = null, bestReaches = false;
    for (const n of st.nearbyNpcs ?? []) {
        const h = hunters.get(n.id);
        if (!h || npcDead(n, st) || n.distance > Math.min(HUNT_VIEW, h.range + h.wander)) continue;
        if (h.tooStrong && !wild && p.combatLevel > h.level * 2) continue;
        // An NPC whose hunt range reaches the player now comes before one that must walk first: its attack
        // style is the one that lands first.
        const reaches = n.distance <= h.range + 1;
        if (!best || (reaches && !bestReaches) || (reaches === bestReaches && n.distance < best.distance)) { best = n; bestReaches = reaches; }
    }
    return best;
}

export function findAttackerNpc(st: any, me: number | undefined): any | null {
    if (me === undefined) return null;
    return (st.nearbyNpcs ?? []).find((n: any) => n.targetIndex === me && !npcDead(n, st)
        && (n.optionsWithIndex ?? []).some((op: any) => /^Attack$/i.test(op.text))) ?? null;
}

export function autoAttackOf(n: any, st: any, selfSlot: unknown): Action | null {
    const op = n?.optionsWithIndex?.find((op: any) => /^Attack$/i.test(op.text));
    return n && op && !npcDead(n, st) && Number.isSafeInteger(selfSlot) && n.targetIndex === 32768 + (selfSlot as number)
        ? { type: 'interactNpc', npcIndex: n.index, optionIndex: op.opIndex, reason: 'SDK' }
        : null;
}

export function assessThreat(st: any, p: any, self: unknown, o: Pick<PrayerGuardOptions, 'protect' | 'players' | 'hunters'>, hit: boolean): ThreatAssessment {
    if (o.protect === false) return { threatNow: false, rival: null, npc: null };
    const me = Number.isSafeInteger(self) ? 32768 + (self as number) : undefined;
    const rival = rivalPlayer(st, p, self, o.players);
    const attacker = findAttackerNpc(st, me);
    // A player that attacks comes first, then an NPC that attacks, then a player that can attack.
    const npc = rival?.attacks ? null : attacker ?? (rival ? null : nearestHunter(st, p, o.hunters));
    return { threatNow: Boolean(npc || rival || hit), rival, npc };
}

export function damageSourceName(st: any, p: any, selfSlot: unknown): string {
    const by = Number.isSafeInteger(selfSlot)
        ? (st.nearbyNpcs ?? []).find((n: any) => n.targetIndex === 32768 + (selfSlot as number))
        : undefined;
    return by?.name ?? (wildernessLevel(p.worldX, p.worldZ) > 0 ? 'player' : 'unknown');
}
