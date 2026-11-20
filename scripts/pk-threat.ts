// The live threat radar of a squad (packages/core/src/pvp-threat.ts is the model and the rules). Each tick it reads every
// member's view of the client (name, combat level, worn items, animation, overhead prayer, combat target) and the world
// feed radar (players out of view), makes one threat record for each player that is not ours, and decides what the squad
// does about it. Each decision is logged with the record that caused it. Each attacker is appended to
// `.practice/threat-records/<server>/<name>.jsonl`, for the behaviour record of the rivals (research/pvp-fight-loop.md).
//   Options: SQUAD_THREAT=1 (squad main) turns the watch on; SQUAD_THREAT_ACT=0 only logs and records; default 1 with the watch.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../packages/core/src/inprocess';
import { decodeHeadicons, decodeWorn, wornWeaponStyle, type CombatStyle } from '../packages/core/src/opponent';
import { classifyThreat, DEFAULT_ODDS, decideAdapt, threatLine, ThreatBook, type OddsParams, type Adapt, type DecideOptions, type Member, type ProtectLevels, type Sighting, type ThreatClass, type ThreatRecord } from '../packages/core/src/pvp-threat';
import { parsePack } from '../packages/knowledge/src/pack';
import { contentRoot } from '../packages/knowledge/src/paths';
import { PRAYER } from './pk';
import { nearestSingleWay, planCounterSwap, restoreFor, wearIds } from './pk-threat-kit';
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
    // A record file at this size (default MAX_RECORD_BYTES) moves to `<name>.jsonl.1` (the older one of that name goes), so a name keeps at most
    // twice that. A server directory with this many record files (default MAX_RECORD_FILES) takes no new name.
    recordMaxBytes?: number; recordMaxFiles?: number;
    // Ticks after a retreat or a single-way move for which the same players cannot cause another one (default 600). A player that was not
    // there at the first one causes one at once. A decision stays for 30 ticks, so that each member of the squad acts on it.
    cooldown?: number;
    // Fight or flight by the win-chance estimate (default on, with DEFAULT_ODDS; the parts that are given replace the default; false: the counting rules).
    odds?: Partial<OddsParams> | false;
    decide?: Partial<DecideOptions>;
    // false: the watch logs and records, and the squad does not act on it (default true).
    act?: boolean;
    now?: () => number;
}

// A record file moves aside at 5 MB, and a server directory takes at most 500 names.
export const MAX_RECORD_BYTES = 5_000_000, MAX_RECORD_FILES = 500;

export class ThreatWatch {
    private book: ThreatBook;
    private cache: { tick: number; classes: ThreatClass[]; actions: Adapt[]; interlopers: string[] } | null = null;
    private logged = new Map<string, string>();
    private recorded = new Map<string, number>();
    private cooling = new Map<string, number>();
    private held: { until: number; moves: Adapt[] } | null = null;
    private pending: { culprits: string[]; moves: Adapt[] } | null = null;
    private full = false;
    readonly act: boolean;
    constructor(private o: WatchOptions) {
        this.act = o.act !== false;
        this.book = new ThreatBook({ friends: o.friends, weaponStyle: id => wornWeaponStyle(id), attackStyle: anim => attackStyleOfAnim(anim), multiAt: isMulti, wildAt: wildLevel });
    }

    // The members now in the Wilderness, from the sessions that are logged in.
    private members(): { sessions: Session[]; members: Member[] } {
        const sessions = this.o.sessions().filter(s => { const p = s.sdk.getState()?.player; return !!p && !p.isDead && wildLevel(p.worldX, p.worldZ) > 0; });
        return { sessions, members: sessions.map(s => { const p = s.sdk.getState()!.player!; return { name: s.name, x: p.worldX, z: p.worldZ, combat: p.combatLevel, prayer: s.sdk.getState()!.prayers?.prayerPoints, prayerLevel: s.sdk.getSkill('Prayer')?.level,
            hp: p.hp, food: s.sdk.getInventory().filter(i => i.optionsWithIndex?.some(op => /^eat$/i.test(op.text))).length }; }) };
    }

