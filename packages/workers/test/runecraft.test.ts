// Unified Runecraft WorkerModule contract, preflight, estimate, bank-craft, Shilo nature, supply, and carrier tests.
import { beforeAll, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { combatLevel, deadly, type Hunter } from '../../core/src/danger';
import { loadPathfinding } from '../../core/src/pathcache';
import { expandPath, walkPath, type PathDeps, type PathPoint } from '../../core/src/walk';
import * as walking from '../../core/src/walk';
import { parseJm2 } from '../../knowledge/src/jm2';
import { runeBankCraftFixture } from '../../practice/src/rune-bank-craft-proof';
import { runeCohortAssetsPreserved } from '../../practice/src/rune-carrier-stage-proof';
import {
    runeContinuationHelpers,
    runeContinuationVarpDifferences,
    runeMeasurementBankedOutput,
} from '../../practice/src/rune-continuation-proof';
import { parsePracticeSave } from '../../../scripts/measure/fleet-player-save';
import { initPathfinding } from '../../../vendor/rs-sdk/sdk/pathfinding';
import { createSaveData } from '../../../vendor/rs-sdk/sdk/test/utils/save-generator';
import type { BotWorldState } from '../../../vendor/rs-sdk/sdk/types';
import * as rsmod from '../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder';
import { CollisionType } from '../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder';
import type { Session } from '../../core/src/inprocess';
import {
    createWorkerRegistry,
    isPreflightResult,
    isRateEstimate,
    isRunOutcome,
    isWorkerModule,
    validateWorkerModule,
    type WorkerAccountView,
    type WorkerWorldView,
} from '../src/contracts';
import * as cooking from '../src/gather/fishing';
import * as essence from '../src/gather/mining';
import {
    BODY_CARRIER_ALTAR,
    COSMIC_ALTAR,
    NATURE,
    NATURE_XP_CAP,
    RUINS,
    RUNE_ALTARS,
    RUNE_CARRIER_ALTARS,
    UNSUPPORTED_CARRIER_ALTARS,
    airCraftEffects,
    assertFreshRuneSkills,
    assertRuneDonor,
    carrierAltar,
    carrierXpPerEssence,
    chooseRuneAltar,
    craftAirRunes,
    createRuneTradeRefresh,
    createShiloTransit,
    dispatchRuneEntry,
    exitAirAltar,
    exitRuneStageBasement,
    exitRuneTower,
    inRuinFootprint,
    inZanarisCosmic,
    insideAirAltar,
    insideCarrierAltar,
    insideNature,
    leaveRuneStarter,
    levelForXp,
    naturePlanComplete,
    natureProfile,
    natureReceipt,
    natureRouteJob,
    natureXpReceipt,
    nearestBankTile,
    normalizeRunecraftConfig,
    observeCraftCompletion,
    outsideAirAltar,
    pipelineOpeningReady,
    requireNatureEligibility,
    ruinTarget,
    runeAltarStaging,
    runeBankBalanced,
    runeBankDone,
    runeBankOk,
    runeBankOptions,
    runeBankTarget,
    runeBankXpBalanced,
    runeCarrierRoster,
    runeCarrierShortfall,
    runeCarrierStaged,
    runeConfirmation,
    runeHandoffPipeline,
    runeMysteriesDecision,
    runeMysteriesStartProblem,
    runeMysteriesWalk,
    runeStageAuthenticate,
    runeStageBankApproach,
    runeStageRequirement,
    runeStageRoster,
    runeSupplyAssets,
    runeSupplyPreserved,
    runeSupplyTarget,
    runNatureTrips,
    runRuneBankCraft,
    runRuneSupply,
    runRunecraftCli,
    runecraftEstimate,
    runecraftPreflight,
    runecraftWorker,
    runesPerEssence,
    sedridorOutcome,
    settleRuneEntryModal,
    toRunecraftWorkerOutcome,
    walkRuneMysteries,
    type NatureJob,
    type RuneBankLedger,
} from '../src/runecraft';
import * as altarActions from '../src/runecraft/air';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

async function fixtureChild(code: string, timeout: number) {
    const child = Bun.spawn([process.execPath, '-e', code], { cwd: REPO_ROOT, windowsHide: true, stdout: 'pipe', stderr: 'pipe', timeout });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
}

// =========================================================================
// Bank-craft & Cosmic tests (migrated from rune-bank-craft & rune-bank-production)
// =========================================================================

test('mind ruins wait for wilderness warning closure and refuse an unsettled modal', async () => {
    for (const mode of ['closed', 'stuck', 'refused', 'stop'] as const) {
        let tick = 0, closes = 0, stopped = false;
        const state = { modalOpen: true, modalInterface: 1908, interface: { isOpen: true, interfaceId: 1908 }, dialog: { isOpen: false } };
        const s = {
            tick: () => tick,
            sdk: { getState: () => state, sendCloseModal: async () => { closes++; return { success: mode !== 'refused' }; } },
            onTick: (cb: () => void) => {
                let active = true;
                const next = () => {
                    if (!active) return;
                    tick++;
                    if (tick === 2 && mode === 'closed') { state.modalOpen = false; state.modalInterface = -1; state.interface.isOpen = false; }
                    if (mode === 'stop') stopped = true;
                    cb();
                    if (active) queueMicrotask(next);
                };
                queueMicrotask(next);
                return () => { active = false; };
            },
        } as unknown as Session;
        expect(await settleRuneEntryModal(s, () => stopped)).toBe(mode === 'closed');
        expect(closes).toBe(1);
        expect(tick).toBe(mode === 'closed' ? 2 : mode === 'stuck' ? 10 : mode === 'stop' ? 1 : 0);
        if (mode === 'closed') {
            expect(await settleRuneEntryModal(s, () => false)).toBe(true);
            expect(closes).toBe(1);
        }
    }
});

test('a wilderness warning opened after dispatch is closed and the canceled entry is sent again', async () => {
    let tick = 0, closes = 0, inside = false;
    const dispatched: number[] = [];
    const state = { modalOpen: false, modalInterface: -1, interface: { isOpen: false, interfaceId: -1 }, dialog: { isOpen: false } };
    const s = {
        tick: () => tick,
        sdk: { getState: () => state, sendCloseModal: async () => { closes++; return { success: true }; } },
        onTick: (cb: () => void) => {
            let active = true;
            const next = () => {
                if (!active) return;
                tick++;
                if (dispatched.length === 1 && tick === dispatched[0]! + 2) {
                    state.modalOpen = true; state.modalInterface = 1908; state.interface = { isOpen: true, interfaceId: 1908 };
                }
                if (closes === 1 && state.modalOpen) {
                    state.modalOpen = false; state.modalInterface = -1; state.interface = { isOpen: false, interfaceId: -1 };
                }
                if (dispatched.length === 2 && tick === dispatched[1]! + 1) inside = true;
                cb();
                if (active) queueMicrotask(next);
            };
            queueMicrotask(next);
            return () => { active = false; };
        },
    } as unknown as Session;
    const r = await dispatchRuneEntry(s, {
        stop: () => false,
        entered: () => inside,
        dispatch: async attempt => {
            expect(state.modalOpen).toBe(false);
            dispatched.push(tick);
            expect(attempt).toBe(dispatched.length);
            return { success: true };
        },
    });
    expect(r).toEqual({ entered: true, dispatches: 2, warnings: 1 });
    expect(closes).toBe(1);
    expect(settleRuneEntryModal).toBeDefined();
    expect(runeBankOptions({ altar: 'air' }).altar).toBe('air');
});

test('entry observer preserves blocking UI and feedback but excludes stale messages', async () => {
    const { runeEntrySnapshot, runeEntryWarning } = await import('../src/runecraft');
    expect(runeEntryWarning({ modalOpen: true, modalInterface: 1908, interface: { isOpen: true, interfaceId: 1908 } } as BotWorldState)).toBe(true);
    expect(runeEntryWarning({ modalOpen: false, modalInterface: -1, interface: { isOpen: false, interfaceId: -1 } } as BotWorldState)).toBe(false);
    const state = {
        tick: 286, revision: 90, inventory: [{ id: 1448, slot: 0, count: 1 }],
        dialog: { isOpen: true }, interface: { isOpen: false, interfaceId: -1 }, modalOpen: true, modalInterface: 233,
        bank: { isOpen: false }, shop: { isOpen: false }, opFeedback: { opRejectedCount: 2 },
        gameMessages: [
            { text: 'old', tick: 285, observationId: 88 },
            { text: 'fresh same tick', tick: 286, observationId: 91 },
            { text: 'old without cursor', tick: 286 },
            { text: 'fresh without cursor', tick: 287 },
        ],
    } as BotWorldState;
    const before = JSON.stringify(state), snapshot = runeEntrySnapshot(state, 90, 286);
    expect(snapshot.messages.map(m => m.text)).toEqual(['fresh same tick', 'fresh without cursor']);
    expect(snapshot).toMatchObject({
        inventory: state.inventory, dialog: { isOpen: true }, modalOpen: true, modalInterface: 233,
        opFeedback: { opRejectedCount: 2 }, bankOpen: false, shopOpen: false, tradeOpen: null,
    });
    expect(JSON.stringify(state)).toBe(before);
    expect(runeEntrySnapshot(null, 90, 286)).toMatchObject({ dialog: null, modalOpen: null, opFeedback: null, messages: [] });
});

test('ladder fixture uses the consumer combat baseline and retains starter Runecraft stock', () => {
    expect(runeBankCraftFixture.skills).toEqual({ Attack: 47, Hitpoints: 33, Runecraft: 1 });
    expect(runeBankCraftFixture.varps[63]).toBe(6);
    expect(runeBankCraftFixture.bank).toEqual([{ id: 1436, count: 30 }, { id: 556, count: 25 }, { id: 1438, count: 1 }, { id: 1448, count: 1 }]);
    expect(runeBankCraftFixture.inventory).toEqual([{ id: 556, count: 5 }]);
    const skills = Object.fromEntries(Object.entries(runeBankCraftFixture.skills).map(([name, level]) => [name.toLowerCase(), level]));
    const bear: Hunter = { name: 'Bear', combat: 19, mode: 'cowardly', reach: 13, spawns: [{ x: 2979, z: 3501, level: 0 }] };
    expect(deadly(bear, combatLevel({}), 10)).toBe(true);
    expect(combatLevel(skills)).toBe(24);
    expect(deadly(bear, combatLevel(skills), skills.hitpoints!)).toBe(false);
});

const ledger = (o: Partial<RuneBankLedger> = {}): RuneBankLedger => ({ essence0: 30, essence: 0, air0: 30, air: 60, consumed: 30, crafted: 30, ...o });
const bankBase = { level0: 1, level: 2, target: 99, bankEssence: 0, held: { essence: 0, air: 0 }, stopped: false };

test('altar follows level and owned access items on each bank visit', () => {
    const owned = new Set([1438, 1448, 1444, 1440, 1442, 1446]);
    for (const [level, name] of [[1, 'air'], [2, 'mind'], [5, 'water'], [9, 'earth'], [14, 'fire'], [20, 'body']] as const)
        expect(chooseRuneAltar(level, owned).altar?.name).toBe(name);
    expect(chooseRuneAltar(5, new Set([1438])).wanted).toEqual(['water', 'mind']);
    expect(chooseRuneAltar(5, new Set([1438])).altar?.name).toBe('air');
    expect(chooseRuneAltar(1, new Set()).altar).toBeUndefined();
    expect(chooseRuneAltar(1, new Set()).wanted).toEqual(['air']);
    expect(chooseRuneAltar(27, new Set([...owned, 1454])).altar?.name).toBe('body');
    expect(RUNE_ALTARS.map(a => a.name)).toEqual(['air', 'mind', 'water', 'earth', 'fire', 'body']);
    expect(chooseRuneAltar(1, new Set([5527, 1448])).altar).toBeUndefined();
    expect(chooseRuneAltar(66, new Set([1446])).altar?.name).toBe('body');
    expect(chooseRuneAltar(66, new Set([1446])).wanted).toEqual([]);
});

test('requested output pins the owned, unlocked altar and never falls back', () => {
    expect(chooseRuneAltar(99, new Set([1438, 1446]), 'air').altar?.name).toBe('air');
    expect(chooseRuneAltar(99, new Set([1438, 1446])).altar?.name).toBe('body');
    expect(() => chooseRuneAltar(99, new Set([1446]), 'air')).toThrow('air talisman1438 required');
    expect(() => chooseRuneAltar(1, new Set([1438, 1446]), 'body')).toThrow('requires Runecraft20');
    expect(() => chooseRuneAltar(99, new Set([1438]), 'nature')).toThrow('unknown rune altar');
});

test('mixed altar output reconciles every rune type, not just the total', () => {
    const mixed = ledger({ air: 57, crafted: 30, runes: { 556: { before: 30, after: 57, crafted: 27 }, 558: { before: 0, after: 3, crafted: 3 } } });
    expect(runeBankBalanced(mixed)).toBe(true);
    expect(runeBankBalanced({ ...mixed, runes: { 556: { before: 30, after: 56, crafted: 27 }, 558: { before: 0, after: 4, crafted: 3 } } })).toBe(false);
    expect(runeBankOk({ ...bankBase, ledger: mixed, held: { essence: 0, air: 0, runes: 3 } })).toBe(false);
});

test('altar levels, XP, access items and destinations match pinned content', () => {
    const root = new URL('../../../vendor/rs-sdk/server/content/', import.meta.url);
    const rows = readFileSync(new URL('scripts/skill_runecraft/configs/runecraft.dbrow', root), 'utf8');
    const pack = readFileSync(new URL('pack/obj.pack', root), 'utf8');
    const locPack = readFileSync(new URL('pack/loc.pack', root), 'utf8');
    const entry = readFileSync(new URL('scripts/skill_runecraft/scripts/runecraft.rs2', root), 'utf8');
    expect(entry).toContain('oc_category(last_useitem) = talismans');
    expect(entry).toContain('db_getfield($data, runecraft_table:talisman, 0) ! last_useitem');
    const coord = (value: string) => { const [level, mx, mz, x, z] = value.split(',')[0]!.split('_').map(Number); return { x: mx! * 64 + x!, z: mz! * 64 + z!, level: level! }; };
    for (const a of RUNE_ALTARS) {
        const row = rows.split(`[runecraft_${a.name}]`)[1]!.split('[')[0]!;
        const field = (name: string) => row.match(new RegExp(`^data=${name},(.+)$`, 'm'))![1]!.trim();
        expect(Number(field('level'))).toBe(a.level);
        expect(Number(field('experience')) / 10).toBe(a.xp);
        expect(Number(field('multiplier'))).toBe(a.multiplier);
        expect(pack).toContain(`${a.talisman}=${a.name}_talisman`);
        expect(pack).toContain(`${a.rune}=${a.name}rune`);
        expect(Number(field('members'))).toBe(0);
        expect(field('talisman')).toBe(`${a.name}_talisman`);
        expect(locPack).toContain(`${2452 + RUNE_ALTARS.indexOf(a)}=${a.name}temple_ruined`);
        expect(locPack).toContain(`${a.portal}=${a.name}temple_exit_portal`);
        expect(coord(field('altar_coord'))).toEqual(a.ruins);
        expect(coord(field('enter_coord'))).toEqual(a.inside);
        expect(coord(field('exit_coord'))).toEqual(a.outside);
    }
});

test('non-air ruins stage outside the blocked centre and approach the pinned placement', () => {
    const root = new URL('../../../vendor/rs-sdk/server/content/', import.meta.url);
    const config = readFileSync(new URL('scripts/skill_runecraft/configs/runecraft.loc', root), 'utf8');
    for (const a of RUNE_ALTARS) {
        const { at, q } = ruinTarget(a), file = q.src.slice('maps/'.length);
        const placed = parseJm2(file, readFileSync(new URL(q.src, root), 'utf8')).locs.filter(l => l.id === q.id);
        expect(placed.map(({ x, z, level, shape, angle }) => ({ x, z, level, shape, angle }))).toEqual([{ ...at, shape: q.shape, angle: q.angle }]);
        const block = config.split(`[${a.name}temple_ruined]`)[1]!.split('\n[')[0]!;
        expect(block).toContain(`width=${q.width}`); expect(block).toContain(`length=${q.height}`); expect(block).not.toContain('forceapproach');
        expect(inRuinFootprint(a, a.ruins)).toBe(true);
        expect(inRuinFootprint(a, runeAltarStaging(a))).toBe(false);
        if (a.name !== 'air') expect(runeAltarStaging(a)).toEqual(a.outside);
    }
    const mind = RUNE_ALTARS.find(a => a.name === 'mind')!;
    expect(mind.ruins).toEqual({ x: 2982, z: 3514, level: 0 });
    expect(ruinTarget(mind).at).toEqual({ x: 2981, z: 3513, level: 0 });
    expect(runeAltarStaging(mind)).toEqual({ x: 2980, z: 3511, level: 0 });
    expect(runeAltarStaging(RUNE_ALTARS[0]!)).toEqual(RUINS);
});

test('target is a bounded Runecraft level', () => {
    expect(runeBankTarget()).toBe(99); expect(runeBankTarget(20)).toBe(20);
    for (const v of [1, 100, NaN, 2.5]) expect(() => runeBankTarget(v)).toThrow('Runecraft target');
});
test('finite production options reject malformed orders before session access', async () => {
    expect(runeBankOptions()).toEqual({ cap: 20000 });
    expect(runeBankOptions({ altar: 'air', essenceTarget: 28 })).toEqual({ cap: 20000, altar: 'air', essenceTarget: 28 });
    for (const options of [{ altar: '' }, { altar: 'nature' }, { essenceTarget: 0 }, { essenceTarget: 1.5 }, { essenceTarget: Infinity }, { cap: 0 }]) {
        expect(() => runeBankOptions(options)).toThrow();
        await expect(runRuneBankCraft({} as Session, 99, options)).rejects.toThrow();
    }
});
test('production XP accepts the pinned rate and cap, and rejects missing or wrong-rate observations', () => {
    expect(runeBankXpBalanced(10_000, 13_500, 140)).toBe(true);
    expect(runeBankXpBalanced(199_999_900, 200_000_000, 140)).toBe(true);
    expect(runeBankXpBalanced(200_000_000, 200_000_000, 140)).toBe(true);
    expect(runeBankXpBalanced(10_000, 10_140, 140)).toBe(false);
    expect(runeBankXpBalanced(NaN, 10_000, 140)).toBe(false);
    expect(runeBankXpBalanced(200_000_001, 200_000_001, 0)).toBe(false);
});
test('odd mind, earth and body batches allow the hidden half XP phase of whole stat packets', () => {
    const encoder = readFileSync(new URL('../../../vendor/rs-sdk/server/engine/src/network/game/server/codec/UpdateStatEncoder.ts', import.meta.url), 'utf8');
    expect(encoder).toContain('buf.p4((message.exp / 10) | 0)');
    for (const altar of ['mind', 'earth', 'body']) {
        const recipe = RUNE_ALTARS.find(a => a.name === altar)!;
        for (const essCount of [1, 3, 27]) for (const phase of [0, 0.5]) {
            const actualInitial = 10_000 + phase, baseGain = essCount * recipe.xp;
            const initial = Math.floor(actualInitial), current = Math.floor(actualInitial + baseGain * 25);
            expect(runeBankXpBalanced(initial, current, baseGain)).toBe(true);
            expect(runeBankXpBalanced(initial, initial + Math.floor(baseGain * 25) - 1, baseGain)).toBe(false);
            expect(runeBankXpBalanced(initial, initial + Math.ceil(baseGain * 25) + 1, baseGain)).toBe(false);
            expect(runeBankXpBalanced(199_999_999, 200_000_000, baseGain)).toBe(true);
        }
    }
    expect(runeBankXpBalanced(10_000.5, 10_188, 7.5)).toBe(false);
    expect(runeBankXpBalanced(10_000, 10_187, 7.5)).toBe(true);
    expect(runeBankXpBalanced(10_187, 10_374, 7.5)).toBe(true);
    expect(runeBankXpBalanced(10_000, 10_374, 15)).toBe(false);
    expect(runeBankXpBalanced(10_000, 10_375, 15)).toBe(true);
});
test('essence spent equals the essence debit; banked runes equal the crafted output', () => {
    expect(runeBankBalanced(ledger())).toBe(true);
    expect(runeBankBalanced(ledger({ air: 90, crafted: 60 }))).toBe(true);
    expect(runeBankBalanced(ledger({ essence: 1 }))).toBe(false);
    expect(runeBankBalanced(ledger({ air: 59 }))).toBe(false);
    expect(runeBankBalanced(ledger({ crafted: 29, air: 59 }))).toBe(false);
});
test('the order ends at the target level or when the bank has no essence', () => {
    expect(runeBankDone(20, 20, 500)).toBe(true); expect(runeBankDone(5, 20, 0)).toBe(true); expect(runeBankDone(5, 20, 1)).toBe(false);
});
test('finite supply requires the exact debit regardless of level or exhausted stock', () => {
    expect(runeBankDone(99, 99, 0, 28, 0)).toBe(false);
    expect(runeBankDone(99, 99, 0, 28, 27)).toBe(false);
    expect(runeBankDone(1, 99, 20, 28, 28)).toBe(true);
    expect(runeBankDone(99, 99, 0, 28, 29)).toBe(false);
    const at99 = { ...bankBase, level0: 99, level: 99, essenceTarget: 30 };
    expect(runeBankOk({ ...at99, ledger: ledger() })).toBe(true);
    expect(runeBankOk({ ...at99, ledger: ledger({ essence0: 0, consumed: 0, crafted: 0, air: 30 }) })).toBe(false);
    expect(runeBankOk({ ...at99, essenceTarget: 31, ledger: ledger() })).toBe(false);
});
test('pass needs observed progress, an empty pack, no stop and a finished order', () => {
    expect(runeBankOk({ ...bankBase, ledger: ledger() })).toBe(true);
    expect(runeBankOk({ ...bankBase, ledger: undefined })).toBe(false);
    expect(runeBankOk({ ...bankBase, ledger: ledger(), stopped: true })).toBe(false);
    expect(runeBankOk({ ...bankBase, ledger: ledger(), held: { essence: 0, air: 3 } })).toBe(false);
    expect(runeBankOk({ ...bankBase, ledger: ledger(), bankEssence: 5 })).toBe(false);
    expect(runeBankOk({ ...bankBase, ledger: ledger({ essence0: 0, consumed: 0, crafted: 0, air: 30 }) })).toBe(false);
    expect(runeBankOk({ ...bankBase, level0: 99, level: 99, bankEssence: 7, ledger: ledger({ essence0: 7, essence: 7, consumed: 0, crafted: 0, air: 30 }) })).toBe(true);
});

test('explicit RUNE_ALTAR=cosmic validates pinned Zanaris ruins, Cosmic altar, and 2471 portal', () => {
    const root = new URL('../../../vendor/rs-sdk/server/content/', import.meta.url);
    const rows = readFileSync(new URL('scripts/skill_runecraft/configs/runecraft.dbrow', root), 'utf8');
    const pack = readFileSync(new URL('pack/obj.pack', root), 'utf8');
    const locPack = readFileSync(new URL('pack/loc.pack', root), 'utf8');
    const row = rows.split('[runecraft_cosmic]')[1]!.split('[')[0]!;
    const field = (name: string) => row.match(new RegExp(`^data=${name},(.+)$`, 'm'))![1]!.trim();
    expect(Number(field('level'))).toBe(COSMIC_ALTAR.level);
    expect(Number(field('experience')) / 10).toBe(COSMIC_ALTAR.xp);
    expect(Number(field('multiplier'))).toBe(COSMIC_ALTAR.multiplier);
    expect(pack).toContain(`${COSMIC_ALTAR.talisman}=cosmic_talisman`);
    expect(pack).toContain(`${COSMIC_ALTAR.rune}=cosmicrune`);
    expect(locPack).toContain('2458=cosmictemple_ruined');
    expect(locPack).toContain(`${COSMIC_ALTAR.portal}=cosmictemple_exit_portal`);
    const templeAltar = parseJm2('m33_75.jm2', readFileSync(new URL('maps/m33_75.jm2', root), 'utf8')).locs.find(l => l.id === 2484);
    expect(templeAltar).toMatchObject({ x: 2141, z: 4832, level: 0 });
    expect(Math.max(Math.abs(COSMIC_ALTAR.inside.x - templeAltar!.x), Math.abs(COSMIC_ALTAR.inside.z - templeAltar!.z))).toBeLessThanOrEqual(2);
    const { at, q } = ruinTarget(COSMIC_ALTAR), file = q.src.slice('maps/'.length);
    const placed = parseJm2(file, readFileSync(new URL(q.src, root), 'utf8')).locs.filter(l => l.id === q.id);
    expect(placed.map(({ x, z, level, shape, angle }) => ({ x, z, level, shape, angle }))).toEqual([{ ...at, shape: q.shape, angle: q.angle }]);
    expect(chooseRuneAltar(99, new Set([1454]), 'cosmic').altar).toBe(COSMIC_ALTAR);
    expect(() => chooseRuneAltar(26, new Set([1454]), 'cosmic')).toThrow('requires Runecraft27');
    expect(runeBankOptions({ altar: 'cosmic', essenceTarget: 27 }).altar).toBe('cosmic');
    expect(inZanarisCosmic({ worldX: 3173, worldZ: 9501, level: 0 })).toBe(true);
    expect(inZanarisCosmic({ worldX: 3152, worldZ: 9578, level: 0 })).toBe(true);
    expect(inZanarisCosmic({ worldX: 3092, worldZ: 3243, level: 0 })).toBe(false);
});

function productionCase(config: {
    inside?: 'air' | 'body'; altar?: 'air' | 'body'; heldEssence?: number; bankEssence?: number; target?: number;
    currentLevel?: number; xp?: number | null; rate?: number; airTalisman?: boolean;
} = {}) {
    const code = `
    import {mock} from 'bun:test';import {resolve} from 'node:path';
    const config=${JSON.stringify(config)},actions=[],withdrawals=[],recipes=[];
    let inventory=[],stored=new Map([[1436,config.bankEssence??40],[1438,config.airTalisman===false?0:1],[1446,1],[995,42],[556,3],[559,7]]),generation=1;
    let xp=config.xp===null?undefined:config.xp??200000000,currentLevel=config.currentLevel??99;
    const player={worldX:config.inside==='body'?2523:config.inside==='air'?2841:3013,worldZ:config.inside?4830:3355,level:0};
    const held=id=>inventory.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const slots=()=>inventory.forEach((i,slot)=>i.slot=slot);
    const add=(id,n)=>{if(id===1436)for(let i=0;i<n;i++)inventory.push({id,count:1});else{const item=inventory.find(i=>i.id===id);if(item)item.count+=n;else inventory.push({id,count:n});}slots();};
    add(1436,config.heldEssence??0);
    if(config.inside&&config.airTalisman!==false){const talisman=config.altar==='body'?1446:1438;stored.set(talisman,0);add(talisman,1);}
    const items=()=>[...stored].filter(([,count])=>count>0).map(([id,count])=>({id,count}));
    const st={player,bank:{isOpen:false,get items(){return items();}},get inventory(){return inventory;},nearbyLocs:[{id:2470,x:2523,z:4837,level:0,optionsWithIndex:[{opIndex:1,text:'Use'}]}]};
    const deposit=async(_s,item)=>{const n=held(item.id);inventory=inventory.filter(i=>i.id!==item.id);stored.set(item.id,(stored.get(item.id)??0)+n);generation++;slots();return n;};
    const craft=async()=>{
     const altar=player.worldX===2841?'air':'body',n=held(1436);recipes.push({altar,n});
     inventory=inventory.filter(i=>i.id!==1436);add(altar==='air'?556:559,n*(Math.floor(currentLevel/(altar==='air'?11:46))+1));
     xp=Math.min(200000000,xp+n*(altar==='air'?5:7.5)*(config.rate??25));return {success:true};
    };
    const s={name:'finite-rune-fixture',tick:()=>0,ended:new Promise(()=>{}),onTick:()=>()=>{},bankObservation:()=>({generation,items:items()}),
     sdk:{getState:()=>st,getInventory:()=>inventory,getSkill:()=>({baseLevel:99,level:currentLevel}),getSkillXp:()=>xp===undefined?undefined:Math.floor(xp),
      findNearbyLoc:()=>({id:2478,name:'Altar'}),findPath:()=>({success:true,reachedDestination:true}),
      sendInteractLoc:async()=>{actions.push('exit-body');player.worldX=3050;player.worldZ=3442;return {success:true};}},
     bot:{openBank:async()=>{actions.push('open-bank');st.bank.isOpen=true;generation++;return {success:true};},
      closeBank:async()=>{actions.push('close-bank');st.bank.isOpen=false;return {success:true};},
      withdrawItem:async(item,n)=>{withdrawals.push({id:item.id,n});stored.set(item.id,stored.get(item.id)-n);add(item.id,n);generation++;return {success:true};},
      dismissBlockingUI:async()=>{},interactLoc:craft,
      walkTo:async(x,z)=>{player.worldX=x;player.worldZ=z;return {success:true};}}};
    const modules={
     'packages/core/src/bot':{openBot:()=>{},finish:()=>{},getWorld:async()=>({}),accountOf:()=>({}),sessionDied:()=>false},
     'packages/core/src/ticks':{waitUntil:async(_s,p)=>p()},
     'packages/core/src/walk':{goTo:async(_s,_w,to)=>{player.worldX=to.x;player.worldZ=to.z;return {ok:true};},walkPath:async()=>({ok:true}),sessionWalker:async()=>({})},
     'packages/core/src/deposit':{depositObserved:deposit},
     'packages/core/src/world':{interactionApproach:async()=>({})},
     'packages/workers/src/runecraft/air':{insideAirAltar:p=>p.worldX===2841,enterAirAltar:async()=>{actions.push('enter-air');player.worldX=2841;player.worldZ=4830;},
      exitAirAltar:async()=>{actions.push('exit-air');player.worldX=2983;player.worldZ=3288;},craftAirRunes:async()=>{throw Error('XP-positive training action used for finite production');}}
    };
    for(const [path,module]of Object.entries(modules))mock.module(resolve(path),()=>module);
    console.log=()=>{};
    const {runRuneBankCraft}=await import('./packages/workers/src/runecraft/bank-craft');
    const result=await runRuneBankCraft(s,99,{altar:config.altar??'air',essenceTarget:config.target??28});
    process.stdout.write(JSON.stringify({result,withdrawals,recipes,actions,bank:Object.fromEntries(stored),held:inventory}));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', code], { cwd: REPO_ROOT, windowsHide: true, stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
    if (child.exitCode !== 0) throw Error(child.stderr.toString());
    return JSON.parse(child.stdout.toString());
}

test('RC99 and XP-capped suppliers produce the requested air quantity with a higher altar owned', () => {
    const r = productionCase();
    expect(r.result).toMatchObject({ ok: true, altar: 'air', essenceTarget: 28, consumed: 28, crafted: 280, xp: 0, xpBalanced: true, bankEssence: 12, held: { essence: 0, runes: 0 } });
    expect(r.withdrawals.filter((w: { id: number }) => w.id === 1436)).toEqual([{ id: 1436, n: 27 }, { id: 1436, n: 1 }]);
    expect(r.recipes).toEqual([{ altar: 'air', n: 27 }, { altar: 'air', n: 1 }]);
    expect(r.bank).toMatchObject({ 1436: 12, 1446: 1, 995: 42, 556: 283, 559: 7 });
    expect(r.held).toEqual([{ id: 1438, count: 1, slot: 0 }]);
});
test('production uses current Runecraft for the native output multiplier and clips XP to the cap', () => {
    const r = productionCase({ target: 2, currentLevel: 21, xp: 199_999_900 });
    expect(r.result).toMatchObject({ ok: true, consumed: 2, crafted: 4, xp: 100, xpBalanced: true });
});
test('odd body production accepts both native hidden phases while conserving exact rune output', () => {
    for (const [phase, gain] of [[0, 562], [0.5, 563]] as const) {
        const r = productionCase({ altar: 'body', inside: 'body', heldEssence: 3, target: 3, xp: 13_034_431 + phase });
        expect(r.result).toMatchObject({ ok: true, altar: 'body', consumed: 3, crafted: 9, xp: gain, xpBalanced: true });
        expect(r.recipes).toEqual([{ altar: 'body', n: 3 }]);
        expect(r.result.ledger.runes[559]).toEqual({ before: 7, after: 16, crafted: 9 });
    }
});
test('a resumed wrong altar exits with its essence intact and crafts only the requested rune', () => {
    const r = productionCase({ inside: 'body', heldEssence: 3, target: 2 });
    expect(r.actions[0]).toBe('exit-body');
    expect(r.recipes).toEqual([{ altar: 'air', n: 2 }]);
    expect(r.result).toMatchObject({ ok: true, consumed: 2, crafted: 20, bankEssence: 41 });
    expect(r.bank[559]).toBe(7);
});
test('oversized resumed essence is banked before an exact production batch', () => {
    const r = productionCase({ inside: 'air', heldEssence: 5, target: 2 });
    expect(r.actions[0]).toBe('exit-air');
    expect(r.recipes).toEqual([{ altar: 'air', n: 2 }]);
    expect(r.result).toMatchObject({ ok: true, consumed: 2, bankEssence: 43 });
});
test('a valid resumed production batch contributes to the aggregate debit and output', () => {
    const r = productionCase({ inside: 'air', heldEssence: 2, target: 2 });
    expect(r.recipes).toEqual([{ altar: 'air', n: 2 }]);
    expect(r.withdrawals.filter((w: { id: number }) => w.id === 1436)).toEqual([]);
    expect(r.result).toMatchObject({ ok: true, consumed: 2, crafted: 20, xpBalanced: true });
    expect(r.result.ledger.runes[556]).toEqual({ before: 3, after: 23, crafted: 20 });
});
test('insufficient stock or a missing requested talisman cannot pass at RC99 or spend essence', () => {
    for (const config of [{ bankEssence: 27 }, { airTalisman: false }]) {
        const r = productionCase(config);
        expect(r.result.ok).toBe(false); expect(r.recipes).toEqual([]);
        expect(r.withdrawals).toEqual([]);
        expect(r.result.failure).toContain('next acquisition:');
    }
});
test('missing XP blocks production before bank actions, and a wrong rate fails the receipt', () => {
    const unknown = productionCase({ xp: null });
    expect(unknown.result.ok).toBe(false); expect(unknown.actions).toEqual([]); expect(unknown.recipes).toEqual([]);
    expect(unknown.result.failure).toContain('entry Runecraft XP');
    const wrongRate = productionCase({ target: 2, xp: 13_034_431, rate: 1 });
    expect(wrongRate.result.ok).toBe(false); expect(wrongRate.result.failure).toContain('craft debit/credit/XP mismatch');
});

// =========================================================================
// Shilo Village Nature & Transit tests
// =========================================================================

const natureJob = (): NatureJob => ({ target: 4, batch: 2, cap: 2000, returnTicks: 400, reserve: 2, members: true, xpRate: 1 });

function natureConsumerFixture(options: { xpRate?: number; initialXp?: number; gain?: number } = {}) {
    const player = { worldX: 2852, worldZ: 2955, level: 0, lifeId: 1, respawnCount: 0, isDead: false };
    let open = false, generation = 0, opens = 0, xp = options.initialXp ?? 0;
    let rows = [{ id: 1436, count: 6 }, { id: 1462, count: 1 }, { id: 995, count: 15 }];
    const s: any = {
        client: { ingame: true, ifType: () => ({ colour: 0x00f800 }), membersAccount: 1 },
        tick: () => 0, ended: new Promise(() => {}),
        bankObservation: () => open ? { generation, items: rows } : null,
        sdk: { getState: () => ({ player, bank: { isOpen: open }, autoRetaliateEnabled: false }), getSkill: () => ({ level: 99 }), getSkillXp: () => xp, getEquipment: () => [], getInventory: () => [], sendCloseModal: async () => { open = false; return { success: true }; } },
        bot: { openBank: async () => { opens++; open = true; generation++; return { success: true }; }, closeBank: async () => { open = false; return { success: true }; } },
    };
    const runner: any = async () => {
        rows = [{ id: 1436, count: 2 }, { id: 1462, count: 1 }, { id: 995, count: 15 }, { id: 561, count: 8 }];
        xp = Math.min(NATURE_XP_CAP, xp + (options.gain ?? 36 * (options.xpRate ?? 1)));
        open = false;
        return { ok: true, completed: 4, trips: 2, atBank: true, banked: { 561: 8 }, failure: '-', ticks: 1 };
    };
    return { s, player, runner, opens: () => opens };
}

test('shared actual Shilo gate engine records unknown dispatch until exact landing settles', async () => {
    for (const unknown of [false, true]) {
        let tick = 0, inputs = 0; const player = { worldX: 2866, worldZ: 2953, level: 0 }, listeners = new Set<() => void>();
        const s: any = {
            tick: () => tick, onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
            sdk: { getState: () => ({ player, modalOpen: false, interface: { isOpen: false }, dialog: { isOpen: false }, nearbyLocs: [{ id: 2261, x: 2867, z: 2953, level: 0, optionsWithIndex: [{ text: 'Open', opIndex: 1 }] }] }), sendInteractLoc: async () => { inputs++; if (unknown) throw Error('transport unknown'); player.worldX = 2868; return { success: true }; } },
        };
        const transit = createShiloTransit(s, {}, () => true), timer = setInterval(() => { tick++; for (const cb of listeners) cb(); }, 1);
        try {
            const action = transit.cross({ id: 2261, x: 2867, z: 2953 }, { x: 2866, z: 2953 }, { x: 2868, z: 2953 }, () => false);
            if (unknown) { await expect(action).rejects.toThrow('transport unknown'); expect(transit.pending()).toBe(true); }
            else { await action; expect(transit.pending()).toBe(false); expect(tick).toBeGreaterThanOrEqual(2); }
            expect(inputs).toBe(1);
        } finally { clearInterval(timer); }
    }
});
test('Nature rejects the native partial fence endpoint instead of authorizing a straight fallback', () => {
    expect(naturePlanComplete({ x: 2852, z: 2955 }, { x: 2865, z: 3022 }, [{ x: 2859, z: 3006 }])).toBe(false);
    expect(naturePlanComplete({ x: 2880, z: 2952 }, { x: 2865, z: 3022 }, [{ x: 2796, z: 2960 }, { x: 2815, z: 3002 }, { x: 2865, z: 3022 }])).toBe(true);
    expect(naturePlanComplete({ x: 2852, z: 2955 }, { x: 2865, z: 3022 }, [])).toBe(false);
});
test('declared native undead-stockade protection requires real prayer points and base level before staging', () => {
    const f = natureConsumerFixture(); f.s.sdk.getState = () => ({ player: f.player, prayers: { prayerPoints: 99 } }); f.s.sdk.getSkill = () => ({ level: 99, baseLevel: 42 });
    expect(() => requireNatureEligibility(f.s, { ...natureJob(), protectMelee: true })).toThrow('protection');
    f.s.sdk.getSkill = () => ({ level: 99, baseLevel: 99 }); f.s.sdk.getState = () => ({ player: f.player, prayers: { prayerPoints: 5 } });
    expect(() => requireNatureEligibility(f.s, { ...natureJob(), protectMelee: true })).toThrow('protection');
    const native = readFileSync(resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/scripts/quests/quest_zombiequeen/configs/quest_zombiequeen.npc'), 'utf8');
    expect(native.split('[zqzombie_unarmed]')[1]!.split('\n[')[0]).toContain('param=damagetype,^slash_style');
});
test('native Shilo transit requires wooden gate, metal gate and the broken-cart Search hop', () => {
    const map = readFileSync(resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/maps/m44_46.jm2'), 'utf8');
    const source = readFileSync(resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/scripts/quests/quest_zombiequeen/scripts/quest_zombiequeen.rs2'), 'utf8');
    for (const row of ['0 51 9: 2261 0 2', '0 59 9: 2260 0', '0 61 7: 2216 10']) expect(map).toContain(row);
    expect(source).toContain('[oploc2,shilo_brokencart]'); expect(source).toContain('p_telejump(movecoord(loc_coord, 3, 0, 1))');
    expect(source).toContain('p_telejump(movecoord(loc_coord, -1, 0, 1))'); expect(source).toContain('^zombiequeen_complete');
});
test('Nature binds explicit native loc IDs/anchors and real Shilo banker, without table index arithmetic', () => {
    const pack = readFileSync(resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/pack/loc.pack'), 'utf8');
    expect(pack).toContain('2460=naturetemple_ruined'); expect(pack).toContain('2473=naturetemple_exit_portal'); expect(pack).toContain('2486=nature_altar');
    expect(readFileSync(resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/maps/m44_47.jm2'), 'utf8').split('==== LOC ====')[1]).toContain('0 52 10: 2460 10');
    expect(readFileSync(resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/maps/m37_75.jm2'), 'utf8').split('==== LOC ====')[1]).toContain('0 31 40: 2486 10 1');
    expect(readFileSync(resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/maps/m44_46.jm2'), 'utf8')).toContain('0 35 10: 499');
    expect(NATURE.bank).toEqual({ x: 2852, z: 2955, level: 0 });
    expect(natureRouteJob(natureJob()).family).toBe('nature-runecraft');
    for (const change of [{ members: false }, { batch: 28 }, { reserve: -1 }, { cap: 400 }, { target: 0 }, ...[-1, 0, NaN, Infinity, 1.5, 1001].map(xpRate => ({ xpRate }))]) {
        expect(() => natureRouteJob({ ...natureJob(), ...change })).toThrow();
    }
});
test('actual trip consumer reopens the closed/null final bank before its conserved asset audit', async () => {
    const f = natureConsumerFixture(); const result = await runNatureTrips(f.s, natureJob(), () => false, f.runner);
    expect(result.ok).toBe(true); expect(result.balanced).toBe(true); expect(result.preserved).toBe(true); expect(f.opens()).toBe(2); expect(f.s.bankObservation()).toBeNull();
});
test('replaced life or respawn in same player object cannot reopen bank or authorize portal cleanup', async () => {
    for (const field of ['lifeId', 'respawnCount'] as const) {
        const f = natureConsumerFixture(), runner: any = async () => { const result = await f.runner(); f.player[field]++; return result; };
        const result = await runNatureTrips(f.s, natureJob(), () => false, runner);
        expect(result.ok).toBe(false); expect(result.auditFailure).toContain('original life'); expect(f.opens()).toBe(1);
        const g = natureConsumerFixture(), p = natureProfile(g.s, natureJob()); let actions = 0;
        g.s.sdk.getInventory = () => [{ id: 1436, count: 2 }, { id: 1462, count: 1 }]; g.s.sdk.sendCloseModal = async () => { actions++; return { success: true }; };
        g.player.worldX = 2400; g.player.worldZ = 4835; g.player[field]++;
        await expect(p.run(2, 100, () => false)).rejects.toThrow(); expect(actions).toBe(0);
    }
});
test('failed fresh final bank stays incomplete rather than trusting a closed snapshot', async () => {
    const f = natureConsumerFixture(), runner: any = async () => { const result = await f.runner(); f.s.bot.openBank = async () => ({ success: false }); return result; };
    const result = await runNatureTrips(f.s, natureJob(), () => false, runner);
    expect(result.ok).toBe(false); expect(result.balanced).toBe(false); expect(result.auditFailure).toContain('fresh bank unavailable');
});
test('Nature transit refuses further movement after an observed first HP drop', async () => {
    const f = natureConsumerFixture(); let hp = 99, inputs = 0;
    f.s.sdk.getSkill = (name: string) => ({ level: name === 'Hitpoints' ? hp : 99 });
    f.s.direct = async () => { inputs++; return { success: true }; };
    const profile = natureProfile(f.s, natureJob()); hp = 98;
    await expect(profile.prepare!(() => false)).rejects.toThrow('Nature native walk stopped'); expect(inputs).toBe(0);
});
test('Nature native multiplier changes at91 independently of the declared world XP rate', () => {
    for (const rate of [1, 25]) {
        expect(natureReceipt(2, 2, 18 * rate, 44, rate)).toBe(true); expect(natureReceipt(2, 2, 18 * rate, 90, rate)).toBe(true);
        expect(natureReceipt(2, 4, 18 * rate, 91, rate)).toBe(true); expect(natureReceipt(2, 4, 18 * rate, 99, rate)).toBe(true);
        expect(natureReceipt(2, 2, 18 * rate, 99, rate)).toBe(false); expect(natureReceipt(2, 4, 19 * rate, 99, rate)).toBe(false);
    }
    expect(natureReceipt(2, 4, 450, 99)).toBe(true); expect(natureReceipt(2, 4, 18, 99)).toBe(false); expect(natureReceipt(0, 0, 0, 99)).toBe(false);
    expect(insideNature({ worldX: 2400, worldZ: 4835, level: 0 })).toBe(true); expect(insideNature({ worldX: 2865, worldZ: 3022, level: 0 })).toBe(false);
    const row = readFileSync(resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/scripts/skill_runecraft/configs/runecraft.dbrow'), 'utf8').split('[runecraft_nature]')[1]!.split('\n[')[0]!;
    for (const field of ['data=level,44', 'data=experience,90', 'data=multiplier,91', 'data=talisman,nature_talisman']) expect(row).toContain(field);
});
test('capped accounts still require exact essence and rune output without fictional XP gain', () => {
    expect(natureReceipt(2, 4, 50, 99, 25, NATURE_XP_CAP - 50)).toBe(true);
    expect(natureReceipt(2, 4, 0, 99, 25, NATURE_XP_CAP)).toBe(true);
    expect(natureReceipt(2, 3, 0, 99, 25, NATURE_XP_CAP)).toBe(false);
    expect(natureReceipt(2, 4, 450, 99, 25, NATURE_XP_CAP - 50)).toBe(false);
    for (const before of [-1, NaN, Infinity, NATURE_XP_CAP + 1]) expect(natureXpReceipt(2, 0, 25, before)).toBe(false);
    for (const rate of [0, -1, NaN, Infinity, 1.5, 1001]) expect(natureXpReceipt(2, 450, rate)).toBe(false);
    const engine = readFileSync(resolve(REPO_ROOT, 'vendor/rs-sdk/server/engine/src/engine/entity/Player.ts'), 'utf8');
    expect(engine).toContain('this.stats[stat] = 2_000_000_000');
});
test('whole-trip XP audit rejects wrong-rate success and accepts exact capped totals', async () => {
    for (const initialXp of [0, NATURE_XP_CAP - 50, NATURE_XP_CAP]) {
        const f = natureConsumerFixture({ xpRate: 25, initialXp }), result = await runNatureTrips(f.s, { ...natureJob(), xpRate: undefined }, () => false, f.runner);
        expect(result.ok).toBe(true); expect(result.xpBalanced).toBe(true); expect(result.runecraftXp).toBe(Math.min(900, NATURE_XP_CAP - initialXp));
    }
    const wrong = natureConsumerFixture(); const result = await runNatureTrips(wrong.s, { ...natureJob(), xpRate: 25 }, () => false, wrong.runner);
    expect(result.balanced).toBe(true); expect(result.preserved).toBe(true); expect(result.ok).toBe(false); expect(result.xpBalanced).toBe(false); expect(result.auditFailure).toContain('whole-trip XP receipt failed');
});
test('unknown starting XP refuses before any batch can consume owned essence', async () => {
    const f = natureConsumerFixture(); f.s.sdk.getSkillXp = () => null; let consumed = false;
    await expect(runNatureTrips(f.s, natureJob(), () => false, async () => { consumed = true; return f.runner(); })).rejects.toThrow('initial Runecraft XP unavailable');
    expect(consumed).toBe(false);
    const g = natureConsumerFixture(); g.s.sdk.getInventory = () => [{ id: 1436, count: 2 }, { id: 1462, count: 1 }]; g.s.sdk.getSkillXp = () => null;
    let sent = 0; g.s.sdk.sendUseItemOnLoc = async () => { sent++; return { success: true }; };
    const p = natureProfile(g.s, natureJob()); await expect(p.run(2, 100, () => false)).rejects.toThrow('pre-craft XP unavailable'); expect(sent).toBe(0);
});
test('quest, member and level preflight rejects before owned withdrawals or loc actions', () => {
    let actions = 0; const client: any = { ingame: true, ifType: () => ({ colour: 0x00f800 }), membersAccount: 1 }, s: any = { client, sdk: { getSkill: () => ({ level: 99 }) }, bot: { withdrawItem: () => { actions++; } } };
    expect(() => requireNatureEligibility(s, natureJob())).not.toThrow();
    client.ifType = () => ({ colour: 0xff0000 }); expect(() => natureProfile(s, natureJob())).toThrow('observed completed');
    client.ifType = () => ({ colour: 0x00f800 }); client.membersAccount = 0; expect(() => natureProfile(s, natureJob())).toThrow('member connection');
    client.membersAccount = 1; s.sdk.getSkill = () => ({ level: 43 }); expect(() => natureProfile(s, natureJob())).toThrow('Runecraft44'); expect(actions).toBe(0);
});
test('LiteClient membership uses the received account flag rather than full-client static configuration', () => {
    const f = natureConsumerFixture(); expect(() => requireNatureEligibility(f.s, natureJob())).not.toThrow();
    f.s.client.constructor = { memServer: true }; delete f.s.client.membersAccount;
    expect(() => requireNatureEligibility(f.s, natureJob())).toThrow('member connection');
    f.s.client.membersAccount = 0; expect(() => requireNatureEligibility(f.s, natureJob())).toThrow('member connection');
    f.s.client.membersAccount = 1; f.s.client.constructor.memServer = false; expect(() => requireNatureEligibility(f.s, natureJob())).not.toThrow();
});

function walkFixture(partialDetour = false, detourZ = 3) {
    let tick = 0;
    const player = { worldX: 0, worldZ: 0, level: 0 }, listeners = new Set<() => void>();
    const avoids: { x: number; z: number }[][] = [], clicks: { x: number; z: number }[] = [], segments: { from: { x: number; z: number }; to: { x: number; z: number } }[] = [];
    const s: any = { tick: () => tick, onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); }, sdk: { getState: () => ({ tick, player }) } };
    const deps: PathDeps = {
        tick: () => tick, pos: () => ({ x: player.worldX, z: player.worldZ, level: 0 }), onTick: s.onTick,
        plan: (_level, from, to, avoid) => { if (avoid?.length) { avoids.push([...avoid]); return partialDetour ? [{ x: from.x, z: detourZ }] : [{ x: from.x, z: detourZ }, { x: to.x, z: detourZ }, to]; } return [to]; },
        hunters: () => [{ x: 6, z: 0, r: 1 }], locs: () => [], reach: () => true,
        walk: (x, z) => { segments.push({ from: { x: player.worldX, z: player.worldZ }, to: { x, z } }); clicks.push({ x, z }); player.worldX = x; player.worldZ = z; return { success: true }; },
        interactLoc: () => { throw Error('unexpected gate interaction'); },
    };
    const advance = () => { tick++; for (const cb of [...listeners]) cb(); };
    return { s, deps, player, avoids, clicks, segments, advance };
}
test('Shilo native walk forwards live-hunter avoidance and completes the safe detour', async () => {
    const f = walkFixture(), transit = createShiloTransit(f.s, {}, () => true, async () => f.deps), timer = setInterval(f.advance, 1);
    try {
        await transit.walkNative({ x: 12, z: 0 }, () => false);
        expect(f.avoids.length).toBeGreaterThan(0); expect(f.avoids[0]).toContainEqual({ x: 6, z: 0 });
        expect(f.player).toEqual({ worldX: 12, worldZ: 0, level: 0 }); expect(f.clicks.length).toBeGreaterThan(0);
        expect(f.clicks.every(p => Math.max(Math.abs(p.x - 6), Math.abs(p.z)) > 1)).toBe(true);
        expect(f.segments.every(seg => expandPath(seg.from, [seg.to]).every(p => Math.max(Math.abs(p.x - 6), Math.abs(p.z)) > 1))).toBe(true);
    } finally { clearInterval(timer); }
});
test('Nature takes a complete long hunter detour immediately while other walkers retain the default hold', async () => {
    const f = walkFixture(false, 12), timer = setInterval(f.advance, 1);
    try { await createShiloTransit(f.s, {}, () => true, async () => f.deps).walkNative({ x: 12, z: 0 }, () => false); expect(f.player.worldX).toBe(12); expect(f.player.worldZ).toBe(0); } finally { clearInterval(timer); }
    const g = walkFixture(false, 12), holdTimer = setInterval(g.advance, 1);
    try { const result = await walkPath(g.deps, [{ x: 12, z: 0, tol: 0 }], { maxTicks: 10 }); expect(result.ok).toBe(false); expect(g.player.worldX).toBeLessThan(5); expect(g.player.worldZ).toBe(0); } finally { clearInterval(holdTimer); }
});
test('Shilo native walk rejects an incomplete hunter detour before dispatch', async () => {
    const f = walkFixture(true), transit = createShiloTransit(f.s, {}, () => true, async () => f.deps);
    await expect(transit.walkNative({ x: 12, z: 0 }, () => false)).rejects.toThrow('route stops short');
    expect(f.avoids.length).toBe(1); expect(f.clicks).toEqual([]);
});
test('Shilo native walk still refuses a stopped or changed life before planning', async () => {
    const f = walkFixture(); let plans = 0; const factory = async () => { plans++; return f.deps; };
    await expect(createShiloTransit(f.s, {}, () => true, factory).walkNative({ x: 12, z: 0 }, () => true)).rejects.toThrow('walk stopped');
    await expect(createShiloTransit(f.s, {}, () => false, factory).walkNative({ x: 12, z: 0 }, () => false)).rejects.toThrow('walk stopped');
    expect(plans).toBe(0); expect(f.clicks).toEqual([]);
});
function stockadeFixture(id = 504, x = 2872) {
    const f = walkFixture(), prayers = { activePrayers: Array(15).fill(false), prayerPoints: 40 }; prayers.activePrayers[14] = true;
    f.player.worldX = x - 2; f.player.worldZ = 2953;
    const state = f.s.sdk.getState;
    f.s.sdk.getState = () => ({ ...state(), prayers, nearbyNpcs: [{ id, x, z: 2953, tileX: x, tileZ: 2953 }] });
    f.deps.hunters = () => [{ x, z: 2953, r: 3 }];
    f.deps.plan = (_level, _from, to, avoid) => { if (avoid?.length) { f.avoids.push([...avoid]); return []; } return [to]; };
    return { ...f, prayers, goal: { x: x + 2, z: 2953 } };
}
test('only observed native stockade undead receive the actual declared melee protection exemption', async () => {
    for (const id of [504, 505]) {
        const f = stockadeFixture(id), timer = setInterval(f.advance, 1);
        try { await createShiloTransit(f.s, { protectMelee: true }, () => true, async () => f.deps).walkNative(f.goal, () => false); expect(f.avoids).toEqual([]); } finally { clearInterval(timer); }
    }
    for (const options of [{ id: 506 }, { x: 2890 }, { points: 9 }, { active: false }, { declared: false }]) {
        const f = stockadeFixture(options.id ?? 504, options.x ?? 2872);
        if (options.points !== undefined) f.prayers.prayerPoints = options.points;
        if (options.active === false) f.prayers.activePrayers[14] = false;
        await expect(createShiloTransit(f.s, { protectMelee: options.declared !== false }, () => true, async () => f.deps).walkNative(f.goal, () => false)).rejects.toThrow('route stops short');
        expect(f.avoids.length).toBe(1); expect(f.clicks).toEqual([]);
    }
});
test('loss of observed melee protection aborts the stockade walk before another movement input', async () => {
    const f = stockadeFixture(), walk = f.deps.walk; let inputs = 0;
    f.deps.walk = (x, z) => { inputs++; const reply = walk(f.player.worldX + 1, z); f.prayers.activePrayers[14] = false; return reply; };
    const timer = setInterval(f.advance, 1);
    try { await expect(createShiloTransit(f.s, { protectMelee: true }, () => true, async () => f.deps).walkNative(f.goal, () => false)).rejects.toThrow('Nature native route'); expect(inputs).toBe(1); } finally { clearInterval(timer); }
});

// =========================================================================
// Air Altar, Rune Mysteries & Supply Chain tests
// =========================================================================

test('air exit identity and all destinations match the pinned portal and air row', () => {
    const pinned = (path: string) => readFileSync(new URL('../../../vendor/rs-sdk/server/' + path, import.meta.url), 'utf8');
    expect(pinned('content/pack/loc.pack')).toMatch(/^2465=airtemple_exit_portal\r?$/m);
    expect(pinned('content/maps/m44_75.jm2')).toMatch(/^0 25 28: 2465 10\r?$/m);
    const air = pinned('content/scripts/skill_runecraft/configs/runecraft.dbrow').split('[runecraft_air]')[1]!.split('[runecraft_mind]')[0]!;
    const exits = air.split(/\r?\n/).filter(l => l.startsWith('data=exit_coord,'));
    expect(exits.length).toBe(1);
    for (const line of exits) {
        const [coord, ...offsets] = line.slice(16).split(','); expect(offsets).toEqual(['0', '0', '0']);
        const [level, rx, rz, x, z] = coord!.split('_').map(Number);
        expect(outsideAirAltar({ level: level!, worldX: rx! * 64 + x!, worldZ: rz! * 64 + z! })).toBe(true);
    }
});

async function airExitModel(mode: string, run: (s: any, calls: string[], logs: string[]) => Promise<void>) {
    let tick = 0, dispatch = -1;
    const callbacks = new Set<() => void>(), calls: string[] = [], logs: string[] = [];
    const portal = { id: 2465, x: 2841, z: 4828, name: 'Portal', optionsWithIndex: [{ text: 'Use', opIndex: 1 }] };
    const state: any = { player: { worldX: 2843, worldZ: 4832, level: 0, animId: 791, spotanimId: 186 }, dialog: { isOpen: false }, interface: { isOpen: false }, modalOpen: false, gameMessages: [], opFeedback: { opRejectedCount: 0 } };
    let essAmt = 1, air = 26, xp = 3250;
    Object.defineProperty(state, 'inventory', { get: () => [{ id: 1436, name: 'Rune essence', count: essAmt }, { id: 556, name: 'Air rune', count: air }] });
    const s: any = {
        tick: () => tick, ended: new Promise(() => {}), onTick: (cb: () => void) => { callbacks.add(cb); return () => callbacks.delete(cb); },
        sdk: {
            getState: () => state, findNearbyLoc: (pattern: RegExp) => pattern.test('Altar') ? { id: 2478, name: 'Altar' } : portal,
            getInventory: () => [{ id: 1436, name: 'Rune essence', count: essAmt }, { id: 556, name: 'Air rune', count: air }],
            getSkill: () => ({ level: 20 }), getSkillXp: () => xp,
            sendWalk: async (x: number, z: number) => { calls.push('walk'); expect([x, z]).toEqual([2841, 4829]); if (mode !== 'walk-unobserved') Object.assign(state.player, { worldX: x, worldZ: z }); return { success: true }; },
            findPath: (x: number, z: number) => ({ success: true, reachedDestination: mode !== 'partial', waypoints: [{ x, z, level: 0 }] }),
            sendInteractLoc: async (x: number, z: number, id: number, op: number) => {
                calls.push('use'); expect([x, z, id, op]).toEqual([2841, 4828, 2465, 1]);
                expect(state.player.worldX).toBe(2841); expect(state.player.worldZ).toBe(4829);
                dispatch = tick; return { success: mode !== 'refused', message: 'dispatch' };
            },
        },
        bot: {
            dismissBlockingUI: async () => {}, walkTo: async () => { throw Error('portal approach must use the observed raw walk'); },
            interactLoc: async (loc: any) => { if (loc.name === 'Altar') { calls.push('craft'); essAmt = 0; air = 28; xp = 3375; } else { calls.push('old-interact'); dispatch = tick; } return { success: true }; },
        },
    };
    const timer = setInterval(() => {
        tick++;
        if (tick === 3) state.player.animId = -1;
        if (dispatch >= 0 && tick === dispatch + 2) {
            if (mode === 'arrived') Object.assign(state.player, { worldX: 2983, worldZ: 3288 });
            if (mode === 'delayed-refusal') state.gameMessages.push({ text: "I can't reach that!", tick, observationId: tick + 100 });
            if (mode === 'rejected-op') state.opFeedback.opRejectedCount++;
            if (mode === 'wrong-arrival') Object.assign(state.player, { worldX: 2984, worldZ: 3288 });
        }
        for (const cb of [...callbacks]) cb();
    }, 1);
    const old = console.log; console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try { await run(s, calls, logs); } finally { console.log = old; clearInterval(timer); expect(callbacks.size).toBe(0); }
}

test('craft animation does not prove portal use; exact supported approach reaches outside', async () => {
    await airExitModel('arrived', async (s, calls, logs) => {
        await exitAirAltar(s);
        expect(calls).toEqual(['walk', 'use']);
        expect(logs.some(l => l.includes('"phase":"outside"'))).toBe(true);
        expect(logs.some(l => l.includes('"animId":791'))).toBe(true);
    });
});
test('real craft helper followed by stale crafting animation still requires observed portal arrival', async () => {
    await airExitModel('arrived', async (s, calls) => {
        expect(await craftAirRunes(s)).toMatchObject({ ok: true, consumed: 1, runes: 2, xp: 125 });
        expect(s.sdk.getState().player.animId).toBe(791);
        await exitAirAltar(s); expect(calls).toEqual(['craft', 'walk', 'use']);
    });
});
for (const [mode, error] of [['delayed-refusal', 'air portal rejected'], ['refused', 'air portal action refused'],
    ['rejected-op', 'air portal rejected'], ['unresolved', 'air portal exit unobserved'], ['wrong-arrival', 'air portal exit unobserved'],
    ['partial', 'air portal approach unavailable'], ['walk-unobserved', 'air portal approach unobserved']]) {
    test('portal failure is bounded without another unchanged dispatch: ' + mode, async () => {
        await airExitModel(mode!, async (s, calls) => {
            await expect(exitAirAltar(s)).rejects.toThrow(error!);
            expect(calls.filter(c => c === 'use').length).toBe(mode === 'partial' || mode === 'walk-unobserved' ? 0 : 1);
        });
    });
}
test('cancelled air exit sends no action', async () => {
    await airExitModel('unresolved', async (s, calls) => { await expect(exitAirAltar(s, () => true)).rejects.toThrow('air exit stopped'); expect(calls).toEqual([]); });
});
test('cancellation during observed portal wait cleans its observers', async () => {
    await airExitModel('unresolved', async (s, calls) => {
        let stopAt = Infinity;
        await expect(exitAirAltar(s, () => { if (calls.includes('use') && stopAt === Infinity) stopAt = s.tick() + 2; return s.tick() >= stopAt; })).rejects.toThrow('air exit stopped');
        expect(calls).toEqual(['walk', 'use']);
    });
});

test('idle169/170 cannot settle the queued level-up171 or its rejected approach', async () => {
    const code = `
    import {mock} from 'bun:test';import {resolve} from 'node:path';
    mock.module(resolve('packages/core/src/bot'),()=>({openBot:()=>{},finish:()=>{},countItems:()=>0}));
    let tick=167,dialog=false,rejected=0,walkAt=-1,dispatchAt=-1,closedAt=-1,levelAt=171;
    let player={worldX:2843,worldZ:4832,level:0,animId:791};
    const walks=[],dispatches=[],observations=[];
    const advance=()=>{tick++;if(tick>=169)player.animId=-1;
     if(tick===levelAt){dialog=true;rejected++;walkAt=-1;}
     if(walkAt>=0&&tick>walkAt&&closedAt>=171&&!dialog)
      player={worldX:2841,worldZ:4829,level:0,animId:-1};
     if(dispatchAt>=0&&tick>dispatchAt)player={worldX:2983,worldZ:3288,level:0,animId:-1};
     observations.push({tick,dialog,rejected,player:{...player}});
    };
    mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p,{timeoutTicks})=>{
     if(p())return true;for(let i=0;i<timeoutTicks;i++){advance();if(p())return true;}return false;
    }}));
    const {exitAirAltar}=await import('./packages/workers/src/runecraft/air');
    const s={tick:()=>tick,onTick:()=>()=>{},sdk:{
     getState:()=>({player,dialog:{isOpen:dialog},interface:{isOpen:dialog},modalOpen:dialog,
      opFeedback:{opRejectedCount:rejected,mapFlagUnsetCount:6+rejected},
      gameMessages:tick>=levelAt?[{text:'Congratulations, you just advanced a runecraft level.',tick:levelAt,observationId:213}]:[]}),
     findNearbyLoc:()=>({id:2465,x:2841,z:4828,optionsWithIndex:[{opIndex:1,text:'Use'}]}),
     findPath:()=>({success:true,reachedDestination:true}),
     sendWalk:async(x,z)=>{walkAt=tick;walks.push({tick,x,z,closedAt});return {success:true};},
     sendInteractLoc:async()=>{dispatchAt=tick;dispatches.push({tick,dialog,player:{...player}});return {success:true};}},
     bot:{dismissBlockingUI:async()=>{if(dialog){dialog=false;closedAt=tick;}}}};
    const rows=[];
    for(levelAt of [171,174]){
     tick=167;dialog=false;rejected=0;walkAt=dispatchAt=closedAt=-1;
     player={worldX:2843,worldZ:4832,level:0,animId:791};walks.length=dispatches.length=observations.length=0;
     await exitAirAltar(s);
     rows.push({levelAt,walks:[...walks],dispatches:[...dispatches],observations:[...observations],closedAt,player});
    }
    console.log('LEVEL_RESULT '+JSON.stringify(rows));
    `;
    const child = await fixtureChild(code, 30000);
    if (child.exitCode !== 0) throw Error(child.stderr);
    const rows = JSON.parse(child.stdout.split(/\r?\n/).find(l => l.startsWith('LEVEL_RESULT '))!.slice(13));
    for (const row of rows) {
        expect(row.observations.filter((o: { tick: number }) => o.tick === 169 || o.tick === 170).map((o: any) => [o.player.animId, o.dialog])).toEqual([[-1, false], [-1, false]]);
        expect(row.observations.find((o: { tick: number }) => o.tick === row.levelAt)).toMatchObject({ dialog: true, rejected: 1, player: { worldX: 2843, worldZ: 4832 } });
        expect(row.closedAt).toBe(row.levelAt); expect(row.walks).toHaveLength(row.levelAt === 171 ? 1 : 2);
        expect(row.walks.at(-1).tick).toBeGreaterThan(row.closedAt);
        if (row.levelAt === 174) expect(row.walks[0].tick).toBeLessThan(row.closedAt);
        expect(row.dispatches).toHaveLength(1);
        expect(row.dispatches[0]).toMatchObject({ dialog: false, player: { worldX: 2841, worldZ: 4829, animId: -1 } });
        expect(row.dispatches[0].tick).toBeGreaterThan(row.walks.at(-1).tick + 1);
        expect(row.player).toMatchObject({ worldX: 2983, worldZ: 3288 });
    }
}, 40_000);

test('air exit settles the delayed craft and waypoint trace before one portal dispatch', async () => {
    const code = `
    import {mock} from 'bun:test';import {resolve} from 'node:path';
    let tick=171,mode='',walkAt=-1,dispatchAt=-1,closes=0;
    mock.module(resolve('packages/core/src/bot'),()=>({openBot:()=>{},finish:()=>{},countItems:()=>0}));
    let player,dialog,faceTicks=0;const walks=[],dispatches=[];
    const portal={id:2465,x:2841,z:4828,optionsWithIndex:[{opIndex:1,text:'Use'}]};
    const state=()=>({player,dialog:{isOpen:dialog},interface:{isOpen:dialog},gameMessages:
     mode==='rejected'&&dispatchAt>=0&&tick>dispatchAt?[{text:"I can't reach that!",tick,observationId:tick}]:[]});
    const advance=()=>{tick++;
     if(tick===175)dialog=true;
     if(tick>=177)player.animId=-1;
     if(walkAt>=0&&tick>walkAt){
      const dz=mode==='drift'&&faceTicks++===1?4831:4829;
      player={worldX:dz===4829?2841:2842,worldZ:dz,level:0,animId:-1};
     }
     if(dispatchAt>=0&&mode!=='rejected'&&mode!=='no-effect'&&tick>dispatchAt)
      player={worldX:2983,worldZ:3288,level:0,animId:-1};
    };
    mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p,{timeoutTicks})=>{
     if(p())return true;for(let i=0;i<timeoutTicks;i++){advance();if(p())return true;}return false;
    }}));
    const {exitAirAltar}=await import('./packages/workers/src/runecraft/air');
    const results=[];
    for(mode of ['trace','drift','rejected','no-effect','stopped']){
     tick=171;walkAt=dispatchAt=-1;faceTicks=closes=0;walks.length=dispatches.length=0;
     player={worldX:2843,worldZ:4832,level:0,animId:791};dialog=false;
     const s={tick:()=>tick,onTick:()=>()=>{},sdk:{getState:state,findNearbyLoc:()=>portal,
      findPath:()=>({success:true,reachedDestination:true}),
      sendWalk:async(x,z)=>{walks.push({tick,x,z});walkAt=tick;return {success:true};},
      sendInteractLoc:async()=>{dispatchAt=tick;dispatches.push({tick,player:{...player},dialog});return {success:true};}},
      bot:{dismissBlockingUI:async()=>{if(dialog){closes++;dialog=false;}},
       walkTo:async()=>{while(tick<177)advance();player={worldX:2841,worldZ:4829,level:0,animId:-1};walkAt=177;return {success:true};}}};
     let error='';try{await exitAirAltar(s,()=>mode==='stopped'&&tick>=176);}catch(e){error=String(e);}
     results.push({mode,error,closes,walks:[...walks],dispatches:[...dispatches],player});
    }
    console.log('TRACE_RESULT '+JSON.stringify(results));
    `;
    const child = await fixtureChild(code, 30000);
    if (child.exitCode !== 0) throw Error(child.stderr);
    const rows = JSON.parse(child.stdout.split(/\r?\n/).find(l => l.startsWith('TRACE_RESULT '))!.slice(13));
    for (const row of rows) {
        if (row.mode === 'stopped') { expect(row.error).toContain('air exit stopped'); expect(row.dispatches).toHaveLength(0); continue; }
        expect(row.closes).toBe(1); expect(row.walks).toHaveLength(1);
        expect(row.walks[0].tick).toBeGreaterThanOrEqual(177);
        expect(row.walks[0]).toMatchObject({ x: 2841, z: 4829 }); expect(row.dispatches).toHaveLength(1);
        expect(row.dispatches[0]).toMatchObject({ player: { worldX: 2841, worldZ: 4829, animId: -1 }, dialog: false });
        expect(row.dispatches[0].tick).toBeGreaterThan(row.walks[0].tick + 1);
        if (row.mode === 'rejected') expect(row.error).toContain('rejected after dispatch; no unchanged retry');
        else if (row.mode === 'no-effect') expect(row.error).toContain('air portal exit unobserved');
        else { expect(row.error).toBe(''); expect(row.player).toMatchObject({ worldX: 2983, worldZ: 3288 }); }
    }
    expect(rows.find((r: { mode: string }) => r.mode === 'drift').dispatches[0].tick).toBeGreaterThan(rows[0].dispatches[0].tick);
}, 40_000);

test('finite supply targets include 20 and 50; invalid inputs fail before login', () => {
    expect(runeSupplyTarget()).toBe(20); expect(runeSupplyTarget(50)).toBe(50);
    for (const n of [NaN, Infinity, 0, 1, 20.1, 100]) expect(() => runeSupplyTarget(n)).toThrow('2..99');
});
test('starter assets remain counted across pack, equipment and bank', () => {
    const before = runeSupplyAssets([{ id: 1265, count: 1 }, { id: 556, count: 25 }, { id: 995, count: 25 }, { id: 315, count: 1 }]);
    expect(runeSupplyPreserved(before, { 1265: 1, 556: 52, 995: 25 })).toBe(true);
    for (const changed of [{ 1265: 0, 556: 52, 995: 25 }, { 1265: 1, 556: 24, 995: 25 }, { 1265: 1, 556: 52, 995: 24 }]) expect(runeSupplyPreserved(before, changed)).toBe(false);
});
test('starting runes, partial essence depletion and XP alone cannot prove crafting', () => {
    expect(airCraftEffects(27, 0, 25, 52, 0, 135)).toBe(true);
    for (const args of [[0, 0, 25, 25, 0, 0], [27, 1, 25, 52, 0, 135], [27, 0, 25, 25, 0, 135], [27, 0, 25, 52, 10, 10]])
        expect(airCraftEffects(...args as [number, number, number, number, number, number])).toBe(false);
});
test('air location excludes the essence mine and ordinary surface', () => {
    expect(insideAirAltar({ worldX: 2841, worldZ: 4830, level: 0 })).toBe(true);
    for (const p of [{ worldX: 2891, worldZ: 4847, level: 0 }, { worldX: 2985, worldZ: 3292, level: 0 }, { worldX: 2841, worldZ: 4830, level: 1 }]) expect(insideAirAltar(p)).toBe(false);
});
test('craft refuses wrong location even with essence and old runes', async () => {
    const s: any = { sdk: { getState: () => ({ inventory: [{ id: 1436 }], player: { worldX: 2985, worldZ: 3292, level: 0 } }), getInventory: () => [{ id: 1436 }], getSkill: () => ({ level: 1 }) } };
    await expect(craftAirRunes(s)).rejects.toThrow('inside-altar');
});
test('starter surface entry performs no registration shortcuts or floor edits', async () => {
    const s: any = { sdk: { getState: () => ({ player: { worldX: 3222, worldZ: 3218, level: 0 } }) } };
    await leaveRuneStarter(s, () => false);
    await expect(leaveRuneStarter(s, () => true)).rejects.toThrow('stopped');
});

const starterGrant = [1351, 590, 303, 315, 1925, 1931, 2309, 1265, 1205, 1277, 1171, 841].map(id => ({ id, count: 1 }))
    .concat([{ id: 882, count: 25 }, { id: 556, count: 25 }, { id: 558, count: 15 }, { id: 555, count: 6 }, { id: 557, count: 4 }, { id: 559, count: 2 }]);
async function starterModel(mode: string, run: (s: any, actions: string[], tick: () => number, logs: string[]) => Promise<void>) {
    let tick = 0, nextPage = 0, landing = 0, grant = 0;
    const actions: string[] = [], logs: string[] = [], listeners = new Set<() => void>();
    const closed = () => ({ isOpen: false, isWaiting: false, options: [] as any[], pageId: 'closed' });
    const state: any = { inGame: true, modalOpen: false, modalInterface: -1, player: { worldX: 3094, worldZ: 3106, level: 0 }, dialog: closed(), inventory: [], nearbyNpcs: [{ index: 1, name: 'RuneScape Guide', optionsWithIndex: [{ text: 'Talk-to', opIndex: 1 }] }] };
    const s: any = {
        tick: () => tick, onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); }, ended: new Promise(() => {}),
        client: { ingame: true, ifType: () => ({ colour: state.inventory.length ? 0xf80000 : 0xff0000 }) },
        sdk: {
            getState: () => state, getDialog: () => state.dialog, getInventory: () => state.inventory,
            sendAcceptCharacterDesign: async () => { actions.push('design'); expect(state.modalOpen).toBe(true); state.modalOpen = false; state.modalInterface = -1; return { success: true }; },
            sendInteractNpc: async () => { actions.push('talk'); state.dialog = { isOpen: true, isWaiting: mode === 'waiting', pageId: 'narration', options: mode === 'waiting' ? [] : [{ index: 1, text: 'Click here to continue', buttonType: 6, componentId: 9 }] }; return { success: true }; },
            sendClickDialog: async (index: number) => { actions.push('continue' + index); expect(state.dialog.isWaiting).toBe(false); state.dialog.isWaiting = true; nextPage = tick + 2; return { success: true }; },
            clickDialogByText: async (pattern: RegExp) => { actions.push('yes'); expect(state.dialog.options.some((o: any) => pattern.test(o.text))).toBe(true); landing = tick + 2; grant = tick + (mode === 'delayed-grant' ? 5 : 2); state.dialog = { ...closed(), isOpen: true, isWaiting: true }; return { success: true }; },
        },
        bot: { talkTo: async () => { throw Error('use bounded observed guide dispatch'); } },
    };
    const timer = setInterval(() => {
        tick++;
        if (tick === 3 && mode !== 'designed') { state.modalOpen = true; state.modalInterface = 3559; }
        if (nextPage && tick === nextPage) state.dialog = { isOpen: true, isWaiting: false, pageId: 'choice', options: mode === 'unsupported' ? [{ index: 1, text: 'Tell me about this place.', buttonType: 1 }] : [{ index: 1, text: 'Yes please.', buttonType: 1 }, { index: 2, text: 'No, thank you.', buttonType: 1 }] };
        if (landing && tick === landing) { state.player = { worldX: 3222, worldZ: 3222, level: 0 }; state.dialog = closed(); }
        if (grant && tick === grant && mode !== 'missing-grant') state.inventory = starterGrant;
        for (const cb of [...listeners]) cb();
    }, 1);
    const old = console.log; console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try { await run(s, actions, () => tick, logs); } finally { console.log = old; clearInterval(timer); }
}
for (const mode of ['normal', 'delayed-grant']) {
    test(`starter observes delayed design, continuation, waiting, choice and real grant: ${mode}`, async () => {
        await starterModel(mode, async (s, actions, tick, logs) => {
            await leaveRuneStarter(s, () => false);
            expect(actions).toEqual(['design', 'talk', 'continue0', 'yes']);
            expect(tick()).toBeGreaterThanOrEqual(7);
            expect(logs.some(l => l.startsWith('RUNE_SUPPLY_STARTER ') && l.includes('"isWaiting":true'))).toBe(true);
            expect(logs.some(l => l.includes('Yes please.'))).toBe(true);
        });
    });
}
test('starter refuses unsupported choices with their actual text retained', async () => {
    await starterModel('unsupported', async (s, actions, _tick, logs) => {
        await expect(leaveRuneStarter(s, () => false)).rejects.toThrow('unsupported tutorial choice');
        expect(actions).toEqual(['design', 'talk', 'continue0']);
        expect(logs.some(l => l.includes('Tell me about this place.'))).toBe(true);
    });
});
test('waiting page has a hard tick deadline without clicks or claiming skip is unavailable', async () => {
    await starterModel('waiting', async (s, actions, tick) => {
        await expect(leaveRuneStarter(s, () => false)).rejects.toThrow('starter entry deadline');
        expect(tick()).toBeLessThanOrEqual(100); expect(actions).toEqual(['design', 'talk']);
    });
});
test('cancellation during delayed modal publication sends no character or dialogue action', async () => {
    await starterModel('normal', async (s, actions, tick) => {
        await expect(leaveRuneStarter(s, () => tick() >= 2)).rejects.toThrow('stopped during starter exit'); expect(actions).toEqual([]);
    });
});
test('mainland arrival without the actual starter grant cannot admit training', async () => {
    await starterModel('missing-grant', async (s, _actions, tick) => {
        await expect(leaveRuneStarter(s, () => false)).rejects.toThrow('starter entry deadline'); expect(tick()).toBeLessThanOrEqual(100);
    });
});
test('a registered starter whose design is already accepted can resume the guide', async () => {
    await starterModel('designed', async (s, actions, tick) => {
        await leaveRuneStarter(s, () => false); expect(actions).toEqual(['talk', 'continue0', 'yes']); expect(tick()).toBeGreaterThanOrEqual(15);
    });
});
test('cancellation while waiting for the guide sends no further action', async () => {
    await starterModel('waiting', async (s, actions, tick) => {
        await expect(leaveRuneStarter(s, () => tick() >= 10)).rejects.toThrow('stopped during starter exit');
        expect(actions).toEqual(['design', 'talk']);
    });
});
test('a stale guarded choice is retained and refused without an index fallback', async () => {
    await starterModel('normal', async (s, actions, _tick, logs) => {
        s.sdk.clickDialogByText = async () => ({ success: false, reason: 'stale_dialog', message: 'page changed' });
        await expect(leaveRuneStarter(s, () => false)).rejects.toThrow('stale_dialog');
        expect(actions).toEqual(['design', 'talk', 'continue0']); expect(logs.some(l => l.includes('Yes please.'))).toBe(true);
    });
});

async function preparationModel(mode: string) {
    let tick = 0, generation = 0, cookedRaw = 0, cookingXp = 0, due = 0, dispatches = 0;
    const cookingOrder: string[] = [];
    const realCooking = cooking.cookStarterChickens, settlementMode = ['late-cooked', 'late-burnt', 'unresolved'].includes(mode);
    const callbacks = new Set<() => void>(), withdrawals: { id: number; amount: number }[] = [];
    const item = (id: number, count = 1) => ({ id, count, name: String(id), slot: 0, optionsWithIndex: [] });
    const inventory = [...Array.from({ length: 10 }, () => item(2138)), item(315), item(2309), item(1265)];
    const equipment = [item(1277), ...(!['mixed', 'missing', 'carried'].includes(mode) ? [item(1171)] : [])];
    if (mode === 'consumable-equipped') equipment.push(item(2138, 10), item(315));
    if (mode === 'carried') { equipment.length = 0; inventory.push(item(1277), item(1171)); }
    const bank = mode === 'missing' ? [] : [...(mode === 'equipped' || mode === 'carried' || mode === 'consumable-equipped' ? [] : [item(1171)])];
    const state: any = {
        tick, player: { worldX: 3092, worldZ: 3243, level: 0, combatLevel: 15, hp: 17, maxHp: 17, lifeId: 1, respawnCount: 0 },
        inventory, bank: { isOpen: false, items: bank }, skills: [{ name: 'Cooking', experience: 0, level: 1 }],
        nearbyLocs: [{ id: 2724, name: 'Fireplace', x: 3214, z: 3249 }], gameMessages: [],
    };
    const count = (items: typeof inventory, id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const s: any = {
        name: 'preparation-model', tick: () => tick, ended: new Promise(() => {}), client: { ingame: true, ifType: () => ({ colour: 0xf80000 }) },
        onTick: (cb: () => void) => { callbacks.add(cb); return () => callbacks.delete(cb); },
        bankObservation: () => ({ generation, at: tick, items: bank }),
        sdk: {
            getState: () => state, getInventory: () => inventory, getEquipment: () => equipment, getSkillXp: (name: string) => name === 'Cooking' ? cookingXp : 0, getDialog: () => ({ isOpen: false }),
            sendUseItemOnLoc: async () => { dispatches++; cookingOrder.push('dispatch'); due = tick + 2; return { success: true }; },
            getSkill: (name: string) => ({ level: name === 'Hitpoints' ? 17 : 1, baseLevel: name === 'Hitpoints' ? 17 : 1 }),
        },
        bot: {
            useItemOnLoc: async () => { await s.sdk.sendUseItemOnLoc(); return { success: true }; },
            openBank: async () => { state.bank.isOpen = true; generation++; return { success: true }; }, closeBank: async () => { state.bank.isOpen = false; return { success: true }; },
            depositItem: async (i: { id: number }) => { const n = count(inventory, i.id), old = bank.find(b => b.id === i.id); if (old) old.count += n; else bank.push(item(i.id, n)); for (let j = inventory.length - 1; j >= 0; j--) if (inventory[j]!.id === i.id) inventory.splice(j, 1); generation++; return { success: true }; },
            withdrawItem: async (i: { id: number }, amount: number) => { withdrawals.push({ id: i.id, amount }); const b = bank.find(b => b.id === i.id)!; if (mode !== 'no-debit') b.count -= amount; inventory.push(item(i.id, mode === 'short-credit' ? amount - 1 : amount)); if (mode !== 'stale-generation') generation++; return { success: true }; },
        },
    };
    const spies = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockResolvedValue({ ok: true } as any),
        spyOn(cooking, 'cookStarterChickens').mockImplementation(async (session, stop, options) => {
            cookedRaw = count(inventory, 2138);
            if (settlementMode) { tick = 999; return realCooking(session, stop, options); }
            if (['missing-food-output', 'burnt-food-output'].includes(mode)) inventory.find(i => i.id === 2138)!.count--;
            if (mode === 'burnt-food-output') inventory.push(item(2144));
            throw Error('preparation reached cooking');
        }),
    ];
    const timer = setInterval(() => {
        state.tick = ++tick;
        if (settlementMode && tick === 1000) cookingOrder.push('cap');
        if (tick === due && mode !== 'unresolved') {
            cookingOrder.push('conversion');
            inventory.find(i => i.id === 2138)!.count--; inventory.push(item(mode === 'late-burnt' ? 2144 : 2140));
            if (mode === 'late-cooked') { cookingXp = 750; state.skills = [{ name: 'Cooking', experience: 750, level: 8 }]; }
        }
        for (const cb of [...callbacks]) cb();
    }, 1);
    try {
        const result = structuredClone(await runRuneSupply(s, 20, {
            ...(settlementMode ? { cap: 1000 } : {}),
            deps: {
                trainChickens: async () => { throw Error('unneeded training acquisition'); },
                runRuneMysteries: async () => { throw Error('unexpected quest invocation'); },
            },
        }));
        cookingOrder.push('snapshot');
        if (settlementMode) await new Promise<void>(resolve => { const off = s.onTick(() => { off(); resolve(); }); });
        cookingOrder.push('logout');
        const saved = structuredClone({ inventory, equipment, cookingXp });
        return { result, withdrawals, cookedRaw, inventory, bank, equipment, saved, dispatches, cookingOrder };
    } finally { clearInterval(timer); for (const spy of spies) spy.mockRestore(); }
}

for (const mode of ['late-cooked', 'late-burnt', 'unresolved']) {
    test(`worker accounts for the accepted cooking use before its final snapshot and owner logout: ${mode}`, async () => {
        const r = await preparationModel(mode), burnt = mode === 'late-burnt', unresolved = mode === 'unresolved';
        expect(r.result.ok).toBe(false); expect(r.result.stopReason).toBe('tick-cap'); expect(r.dispatches).toBe(1);
        expect(r.result.ticks).toBe(unresolved ? 1007 : 1001);
        expect(r.result.stages.food).toMatchObject({ ok: false, raw: 10, consumed: unresolved ? 0 : 1, cooked: mode === 'late-cooked' ? 1 : 0, burnt: burnt ? 1 : 0, xp: mode === 'late-cooked' ? 750 : 0, remainingRaw: unresolved ? 10 : 9 });
        expect(r.result.final.inventory).toEqual(r.saved.inventory); expect(r.result.final.equipment).toEqual(r.saved.equipment);
        expect(r.result.final.skills?.find((s: any) => s.name === 'Cooking')?.experience).toBe(r.saved.cookingXp);
        if (unresolved) { expect(r.result.stages.food).toMatchObject({ settlement: 'unresolved' }); expect(r.result.failure).toContain('settlement unresolved'); }
        else { expect(r.result.failure).toContain('stopped after settled conversion'); expect(r.cookingOrder).toEqual(['dispatch', 'cap', 'conversion', 'snapshot', 'logout']); }
    });
}
for (const mode of ['equipped', 'mixed', 'carried', 'consumable-equipped']) {
    test(`starter preparation reuses owned kit and ten raw chickens: ${mode}`, async () => {
        const r = await preparationModel(mode);
        expect(r.result.stage).toBe('bootstrap-food'); expect(r.result.failure).toContain('preparation reached cooking');
        expect(r.result.stages.training).toEqual({ ok: true, resumed: true }); expect(r.cookedRaw).toBe(10);
        expect(r.withdrawals.filter(i => [1277, 1171].includes(i.id))).toEqual(mode === 'mixed' ? [{ id: 1171, amount: 1 }] : []);
        expect(r.withdrawals.filter(i => [2138, 315, 2309].includes(i.id))).toEqual([{ id: 2138, amount: 10 }, { id: 315, amount: 1 }, { id: 2309, amount: 1 }]);
        for (const id of [2138, 315, 2309]) expect(r.bank.find(i => i.id === id)?.count).toBe(0);
    });
}
test('starter preparation refuses a truly absent shield with its exact acquisition need', async () => {
    const r = await preparationModel('missing'); expect(r.result.ok).toBe(false);
    expect(r.result.failure).toBe('Error: next acquisition: owned item1171 needs1, bank has0');
    expect(r.withdrawals).toEqual([]); expect(r.cookedRaw).toBe(0);
});
for (const mode of ['no-debit', 'short-credit', 'stale-generation']) {
    test(`starter withdrawal refuses unmatched accounting: ${mode}`, async () => {
        const r = await preparationModel(mode); expect(r.result.ok).toBe(false);
        expect(r.result.failure).toBe('Error: withdraw debit/credit unobserved item2138'); expect(r.cookedRaw).toBe(0);
    });
}
for (const mode of ['missing-food-output', 'burnt-food-output']) {
    test(`bootstrap failure retains observed output without inventing burns: ${mode}`, async () => {
        const r = await preparationModel(mode); expect(r.result.ok).toBe(false); expect(r.result.stage).toBe('bootstrap-food');
        expect(r.result.stages.food).toMatchObject({ ok: false, raw: 10, consumed: 1, cooked: 0, burnt: mode === 'burnt-food-output' ? 1 : 0, xp: 0, remainingRaw: 9, acquisition: { itemId: 2138, minimum: 1 } });
    });
}

for (const mode of ['retained', 'mined', 'cancel-outbound', 'recovery']) {
    test(`essence reaches the existing crafting consumer once: ${mode}`, async () => {
        let generation = 1, rcXp = mode === 'recovery' ? 3250 : 0, stopped = false, walks = 0, trainCalls = 0, questCalls = 0;
        const item = (id: number, count = 1) => ({ id, count, slot: 0, name: id === 1436 ? 'Rune essence' : id === 556 ? 'Air rune' : String(id) });
        const inventory = mode === 'recovery' ? [item(556, 26), item(1438), item(315)] : mode === 'mined' ? [] : [item(1436, 26), item(1438), item(315)];
        const bank = mode === 'recovery' ? [item(556, 25)] : mode === 'mined' ? [item(1438), item(315), item(556, 25)] : [item(1436), item(556, 25)];
        const equipment = [item(1265), item(1171)], callbacks = new Set<() => void>();
        const state: any = { inventory, player: { worldX: mode === 'recovery' ? 2842 : 3133, worldZ: mode === 'recovery' ? 4831 : 3313, level: 0, hp: 17, maxHp: 17, combatLevel: 15, lifeId: 1, respawnCount: 0 }, bank: { isOpen: false, items: bank } };
        const s: any = {
            name: 'retained-model', tick: () => 0, ended: new Promise(() => {}), onTick: (cb: () => void) => { callbacks.add(cb); return () => callbacks.delete(cb); },
            client: { ingame: true, ifType: () => ({ colour: 0x00f800 }) }, bankObservation: () => ({ generation, items: bank }),
            sdk: {
                getState: () => state, getInventory: () => inventory, getEquipment: () => equipment, getSkillXp: (name: string) => name === 'Runecraft' ? rcXp : 0,
                getSkill: (name: string) => ({
                    level: name === 'Hitpoints' ? 17 : name === 'Runecraft' && mode === 'recovery' ? (rcXp === 3250 ? 20 : 21) : name === 'Runecraft' && rcXp > 0 ? 18 : 1,
                    baseLevel: name === 'Hitpoints' ? 17 : name === 'Runecraft' && mode === 'recovery' ? (rcXp === 3250 ? 20 : 21) : name === 'Runecraft' && rcXp > 0 ? 18 : 1,
                }),
            },
            bot: {
                openBank: async () => { state.bank.isOpen = true; generation++; return { success: true }; }, closeBank: async () => { state.bank.isOpen = false; return { success: true }; },
                depositItem: async (i: { id: number }) => { const n = inventory.filter(a => a.id === i.id).reduce((sum, a) => sum + a.count, 0), b = bank.find(a => a.id === i.id); if (b) b.count += n; else bank.push(item(i.id, n)); for (let j = inventory.length - 1; j >= 0; j--) if (inventory[j]!.id === i.id) inventory.splice(j, 1); generation++; return { success: true }; },
                withdrawItem: async (i: { id: number }, n: number) => { bank.find(a => a.id === i.id)!.count -= n; inventory.push(item(i.id, n)); generation++; return { success: true }; },
            },
        };
        const spies = [
            spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
            spyOn(walking, 'walkPath').mockImplementation(async (_w, points) => { walks++; if (mode === 'cancel-outbound' && walks === 3) { stopped = true; return { ok: false, detail: 'stopped' } as any; } const p = points.at(-1)!; state.player.worldX = p.x; state.player.worldZ = p.z; return { ok: true } as any; }),
            spyOn(essence, 'runEssenceGatherer').mockImplementation(async () => { bank.push(item(1436, 27)); generation++; return { ok: true, totalMined: 27, totalBanked: 27, held: 0, trips: 1, died: false, failure: '-' }; }),
            spyOn(altarActions, 'enterAirAltar').mockResolvedValue(),
            spyOn(altarActions, 'exitAirAltar').mockResolvedValue(),
            spyOn(altarActions, 'craftAirRunes').mockImplementation(async () => {
                const used = inventory.filter(i => i.id === 1436).reduce((n, i) => n + i.count, 0);
                for (let j = inventory.length - 1; j >= 0; j--) if (inventory[j]!.id === 1436) inventory.splice(j, 1);
                inventory.push(item(556, used)); rcXp += 125 * used; return { ok: true, consumed: used, runes: used, xp: 125 * used, ticks: 1 };
            }),
        ];
        const deps = {
            trainChickens: async () => { trainCalls++; throw Error('must not train'); },
            runRuneMysteries: async () => { questCalls++; throw Error('must not repeat quest'); },
        };
        try {
            const r = await runRuneSupply(s, mode === 'recovery' ? 20 : 2, { stop: () => stopped, deps });
            if (mode === 'recovery') {
                expect(r).toMatchObject({ ok: true, banked: 26, inheritedBanked: 26, newBanked: 0, crafted: 0, consumed: 0, mined: 0, xp: { runecraft: 0 } });
                expect(bank.find(i => i.id === 556)?.count).toBe(51); expect(inventory.some(i => i.id === 556)).toBe(false);
                expect(spies[2]).not.toHaveBeenCalled(); expect(spies[5]).not.toHaveBeenCalled();
                const higher = await runRuneSupply(s, 21, { deps });
                expect(higher).toMatchObject({ ok: true, inheritedBanked: 0, newBanked: 26, banked: 26, crafted: 26, consumed: 26, mined: 27 });
                expect(higher.xp?.runecraft).toBe(3250); expect(bank.find(i => i.id === 556)?.count).toBe(77);
                expect(equipment.map(i => i.id)).toEqual([1265, 1171]); expect(callbacks.size).toBe(0); return;
            }
            if (r.failure && !stopped) throw Error(r.failure);
            expect(trainCalls).toBe(0); expect(questCalls).toBe(0);
            expect(spies[2]).toHaveBeenCalledTimes(mode === 'mined' ? 1 : 0);
            if (mode === 'cancel-outbound') { expect(r.ok).toBe(false); expect(r.stopReason).toBe('operator'); expect(spies[5]).not.toHaveBeenCalled(); }
            else {
                expect(r.ok).toBe(true); expect(r.mined).toBe(mode === 'mined' ? 27 : 0); expect(r.consumed).toBe(26); expect(r.crafted).toBe(26); expect(r.banked).toBe(26);
                expect(bank.find(i => i.id === 1436)?.count).toBe(1); expect(bank.find(i => i.id === 556)?.count).toBe(51); expect(spies[5]).toHaveBeenCalledTimes(1);
            }
            expect(callbacks.size).toBe(0);
        } finally { for (const spy of spies) spy.mockRestore(); }
    });
}

test('starting talisman is not completion; package handoff interruption resumes notes', () => {
    expect(runeMysteriesDecision('started', [1438])).toBe('talisman');
    expect(runeMysteriesDecision('not started', [1438])).toBe('duke');
    expect(runeMysteriesDecision('unknown', [1438])).toBe('observe');
    expect(runeMysteriesDecision('started', [290])).toBe('package');
    expect(runeMysteriesDecision('started', [])).toBe('sedridor');
    expect(runeMysteriesDecision('started', [291])).toBe('notes');
    expect(runeMysteriesDecision('complete', [])).toBe('complete');
});
test('Sedridor names the stage of a started quest with no items', () => {
    const saw = (...texts: string[]) => (re: RegExp) => texts.some(t => re.test(t));
    expect(sedridorOutcome(true, saw())).toBe('package');
    expect(sedridorOutcome(false, saw('I think perhaps you should go and speak to him again then, adventurer.'))).toBe('aubury');
    expect(sedridorOutcome(false, saw('I suggest you go and speak to Aubury once more, with luck he will have made copies of his research.'))).toBe('aubury');
    expect(sedridorOutcome(false, saw('Hmmm? You are a very odd person. Come back again when you have found it.'))).toBe('duke');
    expect(sedridorOutcome(false, saw("Sure, I'll go and get them from the bank."))).toBe('bank');
    expect(sedridorOutcome(false, saw("Welcome adventurer, to the world renowned Wizards' Tower."))).toBe('unknown');
});
test("the nearest ground-floor bank: Draynor from the Wizards' Tower, Varrock East from Aubury", () => {
    const banks = [{ x: 3092, z: 3243, level: 0 }, { x: 3254, z: 3420, level: 0 }, { x: 3185, z: 3440, level: 0 }, { x: 3208, z: 3220, level: 2 }];
    expect(nearestBankTile({ x: 3109, z: 3167 }, banks)).toEqual({ x: 3092, z: 3243, level: 0 });
    expect(nearestBankTile({ x: 3253, z: 3401 }, banks)).toEqual({ x: 3254, z: 3420, level: 0 });
});
test('any combat level may start; below 13 the walk goes straight to the target', async () => {
    for (const combat of [undefined, 3, 12, 13]) expect(runeMysteriesStartProblem(combat)).toBeNull();
    const seen: any[] = []; await walkRuneMysteries({ worldX: 3092, worldZ: 3243, level: 0, combatLevel: 3 }, { x: 3205, z: 3209, tol: 2 }, async point => { seen.push(point); });
    expect(seen).toEqual([{ x: 3205, z: 3209, tol: 2 }]);
});
test('Draynor to the Duke uses the proved north corridor instead of the jail shortcut', () => {
    const route = runeMysteriesWalk({ worldX: 3092, worldZ: 3243, level: 0 }, { x: 3205, z: 3209, tol: 2 });
    expect(route).toContainEqual({ x: 3089, z: 3320, tol: 1 });
    expect(route).toContainEqual({ x: 3180, z: 3320, tol: 0 });
    expect(route.at(-1)).toEqual({ x: 3205, z: 3209, tol: 2 });
});
test('Varrock and tower walking legs reuse both low-level corridors to avoid the wizard circle', () => {
    const home = { x: 3221, z: 3218, tol: 2 };
    const down = runeMysteriesWalk({ worldX: 3253, worldZ: 3398, level: 0 }, home);
    expect(down).toContainEqual({ x: 3171, z: 3427, tol: 0 });
    expect(down).toContainEqual({ x: 3198, z: 3370, tol: 0 }); expect(down.at(-1)).toEqual(home);
    const up = runeMysteriesWalk({ worldX: 3109, worldZ: 3166, level: 0 }, { x: 3253, z: 3420, tol: 2 });
    expect(up).toContainEqual({ x: 3089, z: 3320, tol: 1 }); expect(up).toContainEqual({ x: 3171, z: 3427, tol: 0 });
});
test('leaving the tower stays east of the Draynor wizards before taking the north corridor', () => {
    const route = runeMysteriesWalk({ worldX: 3109, worldZ: 3167, level: 0 }, { x: 3253, z: 3420, tol: 2 });
    expect(route.slice(0, 3)).toEqual([{ x: 3097, z: 3212, tol: 0 }, { x: 3096, z: 3230, tol: 0 }, { x: 3092, z: 3243, tol: 0 }]);
    expect(route).toContainEqual({ x: 3089, z: 3320, tol: 1 });
});
test('Lumbridge to the tower avoids the live bear damage point and the Draynor jail shortcut', () => {
    const to = { x: 3109, z: 3167, tol: 1 };
    const route = runeMysteriesWalk({ worldX: 3221, worldZ: 3218, level: 0 }, to);
    for (const p of [{ x: 3226, z: 3250, tol: 0 }, { x: 3180, z: 3258, tol: 0 }, { x: 3100, z: 3285, tol: 0 }, { x: 3092, z: 3243, tol: 0 }, { x: 3096, z: 3230, tol: 0 }, { x: 3097, z: 3212, tol: 0 }])
        expect(route).toContainEqual(p);
    expect(route.at(-1)).toEqual(to);
});
test('the Draynor tower approach uses the walkable bank-side lane; unknown floors are refused', () => {
    const to = { x: 3109, z: 3167, tol: 1 };
    expect(runeMysteriesWalk({ worldX: 3092, worldZ: 3243, level: 0 }, to)).toEqual([{ x: 3096, z: 3230, tol: 0 }, { x: 3097, z: 3212, tol: 0 }, to]);
    expect(runeMysteriesWalk({ worldX: 3141, worldZ: 3212, level: 0 }, to)).toEqual([{ x: 3097, z: 3212, tol: 0 }, to]);
    expect(() => runeMysteriesWalk(undefined, to)).toThrow('position');
    expect(() => runeMysteriesWalk({ worldX: 3092, worldZ: 3243, level: 1 }, to)).toThrow('surface');
});
test('a failed corridor leg cannot fall back directly to the final destination', async () => {
    const seen: PathPoint[] = [];
    await expect(walkRuneMysteries({ worldX: 3092, worldZ: 3243, level: 0, combatLevel: 20 }, { x: 3205, z: 3209, tol: 2 }, async point => { seen.push(point); throw Error('route failure'); })).rejects.toThrow('route failure');
    expect(seen).toEqual([{ x: 3092, z: 3250, tol: 0 }]);
    const completed: PathPoint[] = [];
    await walkRuneMysteries({ worldX: 3092, worldZ: 3243, level: 0, combatLevel: 20 }, { x: 3205, z: 3209, tol: 2 }, async point => { completed.push(point); });
    expect(completed).toContainEqual({ x: 3089, z: 3320, tol: 1 }); expect(completed.at(-1)).toEqual({ x: 3205, z: 3209, tol: 2 });
});
test('a server restart while carrying the package resumes the western Varrock corridor', () => {
    const route = runeMysteriesWalk({ worldX: 3220, worldZ: 3270, level: 0 }, { x: 3212, z: 3424, tol: 2 });
    expect(route[0]).toEqual({ x: 3230, z: 3298, tol: 0 });
    const west = route.findIndex(p => p.x === 3198 && p.z === 3370);
    const north = route.findIndex(p => p.x === 3171 && p.z === 3427);
    expect(west).toBeGreaterThan(0); expect(north).toBeGreaterThan(west);
    expect(route.at(-1)).toEqual({ x: 3212, z: 3424, tol: 2 });
});
test('tower exit waits for the surface objects, then crosses the inner door before opening the outer one', async () => {
    const calls: string[] = []; let ready = false, inner = false, inHall = false;
    await exitRuneTower({
        waitForLanding: async () => { ready = true; calls.push('observed'); return true; },
        openDoor: async (_label, x, _z) => { expect(ready).toBe(true); if (x === 3107) { inner = true; calls.push('inner'); } else { expect(inHall).toBe(true); calls.push('outer'); } },
        dash: async (_label, _x, z) => { expect(inner).toBe(true); if (z === 3164) { inHall = true; calls.push('hall'); } else calls.push('outside'); },
    });
    expect(calls).toEqual(['observed', 'inner', 'hall', 'outer', 'outside']);
    const actions: string[] = [];
    await expect(exitRuneTower({ waitForLanding: async () => false, openDoor: async () => { actions.push('door'); }, dash: async () => { actions.push('walk'); } })).rejects.toThrow('landing');
    expect(actions).toEqual([]);
});

// =========================================================================
// Carrier Altar, Roster, Stage Contract, Cancel, Trade, Pipeline & Continuation tests
// =========================================================================

const contentDir = join(REPO_ROOT, 'vendor/rs-sdk/server/content');
const readContent = (path: string) => readFileSync(join(contentDir, path), 'utf8');
const contentPack = (type: string) => new Map(readContent(`pack/${type}.pack`).split(/\r?\n/).map(l => l.split('=')).filter(p => p.length === 2).map(([id, name]) => [name!, Number(id)]));
function contentDbrows() {
    const rows = new Map<string, Map<string, string[]>>(); let current: Map<string, string[]> | undefined;
    for (const line of readContent('scripts/skill_runecraft/configs/runecraft.dbrow').split(/\r?\n/)) {
        const head = /^\[runecraft_(\w+)\]$/.exec(line); if (head) { current = new Map(); rows.set(head[1]!, current); continue; }
        const data = /^data=(\w+),(.*)$/.exec(line); if (data && current && !current.has(data[1]!)) current.set(data[1]!, [data[2]!]);
    }
    return rows;
}
const dbCoord = (text: string) => { const [level, mx, mz, lx, lz] = text.split(',')[0]!.split('_').map(Number); return { level: level!, x: mx! * 64 + lx!, z: mz! * 64 + lz! }; };
function altarPlacements(id: number, x: number, z: number) {
    const square = `m${Math.floor(x / 64)}_${Math.floor(z / 64)}`, out: { x: number; z: number; shape: number }[] = [];
    for (const line of readContent(`maps/${square}.jm2`).split(/\r?\n/)) {
        const m = /^0 (\d+) (\d+): (\d+) (\d+)/.exec(line);
        if (m && Number(m[3]) === id) out.push({ x: Math.floor(x / 64) * 64 + Number(m[1]), z: Math.floor(z / 64) * 64 + Number(m[2]), shape: Number(m[4]) });
    }
    return out;
}

test('every runecraft.dbrow row is a carrier altar or an unsupported altar with a reason', () => {
    const names = [...contentDbrows().keys()].sort(), listed = [...RUNE_CARRIER_ALTARS.map(a => a.name), ...UNSUPPORTED_CARRIER_ALTARS.map(a => a.name)].sort();
    expect(listed).toEqual(names);
    expect(RUNE_CARRIER_ALTARS.map(a => a.name as string).sort()).toEqual(RUNE_ALTARS.map(a => a.name).sort());
    for (const u of UNSUPPORTED_CARRIER_ALTARS) expect(u.reason.length).toBeGreaterThan(20);
    expect(() => carrierAltar('law')).toThrow('Entrana');
});
test('each carrier altar row matches runecraft.dbrow, the obj and loc packs, the maps and RUNE_ALTARS', () => {
    const rows = contentDbrows(), objs = contentPack('obj'), locs = contentPack('loc');
    for (const a of RUNE_CARRIER_ALTARS) {
        const r = rows.get(a.name)!, field = (c: string) => r.get(c)?.[0];
        expect({ name: a.name, members: Number(field('members')), level: Number(field('level')), xpTenths: Number(field('experience')), rune: objs.get(field('rune')!), talisman: objs.get(field('talisman')!), multiplier: field('multiplier') === undefined ? null : Number(field('multiplier')), enter: dbCoord(field('enter_coord')!) })
            .toEqual({ name: a.name, members: 0, level: a.level, xpTenths: a.xpTenths, rune: a.rune, talisman: a.talisman, multiplier: a.multiplier, enter: { level: 0, ...a.enter } });
        expect(locs.get(`${a.name}_altar`)).toBe(a.altar.id);
        expect(altarPlacements(a.altar.id, a.enter.x, a.enter.z)).toEqual([{ x: a.altar.x, z: a.altar.z, shape: 10 }]);
        const legacy = RUNE_ALTARS.find(row => row.name === a.name)!;
        expect({ level: legacy.level, xp: legacy.xp * 10, rune: legacy.rune, talisman: legacy.talisman, inside: { x: legacy.inside.x, z: legacy.inside.z } })
            .toEqual({ level: a.level, xp: a.xpTenths, rune: a.rune, talisman: a.talisman, inside: a.enter });
    }
});
test('the carriers bank is the travel cache nearest bank of the ruins', () => {
    const travel = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/planner/src/haggis-travel.json'), 'utf8'));
    for (const a of RUNE_CARRIER_ALTARS) {
        const near = travel.nearestBank[`${a.name}-ruins`], site = travel.banks[near.bank];
        expect({ site: near.bank, x: site.x, z: site.z }).toEqual({ site: a.bank.site, x: a.bank.x, z: a.bank.z });
    }
});
test('body keeps the pipeline numbers it was built with', () => {
    expect(BODY_CARRIER_ALTAR).toMatchObject({ rune: 559, talisman: 1446, altar: { id: 2483 }, bank: { x: 3094, z: 3491 }, crafter: { x: 2523, z: 4832 }, staging: { x: 2523, z: 4833 } });
    for (const level of [20, 45, 46, 91, 92, 99]) expect(runesPerEssence(BODY_CARRIER_ALTAR, level)).toBe(Math.floor(level / 46) + 1);
    expect(carrierXpPerEssence(BODY_CARRIER_ALTAR, 25)).toBe(25 * 7.5);
    expect(insideCarrierAltar(BODY_CARRIER_ALTAR, { worldX: 2523, worldZ: 4833, level: 0 })).toBe(true);
    expect(insideCarrierAltar(BODY_CARRIER_ALTAR, { worldX: 3053, worldZ: 3445, level: 0 })).toBe(false);
});
test('air multiples and XP follow runecraft.rs2: two runes from 11, three from 22', () => {
    const air = carrierAltar('air');
    expect([1, 10, 11, 21, 22, 44].map(l => runesPerEssence(air, l))).toEqual([1, 1, 2, 2, 3, 5]);
    expect(carrierXpPerEssence(air, 25)).toBe(125);
    expect(insideCarrierAltar(air, { worldX: 2842, worldZ: 4834, level: 0 })).toBe(true);
});
test('the staged mode names one altar and a target level after the roster', () => {
    const names = ['Runner', 'CarrierB', 'CarrierC'];
    expect(runeCarrierRoster([...names, '--staged=air:44'])).toEqual(names);
    expect(runeCarrierStaged('--staged=fire:30')).toEqual({ altar: 'fire', target: 30 });
    expect(runeCarrierStaged('--carriers')).toBeUndefined();
    for (const mode of ['--staged=air', '--staged=air:1', '--staged=air:100', '--staged=Air:44', '--staged=air:044']) expect(() => runeCarrierRoster([...names, mode])).toThrow();
    expect(() => runeCarrierRoster([...names, '--carriers', '--staged=air:44'])).toThrow();
});
beforeAll(async () => { await loadPathfinding(); }, 120_000);
test('the crafter and staging tiles are walkable and reachable from the entry tile', () => {
    initPathfinding();
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
    for (const a of RUNE_CARRIER_ALTARS) {
        const key = (x: number, z: number) => x + ',' + z, seen = new Set([key(a.enter.x, a.enter.z)]), queue: [number, number][] = [[a.enter.x, a.enter.z]];
        while (queue.length) {
            const [x, z] = queue.shift()!;
            for (const [dx, dz] of DIRS) {
                const nx = x + dx, nz = z + dz;
                if (Math.abs(nx - a.altar.x) > 15 || Math.abs(nz - a.altar.z) > 20 || seen.has(key(nx, nz)) || !rsmod.canTravel(0, x, z, dx, dz, 1, 0, CollisionType.NORMAL)) continue;
                seen.add(key(nx, nz)); queue.push([nx, nz]);
            }
        }
        expect({ altar: a.name, crafter: seen.has(key(a.crafter.x, a.crafter.z)), staging: seen.has(key(a.staging.x, a.staging.z)), centre: seen.has(key(a.altar.x + 1, a.altar.z + 1)) })
            .toEqual({ altar: a.name, crafter: true, staging: true, centre: false });
    }
}, 60_000);

const freshSkills = Array.from({ length: 21 }, (_, i) => ({ name: i === 3 ? 'Hitpoints' : 'Skill' + i, baseLevel: i === 3 ? 10 : 1, experience: i === 3 ? 980 : 0 }));
test('the composed worker uses the complete ordered supervisor roster', () => {
    expect(runeCarrierRoster(['Wandwaver', 'Shaftsinker', 'Bigchopper', '--carriers'])).toEqual(['Wandwaver', 'Shaftsinker', 'Bigchopper']);
    for (const args of [['Wandwaver', '--carriers'], ['Wandwaver', 'Shaftsinker', 'shaftsinker', '--carriers'], ['Wandwaver', '99', '--carriers', 'extra']]) expect(() => runeCarrierRoster(args)).toThrow();
    expect(() => runeCarrierRoster(['Wandwaver', ...Array.from({ length: 17 }, (_, i) => 'helper' + i), '--carriers'])).toThrow();
});
test('bounded body measurements require an explicit12..48 pack mode and the retained16 helpers', () => {
    const names = ['Wandwaver', ...Array.from({ length: 16 }, (_, i) => 'helper' + i)];
    for (const n of [12, 13, 37, 48]) expect(runeCarrierRoster([...names, '--body-measure=' + n])).toEqual(names);
    for (const mode of ['--body-measure=0', '--body-measure=11', '--body-measure=49', '--body-measure=013', '--body-measure=NaN', '--body-measure=13.5']) expect(() => runeCarrierRoster([...names, mode])).toThrow();
    expect(() => runeCarrierRoster([...names.slice(1), '--body-measure=13'])).toThrow();
    expect(() => runeCarrierRoster([...names, '--body-continuation', '--body-measure=13'])).toThrow();
});
test('a missing or trained skill refuses the fresh route', () => {
    expect(() => assertFreshRuneSkills(freshSkills)).not.toThrow();
    expect(() => assertFreshRuneSkills(freshSkills.slice(1))).toThrow();
    expect(() => assertFreshRuneSkills(freshSkills.map((s, i) => i === 20 ? { ...s, experience: 1 } : s))).toThrow();
    expect(() => assertFreshRuneSkills(freshSkills.map((s, i) => i === 0 ? { ...s, baseLevel: 2 } : s))).toThrow();
});
test('the opening donor is checked before the fresh account logs in', () => {
    const player = { worldX: 3222, worldZ: 3223, level: 0 }, inventory = [{ id: 1438, count: 1 }, ...Array.from({ length: 27 }, () => ({ id: 1436, count: 1 }))];
    expect(() => assertRuneDonor(player, inventory)).not.toThrow();
    expect(() => assertRuneDonor({ ...player, worldZ: 3200 }, inventory)).toThrow();
    expect(() => assertRuneDonor(player, inventory.slice(1))).toThrow();
    expect(() => assertRuneDonor(player, [...inventory, { id: 995, count: 1 }])).toThrow();
});

test('tower and Lumbridge staging entries approach the bank west of the jail guards', () => {
    for (const p of [{ worldX: 3109, worldZ: 3167, level: 0 }, { worldX: 3223, worldZ: 3218, level: 0 }, { worldX: 3248, worldZ: 3193, level: 0 }])
        expect(runeStageBankApproach(p)).toEqual([{ x: 3097, z: 3225 }, { x: 3097, z: 3247 }]);
    for (const p of [{ worldX: 3094, worldZ: 3491, level: 0 }, { worldX: 3050, worldZ: 3442, level: 0 }, { worldX: 3113, worldZ: 9555, level: 0 }, { worldX: 3109, worldZ: 3167, level: 1 }])
        expect(runeStageBankApproach(p)).toEqual([]);
});
test('cohort assets accept omitted empty fixture equipment but reject item or equipment changes', () => {
    const before = parsePracticeSave(createSaveData({ bank: [{ id: 1436, count: 469 }, { id: 995, count: 4321 }, { id: 590, count: 1 }] }));
    expect(before.inventories[94]).toBeUndefined();
    for (const moved of [0, 162]) {
        const after = structuredClone(before); after.inventories[93] = []; after.inventories[94] = []; after.inventories[95]![0]!.count -= moved;
        expect(runeCohortAssetsPreserved(before, after, -moved)).toBe(true);
        const lost = structuredClone(after); lost.inventories[95]![1]!.count--;
        expect(runeCohortAssetsPreserved(before, lost, -moved)).toBe(false);
        const extra = structuredClone(after); extra.inventories[94] = [{ slot: 2, id: 552, count: 1 }];
        expect(runeCohortAssetsPreserved(before, extra, -moved)).toBe(false);
    }
    const worn = parsePracticeSave(createSaveData({ equipment: [{ slot: 2, id: 552, count: 1 }] }));
    expect(runeCohortAssetsPreserved(worn, structuredClone(worn), 0)).toBe(true);
    const banked = structuredClone(worn); banked.inventories[94] = []; banked.inventories[95] = [{ slot: 0, id: 552, count: 1 }];
    expect(runeCohortAssetsPreserved(worn, banked, 0)).toBe(false);
    const shifted = structuredClone(worn); shifted.inventories[94]![0]!.slot = 3;
    expect(runeCohortAssetsPreserved(worn, shifted, 0)).toBe(false);
});
test('observed skull-room entry exits upward before surface staging with only the finite reserve', async () => {
    const shortfall = runeCarrierShortfall([{ id: 1436, count: 243 }, { id: 1446, count: 1 }]);
    const required = runeStageRequirement('existing-cohort', [shortfall]);
    expect(shortfall).toEqual({ essence: 162, talismans: 0 });
    expect(required).toEqual({ essence: 162, talismans: 0, airTalismans: 0 });
    expect(469 - required.essence).toBe(307);
    expect(runeStageRequirement(undefined, [shortfall])).toEqual({ essence: 594, talismans: 2, airTalismans: 1 });
    expect(() => runeStageRequirement('existing', [])).toThrow('RUNE_STAGE_PURPOSE');
    let p = { worldX: 3113, worldZ: 9555, level: 0 }; const calls: string[] = [];
    const io = {
        position: () => p, openDoor: async (_label: string, x: number, z: number) => { calls.push(`door ${x},${z}`); },
        dash: async (_label: string, x: number, z: number, _tol: number) => { calls.push(`walk ${x},${z}`); p = { worldX: x, worldZ: z, level: 0 }; },
        climb: async () => { calls.push('climb 2148'); p = { worldX: 3105, worldZ: 3162, level: 0 }; }, waitForLanding: async () => true,
    };
    await exitRuneStageBasement(io);
    expect(calls).toEqual(['door 3111,9559', 'walk 3110,9559', 'walk 3109,9570', 'door 3108,9570', 'walk 3104,9576', 'climb 2148', 'door 3107,3162', 'walk 3108,3164', 'door 3109,3166', 'walk 3109,3167']);
    p = { worldX: 3113, worldZ: 9555, level: 0 }; calls.length = 0;
    await expect(exitRuneStageBasement({ ...io, climb: async () => {} })).rejects.toThrow('landing unobserved');
    expect(calls.some(c => c.includes('316'))).toBe(false);
    p = { worldX: 3113, worldZ: 9555, level: 1 }; calls.length = 0;
    await expect(exitRuneStageBasement(io)).rejects.toThrow('entry unsupported'); expect(calls).toEqual([]);
});
test('a staging job owns its supplier and one to four carriers', () => {
    expect(runeStageRoster(['Supplier', 'Carrier', '--rune-carriers'])).toEqual({ mode: 'carriers', names: ['Supplier', 'Carrier'] });
    expect(runeStageRoster(['Supplier', 'A', 'B', 'C', 'D', '--rune-carriers']).names).toHaveLength(5);
    for (const args of [['Supplier', '--rune-carriers'], ['S', 'A', 'B', 'C', 'D', 'E', '--rune-carriers'], ['S', 's', '--rune-carriers'], ['S', 'Haggis', '--rune-carriers']]) expect(() => runeStageRoster(args)).toThrow();
});
test('first login establishes authenticated ownership before staging can trade', async () => {
    const owned = new Set<string>(), order: string[] = [];
    const result = await runeStageAuthenticate('Fresh', async () => { order.push('login'); owned.add('fresh'); return { name: 'Fresh' }; }, () => { order.push('owned'); return owned; });
    expect(result.name).toBe('Fresh'); expect(order).toEqual(['login', 'owned']);
});
test('failed authentication and an unproved session cannot stage', async () => {
    let checks = 0;
    await expect(runeStageAuthenticate('Fresh', async () => { throw Error('login refused'); }, () => { checks++; return new Set(['fresh']); })).rejects.toThrow('login refused'); expect(checks).toBe(0);
    await expect(runeStageAuthenticate('Fresh', async () => ({ name: 'Fresh' }), () => new Set())).rejects.toThrow('authenticated owned');
    await expect(runeStageAuthenticate('Fresh', async () => ({ name: 'Other' }), () => new Set(['fresh']))).rejects.toThrow('authenticated owned');
});
test('opening preparation owns only the supplier', () => {
    expect(runeStageRoster(['Supplier', '--rune-opening'])).toEqual({ mode: 'opening', names: ['Supplier'] });
    expect(() => runeStageRoster(['Supplier', 'Other', '--rune-opening'])).toThrow();
});
test('banked stock reduces the exact kit shortfall and retained surplus is not spent', () => {
    expect(runeCarrierShortfall([])).toEqual({ essence: 405, talismans: 1 });
    expect(runeCarrierShortfall([{ id: 1436, count: 100 }, { id: 1446, count: 1 }])).toEqual({ essence: 305, talismans: 0 });
    expect(runeCarrierShortfall([{ id: 1436, count: 900 }, { id: 1446, count: 2 }])).toEqual({ essence: 0, talismans: 0 });
    expect(() => runeCarrierShortfall([{ id: 1436, count: NaN }])).toThrow();
});

test('one staged helper can finish while its peer remains active', () => {
    const code = `
    import{mock}from'bun:test';import{resolve}from'node:path';import{readFileSync,rmSync}from'node:fs';
    mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:async()=>{},onSessionEnd:()=>()=>{}}));
    const{startStatus}=await import('./packages/core/src/status');const{runeStageStatus}=await import('./packages/workers/src/runecraft/carrier-roster');
    const names=['StageA'+process.pid,'StageB'+process.pid],log=runeStageStatus(names);
    const file=name=>resolve('.practice/sim/status',name+'.json');
    const handles=names.map(name=>startStatus({name,sdk:{getState:()=>({inventory:[],equipment:[],skills:[]})},tick:()=>1,onTick:()=>()=>{}},'localhost:8910'));
    try{
     log(names[0],'RESULT ok staged carrier');handles.forEach(h=>h.stop());
     const first=JSON.parse(readFileSync(file(names[0]),'utf8')).result,peer=JSON.parse(readFileSync(file(names[1]),'utf8')).result;
     log(names[1],'RESULT fail stopped');handles[1].stop();
     console.log(JSON.stringify({first,peer,second:JSON.parse(readFileSync(file(names[1]),'utf8')).result}));
    }finally{handles.forEach(h=>h.stop());for(const name of names){rmSync(file(name),{force:true});rmSync(file(name)+'.tmp',{force:true});}}
    `;
    const child = Bun.spawnSync([process.execPath, '-e', code], { cwd: REPO_ROOT, windowsHide: true, stdout: 'pipe', stderr: 'pipe' });
    if (child.exitCode !== 0) throw Error(child.stderr.toString());
    const result = JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
    expect(result.first).toBe('ok staged carrier'); expect(result.peer).toBe(''); expect(result.second).toBe('fail stopped');
});

async function prewarmCase(late: boolean, connectFailure = false, watchdogStop = false) {
    const code = `
    import{mock}from'bun:test';import{resolve,join,dirname}from'node:path';import{mkdirSync,writeFileSync,rmSync}from'node:fs';
    const stem='flwarm'+Math.random().toString(36).slice(2,5),labels=['Fresh','Donor',...Array.from({length:15},(_,i)=>'Helper'+i)],names=labels.map((_,i)=>stem+i.toString(36)),role=n=>labels[names.indexOf(n)],opened=[],closed=[],created=[],stoppers=[];let prefix=false,prefixOpened=[];
    const botRoot=resolve('vendor/rs-sdk/bots');mkdirSync(botRoot,{recursive:true});
    for(const name of names){const path=join(botRoot,name);mkdirSync(path);created.push(path);writeFileSync(join(path,'bot.env'),'SERVER=localhost:8910\\n');}
    const modules={
    'packages/core/src/bot':{getWorld:async()=>({}),serverFromEnv:()=> 'localhost:8910',openBot:async(name,opts)=>{opened.push(role(name));if(${connectFailure}&&role(name)==='Helper0'){await new Promise(r=>setTimeout(r,5));throw Error('fixture helper connection refused')}if(${connectFailure}&&role(name)==='Helper14')await new Promise(r=>setTimeout(r,35));const actor={name,tick:()=>${late}&&role(name)==='Donor'?501:0,onTick:()=>()=>{},sdk:{getInventory:()=>[{id:1446,count:1}],getSkill:()=>({baseLevel:1}),getState:()=>({player:{},skills:[]})}};stoppers.push({actor,opts});return actor},settle:async actors=>{closed.push(...actors.map(a=>role(a.name)));if(${watchdogStop})for(const a of actors)await stoppers.find(r=>r.actor===a).opts.onSessionEnd(a,'logged-out');return true}},
    'packages/core/src/fleet':{assertSideOwns:()=>{}},
    'packages/core/src/ticks':{waitTicks:async()=>{},waitUntil:async(_s,p)=>p(),onSessionEnd:()=>()=>{}},
    'packages/workers/src/runecraft/carrier-roster':{runeCarrierRoster:a=>a.filter(n=>!n.startsWith('--')),assertRuneDonor:()=>{},assertFreshRuneSkills:()=>{}},
    'packages/workers/src/runecraft/carrier-start':{freshBodyStart:async(_s,_h,_stop,prepare)=>{prefix=true;prefixOpened=[...opened];await prepare();if(${watchdogStop})for(const label of['Helper0','Helper1']){const r=stoppers.find(r=>role(r.actor.name)===label);await r.opts.onStop(r.actor,'fixture no progress900')}throw Error('fixture prefix stopped')}},
    'packages/workers/src/runecraft/carrier-trade':{runeTickTrade:()=>false,tickTransfer:async()=>{throw Error('the tick trade is off in this fixture')},runeConfirmation:()=>process.env.RUNE_CONFIRM_AFTER??'causal',runeOpening:()=>process.env.RUNE_OPEN_AFTER??'incoming',runeHandoffPipeline:()=>false,pipelineOpeningReady:()=>true,observeCraftCompletion:()=>({tick:()=>undefined,dispose:()=>{}}),state:a=>a.sdk.getState(),ess:()=>27,transfer:async()=>0,ownedSwap:async()=>({ticks:0})},
    'packages/workers/src/runecraft/carrier-bank':{inside:()=>true,enterBody:async()=>{},stopCarriers:()=>{},restock:async()=>0,bankCarrier:async()=>({}),withdrawCarrier:async()=>{},closeCarrierBank:async()=>{},stageCarrier:async()=>{}}
    };
    for(const[p,m]of Object.entries(modules))mock.module(resolve(p),()=>m);
    try{const{runRuneCarriers}=await import('./packages/workers/src/runecraft/carriers');const result=await runRuneCarriers(names,2800);console.log(JSON.stringify({opened,closed,prefix,prefixOpened,result,firstStopped:names[2]}));}
    finally{for(const path of created){if(dirname(path)!==botRoot)throw Error('fixture path escaped');rmSync(path,{recursive:true});}}
    `;
    const r = await fixtureChild(code, 5000);
    if (r.exitCode !== 0) throw Error(r.stderr);
    return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!);
}
test('the crafter logs in before carrier preparation overlaps its prefix', async () => {
    const r = await prewarmCase(false); expect(r.prefixOpened).toEqual(['Donor', 'Fresh']);
    expect(r.opened).toEqual(['Donor', 'Fresh', ...Array.from({ length: 15 }, (_, i) => 'Helper' + i)]);
    expect(r.prefix).toBe(true); expect(r.closed).toEqual(r.opened);
});
test('an exhausted donor budget stops before the fresh crafter login', async () => {
    const r = await prewarmCase(true); expect(r.opened).toEqual(['Donor']); expect(r.prefix).toBe(false);
    expect(r.closed).toEqual(r.opened); expect(r.result.failure).toContain('fresh route budget');
});
test('overlapping helper logins drain a late connection before cleanup after another fails', async () => {
    const r = await prewarmCase(false, true); expect(r.result.ok).toBe(false); expect(r.result.failure).toContain('fixture helper connection refused');
    expect(r.opened).toHaveLength(17); expect(r.closed).toHaveLength(16); expect(r.closed).toContain('Helper14'); expect(r.closed).not.toContain('Helper0');
});
test('the first account stop cause survives a later stop and logout cleanup', async () => {
    const r = await prewarmCase(false, false, true); expect(r.result.failure).toContain(r.firstStopped + ': fixture no progress900');
    expect(r.result.failure).not.toContain('fixture prefix stopped'); expect(r.closed).toHaveLength(17);
});

function prefixCase(which: 'stop-walk' | 'prefix-error') {
    const code = `
    import {mock} from 'bun:test';
    import {resolve} from 'node:path';
    let stopped=false,bankActions=0,helperLogins=0;
    const cancel=new AbortController(),delay=ms=>new Promise(r=>setTimeout(r,ms));
    const stop=()=>stopped||cancel.signal.aborted;
    const actor=name=>({name,tick:()=>1,xp:0,bankObservation:()=>({generation:1,items:[]}),inventory:[{id:1351,count:1}],state:{player:{worldX:3222,worldZ:3222,level:0},bank:{}},sdk:{getSkillXp(){return 0},getInventory(){return this.owner.inventory}},bot:{async openBank(){bankActions++;throw Error('bank action after stop')}}});
    const s=actor('crafter'),h=actor('donor');for(const a of [s,h])a.sdk.owner=a;
    const modules={
    'packages/core/src/bot':{getWorld:async()=>({}),accountOf:()=>({})},
    'packages/core/src/ticks':{waitUntil:async(_s,p)=>p()},
    'packages/core/src/walk':{goTo:async a=>{if(a===h){if('${which}'==='stop-walk')stopped=true;else await delay(15);}return{ok:true}},walkPath:async()=>({ok:true}),sessionWalker:async()=>({})},
    'packages/core/src/deposit':{depositObserved:async()=>{bankActions++}},
    'packages/core/src/world':{interactionApproach:async()=>({})},
    'packages/workers/src/logistics/walk-helpers':{leaveRuneStarter:async()=>{},runeSupplyAssets:()=>({1351:1})},
    'packages/workers/src/runecraft/air':{enterAirAltar:async()=>{},craftAirRunes:async()=>({}),exitAirAltar:async()=>{throw Error('portal rejected')}},
    'packages/workers/src/runecraft/altars':{RUNE_ALTARS:[{name:'body',outside:{x:3050,z:3442}}],ruinTarget:()=>({})},
    'packages/workers/src/runecraft/bank-craft':{dispatchRuneEntry:async()=>({})},
    'packages/workers/src/runecraft/carrier-trade':{runeTickTrade:()=>false,tickTransfer:async()=>{throw Error('the tick trade is off in this fixture')},runeConfirmation:()=>process.env.RUNE_CONFIRM_AFTER??'causal',runeOpening:()=>process.env.RUNE_OPEN_AFTER??'incoming',ownedSwap:async()=>({}),state:a=>a.state,ess:()=>0}
    };
    for(const [path,value]of Object.entries(modules))mock.module(resolve(path),()=>value);
    const {freshBodyStart}=await import('./packages/workers/src/runecraft/carrier-start');
    try{await freshBodyStart(s,h,stop,async()=>{for(let i=0;i<3;i++){if(stop())break;await delay(5);helperLogins++;}},cancel);}catch{}
    console.log(JSON.stringify({bankActions,helperLogins,cancelled:cancel.signal.aborted}));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', code], { cwd: REPO_ROOT, windowsHide: true, stdout: 'pipe', stderr: 'pipe' });
    if (child.exitCode !== 0) throw Error(child.stderr.toString());
    return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}
