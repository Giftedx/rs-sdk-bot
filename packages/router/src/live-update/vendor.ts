import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeTrees } from '../../../core/src/worker-release';
import { patchNewFiles, patchState, type PatchState } from '../../../../scripts/worktree-setup';
import { gitIn } from './inspect';

export const SDK = 'vendor/rs-sdk', SDK_PATCH = 'patches/rs-sdk-working.patch';

// The part of a patch for each file that it changes, by the file's path in the SDK.
export function patchSections(text: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const part of text.replace(/\r\n/g, '\n').trimEnd().split(/^(?=diff --git )/m)) {
        const m = /^diff --git a\/(\S+) b\//.exec(part);
        if (m) out.set(m[1]!, part.trimEnd());
    }
    return out;
}

// The SDK files whose part differs between two versions of the patch: changed, added to the patch or left out of it.
export function patchChangedFiles(before: string, after: string): string[] {
    const a = patchSections(before), b = patchSections(after);
    return [...new Set([...a.keys(), ...b.keys()])].filter(file => a.get(file) !== b.get(file)).sort();
}

// Those of them that are in a worker release tree, as paths in this repository.
export function vendorReleaseFiles(before: string, after: string, trees: readonly string[] = runtimeTrees): string[] {
    return patchChangedFiles(before, after).map(file => `${SDK}/${file}`).filter(path => trees.some(tree => path.startsWith(tree + '/')));
}

// What vendor/rs-sdk holds against the patch file of this checkout: `applied`, `clean` (no patch) or `other` (edits
// that are not this patch). Null on a checkout without the SDK or without the patch file.
export function vendorState(root: string): PatchState | null {
    const vendor = join(root, SDK), patch = join(root, SDK_PATCH);
    if (!existsSync(join(vendor, 'package.json')) || !existsSync(patch)) return null;
    const git = gitIn(vendor);
    return patchState(git('apply', '--check', '-R', patch).ok, git('apply', '--check', patch).ok);
}

// The exact form of vendorState, for a restore: `applied` or `clean` only when the tracked files of vendor/rs-sdk, and
// the files that the patch creates, are the pinned commit with this patch or with no patch, and nothing else.
// `git apply --check -R` passes also when a different tracked file has an edit, and a restore would discard that edit.
// It writes each state as a git tree through an index file of its own, so the index of vendor/rs-sdk does not change.
export function vendorExact(root: string): PatchState | null {
    const vendor = join(root, SDK), patch = join(root, SDK_PATCH);
    if (!existsSync(join(vendor, 'package.json'))) return null;
    const text = existsSync(patch) ? readFileSync(patch, 'utf8') : '', dir = mkdtempSync(join(tmpdir(), 'live-update-index-'));
    try {
        const tree = (index: string, steps: string[][]): string | null => {
            const run = (...args: string[]) => { const p = Bun.spawnSync(['git', '-c', 'core.quotepath=off', ...args], { cwd: vendor, env: { ...process.env, GIT_INDEX_FILE: join(dir, index) }, windowsHide: true, stdout: 'pipe', stderr: 'pipe' }); return { ok: p.exitCode === 0, out: p.stdout.toString().trim() }; };
            for (const step of [['read-tree', 'HEAD'], ...steps]) if (!run(...step).ok) return null;
            const written = run('write-tree');
            return written.ok ? written.out : null;
        };
        const created = patchNewFiles(text).filter(file => existsSync(join(vendor, file)));
        const actual = tree('actual', [['add', '-u'], ...(created.length ? [['add', '-f', '--', ...created]] : [])]);
        if (!actual) return 'other';
        if (text && actual === tree('patched', [['apply', '--cached', patch]])) return 'applied';
        return actual === tree('pinned', []) ? 'clean' : 'other';
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

// The files that `newPatch` creates and `oldPatch` does not, and that are in vendor/rs-sdk now. Each one is a local
// file that the SDK does not track. The new patch cannot go on without the loss of it, so the folder stays.
export function patchCollisions(root: string, oldPatch: string, newPatch: string): string[] {
    const had = new Set(patchNewFiles(oldPatch));
    return patchNewFiles(newPatch).filter(file => !had.has(file) && existsSync(join(root, SDK, file)));
}

// Puts the patch file of this checkout on vendor/rs-sdk: takes `oldPatch` off and applies the patch.
// It touches only the files of `oldPatch`: it restores each file that the old patch changed, and removes each file
// that the old patch created. No other file changes, so a local file that is staged in vendor/rs-sdk stays.
// Call it only when vendorExact gave `applied` for `oldPatch`, or `clean`: the restore discards an edit in those files.
// It removes no file that only the new patch creates. Such a file makes the apply fail, and the file stays.
export function resetVendor(root: string, oldPatch: string): { ok: boolean; detail: string } {
    const vendor = join(root, SDK), patch = join(root, SDK_PATCH), git = gitIn(vendor);
    const created = new Set(patchNewFiles(oldPatch)), changed = [...patchSections(oldPatch).keys()].filter(file => !created.has(file));
    // From the pinned commit, not from the index: a patch that is staged in vendor/rs-sdk would come back from the
    // index. The index itself does not change.
    const restore = changed.length ? git('restore', '--source=HEAD', '--worktree', '--', ...changed) : { ok: true, out: '' };
    if (!restore.ok) return { ok: false, detail: `restore of ${SDK}: ${restore.out.slice(0, 160)}` };
    const newPatch = existsSync(patch) ? readFileSync(patch, 'utf8') : '';
    for (const file of created) rmSync(join(vendor, file), { force: true });
    if (!newPatch) return { ok: true, detail: '' };
    const apply = git('apply', patch);
    return apply.ok ? { ok: true, detail: '' } : { ok: false, detail: `apply of ${SDK_PATCH}: ${apply.out.slice(0, 160)}` };
}
