// Loot and supplies (RuneLite's Loot Tracker and the Supplies Used plugin) for the Activity plugin: what each account's
// pack and worn gear gained and lost between two status files of one session. A gain is loot (a pickup, a gathered
// item, a buy); a loss is a supply used (food eaten, runes cast, arrows fired, a sale). A change is not counted when
// the bank was seen between the two files (a deposit or a withdrawal), when either file has 0 hitpoints (a death), or
// when more than half of the item kinds vanish at once. Status files come every 5 ticks, so one change can join a
// pickup and an eat of the same item: these are observed changes, not exact loot.

export type FlowItem = { name: string; count: number };
type Flow = { session: string; since: number; at: number; carried: Map<string, number> | null; bankAt: unknown; loot: Map<string, number>; used: Map<string, number> };

const nameOf = (n: unknown) => String(n ?? '').replace(/\s*\(noted\)\s*$/i, '').trim();

function carriedOf(s: any): Map<string, number> {
    const out = new Map<string, number>();
    for (const list of [s?.inventory, s?.equipment]) for (const i of Array.isArray(list) ? list : []) {
        const name = nameOf(i?.name);
        if (name && i.count > 0) out.set(name, (out.get(name) ?? 0) + i.count);
    }
    return out;
}

export function trackFlow(flows: Map<string, Flow>, s: any): void {
    if (!s?.name || !Array.isArray(s.inventory)) return;
    const session = JSON.stringify([s.server, s.started ?? null]), at = Number(s.at) || 0;
    let f = flows.get(s.name);
    if (!f || f.session !== session) { f = { session, since: at, at, carried: null, bankAt: s.bankAt ?? null, loot: new Map(), used: new Map() }; flows.set(s.name, f); }
    if (at <= f.at && f.carried) return;
    // Unknown worn gear (status.ts writes equipment: null when it is not observed) is not empty gear: no comparison
    // crosses it, and the next file with known gear starts a new baseline.
    if (!Array.isArray(s.equipment)) { f.carried = null; f.bankAt = s.bankAt ?? null; f.at = at; return; }
    const now = carriedOf(s), prev = f.carried, dead = s.hp?.now === 0;
    if (prev && !dead && (s.bankAt ?? null) === f.bankAt) {
        const gone = [...prev.keys()].filter(k => !now.has(k)).length;
        if (!(prev.size >= 4 && gone > prev.size / 2)) {
            for (const name of new Set([...prev.keys(), ...now.keys()])) {
                const d = (now.get(name) ?? 0) - (prev.get(name) ?? 0);
                if (d > 0) f.loot.set(name, (f.loot.get(name) ?? 0) + d);
                else if (d < 0) f.used.set(name, (f.used.get(name) ?? 0) - d);
            }
        }
    }
    f.carried = dead ? null : now; f.bankAt = s.bankAt ?? null; f.at = at;
}

// The flow of one account for the page: every item each way, and the time the counts started. The page draws the most
// valuable ones and adds up all of them.
// `at` is the last observation: a stopped account's rates end there.
export function flowView(flows: Map<string, Flow>, name: string): { since: number; at: number; loot: FlowItem[]; used: FlowItem[] } | null {
    const f = flows.get(name);
    if (!f || (!f.loot.size && !f.used.size)) return null;
    const top = (m: Map<string, number>) => [...m].map(([n, count]) => ({ name: n, count })).sort((a, b) => b.count - a.count);
    return { since: f.since, at: f.at, loot: top(f.loot), used: top(f.used) };
}
