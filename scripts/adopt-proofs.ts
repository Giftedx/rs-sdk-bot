// Adopts the method proofs that a hosted runner made for this commit (.github/workflows/progression-practice.yml,
// job `qualification`), so the PC runs no practice engine for them.
// Usage: bun scripts/adopt-proofs.ts [--run <run id>] [--commit <sha>] [--check]
// Without --run it takes the newest successful `Progression practice` run of the commit (default: HEAD).
// The artifact is evidence, not authority. The registrar (packages/router/src/progression-qualification.ts) checks it
// against this checkout before it writes one byte of the index:
//   - the delivery source and the worker release of the artifact equal the ones this checkout computes now
//     (packages/core/src/release-digest.ts gives one release to a Windows and a Linux checkout of one commit);
//   - each declared file has the artifact's SHA-256 here, each check passed, and each check log is the artifact's;
//   - the raw saves, the worker log and the frozen entry give the proof's own result again (verifyProof).
// A proof of another commit, of edited source or with changed files is refused and the index keeps its bytes.
// The command never starts a worker and never touches a stop file. `--check` prints the run it would take.
import {existsSync, mkdirSync, readdirSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';

export const PROOF_WORKFLOW = 'Progression practice';
export type RunRow = {databaseId: number; headSha: string; conclusion: string | null; status: string};
// The newest finished successful run of the commit, or null.
export function pickRun(runs: readonly RunRow[], sha: string): RunRow | null {
    return [...runs].filter(r => r.headSha === sha && r.status === 'completed' && r.conclusion === 'success').sort((a, b) => b.databaseId - a.databaseId)[0] ?? null;
}
// The delivery folder inside a downloaded artifact root: the one folder under deliveries that holds a report.
export function deliveryFolder(practiceRoot: string): string | null {
    const deliveries = join(practiceRoot, 'deliveries');
    if (!existsSync(deliveries)) return null;
    const found = readdirSync(deliveries).filter(name => existsSync(join(deliveries, name, 'report.json')) && existsSync(join(deliveries, name, 'ranged-adaptive-proof.json')));
    return found.length === 1 ? join(deliveries, found[0]!) : null;
}

if (import.meta.main) {
    const root = resolve(import.meta.dir, '..'), argv = process.argv.slice(2);
    const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
    const check = argv.includes('--check');
    const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd, {cwd: root, stdout: 'pipe', stderr: 'pipe', windowsHide: true}); return {ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim()}; };
    const sha = value('--commit') ?? sh(['git', 'rev-parse', 'HEAD']).out;
    let run = value('--run');
    if (!run) {
        const list = sh(['gh', 'run', 'list', '--workflow', PROOF_WORKFLOW, '--commit', sha, '-L', '20', '--json', 'databaseId,headSha,conclusion,status']);
        const picked = list.ok ? pickRun(JSON.parse(list.out || '[]'), sha) : null;
        if (!picked) { console.error(`adopt-proofs: no successful "${PROOF_WORKFLOW}" run for commit ${sha.slice(0, 10)}. Start one: gh workflow run "${PROOF_WORKFLOW}" --ref <branch>`); process.exit(2); }
        run = String(picked.databaseId);
    }
    console.log(`adopt-proofs: run ${run}, commit ${sha.slice(0, 10)}`);
    if (check) process.exit(0);
    // The artifact holds the runner's .practice folders, so its root is a practice root.
    const practiceRoot = join(root, '.practice', 'hosted-proofs', run);
    rmSync(practiceRoot, {recursive: true, force: true}); mkdirSync(practiceRoot, {recursive: true});
    const got = sh(['gh', 'run', 'download', run, '-n', `progression-qualification-${sha}`, '-D', practiceRoot]);
    if (!got.ok) { console.error(`adopt-proofs: the artifact progression-qualification-${sha} of run ${run} was not read: ${got.err.split('\n').at(-1)}`); process.exit(2); }
    const directory = deliveryFolder(practiceRoot);
    if (!directory) { console.error(`adopt-proofs: run ${run} holds no one complete Ranged delivery`); process.exit(2); }
    const {registerProgressionArtifact} = await import('../packages/router/src/progression-qualification-cli');
    try {
        const result = await registerProgressionArtifact(directory, practiceRoot);
        console.log(`adopt-proofs: ${result.registered ? 'registered' : 'already in the index'}: ${JSON.stringify({methods: (result as any).methods, source: (result as any).source, index: result.index})}`);
    } catch (error) {
        console.error(`adopt-proofs: refused, the index is unchanged: ${String((error as Error)?.message ?? error)}`);
        process.exit(1);
    }
}
