// Refresh one owned helper's state without travelling or changing its items.
import { openBot, finish } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import type { BankObservation, Session } from '../packages/core/src/inprocess';

export async function inspectFleetState(s: Session, opts: {requireBank?: boolean; afterLoginAt?: number; stopped?: () => boolean; log?: (line: string) => void} = {}): Promise<BankObservation | null> {
    const log = opts.log ?? console.log, afterLoginAt = opts.afterLoginAt ?? Date.now();
    const generation = opts.requireBank ? s.bankObservation?.()?.generation ?? 0 : 0;
    const checkStopped = () => { if (opts.requireBank && opts.stopped?.()) throw Error('bank observation stopped'); };
    await waitTicks(s, 5);
    checkStopped();
    const st = s.sdk.getState()!;
    log(`INSPECT ${JSON.stringify({ name: s.name, pos: st.player, skills: st.skills, inventory: st.inventory, npcs: st.nearbyNpcs.map(n => ({ name: n.name, x: n.x, z: n.z })), locs: st.nearbyLocs.filter(l => /bank|tree|flax|furnace|range|fireplace|stair|ladder/i.test(l.name)).map(l => ({ name: l.name, id: l.id, x: l.x, z: l.z, level: l.level, options:l.optionsWithIndex })) })}`);
    const bankNear = st.nearbyNpcs.some(n => /banker/i.test(n.name)) || st.nearbyLocs.some(l => /bank booth|bank chest/i.test(l.name));
    if (opts.requireBank && !bankNear) throw Error('bank observation required: no nearby bank');
    if (bankNear) {
        if (opts.requireBank && st.bank?.isOpen) { await s.bot.closeBank(); checkStopped(); }
        const opened = await s.bot.openBank();
        checkStopped();
        if (opts.requireBank) {
            if (!opened.success) throw Error('bank observation required: bank did not open');
            const fresh = () => {
                const observed = s.bankObservation?.();
                return !opts.stopped?.() && !!s.sdk.getState()?.bank?.isOpen && !!observed
                    && Number.isSafeInteger(observed.generation) && observed.generation > generation
                    && Number.isFinite(observed.at) && observed.at >= afterLoginAt;
            };
            if (!await waitUntil(s, fresh, { timeoutTicks: 12 })) throw Error('bank observation required: fresh payload unobserved');
            checkStopped();
            if (!fresh()) throw Error('bank observation required: payload no longer current');
            const observed = s.bankObservation!()!;
            await s.bot.closeBank(); checkStopped();
            log(`BANK ${JSON.stringify(observed.items)}`);
            log(`BANK_OBSERVED ${JSON.stringify({ generation: observed.generation, at: observed.at, items: observed.items.length })}`);
            return observed;
        }
        if (opened.success) { await waitTicks(s,2); log(`BANK ${JSON.stringify(s.sdk.getState()?.bank?.items)}`); const observed=s.bankObservation?.()??null;await s.bot.closeBank();return observed; }
    }
    return null;
}

if (import.meta.main) {
    const requireBank = process.env.REQUIRE_BANK === '1';
    let stopped = false;
    const onStop = async (session: Session, detail: string) => { stopped = true; await finish([session], false, 'bank observation stopped: '+detail); };
    const s = await openBot(process.argv[2]!, requireBank ? { onStop, onSessionEnd: onStop } : {});
    const afterLoginAt = Date.now();
    try {
        const observed = await inspectFleetState(s, { requireBank, afterLoginAt, stopped: () => stopped });
        await finish([s], true, ok => {
            if (!requireBank) return 'inspection';
            if (stopped) throw Error('bank observation stopped');
            return `inspection bankObserved=${ok && observed ? 1 : 0} bankGeneration=${observed?.generation ?? 0} bankObservedAt=${observed?.at ?? 0} bankItems=${observed?.items.length ?? 0}`;
        });
    }
    catch (e) { await finish([s], false, String(e)); }
}
