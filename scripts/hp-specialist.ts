// Fresh-clock Hitpoints 99 specialist: Witch's House, Tree Gnome Village, Gnome Agility, Grand Tree, and Monkey Madness Option 1.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { finish, openBot } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { isLocalServer } from '../packages/core/src/localserver';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { agilityOptions, runAgility } from './agility-order';
import {
    BURY_KEEP_IDS_HP,
    HP_ANTIPOISON_ACCEPT_IDS,
    HP_SPECIALIST_KIT,
    PROTECT_MELEE_INDEX,
    SPECIALIST_TARGETS,
    activeContinueDialog,
    buryBonesTo43,
    CASTLE_WARS_BANK,
    closeBankClean,
    countAntipoisonDoses,
    countById,
    d8,
    depositIds,
    dismissContinueDialogs,
    equipItemById,
    GRAND_TREE_BANK,
    mazeWalkWaypoints,
    openFreshBank,
    posOf,
    configureSpecialistGuardEnv,
    receiveSupplyKit,
    readServerHost,
    rubRingOfDueling,
    setPrayerState,
    skillInfo,
    startAndExitTutorial,
    teleportTo45Falador,
    trainCourtyardMagicTo25,
    walkWaypoints,
    withdrawExactCount,
    type Point,
    type StopFn,
} from './combat-quest-specialists';
import { runQuestBall } from './generated/quest-ball';
import { runQuestGrandTree } from './generated/quest-grandtree';
import { runQuestMM } from './generated/quest-mm';
import { runQuestTree } from './generated/quest-tree';

const GRAND_TREE_JUNK_IDS = [
    587, 588, 589, 783, 784, 785, 786, 787, 788, 789, 790, 791, 792, 793, 794,
    562, 558, 555, 139, 141, 143, 175, 177, 179, 181, 183, 185, 229, 1985, 2434, 2446, 2448, 385,
];

const ANTIPOISON_BANK_IDS = [2448, 2446, 175] as const;

async function withdrawAntipoisonDoses(s: Session, minDoses: number, maxPots: number, stop: StopFn): Promise<void> {
    let withdrawn = 0;
    while (!stop() && withdrawn < maxPots && countAntipoisonDoses(s.sdk.getInventory()) < minDoses) {
        const bankItems = s.sdk.getState()?.bank?.items ?? [];
        const pick = ANTIPOISON_BANK_IDS
            .map(id => bankItems.find(i => i.id === id && i.count > 0))
            .find(Boolean);
        if (!pick) break;
        const dosePer = pick.id === 175 ? 3 : 4;
        const needed = Math.ceil((minDoses - countAntipoisonDoses(s.sdk.getInventory())) / dosePer);
        const take = Math.min(pick.count, maxPots - withdrawn, Math.max(1, needed));
        await withdrawExactCount(s, pick.id, take, stop, pick.name ?? `Antipoison ${pick.id}`);
        withdrawn += take;
    }
    if (countAntipoisonDoses(s.sdk.getInventory()) < minDoses) {
        throw Error(`missing bank antipoison stock: need ${minDoses} doses, have ${countAntipoisonDoses(s.sdk.getInventory())}`);
    }
}

async function rideSpiritTree(s: Session, treeTile: Point, choices: RegExp[], dest: Point, stop: StopFn): Promise<void> {
    if (d8({ x: posOf(s)?.worldX ?? 0, z: posOf(s)?.worldZ ?? 0 }, treeTile) > 4) {
        await walkWaypoints(s, [{ x: treeTile.x, z: treeTile.z + 2, tol: 2 }], 80, stop, `approach spirit tree ${treeTile.x},${treeTile.z}`);
    }
    const deadline = s.tick() + 80;
    let interactedAt = -10;
    while (!stop()) {
        const p = posOf(s);
        if (p && d8({ x: p.worldX, z: p.worldZ }, dest) <= 8) return;
        if (s.tick() >= deadline) throw Error(`spirit tree travel to ${dest.x},${dest.z} timed out`);
        const d: any = s.sdk.getDialog();
        if (d?.isOpen) {
            if (!d.isWaiting) {
                const opts: any[] = d.options ?? [];
                const pick = opts.find(o => choices.some(re => re.test(o.text ?? '')));
                await s.sdk.sendClickDialog(pick ? pick.index : 0);
            }
        } else if (s.tick() - interactedAt >= 4) {
            const tree = (s.sdk.getState()?.nearbyLocs ?? [])
                .filter((l: any) => /spirit tree/i.test(l.name ?? ''))
                .sort((a: any, b: any) => d8(a, treeTile) - d8(b, treeTile))[0];
            if (!tree) throw Error(`Spirit tree not visible near ${treeTile.x},${treeTile.z}`);
            const op = (tree.optionsWithIndex ?? [])[0];
            interactedAt = s.tick();
            await s.sdk.sendInteractLoc(tree.x, tree.z, tree.id, op?.opIndex ?? 1);
        }
        await waitTicks(s, 1);
    }
}

