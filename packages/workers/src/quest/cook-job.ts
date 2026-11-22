// Cook's Assistant & Witch's Potion end-to-end job orchestration using gatherQuestItems + completeCook / completeHetty.
import { openBot, settle } from '../../../core/src/bot';
import { equipmentObserved } from '../../../core/src/container-observation';
import type { Session } from '../../../core/src/inprocess';
import { questFlags } from '../../../core/src/quest-status';
import { holdSessionEater } from '../../../core/src/sustain';
import { waitUntil } from '../../../core/src/ticks';
import { sessionWalker, walkPath, type PathPoint } from '../../../core/src/walk';
import { gatherQuestItems, hettyTravelChecks, type HettyTravelDebit } from './items-order';
import { questSpec } from './order';
import { resolveCompleteCook, resolveCompleteHetty, resolveLeaveRuneStarter } from './runtime';

export const cookJobRuntime = {
    gatherQuestItems,
    leaveRuneStarter: resolveLeaveRuneStarter,
    completeCook: resolveCompleteCook,
    completeHetty: resolveCompleteHetty,
};

type Item = { id: number; count: number };

export interface CookJobSnapshot {
    account: string;
    position: { x: number; z: number; level: number };
    hp: number;
    lifeId: number;
    respawns: number;
    quest: 'unknown' | 'not started' | 'started' | 'complete';
    qp: number;
    cookingXp: number;
    magicXp?: number;
    pack: Item[];
    bank: Item[];
    equipment: (Item & { slot: number })[];
    bankGeneration: number;
}

const sum = (items: readonly Item[], id: number) => items.filter((i) => i.id === id).reduce((n, i) => n + i.count, 0);
const holdings = (s: CookJobSnapshot) => [...s.pack, ...s.bank];
const assets = (s: CookJobSnapshot, id: number) => sum(holdings(s), id);
const ingredients = [1944, 1927, 1933];

export function cookJobChecks(before: CookJobSnapshot, after: CookJobSnapshot) {
    const ids = new Set([...holdings(before), ...holdings(after)].map((i) => i.id));
    const changed = new Set([...ingredients, 1925, 1931, 1947]);
    const equipment = (s: CookJobSnapshot) => JSON.stringify([...s.equipment].sort((a, b) => a.slot - b.slot));
    return {
        entry: before.quest === 'not started' || before.quest === 'started',
        identity: before.account.toLowerCase() === after.account.toLowerCase(),
        quest: after.quest === 'complete',
        questPoints: after.qp === before.qp + 1,
        reward: after.cookingXp - before.cookingXp >= 300 && (after.cookingXp - before.cookingXp) % 300 === 0,
        ingredients: ingredients.every((id) => assets(after, id) === Math.max(0, assets(before, id) - 1)),
        containers: [
            [1927, 1925],
            [1933, 1931],
        ].every(([product, container]) => assets(after, container!) === assets(before, container!) - (assets(before, product!) > 0 ? 0 : 1)),
        grain: assets(after, 1947) >= Math.max(0, assets(before, 1947) - 1) && assets(after, 1947) <= Math.max(1, assets(before, 1947)),
        assets: [...ids].filter((id) => !changed.has(id)).every((id) => assets(before, id) === assets(after, id)),
        equipment: equipment(before) === equipment(after),
        alive: after.hp > 0 && after.lifeId === before.lifeId && after.respawns === before.respawns,
        bank: after.bankGeneration > before.bankGeneration,
    };
}

export function parseCookJobArgs(args: string[], budget = process.env.CAP ?? '2400') {
    const [name, quest] = args;
    const cap = Number(budget);
    if (
        (args.length !== 1 && !(args.length === 2 && quest === 'hetty')) ||
        !name ||
        !/^[A-Za-z0-9]{1,12}$/.test(name) ||
        !Number.isSafeInteger(cap) ||
        cap < 1 ||
        (quest === 'hetty' && cap > 6000)
    ) {
        throw Error('usage: quest-cook-job <account> [hetty]; CAP must be a positive integer (Hetty <=6000)');
    }
    return quest === 'hetty' ? { name, cap, quest: 'hetty' as const } : { name, cap };
}

