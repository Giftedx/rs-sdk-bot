// Eat guard: eats plain food when Hitpoints are low and damage arrives, in each session.
//
// The guard must never eat an item that a script needs for another purpose. Four rules give that:
// - It eats only the cooked fish of PLAIN_FOOD, and only by the Eat option. It never eats a pie, a cake, bread, cheese,
//   a fruit, a stew or a drink: those are ingredients and quest items.
// - A quest session has no guard. Family Crest and Death Plateau take cooked fish from the inventory
//   (quest_crest/scripts/crest_caleb.rs2, quest_death/scripts/death_sherpa.rs2), so a fish is a quest item there.
//   The quest library, the quest sweep and each other quest script hold the guard for the whole session
//   (scripts/generated/quest-lib.ts, scripts/quest-sweep.ts), and bot.ts starts no guard for a script with `quest`
//   in its file name (noGuardScript). The quest sustain eats there, with the reserve rules of the quest.
// - It sends an eat only while damage arrives: Hitpoints fell in the last `calmTicks` ticks. An account that stands
//   with low Hitpoints and takes no damage keeps its food, which can be cargo, and no window closes.
// - It eats only in a session whose script has sent an attack. A cook, a courier and a trader carry cooked fish as
//   product or cargo and send no attack (scripts/cook-food.ts counts each cooked fish), so the guard eats nothing there.
//   The microbot scripts fight and count each piece of their food (scripts/microbot-c-clue-guardian.ts knownRotDelta):
//   bot.ts starts no guard for a script with `microbot` in its file name.
//
// An item click is refused while the player is delayed (engine OpHeldHandler.ts, player.delayed). An accepted click
// clears the pending interaction, closes every open window and clears the weak queue, which holds a skill batch
// (OpHeldHandler.ts clearPendingAction; Player.ts clearPendingAction, closeModal). At the eat level the guard
// therefore eats only while no window is open and no interaction that is not an attack is pending. At the urgent
// level a window or an interaction does not stop the eat. After an eat during an attack, the guard sends the same
// attack again in the same tick.
//
// Normal food cannot be eaten again for 3 ticks (consume.rs2 player_consume_item, %eat_delay). The guard sends at
// most one eat in 3 ticks. The server gives no reply to a refused eat: an eat that removed no item after 3 ticks
// counts as refused, and the guard sends the next one.
//
// The server reads 5 inputs of one player in a tick (engine ClientGameProtCategory.USER_EVENT). The guard counts the
// inputs of the tick, and waits one tick when its eat and its attack do not fit.
//
// A script that sends its own eat input chooses when to eat: from then on the guard sends nothing in that session.
// The server would refuse a script eat in the 2 ticks after an eat of the guard, and a script that checks its eat
// then reads a failure. The guard holds such an input and sends it when the food delay ends.
// A quest sustain (sustain.ts startQuestSustain) and the PK fight loop (scripts/pk.ts) hold the guard from start to
// stop.

import { basename } from 'node:path';
import { attackTarget, IDLE_TICKS, NEUTRAL } from './prayer-guard';
import { defaultEatAt, expandFoodStages, questFoodDefinitions, registerSessionEater, selectQuestFood } from './sustain';

export interface EatGuardSession {
    sdk: { getState(): any };
    tick(): number;
    onTick(cb: () => void): () => void;
    direct(action: { type: string; [k: string]: unknown }): Promise<unknown>;
    client?: unknown;
    ended?: Promise<unknown>;
}

type Level = number | ((maxHp: number) => number);

// The food the guard eats by default: cooked fish that heal and do nothing more (consume_normal.dbrow), in one bite.
// packages/core/test/eat-guard-content.test.ts checks each id against the pinned content.
export const PLAIN_FOOD: readonly number[] = [
    315, // shrimp
    319, // anchovies
    325, // sardine
    329, // salmon
    333, // trout
    339, // cod
    347, // herring
    351, // pike
    355, // mackerel
    361, // tuna
    365, // bass
    373, // swordfish
    379, // lobster
    385, // shark
];

// True for a script that gets no eat guard, by its file name: a quest script, where a fish can be a quest item, and
// a microbot script, which counts each piece of its food.
export const noGuardScript = (script: string): boolean => /quest|microbot/i.test(basename(script));

