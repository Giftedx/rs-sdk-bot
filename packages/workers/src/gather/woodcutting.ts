// Consolidated woodcutting module: Seers yews / Draynor oak & normal, Edgeville oaks, Lumbridge supply logs->shafts, and basic chop loop.
import { existsSync } from 'node:fs';
import { accountOf, countItems, finish, getWorld, openBot, settle } from '../../../core/src/bot';
import { bankCargo } from '../../../core/src/cargo';
import { depositObserved } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { expandPath, goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import type { NearbyLoc } from '../../../../vendor/rs-sdk/sdk/types';
import { defaultApproach, defaultWalkTargetPersist, productionStopRequested } from './runtime';
import { isStopFilePresent } from '../stop';
import {
    type ShopRetryGate,
    WOODCUTTING_AXES_DESC,
    bestWoodcuttingAxe,
    crossedTierBoundary,
    executeShopToolPurchase,
    planToolShopUpgrade,
    readSkillLevels,
    reconcileBankTool,
    recordShopAttempt,
    sessionShopGate,
    sessionToolHooks,
    shouldAttemptShopUpgrade,
    tierBoundaryOf,
} from './tools';
import { type GatherExternalDeps, type GatherOutcome, type NormalizedGatherConfig, resolveSetting } from './types';

// ---------------------------------------------------------------------------
// 1. Edgeville Woodcutting 36 (`woodcutting:edgeville`)
// ---------------------------------------------------------------------------
const EDGEVILLE_BANK = { x: 3094, z: 3492, tol: 1 };
const EDGEVILLE_GROVE = { x: 3125, z: 3434, tol: 2 };
const EDGEVILLE_APPROACH = [
    { x: 3082, z: 3490, tol: 1 },
    { x: 3080, z: 3470, tol: 1 },
    { x: 3101, z: 3421, tol: 3 },
];
const EDGEVILLE_OAKS = new Set(['3120,3428', '3126,3437', '3131,3432']);
const OAK_LOGS = 1521;
const EDGEVILLE_TARGET = 36;
const EDGEVILLE_CAP = 900;
const AXE_IDS: readonly number[] = WOODCUTTING_AXES_DESC;
const AXE_ID_SET = new Set<number>(WOODCUTTING_AXES_DESC);
const CHOP_OP_RE = /^chop/i;
const CHOP_DOWN_OP_RE = /^chop down$/i;
const TREE_RE = /^tree$/i;
const WC_FOOD_RE = /^(shrimps|bread|trout|salmon|lobster|cooked chicken)$/i;
const WC_BANK_FOOD_RE = /^(bread|shrimps|trout|salmon|cooked chicken)$/i;
const WC_KEEP_ITEM_RE = /axe$|^(shrimps|bread|trout|salmon|lobster|cooked chicken)$/i;

const countById = (items: readonly { id: number; count: number }[], id: number) => {
    let total = 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (item.id === id) total += item.count;
    }
    return total;
};
const countAxes = (items: readonly { id: number; count: number }[]) => {
    let total = 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (AXE_ID_SET.has(item.id)) total += item.count;
    }
    return total;
};

function checkAssert(value: unknown, detail: string): asserts value {
    if (!value) throw Error(detail);
}

export function selectEdgevilleWoodcutAxe(
    stock: readonly { id: number; count: number }[],
    levels: ReturnType<typeof readSkillLevels>,
) {
    return bestWoodcuttingAxe(stock, levels);
}

export async function runEdgevilleWoodcut(s: Session, stopped: () => boolean) {
    const start = s.tick();
    const pos = () => s.sdk.getState()?.player;
    const level = () => s.sdk.getSkill('Woodcutting')?.baseLevel ?? 0;
    const xp = () => s.sdk.getSkillXp('Woodcutting') ?? 0;
    const pack = () => s.sdk.getInventory();
    const eq = () => s.sdk.getEquipment();
    const held = (id: number) => countById(pack(), id);
    const activeAxes = () => countAxes(pack()) + countAxes(eq().filter(e => e.slot === 3));
    const atBank = () => {
        const p = pos();
        return Boolean(p?.level === 0 && Math.max(Math.abs(p.worldX - EDGEVILLE_BANK.x), Math.abs(p.worldZ - EDGEVILLE_BANK.z)) <= 3);
    };
    const from = level();
    const initialXp = xp();
    const initialHp = pos()?.hp ?? 0;
    let hpMin = initialHp;
    let gathered = 0;
    let banked = 0;
    let failure: string | undefined;
    const refusedWields = new Set<number>();
    let toolLevels = readSkillLevels(s.sdk);
    const off = s.onTick(() => {
        hpMin = Math.min(hpMin, pos()?.hp ?? 0);
    });
    const safe = () => {
        const p = pos();
        return (
            !stopped() &&
            p?.level === 0 &&
            p.worldZ >= 3405 &&
            p.worldZ < 3520 &&
            p.worldX >= 3050 &&
            p.worldX <= 3140 &&
            !p.isDead &&
            hpMin >= initialHp &&
            s.tick() - start < EDGEVILLE_CAP
        );
    };
    const walk = async (returning: boolean) => {
        const points = returning ? [...EDGEVILLE_APPROACH].reverse().concat(EDGEVILLE_BANK) : [...EDGEVILLE_APPROACH, EDGEVILLE_GROVE];
        const result = await walkPath(await sessionWalker(s), points, {
            maxTicks: 165,
            idleMs: 8_000,
            stop: () => !safe(),
        });
        checkAssert(result.ok && safe(), 'Edgeville route failed: ' + result.detail);
    };
    const openBank = async () => {
        const generation = s.bankObservation?.()?.generation ?? 0;
        checkAssert(
            safe() &&
                atBank() &&
                (await s.bot.openBank()).success &&
                (await waitUntil(s, () => (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 12 })),
            'Fresh Edgeville bank unavailable',
        );
        const bank = s.bankObservation?.();
        checkAssert(bank, 'Edgeville bank observation unavailable');
        return bank.items;
    };
    try {
        checkAssert(
            atBank() &&
                safe() &&
                initialHp > 0 &&
                from >= 15 &&
                from < EDGEVILLE_TARGET &&
                activeAxes() === 0 &&
                held(OAK_LOGS) === 0 &&
                pack().length <= 14,
            'Woodcutting entry changed',
        );
        const openingBank = await openBank();
        const originalAxes = countAxes(openingBank);
        const originalLogs = countById(openingBank, OAK_LOGS);
        const activateBestOwnedAxe = async (bankRows: readonly { id: number; count: number }[]) => {
            const levelsNow = readSkillLevels(s.sdk);
            const rec = selectEdgevilleWoodcutAxe([...bankRows, ...pack(), ...eq().filter(e => e.slot === 3)], levelsNow).current;
            checkAssert(rec, 'No owned woodcutting axe in Edgeville bank');
            await reconcileBankTool(
                sessionToolHooks(s, {
                    openBank,
                    waitUntil: (pred, timeoutTicks) => waitUntil(s, pred, { timeoutTicks }),
                    stop: () => !safe(),
                }),
                {
                    targetId: rec.item.id,
                    canWield: rec.canWield,
                    toolGroupIds: AXE_IDS,
                    refusedWields,
                },
            );
            toolLevels = levelsNow;
        };
        await activateBestOwnedAxe(openingBank);
        await s.bot.closeBank();
        let stalled = false;
        while (safe() && level() < EDGEVILLE_TARGET && !stalled) {
            await walk(false);
            let lastGain = s.tick();
            let previous = '';
            while (safe() && level() < EDGEVILLE_TARGET && pack().length < 27) {
                await s.bot.dismissBlockingUI();
                const locs = s.sdk.getState()?.nearbyLocs ?? [];
                let tree: (typeof locs)[number] | undefined;
                let fallbackTree: (typeof locs)[number] | undefined;
                for (let i = 0; i < locs.length; i++) {
                    const loc = locs[i]!;
                    if (loc.id !== 1281 || loc.reachable === false) continue;
                    const key = `${loc.x},${loc.z}`;
                    if (!EDGEVILLE_OAKS.has(key)) continue;
                    if (key !== previous) {
                        if (!tree || loc.distance < tree.distance) tree = loc;
                    } else if (!fallbackTree || loc.distance < fallbackTree.distance) {
                        fallbackTree = loc;
                    }
                }
                tree ??= fallbackTree;
                const action = tree?.optionsWithIndex.find(op => CHOP_OP_RE.test(op.text));
                if (tree && action) {
                    const before = held(OAK_LOGS);
                    previous = tree.x + ',' + tree.z;
                    await s.bot.interactLoc(tree, action.text);
                    await waitUntil(s, () => held(OAK_LOGS) > before || !safe(), { timeoutTicks: 28 });
                    const gain = held(OAK_LOGS) - before;
                    if (gain > 0) {
                        gathered += gain;
                        lastGain = s.tick();
                    }
                    const nowLevels = readSkillLevels(s.sdk);
                    if (crossedTierBoundary(toolLevels, nowLevels, ['attack', 'woodcutting'], 'woodcutting-axe')) {
                        break;
                    }
                } else {
                    await waitTicks(s, 4);
                }
                if (s.tick() - lastGain >= 180) {
                    stalled = true;
                    break;
                }
            }
            await s.bot.dismissBlockingUI();
            await walk(true);
            let currentBank = await openBank();
            const product = pack().find(item => item.id === OAK_LOGS);
            if (product) {
                const quantity = held(OAK_LOGS);
                const deposited = await depositObserved(s, product);
                checkAssert(deposited === quantity, 'Oak log deposit unconfirmed');
                banked += deposited;
                currentBank = s.bankObservation?.()?.items ?? currentBank;
            }
            if (level() >= EDGEVILLE_TARGET || stalled) {
                const wornAxe = eq().find(item => item.slot === 3 && AXE_IDS.includes(item.id));
                if (wornAxe) {
                    await s.bot.closeBank();
                    checkAssert(
                        (await s.bot.unequipItem(wornAxe)).success &&
                            (await waitUntil(s, () => !eq().some(e => e.slot === 3 && e.id === wornAxe.id), { timeoutTicks: 8 })),
                        'Worn axe unequip unconfirmed',
                    );
                    currentBank = await openBank();
                }
                for (const axe of [...pack()].filter(item => AXE_IDS.includes(item.id))) {
                    checkAssert((await depositObserved(s, axe)) === axe.count, 'Axe deposit unconfirmed');
                }
            } else {
                await activateBestOwnedAxe(currentBank);
            }
            const saved = s.bankObservation?.()?.items ?? [];
            checkAssert(
                countById(saved, OAK_LOGS) === originalLogs + banked && countAxes(saved) + activeAxes() === originalAxes,
                'Woodcutting bank totals differ',
            );
            await s.bot.closeBank();
        }
        checkAssert(
            level() >= EDGEVILLE_TARGET &&
                xp() > initialXp &&
                banked === gathered &&
                banked > 0 &&
                activeAxes() === 0 &&
                held(OAK_LOGS) === 0 &&
                atBank(),
            'Woodcutting target incomplete',
        );
    } catch (error) {
        failure = String(error);
    } finally {
        off();
    }
    return {
        ok: !failure,
        failure,
        from,
        level: level(),
        xp: xp() - initialXp,
        gathered,
        banked,
        hpMin,
        ticks: s.tick() - start,
        atBank: atBank(),
    };
}

