import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { knowledgeDir } from '../src/paths';
import { loadContent, modelRung, modelXpPerTickAt, pDelayTicks, statRandomChance, ticksPerSuccess, type Row } from '../src/method-model';

const c = loadContent();
const dbtables = JSON.parse(readFileSync(join(knowledgeDir(), 'dbtables.json'), 'utf8')) as { table: string; rows: (Row & { def: string })[] }[];
const row = (t: string, r: string) => dbtables.find(x => x.table === t)?.rows.find(x => x.name === r);
const rung = (o: { id: string; skill: string; kind: string; level: number; label?: string; row?: Row | null; outputs?: string[]; inputs?: string[]; npc?: string }) =>
    modelRung(c, { label: '', row: null, outputs: [], inputs: [], ...o });

test('stat_random chance follows the engine formula', () => {
    // PlayerOps.ts STAT_RANDOM: floor(low*(99-L)/98) + floor(high*(L-1)/98) + 1, out of 256.
    expect(statRandomChance(1, 64, 200)).toBe(65 / 256);
    expect(statRandomChance(99, 64, 200)).toBe(201 / 256);
    expect(statRandomChance(50, 256, 256)).toBe(1);
});

test('p_delay ticks: n + 1 per delay, plus one refused decode before a new action', () => {
    expect(pDelayTicks([0], true)).toBe(2); // bury
    expect(pDelayTicks([1, 2], false)).toBe(5); // smithing make-X loop
    expect(pDelayTicks([3], true)).toBe(5); // runecraft
});

test('gathering: oak tree rolls every 4 ticks with axe chances from trees.dbrow', () => {
    const f = rung({ id: 'woodcutting/oak_tree_table', skill: 'woodcutting', kind: 'woodcutting_trees', level: 15, row: row('woodcutting_trees', 'oak_tree_table')! });
    expect(f.gaps).toEqual([]);
    expect(f.timing!.basis).toBe('roll');
    expect(f.timing!.src[0]).toMatch(/^scripts\/skill_woodcutting\/scripts\/woodcut\.rs2:\d+$/);
    const bronze = f.timing!.rolls.find(r => r.tool === 'bronze_axe')!;
    expect(bronze).toMatchObject({ rollTicks: 4, low: 32, high: 100 });
    expect(bronze.src).toMatch(/trees\.dbrow:\d+$/);
    expect(f.timing!.rolls.find(r => r.tool === 'rune_axe')!.toolLevel).toBe(41);
    // Rune axe at 99 is the best roll.
    const rune = f.timing!.rolls.find(r => r.tool === 'rune_axe')!;
    expect(ticksPerSuccess(f.timing!, 99)).toBeCloseTo(4 / statRandomChance(99, rune.low!, rune.high!), 6);
});

test('gathering: fly fishing trout rolls every 5 ticks; XP and chance come from fishing.struct', () => {
    const f = rung({ id: 'fishing/catch-trout', skill: 'fishing', kind: 'catch', level: 20, outputs: ['raw_trout'] });
    expect(f.xpPerAction).toBe(50);
    expect(f.xpSrc).toMatch(/^scripts\/skill_fishing\/configs\/fishing\.struct:\d+$/);
    expect(f.timing!.ticksPerTry).toBe(5);
    expect(f.tools).toEqual(['fly_fishing_rod']);
    expect(f.inputs).toEqual([{ debugname: 'feather', count: 1 }]);
});

test('production: smithing a bronze platebody is 5 bars x 12.5 XP in a 5-tick loop', () => {
    const f = rung({ id: 'smithing/bronze_platebody', skill: 'smithing', kind: 'smithing', level: 18, row: row('smithing', 'bronze_platebody')! });
    expect(f.xpPerAction).toBe(62.5);
    expect(f.xpSrc).toMatch(/smithing\.struct:\d+$/);
    expect(f.inputs).toEqual([{ debugname: 'bronze_bar', count: 5 }]);
    expect(f.timing!.ticksPerTry).toBe(5);
    expect(f.timing!.src.slice(0, 2).every(s => /smithing\/smithing\.rs2:\d+$/.test(s))).toBe(true);
    expect(modelXpPerTickAt(f.xpPerAction, f.timing, 18)).toBe(312.5);
});

test('production: rune arrows make 15 per action with no delay, 5 actions per tick', () => {
    const f = rung({ id: 'fletching/fletching_rune_arrow', skill: 'fletching', kind: 'fletching_table', level: 75, row: row('fletching_table', 'fletching_rune_arrow')! });
    expect(f.xpPerAction).toBe(187.5);
    expect(f.timing!.basis).toBe('instant');
    expect(f.timing!.ticksPerTry).toBe(0.2);
    expect(f.outputs).toEqual([{ debugname: 'rune_arrow', count: 15 }]);
});

test('combat target: a cow is 8 hitpoints, so 32 Attack XP and 10.6 Hitpoints XP per kill', () => {
    const atk = rung({ id: 'attack/target-cow', skill: 'attack', kind: 'target', level: 1, npc: 'cow' });
    const hp = rung({ id: 'hitpoints/target-cow', skill: 'hitpoints', kind: 'target', level: 1, npc: 'cow' });
    expect(atk.xpPerAction).toBe(32);
    expect(hp.xpPerAction).toBe(10.6);
    expect(atk.xpSrc).toMatch(/\.npc:\d+$/);
    expect(atk.xpNote).toMatch(/combat\.rs2:\d+/);
    expect(atk.timing).toBeNull();
    expect(atk.gaps[0]).toMatch(/^ticks per kill unknown/);
});

test('every ladder value with a model carries content source lines', () => {
    const out = JSON.parse(readFileSync(join(knowledgeDir(), 'ladders.json'), 'utf8')) as { ladders: Record<string, { id: string; xpPerAction: number | null; xpSrc: string | null; kind: string; ticksPerAction: number | null; timing: { src: string[] } | null; modelXpPerTick: number | null; xpPerTick: number | null; rateMethod: string | null }[]> };
    for (const m of Object.values(out.ladders).flat()) {
        if (m.xpPerAction !== null) expect(m.xpSrc ?? '').toMatch(/:\d+$/);
        if (m.ticksPerAction !== null) for (const s of m.timing!.src) expect(s).toMatch(/:\d+$/);
        if (m.modelXpPerTick !== null) expect(m.ticksPerAction).not.toBeNull();
        if (m.rateMethod === null) expect(m.xpPerTick).toBeNull(); // the model never fills the measured rate
    }
});