const flag = (s: Session, key = 'cook') => questFlags(s.client)?.find((q) => q.name === questSpec(key).label)?.state ?? 'unknown';
const equipmentReady = (s: Session) => !!s.client && typeof s.client === 'object' && equipmentObserved(s.client);
const qp = (s: Session) => Number((s.client as any).varServ?.[questSpec('cook').qpVarpId]);

export function observeCookJobSnapshot(s: Session, requireBank = true, key = 'cook'): CookJobSnapshot {
    const state = s.sdk.getState();
    const p = state?.player;
    const b = s.bankObservation?.() ?? (!requireBank ? { items: [], generation: 0 } : null);
    if (
        !p ||
        !b ||
        !Array.isArray(state.inventory) ||
        !Array.isArray(state.equipment) ||
        !equipmentReady(s) ||
        flag(s, key) === 'unknown' ||
        !Number.isSafeInteger(qp(s)) ||
        qp(s) < 0 ||
        s.sdk.getSkillXp('Cooking') === null ||
        (key === 'hetty' && s.sdk.getSkillXp('Magic') === null)
    ) {
        throw Error('Cook snapshot unobserved');
    }
    return {
        account: p.name,
        position: { x: p.worldX, z: p.worldZ, level: p.level },
        hp: p.hp,
        lifeId: p.lifeId,
        respawns: p.respawnCount,
        quest: flag(s, key),
        qp: qp(s),
        cookingXp: s.sdk.getSkillXp('Cooking')!,
        ...(key === 'hetty' ? { magicXp: s.sdk.getSkillXp('Magic')! } : {}),
        pack: state.inventory.map((i) => ({ id: i.id, count: i.count })),
        bank: b.items.map((i) => ({ id: i.id, count: i.count })),
        equipment: state.equipment.map((i) => ({ id: i.id, count: i.count, slot: i.slot })),
        bankGeneration: b.generation,
    };
}

