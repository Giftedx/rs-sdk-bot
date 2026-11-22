import {
    activeProtectionIndex,
    backFirst,
    believedPrayers,
    chooseWantedPrayers,
    intendToggle,
    MAX_FLICKED,
    planPrayerTransition,
    prayerKeepExpiry,
    regenOn,
    shouldDropOwned,
    STATE_LAG,
    TICK_INPUTS,
} from './choice';
import {
    createFishingSync,
    held,
    IDLE_TICKS,
    isDyingAttackClick,
    levelUpDialog,
    NEUTRAL,
    PICKUP_IDLE_TICKS,
    skillTarget,
    windowOpen,
} from './interactions';
import { assessThreat, attackTarget, autoAttackOf, damageSourceName, npcDead } from './threats';
import type { Action, GuardSession, Pending, PrayerGuardOptions, PrayerGuardStats, PrayerIntent } from './types';

// Each input is its own network write, and a server tick can start between two writes: the off and the on of a
// flick would then land in two ticks, with the prayer off for one tick. The guard therefore holds the client's
// writes from its first input of a moment to the next macrotask: its inputs, and a script input that follows them,
// leave in one write. The lockstep practice engine already sends one write for each tick (inprocess.ts).
function createWriteCoalescer(client: unknown) {
    const wire = client as { flush?: () => void } | undefined;
    let holding = false;
    return () => {
        if (holding || process.env.SIM_LOCKSTEP === '1' || !wire || typeof wire.flush !== 'function' || Object.prototype.hasOwnProperty.call(wire, 'flush')) return;
        holding = true;
        let wanted = false;
        wire.flush = () => { wanted = true; };
        setImmediate(() => {
            holding = false;
            delete wire.flush;
            // The client's own flush, from its prototype again.
            const flush = (client as { flush?: () => void }).flush;
            if (wanted) flush?.call(client);
        });
    };
}

function createTracer(trace?: (line: string) => void) {
    let tracedLevels = '', tracedMessage = -1, tracedView = '';
    return (st: any, p: any, now: number, pending: Pending, lastEvent: number) => {
        if (!trace) return;
        for (const e of st.combatEvents ?? []) if (e.tick > lastEvent) trace(`GUARD t=${now} hit ${e.type} damage=${e.damage} target=${e.targetType}:${e.targetIndex} at=${e.tick}`);
        const level = (name: string) => { const k = (st.skills ?? []).find((k: any) => k.name === name); return k ? `${k.level}/${k.baseLevel}` : '?'; };
        const levels = `attack=${level('Attack')} strength=${level('Strength')}`;
        if (levels !== tracedLevels) { tracedLevels = levels; trace(`GUARD t=${now} levels ${levels}`); }
        let newestMessage = tracedMessage;
        for (const m of st.gameMessages ?? []) if ((m.tick ?? -1) > tracedMessage) { newestMessage = Math.max(newestMessage, m.tick); trace(`GUARD t=${now} message ${String(m.text ?? '').slice(0, 80)}`); }
        tracedMessage = newestMessage;
        const target = p.combat?.targetType === 'npc' ? `npc:${p.combat.targetIndex}` : 'none';
        const wantsNpc = pending.kind === 'attack' ? `${pending.action.type}:${pending.action.npcIndex ?? pending.action.locId}` : pending.kind;
        const view = `target=${target} pending=${wantsNpc}`;
        if (view !== tracedView) { tracedView = view; trace(`GUARD t=${now} fight ${view}`); }
    };
}

