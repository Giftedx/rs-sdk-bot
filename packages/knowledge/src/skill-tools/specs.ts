import { PICK_CHECK, WC_SCRIPT } from './gathering';
import { applies, cite, emptyRecord, itemId, lines } from './readers';
import type { Cite, Hold, ItemNeed, Rung, ToolRecord } from './types';

// `block`: the names may be anywhere in the block that starts at the cited line.
interface SpecAnchor { file: string; re: RegExp; after?: RegExp; block?: boolean }
export interface Spec {
    id: string; skill: string; kinds: string[]; idPattern?: RegExp; note?: string;
    level?: SpecAnchor & { value: number };
    items?: { anyOf: string[]; hold: Hold; role: ItemNeed['role']; at: SpecAnchor; note?: string }[];
    consumed?: { items: string[]; perAction: number | null; at: SpecAnchor; note?: string }[];
    locs?: { anyOf: string[]; at: SpecAnchor }[];
    conditions?: SpecAnchor[];
    // The line that sends the item used on the loc to this method.
    dispatch?: SpecAnchor;
    gaps?: string[];
}

export const S = 'scripts/';
const SMITH = `${S}skill_smithing/scripts/smithing/smithing.rs2`;
const SMELT = `${S}skill_smithing/scripts/smelting/smelting.rs2`;
const CANNON = `${S}skill_smithing/scripts/smelting/cannonballs.rs2`;
const GEM = `${S}skill_crafting/scripts/gem/uncut_gem.rs2`;
const LEATHER = `${S}skill_crafting/scripts/leather/leather.rs2`;
const GLASS = `${S}skill_crafting/scripts/glass/glass.rs2`;
const JEWEL = `${S}skill_crafting/scripts/jewellery/jewellery.rs2`;
const JEWEL_STRUCT = `${S}skill_crafting/configs/jewellery/jewellery.struct`;
const POTTERY = `${S}skill_crafting/scripts/pottery/pottery.rs2`;
const SPIN = `${S}skill_crafting/scripts/spinning/spinning.rs2`;
const STAFF = `${S}skill_crafting/scripts/battlestaves/battlestaves.rs2`;
const CUTLOG = `${S}skill_fletching/scripts/cut_logs.rs2`;
const BOLTS = `${S}skill_fletching/scripts/bolts.rs2`;
const ARROWS = `${S}skill_fletching/scripts/arrows.rs2`;
const DARTS = `${S}skill_fletching/scripts/darts.rs2`;
const BOWS = `${S}skill_fletching/scripts/bows.rs2`;
const FM = `${S}skill_firemaking/scripts/firemaking.rs2`;
const BREW = `${S}skill_herblore/scripts/brewing/brew_potion.rs2`;
export const GRIND = `${S}skill_herblore/scripts/grinding/grind_ingredient.rs2`;
export const GRINDABLES = `${S}skill_herblore/configs/grinding/grindables.obj`;
const IDENT = `${S}skill_herblore/scripts/identifying/identify.rs2`;
const COOK = `${S}skill_cooking/scripts/cooking.rs2`;
const WINE = `${S}skill_cooking/scripts/cooking_inv/scripts/wine/wine.rs2`;
const RC = `${S}skill_runecraft/scripts/runecraft.rs2`;
export const CHEST = `${S}skill_thieving/scripts/chest/trapped_chest.rs2`;
const GUILD = `${S}skill_fishing/scripts/fishing_guild.rs2`;
const MINING = `${S}skill_mining/scripts/mining.rs2`;
export const MEMBERS = /map_members = \^false/;

