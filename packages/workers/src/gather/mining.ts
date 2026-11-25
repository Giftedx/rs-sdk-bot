// Consolidated mining module: native at-site rocks + rotation/knife, drop mining, progressive tiers,
// Varrock/Lumbridge ore & clay, Aubury Rune Essence, Lava Maze escorted Runite, and ground-loot pickup.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accountOf, countItems, finish, getWorld, openBot, randomEventsOf, serverFromEnv, sessionDied, settle } from '../../../core/src/bot';
import { validateBankRouteJob } from '../../../core/src/bank-trip';
import { bankCargo } from '../../../core/src/cargo';
import { depositObserved } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { type LootPolicy } from '../../../core/src/loot-policy';
import { componentId } from '../../../core/src/logout';
import { RosterFeed } from '../../../core/src/roster-feed';
import { resolveBotEnvPath } from '../../../core/src/practice-paths';
import { readLogoutProof } from '../../../core/src/session-lifecycle';
import { type TickSource, waitTicks, waitUntil } from '../../../core/src/ticks';
import { type PathDeps, goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import { gameDialAddress } from '../../../core/src/websocket-proxy';
import { parseConfigs } from '../../../knowledge/src/config';
import type { BotWorldState, NearbyLoc } from '../../../../vendor/rs-sdk/sdk/types';
import { runVisibleGroundLoot } from './loot';
import { MINING_SITES, runRotationMining, siteTiles } from './mining-rotation';
import { defaultApproach, defaultWalkTargetPersist } from './runtime';
import {
    MINING_PICKAXES_DESC,
    type ShopRetryGate,
    bestMiningPickaxe,
    crossedTierBoundary,
    executeShopToolPurchase,
    gearById,
    planToolShopUpgrade,
    readSkillLevels,
    reconcileBankTool,
    recordShopAttempt,
    sessionShopGate,
    sessionToolHooks,
    shouldAttemptShopUpgrade,
    tierBoundaryOf,
} from './tools';
import {
    type GatherExternalDeps,
    type GatherOutcome,
    type MiningDriver,
    type MiningProfile,
    type NormalizedGatherConfig,
    resolveSetting,
} from './types';

export type { MiningDriver, MiningProfile };
export {
    MINING_SITES,
    contentSites,
    firstRoll,
    oreLag,
    pathSteps,
    respawnTicks,
    runRotationMining,
    siteRocks,
    siteTiles,
    standTiles,
    type MiningAction,
    type RotationOptions,
    type RotationResult,
} from './mining-rotation';

const ROOT = resolve(import.meta.dir, '../../../..');
const CONTENT = resolve(ROOT, 'vendor/rs-sdk/server/content');

// ---------------------------------------------------------------------------
// 1. Native At-Site Mining (`mining:at-site`)
// ---------------------------------------------------------------------------
function contentPack(kind: string) {
    const text = readFileSync(resolve(CONTENT, 'pack', kind + '.pack'), 'utf8');
    const map = new Map<string, number>();
    let pos = 0;
    while (pos < text.length) {
        let end = text.indexOf('\n', pos);
        if (end < 0) end = text.length;
        const lineEnd = end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
        const eq = text.indexOf('=', pos);
        if (eq > pos && eq + 1 < lineEnd) {
            let digits = true;
            for (let i = pos; i < eq; i++) {
                const ch = text.charCodeAt(i);
                if (ch < 48 || ch > 57) { digits = false; break; }
            }
            if (digits) map.set(text.slice(eq + 1, lineEnd), Number(text.slice(pos, eq)));
        }
        pos = end + 1;
    }
    return map;
}

let cachedObjPack: Map<string, number> | undefined;
let cachedLocPack: Map<string, number> | undefined;
function objId(name: string) {
    cachedObjPack ??= contentPack('obj');
    const n = cachedObjPack.get(name);
    if (n === undefined) throw Error('native mining item missing ' + name);
    return n;
}
function locPack() {
    return (cachedLocPack ??= contentPack('loc'));
}
function parseMiningConfigs(file: string) {
    return parseConfigs(readFileSync(resolve(CONTENT, file), 'utf8'), file);
}

let cachedMiningProfiles: MiningProfile[] | undefined;
export function miningProfiles(): MiningProfile[] {
    if (cachedMiningProfiles) return cachedMiningProfiles;
    const loc = locPack();
    const gems = parseMiningConfigs('scripts/skill_mining/configs/gem_rock_table.dbrow').flatMap(b =>
        (b.props.data ?? []).filter(v => v.startsWith('drop,')).map(v => objId(v.split(',')[1]!)),
    );
    const profiles = parseMiningConfigs('scripts/skill_mining/configs/mine.dbrow').map(b => {
        const rows = b.props.data ?? [];
        const one = (key: string) => rows.find(v => v.startsWith(key + ','))?.slice(key.length + 1);
        const names = rows.filter(v => v.startsWith('rock,')).map(v => v.slice(5));
        const gemRock = b.name === 'gem_rock';
        const excludedRocks = names.filter(n => n.startsWith('macro_') || n === 'misc_dummy_coalrock1');
        const rocks = names
            .filter(n => !excludedRocks.includes(n))
            .map(n => {
                const value = loc.get(n);
                if (value === undefined) throw Error('native mining rock missing ' + n);
                return value;
            });
        return {
            name: b.name,
            rocks,
            products: gemRock ? gems : [objId(one('rock_output')!)],
            level: Number(one('rock_level')),
            respawn: Number(one('rock_respawnrate') ?? 0),
            gemRock,
            perfect: false,
            essence: b.name === 'rune_essence_table',
            excludedRocks,
        };
    });
    const gold = profiles.find(p => p.name === 'gold_rock_table')!;
    profiles.push({ ...gold, name: 'perfect_gold_rock_table', products: [objId('perfect_gold_ore')], perfect: true });
    cachedMiningProfiles = profiles;
    return cachedMiningProfiles;
}

export const incidentalMiningGems = ['uncut_diamond', 'uncut_ruby', 'uncut_emerald', 'uncut_sapphire'].map(objId);

let cachedPickaxeRateById: Map<number, { id: number; level: number; rate: number }> | undefined;
function pickaxeRateById() {
    if (cachedPickaxeRateById) return cachedPickaxeRateById;
    const list = parseMiningConfigs('scripts/skill_mining/configs/pickaxes.obj')
        .filter(b => /^(bronze|iron|steel|mithril|adamant|rune)_pickaxe$/.test(b.name))
        .map(b => ({
            id: objId(b.name),
            level: Number((b.props.param ?? []).find(v => v.startsWith('levelrequire,'))?.split(',')[1]),
            rate: Number((b.props.param ?? []).find(v => v.startsWith('mining_rate,'))?.split(',')[1]),
        }));
    cachedPickaxeRateById = new Map(list.map(p => [p.id, p]));
    return cachedPickaxeRateById;
}

export function eligiblePickaxe(s: {
    skills: readonly { name: string; level: number }[];
    inventory: readonly { id: number }[];
    equipment: readonly { id: number; slot: number }[];
}) {
    const level = s.skills.find(k => k.name === 'Mining')?.level ?? 0;
    const stock = [...s.inventory, ...s.equipment.filter(e => e.slot === 3)].map(i => ({ id: i.id, count: 1 }));
    const rec = bestMiningPickaxe(stock, { mining: level, attack: 1 });
    return rec.current ? pickaxeRateById().get(rec.current.item.id) : undefined;
}

export async function equipUsablePickaxeInPack(s: {
    sdk: {
        getSkill: (name: string) => { level: number; baseLevel?: number } | null | undefined;
        getInventory: () => readonly { id: number; name: string; count: number; slot?: number }[];
        getEquipment: () => readonly { id: number; slot: number }[];
    };
    bot: { equipItem: (item: any) => Promise<unknown> };
}) {
    const mining = s.sdk.getSkill('Mining')?.level ?? 1;
    const attack = s.sdk.getSkill('Attack')?.baseLevel ?? s.sdk.getSkill('Attack')?.level ?? 1;
    const inv = s.sdk.getInventory();
    const eq = s.sdk.getEquipment();
    const rec = bestMiningPickaxe([...inv, ...eq.filter(e => e.slot === 3).map(e => ({ id: e.id, count: 1 }))], {
        mining,
        attack,
    }).current;
    if (!rec || !rec.canWield || eq.some(e => e.slot === 3 && e.id === rec.item.id)) return false;
    const weapon = eq.find(e => e.slot === 3);
    if (weapon && !(MINING_PICKAXES_DESC as readonly number[]).includes(weapon.id)) return false;
    const item = inv.find(i => i.id === rec.item.id);
    if (!item) return false;
    await s.bot.equipItem(item);
    return s.sdk.getEquipment().some(e => e.slot === 3 && e.id === rec.item.id);
}

export function inPerfectMine(s: BotWorldState) {
    const p = s.player;
    return !!p && p.level === 0 && p.worldX >= 2736 && p.worldX <= 2740 && p.worldZ >= 9684 && p.worldZ <= 9693;
}

export function selectMiningRock(s: BotWorldState, p: MiningProfile): NearbyLoc | undefined {
    return s.nearbyLocs
        .filter(
            l =>
                p.rocks.includes(l.id) &&
                l.level === s.player?.level &&
                l.distance <= 2 &&
                l.reachable !== false &&
                l.optionsWithIndex.some(o => o.opIndex === 1 && /^mine$/i.test(o.text)) &&
                !s.nearbyPlayers.some(other => Math.max(Math.abs(other.x - l.x), Math.abs(other.z - l.z)) <= 2),
        )
        .sort((a, b) => a.distance - b.distance)[0];
}

const miningXp = (s: BotWorldState) => s.skills.find(k => k.name === 'Mining')?.experience ?? 0;
const miningHp = (s: BotWorldState) => s.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;
const miningStock = (s: BotWorldState) => {
    const result: Record<number, number> = {};
    for (const i of s.inventory) result[i.id] = (result[i.id] ?? 0) + i.count;
    return result;
};

export function miningEffect(
    p: MiningProfile,
    b: BotWorldState,
    a: BotWorldState,
): { kind: 'ore' | 'incidental'; id: number } | null {
    const before = miningStock(b);
    const after = miningStock(a);
    const keys = new Set([...Object.keys(before), ...Object.keys(after)].map(Number));
    const deltas = [...keys].map(id => ({ id, n: (after[id] ?? 0) - (before[id] ?? 0) })).filter(v => v.n !== 0);
    if (!deltas.length) return null;
    if (deltas.length !== 1 || deltas[0]!.n !== 1) throw Error('mining inventory effect does not reconcile');
    const id = deltas[0]!.id;
    if (p.products.includes(id) && miningXp(a) > miningXp(b)) return { kind: 'ore', id };
    if (p.products.includes(id) && miningXp(a) === miningXp(b)) return null;
    if (!p.gemRock && !p.essence && incidentalMiningGems.includes(id) && miningXp(a) === miningXp(b)) {
        return { kind: 'incidental', id };
    }
    throw Error('mining ore/gem and XP do not reconcile');
}

export async function runAtSiteMining(
    d: MiningDriver,
    p: MiningProfile,
    o: {
        maximum: number;
        cap: number;
        idleTicks: number;
        rotation?: Omit<import('./mining-rotation').RotationOptions, 'maximum' | 'cap' | 'idleTicks'>;
    },
) {
    if (![o.maximum, o.cap, o.idleTicks].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('invalid mining bounds');
    if (p.essence) throw Error('reuse gather-essence (mining:essence) for continuous essence mining');
    const initial = d.state();
    if (!initial?.player || miningHp(initial) < 1) throw Error('mining state unknown');
    if ((initial.skills.find(k => k.name === 'Mining')?.level ?? 0) < p.level) throw Error('native mining level short');
    if (!eligiblePickaxe(initial)) throw Error('native eligible owned pickaxe required');
    if (p.perfect !== inPerfectMine(initial) && p.rocks.some(id => miningProfiles().find(r => r.name === 'gold_rock_table')!.rocks.includes(id))) {
        throw Error('gold output differs inside Family Crest perfect mine; select exact profile');
    }
    if (o.rotation) {
        return runRotationMining(
            d,
            p,
            { ...o.rotation, maximum: o.maximum, cap: o.cap, idleTicks: o.idleTicks },
            eligiblePickaxe(initial)!.rate,
            incidentalMiningGems,
        );
    }
    const start = d.tick();
    let progress = start;
    let made = 0;
    let attempts = 0;
    let sideGems = 0;
    let active: string | undefined;
    const outputs: Record<number, number> = {};
    const equipment = JSON.stringify(
        initial.equipment.map(i => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot),
    );
    const state = () => {
        const s = d.state();
        if (!s?.player) throw Error('mining session ended');
        if (d.stop()) throw Error('mining stopped');
        if (d.tick() - start >= o.cap) throw Error('mining tick cap');
        if (s.player.isDead || s.player.lifeId !== initial.player!.lifeId || s.player.level !== initial.player!.level || miningHp(s) !== miningHp(initial)) {
            throw Error('mining health or life changed');
        }
        if (
            JSON.stringify(s.equipment.map(i => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot)) !== equipment ||
            !eligiblePickaxe(s)
        ) {
            throw Error('mining owned pickaxe/equipment changed');
        }
        return s;
    };
    while (made < o.maximum) {
        let before = state();
        if (d.tick() - progress >= o.idleTicks) throw Error('mining no useful ore progress');
        if (before.inventory.length >= 28) throw Error('mining pack full; retain ore for owned bank route');
        if (before.dialog?.isOpen || before.interface?.isOpen) {
            if (!d.clearModal) throw Error('mining modal blocks action');
            await d.clearModal();
            active = undefined;
            before = state();
        }
        const target = selectMiningRock(before, p);
        if (!target) {
            active = undefined;
            await d.step();
            continue;
        }
        const key = `${target.id}:${target.x}:${target.z}:${target.level}`;
        if (active !== key) {
            if (!(await d.mine(target))) throw Error('native Mine option refused');
            attempts++;
            active = key;
        }
        let effect: ReturnType<typeof miningEffect> = null;
        await d.wait(
            () => {
                const s = state();
                effect = miningEffect(p, before, s);
                return !!effect || !s.nearbyLocs.some(l => l.id === target.id && l.x === target.x && l.z === target.z && l.level === target.level);
            },
            Math.min(40, o.idleTicks - (d.tick() - progress), o.cap - (d.tick() - start)),
        );
        let after = state();
        effect = miningEffect(p, before, after);
        if (!effect && !after.nearbyLocs.some(l => l.id === target.id && l.x === target.x && l.z === target.z && l.level === target.level)) {
            await d.step();
            after = state();
            effect = miningEffect(p, before, after);
        }
        if (!effect && (JSON.stringify(miningStock(before)) !== JSON.stringify(miningStock(after)) || miningXp(after) !== miningXp(before))) {
            throw Error('mining item/XP publication did not settle');
        }
        if (effect) {
            outputs[effect.id] = (outputs[effect.id] ?? 0) + 1;
            if (effect.kind === 'ore') {
                made++;
                progress = d.tick();
                active = undefined;
            } else {
                sideGems++;
            }
        }
        if (!after.nearbyLocs.some(l => l.id === target.id && l.x === target.x && l.z === target.z && l.level === target.level)) {
            active = undefined;
        }
        if (made < o.maximum) await d.step();
    }
    return { made, sideGems, attempts, outputs, xp: miningXp(state()) - miningXp(initial), ticks: d.tick() - start, banked: 0 };
}

// ---------------------------------------------------------------------------
// 2. Drop Mining & Progressive Mining (`mining:drop`, `mining:progressive`)
// ---------------------------------------------------------------------------
export interface MiningDropJob {
    maximum: number;
    cap: number;
    idleTicks: number;
    keep: readonly number[];
}
export interface MiningDropDriver extends MiningDriver {
    drop: (slot: number) => Promise<boolean>;
}

export async function runDropMining(d: MiningDropDriver, p: MiningProfile, o: MiningDropJob) {
    if (
        ![o.maximum, o.cap, o.idleTicks].every(n => Number.isSafeInteger(n) && n > 0) ||
        o.maximum > 100000 ||
        o.cap > 100000 ||
        o.keep.some(n => !Number.isSafeInteger(n) || n < 0) ||
        new Set(o.keep).size !== o.keep.length
    ) {
        throw Error('invalid finite mining drop order');
    }
    const initial = d.state();
    if (!initial?.player) throw Error('mining drop state unknown');
    const pick = eligiblePickaxe(initial);
    if (!pick || (initial.inventory.some(i => i.id === pick.id) && !o.keep.includes(pick.id))) {
        throw Error('keep the owned inventory pickaxe');
    }
    const life = initial.player.lifeId;
    const level = initial.player.level;
    const hp = initial.skills.find(k => k.name === 'Hitpoints')?.level;
    const kit = JSON.stringify(initial.equipment);
    const start = d.tick();
    const before = miningStock(initial);
    const dropped: Record<number, number> = {};
    const outputs: Record<number, number> = {};
    let made = 0;
    let xp = 0;
    let sideGems = 0;
    let attempts = 0;
    let progress = start;
    const state = () => {
        const s = d.state();
        if (
            d.stop() ||
            !s?.player ||
            s.player.isDead ||
            s.player.lifeId !== life ||
            s.player.level !== level ||
            s.skills.find(k => k.name === 'Hitpoints')?.level !== hp ||
            JSON.stringify(s.equipment) !== kit
        ) {
            throw Error('mining drop stopped or life/kit changed');
        }
        if (d.tick() - start >= o.cap) throw Error('mining drop cap');
        return s;
    };
    while (made < o.maximum) {
        let s = state();
        if (d.tick() - progress >= o.idleTicks) throw Error('mining drop no useful ore progress');
        if (s.inventory.length >= 27) {
            const discard = s.inventory.filter(i => !o.keep.includes(i.id)).map(i => ({ id: i.id, slot: i.slot, count: i.count }));
            if (!discard.length) throw Error('mining drop pack contains only retained items');
            for (const row of discard) {
                s = state();
                const item = s.inventory.find(i => i.slot === row.slot && i.id === row.id && i.count === row.count);
                const custom = item?.optionsWithIndex?.filter(v => v.opIndex === 5) ?? [];
                if (!item || custom.length > 1 || custom.some(v => !/^drop$/i.test(v.text))) {
                    throw Error('fresh native Drop slot required; custom fifth action refused');
                }
                const b = miningStock(s);
                let accepted = false;
                try {
                    accepted = await d.drop(item.slot);
                } catch {}
                const exact = () => {
                    const a = miningStock(state());
                    return [...new Set([...Object.keys(a), ...Object.keys(b)].map(Number))].every(
                        id => (a[id] ?? 0) - (b[id] ?? 0) === (id === row.id ? -row.count : 0),
                    );
                };
                await d.wait(exact, Math.min(8, o.cap - (d.tick() - start)));
                if (!exact()) throw Error('native drop outcome unconfirmed' + (accepted ? '' : ' after refused/lost reply'));
                dropped[row.id] = (dropped[row.id] ?? 0) + row.count;
            }
        }
        const remaining = o.cap - (d.tick() - start);
        if (remaining < 1) throw Error('mining drop cap');
        const result = await runAtSiteMining(
            { ...d, stop: () => d.stop() || d.tick() - start >= o.cap },
            p,
            { maximum: 1, cap: remaining, idleTicks: Math.min(o.idleTicks - (d.tick() - progress), remaining) },
        );
        made += result.made;
        xp += result.xp;
        sideGems += result.sideGems;
        attempts += result.attempts;
        for (const [id, n] of Object.entries(result.outputs)) outputs[Number(id)] = (outputs[Number(id)] ?? 0) + n;
        progress = d.tick();
    }
    const after = miningStock(state());
    for (const id of new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(outputs), ...Object.keys(dropped)].map(Number))) {
        if ((after[id] ?? 0) - (before[id] ?? 0) !== (outputs[id] ?? 0) - (dropped[id] ?? 0)) {
            throw Error('mining drop final asset audit');
        }
    }
    return { made, xp, sideGems, attempts, outputs, dropped, banked: 0, ticks: d.tick() - start };
}

