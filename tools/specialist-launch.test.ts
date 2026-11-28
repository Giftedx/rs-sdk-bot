import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { sha } from '../packages/core/src/launch-evidence';
import { missionSignature } from '../packages/core/src/session-admission';
import { assertSpecialistLogin, specialistContext, specialistTokenPath } from '../packages/core/src/specialist-launch';
import { capabilityRevision, workerEntries } from '../packages/core/src/worker-release';
import { START_BUDGET_GB } from '../packages/fleet/src/swarm';
import {
    assertLaunchMemory,
    assertMatchesMasterWorkerRelease,
    companionJobs,
    parseSpecialistLaunchArgs,
    runSpecialistLaunch,
    supplierKitFor,
    type SpawnSyncFn,
} from './specialist-launch';

const MELEE_KIT_LINES = [
    { item: 'Shark', count: 1, itemId: 385 },
    { item: 'Dragon bones', count: 11, itemId: 536 },
    { item: 'Water rune', count: 6, itemId: 555 },
    { item: 'Air rune', count: 6, itemId: 556 },
    { item: 'Earth rune', count: 6, itemId: 557 },
    { item: 'Rope', count: 1, itemId: 954 },
    { item: 'Rune 2h sword', count: 1, itemId: 1319 },
    { item: 'Amulet of strength', count: 1, itemId: 1725 },
    { item: 'Prayer potion(4)', count: 2, itemId: 2434 },
    { item: 'Ring of dueling(8)', count: 1, itemId: 2552 },
];

const REPO_ROOT = resolve(import.meta.dir, '..');
const NOW = 1_800_000_000_000;
let tempRoot = '';

