// Keeps a live bot run going: restarts it when it ends without "RESULT ok", stops for good on a stop file, a death
// no progress or too many failures in a row. Live runs were lost to tick caps, a stop-and-restart by hand, and
// Claude Code ending background jobs. Each restart logs in again, so it costs a few playtime ticks. A run the game
// connection ended after real work (a gateway drain hours into a standing job) restarts the failure streak, so only
// failures with no work between them add up to gave-up.
// CLI: bun packages/practice/src/supervise.ts <bot> <script> [maxRestarts=20] [scriptArgs...] (env passes through)

import {assertWorkerRelease,isWorkerReleaseHold} from '../../core/src/worker-release';
import {fleetLeaseAllowsWorker} from '../../core/src/fleet-lease';
import {unplacedCause} from '../../core/src/order-refusal';
import {hasStopFile} from '../../core/src/practice-paths';

export function workerCommand(bot:string,script:string,scriptArgs:readonly string[]):string[]{
    return ['bun',script,bot,...scriptArgs];
}

export function supervisorParticipants(bot:string,raw:string|undefined):string[]{
    const valid=(name:unknown):name is string=>typeof name==='string'&&/^[A-Za-z0-9_ -]{1,12}$/.test(name);
    if(!valid(bot))throw Error('invalid supervisor account');
    if(!raw)return [bot];
    const names:unknown=JSON.parse(raw);
    if(!Array.isArray(names)||names.length<2||names.some(n=>!valid(n))
        ||names[0].toLowerCase()!==bot.toLowerCase()||new Set(names.map(n=>n.toLowerCase())).size!==names.length)
        throw Error('invalid coordinator participants');
    return names;
}

export function participantsStopped(accounts:readonly string[],stopped:(account:string)=>boolean):boolean{
    return accounts.some(stopped);
}

export function participantsHaveStopFile(accounts:readonly string[],root=process.cwd()):boolean{
    return participantsStopped(accounts,account=>hasStopFile(account,root));
}

export interface SuperviseDeps {
    run(): Promise<{ stdout: string; exitCode: number }>;
    stopped(): boolean;
    pause(ms: number): Promise<void>;
    maxRestarts: number;
    log?(line: string): void;
}

// Match failure text, not metrics such as stallTicks=0 or a successful run mentioning progress.
// Worker guards emit "no ore/wood progress", "made no progress", or "stalled".
export function isNoProgressFailure(result: string): boolean {
    return /^RESULT fail\b/.test(result)
        && /\b(?:no(?:[ -]+[a-z]+){0,3}[ -]+progress|stalled|stall(?:[ :]|$)|no woolly sheep within 120 ticks\b)/i.test(result);
}

// These exact worker guards require staging, gear or a config change. Retrying
// the same command logs in again without repairing any of those prerequisites.
export function isPrerequisiteFailure(result: string): boolean {
    if (!/^RESULT fail\b/.test(result)) return false;
    // The shared walker found no route from where the account stands, or the account has no fare for the ferries that
    // the route needs (scripts/walk-to.ts, reason `precondition`). The route tables, the account's place and its coins
    // do not change between two logins, so a restart fails the same way.
    // The walker names a missing fare at the dock (`in the pack`) and at the bank that does not hold the coins.
    if (/\bprecondition (?:no route to \d+,\d+,\d+|(?:(?:westbound|eastbound) )?ferry needs \d+ coins (?:in the pack|and the bank holds \d+))/.test(result)) return true;
    // A Grand Exchange buy that ended before it placed an offer (packages/core/src/order-refusal.ts): the coins, the pack, the count
    // of what the account holds and the order deadline do not change between two logins of the same job, so the same order fails the
    // same way. A stop (the session ended, died or was told to stop) can differ at the next login. The next planner pass sizes a new
    // order from the fresh status that this run leaves.
    const cause = unplacedCause(result);
    if (cause !== undefined && cause !== 'stop') return true;
    // A finite combat pilot that retreats or refuses a target needs review;
    // twenty fresh logins do not change its route, food, gear or attribution.
    return result.startsWith('RESULT fail Fire-pilot ')
        || result.includes('Rune Mysteries quest required: Aubury refused teleport')
        || result.includes('Rune Mysteries prerequisite:')
        || /\bboughtTotal=0\b.*\bstop=(?:stock-wait|coin-reserve)\b|\bstop=(?:stock-wait|coin-reserve)\b.*\bboughtTotal=0\b/.test(result)
        || /\b(?:cow prerequisite:|cow kit(?: equip failed \d+:| withdraw failed \d+\b|: replaced gear deposit failed \(\d+\))|oak PREPARE requires known Draynor bank start\b|cow needs positive CAP and MAX_KILLS1\.\.5\b|oak needs CAP>0 and MAX_MAKE1\.\.25\b|TRAIN_SKILL must be Attack, Strength or Defence\b|TARGET_LEVEL must be1\.\.99\b|missing shears\b|low HP during tool bootstrap\b|worker ended or cap\b)/.test(result);
}

