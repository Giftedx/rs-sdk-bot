// Read-only views of other players, from public game data only: the world feed's roster (every online player's
// name, tile and combat level), the demo hiscore board pages and player pages. They feed the page's Rivals view
// (Hiscores), the World plugin (players at our spots, player lookup) and the minimap's other-player dots.
type Seen = { x: number; z: number; level: number; combat: number; seen: number };
export type BoardRow = { rank: number; name: string; level: number; ticks: number };
export type HiscoreRow = { board: string; rank: number; level: number; time: string };
export const ONLINE_MS = 30_000, RIVALS_PER_BOARD = 10;
const SPOT_RADIUS = 10;
const NAME = /^[A-Za-z0-9_ -]{1,12}$/;

// Skill rows of a hiscore player page, as server.ts reads it: "<Board> <rank> <level> <time>" after tags are removed.
// A value board page (Equipment, Bank, Runite): its top 50, one table row each with the rank, the player link and
// the value cell (exact gp in a title when the cell shows a short value, "1366K"; a plain count for Runite).
// Only the first table counts.
export type ValueRow = { rank: number; name: string; value: number | null; text: string };
export function valueBoardRows(html: string): ValueRow[] {
    const rows: ValueRow[] = [];
    for (const tr of html.split(/<tr[\s>]/).slice(1)) {
        const rank = /<td align="right">(\d+)<\/td>/.exec(tr), name = /href="\/hiscores\/player\/([^?"]+)\?/.exec(tr), cell = /<td align="right" class="yellow"(?: title="([\d,]+) gp")?>([^<]+)<\/td>/.exec(tr);
        if (!rank || !name || !cell) continue;
        // Runite's page adds This week and Today tables after All time: the board is the first table.
        if (rows.length && Number(rank[1]) <= rows[rows.length - 1]!.rank) break;
        const exact = (cell[1] ?? cell[2]!).replace(/,/g, '');
        rows.push({ rank: Number(rank[1]), name: decodeURIComponent(name[1]!), value: /^\d+$/.test(exact) ? Number(exact) : null, text: cell[2]!.trim() });
    }
    return rows;
}
export function hiscoreRows(html: string, boards: readonly string[]): HiscoreRow[] {
    const text = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const rows: HiscoreRow[] = [];
    for (const b of boards) {
        // Overall's level is a total with a thousands comma ("1,881").
        const m = text.match(new RegExp(`${b} ([0-9,]+) ([0-9,]+) ((?:\\d+h )?(?:\\d+m )?\\d+s)`)), level = m ? Number(m[2]!.replace(/,/g, '')) : 0;
        if (m && level > 1) rows.push({ board: b, rank: Number(m[1]!.replace(/,/g, '')), level, time: m[3]! });
    }
    return rows;
}

// Online players: [name, x, z, plane, combat], seen in the last 30 seconds, sorted by name.
export function rosterView(roster: ReadonlyMap<string, Seen & { name?: string }>, now: number) {
    return [...roster].filter(([n, p]) => now - p.seen < ONLINE_MS && NAME.test(p.name ?? n)).map(([n, p]) => [p.name ?? n, p.x, p.z, p.level, p.combat] as [string, number, number, number, number])
        .sort((a, b) => a[0].localeCompare(b[0]));
}

// Each board's top 10 with who is ours, who is online now and where. ourBest: the fleet's best rank on the board.
export function rivalsView(tops: ReadonlyMap<string, { at: number; rows: BoardRow[] }>, roster: ReadonlyMap<string, Seen>, fleet: ReadonlySet<string>, ourBest: ReadonlyMap<string, { rank: number; name: string } | null>, now: number) {
    return [...tops].map(([board, t]) => ({
        board, at: t.at, ours: ourBest.get(board) ?? null,
        rows: t.rows.slice(0, RIVALS_PER_BOARD).filter(r => NAME.test(r.name)).map(r => {
            const p = roster.get(r.name.toLowerCase()), online = !!p && now - p.seen < ONLINE_MS;
            return { ...r, fleet: fleet.has(r.name.toLowerCase()), online, x: online ? p!.x : null, z: online ? p!.z : null };
        }),
    }));
}

