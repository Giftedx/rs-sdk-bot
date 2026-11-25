// Sequential claim worker: visits Varrock West Bank one eligible local account at a time,
// isolates inventory to 1 gp, trades Bramble 1 gp for 100k gp (1-trade or 2-trade), and banks proceeds.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { accountOf, getWorld, openBot, settle } from '../packages/core/src/bot';
import { FLEET_DIR, loadOwners, mySide } from '../packages/core/src/fleet';
import type { Session } from '../packages/core/src/inprocess';
import { hasStopFile, liveStatusDir, simStatusDir } from '../packages/core/src/practice-paths';
import { RESERVED_ACCOUNTS } from '../packages/core/src/specialist-boards';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { goTo } from '../packages/core/src/walk';

const ROOT = resolve(import.meta.dir, '..');
const LEDGER_PATH = join(ROOT, '.practice', 'bramble-claim', 'ledger.json');
const VWB_BANK = { x: 3185, z: 3436, level: 0 } as const;
const VWB_PROBES = [
    { x: 3185, z: 3436, level: 0 },
    { x: 3182, z: 3436, level: 0 },
    { x: 3185, z: 3440, level: 0 },
    { x: 3189, z: 3436, level: 0 },
] as const;

const COINS_ID = 995;
const EXPECTED_MIN_DELTA = 99_999;
const RESERVED_SET = new Set(RESERVED_ACCOUNTS.map(n => n.toLowerCase()));
const PERMANENT_EXCLUDES = new Set(['mightyrod']);

export type ClaimStatus =
    | 'claimed'
    | 'already_claimed'
    | 'free_loss'
    | 'no_coins'
    | 'offline_partner'
    | 'declined'
    | 'no_payout'
    | 'busy'
    | 'failed';

function isBrambleLossChat(chat: readonly string[]): boolean {
    return chat.some(line => /\[loss,\s*need\b/i.test(line));
}

export interface ClaimRecord {
    readonly account: string;
    readonly partner: string;
    readonly status: ClaimStatus;
    readonly beforeCoins: number | null;
    readonly afterCoins: number | null;
    readonly delta: number | null;
    readonly bramblePos: string | null;
    readonly chat: readonly string[];
    readonly detail: string;
    readonly at: string;
}

interface LedgerFile {
    readonly entries: Record<string, ClaimRecord>;
}

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countCoins(items: readonly { id: number; count: number }[] | undefined): number {
    if (!items) return 0;
    let total = 0;
    for (const item of items) {
        if (item.id === COINS_ID) total += item.count ?? 0;
    }
    return total;
}

function d8(a: { x: number; z: number }, b: { x: number; z: number }): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

function posOf(s: Session): { x: number; z: number; level: number } | null {
    const p = s.sdk.getState()?.player;
    return p ? { x: p.worldX, z: p.worldZ, level: p.level ?? 0 } : null;
}

function readLedger(): Record<string, ClaimRecord> {
    if (!existsSync(LEDGER_PATH)) return {};
    try {
        const parsed = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) as Partial<LedgerFile>;
        return parsed.entries ?? {};
    } catch {
        return {};
    }
}

function writeLedger(entries: Record<string, ClaimRecord>): void {
    mkdirSync(join(ROOT, '.practice', 'bramble-claim'), { recursive: true });
    writeFileSync(LEDGER_PATH, JSON.stringify({ entries } satisfies LedgerFile, null, 2) + '\n');
}

function lastKnownDistToVwb(name: string): number {
    for (const dir of [liveStatusDir(ROOT), simStatusDir(ROOT)]) {
        const p = join(dir, `${name}.json`);
        if (!existsSync(p)) continue;
        try {
            const st = JSON.parse(readFileSync(p, 'utf8')) as { pos?: { x: number; z: number } };
            if (st.pos) return d8(st.pos, VWB_BANK);
        } catch { /* ignore unreadable status */ }
    }
    return 99_999;
}

