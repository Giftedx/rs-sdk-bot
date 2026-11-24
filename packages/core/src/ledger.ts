// Tick ledger: what the account did on every logged-in tick, so a run can be reviewed tick by tick and the idle
// ticks found and cut (owner rule: every tick must be used). One kind per tick, by priority:
//   xp      some skill's XP rose this tick
//   inventory item ID/count totals changed (buy, bank, trade, consume or produce; not proof of net output)
//   move    the player's tile changed
//   anim    an animation is playing (skilling, stun, eating)
//   dialog  a dialog is open (level-up, NPC chat): usually waste to close fast
//   stun    none of the above, inside the 8 ticks after "You've been stunned" (unavoidable wait)
//   idle    none of the above
// Attach with startLedger(session); call stop() to get the summary and print it with formatLedger.
// Each idle tick also gets a reason (idleWhy), counted in the LEDGER line as `idleBy=`: a fight between two swings
// (`combat`), damage in the last FIGHT_TICKS ticks with no fight (`hurt`: a failed pickpocket hurts the thief with no
// fight, thieving.rs2 fail_pick_pocket), an open bank, shop or other window, or else the type of the last action the script sent (`after:<type>`,
// `none` when it sent none). scripts/tick-waste.ts sums the reasons by script family.

export type TickKind = 'xp' | 'inventory' | 'move' | 'anim' | 'dialog' | 'stun' | 'idle';
export interface TickRow { tick: number; kind: TickKind; at: string; why?: string }
// Ticks after a hit on the player in which an idle tick with no fight counts as `hurt`.
export const FIGHT_TICKS = 8;

// The reason for one idle tick, from the state of that tick and the type of the script's last action.
export function idleWhy(now: any, lastAction: string | null): string {
    if (now?.fight) return 'combat';
    if (now?.hurt) return 'hurt';
    if (now?.bank) return 'bank';
    if (now?.shop) return 'shop';
    if (now?.window) return 'window';
    return lastAction ? `after:${lastAction}` : 'none';
}

const xpSum = (st: any) => {
    const skills = st?.skills;
    if (!skills) return 0;
    let total = 0;
    for (let i = 0; i < skills.length; i++) total += skills[i]?.experience ?? 0;
    return total;
};

function fillInventoryTotals(items: readonly any[], out: Map<number, number>): void {
    out.clear();
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item && Number.isInteger(item.id) && item.id >= 0 && Number.isFinite(item.count) && item.count > 0) {
            out.set(item.id, (out.get(item.id) ?? 0) + item.count);
        }
    }
}

function sameTotals(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean {
    if (a.size !== b.size) return false;
    for (const [id, count] of a) if (b.get(id) !== count) return false;
    return true;
}

const invScratchA = new Map<number, number>();
const invScratchB = new Map<number, number>();

export function classifyTick(before: any, now: any, stunned = false): TickKind {
    if (xpSum(now) > xpSum(before)) return 'xp';
    // Missing state is unknown, not an empty inventory. Establish a baseline first.
    if (Array.isArray(before?.inventory) && Array.isArray(now?.inventory)) {
        fillInventoryTotals(before.inventory, invScratchA);
        fillInventoryTotals(now.inventory, invScratchB);
        if (!sameTotals(invScratchA, invScratchB)) return 'inventory';
    }
    const a = before?.player, b = now?.player;
    if (a && b && (a.worldX !== b.worldX || a.worldZ !== b.worldZ || a.level !== b.level)) return 'move';
    if ((b?.animId ?? -1) !== -1) return 'anim';
    if (now?.dialog?.isOpen) return 'dialog';
    return stunned ? 'stun' : 'idle';
}

const LONGEST_IDLE = 5;
type Streak = { start: number; length: number; at: string };

// Counters for the summary: a count of each kind, the idle reasons and the five longest idle streaks. A session holds
// these, not every row, so its memory does not grow with the run.
export class TickTally {
    ticks = 0;
    readonly counts: Record<TickKind, number> = { xp: 0, inventory: 0, move: 0, anim: 0, dialog: 0, stun: 0, idle: 0 };
    private readonly why = new Map<string, number>();
    private readonly longest: Streak[] = [];
    private open: Streak | null = null;
    add(r: TickRow): void {
        this.ticks++;
        this.counts[r.kind]++;
        if (r.kind !== 'idle') { this.close(); return; }
        const reason = r.why ?? 'none';
        this.why.set(reason, (this.why.get(reason) ?? 0) + 1);
        if (this.open) this.open.length++;
        else this.open = { start: r.tick, length: 1, at: r.at };
    }
    private close(): void {
        if (this.open) offerStreak(this.longest, this.open);
        this.open = null;
    }
    summary(xpGain = 0) {
        // The open streak is a streak too. Offer it to a copy, so the tally keeps counting.
        const longest = this.longest.map(s => ({ ...s }));
        if (this.open) offerStreak(longest, this.open);
        const idleBy = [...this.why].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6);
        return { ticks: this.ticks, counts: { ...this.counts }, idlePct: this.ticks ? (100 * this.counts.idle) / this.ticks : 0, longestIdle: longest, xpGain, idleBy };
    }
}

