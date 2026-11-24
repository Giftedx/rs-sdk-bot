// Core Agility runner covering Gnome, Barbarian, Wilderness, Brimhaven Arena, and progressive courses.
import { accountOf, getWorld } from '../../../core/src/bot';
import { sail as sailBoat, disembark as disembarkBoat, type BoatResult } from '../../../core/src/boat';
import type { Session } from '../../../core/src/inprocess';
import { componentId } from '../../../core/src/logout';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { goTo, sessionWalker } from '../../../core/src/walk';
import { executionContext } from '../../../../vendor/rs-sdk/sdk/execution-context';
import {
    AGILITY_FOOD_PATTERN,
    BRIMHAVEN_ARENA,
    COURSES,
    EAT_DELAY_TICKS,
    OBSTACLE_SETTLE,
    agilityOptions,
    agilityPreflight,
    eatReady,
    inBrimhavenArena,
    inBrimhavenPit,
    onCourse,
    progressiveCourseForLevel,
    resumeStep,
    wildernessStarted,
    type Pos,
} from './courses';
import {
    DRAYNOR_ENTRY,
    STRONGHOLD_GATE,
    brimhavenPaid,
    buyEntryFood,
    crossStrongholdGate,
    draynorFunds,
    gnomeApproachRoute,
    gnomeEntry,
    needsCourseApproach,
    payBrimhavenFee,
    travelAgilityEntry,
} from './entry';
import {
    canonicalCourseName,
    normalizeAgilityConfig,
    type AgilityConfig,
    type AgilityCourseId,
    type AgilityEntrySummary,
    type AgilityOptions,
    type AgilityResult,
    type AgilitySessionOutcome,
    type Course,
    type Step,
} from './types';

