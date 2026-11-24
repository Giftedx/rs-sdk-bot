// Core Haggis schedule domain types, board/trick/lever/scenario constants, lever patching, and variant selection.
import { join } from 'node:path';
import { xpForLevel } from '../curve';
import type { TravelModel } from '../travel';

// Quest points in rev 289 content: the sum of the quest.constant QP values (the #1 has 141 of 145).
export const MAX_QP = 145;

export const BOARDS_FILE = join(import.meta.dir, '..', 'haggis-boards.json');

export const SKILLS = [
    'attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic', 'cooking', 'woodcutting', 'fletching',
    'fishing', 'firemaking', 'crafting', 'smithing', 'mining', 'herblore', 'agility', 'thieving', 'runecraft',
] as const;
export type Skill = (typeof SKILLS)[number];
export type BoardId = Skill | 'overall' | 'questpoints' | 'equipment' | 'bank' | 'runite';
export type Evidence = 'MEASURED' | 'CODE-READ' | 'ESTIMATE';
export type Trick = 'loginWine' | 'stunRelog' | 'sacredOil';
export type Mode = 'floor' | 'realistic';
export interface Range { floor: number; realistic: number; evidence?: Evidence; source?: string }
// `from`: the activity id that makes the item during the run (Haggis keeps the output). When that row is in the
// route, the item is not staged by a helper (suppliesFor leaves it out).
export interface Supply { item: string; count: number; itemId?: number; note?: string; from?: string }

export const XP99 = xpForLevel(99);

export interface Activity {
    id: string;
    label: string;
    serves: BoardId[];
    // Fixed foreground ticks. For a `train` activity the ticks are computed from the XP still needed.
    ticks?: Range;
    // Train one skill to a level at a flat rate. `side` = XP given to other skills per XP of the main skill.
    // For a rate, `floor` is the best case (the higher rate).
    train?: { skill: Skill; toLevel: number; xpPerTick: Range; side?: Partial<Record<Skill, number>> };
    // XP lands this many ticks after the foreground part ends. The foreground clock does not wait.
    background?: Range;
    // XP to give. 'to99' = whatever the skill still needs for 99 when the activity starts.
    xp?: Partial<Record<Skill, number | 'to99'>>;
    lump?: boolean; // XP lands at the end (quests); otherwise it accrues linearly over the foreground ticks
    qp?: number;
    requires?: string[];
    minLevel?: Partial<Record<Skill, number>>;
    minLevelSource?: string; // why the gate exists (file:line evidence), for example a quest boss fight
    minQp?: number;
    // Alternatives: within one group the scheduler uses the eligible option with the fewest total ticks.
    variant?: { group: string; option: string; trick?: Trick };
    // Multiplies the foreground ticks when the trick is on (for example stun relog on thieving).
    trickSpeedup?: { trick: Trick; factor: number };
    // Host: foreground ticks inside this activity that leave the player free for a different action (for example
    // the 8-tick pickpocket stun, which blocks only pickpocketing and walking). Guests use them.
    deadTicks?: Range;
    // Guest: this activity runs inside the dead ticks of the host activity with this id. The ticks that do not fit
    // run in the foreground right after the host. Without the host in the scenario, the guest runs alone.
    inside?: string;
    // Gap-closer lever (research/gap-closers.md). 'add' rows exist only when the lever is on; 'drop' rows only when it
    // is off. A lever is on unless ScheduleOptions.disable names it. An `owner` lever (OWNER DECISION) is off unless
    // ScheduleOptions.owner names it.
    lever?: { id: string; role: 'add' | 'drop'; owner?: boolean };
    // Field patches that apply when a lever is on (in table order). `set` replaces fields; `addRequires` and
    // `addSide` extend the requirement list and the side XP of a `train` activity.
    patches?: LeverPatch[];
    evidence: Evidence;
    source: string;
    supplies?: Supply[];
    leadTime?: string; // helper staging work for the supplies (research/supply-logistics.md)
    pending?: string; // an input file that will replace these numbers
    // Travel (travel.ts). `at`: a place id, 'anywhere' (no move) or 'bank' (nearest bank). Without `at` the activity
    // does not move the player. `endAt`: where it ends when its own ticks already hold the walk inside it (quests).
    // `via`: places it walks to in order after `at`; those legs are added to its ticks. `bankTrips`: round trips
    // from its place to the nearest bank, added to its ticks.
    at?: string;
    endAt?: string;
    via?: string[];
    bankTrips?: number;
    // Historical metadata only. Neither policy labels nor missing supplies exclude a route.
    out?: { reason: string; rule?: string; replacement: string };
}

