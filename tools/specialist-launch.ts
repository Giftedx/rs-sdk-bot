// Deterministic specialist launch CLI: refreshes hiscores, validates a hosted rehearsal receipt against WORKER_RELEASE and 2% margin, builds exact staging JSON from live holder bank/inventory, and writes .practice/specialist-launch/<acct>.json and .go.json.
// Usage: bun tools/specialist-launch.ts <account> --holder <holder> [--dry-run] [--launch] [--receipt <path>] [--bank <path>] [--delivery <path>] [--run-id <id>] [--skip-hiscores]
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { getSpecialistCampaignSpec, isReservedSpecialistAccount } from '../packages/brain/src/campaigns/specialists';
import { writeAtomicFile } from '../packages/core/src/atomic-file';
import { loadOwners } from '../packages/core/src/fleet';
import { fresh, localFile, sha, type Binding, type SupplyRequirement } from '../packages/core/src/launch-evidence';
import { liveFleetDataDir, liveRoot, operatorCommandsDir, practiceRoot, resolveFleetDataDir, statusReadDirs } from '../packages/core/src/practice-paths';
import { missionSignature } from '../packages/core/src/session-admission';
import {
    evaluateSpecialist,
    MAX_SPECIALIST_RUN_MS,
    SPECIALIST_BOARDS,
    specialistContext,
    specialistTokenPath,
} from '../packages/core/src/specialist-launch';
import { capabilityRevision, releaseFiles, workerEntries } from '../packages/core/src/worker-release';
import { FLEET } from '../scripts/fleet';

const LIVE_SERVER = 'rs-sdk-demo.fly.dev';
const HOUR_MS = 3_600_000;
const REHEARSAL_MAX_AGE_MS = 7 * 86_400_000;
const ACCOUNT_NAME_RE = /^[A-Za-z0-9_ -]{1,12}$/;
const RUN_ID_RE = /^[a-z0-9-]{1,96}$/;

export interface SpecialistLaunchCliArgs {
    readonly account: string;
    readonly holder?: string;
    readonly dryRun: boolean;
    readonly launch: boolean;
    readonly skipHiscores: boolean;
    readonly receiptPath?: string;
    readonly bankPath?: string;
    readonly deliveryPath?: string;
    readonly runId?: string;
}

export type SpawnSyncFn = (cmd: string[], cwd: string) => { exitCode: number; stdout: string; stderr: string };

const defaultSpawnSync: SpawnSyncFn = (cmd, cwd) => {
    const res = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    return {
        exitCode: res.exitCode ?? 1,
        stdout: res.stdout?.toString() ?? '',
        stderr: res.stderr?.toString() ?? '',
    };
};

export function parseSpecialistLaunchArgs(argv: readonly string[]): SpecialistLaunchCliArgs {
    let account = '';
    let holder: string | undefined;
    let dryRun = false;
    let launch = false;
    let skipHiscores = false;
    let receiptPath: string | undefined;
    let bankPath: string | undefined;
    let deliveryPath: string | undefined;
    let runId: string | undefined;

    const takeValue = (flag: string, inline: string | undefined, idx: number): { val: string; nextIdx: number } => {
        if (inline !== undefined) {
            if (!inline) throw Error(`specialist-launch: ${flag} requires a value`);
            return { val: inline, nextIdx: idx };
        }
        const next = argv[idx + 1];
        if (!next || next.startsWith('--')) throw Error(`specialist-launch: ${flag} requires a value`);
        return { val: next, nextIdx: idx + 1 };
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--dry-run') dryRun = true;
        else if (arg === '--launch') launch = true;
        else if (arg === '--skip-hiscores') skipHiscores = true;
        else if (arg === '--holder' || arg.startsWith('--holder=')) {
            const { val, nextIdx } = takeValue('--holder', arg.startsWith('--holder=') ? arg.slice(9) : undefined, i);
            holder = val;
            i = nextIdx;
        } else if (arg === '--receipt' || arg.startsWith('--receipt=')) {
            const { val, nextIdx } = takeValue('--receipt', arg.startsWith('--receipt=') ? arg.slice(10) : undefined, i);
            receiptPath = val;
            i = nextIdx;
        } else if (arg === '--bank' || arg.startsWith('--bank=')) {
            const { val, nextIdx } = takeValue('--bank', arg.startsWith('--bank=') ? arg.slice(7) : undefined, i);
            bankPath = val;
            i = nextIdx;
        } else if (arg === '--delivery' || arg.startsWith('--delivery=')) {
            const { val, nextIdx } = takeValue('--delivery', arg.startsWith('--delivery=') ? arg.slice(11) : undefined, i);
            deliveryPath = val;
            i = nextIdx;
        } else if (arg === '--run-id' || arg.startsWith('--run-id=')) {
            const { val, nextIdx } = takeValue('--run-id', arg.startsWith('--run-id=') ? arg.slice(9) : undefined, i);
            runId = val;
            i = nextIdx;
        } else if (arg.startsWith('--')) {
            throw Error(`specialist-launch: unknown flag ${arg}`);
        } else if (!account) {
            account = arg;
        } else {
            throw Error(`specialist-launch: unexpected positional argument ${arg}`);
        }
    }

    if (!account) {
        throw Error('usage: bun tools/specialist-launch.ts <account> --holder <holder> [--dry-run] [--launch]');
    }
    const lower = account.toLowerCase();
    if (!Object.hasOwn(SPECIALIST_BOARDS, lower) || !getSpecialistCampaignSpec(lower)) {
        throw Error(`specialist-launch: unknown specialist account "${account}"`);
    }
    if (holder !== undefined) {
        if (!ACCOUNT_NAME_RE.test(holder)) throw Error(`specialist-launch: invalid --holder "${holder}"`);
        if (isReservedSpecialistAccount(holder)) throw Error(`specialist-launch: --holder "${holder}" is a reserved account`);
    }
    if (runId !== undefined && !RUN_ID_RE.test(runId)) {
        throw Error(`specialist-launch: --run-id must match /^[a-z0-9-]{1,96}$/ (got "${runId}")`);
    }

    return {
        account: lower,
        holder,
        dryRun,
        launch,
        skipHiscores,
        receiptPath,
        bankPath,
        deliveryPath,
        runId,
    };
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toRepoRel(root: string, filePath: string): string {
    return relative(root, resolve(root, filePath)).replaceAll('\\', '/');
}

function bindRepoFile(root: string, relPath: string): Binding {
    const bytes = readFileSync(localFile(root, relPath));
    return { path: relPath.replaceAll('\\', '/'), sha256: sha(bytes) };
}

function writeJsonAtomic(filePath: string, data: unknown): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    renameSync(tmp, filePath);
}

