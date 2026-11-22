// Crafting production helpers: inventory production, progressive production, tanning, clay softening, and black d'hide sets.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finish, openBot, settle } from '../../../core/src/bot';
import { depositObserved } from '../../../core/src/deposit';
import { componentId } from '../../../core/src/logout';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { sessionWalker, walkPath } from '../../../core/src/walk';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import type { NearbyLoc } from '../../../../vendor/rs-sdk/sdk/types';
import { CONTENT_DIR } from './catalog';
import { cookingRecipes, registerDefaultInventoryBankRunner, type CookRecipe } from './cooking';
import { productionStopRequested, watchProductionLife } from './runtime';
import type { ArtisanExternalDeps, Session } from './types';

// ---- Inventory Production (microbot-production.ts) ----

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

export type ProductionSnapshot = { items: Record<number, number>; xp: number };

export interface ProductionIO {
    tick(): number;
    stopped(): boolean;
    level(): number;
    read(): ProductionSnapshot;
    prepare(): Promise<boolean | 'spent'>;
    use(): Promise<unknown>;
    wait(done: () => boolean): Promise<unknown>;
    deposit(id: number): Promise<number>;
    close(): Promise<void>;
}

let cachedInventoryRecipes: InventoryRecipe[] | undefined;

export function inventoryRecipes(): InventoryRecipe[] {
    if (cachedInventoryRecipes) return cachedInventoryRecipes;
    const contentRel = 'vendor/rs-sdk/server/content/';
    const names = new Map(
        readFileSync(join(CONTENT_DIR, 'pack/obj.pack'), 'utf8')
            .split(/\r?\n/)
            .filter(l => l.includes('='))
            .map(l => {
                const at = l.indexOf('=');
                return [l.slice(at + 1), Number(l.slice(0, at))] as const;
            }),
    );
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
    }
    for (const row of blocks('scripts/skill_herblore/configs/brewing/brew_potion.struct').filter(r => /^(unf_|3dose)/.test(r.name))) {
        const ingredient = param(row.body, 'brew_potion_ingredient');
        const solvent = param(row.body, 'brew_potion_solvent');
        const product = param(row.body, 'brew_potion_mixture');
        if (!ingredient || !solvent || !product) continue;
        add('brew:' + row.name, [ingredient, solvent], product, 'Herblore', Number(param(row.body, 'brew_potion_level') ?? 3), Number(param(row.body, 'brew_potion_exp') ?? 0) > 0, 'scripts/skill_herblore/scripts/brewing/brew_potion.rs2', [], true);
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

export function productionEffect(r: InventoryRecipe, b: ProductionSnapshot, a: ProductionSnapshot): 'none' | 'made' | 'loss' | 'invalid' {
    const keys = new Set([...Object.keys(b.items), ...Object.keys(a.items)].map(Number));
    if ([...keys].every(id => (a.items[id] ?? 0) === (b.items[id] ?? 0)) && a.xp === b.xp) return 'none';
    if (r.xp && a.xp <= b.xp) return 'invalid';
    for (const [product, kind] of [
        [r.product, 'made'],
        [r.lossProduct, 'loss'],
    ] as const) {
        if (product === undefined) continue;
        const expected = new Map<number, number>();
        for (const i of r.inputs) expected.set(i.id, (expected.get(i.id) ?? 0) - i.units);
        expected.set(product, (expected.get(product) ?? 0) + (kind === 'made' ? (r.productUnits ?? 1) : 1));
        if (kind === 'made') for (const i of r.byproducts ?? []) expected.set(i.id, (expected.get(i.id) ?? 0) + i.units);
        const all = new Set([...keys, ...expected.keys()]);
        if (
            [...all].every(id =>
                r.optionalInputs?.includes(id)
                    ? [0, -1].includes((a.items[id] ?? 0) - (b.items[id] ?? 0))
                    : (a.items[id] ?? 0) - (b.items[id] ?? 0) === (expected.get(id) ?? 0),
            )
        ) {
            return kind;
        }
    }
    return 'invalid';
}

export async function runInventoryProduction(
    io: ProductionIO,
    r: InventoryRecipe,
    o: { maximum: number; cap: number; maxAttempts: number; partial?: boolean },
) {
    const units = r.productUnits ?? 1;
    if (![o.maximum, o.cap, o.maxAttempts].every(n => Number.isSafeInteger(n) && n > 0) || o.maximum % units || o.maxAttempts < o.maximum / units) {
        throw Error('invalid production limits or output batch multiple');
    }
    const start = io.tick();
    const over = () => io.stopped() || io.tick() - start >= o.cap;
    let made = 0;
    let banked = 0;
    let losses = 0;
    let attempts = 0;
    let failure = '';
    let spent = false;
    try {
        if (io.level() < r.level) throw Error('production level missing');
        while (made < o.maximum && attempts < o.maxAttempts && !over()) {
            const ready = await io.prepare();
            if (ready !== true) {
                if (ready === 'spent' && o.partial && made > 0) {
                    spent = true;
                    break;
                }
                throw Error('production inputs unavailable');
            }
            if (over()) break;
            const before = io.read();
            if (r.inputs.some(i => (before.items[i.id] ?? 0) < i.units) || [...r.tools, ...(r.optionalInputs ?? [])].some(id => (before.items[id] ?? 0) < 1)) {
                throw Error('production input observation missing');
            }
            attempts++;
            await io.use();
            await io.wait(() => over() || productionEffect(r, before, io.read()) !== 'none');
            const effect = productionEffect(r, before, io.read());
            if (effect === 'made') {
                made += units;
                const n = await io.deposit(r.product);
                if (n !== units) throw Error('production bank credit mismatch');
                banked += n;
                for (const byproduct of r.byproducts ?? []) {
                    if ((await io.deposit(byproduct.id)) !== byproduct.units) throw Error('production container bank credit mismatch');
                }
            } else if (effect === 'loss') {
                losses++;
                if ((await io.deposit(r.lossProduct!)) !== 1) throw Error('production loss bank credit mismatch');
            } else {
                throw Error('production action receipt ' + effect);
            }
        }
        if ((made !== o.maximum && !spent) || banked !== made || over()) throw Error('production target incomplete');
    } catch (e) {
        failure = String(e);
    } finally {
        try {
            await io.close();
        } catch (e) {
            failure ||= String(e);
        }
    }
    return { ok: !failure, recipe: r.name, made, banked, losses, attempts, ticks: io.tick() - start, failure: failure || '-' };
}

export function productionInputReserves(r: InventoryRecipe, reserve = 0, overrides: Readonly<Record<number, number>> = {}) {
    if (
        !Number.isSafeInteger(reserve) ||
        reserve < 0 ||
        !overrides ||
        typeof overrides !== 'object' ||
        Array.isArray(overrides) ||
        Object.entries(overrides).some(([id, n]) => !Number.isSafeInteger(+id) || !r.inputs.some(i => i.id === +id) || !Number.isSafeInteger(n) || n < 0)
    ) {
        throw Error('invalid production input reserves');
    }
    return Object.fromEntries(r.inputs.map(i => [i.id, overrides[i.id] ?? reserve]));
}

export async function runInventoryBank(
    s: Session,
    r: InventoryRecipe,
    o: {
        maximum: number;
        cap: number;
        maxAttempts?: number;
        partial?: boolean;
        reserve?: number;
        inputReserves?: Readonly<Record<number, number>>;
        members?: boolean;
        stop?: () => boolean;
    },
) {
    const reserves = productionInputReserves(r, o.reserve, o.inputReserves);
    if (r.members && !o.members) throw Error('production recipe requires confirmed members world');
    if (!await waitUntil(s, () => !!s.sdk.getState()?.player && !!s.sdk.getSkill(r.skill) && (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0, { timeoutTicks: 10 })) {
        throw Error('production state unavailable');
    }
    const inv = () => s.sdk.getInventory();
    const count = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const initial = s.sdk.getState()!.player!;
    const initialLife = initial.lifeId;
    const initialRespawns = initial.respawnCount ?? 0;
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const stopped = () => {
        const p = s.sdk.getState()?.player;
        return (
            ended ||
            productionStopRequested(s.name, o.stop) ||
            !p ||
            p.isDead ||
            (s.sdk.getSkill('Hitpoints')?.level ?? 0) <= 0 ||
            (p.respawnCount ?? 0) > initialRespawns ||
            (initialLife !== undefined && p.lifeId !== initialLife)
        );
    };
    if ([r.product, ...(r.lossProduct !== undefined ? [r.lossProduct] : []), ...(r.byproducts ?? []).map(i => i.id)].some(id => count(id))) {
        throw Error('bank existing production outputs and returned containers before entry');
    }
    const read = (): ProductionSnapshot => {
        const items: Record<number, number> = {};
        for (const i of inv()) items[i.id] = (items[i.id] ?? 0) + i.count;
        return { items, xp: s.sdk.getSkillXp(r.skill) ?? 0 };
    };
    const open = async () => {
        if (stopped()) throw Error('production session stopped');
        const state = () => s.sdk.getState();
        const ready = () => !!state()?.bank?.isOpen && !!s.bankObservation?.();
        if (ready()) return;
        if (state()?.dialog?.isOpen || state()?.interface?.isOpen) {
            await s.direct({ type: 'closeModal', reason: 'production bank access' });
            if (!await waitUntil(s, () => !state()?.dialog?.isOpen && !state()?.interface?.isOpen, { timeoutTicks: 8 })) {
                throw Error('production blocking interface remains');
            }
        }
        const generation = s.bankObservation?.()?.generation ?? -1;
        if (stopped() || !(await s.bot.openBank()).success) throw Error('production bank unavailable');
        if (!await waitUntil(s, () => ready() && (s.bankObservation?.()?.generation ?? -1) > generation, { timeoutTicks: 10 })) {
            throw Error('production fresh bank unknown');
        }
    };
    const result = await runInventoryProduction(
        {
            tick: () => s.tick(),
            stopped,
            level: () => s.sdk.getSkill(r.skill)?.level ?? 0,
            read,
            prepare: async () => {
                await open();
                if (stopped()) return false;
                for (const need of [...[...r.tools, ...(r.optionalInputs ?? [])].map(id => ({ id, units: 1, input: false })), ...r.inputs.map(i => ({ ...i, input: true }))]) {
                    const missing = Math.max(0, need.units - count(need.id));
                    if (!missing) continue;
                    const item = s.bankObservation?.()?.items.find(i => i.id === need.id);
                    if (!item || item.count - missing < (reserves[need.id] ?? 0)) return need.input ? 'spent' : false;
                    const target = s.sdk.getState()?.bank?.items.find(i => i.id === need.id);
                    if (!target || !Number.isSafeInteger(target.slot)) return false;
                    const before = count(need.id);
                    if (stopped()) return false;
                    const response = await s.bot.withdrawItem(target, missing, { asNote: false });
                    if (!response.success || !await waitUntil(s, () => count(need.id) === before + missing, { timeoutTicks: 8 })) return false;
                }
                if (stopped() || (r.extraSlot && inv().length >= 28)) return false;
                await s.bot.closeBank();
                if (!await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 })) return false;
                return !stopped();
            },
            use: async () => {
                if (s.sdk.getDialog()?.isOpen || s.sdk.getState()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                if (stopped()) throw Error('production session stopped');
                const source = inv().find(i => i.id === (r.tools[0] ?? r.inputs[0]!.id));
                if (r.itemOption !== undefined) {
                    if (!source) throw Error('production item action missing');
                    return s.sdk.sendUseItem(source.slot, r.itemOption);
                }
                const target = r.tools.length
                    ? inv().find(i => i.id === r.inputs[0]!.id)
                    : r.inputs.length > 1
                      ? inv().find(i => i.id === r.inputs[1]!.id)
                      : inv().find(i => i.id === r.inputs[0]!.id && i.slot !== source?.slot);
                if (!source || !target) throw Error('production dispatch inventory missing');
                const response = await s.sdk.sendUseItemOnItem(source.slot, target.slot);
                if (r.menu) {
                    if (!await waitUntil(s, () => stopped() || !!s.sdk.getState()?.interface?.isOpen || !!s.sdk.getDialog()?.isOpen, { timeoutTicks: 8 })) {
                        throw Error('production selection interface absent');
                    }
                    if (stopped()) throw Error('production stopped before selection');
                    await s.sdk.sendClickComponent(componentId(r.menu));
                }
                return response;
            },
            wait: done => waitUntil(s, done, { timeoutTicks: 10 }),
            deposit: async id => {
                await open();
                if (stopped()) throw Error('production session stopped');
                const item = inv().find(i => i.id === id);
                return item ? depositObserved(s, item) : 0;
            },
            close: async () => {
                if (!stopped()) await s.bot.closeBank();
            },
        },
        r,
        { ...o, maxAttempts: o.maxAttempts ?? o.maximum },
    );
    if (stopped()) {
        result.ok = false;
        result.failure = 'production session stopped';
    }
    console.log('MICROBOT_PRODUCTION ' + JSON.stringify(result));
    return result;
}

registerDefaultInventoryBankRunner(runInventoryBank);

const PRODUCTION_CLI_KEYS = new Set(['MAX_MAKE', 'CAP', 'MAX_ATTEMPTS', 'ORDER_MODE', 'RAW_RESERVE', 'MEMBERS', 'INPUT_RESERVES']);

export function parseProductionCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}) {
    const overrides: Record<string, string> = {};
    for (const token of argv.slice(4)) {
        const match = token.match(/^([A-Z][A-Z0-9_]*)=([\s\S]*)$/);
        if (!match || !PRODUCTION_CLI_KEYS.has(match[1]!)) throw Error('unsupported production cli argument: ' + token);
        overrides[match[1]!] = match[2]!;
    }
    const effective = { ...env, ...overrides };
    const r = inventoryRecipes().find(r => r.name === argv[3]);
    if (!r) throw Error('unknown inventory recipe');
    const maximum = Number(effective.MAX_MAKE ?? 1);
    const cap = Number(effective.CAP ?? 500);
    const maxAttempts = Number(effective.MAX_ATTEMPTS ?? maximum);
    if (![maximum, cap, maxAttempts].every(n => Number.isSafeInteger(n) && n > 0) || maximum % (r.productUnits ?? 1) || maxAttempts < maximum / (r.productUnits ?? 1)) {
        throw Error('invalid production limits');
    }
    const reserve = Number(effective.RAW_RESERVE ?? 0);
    const inputReserves = effective.INPUT_RESERVES ? JSON.parse(effective.INPUT_RESERVES) : undefined;
    productionInputReserves(r, reserve, inputReserves);
    return {
        account: argv[2],
        recipe: r,
        maximum,
        cap,
        maxAttempts,
        partial: effective.ORDER_MODE === 'best-effort',
        reserve,
        inputReserves,
        members: effective.MEMBERS === '1',
    };
}

