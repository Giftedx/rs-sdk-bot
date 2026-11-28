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
export type StandStillStreak = { start: number; length: number; at: string; why: string };
export interface LedgerLiveSnapshot {
    ticks: number;
    idle: number;
    idlePct: number;
    standStill: number;
    standStillPct: number;
    windowTicks: number;
    windowIdlePct: number;
    windowStandStillPct: number;
    currentIdle: number;
    currentStandStill: number;
    currentStandStillAt: string | null;
    currentStandStillWhy: string | null;
    maxStandStill: number;
    maxStandStillAt: string | null;
    maxStandStillWhy: string | null;
    longestIdle: number;
    longestIdleAt: string | null;
    currentDialogTicks: number;
    maxDialogTicks: number;
    currentWindowTicks: number;
    currentWindowKind: 'bank' | 'shop' | 'window' | null;
    maxWindowTicks: number;
    currentMoveStreak: number;
    maxMoveStreak: number;
    lastAction: string | null;
    idleBy: Record<string, number>;
    topIdleBy: [string, number][];
    script: string | null;
}
// Ticks after a hit on the player in which an idle tick with no fight counts as `hurt`.
export const FIGHT_TICKS = 8;

// Optional explicit phase tag per session (e.g. `route-plan`, `trade-wait`) so pre-action idle ticks do not read `none`.
const sessionPhases = new WeakMap<object, string>();
export function setLedgerPhase(session: object, phase: string | null): void {
    if (phase && phase.trim()) sessionPhases.set(session, phase.trim());
    else sessionPhases.delete(session);
}
export function ledgerPhaseOf(session: object): string | null {
    return sessionPhases.get(session) ?? null;
}

const ROUTE_PHASE_RE = /\b(?:walk|route|travel|path|goTo)\b/i;
const TRADE_PHASE_RE = /\b(?:trade|partner|meet|handoff|wait(?:ing)?\s+for)\b/i;
export function phaseIdleReason(phase: string | null | undefined): string | null {
    if (!phase) return null;
    const trimmed = phase.trim();
    if (!trimmed) return null;
    if (trimmed === 'route-plan' || trimmed === 'trade-wait') return trimmed;
    if (TRADE_PHASE_RE.test(trimmed)) return 'trade-wait';
    if (ROUTE_PHASE_RE.test(trimmed)) return 'route-plan';
    return null;
}

// Idle ticks caused by active combat swings (`combat`) or recent damage (`hurt`) are combat ticks, not standing still.
export function isStandingStillReason(why: string | undefined): boolean {
    return why !== 'combat' && why !== 'hurt';
}

const MULTI_DISPATCH_SCRIPTS = new Set(['aio', 'aio-skiller', 'aio-combat', 'aio-market', 'aio-logistics', 'aio-quester']);
const SAFE_SCRIPT_TOKEN = /[^A-Za-z0-9_./:-]/g;

// Compact script/job identifier for LEDGER lines and live status snapshots (e.g. `aio-logistics:walk-to`, `goldfarm`).
export function ledgerScriptId(script: string | undefined, argv: readonly string[] = [], account?: string): string | null {
    const raw = (script ?? '').trim();
    if (!raw) return null;
    const base = raw.split(/[\\/]/).pop()?.replace(/\.(?:ts|js|mjs|cjs)$/i, '').trim() ?? '';
    if (!base) return null;
    const acctLower = account?.trim().toLowerCase();
    const rest = argv.filter((a, idx) => {
        if (typeof a !== 'string' || !a.trim()) return false;
        if (idx === 0 && acctLower && a.trim().toLowerCase() === acctLower) return false;
        return true;
    });
    if (MULTI_DISPATCH_SCRIPTS.has(base.toLowerCase())) {
        const sub: string[] = [];
        for (const arg of rest) {
            if (arg.startsWith('-') || arg.includes('=')) continue;
            if (/^\d+$/.test(arg)) break;
            const clean = arg.trim().replace(SAFE_SCRIPT_TOKEN, '');
            if (!clean) continue;
            sub.push(clean);
            if (sub.length >= 2) break;
        }
        if (sub.length) return `${base.replace(SAFE_SCRIPT_TOKEN, '')}:${sub.join('/')}`.slice(0, 64);
    }
    const cleanBase = base.replace(SAFE_SCRIPT_TOKEN, '');
    return cleanBase ? cleanBase.slice(0, 64) : null;
}

