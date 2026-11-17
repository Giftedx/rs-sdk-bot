// Audits knowledge/, packages/dashboard/client-assets/, packages/planner/, packages/router/, packages/practice/, and scripts/
// for strict RS2 Rev 289 (Lost City, January 17, 2005) parity against vendor/rs-sdk/server/content and PlayerStat.ts,
// while preserving rs-sdk's built-in engine Market / Grand Exchange.
// Usage: bun scripts/check-rev289-parity.ts [--strict]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface Rev289Baseline {
    maxObjId: number;
    maxNpcId: number;
    maxLocId: number;
    objById: Map<number, string>;
    objIdsByDebug: Map<string, number>;
    objNames: Set<string>;
    objNameById: Map<number, string>;
    npcById: Map<number, string>;
    npcNames: Set<string>;
    locById: Map<number, string>;
    skills: Set<string>;
    prayers: Set<string>;
    spells: Set<string>;
    questNames: Set<string>;
    specwepDebugs: Set<string>;
}

export interface ParityIssue {
    scope: 'knowledge' | 'client-assets' | 'scripts' | 'planner' | 'router' | 'practice' | 'cross-worker';
    file: string;
    detail: string;
}

export const BANNED_SKILLS = [
    'slayer', 'farming', 'construction', 'hunter', 'sailing',
    'summoning', 'dungeoneering', 'divination', 'invention', 'archaeology', 'necromancy',
] as const;

export const BANNED_PRAYERS = [
    'smite', 'redemption', 'retribution', 'chivalry', 'piety', 'rigour', 'augury',
    'eagle eye', 'hawk eye', 'sharp eye', 'mystic might', 'mystic lore', 'mystic will', 'preserve',
] as const;

export const BANNED_SPELLS = [
    'teleblock', 'tele block', 'ancient magick', 'ice barrage', 'ice blitz', 'ice burst', 'ice rush',
    'blood barrage', 'blood blitz', 'shadow barrage', 'smoke barrage', 'lunar', 'vengeance',
    'arceuus', 'home teleport', 'bones to peaches', 'bolt enchant',
] as const;

export const BANNED_OSRS_BANK_TERMS = [
    'chestplate', 'hauberk', 'tassets', 'defender', 'bracers', 'circlet', 'sallet', 'reward casket', "d'hide vamb",
] as const;

export const BANNED_OSRS_ITEM_IDS = new Map<number, string>([
    [7936, 'Pure essence'],
    [13204, 'Platinum token'],
    [4151, 'Abyssal whip'],
    [4153, 'Granite maul'],
    [6570, 'Fire cape'],
    [6585, 'Amulet of fury'],
    [6685, 'Saradomin brew(4)'],
    [6731, 'Seers ring'],
    [6733, 'Archers ring'],
    [6735, 'Warrior ring'],
    [6737, 'Berserker ring'],
    [7462, 'Barrows gloves'],
    [8850, 'Rune defender'],
    [10551, 'Fighter torso'],
    [10828, 'Helm of neitiznot'],
    [11802, 'Armadyl godsword'],
    [11804, 'Bandos godsword'],
    [11806, 'Saradomin godsword'],
    [11808, 'Zamorak godsword'],
    [11840, 'Dragon boots'],
    [12625, 'Stamina potion(4)'],
    [12695, 'Super combat potion(4)'],
    [12954, 'Dragon defender'],
]);

export const BANNED_OSRS_ITEM_PHRASES = [
    'pure essence', 'platinum token', 'saradomin brew', 'stamina potion', 'super combat',
    'abyssal whip', 'granite maul', 'amulet of fury', 'berserker ring', 'seers ring',
    'archers ring', 'warrior ring', 'fighter torso', 'dragon defender', 'rune defender',
    'dragon boots', 'barrows gloves', 'helm of neitiznot', 'fire cape', 'void knight', 'godsword',
] as const;

const BANNED_SKILL_MATCHERS = BANNED_SKILLS.map(sk => ({
    sk,
    re: new RegExp(`['"\`]${sk}['"\`]|\\b${sk}_(?:lvl|level|xp)\\b`, 'i'),
}));
const BANNED_PRAYER_MATCHERS = BANNED_PRAYERS.map(pr => ({
    pr,
    re: pr === 'preserve' ? /['"`]Preserve['"`]/ : new RegExp(`['"\`]${pr.replace(/\s+/g, '\\s+')}['"\`]`, 'i'),
}));
const BANNED_SPELL_MATCHERS = BANNED_SPELLS.map(sp => ({
    sp,
    re: sp === 'lunar' ? /['"`]Lunar/i : new RegExp(`['"\`]${sp.replace(/\s+/g, '\\s+')}['"\`]`, 'i'),
}));
const BANNED_ITEM_PHRASE_MATCHERS = BANNED_OSRS_ITEM_PHRASES.map(phrase => ({
    phrase,
    re: new RegExp(`\\b${phrase.replace(/\s+/g, '\\s+')}\\b`, 'i'),
}));
const BANNED_ITEM_PHRASES_COMBINED_RE = new RegExp(
    `\\b(?:${BANNED_OSRS_ITEM_PHRASES.map(p => p.replace(/\s+/g, '\\s+')).join('|')})\\b`,
    'i',
);
const BANNED_ITEM_ID_MATCHERS = [...BANNED_OSRS_ITEM_IDS.entries()].map(([id, label]) => ({
    id,
    label,
    re: new RegExp(`\\b${id}\\b`),
}));
const BANNED_ITEM_IDS_COMBINED_RE = new RegExp(`\\b(?:${[...BANNED_OSRS_ITEM_IDS.keys()].join('|')})\\b`);
const COORD_OR_PORT_RE = /\b(?:x|z|worldX|worldZ|port|tick|cap|budget)\b\s*[:=]/;
const NEGATIVE_COMMENT_RE = /^\s*\/\/.*\b(no|absent|off|not in|never|neither|without)\b/i;