export async function runProductionCli(botName: string, restArgs: readonly string[], env: Record<string, string | undefined> = process.env) {
    const cli = parseProductionCli(['bun', 'scripts/aio-skiller.ts', botName, ...restArgs], env);
    let stop = false;
    const s = await openBot(cli.account!, { onStop: async () => { stop = true; } });
    try {
        const result = await runInventoryBank(s, cli.recipe, {
            maximum: cli.maximum,
            cap: cli.cap,
            maxAttempts: cli.maxAttempts,
            partial: cli.partial,
            reserve: cli.reserve,
            inputReserves: cli.inputReserves,
            members: cli.members,
            stop: () => stop,
        });
        await finish([s], result.ok, JSON.stringify(result));
    } catch (e) {
        await finish([s], false, String(e));
    }
}

// ---- Progressive Production (microbot-production-progressive.ts) ----

export type Tile = { x: number; z: number; level: number };

export type ProgressiveProduction = {
    mode: 'fletch' | 'string' | 'craft-staff' | 'craft-glass' | 'cooking-prepared' | 'burn-bake';
    targetLevel: number;
    maximum: number;
    batch: number;
    reserve: number;
    cap: number;
    members: boolean;
    bank: Tile;
    site?: Tile;
};

type ProgSnapshot = { assets: Record<number, number>; gear: { id: number; slot: number; count: number }[] };

