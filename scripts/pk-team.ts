// Practice meeting of two teams of own accounts: SPAR_TEAM accounts a side (default 2), all in one place. Each account
// takes the enemy with the lowest health bar in view (the nearest on a tie), fights it with the fight loop until it
// is dead or gone, then takes the next. The meeting ends when one side has no account left in the Wilderness, or at
// the cap. Side A's accounts know each other as allies (FightOptions.allies), and so do side B's.
// Usage: bun scripts/pk-team.ts <bot> <bot ...> [CAP ticks]: groups of 2 x SPAR_TEAM accounts, side A first.
// SPAR_A, SPAR_B, SPAR_A_OPTS, SPAR_B_OPTS and SPAR_KITS=<kit A>:<kit B> as in scripts/pk-gang.ts; a side's kit may
// be kits joined by `+` (tribrid-snare-spear+tribrid-snare), taken in turn by its members.
// Prints one `TEAM <json>` line for each group and one RESULT: wins (side A left standing), losses, draws.
import type { Session } from '../packages/core/src/inprocess';
import { fightPlayer, nextTick, observePlayer, wildernessLevel, type FightOptions } from './pk';
import { TRIBRID_KIT } from './pk-hunt';
import { kitOptions, kitSwitches } from './pk-kits';
import { sparOptions } from './pk-spar';

export type TeamResult = { winner: 'a' | 'b' | 'draw'; ticks: number; standing: { a: number; b: number }; died: { a: number; b: number }; attacks: { a: number; b: number }; taken: { a: number; b: number } };

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
// The enemy that an account takes from those in view (`own`: the enemy in its own place on the other side).
export function pickEnemy<F, X extends { f: F; p?: { distance: number } }>(live: readonly X[], own: F | undefined, pick: TeamPick, health: (x: X) => number): X | undefined {
    return (pick === 'pair' ? live.find(x => x.f === own) : undefined)
        ?? [...live].sort((x, y) => (pick !== 'near' ? health(x) - health(y) : 0) || x.p!.distance - y.p!.distance)[0];
}
// optionsA and optionsB: one side's options, or a function of the member's place on its side (per-member kits).
type SideOptions = FightOptions | ((member: number) => FightOptions);
export async function team(a: readonly Session[], b: readonly Session[], optionsA: SideOptions, optionsB: SideOptions, cap: number,
    log: (line: string) => void = l => console.log(l), halt: () => boolean = () => false, picks: { a: TeamPick; b: TeamPick } = { a: 'low', b: 'low' }): Promise<TeamResult> {
    // A new practice world refuses player attacks for its first 8 ticks (pvp_combat.rs2:110).
    for (let i = 0; i < 10; i++) if ((await Promise.all([...a, ...b].map(s => nextTick(s)))).some(t => !t)) break;
    const lives = new Map([...a, ...b].map(s => [s, s.sdk.getState()?.player?.lifeId] as const));
    const isOut = (s: Session) => out(s, lives.get(s));
    const start = a[0]!.tick(), attacks = { a: 0, b: 0 }, taken = { a: 0, b: 0 };
    // HP lost by each side: the sum of each account's drops, read each tick.
    const lastHp = new Map<Session, number>();
    const unwatch = [...a, ...b].map(s => s.onTick(() => { const hp = s.sdk.getState()?.player?.hp; if (hp === undefined) return; const was = lastHp.get(s); if (was !== undefined && hp < was) taken[a.includes(s) ? 'a' : 'b'] += was - hp; lastHp.set(s, hp); }));
    let over = false;
    const ended = () => over || halt() || a.every(isOut) || b.every(isOut) || a[0]!.tick() - start >= cap;
    const side = (mine: readonly Session[], foes: readonly Session[], sideOptions: SideOptions, key: 'a' | 'b') => mine.map(async (s, member) => {
        const options = typeof sideOptions === 'function' ? sideOptions(member) : sideOptions;
        const allies = mine.filter(x => x !== s).map(x => x.name.toLowerCase());
        // The game refuses an attack on an enemy while another one has hit us in the last 8 ticks (pvp_combat.rs2:104-112:
        // "I'm already under attack."): the fight stops on the refusal and the pick leaves that enemy out for 8 ticks.
        let seenMessage = 0, refusedAt = -100;
        const skip = new Map<Session, number>();
        const unwatchRefusals = s.onTick(() => { for (const msg of s.sdk.getState()?.gameMessages ?? []) { const id = msg.observationId ?? msg.tick; if (id <= seenMessage) continue; seenMessage = id;
            if (msg.tick >= start && /already under attack/i.test(msg.text)) refusedAt = s.tick(); } });
        try {
        while (!ended() && !isOut(s)) {
            // The enemy with the lowest health bar in view, the nearest on a tie.
            const view = s.sdk.getState()?.nearbyPlayers ?? [];
            const live = foes.filter(f => !isOut(f) && (skip.get(f) ?? -100) < s.tick()).map(f => ({ f, p: view.find(v => v.name.toLowerCase() === f.name.toLowerCase()) })).filter(x => x.p);
            const health = (x: { p?: { index: number } }) => { const o = x.p ? observePlayer(s.client, x.p.index) : null; return o && o.totalHealth > 0 ? o.health / o.totalHealth : 1; };
            const pick = pickEnemy(live, foes[member], picks[key], health);
            if (!pick) { if (!await nextTick(s)) return; continue; }
            const began = s.tick();
            const r = await fightPlayer(s, pick.f.name, { ...options, allies, cap: Math.max(1, cap - (s.tick() - start)), stop: () => ended() || isOut(pick.f) || refusedAt > began,
                log: l => log(`[${s.name}] ${l}`) });
            if (refusedAt > began) skip.set(pick.f, s.tick() + 8);
            attacks[key] += r.attacks.magic + r.attacks.ranged + r.attacks.melee;
            if (r.outcome === 'died' || r.outcome === 'escaped' || r.outcome === 'session ended') return;
            if (!await nextTick(s)) return;
        }
        } finally { unwatchRefusals(); }
    });
    await Promise.all([...side(a, b, optionsA, 'a'), ...side(b, a, optionsB, 'b')]);
    over = true;
    for (const u of unwatch) u();
    const standing = { a: a.filter(s => !isOut(s)).length, b: b.filter(s => !isOut(s)).length };
    const died = { a: a.filter(s => dead(s, lives.get(s))).length, b: b.filter(s => dead(s, lives.get(s))).length };
    const winner = standing.a > 0 && standing.b === 0 ? 'a' : standing.b > 0 && standing.a === 0 ? 'b' : 'draw';
    return { winner, ticks: a[0]!.tick() - start, standing, died, attacks, taken };
}

