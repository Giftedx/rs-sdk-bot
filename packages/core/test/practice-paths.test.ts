import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    findStopFile,
    fleetStateFile,
    hasSimStopFile,
    hasStopFile,
    lifecycleRootForRead,
    lifecycleRootForServer,
    listStopEntries,
    liveFleetDataDir,
    liveLifecycleRoot,
    liveRoot,
    liveStatusArchiveDir,
    liveStatusDir,
    liveStopFile,
    operatorCommandsDir,
    readStopFile,
    resolveBotEnvPath,
    resolveFleetDataDir,
    simBenchDir,
    simBotsDir,
    simCacheDir,
    simLifecycleRoot,
    simLogsDir,
    simProofsDir,
    simRehearseDir,
    simRoot,
    simStatusDir,
    simStopFile,
    statusDirForServer,
    statusReadDirs,
    stopFilePaths,
} from '../src/practice-paths';
import { startStatus } from '../src/status';
import { beginSessionAttempt, readLogoutProof } from '../src/session-lifecycle';

test('live vs sim paths partition .practice/live and .practice/sim cleanly', () => {
    const base = join(tmpdir(), 'practice-paths-layout');
    expect(liveRoot(base)).toBe(join(base, '.practice', 'live'));
    expect(liveStatusDir(base)).toBe(join(base, '.practice', 'live', 'status'));
    expect(liveStatusArchiveDir(base)).toBe(join(base, '.practice', 'live', 'status-archive'));
    expect(liveLifecycleRoot(base)).toBe(join(base, '.practice', 'live', 'session-lifecycle'));
    expect(liveFleetDataDir(base)).toBe(join(base, '.practice', 'live', 'fleet-data'));
    expect(fleetStateFile(base)).toBe(join(base, '.practice', 'live', 'fleet-state.json'));
    expect(operatorCommandsDir(base)).toBe(join(base, '.practice', 'live', 'operator-commands'));
    expect(liveStopFile('coordinator', base)).toBe(join(base, '.practice', 'live', 'stop-coordinator'));

    expect(simRoot(base)).toBe(join(base, '.practice', 'sim'));
    expect(simStatusDir(base)).toBe(join(base, '.practice', 'sim', 'status'));
    expect(simLifecycleRoot(base)).toBe(join(base, '.practice', 'sim', 'session-lifecycle'));
    expect(simBotsDir(base)).toBe(join(base, '.practice', 'sim', 'bots'));
    expect(simBenchDir(base)).toBe(join(base, '.practice', 'sim', 'aio-bench'));
    expect(simProofsDir(base)).toBe(join(base, '.practice', 'sim', 'proofs'));
    expect(simRehearseDir(base)).toBe(join(base, '.practice', 'sim', 'rehearse'));
    expect(simLogsDir(base)).toBe(join(base, '.practice', 'sim', 'logs'));
    expect(simCacheDir(base)).toBe(join(base, '.practice', 'sim', 'cache'));
    expect(simStopFile('flcow', base)).toBe(join(base, '.practice', 'sim', 'stops', 'stop-flcow'));

    expect(statusDirForServer('localhost:8888', base)).toBe(simStatusDir(base));
    expect(statusDirForServer('127.0.0.1:8910', base)).toBe(simStatusDir(base));
    expect(statusDirForServer('rs-sdk-demo.fly.dev', base)).toBe(liveStatusDir(base));
    expect(lifecycleRootForServer('localhost:8888', base)).toBe(simLifecycleRoot(base));
    expect(lifecycleRootForServer('rs-sdk-demo.fly.dev', base)).toBe(liveLifecycleRoot(base));
    expect(statusReadDirs(base)).toEqual([liveStatusDir(base), join(base, '.practice', 'status')]);
});

