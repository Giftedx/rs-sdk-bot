import { readFileSync } from 'node:fs';
import Module from 'node:module';
import { resolve } from 'node:path';
import type { Session } from '../../../core/src/inprocess';
import { componentId } from '../../../core/src/logout';
import { elementalRuneCost, type NativeTeleport } from '../../../core/src/magic-data';
import { clientReach } from '../../../core/src/reach';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { expandPath, sessionWalker, walkPath } from '../../../core/src/walk';
import { CollisionFlag as NativeCollisionFlag } from '../../../../vendor/rs-sdk/server/engine/src/engine/routefinder/flags';
import { ClientProt } from '../../../../vendor/rs-sdk/server/webclient/src/io/ClientProt';
import { combatTeleportAllowed, eatBetweenCasts } from './runtime';
import { REPO_ROOT } from './types';

let cachedMageAnim: number | undefined;
function getMageAnim(): number {
    if (cachedMageAnim !== undefined) return cachedMageAnim;
    const text = readFileSync(resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/pack/seq.pack'), 'utf8');
    const needle = '=human_casting';
    let pos = 0;
    while (pos < text.length) {
        let end = text.indexOf('\n', pos);
        if (end < 0) end = text.length;
        const lineEnd = end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
        if (lineEnd - pos > needle.length && text.endsWith(needle, lineEnd)) {
            const id = Number(text.slice(pos, lineEnd - needle.length));
            cachedMageAnim = id;
            return id;
        }
        pos = end + 1;
    }
    cachedMageAnim = NaN;
    return cachedMageAnim;
}

export const guardianMagePose = (npc: { animId?: number } | undefined) => {
    const anim = getMageAnim();
    return Number.isInteger(anim) && npc?.animId === anim;
};

type Policy = { fatal: () => boolean; stop: () => boolean };
const hp = (s: Session) => s.sdk.getSkill('Hitpoints')?.level ?? 0;

export async function guardianHeal(s: Session, p: Policy) {
    for (let n = 0; n < 4 && hp(s) <= 70; n++) {
        if (p.fatal() || p.stop()) throw Error('guardian food stopped');
        if (!(await eatBetweenCasts(s, { food: [379], eatAt: 70, timeoutTicks: 6, attempts: 2 }))) break;
        await waitUntil(s, () => p.fatal() || p.stop(), { timeoutTicks: 3 });
        if (p.fatal() || p.stop()) throw Error('guardian food settlement stopped');
    }
}

export async function clearGuardianMessage(s: Session, p: Policy) {
    const dialog = () => s.sdk.getState()?.dialog;
    if (!dialog()?.isOpen) return;
    if (p.fatal() || p.stop()) throw Error('guardian message stopped');
    if (!dialog()?.isOpen) return;
    const d = dialog();
    if (d?.options.length !== 1 || !/^Click here to continue$/i.test(d.options[0]!.text)) {
        throw Error('guardian unexpected blocking dialogue');
    }
    if (p.fatal() || p.stop()) throw Error('guardian message stopped');
    await s.sdk.sendCloseModal();
    await waitTicks(s, 2);
    if (p.fatal() || p.stop()) throw Error('guardian message stopped');
}

export async function guardianWalk(s: Session, to: { x: number; z: number }, p: Policy, maxTicks = 40) {
    if (p.fatal() || p.stop()) throw Error('guardian movement stopped');
    await clearGuardianMessage(s, p);
    await guardianHeal(s, p);
    if (p.fatal() || p.stop() || hp(s) < 35) throw Error('guardian movement life/HP floor');
    const result = await walkPath(await sessionWalker(s), [{ ...to, tol: 0 }], { maxTicks, stop: () => p.fatal() || p.stop() || hp(s) < 35 });
    if (!result.ok || p.fatal() || hp(s) < 35) throw Error('guardian movement ' + (result.detail ?? 'life/HP floor'));
    await guardianHeal(s, p);
}

let cachedEmptyCrossbowSpec: { item: number; range: number; cooldown: number; quiver: number; noAmmo: string } | undefined;
export function guardianEmptyCrossbowSpec() {
    if (cachedEmptyCrossbowSpec) return { ...cachedEmptyCrossbowSpec };
    const path = resolve(REPO_ROOT, 'vendor/rs-sdk/server/content') + '/';
    const objPackText = readFileSync(path + 'pack/obj.pack', 'utf8');
    let id = NaN;
    let pos = 0;
    const needle = '=crossbow';
    while (pos < objPackText.length) {
        let end = objPackText.indexOf('\n', pos);
        if (end < 0) end = objPackText.length;
        const lineEnd = end > pos && objPackText.charCodeAt(end - 1) === 13 ? end - 1 : end;
        if (lineEnd - pos > needle.length && objPackText.endsWith(needle, lineEnd)) {
            id = Number(objPackText.slice(pos, lineEnd - needle.length));
            break;
        }
        pos = end + 1;
    }
    const block = readFileSync(path + 'scripts/skill_combat/configs/ranged/crossbows.obj', 'utf8').split('[crossbow]')[1]?.split('\n[')[0]?.replace(/\r/g, '') ?? '';
    const field = (key: string) => Number(block.match(new RegExp('^param=' + key + ',([0-9]+)$', 'm'))?.[1]);
    const quiver = Number(readFileSync(path + 'scripts/player/configs/equip.constant', 'utf8').match(/\^wearpos_quiver\s*=\s*(\d+)/)?.[1]);
    const range = Math.min(field('attackrange'), 10);
    const cooldown = field('attackrate');
    if (id !== 837 || range !== 10 || cooldown !== 6 || quiver !== 13) throw Error('native empty-crossbow recipe changed');
    cachedEmptyCrossbowSpec = { item: id, range, cooldown, quiver, noAmmo: 'There is no ammo left in your quiver.' };
    return { ...cachedEmptyCrossbowSpec };
}

let cachedSaraMeleeLimit: { strength: number; bonus: number; maximum: number; floor: number } | undefined;
export function guardianSaraMeleeLimit() {
    if (cachedSaraMeleeLimit) return { ...cachedSaraMeleeLimit };
    const base = resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/scripts') + '/';
    const npc = readFileSync(base + 'minigames/game_trail/configs/trail.npc', 'utf8').split('[trail_hard2]')[1]?.split('\n[')[0] ?? '';
    const strength = Number(npc.match(/^strength=(\d+)/m)?.[1]);
    const bonus = Number(npc.match(/^param=strengthbonus,(\d+)/m)?.[1]);
    const melee = readFileSync(base + 'skill_combat/scripts/npc/npc_combat_melee.rs2', 'utf8').replace(/\s/g, '');
    const combat = readFileSync(base + 'skill_combat/scripts/combat.rs2', 'utf8').replace(/\s/g, '');
    if (
        !melee.includes('~combat_effective_stat(npc_stat(strength),100)') ||
        !melee.includes('$effective_strength=add($effective_strength,9);') ||
        !combat.includes('return(scale(max(100,$prayerbonus),100,$stat_level));') ||
        !combat.includes('return(calc($effective_stat*($bonus+64)));') ||
        !combat.includes('return(calc(($combat_stat+320)/640));')
    ) {
        throw Error('native Sara melee formula changed');
    }
    const maximum = Math.floor(((strength + 9) * (bonus + 64) + 320) / 640);
    if (strength !== 80 || bonus !== 40 || maximum !== 14) throw Error('native Sara melee envelope changed');
    cachedSaraMeleeLimit = { strength, bonus, maximum, floor: 70 };
    return { ...cachedSaraMeleeLimit };
}

let cachedSaraLandingTail: number | undefined;
export function guardianSaraLandingTail() {
    if (cachedSaraLandingTail !== undefined) return cachedSaraLandingTail;
    const base = resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/scripts') + '/';
    const row = readFileSync(base + 'skill_combat/configs/magic/magic_combat_spells.dbrow', 'utf8').split('[magic_spell_saradomin_strike_npc]')[1]?.split('\n[')[0] ?? '';
    const source = readFileSync(base + 'skill_combat/scripts/npc/npc_combat_magic.rs2', 'utf8').replace(/\s/g, '');
    if (!row || /^data=spotanim_proj,/m.test(row) || !source.includes('def_int$duration=64;') || !source.includes('queue(combat_damage_player,calc($duration/30),$damage);')) {
        throw Error('native Sara projectile tail changed');
    }
    cachedSaraLandingTail = Math.floor(64 / 30) + 1;
    return cachedSaraLandingTail;
}

let cachedSaraAttackRange: number | undefined;
export function guardianSaraAttackRange() {
    if (cachedSaraAttackRange !== undefined) return cachedSaraAttackRange;
    const row = readFileSync(resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/scripts/minigames/game_trail/configs/trail.npc'), 'utf8').split('[trail_hard2]')[1]?.split('\n[')[0] ?? '';
    const range = Number(row.match(/^attackrange=(\d+)/m)?.[1]);
    if (range !== 5) throw Error('native Sara AP attack range changed');
    cachedSaraAttackRange = range;
    return cachedSaraAttackRange;
}

export function guardianCrossbowGoals(
    from: { x: number; z: number; level: number },
    npc: { x: number; z: number; size: number },
    plan: (level: number, from: { x: number; z: number }, to: { x: number; z: number }) => { x: number; z: number }[],
    reach: (to: { x: number; z: number }) => boolean | null,
    sight: (from: { x: number; z: number }, to: { x: number; z: number; size: number }) => boolean,
) {
    const maximum = guardianSaraAttackRange();
    const points: { x: number; z: number; length: number; clearance: number }[] = [];
    for (let dx = -maximum; dx <= maximum; dx++) {
        for (let dz = -maximum; dz <= maximum; dz++) {
            const gap = Math.max(Math.abs(dx), Math.abs(dz));
            const to = { x: npc.x + dx, z: npc.z + dz };
            if (gap < 5 || gap > maximum || reach(to) === false || !sight(to, npc)) continue;
            const path = plan(from.level, from, to);
            const end = path.at(-1) ?? from;
            if (end.x !== to.x || end.z !== to.z) continue;
            const tiles = expandPath(from, path);
            if (tiles.some((t) => Math.max(Math.abs(t.x - npc.x), Math.abs(t.z - npc.z)) > 16)) continue;
            points.push({ ...to, length: tiles.length, clearance: gap - Math.ceil(tiles.length / 2) });
        }
    }
    return points.sort((a, b) => a.length - b.length || a.x - b.x || a.z - b.z);
}

export function guardianLoadedSight(c: any) {
    const file = resolve(REPO_ROOT, 'vendor/rs-sdk/server/vendor/rsmod-pathfinder/rsmod-pathfinder.js');
    const module: any = new Module(file);
    module.filename = file;
    module._compile(readFileSync(file, 'utf8'), file);
    const ray = module.exports;
    return (a: { x: number; z: number; level: number }, b: { x: number; z: number; size: number }) => {
        if (
            typeof c.ensureCollision !== 'function' ||
            ![a.x, a.z, a.level, b.x, b.z, b.size, c.mapBuildBaseX, c.mapBuildBaseZ].every(Number.isSafeInteger) ||
            a.level !== c.minusedlevel ||
            b.size !== 1
        ) {
            return false;
        }
        c.ensureCollision();
        const flags = c.collision?.[a.level]?.flags;
        if (!(flags instanceof Int32Array) || flags.length !== 104 * 104) return false;
        const from = { x: a.x - c.mapBuildBaseX, z: a.z - c.mapBuildBaseZ };
        const to = { x: b.x - c.mapBuildBaseX, z: b.z - c.mapBuildBaseZ };
        const minX = Math.min(from.x, to.x);
        const maxX = Math.max(from.x, to.x);
        const minZ = Math.min(from.z, to.z);
        const maxZ = Math.max(from.z, to.z);
        if (minX < 1 || minZ < 1 || maxX > 102 || maxZ > 102) return false;
        for (let x = minX; x <= maxX; x++) {
            for (let z = minZ; z <= maxZ; z++) {
                const raw = flags[x * 104 + z]!;
                if (raw & 0x1000000) return false;
                const native = (raw & 0x3fe00) | (raw & 0x80000 ? NativeCollisionFlag.BLOCK_NPC_AND_PLAYERS : 0);
                ray.allocateIfAbsent(x, z, 0);
                ray.__set(x, z, 0, native);
            }
        }
        return ray.hasLineOfSight(0, from.x, from.z, to.x, to.z, 1, 1, 1, 1, NativeCollisionFlag.BLOCK_NPC_AND_PLAYERS);
    };
}

export async function setupSaradominMage(
    s: Session,
    index: number,
    npcId: number,
    _dig: { x: number; z: number },
    p: Policy,
    deps: { walker?: typeof sessionWalker; sight?: (a: { x: number; z: number; level: number }, b: { x: number; z: number; size: number }) => boolean } = {},
) {
    const c = s.client as any;
    const spec = guardianEmptyCrossbowSpec();
    const saraRange = guardianSaraAttackRange();
    const meleeLimit = guardianSaraMeleeLimit();
    const state = () => s.sdk.getState();
    const first = state()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const plane = first?.level;
    const capturedNpc = c.npc?.[index];
    const sessionExecutor = c.executeBotAction;
    let ended = false;
    let ready = false;
    let setupReceipt: any;
    void s.ended.then(() => {
        ended = true;
    });
    const fatal = () => {
        const me = state()?.player;
        return (
            s.client !== c ||
            ended ||
            p.fatal() ||
            !c.localPlayer ||
            !c.isInGame?.() ||
            c.minusedlevel !== plane ||
            !me ||
            me.isDead ||
            me.lifeId !== life ||
            (me.respawnCount ?? 0) !== respawns ||
            me.level !== plane ||
            hp(s) < 1
        );
    };
    const stop = () => fatal() || p.stop();
    const inv = () => s.sdk.getInventory();
    const gear = () => s.sdk.getEquipment();
    const held = (id: number) => inv().filter((i) => i.id === id).reduce((a, i) => a + i.count, 0);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const gearView = () => gear().map((i) => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot);
    const totals = () => {
        const out: Record<number, number> = {};
        for (const i of [...inv(), ...gear()]) out[i.id] = (out[i.id] ?? 0) + i.count;
        return out;
    };
    const originalGear = gearView();
    const originalStyle = JSON.parse(JSON.stringify(state()?.combatStyle ?? null));
    const styleEqual = () => same(state()?.combatStyle, originalStyle);
    const head = () => ({ x: c.mapBuildBaseX + c.localPlayer.routeX[0], z: c.mapBuildBaseZ + c.localPlayer.routeZ[0], level: c.minusedlevel });
    const fresh = () => !fatal() && s.sdk.getStateAge() <= 5000 && [head().x, head().z].every(Number.isSafeInteger);
    const ownedFace = () => state()?.nearbyNpcs.find((n) => n.id === npcId && n.index === index && n.targetIndex === 32768 + c.selfSlot);
    const bound = (_index: number) =>
        s.client === c && c.npc?.[index] === capturedNpc && capturedNpc?.type?.id === npcId
            ? state()?.nearbyNpcs.find((n) => n.id === npcId && n.index === index && (n.targetIndex === 32768 + c.selfSlot || n.targetIndex === -1))
            : undefined;
    const target = () => ownedFace();
    const enemyHead = (_index: number) => {
        const n = c.npc?.[index];
        if (n !== capturedNpc || n?.type?.id !== npcId) return null;
        const at = { x: c.mapBuildBaseX + n.routeX[0], z: c.mapBuildBaseZ + n.routeZ[0], size: n.type?.size ?? 1 };
        return [at.x, at.z, at.size].every(Number.isSafeInteger) && at.size === 1 ? at : null;
    };
    const sight = deps.sight ?? guardianLoadedSight(c);
    const coherent = () => {
        const me = head();
        const to = enemyHead(index);
        const local = c.localPlayer;
        const published = state()?.player;
        return (
            !!to &&
            !!published &&
            published.worldX === me.x &&
            published.worldZ === me.z &&
            Math.floor(local.x / 128) + c.mapBuildBaseX === me.x &&
            Math.floor(local.z / 128) + c.mapBuildBaseZ === me.z
        );
    };
    const rangedKnown = () => {
        const style = state()?.combatStyle;
        return !!style?.known && /^ranged$/i.test(style.styles[style.currentStyle]?.damageType ?? '');
    };
    const emptyQuiver = () => !gear().some((i) => i.slot === spec.quiver && i.count > 0);
    const equip = async (id: number, cleanup = false) => {
        if (fatal() || (!cleanup && stop()) || !fresh() || c.executeBotAction !== sessionExecutor) {
            throw Error('guardian owned weapon original life/stop/fresh input owner');
        }
        if (gear().some((i) => i.slot === 3 && i.id === id)) return;
        const row = inv().find((i) => i.id === id);
        if (!row || row.count !== 1) throw Error('guardian exact owned weapon missing');
        const before = totals();
        const old = gear().find((i) => i.slot === 3)?.id;
        let reply = '';
        try {
            const sent = await s.bot.equipItem(row);
            reply = sent.success ? 'acknowledged' : sent.message;
        } catch (error) {
            reply = String(error);
        }
        if (
            !(await waitUntil(
                s,
                () => {
                    if (
                        fatal() ||
                        !fresh() ||
                        c.executeBotAction !== sessionExecutor ||
                        (!cleanup && (stop() || !enemyHead(index) || !bound(index) || !s.sdk.isPrayerActive(12) || state()!.nearbyPlayers.length))
                    ) {
                        throw Error('guardian weapon settlement observation/input owner changed');
                    }
                    return gear().some((i) => i.slot === 3 && i.id === id) && held(id) === 0 && same(totals(), before) && (!old || held(old) >= 1);
                },
                { timeoutTicks: 12 },
            )) ||
            fatal() ||
            !gear().some((i) => i.slot === 3 && i.id === id) ||
            !same(totals(), before)
        ) {
            throw Error('guardian paired owned weapon swap unconfirmed: ' + reply);
        }
    };

    const npc = target();
    if (
        !npc ||
        !c.localPlayer ||
        !c.isInGame?.() ||
        c.minusedlevel !== plane ||
        !Number.isSafeInteger(life) ||
        !Number.isSafeInteger(c.selfSlot) ||
        !enemyHead(index) ||
        !s.sdk.isPrayerActive(12) ||
        state()!.nearbyPlayers.length ||
        !fresh() ||
        typeof sessionExecutor !== 'function' ||
        typeof c.writeOpcode !== 'function' ||
        typeof c.out?.p1 !== 'function' ||
        typeof c.out?.p2 !== 'function' ||
        !emptyQuiver() ||
        held(837) !== 1 ||
        !gear().some((i) => i.slot === 3 && i.id === 1381) ||
        !originalStyle?.known
    ) {
        throw Error('guardian empty-crossbow requires bound Sara, owned Crossbow837, empty quiver, original observed AirStaff style');
    }
    const used = new Set<string>();
    let staffRestoreAttempted = false;
    let attempts = 0;
    try {
        await equip(spec.item);
        if (
            !(await waitUntil(
                s,
                () => {
                    if (
                        stop() ||
                        !fresh() ||
                        !bound(index) ||
                        !enemyHead(index) ||
                        !s.sdk.isPrayerActive(12) ||
                        state()!.nearbyPlayers.length ||
                        c.executeBotAction !== sessionExecutor
                    ) {
                        throw Error('guardian empty-crossbow setup observation/input owner changed');
                    }
                    return rangedKnown();
                },
                { timeoutTicks: 8 },
            )) ||
            stop() ||
            !rangedKnown() ||
            !emptyQuiver()
        ) {
            throw Error('guardian empty-crossbow ranged style/quiver not observed');
        }
        for (let attempt = 0; attempt < 2 && !ready; attempt++) {
            await guardianHeal(s, { fatal, stop });
            const walker = await (deps.walker ?? sessionWalker)(s);
            const from = head();
            const n = enemyHead(index);
            if (!n || !bound(index) || stop() || state()!.nearbyPlayers.length || c.executeBotAction !== sessionExecutor) {
                throw Error('guardian empty-crossbow private target/life/input owner changed');
            }
            const admitted = () => {
                const me = head();
                const to = enemyHead(index);
                const d = to && Math.max(Math.abs(me.x - to.x), Math.abs(me.z - to.z));
                return (
                    !stop() &&
                    fresh() &&
                    !!to &&
                    !!bound(index) &&
                    d !== null &&
                    d >= 5 &&
                    d <= Math.min(spec.range, saraRange) &&
                    coherent() &&
                    sight(me, to) &&
                    emptyQuiver() &&
                    rangedKnown() &&
                    s.sdk.isPrayerActive(12) &&
                    state()!.nearbyPlayers.length === 0
                );
            };
            const walkedAt = s.tick();
            const cycleAt = c.getClientCycle?.();
            if (!Number.isSafeInteger(cycleAt)) throw Error('guardian native client cycle unavailable');
            let arrived = false;
            while (!arrived && s.tick() - walkedAt < 18) {
                const current = head();
                const enemy = enemyHead(index);
                if (!enemy || !bound(index) || stop() || c.executeBotAction !== sessionExecutor) {
                    throw Error('guardian retreat original target/input owner changed');
                }
                const reach = clientReach(c, () => head());
                const goal = guardianCrossbowGoals(
                    current,
                    enemy,
                    walker.plan,
                    (to) => reach?.({ ...to, level: current.level }, { maxSteps: 4096 }) ?? null,
                    (a, b) => sight({ ...a, level: current.level }, b),
                ).find((to) => !used.has(`${to.x},${to.z}`) && (attempt === 0 || to.x !== from.x || to.z !== from.z));
                if (!goal) break;
                used.add(`${goal.x},${goal.z}`);
                const legTick = s.tick();
                const legCycle = c.getClientCycle();
                const settled = () => {
                    const me = head();
                    return me.x === goal.x && me.z === goal.z && s.tick() > legTick && c.getClientCycle() > legCycle && admitted();
                };
                await walkPath(walker, [{ x: goal.x, z: goal.z, tol: 0 }], {
                    maxTicks: Math.max(1, 18 - (s.tick() - walkedAt)),
                    stop: () => stop() || c.executeBotAction !== sessionExecutor || hp(s) < 70 || settled() || s.tick() - walkedAt >= 18,
                });
                if (!settled() && s.tick() === legTick) {
                    await waitUntil(s, () => stop() || c.executeBotAction !== sessionExecutor || (s.tick() > legTick && c.getClientCycle() > legCycle), {
                        timeoutTicks: Math.max(1, 18 - (s.tick() - walkedAt)),
                    });
                }
                arrived = settled();
            }
            if (stop() || hp(s) < 70 || c.executeBotAction !== sessionExecutor) throw Error('guardian empty-crossbow lane life/HP/stop/input owner');
            if (!arrived || !admitted() || c.getClientCycle() <= cycleAt) continue;
            const health = hp(s);
            const assets = totals();
            const skills = ['Attack', 'Strength', 'Defence', 'Ranged', 'Magic', 'Hitpoints'];
            const xp = skills.map((k) => s.sdk.getSkillXp(k));
            const at = s.tick();
            const cursor = Math.max(0, ...(state()?.gameMessages ?? []).map((m) => m.observationId ?? 0));
            let lowest = health;
            if (health < meleeLimit.floor) throw Error('guardian Sara AP HP below70');
            const original = c.executeBotAction;
            let authorized = false;
            const bridge = function (this: unknown, a: any) {
                if (a?.type !== 'guardianEmptyCrossbowAttack') return original.call(c, a);
                if (a.index !== index || stop() || !admitted() || hp(s) !== health || !same(totals(), assets) || authorized || c.executeBotAction !== bridge) {
                    throw Error('guardian empty-crossbow no-ammo AP admission changed');
                }
                authorized = true;
                const me = head();
                console.log(
                    'GUARDIAN_SARA_AP_ADMISSION ' +
                        JSON.stringify({
                            tick: s.tick(),
                            cycle: c.getClientCycle(),
                            received: me,
                            target: enemyHead(index),
                            published: state()?.player && { x: state()!.player!.worldX, z: state()!.player!.worldZ },
                            coherent: coherent(),
                            minimumGap: 5,
                            nativeMaximum: spec.range,
                            nativeSaraMaximum: saraRange,
                        }),
                );
                c.writeOpcode(ClientProt.MOVE_GAMECLICK);
                c.out.p1(5);
                c.out.p1(0);
                c.out.p2(me.x);
                c.out.p2(me.z);
                c.writeOpcode(ClientProt.OPNPC2);
                c.out.p2(index);
                return { success: true };
            };
            let noAmmo: any;
            let reachRefusal: any;
            let mageTick: number | undefined;
            let installed = false;
            const check = () => {
                const message = (text: string) =>
                    (state()?.gameMessages ?? []).find(
                        (m) =>
                            m.type === 0 &&
                            m.sender === '' &&
                            m.fromSelf === false &&
                            Number.isSafeInteger(m.observationId) &&
                            m.observationId! > cursor &&
                            m.tick >= at &&
                            m.tick <= s.tick() &&
                            m.text === text,
                    );
                noAmmo = message(spec.noAmmo);
                reachRefusal = message("I can't reach that!");
                const now = hp(s);
                if (
                    stop() ||
                    !fresh() ||
                    !enemyHead(index) ||
                    !bound(index) ||
                    state()!.nearbyPlayers.length ||
                    !s.sdk.isPrayerActive(12) ||
                    (installed ? c.executeBotAction !== bridge : c.executeBotAction !== original) ||
                    !emptyQuiver() ||
                    now < meleeLimit.floor ||
                    now > lowest ||
                    health - now > meleeLimit.maximum ||
                    !same(totals(), assets) ||
                    skills.some((k, i) => s.sdk.getSkillXp(k) !== xp[i])
                ) {
                    throw Error('guardian empty-crossbow AP stock/HP/XP/private target changed');
                }
                lowest = Math.min(lowest, now);
                const n = ownedFace();
                if (s.tick() > at && guardianMagePose(n)) mageTick ??= s.tick();
                return ((!!noAmmo && mageTick !== undefined) || !!reachRefusal) && state()?.player?.combat.targetType === 'none';
            };
            if (original !== sessionExecutor || c.executeBotAction !== sessionExecutor) {
                throw Error('guardian empty-crossbow AP input owner changed before bridge');
            }
            c.executeBotAction = bridge;
            installed = true;
            let dispatch = '';
            try {
                attempts++;
                try {
                    const result = (await s.direct({
                        type: 'guardianEmptyCrossbowAttack',
                        index,
                        reason: 'guardian empty-crossbow owned empty crossbow AP; no client melee route',
                    })) as any;
                    dispatch = result?.success ? 'acknowledged' : 'unknown';
                } catch (error) {
                    dispatch = String(error);
                }
                if (!authorized) throw Error('guardian empty-crossbow AP input not authorized: ' + dispatch);
                await waitUntil(s, check, { timeoutTicks: 12 });
            } finally {
                if (c.executeBotAction === bridge) c.executeBotAction = original;
                installed = false;
            }
            check();
            const accepted = !!noAmmo && !!ownedFace() && mageTick !== undefined && state()?.player?.combat.targetType === 'none';
            const refused =
                dispatch === 'acknowledged' && !!reachRefusal && !noAmmo && mageTick === undefined && hp(s) === health && state()?.player?.combat.targetType === 'none';
            if (refused) {
                console.log(
                    'GUARDIAN_SARA_REACH_REFUSED ' +
                        JSON.stringify({ attempt: attempts, at, reachRefusal, head: head(), target: enemyHead(index), outcome: 'known native reach refusal; exact assets/HP/XP retained' }),
                );
                continue;
            }
            if (!noAmmo || state()?.player?.combat.targetType !== 'none') throw Error('guardian empty-crossbow unknown no-ammo outcome; no second attack');
            const cooldownEnd = noAmmo.tick + spec.cooldown;
            if (s.tick() < cooldownEnd) {
                await waitUntil(s, () => {
                    check();
                    return s.tick() >= cooldownEnd;
                }, { timeoutTicks: cooldownEnd - s.tick() });
            }
            check();
            console.log(
                'GUARDIAN_SARA_EMPTY_AP ' +
                    JSON.stringify({
                        attempt: attempts,
                        at,
                        noAmmo,
                        mageTick,
                        accepted,
                        dispatch,
                        head: head(),
                        target: enemyHead(index),
                        nativeCooldown: spec.cooldown,
                        setupHPBefore: health,
                        setupHPLowest: lowest,
                        setupHPLoss: health - lowest,
                        maxSource: meleeLimit.maximum,
                    }),
            );
            if (accepted) {
                staffRestoreAttempted = true;
                await equip(1381);
                if (
                    !(await waitUntil(s, () => {
                        check();
                        return styleEqual();
                    }, { timeoutTicks: 12 })) ||
                    stop() ||
                    !styleEqual()
                ) {
                    throw Error('guardian empty-crossbow original AirStaff combat style not restored');
                }
                if (!same(gearView(), originalGear) || held(837) !== 1) throw Error('guardian empty-crossbow exact original gear/crossbow pack not restored');
                check();
                if (!ownedFace() || mageTick === undefined || mageTick <= at || state()?.player?.combat.targetType !== 'none') {
                    throw Error('guardian final private mage owner unconfirmed');
                }
                ready = true;
                setupReceipt = {
                    attempts,
                    noAmmo,
                    mageTick,
                    gearRestored: true,
                    styleRestored: true,
                    noPlayerXP: true,
                    setupHPBefore: health,
                    setupHPLowest: lowest,
                    setupHPLoss: health - lowest,
                    maxSource: meleeLimit.maximum,
                };
            }
        }
        if (!ready) throw Error('guardian two bounded empty-crossbow attempts did not observe mage mode');
    } finally {
        if (!fatal() && !gear().some((i) => i.slot === 3 && i.id === 1381) && !staffRestoreAttempted) {
            staffRestoreAttempted = true;
            await equip(1381, true);
        }
        if (!fatal() && !styleEqual()) {
            await waitUntil(
                s,
                () => {
                    if (!fresh() || c.executeBotAction !== sessionExecutor) throw Error('guardian original style fresh observation/input owner changed');
                    return styleEqual();
                },
                { timeoutTicks: 12 },
            );
        }
        if (!fatal() && (!same(gearView(), originalGear) || held(837) !== 1 || !styleEqual())) {
            throw Error('guardian empty-crossbow finally gear/control restoration unconfirmed');
        }
    }

    if (ready) console.log('GUARDIAN_SARA_AP ' + JSON.stringify({ ...setupReceipt, hp: hp(s) }));
}

export function guardianExitCandidates(walkable: (to: { x: number; z: number }) => boolean) {
    const points: { x: number; z: number }[] = [];
    for (let x = 2944; x <= 3391; x += 8) points.push({ x, z: 3679 });
    for (let z = 3680; z <= 3999; z += 8) points.push({ x: 2943, z }, { x: 3392, z });
    return points.filter(walkable);
}

export function guardianExtractionStep(
    player: { worldX: number; worldZ: number; level: number },
    plan: (level: number, from: { x: number; z: number }, to: { x: number; z: number }) => { x: number; z: number }[],
    exit?: { x: number; z: number },
    walkable: (to: { x: number; z: number }) => boolean = () => true,
    reach?: (to: { x: number; z: number }) => boolean | null,
) {
    const from = { x: player.worldX, z: player.worldZ };
    const distance = (to: { x: number; z: number }) => Math.max(Math.abs(to.x - from.x), Math.abs(to.z - from.z));
    const candidates = (exit ? [exit] : guardianExitCandidates(walkable))
        .filter((to) => combatTeleportAllowed({ ...player, worldX: to.x, worldZ: to.z }) && reach?.(to) !== false)
        .sort((a, b) => distance(a) - distance(b));
    let best: { x: number; z: number }[] | undefined;
    for (const to of candidates) {
        if (best && distance(to) >= best.length) break;
        const corners = plan(player.level, from, to);
        const end = corners.at(-1);
        if (!end || end.x !== to.x || end.z !== to.z) continue;
        const route = expandPath(from, corners);
        if (route.length && (!best || route.length < best.length)) best = route;
    }
    return best ? { target: best[Math.min(23, best.length - 1)]!, exit: best.at(-1)! } : null;
}

export async function recoverGuardian(s: Session, tele: NativeTeleport, p: { fatal: () => boolean; landingTail?: number }, budget = 500) {
    const start = s.tick();
    const state = () => s.sdk.getState();
    const client = s.client;
    const initial = state()?.player;
    const owner = (client as any).executeBotAction;
    const life = initial?.lifeId;
    const respawns = initial?.respawnCount ?? 0;
    const original = () => {
        const me = state()?.player;
        return (
            Number.isSafeInteger(life) &&
            hp(s) > 0 &&
            s.client === client &&
            (client as any).executeBotAction === owner &&
            typeof owner === 'function' &&
            !!me &&
            !me.isDead &&
            me.lifeId === life &&
            (me.respawnCount ?? 0) === respawns
        );
    };
    const over = () => p.fatal() || !original() || s.tick() - start >= budget;
    let exit: { x: number; z: number } | undefined;
    let player = state()?.player;
    if (!player || over()) return { ok: false, failure: 'guardian recovery life/session' };
    const tail = p.landingTail ?? 0;
    if (tail !== 0 && tail !== guardianSaraLandingTail()) throw Error('guardian unsupported landing settlement tail');
    while (!combatTeleportAllowed(player)) {
        if (over()) return { ok: false, failure: 'guardian extraction budget' };
        const walker = await sessionWalker(s);
        const pf = await import('../../../../vendor/rs-sdk/sdk/pathfinding');
        const at = player;
        const reach = clientReach(s.client, () => {
            const p = state()?.player;
            return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null;
        });
        const route = guardianExtractionStep(
            player,
            walker.plan,
            exit,
            (to) => pf.isTileWalkable(at.level, to.x, to.z),
            (to) => reach?.({ ...to, level: at.level }, { maxSteps: 4096 }) ?? null,
        );
        if (!route) return { ok: false, failure: `guardian legal extraction path unavailable from ${player.worldX},${player.worldZ} to ${exit?.x},${exit?.z}` };
        exit = route.exit;
        await guardianWalk(s, route.target, { fatal: over, stop: () => false }, Math.min(40, budget - (s.tick() - start)));
        player = state()?.player;
        if (!player) return { ok: false, failure: 'guardian extraction session' };
    }
    await guardianHeal(s, { fatal: over, stop: () => false });
    if (over()) return { ok: false, failure: 'guardian recovery budget before teleport' };
    const before = new Map(s.sdk.getInventory().map((i) => [i.id, s.sdk.getInventory().filter((j) => j.id === i.id).reduce((n, j) => n + j.count, 0)]));
    const xp = s.sdk.getSkillXp('Magic') ?? 0;
    const costs = Object.fromEntries(Object.entries(tele.runes).map(([id, n]) => [id, elementalRuneCost(Number(id), n, s.sdk.getEquipment(), true)]));
    if (Object.entries(costs).some(([id, n]) => (before.get(Number(id)) ?? 0) < n)) {
        return { ok: false, failure: 'guardian reserved escape runes missing' };
    }
    if (budget - (s.tick() - start) - tail < 2) return { ok: false, failure: 'guardian recovery cannot reserve native landing tail before payment' };
    const closeAt = s.tick();
    const closed = () => state()?.dialog?.isOpen === false && state()?.interface.isOpen === false && state()?.bank.isOpen === false;
    if (over()) return { ok: false, failure: 'guardian recovery owner/life before modal close' };
    await s.direct({ type: 'closeModal', reason: 'guardian bounded recovery modal retirement' });
    const closeBudget = Math.min(8, budget - (s.tick() - start) - tail - 1);
    if (closeBudget < 1) return { ok: false, failure: 'guardian modal settlement cannot reserve native landing tail' };
    if (!(await waitUntil(s, () => over() || (s.tick() > closeAt && closed()), { timeoutTicks: closeBudget })) || over() || s.tick() <= closeAt || !closed()) {
        return { ok: false, failure: 'guardian modal closure/owner settlement unobserved before payment' };
    }
    const landingBudget = Math.min(20, budget - (s.tick() - start) - tail);
    if (landingBudget < 1) return { ok: false, failure: 'guardian recovery cannot reserve native landing tail before payment' };
    if (over()) return { ok: false, failure: 'guardian recovery owner/life before payment' };
    await s.direct({ type: 'clickComponent', componentId: componentId(tele.component), reason: 'guardian legal bounded recovery' });
    const landed = () => {
        const at = state()?.player;
        return !!at && at.level === tele.to.level && Math.max(Math.abs(at.worldX - tele.to.x), Math.abs(at.worldZ - tele.to.z)) <= 2;
    };
    await waitUntil(s, () => landed() || over(), { timeoutTicks: landingBudget });
    const count = (id: number) => s.sdk.getInventory().filter((i) => i.id === id).reduce((n, i) => n + i.count, 0);
    const paid = Object.entries(costs).every(([id, n]) => (before.get(Number(id)) ?? 0) - count(Number(id)) === n);
    let tailSettled = tail === 0;
    if (tail && landed() && paid && !over()) {
        const snapshot = () => JSON.stringify([...s.sdk.getInventory(), ...s.sdk.getEquipment()].map((i) => ({ id: i.id, count: i.count, slot: i.slot })));
        const stock = snapshot();
        const tailAt = s.tick();
        const magicXp = s.sdk.getSkillXp('Magic');
        const original = () => {
            const me = state()?.player;
            return (
                !p.fatal() &&
                !!me &&
                !me.isDead &&
                me.lifeId === life &&
                (me.respawnCount ?? 0) === respawns &&
                (s.client as any).executeBotAction === owner &&
                s.sdk.getStateAge() <= 5000 &&
                hp(s) >= 35 &&
                landed() &&
                s.sdk.isPrayerActive(12) &&
                snapshot() === stock &&
                s.sdk.getSkillXp('Magic') === magicXp
            );
        };
        if (!original()) throw Error('guardian protected landing tail initial state changed');
        if (budget - (s.tick() - start) < tail) return { ok: false, failure: 'guardian landing tail budget unavailable' };
        await waitUntil(
            s,
            () => {
                if (!original()) throw Error('guardian protected landing tail life/owner/HP/stock/prayer changed');
                return s.tick() - tailAt >= tail;
            },
            { timeoutTicks: tail },
        );
        if (!original() || s.tick() - tailAt < tail) throw Error('guardian protected landing tail unconfirmed');
        tailSettled = true;
        console.log('GUARDIAN_SARA_LANDING_TAIL ' + JSON.stringify({ ticks: tail, hp: hp(s), protected: true }));
    }
    return {
        ok: landed() && !p.fatal() && paid && tailSettled && s.tick() - start <= budget && (s.sdk.getSkillXp('Magic') ?? 0) > xp,
        failure: landed() ? '' : 'guardian legal Varrock landing unobserved',
        ticks: s.tick() - start,
    };
}
