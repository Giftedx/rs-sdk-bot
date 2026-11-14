// Steal food from the Ardougne baker's stall for 300 game ticks without being attacked. Preset cake_stall
// (2655,3310,0, Thieving 5). Rules (skill_thieving stealing.rs2:98-121): the steal is refused when a Baker is within
// 5 tiles of the player with line of sight, and a Guard within 5 tiles shouts and attacks. The bot steals only from a
// side tile with no Baker or Guard within SAFE tiles (one tile of margin for NPC movement, line of sight ignored).
// Baker's stall is 2x2 and nearbyLocs reports its SW tile only (World.sceneType matches minTileX/minTileZ).
import { openBot, finish, countItems, sessionDied } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';

const RUN_TICKS = 300;
const SAFE = 6;
const DANGER = /^(baker|guard)$/i;
const STALL = /^baker'?s stall$/i;
const CAKE = /^cake$/i;
const BREAD = /^bread$/i;
const CHOC = /^chocolate slice$/i;

type Tile = { x: number; z: number };
const cheb = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const key = (t: Tile) => `${t.x},${t.z}`;

const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 5);
    const xp = () => s.sdk.getSkillXp('Thieving') ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const pos = (): Tile | null => { const p = s.sdk.getState()?.player; return p ? { x: p.worldX, z: p.worldZ } : null; };
    const food = () => ({ cake: countItems(s, CAKE), bread: countItems(s, BREAD), choc: countItems(s, CHOC) });
    const freeSlots = () => 28 - (s.sdk.getState()?.inventory ?? []).length;
    const xp0 = xp();
    const hp0 = hp();
    const f0 = food();
    const t0 = s.tick();
    const elapsed = () => s.tick() - t0;

    let hpMin = hp0;
    let died = false;
    // A death is the server's (sessionDied): a blank state in a disconnect reads HP 0 and no position.
    const life0 = (({ isDead, respawnCount, lifeId }: any = {}) => ({ isDead, respawnCount, lifeId }))(s.sdk.getState()?.player);
    const off = s.onTick(() => {
        const h = hp();
        hpMin = Math.min(hpMin, h);
        if (sessionDied(life0, s.sdk.getState()?.player)) died = true;
    });

    const dangers = (): Tile[] => (s.sdk.getState()?.nearbyNpcs ?? [])
        .filter((n: any) => DANGER.test(n.name))
        .map((n: any) => ({ x: n.tileX ?? n.x, z: n.tileZ ?? n.z }));
    const safe = (t: Tile) => dangers().every(d => cheb(d, t) > SAFE);
    // Stalls that offer the steal option now (a robbed stall turns into a market stall for 8 ticks).
    const stalls = () => (s.sdk.getState()?.nearbyLocs ?? [])
        .filter((l: any) => STALL.test(l.name) && (l.options ?? []).some((o: string) => /steal/i.test(o)));
    // Every 2x2 stall-like loc blocks its four tiles.
    const blocked = (): Set<string> => {
        const b = new Set<string>();
        for (const l of s.sdk.getState()?.nearbyLocs ?? []) {
            if (!/stall/i.test(l.name)) continue;
            for (const dx of [0, 1]) for (const dz of [0, 1]) b.add(key({ x: l.x + dx, z: l.z + dz }));
        }
        return b;
    };
    const sides = (o: Tile): Tile[] => [
        { x: o.x - 1, z: o.z }, { x: o.x - 1, z: o.z + 1 }, { x: o.x + 2, z: o.z }, { x: o.x + 2, z: o.z + 1 },
        { x: o.x, z: o.z - 1 }, { x: o.x + 1, z: o.z - 1 }, { x: o.x, z: o.z + 2 }, { x: o.x + 1, z: o.z + 2 },
    ];

    // Tiles the bot could not stand on, with the tick when they may be tried again.
    const badUntil = new Map<string, number>();
    let tries = 0, steals = 0, walks = 0, waits = 0, badWalks = 0;
    let lastFail = '';
    const total = () => { const f = food(); return (f.cake - f0.cake) + (f.bread - f0.bread) + (f.choc - f0.choc); };

    for (let i = 0; i < 2000 && elapsed() < RUN_TICKS && !died && hpMin >= hp0; i++) {
        if (freeSlots() <= 0) break;
        const me = pos();
        const open = stalls();
        if (!me || open.length === 0) { waits++; await waitTicks(s, 1); continue; }
        const b = blocked();
        const now = s.tick();
        const options: { tile: Tile; stall: any }[] = [];
        for (const st of open) {
            for (const t of sides({ x: st.x, z: st.z })) {
                if (b.has(key(t)) || (badUntil.get(key(t)) ?? 0) > now || !safe(t)) continue;
                options.push({ tile: t, stall: st });
            }
        }
        if (options.length === 0) { waits++; await waitTicks(s, 1); continue; }
        options.sort((a, c) => cheb(a.tile, me) - cheb(c.tile, me));
        const pick = options[0]!;

        if (cheb(pick.tile, me) > 0) {
            walks++;
            await s.bot.walkTo(pick.tile.x, pick.tile.z, 0, { timeout: 8000 });
            const p = pos();
            if (!p || cheb(p, pick.tile) > 0) {
                badWalks++;
                badUntil.set(key(pick.tile), s.tick() + 30);
            }
            continue; // Check the guards again from the new position.
        }

        // On a side tile that was safe this tick: steal.
        tries++;
        const before = total();
        const r = await s.bot.interactLoc(pick.stall, /steal/i);
        if (!r.success) lastFail = `${r.reason}:${r.message}`.slice(0, 60);
        const got = await waitUntil(s, () => total() > before, { timeoutTicks: 4 });
        if (got) steals++;
        else await waitTicks(s, 1);
    }
    off();

    const ticks = elapsed();
    const f = food();
    const cakes = f.cake - f0.cake, bread = f.bread - f0.bread, choc = f.choc - f0.choc;
    const n = cakes + bread + choc;
    console.log(`RATE thieving ${xp() - xp0} ${ticks}`);
    console.log(`FOOD ${cakes} ${bread} ${choc} ${ticks}`);
    const attacked = hpMin < hp0;
    const p = pos();
    const detail = `food=${n} cakes=${cakes} bread=${bread} choc=${choc} xp=${xp() - xp0} ticks=${ticks} hp0=${hp0} hpMin=${hpMin} `
        + `died=${died} tries=${tries} steals=${steals} walks=${walks} badWalks=${badWalks} waits=${waits} at=${p?.x},${p?.z}`;
    const ok = n >= 6 && !attacked && !died;
    const why = died ? 'died' : attacked ? 'attacked (hitpoints fell)' : `only ${n} food`;
    await finish([s], ok, ok ? detail : `${why} ${detail} last=${lastFail}`);
} catch (e) { await finish([s], false, String(e)); }
