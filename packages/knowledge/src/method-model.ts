// Per-action model of each ladder rung, read from the pinned game content: base XP per action, ticks per action
// (script timing and success rolls), items per action and tools. Every value carries a content file:line.
// modelXpPerTick is derived (25x, no banking, walking, resupply or level-up dialogs). It is never a measured rate:
// measured rates live only in knowledge/rates.json.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, parseConfigs, type ConfigBlock } from './config';
import { contentRoot } from './paths';
import { cleanLines } from './text';

// Engine facts (repo-relative paths).
export const XP_RATE = 25;
export const XP_RATE_SRC = 'vendor/rs-sdk/server/engine/src/util/WorldConfig.ts:102';
export const ACTIONS_PER_TICK = 5; // USER_EVENT decode limit per tick
export const ACTIONS_PER_TICK_SRC = 'vendor/rs-sdk/server/engine/src/network/game/client/ClientGameProtCategory.ts:6';
export const STAT_RANDOM_SRC = 'vendor/rs-sdk/server/engine/src/engine/script/handlers/PlayerOps.ts:591';
// p_delay(n) sets delayedUntil = tick + 1 + n; a suspended script resumes on that tick, and a new client action is
// refused on that tick because packets are decoded before the flag clears.
export const P_DELAY_SRC = 'vendor/rs-sdk/server/engine/src/engine/script/handlers/PlayerOps.ts:378';
// A weak queue entry with delay d added while the weak queue runs fires d + 1 ticks later (delay-- before the test).
export const WEAKQUEUE_SRC = 'vendor/rs-sdk/server/engine/src/engine/entity/Player.ts:975';

// Chance that stat_random(stat, low, high) passes at a level (engine formula, value > floor(random * 256)).
export function statRandomChance(level: number, low: number, high: number): number {
    const l = Math.min(Math.max(level, 1), 99);
    const value = Math.floor((low * (99 - l)) / 98) + Math.floor((high * (l - 1)) / 98) + 1;
    return Math.min(Math.max(value, 0), 256) / 256;
}

// Ticks a run of p_delay calls costs: each resumes after n + 1 ticks; a run that ends the action and waits for a
// new client action adds one more tick for the refused decode.
export function pDelayTicks(delays: number[], reclick: boolean): number {
    return delays.reduce((a, n) => a + n + 1, 0) + (reclick ? 1 : 0);
}

export interface Roll {
    tool: string | null; toolLevel: number; rollTicks: number; failTicks: number;
    low: number | null; high: number | null; fixedChance: number | null; src: string;
}
export interface Timing {
    basis: 'instant' | 'p_delay' | 'queue-loop' | 'roll' | 'timer';
    ticksPerTry: number; // ticks per attempt; for a roll, the roll period with the best tool at the unlock level
    rolls: Roll[];
    note: string;
    src: string[];
}
export interface Facts {
    xpPerAction: number | null; xpSrc: string | null; xpNote: string | null;
    inputs: { debugname: string; count: number }[] | null;
    outputs: { debugname: string; count: number }[] | null;
    tools: string[];
    level: number | null; levelSrc: string | null;
    timing: Timing | null;
    gaps: string[];
}

export interface Content {
    lines(file: string): string[] | null;
    obj(name: string): ConfigBlock | undefined;
    struct(name: string): ConfigBlock | undefined;
    structs(): ConfigBlock[];
    npc(name: string): ConfigBlock | undefined;
}

// Reads files relative to the content root. Config indexes prefer a block outside _unpack/ (the curated copy).
export function loadContent(root = contentRoot()): Content {
    const texts = new Map<string, string[] | null>();
    const lines = (file: string) => {
        if (!texts.has(file)) { const p = join(root, file); texts.set(file, existsSync(p) ? cleanLines(readFileSync(p, 'utf8')) : null); }
        return texts.get(file)!;
    };
    const indexes = new Map<string, { byName: Map<string, ConfigBlock>; all: ConfigBlock[] }>();
    const index = (ext: string) => {
        let ix = indexes.get(ext);
        if (!ix) {
            const all: ConfigBlock[] = [];
            const byName = new Map<string, ConfigBlock>();
            for (const f of listConfigFiles(ext)) for (const b of parseConfigs(readFileSync(join(root, f), 'utf8'), f)) {
                all.push(b);
                const cur = byName.get(b.name);
                if (!cur || (cur.file.includes('/_unpack/') && !b.file.includes('/_unpack/'))) byName.set(b.name, b);
            }
            ix = { byName, all };
            indexes.set(ext, ix);
        }
        return ix;
    };
    return {
        lines, obj: n => index('.obj').byName.get(n), struct: n => index('.struct').byName.get(n),
        structs: () => index('.struct').all, npc: n => index('.npc').byName.get(n),
    };
}

// `param=key,value` of a config block, with its file:line.
export function param(b: ConfigBlock | undefined, key: string): { value: string; src: string } | null {
    if (!b) return null;
    const vals = b.props.param ?? [];
    for (let i = 0; i < vals.length; i++) {
        const v = vals[i]!, c = v.indexOf(',');
        if (v.slice(0, c) === key) return { value: v.slice(c + 1), src: `${b.file}:${b.propLines.param![i]}` };
    }
    return null;
}
export function prop(b: ConfigBlock | undefined, key: string): { value: string; src: string } | null {
    const v = b?.props[key]?.[0];
    return v === undefined ? null : { value: v, src: `${b!.file}:${b!.propLines[key]![0]}` };
}

// Line range of the block whose header is `[kind,name]` or `[name]`, header to next header.
export function block(c: Content, file: string, name: string): { from: number; to: number } | null {
    const ls = c.lines(file);
    if (!ls) return null;
    const head = new RegExp(`^\\[(?:[a-z_0-9]+,)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`);
    const from = ls.findIndex(l => head.test(l));
    if (from < 0) return null;
    let to = ls.findIndex((l, i) => i > from && l.startsWith('['));
    if (to < 0) to = ls.length;
    return { from, to };
}

export interface Hit { m: RegExpExecArray; src: string; line: number }
// Every match of `re` in a file (or in one script block of it), on comment-stripped lines.
export function findAll(c: Content, file: string, re: RegExp, inBlock?: string): Hit[] {
    const ls = c.lines(file);
    if (!ls) return [];
    const r = inBlock ? block(c, file, inBlock) : { from: 0, to: ls.length };
    if (!r) return [];
    const out: Hit[] = [];
    for (let i = r.from; i < r.to; i++) { const m = re.exec(ls[i]!); if (m) out.push({ m, src: `${file}:${i + 1}`, line: i + 1 }); }
    return out;
}
export const find = (c: Content, file: string, re: RegExp, inBlock?: string): Hit | null => findAll(c, file, re, inBlock)[0] ?? null;

