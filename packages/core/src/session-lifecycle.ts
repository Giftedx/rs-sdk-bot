import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute,relative,join,resolve } from 'node:path';
import { isLocalServer } from './localserver';

// Per-account session lifecycle receipts. The in-process session producer (inprocess.ts connectInProcess) writes
// one attempt file before its network attempt and records only events from that exact session: connect, START,
// the server end reason, logout result and close. A latest pointer moves only when a new attempt begins, so a late
// callback from an older attempt updates its own file and never the current one. Only a server-observed
// 'logged-out' end confirms logout. Credentials never enter a receipt. Practice and live servers use separate trees.
//
// Layout: <root>/<domain>/<server key>/<account key>/attempts/<attemptId>.json and .../latest.json

export const LIFECYCLE_SCHEMA = 'session-lifecycle/1';
export const DEFAULT_LIFECYCLE_ROOT = join(resolve(import.meta.dir, '..', '..', '..'), '.practice', 'session-lifecycle');
export type LifecycleDomain = 'practice' | 'live';
export type LifecycleEventKind = 'connecting' | 'connected' | 'connect-failed' | 'ready' | 'ready-failed' | 'ended' | 'logout' | 'closed';
export type LifecycleEvent = { at: number; kind: LifecycleEventKind; detail?: string };
export type LifecycleOwner = { pid: number; coordinatorRunId: string | null; workerRelease: string | null; script: string; role: string | null; participants: string[] | null };
export type AttemptReceipt = {
    schema: typeof LIFECYCLE_SCHEMA; attemptId: string; account: string; server: string; domain: LifecycleDomain;
    owner: LifecycleOwner; config: { members: boolean | null }; createdAt: number; updatedAt: number; events: LifecycleEvent[];
};
export type LatestPointer = { schema: typeof LIFECYCLE_SCHEMA; account: string; server: string; domain: LifecycleDomain; attemptId: string; at: number };
export type SessionAttempt = { readonly attemptId: string; readonly account: string; readonly server: string; readonly domain: LifecycleDomain; record(kind: LifecycleEventKind, detail?: string): boolean };

const ACCOUNT = /^[A-Za-z0-9_ -]{1,12}$/;
const SERVER = /^[A-Za-z0-9.:[\]-]{1,253}$/;
const ATTEMPT = /^\d{13}-\d{1,10}-\d{1,10}$/;
export const domainOf = (server: string): LifecycleDomain => isLocalServer(server) ? 'practice' : 'live';
const serverKey = (server: string) => server.trim().toLowerCase().replace(/[^a-z0-9.-]/g, '_');
export function accountDir(account: string, server: string, root = DEFAULT_LIFECYCLE_ROOT): string {
    if (!ACCOUNT.test(account) || !SERVER.test(server)) throw new Error('invalid lifecycle identity');
    return join(root, domainOf(server), serverKey(server), account.toLowerCase().replace(/ /g, '_'));
}

function writeAtomic(path: string, text: string, exclusive = false): void {
    const temporary = `${path}.tmp-${process.pid}-${++sequence}`;
    writeFileSync(temporary, text);
    try {
        if (exclusive) { linkSync(temporary, path); unlinkSync(temporary); } else replaceFile(temporary, path);
    } catch (e) {
        try { rmSync(temporary, { force: true }); } catch { /* keep the original error */ }
        throw e;
    }
}
// Windows refuses a rename over a file that another process (antivirus, indexer, a reader) holds open for a moment
// (EPERM/EACCES/EBUSY). The write stays synchronous: short blocking retries within a 2 s deadline, then the error.
const RENAME_RETRY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_DEADLINE_MS = 2000;
const pause = new Int32Array(new SharedArrayBuffer(4));
function replaceFile(from: string, to: string): void {
    const start = Date.now();
    for (let attempt = 0; ; attempt++) {
        try { renameSync(from, to); return; }
        catch (e: any) {
            if (!RENAME_RETRY.has(e?.code) || Date.now() - start >= RENAME_DEADLINE_MS) throw e;
            Atomics.wait(pause, 0, 0, Math.min(5 * (attempt + 1), 50));
        }
    }
}
let sequence = 0;
let lastAt = 0;