// ---------------------------------------------------------------------------
// 2. Lumbridge Supply Logs -> Shafts -> Headless (`woodcutting:woodcut-supply`)
// ---------------------------------------------------------------------------
const SUPPLY_BANK = { x: 3092, z: 3243, level: 0 };
const SUPPLY_KNIFE = { x: 3224, z: 3202, level: 0 };
const SUPPLY_TREES = { x: 3226, z: 3237, level: 0 };
const SUPPLY_CORRIDOR = [
    { x: 3092, z: 3266, level: 0 },
    { x: 3140, z: 3270, level: 0 },
    { x: 3180, z: 3258, level: 0 },
    { x: 3218, z: 3256, level: 0 },
];

export function supplyPlan(logs: number, headless: number, cap: number) {
    if (
        !Number.isSafeInteger(logs) ||
        logs < 1 ||
        logs > 25 ||
        !Number.isSafeInteger(headless) ||
        headless < 0 ||
        headless % 15 ||
        headless > Math.floor(Math.max(0, logs * 15 - 200) / 15) * 15 ||
        !Number.isSafeInteger(cap) ||
        cap < 100 ||
        cap > 10000
    ) {
        throw Error('supply requires LOGS1..25, HEADLESS multiple15 within shaft reserve200, CAP100..10000');
    }
    return { logs, headless, shafts: logs * 15 };
}

export async function takeOwnedSupplyKnife(s: Session, check: () => void): Promise<'held' | 'withdrawn' | 'missing'> {
    const held = () => s.sdk.getInventory().filter(i => i.id === 946).reduce((n, i) => n + i.count, 0);
    check();
    if (held() > 0) return 'held';
    const before = s.bankObservation?.();
    if (!before || !s.sdk.getState()?.bank?.isOpen) throw Error('supply owned knife bank unobserved');
    const bankBefore = before.items.filter(i => i.id === 946).reduce((n, i) => n + i.count, 0);
    const generationBefore = before.generation;
    const packBefore = held();
    if (bankBefore === 0) return 'missing';
    const knife = s.sdk.getState()!.bank.items.find(i => i.id === 946);
    if (!knife) throw Error('supply owned knife slot unobserved');
    check();
    if (!(await s.bot.withdrawItem(knife, 1, { asNote: false })).success) {
        throw Error('supply owned knife withdrawal refused');
    }
    check();
    const observed = await waitUntil(
        s,
        () => {
            const bank = s.bankObservation?.();
            return (
                !!bank &&
                bank.generation > generationBefore &&
                bank.items.filter(i => i.id === 946).reduce((n, i) => n + i.count, 0) === bankBefore - 1 &&
                held() === packBefore + 1
            );
        },
        { timeoutTicks: 5 },
    );
    check();
    if (!observed) throw Error('supply owned knife withdrawal unobserved');
    console.log(
        'WOOD_SUPPLY_KNIFE_RECEIPT ' +
            JSON.stringify({
                account: s.name,
                itemId: 946,
                amount: 1,
                bankBefore,
                bankAfter: bankBefore - 1,
                packBefore,
                packAfter: held(),
                generationBefore,
                generationAfter: s.bankObservation!()!.generation,
                tick: s.tick(),
            }),
    );
    return 'withdrawn';
}

export function selectWoodSupplyAxe(
    stock: readonly { id: number; count: number }[],
    levels: ReturnType<typeof readSkillLevels>,
) {
    return bestWoodcuttingAxe(stock, levels);
}

const woodSupplyShopGates = new WeakMap<object, ShopRetryGate>();

export async function reconcileWoodSupplyAxe(
    s: Session,
    options: {
        bankSpot?: { x: number; z: number; level?: number };
        walkTo?: (spot: { x: number; z: number; level?: number }) => Promise<boolean>;
        check: () => void;
        allowShop?: boolean;
        shopGate?: ShopRetryGate;
    },
) {
    options.check();
    const bankItems = s.bankObservation?.()?.items ?? s.sdk.getState()?.bank?.items ?? [];
    const inv = s.sdk.getInventory();
    const eq = s.sdk.getEquipment?.() ?? [];
    const levels = readSkillLevels(s.sdk);
    const stock = [...inv, ...eq.filter(e => e.slot === 3), ...bankItems];
    const coins = stock.filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
    const axeTier = tierBoundaryOf(levels.woodcutting, [1, 6, 21, 31, 41]);
    const shopGate = sessionShopGate(woodSupplyShopGates, s, options.shopGate);
    const stopCheck = () => {
        try {
            options.check();
            return false;
        } catch {
            return true;
        }
    };
    if (options.allowShop !== false && shouldAttemptShopUpgrade(shopGate, axeTier, s.tick?.() ?? 0)) {
        const shopPlan = planToolShopUpgrade('woodcutting-axe', stock, coins, levels, {
            allowedShops: ['axeshop'],
            onlyWhenStarterOrMissing: true,
        });
        if (shopPlan) {
            options.check();
            const hooks = sessionToolHooks(s, {
                walkTo: options.walkTo,
                waitUntil: (pred, timeoutTicks) => waitUntil(s, pred, { timeoutTicks }),
                stop: stopCheck,
            });
            const res = await executeShopToolPurchase(hooks, {
                targetId: shopPlan.target.id,
                shop: 'axeshop',
                maxBudget: shopPlan.coinBudgetNeeded,
                returnBankSpot: options.bankSpot ?? SUPPLY_BANK,
            });
            recordShopAttempt(shopGate, axeTier, s.tick?.() ?? 0, res.bought);
            if (res.bought) {
                console.log('WOOD_SUPPLY_SHOP_AXE ' + JSON.stringify(res));
                options.check();
                if (!(await s.bot.openBank()).success) throw Error('supply bank unavailable after axe purchase');
                options.check();
                const spareCoins = s.sdk.getInventory().find(i => i.id === 995);
                if (spareCoins) await depositObserved(s, spareCoins);
            }
        }
    }
    options.check();
    const latestBank = s.bankObservation?.()?.items ?? s.sdk.getState()?.bank?.items ?? [];
    const rec = bestWoodcuttingAxe([...s.sdk.getInventory(), ...(s.sdk.getEquipment?.() ?? []).filter(e => e.slot === 3), ...latestBank], levels).current;
    if (!rec) return null;
    await reconcileBankTool(
        sessionToolHooks(s, {
            waitUntil: (pred, timeoutTicks) => waitUntil(s, pred, { timeoutTicks }),
            stop: stopCheck,
        }),
        {
            targetId: rec.item.id,
            canWield: rec.canWield,
            toolGroupIds: WOODCUTTING_AXES_DESC,
        },
    );
    return rec.item.id;
}

