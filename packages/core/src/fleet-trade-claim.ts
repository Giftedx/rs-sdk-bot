import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { SIDE_NAME } from './fleet';
import { commitFleetGitRecord, fleetGitRetryable, fleetPushRetryable, pushFleetGitRecord, fleetCheckoutId, fleetCheckoutLastSeen, fleetGitWindow, fleetLeaseLastSeen, readFleetGitRefs,recoveryHostLease,fleetLeaseAllowsWorker,FLEET_LEASE_TTL_MS } from './fleet-lease';
import {assertSpentRecoveryConnection,type RecoveryConnectionAdmission} from './session-recovery-permit';
import { listAttempts, readLogoutProof } from './session-lifecycle';
import { pidAlive, savedProcessAlive } from './session-takeover';

type Identity = { account: string; server: string };
type ClaimIdentity = Identity & { side: string };
type TradeClaimInput = ClaimIdentity & { orderId: string; role: 'from' | 'to' };
type ClaimState = { nonce: string; phase: 'held' | 'released'; at: number };
type ClaimOwner = { checkout: string; host: string; pid: number };
export type FleetTradeClaim = TradeClaimInput & ClaimState & Partial<ClaimOwner>;
type FleetSwarmClaim = ClaimIdentity & ClaimState & ClaimOwner & { kind: 'swarm' };
export type FleetAccountClaim = FleetTradeClaim | FleetSwarmClaim;

const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT = /^[a-z0-9_-]{1,12}$/;
const SERVER = /^[a-z0-9][a-z0-9.:-]{0,252}$/;
const CLAIM_PREFIX = 'refs/heads/fleet-trade-claim/';
export const SWARM_CLAIM_READ_MS = 15_000, SWARM_CLAIM_PUSH_MS = 20_000, SWARM_CLAIM_TRIES = 3, SWARM_CLAIM_PAUSE_MS = 1000;
const REMOTE_BUSY_PAUSE_MS = 200;
const TRADE_AUTHORITY = 'fleet trade claim authority';
const claimPause = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const gitForTrade = (root: string, budgetMs?: number, gitWindow = fleetGitWindow) => gitWindow(root, TRADE_AUTHORITY, budgetMs);
const isRemoteBusyPush = (error: unknown) => fleetPushRetryable(error) && !fleetGitRetryable(error);
type TradePushOptions = { wait?: (ms: number) => void; gitWindow?: typeof fleetGitWindow };

function retryAttempt<T>(action: () => T, retryable: (error: unknown) => boolean, tries: number, wait: (ms: number) => void, pauseMs = SWARM_CLAIM_PAUSE_MS): T {
    for (let n = 1; ; n++) {
        try { return action(); }
        catch (error) {
            if (n >= tries || !retryable(error)) throw error;
            wait(pauseMs * (2 * n - 1));
        }
    }
}

function accountName(account: string) {
    if (!/^[A-Za-z0-9_ -]{1,12}$/.test(account)) throw Error('invalid fleet account claim account');
    return account.toLowerCase().replaceAll(' ', '_');
}

function identity({ account, server }: Identity) {
    server = server.toLowerCase();
    if (!SERVER.test(server)) throw Error('invalid fleet trade claim server');
    return { account: accountName(account), server };
}

const isSwarmClaim = (claim: FleetAccountClaim): claim is FleetSwarmClaim => 'kind' in claim && claim.kind === 'swarm';

function parseClaim(raw: string, account: string, server?: string): FleetAccountClaim {
    let claim: FleetAccountClaim;
    try { claim = JSON.parse(raw); }
    catch { throw Error('fleet trade claim authority has an unreadable record'); }
    if (claim?.account !== account || typeof claim.server !== 'string' || !SERVER.test(claim.server) || (server !== undefined && claim.server !== server)
        || typeof claim.side !== 'string' || !SIDE_NAME.test(claim.side) || typeof claim.nonce !== 'string' || !UUID.test(claim.nonce)
        || (claim.phase !== 'held' && claim.phase !== 'released') || !Number.isSafeInteger(claim.at) || claim.at <= 0) {
        throw Error('fleet trade claim authority has an invalid record');
    }
    if (isSwarmClaim(claim) || 'checkout' in claim || 'host' in claim || 'pid' in claim) {
        if (typeof claim.checkout !== 'string' || !UUID.test(claim.checkout) || typeof claim.host !== 'string' || !claim.host
            || typeof claim.pid !== 'number' || !Number.isSafeInteger(claim.pid) || claim.pid <= 0) throw Error('fleet account claim owner is invalid');
    }
    if (!isSwarmClaim(claim) && ('kind' in claim || typeof claim.orderId !== 'string' || !ORDER_ID.test(claim.orderId) || (claim.role !== 'from' && claim.role !== 'to'))) {
        throw Error('fleet trade claim authority has an invalid record');
    }
    return claim;
}