test('a stop during donor travel prevents bank actions', () => {
    const result = prefixCase('stop-walk'); expect(result.bankActions).toBe(0); expect(result.cancelled).toBe(true);
});
test('a prefix failure cancels helper setup before it drains', () => {
    const result = prefixCase('prefix-error'); expect(result.cancelled).toBe(true); expect(result.helperLogins).toBeLessThanOrEqual(1); expect(result.bankActions).toBe(0);
});
test('prefix travel overlaps preparation and the first body craft waits for readiness', async () => {
    const code = `
    import{mock}from'bun:test';import{resolve}from'node:path';
    let preparing=false,prepared=false,travelDuringPreparation=false,craftedAfterReady=false,release;
    const actor=name=>({name,tick:()=>1,inventory:[],xp:0,state:{player:{worldX:2523,worldZ:4832,level:0},bank:{items:[{id:1446,count:1},{id:1436,count:27}]}},
     bankObservation(){return{generation:1,items:this.state.bank.items}},
     sdk:{getInventory(){return this.owner.inventory},getSkillXp(){return this.owner.xp}},
     bot:{openBank:async()=>({success:true}),closeBank:async()=>({success:true}),async withdrawItem(item,n){item.count-=n;h.inventory.push({id:item.id,count:n,slot:h.inventory.length});return{success:true}}},
     async direct(){craftedAfterReady=prepared;this.xp=8437}});
    const s=actor('crafter'),h=actor('donor');for(const a of[s,h])a.sdk.owner=a;
    const mods={
    'packages/core/src/bot':{getWorld:async()=>({}),accountOf:()=>({})},
    'packages/core/src/ticks':{waitUntil:async()=>true},
    'packages/core/src/walk':{goTo:async(a,_w,to)=>{if(a===s&&to.x===3050){travelDuringPreparation=preparing&&!prepared;setTimeout(()=>release(),10)}return{ok:true}},walkPath:async()=>({ok:true}),sessionWalker:async()=>({})},
    'packages/core/src/deposit':{depositObserved:async()=>{}},
    'packages/core/src/world':{interactionApproach:async()=>({})},
    'packages/workers/src/logistics/walk-helpers':{leaveRuneStarter:async()=>{},runeSupplyAssets:()=>({})},
    'packages/workers/src/runecraft/air':{enterAirAltar:async()=>{},craftAirRunes:async()=>({}),exitAirAltar:async()=>{}},
    'packages/workers/src/runecraft/altars':{RUNE_ALTARS:[{name:'body',outside:{x:3050,z:3442}}],ruinTarget:()=>({at:{},q:{}})},
    'packages/workers/src/runecraft/bank-craft':{dispatchRuneEntry:async()=>({entered:true})},
    'packages/workers/src/runecraft/carrier-trade':{runeTickTrade:()=>false,tickTransfer:async()=>{throw Error('the tick trade is off in this fixture')},runeConfirmation:()=>process.env.RUNE_CONFIRM_AFTER??'causal',runeOpening:()=>process.env.RUNE_OPEN_AFTER??'incoming',state:a=>({...a.state,nearbyLocs:[{id:2483,x:2523,z:4832}]}),ess:()=>0,ownedSwap:async()=>{s.inventory=[{id:1446,count:1,slot:0}];return{}}}
    };
    for(const[p,m]of Object.entries(mods))mock.module(resolve(p),()=>m);
    const{freshBodyStart}=await import('./packages/workers/src/runecraft/carrier-start');
    await freshBodyStart(s,h,()=>false,async()=>{preparing=true;await new Promise(r=>release=r);prepared=true});
    console.log(JSON.stringify({travelDuringPreparation,craftedAfterReady}));
    `;
    const child = await fixtureChild(code, 5000);
    if (child.exitCode !== 0) throw Error(child.stderr);
    const r = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(r.travelDuringPreparation).toBe(true); expect(r.craftedAfterReady).toBe(true);
});

