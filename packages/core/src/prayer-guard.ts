// Prayer guard: keeps the active prayers free of point cost, and turns protection and attack prayers on when they help.
//
// Prayer points drain on a 5-tick timer. The timer starts when the first prayer goes on and is cleared when no prayer
// is on (skill_prayer/scripts/prayer.rs2:30-43,163). A flick turns every active prayer off and on, so the timer never
// fires.
//
// A prayer button closes every open window (skill_prayer/scripts/prayers/*.rs2:2, if_close), clears the pending
// interaction (p_clearpendingaction) and clears the weak queue, which holds a skill batch (engine Player.ts
// closeModal). The guard therefore sends a prayer input only at these times:
// - Right before an input of the script that starts an action. The script's input comes after the prayer inputs in
//   the same tick, so the prayer inputs cancel nothing.
// - In a tick with no window open and no interaction pending.
// - In a tick with an attack pending. The guard then sends the same attack again after the prayer inputs.
// At every other time the prayer stays on and drains at the normal rate: a window is open, or an interaction that is
// not an attack runs and the script sends no input.
//
// A script that sends its own prayer input chooses the prayers: from then on the guard turns no prayer on or off, and
// only keeps the active prayers free. A script that turns one prayer off and on in one tick has its own flick: the
// guard then sends nothing more in that session.

export interface GuardSession {
    sdk: { getState(): any };
    tick(): number;
    onTick(cb: () => void): () => void;
    direct(action: { type: string; [k: string]: unknown }): Promise<unknown>;
    client?: unknown;
    ended?: Promise<unknown>;
}

export const PROTECT = { magic: 12, missiles: 13, melee: 14 } as const;
const PROTECT_ITEM = 8;
// vendor/rs-sdk/sdk/types.ts PRAYER_LEVELS.
const LEVEL: Record<number, number> = { 1: 4, 2: 7, 4: 13, 5: 16, 8: 25, 10: 31, 11: 34, 12: 37, 13: 40, 14: 43 };
// Strength and Attack prayers, the strongest first (5%, 10%, 15%).
const STRENGTH = [10, 4, 1], ATTACK = [11, 5, 2];
const best = (prayers: readonly number[], level: number): number | null => prayers.find(i => level >= LEVEL[i]!) ?? null;

export type AttackStyle = 'melee' | 'ranged' | 'magic';
const PROTECT_FROM: Record<AttackStyle, number> = { melee: PROTECT.melee, ranged: PROTECT.missiles, magic: PROTECT.magic };
// The protection prayer for one NPC, from a table of the styles its attack script can use
// (packages/knowledge/src/npc-attack-styles.ts). An NPC that is not in the table uses melee. An NPC with melee and
// another style uses melee while it stands next to the player. `magic` first in the list: a spell of the NPC binds or
// drains, and magic protection comes first at each distance.
export const protectByStyle = (table: ReadonlyMap<number, readonly AttackStyle[]>) => (npc: any | null): number => {
    const styles = npc ? table.get(npc.id) : undefined;
    if (!styles) return PROTECT.melee;
    if (styles[0] === 'magic') return PROTECT.magic;
    if (styles.includes('melee') && npc.distance <= 1 + Math.floor((npc.size ?? 1) / 2)) return PROTECT.melee;
    return styles.includes('magic') ? PROTECT.magic : styles.includes('ranged') ? PROTECT.missiles : PROTECT.melee;
};

// One NPC that attacks first (packages/knowledge/src/npc-hunters.ts).
export interface Hunter { range: number; wander: number; level: number; tooStrong: boolean }
// The Wilderness level of a tile, 0 outside: one level for each 8 tiles north of the south edge of a zone
// (area_wilderness/scripts/wilderness_levels.rs2; zones in area_wilderness/configs/wilderness_zones.dbrow).
export const wildernessLevel = (x: number, z: number): number => x < 2944 || x >= 3392 ? 0
    : z >= 3520 && z < 6400 ? Math.floor((z - 3520) / 8) + 1
    : z >= 9920 && z < 12800 ? Math.floor((z - 9920) / 8) + 1 : 0;
// The farthest NPC the guard treats as a threat before it attacks.
const HUNT_VIEW = 15;

