// Read-only views of other players, from public game data only: the world feed's roster (every online player's
// name, tile and combat level), the demo hiscore board pages and player pages. They feed the page's Rivals view
// (Hiscores), the World plugin (players at our spots, player lookup) and the minimap's other-player dots.
export type Seen = { x: number; z: number; level: number; combat: number; seen: number };
export type BoardRow = { rank: number; name: string; level: number; ticks: number };
export type HiscoreRow = { board: string; rank: number; level: number; time: string };
export const ONLINE_MS = 30_000, SPOT_RADIUS = 10, RIVALS_PER_BOARD = 10;
const NAME = /^[A-Za-z0-9_ -]{1,12}$/;

// Skill rows of a hiscore player page, as server.ts reads it: "<Board> <rank> <level> <time>" after tags are removed.
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
export function lookupView(name: string, rows: HiscoreRow[] | null, at: number | null, seen: Seen | undefined, now: number) {
    const online = !!seen && now - seen.seen < ONLINE_MS;
    return { name, at, rows, online, x: seen?.x ?? null, z: seen?.z ?? null, plane: seen?.level ?? null, combat: seen?.combat ?? null, lastSeen: seen?.seen ?? null };
}
