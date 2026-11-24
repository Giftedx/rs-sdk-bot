import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { accountJobRows, boundedOperation, capacityState, collectionState, effectiveJob, operationState, productionGoal } from '../../collection';
import { coordinationView } from '../../coordination';
import { dashboardStatuses, healthObservation, localDisplayNames, remoteBots, scoreboardView } from '../../fleet-view';
import { flowView } from '../../flow';
import { GEAR_TARGETS } from '../../goal-details';
import { GOAL_RECEIPTS, goalPlan, goalProgress, questPointObservation, type GoalInputs } from '../../goals';
import { projectItemExamine } from '../../item-examine';
import { itemPrice, projectItemPrices, type ItemPrices, type PriceIdentity } from '../../item-prices';
import { cachedTail } from '../../jsonl-tail';
import { packQuests } from '../../quest-pack';
import { contentionView, farmsView, overtakeView, rivalsView, rosterView, wildernessOverlayData, wildernessView } from '../../world-view';
import { xpForLevel } from '../../../planner/src/curve';
import { ownerOfIn } from '../../../core/src/fleet-snapshots';
import { isLocalServer } from '../../../core/src/localserver';
import { findStopFile, fleetStateFile } from '../../../core/src/practice-paths';
import { cached, dashboardDir, every, FILES, fleetList, getMapBytes, liveAccounts, MAIN, MAP, NL, OBJS, PAGE_FILE, practice, remoteNames, ROLE_SKILL, root, SCRIPT_ROLE, shortPhase, snapshotFiles, type Status } from '../config';
import { getItemPrices, getPricesAt, icons, itemExamines, keySupplyIds, marketById, npcLootPrices, vault } from '../market';
import { boardTops, EXTRA, extraBoards, firstSeen, fmtTicks, inferRole, liveTop, NO_ROLE, parseTime, rankDelta, ranks, roster, serverTick, SKILL_BOARDS, snapshot, topOf, valueRanks, world } from '../world';
import { getBuildMs, getCpuPct, getPrRows, procs, viewerTimings } from './host';
import { gapHistory, gates, haggisPlan, race, requests, swarm, type SwarmJob } from './plans';
import { died, fleetDiagnostics, nativeProofs, newestDeath, newestRes, resultProof, results, scripts } from './results';
import { events, flows, phaseSince, practiceNames, rate, readStatuses, spark } from './statuses';
import { alerts, fleetSides, foodChain, roleView, vaultTrend } from './views';

const PAGE_VERSION_FILES = [
    PAGE_FILE,
    ...['map-shell.css', 'map-shell.js', 'client-shell.css', 'client-shell.js', 'client-viewer.css', 'operations.css', 'operations.js', 'xp-tracker.js'].map(f => join(dashboardDir, f)),
];
const XP_FOR_LEVEL_CACHE = new Map<number, number>();
function cachedXpForLevel(level: number): number {
    let v = XP_FOR_LEVEL_CACHE.get(level);
    if (v === undefined) {
        v = xpForLevel(level);
        XP_FOR_LEVEL_CACHE.set(level, v);
    }
    return v;
}

const GEAR_TARGETS_VIEW = GEAR_TARGETS.map(t => ({
    slot: t.slot,
    ids: [t.id, ...('equivalentIds' in t ? t.equivalentIds ?? [] : [])],
    name: OBJS.get(t.id)?.name ?? null,
    need: t.need,
    source: t.source,
}));

/** Computes per-item GP values across visible prices using projected name-based prices. */
function visibleItemValues(
    visiblePrices: (PriceIdentity | string)[],
    byName: ItemPrices['byName'],
): Record<string, number> {
    const out: Record<string, number> = {};
    const byNameOnly = { byId: {}, byName };
    for (const i of visiblePrices) {
        const name = typeof i === 'string' ? i : i.name;
        if (!name || Object.hasOwn(out, name)) continue;
        const p = itemPrice(byNameOnly, name);
        if (p) out[name] = p.value;
    }
    return out;
}

