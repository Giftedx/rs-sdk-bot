// Prayer guard: keeps the active prayers free of point cost and turns a protection prayer on when an NPC attacks.
//
// Prayer points drain on a 5-tick timer. The timer starts when the first prayer goes on and is cleared when no prayer
// is on (skill_prayer/scripts/prayer.rs2:30-43,163). The guard turns every active prayer off and on in one tick, every
// 3 ticks, so the timer never fires.
//
// A prayer button closes every open window (skill_prayer/scripts/prayers/*.rs2:2, if_close) and clears the pending
// interaction (p_clearpendingaction). The guard therefore sends no prayer input while a window is open, or while an
// interaction that is not an attack is pending: the prayer stays on and drains at the normal rate. After a prayer
// input during an attack, the guard sends the same attack again in the same tick.
//
// A script that sends its own prayer input keeps control: the guard sends nothing for SCRIPT_PRAYER_QUIET ticks after.

export interface GuardSession {
    sdk: { getState(): any };
    tick(): number;
    onTick(cb: () => void): () => void;
    direct(action: { type: string; [k: string]: unknown }): Promise<unknown>;
    client?: unknown;
    ended?: Promise<unknown>;
}

export const PROTECT = { magic: 12, missiles: 13, melee: 14 } as const;
// vendor/rs-sdk/sdk/types.ts PRAYER_LEVELS, indices 12-14.
const PROTECT_LEVEL: Record<number, number> = { 12: 37, 13: 40, 14: 43 };

export interface PrayerGuardOptions {
    // false: never turn a protection prayer on; only keep the script's prayers free.
    // A function: the protection prayer for one attacking NPC (null when only a hit was seen). Default: melee.
    protect?: false | ((npc: any | null) => number | null);
    // Ticks between two flicks. 3 leaves one tick of delay before the 5-tick timer can fire.
    every?: number;
    // Ticks without a threat before the guard turns its own protection prayer off.
    calmTicks?: number;
}

export interface PrayerGuardStats { flicks: number; holds: number; protects: number; repairs: number; resends: number }

const INTERACTIONS = new Set(['talkToNpc', 'interactNpc', 'interactPlayer', 'interactLoc', 'pickupItem', 'useItemOnLoc',
    'useItemOnNpc', 'spellOnNpc', 'spellOnPlayer', 'interactGroundItem']);
const SCRIPT_PRAYER_QUIET = 8;
// One tick holds 5 inputs (scripts/pk.ts, prayerFlick): two prayers off and on, and one attack.
const MAX_FLICKED = 2;

type Action = { type: string; [k: string]: unknown };
type Pending = { kind: 'none' } | { kind: 'attack'; action: Action } | { kind: 'other'; still: number };

