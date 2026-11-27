import { describe, expect, test } from 'bun:test';
import type { AccountState, WorldSnapshot } from '../src/contracts';
import { createActivityCatalog } from '../src/catalog';
import { xpForLevel } from '../src/planner';
import { activityPreflightFromConfig } from '../src/preflight';
import { resolveActivityWorkerRoute } from '../src/worker-routing';
import { STALL_CEILING, STALL_FLOOR, stallTicksForRate, stalled, type TickRow } from '../../core/src/ledger';
import { stopReasonOf } from '../../core/src/bot/rules';

// A job that its worker refuses at the first bank visit (no herb secondary, no arrow inputs) is refused by the brain
// preflight before login, and a bank production run that stalls stops within its rate window.

const NOW = 1_800_000_000_000;
const catalog = createActivityCatalog().list();
const byId = (id: string) => {
    const a = catalog.find((x) => x.id === id);
    if (!a) throw Error(`no catalog activity ${id}`);
    return a;
};
const lv = (n: number) => ({ level: n, xp: xpForLevel(n) });

function account(
    herblore: number,
    bank: Record<number, number>,
    over: { pos?: { x: number; z: number }; inventory?: Record<number, number>; skills?: Record<string, number> } = {},
): { acct: AccountState; world: WorldSnapshot } {
    const extra = Object.fromEntries(Object.entries(over.skills ?? {}).map(([k, v]) => [k, lv(v)]));
    const acct: AccountState = {
        name: 'InputProbe',
        side: 'local',
        role: 'auto',
        protectedClock: false,
        lifecycle: 'idle',
        skills: { Herblore: lv(herblore), Fletching: lv(40), Hitpoints: lv(30), ...extra },
        quests: { druid: 'complete' },
        pos: { ...(over.pos ?? { x: 3092, z: 3243 }), level: 0 },
        inventory: { 995: 5_000, ...over.inventory },
        equipment: {},
        bank: { items: bank, observedAt: NOW - 1000, trusted: true },
    };
    return { acct, world: { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { InputProbe: acct } } };
}

const potions = () => catalog.find((a) => a.config?.skill === 'herblore' && a.config?.method === 'potions')!;
const supplyBlockers = (r: ReturnType<typeof activityPreflightFromConfig>) =>
    r.blockers.flatMap((b) => (b.kind === 'missing_supply' ? [b.itemId] : []));

describe('herblore brew runs need a herb and its secondary before login', () => {
    test('tarromin without limpwurt root is refused for the missing secondary', () => {
        const { acct, world } = account(54, { 203: 20 });
        expect(supplyBlockers(activityPreflightFromConfig(acct, potions(), world))).toEqual([225]);
    });

    test('tarromin with limpwurt root passes', () => {
        const { acct, world } = account(54, { 203: 20, 225: 20 });
        expect(supplyBlockers(activityPreflightFromConfig(acct, potions(), world))).toEqual([]);
    });

    test('guam passes without eyes of newt, which the worker buys', () => {
        const { acct, world } = account(54, { 199: 20, 203: 20 });
        expect(supplyBlockers(activityPreflightFromConfig(acct, potions(), world))).toEqual([]);
    });

    test('no herbs at all is refused', () => {
        const { acct, world } = account(54, {});
        expect(supplyBlockers(activityPreflightFromConfig(acct, potions(), world))).toEqual([199]);
    });
});

describe('the arrows route makes headless arrows and needs its inputs', () => {
    const arrows = () => byId('bank-artisan:fletching-arrows');

    test('the route runs the headless mode, not the rune-tip assembler', () => {
        expect(resolveActivityWorkerRoute(arrows()).env.MODE).toBe('headless');
    });

    test('a bank without shafts and feathers is refused', () => {
        const { acct, world } = account(1, {});
        expect(supplyBlockers(activityPreflightFromConfig(acct, arrows(), world, 150)).sort((a, b) => a - b)).toEqual([52, 314]);
    });

    test('a batch needs the worker reserve of 100 shafts and 100 feathers on top', () => {
        expect(supplyBlockers(activityPreflightFromConfig(account(1, { 52: 150, 314: 150 }).acct, arrows(), account(1, {}).world, 150)).sort((a, b) => a - b)).toEqual([52, 314]);
        const { acct, world } = account(1, { 52: 250, 314: 250 });
        expect(supplyBlockers(activityPreflightFromConfig(acct, arrows(), world, 150))).toEqual([]);
    });
});

