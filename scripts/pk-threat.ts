// The live threat radar of a squad (packages/core/src/pvp-threat.ts is the model and the rules). Each tick it reads every
// member's view of the client (name, combat level, worn items, animation, overhead prayer, combat target) and the world
// feed radar (players out of view), makes one threat record for each player that is not ours, and decides what the squad
// does about it. Each decision is logged with the record that caused it. Each attacker is appended to
// `.practice/threat-records/<server>/<name>.jsonl`, for the behaviour record of the rivals (research/pvp-fight-loop.md).
//   Options: SQUAD_THREAT=1 (squad main) turns the watch on; SQUAD_THREAT_ACT=0 only logs and records; default 1 with the watch.
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../packages/core/src/inprocess';
import { decodeHeadicons, decodeWorn, wornWeaponStyle, type CombatStyle } from '../packages/core/src/opponent';
import { classifyThreat, decideAdapt, threatLine, ThreatBook, type Adapt, type DecideOptions, type Member, type Sighting, type ThreatClass, type ThreatRecord } from '../packages/core/src/pvp-threat';
import { parsePack } from '../packages/knowledge/src/pack';
import { contentRoot } from '../packages/knowledge/src/paths';
import { PRAYER } from './pk';
import { canAttack, isMulti, outclasses, wildLevel, type Radar } from './pk-roam';