export async function runWoodSupply(
    s: Session,
    logs: number,
    headless: number,
    cap: number,
    deps?: GatherExternalDeps,
    callerStop: () => boolean = () => false,
) {
    const plan = supplyPlan(logs, headless, cap);
    const start = s.tick();
    const hp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    let hpMin = hp;
    let last = hp;
    const damage: {
        tick: number;
        hp: number;
        pos: { x: number; z: number; level: number } | undefined;
        combat: unknown;
        npcs: { name: string; x: number; z: number; distance: number }[];
    }[] = [];
    const off = s.onTick(() => {
        const now = s.sdk.getSkill('Hitpoints')?.level ?? 0;
        const hit = now < last;
        last = now;
        if (hit) {
            const p = s.sdk.getState()?.player;
            damage.push({
                tick: s.tick() - start,
                hp: now,
                pos: p ? { x: p.worldX, z: p.worldZ, level: p.level } : undefined,
                combat: p?.combat,
                npcs: s.sdk.getState()?.nearbyNpcs.map(n => ({ name: n.name, x: n.x, z: n.z, distance: n.distance })) ?? [],
            });
            console.log('WOOD_SUPPLY_DAMAGE ' + JSON.stringify(damage.at(-1)));
        }
        hpMin = Math.min(hpMin, now);
    });
    let ended = false;
    void s.ended?.then(() => { ended = true; });
    const stop = () => ended || productionStopRequested(s.name, callerStop);
    const held = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    // Damage latches: a later heal does not clear it. Every guard reads halt().
    const halt = () =>
        stop() ||
        s.tick() - start >= cap ||
        damage.length > 0 ||
        (s.sdk.getSkill('Hitpoints')?.level ?? 0) < hp ||
        !!s.sdk.getState()?.player?.isDead;
    const check = () => {
        if (halt()) throw Error('supply stopped, capped or damaged');
    };
    const walk = async (t: typeof SUPPLY_BANK) => {
        check();
        const abort = new AbortController();
        const watch = s.onTick(() => {
            if (halt()) abort.abort('supply stopped, capped or damaged');
        });
        try {
            const r = await goTo(s, await getWorld(), t, accountOf(s), { legTimeoutTicks: 100, signal: abort.signal });
            check();
            if (!r.ok) throw Error('supply route ' + r.reason + ' ' + r.detail);
        } finally {
            watch();
        }
    };
    const travel = async (t: typeof SUPPLY_BANK) => {
        check();
        const p = s.sdk.getState()?.player;
        if (p && p.level === t.level && Math.max(Math.abs(p.worldX - t.x), Math.abs(p.worldZ - t.z)) <= 2) return;
        // North-bank lane avoids the jail/road spiders.
        if (t.x === SUPPLY_BANK.x && t.z === SUPPLY_BANK.z) {
            // Walk only the lane steps west of the player; a start in Draynor goes straight to the bank.
            const from = p?.worldX ?? Infinity;
            for (const step of [...SUPPLY_CORRIDOR].reverse().filter(c => from > c.x + 8)) await walk(step);
        } else if (t === SUPPLY_TREES || t === SUPPLY_KNIFE || t.x > 3150) {
            for (const step of SUPPLY_CORRIDOR) await walk(step);
        }
        await walk(t);
    };
    const bank = async () => {
        await travel(SUPPLY_BANK);
        check();
        if (!(await s.bot.openBank()).success) throw Error('supply bank unavailable');
        check();
    };
    const deposit = async () => {
        for (const id of [1511, 946]) {
            check();
            const item = s.sdk.getInventory().find(i => i.id === id);
            if (item) await depositObserved(s, item);
        }
        await s.bot.closeBank();
    };
    const activeAxeId = () => {
        const levels = readSkillLevels(s.sdk);
        const eq = s.sdk.getEquipment?.() ?? [];
        return bestWoodcuttingAxe([...s.sdk.getInventory(), ...eq.filter(e => e.slot === 3)], levels).current?.item.id ?? null;
    };
    const walkToSpot = async (spot: { x: number; z: number; level?: number }) => {
        await travel({ x: spot.x, z: spot.z, level: spot.level ?? 0 });
        return true;
    };
    let gathered = 0;
    let shafts: any;
    let arrows: any;
    try {
        if (!activeAxeId() || activeAxeId() === 1351) {
            await bank();
            const picked = await reconcileWoodSupplyAxe(s, { bankSpot: SUPPLY_BANK, walkTo: walkToSpot, check });
            if (!picked) throw Error('supply owned or shop axe required');
            await s.bot.closeBank();
        }
        if (!held(946)) {
            await bank();
            const owned = await takeOwnedSupplyKnife(s, check);
            check();
            await s.bot.closeBank();
            check();
            if (owned === 'missing') {
                await travel(SUPPLY_KNIFE);
                for (let n = 0; n < 8 && !held(946); n++) {
                    check();
                    const k = s.sdk.findGroundItem(/^knife$/i);
                    if (k) await s.bot.pickupItem(k);
                    await waitTicks(s, 2);
                }
                if (!held(946)) throw Error('supply knife spawn unavailable');
            }
        }
        await bank();
        await deposit();
        let lastGain = s.tick();
        while (gathered < plan.logs) {
            if (s.sdk.getInventory().length >= 27) throw Error('supply pack has no free gathering slot after deposit');
            await travel(SUPPLY_TREES);
            lastGain = s.tick();
            while (gathered < plan.logs && s.sdk.getInventory().length < 27) {
                check();
                if (s.sdk.getDialog()?.isOpen) {
                    await s.sdk.sendClickDialog(0);
                    await waitTicks(s, 1);
                }
                const old = held(1511);
                const locs = s.sdk.getState()?.nearbyLocs;
                let tree: NonNullable<typeof locs>[number] | undefined;
                if (locs) {
                    for (let i = 0; i < locs.length; i++) {
                        const l = locs[i]!;
                        if (
                            l.x >= 3214
                            && l.x <= 3239
                            && l.z >= 3226
                            && l.z <= 3250
                            && l.reachable !== false
                            && TREE_RE.test(l.name)
                            && l.optionsWithIndex.some(o => CHOP_OP_RE.test(o.text))
                            && (!tree || l.distance < tree.distance)
                        ) {
                            tree = l;
                        }
                    }
                }
                if (!tree) {
                    if (s.tick() - lastGain > 240) throw Error('supply no normal tree after respawn budget');
                    await waitTicks(s, 4);
                    continue;
                }
                const result = await s.bot.interactLoc(tree, tree.optionsWithIndex.find(o => CHOP_OP_RE.test(o.text))!.text);
                if (!result.success) {
                    console.log('WOOD_SUPPLY_CHOP_REFUSED ' + JSON.stringify({ tree: { id: tree.id, x: tree.x, z: tree.z }, result }));
                }
                await waitUntil(s, () => held(1511) > old || stop(), { timeoutTicks: 12 });
                const gain = held(1511) - old;
                if (gain > 0) {
                    gathered += gain;
                    lastGain = s.tick();
                }
                if (s.tick() - lastGain > 80) throw Error('supply no log progress');
            }
            await bank();
            await reconcileWoodSupplyAxe(s, { bankSpot: SUPPLY_BANK, walkTo: walkToSpot, check });
            await deposit();
        }
        check();
        if (!deps?.runShafts) throw Error('woodcut-supply requires deps.runShafts');
        shafts = await deps.runShafts(s, {
            cap: Math.max(1, cap - (s.tick() - start)),
            maximum: logs,
            reserve: 0,
            bankKnife: true,
            stop: halt,
            pause: stop,
        });
        check();
        if (!shafts.ok) throw Error('supply shafts ' + JSON.stringify(shafts));
        if (headless) {
            if (!deps?.runHeadless) throw Error('woodcut-supply requires deps.runHeadless');
            check();
            arrows = await deps.runHeadless(s, {
                cap: Math.max(1, cap - (s.tick() - start)),
                maximum: headless,
                shaftReserve: 200,
                featherReserve: 100,
                stop: halt,
                pause: stop,
            });
            check();
            if (!arrows.ok || !arrows.targetMet) throw Error('supply headless ' + JSON.stringify(arrows));
        }
        return { ok: true, gathered, shafts, arrows, ticks: s.tick() - start, hpMin, damage };
    } catch (error) {
        return { ok: false, gathered, shafts, arrows, ticks: s.tick() - start, error: String(error), hpMin, damage };
    } finally {
        off();
    }
}

// ---------------------------------------------------------------------------
// 3. Seers Yews / Draynor Oaks & Normal Trees (`woodcutting:yews`)
// ---------------------------------------------------------------------------
export function seersProcessingGrove(tree: string) {
    if (tree === 'willow') return { x: 2708, z: 3509 };
    if (tree === 'magic') return { x: 2692, z: 3425 };
    if (tree === 'maple' || tree === 'yew') return { x: 2712, z: 3462 };
    throw Error('unsupported Seers processing grove');
}

export function processingTreeEdges(tree: { x: number; z: number }, width: number, length: number) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(length) || width < 1 || width > 4 || length !== width) {
        throw Error('native square tree footprint unknown');
    }
    return [
        ...Array.from({ length: width }, (_, i) => ({ x: tree.x + i, z: tree.z - 1 })),
        ...Array.from({ length: width }, (_, i) => ({ x: tree.x + i, z: tree.z + length })),
        ...Array.from({ length }, (_, i) => ({ x: tree.x - 1, z: tree.z + i })),
        ...Array.from({ length }, (_, i) => ({ x: tree.x + width, z: tree.z + i })),
    ];
}

