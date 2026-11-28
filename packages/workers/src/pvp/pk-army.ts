// The PK army: a leader that roams for prey (scripts/pk-roam.ts huntOnce) and followers that keep with it and fight
// whatever it fights. All accounts run in this process. A follower stays within FOLLOW tiles of the leader; while the
// leader has a target in view the follower fights that target with the fight loop on the `army` profile
// (scripts/pk-spar.ts: specials held to 35% so the army's land together, research/pvp-fight-loop.md findings 47 and
// 49), knowing the other accounts as allies, so the champion's escape from a crowd counts them. When the leader
// escapes, dies or ends its hunt, each follower leaves the Wilderness: a glory up to level 30, else a run south.
// Usage: bun scripts/pk-army.ts <leader> <follower ...> [MAX_MINUTES=20] [MAX_WILD=20] [FOLLOW=3] [FRIENDS=name,...]
// and the other KEY=value arguments of scripts/pk-roam.ts for the leader. Prints one RESULT with the leader's hunt and
// each follower's fights.
// With two or more followers on the dragon spear the army opens with the spear lock (ARMY_PROFILE army-alpha,
// OPEN_TOGETHER=1, OPEN_RANGE=1; research/pvp-fight-loop.md finding 67) unless those settings are given.
import { existsSync } from 'node:fs';
import { openBot, settle } from '../../../core/src/bot';
import type { Session } from '../../../core/src/inprocess';
import { componentId } from '../../../core/src/logout';
import { sessionWalker, walkPath } from '../../../core/src/walk';
import { attackable, bestFood, defaultSpec, defaultStunSpec, fightPlayer, isMulti, neverSkullOf, newVolley, nextTick, observePlayer, STUNNED_SHOVE_SPOTANIM, wildernessLevel, type FightOptions, type VolleyState } from './fight';
import { escapeStep, hasVarrockTeleport, kitFrom, pickScoutTargetForSquad, readScoutIntel, wearGlory, type Cfg, type ScoutIntel } from './wild-rules';
import { huntOnce } from './roam';
import { PROFILES, sparOptions } from './pk-spar';

export type FollowerStats = { name: string; fights: number; kills: number; died: boolean; escaped: boolean; attacks: number };
const GLORY = /^amulet of glory\([1-4]\)$/i;

// Handoff from roamers' shared scout intel when local army targets are clear.
export function pickArmyScoutHandoff(opts: {
    leader: { x: number; z: number; combat: number };
    maxWild: number;
    friends: ReadonlySet<string>;
    skipped?: ReadonlySet<string>;
    intel?: readonly ScoutIntel[];
    now?: number;
}): ScoutIntel | null {
    const friends = new Set([...opts.friends, ...(opts.skipped ?? [])].map(s => s.toLowerCase()));
    return pickScoutTargetForSquad({
        me: opts.leader,
        intel: opts.intel ?? readScoutIntel(),
        maxWild: opts.maxWild,
        friends,
        now: opts.now,
    });
}

// Multi-way focus selection for army followers: follow leader's pile, switch to stunned/low-HP enemies in multi, respect single-way PJ lock.
const EMPTY_SET: ReadonlySet<string> = new Set();

