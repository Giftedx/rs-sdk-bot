// Wilderness PK hunt: roam a lap north of Edgeville, attack players we can attack, pick the style the target does
// not protect against, eat, flee when out of food, loot kills, and leave at the budget.
//
// usage: bun scripts/pk-hunt.ts <account> [MAX_MINUTES=20] [MAX_WILD=20] [EAT_AT=50] [FLEE_AT=30] [SPELL=FIRE_BOLT]
//        [RANGED=bow-name-regex] [LOOT=1]
// The account starts anywhere south of the Wilderness with its gear worn and food in its inventory.
// Stop files: .practice/stop-<account>, .practice/stop-pk-hunt.
import { existsSync } from 'node:fs';
import { openBot, settle } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { tradePartners } from '../packages/core/src/tradeguard';
import { openStyles, readOpponent, type CombatStyle } from '../packages/core/src/opponent';

// Surface Wilderness: z 3520-3967, level 1 at z 3520-3527 (content area_wilderness; 8 tiles per level).
export function wildLevel(x: number, z: number): number {
    if (x < 2944 || x > 3392 || z < 3520 || z > 3967) return 0;
    return Math.floor((z - 3520) / 8) + 1;
}

// pvp_combat.rs2: the combat gap must be no more than the lower of the two Wilderness levels.
export function canAttack(me: { x: number; z: number; combat: number }, them: { x: number; z: number; combatLevel: number }): boolean {
    const a = wildLevel(me.x, me.z), b = wildLevel(them.x, them.z);
    return a > 0 && b > 0 && Math.abs(me.combat - them.combatLevel) <= Math.min(a, b);
}

type Candidate = { name: string; x: number; z: number; combatLevel: number; distance: number; inCombat?: boolean; combatTargetType?: string; reachable?: boolean };

// Best target: attackable, not ours, not already fighting someone else, reachable, then closest.
export function pickTarget(me: { x: number; z: number; combat: number }, players: Candidate[], friends: ReadonlySet<string>, maxWild: number): Candidate | null {
    return players
        .filter(p => !friends.has(p.name.toLowerCase()) && p.reachable !== false && !p.inCombat &&
            wildLevel(p.x, p.z) <= maxWild && canAttack(me, p))
        .sort((a, b) => a.distance - b.distance)[0] ?? null;
}

// The lap Goondelf walks: north from Edgeville to the rune rocks and back down the east side.
export function lap(maxWild: number) {
    const points = [
        { x: 3094, z: 3510 }, { x: 3090, z: 3560 }, { x: 3060, z: 3620 }, { x: 3010, z: 3680 },
        { x: 2980, z: 3740 }, { x: 2980, z: 3800 }, { x: 3020, z: 3860 }, { x: 3058, z: 3880 },
        { x: 3070, z: 3760 }, { x: 3110, z: 3700 }, { x: 3110, z: 3620 }, { x: 3100, z: 3540 },
    ];
    return points.filter(p => wildLevel(p.x, p.z) <= maxWild).map(p => ({ ...p, tol: 3 }));
}

const arg = (args: string[], key: string, d: string) => args.find(a => a.startsWith(key + '='))?.slice(key.length + 1) ?? d;