// A TickStallError (packages/core/src/tick-stream.ts) is the game connection going quiet, the same loss as a
// disconnect: a fresh login repairs it. Such a run retries within maxRestarts even when the worker also reports
// no progress, because the stalled stream is what stopped the progress.
export function isTransportStall(result: string): boolean {
    return /^RESULT fail\b/.test(result) && /tick stream stalled: no new game tick for \d+ms/.test(result);
}

// Scan lines backward so large stdout logs do not split into full line arrays.
function lastMatchingLine(text: string, test: (line: string) => boolean): string | undefined {
    let end = text.length;
    while (end > 0) {
        const nl = text.lastIndexOf('\n', end - 1);
        const start = nl + 1;
        const lineEnd = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
        const line = text.slice(start, lineEnd);
        if (test(line)) return line;
        if (nl < 0) break;
        end = nl;
    }
    return undefined;
}

// Real work in a run: the LEDGER line every worker prints at finish (packages/core/src/ledger.ts) with at least
// PROGRESS_TICKS game ticks. A failed login or a session dropped at once prints none, so a dead server still gives up.
export const PROGRESS_TICKS = 300;
const LEDGER_TICKS_RE = /^LEDGER ticks=(\d+)/;
export function madeProgress(stdout: string): boolean {
    const line = lastMatchingLine(stdout, l => l.startsWith('LEDGER ticks=') && LEDGER_TICKS_RE.test(l));
    const m = line ? LEDGER_TICKS_RE.exec(line) : null;
    return !!m && Number(m[1]) >= PROGRESS_TICKS;
}

export function isEntryRefusal(result: string): boolean {
    return /^RESULT fail\b/.test(result) && /\bticks=0\b/.test(result) && !/died=true/.test(result);
}

// A login refused because a dropped session still holds the account's fleet claim ("fleet account claim held"). Only
// an authenticated recovery clears that (packages/core/src/fleet-trade-claim.ts acquireFleetSwarmClaim), and the
// recovery starts from this supervisor's end. A release that is still being written clears within a try or two, so
// HELD_CLAIM_TRIES such refusals in a row end the job as gave-up. Live claude-cloud: each cut of the relay cost its
// account 20 more logins of this kind, about three minutes, before its recovery could start; 150 runs ended on a cut
// in one night.
export const HELD_CLAIM_TRIES = 3;
export const isHeldClaimRefusal = (result: string) => /^RESULT fail (?:login: )?(?:Error: )?fleet account claim held\b/.test(result);