export function armyFocusTarget<P extends { name: string; x: number; z: number; distance: number; combatLevel: number; inCombat?: boolean }>(opts: {
    me: { x: number; z: number; combatLevel: number };
    sharedTarget: string | null;
    view: readonly P[];
    friends: ReadonlySet<string>;
    stunned?: ReadonlySet<string>;
    healthFrac?: (p: P) => number;
}): P | undefined {
    const { me, sharedTarget, view, friends, stunned = EMPTY_SET, healthFrac } = opts;
    const sharedLower = sharedTarget?.toLowerCase();
    const inMultiZone = isMulti(me.x, me.z);
    let best: P | undefined;
    let bestShared = false;
    let bestStunned = false;
    let bestHp = 1;
    let bestDist = Infinity;
    for (let i = 0; i < view.length; i++) {
        const p = view[i]!;
        const key = p.name.toLowerCase();
        if (friends.has(key) || !attackable(me, p)) continue;
        const isShared = key === sharedLower;
        if (!inMultiZone && p.inCombat && !isShared) continue;
        if (!isShared && (!inMultiZone || p.distance > 15)) continue;
        const isStunned = stunned.has(key);
        const hp = healthFrac ? healthFrac(p) : 1;
        if (!best) {
            best = p;
            bestShared = isShared;
            bestStunned = isStunned;
            bestHp = hp;
            bestDist = p.distance;
            continue;
        }
        if (isShared !== bestShared) {
            if (!isShared) continue;
        } else if (isStunned !== bestStunned) {
            if (!isStunned) continue;
        } else if (hp !== bestHp) {
            if (hp >= bestHp) continue;
        } else if (p.distance >= bestDist) {
            continue;
        }
        best = p;
        bestShared = isShared;
        bestStunned = isStunned;
        bestHp = hp;
        bestDist = p.distance;
    }
    return best;
}

// One follower: keep with the leader, fight its target, leave when the army leaves.
export async function follow(s: Session, leader: Session, shared: { target: string | null; over: boolean; killed: Set<string> }, allies: readonly string[],
    options: FightOptions, followTiles: number, stopped: () => boolean, emit: (e: object) => void): Promise<FollowerStats> {
    const stats: FollowerStats = { name: s.name, fights: 0, kills: 0, died: false, escaped: false, attacks: 0 };
    const walker = await sessionWalker(s);
    const me = () => s.sdk.getState()?.player;
    const life0 = me()?.lifeId;
    const dead = () => { const p = me(); return !!p && ((life0 !== undefined && p.lifeId !== life0) || Math.max(Math.abs(p.worldX - 3222), Math.abs(p.worldZ - 3218)) <= 40); };
    const friendsSet = new Set<string>([...allies, leader.name.toLowerCase(), s.name.toLowerCase()]);
    const stunnedSet = new Set<string>();
    let wentIn = false;
    while (!stopped() && !shared.over) {
        const p = me();
        if (!p) { if (!await nextTick(s)) break; continue; }
        if (wildernessLevel(p.worldZ) > 0) wentIn = true;
        if (dead()) { stats.died = true; emit({ e: 'follower-died', name: s.name }); return stats; }
        const view = s.sdk.getState()?.nearbyPlayers ?? [];
        stunnedSet.clear();
        for (let i = 0; i < view.length; i++) {
            const q = view[i]!;
            if (observePlayer(s.client, q.index)?.spotanim === STUNNED_SHOVE_SPOTANIM) stunnedSet.add(q.name.toLowerCase());
        }
        const focus = armyFocusTarget({
            me: { x: p.worldX, z: p.worldZ, combatLevel: p.combatLevel },
            sharedTarget: shared.target,
            view,
            friends: friendsSet,
            stunned: stunnedSet,
            healthFrac: q => { const o = observePlayer(s.client, q.index); return o && o.totalHealth > 0 ? o.health / o.totalHealth : 1; },
        });
        const target = focus?.name ?? shared.target;
        const seen = focus ?? (target ? view.find(x => x.name.toLowerCase() === target.toLowerCase()) : undefined);
        if (target && seen && seen.distance <= 15) {
            stats.fights++;
            const r = await fightPlayer(s, target, { ...options, allies, stop: () => {
                if (stopped() || shared.over) return true;
                if (shared.target === null || shared.target.toLowerCase() === target.toLowerCase()) return false;
                const q = me();
                return !!q && !isMulti(q.worldX, q.worldZ);
            },
                log: l => emit({ e: 'follower-fight', name: s.name, line: l }) });
            stats.attacks += r.attacks.magic + r.attacks.ranged + r.attacks.melee;
            if (r.outcome === 'kill') { stats.kills++; shared.killed.add(target.toLowerCase()); }
            if (r.outcome === 'died') { stats.died = true; return stats; }
            if (r.outcome === 'escaped') { stats.escaped = true; return stats; }
            continue;
        }
        // The leader's target out of this account's view: run to its tile as the leader sees it, 2 ticks at a time.
        // Keeping with the leader left the followers 15 tiles behind it when it reached the target (ARMY_TRACE), and
        // the opening waited 8 ticks for them (FOLLOW_TARGET=0 keeps the old walk).
        const far = target && process.env.FOLLOW_TARGET !== '0' ? leader.sdk.getState()?.nearbyPlayers.find(x => x.name.toLowerCase() === target.toLowerCase()) : undefined;
        if (far) {
            const before = s.tick();
            await walkPath(walker, [{ x: far.x, z: far.z, tol: 2 }], { maxTicks: 2, idleMs: 9000 });
            // A walk that used no tick (already there, or blocked) waits one: the loop must not spin.
            if (s.tick() === before && !await nextTick(s)) break;
            continue;
        }
        // Keep with the leader.
        const l = leader.sdk.getState()?.player;
        if (l && l.level === p.level && Math.max(Math.abs(l.worldX - p.worldX), Math.abs(l.worldZ - p.worldZ)) > followTiles) {
            const before = s.tick();
            await walkPath(walker, [{ x: l.worldX, z: l.worldZ, tol: 1 }], { maxTicks: 6, idleMs: 9000 });
            // A walk that used no tick (no path to the leader) waits one: the loop must not spin.
            if (s.tick() === before && !await nextTick(s)) break;
            continue;
        }
        if (!await nextTick(s)) break;
    }
    // The army leaves: a glory up to level 30, else a run south, until out of the Wilderness.
    if (wentIn && !dead()) stats.escaped = await leave(s, walker, emit);
    return stats;
}

