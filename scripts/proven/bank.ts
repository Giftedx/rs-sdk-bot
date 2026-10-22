// Proven script 2: chop 5 logs near Draynor, walk to Draynor bank (3092,3243 per vendor/rs-sdk/learnings/walking.md),
// deposit them, and check the bank holds 5 more logs. Preset bank_draynor (3092,3247,0, bronze axe).
import { openBot, finish, getWorld, accountOf, countItems } from '../../packages/core/src/bot';
import { goTo } from '../../packages/core/src/walk';

const s = await openBot(process.argv[2]!);
try {
    for (let i = 0; i < 15 && countItems(s, /^logs$/i) < 5; i++) {
        const r = await s.bot.chopTree(/^tree$/i);
        if (!r.success && i % 3 === 2) await s.bot.walkTo(3087, 3262, 4); // more trees north of the bank
    }
    const logs = countItems(s, /^logs$/i);
    if (logs < 5) await finish([s], false, `only ${logs} logs`);
    const walk = await goTo(s as any, await getWorld(), { x: 3092, z: 3243, level: 0 }, accountOf(s));
    if (!walk.ok) await finish([s], false, `walk to bank: ${JSON.stringify(walk)}`);
    const open = await s.bot.openBank();
    if (!open.success) await finish([s], false, `openBank: ${open.message}`);
    const before = s.sdk.getBankItems().filter(b => /^logs$/i.test(b.name)).reduce((n, b) => n + b.count, 0);
    const dep = await s.bot.depositItem(/^logs$/i, -1);
    const after = s.sdk.getBankItems().filter(b => /^logs$/i.test(b.name)).reduce((n, b) => n + b.count, 0);
    await finish([s], dep.success && after - before === logs, `bank logs ${before} -> ${after}, walked ${walk.ticks}t`);
} catch (e) { await finish([s], false, String(e)); }
