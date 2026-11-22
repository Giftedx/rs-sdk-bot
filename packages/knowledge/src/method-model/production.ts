import type { ConfigBlock } from '../config';
import { MODEL_FILES, find, findAll, param, struct } from './content';
import { WEAKQUEUE_SRC } from './rates';
import { doneFacts, facts, instantTiming, pDelayTiming, queueLoopTiming, rowCol, rowColSrc, rowItems, tenths, withRolls } from './timing';
import type { Content, Facts, ModelInput, Roll, Timing } from './types';

// Guide rungs that name the finished item while the craft makes another (symbols are strung and blessed later),
// or whose item name does not resolve: rung output or label -> the struct the craft script reads.
const STRUCT_ALIASES: Record<string, string> = { blessedstar: 'unstrung_symbol', blessedsnake: 'unstrung_emblem', 'Glass orb': 'stafforb' };

// The config struct a crafting rung uses: by product, then alias, then the struct named after the label, then by ingredient.
function structFor(c: Content, r: ModelInput, key: string): ConfigBlock | undefined {
    const out = r.outputs[0];
    const alias = (out && STRUCT_ALIASES[out]) ?? STRUCT_ALIASES[r.label];
    return (out ? struct(c, key, out) : undefined) ?? (alias ? c.struct(alias) : undefined)
        ?? c.struct(r.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')) ?? (r.inputs[0] ? struct(c, 'ingredient', r.inputs[0]) : undefined);
}

function structFacts(c: Content, r: ModelInput, key: string, xpKey: string, t: Timing | string, tools: string[], inputs?: { debugname: string; count: number }[], found?: ConfigBlock): Facts {
    const s = found ?? structFor(c, r, key);
    const xp = param(s, xpKey), ing = param(s, 'ingredient'), product = param(s, 'product');
    const out = facts({
        xpPerAction: xp ? tenths(xp.value) : null, xpSrc: xp?.src ?? null, tools,
        inputs: inputs ?? (ing ? [{ debugname: ing.value, count: 1 }] : null),
        outputs: product ? [{ debugname: product.value, count: 1 }] : null,
        gaps: xp ? [] : [`no struct with ${key}=${r.outputs[0] ?? '(unresolved "' + r.label + '")'} and ${xpKey}`],
    });
    if (typeof t === 'string') out.gaps.push(`ticks per action unknown: ${t}`); else out.timing = t;
    return out;
}

/** Model facts for production and processing rungs, or `null` for other kinds. */
export function productionFacts(c: Content, r: ModelInput, rowName: string): Facts | null {
    const row = r.row;
    switch (r.kind) {
    case 'cooking_generic': {
        const t = pDelayTiming(c, MODEL_FILES.cooking, 'cook_item', true, 'One item per use on the range or fire.');
        const range = rowCol(row, 'successchance_range'), fire = rowCol(row, 'successchance');
        const ch = range ?? fire;
        const xp = rowCol(row, 'experience')?.[0];
        if (!ch) return doneFacts({ xpPerAction: xp ? tenths(xp) : null, xpSrc: rowColSrc(row, 'experience') }, t);
        const always = ch[0] === '1' && ch[1] === '1';
        const roll: Roll = {
            tool: range ? 'range' : 'fire', toolLevel: 1, rollTicks: typeof t === 'string' ? 0 : t.ticksPerTry, failTicks: 0,
            low: always ? null : Number(ch[0]), high: always ? null : Number(ch[1]), fixedChance: always ? 1 : null,
            src: rowColSrc(row, range ? 'successchance_range' : 'successchance')!,
        };
        return doneFacts({ xpPerAction: xp ? tenths(xp) : null, xpSrc: rowColSrc(row, 'experience'), inputs: rowItems(row, 'uncooked', 1), outputs: rowItems(row, 'cooked', 1) },
            withRolls(t, [roll], `XP only when the food does not burn (stat_random on the ${roll.tool}).`));
    }
    case 'smithing': {
        const bar = rowCol(row, 'bar')?.[0], amount = Number(rowCol(row, 'bar_amount')?.[0] ?? 1), product = rowCol(row, 'product')?.[0], made = Number(rowCol(row, 'product_amount')?.[0] ?? 1);
        const s = bar ? struct(c, 'namedobj', bar) : undefined;
        const per = param(s, 'xpperbar');
        const t = pDelayTiming(c, MODEL_FILES.smithing, 'smithing_anvil', false, 'The make-X loop recurses after the last delay.');
        return doneFacts({
            xpPerAction: per ? tenths(per.value) * amount : null, xpSrc: per?.src ?? null, xpNote: per ? `bar_amount ${amount} x xpperbar ${tenths(per.value)}` : null,
            inputs: bar ? [{ debugname: bar, count: amount }] : null, outputs: product ? [{ debugname: product, count: made }] : null, tools: ['hammer'],
            gaps: per ? [] : [`xpperbar for ${bar} not found in any smithing struct`],
        }, t);
    }
    case 'fletching_table': {
        const product = rowCol(row, 'product'), xp = rowCol(row, 'experience')?.[0];
        const count = Number(product?.[1] ?? 1);
        const family = /_tips$/.test(rowName) ? { file: MODEL_FILES.bolts, block: 'make_bolt_tips', multiplied: false }
            : /_bolts$/.test(rowName) ? { file: MODEL_FILES.bolts, block: 'make_bolts', multiplied: true }
            : /_dart$/.test(rowName) ? { file: MODEL_FILES.darts, block: 'make_darts', multiplied: true }
            : /_arrow$/.test(rowName) ? { file: MODEL_FILES.arrows, block: 'make_arrows', multiplied: true }
            : /^stringing_/.test(rowName) ? { file: MODEL_FILES.bows, block: 'string_bow', multiplied: false } : null;
        if (!family || !xp) return doneFacts({}, `no fletching script mapped for ${rowName}`);
        const n = family.multiplied ? count : 1;
        return doneFacts({
            xpPerAction: tenths(xp) * n, xpSrc: rowColSrc(row, 'experience'), xpNote: family.multiplied ? `${count} items per action x ${tenths(xp)} XP` : null,
            inputs: rowItems(row, 'item', n), outputs: product ? [{ debugname: product[0]!, count }] : null,
        }, instantTiming(c, family.file, family.block));
    }
    case 'fletch_bow': {
        const t = queueLoopTiming(c, MODEL_FILES.cutLogs, /weakqueue\*\(fletch_logs, sub\(%action_delay, map_clock\)\)/);
        const delay = find(c, MODEL_FILES.cutLogs, /%action_delay = add\(map_clock, (\d+)\)/, 'process_fletch_logs');
        const timing: Timing | string = typeof t === 'string' || !delay ? (delay ? t : 'action_delay step not found in [label,process_fletch_logs]')
            : { ...t, ticksPerTry: Number(delay.m[1]) + 1, note: `make-X loop re-queues with delay ${delay.m[1]} (action_delay - map_clock): ${Number(delay.m[1]) + 1} ticks per item.`, src: [delay.src, ...t.src] };
        return doneFacts({}, timing);
    }
    case 'craft_leather_table': {
        const leather = rowCol(row, 'leather'), xp = rowCol(row, 'experience')?.[0] ?? rowCol(row, 'productexp')?.[0];
        const delay = find(c, MODEL_FILES.leather, /%action_delay = add\(map_clock, (\d+)\)/, 'process_leather_crafting');
        const t: Timing | string = delay
            ? { basis: 'queue-loop', ticksPerTry: Number(delay.m[1]) + 1, rolls: [], note: `make-X loop re-queues with delay ${delay.m[1]}: ${Number(delay.m[1]) + 1} ticks per item.`, src: [delay.src, WEAKQUEUE_SRC] }
            : `queue delay not found in ${MODEL_FILES.leather}`;
        return doneFacts({ inputs: leather ? [{ debugname: leather[0]!, count: Number(leather[1] ?? 1) }] : null, outputs: rowItems(row, 'product', 1), tools: ['needle', 'thread'], xpSrc: xp ? rowColSrc(row, 'productexp') : null }, t);
    }
    case 'gem_cutting_table': {
        const t = instantTiming(c, MODEL_FILES.gem, 'crafting_gem');
        const ch = rowCol(row, 'success_rate');
        const rolls: Roll[] = ch && typeof t !== 'string' ? [{ tool: 'chisel', toolLevel: 1, rollTicks: t.ticksPerTry, failTicks: 0, low: Number(ch[0]), high: Number(ch[1]), fixedChance: null, src: rowColSrc(row, 'success_rate')! }] : [];
        return doneFacts({ inputs: rowItems(row, 'uncut_gem', 1), outputs: rowItems(row, 'cut_gem', 1), tools: ['chisel'] },
            rolls.length ? withRolls(t, rolls, 'A failed cut crushes the gem and gives (XP + 2) / 4 tenths; the model counts only full cuts.') : t);
    }
    case 'runecraft_table': {
        const t = pDelayTiming(c, MODEL_FILES.runecraft, 'runecraft_runes', true, 'One action crafts every essence held; 27 essence assumed (rcair measured 27 per trip).');
        const xp = rowCol(row, 'experience')?.[0];
        return doneFacts({ xpPerAction: xp ? tenths(xp) * 27 : null, xpSrc: rowColSrc(row, 'experience'), xpNote: xp ? `27 essence x ${tenths(xp)} XP` : null, inputs: [{ debugname: 'blankrune', count: 27 }], outputs: rowItems(row, 'rune', 27) }, t);
    }
    case 'burn': {
        const log = r.inputs[0];
        const xp = log ? param(c.obj(log), 'productexp') : null;
        const roll = find(c, MODEL_FILES.firemaking, /stat_random\(firemaking, (\d+), (\d+)\)/, 'light_logs_inv');
        const next = roll ? findAll(c, MODEL_FILES.firemaking, /%action_delay = calc\(map_clock \+ (\d+)\)/, 'light_logs_inv').find(h => h.line > roll.line) ?? null : null;
        const t: Timing | string = roll && next ? {
            basis: 'roll', ticksPerTry: Number(next.m[1]), note: `a light roll every ${next.m[1]} ticks; after a light the next log waits the same ${next.m[1]} ticks.`, src: [roll.src, next.src],
            rolls: [{ tool: 'tinderbox', toolLevel: 1, rollTicks: Number(next.m[1]), failTicks: 0, low: Number(roll.m[1]), high: Number(roll.m[2]), fixedChance: null, src: roll.src }],
        } : `firemaking roll not found in [label,light_logs_inv] of ${MODEL_FILES.firemaking}`;
        return doneFacts({ xpPerAction: xp ? tenths(xp.value) : null, xpSrc: xp?.src ?? null, inputs: log ? [{ debugname: log, count: 1 }] : null, tools: ['tinderbox'], gaps: xp ? [] : [`productexp param missing on log obj ${log}`] }, t);
    }
    case 'smelt': {
        const bar = r.outputs[0];
        const s = bar ? struct(c, 'product', bar) : undefined;
        const xp = param(s, 'productexp');
        const q = find(c, MODEL_FILES.smelting, /weakqueue\*\(smelting_ore, (\d+)\)/, 'start_smelt_ore');
        const startQ = find(c, MODEL_FILES.smelting, /weakqueue\*\(start_smelt_ore, calc\(%action_delay - map_clock - 1\)\)/);
        const ad = find(c, MODEL_FILES.smelting, /%action_delay = add\(map_clock, (\d+)\)/, 'smelting_ore');
        let t: Timing | string = 'smelting loop delays not found in ' + MODEL_FILES.smelting;
        if (q && startQ && ad) {
            const first = Number(ad.m[1]) - 1 + 1, second = Number(q.m[1]) + 1;
            t = { basis: 'queue-loop', ticksPerTry: first + second, rolls: [], note: `each bar: start_smelt_ore after ${first} tick, then smelting_ore after ${second}: ${first + second} ticks per bar.`, src: [ad.src, startQ.src, q.src, WEAKQUEUE_SRC] };
            if (bar === 'iron_bar') {
                const fail = find(c, MODEL_FILES.smelting, /randominc\(1\) = 1/, 'smelting_ore');
                if (fail) t = withRolls(t, [{ tool: null, toolLevel: 1, rollTicks: first + second, failTicks: 0, low: null, high: null, fixedChance: 0.5, src: fail.src }], 'Iron fails half the time without a ring of forging.');
            }
        }
        const ins: { debugname: string; count: number }[] = [];
        const ing = param(s, 'ingredient'), ingN = param(s, 'bar_count'), sec = param(s, 'ingredient_secondary'), secN = param(s, 'ingredient_secondary_count');
        if (ing) ins.push({ debugname: ing.value, count: Number(ingN?.value ?? 1) });
        if (sec) ins.push({ debugname: sec.value, count: Number(secN?.value ?? 1) });
        return doneFacts({ xpPerAction: xp ? tenths(xp.value) : null, xpSrc: xp?.src ?? null, inputs: ins.length ? ins : null, gaps: xp ? [] : [`no smelting struct with product ${bar}`] }, t);
    }
    case 'spin': return structFacts(c, r, 'product', 'productexp', queueLoopTiming(c, MODEL_FILES.spinning, /weakqueue\*\(crafting_spinning, (\d+)\)\(\$spinning_obj/), []);
    case 'glass': {
        const delay = find(c, MODEL_FILES.glass, /%action_delay = add\(map_clock, (\d+)\)/, 'process_glassblowing');
        const t: Timing | string = delay
            ? { basis: 'queue-loop', ticksPerTry: Number(delay.m[1]) + 1, rolls: [], note: `make-X loop re-queues with delay ${delay.m[1]}: ${Number(delay.m[1]) + 1} ticks per item.`, src: [delay.src, WEAKQUEUE_SRC] }
            : `queue delay not found in ${MODEL_FILES.glass}`;
        return structFacts(c, r, 'product', 'productexp', t, ['glassblowingpipe'], [{ debugname: 'molten_glass', count: 1 }]);
    }
    case 'pottery': {
        const wheel = find(c, MODEL_FILES.pottery, /%action_delay = add\(map_clock, (\d+)\)/, 'process_craft_pottery');
        const oven = find(c, MODEL_FILES.pottery, /%action_delay = add\(map_clock, (\d+)\)/, 'process_fire_pottery');
        const roll = find(c, MODEL_FILES.pottery, /stat_random\(crafting, (\d+), (\d+)\)/, 'fire_pottery');
        const s = structFor(c, r, 'product');
        const a = param(s, 'processexp'), b = param(s, 'productexp');
        if (!wheel || !oven || !roll || !a || !b) return doneFacts({}, `pottery wheel or oven timing, or struct for ${r.outputs[0]}, not found`);
        const ticks = Number(wheel.m[1]) + 1 + Number(oven.m[1]) + 1 + 1;
        return doneFacts({ xpPerAction: tenths(a.value) + tenths(b.value), xpSrc: a.src, xpNote: `wheel ${tenths(a.value)} (${a.src}) + oven ${tenths(b.value)} (${b.src})`, inputs: [{ debugname: 'softclay', count: 1 }] },
            {
                basis: 'roll', ticksPerTry: ticks, note: `wheel ${Number(wheel.m[1]) + 1} ticks + oven ${Number(oven.m[1]) + 1} + 1 ticks per item. The oven fire can fail; the model counts both XP parts only on a fired item.`,
                src: [wheel.src, oven.src, WEAKQUEUE_SRC],
                rolls: [{ tool: null, toolLevel: 1, rollTicks: ticks, failTicks: 0, low: Number(roll.m[1]), high: Number(roll.m[2]), fixedChance: null, src: roll.src }],
            });
    }
    case 'jewellery': {
        const s = structFor(c, r, 'product');
        const silver = !!param(s, 'mould'); // silver items name their mould; gold ones use the furnace interface moulds
        const t = silver ? queueLoopTiming(c, MODEL_FILES.jewellery, /weakqueue\*\(craft_silver, (\d+)\)/, 'Silver items.')
            : pDelayTiming(c, MODEL_FILES.jewellery, 'crafting_gold', false, 'The make-X loop recurses after the delay.');
        const gem = param(s, 'gem');
        const ins = [{ debugname: silver ? 'silver_bar' : 'gold_bar', count: 1 }, ...(gem ? [{ debugname: gem.value, count: 1 }] : [])];
        return structFacts(c, r, 'product', 'productexp', t, silver ? [param(s, 'mould')!.value] : [], ins, s);
    }
    case 'staff': {
        const s = structFor(c, r, 'product');
        const orb = param(s, 'ingredient');
        return structFacts(c, r, 'product', 'productexp', instantTiming(c, MODEL_FILES.staves, 'craft_staff'), [], [{ debugname: 'battlestaff', count: 1 }, ...(orb ? [{ debugname: orb.value, count: 1 }] : [])]);
    }
    case 'wine': {
        const xp = find(c, MODEL_FILES.wine, /stat_advance\(cooking, calc\((\d+) \* \$wines_per_batch\)\)/, 'fermenting_wine');
        const t = instantTiming(c, MODEL_FILES.wine, 'make_wine', 'The XP arrives later from the fermenting timer, which also starts at every login.');
        return doneFacts({ xpPerAction: xp ? tenths(xp.m[1]!) : null, xpSrc: xp?.src ?? null, inputs: [{ debugname: 'grapes', count: 1 }, { debugname: 'jug_water', count: 1 }], outputs: [{ debugname: 'jug_unfermented_wine', count: 1 }] },
            typeof t === 'string' ? t : { ...t, basis: 'timer' });
    }
    case 'identify': {
        const herb = r.outputs[0];
        const xp = herb ? param(c.obj(herb), 'identified_herb_exp') : null;
        // The grimy herb is the opheld1 trigger whose body identifies this herb.
        const call = herb ? find(c, MODEL_FILES.identify, new RegExp(`~attempt_identify_herb\\(${herb},`)) : null;
        const ls = c.lines(MODEL_FILES.identify);
        const grimy = call && ls ? /^\[opheld1,([a-z_0-9]+)\]/.exec(ls[call.line - 2] ?? '')?.[1] : undefined;
        return doneFacts({ xpPerAction: xp ? tenths(xp.value) : null, xpSrc: xp?.src ?? null, inputs: grimy ? [{ debugname: grimy, count: 1 }] : null, gaps: xp ? [] : [`identified_herb_exp missing on ${herb}`] },
            instantTiming(c, MODEL_FILES.identify, 'attempt_identify_herb'));
    }
    case 'potion': {
        // Match by recipe: the unfinished potion of the rung herb, plus the rung secondary. The guide names the 4-dose item.
        const [herb, secondary] = r.inputs;
        const unf = herb ? c.structs().find(x => param(x, 'brew_potion_ingredient')?.value === herb && param(x, 'brew_potion_solvent')?.value === 'vial_water') : undefined;
        const unfMix = param(unf, 'brew_potion_mixture')?.value;
        const byRecipe = unfMix ? c.structs().filter(x => param(x, 'brew_potion_solvent')?.value === unfMix && (!secondary || param(x, 'brew_potion_ingredient')?.value === secondary)) : [];
        const s = (r.outputs[0] ? struct(c, 'brew_potion_mixture', r.outputs[0]) : undefined) ?? (byRecipe.length === 1 ? byRecipe[0] : undefined);
        const xp = param(s, 'brew_potion_exp'), lvl = param(s, 'brew_potion_level');
        const ing = param(s, 'brew_potion_ingredient'), sol = param(s, 'brew_potion_solvent'), mix = param(s, 'brew_potion_mixture');
        return doneFacts({
            xpPerAction: xp ? tenths(xp.value) : null, xpSrc: xp?.src ?? null, level: lvl ? Number(lvl.value) : null, levelSrc: lvl?.src ?? null,
            inputs: ing && sol ? [{ debugname: sol.value, count: 1 }, { debugname: ing.value, count: 1 }] : null,
            outputs: mix ? [{ debugname: mix.value, count: 1 }] : null,
            gaps: xp ? [] : [`no brew_potion struct for ${r.outputs[0] ?? r.label}: ${byRecipe.length} recipes match unfinished ${unfMix ?? '(herb ' + herb + ' has no unfinished potion)'} + ${secondary ?? 'an unresolved secondary'}`],
        }, instantTiming(c, MODEL_FILES.brew, 'attempt_brew_potion'));
    }
    case 'bury': {
        const bone = r.inputs[0];
        const xp = bone ? param(c.obj(bone), 'bone_exp') : null;
        return doneFacts({ xpPerAction: xp ? tenths(xp.value) : null, xpSrc: xp?.src ?? null, gaps: xp ? [] : [`bone_exp param missing on ${bone}`] },
            pDelayTiming(c, MODEL_FILES.bury, 'bury_bones', true, ''));
    }
    default: return null;
    }
}
