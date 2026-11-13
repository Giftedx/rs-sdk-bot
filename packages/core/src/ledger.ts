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

export function summarize(rows: TickRow[], xpGain = 0) {
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
    const why = new Map<string, number>();
    for (const r of rows) if (r.kind === 'idle') why.set(r.why ?? 'none', (why.get(r.why ?? 'none') ?? 0) + 1);
    const idleBy = [...why].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6);
    return { ticks: rows.length, counts, idlePct: rows.length ? (100 * counts.idle) / rows.length : 0, longestIdle: streaks.slice(0, 5), xpGain, idleBy };
}

// `lastAction` returns the type of the last action the script sent, or null.
export function startLedger(s: { sdk: { getState(): any; getDialog?(): any }; onTick(cb: () => void): () => void; tick(): number }, lastAction: () => string | null = () => null) {
    const rows: TickRow[] = [];
    // Copy the fields the classifier reads: the state object may be reused between ticks.
    const snap = () => {
        const st = s.sdk.getState(), p = st?.player, hit = p?.combat?.lastDamageTick ?? -1, now = st?.tick ?? 0;
        // A fight is a hit the player dealt (a miss included) in the last FIGHT_TICKS ticks. `combat.inCombat` is no
        // proof: the SDK sets it for any target, and a pickpocket click targets the NPC.
        const dealt = (st?.combatEvents ?? []).some((e: any) => e?.type === 'damage_dealt' && now - (e.tick ?? -Infinity) <= FIGHT_TICKS);
        return { player: p && { ...p }, skills: (st?.skills ?? []).map((k: any) => ({ experience: k.experience })),
            inventory: Array.isArray(st?.inventory) ? st.inventory.map((i: any) => i && ({ id: i.id, count: i.count })) : undefined,
            dialog: { isOpen: !!(s.sdk.getDialog?.()?.isOpen ?? st?.dialog?.isOpen) },
            fight: dealt, hurt: hit >= 0 && now - hit <= FIGHT_TICKS,
            bank: !!st?.bank?.isOpen, shop: !!st?.shop?.isOpen, window: !!st?.interface?.isOpen || !!st?.modalOpen };
    };
    let last = snap();
    // Total XP over all skills at the start, so the summary can state the XP the run gained.
    const xpStart = xpSum(last);
    // The message list keeps only the newest messages, so its length stops growing: track the newest tick seen.
    let seenTick = Math.max(-1, ...(s.sdk.getState()?.gameMessages ?? []).map((m: any) => m.tick ?? -1));
    let stunUntil = -1;
    const off = s.onTick(() => {
        const now = snap();
        const msgs = s.sdk.getState()?.gameMessages ?? [];
        for (const m of msgs) if ((m.tick ?? -1) > seenTick && /stunned/i.test(m.text ?? '')) stunUntil = s.tick() + 8;
        seenTick = Math.max(seenTick, ...msgs.map((m: any) => m.tick ?? -1));
        const kind = classifyTick(last, now, s.tick() <= stunUntil);
        rows.push({ tick: s.tick(), kind, at: `${now.player?.worldX},${now.player?.worldZ}`, ...(kind === 'idle' ? { why: idleWhy(now, lastAction()) } : {}) });
        last = now;
    });
    return { stop: () => { off(); return summarize(rows, Math.max(0, xpSum(last) - xpStart)); }, rows };
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
const tile = (at: string): [number, number] | null => { const m = at.match(/^(-?\d+),(-?\d+)$/); return m ? [Number(m[1]), Number(m[2])] : null; };
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