if (import.meta.main) {
    // SPAR_TEAM_B: the accounts of side B when it is not SPAR_TEAM (two of ours against three).
    const env = process.env, size = Math.max(1, Number(env.SPAR_TEAM ?? 2)), sizeB = Math.max(1, Number(env.SPAR_TEAM_B ?? size)), group = size + sizeB;
    const args = process.argv.slice(2), capArg = args.find(x => /^\d+$/.test(x)), bots = args.filter(x => x !== capArg);
    if (!bots.length || bots.length % group) { console.log(`RESULT fail usage: bun scripts/pk-team.ts <${group} bots a group> [CAP ticks]`); process.exit(2); }
    const { openBot, finish } = await import('../packages/core/src/bot');
    const cap = Number(env.SPAR_CAP ?? capArg ?? 900), nameA = env.SPAR_A ?? 'base', nameB = env.SPAR_B ?? 'base';
    const [kitA, kitB] = (env.SPAR_KITS ?? '').split(':');
    // A side's kit may be one kit or kits joined by `+`, taken in turn by the side's members.
    const options = (sideB: boolean, group: number) => (member: number): FightOptions => {
        const kits = (sideB ? kitB : kitA)?.split('+').filter(Boolean) ?? [];
        const kit = kits.length ? kits[member % kits.length] : undefined;
        const seed = env.BENCH_SEED === undefined ? {} : { mixSeed: Number(env.BENCH_SEED) * 1000 + group * 2 + (sideB ? 1 : 0) };
        return { ...sparOptions(sideB ? nameB : nameA, sideB ? env.SPAR_B_OPTS : env.SPAR_A_OPTS, kit ? kitSwitches(kit) : TRIBRID_KIT, cap, kit ? kitOptions(kit) : {}), ...seed };
    };
    let halted: string | undefined;
    const onStop = async (_s: unknown, reason: string) => { if (reason !== 'died') halted ??= reason; };
    const { tickWaits } = await import('../packages/core/src/tick-stream');
    tickWaits.active++;
    // The account of the run logs in first: the bench checks the first START line against that account's start tile.
    const first = await openBot(bots[0]!, { onStop });
    const groups: Session[][] = [];
    try {
        for (let at = 0; at < bots.length; at += group) groups.push(await Promise.all(bots.slice(at, at + group).map((name, i) => (at === 0 && i === 0 ? first : openBot(name, { onStop })))));
    } finally { tickWaits.active--; }
    for (const s of groups.flat()) (s.client as { setReachabilityEnabled?: (on: boolean) => void } | undefined)?.setReachabilityEnabled?.(false);
    // SPAR_A_PICK, SPAR_B_PICK: low (default), near or pair.
    const pickOf = (v?: string): TeamPick => (v === 'near' || v === 'pair' ? v : 'low');
    const results = await Promise.all(groups.map((g, i) => team(g.slice(0, size), g.slice(size), options(false, i), options(true, i), cap, undefined, () => halted !== undefined,
        { a: pickOf(env.SPAR_A_PICK), b: pickOf(env.SPAR_B_PICK) })));
    for (const r of results) console.log(`TEAM ${JSON.stringify({ profiles: { a: nameA, b: nameB }, kits: { a: kitA, b: kitB }, ...r })}`);
    const wins = results.filter(r => r.winner === 'a').length, losses = results.filter(r => r.winner === 'b').length;
    const ok = halted === undefined && results.every(r => r.attacks.a > 0 && r.attacks.b > 0);
    await finish(groups.flat(), ok, `team groups=${results.length} size=${size} wins=${wins} losses=${losses} draws=${results.length - wins - losses} ticks=${Math.max(0, ...results.map(r => r.ticks))} a=${nameA} b=${nameB} `
        + `standing=${results.map(r => `${r.standing.a}-${r.standing.b}`).join(',')} diedA=${results.reduce((n, r) => n + r.died.a, 0)} diedB=${results.reduce((n, r) => n + r.died.b, 0)} takenA=${results.reduce((n, r) => n + r.taken.a, 0)}${halted ? ` halted=${halted}` : ''}`);
}