export async function huntOnce(session: Session, cfg: { maxMs: number; maxWild: number; eatAt: number; fleeAt: number; spell: string; ranged?: RegExp; loot: boolean }, stopped: () => boolean, emit: (e: object) => void) {
    const { sdk, bot } = session;
    const me = () => { const p = sdk.getState()?.player; return p && { x: p.worldX, z: p.worldZ, combat: p.combatLevel, hp: p.hp, maxHp: p.maxHp }; };
    const friends = new Set([...tradePartners(process.env.SERVER ?? 'rs-sdk-demo.fly.dev')].map(n => n.toLowerCase()));
    const end = Date.now() + cfg.maxMs;
    const food = () => sdk.getInventory().filter(i => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text)));
    const magic = sdk.getSkill('Magic')?.baseLevel ?? 1;
    const melee: CombatStyle[] = ['melee'];
    const styles = (): CombatStyle[] => [
        ...melee,
        ...(cfg.ranged && (sdk.getInventory().some(i => cfg.ranged!.test(i.name)) || sdk.getEquipment().some(i => cfg.ranged!.test(i.name))) ? ['ranged' as const] : []),
        ...(magic >= 13 ? ['magic' as const] : []),
    ];
    const meleeWeapon = sdk.getEquipment().find(i => i.slot === 3)?.name;
    const stats = { attacks: 0, kills: 0, deaths: 0, eats: 0, loot: [] as string[], targets: new Set<string>() };
    const walker = await sessionWalker(session);
    let lastTile: { x: number; z: number } | null = null;
    let target: string | null = null;
    let style: CombatStyle = 'melee';
    let wentIn = false;

    const setStyle = async (s: CombatStyle) => {
        if (s === style) return;
        if (s === 'ranged' && cfg.ranged) await bot.equipItem(cfg.ranged);
        if (s === 'melee' && style === 'ranged' && meleeWeapon) await bot.equipItem(new RegExp('^' + meleeWeapon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
        style = s;
        emit({ e: 'style', style: s, target });
    };

    while (!stopped() && Date.now() < end) {
        const m = me();
        if (!m) { await sdk.waitForTicks(1); continue; }
        if (wildLevel(m.x, m.z) > 0) wentIn = true;
        // Death: respawn in Lumbridge.
        if (wentIn && Math.abs(m.x - 3222) <= 6 && Math.abs(m.z - 3218) <= 6) { stats.deaths++; emit({ e: 'death', target }); break; }

        if (m.hp * 100 <= m.maxHp * cfg.eatAt && food().length) {
            const r = await bot.eatFood(food()[0]);
            stats.eats++; emit({ e: 'eat', hp: m.hp, ok: r.success });
            continue;
        }
        if (m.hp * 100 <= m.maxHp * cfg.fleeAt && !food().length) {
            emit({ e: 'flee', hp: m.hp });
            await walkPath(walker, [{ x: m.x, z: 3510, tol: 3 }], { maxTicks: 200, idleMs: 9000, stop: stopped });
            break;
        }

        if (target) {
            const seen = sdk.getState()?.nearbyPlayers.find(p => p.name.toLowerCase() === target!.toLowerCase());
            const opp = readOpponent(session.client, target);
            if (seen) lastTile = { x: seen.x, z: seen.z };
            if (!seen || !opp) {
                // Gone: a kill if we saw it low, else it ran or logged.
                emit({ e: 'lost', target, lastTile });
                if (cfg.loot && lastTile) await lootAt(session, lastTile, stats, emit);
                target = null;
                continue;
            }
            if (opp.hp?.fresh && opp.hp.current === 0) {
                stats.kills++; emit({ e: 'kill', target, lastTile });
                await sdk.waitForTicks(4);
                if (cfg.loot && lastTile) await lootAt(session, lastTile, stats, emit);
                target = null;
                continue;
            }
            const open = openStyles(opp, styles());
            const next = open.includes(style) ? style : open[0] ?? style;
            await setStyle(next);
            const engaged = sdk.getState()?.player?.combat?.targetType === 'player';
            if (!engaged) {
                if (!canAttack(m, seen)) { emit({ e: 'out-of-range', target }); target = null; continue; }
                const r = style === 'magic' ? await bot.castSpell(seen as any, cfg.spell) : await bot.attack(seen as any);
                stats.attacks++;
                emit({ e: 'attack', target, style, protect: opp.protect, hp: opp.hp, ok: r.success, msg: r.success ? undefined : r.message });
                if (!r.success) target = null;
            } else if (style === 'magic') {
                await bot.castSpell(seen as any, cfg.spell);
            }
            await sdk.waitForTicks(1);
            continue;
        }

        const pick = pickTarget(m, sdk.getState()?.nearbyPlayers ?? [], friends, cfg.maxWild);
        if (pick) { target = pick.name; stats.targets.add(pick.name); emit({ e: 'target', target, combat: pick.combatLevel, wild: wildLevel(pick.x, pick.z) }); continue; }

        // Roam one lap leg; stop the walk as soon as a target shows.
        const legs = lap(cfg.maxWild);
        const near = legs.reduce((best, p, i) => Math.hypot(p.x - m.x, p.z - m.z) < Math.hypot(legs[best].x - m.x, legs[best].z - m.z) ? i : best, 0);
        const leg = legs[(near + 1) % legs.length];
        await walkPath(walker, [leg], {
            maxTicks: 80, idleMs: 9000,
            stop: () => stopped() || Date.now() >= end || !!pickTarget(me()!, sdk.getState()?.nearbyPlayers ?? [], friends, cfg.maxWild) ||
                (me()?.hp ?? 99) * 100 <= (me()?.maxHp ?? 99) * cfg.eatAt,
        });
    }
    // Leave the Wilderness at the budget.
    const m = me();
    if (m && wildLevel(m.x, m.z) > 0 && stats.deaths === 0) {
        await walkPath(walker, [{ x: 3094, z: 3505, tol: 4 }], { maxTicks: 400, idleMs: 9000, stop: stopped });
    }
    return { ...stats, targets: [...stats.targets] };
}

async function lootAt(session: Session, at: { x: number; z: number }, stats: { loot: string[] }, emit: (e: object) => void) {
    const { sdk, bot } = session;
    for (let i = 0; i < 12; i++) {
        const item = (sdk.getState()?.groundItems ?? []).find((g: any) => Math.abs(g.x - at.x) <= 1 && Math.abs(g.z - at.z) <= 1);
        if (!item || sdk.getInventory().length >= 28) break;
        const r = await bot.pickupItem(item as any);
        if (r.success) { stats.loot.push(item.name); emit({ e: 'loot', item: item.name, count: item.count }); }
        else break;
    }
}

if (import.meta.main) {
    const [name, ...args] = process.argv.slice(2);
    if (!name) throw new Error('usage: bun scripts/pk-hunt.ts <account> [MAX_MINUTES=20] [MAX_WILD=20] [EAT_AT=50] [FLEE_AT=30] [SPELL=FIRE_BOLT] [RANGED=regex] [LOOT=1]');
    const stop = () => existsSync('.practice/stop-' + name) || existsSync('.practice/stop-pk-hunt');
    if (stop()) throw new Error('pk-hunt stop file present');
    const ranged = arg(args, 'RANGED', '');
    const cfg = {
        maxMs: Number(arg(args, 'MAX_MINUTES', '20')) * 60_000, maxWild: Number(arg(args, 'MAX_WILD', '20')),
        eatAt: Number(arg(args, 'EAT_AT', '50')), fleeAt: Number(arg(args, 'FLEE_AT', '30')),
        spell: arg(args, 'SPELL', 'FIRE_BOLT'), ranged: ranged ? new RegExp(ranged, 'i') : undefined, loot: arg(args, 'LOOT', '1') === '1',
    };
    const session = await openBot(name);
    const emit = (e: object) => console.log('PK_EVENT ' + JSON.stringify({ t: session.tick(), ...e }));
    let result: Awaited<ReturnType<typeof huntOnce>> | undefined, failure: string | undefined;
    try { result = await huntOnce(session, cfg, stop, emit); }
    catch (error) { failure = String(error); }
    const ok = !!result && !failure;
    const loggedOut = await settle([session], ok, failure ?? `PK hunt: ${result!.kills} kills, ${result!.deaths} deaths, ${result!.attacks} attacks`);
    console.log('PK_HUNT ' + JSON.stringify({ ok, failure, ...result, loggedOut }));
    process.exitCode = ok && loggedOut ? 0 : 1;
}
