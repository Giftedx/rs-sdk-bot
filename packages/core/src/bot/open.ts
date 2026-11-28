// Bot session login, world/account binding, monitor attachment, tick loop, and death recovery.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { executionContext } from '../../../../vendor/rs-sdk/sdk/execution-context';
import type { DeathSnapshot } from '../death-recovery';
import { accountForSdk, registerRouteActor } from '../door-policy';
import type { Session } from '../inprocess';
import { isLocalServer } from '../localserver';
import { hasSimStopFile, hasStopFile, simBotsDir } from '../practice-paths';
import type { Account, World } from '../world';
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
import { currentHostedScope } from './host-scope';

const NO_GUARD_SCRIPT_RE = /quest|microbot/i;
const LIVE_GC_INTERVAL_MS = 10 * 60 * 1000;
let liveGcTimer: ReturnType<typeof setInterval> | null = null;

function ensureLiveGcTimer(): void {
    if (liveGcTimer || process.env.SIM_LOCKSTEP === '1') return;
    const timer = setInterval(() => { Bun.gc(false); }, LIVE_GC_INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
    liveGcTimer = timer;
}

function samePackSnapshot(prev: readonly { id: number; count: number }[], raw: readonly any[] | undefined): boolean {
    if (!raw?.length) return prev.length === 0;
    let count = 0;
    for (let i = 0; i < raw.length; i++) {
        const cur = raw[i];
        if (!cur) continue;
        if (count >= prev.length || prev[count]!.id !== cur.id || prev[count]!.count !== (cur.count ?? 1)) return false;
        count++;
    }
    return count === prev.length;
}

function sameWornSnapshot(prev: readonly number[], raw: readonly any[] | undefined): boolean {
    if (!raw?.length) return prev.length === 0;
    let count = 0;
    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (!item) continue;
        if (count >= prev.length || prev[count] !== item.id) return false;
        count++;
    }
    return count === prev.length;
}