test('packet refresh skips unchanged polls but observes packets, local mutations and resets', async () => {
    let scans = 0; const actor: any = { client: { packetsReceived: 10 }, sdk: { scanGroundItems: async () => { scans++; } } };
    const r = createRuneTradeRefresh('packets');
    await r.refresh(actor); await r.refresh(actor); expect(scans).toBe(1);
    actor.client.packetsReceived++; await r.refresh(actor); expect(scans).toBe(2);
    r.dirty(actor); await r.refresh(actor); expect(scans).toBe(3);
    actor.client.packetsReceived = 0; await r.refresh(actor); expect(scans).toBe(4);
    expect(r.stats()).toEqual({ mode: 'packets', scanned: 4, skipped: 1 });
});
test('packet refresh does not swallow arrivals or mutations during an awaited scan', async () => {
    let scans = 0, release: () => void = () => {}; const actor: any = { client: { packetsReceived: 10 }, sdk: { scanGroundItems: async () => { if (++scans === 1) await new Promise<void>(r => { release = r; }); } } };
    const r = createRuneTradeRefresh('packets'), pending = r.refresh(actor);
    actor.client.packetsReceived++; r.dirty(actor); release(); await pending;
    await r.refresh(actor); expect(scans).toBe(2);
    await r.refresh(actor); expect(scans).toBe(2);
});
test('poll mode and missing counters keep refreshing; failed scans retry', async () => {
    for (const mode of ['poll', 'packets'] as const) {
        let scans = 0; const actor: any = { sdk: { scanGroundItems: async () => { scans++; } } };
        const r = createRuneTradeRefresh(mode); await r.refresh(actor); await r.refresh(actor); expect(scans).toBe(2);
    }
    let scans = 0; const actor: any = { client: { packetsReceived: 0 }, sdk: { scanGroundItems: async () => { if (++scans === 1) throw Error('scan failed'); } } };
    const r = createRuneTradeRefresh('packets'); await expect(r.refresh(actor)).rejects.toThrow('scan failed'); await r.refresh(actor); expect(scans).toBe(2);
    expect(() => createRuneTradeRefresh('invalid')).toThrow('RUNE_TRADE_REFRESH');
});
test('confirmation mode is explicit and rejects unknown controls', () => {
    expect(runeConfirmation('observed')).toBe('observed'); expect(runeConfirmation('causal')).toBe('causal'); expect(() => runeConfirmation('optimistic')).toThrow('RUNE_CONFIRM_AFTER');
});
test('packet-gated transfer reads an incoming request between game ticks', async () => {
    const code = `import{mock}from'bun:test';import{resolve}from'node:path';process.env.RUNE_TRADE_REFRESH='packets';process.env.RUNE_RECIPROCAL='0';
    let response=-1,scans=0,raw=[];const start=performance.now(),s={name:'Crafter',messages:[],client:{packetsReceived:1}},h={name:'Carrier',messages:[],client:{packetsReceived:1}};
    for(const[a,o]of[[s,h],[h,s]]){a.tick=()=>0;a.direct=async()=>{if(a===h)setTimeout(()=>{s.client.packetsReceived++;raw=[{type:4,sender:'Carrier',text:'wishes to trade with you.',observationId:1}]},35);else response=performance.now()-start;return{success:true}};
    a.sdk={getInventory:()=>a===h?Array.from({length:27},(_,slot)=>({id:1436,count:1,slot})):[],getState:()=>({trade:{isOpen:false},gameMessages:a.messages,nearbyPlayers:[{name:o.name,index:1}]}),scanGroundItems:async()=>{scans++;if(a===s)a.messages=[...raw]}};}
    mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>new Promise(()=>{})}));
    const{transfer}=await import('./packages/workers/src/runecraft/carrier-trade');try{await transfer(s,h,()=>response>=0||performance.now()-start>350)}catch{}console.log(JSON.stringify({response,scans}));`;
    const child = await fixtureChild(code, 2000);
    if (child.exitCode !== 0) throw Error(child.stderr);
    const r = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(r.response).toBeGreaterThanOrEqual(35); expect(r.response).toBeLessThan(350); expect(r.scans).toBeLessThanOrEqual(6);
});
test('causal confirmation reaches the server before confirmation publication and falls back after an invisible click', async () => {
    for (const order of ['receiver', 'helper']) for (const quota of [1, 5]) for (const mode of ['observed', 'causal']) {
        const code = `import{mock}from'bun:test';import{resolve}from'node:path';process.env.RUNE_CONFIRM_AFTER='${mode}';
        let tick=0,pending,settled=false,offered=false,early=0,ignored=0;const queues=[[],[]],server=[{screen:'offer',accepted:false},{screen:'offer',accepted:false}],cache=[];
        const pack=()=>Array.from({length:27},(_,slot)=>({id:1436,count:1,slot}));const actors=[{name:'Crafter'},{name:'Carrier'}];
        const publish=()=>actors.forEach((a,i)=>{const p=server[i];cache[i]={trade:{isOpen:!settled,screen:p.screen,partner:actors[1-i].name,myAccepted:p.accepted,myOffer:i===1&&offered&&(p.accepted||p.screen==='confirm')?pack():[],theirOffer:i===0&&offered&&(server[1].accepted||p.screen==='confirm')?pack():[]},gameMessages:[]};});publish();
        const enqueue=(i,component)=>{if(component===3546&&cache[i].trade.screen==='offer')early++;queues[i].push(component);return{success:true};};
        actors.forEach((a,i)=>{a.tick=()=>tick;a.direct=async(x)=>enqueue(i,x.componentId);a.sdk={getInventory:()=>i===1?(settled?[]:pack()):(settled?pack():[]),getState:()=>cache[i],scanGroundItems:async()=>{},sendOfferItem:async()=>{queues[i].push('offer');return{success:true}},sendAcceptTrade:async()=>enqueue(i,cache[i].trade.screen==='confirm'?3546:3420)};});
        const advance=()=>{tick++;for(const i of ${order === 'receiver' ? '[0,1]' : '[1,0]'})for(const c of queues[i].splice(0,${quota})){const p=server[i],other=server[1-i];if(c==='offer'){offered=true;server.forEach(x=>x.accepted=false);}else if(c===3420&&p.screen==='offer'){p.accepted=true;if(other.accepted)server.forEach(x=>{x.screen='confirm';x.accepted=false;});}else if(c===3546&&p.screen==='confirm'){p.accepted=true;if(other.accepted)settled=true;}else ignored++;}
         if(settled||server[0].screen==='offer'||tick%2===0)publish();};
        mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{if(!pending)pending=new Promise(r=>queueMicrotask(()=>{advance();pending=undefined;r();}));return pending;}}));
        const{transfer}=await import('./packages/workers/src/runecraft/carrier-trade');let error='';try{await transfer(actors[0],actors[1]);}catch(e){error=String(e)}console.log(JSON.stringify({error,early,ignored,settled}));`;
        const child = await fixtureChild(code, 3000);
        if (child.exitCode !== 0) throw Error(child.stderr);
        const r = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
        expect(r.error).toBe(''); expect(r.settled).toBe(true); expect(r.early).toBe(mode === 'causal' ? 2 : 0);
        if (mode === 'causal' && order === 'helper') expect(r.ignored).toBeGreaterThan(0);
    }
});
test('helper-ready acknowledgement answers once before delayed incoming publication', async () => {
    for (const mode of ['fresh', 'stale', 'spoofed', 'busy-then-ready', 'stop', 'opened']) {
        const code = `import{mock}from'bun:test';import{resolve}from'node:path';
        process.env.RUNE_OPEN_AFTER='helper-ack';process.env.RUNE_RECIPROCAL='0';let tick=0,pending,requests=0,response=-1;
        const s={name:'Crafter',messages:[]},h={name:'Carrier',messages:[{type:0,sender:'',text:'Sending trade offer...',observationId:1}]};
        for(const[a,o]of[[s,h],[h,s]]){a.tick=()=>tick;a.direct=async()=>{if(a===h)requests++;else response=tick;return{success:true}};
         a.sdk={getInventory:()=>a===h?Array.from({length:27},(_,slot)=>({id:1436,count:1,slot})):[],
          getState:()=>({trade:{isOpen:'${mode}'==='opened'&&tick>=2},gameMessages:a.messages,nearbyPlayers:[{name:o.name,index:1}]}),scanGroundItems:async()=>{}};}
        mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{if(!pending)pending=new Promise(r=>queueMicrotask(()=>{
         tick++;if(tick===1&&'${mode}'==='busy-then-ready')h.messages.push({type:0,sender:'',text:'Crafter is busy at the moment.',observationId:2});
         if(tick===2&&'${mode}'!=='stale')h.messages.push({type:'${mode}'==='spoofed'?2:0,sender:'${mode}'==='spoofed'?'Stranger':'',text:'Sending trade offer...',observationId:3});
         if(tick===5)s.messages.push({type:4,sender:'Carrier',text:'wishes to trade with you.',observationId:1});
         pending=undefined;r();}));return pending;}}));
        const{transfer}=await import('./packages/workers/src/runecraft/carrier-trade');try{await transfer(s,h,()=>response>=0||tick>=('${mode}'==='stop'?2:6));}catch{}
        console.log(JSON.stringify({requests,response}));`;
        const child = await fixtureChild(code, 3000);
        if (child.exitCode !== 0) throw Error(child.stderr);
        const r = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
        expect(r.requests).toBe(mode === 'busy-then-ready' ? 2 : 1);
        expect(r.response).toBe(['stop', 'opened'].includes(mode) ? -1 : ['stale', 'spoofed'].includes(mode) ? 5 : 2);
    }
});
test('polling preserves tick-stall failure with at most one wait per actor', async () => {
    const code = `
    import{mock}from'bun:test';import{resolve}from'node:path';process.env.RUNE_RECIPROCAL='0';let active=0,peak=0,requests=0;
    const s={name:'Crafter'},h={name:'Carrier'};
    for(const[a,o]of [[s,h],[h,s]]){a.tick=()=>0;a.direct=async()=>{requests++;return{success:true}};a.sdk={getInventory:()=>a===h?Array.from({length:27},(_,slot)=>({id:1436,count:1,slot})):[],getState:()=>({trade:{isOpen:false},gameMessages:[],nearbyPlayers:[{name:o.name,index:1}]}),scanGroundItems:async()=>{}};}
    mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{active++;peak=Math.max(peak,active);return new Promise((_,reject)=>setTimeout(()=>{active--;reject(Error('TickStallError: frozen tick stream'))},100));}}));
    const{transfer}=await import('./packages/workers/src/runecraft/carrier-trade');let error='';try{await transfer(s,h)}catch(e){error=String(e)}console.log(JSON.stringify({error,peak,requests}));
    `;
    const child = await fixtureChild(code, 1500);
    if (child.exitCode !== 0) throw Error('Transfer did not propagate frozen-tick failure: ' + child.stderr);
    const r = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(r.error).toContain('TickStallError'); expect(r.peak).toBe(2); expect(r.requests).toBe(1);
});
test('a between-tick owned trade request is answered without waiting for another game tick', async () => {
    const code = `
    import{mock}from'bun:test';import{resolve}from'node:path';
    process.env.RUNE_RECIPROCAL='0';let tick=0,responseMs=-1,requests=0,raw=[];const started=performance.now();
    const s={name:'Crafter',messages:[]},h={name:'Carrier',messages:[]};
    for(const[a,o]of [[s,h],[h,s]]){
     a.tick=()=>tick;a.direct=async()=>{if(a===h){requests++;setTimeout(()=>raw=[{type:4,sender:'Carrier',text:'wishes to trade with you.',observationId:1}],30);}else responseMs=performance.now()-started;return{success:true}};
     a.sdk={getInventory:()=>a===h?Array.from({length:27},(_,slot)=>({id:1436,count:1,slot})):[],
      getState:()=>({trade:{isOpen:false},gameMessages:a.messages,nearbyPlayers:[{name:o.name,index:1}]}),
      scanGroundItems:async()=>{if(a===s)s.messages=raw;}};
    }
    mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>new Promise(r=>setTimeout(()=>{tick++;r()},400))}));
    const{transfer}=await import('./packages/workers/src/runecraft/carrier-trade');try{await transfer(s,h,()=>responseMs>=0)}catch{}
    console.log(JSON.stringify({responseMs,requests}));
    `;
    const child = await fixtureChild(code, 5000);
    if (child.exitCode !== 0) throw Error(child.stderr);
    const r = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(r.requests).toBe(1); expect(r.responseMs).toBeGreaterThanOrEqual(25); expect(r.responseMs).toBeLessThan(200);
});
test('an offer acceptance is sent once while its published flag is delayed', async () => {
    const code = `
    import{mock}from'bun:test';import{resolve}from'node:path';let phase=0,pending,offerAccepts=0,confirmAccepts=0;
    const pack=()=>Array.from({length:27},(_,slot)=>({id:1436,count:1,slot}));
    const s={name:'Crafter'},h={name:'Carrier'};
    for(const[a,o]of [[s,h],[h,s]]){
     a.tick=()=>phase;a.trade={isOpen:true,screen:'offer',partner:o.name,myAccepted:false,myOffer:a===h?pack():[],theirOffer:a===s?pack():[]};
     a.sdk={getInventory:()=>a===s?(phase>=3?pack():[]):(phase>=3?[]:pack()),getState:()=>({trade:a.trade,nearbyPlayers:[]}),scanGroundItems:async()=>{},
      sendAcceptTrade:async()=>{if(a.trade.screen==='offer')offerAccepts++;else confirmAccepts++;return{success:true}}};
    }
    mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
     if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;if(phase===2)for(const a of[s,h])a.trade.screen='confirm';if(phase===3)for(const a of[s,h])a.trade={isOpen:false};pending=undefined;r()}));return pending;
    }}));
    const{transfer}=await import('./packages/workers/src/runecraft/carrier-trade');let error='';try{await transfer(s,h)}catch(e){error=String(e)}
    console.log(JSON.stringify({error,offerAccepts,confirmAccepts}));
    `;
    const child = await fixtureChild(code, 5000);
    if (child.exitCode !== 0) throw Error(child.stderr);
    const r = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(r.error).toBe(''); expect(r.offerAccepts).toBe(2); expect(r.confirmAccepts).toBe(2);
});

