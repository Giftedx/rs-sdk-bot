// Pure recipe/table readers shared by packages/brain/src/catalog.ts and bank-artisan workers without pulling in SDK/bot/walk runtime code.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { objId } from '../../../core/src/content-facts';
import { parseConfigs } from '../../../knowledge/src/config';
import { CONTENT_DIR, KNOWLEDGE_DIR, packMap, parsePackNameToId } from './catalog';

// ---- Cooking recipes ----

const cookItemIdOf = (name: string) => {
    const n = packMap('obj').get(name);
    if (n === undefined) throw Error('unknown native cook item ' + name);
    return n;
};

export type Heat = 'range' | 'fire';
export interface CookRecipe {
    name: string;
    raw: number;
    products: number[];
    burnt?: number;
    additional?: number;
    noAdditionalSuccess: boolean;
    level: number;
    xp: number;
    range: boolean;
    fire: boolean;
    karambwanChoice?: 1 | 2;
    source: string;
}

let cachedCookingRecipes: { recipes: CookRecipe[]; blocked: { name: string; reason: string }[] } | undefined;

export function cookingRecipes() {
    if (cachedCookingRecipes) return cachedCookingRecipes;
    const file = 'scripts/skill_cooking/configs/cooking_source/cooking_generic.dbrow';
    const text = readFileSync(resolve(CONTENT_DIR, file), 'utf8');
    const recipes: CookRecipe[] = [];
    const blocked: { name: string; reason: string }[] = [];
    for (const m of text.matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)) {
        const name = m[1]!;
        const body = m[2]!;
        const field = (k: string) => body.match(new RegExp('^data=' + k + ',(.+)$', 'm'))?.[1]?.trim();
        const raw = field('uncooked');
        const product = field('cooked');
        if (!raw || !product || product === 'null') {
            blocked.push({ name, reason: 'Native table forbids this raw item on both heat sources; raw oomlie requires wrapping.' });
            continue;
        }
        if (raw === product) {
            blocked.push({ name, reason: 'Native no-op reheats bones without XP or changed item; not a useful production conversion.' });
            continue;
        }
        let products = [cookItemIdOf(product)];
        const dynamic: Record<string, [string, string]> = {
            half_baked_batta: ['gnome_battas.rs2', 'gnome_batta'],
            half_baked_bowl: ['gnome_bowls.rs2', 'gnome_bowl'],
            half_baked_crunchy: ['gnome_crunchies.rs2', 'gnome_crunchies'],
        };
        if (dynamic[raw]) {
            const [dfile, proc] = dynamic[raw]!;
            const source = readFileSync(resolve(CONTENT_DIR, 'scripts/skill_cooking/scripts/gnome_cooking', dfile), 'utf8')
                .split(`[proc,${proc}]`)[1]
                ?.split('[proc,')[0] ?? '';
            products = [...new Set([...source.matchAll(/return\(([^)]+)\)/g)].map(x => cookItemIdOf(x[1]!.trim())))];
            if (!products.length) throw Error('native dynamic gnome products missing');
        }
        const optional = (v: string | undefined) => (v && v !== 'null' ? cookItemIdOf(v) : undefined);
        recipes.push({
            name,
            raw: cookItemIdOf(raw),
            products,
            burnt: field('successchance') === '1,1' ? undefined : optional(field('burnt')),
            additional: optional(field('additional')),
            noAdditionalSuccess: ['half_baked_batta', 'half_baked_bowl', 'half_baked_crunchy'].includes(product),
            level: Number(field('levelrequired') ?? 0),
            xp: Number(field('experience') ?? 0),
            range: !field('cantcookmessage_range'),
            fire: !field('cantcookmessage_fire'),
            ...(raw === 'tbwt_raw_karambwan' ? { karambwanChoice: product === 'tbwt_cooked_karambwan' ? (2 as const) : (1 as const) } : {}),
            source: 'vendor/rs-sdk/server/content/' + file,
        });
    }
    cachedCookingRecipes = { recipes, blocked };
    return cachedCookingRecipes;
}

export const DEFAULT_FOOD_TYPE = 'lobster';

export function foodRecipe(foodType: string): CookRecipe | undefined {
    const key = foodType.trim().toLowerCase();
    const { recipes } = cookingRecipes();
    const exact = recipes.find(r => r.name === `cooking_generic_${key.replaceAll(' ', '_')}`);
    if (exact) return exact;
    const rawId = packMap('obj').get(`raw_${key.replaceAll(' ', '_')}`);
    return recipes.find(r => r.name.endsWith(`_${key}`) || rawId === r.raw);
}

export function foodRule(foodType: string): { rawId: number; cookedId?: number; level: number } {
    const recipe = foodRecipe(foodType);
    if (recipe) return { rawId: recipe.raw, cookedId: recipe.products[0], level: recipe.level };
    return { rawId: foodRecipe(DEFAULT_FOOD_TYPE)!.raw, level: 1 };
}

// ---- Inventory production recipes ----