/** Anchored skill-tool specifications verified against content scripts. */
export const SPECS: Spec[] = [
    {
        id: 'woodcutting/axe', skill: 'woodcutting', kinds: ['woodcutting_trees'],
        note: 'any axe in the axes table; the best one held or worn is used; no Woodcutting level gates the axe',
        items: [{ anyOf: ['bronze_axe', 'iron_axe', 'steel_axe', 'black_axe', 'mithril_axe', 'adamant_axe', 'rune_axe'], hold: 'either', role: 'tool', at: { file: WC_SCRIPT, re: /case bronze_axe, iron_axe, steel_axe, black_axe, mithril_axe, adamant_axe, rune_axe :/ } }],
    },
    {
        id: 'mining/pickaxe', skill: 'mining', kinds: ['mining_table'],
        note: 'any pickaxe in the pickaxes table whose levelrequire is at or below Mining; the best one held or worn is used',
        items: [{ anyOf: ['bronze_pickaxe', 'iron_pickaxe', 'steel_pickaxe', 'mithril_pickaxe', 'adamant_pickaxe', 'rune_pickaxe'], hold: 'either', role: 'tool', at: { file: PICK_CHECK, re: /^\[proc,pickaxe_checker\]/, block: true } }],
        conditions: [{ file: MINING, re: /def_obj \$pickaxe = ~pickaxe_checker;/ }],
    },
    {
        id: 'smithing/anvil', skill: 'smithing', kinds: ['smithing'],
        items: [{ anyOf: ['hammer'], hold: 'held', role: 'tool', at: { file: SMITH, re: /if \(inv_total\(inv, hammer\) < 1\)/, after: /^\[label,smithing_anvil_interface\]/ } }],
        consumed: [{ items: [], perAction: null, at: { file: SMITH, re: /%smithbars = inv_total\(inv, struct_param\(\$struct, namedobj\)\);/ }, note: 'bars per the ladder rung inputs' }],
        locs: [{ anyOf: ['_anvil'], at: { file: SMITH, re: /^\[oplocu,_anvil\]/ } }],
        conditions: [{ file: SMITH, re: /if\(loc_type = doric_anvil\)/ }, { file: SMITH, re: /if\(%viking < \^viking_complete\)/ }],
    },
    {
        id: 'smithing/furnace', skill: 'smithing', kinds: ['smelt'],
        items: [
            { anyOf: ['ring_of_forging'], hold: 'worn', role: 'bonus', at: { file: SMELT, re: /inv_total\(worn, ring_of_forging\) > 0 & map_members = \^true/ }, note: 'iron bar: no 50% impure fail while worn (members world)' },
            { anyOf: ['gauntlets_of_goldsmithing'], hold: 'worn', role: 'bonus', at: { file: SMELT, re: /\$product = gold_bar & inv_total\(worn, gauntlets_of_goldsmithing\) > 0/ }, note: 'gold bar XP x2.5 while worn' },
        ],
        consumed: [{ items: [], perAction: null, at: { file: SMELT, re: /inv_del\(inv, struct_param\(\$struct, ingredient\), struct_param\(\$struct, bar_count\)\);/ }, note: 'ores per the ladder rung inputs' }],
        locs: [{ anyOf: ['_smithing_furnace'], at: { file: SMELT, re: /^\[oplocu,_smithing_furnace\]/ } }],
        conditions: [{ file: SMELT, re: /if\(loc_type = viking_furnace \| loc_type = viking_furnace2\)/ }, { file: SMELT, re: /if \(\$product = iron_bar\)/ }],
    },
    {
        id: 'smithing/cannonball', skill: 'smithing', kinds: [], idPattern: /cannonball/,
        level: { file: CANNON, re: /if \(stat\(smithing\) < 35\)/, value: 35 },
        items: [{ anyOf: ['ammo_mould'], hold: 'held', role: 'tool', at: { file: CANNON, re: /if \(inv_total\(inv, ammo_mould\) < 1\)/ } }],
        consumed: [{ items: ['steel_bar'], perAction: 1, at: { file: CANNON, re: /if \(inv_total\(inv, steel_bar\) < 1\)/ } }],
        locs: [{ anyOf: ['_smithing_furnace'], at: { file: SMELT, re: /^\[oplocu,_smithing_furnace\]/ } }],
        dispatch: { file: SMELT, re: /case steel_bar : @smelt_cannonballs;/ },
        conditions: [{ file: CANNON, re: MEMBERS }],
    },
    {
        id: 'crafting/gem-cutting', skill: 'crafting', kinds: ['gem_cutting_table'],
        items: [{ anyOf: ['chisel'], hold: 'held', role: 'tool', at: { file: GEM, re: /^\[opheldu,chisel\]/, block: true } }],
        consumed: [{ items: [], perAction: 1, at: { file: GEM, re: /db_find\(gem_cutting_table:uncut_gem, \$uncut_gem\);/ }, note: 'one uncut gem per the ladder rung inputs' }],
        conditions: [{ file: GEM, re: /if \(oc_members\(\$uncut_gem\) = true\)/ }],
    },
    {
        id: 'crafting/leather', skill: 'crafting', kinds: ['craft_leather_table'],
        items: [
            { anyOf: ['needle'], hold: 'held', role: 'tool', at: { file: LEATHER, re: /^\[opheldu,needle\]/ } },
            { anyOf: ['thread'], hold: 'held', role: 'bait', at: { file: LEATHER, re: /if \(inv_total\(inv, thread\) < 1\)/ } },
        ],
        consumed: [{ items: ['thread'], perAction: 0.2, at: { file: LEATHER, re: /if \(%thread_used > 4\)/, block: true }, note: 'one thread per 5 items made' }],
    },
    {
        id: 'crafting/glassblowing', skill: 'crafting', kinds: ['glass'],
        items: [{ anyOf: ['glassblowingpipe'], hold: 'held', role: 'tool', at: { file: GLASS, re: /^\[opheldu,glassblowingpipe\]/ } }],
        consumed: [{ items: ['molten_glass'], perAction: 1, at: { file: GLASS, re: /inv_del\(inv, molten_glass, 1\);/ } }],
    },
    {
        id: 'crafting/molten-glass', skill: 'crafting', kinds: [], note: 'supply step for glassblowing; no ladder rung',
        consumed: [
            { items: ['bucket_sand'], perAction: 1, at: { file: GLASS, re: /inv_del\(inv, bucket_sand, 1\);/ } },
            { items: ['soda_ash'], perAction: 1, at: { file: GLASS, re: /inv_del\(inv, soda_ash, 1\);/ } },
        ],
        locs: [{ anyOf: ['_smithing_furnace'], at: { file: SMELT, re: /^\[oplocu,_smithing_furnace\]/ } }],
        dispatch: { file: SMELT, re: /case bucket_sand, soda_ash : @smelt_glass;/ },
    },
    ...(['ring', 'necklace', 'amulet'] as const).map((k): Spec => ({
        id: `crafting/jewellery-gold-${k}`, skill: 'crafting', kinds: ['jewellery'], idPattern: new RegExp(`^crafting/jewellery-[a-z]+-${k}$`),
        items: [{ anyOf: [`${k}_mould`], hold: 'held', role: 'tool', at: { file: JEWEL, re: new RegExp(`if \\(inv_total\\(inv, ${k}_mould\\) > 0\\)`) } }],
        consumed: [
            { items: ['gold_bar'], perAction: 1, at: { file: SMELT, re: /case gold_bar, perfect_gold_bar : @craft_gold_interface;/ }, note: `one bar per item (${JEWEL} "inv_del(inv, $bar, 1)"); perfect_gold_bar is used first when held` },
            { items: [], perAction: 1, at: { file: JEWEL, re: /inv_del\(inv, \$gem, 1\);/ }, note: 'the gem named by the rung, if any' },
        ],
        locs: [{ anyOf: ['_smithing_furnace'], at: { file: SMELT, re: /^\[oplocu,_smithing_furnace\]/ } }],
        dispatch: { file: SMELT, re: /case gold_bar, perfect_gold_bar : @craft_gold_interface;/ },
    })),
    ...([['holy-symbol', 'holy_symbol_mould'], ['unholy-symbol', 'unholy_symbol_mould']] as const).map(([k, mould]): Spec => ({
        id: `crafting/jewellery-${k}`, skill: 'crafting', kinds: ['jewellery'], idPattern: new RegExp(`^crafting/jewellery-${k}$`),
        items: [{ anyOf: [mould], hold: 'held', role: 'tool', at: { file: JEWEL_STRUCT, re: new RegExp(`^param=mould,${mould}$`) }, note: `checked at ${JEWEL} "inv_total(inv, $mould) = 0"` }],
        consumed: [{ items: ['silver_bar'], perAction: 1, at: { file: JEWEL, re: /inv_del\(inv, silver_bar, 1\);/ } }],
        locs: [{ anyOf: ['_smithing_furnace'], at: { file: SMELT, re: /^\[oplocu,_smithing_furnace\]/ } }],
        dispatch: { file: SMELT, re: /case silver_bar : @craft_silver;/ },
    })),
    {
        id: 'crafting/pottery', skill: 'crafting', kinds: ['pottery'],
        consumed: [{ items: ['softclay'], perAction: 1, at: { file: POTTERY, re: /case softclay : @craft_pottery_interface;/ }, note: 'softclay = clay + a water container' }],
        locs: [
            { anyOf: ['_potters_wheel'], at: { file: POTTERY, re: /^\[oplocu,_potters_wheel\]/ } },
            { anyOf: ['_pottery_oven'], at: { file: POTTERY, re: /^\[oplocu,_pottery_oven\]/ } },
        ],
        conditions: [{ file: POTTERY, re: /case bowl_water, bucket_water, jug_water : @make_softclay/ }],
    },
    {
        id: 'crafting/spinning', skill: 'crafting', kinds: ['spin'],
        consumed: [{ items: ['wool'], perAction: 1, at: { file: SPIN, re: /case wool : @craft_spinning/ }, note: 'or flax, per the rung' }],
        locs: [{ anyOf: ['_spinning_wheel'], at: { file: SPIN, re: /^\[oplocu,_spinning_wheel\]/ } }],
        conditions: [{ file: SPIN, re: MEMBERS, after: /case flax :/ }],
    },
    {
        id: 'crafting/battlestaff', skill: 'crafting', kinds: ['staff'], note: 'no tool',
        consumed: [
            { items: ['battlestaff'], perAction: 1, at: { file: STAFF, re: /^\[opheldu,battlestaff\]/ } },
            { items: [], perAction: 1, at: { file: STAFF, re: /case air_orb, fire_orb, water_orb, earth_orb : @craft_staff/ }, note: 'the rung orb: air_orb, fire_orb, water_orb or earth_orb' },
        ],
        conditions: [{ file: STAFF, re: MEMBERS }],
    },
    {
        id: 'fletching/cut-logs', skill: 'fletching', kinds: [], note: 'knife on logs; knowledge/ladders.json holds no log-cutting rung',
        items: [{ anyOf: ['knife'], hold: 'held', role: 'tool', at: { file: CUTLOG, re: /case knife : @fletch_log\(last_item\);/ } }],
        conditions: [{ file: CUTLOG, re: MEMBERS, after: /^\[label,fletch_log\]/ }],
    },
    {
        id: 'fletching/bolt-tips', skill: 'fletching', kinds: ['fletching_table'], idPattern: /_tips$/,
        items: [{ anyOf: ['chisel'], hold: 'held', role: 'tool', at: { file: GEM, re: /^\[opheldu,chisel\]/, block: true }, note: 'chisel on opal or oyster pearls calls make_bolt_tips' }],
        consumed: [{ items: [], perAction: 1, at: { file: BOLTS, re: /inv_del\(inv, \$item, 1\);/, after: /^\[label,make_bolt_tips\]/ }, note: 'one gem or pearl per the rung input' }],
        conditions: [{ file: BOLTS, re: MEMBERS, after: /^\[label,make_bolt_tips\]/ }],
    },
    {
        id: 'fletching/arrows', skill: 'fletching', kinds: ['fletching_table'], idPattern: /_arrow$/, note: 'no tool',
        consumed: [
            { items: ['headless_arrow'], perAction: 1, at: { file: ARROWS, re: /inv_del\(inv, headless_arrow, \$arrows_count\);/ }, note: 'plus one arrowtip per the rung' },
            { items: ['feather'], perAction: 1, at: { file: ARROWS, re: /inv_del\(inv, feather, \$arrow_count\);/ }, note: 'headless arrow step' },
            { items: ['arrow_shaft'], perAction: 1, at: { file: ARROWS, re: /inv_del\(inv, arrow_shaft, \$arrow_count\);/ }, note: 'headless arrow step' },
        ],
        conditions: [{ file: ARROWS, re: MEMBERS }],
    },
    {
        id: 'fletching/darts', skill: 'fletching', kinds: ['fletching_table'], idPattern: /_dart$/, note: 'no tool',
        consumed: [{ items: ['feather'], perAction: 1, at: { file: DARTS, re: /inv_del\(inv, feather, \$darts_count\);/ }, note: 'plus one dart tip per the rung' }],
        conditions: [{ file: DARTS, re: MEMBERS }],
    },
    {
        id: 'fletching/bolts', skill: 'fletching', kinds: ['fletching_table'], idPattern: /_bolts$/, note: 'no tool',
        consumed: [{ items: ['bolt'], perAction: 1, at: { file: BOLTS, re: /inv_del\(inv, bolt, \$bolts_count\);/ }, note: 'plus one bolt tip per the rung' }],
        conditions: [{ file: BOLTS, re: MEMBERS, after: /^\[label,make_bolts\]/ }],
    },
    {
        id: 'fletching/stringing', skill: 'fletching', kinds: ['fletching_table'], idPattern: /^fletching\/stringing_/, note: 'no tool',
        consumed: [{ items: ['bow_string'], perAction: 1, at: { file: BOWS, re: /inv_del\(inv, bow_string, 1\);/ }, note: 'plus the unstrung bow' }],
        conditions: [{ file: BOWS, re: MEMBERS }],
    },
    {
        id: 'firemaking/burn', skill: 'firemaking', kinds: ['burn'],
        items: [{ anyOf: ['tinderbox'], hold: 'held', role: 'tool', at: { file: FM, re: /if\(inv_total\(inv, tinderbox\) < 1\)/ } }],
        consumed: [{ items: [], perAction: 1, at: { file: FM, re: /def_int \$level = oc_param\(\$log, levelrequire\);/ }, note: 'one log per the rung; the log levelrequire param is the Firemaking level' }],
    },
    {
        id: 'herblore/potion', skill: 'herblore', kinds: ['potion'], note: 'no tool; herb + vial_water makes the unfinished potion, then the secondary',
        consumed: [{ items: ['vial_water'], perAction: 1, at: { file: BREW, re: /^\[opheldu,vial_water\]/ }, note: 'plus the herb and secondary per the rung' }],
        conditions: [{ file: BREW, re: MEMBERS }],
    },
    {
        id: 'herblore/identify', skill: 'herblore', kinds: ['identify'], note: 'no tool',
        conditions: [{ file: IDENT, re: MEMBERS }],
    },
    {
        id: 'cooking/heat-source', skill: 'cooking', kinds: ['cooking_generic'],
        items: [{ anyOf: ['gauntlets_of_cooking'], hold: 'worn', role: 'bonus', at: { file: COOK, re: /inv_total\(worn, gauntlets_of_cooking\) > 0/ }, note: 'uses the row successchance_gauntlets while worn' }],
        locs: [
            { anyOf: ['_cooking_oven'], at: { file: COOK, re: /^\[oplocu,_cooking_oven\]/ } },
            { anyOf: ['_cooking_fire'], at: { file: COOK, re: /^\[oplocu,_cooking_fire\]/ } },
        ],
        conditions: [{ file: COOK, re: /loc_type = cooksquestrange/ }],
        note: 'a range (_cooking_oven) or a fire (_cooking_fire); range rows may use successchance_range',
    },
    {
        id: 'cooking/wine', skill: 'cooking', kinds: ['wine'], note: 'no tool',
        level: { file: WINE, re: /if \(stat\(cooking\) < 35\)/, value: 35 },
        consumed: [
            { items: ['grapes'], perAction: 1, at: { file: WINE, re: /inv_del\(inv, grapes, 1\);/ } },
            { items: ['jug_water'], perAction: 1, at: { file: WINE, re: /inv_del\(inv, jug_water, 1\);/ } },
        ],
    },
    {
        id: 'runecraft/altar', skill: 'runecraft', kinds: ['runecraft_table'],
        items: [{ anyOf: ['_talismans'], hold: 'held', role: 'access', at: { file: RC, re: /if \(oc_category\(last_useitem\) = talismans\)/ }, note: 'the rung talisman (ladder requires) is used on the ruins; it is not consumed' }],
        consumed: [{ items: ['blankrune'], perAction: null, at: { file: RC, re: /inv_del\(inv, blankrune, \$total_ess\);/ }, note: 'all essence held is used in one action' }],
        locs: [
            { anyOf: ['_rc_ruins'], at: { file: RC, re: /^\[oplocu,_rc_ruins\]/ } },
            { anyOf: ['_rc_altar'], at: { file: RC, re: /^\[oploc1,_rc_altar\]/ } },
        ],
        gaps: ['no .rs2 or .obj file under content/scripts names a tiara; only a talisman used on the ruins enters the altar'],
    },
    {
        id: 'thieving/locked-chest', skill: 'thieving', kinds: ['trapped_chest'], idPattern: /chest_steel_arrowtips$/,
        items: [{ anyOf: ['lockpick'], hold: 'held', role: 'tool', at: { file: CHEST, re: /if \(inv_total\(inv, lockpick\) < 1\)/ } }],
    },
    {
        id: 'fishing/guild-entry', skill: 'fishing', kinds: [], note: 'entry gate for the Fishing Guild spots',
        level: { file: GUILD, re: /if \(stat\(fishing\) < 68\)/, value: 68 },
    },
];