// ---------- state ----------
function buildState() {
    const proofs=nativeProofs(Date.now());
    const localStatuses = readStatuses();
    const sw = swarm();
    const accountJobs=accountJobRows(sw?.jobs);
    // File/proof reads can span a newer controller publication. Compare those
    // observations with the time after the reads, not the build's old start time.
    const now = Date.now();
    const snapshots=snapshotFiles(),side=process.env.FLEET_SIDE??'local',ownerOf=ownerOfIn(FILES.fleet);
    const st=dashboardStatuses(localStatuses,snapshots,ownerOf,side,now);
    const statusByName=new Map([...st.values()].map(s=>[s.name.toLowerCase(),s]));
    const names = localDisplayNames([...liveAccounts(), ...st.keys(), ...accountJobs.map(j => j.account)],snapshots,ownerOf,side,now);
    const jobsByLower = new Map<string, typeof accountJobs>();
    for (const j of accountJobs) {
        const key = j.account.toLowerCase();
        let list = jobsByLower.get(key);
        if (!list) { list = []; jobsByLower.set(key, list); }
        list.push(j);
    }
    const procsByLower = new Map<string, typeof procs>();
    for (const p of procs) {
        for (const a of p.accounts) {
            const key = a.toLowerCase();
            let list = procsByLower.get(key);
            if (!list) { list = []; procsByLower.set(key, list); }
            list.push(p);
        }
    }
    const bots = [...names].map(name => {
        const nameLower = name.toLowerCase();
        const s0 = statusByName.get(nameLower) ?? ({ name, at: 0, server: 'rs-sdk-demo.fly.dev', role: 'unknown', skills: [] } as Status);
        const live = roster.get(nameLower);
        const inWorld = !!live && now - live.seen < 30_000;
        const fresh = !s0.snapshotOnly && now - s0.at < 20_000 && s0.at <= now + 5_000;
        const mine = jobsByLower.get(nameLower) ?? [];
        // Running by hand: a fresh status from a known script while the swarm has no enabled job for the account.
        const byHand = fresh && !isLocalServer(s0.server) && !mine.some(j => j.enabled && j.script) ? SCRIPT_ROLE[String(s0.goal ?? '')] : undefined;
        const s = byHand ? { ...s0, role: byHand.role, goal: byHand.goal } : s0;
        const rankRows = [...(ranks.get(name)?.rows ?? []), ...valueRanks(name)];
        const guess = NO_ROLE.has(s.role) && name !== MAIN ? inferRole(s, rankRows) : null;
        const skill = byHand ? byHand.skill ?? null : ROLE_SKILL[s.role] ?? (guess && (s.skills ?? []).some((k: any) => k.name === guess) ? guess : null);
        const sk = skill ? (s.skills ?? []).find((k: any) => k.name === skill) : null;
        // TARGET is a level only when it is a whole number from 2 to 99; some scripts use it for a count or a name.
        const targetRaw = Number(s.env?.target), target = Number.isInteger(targetRaw) && targetRaw >= 2 && targetRaw <= 99 ? targetRaw : 99;
        const r = fresh ? rate(name, skill) : null;
        // XP left to this run's TARGET level on this server's curve (packages/planner/src/curve.ts), not always 99.
        const xpLeft = sk && Number.isFinite(sk.xp) ? Math.max(0, cachedXpForLevel(target) - sk.xp) : null;
        const ticksLeft = r && r > 0 && xpLeft != null ? xpLeft / r : null;
        // Pace: the account's hiscore time on the goal board (or this run's ticks) plus ticks left, against #1's time.
        // Pace only means something when the run's target reaches #1's level.
        const topRaw = skill ? topOf(skill) : null;
        const top = topRaw && target >= topRaw.level ? topRaw : null;
        const row = skill ? rankRows.find(x => x.board === skill) : null;
        const played = Math.max(row ? parseTime(row.time) : 0, s.tick ?? 0);
        const finish = ticksLeft != null ? played + ticksLeft : null;
        const ph = s.phase ?? '';
        const since = ph ? phaseSince.get(name + NL + ph) : undefined;
        const last = String(s.timeline ?? '').slice(-1);
        // An account can have two entries (an old disabled single job and a host job): the enabled one wins.
        // An entry without a script is a reservation (the main account), not a job.
        const jobRaw = mine.find(j => j.enabled && j.script) ?? mine.filter(j => j.script).pop() ?? null;
        const jobBeforeStatus = byHand ? { ...(jobRaw ?? { account: name, repeat: false, since: null }), script: String(s0.goal), role: byHand.role, goal: byHand.goal, enabled: true, state: 'manual', note: `started by hand: ${s0.goal}` } as SwarmJob : jobRaw;
        const job = effectiveJob(s, jobBeforeStatus, fresh);
        const acctProcs = procsByLower.get(nameLower);
        const processActive = !s.snapshotOnly && !!acctProcs && acctProcs.some(p => p.started <= (s.at ?? 0));
        const currentGoal = String(s.goal || job?.goal || '');
        // The status may carry a custom goal. Keep the configured script as
        // classification evidence even when effectiveJob labels it manual.
        const production = productionGoal(currentGoal, jobBeforeStatus?.script);
        const reservedEntry = mine.some(j => !j.script || j.state === 'reserved');
        const res = String(s.result ?? '');
        return {
            ...s, ground: name === MAIN ? [] : s.ground ?? [], flow: name === MAIN || s.snapshotOnly ? null : flowView(flows, name), name, fresh, inWorld, processActive, currentGoal, production, operation: s.snapshotOnly ? (inWorld ? 'unobserved' : 'offline') : operationState({ ...s, inWorld, processActive, planJob:job, reserved: name === MAIN }, now), live: inWorld ? live : null, ranksAt:ranks.get(name)?.at??null, ranks: rankRows.map(x => ({ ...x, ...rankDelta(name, x.board) })),
            role: guess ? guess.toLowerCase() + '*' : s.role, roleInferred: !!guess, seenInFeed: firstSeen.has(nameLower),
            practice: isLocalServer(s.server), lastSeen: Math.max(s.at || 0, live?.seen ?? 0) || null,
            goalSkill: skill, goalLevel: target, goalNow: sk?.level ?? null, goalXp: sk?.xp ?? null, xpPerTick: r,
            xpPerHour: r != null ? r * 3_600_000 / world.tickMs : null, spark: s.snapshotOnly ? [] : spark.get(name) ?? [], rateSkill: skill ?? "all skills", xpLeft,
            eta: ticksLeft != null ? fmtTicks(ticksLeft) : null, finish: finish != null ? fmtTicks(finish) : null,
            pace: finish != null && top ? { top: top.name, topTime: fmtTicks(top.ticks), ahead: finish < top.ticks, gap: fmtTicks(Math.abs(top.ticks - finish)) } : null,
            action: fresh ? ({ x: 'xp', v: 'inventory', m: 'move', a: 'anim', d: 'dialog', s: 'stun', i: 'idle' } as Record<string, string>)[last] ?? null : null,
            phaseShort: shortPhase(ph), phaseSince: since?.at ?? null, phaseExact: since?.exact ?? false,
            uptime: s.started && s.at ? s.at - s.started : null,
            outcome: !res ? null : died(res) ? 'died' : /^ok\b/.test(res) ? 'ok' : 'fail',
            nativeProof: resultProof({name,text:res},proofs),
            job, planJob: jobRaw, bounded: boundedOperation(s), reserved: name === MAIN || (reservedEntry && !job),
            // Training: a fresh bot whose goal skill is still below its target, not a gold farmer or a banker.
            training: fresh && !production && sk != null && sk.level < target && !/^gold farm|bank/i.test(String(job?.goal ?? s.goal ?? '')),
            role4: roleView(s, job, fresh, r),
            // Newest RESULT this server saw for the account, and its newest death in the last 24 h.
            lastRes: (() => { const x = newestRes.get(nameLower); return x && (!s.started || x.at >= s.started) ? { at: x.at, ok: x.ok, died: died(x.text), text: x.text } : null; })(),
            death: (() => { const x0 = newestDeath.get(nameLower), x = x0 && now - x0.at < 86_400_000 && (!s.started || x0.at >= s.started) ? x0 : null; return x ? { at: x.at, text: x.text } : null; })(),
        };
    });
    // The other sides' accounts (Codex cloud, Claude cloud): snapshot items and levels, world-feed position, hiscore ranks.
    const local = new Set(bots.map(b => b.name.toLowerCase()));
    for (const r of remoteBots(snapshots, local, roster, firstSeen, now, side, fleetList(join(FILES.fleet, 'plans')), ownerOf))
        (bots as any[]).push({ ...r, ranksAt: ranks.get(r.name)?.at ?? null, ranks: [...(ranks.get(r.name)?.rows ?? []).map(x => ({ ...x, ...rankDelta(r.name, x.board) })), ...valueRanks(r.name)], spark: [], rateSkill: 'all skills' });
    for (const bot of bots as any[]) { bot.questPoints=questPointObservation(bot,now); Object.assign(bot,healthObservation(bot,now)); }
    // In the world now, then fresh status, then the rest (seen in the feed, live accounts, practice bots); Haggis last.
    const tier = (b: typeof bots[number]) => b.reserved ? 5 : b.inWorld ? 0 : b.fresh ? 1 : b.seenInFeed ? 2 : b.practice ? 4 : 3;
    bots.sort((a, b) => tier(a) - tier(b) || (b.at ?? 0) - (a.at ?? 0) || a.name.localeCompare(b.name));
    // 24 boards: each board's #1 against our best live rank on it.
    const bestOverallByBoard = new Map<string, any>();
    const bestNonMainByBoard = new Map<string, any>();
    for (const bot of bots) {
        const notMain = bot.name !== MAIN;
        for (const r of bot.ranks) {
            const curAll = bestOverallByBoard.get(r.board);
            if (!curAll || r.rank < curAll.rank) bestOverallByBoard.set(r.board, { rank: r.rank, name: bot.name });
            if (notMain) {
                const cur = bestNonMainByBoard.get(r.board);
                if (!cur || r.rank < cur.rank) bestNonMainByBoard.set(r.board, { ...r, name: bot.name });
            }
        }
    }
    const boards = [...SKILL_BOARDS.map(b => {
        const top = topOf(b);
        const best = bestNonMainByBoard.get(b) ?? null;
        const ours = best ? parseTime(best.time) : null;
        // close: 1 = level with #1 or faster, toward 0 = far behind (levels, then time).
        const gap = best && top ? (best.level >= top.level
            ? { kind: 'time', ahead: ours! <= top.ticks, text: fmtTicks(Math.abs(top.ticks - ours!)), close: Math.min(1, top.ticks / Math.max(1, ours!)) }
            : { kind: 'level', ahead: false, text: `-${top.level - best.level} lvl`, close: Math.max(0, best.level / top.level) * 0.8 }) : null;
        return { board: b, top: top ? { name: top.name, level: top.level, time: fmtTicks(top.ticks), ticks: top.ticks, live: top.live, at: top.at } : null, best, gap, kind: 'skill' };
    }), ...EXTRA.map(e => {
        const t = extraBoards.get(e.board), first = t?.rows[0], last = t?.rows[t.rows.length - 1];
        return { board: e.board, top: first ? { name: first.name, level: null, time: first.text, ticks: null } : null, best: null, gap: null, kind: 'value', cutoff: last ? { rank: last.rank, text: last.text } : null };
    })];
    const v = vault(bots, now);
    const cargoDir = join(practice, 'cargo');
    const cargo = every(10_000, cargoDir, () => existsSync(cargoDir) ? readdirSync(cargoDir).filter(f => f.endsWith('.json') && !f.startsWith('request-')).flatMap(f => {
        try { return [JSON.parse(readFileSync(join(cargoDir, f), 'utf8'))]; } catch { return []; }
    }) : []);
    const collection = collectionState(bots, [...new Set([...liveAccounts(), ...remoteNames()])], cargo, cachedTail<any>(FILES.vault, 100_000), now);
    if (!vaultTrend.length || now - vaultTrend[vaultTrend.length - 1]!.at > 60_000) { vaultTrend.push({ at: now, value: Math.round(v.value), coins: v.coins }); if (vaultTrend.length > 240) vaultTrend.shift(); }
    const farmers = (bots as any[]).filter(b => b.role4?.kind === 'gold' && !b.practice);
    const itemPrices = getItemPrices(), pricesAt = getPricesAt();
    const visiblePrices: (PriceIdentity | string)[] = [];
    const pushList = (list: any[] | null | undefined) => {
        if (!Array.isArray(list)) return;
        for (let i = 0; i < list.length; i++) {
            const it = list[i];
            if (it) visiblePrices.push(it);
        }
    };
    const examineItems: { id: number; name?: string }[] = [];
    const pushExamineList = (list: unknown) => {
        if (!Array.isArray(list)) return;
        for (let i = 0; i < list.length; i++) examineItems.push(list[i]);
    };
    for (let bi = 0; bi < bots.length; bi++) {
        const b = bots[bi] as any;
        pushList(b.inventory);
        pushList(b.bank);
        pushList(b.equipment);
        pushExamineList(b.inventory);
        pushExamineList(b.equipment);
        pushExamineList(b.bank);
        pushList(b.flow?.loot);
        pushList(b.flow?.used);
        const ground = b.ground;
        if (Array.isArray(ground)) {
            for (let gi = 0; gi < ground.length; gi++) {
                const row = ground[gi];
                if (Array.isArray(row) && row.length >= 5) visiblePrices.push({ id: row[3] });
            }
        }
    }
    for (let i = 0; i < v.items.length; i++) visiblePrices.push(v.items[i]!);
    for (let i = 0; i < v.log.length; i++) pushList(v.log[i]!.items);
    for (let i = 0; i < v.flow.length; i++) pushList(v.flow[i]!.items);
    const supplyIds = keySupplyIds();
    for (let i = 0; i < supplyIds.length; i++) visiblePrices.push({ id: supplyIds[i]! });
    const lootPriceItems = npcLootPrices();
    for (let i = 0; i < lootPriceItems.length; i++) visiblePrices.push(lootPriceItems[i]!);
    for (const f of flows.values()) {
        if (f.loot) for (const item of f.loot.values()) visiblePrices.push(item);
        if (f.used) for (const item of f.used.values()) visiblePrices.push(item);
    }
    const projectedPrices = projectItemPrices(itemPrices,visiblePrices);
    const economy = {
        goldPerTick: farmers.reduce((n, b) => n + (b.fresh && b.role4.coinsPerTick > 0 ? b.role4.coinsPerTick : 0), 0),
        farmers: farmers.map(b => ({ name: b.name, fresh: b.fresh, ...b.role4 })),
        trend: vaultTrend.map(t => t.value),
        supplies: supplyIds.map(id => ({ id, ...(marketById.get(id) ?? { name: '?', ask: null, bid: null, stock: 0, vwap: null, base: null }) })).filter(x => x.name !== '?'),
        pricesAt,
        itemPricesById: projectedPrices.byId,
        itemPricesByName: projectedPrices.byName,
        // One value per item a fleet account holds, the same value the vault total uses (7-day VWAP after 3 trades,
        // else the shop base price), for the page's item prices and bank value.
        // The game's examine text of each held item (obj configs), for the page's Examine option.
        ...projectItemExamine(itemExamines, examineItems),
        // Also the items of the Loot and Supplies lists (flow.ts), which stay after the fleet holds none of them.
        itemValues: visibleItemValues(visiblePrices, projectedPrices.byName),
        // The Equipment-board set for the Supply ledger's Best in slot tab (S.economy.gearTargets): each slot's accepted item ids and the first one's name.
        gearTargets: GEAR_TARGETS_VIEW,
    };
    const prac = practiceNames();
    const sys = {
        freeGB: freemem() / 2 ** 30, totalGB: totalmem() / 2 ** 30, cpu: getCpuPct(), cores: cpus().length, buildMs: getBuildMs(),
        procs: procs.map(p => ({ ...p, up: now - p.started })),
    };
    const objectives=cached(join(root,'docs/plans/joined-plan.md'),goalPlan,goalPlan(''));
    const currentRace=race(),currentGates=gates();
    const currentScoreboard=cached(FILES.scoreboard,text=>scoreboardView(JSON.parse(text)),scoreboardView(null));
    const goalInputs:GoalInputs={requirements:currentRace?.supplies??null,
        items:cached<any[]>(join(root,'knowledge/items.json'),JSON.parse,[]),
        quests:cached<any[]>(join(root,'knowledge/quests.json'),JSON.parse,[]),
        questConstants:cached(join(root,'vendor/rs-sdk/server/content/scripts/general/configs/quest.constant'),text=>text,''),
        receipts:Object.fromEntries(Object.entries(GOAL_RECEIPTS).map(([key,path])=>[key,cached<any>(join(root,path),JSON.parse,null)]))};
    const progress=goalProgress({now,bots,boards,collection,objectives,race:currentRace,gates:currentGates,scoreboard:currentScoreboard},goalInputs);
    // The quest journals travel as one list and each bot's finished and started ids (quest-pack.ts); the page expands them.
    const packedQuests = packQuests(bots as any[]);
    const brainState = (() => {
        const file = fleetStateFile(root);
        const paused = Boolean(findStopFile('swarm', root));
        if (!existsSync(file)) return coordinationView(null, 0, now, paused);
        try {
            const parsed = cached<any>(file, JSON.parse, null);
            const mtime = statSync(file).mtimeMs;
            const at = typeof parsed?.emittedAt === 'number' && Number.isFinite(parsed.emittedAt) ? parsed.emittedAt : mtime;
            return coordinationView(parsed, at, now, paused);
        } catch {
            return coordinationView(null, 0, now, paused);
        }
    })();
    return {
        now, objectives:{...objectives,progress}, world: { ...world, tick: serverTick() }, worldPlayers: world.players, bots: packedQuests.bots, questList: packedQuests.questList, boards,
        coordination: brainState,
        brain: brainState,
        events: events.slice(0, 160).map(e => ({ ...e, text: shortPhase(e.text), full: e.text, practice: prac.has(e.name) })),
        results: results.slice(0, 120).map(r => ({ ...r, practice: prac.has(r.name),nativeProof:resultProof(r,proofs) })), scripts: scripts(proofs), alerts: alerts(bots, now), requests: requests(), mainPlan: haggisPlan(),
        capacity: capacityState(sw,sys.freeGB,now),
        swarm: sw ? { at: sw.at, freeGB: sw.freeGB, running: sw.running, externalRunning: sw.externalRunning ?? null, pendingStartup: sw.pendingStartup ?? null, pendingReserveGB: sw.pendingReserveGB ?? null, minFreeGB: sw.minFreeGB ?? null, maxBots: sw.maxBots, jobs: sw.jobs.length } : null,
        // An open page reloads itself when index.html changes, so a deploy reaches the owner's tab.
        viewerTimings: viewerTimings.slice(0, 20),
        race: currentRace, gates: currentGates, chain: foodChain(st, now), gapHistory: gapHistory.slice(-120).map(g => ({ at: g.at, gap: g.gap, floorGap: g.floorGap ?? null })), economy,
        pageVersion: (() => {
            let maxMt = 0;
            for (const f of PAGE_VERSION_FILES) {
                try {
                    const mt = statSync(f).mtimeMs;
                    if (mt > maxMt) maxMt = mt;
                } catch { /* missing */ }
            }
            return maxMt;
        })(),
        ...(() => {
            // Other players: the roster, each board's rivals, who stands at our claimed spots.
            const fleet = new Set(bots.map(b => b.name.toLowerCase()));
            const best = new Map(SKILL_BOARDS.map(b => [b, bestOverallByBoard.get(b) ?? null] as const));
            const rivals = rivalsView(boardTops, roster, fleet, best, now);
            const contention = contentionView(fleetList(join(FILES.fleet, 'claims')), roster, fleet, now);
            return { roster: rosterView(roster, now), rivals, contention, farms: farmsView(roster, fleet, contention, now), wilderness: wildernessView(roster, fleet, now), overtake: overtakeView(boardTops, bots as any, cachedXpForLevel) };
        })(),
        prs: getPrRows(),
        scoreboard:currentScoreboard, fleetSides:fleetSides(now, snapshots),
        wildernessOverlay: wildernessOverlayData(),
        diagnostics:fleetDiagnostics(now),
        icons, vault: v, collection, map: { ...MAP, ready: !!getMapBytes() }, sys, snapshotAt: snapshot?.takenAt ?? null, liveTopsAt: Math.max(0, ...[...liveTop.values()].map(t => t.at)), liveTops: liveTop.size,
    };
}

export { buildState };
