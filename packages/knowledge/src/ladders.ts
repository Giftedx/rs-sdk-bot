// Method ladders for the 19 skills, built from knowledge/*.json and the pinned game content, plus the worker that performs each rung.
// Usage: bun packages/knowledge/src/ladders.ts   writes knowledge/ladders.json and knowledge/ladder-gaps.md.
// xpPerAction is base content XP per action (the server multiplier is not applied). xpPerTick comes only from rates.json.
// ticksPerAction and modelXpPerTick come from the content model in method-model.ts and are never measured rates.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { knowledgeDir } from './paths';
import { coordTile, loadContent, modelBands, modelRung, modelXpPerTickAt, statRandomChance, ticksPerSuccess, XP_RATE, XP_RATE_SRC, type Band, type Content, type Row, type Timing } from './method-model';

export const SKILLS = ['attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic', 'cooking', 'woodcutting',
    'fletching', 'fishing', 'firemaking', 'crafting', 'smithing', 'mining', 'herblore', 'agility', 'thieving', 'runecraft'] as const;
export type SkillName = typeof SKILLS[number];

interface SkillAction { skill: string; table: string; row: string; level: number; xp: number | null; inputs: string[]; outputs: string[]; at: { locs?: string[]; npcs?: string[] }; src: Record<string, string> }
interface Item { id: number; name: string; debugname: string; members?: boolean; src: string }
interface Spawn { x: number; z: number; level: number; src: string }
interface Npc { id: number; name: string; debugname: string; combat: number; src: string; spawns: Spawn[] }
interface Shop { inv: string; stock: { item: string }[] }
interface DbRow { name: string; data: Record<string, string[][]>; src: Record<string, string[]>; def: string }
interface DbTable { table: string; rows: DbRow[] }
interface Quest { varp: string; folder: string | null }
interface Rate { method: string; skill: string; level: number; xpPerTick: number; evidence: string }
interface Capability { id: string; goal?: string; entry: string; consumer?: string }

export interface Data {
    skills: SkillAction[]; items: Item[]; npcs: Npc[]; shops: Shop[]; dbtables: DbTable[]; quests: Quest[]; rates: Rate[]; drops: unknown[];
    capabilities: Capability[]; readFile: (repoPath: string) => string | null; content: Content;
}

export interface ItemRef { id: number | null; debugname: string | null; name: string; count: number | null; shops: string[] }
export interface Method {
    id: string; skill: SkillName; level: number; kind: string; label: string;
    xpPerAction: number | null; inputs: ItemRef[]; outputs: ItemRef[]; requires: ItemRef[];
    where: { locs: string[]; npcs: string[]; tiles?: { npc: string; spawns: number; sample: Spawn[] }[] } | null;
    tools: ItemRef[];
    xpSrc: string | null; xpNote: string | null;
    ticksPerAction: number | null; timing: Timing | null;
    modelXpPerTick: number | null; modelXpPerTick99: number | null; modelBands: Band[];
    enables: { feeds: string[]; teleport: { x: number; z: number; level: number; src: string } | null };
    inputsBuyable: boolean | null; members: boolean | null;
    quest: { name: string; varp: string | null; src: string } | null;
    xpPerTick: number | null; rateMethod: string | null;
    worker: string | null; workers: string[]; workerEvidence: string | null; pendingCapability: string | null;
    source: string; src: string; gaps: string[];
    combat?: number; spawns?: number; targetBasis?: string;
}

// rates.json method -> ladder method id. Each pair is checked for skill and level below.
const RATE_METHODS: Record<string, string> = {
    pickpocket_man: 'thieving/pickpocket_man',
    mine_copper: 'mining/copper_rock_table',
    craft_air_runes_trade_loop: 'runecraft/runecraft_air',
    cut_dragonstone_trade_loop: 'crafting/dragonstone_cutting',
    pickpocket_guard: 'thieving/pickpocket_guard',
    pickpocket_knight: 'thieving/pickpocket_knight_of_ardougne',
};