// Expected ticks per successful action at a level with the best roll usable at that level (tool level <= level).
export function ticksPerSuccess(t: Timing, level: number): number | null {
    if (!t.rolls.length) return t.ticksPerTry;
    let best: number | null = null;
    for (const r of t.rolls) {
        if (r.toolLevel > level) continue;
        const p = r.fixedChance ?? statRandomChance(level, r.low!, r.high!);
        if (p <= 0) continue;
        const ticks = (r.rollTicks + (1 - p) * r.failTicks) / p;
        if (best === null || ticks < best) best = ticks;
    }
    return best;
}

// Derived XP per tick at 25x for a level; null when XP or timing is unknown.
export function modelXpPerTickAt(xpPerAction: number | null, t: Timing | null, level: number): number | null {
    if (xpPerAction === null || !t) return null;
    const ticks = ticksPerSuccess(t, level);
    return ticks === null || ticks <= 0 ? null : Math.round((xpPerAction * XP_RATE / ticks) * 100) / 100;
}

// The best roll usable at a level (lowest expected ticks per success), or null without rolls.
export function bestRoll(t: Timing, level: number): Roll | null {
    let best: Roll | null = null, bestTicks = Infinity;
    for (const r of t.rolls) {
        if (r.toolLevel > level) continue;
        const p = r.fixedChance ?? statRandomChance(level, r.low!, r.high!);
        const ticks = p > 0 ? (r.rollTicks + (1 - p) * r.failTicks) / p : Infinity;
        if (ticks < bestTicks || (ticks === bestTicks && best !== null && r.toolLevel > best.toolLevel)) { best = r; bestTicks = ticks; }
    }
    return best;
}

export interface Band { from: number; to: number; tool: string | null; xpPerTickFrom: number | null; xpPerTickTo: number | null }
// Model XP per tick over levels from..99, split at each 10-level boundary and where the best tool changes.
// A rung with no success roll has one flat band.
export function modelBands(xpPerAction: number | null, t: Timing | null, from: number): Band[] {
    if (xpPerAction === null || !t) return [];
    const start = Math.max(1, Math.min(99, from));
    if (!t.rolls.length) { const v = modelXpPerTickAt(xpPerAction, t, start); return [{ from: start, to: 99, tool: null, xpPerTickFrom: v, xpPerTickTo: v }]; }
    const bands: Band[] = [];
    let cur: Band | null = null;
    for (let l = start; l <= 99; l++) {
        const tool = bestRoll(t, l)?.tool ?? null;
        if (!cur || tool !== cur.tool || l % 10 === 0) {
            cur = { from: l, to: l, tool, xpPerTickFrom: modelXpPerTickAt(xpPerAction, t, l), xpPerTickTo: null };
            bands.push(cur);
        }
        cur.to = l;
        cur.xpPerTickTo = modelXpPerTickAt(xpPerAction, t, l);
    }
    return bands;
}

// Content coord `level_mx_mz_lx_lz` as a tile.
export function coordTile(s: string): { x: number; z: number; level: number } | null {
    const p = s.split('_').map(Number);
    return p.length === 5 && p.every(n => Number.isFinite(n)) ? { level: p[0]!, x: p[1]! * 64 + p[3]!, z: p[2]! * 64 + p[4]! } : null;
}

const FILES = {
    woodcut: 'scripts/skill_woodcutting/scripts/woodcut.rs2',
    jungle: 'scripts/quests/quest_legends/scripts/jungle_tree.rs2',
    mining: 'scripts/skill_mining/scripts/mining.rs2',
    cooking: 'scripts/skill_cooking/scripts/cooking.rs2',
    wine: 'scripts/skill_cooking/scripts/cooking_inv/scripts/wine/wine.rs2',
    smithing: 'scripts/skill_smithing/scripts/smithing/smithing.rs2',
    smelting: 'scripts/skill_smithing/scripts/smelting/smelting.rs2',
    arrows: 'scripts/skill_fletching/scripts/arrows.rs2',
    darts: 'scripts/skill_fletching/scripts/darts.rs2',
    bolts: 'scripts/skill_fletching/scripts/bolts.rs2',
    bows: 'scripts/skill_fletching/scripts/bows.rs2',
    cutLogs: 'scripts/skill_fletching/scripts/cut_logs.rs2',
    leather: 'scripts/skill_crafting/scripts/leather/leather.rs2',
    gem: 'scripts/skill_crafting/scripts/gem/uncut_gem.rs2',
    spinning: 'scripts/skill_crafting/scripts/spinning/spinning.rs2',
    pottery: 'scripts/skill_crafting/scripts/pottery/pottery.rs2',
    glass: 'scripts/skill_crafting/scripts/glass/glass.rs2',
    jewellery: 'scripts/skill_crafting/scripts/jewellery/jewellery.rs2',
    staves: 'scripts/skill_crafting/scripts/battlestaves/battlestaves.rs2',
    runecraft: 'scripts/skill_runecraft/scripts/runecraft.rs2',
    thieving: 'scripts/skill_thieving/scripts/thieving.rs2',
    firemaking: 'scripts/skill_firemaking/scripts/firemaking.rs2',
    identify: 'scripts/skill_herblore/scripts/identifying/identify.rs2',
    brew: 'scripts/skill_herblore/scripts/brewing/brew_potion.rs2',
    bury: 'scripts/skill_prayer/scripts/bury_bone.rs2',
    combat: 'scripts/skill_combat/scripts/combat.rs2',
    combatParam: 'scripts/skill_combat/configs/combat.param',
    playerMagic: 'scripts/skill_combat/scripts/player/player_magic.rs2',
    spells: 'scripts/skill_magic/scripts/spells/',
    fishingSpots: ['freshfish', 'saltfish', 'memberfish', 'rarefish', 'lavafish', 'lavafish_loc', 'slimeyfish', 'tbwt', 'waterfall']
        .map(f => `scripts/skill_fishing/scripts/fishing_spots/${f}.rs2`),
    courses: { gnome: 'scripts/skill_agility/scripts/gnome_course.rs2', barbarian: 'scripts/skill_agility/scripts/barbarian_course.rs2', wilderness: 'scripts/skill_agility/scripts/wilderness_course.rs2' } as Record<string, string>,
};
export const MODEL_FILES = FILES;
const COURSE_RUNGS: Record<string, string> = {
    'course-gnome-stronghold-agility-course': 'gnome', 'course-barbarian-outpost-agility-course': 'barbarian', 'course-wilderness-course': 'wilderness',
};

