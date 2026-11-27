// Prints one line for each recent fast-fail loop recorded in the main checkout results file, then one line for each error
// that ended short runs of 3 or more accounts in 24 h (crossAccountFaults). It reads the file and changes nothing.
// Usage: bun tools/fail-loops.ts [hours]
import { join, resolve } from 'node:path';
import { crossAccountFaults, crossAccountLines, failLoops, loopLines, readRecentResults } from '../packages/core/src/fail-loops';

export * from '../packages/core/src/fail-loops';

if (import.meta.main) {
    const hours = Number(process.argv[2] ?? 2);
    // The main checkout runs the fleet and holds the results: the first worktree of `git worktree list`, as in now.ts.
    const here = resolve(import.meta.dir, '..');
    const list = Bun.spawnSync(['git', '-C', here, 'worktree', 'list', '--porcelain'], { stdout: 'pipe', stderr: 'ignore', windowsHide: true }).stdout.toString();
    const main = resolve(/^worktree (.+)$/m.exec(list)?.[1] ?? here);
    const file = process.env.RESULTS_FILE ?? join(main, '.practice', 'results.jsonl');
    console.log(`results ${file}`);
    const rows = readRecentResults(file, 40_000_000), now = Date.now();
    const loops = failLoops(rows, now, { windowMs: hours * 3600_000 });
    if (!loops.length) console.log(`no fast-fail loops in ${hours} h`);
    for (const line of loopLines(loops, 50)) console.log(line);
    const cross = crossAccountFaults(rows, now);
    console.log(cross.length ? `cross-account faults in 24 h (${cross.length}):` : 'no cross-account faults in 24 h');
    for (const line of crossAccountLines(cross, 20)) console.log(`  ${line}`);
}
