import { appendFileSync, constants, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { localFile, MAX_LOGOUT_DRAIN_TICKS, sha, type Binding } from '../../../core/src/launch-evidence';
import { specialistContext } from '../../../core/src/specialist-launch';
import { recordRoot, scriptKey } from '../../../core/src/tick-record';
import { capabilityRevision, workerEntries } from '../../../core/src/worker-release';
import { confirmLivingSession, observedSupplies, scoredClock, successfulWorkerLog } from '../specialist-rehearsal';
import { REHEARSE_ROOT, type ScoredRun, type Segment } from './types';

function bind(file: string): Binding {
    const path = relative(REHEARSE_ROOT, file).replaceAll('\\', '/');
    return {path, sha256: sha(readFileSync(localFile(REHEARSE_ROOT, path)))};
}

export async function writeSpecialistReceipt(seg: Segment, scored: ScoredRun, actor: string, server: string, out: string, log: string, savePath: string) {
    const workerLog = readFileSync(log, 'utf8');
    if (!successfulWorkerLog(workerLog)) throw Error('need one successful raw worker run with confirmed logout');
    const recordDir = join(recordRoot(REHEARSE_ROOT), scriptKey(seg.script));
    const prefix = actor.toLowerCase() + '-', suffix = '.ticks.ndjson.gz';
    const records = readdirSync(recordDir)
        .filter(file => file.startsWith(prefix) && file.endsWith(suffix))
        .map(file => ({file: join(recordDir, file), at: Number(file.slice(prefix.length, -suffix.length))}))
        .filter(r => Number.isSafeInteger(r.at))
        .sort((a, b) => a.at - b.at)
        .map(r => r.file);
    if (records.length === 0) throw Error('need one complete tick record of the fresh actor');
    await confirmLivingSession(records, actor, server);
    if (/\[trade-ledger\].*failed/.test(readFileSync(scored.engineLog, 'utf8'))) throw Error('practice trade ledger write failed');
    const save = readFileSync(savePath), {endPlaytime, boardTick} = scoredClock(save, scored.board);
    const planTicks = seg.plan!.ticks;
    if (Math.abs(boardTick - planTicks) > planTicks * .02 || endPlaytime > boardTick + Math.max(planTicks * .02, MAX_LOGOUT_DRAIN_TICKS))
        throw Error('saved specialist clocks differ from the plan by more than 2%');
    if (capabilityRevision(workerEntries(seg.script, seg.args ?? [], REHEARSE_ROOT), REHEARSE_ROOT) !== scored.source)
        throw Error('worker source changed during specialist rehearsal');
    const externalSupplies = observedSupplies(readFileSync(scored.ledger, 'utf8'), actor,
        JSON.parse(readFileSync(join(REHEARSE_ROOT, 'knowledge/items.json'), 'utf8')));
    const context = specialistContext(scored.account, scored.source, scored.mission, externalSupplies);
    const finalSave = join(out, seg.id + '.final.sav');
    writeFileSync(finalSave, save, {flag: 'wx'});
    const retainedTicks = join(out, seg.id + '.ticks.ndjson.gz');
    if (records.length === 1) copyFileSync(records[0]!, retainedTicks, constants.COPYFILE_EXCL);
    else writeFileSync(retainedTicks, Buffer.concat(records.map(file => readFileSync(file))), {flag: 'wx'});
    const stamp = {version: 2, context, runId: actor, actor, server, at: Date.now(), startPlaytime: 0, endPlaytime, planTicks,
        ok: true, died: false, logout: 'logged-out', boardTicks: {[scored.board]: boardTick}, externalSupplies,
        artifacts: {finalSave: bind(finalSave), tradeLedger: bind(scored.ledger), tickRecord: bind(retainedTicks)}};
    appendFileSync(log, '\nREHEARSAL ' + JSON.stringify(stamp) + '\n');
    const receipt = join(out, seg.id + '.receipt.json'), candidate = join(out, seg.id + '.candidate.json');
    writeFileSync(receipt, JSON.stringify({...stamp, log: bind(log)}, null, 2) + '\n', {flag: 'wx'});
    writeFileSync(candidate, JSON.stringify({version: 1, account: scored.account, board: scored.board,
        context, planTicks, requirements: externalSupplies, rehearsal: bind(receipt)}, null, 2) + '\n', {flag: 'wx'});
    return {receipt: bind(receipt), candidate: bind(candidate)};
}
