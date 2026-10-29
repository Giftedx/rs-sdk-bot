import { copyFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readPracticeSave, waitPracticeSave } from '../../../scripts/measure/fleet-player-save';
import { practiceDir, rsSdkRoot } from './paths';

export interface SaveSnapshot {
    bot: string;
    sourcePath: string;
    path: string;
    sha256: string;
    save: ReturnType<typeof readPracticeSave>;
}
export interface OutcomeEvidence {
    ok: boolean;
    detail: string;
    before?: Omit<SaveSnapshot, 'save'>;
    after?: Omit<SaveSnapshot, 'save'>;
}
export type PracticeOutcome = 'rcair';
const inventoryCount = (s: SaveSnapshot, id: number) => (s.save.inventories[93] ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const receipt = ({ save: _save, ...evidence }: SaveSnapshot) => evidence;

export function verifyInitialOutcome(kind: PracticeOutcome, bot: string, before: SaveSnapshot): OutcomeEvidence {
    const fail = (detail: string): OutcomeEvidence => ({ ok: false, detail, before: receipt(before) });
    if (kind !== 'rcair') return fail('unsupported outcome');
    if (before.bot !== bot || basename(before.sourcePath).toLowerCase() !== `${bot.toLowerCase()}.sav`) return fail('save account identity mismatch');
    const start = before.save.position;
    if (start.x !== 2841 || start.z !== 4830 || start.level !== 0 || inventoryCount(before, 1436) !== 27 || inventoryCount(before, 1438) !== 1 || inventoryCount(before, 556) !== 0 || before.save.skills[20]?.rawExperience !== 0 || before.save.skills[20]?.level !== 1) return fail('rcair initial save does not match fresh altar fixture');
    return { ok: true, detail: 'fresh rcair fixture verified', before: receipt(before) };
}

// Source pattern: runebench shared/check_gold.ts independently reads the save.
// Use our existing CRC/version-aware reader; that donor's older varp parser does
// not match this engine. Account provenance is the exact generated filename:
// the binary format contains no username field.
export function verifyOutcome(kind: PracticeOutcome, bot: string, before: SaveSnapshot, after: SaveSnapshot): OutcomeEvidence {
    const evidence = { before: receipt(before), after: receipt(after) };
    const fail = (detail: string): OutcomeEvidence => ({ ok: false, detail, ...evidence });
    if (kind !== 'rcair') return fail('unsupported outcome');
    if (![before, after].every(s => s.bot === bot && basename(s.sourcePath).toLowerCase() === `${bot.toLowerCase()}.sav`)) return fail('save account identity mismatch');
    if (resolve(before.sourcePath) !== resolve(after.sourcePath)) return fail('save source changed');
    const initial = verifyInitialOutcome(kind, bot, before);
    if (!initial.ok) return fail(initial.detail);
    if (before.sha256 === after.sha256) return fail('save has no independent state change');
    // Pinned runecraft_air: one air rune per essence at level 1.
    // The multiplier is chosen before the batch, so a mid-batch level-up does
    // not double its output. Bank-only output cannot satisfy the pack goal.
    // Player.addXp multiplies XP by the server's configured rate (practice
    // defaults to 25). The task promises an XP rise, not an unbound 1x rate.
    const rawXp = after.save.skills[20]?.rawExperience;
    if (inventoryCount(after, 1436) !== 0 || inventoryCount(after, 1438) !== 1 || inventoryCount(after, 556) !== 27 || !Number.isSafeInteger(rawXp) || rawXp! <= before.save.skills[20]!.rawExperience) return fail('rcair requires 27 essence consumed, 27 air runes in pack and positive Runecraft XP');
    return { ok: true, detail: `independent save:27 essence consumed, 27 air runes in pack, ${rawXp! / 10} Runecraft XP`, ...evidence };
}

export async function snapshotPracticeSave(bot: string, phase: 'before' | 'after', ready?: (snapshot: SaveSnapshot) => boolean): Promise<SaveSnapshot> {
    if (!/^[a-z0-9]{1,12}$/i.test(bot)) throw new Error('invalid generated proof account');
    const sourcePath = join(rsSdkRoot(), 'server/engine/data/players/main', `${bot.toLowerCase()}.sav`);
    const dir = join(practiceDir(), 'proofs/inprocess', bot);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${phase}.sav`);
    let latest: SaveSnapshot | undefined;
    const capture = () => {
        // An engine save may be publishing while copied. Keep the prior valid
        // artifact intact until its replacement passes the reader's CRC gate.
        const pending = `${path}.pending`;
        copyFileSync(sourcePath, pending);
        const save = readPracticeSave(pending);
        const sha256 = createHash('sha256').update(readFileSync(pending)).digest('hex');
        renameSync(pending, path);
        latest = { bot, sourcePath, path, sha256, save };
        return save;
    };
    if (phase === 'after' && ready) {
        await waitPracticeSave(sourcePath, () => !!latest && ready(latest), { read: capture, timeoutMs: 6000, intervalMs: 250 });
    } else capture();
    if (!latest) throw new Error('independent proof save unavailable');
    return latest;
}