// Open holes in files owned by other Wave 2 workers; excluded in default mode and enforced with --strict.
export const KNOWN_CROSS_WORKER_FILES = new Set([
    'scripts/gather-essence.ts',
]);

function walkExt(dir: string, ext: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir).sort()) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walkExt(p, ext, out);
        else if (f.endsWith(ext)) out.push(p);
    }
    return out;
}

function parsePack(path: string): { byId: Map<number, string>; byDebug: Map<string, number>; maxId: number } {
    const byId = new Map<number, string>();
    const byDebug = new Map<string, number>();
    let maxId = -1;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        const id = Number(line.slice(0, idx));
        const dbg = line.slice(idx + 1).trim();
        if (!Number.isSafeInteger(id) || id < 0 || !dbg) continue;
        byId.set(id, dbg);
        byDebug.set(dbg, id);
        if (id > maxId) maxId = id;
    }
    return { byId, byDebug, maxId };
}

/** Loads authoritative Rev 289 baselines directly from vendor/rs-sdk/server/content and PlayerStat.ts. */
export function loadRev289Baseline(repoRoot = resolve(import.meta.dir, '..')): Rev289Baseline {
    const content = join(repoRoot, 'vendor', 'rs-sdk', 'server', 'content');
    const obj = parsePack(join(content, 'pack', 'obj.pack'));
    const npc = parsePack(join(content, 'pack', 'npc.pack'));
    const loc = parsePack(join(content, 'pack', 'loc.pack'));

    const objNames = new Set<string>();
    const objNameById = new Map<number, string>();
    const specwepDebugs = new Set<string>();
    for (const f of walkExt(join(content, 'scripts'), '.obj')) {
        let cur = '';
        for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
            const line = raw.trim();
            const head = /^\[([^\]]+)\]$/.exec(line);
            if (head) { cur = head[1]!; continue; }
            if (!cur) continue;
            if (line.startsWith('name=')) {
                const name = line.slice(5).trim();
                objNames.add(name);
                const id = obj.byDebug.get(cur);
                if (id !== undefined) objNameById.set(id, name);
            } else if (line === 'param=specwep,^true') {
                specwepDebugs.add(cur);
            }
        }
    }
    for (const [id, dbg] of obj.byId) {
        if (!objNameById.has(id)) {
            objNameById.set(id, dbg);
            objNames.add(dbg);
        }
    }

    const npcNames = new Set<string>();
    for (const f of walkExt(join(content, 'scripts'), '.npc')) {
        for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
            const line = raw.trim();
            if (line.startsWith('name=')) npcNames.add(line.slice(5).trim().toLowerCase());
        }
    }
    for (const dbg of npc.byId.values()) npcNames.add(dbg.toLowerCase());

    const playerStatText = readFileSync(join(repoRoot, 'vendor', 'rs-sdk', 'server', 'engine', 'src', 'engine', 'entity', 'PlayerStat.ts'), 'utf8');
    const enumBlock = playerStatText.split('enum PlayerStat {')[1]?.split('}')[0] ?? '';
    const skills = new Set<string>();
    for (const m of enumBlock.matchAll(/\b([A-Z]+)\b/g)) {
        const s = m[1]!.toLowerCase();
        if (s && !s.startsWith('stat')) skills.add(s);
    }

    const prayersText = readFileSync(join(content, 'scripts', 'skill_prayer', 'configs', 'prayers.dbrow'), 'utf8');
    const prayers = new Set<string>();
    for (const m of prayersText.matchAll(/^data=name,(.+)$/gm)) prayers.add(m[1]!.trim().toLowerCase());

    const magicIf = readFileSync(join(content, 'scripts', 'skill_magic', 'interfaces', 'magic.if'), 'utf8');
    const spells = new Set<string>();
    for (const m of magicIf.matchAll(/^text=Level\s+\d+\s*:\s*(.+)$/gm)) spells.add(m[1]!.trim().toLowerCase());

    const questNames = new Set<string>();
    const questRewardsPath = join(repoRoot, 'packages', 'dashboard', 'client-assets', 'quest-rewards.json');
    if (existsSync(questRewardsPath)) {
        for (const q of Object.keys(JSON.parse(readFileSync(questRewardsPath, 'utf8')))) questNames.add(q.toLowerCase());
    }

    return {
        maxObjId: obj.maxId,
        maxNpcId: npc.maxId,
        maxLocId: loc.maxId,
        objById: obj.byId,
        objIdsByDebug: obj.byDebug,
        objNames,
        objNameById,
        npcById: npc.byId,
        npcNames,
        locById: loc.byId,
        skills,
        prayers,
        spells,
        questNames,
        specwepDebugs,
    };
}