async function enterGrandTreeSouthDoor(s: Session, stop: StopFn): Promise<void> {
    if ((posOf(s)?.worldZ ?? 0) >= 3493) return;
    await walkWaypoints(s, [{ x: 2465, z: 3490, tol: 1 }], 120, stop, 'to grand tree door');
    const deadline = s.tick() + 30;
    while (!stop() && (posOf(s)?.worldZ ?? 0) < 3493) {
        if (s.tick() >= deadline) throw Error('failed to enter Grand Tree south door');
        const door = (s.sdk.getState()?.nearbyLocs ?? [])
            .filter((l: any) => /tree door/i.test(l.name ?? '') && d8(l, { x: 2465, z: 3492 }) <= 2)
            .sort((a: any, b: any) => d8(a, { x: 2465, z: 3492 }) - d8(b, { x: 2465, z: 3492 }))[0];
        if (door) {
            const op = (door.optionsWithIndex ?? []).find((o: any) => /open/i.test(o.text ?? ''));
            if (op) await s.sdk.sendInteractLoc(door.x, door.z, door.id, op.opIndex);
        }
        await waitUntil(s, () => (posOf(s)?.worldZ ?? 0) >= 3493 || stop(), { timeoutTicks: 6 });
    }
}

async function climbTreeLadder(s: Session, dir: 'up' | 'down', targetLevel: number, stop: StopFn): Promise<void> {
    const deadline = s.tick() + 30;
    const re = dir === 'up' ? /^climb[- ]up/i : /^climb[- ]down/i;
    while (!stop() && (posOf(s)?.level ?? -1) !== targetLevel) {
        if (s.tick() >= deadline) throw Error(`tree ladder ${dir} to level ${targetLevel} timed out`);
        const lad = (s.sdk.getState()?.nearbyLocs ?? [])
            .filter((l: any) => /ladder/i.test(l.name ?? '') && d8(l, { x: 2466, z: 3495 }) <= 3)
            .sort((a: any, b: any) => d8(a, { x: 2466, z: 3495 }) - d8(b, { x: 2466, z: 3495 }))[0];
        if (lad) {
            const op = (lad.optionsWithIndex ?? []).find((o: any) => re.test(o.text ?? '')) ?? lad.optionsWithIndex?.[0];
            if (op) await s.sdk.sendInteractLoc(lad.x, lad.z, lad.id, op.opIndex);
        }
        await waitUntil(s, () => (posOf(s)?.level ?? -1) === targetLevel || stop(), { timeoutTicks: 6 });
    }
}

async function exitGrandTreeRoots(s: Session, stop: StopFn): Promise<void> {
    const deadline = s.tick() + 60;
    while (!stop() && (posOf(s)?.worldZ ?? 0) > 6400) {
        if (s.tick() >= deadline) throw Error('failed to climb Grand Tree root exit ladder');
        const p = posOf(s);
        if (!p || d8({ x: p.worldX, z: p.worldZ }, { x: 2464, z: 9897 }) > 3) {
            await walkWaypoints(s, [{ x: 2464, z: 9897, tol: 1 }], 50, stop, 'roots to exit ladder');
        }
        const ladder = (s.sdk.getState()?.nearbyLocs ?? [])
            .filter((l: any) => /ladder/i.test(l.name ?? '') && (l.optionsWithIndex ?? []).some((o: any) => /climb/i.test(o.text ?? '')))
            .sort((a: any, b: any) => d8(a, { x: 2463, z: 9897 }) - d8(b, { x: 2463, z: 9897 }))[0];
        if (!ladder) throw Error('Grand Tree root exit ladder not found near 2463,9897');
        const op = ladder.optionsWithIndex.find((o: any) => /climb/i.test(o.text ?? ''));
        await s.sdk.sendInteractLoc(ladder.x, ladder.z, ladder.id, op?.opIndex ?? 1);
        await waitUntil(s, () => (posOf(s)?.worldZ ?? 9999) < 6400 || stop(), { timeoutTicks: 8 });
    }
}

