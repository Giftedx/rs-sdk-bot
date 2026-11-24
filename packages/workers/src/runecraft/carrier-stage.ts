// Multi-account rune carrier staging CLI (--rune-carriers and --rune-opening).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { accountOf as defaultAccountOf, assertServerAllowed, getWorld as defaultGetWorld, openBot as defaultOpenBot, serverFromEnv, settle as defaultSettle } from '../../../core/src/bot';
import { depositObserved } from '../../../core/src/deposit';
import { assertSideOwns } from '../../../core/src/fleet';
import type { Session } from '../../../core/src/inprocess';
import { fleetStateFile, resolveBotEnvPath } from '../../../core/src/practice-paths';
import { waitUntil } from '../../../core/src/ticks';
import { ownedAccounts } from '../../../core/src/tradeguard';
import { goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import { enterBody, inside, leaveBody, stopCarriers } from './carrier-bank';
import {
    assertRuneDonor,
    exitRuneStageBasement,
    runeCarrierShortfall,
    runeStageAuthenticate,
    runeStageBankApproach,
    runeStageRequirement,
    runeStageRoster,
    runeStageStatus,
} from './carrier-roster';
import { ownedSwap, state } from './carrier-trade';
import type { RunecraftExternalDeps } from './types';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');
const OPEN_DOOR_RE = /^open$/i;
type SkillXpSnap = readonly { name: string; experience: number }[];

function sameXp(a: SkillXpSnap, b: SkillXpSnap): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i]!.name !== b[i]!.name || a[i]!.experience !== b[i]!.experience) return false;
    }
    return true;
}

let cachedWalkHelpersMod: typeof import('../logistics/walk-helpers') | undefined;
let cachedAdmissionMod: typeof import('../logistics/admission') | undefined;
const loadWalkHelpersMod = (): typeof import('../logistics/walk-helpers') => (cachedWalkHelpersMod ??= require('../logistics/walk-helpers'));
const loadAdmissionMod = (): typeof import('../logistics/admission') => (cachedAdmissionMod ??= require('../logistics/admission'));