const PROGRESSIVE_TIERS = [
    'tin_rock_table',
    'iron_rock_table',
    'coal_rock_table',
    'gold_rock_table',
    'mithril_rock_table',
    'adamantite_rock_table',
    'runite_rock_table',
] as const;

type ProgTile = { x: number; z: number; level: number };
export interface ProgressiveMiningJob {
    maximum: number;
    batch: number;
    cap: number;
    returnTicks: number;
    travelTicks: number;
    members: boolean;
    mode: 'bank' | 'drop';
    keep?: number[];
    routes: { profile: string; bank: ProgTile; site: ProgTile; tool: number }[];
}

export function progressiveMiningProfile(level: number) {
    if (!Number.isSafeInteger(level) || level < 1 || level > 99) throw Error('observed native Mining level required');
    const profiles = miningProfiles();
    return PROGRESSIVE_TIERS.map(n => profiles.find(p => p.name === n)!)
        .filter(p => p.level <= level)
        .sort((a, b) => b.level - a.level)[0]!;
}

export async function runProgressiveMining(
    s: Session,
    j: ProgressiveMiningJob,
    stop: () => boolean = () => false,
    deps?: { runBankJob?: GatherExternalDeps['runBankJob'] },
) {
    if (
        !['bank', 'drop'].includes(j.mode) ||
        ![j.maximum, j.batch, j.cap, j.returnTicks, j.travelTicks].every(n => Number.isSafeInteger(n) && n > 0) ||
        j.maximum > 100000 ||
        j.cap > 100000 ||
        j.travelTicks > j.cap ||
        j.cap <= j.returnTicks ||
        typeof j.members !== 'boolean' ||
        !j.routes.length ||
        new Set(j.routes.map(r => r.profile)).size !== j.routes.length
    ) {
        throw Error('invalid finite progressive mining plan');
    }
    for (const r of j.routes) {
        if (!PROGRESSIVE_TIERS.includes(r.profile as any) || !Number.isSafeInteger(r.tool) || r.tool < 0) {
            throw Error('invalid progressive native profile/tool');
        }
        validateBankRouteJob({
            family: 'mining',
            recipe: r.profile,
            target: 1,
            batch: 1,
            cap: j.cap,
            returnTicks: j.returnTicks,
            members: j.members,
            bank: r.bank,
            site: r.site,
        });
    }
    const first = s.sdk.getState()?.player;
    const hp = s.sdk.getSkill('Hitpoints')?.level;
    const start = s.tick();
    if (!first || !hp) throw Error('progressive mining life unknown');
    const life = first.lifeId;
    const respawns = first.respawnCount;
    const halt = () => {
        const p = s.sdk.getState()?.player;
        return (
            stop() ||
            existsSync('.practice/stop-all') ||
            existsSync(`.practice/stop-${s.name}`) ||
            !p ||
            p.isDead ||
            p.lifeId !== life ||
            p.respawnCount !== respawns ||
            s.sdk.getSkill('Hitpoints')?.level !== hp ||
            s.tick() - start >= j.cap
        );
    };
    const receipts: any[] = [];
    let made = 0;
    while (made < j.maximum) {
        if (halt()) throw Error('progressive mining stopped or life/HP/budget changed');
        const profile = progressiveMiningProfile(s.sdk.getSkill('Mining')?.level ?? 0);
        const route = j.routes.find(r => r.profile === profile.name);
        if (!route) throw Error('declare a native route for unlocked ' + profile.name);
        const travelRoom = j.cap - (s.tick() - start) - j.returnTicks;
        if (travelRoom < 1) throw Error('progressive mining return budget');
        const destination = j.mode === 'bank' ? route.bank : route.site;
        const travel = await walkPath(await sessionWalker(s), [{ ...destination, tol: j.mode === 'bank' ? 2 : 0 }], {
            maxTicks: Math.min(j.travelTicks, travelRoom),
            stop: halt,
        });
        if (!travel.ok || halt()) throw Error('progressive native route unavailable ' + travel.detail);
        const n = Math.min(j.batch, j.maximum - made);
        const cap = j.cap - (s.tick() - start);
        if (cap <= j.returnTicks) throw Error('progressive mining return budget');
        if (j.mode === 'bank') {
            if (!deps?.runBankJob) throw Error('progressive bank mining requires deps.runBankJob');
            const r = await deps.runBankJob(
                s,
                {
                    family: 'mining',
                    recipe: profile.name,
                    target: n,
                    batch: n,
                    cap,
                    returnTicks: j.returnTicks,
                    members: j.members,
                    bank: route.bank,
                    site: route.site,
                    tool: route.tool,
                },
                halt,
            );
            receipts.push({ profile: profile.name, ...r });
            if (!r.ok) throw Error('progressive bank mining ' + r.failure);
            made += r.completed;
        } else {
            const r = await runDropMining(
                {
                    state: () => s.sdk.getState(),
                    tick: () => s.tick(),
                    stop: halt,
                    mine: async l => (await s.sdk.sendInteractLoc(l.x, l.z, l.id, 1)).success,
                    drop: async slot => (await s.sdk.sendDropItem(slot)).success,
                    wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
                    step: () => waitTicks(s, 1),
                    clearModal: async () => {
                        await s.sdk.sendCloseModal();
                    },
                },
                profile,
                { maximum: n, cap: cap - j.returnTicks, idleTicks: Math.min(300, cap - j.returnTicks), keep: j.keep ?? [] },
            );
            receipts.push({ profile: profile.name, ...r });
            made += r.made;
        }
    }
    return {
        ok: !halt() && made === j.maximum,
        made,
        mode: j.mode,
        receipts,
        ticks: s.tick() - start,
        selection: 'highest unlocked native donor tier; explicit native routes; reselect after each finite batch',
    };
}

// ---------------------------------------------------------------------------
// 3. Varrock / Lumbridge Ore & Clay Mining (`mining:ore`)
// ---------------------------------------------------------------------------
const ROCK_IDS = { copper: [2090, 2091], tin: [2094, 2095], iron: [2092, 2093] };
const ORE_AREAS = {
    mixed: { mine: { x: 3286, z: 3368 }, bank: { x: 3253, z: 3420 } },
    clay: { mine: { x: 3180, z: 3372 }, bank: { x: 3185, z: 3436 } },
};

export function mixedOreCombatProblem(combat: unknown): string | null {
    return Number.isSafeInteger(combat) && (combat as number) >= 13
        ? null
        : 'no ore progress: mixed mine requires combat13 above the level6 rat aggression threshold';
}

export function selectRock(
    rocks: readonly NearbyLoc[],
    level: number,
    attempt: number,
    floor: number,
    profile = 'mixed',
    players: readonly { x: number; z: number }[] = [],
): NearbyLoc | undefined {
    if (profile === 'clay') {
        return rocks
            .filter(
                l =>
                    l.level === floor &&
                    l.reachable !== false &&
                    [2108, 2109].includes(l.id) &&
                    l.optionsWithIndex.some(o => /^mine$/i.test(o.text)),
            )
            .sort((a, b) => a.distance - b.distance)[0];
    }
    const kinds = level >= 15 ? (['copper', 'tin', 'iron'] as const) : (['copper', 'tin'] as const);
    const candidates: { rock: NearbyLoc; pressure: number; priority: number }[] = [];
    for (let n = 0; n < kinds.length; n++) {
        const ids: readonly number[] = ROCK_IDS[kinds[(attempt + n) % kinds.length]!];
        for (const rock of rocks.filter(
            l => l.level === floor && l.reachable !== false && ids.includes(l.id) && l.optionsWithIndex.some(o => /^mine$/i.test(o.text)),
        )) {
            candidates.push({
                rock,
                priority: n,
                pressure: players.filter(p => Math.max(Math.abs(p.x - rock.x), Math.abs(p.z - rock.z)) <= 1).length,
            });
        }
    }
    return candidates.sort((a, b) => a.pressure - b.pressure || a.priority - b.priority || a.rock.distance - b.rock.distance)[0]?.rock;
}

export async function mineRock(s: Session, rock: NearbyLoc, over: () => boolean, timeoutTicks = 60, product = /ore$/i) {
    const ores = () => s.sdk.getInventory().filter(i => product.test(i.name)).reduce((n, i) => n + i.count, 0);
    const before = ores();
    const xp0 = s.sdk.getSkillXp('mining') ?? 0;
    const start = s.tick();
    const cursor = Math.max(-1, ...(s.sdk.getState()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
    const refusal = () =>
        s.sdk.getState()?.gameMessages.find(
            m =>
                (m.observationId ?? m.tick) > cursor &&
                /need a mining level|need a pickaxe|do not have a pickaxe|can't reach|cannot reach|no ore currently/i.test(m.text),
        )?.text;
    const active = () =>
        s.sdk
            .getState()
            ?.nearbyLocs.some(
                l =>
                    l.x === rock.x &&
                    l.z === rock.z &&
                    l.level === rock.level &&
                    l.id === rock.id &&
                    l.optionsWithIndex.some(o => /^mine$/i.test(o.text)),
            );
    const progress = () => ores() > before && (s.sdk.getSkillXp('mining') ?? 0) > xp0;
    if (over() || !active()) return { ore: 0, xp: 0, ticks: 0, reason: 'rock-gone' };
    const option = rock.optionsWithIndex.find(o => /^mine$/i.test(o.text))!;
    const windowOpen = () => !!(s.sdk.getState()?.dialog?.isOpen || s.sdk.getState()?.modalOpen);
    let sent = await s.sdk.sendInteractLoc(rock.x, rock.z, rock.id, option.opIndex);
    for (let closes = 0; sent.success; closes++) {
        await waitUntil(s, () => over() || progress() || !!refusal() || !active() || windowOpen(), {
            timeoutTicks: Math.max(1, timeoutTicks - (s.tick() - start)),
        });
        if (over() || progress() || refusal() || !active() || !windowOpen() || closes >= 3 || s.tick() - start >= timeoutTicks) break;
        await s.direct({ type: 'closeModal', reason: 'SDK' });
        sent = await s.sdk.sendInteractLoc(rock.x, rock.z, rock.id, option.opIndex);
    }
    if (sent.success && !progress() && !over() && !active()) await waitTicks(s, 1);
    const ore = ores() - before;
    const xp = (s.sdk.getSkillXp('mining') ?? 0) - xp0;
    return {
        ore,
        xp,
        ticks: s.tick() - start,
        reason: progress()
            ? 'mined'
            : !sent.success
              ? `rejected:${sent.reason ?? sent.message}`
              : refusal() ?? (!active() ? 'rock-gone' : over() ? 'stopped' : 'timeout'),
    };
}

export function oreStalled(ticksWaited: number, limit: number): boolean {
    return ticksWaited >= limit;
}

export function selectActiveOrePickaxe(s: Session, extra: readonly { id: number; count: number }[] = []) {
    const mining = s.sdk.getSkill('Mining')?.level ?? 1;
    const attack = s.sdk.getSkill('Attack')?.baseLevel ?? s.sdk.getSkill('Attack')?.level ?? 1;
    const eq = (s.sdk.getEquipment?.() ?? s.sdk.getState()?.equipment ?? []).filter(e => e.slot === 3);
    return bestMiningPickaxe([...s.sdk.getInventory(), ...eq, ...extra], { mining, attack });
}

const oreShopGates = new WeakMap<object, ShopRetryGate>();

export async function reconcileOrePickaxeAtBank(
    s: Session,
    options: {
        bankSpot: { x: number; z: number; level?: number };
        stop: () => boolean;
        allowShop?: boolean;
        refusedWields?: Set<number>;
        walkTo?: (spot: { x: number; z: number; level?: number }) => Promise<boolean>;
        shopGate?: ShopRetryGate;
        deps?: GatherExternalDeps;
    },
): Promise<{ activeId: number | null; worn: boolean; bought?: number }> {
    const openBank = async () => {
        if (!s.sdk.getState()?.bank?.isOpen) await s.bot.openBank();
    };
    const hooks = sessionToolHooks(s, {
        openBank,
        walkTo:
            options.walkTo ??
            (async spot =>
                (
                    await defaultWalkTargetPersist(
                        s,
                        { x: spot.x, z: spot.z, level: spot.level ?? 0 },
                        4,
                        options.deps,
                        t => defaultApproach(s, t, options.stop, options.deps),
                    )
                ).ok),
        waitUntil: (pred, timeoutTicks) => waitUntil(s, pred, { timeoutTicks }),
        stop: options.stop,
    });
    await openBank();
    if (!(await waitUntil(s, () => options.stop() || !!s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 10 })) || options.stop()) {
        return { activeId: selectActiveOrePickaxe(s).current?.item.id ?? null, worn: false };
    }

    const wornItems = () => s.sdk.getEquipment?.() ?? s.sdk.getState()?.equipment ?? [];
    const bankItems = s.bankObservation?.()?.items ?? s.sdk.getState()?.bank?.items ?? [];
    const levels = {
        mining: s.sdk.getSkill('Mining')?.level ?? 1,
        attack: s.sdk.getSkill('Attack')?.baseLevel ?? s.sdk.getSkill('Attack')?.level ?? 1,
    };
    let bought: number | undefined;
    const miningTier = tierBoundaryOf(levels.mining, [1, 6, 21, 31, 41]);
    const shopGate = sessionShopGate(oreShopGates, s, options.shopGate);

    if (options.allowShop !== false && shouldAttemptShopUpgrade(shopGate, miningTier, s.tick?.() ?? 0)) {
        const stock = [...s.sdk.getInventory(), ...wornItems().filter(e => e.slot === 3), ...bankItems];
        const totalCoins = stock.filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
        const shopPlan = planToolShopUpgrade('mining-pickaxe', stock, totalCoins, levels, {
            allowedShops: ['pickaxeshop'],
            onlyWhenStarterOrMissing: false,
        });
        if (shopPlan && !options.stop()) {
            const res = await executeShopToolPurchase(hooks, {
                targetId: shopPlan.target.id,
                shop: 'pickaxeshop',
                maxBudget: shopPlan.coinBudgetNeeded,
                returnBankSpot: options.bankSpot,
            });
            recordShopAttempt(shopGate, miningTier, s.tick?.() ?? 0, res.bought);
            if (res.bought) {
                bought = res.id;
                console.log(`ORE_SHOP_PICKAXE ${JSON.stringify(res)}`);
                await openBank();
                await waitUntil(s, () => options.stop() || !!s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 10 });
                const spareCoins = s.sdk.getInventory().find(i => i.id === 995);
                if (spareCoins && !options.stop()) await depositObserved(s, spareCoins);
            }
        }
    }

    const latestBank = s.bankObservation?.()?.items ?? s.sdk.getState()?.bank?.items ?? [];
    const rec = bestMiningPickaxe([...s.sdk.getInventory(), ...wornItems().filter(e => e.slot === 3), ...latestBank], levels);
    if (!rec.current) return { activeId: null, worn: false, bought };

    const res = await reconcileBankTool(hooks, {
        targetId: rec.current.item.id,
        canWield: rec.current.canWield,
        toolGroupIds: MINING_PICKAXES_DESC,
        refusedWields: options.refusedWields,
    });
    return { activeId: res.activeId, worn: res.worn, bought };
}

