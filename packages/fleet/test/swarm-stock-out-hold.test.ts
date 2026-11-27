import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveRoot } from '../../core/src/practice-paths';
import {
    brainJobFor,
    brainPlanHold,
    HISCORE_REFRESH_INTERVAL_MS,
    HISCORE_SNAPSHOT_MAX_AGE_MS,
    hiscoreRefreshCommand,
    hiscoreRefreshDue,
    missionSignature,
    startHiscoreRefresh,
    stockOutEnd,
    stockOutHoldMs,
    type EndRecord,
} from '../src/swarm';
import { dispatchAccountPlan } from '../src/worker-dispatch';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const NOW = 1_795_731_251_394;
const offline = () => Infinity;

// The planner recomputes the order quantity each pass (OreElse at ardougnegemstall: 0/10, then 0/9), so each plan
// is a new mission signature.
const geBuy = (quantity: number, itemId = 892) => {
    const plan = {
        account: 'OreElse', demandId: 'd:arrow', scorePerHour: 200,
        steps: [{
            stepKind: 'work' as const, activityId: 'market:ge-buy', demandId: 'd:arrow', workerId: 'market',
            batchUnits: quantity, estimatedTicks: 60, expectedValuePerHour: 200,
            config: { mode: 'ge-buy', itemId, quantity, estimatedCoinCost: 50_000 },
        }],
    };
    return brainJobFor('OreElse', dispatchAccountPlan(plan), plan.steps, 'auto');
};

test('a stock-out end records its venue; a death, a success or another failure records none', () => {
    const run = { marketItemId: 892, marketVenue: 'ge' };
    expect(stockOutEnd(run, 'blocked after 1 runs', 'RESULT fail market buy: out of stock bought=0/10')).toEqual({ marketItemId: 892, marketVenue: 'ge' });
    expect(stockOutEnd(run, 'blocked after 1 runs', 'RESULT fail shop buy boughtTotal=0 stop=stock-wait')).toEqual({ marketItemId: 892, marketVenue: 'ge' });
    expect(stockOutEnd(run, 'blocked after 1 runs', 'RESULT fail Error: no route to 2617,3333,0')).toBeUndefined();
    expect(stockOutEnd(run, 'died after 1 runs', 'RESULT fail out of stock')).toBeUndefined();
    expect(stockOutEnd(run, 'done after 1 runs', 'RESULT ok out of stock after 10')).toBeUndefined();
    expect(stockOutEnd({}, 'blocked after 1 runs', 'RESULT fail out of stock')).toBeUndefined();
});

test('a shop run that exits 0 with nothing bought at stock-wait holds its venue; a partial buy does not', () => {
    // An empty shelf ends the shop run "done" with nothing bought; the next login meets the same empty shelf.
    const run = { marketItemId: 1621, marketVenue: 'shop:gemshop2' };
    const none = 'RESULT ok ticks=72 boughtTotal=0 bankedTotal=0 bankTrips=2 shopTrips=1 coinsLeft=1066 spentTotal=0 maxItems=1 stop=stock-wait targetMet=0 noBuyTicks=5';
    expect(stockOutEnd(run, 'done after 1 runs', none)).toEqual(run);
    expect(stockOutEnd(run, 'done after 1 runs', none.replace('boughtTotal=0', 'boughtTotal=53'))).toBeUndefined();
    expect(stockOutEnd(run, 'done after 1 runs', 'RESULT ok ticks=72 boughtTotal=1 stop=stock-target targetMet=1')).toBeUndefined();
    expect(stockOutEnd(run, 'died after 1 runs', none)).toBeUndefined();
});

test('a market plan at the venue whose stock ended the last run waits for the venue hold, though its quantity changed', () => {
    const first = geBuy(10);
    const ended = new Map<string, EndRecord>([['OreElse', {
        at: NOW, reason: 'blocked after 1 runs', revision: missionSignature(first.job!), marketItemId: 892, marketVenue: 'ge',
    }]]);
    const next = geBuy(9);
    expect(missionSignature(next.job!)).not.toBe(missionSignature(first.job!));
    expect(brainPlanHold(next, ended, offline, undefined, NOW + 60_000)).toMatch(/^ended: ge out of stock for item 892 until /);
    // After the hold, the same venue starts again.
    expect(brainPlanHold(next, ended, offline, undefined, NOW + stockOutHoldMs(892, 'ge'))).toBeUndefined();
    // Another item is not held.
    expect(brainPlanHold(geBuy(9, 1607), ended, offline, undefined, NOW + 60_000)).toBeUndefined();
    // A failed end with no stock-out keeps the earlier rule: a changed job starts.
    const plain = new Map<string, EndRecord>([['oreelse', { at: NOW, reason: 'blocked after 1 runs', revision: missionSignature(first.job!) }]]);
    expect(brainPlanHold(next, plain, offline, undefined, NOW + 60_000)).toBeUndefined();
});