export function startPrayerGuard(s: GuardSession, o: PrayerGuardOptions = {}) {
    const every = o.every ?? 3, calm = o.calmTicks ?? 20;
    if (!Number.isSafeInteger(every) || every < 1 || every > 4) throw new Error('prayer guard: every must be 1..4');
    const stats: PrayerGuardStats = { flicks: 0, early: 0, holds: 0, holdsBy: {}, takenFrom: {}, protects: 0, repairs: 0, resends: 0, spent: 0, manual: false, yielded: false };
    const own = new WeakSet<object>();
    // Prayers the guard turned on, with the tick, and the tick up to which each is still wanted.
    const owned = new Map<number, number>(), keep = new Map<number, number>();
    // What a prayer input sent in the last STATE_LAG ticks makes of each prayer, until the state shows it.
    const intents = new Map<number, PrayerIntent>();
    let stopped = false, flickAt = -Infinity, threatAt = -Infinity, threatNow = false;
    let scriptPrayerAt = -Infinity, scriptPrayers: number[] = [], inputTick = -1, inputs = 0;
    let pending: Pending = { kind: 'none' };
    let expect: number[] | null = null, expectAt = 0, wasActive = false, lastTile = '';
    // Prayers of a flick that come back on in its second tick.
    let resume: number[] = [];
    let pointsFirst: number | undefined, pointsLast: number | undefined, taken = 0, lastEvent = -Infinity;
    // The fight the game started by auto-retaliate, with no attack input from the script: the attack on that NPC and
    // the tick the state last showed the fight. A prayer button clears the fight like each interaction, and the game
    // starts it again only at the NPC's next hit. The guard sends this attack after its prayer inputs.
    let retaliate: { action: Action; at: number } | null = null, walkAt = -Infinity, stillSince = 0;
    const fish = createFishingSync();
    const fishing = (st: any): boolean => pending.kind === 'attack' && pending.action.type === 'interactNpc' && skillTarget(pending.action, st);
    // Outside a multi-combat area the engine refuses an attack on an NPC while another NPC has hit the player in the
    // last 8 ticks: "I'm already under attack!" (skill_combat/scripts/player/player_combat.rs2:118). The game then
    // fights the attacker by auto-retaliate. After that message the attack the guard sends again goes to the
    // attacker, not to the script's refused target, until the script sends its next input or the attacker is gone.
    let refusedSeen = -1, attackerIndex: number | null = null;
    // Ticks of the last two hits the player dealt, for the tick of the next one.
    let swingAt = -Infinity, swingBefore = -Infinity;

    const hold = (cause: string) => { stats.holds++; stats.holdsBy[cause] = (stats.holdsBy[cause] ?? 0) + 1; };
    const holdWrites = createWriteCoalescer(s.client);
    const traceTick = createTracer(o.trace);

    // Sent in order: the server reads the inputs of one tick in the order they arrive.
    // The inputs the guard sent in the current tick: with the script's input they must not pass TICK_INPUTS.
    let sentAt = -1, sent = 0;
    const send = (a: Action) => { const t = s.tick(); if (sentAt !== t) { sentAt = t; sent = 0; } sent++; own.add(a); holdWrites(); try { void Promise.resolve(s.direct(a)).catch(() => {}); } catch { /* session ended */ } };
    let why = '';
    const toggle = (prayerIndex: number) => { o.trace?.(`GUARD t=${s.tick()} prayer=${prayerIndex} ${why}`); send({ type: 'togglePrayer', prayerIndex, reason: 'SDK' }); };
    const fights = (now: number): boolean => pending.kind === 'attack' || (pending.kind === 'none' && !!retaliate && now - retaliate.at <= 1);
    const gameFight = (now: number): boolean => !!retaliate && now - retaliate.at <= 1 && (pending.kind === 'none' || (pending.kind === 'attack' && attackerIndex !== null));
    const resend = (st: any) => {
        if (gameFight(s.tick()) && retaliate) {
            const n = (st?.nearbyNpcs ?? []).find((n: any) => n.index === retaliate!.action.npcIndex);
            if (n && !npcDead(n, st)) { send({ ...retaliate.action }); stats.resends++; }
            return;
        }
        if (pending.kind !== 'attack') return;
        if (!attackTarget(pending.action, st) && !skillTarget(pending.action, st)) { pending = { kind: 'none' }; return; }
        send({ ...pending.action });
        stats.resends++;
    };
    // One flick in one tick, for at most two prayers.
    const flickNow = (active: readonly number[], now: number) => {
        why = 'flick';
        for (const i of active) toggle(i);
        for (const i of active) toggle(i);
        expect = [...active]; expectAt = now; flickAt = now;
        stats.flicks++;
    };

    // The second tick of a flick of three or four prayers: the prayers that are still off come back on.
    const finish = (now: number) => {
        why = 'flick-second-tick';
        for (const i of resume) { toggle(i); intents.set(i, { on: true, at: now }); }
        resume = []; expectAt = now;
    };

    // Right before an input of the script that starts an action: prayer inputs sent here cancel nothing, because the
    // script's input comes after them.
    const beforeInput = (a: Action, attack: boolean) => {
        const st = s.sdk.getState(), prayers = st?.prayers;
        if (stats.yielded || !st?.player || st.player.isDead || !prayers || prayers.prayerPoints < 1 || windowOpen(st)) return;
        const now = s.tick();
        if (resume.length) { finish(now); return; }
        // The script's input takes one of the tick's inputs; the guard has the rest, less what it sent in this tick.
        const room = TICK_INPUTS - 1 - (sentAt === now ? sent : 0);
        if (inputs > 0 || flickAt === now || room <= 0) return;
        // A flick of the last two ticks left these prayers on, and the state can show them late.
        const active = expect ?? believedPrayers(st, intents, now);
        if (!active.length) return;
        // The guard's own prayers go off before an input that is not an attack. Strength and Attack: always. The
        // others: when no threat is near and the input starts an action, because they cannot be flicked while that
        // action runs.
        const drop = attack ? [] : active.filter(i => owned.has(i) && shouldDropOwned(i, a.type, threatNow));
        if (drop.length) {
            why = 'off-before-input';
            let left: number[] = [...active];
            for (const i of drop.slice(0, room)) { toggle(i); owned.delete(i); left = intendToggle(intents, left, i, now); }
            // With inputs to spare, the prayers that stay on go off and on after them: for one moment no prayer is
            // on, which clears the drain timer.
            if (left.length && drop.length + 2 * left.length <= room && !regenOn(left)) {
                why = 'flick-after-off';
                for (const i of left) toggle(i);
                for (const i of left) toggle(i);
                flickAt = now; stats.flicks++; stats.early++;
                expect = left; expectAt = now;
            } else if (expect) { expect = left; expectAt = now; }
            return;
        }
        if (!expect && 2 * active.length <= room && now - flickAt >= 1 && !regenOn(active)) { flickNow(active, now); stats.early++; }
    };

    // Every input of the script passes here before the client sends it.
    const note = (action: unknown) => {
        const a = action as Action | null;
        if (stopped || !a || typeof a !== 'object' || own.has(a)) return;
        const now = s.tick();
        if (inputTick !== now) { inputTick = now; inputs = 0; }
        if (a.type === 'togglePrayer') {
            const prayer = a.prayerIndex as number;
            if (scriptPrayerAt !== now) scriptPrayers = [];
            // The same prayer two times in one tick: the script has its own flick.
            if (scriptPrayers.includes(prayer)) stats.yielded = true;
            scriptPrayers.push(prayer);
            scriptPrayerAt = now; stats.manual = true; owned.clear(); inputs++;
            // The script chose from the prayers before a flick in progress. The flick finishes first, so the script's
            // button acts on those prayers; two ticks later the repair turns on a chosen prayer the state shows off.
            if (resume.length && !stats.yielded) finish(now);
            const after = intendToggle(intents, expect ?? believedPrayers(s.sdk.getState(), intents, now), prayer, now);
            if (expect) { expect = after; expectAt = now; }
            return;
        }
        // A click on the level-up message starts no action.
        if (NEUTRAL.has(a.type) || (a.type === 'clickDialogOption' && levelUpDialog(s.sdk.getState()))) { inputs++; return; }
        const attack = (a.type === 'interactNpc' || a.type === 'interactPlayer') && attackTarget(a, s.sdk.getState());
        beforeInput(a, attack);
        inputs++;
        attackerIndex = null;
        if (a.type === 'walkTo') { pending = { kind: 'none' }; walkAt = now; retaliate = null; return; }
        // `attack` also holds a mining or woodcutting click: the guard sends it again after its prayer inputs.
        if (attack || skillTarget(a, s.sdk.getState())) { pending = { kind: 'attack', action: { ...a } }; if (!attack && a.type === 'interactNpc') fish.markStart(now); return; }
        // An attack click on a dying NPC starts no action. With `other` here, a fight by auto-retaliate that follows
        // would count as that action, and the guard would hold its flicks for the whole fight.
        if (isDyingAttackClick(a, s.sdk.getState())) { pending = { kind: 'none' }; return; }
        if (a.type === 'pickupItem') { const item = a.itemId as number; pending = { kind: 'other', type: a.type, still: 0, need: PICKUP_IDLE_TICKS, item, had: held(s.sdk.getState(), item) }; return; }
        if (o.trace && a.type === 'interactNpc') { const st = s.sdk.getState(), n = (st?.nearbyNpcs ?? []).find((n: any) => n.index === a.npcIndex); o.trace(`GUARD t=${now} other interactNpc:${a.npcIndex} option=${a.optionIndex} hp=${n?.hp} lastCombat=${n?.lastCombatTick} stateTick=${st?.tick} options=${(n?.optionsWithIndex ?? []).map((op: any) => op.text).join('/')}`); }
        pending = { kind: 'other', type: a.type, still: 0, need: IDLE_TICKS };
    };

    const client = s.client as { executeBotAction?: (action: unknown) => unknown } | undefined;
    const original = client?.executeBotAction;
    const observer = typeof original === 'function' ? function (this: unknown, action: unknown) { note(action); return original.call(this, action); } : undefined;
    if (client && observer) client.executeBotAction = observer;

    const off = s.onTick(() => {
        if (stopped || stats.yielded) return;
        const st = s.sdk.getState(), p = st?.player, prayers = st?.prayers;
        if (!p || p.isDead || !prayers || !Array.isArray(prayers.activePrayers)) return;
        const now = s.tick();
        if (pointsLast !== undefined && prayers.prayerPoints < pointsLast) stats.spent += pointsLast - prayers.prayerPoints;
        pointsFirst ??= prayers.prayerPoints; pointsLast = prayers.prayerPoints;
        traceTick(st, p, now, pending, lastEvent);

        // A hit on the player has the player as its target: a hit of another player on an NPC is `damage_taken` too.
        const selfSlot = (s.client as any)?.selfSlot;
        let newest = lastEvent, hit = false;
        for (const e of st.combatEvents ?? []) {
            if (e.type === 'damage_taken' && e.targetType === 'player') {
                if (e.tick > lastEvent) {
                    taken += e.damage;
                    if (e.damage > 0) {
                        const worn = activeProtectionIndex(prayers.activePrayers as boolean[]);
                        const key = `${damageSourceName(st, p, selfSlot)}/${worn < 0 ? 'none' : worn}`;
                        stats.takenFrom[key] = (stats.takenFrom[key] ?? 0) + e.damage;
                    }
                }
                if (now - e.tick <= 8) hit = true;
            }
            if (e.type === 'damage_dealt' && e.sourceType === 'player' && e.tick > swingAt) { swingBefore = swingAt; swingAt = e.tick; }
            newest = Math.max(newest, e.tick);
        }
        lastEvent = newest;
        const active = believedPrayers(st, intents, now);
        const caught = fish.observeTick(st, now, fishing(st));

        // An interaction that is not an attack ends when the player has stood idle for its number of ticks.
        const tile = `${p.worldX},${p.worldZ},${p.level}`;
        if (pending.kind === 'other') {
            pending.still = tile === lastTile && (p.animId ?? -1) === -1 ? pending.still + 1 : 0;
            if (pending.still >= pending.need || (pending.item !== undefined && held(st, pending.item) > pending.had!)) pending = { kind: 'none' };
        }
        stillSince = tile === lastTile ? stillSince : now;
        lastTile = tile;

        // The NPC that attacks the player, and the game's refusal of an attack on another NPC.
        let refused = false;
        for (const m of st.gameMessages ?? []) if ((m.tick ?? -1) > refusedSeen && /^I'm already under attack/.test(m.text ?? '')) refused = true;
        for (const m of st.gameMessages ?? []) refusedSeen = Math.max(refusedSeen, m.tick ?? -1);
        if (pending.kind === 'attack' && pending.action.type === 'interactNpc') {
            if (refused && attackerIndex === null) {
                const scriptTarget = pending.action.npcIndex;
                const other = (st.nearbyNpcs ?? []).find((n: any) => n.index !== scriptTarget && autoAttackOf(n, st, selfSlot));
                if (other) attackerIndex = other.index;
            }
            const attack = attackerIndex === null ? null : autoAttackOf((st.nearbyNpcs ?? []).find((n: any) => n.index === attackerIndex), st, selfSlot);
            if (attack) retaliate = { action: attack, at: now };
            else { attackerIndex = null; retaliate = null; }
        } else if (pending.kind === 'none' && st.autoRetaliateEnabled !== false && p.combat?.targetType === 'npc' && now - walkAt > 3) {
            // An auto-retaliate fight: the player targets an NPC that targets the player, the script has no action
            // of its own, and the player has not walked on a script input in the last 3 ticks.
            const attack = autoAttackOf((st.nearbyNpcs ?? []).find((n: any) => n.index === p.combat.targetIndex), st, selfSlot);
            if (attack) retaliate = { action: attack, at: now };
        } else if (pending.kind !== 'none') retaliate = null;

        // The state shows a prayer one tick after the server turned it on.
        if (active.length && !wasActive) flickAt = Math.max(flickAt, now - 1);
        wasActive = active.length > 0;
        // Not during a flick: its second tick shows the guard's own prayers off.
        if (!expect && !resume.length) for (const [i, at] of owned) if (!active.includes(i) && now - at > STATE_LAG) owned.delete(i);

        // The prayers the guard wants on in this tick.
        let wanted: number[] = [];
        threatNow = false;
        if (!stats.manual) {
            const threat = assessThreat(st, p, selfSlot, o, hit);
            if (threat.threatNow) { threatAt = now; threatNow = true; }
            wanted = chooseWantedPrayers(st, prayers, o, threat, pending);
        }
        for (const i of wanted) keep.set(i, prayerKeepExpiry(i, now, calm));

        if (prayers.prayerPoints < 1) return;
        const windows = windowOpen(st);
        const safe = !windows && pending.kind !== 'other';

        // The second tick of a flick of three or four prayers.
        if (resume.length) {
            if (!safe) return;
            finish(now);
            resend(st);
            return;
        }
        // A flick must leave every prayer on. One that the state shows off two ticks later is turned on again, once.
        if (expect) {
            if (now - expectAt < STATE_LAG) {
                // A script that sends a prayer input in each tick keeps this check waiting. A flick that is due goes
                // to the prayers those inputs leave on.
                // The second click of a fishing cycle, with its flick.
                if (safe && expect.length && expect.length <= 2 && fishing(st) && (caught || fish.isSecondTick(now)) && !regenOn(expect) && fish.shouldFlick(now, caught, flickAt)) { flickNow(expect, now); resend(st); return; }
                if (now - flickAt < 4 || !safe || !expect.length || expect.length > 2 || regenOn(expect)) return;
                flickNow(expect, now);
                resend(st);
                return;
            }
            const shown: boolean[] = prayers.activePrayers;
            const missing = expect.filter(i => !shown[i]);
            if (missing.length && !safe && now - expectAt < 10) return;
            expect = null;
            if (missing.length && safe) {
                why = 'repair';
                for (const i of missing) { toggle(i); intents.set(i, { on: true, at: now }); }
                stats.repairs++; flickAt = now;
                resend(st);
                return;
            }
        }
        if (!safe) { if (active.length) hold(windows ? 'window' : pending.kind === 'other' ? pending.type : 'other'); return; }

        const transition = planPrayerTransition(active, wanted, owned, keep, now, fights(now));
        if (transition) {
            const { missing, stale, order, asFlick } = transition;
            why = `set ${order.join('+') || 'none'} from ${active.join('+') || 'none'} threat=${threatNow}`;
            if (asFlick) {
                // Every prayer off, then the new set on: the moment with no prayer on clears the drain timer, so a
                // change of the set is a flick too.
                for (const i of active) toggle(i);
                for (const i of order) toggle(i);
                flickAt = now;
                if (order.length) { stats.flicks++; expect = order; expectAt = now; }
            } else {
                for (const i of stale) toggle(i);
                for (const i of missing) toggle(i);
                if (!active.length) flickAt = now;
            }
            for (const i of new Set([...active, ...order])) intents.set(i, { on: order.includes(i), at: now });
            for (const i of stale) owned.delete(i);
            for (const i of missing) owned.set(i, now);
            if (missing.length) stats.protects++;
            resend(st);
            return;
        }

        if (!active.length) return;
        if (regenOn(active)) { hold('regen'); return; }
        if (active.length > MAX_FLICKED) { hold('five'); return; }
        const attack = fights(now) ? 1 : 0;
        if (active.length <= 2) {
            if (fishing(st)) {
                if (!fish.shouldFlick(now, caught, flickAt)) return;
            } else if (now - flickAt < every) return;
            flickNow(active, now);
            resend(st);
            return;
        }
        // Three or four prayers flick every 4 ticks, the longest gap the timer allows: the prayers of the second tick
        // are off for one tick. The server reads an input one tick after the guard sends it, so a flick that starts
        // one tick before the player's next hit would leave that hit without its Strength and Attack prayers. Such a
        // flick starts one tick early.
        const gap = swingAt - swingBefore, nextSwing = gap >= 3 && gap <= 8 ? swingAt + gap : -1;
        const unbuffed = (start: number) => start + 1 === nextSwing;
        const since = now - flickAt;
        if (since < 3 || (since === 3 && !unbuffed(now + 1)) || (since === 3 && unbuffed(now))) return;
        const order = [...active].sort((a, b) => backFirst(a) - backFirst(b));
        why = 'flick-first-tick';
        // The first tick sends 4 inputs when it can, which leaves one for the script: the protection prayer comes back
        // now. With no input left for the attack, the attack waits for the second tick.
        const now1 = Math.max(1, TICK_INPUTS - 1 - order.length - attack);
        for (const i of order) toggle(i);
        for (const i of order.slice(0, now1)) toggle(i);
        resume = order.slice(now1);
        expect = active; expectAt = now; flickAt = now;
        stats.flicks++;
        if (order.length + Math.min(now1, order.length) + attack <= TICK_INPUTS) resend(st);
    });

    const stop = () => {
        if (stopped) return;
        stopped = true;
        off();
        o.log?.(`PRAYER_GUARD ${JSON.stringify({ ...stats, points: [pointsFirst, pointsLast], taken })}`);
        if (client && observer && client.executeBotAction === observer) client.executeBotAction = original;
    };
    // Stops the guard and turns the guard's own prayers off: before a logout, and for a script that needs every prayer
    // off before it starts. Waits up to 4 ticks until the state shows them off.
    const release = async (): Promise<void> => {
        const state = () => s.sdk.getState()?.prayers?.activePrayers as boolean[] | undefined;
        const mine = [...owned.keys()].filter(i => state()?.[i]);
        if (stopped) return;
        why = 'release';
        for (const i of mine) toggle(i);
        stop();
        if (!mine.length) return;
        await new Promise<void>(done => {
            let left = 4;
            const end = s.onTick(() => { if (--left <= 0 || !mine.some(i => state()?.[i])) { end(); done(); } });
            void s.ended?.then(() => { end(); done(); });
        });
    };
    void s.ended?.then(stop);
    return { stop, release, stats: () => ({ ...stats, holdsBy: { ...stats.holdsBy }, takenFrom: { ...stats.takenFrom } }), note };
}
