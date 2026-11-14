// Fleet adoption: which accounts change side in fleet/owners.json, so no account sits idle because the machine that
// last ran it is gone. Every downstream rule (openBot, the swarm, the planner, fleet orders, resource claims) follows
// owners.json, so moving an owner row is the whole hand-over; the credential comes from the fleet vault.
// A side that runs its controller, in its own fleet sync:
//  - hands an account it adopted back to the account's home side once that side is live again (a lease renewal
//    within LIVE_MS), publishes room for it (fleet/sides/<side>.json capacity) and the account is idle (its fleet claim
//    is not held) and not paused by this side's owner; a side that hands back adopts nothing in the same pass;
//  - otherwise adopts, up to its own capacity, accounts whose side has gone STRANDED_MS without a lease renewal, whose
//    claim is free (not held, or a swarm claim the orphan rule in fleet-trade-claim.ts lets it replace) and whose
//    credential it holds. Its own accounts coming home go first, then by name.
// Never moved: the main account, the specialist accounts (they run under their own launch gates on the PC), an
// account its side's owner paused (a stop file the side published), every account of a side whose owner stopped its
// swarm, and an account in a held trade claim (the order settles first).
import { MAIN_ACCOUNT } from './haggisgate';
import { SPECIALIST_BOARDS } from './specialist-launch';

// Equal to ORPHAN_CLAIM_MS (fleet-trade-claim.test.ts checks), so an adopted account's old swarm claim is replaceable.
export const STRANDED_MS = 60 * 60_000;
export const LIVE_MS = 15 * 60_000;

export type OwnerRow = { side: string; server: string; home?: string; reservation?: string };
export type ClaimRow = { phase: 'held' | 'released'; kind?: string; side: string; at: number } | null;
// A side's card (fleet/sides/<side>.json) and its newest lease renewal.
export type SideView = { seen?: number | null; capacity?: number; paused?: string[]; stopped?: boolean };
export type Move = { account: string; from: string; to: string; home: string | null };

export function exempt(name: string): boolean {
    const n = name.toLowerCase();
    return n === MAIN_ACCOUNT || Object.hasOwn(SPECIALIST_BOARDS, n);
}

const live = (v: SideView | undefined, now: number) => v?.seen != null && now - v.seen < LIVE_MS;
const stale = (v: SideView | undefined, now: number) => v?.seen == null || now - v.seen >= STRANDED_MS;

export function planTransfers(v: {
    side: string; capacity: number; owners: Record<string, OwnerRow>; sides: Record<string, SideView>;
    claims: ReadonlyMap<string, ClaimRow | undefined>; canLogin: (name: string) => boolean; now: number;
}): Move[] {
    const { side, owners, sides, claims, now } = v;
    const names = Object.keys(owners).sort((a, b) => a.localeCompare(b));
    const count = new Map<string, number>();
    for (const n of names) count.set(owners[n]!.side, (count.get(owners[n]!.side) ?? 0) + 1);
    const held = (n: string) => { const c = claims.get(n.toLowerCase()); return c === null || c?.phase === 'held'; };
    const paused = (n: string, s: string) => !!sides[s]?.stopped || (sides[s]?.paused ?? []).some(p => p.toLowerCase() === n.toLowerCase());

    const handback: Move[] = [];
    for (const n of names) {
        const o = owners[n]!;
        // An account this side's owner paused stays here: its stop file is on this machine, not the home side's.
        if (o.side !== side || !o.home || o.home === side || held(n) || paused(n, side)) continue;
        const home = sides[o.home];
        if (!live(home, now) || home!.stopped) continue;
        if ((home!.capacity ?? 0) - (count.get(o.home) ?? 0) <= 0) continue;
        handback.push({ account: n, from: side, to: o.home, home: null });
        count.set(o.home, (count.get(o.home) ?? 0) + 1);
    }
    if (handback.length) return handback;

    let room = v.capacity - (count.get(side) ?? 0);
    if (room <= 0) return [];
    const candidates = names.filter(n => {
        const o = owners[n]!;
        if (o.side === side || o.reservation || exempt(n) || paused(n, o.side) || !stale(sides[o.side], now)) return false;
        const c = claims.get(n.toLowerCase());
        if (c === null) return false;
        if (c?.phase === 'held') {
            if (c.kind !== 'swarm' || now - c.at < STRANDED_MS || c.side === side) return false;
            if (sides[c.side]?.seen == null || now - sides[c.side]!.seen! < STRANDED_MS) return false;
        }
        return v.canLogin(n);
    }).sort((a, b) => Number(owners[b]!.home === side) - Number(owners[a]!.home === side) || a.localeCompare(b));
    const out: Move[] = [];
    for (const n of candidates) {
        if (room-- <= 0) break;
        const o = owners[n]!, home = o.home ?? o.side;
        out.push({ account: n, from: o.side, to: side, home: home === side ? null : home });
    }
    return out;
}

// One commit message line for a set of moves.
export function describeMoves(moves: readonly Move[]): string {
    return moves.map(m => `${m.account} ${m.from}->${m.to}`).join(', ');
}