function loadOwnerDisplayNames(): Map<string, string> {
    const out = new Map<string, string>();
    const ownersPath = join(FLEET_DIR(), 'owners.json');
    if (!existsSync(ownersPath)) return out;
    const raw = JSON.parse(readFileSync(ownersPath, 'utf8')) as { accounts?: Record<string, unknown> };
    for (const key of Object.keys(raw.accounts ?? {})) out.set(key.toLowerCase(), key);
    return out;
}

export function assertAccountEligible(name: string): string {
    const low = name.trim().toLowerCase();
    if (!low) throw Error('empty account name');
    if (RESERVED_SET.has(low)) throw Error(`${name} is in RESERVED_ACCOUNTS`);
    if (PERMANENT_EXCLUDES.has(low)) throw Error(`${name} is permanently excluded`);
    if (hasStopFile(name, ROOT)) throw Error(`${name} has an active stop file`);
    const owners = loadOwners();
    const side = mySide();
    const owner = owners.get(low);
    if (!owner || owner.side !== side) {
        throw Error(`${name} belongs to side "${owner?.side ?? 'unknown'}", expected "${side}"`);
    }
    return loadOwnerDisplayNames().get(low) ?? name;
}

export function selectEligibleLocalAccounts(ledger: Record<string, ClaimRecord>): string[] {
    const owners = loadOwners();
    const displayNames = loadOwnerDisplayNames();
    const side = mySide();
    const candidates: { name: string; dist: number }[] = [];
    for (const [low, owner] of owners.entries()) {
        if (owner.side !== side) continue;
        if (RESERVED_SET.has(low) || PERMANENT_EXCLUDES.has(low)) continue;
        const display = displayNames.get(low) ?? low;
        if (hasStopFile(display, ROOT) || hasStopFile(low, ROOT)) continue;
        const prev = ledger[low];
        if (
            prev
            && (
                prev.status === 'claimed'
                || prev.status === 'already_claimed'
                || prev.status === 'free_loss'
                || (prev.status === 'no_payout' && isBrambleLossChat(prev.chat))
            )
        ) {
            continue;
        }
        candidates.push({ name: display, dist: lastKnownDistToVwb(display) });
    }
    candidates.sort((a, b) => a.dist - b.dist || a.name.localeCompare(b.name));
    return candidates.map(c => c.name);
}

async function openFreshBank(s: Session) {
    if (s.sdk.getState()?.bank?.isOpen) {
        await s.bot.closeBank();
        await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 10 });
    }
    const gen = s.bankObservation?.()?.generation ?? 0;
    await s.bot.dismissBlockingUI();
    const res = await s.bot.openBank();
    if (!res.success) throw Error(`openBank failed: ${res.message ?? res.reason}`);
    const ok = await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen, { timeoutTicks: 20 });
    const obs = s.bankObservation?.();
    if (!ok || !obs) throw Error('fresh bank observation unavailable');
    return obs;
}

async function depositAllInventory(s: Session): Promise<void> {
    while (s.sdk.getInventory().length > 0) {
        const first = s.sdk.getInventory()[0];
        if (!first) break;
        const beforeLen = s.sdk.getInventory().length;
        const res = await s.bot.depositItem(first, -1);
        if (!res.success) throw Error(`depositItem(${first.name}) failed: ${res.message ?? res.reason}`);
        const ok = await waitUntil(s, () => s.sdk.getInventory().length < beforeLen, { timeoutTicks: 12 });
        if (!ok) throw Error(`deposit of ${first.name} unobserved`);
    }
}

