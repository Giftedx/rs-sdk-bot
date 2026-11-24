import type { Session } from '../inprocess';
import { createFleeGuard } from './combat';
import { createIfReaderAccessor, createPathFinderAccessor, loadDanger } from './data';
import { createEventScanner } from './events';
import { createActionGate } from './gate';
import { createLootScanner } from './loot-watch';
import {
    HOLD_LIMIT,
    type FriendTrack, type HostileTrack, type Job, type JobSpec,
    type RandomEventOptions, type RandomEventWatch, type SeedTrack, type WatcherContext,
} from './model';

const EMPTY_MSGS: any[] = [];

function createMessageTracker(s: Session) {
    let seen = -1;
    for (const m of s.sdk.getState()?.gameMessages ?? EMPTY_MSGS) {
        const t = m.tick ?? -1;
        if (t > seen) seen = t;
    }
    let fresh: any[] = EMPTY_MSGS;
    return {
        update(st: any) {
            const ms = st?.gameMessages ?? EMPTY_MSGS;
            if (!ms.length) { fresh = EMPTY_MSGS; return; }
            let maxTick = seen;
            let hasFresh = false;
            for (let i = 0; i < ms.length; i++) {
                const t = ms[i].tick ?? -1;
                if (t > seen) hasFresh = true;
                if (t > maxTick) maxTick = t;
            }
            if (!hasFresh) {
                fresh = EMPTY_MSGS;
            } else {
                const next: any[] = [];
                for (let i = 0; i < ms.length; i++) {
                    if ((ms[i].tick ?? -1) > seen) next.push(ms[i]);
                }
                fresh = next;
            }
            seen = maxTick;
        },
        any: (re: RegExp) => {
            for (let i = 0; i < fresh.length; i++) if (re.test(fresh[i].text ?? '')) return true;
            return false;
        },
    };
}

const jobPriority = (key: string) =>
    key.startsWith('flee:') ? 0
        : key === 'mime' || key === 'maze' ? 1
            : key.startsWith('talk:') ? 2
                : key === 'loot-bank' || key.startsWith('loot:') ? 4
                    : 3;

/**
 * Start the per-tick random event, flee-guard, value-guard, and ground-loot watcher for `s`.
 * Returns a handle exposing `stop`, `counts`, `busy`, `kept`, `exclusive`, `lastAction`, and `avoid`.
 */