// Follower escape choice at a Wilderness depth: rubbed glory up to 30, Varrock Teleport up to 20, else run south.
export function armyEscapeMethod<I extends { name: string; count?: number }, E extends { name: string }>(
    magic: number,
    z: number,
    inventory: readonly I[],
    equipment: readonly E[],
    removeTries: number,
): { how: ReturnType<typeof escapeStep>; glory: I | undefined; worn: E | undefined } {
    const glory = inventory.find(i => GLORY.test(i.name));
    const worn = equipment.find(i => GLORY.test(i.name));
    const how = escapeStep(wildernessLevel(z), { glory: !!glory || (!!worn && removeTries < 3), teleport: hasVarrockTeleport(magic, inventory, equipment) });
    return { how, glory, worn };
}

// Eat the best food in the pack during Wilderness retreat whenever HP is more than one shark below max.
export function armyEscapeFood<I extends { name: string; optionsWithIndex: { text: string }[] }>(hp: number, maxHp: number, inventory: readonly I[]): I | undefined {
    return hp < maxHp - 20 ? bestFood(inventory) : undefined;
}

async function leave(s: Session, walker: Awaited<ReturnType<typeof sessionWalker>>, emit: (e: object) => void): Promise<boolean> {
    let removeTries = 0;
    for (let step = 0; step < 120; step++) {
        const p = s.sdk.getState()?.player;
        if (!p) { if (!await nextTick(s)) return false; continue; }
        const magic = s.sdk.getSkill('Magic')?.level ?? 1;
        const { how, glory, worn } = armyEscapeMethod(magic, p.worldZ, s.sdk.getInventory(), s.sdk.getEquipment(), removeTries);
        if (how === 'out') { emit({ e: 'follower-out', name: s.name, at: [p.worldX, p.worldZ] }); return true; }
        const heal = armyEscapeFood(p.hp, p.maxHp, s.sdk.getInventory());
        if (heal) { await s.bot.eatFood(heal as any); await s.sdk.waitForTicks(1); }
        if (how === 'glory') {
            // The game rubs a glory only from the pack (amulet_of_glory.rs2 has no worn option). It comes off into a
            // free slot: a full pack eats a food for one. Three tries, then the run south.
            if (!glory && worn) {
                const meal = s.sdk.getInventory().length >= 28 ? bestFood(s.sdk.getInventory() as any) : undefined;
                if (meal) await s.bot.eatFood(meal as any);
                else { removeTries++; await s.sdk.sendUseEquipmentItem?.(worn.slot, 1); }
                await s.sdk.waitForTicks(1); continue;
            }
            const op = glory!.optionsWithIndex?.find((o: { text: string }) => /^rub$/i.test(o.text));
            await s.sdk.sendUseItem(glory!.slot, op?.opIndex ?? 4);
            for (let i = 0; i < 6 && !s.sdk.getDialog()?.isOpen; i++) await s.sdk.waitForTicks(1);
            await s.sdk.clickDialogByText(/^Edgeville/i);
            await s.sdk.waitForTicks(6);
            if (removeTries > 0) await wearGlory(s);
        } else if (how === 'teleport') {
            await s.sdk.sendClickComponent(componentId('magic:varrock_teleport'));
            await s.sdk.waitForTicks(6);
        } else await walkPath(walker, [{ x: p.worldX, z: Math.max(3510, p.worldZ - 20), tol: 2 }], { maxTicks: 12, idleMs: 9000 });
    }
    return false;
}