// Canonical ground-floor (or dungeon) coordinates for named resource claims in contentionView.
const NAMED_SPOT_TILES: Readonly<Record<string, { x: number; z: number; level?: number }>> = {
    'shop:aubury': { x: 3253, z: 3402 },
    'shop:lowe': { x: 3232, z: 3423 },
    'shop:zaff': { x: 3203, z: 3433 },
    'shop:betty': { x: 3012, z: 3259 },
    'shop:sarim': { x: 3013, z: 3225 },
    'shop:ardy': { x: 2613, z: 3294 },
    'shop:catherby': { x: 2821, z: 3444 },
    'shop:catherby_arrows': { x: 2821, z: 3444 },
    'shop:dargaud': { x: 2673, z: 3434 },
    'shop:magic_guild': { x: 2595, z: 3087, level: 1 },
    'shop:jukat': { x: 3252, z: 9572 },
    'shop:harry': { x: 2834, z: 3445 },
    'shop:khazard_paste': { x: 2641, z: 3171 },
    'cow:ardougne-north': { x: 2664, z: 3345 },
    'trooper:battlefield': { x: 2525, z: 3242 },
    'catherby:lobster': { x: 2838, z: 3431 },
    'aio:seers-flax': { x: 2744, z: 3445 },
    'aio:seers-yews': { x: 2710, z: 3460 },
    'aio:varrock-east-mine': { x: 3286, z: 3368 },
    'aio:essence-mine': { x: 2910, z: 4832 },
    'aio:air-altar': { x: 2985, z: 3292 },
    'aio:ardougne-blood-chests': { x: 2586, z: 9736 },
    'cave:taverley-black-dragons': { x: 2835, z: 9824 },
};

export function wildernessInfo(pos: { x: number; z: number; level?: number } | null | undefined, combat?: number | null) {
    if (!pos || !Number.isFinite(pos.z) || (typeof pos.x === 'number' && (pos.x < 2944 || pos.x > 3391))) return { wild: 0, minCombat: null, maxCombat: null };
    const south = pos.z >= 3520 && pos.z < 4000 ? 3520 : pos.z >= 9920 && pos.z < 10400 ? 9920 : 0;
    const wild = south ? Math.floor((pos.z - south) / 8) + 1 : 0;
    if (!wild || typeof combat !== 'number' || !Number.isFinite(combat) || combat < 3) return { wild, minCombat: null, maxCombat: null };
    return { wild, minCombat: Math.max(3, combat - wild), maxCombat: Math.min(126, combat + wild) };
}

export function wildernessView(roster: ReadonlyMap<string, Seen & { name?: string }>, fleet: ReadonlySet<string>, now: number) {
    return [...roster]
        .filter(([n, p]) => now - p.seen < ONLINE_MS && NAME.test(p.name ?? n))
        .flatMap(([n, p]) => {
            const name = p.name ?? n, info = wildernessInfo({ x: p.x, z: p.z, level: p.level }, p.combat);
            return info.wild > 0 ? [{ name, fleet: fleet.has(name.toLowerCase()), x: p.x, z: p.z, plane: p.level, combat: p.combat, wild: info.wild, minCombat: info.minCombat, maxCombat: info.maxCombat }] : [];
        })
        .sort((a, b) => Number(a.fleet) - Number(b.fleet) || b.wild - a.wild || a.name.localeCompare(b.name));
}