export async function runQuestCookJob(name: string, cap: number) {
    parseCookJobArgs([name], String(cap));
    const completeCook = await cookJobRuntime.completeCook();
    const leaveRuneStarter = await cookJobRuntime.leaveRuneStarter();
    const s = await openBot(name);
    const deadline = s.tick() + cap;
    holdSessionEater(s.sdk);
    let before: CookJobSnapshot | undefined;
    let after: CookJobSnapshot | undefined;
    let gather: Awaited<ReturnType<typeof gatherQuestItems>> | undefined;
    let quest: Awaited<ReturnType<typeof completeCook>> | undefined;
    let checks: ReturnType<typeof cookJobChecks> | undefined;
    let detail = '';
    let workOk = false;
    let ended = false;
    let dead = false;
    let life: number | undefined;
    let respawns: number | undefined;
    void s.ended.then(() => {
        ended = true;
    });
    const off = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        dead ||= !!p && (p.isDead || (life !== undefined && p.lifeId !== life) || (respawns !== undefined && p.respawnCount !== respawns));
    });
    const guard = () => {
        if (ended || dead || s.tick() >= deadline) throw Error('Cook job stopped/deadline/death');
    };
    const wait = async (pred: () => boolean, ticks: number) => {
        guard();
        const ok = await waitUntil(s, () => {
            guard();
            return pred();
        }, { timeoutTicks: Math.max(1, Math.min(ticks, deadline - s.tick())) });
        guard();
        return ok;
    };
    const walk = async (label: string, points: PathPoint[]) => {
        guard();
        const result = await walkPath(await sessionWalker(s), points, { maxTicks: deadline - s.tick(), stop: () => ended || dead || s.tick() >= deadline });
        guard();
        if (!result.ok) throw Error(`${label}: ${result.detail}`);
    };
    const converse = async (patterns: RegExp[], ok: () => boolean, ticks: number) => {
        const end = Math.min(deadline, s.tick() + ticks);
        while (s.tick() < end) {
            guard();
            if (ok()) return true;
            const d = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const options = d.options ?? [];
                const choice = options.find((o) => patterns.some((re) => re.test(o.text)));
                if (options.some((o) => !/click here to continue/i.test(o.text)) && !choice) throw Error('Cook dialogue option unknown');
                const result = choice
                    ? await s.sdk.clickDialogByText(new RegExp('^' + choice.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'))
                    : await s.sdk.sendClickDialog(0);
                if (!result.success) throw Error('Cook dialogue click refused');
            }
            const tick = s.tick();
            await wait(() => s.tick() > tick, 1);
        }
        return ok();
    };
    try {
        await leaveRuneStarter(s, () => ended || dead || s.tick() >= deadline);
        guard();
        if (
            !(await wait(() => {
                const st = s.sdk.getState();
                const p = st?.player;
                return (
                    !!p &&
                    flag(s) !== 'unknown' &&
                    Array.isArray(st?.inventory) &&
                    Array.isArray(st?.equipment) &&
                    equipmentReady(s) &&
                    Number.isSafeInteger(qp(s)) &&
                    s.sdk.getSkillXp('Cooking') !== null
                );
            }, 20))
        ) {
            throw Error('Cook entry unobserved within deadline');
        }
        const p = s.sdk.getState()!.player!;
        life = p.lifeId;
        respawns = p.respawnCount;
        if (p.name.toLowerCase() !== name.toLowerCase()) throw Error('Cook account identity mismatch');
        if (p.hp < 10 || p.isDead) throw Error('Cook entry needs at least 10 HP');
        if (flag(s) === 'complete') throw Error('quest already complete');
        const entry = observeCookJobSnapshot(s, false);
        console.log('QUEST_COOK_JOB_OBSERVED_ENTRY ' + JSON.stringify(entry));
        const held = (id: number) => sum(entry.pack, id) > 0;
        const fromPack = entry.position.x > 3150 && (held(1927) || held(1925)) && (held(1933) || held(1931)) && entry.pack.length <= 26;
        gather = await cookJobRuntime.gatherQuestItems(s, 'cook', null, deadline - s.tick(), {
            fromPack,
            stop: () => ended || dead,
            onBank: (bank) => {
                before = { ...entry, bank: bank.items.map((i) => ({ id: i.id, count: i.count })), bankGeneration: bank.generation };
                for (const [product, container] of [
                    [1927, 1925],
                    [1933, 1931],
                ]) {
                    if (!assets(before, product!) && !assets(before, container!)) throw Error(`missing container ${container}`);
                }
                console.log('QUEST_COOK_JOB_ENTRY ' + JSON.stringify(before));
            },
        });
        if (!gather.ok || (!fromPack && !before)) throw Error('Cook gather did not complete');
        const pos = () => s.sdk.getState()!.player!;
        quest = await completeCook({
            pos,
            lvl: () => pos().level,
            near: (x: number, z: number, r: number) => Math.max(Math.abs(pos().worldX - x), Math.abs(pos().worldZ - z)) <= r,
            cnt: (id: number) => sum(s.sdk.getState()?.inventory ?? [], id),
            questState: () => flag(s),
            packReady: () => Array.isArray(s.sdk.getState()?.inventory),
            waitUntil: wait,
            walk,
            dialogOpen: () => !!s.sdk.getDialog()?.isOpen,
            converse,
            milestone: (step: string) => console.log(`MILESTONE cook-${step} ${s.tick()}`),
            openDoor: async (_label: string, x: number, z: number) => {
                guard();
                const door = s.sdk.getState()?.nearbyLocs.find((l) => l.x === x && l.z === z && l.optionsWithIndex?.some((o) => /^open$/i.test(o.text)));
                if (door) {
                    const result = await s.bot.openDoor(door);
                    if (!result.success) throw Error('Cook door refused');
                }
                guard();
            },
            talk: async (label: string, re: RegExp, patterns: RegExp[], ok: () => boolean, _home: any, ticks = 60, stopOpen = false) => {
                for (let attempt = 0; attempt < 2; attempt++) {
                    guard();
                    if (ok() && (stopOpen || !s.sdk.getDialog()?.isOpen)) return;
                    if (!s.sdk.getDialog()?.isOpen) {
                        const result = await s.bot.talkTo(re);
                        if (!result.success) throw Error(`${label}: dialogue refused`);
                    }
                    if (await converse(patterns, () => ok() && (stopOpen || !s.sdk.getDialog()?.isOpen), ticks)) return;
                }
                throw Error(`${label}: effect unobserved`);
            },
        });
        await walk('Cook retained stock', [
            { x: 3207, z: 3216, tol: 0 },
            { x: 3207, z: 3218, tol: 0 },
            { x: 3217, z: 3220, tol: 1 },
            ...questSpec('cook').bank,
        ]);
        const generation = s.bankObservation?.()?.generation ?? 0;
        if (!(await s.bot.openBank()).success || !(await wait(() => (s.bankObservation?.()?.generation ?? 0) > generation, 12))) {
            throw Error('Cook final bank unobserved');
        }
        after = observeCookJobSnapshot(s);
        if (!before) {
            before = { ...entry, bank: [], bankGeneration: -1 };
            checks = cookJobChecks(before, { ...after, bank: [] });
        } else {
            checks = cookJobChecks(before, after);
        }
        if (!(await s.bot.closeBank()).success) throw Error('Cook final bank close refused');
        guard();
        if (!Object.values(checks).every(Boolean)) throw Error('Cook final checks failed');
        detail = 'Cook complete; observed QP, Cooking XP, input costs and retained assets';
        workOk = true;
    } catch (error) {
        detail = String(error);
    } finally {
        off();
    }
    let logout = false;
    const settled = await settle([s], workOk, detail, {
        log: (line) => {
            console.log(line);
            if (line === 'LOGOUT logged-out') logout = true;
        },
    });
    return {
        ok: Boolean(workOk && settled && logout && gather?.ok === true && quest?.ok === true && !!checks && Object.values(checks).every(Boolean)),
        account: name,
        gather,
        quest,
        checks,
        before,
        after,
        logout,
        detail,
        ticks: cap - (deadline - s.tick()),
    };
}

