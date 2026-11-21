import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginSessionAttempt } from '../packages/core/src/session-lifecycle';
import { auditFleetHealth, classifyLocation, HEALTH_STOP_PREFIX, remediateFleetHealth } from './fleet-health';
import { recoverSessionToHub } from './recover-trapped';

const dirs: string[] = [];
function tempWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-health-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.practice', 'status'), { recursive: true });
    mkdirSync(join(dir, '.practice', 'claims'), { recursive: true });
    mkdirSync(join(dir, 'fleet'), { recursive: true });
    return dir;
}

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeLogoutProof(root: string, account: string, server: string, confirmed = true) {
    const attempt = beginSessionAttempt({ account, server }, { root, now: () => 100 });
    if (confirmed) attempt.record('ended', 'logged-out');
}

test('classifyLocation identifies ship decks, sealed ship holds, dungeons, Paterdomus, upstairs and mainland', () => {
    const hubAreas = new Set([21]);
    const labels = {
        area: (_l: number, x: number, z: number) => (x === 2681 && z === 3267 ? 999 : x === 2800 && z === 3000 ? 1610 : 21),
        areas: 3,
        tiles: 3,
        zones: { size: 0, keys: function* () {} },
        cells: new Uint16Array(0),
        zoneKeys: new Int32Array(0),
    };

    expect(classifyLocation({ worldX: 2678, worldZ: 3268, level: 1 }, { labels, hubAreas }).kind).toBe('ship_deck');
    expect(classifyLocation({ worldX: 2681, worldZ: 3267, level: 0 }, { labels, hubAreas }).kind).toBe('ship_hold');
    expect(classifyLocation({ worldX: 2686, worldZ: 3268, level: 2 }, { labels, hubAreas }).kind).toBe('upstairs_stranded');
    expect(classifyLocation({ worldX: 3408, worldZ: 3485, level: 0 }, { labels, hubAreas }).kind).toBe('paterdomus_trapped');
    expect(classifyLocation({ worldX: 3095, worldZ: 9830, level: 0 }, { labels, hubAreas }).kind).toBe('edgeville_dungeon');
    expect(classifyLocation({ worldX: 3035, worldZ: 9803, level: 0 }, { labels, hubAreas }).kind).toBe('dwarven_mine');
    expect(classifyLocation({ worldX: 3077, worldZ: 9774, level: 0 }, { labels, hubAreas }).kind).toBe('dwarven_mine');
    const entrana = classifyLocation({ worldX: 2861, worldZ: 9737, level: 0 }, { labels, hubAreas });
    expect(entrana.kind).toBe('entrana_dungeon');
    expect(entrana.autoFixable).toBe(false);
    expect(classifyLocation({ worldX: 3201, worldZ: 9550, level: 0 }, { labels, hubAreas }).kind).toBe('zanaris');
    expect(classifyLocation({ worldX: 2800, worldZ: 3000, level: 0 }, { labels, hubAreas }).kind).toBe('off_hub_area');
    expect(classifyLocation({ worldX: 3185, worldZ: 3436, level: 0 }, { labels, hubAreas }).kind).toBe('ok');
});

