import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFleetState } from '../../brain/src/contracts';
import { fleetStateFile, liveRoot, operatorCommandsDir, practiceRoot } from '../../core/src/practice-paths';
import { readAccountOverrides, recordWorkerOutcome, runBrainCycle } from '../src/brain-runtime';

const tempRoots: string[] = [];

function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'brain-runtime-'));
    tempRoots.push(dir);
    mkdirSync(join(dir, 'fleet'), { recursive: true });
    writeFileSync(
        join(dir, 'fleet', 'owners.json'),
        JSON.stringify({ accounts: { AlphaBot: { side: 'local', server: 'rs-sdk-demo.fly.dev' } } }, null, 2),
    );
    writeFileSync(
        join(dir, 'swarm.json'),
        JSON.stringify({ maxBots: 4, minFreeGB: 4, jobs: [] }, null, 2),
    );
    return dir;
}

afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('packages/fleet/src/brain-runtime', () => {
    test('runs an offline Brain cycle and publishes a valid FleetState file', () => {
        const root = makeTempRoot();
        const now = 1_700_000_100_000;
        const result = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now,
            side: 'local',
            maxBots: 4,
            marketQuotes: {},
        });

        expect(validateFleetState(result.fleetState)).toEqual([]);
        expect(existsSync(fleetStateFile(root))).toBe(true);
        const persisted = JSON.parse(readFileSync(fleetStateFile(root), 'utf8'));
        expect(persisted.schemaVersion).toBe(1);
        expect(persisted.side).toBe('local');
        expect(persisted.emittedAt).toBe(now);
        expect(persisted.accounts.alphabot).toBeDefined();
        expect(persisted.accounts.alphabot.name).toBe('AlphaBot');
    });

    test('applies pause/resume, override_account, set_campaign_state, clear_defect, and idempotent replay', () => {
        const root = makeTempRoot();
        const now = 1_700_000_200_000;
        const cmdDir = operatorCommandsDir(root);
        mkdirSync(cmdDir, { recursive: true });

        // First pause AlphaBot via operator command.
        const pauseCmd = {
            schemaVersion: 1,
            id: 'cmd-pause-1',
            issuedAt: now,
            issuedBy: 'operator',
            kind: 'pause_account',
            account: 'AlphaBot',
            reason: 'manual audit',
        };
        writeFileSync(join(cmdDir, '001-pause.json'), JSON.stringify(pauseCmd));

        // Seed a quarantined worker_defect so clear_defect has a real defect to clear.
        recordWorkerOutcome({
            root,
            now: now - 1000,
            raw: {
                activityId: 'skiller:fishing:cage',
                account: 'AlphaBot',
                status: 'fail',
                error: 'boom',
            },
        });

        // Add clear_defect + override_account + set_campaign_state commands.
        writeFileSync(
            join(cmdDir, '002-clear-defect.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-clear-defect-1',
                issuedAt: now + 1,
                issuedBy: 'operator',
                kind: 'clear_defect',
                activityId: 'skiller:fishing:cage',
            }),
        );
        writeFileSync(
            join(cmdDir, '003-override.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-override-1',
                issuedAt: now + 2,
                issuedBy: 'operator',
                kind: 'override_account',
                account: 'AlphaBot',
                activityId: 'skiller:woodcutting:yews',
                role: 'helper',
                expiresAt: now + 3_600_000,
            }),
        );
        writeFileSync(
            join(cmdDir, '004-campaign.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-campaign-1',
                issuedAt: now + 3,
                issuedBy: 'operator',
                kind: 'set_campaign_state',
                campaignId: 'campaign:haggis',
                state: 'paused',
            }),
        );

        const firstRun = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 10,
            side: 'local',
            marketQuotes: {},
        });

        expect(firstRun.fleetState.accounts.alphabot?.lifecycle).toBe('paused_owner');
        expect(firstRun.fleetState.accounts.alphabot?.role).toBe('helper');
        expect(existsSync(join(practiceRoot(root), 'stop-AlphaBot'))).toBe(true);
        expect(existsSync(join(cmdDir, 'applied', 'cmd-pause-1.json'))).toBe(true);
        expect(firstRun.fleetState.quarantinedDefects).toEqual([]);
        const campaignHaggis = firstRun.fleetState.campaigns.find((c) => c.id === 'campaign:haggis');
        expect(campaignHaggis?.state).toBe('paused');
        expect(readAccountOverrides(root, now + 10).alphabot?.activityId).toBe('skiller:woodcutting:yews');

        // Duplicate command replay with same id must be ignored cleanly, while resume_account unpauses.
        writeFileSync(join(cmdDir, '005-dup-pause.json'), JSON.stringify(pauseCmd));
        writeFileSync(
            join(cmdDir, '006-resume.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'cmd-resume-1',
                issuedAt: now + 20,
                issuedBy: 'operator',
                kind: 'resume_account',
                account: 'AlphaBot',
            }),
        );

        const secondRun = runBrainCycle({
            root,
            fleetDir: join(root, 'fleet'),
            now: now + 30,
            side: 'local',
            marketQuotes: {},
        });

        expect(secondRun.appliedCommands.find((c) => c.id === 'cmd-pause-1')?.duplicate).toBe(true);
        expect(existsSync(join(practiceRoot(root), 'stop-AlphaBot'))).toBe(false);
        expect(secondRun.fleetState.accounts.alphabot?.lifecycle).not.toBe('paused_owner');
        expect(existsSync(join(liveRoot(root), 'fleet-state.json'))).toBe(true);
    });
});
