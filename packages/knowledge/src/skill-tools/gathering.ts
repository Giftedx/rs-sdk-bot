import { cite, configBlocks, itemId, lines, wieldAttack } from './readers';
import type { AxeRow, PickaxeRow } from './types';

export const WC_SCRIPT = 'scripts/skill_woodcutting/scripts/woodcut.rs2';
const AXE_OBJ = 'scripts/skill_woodcutting/configs/axes/axes.obj';
const TREES = 'scripts/skill_woodcutting/configs/trees.dbrow';
export const PICK_CHECK = 'scripts/skill_mining/scripts/pickaxe_checker.rs2';
const PICK_OBJ = 'scripts/skill_mining/configs/pickaxes.obj';

/** Build woodcutting axe tier rows from `woodcut.rs2`, `axes.obj`, and `trees.dbrow`. */
export function buildAxes(gaps: string[]): AxeRow[] {
    const l = lines(WC_SCRIPT);
    const start = l.findIndex(x => /^\[proc,woodcutting_axe_checker\]/.test(x));
    const objs = configBlocks(AXE_OBJ);
    // Success chance per tree row and axe.
    const chance = new Map<string, Record<string, { low: number; high: number; src: string }>>();
    let row = '';
    lines(TREES).forEach((t, i) => {
        const h = /^\[([^\]]+)\]/.exec(t);
        if (h) { row = h[1]!; return; }
        const m = /^data=successchance,([a-z_]+),(\d+),(\d+)/.exec(t);
        if (!m) return;
        const rec = chance.get(m[1]!) ?? {};
        rec[row] = { low: Number(m[2]), high: Number(m[3]), src: `${TREES}:${i + 1}` };
        chance.set(m[1]!, rec);
    });
    const noLevel = cite(WC_SCRIPT, /no wc req in 2004/, /^\[proc,woodcutting_axe_checker\]/);
    const out: AxeRow[] = [];
    if (start < 0) { gaps.push(`woodcutting: [proc,woodcutting_axe_checker] not found in ${WC_SCRIPT}`); return out; }
    for (let i = start + 1; i < l.length && !/^\[/.test(l[i]!); i++) {
        if (/^\s*\/\//.test(l[i]!)) continue;
        const m = /^if \(\(\$obj1 = ([a-z_]+) \| inv_total\(inv, \1\) > 0\)\)/.exec(l[i]!);
        if (!m) continue;
        const item = m[1]!;
        const ob = objs.get(item);
        const w = wieldAttack(item);
        if (w.gap) gaps.push(`woodcutting: ${w.gap}`);
        const pl = ob?.params.levelrequire;
        out.push({
            item, id: itemId(item), rank: out.length + 1, hold: 'either', holdSrc: `${WC_SCRIPT}:${i + 1}`,
            woodcuttingLevel: null, woodcuttingLevelSrc: noLevel ? noLevel.src : `${WC_SCRIPT}:${i + 1}`,
            paramLevelrequire: pl ? Number(pl.value) : null, paramSrc: pl ? `${AXE_OBJ}:${pl.line}` : null,
            wieldAttack: w.level, wieldSrc: w.src, successChance: chance.get(item) ?? {},
        });
        if (!pl) gaps.push(`woodcutting: ${item} has no levelrequire param in ${AXE_OBJ}`);
        if (out.at(-1)!.id === null) gaps.push(`woodcutting: ${item} not in knowledge/items.json`);
    }
    return out;
}

/** Build mining pickaxe tier rows from `pickaxe_checker.rs2` and `pickaxes.obj`. */
export function buildPickaxes(gaps: string[]): PickaxeRow[] {
    const objs = configBlocks(PICK_OBJ);
    const out: PickaxeRow[] = [];
    lines(PICK_CHECK).forEach((t, i) => {
        const m = /^if \(\$lvl0 >= oc_param\(([a-z_]+), levelrequire\) & \(\$obj1 = \1 \| inv_total\(inv, \1\) > 0\)\)/.exec(t);
        if (!m) return;
        const item = m[1]!;
        const ob = objs.get(item);
        const lv = ob?.params.levelrequire;
        const rate = ob?.params.mining_rate;
        const w = wieldAttack(item);
        if (w.gap) gaps.push(`mining: ${w.gap}`);
        if (!lv) gaps.push(`mining: ${item} has no levelrequire param in ${PICK_OBJ}`);
        if (!rate) gaps.push(`mining: ${item} has no mining_rate param in ${PICK_OBJ}`);
        out.push({
            item, id: itemId(item), rank: out.length + 1, hold: 'either', holdSrc: `${PICK_CHECK}:${i + 1}`,
            miningLevel: lv ? Number(lv.value) : null, miningLevelSrc: lv ? `${PICK_OBJ}:${lv.line}` : null,
            wieldAttack: w.level, wieldSrc: w.src,
            miningRate: rate ? Number(rate.value) : null, miningRateSrc: rate ? `${PICK_OBJ}:${rate.line}` : null,
        });
    });
    if (!out.length) gaps.push(`mining: no pickaxe lines parsed from ${PICK_CHECK}`);
    return out;
}
