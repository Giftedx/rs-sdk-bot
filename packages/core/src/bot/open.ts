// Bot session login, world/account binding, monitor attachment, tick loop, and death recovery.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executionContext } from '../../../../vendor/rs-sdk/sdk/execution-context';
import { npcAttackStyles } from '../../../knowledge/src/npc-attack-styles';
import { npcHunters } from '../../../knowledge/src/npc-hunters';
import { FLEE_HP, damageLog, deathLine, recoverDeath, snapshot, type DeathSnapshot } from '../death-recovery';
import { accountForSdk, registerRouteActor } from '../door-policy';
import { noGuardScript, startEatGuard } from '../eat-guard';
import { assertSideOwns, loadOwners } from '../fleet';
import { fleetLeaseAllowsWorker } from '../fleet-lease';
import { ensureCredential } from '../fleet-vault';
import { connectInProcess, type Session } from '../inprocess';
import { startLedger } from '../ledger';
import { stalled } from '../ledger';
import { isLocalServer } from '../localserver';
import { GUARD_VALUE, recordRun, sellsItems, sharedLootTables } from '../loot';
import { readOpponents, wornWeaponStyle } from '../opponent';
import { hasSimStopFile, hasStopFile, simBotsDir } from '../practice-paths';
import { protectByStyle, startPrayerGuard } from '../prayer-guard';
import { loadDanger, watchRandomEvents } from '../randomevents';
import { startStatus } from '../status';
import { createTickRecorder } from '../tick-record';
import { assertLiveWorkerRelease } from '../worker-release';
import { createWorld, rsPathLength, type Account, type World } from '../world';
import {
    attachTickStallWatch,
    awaitBotReady,
    deathRecoveries,
    eatGuards,
    ledgers,
    openHooks,
    prayerGuards,
    randomEvents,
    records,
    settling,
    statuses,
} from './monitors';
import {
    STALL_TICKS,
    assertServerAllowed,
    botWork,
    deathStep,
    releaseLine,
    repoRoot,
    serverFromEnv,
    sessionDied,
    stopReasonOf,
    watchUnexpectedEnd,
    type LifeFields,
    type OpenBotOptions,
} from './rules';
import { finish } from './settle';

let world: World | null = null;
export async function getWorld(): Promise<World> {
    world ??= { ...createWorld({ pathLength: await rsPathLength() }), offThread: true };
    return world;
}

export function accountOf(s: Session): Account {
    registerRouteActor(s.sdk, s.client);
    return accountForSdk(s.sdk);
}