export interface PrayerGuardOptions {
    // The NPCs that attack first. With a table, the guard turns protection on when such an NPC can reach the player:
    // the player is within the NPC's hunt range plus its wander range, and the NPC's too-strong rule does not
    // exclude the player's combat level. Without a table, the guard waits for an NPC that targets the player.
    hunters?: ReadonlyMap<number, Hunter>;
    // Players in the Wilderness. With this value, a player in view is a threat when the level rule lets that player
    // attack: the combat level difference is not above the lower Wilderness level of the two tiles
    // (skill_combat/scripts/pvp/pvp_combat.rs2:32, pvp_level_check). The guard then also turns Protect Item on.
    // `ignore`: account names in lower case that are never a threat. `style`: the attack style of one player, null
    // when it is not known; the guard then uses melee for a player on the next tile and magic for a farther one.
    players?: { ignore?: ReadonlySet<string>; style?: (player: any) => AttackStyle | null };
    // false: never turn a protection prayer on; only keep the script's prayers free.
    // A function: the protection prayer for one attacking NPC (null when only a hit was seen). Default: melee.
    protect?: false | ((npc: any | null) => number | null);
    // true: while the script attacks an NPC with a melee weapon, turn the strongest Strength and Attack prayers on.
    // `melee` says if the worn weapon is a melee weapon; without it each weapon counts as melee.
    offence?: boolean;
    melee?: (state: any) => boolean;
    // Ticks between two flicks. 3 leaves one tick of delay before the 5-tick timer can fire.
    every?: number;
    // Ticks without a threat before the guard turns its own protection prayer off.
    calmTicks?: number;
    // Receives one PRAYER_GUARD line with the counts and the prayer points when the guard stops.
    log?: (line: string) => void;
    // Receives one line for each prayer input the guard sends (the tick, the prayer and the reason), for each hit the
    // player dealt or took, for each change of the Attack and Strength levels and for each new game message.
    trace?: (line: string) => void;
}

export interface PrayerGuardStats {
    // Flicks in all, and those sent right before a script input.
    flicks: number; early: number;
    // Ticks with a prayer on and no flick possible, in all and for each cause: `window`, `five` (five prayers or
    // more) or the type of the script input whose action runs.
    holds: number; holdsBy: Record<string, number>;
    protects: number; repairs: number; resends: number;
    // Prayer points the state showed going down.
    spent: number;
    manual: boolean; yielded: boolean;
}

// Script inputs that start no action the guard could cancel. Every other input is an interaction.
const NEUTRAL = new Set(['say', 'privateMessage', 'wait', 'none', 'scanGroundItems', 'scanNearbyLocs', 'setTab', 'setCombatStyle',
    'searchGE', 'closeModal', 'closeShop', 'useInventoryItem', 'useEquipmentItem', 'dropItem', 'bankDeposit', 'bankWithdraw',
    'shopBuy', 'shopSell']);
// Ticks the player must stand with no animation before an interaction that is not an attack counts as ended.
const IDLE_TICKS = 6;
// A pickup ends when the item count in the pack goes up, or when the player has stood idle for this many ticks.
const PICKUP_IDLE_TICKS = 2;
// Ticks the Strength and Attack prayers stay on after the last tick with an attack pending.
const OFFENCE_GRACE = 6;
const held = (st: any, id: number): number => (st?.inventory ?? []).reduce((n: number, i: any) => (i.id === id ? n + i.count : n), 0);
// Prayers that turn each other off (skill_prayer/configs, prayer_deactivate): Defence, Strength, Attack, protection.
const EXCLUSIVE = [[0, 3, 9], [1, 4, 10], [2, 5, 11], [12, 13, 14]];
// The active prayers after one button, from the prayers that were active before it.
export const afterToggle = (active: readonly number[], prayer: number): number[] => active.includes(prayer) ? active.filter(i => i !== prayer)
    : [...active.filter(i => !EXCLUSIVE.find(group => group.includes(prayer))?.includes(i)), prayer];
