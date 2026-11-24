import { AsyncLocalStorage } from 'node:async_hooks';
import type { Session } from '../inprocess';
import { unitValue, type LootTables } from '../loot';
import {
    DESTROY, FISH_TOOLS, REFUSE_LIMIT, SUSTAIN, countOf,
    type Act, type LootWatchOptions,
} from './model';

export interface GateOptions {
    session: Session;
    gateOn: boolean;
    loot: LootWatchOptions | null;
    guard: { tables: LootTables; minValue: number } | null;
    isJobHolding: () => boolean;
    activeName: () => string | undefined;
    say: (name: string, action: string, extra?: string) => void;
    log: (line: string) => void;
}

export interface ActionGate {
    avoidNpcs: Set<number>;
    avoidLocs: Set<string>;
    kept: Map<number, number>;
    refusals: Map<number, { n: number; at: number }>;
    ownDrops: Map<string, number>;
    scriptToolDrops: Map<number, { at: number; left: number }>;
    scriptPickupAt(): number;
    isExclusive(): boolean;
    holding(): boolean;
    lastAction(): string | null;
    send(a: Act): void;
    canSend(): boolean;
    flush(): void;
    expireHeld(tick: number, holdLimit: number): void;
    exclusive<T>(work: () => Promise<T>): Promise<T>;
    stop(): void;
}

/**
 * Create the script action gate, value/kept-item guard, target-avoidance filter,
 * exclusive death-recovery scope, and per-tick handler action sender.
 */
