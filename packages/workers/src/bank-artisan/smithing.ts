// Unified smithing worker combining smelt-batch, smelt-bars, smith-batch, and cannonballs.
// Usage: BAR_TYPE: iron | bronze | steel | gold | mithril | silver | adamantite | runite
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountOf, finish, getWorld, openBot } from '../../../core/src/bot';
import { equipmentObserved } from '../../../core/src/container-observation';
import { depositObserved } from '../../../core/src/deposit';
import { questFlags } from '../../../core/src/quest-status';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { knownBanks } from '../../../core/src/trip';
import { goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import { parseConfigs } from '../../../knowledge/src/config';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import { CONTENT_DIR, productionBatch, SMITH_ANVIL, SMITH_BANK, smeltEntryRoute, smithStageRoute } from './catalog';
import { actionSessionOwner, finishActionSession, productionStopRequested } from './runtime';
import type { Session } from './types';

type Stock = readonly { id: number; count: number }[];
const count = (rows: Stock, id: number) => rows.filter(v => v.id === id).reduce((n, v) => n + v.count, 0);

// ---- Smelt Batch & Native Smelting (smelt-batch.ts) ----

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

export type SmeltBonusGear =
    | { kind: 'goldsmith'; xpRate: number }
    | { kind: 'forging'; xpRate: number; maximumRings: number; ringReserve: number };

type SmeltTile = { x: number; z: number; level: number };

export type SmeltLocalRoute = {
    bank: SmeltTile;
    stand: SmeltTile;
    furnace: SmeltTile & { id: number };
    access?: 'shilo-furnace';
    maxEntries?: number;
    coinReserve?: number;
};

export type SmeltOrder = {
    bar: string;
    cap: number;
    maximum: number;
    reserve: number;
    mode: 'exact' | 'best-effort';
    stop?: () => boolean;
    bonusGear?: SmeltBonusGear;
    route?: SmeltLocalRoute;
    nearest?: boolean;
    xpRate?: number;
};

const furnaceCache = new Map<number, { name: string; fremennik: boolean; width: number; length: number }>();

export function nativeSmeltFurnace(id: number) {
    const cached = furnaceCache.get(id);
    if (cached) return cached;
    const name = readFileSync(join(CONTENT_DIR, 'pack/loc.pack'), 'utf8')
        .split(/\r?\n/)
        .find(l => l.startsWith(id + '='))
        ?.split('=')[1];
    if (!name || !['furnace1', 'viking_furnace', 'viking_furnace2'].includes(name)) {
        throw Error('declared furnace lacks the ordinary Native Smelt contract');
    }
    const file = name.startsWith('viking_')
        ? 'scripts/quests/quest_viking/configs/viking.loc'
        : 'scripts/skill_smithing/configs/smelting/smelting.loc';
    const block = parseConfigs(readFileSync(join(CONTENT_DIR, file), 'utf8'), file).find(b => b.name === name);
    if (block?.props.category?.[0] !== 'smithing_furnace' || block.props.op2?.[0] !== 'Smelt') {
        throw Error('ordinary Native furnace metadata changed');
    }
    if (block.props.forceapproach?.[0] !== 'east') {
        throw Error('ordinary Native furnace approach metadata changed');
    }
    const value = {
        name,
        fremennik: name.startsWith('viking_'),
        width: Number(block.props.width?.[0] ?? 1),
        length: Number(block.props.length?.[0] ?? 1),
    };
    furnaceCache.set(id, value);
    return value;
}

export function nativeSmeltStands(f: SmeltTile & { id: number }) {
    const type = nativeSmeltFurnace(f.id);
    const map = join(CONTENT_DIR, `maps/m${f.x >> 6}_${f.z >> 6}.jm2`);
    const placement = readFileSync(map, 'utf8').match(new RegExp(`^${f.level} ${f.x & 63} ${f.z & 63}: ${f.id} 10(?: ([0-3]))?\\r?$`, 'm'));
    if (!placement) throw Error('declared ordinary furnace Native placement absent');
    const angle = Number(placement[1] ?? 0);
    const width = angle % 2 ? type.length : type.width;
    const length = angle % 2 ? type.width : type.length;
    const side = (1 + angle) % 4;
    return Array.from({ length: side % 2 ? length : width }, (_, i) => ({
        level: f.level,
        x: side === 1 ? f.x + width : side === 3 ? f.x - 1 : f.x + i,
        z: side === 0 ? f.z + length : side === 2 ? f.z - 1 : f.z + i,
    }));
}

export function validateSmeltRoute(route: SmeltLocalRoute) {
    const point = (p: SmeltTile) =>
        !!p &&
        [p.x, p.z, p.level].every(Number.isSafeInteger) &&
        p.x >= 0 &&
        p.x <= 16383 &&
        p.z >= 0 &&
        p.z <= 16383 &&
        p.level >= 0 &&
        p.level <= 3;
    if (
        !route ||
        !point(route.bank) ||
        !point(route.stand) ||
        !point(route.furnace) ||
        !Number.isSafeInteger(route.furnace.id) ||
        route.bank.level !== route.stand.level ||
        route.stand.level !== route.furnace.level ||
        Math.max(Math.abs(route.bank.x - route.stand.x), Math.abs(route.bank.z - route.stand.z)) > 160 ||
        Math.max(Math.abs(route.furnace.x - route.stand.x), Math.abs(route.furnace.z - route.stand.z)) > 4
    ) {
        throw Error('invalid finite local furnace/bank/stand route');
    }
    const f = route.furnace;
    if (!nativeSmeltStands(f).some(p => p.x === route.stand.x && p.z === route.stand.z)) {
        throw Error('declared stand differs from Native rotated furnace approach');
    }
    const shilo = f.id === 2781 && f.x === 2856 && f.z === 2966 && f.level === 0;
    if (shilo || route.access !== undefined || route.maxEntries !== undefined || route.coinReserve !== undefined) {
        if (
            !shilo ||
            route.access !== 'shilo-furnace' ||
            route.bank.x !== 2852 ||
            route.bank.z !== 2955 ||
            !Number.isSafeInteger(route.maxEntries) ||
            route.maxEntries! < 1 ||
            route.maxEntries! > 100 ||
            !Number.isSafeInteger(route.coinReserve) ||
            route.coinReserve! < 0
        ) {
            throw Error('Shilo furnace requires explicit finite entry and coin reserve policy');
        }
    }
    return route;
}

const smeltRecipeCache = new Map<string, SmeltRecipe>();
export const SMELT_BAR_TYPES = ['bronze', 'iron', 'silver', 'steel', 'gold', 'mithril', 'adamantite', 'runite'] as const;

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
    const file = 'scripts/skill_smithing/configs/smelting/smelting.struct';
    const ids = new Map(
        readFileSync(join(CONTENT_DIR, 'pack/obj.pack'), 'utf8')
            .split(/\r?\n/)
            .flatMap(l => {
                const m = l.match(/^(\d+)=(.+)$/);
                return m ? ([[m[2]!, Number(m[1])] as const]) : [];
            }),
    );
    const b = parseConfigs(readFileSync(join(CONTENT_DIR, file), 'utf8'), file).find(b => b.name === 'smelting_' + bar + '_bar');
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

export function planSmeltLoad(r: SmeltRecipe, bank: Stock, freeSlots: number, maximum: number, reserved: Readonly<Record<number, number>>) {
    return productionBatch(
        r.ingredients.map(i => ({ ...i, available: count(bank, i.id), reserved: reserved[i.id] ?? 0, stackable: false })),
        freeSlots,
        maximum,
        'best-effort',
    );
}

export function smeltEffect(r: SmeltRecipe, before: Stock, after: Stock, xpBefore: number, xpAfter: number): { kind: 'none' | 'made' | 'loss'; made: number } {
    const debits = r.ingredients.map(i => count(before, i.id) - count(after, i.id));
    const made = count(after, r.product) - count(before, r.product);
    if (made === 0 && debits.every(v => v === 0) && xpAfter === xpBefore) return { kind: 'none', made: 0 };
    if (!debits.every((v, n) => v === r.ingredients[n]!.units)) throw Error('smelt ingredient debit mismatch');
    if (made === (r.productUnits ?? 1) && xpAfter > xpBefore) return { kind: 'made', made: 1 };
    if (r.iron && made === 0 && xpAfter === xpBefore) return { kind: 'loss', made: 0 };
    throw Error('smelt output/XP mismatch');
}

const bonusXpCache = new Map<string, number>();

export function smeltBonusRawXp(b: SmeltBonusGear) {
    let base = bonusXpCache.get(b.kind);
    if (base === undefined) {
        const file = join(CONTENT_DIR, 'scripts/skill_smithing/configs/smelting/smelting.struct');
        const block = parseConfigs(readFileSync(file, 'utf8'), file).find(i => i.name === `smelting_${b.kind === 'goldsmith' ? 'gold' : 'iron'}_bar`);
        base = Number(block?.props.param?.find(i => i.startsWith('productexp,'))?.split(',')[1]);
        if (!Number.isSafeInteger(base) || base <= 0) throw Error('native smelt XP missing');
        bonusXpCache.set(b.kind, base);
    }
    return (b.kind === 'goldsmith' ? Math.floor((base * 5) / 2) : base) * b.xpRate;
}

export function validateSmeltOrder(o: SmeltOrder) {
    if (![o.cap, o.maximum, o.reserve].every(Number.isSafeInteger) || o.cap < 1 || o.maximum < 1 || o.reserve < 0 || !['exact', 'best-effort'].includes(o.mode)) {
        throw Error('invalid finite smelt order');
    }
    if (o.route) validateSmeltRoute(o.route);
    if ((o.nearest !== undefined && typeof o.nearest !== 'boolean') || (o.nearest && o.route)) {
        throw Error('nearest and explicit smelt routes are mutually exclusive');
    }
    if (o.bar === 'cannonballs' && (!Number.isSafeInteger(o.xpRate) || o.xpRate! < 1 || o.xpRate! > 1000 || o.maximum > 100000 || o.cap > 10000)) {
        throw Error('cannonballs require finite operations and explicit XP rate');
    }
    const b = o.bonusGear;
    if (b) {
        if (!Number.isSafeInteger(b.xpRate) || b.xpRate < 1 || b.xpRate > 1000 || !((b.kind === 'goldsmith' && o.bar === 'gold') || (b.kind === 'forging' && o.bar === 'iron'))) {
            throw Error('invalid native smelt bonus policy');
        }
        if (b.kind === 'forging' && (![b.maximumRings, b.ringReserve].every(Number.isSafeInteger) || b.maximumRings < 1 || b.maximumRings > 100 || b.ringReserve < 0)) {
            throw Error('invalid finite forging ring budget');
        }
        smeltBonusRawXp(b);
    }
    return smeltRecipe(o.bar);
}

export function smeltOwnedSession(raw: Session, stop: () => boolean = () => false, inputGuard: () => void = () => {}) {
    const client = raw.client as { executeBotAction?: unknown; selfSlot?: number } | undefined;
    const executor = client?.executeBotAction;
    const sdk = raw.sdk;
    const config = sdk.config;
    const origin = JSON.stringify([config?.gatewayUrl, config?.host, config?.port]);
    const p = sdk.getState()?.player;
    const life = p?.lifeId;
    const respawns = p?.respawnCount ?? 0;
    const self = client?.selfSlot;
    let ended = false;
    let cleaning = false;
    void raw.ended.then(() => { ended = true; });
    const own = () => {
        const now = sdk.getState()?.player;
        return (
            !ended &&
            !!p &&
            Number.isSafeInteger(life) &&
            Number.isSafeInteger(self) &&
            !!client &&
            typeof executor === 'function' &&
            raw.client === client &&
            client.executeBotAction === executor &&
            client.selfSlot === self &&
            raw.sdk === sdk &&
            sdk.config === config &&
            JSON.stringify([config?.gatewayUrl, config?.host, config?.port]) === origin &&
            !!now &&
            !now.isDead &&
            now.lifeId === life &&
            (now.respawnCount ?? 0) === respawns
        );
    };
    const stopped = () => !own() || productionStopRequested(raw.name, stop) || productionStopRequested('smelt-bars', () => false);
    const guard = () => {
        if (!own() || (!cleaning && stopped())) throw Error('smelt original session/input owner/life/stop unavailable');
        inputGuard();
    };
    const proxy = new Proxy(sdk, {
        get(target, key, receiver) {
            const v = Reflect.get(target, key, receiver);
            return typeof v === 'function'
                ? function (...args: unknown[]) {
                      if (String(key).startsWith('send')) guard();
                      return v.apply(receiver, args);
                  }
                : v;
        },
    });
    const s = Object.create(raw) as Session;
    const bot =
        raw.bot instanceof BotActions
            ? new BotActions(proxy)
            : new Proxy(raw.bot, {
                  get(target, key, receiver) {
                      const v: unknown = Reflect.get(target as object, key, receiver);
                      return typeof v === 'function'
                          ? function (...args: unknown[]) {
                                guard();
                                return v.apply(receiver, args);
                            }
                          : v;
                  },
              });
    Object.defineProperties(s, {
        sdk: { value: proxy },
        bot: { value: bot },
        direct: {
            value: (a: Parameters<Session['direct']>[0]) => {
                guard();
                return raw.direct(a);
            },
        },
    });
    return {
        session: s,
        own,
        stopped,
        cleanup: () => {
            if (!own()) return false;
            cleaning = true;
            return true;
        },
    };
}

export async function deriveNearestSmeltRoute(
    raw: Session,
    cap: number,
    stop: () => boolean = () => false,
    io?: { banks?: readonly SmeltTile[]; walker?: () => Promise<Pick<Awaited<ReturnType<typeof sessionWalker>>, 'plan'>> },
): Promise<SmeltLocalRoute> {
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('nearest furnace finite cap required');
    const owner = smeltOwnedSession(raw, stop);
    const s = owner.session;
    const start = s.tick();
    const p = s.sdk.getState()?.player;
    if (!p) throw Error('nearest furnace player unavailable');
    const from = { x: p.worldX, z: p.worldZ, level: p.level };
    const hp = s.sdk.getSkill('Hitpoints')?.level;
    const fingerprint = () => JSON.stringify([s.sdk.getInventory(), s.sdk.getEquipment(), s.sdk.getState()?.skills]);
    const before = fingerprint();
    const check = () => {
        const now = s.sdk.getState()?.player;
        const age = s.sdk.getStateAge();
        if (
            owner.stopped() ||
            !now ||
            now.worldX !== from.x ||
            now.worldZ !== from.z ||
            now.level !== from.level ||
            !Number.isFinite(hp) ||
            hp! < 7 ||
            s.sdk.getSkill('Hitpoints')?.level !== hp ||
            !Number.isFinite(age) ||
            age < 0 ||
            age > 5000 ||
            s.tick() - start >= cap ||
            fingerprint() !== before
        ) {
            throw Error('nearest furnace original observation changed');
        }
    };
    check();
    const walker = await (io?.walker ? io.walker() : sessionWalker(s));
    check();
    const distance = (a: SmeltTile, b: SmeltTile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
    const candidates = (s.sdk.getState()?.nearbyLocs ?? [])
        .filter(l => l.level === from.level && distance(l, from) <= 20 && l.optionsWithIndex.some(o => o.opIndex === 2 && /^smelt$/i.test(o.text)))
        .map(l => ({ id: l.id, x: l.x, z: l.z, level: l.level }))
        .sort((a, b) => distance(a, from) - distance(b, from) || a.id - b.id || a.x - b.x || a.z - b.z);
    const complete = (a: SmeltTile, b: SmeltTile) => {
        check();
        try {
            const path = walker.plan(a.level, a, b);
            const end = path.at(-1) ?? a;
            check();
            return end.x === b.x && end.z === b.z && path.every(t => Number.isFinite(t.x) && Number.isFinite(t.z) && distance(t as SmeltTile, a) <= 160);
        } catch {
            check();
            return false;
        }
    };
    for (const f of candidates) {
        check();
        if (f.id === 2781 && f.x === 2856 && f.z === 2966) continue;
        let stands: SmeltTile[];
        try {
            const type = nativeSmeltFurnace(f.id);
            if (type.fremennik && ((s.client as { membersAccount?: number }).membersAccount !== 1 || !questFlags(s.client)?.some(q => /^(The )?Fremennik Trials$/.test(q.name) && q.state === 'complete'))) {
                continue;
            }
            stands = nativeSmeltStands(f);
        } catch {
            continue;
        }
        const banks = [...(io?.banks ?? knownBanks())]
            .filter(b => b.level === from.level && distance(b, f) <= 160)
            .sort((a, b) => distance(a, f) - distance(b, f) || a.x - b.x || a.z - b.z);
        stands.sort((a, b) => distance(a, from) - distance(b, from) || a.x - b.x || a.z - b.z);
        for (const bank of banks) {
            if (!complete(from, bank)) continue;
            for (const stand of stands) {
                if (complete(bank, stand) && complete(stand, bank)) {
                    check();
                    return structuredClone(validateSmeltRoute({ bank: { ...bank }, stand: { ...stand }, furnace: { ...f } }));
                }
            }
        }
    }
    throw Error('no observed ordinary furnace with complete indexed-bank route within20');
}

export async function runSmeltBatch(
    raw: Session,
    o: SmeltOrder,
    io?: { walk: (x: number, z: number) => Promise<boolean>; recover?: (x: number, z: number) => Promise<boolean>; nearest?: Parameters<typeof deriveNearestSmeltRoute>[3] },
) {
    let bonusInputGuard = () => {};
    const owner = smeltOwnedSession(raw, o.stop, () => bonusInputGuard());
    const s = owner.session;
    const nearestStart = o.nearest ? s.tick() : undefined;
    const r = validateSmeltOrder(o);
    const state = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const held = (id: number) => count(inv(), id);
    const xp = () => s.sdk.getSkillXp('Smithing') ?? 0;
    const cannon = o.bar === 'cannonballs';
    const productUnits = r.productUnits ?? 1;
    const cannonAdmission = () => {
        if (cannon && ((s.client as { membersAccount?: number }).membersAccount !== 1 || (s.sdk.getSkill('Smithing')?.level ?? 0) < 35)) {
            throw Error('cannonballs need observed member and current Smithing35');
        }
    };
    cannonAdmission();
    const route = o.nearest ? await deriveNearestSmeltRoute(raw, o.cap, o.stop, io?.nearest) : o.route ? structuredClone(o.route) : undefined;
    if (o.nearest && owner.stopped()) throw Error('nearest furnace original owner lost');
    const bankSite = route?.bank ?? { x: 3269, z: 3167, level: 0 };
    const furnaceStand = route?.stand ?? { x: 3274, z: 3186, level: 0 };
    const shilo = route?.access === 'shilo-furnace';
    const localAdmission = () => {
        if (
            route &&
            nativeSmeltFurnace(route.furnace.id).fremennik &&
            ((s.client as { membersAccount?: number }).membersAccount !== 1 || !questFlags(s.client)?.some(q => /^(The )?Fremennik Trials$/.test(q.name) && q.state === 'complete'))
        ) {
            throw Error('local furnace requires observed completed Fremennik Trials');
        }
        if (shilo && ((s.client as { membersAccount?: number }).membersAccount !== 1 || !questFlags(s.client)?.some(q => q.name === 'Shilo Village' && q.state === 'complete'))) {
            throw Error('Shilo furnace requires observed member and completed Shilo Village');
        }
    };
    const bonus = o.bonusGear ? { ...o.bonusGear } : undefined;
    const bonusId = bonus?.kind === 'goldsmith' ? 776 : 2568;
    const bonusSlot = bonus?.kind === 'goldsmith' ? 9 : 12;
    const wear = () =>
        s.sdk
            .getEquipment()
            .map(i => ({ id: i.id, count: i.count, slot: i.slot }))
            .sort((a, b) => a.slot - b.slot);
    const originalWear = bonus || cannon ? wear() : [];
    const originalBonusSlot = originalWear.find(i => i.slot === bonusSlot);
    const sameWear = (a: ReturnType<typeof wear>, b: ReturnType<typeof wear>) => JSON.stringify(a) === JSON.stringify(b);
    if ((bonus || cannon) && ((s.client as { membersAccount?: number }).membersAccount !== 1 || !equipmentObserved(s.client as object))) {
        throw Error('smelt optional recipe needs observed member equipment');
    }
    const ready = await waitUntil(s, () => owner.stopped() || (!!state()?.player && (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0 && (s.sdk.getSkill('Smithing')?.baseLevel ?? 0) >= r.level), {
        timeoutTicks: 15,
    });
    if (!ready || owner.stopped()) throw Error('smelt entry level/state unobserved');
    localAdmission();
    const at = state()!.player!;
    const atBank = (x: number, z: number) => at.level === 0 && Math.max(Math.abs(at.worldX - x), Math.abs(at.worldZ - z)) <= 5;
    if (
        route &&
        !o.nearest &&
        (at.level !== bankSite.level ||
            Math.min(Math.max(Math.abs(at.worldX - bankSite.x), Math.abs(at.worldZ - bankSite.z)), Math.max(Math.abs(at.worldX - furnaceStand.x), Math.abs(at.worldZ - furnaceStand.z))) > 3)
    ) {
        throw Error('local smelt starts at its declared bank or furnace stand');
    }
    if (shilo && Math.max(Math.abs(at.worldX - bankSite.x), Math.abs(at.worldZ - bankSite.z)) > 3) {
        throw Error('Shilo access starts at its declared village bank');
    }
    if (!route && !io && !atBank(3269, 3167) && !atBank(3253, 3420)) {
        const there = await goTo(s, await getWorld(), { x: 3269, z: 3167, level: 0 }, accountOf(s), { legTimeoutTicks: 100 });
        if (!there.ok) throw Error(`smelt travel to Al Kharid bank failed: ${there.detail}`);
    }
    const p0 = { ...state()!.player! };
    const start = nearestStart ?? s.tick();
    const xp0 = xp();
    const entryBank = { x: p0.worldX, z: p0.worldZ };
    const entry = route ? { name: 'declared-local-furnace', fare: 0, points: [] } : smeltEntryRoute(p0);
    if (r.iron && held(453) >= 2 && (s.sdk.getSkill('Smithing')?.baseLevel ?? 0) >= 30) {
        throw Error('iron entry requires coal banked before recipe dispatch');
    }
    const material = new Set([...r.ingredients.map(i => i.id), r.product]);
    const kit = new Map<number, number>();
    for (const i of inv()) if (!material.has(i.id)) kit.set(i.id, (kit.get(i.id) ?? 0) + i.count);
    let ended = false;
    let died = false;
    let hpMin = s.sdk.getSkill('Hitpoints')!.level;
    let made = 0;
    let consumedOre = 0;
    let losses = 0;
    let attempts = 0;
    let misses = 0;
    let failure = '';
    let stop = 'cap';
    let ringBreaks = 0;
    let ringsUsed = 0;
    let bonusRawXp = 0;
    let uncertainBonus = false;
    let gearRestored = !bonus;
    let cannonRawXp = 0;
    const cannonReceipts: { tick: number; terminal: number; rawXp: number; products: number }[] = [];
    let localPaid = false;
    let bonusDeadline = start + o.cap;
    const declaredFurnace = () =>
        route
            ? state()?.nearbyLocs.find(
                  l =>
                      l.id === route.furnace.id &&
                      l.x === route.furnace.x &&
                      l.z === route.furnace.z &&
                      l.level === route.furnace.level &&
                      l.reachable !== false &&
                      l.optionsWithIndex.some(op => op.opIndex === 2 && /^smelt$/i.test(op.text)),
              )
            : undefined;
    if (bonus || route || cannon) {
        bonusInputGuard = () => {
            const age = s.sdk.getStateAge();
            if ((bonus || cannon) && !equipmentObserved(s.client as object)) throw Error('smelt optional input health/freshness/deadline');
            if (!Number.isFinite(age) || age < 0 || age > 5000 || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < 7 || s.tick() >= bonusDeadline) {
                throw Error('smelt optional input health/freshness/deadline');
            }
            if (localPaid) {
                localAdmission();
                cannonAdmission();
                if (cannon && (!held(4) || !sameWear(wear(), originalWear))) throw Error('cannonball mould/gear changed before input');
                const p = state()?.player;
                if (route && (!declaredFurnace() || p?.level !== furnaceStand.level || p.worldX !== furnaceStand.x || p.worldZ !== furnaceStand.z)) {
                    throw Error('local smelt changed at paid dispatch');
                }
            }
        };
    }
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => {
        const p = state()?.player;
        hpMin = Math.min(hpMin, s.sdk.getSkill('Hitpoints')?.level ?? hpMin);
        died ||= !owner.own() || hpMin <= 0 || (!!p && (p.isDead || (p.respawnCount ?? 0) > (p0.respawnCount ?? 0) || (p0.lifeId !== undefined && p.lifeId !== p0.lifeId)));
    });
    const over = () => owner.stopped() || ended || died || hpMin < 7 || !!o.stop?.() || s.tick() - start >= o.cap;
    const near = (x: number, z: number, tol = 3) => {
        const p = state()?.player;
        return !!p && p.level === bankSite.level && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };
    let travel = false;
    let travelTicks = 0;
    let coinsSpent = 0;
    let arrival = false;
    let crossed = false;
    let shiloInside = false;
    let shiloEntries = 0;
    const accessReceipts: { kind: 'entry' | 'exit'; tick: number; coins: number }[] = [];
    const passed: { x: number; z: number }[] = [];
    const recover = async (x: number, z: number, cleanup = false) => {
        if (!owner.own() || ended || died || hpMin < 7 || (!cleanup && over())) return false;
        if (io) return !!io.recover && (await io.recover(x, z)) && near(x, z);
        const ac = new AbortController();
        const began = s.tick();
        const budget = cleanup ? 160 : Math.min(160, Math.max(1, o.cap - (s.tick() - start)));
        const stopRec = s.onTick(() => {
            if (ended || died || hpMin < 7 || s.tick() - began >= budget || (!cleanup && over())) ac.abort('smelt recovery deadline/stop');
        });
        try {
            const res = await goTo(s, await getWorld(), { x, z, level: 0 }, accountOf(s), { maxRetriesPerLeg: 1, legTimeoutTicks: budget, signal: ac.signal });
            return res.ok && near(x, z);
        } finally {
            stopRec();
        }
    };
    const walk = async (x: number, z: number, cleanup = false) => {
        if (!owner.own() || (!cleanup && over())) return false;
        if (io) return (await io.walk(x, z)) && near(x, z, route ? 0 : 3);
        const walker = await sessionWalker(s);
        const plan = walker.plan;
        const tol = route ? 0 : 1;
        const inside = (t: { x: number; z: number }) => Math.max(Math.abs(t.x - x), Math.abs(t.z - z)) <= tol;
        walker.plan = (level, from, to) => {
            const path = plan(level, from, to);
            if (!inside(path.at(-1) ?? from)) throw Error('smelt incomplete corridor plan');
            return path;
        };
        const result = await walkPath(walker, [{ x, z, tol }], {
            maxTicks: Math.min(160, cleanup ? 160 : Math.max(1, o.cap - (s.tick() - start))),
            stop: () => !owner.own() || ended || died || hpMin < 7 || (!cleanup && (over() || (travel && (s.sdk.getSkill('Hitpoints')?.level ?? 0) < hpStart))),
        });
        return result.ok && near(x, z);
    };
    let lastBank: Stock | undefined;
    const bankRows = () => {
        const observed = s.bankObservation?.();
        if (observed) lastBank = observed.items.map(i => ({ id: i.id, count: i.count }));
        return lastBank ?? [];
    };
    const totals = () => {
        const rows = [...inv(), ...s.sdk.getEquipment(), ...bankRows()];
        const m = new Map<number, number>();
        for (const i of rows) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        return m;
    };
    let initial: Map<number, number> | undefined;
    const hpStart = hpMin;
    const observeBank = async () => {
        const generation = s.bankObservation?.()?.generation ?? -1;
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!state()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation, { timeoutTicks: 10 })) {
            throw Error('smelt bank observation unready');
        }
    };
    const reserved = Object.fromEntries(r.ingredients.map(i => [i.id, o.reserve]));
    const packSame = (a: Stock, b: Stock) => {
        const ids = new Set([...a, ...b].map(i => i.id));
        return [...ids].every(id => count(a, id) === count(b, id));
    };
    const accessGuard = () => {
        const age = s.sdk.getStateAge();
        if (!owner.own() || ended || died || hpMin < 7 || s.tick() >= bonusDeadline || !Number.isFinite(age) || age < 0 || age > 5000) {
            throw Error('Shilo access original owner/health/deadline lost');
        }
        localAdmission();
    };
    const accessState = () => ({
        pack: inv().map(i => ({ ...i })),
        gear: wear(),
        xp: JSON.stringify((state()?.skills ?? []).map(k => [k.name, k.experience])),
        hp: s.sdk.getSkill('Hitpoints')?.level,
    });
    const accessSame = (before: ReturnType<typeof accessState>, fee: number) => {
        const expected = before.pack.map(i => ({ ...i }));
        let left = fee;
        for (const row of expected) {
            if (row.id === 995) {
                const n = Math.min(left, row.count);
                row.count -= n;
                left -= n;
            }
        }
        return (
            left === 0 &&
            packSame(inv(), expected) &&
            sameWear(wear(), before.gear) &&
            JSON.stringify((state()?.skills ?? []).map(k => [k.name, k.experience])) === before.xp &&
            s.sdk.getSkill('Hitpoints')?.level === before.hp
        );
    };
    const shiloDoor = () => state()?.nearbyLocs.find(l => l.id === 2266 && l.x === 2856 && l.z === 2963 && l.level === 0 && l.optionsWithIndex.some(o => o.opIndex === 1 && /^open$/i.test(o.text)));
    const leaveShilo = async (cleanup: boolean) => {
        if (!shiloInside) return;
        if (!await walk(2856, 2964, cleanup)) throw Error('Shilo inside door approach incomplete');
        const until = Math.min(bonusDeadline, s.tick() + 8);
        while (!shiloDoor() && s.tick() < until) {
            accessGuard();
            await waitTicks(s, 1);
        }
        accessGuard();
        if (!shiloDoor() || !near(2856, 2964, 0)) throw Error('Shilo restored inside door unobserved');
        const before = accessState();
        uncertainBonus = true;
        try {
            await s.direct({ type: 'interactLoc', locId: 2266, x: 2856, z: 2963, optionIndex: 1, reason: 'SDK' });
        } catch {}
        while (s.tick() < until) {
            accessGuard();
            if (!accessSame(before, 0)) throw Error('Shilo free exit assets changed');
            if (near(2856, 2963, 0)) {
                shiloInside = false;
                uncertainBonus = false;
                accessReceipts.push({ kind: 'exit', tick: s.tick(), coins: 0 });
                return;
            }
            await waitTicks(s, 1);
        }
        throw Error('Shilo free exit unknown');
    };
    const enterShilo = async () => {
        if (shiloEntries >= route!.maxEntries!) throw Error('Shilo entry budget exhausted');
        if (!await walk(2856, 2962)) throw Error('Shilo outer door approach incomplete');
        accessGuard();
        if (!shiloDoor() || !near(2856, 2962, 0) || held(995) < 20) throw Error('Shilo door or owned fare unavailable');
        const before = accessState();
        const cursor = Math.max(-1, ...(state()?.recentDialogs ?? []).map(d => d.observationId ?? d.tick));
        const pages = new Set<string>();
        const until = Math.min(bonusDeadline, s.tick() + 60);
        let selected = false;
        let terminal = false;
        uncertainBonus = true;
        await s.direct({ type: 'interactLoc', locId: 2266, x: 2856, z: 2963, optionIndex: 1, reason: 'SDK' });
        while (s.tick() < until) {
            accessGuard();
            const d = s.sdk.getDialog();
            const fresh = (state()?.recentDialogs ?? [])
                .filter(v => (v.observationId ?? v.tick) > cursor)
                .flatMap(v => v.text)
                .join(' ');
            if (selected) {
                if (!accessSame(before, 0) && !accessSame(before, 20)) throw Error('Shilo paid entry mixed assets');
                if (/Thanks Bwana! Enjoy the facilities!/i.test(fresh) && accessSame(before, 20)) terminal = true;
                if (terminal && near(2856, 2964, 0) && !d?.isOpen) {
                    shiloInside = true;
                    shiloEntries++;
                    coinsSpent += 20;
                    uncertainBonus = false;
                    accessReceipts.push({ kind: 'entry', tick: s.tick(), coins: 20 });
                    return;
                }
            } else if (over()) {
                uncertainBonus = false;
                throw Error('Shilo entry stopped before payment');
            }
            if (d?.isOpen && !d.isWaiting) {
                const key = d.pageId ?? JSON.stringify([d.text, d.options, fresh]);
                if (!pages.has(key)) {
                    const pay = d.options.find(o => o.text === 'Use Furnace - 20 Gold');
                    if (pay && !selected) {
                        if (!accessSame(before, 0)) throw Error('Shilo entry pack changed before fare');
                        pages.add(key);
                        selected = true;
                        try {
                            await s.direct({ type: 'clickDialogOption', optionIndex: pay.index, reason: 'SDK' });
                        } catch {}
                    } else if ((d.options.length === 0 || (d.options.length === 1 && /continue/i.test(d.options[0]!.text))) && (!selected || terminal)) {
                        pages.add(key);
                        accessGuard();
                        try {
                            await raw.direct({ type: 'clickDialogOption', optionIndex: d.options[0]?.index ?? 0, reason: 'SDK' });
                        } catch {
                            if (!selected) throw Error('Shilo prepayment page acknowledgement unknown');
                        }
                    } else if (!selected || terminal) {
                        throw Error('Shilo unexpected entry page');
                    }
                }
            }
            await waitTicks(s, 1);
        }
        throw Error('Shilo paid entry unknown');
    };
    const bonusGuard = () => {
        if (!owner.own() || (s.client as { membersAccount?: number }).membersAccount !== 1 || !equipmentObserved(s.client as object) || s.sdk.getStateAge() > 5000 || hpMin < 7) {
            throw Error('smelt bonus original equipment/health/state unavailable');
        }
    };
    const closeBank = async () => {
        if (state()?.bank.isOpen && (!(await s.bot.closeBank()).success || !await waitUntil(s, () => !state()?.bank.isOpen, { timeoutTicks: 5 }))) {
            throw Error('smelt bonus bank close unknown');
        }
    };
    const changeSlot = async (id: number | undefined) => {
        bonusGuard();
        const old = s.sdk.getEquipment().find(i => i.slot === bonusSlot);
        if (old?.id === id) return;
        if (old) {
            if (inv().length >= 28) throw Error('smelt bonus needs an unequip slot');
            await closeBank();
            const before = inv().map(i => ({ ...i }));
            const w = wear();
            uncertainBonus = true;
            await s.bot.unequipItem(old);
            if (!await waitUntil(s, () => sameWear(wear(), w.filter(i => i.slot !== bonusSlot)) && packSame(inv(), [...before, { id: old.id, count: old.count }]), { timeoutTicks: 8 })) {
                throw Error('smelt bonus unequip unknown');
            }
            uncertainBonus = false;
            bonusGuard();
            await observeBank();
        }
        if (id === undefined) return;
        if (!held(id)) {
            if (inv().length >= 28) throw Error('smelt bonus needs an equip slot');
            if (!state()?.bank.isOpen) await observeBank();
            const row = state()?.bank.items.find(i => i.id === id);
            const before = held(id);
            const stock = count(bankRows(), id);
            if (!row || stock < 1) throw Error('smelt original/bonus gear unavailable');
            uncertainBonus = true;
            await s.bot.withdrawItem(row, 1, { asNote: false });
            if (!await waitUntil(s, () => held(id) === before + 1 && count(bankRows(), id) === stock - 1, { timeoutTicks: 8 })) {
                throw Error('smelt bonus withdrawal unknown');
            }
            uncertainBonus = false;
        }
        await closeBank();
        bonusGuard();
        const item = inv().find(i => i.id === id)!;
        const before = inv().map(i => ({ ...i }));
        const w = wear();
        const expected = before.map(i => ({ ...i }));
        const atIdx = expected.findIndex(i => i.id === id);
        expected[atIdx]!.count--;
        uncertainBonus = true;
        await s.bot.equipItem(item);
        if (!await waitUntil(s, () => sameWear(wear(), [...w, { id, count: 1, slot: bonusSlot }].sort((a, b) => a.slot - b.slot)) && packSame(inv(), expected), { timeoutTicks: 8 })) {
            throw Error('smelt bonus equip unknown');
        }
        uncertainBonus = false;
        bonusGuard();
        await observeBank();
    };
    const stageBonus = async () => {
        if (!bonus) return true;
        bonusGuard();
        if (bonus.kind === 'forging') {
            const already = wear().some(i => i.slot === 12 && i.id === 2568);
            if (!(already && ringsUsed > 0)) {
                const protectedRings = bonus.ringReserve + (originalBonusSlot?.id === 2568 ? 1 : 0) + (kit.get(2568) ?? 0);
                if (ringsUsed >= bonus.maximumRings || (totals().get(2568) ?? 0) <= protectedRings) return false;
                await changeSlot(2568);
                ringsUsed++;
            }
        } else {
            await changeSlot(776);
        }
        const now = totals();
        const ids = new Set([...initial!.keys(), ...now.keys()]);
        if (
            [...ids].some(
                id =>
                    (now.get(id) ?? 0) !==
                    (initial!.get(id) ?? 0) +
                        (id === r.product ? made : 0) -
                        (r.ingredients.find(i => i.id === id)?.units ?? 0) * consumedOre -
                        (id === 995 ? coinsSpent : 0) -
                        (id === 2568 ? ringBreaks : 0),
            )
        ) {
            throw Error('smelt bonus bank whole assets changed');
        }
        return true;
    };
    const restoreBonus = async () => {
        if (!bonus) return;
        await changeSlot(originalBonusSlot?.id);
        for (const id of new Set([bonusId, originalBonusSlot?.id].filter((id): id is number => id !== undefined))) {
            const extra = held(id) - (kit.get(id) ?? 0);
            if (extra > 0) {
                const row = inv().find(i => i.id === id)!;
                const before = held(id);
                const stock = count(bankRows(), id);
                uncertainBonus = true;
                await s.bot.depositItem(row, extra);
                if (!await waitUntil(s, () => held(id) === before - extra && count(bankRows(), id) === stock + extra, { timeoutTicks: 8 })) {
                    throw Error('smelt bonus deposit unknown');
                }
                uncertainBonus = false;
            }
        }
        const missing = (kit.get(bonusId) ?? 0) - held(bonusId);
        if (missing > 0) {
            const row = state()?.bank.items.find(i => i.id === bonusId);
            const stock = count(bankRows(), bonusId);
            const before = held(bonusId);
            if (!row || stock < missing || 28 - inv().length < missing) throw Error('smelt original pack gear unavailable');
            uncertainBonus = true;
            await s.bot.withdrawItem(row, missing, { asNote: false });
            if (!await waitUntil(s, () => held(bonusId) === before + missing && count(bankRows(), bonusId) === stock - missing, { timeoutTicks: 8 })) {
                throw Error('smelt original pack gear withdrawal unknown');
            }
            uncertainBonus = false;
        }
        gearRestored = sameWear(wear(), originalWear);
        if (!gearRestored) throw Error('smelt original equipment restoration unproved');
    };
    const bank = async (refill: boolean, cleanup = false) => {
        if (shilo) await leaveShilo(cleanup);
        if (!await walk(bankSite.x, bankSite.z, cleanup)) throw Error('smelt bank route incomplete');
        if (!state()?.bank.isOpen) await observeBank();
        if (!await waitUntil(s, () => !!state()?.bank.isOpen && !!s.bankObservation?.(), { timeoutTicks: 10 })) throw Error('smelt bank observation unready');
        initial ??= totals();
        for (const id of material) {
            const item = inv().find(i => i.id === id);
            if (item) await depositObserved(s, item);
        }
        for (const id of r.tools ?? []) {
            if (refill && !held(id)) {
                const row = state()?.bank.items.find(i => i.id === id);
                const stock = count(bankRows(), id);
                if (!row || stock < 1) throw Error('smelt owned reusable tool missing ' + id);
                uncertainBonus = true;
                await s.bot.withdrawItem(row, 1, { asNote: false });
                if (!await waitUntil(s, () => held(id) === 1 && count(bankRows(), id) === stock - 1, { timeoutTicks: 8 })) {
                    throw Error('smelt reusable tool withdrawal unknown');
                }
                uncertainBonus = false;
            }
            if (!refill && (kit.get(id) ?? 0) === 0 && held(id)) {
                uncertainBonus = true;
                await depositObserved(s, inv().find(i => i.id === id)!);
                if (held(id) !== 0) throw Error('smelt reusable tool return unknown');
                uncertainBonus = false;
            }
        }
        if (!refill) {
            if (shilo) {
                const extra = held(995) - (kit.get(995) ?? 0);
                if (extra > 0) {
                    const row = inv().find(i => i.id === 995)!;
                    const before = held(995);
                    const stock = count(bankRows(), 995);
                    uncertainBonus = true;
                    await s.bot.depositItem(row, extra);
                    if (!await waitUntil(s, () => held(995) === before - extra && count(bankRows(), 995) === stock + extra, { timeoutTicks: 8 })) {
                        throw Error('Shilo unused fare return unknown');
                    }
                    uncertainBonus = false;
                }
            }
            return 0;
        }
        if (shilo) {
            if (shiloEntries >= route!.maxEntries!) {
                stop = 'entry budget';
                return 0;
            }
            const remainingFees = 20 * (route!.maxEntries! - shiloEntries);
            if ((totals().get(995) ?? 0) < remainingFees + Math.max(route!.coinReserve!, kit.get(995) ?? 0)) {
                throw Error('Shilo owned fare budget/reserve unavailable');
            }
            const amount = Math.max(0, 20 + (kit.get(995) ?? 0) - held(995));
            if (amount) {
                const row = state()?.bank.items.find(i => i.id === 995);
                const before = held(995);
                const stock = count(bankRows(), 995);
                if (!row) throw Error('Shilo fare unavailable');
                uncertainBonus = true;
                await s.bot.withdrawItem(row, amount, { asNote: false });
                if (!await waitUntil(s, () => held(995) === before + amount && count(bankRows(), 995) === stock - amount, { timeoutTicks: 8 })) {
                    throw Error('Shilo fare withdrawal unknown');
                }
                uncertainBonus = false;
            }
        }
        if (!await stageBonus()) {
            stop = 'bonus gear depleted';
            return 0;
        }
        const batch = planSmeltLoad(r, bankRows(), 28 - inv().length, o.maximum - made, reserved).planned;
        if (!batch) return 0;
        for (const ingredient of r.ingredients) {
            const item = state()?.bank.items.find(i => i.id === ingredient.id);
            const amount = batch * ingredient.units;
            if (!item || !(await s.bot.withdrawItem(item, amount, { asNote: false })).success || !await waitUntil(s, () => held(ingredient.id) === amount, { timeoutTicks: 8 })) {
                throw Error('smelt withdrawal unobserved ' + ingredient.id);
            }
        }
        if (!(await s.bot.closeBank()).success || !await waitUntil(s, () => !state()?.bank.isOpen, { timeoutTicks: 5 })) {
            throw Error('smelt bank close unobserved');
        }
        return batch;
    };
    try {
        if (entry.fare) {
            travel = true;
            await observeBank();
            initial = totals();
            if (over() || hpMin < 7) throw Error('smelt entry stopped/low health');
            if ((initial.get(995) ?? 0) < entry.fare) throw Error('smelt entry needs 10 coins for toll');
            const needed = Math.max(0, entry.fare - held(995));
            if (needed) {
                const coins = state()?.bank.items.find(i => i.id === 995);
                const before = held(995);
                if (!coins || !(await s.bot.withdrawItem(coins, needed, { asNote: false })).success || !await waitUntil(s, () => held(995) === before + needed, { timeoutTicks: 8 })) {
                    throw Error('smelt fare withdrawal unobserved');
                }
            }
            if (!await waitUntil(s, () => count(bankRows(), 995) + held(995) === (initial!.get(995) ?? 0), { timeoutTicks: 8 })) {
                throw Error('smelt fare bank balance unobserved');
            }
            if (!(await s.bot.closeBank()).success || !await waitUntil(s, () => !state()?.bank.isOpen, { timeoutTicks: 5 })) {
                throw Error('smelt entry bank close unobserved');
            }
            for (const point of entry.points) {
                if (over()) throw Error('smelt entry stopped');
                let reached = false;
                let detail = '';
                try {
                    reached = await walk(point.x, point.z);
                } catch (error) {
                    detail = String(error);
                }
                if (!reached && !await recover(point.x, point.z)) {
                    throw Error(`smelt entry corridor incomplete at ${point.x},${point.z}${detail ? ': ' + detail : ''}`);
                }
                passed.push(point);
            }
            const guardNpc = s.sdk.getNearbyNpcs().filter(n => n.id === 925).sort((a, b) => a.distance - b.distance)[0];
            if (!guardNpc || !(await s.sdk.sendInteractNpc(guardNpc.index, 1)).success) throw Error('smelt west toll guard unavailable');
            const cash = held(995);
            const deadline = s.tick() + 45;
            let answered = false;
            try {
                while (!near(3268, 3227, 1) || (state()?.player?.worldX ?? 0) < 3268) {
                    if (over() || s.tick() >= deadline) throw Error('smelt toll crossing deadline');
                    const d = s.sdk.getDialog();
                    if (d?.isOpen && !d.isWaiting) {
                        if (d.options.some(v => /yes, ok/i.test(v.text))) {
                            if (!answered) {
                                if (!(await s.sdk.clickDialogByText(/yes, ok/i)).success) throw Error('smelt toll choice refused');
                                answered = true;
                            }
                        } else if (d.options.length === 0 || (d.options.length === 1 && /continue/i.test(d.options[0]!.text))) {
                            if (!(await s.sdk.sendClickDialog(d.options[0]?.index ?? 0)).success) throw Error('smelt toll continue refused');
                        } else {
                            throw Error('smelt unexpected toll dialog');
                        }
                    }
                    await waitTicks(s, 1);
                }
                crossed = true;
                if (!await waitUntil(s, () => cash - held(995) === (answered ? entry.fare : 0), { timeoutTicks: 5 })) {
                    throw Error('smelt toll debit unobserved');
                }
            } finally {
                coinsSpent = cash - held(995);
            }
            if (coinsSpent !== (answered ? entry.fare : 0)) throw Error('smelt toll debit mismatch');
            for (const [x, z] of [[3272, 3227], [3275, 3212], [3273, 3194], [3269, 3167]]) {
                if (over() || !await walk(x!, z!)) throw Error('smelt destination corridor incomplete');
            }
            travel = false;
            travelTicks = s.tick() - start;
        }
        arrival = true;
        while (made < o.maximum && !over()) {
            const batch = await bank(true);
            if (!batch) {
                if (stop !== 'bonus gear depleted') stop = 'depleted';
                break;
            }
            if (shilo) {
                await enterShilo();
                if (over()) break;
            }
            if (!await walk(furnaceStand.x, furnaceStand.z)) throw Error('smelt furnace route incomplete');
            while (r.ingredients.every(i => held(i.id) >= i.units) && made < o.maximum && !over()) {
                const dialog = s.sdk.getDialog();
                if (dialog?.isOpen) {
                    if (dialog.isWaiting) {
                        await waitTicks(s, 1);
                        continue;
                    }
                    const option = dialog.options.find(v => /continue/i.test(v.text));
                    if (!option) throw Error('smelt unexpected dialog');
                    const reply = await s.sdk.sendClickDialog(option.index);
                    if (!reply.success) throw Error('smelt dialog click refused: ' + JSON.stringify(reply));
                    await waitTicks(s, 1);
                    continue;
                }
                localAdmission();
                cannonAdmission();
                const furnace = route ? declaredFurnace() : s.sdk.findNearbyLoc(/^furnace$/i, { withOption: /smelt/i });
                const ore = inv().find(i => i.id === r.ingredients[0]!.id);
                if (!furnace || !ore || (route && !near(furnaceStand.x, furnaceStand.z, 0))) {
                    throw Error('smelt furnace/ore/declared stand missing');
                }
                const before = inv().map(i => ({ id: i.id, count: i.count }));
                const beforeXp = xp();
                attempts++;
                const foreignXp = cannon ? JSON.stringify(state()?.skills.filter(k => k.name !== 'Smithing').map(k => [k.name, k.experience])) : '';
                if (cannon && (!held(4) || !sameWear(wear(), originalWear))) throw Error('cannonball mould/original gear missing');
                const beforeWear = bonus ? wear() : [];
                if (bonus) {
                    bonusGuard();
                    if (!sameWear(beforeWear, [...originalWear.filter(i => i.slot !== bonusSlot), { id: bonusId, count: 1, slot: bonusSlot }].sort((a, b) => a.slot - b.slot))) {
                        throw Error('smelt bonus gear absent/changed before Make1');
                    }
                }
                const cursor = Math.max(-1, ...(state()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
                const ironLoss = () => r.iron && (state()?.gameMessages ?? []).some(m => (m.observationId ?? m.tick) > cursor && /ore is too impure|fail to refine/i.test(m.text));
                const meltMessage = () => bonus?.kind === 'forging' && (state()?.gameMessages ?? []).some(m => m.type === 0 && (m.observationId ?? m.tick) > cursor && m.text === 'Your Ring of Forging has melted.');
                const cannonTerminal = () => state()?.gameMessages.find(m => m.type === 0 && !m.sender && !m.fromSelf && (m.observationId ?? m.tick) > cursor && m.text === 'You remove the cannonballs from the mould.');
                const wearReceipt = () => !bonus || (sameWear(wear(), beforeWear) && !meltMessage()) || (bonus.kind === 'forging' && meltMessage() && sameWear(wear(), beforeWear.filter(i => i.slot !== 12)));
                if (bonus || route || cannon) uncertainBonus = true;
                localPaid = !!route || cannon;
                let sent: Awaited<ReturnType<typeof s.sdk.sendUseItemOnLoc>>;
                try {
                    sent = await s.sdk.sendUseItemOnLoc(ore.slot, furnace.x, furnace.z, furnace.id);
                } finally {
                    localPaid = false;
                }
                await waitUntil(s, () => ended || died || held(r.ingredients[0]!.id) < count(before, r.ingredients[0]!.id), {
                    timeoutTicks: cannon ? Math.min(r.receiptTicks!, Math.max(1, bonusDeadline - s.tick())) : 8,
                });
                await waitUntil(
                    s,
                    () => ended || died || (held(r.product) > count(before, r.product) && xp() > beforeXp && wearReceipt() && (!cannon || !!cannonTerminal())) || ironLoss(),
                    { timeoutTicks: cannon ? 3 : 2 },
                );
                if (bonus) {
                    await waitTicks(s, 2);
                    bonusGuard();
                }
                const effect = smeltEffect(r, before, inv(), beforeXp, xp());
                if (cannon) {
                    const delta = r.rawXp! * o.xpRate!;
                    const expected = before.map(i => ({ ...i }));
                    let left = 1;
                    for (const row of expected) {
                        if (row.id === 2353 && left) {
                            row.count--;
                            left--;
                        }
                    }
                    expected.push({ id: r.product, count: productUnits });
                    const terminal = cannonTerminal();
                    if (
                        !owner.own() ||
                        ended ||
                        died ||
                        effect.kind !== 'made' ||
                        !terminal ||
                        !packSame(inv(), expected) ||
                        !sameWear(wear(), originalWear) ||
                        JSON.stringify(state()?.skills.filter(k => k.name !== 'Smithing').map(k => [k.name, k.experience])) !== foreignXp ||
                        xp() - beforeXp < Math.floor(delta / 10) ||
                        xp() - beforeXp > Math.ceil(delta / 10)
                    ) {
                        throw Error('cannonball terminal/whole-pack/XP effect unknown');
                    }
                    cannonRawXp += delta;
                    if (xp() - xp0 < Math.floor(cannonRawXp / 10) || xp() - xp0 > Math.ceil(cannonRawXp / 10)) {
                        throw Error('cannonball cumulative XP mismatch');
                    }
                    cannonReceipts.push({ tick: s.tick(), terminal: terminal.observationId ?? terminal.tick, rawXp: delta, products: productUnits });
                    uncertainBonus = false;
                }
                let melted = false;
                if (bonus) {
                    const delta = smeltBonusRawXp(bonus);
                    const expected = before.map(i => ({ ...i }));
                    for (const ingredient of r.ingredients) {
                        let left = ingredient.units;
                        for (const row of expected) {
                            if (row.id === ingredient.id) {
                                const n = Math.min(left, row.count);
                                row.count -= n;
                                left -= n;
                            }
                        }
                    }
                    expected.push({ id: r.product, count: 1 });
                    if (effect.kind !== 'made' || !packSame(inv(), expected) || xp() - beforeXp < Math.floor(delta / 10) || xp() - beforeXp > Math.ceil(delta / 10)) {
                        throw Error('smelt bonus paid output/whole-pack/XP unknown');
                    }
                    if (bonus.kind === 'forging' && !sameWear(wear(), beforeWear)) {
                        if (!await waitUntil(s, () => meltMessage(), { timeoutTicks: 2 }) || !sameWear(wear(), beforeWear.filter(i => i.slot !== 12))) {
                            throw Error('smelt ring debit without exact fresh melt receipt');
                        }
                        melted = true;
                    } else if (!sameWear(wear(), beforeWear) || meltMessage()) {
                        throw Error('smelt bonus equipment receipt mismatch');
                    }
                    bonusRawXp += delta;
                    if (xp() - xp0 < Math.floor(bonusRawXp / 10) || xp() - xp0 > Math.ceil(bonusRawXp / 10)) {
                        throw Error('smelt cumulative bonus XP mismatch');
                    }
                    if (melted) ringBreaks++;
                    uncertainBonus = false;
                }
                if (effect.kind === 'none') {
                    if (route || !sent.success || ++misses >= 3) throw Error('no smelt progress: unchanged recipe after bounded attempts');
                } else {
                    misses = 0;
                    consumedOre++;
                    made += effect.made;
                    if (effect.kind === 'loss') {
                        losses++;
                        if (!ironLoss()) throw Error('iron impurity loss message unobserved');
                    }
                }
                if (route) uncertainBonus = false;
                if (melted) break;
            }
        }
        if (made >= o.maximum) stop = 'target';
    } catch (error) {
        failure = 'no smelt progress: ' + String(error);
    } finally {
        try {
            if (!uncertainBonus && !ended && !died && owner.cleanup()) {
                if (bonus || route || cannon) bonusDeadline = s.tick() + 160;
                if (s.sdk.getDialog()?.isOpen) {
                    await s.direct({ type: 'closeModal', reason: 'SDK' });
                    if (!await waitUntil(s, () => !s.sdk.getDialog()?.isOpen, { timeoutTicks: 5 })) {
                        throw Error('smelt final dialog close unobserved');
                    }
                }
                if (arrival || crossed) {
                    await bank(false, true);
                    await restoreBonus();
                } else if (entry.fare) {
                    if (!near(3253, 3420, 5)) {
                        for (const point of [...passed].reverse()) if (!await recover(point.x, point.z, true)) throw Error('smelt entry retreat incomplete');
                        if (!await recover(entryBank.x, entryBank.z, true)) throw Error('smelt entry bank retreat incomplete');
                    }
                    if (!state()?.bank.isOpen) await observeBank();
                }
            }
        } catch (error) {
            failure = failure ? failure + '; final bank: ' + String(error) : 'no smelt progress: final bank: ' + String(error);
        }
        off();
    }
    if (travel) travelTicks = s.tick() - start;
    const finalObservation = s.bankObservation?.();
    const final = initial ? totals() : new Map<number, number>();
    const banked = initial && finalObservation ? (final.get(r.product) ?? 0) - (initial.get(r.product) ?? 0) - held(r.product) : null;
    const preserved = [...kit].every(([id, n]) => (id === 995 ? true : held(id) === n));
    const allIds = new Set([...(initial?.keys() ?? []), ...final.keys()]);
    const conserved =
        initial && lastBank
            ? [...allIds].every(id => {
                  const ingredient = r.ingredients.find(i => i.id === id);
                  const expected =
                      (initial!.get(id) ?? 0) +
                      (id === r.product ? made * productUnits : 0) -
                      (ingredient ? consumedOre * ingredient.units : 0) -
                      (id === 995 ? coinsSpent : 0) -
                      (id === 2568 ? ringBreaks : 0);
                  return (final.get(id) ?? 0) === expected;
              })
            : null;
    const reserveMet = finalObservation
        ? r.ingredients.every(i => count(finalObservation.items, i.id) >= (reserved[i.id] ?? 0)) &&
          (!shilo || (final.get(995) ?? 0) >= route!.coinReserve!) &&
          (!bonus || bonus.kind !== 'forging' || count(finalObservation.items, 2568) >= bonus.ringReserve)
        : null;
    if (!failure && o.mode === 'exact' && made !== o.maximum) failure = `no smelt progress: exact target unmet ${made}/${o.maximum} (${stop})`;
    if (!failure && made === 0) failure = `no smelt progress: zero observed bars (${stop})`;
    if (cannon) gearRestored = sameWear(wear(), originalWear) && (r.tools ?? []).every(id => held(id) === (kit.get(id) ?? 0));
    if (!failure && (banked !== made * productUnits || !conserved || !preserved || !reserveMet || !gearRestored)) {
        failure = 'no smelt progress: final bank/asset/reserve acceptance unproved';
    }
    const ok =
        owner.own() &&
        !failure &&
        !ended &&
        !died &&
        !o.stop?.() &&
        hpMin >= 7 &&
        made > 0 &&
        xp() > xp0 &&
        near(bankSite.x, bankSite.z) &&
        banked === made * productUnits &&
        preserved &&
        conserved === true &&
        reserveMet === true &&
        [...material].every(id => held(id) === 0) &&
        (o.mode === 'best-effort' || made === o.maximum);
    return {
        ok: ok && gearRestored && !uncertainBonus,
        bar: o.bar,
        mode: o.mode,
        target: o.maximum,
        targetMet: made === o.maximum,
        ticks: s.tick() - start,
        entry: entry.name,
        travelTicks,
        coinsSpent,
        initialCoins: initial?.get(995) ?? 0,
        finalCoins: final.get(995) ?? 0,
        made,
        banked,
        consumedOre,
        losses,
        attempts,
        xpGain: xp() - xp0,
        preserved,
        conserved,
        reserveMet,
        hpMin,
        died,
        stop,
        failure,
        ...(cannon ? { products: made * productUnits, productUnits, cannonRawXp, cannonReceipts, gearRestored, deferred: uncertainBonus } : {}),
        ...(bonus ? { bonusGear: bonus, bonusRawXp, ringBreaks, ringsUsed, gearRestored, deferred: uncertainBonus } : {}),
        ...(route ? { route, deferred: uncertainBonus, ...(shilo ? { accessReceipts, shiloEntries } : {}) } : {}),
        nextConsumer: 'Smithing progression; measure iron-tip/ammo conversion before more surplus mining',
    };
}

// ---- Cannonballs (microbot-a-cannonballs.ts) ----

export const CANNON = { bar: 2353, ball: 2, mould: 4, level: 35, perBar: 4, bank: { x: 3269, z: 3167 }, furnace: { x: 3274, z: 3186 } } as const;

export function cannonballEffect(before: Stock, after: Stock, xp0: number, xp1: number) {
    const ids = new Set([...before, ...after].map(i => i.id));
    if ([...ids].every(id => count(before, id) === count(after, id)) && xp0 === xp1) return 'none';
    return xp1 > xp0 && [...ids].every(id => count(after, id) - count(before, id) === (id === CANNON.bar ? -1 : id === CANNON.ball ? 4 : 0))
        ? 'made'
        : 'invalid';
}

export type CannonballOrder = { bars: number; cap: number; stop?: () => boolean; xpRate?: number; reserve?: number; route?: SmeltLocalRoute; nearest?: boolean };

export async function runCannonballs(s: Session, o: CannonballOrder, io?: Parameters<typeof runSmeltBatch>[2]) {
    if (!Number.isSafeInteger(o.bars) || o.bars < 1 || o.bars > 100000 || !Number.isSafeInteger(o.cap) || o.cap < 1 || o.cap > 10000) {
        throw Error('invalid cannonball batch');
    }
    const p = s.sdk.getState()?.player;
    if (!p) throw Error('stage cannonballs with observed player');
    const r = await runSmeltBatch(
        s,
        { bar: 'cannonballs', maximum: o.bars, cap: o.cap, mode: 'exact', reserve: o.reserve ?? 0, xpRate: o.xpRate ?? 1, route: o.route, nearest: o.nearest, stop: o.stop },
        io,
    );
    return { ...r, bars: r.made, balls: r.made * CANNON.perBar, xp: r.xpGain };
}

// ---- Smelt Bars & Bronze (smelt-bars.ts) ----

const FURNACE_SPOT = { x: 3274, z: 3186 };
const BANK_SPOT = { x: 3269, z: 3167 };

export function smeltBonusFromEnv(env: Record<string, string | undefined>): SmeltBonusGear | undefined {
    const kind = env.SMELT_BONUS_GEAR;
    if (kind === undefined) return undefined;
    const xpRate = Number(env.SMELT_XP_RATE ?? 25);
    if (kind === 'goldsmith') return { kind, xpRate };
    if (kind === 'forging') return { kind, xpRate, maximumRings: Number(env.MAX_RINGS), ringReserve: Number(env.RING_RESERVE) };
    throw Error('SMELT_BONUS_GEAR must be goldsmith or forging');
}

export function smeltRouteFromEnv(env: Record<string, string | undefined>): SmeltLocalRoute | undefined {
    if (env.SMELT_NEAREST !== undefined && !['0', '1'].includes(env.SMELT_NEAREST)) throw Error('SMELT_NEAREST must be0or1');
    if (env.SMELT_NEAREST === '1' && env.SMELT_ROUTE_JSON !== undefined) throw Error('nearest and explicit smelt routes are mutually exclusive');
    const text = env.SMELT_ROUTE_JSON;
    if (text === undefined) return undefined;
    if (text.length > 4096) throw Error('local smelt route JSON too large');
    return validateSmeltRoute(JSON.parse(text));
}

type BronzeState = { copper: number; tin: number; bars: number; xp: number };

export function planBronze(copper: number, tin: number, freeSlots: number, maximum: number, reserve: number) {
    for (const n of [copper, tin, freeSlots, maximum, reserve]) if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid bronze bound');
    return productionBatch(
        [
            { id: 436, available: copper, reserved: reserve, units: 1, stackable: false },
            { id: 438, available: tin, reserved: reserve, units: 1, stackable: false },
        ],
        freeSlots,
        maximum,
        'best-effort',
    ).planned;
}

export function bronzeProgress(before: BronzeState, after: BronzeState) {
    const n = after.bars - before.bars;
    return n > 0 && before.copper - after.copper === n && before.tin - after.tin === n && after.xp > before.xp ? n : 0;
}

export async function runBronze(
    raw: Session,
    options: { maximum: number; reserve: number; cap: number; stop?: () => boolean; keepPattern?: string },
    io?: { walk: (x: number, z: number) => Promise<boolean> },
) {
    const owner = smeltOwnedSession(raw, options.stop);
    const s = owner.session;
    for (const n of [options.maximum, options.reserve, options.cap]) if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid bronze options');
    if (options.maximum < 1 || options.cap < 1) throw new Error('positive MAX_MAKE and CAP required');
    const ready = await waitUntil(
        s,
        () => owner.stopped() || ((s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0 && (s.sdk.getSkill('Smithing')?.baseLevel ?? 0) > 0),
        { timeoutTicks: 15 },
    );
    if (!ready || owner.stopped()) throw new Error('bronze initial skills not ready');
    const inv = () => s.sdk.getInventory();
    const bankItems = () => s.sdk.getState()?.bank?.items ?? [];
    const cnt = (items: { id: number; count: number }[], id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const state = (): BronzeState => ({ copper: cnt(inv(), 436), tin: cnt(inv(), 438), bars: cnt(inv(), 2349), xp: s.sdk.getSkillXp('Smithing') ?? 0 });
    const p0 = { ...s.sdk.getState()!.player! };
    const t0 = s.tick();
    const xp0 = state().xp;
    if (p0.level !== 0 || Math.max(Math.abs(p0.worldX - BANK_SPOT.x), Math.abs(p0.worldZ - BANK_SPOT.z)) > 5) {
        throw new Error('bronze requires staged Al Kharid bank entry');
    }
    let died = false;
    let ended = false;
    let hpMin = s.sdk.getSkill('Hitpoints')!.level;
    let made = 0;
    let attempts = 0;
    let failed = 0;
    let failure = '';
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        hpMin = Math.min(hpMin, s.sdk.getSkill('Hitpoints')?.level ?? hpMin);
        if (!owner.own() || p?.isDead || hpMin <= 0 || (p?.respawnCount ?? 0) > (p0.respawnCount ?? 0) || (p0.lifeId !== undefined && (p?.lifeId ?? p0.lifeId) !== p0.lifeId)) {
            died = true;
        }
    });
    const keep = new RegExp(options.keepPattern ?? process.env.KEEP ?? '^(knife|shrimps|bread|shears|.*pickaxe|coins)$', 'i');
    const protectedKit = new Map<number, number>();
    for (const i of inv()) if (keep.test(i.name)) protectedKit.set(i.id, (protectedKit.get(i.id) ?? 0) + i.count);
    const over = () => owner.stopped() || ended || died || hpMin < 7 || s.tick() - t0 >= options.cap;
    const walk = async (x: number, z: number, cleanup = false) => {
        if (!owner.own() || (!cleanup && over())) throw Error('bronze original walk stopped');
        if (io) {
            if (
                !(await io.walk(x, z)) ||
                !owner.own() ||
                s.sdk.getState()?.player?.level !== 0 ||
                Math.max(Math.abs((s.sdk.getState()?.player?.worldX ?? NaN) - x), Math.abs((s.sdk.getState()?.player?.worldZ ?? NaN) - z)) > 2
            ) {
                throw Error('bronze test/declared walk unconfirmed');
            }
            return;
        }
        const r = await walkPath(await sessionWalker(s), [{ x, z, tol: 2 }], { maxTicks: 80, stop: () => !owner.own() || ended || died || (!cleanup && over()) });
        if (!r.ok) throw new Error(`bronze walk ${r.detail}`);
    };
    const open = async () => {
        if (!(await s.bot.openBank()).success) throw new Error('bronze bank open failed');
        await waitTicks(s, 2);
    };
    const deposit = async (ids: number[]) => {
        for (const id of new Set(ids)) {
            const item = inv().find(i => i.id === id);
            if (item) {
                const r = await s.bot.depositItem(item, -1);
                if (!r.success) throw new Error(`bronze deposit failed id=${id}`);
            }
        }
        await waitTicks(s, 1);
    };
    let initialCopper = 0;
    let initialTin = 0;
    let initialBars = 0;
    let planned = 0;
    let finalCopper = 0;
    let finalTin = 0;
    let finalBars = 0;
    let banked = 0;
    try {
        await open();
        await deposit(inv().filter(i => !keep.test(i.name)).map(i => i.id));
        initialCopper = cnt(bankItems(), 436);
        initialTin = cnt(bankItems(), 438);
        initialBars = cnt(bankItems(), 2349);
        planned = planBronze(initialCopper, initialTin, 28 - inv().length, options.maximum, options.reserve);
        if (planned < options.maximum) throw new Error(`bronze input insufficient planned=${planned} target=${options.maximum}`);
        for (const [id, name] of [[436, 'Copper ore'], [438, 'Tin ore']] as const) {
            await s.bot.withdrawItem(new RegExp(`^${name}$`, 'i'), planned);
            if (cnt(inv(), id) !== planned) throw new Error(`bronze partial withdrawal id=${id}`);
        }
        await s.bot.closeBank();
        await walk(FURNACE_SPOT.x, FURNACE_SPOT.z);
        while (made < planned && !over()) {
            const d = s.sdk.getDialog();
            if (d?.isOpen) {
                if (d.options.length === 1 && /continue/i.test(d.options[0]!.text)) {
                    await s.sdk.sendClickDialog(d.options[0]!.index);
                    await waitTicks(s, 1);
                    continue;
                }
                throw new Error('unexpected bronze dialog');
            }
            const furnace = s.sdk.findNearbyLoc(/^furnace$/i);
            const ore = inv().find(i => i.id === 436);
            if (!furnace || !ore) throw new Error('bronze furnace/copper unavailable');
            const before = state();
            attempts++;
            await s.sdk.sendUseItemOnLoc(ore.slot, furnace.x, furnace.z, furnace.id);
            await waitUntil(s, () => bronzeProgress(before, state()) > 0 || over(), { timeoutTicks: 8 });
            const gained = bronzeProgress(before, state());
            if (gained) {
                made += gained;
                failed = 0;
            } else {
                console.log(`WARN bronze no-progress attempt=${attempts} state=${JSON.stringify(state())}`);
                if (++failed >= 3) throw new Error('no smelting progress: three attempts');
                await waitTicks(s, 1);
            }
        }
        if (made !== options.maximum) failure = 'bronze stopped before target';
    } catch (e) {
        failure = String(e);
    } finally {
        try {
            if (!ended && !died && owner.cleanup()) {
                const d = s.sdk.getDialog();
                if (d?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                await walk(BANK_SPOT.x, BANK_SPOT.z, true);
                await open();
                await deposit([436, 438, 2349]);
                finalCopper = cnt(bankItems(), 436);
                finalTin = cnt(bankItems(), 438);
                finalBars = cnt(bankItems(), 2349);
                banked = finalBars - initialBars;
                console.log('BRONZE_BANK ' + JSON.stringify({ bank: bankItems(), inventory: inv() }));
                await s.bot.closeBank();
            }
        } catch (e) {
            failure ||= `bronze final bank failed: ${String(e)}`;
        }
        off();
    }
    const preserved = [...protectedKit].every(([id, n]) => cnt(inv(), id) === n);
    const xpGain = state().xp - xp0;
    const reserveMet = finalCopper >= options.reserve && finalTin >= options.reserve;
    const conserved = initialCopper - finalCopper === made && initialTin - finalTin === made;
    const ok =
        owner.own() &&
        !owner.stopped() &&
        !failure &&
        !died &&
        !ended &&
        hpMin >= 7 &&
        made === options.maximum &&
        banked === made &&
        xpGain > 0 &&
        preserved &&
        reserveMet &&
        conserved &&
        [436, 438, 2349].every(id => cnt(inv(), id) === 0);
    const result = { ok, ticks: s.tick() - t0, made, banked, planned, attempts, xpGain, initialCopper, initialTin, initialBars, finalCopper, finalTin, finalBars, preserved, reserveMet, conserved, hpMin, died, failure };
    console.log('BRONZE_RESULT ' + JSON.stringify(result));
    return result;
}

// ---- Anvil Smithing (smith-batch.ts) ----

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

export const HAMMER = 2347;
export const SMITHING_INTERFACE = 994;
export const TOLL_GUARD_EAST = 926;

const smithRecipeCache = new Map<number, SmithRecipe>();

export function smithRecipe(product: number): SmithRecipe {
    const unsupported = Error('unsupported smith recipe: ' + product);
    if (!Number.isSafeInteger(product) || product < 0) throw unsupported;
    const cached = smithRecipeCache.get(product);
    if (cached) return cached;
    const configs = 'scripts/skill_smithing/configs/';
    const pack = (file: string) =>
        new Map(
            readFileSync(join(CONTENT_DIR, 'pack', file), 'utf8')
                .split(/\r?\n/)
                .flatMap(l => {
                    const m = l.match(/^(\d+)=(.+)$/);
                    return m ? ([[m[2]!, Number(m[1])] as const]) : [];
                }),
        );
    const blocks = (file: string) => parseConfigs(readFileSync(join(CONTENT_DIR, configs + file), 'utf8'), file);
    const field = (rows: string[] | undefined, key: string) => rows?.find(v => v.startsWith(key + ','))?.slice(key.length + 1);
    const objs = pack('obj.pack');
    const name = [...objs].find(([, id]) => id === product)?.[0];
    const row = name === undefined ? undefined : blocks('smithing/smithing.dbrow').find(b => field(b.props.data, 'product') === name);
    if (!row) throw unsupported;
    const bar = field(row.props.data, 'bar')!;
    const struct = field(blocks('smelting/smelting.obj').find(b => b.name === bar)?.props.param, 'smithing_anvil_struct');
    const params = blocks('smithing/smithing.struct').find(b => b.name === struct)?.props.param;
    const invs = blocks('smithing/smithing.inv');
    const components = pack('interface.pack');
    const columns = Array.from({ length: 5 }, (_, i) => ({ inventory: field(params, 'invcolumn' + (i + 1)), component: 'smithing:column' + (i + 1) }));
    const handler = readFileSync(join(CONTENT_DIR, 'scripts/skill_smithing/scripts/smithing/smithing.rs2'), 'utf8');
    const branch = handler.split('case ' + bar + ' :')[1]?.split(/\bcase /)[0];
    const claws = branch?.match(/inv_transmit\((\w+), smithing:column_claws\)/)?.[1];
    if (claws) columns.push({ inventory: claws, component: 'smithing:column_claws' });
    for (const column of columns) {
        const inv = invs.find(b => b.name === column.inventory);
        const stock = Object.entries(inv?.props ?? {}).find(([k, v]) => /^stock\d+$/.test(k) && v[0]?.split(',')[0] === name);
        const component = components.get(column.component);
        if (!stock || component === undefined) continue;
        const recipe = {
            product,
            amount: Number(field(row.props.data, 'product_amount')),
            level: Math.max(Number(field(row.props.data, 'levelrequired')), Number(field(params, 'levelrequired'))),
            bar: objs.get(bar)!,
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

export function planSmithLoad(r: SmithRecipe, bank: Stock, freeSlots: number, maximum: number, reserve: number) {
    return productionBatch([{ id: r.bar, available: count(bank, r.bar), reserved: reserve, units: r.bars, stackable: false }], freeSlots, maximum, 'best-effort');
}

export function smithEffect(r: SmithRecipe, before: Stock, after: Stock, xpBefore: number, xpAfter: number) {
    const debit = count(before, r.bar) - count(after, r.bar);
    const made = count(after, r.product) - count(before, r.product);
    if (debit === 0 && made === 0 && xpAfter === xpBefore) return 0;
    if (debit === r.bars && made === r.amount && xpAfter > xpBefore) return 1;
    throw Error('smith bar/product/XP mismatch');
}

export async function runSmithBatch(
    s: Session,
    o: { product: number; cap: number; maximum: number; reserve: number; stop?: () => boolean; allowNativeQuestProbe?: boolean },
    io?: { walk: (x: number, z: number) => Promise<boolean>; recover?: (x: number, z: number) => Promise<boolean> },
) {
    if (![o.product, o.cap, o.maximum, o.reserve].every(Number.isSafeInteger) || o.cap < 1 || o.maximum < 1 || o.reserve < 0) {
        throw Error('invalid finite smith order');
    }
    const r = smithRecipe(o.product);
    const state = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const held = (id: number) => count(inv(), id);
    const xp = () => s.sdk.getSkillXp('Smithing') ?? 0;
    if (o.allowNativeQuestProbe !== undefined && typeof o.allowNativeQuestProbe !== 'boolean') {
        throw Error('invalid native quest admission option');
    }
    const allowNativeQuestProbe = o.allowNativeQuestProbe ?? process.env.SMITH_NATIVE_QUEST_PROBE === '1';
    let nativeQuestAdmission = false;
    const ready = await waitUntil(s, () => !!state()?.player && (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0 && (s.sdk.getSkill('Smithing')?.baseLevel ?? 0) > 0, {
        timeoutTicks: 15,
    });
    if (!ready) throw Error('smith entry state unobserved');
    const p0 = state()!.player!;
    const start = s.tick();
    const xp0 = xp();
    const level = s.sdk.getSkill('Smithing')!.baseLevel;
    const material = new Set([r.bar, r.product]);
    const kit = new Map<number, number>();
    for (const i of inv()) if (!material.has(i.id)) kit.set(i.id, (kit.get(i.id) ?? 0) + i.count);
    let ended = false;
    let died = false;
    let hpMin = s.sdk.getSkill('Hitpoints')!.level;
    let made = 0;
    let attempts = 0;
    let misses = 0;
    let failure = '';
    let stop = 'cap';
    let entry = '';
    const hpStart = hpMin;
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => {
        const p = state()?.player;
        hpMin = Math.min(hpMin, s.sdk.getSkill('Hitpoints')?.level ?? hpMin);
        died ||= hpMin <= 0 || (!!p && (p.isDead || (p.respawnCount ?? 0) > (p0.respawnCount ?? 0) || (p0.lifeId !== undefined && p.lifeId !== p0.lifeId)));
    });
    const over = () => ended || died || hpMin < 7 || !!o.stop?.() || s.tick() - start >= o.cap;
    const near = (x: number, z: number, tol = 3) => {
        const p = state()?.player;
        return !!p && p.level === 0 && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };
    let travel = false;
    let travelTicks = 0;
    let coinsSpent = 0;
    let arrival = false;
    let hammerWithdrawn = false;
    const recover = async (x: number, z: number) => {
        if (over()) return false;
        if (io) return !!io.recover && (await io.recover(x, z)) && near(x, z);
        const ac = new AbortController();
        const began = s.tick();
        const budget = Math.min(160, Math.max(1, o.cap - (s.tick() - start)));
        const stopRecovery = s.onTick(() => {
            if (over() || s.tick() - began >= budget) ac.abort('smith recovery deadline/stop');
        });
        try {
            const result = await goTo(s, await getWorld(), { x, z, level: 0 }, accountOf(s), { maxRetriesPerLeg: 1, legTimeoutTicks: budget, signal: ac.signal });
            return result.ok && near(x, z);
        } finally {
            stopRecovery();
        }
    };
    const walk = async (x: number, z: number, cleanup = false) => {
        if (io) return (await io.walk(x, z)) && near(x, z);
        const walker = await sessionWalker(s);
        const plan = walker.plan;
        const tol = 1;
        const inside = (t: { x: number; z: number }) => Math.max(Math.abs(t.x - x), Math.abs(t.z - z)) <= tol;
        walker.plan = (lvl, from, to) => {
            const path = plan(lvl, from, to);
            if (!inside(path.at(-1) ?? from)) throw Error('smith incomplete corridor plan');
            return path;
        };
        const result = await walkPath(walker, [{ x, z, tol }], {
            maxTicks: Math.min(160, cleanup ? 160 : Math.max(1, o.cap - (s.tick() - start))),
            stop: () => ended || died || hpMin < 7 || (!cleanup && over()) || (travel && (s.sdk.getSkill('Hitpoints')?.level ?? 0) < hpStart),
        });
        return result.ok && near(x, z);
    };
    const leg = async (x: number, z: number) => {
        if (over()) throw Error('smith staging stopped');
        let reached = false;
        let detail = '';
        try {
            reached = await walk(x, z);
        } catch (error) {
            detail = String(error);
        }
        if (!reached && !await recover(x, z)) throw Error(`smith staging corridor incomplete at ${x},${z}${detail ? ': ' + detail : ''}`);
    };
    let lastBank: Stock | undefined;
    const bankRows = () => {
        const observed = s.bankObservation?.();
        if (observed) lastBank = observed.items.map(i => ({ id: i.id, count: i.count }));
        return lastBank ?? [];
    };
    const totals = () => {
        const m = new Map<number, number>();
        for (const i of [...inv(), ...s.sdk.getEquipment(), ...bankRows()]) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        return m;
    };
    let initial: Map<number, number> | undefined;
    const openBank = async () => {
        if (state()?.bank.isOpen && s.bankObservation?.()) return;
        const generation = s.bankObservation?.()?.generation ?? -1;
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!state()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation, { timeoutTicks: 10 })) {
            throw Error('smith bank observation unready');
        }
    };
    const withdraw = async (id: number, amount: number) => {
        const item = state()?.bank.items.find(i => i.id === id);
        const before = held(id);
        if (!item || !(await s.bot.withdrawItem(item, amount, { asNote: false })).success || !await waitUntil(s, () => held(id) === before + amount, { timeoutTicks: 8 })) {
            throw Error('smith withdrawal unobserved ' + id);
        }
    };
    const closeBank = async () => {
        if (!(await s.bot.closeBank()).success || !await waitUntil(s, () => !state()?.bank.isOpen, { timeoutTicks: 5 })) {
            throw Error('smith bank close unobserved');
        }
    };
    const depositMaterial = async (extra: number[] = []) => {
        for (const id of [...material, ...extra]) {
            const item = inv().find(i => i.id === id);
            if (item) await depositObserved(s, item);
        }
    };
    const ifaceOpen = () => !!state()?.interface?.isOpen && state()!.interface.interfaceId === SMITHING_INTERFACE;
    try {
        if (level < r.level) throw Error(`smith refused: Smithing ${level} is below level ${r.level} for product ${r.product}`);
        if (r.quest && !questFlags(s.client)?.some(q => q.name === r.quest && q.state === 'complete')) {
            if (r.quest === 'The Tourist Trap' && allowNativeQuestProbe) nativeQuestAdmission = true;
            else throw Error(`smith refused: ${r.quest} quest completion unobserved`);
        }
        let route: ReturnType<typeof smithStageRoute>;
        try {
            route = smithStageRoute(p0);
        } catch (error) {
            throw Error('smith refused: ' + (error as Error).message);
        }
        entry = route.name;
        await openBank();
        initial = totals();
        await depositMaterial();
        const bars = count(bankRows(), r.bar);
        const need = o.maximum * r.bars + o.reserve;
        if (bars < need) throw Error(`smith refused: ${bars} bars ${r.bar} cannot cover ${o.maximum}x${r.bars} plus reserve ${o.reserve}`);
        if (!(initial.get(HAMMER) ?? 0)) throw Error('smith refused: no hammer in pack, worn or bank');
        if (28 - inv().length - (held(HAMMER) ? 0 : 1) < r.bars) throw Error(`smith refused: pack needs ${r.bars} free slots plus a hammer slot`);
        if ((initial.get(995) ?? 0) < route.fare) throw Error(`smith refused: staging needs ${route.fare} coins for toll`);
        if (route.fare > held(995)) await withdraw(995, route.fare - held(995));
        if (route.points.length || route.toll.length) {
            travel = true;
            await closeBank();
            for (const point of route.toll) await leg(point.x, point.z);
            if (route.fare) {
                const guardNpc = s.sdk.getNearbyNpcs().filter(n => n.id === TOLL_GUARD_EAST).sort((a, b) => a.distance - b.distance)[0];
                if (!guardNpc || !(await s.sdk.sendInteractNpc(guardNpc.index, 1)).success) throw Error('smith east toll guard unavailable');
                const cash = held(995);
                const deadline = s.tick() + 45;
                let answered = false;
                try {
                    while (!near(3267, 3227, 1) || (state()?.player?.worldX ?? 9999) > 3267) {
                        if (over() || s.tick() >= deadline) throw Error('smith toll crossing deadline');
                        const d = s.sdk.getDialog();
                        if (d?.isOpen && !d.isWaiting) {
                            if (d.options.some(v => /yes, ok/i.test(v.text))) {
                                if (!answered) {
                                    if (!(await s.sdk.clickDialogByText(/yes, ok/i)).success) throw Error('smith toll choice refused');
                                    answered = true;
                                }
                            } else if (d.options.length === 0 || (d.options.length === 1 && /continue/i.test(d.options[0]!.text))) {
                                if (!(await s.sdk.sendClickDialog(d.options[0]?.index ?? 0)).success) throw Error('smith toll continue refused');
                            } else {
                                throw Error('smith unexpected toll dialog');
                            }
                        }
                        await waitTicks(s, 1);
                    }
                    if (!await waitUntil(s, () => cash - held(995) === (answered ? route.fare : 0), { timeoutTicks: 5 })) {
                        throw Error('smith toll debit unobserved');
                    }
                } finally {
                    coinsSpent = cash - held(995);
                }
                if (coinsSpent !== (answered ? route.fare : 0)) throw Error('smith toll debit mismatch');
            }
            for (const point of route.points) await leg(point.x, point.z);
            travel = false;
            travelTicks = s.tick() - start;
        }
        if (!near(SMITH_BANK.x, SMITH_BANK.z)) throw Error('smith bank arrival unobserved');
        arrival = true;
        while (made < o.maximum && !over()) {
            if (!await walk(SMITH_BANK.x, SMITH_BANK.z)) throw Error('smith bank route incomplete');
            await openBank();
            await depositMaterial();
            if (!held(HAMMER)) {
                await withdraw(HAMMER, 1);
                hammerWithdrawn = true;
            }
            const batch = planSmithLoad(r, bankRows(), 28 - inv().length, o.maximum - made, o.reserve).planned;
            if (!batch) {
                stop = 'depleted';
                break;
            }
            await withdraw(r.bar, batch * r.bars);
            await closeBank();
            if (!await walk(SMITH_ANVIL.x, SMITH_ANVIL.z)) throw Error('smith anvil route incomplete');
            while (held(r.bar) >= r.bars && made < o.maximum && !over()) {
                const dialog = s.sdk.getDialog();
                if (dialog?.isOpen) {
                    if (dialog.isWaiting) {
                        await waitTicks(s, 1);
                        continue;
                    }
                    const option = dialog.options.find(v => /continue/i.test(v.text));
                    if (!option) throw Error('smith unexpected dialog: ' + (dialog.text ?? ''));
                    if (!(await s.sdk.sendClickDialog(option.index)).success) throw Error('smith dialog click refused');
                    await waitTicks(s, 1);
                    continue;
                }
                attempts++;
                if (!ifaceOpen()) {
                    const anvil = s.sdk.findNearbyLoc(/^anvil$/i);
                    const bar = inv().find(i => i.id === r.bar);
                    if (!anvil || !bar) throw Error('smith anvil/bar missing');
                    const sent = await s.sdk.sendUseItemOnLoc(bar.slot, anvil.x, anvil.z, anvil.id);
                    await waitUntil(s, () => ended || died || ifaceOpen() || !!s.sdk.getDialog()?.isOpen, { timeoutTicks: 12 });
                    if (!ifaceOpen()) {
                        if (!sent.success || ++misses >= 3) throw Error('no smith progress: anvil interface unopened after bounded attempts');
                        continue;
                    }
                }
                const before = inv().map(i => ({ id: i.id, count: i.count }));
                const beforeXp = xp();
                const sent = await s.sdk.sendClickComponentWithOption(r.component, 1, r.slot);
                await waitUntil(s, () => ended || died || held(r.bar) < count(before, r.bar), { timeoutTicks: 8 });
                await waitUntil(s, () => ended || died || (held(r.product) > count(before, r.product) && xp() > beforeXp), { timeoutTicks: 3 });
                if (smithEffect(r, before, inv(), beforeXp, xp())) {
                    made++;
                    misses = 0;
                    nativeQuestAdmission = false;
                } else if (nativeQuestAdmission) {
                    throw Error('native dart admission refused or unconfirmed; no input retry');
                } else if (!sent.success || ++misses >= 3) {
                    throw Error('no smith progress: unchanged anvil after bounded attempts');
                }
            }
        }
        if (made >= o.maximum) stop = 'target';
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        failure = text.startsWith('smith refused') ? text : 'no smith progress: ' + text;
        if (text.startsWith('smith refused')) stop = 'refused';
    } finally {
        try {
            if (!ended && !died) {
                if (s.sdk.getDialog()?.isOpen || ifaceOpen()) {
                    await s.direct({ type: 'closeModal', reason: 'SDK' });
                    if (!await waitUntil(s, () => !s.sdk.getDialog()?.isOpen && !ifaceOpen(), { timeoutTicks: 5 })) {
                        throw Error('smith final modal close unobserved');
                    }
                }
                if (arrival) {
                    if (!await walk(SMITH_BANK.x, SMITH_BANK.z, true)) throw Error('smith final bank route incomplete');
                    await openBank();
                    await depositMaterial(hammerWithdrawn && held(HAMMER) ? [HAMMER] : []);
                }
            }
        } catch (error) {
            failure = failure ? failure + '; final bank: ' + String(error) : 'no smith progress: final bank: ' + String(error);
        }
        off();
    }
    if (travel) travelTicks = s.tick() - start;
    const finalObservation = s.bankObservation?.();
    const final = initial ? totals() : new Map<number, number>();
    const banked = initial && finalObservation ? (final.get(r.product) ?? 0) - (initial.get(r.product) ?? 0) - held(r.product) : null;
    const preserved = [...kit].every(([id, n]) => (id === 995 ? true : held(id) === n)) && inv().every(i => i.id === 995 || kit.has(i.id));
    const allIds = new Set([...(initial?.keys() ?? []), ...final.keys()]);
    const conserved =
        initial && lastBank
            ? [...allIds].every(id => (final.get(id) ?? 0) === (initial!.get(id) ?? 0) + (id === r.product ? made * r.amount : 0) - (id === r.bar ? made * r.bars : 0) - (id === 995 ? coinsSpent : 0))
            : null;
    const hammerRetained = !!initial && (final.get(HAMMER) ?? 0) >= 1 && final.get(HAMMER) === initial.get(HAMMER);
    const reserveMet = finalObservation ? count(finalObservation.items, r.bar) >= o.reserve : null;
    if (!failure && made !== o.maximum) failure = `no smith progress: exact target unmet ${made}/${o.maximum} (${stop})`;
    if (!failure && (banked !== made * r.amount || !conserved || !preserved || !reserveMet || !hammerRetained)) {
        failure = 'no smith progress: final bank/asset/reserve acceptance unproved';
    }
    const ok =
        !failure &&
        !ended &&
        !died &&
        !o.stop?.() &&
        hpMin >= 7 &&
        made === o.maximum &&
        xp() > xp0 &&
        near(SMITH_BANK.x, SMITH_BANK.z) &&
        banked === made * r.amount &&
        preserved &&
        conserved === true &&
        reserveMet === true &&
        hammerRetained &&
        [...material].every(id => held(id) === 0);
    return {
        ok,
        action: 'smith',
        product: r.product,
        bar: r.bar,
        barsPerProduct: r.bars,
        level: r.level,
        target: o.maximum,
        reserve: o.reserve,
        targetMet: made === o.maximum,
        ticks: s.tick() - start,
        entry,
        travelTicks,
        coinsSpent,
        initialCoins: initial?.get(995) ?? 0,
        finalCoins: final.get(995) ?? 0,
        initialBars: initial?.get(r.bar) ?? 0,
        finalBars: final.get(r.bar) ?? 0,
        made,
        banked,
        attempts,
        xpGain: xp() - xp0,
        baseXpPerProduct: (r.bars * r.xpPerBar) / 10,
        levelBefore: level,
        levelAfter: s.sdk.getSkill('Smithing')?.baseLevel ?? level,
        preserved,
        conserved,
        hammerRetained,
        reserveMet,
        hpMin,
        died,
        stop,
        failure,
        nextConsumer: 'Smithing85: price rune dagger inputs (runite ore, coal) and the next Smithing band before more bars',
    };
}

// ---- CLI Entry Points ----

export async function runSmeltBarsCli(
    botName: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
) {
    const CAP = Number(restArgs[0] ?? env.CAP ?? 15000);
    const BAR_TYPE = (restArgs[1] ?? env.BAR_TYPE ?? 'iron').toLowerCase();
    const ACTION = (env.ORDER_ACTION ?? 'smelt').toLowerCase();
    if (!botName) {
        console.error('Usage: bun scripts/aio-skiller.ts <botName> artisan smithing smelt [CAP] [BAR_TYPE]');
        process.exit(1);
    }
    let smith: { product: number; maximum: number; reserve: number } | undefined;
    let smelt: SmeltOrder | undefined;
    if (ACTION === 'smith') {
        const readNum = (k: string) => (env[k] === undefined || env[k] === '' ? NaN : Number(env[k]));
        smith = { product: readNum('PRODUCT_ID'), maximum: readNum('MAX_MAKE'), reserve: readNum('BAR_RESERVE') };
        try {
            if (![CAP, smith.product, smith.maximum, smith.reserve].every(Number.isSafeInteger) || CAP < 1 || smith.maximum < 1 || smith.reserve < 0) {
                throw Error('smith refused: integer CAP>=1, PRODUCT_ID, MAX_MAKE>=1 and BAR_RESERVE>=0 required');
            }
            smithRecipe(smith.product);
        } catch (e) {
            console.error(String(e));
            process.exit(1);
        }
    } else if (ACTION !== 'smelt') {
        console.error('ORDER_ACTION must be smelt or smith');
        process.exit(1);
    } else {
        smelt = {
            bar: BAR_TYPE,
            cap: CAP,
            maximum: Number(env.MAX_MAKE ?? (BAR_TYPE === 'bronze' ? 8 : 28)),
            reserve: Number(env.ORE_RESERVE ?? 1),
            mode: (BAR_TYPE === 'bronze' ? 'exact' : env.ORDER_MODE ?? 'best-effort') as SmeltOrder['mode'],
        };
        try {
            smelt.bonusGear = smeltBonusFromEnv(env);
            smelt.route = smeltRouteFromEnv(env);
            smelt.nearest = env.SMELT_NEAREST === '1';
            validateSmeltOrder(smelt);
        } catch (error) {
            console.error(String(error));
            process.exit(1);
        }
    }
    let stopped = false;
    const s = await openBot(botName, { onStop: async () => { stopped = true; } }).catch(e => finish([], false, `login: ${String(e)}`));
    const owner = actionSessionOwner(s, () => stopped);
    try {
        if (smith) {
            const result = await runSmithBatch(s, { ...smith, cap: CAP, stop: () => stopped });
            console.log('SMITH_RESULT ' + JSON.stringify(result));
            await finishActionSession(owner, result.ok, `mode=smith ${JSON.stringify(result)}`);
            return;
        }
        if (BAR_TYPE === 'bronze' && !smelt?.route && !smelt?.nearest) {
            const result = await runBronze(s, { maximum: Number(env.MAX_MAKE ?? 8), reserve: Number(env.ORE_RESERVE ?? 1), cap: CAP, stop: () => stopped });
            await finishActionSession(owner, result.ok, `mode=bronze ${JSON.stringify(result)}`);
            return;
        }
        if (!smelt) throw Error('smelt order missing');
        const result = await runSmeltBatch(s, { ...smelt, stop: () => stopped });
        console.log('SMELT_RESULT ' + JSON.stringify(result));
        await finishActionSession(owner, result.ok, `mode=${BAR_TYPE} ${JSON.stringify(result)}`);
    } catch (e) {
        await finishActionSession(owner, false, String(e));
    }
}

export async function runCannonballsCli(
    account: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
) {
    if (!account) throw Error('account required');
    const [bars, cap] = restArgs;
    const route = env.CANNON_ROUTE_JSON ? (JSON.parse(env.CANNON_ROUTE_JSON) as SmeltLocalRoute) : undefined;
    const nearest = env.CANNON_NEAREST === '1';
    if (env.CANNON_NEAREST !== undefined && !['0', '1'].includes(env.CANNON_NEAREST)) throw Error('invalid CANNON_NEAREST');
    const order: CannonballOrder = {
        bars: Number(bars ?? 1),
        cap: Number(cap ?? 1200),
        xpRate: Number(env.CANNON_XP_RATE ?? 1),
        reserve: Number(env.CANNON_RESERVE ?? 0),
        route,
        nearest,
    };
    validateSmeltOrder({ bar: 'cannonballs', maximum: order.bars, cap: order.cap, reserve: order.reserve!, xpRate: order.xpRate, mode: 'exact', route, nearest });
    let stopped = false;
    process.once('SIGINT', () => { stopped = true; });
    process.once('SIGTERM', () => { stopped = true; });
    const stop = () => stopped || existsSync('.practice/stop-microbot-cannonballs');
    const s = await openBot(account, { onStop: async () => { stopped = true; } });
    const owner = actionSessionOwner(s, stop);
    try {
        const r = await runCannonballs(s, { ...order, stop });
        console.log('CANNONBALL_RESULT ' + JSON.stringify(r));
        await finishActionSession(owner, r.ok, JSON.stringify(r));
    } catch (e) {
        await finishActionSession(owner, false, String(e));
    }
}

export async function runSmithingCli(
    method: string,
    botName: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
) {
    if (method === 'cannonballs') return runCannonballsCli(botName, restArgs, env);
    if (method === 'smith' || method === 'anvil') return runSmeltBarsCli(botName, restArgs, { ...env, ORDER_ACTION: 'smith' });
    return runSmeltBarsCli(botName, restArgs, env);
}