// The server reads 5 inputs of a player in one tick and keeps the rest for the next tick (engine NetworkPlayer.ts:70,
// ClientGameProtCategory USER_EVENT). A flick never sends more than 5 in a tick. Two prayers go off and on in one tick
// with one attack. Three or four prayers all go off in the first tick; the protection prayer comes back on in that
// tick, and the others in the next tick. Five prayers or more would leave no input for the protection prayer.
const TICK_INPUTS = 5;
const MAX_FLICKED = 4;
// The order prayers come back on: protection, then Defence, then the others.
const backFirst = (prayer: number) => prayer >= 12 ? 0 : [0, 3, 9].includes(prayer) ? 1 : 2;
// Skill actions that a second click on the same rock, tree or fishing spot does not start again: their timer is the
// player variable %action_delay, which a click sets only when it is in the past (skill_mining/scripts/mining.rs2:76,
// skill_woodcutting/scripts/woodcut.rs2:55, skill_fishing/scripts/fishing_spots/freshfish.rs2:37 and each other file
// of that folder). The guard treats them like an attack: it flicks, then sends the click again.
const REPEATABLE = /^(mine|chop down|chop)$/i, FISHING_SPOT = /^fishing spot$/i;
// The level-up message (content levelup/configs/levelup.dbrow). A prayer button closes it, which costs the script nothing.
const LEVEL_UP = /^Congratulations, you just advanced/;
// The state shows a prayer input at most this many ticks after the guard saw it.
const STATE_LAG = 2;

type Action = { type: string; [k: string]: unknown };
type Pending = { kind: 'none' } | { kind: 'attack'; action: Action } | { kind: 'other'; type: string; still: number; need: number; item?: number; had?: number };

