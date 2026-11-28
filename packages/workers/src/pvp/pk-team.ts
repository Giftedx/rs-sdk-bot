// Practice meeting of two teams of own accounts: SPAR_TEAM accounts a side (default 2), all in one place. Each account
// takes the enemy with the lowest health bar in view (the nearest on a tie), fights it with the fight loop until it
// is dead or gone, then takes the next. The meeting ends when one side has no account left in the Wilderness, or at
// the cap. Side A's accounts know each other as allies (FightOptions.allies), and so do side B's.
// Usage: bun scripts/pk-team.ts <bot> <bot ...> [CAP ticks]: groups of 2 x SPAR_TEAM accounts, side A first.
// SPAR_A, SPAR_B, SPAR_A_OPTS, SPAR_B_OPTS and SPAR_KITS=<kit A>:<kit B> as in scripts/pk-gang.ts; a side's kit may
// be kits joined by `+` (tribrid-snare-spear+tribrid-snare), taken in turn by its members.
// Prints one `TEAM <json>` line for each group and one RESULT: wins (side A left standing), losses, draws.
import type { Session } from '../../../core/src/inprocess';
import { RETALIATE_OFF } from '../../../core/src/combat-end';
import { bestFood, createNeverSkullGuard, ENEMY_WEAPON_IDS, fightPlayer, getObjNames, isDying, isMulti, localPlayerSlot, neverSkullOf, nextTick, observePlayer, observeProvocations, ownSkull, PRAYER, protectedStyles, recordKillLoot, skulled, summarizeWeaponLoot, wildernessLevel, type FightOptions, type Kit } from './fight';
import { TRIBRID_KIT } from './hunt-kits';
import { kitOptions, kitSwitches } from '../../../core/src/pk-kits/kits';
import { sparOptions } from './pk-spar';
import { pickUp, PICKUP_ITEMS } from './pk-gang';
import { createDaggerWatch, daggerOptionsOf, type DaggerOptions } from './squad-dagger';

export const BAIT_3PLUS1_SWITCHES: Kit = { ranged: [861, 2503], melee: [1231, 2503] };
export const BAIT_3PLUS1_OPTIONS: Partial<FightOptions> = {
    rotation: ['ranged', 'melee'],
    comboFood: true,
    zeroDrainFlick: true,
    freeze: 'flee',
    eatAt: 62,
    chase: false,
    protectItem: true,
};

/** Whether a team member should exit fightPlayer early on a 0-HP dying target (disabled when Side A must catch the kill message for looting). */
export const shouldStopOnDying = (hasTeamFocus: boolean, liveCount: number, sideKey: 'a' | 'b', hasPickup: boolean): boolean =>
    hasTeamFocus && liveCount > 1 && !(sideKey === 'a' && hasPickup);

/** Whether a Side A bot anchored on a single-way stack has drifted too far or crossed into multi-way ground. */
export function driftedFromHome(
    pos: { worldX: number; worldZ: number } | null | undefined,
    home: { x: number; z: number; multi: boolean } | null,
    maxLeash = 5,
    multiFn: (x: number, z: number) => boolean = isMulti,
): boolean {
    if (!pos || !home) return false;
    if (!home.multi && multiFn(pos.worldX, pos.worldZ)) return true;
    return Math.max(Math.abs(pos.worldX - home.x), Math.abs(pos.worldZ - home.z)) > maxLeash;
}

/** Whether an openBot onStop reason should halt a team run (ignores 900-tick idle notices when STALL_TICKS is raised). */
export function shouldHaltTeamOnStop(reason: string, stallTicks: number): boolean {
    if (reason === 'died') return false;
    if ((stallTicks === 0 || stallTicks > 900) && /^no progress: \d+ ticks without /.test(reason)) return false;
    return true;
}

/** Resolves team winner from surviving and active (not fled/stopped) counts. */
export function teamWinner(standing: { a: number; b: number }, active: { a: number; b: number }): 'a' | 'b' | 'draw' {
    if (standing.a > 0 && standing.b === 0) return 'a';
    if (standing.b > 0 && standing.a === 0) return 'b';
    if (active.a > 0 && active.b === 0) return 'a';
    if (active.b > 0 && active.a === 0) return 'b';
    return 'draw';
}

const KARAMBWAN_ID = 3144;
const EMPTY_VIAL_ID = 229;

