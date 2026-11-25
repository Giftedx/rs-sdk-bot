// Lockstep benchmark worker for Haggis Tourist Trap prep steps:
// 1) fletch-10: headless + bronze arrowtips -> Fletching 1 -> 10 (980 XP)
// 2) magic-wind-1-7: Wind Strike on Lumbridge chickens -> Magic 1 -> 7
// 3) magic-enchant-7-43: 12 Sapphire + 16 Emerald ring enchants at bank -> Magic 7 -> 43
// 4) smith-20: 12 bronze + 4 iron superheat casts at bank -> Smithing 1 -> 20 (+ Magic 43 -> 52)
// Usage: bun scripts/measure/haggis-tt-prep.ts <bot> <fletch-10|magic-wind-1-7|magic-enchant-7-43|smith-20>
import { finish, openBot } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { componentId } from '../../packages/core/src/logout';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';
import { xpForLevel } from '../../packages/planner/src/curve';
import { bankItems, bankOpen, clearDialogs, countId, inv, level, meter, openBank, send, tick, withdrawN, xp } from '../../packages/practice/src/floor-lib';

const HEADLESS_ARROW = 53;
const BRONZE_ARROWTIPS = 39;
const SAPPHIRE_RING = 1637;
const EMERALD_RING = 1639;
const COPPER_ORE = 436;
const TIN_ORE = 438;
const IRON_ORE = 440;

type PrepMode = 'fletch-10' | 'magic-wind-1-7' | 'magic-enchant-7-43' | 'smith-20';

async function runFletch10(s: Session): Promise<string> {
    const t0 = s.tick();
    const xp0 = xp(s, 'Fletching');
    const targetXp = xpForLevel(10);
    for (let t = 0; t < 20 && (level(s, 'Fletching') < 10 || xp(s, 'Fletching') < targetXp); t++) {
        const cur = inv(s);
        const h = cur.find(i => i.id === HEADLESS_ARROW);
        const a = cur.find(i => i.id === BRONZE_ARROWTIPS);
        if (!h || !a) break;
        const sends: Promise<unknown>[] = [];
        for (let k = 0; k < 3; k++) {
            sends.push(s.direct({ type: 'useItemOnItem', sourceSlot: h.slot, targetSlot: a.slot, reason: 'SDK' }));
        }
        await Promise.all(sends);
        await tick(s, 1);
    }
    const ticks = s.tick() - t0;
    const gained = xp(s, 'Fletching') - xp0;
    const lvl = level(s, 'Fletching');
    if (lvl < 10 || gained < targetXp) {
        throw Error(`fletch-10 incomplete: level=${lvl} xp=${gained} ticks=${ticks}`);
    }
    return `mode=fletch-10 ticks=${ticks} level=${lvl} xp=${gained} xpPerTick=${(gained / Math.max(1, ticks)).toFixed(1)}`;
}

async function runWind1To7(s: Session): Promise<string> {
    const t0 = s.tick();
    const xp0 = xp(s, 'Magic');
    const targetXp = xpForLevel(7);
    const windStrike = componentId('magic:wind_strike');
    let casts = 0;
    let prevXp = xp0;
    let lastCastTick = -99;
    while (s.tick() - t0 < 150 && (level(s, 'Magic') < 7 || xp(s, 'Magic') < targetXp)) {
        const nowXp = xp(s, 'Magic');
        if (nowXp > prevXp) {
            prevXp = nowXp;
            lastCastTick = s.tick() - 1;
        }
        if (s.sdk.getState()?.dialog?.isOpen) {
            await s.direct({ type: 'closeModal', reason: 'SDK' });
        }
        const npcs = (s.sdk.getNearbyNpcs() ?? []).filter(
            (n: any) => /^(chicken|rat|giant rat)$/i.test(n.name) && n.optionsWithIndex?.some((o: any) => /^attack$/i.test(o.text)),
        );
        const npc = npcs.sort((a: any, b: any) => a.distance - b.distance)[0];
        if (npc && s.tick() - lastCastTick >= 5) {
            await s.direct({ type: 'spellOnNpc', npcIndex: npc.index, spellComponent: windStrike, reason: 'SDK' });
            casts++;
        }
        await tick(s, 1);
    }
    const ticks = s.tick() - t0;
    const gained = xp(s, 'Magic') - xp0;
    const lvl = level(s, 'Magic');
    if (lvl < 7 || gained < targetXp) {
        throw Error(`magic-wind-1-7 incomplete: level=${lvl} xp=${gained} casts=${casts} ticks=${ticks}`);
    }
    return `mode=magic-wind-1-7 ticks=${ticks} casts=${casts} level=${lvl} xp=${gained} xpPerTick=${(gained / Math.max(1, ticks)).toFixed(1)}`;
}

