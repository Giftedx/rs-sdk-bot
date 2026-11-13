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
import { openBot, settle } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { bestFood, fightPlayer, newVolley, nextTick, wildernessLevel, type FightOptions, type VolleyState } from './pk';
import { escapeStep, huntOnce, kitFrom, wearGlory, type Cfg } from './pk-roam';
import { sparOptions } from './pk-spar';

export type FollowerStats = { name: string; fights: number; kills: number; died: boolean; escaped: boolean; attacks: number };
const GLORY = /^amulet of glory\([1-4]\)$/i;

// One follower: keep with the leader, fight its target, leave when the army leaves.
export async function follow(s: Session, leader: Session, shared: { target: string | null; over: boolean; killed: Set<string> }, allies: readonly string[],
    options: FightOptions, followTiles: number, stopped: () => boolean, emit: (e: object) => void): Promise<FollowerStats> {
    const stats: FollowerStats = { name: s.name, fights: 0, kills: 0, died: false, escaped: false, attacks: 0 };
    const walker = await sessionWalker(s);
    const me = () => s.sdk.getState()?.player;
    const life0 = me()?.lifeId;
    const dead = () => { const p = me(); return !!p && ((life0 !== undefined && p.lifeId !== life0) || Math.max(Math.abs(p.worldX - 3222), Math.abs(p.worldZ - 3218)) <= 40); };
    let wentIn = false;
    while (!stopped() && !shared.over) {
        const p = me();
        if (!p) { if (!await nextTick(s)) break; continue; }
        if (wildernessLevel(p.worldZ) > 0) wentIn = true;
        if (dead()) { stats.died = true; emit({ e: 'follower-died', name: s.name }); return stats; }
        const target = shared.target;
        const seen = target ? (s.sdk.getState()?.nearbyPlayers ?? []).find(x => x.name.toLowerCase() === target.toLowerCase()) : undefined;
        if (target && seen && seen.distance <= 15) {
            stats.fights++;
            const r = await fightPlayer(s, target, { ...options, allies, stop: () => stopped() || shared.over || shared.target !== target,
                log: l => emit({ e: 'follower-fight', name: s.name, line: l }) });
            stats.attacks += r.attacks.magic + r.attacks.ranged + r.attacks.melee;
            if (r.outcome === 'kill') { stats.kills++; shared.killed.add(target.toLowerCase()); }
            if (r.outcome === 'died') { stats.died = true; return stats; }
            if (r.outcome === 'escaped') { stats.escaped = true; return stats; }
            continue;
        }
        // Keep with the leader.
        const l = leader.sdk.getState()?.player;
        if (l && l.level === p.level && Math.max(Math.abs(l.worldX - p.worldX), Math.abs(l.worldZ - p.worldZ)) > followTiles) {
            await walkPath(walker, [{ x: l.worldX, z: l.worldZ, tol: 1 }], { maxTicks: 6, idleMs: 9000 });
            continue;
        }
        if (!await nextTick(s)) break;
    }
    // The army leaves: a glory up to level 30, else a run south, until out of the Wilderness.
    if (wentIn && !dead()) stats.escaped = await leave(s, walker, emit);
    return stats;
}

async function leave(s: Session, walker: Awaited<ReturnType<typeof sessionWalker>>, emit: (e: object) => void): Promise<boolean> {
    let removeTries = 0;
    for (let step = 0; step < 120; step++) {
        const p = s.sdk.getState()?.player;
        if (!p) { if (!await nextTick(s)) return false; continue; }
        const glory = s.sdk.getInventory().find(i => GLORY.test(i.name));
        const worn = s.sdk.getEquipment().find(i => GLORY.test(i.name));
        const how = escapeStep(wildernessLevel(p.worldZ), { glory: !!glory || (!!worn && removeTries < 3), teleport: false });
        if (how === 'out') { emit({ e: 'follower-out', name: s.name, at: [p.worldX, p.worldZ] }); return true; }
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
        } else await walkPath(walker, [{ x: p.worldX, z: Math.max(3510, p.worldZ - 20), tol: 2 }], { maxTicks: 12, idleMs: 9000 });
    }
    return false;
}

