// Dispatcher for unified bank-artisan WorkerModule<ArtisanConfig> in-session and CLI runs.
import { sessionWalker, walkPath } from '../../../core/src/walk';
import {
    cookingRecipes,
    runCookingBatch,
    runCookingCli,
    runCookFood,
    runCookStock,
    runGeCooking,
    runMixedWine,
    runWineSession,
    validateGeCookingOrder,
} from './cooking';
import {
    glassSupplyOptions,
    inventoryRecipes,
    jewelleryOrderFromEnv,
    jewelleryRecipes,
    registerDefaultBankJobRunner,
    registerDefaultJewelleryBankJobRunner,
    registerDefaultShaftsRunner,
    runBankedGlass,
    runBlackDhideSetsSession,
    runCraftingCli,
    runFurnaceGlass,
    runInventoryBank,
    runJewellery,
    runJewelleryOrder,
    runLegacyCraftJewelryCli,
    runProgressiveProduction,
    runSoftenClay,
    runSpinBowstrings,
    tanInventory,
    type InventoryRecipe,
    type JewelleryOrder,
    type ProgressiveProduction,
    type TanKind,
} from './crafting';
import {
    firemakingOptions,
    geFiremakingOptions,
    LOGS,
    runFiremaking,
    runFiremakingCli,
    runGeFiremaking,
    type LogKind,
} from './firemaking';
import {
    type ArrowMetal,
    nativeArrowProfile,
    runFletchingCli,
    runHeadless,
    runNativeArrows,
    runOakBows,
    runShafts,
    runSteel,
    runWoodProductDrop,
} from './fletching';
import {
    depositMiscCoffer,
    dropQolItems,
    enableQolRun,
    enableSpecial,
    fillDruidPouch,
    holdPrayer,
    kittenCare,
    refillCannon,
    runForagingQolCli,
    weedMiscellania,
} from './foraging-qol';
import { brew, herbloreOptions, runDruidMeats, runHerbloreCli } from './herblore';
import {
    chargeInventory,
    itemMagicRecipe,
    nativeTeleport,
    type OrbKind,
    orbOptions,
    orbRecipes,
    runAlch,
    runBonesBank,
    runEarthProduction,
    runItemMagic,
    runMagicBankTrips,
    runMagicCli,
    runOrbTrips,
    runTeleportMagic,
    type MagicBankJob,
} from './magic';
import { prayerOptions, runPrayer, runPrayerCli } from './prayer';
import { readJobJson, resolveArgSetting } from './runtime';
import {
    runBronze,
    runCannonballs,
    runSmeltBatch,
    runSmithBatch,
    runSmithingCli,
    smeltBonusFromEnv,
    smeltRouteFromEnv,
    type SmeltOrder,
    validateSmeltOrder,
} from './smithing';
import {
    ARTISAN_METHOD_MAP,
    type ArtisanConfig,
    type ArtisanSessionOutcome,
    normalizeArtisanConfig,
    resolveArtisanSetting,
    type Session,
    VALID_ARTISAN_SKILLS,
} from './types';

function ensureRegisteredCrossRunners(deps?: ArtisanConfig['deps']) {
    registerDefaultShaftsRunner(runShafts);
    if (deps?.runBankJob) {
        registerDefaultBankJobRunner(deps.runBankJob as any);
        registerDefaultJewelleryBankJobRunner(deps.runBankJob as any);
    }
}