interface HiscoreLeader {
    readonly name: string;
    readonly level: number;
    readonly ticks: number;
}

interface ValidatedHiscore {
    readonly takenAt: number;
    readonly profileAt: number;
    readonly leader: HiscoreLeader;
    readonly snapshotPath: string;
}

export function validateHiscoreSnapshot(
    root: string,
    account: string,
    now: number,
): ValidatedHiscore {
    const snapshotRel = '.practice/specialist-launch/hiscores.json';
    const snapshotAbs = join(root, snapshotRel);
    if (!existsSync(snapshotAbs)) {
        throw Error(`missing hiscore snapshot at ${snapshotRel}`);
    }
    const snapshot = JSON.parse(readFileSync(snapshotAbs, 'utf8')) as Record<string, unknown>;
    const takenAt = typeof snapshot.takenAt === 'string' ? Date.parse(snapshot.takenAt) : NaN;
    if (snapshot.base !== `https://${LIVE_SERVER}` || snapshot.tickMs !== 400 || !fresh(takenAt, now, HOUR_MS)) {
        throw Error('hiscores.json must be a live 400 ms snapshot under one hour old');
    }
    const board = SPECIALIST_BOARDS[account]!;
    const boards = Array.isArray(snapshot.boards)
        ? snapshot.boards.filter((b): b is Record<string, unknown> => isPlainRecord(b) && b.board === board.name && b.category === board.category)
        : [];
    if (boards.length !== 1 || !Array.isArray(boards[0]!.rows)) {
        throw Error(`hiscores.json missing board ${board.name} (category ${board.category})`);
    }
    const rows = boards[0]!.rows as Array<Record<string, unknown>>;
    if (rows.some((r) => typeof r?.name === 'string' && r.name.toLowerCase() === account)) {
        throw Error(`specialist ${account} already appears on ${board.name}`);
    }
    const leader = rows[0];
    if (
        !leader ||
        leader.rank !== 1 ||
        !Number.isSafeInteger(leader.ticks) ||
        Number(leader.ticks) <= 0 ||
        !Number.isSafeInteger(leader.level) ||
        Number(leader.level) <= 0 ||
        Number(leader.level) > 99 ||
        typeof leader.name !== 'string' ||
        !leader.name
    ) {
        throw Error(`hiscores.json missing valid #1 record for ${board.name}`);
    }
    const profiles = Array.isArray(snapshot.profiles)
        ? snapshot.profiles.filter((p): p is Record<string, unknown> => isPlainRecord(p) && p.name === account)
        : [];
    const profile = profiles[0];
    if (profiles.length !== 1 || profile?.status !== 404 || !fresh(profile.at, now, HOUR_MS)) {
        throw Error(`hiscores.json lacks a fresh 404 profile observation for ${account}`);
    }
    return {
        takenAt,
        profileAt: profile.at as number,
        leader: {
            name: leader.name,
            level: Number(leader.level),
            ticks: Number(leader.ticks),
        },
        snapshotPath: snapshotRel,
    };
}

export function discoverReceiptPath(root: string, account: string, now: number): string {
    const rehearseRoot = join(practiceRoot(root), 'hosted-rehearse');
    if (!existsSync(rehearseRoot)) {
        throw Error(`missing hosted rehearsal directory .practice/hosted-rehearse/${account}`);
    }
    const dirs = readdirSync(rehearseRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.toLowerCase() === account)
        .map((d) => d.name);
    if (dirs.length === 0) {
        throw Error(`no hosted rehearsal directory found under .practice/hosted-rehearse/ for ${account}`);
    }
    const candidates: { rel: string; at: number }[] = [];
    for (const dirName of dirs) {
        const dirAbs = join(rehearseRoot, dirName);
        for (const file of readdirSync(dirAbs).filter((f) => f.endsWith('.receipt.json')).sort()) {
            const rel = `.practice/hosted-rehearse/${dirName}/${file}`;
            try {
                const json = JSON.parse(readFileSync(join(dirAbs, file), 'utf8')) as Record<string, unknown>;
                if (json.ok === true && json.died === false && json.logout === 'logged-out' && fresh(json.at, now, REHEARSAL_MAX_AGE_MS)) {
                    candidates.push({ rel, at: Number(json.at) });
                }
            } catch {
                // Skip malformed receipts.
            }
        }
    }
    if (candidates.length === 0) {
        throw Error(`no fresh passing *.receipt.json found in .practice/hosted-rehearse/${account}`);
    }
    candidates.sort((a, b) => b.at - a.at || b.rel.localeCompare(a.rel));
    return candidates[0]!.rel;
}

