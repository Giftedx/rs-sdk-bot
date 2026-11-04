// Shared helpers for the supply-board floor scripts (scripts/measure/floor-<skill>.ts).
// Inputs go out with s.direct, which skips the SDK's one-at-a-time queue, so one tick can carry up to the
// engine's 5 user events (ClientGameProtCategory.ts:6). Extra events stay in the client buffer and the
// server decodes them on the next tick.
import type { Session } from '../../packages/core/src/inprocess';
import { waitTicks } from '../../packages/core/src/ticks';

export type Act = { type: string; [k: string]: unknown };

export interface Meter {
    skill: string;
    t0: number;
    sent: number; // inputs the client wrote
    refused: number; // inputs the client refused (no packet)
    perTickSent: Map<number, number>;
    levelTicks: number; // ticks spent clearing level-up dialogs
    levelClears: number;
    bankTicks: number; // ticks from the bank booth click until the first production input after the bank
    bankCycles: number;
    actions: number; // production actions seen (XP gains or product count changes)
    bands: Map<string, { xp: number; ticks: number; actions: number }>;
}

export function meter(s: Session, skill: string): Meter {
    return { skill, t0: s.tick(), sent: 0, refused: 0, perTickSent: new Map(), levelTicks: 0, levelClears: 0, bankTicks: 0, bankCycles: 0, actions: 0, bands: new Map() };
}

export async function send(s: Session, m: Meter, a: Act): Promise<boolean> {
    let r: any = await s.direct({ reason: 'SDK', ...a });
    // The client refuses a bank button (no packet) until the bank side inventory has its items, which can be a tick
    // after bank.isOpen reads true. Retry those on the next ticks instead of losing them.
    for (let k = 0; k < 3 && r?.success === false && /^bank(Deposit|Withdraw)$/.test(a.type); k++) {
        m.refused++;
        await waitTicks(s, 1);
        r = await s.direct({ reason: 'SDK', ...a });
    }
    const ok = r?.success !== false;
    if (ok) { m.sent++; m.perTickSent.set(s.tick(), (m.perTickSent.get(s.tick()) ?? 0) + 1); } else m.refused++;
    return ok;
}

// Throws once the session has ended: waitTicks then resolves at once and the tick counter stops, so a loop bounded
// by ticks would spin and eat memory (seen: 2.1 GB in floor-fm-rows.ts).
const endedSessions = new WeakSet<object>();
export async function tick(s: Session, n = 1): Promise<void> {
    if (!(s as any).__endWatch) { (s as any).__endWatch = true; void s.ended?.then(() => endedSessions.add(s)); }
    if (endedSessions.has(s)) throw new Error(`session ${s.name} ended`);
    await waitTicks(s, n);
    if (endedSessions.has(s)) throw new Error(`session ${s.name} ended`);
}
// FLOOR_DEBUG=1 prints new game messages and dialog text once per call.
let lastMsg = '';
export function debug(s: Session, tag: string) {
    if (process.env.FLOOR_DEBUG !== '1') return;
    const st: any = s.sdk.getState();
    const msgs = (st?.gameMessages ?? []).slice(-3).map((g: any) => g.text).join(' | ');
    if (msgs !== lastMsg) { lastMsg = msgs; console.log(`NOTE ${tag} t=${s.tick()} msgs: ${msgs}`); }
    if (st?.dialog?.isOpen) console.log(`NOTE ${tag} t=${s.tick()} dialog: ${st.dialog.text ?? ''} opts=${JSON.stringify(st.dialog.options?.map((o: any) => o.text))}`);
    if (st?.interface?.isOpen) console.log(`NOTE ${tag} t=${s.tick()} interface ${st.interface.interfaceId}`);
}
export const xp = (s: Session, skill: string) => s.sdk.getSkillXp(skill) ?? 0;
export const level = (s: Session, skill: string) => s.sdk.getSkill(skill)?.baseLevel ?? 0;
export const inv = (s: Session): any[] => s.sdk.getState()?.inventory ?? [];
export const slotOf = (s: Session, re: RegExp) => inv(s).find(i => re.test(i.name))?.slot;
export const countOf = (s: Session, re: RegExp) => inv(s).filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0);
export const slotsOf = (s: Session, re: RegExp) => inv(s).filter(i => re.test(i.name)).map(i => i.slot as number);
export const dialogOpen = (s: Session) => !!s.sdk.getState()?.dialog?.isOpen;
export const bankOpen = (s: Session) => !!s.sdk.getState()?.bank?.isOpen;
export const bankItems = (s: Session): any[] => (s.sdk.getState() as any)?.bank?.items ?? [];