export async function runArtisan(
    s: Session,
    rawCfg: ArtisanConfig,
    stop: () => boolean = () => false,
): Promise<ArtisanSessionOutcome> {
    const cfg = normalizeArtisanConfig(rawCfg);
    ensureRegisteredCrossRunners(cfg.deps);
    if (!VALID_ARTISAN_SKILLS.includes(cfg.skill)) {
        return { ok: false, summary: `unknown artisan skill: ${String(rawCfg.skill)}`, ticks: 0, produced: 0, failure: 'invalid_config' };
    }
    const validMethods = ARTISAN_METHOD_MAP[cfg.skill] as readonly string[];
    if (!validMethods.includes(cfg.method)) {
        return { ok: false, summary: `unknown ${cfg.skill} method: ${String(rawCfg.method)}`, ticks: 0, produced: 0, failure: 'invalid_config' };
    }

    const halted = () => stop() || !!cfg.stop?.();
    const startTick = s.tick();
    const setting = (key: string, fallback?: string) =>
        resolveArtisanSetting(cfg, key, resolveArgSetting(cfg.args, cfg.env, key) ?? fallback);

    try {
        switch (cfg.skill) {
            case 'cooking': {
                if (cfg.method === 'food') {
                    const cap = Number(cfg.args[0] ?? setting('CAP', '15000'));
                    const foodType = (setting('FOOD_TYPE', cfg.args[1]) ?? 'lobster').toLowerCase();
                    const r = await runCookFood(s, foodType, cap, halted);
                    return { ok: r.ok, summary: `cooked=${r.cookedTotal}`, ticks: r.ticks, produced: r.cookedTotal, failure: r.ok ? undefined : 'cook-food incomplete' };
                }
                if (cfg.method === 'stock') {
                    const cap = Number(cfg.args[0] ?? setting('CAP', '15000'));
                    const reserve = Number(setting('RAW_RESERVE', '50'));
                    const maximum = Number(setting('MAX_COOK', '28'));
                    const route = (setting('COOK_ROUTE', 'near') ?? 'near').toLowerCase() as 'near' | 'north' | 'far';
                    const r = await runCookStock(s, { cap, reserve, maximum, route, stop: halted });
                    return { ok: r.ok, summary: `processed=${r.processed} banked=${r.banked}`, ticks: r.ticks, produced: r.banked, failure: r.ok ? undefined : r.failure || r.summary };
                }
                if (cfg.method === 'wine') {
                    const target = Number(cfg.args[0] ?? setting('TARGET_LEVEL', '35'));
                    const cap = Number(cfg.args[1] ?? setting('CAP', '300'));
                    const r = await runWineSession(s, { target, cap });
                    return { ok: r.ok, summary: `targetMet=${r.targetMet} level=${r.level}`, ticks: r.ticks, produced: r.targetMet ? 1 : 0, failure: r.ok ? undefined : r.detail || 'wine session incomplete' };
                }
                if (cfg.method === 'mixed-wine') {
                    const maximum = Number(setting('MAX_MAKE', cfg.args[0] ?? '1'));
                    const cap = Number(setting('CAP', cfg.args[1] ?? '500'));
                    const reserve = Number(setting('RAW_RESERVE', '0'));
                    const r = await runMixedWine(s, maximum, cap, halted, reserve, { runInventoryBank });
                    return { ok: r.ok, summary: `good=${r.good} bad=${r.bad}`, ticks: r.ticks, produced: r.good, failure: r.ok ? undefined : r.failure };
                }
                if (cfg.method === 'ge-cook') {
                    const order = {
                        recipe: setting('RECIPE', cfg.args[0]) ?? 'cooking_generic_trout',
                        target: Number(setting('TARGET', '14')),
                        batch: Number(setting('BATCH', '14')),
                        cap: Number(setting('CAP', '600')),
                        returnTicks: Number(setting('RETURN_TICKS', '120')),
                        members: setting('MEMBERS') === '1',
                        reserve: Number(setting('RESERVE', '0')),
                        log: (setting('LOG', cfg.args[1]) ?? 'normal') as LogKind,
                        maximumFires: Number(setting('MAX_FIRES', '3')),
                    };
                    validateGeCookingOrder(order);
                    const { runBankJob } = { runBankJob: cfg.deps?.runBankJob };
                    const r = await runGeCooking(s, order, halted, {
                        light: (sess, o) => runFiremaking(sess as Session, o),
                        cook: runBankJob
                            ? (sess, job, st) => runBankJob(sess, job, st)
                            : async () => {
                                  throw Error('ge-cook requires deps.runBankJob');
                              },
                    });
                    return { ok: r.ok, summary: `completed=${r.completed}`, ticks: r.ticks, produced: r.completed, failure: r.ok ? undefined : r.failure };
                }
                const recipeName = setting('RECIPE', cfg.args[0]) ?? 'cooking_generic_trout';
                const recipe = cookingRecipes().recipes.find(r => r.name === recipeName);
                if (!recipe) throw Error(`unknown cooking recipe: ${recipeName}`);
                const maximum = Number(setting('MAX_MAKE', '1'));
                const r = await runCookingBatch(
                    {
                        state: () => s.sdk.getState(),
                        tick: () => s.tick(),
                        stop: halted,
                        close: async () => { await s.sdk.sendCloseModal(); },
                        heat: async slot => {
                            const loc = s.sdk.getState()?.nearbyLocs.find(l => l.distance <= 3 && l.reachable !== false);
                            if (!loc) return false;
                            return (await s.sdk.sendUseItemOnLoc(slot, loc.x, loc.z, loc.id)).success;
                        },
                        wait: (test, ticks) => import('../../../core/src/ticks').then(m => m.waitUntil(s, test, { timeoutTicks: ticks })),
                        step: () => import('../../../core/src/ticks').then(m => m.waitTicks(s, 1)),
                    },
                    recipe,
                    { maximum, cap: Number(setting('CAP', '200')), heat: (setting('HEAT', 'range') as 'range' | 'fire') },
                );
                const batchOk = r.processed >= maximum;
                return { ok: batchOk, summary: `cooked=${r.cooked} burnt=${r.burnt}`, ticks: r.ticks, produced: r.cooked, failure: batchOk ? undefined : 'cooking batch incomplete' };
            }
            case 'firemaking': {
                if (cfg.method === 'ge') {
                    const opts = geFiremakingOptions(cfg.env);
                    const r = await runGeFiremaking(s, opts, halted);
                    return { ok: r.ok, summary: `logsBurnt=${r.logsBurnt}`, ticks: r.ticks, produced: r.logsBurnt, failure: r.ok ? undefined : r.failure };
                }
                const o = firemakingOptions(cfg.env);
                const r = await runFiremaking(s, o);
                return { ok: r.ok, summary: `logsBurnt=${r.logsBurnt}`, ticks: r.ticks, produced: r.logsBurnt, failure: r.ok ? undefined : r.failure };
            }
            case 'fletching': {
                if (cfg.method === 'shafts' || setting('MODE', cfg.args[1]) === 'shafts') {
                    const r = await runShafts(s, {
                        cap: Number(cfg.args[0] ?? setting('CAP', '600')),
                        maximum: Number(setting('MAX_MAKE', '25')),
                        reserve: Number(setting('LOG_RESERVE', '0')),
                        bankKnife: setting('BANK_KNIFE') === '1',
                        stop: halted,
                    });
                    return { ok: r.ok, summary: `made=${r.made}`, ticks: r.ticks, produced: r.made, failure: r.ok ? undefined : r.failure };
                }
                if (cfg.method === 'worker' && cfg.args[0] === '--drop-product') {
                    const r = await runWoodProductDrop(s, Number(cfg.args[1]), Number(cfg.args[2]), Number(setting('CAP', '200')), halted);
                    return { ok: r.ok, summary: `dropped=${r.dropped}`, ticks: r.ticks, produced: r.dropped, failure: r.ok ? undefined : r.failure };
                }
                const mode = (setting('MODE', cfg.args[1]) ?? 'headless').toLowerCase();
                const cap = Number(cfg.args[0] ?? setting('CAP', '1500'));
                if (mode === 'headless') {
                    const r = await runHeadless(s, {
                        cap,
                        maximum: Number(setting('MAX_MAKE', '390')),
                        shaftReserve: Number(setting('SHAFT_RESERVE', '200')),
                        featherReserve: Number(setting('FEATHER_RESERVE', '100')),
                        stop: halted,
                    });
                    return { ok: r.ok, summary: `made=${r.made}`, ticks: r.ticks, produced: r.made, failure: r.ok ? undefined : r.failure };
                }
                if (mode === 'oak-bows') {
                    const r = await runOakBows(s, {
                        cap,
                        maximum: Number(setting('MAX_MAKE', '25')),
                        logReserve: Number(setting('LOG_RESERVE', '0')),
                        stringReserve: Number(setting('STRING_RESERVE', '0')),
                        stop: halted,
                    });
                    return { ok: r.ok, summary: `made=${r.made}`, ticks: r.ticks, produced: r.made, failure: r.ok ? undefined : r.failure };
                }
                if (mode === 'native-arrows') {
                    const tip = (cfg.args[2] ?? setting('TIP_TYPE', 'rune')) as ArrowMetal;
                    nativeArrowProfile(tip);
                    const r = await runNativeArrows(
                        s,
                        {
                            cap,
                            maximum: Number(setting('MAX_MAKE', '30')),
                            headlessReserve: Number(setting('HEADLESS_RESERVE', '200')),
                            tipReserve: Number(setting('TIP_RESERVE', '5')),
                            outputReserve: Number(setting('OUTPUT_RESERVE', '0')),
                            xpRate: Number(setting('FLETCHING_XP_RATE', '25')),
                            stop: halted,
                        },
                        tip,
                    );
                    return { ok: r.ok, summary: `made=${r.made}`, ticks: r.ticks, produced: r.made, failure: r.ok ? undefined : r.failure };
                }
                const metal = (mode === 'iron' ? 'iron' : 'steel') as ArrowMetal;
                const r = await runSteel(
                    s,
                    {
                        cap,
                        maximum: Number(setting('MAX_MAKE', mode === 'iron' ? '90' : '15')),
                        headlessReserve: Number(setting('HEADLESS_RESERVE', '200')),
                        tipReserve: Number(setting('TIP_RESERVE', mode === 'iron' ? '0' : '5')),
                        outputReserve: Number(setting('OUTPUT_RESERVE', '0')),
                        stop: halted,
                    },
                    metal,
                );
                return { ok: r.ok, summary: `made=${r.made}`, ticks: r.ticks, produced: r.made, failure: r.ok ? undefined : r.failure };
            }
            case 'smithing': {
                const cap = Number(cfg.args[0] ?? setting('CAP', '1500'));
                if (cfg.method === 'cannonballs') {
                    const r = await runCannonballs(s, {
                        bars: Number(cfg.args[0] ?? setting('MAX_MAKE', '1')),
                        cap: Number(cfg.args[1] ?? setting('CAP', '1200')),
                        reserve: Number(setting('CANNON_RESERVE', '0')),
                        xpRate: Number(setting('CANNON_XP_RATE', '1')),
                        route: setting('CANNON_ROUTE_JSON') ? JSON.parse(setting('CANNON_ROUTE_JSON')!) : undefined,
                        nearest: setting('CANNON_NEAREST') === '1',
                        stop: halted,
                    });
                    return { ok: r.ok, summary: `balls=${r.balls}`, ticks: r.ticks, produced: r.balls, failure: r.ok ? undefined : r.failure };
                }
                if (cfg.method === 'anvil' || setting('ORDER_ACTION') === 'smith') {
                    const r = await runSmithBatch(s, {
                        product: Number(setting('PRODUCT_ID')),
                        maximum: Number(setting('MAX_MAKE', '1')),
                        reserve: Number(setting('BAR_RESERVE', '0')),
                        cap,
                        stop: halted,
                    });
                    return { ok: r.ok, summary: `made=${r.made} banked=${r.banked}`, ticks: r.ticks, produced: r.banked ?? r.made, failure: r.ok ? undefined : r.failure };
                }
                const bar = (cfg.args[1] ?? setting('BAR_TYPE', 'iron'))!.toLowerCase();
                const bonus = smeltBonusFromEnv(cfg.env);
                const route = smeltRouteFromEnv(cfg.env);
                const nearest = setting('SMELT_NEAREST') === '1';
                if (bar === 'bronze' && !route && !nearest) {
                    const r = await runBronze(s, { maximum: Number(setting('MAX_MAKE', '8')), reserve: Number(setting('ORE_RESERVE', '1')), cap, stop: halted });
                    return { ok: r.ok, summary: `made=${r.made}`, ticks: r.ticks, produced: r.made, failure: r.ok ? undefined : r.failure };
                }
                const order: SmeltOrder = {
                    bar,
                    cap,
                    maximum: Number(setting('MAX_MAKE', bar === 'bronze' ? '8' : '28')),
                    reserve: Number(setting('ORE_RESERVE', '1')),
                    mode: (bar === 'bronze' ? 'exact' : setting('ORDER_MODE', 'best-effort')) as SmeltOrder['mode'],
                    bonusGear: bonus,
                    route,
                    nearest,
                    stop: halted,
                };
                validateSmeltOrder(order);
                const r = await runSmeltBatch(s, order);
                return { ok: r.ok, summary: `made=${r.made}`, ticks: r.ticks, produced: r.made, failure: r.ok ? undefined : r.failure };
            }
            case 'crafting': {
                const craftingMethod = cfg.method as (typeof ARTISAN_METHOD_MAP.crafting)[number];
                switch (craftingMethod) {
                    case 'bowstrings': {
                        const r = await runSpinBowstrings(s.name, cfg.args, cfg.env, { session: s, stop: halted });
                        return { ok: r.ok, summary: r.summary, ticks: r.ticks, produced: r.made, failure: r.failure };
                    }
                    case 'jewellery': {
                        const recipe = jewelleryRecipes().find(r => r.name === (cfg.args[0] ?? setting('RECIPE', 'sapphire_ring')));
                        if (!recipe) throw Error('unknown jewellery recipe');
                        const maximum = Number(cfg.args[1] ?? setting('MAX_MAKE', '1'));
                        const cap = Number(cfg.args[2] ?? setting('CAP', '200'));
                        const r = await runJewellery(
                            {
                                state: () => s.sdk.getState(),
                                tick: () => s.tick(),
                                stop: halted,
                                close: async () => { await s.sdk.sendCloseModal(); },
                                open: async slot => {
                                    const f = s.sdk.getState()?.nearbyLocs.find(l => /^furnace$/i.test(l.name) && l.distance <= 2 && l.reachable !== false);
                                    if (!f || !(await s.sdk.sendUseItemOnLoc(slot, f.x, f.z, f.id)).success) return false;
                                    const { waitUntil } = await import('../../../core/src/ticks');
                                    return waitUntil(s, st => halted() || !!st.interface?.isOpen || !!st.dialog?.isOpen, { timeoutTicks: 8 });
                                },
                                choose: async menu =>
                                    (menu.option === undefined
                                        ? await s.sdk.sendClickComponent(await import('../../../core/src/logout').then(m => m.componentId(menu.component)))
                                        : await s.sdk.sendClickComponentWithOption(await import('../../../core/src/logout').then(m => m.componentId(menu.component)), menu.option, menu.slot)
                                    ).success,
                                wait: (test, ticks) => import('../../../core/src/ticks').then(m => m.waitUntil(s, test, { timeoutTicks: ticks })),
                                step: () => import('../../../core/src/ticks').then(m => m.waitTicks(s, 1)),
                            },
                            recipe,
                            { maximum, cap, members: setting('MEMBERS') === '1' },
                        );
                        return { ok: true, summary: `made=${r.made}`, ticks: r.ticks, produced: r.made };
                    }
                    case 'jewellery-trip': {
                        const order = cfg.args[0] ? (readJobJson(cfg.args[0]) as unknown as JewelleryOrder) : jewelleryOrderFromEnv(cfg.env);
                        const r = await runJewelleryOrder(s, order, halted, {}, cfg.deps);
                        return { ok: r.ok, summary: `made=${r.made} banked=${r.banked}`, ticks: r.ticks, produced: r.made, failure: r.ok ? undefined : r.failure };
                    }
                    case 'legacy-jewelry': {
                        const r = await runLegacyCraftJewelryCli(s.name, cfg.args, cfg.env, { session: s, stop: halted });
                        return { ok: r.ok, summary: r.summary, ticks: r.ticks, produced: r.crafted, failure: r.failure };
                    }
                    case 'glass': {
                        const r =
                            setting('SUPPLY_MODE') === '1'
                                ? await runBankedGlass(s, glassSupplyOptions(cfg.env), halted)
                                : await runFurnaceGlass(s, Number(setting('MAX_MAKE', '1')), Number(setting('CAP', '200')), halted);
                        return { ok: r.ok, summary: `made=${(r as any).made ?? 0}`, ticks: r.ticks, produced: Number((r as any).made ?? 0), failure: r.ok ? undefined : r.failure };
                    }
                    case 'tanning': {
                        const r = await tanInventory(s, cfg.args[0] as TanKind, Number(cfg.args[1] ?? 1), Number(cfg.args[2] ?? 80), halted);
                        return { ok: r.ok, summary: `made=${r.made}`, ticks: r.ticks, produced: r.made, failure: r.ok ? undefined : r.detail };
                    }
                    case 'black-dhide-sets': {
                        const r = await runBlackDhideSetsSession(s, cfg.args, cfg.env, cfg.deps, halted);
                        return { ok: r.ok, summary: r.summary, ticks: r.ticks, produced: r.produced, failure: r.failure };
                    }
                    case 'soften-clay': {
                        const r = await runSoftenClay(s, { cap: Number(setting('CAP', '500')), maximum: Number(setting('MAX_MAKE', '20')), reserve: Number(setting('RAW_RESERVE', '0')) });
                        return { ok: r.ok, summary: `made=${r.made}`, ticks: r.ticks, produced: r.made, failure: r.ok ? undefined : r.failure };
                    }
                    case 'progressive': {
                        const order = readJobJson(cfg.args[0]!) as unknown as ProgressiveProduction;
                        const r = await runProgressiveProduction(s, order, halted, {}, cfg.deps);
                        return { ok: r.ok, summary: `processed=${r.processed}`, ticks: r.ticks, produced: r.processed, failure: r.ok ? undefined : r.failure };
                    }
                    case 'inventory': {
                        const rName = cfg.args[0] ?? setting('RECIPE');
                        const recipe: InventoryRecipe | undefined = inventoryRecipes().find(x => x.name === rName);
                        if (!recipe) throw Error(`crafting: unknown inventory recipe ${String(rName)}`);
                        const maximum = Number(setting('MAX_MAKE', '1'));
                        const res = await runInventoryBank(s, recipe, {
                            maximum,
                            cap: Number(setting('CAP', '500')),
                            maxAttempts: Number(setting('MAX_ATTEMPTS', String(maximum))),
                            partial: setting('ORDER_MODE') === 'best-effort',
                            reserve: Number(setting('RAW_RESERVE', '0')),
                            members: setting('MEMBERS') === '1',
                            stop: halted,
                        });
                        return { ok: res.ok, summary: `made=${res.made}`, ticks: res.ticks, produced: res.made, failure: res.ok ? undefined : res.failure };
                    }
                    default: {
                        const _exhaustive: never = craftingMethod;
                        throw Error(`crafting: unhandled method ${String(_exhaustive)}`);
                    }
                }
            }
            case 'herblore': {
                if (cfg.method === 'meats') {
                    const r = await runDruidMeats(s, { cap: Number(setting('CAP', '4000')), stop: halted });
                    return { ok: r.ok, summary: `kills=${r.kills}`, ticks: r.ticks, produced: r.acquired.length, failure: r.ok ? undefined : 'druid-meats incomplete' };
                }
                const opts = herbloreOptions([s.name, ...cfg.args], cfg.env);
                const r = await brew(s, opts);
                return { ok: r.ok, summary: `brewed=${r.brewed} level=${r.level}`, ticks: r.ticks, produced: r.brewed, failure: r.ok ? undefined : 'brew failed' };
            }
            case 'prayer': {
                const opts = prayerOptions([s.name, ...cfg.args], cfg.env);
                const r = await runPrayer(s, { ...opts, stop: halted });
                return { ok: r.ok, summary: `buried=${r.buried}`, ticks: r.ticks, produced: r.buried, failure: r.ok ? undefined : r.failure };
            }
            case 'magic': {
                if (cfg.method === 'items') {
                    const recipe = itemMagicRecipe(cfg.args[0]!, cfg.args[1] === '-' ? undefined : cfg.args[1]);
                    const r = await runItemMagic(s, recipe, { count: Number(cfg.args[2] ?? 1), cap: Number(cfg.args[3] ?? 200), members: setting('MEMBERS') === '1', stop: halted });
                    return { ok: r.ok, summary: `casts=${r.casts}`, ticks: r.ticks, produced: r.produced, failure: r.ok ? undefined : r.stop };
                }
                if (cfg.method === 'teleport') {
                    const r = await runTeleportMagic(s, nativeTeleport(cfg.args[0]!), {
                        casts: Number(cfg.args[1] ?? 1),
                        cap: Number(cfg.args[2] ?? 1200),
                        members: setting('MEMBERS') === '1',
                        stop: halted,
                    });
                    return { ok: r.ok, summary: `casts=${r.casts}`, ticks: r.ticks, produced: r.casts, failure: r.ok ? undefined : r.failure };
                }
                if (cfg.method === 'trip') {
                    const job = readJobJson(cfg.args[0]!) as unknown as MagicBankJob;
                    const r = await runMagicBankTrips(s, job, halted, cfg.deps);
                    return { ok: r.ok, summary: `completed=${r.completed}`, ticks: r.ticks ?? s.tick() - startTick, produced: r.completed, failure: r.ok ? undefined : r.failure };
                }
                if (cfg.method === 'orbs' || cfg.method === 'orbs-at-site') {
                    const kind = cfg.args[0] as OrbKind;
                    const max = Number(cfg.args[1] ?? 1);
                    const cap = Number(cfg.args[2] ?? 6000);
                    const trip = cfg.method === 'orbs' && setting('ORB_TRIP') === '1';
                    const r = trip
                        ? await runOrbTrips(s, kind, orbRecipes[kind], chargeInventory, { target: max, batch: Number(setting('ORB_BATCH', '1')), cap, stop: halted, ...orbOptions(cfg.env) }, cfg.deps)
                        : await chargeInventory(s, kind, max, cap, halted);
                    return { ok: r.ok, summary: `made=${r.made}`, ticks: r.ticks, produced: r.made, failure: r.ok ? undefined : (r as any).failure || (r as any).detail };
                }
                if (cfg.method === 'bones') {
                    const r = await runBonesBank(s, { maximum: Number(setting('MAX_MAKE', '25')), cap: Number(setting('CAP', '500')), members: setting('MEMBERS') === '1', stop: halted });
                    return { ok: r.ok, summary: `made=${r.made}`, ticks: r.ticks, produced: r.made, failure: r.ok ? undefined : r.failure };
                }
                if (cfg.method === 'earth-production') {
                    const r = await runEarthProduction(
                        s,
                        {
                            mode: cfg.args[0] as 'talismans' | 'craft',
                            cap: Number(cfg.args[1] ?? 4000),
                            target: Number(setting('STOCK_TARGET', '100')),
                            reserve: Number(setting('COIN_RESERVE', '0')),
                            killsPerTarget: Number(setting('HUNT_KILLS_PER_TARGET', '0')),
                            stop: halted,
                        },
                        cfg.deps,
                    );
                    return { ok: r.ok, summary: `crafted=${r.crafted}`, ticks: r.ticks, produced: r.crafted, failure: r.ok ? undefined : r.failure };
                }
                const r = await runAlch(
                    s,
                    {
                        target: Number(cfg.args[0] ?? setting('TARGET_LEVEL', '55')),
                        cap: Number(cfg.args[1] ?? setting('CAP', '5000')),
                        item: setting('ALCH_ITEM', 'feather')!,
                        stop: halted,
                        walk: async (x, z) =>
                            cfg.deps?.walkTargetPersist
                                ? (await cfg.deps.walkTargetPersist(s, { x, z, level: 0 })).ok
                                : (await walkPath(await sessionWalker(s), [{ x, z, tol: 2 }])).ok,
                    },
                    cfg.deps,
                );
                return { ok: r.ok, summary: `level=${r.level} gained=${r.gained}`, ticks: r.ticks, produced: r.gained, failure: r.ok ? undefined : r.failure };
            }
            case 'foraging': {
                if (cfg.method === 'miscellania-coffer') {
                    const r = await depositMiscCoffer(s, Number(cfg.args[0]), Number(cfg.args[1] ?? 120), halted, { collectResources: cfg.args[2] === '--collect' });
                    return { ok: r.ok, summary: `amount=${r.amount}`, ticks: r.ticks, produced: r.amount, failure: r.ok ? undefined : r.detail };
                }
                if (cfg.method === 'qol') {
                    const mode = cfg.args[0] ?? '';
                    const arg = cfg.args[1] ?? '';
                    const val = Number(cfg.args[2] ?? 30);
                    const cap = Number(cfg.args[3] ?? 40);
                    const r =
                        mode === 'drop'
                            ? await dropQolItems(s, readJobJson(arg) as any, halted)
                            : mode === 'run'
                              ? await enableQolRun(s, Number(arg), cap, halted)
                              : mode === 'prayer'
                                ? await holdPrayer(s, Number(arg), val, halted)
                                : mode === 'special'
                                  ? await enableSpecial(s, arg, val, cap, halted)
                                  : await refillCannon(s, Number(arg), val, cap, halted);
                    return { ok: r.ok, summary: `qol=${mode}`, ticks: r.ticks, produced: 1, failure: r.ok ? undefined : (r as any).failure || (r as any).detail };
                }
                const mode = cfg.args[0] ?? 'feed';
                const val = Number(cfg.args[1] ?? 1);
                const cap = Number(cfg.args[2] ?? 80);
                const r =
                    mode === 'pouch'
                        ? await fillDruidPouch(s, val, cap, halted)
                        : mode === 'miscellania'
                          ? await weedMiscellania(s, val, cap, halted, Number(setting('MISC_WEED_XP_RATE', '25')))
                          : await kittenCare(s, val, mode as 'feed' | 'wool' | 'stroke', cap, halted);
                return { ok: r.ok, summary: `made=${(r as any).made ?? 1}`, ticks: r.ticks, produced: Number((r as any).made ?? 1), failure: r.ok ? undefined : r.detail };
            }
            case 'bank-job': {
                if (!cfg.deps?.runBankJob) throw Error('bank-job requires deps.runBankJob');
                let produced = 0;
                for (const arg of cfg.args) {
                    const job = readJobJson(arg);
                    cfg.deps.validateBankJob?.(job);
                    const res = await cfg.deps.runBankJob(s, job, halted);
                    produced += res.completed ?? 0;
                    if (!res.ok) return { ok: false, summary: res.failure, ticks: s.tick() - startTick, produced, failure: res.failure };
                }
                return { ok: true, summary: `jobs=${cfg.args.length} completed=${produced}`, ticks: s.tick() - startTick, produced };
            }
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, summary: msg, ticks: s.tick() - startTick, produced: 0, failure: msg };
    }
}