// Fetches the claim records that this checkout does not hold yet. A record is a commit, and a commit id names its
// content, so a head that is here needs no fetch: a local check of every head costs one local command, a fetch of all
// of them one network round trip each time. A failed check fetches every head, as before.
function fetchMissingHeads(git: ReturnType<typeof gitForTrade>, heads: readonly string[]): void {
    let missing: readonly string[] = heads;
    try {
        const present = new Set(git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], heads.join('\n') + '\n').split(/\r?\n/)
            .flatMap(line => { const [sha, type] = line.trim().split(' '); return sha && type === 'commit' ? [sha] : []; }));
        missing = heads.filter(head => !present.has(head));
    } catch { /* fetch every head */ }
    if (missing.length) git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', 'origin', ...missing]);
}

function loadClaim(git: ReturnType<typeof gitForTrade>, account: string, server: string) {
    // The owner registry names accounts globally. Keep one ref for that identity,
    // including when stale callers disagree on its server or side.
    const ref = CLAIM_PREFIX + account, head = readFleetGitRefs(git, [ref]).get(ref);
    if (!head) return { ref, head, claim: null };
    // Read the commit locally when present; commit SHAs bind exact content so local heads need no remote fetch.
    let body: string;
    try { body = git(['show', '-s', '--format=%b', head]); }
    catch (error) {
        if (!/bad object|unknown revision|not a valid object|does not exist/i.test(String(error))) throw error;
        git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', 'origin', head]);
        body = git(['show', '-s', '--format=%b', head]);
    }
    const claim = parseClaim(body, account, server);
    return { ref, head, claim };
}

export function readFleetTradeClaim(root: string, target: Identity): FleetTradeClaim | null {
    const claim = readFleetAccountClaim(root, target);
    return claim && !isSwarmClaim(claim) ? claim : null;
}

export function readFleetAccountClaim(root: string, target: Identity): FleetAccountClaim | null {
    const { account, server } = identity(target);
    return loadClaim(gitForTrade(root), account, server).claim;
}

export function readHeldFleetTradeClaims(root: string, accounts?: readonly string[]): FleetTradeClaim[] {
    return readHeldFleetAccountClaims(root, accounts).filter((claim): claim is FleetTradeClaim => !isSwarmClaim(claim));
}

// The held claims of both kinds, trade and swarm, in one round trip.
export function readHeldFleetAccountClaims(root: string, accounts?: readonly string[]): FleetAccountClaim[] {
    const names = accounts ? [...new Set(accounts.map(accountName))] : undefined;
    if (names?.length === 0) return [];
    const git = gitForTrade(root);
    const refs = readFleetGitRefs(git, names ? names.map(account => CLAIM_PREFIX + account) : [CLAIM_PREFIX + '*']);
    const pending = new Map([...refs].map(([ref, head]) => [head, ref.slice(CLAIM_PREFIX.length)]));
    if (!pending.size) return [];
    if (pending.size !== refs.size || [...pending.values()].some(account => !ACCOUNT.test(account))) {
        throw Error('fleet trade claim authority has an invalid account ref');
    }
    const heads = [...pending.keys()];
    fetchMissingHeads(git, heads);
    const rows = git(['show', '-s', '--format=%H%x00%b%x00', ...heads]).split('\0');
    const held: FleetAccountClaim[] = [];
    while (rows.length > 1) {
        const head = rows.shift()!.trim(), raw = rows.shift()!, account = pending.get(head);
        if (!account) throw Error('fleet trade claim authority has an unexpected record');
        const claim = parseClaim(raw, account);
        if (claim.phase === 'held') held.push(claim);
        pending.delete(head);
    }
    if (pending.size || rows[0]?.trim()) throw Error('fleet trade claim authority has incomplete records');
    return held;
}

