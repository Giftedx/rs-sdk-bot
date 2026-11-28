// Crafting production helpers: inventory production, progressive production, tanning, clay softening, and black d'hide sets.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountOf, finish, getWorld, openBot, settle } from '../../../core/src/bot';
import { depositObserved } from '../../../core/src/deposit';
import { componentId } from '../../../core/src/logout';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import type { NearbyLoc } from '../../../../vendor/rs-sdk/sdk/types';
import { CONTENT_DIR, packMap } from './catalog';
import { cookingRecipes, registerDefaultInventoryBankRunner, type CookRecipe } from './cooking';
import { inventoryRecipeExp, inventoryRecipes, type InventoryRecipe } from './recipes';
import { nearestBank, productionStopRequested, watchProductionLife } from './runtime';
import type { ArtisanExternalDeps, Session } from './types';

// ---- Inventory Production (microbot-production.ts) ----

export { inventoryRecipeExp, inventoryRecipes, type InventoryRecipe };

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

export function validTargetLevel(level: number | undefined): boolean {
    return level === undefined || (Number.isSafeInteger(level) && level >= 2 && level <= 99);
}

export async function runInventoryProduction(
    io: ProductionIO,
    r: InventoryRecipe,
    o: {
        maximum: number;
        cap: number;
        maxAttempts: number;
        partial?: boolean;
        // The run ends when the recipe skill reaches this level.
        targetLevel?: number;
        // The order is the level: the run passes only at the target level, and ends when the inputs end.
        levelOrder?: boolean;
    },
) {
    const units = r.productUnits ?? 1;
    if (
        ![o.maximum, o.cap, o.maxAttempts].every(n => Number.isSafeInteger(n) && n > 0) ||
        o.maximum % units ||
        o.maxAttempts < o.maximum / units ||
        !validTargetLevel(o.targetLevel) ||
        (o.levelOrder && o.targetLevel === undefined)
    ) {
        throw Error('invalid production limits or output batch multiple');
    }
    const start = io.tick();
    const over = () => io.stopped() || io.tick() - start >= o.cap;
    const reached = () => o.targetLevel !== undefined && io.level() >= o.targetLevel;
    let made = 0;
    let banked = 0;
    let losses = 0;
    let attempts = 0;
    let failure = '';
    let spent = false;
    try {
        if (io.level() < r.level) throw Error('production level missing');
        while (made < o.maximum && attempts < o.maxAttempts && !over() && !reached()) {
            const ready = await io.prepare();
            if (ready !== true) {
                if (ready === 'spent' && (o.levelOrder || (o.partial && made > 0))) {
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
        if (banked !== made) throw Error('production target incomplete');
        if (o.levelOrder) {
            if (!reached()) throw Error(spent ? 'production inputs ended below target level' : 'production target level unreached');
        } else if (!reached() && ((made !== o.maximum && !spent) || over())) {
            throw Error('production target incomplete');
        }
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
        // The bank total of the product that the order's consumer needs. The run makes only the
        // units the bank lacks, so a chain rerun after a later step failed does not repeat it.
        productTarget?: number;
        // The recipe skill level that ends the run. A planner unlock sets levelOrder: the next chain step
        // needs the level, so the unlock passes only at it, and a chain rerun at the level makes nothing.
        targetLevel?: number;
        levelOrder?: boolean;
        stop?: () => boolean;
    },
) {
    const reserves = productionInputReserves(r, o.reserve, o.inputReserves);
    if (o.productTarget !== undefined && (!Number.isSafeInteger(o.productTarget) || o.productTarget < 1)) throw Error('invalid production stock target');
    if (!validTargetLevel(o.targetLevel) || (o.levelOrder && o.targetLevel === undefined)) throw Error('invalid production target level');
    if (r.members && !o.members) throw Error('production recipe requires confirmed members world');
    if (!await waitUntil(s, () => !!s.sdk.getState()?.player && !!s.sdk.getSkill(r.skill) && (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0, { timeoutTicks: 10 })) {
        throw Error('production state unavailable');
    }
    const startLevel = s.sdk.getSkill(r.skill)?.level ?? 0;
    if (o.targetLevel !== undefined && startLevel >= o.targetLevel) {
        const met = { ok: true, recipe: r.name, made: 0, banked: 0, losses: 0, attempts: 0, ticks: 0, failure: '-' };
        console.log('MICROBOT_PRODUCTION ' + JSON.stringify({ ...met, targetLevel: o.targetLevel, level: startLevel }));
        return met;
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
        if (stopped()) throw Error('production bank unavailable');
        // A run can start away from a bank (a chain step after a fight ends where the fight left the account), so a
        // bank that does not open sends the account to the nearest bank once before the run refuses.
        if (!(await s.bot.openBank()).success) {
            const p = state()?.player;
            const bank = p ? nearestBank({ x: p.worldX, z: p.worldZ, level: p.level }) : undefined;
            const ac = new AbortController();
            const off = s.onTick(() => { if (stopped()) ac.abort('production stop'); });
            try {
                const moved = bank ? await goTo(s, await getWorld(), bank, accountOf(s), { legTimeoutTicks: 100, signal: ac.signal }) : { ok: false };
                if (!moved.ok || stopped() || !(await s.bot.openBank()).success) throw Error('production bank unavailable');
            } finally {
                off();
            }
        }
        if (!await waitUntil(s, () => ready() && (s.bankObservation?.()?.generation ?? -1) > generation, { timeoutTicks: 10 })) {
            throw Error('production fresh bank unknown');
        }
    };
    let maximum = o.maximum;
    if (o.productTarget !== undefined) {
        await open();
        const units = r.productUnits ?? 1;
        const owned = (s.bankObservation?.()?.items ?? []).filter(i => i.id === r.product).reduce((n, i) => n + i.count, 0);
        maximum = Math.min(o.maximum, Math.ceil(Math.max(0, o.productTarget - owned) / units) * units);
        if (maximum < 1) {
            await s.bot.closeBank();
            const met = { ok: true, recipe: r.name, made: 0, banked: 0, losses: 0, attempts: 0, ticks: 0, failure: '-' };
            console.log('MICROBOT_PRODUCTION ' + JSON.stringify({ ...met, productTarget: o.productTarget, owned }));
            return met;
        }
    }
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
                    await s.bot.withdrawItem(target, missing, { asNote: false }).catch(() => undefined);
                    let got = await waitUntil(s, () => count(need.id) === before + missing, { timeoutTicks: 8 });
                    if (!got && !stopped() && s.sdk.getState()?.bank?.isOpen && count(need.id) === before) {
                        const retryTarget = s.sdk.getState()?.bank?.items.find(i => i.id === need.id);
                        if (retryTarget && Number.isSafeInteger(retryTarget.slot)) {
                            await s.bot.withdrawItem(retryTarget, missing, { asNote: false }).catch(() => undefined);
                            got = await waitUntil(s, () => count(need.id) === before + missing, { timeoutTicks: 8 });
                        }
                    }
                    if (!got) return false;
                }
                if (stopped() || (r.extraSlot && inv().length >= 28)) return false;
                await s.bot.closeBank();
                let closed = await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
                if (!closed && !stopped()) {
                    await s.direct({ type: 'closeModal', reason: 'production bank close' });
                    closed = await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
                }
                if (!closed) return false;
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
        { ...o, maximum, maxAttempts: o.maxAttempts ?? maximum },
    );
    if (stopped()) {
        result.ok = false;
        result.failure = 'production session stopped';
    }
    console.log('MICROBOT_PRODUCTION ' + JSON.stringify(result));
    return result;
}

registerDefaultInventoryBankRunner(runInventoryBank);

const PRODUCTION_CLI_KEYS = new Set(['MAX_MAKE', 'CAP', 'MAX_ATTEMPTS', 'ORDER_MODE', 'RAW_RESERVE', 'MEMBERS', 'INPUT_RESERVES', 'PRODUCT_TARGET', 'TARGET_LEVEL', 'TRAIN_SKILL']);

// TARGET_LEVEL ends the run only for the recipe skill: a recipe gives XP to that skill alone.
// ORDER_MODE=level (a planner unlock) passes only at the level.
export function productionLevelOrder(
    r: Pick<InventoryRecipe, 'skill'>,
    setting: (key: string) => string | undefined,
): { targetLevel?: number; levelOrder: boolean } {
    const levelOrder = setting('ORDER_MODE') === 'level';
    const raw = setting('TARGET_LEVEL');
    const skill = setting('TRAIN_SKILL');
    const targetLevel = raw === undefined || (skill !== undefined && skill.toLowerCase() !== r.skill.toLowerCase()) ? undefined : Number(raw);
    if (!validTargetLevel(targetLevel) || (levelOrder && targetLevel === undefined)) throw Error('invalid production limits');
    return { ...(targetLevel !== undefined ? { targetLevel } : {}), levelOrder };
}

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
    const level = productionLevelOrder(r, key => effective[key]);
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
        ...(effective.PRODUCT_TARGET ? { productTarget: Number(effective.PRODUCT_TARGET) } : {}),
        ...level,
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
            productTarget: cli.productTarget,
            targetLevel: cli.targetLevel,
            levelOrder: cli.levelOrder,
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

const equalAssets = (a: Record<number, number>, b: Record<number, number>) => {
    for (const k in a) if ((a[+k] ?? 0) !== (b[+k] ?? 0)) return false;
    for (const k in b) if (!(k in a) && (b[+k] ?? 0) !== 0) return false;
    return true;
};
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

let cachedCertificates: Map<number, number> | undefined;
function certMap(): Map<number, number> {
    if (cachedCertificates) return cachedCertificates;
    const packed = packMap('obj');
    const out = new Map<number, number>();
    for (const [name, id] of packed) {
        if (name.startsWith('cert_')) {
            const baseId = packed.get(name.slice(5));
            if (baseId !== undefined) out.set(id, baseId);
        }
    }
    cachedCertificates = out;
    return out;
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

// Buttons verified against vendor/rs-sdk/server/content/scripts/areas/area_alkharid/scripts/tanner.rs2:67-131.
export const tanningRecipes = {
    soft: { input: 1739, output: 1741, cost: 1, button: 'tanner:com_96', button5: 'tanner:com_95', buttonAll: 'tanner:com_93' },
    hard: { input: 1739, output: 1743, cost: 3, button: 'tanner:com_101', button5: 'tanner:com_100', buttonAll: 'tanner:com_98' },
    green: { input: 1753, output: 1745, cost: 20, button: 'tanner:com_106', button5: 'tanner:com_105', buttonAll: 'tanner:com_103' },
    blue: { input: 1751, output: 2505, cost: 20, button: 'tanner:com_111', button5: 'tanner:com_110', buttonAll: 'tanner:com_108' },
    red: { input: 1749, output: 2507, cost: 20, button: 'tanner:com_116', button5: 'tanner:com_115', buttonAll: 'tanner:com_113' },
    black: { input: 1747, output: 2509, cost: 20, button: 'tanner:com_121', button5: 'tanner:com_120', buttonAll: 'tanner:com_118' },
} as const;

export type TanKind = keyof typeof tanningRecipes;
type TanAssets = { input: number; output: number; coins: number };

export function tanningEffect(before: TanAssets, after: TanAssets, cost: number): boolean {
    return before.input - after.input === 1 && after.output - before.output === 1 && before.coins - after.coins === cost;
}

export function tanningBatchEffect(before: TanAssets, after: TanAssets, cost: number, qty: number): boolean {
    if (!Number.isSafeInteger(qty) || qty < 1) return false;
    return before.input - after.input === qty && after.output - before.output === qty && before.coins - after.coins === cost * qty;
}

export function selectTanChunk(
    remaining: number,
    heldInput: number,
    recipe: (typeof tanningRecipes)[TanKind],
): { button: string; qty: number } {
    if (remaining >= 5 && remaining === heldInput) return { button: recipe.buttonAll, qty: remaining };
    if (remaining >= 5) return { button: recipe.button5, qty: 5 };
    return { button: recipe.button, qty: 1 };
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
            const chunk = selectTanChunk(maximum - made, before.input, r);
            const traded = await s.sdk.sendInteractNpc(npc.index, 3);
            if (!traded.success) throw Error('tanner trade refused');
            if (!await waitUntil(s, () => !!s.sdk.getState()?.interface?.isOpen || over(), { timeoutTicks: Math.min(8, Math.max(1, cap - (s.tick() - start))) })) {
                throw Error('tanning interface timeout');
            }
            if (over()) break;
            await s.sdk.sendClickComponent(componentId(chunk.button));
            await waitUntil(s, () => tanningBatchEffect(before, assets(), r.cost, chunk.qty) || over(), {
                timeoutTicks: Math.min(8, Math.max(1, cap - (s.tick() - start))),
            });
            if (!tanningBatchEffect(before, assets(), r.cost, chunk.qty)) throw Error('tanning item/coin reconciliation failed');
            made += chunk.qty;
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

export async function runBankedTanning(
    s: Session,
    kind: TanKind,
    maximum: number,
    cap = 1500,
    stop: () => boolean = () => false,
    deps?: ArtisanExternalDeps,
) {
    if (!Object.hasOwn(tanningRecipes, kind) || !Number.isSafeInteger(maximum) || maximum < 0 || !Number.isSafeInteger(cap) || cap < 1) {
        throw Error('invalid banked tanning order');
    }
    const r = tanningRecipes[kind];
    const start = s.tick();
    const used = () => s.tick() - start;
    const life = watchProductionLife(s, stop);
    const over = () => life.stopped() || used() >= cap;
    const st = () => s.sdk.getState();
    const held = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const banked = (id: number) =>
        (s.bankObservation?.()?.items ?? st()?.bank?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const waitFor = (pred: () => boolean, timeoutTicks: number) => waitUntil(s, () => over() || pred(), { timeoutTicks });
    const openBank = async (label: string) => {
        const generation = s.bankObservation?.()?.generation ?? 0;
        if (
            !(await s.bot.openBank()).success ||
            !(await waitFor(() => !!st()?.bank?.isOpen && (!s.bankObservation || (s.bankObservation()?.generation ?? 0) > generation), 20))
        ) {
            throw Error(`${label}: bank did not open`);
        }
    };
    const closeBank = async () => {
        await s.bot.closeBank();
        await waitFor(() => !st()?.bank?.isOpen, 10);
    };
    const bankPack = async (label: string) => {
        for (const id of new Set(s.sdk.getInventory().map(i => i.id))) {
            const row = s.sdk.getInventory().find(i => i.id === id);
            if (row && (!(await s.bot.depositItem(row, held(id))).success || !(await waitFor(() => held(id) === 0, 10)))) {
                throw Error(`${label}: deposit of item ${id}`);
            }
        }
    };
    const take = async (id: number, n: number) => {
        if (n < 1) return;
        const row = (st()?.bank?.items ?? []).find((i: { id: number }) => i.id === id);
        const before = held(id);
        if (!row || banked(id) < n) throw Error(`withdraw: ${n} of item ${id} short in bank (${banked(id)} banked)`);
        if (!(await s.bot.withdrawItem(row, n, { asNote: false })).success || !(await waitFor(() => held(id) >= before + n, 10))) {
            throw Error(`withdraw ${n} of item ${id}`);
        }
    };
    const go = async (to: { x: number; z: number; level: number }, label: string) => {
        if (over()) throw Error('banked tanning stopped');
        const p = st()?.player;
        if (p && p.level === to.level && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= 2) return;
        if (deps?.walkTargetPersist) {
            const out = await deps.walkTargetPersist(s, to);
            if (!out.ok) throw Error(`route to ${label}: ${out.reason ?? ''} ${out.detail ?? ''}`);
            return;
        }
        if (p && p.level === to.level && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= 35) {
            const out = await walkPath(await sessionWalker(s), [{ x: to.x, z: to.z, tol: 1 }], { stop: over });
            if (out.ok) return;
        }
        const out = await goTo(s, await getWorld(), to, accountOf(s));
        if (!out.ok) throw Error(`route to ${label}: ${out.detail ?? 'unreachable'}`);
    };

    let made = 0;
    let coinsSpent = 0;
    let trips = 0;
    let detail = '';
    let goal = 0;
    try {
        await go(AL_KHARID_BANK, 'the Al Kharid bank');
        await openBank('tan-stage');
        await bankPack('tan-stage');
        const availableHides = banked(r.input);
        const availableCoins = banked(COINS);
        const affordable = Math.min(availableHides, Math.floor(availableCoins / r.cost));
        goal = maximum > 0 ? Math.min(maximum, affordable) : affordable;
        if (goal < 1) {
            await closeBank();
            throw Error(`no tanning supplies: ${availableHides} hides (${r.input}), ${availableCoins} coins (cost ${r.cost})`);
        }
        while (made < goal && !over()) {
            const n = Math.min(TAN_TRIP, goal - made);
            await take(r.input, n);
            await take(COINS, n * r.cost);
            await closeBank();
            await go(TANNER, 'Ellis the tanner');
            const res = await tanInventory(s, kind, n, Math.max(1, Math.min(cap - used(), 60 + n * 12)), over);
            made += res.made;
            coinsSpent += res.coinsSpent;
            if (!res.ok) throw Error(`tanning: ${res.detail} made=${res.made} of ${n}`);
            await go(AL_KHARID_BANK, 'the Al Kharid bank');
            await openBank('tan-deposit');
            await bankPack('tan-deposit');
            trips++;
        }
        await closeBank();
    } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
    }
    detail ||= life.reason();
    return {
        ok: !detail && made > 0 && made === goal,
        made,
        goal,
        coinsSpent,
        trips,
        ticks: used(),
        detail,
    };
}

export async function runTanningCli(
    botName: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
    deps?: ArtisanExternalDeps,
) {
    const argEnv: Record<string, string> = {};
    const positional: string[] = [];
    for (const a of restArgs) {
        const m = a.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
        if (m) argEnv[m[1]!] = m[2]!;
        else positional.push(a);
    }
    const mergedEnv = { ...env, ...argEnv };
    const banked = mergedEnv.TAN_BANKED === '1';
    const kind = (positional[0] ?? mergedEnv.TAN_KIND) as TanKind;
    const maximum = Number(positional[1] ?? mergedEnv.MAX_MAKE ?? mergedEnv.TARGET_COUNT ?? mergedEnv.BATCH_UNITS ?? (banked ? 27 : 1));
    const cap = Number(positional[2] ?? mergedEnv.CAP ?? (banked ? 1500 : 80));
    if (
        !botName ||
        !Object.hasOwn(tanningRecipes, kind) ||
        !Number.isSafeInteger(maximum) ||
        maximum < (banked ? 0 : 1) ||
        !Number.isSafeInteger(cap) ||
        cap < 1
    ) {
        throw Error('Usage: bun scripts/aio-skiller.ts <account> artisan crafting tanning <soft|hard|green|blue|red|black> [quantity] [ticks]');
    }
    let stopped = false;
    process.once('SIGINT', () => { stopped = true; });
    process.once('SIGTERM', () => { stopped = true; });
    const s = await openBot(botName);
    let ok = false;
    try {
        const result = banked
            ? await runBankedTanning(s, kind, maximum, cap, () => stopped, deps)
            : await tanInventory(s, kind, maximum, cap, () => stopped);
        console.log('TANNING_RESULT ' + JSON.stringify(result));
        ok = result.ok;
    } finally {
        ok = await settle([s], ok, banked ? 'finite banked tanning order' : 'finite tanning order');
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

export async function runSoftenClay(s: Session, options: { cap: number; maximum: number; reserve: number; stop?: () => boolean }) {
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
    const stopped = () => ended || died || productionStopRequested(s.name, options.stop);
    const over = () => stopped() || s.tick() - start >= options.cap;
    const walk = async (x: number, z: number) => {
        const r = await walkPath(await sessionWalker(s), [{ x, z, tol: 1 }], { maxTicks: 250, stop: stopped });
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
    let initial = assets();
    try {
        if (over()) {
            stop = 'cap';
        } else {
            await open();
            await deposit();
            initial = assets();
            output0 = bankCount(SOFT);
            planned = planSoftClay(bankCount(CLAY), options.maximum, options.reserve);
        }
        if (planned && !over()) {
            if (!held(BUCKET) && !held(WATER)) await s.bot.withdrawItem(/^bucket$/i, 1, { asNote: false });
            if (!held(BUCKET) && !held(WATER)) throw new Error('no soft clay progress: owned bucket missing');
            // One trip: the clay fits only the free pack slots beside the bucket and kept items.
            planned = Math.min(planned, 28 - inv().length);
            if (planned < 1) throw new Error('no soft clay progress: no free pack slots');
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
        if (!stopped()) {
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
    let requestedStop = false;
    const s = await openBot(botName, { onStop: async () => { requestedStop = true; } });
    try {
        const r = await runSoftenClay(s, {
            cap: Number(env.CAP ?? 500),
            maximum: Number(env.MAX_MAKE ?? 20),
            reserve: Number(env.RAW_RESERVE ?? 0),
            stop: () => requestedStop,
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

export type DhideTier = 'green' | 'blue' | 'red' | 'black';
export type DhideTierPiece = { recipe: string; product: number; leather: number; level: number };
export type DhideTierSpec = {
    tier: DhideTier;
    hide: number;
    leather: number;
    tanCost: number;
    pieces: readonly [DhideTierPiece, DhideTierPiece, DhideTierPiece];
};

// Pinned content/pack/obj.pack & leather.dbrow specs for all four dragonhide PvP tiers (Green/Blue/Red/Black).
export const DHIDE_TIERS: Readonly<Record<DhideTier, DhideTierSpec>> = {
    green: {
        tier: 'green',
        hide: tanningRecipes.green.input,
        leather: tanningRecipes.green.output,
        tanCost: tanningRecipes.green.cost,
        pieces: [
            { recipe: 'leather:dragonhide_body', product: 1135, leather: 3, level: 63 },
            { recipe: 'leather:dragonhide_chaps', product: 1099, leather: 2, level: 60 },
            { recipe: 'leather:dragon_vambraces', product: 1065, leather: 1, level: 57 },
        ],
    },
    blue: {
        tier: 'blue',
        hide: tanningRecipes.blue.input,
        leather: tanningRecipes.blue.output,
        tanCost: tanningRecipes.blue.cost,
        pieces: [
            { recipe: 'leather:blue_dragonhide_body', product: 2499, leather: 3, level: 71 },
            { recipe: 'leather:blue_dragonhide_chaps', product: 2493, leather: 2, level: 68 },
            { recipe: 'leather:blue_dragon_vambraces', product: 2487, leather: 1, level: 66 },
        ],
    },
    red: {
        tier: 'red',
        hide: tanningRecipes.red.input,
        leather: tanningRecipes.red.output,
        tanCost: tanningRecipes.red.cost,
        pieces: [
            { recipe: 'leather:red_dragonhide_body', product: 2501, leather: 3, level: 77 },
            { recipe: 'leather:red_dragonhide_chaps', product: 2495, leather: 2, level: 75 },
            { recipe: 'leather:red_dragon_vambraces', product: 2489, leather: 1, level: 73 },
        ],
    },
    black: {
        tier: 'black',
        hide: tanningRecipes.black.input,
        leather: tanningRecipes.black.output,
        tanCost: tanningRecipes.black.cost,
        pieces: SET_PIECES,
    },
};

export type DhidePiece = 'body' | 'chaps' | 'vambraces';
const PIECE_INDEX: Readonly<Record<DhidePiece, 0 | 1 | 2>> = { body: 0, chaps: 1, vambraces: 2 };
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
    pieces: readonly DhideTierPiece[],
    want: number,
    hides: number,
    leather: number,
    thread: number,
    coins: number,
    needle = false,
    tanCost: number = TAN_COST,
): { count: number; tan: number; thread: number; coins: number } {
    if (![want, hides, leather, thread, coins].every(n => Number.isSafeInteger(n) && n >= 0)) return { count: 0, tan: 0, thread: 0, coins: 0 };
    const totalLeather = pieces.reduce((n, p) => n + p.leather, 0);
    let count = Math.floor((hides + leather) / totalLeather);
    if (want > 0) count = Math.min(count, want);
    const cost = (n: number) => {
        const tan = Math.max(0, n * totalLeather - leather);
        const buy = Math.max(0, Math.ceil((n * pieces.length) / THREAD_MAKES) + 1 - thread);
        return { count: n, tan, thread: buy, coins: tan * tanCost + (buy > 0 || needle ? SHOP_COINS : 0) };
    };
    while (count > 0 && cost(count).coins > coins) count--;
    return cost(count);
}

export function setPlan(want: number, hides: number, leather: number, thread: number, coins: number, needle = false): { sets: number; tan: number; thread: number; coins: number } {
    const r = planFor(SET_PIECES, want, hides, leather, thread, coins, needle);
    return { sets: r.count, tan: r.tan, thread: r.thread, coins: r.coins };
}

export function dhideSetPlan(
    tier: DhideTier,
    want: number,
    hides: number,
    leather: number,
    thread: number,
    coins: number,
    needle = false,
    piece?: DhidePiece,
): { sets: number; tan: number; thread: number; coins: number; spec: DhideTierSpec } {
    const spec = DHIDE_TIERS[tier];
    const pieces = piece ? [spec.pieces[PIECE_INDEX[piece]]] : spec.pieces;
    const r = planFor(pieces, want, hides, leather, thread, coins, needle, spec.tanCost);
    return { sets: r.count, tan: r.tan, thread: r.thread, coins: r.coins, spec };
}

export function piecePlan(piece: DhidePiece, want: number, hides: number, leather: number, thread: number, coins: number, needle = false): { count: number; tan: number; thread: number; coins: number } {
    return planFor([PIECE_BY_NAME[piece]], want, hides, leather, thread, coins, needle);
}

export async function runBlackDhideSetsSession(
    s: Session,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
    deps?: ArtisanExternalDeps,
    stop: () => boolean = () => false,
): Promise<{ ok: boolean; produced: number; ticks: number; summary: string; failure?: string }> {
    const start = s.tick();
    const argEnv = Object.fromEntries(
        restArgs.flatMap(a => {
            const m = a.match(/^([A-Z_]+)=(.*)$/);
            return m ? [[m[1]!, m[2]!]] : [];
        }),
    );
    const want = Number(argEnv.SETS ?? env.SETS ?? 0);
    const tierRaw = (argEnv.TIER ?? env.TIER ?? 'black').trim().toLowerCase() as DhideTier;
    const tierSpec = Object.hasOwn(DHIDE_TIERS, tierRaw) ? DHIDE_TIERS[tierRaw] : undefined;
    const pieceName = (argEnv.PIECE ?? env.PIECE)?.trim().toLowerCase() as DhidePiece | '' | undefined;
    const selected = !tierSpec
        ? null
        : pieceName
          ? pieceName in PIECE_INDEX
              ? [tierSpec.pieces[PIECE_INDEX[pieceName as DhidePiece]]]
              : null
          : [...tierSpec.pieces];
    try {
        if (!tierSpec) throw Error(`unknown TIER=${tierRaw}`);
        if (!selected) throw Error(`unknown PIECE=${pieceName}`);
        if (!Number.isSafeInteger(want) || want < 0 || want > 50) throw Error('SETS 0-50');
        const st = () => s.sdk.getState();
        const held = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        const banked = (id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        const level = s.sdk.getSkill('Crafting')?.level ?? 1;
        const reqLevel = Math.max(...selected.map(p => p.level));
        const leatherPer = selected.reduce((n, p) => n + p.leather, 0);
        if (level < reqLevel) throw Error(`Crafting ${level}, ${pieceName || 'a set'} asks ${reqLevel}`);
        const waitFor = (pred: () => boolean, timeoutTicks: number) => waitUntil(s, () => stop() || pred(), { timeoutTicks });
        const openBank = async (label: string) => {
            const generation = s.bankObservation?.()?.generation ?? 0;
            if (!(await s.bot.openBank()).success || !await waitFor(() => !!st()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, 20)) {
                throw Error(`${label}: bank did not open`);
            }
        };
        const closeBank = async () => {
            await s.bot.closeBank();
            await waitFor(() => !st()?.bank?.isOpen, 10);
        };
        const bankPack = async (label: string) => {
            for (const id of new Set(s.sdk.getInventory().map(i => i.id))) {
                const row = s.sdk.getInventory().find(i => i.id === id);
                if (row && (!(await s.bot.depositItem(row, held(id))).success || !await waitFor(() => held(id) === 0, 10))) {
                    throw Error(`${label}: deposit of item ${id}`);
                }
            }
        };
        const take = async (id: number, n: number) => {
            if (n < 1) return;
            const row = (st()?.bank?.items ?? []).find((i: { id: number }) => i.id === id);
            const before = held(id);
            if (!row || banked(id) < n) throw Error(`withdraw: ${n} of item ${id} short in the bank (${banked(id)} banked)`);
            if (!(await s.bot.withdrawItem(row, n, { asNote: false })).success || !await waitFor(() => held(id) >= before + n, 10)) {
                throw Error(`withdraw ${n} of item ${id}`);
            }
        };
        const go = async (to: { x: number; z: number; level: number }, label: string) => {
            if (stop()) throw Error('stopped');
            const out = deps?.walkTargetPersist
                ? await deps.walkTargetPersist(s, to)
                : await walkPath(await sessionWalker(s), [{ x: to.x, z: to.z, tol: 1 }], { stop });
            const reason = 'reason' in out && typeof out.reason === 'string' ? out.reason : '';
            if (!out.ok) throw Error(`route to ${label}: ${reason} ${out.detail ?? ''}`);
        };
        await go(AL_KHARID_BANK, 'the Al Kharid bank');
        await openBank('stage');
        await bankPack('stage');
        const needle = banked(NEEDLE) < 1;
        const plan = planFor(selected, want, banked(tierSpec.hide), banked(tierSpec.leather), banked(THREAD), banked(COINS), needle, tierSpec.tanCost);
        if (plan.count < 1) {
            await closeBank();
            throw Error(`no craft: ${banked(tierSpec.hide)} hides, ${banked(tierSpec.leather)} leather, ${banked(COINS)} coins, asks ${leatherPer} leather`);
        }
        let tanned = 0;
        let spent = 0;
        while (tanned < plan.tan) {
            if (stop()) throw Error('stopped');
            const n = Math.min(TAN_TRIP, plan.tan - tanned);
            await take(tierSpec.hide, n);
            await take(COINS, n * tierSpec.tanCost);
            await closeBank();
            await go(TANNER, 'the tanner');
            const r = await tanInventory(s, tierSpec.tier, n, 60 + n * 12, stop);
            tanned += r.made;
            spent += r.coinsSpent;
            if (!r.ok) throw Error(`tanning: ${r.detail} made=${r.made} of ${n}`);
            await go(AL_KHARID_BANK, 'the Al Kharid bank');
            await openBank('tanned');
            await bankPack('tanned');
        }
        if (needle || plan.thread > 0) {
            await take(COINS, Math.min(SHOP_COINS, banked(COINS)));
            await closeBank();
            await go(DOMMIK, "Dommik's store");
            const shop = await s.bot.openShop(/^dommik$/i);
            if (!shop.success) throw Error(`dommik shop: ${shop.message}`);
            const coins = held(COINS);
            if (needle) {
                await s.bot.buyFromShop(/^needle$/i, 1);
                await waitFor(() => held(NEEDLE) > 0, 6);
            }
            if (plan.thread > 0) {
                await s.bot.buyFromShop(/^thread$/i, plan.thread);
                await waitFor(() => held(THREAD) >= plan.thread, 6);
            }
            await s.bot.closeShop();
            spent += coins - held(COINS);
            if ((needle && held(NEEDLE) < 1) || held(THREAD) < plan.thread) {
                throw Error(`dommik: needle=${held(NEEDLE)} thread=${held(THREAD)} of ${plan.thread}`);
            }
            await go(AL_KHARID_BANK, 'the Al Kharid bank');
            await openBank('shop');
            await bankPack('shop');
        }
        await closeBank();
        const made: number[] = [];
        for (const piece of selected) {
            const recipe = inventoryRecipes().find(r => r.name === piece.recipe);
            if (!recipe) throw Error(`no recipe ${piece.recipe}`);
            const r = await runInventoryBank(s, recipe, { maximum: plan.count, cap: 100 + plan.count * 40, maxAttempts: plan.count, members: true, stop });
            made.push(r.made);
            if (!r.ok) throw Error(`craft ${piece.recipe}: ${r.failure} made=${r.made} of ${plan.count}`);
        }
        await openBank('end');
        await bankPack('end');
        const sets = Math.min(...selected.map(p => banked(p.product)));
        const hidesLeft = banked(tierSpec.hide);
        const leatherLeft = banked(tierSpec.leather);
        await closeBank();
        const ok = made.every(n => n === plan.count);
        const detail = selected.map((p, idx) => `${p.recipe.endsWith('body') ? 'bodies' : p.recipe.endsWith('chaps') ? 'chaps' : 'vambraces'}=${made[idx]}`).join(' ');
        const summary = `sets=${plan.count} banked=${sets} ${detail} tanned=${tanned} spent=${spent} hidesLeft=${hidesLeft} leatherLeft=${leatherLeft} crafting=${s.sdk.getSkill('Crafting')?.level ?? 0} ticks=${s.tick() - start}`;
        return { ok, produced: plan.count, ticks: s.tick() - start, summary, failure: ok ? undefined : summary };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, produced: 0, ticks: s.tick() - start, summary: msg, failure: msg };
    }
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
    const tierRaw = (argEnv.TIER ?? env.TIER ?? 'black').trim().toLowerCase() as DhideTier;
    const tierSpec = Object.hasOwn(DHIDE_TIERS, tierRaw) ? DHIDE_TIERS[tierRaw] : undefined;
    const pieceName = (argEnv.PIECE ?? env.PIECE)?.trim().toLowerCase() as DhidePiece | '' | undefined;
    const selected = !tierSpec
        ? null
        : pieceName
          ? pieceName in PIECE_INDEX
              ? [tierSpec.pieces[PIECE_INDEX[pieceName as DhidePiece]]]
              : null
          : [...tierSpec.pieces];
    const q = await deps.openQuest({ name: botName, cap: 4000, eatAt: 50, lumbridgeOk: true });
    try {
        if (!tierSpec) await q.fail(`unknown TIER=${tierRaw}`);
        if (!selected) await q.fail(`unknown PIECE=${pieceName}`);
        if (!Number.isSafeInteger(want) || want < 0 || want > 50) await q.fail('SETS 0-50');
        const activeTier = tierSpec!;
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
        const needle = banked(NEEDLE) < 1;
        const plan = planFor(selected!, want, banked(activeTier.hide), banked(activeTier.leather), banked(THREAD), banked(COINS), needle, activeTier.tanCost);
        if (plan.count < 1) {
            await closeBank();
            await q.fail(`no craft: ${banked(activeTier.hide)} hides, ${banked(activeTier.leather)} leather, ${banked(COINS)} coins, asks ${leatherPer} leather`);
        }
        q.milestone(`plan ${activeTier.tier} ${pieceName || 'sets'}=${plan.count} tan=${plan.tan} thread=${plan.thread}`);
        let tanned = 0;
        let spent = 0;
        while (tanned < plan.tan) {
            const n = Math.min(TAN_TRIP, plan.tan - tanned);
            await take(activeTier.hide, n);
            await take(COINS, n * activeTier.tanCost);
            await closeBank();
            await go(TANNER, 'the tanner');
            const r = await tanInventory(s, activeTier.tier, n, 60 + n * 12);
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
        const hidesLeft = banked(activeTier.hide);
        const leatherLeft = banked(activeTier.leather);
        await closeBank();
        const detail = selected!.map((p, idx) => `${p.recipe.endsWith('body') ? 'bodies' : p.recipe.endsWith('chaps') ? 'chaps' : 'vambraces'}=${made[idx]}`).join(' ');
        await q.end(
            made.every(n => n === plan.count),
            `tier=${activeTier.tier} sets=${plan.count} banked=${sets} ${detail} tanned=${tanned} spent=${spent} hidesLeft=${hidesLeft} leatherLeft=${leatherLeft} crafting=${s.sdk.getSkill('Crafting')?.level ?? 0} ticks=${s.tick() - start}`,
        );
    } catch (e) {
        await q.fail(String(e));
    }
}