// The promise is the cache: bots of one process that ask at the same time share one build of the area labels.
let world: Promise<World> | null = null;
export function getWorld(): Promise<World> {
    world ??= (async (): Promise<World> => {
        const [{ createWorld, rsPathLength }, { serviceWanted }] = await Promise.all([import('../world'), import('../route-plan')]);
        return { ...createWorld({ pathLength: await rsPathLength({ lazyLabels: serviceWanted() }) }), offThread: true };
    })().catch((e) => {
        world = null;
        throw e;
    });
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
    // A helper module's openBot() inside a bot host goes through its hosted bot (host-scope.ts), which tracks and
    // logs out the session. The host's own call passes a log, so it reaches the login below.
    if (opts.log === undefined) { const hosted = currentHostedScope(); if (hosted) return hosted.openBot(name, opts); }
    // A replay (replay.ts) serves its recorded accounts through hooks and never logs in for real.
    if (process.env.REPLAY_ONLY === '1') throw new Error(`replay has no record for ${name}; it never logs in`);
    const [
        { assertSideOwns, loadOwners },
        { ensureCredential },
        { assertLiveWorkerRelease },
    ] = await Promise.all([
        import('../fleet'),
        import('../fleet-vault'),
        import('../worker-release'),
    ]);
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
    const scriptFile = opts.record?.script ?? process.argv[1] ?? '';
    const prayerGuardOn = process.env.PRAYER_GUARD !== '0';
    const eatGuardOn = process.env.EAT_GUARD !== '0' && !NO_GUARD_SCRIPT_RE.test(basename(scriptFile));
    const [
        { connectInProcess },
        { startLedger, stalled },
        { GUARD_VALUE, recordRun, sellsItems, sharedLootTables },
        { createTickRecorder },
        { startStatus },
        { FLEE_HP, appendDeathAlert, damageLog, deathAlert, deathLine, recoverDeath },
        { fleetLeaseAllowsWorker },
        prayerMod,
        attackStylesMod,
        huntersMod,
        opponentMod,
        eatGuardMod,
        randomEventsMod,
        { hpFloorOf },
    ] = await Promise.all([
        import('../inprocess'),
        import('../ledger'),
        import('../loot'),
        import('../tick-record'),
        import('../status'),
        import('../death-recovery'),
        import('../fleet-lease'),
        prayerGuardOn ? import('../prayer-guard') : Promise.resolve(null),
        prayerGuardOn ? import('../../../knowledge/src/npc-attack-styles') : Promise.resolve(null),
        prayerGuardOn ? import('../../../knowledge/src/npc-hunters') : Promise.resolve(null),
        prayerGuardOn ? import('../opponent') : Promise.resolve(null),
        eatGuardOn ? import('../eat-guard') : Promise.resolve(null),
        import('../randomevents'),
        import('../hp-floor'),
    ]);
    // The prayer guard reads two NPC tables, and the first read takes about 1 s. It runs before the connection: a
    // connected client that does not answer holds the tick of a lockstep world for every other client.
    const guardTables = prayerGuardOn
        ? { protect: prayerMod!.protectByStyle(attackStylesMod!.npcAttackStyles()), hunters: huntersMod!.npcHunters() }
        : null;
    // The loot job reads the item tables and the hunting NPCs: read them here too, for the same reason.
    const events = process.env.RANDOM_EVENTS !== '0', lootOn = process.env.LOOT_WATCH !== '0' && !recordRun(name);
    // On a death the bot first runs back for its items (packages/core/src/death-recovery.ts) while the watcher holds
    // the script; the session then ends as a death, as before. DEATH_RECOVERY=0 turns it off; a record run never runs it.
    const deathOn = process.env.DEATH_RECOVERY !== '0' && !recordRun(name);
    // The value guard keeps a held stack worth GUARD_VALUE coins from a drop, a sale or an alch (randomevents.ts
    // `guard`). VALUE_GUARD=0 turns it off; a record run and a script that sells, alchs or trades on purpose get none.
    const guardOn = process.env.VALUE_GUARD !== '0' && !recordRun(name) && !sellsItems(scriptFile);
    // The flee guard (randomevents.ts `flee`): at its flee line (the larger of FLEE_HP of the maximum Hitpoints and
    // two estimated hits of the attacker) or less, with no PLAIN_FOOD in the pack, the bot runs
    // out of the attacker's reach and the session ends there instead of in a death. FLEE_GUARD=0 turns it off; a record
    // run and a PvP script (it fights on purpose at low Hitpoints) get none.
    const fleeOn = process.env.FLEE_GUARD !== '0' && !recordRun(name) && !/pk|pvp|spar|gang/i.test(scriptFile.split(/[\\/]/).at(-1) ?? '');
    const lootTables = lootOn ? sharedLootTables() : null;
    if (lootOn) randomEventsMod.loadDanger();
    const s = await connectInProcess({
        name, password, server, ...(trade ? {
            trade: { ...trade, check: srv => { assertSideOwns(name); trade.check(srv); } },
        } : {}),
        ...(opts.allowTradePartners?.length ? { allowTradePartners: opts.allowTradePartners } : {}),
        ...(opts.patientClaim ? { patientClaim: true } : {}),
    });
    await awaitBotReady(s, log);
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
    const ownerFriends = (lootTables || guardTables) ? new Set(loadOwners().keys()) : null;
    if (events || lootTables || deathOn || guardOn || fleeOn) {
        randomEvents.set(s, randomEventsMod.watchRandomEvents(s, {
            events,
            flee: fleeOn ? {
                hp: FLEE_HP, onSafe: detail => {
                    // A timeout or the loss of every flee tile also ends the session: it is a failed flee, not a safe one.
                    log(`FLEE_GUARD ${/^\S+ (timeout|no-tile) /.test(detail) ? 'fail' : 'safe'} ${detail} bot=${name}`);
                    if (!stopping && !settling.has(s)) { stopping = true; stop(`fled at low hitpoints: ${detail}`); }
                },
            } : null,
            guard: guardOn ? { tables: sharedLootTables(), minValue: GUARD_VALUE } : null,
            loot: lootTables ? {
                tables: lootTables, name,
                friends: new Set(ownerFriends!),
                reserved: () => (s as { questReserved?: Record<number, number> }).questReserved ?? {},
            } : null,
        }));
    }
    // Free prayers and protection from NPCs and Wilderness players (packages/core/src/prayer-guard.ts); PRAYER_GUARD=0
    // turns the guard off, PRAYER_OFFENCE=0 turns its Strength and Attack prayers off.
    if (guardTables) {
        prayerGuards.set(s, prayerMod!.startPrayerGuard(s, {
            log: line => log(`${line} bot=${name}`),
            ...(process.env.PRAYER_GUARD_TRACE === '1' ? { trace: log } : {}),
            ...guardTables,
            offence: process.env.PRAYER_OFFENCE !== '0',
            melee: st => opponentMod!.wornWeaponStyle((st?.equipment ?? []).find((i: any) => i.slot === 3)?.id) === 'melee',
            players: {
                ignore: ownerFriends!,
                style: q => { const seen = opponentMod!.readOpponents(s.client).find(v => v.index === q.index); return seen ? opponentMod!.wornWeaponStyle(seen.worn.rhand) : null; },
            },
        }));
    }
    // Eats plain food in a fight when Hitpoints are low and damage arrives (packages/core/src/eat-guard.ts);
    // EAT_GUARD=0 turns the guard off. A script with `quest` or `microbot` in its file name gets no guard
    // (noGuardScript): a fish can be a quest item there, or the script counts each piece of their food.
    // It starts after the prayer guard: its tick callback then counts the prayer inputs of the tick before it sends.
    // quest-sweep marks the edible quest items on the session (questReserved); the guard never eats those.
    if (eatGuardMod) {
        eatGuards.set(s, eatGuardMod.startEatGuard(s, {
            log: line => log(`${line} bot=${name}`),
            reserved: () => (s as { questReserved?: Record<number, number> }).questReserved ?? {},
        }));
    }
    // Any bot stops cleanly when .practice/stop-<name> appears (checked every 25 ticks): a script that never checks
    // it (seen: fishing30 under the supervisor) still logs out in game.
    let stopTicks = 0;
    let stopping = false;
    let lastAlive: DeathSnapshot | null = null;
    let lastHpVal: number | undefined, lastMaxHpVal: number | undefined;
    const lastHpText = () => (lastHpVal !== undefined ? `${lastHpVal}/${lastMaxHpVal}` : '?');
    // The damage of the last ticks, by source, for the DEATH line (death-recovery.ts damageLog).
    const damage = damageLog();
    const stop = (reason: string) => void (opts.onStop ? opts.onStop(s, reason) : finish([s], false, reason));
    // The session's HP floor (packages/core/src/hp-floor.ts) was installed when the session opened; here it gets this
    // run's log, stop and quest reserve. Its stop prints `RESULT fail stop=hp-floor ...`. While the flee guard's job
    // moves the player the floor lets it walk; to walk itself it stops the watcher and that job.
    hpFloorOf(s)?.configure({
        log,
        stop: reason => { if (stopping || settling.has(s)) return false; stopping = true; stop(reason); return true; },
        reserved: () => (s as { questReserved?: Record<number, number> }).questReserved ?? {},
        fleeActive: () => randomEvents.get(s)?.busy() ?? false,
        takeOver: () => randomEvents.get(s)?.stop(),
    });
    const localServer = isLocalServer(server);
    // A live death also goes to .practice/alerts.jsonl (death-recovery.ts deathAlert), so it alerts with no monitor running.
    const logDeath = () => {
        const line = `${deathLine(lastAlive, lastHpText(), damage.cause(), scriptFile)} bot=${name}`;
        log(line);
        if (!localServer) appendDeathAlert(repoRoot, deathAlert(name, line, Date.now()));
    };
    s.onTick(() => {
        const st = s.sdk.getState();
        lastLife = life(st?.player) ?? lastLife;
        const step = deathStep(born, lastLife, opts.continueAfterDeath === true, deathSeen), died = step.died;
        born = step.born; deathSeen = step.seen;
        damage.read(st);
        if (step.announce) logDeath();
        if (!died) {
            const pNow = st?.player;
            if (pNow && !pNow.isDead) {
                lastHpVal = pNow.hp;
                lastMaxHpVal = pNow.maxHp;
                const pack = deathOn && lastAlive && samePackSnapshot(lastAlive.pack, st.inventory)
                    ? lastAlive.pack
                    : (deathOn ? (st.inventory ?? []).filter(Boolean).map((i: any) => ({ id: i.id, count: i.count ?? 1 })) : []);
                const worn = deathOn && lastAlive && sameWornSnapshot(lastAlive.worn, st.equipment)
                    ? lastAlive.worn
                    : (deathOn ? (st.equipment ?? []).filter(Boolean).map((i: any) => i.id) : []);
                lastAlive = {
                    tick: st.tick ?? 0,
                    at: { x: pNow.worldX, z: pNow.worldZ, level: pNow.level ?? 0 },
                    lifeId: pNow.lifeId,
                    pack,
                    worn,
                };
            }
        }
        stopTicks += died ? 0 : 1;
        const reason = stopReasonOf({
            died, stopTicks, stallTicks: STALL_TICKS,
            stopFile: () => localServer ? hasSimStopFile(name, repoRoot) : hasStopFile(name, repoRoot),
            leaseLost: () => !localServer && !fleetLeaseAllowsWorker(repoRoot),
            stalled: () => stalled(led.rows, STALL_TICKS),
        });
        if (!stopping && !settling.has(s) && reason) {
            stopping = true;
            if (reason === 'died') logDeath();
            const watch = randomEvents.get(s), at = lastAlive;
            if (reason !== 'died' || !deathOn || !watch || !at) { stop(reason); return; }
            // The walker's world loads during the respawn wait, not after it.
            const worldReady = getWorld();
            const run = watch.exclusive(() => recoverDeath(s, at, {
                walk: async (to, signal) => (await import('../walk')).goTo(s, await worldReady, to, accountOf(s), { legTimeoutTicks: 100, signal }),
                tables: sharedLootTables(), danger: randomEventsMod.loadDanger(), friends: new Set(loadOwners().keys()), log: line => log(`${line} bot=${name}`),
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
    if (process.env.SIM_LOCKSTEP !== '1') {
        Bun.gc(true);
        ensureLiveGcTimer();
    }
    return s;
}
