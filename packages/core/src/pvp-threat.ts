// The threat model of a squad in the Wilderness: one record for each player that is not ours, its class, and the rules
// that decide what the squad does about it. Pure: the live reading of the client is scripts/pk-threat.ts, and the rule
// of who can attack whom (`canAttack`) is passed in (scripts/pk-roam.ts, pvp_combat.rs2:35-43).
import type { CombatStyle } from './opponent';

export type ThreatStyle = CombatStyle | 'hybrid' | 'unknown';
type Tile = { x: number; z: number };

// A player in view or on the world feed. The worn ids are empty for a player on the feed only (not in view).
export interface Sighting {
    name: string; combat: number; x: number; z: number;
    inView: boolean;
    worn?: { weapon?: number; torso?: number; legs?: number; back?: number; hat?: number };
    // The animation and the graphic on the player this tick (-1 for none), and the overhead prayer it shows.
    anim?: number; spot?: number; protect?: CombatStyle[]; skulled?: boolean;
    // The member of ours that this player is fighting now, from the client's combat target, or null.
    targeting?: string | null;
}
export interface Member { name: string; x: number; z: number; combat: number }

export interface ThreatRecord {
    name: string; combat: number; tick: number; x: number; z: number; wild: number; multi: boolean; inView: boolean;
    worn: NonNullable<Sighting['worn']>;
    protect: CombatStyle[]; skulled: boolean;
    nearest: { member: string; dist: number };
    // The nearest member got closer since the last look, in tiles per tick (negative: it moves away).
    closing: boolean; speed: number;
    // The styles that this player attacked with in the last `memory` ticks, and the last attack.
    styles: CombatStyle[]; lastAttack: { style: CombatStyle; tick: number } | null;
    weaponStyle: CombatStyle;
    targeting: string | null;
}

export interface BookOptions {
    friends: ReadonlySet<string>;
    weaponStyle: (id: number | undefined) => CombatStyle;
    // The style of an attack animation or graphic, or null when it is not an attack.
    attackStyle: (anim: number, spot: number) => CombatStyle | null;
    multiAt: (x: number, z: number) => boolean;
    wildAt: (x: number, z: number) => number;
    // Ticks that a seen attack style counts for (default 50).
    memory?: number;
}

const cheb = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

// The memory of the radar: where each player was and which attack styles it showed.
export class ThreatBook {
    private seen = new Map<string, { x: number; z: number; tick: number; dist: number; styles: Map<CombatStyle, number>; last: { style: CombatStyle; tick: number } | null }>();
    constructor(private o: BookOptions) {}
    private get memory() { return this.o.memory ?? 50; }

    observe(tick: number, members: readonly Member[], sightings: readonly Sighting[]): ThreatRecord[] {
        const out: ThreatRecord[] = [];
        const ours = new Set(members.map(m => m.name.toLowerCase()));
        for (const s of sightings) {
            const key = s.name.toLowerCase();
            if (ours.has(key) || this.o.friends.has(key) || !members.length) continue;
            const old = this.seen.get(key) ?? { x: s.x, z: s.z, tick, dist: Infinity, styles: new Map<CombatStyle, number>(), last: null };
            const near = members.map(m => ({ member: m.name, dist: cheb(m, s) })).sort((a, b) => a.dist - b.dist)[0]!;
            const dt = tick - old.tick;
            const speed = dt > 0 && Number.isFinite(old.dist) ? (old.dist - near.dist) / dt : 0;
            const style = s.anim !== undefined && s.anim >= 0 ? this.o.attackStyle(s.anim, s.spot ?? -1) : null;
            if (style) { old.styles.set(style, tick); old.last = { style, tick }; }
            for (const [st, at] of old.styles) if (tick - at > this.memory) old.styles.delete(st);
            if (old.last && tick - old.last.tick > this.memory) old.last = null;
            old.x = s.x; old.z = s.z; old.tick = tick; old.dist = near.dist;
            this.seen.set(key, old);
            out.push({
                name: s.name, combat: s.combat, tick, x: s.x, z: s.z, wild: this.o.wildAt(s.x, s.z), multi: this.o.multiAt(s.x, s.z), inView: s.inView,
                worn: s.worn ?? {}, protect: s.protect ?? [], skulled: s.skulled ?? false, nearest: near, closing: speed > 0, speed,
                styles: [...old.styles.keys()], lastAttack: old.last, weaponStyle: this.o.weaponStyle(s.worn?.weapon), targeting: s.targeting ?? null,
            });
        }
        // A player that is not seen for a while is forgotten.
        for (const [key, v] of this.seen) if (tick - v.tick > 200) this.seen.delete(key);
        return out;
    }
}

export interface ThreatClass {
    record: ThreatRecord;
    // hybrid: two or more styles in the last `memory` ticks. unknown: no weapon read and no attack seen (a player on the feed only).
    style: ThreatStyle;
    // The style that a protection prayer should cover now: the last attack, else the style of the weapon.
    cover: CombatStyle | null;
    by: 'attack' | 'weapon' | 'none';
    // Members that this player can attack (the combat-level rule of its tile).
    canHit: string[];
    // In range of a member and coming closer, or already fighting one.
    dangerous: boolean;
}

export interface ClassifyOptions {
    canAttack: (me: { x: number; z: number; combat: number }, them: { x: number; z: number; combatLevel: number }) => boolean;
    // Tiles within which a player counts as in range (default 10).
    range?: number;
}

