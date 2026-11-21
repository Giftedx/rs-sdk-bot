// Recharges uncharged or partially charged Amulets of glory at the Heroes' Guild basement Fountain of Heroes.
// Usage: bun scripts/charge-glory.ts <account> [CAP ticks, default 2000]
// Env: MAX_GLORIES (default 0: recharge all banked Amulets of glory (0..3) up to 28 per trip).
import { existsSync } from 'node:fs';
import { accountOf, finish, openBot, sessionDied } from '../packages/core/src/bot';
import { combatLevel } from '../packages/core/src/danger';
import { depositObserved } from '../packages/core/src/deposit';
import type { Session } from '../packages/core/src/inprocess';
import { waitUntil } from '../packages/core/src/ticks';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import type { Tile } from '../packages/core/src/world';
import { walkTargetPersist } from './walk-to';

export const GLORY_UNCHARGED = [1704, 1706, 1708, 1710] as const;
export const GLORY_4 = 1712, FOUNTAIN_ID = 2638;
export const FALADOR_WEST_BANK: Tile = { x: 2946, z: 3368, level: 0 };
export const HEROES_FOUNTAIN_STAND: Tile = { x: 2916, z: 9893, level: 0 };
export const HEROES_FOUNTAIN_TILE: Tile = { x: 2917, z: 9893, level: 0 };

export function canEnterHeroesBasement(acct: {
    quests?: ReadonlySet<string>;
    varps?: Readonly<Record<string, number>>;
    questStages?: Readonly<Record<string, number>>;
    unlocks?: readonly string[];
    skills: Record<string, number>;
}): { ok: boolean; reason?: string } {
    const heroDone = !!acct.quests?.has("hero's quest") || (acct.varps?.heroquest ?? acct.questStages?.heroquest ?? 0) >= 15 || !!acct.unlocks?.includes('complete:heroquest');
    if (!heroDone) return { ok: false, reason: "Hero's Quest is required for the Fountain of Heroes" };
    const skills = Object.fromEntries(Object.entries(acct.skills).map(([k, v]) => [k.toLowerCase(), v]));
    const cb = combatLevel(skills), hp = skills.hitpoints ?? 10;
    if (cb < 111 && hp < 75) return { ok: false, reason: `Heroes basement safety requires combat >= 111 or Hitpoints >= 75 (observed combat=${cb}, hp=${hp})` };
    return { ok: true };
}

