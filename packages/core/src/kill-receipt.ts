import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isLocalServer } from './localserver';

// Player-kill receipts. The fight loop (scripts/pk.ts fightPlayer) writes one file in the tick in which the server
// sends the killer's message for its target. The run that holds the session adds the loot and the world-feed match to
// the same file. Practice and live servers use separate trees, and each receipt also carries its domain. A reader
// credits a kill to the owner goal only from the live tree, with the live domain, on the named live server.
//
// Layout: <root>/<domain>/<server key>/<account key>/<id>.json

export const KILL_SCHEMA = 'player-kill/1';
export const DEFAULT_KILL_ROOT = join(resolve(import.meta.dir, '..', '..', '..'), '.practice', 'kill-receipts');
export type KillDomain = 'practice' | 'live';
export type KillItem = { id: number; name?: string; count: number };
// The world-feed death of the victim near the kill, or the reason that no match exists.
export type KillFeedMatch = { matched: true; feedTick: number; deltaMs: number | null; source: string } | { matched: false; reason: string; source?: string };
export type KillReceipt = {
    schema: typeof KILL_SCHEMA; id: string; account: string; victim: string; server: string; domain: KillDomain; practice: boolean;
    // `at` is the wall clock of the writer in ms. `tick` is the session tick of the killer, which starts at its login.
    at: number; tick: number; attemptId: string | null;
    tile: { x: number; z: number; level: number }; wilderness: number; multi: boolean; message: string;
    victimCombat: number | null; victimTile: { x: number; z: number } | null;
    kit: { worn: { slot: number; id: number; name?: string }[]; switches: { magic: number[]; ranged: number[]; melee: number[] } };
    fight: { ticks: number; dealt: number; taken: number; eaten: number; specs: number };
    // null: no pickup ran for this kill. An empty list: a pickup ran and took nothing.
    loot: KillItem[] | null; lootAt: number | null;
    // null: no feed check ran for this kill.
    feed: KillFeedMatch | null;
    owner: { pid: number; script: string | null; coordinatorRunId: string | null; workerRelease: string | null };
};
// The session identity of the killer (Session.lifecycle). With no session identity the receipt is a practice receipt.
export type KillSession = { server: string; attemptId?: string } | null | undefined;
export type KillInput = Omit<KillReceipt, 'schema' | 'id' | 'server' | 'domain' | 'practice' | 'at' | 'attemptId' | 'loot' | 'lootAt' | 'feed' | 'owner'> & { session: KillSession };

// The killer's message for a PvP death, with the loser's display name (skill_combat/scripts/pvp/pvp_combat.rs2
// pvp_death_message).
export const KILL_MESSAGES = ['You have defeated {}.', '{} was no match for you.', 'With a crushing blow you finish {}.', 'Can anyone defeat you? Certainly not {}.',
    '{} regrets the day they met you in combat.', "It's all over for {}.", "{} didn't stand a chance against you.", 'A humiliating defeat for {}.',
    '{} falls before your might.', '{} has won a free ticket to Lumbridge.', 'You were clearly a better fighter than {}.'];
const plain = (text: string) => text.trim().toLowerCase().replace(/[_ ]/g, ' ');
export const killMessage = (text: string, name: string) => KILL_MESSAGES.some(t => plain(t.replace('{}', name)) === plain(text));

const ACCOUNT = /^[A-Za-z0-9_ -]{1,12}$/;
const SERVER = /^[A-Za-z0-9.:[\]-]{1,253}$/;
const ID = /^\d{13}-\d{1,10}-\d{1,10}$/;
const serverKey = (server: string) => server.trim().toLowerCase().replace(/[^a-z0-9.-]/g, '_');
const accountKey = (account: string) => account.trim().toLowerCase().replace(/ /g, '_');
const int = (n: unknown): n is number => Number.isSafeInteger(n);
const same = (a: unknown, b: string) => typeof a === 'string' && accountKey(a) === accountKey(b);
let sequence = 0;

// Only a session on a server that is not this machine gives a live receipt.
export function killDomain(session: KillSession): KillDomain {
    return session && SERVER.test(session.server) && !isLocalServer(session.server) ? 'live' : 'practice';
}

function writeAtomic(path: string, text: string): void {
    const temporary = `${path}.tmp-${process.pid}-${++sequence}`;
    writeFileSync(temporary, text);
    // Windows refuses a rename over a file that a reader holds open for a moment: short retries, then the error.
    for (let attempt = 0; ; attempt++) {
        try { renameSync(temporary, path); return; }
        catch (e: any) {
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(e?.code) || attempt >= 20) { try { rmSync(temporary, { force: true }); } catch { /* keep the first error */ } throw e; }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
        }
    }
}

