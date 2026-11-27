import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutcomeClassifier } from '../../brain/src/outcome-classifier';
import type { RawWorkerExitInput } from '../../brain/src/index';
import { liveStatusDir } from '../../core/src/practice-paths';
import { drainWorkerOutcomeInbox, queueWorkerOutcome, tradeNoRouteOutcome, workerOutcomeInboxDir } from '../src/brain-runtime';
import { queueTradeNoRoute } from '../src/fleet-agent';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

// KnightRider, shut in the West Ardougne Mourner HQ (.practice/fleet-agent.log: the trade to the Ardougne hub failed).
const MOURNER_HQ = { x: 2546, z: 3325, level: 0 };
const ARDOUGNE_HUB = { x: 2617, z: 3333, level: 0 };
const NO_ROUTE = 'RESULT fail fleet-trade xfer-1795730863043-1 failed 0/1: Error: route to 2617, 3333: precondition no route to 2617,3333,0';
const START = 1_795_730_863_043;

function rootWithStatus(pos: { x: number; z: number; level: number } | null, at = START + 1_000): string {
    const root = mkdtempSync(join(tmpdir(), 'trade-no-route-'));
    roots.push(root);
    mkdirSync(liveStatusDir(root), { recursive: true });
    writeFileSync(join(liveStatusDir(root), 'KnightRider.json'), JSON.stringify({
        name: 'KnightRider', server: 'rs-sdk-demo.fly.dev', at, started: START, ...(pos ? { pos } : {}),
    }));
    return root;
}

const outcome = (root: string, resultLine = NO_ROUTE) =>
    tradeNoRouteOutcome({ root, account: 'KnightRider', resultLine, startedAt: START, finishedAt: START + 2_000, logPath: 'fleet-agent.log' });

test('a failed trade with no route from where the account stands gives a logistics:trade outcome with its position', () => {
    const raw = outcome(rootWithStatus(MOURNER_HQ));
    expect(raw).toMatchObject({ activityId: 'logistics:trade', account: 'KnightRider', status: 'fail', pos: MOURNER_HQ, detail: NO_ROUTE, skipRateSample: true });
});

test('a trade failure that is not a no-route, or one with no position of this run, gives no outcome', () => {
    // Any other failure as a worker defect would hold logistics:trade for every account.
    expect(outcome(rootWithStatus(MOURNER_HQ), 'RESULT fail fleet-trade xfer-1 failed 0/1: Error: partner did not come')).toBeNull();
    expect(outcome(rootWithStatus(null))).toBeNull();
    // A status file from before the trade started is not where this search started.
    expect(outcome(rootWithStatus(MOURNER_HQ, START - 60_000))).toBeNull();
});

test('the fleet agent queues the no-route trade, and the swarm drain records a no-route fact, not a defect', () => {
    const root = rootWithStatus(MOURNER_HQ);
    expect(queueTradeNoRoute({ base: root, account: 'KnightRider', result: 'RESULT ok fleet-trade xfer-1 done', startedAt: START, logPath: 'x' })).toBeNull();
    expect(queueTradeNoRoute({ base: root, account: 'KnightRider', result: undefined, startedAt: START, logPath: 'x' })).toBeNull();
    const file = queueTradeNoRoute({ base: root, account: 'KnightRider', result: NO_ROUTE, startedAt: START, now: START + 2_000, logPath: 'x' });
    expect(file).not.toBeNull();
    expect(existsSync(file!)).toBe(true);

    const classifier = new OutcomeClassifier({ root, persist: false });
    const results: ReturnType<OutcomeClassifier['classifyAndApplyRaw']>[] = [];
    expect(drainWorkerOutcomeInbox(root, raw => { results.push(classifier.classifyAndApplyRaw(raw, { now: START + 3_000 })); })).toBe(1);
    expect(results[0]!.noRoute?.to).toEqual(ARDOUGNE_HUB);
    expect(results[0]!.defect).toBeUndefined();
    // Each queued outcome applies once.
    expect(readdirSync(workerOutcomeInboxDir(root))).toEqual([]);
    expect(drainWorkerOutcomeInbox(root, () => { throw Error('applied twice'); })).toBe(0);
});

test('the drain removes a bad record and a record whose apply throws, so no file repeats', () => {
    const root = rootWithStatus(MOURNER_HQ);
    const dir = workerOutcomeInboxDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1-bad.json'), '{not json');
    writeFileSync(join(dir, '2-empty.json'), JSON.stringify({ account: 'KnightRider' }));
    const raw: RawWorkerExitInput = { activityId: 'logistics:trade', account: 'KnightRider', status: 'fail', detail: NO_ROUTE, pos: MOURNER_HQ };
    const queued = queueWorkerOutcome(root, raw, START);
    expect(JSON.parse(readFileSync(queued, 'utf8'))).toEqual(raw);
    expect(drainWorkerOutcomeInbox(root, () => { throw Error('classifier failed'); })).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
});