    // The threats, their classes and the decisions of this tick. One reading for the squad each tick, whichever member asks.
    step(tick: number): { classes: ThreatClass[]; actions: Adapt[]; interlopers: string[] } {
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
        const levelOf = (s: Session, skill: string) => s.sdk.getSkill(skill)?.level ?? 1;
        const decided = decideAdapt(classes, members, {
            outclasses: (m, t) => outclasses({ combat: m.combat }, { combatLevel: t.combat }),
            multiAt: isMulti,
            protectLevels: protectLevels(),
            ...(this.o.odds === false ? {} : { odds: { ...DEFAULT_ODDS, ...this.o.odds } }),
            // The nearest single-way tile, away from the dangerous players.
            singleWayFrom: at => nearestSingleWay(at, { multiAt: isMulti, wildAt: wildLevel, avoid: classes.filter(c => c.dangerous).map(c => ({ x: c.record.x, z: c.record.z })) }),
            // The armour of the pack that defends better against the threat's style (scripts/pk-threat-kit.ts).
            counterFor: (member, style) => {
                const s = sessions.find(x => x.name === member);
                return s ? planCounterSwap({ worn: s.sdk.getEquipment().map(e => e.id), pack: s.sdk.getInventory().map(i => i.id), style,
                    levels: { attack: levelOf(s, 'Attack'), strength: levelOf(s, 'Strength'), defence: levelOf(s, 'Defence'), ranged: levelOf(s, 'Ranged'), magic: levelOf(s, 'Magic') } }) : null;
            },
            ...this.o.decide,
        });
        const actions = this.cooldown(tick, classes, decided);
        // The interlopers: dangerous players that the squad did not come for. They are targets (the squad switches to them, one at a time).
        const expected = this.o.decide?.expected;
        const interlopers = classes.filter(c => c.dangerous && !expected?.has(c.record.name.toLowerCase())).map(c => c.record.name);
        this.cache = { tick, classes, actions, interlopers };
        this.report(tick, classes, actions);
        return this.cache;
    }

    // A retreat or a single-way move stays decided, each tick, until a member acts on it and says so (`acted`). From then on the same players cannot cause
    // another one for `cooldown` ticks (the protect prayer and the swap stay): a stranger at the post would cause retreat, return, retreat until the trips
    // run out. A member inside a fight does not read the decision, so the cooldown must not start before one has acted.
    private cooldown(tick: number, classes: readonly ThreatClass[], actions: Adapt[]): Adapt[] {
        const move = (a: Adapt) => a.kind === 'retreat' || a.kind === 'single-way';
        const rest = actions.filter(a => !move(a)), moves = actions.filter(move);
        const hasRetreat = moves.some(a => a.kind === 'retreat');
        if (this.held && tick <= this.held.until && (!hasRetreat || this.held.moves.some(a => a.kind === 'retreat'))) {
            return [...this.held.moves, ...rest];
        }
        if (!moves.length) { this.pending = null; return actions; }
        // The players that caused the move: the strangers; with the win-chance estimate every dangerous player counts (it counts the squad's targets too, so a lost fight
        // against the gang alone must have a cooldown as well).
        const expected = this.o.odds === false ? this.o.decide?.expected : undefined;
        const culprits = classes.filter(c => c.dangerous && !expected?.has(c.record.name.toLowerCase())).map(c => c.record.name.toLowerCase());
        const kinds = [...new Set(moves.map(a => a.kind))];
        if (culprits.length && culprits.every(n => kinds.every(k => (this.cooling.get(`${k}:${n}`) ?? -1) > tick))) {
            if (this.logged.get('cooldown') !== culprits.join('+')) { this.logged.set('cooldown', culprits.join('+')); this.o.log(`THREAT retreat held, cooldown: ${culprits.join(', ')}`); }
            this.pending = null;
            return rest;
        }
        this.pending = { culprits, moves };
        this.logged.delete('cooldown');
        return actions;
    }