// Clears queued level-up pages. mode 'close' sends CLOSE_MODAL each tick (Player.closeModal drops a paused
// script, Player.ts:817-835); mode 'click' sends one continue click each tick (the client latches one resume per
// page, Client.ts:2537-2556). Returns the ticks spent.
export async function clearDialogs(s: Session, m: Meter, mode: 'close' | 'click' = 'close', cap = 200): Promise<number> {
    const t0 = s.tick();
    // Sends until the client shows no dialog; openBank closes any page that comes back after that.
    const need = Number(process.env.FLOOR_SHUT ?? 2);
    let shut = dialogOpen(s) ? 0 : need;
    while (shut < need && s.tick() - t0 < cap) {
        if (mode === 'close') await send(s, m, { type: 'closeModal' });
        else if (dialogOpen(s)) await send(s, m, { type: 'clickDialogOption', optionIndex: 0 });
        await tick(s);
        shut = dialogOpen(s) ? 0 : shut + 1;
    }
    const n = s.tick() - t0;
    if (n > 0) { m.levelTicks += n; m.levelClears++; }
    return n;
}

export function nearestLoc(s: Session, name: RegExp, op: RegExp): { loc: any; opIndex: number } | null {
    const locs = (s.sdk.getState()?.nearbyLocs ?? []) as any[];
    const l = locs.filter(x => name.test(x.name) && x.optionsWithIndex.some((o: any) => op.test(o.text))).sort((a, b) => a.distance - b.distance)[0];
    if (!l) return null;
    return { loc: l, opIndex: l.optionsWithIndex.find((o: any) => op.test(o.text)).opIndex };
}

// Booth click, then wait for the bank interface. Returns ticks, or -1.
export async function openBank(s: Session, m: Meter, cap = 40): Promise<number> {
    const t0 = s.tick();
    // Use-quickly (op2) opens the bank at once; Use (op1) starts the banker chat (bank_booth.rs2:1-7).
    const b = nearestLoc(s, /bank booth/i, /use-quickly/i);
    if (!b) return -1;
    const pos = () => { const q = s.sdk.getState()?.player; return q ? q.worldX * 100000 + q.worldZ : 0; };
    const p0 = pos();
    const movedSince = (_s: Session, _t: number) => pos() !== p0;
    await send(s, m, { type: 'interactLoc', x: b.loc.x, z: b.loc.z, locId: b.loc.id, optionIndex: b.opIndex });
    while (!bankOpen(s) && s.tick() - t0 < cap) {
        await tick(s); debug(s, 'bank');
        // A queued level-up page opened after the click: it cancels the booth op. Close it and click again.
        if (dialogOpen(s)) { await send(s, m, { type: 'closeModal' }); await send(s, m, { type: 'interactLoc', x: b.loc.x, z: b.loc.z, locId: b.loc.id, optionIndex: b.opIndex }); m.levelTicks++; }
        // A click sent while the player is still delayed (the last anvil p_delay(2)) is dropped: while the player has
        // not moved, click again every 2 ticks; after that, every 10 ticks.
        // Never while the bank interface shows: a booth op then closes the bank and the next inputs are lost.
        else if (!(s.sdk.getState() as any)?.interface?.isOpen && (!movedSince(s, t0) ? (s.tick() - t0) % 2 === 0 : (s.tick() - t0) % 10 === 0)) { await send(s, m, { type: 'interactLoc', x: b.loc.x, z: b.loc.z, locId: b.loc.id, optionIndex: b.opIndex }); console.log(`NOTE booth re-click at +${s.tick() - t0}`); }
    }
    return bankOpen(s) ? s.tick() - t0 : -1;
}

export function bankSlot(s: Session, re: RegExp): { slot: number; count: number } | null {
    const b = bankItems(s).find(i => re.test(i.name) && i.count > 0);
    return b ? { slot: b.slot, count: b.count } : null;
}