export type BoardKind =
    | { kind: 'clock'; deadline: number } // skill or overall: finish tick must be < deadline
    // Quest Points ranks by points desc, then playtime asc (RankedHiscoresWorker.ts:19); the playtime is stamped when
    // the total changes (LoginServer.ts:209-213). The leader can still gain points up to maxPoints, so only reaching
    // maxPoints before leaderTicks is a secure win (the leader's own maxPoints stamp is later than leaderTicks).
    | { kind: 'qp'; leaderPoints: number; leaderTicks: number; maxPoints?: number }
    | { kind: 'value'; note: string }; // no clock: value target from a board not in the snapshot

export interface Board { id: BoardId; label: string; rule: BoardKind }

export interface ScheduleOptions {
    mode: Mode;
    tricks: ReadonlySet<Trick>;
    sacrificed?: ReadonlySet<BoardId>;
    startXp?: Partial<Record<Skill, number>>;
    force?: Record<string, string>; // variant group -> option, to compare routes
    disable?: ReadonlySet<string>; // safe levers to switch off (to measure each lever alone)
    owner?: ReadonlySet<string>; // legacy name: explicitly enable retired variants for comparison; no approval gate
    travel?: TravelModel; // price the walks between activities; without it travel is 0
    includeOut?: boolean; // legacy compatibility, ignored: all rows are eligible
    // How schedule() picks one option per variant group: 'overall' (default) = the combination with the earliest
    // Overall finish in this mode (chooseRoute); 'ticks' = each group's option with the fewest raw ticks.
    route?: 'overall' | 'ticks';
}

export interface LeverPatch {
    lever: string;
    owner?: boolean;
    set?: Partial<Omit<Activity, 'id' | 'patches' | 'lever'>>;
    addRequires?: string[];
    addSide?: Partial<Record<Skill, number>>;
}

// `start` is the start of the activity itself; the walk to it (`travel` ticks from `from` to `to`) ends at `start`.
// `ticks` includes `inner`: the via legs and bank trips inside the activity.
export interface Placed { id: string; label: string; start: number; end: number; landsAt: number; ticks: number; deadline: number; travel?: number; from?: string; to?: string; method?: string; inner?: number }
export interface BoardResult {
    id: BoardId;
    label: string;
    deadline: number | null;
    finish: number | null; // tick the board's condition was met; null = never
    slack: number | null; // deadline - finish; > 0 beats #1
    // HOLD: rank 1 on points now, but lost if the leader gains points first (Quest Points only).
    status: 'WIN' | 'HOLD' | 'LATE' | 'TIE' | 'NEVER' | 'NO-CLOCK';
    sacrificed: boolean;
}
// `route`: the option used in each variant group (group -> option). `overallFinish`: the tick of the last 99 (null =
// some skill never reaches 99), whether or not `boards` has an Overall board; `lastSkill`: the skill of that 99.
export interface ScheduleResult { order: Placed[]; boards: BoardResult[]; blocked: string[]; idle: number; endTick: number; qp: number; chosen: string[]; travel: number; route: Record<string, string>; overallFinish: number | null; lastSkill: Skill | null }

