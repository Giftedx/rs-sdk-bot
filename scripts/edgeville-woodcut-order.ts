import { existsSync } from 'node:fs';
import { openBot, settle } from '../packages/core/src/bot';
import { depositObserved } from '../packages/core/src/deposit';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { sessionWalker, walkPath } from '../packages/core/src/walk';

type Session = Awaited<ReturnType<typeof openBot>>;
const BANK = { x: 3094, z: 3492, tol: 1 };
const GROVE = { x: 3125, z: 3434, tol: 2 };
const APPROACH = [{ x: 3082, z: 3490, tol: 1 }, { x: 3080, z: 3470, tol: 1 }, { x: 3101, z: 3421, tol: 3 }];
const OAKS = new Set(['3120,3428', '3126,3437', '3131,3432']);
const AXE = 1351, OAK_LOGS = 1521, TARGET = 36, CAP = 900;

const count = (items: readonly { id: number; count: number }[], id: number) =>
    items.reduce((total, item) => total + (item.id === id ? item.count : 0), 0);
function check(value: unknown, detail: string): asserts value {
    if (!value) throw Error(detail);
}

export async function runEdgevilleWoodcut(s: Session, stopped: () => boolean) {
    const start = s.tick();
    const pos = () => s.sdk.getState()?.player;
    const level = () => s.sdk.getSkill('Woodcutting')?.baseLevel ?? 0;
    const xp = () => s.sdk.getSkillXp('Woodcutting') ?? 0;
    const pack = () => s.sdk.getInventory();
    const held = (id: number) => count(pack(), id);
    const atBank = () => {
        const p = pos();
        return Boolean(p?.level === 0 && Math.max(Math.abs(p.worldX - BANK.x), Math.abs(p.worldZ - BANK.z)) <= 3);
    };
    const from = level(), initialXp = xp(), initialHp = pos()?.hp ?? 0;
    let hpMin = initialHp, gathered = 0, banked = 0, failure: string | undefined;
    const off = s.onTick(() => { hpMin = Math.min(hpMin, pos()?.hp ?? 0); });
    const safe = () => {
        const p = pos();
        return !stopped() && p?.level === 0 && p.worldZ >= 3405 && p.worldZ < 3520 &&
            p.worldX >= 3050 && p.worldX <= 3140 && !p.isDead && hpMin >= initialHp && s.tick() - start < CAP;
    };
    const walk = async (returning: boolean) => {
        const points = returning ? [...APPROACH].reverse().concat(BANK) : [...APPROACH, GROVE];
        const result = await walkPath(await sessionWalker(s), points, {
            maxTicks: 165, idleMs: 8_000, stop: () => !safe(),
        });
        check(result.ok && safe(), 'Edgeville route failed: ' + result.detail);
    };
    const openBank = async () => {
        const generation = s.bankObservation?.()?.generation ?? 0;
        check(safe() && atBank() && (await s.bot.openBank()).success &&
            await waitUntil(s, () => (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 12 }),
            'Fresh Edgeville bank unavailable');
        const bank = s.bankObservation?.();
        check(bank, 'Edgeville bank observation unavailable');
        return bank.items;
    };
    try {
        check(atBank() && safe() && initialHp > 0 && from >= 15 && from < TARGET &&
            held(AXE) === 0 && held(OAK_LOGS) === 0 && pack().length <= 14, 'Woodcutting entry changed');
        const openingBank = await openBank();
        const originalAxes = count(openingBank, AXE), originalLogs = count(openingBank, OAK_LOGS);
        const tool = s.sdk.getBankItems().find(item => item.id === AXE);
        check(tool && (await s.bot.withdrawItem(tool, 1, { asNote: false })).success &&
            await waitUntil(s, () => held(AXE) === 1 && count(s.bankObservation?.()?.items ?? [], AXE) === originalAxes - 1,
                { timeoutTicks: 10 }), 'Owned axe withdrawal unconfirmed');
        await s.bot.closeBank();
        let stalled = false;
        while (safe() && level() < TARGET && !stalled) {
            await walk(false);
            let lastGain = s.tick(), previous = '';
            while (safe() && level() < TARGET && pack().length < 27) {
                await s.bot.dismissBlockingUI();
                const standing = (s.sdk.getState()?.nearbyLocs ?? []).filter(loc =>
                    loc.id === 1281 && OAKS.has(loc.x + ',' + loc.z) && loc.reachable !== false)
                    .sort((a, b) => a.distance - b.distance);
                const tree = standing.find(loc => loc.x + ',' + loc.z !== previous) ?? standing[0];
                const action = tree?.optionsWithIndex.find(op => /^chop/i.test(op.text));
                if (tree && action) {
                    const before = held(OAK_LOGS);
                    previous = tree.x + ',' + tree.z;
                    await s.bot.interactLoc(tree, action.text);
                    await waitUntil(s, () => held(OAK_LOGS) > before || !safe(), { timeoutTicks: 28 });
                    const gain = held(OAK_LOGS) - before;
                    if (gain > 0) {
                        gathered += gain;
                        lastGain = s.tick();
                    }
                } else await waitTicks(s, 4);
                if (s.tick() - lastGain >= 180) { stalled = true; break; }
            }
            await s.bot.dismissBlockingUI();
            await walk(true);
            await openBank();
            const product = pack().find(item => item.id === OAK_LOGS);
            if (product) {
                const quantity = held(OAK_LOGS);
                const deposited = await depositObserved(s, product);
                check(deposited === quantity, 'Oak log deposit unconfirmed');
                banked += deposited;
            }
            if (level() >= TARGET || stalled) {
                const axe = pack().find(item => item.id === AXE);
                check(axe && await depositObserved(s, axe) === 1, 'Axe deposit unconfirmed');
            }
            const saved = s.bankObservation()?.items ?? [];
            check(count(saved, OAK_LOGS) === originalLogs + banked &&
                count(saved, AXE) + held(AXE) === originalAxes, 'Woodcutting bank totals differ');
            await s.bot.closeBank();
        }
        check(level() >= TARGET && xp() > initialXp && banked === gathered && banked > 0 &&
            held(AXE) === 0 && held(OAK_LOGS) === 0 && atBank(), 'Woodcutting target incomplete');
    } catch (error) {
        failure = String(error);
    } finally {
        off();
    }
    return { ok: !failure, failure, from, level: level(), xp: xp() - initialXp, gathered, banked,
        hpMin, ticks: s.tick() - start, atBank: atBank() };
}

if (import.meta.main) {
    const name = process.argv[2] ?? '';
    check(/^[a-z0-9]{1,12}$/i.test(name) && process.argv.length === 3, 'Usage: edgeville-woodcut-order.ts <account>');
    const stopped = () => existsSync('.practice/stop-all') || existsSync('.practice/stop-' + name);
    let session: Session | undefined, failure: string | undefined;
    try {
        check(!stopped(), 'Woodcutting stopped before login');
        const end = async (_: Session, reason: string) => { failure = reason; };
        session = await openBot(name, { onStop: end, onSessionEnd: end });
        const result = await runEdgevilleWoodcut(session, () => Boolean(failure) || stopped());
        if (!result.ok) failure ??= result.failure ?? 'Woodcutting target incomplete';
        console.log('EDGEVILLE_WOODCUT ' + JSON.stringify(result));
    } catch (error) {
        failure = String(error);
    }
    const saved = session ? await settle([session], !failure, failure ?? 'Edgeville Woodcutting 36') : false;
    if (!saved || failure) process.exitCode = 1;
}