export interface EatGuardOptions {
    // Item ids the guard can eat. Default: PLAIN_FOOD.
    food?: readonly number[];
    // Eat at this Hitpoints level or below. Default: sustain.ts defaultEatAt.
    eatAt?: Level;
    // At this level or below, an open window or a pending interaction does not stop the eat. Default: half of the
    // eat level.
    urgentAt?: Level;
    // For each item id, the count the guard never eats: a quest ingredient or cargo.
    reserved?: () => Readonly<Record<number, number>>;
    // Ticks after the last fall of Hitpoints in which the guard eats.
    calmTicks?: number;
    // false: eat also in a session whose script has sent no attack. Default true.
    fightOnly?: boolean;
    // Receives one EAT_GUARD line with the counts when the guard stops. `fought` is true when the script sent an
    // attack. `held` is true when an eater of the script held the guard at that time.
    log?: (line: string) => void;
}

// eats: eats the server took. urgent: eats at the urgent level. holds: ticks at the eat level with a window or an
// interaction in the way. waits: ticks with no room for the inputs. refused: eats the server did not take.
// resends: attacks sent again. late: script eats sent late, after the food delay. healed: Hitpoints the eats gave.
export interface EatGuardStats { eats: number; urgent: number; holds: number; waits: number; refused: number; resends: number; late: number; healed: number; yielded: boolean }

const EAT_TICKS = 3;
const MAX_INPUTS = 5;

type Action = { type: string; [k: string]: unknown };
type Pending = { kind: 'none' } | { kind: 'attack'; action: Action } | { kind: 'other'; still: number };

