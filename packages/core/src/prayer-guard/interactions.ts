import { npcDead } from './threats';
import type { Action } from './types';

// Script inputs that start no action the guard could cancel. Every other input is an interaction.
export const NEUTRAL = new Set(['say', 'privateMessage', 'wait', 'none', 'scanGroundItems', 'scanNearbyLocs', 'setTab', 'setCombatStyle',
    'searchGE', 'closeModal', 'closeShop', 'useInventoryItem', 'useEquipmentItem', 'dropItem', 'bankDeposit', 'bankWithdraw',
    'shopBuy', 'shopSell']);
// Ticks the player must stand with no animation before an interaction that is not an attack counts as ended.
export const IDLE_TICKS = 6;
// A pickup ends when the item count in the pack goes up, or when the player has stood idle for this many ticks.
export const PICKUP_IDLE_TICKS = 2;

export const held = (st: any, id: number): number => (st?.inventory ?? []).reduce((n: number, i: any) => (i.id === id ? n + i.count : n), 0);

// Skill actions that a second click on the same rock, tree or fishing spot does not start again: their timer is the
// player variable %action_delay, which a click sets only when it is in the past (skill_mining/scripts/mining.rs2:76,
// skill_woodcutting/scripts/woodcut.rs2:55, skill_fishing/scripts/fishing_spots/freshfish.rs2:37 and each other file
// of that folder). The guard treats them like an attack: it flicks, then sends the click again.
// The guard leaves auto-retaliate on during these actions. A hit with auto-retaliate on sets %action_delay to 2 ticks
// ahead when it is in the past (skill_combat/scripts/player/auto_retaliate.rs2), and the next click on a rock then
// rolls after those 2 ticks, not after the full rate of the pickaxe. Measured on `extra:guard-mine` at seeds 1 to 3,
// 25 iron ore: auto-retaliate off takes 263, 280 and 272 ticks against 265, 281 and 252 with a rune pickaxe, and 392,
// 400 and 392 against 333, 356 and 314 with a bronze pickaxe at Mining 15. Willows with a bronze axe under dark wizards
// (`extra:guard-chop-wizard`, 12 logs): 409, 473 and over 500 ticks against 454, 450 and 362. Net fishing beside a scorpion
// (`extra:guard-fish-scorpion`, 12 fish): 95, 110 and 100 ticks against 100, 106 and 103.
const REPEATABLE = /^(mine|chop down|chop)$/i, FISHING_SPOT = /^fishing spot$/i;

// A click on a fishing spot is different: it does something on three ticks of the timer only. With the timer in the
// past it starts the timer at 4 ticks and goes on; one tick later (timer at 3) it casts and hands over to the hidden
// option that rolls for the fish when the timer ends; on each other tick it does nothing and the fishing stops
// (skill_fishing/scripts/fishing_spots/saltfish.rs2 `attempt_fish_shrimp`, and the same in each file of that folder).
// The server refuses the hidden option from a client (engine OpNpcHandler.ts). So during fishing the guard flicks
// and clicks on two ticks of a cycle of FISH_CYCLE ticks only: on the tick that starts the timer and on the next
// one. The roll on tick 4 runs with no input, and the next cycle starts on tick 5, the longest gap the drain timer
// allows. With 3 or 4 prayers on, the two-tick flick needs a start each 4 ticks, which no 5-tick cycle has: the guard
// then keeps the prayer points and loses most rolls.
// A cycle whose first click comes on the roll tick stays there: the second click then starts the timer, and the
// next first click is on the roll tick again. A click on a river spot (freshfish.rs2) on that tick takes the place
// of the roll, so no fish comes. Three rules move the cycle to the right tick. The state shows the game's message
// for the cast (FISH_START) two ticks after the click that started the timer: that click is the start of the cycle.
// The state shows more Fishing experience one tick after a roll: that tick starts a cycle. With no such message
// seen yet, after FISH_DRY cycles with no catch one cycle has a third click on its third tick, and the cycles
// after it start one tick later.
const FISH_CYCLE = 5, FISH_DRY = 4;
const FISH_START = /^You (cast out your|start Harpooning|lower the Karambwan|attempt to catch (a Lobster|an eel))/;
// The level-up message (content levelup/configs/levelup.dbrow). A prayer button closes it, which costs the script nothing.
const LEVEL_UP = /^Congratulations, you just advanced/;

