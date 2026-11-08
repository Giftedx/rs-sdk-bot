import { existsSync } from 'node:fs';
import { openBot, settle } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { componentId } from '../packages/core/src/logout';
import { waitUntil } from '../packages/core/src/ticks';
import { sessionWalker, walkPath } from '../packages/core/src/walk';

const bank = { x: 3252, z: 3420, level: 0 };
const edge = { x: 3135, z: 3519, level: 0 };
const profiles = {
    6: { hp: 11, strength: 1, ranged: 7, magic: 7, mindRunes: 5, tile: { x: 3135, z: 3523, level: 0 } },
    9: { hp: 12, strength: 1, ranged: 7, magic: 13, mindRunes: 3, tile: { x: 3135, z: 3524, level: 0 } },
    20: { hp: 24, strength: 23, ranged: 29, magic: 13, mindRunes: 3, tile: { x: 3135, z: 3521, level: 0 } },
};
type StandbyProfile = typeof profiles[keyof typeof profiles];

const route = [
    { x: 3210, z: 3426, tol: 2 },
    { x: 3184, z: 3434, tol: 2 },
    { x: 3167, z: 3459, tol: 2 },
    { x: 3142, z: 3499, tol: 2 },
    { ...edge, tol: 0 },
];
const suppliesFor = (profile: StandbyProfile) => [
    { id: 841, item: /^shortbow$/i, count: 1 },
    { id: 882, item: /^bronze arrow$/i, count: 8 },
    { id: 556, item: /^air rune$/i, count: 10 },
    { id: 558, item: /^mind rune$/i, count: profile.mindRunes },
    { id: 1985, item: /^cheese$/i, count: 1 },
];

const meleeKit = [
    { id: 1277, item: /^bronze sword$/i, count: 1, slot: 3 },
    { id: 1171, item: /^wooden shield$/i, count: 1, slot: 5 },
];

function atTile(position: typeof bank | null | undefined, tile: typeof bank) {
    return position?.x === tile.x && position.z === tile.z && position.level === tile.level;
}

function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function snapshot(session: Session, kit: ReturnType<typeof suppliesFor>) {
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
        meleeReady: meleeKit.every(gear => equipment.some(item => item.slot === gear.slot && item.id === gear.id)),
        supplies: kit.map(({ id }) => ({
            id,
            count: (id === 882 ? equipment.filter(item => item.slot === 13) : inventory)
                .filter(item => item.id === id).reduce((total, item) => total + item.count, 0),
        })),
    };
}

function hasBuild(state: ReturnType<typeof snapshot>, profile: StandbyProfile) {
    return state.hp === profile.hp && state.strength === profile.strength &&
        state.ranged === profile.ranged && state.magic === profile.magic;
}

export function shallowStandbyThreat(
    player: { x: number; z: number; combatLevel: number }, tile: typeof bank, combat: number,
) {
    // These standby tiles are Wilderness level 1. The server uses the shallower player's level.
    return player.z >= 3520 && Math.max(Math.abs(player.x - tile.x), Math.abs(player.z - tile.z)) <= 12 &&
        (!Number.isSafeInteger(player.combatLevel) || player.combatLevel < 3 || player.combatLevel > 126 ||
            Math.abs(player.combatLevel - combat) <= 1);
}
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
    const combat = session.sdk.getState()?.player?.combatLevel;
    const profile = combat === 6 || combat === 9 || combat === 20 ? profiles[combat] : undefined;
    const kit = profile ? suppliesFor(profile) : [];
    const threatened = () => session.sdk.getState()?.nearbyPlayers.some(player =>
        profile && combat !== undefined && shallowStandbyThreat(player, profile.tile, combat));
    let failure: string | undefined;
    try {
        const initial = snapshot(session, kit);
        check(!stopped() && profile && hasBuild(initial, profile), 'standby build changed or stopped');
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
            const hasGear = (gear: typeof meleeKit[number]) => session.sdk.getEquipment()
                .some(item => item.slot === gear.slot && item.id === gear.id);
            const gearNeeded = meleeKit.filter(gear => !hasGear(gear));
            const needed = [...kit, ...gearNeeded];
            check(ammo() === 0 && needed.every(item => held(item.id) === 0 &&
                stock.some(row => row.id === item.id && row.count >= item.count)), 'standby kit stock changed');
            for (const item of needed) {
                check(!stopped() && hp() === profile.hp, 'standby kit withdrawal stopped');
                await session.bot.withdrawItem(item.item, item.count, { asNote: false });
                check(await waitUntil(session, () => held(item.id) === item.count, { timeoutTicks: 10 }),
                    'standby withdrawal missing item ' + item.id);
            }
            await session.bot.closeBank();
            for (const gear of gearNeeded) {
                check(!stopped() && (await session.bot.equipItem(gear.item)).success &&
                    await waitUntil(session, () => hasGear(gear), { timeoutTicks: 10 }), 'standby melee gear not worn');
            }
            check(!stopped() && (await session.bot.equipItem(/^bronze arrow$/i)).success &&
                await waitUntil(session, () => ammo() === 8, { timeoutTicks: 10 }), 'standby ammo not worn');
            const walker = await sessionWalker(session);
            const unsafe = () => stopped() || hp() !== profile.hp;
            const approach = await walkPath(walker, route, {
                maxTicks: 440, idleMs: 9000, stop: () => unsafe() || (position()?.z ?? 0) >= 3520,
            });
            check(approach.ok && atTile(position(), edge) && !unsafe() && threatened() === false,
                'edge approach or clear tile failed: ' + JSON.stringify(approach));
            const ingress = await walkPath(walker, [{ ...profile.tile, tol: 0 }], {
                maxTicks: 12, idleMs: 9000, stop: () => unsafe() || threatened() !== false,
            });
            check(ingress.ok, 'Wilderness staging failed: ' + JSON.stringify(ingress));
        }
        const final = snapshot(session, kit);
        check(!stopped() && atTile(final.position, profile.tile) && hasBuild(final, profile) && final.meleeReady &&
            threatened() === false && session.sdk.getState()?.autoRetaliateEnabled === false &&
            kit.every((item, i) => final.supplies[i]?.count === item.count), 'standby position, kit or tile check failed');
        return { ok: true, final };
    } catch (error) {
        failure = String(error);
        if ((position()?.z ?? 0) >= 3520) {
            try {
                const retreat = await walkPath(await sessionWalker(session), [{ ...edge, tol: 0 }], {
                    maxTicks: 20, idleMs: 9000, stop: () => hp() < Math.ceil((profile?.hp ?? 24) / 2),
                });
                failure += ' | edge exit ' + JSON.stringify(retreat);
            } catch (retreatError) {
                failure += ' | edge exit failed ' + String(retreatError);
            }
        }
        return { ok: false, final: snapshot(session, kit), failure };
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
    const loggedOut = await settle([session], result.ok, result.failure ?? 'Combat ' + result.final.combat + ' Wilderness standby ' + mode);
    console.log('PVP_STANDBY ' + JSON.stringify({ ...result, mode, loginMs, loggedOut }));
    process.exitCode = result.ok && loggedOut ? 0 : 1;
}