export async function mainRuneStage(args: readonly string[], deps: RunecraftExternalDeps = {}): Promise<void> {
    const { leaveRuneStarter, runeSupplyAssets } = loadWalkHelpersMod();
    const { acquireAccountLeases, assertAccountOwnership, assertRecoverableStatus } = loadAdmissionMod();
    const { mode, names } = runeStageRoster(args);
    const root = REPO_ROOT, dir = join(root, '.practice');
    const purpose = process.env.RUNE_STAGE_PURPOSE;
    runeStageRequirement(purpose, []);
    const cap = Number(process.env.CAP ?? 1600);
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 2800) throw Error('Rune staging budget must be1..2800');
    const servers = names.map(n => {
        assertSideOwns(n);
        return serverFromEnv(readFileSync(resolveBotEnvPath(n, root), 'utf8'));
    });
    if (new Set(servers.map(s => s.toLowerCase())).size !== 1) throw Error('Rune staging participants must share a server');
    const server = servers[0]!;
    assertServerAllowed(server);
    const runId = process.env.FLEET_RUN_ID ?? process.env.COORDINATOR_RUN_ID ?? '';
    const read = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
    const ownershipDeps = deps.stageOwnership;
    const coordState = ownershipDeps ? ownershipDeps.readCoordinatorState() : (existsSync(fleetStateFile(root)) ? read(fleetStateFile(root)) : null);
    const swarmJobs = ownershipDeps ? ownershipDeps.readSwarmJobs() : (read(join(root, 'swarm.json'))?.jobs ?? []);
    assertAccountOwnership(names, coordState, swarmJobs, n => existsSync(join(dir, 'stop-' + n)), runId);
    for (const n of names) {
        const st = ownershipDeps ? ownershipDeps.readStatus(n) : read(join(dir, 'status', n + '.json'));
        if (st) assertRecoverableStatus(st, undefined, () => true);
    }
    const openBotFn = deps.openBot ?? defaultOpenBot;
    const settleFn = deps.settle ?? defaultSettle;
    const getWorldFn = deps.getWorld ?? defaultGetWorld;
    const accountOfFn = deps.accountOf ?? defaultAccountOf;
    const leaveStarterFn = deps.leaveRuneStarter ?? leaveRuneStarter;
    const release = acquireAccountLeases(names, runId);
    const cancel = new AbortController();
    const opened: Session[] = [], active = new Set<Session>(), closing = new Set<Session>();
    const monitors: (() => void)[] = [], flights: Promise<unknown>[] = [], rows: unknown[] = [];
    const log = runeStageStatus(names);
    let failure: unknown, done = false, logout = true, receivedEssence = 0, receivedTalismans = 0;

    const stop = () => {
        if (cancel.signal.aborted) return true;
        if (failure
            || names.some(n => existsSync(join(dir, 'stop-' + n)))
            || existsSync(join(dir, 'stop-coordinator'))
            || existsSync(join(dir, 'stop-swarm'))
            || [...active].some(s => s.tick() > cap || state(s)?.player?.isDead)) {
            cancel.abort(failure ?? Error('Rune staging stopped or over budget'));
            stopCarriers();
            return true;
        }
        return false;
    };
    const check = () => { if (stop()) throw cancel.signal.reason; };
    const fail = (s: Session, detail: string) => {
        if (!closing.has(s) && !done) {
            failure = Error(s.name + ': ' + detail);
            stop();
        }
    };
    const open = async (n: string) => runeStageAuthenticate(n, async () => {
        check();
        const s = await openBotFn(n, { onStop: async (sess, d) => fail(sess, d), onSessionEnd: async (sess, d) => fail(sess, d) });
        opened.push(s);
        active.add(s);
        monitors.push(s.onTick(stop));
        if (!await waitUntil(s, () => stop() || (!!state(s)?.player && state(s).skills?.length === 21), { timeoutTicks: 20 })) {
            throw Error('Rune staging initial state unavailable');
        }
        check();
        return s;
    }, () => ownedAccounts(server));
    const close = async (s: Session, ok: boolean) => {
        closing.add(s);
        let confirmed = false, warning = false;
        const result = await settleFn([s], ok, 'finite Rune carrier staging', {
            log: line => {
                log(s.name, line);
                if (line === 'LOGOUT logged-out') confirmed = true;
                if (line.startsWith('WARN ')) warning = true;
            },
        });
        logout = confirmed && !warning && (!ok || result) && logout;
        active.delete(s);
    };
    const xp = (s: Session): SkillXpSnap => {
        const skills = state(s).skills;
        const out = new Array<{ name: string; experience: number }>(skills.length);
        for (let i = 0; i < skills.length; i++) {
            const sk = skills[i]!;
            out[i] = { name: sk.name, experience: sk.experience };
        }
        return out;
    };
    const count = (items: readonly { id: number; count: number }[], id: number) => {
        let n = 0;
        for (let i = 0; i < items.length; i++) if (items[i]!.id === id) n += items[i]!.count;
        return n;
    };
    const bankItems = (s: Session) => {
        const b = s.bankObservation?.();
        if (!b) throw Error('Rune staging bank unobserved');
        return b.items;
    };
    const travel = async (s: Session, x: number, z: number) => {
        check();
        const r = await goTo(s, await getWorldFn(), { x, z, level: 0 }, accountOfFn(s), { legTimeoutTicks: 180, signal: cancel.signal });
        check();
        if (!r.ok) throw Error('Rune staging travel ' + JSON.stringify(r));
    };
    const bank = async (s: Session) => {
        check();
        if (inside(s)) await leaveBody(s);
        await exitRuneStageBasement({
            position: () => state(s).player!,
            dash: async (label, x, z, tol) => {
                check();
                const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { maxTicks: 45, stop });
                check();
                const p = state(s).player!;
                if (!r.ok || p.level !== 0 || Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) > tol) {
                    throw Error('Rune staging ' + label + ' unobserved');
                }
            },
            openDoor: async (label, x, z) => {
                check();
                const shut = () => state(s).nearbyLocs.find(l => l.x === x && l.z === z && l.optionsWithIndex.some(o => OPEN_DOOR_RE.test(o.text)));
                const door = shut();
                if (door && door.distance > 2) {
                    const r = await walkPath(await sessionWalker(s), [{ x, z, tol: 1 }], { maxTicks: 30, stop });
                    check();
                    if (!r.ok) throw Error('Rune staging ' + label + ' approach failed');
                }
                const current = shut(), op = current?.optionsWithIndex.find(o => OPEN_DOOR_RE.test(o.text));
                if (current && op && (!(await s.sdk.sendInteractLoc(current.x, current.z, current.id, op.opIndex)).success || !await waitUntil(s, () => stop() || !shut(), { timeoutTicks: 15 }))) {
                    throw Error('Rune staging ' + label + ' refused');
                }
                check();
            },
            climb: async () => {
                check();
                if (!await waitUntil(s, () => stop() || state(s).nearbyLocs.some(l => l.id === 2148 && l.x === 3103 && l.z === 9576), { timeoutTicks: 15 })) {
                    throw Error('Rune staging upward ladder unavailable');
                }
                check();
                if (!(await s.sdk.sendInteractLoc(3103, 9576, 2148, 1)).success
                    || !await waitUntil(s, () => { const p = state(s).player!; return stop() || (p.worldX === 3105 && p.worldZ === 3162 && p.level === 0); }, { timeoutTicks: 20 })) {
                    throw Error('Rune staging upward climb unobserved');
                }
                check();
            },
            waitForLanding: async () => {
                const seen = await waitUntil(s, () => stop() || state(s).nearbyLocs.some(l => l.id === 2147 && l.x === 3104 && l.z === 3162), { timeoutTicks: 15 });
                check();
                return seen;
            },
        });
        check();
        for (const point of runeStageBankApproach(state(s).player!)) await travel(s, point.x, point.z);
        await travel(s, 3094, 3491);
        if (state(s).bank.isOpen) { await s.bot.closeBank(); check(); }
        const generation = s.bankObservation?.()?.generation ?? 0;
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => stop() || (state(s).bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation), { timeoutTicks: 20 })) {
            throw Error('Rune staging fresh bank unavailable');
        }
        check();
    };
    const deposit = async (s: Session) => {
        for (const id of new Set(s.sdk.getInventory().map(i => i.id))) {
            check();
            const item = s.sdk.getInventory().find(i => i.id === id);
            if (item) await depositObserved(s, item);
            check();
        }
    };
    const withdraw = async (s: Session, id: number, n: number, asNote = false) => {
        check();
        const packId = asNote ? id + 1 : id, before = count(bankItems(s), id), held = count(s.sdk.getInventory(), packId);
        const item = state(s).bank.items.find(i => i.id === id);
        if (!item || before < n) throw Error('Rune staging shortage ' + id);
        if (!(await s.bot.withdrawItem(item, n, { asNote })).success
            || !await waitUntil(s, () => {
                if (stop()) return true;
                const observed = s.bankObservation?.();
                return count(s.sdk.getInventory(), packId) === held + n && !!observed && count(observed.items, id) === before - n;
            }, { timeoutTicks: 15 })) {
            throw Error('Rune staging withdrawal did not reconcile ' + id);
        }
        check();
    };
    const snapshot = (s: Session) => bankItems(s).map(i => ({ ...i }));
    const record = (s: Session, bankData: ReturnType<typeof snapshot>, extra: object) => {
        const p = state(s).player!;
        const row = { name: s.name, tick: s.tick(), position: { x: p.worldX, z: p.worldZ, level: p.level }, inventory: runeSupplyAssets(s.sdk.getInventory()), bank: bankData, ...extra };
        rows.push(row);
        console.log('RUNE_CARRIER_STAGE ' + JSON.stringify(row));
    };

    try {
        await getWorldFn();
        check();
        if (mode === 'opening') {
            const s = await open(names[0]!), beforeXp = xp(s);
            await bank(s);
            await deposit(s);
            if (count(bankItems(s), 1436) < 432 || count(bankItems(s), 1446) < 2 || count(bankItems(s), 1438) < 1) {
                throw Error('opening donor reserve needs432 essence,2 body talismans and1 air talisman');
            }
            await withdraw(s, 1436, 27);
            await withdraw(s, 1438, 1);
            const stored = snapshot(s);
            await s.bot.closeBank();
            check();
            await travel(s, 3222, 3223);
            assertRuneDonor(state(s).player, s.sdk.getInventory());
            if (!sameXp(xp(s), beforeXp)) throw Error('Rune staging changed donor XP');
            record(s, stored, { role: 'opening', receivedEssence: 0, receivedTalismans: 0 });
            await close(s, true);
        } else {
            const prepared: Promise<{ s: Session; beforeXp: SkillXpSnap; shortfall: ReturnType<typeof runeCarrierShortfall>; beforeEssence: number; beforeTalismans: number }>[] = [];
            for (const name of names.slice(1)) {
                const s = await open(name), beforeXp = xp(s);
                const flight = (async () => {
                    await leaveStarterFn(s, stop);
                    check();
                    await bank(s);
                    await deposit(s);
                    const items = bankItems(s), beforeEssence = count(items, 1436), beforeTalismans = count(items, 1446), shortfall = runeCarrierShortfall(items);
                    await s.bot.closeBank();
                    check();
                    return { s, beforeXp, shortfall, beforeEssence, beforeTalismans };
                })();
                prepared.push(flight);
                flights.push(flight.catch(e => { failure = e; stop(); }));
            }
            const receivers = await Promise.all(prepared);
            check();
            const needs = receivers.filter(r => r.shortfall.essence || r.shortfall.talismans);
            let source: Session | undefined, sourceXp: SkillXpSnap = [], sourceEssence = 0, sourceTalismans = 0;
            if (needs.length) {
                source = await open(names[0]!);
                sourceXp = xp(source);
                await bank(source);
                await deposit(source);
                sourceEssence = count(bankItems(source), 1436);
                sourceTalismans = count(bankItems(source), 1446);
                const required = runeStageRequirement(purpose, needs.map(r => r.shortfall));
                if (sourceEssence < required.essence || sourceTalismans < required.talismans || count(bankItems(source), 1438) < required.airTalismans) {
                    throw Error('Rune staging supplier lacks ' + (purpose === 'existing-cohort' ? 'finite receiver shortfall' : 'kits plus opening reserve') + ' ' + JSON.stringify(required));
                }
            }
            for (const r of receivers) {
                check();
                const { s, shortfall } = r;
                if (shortfall.essence || shortfall.talismans) {
                    const giver = source!;
                    await bank(giver);
                    const e0 = count(bankItems(giver), 1436), t0 = count(bankItems(giver), 1446);
                    if (shortfall.essence) await withdraw(giver, 1436, shortfall.essence, true);
                    if (shortfall.talismans) await withdraw(giver, 1446, shortfall.talismans, true);
                    if (count(bankItems(giver), 1436) !== e0 - shortfall.essence || count(bankItems(giver), 1446) !== t0 - shortfall.talismans) {
                        throw Error('Rune staging supplier bank debit mismatch');
                    }
                    const pack = giver.sdk.getInventory();
                    if (pack.some(i => ![1437, 1446, 1447].includes(i.id)) || count(pack, 1437) !== shortfall.essence || count(pack, 1446) + count(pack, 1447) !== shortfall.talismans) {
                        throw Error('Rune staging payout pack mismatch');
                    }
                    await giver.bot.closeBank();
                    check();
                    await ownedSwap(giver, s, runeSupplyAssets(pack), {}, stop);
                    check();
                    receivedEssence += shortfall.essence;
                    receivedTalismans += shortfall.talismans;
                }
                const ready = (async () => {
                    await bank(s);
                    await deposit(s);
                    if (count(bankItems(s), 1436) !== r.beforeEssence + shortfall.essence || count(bankItems(s), 1446) !== r.beforeTalismans + shortfall.talismans) {
                        throw Error('Rune staging receiver bank credit mismatch');
                    }
                    await withdraw(s, 1446, 1);
                    await withdraw(s, 1436, 27);
                    const stored = snapshot(s);
                    await s.bot.closeBank();
                    check();
                    await enterBody(s);
                    check();
                    if (!inside(s) || count(s.sdk.getInventory(), 1436) !== 27 || count(s.sdk.getInventory(), 1446) !== 1 || count(stored, 1436) < 378 || !sameXp(xp(s), r.beforeXp)) {
                        throw Error('Rune carrier readiness unobserved');
                    }
                    record(s, stored, { role: 'carrier', receivedEssence: shortfall.essence, receivedTalismans: shortfall.talismans });
                    await close(s, true);
                })();
                flights.push(ready.catch(e => { failure = e; stop(); }));
            }
            if (source) {
                await bank(source);
                if (count(bankItems(source), 1436) !== sourceEssence - receivedEssence || count(bankItems(source), 1446) !== sourceTalismans - receivedTalismans || source.sdk.getInventory().length || !sameXp(xp(source), sourceXp)) {
                    throw Error('Rune staging supplier final reconciliation failed');
                }
                record(source, snapshot(source), { role: 'supplier', debitedEssence: receivedEssence, debitedTalismans: receivedTalismans });
                await source.bot.closeBank();
                await close(source, true);
            }
            await Promise.all(flights);
            check();
        }
        done = true;
        console.log('RUNE_CARRIER_STAGE_RESULT ' + JSON.stringify({ ok: logout, mode, names, receivedEssence, receivedTalismans, rows, logout }));
        process.exitCode = logout ? 0 : 1;
    } catch (error) {
        failure = error;
        cancel.abort(error);
        stopCarriers();
        await Promise.allSettled(flights);
        done = true;
        for (const s of [...active]) await close(s, false);
        console.log('RUNE_CARRIER_STAGE_RESULT ' + JSON.stringify({ ok: false, mode, names, failure: String(error), rows, logout }));
        process.exitCode = 1;
    } finally {
        monitors.forEach(off => off());
        release();
    }
}