export function oreDamageEvidence(st: any, before: number, after: number, tick: number) {
    if (before <= 0 || after <= 0 || after >= before) return;
    const p = st?.player;
    return {
        tick,
        hpBefore: before,
        hpAfter: after,
        pos: p ? [p.worldX, p.worldZ, p.level] : null,
        attacker: 'unknown',
        eventAttribution: 'SDK source indices are facing-entity heuristics, not attacker proof',
        combat: p?.combat ?? null,
        npcs: (st?.nearbyNpcs ?? [])
            .filter((n: any) => n.distance <= 12)
            .slice(0, 16)
            .map((n: any) => ({
                id: n.id,
                index: n.index,
                name: n.name,
                x: n.tileX ?? n.x,
                z: n.tileZ ?? n.z,
                distance: n.distance,
                targetIndex: n.targetIndex,
                inCombat: n.inCombat,
            })),
        players: (st?.nearbyPlayers ?? [])
            .filter((n: any) => n.distance <= 12)
            .slice(0, 16)
            .map((n: any) => ({
                index: n.index,
                name: n.name,
                x: n.x,
                z: n.z,
                distance: n.distance,
                targetType: n.combatTargetType ?? null,
                targetIndex: n.combatTargetIndex ?? null,
                inCombat: n.inCombat ?? null,
            })),
        events: (st?.combatEvents ?? [])
            .filter((e: any) => e.type === 'damage_taken' && e.tick >= tick - 2)
            .map((e: any) => ({
                tick: e.tick,
                observationId: e.observationId,
                damage: e.damage,
                sourceType: e.sourceType,
                sourceIndex: e.sourceIndex,
            })),
    };
}

export function watchOreDamage(s: Session, onDamage: (e: NonNullable<ReturnType<typeof oreDamageEvidence>>) => void) {
    let previous = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    let seen = false;
    return s.onTick(() => {
        const hp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
        const e = oreDamageEvidence(s.sdk.getState(), previous, hp, s.tick());
        if (hp > 0) previous = hp;
        if (e && !seen) {
            seen = true;
            onDamage(e);
        }
    });
}

export async function retreatOre(
    s: Session,
    bank: { x: number; z: number },
    product: RegExp,
    aborted: () => boolean,
    walk?: (stop: () => boolean) => Promise<boolean>,
) {
    const start = s.tick();
    const expired = () => aborted() || s.tick() - start >= 200;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const inv = () => s.sdk.getInventory();
    const first = s.sdk.getState()?.player;
    const dead = () => {
        const p = s.sdk.getState()?.player;
        return (
            hp() <= 0 ||
            (!!p &&
                (p.isDead ||
                    (p.respawnCount ?? 0) > (first?.respawnCount ?? 0) ||
                    (first?.lifeId !== undefined && p.lifeId !== first.lifeId)))
        );
    };
    const failure = (why: string) => new Error(`${dead() ? 'died=true ' : ''}no ore progress: ${why}`);
    const count = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const foods: { id: number; count: number; hpBefore: number; hpAfter: number }[] = [];
    if (expired() || dead()) throw failure('safety cleanup unavailable after death/session end');
    if (s.sdk.getState()?.dialog?.isOpen || s.sdk.getState()?.modalOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
    for (let attempt = 0; attempt < 2 && !expired() && hp() < (s.sdk.getSkill('Hitpoints')?.baseLevel ?? hp()); attempt++) {
        const food = inv().find(i => [315, 2309, 333, 329].includes(i.id) && i.optionsWithIndex?.some(o => /^eat$/i.test(o.text)));
        if (!food) break;
        const before = count(food.id);
        const hpBefore = hp();
        const option = food.optionsWithIndex.find(o => /^eat$/i.test(o.text))!;
        await s.direct({ type: 'useInventoryItem', slot: food.slot, optionIndex: option.opIndex, reason: 'SDK' });
        await waitUntil(s, () => count(food.id) < before || expired(), { timeoutTicks: 3 });
        const used = before - count(food.id);
        if (used > 0) {
            foods.push({ id: food.id, count: used, hpBefore, hpAfter: hp() });
            break;
        }
    }
    if (expired() || dead()) throw failure('safety cleanup ended before retreat');
    const arrived = walk ? await walk(expired) : (await walkPath(await sessionWalker(s), [{ ...bank, tol: 2 }], { maxTicks: 180, stop: expired })).ok;
    if (!arrived || expired() || dead()) throw failure('bounded safety retreat failed');
    if (!(await s.bot.openBank()).success) throw failure('safety bank unavailable');
    try {
        await waitTicks(s, 1);
        const held = () => inv().filter(i => product.test(i.name)).reduce((n, i) => n + i.count, 0);
        const banked = () => s.sdk.getState()?.bank?.items.filter(i => product.test(i.name)).reduce((n, i) => n + i.count, 0) ?? 0;
        const before = held();
        const stock = banked();
        for (const id of new Set(inv().filter(i => product.test(i.name)).map(i => i.id))) {
            if (expired() || dead()) throw failure('safety bank deadline');
            await s.bot.depositItem(inv().find(i => i.id === id)!, -1);
        }
        await waitTicks(s, 1);
        if (held() !== 0 || banked() - stock !== before || dead()) throw failure('safety deposit not conserved');
        const p = s.sdk.getState()?.player;
        return { ok: true, banked: before, held: held(), foods, hp: hp(), ticks: s.tick() - start, pos: p ? [p.worldX, p.worldZ, p.level] : null };
    } finally {
        await s.bot.closeBank();
    }
}

async function runOreGathererSession(
    s: Session,
    cfg: NormalizedGatherConfig,
    stopState: () => string,
): Promise<GatherOutcome> {
    const PROFILE = cfg.spot ?? resolveSetting(cfg, 'ORE_PROFILE') ?? 'mixed';
    if (!['mixed', 'clay'].includes(PROFILE)) throw new Error('invalid ORE_PROFILE');
    const ORE = PROFILE === 'clay' ? /^clay$/i : /ore$/i;
    const { mine: MINE_SPOT, bank: BANK_SPOT } = ORE_AREAS[PROFILE as keyof typeof ORE_AREAS];
    const CAP = cfg.target?.capTicks ?? Number(cfg.args[0] ?? resolveSetting(cfg, 'CAP') ?? 15000);
    const BANK_AT = Number(cfg.args[1] ?? resolveSetting(cfg, 'BANK_AT') ?? 27);
    const NO_ORE_TICKS = Number(resolveSetting(cfg, 'NO_ORE_TICKS') ?? 120);
    if (!Number.isSafeInteger(NO_ORE_TICKS) || NO_ORE_TICKS < 1) throw new Error('invalid NO_ORE_TICKS');

    let damage: ReturnType<typeof oreDamageEvidence>;
    const offDamage = watchOreDamage(s, e => {
        damage = e;
        console.log('ORE_DAMAGE ' + JSON.stringify(e));
    });
    let safetyStarted = false;
    let cleanup: ((reason: string) => Promise<GatherOutcome>) | undefined;
    let off = () => {};
    try {
        if (cfg.deps?.leaveRuneStarter) {
            await cfg.deps.leaveRuneStarter(s, () => !!stopState() || !!damage);
        }
        await waitTicks(s, 3);
        const pos = () => s.sdk.getState()?.player;
        const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
        const oreCount = () => countItems(s, ORE);
        const freeSpace = () => 28 - s.sdk.getInventory().length;
        const t0 = s.tick();
        const used = () => s.tick() - t0;
        let ended = false;
        let died = false;
        const life = pos()?.lifeId;
        const respawns = pos()?.respawnCount ?? 0;
        void s.ended.then(() => {
            ended = true;
        });
        const over = () => used() >= CAP || ended || died || !!damage || !!stopState();
        const hp0 = hp();
        let hpMin = hp0;
        off = s.onTick(() => {
            if (hp0 > 0) hpMin = Math.min(hpMin, hp());
            const p = pos();
            if (p?.isDead || (p?.respawnCount ?? 0) > respawns || (life !== undefined && (p?.lifeId ?? life) !== life)) died = true;
        });

        let oreWaitTicks = 0;
        let stopReason = 'cap';
        const initialOre = oreCount();
        const xp0 = s.sdk.getSkillXp('mining') ?? 0;
        let mined = 0;
        let banked = 0;
        let bankTrips = 0;
        let walkTicks = 0;
        let tries = 0;
        const counters = () => `mined=${mined} banked=${banked} held=${oreCount()} bankTrips=${bankTrips} walkTicks=${walkTicks} hpMin=${hpMin}`;
        const walk = async (x: number, z: number, tol = 2): Promise<boolean> => {
            const a = s.tick();
            for (let i = 0; i < 3 && !over(); i++) {
                const p = pos();
                if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
                const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop: over });
                if (!r.ok) {
                    console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                    await waitTicks(s, 1);
                }
            }
            walkTicks += s.tick() - a;
            const p = pos();
            return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
        };
        const refusedPickWields = new Set<number>();
        let toolLevels = readSkillLevels(s.sdk);
        const travel = async (destination: 'bank' | 'mine') => {
            const p = destination === 'bank' ? BANK_SPOT : MINE_SPOT;
            return walk(p.x, p.z, destination === 'bank' ? 2 : 3);
        };
        const bank = async (forceToolCheck = false) => {
            const n = oreCount();
            if (n === 0 && !forceToolCheck) return;
            if (!(await travel('bank'))) return;
            if (damage || stopState() || ended || died) return;
            const b = await s.bot.openBank();
            if (!b.success) {
                console.log(`WARN openBank failed: ${b.message}`);
                await waitTicks(s, 2);
                return;
            }
            if (n > 0) {
                for (const id of new Set(s.sdk.getInventory().filter(i => ORE.test(i.name)).map(i => i.id))) {
                    const item = s.sdk.getInventory().find(i => i.id === id);
                    if (item) await s.bot.depositItem(item, -1);
                }
                await waitTicks(s, 1);
                const after = oreCount();
                banked += n - after;
                bankTrips++;
                if (!over()) await bankCargo(s, [ORE], 0, { stopped: over });
            }
            if (!over()) {
                await reconcileOrePickaxeAtBank(s, {
                    bankSpot: BANK_SPOT,
                    stop: over,
                    refusedWields: refusedPickWields,
                    deps: cfg.deps,
                });
            }
            await s.bot.closeInterface();
            await waitTicks(s, 1);
            console.log(`MILESTONE bank t=${used()} banked=${banked} totalMined=${mined}`);
        };
        const safetyExit = async (reason: string): Promise<GatherOutcome> => {
            safetyStarted = true;
            offDamage();
            if (died || stopState() === 'died') {
                off();
                const line = `died=true ${counters()} stop=safety`;
                return { ok: false, kind: 'died', detail: line, delta: { elapsedTicks: used() }, recoverable: true, resultLine: line };
            }
            const recovered = await retreatOre(s, BANK_SPOT, ORE, () => ended || died);
            banked += recovered.banked;
            console.log('ORE_RECOVERY ' + JSON.stringify({ ...recovered, reason, damage: damage ?? null, initialOre, mined, hpMin }));
            off();
            const line = `no ore progress: ${reason}; mining blocked after safety cleanup ${counters()} recovered=${recovered.banked} stop=safety`;
            return { ok: false, kind: 'failed', detail: line, delta: { elapsedTicks: used() }, recoverable: true, resultLine: line };
        };
        cleanup = safetyExit;

        console.log(`START ore gatherer ${s.name} at=${pos()?.worldX},${pos()?.worldZ}`);
        const pickLine = () => {
            const worn = (s.sdk.getEquipment?.() ?? s.sdk.getState()?.equipment ?? []).find(
                e => e.slot === 3 && (MINING_PICKAXES_DESC as readonly number[]).includes(e.id),
            );
            return `pick=${worn?.id ?? selectActiveOrePickaxe(s).current?.item.id ?? 0} pickWorn=${!!worn}`;
        };
        const maxTrips = cfg.target?.trips ?? Number(resolveSetting(cfg, 'MAX_TRIPS') ?? Infinity);
        if (damage || stopState() || hp() < (s.sdk.getSkill('Hitpoints')?.baseLevel ?? hp()) || maxTrips === 0) {
            return safetyExit(damage ? 'damage' : stopState() || 'owned-load recovery');
        }
        if (PROFILE === 'mixed') {
            const problem = mixedOreCombatProblem(pos()?.combatLevel);
            if (problem) throw Error(problem);
        }
        if ((pos()?.worldZ ?? 0) < 3330 && !selectActiveOrePickaxe(s).current) {
            await walk(3222, 3218, 3);
            for (let i = 0; i < 8 && countItems(s, /^coins$/i) < 2; i++) {
                if (hp() < 5) throw new Error('low HP during pickaxe bootstrap');
                await s.bot.pickpocketNpc(/^man$/i);
            }
            await walk(3231, 3203, 2);
            const shop = await s.bot.openShop(/^bob$/i);
            if (!shop.success) throw new Error(`Bob bootstrap: ${shop.message}`);
            const buy = await s.bot.buyFromShop(/^bronze pickaxe$/i, 1);
            await s.bot.closeShop();
            if (!buy.success) throw new Error(`bronze pickaxe bootstrap: ${buy.message}`);
            console.log(`MILESTONE pickaxe bootstrap t=${used()} hp=${hp()}`);
        }
        if ((pos()?.worldZ ?? 0) < 3330) {
            for (const [x, z] of [
                [3242, 3248],
                [3255, 3295],
                [3255, 3330],
                [3285, 3348],
            ]) {
                if (!(await walk(x!, z!, 3))) throw new Error(`cannot reach safe mine approach ${x},${z}`);
            }
        }
        const initialPick = selectActiveOrePickaxe(s).current;
        const atMineNow = !!pos() && Math.max(Math.abs(pos()!.worldX - MINE_SPOT.x), Math.abs(pos()!.worldZ - MINE_SPOT.z)) <= 15;
        if (
            s.sdk.getInventory().some(i => !/pickaxe$|^(shrimps|bread|trout|salmon)$/i.test(i.name)) ||
            !initialPick ||
            !atMineNow ||
            (initialPick.item.id === 1265 && (s.sdk.getSkill('Mining')?.level ?? 1) >= 6)
        ) {
            if (!(await travel('bank'))) throw Error('no ore progress: cannot reach bank route');
            const opened = await s.bot.openBank();
            if (!opened.success) throw new Error(`initial bank: ${opened.message}`);
            const junkIds = new Set(s.sdk.getInventory().filter(i => !/pickaxe$|^(shrimps|bread|trout|salmon)$/i.test(i.name)).map(i => i.id));
            const oreBeforeInitialBank = oreCount();
            for (const id of junkIds) {
                const item = s.sdk.getInventory().find(i => i.id === id);
                if (item) await s.bot.depositItem(item, -1);
            }
            banked += oreBeforeInitialBank - oreCount();
            const pickRes = await reconcileOrePickaxeAtBank(s, {
                bankSpot: BANK_SPOT,
                stop: over,
                refusedWields: refusedPickWields,
                deps: cfg.deps,
            });
            if (!pickRes.activeId) await s.bot.withdrawItem(/^coins$/i, 25);
            await s.bot.closeBank();
        }
        if (!selectActiveOrePickaxe(s).current) {
            console.log('MILESTONE recover pickaxe from Bob');
            const world = await getWorld();
            const there = await goTo(s, world, { x: 3231, z: 3203, level: 0 }, accountOf(s));
            if (!there.ok) throw new Error(`Bob route: ${there.detail}`);
            const shop = await s.bot.openShop(/^bob$/i);
            if (!shop.success) throw new Error(`Bob shop: ${shop.message}`);
            const buy = await s.bot.buyFromShop(/^bronze pickaxe$/i, 1);
            await s.bot.closeShop();
            if (!buy.success) throw new Error(`bronze pickaxe: ${buy.message}`);
            const back = await goTo(s, world, { x: BANK_SPOT.x, z: BANK_SPOT.z, level: 0 }, accountOf(s));
            if (!back.ok) throw new Error(`return from Bob: ${back.detail}`);
        }
        if (damage || stopState()) return safetyExit(damage ? 'damage' : stopState());
        while (!over() && bankTrips < maxTrips) {
            if (oreStalled(oreWaitTicks, NO_ORE_TICKS)) {
                stopReason = 'no-progress';
                break;
            }
            if (oreCount() >= BANK_AT || (oreCount() > 0 && freeSpace() === 0)) {
                await bank();
                continue;
            }
            const p = pos();
            if (!p) {
                await waitTicks(s, 1);
                continue;
            }
            if (hp() < 7) {
                const food = s.sdk.getInventory().find(i => /^(shrimps|bread|trout|salmon)$/i.test(i.name));
                if (food) await s.bot.eatFood(food.name);
                else if (hp() < 4) throw new Error('low HP: no food');
            }
            if (Math.max(Math.abs(p.worldX - MINE_SPOT.x), Math.abs(p.worldZ - MINE_SPOT.z)) > 15) {
                if (!(await travel('mine'))) throw Error('no ore progress: cannot reach mine route');
                continue;
            }
            const attempt = tries++;
            const frame = s.sdk.getState();
            const peers = frame?.nearbyPlayers ?? [];
            const rock = selectRock(frame?.nearbyLocs ?? [], s.sdk.getSkill('Mining')?.level ?? 1, attempt, p.level, PROFILE, peers);
            if (!rock) {
                const a = s.tick();
                await waitTicks(s, 2);
                oreWaitTicks += s.tick() - a;
                continue;
            }
            if (s.sdk.getState()?.dialog?.isOpen || s.sdk.getState()?.modalOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
            const r = await mineRock(s, rock, over, Math.min(60, NO_ORE_TICKS - oreWaitTicks), ORE);
            if (r.reason === 'mined') {
                mined += r.ore;
                oreWaitTicks = 0;
                const curToolLevels = readSkillLevels(s.sdk);
                if (crossedTierBoundary(toolLevels, curToolLevels, ['mining', 'attack'], 'mining-pickaxe')) {
                    toolLevels = curToolLevels;
                    await bank(true);
                }
            } else {
                const adjacent = peers.filter(peer => Math.max(Math.abs(peer.x - rock.x), Math.abs(peer.z - rock.z)) <= 1).length;
                console.log(
                    `WARN mine attempt=${attempt} rock=${rock.id}@${rock.x},${rock.z} players=${peers.length} adjacent=${adjacent} reason=${r.reason} ticks=${r.ticks} observedOre=${r.ore} observedXp=${r.xp}`,
                );
                oreWaitTicks += r.ticks;
                const a = s.tick();
                await waitTicks(s, 1);
                oreWaitTicks += s.tick() - a;
            }
        }
        if (damage || stopState()) return safetyExit(damage ? 'damage' : stopState());
        if (!ended && !died) await bank();
        if (damage || stopState()) return safetyExit(damage ? 'damage' : stopState());
        if (bankTrips >= maxTrips && stopReason !== 'no-progress') stopReason = 'max-trips';
        off();
        offDamage();
        let softClay: { ok: boolean; made?: number; banked?: number; preserved?: boolean; failure?: string } | undefined;
        if (PROFILE === 'clay' && resolveSetting(cfg, 'SOFTEN_CLAY') === '1' && !ended && !died && stopReason !== 'no-progress') {
            if (!cfg.deps?.runSoftenClay) throw Error('clay softening requires deps.runSoftenClay');
            softClay = await cfg.deps.runSoftenClay(s, {
                cap: Math.max(1, CAP - used()),
                maximum: Number(resolveSetting(cfg, 'MAX_MAKE') ?? 20),
                reserve: Number(resolveSetting(cfg, 'RAW_RESERVE') ?? 0),
            });
        }
        const total = banked + oreCount();
        const perK = ((mined * 1000) / Math.max(1, used())).toFixed(2);
        const xpGain = (s.sdk.getSkillXp('mining') ?? 0) - xp0;
        const ok = total > 0 && oreCount() === 0 && !died && !ended && !stopState() && !damage && stopReason !== 'no-progress' && (softClay?.ok ?? true);
        const line = `ticks=${used()} died=${died} ${counters()} ${pickLine()} profile=${PROFILE} softMade=${softClay?.made ?? 0} softBanked=${softClay?.banked ?? 0} softPreserved=${softClay?.preserved ?? true} initialOre=${initialOre} recovered=${total} xpGain=${xpGain} stop=${stopReason} ${stopState()} oreWaitTicks=${oreWaitTicks} ${
            stopReason === 'no-progress' ? 'no ore progress: bounded mining wait exhausted' : ''
        } ${softClay && !softClay.ok ? `no soft clay progress: ${softClay.failure}` : ''} orePer1kTicks=${perK}`;
        return {
            ok,
            kind: ok ? 'completed' : died ? 'died' : 'failed',
            detail: line,
            delta: { xp: { Mining: xpGain }, elapsedTicks: used() },
            recoverable: !ok,
            summary: { mined, banked, total, xpGain, profile: PROFILE, ticks: used() },
            resultLine: line,
        };
    } catch (e) {
        offDamage();
        if (cleanup && !safetyStarted && (damage || stopState())) return cleanup(damage ? 'damage' : stopState());
        throw e;
    } finally {
        off();
        offDamage();
    }
}