// Players near each claimed resource with a tile ("knight:2582,3297") or named spot ("shop:aubury"): ours and others,
// within SPOT_RADIUS tiles on that plane.
export function contentionView(claims: any[], roster: ReadonlyMap<string, Seen & { name?: string }>, fleet: ReadonlySet<string>, now: number, radius = SPOT_RADIUS) {
    const online = [...roster].filter(([, p]) => now - p.seen < ONLINE_MS);
    const spots: { side: string; resource: string; kind: string; x: number | null; z: number | null; others: string[]; ours: string[] }[] = [];
    const listed = new Set<string>();
    for (const c of claims) {
        if (!c || typeof c.side !== 'string' || !Array.isArray(c.resources)) continue;
        // A shared knight spot is listed once per farmer, in one claim or in several; the view shows the spot once.
        for (const resource of new Set(c.resources)) {
            const key = c.side + ' ' + resource;
            if (listed.has(key)) continue;
            listed.add(key);
            const raw = String(resource);
            const m = raw.match(/^([a-z]+):(\d{3,5}),(\d{3,5})$/);
            const named = !m ? NAMED_SPOT_TILES[raw] : undefined;
            if (!m && !named) { spots.push({ side: c.side, resource: raw, kind: raw.split(':')[0]!, x: null, z: null, others: [], ours: [] }); continue; }
            const x = m ? Number(m[2]) : named!.x, z = m ? Number(m[3]) : named!.z, plane = m ? 0 : named!.level ?? 0;
            const kind = m ? m[1]! : raw.split(':')[0]!;
            const near = online.filter(([, p]) => p.level === plane && Math.abs(p.x - x) <= radius && Math.abs(p.z - z) <= radius).map(([n, p]) => p.name ?? n);
            spots.push({ side: c.side, resource: raw, kind, x, z, others: near.filter(n => !fleet.has(n.toLowerCase())).sort(), ours: near.filter(n => fleet.has(n.toLowerCase())).sort() });
        }
    }
    return spots.sort((a, b) => b.others.length - a.others.length || a.resource.localeCompare(b.resource));
}

// One looked-up player: hiscore rows (or null when not fetched), and where the world feed last saw them.
// worn: the player's worn items read from the world feed when the lookup ran (online players only).
// A supplied feed time dates presence independently of the hiscores. Omitted feed times keep the legacy shape.
export function lookupView(name: string, rows: HiscoreRow[] | null, at: number | null, seen: Seen | undefined, now: number, worn: { slot: string; name: string }[] | null = null, wornAt: number | null = null, feedAt?: number | null) {
    const dated = arguments.length >= 8;
    const presenceObservedAt = typeof feedAt === 'number' && Number.isFinite(feedAt) && feedAt > 0 && feedAt <= now && now - feedAt < ONLINE_MS ? feedAt : null;
    const sightingFresh = !!seen && Number.isFinite(seen.seen) && seen.seen > 0 && seen.seen <= now && now - seen.seen < ONLINE_MS;
    const online = !dated ? !!seen && now - seen.seen < ONLINE_MS : presenceObservedAt === null ? null : sightingFresh;
    const wild = seen ? wildernessInfo({ x: seen.x, z: seen.z, level: seen.level }, seen.combat) : null;
    return { name, at, rows, online, x: seen?.x ?? null, z: seen?.z ?? null, plane: seen?.level ?? null, combat: seen?.combat ?? null, lastSeen: seen?.seen ?? null, worn, wornAt, ...(wild && wild.wild > 0 ? { wild } : {}), ...(dated ? { presenceObservedAt } : {}) };
}

