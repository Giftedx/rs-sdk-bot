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
// A prayer button also clears the weak queue (engine Player.ts closeModal), which holds a skill batch. Each script
// input that can start an action therefore counts as an interaction, except the single-item inputs in NEUTRAL.
//
// A script that sends its own prayer input chooses the prayers: from then on the guard turns no protection prayer
// on or off, and only keeps the active prayers free. It sends nothing in the tick of a script prayer input or the
// two ticks after: the state can show that input late. A script that turns one prayer off and on in one tick has its own flick: the guard then sends nothing
// more in that session.

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

export type AttackStyle = 'melee' | 'ranged' | 'magic';
const PROTECT_FROM: Record<AttackStyle, number> = { melee: PROTECT.melee, ranged: PROTECT.missiles, magic: PROTECT.magic };
// The protection prayer for one NPC, from a table of the styles its attack script can use
// (packages/knowledge/src/npc-attack-styles.ts). An NPC that is not in the table uses melee. An NPC with melee and
// another style uses melee while it stands next to the player.
export const protectByStyle = (table: ReadonlyMap<number, readonly AttackStyle[]>) => (npc: any | null): number => {
    const styles = npc ? table.get(npc.id) : undefined;
    if (!styles) return PROTECT.melee;
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
    // (skill_combat/scripts/pvp/pvp_combat.rs2:32, pvp_level_check).
    // `ignore`: account names in lower case that are never a threat. `style`: the attack style of one player, null
    // when it is not known; the guard then uses melee for a player on the next tile and magic for a farther one.
    players?: { ignore?: ReadonlySet<string>; style?: (player: any) => AttackStyle | null };
    // false: never turn a protection prayer on; only keep the script's prayers free.
    // A function: the protection prayer for one attacking NPC (null when only a hit was seen). Default: melee.
    protect?: false | ((npc: any | null) => number | null);
    // Ticks between two flicks. 3 leaves one tick of delay before the 5-tick timer can fire.
    every?: number;
    // Ticks without a threat before the guard turns its own protection prayer off.
    calmTicks?: number;
    // Receives one PRAYER_GUARD line with the counts and the prayer points when the guard stops.
    log?: (line: string) => void;
}

export interface PrayerGuardStats { flicks: number; holds: number; protects: number; repairs: number; resends: number; manual: boolean; yielded: boolean }

// Script inputs that start no action the guard could cancel. Every other input is an interaction.
const NEUTRAL = new Set(['say', 'privateMessage', 'wait', 'none', 'scanGroundItems', 'scanNearbyLocs', 'setTab', 'setCombatStyle',
    'searchGE', 'closeModal', 'closeShop', 'useInventoryItem', 'useEquipmentItem', 'dropItem', 'bankDeposit', 'bankWithdraw',
    'shopBuy', 'shopSell']);
// Ticks the player must stand with no animation before an interaction that is not an attack counts as ended.
const IDLE_TICKS = 6;
// Prayers that turn each other off (skill_prayer/configs, prayer_deactivate): Defence, Strength, Attack, protection.
const EXCLUSIVE = [[0, 3, 9], [1, 4, 10], [2, 5, 11], [12, 13, 14]];
// The active prayers after one button, from the prayers that were active before it.
export const afterToggle = (active: readonly number[], prayer: number): number[] => active.includes(prayer) ? active.filter(i => i !== prayer)
    : [...active.filter(i => !EXCLUSIVE.find(group => group.includes(prayer))?.includes(i)), prayer];
// One tick holds 5 inputs (scripts/pk.ts, prayerFlick): two prayers off and on, and one attack.
const MAX_FLICKED = 2;

type Action = { type: string; [k: string]: unknown };
type Pending = { kind: 'none' } | { kind: 'attack'; action: Action } | { kind: 'other'; still: number };