/** Materialize one anchored `Spec` into a `ToolRecord` with line citations. */
export function fromSpec(sp: Spec, rungs: Rung[]): ToolRecord {
    const rec = emptyRecord(sp.id, sp.skill, applies(rungs, sp.skill, sp.kinds, sp.idPattern), '');
    if (sp.note) rec.note = sp.note;
    const miss = (a: SpecAnchor) => rec.gaps.push(`anchor not found: ${a.file} /${a.re.source}/`);
    const check = (names: string[], c: Cite, a: SpecAnchor) => {
        let text = c.text;
        if (a.block) {
            const l = lines(a.file);
            const start = Number(c.src.split(':').pop()) - 1;
            const end = l.findIndex((x, i) => i > start && /^\[/.test(x));
            text = l.slice(start, end < 0 ? l.length : end).join('\n');
        }
        // A category name may appear with its `_` (trigger) or without it (oc_category test).
        for (const n of names) if (!new RegExp(`(^|[^a-z0-9_])${n.startsWith('_') ? '_?' : ''}${n.replace(/^_/, '')}\\b`).test(text)) rec.gaps.push(`${n} is not on ${c.src}${a.block ? ' or its block' : ''}: ${c.text}`);
    };
    if (sp.level) {
        const c = cite(sp.level.file, sp.level.re, sp.level.after);
        if (c && c.text.includes(String(sp.level.value))) { rec.minLevel = sp.level.value; rec.levelSrc = c.src; } else miss(sp.level);
    }
    for (const it of sp.items ?? []) {
        const c = cite(it.at.file, it.at.re, it.at.after);
        if (!c) { miss(it.at); continue; }
        check(it.anyOf, c, it.at);
        rec.items.push({ anyOf: it.anyOf, ids: it.anyOf.map(n => n.startsWith('_') ? null : itemId(n)), hold: it.hold, role: it.role, src: c.src, ...(it.note ? { note: it.note } : {}) });
        for (const n of it.anyOf) if (!n.startsWith('_') && itemId(n) === null) rec.gaps.push(`${n} not in knowledge/items.json`);
    }
    for (const cs of sp.consumed ?? []) {
        const c = cite(cs.at.file, cs.at.re, cs.at.after);
        if (!c) { miss(cs.at); continue; }
        check(cs.items, c, cs.at);
        if (!cs.items.length) rec.consumed.push({ item: '(rung input)', id: null, perAction: cs.perAction, src: c.src, ...(cs.note ? { note: cs.note } : {}) });
        for (const n of cs.items) rec.consumed.push({ item: n, id: itemId(n), perAction: cs.perAction, src: c.src, ...(cs.note ? { note: cs.note } : {}) });
    }
    for (const l of sp.locs ?? []) {
        const c = cite(l.at.file, l.at.re, l.at.after);
        if (!c) { miss(l.at); continue; }
        check(l.anyOf, c, l.at);
        rec.locs.push({ anyOf: l.anyOf, src: c.src });
    }
    for (const a of [...(sp.dispatch ? [sp.dispatch] : []), ...(sp.conditions ?? [])]) {
        const c = cite(a.file, a.re, a.after);
        if (c) rec.conditions.push({ text: c.text, src: c.src }); else miss(a);
    }
    rec.gaps.push(...(sp.gaps ?? []));
    rec.src = rec.items[0]?.src ?? rec.locs[0]?.src ?? rec.consumed[0]?.src ?? rec.levelSrc ?? rec.conditions[0]?.src ?? '';
    if (sp.kinds.length && !rec.appliesTo.rungs.length) rec.gaps.push(`no ladder rung matches kinds ${sp.kinds.join(',')}${sp.idPattern ? ` and /${sp.idPattern.source}/` : ''}`);
    return rec;
}
