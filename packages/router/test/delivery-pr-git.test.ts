import {expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDeliveryPr, type DeliveryPr, type Run} from '../src/delivery-pr';

const FILE = 'scripts/output.ts', URL = 'https://github.com/example/project/pull/1';
const original = Array.from({length: 20}, (_,i) => `line ${i}`).join('\n') + '\n';
const built = original.replace('line 10\n', 'delivered output\n');

function fixture(content: string | null) {
 const root = mkdtempSync(join(tmpdir(), 'delivery-head-git-')), repo = join(root, 'repo'), origin = join(root, 'origin.git');
 mkdirSync(repo);
 const git = (args: string[], cwd = repo) => {
  const out = Bun.spawnSync(['git', ...args], {cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true});
  if(out.exitCode !== 0) throw Error(out.stderr.toString());
  return out.stdout.toString().trim();
 };
 git(['init', '--bare', origin], root);
 git(['init', '--initial-branch=master']);
 git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
 git(['config', 'commit.gpgsign', 'false']); git(['config', 'core.hooksPath', join(root, 'no-hooks')]);
 git(['remote', 'add', 'origin', origin]);
 mkdirSync(join(repo, 'scripts')); writeFileSync(join(repo, FILE), original);
 git(['add', '.']); git(['commit', '-m', 'Base']); git(['push', 'origin', 'master']);
 const base = join(root, 'base'), snapshot = join(root, 'snapshot');
 for(const dir of [base, snapshot]) mkdirSync(join(dir, 'scripts'), {recursive: true});
 writeFileSync(join(base, FILE), original); writeFileSync(join(snapshot, FILE), built);
 const pr: DeliveryPr = {taskId: 'fixture-delivery', capability: 'fixture', branch: 'coordinator/fixture-delivery',
  files: [FILE], snapshot, base, title: 'Fixture delivery', body: 'Fixture', prerequisites: [],
  state: 'pending', createdAt: 1, attempts: 0, nextAt: 1};
 if(content === null) unlinkSync(join(repo, FILE)); else writeFileSync(join(repo, FILE), content);
 git(['add', '-A']); git(['commit', '--allow-empty', '-m', 'Published head']);
 git(['push', 'origin', 'HEAD:refs/heads/' + pr.branch]);
 const head = git(['rev-parse', 'HEAD']);
 writeFileSync(join(repo, '.git', 'FETCH_HEAD'), 'preserved fetch state\n');
 return {root, repo, pr, head};
}

test.each(['branch', 'pull request'] as const)('a reused %s verifies staged output against real Git objects', async kind => {
 for(const content of [built, 'unrelated prefix\n' + built + 'unrelated suffix\n', original, built.replace('delivered output', 'different output'), null]) {
  const f = fixture(content), calls: string[][] = [];
  try {
   const run: Run = async (cmd, cwd) => {
    calls.push(cmd);
    if(cmd[0] === 'gh') return {code: 0, stderr: '', stdout: cmd[2] === 'list'
     ? JSON.stringify(kind === 'branch' ? [] : [{url: URL, headRefOid: f.head, state: 'OPEN', isCrossRepository: false, baseRefName: 'master', headRefName: f.pr.branch}])
     : URL + '\n'};
    const out = Bun.spawnSync(cmd, {cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true});
    return {code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString()};
   };
   const opened = openDeliveryPr(f.pr, f.repo, run, f.root);
   if(content?.includes('delivered output')) await expect(opened).resolves.toEqual({state: 'opened', url: URL});
   else {
    await expect(opened).rejects.toThrow(FILE);
    expect(calls.some(cmd => cmd[0] === 'gh' && cmd[2] === 'create')).toBe(false);
   }
   expect(calls.some(cmd => cmd[0] === 'git' && ['push', 'commit', 'worktree'].includes(cmd[1]!))).toBe(false);
   expect(readFileSync(join(f.repo, '.git', 'FETCH_HEAD'), 'utf8')).toBe('preserved fetch state\n');
  } finally {rmSync(f.root, {recursive: true, force: true});}
 }
}, 30_000);