// Writes the receipt of one kill and returns its file. It throws when the identity is not valid or the file cannot be
// written. The caller decides what a failed write means for its run.
export function writeKillReceipt(input: KillInput, opts: { root?: string; now?: () => number; env?: Record<string, string | undefined>; script?: string | null } = {}): { file: string; receipt: KillReceipt } {
    const { session, ...body } = input, env = opts.env ?? process.env;
    if (!ACCOUNT.test(body.account) || !body.victim.trim()) throw new Error('invalid kill receipt identity');
    const domain = killDomain(session), server = session && SERVER.test(session.server) ? session.server : 'no-session';
    const at = (opts.now ?? Date.now)();
    // Fixed-width parts. The pid and the sequence make the name unique when two kills have the same ms.
    const id = `${String(at).padStart(13, '0')}-${String(process.pid).padStart(10, '0')}-${String(++sequence).padStart(10, '0')}`;
    const receipt: KillReceipt = {
        schema: KILL_SCHEMA, id, account: body.account, victim: body.victim, server, domain, practice: domain !== 'live', at, tick: body.tick,
        attemptId: session?.attemptId ?? null, tile: body.tile, wilderness: body.wilderness, multi: body.multi, message: body.message,
        victimCombat: body.victimCombat, victimTile: body.victimTile, kit: body.kit, fight: body.fight, loot: null, lootAt: null, feed: null,
        owner: { pid: process.pid, script: opts.script ?? null, coordinatorRunId: env.FLEET_RUN_ID || env.COORDINATOR_RUN_ID || null, workerRelease: env.WORKER_RELEASE || null },
    };
    const dir = join(opts.root ?? DEFAULT_KILL_ROOT, domain, serverKey(server), accountKey(body.account));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.json`);
    writeAtomic(file, JSON.stringify(receipt, null, 1) + '\n');
    return { file, receipt };
}

// Adds picked-up items or the feed match to a receipt. Loot counts add to the loot that the file holds.
export function amendKillReceipt(file: string, patch: { loot?: readonly KillItem[]; feed?: KillFeedMatch }, now: () => number = Date.now): KillReceipt {
    const receipt = JSON.parse(readFileSync(file, 'utf8')) as KillReceipt;
    if (receipt?.schema !== KILL_SCHEMA) throw new Error('not a kill receipt');
    if (patch.loot) {
        const total = new Map((receipt.loot ?? []).map(i => [i.id, { ...i }]));
        for (const i of patch.loot) {
            if (!int(i.id) || !int(i.count) || i.count <= 0) continue;
            const held = total.get(i.id);
            if (held) held.count += i.count; else total.set(i.id, { id: i.id, ...(i.name ? { name: i.name } : {}), count: i.count });
        }
        receipt.loot = [...total.values()].sort((a, b) => a.id - b.id);
        receipt.lootAt = now();
    }
    if (patch.feed) receipt.feed = patch.feed;
    writeAtomic(file, JSON.stringify(receipt, null, 1) + '\n');
    return receipt;
}

// The proof text of a run for its RESULT line: the receipts that the run wrote, read again from the disk.
// `receiptDomain` is `practice` or `live` when each file agrees, `mixed` when they differ and `none` with no file.
// `feedMatched` counts the receipts with a world-feed death of the victim.
export function killReceiptProof(files: readonly string[]): string {
    const domains = new Set<string>();
    let count = 0, matched = 0;
    for (const file of files) {
        try {
            const r = JSON.parse(readFileSync(file, 'utf8'));
            if (r?.schema !== KILL_SCHEMA || !killMessage(String(r.message), String(r.victim))) continue;
            count++; domains.add(r.practice === false && r.domain === 'live' ? 'live' : 'practice');
            if (r.feed?.matched === true) matched++;
        } catch { /* a file that cannot be read is not a receipt */ }
    }
    return `killReceipts=${count} receiptDomain=${domains.size === 0 ? 'none' : domains.size === 1 ? [...domains][0] : 'mixed'} feedMatched=${matched}`;
}

export type KillVerdict = { file: string; receipt: KillReceipt | null; credited: boolean; reason: string | null };
// The reason that a receipt in the live tree of `server` gives no credit, or null for a credited kill.
// `owned` holds the lower-case names of the accounts of the fleet: a kill of an own account is a spar.
function refusal(r: any, id: string, account: string, server: string, owned: ReadonlySet<string>, now: number): string | null {
    if (r?.schema !== KILL_SCHEMA) return 'schema';
    if (r.id !== id || !ID.test(id)) return 'id does not match the file';
    if (r.domain !== 'live' || r.practice !== false) return 'practice receipt';
    if (typeof r.server !== 'string' || isLocalServer(r.server) || r.server.toLowerCase() !== server.toLowerCase()) return 'other server';
    if (!same(r.account, account)) return 'account does not match the folder';
    if (!owned.has(accountKey(r.account))) return 'killer is not an own account';
    if (typeof r.victim !== 'string' || !r.victim.trim()) return 'no victim';
    if (same(r.victim, r.account) || owned.has(accountKey(r.victim))) return 'victim is an own account';
    if (!int(r.at) || r.at <= 0 || r.at > now) return 'time is not in the past';
    if (!int(r.tick) || r.tick < 0) return 'tick';
    if (![r.tile?.x, r.tile?.z, r.tile?.level].every(int)) return 'tile';
    if (!int(r.wilderness) || r.wilderness < 1) return 'not in the Wilderness';
    if (typeof r.multi !== 'boolean') return 'combat area';
    if (typeof r.message !== 'string' || !killMessage(r.message, r.victim)) return 'server message is not a kill of the victim';
    return null;
}

// Every receipt in the live tree of `server`, each with its verdict. The practice tree is never read.
export function readKillReceipts(opts: { root?: string; server: string; owned: ReadonlySet<string>; now: number }): KillVerdict[] {
    const base = join(opts.root ?? DEFAULT_KILL_ROOT, 'live', serverKey(opts.server)), out: KillVerdict[] = [];
    let accounts: string[]; try { accounts = readdirSync(base).sort(); } catch { return out; }
    for (const account of accounts) {
        let names: string[]; try { names = readdirSync(join(base, account)).filter(n => n.endsWith('.json')).sort(); } catch { continue; }
        for (const name of names) {
            const file = join(base, account, name);
            let receipt: any = null; try { receipt = JSON.parse(readFileSync(file, 'utf8')); } catch { /* refused below */ }
            const reason = receipt === null ? 'unreadable' : refusal(receipt, name.slice(0, -5), account, opts.server, opts.owned, opts.now);
            out.push({ file, receipt: reason === null || receipt?.schema === KILL_SCHEMA ? receipt : null, credited: reason === null, reason });
        }
    }
    return out;
}