export async function chopProcessingTree(
    original: Session,
    tree: NearbyLoc,
    stop: () => boolean,
    walk?: (x: number, z: number) => Promise<boolean>,
) {
    const client = original.client;
    const executor = (client as any)?.executeBotAction;
    const first = original.sdk.getState()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const plane = first?.level;
    const hp = original.sdk.getSkill('Hitpoints')?.level ?? 0;
    let lost = false;
    const safe = () => {
        const p = original.sdk.getState()?.player;
        if (original.client !== client || (client as any)?.executeBotAction !== executor) lost = true;
        return (
            !lost &&
            typeof executor === 'function' &&
            life !== undefined &&
            !!p &&
            !p.isDead &&
            p.lifeId === life &&
            (p.respawnCount ?? 0) === respawns &&
            p.level === plane &&
            (original.sdk.getSkill('Hitpoints')?.level ?? 0) === hp &&
            !stop() &&
            !productionStopRequested(original.name)
        );
    };
    if (!safe()) throw Error('native tree original life/owner/HP/stop unavailable');
    const type = (client as { locTypeOf(id: number): { width: number; length: number } }).locTypeOf(tree.id);
    const width = type.width;
    const length = type.length;
    const edges = processingTreeEdges(tree, width, length);
    const began = original.tick();
    const received = () => {
        const c = client as any;
        const local = c.localPlayer;
        return {
            x: c.mapBuildBaseX + local?.routeX?.[0],
            z: c.mapBuildBaseZ + local?.routeZ?.[0],
            level: c.minusedlevel,
            routeLength: local?.routeLength,
        };
    };
    const head = received();
    if (!Number.isSafeInteger(head.x) || !Number.isSafeInteger(head.z) || head.level !== plane) {
        throw Error('native tree received approach origin unavailable');
    }
    let goal: (typeof edges)[number] | undefined;
    {
        const goals = edges
            .flatMap(g => {
                if (g.x === head.x && g.z === head.z) return [];
                const plan = original.sdk.findPath(g.x, g.z);
                if (
                    !plan.success ||
                    plan.reachedDestination !== true ||
                    !plan.waypoints.length ||
                    plan.waypoints.at(-1)!.x !== g.x ||
                    plan.waypoints.at(-1)!.z !== g.z
                ) {
                    return [];
                }
                let cost = 0;
                let at = { x: head.x, z: head.z };
                for (const point of plan.waypoints) {
                    cost += Math.max(Math.abs(at.x - point.x), Math.abs(at.z - point.z));
                    at = point;
                }
                return [{ ...g, cost }];
            })
            .sort((a, b) => a.cost - b.cost);
        goal = goals[0];
        if (!goal) throw Error('native tree no complete cardinal approach path');
    }
    let settlement: { frames: number; after: number | undefined; at: number | undefined } | undefined;
    const stand = goal;
    const coherent = () => {
        const at = original.sdk.getState()?.player;
        const h = received();
        return !!at && at.level === plane && at.worldX === stand.x && at.worldZ === stand.z && h.x === stand.x && h.z === stand.z && h.level === plane;
    };
    {
        if (!safe()) throw Error('native tree stopped before approach');
        const movementSdk = new Proxy(original.sdk, {
            get(target, key, receiver) {
                const v = Reflect.get(target, key, receiver);
                return typeof v === 'function'
                    ? function (this: unknown, ...args: unknown[]) {
                          if (typeof key === 'string' && key.startsWith('send')) {
                              if (!safe()) throw Error('native tree movement owner changed');
                              const action = args[0] as any;
                              if (key === 'sendWalk' || (key === 'send' && action?.type === 'walkTo')) {
                                  const now = received();
                                  if (now.x === stand.x && now.z === stand.z) throw Error('native tree approach became a same-tile no-op');
                              }
                          }
                          return v.apply(receiver, args);
                      }
                    : v;
            },
        });
        const moved = walk ? await walk(stand.x, stand.z) : (await movementSdk.sendWalk(stand.x, stand.z)).success;
        const remaining = 40 - (original.tick() - began);
        const sentTick = original.sdk.getState()?.tick;
        let last = sentTick;
        let stable = 0;
        const settled = () => {
            const tick = original.sdk.getState()?.tick;
            if (!coherent()) {
                stable = 0;
                last = tick;
                return false;
            }
            if (Number.isSafeInteger(tick) && Number.isSafeInteger(last) && tick! > last!) {
                stable++;
                last = tick;
            }
            return stable >= 2;
        };
        if (!moved || remaining <= 0 || !(await waitUntil(original, () => !safe() || settled(), { timeoutTicks: remaining })) || !safe() || !coherent()) {
            throw Error('native tree cardinal arrival unobserved');
        }
        settlement = { frames: stable, after: sentTick, at: last };
    }
    const fresh = () =>
        original.sdk
            .getState()
            ?.nearbyLocs.some(
                l => l.id === tree.id && l.x === tree.x && l.z === tree.z && l.level === plane && l.optionsWithIndex.some(o => /^chop down$/i.test(o.text)),
            );
    if (!fresh()) throw Error('native tree changed before chop');
    const initialMessages = original.sdk.getState()?.gameMessages ?? [];
    const revision = Math.max(0, ...initialMessages.map(m => m.observationId ?? 0));
    const tick = original.tick();
    let refusal = '';
    const sdk = new Proxy(original.sdk, {
        get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            if (key === 'waitForCondition') {
                return function (predicate: (state: any) => boolean, timeout: number) {
                    return value.call(
                        receiver,
                        (state: any) => {
                            if (!safe()) throw Error('native tree original context ended');
                            const message = state.gameMessages?.find(
                                (m: any) => m.type === 0 && ((m.observationId ?? 0) > revision || m.tick > tick) && /I can't reach that!/i.test(m.text),
                            );
                            if (message) {
                                refusal = message.text;
                                throw Error(refusal);
                            }
                            return predicate(state);
                        },
                        timeout,
                    );
                };
            }
            return typeof value === 'function'
                ? function (...args: unknown[]) {
                      if (typeof key === 'string' && key.startsWith('send') && (!safe() || (key === 'sendInteractLoc' && (!coherent() || !fresh())))) {
                          throw Error('native tree pre-dispatch context changed');
                      }
                      if (key === 'sendInteractLoc') {
                          console.log(
                              'WOOD_TREE_APPROACH ' +
                                  JSON.stringify({
                                      tree: { id: tree.id, x: tree.x, z: tree.z, width, length },
                                      stand,
                                      settlement,
                                      received: received(),
                                      public: {
                                          x: original.sdk.getState()?.player?.worldX,
                                          z: original.sdk.getState()?.player?.worldZ,
                                          level: original.sdk.getState()?.player?.level,
                                      },
                                      tick: original.tick(),
                                  }),
                          );
                      }
                      return value.apply(receiver, args);
                  }
                : value;
        },
    });
    const result = await new BotActions(sdk).chopTree(tree);
    if (refusal) throw Error('native processing tree refusal: ' + refusal);
    if (!safe()) throw Error('native tree context changed during chop');
    return result;
}

export const treeAfterBank = (explicit: string | undefined, normalLogs: number) => explicit ?? (normalLogs < 100 ? 'normal' : 'oak');

const NORTH_NORMAL_TREES = new Set([
    '3078,3307',
    '3081,3308',
    '3082,3304',
    '3083,3306',
    '3084,3298',
    '3086,3296',
    '3087,3307',
    '3089,3301',
    '3089,3310',
    '3090,3305',
    '3093,3301',
    '3096,3310',
]);

export function normalGrove(name = 'south') {
    if (name !== 'south' && name !== 'north') throw Error('unsupported NORMAL_GROVE: ' + name);
    return {
        name,
        spot: name === 'north' ? { x: 3088, z: 3303 } : { x: 3088, z: 3285 },
        contains: (x: number, z: number) =>
            name === 'north' ? NORTH_NORMAL_TREES.has(`${x},${z}`) : x >= 3080 && x <= 3092 && z >= 3272 && z <= 3295,
    };
}

type WoodTree = { x: number; z: number; distance: number; reachable?: boolean; optionsWithIndex: readonly { text: string }[] };

export function woodTreeOrder<T extends WoodTree>(trees: readonly T[], players: readonly { x: number; z: number }[]) {
    const adjacent = (t: T) => players.filter(p => Math.max(Math.abs(p.x - t.x), Math.abs(p.z - t.z)) <= 1).length;
    return trees
        .filter(t => t.reachable !== false && t.optionsWithIndex.some(o => /^chop down$/i.test(o.text)))
        .sort((a, b) => adjacent(a) - adjacent(b) || a.distance - b.distance);
}

const OAK_TILES = new Set(['3081,3291', '3082,3295']);

export function oakGrove(name = 'north') {
    if (name !== 'north' && name !== 'west') throw new Error('unsupported OAK_GROVE: ' + name);
    return {
        name,
        trees: name === 'west' ? new Set(['3070,3253']) : OAK_TILES,
        approach: name === 'west' ? { x: 3070, z: 3253, tol: 3 } : { x: 3088, z: 3285, tol: 3 },
    };
}

export function westOakPathAllowed(from: { x: number; z: number }, corners: readonly { x: number; z: number }[], to = corners.at(-1)) {
    const near = (a: { x: number; z: number } | undefined, x: number, z: number) =>
        !!a && Math.max(Math.abs(a.x - x), Math.abs(a.z - z)) <= 1;
    const access = (near(from, 3092, 3250) && near(to, 3089, 3266)) || (near(from, 3089, 3266) && near(to, 3092, 3250));
    return (
        corners.length > 0 &&
        [from, ...expandPath(from, [...corners])].every(
            p => (p.x <= 3094 || (access && p.x <= 3103 && p.z >= 3250 && p.z <= 3271)) && !(p.x < 3090 && p.z < 3250),
        )
    );
}

