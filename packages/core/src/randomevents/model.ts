import type { Session } from '../inprocess';
import type { LootRules, LootTables } from '../loot';

// Hostile events attack in OPPLAYER2 mode. The engine drops the target when the player is more than
// maxrange + 1 tiles (Chebyshev) from the NPC's SPAWN tile (Npc.ts targetWithinMaxRange, op branch), the NPC
// goes back to WANDER (no hunt mode, so it never re-targets), and its ai_timer deletes it.
export const HOSTILE: { name: string; lo: number; hi: number; range: number }[] = [
    { name: 'dryad', lo: 438, hi: 443, range: 5 },
    { name: 'river_troll', lo: 391, hi: 396, range: 5 },
    { name: 'rock_golem', lo: 413, hi: 418, range: 5 },
    { name: 'zombie', lo: 419, hi: 424, range: 5 },
    { name: 'shade', lo: 425, hi: 430, range: 3 },
    { name: 'watchman', lo: 431, hi: 436, range: 5 },
    { name: 'swarm', lo: 411, hi: 411, range: 15 },
    { name: 'triffid', lo: 408, hi: 408, range: 3 },
];

// Talk-to events: ignored, the genie and the old man teleport the player at the 4th 20-tick timer; the dwarf
// turns hostile at his 5th 10-tick timer with maxrange 10000 (no escape on foot).
export const FRIENDLY: Record<number, string> = { 409: 'genie', 410: 'old_man', 956: 'drunken_dwarf' };
export const TRIFFID_SEED = 407;
export const ENT = { lo: 444, hi: 452 };
export const WHIRLPOOL = { lo: 403, hi: 406 };
export const BIG_FISH = 390;
export const MIME_NPC = 1056;
export const GAS_ROCK = { lo: 2119, hi: 2140 };
export const GAS_CHEST = 2141;
export const MAZE_STATUE = 3634;
export const AXE_HANDLE = 492;
export const PICK_HANDLE = 466;
export const AXE_HEADS = [508, 510, 512, 514, 516, 518, 520];
export const PICK_HEADS = [480, 482, 484, 486, 488, 490];
export const FISH_TOOLS = [301, 303, 305, 307, 309, 311]; // lobster pot, net, big net, rod, fly rod, harpoon
export const CUBE = 3062;
export const LAMP = 2528;
export const TRIFFID_FRUIT = 464;
// macro_cube interface: models (if_setobject), question, three answer buttons.
export const CUBE_IF = { root: 6554, models: [6555, 6557, 6559], question: 6561, buttons: [6562, 6563, 6564] };
// Cube part objs 3063..3091 step 2: shape-major, colour-minor (macro_cube_<colour><shape>).
export const CUBE_SHAPES = ['triangle', 'square', 'circle', 'star', 'halfmoon'];
export const CUBE_COLOURS = ['red', 'blue', 'yellow'];
// xplamp interface: one button per skill, then confirm.
export const LAMP_IF = 2808;
export const LAMP_SKILLS = ['attack', 'strength', 'ranged', 'magic', 'defence', 'hitpoints', 'prayer', 'agility', 'herblore', 'thieving',
    'crafting', 'runecraft', 'mining', 'smithing', 'fishing', 'cooking', 'firemaking', 'woodcutting', 'fletching'];
export const LAMP_FIRST = 2812;
export const LAMP_CONFIRM = 2831;
// Mime: the emote seq the mime plays, in the order of the macro_mime_emotes buttons com_2..com_9.
export const MIME_ANIMS = [860, 857, 861, 866, 1130, 1129, 1128, 1131];
export const MIME_FIRST_BUTTON = 6546;
export const EMOTE_BOW = 858;
export const MIME_REGION = { x0: 1984, x1: 2047, z0: 4736, z1: 4799 };
export const MAZE_REGION = { x0: 2880, x1: 2943, z0: 4544, z1: 4607 };
export const JUNK = /^(logs|(oak|willow|maple|yew|magic) logs|(copper|tin|iron|silver|gold|mithril|adamantite|runite) ore|coal|clay|raw .+|uncut .+)$/i;