export function assertMatchesMasterWorkerRelease(
    root: string,
    entries: readonly string[],
    spawn: SpawnSyncFn = defaultSpawnSync,
): void {
    if (!existsSync(join(root, '.git'))) return;
    let ref = '';
    for (const candidate of ['master', 'origin/master']) {
        const probe = spawn(['git', 'rev-parse', '--verify', candidate], root);
        if (probe.exitCode === 0) {
            ref = candidate;
            break;
        }
    }
    if (!ref) return;
    const files = releaseFiles(entries, root);
    const diff = spawn(['git', 'diff', '--name-only', ref, '--', ...files], root);
    if (diff.exitCode === 0 && diff.stdout.trim().length > 0) {
        const changed = diff.stdout.trim().split(/\r?\n/).slice(0, 5).join(', ');
        throw Error(`worker release differs from ${ref} (${changed}); merge or switch to ${ref} before launch`);
    }
}

export interface ValidatedRehearsal {
    readonly receiptPath: string;
    readonly receiptBinding: Binding;
    readonly source: string;
    readonly rehearsalMission: string;
    readonly jobMissionHash: string;
    readonly script: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly planTicks: number;
    readonly boardTicks: number;
    readonly requirements: readonly SupplyRequirement[];
    readonly context: string;
    readonly marginRequired: number;
    readonly marginObserved: number;
}

export function validateHostedRehearsalReceipt(
    root: string,
    account: string,
    leader: HiscoreLeader,
    runId: string,
    now: number,
    opts: {
        readonly receiptPath?: string;
        readonly checkMaster?: boolean;
        readonly spawn?: SpawnSyncFn;
    } = {},
): ValidatedRehearsal {
    const spec = getSpecialistCampaignSpec(account);
    if (!spec) throw Error(`unknown specialist campaign spec for ${account}`);
    const board = SPECIALIST_BOARDS[account]!;
    const receiptRel = opts.receiptPath
        ? toRepoRel(root, opts.receiptPath)
        : discoverReceiptPath(root, account, now);
    const receiptBinding = bindRepoFile(root, receiptRel);
    const receipt = JSON.parse(readFileSync(localFile(root, receiptRel), 'utf8')) as Record<string, unknown>;

    if (receipt.version !== 2 || receipt.ok !== true || receipt.died !== false || receipt.logout !== 'logged-out') {
        throw Error(`rehearsal receipt ${receiptRel} is not a passing v2 logged-out receipt`);
    }
    if (!fresh(receipt.at, now, REHEARSAL_MAX_AGE_MS)) {
        throw Error(`rehearsal receipt ${receiptRel} is stale or future-dated`);
    }

    let script = spec.script;
    let args = [...(spec.defaultArgs ?? [])];
    let env: Record<string, string> = { ...(spec.defaultEnv ?? {}), CAP: spec.defaultEnv?.CAP ?? '1600' };
    const segRel = `.practice/hosted-rehearse/${account}.segment.json`;
    const segAbs = join(root, segRel);
    if (existsSync(segAbs)) {
        try {
            const seg = JSON.parse(readFileSync(segAbs, 'utf8')) as Record<string, unknown>;
            if (typeof seg.script === 'string' && seg.script === spec.script) {
                script = seg.script;
                args = Array.isArray(seg.args) ? seg.args.filter((a): a is string => typeof a === 'string') : [];
                if (isPlainRecord(seg.env)) {
                    const segEnv: Record<string, string> = {};
                    for (const [k, v] of Object.entries(seg.env)) {
                        if (typeof v === 'string') segEnv[k] = v;
                    }
                    env = { ...segEnv, CAP: segEnv.CAP ?? '1600' };
                }
            }
        } catch {
            // Fall back to declarative spec when segment file is unreadable.
        }
    }

    const entries = workerEntries(script, args, root);
    if (opts.checkMaster !== false) {
        assertMatchesMasterWorkerRelease(root, entries, opts.spawn);
    }
    const source = capabilityRevision(entries, root);
    const rehearsalMission = missionSignature({
        account,
        script,
        args,
        env: { ...env, COORDINATOR_RUN_ID: '' },
    });

    const requirements: SupplyRequirement[] = Array.isArray(receipt.externalSupplies)
        ? (receipt.externalSupplies as SupplyRequirement[])
        : [];
    const expectedContext = specialistContext(account, source, rehearsalMission, requirements);
    if (receipt.context !== expectedContext) {
        throw Error(
            `rehearsal receipt ${receiptRel} context (${String(receipt.context)}) does not match current WORKER_RELEASE (${source})`,
        );
    }

    const boardTicksRaw = isPlainRecord(receipt.boardTicks) ? receipt.boardTicks[board.name] : undefined;
    const boardTicks = typeof boardTicksRaw === 'number' && Number.isSafeInteger(boardTicksRaw) && boardTicksRaw > 0
        ? boardTicksRaw
        : 0;
    if (boardTicks <= 0) {
        throw Error(`rehearsal receipt ${receiptRel} missing valid boardTicks.${board.name}`);
    }
    const planTicks = typeof receipt.planTicks === 'number' && Number.isSafeInteger(receipt.planTicks) && receipt.planTicks > 0
        ? receipt.planTicks
        : (spec.planTicks ?? boardTicks);

    const marginRequired = leader.level === 99 ? Math.ceil(leader.ticks * 0.02) : 1;
    const marginObserved = leader.ticks - Math.max(planTicks, boardTicks);
    if (marginObserved < marginRequired) {
        throw Error(
            `${board.name} clocks (${Math.max(planTicks, boardTicks)}t) fail 2% margin (${marginRequired}t) against #1 ${leader.name} (${leader.ticks}t)`,
        );
    }

    const jobMissionHash = sha(
        missionSignature({
            account,
            script,
            args,
            env: { ...env, FLEET_RUN_ID: runId },
        }),
    );

    return {
        receiptPath: receiptRel,
        receiptBinding,
        source,
        rehearsalMission,
        jobMissionHash,
        script,
        args,
        env,
        planTicks,
        boardTicks,
        requirements,
        context: expectedContext,
        marginRequired,
        marginObserved,
    };
}

