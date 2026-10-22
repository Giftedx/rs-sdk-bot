// Proven script 1: chop 5 logs. Preset wc_lumbridge (3224,3245,0, bronze axe).
import { openBot, finish, countItems } from '../../packages/core/src/bot';

const s = await openBot(process.argv[2]!);
try {
    for (let i = 0; i < 12 && countItems(s, /^logs$/i) < 5; i++) await s.bot.chopTree(/^tree$/i);
    const n = countItems(s, /^logs$/i);
    await finish([s], n >= 5, `logs=${n} ticks=${s.tick()}`);
} catch (e) { await finish([s], false, String(e)); }
