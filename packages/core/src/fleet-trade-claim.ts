import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { SIDE_NAME } from './fleet';
import { appendFleetGitRecord, fleetCheckoutId, fleetGitWindow, readFleetGitRefs } from './fleet-lease';
import { listAttempts, readLogoutProof } from './session-lifecycle';
import { pidAlive } from './session-takeover';

type Identity = { account: string; server: string };
type ClaimIdentity = Identity & { side: string };
type TradeClaimInput = ClaimIdentity & { orderId: string; role: 'from' | 'to' };
type ClaimState = { nonce: string; phase: 'held' | 'released'; at: number };
type ClaimOwner = { checkout: string; host: string; pid: number };
export type FleetTradeClaim = TradeClaimInput & ClaimState & Partial<ClaimOwner>;
type FleetSwarmClaim = ClaimIdentity & ClaimState & ClaimOwner & { kind: 'swarm' };
type FleetAccountClaim = FleetTradeClaim | FleetSwarmClaim;

const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT = /^[a-z0-9_-]{1,12}$/;
const SERVER = /^[a-z0-9][a-z0-9.:-]{0,252}$/;
const CLAIM_PREFIX = 'refs/heads/fleet-trade-claim/';
const gitForTrade = (root: string) => fleetGitWindow(root, 'fleet trade claim authority');

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

function loadClaim(git: ReturnType<typeof gitForTrade>, account: string, server: string) {
    // The owner registry names accounts globally. Keep one ref for that identity,
    // including when stale callers disagree on its server or side.
    const ref = CLAIM_PREFIX + account, head = readFleetGitRefs(git, [ref]).get(ref);
    if (!head) return { ref, head, claim: null };
    git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', 'origin', head]);
    const claim = parseClaim(git(['show', '-s', '--format=%b', head]), account, server);
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
    git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', 'origin', ...heads]);
    const rows = git(['show', '-s', '--format=%H%x00%b%x00', ...heads]).split('\0');
    const held: FleetTradeClaim[] = [];
    while (rows.length > 1) {
        const head = rows.shift()!.trim(), raw = rows.shift()!, account = pending.get(head);
        if (!account) throw Error('fleet trade claim authority has an unexpected record');
        const claim = parseClaim(raw, account);
        if (claim.phase === 'held' && !isSwarmClaim(claim)) held.push(claim);
        pending.delete(head);
    }
    if (pending.size || rows[0]?.trim()) throw Error('fleet trade claim authority has incomplete records');
    return held;
}

function appendClaim(git: ReturnType<typeof gitForTrade>, ref: string, head: string | undefined, subject: string, claim: FleetAccountClaim) {
    const tree = git(['hash-object', '-w', '-t', 'tree', '--stdin'], '');
    return appendFleetGitRecord(git, ref, head, tree, subject + '\n\n' + JSON.stringify(claim));
}

const pendingDir = (root: string) => join(root, '.practice', 'fleet-account-pending');
const pendingPath = (root: string, nonce: string) => join(pendingDir(root), nonce + '.json');
const lifecycleOptions = (root: string) => ({root: join(root, '.practice/session-lifecycle')});
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

function abandonedPending(root: string, claim: FleetAccountClaim, target: ClaimIdentity): { inherited?: FleetSwarmClaim } | undefined {
    if (!claim.pid || pidAlive(claim.pid) || !owningCheckout(root, claim, target.side)) return;
    let pending: {claim: string; inherited?: FleetSwarmClaim};
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
    if (!pending.inherited) return {};
    if (!isSwarmClaim(claim)) return;
    const prior = parseClaim(JSON.stringify(pending.inherited), claim.account, claim.server);
    if (isSwarmClaim(prior) && prior.phase === 'held' && prior.checkout === claim.checkout
        && prior.side === claim.side && prior.host === claim.host && prior.nonce !== claim.nonce) return {inherited: prior};
}