interface ItemEntry {
    readonly id: number;
    readonly baseId?: number;
    readonly name?: string;
    readonly count: number;
}

interface HolderBankSnapshot {
    readonly name: string;
    readonly server: string;
    readonly bankAt: number;
    readonly bank: readonly ItemEntry[];
    readonly inventory: readonly ItemEntry[];
    readonly sourcePath?: string;
}

function normalizeItemRows(raw: unknown): ItemEntry[] {
    if (!Array.isArray(raw)) return [];
    const out: ItemEntry[] = [];
    for (const row of raw) {
        if (!isPlainRecord(row)) continue;
        const id = typeof row.id === 'number' ? row.id : -1;
        const count = typeof row.count === 'number' ? row.count : 0;
        if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(count) || count <= 0) continue;
        const baseId = typeof row.baseId === 'number' && Number.isSafeInteger(row.baseId) && row.baseId >= 0 ? row.baseId : undefined;
        out.push({
            id,
            ...(baseId !== undefined ? { baseId } : {}),
            ...(typeof row.name === 'string' ? { name: row.name } : {}),
            count,
        });
    }
    return out;
}

function sumItemId(items: readonly ItemEntry[], itemId: number): number {
    let total = 0;
    for (const item of items) {
        if ((item.baseId ?? item.id) === itemId) total += item.count;
    }
    return total;
}

function findHolderStatusFile(root: string, holder: string): string | null {
    const targetLower = `${holder.toLowerCase()}.json`;
    for (const dir of statusReadDirs(root)) {
        if (!existsSync(dir)) continue;
        const exact = join(dir, `${holder}.json`);
        if (existsSync(exact)) return exact;
        try {
            const match = readdirSync(dir).find((f) => f.toLowerCase() === targetLower);
            if (match) return join(dir, match);
        } catch {
            // Unreadable status dir.
        }
    }
    return null;
}

export function loadHolderBankSnapshot(
    root: string,
    account: string,
    holder: string,
    now: number,
    explicitBankPath?: string,
): HolderBankSnapshot {
    if (explicitBankPath) {
        const rel = toRepoRel(root, explicitBankPath);
        const raw = JSON.parse(readFileSync(localFile(root, rel), 'utf8')) as Record<string, unknown>;
        if (
            typeof raw.name !== 'string' ||
            raw.name.toLowerCase() !== holder.toLowerCase() ||
            raw.server !== LIVE_SERVER ||
            !fresh(raw.bankAt, now, HOUR_MS) ||
            !Array.isArray(raw.bank)
        ) {
            throw Error(`invalid or stale bank observation in ${rel}`);
        }
        return {
            name: raw.name,
            server: LIVE_SERVER,
            bankAt: Number(raw.bankAt),
            bank: normalizeItemRows(raw.bank),
            inventory: normalizeItemRows(raw.inventory),
            sourcePath: rel,
        };
    }

    const candidates: HolderBankSnapshot[] = [];
    const statusFile = findHolderStatusFile(root, holder);
    if (statusFile) {
        const raw = JSON.parse(readFileSync(statusFile, 'utf8')) as Record<string, unknown>;
        if (raw.server === LIVE_SERVER && fresh(raw.bankAt, now, HOUR_MS) && Array.isArray(raw.bank)) {
            candidates.push({
                name: typeof raw.name === 'string' && raw.name ? raw.name : holder,
                server: LIVE_SERVER,
                bankAt: Number(raw.bankAt),
                bank: normalizeItemRows(raw.bank),
                inventory: normalizeItemRows(raw.inventory),
            });
        }
    }
    for (const rel of [
        `.practice/specialist-launch/${account}/bank.json`,
        `.practice/specialist-launch/${account}.bank.json`,
    ]) {
        const abs = join(root, rel);
        if (!existsSync(abs)) continue;
        try {
            const raw = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
            if (
                typeof raw.name === 'string' &&
                raw.name.toLowerCase() === holder.toLowerCase() &&
                raw.server === LIVE_SERVER &&
                fresh(raw.bankAt, now, HOUR_MS) &&
                Array.isArray(raw.bank)
            ) {
                candidates.push({
                    name: raw.name,
                    server: LIVE_SERVER,
                    bankAt: Number(raw.bankAt),
                    bank: normalizeItemRows(raw.bank),
                    inventory: normalizeItemRows(raw.inventory),
                    sourcePath: rel,
                });
            }
        } catch {
            // Skip malformed bank candidate.
        }
    }
    if (candidates.length === 0) {
        throw Error(`no fresh live bank observation (< 1 h old) found for holder ${holder}`);
    }
    candidates.sort((a, b) => b.bankAt - a.bankAt);
    return candidates[0]!;
}

