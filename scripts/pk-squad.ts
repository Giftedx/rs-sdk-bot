// The gang squad: several of our accounts hold a multi-way post and kill the named targets that come to it, again and
// again. Built for the dagger gang (Goondelf, Ligma, Sugma: research/pvp-fight-loop.md "The cost of a kill"): the gang
// walks to its target, so the squad waits in the multi-way zone 12 tiles west of the gang's single-way post (x
// 3064-3071, z 3624-3663, Wilderness 14-18) and every account hits the same gang account, the one with the lowest
// health bar (on the bench four kill 47 of 48 at 35 HP a kill, nine 24 of 24 at 14 HP). Each account fights with the
// fight loop (profile SQUAD_PROFILE, default gang-hunter, with SQUAD_OPTS), picks up the dearest drops after a kill
// (scripts/pk-gang.ts pickUp: a skulled gang account with no Protect Item drops its dragon dagger(p)), and when its
// fight loop leaves (low HP with no food) it banks at Edgeville (scripts/pk-gang.ts bankTrip: the pack it started
// with, the boosts drunk at the bank) and walks back to the post.
// Usage: bun scripts/pk-squad.ts <account> [<account> ...] [KEY=value ...]
//   TARGETS=goondelf,ligma,sugma  POST=3067,3640  MAX_MINUTES=30  MAX_KILLS=0 (no limit)  SQUAD_PROFILE=gang-hunter
//   SQUAD_OPTS={"cureNow":true,"eatAt":60,"freeze":"flee","focusRunner":0.4,"chaseBelow":0.4,"freezeMagicCap":49,"dropForStrip":null}
//   PICKUP=1  TRIPS=10 (bank trips an account may make)
// Bench only: SQUAD_GANG=<n> drives the last n accounts as the gang (profile ganker-live against our accounts).
// Live: openBot refuses a non-local server without DEMO_OK=1 and an account of another fleet side. The main account
// is refused. Stop: touch .practice/stop-<account> for one account, or .practice/stop-pk-squad for all.
import { existsSync } from 'node:fs';
import type { Session } from '../packages/core/src/inprocess';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { fightPlayer, isMulti, nextTick, observePlayer, wildernessLevel, type FightOptions } from './pk';
import { bankTrip, packOf, pickUp, PICKUP_ITEMS } from './pk-gang';
import { EDGEVILLE_BANK } from './pk-hunt';
import { kitFrom } from './pk-roam';
import { sparOptions } from './pk-spar';

export const GANG = ['goondelf', 'ligma', 'sugma'];
export const SQUAD_POST = { x: 3067, z: 3640 };
const MAIN = new Set(['haggis']);
// dropForStrip off: the profile's champion base drops a shark before a freeze to free slots for its armour strip.
export const SQUAD_OPTS = { cureNow: true, eatAt: 60, freeze: 'flee', focusRunner: 0.4, chaseBelow: 0.4, freezeMagicCap: 49, dropForStrip: null } as const;

export type SquadStats = { name: string; fights: number; kills: number; trips: number; died: boolean; picked: Record<string, number>; taken: number };

// The target of the squad: the target account in view with the lowest health bar, the nearest on a tie; one the game
// refused leaves the pick for 8 ticks.
export function squadTarget<P extends { name: string; index: number; distance: number }>(view: readonly P[], targets: ReadonlySet<string>, health: (p: P) => number, skip: ReadonlySet<string> = new Set()): P | undefined {
    return view.filter(p => targets.has(p.name.toLowerCase()) && !skip.has(p.name.toLowerCase())).sort((a, b) => health(a) - health(b) || a.distance - b.distance)[0];
}