export async function runAgility(s: Session, o: AgilityOptions): Promise<AgilityResult> {
    if (canonicalCourseName(o.course) === 'ape-atoll') {
        throw Error('ape-atoll agility course is unsupported on this rev-289 server');
    }
    const start = s.tick();
    const end = start + o.maxTicks;
    let ended = false;
    void s.ended.then(() => {
        ended = true;
    });

    const pos = () => s.sdk.getState()!.player!;
    const xp = () => s.sdk.getSkillXp('Agility')!;
    const base = () => s.sdk.getSkill('Agility')!.baseLevel;
    const hp = () => s.sdk.getSkill('Hitpoints')!.level;
    const live = () => {
        if (ended || o.stop?.()) throw Error('session interrupted');
        if (s.tick() >= end) throw Error('agility tick budget exhausted');
        if (hp() <= 0) throw Error('died');
    };
    let observeAction = () => {};
    const tick = async () => {
        live();
        await waitTicks(s, 1);
        live();
        observeAction();
    };
    const ready = () => {
        const p = s.sdk.getState()?.player;
        const a = s.sdk.getSkill('Agility');
        const h = s.sdk.getSkill('Hitpoints');
        return !!p && p.worldX > 0 && p.worldZ > 0 && !!a && a.baseLevel > 0 && !!h && h.baseLevel > 0
            && Number.isFinite(s.sdk.getSkillXp('Agility')) && Array.isArray(s.sdk.getState()?.inventory);
    };
    if (!await waitUntil(s, ready, { timeoutTicks: Math.min(20, o.maxTicks) })) {
        throw Error('entry state unobserved');
    }
    live();

    const initial = s.sdk.getState()!;
    const project = (list: { slot: number; id: number; count: number }[]) => (list ?? []).map(({ slot, id, count }) => ({ slot, id, count }));
    console.log('AGILITY_INITIAL ' + JSON.stringify({
        name: s.name,
        course: o.course,
        target: o.target,
        tick: s.tick(),
        state: {
            position: { x: pos().worldX, z: pos().worldZ, level: pos().level },
            skills: (initial.skills ?? []).map(({ experience, level, baseLevel }) => ({ experience, level, baseLevel })),
            inventory: project(initial.inventory),
            equipment: project(initial.equipment),
        },
    }));

    const refusal = agilityPreflight(o, base(), s.sdk.getSkill('Agility')!.level);
    if (refusal) throw Error(refusal);

    const beforeXp = xp();
    const beforeLevel = base();
    let laps = 0;
    let falls = 0;
    let pitExits = 0;
    let eats = 0;

    const tile = () => `${pos().worldX},${pos().worldZ},${pos().level}`;
    const anim = () => s.sdk.getState()?.player?.animId ?? -1;
    const rejectedTotal = () => s.sdk.getState()?.opFeedback?.opRejectedCount ?? 0;
    const low = () => hp() < Math.max(8, s.sdk.getSkill('Hitpoints')!.baseLevel * 0.5);

    type Observation = {
        tick: number;
        at: string;
        anim: number;
        rejected: number;
        mapFlags: number;
        hp: number;
        xp: number;
        ops: number;
        messages: { tick: number; text: string }[];
    };
    let ops = 0;
    let pending: {
        step: string;
        tick: number;
        xp: number;
        at: string;
        rejected: number;
        ops: number;
        observations: Observation[];
    } | null = null;

    const observation = (): Observation => ({
        tick: s.tick(),
        at: tile(),
        anim: s.sdk.getState()?.player?.animId ?? NaN,
        rejected: s.sdk.getState()?.opFeedback?.opRejectedCount ?? NaN,
        mapFlags: s.sdk.getState()?.opFeedback?.mapFlagUnsetCount ?? NaN,
        hp: hp(),
        xp: xp(),
        ops,
        messages: (s.sdk.getState()?.gameMessages ?? []).map(m => ({ tick: m.tick, text: m.text })),
    });
    const actionTrace = (event: string, extra: Record<string, unknown>) =>
        console.log('AGILITY_ACTION ' + JSON.stringify({ event, ...observation(), ...extra }));

    observeAction = () => {
        if (pending?.step !== 'stones') return;
        const v = observation();
        const last = pending.observations.at(-1);
        if (last?.tick === v.tick) return;
        pending.observations.push(v);
        actionTrace('observation', { actionId: pending.ops });
    };

    const click = async (step: Step, speculative = false) => {
        if (!speculative && pending?.step === 'stones' && xp() === pending.xp
            && (wildernessStarted('stones', pos()) || (tile() === '3002,3960,0' && anim() === 741))) {
            return;
        }
        live();
        if (s.sdk.getState()?.dialog?.isOpen) {
            ops++;
            actionTrace('modal', {});
            await s.direct({ type: 'closeModal', reason: 'SDK' });
        }
        ops++;
        if (!speculative) {
            pending = {
                step: step.name,
                tick: s.tick(),
                xp: xp(),
                at: tile(),
                rejected: rejectedTotal(),
                ops,
                observations: [observation()],
            };
        }
        actionTrace('dispatch', { step: step.name, locId: step.id, x: step.x, z: step.z, speculative, actionId: pending?.ops ?? null });
        await s.direct({ type: 'interactLoc', x: step.x, z: step.z, locId: step.id, optionIndex: 1, reason: 'SDK' });
    };

    const fallText = (t: string) =>
        /slip|lose your footing|lost your balance|fall|bites you|stumble/i.test(t)
        && !/carefully|safely|skillfully|skilfully/i.test(t);

    const settleObstacle = async (sequence: number) => {
        const p = pending;
        if (!p) return;
        const settleStart = s.tick();
        const ops0 = ops;
        const marks: Observation[] = [];
        let quiet = 0;
        let last: Observation | undefined;
        let xpTick: number | undefined;
        let fallTick: number | undefined;
        const report = (event: string) => ({
            event,
            sequence,
            step: p.step,
            dispatchTick: p.tick,
            dispatchAt: p.at,
            start: settleStart,
            tick: s.tick(),
            actionId: p.ops,
            observations: p.observations,
            quiet,
            xpTick,
            fallTick,
            rejected: rejectedTotal() - p.rejected,
            opsSinceDispatch: ops - p.ops,
            opsWhileSettling: ops - ops0,
            marks,
        });
        for (;;) {
            const v = observation();
            if (v.xp > p.xp) xpTick ??= v.tick;
            if ((s.sdk.getState()?.gameMessages ?? []).some(m => m.tick >= p.tick && fallText(m.text))) fallTick ??= v.tick;
            quiet = last && v.tick === last.tick + 1 && v.at === last.at && v.anim === -1 && last.anim === -1
                && v.rejected === last.rejected && Number.isFinite(v.rejected) && Number.isFinite(v.mapFlags)
                && v.mapFlags === last.mapFlags && v.ops === last.ops && v.hp === last.hp && v.xp === last.xp
                ? quiet + 1
                : 0;
            marks.push(v);
            last = v;
            if (quiet >= OBSTACLE_SETTLE.quietTicks) {
                pending = null;
                console.log('AGILITY_FOOD ' + JSON.stringify({ ...report('settle'), settled: true }));
                return;
            }
            if (v.tick - settleStart >= OBSTACLE_SETTLE.maxTicks) {
                const r = { ...report('settle'), settled: false };
                console.log('AGILITY_FOOD ' + JSON.stringify(r));
                throw Error(`obstacle settlement unresolved before food: ${JSON.stringify(r)}`);
            }
            await tick();
        }
    };

    let lastEat = -Infinity;
    const health = async (): Promise<void> => {
        live();
        if (!low()) return;
        await settleObstacle(eats + 1);
        live();
        if (!low()) return;
        if (!eatReady(lastEat, s.tick())) {
            console.log('AGILITY_FOOD ' + JSON.stringify({
                event: 'cooldown',
                sequence: eats + 1,
                tick: s.tick(),
                lastEffectTick: lastEat,
                readyAfter: lastEat + EAT_DELAY_TICKS,
            }));
            await waitUntil(s, () => eatReady(lastEat, s.tick()), { timeoutTicks: Math.max(0, Math.min(EAT_DELAY_TICKS + 1, end - s.tick())) });
            live();
            if (!eatReady(lastEat, s.tick())) throw Error('food effect unobserved: eat delay unexpired at deadline');
        }
        const f = s.sdk.getInventory().find(i => AGILITY_FOOD_PATTERN.test(i.name));
        if (!f) throw Error('low HP: no owned food');
        const oldHp = hp();
        const held = s.sdk.getInventory().filter(i => i.id === f.id).reduce((n, i) => n + i.count, 0);
        const sentAt = s.tick();
        const seenMsgs = new Set((s.sdk.getState()?.gameMessages ?? []).map(m => `${m.observationId}:${m.tick}:${m.text}`));
        const rejected0 = rejectedTotal();
        const ops0 = ops;
        const observe = () => {
            const st = s.sdk.getState();
            const inventory = s.sdk.getInventory().map(i => ({ slot: i.slot, id: i.id, count: i.count }));
            return {
                tick: s.tick(),
                hp: hp(),
                baseHp: s.sdk.getSkill('Hitpoints')!.baseLevel,
                xp: xp(),
                count: inventory.filter(i => i.id === f.id).reduce((n, i) => n + i.count, 0),
                inventory,
                at: tile(),
                workerOps: ops,
                anim: st?.player?.animId ?? null,
                dialog: st?.dialog ?? null,
                rejected: rejectedTotal() - rejected0,
                ops: ops - ops0,
                messages: (st?.gameMessages ?? []).filter(m => !seenMsgs.has(`${m.observationId}:${m.tick}:${m.text}`)).map(m => ({ tick: m.tick, text: m.text })),
            };
        };
        const trace = (event: string, extra: Record<string, unknown> = {}) =>
            console.log('AGILITY_FOOD ' + JSON.stringify({ event, sequence: eats + 1, slot: f.slot, id: f.id, held, ...observe(), ...extra }));
        trace('dispatch');
        ops++;
        actionTrace('food', { sequence: eats + 1, slot: f.slot, id: f.id });
        const sent = await s.direct({ type: 'useInventoryItem', slot: f.slot, optionIndex: 1, reason: 'SDK' });
        trace('reply', { reply: sent });
        if ((sent as { success?: boolean } | undefined)?.success !== true) {
            throw Error(`food dispatch refused: ${JSON.stringify({ sent, tick: s.tick(), hp: hp(), slot: f.slot, id: f.id, held })}`);
        }
        let hpTick: number | undefined;
        let inventoryTick: number | undefined;
        if (!await waitUntil(s, () => {
            const v = observe();
            trace('observation');
            if (v.hp > oldHp) hpTick ??= v.tick;
            if (v.count === held - 1) inventoryTick ??= v.tick;
            return v.hp > oldHp && v.count === held - 1;
        }, { timeoutTicks: Math.max(0, Math.min(8, end - s.tick())) })) {
            live();
            const st = s.sdk.getState();
            const count = s.sdk.getInventory().filter(i => i.id === f.id).reduce((n, i) => n + i.count, 0);
            const messages = (st?.gameMessages ?? []).filter(m => !seenMsgs.has(`${m.observationId}:${m.tick}:${m.text}`)).map(m => m.text);
            throw Error(`food effect unobserved: ${JSON.stringify({
                sentAt,
                tick: s.tick(),
                lastEat,
                oldHp,
                hp: hp(),
                slot: f.slot,
                id: f.id,
                held,
                count,
                anim: st?.player?.animId,
                dialog: !!st?.dialog?.isOpen,
                rejected: rejectedTotal() - rejected0,
                ops: ops - ops0,
                messages,
            })}`);
        }
        trace('effect', { hpTick, inventoryTick });
        eats++;
        lastEat = s.tick();
        live();
        if (low()) await health();
    };

    const entry: AgilityEntrySummary = { route: 'none', fares: 0, foodBought: 0, coinsSpent: 0, eats: 0, gate: null };

    if (o.course === 'brimhaven') {
        const res = await runBrimhavenArena(s, o, {
            live,
            tick,
            health,
            low,
            click,
            xp,
            base,
            hp,
            pos,
            end,
            beforeXp,
            beforeLevel,
            start,
            fallText,
            eats: () => eats,
            falls: () => { falls++; },
            pitExit: () => { pitExits++; },
            getCounters: () => ({ laps, falls, pitExits, eats }),
            entry,
        });
        return res;
    }

    let activeCourse: Course = o.course === 'progressive'
        ? progressiveCourseForLevel(base(), { barcrawl: o.barcrawl, potion: o.potion })
        : (o.course as Course);

    const enterPhysicalCourse = async (course: Course) => {
        const C = COURSES[course];
        const pit = () => !!C.pit && pos().level === 0 && Math.abs(pos().worldX - C.pit.x) < 15 && Math.abs(pos().worldZ - C.pit.z) < 20;
        const recoverPit = async () => {
            const deadline = Math.min(end, s.tick() + o.progressTicks);
            await health();
            while (pit() && s.tick() < deadline) {
                await click(C.pit!);
                await tick();
            }
            if (pit() || !onCourse(course, pos())) throw Error('pit exit unobserved');
            pitExits++;
            console.log(`AGILITY_RECOVERY pit tick=${s.tick()} at=${pos().worldX},${pos().worldZ}`);
        };

        if (course === 'wilderness' && s.sdk.getSkill('Agility')!.level < 52) {
            const pot = s.sdk.getInventory().find(i => /^agility potion/i.test(i.name));
            if (!o.potion || !pot) throw Error('missing owned agility potion');
            ops++;
            await s.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
            if (!await waitUntil(s, () => s.sdk.getSkill('Agility')!.level >= 52, { timeoutTicks: Math.min(8, end - s.tick()) })) {
                throw Error('agility boost unobserved');
            }
            live();
        }
        if (pit()) await recoverPit();

        if (needsCourseApproach(course, pos())) {
            if (pos().level !== 0) throw Error('unsupported entry plane');
            const region = course === 'gnome' ? gnomeEntry(pos()) : 'walk';
            if (!region) throw Error('unsupported gnome entry region: no safe route from here');
            const coins = () => s.sdk.getInventory().filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
            const owned = () => s.sdk.getInventory().filter(i => AGILITY_FOOD_PATTERN.test(i.name)).reduce((n, i) => n + i.count, 0);
            if (region === 'draynor') {
                const short = draynorFunds(coins(), owned());
                if (short) throw Error(short);
            }
            entry.route = region;
            const coins0 = coins();
            const eats0 = eats;
            const entryEnd = Math.min(end, s.tick() + o.entryTicks);
            const left = (label: string) => {
                live();
                if (s.tick() >= entryEnd) throw Error(`${label}: entry tick budget exhausted`);
            };
            const travel = async (points: { x: number; z: number; tol?: number }[], label: string) => {
                await travelAgilityEntry(await sessionWalker(s), points, label, entryEnd, {
                    left,
                    live,
                    health,
                    low,
                    heals: () => eats,
                    interrupted: () => ended || hp() <= 0 || executionContext.getStore()?.signal.aborted === true,
                });
            };
            const boatStop = () => ended || hp() <= 0;
            const boatFailed = (r: BoatResult, label: string) => {
                live();
                if (r.outcome === 'deadline') throw Error(`${label}: entry tick budget exhausted`);
                throw Error(`${label}: ${r.detail}`);
            };
            const sail = async (npc: RegExp, choices: RegExp[], deck: { x: number; z: number }, label: string) => {
                left(label);
                const before = coins();
                const r = await sailBoat(s, { npc, choices, deck, stop: boatStop, deadline: entryEnd, before: health, retryTicks: 1 });
                if (!r.ok) boatFailed(r, `${label} unobserved`);
                live();
                const paid = before - coins();
                if (paid !== DRAYNOR_ENTRY.fare) throw Error(`${label} fare effect unobserved: paid ${paid}`);
                entry.fares++;
                console.log(`AGILITY_ENTRY_FARE ${JSON.stringify({ leg: label, paid, coins: coins(), tick: s.tick() })}`);
                const g = await disembarkBoat(s, { stop: boatStop, deadline: entryEnd, attempts: 6, missTicks: 1 });
                if (!g.ok) boatFailed(g, `${label} gangplank unobserved`);
                live();
            };

            if (region === 'draynor') {
                await travel(DRAYNOR_ENTRY.toSarim, 'walk to Port Sarim');
                if (owned() === 0) {
                    entry.foodBought = (await buyEntryFood(s, { approach: travel, left, live, coins, owned, deadline: entryEnd })).bought;
                    await travel([DRAYNOR_ENTRY.dock], 'walk to Port Sarim dock');
                }
                await sail(/^(seaman|captain tobias)/i, [/^yes please/i], DRAYNOR_ENTRY.musaDeck, 'sail to Karamja');
                await travel(DRAYNOR_ENTRY.toBrimhaven, 'walk to Brimhaven');
                await sail(/^customs officer$/i, [/journey on this ship/i, /search away/i, /^ok\.?$/i], DRAYNOR_ENTRY.ardougneDeck, 'sail to Ardougne');
                await travel(DRAYNOR_ENTRY.toCourse, 'walk to Gnome Stronghold');
            }
            if (course === 'gnome') {
                const w = await sessionWalker(s);
                const p = pos();
                const at = `${p.worldX},${p.worldZ},${p.level}`;
                const route = gnomeApproachRoute((a, b) => w.plan(0, a, b), { x: p.worldX, z: p.worldZ });
                console.log(`AGILITY_ENTRY_ROUTE ${JSON.stringify({ route, at, tick: s.tick() })}`);
                if (!route) {
                    const r = await goTo(s, await getWorld(), { ...C.start, level: 0 }, accountOf(s), { legTimeoutTicks: 150 });
                    live();
                    console.log(`AGILITY_ENTRY_WORLD ${JSON.stringify({ ok: r.ok, detail: r.ok ? undefined : r.detail, at: `${pos().worldX},${pos().worldZ},${pos().level}`, tick: s.tick() })}`);
                    if (!r.ok) throw Error(`course approach: no supported public route from ${at}: ${r.detail}`);
                }
                if (route === 'gate') {
                    await travel([{ ...STRONGHOLD_GATE.south, tol: 1 }], 'walk to Stronghold gate');
                    entry.gate = await crossStrongholdGate(s, { left, live, health });
                }
            }
            if (course !== 'gnome' && o.course === 'progressive' && Math.max(Math.abs(pos().worldX - C.start.x), Math.abs(pos().worldZ - C.start.z)) > 12) {
                const r = await goTo(s, await getWorld(), { ...C.start, level: 0 }, accountOf(s), { legTimeoutTicks: 150 });
                live();
                if (!r.ok) throw Error(`progressive course transfer failed: ${r.detail}`);
            }
            await travel([{ ...C.start, tol: 1 }], 'course approach');
            entry.coinsSpent = coins0 - coins();
            entry.eats = eats - eats0;
            console.log(`AGILITY_ENTRY ${JSON.stringify({ ...entry, tick: s.tick(), at: `${pos().worldX},${pos().worldZ},${pos().level}` })}`);
        }
        if (course === 'barbarian' && !onCourse(course, pos())) {
            const deadline = Math.min(end, s.tick() + o.progressTicks);
            while (!onCourse(course, pos()) && s.tick() < deadline) {
                await click({ name: 'entry-pipe', id: 2287, x: 2552, z: 3559 });
                await tick();
            }
        }
        if (course === 'wilderness' && !onCourse(course, pos())) {
            const deadline = Math.min(end, s.tick() + o.progressTicks);
            const gateXp = xp();
            let last = '';
            while ((!onCourse(course, pos()) || xp() <= gateXp) && s.tick() < deadline) {
                await health();
                if (s.sdk.getSkill('Agility')!.level < 52) throw Error('wilderness entry boost expired');
                const p = `${pos().worldX},${pos().worldZ},${pos().level}`;
                if (p === last || !last) await click({ name: 'ridge', id: 2309, x: 2998, z: 3917 });
                last = p;
                await tick();
            }
            if (xp() <= gateXp) throw Error('ridge XP effect unobserved');
        }
        if (!onCourse(course, pos())) throw Error('course entry unobserved');
        return { C, pit, recoverPit };
    };

    const doneGoal = () => (o.stopOnMaxLaps ? laps >= o.maxLaps : base() >= o.target);
    let { C, pit, recoverPit } = await enterPhysicalCourse(activeCourse);
    let i = resumeStep(activeCourse, pos());
    let stepXp = xp();
    let stepStart = s.tick();
    let previous = tile();
    let still = 0;
    let preBlocked = false;

    const advance = async (step: Step) => {
        await health();
        if (pit() || xp() > stepXp) return;
        await click(step);
    };
    const seen = new Set<string>();
    for (const m of s.sdk.getState()?.gameMessages ?? []) seen.add(`${m.observationId}:${m.tick}:${m.text}`);

    if (!doneGoal()) await advance(C.steps[i]!);
    while (!doneGoal()) {
        await tick();
        const p = pos();
        let fell = false;
        for (const m of s.sdk.getState()?.gameMessages ?? []) {
            const key = `${m.observationId}:${m.tick}:${m.text}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (fallText(m.text)) fell = true;
        }
        if (fell) {
            falls++;
            preBlocked = true;
            console.log(`AGILITY_RECOVERY fall tick=${s.tick()} step=${C.steps[i]!.name} hp=${hp()} at=${p.worldX},${p.worldZ} xp=${xp()}`);
        }
        if (low()) await health();
        if (pit()) {
            await recoverPit();
            i = activeCourse === 'wilderness' ? resumeStep(activeCourse, pos()) : 0;
            stepXp = xp();
            stepStart = s.tick();
            preBlocked = false;
            await advance(C.steps[i]!);
            continue;
        }
        if (!onCourse(activeCourse, p)) throw Error('left course or died');
        const position = tile();
        still = position === previous ? still + 1 : 0;
        previous = position;
        const step = C.steps[i]!;
        const gain = xp() - stepXp;
        const zeroDone = step.zero && still >= 1 && (step.name === 'ladder' ? p.level === 0 && p.worldX <= 2533 : p.worldZ <= 3933);
        if (gain > 0 || zeroDone) {
            if (i === C.steps.length - 1) {
                laps++;
                if (o.stopOnMaxLaps && laps >= o.maxLaps) {
                    console.log(`AGILITY_PROGRESS level=${base()} xp=${xp()} tick=${s.tick()} step=${step.name}`);
                    break;
                }
                if (laps >= o.maxLaps && base() < o.target) throw Error('agility lap budget exhausted');
            }
            console.log(`AGILITY_PROGRESS level=${base()} xp=${xp()} tick=${s.tick()} step=${step.name}`);
            if (base() >= o.target && !o.stopOnMaxLaps) break;
            if (o.course === 'progressive' && i === C.steps.length - 1) {
                const nextCourse = progressiveCourseForLevel(base(), { barcrawl: o.barcrawl, potion: o.potion });
                if (nextCourse !== activeCourse) {
                    activeCourse = nextCourse;
                    ({ C, pit, recoverPit } = await enterPhysicalCourse(activeCourse));
                    i = resumeStep(activeCourse, pos());
                    stepXp = xp();
                    stepStart = s.tick();
                    still = 0;
                    preBlocked = false;
                    await advance(C.steps[i]!);
                    continue;
                }
            }
            i = (i + 1) % C.steps.length;
            stepXp = xp();
            stepStart = s.tick();
            still = 0;
            preBlocked = false;
            await advance(C.steps[i]!);
            continue;
        }
        if (activeCourse === 'barbarian' && i === 3 && p.level === 0 && still >= 1) {
            i = 2;
            await advance(C.steps[i]!);
        }
        if (s.tick() - stepStart >= o.progressTicks) throw Error(`no observed progress at ${step.name}`);
        if (activeCourse === 'wilderness' && !preBlocked && wildernessStarted(step.name, p)) {
            if (low()) await health();
            else {
                if (step.name === 'stones') preBlocked = true;
                await click(C.steps[(i + 1) % C.steps.length]!, step.name === 'stones');
            }
            continue;
        }
        if (still >= 1) await advance(C.steps[i]!);
    }

    live();
    if ((!o.stopOnMaxLaps && base() < o.target) || (o.stopOnMaxLaps && laps < o.maxLaps) || xp() <= beforeXp) {
        throw Error('agility goal or XP effect absent');
    }
    return {
        ok: true,
        at: new Date().toISOString(),
        course: o.course,
        target: o.target,
        beforeLevel,
        level: base(),
        xpGained: xp() - beforeXp,
        laps,
        falls,
        pitExits,
        eats,
        finalHp: hp(),
        entry,
        ticks: s.tick() - start,
    };
}

interface BrimhavenCtx {
    live: () => void;
    tick: () => Promise<void>;
    health: () => Promise<void>;
    low: () => boolean;
    click: (step: Step, speculative?: boolean) => Promise<void>;
    xp: () => number;
    base: () => number;
    hp: () => number;
    pos: () => Pos;
    end: number;
    beforeXp: number;
    beforeLevel: number;
    start: number;
    fallText: (t: string) => boolean;
    eats: () => number;
    falls: () => void;
    pitExit: () => void;
    getCounters: () => { laps: number; falls: number; pitExits: number; eats: number };
    entry: AgilityEntrySummary;
}

async function runBrimhavenArena(s: Session, o: AgilityOptions, ctx: BrimhavenCtx): Promise<AgilityResult> {
    const coins = () => s.sdk.getInventory().filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
    const ticketCount = () => s.sdk.getInventory().filter(i => i.id === BRIMHAVEN_ARENA.ticketId).reduce((n, i) => n + i.count, 0);
    const ladderDown = () => (s.sdk.getState()?.nearbyLocs ?? []).find(l => l.id === BRIMHAVEN_ARENA.ladderDown.id);

    if (!inBrimhavenArena(ctx.pos()) && !inBrimhavenPit(ctx.pos())) {
        if (ctx.pos().level !== 0) throw Error('unsupported entry plane');
        if (!brimhavenPaid(s) && coins() < BRIMHAVEN_ARENA.feeCoins) {
            throw Error(`brimhaven entry needs ${BRIMHAVEN_ARENA.feeCoins} carried coins`);
        }
        const entryEnd = Math.min(ctx.end, s.tick() + o.entryTicks);
        ctx.entry.route = 'brimhaven';
        if (Math.max(Math.abs(ctx.pos().worldX - BRIMHAVEN_ARENA.entry.x), Math.abs(ctx.pos().worldZ - BRIMHAVEN_ARENA.entry.z)) > 8) {
            const move = await goTo(s, await getWorld(), { ...BRIMHAVEN_ARENA.entry }, accountOf(s), { legTimeoutTicks: Math.min(200, o.entryTicks) });
            ctx.live();
            if (!move.ok) throw Error(`brimhaven entry travel failed: ${move.detail}`);
        }
        const c0 = coins();
        await payBrimhavenFee(s, entryEnd, ctx.live, ctx.tick);
        ctx.entry.coinsSpent = Math.max(0, c0 - coins());
        while (!inBrimhavenArena(ctx.pos()) && s.tick() < entryEnd) {
            await ctx.health();
            const down = ladderDown();
            await ctx.click({
                name: 'brimhaven-ladder-down',
                id: down?.id ?? BRIMHAVEN_ARENA.ladderDown.id,
                x: down?.x ?? BRIMHAVEN_ARENA.ladderDown.x,
                z: down?.z ?? BRIMHAVEN_ARENA.ladderDown.z,
            });
            await ctx.tick();
        }
        if (!inBrimhavenArena(ctx.pos())) throw Error('brimhaven arena entry unobserved');
    }

    let tags = 0;
    let lastTagXp = ctx.xp();
    let stepStart = s.tick();
    let lastObstacleKey = '';
    const tickets0 = ticketCount();

    const targetReached = () => (o.stopOnMaxLaps ? tags >= o.maxLaps : ctx.base() >= o.target);
    const seen = new Set<string>();
    for (const m of s.sdk.getState()?.gameMessages ?? []) seen.add(`${m.observationId}:${m.tick}:${m.text}`);

    while (!targetReached()) {
        ctx.live();
        if (ctx.low()) await ctx.health();
        for (const m of s.sdk.getState()?.gameMessages ?? []) {
            const key = `${m.observationId}:${m.tick}:${m.text}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (ctx.fallText(m.text)) ctx.falls();
            if (/ticket/i.test(m.text)) tags++;
        }

        const p = ctx.pos();
        if (inBrimhavenPit(p)) {
            const rope = (s.sdk.getState()?.nearbyLocs ?? [])
                .filter(l => l.id === BRIMHAVEN_ARENA.climbRopeId)
                .sort((a, b) => a.distance - b.distance)[0];
            if (!rope) throw Error('brimhaven pit climbing rope unobserved');
            await ctx.click({ name: 'brimhaven-rope-up', id: rope.id, x: rope.x, z: rope.z });
            await ctx.tick();
            if (inBrimhavenArena(ctx.pos())) ctx.pitExit();
            continue;
        }
        if (!inBrimhavenArena(p)) throw Error('left brimhaven arena or died');

        const curXp = ctx.xp();
        if (curXp > lastTagXp) {
            if (o.stopOnMaxLaps && !seen.has(`xp:${s.tick()}`)) tags++;
            lastTagXp = curXp;
            stepStart = s.tick();
            console.log(`AGILITY_PROGRESS level=${ctx.base()} xp=${curXp} tick=${s.tick()} step=brimhaven`);
            if (targetReached()) break;
        }
        if (s.tick() - stepStart >= o.progressTicks) {
            throw Error('no observed progress at brimhaven');
        }

        const client = s.client as { hintType?: number; hintTileX?: number; hintTileZ?: number } | undefined;
        const hintTarget = client?.hintType === 2 && Number.isInteger(client.hintTileX) && Number.isInteger(client.hintTileZ)
            ? { x: client.hintTileX!, z: client.hintTileZ! }
            : undefined;
        const locs = s.sdk.getState()?.nearbyLocs ?? [];
        const activePillar = hintTarget
            ? locs.find(l => BRIMHAVEN_ARENA.pillarLocIds.includes(l.id) && l.x === hintTarget.x && l.z === hintTarget.z)
            : locs.filter(l => BRIMHAVEN_ARENA.pillarLocIds.includes(l.id)).sort((a, b) => a.distance - b.distance)[0];

        if (activePillar && activePillar.distance <= 5) {
            await ctx.click({ name: 'brimhaven-pillar', id: activePillar.id, x: activePillar.x, z: activePillar.z });
            await ctx.tick();
            continue;
        }

        const level = ctx.base();
        const candidates = locs
            .filter(l => {
                if (!BRIMHAVEN_ARENA.obstacleIds.has(l.id)) return false;
                const minLv = BRIMHAVEN_ARENA.obstacleMinLevel.get(l.id) ?? 1;
                return level >= minLv;
            })
            .sort((a, b) => {
                const aScore = hintTarget ? Math.abs(a.x - hintTarget.x) + Math.abs(a.z - hintTarget.z) : a.distance;
                const bScore = hintTarget ? Math.abs(b.x - hintTarget.x) + Math.abs(b.z - hintTarget.z) : b.distance;
                return aScore - bScore;
            });
        const picked = candidates.find(l => `${l.id}:${l.x},${l.z}` !== lastObstacleKey) ?? candidates[0];
        if (!picked) {
            await ctx.tick();
            continue;
        }
        lastObstacleKey = `${picked.id}:${picked.x},${picked.z}`;
        await ctx.click({ name: `brimhaven-${picked.id}`, id: picked.id, x: picked.x, z: picked.z });
        await ctx.tick();
    }

    if (o.tradeTickets && ticketCount() > 0 && inBrimhavenArena(ctx.pos())) {
        const up = (s.sdk.getState()?.nearbyLocs ?? []).find(l => l.id === BRIMHAVEN_ARENA.ladderUp.id) ?? BRIMHAVEN_ARENA.ladderUp;
        await s.direct({ type: 'interactLoc', x: up.x, z: up.z, locId: up.id, optionIndex: 1, reason: 'SDK' });
        await waitUntil(s, () => !inBrimhavenArena(ctx.pos()), { timeoutTicks: 15 });
        const trader = (s.sdk.getState()?.nearbyNpcs ?? []).find(n => /jack/i.test(n.name));
        if (trader) {
            const op = trader.optionsWithIndex.find(x => /trade/i.test(x.text)) ?? trader.optionsWithIndex[0];
            if (op) await s.sdk.sendInteractNpc(trader.index, op.opIndex);
            await waitTicks(s, 2);
            const btn = componentId('agilityarena_trade:com_94');
            await s.direct({ type: 'clickComponent', componentId: btn, reason: 'SDK' });
            await waitTicks(s, 2);
        }
    }

    ctx.live();
    if ((!o.stopOnMaxLaps && ctx.base() < o.target) || (o.stopOnMaxLaps && tags < o.maxLaps) || (ctx.xp() <= ctx.beforeXp && ticketCount() <= tickets0)) {
        throw Error('agility goal or XP effect absent');
    }
    const counters = ctx.getCounters();
    return {
        ok: true,
        at: new Date().toISOString(),
        course: 'brimhaven',
        target: o.target,
        beforeLevel: ctx.beforeLevel,
        level: ctx.base(),
        xpGained: ctx.xp() - ctx.beforeXp,
        laps: tags,
        falls: counters.falls,
        pitExits: counters.pitExits,
        eats: counters.eats,
        finalHp: ctx.hp(),
        entry: ctx.entry,
        ticks: s.tick() - ctx.start,
        tickets: ticketCount(),
    };
}