// ---------------------------------------------------------------------------
// 4. Varrock Aubury Rune Essence Gatherer (`mining:essence`)
// ---------------------------------------------------------------------------
const ESSENCE_BANK_SPOT = { x: 3253, z: 3420 };
const AUBURY_OUTSIDE = { x: 3253, z: 3398 };
const AUBURY_INSIDE = { x: 3253, z: 3402 };
const SHOP_DOOR = { x: 3253, z: 3399 };
const ESSENCE_ROCKS = [
    { x: 2891, z: 4847 },
    { x: 2893, z: 4812 },
    { x: 2925, z: 4848 },
    { x: 2927, z: 4814 },
];
const EXIT_PORTALS = [
    { x: 2885, z: 4850 },
    { x: 2889, z: 4813 },
    { x: 2932, z: 4854 },
    { x: 2933, z: 4815 },
];
const RUNE_ESSENCE = 1436;
const PICKAXES: readonly number[] = MINING_PICKAXES_DESC;

const refusedPickWields = new WeakMap<Session, Set<number>>();
export function essencePickWieldLevel(id: number): number | undefined {
    if (!PICKAXES.includes(id)) return undefined;
    return gearById(id)?.requires.skills.attack ?? 1;
}

export async function upgradeOwnedEssencePick(s: Session, o: { openBank: () => Promise<void>; stop: () => boolean }) {
    const p = s.sdk.getState()?.player;
    const life = p?.lifeId;
    const respawns = p?.respawnCount ?? 0;
    const hp0 = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const stop = () => {
        const at = s.sdk.getState()?.player;
        return o.stop() || !at || at.isDead || at.lifeId !== life || (at.respawnCount ?? 0) !== respawns || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < hp0 || hp0 < 1;
    };
    if (stop()) throw Error('essence pick upgrade stopped');
    await o.openBank();
    if (!(await waitUntil(s, () => stop() || !!s.bankObservation?.(), { timeoutTicks: 10 })) || stop() || !s.sdk.getState()?.bank.isOpen) {
        throw Error('essence pick bank observation absent');
    }
    const state = s.sdk.getState()!;
    const bank = s.bankObservation!()!;
    const miningStat = s.sdk.getSkill('Mining')?.level ?? state.skills?.find(k => k.name === 'Mining')?.level ?? 1;
    const attackStat = s.sdk.getSkill('Attack')?.baseLevel ?? 1;
    const rec = bestMiningPickaxe([...s.sdk.getInventory(), ...s.sdk.getEquipment().filter(e => e.slot === 3), ...bank.items.filter(i => i.count > 0)], {
        mining: miningStat,
        attack: attackStat,
    });
    const candidate = rec.current?.item;
    if (!candidate) throw Error('no eligible owned native pickaxe');
    const inv = () => s.sdk.getInventory();
    const eq = () => s.sdk.getEquipment();
    const count = (id: number, rows: readonly { id: number; count: number }[]) => rows.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const totals = () => {
        const b = s.bankObservation?.();
        if (!b || !s.sdk.getState()?.bank.isOpen) throw Error('essence pick current bank receipt missing');
        const m = new Map<number, number>();
        for (const i of [...inv(), ...eq(), ...b.items]) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        return m;
    };
    const before = totals();
    const weapon = eq().find(i => i.slot === 3);
    if (!inv().some(i => i.id === candidate.id) && !eq().some(i => i.slot === 3 && i.id === candidate.id)) {
        if (inv().length >= 28 || stop()) throw Error('essence pick upgrade needs one free slot');
        const item = state.bank.items.find(i => i.id === candidate.id);
        const old = s.bankObservation!()!;
        const held = count(candidate.id, inv());
        const stored = count(candidate.id, old.items);
        if (!item) throw Error('owned upgrade pick missing from observed bank');
        await s.bot.withdrawItem(item, 1, { asNote: false });
        const matched = () => {
            const b = s.bankObservation?.();
            return !!b && b.generation > old.generation && count(candidate.id, inv()) === held + 1 && count(candidate.id, b.items) === stored - 1;
        };
        if (!(await waitUntil(s, () => stop() || matched(), { timeoutTicks: 10 })) || stop() || !matched()) {
            throw Error('essence upgrade withdrawal does not reconcile');
        }
    }
    const requiredAttack = essencePickWieldLevel(candidate.id);
    const refused = refusedPickWields.get(s) ?? new Set<number>();
    refusedPickWields.set(s, refused);
    if (!eq().some(i => i.slot === 3 && i.id === candidate.id) && (!weapon || PICKAXES.includes(weapon.id)) && requiredAttack !== undefined && attackStat >= requiredAttack && !refused.has(candidate.id)) {
        if (stop()) throw Error('essence stopped before pick equip');
        const item = inv().find(i => i.id === candidate.id);
        if (!item) throw Error('owned pick vanished');
        const generation = s.bankObservation!()!.generation;
        await s.bot.closeBank();
        if (!(await waitUntil(s, () => stop() || (!s.sdk.getState()?.bank.isOpen && !s.bankObservation?.()), { timeoutTicks: 8 })) || stop() || s.sdk.getState()?.bank.isOpen) {
            throw Error('essence upgrade bank close unobserved');
        }
        try {
            await s.bot.equipItem(item);
        } catch {}
        if (!eq().some(i => i.slot === 3 && i.id === candidate.id)) refused.add(candidate.id);
        if (stop()) throw Error('essence stopped after wield');
        await o.openBank();
        if (
            !(await waitUntil(s, () => stop() || (!!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation), {
                timeoutTicks: 12,
            })) ||
            stop() ||
            !s.sdk.getState()?.bank.isOpen ||
            !s.bankObservation?.() ||
            (s.bankObservation?.()?.generation ?? -1) <= generation
        ) {
            throw Error('essence post-wield fresh bank absent');
        }
    }
    if (stop()) throw Error('essence pick upgrade stopped after dispatch');
    const worn = eq().some(i => i.slot === 3 && i.id === candidate.id);
    if (worn) {
        for (const item of [...inv()].filter(i => PICKAXES.includes(i.id) && i.id !== candidate.id)) {
            if (stop()) throw Error('essence stopped before inferior pick bank');
            await depositObserved(s, item);
        }
    }
    const after = totals();
    if ([...new Set([...before.keys(), ...after.keys()])].some(id => (before.get(id) ?? 0) !== (after.get(id) ?? 0))) {
        throw Error('essence pick upgrade changed owned assets');
    }
    const active = bestMiningPickaxe([...inv(), ...eq().filter(e => e.slot === 3)], { mining: miningStat, attack: attackStat }).current?.item;
    if (active?.id !== candidate.id) throw Error('best owned eligible pick not active');
    console.log('ESSENCE_PICK ' + JSON.stringify({ id: candidate.id, worn, preserved: true }));
    return { id: candidate.id, worn, preserved: true };
}

export async function mineEssenceBatch(
    s: Session,
    o: { count: () => number; full: () => boolean; stop: () => boolean; busy: () => boolean; click: () => Promise<unknown>; gain: (n: number) => void },
) {
    let held = o.count();
    let lastOutput = s.tick();
    let lastClick = s.tick();
    await o.click();
    while (!o.stop() && !o.full()) {
        await waitTicks(s, 2);
        const current = o.count();
        if (current > held) {
            o.gain(current - held);
            lastOutput = s.tick();
        }
        held = current;
        if (o.stop()) break;
        if (s.tick() - lastOutput >= 60) throw Error('no essence progress: no observed output for60 ticks');
        if (o.busy()) continue;
        if (s.tick() - Math.max(lastOutput, lastClick) > 10) {
            await o.click();
            lastClick = s.tick();
        }
    }
}

export function isEssence(id: number): boolean {
    return id === RUNE_ESSENCE;
}

type EssenceMessage = { text: string; tick: number; observationId?: number };
export function essenceTeleportProblem(inMine: boolean, messages: readonly EssenceMessage[], cursor: number): string | null {
    if (inMine) return null;
    const refused = messages.some(
        m => (m.observationId ?? m.tick) > cursor && /\bneed to have completed the rune mysteries quest to use this feature\b/i.test(m.text),
    );
    return refused ? 'Rune Mysteries quest required: Aubury refused teleport' : 'Teleport to essence mine timed out';
}

export function dist(a: { x: number; z: number }, b: { worldX: number; worldZ: number } | { x: number; z: number }): number {
    const bx = 'worldX' in b ? b.worldX : b.x;
    const bz = 'worldZ' in b ? b.worldZ : b.z;
    return Math.max(Math.abs(a.x - bx), Math.abs(a.z - bz));
}

