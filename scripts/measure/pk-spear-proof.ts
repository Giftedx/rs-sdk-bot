// Native practice proof: the non-damaging spear hold works through Protect Melee above quarter health.
import {finish, openBot} from '../../packages/core/src/bot';
import type {Session} from '../../packages/core/src/inprocess';
import {tickWaits} from '../../packages/core/src/tick-stream';
import {defaultSpec, fightPlayer, nextTick, observePlayer, PRAYER, protectedStyles} from '../pk';

const [name, targetName] = process.argv.slice(2);
if (!name || !targetName) throw Error('runner and target required');
const SPEAR = 1249, STUN = 254;
const sessions: Session[] = [];
const assets = (s: Session) => {
    const totals = new Map<number, number>();
    for (const item of [...s.sdk.getInventory(), ...s.sdk.getEquipment()]) totals.set(item.id, (totals.get(item.id) ?? 0) + item.count);
    return JSON.stringify([...totals].sort((a, b) => a[0] - b[0]));
};
const energy = (s: Session) => (s.client as {var?: number[]})?.var?.[300];
let done = false, idle = Promise.resolve(), off = () => {};
let proof: Record<string, unknown> & {ok: boolean} = {ok: false};
try {
    tickWaits.active++;
    try {
        sessions.push(await openBot(name));
        sessions.push(await openBot(targetName, {onStop: async () => {}}));
    } finally {tickWaits.active--;}
    const [runner, target] = sessions as [Session, Session];
    // New practice worlds refuse PvP during the first eight ticks.
    for (let n = 0; n < 10; n++) {
        if (!(await Promise.all([nextTick(runner), nextTick(target)])).every(Boolean)) throw Error('session ended before staging');
    }
    if (!target.sdk.getState()?.prayers.activePrayers[PRAYER.melee]) await target.sdk.sendTogglePrayer(PRAYER.melee);
    let protectedTarget = false;
    for (let n = 0; n < 10; n++) {
        const seen = runner.sdk.getState()?.nearbyPlayers.find(p => p.name.toLowerCase() === targetName.toLowerCase());
        if (seen && target.sdk.getState()?.prayers.activePrayers[PRAYER.melee]
            && protectedStyles(observePlayer(runner.client, seen.index)?.headicons).has('melee')) {protectedTarget = true; break;}
        if (!(await Promise.all([nextTick(runner), nextTick(target)])).every(Boolean)) throw Error('session ended before prayer observation');
    }
    const before = sessions.map(s => ({player: {...s.sdk.getState()!.player!}, assets: assets(s)}));
    const targetBefore = before[1]!.player;
    if (!protectedTarget || targetBefore.hp <= targetBefore.maxHp / 4 || energy(runner) !== 1000
        || target.sdk.getState()?.autoRetaliateEnabled !== false || !runner.sdk.getEquipment().some(i => i.slot === 3 && i.id === SPEAR)
        || targetBefore.worldX !== before[0]!.player.worldX + 1 || targetBefore.worldZ !== before[0]!.player.worldZ) {
        throw Error('protected east-adjacent spear entry missing');
    }
    let graphicSeen = false, hpMin = targetBefore.hp;
    off = target.onTick(() => {
        const p = target.sdk.getState()?.player;
        graphicSeen ||= p?.spotanimId === STUN;
        hpMin = Math.min(hpMin, p?.hp ?? 0);
    });
    idle = (async () => {while (!done && await nextTick(target)) { /* Keep the defender waiting in lockstep. */ }})();
    const spec = defaultSpec({melee: [SPEAR]})!;
    const result = await fightPlayer(runner, targetName, {
        kit: {melee: [SPEAR]}, rotation: ['melee'], spec: {...spec, below: 1}, specReserve: 0,
        freeze: false, prayerFlick: false, protectItem: false, defencePrayer: false, overheadPrayer: false, cap: 12,
        stop: () => graphicSeen && energy(runner) === 750,
    });
    const after = sessions.map(s => ({player: {...s.sdk.getState()!.player!}, assets: assets(s)}));
    const p = after[1]!.player;
    graphicSeen ||= p.spotanimId === STUN;
    hpMin = Math.min(hpMin, p.hp);
    // dragon_spear_push tries east (+1,+1), then (+1,0) when the diagonal has no line of walk.
    const dx = p.worldX - targetBefore.worldX, dz = p.worldZ - targetBefore.worldZ;
    const pushed = p.level === targetBefore.level && dx === 1 && (dz === 1 || dz === 0);
    const assetsPreserved = before.every((b, i) => b.assets === after[i]!.assets);
    const livesPreserved = before.every((b, i) => Number.isSafeInteger(b.player.lifeId) && b.player.lifeId === after[i]!.player.lifeId && after[i]!.player.hp > 0);
    const hpPreserved = hpMin === targetBefore.hp && p.hp === targetBefore.hp;
    proof = {ok: protectedTarget && energy(runner) === 750 && pushed && graphicSeen && hpPreserved && assetsPreserved && livesPreserved,
        protectedTarget, energy: energy(runner), pushed, graphicSeen, hpPreserved, assetsPreserved, livesPreserved,
        ticks: result.ticks, pushOffset: [dx, dz], targetBefore: [targetBefore.worldX, targetBefore.worldZ], targetAfter: [p.worldX, p.worldZ]};
} catch (error) {proof = {ok: false, failure: String(error)};}
finally {
    off(); done = true;
    await Promise.race([idle, new Promise(resolve => setTimeout(resolve, 2000))]);
}
console.log('PK_SPEAR_PROOF ' + JSON.stringify(proof));
await finish(sessions, proof.ok, `pk-spear protected-hold ${JSON.stringify(proof)}`);