// Skill guide rows that add rungs the skill dbtables in skills.json do not hold.
const GUIDES: { row: string; skill: SkillName; kind: string; skip?: RegExp }[] = [
    { row: 'skill_guide_combat_attack', skill: 'attack', kind: 'weapon-gear' },
    { row: 'skill_guide_combat_defence', skill: 'defence', kind: 'armour-gear' },
    { row: 'skill_guide_ranged_bows', skill: 'ranged', kind: 'bow-gear' },
    { row: 'skill_guide_ranged_thrown', skill: 'ranged', kind: 'thrown-gear' },
    { row: 'skill_guide_agility_agility', skill: 'agility', kind: 'course' },
    { row: 'skill_guide_herblore_herbs', skill: 'herblore', kind: 'identify' },
    { row: 'skill_guide_herblore_potions', skill: 'herblore', kind: 'potion' },
    { row: 'skill_guide_crafting_spinning', skill: 'crafting', kind: 'spin' },
    { row: 'skill_guide_crafting_pottery', skill: 'crafting', kind: 'pottery' },
    { row: 'skill_guide_crafting_glass', skill: 'crafting', kind: 'glass' },
    { row: 'skill_guide_crafting_jewellery', skill: 'crafting', kind: 'jewellery', skip: /^Cut / }, // gem cutting is in skills.json
    { row: 'skill_guide_crafting_staffs', skill: 'crafting', kind: 'staff' },
    { row: 'skill_guide_smithing_smelting', skill: 'smithing', kind: 'smelt' },
    { row: 'skill_guide_fishing_catches', skill: 'fishing', kind: 'catch' },
    { row: 'skill_guide_cooking_wine', skill: 'cooking', kind: 'wine' },
    { row: 'skill_guide_firemaking_firemaking', skill: 'firemaking', kind: 'burn' },
];
// Guide rows covered by skills.json; scanned only for quest requirements.
const COVERED_GUIDES = ['skill_guide_mining_ores', 'skill_guide_runecrafting_runecrafting'];

const MELEE: SkillName[] = ['attack', 'strength', 'defence', 'hitpoints'];
const TARGET_SKILLS: SkillName[] = [...MELEE, 'ranged'];
// Monsters a combat worker fights by name; added as target rungs next to the band representatives.
const WORKER_TARGETS = ['chicken', 'cow', 'chaos_druid'];