async function travelAgilityCourseToGrandTree(s: Session, stop: StopFn): Promise<void> {
    const settleDeadline = s.tick() + 60;
    while (!stop() && (posOf(s)?.level ?? 0) > 0) {
        if (s.tick() >= settleDeadline) throw Error(`failed to descend from Gnome Agility level ${posOf(s)?.level}`);
        await dismissContinueDialogs(s, stop, 1);
        const p = posOf(s);
        if (!p) { await waitTicks(s, 1); continue; }
        if (p.level === 1) {
            const branch = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.id === 2313);
            if (branch) await s.sdk.sendInteractLoc(branch.x, branch.z, branch.id, 1);
            await waitUntil(s, () => (posOf(s)?.level ?? 1) !== 1 || stop(), { timeoutTicks: 10 });
        } else if (p.level === 2 && p.worldX < 2483) {
            const rope = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.id === 2312);
            if (rope) await s.sdk.sendInteractLoc(rope.x, rope.z, rope.id, 1);
            await waitUntil(s, () => (posOf(s)?.worldX ?? 0) >= 2483 || (posOf(s)?.level ?? 2) !== 2 || stop(), { timeoutTicks: 12 });
        } else {
            const treeDown = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.id === 2314);
            if (treeDown) await s.sdk.sendInteractLoc(treeDown.x, treeDown.z, treeDown.id, 1);
            await waitUntil(s, () => (posOf(s)?.level ?? 2) === 0 || stop(), { timeoutTicks: 10 });
        }
    }
    const p0 = posOf(s);
    if (p0 && p0.level === 0 && p0.worldX >= 2482 && p0.worldX <= 2489 && p0.worldZ >= 3426 && p0.worldZ <= 3431) {
        const pipe = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => (l.id === 154 || l.id === 4058) && l.z === 3431);
        if (pipe) {
            await s.sdk.sendInteractLoc(pipe.x, pipe.z, pipe.id, 1);
            await waitUntil(s, () => (posOf(s)?.worldZ ?? 0) >= 3436 || stop(), { timeoutTicks: 12 });
        }
    }
    await enterGrandTreeSouthDoor(s, stop);
}

async function walkToBolren(s: Session, stop: StopFn): Promise<void> {
    await walkWaypoints(s, [{ x: 2451, z: 3151, tol: 2 }], 100, stop, 'castle wars west road');
    await setPrayerState(s, PROTECT_MELEE_INDEX, true, stop);
    await walkWaypoints(
        s,
        [
            { x: 2490, z: 3220, tol: 2 },
            { x: 2502, z: 3191, tol: 1 },
        ],
        180,
        stop,
        'cw road to maze entry',
        { ignoreMeleeHunters: true },
    );
    await setPrayerState(s, PROTECT_MELEE_INDEX, false, stop);
    await mazeWalkWaypoints(
        s,
        [
            { x: 2533, z: 3156, tol: 2 },
            { x: 2515, z: 3160, tol: 0 },
        ],
        240,
        stop,
        'maze entry to loose railing',
    );
    for (let attempt = 0; attempt < 8 && !stop(); attempt++) {
        if ((posOf(s)?.worldZ ?? 0) >= 3161) break;
        await dismissContinueDialogs(s, stop, 1);
        const locs: any[] = s.sdk.getState()?.nearbyLocs ?? [];
        const railing = locs
            .filter(l => (l.id === 2186 || /railing/i.test(l.name ?? '')) && (l.optionsWithIndex ?? []).some((o: any) => /squeeze/i.test(o.text ?? '')))
            .sort((a, b) => d8(a, { x: 2515, z: 3161 }) - d8(b, { x: 2515, z: 3161 }))[0];
        if (!railing) throw Error('loose railing not found at 2515,3161');
        const op = railing.optionsWithIndex.find((o: any) => /squeeze/i.test(o.text ?? ''));
        await s.sdk.sendInteractLoc(railing.x, railing.z, railing.id, op?.opIndex ?? 1);
        await waitUntil(s, () => (posOf(s)?.worldZ ?? 0) >= 3161 || stop(), { timeoutTicks: 8 });
    }
    if ((posOf(s)?.worldZ ?? 0) < 3161) throw Error('failed to squeeze through loose railing');
    await walkWaypoints(
        s,
        [
            { x: 2529, z: 3165, tol: 2 },
            { x: 2542, z: 3169, tol: 1 },
        ],
        120,
        stop,
        'railing to bolren',
    );
}