export type InventoryRecipe = {
    name: string;
    inputs: { id: number; units: number }[];
    tools: number[];
    product: number;
    productUnits?: number;
    lossProduct?: number;
    byproducts?: { id: number; units: number }[];
    optionalInputs?: number[];
    menu?: string;
    extraSlot?: boolean;
    itemOption?: number;
    skill: 'Crafting' | 'Cooking' | 'Fletching' | 'Herblore';
    level: number;
    xp: boolean;
    members: boolean;
    source: string;
};

let cachedInventoryRecipes: InventoryRecipe[] | undefined;
const recipeExp = new Map<string, number>();

export function inventoryRecipeExp(name: string): number | undefined {
    inventoryRecipes();
    return recipeExp.get(name);
}

export function inventoryRecipes(): InventoryRecipe[] {
    if (cachedInventoryRecipes) return cachedInventoryRecipes;
    const contentRel = 'vendor/rs-sdk/server/content/';
    const names = packMap('obj');
    const id = (name: string) => {
        const value = names.get(name);
        if (value === undefined) throw Error('unknown production item ' + name);
        return value;
    };
    const recipes: InventoryRecipe[] = [];
    const add = (
        name: string,
        inputs: string[],
        product: string,
        skill: InventoryRecipe['skill'],
        level: number,
        xp: boolean,
        source: string,
        tools: string[] = [],
        members = false,
        loss?: string,
    ) =>
        recipes.push({
            name,
            inputs: inputs.map(n => ({ id: id(n), units: 1 })),
            product: id(product),
            skill,
            level,
            xp,
            source: contentRel + source,
            tools: tools.map(id),
            members,
            ...(loss ? { lossProduct: id(loss) } : {}),
        });
    const pie = 'scripts/skill_cooking/scripts/cooking_inv/scripts/pies/pies.rs2';
    add('pie-shell', ['pastry_dough', 'piedish'], 'pie_shell', 'Cooking', 1, false, pie);
    for (const [name, ingredient, level] of [
        ['apple', 'cooking_apple', 30],
        ['meat', 'cooked_meat', 20],
        ['redberry', 'redberries', 10],
    ] as const) {
        add('raw-' + name + '-pie', ['pie_shell', ingredient], 'uncooked_' + name + '_pie', 'Cooking', level, false, pie);
    }
    add('wine-unfermented', ['grapes', 'jug_water'], 'jug_unfermented_wine', 'Cooking', 35, false, 'scripts/skill_cooking/scripts/cooking_inv/scripts/wine/wine.rs2');
    const gem = 'scripts/skill_crafting/scripts/gem/uncut_gem.rs2';
    for (const [name, level, fragile, members] of [
        ['sapphire', 20, false, false],
        ['emerald', 27, false, false],
        ['ruby', 34, false, false],
        ['diamond', 43, false, false],
        ['dragonstone', 55, false, true],
        ['opal', 1, true, true],
        ['jade', 13, true, true],
        ['red_topaz', 16, true, true],
    ] as const) {
        add('cut-' + name, ['uncut_' + name], name, 'Crafting', level, true, gem, ['chisel'], members, fragile ? 'crushed_gemstone' : undefined);
    }
    for (const [name, level] of [
        ['water', 54],
        ['earth', 58],
        ['fire', 62],
        ['air', 66],
    ] as const) {
        add(name + '-battlestaff', ['battlestaff', name + '_orb'], name + '_battlestaff', 'Crafting', level, true, 'scripts/skill_crafting/scripts/battlestaves/battlestaves.rs2', [], true);
    }
    for (const name of ['gold', 'sapphire', 'emerald', 'ruby', 'diamond', 'dragonstone']) {
        add('string-' + name + '-amulet', ['ball_of_wool', 'unstrung_' + name + '_amulet'], 'strung_' + name + '_amulet', 'Crafting', 1, true, 'scripts/skill_crafting/scripts/jewellery/stringing.rs2', [], name === 'dragonstone');
    }
    const blocks = (file: string) =>
        [...readFileSync(join(CONTENT_DIR, file), 'utf8').matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)].map(m => ({ name: m[1]!, body: m[2]! }));
    const field = (body: string, key: string) => body.match(new RegExp('^data=' + key + ',(.+)$', 'm'))?.[1]?.trim();
    const softMenus: Record<string, string> = {
        leather_armour: '113',
        leather_gloves: '116',
        leather_boots: '119',
        leather_vambraces: '122',
        leather_chaps: '125',
        coif: '128',
        leather_cowl: '131',
    };
    for (const row of blocks('scripts/skill_crafting/configs/leather/leather.dbrow').filter(r => r.body.includes('table=craft_leather_table'))) {
        const product = field(row.body, 'product')!;
        const [leather, units] = field(row.body, 'leather')!.split(',');
        add('leather:' + product, [leather!], product, 'Crafting', Number(field(row.body, 'levelrequired')), true, 'scripts/skill_crafting/scripts/leather/leather.rs2', ['needle'], field(row.body, 'members') === 'true');
        const recipe = recipes.at(-1)!;
        recipe.inputs[0]!.units = Number(units);
        recipe.optionalInputs = [id('thread')];
        if (softMenus[product]) recipe.menu = 'leather_crafting:com_' + softMenus[product];
        else if (product !== 'hardleather_body') recipe.menu = 'skill_multi3:make1_' + (product.includes('vambraces') ? 'b' : product.includes('chaps') ? 'c' : 'a');
    }
    for (const [product, level, letter] of [
        ['beer_glass', 1, 'a'],
        ['vial_empty', 33, 'b'],
        ['stafforb', 46, 'c'],
    ] as const) {
        add('glass:' + product, ['molten_glass'], product, 'Crafting', level, true, 'scripts/skill_crafting/scripts/glass/glass.rs2', ['glassblowingpipe'], true);
        recipes.at(-1)!.menu = 'skill_multi3:make1_' + letter;
    }
    for (const row of blocks('scripts/skill_fletching/configs/stringing/bows.dbrow')) {
        const input = field(row.body, 'item');
        const value = field(row.body, 'product');
        if (!input || !value) continue;
        const product = value.split(',')[0]!;
        add('bow-string:' + product, [input, 'bow_string'], product, 'Fletching', Number(field(row.body, 'level')), true, 'scripts/skill_fletching/scripts/bows.rs2', [], true);
    }
    for (const row of blocks('scripts/skill_fletching/configs/cut_logs/cut_logs.dbrow')) {
        const log = field(row.body, 'log');
        if (!log) continue;
        const three = Number(field(row.body, 'shafts') ?? 0) > 0;
        for (const shape of ['shortbow', 'longbow'] as const) {
            const value = field(row.body, shape);
            if (!value) continue;
            const [product, level] = value.split(',');
            add('cut-bow:' + product, [log], product!, 'Fletching', Number(level), true, 'scripts/skill_fletching/scripts/cut_logs.rs2', ['knife'], true);
            recipes.at(-1)!.menu = `skill_multi${three ? '3' : '2'}:make1_${shape === 'shortbow' ? (three ? 'b' : 'a') : three ? 'c' : 'b'}`;
        }
    }
    for (const row of blocks('scripts/skill_fletching/configs/darts/darts.dbrow')) {
        const input = field(row.body, 'item');
        const value = field(row.body, 'product');
        if (!input || !value) continue;
        const [product, units] = value.split(',');
        add('darts:' + product, [input, 'feather'], product!, 'Fletching', Number(field(row.body, 'level')), true, 'scripts/skill_fletching/scripts/darts.rs2', [], true);
        const recipe = recipes.at(-1)!;
        recipe.productUnits = Number(units);
        for (const ingredient of recipe.inputs) ingredient.units = Number(units);
    }
    for (const row of blocks('scripts/skill_fletching/configs/bolts/bolts.dbrow')) {
        const input = field(row.body, 'item');
        const value = field(row.body, 'product');
        if (!input || !value) continue;
        const [product, units] = value.split(',');
        const tips = product!.endsWith('bolttips');
        const label = (tips ? 'bolt-tips:' : 'tip-bolts:') + product;
        const name = recipes.some(r => r.name === label) ? label + ':' + input : label;
        add(name, [input, ...(tips ? [] : ['bolt'])], product!, 'Fletching', Number(field(row.body, 'level')), true, 'scripts/skill_fletching/scripts/bolts.rs2', tips ? ['chisel'] : [], true);
        const recipe = recipes.at(-1)!;
        recipe.productUnits = Number(units);
        if (!tips) for (const ingredient of recipe.inputs) ingredient.units = Number(units);
    }
    const param = (body: string, key: string) => body.match(new RegExp('^param=' + key + ',(.+)$', 'm'))?.[1]?.trim();
    const herbs = ['scripts/skill_herblore/configs/herbs.obj'].flatMap(blocks);
    const identify = 'scripts/skill_herblore/scripts/identifying/identify.rs2';
    const identifyText = readFileSync(join(CONTENT_DIR, identify), 'utf8');
    for (const m of identifyText.matchAll(/\[opheld1,([^\]]+)\]\s*~attempt_identify_herb\((\w+),/g)) {
        const herb = herbs.find(r => r.name === m[2]);
        const level = Number(param(herb?.body ?? '', 'identified_herb_level') ?? 3);
        const xp = Number(param(herb?.body ?? '', 'identified_herb_exp') ?? 0);
        add('identify:' + m[2], [m[1]!], m[2]!, 'Herblore', level, xp > 0, identify, [], true);
        recipes.at(-1)!.itemOption = 1;
        if (xp > 0) recipeExp.set('identify:' + m[2], xp);
    }
    for (const row of blocks('scripts/skill_herblore/configs/brewing/brew_potion.struct').filter(r => /^(unf_|3dose)/.test(r.name))) {
        const ingredient = param(row.body, 'brew_potion_ingredient');
        const solvent = param(row.body, 'brew_potion_solvent');
        const product = param(row.body, 'brew_potion_mixture');
        if (!ingredient || !solvent || !product) continue;
        const exp = Number(param(row.body, 'brew_potion_exp') ?? 0);
        add('brew:' + row.name, [ingredient, solvent], product, 'Herblore', Number(param(row.body, 'brew_potion_level') ?? 3), exp > 0, 'scripts/skill_herblore/scripts/brewing/brew_potion.rs2', [], true);
        if (exp > 0) recipeExp.set('brew:' + row.name, exp);
    }
    for (const row of blocks('scripts/skill_herblore/configs/grinding/grindables.obj').filter(r => ['unicorn_horn', 'blue_dragon_scale', 'bat_bones'].includes(r.name))) {
        add('grind:' + row.name, [row.name], param(row.body, 'grindable_ingredient_refined')!, 'Herblore', 1, false, 'scripts/skill_herblore/scripts/grinding/grind_ingredient.rs2', ['pestle_and_mortar'], true);
    }
    const cooking = 'scripts/skill_cooking/scripts/cooking_inv/scripts/';
    for (const water of blocks('scripts/general_use/configs/water_sources.obj').filter(r => param(r.body, 'is_water_source') === '^true')) {
        for (const [kind, product, option] of [
            ['bread', 'bread_dough', 1],
            ['pastry', 'pastry_dough', 2],
            ['pizza', 'pizza_base', 3],
            ['pitta', 'uncooked_pitta_bread', 4],
        ] as const) {
            add('dough:' + kind + ':' + water.name, ['pot_flour', water.name], product, 'Cooking', 1, false, cooking + 'dough/dough.rs2', [], kind === 'pitta' || /^members=yes$/m.test(water.body));
            const recipe = recipes.at(-1)!;
            recipe.menu = 'multi4:com_' + option;
            recipe.extraSlot = true;
            recipe.byproducts = [{ id: id('pot_empty'), units: 1 }, { id: id(param(water.body, 'next_obj_stage')!), units: 1 }];
        }
    }
    add('prepare:cake', ['cake_tin', 'pot_flour', 'egg', 'bucket_milk'], 'uncooked_cake', 'Cooking', 1, false, cooking + 'cakes/cakes.rs2');
    recipes.at(-1)!.byproducts = [{ id: id('pot_empty'), units: 1 }, { id: id('bucket_empty'), units: 1 }];
    add('prepare:chocolate-cake', ['cake', 'chocolate_bar'], 'chocolate_cake', 'Cooking', 50, true, cooking + 'cakes/cakes.rs2');
    const stew = cooking + 'stew/stew.rs2';
    add('prepare:potato-stew', ['potato', 'bowl_water'], 'stew1', 'Cooking', 25, false, stew);
    add('prepare:meat-stew', ['cooked_meat', 'bowl_water'], 'stew2', 'Cooking', 25, false, stew);
    add('prepare:uncooked-stew', ['stew1', 'cooked_meat'], 'uncooked_stew', 'Cooking', 25, false, stew);
    add('prepare:uncooked-stew-potato', ['stew2', 'potato'], 'uncooked_stew', 'Cooking', 25, false, stew);
    add('prepare:curry', ['uncooked_stew', 'spicespot'], 'uncooked_curry', 'Cooking', 25, false, stew, [], true);
    const pizza = cooking + 'pizza/pizza.rs2';
    add('prepare:tomato-pizza', ['pizza_base', 'tomato'], 'incomplete_pizza', 'Cooking', 35, false, pizza);
    add('prepare:uncooked-pizza', ['incomplete_pizza', 'cheese'], 'uncooked_pizza', 'Cooking', 35, false, pizza);
    for (const [topping, product, level, members] of [
        ['cooked_meat', 'meat_pizza', 45, false],
        ['cooked_chicken', 'meat_pizza', 45, false],
        ['anchovies', 'anchovie_pizza', 55, false],
        ['pineapple_ring', 'pineapple_pizza', 65, true],
        ['pineapple_chunks', 'pineapple_pizza', 65, true],
    ] as const) {
        add('top-pizza:' + topping, ['plain_pizza', topping], product, 'Cooking', level, true, pizza, [], members);
    }
    const chicken = cooking + 'meat/cooked_meat.rs2';
    add('prepare:chicken-stew', ['cooked_chicken', 'bowl_water'], 'stew2', 'Cooking', 25, false, chicken);
    add('prepare:uncooked-stew-chicken', ['stew1', 'cooked_chicken'], 'uncooked_stew', 'Cooking', 25, false, chicken);
    const poison = 'scripts/skill_combat/scripts/weapon_poison.rs2';
    add('poison:dragon-dagger', ['dragon_dagger', 'weapon_poison'], 'dragon_dagger_p', 'Herblore', 1, false, poison, [], true);
    recipes.at(-1)!.byproducts = [{ id: id('vial_empty'), units: 1 }];
    add('poison:dragon-spear', ['dragon_spear', 'weapon_poison'], 'dragon_spear_p', 'Herblore', 1, false, poison, [], true);
    recipes.at(-1)!.byproducts = [{ id: id('vial_empty'), units: 1 }];
    add('poison:rune-arrow', ['rune_arrow', 'weapon_poison'], 'rune_arrow_p', 'Herblore', 1, false, poison, [], true);
    recipes.at(-1)!.productUnits = 5;
    recipes.at(-1)!.inputs[0]!.units = 5;
    recipes.at(-1)!.byproducts = [{ id: id('vial_empty'), units: 1 }];
    add('brew:weapon_poison', ['dragon_scale_dust', 'kwuarmvial'], 'weapon_poison', 'Herblore', 60, true, 'scripts/skill_herblore/scripts/brewing/brew_potion.rs2', [], true);
    add('strip:swamp-toad', ['swamp_toad'], 'toads_legs', 'Herblore', 1, false, 'scripts/skill_cooking/scripts/gnome_cooking/swamp_toad.rs2', [], true);
    recipes.at(-1)!.itemOption = 1;
    const decant = 'scripts/skill_herblore/scripts/decanting/decant_potion.rs2';
    for (const [key, base] of [
        ['prayer_restore', 'prayerrestore'],
        ['super_attack', '2attack'],
        ['super_strength', '2strength'],
        ['super_defense', '2defense'],
        ['ranging_potion', 'rangerspotion'],
        ['super_energy', '2energy'],
        ['agility_potion', '1agility'],
        ['super_antipoison', '2antipoison'],
        ['super_restore', '2restore'],
        ['magic_potion', '1magic'],
        ['zamorak_potion', 'potionofzamorak'],
        ['restore_potion', 'statrestore'],
    ] as const) {
        add('decant:' + key, ['3dose' + base], '4dose' + base, 'Herblore', 1, false, decant, [], true);
        recipes.at(-1)!.inputs[0]!.units = 2;
        recipes.at(-1)!.byproducts = [{ id: id('2dose' + base), units: 1 }];
        add('decant2:' + key, ['2dose' + base], '4dose' + base, 'Herblore', 1, false, decant, [], true);
        recipes.at(-1)!.inputs[0]!.units = 2;
        recipes.at(-1)!.byproducts = [{ id: id('vial_empty'), units: 1 }];
        add('decant31:' + key, ['3dose' + base, '1dose' + base], '4dose' + base, 'Herblore', 1, false, decant, [], true);
        recipes.at(-1)!.byproducts = [{ id: id('vial_empty'), units: 1 }];
        if (key === 'super_antipoison') {
            add('grind:chocolate_bar', ['chocolate_bar'], 'chocolate_dust', 'Herblore', 1, false, 'scripts/skill_cooking/scripts/cooking_inv/scripts/cakes/cakes.rs2', ['pestle_and_mortar'], true);
            add('combine:crystal-key', ['keyhalf1', 'keyhalf2'], 'crystal_key', 'Herblore', 1, false, 'scripts/areas/area_taverly/scripts/crystal_key.rs2', [], true);
        }
    }
    if (new Set(recipes.map(r => r.name)).size !== recipes.length) throw Error('duplicate inventory production profile');
    cachedInventoryRecipes = recipes;
    return cachedInventoryRecipes;
}