export function watchRandomEvents(s: Session, opts: RandomEventOptions = {}): RandomEventWatch {
    const log = opts.log ?? ((l: string) => console.log(l));
    const gateOn = opts.gate ?? process.env.RANDOM_EVENTS_GATE !== '0';
    const eventsOn = opts.events ?? true;
    const lampSkill = (opts.lampSkill ?? process.env.RANDOM_EVENTS_LAMP ?? 'auto').toLowerCase();
    const counts: Record<string, number> = {};
    const noDanger = new Map<number, number>();
    const danger = () => opts.danger ?? (opts.danger === null ? noDanger : loadDanger());
    const say = (name: string, action: string, extra = '') => {
        const k = `${name}:${action}`;
        counts[k] = (counts[k] ?? 0) + 1;
        log(`EVENT ${name} ${action} t=${s.tick()}${extra ? ` ${extra}` : ''}`);
    };

    const getIfReader = createIfReaderAccessor(opts.ifReader);
    const getPf = createPathFinderAccessor(opts.pf, opts.loadPf);
    const loot = opts.loot ?? null;
    const jobs = new Map<string, Job>();
    let active: Job | null = null;
    let activeKey: string | null = null;
    let st: any = null;
    let lastStateTick = -1;

    const gate = createActionGate({
        session: s,
        gateOn,
        loot,
        guard: opts.guard ?? null,
        isJobHolding: () => !!active?.hold,
        activeName: () => active?.name,
        say,
        log,
    });

    const newMessages = createMessageTracker(s);
    const ctx: WatcherContext = {
        session: s,
        state: () => st,
        tick: () => s.tick(),
        log,
        say,
        send: gate.send,
        canSend: gate.canSend,
        getPf,
        getIfReader,
        danger,
        newMessages,
        jobs,
        hasActiveJob: () => !!active,
        want: (key: string, job: JobSpec) => { if (!jobs.has(key)) jobs.set(key, { ...job, started: s.tick() }); },
        clearJob: (key: string) => { if (active === jobs.get(key)) { active = null; activeKey = null; } jobs.delete(key); },
        hostiles: new Map<number, HostileTrack>(),
        friends: new Map<number, FriendTrack>(),
        seeds: new Map<number, SeedTrack>(),
        handledNpc: new Set<number>(),
        avoidNpcs: gate.avoidNpcs,
        avoidLocs: gate.avoidLocs,
        kept: gate.kept,
        refusals: gate.refusals,
        ownDrops: gate.ownDrops,
        scriptToolDrops: gate.scriptToolDrops,
        scriptPickupAt: gate.scriptPickupAt,
        lampSkill,
        xpStart: new Map<string, number>(),
        fleetNames: loot?.friends ?? new Set<string>(),
    };

    const eventScanner = createEventScanner(ctx);
    const fleeGuard = opts.flee ? createFleeGuard(ctx, opts.flee) : null;
    const lootScanner = loot ? createLootScanner(ctx, loot) : null;

    const topPendingJob = (): [string, Job] | undefined => {
        if (jobs.size === 0) return undefined;
        let bestKey = '';
        let bestJob: Job | undefined;
        let bestPri = Infinity;
        for (const [k, j] of jobs) {
            if (j.name === 'noop') continue;
            const pri = jobPriority(k);
            if (!bestJob || pri < bestPri || (pri === bestPri && j.started < bestJob.started)) {
                bestKey = k; bestJob = j; bestPri = pri;
            }
        }
        return bestJob ? [bestKey, bestJob] : undefined;
    };

    const off = s.onTick(() => {
        try {
            st = s.sdk.getState();
            if (!st?.player || s.tick() === lastStateTick) return;
            lastStateTick = s.tick();
            if (ctx.xpStart.size === 0) {
                for (const k of st.skills ?? EMPTY_MSGS) ctx.xpStart.set(String(k.name).toLowerCase(), k.experience ?? 0);
            }
            newMessages.update(st);
            if (gate.isExclusive()) {
                gate.expireHeld(s.tick(), HOLD_LIMIT);
                return;
            }
            if (eventsOn) eventScanner.scanEvents();
            if (fleeGuard) { fleeGuard.seeFled(); fleeGuard.scanFlee(); }
            if (lootScanner) lootScanner.scanLoot();
            const top = topPendingJob();
            if (top && (!active || jobPriority(top[0]) < jobPriority(activeKey ?? 'zzz'))) {
                activeKey = top[0];
                active = top[1];
            }
            if (active) {
                const key = activeKey;
                let done = false;
                try { done = !!active.tick(); }
                catch (e) { log(`EVENT ${active.name} error t=${s.tick()} ${String(e)}`); done = true; }
                if (done) {
                    if (key) jobs.delete(key);
                    active = null;
                    activeKey = null;
                    const next = topPendingJob();
                    if (next) { activeKey = next[0]; active = next[1]; }
                }
            }
            if (!gate.holding()) gate.flush();
            else gate.expireHeld(s.tick(), HOLD_LIMIT);
        } catch (e) {
            log(`EVENT watcher error t=${s.tick()} ${String(e)}`);
        }
    });

    return {
        stop() {
            off();
            active = null;
            activeKey = null;
            gate.stop();
        },
        counts: () => ({ ...counts }),
        busy: () => gate.holding(),
        avoid: () => ({ npcs: new Set(gate.avoidNpcs), locs: new Set(gate.avoidLocs) }),
        kept: () => new Map(gate.kept),
        lastAction: () => gate.lastAction(),
        exclusive: <T>(work: () => Promise<T>) => gate.exclusive(work),
    };
}
