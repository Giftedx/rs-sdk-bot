// A trip may stop at a bank first: an account with its coins in the bank cannot pay a boat until it takes
// fares out. planTrip compares the direct route with "walk to a bank, take what the route needs, go on" for
// the nearest banks, and keeps the cheaper. Only coins are taken; a route needs no other bank item yet.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Account, Leg, Tile, World } from './world';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
export const BANK_STOP_COST = 10; // estimate in ticks: open the bank, withdraw, close
export const TRIP_COINS = 1000;   // coins taken for fares: two boats each way cost 120
const DIRECT_GOOD_ENOUGH = 150;   // a direct route this cheap is not compared with bank stops
const cheb = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

export type BankStock = { coins: number };
export type TripPlan = { cost: number; legs: Leg[]; bank?: { at: Tile; coins: number; then: Leg[] } };

// The bank stand tiles packages/planner/src/haggis-travel.json lists (each walked to live by quest-sweep).
let banks: Tile[] | undefined;
export function knownBanks(): Tile[] {
    return banks ??= Object.values((JSON.parse(readFileSync(join(repoRoot, 'packages', 'planner', 'src', 'haggis-travel.json'), 'utf8')) as { banks: Record<string, Tile> }).banks)
        .map(b => ({ x: b.x, z: b.z, level: b.level }));
}

export function planTrip(world: World, from: Tile, to: Tile, acct: Account, stock: BankStock | undefined, bankTiles: Tile[] = knownBanks(), nearest = 3): TripPlan | null {
    const direct = world.route(from, to, acct);
    let best: TripPlan | null = direct.ok ? { cost: direct.cost, legs: direct.legs } : null;
    const held = acct.coins ?? 0, take = Math.min(stock?.coins ?? 0, Math.max(0, TRIP_COINS - held));
    if (take <= 0 || (best && best.cost <= DIRECT_GOOD_ENOUGH)) return best;
    const richer: Account = { ...acct, coins: held + take };
    for (const bank of [...bankTiles].filter(b => b.level === from.level).sort((a, b) => cheb(a, from) - cheb(b, from)).slice(0, nearest)) {
        const there = world.route(from, bank, acct);
        if (!there.ok || (best && there.cost + BANK_STOP_COST >= best.cost)) continue;
        const on = world.route(bank, to, richer);
        if (!on.ok) continue;
        const cost = there.cost + BANK_STOP_COST + on.cost;
        if (!best || cost < best.cost) best = { cost, legs: there.legs, bank: { at: bank, coins: take, then: on.legs } };
    }
    return best;
}

// The last bank snapshot the status file holds (packages/core/src/status.ts writes it when a bank is open).
export function bankStock(name: string): BankStock | undefined {
    try {
        const st = JSON.parse(readFileSync(join(repoRoot, '.practice', 'status', `${name}.json`), 'utf8')) as { bank?: { id: number; count: number }[] };
        if (!Array.isArray(st.bank)) return undefined;
        return { coins: st.bank.filter(i => i.id === 995).reduce((n, i) => n + i.count, 0) };
    } catch { return undefined; }
}

type BankSession = { tick(): number; sdk: { getState(): any }; bot: { openBank(): Promise<{ success: boolean; message?: string }>; withdrawItem(row: unknown, count: number): Promise<unknown>; closeBank(): Promise<unknown> } };
// Opens the nearest bank and takes `coins` coins. Ok when the pack holds at least that many more coins.
export async function takeCoins(s: BankSession, coins: number, waitTicks: (n: number) => Promise<unknown>): Promise<{ ok: boolean; detail: string }> {
    const held = () => (s.sdk.getState()?.inventory ?? []).filter((i: any) => i.id === 995).reduce((n: number, i: any) => n + i.count, 0);
    const before = held(), opened = await s.bot.openBank();
    if (!opened.success) return { ok: false, detail: `bank did not open: ${opened.message ?? ''}` };
    for (let i = 0; i < 10 && !(s.sdk.getState()?.bank?.items?.length); i++) await waitTicks(1);
    const row = (s.sdk.getState()?.bank?.items ?? []).find((i: any) => i.id === 995);
    if (!row) { await s.bot.closeBank(); return { ok: false, detail: 'no coins in bank' }; }
    await s.bot.withdrawItem(row, Math.min(coins, row.count));
    for (let i = 0; i < 5 && held() < before + Math.min(coins, row.count); i++) await waitTicks(1);
    await s.bot.closeBank();
    return held() >= before + Math.min(coins, row.count) ? { ok: true, detail: `took ${held() - before} coins` } : { ok: false, detail: `withdraw short: ${held() - before} of ${coins}` };
}