export function startPrayerGuard(s: GuardSession, o: PrayerGuardOptions = {}) {
    const every = o.every ?? 3, calm = o.calmTicks ?? 20;
    if (!Number.isSafeInteger(every) || every < 1 || every > 4) throw new Error('prayer guard: every must be 1..4');
    const stats: PrayerGuardStats = { flicks: 0, early: 0, holds: 0, holdsBy: {}, protects: 0, repairs: 0, resends: 0, spent: 0, manual: false, yielded: false };
    const own = new WeakSet<object>();
    // Prayers the guard turned on, with the tick, and the tick up to which each is still wanted.
    const owned = new Map<number, number>(), keep = new Map<number, number>();
    // What a prayer input sent in the last STATE_LAG ticks makes of each prayer, until the state shows it.
    const intents = new Map<number, { on: boolean; at: number }>();
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
    // Outside a multi-combat area the engine refuses an attack on an NPC while another NPC has hit the player in the
    // last 8 ticks: "I'm already under attack!" (skill_combat/scripts/player/player_combat.rs2:118). The game then
    // fights the attacker by auto-retaliate. After that message the attack the guard sends again goes to the
    // attacker, not to the script's refused target, until the script sends its next input or the attacker is gone.
    let refusedSeen = -1, attackerIndex: number | null = null;
    // Ticks of the last two hits the player dealt, for the tick of the next one.
    let swingAt = -Infinity, swingBefore = -Infinity;

    const hold = (cause: string) => { stats.holds++; stats.holdsBy[cause] = (stats.holdsBy[cause] ?? 0) + 1; };
    const attackTarget = (a: Action, st: any): boolean => {
        if (a.type === 'interactPlayer') return a.optionIndex === 2 && (st?.nearbyPlayers ?? []).some((p: any) => p.index === a.playerIndex);
        if (a.type !== 'interactNpc') return false;
        const n = (st?.nearbyNpcs ?? []).find((n: any) => n.index === a.npcIndex);
        return !!n && n.hp !== 0 && (n.optionsWithIndex ?? []).some((op: any) => op.opIndex === a.optionIndex && /^Attack$/i.test(op.text));
    };
    // The open dialog is the level-up message: the state has its text in the newest entry of `recentDialogs`.
    const levelUp = (st: any): boolean => {
        if (!st?.dialog?.isOpen) return false;
        let newest: any = null;
        for (const entry of st.recentDialogs ?? []) if (!newest || entry.tick >= newest.tick) newest = entry;
        return !!newest && LEVEL_UP.test((newest.text ?? []).join(' ').trim());
    };
    const skillTarget = (a: Action, st: any): boolean => {
        if (a.type === 'interactNpc') {
            const spot = (st?.nearbyNpcs ?? []).find((n: any) => n.index === a.npcIndex);
            return !!spot && FISHING_SPOT.test(spot.name ?? '') && (spot.optionsWithIndex ?? []).some((op: any) => op.opIndex === a.optionIndex);
        }
        if (a.type !== 'interactLoc') return false;
        const loc = (st?.nearbyLocs ?? []).find((l: any) => l.id === a.locId && l.x === a.x && l.z === a.z);
        return !!loc && (loc.optionsWithIndex ?? []).some((op: any) => op.opIndex === a.optionIndex && REPEATABLE.test(op.text ?? ''));
    };
    const windowOpen = (st: any): boolean => {
        const other = !!(st.interface?.isOpen || st.bank?.isOpen || st.shop?.isOpen || st.modalOpen);
        return other || (!!st.dialog?.isOpen && !levelUp(st));
    };
    // The active prayers: the state, with each prayer input of the last STATE_LAG ticks applied.
    const believed = (st: any, now: number): number[] => {
        const set = new Set<number>((st?.prayers?.activePrayers ?? []).flatMap((on: boolean, i: number) => (on ? [i] : [])));
        for (const [i, v] of intents) {
            if (now - v.at > STATE_LAG) intents.delete(i);
            else if (v.on) set.add(i); else set.delete(i);
        }
        return [...set].sort((a, b) => a - b);
    };
    const intend = (before: readonly number[], prayer: number, now: number): number[] => {
        const after = afterToggle(before, prayer);
        for (const i of [...before, prayer]) if (before.includes(i) !== after.includes(i)) intents.set(i, { on: after.includes(i), at: now });
        return after;
    };

    // Each input is its own network write, and a server tick can start between two writes: the off and the on of a
    // flick would then land in two ticks, with the prayer off for one tick. The guard therefore holds the client's
    // writes from its first input of a moment to the next macrotask: its inputs, and a script input that follows them,
    // leave in one write. The lockstep practice engine already sends one write for each tick (inprocess.ts).
    const wire = s.client as { flush?: () => void } | undefined;
    let holding = false;
    const holdWrites = () => {
        if (holding || process.env.SIM_LOCKSTEP === '1' || !wire || typeof wire.flush !== 'function' || Object.prototype.hasOwnProperty.call(wire, 'flush')) return;
        holding = true;
        let wanted = false;
        wire.flush = () => { wanted = true; };
        setImmediate(() => {
            holding = false;
            delete wire.flush;
            // The client's own flush, from its prototype again.
            const flush = (s.client as { flush?: () => void }).flush;
            if (wanted) flush?.call(s.client);
        });
    };
    // Sent in order: the server reads the inputs of one tick in the order they arrive.
    // The inputs the guard sent in the current tick: with the script's input they must not pass TICK_INPUTS.
    let sentAt = -1, sent = 0;
    const send = (a: Action) => { const t = s.tick(); if (sentAt !== t) { sentAt = t; sent = 0; } sent++; own.add(a); holdWrites(); try { void Promise.resolve(s.direct(a)).catch(() => {}); } catch { /* session ended */ } };
    let why = '', tracedLevels = '', tracedMessage = -1, tracedView = '';
    const toggle = (prayerIndex: number) => { o.trace?.(`GUARD t=${s.tick()} prayer=${prayerIndex} ${why}`); send({ type: 'togglePrayer', prayerIndex, reason: 'SDK' }); };
    const fights = (now: number): boolean => pending.kind === 'attack' || (pending.kind === 'none' && !!retaliate && now - retaliate.at <= 1);
    const gameFight = (now: number): boolean => !!retaliate && now - retaliate.at <= 1 && (pending.kind === 'none' || (pending.kind === 'attack' && attackerIndex !== null));
    const resend = (st: any) => {
        if (gameFight(s.tick()) && retaliate) {
            const n = (st?.nearbyNpcs ?? []).find((n: any) => n.index === retaliate!.action.npcIndex);
            if (n && n.hp !== 0) { send({ ...retaliate.action }); stats.resends++; }
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
        const active = expect ?? believed(st, now);
        if (!active.length) return;
        // The guard's own prayers go off before an input that is not an attack. Strength and Attack: always. The
        // others: when no threat is near and the input starts an action, because they cannot be flicked while that
        // action runs.
        const drop = attack ? [] : active.filter(i => owned.has(i) && (i < 12 && i !== PROTECT_ITEM ? true : a.type !== 'walkTo' && !threatNow));
        if (drop.length) {
            why = 'off-before-input';
            let left: number[] = [...active];
            for (const i of drop.slice(0, room)) { toggle(i); owned.delete(i); left = intend(left, i, now); }
            // With inputs to spare, the prayers that stay on go off and on after them: for one moment no prayer is
            // on, which clears the drain timer.
            if (left.length && drop.length + 2 * left.length <= room) {
                why = 'flick-after-off';
                for (const i of left) toggle(i);
                for (const i of left) toggle(i);
                flickAt = now; stats.flicks++; stats.early++;
                expect = left; expectAt = now;
            } else if (expect) { expect = left; expectAt = now; }
            return;
        }
        if (!expect && 2 * active.length <= room && now - flickAt >= 1) { flickNow(active, now); stats.early++; }
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
            const after = intend(expect ?? believed(s.sdk.getState(), now), prayer, now);
            if (expect) { expect = after; expectAt = now; }
            return;
        }
        // A click on the level-up message starts no action.
        if (NEUTRAL.has(a.type) || (a.type === 'clickDialogOption' && levelUp(s.sdk.getState()))) { inputs++; return; }
        const attack = (a.type === 'interactNpc' || a.type === 'interactPlayer') && attackTarget(a, s.sdk.getState());
        beforeInput(a, attack);
        inputs++;
        attackerIndex = null;
        if (a.type === 'walkTo') { pending = { kind: 'none' }; walkAt = now; retaliate = null; return; }
        // `attack` also holds a mining or woodcutting click: the guard sends it again after its prayer inputs.
        if (attack || skillTarget(a, s.sdk.getState())) { pending = { kind: 'attack', action: { ...a } }; return; }
        if (a.type === 'pickupItem') { const item = a.itemId as number; pending = { kind: 'other', type: a.type, still: 0, need: PICKUP_IDLE_TICKS, item, had: held(s.sdk.getState(), item) }; return; }
        pending = { kind: 'other', type: a.type, still: 0, need: IDLE_TICKS };
    };

    const client = s.client as { executeBotAction?: (action: unknown) => unknown } | undefined;
    const original = client?.executeBotAction;
    const observer = typeof original === 'function' ? function (this: unknown, action: unknown) { note(action); return original.call(this, action); } : undefined;
    if (client && observer) client.executeBotAction = observer;

    const rivalPlayer = (st: any, p: any, self: unknown): { player: any; attacks: boolean } | null => {
        const mine = o.players ? wildernessLevel(p.worldX, p.worldZ) : 0;
        if (mine < 1) return null;
        let best: { player: any; attacks: boolean } | null = null;
        for (const q of st.nearbyPlayers ?? []) {
            if (o.players!.ignore?.has(String(q.name).toLowerCase())) continue;
            const level = Math.min(mine, wildernessLevel(q.worldX ?? q.x, q.worldZ ?? q.z));
            if (level < 1 || Math.abs(q.combatLevel - p.combatLevel) > level) continue;
            const attacks = q.combatTargetType === 'player' && q.combatTargetIndex === self;
            if (!best || (attacks && !best.attacks) || (attacks === best.attacks && q.distance < best.player.distance)) best = { player: q, attacks };
        }
        return best;
    };

    const nearestHunter = (st: any, p: any): any | null => {
        if (!o.hunters) return null;
        const wild = wildernessLevel(p.worldX, p.worldZ) > 0;
        let best: any | null = null, bestReaches = false;
        for (const n of st.nearbyNpcs ?? []) {
            const h = o.hunters.get(n.id);
            if (!h || n.hp === 0 || n.distance > Math.min(HUNT_VIEW, h.range + h.wander)) continue;
            if (h.tooStrong && !wild && p.combatLevel > h.level * 2) continue;
            // An NPC whose hunt range reaches the player now comes before one that must walk first: its attack
            // style is the one that lands first.
            const reaches = n.distance <= h.range + 1;
            if (!best || (reaches && !bestReaches) || (reaches === bestReaches && n.distance < best.distance)) { best = n; bestReaches = reaches; }
        }
        return best;
    };

    const off = s.onTick(() => {
        if (stopped || stats.yielded) return;
        const st = s.sdk.getState(), p = st?.player, prayers = st?.prayers;
        if (!p || p.isDead || !prayers || !Array.isArray(prayers.activePrayers)) return;
        const now = s.tick();
        if (pointsLast !== undefined && prayers.prayerPoints < pointsLast) stats.spent += pointsLast - prayers.prayerPoints;
        pointsFirst ??= prayers.prayerPoints; pointsLast = prayers.prayerPoints;
        if (o.trace) {
            for (const e of st.combatEvents ?? []) if (e.tick > lastEvent) o.trace(`GUARD t=${now} hit ${e.type} damage=${e.damage} target=${e.targetType}:${e.targetIndex} at=${e.tick}`);
            const level = (name: string) => { const k = (st.skills ?? []).find((k: any) => k.name === name); return k ? `${k.level}/${k.baseLevel}` : '?'; };
            const levels = `attack=${level('Attack')} strength=${level('Strength')}`;
            if (levels !== tracedLevels) { tracedLevels = levels; o.trace(`GUARD t=${now} levels ${levels}`); }
            let newestMessage = tracedMessage;
            for (const m of st.gameMessages ?? []) if ((m.tick ?? -1) > tracedMessage) { newestMessage = Math.max(newestMessage, m.tick); o.trace(`GUARD t=${now} message ${String(m.text ?? '').slice(0, 80)}`); }
            tracedMessage = newestMessage;
            const target = p.combat?.targetType === 'npc' ? `npc:${p.combat.targetIndex}` : 'none';
            const wantsNpc = pending.kind === 'attack' ? `${pending.action.type}:${pending.action.npcIndex ?? pending.action.locId}` : pending.kind;
            const view = `target=${target} pending=${wantsNpc}`;
            if (view !== tracedView) { tracedView = view; o.trace(`GUARD t=${now} fight ${view}`); }
        }
        // A hit on the player has the player as its target: a hit of another player on an NPC is `damage_taken` too.
        let newest = lastEvent, hit = false;
        for (const e of st.combatEvents ?? []) {
            if (e.type === 'damage_taken' && e.targetType === 'player') {
                if (e.tick > lastEvent) taken += e.damage;
                if (now - e.tick <= 8) hit = true;
            }
            if (e.type === 'damage_dealt' && e.sourceType === 'player' && e.tick > swingAt) { swingBefore = swingAt; swingAt = e.tick; }
            newest = Math.max(newest, e.tick);
        }
        lastEvent = newest;
        const active = believed(st, now);

        // An interaction that is not an attack ends when the player has stood idle for its number of ticks.
        const tile = `${p.worldX},${p.worldZ},${p.level}`;
        if (pending.kind === 'other') {
            pending.still = tile === lastTile && (p.animId ?? -1) === -1 ? pending.still + 1 : 0;
            if (pending.still >= pending.need || (pending.item !== undefined && held(st, pending.item) > pending.had!)) pending = { kind: 'none' };
        }
        stillSince = tile === lastTile ? stillSince : now;
        lastTile = tile;
        // The NPC that attacks the player, and the game's refusal of an attack on another NPC.
        const selfSlot = (s.client as any)?.selfSlot;
        const attackOf = (n: any): Action | null => {
            const op = n?.optionsWithIndex?.find((op: any) => /^Attack$/i.test(op.text));
            return n && op && n.hp !== 0 && Number.isSafeInteger(selfSlot) && n.targetIndex === 32768 + selfSlot ? { type: 'interactNpc', npcIndex: n.index, optionIndex: op.opIndex, reason: 'SDK' } : null;
        };
        let refused = false;
        for (const m of st.gameMessages ?? []) if ((m.tick ?? -1) > refusedSeen && /^I'm already under attack/.test(m.text ?? '')) refused = true;
        for (const m of st.gameMessages ?? []) refusedSeen = Math.max(refusedSeen, m.tick ?? -1);
        if (pending.kind === 'attack' && pending.action.type === 'interactNpc') {
            if (refused && attackerIndex === null) {
                const scriptTarget = pending.action.npcIndex;
                const other = (st.nearbyNpcs ?? []).find((n: any) => n.index !== scriptTarget && attackOf(n));
                if (other) attackerIndex = other.index;
            }
            const attack = attackerIndex === null ? null : attackOf((st.nearbyNpcs ?? []).find((n: any) => n.index === attackerIndex));
            if (attack) retaliate = { action: attack, at: now };
            else { attackerIndex = null; retaliate = null; }
        } else if (pending.kind === 'none' && st.autoRetaliateEnabled !== false && p.combat?.targetType === 'npc' && now - walkAt > 3) {
            // An auto-retaliate fight: the player targets an NPC that targets the player, the script has no action
            // of its own, and the player has not walked on a script input in the last 3 ticks.
            const attack = attackOf((st.nearbyNpcs ?? []).find((n: any) => n.index === p.combat.targetIndex));
            if (attack) retaliate = { action: attack, at: now };
        } else if (pending.kind !== 'none') retaliate = null;

        // The state shows a prayer one tick after the server turned it on.
        if (active.length && !wasActive) flickAt = Math.max(flickAt, now - 1);
        wasActive = active.length > 0;
        // Not during a flick: its second tick shows the guard's own prayers off.
        if (!expect && !resume.length) for (const [i, at] of owned) if (!active.includes(i) && now - at > STATE_LAG) owned.delete(i);

        // The prayers the guard wants on in this tick.
        const wanted: number[] = [];
        threatNow = false;
        if (!stats.manual) {
            const self = (s.client as any)?.selfSlot;
            const me = Number.isSafeInteger(self) ? 32768 + self : undefined;
            const rival = o.protect === false ? null : rivalPlayer(st, p, self);
            if (o.protect !== false) {
                const attacker = (st.nearbyNpcs ?? []).find((n: any) => me !== undefined && n.targetIndex === me && n.hp !== 0
                    && (n.optionsWithIndex ?? []).some((op: any) => /^Attack$/i.test(op.text))) ?? null;
                // A player that attacks comes first, then an NPC that attacks, then a player that can attack.
                const npc = rival?.attacks ? null : attacker ?? (rival ? null : nearestHunter(st, p));
                if (npc || rival || hit) {
                    threatAt = now; threatNow = true;
                    const choice = !npc && rival ? PROTECT_FROM[o.players?.style?.(rival.player) ?? (rival.player.distance <= 1 ? 'melee' : 'magic')]
                        : o.protect ? o.protect(npc) : PROTECT.melee;
                    if (choice !== null && prayers.prayerLevel >= (LEVEL[choice] ?? Infinity)) wanted.push(choice);
                }
                if (rival && prayers.prayerLevel >= LEVEL[PROTECT_ITEM]!) wanted.push(PROTECT_ITEM);
            }
            if (o.offence && pending.kind === 'attack' && pending.action.type === 'interactNpc' && attackTarget(pending.action, st) && (o.melee?.(st) ?? true)) {
                for (const i of [best(STRENGTH, prayers.prayerLevel), best(ATTACK, prayers.prayerLevel)]) if (i !== null) wanted.push(i);
            }
        }
        for (const i of wanted) keep.set(i, now + (i >= 12 || i === PROTECT_ITEM ? calm : OFFENCE_GRACE));

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
                if (now - flickAt < 4 || !safe || !expect.length || expect.length > 2) return;
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

        const missing = wanted.filter(i => !active.includes(i));
        const stale = active.filter(i => owned.has(i) && !wanted.includes(i) && now > (keep.get(i) ?? -Infinity));
        if (missing.length || stale.length) {
            let target = active.filter(i => !stale.includes(i));
            for (const i of missing) target = afterToggle(target, i);
            const order = [...target].sort((x, y) => backFirst(x) - backFirst(y));
            why = `set ${order.join('+') || 'none'} from ${active.join('+') || 'none'} threat=${threatNow}`;
            if (active.length && active.length + order.length + (fights(now) ? 1 : 0) <= TICK_INPUTS) {
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
        if (active.length > MAX_FLICKED) { hold('five'); return; }
        const attack = fights(now) ? 1 : 0;
        if (active.length <= 2) {
            if (now - flickAt < every) return;
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
    return { stop, release, stats: () => ({ ...stats, holdsBy: { ...stats.holdsBy } }), note };
}