async function withdrawExactBatch(s: Session, want: ReadonlyArray<readonly [number, number]>): Promise<void> {
    const m = meter(s, 'Bank');
    await clearDialogs(s, m, 'close');
    if (await openBank(s, m) < 0) throw Error('failed to open bank booth');
    const seen = new Set<number>();
    for (const it of inv(s)) {
        if ([564, 555, 561].includes(it.id) || seen.has(it.id)) continue;
        seen.add(it.id);
        await send(s, m, { type: 'bankDeposit', slot: it.slot, amount: -1 });
    }
    for (const [id, count] of want) {
        let b = bankItems(s).find(x => x.id === id);
        for (let r = 0; r < 3 && (!b || b.count < count); r++) {
            await tick(s, 1);
            b = bankItems(s).find(x => x.id === id);
        }
        if (!b || b.count < count) throw Error(`bank missing item ${id} (need ${count}, have ${b?.count ?? 0})`);
        await withdrawN(s, m, b.slot, count);
    }
    await send(s, m, { type: 'closeModal' });
    await waitUntil(s, () => !bankOpen(s) && want.every(([id, count]) => countId(s, id) >= count), { timeoutTicks: 20 });
}

async function runEnchant7To43(s: Session): Promise<string> {
    const t0 = s.tick();
    const xp0 = xp(s, 'Magic');
    const targetXp = xpForLevel(43);
    const lvl1 = componentId('magic:enchant_lvl1');
    const lvl2 = componentId('magic:enchant_lvl2');
    let casts = 0;

    // 2 rune stacks occupy 2 slots -> 26 rings fit in trip 1 (12 Sapphire + 14 Emerald), remaining 2 Emerald in trip 2.
    const batches: ReadonlyArray<readonly (readonly [number, number])[]> = [
        [[SAPPHIRE_RING, 12], [EMERALD_RING, 14]],
        [[EMERALD_RING, 2]],
    ];
    for (const batch of batches) {
        if (level(s, 'Magic') >= 43 && xp(s, 'Magic') >= targetXp) break;
        await withdrawExactBatch(s, batch);
        while (s.tick() - t0 < 250 && (level(s, 'Magic') < 43 || xp(s, 'Magic') < targetXp)) {
            const lvl = level(s, 'Magic');
            const cur = inv(s);
            const ring = lvl >= 27 ? cur.find(i => i.id === EMERALD_RING) : cur.find(i => i.id === SAPPHIRE_RING);
            if (!ring) break;
            const comp = ring.id === EMERALD_RING ? lvl2 : lvl1;
            const before = countId(s, ring.id);
            if (s.sdk.getState()?.dialog?.isOpen) {
                await s.direct({ type: 'closeModal', reason: 'SDK' });
            }
            await s.direct({ type: 'spellOnItem', slot: ring.slot, spellComponent: comp, reason: 'SDK' });
            await waitTicks(s, 1);
            if (countId(s, ring.id) < before) {
                casts++;
                await waitTicks(s, 2);
            }
        }
    }
    const ticks = s.tick() - t0;
    const totalXp = xp(s, 'Magic');
    const gained = totalXp - xp0;
    const lvl = level(s, 'Magic');
    if (lvl < 43 || totalXp < targetXp) {
        throw Error(`magic-enchant-7-43 incomplete: level=${lvl} xp=${gained} totalXp=${totalXp} casts=${casts} ticks=${ticks}`);
    }
    return `mode=magic-enchant-7-43 ticks=${ticks} casts=${casts} level=${lvl} xp=${gained} xpPerTick=${(gained / Math.max(1, ticks)).toFixed(1)}`;
}