export async function runEssenceGatherer(
    s: Session,
    o: { cap: number; bankAt: number; maxTrips?: number; allowShopUpgrade?: boolean; stop?: () => boolean; deps?: GatherExternalDeps },
) {
    if (
        !Number.isSafeInteger(o.cap) ||
        o.cap < 1 ||
        !Number.isSafeInteger(o.bankAt) ||
        o.bankAt < 1 ||
        o.bankAt > 28 ||
        (o.maxTrips !== undefined && (!Number.isSafeInteger(o.maxTrips) || o.maxTrips < 1))
    ) {
        throw Error('invalid essence limits');
    }
    const start = s.tick();
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const inv = () => s.sdk.getInventory();
    const eq = () => s.sdk.getEquipment();
    const miningLevel = () => s.sdk.getSkill('Mining')?.level ?? 1;
    const miningXpNow = () => s.sdk.getSkillXp('Mining') ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const count = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const essenceCount = () => inv().filter(i => isEssence(i.id)).reduce((n, i) => n + i.count, 0);
    const freeSlots = () => 28 - inv().length;

    let ended = false;
    let died = false;
    let totalMined = 0;
    let totalBanked = 0;
    let trips = 0;
    let failure = '';
    const initialEssence = essenceCount();
    let cleanupDeadline: number | undefined;
    void s.ended.then(() => {
        ended = true;
    });
    const over = () => ended || died || !!o.stop?.() || (cleanupDeadline === undefined ? s.tick() - start >= o.cap : s.tick() >= cleanupDeadline);
    const observe = (action: string, phase: string) =>
        console.log(
            'ESSENCE_ACTION ' +
                JSON.stringify({
                    at: Date.now(),
                    tick: s.tick(),
                    action,
                    phase,
                    position: pos() ? { x: pos()!.worldX, z: pos()!.worldZ, level: pos()!.level } : null,
                    hp: hp(),
                    held: essenceCount(),
                    trips,
                    totalBanked,
                    miningXp: miningXpNow(),
                    bankOpen: st()?.bank?.isOpen,
                    generation: s.bankObservation?.()?.generation,
                    pickaxes: [...inv(), ...eq()].filter(i => PICKAXES.includes(i.id)),
                }),
        );
    const action = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
        observe(name, 'start');
        try {
            const result = await work();
            observe(name, 'end');
            return result;
        } catch (error) {
            observe(name, 'error');
            throw error;
        }
    };
    const active = () => {
        if (over()) throw Error('essence stopped; preserve observed load');
    };
    const life0 = (({ isDead, respawnCount, lifeId }: any = {}) => ({ isDead, respawnCount, lifeId }))(s.sdk.getState()?.player);
    const off = s.onTick(() => {
        if (sessionDied(life0, s.sdk.getState()?.player)) died = true;
    });
    const isInMine = (): boolean => {
        const p = pos();
        return !!p && p.worldX >= 2880 && p.worldX <= 2945 && p.worldZ >= 4800 && p.worldZ <= 4865;
    };
    const walk = async (x: number, z: number, tol = 1): Promise<boolean> => {
        const p = pos();
        if (p && dist({ x, z }, p) <= tol) return true;
        const walker = await sessionWalker(s);
        const r = await walkPath(walker, [{ x, z, tol }], { stop: over, maxTicks: 120 });
        return r.ok;
    };
    const openDoorIfNeeded = async () => {
        const door = (st()?.nearbyLocs ?? []).find(
            l => Math.max(Math.abs(l.x - SHOP_DOOR.x), Math.abs(l.z - SHOP_DOOR.z)) <= 1 && l.optionsWithIndex.some(o => /open/i.test(o.text)),
        );
        if (door) {
            const op = door.optionsWithIndex.find(o => /open/i.test(o.text))!;
            await s.sdk.sendInteractLoc(door.x, door.z, door.id, op.opIndex);
            await waitTicks(s, 2);
        }
    };
    const openBank = async () => {
        active();
        await action('dismiss-bank-ui', () => s.bot.dismissBlockingUI());
        active();
        if (!st()?.bank.isOpen) {
            const res = await action('open-bank', () => s.bot.openBank());
            if (!res.success) throw new Error(`openBank failed: ${res.message}`);
            if (!(await waitUntil(s, () => over() || !!st()?.bank.isOpen, { timeoutTicks: 15 })) || !st()?.bank.isOpen) {
                throw Error('essence bank open unobserved');
            }
        }
        active();
    };
    const depositEssence = async () => {
        await openBank();
        if (!(await waitUntil(s, () => over() || !!s.bankObservation?.(), { timeoutTicks: 10 }))) {
            throw new Error('no essence progress: deposit bank observation unavailable');
        }
        active();
        const beforeBank = s.bankObservation!()!.items.filter(i => isEssence(i.id)).reduce((n, i) => n + i.count, 0);
        const held = essenceCount();
        const ids = new Set(inv().filter(i => !PICKAXES.includes(i.id)).map(i => i.id));
        for (const id of ids) {
            active();
            const item = inv().find(i => i.id === id);
            const before = s.bankObservation?.();
            if (!item || !before) throw new Error(`no essence progress: deposit inputs unknown ${id}`);
            const amount = count(id);
            const stored = before.items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
            const matched = () => {
                const receipt = s.bankObservation?.();
                return (
                    !!receipt &&
                    receipt.generation > before.generation &&
                    count(id) === 0 &&
                    receipt.items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0) === stored + amount
                );
            };
            if (
                !(await action('deposit-' + id, () => s.bot.depositItem(item, -1))).success ||
                !(await waitUntil(s, () => over() || matched(), { timeoutTicks: 10 })) ||
                !matched()
            ) {
                throw new Error(`no essence progress: deposit debit/credit unobserved ${id}`);
            }
        }
        const afterBank = s.bankObservation!()!.items.filter(i => isEssence(i.id)).reduce((n, i) => n + i.count, 0);
        const bankedDelta = afterBank - beforeBank;
        if (bankedDelta !== held) throw new Error('no essence progress: deposit total mismatch');
        totalBanked += bankedDelta;
        if (bankedDelta > 0) trips++;
        console.log(`ESSENCE_BANK trip=${trips} bankedDelta=${bankedDelta} totalBanked=${totalBanked} miningXp=${miningXpNow()}`);
        active();
        await action('close-bank', () => s.bot.closeBank());
        if (!(await waitUntil(s, () => over() || !st()?.bank.isOpen, { timeoutTicks: 5 })) || st()?.bank.isOpen) {
            throw Error('essence bank close unobserved');
        }
        active();
    };

    const shopGate: ShopRetryGate = {};
    const maybeBuyShopPickaxe = async () => {
        if (!o.allowShopUpgrade || over()) return;
        const tierNow = tierBoundaryOf(miningLevel(), [1, 6, 21, 31, 41]);
        if (!shouldAttemptShopUpgrade(shopGate, tierNow, s.tick())) return;
        if (!(await walk(ESSENCE_BANK_SPOT.x, ESSENCE_BANK_SPOT.z, 2)) || over()) return;
        await openBank();
        if (!(await waitUntil(s, () => over() || !!s.bankObservation?.(), { timeoutTicks: 10 })) || over()) {
            throw Error('essence shop check bank observation absent');
        }
        const bankItems = s.bankObservation!()!.items;
        const stock = [...inv(), ...eq().filter(e => e.slot === 3), ...bankItems];
        const totalCoins = stock.filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
        const plan = planToolShopUpgrade(
            'mining-pickaxe',
            stock,
            totalCoins,
            { mining: miningLevel(), attack: s.sdk.getSkill('Attack')?.baseLevel ?? 1 },
            { allowedShops: ['pickaxeshop'], onlyWhenStarterOrMissing: true },
        );
        if (plan) {
            const res = await executeShopToolPurchase(
                sessionToolHooks(s, {
                    openBank,
                    walkTo: async spot =>
                        (
                            await defaultWalkTargetPersist(
                                s,
                                { x: spot.x, z: spot.z, level: spot.level ?? 0 },
                                4,
                                o.deps,
                                t => defaultApproach(s, t, over, o.deps),
                            )
                        ).ok,
                    waitUntil: (pred, timeoutTicks) => waitUntil(s, pred, { timeoutTicks }),
                    stop: over,
                }),
                {
                    targetId: plan.target.id,
                    shop: 'pickaxeshop',
                    maxBudget: plan.coinBudgetNeeded,
                    returnBankSpot: ESSENCE_BANK_SPOT,
                },
            );
            recordShopAttempt(shopGate, tierNow, s.tick(), res.bought);
            if (res.bought) {
                console.log(`ESSENCE_SHOP_PICKAXE ${JSON.stringify(res)}`);
                await openBank();
                const spareCoins = inv().find(i => i.id === 995);
                if (spareCoins && !over()) await depositObserved(s, spareCoins);
                await upgradeOwnedEssencePick(s, { openBank, stop: over });
            }
        } else {
            recordShopAttempt(shopGate, tierNow, s.tick(), true);
        }
        await action('close-shop-bank', () => s.bot.closeBank());
        await waitUntil(s, () => over() || !st()?.bank.isOpen, { timeoutTicks: 5 });
    };

    const checkPickaxe = async () => {
        active();
        await upgradeOwnedEssencePick(s, { openBank, stop: over });
        active();
        await action('close-upgrade-bank', () => s.bot.closeBank());
        if (!(await waitUntil(s, () => over() || !st()?.bank.isOpen, { timeoutTicks: 5 })) || over() || st()?.bank.isOpen) {
            throw Error('essence pick bank close unobserved');
        }
    };
    const teleportToMine = async () => {
        await walk(AUBURY_OUTSIDE.x, AUBURY_OUTSIDE.z, 2);
        await openDoorIfNeeded();
        await walk(AUBURY_INSIDE.x, AUBURY_INSIDE.z, 2);
        let aubury = (st()?.nearbyNpcs ?? []).find(n => /aubury/i.test(n.name) || n.id === 553);
        if (!aubury) {
            await waitUntil(s, () => !!(st()?.nearbyNpcs ?? []).find(n => /aubury/i.test(n.name) || n.id === 553), { timeoutTicks: 10 });
            aubury = (st()?.nearbyNpcs ?? []).find(n => /aubury/i.test(n.name) || n.id === 553);
        }
        if (!aubury) throw new Error('Aubury not found in shop');
        const opt = aubury.optionsWithIndex.find(o => /teleport/i.test(o.text));
        const opIndex = opt?.opIndex ?? 3;
        const cursor = Math.max(-1, ...(st()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
        await s.sdk.sendInteractNpc(aubury.index, opIndex);
        await waitUntil(
            s,
            () => {
                if (isInMine()) return true;
                const d = s.sdk.getDialog();
                if (d?.isOpen) {
                    const optEss = d.options.find(o => /teleport me to the rune essence/i.test(o.text));
                    void s.sdk.sendClickDialog(optEss ? optEss.index : 0);
                }
                return isInMine() || over();
            },
            { timeoutTicks: 25 },
        );
        const problem = essenceTeleportProblem(isInMine(), st()?.gameMessages ?? [], cursor);
        if (problem) throw new Error(problem);
    };
    const getClosestRock = () => {
        const p = pos();
        if (!p) return ESSENCE_ROCKS[0]!;
        let best = ESSENCE_ROCKS[0]!;
        let bestD = Infinity;
        for (const rock of ESSENCE_ROCKS) {
            const d = dist(rock, p);
            if (d < bestD) {
                bestD = d;
                best = rock;
            }
        }
        return best;
    };
    const getClosestPortal = () => {
        const p = pos();
        if (!p) return EXIT_PORTALS[0]!;
        let best = EXIT_PORTALS[0]!;
        let bestD = Infinity;
        for (const portal of EXIT_PORTALS) {
            const d = dist(portal, p);
            if (d < bestD) {
                bestD = d;
                best = portal;
            }
        }
        return best;
    };
    const exitMine = async () => {
        const first = getClosestPortal();
        const rest = EXIT_PORTALS.filter(p => p !== first).sort((a, b) => dist(a, pos() ?? a) - dist(b, pos() ?? b));
        const portals = [first, ...rest];
        for (const targetPortal of portals.slice(0, 2)) {
            const walked = await walk(targetPortal.x, targetPortal.z, 2);
            if (!walked) continue;
            let portalLoc = (st()?.nearbyLocs ?? []).find(
                l => (l.id === 2492 || /blankrunestone_exit_portal|portal/i.test(l.name)) && dist(targetPortal, l) <= 10,
            );
            if (!portalLoc) {
                await waitUntil(
                    s,
                    () =>
                        !!(st()?.nearbyLocs ?? []).find(
                            l => (l.id === 2492 || /blankrunestone_exit_portal|portal/i.test(l.name)) && dist(targetPortal, l) <= 10,
                        ),
                    { timeoutTicks: 15 },
                );
                portalLoc = (st()?.nearbyLocs ?? []).find(
                    l => (l.id === 2492 || /blankrunestone_exit_portal|portal/i.test(l.name)) && dist(targetPortal, l) <= 10,
                );
            }
            if (!portalLoc) continue;
            const opt = portalLoc.optionsWithIndex.find(o => /use|enter|exit|step/i.test(o.text));
            const opIndex = opt?.opIndex ?? 0;
            await s.sdk.sendInteractLoc(portalLoc.x, portalLoc.z, portalLoc.id, opIndex);
            const exited = await waitUntil(s, () => !isInMine() || over(), { timeoutTicks: 25 });
            if (exited && !isInMine()) return;
            if (over()) break;
        }
        const locs = (st()?.nearbyLocs ?? []).map(l => `${l.name}#${l.id}@${l.x},${l.z}`).join(';');
        throw new Error(`no essence progress: mine exit incomplete; nearby: ${locs}`);
    };
    const mineEssence = async () => {
        const targetRock = getClosestRock();
        await walk(targetRock.x, targetRock.z, 2);
        const rockLoc = (st()?.nearbyLocs ?? []).find(
            l => (l.id === 2491 || /blankrunestone|rune essence/i.test(l.name)) && dist(targetRock, l) <= 6,
        );
        if (!rockLoc) throw new Error('Rune essence rock not found in range');
        const opt = rockLoc.optionsWithIndex.find(o => /mine/i.test(o.text));
        const opIndex = opt?.opIndex ?? 0;
        await mineEssenceBatch(s, {
            count: essenceCount,
            full: () => freeSlots() === 0 || essenceCount() >= o.bankAt,
            stop: over,
            busy: () => !!randomEventsOf(s)?.busy(),
            click: () => s.sdk.sendInteractLoc(rockLoc.x, rockLoc.z, rockLoc.id, opIndex),
            gain: n => {
                totalMined += n;
            },
        });
    };
    const bankLoad = async () => {
        cleanupDeadline = s.tick() + 300;
        try {
            if (isInMine()) await exitMine();
            if (over() || !(await walk(ESSENCE_BANK_SPOT.x, ESSENCE_BANK_SPOT.z, 2))) {
                throw Error('no essence progress: final bank route incomplete');
            }
            if (inv().some(i => !PICKAXES.includes(i.id))) await depositEssence();
            if (over() || essenceCount() > 0) throw Error('no essence progress: final load not banked');
            if (s.tick() - start < o.cap && (o.maxTrips === undefined || trips < o.maxTrips)) await action('check-pickaxe', checkPickaxe);
            active();
        } finally {
            cleanupDeadline = undefined;
        }
    };

    try {
        console.log(`ESSENCE_START level=${miningLevel()} xp=${miningXpNow()} cap=${o.cap}`);
        const initialTrips = trips;
        if (!isInMine() && essenceCount() === 0) await maybeBuyShopPickaxe();
        if (!isInMine() || freeSlots() === 0) await action('initial-bank-load', bankLoad);
        while (!over() && (o.maxTrips === undefined || trips - initialTrips < o.maxTrips)) {
            if (freeSlots() === 0 || essenceCount() >= o.bankAt) {
                await action('bank-load', bankLoad);
            } else {
                if (!isInMine()) {
                    await maybeBuyShopPickaxe();
                    await action('teleport', teleportToMine);
                }
                await action('mine', mineEssence);
            }
        }
        if (!ended && !died && !o.stop?.() && (isInMine() || essenceCount() > 0)) {
            console.log('ESSENCE_CLEANUP cap');
            await action('cleanup-bank-load', bankLoad);
        }
    } catch (e) {
        failure = String(e);
        console.error(`ESSENCE_ERROR: ${failure}`);
    } finally {
        off();
    }
    totalMined = totalBanked + essenceCount() - initialEssence;
    observe('return', 'end');
    return { ok: !failure && !died && !ended && !o.stop?.(), totalMined, totalBanked, held: essenceCount(), trips, died, failure: failure || '-' };
}

// ---------------------------------------------------------------------------
// 5. Lava Maze Escorted Runite Mining (`mining:lava-maze`)
// ---------------------------------------------------------------------------
export type Tile = readonly [number, number];
export type RosterPlayer = [number, string, number, number, number, number];
type EscortFrame = { tick: number; roster: RosterPlayer[]; at: number };
type MeasuredRoute = { p: Tile[]; route: Tile[]; multi: number };

export const BANK: Tile = [3094, 3492];
export const STAGE: Tile = [3060, 3883];
export const CAMP: Tile = [3060, 3885];
const ESCORT_ORE = 451;
const ESCORT_FOOD = 385;
const ESCORT_PICK = 1275;
const MINING_GEMS_SET = new Set([1617, 1619, 1621, 1623]);

const escortDistance = (a: Tile, b: Tile) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
function requireEscort(ok: unknown, why: string): asserts ok {
    if (!ok) throw Error(why);
}
const wildernessDepth = (x: number, z: number) => (x >= 2944 && x <= 3391 && z >= 3520 && z <= 6399 ? Math.floor((z - 3520) / 8) + 1 : 0);
const defaultWildernessLevel = (z: number) => (z >= 9920 ? Math.floor((z - 9920) / 8) + 1 : z >= 3520 ? Math.floor((z - 3520) / 8) + 1 : 0);
const defaultAttackable = (me: { z: number; combatLevel: number }, other: { z: number; combatLevel: number }) => {
    const level = Math.min(defaultWildernessLevel(me.z), defaultWildernessLevel(other.z));
    return level > 0 && Math.abs(me.combatLevel - other.combatLevel) <= level;
};
const defaultEscapeStep = (level: number, has: { glory: boolean; teleport: boolean }): 'glory' | 'teleport' | 'run' | 'out' => {
    if (level === 0) return 'out';
    if (has.glory && level <= 30) return 'glory';
    if (has.teleport && level <= 20) return 'teleport';
    return 'run';
};
const defaultHasVarrockTeleport = (
    magic: number,
    inventory: readonly { name: string; count?: number }[],
    equipment: readonly { name: string }[],
): boolean => {
    if (magic < 25) return false;
    const held = (re: RegExp) => inventory.filter(i => re.test(i.name)).reduce((n, i) => n + (i.count ?? 1), 0);
    const worn = (re: RegExp) => equipment.some(i => re.test(i.name));
    return (
        held(/^law rune$/i) >= 1 &&
        (held(/^air rune$/i) >= 3 || worn(/staff of air|air battlestaff|mystic air staff/i)) &&
        (held(/^fire rune$/i) >= 1 || worn(/staff of fire|fire battlestaff|mystic fire staff/i))
    );
};

export function corridorThreat(roster: RosterPlayer[], own: Set<string>, corridor: readonly Tile[], combat: number) {
    return roster.find(
        ([, name, x, z, plane, level]) =>
            !own.has(name.toLowerCase()) &&
            plane === 0 &&
            corridor.some(t => {
                const limit = Math.min(wildernessDepth(x, z), wildernessDepth(...t));
                return limit > 0 && escortDistance([x, z], t) <= 30 && Math.abs(level - combat) <= limit;
            }),
    );
}

export class RosterEvidence {
    private frame?: EscortFrame;
    failure?: string;
    accept(value: unknown, at = Date.now()) {
        const v = value as { t?: string; k?: number; p?: RosterPlayer[] };
        if (v?.t !== 'roster') return;
        const valid =
            Number.isSafeInteger(v.k) &&
            Array.isArray(v.p) &&
            v.p.every(
                p =>
                    Array.isArray(p) &&
                    p.length === 6 &&
                    Number.isSafeInteger(p[0]) &&
                    typeof p[1] === 'string' &&
                    p[1].length > 0 &&
                    p.slice(2).every(Number.isSafeInteger) &&
                    p[4] >= 0 &&
                    p[4] <= 3 &&
                    p[5] >= 3 &&
                    p[5] <= 126,
            ) &&
            new Set(v.p.map(p => p[1].toLowerCase())).size === v.p.length;
        if (!valid) {
            this.failure ??= 'Malformed roster';
            return;
        }
        if (this.frame && (v.k !== this.frame.tick + 10 || at - this.frame.at >= 10000)) {
            this.failure ??= 'Roster frame gap';
        }
        this.frame = { tick: v.k!, roster: v.p!, at };
    }
    fresh(now = Date.now()): EscortFrame | undefined {
        if (this.frame && now - this.frame.at >= 10000) this.failure ??= 'Stale roster';
        return this.failure ? undefined : this.frame;
    }
}

type EntryParticipant = { name: string; player: { worldX: number; worldZ: number; level: number; combatLevel?: number } | undefined | null };

export function entryRosterReady(frame: EscortFrame | undefined, participants: readonly EntryParticipant[]) {
    return (
        !!frame &&
        participants.length === 2 &&
        participants.every(
            ({ name, player: p }) =>
                p?.level === 0 &&
                escortDistance([p.worldX, p.worldZ], BANK) === 0 &&
                frame.roster.some(
                    row =>
                        row[1].toLowerCase() === name.toLowerCase() &&
                        row[2] === p.worldX &&
                        row[3] === p.worldZ &&
                        row[4] === p.level &&
                        row[5] === p.combatLevel,
                ),
        )
    );
}

export async function waitForRosterEntry(
    s: TickSource,
    read: () => EscortFrame | undefined,
    participants: () => readonly EntryParticipant[],
    refused: () => boolean,
) {
    const ready = () => entryRosterReady(read(), participants());
    return (await waitUntil(s, () => refused() || ready(), { timeoutTicks: 40 })) && !refused() && ready();
}

export function stageRelease(escort: string, miner: string, escortCombat = 75, minerCombat = 29) {
    let previous: number | undefined;
    let frames = 0;
    return (frame: EscortFrame | undefined, localReady: boolean) => {
        const at = (name: string, t: Tile, combat: number) =>
            frame?.roster.some(
                p => p[1].toLowerCase() === name.toLowerCase() && p[4] === 0 && p[5] === combat && escortDistance([p[2], p[3]], t) === 0,
            );
        if (!frame || !localReady || !at(escort, STAGE, escortCombat) || !at(miner, BANK, minerCombat)) {
            frames = 0;
            previous = undefined;
            return false;
        }
        if (frame.tick !== previous) {
            frames = previous === undefined || frame.tick === previous + 10 ? frames + 1 : 1;
            previous = frame.tick;
        }
        return frames >= 3;
    };
}

export function selectInboundRecovery(from: Tile, inbound: readonly Tile[]): number {
    let bestSouth = -1;
    let bestSouthDist = Infinity;
    let bestAny = 0;
    let bestAnyDist = Infinity;
    for (let i = 0; i < inbound.length; i++) {
        const t = inbound[i]!;
        const d = escortDistance(from, t);
        if (t[1] <= from[1] + 2 && d < bestSouthDist) {
            bestSouth = i;
            bestSouthDist = d;
        }
        if (d < bestAnyDist) {
            bestAny = i;
            bestAnyDist = d;
        }
    }
    return bestSouth >= 0 ? bestSouth : bestAny;
}

export function retreatOrTeleportPlan(
    opts: {
        tile: Tile;
        magic: number;
        inventory: readonly { name: string; count?: number }[];
        equipment: readonly { name: string }[];
    },
    deps?: Pick<GatherExternalDeps, 'hasVarrockTeleport' | 'escapeStep'>,
): 'out' | 'glory' | 'teleport' | 'run' {
    const level = wildernessDepth(opts.tile[0], opts.tile[1]);
    if (level === 0) return 'out';
    const gloryRe = /^amulet of glory\([1-4]\)$/i;
    const hasGlory = opts.inventory.some(i => gloryRe.test(i.name)) || opts.equipment.some(e => gloryRe.test(e.name));
    const hasTele = (deps?.hasVarrockTeleport ?? defaultHasVarrockTeleport)(opts.magic, opts.inventory, opts.equipment);
    return (deps?.escapeStep ?? defaultEscapeStep)(level, { glory: hasGlory, teleport: hasTele });
}

export function escortInterceptDecision(
    opts: {
        escortTile: Tile;
        escortCombat: number;
        threat: { name: string; x: number; z: number; combatLevel: number };
        hasWeapon: boolean;
        hasFood: boolean;
        prayerPoints: number;
    },
    deps?: Pick<GatherExternalDeps, 'attackable'>,
): { action: 'intercept' | 'screen-retreat'; reason: string } {
    const canHit = (deps?.attackable ?? defaultAttackable)(
        { z: opts.escortTile[1], combatLevel: opts.escortCombat },
        { z: opts.threat.z, combatLevel: opts.threat.combatLevel },
    );
    const d = escortDistance(opts.escortTile, [opts.threat.x, opts.threat.z]);
    if (canHit && d <= 12 && opts.hasWeapon && opts.hasFood && opts.prayerPoints >= 10 && opts.threat.combatLevel <= opts.escortCombat + 5) {
        return { action: 'intercept', reason: `escort intercepts ${opts.threat.name} (combat ${opts.threat.combatLevel}) at ${d} tiles` };
    }
    return { action: 'screen-retreat', reason: `retreat from ${opts.threat.name} (combat ${opts.threat.combatLevel}) at ${d} tiles` };
}

export function readEscortRoute() {
    const r = JSON.parse(readFileSync(resolve(ROOT, 'scripts/lava-maze-escort-route.json'), 'utf8')) as {
        out: MeasuredRoute;
        back: MeasuredRoute;
    };
    const zones = new Set(readFileSync(resolve(CONTENT, 'maps/multiway.csv'), 'utf8').split(/\r?\n/));
    const multi = (t: Tile) => zones.has([0, t[0] >> 6, t[1] >> 6, t[0] & 56, t[1] & 56].join('_'));
    for (const [path, start, end] of [
        [r.out, BANK, STAGE],
        [r.back, STAGE, BANK],
    ] as const) {
        requireEscort(
            path?.p?.length === 453 && escortDistance(path.p[0]!, start) === 0 && escortDistance(path.p.at(-1)!, end) === 0,
            'Measured route endpoints differ',
        );
        requireEscort(
            path.p.every((t, i) => t.length === 2 && t.every(Number.isSafeInteger) && (i === 0 || escortDistance(path.p[i - 1]!, t) === 1)),
            'Measured route has a gap',
        );
        requireEscort(path.p.filter(multi).length === 40 && path.multi === 40, 'Measured multi transit differs');
    }
    requireEscort([STAGE, CAMP, [3059, 3885] as Tile, [3060, 3884] as Tile].every(t => !multi(t)), 'Stage and rocks must be singles');
    const points = (rt: MeasuredRoute) => {
        const turns = new Set(rt.route.filter(t => t[1] >= 3860).map(t => t.join(',')));
        return rt.p.filter((t, i) => i % 8 === 0 || i === rt.p.length - 1 || turns.has(t.join(',')));
    };
    return {
        ...r,
        multiTiles: 40,
        outbound: points(r.out),
        inbound: points(r.back),
        corridor: [...r.out.p, ...r.back.p, CAMP, [3060, 3884], [3059, 3885]] as Tile[],
    };
}

function radar(url: string) {
    const evidence = new RosterEvidence();
    const socket = new WebSocket(url);
    const feed = new RosterFeed();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ t: 'roster', on: true }));
        heartbeat = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'ping' }));
        }, 30000);
    });
    socket.addEventListener('message', ({ data }) => {
        try {
            evidence.accept(feed.expand(JSON.parse(String(data))));
        } catch {
            evidence.failure ??= 'Invalid roster JSON';
        }
    });
    socket.addEventListener('close', () => {
        evidence.failure ??= 'Roster socket closed';
        if (heartbeat) clearInterval(heartbeat);
    });
    socket.addEventListener('error', () => {
        evidence.failure ??= 'Roster socket failed';
    });
    return {
        evidence,
        fresh: () => (socket.readyState === WebSocket.OPEN ? evidence.fresh() : undefined),
        close: () => {
            if (heartbeat) clearInterval(heartbeat);
            socket.close();
        },
    };
}

