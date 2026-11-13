// The PK army: a leader that roams for prey (scripts/pk-roam.ts huntOnce) and followers that keep with it and fight
// whatever it fights. All accounts run in this process. A follower stays within FOLLOW tiles of the leader; while the
// leader has a target in view the follower fights that target with the fight loop on the `army` profile
// (scripts/pk-spar.ts: specials held to 35% so the army's land together, research/pvp-fight-loop.md findings 47 and
// 49), knowing the other accounts as allies, so the champion's escape from a crowd counts them. When the leader
// escapes, dies or ends its hunt, each follower leaves the Wilderness: a glory up to level 30, else a run south.
// Usage: bun scripts/pk-army.ts <leader> <follower ...> [MAX_MINUTES=20] [MAX_WILD=20] [FOLLOW=3] [FRIENDS=name,...]
// and the other KEY=value arguments of scripts/pk-roam.ts for the leader. Prints one RESULT with the leader's hunt and
// each follower's fights.
import { existsSync } from 'node:fs';
import { openBot, settle } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { fightPlayer, nextTick, wildernessLevel, type FightOptions } from './pk';
import { escapeStep, huntOnce, kitFrom, type Cfg } from './pk-roam';
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
    for (let step = 0; step < 120; step++) {
        const p = s.sdk.getState()?.player;
        if (!p) { if (!await nextTick(s)) return false; continue; }
        const glory = s.sdk.getInventory().find(i => GLORY.test(i.name));
        const worn = s.sdk.getEquipment().find(i => GLORY.test(i.name));
        const how = escapeStep(wildernessLevel(p.worldZ), { glory: !!glory || !!worn, teleport: false });
        if (how === 'out') { emit({ e: 'follower-out', name: s.name, at: [p.worldX, p.worldZ] }); return true; }
        if (how === 'glory') {
            // The game rubs a glory only from the pack (amulet_of_glory.rs2 has no worn option).
            if (!glory && worn) { await s.sdk.sendUseEquipmentItem?.(worn.slot, 1); await s.sdk.waitForTicks(1); continue; }
            const op = glory!.optionsWithIndex?.find((o: { text: string }) => /^rub$/i.test(o.text));
            await s.sdk.sendUseItem(glory!.slot, op?.opIndex ?? 4);
            for (let i = 0; i < 6 && !s.sdk.getDialog()?.isOpen; i++) await s.sdk.waitForTicks(1);
            await s.sdk.clickDialogByText(/^Edgeville/i);
            await s.sdk.waitForTicks(6);
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
    const emit = (e: object) => console.log('PK_EVENT ' + JSON.stringify({ t: leader!.tick(), ...e }));
    // The army's kills: each target that any of its accounts saw die, once.
    const shared = { target: null as string | null, over: false, killed: new Set<string>() };
    // OPEN_TOGETHER=1: the army holds its fire on a new target until every account stands within 3 tiles of it, 10
    // of the leader's ticks at most, then all open in one tick.
    const openTogether = arg(args, 'OPEN_TOGETHER', '0') === '1';
    const opened = new Map<string, number>();
    const hold = () => {
        const t = shared.target?.toLowerCase();
        if (!openTogether || !t) return false;
        const first = opened.get(t) ?? (opened.set(t, leader!.tick()), leader!.tick());
        if (first < 0) return false;
        const near = sessions.every(x => { const p = x.sdk.getState()?.nearbyPlayers.find(n => n.name.toLowerCase() === t); return !!p && p.distance <= 3; });
        if (near || leader!.tick() - first >= 10) { opened.set(t, -1); return false; }
        return true;
    };
    if (openTogether) cfg.hold = hold;
    // FREEZE_SHARE=1 (default): one freeze for the army, on the leader's tick count.
    const freezeShare = arg(args, 'FREEZE_SHARE', '1') === '1' ? { clock: () => leader!.tick(), until: -1 } : undefined;
    if (freezeShare) cfg.fight = { ...cfg.fight, freezeShare, allies: followers.map(f => f.name.toLowerCase()) };
    const leaderEmit = (e: object) => {
        const ev = e as { e?: string; target?: string };
        if (ev.e === 'target' && ev.target) shared.target = ev.target;
        if ((ev.e === 'kill' || (ev.e === 'fight-end' && (ev as { outcome?: string }).outcome === 'kill')) && ev.target) shared.killed.add(ev.target.toLowerCase());
        if (ev.e === 'chase-end' || ev.e === 'kill' || ev.e === 'gone' || ev.e === 'left') shared.target = null;
        if (ev.e === 'escape' || ev.e === 'death') { shared.target = null; shared.over = true; }
        emit(e);
    };
    // ARMY_PROFILE: the followers' profile of scripts/pk-spar.ts (default army; army-alpha opens with every special).
    const armyProfile = arg(args, 'ARMY_PROFILE', 'army');
    // ARMY_OPTS: fight options (JSON) on top of that profile, such as {"freeze":false} for followers that only hit while
    // the leader freezes.
    const armyOpts = arg(args, 'ARMY_OPTS', '') || undefined;
    const options = (s: Session): FightOptions => ({ ...sparOptions(armyProfile, armyOpts, kitFrom(s.sdk.getEquipment(), s.sdk.getInventory(), cfg.ranged), Math.round(cfg.maxMs / 600)), ...(freezeShare ? { freezeShare } : {}), ...(openTogether ? { holdFire: hold } : {}) });
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