// Pinned prices: Betty eye=3, Wydin beef=1. Only missing inputs may be bought.
export function hettyJobChecks(
    before: CookJobSnapshot,
    after: CookJobSnapshot,
    purchases: { id: number; coins: number }[],
    travel: HettyTravelDebit[] = [],
) {
    const ids = new Set([...holdings(before), ...holdings(after)].map((i) => i.id));
    const owned = (id: number) => assets(before, id);
    const left = (id: number) => assets(after, id);
    const eye = owned(221) ? 0 : 1;
    const meat = [2146, 2142, 2132].every((id) => !owned(id)) ? 1 : 0;
    const selected = owned(2146) ? 2146 : owned(2142) ? 2142 : owned(2132) ? 2132 : 0;
    const debit = purchases.reduce((n, p) => n + p.coins, 0);
    const equipment = (s: CookJobSnapshot) => JSON.stringify([...s.equipment].sort((a, b) => a.slot - b.slot));
    return {
        entry: before.quest === 'not started' || before.quest === 'started',
        identity: before.account.toLowerCase() === after.account.toLowerCase(),
        quest: after.quest === 'complete',
        questPoints: after.qp === before.qp + 1,
        reward: after.magicXp !== undefined && before.magicXp !== undefined && after.magicXp - before.magicXp === 8125,
        purchases:
            purchases.length === eye + meat &&
            purchases.filter((p) => p.id === 221 && p.coins === 3).length === eye &&
            purchases.filter((p) => p.id === 2132 && p.coins === 1).length === meat,
        travel: hettyTravelChecks(travel) && debit <= 4 && travel.reduce((n, d) => n + d.coins, 0) + debit <= 64,
        coins: left(995) === owned(995) - debit - travel.reduce((n, d) => n + d.coins, 0),
        ingredients:
            [1957, 221, 300].every((id) => left(id) === Math.max(0, owned(id) - 1)) &&
            [2146, 2142, 2132].every((id) => left(id) === owned(id) - (selected === id ? 1 : 0)),
        assets: [...ids].filter((id) => ![995, 1957, 221, 300, 2146, 2142, 2132].includes(id)).every((id) => owned(id) === left(id)),
        equipment: equipment(before) === equipment(after),
        alive: after.hp > 0 && after.lifeId === before.lifeId && after.respawns === before.respawns,
        bank: after.bankGeneration > before.bankGeneration,
    };
}

