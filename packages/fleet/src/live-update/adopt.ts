import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Dirty, Git } from './inspect';

type WorkingCopy = { kind: 'missing' } | { kind: 'file'; bytes: Buffer; mode: number } | { kind: 'link'; target: string };
type IndexCopy = { mode: string; object: string } | null;
type AdoptionCopy = { path: string; work: WorkingCopy; index: IndexCopy; indexBytes?: Buffer; ownedWork?: WorkingCopy; ownedIndex?: IndexCopy };

const workingCopy = (file: string): WorkingCopy => {
    try {
        const st = lstatSync(file);
        if (st.isSymbolicLink()) return { kind: 'link', target: readlinkSync(file) };
        if (!st.isFile()) throw Error('adopted path is not a file: ' + file);
        return { kind: 'file', bytes: readFileSync(file), mode: st.mode & 0o7777 };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }; throw error; }
};

const sameWork = (a: WorkingCopy, b: WorkingCopy): boolean => a.kind === b.kind && (a.kind === 'missing'
    || a.kind === 'link' && b.kind === 'link' && a.target === b.target
    || a.kind === 'file' && b.kind === 'file' && a.mode === b.mode && a.bytes.equals(b.bytes));

const sameIndex = (a: IndexCopy, b: IndexCopy): boolean => a?.mode === b?.mode && a?.object === b?.object;

function indexCopy(git: Git, path: string): IndexCopy {
    const result = git('ls-files', '--stage', '-z', '--', path);
    if (!result.ok) throw Error('cannot read index for ' + path + ': ' + result.out.slice(0, 160));
    const rows = result.out.split('\0').filter(Boolean);
    if (!rows.length) return null;
    const entry = rows.length === 1 && /^(\d{6}) ([a-f0-9]+) 0\t/.exec(rows[0]!);
    if (!entry) throw Error('cannot adopt an unmerged index path: ' + path);
    return { mode: entry[1]!, object: entry[2]! };
}

function targetCopy(git: Git, target: string, path: string): IndexCopy {
    const result = git('ls-tree', '-z', target, '--', path);
    if (!result.ok) throw Error('cannot read target for ' + path + ': ' + result.out.slice(0, 160));
    const rows = result.out.split('\0').filter(Boolean);
    if (!rows.length) return null;
    const entry = rows.length === 1 && /^(\d{6}) blob ([a-f0-9]+)\t/.exec(rows[0]!);
    if (!entry) throw Error('cannot adopt a non-file target: ' + path);
    return { mode: entry[1]!, object: entry[2]! };
}