function writeFileRel(root: string, relPath: string, content: string | Buffer): { path: string; sha256: string } {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return { path: relPath.replaceAll('\\', '/'), sha256: sha(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')) };
}

function writeJsonRel(root: string, relPath: string, data: unknown): { path: string; sha256: string } {
    return writeFileRel(root, relPath, JSON.stringify(data, null, 2) + '\n');
}

function setupWorkerTree(root: string, account = 'tipmyshaft'): {
    script: string;
    source: string;
    rehearsalMission: string;
    context: string;
    requirements: Array<{ item: string; count: number; itemId: number }>;
} {
    const script = 'scripts/fletching-specialist.ts';
    const items = [
        { id: 39, name: 'Bronze arrowtips', tradeable: true },
        { id: 40, name: 'Iron arrowtips', tradeable: true },
        { id: 41, name: 'Steel arrowtips', tradeable: true },
        { id: 42, name: 'Mithril arrowtips', tradeable: true },
        { id: 43, name: 'Adamant arrowtips', tradeable: true },
        { id: 44, name: 'Rune arrowtips', tradeable: true },
        { id: 53, name: 'Headless arrow', tradeable: true },
    ];
    writeJsonRel(root, 'package.json', { name: 'test-fixture', version: '1.0.0' });
    writeFileRel(root, 'bun.lock', '{}');
    writeFileRel(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ESNext' } }));
    writeFileRel(root, 'rs-sdk.pin', 'pin-1\n');
    writeJsonRel(root, 'knowledge/items.json', items);
    writeFileRel(root, 'vendor/rs-sdk/sdk/index.ts', 'export const sdk = 1;\n');
    writeFileRel(root, 'vendor/rs-sdk/server/webclient/src/Client.ts', 'export const client = 1;\n');
    writeFileRel(root, 'vendor/rs-sdk/server/vendor/rsmod-pathfinder/rsmod-pathfinder.js', 'export const pf = 1;\n');
    writeFileRel(root, 'scripts/fletching-specialist.ts', 'export const FLETCH = 1;\n');
    writeFileRel(root, 'packages/core/src/bot.ts', 'export const bot = 1;\n');
    writeFileRel(root, 'packages/practice/src/supervise.ts', 'export const supervise = 1;\n');
    writeFileRel(root, 'packages/practice/src/supervise-host.ts', 'export const superviseHost = 1;\n');

    const entries = workerEntries(script, [], root);
    const source = capabilityRevision(entries, root);
    const rehearsalMission = missionSignature({
        account,
        script,
        args: [],
        env: { CAP: '200', COORDINATOR_RUN_ID: '' },
    });
    const requirements = [
        { item: 'Bronze arrowtips', count: 60, itemId: 39 },
        { item: 'Iron arrowtips', count: 90, itemId: 40 },
        { item: 'Steel arrowtips', count: 135, itemId: 41 },
        { item: 'Mithril arrowtips', count: 225, itemId: 42 },
        { item: 'Adamant arrowtips', count: 495, itemId: 43 },
        { item: 'Rune arrowtips', count: 2595, itemId: 44 },
        { item: 'Headless arrow', count: 3600, itemId: 53 },
    ];
    const context = specialistContext(account, source, rehearsalMission, requirements);
    return { script, source, rehearsalMission, context, requirements };
}

function writeFullRehearsalFixture(
    root: string,
    opts: {
        account?: string;
        context: string;
        board?: string;
        planTicks?: number;
        boardTick?: number;
        requirements: Array<{ item: string; count: number; itemId: number }>;
        at?: number;
    },
): string {
    const account = opts.account ?? 'tipmyshaft';
    const board = opts.board ?? 'Fletching';
    const planTicks = opts.planTicks ?? 54;
    const boardTick = opts.boardTick ?? 54;
    const at = opts.at ?? NOW - 60_000;
    const baseDir = `.practice/hosted-rehearse/${account}`;
    const finalSave = writeFileRel(root, `${baseDir}/tipmyshaft-fletching.final.sav`, 'sav-bytes');
    const tradeLedger = writeFileRel(root, `${baseDir}/trades.jsonl`, '');
    const tickRecord = writeFileRel(root, `${baseDir}/tipmyshaft-fletching.ticks.ndjson.gz`, 'gz-bytes');

    const baseStamp = {
        version: 2,
        context: opts.context,
        runId: 'rhtip1',
        actor: 'rhtip1',
        server: '127.0.0.1:8889',
        at,
        startPlaytime: 0,
        endPlaytime: boardTick,
        planTicks,
        ok: true,
        died: false,
        logout: 'logged-out',
        boardTicks: { [board]: boardTick },
        externalSupplies: opts.requirements,
        artifacts: { finalSave, tradeLedger, tickRecord },
    };
    const logRef = writeFileRel(
        root,
        `${baseDir}/tipmyshaft-fletching.log`,
        `START 3094 3106 0\nLOGOUT logged-out\nRESULT ok level=99 ticks=${boardTick}\nREHEARSAL ${JSON.stringify(baseStamp)}\n`,
    );
    const receiptRel = `${baseDir}/tipmyshaft-fletching.receipt.json`;
    writeJsonRel(root, receiptRel, { ...baseStamp, log: logRef });
    return receiptRel;
}

function writeHiscoresFixture(
    root: string,
    opts: {
        account?: string;
        board?: string;
        category?: number;
        leaderTicks?: number;
        takenAt?: number;
    } = {},
): void {
    const account = opts.account ?? 'tipmyshaft';
    const board = opts.board ?? 'Fletching';
    const category = opts.category ?? 10;
    const leaderTicks = opts.leaderTicks ?? 56;
    const takenAt = opts.takenAt ?? NOW - 30_000;
    writeJsonRel(root, '.practice/specialist-launch/hiscores.json', {
        base: 'https://rs-sdk-demo.fly.dev',
        takenAt: new Date(takenAt).toISOString(),
        tickMs: 400,
        boards: [
            {
                board,
                category,
                rows: [{ rank: 1, name: 'nickarrowz', level: 99, ticks: leaderTicks }],
            },
        ],
        profiles: [{ name: account, status: 404, at: takenAt }],
    });
}

function writeHolderStagingInputs(
    root: string,
    holder: string,
    donor: string,
    requirements: Array<{ item: string; count: number; itemId: number }>,
): void {
    const items = requirements.map((r) => ({ id: r.itemId, name: r.item, count: r.count }));
    writeJsonRel(root, `.practice/live/status/${holder}.json`, {
        name: holder,
        server: 'rs-sdk-demo.fly.dev',
        at: NOW - 15_000,
        bankAt: NOW - 20_000,
        bank: items,
        inventory: [],
    });
    writeJsonRel(root, '.practice/specialist-launch/tipmyshaft.delivery.json', {
        ok: true,
        observed: true,
        server: 'rs-sdk-demo.fly.dev',
        from: donor,
        to: holder,
        at: NOW - 30_000,
        before: [],
        after: items.map((i) => ({ id: i.id, count: i.count })),
        items: items.map((i) => ({ id: i.id, count: i.count })),
    });
    writeJsonRel(root, 'fleet/owners.json', {
        accounts: {
            [holder]: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
            [donor]: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
        },
    });
}

beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'specialist-launch-cli-'));
});