function collectRecentMessages(s: Session, seen: Set<string>, out: string[], partnerLower: string): void {
    const msgs = s.sdk.getState()?.gameMessages ?? [];
    for (const m of msgs as readonly { text?: string; sender?: string; tick?: number }[]) {
        const sender = String(m.sender ?? '');
        const text = String(m.text ?? '');
        if (!text) continue;
        const key = `${m.tick ?? ''}|${sender}|${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (
            sender.toLowerCase().includes(partnerLower)
            || text.toLowerCase().includes(partnerLower)
            || /trade|offer|coin|already|once|welcome|gift|gambl/i.test(text)
        ) {
            const line = sender ? `[${sender}] ${text}` : text;
            out.push(line);
            console.log(`CHAT ${line}`);
        }
    }
}

async function findPartner(s: Session, world: Awaited<ReturnType<typeof getWorld>>, partnerLower: string, seen: Set<string>, chat: string[]) {
    const pick = () => (s.sdk.getState()?.nearbyPlayers ?? []).find(p => (p.name ?? '').toLowerCase() === partnerLower) ?? null;
    let found = pick();
    if (found) return found;
    for (const tile of VWB_PROBES) {
        collectRecentMessages(s, seen, chat, partnerLower);
        const cur = posOf(s);
        if (!cur || cur.level !== tile.level || d8(cur, tile) > 1) {
            await goTo(s, world, tile, accountOf(s), { maxRetriesPerLeg: 2, legTimeoutTicks: 40 }).catch(() => {});
        }
        for (let i = 0; i < 6; i++) {
            collectRecentMessages(s, seen, chat, partnerLower);
            found = pick();
            if (found) return found;
            await waitTicks(s, 1);
        }
    }
    return null;
}

async function acceptOfferAndConfirm(s: Session, requireCoinsAtLeast: number, timeoutTicks: number): Promise<'completed' | 'declined' | 'mismatch' | 'timeout'> {
    for (let i = 0; i < timeoutTicks; i++) {
        const t = s.sdk.getTradeState();
        if (!t.isOpen) {
            await waitTicks(s, 2);
            if (!s.sdk.getTradeState().isOpen) return 'completed';
            continue;
        }
        const theirCoins = countCoins(t.theirOffer);
        const myCoins = countCoins(t.myOffer);
        if (t.screen === 'offer') {
            if (theirCoins < requireCoinsAtLeast || myCoins > 1 || t.myOffer.length > 1) {
                await s.bot.declineTrade();
                return 'mismatch';
            }
            if (!t.myAccepted) await s.sdk.sendAcceptTrade();
        } else if (t.screen === 'confirm') {
            if (theirCoins < requireCoinsAtLeast || myCoins > 1 || t.myOffer.length > 1) {
                await s.bot.declineTrade();
                return 'mismatch';
            }
            if (!t.myAccepted) await s.sdk.sendAcceptTrade();
        }
        await waitTicks(s, 1);
    }
    if (s.sdk.getTradeState().isOpen) await s.bot.declineTrade();
    return 'timeout';
}

async function claimAccount(rawName: string, partner: string, argv: string[]): Promise<ClaimRecord> {
    const account = assertAccountEligible(rawName);
    const partnerLower = partner.toLowerCase();
    const partnerRe = new RegExp(`^${escapeRegex(partner)}$`, 'i');
    process.env.VALUE_GUARD = '0';
    process.env.LOOT_WATCH = '0';

    const chat: string[] = [];
    const seenMsgs = new Set<string>();
    let beforeCoins: number | null = null;
    let afterCoins: number | null = null;
    let bramblePos: string | null = null;
    let status: ClaimStatus = 'failed';
    let detail = '';

    let session: Session;
    try {
        session = await openBot(account, {
            allowTradePartners: [partner],
            record: { script: 'scripts/bramble-claim.ts', argv, env: process.env },
        });
    } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        const isBusy = /claim|lease|holds the account|active session|already logged/i.test(msg);
        return {
            account,
            partner,
            status: isBusy ? 'busy' : 'failed',
            beforeCoins: null,
            afterCoins: null,
            delta: null,
            bramblePos: null,
            chat,
            detail: msg,
            at: new Date().toISOString(),
        };
    }

    let settleOk = false;
    try {
        const world = await getWorld();
        const route = await goTo(session, world, VWB_BANK, accountOf(session), { maxRetriesPerLeg: 3, legTimeoutTicks: 150 });
        if (!route.ok) throw Error(`route to Varrock West Bank failed: ${route.reason} ${route.detail}`);

        const bankBefore = await openFreshBank(session);
        beforeCoins = countCoins(bankBefore.items) + countCoins(session.sdk.getInventory());
        if (beforeCoins < 1) {
            await session.bot.closeBank();
            status = 'no_coins';
            detail = 'no coins available in bank or inventory';
            settleOk = true;
            return {
                account, partner, status, beforeCoins, afterCoins: beforeCoins, delta: 0,
                bramblePos, chat, detail, at: new Date().toISOString(),
            };
        }

        await depositAllInventory(session);
        const coinRow = session.sdk.getState()?.bank?.items.find(i => i.id === COINS_ID && i.count >= 1);
        if (!coinRow) throw Error('Coins missing from bank after deposit');
        const wd = await session.bot.withdrawItem(coinRow, 1);
        if (!wd.success) throw Error(`withdrawItem(1 Coin) failed: ${wd.message ?? wd.reason}`);
        const gotCoin = await waitUntil(
            session,
            () => {
                const inv = session.sdk.getInventory();
                return inv.length === 1 && inv[0]!.id === COINS_ID && inv[0]!.count === 1;
            },
            { timeoutTicks: 12 },
        );
        if (!gotCoin) throw Error('isolated 1-coin inventory invariant failed');
        await session.bot.closeBank();
        await waitUntil(session, () => !session.sdk.getState()?.bank?.isOpen, { timeoutTicks: 10 });

        const bramble = await findPartner(session, world, partnerLower, seenMsgs, chat);
        if (!bramble) {
            await goTo(session, world, VWB_BANK, accountOf(session), { maxRetriesPerLeg: 2, legTimeoutTicks: 80 }).catch(() => {});
            await openFreshBank(session);
            await depositAllInventory(session);
            await session.bot.closeBank();
            status = 'offline_partner';
            detail = `${partner} not found at Varrock West Bank`;
            return {
                account, partner, status, beforeCoins, afterCoins: beforeCoins, delta: 0,
                bramblePos, chat, detail, at: new Date().toISOString(),
            };
        }
        bramblePos = `${bramble.worldX},${bramble.worldZ},0`;

        let declinedByPartner = false;
        const opened = await session.bot.tradeWith(partnerRe, 30_000, { retryOnBusy: true });
        collectRecentMessages(session, seenMsgs, chat, partnerLower);
        if (!opened.success) {
            status = 'no_payout';
            detail = `tradeWith(${partner}) failed: ${opened.message}`;
        } else {
            const offered = await session.bot.offerTradeItems([{ item: 'Coins', amount: 1 }], 15_000);
            if (!offered.success) {
                status = 'no_payout';
                detail = `offer 1gp failed: ${offered.message}`;
            } else {
                let lastStateSig = '';
                let phaseResult: 'payout_done' | 'one_way_done' | 'declined' | 'timeout' = 'timeout';
                for (let tIdx = 0; tIdx < 35; tIdx++) {
                    collectRecentMessages(session, seenMsgs, chat, partnerLower);
                    const tr = session.sdk.getTradeState();
                    if (!tr.isOpen) {
                        phaseResult = 'declined';
                        break;
                    }
                    const theirCoins = countCoins(tr.theirOffer);
                    const sig = `${tr.screen}|${tr.myAccepted}|${tr.partnerAccepted}|my=${countCoins(tr.myOffer)}|their=${theirCoins}`;
                    if (sig !== lastStateSig) {
                        lastStateSig = sig;
                        console.log(`TRADE ${account} ${sig}`);
                    }
                    if (theirCoins >= 100_000) {
                        const acc = await acceptOfferAndConfirm(session, 100_000, 25);
                        console.log(`TRADE_ACCEPT_1 ${account} result=${acc}`);
                        phaseResult = acc === 'completed' ? 'payout_done' : 'declined';
                        break;
                    }
                    if (tr.partnerAccepted) {
                        const acc = await acceptOfferAndConfirm(session, 0, 25);
                        console.log(`TRADE_ONEWAY ${account} result=${acc}`);
                        phaseResult = acc === 'completed' ? 'one_way_done' : 'declined';
                        break;
                    }
                    await waitTicks(session, 1);
                }

                if (phaseResult === 'declined') declinedByPartner = true;
                if (phaseResult === 'timeout' && session.sdk.getTradeState().isOpen) {
                    await session.bot.declineTrade();
                }

                if (phaseResult === 'one_way_done') {
                    const serve = await session.bot.serveTrades({
                        from: partnerRe,
                        maxTrades: 1,
                        timeout: 15_000,
                        tradeTimeout: 15_000,
                        until: () => {
                            collectRecentMessages(session, seenMsgs, chat, partnerLower);
                            return isBrambleLossChat(chat);
                        },
                        onTrade: () => ({ want: [{ item: 'Coins', amount: 100_000 }] }),
                    });
                    collectRecentMessages(session, seenMsgs, chat, partnerLower);
                    console.log(`SERVE_RETURN ${account} ok=${serve.success} msg=${serve.message}`);
                    if (!isBrambleLossChat(chat) && countCoins(session.sdk.getInventory()) < 100_000) {
                        const retry2 = await session.bot.trade(partnerRe, {
                            want: [{ item: 'Coins', amount: 100_000 }],
                            requestTimeout: 12_000,
                            timeout: 15_000,
                            retryOnBusy: true,
                        });
                        collectRecentMessages(session, seenMsgs, chat, partnerLower);
                        console.log(`TRADE_RETURN ${account} ok=${retry2.success} msg=${retry2.message}`);
                    }
                }
            }
        }

        const backPos = posOf(session);
        if (!backPos || d8(backPos, VWB_BANK) > 3) {
            await goTo(session, world, VWB_BANK, accountOf(session), { maxRetriesPerLeg: 2, legTimeoutTicks: 80 });
        }
        await openFreshBank(session);
        await depositAllInventory(session);
        const bankAfter = await openFreshBank(session);
        afterCoins = countCoins(bankAfter.items) + countCoins(session.sdk.getInventory());
        await session.bot.closeBank();
        await waitUntil(session, () => !session.sdk.getState()?.bank?.isOpen, { timeoutTicks: 10 });

        const delta = afterCoins - beforeCoins;
        const chatSaysAlready = chat.some(line => /already|only once|one time|claimed/i.test(line));
        if (delta >= EXPECTED_MIN_DELTA) {
            status = 'claimed';
            detail = `delta=${delta} (${beforeCoins} -> ${afterCoins})`;
            settleOk = true;
        } else if (isBrambleLossChat(chat)) {
            status = 'free_loss';
            detail = `free roll lost (${beforeCoins} -> ${afterCoins})`;
            settleOk = true;
        } else if (chatSaysAlready) {
            status = 'already_claimed';
            detail = `already claimed per chat (delta=${delta})`;
            settleOk = true;
        } else {
            status = declinedByPartner ? 'declined' : 'no_payout';
            detail = detail || `delta=${delta} (${beforeCoins} -> ${afterCoins})`;
        }
    } catch (err) {
        status = 'failed';
        detail = String(err instanceof Error ? err.message : err);
    } finally {
        await settle([session], settleOk, `${status}: ${detail}`).catch(() => {});
    }

    return {
        account,
        partner,
        status,
        beforeCoins,
        afterCoins,
        delta: beforeCoins !== null && afterCoins !== null ? afterCoins - beforeCoins : null,
        bramblePos,
        chat,
        detail,
        at: new Date().toISOString(),
    };
}

function parseCli(argv: readonly string[]) {
    let all = false;
    let max = Infinity;
    let partner = 'Bramble';
    const accounts: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === '--all') all = true;
        else if (a.startsWith('--max=')) max = Number(a.slice(6));
        else if (a === '--max') max = Number(argv[++i]);
        else if (a.startsWith('--partner=')) partner = a.slice(10);
        else if (a === '--partner') partner = argv[++i] ?? 'Bramble';
        else if (a.startsWith('-')) throw Error(`unknown flag: ${a}`);
        else accounts.push(a);
    }
    if (!all && accounts.length === 0) {
        throw Error('usage: bun scripts/bramble-claim.ts [--all] [--max=N] [--partner=Bramble] [Account...]');
    }
    if (!Number.isFinite(max) && max !== Infinity || max <= 0) {
        throw Error(`invalid --max value: ${max}`);
    }
    return { all, max, partner, accounts };
}

async function main() {
    const cli = parseCli(process.argv.slice(2));
    const ledger = readLedger();
    const queue = cli.all ? selectEligibleLocalAccounts(ledger) : cli.accounts.map(assertAccountEligible);
    const targets = Number.isFinite(cli.max) ? queue.slice(0, cli.max) : queue;
    console.log(`BRAMBLE_PLAN total=${targets.length} partner=${cli.partner} mode=${cli.all ? 'all' : 'explicit'}`);

    const busyQueue: string[] = [];
    let consecutiveNoPayout = 0;
    let abortedReason = '';

    const runOne = async (account: string, isRetry: boolean) => {
        const rec = await claimAccount(account, cli.partner, process.argv.slice(2));
        ledger[account.toLowerCase()] = rec;
        writeLedger(ledger);
        console.log('BRAMBLE_CLAIM ' + JSON.stringify(rec));

        if (rec.status === 'offline_partner') {
            abortedReason = `${cli.partner} not found at Varrock West Bank`;
            return false;
        }
        if (rec.status === 'busy') {
            if (!isRetry) busyQueue.push(account);
            return true;
        }
        if (
            rec.status === 'claimed'
            || rec.status === 'already_claimed'
            || rec.status === 'free_loss'
            || rec.status === 'no_coins'
        ) {
            consecutiveNoPayout = 0;
        } else {
            consecutiveNoPayout++;
            if (cli.all && consecutiveNoPayout >= 3) {
                abortedReason = `3 consecutive non-payout outcomes (last=${account}:${rec.status})`;
                return false;
            }
        }
        return true;
    };

    for (let i = 0; i < targets.length; i++) {
        const cont = await runOne(targets[i]!, false);
        if (!cont) break;
        if (i + 1 < targets.length) await Bun.sleep(2500);
    }

    if (!abortedReason && busyQueue.length > 0) {
        console.log(`BRAMBLE_RETRY_BUSY count=${busyQueue.length}`);
        for (const account of busyQueue) {
            await Bun.sleep(2500);
            const cont = await runOne(account, true);
            if (!cont) break;
        }
    }

    const values = Object.values(ledger);
    const claimed = values.filter(r => r.status === 'claimed');
    const totalGain = claimed.reduce((s, r) => s + (r.delta ?? 0), 0);
    const summary = {
        claimedCount: claimed.length,
        totalGain,
        freeLoss: values.filter(r => r.status === 'free_loss').length,
        alreadyClaimed: values.filter(r => r.status === 'already_claimed').length,
        noCoins: values.filter(r => r.status === 'no_coins').length,
        busy: values.filter(r => r.status === 'busy').length,
        failedOrNoPayout: values.filter(r => r.status === 'failed' || r.status === 'no_payout' || r.status === 'declined' || r.status === 'offline_partner').length,
        abortedReason: abortedReason || null,
    };
    console.log('BRAMBLE_SUMMARY ' + JSON.stringify(summary));
    if (abortedReason || (!cli.all && targets.some(t => !['claimed', 'already_claimed', 'free_loss'].includes(ledger[t.toLowerCase()]?.status ?? '')))) {
        process.exitCode = 1;
    }
}

if (import.meta.main) {
    main().catch(err => {
        console.error('BRAMBLE_FATAL', err);
        process.exit(1);
    });
}