export type ProgressiveStage = {
    name: string;
    skill: 'Fletching' | 'Crafting' | 'Cooking';
    level: number;
    inputs: { id: number; units: number }[];
    tools: number[];
    recipe?: InventoryRecipe;
    cooking?: CookRecipe;
    shafts?: true;
};

export type ProgressiveDeps = {
    recipes?: readonly InventoryRecipe[];
    cooks?: readonly CookRecipe[];
    audit?: () => Promise<ProgSnapshot>;
    inventory?: typeof runInventoryBank;
    shafts?: (s: Session, o: { cap: number; maximum: number; reserve: number; bankKnife?: boolean; stop?: () => boolean }) => Promise<any>;
    cook?: (s: Session, j: any, stop?: () => boolean) => Promise<any>;
};

let defaultBankJobRunner: ((s: Session, j: any, stop?: () => boolean) => Promise<any>) | undefined;
export function registerDefaultBankJobRunner(fn: (s: Session, j: any, stop?: () => boolean) => Promise<any>) {
    defaultBankJobRunner = fn;
}

let defaultShaftsRunner: ((s: Session, o: { cap: number; maximum: number; reserve: number; bankKnife?: boolean; stop?: () => boolean }) => Promise<any>) | undefined;
export function registerDefaultShaftsRunner(fn: (s: Session, o: { cap: number; maximum: number; reserve: number; bankKnife?: boolean; stop?: () => boolean }) => Promise<any>) {
    defaultShaftsRunner = fn;
}

const equalAssets = (a: Record<number, number>, b: Record<number, number>) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => (a[+k] ?? 0) === (b[+k] ?? 0));
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

let cachedCertificates: Map<number, number> | undefined;
function certMap(): Map<number, number> {
    if (cachedCertificates) return cachedCertificates;
    const packed = new Map(
        readFileSync(join(CONTENT_DIR, 'pack/obj.pack'), 'utf8')
            .split(/\r?\n/)
            .flatMap(l => {
                const m = l.match(/^(\d+)=(\w+)$/);
                return m ? ([[m[2]!, Number(m[1])] as const]) : [];
            }),
    );
    cachedCertificates = new Map(
        [...packed].flatMap(([name, id]) => (name.startsWith('cert_') && packed.has(name.slice(5)) ? [[id, packed.get(name.slice(5))!] as const] : [])),
    );
    return cachedCertificates;
}

export function validateProgressiveProduction(o: ProgressiveProduction) {
    if (
        !o ||
        !['fletch', 'string', 'craft-staff', 'craft-glass', 'cooking-prepared', 'burn-bake'].includes(o.mode) ||
        !Number.isSafeInteger(o.targetLevel) ||
        o.targetLevel < 1 ||
        o.targetLevel > 99 ||
        !Number.isSafeInteger(o.maximum) ||
        o.maximum < 1 ||
        o.maximum > 10000 ||
        !Number.isSafeInteger(o.batch) ||
        o.batch < 1 ||
        o.batch > 24 ||
        !Number.isSafeInteger(o.reserve) ||
        o.reserve < 0 ||
        !Number.isSafeInteger(o.cap) ||
        o.cap < 300 ||
        o.cap > 100000 ||
        typeof o.members !== 'boolean'
    ) {
        throw Error('invalid finite progressive production');
    }
    for (const t of [o.bank, ...(o.site ? [o.site] : [])]) {
        if (!t || ![t.x, t.z, t.level].every(Number.isSafeInteger) || t.x < 0 || t.x > 16383 || t.z < 0 || t.z > 16383 || t.level < 0 || t.level > 3) {
            throw Error('progressive bank/site unknown');
        }
    }
    if (['cooking-prepared', 'burn-bake'].includes(o.mode) && !o.site) throw Error('cooking requires declared native oven site');
}

export function progressiveStage(
    mode: ProgressiveProduction['mode'],
    level: number,
    recipes: readonly InventoryRecipe[] = inventoryRecipes(),
    cooks: readonly CookRecipe[] = cookingRecipes().recipes,
): ProgressiveStage {
    if (!Number.isSafeInteger(level) || level < 1 || level > 99) throw Error('progressive base level unknown');
    if (mode === 'craft-staff' || mode === 'craft-glass') {
        const names = mode === 'craft-staff' ? ['water-battlestaff', 'earth-battlestaff', 'fire-battlestaff', 'air-battlestaff'] : ['glass:beer_glass', 'glass:vial_empty', 'glass:stafforb'];
        const eligible = names
            .map(n => {
                const r = recipes.find(r => r.name === n);
                if (!r || r.skill !== 'Crafting') throw Error('native progressive Crafting descriptor absent ' + n);
                return r;
            })
            .filter(r => r.level <= level)
            .sort((a, b) => b.level - a.level);
        const recipe = eligible[0];
        if (!recipe) throw Error('progressive native staff requires Crafting54');
        return { name: recipe.name, skill: 'Crafting', level: recipe.level, inputs: recipe.inputs, tools: recipe.tools, recipe };
    }
    if (mode === 'cooking-prepared' || mode === 'burn-bake') {
        const key = level < 25 ? 'bread' : level < 41 ? 'stew' : 'cake';
        const recipe = cooks.find(r => r.name === 'cooking_generic_' + key) || cooks.find(r => r.name.endsWith('_' + key));
        if (!recipe || recipe.level > level || !recipe.range) throw Error('native progressive cooking recipe/oven contract absent');
        return { name: recipe.name, skill: 'Cooking', level: recipe.level, inputs: [{ id: recipe.raw, units: 1 }], tools: [], cooking: recipe };
    }
    if (level < 5) {
        if (mode === 'string') throw Error('progressive stringing requires Fletching5');
        return { name: 'shafts', skill: 'Fletching', level: 1, inputs: [{ id: 1511, units: 1 }], tools: [946], shafts: true };
    }
    const prefix = mode === 'fletch' ? 'cut-bow:' : 'bow-string:';
    const recipe = recipes
        .filter(r => r.name.startsWith(prefix) && r.level <= level)
        .sort((a, b) => b.level - a.level)[0];
    if (!recipe) throw Error('native progressive bow recipe absent');
    return { name: recipe.name, skill: 'Fletching', level: recipe.level, inputs: recipe.inputs, tools: recipe.tools, recipe };
}