export async function runChargeGlory(
    s: Session,
    opts: { cap?: number; maxGlories?: number; stop?: () => boolean; walk?: (to: Tile) => Promise<{ ok: boolean; reason?: string; detail?: string }> } = {},
) {
    const cap = opts.cap ?? 2000, maxGlories = opts.maxGlories ?? 0;
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('invalid charge-glory tick cap');
    if (!Number.isSafeInteger(maxGlories) || maxGlories < 0) throw Error('invalid MAX_GLORIES');
    const start = s.tick(), st = () => s.sdk.getState(), pos = () => st()?.player, initialLife = pos();
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const stopped = () => ended || !!opts.stop?.() || sessionDied(initialLife, pos()) || existsSync(`.practice/stop-${s.name}`) || s.tick() - start >= cap;
    const inv = () => s.sdk.getInventory();
    const count = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const totalUnchargedInv = () => GLORY_UNCHARGED.reduce((n, id) => n + count(id), 0);
    const bankCount = (id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const totalUnchargedBank = () => GLORY_UNCHARGED.reduce((n, id) => n + bankCount(id), 0);

    if (!await waitUntil(s, () => stopped() || (!!pos() && Array.isArray(st()?.inventory)), { timeoutTicks: 20 }))
        throw Error('charge-glory startup state unavailable');
    const stateQuests = ((st() as { quests?: readonly { name?: string; state?: string }[] } | undefined)?.quests ?? [])
        .filter(q => typeof q.name === 'string' && q.state === 'complete')
        .map(q => q.name!.toLowerCase());
    const acct = accountOf(s);
    const gate = canEnterHeroesBasement({ ...acct, quests: new Set(stateQuests) });
    if (!gate.ok) throw Error(`next acquisition: ${gate.reason}`);

    const openBank = async () => {
        const gen = s.bankObservation?.()?.generation ?? 0;
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => stopped() || (!!st()?.bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen), { timeoutTicks: 15 }))
            throw Error('charge-glory bank observation unavailable');
    };
    const closeBank = async () => {
        await s.bot.closeBank();
        await waitUntil(s, () => stopped() || !st()?.bank.isOpen, { timeoutTicks: 10 });
    };
    const depositAll = async () => {
        for (const id of new Set(inv().map(i => i.id))) {
            const item = inv().find(i => i.id === id);
            if (item) await depositObserved(s, item);
        }
    };
    const withdraw = async (id: number, n: number) => {
        if (n < 1) return;
        const row = st()?.bank.items.find(i => i.id === id), before = count(id), stored = bankCount(id), gen = s.bankObservation?.()?.generation ?? 0;
        if (!row || stored < n) throw Error(`charge-glory withdraw short: item ${id} needs ${n}, bank holds ${stored}`);
        await s.bot.withdrawItem(row, n, { asNote: false });
        if (!await waitUntil(s, () => stopped() || (count(id) === before + n && bankCount(id) === stored - n && (s.bankObservation?.()?.generation ?? 0) > gen), { timeoutTicks: 10 }))
            throw Error(`charge-glory withdraw unobserved for item ${id}`);
    };
    const walkTo = async (to: Tile, label: string) => {
        const res = await walkTargetPersist(s, to, 4, opts.walk);
        if (!res.ok) throw Error(`charge-glory walk to ${label} failed: ${res.reason ?? ''} ${res.detail ?? ''}`);
    };

    await walkTo(FALADOR_WEST_BANK, 'Falador West Bank');
    await openBank();
    await depositAll();
    const totalAvailable = totalUnchargedBank();
    if (totalAvailable < 1) {
        await closeBank();
        throw Error('next acquisition: no uncharged Amulet of glory (1704/1706/1708/1710) in bank');
    }

    const goal = maxGlories > 0 ? Math.min(totalAvailable, maxGlories) : totalAvailable;
    let charged = 0;
    while (charged < goal && !stopped()) {
        let want = Math.min(28, goal - charged);
        for (const id of GLORY_UNCHARGED) {
            if (want <= 0) break;
            const take = Math.min(want, bankCount(id));
            if (take > 0) { await withdraw(id, take); want -= take; }
        }
        if (totalUnchargedInv() < 1) break;
        await closeBank();
        await walkTo(HEROES_FOUNTAIN_STAND, 'Fountain of Heroes');
        if (!opts.walk && (pos()?.worldX !== HEROES_FOUNTAIN_STAND.x || pos()?.worldZ !== HEROES_FOUNTAIN_STAND.z)) {
            await walkPath(await sessionWalker(s), [{ ...HEROES_FOUNTAIN_STAND, tol: 0 }], { maxTicks: 30, stop: stopped });
        }
        const fountain = (st()?.nearbyLocs ?? []).find(l => l.id === FOUNTAIN_ID || /fountain of heroes/i.test(l.name));
        if (!fountain) throw Error('fountain of heroes unobserved');
        while (totalUnchargedInv() > 0 && !stopped()) {
            await s.bot.dismissBlockingUI?.();
            const glory = inv().find(i => (GLORY_UNCHARGED as readonly number[]).includes(i.id));
            if (!glory) break;
            const before4 = count(GLORY_4);
            const res = await s.bot.useItemOnLoc(glory, fountain);
            if (!await waitUntil(s, () => stopped() || count(GLORY_4) > before4, { timeoutTicks: 12 })) {
                const cur = pos();
                const msgs = (st()?.gameMessages ?? []).slice(-4).map((m: { text?: string }) => m.text ?? '').join('|');
                throw Error(`glory recharge at Fountain of Heroes unobserved (res=${JSON.stringify(res)} pos=${cur?.worldX},${cur?.worldZ} loc=${fountain.x},${fountain.z},${fountain.id} msgs=${msgs})`);
            }
            await s.bot.dismissBlockingUI?.();
            charged += Math.max(1, count(GLORY_4) - before4);
        }
        await walkTo(FALADOR_WEST_BANK, 'Falador West Bank');
        await openBank();
        await depositAll();
    }
    const bankGlory4 = bankCount(GLORY_4);
    await closeBank();
    return { ok: charged > 0 && !stopped(), charged, bankGlory4, ticks: s.tick() - start };
}

if (import.meta.main) {
    const argEnv = Object.fromEntries(process.argv.slice(2).flatMap(a => { const m = a.match(/^([A-Z_]+)=(.*)$/); return m ? [[m[1]!, m[2]!]] : []; }));
    const posArgs = process.argv.slice(2).filter(a => !/^[A-Z_]+=/.test(a));
    const account = posArgs[0];
    const cap = Number(posArgs[1] ?? 2000);
    const maxGlories = Number(argEnv.MAX_GLORIES ?? process.env.MAX_GLORIES ?? 0);
    if (!account) throw Error('account argument required');
    let stopped = false;
    const s = await openBot(account, { onStop: async () => { stopped = true; } });
    try {
        const r = await runChargeGlory(s, { cap, maxGlories, stop: () => stopped });
        await finish([s], r.ok, `charged=${r.charged} bankGlory4=${r.bankGlory4} ticks=${r.ticks}`);
    } catch (error) {
        await finish([s], false, String(error));
    }
}