/** Checks that a list of skill names belongs strictly to Rev 289's 19 enabled skills. */
export function checkSkillsList(skills: readonly string[], baseline: Pick<Rev289Baseline, 'skills'>, file: string, scope: ParityIssue['scope']): ParityIssue[] {
    const issues: ParityIssue[] = [];
    for (const sk of skills) {
        if (!baseline.skills.has(sk.toLowerCase())) issues.push({ scope, file, detail: `non-rev-289 skill "${sk}"` });
    }
    return issues;
}

/** Checks that a list of prayer names belongs strictly to Rev 289's 15 prayers. */
export function checkPrayersList(prayers: readonly string[], baseline: Pick<Rev289Baseline, 'prayers'>, file: string, scope: ParityIssue['scope']): ParityIssue[] {
    const issues: ParityIssue[] = [];
    for (const p of prayers) {
        if (!baseline.prayers.has(p.toLowerCase())) issues.push({ scope, file, detail: `non-rev-289 prayer "${p}"` });
    }
    return issues;
}

/** Checks that a list of spell names belongs strictly to Rev 289's 52 Standard spells. */
export function checkSpellsList(spells: readonly string[], baseline: Pick<Rev289Baseline, 'spells'>, file: string, scope: ParityIssue['scope']): ParityIssue[] {
    const issues: ParityIssue[] = [];
    for (const s of spells) {
        if (!baseline.spells.has(s.toLowerCase())) issues.push({ scope, file, detail: `non-rev-289 spell "${s}"` });
    }
    return issues;
}

/** Checks that all item IDs (and optional display names) exist in Rev 289 obj.pack/.obj. */
export function validateItemIds(items: readonly { id: number; name?: string }[], baseline: Pick<Rev289Baseline, 'objById' | 'objNameById'>, file: string, scope: ParityIssue['scope']): ParityIssue[] {
    const issues: ParityIssue[] = [];
    for (const it of items) {
        if (!baseline.objById.has(it.id)) {
            issues.push({ scope, file, detail: `non-rev-289 item ID ${it.id}${it.name ? ` ("${it.name}")` : ''}` });
            continue;
        }
        if (it.name) {
            const expected = baseline.objNameById.get(it.id);
            if (expected && expected.toLowerCase() !== it.name.toLowerCase()) {
                issues.push({ scope, file, detail: `item ID ${it.id} named "${it.name}", expected "${expected}"` });
            }
        }
    }
    return issues;
}