// Bot farms: other players whose names follow one pattern, online now. A numbered series ("Money 01" … "Money 43",
// "Johnbpockt02") groups by its stem; random names that share their first two characters and their length, with
// at least three digits ("671nb2fxy", "6728br6td"), group by that prefix. Groups of three or more are listed, each
// with how many members stand at each of our claimed spots. Fleet accounts are never counted.
export function farmsView(roster: ReadonlyMap<string, Seen & { name?: string }>, fleet: ReadonlySet<string>, spots: { resource: string; others: string[] }[], now: number, min = 3) {
    const groups = new Map<string, { key: string; label: string; names: string[]; numbers: number[]; tiles: [number, number][] }>();
    for (const [n, p] of roster) {
        const name = p.name ?? n;
        if (now - p.seen >= ONLINE_MS || fleet.has(name.toLowerCase())) continue;
        const series = name.match(/^(.*?[A-Za-z])[ _-]?(\d{1,3})$/), random = /^[0-9a-z]{8,12}$/i.test(name) && (name.match(/\d/g) ?? []).length >= 3 && /[a-z]/i.test(name);
        const key = series ? 'series:' + series[1]!.toLowerCase().trim() : random ? `random:${name.slice(0, 2).toLowerCase()}:${name.length}` : null;
        if (!key) continue;
        const g = groups.get(key) ?? { key, label: series ? series[1]!.trim() + ' ##' : `${name.slice(0, 2)}… (${name.length} characters, random)`, names: [], numbers: [], tiles: [] };
        g.names.push(name); if (series) g.numbers.push(Number(series[2])); g.tiles.push([p.x, p.z]); groups.set(key, g);
    }
    return [...groups.values()].filter(g => g.names.length >= min).map(g => {
        const members = new Set(g.names);
        return { key: g.key, label: g.label, count: g.names.length, names: g.names.sort(), range: g.numbers.length ? [Math.min(...g.numbers), Math.max(...g.numbers)] as [number, number] : null, tiles: g.tiles,
            atSpots: spots.map(s => ({ resource: s.resource, count: s.others.filter(o => members.has(o)).length })).filter(s => s.count > 0) };
    }).sort((a, b) => b.atSpots.reduce((n, s) => n + s.count, 0) - a.atSpots.reduce((n, s) => n + s.count, 0) || b.count - a.count);
}

// Overtake planner: for each board, the fleet account with the best rank, the XP it needs to pass the next rows of the
// top 10, and the hours that takes at its measured rate when it trains that skill now. Boards rank by level, then by the
// shorter time, and our board time only grows. Reaching a row's level passes it only while our time stays under theirs:
// otherwise the goal is one level more, and past 99 there is none, so only a new account under that time passes it
// (newAccount). Board time stops at 99, so a finished account never gets faster. deadline: the board time we have left
// for a same-level pass.
type FleetSkill = { name: string; level: number; xp: number | null };
type FleetAccount = { name: string; skills: FleetSkill[]; ranks: { board: string; rank: number; level: number; time: string }[]; goalSkill?: string | null; xpPerHour?: number | null };
const secondsOf = (t: string) => { let s = 0; for (const [, n, u] of t.matchAll(/(\d+)([hms])/g)) s += Number(n) * (u === 'h' ? 3600 : u === 'm' ? 60 : 1); return s; };
export function overtakeView(tops: ReadonlyMap<string, { rows: BoardRow[] }>, accounts: FleetAccount[], xpForLevel: (level: number) => number) {
    const out: any[] = [];
    for (const [board, t] of tops) {
        if (board === 'Overall' || board === 'Quest Points') continue;
        let best: { a: FleetAccount; rank: number; level: number; seconds: number } | null = null;
        for (const a of accounts) { const r = a.ranks?.find(x => x.board === board); if (r && (!best || r.rank < best.rank)) best = { a, rank: r.rank, level: r.level, seconds: secondsOf(r.time) }; }
        if (!best) continue;
        const skill = best.a.skills?.find(k => k.name === board), xp = skill?.xp ?? null, rate = best.a.goalSkill === board && best.a.xpPerHour && best.a.xpPerHour > 0 ? best.a.xpPerHour : null;
        const above = t.rows.filter(r => r.rank < best!.rank);
        const picks = [...new Map([above[above.length - 1], above[0]].filter(Boolean).map(r => [r!.rank, r!])).values()];
        const targets = picks.map(r => {
            const theirs = Math.round(r.ticks * 0.4), xpTo = (l: number) => xp == null ? null : Math.max(0, xpForLevel(l) - xp);
            // Our board time when we reach their level: the time so far plus the hours to get there, when the rate is known.
            const sameNeed = r.level > best!.level ? xpTo(r.level) : null, sameAt = best!.seconds + (sameNeed != null && rate ? sameNeed / rate * 3600 : 0);
            const sameLevel = r.level > best!.level && sameAt < theirs, goal = sameLevel ? r.level : Math.max(r.level, best!.level) + 1;
            const newAccount = goal > 99 || best!.level >= 99, need = newAccount ? null : xpTo(goal);
            return { rank: r.rank, name: r.name, level: r.level, seconds: theirs, newAccount, goal: newAccount ? null : goal, xpNeeded: need, hours: need != null && rate ? need / rate : null, deadline: sameLevel ? theirs - best!.seconds : null };
        });
        out.push({ board, account: best.a.name, rank: best.rank, level: best.level, seconds: best.seconds, xp, xpPerHour: rate, inTop: best.rank <= t.rows.length, targets });
    }
    return out;
}

