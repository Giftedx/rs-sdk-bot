// Log one owned account in, confirm it is in the game, and log it out. No gameplay.
// It follows an authenticated session recovery, so the account ends with a confirmed producer logout.
// `--verify` checks the delivery's native recovery proof instead (the capability's consumer gate).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { openBot, finish } from '../packages/core/src/bot';
import { waitUntil } from '../packages/core/src/ticks';
import { RECOVERY_SCRIPT, verifyNativeRecoveryProof } from '../packages/core/src/session-recovery-permit';
import { launchRevision } from '../packages/core/src/worker-release';

export const CAPABILITY = 'session-recovery-only';

export function sessionCheckDetail(state: any): string {
    const p = state?.player;
    if (state?.inGame !== true || !p || !(p.hp > 0)) throw new Error('session check: account not in game');
    return `sessionChecked=1 hp=${p.hp} x=${p.worldX} z=${p.worldZ} level=${p.level}`;
}

export function verifyDelivery(directory: string, root = resolve(import.meta.dir, '..')): true {
    const proof = JSON.parse(readFileSync(join(directory, 'proof.json'), 'utf8'));
    if (proof.capability !== CAPABILITY) throw new Error('session check: proof names another capability');
    const runnerSha256 = createHash('sha256').update(readFileSync(join(root, RECOVERY_SCRIPT))).digest('hex');
    verifyNativeRecoveryProof(proof, directory, { runtimeRevision: launchRevision(root), runnerSha256 });
    return true;
}

if (import.meta.main) {
    if (process.argv[2] === '--verify') {
        try {
            if (!process.env.DELIVERY_DIR) throw new Error('run through the delivery harness');
            verifyDelivery(resolve(process.env.DELIVERY_DIR));
            console.log('SESSION_CHECK_VERIFIED');
            process.exit(0);
        } catch (e) { console.error(String(e)); process.exit(1); }
    }
    const s = await openBot(process.argv[2]!);
    try {
        await waitUntil(s, st => st?.inGame && !!st.player && st.player.hp > 0, { timeoutTicks: 100, idleMs: 10000 });
        await finish([s], true, sessionCheckDetail(s.sdk.getState()));
    } catch (e) { await finish([s], false, String(e)); }
}