async function delayedOffer(mode: 'valid' | 'empty' | 'wrong-item' | 'partial') {
    const code = `
    import{mock}from'bun:test';import{resolve}from'node:path';let phase=0,pending,offered=false,receiverAt=-1,confirms=0;const early=[];
    const pack=(n=27,id=1436)=>Array.from({length:n},(_,slot)=>({id,count:1,slot}));
    const s={name:'Crafter'},h={name:'Carrier'};
    for(const[a,o]of[[s,h],[h,s]]){a.tick=()=>phase;a.trade={isOpen:true,screen:'offer',partner:o.name,myAccepted:false,myOffer:[],theirOffer:[]};a.direct=async command=>{early.push({name:a.name,phase,component:command.componentId});return{success:true}};
    a.sdk={getInventory:()=>a===h?(phase<4?pack():[]):(phase>=4?pack():[]),getState:()=>({trade:a.trade,nearbyPlayers:[]}),scanGroundItems:async()=>{},
    sendOfferItem:async()=>{offered=true;return{success:true}},sendAcceptTrade:async()=>{if(a.trade.screen==='confirm')confirms++;else if(a===s)receiverAt=phase;return{success:true}}};}
    mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
    if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;
    if(phase===1&&offered)h.trade.myAccepted=true;
    if(phase===2){const stock='${mode}'==='empty'?[]:pack('${mode}'==='partial'?26:27,'${mode}'==='wrong-item'?995:1436);h.trade.myOffer=stock;s.trade.theirOffer=stock;}
    if(phase===3)for(const a of[s,h]){a.trade.screen='confirm';a.trade.myAccepted=false;}
    if(phase===4)for(const a of[s,h])a.trade={isOpen:false};pending=undefined;r();}));return pending;}}));
    const{transfer}=await import('./packages/workers/src/runecraft/carrier-trade');let error='';try{await transfer(s,h)}catch(e){error=String(e)}console.log(JSON.stringify({error,receiverAt,confirms,early}));`;
    const child = await fixtureChild(code, 5000);
    if (child.exitCode !== 0) throw Error(child.stderr);
    return JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
}
test('a fresh server acceptance acknowledges the owned offer before item publication', async () => {
    const r = await delayedOffer('valid'); expect(r.error).toBe(''); expect(r.receiverAt).toBe(1); expect(r.confirms).toBe(2);
});
test('causal confirmation rechecks the exact accepted offer after receiver acceptance is latched', async () => {
    const r = await delayedOffer('valid'); expect(r.error).toBe(''); expect(r.receiverAt).toBe(1);
    expect(r.early).toEqual([{ name: 'Crafter', phase: 2, component: 3546 }, { name: 'Carrier', phase: 2, component: 3546 }]);
    expect(r.confirms).toBe(2);
});
test('early owned-offer acceptance cannot accept empty, partial or wrong-item confirmation', async () => {
    for (const mode of ['empty', 'partial', 'wrong-item'] as const) { const r = await delayedOffer(mode); expect(r.error).not.toBe(''); expect(r.confirms).toBe(0); expect(r.early).toEqual([]); }
});