const arg = (args: string[], key: string, d: string) => args.find(a => a.startsWith(key + '='))?.slice(key.length + 1) ?? d;

export async function runPkArmyCli(all: readonly string[]): Promise<number> {
    const names = all.filter(a => !a.includes('=')), args = all.filter(a => a.includes('='));
    const [leaderName, ...followerNames] = names;
    if (!leaderName || !followerNames.length) { console.log('RESULT fail usage: bun scripts/pk-army.ts <leader> <follower ...> [KEY=value ...]'); return 2; }
    const stop = () => existsSync('.practice/stop-pk-hunt') || names.some(n => existsSync('.practice/stop-' + n));
    if (stop()) throw new Error('PK stop file present');
    const army = names.map(n => n.toLowerCase());
    const friendList = args.some(a => a.startsWith('FRIENDS=')) ? arg(args, 'FRIENDS', '').split(',').filter(Boolean) : undefined;
    const ranged = arg(args, 'RANGED', '');
    const cfg: Cfg = {
        maxMs: Number(arg(args, 'MAX_MINUTES', '20')) * 60_000, maxWild: Number(arg(args, 'MAX_WILD', '20')),
        eatAt: Number(arg(args, 'EAT_AT', '50')), fleeAt: Number(arg(args, 'FLEE_AT', '30')),
        spell: arg(args, 'SPELL', 'AUTO'), ranged: ranged ? new RegExp(ranged, 'i') : undefined,
        loot: arg(args, 'LOOT', '1') === '1', freeze: arg(args, 'FREEZE', '1') === '1',
        ...(friendList ? { friends: [...friendList, ...army] } : {}),
    };
    const followTiles = Math.max(1, Number(arg(args, 'FOLLOW', '3')));
    const { tickWaits } = await import('../../../core/src/tick-stream');
    tickWaits.active++;
    let sessions: Session[];
    try { sessions = await Promise.all(names.map(n => openBot(n))); } finally { tickWaits.active--; }
    const [leader, ...followers] = sessions;
    if ((leader!.sdk.getState()?.player?.combatLevel ?? 0) >= 115) {
        const { specBelow: _below, ...champion } = PROFILES.champion!;
        cfg.fight = { ...champion, ...cfg.fight };
    }
    const emit = (e: object) => console.log('PK_EVENT ' + JSON.stringify({ t: leader!.tick(), ...e }));
    const shared = { target: null as string | null, over: false, killed: new Set<string>() };
    const hasSpear = (s: Session) => [...s.sdk.getEquipment(), ...s.sdk.getInventory()].some(i => /^dragon spear/i.test(i.name));
    const spears = sessions.filter(hasSpear).length, followerSpears = followers.filter(hasSpear).length, lock = followerSpears >= 2;
    if (lock) emit({ e: 'spear-lock', spears });
    const stunArg = arg(args, 'STUN_SHARE', spears >= 1 ? 'chain' : '0');
    const stunShare = stunArg !== '0' ? { clock: () => leader!.tick(), until: -1, stunnedUntil: -1, overlap: stunArg === 'strict' ? 0 : 1 } : undefined;
    const burstOnStun = arg(args, 'BURST_STUN', spears >= 1 ? '1' : '0') === '1';
    if (stunShare) cfg.fight = { ...cfg.fight, stunShare };
    if (burstOnStun) cfg.fight = { ...cfg.fight, burstOnStun };
    const leaderKit = kitFrom(leader!.sdk.getEquipment(), leader!.sdk.getInventory(), cfg.ranged);
    const leaderStun = defaultStunSpec(leaderKit);
    if (leaderStun && !defaultSpec(leaderKit)?.stun) cfg.fight = { ...cfg.fight, stunSpec: leaderStun };
    const openTogether = arg(args, 'OPEN_TOGETHER', lock ? '1' : '0') === '1', openTicks = Number(arg(args, 'OPEN_TICKS', '20')), openRange = Number(arg(args, 'OPEN_RANGE', lock ? '1' : '3'));
    const opened = new Map<string, number>();
    let traced = -1, lastTick = -1;
    const lastAt = new Map<string, { x: number; z: number }>();
    const hold = () => {
        const t = shared.target?.toLowerCase();
        if (!openTogether || !t) return false;
        const first = opened.get(t) ?? (opened.set(t, leader!.tick()), leader!.tick());
        if (first < 0) return false;
        const near = sessions.every(x => { const p = x.sdk.getState()?.nearbyPlayers.find(n => n.name.toLowerCase() === t); return !!p && p.distance <= openRange; });
        if (process.env.ARMY_TRACE === '1' && leader!.tick() !== traced) { traced = leader!.tick(); console.log('PK_EVENT ' + JSON.stringify({ t: traced, e: 'hold', d: sessions.map(x => x.sdk.getState()?.nearbyPlayers.find(n => n.name.toLowerCase() === t)?.distance ?? -1) })); }
        const lp = leader!.sdk.getState()?.nearbyPlayers.find(n => n.name.toLowerCase() === t), was = lastAt.get(t);
        const runs = process.env.OPEN_ON_RUN !== '0' && !!lp && !!was && Math.max(Math.abs(lp.x - was.x), Math.abs(lp.z - was.z)) >= 2;
        if (lp && lastTick !== leader!.tick()) { lastAt.set(t, { x: lp.x, z: lp.z }); lastTick = leader!.tick(); }
        if (near || runs || leader!.tick() - first >= openTicks) { opened.set(t, -1); console.log('PK_EVENT ' + JSON.stringify({ t: leader!.tick(), e: 'open', target: t, why: near ? 'all near' : runs ? 'runs' : 'waited', after: leader!.tick() - first })); return false; }
        return true;
    };
    if (openTogether) { cfg.hold = hold; cfg.holdRange = openRange; }
    const pace = Number(arg(args, 'PACE', openTogether ? '4' : '0'));
    if (pace > 0) cfg.pace = () => { const t = shared.target?.toLowerCase(); if (!t || opened.get(t) === -1) return false; const l = leader!.sdk.getState()?.player; return !!l && followers.some(f => { const p = f.sdk.getState()?.player; return !!p && p.level === l.level && Math.max(Math.abs(p.worldX - l.worldX), Math.abs(p.worldZ - l.worldZ)) > pace; }); };
    if (arg(args, 'LEADER_CAP', '')) cfg.fight = { ...cfg.fight, cap: Number(arg(args, 'LEADER_CAP', '')) };
    if (arg(args, 'LEADER_SPEC', lock ? 'all' : '') === 'all') { cfg.specAll = true; cfg.fight = { ...cfg.fight, specReserve: 0 }; }
    const stagger = arg(args, 'FREEZE_STAGGER', '') ? Number(arg(args, 'FREEZE_STAGGER', '')) : undefined;
    const freezeShare = arg(args, 'FREEZE_SHARE', '1') === '1' ? { clock: () => leader!.tick(), until: -1, ...(stagger !== undefined ? { stagger } : {}) } : undefined;
    if (freezeShare) cfg.fight = { ...cfg.fight, freezeShare, allies: followers.map(f => f.name.toLowerCase()) };
    const volleys = new Map<string, VolleyState>();
    const volley = arg(args, 'VOLLEY', '0') === '1' ? { state: (t: string) => volleys.get(t) ?? (volleys.set(t, newVolley()), volleys.get(t)!),
        members: sessions.length, window: Number(arg(args, 'VOLLEY_TICKS', '8')), clock: () => leader!.tick() } : undefined;
    if (volley) cfg.fight = { ...cfg.fight, volley };
    const burstOnHold = arg(args, 'BURST_HOLD', '0') === '1';
    if (burstOnHold) cfg.fight = { ...cfg.fight, burstOnHold };
    const openFreeze = arg(args, 'OPEN_FREEZE', '0') === '1';
    if (openFreeze) cfg.fight = { ...cfg.fight, openFreeze };
    const leaderEmit = (e: object) => {
        const ev = e as { e?: string; target?: string };
        if (ev.e === 'target' && ev.target) shared.target = ev.target;
        if (ev.e === 'switch') shared.target = (ev as { to?: string }).to ?? shared.target;
        if ((ev.e === 'kill' || (ev.e === 'fight-end' && (ev as { outcome?: string }).outcome === 'kill')) && ev.target) shared.killed.add(ev.target.toLowerCase());
        if (ev.e === 'chase-end' || ev.e === 'kill' || ev.e === 'gone' || ev.e === 'left') shared.target = null;
        if (ev.e === 'escape' || ev.e === 'death') { shared.target = null; shared.over = true; }
        emit(e);
    };
    const armyProfile = arg(args, 'ARMY_PROFILE', lock ? 'army-alpha' : 'army');
    const armyOpts = arg(args, 'ARMY_OPTS', '') || undefined;
    const neverSkull = neverSkullOf((k, d) => arg(args, k, process.env[k] ?? d), false);
    if (neverSkull) cfg.fight = { ...cfg.fight, neverSkull: true, protectItem: true };
    const options = (s: Session): FightOptions => {
        const kit = kitFrom(s.sdk.getEquipment(), s.sdk.getInventory(), cfg.ranged);
        const stunSpec = defaultStunSpec(kit);
        return {
            ...sparOptions(armyProfile, armyOpts, kit, Math.round(cfg.maxMs / 600)),
            ...(neverSkull ? { neverSkull: true, protectItem: true } : {}),
            ...(freezeShare ? { freezeShare } : {}),
            ...(openTogether ? { holdFire: hold, holdRange: openRange } : {}),
            ...(volley ? { volley } : {}),
            ...(burstOnHold ? { burstOnHold } : {}),
            ...(openFreeze ? { openFreeze } : {}),
            ...(stunShare ? { stunShare } : {}),
            ...(burstOnStun ? { burstOnStun } : {}),
            ...(stunSpec && !defaultSpec(kit)?.stun ? { stunSpec } : {}),
        };
    };
    let result: Awaited<ReturnType<typeof huntOnce>> | undefined, failure: string | undefined;
    const runs = followers.map(f => follow(f, leader!, shared, army.filter(n => n !== f.name.toLowerCase()), options(f), followTiles, stop, emit));
    try { result = await huntOnce(leader!, cfg, stop, leaderEmit); }
    catch (error) { failure = String(error); }
    shared.over = true;
    const fs = await Promise.all(runs);
    const ok = !!result && !failure && fs.every(f => !f.died);
    const detail = failure ?? `PK army: ${shared.killed.size} kills, ${result!.deaths + fs.filter(f => f.died).length} deaths, ${result!.attacks} leader attacks; followers ${fs.map(f => `${f.name}:${f.fights}f/${f.kills}k${f.died ? '/died' : ''}`).join(' ')}`;
    const loggedOut = await settle(sessions, ok, detail);
    console.log('PK_ARMY ' + JSON.stringify({ ok, failure, leader: result, followers: fs, loggedOut }));
    return ok && loggedOut ? 0 : 1;
}