// One account of the squad: hold the post, fight the squad's target, pick up, bank and come back.
export async function hold(s: Session, o: { targets: ReadonlySet<string>; post: { x: number; z: number }; options: FightOptions; allies: readonly string[]; pickup: boolean;
    trips: number; deadline: number; stopped: () => boolean; killsLeft: () => boolean; log: (l: string) => void }): Promise<SquadStats> {
    const stats: SquadStats = { name: s.name, fights: 0, kills: 0, trips: 0, died: false, picked: {}, taken: 0 };
    const st = s.sdk.getState(), me = () => s.sdk.getState()?.player, life0 = st?.player?.lifeId;
    const pack = packOf(st?.inventory ?? [], st?.equipment ?? []), kit = kitFrom(st?.equipment ?? [], st?.inventory ?? []);
    const ammo = (st?.equipment ?? []).find(e => /arrow|bolt/i.test(e.name))?.id;
    const wanted = new Set([...PICKUP_ITEMS, ...(ammo ? [ammo] : [])]);
    const trip = bankTrip(EDGEVILLE_BANK, o.post, pack, kit, o.stopped);
    const walker = await sessionWalker(s);
    const going = () => !o.stopped() && s.tick() < o.deadline && o.killsLeft();
    let lastHp = me()?.hp ?? 0, seenMessage = 0, refusedAt = -100;
    const skip = new Map<string, number>();
    const unwatch = s.onTick(() => {
        const hp = me()?.hp; if (hp !== undefined) { if (hp < lastHp) stats.taken += lastHp - hp; lastHp = hp; }
        for (const m of s.sdk.getState()?.gameMessages ?? []) { const id = m.observationId ?? m.tick; if (id <= seenMessage) continue; seenMessage = id; if (/already under attack/i.test(m.text)) refusedAt = s.tick(); }
    });
    try {
        while (going()) {
            const p = me();
            if (!p) { if (!await nextTick(s)) break; continue; }
            if ((life0 !== undefined && p.lifeId !== life0) || Math.max(Math.abs(p.worldX - 3222), Math.abs(p.worldZ - 3218)) <= 40) { stats.died = true; o.log(`[${s.name}] SQUAD died`); break; }
            // Out of the Wilderness (a walk out, a teleport): to the bank and back to the post.
            if (wildernessLevel(p.worldZ) === 0) {
                if (stats.trips >= o.trips) { o.log(`[${s.name}] SQUAD no trips left`); break; }
                stats.trips++;
                // Eat up first: a teleport out (Camelot) leaves a long walk, and the gang's daggers poison.
                for (let i = 0; i < 12 && !o.stopped(); i++) {
                    const q = me(), food = s.sdk.getInventory().find(f => f.optionsWithIndex.some(op => /^eat$/i.test(op.text)));
                    const op = food?.optionsWithIndex.find(x => /^eat$/i.test(x.text));
                    if (!q || !food || !op || q.hp >= q.maxHp - 20) break;
                    await s.sdk.sendUseItem(food.slot, op.opIndex);
                    for (let t = 0; t < 3; t++) if (!await nextTick(s)) break;
                }
                const fault = await trip(s);
                const after = me();
                if (after && ((life0 !== undefined && after.lifeId !== life0) || Math.max(Math.abs(after.worldX - 3222), Math.abs(after.worldZ - 3218)) <= 40)) { stats.died = true; o.log(`[${s.name}] SQUAD died on a bank trip`); break; }
                if (fault) { o.log(`[${s.name}] SQUAD bank trip: ${fault}`); break; }
                continue;
            }
            const now = s.tick();
            for (const [k, until] of skip) if (until <= now) skip.delete(k);
            const view = s.sdk.getState()?.nearbyPlayers ?? [];
            const health = (q: { index: number }) => { const seen = observePlayer(s.client, q.index); return seen && seen.totalHealth > 0 ? seen.health / seen.totalHealth : 1; };
            const target = squadTarget(view, o.targets, health, new Set(skip.keys()));
            if (!target) {
                // Back to the post between fights.
                if (Math.max(Math.abs(p.worldX - o.post.x), Math.abs(p.worldZ - o.post.z)) > 2) await walkPath(walker, [{ ...o.post, tol: 1 }], { maxTicks: 60, idleMs: 9000, stop: () => !going() || !!squadTarget(s.sdk.getState()?.nearbyPlayers ?? [], o.targets, health) });
                else if (!await nextTick(s)) break;
                continue;
            }
            const began = s.tick();
            stats.fights++;
            const r = await fightPlayer(s, target.name, { ...o.options, allies: o.allies, cap: Math.max(1, o.deadline - s.tick()), stop: () => !going() || refusedAt > began,
                log: l => o.log(`[${s.name}] ${l}`) });
            if (refusedAt > began) skip.set(target.name.toLowerCase(), s.tick() + 8);
            const gone = !(s.sdk.getState()?.nearbyPlayers ?? []).some(q => q.name.toLowerCase() === target.name.toLowerCase());
            if (r.outcome === 'kill') stats.kills++;
            if (o.pickup && (r.outcome === 'kill' || gone)) for (const [id, n] of Object.entries(await pickUp(s, wanted, { radius: 3, maxTicks: 30, wait: 6, stop: o.stopped }))) stats.picked[id] = (stats.picked[id] ?? 0) + n;
            if (r.outcome === 'died') { stats.died = true; break; }
            if (!await nextTick(s)) break;
        }
    } finally { unwatch(); }
    return stats;
}

