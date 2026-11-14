// A trip may stop at a bank first: an account with its coins in the bank cannot pay a boat until it takes
// fares out. planTrip compares the direct route with "walk to a bank, take what the route needs, go on" for
// the nearest banks, and keeps the cheaper. It takes coins for fares and the runes, jewellery and passes the
// route after the bank uses.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Account, Leg, RouteOptions, Tile, World } from './world';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
export const BANK_STOP_COST = 10; // estimate in ticks: open the bank, withdraw, close
export const TRIP_COINS = 1000;   // the most coins a plan counts on taking for fares
const DIRECT_GOOD_ENOUGH = 150;   // a direct route this cheap is not compared with bank stops
const cheb = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

export type BankStock = { coins: number; items?: Record<string, number> };
export type TripPlan = { cost: number; legs: Leg[]; bank?: { at: Tile; coins: number; items: Record<string, number>; then: Leg[] } };
const BANK_ITEM_CAP = 100; // runes or passes a plan may count on taking from the bank

// Items the legs use up or need in the pack: spell runes, one charged jewellery item, consumed passes.
export function itemsFor(legs: Leg[], counts: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const l of legs) {
        if (l.kind !== 'travel') continue;
        for (const r of l.travel.runes) out[r.item] = (out[r.item] ?? 0) + r.count;
        for (const n of l.travel.needs) if ('held' in n) out[n.held] = Math.max(out[n.held] ?? 0, n.count);
        if (l.travel.run.how === 'rub') { const j = l.travel.run.items.find(i => (counts[i] ?? 0) > 0); if (j) out[j] = Math.max(out[j] ?? 0, 1); }
    }
    return out;
}

// The bank stand tiles packages/planner/src/haggis-travel.json lists (each walked to live by quest-sweep).
let banks: Tile[] | undefined;
export function knownBanks(): Tile[] {
    return banks ??= Object.values((JSON.parse(readFileSync(join(repoRoot, 'packages', 'planner', 'src', 'haggis-travel.json'), 'utf8')) as { banks: Record<string, Tile> }).banks)
        .map(b => ({ x: b.x, z: b.z, level: b.level }));
}

export function planTrip(world: World, from: Tile, to: Tile, acct: Account, stock: BankStock | undefined, bankTiles: Tile[] = knownBanks(), nearest = 3, routeOpts?: RouteOptions): TripPlan | null {
    const direct = world.route(from, to, acct, routeOpts);
    let best: TripPlan | null = direct.ok ? { cost: direct.cost, legs: direct.legs } : null;
    const held = acct.coins ?? 0, take = Math.min(stock?.coins ?? 0, Math.max(0, TRIP_COINS - held));
    const banked = Object.entries(stock?.items ?? {}).filter(([, n]) => n > 0);
    if ((take <= 0 && !banked.length) || (best && best.cost <= DIRECT_GOOD_ENOUGH)) return best;
    const counts = { ...acct.counts };
    for (const [i, n] of banked) counts[i] = (counts[i] ?? 0) + Math.min(n, BANK_ITEM_CAP);
    const richer: Account = { ...acct, coins: held + take, counts, items: [...new Set([...acct.items, ...banked.map(([i]) => i)])] };
    // With no fare coins to take and no travel or key door that the bank's items open, a bank stop gives the same routes
    // as the direct search plus a detour, so it is never cheaper. Each bank search costs a full route search (about 10 s
    // from Varrock West to Port Sarim; the 3 banks made the plan 40 s against 11 s direct, with the same cost).
    if (best && take <= 0 && world.routeGain && !world.routeGain(acct, richer)) return best;
    for (const bank of [...bankTiles].filter(b => b.level === from.level).sort((a, b) => cheb(a, from) - cheb(b, from)).slice(0, nearest)) {
        const there = world.route(from, bank, acct, routeOpts);
        if (!there.ok || (best && there.cost + BANK_STOP_COST >= best.cost)) continue;
        const on = world.route(bank, to, richer, routeOpts);
        if (!on.ok) continue;
        const cost = there.cost + BANK_STOP_COST + on.cost;
        if (!best || cost < best.cost) {
            const want = itemsFor(on.legs, counts), items: Record<string, number> = {};
            for (const [i, n] of Object.entries(want)) { const short = n - (acct.counts?.[i] ?? 0); if (short > 0) items[i] = short; }
            // Fares for the legs after the bank, twice over for the way back, within what the bank holds.
            const fares = on.legs.reduce((n, l) => n + (l.kind === 'travel' ? l.travel.coins : 0), 0);
            best = { cost, legs: there.legs, bank: { at: bank, coins: Math.min(take, Math.max(0, 2 * fares - held)), items, then: on.legs } };
        }
    }
    return best;
}