export function burnBakePreparation(
    stage: ProgressiveStage,
    stock: Record<number, number>,
    floor: Record<number, number>,
    recipes: readonly InventoryRecipe[] = inventoryRecipes(),
) {
    const get = (name: string) => {
        const r = recipes.find(r => r.name === name);
        if (!r) throw Error('native BurnBaking preparation absent ' + name);
        return r;
    };
    const available = (id: number) => (stock[id] ?? 0) - (floor[id] ?? 0);
    let steps: InventoryRecipe[];
    if (stage.name === 'cooking_generic_bread') steps = [get('dough:bread:bucket_water')];
    else if (stage.name === 'cooking_generic_cake') steps = [get('prepare:cake')];
    else if (stage.name === 'cooking_generic_stew') {
        const finishRecipe = available(2142) > 0 ? get('prepare:uncooked-stew') : available(2140) > 0 ? get('prepare:uncooked-stew-chicken') : undefined;
        if (available(1997) > 0 && finishRecipe) steps = [finishRecipe];
        else if (available(1999) > 0 && available(1942) > 0) steps = [get('prepare:uncooked-stew-potato')];
        else if (finishRecipe) steps = [get('prepare:potato-stew'), finishRecipe];
        else throw Error('owned cooked meat/chicken unavailable for BurnBaking stew');
    } else {
        throw Error('unknown native BurnBaking stage');
    }
    const produced = new Set<number>();
    let capacity = 2147483647;
    for (const step of steps) {
        for (const i of step.inputs) if (!produced.has(i.id)) capacity = Math.min(capacity, Math.floor(available(i.id) / i.units));
        produced.add(step.product);
    }
    return { steps, capacity: Math.max(0, capacity) };
}

