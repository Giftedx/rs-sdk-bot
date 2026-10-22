// Measure one gathering method for a fixed number of game ticks, then print `RATE <skill> <xp> <ticks>`.
// Usage: bun scripts/measure/gather.ts <bot> <method> <ticks>. Products are dropped when the pack fills.
// Spots come from vendor/rs-sdk/learnings (woodcutting.md, mining.md, fishing.md) via the measure_* presets.
import { openBot, finish } from '../../packages/core/src/bot';

const METHODS: Record<string, { skill: string; act: (s: any) => Promise<unknown>; product: RegExp }> = {
    trees: { skill: 'Woodcutting', act: s => s.bot.chopTree(/^tree$/i), product: /^logs$/i },
    oaks: { skill: 'Woodcutting', act: s => s.bot.chopTree(/^oak$/i), product: /^oak logs$/i },
    copper: { skill: 'Mining', act: s => s.bot.mineRock(/copper/i), product: /copper ore/i },
    tin: { skill: 'Mining', act: s => s.bot.mineRock(/tin/i), product: /tin ore/i },
    shrimp: { skill: 'Fishing', act: s => s.bot.interactNpc(/fishing spot/i, 'Net'), product: /raw shrimps|raw anchovies/i },
};

const [name, methodId, ticksArg] = process.argv.slice(2);
const m = METHODS[methodId!];
if (!m) { console.log(`RESULT fail unknown method ${methodId}`); process.exit(1); }
const budget = Number(ticksArg ?? 600);
const s = await openBot(name!);
try {
    const xp = () => s.sdk.getSkillXp(m.skill) ?? 0;
    const xp0 = xp();
    const t0 = s.tick();
    while (s.tick() - t0 < budget) {
        if ((s.sdk.getState()?.inventory?.length ?? 0) >= 27) await s.bot.dropItem(m.product, 'all');
        await m.act(s);
    }
    const gained = xp() - xp0;
    const ticks = s.tick() - t0;
    console.log(`RATE ${m.skill.toLowerCase()} ${gained} ${ticks}`);
    await finish([s], gained > 0, `${methodId} xp=${gained} ticks=${ticks}`);
} catch (e) { await finish([s], false, String(e)); }
