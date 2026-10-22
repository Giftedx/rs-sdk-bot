// Measure one gathering method for a fixed number of game ticks, then print `RATE <skill> <xp> <ticks>`.
// Usage: bun scripts/measure/gather.ts <bot> <method> <ticks>. Products are dropped when the pack fills.
// Spots come from vendor/rs-sdk/learnings (woodcutting.md, mining.md, fishing.md) via the measure_* presets.
import { openBot, finish } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';

// Power-mine without walking: click the nearest matching rock within 2 tiles, then wait up to 6 ticks for ore.
function mineNear(re: RegExp) {
    return async (s: any) => {
        const rock = (s.sdk.getState()?.nearbyLocs ?? [])
            .filter((l: any) => re.test(l.name) && l.distance <= 2 && l.optionsWithIndex.some((o: any) => /^mine$/i.test(o.text)))
            .sort((a: any, b: any) => a.distance - b.distance)[0];
        if (!rock) {
            await waitTicks(s, 1);
            const seen = (s.sdk.getState()?.nearbyLocs ?? []).filter((l: any) => re.test(l.name)).slice(0, 6).map((l: any) => `${l.x},${l.z}`).join(' ');
            return { success: false, message: `no rock in reach; seen ${seen}` };
        }
        const n0 = (s.sdk.getState()?.inventory ?? []).length;
        await s.sdk.sendInteractLoc(rock.x, rock.z, rock.id, rock.optionsWithIndex.find((o: any) => /^mine$/i.test(o.text)).opIndex);
        for (let i = 0; i < 6; i++) {
            await waitTicks(s, 1);
            if ((s.sdk.getState()?.inventory ?? []).length > n0) return { success: true, message: 'ore' };
        }
        return { success: false, message: 'no ore in 6 ticks' };
    };
}

const METHODS: Record<string, { skill: string; act: (s: any) => Promise<unknown>; product: RegExp }> = {
    irondirect: { skill: 'Mining', act: mineNear(/iron/i), product: /iron ore/i },
    trees: { skill: 'Woodcutting', act: s => s.bot.chopTree(/^tree$/i), product: /^logs$/i },
    oaks: { skill: 'Woodcutting', act: s => s.bot.chopTree(/^oak$/i), product: /^oak logs$/i },
    copper: { skill: 'Mining', act: s => s.bot.mineRock(/copper/i), product: /copper ore/i },
    iron: { skill: 'Mining', act: s => s.bot.mineRock(/iron/i), product: /iron ore/i },
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
    // Preset stats arrive a few ticks after START (thieving guard/knight rates were inflated by this).
    await waitTicks(s, 5);
    const xp0 = xp();
    const t0 = s.tick();
    let nextLog = 0;
    while (s.tick() - t0 < budget) {
        if ((s.sdk.getState()?.inventory?.length ?? 0) >= 27) await s.bot.dropItem(m.product, 'all');
        // An SDK call can wait forever (seen: mineRock with every iron rock mined out). Bound each one.
        const r: any = await Promise.race([m.act(s), waitTicks(s, 30).then(() => ({ success: false, message: "act timeout 30 ticks" }))]);
        if (s.tick() - t0 >= nextLog) { console.log(`WARN progress t=${s.tick() - t0} lvl=${s.sdk.getSkill(m.skill)?.baseLevel} inv=${(s.sdk.getState()?.inventory ?? []).map((i: any) => i.name).join(",").slice(0, 60)} xp=${xp() - xp0} last=${r?.success}:${String(r?.message ?? '').slice(0, 80)}`); nextLog += 100; }
    }
    const gained = xp() - xp0;
    const ticks = s.tick() - t0;
    console.log(`RATE ${m.skill.toLowerCase()} ${gained} ${ticks}`);
    await finish([s], gained > 0, `${methodId} xp0=${xp0} xp=${gained} ticks=${ticks}`);
} catch (e) { await finish([s], false, String(e)); }
