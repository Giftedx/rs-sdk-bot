// Squad bank-standing inventory recipes: herb cleaning, unfinished/finished/decanted potions, and poison supplies.
import type { Template } from '../world';
import { MAKE_BATCH, UNF_POTIONS } from './constants';

export function invMake(
    id: string, recipe: string, item: string, level: number,
    inputs: Readonly<Record<string, number>>, tools: Readonly<Record<string, number>>,
    perTick = 0.1, goal = `make ${item} at the bank for the gang squad`, max = MAKE_BATCH,
    opts: { skill?: string; role?: string; members?: 0 | 1; strictOutput?: true; ownSupply?: readonly string[] } = {},
): Template {
    const argsFor = (n: number) => [recipe, `MAX_MAKE=${n}`, 'CAP=1500', `MEMBERS=${opts.members ?? 1}`, 'ORDER_MODE=best-effort'];
    const skill = opts.skill ?? 'Herblore', role = opts.role ?? 'herblore';
    return {
        id, family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts', args: argsFor(max), role,
        goal, resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        ...(opts.ownSupply ? { ownSupply: opts.ownSupply } : {}),
        needs: { skills: { [skill]: level }, items: { ...inputs, ...tools } },
        production: { output: item, outputPerUnit: 1, maximum: max, inputs, ...(opts.strictOutput ? { strictOutput: true as const } : {}), resize: n => ({ args: argsFor(n) }) },
        yields: () => [{ item, perTick }],
    };
}