    // A member acts on the retreat or the single-way move that the last `step` decided: the cooldown of its players starts, and the decision stays
    // 30 ticks for the other members of the squad.
    acted(tick: number): void {
        if (!this.pending) return;
        const until = tick + (this.o.cooldown ?? 600);
        const hasRetreat = this.pending.moves.some(a => a.kind === 'retreat');
        for (const n of this.pending.culprits) {
            this.cooling.set(`single-way:${n}`, until);
            if (hasRetreat) this.cooling.set(`retreat:${n}`, until);
        }
        this.held = { until: tick + 30, moves: this.pending.moves };
        this.pending = null;
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
            if (this.logged.get(key) !== sig) { this.logged.set(key, sig); this.o.log(`ADAPT ${a.kind}${'member' in a ? ` ${a.member}` : ''}${'style' in a ? ` ${a.style}` : ''}: ${a.reason}`); }
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
        const file = join(dir, `${r.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.jsonl`);
        try {
            mkdirSync(dir, { recursive: true });
            if (existsSync(file)) {
                if (statSync(file).size >= (this.o.recordMaxBytes ?? MAX_RECORD_BYTES)) { rmSync(`${file}.1`, { force: true }); renameSync(file, `${file}.1`); }
            } else if (readdirSync(dir).filter(n => n.endsWith('.jsonl')).length >= (this.o.recordMaxFiles ?? MAX_RECORD_FILES)) {
                if (!this.full) { this.full = true; this.o.log(`THREAT record directory is full (${this.o.recordMaxFiles ?? MAX_RECORD_FILES} files): no new name is recorded`); }
                return;
            }
            appendFileSync(file, JSON.stringify(line) + '\n');
        } catch (error) { this.o.log(`THREAT record write failed: ${String(error)}`); }
    }
}

// The protect prayer to hold now for a member, from the decisions: the style of the nearest dangerous player that can hit it, or null.
export const protectOf = (actions: readonly Adapt[], member: string): CombatStyle | null => (actions.find(a => a.kind === 'protect' && a.member === member) as Extract<Adapt, { kind: 'protect' }> | undefined)?.style ?? null;
export const retreatOf = (actions: readonly Adapt[]): string | null => (actions.find(a => a.kind === 'retreat') as Extract<Adapt, { kind: 'retreat' }> | undefined)?.reason ?? null;

// Protect from `style` for an account that waits (no fight loop to hold it): other protect prayers off, then the one on, one input each 3 ticks.
const PROTECT_PRAYER = { magic: PRAYER.magic, ranged: PRAYER.missiles, melee: PRAYER.melee } as const;
// The Prayer level of each protect prayer, read from the content (scripts/skill_prayer/configs/prayers.dbrow).
let levelCache: ProtectLevels | undefined;
export function protectLevels(): ProtectLevels {
    if (levelCache) return levelCache;
    const text = readFileSync(join(contentRoot(), 'scripts/skill_prayer/configs/prayers.dbrow'), 'utf8');
    const of = (row: string) => Number(text.match(new RegExp(`\\[prayer_protect_from_${row}\\][^\\[]*?data=level,(\\d+)`))?.[1]);
    const levels = { magic: of('magic'), ranged: of('missiles'), melee: of('melee') };
    if (!Object.values(levels).every(Number.isFinite)) throw new Error('prayers.dbrow: the protect prayer levels are not there');
    return (levelCache = levels);
}
export function holdProtect(s: Session, style: CombatStyle, tick: number): void {
    if (tick % 3 !== 0) return;
    // Turning a protect prayer on turns the other two off on the server (prayer.rs2 prayer_activate calls prayer_deactivate_conflicting, and each protect prayer
    // lists the other two in prayers.dbrow), so only the wanted one is sent: switching the old one off first cost another 3 ticks.
    const active = s.sdk.getState()?.prayers.activePrayers ?? [], want = PROTECT_PRAYER[style];
    if (!active[want] && (s.sdk.getSkill('Prayer')?.level ?? 0) >= protectLevels()[style]) void s.sdk.sendTogglePrayer(want);
}