// Diagnostic text from errors. The password never enters a receipt, even inside an error message.
function clean(detail: string | undefined, secret: string | undefined): string | undefined {
    if (detail === undefined) return undefined;
    let text = String(detail);
    if (secret) text = text.split(secret).join('[redacted]');
    return text.slice(0, 300);
}

const producerArgv=[...process.argv],producerCwd=process.cwd(),producerRepo=resolve(import.meta.dir,'../../..');
export function lifecycleOwner(env: Record<string, string | undefined> = process.env, argv = producerArgv): LifecycleOwner {
    let participants: string[] | null = null;
    try { const p = JSON.parse(env.COORDINATOR_PARTICIPANTS || 'null'); if (Array.isArray(p) && p.every(a => typeof a === 'string')) participants = p; } catch { /* absent */ }
    const entry=(value:string|undefined)=>{
        if(!value||value.startsWith('-'))return '';
        const path=relative(producerRepo,resolve(producerCwd,value)).replaceAll('\\','/');
        return !isAbsolute(path)&&path&&!path.startsWith('../')&&/\.ts$/i.test(path)?path:'';
    };
    let script=entry(argv[1]);
    if(script.toLowerCase()==='packages/core/src/host.ts'){
        // The host CLI accepts its two value flags anywhere. Custom/eval hosts have no
        // supported worker entry here; a goal label must never fill that missing identity.
        let selected:string|undefined;
        for(let i=2;i<argv.length;i++){
            const value=argv[i]!;
            if(value.startsWith('--')){if(!['--stagger-ms','--mem-every-s'].includes(value)){selected=undefined;break;}i++;continue;}
            selected=value;break;
        }
        script=entry(selected);
    }
    return { pid: process.pid, coordinatorRunId: env.COORDINATOR_RUN_ID || null, workerRelease: env.WORKER_RELEASE || null,
        script, role: env.BOT_ROLE || null, participants };
}

// Records intent before any network attempt. It throws, and the caller must not connect, when the attempt file or
// the latest pointer cannot be written. An attempt file whose pointer failed is removed: no network attempt exists.
export function beginSessionAttempt(identity: { account: string; server: string; members?: boolean; secret?: string },
    opts: { root?: string; now?: () => number; owner?: LifecycleOwner } = {}): SessionAttempt {
    const root = opts.root ?? DEFAULT_LIFECYCLE_ROOT, now = opts.now ?? Date.now;
    const dir = accountDir(identity.account, identity.server, root), attempts = join(dir, 'attempts');
    mkdirSync(attempts, { recursive: true });
    const createdAt = Math.max(now(), lastAt);
    lastAt = createdAt;
    // Fixed-width parts: file-name order is (time, pid, sequence) order.
    const attemptId = `${String(createdAt).padStart(13, '0')}-${String(process.pid).padStart(10, '0')}-${String(++sequence).padStart(10, '0')}`;
    const receipt: AttemptReceipt = { schema: LIFECYCLE_SCHEMA, attemptId, account: identity.account, server: identity.server, domain: domainOf(identity.server),
        owner: opts.owner ?? lifecycleOwner(), config: { members: identity.members ?? null }, createdAt, updatedAt: createdAt, events: [{ at: createdAt, kind: 'connecting' }] };
    const file = join(attempts, `${attemptId}.json`);
    writeAtomic(file, JSON.stringify(receipt), true);
    const pointer: LatestPointer = { schema: LIFECYCLE_SCHEMA, account: identity.account, server: identity.server, domain: receipt.domain, attemptId, at: createdAt };
    try { writeAtomic(join(dir, 'latest.json'), JSON.stringify(pointer)); }
    catch (e) { try { unlinkSync(file); } catch { /* the reader then reports the unpointed attempt as inconsistent */ } throw e; }
    let ended = false;
    return {
        attemptId, account: identity.account, server: identity.server, domain: receipt.domain,
        // Updates touch only this attempt's file. The first server end is kept; later ends cannot replace it.
        record(kind, detail) {
            if (kind === 'ended') { if (ended) return false; ended = true; }
            const at = now();
            receipt.events.push({ at, kind, ...(detail !== undefined ? { detail: clean(detail, identity.secret) } : {}) });
            receipt.updatedAt = at;
            try { writeAtomic(file, JSON.stringify(receipt)); return true; }
            catch (e) { console.error(`[lifecycle] ${identity.account}: receipt update failed`, String(e)); return false; }
        },
    };
}