export const PF_RETRY_MS = 60_000;
export const HOLD_LIMIT = 50;
export const FLEE_RANGE = 8;
export const REFUSE_LIMIT = 3;
export const SCRIPT_LOOT_TICKS = 20;
export const LOOT_TICKS = 25;
export const RETURN_TICKS = 15;
export const SKIP_RISK = 10;
export const SKIP_DONE = 100;
export const DESTROY = /^(drop|destroy)$/i;
export const SUSTAIN = /^(eat|drink)$/i;
export const EAT = /^eat$/i;

export interface IfReader {
    text(com: number): string | undefined;
    obj(com: number): number | undefined;
}

export interface PathFinder {
    findLongPath(level: number, sx: number, sz: number, dx: number, dz: number, max?: number, blocked?: Iterable<any>): { x: number; z: number; level: number }[];
    getDoorAt(level: number, x: number, z: number): any;
}

export interface RandomEventOptions {
    // undefined: load the in-process client's IfType and the rsmod pathfinder lazily; null: run without them.
    ifReader?: IfReader | null;
    pf?: PathFinder | null;
    // How the route finder loads when `pf` is undefined (a test gives its own); the default loads it through pathcache.ts.
    loadPf?: () => Promise<PathFinder>;
    gate?: boolean;
    lampSkill?: string;
    // NPC type id -> danger radius in tiles; undefined: read the server's hunt configs once; null: none.
    danger?: Map<number, number> | null;
    log?: (line: string) => void;
    // False: no random-event handling; the gate and the loot job still run. Default true.
    events?: boolean;
    // Ground-item pickup (loot.ts). Null or undefined: off.
    loot?: LootWatchOptions | null;
    // The value guard: the gate refuses a drop, sale, spell or Drop option on a held stack worth minValue or more.
    guard?: { tables: LootTables; minValue: number } | null;
    // The flee guard: at `hp` or less of the maximum Hitpoints, with no food in the pack, the player runs out of the
    // reach of the NPC that attacks it and stays held; `onSafe` then ends the session. Null or undefined: off.
    flee?: { hp: number; onSafe(detail: string): void } | null;
}

export interface LootWatchOptions {
    tables: LootTables;
    // The account: the claim of a pile carries it.
    name: string;
    // Lower-case names of our own accounts: no threat in the Wilderness.
    friends?: ReadonlySet<string>;
    rules?: LootRules;
    // Item id -> count the script holds back (quest items): never dropped for room.
    reserved?: () => Readonly<Record<number, number>>;
}

export interface RandomEventWatch {
    stop(): void;
    counts(): Record<string, number>;
    busy(): boolean;
    // Item id -> count the loot job picked up and the pack still holds. The gate keeps these from a drop or a sale.
    kept(): Map<number, number>;
    // Runs `work` with the player held from the script (death recovery): the gate passes the actions that `work`
    // sends and the eat, drink and prayer inputs of the guards, and holds every other action; no event or loot job
    // starts until `work` ends.
    exclusive<T>(work: () => Promise<T>): Promise<T>;
    // The type of the last action the script sent through the gate (prayer flicks not counted), for the ledger's
    // idle reasons (ledger.ts idleWhy). Null before the first one.
    lastAction(): string | null;
    // Event NPC indices and loc tiles ("x,z") a script must not click (whirlpool, ent, gas rock, gas chest).
    avoid(): { npcs: Set<number>; locs: Set<string> };
}