const arg = (args: string[], key: string, d: string) => args.find(a => a.startsWith(key + '='))?.slice(key.length + 1) ?? d;

if (import.meta.main) {
    const all = process.argv.slice(2), names = all.filter(a => !a.includes('=')), args = all.filter(a => a.includes('='));
    const [leaderName, ...followerNames] = names;
    if (!leaderName || !followerNames.length) { console.log('RESULT fail usage: bun scripts/pk-army.ts <leader> <follower ...> [KEY=value ...]'); process.exit(2); }
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
        // The army is always among the leader's friends, whatever FRIENDS names.
        ...(friendList ? { friends: [...friendList, ...army] } : {}),
    };
    const followTiles = Math.max(1, Number(arg(args, 'FOLLOW', '3')));
    const { tickWaits } = await import('../packages/core/src/tick-stream');
    tickWaits.active++;
    let sessions: Session[];
    try { sessions = await Promise.all(names.map(n => openBot(n))); } finally { tickWaits.active--; }
    const [leader, ...followers] = sessions;
    // The leader's fights take the champion's options for a maxed leader, as the roam's do (ROAM_PROFILE auto,
    // research/pvp-fight-loop.md finding 58).
    if ((leader!.sdk.getState()?.player?.combatLevel ?? 0) >= 115) {
        const { PROFILES } = await import('./pk-spar');
        const { specBelow: _below, ...champion } = PROFILES.champion!;
        cfg.fight = { ...champion, ...cfg.fight };
    }
    const emit = (e: object) => console.log('PK_EVENT ' + JSON.stringify({ t: leader!.tick(), ...e }));
    // The army's kills: each target that any of its accounts saw die, once.
    const shared = { target: null as string | null, over: false, killed: new Set<string>() };
    // OPEN_TOGETHER=1: the army holds its fire on a new target until every account stands within 3 tiles of it,
    // OPEN_TICKS of the leader's ticks at most (default 20), then all open in one tick.
    // OPEN_RANGE: the tiles from the target at which an account counts as near and holds (default 3; 1 puts each
    // account on a melee tile, for a spear's opening special).
    // Two or more followers on the dragon spear: the spear lock is the default (finding 67), each setting still its own.
    const spears = followers.filter(f => f.sdk.getEquipment().some(i => /^dragon spear/i.test(i.name))).length, lock = spears >= 2;
    if (lock) emit({ e: 'spear-lock', spears });
    // STUN_SHARE=1: the army's spears stun in turn, one hold at a time. Off: spears that stun as soon as they can
    // overlap their holds and leave no gap to eat in (finding 67: 0 of 6 with it, 18 of 18 without).
    const stunShare = arg(args, 'STUN_SHARE', '0') === '1' ? { clock: () => leader!.tick(), until: -1 } : undefined;
    if (stunShare) cfg.fight = { ...cfg.fight, stunShare };
    const openTogether = arg(args, 'OPEN_TOGETHER', lock ? '1' : '0') === '1', openTicks = Number(arg(args, 'OPEN_TICKS', '20')), openRange = Number(arg(args, 'OPEN_RANGE', lock ? '1' : '3'));
    const opened = new Map<string, number>();
    const hold = () => {
        const t = shared.target?.toLowerCase();
        if (!openTogether || !t) return false;
        const first = opened.get(t) ?? (opened.set(t, leader!.tick()), leader!.tick());
        if (first < 0) return false;
        const near = sessions.every(x => { const p = x.sdk.getState()?.nearbyPlayers.find(n => n.name.toLowerCase() === t); return !!p && p.distance <= openRange; });
        if (near || leader!.tick() - first >= openTicks) { opened.set(t, -1); console.log('PK_EVENT ' + JSON.stringify({ t: leader!.tick(), e: 'open', target: t, why: near ? 'all near' : 'waited', after: leader!.tick() - first })); return false; }
        return true;
    };
    if (openTogether) { cfg.hold = hold; cfg.holdRange = openRange; }
    // LEADER_SPEC=all: the leader's specials go at any health and with no reserve, as the followers' on army-alpha.
    if (arg(args, 'LEADER_SPEC', '') === 'all') { cfg.specAll = true; cfg.fight = { ...cfg.fight, specReserve: 0 }; }
    // FREEZE_SHARE=1 (default): one freeze for the army, on the leader's tick count.
    // FREEZE_STAGGER=<ticks>: a cast blocks the others that long only, until its caster sees the hold.
    const stagger = arg(args, 'FREEZE_STAGGER', '') ? Number(arg(args, 'FREEZE_STAGGER', '')) : undefined;
    const freezeShare = arg(args, 'FREEZE_SHARE', '1') === '1' ? { clock: () => leader!.tick(), until: -1, ...(stagger !== undefined ? { stagger } : {}) } : undefined;
    if (freezeShare) cfg.fight = { ...cfg.fight, freezeShare, allies: followers.map(f => f.name.toLowerCase()) };
    // VOLLEY=1: the army's first special on each target goes in one tick once every account stands next to it with a
    // special ready, VOLLEY_TICKS (default 8) of the leader's ticks after the first at most (FightOptions.volley).
    const volleys = new Map<string, VolleyState>();
    const volley = arg(args, 'VOLLEY', '0') === '1' ? { state: (t: string) => volleys.get(t) ?? (volleys.set(t, newVolley()), volleys.get(t)!),
        members: sessions.length, window: Number(arg(args, 'VOLLEY_TICKS', '8')), clock: () => leader!.tick() } : undefined;
    if (volley) cfg.fight = { ...cfg.fight, volley };
    // BURST_HOLD=1: every account specials while the shared freeze holds the target (FightOptions.burstOnHold).
    const burstOnHold = arg(args, 'BURST_HOLD', '0') === '1';
    if (burstOnHold) cfg.fight = { ...cfg.fight, burstOnHold };
    // OPEN_FREEZE=1: each account's first turn on a target is a freeze (FightOptions.openFreeze).
    const openFreeze = arg(args, 'OPEN_FREEZE', '0') === '1';
    if (openFreeze) cfg.fight = { ...cfg.fight, openFreeze };
    const leaderEmit = (e: object) => {
        const ev = e as { e?: string; target?: string };
        if (ev.e === 'target' && ev.target) shared.target = ev.target;
        // The leader's chase moved to a softer target in view (scripts/pk-roam.ts, finding 62).
        if (ev.e === 'switch') shared.target = (ev as { to?: string }).to ?? shared.target;
        if ((ev.e === 'kill' || (ev.e === 'fight-end' && (ev as { outcome?: string }).outcome === 'kill')) && ev.target) shared.killed.add(ev.target.toLowerCase());
        if (ev.e === 'chase-end' || ev.e === 'kill' || ev.e === 'gone' || ev.e === 'left') shared.target = null;
        if (ev.e === 'escape' || ev.e === 'death') { shared.target = null; shared.over = true; }
        emit(e);
    };
    // ARMY_PROFILE: the followers' profile of scripts/pk-spar.ts (default army; army-alpha opens with every special).
    const armyProfile = arg(args, 'ARMY_PROFILE', lock ? 'army-alpha' : 'army');
    // ARMY_OPTS: fight options (JSON) on top of that profile, such as {"freeze":false} for followers that only hit while
    // the leader freezes.
    const armyOpts = arg(args, 'ARMY_OPTS', '') || undefined;
    const options = (s: Session): FightOptions => ({ ...sparOptions(armyProfile, armyOpts, kitFrom(s.sdk.getEquipment(), s.sdk.getInventory(), cfg.ranged), Math.round(cfg.maxMs / 600)), ...(freezeShare ? { freezeShare } : {}), ...(openTogether ? { holdFire: hold, holdRange: openRange } : {}), ...(volley ? { volley } : {}), ...(burstOnHold ? { burstOnHold } : {}), ...(openFreeze ? { openFreeze } : {}), ...(stunShare ? { stunShare } : {}) });
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
    process.exitCode = ok && loggedOut ? 0 : 1;
}