export async function runProgressiveProduction(
    original: Session,
    o: ProgressiveProduction,
    requested: () => boolean = () => false,
    deps: ProgressiveDeps = {},
    extDeps?: ArtisanExternalDeps,
) {
    validateProgressiveProduction(o);
    const recipes = deps.recipes ?? inventoryRecipes();
    const cooks = deps.cooks ?? cookingRecipes().recipes;
    const skill = o.mode === 'fletch' || o.mode === 'string' ? 'Fletching' : o.mode === 'craft-staff' || o.mode === 'craft-glass' ? 'Crafting' : 'Cooking';
    const first = original.sdk.getState()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const hp = original.sdk.getSkill('Hitpoints')?.level ?? 0;
    const client = original.client;
    const executor = (client as any)?.executeBotAction;
    const start = original.tick();
    let ended = false;
    let lost = false;
    void original.ended.then(() => { ended = true; });
    const fatal = () => {
        const p = original.sdk.getState()?.player;
        if (original.client !== client || (client as any)?.executeBotAction !== executor) lost = true;
        return lost || typeof executor !== 'function' || ended || !p || !first || life === undefined || p.lifeId !== life || (p.respawnCount ?? 0) !== respawns || p.isDead || hp < 1 || (original.sdk.getSkill('Hitpoints')?.level ?? 0) < hp;
    };
    const stop = () => fatal() || productionStopRequested(original.name, requested, existsSync, process.env.STOP_FILE ?? '.practice/stop-microbot-production-progressive') || original.tick() - start >= o.cap - 120;
    const sdk = new Proxy(original.sdk, {
        get(target, key, receiver) {
            const v = Reflect.get(target, key, receiver);
            return typeof v === 'function'
                ? function (...args: unknown[]) {
                      if (typeof key === 'string' && key.startsWith('send') && (fatal() || original.tick() - start >= o.cap)) {
                          throw Error('progressive original input owner/life unavailable');
                      }
                      return v.apply(receiver, args);
                  }
                : v;
        },
    });
    const s = {
        ...original,
        sdk,
        bot: new BotActions(sdk),
        direct: async (action: Parameters<Session['direct']>[0]) => {
            if (fatal() || original.tick() - start >= o.cap) throw Error('progressive direct original owner/life unavailable');
            return original.direct(action);
        },
    } as Session;
    const level = () => s.sdk.getSkill(skill)?.baseLevel ?? 0;
    const initialLevel = level();
    const receipts: { stage: string; levelBefore: number; levelAfter: number; processed: number; products: Record<number, number>; result: unknown }[] = [];
    const preparations: { stage: string; processed: number; result: unknown }[] = [];
    let initial: ProgSnapshot | undefined;
    let final: ProgSnapshot | undefined;
    let processed = 0;
    let failure = '';
    let reason = 'maximum';
    let expected: Record<number, number> = {};
    let floors: Record<number, number> = {};
    let uncertain = false;
    const certificates = certMap();
    const audit =
        deps.audit ??
        (async () => {
            if (fatal() || original.tick() - start >= o.cap - 20) throw Error('progressive audit original life/budget unavailable');
            const at = s.sdk.getState()?.player;
            if (!at || at.level !== o.bank.level || Math.max(Math.abs(at.worldX - o.bank.x), Math.abs(at.worldZ - o.bank.z)) > 3) {
                throw Error('progressive original bank position absent');
            }
            const t = s.tick();
            await s.sdk.sendCloseModal();
            if (!await waitUntil(s, () => fatal() || (s.tick() > t && !s.sdk.getState()?.bank.isOpen && !s.sdk.getState()?.interface.isOpen && !s.sdk.getState()?.dialog.isOpen), { timeoutTicks: 12 }) || fatal()) {
                throw Error('progressive observed modal close absent');
            }
            const g = s.bankObservation?.()?.generation ?? -1;
            if (!(await s.bot.openBank()).success || !await waitUntil(s, () => fatal() || (!!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > g), { timeoutTicks: 12 }) || fatal()) {
                throw Error('progressive fresh bank unavailable');
            }
            const view = () => {
                const b = s.bankObservation?.();
                if (!b || !s.sdk.getState()?.bank.isOpen) throw Error('progressive bank unknown');
                const gear = s.sdk.getEquipment().map(i => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot);
                const assets: Record<number, number> = {};
                for (const i of [...b.items, ...s.sdk.getInventory(), ...gear]) {
                    const id = certificates.get(i.id) ?? i.id;
                    assets[id] = (assets[id] ?? 0) + i.count;
                }
                return { assets, gear };
            };
            const before = view();
            for (const id of new Set(s.sdk.getInventory().map(i => i.id))) {
                if (fatal()) throw Error('progressive deposit owner unavailable');
                const row = s.sdk.getInventory().find(i => i.id === id);
                if (row) await depositObserved(s, row);
            }
            const after = view();
            if (!equalAssets(before.assets, after.assets) || !sameJson(before.gear, after.gear)) throw Error('progressive stock deposit changed assets/gear');
            await s.bot.closeBank();
            return after;
        });
    try {
        if (fatal() || stop() || initialLevel < 1) throw Error('progressive entry life/level/stop unavailable');
        if (o.members && (client as any).membersAccount !== 1) throw Error('progressive member account unknown');
        initial = await audit();
        expected = { ...initial.assets };
        floors = Object.fromEntries(Object.entries(initial.assets).map(([id, n]) => [id, Math.min(n, o.reserve)]));
        while (processed < o.maximum && level() < o.targetLevel) {
            if (stop()) {
                reason = 'stopped';
                throw Error('progressive stopped before next batch');
            }
            const before = await audit();
            if (!equalAssets(expected, before.assets) || !sameJson(initial.gear, before.gear)) throw Error('progressive all-assets/gear drift before batch');
            const stage = progressiveStage(o.mode, level(), recipes, cooks);
            const base = level();
            if (stage.recipe?.members && !o.members) throw Error('progressive recipe requires member account');
            if (stage.tools.some(id => (before.assets[id] ?? 0) < 1)) throw Error('selected progressive tool unavailable');
            let n = Math.min(o.batch, o.maximum - processed, ...stage.inputs.map(i => Math.floor(((before.assets[i.id] ?? 0) - (floors[i.id] ?? 0)) / i.units)));
            if (n < 1 && o.mode === 'burn-bake') {
                const prep = burnBakePreparation(stage, before.assets, floors, recipes);
                n = Math.min(o.batch, o.maximum - processed, prep.capacity);
                if (n < 1) throw Error('selected BurnBaking ingredients/reserve unavailable');
                for (const recipe of prep.steps) {
                    if (stop()) throw Error('BurnBaking stopped before preparation');
                    const known = await audit();
                    if (!equalAssets(expected, known.assets) || !sameJson(initial.gear, known.gear)) throw Error('BurnBaking preparation stock drift');
                    const remaining = o.cap - (s.tick() - start) - 60;
                    if (remaining < 180) throw Error('BurnBaking preparation/cleanup budget unavailable');
                    uncertain = true;
                    const r = await (deps.inventory ?? runInventoryBank)(s, recipe, {
                        maximum: n,
                        maxAttempts: n,
                        cap: remaining,
                        reserve: Math.min(...recipe.inputs.map(i => floors[i.id] ?? 0)),
                        members: o.members,
                        stop,
                    });
                    if (!r.ok || r.attempts !== n || r.losses || r.made !== n || r.banked !== n) throw Error('BurnBaking preparation receipt incomplete');
                    for (const i of recipe.inputs) expected[i.id] = (expected[i.id] ?? 0) - n * i.units;
                    expected[recipe.product] = (expected[recipe.product] ?? 0) + n;
                    for (const i of recipe.byproducts ?? []) expected[i.id] = (expected[i.id] ?? 0) + n * i.units;
                    preparations.push({ stage: recipe.name, processed: n, result: r });
                    final = await audit();
                    if (!equalAssets(expected, final.assets) || !sameJson(initial.gear, final.gear)) throw Error('BurnBaking exact preparation asset receipt invalid');
                    uncertain = false;
                }
            }
            if (n < 1) throw Error('selected progressive tier owned inputs/reserve unavailable');
            const remaining = o.cap - (s.tick() - start) - 60;
            if (remaining < 180) throw Error('progressive batch/cleanup budget unavailable');
            let result: any;
            let products: Record<number, number> = {};
            uncertain = true;
            const reserve = Math.min(...stage.inputs.map(i => floors[i.id] ?? 0));
            if (stage.shafts) {
                const shaftsRunner = deps.shafts ?? defaultShaftsRunner;
                if (!shaftsRunner) throw Error('progressive shafts requires runShafts registration');
                result = await shaftsRunner(s, { cap: remaining, maximum: n, reserve, bankKnife: true, stop });
                if (!result.ok || result.logsUsed !== n || result.made !== n * 15 || result.banked !== result.made) throw Error('progressive shafts batch incomplete');
                products[52] = result.made;
            } else if (stage.recipe) {
                result = await (deps.inventory ?? runInventoryBank)(s, stage.recipe, {
                    maximum: n * (stage.recipe.productUnits ?? 1),
                    maxAttempts: n,
                    cap: remaining,
                    reserve,
                    members: o.members,
                    stop,
                });
                if (!result.ok || result.attempts !== n || result.losses || result.made !== n * (stage.recipe.productUnits ?? 1) || result.banked !== result.made) {
                    throw Error('progressive inventory batch incomplete');
                }
                products[stage.recipe.product] = result.made;
                for (const p of stage.recipe.byproducts ?? []) products[p.id] = n * p.units;
            } else {
                const r = stage.cooking!;
                const cookRunner = deps.cook ?? (extDeps?.runBankJob as typeof deps.cook) ?? defaultBankJobRunner;
                if (!cookRunner) throw Error('progressive cooking requires runBankJob dependency');
                result = await cookRunner(s, { family: 'cooking', recipe: r.name, target: n, batch: n, cap: remaining, returnTicks: 120, members: o.members, reserve, bank: o.bank, site: o.site, heat: 'range' }, stop);
                if (!result.ok || !result.atBank || result.completed !== n) throw Error('progressive prepared cooking batch incomplete');
                products = { ...result.banked };
                const expectedProducts = [...r.products, ...(r.burnt === undefined ? [] : [r.burnt])];
                if (
                    expectedProducts.reduce((sum, id) => sum + (products[id] ?? 0), 0) !== n ||
                    Object.keys(products).some(id => !expectedProducts.includes(+id) && +id !== r.additional) ||
                    (r.additional !== undefined && (products[r.additional] ?? 0) !== n)
                ) {
                    throw Error('progressive cooking product/container receipt invalid');
                }
            }
            for (const i of stage.inputs) expected[i.id] = (expected[i.id] ?? 0) - n * i.units;
            for (const [id, count] of Object.entries(products)) expected[+id] = (expected[+id] ?? 0) + count;
            processed += n;
            receipts.push({ stage: stage.name, levelBefore: base, levelAfter: level(), processed: n, products, result });
            final = await audit();
            if (!equalAssets(expected, final.assets) || !sameJson(initial.gear, final.gear)) throw Error('progressive exact batch asset/gear receipt invalid');
            uncertain = false;
        }
        reason = level() >= o.targetLevel ? 'target-level' : 'maximum';
    } catch (error) {
        failure = String(error);
    } finally {
        if (initial && !fatal() && !uncertain) {
            try {
                final = await audit();
            } catch (error) {
                failure ||= String(error);
            }
        }
    }
    const preserved = !uncertain && !fatal() && !!initial && !!final && equalAssets(expected, final.assets) && sameJson(initial.gear, final.gear);
    const targetMet = level() >= o.targetLevel;
    return {
        ok: !failure && !fatal() && preserved && !uncertain && (targetMet || processed === o.maximum),
        mode: o.mode,
        skill,
        processed,
        initialLevel,
        finalLevel: level(),
        targetMet,
        stop: reason,
        receipts,
        preparations,
        preserved,
        banked: !!final && !uncertain,
        uncertain,
        ticks: s.tick() - start,
        failure: failure || '-',
        scope:
            o.mode === 'burn-bake'
                ? 'owned bank ingredient preparation or prepared raw food, bread/stew/cake level selection, native oven and bank return; no external ingredient acquisition'
                : o.mode === 'cooking-prepared'
                  ? 'prepared bread/stew/cake level selection and native oven/bank route; no ingredient acquisition/preparation claim'
                  : o.mode === 'craft-staff' || o.mode === 'craft-glass'
                    ? 'automatic native water/earth/fire/air battlestaff or beer-glass/vial/orb tiers; modern lamp, fishbowl, lens and light-orb glass not supplied; no lower-tier stock fallback'
                    : 'automatic native legacy level selection; no lower-tier stock fallback',
    };
}

export async function runProgressiveProductionCli(
    actor: string,
    restArgs: readonly string[],
    deps?: ArtisanExternalDeps,
) {
    const file = restArgs[0];
    if (!actor || !file) throw Error('usage: microbot-production-progressive.ts account finite-policy.json');
    const o = JSON.parse(readFileSync(file, 'utf8')) as ProgressiveProduction;
    validateProgressiveProduction(o);
    inventoryRecipes();
    cookingRecipes();
    let stopped = false;
    process.once('SIGINT', () => { stopped = true; });
    process.once('SIGTERM', () => { stopped = true; });
    const s = await openBot(actor);
    try {
        const result = await runProgressiveProduction(s, o, () => stopped, {}, deps);
        console.log('PROGRESSIVE_PRODUCTION ' + JSON.stringify(result));
        process.exitCode = (await settle([s], result.ok, JSON.stringify(result))) ? 0 : 1;
    } catch (error) {
        await settle([s], false, String(error));
        throw error;
    }
}