// The last bank snapshot the status file holds (packages/core/src/status.ts writes it when a bank is open).
export function bankStock(name: string): BankStock | undefined {
    try {
        const st = JSON.parse(readFileSync(join(repoRoot, '.practice', 'status', `${name}.json`), 'utf8')) as { bank?: { id: number; count: number }[] };
        if (!Array.isArray(st.bank)) return undefined;
        const items: Record<string, number> = {};
        for (const i of st.bank) { const n = itemName(i.id); if (n && i.id !== 995) items[n] = (items[n] ?? 0) + i.count; }
        return { coins: st.bank.filter(i => i.id === 995).reduce((n, i) => n + i.count, 0), items };
    } catch { return undefined; }
}

let names: Map<number, string> | undefined, ids: Map<string, number> | undefined;
const items = () => (JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'items.json'), 'utf8')) as { id: number; debugname: string }[]);
export const itemName = (id: number) => (names ??= new Map(items().map(i => [i.id, i.debugname]))).get(id);
export const itemIdOf = (name: string) => (ids ??= new Map(items().map(i => [i.debugname, i.id]))).get(name);

type BankSession = { tick(): number; sdk: { getState(): any }; bot: { openBank(): Promise<{ success: boolean; message?: string }>; withdrawItem(row: unknown, count: number): Promise<unknown>; closeBank(): Promise<unknown> } };
// Opens the nearest bank and takes `coins` coins and `items` (debugname -> count). Ok when the pack gained them all.
export async function takeItems(s: BankSession, coins: number, want: Record<string, number>, waitTicks: (n: number) => Promise<unknown>): Promise<{ ok: boolean; detail: string }> {
    const held = (id: number) => (s.sdk.getState()?.inventory ?? []).filter((i: any) => i.id === id).reduce((n: number, i: any) => n + i.count, 0);
    const list = [...(coins > 0 ? [[995, coins] as const] : []), ...Object.entries(want).map(([n, c]) => [itemIdOf(n), c] as const)];
    if (list.some(([id]) => id === undefined)) return { ok: false, detail: `unknown item in ${JSON.stringify(want)}` };
    const opened = await s.bot.openBank();
    if (!opened.success) return { ok: false, detail: `bank did not open: ${opened.message ?? ''}` };
    for (let i = 0; i < 10 && !(s.sdk.getState()?.bank?.items?.length); i++) await waitTicks(1);
    const short: string[] = [];
    for (const [id, n] of list as [number, number][]) {
        const row = (s.sdk.getState()?.bank?.items ?? []).find((i: any) => i.id === id), before = held(id);
        if (!row) { short.push(`${id}:none`); continue; }
        await s.bot.withdrawItem(row, Math.min(n, row.count));
        for (let i = 0; i < 5 && held(id) < before + Math.min(n, row.count); i++) await waitTicks(1);
        if (held(id) < before + Math.min(n, row.count)) short.push(`${id}:${held(id) - before}/${n}`);
    }
    await s.bot.closeBank();
    return short.length ? { ok: false, detail: `withdraw short ${short.join(',')}` } : { ok: true, detail: `took ${list.map(([id, n]) => `${id}x${n}`).join(',')}` };
}
