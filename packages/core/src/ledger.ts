// Tick ledger: what the account did on every logged-in tick, so a run can be reviewed tick by tick and the idle
// ticks found and cut (owner rule: every tick must be used). One kind per tick, by priority:
//   xp      some skill's XP rose this tick
//   inventory item ID/count totals changed (buy, bank, trade, consume or produce; not proof of net output)
//   move    the player's tile changed
//   anim    an animation is playing (skilling, stun, eating)
//   dialog  a dialog is open (level-up, NPC chat): usually waste to close fast; the row counts how long the same
//           words stay open (dialogTicks), which the stall check reads
//   stun    none of the above, inside the 8 ticks after "You've been stunned" (unavoidable wait)
//   idle    none of the above
// Attach with startLedger(session); call stop() to get the summary and print it with formatLedger.
// Each idle tick also gets a reason (idleWhy), counted in the LEDGER line as `idleBy=`: a fight between two swings
// (`combat`), damage in the last FIGHT_TICKS ticks with no fight (`hurt`: a failed pickpocket hurts the thief with no
// fight, thieving.rs2 fail_pick_pocket), an open bank, shop or other window, or else the type of the last action the script sent (`after:<type>`,
// `none` when it sent none). scripts/tick-waste.ts sums the reasons by script family.

export type TickKind = 'xp' | 'inventory' | 'move' | 'anim' | 'dialog' | 'stun' | 'idle';
// `dialogTicks`, on a dialog row of startLedger: the open-dialog ticks in a row that showed the same words, this one
// included (see dialogWords; a closed tick does not reset the count).
export interface TickRow { tick: number; kind: TickKind; at: string; why?: string; dialogTicks?: number }
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

// The words that an open dialog shows: its text, the texts of its components and the texts of its options. The
// pageId does not tell a new page: the client makes a new pageId each time the server sends a page, also the same page
// again (vendor/rs-sdk/server/webclient/src/bot/dialog-page.ts). A cook step that uses lobsters on a range below
// Cooking 40 gets the same "You need a Cooking level of 40" box every 10 ticks, each with a new pageId.
function dialogWords(d: any): string {
    let words = typeof d?.text === 'string' ? d.text : '';
    const parts = d?.allComponents;
    if (Array.isArray(parts)) for (let i = 0; i < parts.length; i++) words += '\u0001' + (parts[i]?.text ?? '');
    const options = d?.options;
    if (Array.isArray(options)) for (let i = 0; i < options.length; i++) words += '\u0002' + (options[i]?.text ?? '');
    return words;
}

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
        dialogWords: string;
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
        const dlg = s.sdk.getDialog?.();
        into.dialogOpen = !!(dlg?.isOpen ?? st?.dialog?.isOpen);
        into.dialogWords = into.dialogOpen ? dialogWords(dlg ?? st?.dialog) : '';
        into.hasInv = Array.isArray(st?.inventory);
        if (into.hasInv) fillInventoryTotals(st.inventory, into.inv);
        else into.inv.clear();
        into.fight = dealt;
        into.hurt = hit >= 0 && now - hit <= FIGHT_TICKS;
        into.bank = !!st?.bank?.isOpen;
        into.shop = !!st?.shop?.isOpen;
        into.window = !!st?.interface?.isOpen || !!st?.modalOpen;
    };
    let last: SnapState = { xp: 0, hasPlayer: false, x: 0, z: 0, level: 0, animId: -1, dialogOpen: false, dialogWords: '', hasInv: false, inv: new Map(), fight: false, hurt: false, bank: false, shop: false, window: false };
    let cur: SnapState = { xp: 0, hasPlayer: false, x: 0, z: 0, level: 0, animId: -1, dialogOpen: false, dialogWords: '', hasInv: false, inv: new Map(), fight: false, hurt: false, bank: false, shop: false, window: false };
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
    // The words of the last open dialog and the open-dialog ticks that showed them in a row (TickRow.dialogTicks).
    let shownWords: string | null = null, shownTicks = 0;
    const off = s.onTick(() => {
        readSnap(cur);
        const tick = s.tick();
        if (cur.dialogOpen) {
            shownTicks = cur.dialogWords === shownWords ? shownTicks + 1 : 1;
            shownWords = cur.dialogWords;
        }
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
            ...(kind === 'idle' ? { why: idleWhy(cur, lastAction()) } : kind === 'dialog' ? { dialogTicks: shownTicks } : {}),
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

// A session is stalled when its last `window` ticks hold no xp, no inventory change, no new dialog and no journey:
// walking, waiting or animating that long without gaining anything is a loop (a bank trip that cannot take food, a
// chop with no logs), not work. bot.ts stops such a session.
// A journey counts: a tile FAR_WALK or more from the tile at the window's start is travel (quest-sweep walks
// Port Sarim to the Sinclair Mansion in about 1,200 ticks with nothing else changing), while pacing near one tile is not.
// A dialog tick counts while its words are new: for the first DIALOG_TICKS open-dialog ticks that show the same words
// (TickRow.dialogTicks). A quest talk shows new words on each page every few ticks, so it does not stall. A dialog
// that shows the same words for DIALOG_TICKS ticks and then a full window stalls: a cook step below the food's level
// gets one "You need a Cooking level of 40" box for ever. A row without dialogTicks counts as a new dialog.
export const FAR_WALK = 20;
export const DIALOG_TICKS = 300;
const tile = (at: string): [number, number] | null => {
    const comma = at.indexOf(',');
    if (comma <= 0 || comma >= at.length - 1) return null;
    const x = Number(at.slice(0, comma)), z = Number(at.slice(comma + 1));
    return Number.isInteger(x) && Number.isInteger(z) ? [x, z] : null;
};
// The stall window of a bank production run, from its expected rate in units a tick. Each unit or bank trip of such a
// run changes the pack, so a run that changes nothing for STALL_PACKS packs of expected work is a loop. The window is
// at least STALL_FLOOR ticks (a login, a bank walk under FAR_WALK tiles and a bank visit fit in it) and at most the
// session default of 900 ticks. The stop check runs every 50 ticks, so a stalled run ends within window + 50 ticks.
export const STALL_PACKS = 2;
export const STALL_FLOOR = 150;
export const STALL_CEILING = 900;
export function stallTicksForRate(unitsPerTick: number | undefined): number | undefined {
    if (unitsPerTick === undefined || !Number.isFinite(unitsPerTick) || unitsPerTick <= 0) return undefined;
    return Math.min(STALL_CEILING, Math.max(STALL_FLOOR, Math.ceil((STALL_PACKS * 28) / unitsPerTick)));
}

export function stalled(rows: readonly TickRow[], window: number): boolean {
    if (window <= 0 || rows.length < window) return false;
    const start = tile(rows[rows.length - window]!.at);
    for (let i = rows.length - window; i < rows.length; i++) {
        const r = rows[i]!;
        if (r.kind === 'xp' || r.kind === 'inventory') return false;
        if (r.kind === 'dialog' && (r.dialogTicks ?? 1) <= DIALOG_TICKS) return false;
        const t = start && tile(r.at);
        if (t && Math.max(Math.abs(t[0] - start![0]), Math.abs(t[1] - start![1])) >= FAR_WALK) return false;
    }
    return true;
}
