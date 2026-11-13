// Givers: helper accounts that hand a consumable to a gatherer at its site by trade, so the gatherer never walks to a
// bank for it. Each giver takes an exact pack from its bank, walks next to the gatherer and waits; the gatherer calls
// handOver when its pack runs out, and the giver goes back to its bank for the next pack.
// The trade is ownedSwap (rune-carrier-trade.ts): both accounts request, the giver offers its complete count of the
// item, both accept both screens, and both packs must end exactly as planned. ownedSwap moves whole item counts, so a
// giver holds exactly the pack it gives.
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks} from '../packages/core/src/ticks';
import {ownedSwap} from './rune-carrier-trade';

type Pt = {x: number; z: number};
export type GiverSite = {
  // The bank the givers restock at; openBank walks to the nearest booth in view.
  bank: Pt;
  // Item ids the givers may hand over, the most wanted first. A pack is one id.
  ids: readonly number[];
};
export type Giver = {
  s: Session;
  // Holds its pack and stands next to the gatherer.
  ready: boolean;
  // The bank has none of the ids left.
  empty: boolean;
  id: number;
  // The count it holds when ready, and the count a staging flight asks the bank for.
  n: number;
  planned: number;
  flight?: Promise<void>;
  trades: number;
  retries: number;
  tradeTicks: number[];
  stageTicks: number[];
  failure?: string;
};

const cheb = (a: Pt, b: Pt) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const at = (s: Session): Pt | undefined => { const p = s.sdk.getState()?.player; return p ? {x: p.worldX, z: p.worldZ} : undefined; };
const held = (s: Session, id: number) => (s.sdk.getInventory() ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

export function newGiver(s: Session): Giver {
  return {s, ready: false, empty: false, id: 0, n: 0, planned: 0, trades: 0, retries: 0, tradeTicks: [], stageTicks: []};
}

// True when the giver stands on a tile beside the gatherer, north, south, east or west. A player interaction runs
// from such a tile; from a diagonal tile the gatherer steps first (bench engine trace: `act target=NetworkPlayer ...
// steps=1`), and then walks back to its tree.
export function beside(g: Giver, gatherer: Session): boolean {
  const a = at(g.s), b = at(gatherer);
  return !!a && !!b && Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1;
}

// Walk to a free tile beside the gatherer, the nearest of the four first.
async function follow(g: Giver, gatherer: Session) {
  const b = at(gatherer), a = at(g.s);
  if (!b || !a || beside(g, gatherer)) return;
  const tiles = [{x: b.x + 1, z: b.z}, {x: b.x - 1, z: b.z}, {x: b.x, z: b.z + 1}, {x: b.x, z: b.z - 1}].sort((p, q) => cheb(p, a) - cheb(q, a));
  for (const t of tiles) {
    await g.s.bot.walkTo(t.x, t.z, 0);
    if (beside(g, gatherer)) return;
  }
  // The gatherer moved meanwhile, or no tile was free: the caller sends the giver again (refollow).
}

// Take exactly n of the first id the bank holds (fewer when the bank has fewer), then stand next to the gatherer.
// Any other item of the ids in the pack goes back first, so the pack is one exact count.
export function stage(g: Giver, site: GiverSite, n: number, gatherer: Session): Promise<void> {
  g.ready = false;
  g.planned = n;
  const t0 = g.s.tick();
  g.flight = (async () => {
    const p = at(g.s);
    if (!p || cheb(p, site.bank) > 14) {
      const r = await g.s.bot.walkTo(site.bank.x, site.bank.z, 3);
      if (!r.success) throw Error(`giver ${g.s.name} walk to bank: ${r.message}`);
    }
    const o = await g.s.bot.openBank();
    if (!o.success) throw Error(`giver ${g.s.name} openBank: ${o.message}`);
    for (const id of site.ids) {
      const item = (g.s.sdk.getInventory() ?? []).find(i => i.id === id);
      if (item) await g.s.bot.depositItem(item, -1);
    }
    const bank = (g.s.sdk.getState()?.bank?.items ?? []) as {id: number; count: number; slot: number; name: string}[];
    const item = site.ids.map(id => bank.find(i => i.id === id && i.count > 0)).find(i => i);
    if (!item) { g.empty = true; await g.s.bot.closeBank(); return; }
    const take = Math.min(n, item.count);
    const w = await g.s.bot.withdrawItem(item, take, {asNote: false});
    if (!w.success || held(g.s, item.id) !== take) throw Error(`giver ${g.s.name} withdraw ${take} ${item.name}: ${w.message}`);
    await g.s.bot.closeBank();
    g.id = item.id;
    g.n = take;
    await follow(g, gatherer);
    g.ready = true;
    g.stageTicks.push(g.s.tick() - t0);
  })().catch(e => { g.failure = String(e); }).finally(() => { g.flight = undefined; });
  return g.flight;
}

// Move a ready giver next to the gatherer again (the gatherer moved to another tree).
export function refollow(g: Giver, gatherer: Session): void {
  if (g.flight || !g.ready || beside(g, gatherer)) return;
  g.flight = follow(g, gatherer).catch(e => { g.failure = String(e); }).finally(() => { g.flight = undefined; });
}

// The trade: the gatherer gives nothing and gets the giver's whole pack. Returns the ticks from the first request to
// both packs reconciled (ownedSwap). A trade takes 6 ticks in ownedSwap; one that has not reconciled after
// STUCK_TICKS is stopped, both windows close, and it starts again, at most 3 times. In practice a stuck trade
// followed an offer the server refused (engine trace `in InvButton ok=false`): ownedSwap sends each offer once and
// would wait out its 50 ticks.
const STUCK_TICKS = 14;
export async function handOver(gatherer: Session, g: Giver, stop: () => boolean = () => false): Promise<number> {
  if (!g.ready || held(g.s, g.id) !== g.n) throw Error(`giver ${g.s.name} not staged`);
  g.ready = false;
  const start = gatherer.tick(), before = held(gatherer, g.id);
  for (let attempt = 1; ; attempt++) {
    const t0 = gatherer.tick();
    try {
      await ownedSwap(gatherer, g.s, {}, {[g.id]: g.n}, () => stop() || gatherer.tick() - t0 > STUCK_TICKS);
      break;
    } catch (error) {
      if (stop()) throw error;
      for (const a of [gatherer, g.s]) await a.direct({type: 'closeModal', reason: 'SDK'});
      await waitTicks(gatherer, 1);
      // The items can move after the reconcile check gave up.
      if (held(gatherer, g.id) === before + g.n && held(g.s, g.id) === 0) break;
      if (held(g.s, g.id) !== g.n || attempt >= 3) throw Error(`giver ${g.s.name} trade: ${String(error)} after ${attempt} attempts`);
      g.retries++;
    }
  }
  const ticks = gatherer.tick() - start;
  g.trades++;
  g.tradeTicks.push(ticks);
  return ticks;
}

export const giverStats = (givers: readonly Giver[]) => givers.map(g => ({name: g.s.name, trades: g.trades, retries: g.retries, tradeTicks: g.tradeTicks, stageTicks: g.stageTicks, empty: g.empty, failure: g.failure}));

// Items on the way: the packs that ready givers hold and the packs that staging givers fetch.
export const staged = (givers: readonly Giver[]) => givers.reduce((n, g) => n + (g.ready ? g.n : g.flight && !g.empty ? g.planned : 0), 0);
