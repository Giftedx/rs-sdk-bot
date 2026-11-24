// Direct Air altar entry, crafting, and level-up-safe portal exit.
import { countItems } from '../../../core/src/bot';
import type { Session } from '../../../core/src/inprocess';
import { waitUntil } from '../../../core/src/ticks';
import { insideAirAltar, outsideAirAltar } from './altars';

export async function enterAirAltar(s: Session, stop: () => boolean = () => false): Promise<void> {
    if (stop()) throw Error('air entry stopped');
    if (insideAirAltar(s.sdk.getState()?.player)) return;
    const ruins = s.sdk.getState()?.nearbyLocs.find(l => /mysterious ruins/i.test(l.name) && Math.max(Math.abs(l.x - 2985), Math.abs(l.z - 3292)) <= 3);
    const talisman = s.sdk.getInventory().find(i => i.id === 1438);
    if (!ruins || !talisman) throw Error('air entry requires earned air talisman1438 at ruins2985,3292');
    await s.bot.useItemOnLoc(talisman, ruins);
    if (!await waitUntil(s, () => stop() || insideAirAltar(s.sdk.getState()?.player), { timeoutTicks: 20 }) || stop()) {
        throw Error(stop() ? 'air entry stopped' : 'air altar entry unobserved');
    }
}