// ---- Tanner (microbot-c-tanner.ts) ----

export const tanningRecipes = {
    soft: { input: 1739, output: 1741, cost: 1, button: 'tanner:com_96' },
    hard: { input: 1739, output: 1743, cost: 3, button: 'tanner:com_101' },
    green: { input: 1753, output: 1745, cost: 20, button: 'tanner:com_106' },
    blue: { input: 1751, output: 2505, cost: 20, button: 'tanner:com_111' },
    red: { input: 1749, output: 2507, cost: 20, button: 'tanner:com_116' },
    black: { input: 1747, output: 2509, cost: 20, button: 'tanner:com_121' },
} as const;

export type TanKind = keyof typeof tanningRecipes;
type TanAssets = { input: number; output: number; coins: number };

export function tanningEffect(before: TanAssets, after: TanAssets, cost: number): boolean {
    return before.input - after.input === 1 && after.output - before.output === 1 && before.coins - after.coins === cost;
}

export async function tanInventory(s: Session, kind: TanKind, maximum: number, cap: number, stop: () => boolean = () => false) {
    if (!Object.hasOwn(tanningRecipes, kind) || !Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(cap) || cap < 1) {
        throw Error('invalid tanning order');
    }
    const r = tanningRecipes[kind];
    const start = s.tick();
    const count = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const assets = (): TanAssets => ({ input: count(r.input), output: count(r.output), coins: count(995) });
    const initial = assets();
    const protectedItems = new Map<number, number>();
    for (const i of s.sdk.getInventory()) if (![r.input, r.output, 995].includes(i.id)) protectedItems.set(i.id, count(i.id));
    const life = watchProductionLife(s, stop);
    const over = () => life.stopped() || s.tick() - start >= cap;
    let made = 0;
    let detail = '';
    try {
        if (initial.input < maximum || initial.coins < maximum * r.cost) throw Error('staged tanning supplies short');
        while (made < maximum && !over()) {
            const npc = s.sdk.getState()?.nearbyNpcs.find(n => /^Tanner$/i.test(n.name));
            if (!npc) throw Error('Al Kharid Tanner must be nearby');
            const before = assets();
            const traded = await s.sdk.sendInteractNpc(npc.index, 3);
            if (!traded.success) throw Error('tanner trade refused');
            if (!await waitUntil(s, () => !!s.sdk.getState()?.interface?.isOpen || over(), { timeoutTicks: Math.min(8, Math.max(1, cap - (s.tick() - start))) })) {
                throw Error('tanning interface timeout');
            }
            if (over()) break;
            await s.sdk.sendClickComponent(componentId(r.button));
            await waitUntil(s, () => tanningEffect(before, assets(), r.cost) || over(), { timeoutTicks: Math.min(8, Math.max(1, cap - (s.tick() - start))) });
            if (!tanningEffect(before, assets(), r.cost)) throw Error('tanning item/coin reconciliation failed');
            made++;
        }
        if (made !== maximum) throw Error('tanning budget or stop');
    } catch (error) {
        detail = String(error);
    }
    const final = assets();
    const preserved = [...protectedItems].every(([id, n]) => count(id) === n);
    const conserved = initial.input - final.input === made && final.output - initial.output === made && initial.coins - final.coins === made * r.cost;
    detail ||= life.reason();
    return { ok: !detail && made === maximum && preserved && conserved, made, coinsSpent: initial.coins - final.coins, preserved, conserved, ticks: s.tick() - start, detail };
}

export async function runTanningCli(botName: string, restArgs: readonly string[]) {
    const kind = restArgs[0] as TanKind;
    const maximum = Number(restArgs[1] ?? 1);
    const cap = Number(restArgs[2] ?? 80);
    if (!botName || !Object.hasOwn(tanningRecipes, kind) || !Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(cap) || cap < 1) {
        throw Error('Usage: bun scripts/aio-skiller.ts <account> artisan crafting tanning <soft|hard|green|blue|red|black> [quantity] [ticks]');
    }
    let stopped = false;
    process.once('SIGINT', () => { stopped = true; });
    process.once('SIGTERM', () => { stopped = true; });
    const s = await openBot(botName);
    let ok = false;
    try {
        const result = await tanInventory(s, kind, maximum, cap, () => stopped);
        console.log('TANNING_RESULT ' + JSON.stringify(result));
        ok = result.ok;
    } finally {
        ok = await settle([s], ok, 'finite tanning order');
    }
    process.exitCode = ok ? 0 : 1;
}

// ---- Soften Clay (soften-clay.ts) ----

const CLAY = 434;
const SOFT = 1761;
const BUCKET = 1925;
const WATER = 1929;
const CLAY_BANK = { x: 3185, z: 3436 };
const FOUNTAIN = { x: 3190, z: 3468 };

export function planSoftClay(raw: number, maximum: number, reserve: number) {
    return Math.max(0, Math.min(maximum, raw - reserve));
}

export async function softenOne(s: Session, fountain: NearbyLoc, over: () => boolean) {
    const held = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const before = { raw: held(CLAY), soft: held(SOFT), bucket: held(BUCKET) + held(WATER) };
    if (!before.raw || !before.bucket || over()) return false;
    if (!held(WATER)) {
        const bucket = s.sdk.getInventory().find(i => i.id === BUCKET)!;
        await s.sdk.sendUseItemOnLoc(bucket.slot, fountain.x, fountain.z, fountain.id);
        await waitUntil(s, () => held(WATER) > 0 || over(), { timeoutTicks: 5 });
    }
    if (!held(WATER) || over()) return false;
    const clay = s.sdk.getInventory().find(i => i.id === CLAY)!;
    const water = s.sdk.getInventory().find(i => i.id === WATER)!;
    await s.sdk.sendUseItemOnItem(clay.slot, water.slot);
    await waitUntil(s, () => held(SOFT) > before.soft || over(), { timeoutTicks: 5 });
    const made = held(SOFT) - before.soft;
    const used = before.raw - held(CLAY);
    if (made || used) {
        if (made !== 1 || used !== 1 || held(BUCKET) + held(WATER) !== before.bucket || !held(BUCKET)) {
            throw new Error('soft clay input/output/bucket accounting mismatch');
        }
        return true;
    }
    return false;
}