/** Non-blocking tick-by-tick weapon pickup under live combat: guards HP and Protect from Melee every tick and aborts immediately on incoming burst so fightPlayer never stalls inside bot.pickupItem. */
export async function combatPickupWeapons(
    s: Session,
    ids: ReadonlySet<number>,
    opts: {
        radius: number;
        maxTicks: number;
        wait: number;
        minHp?: number;
        eatBelow?: number;
        home?: { x: number; z: number; multi: boolean } | null;
        stop?: () => boolean;
        multiFn?: (x: number, z: number) => boolean;
    },
): Promise<Record<string, number>> {
    const got: Record<string, number> = {};
    const start = s.tick();
    const minHp = opts.minHp ?? 60;
    const eatBelow = opts.eatBelow ?? 72;
    const multiFn = opts.multiFn ?? isMulti;
    const tried = new Set<string>();
    let prevHp = s.sdk.getState()?.player?.hp ?? 99;
    let pending: { id: number; x: number; z: number; before: number; sentAt: number } | null = null;
    const invCount = (inv: readonly { id: number; count: number }[], id: number) =>
        inv.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

    while (s.tick() - start < opts.maxTicks && !opts.stop?.()) {
        const st = s.sdk.getState();
        const me = st?.player;
        if (!st || !me || me.isDead) break;
        if (opts.home && !opts.home.multi && multiFn(me.worldX, me.worldZ)) break;
        const hp = me.hp ?? 99;
        const inv = s.sdk.getInventory?.() ?? st.inventory ?? [];
        if (hp < eatBelow && typeof s.sdk.sendUseItem === 'function') {
            const food = bestFood(inv);
            const eatOp = food?.optionsWithIndex.find(o => /^eat$/i.test(o.text));
            if (food && eatOp) void s.sdk.sendUseItem(food.slot, eatOp.opIndex);
            if (hp < minHp) {
                const karam = inv.find(i => i.id === KARAMBWAN_ID && i.slot !== food?.slot);
                const kOp = karam?.optionsWithIndex.find(o => /^eat$/i.test(o.text));
                if (karam && kOp) void s.sdk.sendUseItem(karam.slot, kOp.opIndex);
            }
        }
        if (hp < minHp || (hp < prevHp && hp < eatBelow)) break;
        prevHp = hp;
        if ((st.prayers?.prayerPoints ?? 0) > 0 && !st.prayers?.activePrayers?.[PRAYER.melee] && typeof s.sdk.sendTogglePrayer === 'function') {
            void s.sdk.sendTogglePrayer(PRAYER.melee);
        }
        const ground = st.groundItems ?? [];
        if (pending) {
            const gained = invCount(inv, pending.id) - pending.before;
            if (gained > 0) {
                got[pending.id] = (got[pending.id] ?? 0) + gained;
                tried.add(`${pending.id}@${pending.x},${pending.z}`);
                pending = null;
            } else {
                const stillThere = ground.some(g => g.id === pending!.id && g.x === pending!.x && g.z === pending!.z);
                if (!stillThere || s.tick() - pending.sentAt >= 4) {
                    tried.add(`${pending.id}@${pending.x},${pending.z}`);
                    pending = null;
                } else {
                    if (!await nextTick(s)) break;
                    continue;
                }
            }
        }
        const candidates = ground
            .filter(g => ids.has(g.id) && g.distance <= opts.radius && !tried.has(`${g.id}@${g.x},${g.z}`)
                && (!opts.home || opts.home.multi || !multiFn(g.x, g.z)))
            .sort((a, b) => a.distance - b.distance);
        const next = candidates[0];
        if (!next) {
            if (s.tick() - start < opts.wait && await nextTick(s)) continue;
            break;
        }
        if (inv.length >= 28) {
            const vial = inv.find(i => i.id === EMPTY_VIAL_ID);
            const edibles = inv.filter(i => i.optionsWithIndex.some(o => /^eat$/i.test(o.text)));
            const dropTarget = vial ?? (edibles.length >= 6 ? edibles[edibles.length - 1] : undefined);
            if (!dropTarget || typeof s.sdk.sendDropItem !== 'function') break;
            void s.sdk.sendDropItem(dropTarget.slot);
            if (!await nextTick(s)) break;
            continue;
        }
        if (typeof s.direct !== 'function') break;
        pending = { id: next.id, x: next.x, z: next.z, before: invCount(inv, next.id), sentAt: s.tick() };
        void Promise.resolve(s.direct({ type: 'pickupItem', x: next.x, z: next.z, itemId: next.id, reason: 'pk-team weapon loot' })).catch(() => {});
        if (!await nextTick(s)) break;
    }
    if (pending) {
        const inv = s.sdk.getInventory?.() ?? s.sdk.getState()?.inventory ?? [];
        const gained = invCount(inv, pending.id) - pending.before;
        if (gained > 0) got[pending.id] = (got[pending.id] ?? 0) + gained;
    }
    return got;
}