const axeShopGates = new WeakMap<object, ShopRetryGate>();

async function walkViaRoute(
    s: Session,
    spot: { x: number; z: number; level?: number },
    stop: () => boolean,
    deps?: GatherExternalDeps,
): Promise<boolean> {
    const tile = { x: spot.x, z: spot.z, level: spot.level ?? 0 };
    return (await defaultWalkTargetPersist(s, tile, 4, deps, t => defaultApproach(s, t, stop, deps))).ok;
}

export const woodStallTicks = (tree: string) => (tree.toLowerCase() === 'magic' ? 700 : 220);

export async function reconcileWoodcuttingAxeAtBank(
    s: Session,
    options: {
        bankSpot: { x: number; z: number; level?: number };
        stop: () => boolean;
        allowShop?: boolean;
        refusedWields?: Set<number>;
        walkTo?: (spot: { x: number; z: number; level?: number }) => Promise<boolean>;
        shopGate?: ShopRetryGate;
        deps?: GatherExternalDeps;
    },
): Promise<{ activeId: number | null; worn: boolean; bought?: number }> {
    const openBank = async () => {
        if (!s.sdk.getState()?.bank?.isOpen) await s.bot.openBank();
    };
    const hooks = sessionToolHooks(s, {
        openBank,
        walkTo: options.walkTo ?? (spot => walkViaRoute(s, spot, options.stop, options.deps)),
        waitUntil: (pred, timeoutTicks) => waitUntil(s, pred, { timeoutTicks }),
        stop: options.stop,
    });
    const wornItems = () => s.sdk.getEquipment?.() ?? s.sdk.getState()?.equipment ?? [];
    await openBank();
    if (!(await waitUntil(s, () => options.stop() || !!s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 10 })) || options.stop()) {
        const levels = readSkillLevels(s.sdk);
        const cur = bestWoodcuttingAxe([...s.sdk.getInventory(), ...wornItems().filter(e => e.slot === 3)], levels).current;
        return { activeId: cur?.item.id ?? null, worn: !!cur && wornItems().some(e => e.slot === 3 && e.id === cur.item.id) };
    }

    const bankItems = s.bankObservation?.()?.items ?? s.sdk.getState()?.bank?.items ?? [];
    const levels = readSkillLevels(s.sdk);
    let bought: number | undefined;
    const axeTier = tierBoundaryOf(levels.woodcutting, [1, 6, 21, 31, 41]);
    const shopGate = sessionShopGate(axeShopGates, s, options.shopGate);

    if (options.allowShop && shouldAttemptShopUpgrade(shopGate, axeTier, s.tick?.() ?? 0)) {
        const stock = [...s.sdk.getInventory(), ...wornItems().filter(e => e.slot === 3), ...bankItems];
        const totalCoins = stock.filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
        const shopPlan = planToolShopUpgrade('woodcutting-axe', stock, totalCoins, levels, {
            allowedShops: ['axeshop'],
            onlyWhenStarterOrMissing: false,
        });
        if (shopPlan && !options.stop()) {
            const res = await executeShopToolPurchase(hooks, {
                targetId: shopPlan.target.id,
                shop: 'axeshop',
                maxBudget: shopPlan.coinBudgetNeeded,
                returnBankSpot: options.bankSpot,
            });
            recordShopAttempt(shopGate, axeTier, s.tick?.() ?? 0, res.bought);
            if (res.bought) {
                bought = res.id;
                console.log(`WOOD_SHOP_AXE ${JSON.stringify(res)}`);
                await openBank();
                await waitUntil(s, () => options.stop() || !!s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 10 });
                const spareCoins = s.sdk.getInventory().find(i => i.id === 995);
                if (spareCoins && !options.stop()) await depositObserved(s, spareCoins);
            }
        }
    }

    const latestBank = s.bankObservation?.()?.items ?? s.sdk.getState()?.bank?.items ?? [];
    const rec = bestWoodcuttingAxe([...s.sdk.getInventory(), ...wornItems().filter(e => e.slot === 3), ...latestBank], levels).current;
    if (!rec) return { activeId: null, worn: false, bought };

    const res = await reconcileBankTool(hooks, {
        targetId: rec.item.id,
        canWield: rec.canWield,
        toolGroupIds: AXE_IDS,
        refusedWields: options.refusedWields,
    });
    return { activeId: res.activeId, worn: res.worn, bought };
}