// ---- Jewellery recipes ----

const jewelleryObjId = (name: string) => {
    const n = packMap('obj').get(name);
    if (n === undefined) throw Error('unknown native jewellery item ' + name);
    return n;
};

export interface JewelleryRecipe extends InventoryRecipe {
    bar: number;
    shape: 'ring' | 'necklace' | 'amulet' | 'silver';
    slot: number;
    silverLetter?: 'a' | 'b' | 'c';
}

let cachedJewelleryRecipes: JewelleryRecipe[] | undefined;

export function jewelleryRecipes(): JewelleryRecipe[] {
    if (cachedJewelleryRecipes) return cachedJewelleryRecipes;
    const pathRel = 'scripts/skill_crafting/configs/jewellery/jewellery.struct';
    const text = readFileSync(join(CONTENT_DIR, pathRel), 'utf8');
    cachedJewelleryRecipes = [...text.matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)].map((match): JewelleryRecipe => {
        const name = match[1]!;
        const body = match[2]!;
        const param = (key: string) => body.match(new RegExp('^param=' + key + ',(.+)$', 'm'))?.[1]?.trim();
        const product = param('product')!;
        const silver = ['unstrung_symbol', 'unstrung_emblem', 'silver_sickle'].includes(name);
        const perfect = name.startsWith('perfect_');
        const shape = silver ? 'silver' : name.includes('ring') ? 'ring' : name.includes('necklace') ? 'necklace' : 'amulet';
        const gem = param('gem');
        const bar = jewelleryObjId(silver ? 'silver_bar' : perfect ? 'perfect_gold_bar' : 'gold_bar');
        const mould = param('mould') ?? shape + '_mould';
        const slot = silver ? 0 : gem ? ['gold', 'sapphire', 'emerald', 'ruby', 'diamond', 'dragonstone'].indexOf(gem) : 0;
        if (slot < 0) throw Error('unknown native jewellery gem');
        return {
            name,
            product: jewelleryObjId(product),
            inputs: [{ id: bar, units: 1 }, ...(gem ? [{ id: jewelleryObjId(gem), units: 1 }] : [])],
            tools: [jewelleryObjId(mould)],
            skill: 'Crafting',
            level: Number(param('levelrequired')),
            xp: true,
            members: gem === 'dragonstone' || name === 'unstrung_emblem' || name === 'silver_sickle',
            source: 'vendor/rs-sdk/server/content/' + pathRel,
            bar,
            shape,
            slot,
            ...(silver ? { silverLetter: name === 'unstrung_emblem' ? ('a' as const) : name === 'unstrung_symbol' ? ('b' as const) : ('c' as const) } : {}),
        };
    });
    return cachedJewelleryRecipes;
}