async function main(): Promise<void> {
    const bot = process.argv[2] ?? '';
    const capArg = process.argv.slice(3).find(a => /^\d+$/.test(a));
    const CAP = Number(capArg ?? process.env.CAP ?? 12000);
    if (!bot) throw Error('usage: hp-specialist.ts <bot> [cap]');
    if (!Number.isSafeInteger(CAP) || CAP < 500 || CAP > 25000) throw Error(`invalid CAP: ${CAP}`);
    const supplierName = (process.env.PRACTICE_SUPPLIER ?? process.env.SUPPLIER ?? '').trim();
    if (!supplierName) throw Error('missing SUPPLIER (or PRACTICE_SUPPLIER) environment variable');

    const root = resolve(import.meta.dir, '..');
    configureSpecialistGuardEnv();
    const s = await openBot(bot);
    const serverHost = readServerHost(root, bot);
    if (!serverHost) {
        await finish([s], false, `missing SERVER in bot.env for ${bot}`);
        return;
    }

    let ended = false;
    void s.ended?.then(() => { ended = true; });
    const t0 = s.tick();
    const elapsed = () => s.tick() - t0;
    const stop: StopFn = () =>
        ended ||
        elapsed() >= CAP ||
        existsSync(join(root, '.practice', `stop-${bot}`)) ||
        (!isLocalServer(serverHost) && existsSync(join(root, '.practice', 'stop-swarm')));
    const milestone = (step: string, extra = '') => {
        console.log(`MILESTONE ${step} tick=${elapsed()}${extra ? ' ' + extra : ''}`);
    };

    try {
        milestone('start');
        await startAndExitTutorial(s, BURY_KEEP_IDS_HP, stop);
        milestone('tutorial');

        await receiveSupplyKit(s, supplierName, HP_SPECIALIST_KIT, stop, {
            altSlots: new Map([[176, {
                allowedIds: HP_ANTIPOISON_ACCEPT_IDS,
                satisfied: items => countAntipoisonDoses(items) >= 8,
            }]]),
        });
        milestone('kit', `slots=${s.sdk.getInventory().length}`);

        await equipItemById(s, 1387, stop, 'Staff of fire');
        await equipItemById(s, 1059, stop, 'Leather gloves');
        await buryBonesTo43(s, stop);
        milestone('prayer43', `prayer=${skillInfo(s, 'Prayer').baseLevel}`);

        await trainCourtyardMagicTo25(s, stop);
        milestone('magic25', `magic=${skillInfo(s, 'Magic').baseLevel}`);

        await rubRingOfDueling(s, /castle wars/i, { x: 2440, z: 3090 }, stop);
        await walkWaypoints(s, [{ x: CASTLE_WARS_BANK.x, z: CASTLE_WARS_BANK.z, tol: 1 }], 40, stop, 'castle wars bank 1');
        await openFreshBank(s, stop);
        await depositIds(s, [1512, 2435, 386, 2358, 1760, ...HP_ANTIPOISON_ACCEPT_IDS], stop);
        await withdrawExactCount(s, 385, 3, stop, 'Shark');
        await withdrawExactCount(s, 2434, 1, stop, 'Prayer potion(4)');
        await closeBankClean(s, stop);

        await teleportTo45Falador(s, stop);
        milestone('falador', `magic=${skillInfo(s, 'Magic').baseLevel} laws=${countById(s.sdk.getInventory(), 563)}`);

        await walkWaypoints(s, [{ x: 2928, z: 3456, tol: 2 }], 100, stop, 'falador to boy');
        await runQuestBall({ session: s, cap: Math.max(200, CAP - elapsed()), stop, food: [385, 379], eatAt: 6, keepAlive: true });
        milestone('witchs_house', `hp=${skillInfo(s, 'Hitpoints').baseLevel} xp=${skillInfo(s, 'Hitpoints').experience}`);

        const wornGloves = s.sdk.getEquipment().find(e => e.id === 1059);
        if (wornGloves) {
            await s.direct({ type: 'unequipItem', slot: wornGloves.slot, reason: 'SDK' });
            await waitUntil(s, () => s.sdk.getInventory().some(i => i.id === 1059) || stop(), { timeoutTicks: 5 });
        }
        const invGloves = s.sdk.getInventory().find(i => i.id === 1059);
        if (invGloves) await s.direct({ type: 'dropItem', slot: invGloves.slot, reason: 'SDK' });

        await rubRingOfDueling(s, /castle wars/i, { x: 2440, z: 3090 }, stop);
        await walkWaypoints(s, [{ x: CASTLE_WARS_BANK.x, z: CASTLE_WARS_BANK.z, tol: 1 }], 40, stop, 'castle wars bank');
        await openFreshBank(s, stop);
        await depositIds(s, [1512, 2435, 386, 2358, 1760, ...HP_ANTIPOISON_ACCEPT_IDS, 2552, 2554, 2556, 2558, 2560, 2562, 2564, 2566, 2409, 2410, 2411, 2407, 1985, 139, 141, 143, 229, 385, 2434], stop);
        await withdrawExactCount(s, 1511, 6, stop, 'Logs');
        await withdrawExactCount(s, 2434, 2, stop, 'Prayer potion(4)');
        await withdrawExactCount(s, 385, 2, stop, 'Shark');
        await closeBankClean(s, stop);
        milestone('castle_wars_bank');

        await walkToBolren(s, stop);
        await runQuestTree({ session: s, cap: Math.max(200, CAP - elapsed()), stop, food: [385, 379], burst: true, keepAlive: true });
        milestone('tree_gnome_village', `hp=${skillInfo(s, 'Hitpoints').baseLevel}`);

        await rideSpiritTree(s, { x: 2542, z: 3169 }, [/where can i go/i, /gnome stronghold/i], { x: 2461, z: 3444 }, stop);
        const agility = await runAgility(s, agilityOptions('gnome', '25', { ...process.env, CAP: String(Math.max(200, CAP - elapsed())) }));
        if (!agility.ok || skillInfo(s, 'Agility').baseLevel < 25) {
            throw Error(`Gnome agility 1->25 incomplete: ${JSON.stringify(agility)}`);
        }
        milestone('agility25', `agility=${skillInfo(s, 'Agility').baseLevel}`);

        await travelAgilityCourseToGrandTree(s, stop);
        await climbTreeLadder(s, 'up', 1, stop);
        await walkWaypoints(s, [{ x: GRAND_TREE_BANK.x, z: GRAND_TREE_BANK.z, tol: 2 }], 40, stop, 'grand tree bank 1');
        await openFreshBank(s, stop);
        await depositIds(s, [139, 141, 143, 229, 587, 588, 589, 1511, 385, 2434], stop);
        await withdrawExactCount(s, 2434, 3, stop, 'Prayer potion(4)');
        await withdrawExactCount(s, 385, 3, stop, 'Shark');
        await closeBankClean(s, stop);
        await walkWaypoints(s, [{ x: 2466, z: 3495, tol: 1 }], 40, stop, 'grand tree bank to ladder 1');
        await climbTreeLadder(s, 'down', 0, stop);

        await runQuestGrandTree({ session: s, cap: Math.max(200, CAP - elapsed()), stop, food: [385, 379], burst: true, keepAlive: true });
        milestone('grand_tree', `magic=${skillInfo(s, 'Magic').baseLevel} hp=${skillInfo(s, 'Hitpoints').baseLevel}`);

        await exitGrandTreeRoots(s, stop);
        await climbTreeLadder(s, 'up', 1, stop);
        await walkWaypoints(s, [{ x: GRAND_TREE_BANK.x, z: GRAND_TREE_BANK.z, tol: 2 }], 40, stop, 'grand tree bank 2');
        await openFreshBank(s, stop);
        await depositIds(s, GRAND_TREE_JUNK_IDS, stop);
        await withdrawExactCount(s, 2357, 1, stop, 'Gold bar');
        await withdrawExactCount(s, 1759, 1, stop, 'Ball of wool');
        await withdrawAntipoisonDoses(s, 8, 3, stop);
        await withdrawExactCount(s, 2434, 8, stop, 'Prayer potion(4)');
        await withdrawExactCount(s, 385, 6, stop);
        await closeBankClean(s, stop);
        await walkWaypoints(s, [{ x: 2466, z: 3495, tol: 1 }], 40, stop, 'grand tree bank to ladder 2');
        await climbTreeLadder(s, 'down', 0, stop);

        await runQuestMM({ session: s, cap: Math.max(200, CAP - elapsed()), stop, daeroOption: 1, keepAlive: true });

        await setPrayerState(s, PROTECT_MELEE_INDEX, false, stop);
        await dismissContinueDialogs(s, stop, 4);
        await s.bot.dismissBlockingUI();

        const hp = skillInfo(s, 'Hitpoints');
        const target = SPECIALIST_TARGETS.hitpoints;
        milestone('complete', `hitpoints=${hp.baseLevel} xp=${hp.experience} targetTicks=${target.targetTicks}`);
        if (hp.baseLevel < 99) throw Error(`Hitpoints finished at ${hp.baseLevel} (< 99), xp=${hp.experience}`);
        await finish([s], true, `hitpoints=${hp.baseLevel} xp=${hp.experience} ticks=${elapsed()} liveTarget=${target.targetTicks}`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

if (import.meta.main) await main();