// Worker rules. A rule applies only when `evidence` is a literal substring of the worker's file (the capability entry,
// or the capability JSON for a pending one). Capabilities come first: they carry acceptance.
interface Rule { worker: string; evidence: string; methods: RegExp }
const RULES: Rule[] = [
    { worker: 'cap:agility-order', evidence: 'gnome:{', methods: /^agility\/course-gnome-stronghold-agility-course$/ },
    { worker: 'cap:agility-order', evidence: "'barbarian'", methods: /^agility\/course-barbarian-outpost-agility-course$/ },
    { worker: 'cap:agility-order', evidence: "'wilderness'", methods: /^agility\/course-wilderness-course$/ },
    { worker: 'cap:firemaking-order', evidence: 'banked normal logs', methods: /^firemaking\/burn-normal-logs$/ },
    { worker: 'cap:magic-order', evidence: 'casts wind strike', methods: /^magic\/magic_spell_wind_strike$/ },
    { worker: 'cap:wine-order', evidence: 'wine', methods: /^cooking\/wine-wine$/ },
    { worker: 'cap:rune-bank-craft', evidence: 'AIR=556', methods: /^runecraft\/runecraft_air$/ },
    { worker: 'cap:fresh-rune-supply-order', evidence: 'gather-essence', methods: /^(runecraft\/runecraft_air|mining\/rune_essence_table)$/ },
    { worker: 'cap:goldfarm-order', evidence: 'pickpocket knights of Ardougne', methods: /^thieving\/pickpocket_knight_of_ardougne$/ },
    { worker: 'cap:shark-supply-order', evidence: 'shark', methods: /^(fishing\/catch-shark|cooking\/cooking_generic_shark)$/ },
    { worker: 'cap:iron-progress-order', evidence: "BAR_TYPE: iron", methods: /^smithing\/smelt-iron$/ },
    { worker: 'cap:cow-progress-order', evidence: 'cowTraining', methods: /^(attack|strength|defence|hitpoints)\/target-cow$/ },
    { worker: 'cap:cow-progress-order', evidence: '/^chaos druid$/i', methods: /^(attack|strength|defence|hitpoints)\/target-chaos_druid$/ },
    { worker: 'cap:ranged-train', evidence: 'export const BOWS=[', methods: /^ranged\/bow-gear-(standard-bows|oak-bows|willow-bows|maple-bows|yew-bows|magic-bows)$/ },
    { worker: 'cap:ranged-train', evidence: 'Lumbridge chickens', methods: /^(ranged|hitpoints)\/target-chicken$/ },
    { worker: 'scripts/gather-yews.ts', evidence: "'yew'", methods: /^woodcutting\/(normal|oak|yew)_tree_table$/ },
    { worker: 'scripts/wc-loop.ts', evidence: 'chopTree(/^tree$/i)', methods: /^woodcutting\/normal_tree_table$/ },
    { worker: 'scripts/gather-ore.ts', evidence: "copper: [2090", methods: /^mining\/(copper|tin|iron|clay)_rock_table$/ },
    { worker: 'scripts/gather-essence.ts', evidence: 'RUNE_ESSENCE = 1436', methods: /^mining\/rune_essence_table$/ },
    { worker: 'scripts/goldfarm.ts', evidence: 'pickpocket knights of Ardougne', methods: /^thieving\/pickpocket_knight_of_ardougne$/ },
    { worker: 'scripts/craft-jewelry.ts', evidence: 'TIER: sapphire | emerald | ruby | diamond | dragonstone', methods: /^(crafting\/(sapphire|emerald|ruby|diamond|dragonstone)_cutting|crafting\/jewellery-(sapphire|emerald|ruby|diamond|dragonstone)-ring|magic\/magic_spell_enchant_level[1-5])$/ },
    { worker: 'scripts/spin-bowstrings.ts', evidence: 'spins flax into bow strings', methods: /^crafting\/spin-flax-into-bow-strings$/ },
    { worker: 'scripts/collect-wool.ts', evidence: 'spin the rest', methods: /^crafting\/spin-wool$/ },
    { worker: 'scripts/fletch-arrows.ts', evidence: 'TIP_TYPE: rune | adamant | mithril | steel', methods: /^fletching\/fletching_(steel|mithril|adamant|rune)_arrow$/ },
    { worker: 'scripts/fletch-arrows.ts', evidence: 'OAK_BOW = 845', methods: /^fletching\/stringing_oak_longbow$/ },
    { worker: 'scripts/smelt-bars.ts', evidence: 'BAR_TYPE: iron | bronze | steel | gold | mithril', methods: /^smithing\/smelt-(bronze|iron|steel|gold|mithril)$/ },
    { worker: 'scripts/smelt-batch.ts', evidence: "['iron','steel','gold','mithril']", methods: /^smithing\/smelt-(iron|steel|gold|mithril)$/ },
    { worker: 'scripts/cook-food.ts', evidence: 'FOOD_TYPE: lobster | swordfish | trout | salmon | shark', methods: /^cooking\/cooking_generic_(lobster|swordfish|trout|salmon|shark)$/ },
    { worker: 'scripts/cook-stock.ts', evidence: 'Cook banked trout/salmon', methods: /^cooking\/cooking_generic_(trout|salmon)$/ },
    { worker: 'scripts/fishcook.ts', evidence: 'Fly fishes trout and salmon', methods: /^(fishing\/catch-(trout|salmon)|cooking\/cooking_generic_(trout|salmon))$/ },
    { worker: 'scripts/fishcook.ts', evidence: 'raw chicken', methods: /^cooking\/cooking_generic_chicken$/ },
    { worker: 'scripts/gather-fish.ts', evidence: 'Lobsters (Cage) or Swordfish/Tuna (Harpoon)', methods: /^fishing\/catch-(lobster|swordfish|tuna)$/ },
    { worker: 'scripts/gather-fish.ts', evidence: 'export function sharkSpot', methods: /^fishing\/catch-shark$/ },
    { worker: 'scripts/brew-potions.ts', evidence: 'super_def:', methods: /^herblore\/potion-(prayer-restore-potion|super-attack-potion|super-strength-potion|super-defence-potion|energy-potion)$/ },
    { worker: 'scripts/train-prayer.ts', evidence: 'BONE=526', methods: /^prayer\/bury-bones$/ },
    { worker: 'scripts/train-chickens.ts', evidence: 'Train on Lumbridge chickens', methods: /^(attack|strength|defence|hitpoints)\/target-chicken$/ },
    { worker: 'scripts/gather-combat.ts', evidence: '/^chaos druid$/i', methods: /^(attack|strength|defence|hitpoints)\/target-chaos_druid$/ },
    { worker: 'scripts/gather-ranged.ts', evidence: 'BOW=841', methods: /^(ranged\/bow-gear-standard-bows|ranged\/target-chicken)$/ },
];