/** Validates all generated files under knowledge/ against the Rev 289 baseline. */
export function checkKnowledgeParity(repoRoot: string, baseline: Rev289Baseline): ParityIssue[] {
    const issues: ParityIssue[] = [];
    const readJson = (name: string) => JSON.parse(readFileSync(join(repoRoot, 'knowledge', name), 'utf8'));

    const items = readJson('items.json') as { id: number; debugname: string }[];
    for (const it of items) {
        const expected = baseline.objById.get(it.id);
        if (expected !== it.debugname) issues.push({ scope: 'knowledge', file: 'knowledge/items.json', detail: `item ${it.id} (${it.debugname}) mismatch with obj.pack (${expected})` });
    }

    const gear = readJson('gear.json') as { id: number; debugname: string; requires?: { skills?: Record<string, number>; src?: string }; special?: { energy: number; pvp: boolean } }[];
    for (const g of gear) {
        if (baseline.objById.get(g.id) !== g.debugname) issues.push({ scope: 'knowledge', file: 'knowledge/gear.json', detail: `gear ${g.id} (${g.debugname}) missing in obj.pack` });
        const skills = Object.keys(g.requires?.skills ?? {});
        if (g.requires?.src && skills.length === 0) issues.push({ scope: 'knowledge', file: 'knowledge/gear.json', detail: `gear ${g.id} (${g.debugname}) has levelrequire src with empty skills` });
        issues.push(...checkSkillsList(skills, baseline, 'knowledge/gear.json', 'knowledge'));
    }
    const specDebugs = new Set(gear.filter(g => g.special).map(g => g.debugname));
    for (const s of baseline.specwepDebugs) {
        if (!specDebugs.has(s)) issues.push({ scope: 'knowledge', file: 'knowledge/gear.json', detail: `specwep item "${s}" missing special metadata` });
    }

    const npcs = readJson('npcs.json') as { id: number; debugname: string }[];
    for (const n of npcs) {
        if (baseline.npcById.get(n.id) !== n.debugname) issues.push({ scope: 'knowledge', file: 'knowledge/npcs.json', detail: `npc ${n.id} (${n.debugname}) mismatch with npc.pack` });
    }

    const doors = readJson('doors.json') as { id: number; loc: string }[];
    for (const d of doors) {
        if (!baseline.locById.has(d.id)) issues.push({ scope: 'knowledge', file: 'knowledge/doors.json', detail: `door loc ${d.id} (${d.loc}) missing in loc.pack` });
    }

    const pickables = readJson('pickables.json') as Record<string, { name: string }>;
    for (const [idStr, p] of Object.entries(pickables)) {
        const id = Number(idStr);
        if (!baseline.locById.has(id)) issues.push({ scope: 'knowledge', file: 'knowledge/pickables.json', detail: `pickable loc ${id} (${p.name}) missing in loc.pack` });
    }

    const skills = readJson('skills.json') as { skill: string }[];
    issues.push(...checkSkillsList([...new Set(skills.map(s => s.skill))], baseline, 'knowledge/skills.json', 'knowledge'));

    const ladders = readJson('ladders.json') as { ladders: Record<string, unknown> };
    issues.push(...checkSkillsList(Object.keys(ladders.ladders), baseline, 'knowledge/ladders.json', 'knowledge'));

    const rates = readJson('rates.json') as { skill: string }[];
    issues.push(...checkSkillsList([...new Set(rates.map(r => r.skill))], baseline, 'knowledge/rates.json', 'knowledge'));

    const quests = readJson('quests.json') as { xp?: { skill: string }[] }[];
    issues.push(...checkSkillsList([...new Set(quests.flatMap(q => (q.xp ?? []).map(x => x.skill)))], baseline, 'knowledge/quests.json', 'knowledge'));

    const teleports = readJson('teleports.json') as { teleports: { kind: string; name: string }[] };
    issues.push(...checkSpellsList(teleports.teleports.filter(t => t.kind === 'spell').map(t => t.name), baseline, 'knowledge/teleports.json', 'knowledge'));

    return issues;
}

/** Validates quest-reqs.json for rev 289 skill names, quest names, and absence of known OSRS wiki/godbook artifacts. */
export function checkQuestReqs(reqs: Record<string, { s?: [string, number, number][]; q?: [string, number][] }>, baseline: Pick<Rev289Baseline, 'skills' | 'questNames'>, file: string, scope: ParityIssue['scope']): ParityIssue[] {
    const issues: ParityIssue[] = [];
    for (const [qName, r] of Object.entries(reqs)) {
        if (baseline.questNames.size > 0 && !baseline.questNames.has(qName.toLowerCase())) {
            issues.push({ scope, file, detail: `unknown non-rev-289 quest "${qName}"` });
        }
        for (const [prereq] of r.q ?? []) {
            if (baseline.questNames.size > 0 && !baseline.questNames.has(prereq.toLowerCase())) {
                issues.push({ scope, file, detail: `quest "${qName}" references unknown non-rev-289 prerequisite "${prereq}"` });
            }
        }
        issues.push(...checkSkillsList((r.s ?? []).map(([sk]) => sk), baseline, file, scope));
    }
    if (reqs['Priest in Peril']?.q?.some(([n]) => n === 'Rune Mysteries Quest')) {
        issues.push({ scope, file, detail: 'Priest in Peril lists OSRS-only Rune Mysteries Quest prerequisite' });
    }
    if (reqs['Horror from the Deep']?.s?.some(([s, lv]) => s === 'Prayer' && lv === 50)) {
        issues.push({ scope, file, detail: 'Horror from the Deep lists post-quest godbook 50 Prayer check' });
    }
    return issues;
}

