import { createHash, randomUUID } from 'node:crypto';
import { SIDE_NAME } from './fleet';
import { appendFleetGitRecord, fleetGitWindow, readFleetGitRefs } from './fleet-lease';

type Identity = { account: string; server: string };
type TradeClaimInput = Identity & { side: string; orderId: string; role: 'from' | 'to' };
export type FleetTradeClaim = TradeClaimInput & { nonce: string; phase: 'held' | 'released'; at: number };

const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT = /^[a-z0-9]{1,12}$/;
const SERVER = /^[a-z0-9][a-z0-9.:-]{0,252}$/;
const CLAIM_PREFIX = 'refs/heads/fleet-trade-claim/';
const gitForTrade = (root: string) => fleetGitWindow(root, 'fleet trade claim authority');

function accountName(account: string) {
    if (!/^[A-Za-z0-9]{1,12}$/.test(account)) throw Error('invalid fleet trade claim account');
    return account.toLowerCase();
}

function identity({ account, server }: Identity) {
    server = server.toLowerCase();
    if (!SERVER.test(server)) throw Error('invalid fleet trade claim server');
    return { account: accountName(account), server };
}

function parseClaim(raw: string, account: string, server?: string): FleetTradeClaim {
    let claim: FleetTradeClaim;
    try { claim = JSON.parse(raw); }
    catch { throw Error('fleet trade claim authority has an unreadable record'); }
    if (claim?.account !== account || typeof claim.server !== 'string' || !SERVER.test(claim.server) || (server !== undefined && claim.server !== server)
        || typeof claim.side !== 'string' || !SIDE_NAME.test(claim.side) || typeof claim.orderId !== 'string' || !ORDER_ID.test(claim.orderId)
        || (claim.role !== 'from' && claim.role !== 'to') || typeof claim.nonce !== 'string' || !UUID.test(claim.nonce)
        || (claim.phase !== 'held' && claim.phase !== 'released') || !Number.isSafeInteger(claim.at) || claim.at <= 0) {
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
        if (claim.phase === 'held') held.push(claim);
        pending.delete(head);
    }
    if (pending.size || rows[0]?.trim()) throw Error('fleet trade claim authority has incomplete records');
    return held;
}

function appendClaim(git: ReturnType<typeof gitForTrade>, ref: string, head: string | undefined, subject: string, claim: FleetTradeClaim) {
    const tree = git(['hash-object', '-w', '-t', 'tree', '--stdin'], '');
    return appendFleetGitRecord(git, ref, head, tree, subject + '\n\n' + JSON.stringify(claim));
}

// The caller supplies the exact nonce only after it proves settlement and logout,
// or proves that the held attempt never connected. A stale caller cannot clear a new claim.
export function releaseFleetTradeClaim(root: string, target: Identity & { nonce: string }, now = Date.now): void {
    const { account, server } = identity(target), git = gitForTrade(root);
    const { ref, head, claim } = loadClaim(git, account, server);
    if (!claim || claim.nonce !== target.nonce) throw Error('fleet trade claim changed');
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
    if (claim?.phase === 'held') throw Error('fleet trade claim held for order ' + claim.orderId);
    const key = createHash('sha256').update(JSON.stringify([orderId.toLowerCase(), role])).digest('hex');
    const subject = 'Fleet trade attempt ' + key;
    if (head && git(['log', '-1', '--format=%H', '--fixed-strings', '--grep=' + subject, head])) throw Error('fleet trade order role already claimed');
    const record: FleetTradeClaim = { account, server, side, orderId, role, nonce: randomUUID(), phase: 'held', at: now() };
    appendClaim(git, ref, head, subject, record);
    return { ...record, release: () => releaseFleetTradeClaim(root, record, now) };
}
