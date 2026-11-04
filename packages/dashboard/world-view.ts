// Read-only views of other players, from public game data only: the world feed's roster (every online player's
// name, tile and combat level), the demo hiscore board pages and player pages. They feed the page's Rivals view
// (Hiscores), the World plugin (players at our spots, player lookup) and the minimap's other-player dots.
export type Seen = { x: number; z: number; level: number; combat: number; seen: number };
export type BoardRow = { rank: number; name: string; level: number; ticks: number };
export type HiscoreRow = { board: string; rank: number; level: number; time: string };
export const ONLINE_MS = 30_000, SPOT_RADIUS = 10, RIVALS_PER_BOARD = 10;
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

// Players near each claimed resource with a tile ("knight:2582,3297"): ours and others, within SPOT_RADIUS tiles on
// the ground floor. Named resources without a tile ("shop:aubury") are listed with no count.
export function contentionView(claims: any[], roster: ReadonlyMap<string, Seen & { name?: string }>, fleet: ReadonlySet<string>, now: number, radius = SPOT_RADIUS) {
    const online = [...roster].filter(([, p]) => now - p.seen < ONLINE_MS);
    const spots: { side: string; resource: string; kind: string; x: number | null; z: number | null; others: string[]; ours: string[] }[] = [];
    for (const c of claims) {
        if (!c || typeof c.side !== 'string' || !Array.isArray(c.resources)) continue;
        for (const resource of c.resources) {
            const m = String(resource).match(/^([a-z]+):(\d{3,5}),(\d{3,5})$/);
            if (!m) { spots.push({ side: c.side, resource: String(resource), kind: String(resource).split(':')[0]!, x: null, z: null, others: [], ours: [] }); continue; }
            const x = Number(m[2]), z = Number(m[3]), near = online.filter(([, p]) => p.level === 0 && Math.abs(p.x - x) <= radius && Math.abs(p.z - z) <= radius).map(([n, p]) => p.name ?? n);
            spots.push({ side: c.side, resource: String(resource), kind: m[1]!, x, z, others: near.filter(n => !fleet.has(n.toLowerCase())).sort(), ours: near.filter(n => fleet.has(n.toLowerCase())).sort() });
        }
    }
    return spots.sort((a, b) => b.others.length - a.others.length || a.resource.localeCompare(b.resource));
}

// One looked-up player: hiscore rows (or null when not fetched), and where the world feed last saw them.
// worn: the player's worn items read from the world feed when the lookup ran (online players only).
export function lookupView(name: string, rows: HiscoreRow[] | null, at: number | null, seen: Seen | undefined, now: number, worn: { slot: string; name: string }[] | null = null, wornAt: number | null = null) {
    const online = !!seen && now - seen.seen < ONLINE_MS;
    return { name, at, rows, online, x: seen?.x ?? null, z: seen?.z ?? null, plane: seen?.level ?? null, combat: seen?.combat ?? null, lastSeen: seen?.seen ?? null, worn, wornAt };
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
export type FleetSkill = { name: string; level: number; xp: number | null };
export type FleetAccount = { name: string; skills: FleetSkill[]; ranks: { board: string; rank: number; level: number; time: string }[]; goalSkill?: string | null; xpPerHour?: number | null };
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