// The failure text of a run with its numbers masked. Two runs in a row that end with the same text, with no real work
// in either, fail the same way on every next login, so the job ends as blocked after the second: a failure that no
// rule above names (a "no route" or "feathers=2000 gained=0" result without its own rule) would otherwise log in
// maxRestarts times. Failures that a later login can repair keep the retry streak: a login error, a dropped session,
// a transport stall, a held claim (it has its own limit) and a claim authority that did not answer.
// The Git authority of the login claim did not answer in its time (packages/core/src/fleet-trade-claim.ts). The account
// did not log in, and a later login can pass. Such a result keeps the retry streak and never ends a job as blocked, and
// the next run waits CLAIM_AUTHORITY_PAUSE_MS, because the authority was slow. A chain whose step ended on the error
// gives the text with no "login:" (packages/core/src/run-child.ts).
export const CLAIM_AUTHORITY_PAUSE_MS = 30_000;
export const isClaimAuthorityFault = (result: string) => /^RESULT fail (?:login: )?(?:Error: )?fleet swarm claim authority (?:unavailable or changed|timed out)\b/.test(result);

// A `position=x,z,level` keeps its numbers: a run that ended on another tile moved, so it is not the same failure
// (market bank travel stopped at 3035,3247 and then at 3096,3414, and the job ended as blocked).
export const failureShape = (result: string) => result.replace(/position=\d+,\d+,\d+|\d+/g, m => m.startsWith('position=') ? m : 'N').replace(/\s+/g, ' ').trim();
export const repeatableFailure = (result: string) => /^RESULT fail\b/.test(result) && !isTransportStall(result) && !isHeldClaimRefusal(result) && !isClaimAuthorityFault(result)
    && !/^RESULT fail (?:login:|session ended|.*TickStallError)/.test(result);

// A run's output can be hours long. The supervisor reads only the last RESULT line and the last LEDGER line (one for
// each key), so this keeps those lines and drops the rest. `match` returns the key of a line to keep, or null. A line
// over MAX_KEPT_LINE characters keeps its first MAX_KEPT_LINE characters.
export const MAX_KEPT_LINE = 65_536;
export function lineKeeper(match: (line: string) => string | null) {
    const kept = new Map<string, string>();
    let partial = '';
    const take = (raw: string) => { const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw, key = match(line); if (key !== null) kept.set(key, line); };
    return {
        push(chunk: string): void {
            let start = 0;
            let nl = chunk.indexOf('\n');
            if (nl < 0) {
                if (partial.length < MAX_KEPT_LINE) partial += chunk.slice(0, MAX_KEPT_LINE - partial.length);
                return;
            }
            const first = (partial + chunk.slice(0, nl)).slice(0, MAX_KEPT_LINE);
            partial = '';
            take(first);
            start = nl + 1;
            while (start <= chunk.length) {
                nl = chunk.indexOf('\n', start);
                if (nl < 0) {
                    partial = chunk.slice(start, start + MAX_KEPT_LINE);
                    break;
                }
                take(chunk.slice(start, Math.min(nl, start + MAX_KEPT_LINE)));
                start = nl + 1;
            }
        },
        /** The kept lines joined by newlines. This ends the open line. */
        text(): string { if (partial) { take(partial); partial = ''; } return [...kept.values()].join('\n'); },
    };
}

// Copies a child's stdout to this process and returns only the lines that `match` keeps.
export async function keepOutput(stdout: ReadableStream<Uint8Array>, match: (line: string) => string | null): Promise<string> {
    const keep = lineKeeper(match), reader = stdout.getReader(), decoder = new TextDecoder();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const c = decoder.decode(value, { stream: true });
        keep.push(c);
        process.stdout.write(c);
    }
    keep.push(decoder.decode());
    return keep.text();
}