export function classifyThreat(r: ThreatRecord, members: readonly Member[], o: ClassifyOptions): ThreatClass {
    const range = o.range ?? 10;
    const style: ThreatStyle = r.styles.length >= 2 ? 'hybrid' : r.styles[0] ?? (r.inView ? r.weaponStyle : 'unknown');
    const cover = r.lastAttack?.style ?? (r.inView ? r.weaponStyle : null);
    const canHit = members.filter(m => o.canAttack(m, { x: r.x, z: r.z, combatLevel: r.combat })).map(m => m.name);
    const dangerous = canHit.length > 0 && (r.targeting !== null || (r.nearest.dist <= range && (r.closing || r.nearest.dist <= 4)));
    return { record: r, style, cover, by: r.lastAttack ? 'attack' : r.inView ? 'weapon' : 'none', canHit, dangerous };
}


// An armour swap for a member that a threat of `style` can hit: the obj ids in its pack to wear, and the gain in the defence bonus that
// matters against the style (scripts/pk-threat-kit.ts). Null when no swap helps.
export interface CounterSwap { wear: number[]; gain: number }

export type Adapt =
    | { kind: 'protect'; member: string; style: CombatStyle; reason: string }
    | { kind: 'kit'; member: string; style: CombatStyle; wear: number[]; gain: number; reason: string }
    | { kind: 'single-way'; to: Tile; reason: string }
    | { kind: 'retreat'; reason: string };

export interface DecideOptions {
    // A threat of this many dangerous players at once is a team (default 3, as pk-roam PILE_SIZE).
    teamSize?: number;
    outclasses: (me: Member, them: ThreatRecord) => boolean;
    // Whether a tile is multi-way. A team on a single-way tile is held there: one attacker at a time can hit each member (pvp_combat.rs2:103-133).
    multiAt?: (x: number, z: number) => boolean;
    // The nearest single-way tile for a squad on a multi-way tile, or null (none known).
    singleWayFrom?: (at: Tile) => Tile | null;
    // The armour swap that counters a style for a member, or null.
    counterFor?: (member: string, style: CombatStyle) => CounterSwap | null;
    // Names (lower case) that the squad hunts on purpose. They get a protect prayer, but are not a reason to retreat: the squad
    // chose that fight (a gang of three is three dangerous players that are expected).
    expected?: ReadonlySet<string>;
}

export const threatLine = (c: ThreatClass) => {
    const r = c.record, w = r.worn;
    return `THREAT ${r.name} combat=${r.combat} style=${c.style} by=${c.by} wild=${r.wild} ${r.multi ? 'multi' : 'single'} dist=${r.nearest.dist} to=${r.nearest.member}`
        + `${r.closing ? ' closing' : ''}${r.targeting ? ` fighting=${r.targeting}` : ''} hits=${c.canHit.join('+') || '-'} weapon=${w.weapon ?? '-'} torso=${w.torso ?? '-'} legs=${w.legs ?? '-'} back=${w.back ?? '-'}`
        + `${r.lastAttack ? ` last=${r.lastAttack.style}@${r.lastAttack.tick}` : ''}`;
};

// What the squad does about the threats now, in priority order: retreat, single-way, protect, kit. Each action names its
// reason, which holds the record of the player that caused it.
//  - A player that outclasses the strongest member: retreat.
//  - Three or more unexpected dangerous players (a team): on a multi-way tile, go to the nearest single-way tile, or retreat when none is known;
//    on a single-way tile, hold it (the game lets one attacker at a time on each member).
//  - Each member that a dangerous player can hit: the protect prayer of its style, and the armour swap that counters it.
export function decideAdapt(classes: readonly ThreatClass[], members: readonly Member[], o: DecideOptions): Adapt[] {
    const danger = classes.filter(c => c.dangerous), actions: Adapt[] = [];
    if (!danger.length || !members.length) return actions;
    const team = o.teamSize ?? 3;
    const strongest = [...members].sort((a, b) => b.combat - a.combat)[0]!;
    const unexpected = danger.filter(c => !o.expected?.has(c.record.name.toLowerCase()));
    const outclassing = unexpected.find(c => o.outclasses(strongest, c.record));
    const centre = { x: Math.round(members.reduce((n, m) => n + m.x, 0) / members.length), z: Math.round(members.reduce((n, m) => n + m.z, 0) / members.length) };
    const squadMulti = o.multiAt ? members.some(m => o.multiAt!(m.x, m.z)) : true;
    const names = (cs: readonly ThreatClass[]) => cs.slice(0, 3).map(c => `${c.record.name}(${c.record.combat},${c.style})`).join(', ');
    if (outclassing) actions.push({ kind: 'retreat', reason: `outclassed by ${names([outclassing])} at ${outclassing.record.nearest.dist} tiles` });
    else if (unexpected.length >= team && squadMulti) {
        const to = o.singleWayFrom?.(centre) ?? null;
        actions.push(to ? { kind: 'single-way', to, reason: `team of ${unexpected.length}: ${names(unexpected)}` } : { kind: 'retreat', reason: `team of ${unexpected.length}: ${names(unexpected)}, no single-way tile known` });
    }
    for (const m of members) {
        const away = (c: ThreatClass) => cheb(m, c.record);
        const mine = danger.filter(c => c.canHit.includes(m.name)).sort((a, b) => away(a) - away(b));
        const first = mine.find(c => c.cover !== null);
        if (!first) continue;
        actions.push({ kind: 'protect', member: m.name, style: first.cover!, reason: `${first.record.name} ${first.style} by ${first.by}, ${away(first)} tiles` });
        const swap = o.counterFor?.(m.name, first.cover!);
        if (swap && swap.wear.length) actions.push({ kind: 'kit', member: m.name, style: first.cover!, wear: swap.wear, gain: swap.gain, reason: `${first.record.name} ${first.style}: wear ${swap.wear.join('+')} (+${swap.gain})` });
    }
    return actions;
}