export function squadHerbloreSupplies(): Template[] {
    // Herb cleaning templates feeding unfinished potion brewers.
    const cleanHerbs = ([
        ['guam', 'identify:guam_leaf', 'unidentified guam', 'guam leaf', 3],
        ['marentill', 'identify:marentill', 'unidentified marentill', 'marrentill', 5],
        ['tarromin', 'identify:tarromin', 'unidentified tarromin', 'tarromin', 11],
        ['harralander', 'identify:harralander', 'unidentified harralander', 'harralander', 20],
        ['ranarr', 'identify:ranarr_weed', 'unidentified ranarr', 'ranarr weed', 25],
        ['toadflax', 'identify:toadflax', 'unidentified toadflax', 'toadflax', 30],
        ['irit', 'identify:irit_leaf', 'unidentified irit', 'irit leaf', 40],
        ['avantoe', 'identify:avantoe', 'unidentified avantoe', 'avantoe', 48],
        ['kwuarm', 'identify:kwuarm', 'unidentified kwuarm', 'kwuarm', 54],
        ['snapdragon', 'identify:snapdragon', 'unidentified snapdragon', 'snapdragon', 59],
        ['cadantine', 'identify:cadantine', 'unidentified cadantine', 'cadantine', 65],
        ['lantadyme', 'identify:lantadyme', 'unidentified lantadyme', 'lantadyme', 67],
        ['dwarf-weed', 'identify:dwarf_weed', 'unidentified dwarf weed', 'dwarf weed', 70],
        ['torstol', 'identify:torstol', 'unidentified torstol', 'torstol', 75],
    ] as const).map(([slug, recipe, raw, clean, lvl]) =>
        invMake(`squad-identify-${slug}`, recipe, clean, lvl, { [raw]: 1 }, {}, 0.2, `identify banked ${raw} for squad potions`));
    const unfPotions = UNF_POTIONS.map(([herb, item, lvl]) =>
        invMake(`squad-unf-${herb.replace(' ', '-')}`, `brew:unf_${herb.replace(' ', '_')}_potion`, `${herb} potion (unf)`, lvl,
            { [item]: 1, 'vial of water': 1 }, {}, 0.15, `mix banked ${item} and vials of water into ${herb} potion (unf)`));
    const decantPotions = ([
        ['prayer_restore', 'prayer potion'],
        ['super_attack', 'super attack'],
        ['super_strength', 'super strength'],
        ['super_defense', 'super defence'],
        ['ranging_potion', 'ranging potion'],
        ['super_energy', 'super energy'],
        ['agility_potion', 'agility potion'],
        ['super_antipoison', 'superantipoison'],
        ['super_restore', 'super restore'],
        ['magic_potion', 'magic potion'],
        ['zamorak_potion', 'zamorak potion'],
        ['restore_potion', 'restore potion'],
    ] as const).flatMap(([slug, label]) => [
        invMake(`squad-decant-${slug}`, `decant:${slug}`, `${label}(4)`, 1, { [`${label}(3)`]: 2 }, {}, 0.3,
            `decant ${label}(3) doses into ${label}(4) at the bank`, MAKE_BATCH, { strictOutput: true, ownSupply: [`${label}(3)`] }),
        invMake(`squad-decant2-${slug}`, `decant2:${slug}`, `${label}(4)`, 1, { [`${label}(2)`]: 2 }, {}, 0.4,
            `decant ${label}(2) doses into ${label}(4) at the bank`, MAKE_BATCH, { ownSupply: [`${label}(2)`] }),
        invMake(`squad-decant31-${slug}`, `decant31:${slug}`, `${label}(4)`, 1, { [`${label}(3)`]: 1, [`${label}(1)`]: 1 }, {}, 0.4,
            `decant ${label}(3) and (1) doses into ${label}(4) at the bank`, MAKE_BATCH, { ownSupply: [`${label}(3)`, `${label}(1)`] }),
    ]);
    const poisonArrowsArgs = (units: number) => ['poison:rune-arrow', `MAX_MAKE=${units * 5}`, 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'];
    const poisonRuneArrows: Template = {
        id: 'squad-poison-rune-arrows', family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts',
        args: poisonArrowsArgs(MAKE_BATCH), role: 'herblore',
        goal: 'poison banked rune arrows with weapon poison at the bank for the gang squad',
        resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Herblore: 1 }, items: { 'rune arrow': 5, 'weapon poison': 1 } },
        production: {
            output: 'rune arrow(p)', outputPerUnit: 5, maximum: MAKE_BATCH,
            inputs: { 'rune arrow': 5, 'weapon poison': 1 },
            resize: n => ({ args: poisonArrowsArgs(n) }),
        },
        yields: () => [{ item: 'rune arrow(p)', perTick: 0.5 }],
    };
    return [
        ...cleanHerbs, ...unfPotions, ...decantPotions,
        invMake('squad-grind-unicorn-horn', 'grind:unicorn_horn', 'unicorn horn dust', 1, { 'unicorn horn': 1 }, { 'pestle and mortar': 1 }, 0.2),
        invMake('squad-grind-dragon-scale', 'grind:blue_dragon_scale', 'dragon scale dust', 1, { 'blue dragon scale': 1 }, { 'pestle and mortar': 1 }, 0.2),
        invMake('squad-grind-chocolate', 'grind:chocolate_bar', 'chocolate dust', 1, { 'chocolate bar': 1 }, { 'pestle and mortar': 1 }, 0.2,
            'grind banked chocolate bars into chocolate dust for potions and cakes'),
        invMake('squad-combine-crystal-key', 'combine:crystal-key', 'crystal key', 1, { keyhalf1: 1, keyhalf2: 1 }, {}, 0.2,
            'combine banked crystal key halves into crystal keys'),
        invMake('squad-strip-swamp-toad', 'strip:swamp-toad', "toad's leg", 1, { 'swamp toad': 1 }, {}, 0.2, "strip banked swamp toads into toad's legs"),
        invMake('squad-chocolate-cake', 'prepare:chocolate-cake', 'chocolate cake', 50, { cake: 1, 'chocolate bar': 1 }, {}, 0.15,
            'combine banked cakes and chocolate bars into chocolate cakes', MAKE_BATCH, { skill: 'Cooking', role: 'cooking', members: 0 }),
        invMake('squad-prayer-potion', 'brew:3doseprayerrestore', 'prayer potion(3)', 38, { 'ranarr potion (unf)': 1, 'snape grass': 1 }, {}),
        invMake('squad-super-attack', 'brew:3dose2attack', 'super attack(3)', 45, { 'irit potion (unf)': 1, 'eye of newt': 1 }, {}),
        invMake('squad-super-strength', 'brew:3dose2strength', 'super strength(3)', 55, { 'kwuarm potion (unf)': 1, 'limpwurt root': 1 }, {}),
        invMake('squad-super-defence', 'brew:3dose2defense', 'super defence(3)', 66, { 'cadantine potion (unf)': 1, 'white berrie': 1 }, {}),
        invMake('squad-ranging-potion', 'brew:3doserangerspotion', 'ranging potion(3)', 72, { 'dwarf weed potion (unf)': 1, 'wine of zamorak': 1 }, {}),
        invMake('squad-super-energy', 'brew:3dose2energy', 'super energy(3)', 52, { 'avantoe potion (unf)': 1, 'mort myre fungi': 1 }, {}),
        invMake('squad-agility-potion', 'brew:3dose1agility', 'agility potion(3)', 34, { 'toadflax potion (unf)': 1, "toad's leg": 1 }, {}),
        invMake('squad-super-restore', 'brew:3dose2restore', 'super restore(3)', 63, { 'snapdragon potion (unf)': 1, "red spiders' egg": 1 }, {}),
        invMake('squad-magic-potion', 'brew:3dose1magic', 'magic potion(3)', 76, { 'lantadyme potion (unf)': 1, 'potato cactu': 1 }, {}),
        invMake('squad-zamorak-potion', 'brew:3dosepotionofzamorak', 'zamorak potion(3)', 78, { 'torstol potion (unf)': 1, jangerberrie: 1 }, {}),
        invMake('squad-superantipoison', 'brew:3dose2antipoison', 'superantipoison(3)', 48, { 'irit potion (unf)': 1, 'unicorn horn dust': 1 }, {}),
        invMake('squad-antipoison-brew', 'brew:3doseantipoison', 'antipoison(3)', 5, { 'marrentill potion (unf)': 1, 'unicorn horn dust': 1 }, {}),
        invMake('squad-weapon-poison', 'brew:weapon_poison', 'weapon poison', 60, { 'kwuarm potion (unf)': 1, 'dragon scale dust': 1 }, {}),
        invMake('squad-poison-dds', 'poison:dragon-dagger', 'dragon dagger(p)', 1, { 'dragon dagger': 1, 'weapon poison': 1 }, {}),
        poisonRuneArrows,
    ];
}