export const TRICKS: Trick[] = ['loginWine', 'stunRelog', 'sacredOil'];
// Gap-closer choices. All techniques are authorized; retired slower variants remain available for comparison.
export const LEVERS: { id: string; owner: boolean; label: string; retired?: boolean }[] = [
    { id: 'magic-teleports', owner: false, label: 'Standard Magic teleports (Varrock 25, Lumbridge 31, Falador 37, Camelot 45, Ardougne 51), Amulet of glory, Ring of dueling, and Deserted Keep lever' },
    { id: 'spiders-combat', owner: false, label: 'Wilderness Poison Spiders progressive Ranged 1->55->99, pre-Overall Dragon Slayer, Doric/Plague City + Zoo mining, Air->Body altar RC' },
    { id: 'woodcut-givers', owner: false, label: 'Woodcutting 1->99 + Prayer 1->99 with bone givers at the trees (extra:woodcut-givers-block5)' },
    { id: 'superheat-stun', owner: false, label: 'Superheat inside pickpocket stuns (Magic 76->80 and Smithing XP in unused stun deadTicks)' },
    { id: 'q-burst', owner: false, label: 'Q_BURST=1 dialogue burst on non-talk-plans quests (0.7% measured seed-7 saving)' },
    { id: 'magic-enchant', owner: false, label: 'Enchant ladder rather than teleport ladder; compare by disabling this option' },
    { id: 'combat-hp-bound', owner: false, label: "Melee by combat (HP-bound); melee-only quests after Overall; Witch's House split out" },
    // Retired: measured, it slows Defence to 86.7 style XP/tick and loses ticks in every table
    // (research/combat-measure.md section 6); bow + cannon carries Ranged instead.
    { id: 'cannon-melee', owner: false, retired: true, label: 'Cannon fires for Ranged XP during every melee top-up (RETIRED: loses ticks)' },
    { id: 'stun-guests', owner: false, label: 'Prayer and Magic inside the pickpocket stuns' },
    // research/combat-measure.md section 7. Attack is 99 from Tree Gnome Village, The Grand Tree and Fight Arena before
    // Monkey Madness, so Waterfall adds only Strength; a melee top-up after Monkey Madness gives it in fewer ticks.
    { id: 'waterfall-late', owner: false, label: 'Waterfall Quest after Overall; Strength 99 from Monkey Madness + melee top-up' },
    // Defence trains at the ranged row spot right after the Ranged row, before the walk to the Wilderness course.
    { id: 'def-at-ranged-spot', owner: false, label: 'Defence top-up at the Gnome battlefield right after the Ranged row (no walk back)' },
    { id: 'flinch-gather', owner: false, label: '2-tick flinch woodcutting and fishing (tick manipulation, UNVERIFIED live)' },
    { id: 'charge-spam', owner: false, label: 'Charge spell 80 -> 99, no delay, no recast check' },
    { id: 'wild-iron', owner: false, label: '5-rock Wilderness iron spot (PvP risk)' },
    // Rival techniques, priced from bleugreen/rs-sdk@3bd2ab0a (ESTIMATE until we measure them; research/rival-gap-list.md).
    { id: 'rival-knife-mine', owner: false, label: 'Knife-starter mining, Ardougne zoo iron rotation' },
    { id: 'rival-altar-room-rc', owner: false, label: '7-tick altar-room runecraft cycle with givers' },
    { id: 'rival-dialogue-burst', owner: false, label: 'Dialogue bursts (several continue clicks in one tick)' },
    { id: 'rival-grandtree-agility', owner: false, label: 'Grand Tree first, then agility laps' },
    { id: 'rival-bury-in-knife-wc', owner: false, label: 'Bury bones inside the knife woodcutting loop' },
    // Retired: our measured laps (research/agility.md) replace the rival's estimate.
    { id: 'rival-agility-lap', owner: false, retired: true, label: '66-74 tick agility laps (RETIRED: measured rates used)' },
    { id: 'rival-stun-pack', owner: false, label: 'Stun pack: skill actions inside pickpocket stuns' },
    { id: 'rival-monkey-madness', owner: false, label: 'Monkey Madness before melee and thieving' },
    { id: 'rival-sea-slug', owner: false, label: 'Sea Slug for early Fishing' },
    // Retired: Cairn's order (research/community-and-upstream.md section 7) loses 628 ticks in our model.
    // Dragon Slayer replaces the Strength and Defence top-ups, but Hitpoints then needs Witch's House at the end.
    { id: 'rival-dragon-combat', owner: false, retired: true, label: 'Dragon Slayer before the melee top-ups, Doric for the 32 QP (RETIRED: loses ticks in the model)' },
    { id: 'pvp-relog-combat', owner: false, label: '1-tick PvP relog combat at Deserted Keep (Attack, Strength, Defence, Ranged 1->99), free Hitpoints side XP, zero pre-Overall combat/Cannon quests, standalone Thieving' },
];
export const SCENARIOS: { id: string; label: string; tricks: Trick[] }[] = [
    { id: 'a', label: 'All server mechanics (default)', tricks: TRICKS },
    { id: 'b', label: 'With login wine', tricks: ['loginWine'] },
    { id: 'c', label: 'All tricks optional (login wine, stun relog, sacred oil)', tricks: TRICKS },
];

