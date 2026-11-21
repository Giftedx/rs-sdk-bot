// Usage: bun scripts/fail-loops.ts [hours]   (prints one line for each loop of the main checkout's results)
import { join, resolve } from 'node:path';
import { failLoops, loopLines, readRecentResults } from '../packages/core/src/fail-loops';

export * from '../packages/core/src/fail-loops';

if (import.meta.main) {
    const hours = Number(process.argv[2] ?? 2);
    // The main checkout runs the fleet and holds the results: the first worktree of `git worktree list`, as in now.ts.
    const here = resolve(import.meta.dir, '..');
    const list = Bun.spawnSync(['git', '-C', here, 'worktree', 'list', '--porcelain'], { stdout: 'pipe', stderr: 'ignore', windowsHide: true }).stdout.toString();
    const main = resolve(/^worktree (.+)$/m.exec(list)?.[1] ?? here);
    const file = process.env.RESULTS_FILE ?? join(main, '.practice', 'results.jsonl');
    console.log(`results ${file}`);
    const loops = failLoops(readRecentResults(file, 40_000_000), Date.now(), { windowMs: hours * 3600_000 });
    if (!loops.length) console.log(`no fast-fail loops in ${hours} h`);
    for (const line of loopLines(loops, 50)) console.log(line);
}