export function startEatGuard(s: EatGuardSession, o: EatGuardOptions = {}) {
    const calm = o.calmTicks ?? 100;
    if (!Number.isSafeInteger(calm) || calm < 1) throw new Error('eat guard: calmTicks must be 1 or more');
    // The food table is read here, at login: the read must not run inside a tick.
    const food = o.food ?? PLAIN_FOOD;
    // A script eats what it chooses: each item that heals counts as the food of a script's own eat input.
    const edible = expandFoodStages([...questFoodDefinitions().keys()]);
    const stats: EatGuardStats = { eats: 0, urgent: 0, holds: 0, waits: 0, refused: 0, resends: 0, late: 0, healed: 0, yielded: false };
    const own = new WeakSet<object>();
    const fightOnly = o.fightOnly ?? true;
    let stopped = false, fought = false, holders = 0, ateAt = -Infinity, damageAt = -Infinity, inputsAt = -Infinity, inputs = 0;
    let pending: Pending = { kind: 'none' };
    let lastHp: number | undefined, hpFirst: number | undefined, hpMin: number | undefined, lastTile = '';
    let sent: { id: number; before: number; hp: number; at: number } | null = null;
    let lateEat: { action: Action; id: number } | null = null;

    const count = (st: any, id: number): number => (st?.inventory ?? []).filter((i: any) => i.id === id).reduce((n: number, i: any) => n + i.count, 0);
    const level = (v: Level, max: number): number => typeof v === 'function' ? v(max) : v;

    const slotItem = (slot: unknown): any => (s.sdk.getState()?.inventory ?? []).find((i: any) => i.slot === slot);
    // The food of a script's eat input, null for every other input. The eat inputs of a holder are not a script's own
    // eater.
    const scriptEat = (a: Action): { id: number } | null => {
        if (a.type !== 'useInventoryItem' || own.has(a) || holders > 0) return null;
        const item = slotItem(a.slot);
        const op = item?.optionsWithIndex?.find((v: any) => v.opIndex === a.optionIndex);
        return item && edible.has(item.id) && op && /^(eat|drink)$/i.test(op.text) ? item : null;
    };

    // Every input of the session passes here before the client sends it.
    const note = (action: unknown) => {
        const a = action as Action | null;
        if (stopped || !a || typeof a !== 'object') return;
        const now = s.tick();
        if (inputsAt !== now) { inputsAt = now; inputs = 0; }
        inputs++;
        if (own.has(a)) return;
        if (a.type === 'useInventoryItem') { if (scriptEat(a)) stats.yielded = true; return; }
        if (NEUTRAL.has(a.type) || a.type === 'togglePrayer') return;
        if (a.type === 'walkTo') { pending = { kind: 'none' }; return; }
        if ((a.type === 'interactNpc' || a.type === 'interactPlayer') && attackTarget(a, s.sdk.getState())) { fought = true; pending = { kind: 'attack', action: { ...a } }; return; }
        // A combat spell on a target is an attack of the script too.
        if (a.type === 'spellOnNpc' || a.type === 'spellOnPlayer') fought = true;
        pending = { kind: 'other', still: 0 };
    };

    const client = s.client as { executeBotAction?: (action: unknown) => unknown } | undefined;
    const original = client?.executeBotAction;
    const observer = typeof original === 'function' ? function (this: unknown, action: unknown) {
        const a = action as Action | null, since = s.tick() - ateAt;
        const eaten = !stopped && a && typeof a === 'object' && since > 0 && since < EAT_TICKS ? scriptEat(a) : null;
        if (a && eaten) {
            stats.yielded = true; stats.late++; lateEat = { action: { ...a }, id: eaten.id };
            return { success: true, message: 'Eat held for the food delay' };
        }
        note(action);
        return original.call(this, action);
    } : undefined;
    if (client && observer) client.executeBotAction = observer;

    // Sent in the tick callback, in order: the server reads the inputs of one tick in the order they arrive.
    const send = (a: Action) => { own.add(a); try { void Promise.resolve(s.direct(a)).catch(() => {}); } catch { /* session ended */ } };

    const off = s.onTick(() => {
        if (stopped) return;
        const now = s.tick();
        if (inputsAt !== now) { inputsAt = now; inputs = 0; }
        // A late eat is sent only while its slot still holds the same food.
        if (lateEat && now - ateAt >= EAT_TICKS) { if (slotItem(lateEat.action.slot)?.id === lateEat.id) send(lateEat.action); lateEat = null; }
        const st = s.sdk.getState(), p = st?.player;
        if (!p || p.isDead) return;
        const skill = (st.skills ?? []).find((k: any) => k.name === 'Hitpoints'), hp = skill?.level, max = skill?.baseLevel;
        if (!Number.isFinite(hp) || !Number.isFinite(max) || hp <= 0 || max <= 0) return;

        // An interaction that is not an attack ends when the player has stood idle for IDLE_TICKS ticks.
        const tile = `${p.worldX},${p.worldZ},${p.level}`;
        if (pending.kind === 'other') {
            pending.still = tile === lastTile && (p.animId ?? -1) === -1 ? pending.still + 1 : 0;
            if (pending.still >= IDLE_TICKS) pending = { kind: 'none' };
        }
        lastTile = tile;

        if (lastHp !== undefined && hp < lastHp) damageAt = now;
        lastHp = hp; hpFirst ??= hp; hpMin = Math.min(hpMin ?? hp, hp);

        if (sent) {
            if (count(st, sent.id) < sent.before) { stats.eats++; stats.healed += Math.max(0, hp - sent.hp); sent = null; }
            else if (now - sent.at >= EAT_TICKS) { stats.refused++; sent = null; }
        }
        if (stats.yielded || holders > 0 || sent || now - ateAt < EAT_TICKS) return;

        const eatLevel = level(o.eatAt ?? defaultEatAt, max);
        if (hp > eatLevel) return;
        const urgent = hp <= (o.urgentAt === undefined ? Math.floor(eatLevel / 2) : level(o.urgentAt, max));
        if (fightOnly && !fought) return;
        if (now - damageAt > calm) return;
        const choice = selectQuestFood(st, { food, eatAt: eatLevel, reserved: o.reserved?.() });
        if (!choice || !/^eat$/i.test(choice.item.optionsWithIndex?.find(v => v.opIndex === choice.opIndex)?.text ?? '')) return;
        const windows = !!(st.modalOpen || st.dialog?.isOpen || st.interface?.isOpen || st.bank?.isOpen || st.shop?.isOpen);
        if (!urgent && (windows || pending.kind === 'other')) { stats.holds++; return; }
        if (pending.kind === 'attack' && !attackTarget(pending.action, st)) pending = { kind: 'none' };
        const attack = pending.kind === 'attack' ? pending.action : null;
        if (inputs + (attack ? 2 : 1) > MAX_INPUTS) { stats.waits++; return; }

        send({ type: 'useInventoryItem', slot: choice.item.slot, optionIndex: choice.opIndex, reason: 'SDK' });
        sent = { id: choice.item.id, before: count(st, choice.item.id), hp, at: now };
        ateAt = now;
        if (urgent) stats.urgent++;
        // The eat cleared every interaction: one that is not an attack is the script's to send again.
        if (attack) { send({ ...attack }); stats.resends++; } else pending = { kind: 'none' };
    });

    const stop = () => {
        if (stopped) return;
        stopped = true;
        off();
        o.log?.(`EAT_GUARD ${JSON.stringify({ ...stats, fought, held: holders > 0, hp: [hpFirst, hpMin, lastHp] })}`);
        if (client && observer && client.executeBotAction === observer) client.executeBotAction = original;
    };
    // For an eater with checks of its own (sustain.ts startQuestSustain): the guard sends nothing until the release.
    // `ateAt` is the tick of the guard's last eat, so the holder can wait for the food delay.
    const hold = () => {
        holders++;
        let held = true;
        return { ateAt, release: () => { if (held) { held = false; holders--; } } };
    };
    registerSessionEater(s.sdk, hold);
    void s.ended?.then(stop);
    return { stop, hold, stats: () => ({ ...stats }), note };
}