describe('a route that starts only in place with a kit in the pack is refused elsewhere', () => {
    const at = (pos: { x: number; z: number }, inventory: Record<number, number>, skills: Record<string, number> = {}) =>
        account(1, { 333: 50, 1941: 200, 954: 20, 583: 1 }, { pos, inventory, skills });
    const kinds = (r: ReturnType<typeof activityPreflightFromConfig>) =>
        r.blockers.map((b) => (b.kind === 'missing_supply' ? `missing_supply:${b.itemId}` : b.kind === 'invalid_config' ? 'start_area' : b.kind));

    test('imps from the Ardougne north bank, or without trout in the pack, are refused', () => {
        const imp = byId('combat:imp');
        const north = at({ x: 2618, z: 3332 }, { 333: 2 });
        expect(kinds(activityPreflightFromConfig(north.acct, imp, north.world))).toContain('start_area');
        const banked = at({ x: 2655, z: 3283 }, {});
        expect(kinds(activityPreflightFromConfig(banked.acct, imp, banked.world))).toContain('missing_supply:333');
        const staged = at({ x: 2655, z: 3283 }, { 333: 2 });
        expect(kinds(activityPreflightFromConfig(staged.acct, imp, staged.world)).filter((k) => k === 'start_area' || k.startsWith('missing_supply'))).toEqual([]);
    });

    test('the trawler away from Port Khazard, below Fishing 15 or without its kit in the pack, is refused', () => {
        const trawler = byId('combat:boss-trawler');
        const ardougne = at({ x: 2618, z: 3332 }, { 1941: 100, 954: 10, 583: 1 }, { Fishing: 15 });
        expect(kinds(activityPreflightFromConfig(ardougne.acct, trawler, ardougne.world))).toContain('start_area');
        const empty = at({ x: 2675, z: 3170 }, {}, { Fishing: 10 });
        const k = kinds(activityPreflightFromConfig(empty.acct, trawler, empty.world));
        expect(k).toEqual(expect.arrayContaining(['skill_level', 'missing_supply:1941', 'missing_supply:954', 'missing_supply:583']));
        const staged = at({ x: 2675, z: 3170 }, { 1941: 100, 954: 10, 583: 1 }, { Fishing: 15 });
        expect(kinds(activityPreflightFromConfig(staged.acct, trawler, staged.world)).filter((x) => x === 'start_area' || x === 'skill_level' || x.startsWith('missing_supply'))).toEqual([]);
    });
});

describe('a stalled bank production run stops within its rate window', () => {
    test('the window comes from the expected rate, between the floor and the session default', () => {
        expect(stallTicksForRate(1.5)).toBe(STALL_FLOOR);
        expect(stallTicksForRate(0.28)).toBe(200);
        expect(stallTicksForRate(0.02)).toBe(STALL_CEILING);
        expect(stallTicksForRate(0)).toBeUndefined();
        expect(stallTicksForRate(undefined)).toBeUndefined();
    });

    test('every bank-artisan route carries a window at most the session default', () => {
        const over: string[] = [];
        for (const a of catalog.filter((x) => x.family === 'bank-artisan')) {
            const stall = Number(resolveActivityWorkerRoute(a).env.STALL_TICKS);
            if (!(stall >= STALL_FLOOR && stall <= STALL_CEILING)) over.push(`${a.id}=${stall}`);
        }
        expect(over).toEqual([]);
        expect(resolveActivityWorkerRoute(byId('bank-artisan:fletching-arrows')).env.STALL_TICKS).toBe(String(STALL_FLOOR));
    });

    test('a run idle at the bank from its first tick stops by window + 50 ticks', () => {
        const window = Number(resolveActivityWorkerRoute(byId('bank-artisan:fletching-arrows')).env.STALL_TICKS);
        const rows: TickRow[] = [];
        let stoppedAt = -1;
        for (let t = 1; t <= 900 && stoppedAt < 0; t++) {
            rows.push({ tick: t, kind: 'idle', at: '2618,3332' } as TickRow);
            const reason = stopReasonOf({ died: false, stopTicks: t, stopFile: () => false, leaseLost: () => false, stalled: () => stalled(rows, window), stallTicks: window });
            if (reason) stoppedAt = t;
        }
        expect(stoppedAt).toBeGreaterThanOrEqual(window);
        expect(stoppedAt).toBeLessThanOrEqual(window + 50);
    });
});