// The reason for one idle tick, from the state of that tick, an explicit phase tag (setLedgerPhase), the last action
// the script sent, and any passive status phase fallback.
export function idleWhy(now: any, lastAction: string | null, phase?: string | null, explicitPhase?: string | null): string {
    if (now?.fight) return 'combat';
    if (now?.hurt) return 'hurt';
    if (now?.bank) return 'bank';
    if (now?.shop) return 'shop';
    if (now?.window) return 'window';
    const explicit = phaseIdleReason(explicitPhase);
    if (explicit) return explicit;
    if (lastAction) return `after:${lastAction}`;
    return phaseIdleReason(phase) ?? 'none';
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

// Counters for the summary: a count of each kind, the idle reasons, standing-still counters/streaks, and the five
// longest idle streaks. A session holds these, not every row, so its memory stays bounded over any run length.
export class TickTally {
    ticks = 0;
    standStill = 0;
    readonly counts: Record<TickKind, number> = { xp: 0, inventory: 0, move: 0, anim: 0, dialog: 0, stun: 0, idle: 0 };
    private readonly why = new Map<string, number>();
    private readonly longest: Streak[] = [];
    private open: Streak | null = null;
    private openStandStill: StandStillStreak | null = null;
    private bestStandStill: StandStillStreak | null = null;
    private curDialog = 0;
    private bestDialog = 0;
    private curMove = 0;
    private bestMove = 0;
    add(r: TickRow): void {
        this.ticks++;
        this.counts[r.kind]++;
        if (r.kind === 'dialog') {
            this.curDialog++;
            if (this.curDialog > this.bestDialog) this.bestDialog = this.curDialog;
        } else {
            this.curDialog = 0;
        }
        if (r.kind === 'move') {
            this.curMove++;
            if (this.curMove > this.bestMove) this.bestMove = this.curMove;
        } else if (r.kind === 'xp' || r.kind === 'inventory') {
            this.curMove = 0;
        }
        if (r.kind !== 'idle') { this.close(); this.closeStandStill(); return; }
        const reason = r.why ?? 'none';
        this.why.set(reason, (this.why.get(reason) ?? 0) + 1);
        if (this.open) this.open.length++;
        else this.open = { start: r.tick, length: 1, at: r.at };
        if (isStandingStillReason(reason)) {
            this.standStill++;
            if (this.openStandStill) {
                this.openStandStill.length++;
                this.openStandStill.why = reason;
            } else {
                this.openStandStill = { start: r.tick, length: 1, at: r.at, why: reason };
            }
        } else {
            this.closeStandStill();
        }
    }
    private close(): void {
        if (this.open) offerStreak(this.longest, this.open);
        this.open = null;
    }
    private closeStandStill(): void {
        if (this.openStandStill) {
            if (!this.bestStandStill
                || this.openStandStill.length > this.bestStandStill.length
                || (this.openStandStill.length === this.bestStandStill.length && this.openStandStill.start < this.bestStandStill.start)) {
                this.bestStandStill = { ...this.openStandStill };
            }
        }
        this.openStandStill = null;
    }
    currentIdle(): Streak | null {
        return this.open ? { ...this.open } : null;
    }
    longestIdleTop(): Streak | null {
        const best = this.longest[0] ?? null, cur = this.open;
        if (!cur) return best ? { ...best } : null;
        if (!best || cur.length > best.length || (cur.length === best.length && cur.start < best.start)) return { ...cur };
        return { ...best };
    }
    currentDialog(): { current: number; max: number } {
        return { current: this.curDialog, max: this.bestDialog };
    }
    currentMove(): { current: number; max: number } {
        return { current: this.curMove, max: this.bestMove };
    }
    currentStandStill(): StandStillStreak | null {
        return this.openStandStill ? { ...this.openStandStill } : null;
    }
    maxStandStill(): StandStillStreak | null {
        const best = this.bestStandStill, cur = this.openStandStill;
        if (!cur) return best ? { ...best } : null;
        if (!best || cur.length > best.length || (cur.length === best.length && cur.start < best.start)) return { ...cur };
        return { ...best };
    }
    topIdleBy(limit = 6): [string, number][] {
        return [...this.why].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit);
    }
    summary(xpGain = 0, script: string | null = null) {
        // The open streak is a streak too. Offer it to a copy, so the tally keeps counting.
        const longest = this.longest.map(s => ({ ...s }));
        if (this.open) offerStreak(longest, this.open);
        const idleBy = this.topIdleBy(6);
        const standStillPct = this.ticks ? (100 * this.standStill) / this.ticks : 0;
        const maxStandStill = this.maxStandStill();
        return {
            ticks: this.ticks,
            counts: { ...this.counts },
            idlePct: this.ticks ? (100 * this.counts.idle) / this.ticks : 0,
            standStill: this.standStill,
            standStillPct,
            maxStandStill,
            longestIdle: longest,
            xpGain,
            idleBy,
            ...(script ? { script } : {}),
        };
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
// `startLedger` also intercepts `s.direct` and `s.sdk.send` directly so sessions without randomEvents (e.g.
// RANDOM_EVENTS=0, record runs, or direct openBot scripts) still attribute idle ticks to their last dispatched action.
// `keep` is the number of newest rows that `rows` holds (at least the stall window of `stalled`); older rows only
// count in the tally. `rows` holds between `keep` and 2 x `keep` rows.
export function startLedger(
    s: { sdk: { getState(): any; getDialog?(): any; send?: (msg: any) => unknown }; direct?: (a: any) => unknown; onTick(cb: () => void): () => void; tick(): number },
    lastAction: () => string | null = () => null,
    keep = LEDGER_KEEP,
    opts: { script?: string | null; phase?: () => string | null } = {},
) {
    const rows: TickRow[] = [], tally = new TickTally(), floor = Number.isFinite(keep) ? Math.max(1, keep) : LEDGER_KEEP;
    const scriptId = opts.script ?? null;
    const STUN_RE = /stunned/i;
    let stopped = false;
    let effectiveAction: string | null = null;
    let lastExternalAction: string | null = null;
    const noteDispatched = (action: any) => {
        if (stopped || !action || typeof action.type !== 'string' || action.type === 'togglePrayer') return;
        effectiveAction = action.reason === 'random-event' ? 'random-event' : action.type;
    };
    const sessAny = s as any;
    const sdkAny = s.sdk as any;
    const origDirect = sessAny.direct;
    let directWrapper: ((a: any) => unknown) | undefined;
    if (typeof origDirect === 'function') {
        const bound = origDirect.bind(sessAny);
        directWrapper = (a: any) => { noteDispatched(a); return bound(a); };
        sessAny.direct = directWrapper;
    }
    const origSend = sdkAny?.send;
    let sendWrapper: ((msg: any) => unknown) | undefined;
    if (typeof origSend === 'function') {
        const bound = origSend.bind(sdkAny);
        sendWrapper = (msg: any) => { if (msg?.type === 'sdk_action') noteDispatched(msg.action); return bound(msg); };
        sdkAny.send = sendWrapper;
    }
    const resolveLastAction = (): string | null => {
        const external = lastAction();
        if (external !== lastExternalAction) {
            lastExternalAction = external;
            if (external !== null) effectiveAction = external;
            else if (!directWrapper && !sendWrapper) effectiveAction = null;
        }
        return effectiveAction ?? external;
    };
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
    let curWindowTicks = 0, maxWindowTicks = 0;
    let curWindowKind: 'bank' | 'shop' | 'window' | null = null;
    const off = s.onTick(() => {
        readSnap(cur);
        const tick = s.tick();
        if (cur.dialogOpen) {
            shownTicks = cur.dialogWords === shownWords ? shownTicks + 1 : 1;
            shownWords = cur.dialogWords;
        }
        const winKind: 'bank' | 'shop' | 'window' | null = cur.bank ? 'bank' : cur.shop ? 'shop' : cur.window ? 'window' : null;
        if (winKind) {
            curWindowTicks = curWindowKind === winKind ? curWindowTicks + 1 : 1;
            curWindowKind = winKind;
            if (curWindowTicks > maxWindowTicks) maxWindowTicks = curWindowTicks;
        } else {
            curWindowTicks = 0;
            curWindowKind = null;
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
        const explicitPhase = ledgerPhaseOf(s);
        const fallbackPhase = opts.phase?.() ?? null;
        const row: TickRow = {
            tick,
            kind,
            at: cur.hasPlayer ? `${cur.x},${cur.z}` : 'undefined,undefined',
            ...(kind === 'idle' ? { why: idleWhy(cur, resolveLastAction(), fallbackPhase, explicitPhase) } : kind === 'dialog' ? { dialogTicks: shownTicks } : {}),
        };
        tally.add(row);
        rows.push(row);
        if (rows.length >= 2 * floor) rows.splice(0, rows.length - floor);
        const tmp = last; last = cur; cur = tmp;
    });
    const snapshot = (window = 300): LedgerLiveSnapshot => {
        const w = Math.min(rows.length, Math.max(1, window));
        const startIdx = rows.length - w;
        let wIdle = 0, wStandStill = 0;
        for (let i = startIdx; i < rows.length; i++) {
            const r = rows[i]!;
            if (r.kind === 'idle') {
                wIdle++;
                if (isStandingStillReason(r.why)) wStandStill++;
            }
        }
        const curStand = tally.currentStandStill();
        const curIdle = tally.currentIdle();
        const bestStand = tally.maxStandStill();
        const topIdle = tally.longestIdleTop();
        const dlg = tally.currentDialog();
        const mv = tally.currentMove();
        const topBy = tally.topIdleBy(6);
        const round1 = (n: number) => Math.round(n * 10) / 10;
        return {
            ticks: tally.ticks,
            idle: tally.counts.idle,
            idlePct: tally.ticks ? round1((100 * tally.counts.idle) / tally.ticks) : 0,
            standStill: tally.standStill,
            standStillPct: tally.ticks ? round1((100 * tally.standStill) / tally.ticks) : 0,
            windowTicks: w,
            windowIdlePct: w > 0 ? round1((100 * wIdle) / w) : 0,
            windowStandStillPct: w > 0 ? round1((100 * wStandStill) / w) : 0,
            currentIdle: curIdle?.length ?? 0,
            currentStandStill: curStand?.length ?? 0,
            currentStandStillAt: curStand?.at ?? null,
            currentStandStillWhy: curStand?.why ?? null,
            maxStandStill: bestStand?.length ?? 0,
            maxStandStillAt: bestStand?.at ?? null,
            maxStandStillWhy: bestStand?.why ?? null,
            longestIdle: topIdle?.length ?? 0,
            longestIdleAt: topIdle?.at ?? null,
            currentDialogTicks: dlg.current,
            maxDialogTicks: dlg.max,
            currentWindowTicks: curWindowTicks,
            currentWindowKind: curWindowKind,
            maxWindowTicks,
            currentMoveStreak: mv.current,
            maxMoveStreak: mv.max,
            lastAction: resolveLastAction(),
            idleBy: Object.fromEntries(topBy),
            topIdleBy: topBy.slice(0, 4),
            script: scriptId,
        };
    };
    return {
        stop: () => {
            if (!stopped) {
                stopped = true;
                off();
                if (directWrapper && sessAny.direct === directWrapper) sessAny.direct = origDirect;
                if (sendWrapper && sdkAny.send === sendWrapper) sdkAny.send = origSend;
            }
            return tally.summary(Math.max(0, last.xp - xpStart), scriptId);
        },
        rows,
        /** Ticks of each kind so far, for the kinds that occurred. */
        counts: (): Record<string, number> => Object.fromEntries(Object.entries(tally.counts).filter(([, n]) => n > 0)),
        snapshot,
        lastAction: resolveLastAction,
    };
}

export function formatLedger(sum: ReturnType<typeof summarize>): string {
    const c = sum.counts;
    const maxStand = sum.maxStandStill ? `${sum.maxStandStill.length}@t${sum.maxStandStill.start}(${sum.maxStandStill.at})` : '0';
    return `LEDGER ticks=${sum.ticks} xp=${c.xp} inventory=${c.inventory} move=${c.move} anim=${c.anim} dialog=${c.dialog} stun=${c.stun} idle=${c.idle} idlePct=${sum.idlePct.toFixed(1)} xpGain=${sum.xpGain} `
        + `longestIdle=${sum.longestIdle.map(x => `${x.length}@t${x.start}(${x.at})`).join(',')}`
        + ` idleBy=${sum.idleBy.map(([why, n]) => `${why}:${n}`).join(',')}`
        + ` standStill=${sum.standStill} standStillPct=${sum.standStillPct.toFixed(1)} maxStandStill=${maxStand}`
        + (sum.script ? ` script=${sum.script}` : '');
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