// ---- Item magic & standard teleport recipes ----

const magicTextsCache = new Map<string, string>();
const magicParsedBlocksCache = new Map<string, { name: string; body: string }[]>();
const readMagicCached = (file: string) => {
    let t = magicTextsCache.get(file);
    if (t === undefined) {
        t = readFileSync(file, 'utf8');
        magicTextsCache.set(file, t);
    }
    return t;
};
const parseCfgBlocks = (text: string) => [...text.matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)].map(m => ({ name: m[1]!, body: m[2]! }));
const magicBlocksOf = (file: string) => {
    let b = magicParsedBlocksCache.get(file);
    if (!b) {
        b = parseCfgBlocks(readMagicCached(file));
        magicParsedBlocksCache.set(file, b);
    }
    return b;
};

let itemCostsMapCache: Map<string, number> | undefined;
function itemCostsByDebug(): Map<string, number> {
    if (!itemCostsMapCache) {
        const rows = JSON.parse(readFileSync(join(KNOWLEDGE_DIR, 'items.json'), 'utf8')) as { debugname: string; cost?: number }[];
        itemCostsMapCache = new Map();
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!;
            if (!itemCostsMapCache.has(row.debugname) && row.cost !== undefined) {
                itemCostsMapCache.set(row.debugname, row.cost);
            }
        }
    }
    return itemCostsMapCache;
}