/** Drinks an antipoison dose if carried after escaping to a safe zone so lingering poison cannot kill an escaped account. */
export async function cureAfterEscape(s: Session): Promise<boolean> {
    const inv = s.sdk.getInventory?.() ?? [];
    const anti = inv.find(i => /antipoison/i.test(i.name) && i.optionsWithIndex.some(op => /^drink$/i.test(op.text)));
    const op = anti?.optionsWithIndex.find(o => /^drink$/i.test(o.text));
    if (!anti || !op || typeof s.sdk.sendUseItem !== 'function') return false;
    await s.sdk.sendUseItem(anti.slot, op.opIndex);
    return true;
}

/** Resolves a SPAR_KITS entry into fight switches and options, including the zero-risk gang-bait-3plus1 profile. */
export function resolveTeamKit(kit: string | undefined): { switches: Kit; options: Partial<FightOptions> } {
    if (kit === 'gang-bait-3plus1') return { switches: BAIT_3PLUS1_SWITCHES, options: BAIT_3PLUS1_OPTIONS };
    if (!kit) return { switches: TRIBRID_KIT, options: {} };
    return { switches: kitSwitches(kit), options: kitOptions(kit) };
}

/** Builds effective FightOptions for one team side; gang-bait-3plus1 options sit above profile defaults and below explicit SPAR_*_OPTS. */
export function buildTeamSideOptions(opts: {
    profileName: string;
    extraJson?: string;
    kit?: string;
    cap: number;
    neverSkull?: boolean;
    mixSeed?: number;
}): FightOptions {
    const resolved = resolveTeamKit(opts.kit);
    const isBaitKit = opts.kit === 'gang-bait-3plus1';
    const explicitExtra = isBaitKit && opts.extraJson ? JSON.parse(opts.extraJson) as Record<string, unknown> : undefined;
    const mergedExtra = isBaitKit ? JSON.stringify({ ...resolved.options, ...(explicitExtra ?? {}) }) : opts.extraJson;
    const scenario = isBaitKit ? {} : resolved.options;
    return {
        ...sparOptions(opts.profileName, mergedExtra, resolved.switches, opts.cap, scenario),
        ...(opts.neverSkull ? { neverSkull: true, protectItem: true } : {}),
        ...(opts.mixSeed !== undefined ? { mixSeed: opts.mixSeed } : {}),
    };
}

/** Prefers unheld targets over prayer-drain-held targets whenever any unheld candidate is available. */
export function preferUnheldTargets<X>(live: readonly X[], isHeld?: (x: X) => boolean): readonly X[] {
    if (!isHeld) return live;
    const unheld = live.filter(x => !isHeld(x));
    return unheld.length ? unheld : live;
}

/** Maximum simultaneous attackers assigned to a wounded target before overflow rolls to the secondary focus (eliminates 24v49 overkill waste). */
export function maxOverkillAttackers(hpFrac: number): number {
    if (hpFrac <= 0) return 0;
    if (hpFrac <= 0.15) return 2;
    if (hpFrac <= 0.30) return 3;
    if (hpFrac <= 0.50) return 5;
    return Infinity;
}

/** Shared target-assignment tracker for multi-way team stacks (24v49) so overflow attackers focus-fire the next priority target without overkill waste. */
export function createTeamFocus() {
    const memberTarget = new Map<string, string>();
    const counts = new Map<string, number>();
    const unassign = (member: string) => {
        const mKey = member.toLowerCase();
        const prev = memberTarget.get(mKey);
        if (!prev) return;
        memberTarget.delete(mKey);
        const next = (counts.get(prev) ?? 1) - 1;
        if (next <= 0) counts.delete(prev);
        else counts.set(prev, next);
    };
    const assign = (member: string, target: string) => {
        const mKey = member.toLowerCase();
        const tKey = target.toLowerCase();
        if (memberTarget.get(mKey) === tKey) return;
        unassign(mKey);
        memberTarget.set(mKey, tKey);
        counts.set(tKey, (counts.get(tKey) ?? 0) + 1);
    };
    const assignedCount = (target: string, excludeMember?: string): number => {
        const tKey = target.toLowerCase();
        const total = counts.get(tKey) ?? 0;
        if (excludeMember && memberTarget.get(excludeMember.toLowerCase()) === tKey) return Math.max(0, total - 1);
        return total;
    };
    return { assign, unassign, assignedCount };
}
export type TeamFocus = ReturnType<typeof createTeamFocus>;

export type TeamResult = {
    winner: 'a' | 'b' | 'draw';
    ticks: number;
    standing: { a: number; b: number };
    died: { a: number; b: number };
    attacks: { a: number; b: number };
    taken: { a: number; b: number };
    skulled: { a: number; b: number };
    picked?: Record<string, number>;
    weapons?: number;
    weaponLoot?: Record<string, number>;
};

