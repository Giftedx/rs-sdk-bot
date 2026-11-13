// Random event handler for every bot (research/random-events.md has the server facts behind each rule).
// watchRandomEvents(s) checks every tick, handles each event with the cheapest response that never causes a
// fail teleport, and prints `EVENT <name> <action> t=<tick>`. While it handles an event that needs the player
// (flee, talk, pick up, solve), busy() is true and the gate holds the script's actions until it is done.
// With `loot` set, the same watcher picks up a valuable ground item near the player (rules in loot.ts), keeps it
// from the script's drops and sales, and puts it in the bank when the script next opens one: `EVENT loot <action>`.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from './inprocess';
import { claimPile, LOOT_RULES, lootRisk, lootRoom, pileKey, pileValue, releasePile, unitValue, worthIt, type Ground, type LootRules, type LootTables } from './loot';

// ---- Server ids (vendor/rs-sdk/server/content/pack/{npc,obj,loc,seq,interface}.pack) ----

// Hostile events attack in OPPLAYER2 mode. The engine drops the target when the player is more than
// maxrange + 1 tiles (Chebyshev) from the NPC's SPAWN tile (Npc.ts targetWithinMaxRange, op branch), the NPC
// goes back to WANDER (no hunt mode, so it never re-targets), and its ai_timer deletes it.
const HOSTILE: { name: string; lo: number; hi: number; range: number }[] = [
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
const FRIENDLY: Record<number, string> = { 409: 'genie', 410: 'old_man', 956: 'drunken_dwarf' };
const TRIFFID_SEED = 407;
const ENT = { lo: 444, hi: 452 };
const WHIRLPOOL = { lo: 403, hi: 406 };
const BIG_FISH = 390;
const MIME_NPC = 1056;
const GAS_ROCK = { lo: 2119, hi: 2140 };
const GAS_CHEST = 2141;
const MAZE_STATUE = 3634;
const AXE_HANDLE = 492;
const PICK_HANDLE = 466;
const AXE_HEADS = [508, 510, 512, 514, 516, 518, 520];
const PICK_HEADS = [480, 482, 484, 486, 488, 490];
const FISH_TOOLS = [301, 303, 305, 307, 309, 311]; // lobster pot, net, big net, rod, fly rod, harpoon
const CUBE = 3062;
const LAMP = 2528;
const TRIFFID_FRUIT = 464;
// macro_cube interface: models (if_setobject), question, three answer buttons.
const CUBE_IF = { root: 6554, models: [6555, 6557, 6559], question: 6561, buttons: [6562, 6563, 6564] };
// Cube part objs 3063..3091 step 2: shape-major, colour-minor (macro_cube_<colour><shape>).
const CUBE_SHAPES = ['triangle', 'square', 'circle', 'star', 'halfmoon'];
const CUBE_COLOURS = ['red', 'blue', 'yellow'];
// xplamp interface: one button per skill, then confirm.
const LAMP_IF = 2808;
const LAMP_SKILLS = ['attack', 'strength', 'ranged', 'magic', 'defence', 'hitpoints', 'prayer', 'agility', 'herblore', 'thieving',
    'crafting', 'runecraft', 'mining', 'smithing', 'fishing', 'cooking', 'firemaking', 'woodcutting', 'fletching'];
const LAMP_FIRST = 2812;
const LAMP_CONFIRM = 2831;
// Mime: the emote seq the mime plays, in the order of the macro_mime_emotes buttons com_2..com_9.
const MIME_ANIMS = [860, 857, 861, 866, 1130, 1129, 1128, 1131];
const MIME_FIRST_BUTTON = 6546;
const EMOTE_BOW = 858;
const MIME_REGION = { x0: 1984, x1: 2047, z0: 4736, z1: 4799 };
const MAZE_REGION = { x0: 2880, x1: 2943, z0: 4544, z1: 4607 };
const JUNK = /^(logs|(oak|willow|maple|yew|magic) logs|(copper|tin|iron|silver|gold|mithril|adamantite|runite) ore|coal|clay|raw .+|uncut .+)$/i;

const inRange = (id: number, r: { lo: number; hi: number }) => id >= r.lo && id <= r.hi;
const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const inRegion = (p: { x: number; z: number }, r: { x0: number; x1: number; z0: number; z1: number }) => p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1;
const tileOf = (n: any) => ({ x: n.tileX ?? n.x, z: n.tileZ ?? n.z });

// The OP-mode target check (Npc.ts targetWithinMaxRange): the target is lost when the player is past
// maxrange + 1 on either axis, or exactly on the maxrange + 1 corner.
export function outOfReach(player: { x: number; z: number }, spawn: { x: number; z: number }, range: number): boolean {
    const dx = Math.abs(player.x - spawn.x), dz = Math.abs(player.z - spawn.z);
    return Math.max(dx, dz) > range + 1 || (dx === range + 1 && dz === range + 1);
}

// Cube solver: question text + the obj id set on the centre, side and top model components.
// Returns the 0-based answer button, or -1 when the data does not decide it.
export function solveCube(question: string, objs: (number | undefined)[]): number {
    const parts = objs.map(o => {
        if (o === undefined || o < 3063 || o > 3091 || (o - 3063) % 2 !== 0) return null;
        const i = (o - 3063) / 2;
        return { shape: CUBE_SHAPES[Math.floor(i / 3)]!, colour: CUBE_COLOURS[i % 3]! };
    });
    const colourQ = question.match(/what colour is the (\w+)/i);
    if (colourQ) return parts.findIndex(p => p?.shape === colourQ[1]!.toLowerCase());
    const shapeQ = question.match(/which shape is (\w+)/i);
    if (shapeQ) return parts.findIndex(p => p?.colour === shapeQ[1]!.toLowerCase());
    return -1;
}

export interface IfReader { text(com: number): string | undefined; obj(com: number): number | undefined }
export interface PathFinder {
    findLongPath(level: number, sx: number, sz: number, dx: number, dz: number, max?: number, blocked?: Iterable<any>): { x: number; z: number; level: number }[];
    getDoorAt(level: number, x: number, z: number): any;
}
export interface RandomEventOptions {
    // undefined: load the in-process client's IfType and the rsmod pathfinder lazily; null: run without them.
    ifReader?: IfReader | null;
    pf?: PathFinder | null;
    gate?: boolean;
    lampSkill?: string;
    // NPC type id -> danger radius in tiles; undefined: read the server's hunt configs once; null: none.
    danger?: Map<number, number> | null;
    log?: (line: string) => void;
    // False: no random-event handling; the gate and the loot job still run. Default true.
    events?: boolean;
    // Ground-item pickup (loot.ts). Null or undefined: off.
    loot?: LootWatchOptions | null;
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
    // Event NPC indices and loc tiles ("x,z") a script must not click (whirlpool, ent, gas rock, gas chest).
    avoid(): { npcs: Set<number>; locs: Set<string> };
}

type Act = { type: string; [k: string]: unknown };
type Job = { name: string; tick(): boolean | void; started: number; hold: boolean };

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const vendor = (p: string) => join(repoRoot, 'vendor', 'rs-sdk', p);

// Tiles of the maze's permanent walls (loc 3626 in maps/m45_71.jm2, LOC lines "level x z: id shape angle").
// Also the loc id of every maze door (3628-3632), keyed "x,z".
let mazeWallCache: [number, number][] | null = null;
const mazeDoorIds = new Map<string, number>();
export function mazeWalls(): [number, number][] {
    if (mazeWallCache) return mazeWallCache;
    const out: [number, number][] = [];
    try {
        const text = readFileSync(vendor('server/content/maps/m45_71.jm2'), 'utf8');
        const loc = text.slice(text.indexOf('==== LOC ===='));
        for (const m of loc.matchAll(/^0 (\d+) (\d+): (36\d\d) /gm)) {
            const x = 2880 + Number(m[1]), z = 4544 + Number(m[2]), id = Number(m[3]);
            if (id === 3626) out.push([x, z]);
            else if (id >= 3628 && id <= 3632) mazeDoorIds.set(`${x},${z}`, id);
        }
    } catch { /* no content checkout */ }
    mazeWallCache = out;
    return out;
}
export const mazeDoorId = (x: number, z: number): number | undefined => { mazeWalls(); return mazeDoorIds.get(`${x},${z}`); };

// NPC types that hunt players (huntmode aggressive_*, cowardly, ranged in the server's .npc configs; the same
// rule as research/route-danger.ts). Radius: huntrange + 3, at least 10 for ranged hunters.
let dangerCache: Map<number, number> | null = null;
export function loadDanger(): Map<number, number> {
    if (dangerCache) return dangerCache;
    const out = new Map<number, number>();
    try {
        const ids = new Map<string, number>();
        for (const line of readFileSync(vendor('server/content/pack/npc.pack'), 'utf8').split(/\r?\n/)) {
            const m = line.match(/^(\d+)=(\S+)$/); if (m) ids.set(m[2]!, Number(m[1]));
        }
        const dir = vendor('server/content/scripts');
        const files = (readdirSync(dir, { recursive: true }) as string[]).filter(f => f.endsWith('.npc') && !f.includes('macro events'));
        for (const f of files) {
            let cur = '', mode = '', range = 0;
            const done = () => {
                const id = ids.get(cur);
                if (id !== undefined && /^(aggressive|aa_aggressive|cowardly|ranged)/.test(mode)) out.set(id, Math.max(out.get(id) ?? 0, /ranged/.test(mode) ? Math.max(10, range + 3) : (range || 1) + 3));
            };
            for (const line of readFileSync(join(dir, f), 'utf8').split(/\r?\n/)) {
                const h = line.match(/^\[([^\]]+)\]/);
                if (h) { done(); cur = h[1]!; mode = ''; range = 0; continue; }
                const m = line.match(/^huntmode=(\S+)/); if (m) mode = m[1]!;
                const r = line.match(/^huntrange=(\d+)/); if (r) range = Number(r[1]);
            }
            done();
        }
    } catch { /* no content checkout: no danger data */ }
    dangerCache = out;
    return out;
}