test('auditFleetHealth catches trapped/looping accounts while guarding owner holds, reserved accounts and healed loops', () => {
    const root = tempWorkspace();
    const prac = join(root, '.practice');
    const now = 1_000_000;
    const owners = new Map([
        ['haggis', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['bravehardon', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['unsheathed', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['tossthecaber', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['gooddruid', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['healed', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
    ]);

    writeFileSync(join(prac, 'stop-BraveHardon'), 'owner stop: upstairs level=1 crash loop');
    writeFileSync(join(prac, 'stop-Healed'), `${HEALTH_STOP_PREFIX} prior loop\n`);
    writeLogoutProof(root, 'Unsheathed', 'rs-sdk-demo.fly.dev', true);
    writeLogoutProof(root, 'Healed', 'rs-sdk-demo.fly.dev', true);

    const statusRows = [
        { name: 'Haggis', server: 'rs-sdk-demo.fly.dev', pos: { x: 2686, z: 3268, level: 1 }, at: now - 1000 },
        { name: 'BraveHardon', server: 'rs-sdk-demo.fly.dev', pos: { x: 2686, z: 3268, level: 1 }, at: now - 1000, result: 'RESULT fail Error: combat travel aborted: level !== 0' },
        { name: 'Unsheathed', server: 'rs-sdk-demo.fly.dev', pos: { x: 3095, z: 9830, level: 0 }, at: now - 1000, result: 'RESULT fail Error: combat bank return unavailable' },
        { name: 'TossTheCaber', server: 'rs-sdk-demo.fly.dev', pos: { x: 2618, z: 3332, level: 0 }, at: now - 1000, result: 'RESULT ok fleet-trade' },
        { name: 'GoodDruid', server: 'rs-sdk-demo.fly.dev', pos: { x: 3115, z: 9928, level: 0 }, at: now - 1000, result: 'RESULT ok' },
        { name: 'Healed', server: 'rs-sdk-demo.fly.dev', pos: { x: 3185, z: 3436, level: 0 }, at: now - 1000, result: 'RESULT ok' },
    ];

    const swarmPlan = {
        jobs: [
            { name: 'u', account: 'Unsheathed', script: 'scripts/gather-combat.ts', args: ['Unsheathed', '6000', 'taverley_druid'], enabled: true },
            { name: 'g', account: 'GoodDruid', script: 'scripts/gather-combat.ts', args: ['GoodDruid', '6000', 'druid'], enabled: true },
        ],
    };

    const results = [
        // Older fast-fail loop for TossTheCaber, followed by an ok run after it was rescued.
        { started: now - 90_000, at: now - 85_000, name: 'TossTheCaber', goal: 'giant', ok: false, text: 'fail Error: combat travel' },
        { started: now - 80_000, at: now - 75_000, name: 'TossTheCaber', goal: 'giant', ok: false, text: 'fail Error: combat travel' },
        { started: now - 70_000, at: now - 65_000, name: 'TossTheCaber', goal: 'giant', ok: false, text: 'fail Error: combat travel' },
        { started: now - 30_000, at: now - 10_000, name: 'TossTheCaber', goal: 'fleet-trade', ok: true, text: 'ok' },
    ];

    const deaths = {
        PickpockDick: { at: now - 50_000, reason: 'blocked after 1 runs' },
        StuckWorker: { at: now - 500, reason: 'blocked after 1 runs' },
    };
    const extraOwners = new Map([...owners, ['pickpockdick', { side: 'local', server: 'rs-sdk-demo.fly.dev' }], ['stuckworker', { side: 'local', server: 'rs-sdk-demo.fly.dev' }]]);
    const extraStatuses = [
        ...statusRows,
        { name: 'PickpockDick', server: 'rs-sdk-demo.fly.dev', pos: { x: 3232, z: 3244, level: 0 }, at: now - 1000, result: 'RESULT ok' },
        { name: 'StuckWorker', server: 'rs-sdk-demo.fly.dev', pos: { x: 3185, z: 3436, level: 0 }, at: now - 1000 },
    ];
    const extraPlan = { jobs: [...swarmPlan.jobs, { name: 'sw', account: 'StuckWorker', script: 'scripts/train-prayer.ts', enabled: true }] };

    const audit = auditFleetHealth({ root, side: 'local', now, owners: extraOwners, statusRows: extraStatuses, swarmPlan: extraPlan, results, deaths });
    const byName = new Map(audit.accounts.map(a => [a.account, a]));

    expect(byName.get('Haggis')?.fixAction).toBe('manual_hold');
    expect(byName.get('Haggis')?.blockedBy).toBe('reserved account');
    expect(byName.get('BraveHardon')?.ownerStop).toBe(true);
    expect(byName.get('BraveHardon')?.fixAction).toBe('manual_hold');
    expect(byName.get('Unsheathed')?.location.kind).toBe('edgeville_dungeon');
    expect(byName.get('Unsheathed')?.fixAction).toBe('recover_location');
    expect(byName.get('TossTheCaber')?.issues).toEqual([]);
    expect(byName.get('GoodDruid')?.issues).toEqual([]);
    expect(byName.get('Healed')?.fixAction).toBe('clear_stale_health_stop');
    expect(byName.get('PickpockDick')?.issues).toEqual([]);
    expect(byName.get('StuckWorker')?.fixAction).toBe('manual_hold');
    expect(byName.get('StuckWorker')?.blockedBy).toBe('ended: blocked after 1 runs');
});

test('remediateFleetHealth recovers stranded accounts, clears stale health stops, protects owner stops and enforces cooldown and RAM floor', async () => {
    const root = tempWorkspace();
    const prac = join(root, '.practice');
    const now = 5_000_000;
    const owners = new Map([
        ['bravehardon', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['unsheathed', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['looper', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['healed', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
    ]);

    writeFileSync(join(prac, 'stop-BraveHardon'), 'owner stop: manual hold');
    writeFileSync(join(prac, 'stop-Unsheathed'), `${HEALTH_STOP_PREFIX} edgeville trap\n`);
    writeFileSync(join(prac, 'stop-Healed'), `${HEALTH_STOP_PREFIX} old error\n`);
    writeLogoutProof(root, 'Unsheathed', 'rs-sdk-demo.fly.dev', true);
    writeLogoutProof(root, 'Healed', 'rs-sdk-demo.fly.dev', true);

    const statusRows = [
        { name: 'BraveHardon', server: 'rs-sdk-demo.fly.dev', pos: { x: 2686, z: 3268, level: 1 }, at: now - 1000 },
        { name: 'Unsheathed', server: 'rs-sdk-demo.fly.dev', pos: { x: 3095, z: 9830, level: 0 }, at: now - 1000, result: 'RESULT fail Error: combat bank return unavailable' },
        { name: 'Looper', server: 'rs-sdk-demo.fly.dev', pos: { x: 3185, z: 3436, level: 0 }, at: now - 1000 },
        { name: 'Healed', server: 'rs-sdk-demo.fly.dev', pos: { x: 3185, z: 3436, level: 0 }, at: now - 1000, result: 'RESULT ok' },
    ];
    const results = [
        { started: now - 30_000, at: now - 25_000, name: 'Looper', goal: 'taverley_druid', ok: false, text: 'fail walk rejected' },
        { started: now - 20_000, at: now - 15_000, name: 'Looper', goal: 'taverley_druid', ok: false, text: 'fail walk rejected' },
        { started: now - 10_000, at: now - 5_000, name: 'Looper', goal: 'taverley_druid', ok: false, text: 'fail walk rejected' },
    ];

    const lowRamAudit = auditFleetHealth({ root, side: 'local', now, owners, statusRows, results, swarmPlan: { jobs: [] } });
    const lowRamActions = await remediateFleetHealth(lowRamAudit, {
        now,
        freeMemGB: () => 4.2,
        runRecovery: async () => { throw Error('should not run below memory floor'); },
    });
    expect(lowRamActions.some(a => a.account === 'Unsheathed' && a.action === 'skipped' && /low free RAM/.test(a.detail))).toBe(true);
    expect(lowRamActions.some(a => a.account === 'Looper' && a.action === 'paused')).toBe(true);
    expect(lowRamActions.some(a => a.account === 'Healed' && a.action === 'cleared_health_stop')).toBe(true);
    expect(readFileSync(join(prac, 'stop-BraveHardon'), 'utf8')).toBe('owner stop: manual hold');
    expect(existsSync(join(prac, 'stop-Healed'))).toBe(false);
    expect(readFileSync(join(prac, 'stop-Looper'), 'utf8').startsWith(HEALTH_STOP_PREFIX)).toBe(true);

    const recovered: string[] = [];
    const okAudit = auditFleetHealth({ root, side: 'local', now: now + 1000, owners, statusRows, results, swarmPlan: { jobs: [] } });
    const actions = await remediateFleetHealth(okAudit, {
        now: now + 1000,
        freeMemGB: () => 12.0,
        runRecovery: async (account) => { recovered.push(account); return { ok: true, detail: 'RESULT ok at=3185,3436,0' }; },
    });
    expect(recovered).toEqual(['Unsheathed']);
    expect(actions.some(a => a.account === 'Unsheathed' && a.action === 'recovered')).toBe(true);
    expect(existsSync(join(prac, 'stop-Unsheathed'))).toBe(false);

    // Cooldown prevents repeating recovery immediately on next pass.
    const repeatActions = await remediateFleetHealth(okAudit, {
        now: now + 2000,
        freeMemGB: () => 12.0,
        runRecovery: async () => { throw Error('should respect cooldown'); },
    });
    expect(repeatActions.some(a => a.account === 'Unsheathed' && a.action === 'skipped' && /cooldown/.test(a.detail))).toBe(true);
});

test('recoverSessionToHub climbs out of a sealed ship hold, disembarks the deck gangplank and settles on ground', async () => {
    let player = { worldX: 2681, worldZ: 3267, level: 0, lifeId: 1, respawnCount: 0, isDead: false };
    let tick = 0;
    const listeners = new Set<() => void>();
    const timer = setInterval(() => { tick++; for (const cb of [...listeners]) cb(); }, 2);
    const ladder = { id: 274, name: "Ship's ladder", x: 2682, z: 3267, distance: 1, optionsWithIndex: [{ text: 'Climb-up', opIndex: 1 }] };
    const exitPlank = { id: 2086, name: 'Gangplank', x: 2683, z: 3269, distance: 2, optionsWithIndex: [{ text: 'Cross', opIndex: 1 }] };
    const s: any = {
        tick: () => tick,
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        sdk: {
            getState: () => ({ player, nearbyLocs: player.level === 0 && player.worldX === 2681 ? [ladder] : [exitPlank] }),
            getDialog: () => ({ isOpen: false, options: [] }),
            sendClickDialog: async () => {},
            findNearbyLoc: (re: RegExp) => (re.test('Gangplank') && player.level === 1 ? exitPlank : null),
        },
        bot: {
            interactLoc: async (loc: any) => {
                if (loc.id === 274) player = { ...player, worldX: 2682, worldZ: 3268, level: 1 };
                if (loc.id === 2086) player = { ...player, worldX: 2619, worldZ: 3332, level: 0 };
                return { success: true };
            },
        },
    };
    try {
        const res = await recoverSessionToHub(s, { capTicks: 100 });
        expect(res.ok).toBe(true);
        expect(res.kind).toBe('ship_hold');
        expect(res.to).toBe('2619,3332,0');
    } finally {
        clearInterval(timer);
    }
});
