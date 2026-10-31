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

export type TickKind = 'xp' | 'inventory' | 'move' | 'anim' | 'dialog' | 'stun' | 'idle';
export interface TickRow { tick: number; kind: TickKind; at: string }

const xpSum = (st: any) => (st?.skills ?? []).reduce((n: number, k: any) => n + (k.experience ?? 0), 0);
const inventoryKey = (items: any[]) => {
    const totals = new Map<number, number>();
    for (const item of items) if (Number.isInteger(item?.id) && item.id >= 0 && Number.isFinite(item.count) && item.count > 0)
        totals.set(item.id, (totals.get(item.id) ?? 0) + item.count);
    return JSON.stringify([...totals].sort((a, b) => a[0] - b[0]));
};

export function classifyTick(before: any, now: any, stunned = false): TickKind {
    if (xpSum(now) > xpSum(before)) return 'xp';
    // Missing state is unknown, not an empty inventory. Establish a baseline first.
    if (Array.isArray(before?.inventory) && Array.isArray(now?.inventory)
        && inventoryKey(before.inventory) !== inventoryKey(now.inventory)) return 'inventory';
    const a = before?.player, b = now?.player;
    if (a && b && (a.worldX !== b.worldX || a.worldZ !== b.worldZ || a.level !== b.level)) return 'move';
    if ((b?.animId ?? -1) !== -1) return 'anim';
    if (now?.dialog?.isOpen) return 'dialog';
    return stunned ? 'stun' : 'idle';
}

export function summarize(rows: TickRow[]) {
    const counts: Record<TickKind, number> = { xp: 0, inventory: 0, move: 0, anim: 0, dialog: 0, stun: 0, idle: 0 };
    for (const r of rows) counts[r.kind]++;
    const streaks: { start: number; length: number; at: string }[] = [];
    for (let i = 0; i < rows.length; i++) {
        if (rows[i]!.kind !== 'idle') continue;
        let j = i;
        while (j + 1 < rows.length && rows[j + 1]!.kind === 'idle') j++;
        streaks.push({ start: rows[i]!.tick, length: j - i + 1, at: rows[i]!.at });
        i = j;
    }
    streaks.sort((x, y) => y.length - x.length || x.start - y.start);
    return { ticks: rows.length, counts, idlePct: rows.length ? (100 * counts.idle) / rows.length : 0, longestIdle: streaks.slice(0, 5) };
}

export function startLedger(s: { sdk: { getState(): any; getDialog?(): any }; onTick(cb: () => void): () => void; tick(): number }) {
    const rows: TickRow[] = [];
    // Copy the fields the classifier reads: the state object may be reused between ticks.
    const snap = () => {
        const st = s.sdk.getState();
        return { player: st?.player && { ...st.player }, skills: (st?.skills ?? []).map((k: any) => ({ experience: k.experience })),
            inventory: Array.isArray(st?.inventory) ? st.inventory.map((i: any) => i && ({ id: i.id, count: i.count })) : undefined,
            dialog: { isOpen: !!(s.sdk.getDialog?.()?.isOpen ?? st?.dialog?.isOpen) } };
    };
    let last = snap();
    // The message list keeps only the newest messages, so its length stops growing: track the newest tick seen.
    let seenTick = Math.max(-1, ...(s.sdk.getState()?.gameMessages ?? []).map((m: any) => m.tick ?? -1));
    let stunUntil = -1;
    const off = s.onTick(() => {
        const now = snap();
        const msgs = s.sdk.getState()?.gameMessages ?? [];
        for (const m of msgs) if ((m.tick ?? -1) > seenTick && /stunned/i.test(m.text ?? '')) stunUntil = s.tick() + 8;
        seenTick = Math.max(seenTick, ...msgs.map((m: any) => m.tick ?? -1));
        rows.push({ tick: s.tick(), kind: classifyTick(last, now, s.tick() <= stunUntil), at: `${now.player?.worldX},${now.player?.worldZ}` });
        last = now;
    });
    return { stop: () => { off(); return summarize(rows); }, rows };
}

export function formatLedger(sum: ReturnType<typeof summarize>): string {
    const c = sum.counts;
    return `LEDGER ticks=${sum.ticks} xp=${c.xp} inventory=${c.inventory} move=${c.move} anim=${c.anim} dialog=${c.dialog} stun=${c.stun} idle=${c.idle} idlePct=${sum.idlePct.toFixed(1)} `
        + `longestIdle=${sum.longestIdle.map(x => `${x.length}@t${x.start}(${x.at})`).join(',')}`;
}

// A session is stalled when its last `window` ticks hold no xp, no inventory change and no dialog: walking,
// waiting or animating that long without gaining anything is a loop (a bank trip that cannot take food, a
// chop with no logs), not work. bot.ts stops such a session.
export function stalled(rows: readonly TickRow[], window: number): boolean {
    if (window <= 0 || rows.length < window) return false;
    for (let i = rows.length - window; i < rows.length; i++) { const k = rows[i]!.kind; if (k === 'xp' || k === 'inventory' || k === 'dialog') return false; }
    return true;
}