// The read contract for admission and repair. Only `confirmed` permits a release step; on a takeover server a
// `held` session whose owner is gone may start again by re-login (session-takeover.ts).
export type LogoutProof =
    | { state: 'confirmed'; account: string; server: string; domain: LifecycleDomain; attemptId: string; loggedOutAt: number; ownerRun: string | null; receiptSha256: string }
    | { state: 'none'; account: string; server: string; domain: LifecycleDomain }
    | { state: 'held'; account: string; server: string; domain: LifecycleDomain; attemptId: string; reason: string }
    | { state: 'invalid'; account: string; server: string; reason: string };

function validReceipt(r: any): r is AttemptReceipt {
    return !!r && r.schema === LIFECYCLE_SCHEMA && typeof r.attemptId === 'string' && ATTEMPT.test(r.attemptId)
        && typeof r.account === 'string' && typeof r.server === 'string' && (r.domain === 'practice' || r.domain === 'live')
        && Number.isFinite(r.createdAt) && Number.isFinite(r.updatedAt) && Array.isArray(r.events) && r.events.length > 0
        && r.events[0].kind === 'connecting' && r.events.every((e: any) => e && Number.isFinite(e.at) && typeof e.kind === 'string')
        && !!r.owner && typeof r.owner === 'object';
}

// Classifies one attempt. No end, an unknown end, a logout timeout or a disconnect is held, never confirmed.
export function attemptOutcome(r: AttemptReceipt): { confirmed: true; at: number } | { confirmed: false; reason: string } {
    const end = r.events.find(e => e.kind === 'ended');
    if (end?.detail === 'logged-out') return { confirmed: true, at: end.at };
    if (end) return { confirmed: false, reason: `ended ${end.detail ?? 'unknown'}` };
    const failed = r.events.find(e => e.kind === 'connect-failed');
    if (failed) return { confirmed: false, reason: 'connect failed without an observed end' };
    const logout = [...r.events].reverse().find(e => e.kind === 'logout');
    if (logout) return { confirmed: false, reason: `logout ${logout.detail ?? 'unknown'} without an observed end` };
    return { confirmed: false, reason: r.events.some(e => e.kind === 'ready') ? 'session active or outcome unknown' : 'connection attempt before START, outcome unknown' };
}

export function readLogoutProof(account: string, server: string, opts: { root?: string } = {}): LogoutProof {
    let dir: string;
    try { dir = accountDir(account, server, opts.root); } catch { return { state: 'invalid', account, server, reason: 'invalid identity' }; }
    const domain = domainOf(server), attempts = join(dir, 'attempts'), same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    let names: string[] = [];
    try { names = existsSync(attempts) ? readdirSync(attempts).filter(n => n.endsWith('.json')) : []; }
    catch (e) { return { state: 'invalid', account, server, reason: `attempts unreadable: ${String(e).slice(0, 120)}` }; }
    const latestFile = join(dir, 'latest.json');
    if (!existsSync(latestFile)) return names.length ? { state: 'invalid', account, server, reason: 'attempts without a latest pointer' } : { state: 'none', account, server, domain };
    let pointer: any, raw: Buffer, receipt: any;
    try { pointer = JSON.parse(readFileSync(latestFile, 'utf8')); } catch { return { state: 'invalid', account, server, reason: 'malformed latest pointer' }; }
    if (!pointer || pointer.schema !== LIFECYCLE_SCHEMA || typeof pointer.attemptId !== 'string' || !ATTEMPT.test(pointer.attemptId)
        || typeof pointer.account !== 'string' || !same(pointer.account, account) || pointer.server !== server || pointer.domain !== domain)
        return { state: 'invalid', account, server, reason: 'latest pointer identity mismatch' };
    try { raw = readFileSync(join(attempts, `${pointer.attemptId}.json`)); receipt = JSON.parse(raw.toString('utf8')); }
    catch { return { state: 'invalid', account, server, reason: 'latest attempt missing or malformed' }; }
    if (!validReceipt(receipt) || receipt.attemptId !== pointer.attemptId || !same(receipt.account, account) || receipt.server !== server || receipt.domain !== domain)
        return { state: 'invalid', account, server, reason: 'latest attempt identity mismatch' };
    // A newer attempt file than the pointer means an unrecorded owner; it can never be older proof.
    const newer = names.map(n => n.slice(0, -5)).filter(id => ATTEMPT.test(id) && id > receipt.attemptId);
    if (newer.length) return { state: 'held', account, server, domain, attemptId: receipt.attemptId, reason: `newer attempt ${newer.sort().at(-1)} is not the latest pointer` };
    const outcome = attemptOutcome(receipt);
    if (!outcome.confirmed) return { state: 'held', account, server, domain, attemptId: receipt.attemptId, reason: outcome.reason };
    return { state: 'confirmed', account, server, domain, attemptId: receipt.attemptId, loggedOutAt: outcome.at,
        ownerRun: receipt.owner.coordinatorRunId ?? null, receiptSha256: createHash('sha256').update(raw).digest('hex') };
}

