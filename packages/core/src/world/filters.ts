import type { TransportMeta } from '../../../knowledge/src/transports';
import { questCompleteValue } from '../travel';
import { loadKnowledgeJson, tileKey, type Account, type Door, type DoorBlock, type Leg, type Tile, type Transport } from './model';

/** Returns whether an account satisfies a transport's visible-loc, unlock, skill, and banner guards. */
export function transportAllowed(t: TransportMeta, a: Account): boolean {
    const r = t.requires;
    if (!r) return true;
    if (r.visibleLoc && !a.visibleLocs?.some(l => l.id === r.visibleLoc!.id && tileKey(l) === tileKey(r.visibleLoc!))) return false;
    if (r.unlock && !a.unlocks?.includes(r.unlock)) return false;
    if (r.skill && (a.skills[r.skill.name] ?? -1) < r.skill.level) return false;
    if (r.notOwnBanner) {
        const b = r.notOwnBanner;
        if (a.castlewarsTeam !== undefined && a.castlewarsTeam !== b.team) return true;
        if (!a.worn) return false;
        if (a.worn.includes(b.item)) return false;
    }
    return true;
}

// Only a source-backed identical physical route can supersede a legacy literal.
export function canonicalTransport(t: Transport): Transport | null {
    const c = t.canonical;
    if (!c) return t;
    if (c.option !== t.option || c.exact !== t.exact || tileKey(c.from) !== tileKey(t.from) || tileKey(c.to) !== tileKey(t.to) || !c.interaction || c.id !== c.interaction.id || !c.handler || !c.src) return null;
    if (t.requires && c.requires && JSON.stringify(t.requires) !== JSON.stringify(c.requires)) return null;
    return { ...t, ...c, requires: t.requires ?? c.requires, unplaced: undefined, canonical: undefined };
}

let transportAliases: Transport[] | undefined;

export function canonicalTransportLeg(leg: Extract<Leg, { kind: 'transport' }>, aliases?: Transport[]): Extract<Leg, { kind: 'transport' }> | null {
    const rows = aliases ?? (transportAliases ??= loadKnowledgeJson<Transport[]>('transports.json').filter(t => t.canonical));
    const old = rows.find(t => t.locName === leg.loc && t.option === leg.option && tileKey(t.from) === tileKey(leg.at));
    if (!old) return leg;
    if (tileKey(old.to) !== tileKey(leg.to) || old.exact !== leg.exact) return null;
    const c = canonicalTransport(old);
    if (!c || c.unplaced) return null;
    if (leg.requires && c.requires && JSON.stringify(leg.requires) !== JSON.stringify(c.requires)) return null;
    return { ...leg, loc: c.locName, interaction: c.interaction, requires: leg.requires ?? c.requires, entry: c.entry, landing: c.landing, requireSrc: c.requireSrc };
}

/** Deduplicates canonical transports and drops op1 menu rows when direct options exist at the same loc tile. */
export function normalizeTransports(raw: readonly Transport[]): Transport[] {
    // A stair with direct op2/op3 links (Climb-up / Climb-down) uses op1 for a "which way?" menu
    // (e.g. spiralstairsmiddle op1=Climb). Clicking op1 opens a dialog and never changes floor, so drop it.
    const all = [...new Map(
        raw.map(canonicalTransport)
            .filter((t): t is Transport => t !== null)
            .map(t => [`${t.locName}:${t.option}:${tileKey(t.from)}>${tileKey(t.to)}:${JSON.stringify([t.requires, t.entry, t.landing])}`, t]),
    ).values()];
    const hasDirect = new Set(all.filter(t => t.option !== 'op1').map(t => `${t.locName}@${tileKey(t.from)}`));
    return all.filter(t => !t.unplaced && !(t.option === 'op1' && hasDirect.has(`${t.locName}@${tileKey(t.from)}`)));
}

// Only an observed value meeting a mined threshold admits quest gates. The SDK state has no varps, so a quest that the
// quest list shows complete (unlock complete:<varp>, guild-observation.ts completedQuestUnlocks) stands for its
// complete value while its stage is not observed: a gate whose threshold is at or below that value opens.
const questGateValue = (varp: string, a: Account): number | undefined => {
    const seen = varp === 'qp' ? a.varps.qp : a.questStages?.[varp] ?? a.varps[varp];
    return seen ?? (a.unlocks?.includes(`complete:${varp}`) ? questCompleteValue(varp) : undefined);
};

export function doorBlocks(d: Door, a: Account): boolean {
    switch (d.kind) {
        case 'open': return false;
        case 'skill': return !(d.need?.skill && d.need.level !== undefined && (a.skills[d.need.skill] ?? 1) >= d.need.level && (!d.need.worn || a.worn?.includes(d.need.worn)));
        case 'key': return !(d.need?.item && a.items.includes(d.need.item));
        case 'team': return !(d.need?.team !== undefined && (a.castlewarsTeam === d.need.team || a.doorStates?.[`${d.level},${d.x},${d.z}`] === true));
        case 'quest': return !(d.need?.varp && d.need.minimum !== undefined && (questGateValue(d.need.varp, a) ?? -Infinity) >= d.need.minimum);
        default: return true;
    }
}

let knownDoorFacts: Door[] | null = null;

/** Returns cached static door facts loaded from knowledge/doors.json. */
export function getKnownDoorFacts(): Door[] {
    return knownDoorFacts ??= loadKnowledgeJson<Door[]>('doors.json');
}

export function doorBlock(d: Door): DoorBlock {
    return {
        x: d.x,
        z: d.z,
        level: d.level,
        ...(d.need?.whenAxis !== undefined && Number.isInteger(d.angle) && d.shape === 0 ? { whenAxis: d.need.whenAxis, angle: d.angle } : {}),
    };
}

// Same account policy as the route planner, bounded to the current same-floor leg plus 32 tiles.
// This loader does not initialize the pathfinder or construct the transport graph.
export function blockedDoorsNear(from: Tile, to: Tile, acct: Account, doors?: readonly Door[]): DoorBlock[] {
    if (from.level !== to.level) return [];
    const minX = Math.min(from.x, to.x) - 32, maxX = Math.max(from.x, to.x) + 32;
    const minZ = Math.min(from.z, to.z) - 32, maxZ = Math.max(from.z, to.z) + 32;
    const facts = doors ?? getKnownDoorFacts();
    return facts.filter(d => d.level === from.level && d.x >= minX && d.x <= maxX && d.z >= minZ && d.z <= maxZ && doorBlocks(d, acct))
        .map(doorBlock);
}