export async function runArtisanCli(account: string, rawCfg: ArtisanConfig): Promise<number> {
    const cfg = normalizeArtisanConfig(rawCfg);
    ensureRegisteredCrossRunners(cfg.deps);
    if (!VALID_ARTISAN_SKILLS.includes(cfg.skill)) {
        throw Error(`unknown artisan skill: ${String(rawCfg.skill)}`);
    }
    const validMethods = ARTISAN_METHOD_MAP[cfg.skill] as readonly string[];
    if (!validMethods.includes(cfg.method)) {
        throw Error(`unknown ${cfg.skill} method: ${String(rawCfg.method)}`);
    }
    const env: Record<string, string | undefined> = { ...process.env, ...cfg.env };

    const runLegacyExitCode = async (fn: () => Promise<unknown>): Promise<number> => {
        const prevExitCode = process.exitCode;
        process.exitCode = 0;
        try {
            await fn();
            return process.exitCode ? 1 : 0;
        } finally {
            process.exitCode = prevExitCode;
        }
    };

    switch (cfg.skill) {
        case 'cooking':
            return await runCookingCli(cfg.method, account, cfg.args, env, cfg.deps);
        case 'firemaking':
            return await runFiremakingCli(cfg.method, account, cfg.args, env);
        case 'fletching':
            return await runLegacyExitCode(() => runFletchingCli(cfg.method, account, cfg.args, env));
        case 'smithing':
            return await runLegacyExitCode(() => runSmithingCli(cfg.method, account, cfg.args, env));
        case 'crafting':
            return await runLegacyExitCode(() => runCraftingCli(cfg.method, account, cfg.args, env, cfg.deps));
        case 'herblore':
            return await runLegacyExitCode(() => runHerbloreCli(cfg.method, account, cfg.args, env));
        case 'prayer':
            return await runPrayerCli(cfg.method, account, cfg.args, env);
        case 'magic':
            return await runLegacyExitCode(() => runMagicCli(cfg.method, account, cfg.args, env, cfg.deps));
        case 'foraging':
            return await runLegacyExitCode(() => runForagingQolCli(cfg.method, account, cfg.args, env));
        case 'bank-job':
            throw Error('bank-job CLI orchestration runs directly through runBankJob jobs in scripts/aio-skiller.ts');
    }
}