async function runSmith20(s: Session): Promise<string> {
    const t0 = s.tick();
    const smithXp0 = xp(s, 'Smithing');
    const magicXp0 = xp(s, 'Magic');
    const targetXp = xpForLevel(20);
    const superheat = componentId('magic:superheat_item');
    let casts = 0;

    const batches: ReadonlyArray<{ withdraw: readonly (readonly [number, number])[]; oreId: number }> = [
        { withdraw: [[COPPER_ORE, 12], [TIN_ORE, 12]], oreId: COPPER_ORE },
        { withdraw: [[IRON_ORE, 4]], oreId: IRON_ORE },
    ];
    for (const batch of batches) {
        if (level(s, 'Smithing') >= 20 && xp(s, 'Smithing') >= targetXp) break;
        await withdrawExactBatch(s, batch.withdraw);
        while (s.tick() - t0 < 200 && (level(s, 'Smithing') < 20 || xp(s, 'Smithing') < targetXp)) {
            const ore = inv(s).find(i => i.id === batch.oreId);
            if (!ore) break;
            const before = countId(s, batch.oreId);
            if (s.sdk.getState()?.dialog?.isOpen) {
                await s.direct({ type: 'closeModal', reason: 'SDK' });
            }
            await s.direct({ type: 'spellOnItem', slot: ore.slot, spellComponent: superheat, reason: 'SDK' });
            await waitTicks(s, 1);
            if (countId(s, batch.oreId) < before) {
                casts++;
                await waitTicks(s, 2);
            }
        }
    }
    const ticks = s.tick() - t0;
    const smithGained = xp(s, 'Smithing') - smithXp0;
    const magicGained = xp(s, 'Magic') - magicXp0;
    const smithLvl = level(s, 'Smithing');
    const magicLvl = level(s, 'Magic');
    if (smithLvl < 20 || smithGained < targetXp) {
        throw Error(`smith-20 incomplete: smithLvl=${smithLvl} smithXp=${smithGained} casts=${casts} ticks=${ticks}`);
    }
    return `mode=smith-20 ticks=${ticks} casts=${casts} smithLvl=${smithLvl} smithXp=${smithGained} magicLvl=${magicLvl} magicXp=${magicGained} smithPerTick=${(smithGained / Math.max(1, ticks)).toFixed(2)}`;
}

if (import.meta.main) {
    const bot = process.argv[2];
    const mode = process.argv[3] as PrepMode | undefined;
    if (!bot || !mode || !['fletch-10', 'magic-wind-1-7', 'magic-enchant-7-43', 'smith-20'].includes(mode)) {
        throw Error('usage: haggis-tt-prep.ts <bot> <fletch-10|magic-wind-1-7|magic-enchant-7-43|smith-20>');
    }
    const s = await openBot(bot, { onStop: async () => {}, onSessionEnd: async () => {} });
    try {
        await tick(s, 2);
        const detail = mode === 'fletch-10'
            ? await runFletch10(s)
            : mode === 'magic-wind-1-7'
                ? await runWind1To7(s)
                : mode === 'magic-enchant-7-43'
                    ? await runEnchant7To43(s)
                    : await runSmith20(s);
        await finish([s], true, detail);
    } catch (err) {
        await finish([s], false, err instanceof Error ? err.message : String(err));
    }
}