if (import.meta.main) {
    const env = process.env, args = process.argv.slice(2);
    const kv = Object.fromEntries(args.filter(a => /^[A-Z_]+=/.test(a)).map(a => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
    const get = (k: string, d: string) => kv[k] ?? env[k] ?? d;
    const names = args.filter(a => !/^[A-Z_]+=/.test(a) && !/^\d+$/.test(a));
    const gangSize = Number(get('SQUAD_GANG', '0'));
    const ours = names.slice(0, names.length - gangSize), gangNames = names.slice(names.length - gangSize);
    if (!ours.length) { console.log('RESULT fail usage: bun scripts/pk-squad.ts <account> [<account> ...] [KEY=value ...]'); process.exit(2); }
    if (ours.some(n => MAIN.has(n.toLowerCase()))) { console.log('RESULT fail the main account is not a squad account'); process.exit(2); }
    const [px, pz] = get('POST', `${SQUAD_POST.x},${SQUAD_POST.z}`).split(',').map(Number);
    const post = { x: px!, z: pz! };
    if (!isMulti(post.x, post.z) || wildernessLevel(post.z) === 0) { console.log(`RESULT fail post ${post.x},${post.z} is not a multi-way Wilderness tile`); process.exit(2); }
    const targets = new Set((gangSize ? gangNames : get('TARGETS', GANG.join(',')).split(',')).map(t => t.trim().toLowerCase()).filter(Boolean));
    const { openBot, finish } = await import('../packages/core/src/bot');
    let halted: string | undefined;
    const onStop = async (_s: unknown, reason: string) => { if (reason !== 'died') halted ??= reason; };
    const all: Session[] = [];
    for (const n of names) all.push(await openBot(n, { onStop }));
    const squad = all.slice(0, ours.length), gang = all.slice(ours.length);
    // Bench: a gang account is out when it died (a new life, or at the Lumbridge spawn) or left the Wilderness.
    const gangLife = new Map(gang.map(g => [g, g.sdk.getState()?.player?.lifeId] as const));
    const gangDead = (g: Session) => { const p = g.sdk.getState()?.player; return !!p && ((gangLife.get(g) !== undefined && p.lifeId !== gangLife.get(g)) || Math.max(Math.abs(p.worldX - 3222), Math.abs(p.worldZ - 3218)) <= 40); };
    const gangOut = () => gang.length > 0 && gang.every(g => { const p = g.sdk.getState()?.player; return !p || gangDead(g) || wildernessLevel(p.worldZ) === 0; });
    const stopped = () => halted !== undefined || existsSync('.practice/stop-pk-squad') || gangOut();
    const deadline = squad[0]!.tick() + Math.round(Number(get('MAX_MINUTES', '30')) * 100);
    const maxKills = Number(get('MAX_KILLS', '0'));
    let kills = 0;
    const optsJson = get('SQUAD_OPTS', JSON.stringify(SQUAD_OPTS));
    const log = (l: string) => console.log(l);
    // Bench: the gang accounts each fight the nearest of ours in view until they walk out (profile ganker-live).
    const gangRuns = gang.map(async g => {
        const opts = sparOptions('ganker-live', env.SPAR_B_OPTS, kitFrom(g.sdk.getState()?.equipment ?? [], g.sdk.getState()?.inventory ?? []), 1200);
        while (!stopped() && g.tick() < deadline) {
            const me = g.sdk.getState()?.player;
            if (!me || wildernessLevel(me.worldZ) === 0) break;
            const prey = (g.sdk.getState()?.nearbyPlayers ?? []).filter(q => ours.some(n => n.toLowerCase() === q.name.toLowerCase())).sort((a, b) => a.distance - b.distance)[0];
            if (!prey) { if (!await nextTick(g)) break; continue; }
            const r = await fightPlayer(g, prey.name, { ...opts, allies: gangNames.filter(n => n !== g.name).map(n => n.toLowerCase()), cap: Math.max(1, deadline - g.tick()), stop: stopped });
            if (r.outcome === 'died' || r.outcome === 'escaped') break;
            if (!await nextTick(g)) break;
        }
    });
    // Our accounts walk to the post first.
    await Promise.all(squad.map(async s => { const r = await walkPath(await sessionWalker(s), [{ ...post, tol: 2 }], { maxTicks: 600, idleMs: 9000, stop: stopped }); if (!r.ok) log(`[${s.name}] SQUAD no walk to the post: ${r.detail ?? 'stopped'}`); }));
    const results = await Promise.all(squad.map(s => hold(s, { targets, post, options: sparOptions(get('SQUAD_PROFILE', 'gang-hunter'), optsJson, kitFrom(s.sdk.getState()?.equipment ?? [], s.sdk.getState()?.inventory ?? []), 1200),
        allies: ours.filter(n => n !== s.name).map(n => n.toLowerCase()), pickup: get('PICKUP', '1') === '1', trips: Number(get('TRIPS', '10')), deadline,
        stopped: () => stopped() || existsSync(`.practice/stop-${s.name}`), killsLeft: () => !maxKills || kills < maxKills, log: l => { if (/PK kill /.test(l)) kills++; log(l); } })));
    await Promise.all(gangRuns);
    for (const r of results) console.log(`SQUAD ${JSON.stringify(r)}`);
    const picked: Record<string, number> = {};
    for (const r of results) for (const [id, n] of Object.entries(r.picked)) picked[id] = (picked[id] ?? 0) + n;
    const sum = (f: (r: SquadStats) => number) => results.reduce((n, r) => n + f(r), 0);
    const ok = halted === undefined && sum(r => r.fights) > 0;
    await finish(all, ok, `squad accounts=${results.length} kills=${sum(r => r.kills)}${gang.length ? ` gangDied=${gang.filter(gangDead).length}` : ''} died=${results.filter(r => r.died).length} taken=${sum(r => r.taken)} trips=${sum(r => r.trips)} picked=${JSON.stringify(picked)}${halted ? ` halted=${halted}` : ''}`);
}