interface DeliveryCandidate {
    readonly path: string;
    readonly data: Record<string, unknown>;
    readonly at: number;
    readonly items: readonly ItemEntry[];
}

function parseDeliveryCandidate(
    relPath: string,
    raw: unknown,
    holder: string,
    bankAt: number,
    ownedSet: ReadonlySet<string>,
    now: number,
): DeliveryCandidate | null {
    if (!isPlainRecord(raw)) return null;
    if (raw.ok !== true || raw.observed !== true || raw.server !== LIVE_SERVER) return null;
    if (typeof raw.to !== 'string' || raw.to.toLowerCase() !== holder.toLowerCase()) return null;
    if (typeof raw.from !== 'string' || !ownedSet.has(raw.from.toLowerCase()) || raw.from.toLowerCase() === holder.toLowerCase()) return null;
    if (!fresh(raw.at, now, HOUR_MS) || Number(raw.at) > bankAt) return null;
    const before = normalizeItemRows(raw.before);
    const after = normalizeItemRows(raw.after);
    const items = normalizeItemRows(raw.items);
    if (items.length === 0) return null;
    for (const item of items) {
        const id = item.baseId ?? item.id;
        if (sumItemId(after, id) - sumItemId(before, id) !== sumItemId(items, id)) return null;
    }
    return { path: relPath, data: raw, at: Number(raw.at), items };
}

function collectOwnedAccountNames(root: string, holder: string): string[] {
    const names = new Set<string>([holder]);
    for (const acct of FLEET) {
        if (acct.role !== 'main' && !isReservedSpecialistAccount(acct.name)) {
            names.add(acct.name);
        }
    }
    const ownerFiles = [
        join(liveFleetDataDir(root), 'fleet', 'owners.json'),
        join(resolveFleetDataDir(root), 'fleet', 'owners.json'),
        join(root, 'fleet', 'owners.json'),
    ];
    for (const file of ownerFiles) {
        if (!existsSync(file)) continue;
        for (const [name] of loadOwners(file)) {
            if (!isReservedSpecialistAccount(name)) names.add(name);
        }
    }
    return [...names];
}

function deriveDeliveryFromTradeReceipts(
    root: string,
    account: string,
    holder: string,
    bankAt: number,
    requirements: readonly SupplyRequirement[],
    ownedSet: ReadonlySet<string>,
    now: number,
    dryRun: boolean,
): DeliveryCandidate[] {
    const receiptDirs = [
        join(liveFleetDataDir(root), 'fleet', 'receipts'),
        join(resolveFleetDataDir(root), 'fleet', 'receipts'),
        join(root, 'fleet', 'receipts'),
    ];
    const itemsCatalog = JSON.parse(readFileSync(localFile(root, 'knowledge/items.json'), 'utf8')) as Array<{ id: number; name: string }>;
    const byName = new Map<string, number>();
    for (const item of itemsCatalog) {
        const key = item.name.trim().toLowerCase();
        if (!byName.has(key)) byName.set(key, item.id);
    }

    const reqIds = new Set<number>();
    for (const req of requirements) {
        if (req.itemId !== undefined) reqIds.add(req.itemId);
        else {
            const hit = byName.get(req.item.trim().toLowerCase());
            if (hit !== undefined) reqIds.add(hit);
        }
    }

    const derived: DeliveryCandidate[] = [];
    const seenReceiptIds = new Set<string>();
    for (const dir of receiptDirs) {
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
            let r: Record<string, unknown>;
            try {
                r = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
            } catch {
                continue;
            }
            if (
                r.version !== 2 ||
                r.state !== 'settled' ||
                r.ok !== true ||
                r.role !== 'to' ||
                r.server !== LIVE_SERVER ||
                typeof r.id !== 'string' ||
                seenReceiptIds.has(r.id) ||
                typeof r.account !== 'string' ||
                r.account.toLowerCase() !== holder.toLowerCase() ||
                typeof r.partner !== 'string' ||
                !ownedSet.has(r.partner.toLowerCase()) ||
                r.partner.toLowerCase() === holder.toLowerCase()
            ) {
                continue;
            }
            const at = typeof r.at === 'number' ? r.at : 0;
            if (!fresh(at, now, HOUR_MS) || at > bankAt) continue;

            const rawLines = [
                { item: r.item, count: r.count, inventory: r.inventory },
                ...(Array.isArray(r.lines) ? (r.lines as Array<Record<string, unknown>>) : []),
            ];
            const before: { id: number; count: number }[] = [];
            const after: { id: number; count: number }[] = [];
            const items: { id: number; count: number }[] = [];
            let validLines = true;
            for (const line of rawLines) {
                if (
                    typeof line.item !== 'string' ||
                    !Number.isSafeInteger(line.count) ||
                    Number(line.count) <= 0 ||
                    !isPlainRecord(line.inventory) ||
                    !Number.isSafeInteger(line.inventory.before) ||
                    !Number.isSafeInteger(line.inventory.after)
                ) {
                    validLines = false;
                    break;
                }
                const itemId = byName.get(line.item.trim().toLowerCase());
                if (itemId === undefined) {
                    validLines = false;
                    break;
                }
                const cnt = Number(line.count);
                const bef = Number(line.inventory.before);
                const aft = Number(line.inventory.after);
                if (aft - bef !== cnt) {
                    validLines = false;
                    break;
                }
                if (reqIds.has(itemId)) {
                    before.push({ id: itemId, count: bef });
                    after.push({ id: itemId, count: aft });
                    items.push({ id: itemId, count: cnt });
                }
            }
            if (!validLines || items.length === 0) continue;
            seenReceiptIds.add(r.id);
            const relOut = `.practice/specialist-launch/${account}.delivery-${r.id}.json`;
            const payload = {
                ok: true,
                observed: true,
                server: LIVE_SERVER,
                from: r.partner,
                to: holder,
                at,
                orderId: r.id,
                before,
                after,
                items,
            };
            if (!dryRun) writeJsonAtomic(join(root, relOut), payload);
            derived.push({ path: relOut, data: payload, at, items });
        }
    }
    return derived;
}

