// Magic teleport ladder (planner row magic-teleport, MAGIC_TELEPORT_TIERS in packages/planner/src/haggis.ts):
// wind strike 1-25 on a chicken, then the best teleport the level allows (Varrock 25, Lumbridge 31, Falador 37,
// Camelot 45), staff of air worn so air runes are free. No bank trips.
// Usage: RANDOM_EVENTS=0 bun scripts/measure/floor-teleport.ts <bot> [capTicks=3000] [stopLevel=99]
// Presets: floor_tele1 (Magic 1 at the Lumbridge chicken pen), floor_tele25, floor_tele45, floor_tele80.
// Mechanism (code-read): teleport.rs2:9-48 runs only when p_finduid succeeds (not while the player is delayed),
// then player_teleport_normal p_delay(1) + p_delay(0) and the jump. A click sent while delayed is a no-op, so the
// script sends one click every tick and the server takes the first one it can. Wind strike: player_magic.rs2:188
// sets %action_delay = clock + 5, so a strike lands every 5 ticks; the script re-sends the cast every tick.
import { openBot, finish } from '../../packages/core/src/bot';
import { componentId } from '../../packages/core/src/logout';
import { meter, send, tick, xp, level, report, band, dialogOpen } from './floor-lib';

const [bot, capArg, stopArg] = process.argv.slice(2);
const CAP = Number(capArg ?? 3000);
const STOP = Number(stopArg ?? 99);
const TELES = [
    { level: 45, name: 'camelot', comp: 'magic:camelot_teleport' },
    { level: 37, name: 'falador', comp: 'magic:falador_teleport' },
    { level: 31, name: 'lumbridge', comp: 'magic:lumbridge_teleport' },
    { level: 25, name: 'varrock', comp: 'magic:varrock_teleport' },
];
const STRIKE = componentId('magic:wind_strike');
const s = await openBot(bot!);
try {
    await tick(s, 3);
    const m = meter(s, 'Magic');
    const t0 = s.tick();
    const lvl0 = level(s, 'Magic');
    console.log(`START Magic ${lvl0} xp=${xp(s, 'Magic')}`);
    let casts = 0, last = xp(s, 'Magic'), lastT = s.tick(), curLvl = lvl0;
    let lastBand = '';
    const levelAt: Record<number, number> = {};
    while (s.tick() - t0 < CAP && level(s, 'Magic') < STOP) {
        const L = level(s, 'Magic');
        if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
        let bandName: string;
        if (L < 25) {
            bandName = 'wind strike';
            const npcs = (s.sdk.getState()?.nearbyNpcs ?? []) as any[];
            const c = npcs.filter(n => /^chicken$/i.test(n.name)).sort((a, b) => a.distance - b.distance)[0];
            if (c) await send(s, m, { type: 'spellOnNpc', npcIndex: c.index, spellComponent: STRIKE });
        } else {
            const t = TELES.find(x => L >= x.level)!;
            bandName = `${t.name} teleport`;
            await send(s, m, { type: 'clickComponent', componentId: componentId(t.comp) });
        }
        lastBand = bandName;
        await tick(s);
        const x = xp(s, 'Magic');
        if (x > last) { casts++; band(m, bandName, x - last, s.tick() - lastT, 1); m.actions++; last = x; lastT = s.tick(); }
        const nl = level(s, 'Magic');
        if (nl > curLvl) { for (let q = curLvl + 1; q <= nl; q++) levelAt[q] = s.tick() - t0; curLvl = nl; console.log(`LEVELUP Magic ${nl} at ${s.tick() - t0} xp=${x}`); }
        if (s.tick() - lastT > 40) { console.log(`WARN no XP for 40 ticks at Magic ${nl} band=${lastBand}`); break; }
    }
    const ticks = s.tick() - t0;
    const line = report(s, m, `casts=${casts} start=${lvl0} cap=${CAP} ticksPerCast=${(ticks / Math.max(1, casts)).toFixed(2)}`);
    await finish([s], casts > 0, line);
} catch (e) { await finish([s], false, String(e)); }