function workAtTarget(copy: WorkingCopy, target: IndexCopy, git: Git, file: string, path: string, fileMode: boolean, symlinks: boolean): boolean {
    if (copy.kind === 'missing') return target === null;
    if (!target) return false;
    if (target.mode === '120000' ? copy.kind !== 'link' && symlinks : copy.kind !== 'file') return false;
    if (copy.kind === 'file' && target.mode !== '120000' && fileMode && ((copy.mode & 0o111) !== 0) !== (target.mode === '100755')) return false;
    if (copy.kind === 'file') {
        const object = git('hash-object', '--path=' + path, '--', path);
        return object.ok && object.out === target.object && sameWork(copy, workingCopy(file));
    }
    const bytes = Buffer.from(copy.target);
    const object = createHash(target.object.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return object === target.object;
}

function indexBytes(root: string, entry: IndexCopy): Buffer | undefined {
    if (!entry) return undefined;
    const result = Bun.spawnSync(['git', 'cat-file', 'blob', entry.object], { cwd: root, windowsHide: true, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw Error('cannot preserve original staged blob: ' + entry.object);
    return Buffer.from(result.stdout);
}

function restoreWorking(file: string, copy: WorkingCopy) {
    if (copy.kind === 'missing') { rmSync(file, { force: true }); return; }
    mkdirSync(dirname(file), { recursive: true });
    if (workingCopy(file).kind !== 'missing') rmSync(file, { force: true });
    if (copy.kind === 'link') symlinkSync(copy.target, file);
    else { writeFileSync(file, copy.bytes); chmodSync(file, copy.mode); }
}

// Adopt only the planned paths, then fast-forward.
export function applyUpdate(git: Git, root: string, target: string, adopt: readonly Dirty[]): { ok: boolean; detail: string } {
    const copies: AdoptionCopy[] = [], touched: AdoptionCopy[] = [];
    const refused = (detail: string) => {
        const failed: string[] = [];
        for (const copy of [...touched].reverse()) {
            try {
                const file = join(root, copy.path), current = workingCopy(file);
                if (!sameWork(current, copy.work)) {
                    if (!copy.ownedWork || !sameWork(current, copy.ownedWork)) throw Error('working copy changed concurrently');
                    restoreWorking(file, copy.work);
                }
            } catch (error) { failed.push(copy.path + ' work: ' + String(error)); }
            try {
                const current = indexCopy(git, copy.path);
                if (!sameIndex(current, copy.index)) {
                    if (copy.ownedIndex === undefined || !sameIndex(current, copy.ownedIndex)) throw Error('index entry changed concurrently');
                    const restore = copy.index ? git('update-index', '--add', '--cacheinfo', `${copy.index.mode},${copy.index.object},${copy.path}`)
                        : git('update-index', '--force-remove', '--', copy.path);
                    if (!restore.ok || !sameIndex(indexCopy(git, copy.path), copy.index)) throw Error(restore.out.slice(0, 160) || 'index restore failed');
                }
            } catch (error) { failed.push(copy.path + ' index: ' + String(error)); }
        }
        if (failed.length) {
            const parent = join(root, '.practice', 'live-update-recovery'); mkdirSync(parent, { recursive: true });
            const directory = mkdtempSync(join(parent, 'adopt-')), file = join(directory, 'originals.json');
            writeFileSync(file, JSON.stringify(copies.map(copy => ({ path: copy.path, index: copy.index && { ...copy.index, base64: copy.indexBytes!.toString('base64') },
                work: copy.work.kind === 'file' ? { kind: 'file', mode: copy.work.mode, base64: copy.work.bytes.toString('base64') } : copy.work })), null, 1));
            return { ok: false, detail: `${detail}; rollback incomplete: ${failed.join('; ')}; originals: ${file}` };
        }
        return { ok: false, detail };
    };
    try {
        const targets = adopt.map(d => targetCopy(git, target, d.path));
        const fileMode = git('config', '--bool', 'core.filemode').out !== 'false', symlinks = git('config', '--bool', 'core.symlinks').out !== 'false';
        for (const d of adopt) { const index = indexCopy(git, d.path); copies.push({ path: d.path, work: workingCopy(join(root, d.path)), index, indexBytes: indexBytes(root, index) }); }
        for (const [n, d] of adopt.entries()) {
            const copy = copies[n]!, file = join(root, d.path);
            if (!sameWork(workingCopy(file), copy.work) || !sameIndex(indexCopy(git, d.path), copy.index))
                return refused(`adopt ${d.path}: source changed concurrently before adoption`);
            touched.push(copy);
            copy.ownedIndex = d.untracked ? copy.index : targets[n]!;
            if (d.untracked) copy.ownedWork = { kind: 'missing' };
            let failure: string | undefined;
            try {
                if (!d.untracked) {
                    const r = targets[n] === null ? git('update-index', '--force-remove', '--', d.path) : git('checkout', target, '--', d.path);
                    if (!r.ok) failure = `adopt ${d.path}: ${r.out.slice(0, 160)}`;
                    else if (targets[n] === null) rmSync(file, { force: true });
                }
                else if (workingCopy(file).kind !== 'missing') rmSync(file, { force: true });
            } finally {
                const current = workingCopy(file);
                if (!d.untracked && workAtTarget(current, targets[n]!, git, file, d.path, fileMode, symlinks)) copy.ownedWork = current;
            }
            if (failure) return refused(failure);
            if (!copy.ownedWork || !sameWork(workingCopy(file), copy.ownedWork) || !sameIndex(indexCopy(git, d.path), copy.ownedIndex!))
                return refused(`adopt ${d.path}: target changed concurrently during adoption`);
        }
        const merge = git('merge', '--ff-only', '--quiet', target);
        return merge.ok ? { ok: true, detail: '' } : refused(`merge refused: ${merge.out.slice(0, 200)}`);
    } catch (error) {
        return refused('update failed: ' + String(error));
    }
}