// Every account's latest claim record, swarm and trade, in one round trip (fleet adoption reads which accounts are
// free). An unreadable record maps to null, which a reader treats as held.
export function readAllFleetAccountClaims(git: ReturnType<typeof fleetGitWindow>): Map<string, FleetAccountClaim | null> {
    const refs = readFleetGitRefs(git, [CLAIM_PREFIX + '*']), out = new Map<string, FleetAccountClaim | null>();
    const heads = [...refs].filter(([ref]) => ACCOUNT.test(ref.slice(CLAIM_PREFIX.length)));
    if (!heads.length) return out;
    fetchMissingHeads(git, heads.map(([, sha]) => sha));
    // One command reads every record (a command for each account took seconds under load). A record that the batch did
    // not return, or that fails to parse, maps to null as before; a failed batch reads each record on its own.
    const bodies = new Map<string, string>();
    try {
        const rows = git(['show', '-s', '--format=%H%x00%b%x00', ...heads.map(([, sha]) => sha)]).split('\0');
        while (rows.length > 1) { const head = rows.shift()!.trim(), raw = rows.shift()!; bodies.set(head, raw); }
    } catch { bodies.clear(); }
    for (const [ref, sha] of heads) {
        const account = ref.slice(CLAIM_PREFIX.length);
        try { out.set(account, parseClaim(bodies.get(sha) ?? git(['show', '-s', '--format=%b', sha]), account)); } catch { out.set(account, null); }
    }
    return out;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const missingGitObject = (error: unknown) => /not a valid object|invalid object|does not exist/i.test(String(error));

function commitClaimWithFallback(git: ReturnType<typeof gitForTrade>, head: string | undefined, message: string, cachedTree?: string) {
    const tree = cachedTree ?? (head ? EMPTY_TREE : undefined);
    if (tree) {
        try { return commitFleetGitRecord(git, head, tree, message); }
        catch (error) { if (!missingGitObject(error)) throw error; }
    }
    return commitFleetGitRecord(git, head, git(['hash-object', '-w', '-t', 'tree', '--stdin'], ''), message);
}

function commitClaim(git: ReturnType<typeof gitForTrade>, head: string | undefined, subject: string, claim: FleetAccountClaim) {
    return commitClaimWithFallback(git, head, subject + '\n\n' + JSON.stringify(claim));
}

function commitAndPushTradeClaim(root: string, git: ReturnType<typeof gitForTrade>, ref: string, head: string | undefined, subject: string, claim: FleetAccountClaim, { wait = claimPause, gitWindow = fleetGitWindow }: TradePushOptions) {
    const next = commitClaim(git, head, subject, claim);
    retryAttempt(() => pushFleetGitRecord(gitForTrade(root, SWARM_CLAIM_PUSH_MS, gitWindow), ref, next), fleetPushRetryable, SWARM_CLAIM_TRIES, wait);
    return next;
}

const pendingDir = (root: string) => join(root, '.practice', 'fleet-account-pending');
const pendingPath = (root: string, nonce: string) => join(pendingDir(root), nonce + '.json');
const lifecycleOptions = (root: string) => ({ base: root });
const claimOwner = (root: string): ClaimOwner => ({checkout: fleetCheckoutId(root), host: hostname(), pid: process.pid});

function owningCheckout(root: string, claim: FleetAccountClaim, side: string) {
    return claim.side === side && claim.host === hostname() && claim.checkout === fleetCheckoutId(root);
}

function matchedWorkerProof(root: string, claim: FleetSwarmClaim, target: ClaimIdentity) {
    if (!owningCheckout(root, claim, target.side)) return;
    const options = lifecycleOptions(root), proof = readLogoutProof(target.account, target.server, options);
    if (proof.state !== 'confirmed' && proof.state !== 'held') return;
    const producer = listAttempts(target.account, target.server, options).find(row => row.attemptId === proof.attemptId)?.receipt?.owner;
    if (producer?.sharedClaimNonce === claim.nonce && producer.pid === claim.pid) return proof;
}

// A held swarm claim of this checkout with a dead owner, no pending marker, no matching attempt receipt, and a
// confirmed logout proof from a prior session never reached session intent (connect.ts writes the attempt receipt
// before armNetwork removes the pending marker). Unsettled logouts, live owners, other checkouts, trade claims,
// and unreadable receipts never qualify.
function orphanedConfirmedPreNetworkClaim(
    root: string,
    claim: FleetAccountClaim,
    target: ClaimIdentity,
    ownerAlive: (pid: number, savedAt: number) => boolean = savedProcessAlive,
): boolean {
    if (!isSwarmClaim(claim) || claim.phase !== 'held' || !owningCheckout(root, claim, target.side)) return false;
    if (!claim.pid || ownerAlive(claim.pid, claim.at)) return false;
    if (existsSync(pendingPath(root, claim.nonce))) return false;
    const options = lifecycleOptions(root);
    if (readLogoutProof(target.account, target.server, options).state !== 'confirmed') return false;
    const attempts = listAttempts(target.account, target.server, options);
    return attempts.length > 0 && !attempts.some(row => !row.receipt || row.receipt.owner.sharedClaimNonce === claim.nonce);
}

function abandonedBeforeNetwork(root: string, claim: FleetAccountClaim, target: ClaimIdentity) {
    if (!claim.pid || savedProcessAlive(claim.pid, claim.at) || !owningCheckout(root, claim, target.side)) return;
    let pending: {claim: string; inherited?: FleetSwarmClaim; inheritedHead?:string};
    try { pending = JSON.parse(readFileSync(pendingPath(root, claim.nonce), 'utf8')); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    if (pending?.claim !== JSON.stringify(claim)) return;
    const attempts = listAttempts(target.account, target.server, lifecycleOptions(root));
    // A missing receipt alone proves nothing. Require the pre-push marker and refuse if
    // any receipt is unreadable or could belong to the marked attempt.
    if (attempts.some(row => !row.receipt || row.receipt.owner.sharedClaimNonce === claim.nonce)) return;
    return pending;
}

function abandonedPending(root: string, claim: FleetAccountClaim, target: ClaimIdentity): { inherited?: FleetSwarmClaim; inheritedHead?:string } | undefined {
    const pending=abandonedBeforeNetwork(root,claim,target);
    if(!pending)return;
    if (!pending.inherited) return {};
    if (!isSwarmClaim(claim)) return;
    const prior = parseClaim(JSON.stringify(pending.inherited), claim.account, claim.server);
    if (isSwarmClaim(prior) && prior.phase === 'held' && prior.checkout === claim.checkout
        && prior.side === claim.side && prior.host === claim.host && prior.nonce !== claim.nonce) return {inherited: prior};
}

function writePending(root: string, claim: FleetAccountClaim, inherited?: FleetSwarmClaim, inheritedHead?:string) {
    mkdirSync(pendingDir(root), {recursive: true});
    writeFileSync(pendingPath(root, claim.nonce), JSON.stringify({claim: JSON.stringify(claim), inherited, inheritedHead}), {flag: 'wx'});
}

function forgetPending(root: string, nonce: string) {
    try { unlinkSync(pendingPath(root, nonce)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function cleanPending(root: string, nonce: string) {
    try { forgetPending(root, nonce); }
    catch { console.error('could not clean superseded fleet admission marker'); }
}

// The caller supplies the exact nonce only after it proves settlement and logout,
// or proves that the held attempt never connected. A stale caller cannot clear a new claim.
export function releaseFleetTradeClaim(root: string, target: Identity & { nonce: string }, now = Date.now, options: TradePushOptions = {}): void {
    const { account, server } = identity(target), git = gitForTrade(root, undefined, options.gitWindow);
    const { ref, head, claim } = loadClaim(git, account, server);
    if (!claim || isSwarmClaim(claim) || claim.nonce !== target.nonce) throw Error('fleet trade claim changed');
    if (claim.phase === 'released') return;
    commitAndPushTradeClaim(root, git, ref, head, 'Fleet trade released', { ...claim, phase: 'released', at: now() }, options);
}

// The caller proves every trade's outcome and logout before releasing a group. One remote transaction keeps a
// reconciled pair together: a changed ref refuses the entire push, and a lost response can be checked by nonce.
export function releaseFleetTradeClaims(root: string, targets: readonly (Identity & { nonce: string })[], now = Date.now, { wait = claimPause, gitWindow = fleetGitWindow }: TradePushOptions = {}): number {
    if (!targets.length) return 0;
    const git = gitForTrade(root, undefined, gitWindow), seen = new Set<string>();
    const pending = targets.flatMap(target => {
        const { account, server } = identity(target);
        if (seen.has(account)) throw Error('duplicate fleet trade release account');
        seen.add(account);
        const { ref, head, claim } = loadClaim(git, account, server);
        if (!claim || isSwarmClaim(claim) || claim.nonce !== target.nonce) throw Error('fleet trade claim changed');
        return claim.phase === 'held' ? [{ ref, head, claim }] : [];
    });
    if (!pending.length) return 0;
    const at = now();
    const updates = pending.map(({ ref, head, claim }) => {
        const commit = commitClaimWithFallback(git, head, 'Fleet trade released\n\n' + JSON.stringify({ ...claim, phase: 'released', at }), EMPTY_TREE);
        return commit + ':' + ref;
    });
    retryAttempt(() => gitForTrade(root, SWARM_CLAIM_PUSH_MS, gitWindow)(['-c', 'push.followTags=false', 'push', '--quiet', '--atomic', 'origin', ...updates]), fleetPushRetryable, SWARM_CLAIM_TRIES, wait);
    return pending.length;
}

function claimRefusal(
    root: string,
    claim: FleetAccountClaim | null,
    input: ClaimIdentity,
    pending: ReturnType<typeof abandonedPending>,
    ownerAlive: (pid: number, savedAt: number) => boolean = savedProcessAlive,
): string | undefined {
    if (claim?.phase !== 'held' || (pending && !pending.inherited)) return;
    if (!isSwarmClaim(claim)) return 'fleet trade claim held for order ' + claim.orderId;
    if (matchedWorkerProof(root, claim, input)?.state === 'confirmed') return;
    if (orphanedConfirmedPreNetworkClaim(root, claim, input, ownerAlive)) return;
    return 'fleet account claim held by swarm';
}

// The refusal that a trade login (acquireFleetTradeClaim) gives for this claim of `input.account`, or undefined when
// the login can take it. A controller checks it before it starts a trade, so it does not log in an account to be refused.
export function fleetTradeClaimRefusal(
    root: string,
    claim: FleetAccountClaim | null,
    input: ClaimIdentity,
    ownerAlive: (pid: number, savedAt: number) => boolean = savedProcessAlive,
): string | undefined {
    const { account, server } = identity(input), target = { ...input, account, server };
    return claimRefusal(root, claim, target, claim?.phase === 'held' ? abandonedPending(root, claim, target) : undefined, ownerAlive);
}

export const isFleetSwarmClaim = (claim: FleetAccountClaim): boolean => isSwarmClaim(claim);

// Acquisition is the durable attempt intent. A held claim has no wall-clock
// timeout, since a killed client can leave its transfer or logout uncertain.
export function acquireFleetTradeClaim(root: string, input: TradeClaimInput, now = Date.now, options: TradePushOptions = {}) {
    const { account, server } = identity(input);
    const { side, orderId, role } = input;
    if (!SIDE_NAME.test(side) || !ORDER_ID.test(orderId) || (role !== 'from' && role !== 'to')) throw Error('invalid fleet trade claim order');
    const git = gitForTrade(root, undefined, options.gitWindow), { ref, head, claim } = loadClaim(git, account, server);
    const pending = claim?.phase === 'held' ? abandonedPending(root, claim, input) : undefined;
    const refused = claimRefusal(root, claim, input, pending);
    if (refused) throw Error(refused);
    const key = createHash('sha256').update(JSON.stringify([orderId.toLowerCase(), role])).digest('hex');
    const subject = 'Fleet trade attempt ' + key;
    // One attempt for each order role, so that no order is traded two times. The one exception: the head is the claim
    // of this checkout for the same order role, and it never reached the network (its marker from before the push is
    // there and its process is gone). That attempt traded nothing. A claim push that times out for its client can
    // reach the remote: with no exception, each later try of the order reads "already claimed" to the end of its window.
    const sameAbandoned = !!pending && !pending.inherited && !!claim && !isSwarmClaim(claim)
        && claim.orderId.toLowerCase() === orderId.toLowerCase() && claim.role === role;
    const earlier = head ? git(['log', '-1', '--format=%H', '--fixed-strings', '--grep=' + subject, head]) : '';
    if (earlier && !(sameAbandoned && earlier === head)) throw Error('fleet trade order role already claimed');
    const record: FleetTradeClaim = { account, server, side, orderId, role, nonce: randomUUID(), phase: 'held', at: now(), ...claimOwner(root) };
    writePending(root, record);
    commitAndPushTradeClaim(root, git, ref, head, subject, record, options);
    if (pending && claim) cleanPending(root, claim.nonce);
    return {
        ...record,
        armNetwork: () => forgetPending(root, record.nonce),
        release: () => {
            releaseFleetTradeClaim(root, record, now, options);
            cleanPending(root, record.nonce);
        },
    };
}

// A swarm claim outlives its container: only the owning checkout can prove the logout, and a container that is gone
// never will. The claim of ANOTHER side may be replaced once that side's controller lease has gone unrenewed, and the
// claim itself has stood, for ORPHAN_CLAIM_MS. By then the side's workers have refused logins for most of that time
// (FLEET_LEASE_TTL_MS is 10 minutes) and the game server has dropped a session with no client. Trade claims never
// qualify. openBot admits only accounts fleet/owners.json gives to the caller's side (fleet.ts assertSideOwns).
// A claim of the caller's own side taken by ANOTHER checkout (a container of this side that is gone) is orphaned on the
// same terms, judged by that checkout's own renewals: its newest record on the side's lease ref is an hour old, or it
// has none there while another checkout now holds the lease. A fresh container of a side thus takes over the accounts
// its dead predecessor left held. A side with no lease ref still gives no takeover; the caller's own checkout
// recovers its claims through session recovery, never here.
export const ORPHAN_CLAIM_MS = 60 * 60_000;
function orphanedSwarmClaim(git: ReturnType<typeof fleetGitWindow>, claim: FleetSwarmClaim, side: string, now: number, checkout: string): boolean {
    if (now - claim.at < ORPHAN_CLAIM_MS) return false;
    if (claim.side === side) {
        if (claim.checkout === checkout) return false;
        const { head, seen } = fleetCheckoutLastSeen(git, side, claim.checkout);
        if (!head) return false;
        return seen === null ? head.holder !== claim.checkout : now - seen >= ORPHAN_CLAIM_MS;
    }
    const seen = fleetLeaseLastSeen(git, claim.side);
    return seen !== null && now - seen >= ORPHAN_CLAIM_MS;
}

function qualifiedHostProof(root:string,claim:FleetSwarmClaim,target:ClaimIdentity,authorized:ReturnType<typeof assertSpentRecoveryConnection>,git:ReturnType<typeof fleetGitWindow>,now:number){
    if(claim.side!==target.side||claim.checkout!==fleetCheckoutId(root)||claim.host===hostname())return;
    const proof=readLogoutProof(target.account,target.server,lifecycleOptions(root));
    const producer=proof.state==='held'?listAttempts(target.account,target.server,lifecycleOptions(root)).find(a=>a.attemptId===proof.attemptId):undefined;
    if(proof.state!=='held'||authorized.previous?.attemptId!==proof.attemptId||authorized.previous.sha256!==producer?.sha256
        ||producer?.receipt?.owner.sharedClaimNonce!==claim.nonce||producer.receipt.owner.pid!==claim.pid)return;
    const lease=recoveryHostLease(git,target.side,claim.checkout,claim.host,now);
    if(lease&&claim.at<=lease.previous.at+FLEET_LEASE_TTL_MS&&producer.receipt.createdAt<=lease.previous.at+FLEET_LEASE_TTL_MS
        &&fleetLeaseAllowsWorker(root,target.side+':'+lease.current.epoch,now))return proof;
}

function pendingHostWitness(root:string,head:string,inherited:FleetSwarmClaim,witness:string|undefined,target:ClaimIdentity,git:ReturnType<typeof fleetGitWindow>){
    const {account,server}=identity(target);
    const parents=git(['show','-s','--format=%P',head]).split(/\s+/);
    // Legacy first-interruption markers bind directly to the original parent.
    witness??=parents.length===1?parents[0]:undefined;
    if(!witness||! /^[0-9a-f]{40}$/.test(witness)||git(['show','-s','--format=%b',witness])!==JSON.stringify(inherited))return;
    git(['merge-base','--is-ancestor',witness,head]);
    const attempts=listAttempts(target.account,target.server,lifecycleOptions(root));
    if(attempts.some(a=>!a.receipt))return;
    const rows=git(['rev-list','--parents',head,'^'+witness]).split('\n'),seen=new Set<string>();
    let cursor=head;
    for(const row of rows){
        const [commit,parent,...extra]=row.split(/\s+/);
        if(commit!==cursor||!parent||extra.length)return;
        const claim=parseClaim(git(['show','-s','--format=%b',commit!]),account,server);
        if(!isSwarmClaim(claim)||claim.phase!=='held'||!owningCheckout(root,claim,target.side)||claim.nonce===inherited.nonce||seen.has(claim.nonce)
            ||savedProcessAlive(claim.pid,claim.at)||attempts.some(a=>a.receipt!.owner.sharedClaimNonce===claim.nonce))return;
        seen.add(claim.nonce);cursor=parent;
    }
    if(cursor===witness)return witness;
}

// The budgets of a swarm login claim. The claim is a child commit on the account's ref, so two fleet sides cannot both
// hold one account. One window for the reads and the push ends before the push on a machine under load, and the login
// then fails with `spawnSync git ETIMEDOUT`. A patient claim gives the reads, the commit and the push their own
// windows and tries the reads and the push again, SWARM_CLAIM_TRIES times at most, after a failure that says nothing
// about the ref. Its longest wait is about 130 s: 3 reads and 1 commit of 15 s, 3 pushes of 20 s and the pauses.
export function acquireFleetSwarmClaim(root: string, input: ClaimIdentity, { recover = false, admission=undefined as RecoveryConnectionAdmission|undefined, now = Date.now, ownerAlive = savedProcessAlive as (pid: number, savedAt: number) => boolean,
    patient = false, gitWindow = fleetGitWindow, wait = claimPause } = {}) {
    const { account, server } = identity(input), { side } = input;
    if (!SIDE_NAME.test(side)) throw Error('invalid fleet swarm claim side');
    const authorized=admission?assertSpentRecoveryConnection(admission,account,server,root):undefined;
    const authority = 'fleet swarm claim authority', tries = patient ? SWARM_CLAIM_TRIES : 1;
    // An action that changes nothing, or changes the same thing, is tried again after a failure that says nothing about the ref.
    const again = <T>(action: () => T, retryable = fleetGitRetryable): T => retryAttempt(action, retryable, tries, wait);
    // A login under the plan lock keeps the one short window for its reads and its push.
    let git = gitWindow(root, authority, patient ? SWARM_CLAIM_READ_MS : undefined);
    const read = (git: ReturnType<typeof gitForTrade>) => {
        const { ref, head, claim: current } = loadClaim(git, account, server);
        let pending = current?.phase === 'held' ? abandonedPending(root, current, input) : undefined;
        // A qualified child may die after pushing its claim but before recording intent.
        // Only its exact durable marker and linear Git witness can carry the foreign-host hold
        // forward; the spent admission and retired host lease must still authorize it.
        if(!pending&&recover&&authorized&&current?.phase==='held'&&isSwarmClaim(current)){
            const marker=abandonedBeforeNetwork(root,current,input);
            if(marker?.inherited){
                const inherited=parseClaim(JSON.stringify(marker.inherited),account,server);
                if(head&&isSwarmClaim(inherited)&&inherited.phase==='held'&&inherited.nonce!==current.nonce
                    &&qualifiedHostProof(root,inherited,input,authorized,git,now())){
                    const inheritedHead=pendingHostWitness(root,head,inherited,marker.inheritedHead,input,git);
                    if(inheritedHead)pending={inherited,inheritedHead};
                }
            }
        }
        const claim = pending ? pending.inherited : current;
        let inheritedHold: FleetSwarmClaim | undefined, inheritedHead:string|undefined, orphan: FleetSwarmClaim | undefined;
        if (claim?.phase === 'held') {
            if (!isSwarmClaim(claim)) throw Error('fleet trade claim held for order ' + claim.orderId);
            let prior = matchedWorkerProof(root, claim, input),continuedHost=false;
            if(!prior&&recover&&authorized){prior=qualifiedHostProof(root,claim,input,authorized,git,now());continuedHost=!!prior;}
            if(authorized&&!prior)throw Error('qualified recovery claim identity or host continuation unavailable');
            if (!prior && orphanedSwarmClaim(git, claim, side, now(), fleetCheckoutId(root))) orphan = claim;
            else if (!prior && orphanedConfirmedPreNetworkClaim(root, claim, input, ownerAlive)) orphan = claim;
            // A recovery takes a held claim only from an owner that is gone. The claim's time tells its owner from a later
            // process with the same id (savedProcessAlive).
            else if (!prior || (prior.state !== 'confirmed' && !(recover && (continuedHost||!ownerAlive(claim.pid, claim.at))))) {
                throw Error('fleet account claim held by swarm');
            }
            if (prior?.state === 'held') inheritedHold = claim;
            if(continuedHost)inheritedHead=pending?.inheritedHead??head;
        }
        return { ref, head, current, pending, orphan, inheritedHold, inheritedHead };
    };
    for (let casAttempt = 1; casAttempt <= tries; casAttempt++) {
        if (casAttempt > 1) git = gitWindow(root, authority, SWARM_CLAIM_READ_MS);
        const { ref, head, current, pending, orphan, inheritedHold, inheritedHead } = again(() => { try { return read(git); } catch (error) { git = gitWindow(root, authority, SWARM_CLAIM_READ_MS); throw error; } });
        const record: FleetSwarmClaim = { kind: 'swarm', account, server, side, ...claimOwner(root), nonce: randomUUID(), phase: 'held', at: now() };
        writePending(root, record, inheritedHold,inheritedHead);
        const subject = orphan ? `Fleet swarm attempt, replacing the orphaned ${orphan.side} claim ${orphan.nonce}` : 'Fleet swarm attempt';
        let owned: string;
        if (!patient) {
            owned = commitClaim(git, head, subject, record);
            retryAttempt(() => pushFleetGitRecord(git, ref, owned), isRemoteBusyPush, SWARM_CLAIM_TRIES, wait, REMOTE_BUSY_PAUSE_MS);
        } else {
            // One record, made one time. A push that timed out can have reached the remote, and the same commit pushed again
            // is then no change. A push that the fast-forward rule rejected means that another writer has the ref: it is
            // never pushed again, unless a lagged ref check caught our own checkout releasing the held claim we read.
            owned = commitClaim(gitWindow(root, authority, SWARM_CLAIM_READ_MS), head, subject, record);
            try {
                again(() => pushFleetGitRecord(gitWindow(root, authority, SWARM_CLAIM_PUSH_MS), ref, owned), fleetPushRetryable);
            } catch (error) {
                if (casAttempt >= tries || fleetPushRetryable(error)) throw error;
                cleanPending(root, record.nonce);
                wait(SWARM_CLAIM_PAUSE_MS);
                const after = again(() => loadClaim(gitWindow(root, authority, SWARM_CLAIM_READ_MS), account, server));
                if (after.head !== head && after.claim && isSwarmClaim(after.claim) && after.claim.phase === 'released'
                    && owningCheckout(root, after.claim, side) && current && isSwarmClaim(current) && after.claim.nonce === current.nonce) {
                    continue;
                }
                throw error;
            }
        }
        if (pending && current) cleanPending(root, current.nonce);
        let released = false;
        const release = (restore?: FleetSwarmClaim) => {
            if (released) return;
            const releaseSubject = restore ? 'Fleet swarm inherited hold restored' : 'Fleet swarm released';
            const releaseBody = restore ?? { ...record, phase: 'released', at: now() };
            if (!patient) {
                const releaseGit = gitWindow(root, authority, 4000);
                const rel = commitClaim(releaseGit, owned, releaseSubject, releaseBody);
                retryAttempt(() => pushFleetGitRecord(releaseGit, ref, rel), isRemoteBusyPush, SWARM_CLAIM_TRIES, wait, REMOTE_BUSY_PAUSE_MS);
            } else {
                const rel = commitClaim(gitWindow(root, authority, SWARM_CLAIM_READ_MS), owned, releaseSubject, releaseBody);
                again(() => pushFleetGitRecord(gitWindow(root, authority, SWARM_CLAIM_PUSH_MS), ref, rel), fleetPushRetryable);
            }
            released = true;
            cleanPending(root, record.nonce);
        };
        return {
            nonce: record.nonce,
            armNetwork: () => forgetPending(root, record.nonce),
            abortBeforeNetwork: () => release(inheritedHold),
            releaseAfterLogout(attemptId: string) {
                const latest = matchedWorkerProof(root, record, input);
                if (latest?.state !== 'confirmed' || latest.attemptId !== attemptId) throw Error('fleet swarm claim lacks exact logout proof');
                release();
            },
        };
    }
    throw Error('fleet swarm claim attempts exhausted');
}
