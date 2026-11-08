import { existsSync } from 'node:fs';
import { openBot, settle } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { componentId } from '../packages/core/src/logout';
import { waitUntil } from '../packages/core/src/ticks';
import { sessionWalker, walkPath } from '../packages/core/src/walk';

const bank = { x: 3252, z: 3420, level: 0 };
const edge = { x: 3135, z: 3519, level: 0 };
export const standbyTile = { x: 3135, z: 3521, level: 0 };

const route = [
    { x: 3210, z: 3426, tol: 2 },
    { x: 3184, z: 3434, tol: 2 },
    { x: 3167, z: 3459, tol: 2 },
    { x: 3142, z: 3499, tol: 2 },
    { ...edge, tol: 0 },
];
const kit = [
    { id: 841, item: /^shortbow$/i, count: 1 },
    { id: 882, item: /^bronze arrow$/i, count: 8 },
    { id: 556, item: /^air rune$/i, count: 10 },
    { id: 558, item: /^mind rune$/i, count: 3 },
    { id: 1985, item: /^cheese$/i, count: 1 },
];

function atTile(position: typeof bank | null | undefined, tile: typeof bank) {
    return position?.x === tile.x && position.z === tile.z && position.level === tile.level;
}

function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function snapshot(session: Session) {
    const player = session.sdk.getState()?.player;
    const equipment = session.sdk.getEquipment();
    const inventory = session.sdk.getInventory();
    return {
        position: player && { x: player.worldX, z: player.worldZ, level: player.level },
        combat: player?.combatLevel,
        hp: player?.hp,
        strength: session.sdk.getSkill('Strength')?.baseLevel,
        ranged: session.sdk.getSkill('Ranged')?.baseLevel,
        magic: session.sdk.getSkill('Magic')?.baseLevel,
        sword: equipment.some(item => item.slot === 3 && item.id === 1277),
        supplies: kit.map(({ id }) => ({
            id,
            count: (id === 882 ? equipment.filter(item => item.slot === 13) : inventory)
                .filter(item => item.id === id).reduce((total, item) => total + item.count, 0),
        })),
    };
}

function hasBuild(state: ReturnType<typeof snapshot>) {
    return state.combat === 20 && state.hp === 24 && state.strength === 23 &&
        state.ranged === 29 && state.magic === 13 && state.sword;
}

function tileOccupied(session: Session) {
    return session.sdk.getState()?.nearbyPlayers.some(player => player.z >= 3520 &&
        Math.max(Math.abs(player.x - standbyTile.x), Math.abs(player.z - standbyTile.z)) <= 12);
}

// The route and kit qualify one combat-20 build at Wilderness level 1.
export async function runWildernessStandby(
    session: Session,
    mode: 'stage' | 'verify',
    stopped: () => boolean,
) {
    const position = () => {
        const player = session.sdk.getState()?.player;
        return player && { x: player.worldX, z: player.worldZ, level: player.level };
    };
    const hp = () => session.sdk.getState()?.player?.hp ?? 0;
    const held = (id: number) => session.sdk.getInventory().filter(item => item.id === id)
        .reduce((total, item) => total + item.count, 0);
    const ammo = () => session.sdk.getEquipment().find(item => item.slot === 13 && item.id === 882)?.count ?? 0;
    let failure: string | undefined;
    try {
        const initial = snapshot(session);
        check(!stopped() && hasBuild(initial), 'standby build changed or stopped');
        if (mode === 'stage') {
            check(atTile(initial.position, bank), 'standby requires the Varrock East bank start');
            if (session.sdk.getState()?.autoRetaliateEnabled === true) {
                await session.sdk.sendClickComponent(componentId('controls:com_3'));
            }
            check(await waitUntil(session, () => session.sdk.getState()?.autoRetaliateEnabled === false,
                { timeoutTicks: 8 }), 'auto-retaliation state unconfirmed');
            check((await session.bot.openBank()).success && await waitUntil(session,
                () => Boolean(session.bankObservation?.()), { timeoutTicks: 14 }), 'staging bank did not open');
            const stock = session.bankObservation?.()?.items ?? [];
            check(ammo() === 0 && kit.every(item => held(item.id) === 0 &&
                stock.some(row => row.id === item.id && row.count >= item.count)), 'standby kit stock changed');
            for (const item of kit) {
                check(!stopped() && hp() === 24, 'standby kit withdrawal stopped');
                await session.bot.withdrawItem(item.item, item.count, { asNote: false });
                check(await waitUntil(session, () => held(item.id) === item.count, { timeoutTicks: 10 }),
                    'standby withdrawal missing item ' + item.id);
            }
            await session.bot.closeBank();
            check((await session.bot.equipItem(/^bronze arrow$/i)).success &&
                await waitUntil(session, () => ammo() === 8, { timeoutTicks: 10 }), 'standby ammo not worn');
            const walker = await sessionWalker(session);
            const unsafe = () => stopped() || hp() !== 24;
            const approach = await walkPath(walker, route, {
                maxTicks: 440, idleMs: 9000, stop: () => unsafe() || (position()?.z ?? 0) >= 3520,
            });
            check(approach.ok && atTile(position(), edge) && !unsafe() && tileOccupied(session) === false,
                'edge approach or clear tile failed: ' + JSON.stringify(approach));
            const ingress = await walkPath(walker, [{ ...standbyTile, tol: 0 }], {
                maxTicks: 12, idleMs: 9000, stop: () => unsafe() || tileOccupied(session) !== false,
            });
            check(ingress.ok, 'Wilderness staging failed: ' + JSON.stringify(ingress));
        }
        const final = snapshot(session);
        check(!stopped() && atTile(final.position, standbyTile) && hasBuild(final) &&
            tileOccupied(session) === false && session.sdk.getState()?.autoRetaliateEnabled === false &&
            kit.every((item, i) => final.supplies[i]?.count === item.count), 'standby position, kit or tile check failed');
        return { ok: true, final };
    } catch (error) {
        failure = String(error);
        if ((position()?.z ?? 0) >= 3520) {
            try {
                const retreat = await walkPath(await sessionWalker(session), [{ ...edge, tol: 0 }], {
                    maxTicks: 20, idleMs: 9000, stop: () => hp() < 12,
                });
                failure += ' | edge exit ' + JSON.stringify(retreat);
            } catch (retreatError) {
                failure += ' | edge exit failed ' + String(retreatError);
            }
        }
        return { ok: false, final: snapshot(session), failure };
    }
}

if (import.meta.main) {
    const [name, mode, ...extra] = process.argv.slice(2);
    check(name && (mode === 'stage' || mode === 'verify') && !extra.length,
        'usage: bun scripts/pvp-standby.ts <account> <stage|verify>');
    const stop = () => existsSync('.practice/stop-' + name) || existsSync('.practice/stop-pvp-standby');
    check(!stop(), 'standby stop file present');
    const start = performance.now();
    const session = await openBot(name);
    const loginMs = Math.round(performance.now() - start);
    const result = await runWildernessStandby(session, mode, stop);
    const loggedOut = await settle([session], result.ok, result.failure ?? 'Combat 20 Wilderness standby ' + mode);
    console.log('PVP_STANDBY ' + JSON.stringify({ ...result, mode, loginMs, loggedOut }));
    process.exitCode = result.ok && loggedOut ? 0 : 1;
}