export type Act = { type: string; [k: string]: unknown };
export type Job = { name: string; tick(): boolean | void; started: number; hold: boolean };
export type JobSpec = Omit<Job, 'started'>;
export type Tile = { x: number; z: number };
export type TileLevel = { x: number; z: number; level: number };
export type HostileTrack = {
    name: string;
    id: number;
    range: number;
    spawn: Tile;
    seen: number;
    lastSeen: number;
    ours: boolean | null;
    pre: boolean;
    done: boolean;
};
export type FriendTrack = { name: string; id: number; seen: number; lastSeen: number; ours: boolean | null };
export type SeedTrack = { seen: number; lastSeen: number; mine: boolean };

/** Shared per-watcher runtime context passed into solver and scanner submodules. */
export interface WatcherContext {
    session: Session;
    state(): any;
    tick(): number;
    log(line: string): void;
    say(name: string, action: string, extra?: string): void;
    send(a: Act): void;
    canSend(): boolean;
    getPf(): PathFinder | null;
    getIfReader(): IfReader | null;
    danger(): Map<number, number>;
    newMessages: { any(re: RegExp): boolean };
    jobs: Map<string, Job>;
    hasActiveJob(): boolean;
    want(key: string, job: JobSpec): void;
    clearJob(key: string): void;
    hostiles: Map<number, HostileTrack>;
    friends: Map<number, FriendTrack>;
    seeds: Map<number, SeedTrack>;
    handledNpc: Set<number>;
    avoidNpcs: Set<number>;
    avoidLocs: Set<string>;
    kept: Map<number, number>;
    refusals: Map<number, { n: number; at: number }>;
    ownDrops: Map<string, number>;
    scriptToolDrops: Map<number, { at: number; left: number }>;
    scriptPickupAt(): number;
    lampSkill: string;
    xpStart: Map<string, number>;
    fleetNames: ReadonlySet<string>;
}

export const inRange = (id: number, r: { lo: number; hi: number }) => id >= r.lo && id <= r.hi;
export const cheb = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
export const inRegion = (p: Tile, r: { x0: number; x1: number; z0: number; z1: number }) => p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1;
export const tileOf = (n: any): Tile => ({ x: n.tileX ?? n.x, z: n.tileZ ?? n.z });

/** The OP-mode target check (Npc.ts targetWithinMaxRange): the target is lost past maxrange + 1, or on the corner. */
export function outOfReach(player: Tile, spawn: Tile, range: number): boolean {
    const dx = Math.abs(player.x - spawn.x), dz = Math.abs(player.z - spawn.z);
    return Math.max(dx, dz) > range + 1 || (dx === range + 1 && dz === range + 1);
}

export const meOf = (st: any): TileLevel | null =>
    st?.player ? { x: st.player.worldX as number, z: st.player.worldZ as number, level: st.player.level as number } : null;
export const invOf = (st: any): any[] => st?.inventory ?? [];
export const eqOf = (st: any): any[] => st?.equipment ?? [];
export const freeSlots = (st: any) => 28 - invOf(st).length;
export const countOf = (pack: readonly any[], id: number) => pack.reduce((n, i) => (i.id === id ? n + (i.count ?? 1) : n), 0);
export const optIndex = (opts: any[] | undefined, re: RegExp, dflt: number) => opts?.find((o: any) => re.test(o.text))?.opIndex ?? dflt;

export const otherNear = (st: any, t: Tile, r: number) => (st?.nearbyPlayers ?? []).some((p: any) => cheb(p, t) <= r);
export const targetsMe = (st: any, n: any) =>
    n.targetIndex >= 32768 && !(st?.nearbyPlayers ?? []).some((p: any) => p.index === n.targetIndex - 32768);

/** Click through single-option "Click here to continue" dialogs without touching multi-option choices. */
export function continueDialog(st: any, canSend: () => boolean, send: (a: Act) => void): void {
    const d = st?.dialog;
    if (!d?.isOpen || !canSend() || (d.options?.length ?? 0) !== 1) return;
    send({ type: 'clickDialogOption', optionIndex: d.options[0].index ?? 0 });
}