// The style of an attack animation, from the name of the sequence (content pack/seq.pack): a cast is magic, a bow or a throw is ranged,
// a stab, slash, crush or punch is melee. Defends, walks and idles are not attacks.
let seqNames: Map<number, string> | undefined;
export function attackStyleOfSeq(name: string | undefined): CombatStyle | null {
    if (!name || !name.startsWith('human_')) return null;
    if (/(block|def|walk|run|ready|stand|idle|turn|death|heal|trap|emote)/.test(name)) return null;
    if (/^human_cast/.test(name)) return 'magic';
    if (/^human_(bow|xbow|crossbow|dart|knife|javelin|thrownaxe|chinchompa|throw|spear_throw)/.test(name)) return 'ranged';
    if (/^human_(stab|slash|blunt|spear|sword|dagger|scim|whip|axe|mace|unarmed|hack|lunge|attack|claw|halberd|battleaxe|warhammer|pickaxe|2h)/.test(name)) return 'melee';
    return null;
}
// The attack animations that the content gives to weapons, by sequence name: the stab, slash and crush animations of every weapon object
// (scripts/skill_combat/configs/**/*.obj: `stabattack_anim`, `slashattack_anim`, `crushattack_anim`, such as human_ddagger_lunge) are melee, and the special attack
// animations of scripts/skill_combat/scripts/pvp/specs/scripts/pvp_<weapon>.rs2 (puncture, cleave, shove, snapshot, chainhit) take the style of their
// weapon: a bow or a thrown weapon is ranged, any other is melee. The name rules of attackStyleOfSeq do not see these names.
let contentStyles: Map<string, CombatStyle> | undefined;
export function contentAttackStyles(root = contentRoot()): Map<string, CombatStyle> {
    const map = new Map<string, CombatStyle>();
    const configs = join(root, 'scripts/skill_combat/configs');
    for (const file of readdirSync(configs, { recursive: true }) as string[]) {
        if (!file.endsWith('.obj')) continue;
        for (const m of readFileSync(join(configs, file), 'utf8').matchAll(/^param=(?:stab|slash|crush)attack_anim,(\w+)/gm)) map.set(m[1]!, 'melee');
    }
    const dir = join(root, 'scripts/skill_combat/scripts/pvp/specs/scripts');
    for (const file of readdirSync(dir)) {
        const weapon = file.match(/^pvp_(.+)\.rs2$/)?.[1];
        if (!weapon) continue;
        const style: CombatStyle = /bow|thrownaxe|knife|dart|javelin/.test(weapon) ? 'ranged' : 'melee';
        for (const m of readFileSync(join(dir, file), 'utf8').matchAll(/^anim\((?!%)(\w+),/gm)) map.set(m[1]!, style);
    }
    return map;
}
export const attackStyleOfAnim = (anim: number): CombatStyle | null => {
    seqNames ??= parsePack(readFileSync(join(contentRoot(), 'pack/seq.pack'), 'utf8'));
    contentStyles ??= contentAttackStyles();
    const name = seqNames.get(anim);
    return (name !== undefined ? contentStyles.get(name) : undefined) ?? attackStyleOfSeq(name);
};

type ClientPlayer = { name?: string | null; combatLevel?: number; headicons?: number; appearance?: ArrayLike<number>; primaryAnim?: number; spotanimId?: number };
type Client = { localPlayer?: unknown; players?: (ClientPlayer | null)[] } | undefined;

// One player of the client, with its worn items, animation and prayer. Slots: content player/configs/equip.constant.
export function readSighting(client: unknown, index: number, name: string, combat: number, x: number, z: number): Sighting {
    const p = (client as Client)?.players?.[index];
    const worn = decodeWorn(p?.appearance ?? []);
    const head = decodeHeadicons(p?.headicons ?? 0);
    return { name, combat, x, z, inView: true, worn: { weapon: worn.rhand, torso: worn.torso, legs: worn.legs, back: worn.back, hat: worn.hat }, anim: p?.primaryAnim ?? -1, spot: p?.spotanimId ?? -1, protect: head.protect, skulled: head.skulled };
}
const selfIndex = (client: unknown) => { const c = client as Client; return c?.players && c.localPlayer ? c.players.indexOf(c.localPlayer as ClientPlayer) : -1; };

export interface WatchOptions {
    sessions: () => Session[];
    server: string;
    friends: ReadonlySet<string>;
    radar?: Radar;
    log: (line: string) => void;
    // The root of the record tree (default the working directory), and false for no record.
    recordRoot?: string | false;
    decide?: Partial<DecideOptions>;
    // false: the watch logs and records, and the squad does not act on it (default true).
    act?: boolean;
    now?: () => number;
}

export class ThreatWatch {
    private book: ThreatBook;
    private cache: { tick: number; classes: ThreatClass[]; actions: Adapt[] } | null = null;
    private logged = new Map<string, string>();
    private recorded = new Map<string, number>();
    readonly act: boolean;
    constructor(private o: WatchOptions) {
        this.act = o.act !== false;
        this.book = new ThreatBook({ friends: o.friends, weaponStyle: id => wornWeaponStyle(id), attackStyle: anim => attackStyleOfAnim(anim), multiAt: isMulti, wildAt: wildLevel });
    }

    // The members now in the Wilderness, from the sessions that are logged in.
    private members(): { sessions: Session[]; members: Member[] } {
        const sessions = this.o.sessions().filter(s => { const p = s.sdk.getState()?.player; return !!p && !p.isDead && wildLevel(p.worldX, p.worldZ) > 0; });
        return { sessions, members: sessions.map(s => { const p = s.sdk.getState()!.player!; return { name: s.name, x: p.worldX, z: p.worldZ, combat: p.combatLevel }; }) };
    }

    // The threats, their classes and the decisions of this tick. One reading for the squad each tick, whichever member asks.
    step(tick: number): { classes: ThreatClass[]; actions: Adapt[] } {
        if (this.cache?.tick === tick) return this.cache;
        const { sessions, members } = this.members();
        const sightings = new Map<string, Sighting>();
        const nameAt = new Map(sessions.map(s => [selfIndex(s.client), s.name] as const));
        for (const s of sessions) {
            for (const q of s.sdk.getState()?.nearbyPlayers ?? []) {
                const key = q.name.toLowerCase();
                if (sightings.has(key)) continue;
                const sight = readSighting(s.client, q.index, q.name, q.combatLevel, q.x, q.z);
                sight.targeting = q.combatTargetType === 'player' && q.combatTargetIndex !== undefined ? nameAt.get(q.combatTargetIndex) ?? null : null;
                sightings.set(key, sight);
            }
        }
        if (this.o.radar?.fresh()) for (const t of this.o.radar.tracks.values()) if (!sightings.has(t.name.toLowerCase())) sightings.set(t.name.toLowerCase(), { name: t.name, combat: t.combatLevel, x: t.x, z: t.z, inView: false });
        const records = this.book.observe(tick, members, [...sightings.values()].filter(x => members.some(m => Math.max(Math.abs(m.x - x.x), Math.abs(m.z - x.z)) <= 40)));
        const classes = records.map(r => classifyThreat(r, members, { canAttack: (m, t) => canAttack(m, t) }));
        const actions = decideAdapt(classes, members, { outclasses: (m, t) => outclasses({ combat: m.combat }, { combatLevel: t.combat }), ...this.o.decide });
        this.cache = { tick, classes, actions };
        this.report(tick, classes, actions);
        return this.cache;
    }

    actionsFor(member: string): Adapt[] { return (this.cache?.actions ?? []).filter(a => 'member' in a ? a.member === member : true); }

    // The log and the record: a line when a dangerous player or a decision changes, and a record line for each player in range.
    private report(tick: number, classes: ThreatClass[], actions: Adapt[]) {
        for (const c of classes) {
            if (!c.dangerous && !c.record.lastAttack) continue;
            const key = c.record.name.toLowerCase(), sig = `${c.style}/${c.canHit.join('+')}/${c.record.closing}`;
            if (this.logged.get(key) !== sig) { this.logged.set(key, sig); this.o.log(threatLine(c)); }
            this.record(tick, c);
        }
        for (const a of actions) {
            // The reason holds distances that change each tick: a decision is logged again only when its kind, member, style, kit or tile changes.
            const key = `adapt:${a.kind}:${'member' in a ? a.member : ''}`, sig = JSON.stringify({ ...a, reason: undefined });
            if (this.logged.get(key) !== sig) { this.logged.set(key, sig); this.o.log(`ADAPT ${a.kind}${'member' in a ? ` ${a.member}` : ''}${'style' in a ? ` ${a.style}` : ''}${'kit' in a ? ` ${a.kit}` : ''}: ${a.reason}`); }
        }
        // A decision that no longer holds is forgotten, so that its next time is logged again.
        for (const key of [...this.logged.keys()]) if (key.startsWith('adapt:') && !actions.some(a => `adapt:${a.kind}:${'member' in a ? a.member : ''}` === key)) this.logged.delete(key);
    }

    private record(tick: number, c: ThreatClass) {
        if (this.o.recordRoot === false) return;
        const r: ThreatRecord = c.record, key = r.name.toLowerCase(), last = this.recorded.get(key);
        if (last !== undefined && tick - last < 25 && !(r.lastAttack && r.lastAttack.tick === tick)) return;
        this.recorded.set(key, tick);
        const dir = join(this.o.recordRoot ?? '.', '.practice', 'threat-records', this.o.server.replace(/[^A-Za-z0-9._-]/g, '_'));
        const line = { schema: 'threat-sighting/1', tick, at: (this.o.now ?? Date.now)(), server: this.o.server, name: r.name, combat: r.combat, worn: r.worn, wild: r.wild, multi: r.multi, x: r.x, z: r.z,
            nearest: r.nearest, closing: r.closing, speed: r.speed, style: c.style, by: c.by, cover: c.cover, lastAttack: r.lastAttack, targeting: r.targeting, protect: r.protect, skulled: r.skulled, canHit: c.canHit };
        try { mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, `${r.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.jsonl`), JSON.stringify(line) + '\n'); }
        catch (error) { this.o.log(`THREAT record write failed: ${String(error)}`); }
    }
}