async function acceptedCraftCase(mode: 'fresh' | 'stale' | 'spoofed' | 'no-movement' | 'refused' | 'stop') {
    const code = `import{mock}from'bun:test';import{resolve}from'node:path';let phase=0,pending,craftAt=-1,crafts=0;
    const pack=()=>Array.from({length:27},(_,slot)=>({id:1436,count:1,slot}));const s={name:'Crafter'},h={name:'Carrier'};
    for(const[a,o]of[[s,h],[h,s]]){a.tick=()=>phase;a.messages=[{type:0,sender:'',text:'Accepted trade.',observationId:1}];a.trade={isOpen:true,screen:'confirm',partner:o.name,myAccepted:false,myOffer:a===h?pack():[],theirOffer:a===s?pack():[]};
    a.sdk={getInventory:()=>a===h?(phase===0?pack():[]):(phase>=2&&craftAt<0&&'${mode}'!=='no-movement'?pack():[]),getState:()=>({trade:a.trade,gameMessages:a.messages,nearbyPlayers:[]}),scanGroundItems:async()=>{},sendAcceptTrade:async()=>{a.trade.myAccepted=true;return{success:true}}};}
    mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;if(phase===1)for(const a of[s,h]){a.trade={isOpen:false};if('${mode}'!=='stale')a.messages.push({type:'${mode}'==='spoofed'?2:0,sender:'${mode}'==='spoofed'?'Stranger':'',text:'Accepted trade.',observationId:2});}pending=undefined;r();}));return pending;}}));
    const{transfer}=await import('./packages/workers/src/runecraft/carrier-trade');let error='';try{await transfer(s,h,()=> '${mode}'==='stop'&&phase>=1,27,{send:async()=>{crafts++;craftAt=phase;if('${mode}'==='refused')throw Error('fixture altar refused');},complete:()=>craftAt>=0&&phase>=3&&'${mode}'!=='no-movement'});}catch(e){error=String(e)}console.log(JSON.stringify({error,craftAt,crafts,phase}));`;
    const child = await fixtureChild(code, 5000);
    if (child.exitCode !== 0) throw Error(child.stderr);
    return JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
}
test('combined crafting can start on both fresh server acceptance messages before credit publication', async () => {
    const r = await acceptedCraftCase('fresh'); expect(r.error).toBe(''); expect(r.craftAt).toBe(1); expect(r.crafts).toBe(1); expect(r.phase).toBeGreaterThanOrEqual(3);
});
test('stale or spoofed acceptance cannot start a combined craft before observed credit', async () => {
    for (const mode of ['stale', 'spoofed'] as const) { const r = await acceptedCraftCase(mode); expect(r.error).toBe(''); expect(r.craftAt).toBe(2); expect(r.crafts).toBe(1); }
});
test('combined handoff refuses missing effects, a refused altar action and stop without blind craft retries', async () => {
    const missing = await acceptedCraftCase('no-movement'); expect(missing.error).not.toBe(''); expect(missing.crafts).toBe(1);
    const refused = await acceptedCraftCase('refused'); expect(refused.error).toContain('fixture altar refused'); expect(refused.crafts).toBe(1);
    const stopped = await acceptedCraftCase('stop'); expect(stopped.error).not.toBe(''); expect(stopped.crafts).toBe(0);
});