export async function runSoftenClay(s: Session, options: { cap: number; maximum: number; reserve: number }) {
    if (![options.cap, options.maximum, options.reserve].every(Number.isSafeInteger) || options.cap <= 0 || options.maximum <= 0 || options.reserve < 0) {
        throw new Error('invalid soft clay cap/maximum/reserve');
    }
    const start = s.tick();
    const inv = () => s.sdk.getInventory();
    let ended = false;
    let died = false;
    let hpMin = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const player = s.sdk.getState()?.player;
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        hpMin = Math.min(hpMin, s.sdk.getSkill('Hitpoints')?.level ?? hpMin);
        if (p?.isDead || hpMin <= 0 || (p?.respawnCount ?? 0) > (player?.respawnCount ?? 0) || (player?.lifeId !== undefined && (p?.lifeId ?? player.lifeId) !== player.lifeId)) {
            died = true;
        }
    });
    const over = () => ended || died || s.tick() - start >= options.cap;
    const walk = async (x: number, z: number) => {
        const r = await walkPath(await sessionWalker(s), [{ x, z, tol: 1 }], { maxTicks: 250, stop: () => ended || died });
        if (!r.ok) throw new Error(`soft clay route: ${r.detail}`);
    };
    const open = async () => {
        if (!(await s.bot.openBank()).success) throw new Error('soft clay bank failed');
        await waitTicks(s, 1);
    };
    const deposit = async () => {
        for (const id of new Set(inv().filter(i => i.id === CLAY || i.id === SOFT).map(i => i.id))) {
            await s.bot.depositItem(inv().find(i => i.id === id)!, -1);
        }
        await waitTicks(s, 1);
    };
    const bankCount = (id: number) => (s.sdk.getState()?.bank?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const assets = () => {
        const counts = new Map<number, number>();
        for (const i of [...inv(), ...(s.sdk.getState()?.bank?.items ?? [])]) counts.set(i.id, (counts.get(i.id) ?? 0) + i.count);
        return counts;
    };
    let made = 0;
    let banked = 0;
    let planned = 0;
    let output0 = 0;
    let failure = '';
    let stop = 'input-insufficient';
    let initial = new Map<number, number>();
    try {
        await open();
        await deposit();
        initial = assets();
        output0 = bankCount(SOFT);
        planned = planSoftClay(bankCount(CLAY), options.maximum, options.reserve);
        if (planned && !over()) {
            if (!held(BUCKET) && !held(WATER)) await s.bot.withdrawItem(/^bucket$/i, 1, { asNote: false });
            if (!held(BUCKET) && !held(WATER)) throw new Error('no soft clay progress: owned bucket missing');
            await s.bot.withdrawItem(/^clay$/i, planned, { asNote: false });
            if (held(CLAY) !== planned) throw new Error('no soft clay progress: incomplete clay withdrawal');
            await s.bot.closeBank();
            await walk(FOUNTAIN.x, FOUNTAIN.z);
            let misses = 0;
            while (made < planned && !over()) {
                if (s.sdk.getDialog()?.isOpen || s.sdk.getState()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                const fountain = s.sdk.getState()?.nearbyLocs.find(l => l.id === 879 && l.x === FOUNTAIN.x && l.z === FOUNTAIN.z && l.level === 0);
                if (!fountain) throw new Error('no soft clay progress: public fountain not observed');
                if (await softenOne(s, fountain, over)) {
                    made++;
                    misses = 0;
                } else if (++misses >= 3) {
                    throw new Error('no soft clay progress: three failed conversions');
                }
            }
            stop = made === options.maximum ? 'max-make' : over() ? 'cap' : 'input-insufficient';
        }
    } catch (e) {
        failure = String(e);
    } finally {
        if (!ended && !died) {
            try {
                await walk(CLAY_BANK.x, CLAY_BANK.z);
                await open();
                await deposit();
                banked = Math.max(0, bankCount(SOFT) - output0);
            } catch (e) {
                failure ||= String(e);
            }
        }
        off();
    }
    const final = assets();
    const protectedIds = [...initial].filter(([id]) => ![CLAY, SOFT, BUCKET, WATER].includes(id));
    const bucketTotal = (final.get(BUCKET) ?? 0) + (final.get(WATER) ?? 0);
    const originalBuckets = (initial.get(BUCKET) ?? 0) + (initial.get(WATER) ?? 0);
    const preserved = !!initial.size && protectedIds.every(([id, n]) => (final.get(id) ?? 0) >= n) && bucketTotal === originalBuckets;
    const reserveMet = bankCount(CLAY) >= options.reserve;
    if (!preserved || made !== banked || held(CLAY) || held(SOFT) || !reserveMet) failure ||= 'soft clay final bank/assets proof failed';
    const r = {
        ok: !failure && !died && !ended,
        ticks: s.tick() - start,
        made,
        banked,
        planned,
        rawBank: bankCount(CLAY),
        softBank: bankCount(SOFT),
        bucketTotal,
        preserved,
        reserveMet,
        targetMet: !failure && !died && !ended && preserved && reserveMet && made === options.maximum && banked === made,
        stop,
        hpMin,
        died,
        failure: failure || '-',
    };
    console.log(`SOFT_CLAY_BANK ${JSON.stringify(r)}`);
    return r;
}

export async function runSoftenClayCli(botName: string, _restArgs: readonly string[], env: Record<string, string | undefined> = process.env) {
    const s = await openBot(botName);
    try {
        const r = await runSoftenClay(s, {
            cap: Number(env.CAP ?? 500),
            maximum: Number(env.MAX_MAKE ?? 20),
            reserve: Number(env.RAW_RESERVE ?? 0),
        });
        await finish([s], r.ok, `softClay ${Object.entries(r).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

// ---- Black Dragonhide Sets (black-dhide-sets.ts) ----

export const BLACK_HIDE = tanningRecipes.black.input;
export const BLACK_LEATHER = tanningRecipes.black.output;
export const TAN_COST = tanningRecipes.black.cost;
export const NEEDLE = 1733;
export const THREAD = 1734;
export const COINS = 995;
export const THREAD_MAKES = 5;

export const SET_PIECES = [
    { recipe: 'leather:black_dragonhide_body', product: 2503, leather: 3, level: 84 },
    { recipe: 'leather:black_dragonhide_chaps', product: 2497, leather: 2, level: 82 },
    { recipe: 'leather:black_dragon_vambraces', product: 2491, leather: 1, level: 79 },
] as const;

export type DhidePiece = 'body' | 'chaps' | 'vambraces';
const PIECE_BY_NAME: Readonly<Record<DhidePiece, (typeof SET_PIECES)[number]>> = {
    body: SET_PIECES[0],
    chaps: SET_PIECES[1],
    vambraces: SET_PIECES[2],
};
export const SET_LEATHER = SET_PIECES.reduce((n, p) => n + p.leather, 0);
export const SET_LEVEL = Math.max(...SET_PIECES.map(p => p.level));
export const TAN_TRIP = 27;
export const SHOP_COINS = 100;
const AL_KHARID_BANK = { x: 3269, z: 3167, level: 0 };
const TANNER = { x: 3274, z: 3191, level: 0 };
const DOMMIK = { x: 3320, z: 3194, level: 0 };

function planFor(
    pieces: readonly (typeof SET_PIECES)[number][],
    want: number,
    hides: number,
    leather: number,
    thread: number,
    coins: number,
): { count: number; tan: number; thread: number; coins: number } {
    if (![want, hides, leather, thread, coins].every(n => Number.isSafeInteger(n) && n >= 0)) return { count: 0, tan: 0, thread: 0, coins: 0 };
    const totalLeather = pieces.reduce((n, p) => n + p.leather, 0);
    let count = Math.floor((hides + leather) / totalLeather);
    if (want > 0) count = Math.min(count, want);
    const cost = (n: number) => {
        const tan = Math.max(0, n * totalLeather - leather);
        const buy = Math.max(0, Math.ceil((n * pieces.length) / THREAD_MAKES) + 1 - thread);
        return { count: n, tan, thread: buy, coins: tan * TAN_COST + (buy > 0 ? SHOP_COINS : 0) };
    };
    while (count > 0 && cost(count).coins > coins) count--;
    return cost(count);
}

export function setPlan(want: number, hides: number, leather: number, thread: number, coins: number): { sets: number; tan: number; thread: number; coins: number } {
    const r = planFor(SET_PIECES, want, hides, leather, thread, coins);
    return { sets: r.count, tan: r.tan, thread: r.thread, coins: r.coins };
}

export function piecePlan(piece: DhidePiece, want: number, hides: number, leather: number, thread: number, coins: number): { count: number; tan: number; thread: number; coins: number } {
    return planFor([PIECE_BY_NAME[piece]], want, hides, leather, thread, coins);
}

export async function runBlackDhideSetsCli(
    botName: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
    deps?: ArtisanExternalDeps,
) {
    if (!deps?.openQuest) throw Error('black-dhide-sets requires deps.openQuest');
    const argEnv = Object.fromEntries(
        restArgs.flatMap(a => {
            const m = a.match(/^([A-Z_]+)=(.*)$/);
            return m ? [[m[1]!, m[2]!]] : [];
        }),
    );
    const want = Number(argEnv.SETS ?? env.SETS ?? 0);
    const pieceName = (argEnv.PIECE ?? env.PIECE)?.trim().toLowerCase() as DhidePiece | '' | undefined;
    const selected = pieceName ? (pieceName in PIECE_BY_NAME ? [PIECE_BY_NAME[pieceName as DhidePiece]] : null) : [...SET_PIECES];
    const q = await deps.openQuest({ name: botName, cap: 4000, eatAt: 50, lumbridgeOk: true });
    try {
        if (!selected) await q.fail(`unknown PIECE=${pieceName}`);
        if (!Number.isSafeInteger(want) || want < 0 || want > 50) await q.fail('SETS 0-50');
        const s: Session = q.s;
        const start = s.tick();
        const held = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        const banked = (id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        const level = s.sdk.getSkill('Crafting')?.level ?? 1;
        const reqLevel = Math.max(...selected!.map(p => p.level));
        const leatherPer = selected!.reduce((n, p) => n + p.leather, 0);
        if (level < reqLevel) await q.fail(`Crafting ${level}, ${pieceName || 'a set'} asks ${reqLevel}`);
        const openBank = async (label: string) => {
            const generation = s.bankObservation?.()?.generation ?? 0;
            if (!(await s.bot.openBank()).success || !await q.waitUntil(() => !!q.st()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, 20)) {
                await q.fail(`${label}: bank did not open`);
            }
        };
        const closeBank = async () => {
            await s.bot.closeBank();
            await q.waitUntil(() => !q.st()?.bank?.isOpen, 10);
            await q.waitTicks(2);
        };
        const bankPack = async (label: string) => {
            for (const id of new Set(s.sdk.getInventory().map(i => i.id))) {
                const row = s.sdk.getInventory().find(i => i.id === id);
                if (row && (!(await s.bot.depositItem(row, held(id))).success || !await q.waitUntil(() => held(id) === 0, 10))) {
                    await q.fail(`${label}: deposit of item ${id}`);
                }
            }
        };
        const take = async (id: number, n: number) => {
            if (n < 1) return;
            const row = (q.st()?.bank?.items ?? []).find((i: { id: number }) => i.id === id);
            const before = held(id);
            if (!row || banked(id) < n) await q.fail(`withdraw: ${n} of item ${id} short in the bank (${banked(id)} banked)`);
            if (!(await s.bot.withdrawItem(row!, n, { asNote: false })).success || !await q.waitUntil(() => held(id) >= before + n, 10)) {
                await q.fail(`withdraw ${n} of item ${id}`);
            }
        };
        const go = async (to: { x: number; z: number; level: number }, label: string) => {
            const out = deps.walkTargetPersist
                ? await deps.walkTargetPersist(s, to)
                : await walkPath(await sessionWalker(s), [{ x: to.x, z: to.z, tol: 1 }]);
            const reason = 'reason' in out && typeof out.reason === 'string' ? out.reason : '';
            if (!out.ok) await q.fail(`route to ${label}: ${reason} ${out.detail ?? ''}`);
        };
        await go(AL_KHARID_BANK, 'the Al Kharid bank');
        await openBank('stage');
        await bankPack('stage');
        const plan = planFor(selected!, want, banked(BLACK_HIDE), banked(BLACK_LEATHER), banked(THREAD), banked(COINS));
        const needle = banked(NEEDLE) < 1;
        if (plan.count < 1) {
            await closeBank();
            await q.fail(`no craft: ${banked(BLACK_HIDE)} hides, ${banked(BLACK_LEATHER)} leather, ${banked(COINS)} coins, asks ${leatherPer} leather`);
        }
        q.milestone(`plan ${pieceName || 'sets'}=${plan.count} tan=${plan.tan} thread=${plan.thread}`);
        let tanned = 0;
        let spent = 0;
        while (tanned < plan.tan) {
            const n = Math.min(TAN_TRIP, plan.tan - tanned);
            await take(BLACK_HIDE, n);
            await take(COINS, n * TAN_COST);
            await closeBank();
            await go(TANNER, 'the tanner');
            const r = await tanInventory(s, 'black', n, 60 + n * 12);
            tanned += r.made;
            spent += r.coinsSpent;
            if (!r.ok) await q.fail(`tanning: ${r.detail} made=${r.made} of ${n}`);
            await go(AL_KHARID_BANK, 'the Al Kharid bank');
            await openBank('tanned');
            await bankPack('tanned');
        }
        if (plan.tan) q.milestone(`tanned ${tanned}`);
        if (needle || plan.thread > 0) {
            await take(COINS, Math.min(SHOP_COINS, banked(COINS)));
            await closeBank();
            await go(DOMMIK, "Dommik's store");
            const shop = await s.bot.openShop(/^dommik$/i);
            if (!shop.success) await q.fail(`dommik shop: ${shop.message}`);
            const coins = held(COINS);
            if (needle) {
                await s.bot.buyFromShop(/^needle$/i, 1);
                await q.waitUntil(() => held(NEEDLE) > 0, 6);
            }
            if (plan.thread > 0) {
                await s.bot.buyFromShop(/^thread$/i, plan.thread);
                await q.waitUntil(() => held(THREAD) >= plan.thread, 6);
            }
            await s.bot.closeShop();
            await q.waitTicks(2);
            spent += coins - held(COINS);
            if ((needle && held(NEEDLE) < 1) || held(THREAD) < plan.thread) {
                await q.fail(`dommik: needle=${held(NEEDLE)} thread=${held(THREAD)} of ${plan.thread}`);
            }
            q.milestone('needle and thread');
            await go(AL_KHARID_BANK, 'the Al Kharid bank');
            await openBank('shop');
            await bankPack('shop');
        }
        await closeBank();
        const made: number[] = [];
        for (const piece of selected!) {
            const recipe = inventoryRecipes().find(r => r.name === piece.recipe);
            if (!recipe) await q.fail(`no recipe ${piece.recipe}`);
            const r = await runInventoryBank(s, recipe!, { maximum: plan.count, cap: 100 + plan.count * 40, maxAttempts: plan.count, members: true });
            made.push(r.made);
            if (!r.ok) await q.fail(`craft ${piece.recipe}: ${r.failure} made=${r.made} of ${plan.count}`);
        }
        await openBank('end');
        await bankPack('end');
        const sets = Math.min(...selected!.map(p => banked(p.product)));
        const hidesLeft = banked(BLACK_HIDE);
        const leatherLeft = banked(BLACK_LEATHER);
        await closeBank();
        const detail = selected!.map((p, idx) => `${p.recipe.endsWith('body') ? 'bodies' : p.recipe.endsWith('chaps') ? 'chaps' : 'vambraces'}=${made[idx]}`).join(' ');
        await q.end(
            made.every(n => n === plan.count),
            `sets=${plan.count} banked=${sets} ${detail} tanned=${tanned} spent=${spent} hidesLeft=${hidesLeft} leatherLeft=${leatherLeft} crafting=${s.sdk.getSkill('Crafting')?.level ?? 0} ticks=${s.tick() - start}`,
        );
    } catch (e) {
        await q.fail(String(e));
    }
}