// Rows of the dbtables the generator reads, as data columns with file:line.
export interface Row { name: string; data: Record<string, string[][]>; src: Record<string, string[]> }

const facts = (o: Partial<Facts>): Facts => ({ xpPerAction: null, xpSrc: null, xpNote: null, inputs: null, outputs: null, tools: [], level: null, levelSrc: null, timing: null, gaps: [], ...o });
const tenths = (v: string) => Number(v) / 10;

// p_delay timing of one script block. `reclick`: the action ends and the next one needs a new client packet.
function pDelayTiming(c: Content, file: string, blockName: string, reclick: boolean, note: string): Timing | string {
    const hits = findAll(c, file, /p_delay\((\d+)\)/, blockName);
    if (!hits.length) return `no p_delay in [${blockName}] of ${file}`;
    const ticks = pDelayTicks(hits.map(h => Number(h.m[1])), reclick);
    return { basis: 'p_delay', ticksPerTry: ticks, rolls: [], note: `${hits.map(h => `p_delay(${h.m[1]})`).join(' + ')}${reclick ? ' + 1 refused decode' : ''} = ${ticks} ticks. ${note}`.trim(), src: [...hits.map(h => h.src), P_DELAY_SRC] };
}
// An item action with no p_delay and no queue: 5 per tick.
function instantTiming(c: Content, file: string, blockName: string, note = ''): Timing | string {
    const b = block(c, file, blockName);
    if (!b) return `[${blockName}] not found in ${file}`;
    const delayed = findAll(c, file, /p_delay\(|weakqueue|queue\*?\(/, blockName);
    if (delayed.length) return `[${blockName}] in ${file} has a delay at ${delayed[0]!.src}`;
    return { basis: 'instant', ticksPerTry: 1 / ACTIONS_PER_TICK, rolls: [], note: `no p_delay or queue in [${blockName}]: up to ${ACTIONS_PER_TICK} actions per tick. ${note}`.trim(), src: [`${file}:${b.from + 1}`, ACTIONS_PER_TICK_SRC] };
}
// A make-X loop that re-queues itself with weakqueue delay d: d + 1 ticks per item.
function queueLoopTiming(c: Content, file: string, re: RegExp, note = ''): Timing | string {
    const h = find(c, file, re);
    if (!h) return `queue loop ${re} not found in ${file}`;
    const d = Number(h.m[1]);
    return { basis: 'queue-loop', ticksPerTry: d + 1, rolls: [], note: `make-X loop re-queues with delay ${d}: ${d + 1} ticks per item. ${note}`.trim(), src: [h.src, WEAKQUEUE_SRC] };
}
const withRolls = (t: Timing | string, rolls: Roll[], note: string): Timing | string => typeof t === 'string' ? t : { ...t, basis: 'roll', rolls, note: `${t.note} ${note}`.trim() };

function struct(c: Content, key: string, value: string): ConfigBlock | undefined {
    return c.structs().find(s => param(s, key)?.value === value);
}

export interface ModelInput {
    id: string; skill: string; kind: string; level: number; row: Row | null;
    label: string; outputs: string[]; inputs: string[]; npc?: string;
}

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

// Facts for one rung. Unknown parts become a gap that names the missing fact.
export function modelRung(c: Content, r: ModelInput): Facts {
    const row = r.row;
    const col = (name: string, i = 0) => row?.data[name]?.[i];
    const colSrc = (name: string, i = 0) => row?.src[name]?.[i] ?? null;
    const items = (name: string, count: number) => { const v = col(name)?.[0]; return v ? [{ debugname: v, count }] : null; };
    const done = (f: Partial<Facts>, t: Timing | string | null) => {
        const out = facts(f);
        if (typeof t === 'string') out.gaps.push(`ticks per action unknown: ${t}`);
        else out.timing = t;
        return out;
    };
    const rowName = r.id.slice(r.id.indexOf('/') + 1);

    switch (r.kind) {
    case 'woodcutting_trees': {
        // Kharazi jungle trees have their own oploc script with one roll for every axe.
        if (row?.data.tree?.some(t => /^kharazi_jungle_tree/.test(t[0]!))) {
            const d = find(c, FILES.jungle, /%action_delay = calc\(map_clock \+ (\d+)\)/, 'chop_jungle');
            const roll = find(c, FILES.jungle, /stat_random\(woodcutting, (\d+), (\d+)\)/, 'chop_jungle');
            if (!d || !roll) return done({}, `jungle roll not found in [label,chop_jungle] of ${FILES.jungle}`);
            const rollTicks = Number(d.m[1]) + 1;
            return done({ outputs: items('product', 1) }, {
                basis: 'roll', ticksPerTry: rollTicks, note: `a roll every ${rollTicks} ticks with any usable axe. Needs the Legends' Quest Kharazi map ([label,start_chop_jungle]); a cut moves the player one tile.`,
                src: [d.src, roll.src], rolls: [{ tool: null, toolLevel: 1, rollTicks, failTicks: 0, low: Number(roll.m[1]), high: Number(roll.m[2]), fixedChance: null, src: roll.src }],
            });
        }
        const period = find(c, FILES.woodcut, /%action_delay = calc\(map_clock \+ (\d+)\)/, 'cut_tree');
        if (!period) return done({}, `roll delay not found in [label,cut_tree] of ${FILES.woodcut}`);
        const rollTicks = Number(period.m[1]) + 1;
        const rolls: Roll[] = (row?.data.successchance ?? []).map((v, i) => ({
            tool: v[0]!, toolLevel: Math.max(1, Number(param(c.obj(v[0]!), 'levelrequire')?.value ?? 1)), rollTicks, failTicks: 0,
            low: Number(v[1]), high: Number(v[2]), fixedChance: null, src: row!.src.successchance![i]!,
        }));
        const respawn = col('respawnrate')?.[0];
        return done({ outputs: items('product', 1), tools: rolls.map(x => x.tool!) },
            withRolls({ basis: 'roll', ticksPerTry: rollTicks, rolls: [], note: `a roll every ${rollTicks} ticks (the poll tick plus ${period.m[1]}).`, src: [period.src] }, rolls,
                `Success: stat_random with the best axe usable at the level. ${respawn === '0' ? 'Normal trees fall on the first log.' : 'A tree falls with chance 1/8 per log.'} The model assumes a ready tree.`));
    }
    case 'mining_table': {
        const period = find(c, FILES.mining, /%action_delay = calc\(map_clock \+ \$mining_rate\)/);
        const chance = col('rock_successchance');
        if (!period || !chance) return done({}, `mining roll delay or rock_successchance not found (${FILES.mining}, ${r.id})`);
        const rolls: Roll[] = [];
        for (const pick of ['bronze_pickaxe', 'iron_pickaxe', 'steel_pickaxe', 'mithril_pickaxe', 'adamant_pickaxe', 'rune_pickaxe']) {
            const rate = param(c.obj(pick), 'mining_rate'), lvl = param(c.obj(pick), 'levelrequire');
            if (!rate) continue;
            rolls.push({ tool: pick, toolLevel: Math.max(1, Number(lvl?.value ?? 1)), rollTicks: Number(rate.value) + 1, failTicks: 0, low: Number(chance[0]), high: Number(chance[1]), fixedChance: null, src: rate.src });
        }
        const respawn = col('rock_respawnrate')?.[0];
        return done({ outputs: items('rock_output', 1), tools: rolls.map(x => x.tool!) },
            withRolls({ basis: 'roll', ticksPerTry: rolls[0]?.rollTicks ?? 0, rolls: [], note: 'a roll every pickaxe mining_rate + 1 ticks.', src: [period.src, colSrc('rock_successchance')!] }, rolls,
                `Success: stat_random(rock_successchance). The rock depletes after one ore${respawn ? ` (respawn ${respawn} ticks)` : ''}; the model assumes a ready rock. A 1/256 gem roll replaces the ore roll.`));
    }
    case 'cooking_generic': {
        const t = pDelayTiming(c, FILES.cooking, 'cook_item', true, 'One item per use on the range or fire.');
        const range = col('successchance_range'), fire = col('successchance');
        const ch = range ?? fire;
        const xp = col('experience')?.[0];
        if (!ch) return done({ xpPerAction: xp ? tenths(xp) : null, xpSrc: colSrc('experience') }, t);
        const always = ch[0] === '1' && ch[1] === '1';
        const roll: Roll = { tool: range ? 'range' : 'fire', toolLevel: 1, rollTicks: typeof t === 'string' ? 0 : t.ticksPerTry, failTicks: 0,
            low: always ? null : Number(ch[0]), high: always ? null : Number(ch[1]), fixedChance: always ? 1 : null, src: colSrc(range ? 'successchance_range' : 'successchance')! };
        return done({ xpPerAction: xp ? tenths(xp) : null, xpSrc: colSrc('experience'), inputs: items('uncooked', 1), outputs: items('cooked', 1) },
            withRolls(t, [roll], `XP only when the food does not burn (stat_random on the ${roll.tool}).`));
    }
    case 'smithing': {
        const bar = col('bar')?.[0], amount = Number(col('bar_amount')?.[0] ?? 1), product = col('product')?.[0], made = Number(col('product_amount')?.[0] ?? 1);
        const s = bar ? struct(c, 'namedobj', bar) : undefined;
        const per = param(s, 'xpperbar');
        const t = pDelayTiming(c, FILES.smithing, 'smithing_anvil', false, 'The make-X loop recurses after the last delay.');
        return done({
            xpPerAction: per ? tenths(per.value) * amount : null, xpSrc: per?.src ?? null, xpNote: per ? `bar_amount ${amount} x xpperbar ${tenths(per.value)}` : null,
            inputs: bar ? [{ debugname: bar, count: amount }] : null, outputs: product ? [{ debugname: product, count: made }] : null, tools: ['hammer'],
            gaps: per ? [] : [`xpperbar for ${bar} not found in any smithing struct`],
        }, t);
    }
    case 'fletching_table': {
        const product = col('product'), xp = col('experience')?.[0];
        const count = Number(product?.[1] ?? 1);
        const family = /_tips$/.test(rowName) ? { file: FILES.bolts, block: 'make_bolt_tips', multiplied: false }
            : /_bolts$/.test(rowName) ? { file: FILES.bolts, block: 'make_bolts', multiplied: true }
            : /_dart$/.test(rowName) ? { file: FILES.darts, block: 'make_darts', multiplied: true }
            : /_arrow$/.test(rowName) ? { file: FILES.arrows, block: 'make_arrows', multiplied: true }
            : /^stringing_/.test(rowName) ? { file: FILES.bows, block: 'string_bow', multiplied: false } : null;
        if (!family || !xp) return done({}, `no fletching script mapped for ${rowName}`);
        const n = family.multiplied ? count : 1;
        return done({
            xpPerAction: tenths(xp) * n, xpSrc: colSrc('experience'), xpNote: family.multiplied ? `${count} items per action x ${tenths(xp)} XP` : null,
            inputs: items('item', n), outputs: product ? [{ debugname: product[0]!, count }] : null,
        }, instantTiming(c, family.file, family.block));
    }
    case 'fletch_bow': {
        const t = queueLoopTiming(c, FILES.cutLogs, /weakqueue\*\(fletch_logs, sub\(%action_delay, map_clock\)\)/);
        const delay = find(c, FILES.cutLogs, /%action_delay = add\(map_clock, (\d+)\)/, 'process_fletch_logs');
        const timing: Timing | string = typeof t === 'string' || !delay ? (delay ? t : 'action_delay step not found in [label,process_fletch_logs]')
            : { ...t, ticksPerTry: Number(delay.m[1]) + 1, note: `make-X loop re-queues with delay ${delay.m[1]} (action_delay - map_clock): ${Number(delay.m[1]) + 1} ticks per item.`, src: [delay.src, ...t.src] };
        return done({}, timing);
    }
    case 'craft_leather_table': {
        const leather = col('leather'), xp = col('experience')?.[0] ?? col('productexp')?.[0];
        const delay = find(c, FILES.leather, /%action_delay = add\(map_clock, (\d+)\)/, 'process_leather_crafting');
        const t: Timing | string = delay ? { basis: 'queue-loop', ticksPerTry: Number(delay.m[1]) + 1, rolls: [], note: `make-X loop re-queues with delay ${delay.m[1]}: ${Number(delay.m[1]) + 1} ticks per item.`, src: [delay.src, WEAKQUEUE_SRC] } : `queue delay not found in ${FILES.leather}`;
        return done({ inputs: leather ? [{ debugname: leather[0]!, count: Number(leather[1] ?? 1) }] : null, outputs: items('product', 1), tools: ['needle', 'thread'], xpSrc: xp ? colSrc('productexp') : null }, t);
    }
    case 'gem_cutting_table': {
        const t = instantTiming(c, FILES.gem, 'crafting_gem');
        const ch = col('success_rate');
        const rolls: Roll[] = ch && typeof t !== 'string' ? [{ tool: 'chisel', toolLevel: 1, rollTicks: t.ticksPerTry, failTicks: 0, low: Number(ch[0]), high: Number(ch[1]), fixedChance: null, src: colSrc('success_rate')! }] : [];
        return done({ inputs: items('uncut_gem', 1), outputs: items('cut_gem', 1), tools: ['chisel'] },
            rolls.length ? withRolls(t, rolls, 'A failed cut crushes the gem and gives (XP + 2) / 4 tenths; the model counts only full cuts.') : t);
    }
    case 'runecraft_table': {
        const t = pDelayTiming(c, FILES.runecraft, 'runecraft_runes', true, 'One action crafts every essence held; 27 essence assumed (rcair measured 27 per trip).');
        const xp = col('experience')?.[0];
        return done({ xpPerAction: xp ? tenths(xp) * 27 : null, xpSrc: colSrc('experience'), xpNote: xp ? `27 essence x ${tenths(xp)} XP` : null, inputs: [{ debugname: 'blankrune', count: 27 }], outputs: items('rune', 27) }, t);
    }
    case 'magic_spell_table': return magicFacts(c, rowName, row);
    case 'pickpocket': {
        const t = pDelayTiming(c, FILES.thieving, 'pick_pocket', true, '');
        const ch = col('success_chance'), stun = col('stun_ticks')?.[0];
        if (!ch || typeof t === 'string') return done({}, t);
        const stunAt = find(c, FILES.thieving, /%action_delay = calc\(map_clock \+ \$stun_ticks\)/, 'fail_pick_pocket');
        return done({}, withRolls(t, [{ tool: null, toolLevel: 1, rollTicks: t.ticksPerTry, failTicks: Number(stun ?? 0), low: Number(ch[0]), high: Number(ch[1]), fixedChance: null, src: colSrc('success_chance')! }],
            `A failed try stuns for stun_ticks ${stun} (${stunAt?.src ?? 'fail_pick_pocket'}, ${colSrc('stun_ticks')}); the model adds the stun to each fail.`));
    }
    case 'stealing': return done({}, pDelayTiming(c, FILES.thieving, 'steal_from_stall', true, 'The stall then respawns; the model assumes a ready stall and no guard.'));
    case 'trapped_chest': return done({}, pDelayTiming(c, FILES.thieving, 'disarm_trapped_chest', true, 'The chest then respawns; the model assumes a ready chest.'));
    case 'catch': return fishFacts(c, r.outputs[0]);
    case 'burn': {
        const log = r.inputs[0];
        const xp = log ? param(c.obj(log), 'productexp') : null;
        const roll = find(c, FILES.firemaking, /stat_random\(firemaking, (\d+), (\d+)\)/, 'light_logs_inv');
        const next = roll ? findAll(c, FILES.firemaking, /%action_delay = calc\(map_clock \+ (\d+)\)/, 'light_logs_inv').find(h => h.line > roll.line) ?? null : null;
        const t: Timing | string = roll && next ? {
            basis: 'roll', ticksPerTry: Number(next.m[1]), note: `a light roll every ${next.m[1]} ticks; after a light the next log waits the same ${next.m[1]} ticks.`, src: [roll.src, next.src],
            rolls: [{ tool: 'tinderbox', toolLevel: 1, rollTicks: Number(next.m[1]), failTicks: 0, low: Number(roll.m[1]), high: Number(roll.m[2]), fixedChance: null, src: roll.src }],
        } : `firemaking roll not found in [label,light_logs_inv] of ${FILES.firemaking}`;
        return done({ xpPerAction: xp ? tenths(xp.value) : null, xpSrc: xp?.src ?? null, inputs: log ? [{ debugname: log, count: 1 }] : null, tools: ['tinderbox'], gaps: xp ? [] : [`productexp param missing on log obj ${log}`] }, t);
    }
    case 'smelt': {
        const bar = r.outputs[0];
        const s = bar ? struct(c, 'product', bar) : undefined;
        const xp = param(s, 'productexp');
        const q = find(c, FILES.smelting, /weakqueue\*\(smelting_ore, (\d+)\)/, 'start_smelt_ore');
        const startQ = find(c, FILES.smelting, /weakqueue\*\(start_smelt_ore, calc\(%action_delay - map_clock - 1\)\)/);
        const ad = find(c, FILES.smelting, /%action_delay = add\(map_clock, (\d+)\)/, 'smelting_ore');
        let t: Timing | string = 'smelting loop delays not found in ' + FILES.smelting;
        if (q && startQ && ad) {
            const first = Number(ad.m[1]) - 1 + 1, second = Number(q.m[1]) + 1;
            t = { basis: 'queue-loop', ticksPerTry: first + second, rolls: [], note: `each bar: start_smelt_ore after ${first} tick, then smelting_ore after ${second}: ${first + second} ticks per bar.`, src: [ad.src, startQ.src, q.src, WEAKQUEUE_SRC] };
            if (bar === 'iron_bar') {
                const fail = find(c, FILES.smelting, /randominc\(1\) = 1/, 'smelting_ore');
                if (fail) t = withRolls(t, [{ tool: null, toolLevel: 1, rollTicks: first + second, failTicks: 0, low: null, high: null, fixedChance: 0.5, src: fail.src }], 'Iron fails half the time without a ring of forging.');
            }
        }
        const ins: { debugname: string; count: number }[] = [];
        const ing = param(s, 'ingredient'), ingN = param(s, 'bar_count'), sec = param(s, 'ingredient_secondary'), secN = param(s, 'ingredient_secondary_count');
        if (ing) ins.push({ debugname: ing.value, count: Number(ingN?.value ?? 1) });
        if (sec) ins.push({ debugname: sec.value, count: Number(secN?.value ?? 1) });
        return done({ xpPerAction: xp ? tenths(xp.value) : null, xpSrc: xp?.src ?? null, inputs: ins.length ? ins : null, gaps: xp ? [] : [`no smelting struct with product ${bar}`] }, t);
    }
    case 'spin': return structFacts(c, r, 'product', 'productexp', queueLoopTiming(c, FILES.spinning, /weakqueue\*\(crafting_spinning, (\d+)\)\(\$spinning_obj/), []);
    case 'glass': {
        const delay = find(c, FILES.glass, /%action_delay = add\(map_clock, (\d+)\)/, 'process_glassblowing');
        const t: Timing | string = delay ? { basis: 'queue-loop', ticksPerTry: Number(delay.m[1]) + 1, rolls: [], note: `make-X loop re-queues with delay ${delay.m[1]}: ${Number(delay.m[1]) + 1} ticks per item.`, src: [delay.src, WEAKQUEUE_SRC] } : `queue delay not found in ${FILES.glass}`;
        return structFacts(c, r, 'product', 'productexp', t, ['glassblowingpipe'], [{ debugname: 'molten_glass', count: 1 }]);
    }
    case 'pottery': {
        const wheel = find(c, FILES.pottery, /%action_delay = add\(map_clock, (\d+)\)/, 'process_craft_pottery');
        const oven = find(c, FILES.pottery, /%action_delay = add\(map_clock, (\d+)\)/, 'process_fire_pottery');
        const roll = find(c, FILES.pottery, /stat_random\(crafting, (\d+), (\d+)\)/, 'fire_pottery');
        const s = structFor(c, r, 'product');
        const a = param(s, 'processexp'), b = param(s, 'productexp');
        if (!wheel || !oven || !roll || !a || !b) return done({}, `pottery wheel or oven timing, or struct for ${r.outputs[0]}, not found`);
        const ticks = Number(wheel.m[1]) + 1 + Number(oven.m[1]) + 1 + 1;
        return done({ xpPerAction: tenths(a.value) + tenths(b.value), xpSrc: a.src, xpNote: `wheel ${tenths(a.value)} (${a.src}) + oven ${tenths(b.value)} (${b.src})`, inputs: [{ debugname: 'softclay', count: 1 }] },
            { basis: 'roll', ticksPerTry: ticks, note: `wheel ${Number(wheel.m[1]) + 1} ticks + oven ${Number(oven.m[1]) + 1} + 1 ticks per item. The oven fire can fail; the model counts both XP parts only on a fired item.`, src: [wheel.src, oven.src, WEAKQUEUE_SRC],
              rolls: [{ tool: null, toolLevel: 1, rollTicks: ticks, failTicks: 0, low: Number(roll.m[1]), high: Number(roll.m[2]), fixedChance: null, src: roll.src }] });
    }
    case 'jewellery': {
        const s = structFor(c, r, 'product');
        const silver = !!param(s, 'mould'); // silver items name their mould; gold ones use the furnace interface moulds
        const t = silver ? queueLoopTiming(c, FILES.jewellery, /weakqueue\*\(craft_silver, (\d+)\)/, 'Silver items.')
            : pDelayTiming(c, FILES.jewellery, 'crafting_gold', false, 'The make-X loop recurses after the delay.');
        const gem = param(s, 'gem');
        const ins = [{ debugname: silver ? 'silver_bar' : 'gold_bar', count: 1 }, ...(gem ? [{ debugname: gem.value, count: 1 }] : [])];
        return structFacts(c, r, 'product', 'productexp', t, silver ? [param(s, 'mould')!.value] : [], ins, s);
    }
    case 'staff': {
        const s = structFor(c, r, 'product');
        const orb = param(s, 'ingredient');
        return structFacts(c, r, 'product', 'productexp', instantTiming(c, FILES.staves, 'craft_staff'), [], [{ debugname: 'battlestaff', count: 1 }, ...(orb ? [{ debugname: orb.value, count: 1 }] : [])]);
    }
    case 'wine': {
        const xp = find(c, FILES.wine, /stat_advance\(cooking, calc\((\d+) \* \$wines_per_batch\)\)/, 'fermenting_wine');
        const t = instantTiming(c, FILES.wine, 'make_wine', 'The XP arrives later from the fermenting timer, which also starts at every login.');
        return done({ xpPerAction: xp ? tenths(xp.m[1]!) : null, xpSrc: xp?.src ?? null, inputs: [{ debugname: 'grapes', count: 1 }, { debugname: 'jug_water', count: 1 }], outputs: [{ debugname: 'jug_unfermented_wine', count: 1 }] },
            typeof t === 'string' ? t : { ...t, basis: 'timer' });
    }
    case 'identify': {
        const herb = r.outputs[0];
        const xp = herb ? param(c.obj(herb), 'identified_herb_exp') : null;
        // The grimy herb is the opheld1 trigger whose body identifies this herb.
        const call = herb ? find(c, FILES.identify, new RegExp(`~attempt_identify_herb\\(${herb},`)) : null;
        const ls = c.lines(FILES.identify);
        const grimy = call && ls ? /^\[opheld1,([a-z_0-9]+)\]/.exec(ls[call.line - 2] ?? '')?.[1] : undefined;
        return done({ xpPerAction: xp ? tenths(xp.value) : null, xpSrc: xp?.src ?? null, inputs: grimy ? [{ debugname: grimy, count: 1 }] : null, gaps: xp ? [] : [`identified_herb_exp missing on ${herb}`] },
            instantTiming(c, FILES.identify, 'attempt_identify_herb'));
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
        return done({
            xpPerAction: xp ? tenths(xp.value) : null, xpSrc: xp?.src ?? null, level: lvl ? Number(lvl.value) : null, levelSrc: lvl?.src ?? null,
            inputs: ing && sol ? [{ debugname: sol.value, count: 1 }, { debugname: ing.value, count: 1 }] : null,
            outputs: mix ? [{ debugname: mix.value, count: 1 }] : null,
            gaps: xp ? [] : [`no brew_potion struct for ${r.outputs[0] ?? r.label}: ${byRecipe.length} recipes match unfinished ${unfMix ?? '(herb ' + herb + ' has no unfinished potion)'} + ${secondary ?? 'an unresolved secondary'}`],
        }, instantTiming(c, FILES.brew, 'attempt_brew_potion'));
    }
    case 'bury': {
        const bone = r.inputs[0];
        const xp = bone ? param(c.obj(bone), 'bone_exp') : null;
        return done({ xpPerAction: xp ? tenths(xp.value) : null, xpSrc: xp?.src ?? null, gaps: xp ? [] : [`bone_exp param missing on ${bone}`] },
            pDelayTiming(c, FILES.bury, 'bury_bones', true, ''));
    }
    case 'course': {
        const key = COURSE_RUNGS[rowName];
        if (!key) return done({ gaps: [`XP per action and ticks unknown: the guide row ${rowName} names an activity (agility arena or gnomeball) with no lap script, and its XP is paid by other scripts`] }, null);
        // A lap is the blocks that advance the course varp, plus the varp proc that pays the lap bonus.
        const file = FILES.courses[key]!, ls = c.lines(file) ?? [];
        const hits: Hit[] = [];
        for (let i = 0; i < ls.length; i++) {
            const h = /^\[([a-z_0-9]+),([^\]]+)\]/.exec(ls[i]!);
            if (!h) continue;
            const inLap = h[1] === 'proc' ? /^update_\w+_varp$/.test(h[2]!) : findAll(c, file, /~update_\w+_varp\(/, h[2]!).length > 0;
            if (inLap) hits.push(...findAll(c, file, /(?:stat_advance\(agility, |~agility_climb_up\(|~agility_force_move\()(\d+)/, h[2]!));
        }
        const xp = hits.reduce((a, h) => a + Number(h.m[1]), 0) / 10;
        return done({ xpPerAction: xp, xpSrc: hits[0]?.src ?? null, xpNote: `one lap: XP calls in the blocks that advance the course varp, lap bonus included (lines ${hits.map(h => h.src.split(':').pop()).join(', ')}); agility_climb_up and agility_force_move award their first argument (scripts/skill_agility/scripts/agility.rs2:6,16)`,
            gaps: ['lap ticks unknown: each obstacle moves the player with forcemove and walk steps that the generator does not sum'] }, null);
    }
    case 'target': return targetFacts(c, r);
    default:
        if (/gear$/.test(r.kind)) return facts({ xpNote: 'gear unlock: this rung is a wield or wear level, not an XP action' });
        return facts({ gaps: [`no model for rung kind ${r.kind}`] });
    }
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

function fishFacts(c: Content, fish: string | undefined): Facts {
    if (!fish) return facts({ gaps: ['catch item not resolved'] });
    const fs = param(c.obj(fish), 'fishing_struct');
    const s = fs ? c.struct(fs.value) : undefined;
    const xp = param(s, 'productexp'), lo = param(s, 'success_low'), hi = param(s, 'success_high');
    // The spot script that rolls this fish: its hidden-op label holds the roll delay and the equipment check.
    let best: { ticks: number; src: string[]; tool: string | null; bait: string | null } | null = null;
    for (const file of FILES.fishingSpots) {
        const calls = findAll(c, file, new RegExp(`~fish_roll(?:_loc)?\\(([^)]*\\b${fish}\\b[^)]*)\\)`));
        for (const call of calls) {
            const ls = c.lines(file)!;
            let head = call.line - 1;
            while (head > 0 && !ls[head]!.startsWith('[')) head--;
            const name = /^\[[a-z_0-9]+,([^\]]+)\]/.exec(ls[head]!)?.[1];
            if (!name) continue;
            const d = find(c, file, /%action_delay = calc\(map_clock \+ (\d+)\)/, name);
            const eq = find(c, file, /check_fish_equipment\((\w+)\)/, name);
            if (!d) continue;
            const ticks = Number(d.m[1]) + 1;
            const args = call.m[1]!.split(',').map(s => s.trim());
            const bait = args.length >= 4 && args[3] !== 'null' ? args[3]! : null;
            if (!best || ticks < best.ticks) best = { ticks, src: [d.src, call.src], tool: eq?.m[1] ?? null, bait };
        }
    }
    // Spots that roll inline (big net, karambwan): stat_random, inv_add and stat_advance on nearby lines.
    let inline: { xp: number; xpSrc: string; low: number; high: number; rollSrc: string; ticks: number; src: string[]; basis: Timing['basis']; tool: string | null } | null = null;
    if (!fs) for (const file of FILES.fishingSpots) {
        const ls = c.lines(file);
        if (!ls) continue;
        for (const add of findAll(c, file, new RegExp(`inv_add\\(inv, ${fish}, 1\\)`))) {
            const i = add.line - 1;
            let roll: RegExpExecArray | null = null, rollLine = -1, adv: RegExpExecArray | null = null, advLine = -1;
            for (let k = i; k >= Math.max(0, i - 3) && !roll; k--) { roll = /stat_random\(fishing, (\d+), (\d+)\)/.exec(ls[k]!); rollLine = k; }
            for (let k = i; k <= Math.min(ls.length - 1, i + 3) && !adv; k++) { adv = /stat_advance\(fishing, (\d+)\)/.exec(ls[k]!); advLine = k; }
            if (!roll || !adv) continue;
            let head = i;
            while (head > 0 && !ls[head]!.startsWith('[')) head--;
            const m = /^\[([a-z_0-9]+),([^\]]+)\]/.exec(ls[head]!);
            if (!m) continue;
            // The delay is in the block itself, or in the label that calls this proc.
            let host = m[2]!;
            if (m[1] === 'proc') { const caller = find(c, file, new RegExp(`~${host}\\b`)); if (caller) { let h = caller.line - 1; while (h > 0 && !ls[h]!.startsWith('[')) h--; host = /^\[[a-z_0-9]+,([^\]]+)\]/.exec(ls[h]!)?.[1] ?? host; } }
            const d = find(c, file, /%action_delay = calc\(map_clock \+ (\d+)\)/, host);
            const pd = findAll(c, file, /p_delay\((\d+)\)/, host).filter(h => h.line <= rollLine + 1);
            const eq = find(c, file, /check_fish_equipment\((\w+)\)/, host);
            const timing = d ? { ticks: Number(d.m[1]) + 1, src: [d.src], basis: 'roll' as const }
                : pd.length ? { ticks: pDelayTicks(pd.map(h => Number(h.m[1])), true), src: [...pd.map(h => h.src), P_DELAY_SRC], basis: 'roll' as const } : null;
            if (!timing) continue;
            const cand = { xp: Number(adv[1]) / 10, xpSrc: `${file}:${advLine + 1}`, low: Number(roll[1]), high: Number(roll[2]), rollSrc: `${file}:${rollLine + 1}`, ...timing, tool: eq?.m[1] ?? null };
            if (!inline || cand.ticks < inline.ticks) inline = cand;
        }
    }
    if (inline) return facts({
        xpPerAction: inline.xp, xpSrc: inline.xpSrc, tools: inline.tool ? [inline.tool] : [], outputs: [{ debugname: fish, count: 1 }],
        timing: { basis: 'roll', ticksPerTry: inline.ticks, note: `inline roll every ${inline.ticks} ticks. Other catches at the spot roll first or after; the model counts this catch alone.`, src: [...inline.src, inline.rollSrc],
            rolls: [{ tool: inline.tool, toolLevel: 1, rollTicks: inline.ticks, failTicks: 0, low: inline.low, high: inline.high, fixedChance: null, src: inline.rollSrc }] },
    });
    const gaps: string[] = [];
    if (!xp) gaps.push(`XP per action unknown: ${fish} has no fishing_struct param and no fishing spot script adds it (it comes from ${fish === 'raw_mantaray' || fish === 'raw_seaturtle' ? 'the Fishing Trawler reward, scripts/minigames/game_trawler/scripts/trawler_win.rs2' : 'a script outside skill_fishing'})`);
    if (!best) gaps.push(`ticks per action unknown: no fishing spot script rolls ${fish}`);
    return facts({
        xpPerAction: xp ? tenths(xp.value) : null, xpSrc: xp?.src ?? null, tools: best?.tool ? [best.tool] : [],
        inputs: best?.bait ? [{ debugname: best.bait, count: 1 }] : null, outputs: [{ debugname: fish, count: 1 }],
        timing: best && lo && hi ? { basis: 'roll', ticksPerTry: best.ticks, note: `a roll every ${best.ticks} ticks (the poll tick plus the action delay). The spot may roll a better fish first; the model counts this fish alone.`, src: best.src,
            rolls: [{ tool: best.tool, toolLevel: 1, rollTicks: best.ticks, failTicks: 0, low: Number(lo.value), high: Number(hi.value), fixedChance: null, src: lo.src }] } : null,
        gaps,
    });
}

function magicFacts(c: Content, rowName: string, row: Row | null): Facts {
    const spell = rowName.replace(/^magic_spell_/, '');
    const isCombat = !!(row?.data.maxhit || row?.data.stat_change || row?.data.freeze_time);
    let t: Timing | string;
    let note: string | null = null;
    const S = (f: string) => `${FILES.spells}${f}.rs2`;
    if (/^enchant_level\d$/.test(spell)) t = pDelayTiming(c, S('enchant'), 'magic_spell_enchant', true, '');
    else if (spell === 'high_alch') t = pDelayTiming(c, S('alchemy'), 'magic_spell_high_alch', true, '');
    else if (spell === 'low_alch') t = pDelayTiming(c, S('alchemy'), 'magic_spell_low_alch', true, '');
    else if (spell === 'superheat') t = pDelayTiming(c, S('superheat'), 'magic_spell_superheat', true, 'Also gives smithing XP.');
    else if (/^charge_[a-z]+_orb$/.test(spell)) t = pDelayTiming(c, S('charge_orb'), 'magic_spell_charge_orb', true, 'Cast on the obelisk.');
    else if (spell === 'bones_to_bananas') t = pDelayTiming(c, S('convert_bones'), 'magic_spell_convert_bones', true, '');
    else if (spell === 'telegrab') t = pDelayTiming(c, S('telegrab'), 'magic_spell_telegrab', true, 'Needs a ground item in range.');
    else if (/^teleport_/.test(spell)) t = pDelayTiming(c, S('teleport'), 'player_teleport_normal', true, 'Ticks are the teleport delays; walking back is not counted.');
    else if (spell === 'charge') t = instantTiming(c, S('charge'), 'magic:charge', 'Needs the Mage Arena god staff (%magearena).');
    else if (isCombat) {
        const d = find(c, FILES.playerMagic, /%action_delay = add\(map_clock, (\d+)\)/);
        t = d ? { basis: 'p_delay', ticksPerTry: Number(d.m[1]), rolls: [], note: `one cast every ${d.m[1]} ticks (combat spell attack delay). A hit also gives 2 XP per damage (${FILES.combat}:161); the model counts only the base cast XP.`, src: [d.src] } : `combat spell delay not found in ${FILES.playerMagic}`;
        note = 'base cast XP; damage XP not counted';
    } else t = `no timing model for spell ${spell}`;
    const out = facts({ xpNote: note });
    if (typeof t === 'string') out.gaps.push(`ticks per action unknown: ${t}`); else out.timing = t;
    return out;
}

const COMBAT_XP: Record<string, { tenthsPerDamage: number; re: RegExp; note: string }> = {
    attack: { tenthsPerDamage: 40, re: /stat_advance\(attack, scale\(\$multiplier, 1000, scale\(400, 100, \$base\)\)\)/, note: 'accurate style, 4 XP per damage' },
    strength: { tenthsPerDamage: 40, re: /stat_advance\(strength, scale\(\$multiplier, 1000, scale\(400, 100, \$base\)\)\)/, note: 'aggressive style, 4 XP per damage' },
    defence: { tenthsPerDamage: 40, re: /stat_advance\(defence, scale\(\$multiplier, 1000, scale\(400, 100, \$base\)\)\)/, note: 'defensive style, 4 XP per damage' },
    ranged: { tenthsPerDamage: 40, re: /stat_advance\(ranged, scale\(\$multiplier, 1000, scale\(400, 100, \$base\)\)\)/, note: 'accurate or rapid style, 4 XP per damage' },
    hitpoints: { tenthsPerDamage: 13.3, re: /stat_advance\(hitpoints, scale\(\$multiplier, 1000, scale\(133, 100, \$base\)\)\)/, note: 'any style, 1.33 XP per damage' },
};
function targetFacts(c: Content, r: ModelInput): Facts {
    const npc = r.npc ? c.npc(r.npc) : undefined;
    const hp = prop(npc, 'hitpoints');
    const mult = param(npc, 'combat_xp_multiplier');
    const def = find(c, FILES.combatParam, /^default=(\d+)/, 'combat_xp_multiplier');
    const rule = COMBAT_XP[r.skill];
    const line = rule ? find(c, FILES.combat, rule.re, 'give_combat_experience') : null;
    const gaps = ['ticks per kill unknown: they need max hit and hit chance (player_melee.rs2, player_ranged.rs2), which depend on levels and gear'];
    if (!hp || !rule || !line) return facts({ gaps: [hp ? `combat XP rule not found for ${r.skill}` : `hitpoints not found for npc ${r.npc}`, ...gaps] });
    const m = Number(mult?.value ?? def?.m[1] ?? 1000);
    const xp = Math.round(Number(hp.value) * rule.tenthsPerDamage * m / 1000) / 10;
    return facts({ xpPerAction: xp, xpSrc: hp.src, xpNote: `XP per kill: hitpoints ${hp.value} x ${rule.note} (${line.src}) x multiplier ${m}/1000 (${mult?.src ?? def?.src ?? 'default'})`, gaps });
}