const round = (v: number | null) => v === null ? null : Math.round(v * 100) / 100;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const clean = (s: string) => s.replace(/\\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
const cell = (row: DbRow | undefined, col: string) => row?.data[col]?.[0];
const bool = (v: string | undefined) => v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : null;

export function buildLadders(d: Data) {
    const byDebug = new Map(d.items.map(i => [i.debugname, i]));
    // Name key: lower case, no "(3)" dose suffix, letters and digits only. The lowest item id wins a shared name.
    const nameKey = (s: string) => s.toLowerCase().replace(/\(\d\)$/, '').replace(/[^a-z0-9]/g, '');
    const byName = new Map<string, Item>();
    for (const i of [...d.items].sort((a, b) => a.id - b.id)) if (!byName.has(nameKey(i.name))) byName.set(nameKey(i.name), i);
    const shopsOf = new Map<string, string[]>();
    for (const s of d.shops) for (const st of s.stock) { const l = shopsOf.get(st.item) ?? []; if (!l.includes(s.inv)) l.push(s.inv); shopsOf.set(st.item, l); }
    const table = (name: string) => d.dbtables.find(t => t.table === name);
    const dbRow = (t: string, r: string) => table(t)?.rows.find(x => x.name === r);
    const questByName = (name: string) => {
        const k = name.toLowerCase().replace(/[^a-z]/g, '');
        return d.quests.find(q => (q.folder ?? '').replace(/^quest_/, '') === k || q.varp === k)?.varp ?? null;
    };
    const ref = (debugname: string, count: number | null = null): ItemRef => {
        const it = byDebug.get(debugname);
        return { id: it?.id ?? null, debugname, name: it?.name ?? debugname, count, shops: shopsOf.get(debugname) ?? [] };
    };
    const refByName = (names: string[], label: string): ItemRef => {
        const tries = names.flatMap(n => [n, n.replace(/ potion$/i, ''), n.replace(/s$/, '')]);
        for (const n of tries) { const it = byName.get(nameKey(n)); if (it) return { ...ref(it.debugname), name: it.name }; }
        return { id: null, debugname: null, name: label, count: null, shops: [] };
    };
    const buyable = (inputs: ItemRef[]) => inputs.length === 0 ? null : inputs.every(i => i.shops.length > 0);
    const base = (o: Partial<Method> & Pick<Method, 'id' | 'skill' | 'level' | 'kind' | 'label' | 'source' | 'src'>): Method => ({
        xpPerAction: null, inputs: [], outputs: [], requires: [], where: null, inputsBuyable: null, members: null, quest: null,
        tools: [], xpSrc: null, xpNote: null, ticksPerAction: null, timing: null, modelXpPerTick: null, modelXpPerTick99: null, modelBands: [],
        enables: { feeds: [], teleport: null },
        xpPerTick: null, rateMethod: null, worker: null, workers: [], workerEvidence: null, pendingCapability: null, gaps: [], ...o,
    });
    const methods: Method[] = [];
    const notes: string[] = [];

    // 1. skills.json rows.
    let zeroXp = 0, npcSpells = 0;
    for (const a of d.skills) {
        if (!(SKILLS as readonly string[]).includes(a.skill)) continue;
        if (a.skill === 'magic' && a.level <= 0) { npcSpells++; continue; }
        if (a.xp === 0) { zeroXp++; continue; }
        const row = dbRow(a.table, a.row);
        let inputs = a.inputs.map(n => ref(n));
        const requires: ItemRef[] = [];
        const gaps: string[] = [];
        if (a.table === 'magic_spell_table') {
            const runes = cell(row, 'runesrequired') ?? [];
            inputs = [];
            for (let i = 0; i + 1 < runes.length; i += 2) if (runes[i] !== 'null') inputs.push(ref(runes[i]!, Number(runes[i + 1])));
            for (const w of cell(row, 'wornrequired') ?? []) if (w !== 'null') requires.push(ref(w));
            if (!inputs.length) gaps.push('runes not listed in magic_spell_table');
        }
        if (a.table === 'runecraft_table') {
            const t = cell(row, 'talisman')?.[0];
            if (t && t !== 'null') requires.push(ref(t));
        }
        const where = { locs: a.at.locs ?? [], npcs: a.at.npcs ?? [] };
        methods.push(base({
            id: `${a.skill}/${a.row}`, skill: a.skill as SkillName, level: Math.max(1, a.level), kind: a.table, label: a.row.replace(/_/g, ' '),
            xpPerAction: a.xp, xpSrc: a.src.xp ?? null, inputs, outputs: a.outputs.map(n => ref(n)), requires,
            where: where.locs.length || where.npcs.length ? where : null,
            inputsBuyable: buyable(inputs), members: bool(cell(row, 'members')?.[0]),
            source: 'knowledge/skills.json', src: a.src.row ?? a.src.level ?? Object.values(a.src)[0] ?? '', gaps,
        }));
    }
    notes.push(`skills.json rows left out: ${zeroXp} with 0 XP per action, ${npcSpells} NPC-only spells (level 0).`);

    // 2. Skill guide rungs.
    const guides = table('skill_guides');
    const quests: { name: string; target: string; src: string }[] = [];
    for (const g of GUIDES) {
        const row = guides?.rows.find(r => r.name === g.row);
        if (!row) { notes.push(`guide row ${g.row} not in dbtables.json`); continue; }
        let gate: Method['quest'] = null;
        row.data.unlock!.forEach((u, i) => {
            const src = row.src.unlock![i]!;
            const text = clean(u[1] ?? ''), level = Number(u[0]);
            const q = /You must complete the (.+?) quest/.exec(text);
            if (q) { gate = { name: q[1]!, varp: questByName(q[1]!), src }; return; }
            const members = /^Members:/.test(text);
            const body = text.replace(/^Members:\s*/, '');
            if (level < 1 || !body || (g.skip && g.skip.test(body))) return;
            let head = body.split(/ - |\. Ammo:|\.$/)[0]!.replace(/\.$/, '').trim();
            let inputs: ItemRef[] = [], outputs: ItemRef[] = [];
            const gaps: string[] = [];
            if (g.kind === 'catch') outputs = [refByName([`Raw ${head}`, `Raw ${head}s`, head], head)];
            else if (g.kind === 'burn') inputs = [refByName([head, head.replace(/^Normal /, '')], head)];
            else if (g.kind === 'smelt') outputs = [refByName([`${head} bar`, `${head.replace(/^Adamant$/, 'Adamantite')} bar`], `${head} bar`)];
            else if (g.kind === 'spin') {
                const m = /^(.+?) into (.+)$/.exec(head);
                inputs = [refByName([m ? m[1]! : head], m ? m[1]! : head)];
                if (m) outputs = [refByName([m[2]!, m[2]!.replace(/s$/, ''), m[2]!.replace(/ strings$/, ' string')], m[2]!)];
            } else if (g.kind === 'potion') {
                const name = /^(.*?(?:potion|poison)) (?=[A-Z])/.exec(body)?.[1] ?? body;
                const parts = body.slice(name.length).replace(/\.$/, '').split('&').map(s => s.trim()).filter(Boolean);
                head = name;
                // "Ground X" is the ground form: try "X dust" only, never the unground item.
                inputs = parts.map(p => refByName(/^Ground /.test(p) ? [p, `${p.replace(/^Ground /, '')} dust`, `${p.replace(/^Ground (blue |green |red |black )?/, '')} dust`] : [p], p));
                outputs = [refByName([`${name}(3)`, name], name)];
            } else if (g.kind === 'identify') {
                const herb = refByName([head], head);
                const word = head.toLowerCase().split(/[^a-z]/)[0]!;
                const grimy = byDebug.get(`unidentified_${word}`);
                inputs = grimy ? [ref(grimy.debugname)] : [{ id: null, debugname: null, name: `unidentified ${head}`, count: null, shops: [] }];
                outputs = [herb];
            } else if (['pottery', 'glass', 'jewellery', 'staff', 'wine'].includes(g.kind)) outputs = [refByName([head, `Jug of ${head.toLowerCase()}`], head)];
            for (const r of [...inputs, ...outputs]) if (r.id === null) gaps.push(`item "${r.name}" not resolved in knowledge/items.json`);
            methods.push(base({
                id: `${g.skill}/${g.kind}-${slug(head)}`, skill: g.skill, level, kind: g.kind, label: head, inputs, outputs,
                inputsBuyable: buyable(inputs), members, quest: gate, source: 'knowledge/dbtables.json#skill_guides', src, gaps,
            }));
        });
    }
    for (const r of COVERED_GUIDES) {
        const row = guides?.rows.find(x => x.name === r);
        row?.data.unlock!.forEach((u, i) => {
            const m = /^(.+?) \(after completing (.+?)\)/.exec(clean(u[1] ?? ''));
            if (m) quests.push({ name: m[2]!, target: m[1]!, src: row.src.unlock![i]! });
        });
    }
    for (const q of quests) for (const m of methods) if (m.outputs.some(o => o.name.toLowerCase() === q.target.toLowerCase()))
        m.quest = { name: q.name, varp: questByName(q.name), src: q.src };

    // 3. Prayer: bones items, with the drop tables that give them.
    const dropSources = new Map<string, string[]>();
    const walk = (v: unknown, trigger: string) => {
        if (Array.isArray(v)) { v.forEach(x => walk(x, trigger)); return; }
        if (v && typeof v === 'object') {
            const o = v as Record<string, unknown>;
            if (typeof o.item === 'string') { const l = dropSources.get(o.item) ?? []; if (!l.includes(trigger)) l.push(trigger); dropSources.set(o.item, l); }
            Object.values(o).forEach(x => walk(x, trigger));
        }
    };
    for (const t of d.drops as { trigger: string }[]) walk(t, t.trigger);
    for (const it of d.items.filter(i => i.src.startsWith('scripts/skill_prayer/configs/bones.obj'))) {
        const input = ref(it.debugname, 1);
        const drops = dropSources.get(it.debugname) ?? [];
        methods.push(base({
            id: `prayer/bury-${it.debugname}`, skill: 'prayer', level: 1, kind: 'bury', label: `bury ${it.name}`, inputs: [input],
            inputsBuyable: buyable([input]), members: it.members ?? null, where: drops.length ? { locs: [], npcs: drops.slice(0, 12) } : null,
            source: 'knowledge/items.json', src: it.src,
            gaps: [],
        }));
    }

    // 4. Combat targets: the most-spawned monster per 10-level combat band (101+ is one band), plus worker targets.
    const live = d.npcs.filter(n => n.combat > 0 && n.spawns.length > 0);
    const bands = new Map<number, Npc>();
    for (const n of live) {
        const b = n.combat > 100 ? 10 : Math.floor((n.combat - 1) / 10);
        const cur = bands.get(b);
        if (!cur || n.spawns.length > cur.spawns.length || (n.spawns.length === cur.spawns.length && n.id < cur.id)) bands.set(b, n);
    }
    const targets = new Map<string, { npc: Npc; basis: string }>();
    for (const n of bands.values()) targets.set(n.debugname, { npc: n, basis: 'most spawns in its 10-level combat band' });
    for (const dn of WORKER_TARGETS) { const n = live.find(x => x.debugname === dn); if (n && !targets.has(dn)) targets.set(dn, { npc: n, basis: 'named by a combat worker' }); }
    for (const skill of TARGET_SKILLS) for (const { npc, basis } of targets.values()) methods.push(base({
        id: `${skill}/target-${npc.debugname}`, skill, level: 1, kind: 'target', label: `fight ${npc.name} (combat ${npc.combat})`,
        where: { locs: [], npcs: [npc.debugname] }, source: 'knowledge/npcs.json', src: npc.src, combat: npc.combat, spawns: npc.spawns.length, targetBasis: basis,
        gaps: [],
    }));
    notes.push('Strength and Hitpoints have no skill guide gear rows; their ladders hold only combat targets.');
    notes.push('Magic combat spells need a target; pick one from the Attack ladder targets.');
    notes.push('Prayer prayers (prayers dbtable) are unlocks, not XP methods, and are left out.');
    notes.push('Prayer bones and combat targets have no level gate in the content; their rungs start at level 1.');

    // 4b. Knife on logs: arrow shafts and unstrung bows (fletch_bow_table: level and XP per product).
    for (const row of table('fletch_bow_table')?.rows ?? []) {
        const log = cell(row, 'log')?.[0];
        if (!log) continue;
        const shafts = Number(cell(row, 'shafts')?.[0] ?? 0);
        const choices: { level: number; xp: number; product: string; count: number; src: string }[] = [];
        if (shafts > 0) choices.push({ level: 1, xp: shafts * 5 / 10, product: 'arrow_shaft', count: shafts, src: row.src.shafts![0]! });
        for (const k of ['shortbow', 'longbow']) {
            const v = cell(row, k);
            if (v) choices.push({ level: Number(v[1]), xp: Number(v[2]) / 10, product: v[0]!, count: 1, src: row.src[k]![0]! });
        }
        for (const ch of choices) {
            const inputs = [ref(log, 1)];
            methods.push(base({
                id: `fletching/cut-${ch.product}`, skill: 'fletching', level: ch.level, kind: 'fletch_bow', label: `cut ${ref(log).name} into ${ref(ch.product).name}`,
                xpPerAction: ch.xp, xpSrc: ch.src, xpNote: ch.product === 'arrow_shaft' ? `${ch.count} shafts x 0.5 XP (scripts/skill_fletching/scripts/cut_logs.rs2 multiply($shaft_count, 5))` : null,
                inputs, outputs: [ref(ch.product, ch.count)], tools: [ref('knife')], inputsBuyable: buyable(inputs),
                source: 'knowledge/dbtables.json#fletch_bow_table', src: row.def,
            }));
        }
    }

    // 4c. Content model: XP, timing, items and tools per action (method-model.ts).
    const rowOf = (t: string, r: string): Row | undefined => dbRow(t, r);
    const skillRow = new Map(d.skills.map(a => [`${a.skill}/${a.row}`, a]));
    for (const m of methods) {
        const a = skillRow.get(m.id);
        const f = modelRung(d.content, {
            id: m.id, skill: m.skill, kind: m.kind, level: m.level, label: m.label, row: a ? rowOf(a.table, a.row) ?? null : null,
            outputs: m.outputs.map(o => o.debugname).filter((x): x is string => !!x), inputs: m.inputs.map(i => i.debugname).filter((x): x is string => !!x),
            npc: m.kind === 'target' ? m.where?.npcs[0] : undefined,
        });
        if (f.xpPerAction !== null) { m.xpPerAction = f.xpPerAction; m.xpSrc = f.xpSrc; }
        m.xpNote = f.xpNote ?? m.xpNote;
        if (f.inputs && m.kind !== 'magic_spell_table') { m.inputs = f.inputs.map(i => ref(i.debugname, i.count)); m.inputsBuyable = buyable(m.inputs); }
        if (f.outputs) m.outputs = f.outputs.map(o => ref(o.debugname, o.count));
        if (f.tools.length) m.tools = f.tools.map(t => ref(t));
        m.timing = f.timing;
        m.ticksPerAction = f.timing ? round(ticksPerSuccess(f.timing, m.level)) : null;
        m.modelXpPerTick = modelXpPerTickAt(m.xpPerAction, f.timing, m.level);
        m.modelXpPerTick99 = modelXpPerTickAt(m.xpPerAction, f.timing, 99);
        m.modelBands = modelBands(m.xpPerAction, f.timing, m.level);
        // Chance per roll at the unlock level and at 99 (null where the tool is not usable yet).
        if (m.timing) m.timing.rolls = m.timing.rolls.map(r => {
            const at = (l: number) => r.toolLevel > l ? null : round(r.fixedChance ?? statRandomChance(l, r.low!, r.high!));
            return { ...r, chanceAtUnlock: at(m.level), chanceAt99: at(99) };
        });
        if (a?.table === 'magic_spell_table') {
            const tc = cell(rowOf(a.table, a.row) as DbRow | undefined, 'tele_coord')?.[0], tile = tc ? coordTile(tc) : null;
            if (tile) m.enables.teleport = { ...tile, src: (rowOf(a.table, a.row) as DbRow).src.tele_coord![0]! };
        }
        // Item gaps are re-derived from the items the rung holds after the model.
        m.gaps = m.gaps.filter(g => !/^item ".*" not resolved/.test(g));
        for (const it of [...m.inputs, ...m.outputs]) if (it.id === null) m.gaps.push(`item "${it.name}" not resolved in knowledge/items.json`);
        m.gaps.push(...f.gaps);
        if (m.xpPerAction === null && !/gear$/.test(m.kind) && !f.gaps.some(g => /XP/.test(g))) m.gaps.push('XP per action unknown: no content value mapped for this rung');
        if (m.ticksPerAction === null && !f.gaps.some(g => /ticks/.test(g)) && !/gear$/.test(m.kind)) m.gaps.push('ticks per action unknown: no timing model for this rung');
        if (m.where?.npcs.length) {
            m.where.tiles = m.where.npcs.map(n => d.npcs.find(x => x.debugname === n)).filter((n): n is Npc => !!n && n.spawns.length > 0)
                .map(n => ({ npc: n.debugname, spawns: n.spawns.length, sample: n.spawns.slice(0, 3) }));
        }
    }

    // 4d. What each rung enables: rungs that consume its outputs as inputs or tools.
    const usedBy = new Map<string, string[]>();
    for (const m of methods) for (const it of [...m.inputs, ...m.tools, ...m.requires]) if (it.debugname) usedBy.set(it.debugname, [...(usedBy.get(it.debugname) ?? []), m.id]);
    for (const m of methods) m.enables.feeds = [...new Set(m.outputs.flatMap(o => o.debugname ? usedBy.get(o.debugname) ?? [] : []))].filter(id => id !== m.id).sort();

    // 5. Rates.
    const byId = new Map(methods.map(m => [m.id, m]));
    for (const r of d.rates) {
        const m = byId.get(RATE_METHODS[r.method] ?? '');
        if (!m || m.skill !== r.skill || r.level < m.level) { notes.push(`rate ${r.method} not mapped to a ladder method`); continue; }
        m.xpPerTick = r.xpPerTick; m.rateMethod = r.method;
    }

    // 6. Workers.
    const caps = new Map(d.capabilities.map(c => [c.id, c]));
    const unused: string[] = [];
    for (const rule of RULES) {
        let file: string | null, worker: string | null = rule.worker, pending: string | null = null;
        if (rule.worker.startsWith('cap:')) {
            const c = caps.get(rule.worker.slice(4));
            if (!c) { unused.push(`${rule.worker}: capability missing`); continue; }
            const entry = d.readFile(c.entry);
            if (entry === null) { pending = c.id; worker = null; file = JSON.stringify(c); }
            else { worker = c.id; file = entry + '\n' + JSON.stringify(c); }
        } else file = d.readFile(rule.worker);
        if (file === null || !file.includes(rule.evidence)) { unused.push(`${rule.worker}: evidence ${JSON.stringify(rule.evidence)} not found`); continue; }
        const hits = methods.filter(m => rule.methods.test(m.id));
        if (!hits.length) unused.push(`${rule.worker}: pattern ${rule.methods} matched no method`);
        for (const m of hits) {
            if (pending) { m.pendingCapability ??= pending; continue; }
            if (!m.workers.includes(worker!)) m.workers.push(worker!);
            if (!m.worker) { m.worker = worker; m.workerEvidence = `${rule.worker.startsWith('cap:') ? caps.get(worker!)!.entry : rule.worker} contains ${JSON.stringify(rule.evidence)}`; }
        }
    }
    for (const u of unused) notes.push(`worker rule unused: ${u}`);

    const ladders = {} as Record<SkillName, Method[]>;
    for (const s of SKILLS) ladders[s] = methods.filter(m => m.skill === s)
        .sort((a, b) => a.level - b.level || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const counts = Object.fromEntries(SKILLS.map(s => [s, {
        methods: ladders[s].length, withWorker: ladders[s].filter(m => m.worker).length,
        withXp: ladders[s].filter(m => m.xpPerAction !== null).length, withTicks: ladders[s].filter(m => m.ticksPerAction !== null).length,
        withGaps: ladders[s].filter(m => m.gaps.length).length,
    }]));
    return {
        generatedBy: 'bun packages/knowledge/src/ladders.ts',
        xpNote: 'xpPerAction is base content XP per action (one script run; arrows make 15, runecraft uses 27 essence); the server multiplier is not applied. xpPerTick is set only from knowledge/rates.json (measured).',
        modelNote: `ticksPerAction is the expected ticks per successful action at the unlock level, from script timing and success rolls (timing.src). modelXpPerTick = xpPerAction x ${XP_RATE} (${XP_RATE_SRC}) / ticksPerAction at the unlock level; modelXpPerTick99 is the same at level 99; modelBands gives the model from the unlock level to 99, split every 10 levels and where the best tool changes, and timing.rolls[].chanceAtUnlock / chanceAt99 give each stat_random chance. All are derived, never measured, and exclude banking, walking, resupply and level-up dialogs.`,
        enablesNote: 'enables.feeds lists rungs that use this rung output as an input, tool or requirement; enables.teleport is the spell destination (magic_spell_table tele_coord). Tool tiers are the toolLevel of each roll in timing.rolls.',
        counts, notes, ladders,
    };
}

export function gapsMarkdown(out: ReturnType<typeof buildLadders>): string {
    const all = SKILLS.flatMap(s => out.ladders[s]);
    const lines = ['# Ladder gaps', '',
        'Generated by `bun packages/knowledge/src/ladders.ts` from `knowledge/*.json` and `vendor/rs-sdk/server/content`. Do not edit by hand.', '',
        `## Method data gaps (${all.filter(m => m.gaps.length).length} of ${all.length} rungs)`, '',
        'Each line is a rung that misses a method fact, and names the missing fact. A rung not listed has XP per action, ticks per action, items and a source line for each.', ''];
    for (const s of SKILLS) {
        const rungs = out.ladders[s], missing = rungs.filter(m => m.gaps.length);
        lines.push(`### ${s[0]!.toUpperCase()}${s.slice(1)} (${missing.length} of ${rungs.length} rungs)`, '');
        for (const m of missing) lines.push(`- L${m.level} ${m.label} \`${m.id}\`: ${m.gaps.join('; ')}`);
        lines.push('');
    }
    lines.push(`## Rungs with no worker (${all.filter(m => !m.worker).length} of ${all.length})`, '',
        'Each line: unlock level, method, base XP per action, ticks per action, model XP per tick at the unlock level (25x, derived), source. A pending capability has a definition and no entry script.', '');
    for (const s of SKILLS) {
        const rungs = out.ladders[s], gaps = rungs.filter(m => !m.worker);
        lines.push(`### ${s[0]!.toUpperCase()}${s.slice(1)} (${gaps.length} of ${rungs.length} rungs have no worker)`, '');
        for (const m of gaps) {
            const xp = m.xpPerAction === null ? 'XP unknown' : `${m.xpPerAction} XP`;
            const ticks = m.ticksPerAction === null ? 'ticks unknown' : `${m.ticksPerAction} ticks`;
            const model = m.modelXpPerTick === null ? '' : `; model ${m.modelXpPerTick} XP/tick`;
            const pend = m.pendingCapability ? `; pending capability \`${m.pendingCapability}\`` : '';
            lines.push(`- L${m.level} ${m.label} \`${m.id}\`; ${xp}; ${ticks}${model}${pend}; \`${m.source}\` \`${m.src}\``);
        }
        lines.push('');
    }
    return lines.join('\n');
}

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
export function loadData(): Data {
    const k = (f: string) => JSON.parse(readFileSync(join(knowledgeDir(), f), 'utf8'));
    const tasksDir = join(repoRoot, 'packages', 'router', 'tasks');
    const capabilities = (require('node:fs').readdirSync(tasksDir) as string[]).filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(readFileSync(join(tasksDir, f), 'utf8')) as Capability);
    return {
        skills: k('skills.json'), items: k('items.json'), npcs: k('npcs.json'), shops: k('shops.json'), dbtables: k('dbtables.json'),
        quests: k('quests.json'), rates: k('rates.json'), drops: k('drops.json'), capabilities, content: loadContent(),
        readFile: p => { const f = join(repoRoot, p); return existsSync(f) ? readFileSync(f, 'utf8') : null; },
    };
}

if (import.meta.main) {
    const out = buildLadders(loadData());
    writeFileSync(join(knowledgeDir(), 'ladders.json'), JSON.stringify(out, null, 1) + '\n');
    writeFileSync(join(knowledgeDir(), 'ladder-gaps.md'), gapsMarkdown(out));
    for (const s of SKILLS) console.log(`${s.padEnd(12)} methods=${out.counts[s]!.methods} withWorker=${out.counts[s]!.withWorker}`);
    for (const n of out.notes) console.log(`note: ${n}`);
}