// Streaks arrive in start order. The list stays sorted by length (longest first), then by start.
function offerStreak(list: Streak[], s: Streak): void {
    const at = list.findIndex(x => s.length > x.length || (s.length === x.length && s.start < x.start));
    if (at >= 0) list.splice(at, 0, { ...s }); else list.push({ ...s });
    if (list.length > LONGEST_IDLE) list.length = LONGEST_IDLE;
}

export function summarize(rows: readonly TickRow[], xpGain = 0) {
    const tally = new TickTally();
    for (const r of rows) tally.add(r);
    return tally.summary(xpGain);
}

// Rows that a ledger keeps when the caller names no count: enough for the stall window (900 ticks) and the 300-tick timeline.
export const LEDGER_KEEP = 1024;

// `lastAction` returns the type of the last action the script sent, or null.
// `keep` is the number of newest rows that `rows` holds (at least the stall window of `stalled`); older rows only
// count in the tally. `rows` holds between `keep` and 2 x `keep` rows.
export function startLedger(s: { sdk: { getState(): any; getDialog?(): any }; onTick(cb: () => void): () => void; tick(): number }, lastAction: () => string | null = () => null, keep = LEDGER_KEEP) {
    const rows: TickRow[] = [], tally = new TickTally(), floor = Number.isFinite(keep) ? Math.max(1, keep) : LEDGER_KEEP;
    const STUN_RE = /stunned/i;
    type SnapState = {
        xp: number;
        hasPlayer: boolean;
        x: number;
        z: number;
        level: number;
        animId: number;
        dialogOpen: boolean;
        hasInv: boolean;
        inv: Map<number, number>;
        fight: boolean;
        hurt: boolean;
        bank: boolean;
        shop: boolean;
        window: boolean;
    };
    const readSnap = (into: SnapState): void => {
        const st = s.sdk.getState(), p = st?.player, hit = p?.combat?.lastDamageTick ?? -1, now = st?.tick ?? 0;
        let dealt = false;
        const events = st?.combatEvents;
        if (events?.length) {
            for (let i = 0; i < events.length; i++) {
                const e = events[i];
                if (e?.type === 'damage_dealt' && now - (e.tick ?? -Infinity) <= FIGHT_TICKS) { dealt = true; break; }
            }
        }
        into.xp = xpSum(st);
        into.hasPlayer = !!p;
        if (p) {
            into.x = p.worldX;
            into.z = p.worldZ;
            into.level = p.level;
            into.animId = p.animId ?? -1;
        } else {
            into.animId = -1;
        }
        into.dialogOpen = !!(s.sdk.getDialog?.()?.isOpen ?? st?.dialog?.isOpen);
        into.hasInv = Array.isArray(st?.inventory);
        if (into.hasInv) fillInventoryTotals(st.inventory, into.inv);
        else into.inv.clear();
        into.fight = dealt;
        into.hurt = hit >= 0 && now - hit <= FIGHT_TICKS;
        into.bank = !!st?.bank?.isOpen;
        into.shop = !!st?.shop?.isOpen;
        into.window = !!st?.interface?.isOpen || !!st?.modalOpen;
    };
    let last: SnapState = { xp: 0, hasPlayer: false, x: 0, z: 0, level: 0, animId: -1, dialogOpen: false, hasInv: false, inv: new Map(), fight: false, hurt: false, bank: false, shop: false, window: false };
    let cur: SnapState = { xp: 0, hasPlayer: false, x: 0, z: 0, level: 0, animId: -1, dialogOpen: false, hasInv: false, inv: new Map(), fight: false, hurt: false, bank: false, shop: false, window: false };
    readSnap(last);
    // Total XP over all skills at the start, so the summary can state the XP the run gained.
    const xpStart = last.xp;
    // The message list keeps only the newest messages, so its length stops growing: track the newest tick seen.
    let seenTick = -1;
    for (const m of s.sdk.getState()?.gameMessages ?? []) {
        const mt = m.tick ?? -1;
        if (mt > seenTick) seenTick = mt;
    }
    let stunUntil = -1;
    const off = s.onTick(() => {
        readSnap(cur);
        const tick = s.tick();
        const msgs = s.sdk.getState()?.gameMessages;
        if (msgs?.length) {
            let maxTick = seenTick;
            for (let i = 0; i < msgs.length; i++) {
                const m = msgs[i], mt = m.tick ?? -1;
                if (mt > seenTick && STUN_RE.test(m.text ?? '')) stunUntil = tick + 8;
                if (mt > maxTick) maxTick = mt;
            }
            seenTick = maxTick;
        }
        const kind: TickKind = cur.xp > last.xp ? 'xp'
            : cur.hasInv && last.hasInv && !sameTotals(last.inv, cur.inv) ? 'inventory'
            : last.hasPlayer && cur.hasPlayer && (last.x !== cur.x || last.z !== cur.z || last.level !== cur.level) ? 'move'
            : cur.animId !== -1 ? 'anim'
            : cur.dialogOpen ? 'dialog'
            : tick <= stunUntil ? 'stun' : 'idle';
        const row: TickRow = {
            tick,
            kind,
            at: cur.hasPlayer ? `${cur.x},${cur.z}` : 'undefined,undefined',
            ...(kind === 'idle' ? { why: idleWhy(cur, lastAction()) } : {}),
        };
        tally.add(row);
        rows.push(row);
        if (rows.length >= 2 * floor) rows.splice(0, rows.length - floor);
        const tmp = last; last = cur; cur = tmp;
    });
    return {
        stop: () => { off(); return tally.summary(Math.max(0, last.xp - xpStart)); },
        rows,
        /** Ticks of each kind so far, for the kinds that occurred. */
        counts: (): Record<string, number> => Object.fromEntries(Object.entries(tally.counts).filter(([, n]) => n > 0)),
    };
}