function writePending(root: string, claim: FleetAccountClaim, inherited?: FleetSwarmClaim) {
    mkdirSync(pendingDir(root), {recursive: true});
    writeFileSync(pendingPath(root, claim.nonce), JSON.stringify({claim: JSON.stringify(claim), inherited}), {flag: 'wx'});
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
export function releaseFleetTradeClaim(root: string, target: Identity & { nonce: string }, now = Date.now): void {
    const { account, server } = identity(target), git = gitForTrade(root);
    const { ref, head, claim } = loadClaim(git, account, server);
    if (!claim || isSwarmClaim(claim) || claim.nonce !== target.nonce) throw Error('fleet trade claim changed');
    if (claim.phase === 'released') return;
    appendClaim(git, ref, head, 'Fleet trade released', { ...claim, phase: 'released', at: now() });
}

// Acquisition is the durable attempt intent. A held claim has no wall-clock
// timeout, since a killed client can leave its transfer or logout uncertain.
export function acquireFleetTradeClaim(root: string, input: TradeClaimInput, now = Date.now) {
    const { account, server } = identity(input);
    const { side, orderId, role } = input;
    if (!SIDE_NAME.test(side) || !ORDER_ID.test(orderId) || (role !== 'from' && role !== 'to')) throw Error('invalid fleet trade claim order');
    const git = gitForTrade(root), { ref, head, claim } = loadClaim(git, account, server);
    const pending = claim?.phase === 'held' ? abandonedPending(root, claim, input) : undefined;
    if (claim?.phase === 'held' && !(pending && !pending.inherited)) {
        if (!isSwarmClaim(claim)) throw Error('fleet trade claim held for order ' + claim.orderId);
        if (matchedWorkerProof(root, claim, input)?.state !== 'confirmed') throw Error('fleet account claim held by swarm');
    }
    const key = createHash('sha256').update(JSON.stringify([orderId.toLowerCase(), role])).digest('hex');
    const subject = 'Fleet trade attempt ' + key;
    if (head && git(['log', '-1', '--format=%H', '--fixed-strings', '--grep=' + subject, head])) throw Error('fleet trade order role already claimed');
    const record: FleetTradeClaim = { account, server, side, orderId, role, nonce: randomUUID(), phase: 'held', at: now(), ...claimOwner(root) };
    writePending(root, record);
    appendClaim(git, ref, head, subject, record);
    if (pending && claim) cleanPending(root, claim.nonce);
    return {
        ...record,
        armNetwork: () => forgetPending(root, record.nonce),
        release: () => {
            releaseFleetTradeClaim(root, record, now);
            cleanPending(root, record.nonce);
        },
    };
}

export function acquireFleetSwarmClaim(root: string, input: ClaimIdentity, { recover = false, now = Date.now } = {}) {
    const { account, server } = identity(input), { side } = input;
    if (!SIDE_NAME.test(side)) throw Error('invalid fleet swarm claim side');
    const git = fleetGitWindow(root, 'fleet swarm claim authority');
    const { ref, head, claim: current } = loadClaim(git, account, server);
    const pending = current?.phase === 'held' ? abandonedPending(root, current, input) : undefined;
    const claim = pending ? pending.inherited : current;
    let inheritedHold: FleetSwarmClaim | undefined;
    if (claim?.phase === 'held') {
        if (!isSwarmClaim(claim)) throw Error('fleet trade claim held for order ' + claim.orderId);
        const prior = matchedWorkerProof(root, claim, input);
        if (!prior || (prior.state !== 'confirmed' && !(recover && !pidAlive(claim.pid)))) {
            throw Error('fleet account claim held by swarm');
        }
        if (prior.state === 'held') inheritedHold = claim;
    }
    const record: FleetSwarmClaim = { kind: 'swarm', account, server, side, ...claimOwner(root), nonce: randomUUID(), phase: 'held', at: now() };
    writePending(root, record, inheritedHold);
    const owned = appendClaim(git, ref, head, 'Fleet swarm attempt', record);
    if (pending && current) cleanPending(root, current.nonce);
    let released = false;
    const release = (restore?: FleetSwarmClaim) => {
        if (released) return;
        appendClaim(fleetGitWindow(root, 'fleet swarm claim authority', 4000), ref, owned,
            restore ? 'Fleet swarm inherited hold restored' : 'Fleet swarm released',
            restore ?? { ...record, phase: 'released', at: now() });
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