// Every recorded attempt for one identity, oldest first. Malformed files are reported, never dropped.
export function listAttempts(account: string, server: string, opts: { root?: string } = {}): { attemptId: string; receipt: AttemptReceipt | null; sha256: string | null }[] {
    const attempts = join(accountDir(account, server, opts.root), 'attempts');
    if (!existsSync(attempts)) return [];
    return readdirSync(attempts).filter(n => n.endsWith('.json')).sort().map(n => {
        try { const raw = readFileSync(join(attempts, n)); const r = JSON.parse(raw.toString('utf8'));
            return { attemptId: n.slice(0, -5), receipt: validReceipt(r) ? r : null, sha256: createHash('sha256').update(raw).digest('hex') }; }
        catch { return { attemptId: n.slice(0, -5), receipt: null, sha256: null }; }
    });
}

// Retained legacy format is diagnostic only: hashes bind bytes, but anonymous START/LOGOUT
// lines do not attribute those bytes to the adjacent status account, server or session.
export type LegacyLogoutClaim = { kind: 'legacy-logout'; account: string; server: string; statusPath: string; statusSha256: string; statusAt: number; logPath: string; logSha256: string };
export type LegacyLogoutProof = { state: 'legacy-confirmed'; account: string; server: string; statusAt: number; statusSha256: string; logSha256: string } | { state: 'refused'; reason: string };
export function verifyLegacyLogout(claim: any, opts: { root?: string } = {}): LegacyLogoutProof {
    if (!claim || claim.kind !== 'legacy-logout' || typeof claim.account !== 'string' || typeof claim.server !== 'string'
        || typeof claim.statusPath !== 'string' || typeof claim.logPath !== 'string' || !Number.isFinite(claim.statusAt)
        || !/^[0-9a-f]{64}$/.test(claim.statusSha256 ?? '') || !/^[0-9a-f]{64}$/.test(claim.logSha256 ?? '')) return { state: 'refused', reason: 'invalid legacy claim' };
    const current = readLogoutProof(claim.account, claim.server, opts);
    if (current.state !== 'none') return { state: 'refused', reason: `producer evidence exists: ${current.state}` };
    let status: Buffer, log: Buffer;
    try { status = readFileSync(claim.statusPath); log = readFileSync(claim.logPath); } catch { return { state: 'refused', reason: 'legacy evidence missing' }; }
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    if (sha(status) !== claim.statusSha256 || sha(log) !== claim.logSha256) return { state: 'refused', reason: 'legacy evidence hash changed' };
    let doc: any;
    try { doc = JSON.parse(status.toString('utf8')); } catch { return { state: 'refused', reason: 'legacy status malformed' }; }
    if (!doc || typeof doc.name !== 'string' || doc.name.toLowerCase() !== claim.account.toLowerCase() || doc.server !== claim.server || doc.at !== claim.statusAt)
        return { state: 'refused', reason: 'legacy status identity mismatch' };
    const text = log.toString('utf8'), logouts = text.match(/^LOGOUT .*$/gm) ?? [], starts = text.match(/^START /gm) ?? [];
    if (starts.length !== 1 || logouts.length !== 1 || logouts[0]!.trim() !== 'LOGOUT logged-out') return { state: 'refused', reason: 'legacy log lacks exactly one START and one LOGOUT logged-out' };
    return { state:'refused',reason:'anonymous legacy log has no independent account/server/session attribution' };
}
