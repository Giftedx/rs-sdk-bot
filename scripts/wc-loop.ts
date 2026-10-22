import { runScript } from '../vendor/rs-sdk/sdk/runner';

// Phase 0 proof: chop 8 trees, drop the logs, report Woodcutting XP gained.
await runScript(async ({ bot, sdk }) => {
    const t0 = Date.now();
    const xp0 = sdk.getSkillXp('Woodcutting') ?? 0;
    let chops = 0;
    for (let i = 0; i < 8; i++) {
        const r = await bot.chopTree(/^tree$/i);
        if (r.success) chops++;
        else console.log(`chop ${i + 1} failed: ${r.message ?? ''}`);
        await bot.dropItem(/logs/i, 'all');
    }
    const xp1 = sdk.getSkillXp('Woodcutting') ?? 0;
    console.log(`RESULT chops=${chops} wcXpGained=${xp1 - xp0} seconds=${((Date.now() - t0) / 1000).toFixed(1)}`);
}, { timeout: 240_000 });