// Withdraw `n` with 10/5/1 buttons only (no count dialog round trip). Returns the inputs used.
export async function withdrawN(s: Session, m: Meter, slot: number, n: number): Promise<number> {
    let used = 0;
    for (const step of [10, 5, 1]) while (n >= step) { await send(s, m, { type: 'bankWithdraw', slot, amount: step }); n -= step; used++; }
    return used;
}

export function band(m: Meter, name: string, dxp: number, dticks: number, dactions: number) {
    const b = m.bands.get(name) ?? { xp: 0, ticks: 0, actions: 0 };
    b.xp += dxp; b.ticks += dticks; b.actions += dactions;
    m.bands.set(name, b);
}

// Prints BAND lines (XP/tick and actions/tick per method) and one FLOOR line for the whole run.
export function report(s: Session, m: Meter, extra = ''): string {
    const ticks = s.tick() - m.t0;
    for (const [name, b] of m.bands) {
        console.log(`BAND ${m.skill} ${name} xp=${Math.round(b.xp)} ticks=${b.ticks} actions=${b.actions} xpPerTick=${(b.xp / Math.max(1, b.ticks)).toFixed(1)} actionsPerTick=${(b.actions / Math.max(1, b.ticks)).toFixed(2)}`);
    }
    const busy = [...m.perTickSent.values()];
    const maxSent = busy.length ? Math.max(...busy) : 0;
    const line = `FLOOR ${m.skill} level=${level(s, m.skill)} xp=${xp(s, m.skill)} ticks=${ticks} actions=${m.actions} actionsPerTick=${(m.actions / Math.max(1, ticks)).toFixed(2)} sent=${m.sent} refused=${m.refused} sentPerActiveTick=${(m.sent / Math.max(1, busy.length)).toFixed(2)} maxSentInTick=${maxSent} levelTicks=${m.levelTicks} levelClears=${m.levelClears} bankTicks=${m.bankTicks} bankCycles=${m.bankCycles}${extra ? ' ' + extra : ''}`;
    console.log(line);
    return line;
}

// ---- Bank-fed production at a booth (crafting gems, herblore potions, cooking wine) ----

// One production action: `use` on `on` (both inventory item names, regex-escaped by the caller), or `use` alone
// with a tool already in the pack. `level` is the level the action needs; `band` names its method.
export interface Job { use: number; on: number; level: number; band: string; xp: number } // obj ids
export interface Load { names: Record<string, number> } // item name -> count to withdraw