function handoff(mode: 'publication' | 'reset-publication' | 'wrong-item' | 'refused' | 'no-credit') {
    const code = `
    import{mock}from'bun:test';import{resolve}from'node:path';
    let phase=0,accepts=0,pending;
    const pack=n=>Array.from({length:n},()=>({id:1436,count:1,slot:0}));
    const make=(name,giver)=>{const a={name,tick:()=>phase};a.trade={isOpen:true,screen:'confirm',partner:giver?'Crafter':'Carrier',myAccepted:false,myOffer:giver?pack(27):[],theirOffer:giver?[]:pack(27)};
    a.sdk={getInventory:()=>giver?pack(phase===0?27:0):pack(phase>=2&&'${mode}'!=='no-credit'?27:0),getState:()=>({trade:a.trade,nearbyPlayers:[]}),scanGroundItems:async()=>{},sendAcceptTrade:async()=>{accepts++;if('${mode}'==='refused')return{success:false,message:'declined'};a.trade.myAccepted=true;return{success:true}}};return a;};
    const s=make('Crafter',false),h=make('Carrier',true);
    if('${mode}'==='wrong-item'){s.trade.theirOffer=[{id:995,count:27}];h.trade.myOffer=[{id:995,count:27}];}
    mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
     if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;if(phase===1){h.trade={isOpen:false};s.trade.myOffer=[];s.trade.theirOffer=[];if('${mode}'==='reset-publication')s.trade.myAccepted=false;}else{s.trade={isOpen:false};}pending=undefined;r();}));return pending;
    }}));
    const{transfer}=await import('./packages/workers/src/runecraft/carrier-trade');let error='';try{await transfer(s,h);}catch(e){error=String(e);}
    console.log(JSON.stringify({error,accepts,phase,received:s.sdk.getInventory().length}));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', code], { cwd: REPO_ROOT, windowsHide: true, stdout: 'pipe', stderr: 'pipe' });
    if (child.exitCode !== 0) throw Error(child.stderr.toString());
    return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}
test('accepted confirmation may clear before recipient inventory is published', () => {
    const result = handoff('publication'); expect(result.error).toBe(''); expect(result.accepts).toBe(2); expect(result.received).toBe(27);
});
test('wrong confirmation stock still refuses before either accept', () => {
    const result = handoff('wrong-item'); expect(result.error).toContain('unexpected carrier trade stock'); expect(result.accepts).toBe(0);
});
test('sent confirmation survives an acceptance flag reset before inventory publication', () => {
    const result = handoff('reset-publication'); expect(result.error).toBe(''); expect(result.accepts).toBe(2); expect(result.received).toBe(27);
});
test('a refused confirmation does not count as sent', () => {
    const result = handoff('refused'); expect(result.error).toContain('carrier confirmation refused declined'); expect(result.received).toBe(0);
});
test('sent confirmations still require both inventory publications', () => {
    const result = handoff('no-credit'); expect(result.error).toContain('essence transfer did not reconcile'); expect(result.received).toBe(0);
});

test('delayed carrier transfer opening avoids cancellation and reconciles27 essence on both actors', async () => {
    for (const mode of ['1', '0']) {
        const code = `
        import{mock}from'bun:test';import{resolve}from'node:path';process.env.RUNE_RECIPROCAL='${mode}';
        let phase=0,pending,duplicate=false,cancelled=false;
        const requests=[],closed=()=>({isOpen:false,screen:null,myOffer:[],theirOffer:[],myAccepted:false});
        const s={name:'Crafter',pack:[],trade:closed(),messages:[]},h={name:'Carrier',pack:Array.from({length:27},(_,slot)=>({id:1436,count:1,slot})),trade:closed(),messages:[]};
        const essence=a=>a.pack.filter(i=>i.id===1436).reduce((n,i)=>n+i.count,0),before=[essence(s),essence(h)];
        for(const [a,other]of [[s,h],[h,s]]){
         a.tick=()=>phase;a.direct=async(action)=>{if(action.type==='clickComponent'){if(a.trade.screen==='confirm')a.trade.myAccepted=true;return{success:true}}if(requests.some(r=>r.name===a.name))duplicate=true;requests.push({name:a.name,tick:phase});return{success:true}};
         a.sdk={getInventory:()=>a.pack,getState:()=>({trade:a.trade,gameMessages:a.messages,nearbyPlayers:[{name:other.name,index:1}]}),scanGroundItems:async()=>{},sendOfferItem:async(slot,amount)=>{
          if(a!==h||amount!==-1||!a.pack.some(i=>i.slot===slot))throw Error('unexpected offer');
          a.trade.myOffer=a.pack.map(i=>({...i}));other.trade.theirOffer=a.trade.myOffer.map(i=>({...i}));a.trade.myAccepted=false;other.trade.myAccepted=false;return{success:true};
         },sendAcceptTrade:async()=>{a.trade.myAccepted=true;return{success:true}}};
        }
        mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
         if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;
          if(phase===1)s.messages.push({type:4,sender:h.name,text:'wishes to trade with you.',observationId:1});
          if(phase===3)for(const [a,o]of [[s,h],[h,s]])a.trade={...closed(),isOpen:true,screen:'offer',partner:o.name};
          if(phase===4){
           if(duplicate){cancelled=true;for(const [a,o]of [[s,h],[h,s]])a.trade={...closed(),isOpen:true,screen:'offer',partner:o.name};}
           else if(s.trade.myAccepted&&h.trade.myAccepted)for(const a of [s,h]){a.trade.screen='confirm';a.trade.myAccepted=false;}
          }
          if(phase===5&&!cancelled&&s.trade.screen==='confirm'&&h.trade.screen==='confirm'&&s.trade.myAccepted&&h.trade.myAccepted){s.pack=h.pack;h.pack=[];s.trade=closed();h.trade=closed();}
          pending=undefined;r();}));return pending;
        }}));
        const{transfer}=await import('./packages/workers/src/runecraft/carrier-trade');let error='';try{await transfer(s,h);}catch(e){error=String(e);}
        const after=[essence(s),essence(h)];console.log(JSON.stringify({error,requests,duplicate,cancelled,before,after,deltas:after.map((n,i)=>n-before[i])}));
        `;
        const child = await fixtureChild(code, 10000);
        if (child.exitCode !== 0) throw Error(child.stderr);
        const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
        expect(result.error).toBe(''); expect(result.duplicate).toBe(false); expect(result.cancelled).toBe(false);
        expect(result.requests).toEqual([{ name: 'Carrier', tick: 0 }, { name: 'Crafter', tick: mode === '0' ? 1 : 0 }]);
        expect(result.before).toEqual([0, 27]); expect(result.after).toEqual([27, 0]); expect(result.deltas).toEqual([27, -27]);
    }
});

async function acknowledgedTransfer(busyUntil: number, mode: 'fresh' | 'missing' | 'stop' | 'levelup' | 'level54' | 'unrelated-dialog' | 'levelup-stop' = 'fresh', reciprocal = true) {
    const code = `
    import{mock}from'bun:test';import{resolve}from'node:path';process.env.RUNE_RECIPROCAL='${reciprocal ? '1' : '0'}';
    let phase=0,pending,outstanding=false,received=false,duplicate=false,premature=false,opening=-1,escrow=[];
    let modal=${['levelup', 'level54', 'unrelated-dialog', 'levelup-stop'].includes(mode)},closes=0,unlock=false;
    const requests=[],events=[],closed=()=>({isOpen:false,screen:null,myOffer:[],theirOffer:[],myAccepted:false});
    const s={name:'Crafter',pack:[{id:1446,count:1,slot:0}],trade:closed(),messages:[{type:4,sender:'Carrier',text:'wishes to trade with you.',observationId:7}],seq:7};
    const h={name:'Carrier',pack:[{id:1446,count:1,slot:0},...Array.from({length:27},(_,i)=>({id:1436,count:1,slot:i+1}))],trade:closed(),messages:[{type:0,sender:'',text:'Crafter is busy at the moment.',observationId:7}],seq:7};
    const message=(a,type,sender,text)=>a.messages.push({type,sender,text,observationId:++a.seq});
    for(const[a,other]of [[s,h],[h,s]]){
     a.tick=()=>phase;a.direct=async(action)=>{
      if(action.type==='clickComponent'){if(a.trade.screen==='confirm')a.trade.myAccepted=true;return{success:true}}
      if(action.type==='closeModal'){if(a!==s)throw Error('wrong actor closed');closes++;events.push({at:phase+1,run:()=>{modal=false;}});return{success:true};}
      requests.push({name:a.name,tick:phase});
      if(a===h){
       if(outstanding)duplicate=true;outstanding=true;const busy=phase<${busyUntil}||modal;
       events.push({at:phase+1,run:()=>{if(busy){outstanding=false;message(h,0,'','Crafter is busy at the moment.');}else if('${mode}'!=='missing'){received=true;message(s,4,'cArRiEr','wishes to trade with you.');}}});
      }else if(${reciprocal}){
       if(phase<${busyUntil}||modal){}else if(opening>=0)duplicate=true;else if(outstanding&&'${mode}'!=='missing')opening=phase+1;
      }else if(!received||phase<${busyUntil})premature=true;
      else if(opening<0)opening=phase+1;
      return{success:true};
     };
     a.sdk={getInventory:()=>a.pack,getState:()=>({trade:a.trade,gameMessages:a.messages,dialog:a===s?{isOpen:modal,options:[{index:1,text:'Click here to continue',componentId:4270,buttonType:6}],allComponents:[{id:4268,text:unlock?'Members can now craft @dbl@Law Runes@bla@.':'${mode === 'unrelated-dialog' ? 'Choose an option.' : '@dbl@Congratulations, you just advanced a runecraft level.'}'}]}:undefined,nearbyPlayers:[{name:other.name,index:1}]}),scanGroundItems:async()=>{},clickDialogByText:async()=>{
      events.push({at:phase+1,run:()=>{if('${mode}'==='level54'&&!unlock)unlock=true;else modal=false;}});return{success:true};
     },sendOfferItem:async(slot,amount)=>{
      if(a!==h||amount!==-1||!h.pack.some(i=>i.slot===slot&&i.id===1436))throw Error('unexpected offer');
      escrow=h.pack.filter(i=>i.id===1436);h.pack=h.pack.filter(i=>i.id!==1436);h.trade.myOffer=escrow;s.trade.theirOffer=escrow;return{success:true};
     },sendAcceptTrade:async()=>{a.trade.myAccepted=true;return{success:true}}};
    }
    mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
     if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;
      if(phase===1){message(s,4,'Other','wishes to trade with you.');message(s,2,'Carrier','wishes to trade with you.');}
      for(const e of events.filter(e=>e.at===phase))e.run();
      if(phase===opening)for(const[a,o]of [[s,h],[h,s]])a.trade={...closed(),isOpen:true,screen:'offer',partner:o.name};
      else if(duplicate&&opening>=0&&phase===opening+1){h.pack.push(...escrow);escrow=[];for(const[a,o]of [[s,h],[h,s]])a.trade={...closed(),isOpen:true,screen:'offer',partner:o.name};}
      else if(!duplicate&&s.trade.screen==='offer'&&s.trade.myAccepted&&h.trade.myAccepted)for(const a of[s,h]){a.trade.screen='confirm';a.trade.myAccepted=false;}
      else if(!duplicate&&s.trade.screen==='confirm'&&s.trade.myAccepted&&h.trade.myAccepted){s.pack.push(...escrow);escrow=[];s.trade=closed();h.trade=closed();}
      pending=undefined;r();}));return pending;
    }}));
    const{transfer}=await import('./packages/workers/src/runecraft/carrier-trade');let error='';try{await transfer(s,h,()=> '${mode}'==='levelup-stop'||('${mode}'==='stop'&&phase>=2));}catch(e){error=String(e);}
    const count=(a,id)=>a.pack.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    console.log(JSON.stringify({error,phase,requests,duplicate,premature,closes,modal,after:[count(s,1436),count(h,1436)],talismans:[count(s,1446),count(h,1446)]}));
    `;
    const child = await fixtureChild(code, 10000);
    if (child.exitCode !== 0) throw Error(child.stderr);
    return JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
}
test('carrier retries only acknowledged busy requests and responds once to a fresh exact-player request', async () => {
    for (const reciprocal of [true, false]) for (const busy of [0, 3, 7]) {
        const r = await acknowledgedTransfer(busy, 'fresh', reciprocal);
        expect(r.error).toBe(''); expect(r.duplicate).toBe(false); expect(r.premature).toBe(false);
        expect(r.requests.filter((a: any) => a.name === 'Carrier')).toHaveLength(busy + 1);
        expect(r.requests.filter((a: any) => a.name === 'Crafter')).toEqual(reciprocal ? Array.from({ length: busy + 1 }, (_, tick) => ({ name: 'Crafter', tick })) : [{ name: 'Crafter', tick: busy + 1 }]);
        expect(r.phase).toBeLessThanOrEqual(busy + (reciprocal ? 4 : 5)); expect(r.after).toEqual([27, 0]); expect(r.talismans).toEqual([1, 1]);
    }
});
test('a Runecraft level-up dialog is dismissed before a fresh trade request can arrive', async () => {
    for (const reciprocal of [true, false]) {
        const r = await acknowledgedTransfer(0, 'levelup', reciprocal); expect(r.error).toBe(''); expect(r.closes).toBe(1);
        expect(r.duplicate).toBe(false); expect(r.premature).toBe(false); expect(r.after).toEqual([27, 0]);
        expect(r.talismans).toEqual([1, 1]); expect(r.phase).toBeLessThanOrEqual(6);
    }
});
test('the reachable level54 reward page cannot keep the next essence handoff busy', async () => {
    expect(levelForXp(3375 + 8 * 27 * 7.5 * 25)).toBe(54);
    const r = await acknowledgedTransfer(0, 'level54'); expect(r.error).toBe(''); expect(r.modal).toBe(false);
    expect(r.after).toEqual([27, 0]); expect(r.talismans).toEqual([1, 1]);
});
test('the handoff preserves unrelated dialogs and sends no dismissal after stop', async () => {
    const unrelated = await acknowledgedTransfer(0, 'unrelated-dialog'); expect(unrelated.closes).toBe(0);
    expect(unrelated.error).toContain('essence transfer did not reconcile'); expect(unrelated.after).toEqual([0, 27]);
    const stopped = await acknowledgedTransfer(0, 'levelup-stop'); expect(stopped.closes).toBe(0); expect(stopped.requests).toEqual([]);
    expect(stopped.after).toEqual([0, 27]);
});
test('stale, wrong-player and player-chat requests cannot open a handoff or send a response after stop', async () => {
    for (const reciprocal of [true, false]) {
        const missing = await acknowledgedTransfer(0, 'missing', reciprocal); expect(missing.error).toContain('essence transfer did not reconcile');
        expect(missing.requests).toEqual(reciprocal ? [{ name: 'Carrier', tick: 0 }, { name: 'Crafter', tick: 0 }] : [{ name: 'Carrier', tick: 0 }]);
        expect(missing.after).toEqual([0, 27]); expect(missing.phase).toBeLessThanOrEqual(35);
        const stopped = await acknowledgedTransfer(7, 'stop', reciprocal); expect(stopped.error).toContain('essence transfer did not reconcile');
        expect(stopped.requests.every((a: any) => (reciprocal || a.name === 'Carrier') && a.tick < 2)).toBe(true); expect(stopped.after).toEqual([0, 27]);
    }
});
test('a delayed walking handshake is not cancelled by repeated trade requests', () => {
    const code = `
    import{mock}from'bun:test';import{resolve}from'node:path';
    let phase=0,pending,requests=0,duplicate=false;
    const closed=()=>({isOpen:false,screen:null,myOffer:[],theirOffer:[],myAccepted:false});
    const a={name:'Supplier',pack:[{id:1437,count:405,slot:0},{id:1447,count:1,slot:1}],trade:closed()},b={name:'Carrier',pack:[],trade:closed()};
    for(const [s,other]of [[a,b],[b,a]]){
     s.tick=()=>phase;s.direct=async()=>{requests++;if(phase>0&&phase<3)duplicate=true;return{success:true}};
     s.sdk={getInventory:()=>s.pack,getState:()=>({nearbyPlayers:[{name:other.name,index:1}]}),getTradeState:()=>s.trade,scanGroundItems:async()=>{},sendOfferItem:async slot=>{s.trade.myOffer.push({...s.pack.find(i=>i.slot===slot)});other.trade.theirOffer=s.trade.myOffer.map(i=>({...i}));return{success:true}},sendAcceptTrade:async()=>{s.trade.myAccepted=true;return{success:true}}};
    }
    mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
     if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;
      if(phase===3)for(const [s,o]of [[a,b],[b,a]])s.trade={...closed(),isOpen:true,screen:'offer',partner:o.name};
      if(phase===4){if(duplicate){a.trade.myOffer=[];a.trade.theirOffer=[];b.trade.myOffer=[];b.trade.theirOffer=[];a.trade.myAccepted=false;b.trade.myAccepted=false;}else if(a.trade.myAccepted&&b.trade.myAccepted){a.trade.screen='confirm';b.trade.screen='confirm';a.trade.myAccepted=false;b.trade.myAccepted=false;}}
      if(phase===5&&!duplicate&&a.trade.myAccepted&&b.trade.myAccepted){b.pack=a.pack;a.pack=[];a.trade=closed();b.trade=closed();}
      pending=undefined;r();}));return pending;
    }}));
    const{ownedSwap}=await import('./packages/workers/src/runecraft/carrier-trade');let error='';try{await ownedSwap(a,b,{1437:405,1447:1},{});}catch(e){error=String(e);}console.log(JSON.stringify({error,requests,duplicate,received:b.pack.reduce((n,i)=>n+i.count,0)}));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', code], { cwd: REPO_ROOT, windowsHide: true, stdout: 'pipe', stderr: 'pipe' });
    if (child.exitCode !== 0) throw Error(child.stderr.toString());
    const result = JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
    expect(result.error).toBe(''); expect(result.duplicate).toBe(false); expect(result.requests).toBe(2); expect(result.received).toBe(406);
});