// An account died when it has a new life id or stands at the Lumbridge spawn; it is out when it died or left the
// Wilderness.
const dead = (s: Session, life0: number | undefined) => {
    const p = s.sdk.getState()?.player;
    if (!p) return false;
    return (life0 !== undefined && p.lifeId !== undefined && p.lifeId !== life0) || Math.max(Math.abs(p.worldX - 3222), Math.abs(p.worldZ - 3218)) <= 40;
};
const out = (s: Session, life0: number | undefined) => {
    const p = s.sdk.getState()?.player;
    return !p || dead(s, life0) || wildernessLevel(p.worldZ) === 0;
};

// How an account takes its next enemy: `low` the lowest health bar in view (the nearest on a tie), `near` the nearest,
// `pair` the enemy in its own place on the other side while that one is in, else as `low`. On a single-way tile an
// account fights one enemy at a time (pvp_combat.rs2:104-131), so pairs on both sides make one fight of each pair.
export type TeamPick = 'low' | 'near' | 'pair';
// Only count ticks toward the unseen timeout when no living enemy is in view; enemies in an 8-tick refusal cooldown keep the loop alive.
export const shouldStopUnseen = (anyEnemyInView: boolean, unseen: number, wait: number) => !anyEnemyInView && unseen > wait;

// The enemy that an account takes from those in view (`own`: the enemy in its own place on the other side).
// When `focus` is supplied (large multi-way stacks), skips 0-HP dying enemies and caps overkill attackers on low-HP targets
// so overflow allies immediately pile the next priority target without wasting attack ticks.
export function pickEnemy<F, X extends { f: F; p?: { name?: string; distance: number } }>(
    live: readonly X[],
    own: F | undefined,
    pick: TeamPick,
    health: (x: X) => number,
    coord?: { focus: TeamFocus; memberName: string; nameOf: (x: X) => string; drained?: (x: X) => boolean },
): X | undefined {
    if (pick === 'pair') {
        const paired = live.find(x => x.f === own);
        if (paired) return paired;
    }
    const sorted = [...live].sort((x, y) => {
        if (coord?.drained) {
            const dx = coord.drained(x) ? 1 : 0, dy = coord.drained(y) ? 1 : 0;
            if (dx !== dy) return dy - dx;
        }
        return (pick !== 'near' ? health(x) - health(y) : 0) || x.p!.distance - y.p!.distance;
    });
    if (!coord) return sorted[0];
    const nonOverkill = sorted.find(x => {
        const hp = health(x);
        const cap = maxOverkillAttackers(hp);
        return cap > 0 && coord.focus.assignedCount(coord.nameOf(x), coord.memberName) < cap;
    });
    return nonOverkill ?? sorted.find(x => health(x) > 0) ?? sorted[0];
}
async function disableTeamAutoRetaliate(s: Session): Promise<void> {
    const state = s.sdk.getState?.() as { autoRetaliateEnabled?: boolean } | undefined;
    if (!state || state.autoRetaliateEnabled !== true || typeof s.direct !== 'function') return;
    await s.direct({ type: 'clickComponent', componentId: RETALIATE_OFF, reason: 'team auto-retaliate off' });
    for (let t = 0; t < 3 && (s.sdk.getState?.() as { autoRetaliateEnabled?: boolean } | undefined)?.autoRetaliateEnabled === true; t++) {
        if (!await nextTick(s)) break;
    }
}