export async function runAgilitySession(
    s: Session,
    rawCfg: AgilityConfig,
): Promise<AgilitySessionOutcome> {
    const cfg = normalizeAgilityConfig(rawCfg);
    if (cfg.course === 'ape-atoll') {
        return {
            ok: false,
            kind: 'refused',
            detail: 'ape-atoll agility course is unsupported on this rev-289 server',
            delta: { elapsedTicks: 0 },
        };
    }
    const startTick = s.tick?.() ?? 0;
    try {
        const opts = agilityOptions(cfg.course, String(cfg.targetLevel), cfg.env);
        if (cfg.maxLaps !== undefined) opts.maxLaps = cfg.maxLaps;
        if (cfg.stopOnMaxLaps !== undefined) opts.stopOnMaxLaps = cfg.stopOnMaxLaps;
        if (cfg.maxTicks !== undefined) opts.maxTicks = cfg.maxTicks;
        if (cfg.progressTicks !== undefined) opts.progressTicks = cfg.progressTicks;
        if (cfg.entryTicks !== undefined) opts.entryTicks = cfg.entryTicks;
        if (cfg.usePotion !== undefined) opts.potion = cfg.usePotion;
        if (cfg.barcrawl !== undefined) opts.barcrawl = cfg.barcrawl;
        if (cfg.tradeTickets !== undefined) opts.tradeTickets = cfg.tradeTickets;
        if (cfg.stop !== undefined) opts.stop = cfg.stop;

        const result = await runAgility(s, opts);
        return {
            ok: result.ok,
            kind: result.ok ? 'completed' : 'failed',
            detail: `agility-order ${result.course} level=${result.level} target=${result.target} xp=${result.xpGained}`,
            delta: {
                xp: { Agility: result.xpGained },
                ...(result.entry.coinsSpent > 0 ? { coins: -result.entry.coinsSpent } : {}),
                ...(result.tickets ? { items: { [BRIMHAVEN_ARENA.ticketId]: result.tickets } } : {}),
                elapsedTicks: result.ticks,
            },
            result,
        };
    } catch (error) {
        const detail = String(error);
        const elapsedTicks = Math.max(0, (s.tick?.() ?? startTick) - startTick);
        const lower = detail.toLowerCase();
        const kind = lower.includes('died')
            ? 'died'
            : lower.includes('interrupted')
                ? 'aborted'
                : /already at target|unsupported|requires|missing owned|needs \d+ carried/.test(lower)
                    ? 'refused'
                    : 'failed';
        return { ok: false, kind, detail, delta: { elapsedTicks } };
    }
}
