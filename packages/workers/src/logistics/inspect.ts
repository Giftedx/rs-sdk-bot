// Fleet account state, bank, inventory, and surrounding object inspection.
import type { BankObservation, Session } from '../../../core/src/inprocess';
import { waitTicks, waitUntil } from '../../../core/src/ticks';

export async function inspectFleetState(
    s: Session,
    opts: { requireBank?: boolean; afterLoginAt?: number; stopped?: () => boolean; log?: (line: string) => void } = {},
): Promise<BankObservation | null> {
    const log = opts.log ?? console.log, afterLoginAt = opts.afterLoginAt ?? Date.now();
    const generation = opts.requireBank ? s.bankObservation?.()?.generation ?? 0 : 0;
    const checkStopped = () => { if (opts.requireBank && opts.stopped?.()) throw Error('bank observation stopped'); };
    await waitTicks(s, 5);
    checkStopped();
    const st = s.sdk.getState()!;
    log(`INSPECT ${JSON.stringify({
        name: s.name,
        pos: st.player,
        skills: st.skills,
        inventory: st.inventory,
        npcs: st.nearbyNpcs.map(n => ({ name: n.name, x: n.x, z: n.z })),
        locs: st.nearbyLocs
            .filter(l => /bank|tree|flax|furnace|range|fireplace|stair|ladder/i.test(l.name))
            .map(l => ({ name: l.name, id: l.id, x: l.x, z: l.z, level: l.level, options: l.optionsWithIndex })),
    })}`);
    const bankNear = st.nearbyNpcs.some(n => /banker/i.test(n.name)) || st.nearbyLocs.some(l => /bank booth|bank chest/i.test(l.name));
    if (opts.requireBank && !bankNear) throw Error('bank observation required: no nearby bank');
    if (bankNear) {
        if (opts.requireBank && st.bank?.isOpen) {
            await s.bot.closeBank();
            checkStopped();
        }
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
            await s.bot.closeBank();
            checkStopped();
            log(`BANK ${JSON.stringify(observed.items)}`);
            log(`BANK_OBSERVED ${JSON.stringify({ generation: observed.generation, at: observed.at, items: observed.items.length })}`);
            return observed;
        }
        if (opened.success) {
            await waitTicks(s, 2);
            log(`BANK ${JSON.stringify(s.sdk.getState()?.bank?.items)}`);
            const observed = s.bankObservation?.() ?? null;
            await s.bot.closeBank();
            return observed;
        }
    }
    return null;
}