export async function runDraynorOak(
    s: Session,
    o: {
        cap: number;
        maximum: number;
        prepare: boolean;
        grove?: string;
        noProgress?: number;
        walk?: (x: number, z: number, tol: number) => Promise<boolean>;
    },
) {
    const grove = oakGrove(o.grove);
    if (!Number.isSafeInteger(o.cap) || o.cap < 1 || !Number.isSafeInteger(o.maximum) || o.maximum < 1 || o.maximum > 25) {
        throw new Error('oak needs CAP>0 and MAX_MAKE1..25');
    }
    const st = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const xp = () => s.sdk.getSkillXp('Woodcutting') ?? 0;
    const count = (items: readonly { id: number; count: number }[], id: number) =>
        items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const held = (id: number) => count(inv(), id);
    if (!(await waitUntil(s, () => hp() > 0 && (s.sdk.getSkill('Woodcutting')?.baseLevel ?? 0) >= 15, { timeoutTicks: 15 }))) {
        throw new Error('oak skill readiness failed');
    }
    const p0 = st()?.player;
    const start = s.tick();
    const initialXp = xp();
    const initialHp = hp();
    if (!p0 || p0.level !== 0 || Math.max(Math.abs(p0.worldX - 3092), Math.abs(p0.worldZ - 3243)) > 5) {
        throw new Error('oak PREPARE requires known Draynor bank start');
    }
    let ended = false;
    let died = false;
    let damaged = false;
    let hpMin = initialHp;
    let bankTrips = 0;
    let banked = 0;
    let failure = '';
    let baselineOak = 0;
    let lastProgress = s.tick();
    let walkTicks = 0;
    let plannedPathTiles = 0;
    let observedTileDistance = 0;
    let packStarted: number | undefined;
    let packFillTicks = 0;
    let previous = { x: p0.worldX, z: p0.worldZ, level: p0.level };
    const pathLegs: { from: { x: number; z: number }; to: { x: number; z: number }; tiles: number }[] = [];
    void s.ended.then(() => {
        ended = true;
    });
    const observe = () => {
        const p = st()?.player;
        if (p) {
            if (previous.level === p.level) {
                observedTileDistance += Math.max(Math.abs(p.worldX - previous.x), Math.abs(p.worldZ - previous.z));
            }
            previous = { x: p.worldX, z: p.worldZ, level: p.level };
        }
        hpMin = Math.min(hpMin, hp());
        damaged ||= hp() < initialHp;
        died ||= !!p?.isDead || (p?.lifeId ?? p0.lifeId) !== p0.lifeId || (p?.respawnCount ?? 0) > (p0.respawnCount ?? 0);
    };
    const off = s.onTick(observe);
    const over = () => {
        observe();
        return ended || died || damaged || s.tick() - start >= o.cap;
    };
    const foodIds = [315, 2309, 333, 329];
    const foods = () => foodIds.reduce((n, id) => n + held(id), 0);
    const walk = async (x: number, z: number, tol: number) => {
        const tick = s.tick();
        try {
            if (o.walk) return await o.walk(x, z, tol);
            const deps = await sessionWalker(s);
            const plan = deps.plan;
            deps.plan = (level, from, to) => {
                const corners = plan(level, from, to);
                const tiles = expandPath(from, corners);
                if (grove.name === 'west' && !westOakPathAllowed(from, corners, to)) {
                    console.log('OAK_ROUTE_REFUSED ' + JSON.stringify({ from, to, corners, tiles: tiles.length }));
                    throw new Error(`west oak path refused: unsafe or unknown plan ${from.x},${from.z}->${to.x},${to.z}`);
                }
                plannedPathTiles += tiles.length;
                pathLegs.push({ from, to, tiles: tiles.length });
                return corners;
            };
            return (await walkPath(deps, [{ x, z, tol }], { stop: () => ended || died, maxTicks: 180 })).ok;
        } finally {
            walkTicks += s.tick() - tick;
        }
    };
    const open = async () => {
        if (st()?.bank.isOpen && s.bankObservation?.()) return;
        const generation = s.bankObservation?.()?.generation ?? 0;
        if (
            !(await s.bot.openBank()).success ||
            !(await waitUntil(s, () => !!st()?.bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 20 }))
        ) {
            throw new Error('no wood progress: bank readiness unknown');
        }
        bankTrips++;
    };
    let bankSnapshot: { id: number; count: number }[] = [];
    const bankItems = () => {
        const observed = s.bankObservation?.();
        if (observed) bankSnapshot = observed.items.map(i => ({ id: i.id, count: i.count }));
        return bankSnapshot;
    };
    const bankCount = (id: number) => count(bankItems(), id);
    const assets = () => {
        const m = new Map<number, number>();
        for (const i of [...inv(), ...(st()?.equipment ?? []), ...bankItems()]) {
            if (i.id !== OAK_LOGS) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        }
        return m;
    };
    let original = new Map<number, number>();
    const deposit = async () => {
        await open();
        const item = inv().find(i => i.id === OAK_LOGS);
        if (item) {
            const before = bankCount(OAK_LOGS);
            const n = held(OAK_LOGS);
            if (
                !(await s.bot.depositItem(item, -1)).success ||
                !(await waitUntil(s, () => held(OAK_LOGS) === 0 && bankCount(OAK_LOGS) === before + n, { timeoutTicks: 20 }))
            ) {
                throw new Error('no wood progress: oak deposit unobserved');
            }
        }
        banked = bankCount(OAK_LOGS) - baselineOak;
    };
    try {
        await open();
        baselineOak = bankCount(OAK_LOGS);
        original = assets();
        if (held(OAK_LOGS)) throw new Error('oak needs empty carried output for NEW-log accounting');
        if (o.prepare) {
            const levels = readSkillLevels(s.sdk);
            const eq = (st()?.equipment ?? []).filter(e => e.slot === 3);
            const chosen = bestWoodcuttingAxe([...inv(), ...eq, ...bankItems()], levels).current;
            const axeId = chosen?.item.id;
            const missingAxe = !axeId || (held(axeId) < 1 && !count(eq, axeId));
            const foodNeed = Math.max(0, 2 - foods());
            if (!axeId || (missingAxe && bankCount(axeId) < 1) || foodIds.reduce((n, id) => n + bankCount(id), 0) < foodNeed) {
                throw new Error('oak owned axe/food unavailable');
            }
            if (missingAxe) {
                const item = st()!.bank.items.find(i => i.id === axeId)!;
                if (!(await s.bot.withdrawItem(item, 1, { asNote: false })).success || held(axeId) !== 1) {
                    throw new Error('oak owned axe withdrawal failed');
                }
            }
            for (const id of foodIds) {
                const n = Math.min(Math.max(0, 2 - foods()), bankCount(id));
                if (n) {
                    const item = st()!.bank.items.find(i => i.id === id)!;
                    if (!(await s.bot.withdrawItem(item, n, { asNote: false })).success) {
                        throw new Error('oak owned food withdrawal failed');
                    }
                }
            }
        }
        const activeAxe = bestWoodcuttingAxe([...inv(), ...(st()?.equipment ?? []).filter(e => e.slot === 3)], readSkillLevels(s.sdk)).current;
        if (!activeAxe || foods() < 2) throw new Error('oak needs owned usable axe and2working foods');
        if (inv().length > 3) throw new Error('oak bounded25 needs only axe and2foods held; no unrelated cargo');
        await s.bot.closeBank();
        for (const [x, z, tol] of [
            [3092, 3250, 1],
            [3089, 3266, 1],
            [grove.approach.x, grove.approach.z, grove.approach.tol],
        ]) {
            if (!(await walk(x!, z!, tol!))) throw new Error('no wood progress: guarded northern entry failed');
        }
        packStarted = lastProgress = s.tick();
        while (held(OAK_LOGS) < o.maximum && !over()) {
            if (s.tick() - lastProgress >= (o.noProgress ?? 180)) throw new Error('no wood progress: bounded oak output wait');
            const locs = st()?.nearbyLocs;
            let tree: NonNullable<typeof locs>[number] | undefined;
            if (locs) {
                for (let i = 0; i < locs.length; i++) {
                    const l = locs[i]!;
                    if (
                        l.id === 1281
                        && grove.trees.has(`${l.x},${l.z}`)
                        && l.optionsWithIndex.some(op => CHOP_DOWN_OP_RE.test(op.text))
                        && (!tree || l.distance < tree.distance)
                    ) {
                        tree = l;
                    }
                }
            }
            if (!tree) {
                await waitTicks(s, 1);
                continue;
            }
            const before = held(OAK_LOGS);
            const beforeXp = xp();
            const op = tree.optionsWithIndex.find(x => CHOP_DOWN_OP_RE.test(x.text))!;
            if (st()?.dialog?.isOpen || st()?.modalOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
            await s.sdk.sendInteractLoc(tree.x, tree.z, tree.id, op.opIndex);
            await waitUntil(
                s,
                () =>
                    over() ||
                    (held(OAK_LOGS) > before && xp() > beforeXp) ||
                    !st()?.nearbyLocs.some(l => l.id === tree.id && l.x === tree.x && l.z === tree.z),
                { timeoutTicks: 8 },
            );
            if (held(OAK_LOGS) > before && xp() > beforeXp) lastProgress = s.tick();
            else await waitTicks(s, 1);
        }
    } catch (e) {
        failure = `no wood progress: ${String(e)}`;
    } finally {
        if (packStarted !== undefined) packFillTicks = s.tick() - packStarted;
        if (!ended && !died) {
            try {
                for (const [x, z, tol] of [
                    [3089, 3266, 1],
                    [3092, 3250, 1],
                    [3092, 3243, 2],
                ]) {
                    if (!(await walk(x!, z!, tol!))) throw new Error('oak final bank route failed');
                }
                await deposit();
                await s.bot.closeBank();
            } catch (e) {
                failure = [failure, String(e)].filter(Boolean).join('; ');
            }
        }
        off();
    }
    const final = assets();
    const preserved = original.size > 0 && original.size === final.size && [...original].every(([id, n]) => final.get(id) === n);
    const targetMet = banked === o.maximum && held(OAK_LOGS) === 0;
    console.log(
        'OAK_ROUTE ' +
            JSON.stringify({
                grove: grove.name,
                plannedPathTiles: o.walk ? null : plannedPathTiles,
                pathLegs,
                observedTileDistance,
                walkTicks,
                packFillTicks,
                banked,
            }),
    );
    return {
        ok: !failure && !ended && !died && !damaged && targetMet && preserved,
        tree: 'oak',
        grove: grove.name,
        banked,
        newLogs: banked + held(OAK_LOGS),
        xpGain: xp() - initialXp,
        bankTrips,
        walkTicks,
        packFillTicks,
        plannedPathTiles: o.walk ? null : plannedPathTiles,
        observedTileDistance,
        hpMin,
        died,
        damaged,
        preserved,
        targetMet,
        ticks: s.tick() - start,
        failure:
            failure ||
            (damaged
                ? 'no wood progress: route HP loss'
                : !preserved
                  ? 'no wood progress: kit conservation mismatch'
                  : !targetMet
                    ? 'no wood progress: oak target unmet'
                    : '-'),
    };
}