// Runs the jobs in order, 5 per tick, from a bank. `keep` matches tools that stay in the pack. `pairSlots` is the
// pack space per job (2 for item+item, 1 for tool+item). `perLoad` caps jobs per bank trip.
export async function bankProduction(s: Session, m: Meter, jobs: Job[], o: { keep: RegExp; pairSlots: 1 | 2; perLoad: number; perTick?: number; clear?: 'close' | 'click'; closeWhileProducing?: boolean }) {
    const perTick = o.perTick ?? 5;
    let i = 0;
    let cycle = 0;
    while (i < jobs.length) {
        // 1. Clear level-up pages (they block the booth), open the bank, swap the pack.
        const tc = s.tick();
        await clearDialogs(s, m, o.clear ?? 'close');
        const tb = s.tick();
        const opened = await openBank(s, m);
        if (opened < 0) { console.log(`WARN bank did not open at job ${i}`); return false; }
        const toDeposit = [...new Set(inv(s).filter(x => !o.keep.test(x.name)).map(x => x.slot as number))];
        const seenIds = new Set<number>();
        let deposits = 0;
        for (const sl of toDeposit) { const it = inv(s).find(x => x.slot === sl)!; if (seenIds.has(it.id)) continue; seenIds.add(it.id); await send(s, m, { type: 'bankDeposit', slot: sl, amount: -1 }); deposits++; }
        const free = 28 - inv(s).filter(x => o.keep.test(x.name)).length;
        const n = Math.min(o.perLoad, Math.floor(free / o.pairSlots), jobs.length - i);
        const load: Record<number, number> = {};
        for (const j of jobs.slice(i, i + n)) { load[j.use] = (load[j.use] ?? 0) + 1; if (o.pairSlots === 2) load[j.on] = (load[j.on] ?? 0) + 1; }
        let withdraws = 0;
        for (const [name, cnt] of Object.entries(load)) {
            const b = bankItems(s).find(x => x.id === Number(name) && x.count > 0);
            if (!b || b.count < cnt) { console.log(`WARN bank short of ${name}: have ${b?.count ?? 0} need ${cnt}`); return false; }
            withdraws += await withdrawN(s, m, b.slot, cnt);
        }
        await send(s, m, { type: 'closeModal' });
        const want = Object.entries(load);
        const t0 = s.tick();
        while (s.tick() - t0 < 30 && (bankOpen(s) || !want.every(([id, c]) => countId(s, Number(id)) >= c))) { await tick(s); if (process.env.FLOOR_DEBUG === "1") console.log(`NOTE bankwait +${s.tick() - t0} open=${bankOpen(s)} iface=${(s.sdk.getState() as any)?.interface?.interfaceId} dialog=${dialogOpen(s)} inv=${inv(s).map((x: any) => x.id).join(",")} msgs=${((s.sdk.getState() as any)?.gameMessages ?? []).slice(-1).map((g: any) => g.text)}`); }
        const bankT = s.tick() - tb;
        m.bankTicks += bankT; m.bankCycles++;
        // 2. Produce: up to perTick new jobs per tick, in order, without waiting for the server's answer. A slot that
        // was sent is not sent again for 3 ticks. A job needs its level: if the level is not there yet, wait a tick
        // for the XP of the jobs in flight.
        const tp = s.tick();
        const end = i + n;
        const sentAt = new Map<number, number>();
        const loadIds = new Set(jobs.slice(i, end).map(j => j.use));
        const left = () => inv(s).filter(x => loadIds.has(x.id)).length;
        let k = i;
        while (left() > 0 && s.tick() - tp < 200) {
            let sentNow = 0;
            const lvl = level(s, m.skill);
            const busy = (sl: number) => (sentAt.get(sl) ?? -99) > s.tick() - 3;
            // Close a level-up page in the same tick as the production inputs (item-on-item runs with it open).
            if (o.closeWhileProducing && dialogOpen(s)) { await send(s, m, { type: 'closeModal' }); sentNow++; }
            while (k < end && sentNow < perTick) {
                const j = jobs[k]!;
                if (j.level > lvl) break;
                const a = inv(s).find(x => x.id === j.use && !busy(x.slot));
                const b = inv(s).find(x => x.id === j.on && x.slot !== a?.slot && (o.pairSlots === 1 || !busy(x.slot)));
                if (!a || !b) break;
                await send(s, m, { type: 'useItemOnItem', sourceSlot: b.slot, targetSlot: a.slot });
                sentAt.set(a.slot, s.tick()); if (o.pairSlots === 2) sentAt.set(b.slot, s.tick());
                k++; sentNow++;
            }
            // Jobs sent but refused (a level not reached, a lost packet): resend from the first unsent input.
            if (k >= end && sentNow === 0 && left() > 0 && [...sentAt.values()].every(t => t <= s.tick() - 3)) k = end - left();
            await tick(s);
        }
        const done = n - left();
        for (const j of jobs.slice(i, i + done)) band(m, j.band, j.xp * RATE_X, 0, 1);
        m.actions += done;
        if (done < n) { console.log(`WARN produced ${done}/${n}`); return false; }
        const prodT = s.tick() - tp;
        // Split the cycle's ticks over its bands by job count.
        const bandsHere = new Map<string, number>();
        for (const j of jobs.slice(i, end)) bandsHere.set(j.band, (bandsHere.get(j.band) ?? 0) + 1);
        const cycT = s.tick() - tc;
        for (const [b, c] of bandsHere) band(m, b, 0, cycT * c / n, 0);
        cycle++;
        console.log(`CYCLE ${cycle} jobs=${n} level=${level(s, m.skill)} clear=${tb - tc} bank=${bankT} (open=${opened} deposits=${deposits} withdraws=${withdraws}) produce=${prodT} total=${cycT}`);
        i = end;
    }
    return true;
}
export let RATE_X = 25;
export const countId = (s: Session, id: number) => inv(s).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