// The open dialog is the level-up message: the state has its text in the newest entry of `recentDialogs`.
export function levelUpDialog(st: any): boolean {
    if (!st?.dialog?.isOpen) return false;
    let newest: any = null;
    for (const entry of st.recentDialogs ?? []) if (!newest || entry.tick >= newest.tick) newest = entry;
    return !!newest && LEVEL_UP.test((newest.text ?? []).join(' ').trim());
}

export function windowOpen(st: any): boolean {
    const other = !!(st.interface?.isOpen || st.bank?.isOpen || st.shop?.isOpen || st.modalOpen);
    return other || (!!st.dialog?.isOpen && !levelUpDialog(st));
}

export function skillTarget(a: Action, st: any): boolean {
    if (a.type === 'interactNpc') {
        const spot = (st?.nearbyNpcs ?? []).find((n: any) => n.index === a.npcIndex);
        return !!spot && FISHING_SPOT.test(spot.name ?? '') && (spot.optionsWithIndex ?? []).some((op: any) => op.opIndex === a.optionIndex);
    }
    if (a.type !== 'interactLoc') return false;
    const loc = (st?.nearbyLocs ?? []).find((l: any) => l.id === a.locId && l.x === a.x && l.z === a.z);
    return !!loc && (loc.optionsWithIndex ?? []).some((op: any) => op.opIndex === a.optionIndex && REPEATABLE.test(op.text ?? ''));
}

export function isDyingAttackClick(a: Action, st: any): boolean {
    if (a.type !== 'interactNpc') return false;
    const n = (st?.nearbyNpcs ?? []).find((n: any) => n.index === a.npcIndex);
    return !!n && npcDead(n, st) && (n.optionsWithIndex ?? []).some((op: any) => op.opIndex === a.optionIndex && /^Attack$/i.test(op.text));
}

export function createFishingSync() {
    // The tick of the click that started the fishing cycle in progress: a click of the script or of the guard.
    let fishAt = -Infinity, fishXp = -1, fishDry = 0, fishShift = false, fishSeen = -1, fishSynced = false, fishExtra = -1, fishIdx = -1;

    const markStart = (now: number) => { fishAt = now; };
    const isSecondTick = (now: number) => now - fishAt === 1;

    // True on the tick the state shows more Fishing experience than on the tick before.
    const fishCaught = (st: any): boolean => {
        const skills = st.skills;
        let k = fishIdx >= 0 ? skills?.[fishIdx] : undefined;
        if (k?.name !== 'Fishing') {
            k = undefined;
            if (skills) for (let i = 0; i < skills.length; i++) if (skills[i]?.name === 'Fishing') { fishIdx = i; k = skills[i]; break; }
        }
        const xp = k?.experience ?? -1, more = fishXp >= 0 && xp > fishXp;
        fishXp = xp;
        if (more) fishDry = 0;
        return more;
    };

    const observeTick = (st: any, now: number, isFishing: boolean): boolean => {
        const caught = fishCaught(st);
        let cast = false;
        const msgs = st.gameMessages;
        if (msgs?.length) {
            for (let i = 0; i < msgs.length; i++) {
                const m = msgs[i], t = m.tick ?? -1;
                if (isFishing && !cast && t > fishSeen && FISH_START.test(m.text ?? '')) cast = true;
                if (t > fishSeen) fishSeen = t;
            }
        }
        if (cast && isFishing) {
            // A start that moves later leaves 5 ticks from the last flick to the next cycle. One more flick and click
            // on tick 3 fills that gap; on a sea spot it costs the roll of this cycle.
            if (now - 2 > fishAt) fishExtra = now + 1;
            fishSynced = true; fishShift = false; fishAt = now - 2;
        }
        return caught;
    };

    // True on a tick of the fishing cycle that has a flick and a click.
    const shouldFlick = (now: number, caught: boolean, flickAt: number): boolean => {
        const tick = now - fishAt;
        if (caught || tick >= FISH_CYCLE) {
            if (!caught && !fishSynced && ++fishDry > FISH_DRY) { fishDry = 0; fishShift = true; }
            fishAt = now;
            return true;
        }
        if (now === fishExtra) return true;
        // No cycle tick came in time (a window was open on it, or the start moved): a flick and a click now cost at
        // most one roll, and a flick that comes late costs a prayer point.
        if (tick !== 1) return now - flickAt >= FISH_CYCLE - 1;
        if (fishShift) { fishShift = false; fishAt = now; }
        return true;
    };

    return { markStart, isSecondTick, observeTick, shouldFlick };
}