export function startPrayerGuard(s: GuardSession, o: PrayerGuardOptions = {}) {
    const every = o.every ?? 3, calm = o.calmTicks ?? 20;
    if (!Number.isSafeInteger(every) || every < 1 || every > 4) throw new Error('prayer guard: every must be 1..4');
    const stats: PrayerGuardStats = { flicks: 0, holds: 0, protects: 0, repairs: 0, resends: 0 };
    const own = new WeakSet<object>();
    const owned = new Map<number, number>();
    let stopped = false, flickAt = -Infinity, scriptPrayerAt = -Infinity, threatAt = -Infinity, protectAt = -Infinity;
    let pending: Pending = { kind: 'none' };
    let expect: number[] | null = null, expectAt = 0, wasActive = false, lastTile = '';

    const attackTarget = (a: Action, st: any): boolean => {
        if (a.type === 'interactPlayer') return a.optionIndex === 2 && (st?.nearbyPlayers ?? []).some((p: any) => p.index === a.playerIndex);
        const n = (st?.nearbyNpcs ?? []).find((n: any) => n.index === a.npcIndex);
        return !!n && n.hp !== 0 && (n.optionsWithIndex ?? []).some((op: any) => op.opIndex === a.optionIndex && /^Attack$/i.test(op.text));
    };

    // Every input of the script passes here before the client sends it.
    const note = (action: unknown) => {
        const a = action as Action | null;
        if (stopped || !a || typeof a !== 'object' || own.has(a)) return;
        if (a.type === 'togglePrayer') { scriptPrayerAt = s.tick(); owned.delete(a.prayerIndex as number); expect = null; return; }
        if (a.type === 'walkTo') { pending = { kind: 'none' }; return; }
        if ((a.type === 'interactNpc' || a.type === 'interactPlayer') && attackTarget(a, s.sdk.getState())) { pending = { kind: 'attack', action: { ...a } }; return; }
        if (INTERACTIONS.has(a.type)) pending = { kind: 'other', still: 0 };
    };

    const client = s.client as { executeBotAction?: (action: unknown) => unknown } | undefined;
    const original = client?.executeBotAction;
    const observer = typeof original === 'function' ? function (this: unknown, action: unknown) { note(action); return original.call(this, action); } : undefined;
    if (client && observer) client.executeBotAction = observer;

    // Sent in the tick callback, in order: the server reads the inputs of one tick in the order they arrive.
    const send = (a: Action) => { own.add(a); try { void Promise.resolve(s.direct(a)).catch(() => {}); } catch { /* session ended */ } };
    const toggle = (prayerIndex: number) => send({ type: 'togglePrayer', prayerIndex, reason: 'SDK' });
    const resend = (st: any) => {
        if (pending.kind !== 'attack') return;
        if (!attackTarget(pending.action, st)) { pending = { kind: 'none' }; return; }
        send({ ...pending.action });
        stats.resends++;
    };

    const off = s.onTick(() => {
        if (stopped) return;
        const st = s.sdk.getState(), p = st?.player, prayers = st?.prayers;
        if (!p || p.isDead || !prayers || !Array.isArray(prayers.activePrayers)) return;
        const now = s.tick();
        const active: number[] = prayers.activePrayers.flatMap((on: boolean, i: number) => (on ? [i] : []));

        // An interaction that is not an attack ends when the player has stood idle for 3 ticks.
        const tile = `${p.worldX},${p.worldZ},${p.level}`;
        if (pending.kind === 'other') {
            pending.still = tile === lastTile && (p.animId ?? -1) === -1 ? pending.still + 1 : 0;
            if (pending.still >= 3) pending = { kind: 'none' };
        }
        lastTile = tile;

        // The state shows a prayer one tick after the server turned it on.
        if (active.length && !wasActive) flickAt = Math.max(flickAt, now - 1);
        wasActive = active.length > 0;
        for (const [i, at] of owned) if (!active.includes(i) && now - at > 2) owned.delete(i);

        let wanted: number | null = null;
        if (o.protect !== false) {
            const self = (s.client as any)?.selfSlot;
            const me = Number.isSafeInteger(self) ? 32768 + self : undefined;
            const npc = (st.nearbyNpcs ?? []).find((n: any) => me !== undefined && n.targetIndex === me && n.hp !== 0
                && (n.optionsWithIndex ?? []).some((op: any) => /^Attack$/i.test(op.text))) ?? null;
            const hit = (st.combatEvents ?? []).some((e: any) => e.type === 'damage_taken' && e.sourceType === 'npc' && now - e.tick <= 8);
            if (npc || hit) {
                threatAt = now;
                const choice = o.protect ? o.protect(npc) : PROTECT.melee;
                if (choice !== null && prayers.prayerLevel >= (PROTECT_LEVEL[choice] ?? Infinity)) wanted = choice;
            }
        }

        if (prayers.prayerPoints < 1) return;
        const windows = !!(st.modalOpen || st.dialog?.isOpen || st.interface?.isOpen || st.bank?.isOpen || st.shop?.isOpen);
        const safe = !windows && pending.kind !== 'other' && now - scriptPrayerAt > SCRIPT_PRAYER_QUIET;

        // A flick must leave every prayer on. One that stayed off two ticks later is turned on again, once.
        if (expect) {
            if (now - expectAt < 2) return;
            const missing = expect.filter(i => !active.includes(i));
            if (missing.length && !safe && now - expectAt < 10) return;
            expect = null;
            if (missing.length && safe) {
                for (const i of missing) toggle(i);
                stats.repairs++; flickAt = now; protectAt = now;
                resend(st);
                return;
            }
        }
        if (now - protectAt < 2) return;
        if (!safe) { if (active.length) stats.holds++; return; }

        if (wanted !== null && !active.includes(wanted)) {
            toggle(wanted);
            owned.set(wanted, now);
            stats.protects++; protectAt = now;
            if (!active.length) flickAt = now;
            resend(st);
            return;
        }
        if (wanted === null && now - threatAt > calm) {
            const mine = active.filter(i => owned.has(i));
            if (mine.length) {
                for (const i of mine) { toggle(i); owned.delete(i); }
                protectAt = now;
                resend(st);
                return;
            }
        }
        if (!active.length || now - flickAt < every) return;
        if (active.length > MAX_FLICKED) { stats.holds++; return; }
        for (const i of active) toggle(i);
        for (const i of active) toggle(i);
        expect = active; expectAt = now; flickAt = now;
        stats.flicks++;
        resend(st);
    });

    const stop = () => {
        if (stopped) return;
        stopped = true;
        off();
        if (client && observer && client.executeBotAction === observer) client.executeBotAction = original;
    };
    void s.ended?.then(stop);
    return { stop, stats: () => ({ ...stats }), note };
}