export interface StagingBuildResult {
    readonly stagingPath?: string;
    readonly stagingBinding?: Binding;
    readonly bankPath?: string;
    readonly holders: readonly string[];
}

export function buildStagingManifest(
    root: string,
    account: string,
    holder: string | undefined,
    requirements: readonly SupplyRequirement[],
    context: string,
    now: number,
    opts: {
        readonly dryRun: boolean;
        readonly bankPath?: string;
        readonly deliveryPath?: string;
    },
): StagingBuildResult {
    const owned = collectOwnedAccountNames(root, holder ?? '');
    if (requirements.length === 0) {
        return { holders: owned.filter(Boolean) };
    }
    if (!holder) {
        throw Error(`specialist ${account} requires ${requirements.length} staged supply lines; pass --holder <holder>`);
    }

    const bankSnap = loadHolderBankSnapshot(root, account, holder, now, opts.bankPath);
    const missingFromBank: string[] = [];
    for (const req of requirements) {
        if (req.itemId === undefined) {
            throw Error(`requirement "${req.item}" lacks exact itemId`);
        }
        const inBank = sumItemId(bankSnap.bank, req.itemId);
        if (inBank < req.count) {
            const inInv = sumItemId(bankSnap.inventory, req.itemId);
            missingFromBank.push(
                inInv > 0
                    ? `${req.item} (${req.itemId}): bank ${inBank}/${req.count} (+${inInv} unbanked in inventory)`
                    : `${req.item} (${req.itemId}): bank ${inBank}/${req.count}`,
            );
        }
    }
    if (missingFromBank.length > 0) {
        throw Error(`holder ${holder} bank short for ${account}: ${missingFromBank.join('; ')}`);
    }

    let bankRel = bankSnap.sourcePath;
    if (!bankRel) {
        bankRel = `.practice/specialist-launch/${account}.bank.json`;
        if (!opts.dryRun) {
            writeJsonAtomic(join(root, bankRel), {
                name: bankSnap.name,
                server: bankSnap.server,
                bankAt: bankSnap.bankAt,
                bank: bankSnap.bank.map((i) => ({ id: i.id, ...(i.baseId !== undefined ? { baseId: i.baseId } : {}), count: i.count })),
            });
        }
    }
    const bankBinding = opts.dryRun && !existsSync(join(root, bankRel))
        ? { path: bankRel, sha256: '0'.repeat(64) }
        : bindRepoFile(root, bankRel);

    const ownedSet = new Set(owned.map((n) => n.toLowerCase()));
    const deliveryCandidates: DeliveryCandidate[] = [];
    const candidateRelPaths = new Set<string>();
    if (opts.deliveryPath) {
        candidateRelPaths.add(toRepoRel(root, opts.deliveryPath));
    } else {
        for (const p of [
            `.practice/specialist-launch/${account}/delivery.json`,
            `.practice/specialist-launch/${account}.delivery.json`,
        ]) {
            if (existsSync(join(root, p))) candidateRelPaths.add(p);
        }
    }

    for (const rel of candidateRelPaths) {
        const raw = JSON.parse(readFileSync(localFile(root, rel), 'utf8')) as Record<string, unknown>;
        if (Array.isArray(raw.legs)) {
            const baseDir = dirname(rel).replaceAll('\\', '/');
            for (const legFile of raw.legs) {
                if (typeof legFile !== 'string') continue;
                const legRel = baseDir === '.' ? legFile : `${baseDir}/${legFile}`;
                if (!existsSync(join(root, legRel))) continue;
                const legRaw = JSON.parse(readFileSync(localFile(root, legRel), 'utf8'));
                const parsed = parseDeliveryCandidate(legRel, legRaw, holder, bankSnap.bankAt, ownedSet, now);
                if (parsed) deliveryCandidates.push(parsed);
            }
        }
        const parsed = parseDeliveryCandidate(rel, raw, holder, bankSnap.bankAt, ownedSet, now);
        if (parsed) deliveryCandidates.push(parsed);
    }

    if (deliveryCandidates.length === 0) {
        deliveryCandidates.push(
            ...deriveDeliveryFromTradeReceipts(
                root,
                account,
                holder,
                bankSnap.bankAt,
                requirements,
                ownedSet,
                now,
                opts.dryRun,
            ),
        );
    }
    if (deliveryCandidates.length === 0) {
        throw Error(
            `no fresh observed delivery receipt found for holder ${holder} (pass --delivery <path> or run specialist-supplier --stage)`,
        );
    }

    // Track remaining delivered count per (candidate, itemId) to avoid double-counting.
    const remainingByCandidate = deliveryCandidates.map((c) => {
        const m = new Map<number, number>();
        for (const item of c.items) {
            const id = item.baseId ?? item.id;
            m.set(id, (m.get(id) ?? 0) + item.count);
        }
        return m;
    });
    const deliveryBindingCache = new Map<string, Binding>();
    const bindingFor = (rel: string): Binding => {
        const cached = deliveryBindingCache.get(rel);
        if (cached) return cached;
        const b = opts.dryRun && !existsSync(join(root, rel))
            ? { path: rel, sha256: '0'.repeat(64) }
            : bindRepoFile(root, rel);
        deliveryBindingCache.set(rel, b);
        return b;
    };

    const allocations: Array<{
        item: string;
        itemId: number;
        count: number;
        holder: string;
        recipient: string;
        bank: Binding;
        delivery: Binding;
    }> = [];

    for (const req of requirements) {
        const itemId = req.itemId!;
        let remainingNeed = req.count;
        for (let i = 0; i < deliveryCandidates.length && remainingNeed > 0; i++) {
            const cand = deliveryCandidates[i]!;
            const availMap = remainingByCandidate[i]!;
            const avail = availMap.get(itemId) ?? 0;
            if (avail <= 0) continue;
            const take = Math.min(remainingNeed, avail);
            availMap.set(itemId, avail - take);
            remainingNeed -= take;
            allocations.push({
                item: req.item,
                itemId,
                count: take,
                holder: bankSnap.name,
                recipient: account,
                bank: bankBinding,
                delivery: bindingFor(cand.path),
            });
        }
        if (remainingNeed > 0) {
            throw Error(`delivery receipts for ${holder} short on ${req.item} (${itemId}): missing ${remainingNeed}/${req.count}`);
        }
    }

    const stagingRel = `.practice/specialist-launch/${account}.staging.json`;
    const stagingDoc = {
        version: 2,
        context,
        at: now,
        allocations,
    };
    if (!opts.dryRun) {
        writeJsonAtomic(join(root, stagingRel), stagingDoc);
    }
    const stagingBinding = opts.dryRun
        ? { path: stagingRel, sha256: sha(JSON.stringify(stagingDoc, null, 2) + '\n') }
        : bindRepoFile(root, stagingRel);

    const extraHolders = deliveryCandidates
        .map((c) => String(c.data.from ?? ''))
        .filter(Boolean);
    return {
        stagingPath: stagingRel,
        stagingBinding,
        bankPath: bankRel,
        holders: [...new Set([...owned, ...extraHolders])].filter(Boolean),
    };
}

