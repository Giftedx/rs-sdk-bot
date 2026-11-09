// Opponent sensor: overhead prayer, skull, worn items and last seen HP of other players in view.
//
// The vendored state collector publishes name, combat level and tile only (StateCollector.collectNearbyPlayers).
// The lite client already decodes the rest into each ClientPlayer, so this reads it from the client without a
// vendor change:
// - headicons: one bit per icon (content player/configs/headicon.constant, set by appearance.rs2 headicon_add).
// - appearance[slot]: 0x200 + obj id when an item is worn in that wear position (engine Player.generateAppearance).
// - health / totalHealth: real HP from the last hitmark seen; combatCycle is that cycle + 400 (lite entities.ts).

export type CombatStyle = 'melee' | 'ranged' | 'magic';

const HEADICON_SKULL = 0;
const PROTECT_BITS: readonly [number, CombatStyle][] = [[3, 'melee'], [4, 'ranged'], [5, 'magic']];

// Wear positions 0-11 (content player/configs/equip.constant). Rings and ammo are not in the appearance block.
const WEAR_SLOTS = ['hat', 'back', 'front', 'rhand', 'torso', 'lhand', 'arms', 'legs', 'head', 'hands', 'feet', 'jaw'] as const;
export type WearSlot = typeof WEAR_SLOTS[number];

export interface OpponentView {
    index: number;
    name: string;
    combatLevel: number;
    protect: CombatStyle[];
    skulled: boolean;
    worn: Partial<Record<WearSlot, number>>;
    // null until a hitmark on this player has been seen.
    hp: { current: number; max: number; fresh: boolean } | null;
}

export function decodeHeadicons(bits: number): { protect: CombatStyle[]; skulled: boolean } {
    return {
        protect: PROTECT_BITS.filter(([bit]) => (bits & (1 << bit)) !== 0).map(([, style]) => style),
        skulled: (bits & (1 << HEADICON_SKULL)) !== 0,
    };
}

export function decodeWorn(appearance: ArrayLike<number>): Partial<Record<WearSlot, number>> {
    const worn: Partial<Record<WearSlot, number>> = {};
    for (let slot = 0; slot < WEAR_SLOTS.length && slot < appearance.length; slot++) {
        const value = appearance[slot];
        if (value >= 0x200 && value !== 0xffff) worn[WEAR_SLOTS[slot]] = value - 0x200;
    }
    return worn;
}

type ClientPlayerLike = {
    name?: string | null; combatLevel?: number; headicons?: number; appearance?: ArrayLike<number>;
    health?: number; totalHealth?: number; combatCycle?: number;
};

export function readOpponents(client: unknown): OpponentView[] {
    const c = client as {
        localPlayer?: unknown; players?: (ClientPlayerLike | null)[]; playerIds?: ArrayLike<number>;
        playerCount?: number; getClientCycle?: () => number;
    } | null | undefined;
    if (!c?.localPlayer || !c.players || !c.playerIds) return [];
    const cycle = typeof c.getClientCycle === 'function' ? c.getClientCycle() : 0;
    const out: OpponentView[] = [];
    for (let i = 0; i < (c.playerCount ?? 0); i++) {
        const index = c.playerIds[i];
        const p = c.players[index];
        if (!p || p === c.localPlayer || !p.name) continue;
        const max = p.totalHealth ?? 0;
        out.push({
            index,
            name: p.name,
            combatLevel: p.combatLevel ?? 0,
            ...decodeHeadicons(p.headicons ?? 0),
            worn: decodeWorn(p.appearance ?? []),
            hp: max > 0 ? { current: p.health ?? 0, max, fresh: (p.combatCycle ?? -1000) > cycle } : null,
        });
    }
    return out;
}

export function readOpponent(client: unknown, name: string): OpponentView | null {
    const key = name.toLowerCase();
    return readOpponents(client).find(o => o.name.toLowerCase() === key) ?? null;
}

// The styles this attacker can use that the opponent is not praying against, in the attacker's order.
export function openStyles(opponent: Pick<OpponentView, 'protect'>, available: readonly CombatStyle[]): CombatStyle[] {
    return available.filter(style => !opponent.protect.includes(style));
}
