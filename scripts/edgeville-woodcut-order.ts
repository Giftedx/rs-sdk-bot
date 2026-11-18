import { existsSync } from 'node:fs';
import { openBot, settle } from '../packages/core/src/bot';
import { depositObserved } from '../packages/core/src/deposit';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import {
    WOODCUTTING_AXES_DESC,
    bestWoodcuttingAxe,
    crossedTierBoundary,
    readSkillLevels,
    reconcileBankTool,
    sessionToolHooks,
} from '../packages/planner/src/gear-progression';

type Session = Awaited<ReturnType<typeof openBot>>;
const BANK = { x: 3094, z: 3492, tol: 1 };
const GROVE = { x: 3125, z: 3434, tol: 2 };
const APPROACH = [{ x: 3082, z: 3490, tol: 1 }, { x: 3080, z: 3470, tol: 1 }, { x: 3101, z: 3421, tol: 3 }];
const OAKS = new Set(['3120,3428', '3126,3437', '3131,3432']);
const OAK_LOGS = 1521, TARGET = 36, CAP = 900;
const AXE_IDS: readonly number[] = WOODCUTTING_AXES_DESC;

const count = (items: readonly { id: number; count: number }[], id: number) =>
    items.reduce((total, item) => total + (item.id === id ? item.count : 0), 0);
const countAxes = (items: readonly { id: number; count: number }[]) =>
    items.reduce((total, item) => total + (AXE_IDS.includes(item.id) ? item.count : 0), 0);
function check(value: unknown, detail: string): asserts value {
    if (!value) throw Error(detail);
}

export function selectEdgevilleWoodcutAxe(
    stock: readonly { id: number; count: number }[],
    levels: ReturnType<typeof readSkillLevels>,
) {
    return bestWoodcuttingAxe(stock, levels);
}

export async function runEdgevilleWoodcut(s: Session, stopped: () => boolean) {
    const start = s.tick();
    const pos = () => s.sdk.getState()?.player;
    const level = () => s.sdk.getSkill('Woodcutting')?.baseLevel ?? 0;
    const xp = () => s.sdk.getSkillXp('Woodcutting') ?? 0;
    const pack = () => s.sdk.getInventory();
    const eq = () => s.sdk.getEquipment();
    const held = (id: number) => count(pack(), id);
    const activeAxes = () => countAxes(pack()) + countAxes(eq().filter(e => e.slot === 3));
    const atBank = () => {
        const p = pos();
        return Boolean(p?.level === 0 && Math.max(Math.abs(p.worldX - BANK.x), Math.abs(p.worldZ - BANK.z)) <= 3);
    };
    const from = level(), initialXp = xp(), initialHp = pos()?.hp ?? 0;
    let hpMin = initialHp, gathered = 0, banked = 0, failure: string | undefined;
    const refusedWields = new Set<number>();
    let toolLevels = readSkillLevels(s.sdk);
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
            activeAxes() === 0 && held(OAK_LOGS) === 0 && pack().length <= 14, 'Woodcutting entry changed');
        const openingBank = await openBank();
        const originalAxes = countAxes(openingBank), originalLogs = count(openingBank, OAK_LOGS);
        const activateBestOwnedAxe = async (bankRows: readonly { id: number; count: number }[]) => {
            const levelsNow = readSkillLevels(s.sdk);
            const rec = selectEdgevilleWoodcutAxe([...bankRows, ...pack(), ...eq().filter(e => e.slot === 3)], levelsNow).current;
            check(rec, 'No owned woodcutting axe in Edgeville bank');
            await reconcileBankTool(sessionToolHooks(s, {
                openBank,
                waitUntil: (pred, timeoutTicks) => waitUntil(s, pred, { timeoutTicks }),
                stop: () => !safe(),
            }), {
                targetId: rec.item.id,
                canWield: rec.canWield,
                toolGroupIds: AXE_IDS,
                refusedWields,
            });
            toolLevels = levelsNow;
        };
        await activateBestOwnedAxe(openingBank);
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
                    const nowLevels = readSkillLevels(s.sdk);
                    if (crossedTierBoundary(toolLevels, nowLevels, ['attack', 'woodcutting'])) {
                        break;
                    }
                } else await waitTicks(s, 4);
                if (s.tick() - lastGain >= 180) { stalled = true; break; }
            }
            await s.bot.dismissBlockingUI();
            await walk(true);
            let currentBank = await openBank();
            const product = pack().find(item => item.id === OAK_LOGS);
            if (product) {
                const quantity = held(OAK_LOGS);
                const deposited = await depositObserved(s, product);
                check(deposited === quantity, 'Oak log deposit unconfirmed');
                banked += deposited;
                currentBank = s.bankObservation?.()?.items ?? currentBank;
            }
            if (level() >= TARGET || stalled) {
                const wornAxe = eq().find(item => item.slot === 3 && AXE_IDS.includes(item.id));
                if (wornAxe) {
                    await s.bot.closeBank();
                    check((await s.bot.unequipItem(wornAxe)).success &&
                        await waitUntil(s, () => !eq().some(e => e.slot === 3 && e.id === wornAxe.id), { timeoutTicks: 8 }),
                        'Worn axe unequip unconfirmed');
                    currentBank = await openBank();
                }
                for (const axe of [...pack()].filter(item => AXE_IDS.includes(item.id))) {
                    check(await depositObserved(s, axe) === axe.count, 'Axe deposit unconfirmed');
                }
            } else {
                await activateBestOwnedAxe(currentBank);
            }
            const saved = s.bankObservation?.()?.items ?? [];
            check(count(saved, OAK_LOGS) === originalLogs + banked &&
                countAxes(saved) + activeAxes() === originalAxes, 'Woodcutting bank totals differ');
            await s.bot.closeBank();
        }
        check(level() >= TARGET && xp() > initialXp && banked === gathered && banked > 0 &&
            activeAxes() === 0 && held(OAK_LOGS) === 0 && atBank(), 'Woodcutting target incomplete');
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