export function startPrayerGuard(s: GuardSession, o: PrayerGuardOptions = {}) {
    const every = o.every ?? 3, calm = o.calmTicks ?? 20;
    if (!Number.isSafeInteger(every) || every < 1 || every > 4) throw new Error('prayer guard: every must be 1..4');
    const stats: PrayerGuardStats = { flicks: 0, holds: 0, protects: 0, repairs: 0, resends: 0, manual: false, yielded: false };
    const own = new WeakSet<object>();
    const owned = new Map<number, number>();
    let stopped = false, flickAt = -Infinity, threatAt = -Infinity, protectAt = -Infinity, scriptPrayerAt = -Infinity;
    let scriptPrayers: number[] = [];
    let pending: Pending = { kind: 'none' };
    let expect: number[] | null = null, expectAt = 0, wasActive = false, lastTile = '';
    let pointsFirst: number | undefined, pointsLast: number | undefined, taken = 0, lastEvent = -Infinity;

    const attackTarget = (a: Action, st: any): boolean => {
        if (a.type === 'interactPlayer') return a.optionIndex === 2 && (st?.nearbyPlayers ?? []).some((p: any) => p.index === a.playerIndex);
        const n = (st?.nearbyNpcs ?? []).find((n: any) => n.index === a.npcIndex);
        return !!n && n.hp !== 0 && (n.optionsWithIndex ?? []).some((op: any) => op.opIndex === a.optionIndex && /^Attack$/i.test(op.text));
    };

    // Every input of the script passes here before the client sends it.
    const note = (action: unknown) => {
        const a = action as Action | null;
        if (stopped || !a || typeof a !== 'object' || own.has(a)) return;
        if (a.type === 'togglePrayer') {
            const now = s.tick(), prayer = a.prayerIndex as number;
            if (scriptPrayerAt !== now) scriptPrayers = [];
            // The same prayer two times in one tick: the script has its own flick.
            if (scriptPrayers.includes(prayer)) stats.yielded = true;
            scriptPrayers.push(prayer);
            scriptPrayerAt = now; stats.manual = true; owned.clear();
            // The guard flicked in this tick and the script chose from the prayers before the flick: the inputs can
            // cancel each other. The repair then makes the prayers the script chose.
            expect = expect && expectAt === now ? afterToggle(expect, prayer) : null;
            return;
        }
        if (NEUTRAL.has(a.type)) return;
        if (a.type === 'walkTo') { pending = { kind: 'none' }; return; }
        if ((a.type === 'interactNpc' || a.type === 'interactPlayer') && attackTarget(a, s.sdk.getState())) { pending = { kind: 'attack', action: { ...a } }; return; }
        pending = { kind: 'other', still: 0 };
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
        let best: any | null = null;
        for (const n of st.nearbyNpcs ?? []) {
            const h = o.hunters.get(n.id);
            if (!h || n.hp === 0 || n.distance > Math.min(HUNT_VIEW, h.range + h.wander)) continue;
            if (h.tooStrong && !wild && p.combatLevel > h.level * 2) continue;
            if (!best || n.distance < best.distance) best = n;
        }
        return best;
    };

    const off = s.onTick(() => {
        if (stopped || stats.yielded) return;
        const st = s.sdk.getState(), p = st?.player, prayers = st?.prayers;
        if (!p || p.isDead || !prayers || !Array.isArray(prayers.activePrayers)) return;
        const now = s.tick();
        pointsFirst ??= prayers.prayerPoints; pointsLast = prayers.prayerPoints;
        for (const e of st.combatEvents ?? []) if (e.type === 'damage_taken' && e.tick > lastEvent) { taken += e.damage; lastEvent = e.tick; }
        const active: number[] = prayers.activePrayers.flatMap((on: boolean, i: number) => (on ? [i] : []));

        // An interaction that is not an attack ends when the player has stood idle for IDLE_TICKS ticks.
        const tile = `${p.worldX},${p.worldZ},${p.level}`;
        if (pending.kind === 'other') {
            pending.still = tile === lastTile && (p.animId ?? -1) === -1 ? pending.still + 1 : 0;
            if (pending.still >= IDLE_TICKS) pending = { kind: 'none' };
        }
        lastTile = tile;

        // The state shows a prayer one tick after the server turned it on.
        if (active.length && !wasActive) flickAt = Math.max(flickAt, now - 1);
        wasActive = active.length > 0;
        for (const [i, at] of owned) if (!active.includes(i) && now - at > 2) owned.delete(i);

        let wanted: number | null = null;
        if (o.protect !== false && !stats.manual) {
            const self = (s.client as any)?.selfSlot;
            const me = Number.isSafeInteger(self) ? 32768 + self : undefined;
            const attacker = (st.nearbyNpcs ?? []).find((n: any) => me !== undefined && n.targetIndex === me && n.hp !== 0
                && (n.optionsWithIndex ?? []).some((op: any) => /^Attack$/i.test(op.text))) ?? null;
            // A player that attacks comes first, then an NPC that attacks, then a player that can attack.
            const rival = rivalPlayer(st, p, self);
            const npc = rival?.attacks ? null : attacker ?? (rival ? null : nearestHunter(st, p));
            const hit = (st.combatEvents ?? []).some((e: any) => e.type === 'damage_taken' && e.sourceType !== 'player' && now - e.tick <= 8);
            if (npc || rival || hit) {
                threatAt = now;
                const choice = !npc && rival ? PROTECT_FROM[o.players?.style?.(rival.player) ?? (rival.player.distance <= 1 ? 'melee' : 'magic')]
                    : o.protect ? o.protect(npc) : PROTECT.melee;
                if (choice !== null && prayers.prayerLevel >= (PROTECT_LEVEL[choice] ?? Infinity)) wanted = choice;
            }
        }

        if (prayers.prayerPoints < 1) return;
        const windows = !!(st.modalOpen || st.dialog?.isOpen || st.interface?.isOpen || st.bank?.isOpen || st.shop?.isOpen);
        const safe = !windows && pending.kind !== 'other';

        if (now - scriptPrayerAt < 3) return;
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
        o.log?.(`PRAYER_GUARD ${JSON.stringify({ ...stats, points: [pointsFirst, pointsLast], taken })}`);
        if (client && observer && client.executeBotAction === observer) client.executeBotAction = original;
    };
    // For a script that needs every prayer off before it starts: stops the guard, turns the guard's own prayers off
    // and waits up to 4 ticks until the state shows them off.
    const release = async (): Promise<void> => {
        const state = () => s.sdk.getState()?.prayers?.activePrayers as boolean[] | undefined;
        const mine = [...owned.keys()].filter(i => state()?.[i]);
        if (stopped) return;
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
    return { stop, release, stats: () => ({ ...stats }), note };
}