function swapWindow(mode: 'late' | 'stuck' | 'stop') {
    const code = `
    import{mock}from'bun:test';import{resolve}from'node:path';
    let phase=0,pending,accepts=0;
    const stock=[{id:1437,count:405,slot:0},{id:1447,count:1,slot:1}],closed=()=>({isOpen:false,screen:null,myOffer:[],theirOffer:[],myAccepted:false});
    const a={name:'Supplier',pack:stock,trade:{...closed(),isOpen:true,screen:'confirm',partner:'Carrier',myOffer:stock}},b={name:'Carrier',pack:[],trade:{...closed(),isOpen:true,screen:'confirm',partner:'Supplier',theirOffer:stock}};
    for(const s of [a,b]){s.tick=()=>phase;s.sdk={getInventory:()=>s.pack,getState:()=>({nearbyPlayers:[]}),getTradeState:()=>s.trade,scanGroundItems:async()=>{},sendAcceptTrade:async()=>{accepts++;s.trade.myAccepted=true;return{success:true}}};}
    mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:()=>{
     if(!pending)pending=new Promise(r=>queueMicrotask(()=>{phase++;
      if(phase===1&&a.trade.myAccepted&&b.trade.myAccepted){b.pack=stock;a.pack=[];for(const s of [a,b]){s.trade.myOffer=[];s.trade.theirOffer=[];s.trade.myAccepted=false;}}
      if(phase===2)a.trade=closed();
      if(phase===3&&'${mode}'!=='stuck')b.trade=closed();
      pending=undefined;r();}));return pending;
    }}));
    const{ownedSwap}=await import('./packages/workers/src/runecraft/carrier-trade');let error='';try{await ownedSwap(a,b,{1437:405,1447:1},{},()=> '${mode}'==='stop'&&phase>=2);}catch(e){error=String(e);}
    console.log(JSON.stringify({error,phase,accepts,received:b.pack.reduce((n,i)=>n+i.count,0),bankReady:!a.trade.isOpen&&!b.trade.isOpen}));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', code], { cwd: REPO_ROOT, windowsHide: true, stdout: 'pipe', stderr: 'pipe' });
    if (child.exitCode !== 0) throw Error(child.stderr.toString());
    return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}
test('paired inventory settlement waits for both trade windows before the bank consumer', () => {
    const r = swapWindow('late'); expect(r.error).toBe(''); expect(r.received).toBe(406); expect(r.accepts).toBe(2); expect(r.bankReady).toBe(true); expect(r.phase).toBe(3);
});
test('a stuck trade window refuses within the existing50tick budget despite settled stock', () => {
    const r = swapWindow('stuck'); expect(r.error).toContain('trade windows stayed open'); expect(r.received).toBe(406); expect(r.phase).toBe(50); expect(r.accepts).toBe(2);
});
test('stop after inventory settlement prevents a new bank action', () => {
    const r = swapWindow('stop'); expect(r.error).toContain('owned swap stopped'); expect(r.received).toBe(406); expect(r.phase).toBe(2); expect(r.bankReady).toBe(false);
});

async function tickTrade(order: 'crafter' | 'helper', levelup: boolean) {
    const code = `import{mock}from'bun:test';import{resolve}from'node:path';
    const S=0,H=1,names=['Crafter','Carrier'],turns=${order === 'crafter' ? '[0,1]' : '[1,0]'};let tick=0,delayed=true,delayUntil=4,modal=false,levelup=${levelup};
    let open=false,screen=null,accepted=[false,false],offer=0,requested=[false,false],craftedAt=-1,cancelled=0,ignored=0,dropped=0;const ess=[0,27],queues=[[],[]],ops=[null,null],listeners=[[],[]];
    const pack=n=>Array.from({length:n},(_,slot)=>({id:1436,count:1,slot}));
    const busy=i=>(i===S&&(delayed||modal))||open;
    const decode=(i,a)=>{
     if(a.type==='interactPlayer'||a.type==='interactLoc'){
      if(i===S&&delayed){dropped++;return;}
      if(a.type==='interactLoc'&&open){open=false;screen=null;offer=0;cancelled++;}
      if(i===S)modal=false;ops[i]=a;return;}
     if(a.type==='closeModal'){if(i===S)modal=false;return;}
     if(!open){ignored++;return;}
     if(a.type==='clickComponentWithOption'&&a.componentId===3322&&screen==='offer'&&i===H){offer=ess[H];accepted=[false,false];return;}
     if(a.componentId===3420&&screen==='offer'){accepted[i]=true;if(accepted[1-i]){screen='confirm';accepted=[false,false];}return;}
     if(a.componentId===3546&&screen==='confirm'){accepted[i]=true;if(accepted[1-i]){ess[S]+=offer;ess[H]-=offer;offer=0;open=false;screen=null;accepted=[false,false];requested=[false,false];}return;}
     ignored++;};
    const turn=i=>{
     if(i===S&&delayed&&tick>=delayUntil){delayed=false;if(levelup){modal=true;levelup=false;}}
     const a=ops[i];ops[i]=null;if(!a)return;
     if(a.type==='interactLoc'){if(ess[S]===27){craftedAt=tick;ess[S]=0;delayed=true;delayUntil=tick+4;}return;}
     if(busy(1-i))return;
     if(requested[1-i]){open=true;screen='offer';accepted=[false,false];requested=[false,false];}else requested[i]=true;};
    const advance=()=>{tick++;for(const i of turns)for(const a of queues[i].splice(0))decode(i,a);for(const i of turns)turn(i);for(const i of [S,H])for(const l of [...listeners[i]])l();};
    const actors=[0,1].map(i=>({name:names[i],tick:()=>tick,onTick:cb=>{listeners[i].push(cb);return()=>{listeners[i]=listeners[i].filter(x=>x!==cb);};},
     direct:async a=>{queues[i].push(a);return{success:true};},
     sdk:{getInventory:()=>pack(ess[i]),getState:()=>({trade:{isOpen:open,screen,partner:names[1-i],myAccepted:accepted[i],myOffer:i===H?pack(offer):[],theirOffer:i===S?pack(offer):[]},
      dialog:i===S&&modal?{isOpen:true,allComponents:[{text:'Congratulations, you just advanced a runecraft level.'}]}:{isOpen:false},gameMessages:[],nearbyPlayers:[{name:names[1-i],index:1}]})}}));
    mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p,o)=>{for(let k=0;k<(o?.timeoutTicks??10);k++){if(p())return true;advance();}return p();},waitTicks:async()=>{advance();}}));
    const{tickTransfer}=await import('./packages/workers/src/runecraft/carrier-trade');let error='',credited=-1,result=-1;
    const craft={send:async()=>{await actors[S].direct({type:'interactLoc'});},complete:()=>craftedAt>=0};
    try{result=await tickTransfer(actors[S],actors[H],27,craft,()=>false,()=>{credited=tick;});}catch(e){error=String(e);}
    console.log(JSON.stringify({error,result,credited,craftedAt,cancelled,ignored,dropped,crafter:ess[S],helper:ess[H]}));`;
    const child = await fixtureChild(code, 3000);
    if (child.exitCode !== 0) throw Error(child.stderr);
    return JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
}
test('the tick-driven trade crafts the next pack 8 ticks after the last craft in both read orders', async () => {
    for (const order of ['crafter', 'helper'] as const) for (const levelup of [false, true]) {
        const r = await tickTrade(order, levelup);
        expect(r.error).toBe(''); expect(r.cancelled).toBe(0);
        expect(r.credited).toBe(7); expect(r.result).toBe(7); expect(r.craftedAt).toBe(8);
        expect(r.crafter).toBe(0); expect(r.helper).toBe(0); expect(r.dropped).toBeGreaterThan(0);
        if (order === 'crafter') expect(r.ignored).toBeGreaterThan(0);
    }
});

// =========================================================================
// Pipeline & Continuation tests
// =========================================================================

function pipelineFixture() {
    let tick = 10, complete = false, stopped = false; const listeners = new Set<() => void>();
    const session = { tick: () => tick, onTick: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; } };
    const boundary = observeCraftCompletion(session as any, () => complete, () => stopped);
    return { session: session as any, boundary, listeners, done: () => { complete = true; }, stop: () => { stopped = true; }, publish: (next: number) => { tick = next; for (const cb of [...listeners]) cb(); } };
}
test('a catch-up publication batch anchors its final count before four later turns', async () => {
    const f = pipelineFixture(); f.done(); f.publish(11); f.publish(12); f.publish(13);
    expect(f.boundary.tick()).toBeUndefined(); await Promise.resolve(); expect(f.boundary.tick()).toBe(13); expect(f.listeners.size).toBe(0);
    f.publish(16); expect(pipelineOpeningReady(f.session, f.boundary)).toBe(false);
    f.publish(17); expect(pipelineOpeningReady(f.session, f.boundary)).toBe(true);
});
test('split packets and action refreshes cannot anchor before a completed tick publication', async () => {
    const f = pipelineFixture(); f.publish(11); await Promise.resolve(); f.done(); await Promise.resolve(); expect(f.boundary.tick()).toBeUndefined();
    f.publish(12); await Promise.resolve(); expect(f.boundary.tick()).toBe(12); f.publish(15); expect(pipelineOpeningReady(f.session, f.boundary)).toBe(false);
    f.publish(16); expect(pipelineOpeningReady(f.session, f.boundary)).toBe(true);
});
test('stop before the anchor microtask removes the observer without a ready boundary', async () => {
    const f = pipelineFixture(); f.done(); f.publish(11); f.stop(); await Promise.resolve(); expect(f.boundary.tick()).toBeUndefined(); expect(f.listeners.size).toBe(0);
});
test('disposing a scheduled boundary prevents it from escaping into another craft', async () => {
    const f = pipelineFixture(); f.done(); f.publish(11); f.boundary.dispose(); await Promise.resolve(); expect(f.boundary.tick()).toBeUndefined(); expect(f.listeners.size).toBe(0);
    f.publish(20); expect(pipelineOpeningReady(f.session, f.boundary)).toBe(false);
});
test('the opt-in pipeline requires combined trade-message crafting before accounts open', () => {
    expect(runeHandoffPipeline('0', 'inventory')).toBe(false); expect(runeHandoffPipeline('0', 'trade-message')).toBe(false); expect(runeHandoffPipeline('1', 'trade-message')).toBe(true);
    for (const value of ['true', '2', '', '01']) expect(() => runeHandoffPipeline(value, 'trade-message')).toThrow();
    expect(() => runeHandoffPipeline('1', 'inventory')).toThrow();
});
test('pipeline opening preserves unrelated dialogs and stops on refused dispatch without retrying', async () => {
    for (const mode of ['dialog', 'refused', 'stop']) {
        const code = `import{mock}from'bun:test';import{resolve}from'node:path';let requests=0,crafts=0;
        const s={name:'Crafter'},h={name:'Carrier'};
        for(const[a,o]of[[s,h],[h,s]]){a.tick=()=>104;a.direct=async()=>{requests++;return{success:false}};a.sdk={getInventory:()=>a===h?[{id:1436,count:27,slot:0}]:[],getState:()=>({trade:{isOpen:false},gameMessages:[],player:{worldX:2523,worldZ:4833,level:0},nearbyPlayers:[{name:o.name,index:1}],dialog:{isOpen:'${mode}'==='dialog'&&a===s,allComponents:[{text:'Keep this quest choice'}]}}),scanGroundItems:async()=>{}};}
        mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:async()=>{throw Error('Unexpected tick wait')}}));
        const{transfer}=await import('./packages/workers/src/runecraft/carrier-trade');let error='';try{await transfer(s,h,()=> '${mode}'==='stop',27,{send:async()=>{crafts++},complete:()=>false},{boundary:{tick:()=>100,dispose:()=>{}}})}catch(e){error=String(e)}console.log(JSON.stringify({error,requests,crafts}));`;
        const child = await fixtureChild(code, 2000);
        expect(child.exitCode).toBe(0);
        const r = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
        expect(r.crafts).toBe(0); expect(r.requests).toBe(mode === 'refused' ? 2 : 0);
        expect(r.error).toContain(mode === 'dialog' ? 'preserves unrelated dialogs' : mode === 'refused' ? 'reciprocal request refused' : 'did not reconcile');
    }
});

test('saved measurement rejects moving otherwise conserved output from bank to backpack', () => {
    const before = { inventories: { 93: [], 95: [{ slot: 0, id: 559, count: 12522 }] } }, after = { inventories: { 93: [] as { slot: number; id: number; count: number }[], 95: [{ slot: 0, id: 559, count: 13494 }] } };
    expect(runeMeasurementBankedOutput(before, after, 972)).toBe(true);
    const mutated = structuredClone(after); mutated.inventories[95][0]!.count -= 972; mutated.inventories[93].push({ slot: 0, id: 559, count: 972 });
    const total = (s: typeof after) => Object.values(s.inventories).flat().reduce((n, i) => n + i.count, 0);
    expect(total(mutated)).toBe(total(after));
    expect(runeMeasurementBankedOutput(before, mutated, 972)).toBe(false);
    expect(runeMeasurementBankedOutput(before, after, 973)).toBe(false);
});
test('continuation reconciles dense and sparse lifecycle varps without accepting quest or unexplained changes', () => {
    const before = { version: 6, vars: Object.fromEntries(Array.from({ length: 309 }, (_, id) => [id, id === 63 ? 6 : id === 281 ? 1000 : 0])) };
    const after = { version: 10, vars: { 21: 1114112, 25: 16384, 63: 6, 101: 1, 134: 923, 166: 2, 168: 2, 169: 2, 275: 4294967295, 277: 4294967295, 281: 1000, 300: 1000, 346: 2, 367: 4294967295 } };
    const refusal = { version: 10, vars: { ...after.vars, 134: 999, 4: 4294967295, 9: 4294967295, 13: 4294967295, 16: 4294967295, 28: 4294967295, 64: 4294967295, 181: 4294967295, 209: 4294967295 } };
    expect(runeContinuationVarpDifferences(before, after, 'craft')).toEqual([]);
    expect(runeContinuationVarpDifferences(after, refusal, 'refusal')).toEqual([]);
    for (const [b, a, phase] of [[before, after, 'craft'], [after, refusal, 'refusal']] as const) {
        for (const [id, value] of [[63, 5], [29, 1], [4, 12345], [21, 1114113], [101, 2], [300, 999], [134, 0], [390, 1]]) {
            expect(runeContinuationVarpDifferences(b, { ...a, vars: { ...a.vars, [id!]: value! } }, phase).some(d => d.id === id)).toBe(true);
        }
    }
    expect(runeContinuationVarpDifferences({ ...after, vars: { ...after.vars, 4: 12345 } }, refusal, 'refusal').some(d => d.id === 4)).toBe(true);
    const falador = { ...after, vars: { ...after.vars, 21: 1118208, 24: 2148532224 } };
    expect(runeContinuationVarpDifferences(before, falador, 'craft', 'falador-bank')).toEqual([]);
    expect(runeContinuationVarpDifferences(before, falador, 'craft').map(d => d.id)).toEqual([21, 24]);
    for (const [id, value] of [[63, 5], [21, 1118209], [24, 2148532225]]) expect(runeContinuationVarpDifferences(before, { ...falador, vars: { ...falador.vars, [id!]: value! } }, 'craft', 'falador-bank').some(d => d.id === id)).toBe(true);
});

function bankApproach(mode: 'far' | 'near' | 'cancel') {
    const code = `
    import {mock} from 'bun:test';
    import {resolve} from 'node:path';
    let player={worldX:${mode === 'near' ? 3092 : 3011},worldZ:${mode === 'near' ? 3491 : 3355},level:0},generation=7,open=false,approaches=0,opens=0,routes=0,aborted=false;const budgets=[];
    let inventory=[{id:1446,count:1},{id:1436,count:27}],items=[{id:1436,count:108}];
    const loc={id:2213,x:3095,z:3491,level:0,name:'Bank booth',distance:4,optionsWithIndex:[{text:'Use',opIndex:1},{text:'Use-quickly',opIndex:2}]};
    const s={name:'retained',tick:()=>100,bankObservation:()=>({generation,items}),
     sdk:{getInventory:()=>inventory,getSkill:()=>({level:10}),getState:()=>({player,nearbyLocs:[loc],bank:{isOpen:open,items}})},
     bot:{openBank:async()=>{opens++;if(player.worldX!==3094||player.worldZ!==3491)throw Error('travel tolerance is not booth reach');open=true;generation++;return {success:true};}}
    };
    const modules={
    'packages/core/src/ticks':{waitUntil:async(_s,p)=>p()},
    'packages/core/src/walk':{sessionWalker:async()=>s,walkPath:async(_w,[p],opts)=>{budgets.push(opts.maxTicks);if(player.worldZ<3400)throw Error('long Falador staging exceeds refill150tick budget');if(p.x===3092&&p.z===3496){player={worldX:3092,worldZ:3491,level:0};return{ok:false,ticks:151,still:23,repaths:3,detail:'live bank waypoint stalled'}}player={worldX:p.x,worldZ:p.z,level:0};return {ok:true};},
    walkRoute:async(_w,[leg],opts)=>{routes++;if(leg.kind!=='walk'||leg.to.x!==3094||leg.to.z!==3491||leg.to.level!==0||leg.tolerance!==2||!opts.signal)throw Error('wrong staging leg');if('${mode}'==='cancel'){queueMicrotask(()=>stopCarriers());await new Promise(r=>opts.signal.addEventListener('abort',()=>{aborted=true;r();},{once:true}));return{ok:false,reason:'aborted',ticks:1};}player={worldX:leg.to.x,worldZ:leg.to.z,level:0};return{ok:true,ticks:161};}},
    'packages/core/src/world':{interactionApproach:async(_sdk,at,q)=>{approaches++;if(at.x!==3095||at.z!==3491||at.level!==0||q.id!==2213||q.shape!==10||q.angle!==3||q.width!==1||q.height!==1||q.blockAccessFlags!==0)throw Error('wrong booth geometry');return {x:3094,z:3491,level:0};}},
    'packages/core/src/deposit':{depositObserved:async(_s,item)=>{if(!open||generation<=7)throw Error('stale bank');const held=inventory.find(i=>i.id===item.id);const bank=items.find(i=>i.id===item.id);if(bank)bank.count+=held.count;else items.push({...held});inventory=inventory.filter(i=>i.id!==item.id);generation++;}},
    'packages/workers/src/runecraft/altars':{BODY_CARRIER_ALTAR:{name:'body',rune:559,talisman:1446,altar:{id:2483,x:2522,z:4838},bank:{site:'falador-north',x:3094,z:3491}},RUNE_ALTARS:[{name:'body',outside:{x:3050,z:3442},portal:2470}],insideCarrierAltar:()=>false,ruinTarget:()=>({})},
    'packages/workers/src/runecraft/bank-craft':{dispatchRuneEntry:async()=>({})},
    'packages/workers/src/runecraft/carrier-trade':{runeTickTrade:()=>false,tickTransfer:async()=>{throw Error('the tick trade is off in this fixture')},runeConfirmation:()=>process.env.RUNE_CONFIRM_AFTER??'causal',runeOpening:()=>process.env.RUNE_OPEN_AFTER??'incoming',state:a=>a.sdk.getState(),ess:()=>0}
    };
    for(const [p,m]of Object.entries(modules))mock.module(resolve(p),()=>m);
    const {bankCarrier,stopCarriers}=await import('./packages/workers/src/runecraft/carrier-bank');
    let assets,failure;try{assets=await bankCarrier(s);}catch(e){failure=String(e);}console.log(JSON.stringify({assets,failure,approaches,opens,generation,inventory,routes,budgets,aborted}));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', code], { cwd: REPO_ROOT, windowsHide: true, stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
    if (child.exitCode !== 0) throw Error(child.stderr.toString());
    return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}
