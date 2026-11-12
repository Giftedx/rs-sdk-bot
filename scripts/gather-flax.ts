// Seers' Village Flax Gatherer: picks flax in the field (2744,3445) and banks at Seers' Bank (2725,3492).
// Usage: bun scripts/gather-flax.ts <bot> [CAP ticks, default 15000] [BANK_AT flax, default 28]
// Environment: DEMO_OK=1 for live server.
import type { Session } from '../packages/core/src/inprocess';
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import { bankCargo, courierWaiting } from '../packages/core/src/cargo';
import { approach, awayFrom } from './walk-to';

const FLAX_FIELD = { x: 2744, z: 3445 };
const SEERS_BANK = { x: 2727, z: 3492 };
// The field walk and the bank walk stay on the ground floor (the bank is 47 tiles from the field). A start on
// another floor, or more than this many tiles from the field, goes to the field with the shared walker first.
const APPROACH_FROM = 80;
export interface FlaxOptions {
    cap: number;
    bankAt: number;
    stop?: () => boolean;
    // The walk to the field from a far start or another floor. Default: the shared walker (stairs, doors, ferries).
    approach?: (stop: () => boolean) => Promise<boolean>;
    walk?: (x: number, z: number, tol: number, stop: () => boolean, remaining: number) => Promise<boolean>;
    cargo?: (s: Session) => Promise<void>;
    waiting?: () => boolean;
}
// Production CAP ends picking. Final return gets a separate bounded budget; it never overrides a user stop.
export async function runFlax(s: Session, o: FlaxOptions) {
    if (!Number.isInteger(o.cap) || o.cap < 1 || !Number.isInteger(o.bankAt) || o.bankAt < 1 || o.bankAt > 28) throw new Error('invalid flax CAP/BANK_AT');
    const CAP = o.cap, BANK_AT = o.bankAt;
    const pos = () => s.sdk.getState()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const flaxCount = () => countItems(s, /^flax$/i);
    const freeSpace = () => 28 - (s.sdk.getInventory().length);
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    let ended = false, died = false;
    const life = pos()?.lifeId, respawns = pos()?.respawnCount ?? 0;
    void s.ended.then(() => { ended = true; });
    let stopped = false, cleanupDeadline: number | undefined;
    const terminal = () => ended || died || (stopped ||= !!o.stop?.());
    const over = () => used() >= CAP || terminal();
    const cleanupOver = () => terminal() || s.tick() >= (cleanupDeadline ?? s.tick());
    const waiting = o.waiting ?? (() => courierWaiting(s.name));
    let finalBankConfirmed = false, bankObservedAt = 0, failure = '';

    let hp0 = hp();
    let hpMin = hp0;
    const off = s.onTick(() => {
        if (hp0 > 0) hpMin = Math.min(hpMin, hp());
        stopped ||= !!o.stop?.();
        const p = pos();
        if (p?.isDead || (p?.respawnCount ?? 0) > respawns || (life !== undefined && p?.lifeId !== life)) died = true;
    });

    let picks = 0, banked = 0, bankTrips = 0, walkTicks = 0, tries = 0;

    const walk = async (x: number, z: number, tol = 2, stop = over): Promise<boolean> => {
        const a = s.tick();
        for (let i = 0; i < 3 && !stop(); i++) {
            const p = pos();
            if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
            const remaining = Math.max(0, (cleanupDeadline ?? t0 + CAP) - s.tick());
            if (o.walk) {
                if (!await o.walk(x, z, tol, stop, remaining)) break;
                continue;
            }
            const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop, maxTicks: remaining });
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                await waitTicks(s, 1);
            }
        }
        walkTicks += s.tick() - a;
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };

    const bank = async (final = false): Promise<boolean> => {
        const stop = final ? cleanupOver : over;
        const n = flaxCount();
        if (!final && n === 0 && !waiting()) return false;
        if (stop() || !await walk(SEERS_BANK.x, SEERS_BANK.z, 2, stop) || stop()) return false;
        await s.bot.dismissBlockingUI();
        if (stop()) return false;
        // A production deposit can cross CAP with the bank still open. Its current ready
        // snapshot remains valid; reopening that same UI produces no new inventory packet.
        if (!s.sdk.getState()?.bank?.isOpen || !s.bankObservation?.()) {
            const generation = s.bankObservation?.()?.generation ?? 0;
            const b = await s.bot.openBank();
            if (!b.success || !await waitUntil(s, () => stop() || !!s.sdk.getState()?.bank?.isOpen
                && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 15 }) || stop()) return false;
        }
        const before = s.bankObservation?.();
        if (!before || !s.sdk.getState()?.bank?.isOpen) return false;
        const bankFlax = () => (s.bankObservation?.()?.items ?? []).filter(i => /^flax$/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
        const original = bankFlax();
        if (n > 0) {
            if (!(await s.bot.depositItem(/^flax$/i, -1)).success) return false;
            await waitUntil(s, () => stop() || flaxCount() === 0 && bankFlax() === original + n
                && (s.bankObservation?.()?.generation ?? 0) > before.generation, { timeoutTicks: 10 });
            if (stop() || flaxCount() !== 0 || bankFlax() !== original + n
                || (s.bankObservation?.()?.generation ?? 0) <= before.generation) return false;
            banked += n;
        }
        bankTrips++;
        if (stop()) return false;
        await (o.cargo ?? (session => bankCargo(session, [/^flax$/i])))(s);
        // Cargo may withdraw notes and reopen the bank. Verify its cleanup too, before closing the UI.
        const observed = s.bankObservation?.();
        const confirmed = !stop() && !!s.sdk.getState()?.bank?.isOpen && !!observed && flaxCount() === 0;
        if (confirmed) bankObservedAt = observed!.at;
        await s.bot.closeInterface();
        console.log(`MILESTONE bank t=${used()} banked=${banked} totalPicks=${picks}`);
        return confirmed;
    };

    const field = { ...FLAX_FIELD, level: 0 }, away = () => awayFrom(pos(), field, APPROACH_FROM);
    console.log(`START flax gatherer ${s.name} at=${pos()?.worldX},${pos()?.worldZ},${pos()?.level ?? 0}`);
    try {
    if (away() && !over()) {
        const reached = o.approach ? await o.approach(over) : (await approach(s, field, over)).ok;
        if (!reached && away() && !over()) failure = 'no flax progress: no route to the flax field';
        console.log(`MILESTONE approach t=${used()} at=${pos()?.worldX},${pos()?.worldZ},${pos()?.level ?? 0}`);
    }
    while (!over() && !failure) {
        if (flaxCount() >= BANK_AT || waiting() || (flaxCount() > 0 && freeSpace() === 0)) {
            if (!await bank()) {
                if (!over()) failure = 'no flax progress: production bank unconfirmed';
                break;
            }
            // Never starve incoming game ticks if a bank/request check makes no progress.
            await waitTicks(s, 1);
            continue;
        }

        const p = pos();
        if (!p) { await waitTicks(s, 1); continue; }

        // If not in the flax field, walk there
        if (Math.max(Math.abs(p.worldX - FLAX_FIELD.x), Math.abs(p.worldZ - FLAX_FIELD.z)) > 15) {
            await walk(FLAX_FIELD.x, FLAX_FIELD.z, 5);
            continue;
        }

        // Find nearby flax plant (loc 2646 or name flax)
        const loc = s.sdk.findNearbyLoc(/^flax$/i);
        if (!loc) {
            await walk(FLAX_FIELD.x, FLAX_FIELD.z, 4);
            await waitTicks(s, 2);
            continue;
        }

        tries++;
        const before = flaxCount();
        await s.bot.interactLoc(loc, 'Pick');
        await waitUntil(s, () => flaxCount() > before, { timeoutTicks: 6 });

        if (flaxCount() > before) {
            picks++;
        }
    }

    } catch (e) { failure = String(e); }
    // CAP is a production budget, not permission to leave picked stock unbanked.
    if (!terminal()) {
        cleanupDeadline = s.tick() + 240;
        try { finalBankConfirmed = await bank(true); } catch (e) { failure ||= String(e); }
    }
    off();
    const held = flaxCount();
    const ok = picks > 0 && !terminal() && !failure && finalBankConfirmed && held === 0;
    if (!ok) failure ||= stopped ? 'stop-file' : died ? 'died' : ended ? 'session-ended' : 'no flax progress: final bank unconfirmed';
    return { ok, picks, banked, held, bankTrips, walkTicks, hpMin, died, ended, stopped,
        finalBankConfirmed, bankObservedAt, ticks: used(), failure,
        flaxPer1kTicks: (picks * 1000 / Math.max(1, used())).toFixed(2) };
}
if (import.meta.main) {
    const name = process.argv[2];
    if (!name) throw new Error('Usage: bun scripts/gather-flax.ts <botName>');
    let stopped = false;
    const s = await openBot(name, { onStop: async () => { stopped = true; } }).catch(e => finish([], false, `login: ${String(e)}`));
    try {
        const r = await runFlax(s, { cap: Number(process.argv[3] ?? process.env.CAP ?? 15000), bankAt: Number(process.argv[4] ?? process.env.BANK_AT ?? 28), stop: () => stopped });
        await finish([s], r.ok, Object.entries(r).map(([k,v]) => `${k}=${v}`).join(' '));
    } catch (e) { await finish([s], false, String(e)); }
}
