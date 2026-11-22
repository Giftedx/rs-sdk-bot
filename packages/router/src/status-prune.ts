// Compatibility shim forwarding status pruning to packages/fleet/src/status-prune.ts.
import { resolve } from 'node:path';
import { pruneStatus } from '../../fleet/src/status-prune';

export { STATUS_ROW_MAX_AGE_MS, prunable, keptAccounts, pruneStatus } from '../../fleet/src/status-prune';

if (import.meta.main) {
    const apply = process.argv.includes('--apply');
    const r = pruneStatus(resolve(import.meta.dir, '../../..'), { dry: !apply });
    console.log(`RESULT ok status-prune ${apply ? 'moved' : 'would move'} ${r.moved.length} rows, kept ${r.kept}${r.failed ? `, ${r.failed} not moved` : ''}`);
}
