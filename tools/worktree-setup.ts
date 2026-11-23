// Makes a new git worktree of this repository ready for tests, the type check and the local gate, as the CI setup
// steps do (.github/workflows/ci.yml): the SDK submodule, the SDK patch and the installs. It also carries the owner's
// hook switch (disableAllHooks) of the main checkout's local settings into the worktree.
// Usage: bun tools/worktree-setup.ts [--bench] [--reset-vendor] [--check]
//   --bench         also install the engine packages, which a practice bench needs, and copy the route caches of the
//                   main checkout that this worktree does not hold
//   --reset-vendor  when vendor/rs-sdk has the patch of a different commit, restore its tracked files and apply the
//                   patch of this commit. Without the flag the script reports the mismatch and changes nothing there.
//   --check         print what each step would do and change nothing
// Each step is skipped when its result is there already, so the script is safe to run again.
import {resolve} from 'node:path';
import {runWorktreeSetup} from '../packages/core/src/worktree-setup';

export * from '../packages/core/src/worktree-setup';

if(import.meta.main)process.exit(runWorktreeSetup(process.argv.slice(2),resolve(import.meta.dir,'..')));