export async function runYewsGather(s: Session, cfg: NormalizedGatherConfig, stop: () => boolean): Promise<GatherOutcome> {
    const region = cfg.region ?? resolveSetting(cfg, 'REGION');
    const local = region === 'lumbridge';
    const draynor = region === 'draynor';
    const normalGroveArg = resolveSetting(cfg, 'NORMAL_GROVE');
    const woodGroveArg = resolveSetting(cfg, 'WOOD_GROVE');
    const explicitTree = cfg.spot ?? resolveSetting(cfg, 'TREE');
    const prepareArg = resolveSetting(cfg, 'PREPARE');
    const maxMakeArg = resolveSetting(cfg, 'MAX_MAKE');
    const oakGroveArg = resolveSetting(cfg, 'OAK_GROVE');
    const cap = cfg.target?.capTicks ?? Number(cfg.args[0] ?? resolveSetting(cfg, 'CAP') ?? 15000);
    const bankAt = Number(cfg.args[1] ?? resolveSetting(cfg, 'BANK_AT') ?? 27);
    const maxTrips = cfg.target?.trips ?? Number(resolveSetting(cfg, 'MAX_TRIPS') ?? Infinity);

    const grove = draynor ? normalGrove(normalGroveArg) : undefined;
    let spot = local ? { x: 3226, z: 3237 } : draynor ? grove!.spot : { x: 2712, z: 3462 };
    const bankTile = local || draynor ? { x: 3092, z: 3243 } : { x: 2727, z: 3492 };
    let treeKind = explicitTree ?? (draynor ? 'normal' : 'yew');
    if (woodGroveArg !== undefined) {
        if (woodGroveArg !== 'native-processing' || local || draynor) throw Error('invalid WOOD_GROVE');
        spot = seersProcessingGrove(treeKind);
    }
    if (normalGroveArg && (!draynor || treeKind !== 'normal')) throw Error('NORMAL_GROVE requires Draynor normal trees');
    const logRe = draynor && !explicitTree ? /^(logs|oak logs)$/i : treeKind === 'normal' ? /^logs$/i : new RegExp(`^${treeKind} logs$`, 'i');
    let treeRe = treeKind === 'normal' ? /^tree$/i : new RegExp(`^${treeKind}`, 'i');
    if (draynor && treeKind === 'oak') oakGrove(oakGroveArg);
    if (grove?.name === 'north' && (s.sdk.getState()?.player?.combatLevel ?? 0) < 13) {
        return {
            ok: false,
            kind: 'refused',
            detail: 'no wood progress: northern grove requires combat13',
            delta: { elapsedTicks: 0 },
            recoverable: false,
            resultLine: 'no wood progress: northern grove requires combat13',
        };
    }

    if (draynor && treeKind === 'oak' && (prepareArg === '1' || maxMakeArg)) {
        const r = await runDraynorOak(s, {
            cap,
            maximum: Number(maxMakeArg ?? 25),
            prepare: prepareArg === '1',
            grove: oakGroveArg,
        });
        const line = `mode=draynor-oak ${Object.entries(r)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}`;
        return {
            ok: r.ok,
            kind: r.ok ? 'completed' : r.died ? 'died' : 'failed',
            detail: line,
            delta: { items: { [OAK_LOGS]: r.banked }, xp: { Woodcutting: r.xpGain }, elapsedTicks: r.ticks },
            recoverable: !r.ok,
            summary: r,
            resultLine: line,
        };
    }

    const pos = () => s.sdk.getState()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const heldLogs = () => countItems(s, logRe);
    const freeSpace = () => 28 - (s.sdk.getState()?.inventory?.length ?? 0);
    const t0 = s.tick();
    const xp0 = s.sdk.getSkillXp('Woodcutting') ?? 0;
    const used = () => s.tick() - t0;
    let ended = false;
    let died = false;
    const life = pos()?.lifeId;
    const respawns = pos()?.respawnCount ?? 0;
    void s.ended.then(() => {
        ended = true;
    });
    const over = () => stop() || used() >= cap || ended || died;

    const hp0 = hp();
    let hpMin = hp0;
    const off = s.onTick(() => {
        if (hp0 > 0) hpMin = Math.min(hpMin, hp());
        const p = pos();
        if (p?.isDead || (p?.respawnCount ?? 0) > respawns || (life !== undefined && (p?.lifeId ?? life) !== life)) died = true;
    });

    const retryAfter = new Map<string, number>();
    let progressTick = s.tick();
    let chops = 0;
    let banked = 0;
    let bankTrips = 0;
    let walkTicks = 0;
    const counters = () => `chops=${chops} banked=${banked} held=${heldLogs()} bankTrips=${bankTrips} walkTicks=${walkTicks} hpMin=${hpMin}`;

    const walk = async (x: number, z: number, tol = 2): Promise<boolean> => {
        const a = s.tick();
        for (let i = 0; i < 3 && !over(); i++) {
            const p = pos();
            if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
            const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop: over });
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                await waitTicks(s, 1);
            }
        }
        walkTicks += s.tick() - a;
        progressTick = s.tick();
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };

    const refusedWields = new Set<number>();
    let toolLevels = readSkillLevels(s.sdk);
    const activeAxe = () =>
        bestWoodcuttingAxe(
            [...s.sdk.getInventory(), ...(s.sdk.getEquipment?.() ?? s.sdk.getState()?.equipment ?? []).filter(e => e.slot === 3)],
            readSkillLevels(s.sdk),
        ).current;
    const bank = async (forceToolCheck = false) => {
        const n = heldLogs();
        if (n === 0 && freeSpace() > 0 && !forceToolCheck) return;
        if ((local || draynor) && (pos()?.worldX ?? 0) > 3150) {
            for (const [x, z] of [
                [3226, 3256],
                [3180, 3258],
                [3140, 3270],
                [3100, 3270],
                [3089, 3266],
                [3092, 3250],
            ]) {
                await walk(x!, z!, 2);
            }
        }
        if (draynor) await walk(3092, 3250, 1);
        await walk(bankTile.x, bankTile.z, 2);
        const b = await s.bot.openBank();
        if (!b.success) {
            console.log(`WARN openBank failed: ${b.message}`);
            await waitTicks(s, 2);
            return;
        }
        if (s.sdk.getInventory().filter(i => WC_BANK_FOOD_RE.test(i.name)).length < 3) {
            for (const food of [/^salmon$/i, /^trout$/i, /^cooked chicken$/i]) {
                if (s.sdk.getState()?.bank?.items.some(i => food.test(i.name) && i.count > 0)) {
                    await s.bot.withdrawItem(food, 5);
                    break;
                }
            }
        }
        await s.bot.depositItem(logRe, -1);
        for (const item of s.sdk.getInventory()) {
            if (!WC_KEEP_ITEM_RE.test(item.name)) {
                await s.bot.depositItem(item.name, -1);
            }
        }
        if (heldLogs() > 0) await waitTicks(s, 1);
        const after = heldLogs();
        banked += n - after;
        if (!forceToolCheck || n > 0) bankTrips++;
        if (!over()) await bankCargo(s, [logRe], 0, { stopped: over });
        if (!over()) {
            const axeWalk = async (target: { x: number; z: number; level?: number }) => {
                if ((local || draynor) && target.x === 3231 && target.z === 3203) {
                    for (const [x, z] of [
                        [3092, 3250],
                        [3089, 3266],
                        [3100, 3270],
                        [3140, 3270],
                        [3180, 3258],
                        [3220, 3256],
                    ]) {
                        if (!(await walk(x!, z!, 2))) return false;
                    }
                    return walk(target.x, target.z, 2);
                }
                if ((local || draynor) && target.x === bankTile.x && target.z === bankTile.z) {
                    for (const [x, z] of [
                        [3220, 3256],
                        [3180, 3258],
                        [3140, 3270],
                        [3100, 3270],
                        [3089, 3266],
                        [3092, 3250],
                    ]) {
                        if (!(await walk(x!, z!, 2))) return false;
                    }
                    return walk(bankTile.x, bankTile.z, 2);
                }
                return walkViaRoute(s, target, over, cfg.deps);
            };
            await reconcileWoodcuttingAxeAtBank(s, {
                bankSpot: bankTile,
                stop: over,
                allowShop: local || draynor,
                refusedWields,
                walkTo: axeWalk,
                deps: cfg.deps,
            });
        }
        if (draynor) {
            const logs = s.sdk.getState()?.bank?.items.find(i => /^logs$/i.test(i.name))?.count ?? 0;
            treeKind = treeAfterBank(explicitTree, logs);
            treeRe = treeKind === 'normal' ? /^tree$/i : new RegExp(`^${treeKind}`, 'i');
            spot = grove!.spot;
        }
        await s.bot.closeInterface();
        console.log(`MILESTONE bank t=${used()} banked=${banked} totalChops=${chops}`);
    };

    try {
        console.log(`START yew logger ${s.name} at=${pos()?.worldX},${pos()?.worldZ}`);
        if ((local || draynor) && (pos()?.worldX ?? 0) > 3150) {
            await s.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' });
            await s.direct({ type: 'walkTo', x: 3220, z: 3256, running: true, reason: 'SDK' });
            await walk(3220, 3256, 2);
            for (const [x, z] of [
                [3180, 3258],
                [3140, 3270],
                [3100, 3270],
                [3089, 3266],
                [3092, 3250],
            ]) {
                await walk(x!, z!, 2);
            }
            await bank(true);
        } else if (
            !activeAxe() ||
            (activeAxe()!.item.id === 1351 && (local || draynor)) ||
            Math.max(Math.abs((pos()?.worldX ?? 0) - bankTile.x), Math.abs((pos()?.worldZ ?? 0) - bankTile.z)) <= 6
        ) {
            await bank(true);
        }

        while (!over() && bankTrips < maxTrips) {
            const curLevels = readSkillLevels(s.sdk);
            if (crossedTierBoundary(toolLevels, curLevels, ['attack', 'woodcutting'], 'woodcutting-axe')) {
                toolLevels = curLevels;
                await bank(true);
                continue;
            }
            const actual = banked + heldLogs();
            if (actual > chops) progressTick = s.tick();
            chops = actual;
            const stallTicks = woodStallTicks(treeKind);
            if (s.tick() - progressTick > stallTicks) throw new Error(`no wood progress for ${stallTicks} ticks`);
            if (heldLogs() >= bankAt || freeSpace() === 0) {
                await bank();
                continue;
            }

            const p = pos();
            if (!p) {
                await waitTicks(s, 1);
                continue;
            }
            if (hp() < 7) {
                const food = s.sdk.getInventory().find(i => /^(shrimps|bread|trout|salmon|lobster|cooked chicken)$/i.test(i.name));
                if (food) await s.bot.eatFood(food.name);
                else if (hp() < 4) {
                    await s.direct({ type: 'walkTo', x: 3088, z: 3285, running: true, reason: 'SDK' });
                    await walk(3088, 3285, 2);
                    throw new Error('low HP: no food; escaped to northern trees');
                }
            }

            if (Math.max(Math.abs(p.worldX - spot.x), Math.abs(p.worldZ - spot.z)) > 12) {
                if (local) {
                    for (const [x, z] of [
                        [3092, 3250],
                        [3089, 3266],
                        [3100, 3270],
                        [3140, 3270],
                        [3180, 3258],
                        [3226, 3256],
                    ]) {
                        await walk(x!, z!, 2);
                    }
                }
                if (draynor) await walk(3092, 3250, 1);
                await walk(spot.x, spot.z, 4);
                continue;
            }

            const before = heldLogs();
            const nearbyLocs = s.sdk.getState()?.nearbyLocs ?? [];
            const matching = nearbyLocs.filter(
                l =>
                    treeRe.test(l.name) &&
                    (!local || (l.x >= 3214 && l.x <= 3239 && l.z >= 3226 && l.z <= 3250)) &&
                    (!draynor || grove!.contains(l.x, l.z)) &&
                    (retryAfter.get(`${l.x},${l.z}`) ?? 0) <= s.tick(),
            );
            if (matching.length > 1) matching.sort((a, b) => a.distance - b.distance);
            const tree = woodTreeOrder(matching, s.sdk.getState()?.nearbyPlayers ?? [])[0];
            if (!tree) {
                await waitTicks(s, 1);
                continue;
            }
            if (draynor) {
                const xp = s.sdk.getSkillXp('woodcutting') ?? 0;
                const a = s.tick();
                if (s.sdk.getState()?.dialog?.isOpen || s.sdk.getState()?.modalOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                const option = tree.optionsWithIndex.find(o => CHOP_DOWN_OP_RE.test(o.text));
                if (!option) {
                    retryAfter.set(`${tree.x},${tree.z}`, s.tick() + 20);
                    await waitTicks(s, 1);
                    continue;
                }
                const sent = await s.sdk.sendInteractLoc(tree.x, tree.z, tree.id, option.opIndex);
                if (sent.success) {
                    await waitUntil(
                        s,
                        () =>
                            over() ||
                            (heldLogs() > before && (s.sdk.getSkillXp('woodcutting') ?? 0) > xp) ||
                            !s.sdk.getState()?.nearbyLocs.some(l => l.id === tree.id && l.x === tree.x && l.z === tree.z),
                        { timeoutTicks: 20 },
                    );
                }
                if (heldLogs() > before && (s.sdk.getSkillXp('woodcutting') ?? 0) > xp) {
                    chops = banked + heldLogs();
                    progressTick = s.tick();
                } else {
                    retryAfter.set(`${tree.x},${tree.z}`, s.tick() + 20);
                    console.log(`WARN wood tree=${tree.id}@${tree.x},${tree.z} ticks=${s.tick() - a} no log and XP gain`);
                    await waitTicks(s, 1);
                }
            } else {
                if (s.sdk.getState()?.dialog?.isOpen || s.sdk.getState()?.modalOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                const r = woodGroveArg === 'native-processing' ? await chopProcessingTree(s, tree, over) : await s.bot.chopTree(tree);
                if (r.success) {
                    chops = banked + heldLogs();
                    if (heldLogs() > before) progressTick = s.tick();
                } else {
                    retryAfter.set(`${tree.x},${tree.z}`, s.tick() + 15);
                    await waitTicks(s, 1);
                }
            }
        }

        if (!ended && !died) await bank();
        chops = banked + heldLogs();
        const perK = ((chops * 1000) / Math.max(1, used())).toFixed(2);
        const line = `ticks=${used()} died=${died} tree=${treeKind} ${counters()} logsPer1kTicks=${perK}`;
        const ok = chops > 0 && !died && !ended;
        return {
            ok,
            kind: ok ? 'completed' : died ? 'died' : 'failed',
            detail: line,
            delta: { xp: { Woodcutting: (s.sdk.getSkillXp('Woodcutting') ?? xp0) - xp0 }, elapsedTicks: used() },
            recoverable: !ok,
            summary: { chops, banked, tree: treeKind, died, ended, ticks: used() },
            resultLine: line,
        };
    } finally {
        off();
    }
}

// ---------------------------------------------------------------------------
// 4. Lumbridge Basic Chop + Drop Loop (`woodcutting:loop`)
// ---------------------------------------------------------------------------
export async function runWcLoop(s: Session, callerStop: () => boolean = () => false, cap = 400): Promise<GatherOutcome> {
    const t0 = Date.now();
    const startTick = s.tick();
    let ended = false;
    void s.ended?.then(() => { ended = true; });
    const isStopped = () => ended || productionStopRequested(s.name, callerStop);
    const xp0 = s.sdk.getSkillXp('Woodcutting') ?? 0;
    const levels = readSkillLevels(s.sdk);
    const inv = s.sdk.getInventory();
    const eq = s.sdk.getEquipment();
    const rec = bestWoodcuttingAxe([...inv, ...eq.filter(e => e.slot === 3)], levels).current;
    if (rec && rec.canWield && !eq.some(e => e.slot === 3 && e.id === rec.item.id)) {
        const weapon = eq.find(e => e.slot === 3);
        if (!weapon || (WOODCUTTING_AXES_DESC as readonly number[]).includes(weapon.id)) {
            const held = inv.find(i => i.id === rec.item.id);
            if (held) await s.bot.equipItem(held);
        }
    }
    let chops = 0;
    let stoppedEarly = false;
    for (let i = 0; i < 8; i++) {
        if (isStopped() || s.tick() - startTick >= cap) {
            stoppedEarly = true;
            break;
        }
        const r = await s.bot.chopTree(/^tree$/i);
        if (r.success) chops++;
        else console.log(`chop ${i + 1} failed: ${r.message ?? ''}`);
        if (isStopped()) {
            stoppedEarly = true;
            break;
        }
        await s.bot.dropItem(/logs/i, 'all');
    }
    const xp1 = s.sdk.getSkillXp('Woodcutting') ?? 0;
    const line = `RESULT chops=${chops} wcXpGained=${xp1 - xp0} seconds=${((Date.now() - t0) / 1000).toFixed(1)}`;
    console.log(line);
    return {
        ok: !stoppedEarly,
        kind: stoppedEarly ? 'aborted' : 'completed',
        detail: stoppedEarly ? 'woodcutting loop stopped or cap reached' : line,
        delta: { xp: { Woodcutting: xp1 - xp0 }, elapsedTicks: s.tick() - startTick },
        recoverable: stoppedEarly,
        summary: { chops, wcXpGained: xp1 - xp0 },
        resultLine: line,
    };
}

// ---------------------------------------------------------------------------
// 5. Unified Woodcutting Session & CLI
// ---------------------------------------------------------------------------
export async function runWoodcuttingSession(
    s: Session,
    cfg: NormalizedGatherConfig,
    stop: () => boolean,
): Promise<GatherOutcome> {
    switch (cfg.method) {
        case 'edgeville': {
            const result = await runEdgevilleWoodcut(s, stop);
            const line = 'EDGEVILLE_WOODCUT ' + JSON.stringify(result);
            console.log(line);
            return {
                ok: result.ok,
                kind: result.ok ? 'completed' : 'failed',
                detail: result.failure ?? line,
                delta: { items: { [OAK_LOGS]: result.banked }, xp: { Woodcutting: result.xp }, elapsedTicks: result.ticks },
                recoverable: !result.ok,
                summary: result,
                resultLine: line,
            };
        }
        case 'woodcut-supply': {
            const logs = Number(resolveSetting(cfg, 'SUPPLY_LOGS') ?? cfg.target?.count ?? 1);
            const headless = Number(resolveSetting(cfg, 'SUPPLY_HEADLESS') ?? 0);
            const cap = cfg.target?.capTicks ?? Number(resolveSetting(cfg, 'CAP') ?? 1000);
            const r = await runWoodSupply(s, logs, headless, cap, cfg.deps, stop);
            const line = `woodcut-supply ok=${r.ok} gathered=${r.gathered} ticks=${r.ticks}`;
            return {
                ok: r.ok,
                kind: r.ok ? 'completed' : 'failed',
                detail: r.error ?? line,
                delta: { elapsedTicks: r.ticks },
                recoverable: !r.ok,
                summary: r,
                resultLine: line,
            };
        }
        case 'yews':
            return runYewsGather(s, cfg, stop);
        case 'loop':
            return runWcLoop(s, stop, cfg.target?.capTicks ?? 400);
        default:
            return {
                ok: false,
                kind: 'refused',
                detail: `unknown woodcutting method: ${cfg.method}`,
                delta: { elapsedTicks: 0 },
                recoverable: false,
            };
    }
}

export async function runWoodcuttingCli(account: string, cfg: NormalizedGatherConfig): Promise<number> {
    if (cfg.method === 'edgeville') {
        if (!/^[a-z0-9]{1,12}$/i.test(account)) {
            throw Error('Usage: edgeville woodcutting requires valid <account>');
        }
        const stopped = () => isStopFilePresent(account);
        let session: Session | undefined;
        let failure: string | undefined;
        try {
            checkAssert(!stopped(), 'Woodcutting stopped before login');
            const end = async (_: Session, reason: string) => {
                failure = reason;
            };
            session = await openBot(account, { onStop: end, onSessionEnd: end });
            const outcome = await runWoodcuttingSession(session, cfg, () => Boolean(failure) || stopped());
            if (!outcome.ok) failure ??= outcome.detail ?? 'Woodcutting target incomplete';
        } catch (error) {
            failure = String(error);
        }
        const saved = session ? await settle([session], !failure, failure ?? 'Edgeville Woodcutting 36') : false;
        if (!saved || failure) {
            process.exitCode = 1;
            return 1;
        }
        return 0;
    }

    if (cfg.method === 'yews') {
        const region = cfg.region ?? resolveSetting(cfg, 'REGION');
        const treeKind = cfg.spot ?? resolveSetting(cfg, 'TREE') ?? (region === 'draynor' ? 'normal' : 'yew');
        if (region === 'draynor' && treeKind === 'oak') {
            oakGrove(resolveSetting(cfg, 'OAK_GROVE'));
        }
    }

    let stopped = false;
    let s: Session | undefined;
    try {
        s = await openBot(account, {
            onStop: (session, reason) => {
                stopped = true;
                return finish([session], false, reason);
            },
            onSessionEnd: async () => {
                stopped = true;
            },
        });
    } catch (e) {
        await finish([], false, `login: ${String(e)}`);
        return 1;
    }
    try {
        const outcome = await runWoodcuttingSession(s, cfg, () => stopped || isStopFilePresent(account));
        await finish([s], outcome.ok, outcome.resultLine ?? outcome.detail ?? '');
        return outcome.ok ? 0 : 1;
    } catch (e) {
        await finish([s], false, String(e));
        return 1;
    }
}
