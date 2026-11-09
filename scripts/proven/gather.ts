// Proven script 1: chop 5 logs. Preset wc_lumbridge (3224,3245,0, bronze axe).
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';

const s = await openBot(process.argv[2]!);
try {
    const why: Record<string, number> = {};
    const t0 = s.tick();
    // Bounded by ticks, not tries: back-to-back runs (seen) start with the nearby trees still felled,
    // and "No tree found" returns at once. Wait for a respawn instead of burning the loop.
    while (countItems(s, /^logs$/i) < 5 && s.tick() - t0 < 400) {
        const r: any = await s.bot.chopTree(/^tree$/i);
        if (r?.success) continue;
        const k = String(r?.message ?? r?.reason).slice(0, 40);
        why[k] = (why[k] ?? 0) + 1;
        if (/no tree/i.test(k)) await waitTicks(s, 5);
    }
    const n = countItems(s, /^logs$/i);
    await finish([s], n >= 5, `logs=${n} ticks=${s.tick() - t0}${Object.keys(why).length ? ` fails=${JSON.stringify(why)}` : ''}`);
} catch (e) { await finish([s], false, String(e)); }