afterEach(() => {
    if (tempRoot) {
        rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = '';
    }
});

describe('tools/specialist-launch CLI', () => {
    test('parses arguments and rejects invalid accounts, reserved holders, or bad flags', () => {
        expect(parseSpecialistLaunchArgs(['TipMyShaft', '--holder', 'YewFirst', '--dry-run'])).toEqual({
            account: 'tipmyshaft',
            holder: 'YewFirst',
            dryRun: true,
            launch: false,
            skipHiscores: false,
            receiptPath: undefined,
            bankPath: undefined,
            deliveryPath: undefined,
            runId: undefined,
        });
        expect(parseSpecialistLaunchArgs(['hiltsdeep', '--holder=Quickhandjob', '--launch'])).toMatchObject({
            account: 'hiltsdeep',
            holder: 'Quickhandjob',
            dryRun: false,
            launch: true,
        });
        expect(() => parseSpecialistLaunchArgs([])).toThrow(/usage:/);
        expect(() => parseSpecialistLaunchArgs(['NotASpecialist', '--holder', 'YewFirst'])).toThrow(/unknown specialist/);
        expect(() => parseSpecialistLaunchArgs(['tipmyshaft', '--holder', 'hiltsdeep'])).toThrow(/reserved account/);
        expect(() => parseSpecialistLaunchArgs(['tipmyshaft', '--bogus'])).toThrow(/unknown flag/);
        expect(() => parseSpecialistLaunchArgs(['tipmyshaft', '--run-id', 'BAD_RUN'])).toThrow(/--run-id/);
    });

    test('end-to-end: refreshes hiscores, validates receipt against WORKER_RELEASE & 2% margin, builds staging, writes <acct>.json + .go.json', () => {
        const fx = setupWorkerTree(tempRoot, 'tipmyshaft');
        const receiptRel = writeFullRehearsalFixture(tempRoot, {
            account: 'tipmyshaft',
            context: fx.context,
            board: 'Fletching',
            planTicks: 54,
            boardTick: 54,
            requirements: fx.requirements,
        });
        writeHolderStagingInputs(tempRoot, 'YewFirst', 'Dipstick', fx.requirements);

        let scoutCmd: string[] = [];
        const spawn: SpawnSyncFn = (cmd) => {
            scoutCmd = cmd;
            writeHiscoresFixture(tempRoot, { account: 'tipmyshaft', board: 'Fletching', category: 10, leaderTicks: 56 });
            return { exitCode: 0, stdout: 'saved', stderr: '' };
        };

        // Dry run must NOT invoke scout-cli or write output files.
        writeHiscoresFixture(tempRoot, { account: 'tipmyshaft', board: 'Fletching', category: 10, leaderTicks: 56 });
        const dry = runSpecialistLaunch(['tipmyshaft', '--holder', 'YewFirst', '--dry-run'], {
            root: tempRoot,
            now: NOW,
            spawn,
            log: () => {},
        });
        expect(dry.dryRun).toBe(true);
        expect(dry.launched).toBe(false);
        expect(scoutCmd).toEqual([]);
        expect(existsSync(join(tempRoot, '.practice/specialist-launch/tipmyshaft.json'))).toBe(false);
        expect(existsSync(join(tempRoot, specialistTokenPath('tipmyshaft')))).toBe(false);

        // Full run refreshes hiscores with --fresh-account and writes .staging.json, .json, and .go.json.
        rmSync(join(tempRoot, '.practice/specialist-launch/hiscores.json'));
        const res = runSpecialistLaunch(['tipmyshaft', '--holder', 'YewFirst', '--run-id', 'launch-tip-1'], {
            root: tempRoot,
            now: NOW,
            spawn,
            log: () => {},
        });
        expect(scoutCmd).toEqual([
            'bun',
            'packages/planner/src/scout-cli.ts',
            '--out=.practice/specialist-launch/hiscores.json',
            '--fresh-account=tipmyshaft',
        ]);
        expect(res.ok).toBe(true);
        expect(res.launched).toBe(false);
        expect(res.receiptPath).toBe(receiptRel);
        expect(res.marginRequired).toBe(2);
        expect(res.marginObserved).toBe(2);

        const evidence = JSON.parse(readFileSync(join(tempRoot, '.practice/specialist-launch/tipmyshaft.json'), 'utf8'));
        expect(evidence.version).toBe(1);
        expect(evidence.account).toBe('tipmyshaft');
        expect(evidence.board).toBe('Fletching');
        expect(evidence.context).toBe(fx.context);
        expect(evidence.staging.path).toBe('.practice/specialist-launch/tipmyshaft.staging.json');

        const token = JSON.parse(readFileSync(join(tempRoot, specialistTokenPath('tipmyshaft')), 'utf8'));
        expect(token.version).toBe(2);
        expect(token.account).toBe('tipmyshaft');
        expect(token.runId).toBe('launch-tip-1');
        expect(token.source).toBe(fx.source);
        expect(token.runUntil).toBe(token.at + 86_400_000);
        expect(token.mission).toMatch(/^[a-f0-9]{64}$/);

        // Verify the emitted .go.json authorizes assertSpecialistLogin when swarm.json job is active.
        writeJsonRel(tempRoot, 'swarm.json', {
            maxBots: 17,
            jobs: [
                {
                    account: 'tipmyshaft',
                    script: fx.script,
                    enabled: true,
                    env: { CAP: '200', SUPPLIER: 'YewFirst', FLEET_RUN_ID: 'launch-tip-1' },
                },
            ],
        });
        writeJsonRel(tempRoot, '.practice/live/fleet-runs/launch-tip-1/owner.json', {
            runId: 'launch-tip-1',
            pid: process.pid,
            mission: token.mission,
            source: token.source,
        });
        const ticket = assertSpecialistLogin(
            tempRoot,
            'TipMyShaft',
            NOW + 5_000,
            {
                FLEET_RUN_ID: 'launch-tip-1',
                WORKER_RELEASE: token.source,
                SWARM_MISSION_HASH: token.mission,
            },
            'rs-sdk-demo.fly.dev',
            (pid, marker) => pid === process.pid && marker === 'launch-tip-1',
        );
        expect(ticket).toMatch(/^[a-f0-9]{64}$/);
    });

    test('rejects stale/mismatched WORKER_RELEASE context, insufficient 2% margin, and unbanked holder stock', () => {
        const fx = setupWorkerTree(tempRoot, 'tipmyshaft');
        writeHiscoresFixture(tempRoot, { account: 'tipmyshaft', board: 'Fletching', category: 10, leaderTicks: 56 });
        writeFullRehearsalFixture(tempRoot, {
            account: 'tipmyshaft',
            context: fx.context,
            board: 'Fletching',
            planTicks: 54,
            boardTick: 54,
            requirements: fx.requirements,
        });
        writeHolderStagingInputs(tempRoot, 'YewFirst', 'Dipstick', fx.requirements);

        // Mutating worker source invalidates WORKER_RELEASE context.
        writeFileRel(tempRoot, 'scripts/fletching-specialist.ts', 'export const FLETCH = 2;\n');
        expect(() =>
            runSpecialistLaunch(['tipmyshaft', '--holder', 'YewFirst', '--skip-hiscores'], {
                root: tempRoot,
                now: NOW,
                log: () => {},
            }),
        ).toThrow(/does not match current WORKER_RELEASE/);

        // Restore source, then test failing 2% margin (55t vs #1 56t -> margin 1 < required 2).
        setupWorkerTree(tempRoot, 'tipmyshaft');
        writeFullRehearsalFixture(tempRoot, {
            account: 'tipmyshaft',
            context: fx.context,
            board: 'Fletching',
            planTicks: 55,
            boardTick: 55,
            requirements: fx.requirements,
        });
        expect(() =>
            runSpecialistLaunch(['tipmyshaft', '--holder', 'YewFirst', '--skip-hiscores'], {
                root: tempRoot,
                now: NOW,
                log: () => {},
            }),
        ).toThrow(/fail 2% margin/);

        // Restore 54t receipt, then put items in inventory instead of bank to verify clear bank error.
        writeFullRehearsalFixture(tempRoot, {
            account: 'tipmyshaft',
            context: fx.context,
            board: 'Fletching',
            planTicks: 54,
            boardTick: 54,
            requirements: fx.requirements,
        });
        writeJsonRel(tempRoot, '.practice/live/status/YewFirst.json', {
            name: 'YewFirst',
            server: 'rs-sdk-demo.fly.dev',
            at: NOW - 15_000,
            bankAt: NOW - 20_000,
            bank: [],
            inventory: fx.requirements.map((r) => ({ id: r.itemId, name: r.item, count: r.count })),
        });
        expect(() =>
            runSpecialistLaunch(['tipmyshaft', '--holder', 'YewFirst', '--skip-hiscores'], {
                root: tempRoot,
                now: NOW,
                log: () => {},
            }),
        ).toThrow(/unbanked in inventory/);
    });

    test('--launch writes operator command and swarm.json job, and master diff check blocks dirty worker files', () => {
        const fx = setupWorkerTree(tempRoot, 'tipmyshaft');
        writeHiscoresFixture(tempRoot, { account: 'tipmyshaft', board: 'Fletching', category: 10, leaderTicks: 56 });
        writeFullRehearsalFixture(tempRoot, {
            account: 'tipmyshaft',
            context: fx.context,
            board: 'Fletching',
            planTicks: 54,
            boardTick: 54,
            requirements: fx.requirements,
        });
        writeHolderStagingInputs(tempRoot, 'YewFirst', 'Dipstick', fx.requirements);
        writeJsonRel(tempRoot, 'swarm.json', { maxBots: 17, minFreeGB: 4, jobs: [] });

        const need2 = 4 + 2 * START_BUDGET_GB;
        expect(() =>
            runSpecialistLaunch(
                ['tipmyshaft', '--holder', 'YewFirst', '--skip-hiscores', '--launch', '--run-id', 'launch-tip-2'],
                { root: tempRoot, now: NOW, log: () => {}, freeGB: need2 - 0.1 },
            ),
        ).toThrow(new RegExp(`2 sessions need ${need2.toFixed(1).replace('.', '\\.')} GiB`));
        expect(existsSync(join(tempRoot, specialistTokenPath('tipmyshaft')))).toBe(false);

        const res = runSpecialistLaunch(
            ['tipmyshaft', '--holder', 'YewFirst', '--skip-hiscores', '--launch', '--run-id', 'launch-tip-2'],
            { root: tempRoot, now: NOW, log: () => {}, freeGB: 64 },
        );
        expect(res.launched).toBe(true);
        expect(JSON.parse(readFileSync(join(tempRoot, '.practice/live/fleet-runs/launch-tip-2/owner.json'), 'utf8'))).toMatchObject({
            runId: 'launch-tip-2',
            controller: 'swarm',
        });

        const cmdPath = join(tempRoot, '.practice/live/operator-commands', `launch-tipmyshaft-${NOW}.json`);
        expect(existsSync(cmdPath)).toBe(true);
        const cmd = JSON.parse(readFileSync(cmdPath, 'utf8'));
        expect(cmd.kind).toBe('set_campaign_state');
        expect(cmd.campaignId).toBe('campaign:tipmyshaft');
        expect(cmd.state).toBe('running');

        const swarm = JSON.parse(readFileSync(join(tempRoot, 'swarm.json'), 'utf8'));
        expect(swarm.jobs).toHaveLength(2);
        expect(swarm.jobs[0]).toMatchObject({
            account: 'tipmyshaft',
            script: fx.script,
            enabled: true,
            env: { CAP: '200', SUPPLIER: 'YewFirst', FLEET_RUN_ID: 'launch-tip-2' },
        });
        expect(swarm.jobs[1]).toEqual({
            account: 'YewFirst',
            script: 'scripts/aio-logistics.ts',
            args: ['specialist-supplier', 'tipmyshaft', '--kit=fletching'],
            role: 'specialist-supplier',
            goal: 'Fletching specialist tipmyshaft: hand over the fletching kit',
            enabled: true,
            repeat: false,
            env: { FLEET_RUN_ID: 'launch-tip-2' },
        });

        const launchToken = JSON.parse(readFileSync(join(tempRoot, specialistTokenPath('tipmyshaft')), 'utf8'));

        // The swarm that runs this plan owns the run: no run process, the live swarm owner record and the active job.
        writeJsonRel(tempRoot, '.practice/live/swarm-owner.json', { pid: 4242, plan: join(tempRoot, 'swarm.json'), side: 'local', at: NOW });
        const swarmLogin = (ownerMatches: (pid: number, marker: string) => boolean) =>
            assertSpecialistLogin(
                tempRoot,
                'TipMyShaft',
                NOW + 5_000,
                { FLEET_RUN_ID: 'launch-tip-2', WORKER_RELEASE: launchToken.source, SWARM_MISSION_HASH: launchToken.mission },
                'rs-sdk-demo.fly.dev',
                ownerMatches,
            );
        expect(swarmLogin((pid, marker) => pid === 4242 && marker === 'swarm.ts')).toMatch(/^[a-f0-9]{64}$/);
        expect(() => swarmLogin(() => false)).toThrow(/controller run is no longer active/);
        writeJsonRel(tempRoot, '.practice/live/swarm-owner.json', { pid: 4242, plan: join(tempRoot, 'other.json'), side: 'local', at: NOW });
        expect(() => swarmLogin(() => true)).toThrow(/controller run is no longer active/);
        writeJsonRel(tempRoot, '.practice/live/swarm-owner.json', { pid: 4242, plan: join(tempRoot, 'swarm.json'), side: 'local', at: NOW });
        writeJsonRel(tempRoot, 'swarm.json', { ...swarm, jobs: [{ ...swarm.jobs[0], enabled: false }, swarm.jobs[1]] });
        expect(() => swarmLogin(() => true)).toThrow(/no longer active/);
        writeJsonRel(tempRoot, 'swarm.json', swarm);
        writeJsonRel(tempRoot, '.practice/live/fleet-runs/launch-tip-2/owner.json', {
            runId: 'launch-tip-2',
            pid: process.pid,
            mission: launchToken.mission,
            source: launchToken.source,
        });
        const launchTicket = assertSpecialistLogin(
            tempRoot,
            'TipMyShaft',
            NOW + 5_000,
            {
                FLEET_RUN_ID: 'launch-tip-2',
                WORKER_RELEASE: launchToken.source,
                SWARM_MISSION_HASH: launchToken.mission,
            },
            'rs-sdk-demo.fly.dev',
            (pid, marker) => pid === process.pid && marker === 'launch-tip-2',
        );
        expect(launchTicket).toMatch(/^[a-f0-9]{64}$/);

        // Verify assertMatchesMasterWorkerRelease rejects dirty/off-master worker closure when .git exists.
        mkdirSync(join(tempRoot, '.git'), { recursive: true });
        expect(() =>
            assertMatchesMasterWorkerRelease(tempRoot, ['scripts/fletching-specialist.ts'], (cmdArgs) => {
                if (cmdArgs[1] === 'rev-parse') return { exitCode: 0, stdout: 'abc\n', stderr: '' };
                if (cmdArgs[1] === 'diff') return { exitCode: 0, stdout: 'scripts/fletching-specialist.ts\n', stderr: '' };
                return { exitCode: 0, stdout: '', stderr: '' };
            }),
        ).toThrow(/differs from master/);
        expect(existsSync(join(REPO_ROOT, 'tools', 'specialist-launch.ts'))).toBe(true);
    });

    test('--tanks forwards comma-separated TANKS into swarm.json env and jobMissionHash for assertSpecialistLogin', () => {
        const fx = setupWorkerTree(tempRoot, 'tipmyshaft');
        writeHiscoresFixture(tempRoot, { account: 'tipmyshaft', board: 'Fletching', category: 10, leaderTicks: 56 });
        writeFullRehearsalFixture(tempRoot, {
            account: 'tipmyshaft',
            context: fx.context,
            board: 'Fletching',
            planTicks: 54,
            boardTick: 54,
            requirements: fx.requirements,
        });
        writeHolderStagingInputs(tempRoot, 'YewFirst', 'Dipstick', fx.requirements);
        writeJsonRel(tempRoot, 'swarm.json', { maxBots: 17, minFreeGB: 4, jobs: [] });

        expect(() =>
            runSpecialistLaunch(['tipmyshaft', '--holder', 'YewFirst', '--tanks', 'RockSolid', '--skip-hiscores'], {
                root: tempRoot,
                now: NOW,
                log: () => {},
            }),
        ).toThrow(/reserved account/);

        const res = runSpecialistLaunch(
            ['tipmyshaft', '--holder', 'YewFirst', '--tanks', 'TankOne, TankTwo,TankOne', '--skip-hiscores', '--launch', '--run-id', 'launch-tanks-1'],
            { root: tempRoot, now: NOW, log: () => {}, freeGB: 64 },
        );
        expect(res.tanks).toBe('TankOne,TankTwo');

        const swarm = JSON.parse(readFileSync(join(tempRoot, 'swarm.json'), 'utf8'));
        expect(swarm.jobs.map((j: { account: string; script: string }) => `${j.account}:${j.script}`)).toEqual([
            `tipmyshaft:${fx.script}`,
            'YewFirst:scripts/aio-logistics.ts',
            'TankOne:scripts/pvp-relog-combat.ts',
            'TankTwo:scripts/pvp-relog-combat.ts',
        ]);
        expect(swarm.jobs[3].args).toEqual(['--companion-tank', 'tipmyshaft', '1', '200']);
        expect(swarm.jobs[0].env).toMatchObject({
            CAP: '200',
            SUPPLIER: 'YewFirst',
            TANKS: 'TankOne,TankTwo',
            FLEET_RUN_ID: 'launch-tanks-1',
        });

        const launchToken = JSON.parse(readFileSync(join(tempRoot, specialistTokenPath('tipmyshaft')), 'utf8'));
        writeJsonRel(tempRoot, '.practice/live/fleet-runs/launch-tanks-1/owner.json', {
            runId: 'launch-tanks-1',
            pid: process.pid,
            mission: launchToken.mission,
            source: launchToken.source,
        });
        expect(
            assertSpecialistLogin(
                tempRoot,
                'TipMyShaft',
                NOW + 5_000,
                {
                    FLEET_RUN_ID: 'launch-tanks-1',
                    WORKER_RELEASE: launchToken.source,
                    SWARM_MISSION_HASH: launchToken.mission,
                },
                'rs-sdk-demo.fly.dev',
                (pid, marker) => pid === process.pid && marker === 'launch-tanks-1',
            ),
        ).toMatch(/^[a-f0-9]{64}$/);
    });

    test('--launch refuses a companion that another enabled swarm.json job holds, before any ticket', () => {
        const fx = setupWorkerTree(tempRoot, 'tipmyshaft');
        writeHiscoresFixture(tempRoot, { account: 'tipmyshaft', board: 'Fletching', category: 10, leaderTicks: 56 });
        writeFullRehearsalFixture(tempRoot, { account: 'tipmyshaft', context: fx.context, board: 'Fletching', planTicks: 54, boardTick: 54, requirements: fx.requirements });
        writeHolderStagingInputs(tempRoot, 'YewFirst', 'Dipstick', fx.requirements);
        writeJsonRel(tempRoot, 'swarm.json', { maxBots: 17, minFreeGB: 4, jobs: [{ account: 'YewFirst', script: 'scripts/aio-skiller.ts', enabled: true }] });
        expect(() =>
            runSpecialistLaunch(['tipmyshaft', '--holder', 'YewFirst', '--skip-hiscores', '--launch', '--run-id', 'launch-busy-1'], {
                root: tempRoot,
                now: NOW,
                log: () => {},
                freeGB: 64,
            }),
        ).toThrow(/companion YewFirst already has an enabled swarm\.json job \(scripts\/aio-skiller\.ts\)/);
        expect(existsSync(join(tempRoot, specialistTokenPath('tipmyshaft')))).toBe(false);
        expect(existsSync(join(tempRoot, '.practice/live/fleet-runs/launch-busy-1/owner.json'))).toBe(false);
    });
});