// `opts.log` receives the START and LOGOUT lines; the bot host (host.ts) passes a per-bot log. Default console.log.
// `opts.record` names the worker script and its arguments for the run record (tick-record.ts); the bot host passes
// the hosted script, a standalone worker uses its own process arguments.
export async function openBot(name: string, opts: OpenBotOptions = {}): Promise<Session> {
    if (executionContext.getStore()?.signal.aborted) return new Promise(() => {});
    // An in-process runner in a bot host routes this account's logins through the host's own openBot, so the host
    // tracks the session and logs it out when the runner ends. The hook is lifted for the call it makes back here.
    const hook = openHooks.get(name.toLowerCase());
    if (hook) { openHooks.delete(name.toLowerCase()); try { return await hook(name, opts); } finally { openHooks.set(name.toLowerCase(), hook); } }
    // A replay (replay.ts) serves its recorded accounts through hooks and never logs in for real.
    if (process.env.REPLAY_ONLY === '1') throw new Error(`replay has no record for ${name}; it never logs in`);
    // Never log in an account the other fleet side owns (fleet/owners.json): two machines would fight over it.
    assertSideOwns(name);
    const log = opts.log ?? ((l: string) => console.log(l));
    // Practice/test credentials live under .practice/sim/bots/<name>/bot.env and only connect locally;
    // live fleet accounts read vendor/rs-sdk/bots/<name>/bot.env (populated from fleet-vault.ts when missing).
    const simEnvPath = join(simBotsDir(repoRoot), name, 'bot.env');
    const vendorEnvPath = join(repoRoot, 'vendor', 'rs-sdk', 'bots', name, 'bot.env');
    let envPath = vendorEnvPath;
    if (existsSync(simEnvPath)) {
        envPath = simEnvPath;
    } else {
        ensureCredential(name);
    }
    const env = readFileSync(envPath, 'utf8');
    const password = env.match(/^PASSWORD=(.*)$/m)?.[1]?.trim();
    if (!password) throw new Error(`no PASSWORD in bots/${name}/bot.env`);
    const server = serverFromEnv(env);
    if (envPath === simEnvPath && !isLocalServer(server)) {
        throw new Error(`refusing to connect sim bot ${name} to non-local server ${server}`);
    }
    assertServerAllowed(server);
    assertLiveWorkerRelease(server);
    const trade = opts.trade;
    // The prayer guard reads two NPC tables, and the first read takes about 1 s. It runs before the connection: a
    // connected client that does not answer holds the tick of a lockstep world for every other client.
    const guardTables = process.env.PRAYER_GUARD !== '0' ? { protect: protectByStyle(npcAttackStyles()), hunters: npcHunters() } : null;
    // The loot job reads the item tables and the hunting NPCs: read them here too, for the same reason.
    const events = process.env.RANDOM_EVENTS !== '0', lootOn = process.env.LOOT_WATCH !== '0' && !recordRun(name);
    // On a death the bot first runs back for its items (packages/core/src/death-recovery.ts) while the watcher holds
    // the script; the session then ends as a death, as before. DEATH_RECOVERY=0 turns it off; a record run never runs it.
    const deathOn = process.env.DEATH_RECOVERY !== '0' && !recordRun(name);
    // The value guard keeps a held stack worth GUARD_VALUE coins from a drop, a sale or an alch (randomevents.ts
    // `guard`). VALUE_GUARD=0 turns it off; a record run and a script that sells, alchs or trades on purpose get none.
    const guardOn = process.env.VALUE_GUARD !== '0' && !recordRun(name) && !sellsItems(opts.record?.script ?? process.argv[1] ?? '');
    // The flee guard (randomevents.ts `flee`): at FLEE_HP of the maximum Hitpoints or less, with no food, the bot runs
    // out of the attacker's reach and the session ends there instead of in a death. FLEE_GUARD=0 turns it off; a record
    // run and a PvP script (it fights on purpose at low Hitpoints) get none.
    const scriptFile = opts.record?.script ?? process.argv[1] ?? '';
    const fleeOn = process.env.FLEE_GUARD !== '0' && !recordRun(name) && !/pk|pvp|spar|gang/i.test(scriptFile.split(/[\\/]/).at(-1) ?? '');
    const lootTables = lootOn ? sharedLootTables() : null;
    if (lootOn) loadDanger();
    const s = await connectInProcess({
        name, password, server, work: botWork(name, opts.record), ...(trade ? {
            trade: { ...trade, check: srv => { assertSideOwns(name); trade.check(srv); } },
        } : {}),
    });
    await awaitBotReady(s, log);
    s.progression?.onHandoff(detail => { void (opts.onStop ? opts.onStop(s, detail) : finish([s], false, detail)); });
    const p = s.sdk.getState()!.player!;
    // Life fields copied while connected: after a disconnect the state's player is no evidence of a death (a run
    // whose logout timed out ended the next login, and the stale player read as a new life).
    const life = (q: any) => q ? { isDead: q.isDead, respawnCount: q.respawnCount, lifeId: q.lifeId } : undefined;
    let born: LifeFields = life(p);
    let lastLife: LifeFields = born, deathSeen = false;
    s.lifecycle?.record('ready', `${p.worldX} ${p.worldZ} ${p.level}`);
    log(`START ${p.worldX} ${p.worldZ} ${p.level}`);
    // The worker release of this run (WORKER_RELEASE, which the swarm sets from the files the job runs): reports such as
    // scripts/tick-waste.ts count each run under the code it ran, so a fixed bug stops counting. A line of its own,
    // because proofs match the START line to its end.
    log(releaseLine(process.env.WORKER_RELEASE));
    // On the lockstep practice engine: the time from the start of the worker process to its login, for the bench.
    if (process.env.SIM_LOCKSTEP === '1') log(`BOOT ${Math.round(performance.now())} ms from process start to login`);
    const record = createTickRecorder({
        account: name, server, script: opts.record?.script ?? process.argv[1] ?? 'unknown',
        argv: opts.record?.argv ?? process.argv.slice(2), startedAt: Date.now(),
    });
    if (record && s.record) { s.record(record); records.set(s, record); }
    // Every session keeps a tick ledger (packages/core/src/ledger.ts); finish() prints it.
    // The ledger names the last script action of each idle tick: the watcher's gate sees them (started below).
    const led = startLedger(s as any, () => randomEvents.get(s)?.lastAction() ?? null, Math.max(STALL_TICKS, 300));
    ledgers.set(s, led);
    // Random events (dryad, genie, lost axe...) and valuable ground items share one watcher (packages/core/src/randomevents.ts,
    // packages/core/src/loot.ts). RANDOM_EVENTS=0 turns the events off and LOOT_WATCH=0 the pickup; a record run never loots.
    // Death recovery needs the watcher's gate too: it starts the watcher with events and loot off.
    if (events || lootTables || deathOn || guardOn || fleeOn) {
        randomEvents.set(s, watchRandomEvents(s, {
            events,
            flee: fleeOn ? {
                hp: FLEE_HP, onSafe: detail => {
                    log(`FLEE_GUARD safe ${detail} bot=${name}`);
                    if (!stopping && !settling.has(s)) { stopping = true; stop(`fled at low hitpoints: ${detail}`); }
                },
            } : null,
            guard: guardOn ? { tables: sharedLootTables(), minValue: GUARD_VALUE } : null,
            loot: lootTables ? {
                tables: lootTables, name,
                friends: new Set(loadOwners().keys()),
                reserved: () => (s as { questReserved?: Record<number, number> }).questReserved ?? {},
            } : null,
        }));
    }
    // Free prayers and protection from NPCs and Wilderness players (packages/core/src/prayer-guard.ts); PRAYER_GUARD=0
    // turns the guard off, PRAYER_OFFENCE=0 turns its Strength and Attack prayers off.
    if (guardTables) {
        prayerGuards.set(s, startPrayerGuard(s, {
            log: line => log(`${line} bot=${name}`),
            ...(process.env.PRAYER_GUARD_TRACE === '1' ? { trace: log } : {}),
            ...guardTables,
            offence: process.env.PRAYER_OFFENCE !== '0',
            melee: st => wornWeaponStyle((st?.equipment ?? []).find((i: any) => i.slot === 3)?.id) === 'melee',
            players: {
                ignore: new Set(loadOwners().keys()),
                style: q => { const seen = readOpponents(s.client).find(v => v.index === q.index); return seen ? wornWeaponStyle(seen.worn.rhand) : null; },
            },
        }));
    }
    // Eats plain food in a fight when Hitpoints are low and damage arrives (packages/core/src/eat-guard.ts);
    // EAT_GUARD=0 turns the guard off. A script with `quest` or `microbot` in its file name gets no guard
    // (noGuardScript): a fish can be a quest item there, or the script counts each piece of its food.
    // It starts after the prayer guard: its tick callback then counts the prayer inputs of the tick before it sends.
    // quest-sweep marks the edible quest items on the session (questReserved); the guard never eats those.
    if (process.env.EAT_GUARD !== '0' && !noGuardScript(opts.record?.script ?? process.argv[1] ?? '')) {
        eatGuards.set(s, startEatGuard(s, {
            log: line => log(`${line} bot=${name}`),
            reserved: () => (s as { questReserved?: Record<number, number> }).questReserved ?? {},
        }));
    }
    // Any bot stops cleanly when .practice/stop-<name> appears (checked every 25 ticks): a script that never checks
    // it (seen: fishing30 under the supervisor) still logs out in game.
    let stopTicks = 0;
    let stopping = false;
    let lastAlive: DeathSnapshot | null = null, lastHp = '?';
    // The damage of the last ticks, by source, for the DEATH line (death-recovery.ts damageLog).
    const damage = damageLog();
    const stop = (reason: string) => void (opts.onStop ? opts.onStop(s, reason) : finish([s], false, reason));
    s.onTick(() => {
        const st = s.sdk.getState();
        lastLife = life(st?.player) ?? lastLife;
        const step = deathStep(born, lastLife, opts.continueAfterDeath === true, deathSeen), died = step.died;
        born = step.born; deathSeen = step.seen;
        damage.read(st);
        if (step.announce) log(`${deathLine(lastAlive, lastHp, damage.cause(), scriptFile)} bot=${name}`);
        if (!died) { lastAlive = snapshot(st) ?? lastAlive; if (st?.player) lastHp = `${st.player.hp}/${st.player.maxHp}`; }
        stopTicks += died ? 0 : 1;
        const reason = stopReasonOf({
            died, stopTicks, stallTicks: STALL_TICKS,
            stopFile: () => isLocalServer(server) ? hasSimStopFile(name, repoRoot) : hasStopFile(name, repoRoot),
            leaseLost: () => !isLocalServer(server) && !fleetLeaseAllowsWorker(repoRoot),
            stalled: () => stalled(led.rows, STALL_TICKS),
        });
        if (!stopping && !settling.has(s) && reason) {
            stopping = true;
            if (reason === 'died') log(`${deathLine(lastAlive, lastHp, damage.cause(), scriptFile)} bot=${name}`);
            const watch = randomEvents.get(s), at = lastAlive;
            if (reason !== 'died' || !deathOn || !watch || !at) { stop(reason); return; }
            // The walker's world loads during the respawn wait, not after it.
            const worldReady = getWorld();
            const run = watch.exclusive(() => recoverDeath(s, at, {
                walk: async (to, signal) => (await import('../walk')).goTo(s, await worldReady, to, accountOf(s), { legTimeoutTicks: 100, signal }),
                tables: sharedLootTables(), danger: loadDanger(), friends: new Set(loadOwners().keys()), log: line => log(`${line} bot=${name}`),
            })).catch(e => { log(`DEATH_RECOVERY error ${String(e)} bot=${name}`); return 'error'; });
            deathRecoveries.set(s, run);
            void run.then(() => stop(reason));
        }
    });
    // A tick stream that stops arriving without a disconnect (tick-stall.ts) ends the session on the clock.
    attachTickStallWatch(s, reason => {
        if (stopping || settling.has(s)) return;
        stopping = true;
        void (opts.onStop ? opts.onStop(s, reason) : finish([s], false, reason));
    });
    // Live status for the dashboard (packages/dashboard).
    statuses.set(s, startStatus(s as any, server, led.counts, () => led.rows.slice(-300).map(r => r.kind === 'inventory' ? 'v' : r.kind[0]).join('')));
    // No more game ticks arrive after disconnect. End a script waiting on them
    // through its own session owner, while planned logout/stop keeps its result.
    watchUnexpectedEnd(s, () => settling.has(s), () => stopping, detail =>
        opts.onSessionEnd ? opts.onSessionEnd(s, sessionDied(born, lastLife) ? 'died' : detail)
            : finish([s], false, sessionDied(born, lastLife) ? 'died' : detail));
    return s;
}