const WILDERNESS_BOUNDS = { xMin: 2944, xMax: 3392, zMin: 3520, zMax: 3968 } as const;

type WildernessBandId = 'tele' | 'glory' | 'deep';
type WildernessBand = {
    id: WildernessBandId;
    label: string;
    range: string;
    minWild: number;
    maxWild: number;
    zMin: number;
    zMax: number;
    colour: string;
    fill: string;
    note: string;
};

export const WILDERNESS_BANDS: readonly WildernessBand[] = [
    { id: 'tele', label: 'Lvl 1–20 (Tele)', range: 'Lvl 1-20', minWild: 1, maxWild: 20, zMin: 3520, zMax: 3680, colour: '#86c862', fill: 'rgba(134, 200, 98, 0.09)', note: 'Standard teleports & enchanted jewellery' },
    { id: 'glory', label: 'Lvl 21–30 (Glory)', range: 'Lvl 21-30', minWild: 21, maxWild: 30, zMin: 3680, zMax: 3760, colour: '#e8a844', fill: 'rgba(232, 168, 68, 0.12)', note: 'Amulet of glory & Ring of life only' },
    { id: 'deep', label: 'Lvl 31+ (Deep Wild)', range: 'Lvl 31+', minWild: 31, maxWild: 56, zMin: 3760, zMax: 3968, colour: '#e05347', fill: 'rgba(224, 83, 71, 0.14)', note: 'Teleports blocked — run south or lever' },
];

type WildernessHotspot = {
    id: string;
    label: string;
    x: number;
    z: number;
    level: number;
    wild: number;
    band: WildernessBandId;
    note: string;
};

export const WILDERNESS_HOTSPOTS: readonly WildernessHotspot[] = [
    { id: 'edgeville-ditch', label: 'Wilderness Edge', x: 3094, z: 3520, level: 0, wild: 1, band: 'tele', note: 'Lvl 1 Wilderness edge' },
    { id: 'chaos-temple', label: 'Chaos Temple', x: 3236, z: 3610, level: 0, wild: 12, band: 'tele', note: 'Lvl 12 Chaos Temple altar' },
    { id: 'green-dragons', label: 'Green Dragons', x: 3092, z: 3810, level: 0, wild: 37, band: 'deep', note: 'Lvl 37 Green Dragons' },
    { id: 'lava-maze', label: 'Lava Maze', x: 3067, z: 3856, level: 0, wild: 43, band: 'deep', note: 'Lvl 43 Lava Maze & runite' },
    { id: 'rogues-castle', label: "Rogue's Castle", x: 3285, z: 3930, level: 0, wild: 52, band: 'deep', note: "Lvl 52 Rogue's Castle" },
    { id: 'mage-bank', label: 'Mage Bank / Arena', x: 3098, z: 3955, level: 0, wild: 55, band: 'deep', note: 'Lvl 55 Mage Arena & cellar bank' },
];