/** Validates packages/dashboard/client-assets/*.json and PNG icons against the Rev 289 baseline. */
export function checkDashboardAssetsParity(repoRoot: string, baseline: Rev289Baseline): ParityIssue[] {
    const issues: ParityIssue[] = [];
    const caDir = join(repoRoot, 'packages', 'dashboard', 'client-assets');
    const readAsset = (name: string) => JSON.parse(readFileSync(join(caDir, name), 'utf8'));

    const itemList = readAsset('item-list.json') as [number, string, string][];
    issues.push(...validateItemIds(itemList.map(([id, name]) => ({ id, name })), baseline, 'packages/dashboard/client-assets/item-list.json', 'client-assets'));

    const itemSources = readAsset('item-sources.json') as Record<string, unknown>;
    for (const id of Object.keys(itemSources)) {
        if (!baseline.objById.has(Number(id))) issues.push({ scope: 'client-assets', file: 'packages/dashboard/client-assets/item-sources.json', detail: `non-rev-289 item ID ${id}` });
    }

    for (const f of ['item-bonuses.json', 'item-alch.json', 'weapon-speed.json'] as const) {
        const obj = readAsset(f) as Record<string, unknown>;
        for (const k of Object.keys(obj)) {
            if (/^\d+$/.test(k)) {
                if (!baseline.objById.has(Number(k))) issues.push({ scope: 'client-assets', file: `packages/dashboard/client-assets/${f}`, detail: `non-rev-289 item ID ${k}` });
            } else if (!baseline.objNames.has(k)) {
                issues.push({ scope: 'client-assets', file: `packages/dashboard/client-assets/${f}`, detail: `unknown item name "${k}"` });
            }
        }
    }

    const itemStats = readAsset('item-stats.json') as Record<string, unknown>;
    for (const k of Object.keys(itemStats)) {
        if (!baseline.objNames.has(k)) issues.push({ scope: 'client-assets', file: 'packages/dashboard/client-assets/item-stats.json', detail: `unknown item name "${k}"` });
    }

    const pkKits = readAsset('pk-kits.json') as { name: string; worn: Record<string, [string, number, number]>; carried: [string, number, number][] }[];
    for (const kit of pkKits) {
        const rows = [...Object.values(kit.worn), ...kit.carried].map(([name, , id]) => ({ id, name }));
        issues.push(...validateItemIds(rows, baseline, 'packages/dashboard/client-assets/pk-kits.json', 'client-assets'));
    }

    const spellbook = readAsset('spellbook.json') as { spells: [string, number, [string, number][]][]; staffs: Record<string, string[]>; combat: [string, number, number, [string, number][], string | null, number][] };
    issues.push(...checkSpellsList([
        ...spellbook.spells.map(([n]) => n),
        ...spellbook.combat.map(([n]) => n),
    ], baseline, 'packages/dashboard/client-assets/spellbook.json', 'client-assets'));
    for (const s of Object.values(spellbook.staffs).flat()) {
        if (!baseline.objNames.has(s)) issues.push({ scope: 'client-assets', file: 'packages/dashboard/client-assets/spellbook.json', detail: `unknown staff "${s}"` });
    }

    const skillActions = readAsset('skill-actions.json') as Record<string, unknown>;
    issues.push(...checkSkillsList(Object.keys(skillActions), baseline, 'packages/dashboard/client-assets/skill-actions.json', 'client-assets'));

    const npcNames = readAsset('npc-names.json') as ([string, number?] | null)[];
    for (let id = 0; id < npcNames.length; id++) {
        const row = npcNames[id];
        if (!row) continue;
        if (!baseline.npcById.has(id)) issues.push({ scope: 'client-assets', file: 'packages/dashboard/client-assets/npc-names.json', detail: `non-rev-289 NPC ID ${id}` });
        else if (!baseline.npcNames.has(row[0].toLowerCase())) issues.push({ scope: 'client-assets', file: 'packages/dashboard/client-assets/npc-names.json', detail: `unknown NPC "${row[0]}"` });
    }
    const npcSpawns = readAsset('npc-spawns.json') as [string, ...unknown[]][];
    for (const [name] of npcSpawns) {
        if (!baseline.npcNames.has(name.toLowerCase())) issues.push({ scope: 'client-assets', file: 'packages/dashboard/client-assets/npc-spawns.json', detail: `unknown NPC "${name}"` });
    }
    const npcHunt = readAsset('npc-hunt.json') as [string, ...unknown[]][];
    for (const [name] of npcHunt) {
        if (!baseline.npcNames.has(name.toLowerCase())) issues.push({ scope: 'client-assets', file: 'packages/dashboard/client-assets/npc-hunt.json', detail: `unknown NPC "${name}"` });
    }
    const npcDrops = readAsset('npc-drops.json') as { byId: Record<string, unknown>; byName: Record<string, unknown> };
    for (const id of Object.keys(npcDrops.byId)) {
        if (!baseline.npcById.has(Number(id))) issues.push({ scope: 'client-assets', file: 'packages/dashboard/client-assets/npc-drops.json', detail: `non-rev-289 NPC ID ${id}` });
    }
    for (const name of Object.keys(npcDrops.byName)) {
        if (!baseline.npcNames.has(name.toLowerCase())) issues.push({ scope: 'client-assets', file: 'packages/dashboard/client-assets/npc-drops.json', detail: `unknown NPC "${name}"` });
    }
    for (const f of ['npc-defence.json', 'npc-loot.json'] as const) {
        for (const name of Object.keys(readAsset(f) as Record<string, unknown>)) {
            if (!baseline.npcNames.has(name.toLowerCase())) issues.push({ scope: 'client-assets', file: `packages/dashboard/client-assets/${f}`, detail: `unknown NPC "${name}"` });
        }
    }

    const resources = readAsset('resources.json') as { kinds?: Record<string, unknown>; depleted?: number[] };
    for (const id of [...Object.keys(resources.kinds ?? {}).map(Number), ...(resources.depleted ?? [])]) {
        if (!baseline.locById.has(id)) issues.push({ scope: 'client-assets', file: 'packages/dashboard/client-assets/resources.json', detail: `non-rev-289 loc ID ${id}` });
    }

    const cooking = readAsset('cooking.json') as Record<string, { c?: string }>;
    for (const [raw, info] of Object.entries(cooking)) {
        if (!baseline.objNames.has(raw)) issues.push({ scope: 'client-assets', file: 'packages/dashboard/client-assets/cooking.json', detail: `unknown item "${raw}"` });
        if (info.c && !baseline.objNames.has(info.c)) issues.push({ scope: 'client-assets', file: 'packages/dashboard/client-assets/cooking.json', detail: `unknown cooked item "${info.c}"` });
    }
    const runecraft = readAsset('runecraft.json') as Record<string, unknown>;
    for (const rune of Object.keys(runecraft)) {
        if (!baseline.objNames.has(rune)) issues.push({ scope: 'client-assets', file: 'packages/dashboard/client-assets/runecraft.json', detail: `unknown rune "${rune}"` });
    }
    const thieving = readAsset('thieving.json') as Record<string, unknown>;
    for (const npc of Object.keys(thieving)) {
        if (!baseline.npcNames.has(npc.toLowerCase())) issues.push({ scope: 'client-assets', file: 'packages/dashboard/client-assets/thieving.json', detail: `unknown NPC "${npc}"` });
    }

    const questReqs = readAsset('quest-reqs.json') as Record<string, { s?: [string, number, number][]; q?: [string, number][] }>;
    issues.push(...checkQuestReqs(questReqs, baseline, 'packages/dashboard/client-assets/quest-reqs.json', 'client-assets'));

    const questRewards = readAsset('quest-rewards.json') as Record<string, { xp?: Record<string, number> }>;
    for (const [qName, r] of Object.entries(questRewards)) {
        issues.push(...checkSkillsList(Object.keys(r.xp ?? {}), baseline, 'packages/dashboard/client-assets/quest-rewards.json', 'client-assets'));
    }

    // Ensure no post-289 skill/prayer/spell PNG assets remain in client-assets.
    for (const f of readdirSync(caDir)) {
        if (!f.endsWith('.png')) continue;
        if (f.startsWith('skill-') && BANNED_SKILLS.some(sk => f === `skill-${sk}.png`)) {
            issues.push({ scope: 'client-assets', file: `packages/dashboard/client-assets/${f}`, detail: 'banned post-289 skill icon' });
        }
        if (f.startsWith('prayer-') && BANNED_PRAYERS.some(pr => f === `prayer-${pr.replace(/\s+/g, '-')}.png`)) {
            issues.push({ scope: 'client-assets', file: `packages/dashboard/client-assets/${f}`, detail: 'banned post-289 prayer icon' });
        }
        if (f.startsWith('spell-') && BANNED_SPELLS.some(sp => f === `spell-${sp.replace(/\s+/g, '-')}.png`)) {
            issues.push({ scope: 'client-assets', file: `packages/dashboard/client-assets/${f}`, detail: 'banned post-289 spell icon' });
        }
    }

    return issues;
}