test('an unplaced buy refusal that the next login meets again holds the venue; a baseline or a stop does not', () => {
    const run = { marketItemId: 892, marketVenue: 'ge' };
    const unplaced = (failure: string) => `RESULT fail {"ok":false,"phase":"unplaced","quantity":1,"acquired":0,"escrow":0,"failure":"Error: ${failure}"}`;
    const present = unplaced('owned item already present;allocate it instead of buying duplicate stock');
    expect(stockOutEnd(run, 'blocked after 1 runs', present)).toEqual({ marketItemId: 892, marketVenue: 'ge', marketRefusal: 'present' });
    expect(stockOutEnd(run, 'blocked after 1 runs', unplaced('owned item baseline 2 differs from EXPECTED_OWNED 1'))).toBeUndefined();
    expect(stockOutEnd(run, 'blocked after 1 runs', unplaced('order stopped: the session ended'))).toBeUndefined();
    expect(stockOutEnd(run, 'died after 1 runs', present)).toBeUndefined();

    const first = geBuy(10);
    const ended = new Map<string, EndRecord>([['OreElse', {
        at: NOW, reason: 'blocked after 1 runs', revision: missionSignature(first.job!), ...stockOutEnd(run, 'blocked after 1 runs', present),
    }]]);
    expect(brainPlanHold(geBuy(9), ended, offline, undefined, NOW + 60_000)).toMatch(/^ended: ge refused item 892 \(present\) until /);
    expect(brainPlanHold(geBuy(9), ended, offline, undefined, NOW + stockOutHoldMs(892, 'ge'))).toBeUndefined();
});

test('the hold lasts the venue cooldown, or the shop restock when longer', () => {
    expect(stockOutHoldMs(892, 'ge')).toBe(10 * 60_000);
    // The Ardougne gem stall restocks its sapphires each 15000 ticks (knowledge/shops.json).
    expect(stockOutHoldMs(1607, 'shop:ardougnegemstall')).toBe(15_000 * 400);
});

test('the swarm refreshes the hiscore snapshot at most each 10 min, one child at a time, into the live path', () => {
    expect(hiscoreRefreshDue({ now: NOW, lastAt: 0, running: false })).toBe(true);
    expect(hiscoreRefreshDue({ now: NOW, lastAt: 0, running: true })).toBe(false);
    expect(hiscoreRefreshDue({ now: NOW + HISCORE_REFRESH_INTERVAL_MS - 1, lastAt: NOW, running: false })).toBe(false);
    expect(hiscoreRefreshDue({ now: NOW + HISCORE_REFRESH_INTERVAL_MS, lastAt: NOW, running: false })).toBe(true);

    const root = mkdtempSync(join(tmpdir(), 'hiscore-refresh-'));
    roots.push(root);
    const { cmd, out, log } = hiscoreRefreshCommand(root);
    // packages/brain/src/campaigns.ts loadHiscoreSnapshots reads this path.
    expect(out).toBe(join(liveRoot(root), 'specialist-launch', 'hiscores.json'));
    expect(cmd.slice(1)).toEqual([join(root, 'packages', 'planner', 'src', 'scout-cli.ts'), `--out=${out}`, `--max-age-ms=${HISCORE_SNAPSHOT_MAX_AGE_MS}`]);
    expect(cmd.some(a => a.startsWith('--fresh-account'))).toBe(false);

    const child = new EventEmitter();
    let spawned: { cmd: string; args: readonly string[]; opts: any } | undefined;
    let ends = 0;
    startHiscoreRefresh(root, () => { ends++; }, ((c: string, args: readonly string[], opts: any) => { spawned = { cmd: c, args, opts }; return child; }) as any);
    expect(spawned?.opts).toMatchObject({ cwd: root, windowsHide: true });
    expect(existsSync(log)).toBe(true);
    expect(ends).toBe(0);
    child.emit('exit', 0);
    child.emit('error', new Error('late'));
    expect(ends).toBe(1);
});