export async function supervise(d: SuperviseDeps): Promise<{ reason: 'done' | 'stopped' | 'died' | 'blocked' | 'gave-up' | 'release-paused' | 'refused'; runs: number }> {
    let fails = 0, held = 0, lastShape: string | null = null;
    for (let runs = 1; ; runs++) {
        if (d.stopped()) return { reason: 'stopped', runs: runs - 1 };
        const r = await d.run();
        const result = lastMatchingLine(r.stdout, l => l.startsWith('RESULT')) ?? '(no RESULT)';
        d.log?.(`SUPERVISE run ${runs} exit ${r.exitCode}: ${result.slice(0, 200)}`);
        if (r.exitCode === 0 && /^RESULT ok\b/.test(result)) return { reason: 'done', runs };
        if (d.stopped() || /stop file/.test(result)) return { reason: 'stopped', runs };
        // A death means the route or the food plan failed; a blind restart repeats it.
        if (/died=true|RESULT fail died/.test(result)) return { reason: 'died', runs };
        // Out of food: a restart only logs in again and finds the same empty bank. A resupply job must run first.
        if (/RESULT fail no food/.test(result)) return { reason: 'stopped', runs };
        if (isWorkerReleaseHold(result)) return { reason: 'release-paused', runs };
        // A worker that refuses before it acts (no game ticks) changed nothing: the account is free for its next job.
        if (isEntryRefusal(result)) return { reason: 'refused', runs };
        if (!isTransportStall(result) && (isNoProgressFailure(result) || isPrerequisiteFailure(result))) return { reason: 'blocked', runs };
        held = isHeldClaimRefusal(result) ? held + 1 : 0;
        if (held >= HELD_CLAIM_TRIES) return { reason: 'gave-up', runs };
        const worked = madeProgress(r.stdout);
        const shape = !worked && repeatableFailure(result) ? failureShape(result) : null;
        if (shape !== null && shape === lastShape) return { reason: 'blocked', runs };
        lastShape = shape;
        // A run with real work behind it is one failure, not one more: the streak toward gave-up restarts at it.
        fails = worked ? 1 : fails + 1;
        if (fails > d.maxRestarts) return { reason: 'gave-up', runs };
        await d.pause(isClaimAuthorityFault(result) ? CLAIM_AUTHORITY_PAUSE_MS : 10_000);
    }
}

export function parseSuperviseArgs(argv: readonly string[]): { bot: string; script: string; maxRestarts: number; scriptArgs: string[] } {
    const [bot, script, maxArg, ...scriptArgs] = argv;
    if (!bot || !script) throw Error('usage: supervise.ts <bot> <script> [maxRestarts=20]');
    const maxRestarts = maxArg === undefined ? 20 : Number(maxArg);
    if (!Number.isSafeInteger(maxRestarts) || maxRestarts < 0) throw Error(`maxRestarts must be a whole number: ${maxArg}`);
    return { bot, script, maxRestarts, scriptArgs };
}

if (import.meta.main) {
    let parsed: ReturnType<typeof parseSuperviseArgs>;
    try { parsed = parseSuperviseArgs(process.argv.slice(2)); } catch (e) { console.log(String(e)); process.exit(2); }
    const { bot, script, maxRestarts, scriptArgs } = parsed;
    const participants=supervisorParticipants(bot,process.env.COORDINATOR_PARTICIPANTS);
    const r = await supervise({
        run: async () => {
            // A standing owner job has no coordinator acceptance, so it runs the current source without the release pin.
            if(process.env.DEMO_OK==='1'&&process.env.STANDING!=='1')try{assertWorkerRelease();}catch(e){return {stdout:`RESULT fail ${String(e)}`,exitCode:1};}
            const p = Bun.spawn(workerCommand(bot,script,scriptArgs), { stdout: 'pipe', stderr: 'inherit', env: process.env ,windowsHide:true});
            const stdout = await keepOutput(p.stdout, l => l.startsWith('RESULT') ? 'RESULT' : /^LEDGER ticks=\d+/.test(l) ? 'LEDGER' : null);
            return { stdout, exitCode: await p.exited };
        },
        stopped: () => !fleetLeaseAllowsWorker(process.cwd()) || participantsHaveStopFile(participants, process.cwd()),
        pause: ms => Bun.sleep(ms),
        maxRestarts,
        log: l => console.log(l),
    });
    console.log(`SUPERVISE end ${r.reason} after ${r.runs} runs`);
    process.exit(r.reason === 'done' ? 0 : 1);
}
