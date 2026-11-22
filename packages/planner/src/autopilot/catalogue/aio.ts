// Fleet quest-demand sweeps (`questDemand`) and AIO skiller/quest route templates (`aioTemplates`).
import { AIO_PLACES, QUEST_DEMAND, QUEST_DEMAND_BAND, QUEST_DEMAND_ROWS, questResource, type Needs, type Template } from '../world';
import { AXES, BLOOD_FOOD, BLOOD_MEALS, CANNON_BARS, GEM_RINGS, MAKE_BATCH, PICKAXES, RING_BATCH, SWEEP_MEALS, UNF_POTIONS } from './constants';

const BOWSTRING_BATCH = 56, SHAFT_LOGS = 25, BLOOD_LOOTS = 6;

// One sweep job for each quest of QUEST_DEMAND_ROWS, run through the AIO route `quester:quest:<slug>`.
export function questDemand(): Template[] {
    return QUEST_DEMAND_ROWS.map((q, i): Template => ({
        id: `quest-${q.slug}`, family: `aio:quester:quest:${q.slug}`, script: 'scripts/aio.ts', args: ['quester', 'sweep', q.slug], aio: `quester:quest:${q.slug}`,
        worker: 'scripts/quest-sweep.ts', pilot: true, once: true, role: 'quest', goal: `complete ${q.name} once for the quest board`, tier: 'goal',
        ...(q.wilderness ? { wilderness: true as const } : {}),
        band: QUEST_DEMAND_BAND + i / 100, quest: { name: q.name, unlocks: [] }, resources: [questResource(q.slug), QUEST_DEMAND], yields: () => [],
        needs: { ...(Object.keys(q.skills).length ? { skills: q.skills } : {}), ...(q.quests.length ? { quests: q.quests } : {}), ...(q.questPoints ? { questPoints: q.questPoints } : {}),
            ...(Object.keys(q.items).length ? { items: q.items } : {}), ...(q.meals ? { pieces: { of: SWEEP_MEALS, count: q.meals } } : {}) },
        kitFirst: true,
    }));
}

