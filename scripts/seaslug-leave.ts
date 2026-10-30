// Brings an account that Sea Slug left on the fishing platform or the island back to the Witchaven shore.
// Holgart on the platform takes stage 4 (spoken_kennith) to the island, not to shore (holgart_platform.rs2:2-5).
// On the island Kent sets stage 6 (kent.rs2), and only then does Holgart row back to the platform
// (holgart_island.rs2:1-7). At any other stage Holgart on the platform offers "Okay, let's go back." to shore.
// Usage: bun scripts/seaslug-leave.ts <account>
import { openQuest } from './generated/quest-lib';

const PLATFORM = { x: 2782, z: 3273 }, ISLAND = { x: 2800, z: 3320 }, SHORE = { x: 2722, z: 3305 };

const q = await openQuest({ cap: 600, eatAt: 40 });
try {
    for (let i = 0; i < 3 && !q.near(SHORE.x, SHORE.z, 12); i++) {
        if (q.near(ISLAND.x, ISLAND.z, 20)) {
            await q.talk('kent', /^kent$/i, [], () => q.sawText(/thanks kent/i) || q.sawText(/please go back and get my boy/i), { x: 2793, z: 3321 }, 60);
            await q.converse([], () => !q.dialogOpen(), 20);
            await q.talk('holgart island', /^holgart$/i, [], () => q.near(PLATFORM.x, PLATFORM.z, 6), ISLAND, 40);
            await q.converse([], () => !q.dialogOpen(), 10);
        } else if (q.near(PLATFORM.x, PLATFORM.z, 25)) {
            await q.talk('holgart platform', /^holgart$/i, [/okay, let'?s go back/i], () => q.near(SHORE.x, SHORE.z, 6) || q.near(ISLAND.x, ISLAND.z, 8), PLATFORM, 40);
            await q.converse([], () => !q.dialogOpen(), 10);
        } else break;
    }
    await q.end(q.near(SHORE.x, SHORE.z, 12), 'seaslug-leave');
} catch (e) { await q.fail(String(e)); }