export async function alignAtBank(walker: PathDeps, refused: () => boolean) {
    let stopped = false;
    const stop = () => {
        const p = walker.pos();
        stopped = stopped || refused() || !p || p.level !== 0 || escortDistance([p.x, p.z], BANK) > 3;
        return stopped;
    };
    if (stop()) return false;
    const result = await walkPath(walker, [{ x: BANK[0], z: BANK[1], tol: 0 }], { maxTicks: 12, idleMs: 8000, stop });
    const p = walker.pos();
    return !stop() && result.ok && !!p && p.level === 0 && p.x === BANK[0] && p.z === BANK[1];
}

export async function runEscortedOre(
    names: readonly string[],
    cap = Number(process.env.CAP ?? 1800),
    deps?: GatherExternalDeps,
) {
    requireEscort(
        names.length === 2 && names.every(n => /^[a-z0-9]{1,12}$/i.test(n)) && names[0]!.toLowerCase() !== names[1]!.toLowerCase(),
        'Two distinct owned accounts required',
    );
    requireEscort(Number.isSafeInteger(cap) && cap >= 1 && cap <= 6000 && Number(process.env.MAX_ORE ?? 1) === 1, 'One ore and a finite tick cap required');
    const servers = names.map(n => serverFromEnv(readFileSync(resolveBotEnvPath(n, ROOT), 'utf8')));
    requireEscort(servers[0] === servers[1], 'Participant servers differ');
    const local = /^127\.0\.0\.1:\d+$/.test(servers[0]!);
    if (!local) {
        const controllerRunId = process.env.FLEET_RUN_ID || process.env.COORDINATOR_RUN_ID;
        const participants = JSON.parse(process.env.COORDINATOR_PARTICIPANTS ?? 'null');
        requireEscort(
            controllerRunId &&
                Array.isArray(participants) &&
                participants.length === 2 &&
                names.every(n => participants.some((p: string) => p.toLowerCase() === n.toLowerCase())),
            'Composed controller ownership required',
        );
        requireEscort(process.env.STANDING !== '1', 'Standing repeat is not this pilot');
    }
    const fixtureFeed = process.env.LAVA_ESCORT_ROSTER_URL;
    if (fixtureFeed) {
        requireEscort(
            local && /^ws:\/\/127\.0\.0\.1:\d+\/worldfeed$/.test(fixtureFeed) && process.env.DEMO_OK !== '1',
            'Fixture roster requires loopback accounts',
        );
    }
    const holdPaths = ['all', 'swarm', 'coordinator'].map(n => resolve(ROOT, '.practice/stop-' + n));
    const holdState = () => JSON.stringify(holdPaths.map(p => (existsSync(p) ? readFileSync(p, 'utf8') : null)));
    const fixtureHolds = process.env.LAVA_ESCORT_HOLDS;
    if (fixtureHolds !== undefined) requireEscort(local && fixtureFeed && fixtureHolds === holdState(), 'Loopback hold snapshot differs');
    const stop = () =>
        (local && fixtureHolds !== undefined ? fixtureHolds !== holdState() : holdPaths.some(p => existsSync(p))) ||
        [...names, 'lava-maze-escorted-ore'].some(n => existsSync(resolve(ROOT, '.practice/stop-' + n)));
    const route = readEscortRoute();
    const own = new Set(names.map(n => n.toLowerCase()));
    const sessions: Session[] = [];
    const offs: (() => void)[] = [];
    const faults = new Map<Session, string>();
    const report = {
        mined: 0,
        banked: 0,
        released: false,
        stage: undefined as undefined | { tick: number; hp: number; prayer: number; frames: number },
        rocks: [] as { tick: number; x: number; z: number; id: number }[],
        attempts: [] as Awaited<ReturnType<typeof mineRock>>[],
        actors: [] as {
            name: string;
            ticks: number;
            wallMs: number;
            foodUsed: number;
            hpStart: number;
            hpMin: number;
            hpEnd: number;
            prayerStart: number;
            prayerEnd: number;
            position: Tile | undefined;
        }[],
    };
    let feed: ReturnType<typeof radar> | undefined;
    let failure: string | undefined;
    let abort: string | undefined;
    let holding = false;
    let escort: Session | undefined;
    let miner: Session | undefined;
    let previousEscortHp = 0;
    let meleeProtectAt = -10;
    const starts = new Map<
        Session,
        { tick: number; wall: number; hp: number; min: number; prayer: number; food: number; inventory: Record<number, number>; equipment: string }
    >();
    const walkers = new Map<Session, Awaited<ReturnType<typeof sessionWalker>>>();
    const lastTicks = new Map<Session, number>();
    const player = (s: Session) => s.sdk.getState()?.player;
    const tile = (s: Session): Tile | undefined => {
        const p = player(s);
        return p?.level === 0 ? [p.worldX, p.worldZ] : undefined;
    };
    const at = (s: Session, t: Tile) => {
        const p = tile(s);
        return !!p && escortDistance(p, t) === 0;
    };
    const atEdgeville = (s: Session) => {
        const p = tile(s);
        return !!p && escortDistance(p, BANK) <= 3;
    };
    const held = (s: Session, id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const hp = (s: Session) => player(s)?.hp ?? 0;
    const prayer = (s: Session) => s.sdk.getPrayerState()?.prayerPoints ?? 0;
    const alive = (s: Session) => !!tile(s) && hp(s) > 0 && !player(s)?.isDead;
    const totals = (items: readonly { id: number; count: number }[]) =>
        items.reduce<Record<number, number>>((a, i) => {
            a[i.id] = (a[i.id] ?? 0) + i.count;
            return a;
        }, {});
    const began = Date.now();
    const limits = () =>
        stop() ||
        sessions.some(s => faults.has(s) || !alive(s) || Date.now() - (lastTicks.get(s) ?? 0) > 10000 || s.tick() - starts.get(s)!.tick >= cap) ||
        Date.now() - began > 12 * 60 * 1000;
    const protectedEscort = () => !!escort && escort.sdk.isPrayerActive('protect_items') && prayer(escort) >= 10;
    const checkOutbound = (entering = false) => {
        if (abort) return true;
        const frame = feed?.fresh();
        if (limits()) abort = 'Account, stop or budget gate failed';
        else if (feed?.evidence.failure) abort = feed.evidence.failure;
        else if (!frame && !entering) abort = 'Fresh roster unavailable';
        else if (
            !entering &&
            frame &&
            !sessions.every(s => frame.roster.some(p => p[1].toLowerCase() === s.name.toLowerCase() && p[4] === 0 && p[5] === player(s)?.combatLevel))
        ) {
            abort = 'Participant roster evidence missing';
        } else if (!protectedEscort()) abort = 'Escort prayer reserve lost';
        else if (frame && sessions.some(s => corridorThreat(frame.roster, own, route.corridor, player(s)!.combatLevel!))) {
            abort = 'Full corridor threat';
        } else if (
            sessions.some(s =>
                (s.sdk.getState()?.nearbyPlayers ?? []).some(
                    p =>
                        !own.has(p.name.toLowerCase()) &&
                        (!Number.isSafeInteger(p.combatLevel) || !!corridorThreat([[p.index, p.name, p.x, p.z, 0, p.combatLevel]], own, route.corridor, player(s)!.combatLevel!)),
                ),
            )
        ) {
            abort = 'Local player threat';
        } else if (
            holding &&
            (!escort ||
                !at(escort, STAGE) ||
                hp(escort) < previousEscortHp ||
                (report.released &&
                    !frame?.roster.some(
                        p => p[1].toLowerCase() === escort!.name.toLowerCase() && p[4] === 0 && p[2] === STAGE[0] && p[3] === STAGE[1],
                    )))
        ) {
            abort = 'Escort stage or HP changed';
        }
        if (holding && escort) previousEscortHp = hp(escort);
        return !!abort;
    };
    const heal = async (s: Session) => {
        if (hp(s) > (s === escort ? 46 : 24) || hp(s) >= (player(s)?.maxHp ?? hp(s))) return;
        const food = held(s, ESCORT_FOOD);
        const before = hp(s);
        requireEscort(food > 0, 'Retreat food exhausted ' + s.name);
        await s.bot.eatFood(/^shark$/i);
        requireEscort(await waitUntil(s, () => held(s, ESCORT_FOOD) === food - 1 && hp(s) > before, { timeoutTicks: 8 }), 'Food effect unconfirmed ' + s.name);
    };
    const move = async (s: Session, points: readonly Tile[], retreat = false, expired = () => false) => {
        for (const t of points) {
            requireEscort(alive(s) && !expired(), 'Account or retreat budget failed ' + s.name);
            if (at(s, t)) continue;
            if (retreat) await heal(s);
            else {
                requireEscort(!checkOutbound(), abort ?? 'Outbound refused');
                await heal(s);
                requireEscort(!checkOutbound(), abort ?? 'Outbound refused');
            }
            const result = await walkPath(walkers.get(s)!, [{ x: t[0], z: t[1], tol: 0 }], {
                maxTicks: 40,
                idleMs: 8000,
                stop: () => !alive(s) || expired() || (!retreat && checkOutbound()),
            });
            requireEscort(result.ok && at(s, t), 'Waypoint unconfirmed ' + s.name + ' ' + t.join(',') + ' ' + result.detail);
        }
    };
    const home = async (s: Session) => {
        if (at(s, BANK)) return;
        const from = tile(s);
        requireEscort(from, 'Retreat position unknown ' + s.name);
        if (process.env.LAVA_ESCORT_TELE_RETREAT === '1') {
            for (let tryTele = 0; tryTele < 6; tryTele++) {
                const cur = tile(s);
                if (!cur || wildernessDepth(cur[0], cur[1]) === 0) break;
                const magic = s.sdk.getSkill('Magic')?.level ?? 1;
                const step = retreatOrTeleportPlan(
                    { tile: cur, magic, inventory: s.sdk.getInventory(), equipment: s.sdk.getEquipment() },
                    deps,
                );
                if (step === 'run' || step === 'out') break;
                if (step === 'glory') {
                    const gloryRe = /^amulet of glory\([1-4]\)$/i;
                    const packed = s.sdk.getInventory().find(i => gloryRe.test(i.name));
                    const worn = s.sdk.getEquipment().find(e => gloryRe.test(e.name));
                    if (!packed && worn) {
                        if (s.sdk.getInventory().length >= 28) await heal(s);
                        await s.sdk.sendUseEquipmentItem?.(worn.slot, 1);
                        await waitUntil(s, () => false, { timeoutTicks: 1 });
                        continue;
                    }
                    if (packed) {
                        const op = packed.optionsWithIndex?.find(o => /^rub$/i.test(o.text));
                        await s.sdk.sendUseItem(packed.slot, op?.opIndex ?? 4);
                        await waitUntil(s, () => !!s.sdk.getDialog()?.isOpen, { timeoutTicks: 5 });
                        await s.sdk.clickDialogByText(/^Edgeville/i);
                        await waitUntil(s, () => !tile(s) || wildernessDepth(tile(s)![0], tile(s)![1]) === 0, { timeoutTicks: 6 });
                    }
                } else if (step === 'teleport') {
                    await s.sdk.sendClickComponent(componentId('magic:varrock_teleport'));
                    await waitUntil(s, () => !tile(s) || wildernessDepth(tile(s)![0], tile(s)![1]) === 0, { timeoutTicks: 6 });
                }
            }
            const postTele = tile(s);
            if (postTele && wildernessDepth(postTele[0], postTele[1]) === 0) {
                await walkPath(walkers.get(s)!, [{ x: BANK[0], z: BANK[1], tol: 0 }], { maxTicks: 180, idleMs: 8000 });
                if (at(s, BANK) && alive(s)) return;
            }
        }
        const near = selectInboundRecovery(from, route.inbound);
        const start = s.tick();
        const wall = Date.now();
        await move(s, route.inbound.slice(near), true, () => s.tick() - start >= 650 || Date.now() - wall >= 300000);
        requireEscort(at(s, BANK) && alive(s), 'Safe bank return unconfirmed ' + s.name);
    };

    try {
        requireEscort(!stop(), 'Owner hold present');
        const viaCli = process.argv[2]?.toLowerCase() === names[0]!.toLowerCase();
        const workScript = viaCli && process.argv[1] ? process.argv[1] : deps?.workScript;
        const workRecord = workScript
            ? {
                  script: workScript,
                  argv: viaCli ? process.argv.slice(2) : [names[0]!, 'gather', 'mining', 'lava-maze', ...names.slice(1), `CAP=${cap}`],
                  workArgs: viaCli ? process.argv.slice(3) : ['gather', 'mining', 'lava-maze', ...names.slice(1), `CAP=${cap}`],
                  env: { ...process.env },
              }
            : undefined;
        for (const name of names) {
            requireEscort(!stop(), 'Owner hold before login');
            const fault = async (s: Session, d: string) => {
                faults.set(s, d);
                abort ??= name + ': ' + d;
            };
            const s = await openBot(name, { onStop: fault, onSessionEnd: fault, ...(workRecord ? { record: workRecord } : {}) });
            sessions.push(s);
            starts.set(s, { tick: s.tick(), wall: Date.now(), hp: hp(s), min: hp(s), prayer: prayer(s), food: held(s, ESCORT_FOOD), inventory: {}, equipment: '' });
            lastTicks.set(s, Date.now());
            offs.push(
                s.onTick(() => {
                    lastTicks.set(s, Date.now());
                    const initial = starts.get(s)!;
                    initial.min = Math.min(initial.min, hp(s));
                    if (
                        holding &&
                        s === escort &&
                        !s.sdk.isPrayerActive('protect_from_melee') &&
                        prayer(s) >= 10 &&
                        s.tick() - meleeProtectAt >= 2 &&
                        (s.sdk.getState()?.nearbyNpcs ?? []).some(n => n.distance <= 3 && n.targetIndex >= 32768)
                    ) {
                        meleeProtectAt = s.tick();
                        void s.sdk.sendTogglePrayer('protect_from_melee');
                    }
                    if (holding && s === escort && hp(s) < previousEscortHp) abort ??= 'Escort HP dropped';
                    if (holding && s === escort) previousEscortHp = hp(s);
                    if (holding) checkOutbound();
                }),
            );
            requireEscort(await waitUntil(s, () => alive(s), { timeoutTicks: 20 }), 'Alive session required ' + name);
            if (process.env.WALK_TO_EDGEVILLE === '1' && !atEdgeville(s)) {
                const world = await getWorld();
                const ac = new AbortController();
                const timer = setInterval(() => { if (limits()) ac.abort('limits'); }, 500);
                let moved;
                try {
                    moved = await goTo(s, world, { x: BANK[0], z: BANK[1], level: 0 }, accountOf(s), { signal: ac.signal });
                } finally {
                    clearInterval(timer);
                }
                requireEscort(moved.ok, 'Edgeville walk failed ' + name + (moved.ok ? '' : ': ' + moved.detail));
            }
            requireEscort(await waitUntil(s, () => atEdgeville(s) && alive(s), { timeoutTicks: 20 }), 'Observed Edgeville entry required ' + name);
            if (s.sdk.getState()?.autoRetaliateEnabled === true) await s.sdk.sendClickComponent(151);
            requireEscort(await waitUntil(s, () => s.sdk.getState()?.autoRetaliateEnabled === false, { timeoutTicks: 8 }), 'Auto retaliation remains active ' + name);
            walkers.set(s, await sessionWalker(s));
            if (!at(s, BANK)) {
                requireEscort((await alignAtBank(walkers.get(s)!, limits)) && at(s, BANK), 'Edgeville route start unconfirmed ' + name);
            }
        }
        [escort, miner] = sessions;
        const wantEscortCombat = process.env.ESCORT_COMBAT === 'any' ? null : Number(process.env.ESCORT_COMBAT ?? 75);
        const wantMinerCombat = process.env.MINER_COMBAT === 'any' ? null : Number(process.env.MINER_COMBAT ?? 29);
        const escortCombat = player(escort!)?.combatLevel ?? 0;
        const minerCombat = player(miner!)?.combatLevel ?? 0;
        requireEscort(
            (wantEscortCombat === null || escortCombat === wantEscortCombat) && (wantMinerCombat === null || minerCombat === wantMinerCombat),
            `Expected combat${wantEscortCombat ?? 'any'} escort and combat${wantMinerCombat ?? 'any'} miner`,
        );
        requireEscort((miner!.sdk.getSkill('Mining')?.baseLevel ?? 0) >= 85 && hp(miner!) >= 30 && hp(escort!) >= 47, 'Mining or HP prerequisite missing');
        requireEscort(held(miner!, ESCORT_ORE) === 0, 'Miner must start without carried Runite');
        let bankBaseline = 0;
        for (const s of sessions) {
            requireEscort(!limits(), 'Entry stopped');
            await s.bot.openBank();
            requireEscort(await waitUntil(s, () => !!s.bankObservation?.(), { timeoutTicks: 14 }), 'Fresh bank observation missing ' + s.name);
            if (s === miner) {
                bankBaseline = s.bankObservation!()!.items.filter(i => i.id === ESCORT_ORE).reduce((n, i) => n + i.count, 0);
                requireEscort(bankBaseline === Number(process.env.EXPECTED_BANK_ORE ?? 57), 'Miner bank baseline differs');
            }
            for (const [id, re, want] of [[ESCORT_FOOD, /^shark$/i, 4], ...(s === miner ? ([[ESCORT_PICK, /^rune pickaxe$/i, 1]] as const) : [])] as const) {
                const missing = want - held(s, id);
                if (missing <= 0) continue;
                requireEscort(s.bankObservation!()!.items.some(i => i.id === id && i.count >= missing), 'Missing owned supply ' + id + ' ' + s.name);
                await s.bot.withdrawItem(re, missing, { asNote: false });
                requireEscort(await waitUntil(s, () => held(s, id) >= want, { timeoutTicks: 10 }), 'Supply withdrawal unconfirmed ' + s.name);
            }
            await s.bot.closeBank();
            const initial = starts.get(s)!;
            initial.food = held(s, ESCORT_FOOD);
            initial.inventory = totals(s.sdk.getInventory());
            initial.equipment = JSON.stringify(s.sdk.getEquipment());
        }
        requireEscort(held(miner!, ESCORT_PICK) === 1 && held(miner!, ESCORT_FOOD) >= 4 && held(escort!, ESCORT_FOOD) >= 4, 'Observed kit missing');
        if (!escort!.sdk.isPrayerActive('protect_items')) await escort!.bot.activatePrayer('protect_items');
        requireEscort(await waitUntil(escort!, protectedEscort, { timeoutTicks: 8 }), 'Protect Item or ten-Prayer reserve missing');
        for (const s of sessions) {
            requireEscort((await alignAtBank(walkers.get(s)!, () => !!abort || limits())) && at(s, BANK), 'Post-bank stage unconfirmed ' + s.name);
        }
        requireEscort(sessions.every(s => at(s, BANK) && alive(s)), 'Exact participant bank staging unconfirmed');
        feed = radar(fixtureFeed ?? gameDialAddress(`${local ? 'ws' : 'wss'}://${servers[0]}/worldfeed`));
        requireEscort(
            await waitForRosterEntry(miner!, () => feed!.fresh(), () => sessions.map(s => ({ name: s.name, player: player(s) })), () => checkOutbound(true)),
            abort ?? 'Participant roster unavailable before departure',
        );
        requireEscort(!checkOutbound(), abort ?? 'Departure refused');
        await move(escort!, route.outbound);
        requireEscort(at(escort!, STAGE), 'Exact escort stage unconfirmed');
        holding = true;
        previousEscortHp = hp(escort!);
        const release = stageRelease(escort!.name, miner!.name, escortCombat, minerCombat);
        requireEscort(
            (await waitUntil(miner!, () => checkOutbound() || release(feed!.fresh(), at(miner!, BANK) && at(escort!, STAGE)), { timeoutTicks: 45 })) &&
                !checkOutbound() &&
                release(feed.fresh(), at(miner!, BANK) && at(escort!, STAGE)),
            'Three fresh stage frames unconfirmed',
        );
        report.stage = { tick: feed.fresh()!.tick, hp: hp(escort!), prayer: prayer(escort!), frames: 3 };
        report.released = true;
        await move(miner!, [...route.outbound, CAMP]);
        const rock = () =>
            miner!.sdk
                .getState()
                ?.nearbyLocs.find(
                    l =>
                        l.level === 0 &&
                        [2106, 2107].includes(l.id) &&
                        ((l.x === 3059 && l.z === 3885) || (l.x === 3060 && l.z === 3884)) &&
                        l.reachable !== false &&
                        l.optionsWithIndex.some(o => /^mine$/i.test(o.text)),
                );
        requireEscort(
            (await waitUntil(miner!, () => checkOutbound() || !!rock(), { timeoutTicks: 120 })) && !checkOutbound() && rock(),
            'Counted Runite rock unavailable',
        );
        const startXp = miner!.sdk.getSkillXp('mining') ?? 0;
        const start = miner!.tick();
        const mineTicks = Math.max(25, Math.min(600, Number(process.env.MINE_TICKS ?? 210)));
        for (let i = 0; i < Math.ceil(mineTicks / 25) + 1 && miner!.tick() - start < mineTicks && held(miner!, ESCORT_ORE) === 0; i++) {
            requireEscort(!checkOutbound(), abort ?? 'Mining stopped');
            await heal(miner!);
            const loc = rock();
            if (!loc) break;
            report.rocks.push({ tick: miner!.tick(), x: loc.x, z: loc.z, id: loc.id });
            report.attempts.push(await mineRock(miner!, loc, () => checkOutbound() || held(miner!, ESCORT_ORE) >= 1, Math.min(25, mineTicks - (miner!.tick() - start)), /^runite ore$/i));
        }
        requireEscort(
            await waitUntil(miner!, () => held(miner!, ESCORT_ORE) === 1 && (miner!.sdk.getSkillXp('mining') ?? 0) > startXp, { timeoutTicks: 2 }),
            'Exactly one new ore and Mining XP required',
        );
        report.mined = 1;
        await home(miner!);
        holding = false;
        await home(escort!);
        requireEscort(!abort && !stop(), 'Pilot interrupted ' + abort);
        await miner!.bot.openBank();
        requireEscort(await waitUntil(miner!, () => !!miner!.bankObservation?.(), { timeoutTicks: 14 }), 'Return bank unavailable');
        requireEscort(held(miner!, ESCORT_ORE) === 1, 'New carried ore differs before deposit');
        report.banked = await depositObserved(miner!, { id: ESCORT_ORE, name: 'Runite ore' });
        requireEscort(
            report.banked === 1 && held(miner!, ESCORT_ORE) === 0 && miner!.bankObservation!()!.items.filter(i => i.id === ESCORT_ORE).reduce((n, i) => n + i.count, 0) === bankBaseline + 1,
            'Exact bank credit unconfirmed',
        );
        await miner!.bot.closeBank();
        requireEscort((await alignAtBank(walkers.get(miner!)!, () => !!abort || limits())) && at(miner!, BANK), 'Post-deposit bank position unconfirmed');
        for (const s of sessions) {
            const initial = starts.get(s)!;
            const after = totals(s.sdk.getInventory());
            requireEscort(at(s, BANK) && alive(s), 'Safe return unconfirmed ' + s.name);
            requireEscort(
                JSON.stringify(s.sdk.getEquipment()) === initial.equipment &&
                    Object.keys({ ...initial.inventory, ...after }).every(
                        id =>
                            Number(id) === ESCORT_FOOD ||
                            Number(id) === ESCORT_ORE ||
                            (s === miner && MINING_GEMS_SET.has(Number(id))
                                ? (after[Number(id)] ?? 0) >= (initial.inventory[Number(id)] ?? 0)
                                : (initial.inventory[Number(id)] ?? 0) === (after[Number(id)] ?? 0)),
                    ),
                'Unrelated carried assets differ ' + s.name,
            );
        }
    } catch (error) {
        failure = String(error);
        holding = false;
        const escortWork = async () => {
            if (process.env.LAVA_ESCORT_DEFEND === '1' && escort && walkers.has(escort) && alive(escort) && miner) {
                const et = tile(escort);
                const localFoe = (escort.sdk.getState()?.nearbyPlayers ?? []).find(p => !own.has(p.name.toLowerCase()));
                if (et && localFoe) {
                    if (!deps?.kitFrom || !deps?.fightPlayer || !deps?.defaultSpec) {
                        throw Error('LAVA_ESCORT_DEFEND requires deps.kitFrom, deps.defaultSpec, deps.fightPlayer');
                    }
                    const kit = deps.kitFrom(escort.sdk.getEquipment(), escort.sdk.getInventory());
                    const decision = escortInterceptDecision(
                        {
                            escortTile: et,
                            escortCombat: player(escort)?.combatLevel ?? 75,
                            threat: { name: localFoe.name, x: localFoe.x, z: localFoe.z, combatLevel: localFoe.combatLevel },
                            hasWeapon: Boolean(kit.melee?.length || kit.ranged?.length || kit.magic?.length),
                            hasFood: held(escort, ESCORT_FOOD) > 0,
                            prayerPoints: prayer(escort),
                        },
                        deps,
                    );
                    if (decision.action === 'intercept') {
                        await deps
                            .fightPlayer(escort, localFoe.name, {
                                kit,
                                spec: deps.defaultSpec(kit),
                                freeze: 'flee',
                                cap: 30,
                                exitOnDanger: true,
                                eatAt: 45,
                                escapeAt: 35,
                                maxWild: 56,
                                allies: [miner.name.toLowerCase()],
                                stop: () => !alive(escort!) || wildernessDepth(tile(miner!)?.[0] ?? 0, tile(miner!)?.[1] ?? 0) === 0,
                            })
                            .catch(() => {});
                    }
                }
            }
            if (escort && walkers.has(escort) && alive(escort)) await home(escort);
        };
        const minerWork = async () => {
            if (miner && walkers.has(miner) && alive(miner)) await home(miner);
        };
        const returned = await Promise.allSettled([minerWork(), escortWork()]);
        returned.forEach((r, i) => {
            if (r.status === 'rejected') failure += ' | retreat ' + (i === 0 ? miner?.name : escort?.name) + ': ' + String(r.reason);
        });
    } finally {
        holding = false;
        offs.forEach(off => off());
        feed?.close();
    }
    for (const s of sessions) {
        const b = starts.get(s)!;
        report.actors.push({
            name: s.name,
            ticks: s.tick() - b.tick,
            wallMs: Date.now() - b.wall,
            foodUsed: b.food - held(s, ESCORT_FOOD),
            hpStart: b.hp,
            hpMin: b.min,
            hpEnd: hp(s),
            prayerStart: b.prayer,
            prayerEnd: prayer(s),
            position: tile(s),
        });
    }
    const attempts = sessions.map(s => s.lifecycle?.attemptId);
    const logout = await settle(sessions, !failure && report.banked === 1, failure ?? 'One new Lava Maze Runite banked');
    const loggedOut =
        sessions.length === 2 &&
        sessions.every((s, i) => {
            const p = readLogoutProof(s.name, servers[0]!);
            return p.state === 'confirmed' && p.attemptId === attempts[i];
        });
    return { ...report, ok: !failure && logout && loggedOut, logout: loggedOut, failure, wallMs: Date.now() - began };
}

// ---------------------------------------------------------------------------
// 6. Unified Mining Session & CLI
// ---------------------------------------------------------------------------
function lootPolicyFromConfig(cfg: NormalizedGatherConfig): LootPolicy {
    const csv = (k: string) => (resolveSetting(cfg, k) ?? '').split(',').map(v => v.trim()).filter(Boolean);
    const numCsv = (k: string) => csv(k).map(Number);
    return {
        mode: (resolveSetting(cfg, 'LOOT_MODE') ?? 'list') as LootPolicy['mode'],
        ids: numCsv('LOOT_IDS'),
        names: csv('LOOT_NAMES'),
        minimumValue: Number(resolveSetting(cfg, 'MIN_VALUE') ?? 1),
        maximumValue: Number(resolveSetting(cfg, 'MAX_VALUE') ?? 2147483647),
        radius: Number(resolveSetting(cfg, 'RADIUS') ?? 2),
        maximumUnits: cfg.target?.count ?? Number(resolveSetting(cfg, 'MAX_UNITS') ?? 1),
        cap: cfg.target?.capTicks ?? Number(resolveSetting(cfg, 'CAP') ?? 200),
        idleTicks: Number(resolveSetting(cfg, 'IDLE_TICKS') ?? 80),
        nameGlobs: csv('LOOT_NAME_GLOBS'),
        ignoredIds: numCsv('LOOT_IGNORE_IDS'),
        ignoredNames: csv('LOOT_IGNORE_NAMES'),
        ignoredNameGlobs: csv('LOOT_IGNORE_NAME_GLOBS'),
    };
}

export async function runMiningSession(s: Session, cfg: NormalizedGatherConfig, stop: () => boolean): Promise<GatherOutcome> {
    switch (cfg.method) {
        case 'ore': {
            const stopState = () => (stop() ? 'stop-requested' : '');
            return runOreGathererSession(s, cfg, stopState);
        }
        case 'essence': {
            const cap = cfg.target?.capTicks ?? Number(cfg.args[0] ?? resolveSetting(cfg, 'CAP') ?? 15000);
            const bankAt = Number(cfg.args[1] ?? resolveSetting(cfg, 'BANK_AT') ?? 28);
            const r = await runEssenceGatherer(s, {
                cap,
                bankAt,
                maxTrips: cfg.target?.trips,
                allowShopUpgrade: resolveSetting(cfg, 'ALLOW_SHOP_UPGRADE') !== '0',
                stop,
                deps: cfg.deps,
            });
            const line = `essence ${JSON.stringify(r)}`;
            return {
                ok: r.ok,
                kind: r.ok ? 'completed' : r.died ? 'died' : 'failed',
                detail: line,
                delta: { items: { [RUNE_ESSENCE]: r.totalBanked } },
                recoverable: !r.ok,
                summary: r,
                resultLine: line,
            };
        }
        case 'at-site': {
            const profileName = cfg.spot ?? cfg.args[0] ?? resolveSetting(cfg, 'PROFILE') ?? 'iron_rock_table';
            const profile = miningProfiles().find(p => p.name === profileName);
            if (!profile) throw Error('account and native mining table profile required');
            const maximum = cfg.target?.count ?? Number(cfg.args[1] ?? resolveSetting(cfg, 'MAX_MAKE') ?? 1);
            const cap = cfg.target?.capTicks ?? Number(cfg.args[2] ?? resolveSetting(cfg, 'CAP') ?? 2000);
            await equipUsablePickaxeInPack(s);
            const siteKey = resolveSetting(cfg, 'MINING_SITE');
            const site = MINING_SITES.find(t => t.key === siteKey);
            if (siteKey && !site) throw Error('unknown MINING_SITE ' + siteKey);
            const keepRaw = resolveSetting(cfg, 'MINING_KEEP');
            const keepIds = keepRaw ? keepRaw.split(',').filter(Boolean).map(Number) : [...MINING_PICKAXES_DESC];
            const rotate = resolveSetting(cfg, 'MINING_ROTATE') === '1' || resolveSetting(cfg, 'MINING_KNIFE') === '1';
            const pickRaw = resolveSetting(cfg, 'MINING_PICK');
            const rotation = rotate
                ? {
                      knife: resolveSetting(cfg, 'MINING_KNIFE') === '1',
                      drop: resolveSetting(cfg, 'MINING_DROP') === '1',
                      make1: componentId('skill_multi3:make1_a'),
                      players: Number(resolveSetting(cfg, 'MINING_PLAYERS') ?? 1),
                      rocks: site ? siteTiles(profile, site) : undefined,
                      keep: keepIds,
                      pick: pickRaw === 'nearest' || pickRaw === 'roll' ? (pickRaw as 'nearest' | 'roll') : undefined,
                  }
                : undefined;
            const r = await runAtSiteMining(
                {
                    state: () => s.sdk.getState(),
                    tick: () => s.tick(),
                    stop,
                    mine: async l => (await s.sdk.sendInteractLoc(l.x, l.z, l.id, 1)).success,
                    wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
                    step: () => waitTicks(s, 1),
                    clearModal: async () => {
                        await s.sdk.sendCloseModal();
                    },
                    send: async acts => {
                        for (const a of acts) await s.direct({ ...a, reason: 'SDK' });
                    },
                },
                profile,
                { maximum, cap, idleTicks: Number(resolveSetting(cfg, 'IDLE_TICKS') ?? 1200), rotation },
            );
            const rolls = (r as { rolls?: number[] }).rolls;
            if (rolls && rolls.length > 1) {
                const per = (rolls.at(-1)! - rolls[0]!) / (rolls.length - 1);
                console.log(
                    `MINING_RATE ores=${r.made} ticksPerOre=${per.toFixed(2)} xpPerTick=${(r.xp / r.made / per).toFixed(1)} runTicks=${r.ticks} runXpPerTick=${(r.xp / r.ticks).toFixed(1)}`,
                );
            }
            const line = JSON.stringify(r);
            return { ok: true, kind: 'completed', detail: line, delta: { xp: { Mining: r.xp }, elapsedTicks: r.ticks }, recoverable: false, summary: r, resultLine: line };
        }
        case 'drop': {
            const profileName = cfg.spot ?? cfg.args[0] ?? resolveSetting(cfg, 'PROFILE') ?? 'iron_rock_table';
            const profile = miningProfiles().find(p => p.name === profileName);
            if (!profile) throw Error('native-profile required for drop mining');
            const maximum = cfg.target?.count ?? Number(cfg.args[1] ?? resolveSetting(cfg, 'MAX_MAKE') ?? 1);
            const cap = cfg.target?.capTicks ?? Number(cfg.args[2] ?? resolveSetting(cfg, 'CAP') ?? 2000);
            const keepArg = cfg.args[3] ?? resolveSetting(cfg, 'MINING_KEEP');
            const keepIds = keepArg ? keepArg.split(',').filter(Boolean).map(Number) : [...MINING_PICKAXES_DESC];
            await equipUsablePickaxeInPack(s);
            const r = await runDropMining(
                {
                    state: () => s.sdk.getState(),
                    tick: () => s.tick(),
                    stop,
                    mine: async l => (await s.sdk.sendInteractLoc(l.x, l.z, l.id, 1)).success,
                    drop: async slot => (await s.sdk.sendDropItem(slot)).success,
                    wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
                    step: () => waitTicks(s, 1),
                    clearModal: async () => {
                        await s.sdk.sendCloseModal();
                    },
                },
                profile,
                { maximum, cap, idleTicks: Number(resolveSetting(cfg, 'IDLE_TICKS') ?? 300), keep: keepIds },
            );
            const line = JSON.stringify(r);
            return { ok: true, kind: 'completed', detail: line, delta: { xp: { Mining: r.xp }, elapsedTicks: r.ticks }, recoverable: false, summary: r, resultLine: line };
        }
        case 'progressive': {
            const rawPath = cfg.args[0];
            if (!rawPath) throw Error('usage: mining progressive job.json');
            const j = (rawPath.startsWith('{') ? JSON.parse(rawPath) : JSON.parse(readFileSync(rawPath, 'utf8'))) as ProgressiveMiningJob;
            const r = await runProgressiveMining(s, j, stop, { runBankJob: cfg.deps?.runBankJob });
            const line = JSON.stringify(r);
            console.log('PROGRESSIVE_MINING ' + line);
            return { ok: r.ok, kind: r.ok ? 'completed' : 'failed', detail: line, delta: { elapsedTicks: r.ticks }, recoverable: !r.ok, summary: r, resultLine: line };
        }
        case 'loot': {
            const p = lootPolicyFromConfig(cfg);
            const client = s.client as { objType?: (id: number) => { cost: number; stackable: boolean } };
            const r = await runVisibleGroundLoot(
                {
                    state: () => s.sdk.getState(),
                    tick: () => s.tick(),
                    stop,
                    definition: id => {
                        const d = client.objType?.(id);
                        return d && typeof d.stackable === 'boolean' ? { cost: d.cost, stackable: d.stackable } : undefined;
                    },
                    pickup: async i => (await s.sdk.sendPickup(i.x, i.z, i.id)).success,
                    wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
                    step: () => waitTicks(s, 1),
                    clearModal: async () => {
                        await s.sdk.sendCloseModal();
                    },
                },
                p,
            );
            const line = JSON.stringify(r);
            return { ok: true, kind: 'completed', detail: line, delta: { elapsedTicks: r.ticks }, recoverable: false, summary: r, resultLine: line };
        }
        case 'lava-maze':
            return {
                ok: false,
                kind: 'refused',
                detail: 'lava-maze requires dual-account CLI/orchestrator invocation (runEscortedOre)',
                delta: { elapsedTicks: 0 },
                recoverable: false,
            };
        default:
            return { ok: false, kind: 'refused', detail: `unknown mining method: ${cfg.method}`, delta: { elapsedTicks: 0 }, recoverable: false };
    }
}

export async function runMiningCli(account: string, cfg: NormalizedGatherConfig): Promise<number> {
    if (cfg.method === 'lava-maze') {
        const partner = cfg.escort ?? resolveSetting(cfg, 'ESCORT') ?? cfg.args[0] ?? '';
        const cap = cfg.target?.capTicks ?? Number(resolveSetting(cfg, 'CAP') ?? 1800);
        const names = [account, partner].filter(Boolean);
        try {
            const result = await runEscortedOre(names, cap, cfg.deps);
            console.log('LAVA_ESCORT_RESULT ' + JSON.stringify(result));
            process.exitCode = result.ok ? 0 : 1;
            return result.ok ? 0 : 1;
        } catch (error) {
            console.log('LAVA_ESCORT_RESULT ' + JSON.stringify({ ok: false, logout: false, failure: String(error) }));
            process.exitCode = 1;
            return 1;
        }
    }

    let requestedStop = '';
    const stopFile = `.practice/stop-${account}`;
    const s = await openBot(account, {
        onStop: async (_session, reason) => {
            requestedStop = reason;
        },
    }).catch(e => finish([], false, `login: ${String(e)}`));
    let ended = false;
    void s.ended.then(() => {
        ended = true;
    });
    const stop = () => ended || !!requestedStop || existsSync(stopFile) || existsSync('.practice/stop-all');
    try {
        const outcome = await runMiningSession(s, cfg, stop);
        await finish([s], outcome.ok, outcome.resultLine ?? outcome.detail ?? '');
        return outcome.ok ? 0 : 1;
    } catch (e) {
        await finish([s], false, String(e));
        return 1;
    }
}