// Pinned content/pack/loc.pack and maps/m44_75.jm2: 2465 at 0_44_75_25_28; runecraft.dbrow air exit_coord 0_46_51_39_24.
export async function exitAirAltar(s: Session, stop: () => boolean = () => false): Promise<void> {
    const check = () => { if (stop()) throw Error('air exit stopped'); };
    check();
    if (!insideAirAltar(s.sdk.getState()?.player)) return;
    const portal = s.sdk.findNearbyLoc(/^portal$/i, { withOption: /^use$/i });
    if (!portal) throw Error('air exit portal unobserved');
    if (portal.id !== 2465 || portal.x !== 2841 || portal.z !== 4828 || !portal.optionsWithIndex.some(o => o.opIndex === 1 && /^use$/i.test(o.text))) {
        throw Error('air exit portal identity/option differs from pinned content');
    }
    const messages = () => s.sdk.getState()?.gameMessages ?? [];
    const cursor = () => Math.max(0, ...messages().map(m => m.observationId ?? m.tick));
    let baseline = cursor();
    const record = (phase: string, reply?: unknown) => console.log('AIR_EXIT ' + JSON.stringify({
        phase,
        tick: s.tick(),
        portal,
        position: s.sdk.getState()?.player,
        opFeedback: s.sdk.getState()?.opFeedback,
        messages: messages().filter(m => (m.observationId ?? m.tick) > baseline),
        reply,
    }));
    record('selected');
    const off = s.onTick(() => record('observe'));
    try {
        const idle = () => {
            const st = s.sdk.getState();
            return st?.player?.animId === -1 && !st.dialog.isOpen && !st.interface.isOpen && !st.modalOpen;
        };
        const settle = async (ready: () => boolean, reason: string, quietTicks = 1, recover?: (dismissed: boolean) => Promise<boolean>) => {
            let last = '', lastTick = -1, stable = 0, quietAt = -1, dismissed = false;
            for (let observation = 0; observation < 20; observation++) {
                check();
                const st = s.sdk.getState();
                const blocked = !!(st?.dialog.isOpen || st?.interface.isOpen || st?.modalOpen);
                await s.bot.dismissBlockingUI();
                check();
                if (blocked) { stable = 0; last = ''; quietAt = -1; dismissed = true; }
                const p = s.sdk.getState()?.player, now = s.tick(), key = p ? `${p.level}:${p.worldX}:${p.worldZ}` : '';
                if (now !== lastTick) {
                    stable = idle() && key ? (key === last ? stable + 1 : 1) : 0;
                    last = stable ? key : '';
                    lastTick = now;
                    if (stable === 1) quietAt = now;
                }
                if (stable >= 2 && now - quietAt >= quietTicks) {
                    if (ready()) return;
                    if (recover && await recover(dismissed)) {
                        stable = 0;
                        last = '';
                        quietAt = -1;
                        dismissed = false;
                    }
                }
                if (!await waitUntil(s, () => stop() || s.tick() > now, { timeoutTicks: 1 })) { check(); break; }
            }
            check();
            throw Error(reason);
        };
        await settle(() => insideAirAltar(s.sdk.getState()?.player), 'air craft/modal did not settle', 4);
        const edges = [{ x: 2841, z: 4829 }, { x: 2842, z: 4828 }, { x: 2841, z: 4827 }, { x: 2840, z: 4828 }];
        let edge: typeof edges[number] | undefined;
        for (const candidate of edges) {
            check();
            const path = s.sdk.findPath(candidate.x, candidate.z);
            record('path', { candidate, path });
            if (path.success && path.reachedDestination === true) { edge = candidate; break; }
        }
        if (!edge) throw Error('air portal approach unavailable');
        const approachCursor = cursor(), approachRejected = s.sdk.getState()?.opFeedback?.opRejectedCount;
        let retried = false;
        const approach = async () => {
            check();
            record('approach', edge);
            const walk = await s.sdk.sendWalk(edge!.x, edge!.z);
            record('approach-dispatched', walk);
            check();
            if (!walk.success) throw Error('air portal approach refused ' + JSON.stringify(walk));
        };
        await approach();
        const atEdge = () => {
            const p = s.sdk.getState()?.player;
            return p?.level === 0 && p.worldX === edge!.x && p.worldZ === edge!.z;
        };
        await settle(atEdge, 'air portal approach unobserved', 1, async dismissed => {
            const levelup = messages().some(m => (m.observationId ?? m.tick) > approachCursor && /^Congratulations, you just advanced a runecraft level\.$/i.test(m.text));
            const rejected = approachRejected !== undefined && (s.sdk.getState()?.opFeedback?.opRejectedCount ?? approachRejected) > approachRejected;
            if (retried || !dismissed || !levelup || !rejected) return false;
            const path = s.sdk.findPath(edge!.x, edge!.z);
            record('approach-recovery-path', path);
            if (!path.success || path.reachedDestination !== true) throw Error('air portal recovery approach unavailable');
            retried = true;
            await approach();
            return true;
        });
        check();
        if (!atEdge() || !idle()) throw Error('air portal approach changed before dispatch');
        record('approached');
        baseline = cursor();
        const rejected = s.sdk.getState()?.opFeedback?.opRejectedCount;
        record('dispatch');
        const reply = await s.sdk.sendInteractLoc(portal.x, portal.z, portal.id, 1);
        record('action', reply);
        check();
        if (!reply.success) throw Error('air portal action refused ' + JSON.stringify(reply));
        const refusal = () =>
            messages().some(m => (m.observationId ?? m.tick) > baseline && /can(?:not|'t) reach/i.test(m.text))
            || (rejected !== undefined && (s.sdk.getState()?.opFeedback?.opRejectedCount ?? rejected) > rejected);
        const observed = await waitUntil(s, () => stop() || outsideAirAltar(s.sdk.getState()?.player) || refusal(), { timeoutTicks: 20 });
        check();
        if (outsideAirAltar(s.sdk.getState()?.player)) { record('outside'); return; }
        if (refusal()) { record('rejected'); throw Error('air portal rejected after dispatch; no unchanged retry'); }
        record('unobserved', { observed });
        throw Error('air portal exit unobserved');
    } finally {
        off();
    }
}

export function airCraftEffects(ess0: number, ess: number, runes0: number, runes: number, xp0: number, xp: number): boolean {
    return ess0 > 0 && ess === 0 && runes - runes0 >= ess0 && xp > xp0;
}

export interface AirCraftResult {
    ok: boolean;
    consumed: number;
    runes: number;
    xp: number;
    ticks: number;
}

export async function craftAirRunes(s: Session, stop: () => boolean = () => false): Promise<AirCraftResult> {
    if (!await waitUntil(s, () => s.sdk.getInventory().length > 0 && !!s.sdk.getSkill('Runecraft'), { timeoutTicks: 30 })) {
        throw Error('air inventory/skills unobserved');
    }
    if (!insideAirAltar(s.sdk.getState()?.player)) throw Error('air craft requires observed inside-altar position');
    const ess = () => countItems(s, /^rune essence$/i);
    const runes = () => countItems(s, /^air rune$/i);
    const xp = () => s.sdk.getSkillXp('Runecraft') ?? 0;
    const ess0 = ess(), runes0 = runes(), xp0 = xp(), start = s.tick();
    for (let attempt = 0; attempt < 3 && ess() > 0 && !stop(); attempt++) {
        await s.bot.dismissBlockingUI();
        const altar = s.sdk.findNearbyLoc(/^altar$/i, { withOption: /craft/i });
        if (!altar) throw Error('air altar with craft option unobserved');
        await s.bot.interactLoc(altar, /craft/i);
        await waitUntil(s, () => stop() || ess() === 0, { timeoutTicks: 12 });
    }
    const result: AirCraftResult = {
        ok: !stop() && airCraftEffects(ess0, ess(), runes0, runes(), xp0, xp()),
        consumed: ess0 - ess(),
        runes: runes() - runes0,
        xp: xp() - xp0,
        ticks: s.tick() - start,
    };
    if (!result.ok) throw Error('air craft effects unobserved ' + JSON.stringify(result));
    return result;
}