// optionsA and optionsB: one side's options, or a function of the member's place on its side (per-member kits).
type SideOptions = FightOptions | ((member: number) => FightOptions);
export async function team(a: readonly Session[], b: readonly Session[], optionsA: SideOptions, optionsB: SideOptions, cap: number,
    log: (line: string) => void = l => console.log(l), halt: () => boolean = () => false, picks: { a: TeamPick; b: TeamPick } = { a: 'low', b: 'low' }, wait = 100, pickup?: ReadonlySet<number>, pickupRadius = 3, daggerOptions?: DaggerOptions): Promise<TeamResult> {
    // A new practice world refuses player attacks for its first 8 ticks (pvp_combat.rs2:110).
    for (let i = 0; i < 10; i++) if ((await Promise.all([...a, ...b].map(s => nextTick(s)))).some(t => !t)) break;
    const lives = new Map([...a, ...b].map(s => [s, s.sdk.getState()?.player?.lifeId] as const));
    const isOut = (s: Session) => out(s, lives.get(s));
    const start = a[0]!.tick(), attacks = { a: 0, b: 0 }, taken = { a: 0, b: 0 }, picked: Record<string, number> = {};
    const skulledSet = { a: new Set<string>(), b: new Set<string>() };
    const dagger = daggerOptions ? createDaggerWatch(daggerOptions) : undefined;
    // HP lost by each side: the sum of each account's drops, read each tick.
    const lastHp = new Map<Session, number>();
    const unwatch = [...a, ...b].map(s => s.onTick(() => {
        const key = a.includes(s) ? 'a' : 'b';
        if (ownSkull(s.client) === true) skulledSet[key].add(s.name.toLowerCase());
        const hp = s.sdk.getState()?.player?.hp;
        if (hp === undefined) return;
        const was = lastHp.get(s);
        if (was !== undefined && hp < was) taken[key] += was - hp;
        lastHp.set(s, hp);
    }));
    let over = false;
    // A side whose accounts are all out or stopped (each saw no enemy for `wait` ticks) ends the meeting. An account
    // whose fight loop ends for another reason (it escaped, it fled) is not stopped: a runner is still chased.
    const stopped = new Set<Session>();
    const ended = () => over || halt() || a.every(isOut) || b.every(isOut) || a[0]!.tick() - start >= cap || a.every(s => isOut(s) || stopped.has(s)) || b.every(s => isOut(s) || stopped.has(s));
    const side = (mine: readonly Session[], foes: readonly Session[], sideOptions: SideOptions, key: 'a' | 'b') => {
        const teamFocus = mine.length >= 4 ? createTeamFocus() : undefined;
        const foeNames = new Set(foes.map(f => f.name.toLowerCase()));
        return mine.map(async (s, member) => {
        const options = typeof sideOptions === 'function' ? sideOptions(member) : sideOptions;
        const allies = mine.filter(x => x !== s).map(x => x.name.toLowerCase());
        const allySet = new Set(allies);
        const skullGuard = options.neverSkull ? createNeverSkullGuard({ selfName: s.name }) : null;
        const sideDagger = key === 'a' ? dagger : undefined;
        const startPos = s.sdk.getState()?.player;
        const home = key === 'a' && sideDagger && startPos ? { x: startPos.worldX, z: startPos.worldZ, multi: isMulti(startPos.worldX, startPos.worldZ) } : null;
        if (key === 'a' && (skullGuard || sideDagger)) await disableTeamAutoRetaliate(s);
        // The game refuses an attack on an enemy while another one has hit us in the last 8 ticks (pvp_combat.rs2:104-112:
        // "I'm already under attack.", and "Someone else is already fighting your opponent." for an enemy that another one
        // hit): the fight stops on the refusal and the pick leaves that enemy out for 8 ticks.
        let seenMessage = 0, refusedAt = -100, unseen = 0, skullSeenEvent = 0;
        let activeTarget: string | null = null, holdCancelledFor: string | null = null;
        const skip = new Map<Session, number>();
        const unwatchRefusals = s.onTick(() => {
            const st = s.sdk.getState();
            const now = s.tick();
            if (ownSkull(s.client) === true) skulledSet[key].add(s.name.toLowerCase());
            for (const msg of st?.gameMessages ?? []) { const id = msg.observationId ?? msg.tick; if (id <= seenMessage) continue; seenMessage = id;
                if (msg.tick >= start && /already under attack|already fighting your opponent/i.test(msg.text)) refusedAt = now; }
            const selfSlot = localPlayerSlot(s.client);
            if (skullGuard && st) {
                const clientPlayers = (s.client as { players?: ({ faceEntity?: number; primaryAnim?: number; primaryAnimCycle?: number; primaryAnimFrame?: number } | null)[] } | undefined)?.players;
                skullSeenEvent = observeProvocations({
                    guard: skullGuard,
                    now,
                    selfSlot,
                    allies: allySet,
                    nearbyPlayers: st.nearbyPlayers ?? [],
                    combatEvents: st.combatEvents,
                    seenEventId: skullSeenEvent,
                    minTick: start,
                    clientPlayers,
                });
            }
            if (sideDagger && st) {
                for (const q of st.nearbyPlayers ?? []) {
                    const qKey = q.name.toLowerCase();
                    if (!foeNames.has(qKey)) continue;
                    const seen = observePlayer(s.client, q.index);
                    if (!seen) continue;
                    const fighting = q.combatTargetType === 'player' && q.combatTargetIndex !== undefined && q.combatTargetIndex >= 0;
                    if (fighting && selfSlot >= 0 && q.combatTargetIndex === selfSlot) sideDagger.attacked(qKey, now);
                    sideDagger.read(qKey, now, {
                        skulled: skulled(seen.headicons),
                        overhead: protectedStyles(seen.headicons).size > 0,
                        inCombat: q.inCombat === true || fighting,
                        hp: seen.totalHealth > 0 ? seen.health / seen.totalHealth : null,
                        wornIds: seen.worn,
                    });
                }
                if (activeTarget && skullGuard && sideDagger.held(activeTarget, now)) {
                    if (holdCancelledFor !== activeTarget) {
                        holdCancelledFor = activeTarget;
                        const me = st.player;
                        if (me && typeof s.sdk.sendWalk === 'function') void s.sdk.sendWalk(me.worldX, me.worldZ);
                    }
                } else if (holdCancelledFor === activeTarget) {
                    holdCancelledFor = null;
                }
            }
        });
        const hasUnheldAlternative = (currentFoe: Session): boolean => {
            if (!sideDagger) return false;
            const nowTick = s.tick();
            const curView = s.sdk.getState()?.nearbyPlayers ?? [];
            return foes.some(f => {
                if (f === currentFoe || isOut(f) || (skip.get(f) ?? -100) >= nowTick) return false;
                const p = curView.find(v => v.name.toLowerCase() === f.name.toLowerCase());
                if (!p || isDying(observePlayer(s.client, p.index))) return false;
                if (skullGuard && !skullGuard.canAttackSafely(f.name, nowTick)) return false;
                return !sideDagger.held(f.name, nowTick);
            });
        };
        try {
        while (!ended() && !isOut(s)) {
            // The enemy with the lowest health bar in view, the nearest on a tie.
            const view = s.sdk.getState()?.nearbyPlayers ?? [];
            const liveAll = foes.filter(f => !isOut(f) && (skip.get(f) ?? -100) < s.tick())
                .map(f => ({ f, p: view.find(v => v.name.toLowerCase() === f.name.toLowerCase()) }))
                .filter(x => x.p && !isDying(observePlayer(s.client, x.p.index)));
            const live = skullGuard ? liveAll.filter(x => skullGuard.canAttackSafely(x.f.name, s.tick())) : liveAll;
            const pool = preferUnheldTargets(live, sideDagger ? x => sideDagger.held(x.f.name, s.tick()) : undefined);
            const health = (x: { p?: { index: number } }) => { const o = x.p ? observePlayer(s.client, x.p.index) : null; return o && o.totalHealth > 0 ? o.health / o.totalHealth : 1; };
            const pick = pickEnemy(pool, foes[member], picks[key], health, teamFocus ? {
                focus: teamFocus,
                memberName: s.name,
                nameOf: x => x.f.name,
                ...(sideDagger ? { drained: (x: { f: Session }) => sideDagger.drained(x.f.name) } : {}),
            } : undefined);
            // No enemy in view for SPAR_TEAM_WAIT ticks (default 100): the enemies left are away, as the gang meeting's `away`.
            const anyEnemyInView = foes.some(f => !isOut(f) && view.some(v => v.name.toLowerCase() === f.name.toLowerCase()));
            if (!pick) {
                teamFocus?.unassign(s.name);
                if (!anyEnemyInView && shouldStopUnseen(false, ++unseen, wait)) { stopped.add(s); return; }
                if (key === 'a' && pickup && sideDagger && !ended() && !isOut(s)) {
                    const stIdle = s.sdk.getState();
                    const hasSafeWeapon = (stIdle?.player?.hp ?? 0) >= 70
                        && (stIdle?.groundItems ?? []).some(g => ENEMY_WEAPON_IDS.has(g.id) && g.distance <= pickupRadius && (!home || home.multi || !isMulti(g.x, g.z)));
                    if (hasSafeWeapon) {
                        const got = await combatPickupWeapons(s, ENEMY_WEAPON_IDS, {
                            radius: pickupRadius,
                            maxTicks: 6,
                            wait: 0,
                            minHp: 62,
                            eatBelow: 72,
                            home,
                            stop: () => ended() || isOut(s),
                        });
                        for (const [id, n] of Object.entries(got)) picked[id] = (picked[id] ?? 0) + n;
                        continue;
                    }
                }
                if (!await nextTick(s)) return;
                continue;
            }
            unseen = 0;
            teamFocus?.assign(s.name, pick.f.name);
            activeTarget = pick.f.name.toLowerCase();
            holdCancelledFor = null;
            const began = s.tick();
            const r = await fightPlayer(s, pick.f.name, {
                ...options,
                ...(skullGuard ? {
                    provokedBy: (name: string) => skullGuard.canAttackSafely(name, s.tick()) && !(sideDagger?.held(name, s.tick()) ?? false),
                    onUnexpectedSkull: () => { skulledSet[key].add(s.name.toLowerCase()); },
                } : {}),
                ...(sideDagger ? {
                    smiteBurst: () => sideDagger.smiteReady(pick.f.name),
                    holdSpecForDrain: () => sideDagger.holdSpecForDrain(pick.f.name, s.tick()),
                } : {}),
                stopOnDying: shouldStopOnDying(teamFocus !== undefined, liveAll.length, key, pickup !== undefined),
                allies,
                cap: Math.max(1, cap - (s.tick() - start)),
                stop: () => ended() || isOut(pick.f) || refusedAt > began
                    || (home !== null && driftedFromHome(s.sdk.getState()?.player, home))
                    || (!!sideDagger?.held(pick.f.name, s.tick()) && hasUnheldAlternative(pick.f)),
                log: l => log(`[${s.name}] ${l}`),
            });
            activeTarget = null;
            holdCancelledFor = null;
            teamFocus?.unassign(s.name);
            if (r.unexpectedSkull) skulledSet[key].add(s.name.toLowerCase());
            if (refusedAt > began) skip.set(pick.f, s.tick() + 8);
            const killed = r.outcome === 'kill' || dead(pick.f, lives.get(pick.f));
            if (killed) {
                skullGuard?.recordDeath(pick.f.name);
                sideDagger?.died(pick.f.name);
            }
            // `pickup`: after its kill the account takes the wanted stacks within `pickupRadius` tiles (SPAR_PICKUP_RADIUS,
            // default 3; scripts/pk-gang.ts pickUp). It runs on after the meeting ends: the last kill ends it.
            // A dead target counts as a kill too: the loop can stop on its death before the kill message comes.
            if (killed && pickup && key === 'a') {
                const enemiesLeft = foes.some(f => !isOut(f));
                const got = sideDagger && enemiesLeft
                    ? await combatPickupWeapons(s, ENEMY_WEAPON_IDS, {
                        radius: pickupRadius,
                        maxTicks: 12,
                        wait: 6,
                        minHp: 60,
                        eatBelow: 72,
                        home,
                        stop: () => over || halt(),
                    })
                    : await pickUp(s, pickup, { radius: pickupRadius, maxTicks: 30, wait: 6, stop: () => over || halt() });
                recordKillLoot(r, got);
                for (const [id, n] of Object.entries(got)) picked[id] = (picked[id] ?? 0) + n;
            }
            if (home && !ended() && !isOut(s)) {
                const curPos = s.sdk.getState()?.player;
                if (curPos && (curPos.worldX !== home.x || curPos.worldZ !== home.z) && typeof s.sdk.sendWalk === 'function') {
                    void s.sdk.sendWalk(home.x, home.z);
                }
            }
            attacks[key] += r.attacks.magic + r.attacks.ranged + r.attacks.melee;
            if (r.outcome === 'escaped') {
                await cureAfterEscape(s);
                return;
            }
            if (r.outcome === 'died' || r.outcome === 'session ended') return;
            // Zero-tick-waste switch: only wait a tick when fightPlayer consumed 0 ticks.
            if (s.tick() === began && !await nextTick(s)) return;
        }
        // Post-victory battlefield sweep: once all enemies are out or fled/stopped, surviving Side A members vacuum remaining dropped weapons/loot.
        if (key === 'a' && pickup && !isOut(s) && !halt() && foes.every(f => isOut(f) || stopped.has(f))) {
            const sweep = await pickUp(s, pickup, { radius: Math.max(pickupRadius, 12), maxTicks: 30, wait: 4, stop: () => halt() });
            for (const [id, n] of Object.entries(sweep)) picked[id] = (picked[id] ?? 0) + n;
        }
        } finally { teamFocus?.unassign(s.name); unwatchRefusals(); }
    });
    };
    await Promise.all([...side(a, b, optionsA, 'a'), ...side(b, a, optionsB, 'b')]);
    over = true;
    for (const u of unwatch) u();
    const standing = { a: a.filter(s => !isOut(s)).length, b: b.filter(s => !isOut(s)).length };
    const active = { a: a.filter(s => !isOut(s) && !stopped.has(s)).length, b: b.filter(s => !isOut(s) && !stopped.has(s)).length };
    const died = { a: a.filter(s => dead(s, lives.get(s))).length, b: b.filter(s => dead(s, lives.get(s))).length };
    const winner = teamWinner(standing, active);
    const weaponSummary = pickup ? summarizeWeaponLoot(picked, id => getObjNames().get(id)) : undefined;
    return {
        winner,
        ticks: a[0]!.tick() - start,
        standing,
        died,
        attacks,
        taken,
        skulled: { a: skulledSet.a.size, b: skulledSet.b.size },
        ...(pickup ? { picked, weapons: weaponSummary!.totalWeapons, weaponLoot: weaponSummary!.weapons } : {}),
    };
}