describe('specialist launch companions', () => {
    test('the supplier kit is the kit whose lines equal the rehearsed supplies, the board name first', () => {
        expect(supplierKitFor('Strength', MELEE_KIT_LINES)).toBe('strength');
        expect(supplierKitFor('Defence', MELEE_KIT_LINES)).toBe('defence');
        expect(() => supplierKitFor('Strength', MELEE_KIT_LINES.slice(1))).toThrow(/no supplier kit matches the 9 rehearsed supply lines of Strength/);
    });

    test('the holder hands over the kit and each tank holds one Keep post for the specialist cap', () => {
        const jobs = companionJobs({
            account: 'bigswinger',
            board: 'Strength',
            holder: 'Woodenstaff',
            tanks: 'Shaftsinker,Spitroaster,Unsheathed',
            requirements: MELEE_KIT_LINES,
            runId: 'specialist-bigswinger-1',
            cap: '6000',
        });
        expect(jobs.map((j) => [j.account, j.script, ...j.args])).toEqual([
            ['Woodenstaff', 'scripts/aio-logistics.ts', 'specialist-supplier', 'bigswinger', '--kit=strength'],
            ['Shaftsinker', 'scripts/pvp-relog-combat.ts', '--companion-tank', 'bigswinger', '0', '6000'],
            ['Spitroaster', 'scripts/pvp-relog-combat.ts', '--companion-tank', 'bigswinger', '1', '6000'],
            ['Unsheathed', 'scripts/pvp-relog-combat.ts', '--companion-tank', 'bigswinger', '2', '6000'],
        ]);
        expect(jobs.every((j) => j.enabled && !j.repeat && j.env.FLEET_RUN_ID === 'specialist-bigswinger-1')).toBe(true);
        expect(companionJobs({ account: 'x', board: 'Agility', requirements: [], runId: 'r', cap: '1' })).toEqual([]);
        expect(() => companionJobs({ account: 'x', board: 'Strength', tanks: 'A,B,C,D', requirements: [], runId: 'r', cap: '1' })).toThrow(/at most 3 tanks/);
        expect(() =>
            companionJobs({ account: 'x', board: 'Strength', holder: 'Woodenstaff', tanks: 'woodenstaff', requirements: MELEE_KIT_LINES, runId: 'r', cap: '1' }),
        ).toThrow(/cannot also be a tank/);
    });

    test('a launch needs the memory floor plus the swarm start budget for every session', () => {
        expect(START_BUDGET_GB).toBe(0.25);
        const need5 = 4 + 5 * START_BUDGET_GB;
        const need1 = 5 + START_BUDGET_GB;
        expect(() => assertLaunchMemory(5, need5, 4)).not.toThrow();
        expect(() => assertLaunchMemory(5, need5 - 0.1, 4)).toThrow(
            `host has ${(need5 - 0.1).toFixed(1)} GiB free; 5 sessions need ${need5.toFixed(1)} GiB (floor 4 + ${START_BUDGET_GB} each), so the first-login window would expire`,
        );
        expect(() => assertLaunchMemory(1, need1 - 0.1, 5)).toThrow(new RegExp(`need ${need1.toFixed(1).replace('.', '\\.')} GiB \\(floor 5`));
    });
});