// The armour swap of one account, for the squad's hold loop and the hunt: wears what the radar decides (the `kit` action of the account) from the
// pack once, and wears the worn armour again after the threat has been gone for `holdTicks` ticks. It returns true when it used the tick
// (an input and a tick each), so that the caller goes on with a new pass.
export class KitSwapper {
    private swapped: { restore: number[]; lastNeeded: number; style: string } | null = null;
    constructor(private holdTicks = 60) {}
    get active() { return this.swapped !== null; }
    async step(s: Session, actions: readonly Adapt[], now: number, tick: () => Promise<boolean>, log: (line: string) => void): Promise<boolean> {
        const kit = actions.find(a => a.kind === 'kit' && a.member === s.name) as Extract<Adapt, { kind: 'kit' }> | undefined;
        if (kit && !this.swapped) {
            this.swapped = { restore: restoreFor(s.sdk.getEquipment().map(e => e.id), kit.wear), lastNeeded: now, style: kit.style };
            log(`[${s.name}] threat kit swap: ${kit.reason}`);
            const failed = await wearIds(s, kit.wear, tick);
            if (failed.length) log(`[${s.name}] threat kit swap could not wear ${failed.join('+')}`);
            return true;
        }
        // The swap stays needed while a threat of its style can hit us: the kit action itself goes once the armour is worn (planCounterSwap finds nothing better), so
        // the protect action of the same style is the sign that the threat is still there.
        const stillThere = this.swapped !== null && actions.some(a => a.kind === 'protect' && a.member === s.name && a.style === this.swapped!.style);
        if ((kit || stillThere) && this.swapped) this.swapped.lastNeeded = now;
        if (!kit && this.swapped && now - this.swapped.lastNeeded >= this.holdTicks) {
            const back = this.swapped.restore;
            this.swapped = null;
            log(`[${s.name}] threat kit restore: wear ${back.join('+')}`);
            await wearIds(s, back, tick);
            return true;
        }
        return false;
    }
}

// The settings of the squad's threat watch: SQUAD_THREAT_OPTS (a JSON object) over the SQUAD_THREAT_* settings of the environment. A key that is not
// known, or a value that is not a number, throws, so that a typo in a climb cannot leave a setting at its default without a word.
//   act (false: only log and record), cooldown (ticks), expected (false: the squad's targets count as strangers), odds (false: the counting rules),
//   and the constants of the win-chance estimate: lose, protect, pile, theirFood, singleWayMin.
export interface ThreatOptions { act: boolean; cooldown: number; expectedTargets: boolean; odds: Partial<OddsParams> | false }
export const THREAT_OPTION_KEYS = ['act', 'cooldown', 'expected', 'odds', 'lose', 'protect', 'pile', 'theirFood', 'singleWayMin'] as const;
export function threatOptions(json: string, get: (name: string, fallback: string) => string): ThreatOptions {
    let o: unknown;
    try { o = JSON.parse(json.trim() || '{}'); } catch { throw new Error('SQUAD_THREAT_OPTS is not JSON'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('SQUAD_THREAT_OPTS is not a JSON object');
    const given = o as Record<string, unknown>;
    for (const key of Object.keys(given)) if (!(THREAT_OPTION_KEYS as readonly string[]).includes(key)) throw new Error(`SQUAD_THREAT_OPTS has an unknown key: ${key} (known: ${THREAT_OPTION_KEYS.join(', ')})`);
    const num = (key: string, env: string, fallback: string) => { const n = Number(given[key] ?? get(env, fallback)); if (!Number.isFinite(n)) throw new Error(`${key} is not a number`); return n; };
    const off = given.odds !== undefined ? given.odds === false || given.odds === 0 : get('SQUAD_THREAT_ODDS', '1') === '0';
    return {
        act: given.act !== undefined ? given.act !== false && given.act !== 0 : get('SQUAD_THREAT_ACT', '1') !== '0',
        cooldown: num('cooldown', 'SQUAD_THREAT_COOLDOWN', '600'),
        expectedTargets: given.expected !== undefined ? given.expected !== false && given.expected !== 0 : get('SQUAD_THREAT_EXPECTED', '1') === '1',
        odds: off ? false : { lose: num('lose', 'SQUAD_THREAT_LOSE', '0.9'), protect: num('protect', 'SQUAD_THREAT_PROTECT', '0.6'), pile: num('pile', 'SQUAD_THREAT_PILE', '0.7'),
            theirFood: num('theirFood', 'SQUAD_THREAT_THEIR_FOOD', '10'), singleWayMin: num('singleWayMin', 'SQUAD_THREAT_SINGLE', '1.5') },
    };
}