export interface ItemMagicRecipe {
    name: string;
    spell: string;
    level: number;
    smithing: number;
    target: number;
    product: number;
    inputs: Record<number, number>;
    output: number;
    members: boolean;
}
export type Recipe = ItemMagicRecipe;

const itemMagicRecipeCache = new Map<string, ItemMagicRecipe>();

export function itemMagicRecipe(mode: string, targetName?: string): ItemMagicRecipe {
    const cacheKey = `${mode}\0${targetName ?? ''}`;
    const hit = itemMagicRecipeCache.get(cacheKey);
    if (hit) return { ...hit, inputs: { ...hit.inputs } };
    const spells = magicBlocksOf(join(CONTENT_DIR, 'scripts/skill_magic/configs/magic_spells.dbrow'));
    const field = (body: string, key: string) => body.match(new RegExp('^data=' + key + ',(.+)$', 'm'))?.[1]?.trim();
    let row = spells.find(r => r.name === `magic_spell_${mode === 'low-alch' ? 'low_alch' : mode === 'high-alch' ? 'high_alch' : 'superheat'}`);
    let input = '';
    let product = 'coins';
    let smithing = 0;
    let secondary: string | undefined;
    let secondaryCount = 0;
    if (mode.startsWith('enchant:')) {
        input = mode.slice(8);
        if (!/^\w+$/.test(input)) throw Error('invalid native item name');
        row = spells.find(r => r.body.includes('data=convertobj,' + input + ','));
        product = row?.body.match(new RegExp('^data=convertobj,' + input + ',([^,]+)', 'm'))?.[1] ?? '';
    } else if (mode.startsWith('superheat:')) {
        const metal = mode.slice(10);
        if (!/^(bronze|iron|silver|steel|gold|mithril|adamantite|runite)$/.test(metal)) throw Error('unsupported metal');
        product = metal + '_bar';
        const b = magicBlocksOf(join(CONTENT_DIR, 'scripts/skill_smithing/configs/smelting/smelting.struct')).find(r => r.name === 'smelting_' + product)?.body;
        if (!b) throw Error('missing native smelting recipe');
        const p = (key: string) => b.match(new RegExp('^param=' + key + ',(.+)$', 'm'))?.[1]?.trim();
        input = p('ingredient')!;
        smithing = Number(p('levelrequired'));
        secondary = p('ingredient_secondary');
        secondaryCount = Number(p('ingredient_secondary_count') ?? 0);
    } else if (mode === 'low-alch' || mode === 'high-alch') {
        if (!targetName || !/^\w+$/.test(targetName) || ['coins', 'naturerune', 'firerune'].includes(targetName)) {
            throw Error('explicit non-rune alchemy target required');
        }
        input = targetName;
    } else {
        throw Error('unsupported item magic mode');
    }
    if (!row || !input || !product) throw Error('no native item conversion');
    const inputs: Record<number, number> = { [objId(input)]: 1 };
    const runes = field(row.body, 'runesrequired')!.split(',');
    for (let n = 0; n < runes.length; n += 2) {
        if (runes[n] !== 'null') inputs[objId(runes[n]!)] = (inputs[objId(runes[n]!)] ?? 0) + Number(runes[n + 1]);
    }
    if (secondary) inputs[objId(secondary)] = secondaryCount;
    let output = 1;
    if (product === 'coins') {
        const cost = itemCostsByDebug().get(input);
        if (cost === undefined) throw Error('unknown native alchemy value');
        output = Math.max(1, Math.floor((cost * (mode === 'high-alch' ? 6 : 4)) / 10));
    }
    const built: ItemMagicRecipe = {
        name: mode,
        spell: 'magic:' + field(row.body, 'spell')!.replace('^', ''),
        level: Number(field(row.body, 'levelrequired')),
        smithing,
        target: objId(input),
        product: objId(product),
        inputs,
        output,
        members: field(row.body, 'members') === 'true',
    };
    itemMagicRecipeCache.set(cacheKey, built);
    return { ...built, inputs: { ...built.inputs } };
}