/** Audits one script's text for non-rev-289 item IDs, post-289 skills/prayers/spells, or OSRS item/bank terms. */
export function findScriptParityIssues(relPath: string, text: string, baseline: Pick<Rev289Baseline, 'maxObjId'>, scope: ParityIssue['scope'] = 'scripts'): ParityIssue[] {
    const issues: ParityIssue[] = [];
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        const isNegativeComment = NEGATIVE_COMMENT_RE.test(line);
        const caughtIdsOnLine = new Set<number>();

        // Flag explicit item-ID declarations above obj.pack max (4088), excluding coords/ticks/ports/interface IDs.
        const itemIdDecl = /\b(?:PURE_ESSENCE|ITEM_ID|itemId|objId)\s*=\s*(\d{4,6})\b/i.exec(line);
        if (itemIdDecl && Number(itemIdDecl[1]) > baseline.maxObjId) {
            const id = Number(itemIdDecl[1]);
            caughtIdsOnLine.add(id);
            issues.push({ scope, file: `${relPath}:${i + 1}`, detail: `non-rev-289 item ID ${id} (max obj.pack=${baseline.maxObjId})` });
        }
        const protectSet = /\bprotectedSet\s*=\s*new Set\(\[([^\]]+)\]/i.exec(line);
        if (protectSet) {
            for (const m of protectSet[1]!.matchAll(/\b(\d{4,6})\b/g)) {
                const id = Number(m[1]);
                if (id > baseline.maxObjId) {
                    caughtIdsOnLine.add(id);
                    issues.push({ scope, file: `${relPath}:${i + 1}`, detail: `non-rev-289 protected item ID ${id} (max obj.pack=${baseline.maxObjId})` });
                }
            }
        }
        // Flag known post-289 OSRS item IDs in item-helper calls or non-coord ID references.
        if (BANNED_ITEM_IDS_COMBINED_RE.test(line)) {
            for (const m of line.matchAll(/\b(?:sum|has|hasItem|invCount|bankCount|itemCount)\s*\([^)]*\b(\d{4,5})\b/g)) {
                const id = Number(m[1]);
                if (id > baseline.maxObjId && !caughtIdsOnLine.has(id) && BANNED_OSRS_ITEM_IDS.has(id)) {
                    caughtIdsOnLine.add(id);
                    issues.push({ scope, file: `${relPath}:${i + 1}`, detail: `non-rev-289 item ID ${id} (${BANNED_OSRS_ITEM_IDS.get(id)})` });
                }
            }
            if (!isNegativeComment && !COORD_OR_PORT_RE.test(line)) {
                for (const { id, label, re } of BANNED_ITEM_ID_MATCHERS) {
                    if (!caughtIdsOnLine.has(id) && re.test(line)) {
                        issues.push({ scope, file: `${relPath}:${i + 1}`, detail: `non-rev-289 item ID ${id} (${label})` });
                    }
                }
            }
        }

        // Flag post-289 skills, item phrases, prayers, and spells in runtime literals or non-negated lines.
        if (!isNegativeComment) {
            for (const { sk, re } of BANNED_SKILL_MATCHERS) {
                if (re.test(line) || (sk === 'slayer' && /\bslayer\/drop\b/i.test(line))) {
                    issues.push({ scope, file: `${relPath}:${i + 1}`, detail: `post-rev-289 skill "${sk}" in ${trimmed.slice(0, 80)}` });
                }
            }
            if (BANNED_ITEM_PHRASES_COMBINED_RE.test(line)) {
                for (const { phrase, re } of BANNED_ITEM_PHRASE_MATCHERS) {
                    if (re.test(line)) {
                        issues.push({ scope, file: `${relPath}:${i + 1}`, detail: `post-rev-289 item phrase "${phrase}" in ${trimmed.slice(0, 80)}` });
                    }
                }
            }
            for (const { pr, re } of BANNED_PRAYER_MATCHERS) {
                if (re.test(line)) {
                    issues.push({ scope, file: `${relPath}:${i + 1}`, detail: pr === 'preserve' ? 'post-rev-289 prayer literal "Preserve"' : `post-rev-289 prayer "${pr}"` });
                }
            }
            for (const { sp, re } of BANNED_SPELL_MATCHERS) {
                if (re.test(line)) {
                    issues.push({ scope, file: `${relPath}:${i + 1}`, detail: sp === 'lunar' ? 'post-rev-289 spellbook "lunar"' : `post-rev-289 spell "${sp}"` });
                }
            }
        }

        if (relPath === 'scripts/microbot-bank-sort.ts') {
            for (const term of BANNED_OSRS_BANK_TERMS) {
                if (line.toLowerCase().includes(term)) {
                    issues.push({ scope, file: `${relPath}:${i + 1}`, detail: `post-rev-289 bank-sort keyword "${term}"` });
                }
            }
        }
    }

    return issues;
}

