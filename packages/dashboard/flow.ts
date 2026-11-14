// Loot and supplies (RuneLite's Loot Tracker and the Supplies Used plugin) for the Activity plugin: what each account's
// pack and worn gear gained and lost between two status files of one session. A gain is loot (a pickup, a gathered
// item, a buy); a loss is a supply used (food eaten, runes cast, arrows fired, a sale). A change is not counted when
// the bank was seen between the two files (a deposit or a withdrawal), when either file has 0 hitpoints (a death), or
// when more than half of the item kinds vanish at once. Status files come every 5 ticks, so one change can join a
// pickup and an eat of the same item: these are observed changes, not exact loot.
import { hasPriceId, priceItemId, type PriceIdentity } from './item-prices';

export type FlowItem = PriceIdentity & { name: string; count: number };
type Flow = { session: string; since: number; at: number; carried: Map<string, FlowItem> | null; bankAt: unknown; loot: Map<string, FlowItem>; used: Map<string, FlowItem> };
type IdentityKind = 'legacy' | 'exact' | 'malformed' | 'mixed';

const nameOf = (n: unknown) => String(n ?? '').replace(/\s*\(noted\)\s*$/i, '').trim();
const kindOf = (i: FlowItem): IdentityKind => !hasPriceId(i) ? 'legacy' : priceItemId(i) === null ? 'malformed' : 'exact';
const keyOf = (i: FlowItem): string => {
    const id = priceItemId(i);
    return id !== null ? `id:${id}` : `${hasPriceId(i) ? 'invalid' : 'name'}:${i.name}`;
};
const mergeItem = (previous: FlowItem | undefined, item: FlowItem): FlowItem => {
    if (!previous) return { ...item };
    const out = { ...item, count: previous.count + item.count }, canonical = priceItemId(item);
    if (canonical !== null) {
        // A commodity total can join notes and normal items. Its raw form is known only when every contribution
        // has the same raw ID; a canonical-only contribution keeps the accumulated raw form unknown.
        if (!Object.hasOwn(previous, 'id') || !Object.hasOwn(item, 'id') || previous.id !== item.id) {
            delete out.id; out.baseId = canonical;
        } else if (Object.hasOwn(previous, 'baseId') || Object.hasOwn(item, 'baseId')) out.baseId = canonical;
    }
    return out;
};
const familiesOf = (items: Map<string, FlowItem>) => {
    const out = new Map<string, IdentityKind>();
    for (const item of items.values()) {
        const kind = kindOf(item), prev = out.get(item.name);
        out.set(item.name, !prev || prev === kind ? kind : 'mixed');
    }
    return out;
};

function carriedOf(s: any): Map<string, FlowItem> {
    const out = new Map<string, FlowItem>();
    for (const list of [s?.inventory, s?.equipment]) for (const i of Array.isArray(list) ? list : []) {
        const name = nameOf(i?.name);
        if (!name || !(i.count > 0)) continue;
        const item: FlowItem = { name, count: i.count };
        if (Object.hasOwn(i, 'id')) item.id = i.id;
        if (Object.hasOwn(i, 'baseId')) item.baseId = i.baseId;
        const key = keyOf(item), prev = out.get(key);
        out.set(key, mergeItem(prev, item));
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
    if (!Array.isArray(s.equipment) || s.equipmentObserved === false) { f.carried = null; f.bankAt = s.bankAt ?? null; f.at = at; return; }
    const now = carriedOf(s), prev = f.carried, dead = s.hp?.now === 0;
    if (prev && !dead && (s.bankAt ?? null) === f.bankAt) {
        const before = familiesOf(prev), after = familiesOf(now), gone = [...before.keys()].filter(name => !after.has(name)).length;
        // The sudden-loss guard counts display-name kinds, as it does for legacy observations. Variant changes
        // still need their exact deltas even when several IDs share one display name.
        if (!(before.size >= 4 && gone > before.size / 2)) {
            for (const key of new Set([...prev.keys(), ...now.keys()])) {
                const old = prev.get(key), current = now.get(key), item = current ?? old!, name = item.name;
                const from = before.get(name), to = after.get(name);
                // Identity enrichment is a baseline change, not loot. Mixed or malformed rows cannot attribute
                // a same-name change to an exact variant; unrelated display names still compare normally.
                if (from === 'mixed' || to === 'mixed' || from === 'malformed' || to === 'malformed' || from && to && from !== to) continue;
                const d = (current?.count ?? 0) - (old?.count ?? 0);
                const target = d > 0 ? f.loot : f.used, metadata = d > 0 ? current : old;
                if (d && metadata) target.set(key, mergeItem(target.get(key), { ...metadata, count: Math.abs(d) }));
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
    const top = (m: Map<string, FlowItem>) => [...m.values()].map(item => ({ ...item })).sort((a, b) => b.count - a.count);
    return { since: f.since, at: f.at, loot: top(f.loot), used: top(f.used) };
}