export interface NativeTeleport {
    name: string;
    component: string;
    level: number;
    members: boolean;
    runes: Record<number, number>;
    to: { x: number; z: number; level: number };
}

const nativeTeleportCache = new Map<string, NativeTeleport>();

export function nativeTeleport(name: string): NativeTeleport {
    if (!/^(varrock|lumbridge|falador|camelot|ardougne|watchtower|trollheim)$/.test(name)) throw Error('unsupported native teleport');
    let cached = nativeTeleportCache.get(name);
    if (!cached) {
        const text = readMagicCached(join(CONTENT_DIR, 'scripts/skill_magic/configs/magic_spells.dbrow'));
        const body = text.split('[magic_spell_teleport_' + name + ']')[1]?.split('\n[')[0];
        if (!body) throw Error('native teleport missing');
        const field = (key: string) => body.match(new RegExp('^data=' + key + ',(.+)$', 'm'))?.[1]?.trim();
        const parts = field('runesrequired')!.split(',');
        const runes: Record<number, number> = {};
        for (let i = 0; i < parts.length; i += 2) if (parts[i] !== 'null') runes[objId(parts[i]!)] = Number(parts[i + 1]);
        const [level, mx, mz, lx, lz] = field('tele_coord')!.split('_').map(Number);
        cached = { name, component: 'magic:' + name + '_teleport', level: Number(field('levelrequired')), members: field('members') === 'true', runes, to: { x: mx! * 64 + lx!, z: mz! * 64 + lz!, level: level! } };
        nativeTeleportCache.set(name, cached);
    }
    return { ...cached, runes: { ...cached.runes }, to: { ...cached.to } };
}