function resolveRunId(root: string, account: string, explicitRunId: string | undefined, now: number): string {
    if (explicitRunId) return explicitRunId;
    const swarmPath = join(root, 'swarm.json');
    if (existsSync(swarmPath)) {
        try {
            const swarm = JSON.parse(readFileSync(swarmPath, 'utf8')) as { jobs?: Array<Record<string, unknown>> };
            const job = (swarm.jobs ?? []).find(
                (j) => typeof j.account === 'string' && j.account.toLowerCase() === account,
            );
            const existing = isPlainRecord(job?.env)
                ? (job.env.FLEET_RUN_ID ?? job.env.COORDINATOR_RUN_ID)
                : undefined;
            if (typeof existing === 'string' && RUN_ID_RE.test(existing)) return existing;
        } catch {
            // Fall back to generated runId.
        }
    }
    return `specialist-${account}-${Math.floor(now / 1000)}`;
}

function activateLaunchInController(
    root: string,
    account: string,
    holder: string | undefined,
    rehearsal: ValidatedRehearsal,
    runId: string,
    now: number,
): void {
    const spec = getSpecialistCampaignSpec(account)!;
    const cmdId = `launch-${account}-${now}`;
    const cmdDir = operatorCommandsDir(root);
    mkdirSync(cmdDir, { recursive: true });
    writeAtomicFile(
        join(cmdDir, `${cmdId}.json`),
        JSON.stringify(
            {
                schemaVersion: 1,
                id: cmdId,
                issuedAt: now,
                issuedBy: 'specialist-launch-cli',
                reason: `specialist launch authorized for ${account}`,
                kind: 'set_campaign_state',
                campaignId: `campaign:${account}`,
                state: 'running',
            },
            null,
            2,
        ) + '\n',
        { ensureDir: true },
    );

    const swarmPath = join(root, 'swarm.json');
    if (existsSync(swarmPath)) {
        const swarm = JSON.parse(readFileSync(swarmPath, 'utf8')) as { maxBots?: number; minFreeGB?: number; jobs?: Array<Record<string, unknown>> };
        const jobs = Array.isArray(swarm.jobs) ? [...swarm.jobs] : [];
        const newJob = {
            account: spec.account,
            script: rehearsal.script,
            role: 'specialist',
            goal: `${SPECIALIST_BOARDS[account]!.name} 99 specialist`,
            enabled: true,
            repeat: false,
            ...(rehearsal.args.length > 0 ? { args: [...rehearsal.args] } : {}),
            env: {
                ...rehearsal.env,
                ...(holder ? { SUPPLIER: holder } : {}),
                FLEET_RUN_ID: runId,
            },
        };
        const idx = jobs.findIndex((j) => typeof j.account === 'string' && j.account.toLowerCase() === account);
        if (idx >= 0) jobs[idx] = newJob;
        else jobs.push(newJob);
        writeJsonAtomic(swarmPath, { ...swarm, jobs });
    }
}

