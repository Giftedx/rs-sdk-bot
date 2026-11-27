import { expect, test } from 'bun:test';
import { WALLED_REGIONS } from '../src/snapshot';
import { walledRecoveryReason } from '../src/worker-routing';
import { walledExitRecovery } from '../../workers/src/quest/modes';

// The brain names the walled exit in the recovery reason, and the quest worker runs the exit alone on that reason.
test('the quest worker reads the brain walled recovery reason as an exit-only run', () => {
    const region = WALLED_REGIONS.find((r) => r.id === 'west-ardougne')!;
    expect(walledExitRecovery(walledRecoveryReason(region), region.openedByQuest)).toBe(true);
    expect(walledExitRecovery(undefined, 'biohazard')).toBe(false);
    expect(walledExitRecovery('stranded off-hub or non-ground plane', 'biohazard')).toBe(false);
    expect(walledExitRecovery(walledRecoveryReason(region), 'cook')).toBe(false);
});