export const BONES_TO_BANANAS_RUNES = { 557: 2, 555: 2, 561: 1 } as const;
export const BONES_PER_CAST = 25;

// ---- Smelting & smithing recipes ----

export type SmeltRecipe = {
    product: number;
    level: number;
    ingredients: { id: number; units: number }[];
    iron: boolean;
    productUnits?: number;
    tools?: readonly number[];
    receiptTicks?: number;
    rawXp?: number;
};

export const SMELT_BAR_TYPES = ['bronze', 'iron', 'silver', 'steel', 'gold', 'mithril', 'adamantite', 'runite'] as const;

const smeltRecipeCache = new Map<string, SmeltRecipe>();
let cachedSmeltingStructByName: Map<string, ReturnType<typeof parseConfigs>[number]> | undefined;

export function smeltingStructByName() {
    if (!cachedSmeltingStructByName) {
        const file = 'scripts/skill_smithing/configs/smelting/smelting.struct';
        cachedSmeltingStructByName = new Map(parseConfigs(readFileSync(join(CONTENT_DIR, file), 'utf8'), file).map(b => [b.name, b]));
    }
    return cachedSmeltingStructByName;
}

export function smeltRecipe(bar: string): SmeltRecipe {
    const cached = smeltRecipeCache.get(bar);
    if (cached) return cached;
    if (bar === 'cannonballs') {
        const r: SmeltRecipe = { product: 2, level: 35, ingredients: [{ id: 2353, units: 1 }], iron: false, productUnits: 4, tools: [4], receiptTicks: 24, rawXp: 375 };
        smeltRecipeCache.set(bar, r);
        return r;
    }
    if (!SMELT_BAR_TYPES.includes(bar as (typeof SMELT_BAR_TYPES)[number])) {
        throw Error('unsupported smelt recipe: ' + bar);
    }
    const ids = packMap('obj');
    const b = smeltingStructByName().get('smelting_' + bar + '_bar');
    if (!b) throw Error('pinned smelt recipe missing');
    const p = Object.fromEntries(
        (b.props.param ?? []).map(v => {
            const at = v.indexOf(',');
            return [v.slice(0, at), v.slice(at + 1)];
        }),
    );
    const item = (name: string) => {
        const id = ids.get(name);
        if (id === undefined) throw Error('unknown smelt item ' + name);
        return id;
    };
    const ingredients = [{ id: item(p.ingredient!), units: Number(p.bar_count) }];
    if (p.ingredient_secondary) ingredients.push({ id: item(p.ingredient_secondary), units: Number(p.ingredient_secondary_count) });
    const r: SmeltRecipe = { product: item(p.product!), level: Number(p.levelrequired), ingredients, iron: bar === 'iron' };
    smeltRecipeCache.set(bar, r);
    return r;
}