export function formatLedger(sum: ReturnType<typeof summarize>): string {
    const c = sum.counts;
    return `LEDGER ticks=${sum.ticks} xp=${c.xp} inventory=${c.inventory} move=${c.move} anim=${c.anim} dialog=${c.dialog} stun=${c.stun} idle=${c.idle} idlePct=${sum.idlePct.toFixed(1)} xpGain=${sum.xpGain} `
        + `longestIdle=${sum.longestIdle.map(x => `${x.length}@t${x.start}(${x.at})`).join(',')}`
        + ` idleBy=${sum.idleBy.map(([why, n]) => `${why}:${n}`).join(',')}`;
}

// A session is stalled when its last `window` ticks hold no xp, no inventory change and no dialog: walking,
// waiting or animating that long without gaining anything is a loop (a bank trip that cannot take food, a
// chop with no logs), not work. bot.ts stops such a session.
// A journey counts too: a tile FAR_WALK or more from the tile at the window's start is travel (quest-sweep walks
// Port Sarim to the Sinclair Mansion in about 1,200 ticks with nothing else changing), while pacing near one tile is not.
export const FAR_WALK = 20;
const tile = (at: string): [number, number] | null => {
    const comma = at.indexOf(',');
    if (comma <= 0 || comma >= at.length - 1) return null;
    const x = Number(at.slice(0, comma)), z = Number(at.slice(comma + 1));
    return Number.isInteger(x) && Number.isInteger(z) ? [x, z] : null;
};
export function stalled(rows: readonly TickRow[], window: number): boolean {
    if (window <= 0 || rows.length < window) return false;
    const start = tile(rows[rows.length - window]!.at);
    for (let i = rows.length - window; i < rows.length; i++) {
        const r = rows[i]!;
        if (r.kind === 'xp' || r.kind === 'inventory' || r.kind === 'dialog') return false;
        const t = start && tile(r.at);
        if (t && Math.max(Math.abs(t[0] - start![0]), Math.abs(t[1] - start![1])) >= FAR_WALK) return false;
    }
    return true;
}