test('Falador staging uses the distance-budget route before observing the booth and bank', () => {
    const r = bankApproach('far'); expect(r.failure).toBeUndefined(); expect(r.routes).toBe(1); expect(r.budgets).toEqual([150]);
    expect(r.assets).toEqual({ 1436: 135, 1446: 1 }); expect(r.inventory).toEqual([]);
    expect(r.approaches).toBeGreaterThan(0); expect(r.opens).toBe(1); expect(r.generation).toBe(10);
});
test('near-bank staging retains its150tick walks and exact booth face', () => {
    const r = bankApproach('near'); expect(r.failure).toBeUndefined(); expect(r.routes).toBe(0); expect(r.budgets).toEqual([150, 150]); expect(r.opens).toBe(1);
});
test('stopping a long staging leg aborts it before opening or depositing', () => {
    const r = bankApproach('cancel'); expect(r.aborted).toBe(true); expect(r.failure).toContain('carrier stopped'); expect(r.opens).toBe(0); expect(r.inventory).toEqual([{ id: 1446, count: 1 }, { id: 1436, count: 27 }]);
});
test('measurement allocates only full packs on an existing99 while normal continuation still refuses99', () => {
    const code = `import{continuationLoads}from'./packages/workers/src/runecraft/carriers';
    const stocks=Array(16).fill(405),errors=[];const measure=continuationLoads(998625,stocks,187.5,37);
    for(const args of [[998625,stocks,187.5],[793125,stocks,187.5,37],[199999000,stocks,187.5,13],[998625,Array(16).fill(26),187.5,12],[998625,stocks,187.5,49]]){try{continuationLoads(...args);errors.push('accepted');}catch(e){errors.push(String(e));}}
    console.log(JSON.stringify({measure,errors}));`;
    const child = Bun.spawnSync([process.execPath, '-e', code], { cwd: REPO_ROOT, windowsHide: true, stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
    if (child.exitCode !== 0) throw Error(child.stderr.toString());
    const r = JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
    expect(r.measure.needed).toBe(999); expect(r.measure.loads.flat()).toHaveLength(37); expect(r.measure.loads.flat().every((n: number) => n === 27)).toBe(true);
    expect(r.errors).toHaveLength(5); expect(r.errors.every((e: string) => e !== 'accepted')).toBe(true);
});

function continuationCase(measurePacks?: number, craftAfter = 'inventory') {
    const code = `
    import {mock} from 'bun:test';
    import {resolve} from 'node:path';
    let tick=0,stopped=false,xp=${measurePacks === undefined ? 793125 : 998625},starterCalls=0,swaps=0,bankFailure=false;
    const options=${JSON.stringify({ measurePacks, craftAfter })};let craftCalls=0;
    const sum=(a,id)=>a.pack[id]??0;
    const fixtures=${JSON.stringify(runeContinuationHelpers)};
    const actor=(i)=>({name:'retained'+i,pack:i?{1446:1,...(fixtures[i-1][2]?{1436:fixtures[i-1][2]}:{})}:{559:9234},bank:i?{1436:fixtures[i-1][3],...(i===2?{1446:1}:{})}:{995:500,559:7},position:i&&fixtures[i-1][1]<4800?'bank-route':'altar',
     tick:()=>tick,bot:{dismissBlockingUI:async()=>({success:true})},
     sdk:{getInventory(){return Object.entries(this.owner.pack).filter(([,n])=>n).map(([id,count])=>({id:+id,count}));},getEquipment:()=>[],getSkillXp:()=>xp,getSkill:n=>({baseLevel:n==='Runecraft'?(xp>=998458?99:95):10,level:10}),getState(){return {player:{worldX:2523,worldZ:4833,level:0},nearbyLocs:[{id:2483,x:2521,z:4840}]};}},
     direct:async function(){craftCalls++;const n=sum(this,1436);delete this.pack[1436];this.pack[559]=(this.pack[559]??0)+n*3;xp+=n*187.5;tick+=2;return{success:true};}
    });
    const all=Array.from({length:17},(_,i)=>actor(i));for(const a of all)a.sdk.owner=a;
    const move=(a,b,items)=>{for(const [id,n] of Object.entries(items)){if(sum(a,id)!==n)throw Error('whole item swap mismatch');delete a.pack[id];b.pack[id]=(b.pack[id]??0)+n;}};
    const bank=async a=>{if(bankFailure){if(a===all[1])throw Error('first bank refusal');await Promise.resolve();await Promise.resolve();throw Error('secondary carrier stopped');}if(stopped)throw Error('stopped');for(const [id,n]of Object.entries(a.pack))a.bank[id]=(a.bank[id]??0)+n;a.pack={};a.position='bank';tick+=4;return {...a.bank};};
    const withdraw=async(a,id,n)=>{if((a.bank[id]??0)<n)throw Error('short');a.bank[id]-=n;if(!a.bank[id])delete a.bank[id];a.pack[id]=(a.pack[id]??0)+n;};
    const realBot=await import('./packages/core/src/bot');
    const modules={
    'packages/core/src/bot':{...realBot,getWorld:async()=>({}),openBot:async()=>{throw Error('unexpected open')},settle:async()=>true,serverFromEnv:()=>''},
    'packages/core/src/fleet':{assertSideOwns:()=>{}},
    'packages/core/src/ticks':{waitTicks:async()=>{},waitUntil:async(_s,p)=>{for(let i=0;i<30&&!p();i++)await Promise.resolve();return p();},onSessionEnd:()=>()=>{}},
    'packages/workers/src/runecraft/carrier-start':{freshBodyStart:async()=>{starterCalls++;throw Error('tutorial prohibited');}},
    'packages/workers/src/runecraft/carrier-bank':{bankCarrier:bank,withdrawCarrier:withdraw,closeCarrierBank:async()=>{},inside:a=>a.position==='altar',enterBody:async a=>{a.position='altar';},stopCarriers:()=>{stopped=true;},restock:async()=>{throw Error('fresh refill prohibited');},
     stageCarrier:async(a,n,fromBank)=>{if(!fromBank)await bank(a);await withdraw(a,1446,1);await withdraw(a,1436,n);a.position='altar';}},
    'packages/workers/src/runecraft/carrier-trade':{runeTickTrade:()=>false,tickTransfer:async()=>{throw Error('the tick trade is off in this fixture')},runeConfirmation:()=>process.env.RUNE_CONFIRM_AFTER??'causal',runeOpening:()=>process.env.RUNE_OPEN_AFTER??'incoming',runeHandoffPipeline:()=>false,pipelineOpeningReady:()=>true,observeCraftCompletion:()=>({tick:()=>undefined,dispose:()=>{}}),ess:a=>sum(a,1436),state:a=>a.sdk.getState(),ownedSwap:async(a,b,giveA,giveB)=>{swaps++;move(a,b,giveA);move(b,a,giveB);return{ticks:1};},transfer:async(a,b,_stop,n=27,craft)=>{move(b,a,{1436:n});tick+=10;if(craft)await craft.send();return 10;}}
    };
    for(const [p,m]of Object.entries(modules))mock.module(resolve(p),()=>m);
    const {continueRuneBody}=await import('./packages/workers/src/runecraft/carriers');
    const r=await continueRuneBody(all[0],all.slice(1),()=>stopped||tick>2800,options);
    let normalRefusal;try{await continueRuneBody(all[0],all.slice(1),()=>stopped);}catch(e){normalRefusal=String(e);}
    xp=${measurePacks === undefined ? 793125 : 998625};bankFailure=true;let failure;
    try{await continueRuneBody(all[0],all.slice(1),()=>stopped||tick>2800,options);}catch(e){failure=String(e);}
    console.log(JSON.stringify({r,starterCalls,swaps,tick,failure,normalRefusal,craftCalls}));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', code], { cwd: REPO_ROOT, windowsHide: true, stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
    if (child.exitCode !== 0) throw Error(child.stderr.toString());
    return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}
test('persisted95 uses mixed retained stock and positions without tutorial or starter swaps', () => {
    const { r, starterCalls, swaps, tick, failure, normalRefusal } = continuationCase();
    expect(normalRefusal).toContain('below99');
    expect(failure).toBe('Error: first bank refusal');
    expect(starterCalls).toBe(0); expect(swaps).toBeGreaterThanOrEqual(2);
    expect(r.xp0).toBe(793125); expect(r.level).toBe(99); expect(r.consumed).toBe(1096); expect(r.crafted).toBe(3288);
    expect(new Set(r.rows.slice(0, 16).map((row: any) => row.helper)).size).toBe(16);
    expect(r.before.slice(1).reduce((n: number, b: any) => n + (b[1436] ?? 0), 0)).toBe(8628);
    expect(r.after[0][559]).toBe(9234 + 7 + 3288); expect(r.after[0][995]).toBe(500);
    expect(r.after[2][1446]).toBe(2); expect(r.after[0][1446] ?? 0).toBe(0); expect(tick).toBeLessThan(2800);
});
test('existing99 measurement banks exactly37 full packs while ordinary entry still refuses it', () => {
    const { r, starterCalls, swaps, failure, normalRefusal } = continuationCase(37);
    expect(r.confirmation).toBe('causal'); expect(r.mode).toBe('body-measure'); expect(r.requestedPacks).toBe(37); expect(r.batches).toBe(37); expect(r.consumed).toBe(999); expect(r.crafted).toBe(2997); expect(r.xp0).toBe(998625); expect(r.xp).toBe(1185937.5);
    expect(r.after[0][559]).toBe(9234 + 7 + 2997); expect(new Set(r.rows.slice(0, 16).map((row: any) => row.helper)).size).toBe(16); expect(starterCalls).toBe(0); expect(swaps).toBe(2); expect(failure).toBe('Error: first bank refusal'); expect(normalRefusal).toContain('below99');
});
test('combined continuation crafting dispatches once per measured pack with the same final balances', () => {
    const { r, craftCalls, normalRefusal } = continuationCase(37, 'trade-message'); expect(r.craftAfter).toBe('trade-message'); expect(craftCalls).toBe(37); expect(r.consumed).toBe(999); expect(r.crafted).toBe(2997); expect(r.after[0][559]).toBe(12238); expect(normalRefusal).toContain('below99');
});

// =========================================================================
// Unified WorkerModule<RunecraftConfig> contract, preflight, estimate & CLI tests
// =========================================================================

function makeRcAccount(over: Partial<WorkerAccountView> = {}): WorkerAccountView {
    return {
        name: 'RcTester',
        side: 'local',
        protectedClock: false,
        skills: {
            Runecraft: { level: 60, xp: 273_742 },
            Prayer: { level: 50, xp: 101_333 },
            Hitpoints: { level: 50, xp: 101_333 },
        },
        quests: {
            'Rune Mysteries': 'complete',
            'Lost City': 'complete',
            'Shilo Village': 'complete',
        },
        pos: { x: 3092, z: 3243, level: 0 },
        inventory: {},
        equipment: {},
        bank: {
            items: { 1436: 500, 1438: 1, 1446: 1, 1454: 1, 1462: 1, 772: 1 },
            observedAt: 1_000,
            trusted: true,
        },
        ...over,
    };
}

function makeRcWorld(acct: WorkerAccountView): WorkerWorldView {
    return {
        at: 1_000,
        side: 'local',
        server: 'localhost:8888',
        accounts: { [acct.name]: acct },
    };
}

test('runecraftWorker satisfies WorkerModule contract and registry metadata', () => {
    expect(validateWorkerModule(runecraftWorker)).toEqual([]);
    expect(isWorkerModule(runecraftWorker)).toBe(true);
    expect(runecraftWorker.id).toBe('runecraft:unified');
    expect(runecraftWorker.family).toBe('runecraft');
    expect(runecraftWorker.kind).toBe('produce');
    expect(runecraftWorker.trust).toBe('practice_passed');
    expect(runecraftWorker.protectedAllowed).toBe(false);

    const reg = createWorkerRegistry([runecraftWorker]);
    expect(reg.require('runecraft:unified')).toBe(runecraftWorker);
});

test('runecraftPreflight approves valid configs and catches invalid/blocked preconditions across modes', () => {
    const acct = makeRcAccount();
    const world = makeRcWorld(acct);

    for (const cfg of [
        { mode: 'bank-craft' as const },
        { mode: 'bank-craft' as const, altar: 'cosmic', essenceTarget: 27 },
        { mode: 'nature' as const, natureJob: { target: 27, batch: 27, cap: 5000, returnTicks: 400, reserve: 0, members: true, protectMelee: true } },
        { mode: 'supply' as const, targetLevel: 99 },
        { mode: 'carriers' as const, roster: ['Fresh', 'Donor', 'HelperA'] },
        { mode: 'staged' as const, altar: 'fire', targetLevel: 44, roster: ['Crafter', 'HelperA', 'HelperB'] },
        { mode: 'stage-carriers' as const, roster: ['Supplier', 'CarrierA'] },
        { mode: 'stage-opening' as const, roster: ['Supplier'] },
    ]) {
        const res = runecraftPreflight(acct, cfg, world);
        expect(isPreflightResult(res)).toBe(true);
        expect(res.ok, `${cfg.mode}: ${JSON.stringify(res.blockers)}`).toBe(true);
    }

    const insideAir = makeRcAccount({ pos: { x: 2841, z: 4830, level: 0 }, inventory: { 1436: 27 } });
    expect(runecraftPreflight(insideAir, { mode: 'air' }, makeRcWorld(insideAir)).ok).toBe(true);
    expect(runecraftPreflight(acct, { mode: 'air' }, world).blockers.map(b => b.kind)).toContain('unreachable_tile');

    expect(runecraftPreflight(makeRcAccount({ protectedClock: true }), { mode: 'bank-craft' }, world).blockers.map(b => b.kind)).toContain('protected_clock');
    expect(runecraftPreflight(makeRcAccount({ maxLevels: { Runecraft: 60 } }), { mode: 'bank-craft' }, world).blockers.map(b => b.kind)).toContain('max_level_cap');
    expect(runecraftPreflight(makeRcAccount({ quests: {} }), { mode: 'bank-craft', altar: 'cosmic', members: false }, world).blockers.map(b => b.kind)).toEqual(expect.arrayContaining(['invalid_config', 'quest_incomplete']));
    expect(runecraftPreflight(makeRcAccount({ bank: { observedAt: 1, trusted: true, items: {} } }), { mode: 'bank-craft', altar: 'air' }, world).blockers.map(b => b.kind)).toContain('missing_supply');
    expect(runecraftPreflight(acct, { mode: 'bank-craft', altar: 'bad-altar' }, world).blockers[0]!.kind).toBe('invalid_config');
});

test('runecraftEstimate, toRunecraftWorkerOutcome, runecraftWorker.run, and runRunecraftCli obey contracts', async () => {
    const acct = makeRcAccount();
    const world = makeRcWorld(acct);
    for (const cfg of [
        { mode: 'bank-craft' as const },
        { mode: 'bank-craft' as const, altar: 'cosmic' },
        { mode: 'nature' as const, natureJob: natureJob() },
        { mode: 'supply' as const },
        { mode: 'air' as const },
        { mode: 'carriers' as const, roster: ['Crafter', 'Donor', 'Helper'] },
    ]) {
        const est = runecraftEstimate(acct, cfg, world);
        expect(isRateEstimate(est), cfg.mode).toBe(true);
        expect(est.xpPerTick).toBeGreaterThan(0);
    }

    const norm = normalizeRunecraftConfig({ mode: 'air' });
    const met = toRunecraftWorkerOutcome({ ok: true, kind: 'completed', mode: 'air', unitsCompleted: 10, xpGained: 1250 }, 'RcTester', norm, 3);
    expect(isRunOutcome(met)).toBe(true);
    expect(met).toMatchObject({ kind: 'target_met', unitsCompleted: 10, xpGained: { Runecraft: 1250 }, ticksElapsed: 3 });

    const makeAirSession = () => {
        let inv = [{ id: 1436, name: 'Rune essence', count: 1, slot: 0 }];
        let rcXp = 0;
        return {
            name: 'RcAir',
            tick: () => 1,
            onTick: () => () => {},
            ended: new Promise(() => {}),
            sdk: {
                getState: () => ({ player: { worldX: 2841, worldZ: 4830, level: 0 }, inventory: inv }),
                getInventory: () => inv,
                getSkill: () => ({ level: 1, baseLevel: 1 }),
                getSkillXp: () => rcXp,
                findNearbyLoc: () => ({ id: 2478, name: 'Altar' }),
            },
            bot: {
                dismissBlockingUI: async () => {},
                interactLoc: async () => {
                    inv = [{ id: 556, name: 'Air rune', count: 1, slot: 0 }];
                    rcXp = 125;
                    return { success: true };
                },
            },
        };
    };
    const airRes = await runecraftWorker.run(makeAirSession() as any, { mode: 'air' });
    expect(airRes.kind).toBe('target_met');

    let finishSummary = '';
    const cliExit = await runRunecraftCli(
        'air',
        'RcAir',
        [],
        {},
        {
            openBot: async () => makeAirSession() as any,
            finish: async (_s, ok, summary) => { finishSummary = `${ok}:${summary}`; },
        },
    );
    expect(cliExit).toBe(0);
    expect(finishSummary).toContain('true:');

    const stoppedEntry = await runecraftWorker.run(makeAirSession() as any, { mode: 'air', stop: () => true });
    expect(isRunOutcome(stoppedEntry)).toBe(true);
    expect(stoppedEntry.kind).toBe('session_unsettled');

    const endedEntry = await runecraftWorker.run({ ...makeAirSession(), ended: Promise.resolve() } as any, { mode: 'air' });
    expect(isRunOutcome(endedEntry)).toBe(true);
    expect(endedEntry.kind).toBe('session_unsettled');

    let stopDuringAir = false;
    const midStopSession = {
        ...makeAirSession(),
        bot: {
            dismissBlockingUI: async () => {},
            interactLoc: async () => {
                stopDuringAir = true;
                return { success: false };
            },
        },
    };
    const airMidStop = await runecraftWorker.run(midStopSession as any, { mode: 'air', stop: () => stopDuringAir });
    expect(isRunOutcome(airMidStop)).toBe(true);
    expect(airMidStop.kind).toBe('session_unsettled');
});

test('runecraft preflight checks level caps/air reserves, maps config refusals to worker_defect, and enterAirAltar honors stop', async () => {
    const { enterAirAltar } = await import('../src/runecraft/air');
    const capped = makeRcAccount({ maxLevels: { Runecraft: 60 }, bank: { observedAt: 1, trusted: true, items: { 1436: 100, 1438: 1 } } });
    const world = makeRcWorld(capped);
    expect(runecraftPreflight(capped, { mode: 'supply' }, world).blockers.map(b => b.kind)).toContain('max_level_cap');
    expect(runecraftPreflight(capped, { mode: 'nature', natureJob: natureJob() }, world).blockers.map(b => b.kind)).toContain('max_level_cap');
    expect(runecraftPreflight(capped, { mode: 'air' }, world).blockers.map(b => b.kind)).toContain('max_level_cap');

    const airAcct = makeRcAccount({
        name: 'ReserveAir',
        bank: { observedAt: 1, trusted: true, items: { 1436: 10, 1438: 1 } },
    });
    const reservedWorld: WorkerWorldView = {
        ...makeRcWorld(airAcct),
        reserves: { reserveair: { 1436: 6 } },
        globalReserves: { 1436: 4 },
    };
    expect(runecraftPreflight(airAcct, { mode: 'air' }, reservedWorld).blockers.map(b => b.kind)).toContain('missing_supply');

    const refusalOutcome = toRunecraftWorkerOutcome(
        { ok: false, kind: 'refused', mode: 'supply', detail: 'Runecraft supply target must be 2..99 (got 1)' },
        'RcTester',
        normalizeRunecraftConfig({ mode: 'supply' }),
        1,
    );
    expect(isRunOutcome(refusalOutcome)).toBe(true);
    expect(refusalOutcome.kind).toBe('worker_defect');

    let usedTalisman = false;
    const ruinsSession: any = {
        name: 'AirStop',
        tick: () => 1,
        sdk: {
            getState: () => ({
                player: { worldX: 2985, worldZ: 3291, level: 0 },
                nearbyLocs: [{ id: 2452, name: 'Mysterious ruins', x: 2985, z: 3292 }],
            }),
            getInventory: () => [{ id: 1438, name: 'Air talisman', count: 1, slot: 0 }],
        },
        bot: {
            useItemOnLoc: async () => {
                usedTalisman = true;
                return { success: true };
            },
        },
    };
    await expect(enterAirAltar(ruinsSession, () => true)).rejects.toThrow('air entry stopped');
    expect(usedTalisman).toBe(false);
});