const RETIRED_LEVERS = new Set(LEVERS.filter(l => l.retired).map(l => l.id));

// A retired lever was measured and loses ticks; it stays off unless named in opts.owner (to show its size).
const isOn = (id: string, _owner: boolean | undefined, opts: Pick<ScheduleOptions, 'disable' | 'owner'>) =>
    RETIRED_LEVERS.has(id) ? (opts.owner?.has(id) ?? false) : !(opts.disable?.has(id) ?? false);

function leverOn(a: Activity, opts: Pick<ScheduleOptions, 'disable' | 'owner'>): boolean {
    if (!a.lever) return true;
    const on = isOn(a.lever.id, a.lever.owner, opts);
    return a.lever.role === 'add' ? on : !on;
}

// The activity table with the levers of `opts` applied: rows filtered, patches merged.
// Missing supplies create procurement work. Historical OUT metadata cannot disable rows or their patches.
export function applyLevers(activities: Activity[], opts: Pick<ScheduleOptions, 'disable' | 'owner' | 'includeOut'>): Activity[] {
    return activities.filter(a => leverOn(a, opts)).map(a => {
        let out = a;
        for (const p of a.patches ?? []) {
            if (!isOn(p.lever, p.owner, opts)) continue;
            out = { ...out, ...(p.set ?? {}) };
            if (p.addRequires) out = { ...out, requires: [...(out.requires ?? []), ...p.addRequires] };
            if (p.addSide && out.train) out = { ...out, train: { ...out.train, side: { ...(out.train.side ?? {}), ...p.addSide } } };
        }
        return out;
    });
}

export function pick(r: Range, mode: Mode): number { return mode === 'floor' ? r.floor : r.realistic; }

export function speed(a: Activity, opts: ScheduleOptions): number {
    return a.trickSpeedup && opts.tricks.has(a.trickSpeedup.trick) ? a.trickSpeedup.factor : 1;
}

export function roughTicks(a: Activity, opts: ScheduleOptions): number {
    let t = a.ticks ? pick(a.ticks, opts.mode) : 0;
    if (a.train) t += Math.ceil(xpForLevel(a.train.toLevel) / pick(a.train.xpPerTick, opts.mode));
    return t * speed(a, opts) + (a.background ? pick(a.background, opts.mode) : 0);
}

// Eligible options per variant group after the levers, the tricks and opts.force, in table order.
export function variantGroups(activities: Activity[], opts: ScheduleOptions): Map<string, Map<string, Activity[]>> {
    const groups = new Map<string, Map<string, Activity[]>>();
    for (const a of activities) {
        if (!a.variant) continue;
        if (a.variant.trick && !opts.tricks.has(a.variant.trick)) continue;
        const forced = opts.force?.[a.variant.group];
        if (forced !== undefined && forced !== a.variant.option) continue;
        let g = groups.get(a.variant.group);
        if (!g) { g = new Map<string, Activity[]>(); groups.set(a.variant.group, g); }
        let list = g.get(a.variant.option);
        if (!list) { list = []; g.set(a.variant.option, list); }
        list.push(a);
    }
    return groups;
}

// Raw-tick choice: per group the eligible option with the fewest total ticks (train activities count by their full
// 1->target cost at the given rate). This ignores side XP and order, so it can pick a route with a later Overall.
export function rawRoute(groups: Map<string, Map<string, Activity[]>>, opts: ScheduleOptions): Record<string, string> {
    const route: Record<string, string> = {};
    for (const [group, options] of groups) {
        let bestCost = Infinity;
        for (const [option, acts] of options) {
            const cost = acts.reduce((s, a) => s + roughTicks(a, opts), 0);
            if (cost < bestCost) { bestCost = cost; route[group] = option; }
        }
    }
    return route;
}

// Pick one option per variant group: opts.force where given, else the raw-tick choice.
export function chooseVariants(activities: Activity[], opts: ScheduleOptions, leversAlreadyApplied = false): Activity[] {
    if (!leversAlreadyApplied) activities = applyLevers(activities, opts);
    const groups = variantGroups(activities, opts);
    const route = rawRoute(groups, opts);
    return activities.filter(a => !a.variant || route[a.variant.group] === a.variant.option);
}