export type SmithRecipe = {
    product: number;
    amount: number;
    level: number;
    bar: number;
    bars: number;
    xpPerBar: number;
    component: number;
    slot: number;
    quest?: 'The Tourist Trap' | 'Death Plateau';
};

const smithRecipeCache = new Map<number, SmithRecipe>();
type SmithingTables = {
    objs: ReadonlyMap<string, number>;
    objNameById: Map<number, string>;
    components: ReadonlyMap<string, number>;
    dbrowByProduct: Map<string, ReturnType<typeof parseConfigs>[number]>;
    smeltingObjByName: Map<string, ReturnType<typeof parseConfigs>[number]>;
    smithingStructByName: Map<string, ReturnType<typeof parseConfigs>[number]>;
    smithingInvByName: Map<string, ReturnType<typeof parseConfigs>[number]>;
    handler: string;
};
let cachedSmithingTables: SmithingTables | undefined;

function smithingTables(): SmithingTables {
    if (cachedSmithingTables) return cachedSmithingTables;
    const configs = 'scripts/skill_smithing/configs/';
    const blocks = (file: string) => parseConfigs(readFileSync(join(CONTENT_DIR, configs + file), 'utf8'), file);
    const field = (rows: string[] | undefined, key: string) => rows?.find(v => v.startsWith(key + ','))?.slice(key.length + 1);
    const objs = packMap('obj');
    const objNameById = new Map<number, string>();
    for (const [name, id] of objs) if (!objNameById.has(id)) objNameById.set(id, name);
    const dbrowByProduct = new Map<string, ReturnType<typeof parseConfigs>[number]>();
    for (const b of blocks('smithing/smithing.dbrow')) {
        const prod = field(b.props.data, 'product');
        if (prod && !dbrowByProduct.has(prod)) dbrowByProduct.set(prod, b);
    }
    cachedSmithingTables = {
        objs,
        objNameById,
        components: parsePackNameToId(readFileSync(join(CONTENT_DIR, 'pack/interface.pack'), 'utf8')),
        dbrowByProduct,
        smeltingObjByName: new Map(blocks('smelting/smelting.obj').map(b => [b.name, b])),
        smithingStructByName: new Map(blocks('smithing/smithing.struct').map(b => [b.name, b])),
        smithingInvByName: new Map(blocks('smithing/smithing.inv').map(b => [b.name, b])),
        handler: readFileSync(join(CONTENT_DIR, 'scripts/skill_smithing/scripts/smithing/smithing.rs2'), 'utf8'),
    };
    return cachedSmithingTables;
}

export function smithRecipe(product: number): SmithRecipe {
    const unsupported = Error('unsupported smith recipe: ' + product);
    if (!Number.isSafeInteger(product) || product < 0) throw unsupported;
    const cached = smithRecipeCache.get(product);
    if (cached) return cached;
    const field = (rows: string[] | undefined, key: string) => rows?.find(v => v.startsWith(key + ','))?.slice(key.length + 1);
    const t = smithingTables();
    const name = t.objNameById.get(product);
    const row = name === undefined ? undefined : t.dbrowByProduct.get(name);
    if (!row) throw unsupported;
    const bar = field(row.props.data, 'bar')!;
    const struct = field(t.smeltingObjByName.get(bar)?.props.param, 'smithing_anvil_struct');
    const params = struct ? t.smithingStructByName.get(struct)?.props.param : undefined;
    const columns = Array.from({ length: 5 }, (_, i) => ({ inventory: field(params, 'invcolumn' + (i + 1)), component: 'smithing:column' + (i + 1) }));
    const branch = t.handler.split('case ' + bar + ' :')[1]?.split(/\bcase /)[0];
    const claws = branch?.match(/inv_transmit\((\w+), smithing:column_claws\)/)?.[1];
    if (claws) columns.push({ inventory: claws, component: 'smithing:column_claws' });
    for (const column of columns) {
        const inv = column.inventory ? t.smithingInvByName.get(column.inventory) : undefined;
        const stock = Object.entries(inv?.props ?? {}).find(([k, v]) => /^stock\d+$/.test(k) && v[0]?.split(',')[0] === name);
        const component = t.components.get(column.component);
        if (!stock || component === undefined) continue;
        const recipe = {
            product,
            amount: Number(field(row.props.data, 'product_amount')),
            level: Math.max(Number(field(row.props.data, 'levelrequired')), Number(field(params, 'levelrequired'))),
            bar: t.objs.get(bar)!,
            bars: Number(field(row.props.data, 'bar_amount')),
            xpPerBar: Number(field(params, 'xpperbar')),
            component,
            slot: Number(stock[0].slice(5)) - 1,
        };
        if (!Object.values(recipe).every(n => Number.isSafeInteger(n) && n >= 0) || recipe.amount < 1 || recipe.bars < 1) throw unsupported;
        const resolved: SmithRecipe = name!.endsWith('_dart_tip')
            ? { ...recipe, quest: 'The Tourist Trap' }
            : column.component === 'smithing:column_claws'
              ? { ...recipe, quest: 'Death Plateau' }
              : recipe;
        smithRecipeCache.set(product, resolved);
        return resolved;
    }
    throw unsupported;
}
