import { test, expect } from 'bun:test';
import { assertBoundedRecoveryAssignments, assertBoundedInspectionAssignments, validateBoundedRecovery } from '../src/bounded-recovery';
const scope = { targets: [{ account: 'Rod', attemptId: '1794807014059-0000010716-0000000001', endedAt: 1794807014127 }] };
test('bounded recovery scope rejects duplicate targets and invalid attempt markers', () => {
    expect(() => validateBoundedRecovery(scope)).not.toThrow();
    expect(() => validateBoundedRecovery({ ...scope, targets: [...scope.targets, ...scope.targets] })).toThrow('invalid');
    expect(() => validateBoundedRecovery({ targets: [{ account: '../bad', attemptId: '1794807014059-0000010716-0000000001', endedAt: 1794807014127 }] })).toThrow('invalid');
});
test('a bounded swarm refuses foreign or non-finite assignments before recovery', () => {
    expect(() => assertBoundedRecoveryAssignments(scope, [{ account: 'Rod', enabled: false }])).not.toThrow();
    expect(() => assertBoundedRecoveryAssignments(scope, [{ account: 'Other', enabled: true, script: 'scripts/session-check.ts', repeat: false }])).toThrow('outside');
    expect(() => assertBoundedRecoveryAssignments(scope, [{ account: 'Rod', enabled: true, script: 'old.ts', repeat: false }])).toThrow('outside');
    expect(() => assertBoundedRecoveryAssignments(scope, [{ account: 'Rod', enabled: true, script: 'scripts/session-check.ts', repeat: false }])).not.toThrow();
});
test('inspection accepts only finite selected inspectors and disabled reservations', () => {
    const jobs = [{ account: 'Rod', script: 'scripts/aio-logistics.ts', args: ['inspect'], enabled: true, repeat: false, maxRestarts: 0, standingRetry: false, env: { LOOT_WATCH: '0', RANDOM_EVENTS: '0', REQUIRE_BANK: '1' } }, { account: 'Other', enabled: false, repeat: false, role: 'reserved' }];
    expect(() => assertBoundedInspectionAssignments(['Rod'], jobs)).not.toThrow();
    for (const change of [{ ...jobs[0], repeat: true }, { ...jobs[0], script: 'old.ts' }, { ...jobs[0], autopilot: 'gold' }, { ...jobs[1], enabled: true }])
        expect(() => assertBoundedInspectionAssignments(['Rod'], [change])).toThrow();
});