export function createActionGate(opts: GateOptions): ActionGate {
    const { session: s, gateOn, loot, guard, isJobHolding, activeName, say, log } = opts;
    const rawDirect = s.direct.bind(s);
    const sdkAny = s.sdk as any;
    const rawSend = typeof sdkAny.send === 'function' ? sdkAny.send : null;
    const held: { at: number; run: () => void; fail: () => void }[] = [];
    const avoidNpcs = new Set<number>();
    const avoidLocs = new Set<string>();
    const fail = (msg: string, reason = 'random_event') => ({ success: false, message: msg, reason });
    const avoided = (a: any) =>
        (a?.type === 'interactNpc' && avoidNpcs.has(a.npcIndex))
        || (a?.type === 'interactLoc' && avoidLocs.has(`${a.x},${a.z}`));
    const answer = (msg: any, result: object) =>
        sdkAny.handleMessage?.(JSON.stringify({ type: 'sdk_action_result', actionId: msg.actionId, result }));
    const later = (r: (v: any) => void, v: object) => {
        const off = s.onTick(() => { off(); r(v); });
    };

    const kept = new Map<number, number>();
    let scriptPickupAt = -99;
    const ownDrops = new Map<string, number>();
    const refusals = new Map<number, { n: number; at: number }>();
    const packNow = (): any[] => s.sdk.getState()?.inventory ?? [];
    const scriptToolDrops = new Map<number, { at: number; left: number }>();
    const guardReleased = new Set<number>();

    const dropSlotOf = (pack: readonly any[], a: any): number | undefined => {
        if (a.type === 'dropItem') return a.slot;
        if (a.type === 'useInventoryItem') {
            const item = pack.find(x => x.slot === a.slot);
            if ((item?.optionsWithIndex ?? []).some((o: any) => o.opIndex === a.optionIndex && DESTROY.test(o.text ?? ''))) {
                return a.slot;
            }
        }
        return undefined;
    };

    const noteToolDrop = (a: any) => {
        if (!a || (a.type !== 'dropItem' && a.type !== 'useInventoryItem')) return;
        const pack = packNow();
        const slot = dropSlotOf(pack, a);
        const item = slot === undefined ? undefined : pack.find(x => x.slot === slot);
        if (!item || !FISH_TOOLS.includes(item.id)) return;
        const now = s.tick();
        const prev = scriptToolDrops.get(item.id);
        const left = prev && now - prev.at <= 6 ? prev.left + 1 : 1;
        scriptToolDrops.set(item.id, { at: now, left });
    };

    const noteScript = (a: any) => {
        if (!loot || !a) return;
        if (a.type === 'pickupItem' || a.type === 'interactGroundItem' || a.type === 'spellOnGroundItem') scriptPickupAt = s.tick();
        if (a.type === 'dropItem') {
            const i = packNow().find(x => x.slot === a.slot), q = s.sdk.getState()?.player;
            if (i && q) ownDrops.set(`${q.worldX},${q.worldZ},${i.id}`, s.tick());
        }
    };

    const keptRefusal = (a: any): string | null => {
        if (((!loot || kept.size === 0) && !guard) || !a) return null;
        const t = a.type;
        if (t !== 'dropItem' && t !== 'shopSell' && t !== 'spellOnItem' && t !== 'useInventoryItem') return null;
        const pack = packNow();
        const slot = t === 'useInventoryItem' ? dropSlotOf(pack, a) : a.slot;
        const item = slot === undefined ? undefined : pack.find(i => i.slot === slot);
        if (!item) return null;
        const keep = kept.get(item.id) ?? 0;
        const leaves = a.type === 'shopSell' ? Math.min(a.amount ?? 1, item.count ?? 1) : item.count ?? 1;
        const keptHit = keep > 0 && countOf(pack, item.id) - leaves < keep;
        const valueHit = !keptHit && !!guard && !guardReleased.has(item.id) && unitValue(item.id, guard.tables) * leaves >= guard.minValue;
        if (!keptHit && !valueHit) return null;
        const who = keptHit ? 'loot' : 'guard';
        const r = refusals.get(item.id) ?? { n: 0, at: -1 };
        if (r.at !== s.tick()) {
            r.n++;
            r.at = s.tick();
            refusals.set(item.id, r);
            say(who, 'refused', `${a.type} id=${item.id} n=${r.n}`);
        }
        if (r.n > REFUSE_LIMIT) {
            refusals.delete(item.id);
            if (keptHit) kept.delete(item.id); else guardReleased.add(item.id);
            say(who, 'released', `id=${item.id}`);
            return null;
        }
        return keptHit ? 'loot: the item is kept until a bank' : `guard: item ${item.id} is worth ${guard!.minValue} or more`;
    };

    const trusted = new AsyncLocalStorage<true>();
    let lastType: string | null = null;
    const noteType = (a: any) => { if (typeof a?.type === 'string' && a.type !== 'togglePrayer') lastType = a.type; };
    let exclusiveDepth = 0;
    const holding = () => exclusiveDepth > 0 || isJobHolding();

    // Passes the gate during exclusive work: the work's own actions, and the eat, drink and prayer inputs.
    const passes = (a: any): boolean => {
        if (trusted.getStore()) return true;
        if (!exclusiveDepth || !a) return false;
        if (a.type === 'togglePrayer') return true;
        if (a.type !== 'useInventoryItem') return false;
        const i = packNow().find(x => x.slot === a.slot);
        return (i?.optionsWithIndex ?? []).some((o: any) => o.opIndex === a.optionIndex && SUSTAIN.test(o.text ?? ''));
    };

    if (gateOn) {
        s.direct = (a: Act) => {
            if (passes(a)) { noteToolDrop(a); return rawDirect(a); }
            noteType(a);
            noteScript(a);
            if (avoided(a)) return new Promise(r => later(r, fail('random event: target avoided')));
            const no = keptRefusal(a);
            if (no) return new Promise(r => later(r, fail(no, 'loot_kept')));
            if (!holding()) { noteToolDrop(a); return rawDirect(a); }
            return new Promise(r => held.push({
                at: s.tick(),
                run: () => {
                    const n = keptRefusal(a);
                    if (n) r(fail(n, 'loot_kept'));
                    else { noteToolDrop(a); r(rawDirect(a)); }
                },
                fail: () => r(fail('random event in progress')),
            }));
        };
        if (rawSend) sdkAny.send = (msg: any) => {
            if (msg?.type === 'sdk_action') {
                if (passes(msg.action)) { noteToolDrop(msg.action); return rawSend.call(sdkAny, msg); }
                noteType(msg.action);
                noteScript(msg.action);
                if (avoided(msg.action)) { later(() => answer(msg, fail('random event: target avoided')), {}); return; }
                const no = keptRefusal(msg.action);
                if (no) { later(() => answer(msg, fail(no, 'loot_kept')), {}); return; }
                if (holding()) {
                    held.push({
                        at: s.tick(),
                        run: () => {
                            const n = keptRefusal(msg.action);
                            if (n) answer(msg, fail(n, 'loot_kept'));
                            else { noteToolDrop(msg.action); rawSend.call(sdkAny, msg); }
                        },
                        fail: () => answer(msg, fail('random event in progress')),
                    });
                    return;
                }
                noteToolDrop(msg.action);
            }
            return rawSend.call(sdkAny, msg);
        };
    }

    let lastSendTick = -1;
    const send = (a: Act) => {
        lastSendTick = s.tick();
        void rawDirect({ reason: 'random-event', ...a }).then((r: any) => {
            if (r && r.success === false) log(`EVENT ${activeName() ?? 'watcher'} send-failed t=${s.tick()} ${a.type}: ${r.message ?? ''}`);
        }, () => {});
    };

    return {
        avoidNpcs,
        avoidLocs,
        kept,
        refusals,
        ownDrops,
        scriptToolDrops,
        scriptPickupAt: () => scriptPickupAt,
        isExclusive: () => exclusiveDepth > 0,
        holding,
        lastAction: () => lastType,
        send,
        canSend: () => lastSendTick !== s.tick(),
        flush: () => { for (const h of held.splice(0)) h.run(); },
        expireHeld: (tick: number, holdLimit: number) => {
            for (let i = held.length - 1; i >= 0; i--) {
                if (tick - held[i]!.at > holdLimit) held.splice(i, 1)[0]!.fail();
            }
        },
        async exclusive<T>(work: () => Promise<T>): Promise<T> {
            exclusiveDepth++;
            try { return await trusted.run(true, work); }
            // The script's actions from before the work are stale after it: they fail rather than run.
            finally { if (--exclusiveDepth === 0) for (const h of held.splice(0)) h.fail(); }
        },
        stop() {
            if (gateOn) { s.direct = rawDirect; if (rawSend) sdkAny.send = rawSend; }
            for (const h of held.splice(0)) h.fail();
        },
    };
}