// The protect prayer to hold now for a member, from the decisions: the style of the nearest dangerous player that can hit it, or null.
export const protectOf = (actions: readonly Adapt[], member: string): CombatStyle | null => (actions.find(a => a.kind === 'protect' && a.member === member) as Extract<Adapt, { kind: 'protect' }> | undefined)?.style ?? null;
export const retreatOf = (actions: readonly Adapt[]): string | null => (actions.find(a => a.kind === 'retreat') as Extract<Adapt, { kind: 'retreat' }> | undefined)?.reason ?? null;

// Protect from `style` for an account that waits (no fight loop to hold it): other protect prayers off, then the one on, one input each 3 ticks.
// The levels are the prayer requirements (pk.ts PRAYER_REQ: 37, 40, 43).
const PROTECT_LEVEL = { magic: 37, ranged: 40, melee: 43 } as const;
const PROTECT_PRAYER = { magic: PRAYER.magic, ranged: PRAYER.missiles, melee: PRAYER.melee } as const;
export function holdProtect(s: Session, style: CombatStyle, tick: number): void {
    if (tick % 3 !== 0) return;
    const active = s.sdk.getState()?.prayers.activePrayers ?? [], want = PROTECT_PRAYER[style];
    for (const i of Object.values(PROTECT_PRAYER)) if (i !== want && active[i]) { void s.sdk.sendTogglePrayer(i); return; }
    if (!active[want] && (s.sdk.getSkill('Prayer')?.level ?? 0) >= PROTECT_LEVEL[style]) void s.sdk.sendTogglePrayer(want);
}