test('backwards-compatible owner stop lookup honors .practice/stop-* and .practice/live/stop-* while isolating sim stops', () => {
    const root = mkdtempSync(join(tmpdir(), 'practice-stops-'));
    try {
        mkdirSync(join(root, '.practice', 'live'), { recursive: true });
        mkdirSync(join(root, '.practice', 'sim', 'stops'), { recursive: true });

        for (const flag of [
            'coordinator', 'swarm', 'autopilot', 'dashboard-publish',
            'pk-squad', 'runite-radar', 'BraveHardon', 'UnloadMe',
        ]) {
            writeFileSync(join(root, '.practice', `stop-${flag}`), `owner pause ${flag}`);
            expect(hasStopFile(flag, root)).toBe(true);
            expect(readStopFile(flag, root)).toBe(`owner pause ${flag}`);
        }

        // .practice/live/stop-* wins if present alongside legacy root .practice/stop-*
        writeFileSync(liveStopFile('swarm', root), 'live owner pause');
        expect(findStopFile('swarm', root)).toBe(liveStopFile('swarm', root));
        expect(readStopFile('swarm', root)).toBe('live owner pause');
        expect(hasStopFile('bravehardon', root)).toBe(true);
        expect(hasStopFile('BraveHardon', root)).toBe(true);

        // Sim stop files remain strictly isolated from live stop lookups, and live stops do not stop sim.
        writeFileSync(simStopFile('flsimonly', root), 'sim stop marker');
        expect(hasSimStopFile('flsimonly', root)).toBe(true);
        expect(hasStopFile('flsimonly', root)).toBe(false);
        writeFileSync(liveStopFile('liveonly', root), 'owner live only');
        expect(hasStopFile('liveonly', root)).toBe(true);
        expect(hasSimStopFile('liveonly', root)).toBe(false);

        const entries = listStopEntries(root);
        expect(entries.some(e => e.location === 'sim' && e.flag === 'flsimonly')).toBe(true);
        expect(entries.some(e => e.location === 'legacy' && e.flag === 'coordinator')).toBe(true);
        expect(entries.some(e => e.location === 'live' && e.flag === 'swarm')).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('resolveFleetDataDir, lifecycleRootForRead, and resolveBotEnvPath prefer live/sim layout with safe fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'practice-fallback-'));
    try {
        mkdirSync(join(root, '.practice', 'fleet-data'), { recursive: true });
        expect(resolveFleetDataDir(root)).toBe(join(root, '.practice', 'fleet-data'));
        mkdirSync(liveFleetDataDir(root), { recursive: true });
        expect(resolveFleetDataDir(root)).toBe(liveFleetDataDir(root));

        mkdirSync(join(root, '.practice', 'session-lifecycle'), { recursive: true });
        expect(lifecycleRootForRead('rs-sdk-demo.fly.dev', root)).toBe(join(root, '.practice', 'session-lifecycle'));
        mkdirSync(liveLifecycleRoot(root), { recursive: true });
        expect(lifecycleRootForRead('rs-sdk-demo.fly.dev', root)).toBe(liveLifecycleRoot(root));
        expect(lifecycleRootForRead('localhost:8888', root)).toBe(simLifecycleRoot(root));

        mkdirSync(join(root, 'vendor', 'rs-sdk', 'bots', 'Hero'), { recursive: true });
        writeFileSync(join(root, 'vendor', 'rs-sdk', 'bots', 'Hero', 'bot.env'), 'SERVER=rs-sdk-demo.fly.dev\n');
        expect(resolveBotEnvPath('Hero', root)).toBe(join(root, 'vendor', 'rs-sdk', 'bots', 'Hero', 'bot.env'));
        mkdirSync(join(simBotsDir(root), 'Hero'), { recursive: true });
        writeFileSync(join(simBotsDir(root), 'Hero', 'bot.env'), 'SERVER=localhost:8888\n');
        expect(resolveBotEnvPath('Hero', root)).toBe(join(simBotsDir(root), 'Hero', 'bot.env'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('local startStatus and session-lifecycle write strictly to .practice/sim/ and never .practice/live/', () => {
    const name = `SimIso${process.pid}`;
    const simStatus = join(simStatusDir(), `${name}.json`);
    const simLife = join(simLifecycleRoot(), 'practice', 'localhost_8888', name.toLowerCase());
    const liveStatus = join(liveStatusDir(), `${name}.json`);
    const attempt = beginSessionAttempt({ account: name, server: 'localhost:8888' });
    const session: any = {
        name,
        lifecycle: attempt,
        sdk: { getState: () => ({ skills: [], inventory: [] }) },
        tick: () => 1,
        onTick: () => () => {},
    };
    const status = startStatus(session, 'localhost:8888');
    try {
        expect(existsSync(simStatus)).toBe(true);
        expect(existsSync(liveStatus)).toBe(false);
        expect(existsSync(simLife)).toBe(true);
        attempt.record('ended', 'logged-out');
        expect(readLogoutProof(name, 'localhost:8888').state).toBe('confirmed');
    } finally {
        status.stop();
        rmSync(simStatus, { force: true });
        rmSync(`${simStatus}.tmp`, { force: true });
        rmSync(simLife, { recursive: true, force: true });
    }
});
