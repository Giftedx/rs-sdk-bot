import { runScript } from '../vendor/rs-sdk/sdk/runner';
import { WOODCUTTING_AXES_DESC, bestWoodcuttingAxe, readSkillLevels } from '../packages/planner/src/gear-progression';

// Phase 0 proof: equip best carried axe when Attack allows, chop 8 trees, drop the logs, report Woodcutting XP gained.
await runScript(async ({ bot, sdk }) => {
    const t0 = Date.now();
    const xp0 = sdk.getSkillXp('Woodcutting') ?? 0;
    const levels = readSkillLevels(sdk);
    const inv = sdk.getInventory();
    const eq = sdk.getEquipment();
    const rec = bestWoodcuttingAxe([...inv, ...eq.filter(e => e.slot === 3)], levels).current;
    if (rec && rec.canWield && !eq.some(e => e.slot === 3 && e.id === rec.item.id)) {
        const weapon = eq.find(e => e.slot === 3);
        if (!weapon || (WOODCUTTING_AXES_DESC as readonly number[]).includes(weapon.id)) {
            const held = inv.find(i => i.id === rec.item.id);
            if (held) await bot.equipItem(held);
        }
    }
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