export async function runQuestHettyJob(name: string, cap: number) {
    parseCookJobArgs([name, 'hetty'], String(cap));
    const completeHetty = await cookJobRuntime.completeHetty();
    const leaveRuneStarter = await cookJobRuntime.leaveRuneStarter();
    const s = await openBot(name);
    const deadline = s.tick() + cap;
    holdSessionEater(s.sdk);
    const workDeadline = deadline - Math.min(64, cap - 1);
    let before: CookJobSnapshot | undefined;
    let after: CookJobSnapshot | undefined;
    let gather: Awaited<ReturnType<typeof gatherQuestItems>> | undefined;
    let quest: Awaited<ReturnType<typeof completeHetty>> | undefined;
    let checks: ReturnType<typeof hettyJobChecks> | undefined;
    let detail = '';
    let workOk = false;
    let ended = false;
    let life: number | undefined;
    let respawns: number | undefined;
    void s.ended.then(() => {
        ended = true;
    });
    const unsafe = () => {
        const p = s.sdk.getState()?.player;
        return ended || (!!p && (p.isDead || (life !== undefined && p.lifeId !== life) || (respawns !== undefined && p.respawnCount !== respawns)));
    };
    const stopped = () => unsafe() || s.tick() >= workDeadline;
    const guard = () => {
        if (stopped()) throw Error('Hetty job stopped/deadline/death');
    };
    const observe = async (pred: () => boolean, ticks: number) => {
        guard();
        const reached = await waitUntil(s, () => {
            guard();
            return pred();
        }, { timeoutTicks: Math.max(1, Math.min(ticks, workDeadline - s.tick())) });
        guard();
        if (!reached) throw Error('Hetty effect unobserved');
    };
    try {
        await observe(() => !!s.sdk.getState()?.player, 20);
        const start = s.sdk.getState()!.player!;
        life = start.lifeId;
        respawns = start.respawnCount;
        if (start.name.toLowerCase() !== name.toLowerCase()) throw Error('Hetty identity mismatch');
        await leaveRuneStarter(s, stopped);
        guard();
        await observe(() => {
            try {
                observeCookJobSnapshot(s, false, 'hetty');
                return true;
            } catch {
                return false;
            }
        }, 20);
        const entry = observeCookJobSnapshot(s, false, 'hetty');
        life = entry.lifeId;
        respawns = entry.respawns;
        if (entry.account.toLowerCase() !== name.toLowerCase()) throw Error('Hetty identity mismatch');
        if (entry.hp < 10) throw Error('Hetty entry needs at least 10 HP');
        if (entry.quest === 'complete') throw Error('quest already complete');
        console.log('QUEST_HETTY_OBSERVED_ENTRY ' + JSON.stringify(entry));
        gather = await cookJobRuntime.gatherQuestItems(s, 'hetty', null, workDeadline - s.tick(), {
            stop: stopped,
            onBank: (bank) => {
                before = { ...entry, bank: bank.items.map((i) => ({ id: i.id, count: i.count })), bankGeneration: bank.generation };
                console.log('QUEST_HETTY_ENTRY ' + JSON.stringify(before));
            },
        });
        guard();
        if (!gather.ok || !before) throw Error('Hetty gather incomplete');
        const walk = await walkPath(
            await sessionWalker(s),
            [
                { x: 2965, z: 3210, tol: 1 },
                { x: 2968, z: 3206, tol: 1 },
            ],
            { maxTicks: workDeadline - s.tick(), stop: stopped },
        );
        guard();
        if (!walk.ok) throw Error('Hetty approach: ' + walk.detail);
        quest = await completeHetty(s, workDeadline - s.tick(), stopped);
        guard();
        const back = await walkPath(
            await sessionWalker(s),
            [
                { x: 2965, z: 3210, tol: 1 },
                { x: 3000, z: 3266, tol: 2 },
                { x: 3050, z: 3266, tol: 2 },
                { x: 3089, z: 3266, tol: 1 },
                { x: 3092, z: 3250, tol: 1 },
                { x: 3092, z: 3243, tol: 1 },
            ],
            { maxTicks: workDeadline - s.tick(), stop: stopped },
        );
        guard();
        if (!back.ok) throw Error('Hetty retained stock: ' + back.detail);
        const generation = s.bankObservation?.()?.generation ?? 0;
        if (!(await s.bot.openBank()).success) throw Error('Hetty final bank refused');
        await observe(() => (s.bankObservation?.()?.generation ?? 0) > generation, 12);
        after = observeCookJobSnapshot(s, true, 'hetty');
        checks = hettyJobChecks(before, after, gather.purchases ?? [], gather.travel ?? []);
        if (!(await s.bot.closeBank()).success) throw Error('Hetty final bank close refused');
        guard();
        if (!Object.values(checks).every(Boolean)) throw Error('Hetty final checks failed');
        workOk = true;
        detail = 'Hetty complete; QP+1, Magic+8125, costs, assets and life observed';
    } catch (error) {
        detail = String(error);
        const p = s.sdk.getState()?.player;
        if (!unsafe() && p?.combat?.inCombat && p.level === 0 && p.worldX >= 2953 && p.worldX <= 2960 && p.worldZ >= 3201 && p.worldZ <= 3206) {
            try {
                const retreat = await walkPath(
                    await sessionWalker(s),
                    [
                        { x: 2956, z: 3206, tol: 0 },
                        { x: 2956, z: 3214, tol: 1 },
                    ],
                    { maxTicks: Math.max(1, Math.min(32, deadline - s.tick())), stop: () => unsafe() || s.tick() >= deadline },
                );
                if (!retreat.ok) throw Error('retreat: ' + retreat.detail);
                const quiet = await waitUntil(s, () => unsafe() || s.sdk.getState()?.player?.combat?.inCombat === false, {
                    timeoutTicks: Math.max(1, Math.min(32, deadline - s.tick())),
                });
                if (!quiet || unsafe()) throw Error('combat exit unobserved');
            } catch (recovery) {
                detail += '; Hetty recovery: ' + String(recovery);
            }
        }
    }
    let logout = false;
    const settled = await settle([s], workOk, detail, {
        log: (line) => {
            console.log(line);
            if (line === 'LOGOUT logged-out') logout = true;
            if (/^WARN .*?(?:logout|session close)/.test(line)) logout = false;
        },
    });
    return {
        ok: !!(workOk && settled && logout && gather?.ok && quest?.ok),
        account: name,
        questKey: 'hetty',
        gather,
        quest,
        checks,
        before,
        after,
        logout,
        detail,
        ticks: cap - (deadline - s.tick()),
    };
}