const PLACE_HINTS: readonly (readonly [RegExp, { readonly x: number; readonly z: number; readonly level: number; readonly label: string }])[] = [
    ...WILDERNESS_HOTSPOTS.map(h => [new RegExp(h.label.replace(/['’/]/g, '.?').replace(/\s+/g, '\\s+'), 'i'), { x: h.x, z: h.z, level: h.level, label: h.label }] as const),
    [/\bmage\s*(?:bank|arena)\b/i, { x: 3098, z: 3955, level: 0, label: 'Mage Bank / Arena' }],
    [/\brogue'?s?\s*castle\b/i, { x: 3285, z: 3930, level: 0, label: "Rogue's Castle" }],
    [/\brunite\b/i, { x: 3058, z: 3884, level: 0, label: 'Lava Maze runite' }],
    [/\bedgeville\b/i, { x: 3094, z: 3494, level: 0, label: 'Edgeville' }],
];

export function wildernessBandFor(pos: { x: number; z: number; level?: number } | null | undefined) {
    const { wild } = wildernessInfo(pos);
    if (wild <= 0) return null;
    const band = WILDERNESS_BANDS.find(b => wild >= b.minWild && wild <= b.maxWild) ?? WILDERNESS_BANDS[WILDERNESS_BANDS.length - 1]!;
    return { ...band, wild };
}

function parseTile(raw: any): { x: number; z: number; level: number; label?: string } | null {
    if (!raw || typeof raw !== 'object') return null;
    if (Array.isArray(raw)) {
        const [x, z, level = 0] = raw;
        return Number.isFinite(x) && Number.isFinite(z) ? { x: Math.trunc(x), z: Math.trunc(z), level: Number.isFinite(level) ? Math.trunc(level) : 0 } : null;
    }
    if (Number.isFinite(raw.x) && Number.isFinite(raw.z)) {
        return {
            x: Math.trunc(raw.x),
            z: Math.trunc(raw.z),
            level: Number.isFinite(raw.level) ? Math.trunc(raw.level) : 0,
            ...(typeof raw.label === 'string' && raw.label.trim() ? { label: raw.label.trim() } : {}),
        };
    }
    return null;
}

export function resolveBotDestination(bot: any): { x: number; z: number; level: number; label: string } | null {
    if (!bot || typeof bot !== 'object') return null;
    for (const candidate of [bot.target, bot.dest, bot.destination, bot.progressionContext?.target]) {
        const parsed = parseTile(candidate);
        if (parsed) return { ...parsed, label: parsed.label ?? (typeof bot.targetLabel === 'string' ? bot.targetLabel : 'Target') };
    }
    const spotKey = typeof bot.spot === 'string' ? bot.spot.toLowerCase() : '';
    const named = NAMED_SPOT_TILES[spotKey];
    if (named) return { x: named.x, z: named.z, level: named.level ?? 0, label: spotKey };
    const text = [bot.targetLabel, bot.phase, bot.goal].filter(x => typeof x === 'string').join(' ');
    for (const [re, spot] of PLACE_HINTS) {
        if (re.test(text)) return { ...spot };
    }
    return null;
}

type BotPathOverlay = {
    name: string;
    from: { x: number; z: number; level: number };
    to: { x: number; z: number; level: number };
    label: string;
    wild: number;
    band: WildernessBandId | null;
};

export function botPathOverlays(bots: readonly any[], options: { secretName?: string; includePractice?: boolean; publicView?: boolean } = {}): BotPathOverlay[] {
    const secret = (options.secretName ?? 'Haggis').toLowerCase();
    const out: BotPathOverlay[] = [];
    for (const b of bots || []) {
        if (!b || typeof b !== 'object') continue;
        if (!options.includePractice && b.practice) continue;
        const rawName = String(b.name ?? '');
        const isSecret = rawName === '⟦MAIN⟧' || rawName.toLowerCase() === secret;
        if (options.publicView && isSecret) continue;
        const pos = b.live || b.pos;
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) continue;
        const to = resolveBotDestination(b);
        if (!to) continue;
        if (to.x === pos.x && to.z === pos.z && to.level === (pos.level ?? 0)) continue;
        const band = wildernessBandFor(to);
        out.push({
            name: isSecret ? 'main' : rawName,
            from: { x: Math.trunc(pos.x), z: Math.trunc(pos.z), level: Number.isFinite(pos.level) ? Math.trunc(pos.level) : 0 },
            to,
            label: to.label,
            wild: band?.wild ?? 0,
            band: band?.id ?? null,
        });
    }
    return out;
}

export function wildernessOverlayData() {
    return { bounds: WILDERNESS_BOUNDS, bands: WILDERNESS_BANDS, hotspots: WILDERNESS_HOTSPOTS };
}