export interface SpecialistLaunchResult {
    readonly ok: boolean;
    readonly dryRun: boolean;
    readonly launched: boolean;
    readonly account: string;
    readonly board: string;
    readonly holder?: string;
    readonly runId: string;
    readonly source: string;
    readonly planTicks: number;
    readonly boardTicks: number;
    readonly leaderTicks: number;
    readonly marginRequired: number;
    readonly marginObserved: number;
    readonly receiptPath: string;
    readonly evidencePath: string;
    readonly tokenPath: string;
    readonly stagingPath?: string;
    readonly expiresAt?: number;
}

export function runSpecialistLaunch(
    argv: readonly string[],
    opts: {
        readonly root?: string;
        readonly now?: number;
        readonly spawn?: SpawnSyncFn;
        readonly checkMaster?: boolean;
        readonly log?: (line: string) => void;
    } = {},
): SpecialistLaunchResult {
    const root = resolve(opts.root ?? resolve(import.meta.dir, '..'));
    const now = opts.now ?? Date.now();
    const spawn = opts.spawn ?? defaultSpawnSync;
    const log = opts.log ?? console.log;
    const parsed = parseSpecialistLaunchArgs(argv);
    const account = parsed.account;
    const board = SPECIALIST_BOARDS[account]!;
    const runId = resolveRunId(root, account, parsed.runId, now);

    const launchDir = join(practiceRoot(root), 'specialist-launch');
    if (!parsed.dryRun) {
        mkdirSync(launchDir, { recursive: true });
        if (!parsed.skipHiscores) {
            const scout = spawn(
                [
                    'bun',
                    'packages/planner/src/scout-cli.ts',
                    '--out=.practice/specialist-launch/hiscores.json',
                    `--fresh-account=${account}`,
                ],
                root,
            );
            if (scout.exitCode !== 0) {
                throw Error(`scout-cli failed (${scout.exitCode}): ${scout.stderr.trim() || scout.stdout.trim()}`);
            }
        }
    }

    const hiscores = validateHiscoreSnapshot(root, account, now);
    const rehearsal = validateHostedRehearsalReceipt(root, account, hiscores.leader, runId, now, {
        receiptPath: parsed.receiptPath,
        checkMaster: opts.checkMaster,
        spawn,
    });

    const staging = buildStagingManifest(
        root,
        account,
        parsed.holder,
        rehearsal.requirements,
        rehearsal.context,
        now,
        {
            dryRun: parsed.dryRun,
            bankPath: parsed.bankPath,
            deliveryPath: parsed.deliveryPath,
        },
    );

    const evidenceRel = `.practice/specialist-launch/${account}.json`;
    const tokenRel = specialistTokenPath(account);
    const evidenceDoc = {
        version: 1,
        account,
        board: board.name,
        context: rehearsal.context,
        planTicks: rehearsal.planTicks,
        requirements: rehearsal.requirements,
        rehearsal: rehearsal.receiptBinding,
        ...(staging.stagingBinding ? { staging: staging.stagingBinding } : {}),
    };

    let expiresAt: number | undefined;
    if (!parsed.dryRun) {
        writeJsonAtomic(join(root, evidenceRel), evidenceDoc);
        const token = evaluateSpecialist(
            root,
            account,
            runId,
            rehearsal.source,
            rehearsal.rehearsalMission,
            [...staging.holders],
            now,
        );
        const fullToken = {
            ...token,
            mission: rehearsal.jobMissionHash,
            runUntil: token.at + MAX_SPECIALIST_RUN_MS,
        };
        writeJsonAtomic(join(root, tokenRel), fullToken);
        expiresAt = token.expiresAt;

        if (parsed.launch) {
            activateLaunchInController(root, account, parsed.holder, rehearsal, runId, now);
        }
    }

    const result: SpecialistLaunchResult = {
        ok: true,
        dryRun: parsed.dryRun,
        launched: parsed.launch && !parsed.dryRun,
        account,
        board: board.name,
        ...(parsed.holder ? { holder: parsed.holder } : {}),
        runId,
        source: rehearsal.source,
        planTicks: rehearsal.planTicks,
        boardTicks: rehearsal.boardTicks,
        leaderTicks: hiscores.leader.ticks,
        marginRequired: rehearsal.marginRequired,
        marginObserved: rehearsal.marginObserved,
        receiptPath: rehearsal.receiptPath,
        evidencePath: evidenceRel,
        tokenPath: tokenRel,
        ...(staging.stagingPath ? { stagingPath: staging.stagingPath } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    log(`SPECIALIST_LAUNCH ${JSON.stringify(result)}`);
    return result;
}

if (import.meta.main) {
    try {
        runSpecialistLaunch(process.argv.slice(2));
    } catch (error) {
        console.error(`specialist-launch: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