export function aioTemplates(): Template[] {
    const aio = (id: string, key: string, worker: string, args: string[], rest: Omit<Template, 'id' | 'family' | 'script' | 'args' | 'aio' | 'worker' | 'pilot'>): Template =>
        ({ id, family: `aio:${key}`, script: 'scripts/aio.ts', args: [key.split(':')[0]!, ...args], aio: key, worker, pilot: true, ...rest });
    const essence = aio('aio-essence', 'skiller:mining:essence', 'scripts/gather-essence.ts', ['mining', 'essence', 'CAP=1800', 'BANK_AT=28'], {
        role: 'mining', goal: 'mine rune essence through Aubury and bank it at Varrock East', resources: [AIO_PLACES.essence],
        needs: { quests: ['Rune Mysteries Quest'], pieces: { of: PICKAXES, count: 1 } }, yields: () => [{ item: 'rune essence', perTick: 0.03 }] });
    // `load`: the bars of one pack load, which `needs` asks the ore and the coal for.
    const bars = (bar: string, level: number, ore: string, coal: number, load: number, perTick: number) =>
        aio(`aio-${bar}-bars`, 'skiller:smithing:smelt', 'scripts/smelt-bars.ts', ['smithing', 'smelt', '1500', bar, 'MAX_MAKE=28', 'ORE_RESERVE=0'], {
            role: 'smithing', goal: `smelt banked ${ore}${coal ? ' and coal' : ''} into ${bar} bars at Al Kharid`,
            repeats: false, production: { output: `${bar} bar`, outputPerUnit: 1, maximum: 28, inputs: { [ore]: 1, ...coal ? { coal } : {} },
                resize: n => ({ args: ['skiller', 'smithing', 'smelt', '1500', bar, `MAX_MAKE=${n}`, 'ORE_RESERVE=0'] }) },
            needs: { skills: { Smithing: level }, items: { [ore]: load, ...(coal ? { coal: coal * load } : {}) } }, yields: () => [{ item: `${bar} bar`, perTick }] });
    // One recipe of the bank-standing worker, up to MAKE_BATCH units of what the bank holds.
    const make = (id: string, recipe: string, goal: string, role: string, needs: Needs, item: string, consumed: Record<string, number> = needs.items ?? {}) =>
        aio(id, 'skiller:crafting:inventory', 'scripts/microbot-production.ts', ['crafting', 'inventory', recipe, `MAX_MAKE=${MAKE_BATCH}`, 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'], {
            role, goal, needs, repeats: false, production: { output: item, outputPerUnit: 1, maximum: MAKE_BATCH, inputs: consumed,
                resize: n => ({ args: ['skiller', 'crafting', 'inventory', recipe, `MAX_MAKE=${n}`, 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'] }) }, yields: () => [{ item, perTick: 0.1 }] });
    const potions = UNF_POTIONS.map(([herb, item, level]) => make(`aio-unf-${herb.replace(' ', '-')}`, `brew:unf_${herb.replace(' ', '_')}_potion`,
        `mix banked ${item} and vials of water into unfinished ${herb} potions`, 'herblore', { skills: { Herblore: level }, items: { [item]: 1, 'vial of water': 1 } }, `${herb} potion (unf)`));
    const dust = (id: string, raw: string, item: string) => make(id, `grind:${raw.replace(/ /g, '_')}`, `grind banked ${raw}s into ${item}`, 'herblore', { items: { 'pestle and mortar': 1, [raw]: 1 } }, item, { [raw]: 1 });
    const rings = GEM_RINGS.map(([gem, level]) => aio(`aio-${gem}-rings`, 'skiller:crafting:jewellery-trip', 'scripts/microbot-jewellery-trip.ts',
        ['crafting', 'jewellery-trip', `RECIPE=${gem}_ring`, `TARGET=${RING_BATCH}`, `BATCH=${RING_BATCH}`, 'CAP=1500'], {
            role: 'crafting', goal: `make ${RING_BATCH} ${gem} rings from banked gold bars and gems at the Al Kharid furnace`,
            repeats: false, production: { output: `${gem} ring`, outputPerUnit: 1, maximum: RING_BATCH, inputs: { 'gold bar': 1, [gem]: 1 },
                resize: n => ({ args: ['skiller', 'crafting', 'jewellery-trip', `RECIPE=${gem}_ring`, `TARGET=${n}`, `BATCH=${n}`, 'CAP=1500'] }) },
            needs: { skills: { Crafting: level }, items: { 'ring mould': 1, 'gold bar': RING_BATCH, [gem]: RING_BATCH } },
            yields: () => [{ item: `${gem} ring`, perTick: 0.05 }] }));
    return [
        aio('aio-flax', 'skiller:foraging:flax', 'scripts/gather-flax.ts', ['foraging', 'flax', '1800', '28'], {
            role: 'crafting', goal: 'pick flax at Seers and bank it', resources: [AIO_PLACES.flax], yields: () => [{ item: 'flax', perTick: 0.18 }] }),
        aio('aio-bowstrings', 'skiller:crafting:bowstrings', 'scripts/spin-bowstrings.ts', ['crafting', 'bowstrings', '1250', `MAX_MAKE=${BOWSTRING_BATCH}`, 'RAW_RESERVE=0', 'MAX_TRIPS=4'], {
            role: 'crafting', goal: `spin ${BOWSTRING_BATCH} banked flax into bow strings at Seers`, needs: { skills: { Crafting: 10 }, items: { flax: BOWSTRING_BATCH } },
            repeats: false, production: { output: 'bow string', outputPerUnit: 1, maximum: BOWSTRING_BATCH, inputs: { flax: 1 }, resize: n => ({ args: ['skiller', 'crafting', 'bowstrings', '1250', `MAX_MAKE=${n}`, 'RAW_RESERVE=0', 'MAX_TRIPS=4'] }) },
            yields: () => [{ item: 'bow string', perTick: 0.12 }] }),
        aio('aio-yews', 'skiller:woodcutting:yews', 'scripts/gather-yews.ts', ['woodcutting', 'yews', '1800', '27', 'MAX_TRIPS=4'], {
            role: 'woodcutting', goal: 'cut yew logs at Seers and bank them', resources: [AIO_PLACES.yews],
            needs: { skills: { Woodcutting: 60 }, pieces: { of: AXES, count: 1 } }, yields: () => [{ item: 'yew logs', perTick: 0.018 }] }),
        aio('aio-shafts', 'skiller:fletching:shafts', 'scripts/fletch-arrows.ts', ['fletching', 'shafts', '600', `MAX_MAKE=${SHAFT_LOGS}`, 'LOG_RESERVE=0'], {
            role: 'fletching', goal: `cut ${SHAFT_LOGS} banked logs into arrow shafts`, needs: { items: { knife: 1, logs: SHAFT_LOGS } },
            repeats: false, production: { output: 'arrow shaft', outputPerUnit: 15, maximum: SHAFT_LOGS, inputs: { logs: 1 }, resize: n => ({ args: ['skiller', 'fletching', 'shafts', '600', `MAX_MAKE=${n}`, 'LOG_RESERVE=0'] }) },
            yields: () => [{ item: 'arrow shaft', perTick: 1 }] }),
        aio('aio-ore', 'skiller:mining:ore', 'scripts/gather-ore.ts', ['mining', 'ore', '1800', '25', 'MAX_TRIPS=3'], {
            role: 'mining', goal: 'mine ore at Varrock East and bank three loads', resources: [AIO_PLACES.ore],
            needs: { combat: 13, pieces: { of: PICKAXES, count: 1 } },
            // Iron from Mining 15; copper and tin before it.
            yields: a => (a.skills.Mining ?? 1) >= 15 ? [{ item: 'iron ore', perTick: 0.064 }] : [{ item: 'copper ore', perTick: 0.032 }, { item: 'tin ore', perTick: 0.032 }] }),
        essence,
        aio('aio-air-runes', 'skiller:runecraft:bank-craft', 'scripts/rune-bank-craft.ts', ['runecraft', 'bank-craft', '99', 'RUNE_ALTAR=air', 'ESSENCE_TARGET=28', 'CAP=4000'], {
            role: 'magic', goal: 'craft 28 banked rune essence into air runes', resources: [AIO_PLACES.air],
            needs: { items: { 'air talisman': 1, 'rune essence': 28 } }, yields: () => [{ item: 'air rune', perTick: 0.09 }] }),
        bars('runite', 85, 'runite ore', 8, 2, 0.06),
        bars('adamantite', 70, 'adamantite ore', 6, 4, 0.07),
        bars('mithril', 50, 'mithril ore', 4, 5, 0.08),
        bars('iron', 15, 'iron ore', 0, 28, 0.074),
        bars('steel', 30, 'iron ore', 2, 9, 0.1),
        aio('aio-cannonballs', 'skiller:smithing:cannonballs', 'scripts/microbot-a-cannonballs.ts', ['smithing', 'cannonballs', String(CANNON_BARS), '1500', 'CANNON_XP_RATE=25'], {
            role: 'smithing', goal: `cast ${CANNON_BARS} banked steel bars into cannonballs at Al Kharid`,
            repeats: false, production: { output: 'cannonball', outputPerUnit: 4, maximum: CANNON_BARS, inputs: { 'steel bar': 1 }, resize: n => ({ args: ['skiller', 'smithing', 'cannonballs', String(n), '1500', 'CANNON_XP_RATE=25'] }) },
            needs: { skills: { Smithing: 35 }, items: { 'ammo mould': 1, 'steel bar': CANNON_BARS } }, yields: () => [{ item: 'cannonball', perTick: 0.2 }] }),
        aio('aio-rune-scimitars', 'skiller:smithing:anvil', 'scripts/smelt-bars.ts', ['smithing', 'anvil', '1500', 'PRODUCT_ID=1333', 'MAX_MAKE=1', 'BAR_RESERVE=0'], {
            role: 'smithing', goal: 'smith a rune scimitar from two banked runite bars at the Varrock West anvils',
            repeats: false, production: { output: 'rune scimitar', outputPerUnit: 1, maximum: 1, inputs: { 'runite bar': 2 }, resize: () => ({ args: ['skiller', 'smithing', 'anvil', '1500', 'PRODUCT_ID=1333', 'MAX_MAKE=1', 'BAR_RESERVE=0'] }) },
            needs: { skills: { Smithing: 90 }, items: { hammer: 1, 'runite bar': 2, coins: 10 } }, yields: () => [{ item: 'rune scimitar', perTick: 0.003 }] }),
        aio('aio-rune-axe', 'skiller:smithing:anvil', 'scripts/smelt-bars.ts', ['smithing', 'anvil', '1500', 'PRODUCT_ID=1359', 'MAX_MAKE=1', 'BAR_RESERVE=0'], {
            role: 'smithing', goal: 'smith a rune axe from a banked runite bar at the Varrock West anvils',
            repeats: false, production: { output: 'rune axe', outputPerUnit: 1, maximum: 1, inputs: { 'runite bar': 1 }, resize: () => ({ args: ['skiller', 'smithing', 'anvil', '1500', 'PRODUCT_ID=1359', 'MAX_MAKE=1', 'BAR_RESERVE=0'] }) },
            needs: { skills: { Smithing: 86 }, items: { hammer: 1, 'runite bar': 1, coins: 10 }, holdsUnder: { 'rune axe': 1 } }, yields: () => [{ item: 'rune axe', perTick: 0.003 }] }),
        ...potions,
        dust('aio-unicorn-horn-dust', 'unicorn horn', 'unicorn horn dust'),
        dust('aio-dragon-scale-dust', 'blue dragon scale', 'dragon scale dust'),
        ...rings,
        aio('aio-blood-chest', 'skiller:thieving:blood-chest', 'scripts/blood-chest.ts', ['thieving', 'blood-chest', '4000', `MAX_LOOTS=${BLOOD_LOOTS}`, 'CAP=4000'], {
            role: 'thieving', goal: `loot the Ardougne blood rune chests ${BLOOD_LOOTS} times and bank the runes`, resources: [AIO_PLACES.blood],
            needs: { skills: { Thieving: 59 }, pieces: { of: BLOOD_FOOD, count: BLOOD_MEALS } },
            yields: () => [{ item: 'blood rune', perTick: 0.01 }, { item: 'coins', perTick: 2.5 }] }),
        aio('aio-quest-runemysteries', 'quester:mode:sweep', 'scripts/quest-sweep.ts', ['sweep', 'runemysteries'], {
            role: 'quest', goal: 'complete Rune Mysteries for the essence mine', quest: { name: 'Rune Mysteries Quest', unlocks: [essence.id] },
            needs: { items: { 'law rune': 2, 'air rune': 6, 'fire rune': 1, 'earth rune': 1 }, pieces: { of: SWEEP_MEALS, count: 4 } }, yields: () => [] }),
    ];
}