export function watchRandomEvents(s: Session, opts: RandomEventOptions = {}): RandomEventWatch {
    const log = opts.log ?? ((l: string) => console.log(l));
    const gateOn = opts.gate ?? process.env.RANDOM_EVENTS_GATE !== '0';
    const eventsOn = opts.events ?? true;
    const lampSkill = (opts.lampSkill ?? process.env.RANDOM_EVENTS_LAMP ?? 'auto').toLowerCase();
    const counts: Record<string, number> = {};
    const noDanger = new Map<number, number>();
    const danger = () => opts.danger ?? (opts.danger === null ? noDanger : loadDanger());
    const say = (name: string, action: string, extra = '') => {
        const k = `${name}:${action}`;
        counts[k] = (counts[k] ?? 0) + 1;
        log(`EVENT ${name} ${action} t=${s.tick()}${extra ? ` ${extra}` : ''}`);
    };

    let ifReader: IfReader | null = opts.ifReader ?? null;
    let pf: PathFinder | null = opts.pf ?? null;
    if (opts.ifReader === undefined) {
        void import(vendor('server/webclient/src/config/IfType.ts')).then((m: any) => {
            const list = m.default?.list as any[] | undefined;
            if (list) ifReader = {
                text: c => list[c]?.text ?? undefined,
                obj: c => (list[c]?.model1Type === 4 ? list[c].model1Id : undefined),
            };
        }).catch(() => {});
    }
    if (opts.pf === undefined) {
        void import('./pathcache').then(m => m.loadPathfinding()).then(() => import(vendor('sdk/pathfinding.ts'))).then((m: any) => { pf = m; }).catch(() => {});
    }

    // ---- the gate: the script's actions wait while a job holds the player ----
    const rawDirect = s.direct.bind(s);
    const sdkAny = s.sdk as any;
    const rawSend = typeof sdkAny.send === 'function' ? sdkAny.send : null;
    const held: { at: number; run: () => void; fail: () => void }[] = [];
    const avoidNpcs = new Set<number>();
    const avoidLocs = new Set<string>();
    const fail = (msg: string, reason = 'random_event') => ({ success: false, message: msg, reason });
    const avoided = (a: any) => (a?.type === 'interactNpc' && avoidNpcs.has(a.npcIndex)) || (a?.type === 'interactLoc' && avoidLocs.has(`${a.x},${a.z}`));
    // A queued SDK action is answered the way the shim answers it, so the script's await resolves.
    const answer = (msg: any, result: object) => sdkAny.handleMessage?.(JSON.stringify({ type: 'sdk_action_result', actionId: msg.actionId, result }));
    // An answer one tick later: a script that sends the refused action again in a loop sends it once a tick.
    const later = (r: (v: any) => void, v: object) => { const off = s.onTick(() => { off(); r(v); }); };

    // ---- loot: the keep list and what the script does with ground items ----
    const loot = opts.loot ?? null;
    const rules = loot?.rules ?? LOOT_RULES;
    const fleetNames = loot?.friends ?? new Set<string>();
    const kept = new Map<number, number>();
    let scriptPickupAt = -99;
    // Piles the script dropped, `x,z,id` -> tick: the loot job never picks those up again.
    const ownDrops = new Map<string, number>();
    const refusals = new Map<number, { n: number; at: number }>();
    const packNow = (): any[] => s.sdk.getState()?.inventory ?? [];
    const countOf = (pack: readonly any[], id: number) => pack.reduce((n, i) => (i.id === id ? n + (i.count ?? 1) : n), 0);
    const noteScript = (a: any) => {
        if (!loot || !a) return;
        if (a.type === 'pickupItem' || a.type === 'interactGroundItem' || a.type === 'spellOnGroundItem') scriptPickupAt = s.tick();
        if (a.type === 'dropItem') {
            const i = packNow().find(x => x.slot === a.slot), q = s.sdk.getState()?.player;
            if (i && q) ownDrops.set(`${q.worldX},${q.worldZ},${i.id}`, s.tick());
        }
    };
    // The gate refuses a drop, a sale, a spell or a Drop/Destroy option on an item the loot job keeps, while the
    // pack would then hold less than the kept count. After REFUSE_LIMIT refusals of one item (on different ticks)
    // the script wins: the item leaves the keep list, so a script that must empty its pack never stalls.
    const REFUSE_LIMIT = 3;
    const DESTROY = /^(drop|destroy)$/i;
    const keptRefusal = (a: any): string | null => {
        if (!loot || kept.size === 0 || !a) return null;
        const pack = packNow();
        let slot: number | undefined;
        if (a.type === 'dropItem' || a.type === 'shopSell' || a.type === 'spellOnItem') slot = a.slot;
        else if (a.type === 'useInventoryItem') {
            const i = pack.find(x => x.slot === a.slot);
            if ((i?.optionsWithIndex ?? []).some((o: any) => o.opIndex === a.optionIndex && DESTROY.test(o.text ?? ''))) slot = a.slot;
        }
        const item = slot === undefined ? undefined : pack.find(i => i.slot === slot);
        const keep = item ? kept.get(item.id) ?? 0 : 0;
        if (!item || keep <= 0) return null;
        const leaves = a.type === 'shopSell' ? Math.min(a.amount ?? 1, item.count ?? 1) : item.count ?? 1;
        if (countOf(pack, item.id) - leaves >= keep) return null;
        const r = refusals.get(item.id) ?? { n: 0, at: -1 };
        if (r.at !== s.tick()) { r.n++; r.at = s.tick(); refusals.set(item.id, r); say('loot', 'refused', `${a.type} id=${item.id} n=${r.n}`); }
        if (r.n > REFUSE_LIMIT) { kept.delete(item.id); refusals.delete(item.id); say('loot', 'released', `id=${item.id}`); return null; }
        return 'loot: the item is kept until a bank';
    };

    if (gateOn) {
        s.direct = (a: Act) => {
            noteScript(a);
            if (avoided(a)) return new Promise(r => later(r, fail('random event: target avoided')));
            const no = keptRefusal(a);
            if (no) return new Promise(r => later(r, fail(no, 'loot_kept')));
            if (!holding()) return rawDirect(a);
            return new Promise(r => held.push({ at: s.tick(), run: () => { const n = keptRefusal(a); n ? r(fail(n, 'loot_kept')) : r(rawDirect(a)); }, fail: () => r(fail('random event in progress')) }));
        };
        if (rawSend) sdkAny.send = (msg: any) => {
            if (msg?.type === 'sdk_action') {
                noteScript(msg.action);
                if (avoided(msg.action)) { later(() => answer(msg, fail('random event: target avoided')), {}); return; }
                const no = keptRefusal(msg.action);
                if (no) { later(() => answer(msg, fail(no, 'loot_kept')), {}); return; }
                if (holding()) {
                    held.push({ at: s.tick(), run: () => { const n = keptRefusal(msg.action); n ? answer(msg, fail(n, 'loot_kept')) : rawSend.call(sdkAny, msg); },
                        fail: () => answer(msg, fail('random event in progress')) });
                    return;
                }
            }
            return rawSend.call(sdkAny, msg);
        };
    }
    const flush = () => { for (const h of held.splice(0)) h.run(); };

    // Handler actions: at most one per tick, straight to the client.
    let lastSendTick = -1;
    const send = (a: Act) => {
        lastSendTick = s.tick();
        void rawDirect({ reason: 'random-event', ...a }).then((r: any) => {
            if (r && r.success === false) log(`EVENT ${active?.name ?? 'watcher'} send-failed t=${s.tick()} ${a.type}: ${r.message ?? ''}`);
        }, () => {});
    };
    const canSend = () => lastSendTick !== s.tick();

    // ---- per-tick helpers ----
    let st: any = null;
    const me = () => st?.player ? { x: st.player.worldX as number, z: st.player.worldZ as number, level: st.player.level as number } : null;
    const inv = (): any[] => st?.inventory ?? [];
    const eq = (): any[] => st?.equipment ?? [];
    const otherPlayers = () => new Set<number>((st?.nearbyPlayers ?? []).map((p: any) => p.index));
    const otherNear = (t: { x: number; z: number }, r: number) => (st?.nearbyPlayers ?? []).some((p: any) => cheb(p, t) <= r);
    const targetsMe = (n: any) => n.targetIndex >= 32768 && !otherPlayers().has(n.targetIndex - 32768);
    const newMessages = (() => {
        let seen = Math.max(-1, ...(s.sdk.getState()?.gameMessages ?? []).map((m: any) => m.tick ?? -1));
        let fresh: any[] = [];
        return {
            update() { const ms = st?.gameMessages ?? []; fresh = ms.filter((m: any) => (m.tick ?? -1) > seen); seen = Math.max(seen, ...ms.map((m: any) => m.tick ?? -1)); },
            any: (re: RegExp) => fresh.some(m => re.test(m.text ?? '')),
        };
    })();
    const freeSlots = () => 28 - inv().length;
    const optIndex = (opts: any[] | undefined, re: RegExp, dflt: number) => opts?.find((o: any) => re.test(o.text))?.opIndex ?? dflt;
    const pathLen = (from: { x: number; z: number; level: number }, to: { x: number; z: number }): number | null => {
        if (!pf) return cheb(from, to);
        const pts = pf.findLongPath(from.level, from.x, from.z, to.x, to.z, 200, []);
        if (pts.length === 0) return cheb(from, to) === 0 ? 0 : null;
        const last = pts[pts.length - 1]!;
        if (last.x !== to.x || last.z !== to.z) return null;
        let len = 0, prev = from as { x: number; z: number };
        for (const q of pts) { len += cheb(prev, q); prev = q; }
        return len;
    };
    // "Click here to continue" carries a server index (1, not 0: sdk/actions.ts dismissBlockingUI). A dialog with
    // several options is a choice, not ours to answer.
    const continueDialog = () => {
        const d = st?.dialog;
        if (!d?.isOpen || !canSend() || (d.options?.length ?? 0) !== 1) return;
        send({ type: 'clickDialogOption', optionIndex: d.options[0].index ?? 0 });
    };

    // ---- jobs: one controls the player at a time; hostile flight comes first ----
    const jobs = new Map<string, Job>();
    let active: Job | null = null;
    const holding = () => !!active?.hold;
    const want = (key: string, job: Omit<Job, 'started'>) => { if (!jobs.has(key)) jobs.set(key, { ...job, started: s.tick() }); };

    // Hostile NPC memory, by NPC index.
    const hostiles = new Map<number, { name: string; id: number; range: number; spawn: { x: number; z: number }; seen: number; lastSeen: number; ours: boolean | null; pre: boolean; done: boolean }>();
    const friends = new Map<number, { name: string; id: number; seen: number; lastSeen: number; ours: boolean | null }>();
    const seeds = new Map<number, { seen: number; lastSeen: number; mine: boolean }>();
    const handledNpc = new Set<number>();

    const fleeJob = (idx: number): Omit<Job, 'started'> => {
        let dest: { x: number; z: number } | null = null;
        let sentAt = -99;
        let lastPos = '';
        let awaySince = -1;
        let backSince = -1;
        const begin = s.tick();
        const p0 = me();
        const origin = p0 ? { x: p0.x, z: p0.z } : null;
        return {
            name: 'flee', hold: true,
            tick() {
                const h = hostiles.get(idx);
                const p = me();
                if (!h || !p) return true;
                const npc = (st?.nearbyNpcs ?? []).find((n: any) => n.index === idx);
                const away = outOfReach(p, h.spawn, h.range);
                const engaged = npc ? targetsMe(npc) : false;
                // Phase 2: the NPC dropped the target; walk back to where the flight began (the NPC wanders near
                // its spawn and never takes the target again), so the script resumes where it was and the bot
                // does not stand at a strange tile (seen: a swarm flight ended next to dark wizards).
                if (backSince >= 0) {
                    if (engaged) { backSince = -1; dest = null; say(h.name, 'flee-again'); }
                    else {
                        if (!origin || cheb(p, origin) <= 1) { say(h.name, 'returned', `ticks=${s.tick() - begin}`); h.done = true; return true; }
                        if (s.tick() - backSince > 30) { say(h.name, 'return-timeout'); h.done = true; return true; }
                        if (canSend() && s.tick() - sentAt >= 4) { send({ type: 'walkTo', x: origin.x, z: origin.z, running: true }); sentAt = s.tick(); }
                        return false;
                    }
                }
                const escaped = (why: string) => { say(h.name, why, `ticks=${s.tick() - begin}`); backSince = s.tick(); sentAt = -99; return false; };
                if (s.tick() - begin > 90) { say(h.name, 'flee-timeout'); h.done = true; return true; }
                if (away && !engaged && s.tick() - h.seen >= 4) return escaped('escaped');
                // Out of view: the NPC either lost us or we are far away. The client can hold our reported tile
                // still for 20+ ticks while an attack animation plays, so wait for a settled position first.
                if (!npc && s.tick() - h.lastSeen > 3 && (away || s.tick() - h.lastSeen > 15)) return escaped('gone');
                if (away) {
                    // Outside its reach: wait for the NPC to drop the target. Still chased after 6 ticks means the
                    // spawn tile was seen late (the NPC had moved): widen the ring and go on.
                    if (awaySince < 0) awaySince = s.tick();
                    if (!engaged || s.tick() - awaySince <= 6) return false;
                    h.range += 3; awaySince = -1; dest = null;
                    say(h.name, 'widen', `need=${h.range + 2}`);
                }
                awaySince = -1;
                const pos = `${p.x},${p.z}`;
                const stuck = pos === lastPos && s.tick() - sentAt >= 2;
                lastPos = pos;
                if (!dest || (dest && !outOfReach(dest, h.spawn, h.range))) dest = pickFleeTile(p, h.spawn, h.range, npc ? tileOf(npc) : h.spawn);
                if (dest && canSend() && (s.tick() - sentAt >= 3 || stuck || sentAt < begin)) { send({ type: 'walkTo', x: dest.x, z: dest.z, running: true }); if (sentAt < begin) log(`EVENT ${h.name} dest t=${s.tick()} to=${dest.x},${dest.z} from=${p.x},${p.z}`); sentAt = s.tick(); }
                return false;
            },
        };
    };

    // The nearest tile (by path) at Chebyshev distance range + 2 from the spawn, preferring tiles away from the NPC.
    const pickFleeTile = (p: { x: number; z: number; level: number }, spawn: { x: number; z: number }, range: number, npcAt: { x: number; z: number }) => {
        const d = range + 2;
        let best: { x: number; z: number; score: number } | null = null;
        for (let dx = -d; dx <= d; dx++) for (let dz = -d; dz <= d; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
            const t = { x: spawn.x + dx, z: spawn.z + dz };
            if (cheb(t, p) > d + 4) continue; // only the near side of the ring
            const len = pathLen(p, t);
            if (len === null) continue;
            // Keep away from NPCs that hunt players (aggressive, cowardly, ranged hunt modes).
            const risk = (st?.nearbyNpcs ?? []).some((n: any) => { const r = danger().get(n.id); return r !== undefined && cheb(tileOf(n), t) <= r; });
            const score = len * 10 - cheb(t, npcAt) + (risk ? 10000 : 0);
            if (!best || score < best.score) best = { ...t, score };
        }
        if (best) return { x: best.x, z: best.z };
        // No path data: straight away from the NPC.
        const sx = Math.sign(p.x - npcAt.x) || 1, sz = Math.sign(p.z - npcAt.z);
        return { x: spawn.x + sx * d, z: spawn.z + sz * d };
    };

    const talkJob = (idx: number): Omit<Job, 'started'> => {
        let talkedAt = -99, tries = 0, dialogSeen = false;
        return {
            name: 'talk', hold: true,
            tick() {
                const f = friends.get(idx);
                if (!f) return true;
                const npc = (st?.nearbyNpcs ?? []).find((n: any) => n.index === idx);
                if (st?.dialog?.isOpen) {
                    dialogSeen = true;
                    const text = `${st.dialog.text ?? ''} ${(st.dialog.allComponents ?? []).map((c: any) => c.text).join(' ')}`;
                    if (/trying to talk to|not my matey/i.test(text)) { f.ours = false; say(f.name, 'not-ours'); }
                    continueDialog();
                    return false;
                }
                if (!npc) { say(f.name, dialogSeen ? 'done' : 'gone'); return true; }
                if (f.ours === false) return true;
                if (dialogSeen && s.tick() - talkedAt > 2) { say(f.name, 'done'); return true; }
                if (canSend() && s.tick() - talkedAt >= 8) {
                    if (++tries > 4) { say(f.name, 'talk-failed'); return true; }
                    send({ type: 'interactNpc', npcIndex: idx, optionIndex: optIndex(npc.optionsWithIndex, /talk/i, 1) });
                    if (tries === 1) say(f.name, 'talk');
                    talkedAt = s.tick();
                }
                return false;
            },
        };
    };

    const seedJob = (idx: number): Omit<Job, 'started'> => {
        let at = -99, tries = 0;
        return {
            name: 'pick', hold: true,
            tick() {
                const sd = seeds.get(idx);
                const npc = (st?.nearbyNpcs ?? []).find((n: any) => n.index === idx && n.id === TRIFFID_SEED);
                if (!sd || !npc) { if (inv().some(i => i.id === TRIFFID_FRUIT)) say('triffid', 'picked'); return true; }
                if (newMessages.any(/not here for you/i)) { sd.mine = false; say('triffid', 'not-ours'); return true; }
                if (st?.dialog?.isOpen) { continueDialog(); return false; }
                if (newMessages.any(/isn't ready/i)) { at = s.tick(); return true; } // retried by the scan 4 ticks later
                if (canSend() && s.tick() - at >= 4) {
                    if (++tries > 5) return true;
                    send({ type: 'interactNpc', npcIndex: idx, optionIndex: optIndex(npc.optionsWithIndex, /pick/i, 1) });
                    if (tries === 1) say('triffid', 'pick');
                    at = s.tick();
                }
                return false;
            },
        };
    };

    // Lost axe / pickaxe: unequip the handle if worn, pick the head up, use one on the other, wield again.
    const lostToolJob = (kind: 'axe' | 'pickaxe'): Omit<Job, 'started'> => {
        const handle = kind === 'axe' ? AXE_HANDLE : PICK_HANDLE;
        const heads = kind === 'axe' ? AXE_HEADS : PICK_HEADS;
        const name = kind === 'axe' ? 'lost_axe' : 'lost_pickaxe';
        const wasWorn = eq().some(i => i?.id === handle);
        const begin = s.tick();
        let at = -99, kind0 = '', step = 'start', rewield = false;
        // A repeat of the same action waits `every` ticks; a new kind of action goes at once.
        const due = (k: string, every: number) => { if (k === kind0 && s.tick() - at < every) return false; kind0 = k; at = s.tick(); return true; };
        return {
            name, hold: true,
            tick() {
                if (st?.dialog?.isOpen) { continueDialog(); return false; }
                const worn = eq().find(i => i?.id === handle);
                const hInv = inv().find(i => i.id === handle);
                const head = inv().find(i => heads.includes(i.id));
                if (!worn && !hInv) {
                    // Fixed: the handle is gone. Wield the axe again if the handle was worn.
                    if (wasWorn && !rewield) {
                        const tool = inv().find(i => new RegExp(kind === 'axe' ? ' axe$' : ' pickaxe$', 'i').test(i.name) && i.optionsWithIndex?.some((o: any) => /wield/i.test(o.text)));
                        if (tool && canSend()) { send({ type: 'useInventoryItem', slot: tool.slot, optionIndex: optIndex(tool.optionsWithIndex, /wield/i, 2) }); rewield = true; return false; }
                    }
                    say(name, 'fixed', `ticks=${s.tick() - begin}`);
                    return true;
                }
                if (!canSend()) return false;
                if (head && hInv) {
                    if (due('join', 3)) { send({ type: 'useItemOnItem', sourceSlot: hInv.slot, targetSlot: head.slot }); if (step !== 'join') { step = 'join'; say(name, 'reattach'); } }
                    return false;
                }
                const need = (worn ? 1 : 0) + (head ? 0 : 1);
                if (freeSlots() < need) {
                    const junk = [...inv()].reverse().find(i => JUNK.test(i.name));
                    if (!junk) { if (step !== 'nospace') { step = 'nospace'; say(name, 'no-free-slot'); } return s.tick() - begin > 30; }
                    if (due('drop', 2)) send({ type: 'dropItem', slot: junk.slot });
                    return false;
                }
                if (worn) {
                    if (due('unequip', 3)) send({ type: 'useEquipmentItem', slot: worn.slot, optionIndex: 1 });
                    return false;
                }
                const g = (st?.groundItems ?? []).filter((x: any) => heads.includes(x.id)).sort((a: any, b: any) => a.distance - b.distance)[0];
                if (!g) { if (s.tick() - begin > 15) { say(name, 'head-missing'); return true; } return false; }
                if (due('pickup', 5)) { send({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id }); if (step !== 'pickup') { step = 'pickup'; say(name, 'pickup'); } }
                return false;
            },
        };
    };

    // Big fish: the tool left the pack and lies within 7 tiles. Pick it up again.
    const toolPickupJob = (id: number): Omit<Job, 'started'> => {
        let at = -99;
        const begin = s.tick();
        return {
            name: 'big_fish', hold: true,
            tick() {
                if (st?.trade?.isOpen) return true;
                if (inv().some(i => i.id === id)) { say('big_fish', 'recovered', `ticks=${s.tick() - begin}`); return true; }
                if (s.tick() - begin > 30) { say('big_fish', 'lost-tool'); return true; }
                const g = (st?.groundItems ?? []).filter((x: any) => x.id === id && x.distance <= 10).sort((a: any, b: any) => a.distance - b.distance)[0];
                if (!g || !canSend()) return false;
                if (freeSlots() < 1) {
                    const junk = [...inv()].reverse().find(i => JUNK.test(i.name));
                    if (junk) { send({ type: 'dropItem', slot: junk.slot }); at = s.tick(); }
                    return false;
                }
                if (s.tick() - at >= 5) { send({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id }); at = s.tick(); }
                return false;
            },
        };
    };

    const cubeJob = (): Omit<Job, 'started'> => {
        let at = -99, answeredAt = -99, before = 0, answers = 0;
        return {
            name: 'strange_box', hold: true,
            tick() {
                const cubes = inv().filter(i => i.id === CUBE).reduce((n, i) => n + i.count, 0);
                if (cubes === 0) { say('strange_box', 'solved', `answers=${answers}`); return true; }
                if (!ifReader) { say('strange_box', 'no-interface-reader'); return true; }
                if (!canSend()) return false;
                if (st?.dialog?.isOpen) { continueDialog(); return false; }
                if (st?.modalInterface === CUBE_IF.root && s.tick() - answeredAt >= 3) {
                    const q = ifReader.text(CUBE_IF.question) ?? '';
                    const pick = solveCube(q, CUBE_IF.models.map(c => ifReader!.obj(c)));
                    if (pick < 0) { say('strange_box', 'unreadable', JSON.stringify(q)); return true; }
                    send({ type: 'clickComponent', componentId: CUBE_IF.buttons[pick] });
                    before = cubes; answeredAt = s.tick(); answers++;
                    say('strange_box', 'answer', `q=${JSON.stringify(q)} button=${pick + 1}`);
                    return false;
                }
                if (st?.modalInterface !== CUBE_IF.root && s.tick() - at >= 4 && s.tick() - answeredAt >= 2) {
                    if (answeredAt > 0 && cubes > before) say('strange_box', 'wrong-answer');
                    const c = inv().find(i => i.id === CUBE)!;
                    send({ type: 'useInventoryItem', slot: c.slot, optionIndex: optIndex(c.optionsWithIndex, /open/i, 1) });
                    at = s.tick();
                }
                return s.tick() - (jobs.get('strange_box')?.started ?? s.tick()) > 200;
            },
        };
    };

    // XP from the genie's lamp: level x 10 XP in the skill this session trains (most XP gained), or RANDOM_EVENTS_LAMP.
    const xpStart = new Map<string, number>();
    const lampTarget = (): string | null => {
        if (lampSkill === 'keep') return null;
        if (lampSkill !== 'auto') return LAMP_SKILLS.includes(lampSkill) ? lampSkill : null;
        let best: string | null = null, gain = 0;
        for (const k of st?.skills ?? []) {
            const n = String(k.name).toLowerCase();
            const g = (k.experience ?? 0) - (xpStart.get(n) ?? k.experience ?? 0);
            if (LAMP_SKILLS.includes(n) && g > gain) { gain = g; best = n; }
        }
        return best;
    };
    const lampJob = (skill: string): Omit<Job, 'started'> => {
        let at = -99, step = 0;
        const begin = s.tick();
        return {
            name: 'lamp', hold: true,
            tick() {
                const lamp = inv().find(i => i.id === LAMP);
                if (!lamp) { if (st?.dialog?.isOpen) { continueDialog(); return false; } say('genie', `lamp-${skill}`); return true; }
                if (s.tick() - begin > 40) { say('genie', 'lamp-failed'); return true; }
                if (!canSend() || s.tick() - at < 2) return false;
                if (st?.dialog?.isOpen) { continueDialog(); return false; }
                if (st?.modalInterface === LAMP_IF) {
                    send({ type: 'clickComponent', componentId: step === 0 ? LAMP_FIRST + LAMP_SKILLS.indexOf(skill) : LAMP_CONFIRM });
                    step = step === 0 ? 1 : 0; at = s.tick();
                    return false;
                }
                send({ type: 'useInventoryItem', slot: lamp.slot, optionIndex: optIndex(lamp.optionsWithIndex, /rub/i, 1) }); step = 0; at = s.tick();
                return false;
            },
        };
    };

    // Mime: copy the mime's emote 4 times in a row (macro_event_mime.rs2), then the server returns the player.
    const mimeJob = (): Omit<Job, 'started'> => {
        let emote = -1, at = -99, clicks = 0;
        return {
            name: 'mime', hold: true,
            tick() {
                const p = me();
                if (!p || !inRegion(p, MIME_REGION)) { say('mime', 'returned', `clicks=${clicks}`); return true; }
                const mime = (st?.nearbyNpcs ?? []).find((n: any) => n.id === MIME_NPC);
                const i = mime ? MIME_ANIMS.indexOf(mime.animId) : -1;
                if (i >= 0) emote = i;
                const panel = st?.dialog?.isOpen && (st.dialog.allComponents ?? []).some((c: any) => c.id >= MIME_FIRST_BUTTON && c.id < MIME_FIRST_BUTTON + 8);
                if ((panel || (mime?.animId === EMOTE_BOW && emote >= 0)) && emote >= 0 && canSend() && s.tick() - at >= 3) {
                    send({ type: 'clickComponent', componentId: MIME_FIRST_BUTTON + emote });
                    at = s.tick(); clicks++;
                    say('mime', 'emote', `i=${emote}`);
                    emote = -1;
                } else if (st?.dialog?.isOpen && !panel) continueDialog();
                return false;
            },
        };
    };

    // Maze: route to the centre shrine through the maze's wall-doors (oploc1 on each), blocking a door that
    // answers "not the right way" (one-way doors), then touch the shrine.
    const mazeJob = (): Omit<Job, 'started'> => {
        let at = -99, lastPos = '', moved = -99, doors = 0, shrineTries = 0;
        // Every maze wall is a "Wall" with op Open, so the door index takes them all for doors. The permanent ones
        // (macro_maze_wallhigh, loc 3626: "I can't open that.") go in as blocked doors, read from the map file.
        const blocked: any[] = pf ? mazeWalls().map(([x, z]) => pf!.getDoorAt(0, x, z)).filter(Boolean) : [];
        let lastDoor: any = null;
        return {
            name: 'maze', hold: true,
            tick() {
                const p = me();
                if (!p || !inRegion(p, MAZE_REGION)) { say('maze', 'returned', `doors=${doors}`); return true; }
                if (st?.dialog?.isOpen) { continueDialog(); return false; }
                if (newMessages.any(/right way/i) && lastDoor) { blocked.push(lastDoor); say('maze', 'wrong-way', `door=${lastDoor.x},${lastDoor.z}`); lastDoor = null; at = -99; }
                if (!canSend() || !pf) return false;
                const pos = `${p.x},${p.z}`;
                if (pos !== lastPos) { lastPos = pos; moved = s.tick(); }
                // Act when the player has stood still for 2 ticks after the last click, or 10 ticks passed.
                if (s.tick() - at < 2 || (s.tick() - moved < 2 && s.tick() - at < 10)) return false;
                const statue = { x: MAZE_REGION.x0 + 31, z: MAZE_REGION.z0 + 31 };
                // The shrine (3x3) fills its walled room; the only way in is the wall-door on the east edge of
                // local (30,32) (maps/m45_71.jm2). Stand there, open it, then touch the shrine.
                const gate = { x: MAZE_REGION.x0 + 30, z: MAZE_REGION.z0 + 32 };
                if ((p.x === gate.x && p.z === gate.z) || inRegion(p, { x0: statue.x, x1: statue.x + 2, z0: statue.z, z1: statue.z + 2 })) {
                    const touch = shrineTries++ % 2 === 1 || p.x !== gate.x;
                    if (touch) send({ type: 'interactLoc', x: statue.x, z: statue.z, locId: MAZE_STATUE, optionIndex: 1 });
                    else send({ type: 'interactLoc', x: gate.x, z: gate.z, locId: mazeDoorId(gate.x, gate.z) ?? 3628, optionIndex: 1 });
                    at = s.tick();
                    say('maze', touch ? 'shrine' : 'gate', `from=${p.x},${p.z}`);
                    return false;
                }
                const hit = firstDoor(p, gate, blocked);
                if (!hit) { send({ type: 'walkTo', x: gate.x, z: gate.z, running: true }); at = s.tick(); return false; }
                const { door, before } = hit;
                // A far door: walk to the tile in front of it first, then click it.
                if (cheb(p, before) > 10) { send({ type: 'walkTo', x: before.x, z: before.z, running: true }); at = s.tick(); return false; }
                const loc = (st?.nearbyLocs ?? []).find((l: any) => l.x === door.x && l.z === door.z && l.options?.some((o: string) => /open/i.test(o)));
                send({ type: 'interactLoc', x: door.x, z: door.z, locId: loc?.id ?? mazeDoorId(door.x, door.z) ?? 3628, optionIndex: 1 });
                lastDoor = door; doors++; at = s.tick();
                say('maze', 'door', `at=${door.x},${door.z} from=${p.x},${p.z}`);
                return false;
            },
        };
    };
    // The first door the path crosses: expand the waypoints to single steps and look for a door on either tile.
    const firstDoor = (p: { x: number; z: number; level: number }, to: { x: number; z: number }, blocked: any[]) => {
        const pts = pf!.findLongPath(p.level, p.x, p.z, to.x, to.z, 500, blocked);
        let cur = { x: p.x, z: p.z };
        for (const w of pts) {
            while (cur.x !== w.x || cur.z !== w.z) {
                const next = { x: cur.x + Math.sign(w.x - cur.x), z: cur.z + Math.sign(w.z - cur.z) };
                for (const d of [pf!.getDoorAt(p.level, cur.x, cur.z), pf!.getDoorAt(p.level, next.x, next.z)]) {
                    if (!d || blocked.some(b => b.x === d.x && b.z === d.z)) continue;
                    // A straight wall on tile T, angle 0 west, 1 north, 2 east, 3 south: the step crosses it only
                    // between T and its neighbour on that side.
                    const [ox, oz] = [[-1, 0], [0, 1], [1, 0], [0, -1]][d.angle & 3]!;
                    const side = { x: d.x + ox, z: d.z + oz };
                    const at = (q: { x: number; z: number }, r: { x: number; z: number }) => q.x === r.x && q.z === r.z;
                    if ((at(cur, d) && at(next, side)) || (at(next, d) && at(cur, side))) return { door: d, before: { ...cur } };
                }
                cur = next;
            }
        }
        return null;
    };

    // Redirect away from an event object the player is working on (ent, whirlpool, gas rock).
    const redirected = new Map<string, number>();
    const redirect = (key: string, name: string, target: Act | null, away: { x: number; z: number } | null) => {
        if ((redirected.get(key) ?? -99) > s.tick() - 4 || !canSend()) return;
        redirected.set(key, s.tick());
        const p = me()!;
        if (target) { send(target); say(name, 'redirect'); return; }
        if (away) {
            const sx = Math.sign(p.x - away.x) || 1, sz = Math.sign(p.z - away.z);
            send({ type: 'walkTo', x: p.x + sx * 2, z: p.z + sz * 2, running: true });
            say(name, 'step-away');
        }
    };
    const nearestLoc = (re: RegExp, op: RegExp, not: (l: any) => boolean) =>
        (st?.nearbyLocs ?? []).filter((l: any) => re.test(l.name) && l.options?.some((o: string) => op.test(o)) && !not(l) && l.reachable !== false)
            .sort((a: any, b: any) => a.distance - b.distance)[0];

    // ---- loot jobs ----
    // Ticks after a pickup of the script in which the loot job starts nothing: the script loots for itself.
    const SCRIPT_LOOT_TICKS = 20;
    // A pickup job ends after this many ticks; the walk back to the start tile has its own limit.
    const LOOT_TICKS = 30, RETURN_TICKS = 20;
    // Ticks a pile the job skipped or gave up stays skipped.
    const SKIP_RISK = 10, SKIP_DONE = 100;
    const skipPiles = new Map<string, number>();
    const riskSaid = new Set<string>();
    const reserved = (id: number) => (loot?.reserved?.()[id] ?? 0) > 0;
    const keepOrReserve = (id: number) => kept.has(id) || reserved(id);
    const lootJob = (g: Ground, key: string): Omit<Job, 'started'> => {
        const tables = loot!.tables, begin = s.tick(), p0 = me(), origin = p0 ? { x: p0.x, z: p0.z } : null;
        const before = countOf(inv(), g.id);
        let at = -99, dropAt = -99, tries = 0, back = -1;
        // Ends the pickup: walk back first when the player left the start tile, so the script resumes where it was.
        const end = (why: string, extra = '') => {
            releasePile(key, loot!.name);
            skipPiles.set(key, s.tick() + SKIP_DONE);
            say('loot', why, `id=${g.id}${extra} ticks=${s.tick() - begin}`);
            const p = me();
            if (origin && p && cheb(p, origin) > 1) { back = s.tick(); at = -99; return false; }
            return true;
        };
        return {
            name: 'loot', hold: true,
            tick() {
                const p = me();
                if (!p) return true;
                if (back >= 0) {
                    if (!origin || cheb(p, origin) <= 1) { say('loot', 'returned', `ticks=${s.tick() - begin}`); return true; }
                    if (s.tick() - back > RETURN_TICKS) { say('loot', 'return-timeout'); return true; }
                    if (canSend() && s.tick() - at >= 4) { send({ type: 'walkTo', x: origin.x, z: origin.z, running: true }); at = s.tick(); }
                    return false;
                }
                const got = countOf(inv(), g.id) - before;
                if (got > 0) {
                    kept.set(g.id, (kept.get(g.id) ?? 0) + got);
                    return end('pickup', ` n=${got} value=${unitValue(g.id, tables) * got}`);
                }
                if (st?.dialog?.isOpen) { continueDialog(); return false; }
                const here = (st?.groundItems ?? []).find((x: any) => x.id === g.id && x.x === g.x && x.z === g.z);
                if (!here) return end('gone');
                if (s.tick() - begin > LOOT_TICKS) return end('timeout');
                const risk = lootRisk(st, here, danger(), fleetNames, rules);
                if (risk) return end(`abort-${risk}`);
                if (!canSend()) return false;
                const room = lootRoom(inv(), here, tables, keepOrReserve);
                if (room === null) return end('full');
                if (room !== 'ok') {
                    if (s.tick() - dropAt >= 2) {
                        const i = inv().find(x => x.slot === room);
                        if (i) ownDrops.set(`${p.x},${p.z},${i.id}`, s.tick());
                        send({ type: 'dropItem', slot: room });
                        dropAt = s.tick();
                    }
                    return false;
                }
                if (s.tick() - at >= 4) {
                    if (++tries > 4) return end('failed');
                    send({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id });
                    at = s.tick();
                }
                return false;
            },
        };
    };
    // The script opened a bank: put the kept items in it first. The script's held actions run after.
    const lootBankJob = (): Omit<Job, 'started'> => {
        const begin = s.tick();
        let at = -99;
        return {
            name: 'loot-bank', hold: true,
            tick() {
                if (!st?.bank?.isOpen) return true;
                const item = inv().find(i => (kept.get(i.id) ?? 0) > 0);
                if (!item) return true;
                if (s.tick() - begin > 20) { say('loot', 'bank-timeout'); return true; }
                if (canSend() && s.tick() - at >= 2) {
                    send({ type: 'bankDeposit', slot: item.slot, amount: Math.min(item.count ?? 1, kept.get(item.id)!) });
                    at = s.tick();
                }
                return false;
            },
        };
    };
    const scanLoot = () => {
        const p = me();
        if (!loot || !p) return;
        const now = s.tick(), pack = inv();
        // The keep list follows the pack: a deposit, a wield or a meal takes the item off it.
        for (const [id, k] of kept) {
            const n = countOf(pack, id);
            if (n >= k) continue;
            say('loot', st?.bank?.isOpen ? 'banked' : 'left-pack', `id=${id} n=${k - n}`);
            if (n > 0) kept.set(id, n); else { kept.delete(id); refusals.delete(id); }
        }
        for (const [k, t] of ownDrops) if (now - t > 300) ownDrops.delete(k);
        for (const [k, t] of skipPiles) if (t < now) skipPiles.delete(k);
        if (st?.bank?.isOpen) { if (pack.some(i => kept.has(i.id))) want('loot-bank', lootBankJob()); return; }
        if (active || [...jobs.keys()].some(k => k.startsWith('loot:'))) return;
        if (st?.dialog?.isOpen || st?.shop?.isOpen || st?.trade?.isOpen || st?.ge || st?.modalOpen) return;
        if (now - scriptPickupAt <= SCRIPT_LOOT_TICKS) return;
        const tables = loot.tables;
        const piles = ((st?.groundItems ?? []) as Ground[]).filter(g => worthIt(g, tables, rules))
            .sort((a, b) => pileValue(b, tables) - pileValue(a, tables) || a.distance - b.distance);
        for (const g of piles) {
            const key = pileKey(p.level, g);
            if (skipPiles.has(key) || ownDrops.has(`${g.x},${g.z},${g.id}`)) continue;
            const risk = lootRisk(st, g, danger(), fleetNames, rules);
            if (risk) {
                skipPiles.set(key, now + SKIP_RISK);
                if (!riskSaid.has(key)) { riskSaid.add(key); say('loot', `skip-${risk}`, `id=${g.id} value=${pileValue(g, tables)} d=${g.distance}`); }
                continue;
            }
            if (lootRoom(pack, g, tables, keepOrReserve) === null) {
                skipPiles.set(key, now + SKIP_DONE);
                say('loot', 'skip-full', `id=${g.id} value=${pileValue(g, tables)}`);
                continue;
            }
            if (!claimPile(key, loot.name)) continue;
            say('loot', 'seen', `id=${g.id} n=${g.count} value=${pileValue(g, tables)} d=${g.distance}`);
            want(`loot:${key}`, lootJob(g, key));
            return;
        }
    };

    const toolCounts = new Map<number, number>();
    const toolGone = new Map<number, number>();
    let lastStateTick = -1;

    const scanEvents = () => {
        const p = me();
        if (!p) return;
        const now = s.tick();
        const npcs: any[] = st?.nearbyNpcs ?? [];
        avoidNpcs.clear();
        avoidLocs.clear();

        for (const n of npcs) {
            // Hostile
            const h = HOSTILE.find(x => inRange(n.id, x));
            if (h) {
                let m = hostiles.get(n.index);
                if (!m || m.id !== n.id) {
                    m = { name: h.name, id: n.id, range: h.range, spawn: tileOf(n), seen: now, lastSeen: now, ours: null, pre: false, done: false };
                    // An angry triffid keeps the seed's spawn tile.
                    const seed = seeds.get(n.index);
                    if (n.id === 408 && seed) { m.seen = seed.seen; m.ours = seed.mine ? true : null; }
                    hostiles.set(n.index, m);
                    say(h.name, 'seen', `at=${m.spawn.x},${m.spawn.z} d=${cheb(m.spawn, p)}`);
                }
                m.lastSeen = now;
                if (n.targetIndex >= 32768) m.ours = targetsMe(n);
                else if (m.ours === null && now - m.seen <= 1 && cheb(tileOf(n), p) <= 2 && !otherNear(tileOf(n), 3)) { m.ours = true; m.pre = true; }
                const engaged = targetsMe(n) || (m.pre && now - m.seen < 6);
                if (m.ours && engaged && !outOfReach(p, m.spawn, m.range) && !jobs.has(`flee:${n.index}`)) {
                    m.done = false;
                    jobs.set(`flee:${n.index}`, { ...fleeJob(n.index), started: now });
                    say(h.name, 'flee', `need=${m.range + 2}`);
                }
                continue;
            }
            const fname = FRIENDLY[n.id];
            if (fname) {
                let f = friends.get(n.index);
                if (!f || f.id !== n.id) { f = { name: fname, id: n.id, seen: now, lastSeen: now, ours: null }; friends.set(n.index, f); say(fname, 'seen'); }
                f.lastSeen = now;
                if (n.targetIndex >= 32768) f.ours = targetsMe(n);
                else if (f.ours === null && cheb(tileOf(n), p) <= 2 && !otherNear(tileOf(n), 3)) f.ours = true;
                // The old man's mime, maze and box variants vanish after 1-2 ticks: talk only to one that stays.
                const settled = fname !== 'old_man' || now - f.seen >= 3;
                if (f.ours && settled && !handledNpc.has(n.index) && !jobs.has(`talk:${n.index}`)) { handledNpc.add(n.index); want(`talk:${n.index}`, talkJob(n.index)); }
                continue;
            }
            if (n.id === TRIFFID_SEED) {
                let sd = seeds.get(n.index);
                if (!sd) { sd = { seen: now, lastSeen: now, mine: cheb(tileOf(n), p) <= 2 }; seeds.set(n.index, sd); say('triffid', 'seen'); }
                sd.lastSeen = now;
                // ai_timer 45: the first timer makes the fruit ripe, the second turns the plant hostile.
                if (sd.mine && freeSlots() > 0 && now - sd.seen >= 47 && now - sd.seen <= 86 && !jobs.has(`seed:${n.index}`) && (redirected.get(`seed:${n.index}`) ?? -99) < now - 4) {
                    redirected.set(`seed:${n.index}`, now);
                    want(`seed:${n.index}`, seedJob(n.index));
                }
                continue;
            }
            if (inRange(n.id, ENT)) {
                avoidNpcs.add(n.index);
                const size = n.size ?? 2;
                const t = tileOf(n);
                const touching = p.x >= t.x - 1 && p.x <= t.x + size && p.z >= t.z - 1 && p.z <= t.z + size;
                if (touching && (st.player.animId ?? -1) !== -1) {
                    const tree = nearestLoc(new RegExp(`^${n.name}$`, 'i'), /chop/i, (l: any) => l.x >= t.x && l.x < t.x + size && l.z >= t.z && l.z < t.z + size);
                    redirect(`ent:${n.index}`, 'ent', tree ? { type: 'interactLoc', x: tree.x, z: tree.z, locId: tree.id, optionIndex: optIndex(tree.optionsWithIndex, /chop/i, 1) } : null, t);
                }
                continue;
            }
            if (inRange(n.id, WHIRLPOOL)) {
                avoidNpcs.add(n.index);
                const t = tileOf(n);
                if (cheb(t, p) <= 1 && (st.player.animId ?? -1) !== -1) {
                    const spot = npcs.filter(o => o.name === n.name && !inRange(o.id, WHIRLPOOL) && o.reachable !== false).sort((a, b) => a.distance - b.distance)[0];
                    const op = spot?.optionsWithIndex?.find((o: any) => n.options?.includes(o.text));
                    redirect(`whirl:${n.index}`, 'whirlpool', spot && op ? { type: 'interactNpc', npcIndex: spot.index, optionIndex: op.opIndex } : null, t);
                }
                continue;
            }
            if (n.id === BIG_FISH && !handledNpc.has(n.index)) { handledNpc.add(n.index); say('big_fish', 'seen'); }
        }

        // Gas rock (mining) and gas chest (thieving).
        for (const l of st?.nearbyLocs ?? []) {
            if (inRange(l.id, GAS_ROCK)) {
                avoidLocs.add(`${l.x},${l.z}`);
                if (cheb(l, p) <= 1 && (st.player.animId ?? -1) !== -1) {
                    const rock = nearestLoc(/^rocks?$/i, /mine/i, (o: any) => inRange(o.id, GAS_ROCK) || (o.x === l.x && o.z === l.z));
                    redirect(`gas:${l.x},${l.z}`, 'gas_rock', rock ? { type: 'interactLoc', x: rock.x, z: rock.z, locId: rock.id, optionIndex: optIndex(rock.optionsWithIndex, /mine/i, 1) } : null, l);
                }
            } else if (l.id === GAS_CHEST) {
                avoidLocs.add(`${l.x},${l.z}`);
                if (cheb(l, p) <= 1) redirect(`chest:${l.x},${l.z}`, 'poison_gas', null, l);
            }
        }

        // Lost axe / pickaxe: a handle in the pack or the hand.
        const all = [...inv(), ...eq().filter(Boolean)];
        if (all.some(i => i.id === AXE_HANDLE)) want('lost_axe', lostToolJob('axe'));
        if (all.some(i => i.id === PICK_HANDLE)) want('lost_pickaxe', lostToolJob('pickaxe'));

        // Trade offers remove tools from the pack without dropping them.
        for (const id of FISH_TOOLS) {
            const c = inv().filter(i => i.id === id).length;
            const prev = toolCounts.get(id) ?? c;
            toolCounts.set(id, c);
            if (st?.trade?.isOpen) {
                toolGone.delete(id);
                const key = `tool:${id}`;
                if (active === jobs.get(key)) active = null;
                jobs.delete(key);
                continue;
            }
            if (c < prev && !st?.bank?.isOpen) toolGone.set(id, now);
            const gone = toolGone.get(id);
            if (gone !== undefined && now - gone <= 12 && (st?.groundItems ?? []).some((g: any) => g.id === id && g.distance <= 10)) {
                toolGone.delete(id);
                say('big_fish', 'tool-dropped', `id=${id}`);
                want(`tool:${id}`, toolPickupJob(id));
            }
        }

        if (inv().some(i => i.id === CUBE)) want('strange_box', cubeJob());
        // No skill trained yet (auto): keep the lamp and look again every 100 ticks.
        const kept = jobs.get('lamp-kept');
        if (kept && now - kept.started >= 100 && lampSkill === 'auto') jobs.delete('lamp-kept');
        if (inv().some(i => i.id === LAMP) && !jobs.has('lamp') && !jobs.has('lamp-kept')) {
            const skill = lampTarget();
            if (skill) want('lamp', lampJob(skill));
            else { if (!kept) say('genie', 'lamp-kept'); jobs.set('lamp-kept', { name: 'noop', hold: false, started: now, tick: () => false }); }
        }
        if (inRegion(p, MIME_REGION)) want('mime', mimeJob());
        if (inRegion(p, MAZE_REGION)) want('maze', mazeJob());

        for (const [k, m] of hostiles) if (now - m.lastSeen > 50) hostiles.delete(k);
        for (const [k, f] of friends) if (now - f.lastSeen > 50) friends.delete(k);
        for (const [k, sd] of seeds) if (now - sd.lastSeen > 50) seeds.delete(k);
    };

    const priority = (key: string) => key.startsWith('flee:') ? 0 : key === 'mime' || key === 'maze' ? 1 : key.startsWith('talk:') ? 2
        : key === 'loot-bank' || key.startsWith('loot:') ? 4 : 3;
    const HOLD_LIMIT = 50;

    const off = s.onTick(() => {
        try {
            st = s.sdk.getState();
            if (!st?.player || s.tick() === lastStateTick) return;
            lastStateTick = s.tick();
            if (xpStart.size === 0) for (const k of st.skills ?? []) xpStart.set(String(k.name).toLowerCase(), k.experience ?? 0);
            newMessages.update();
            if (eventsOn) scanEvents();
            if (loot) scanLoot();
            // Pick the job to run this tick: the active one, unless a flight must preempt it.
            const order = [...jobs.entries()].filter(([, j]) => j.name !== 'noop').sort((a, b) => priority(a[0]) - priority(b[0]) || a[1].started - b[1].started);
            const top = order[0];
            if (top && (!active || (priority(top[0]) < priority([...jobs.entries()].find(([, j]) => j === active)?.[0] ?? 'zzz')))) active = top[1];
            if (active) {
                const key = [...jobs.entries()].find(([, j]) => j === active)?.[0];
                let done = false;
                try { done = !!active.tick(); } catch (e) { log(`EVENT ${active.name} error t=${s.tick()} ${String(e)}`); done = true; }
                if (done) {
                    if (key) jobs.delete(key);
                    active = null;
                    const next = [...jobs.entries()].filter(([, j]) => j.name !== 'noop').sort((a, b) => priority(a[0]) - priority(b[0]) || a[1].started - b[1].started)[0];
                    if (next) active = next[1];
                }
            }
            // Release the script: everything when no job holds the player, and anything held too long.
            if (!holding()) flush();
            else for (let i = held.length - 1; i >= 0; i--) if (s.tick() - held[i]!.at > HOLD_LIMIT) held.splice(i, 1)[0]!.fail();
        } catch (e) {
            log(`EVENT watcher error t=${s.tick()} ${String(e)}`);
        }
    });

    return {
        stop() {
            off();
            if (gateOn) { s.direct = rawDirect; if (rawSend) sdkAny.send = rawSend; }
            active = null;
            for (const h of held.splice(0)) h.fail();
        },
        counts: () => ({ ...counts }),
        busy: () => holding(),
        avoid: () => ({ npcs: new Set(avoidNpcs), locs: new Set(avoidLocs) }),
        kept: () => new Map(kept),
    };
}
