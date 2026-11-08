import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openBot, serverFromEnv, settle } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { expandPath, sessionWalker, walkPath } from '../packages/core/src/walk';
import { rangedEntry, runRangedTrain } from './ranged-train';

function check(value: unknown, message: string): asserts value {
    if (!value) throw Error(message);
}

const bank = { x: 3253, z: 3421, tol: 2 };
const route = [[3226,3250],[3226,3262],[3232,3285],[3239,3306],[3260,3335],[3275,3380],[3280,3429]]
    .map(([x,z]) => ({ x: x!, z: z!, tol: 2 })).concat(bank);

export function freshRangedStart(
    player: { worldX: number; worldZ: number; level: number } | null | undefined,
    ranged: number,
    xp: number,
): boolean {
    return !!player && player.level === 0 && player.worldX >= 3070 && player.worldX < 3160
        && player.worldZ >= 3050 && player.worldZ < 3130 && ranged === 1 && xp === 0;
}

export async function runRangedStarter(session: Session, stopRequested: () => boolean): Promise<boolean> {
    const player = () => session.sdk.getState()?.player;
    const hp = () => session.sdk.getSkill('Hitpoints')?.level ?? 0;
    const ranged = () => session.sdk.getSkill('Ranged')?.baseLevel ?? 0;
    const xp = () => session.sdk.getSkillXp('Ranged') ?? -1;
    const start = session.tick();
    const life = player()?.lifeId;
    const stopped = () => stopRequested() || hp() < 6 || player()?.isDead === true || player()?.lifeId !== life;
    let ok = false;
    try {
        const tutorial = player();
        check(freshRangedStart(tutorial, ranged(), xp()), 'fresh tutorial start required');
        let mainland = false;
        for (let i = 0; i < 3 && !mainland; i++) {
            check(!stopped(), 'stopped before tutorial skip');
            check((await session.bot.skipTutorial()).success, 'tutorial skip failed');
            mainland = await waitUntil(session, () => {
                const p = player();
                return p?.level === 0 && Math.abs(p.worldX-3222) <= 3 && Math.abs(p.worldZ-3222) <= 6;
            }, { timeoutTicks: 30 });
        }
        const p = player();
        const starter = session.sdk.getInventory().map(({ id, count }) => ({ id, count }));
        check(mainland && p && ranged() === 1 && xp() === 0 && hp() === 10 &&
            starter.some(i => i.id === 841 && i.count === 1) && starter.some(i => i.id === 882 && i.count === 25),
            'fresh Lumbridge and tutorial bow/ammunition required');
        console.log('LUMBRIDGE ' + JSON.stringify({ x:p.worldX, z:p.worldZ, hp:hp(), ranged:ranged(), xp:xp(), starter }));
        const coins = () => session.sdk.getInventory().filter(i => i.id === 995).reduce((n,i) => n+i.count,0);
        const thieving = () => session.sdk.getSkillXp('Thieving') ?? -1;
        const beforeXp = thieving();
        const earnStart = session.tick();
        // Wydin's conservative ceiling is 24 GP per cheese. Add 27 GP to the 25 GP tutorial bank.
        while (coins() < 27 && session.tick() - earnStart < 900) {
            check(!stopped(), 'stopped during starter coin earning');
            if (hp() <= 7) {
                check(await waitUntil(session, () => hp() >= 9 || stopped(), { timeoutTicks: 320 }),
                    'starter HP recovery timed out');
                continue;
            }
            const man = session.sdk.getState()?.nearbyNpcs.filter(n => /^man$/i.test(n.name) &&
                n.x >= 3210 && n.x <= 3234 && n.z >= 3205 && n.z <= 3235 && n.reachable !== false)
                .sort((a,b) => a.distance-b.distance)[0];
            check(man, 'Lumbridge man unavailable');
            const hpBefore = hp();
            await session.bot.pickpocketNpc(man);
            await waitTicks(session, hp() < hpBefore ? 8 : 2);
        }
        const here = player();
        check(here, 'starter coin earning position unavailable');
        await session.sdk.sendWalk(here.worldX,here.worldZ);
        await waitTicks(session,4);
        check(coins() >= 27 && coins()*200 === (thieving()-beforeXp)*3 && !stopped(), 'starter coins failed reconciliation');
        console.log('STARTER_COINS ' + JSON.stringify({ coins:coins(), xp:thieving()-beforeXp, ticks:session.tick()-earnStart }));
        const walker = await sessionWalker(session);
        const guard = { ...walker, walk: async (x:number, z:number) => {
            const from = walker.pos();
            check(from?.level === 0, 'ground route required');
            const path = walker.plan(0, from, {x,z});
            check(path.length > 0 && !expandPath(from,path).some(t => t.x < 3250 && t.z >= 3350 && t.z <= 3390),
                'walk path absent or crosses Varrock dark-wizard corridor');
            return walker.walk(x,z);
        }};
        const walked = await walkPath(guard, route, { maxTicks: 430, stop: stopped });
        check(walked.ok && rangedEntry(player()) && !stopped(), 'Varrock East walk: ' + walked.detail);
        console.log('RANGED_ENTRY ' + JSON.stringify({ tick: session.tick() - start, hp: hp(), x:player()?.worldX,z:player()?.worldZ }));
        const result = await runRangedTrain(session, {
            target: 5, cap: 1800, minArrows: 3, buyArrows: 0, buyArrowId: 882,
            maxSpend: 52, coinReserve: 0, ammo: 25, food: 2, foodId: 329, killsPerTrip: 3, maxTrips: 3, stop: stopped,
        });
        console.log('TRAINING ' + JSON.stringify(result));
        check(result.ok && result.kills > 0 && result.xpGain > 0 && result.startLevel === 1 &&
            result.bow === 841 && result.arrow === 882 && !stopped(), 'starter Ranged job failed: ' + result.failure);
        ok = true;
    } catch (error) {
        console.error(String(error));
    }
    const closed = await settle([session], ok, 'fresh Ranged starter route');
    return ok && closed;
}

if (import.meta.main) {
    const name = process.argv[2];
    check(name && /^[a-z0-9]{1,12}$/i.test(name), 'starter requires one account name');
    const root = resolve(import.meta.dir, '..');
    const server = serverFromEnv(readFileSync(resolve(root, 'vendor/rs-sdk/bots', name, 'bot.env'), 'utf8'));
    const holds = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(server) ? [name] : ['all', name];
    const stopped = () => holds.some(key => existsSync(resolve(root, '.practice', 'stop-' + key)));
    check(!stopped(), 'starter launch held by stop file');
    const session = await openBot(name);
    process.exitCode = await runRangedStarter(session, stopped) ? 0 : 1;
}