export async function runPkTeamCli(
    argv: readonly string[],
    env: Record<string, string | undefined> = process.env,
): Promise<number> {
    const size = Math.max(1, Number(env.SPAR_TEAM ?? 2)), sizeB = Math.max(1, Number(env.SPAR_TEAM_B ?? size)), group = size + sizeB;
    const capArg = argv.find(x => /^\d+$/.test(x)), bots = argv.filter(x => x !== capArg);
    if (!bots.length || bots.length % group) { console.log(`RESULT fail usage: bun scripts/pk-team.ts <${group} bots a group> [CAP ticks]`); return 2; }
    if (env.STALL_TICKS !== undefined) process.env.STALL_TICKS = env.STALL_TICKS;
    const { openBot, finish } = await import('../../../core/src/bot');
    const cap = Number(env.SPAR_CAP ?? capArg ?? 900), nameA = env.SPAR_A ?? 'base', nameB = env.SPAR_B ?? 'base';
    const [kitA, kitB] = (env.SPAR_KITS ?? '').split(':');
    const neverSkullA = neverSkullOf((k, d) => env[k] ?? d, false);
    const daggerOptions = daggerOptionsOf((k, d) => env[k] ?? d);
    const options = (sideB: boolean, group: number) => (member: number): FightOptions => {
        const kits = (sideB ? kitB : kitA)?.split('+').filter(Boolean) ?? [];
        const kit = kits.length ? kits[member % kits.length] : undefined;
        return buildTeamSideOptions({
            profileName: sideB ? nameB : nameA,
            extraJson: sideB ? env.SPAR_B_OPTS : env.SPAR_A_OPTS,
            kit,
            cap,
            neverSkull: !sideB && neverSkullA,
            mixSeed: env.BENCH_SEED === undefined ? undefined : Number(env.BENCH_SEED) * 1000 + group * 2 + (sideB ? 1 : 0),
        });
    };
    let halted: string | undefined;
    const stallLimit = Number(env.STALL_TICKS ?? 900);
    const onStop = async (_s: unknown, reason: string) => { if (shouldHaltTeamOnStop(reason, stallLimit)) halted ??= reason; };
    const { tickWaits } = await import('../../../core/src/tick-stream');
    tickWaits.active++;
    const first = await openBot(bots[0]!, { onStop });
    const groups: Session[][] = [];
    try {
        // Open large teams (e.g. 24v49 = 73 bots) in bounded batches of 8 to avoid simultaneous login memory spikes.
        for (let at = 0; at < bots.length; at += group) {
            const slice = bots.slice(at, at + group);
            const opened: Session[] = [];
            for (let j = 0; j < slice.length; j += 8) {
                const batch = await Promise.all(slice.slice(j, j + 8).map((name, k) => (at === 0 && j + k === 0 ? first : openBot(name, { onStop }))));
                opened.push(...batch);
            }
            groups.push(opened);
        }
    } finally { tickWaits.active--; }
    for (const s of groups.flat()) (s.client as { setReachabilityEnabled?: (on: boolean) => void } | undefined)?.setReachabilityEnabled?.(false);
    const pickOf = (v?: string): TeamPick => (v === 'near' || v === 'pair' ? v : 'low');
    const results = await Promise.all(groups.map((g, i) => team(g.slice(0, size), g.slice(size), options(false, i), options(true, i), cap, undefined, () => halted !== undefined,
        { a: pickOf(env.SPAR_A_PICK), b: pickOf(env.SPAR_B_PICK) }, Number(env.SPAR_TEAM_WAIT ?? 100), env.SPAR_PICKUP === '1' ? new Set(PICKUP_ITEMS) : undefined, Number(env.SPAR_PICKUP_RADIUS ?? 3), daggerOptions)));
    for (const r of results) console.log(`TEAM ${JSON.stringify({ profiles: { a: nameA, b: nameB }, kits: { a: kitA, b: kitB }, ...r })}`);
    const wins = results.filter(r => r.winner === 'a').length, losses = results.filter(r => r.winner === 'b').length;
    const totalSkulledA = results.reduce((n, r) => n + r.skulled.a, 0);
    const allPicked: Record<string, number> = {};
    for (const r of results) for (const [id, n] of Object.entries(r.picked ?? {})) allPicked[id] = (allPicked[id] ?? 0) + n;
    const weaponSummary = summarizeWeaponLoot(allPicked, id => getObjNames().get(id));
    const ok = halted === undefined && results.every(r => r.attacks.a > 0 && r.attacks.b > 0) && (!neverSkullA || totalSkulledA === 0);
    await finish(groups.flat(), ok, `team groups=${results.length} size=${size} wins=${wins} losses=${losses} draws=${results.length - wins - losses} ticks=${Math.max(0, ...results.map(r => r.ticks))} a=${nameA} b=${nameB} `
        + `standing=${results.map(r => `${r.standing.a}-${r.standing.b}`).join(',')} diedA=${results.reduce((n, r) => n + r.died.a, 0)} diedB=${results.reduce((n, r) => n + r.died.b, 0)} takenA=${results.reduce((n, r) => n + r.taken.a, 0)} picked=${results.reduce((n, r) => n + Object.values(r.picked ?? {}).reduce((x, c) => x + c, 0), 0)}${env.SPAR_PICKUP === '1' ? ` weapons=${weaponSummary.totalWeapons}` : ''} skulledA=${totalSkulledA}${halted ? ` halted=${halted}` : ''}`);
    return ok ? 0 : 1;
}