/** Audits non-test script files under scripts/ against the Rev 289 baseline. */
export function checkScriptsParity(repoRoot: string, baseline: Rev289Baseline, opts: { includeCrossWorker?: boolean } = {}): ParityIssue[] {
    const issues: ParityIssue[] = [];
    const scriptsRoot = join(repoRoot, 'scripts');
    const walk = (dir: string) => {
        for (const f of readdirSync(dir).sort()) {
            const p = join(dir, f);
            if (statSync(p).isDirectory()) { walk(p); continue; }
            if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
            const rel = relative(repoRoot, p).replace(/\\/g, '/');
            if (rel === 'scripts/check-rev289-parity.ts') continue;
            const isCross = KNOWN_CROSS_WORKER_FILES.has(rel);
            if (isCross && !opts.includeCrossWorker) continue;
            issues.push(...findScriptParityIssues(rel, readFileSync(p, 'utf8'), baseline, isCross ? 'cross-worker' : 'scripts'));
        }
    };
    walk(scriptsRoot);
    return issues;
}

/** Audits packages/planner/, packages/router/, and packages/practice/src/ (.ts and .json) against Rev 289 parity. */
export function checkPlannerRouterPracticeParity(repoRoot: string, baseline: Rev289Baseline): ParityIssue[] {
    const issues: ParityIssue[] = [];
    const targets: { dir: string; scope: 'planner' | 'router' | 'practice' }[] = [
        { dir: join(repoRoot, 'packages', 'planner'), scope: 'planner' },
        { dir: join(repoRoot, 'packages', 'router'), scope: 'router' },
        { dir: join(repoRoot, 'packages', 'practice', 'src'), scope: 'practice' },
    ];
    for (const { dir, scope } of targets) {
        if (!existsSync(dir)) continue;
        for (const p of walkExt(dir, '.ts')) {
            if (p.endsWith('.test.ts')) continue;
            const rel = relative(repoRoot, p).replace(/\\/g, '/');
            issues.push(...findScriptParityIssues(rel, readFileSync(p, 'utf8'), baseline, scope));
        }
        for (const p of walkExt(dir, '.json')) {
            const rel = relative(repoRoot, p).replace(/\\/g, '/');
            let data: unknown;
            try { data = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
            const scanJson = (v: unknown, jsonPath: string) => {
                if (Array.isArray(v)) {
                    v.forEach((x, idx) => {
                        if (typeof x === 'number' && /(?:^|\.)items$/i.test(jsonPath) && !baseline.objById.has(x)) {
                            issues.push({ scope, file: `${rel}:${jsonPath}[${idx}]`, detail: `non-rev-289 item ID ${x}` });
                        } else {
                            scanJson(x, `${jsonPath}[${idx}]`);
                        }
                    });
                    return;
                }
                if (v && typeof v === 'object') {
                    const o = v as Record<string, unknown>;
                    if (typeof o.skill === 'string' && !baseline.skills.has(o.skill.toLowerCase())) {
                        issues.push({ scope, file: `${rel}:${jsonPath}.skill`, detail: `non-rev-289 skill "${o.skill}"` });
                    }
                    if (o.skills && typeof o.skills === 'object' && !Array.isArray(o.skills)) {
                        for (const sk of Object.keys(o.skills)) {
                            if (!baseline.skills.has(sk.toLowerCase())) {
                                issues.push({ scope, file: `${rel}:${jsonPath}.skills`, detail: `non-rev-289 skill "${sk}"` });
                            }
                        }
                    }
                    for (const key of ['itemId', 'objId'] as const) {
                        if (typeof o[key] === 'number' && !baseline.objById.has(o[key] as number)) {
                            issues.push({ scope, file: `${rel}:${jsonPath}.${key}`, detail: `non-rev-289 item ID ${o[key]}` });
                        }
                    }
                    if (typeof o.npcId === 'number' && !baseline.npcById.has(o.npcId)) {
                        issues.push({ scope, file: `${rel}:${jsonPath}.npcId`, detail: `non-rev-289 npc ID ${o.npcId}` });
                    }
                    if (typeof o.locId === 'number' && !baseline.locById.has(o.locId)) {
                        issues.push({ scope, file: `${rel}:${jsonPath}.locId`, detail: `non-rev-289 loc ID ${o.locId}` });
                    }
                    for (const [k, val] of Object.entries(o)) scanJson(val, jsonPath ? `${jsonPath}.${k}` : k);
                } else if (typeof v === 'string' && BANNED_ITEM_PHRASES_COMBINED_RE.test(v)) {
                    for (const { phrase, re } of BANNED_ITEM_PHRASE_MATCHERS) {
                        if (re.test(v)) {
                            issues.push({ scope, file: `${rel}:${jsonPath}`, detail: `post-rev-289 item phrase "${phrase}"` });
                        }
                    }
                }
            };
            scanJson(data, '');
        }
    }
    return issues;
}

/** Runs all Rev 289 parity checks across knowledge/, packages/dashboard/client-assets/, planner/router/practice, and scripts/. */
export function checkAllRev289Parity(repoRoot = resolve(import.meta.dir, '..'), opts: { includeCrossWorker?: boolean } = {}): ParityIssue[] {
    const baseline = loadRev289Baseline(repoRoot);
    return [
        ...checkKnowledgeParity(repoRoot, baseline),
        ...checkDashboardAssetsParity(repoRoot, baseline),
        ...checkPlannerRouterPracticeParity(repoRoot, baseline),
        ...checkScriptsParity(repoRoot, baseline, opts),
    ];
}

if (import.meta.main) {
    const strict = process.argv.includes('--strict');
    const baseline = loadRev289Baseline();
    const ownedIssues = checkAllRev289Parity(undefined, { includeCrossWorker: false });
    const crossIssues = checkScriptsParity(resolve(import.meta.dir, '..'), baseline, { includeCrossWorker: true })
        .filter(i => i.scope === 'cross-worker');

    console.log(`rev289-parity baseline: obj=${baseline.objById.size} (max ${baseline.maxObjId}), npc=${baseline.npcById.size} (max ${baseline.maxNpcId}), loc=${baseline.locById.size} (max ${baseline.maxLocId}), skills=${baseline.skills.size}, prayers=${baseline.prayers.size}, spells=${baseline.spells.size}`);
    for (const issue of ownedIssues) console.error(`[FAIL:${issue.scope}] ${issue.file}: ${issue.detail}`);
    for (const issue of crossIssues) console.warn(`[CROSS-WORKER] ${issue.file}: ${issue.detail}`);
    console.log(`rev289-parity: ${ownedIssues.length} owned error(s), ${crossIssues.length} cross-worker warning(s)`);
    if (ownedIssues.length > 0 || (strict && crossIssues.length > 0)) process.exit(1);
}
