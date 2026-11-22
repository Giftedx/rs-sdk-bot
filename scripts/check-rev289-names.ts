// Name sweep: every string a game call or a name table uses as an item, NPC, object or quest name must be a name
// that the revision-289 content defines. Compares string literals in scripts/ and packages/ against the names in
// vendor/rs-sdk/server/content (.obj, .npc, .loc configs, quest.enum, skills, prayers, spells).
// Usage: bun scripts/check-rev289-names.ts [--all]   (--all also lists every checked literal count by callee)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { loadRev289Baseline, type Rev289Baseline } from './check-rev289-parity';

export type NameFaultKind = 'osrs-only' | 'mismatch' | 'bad-id';

export interface NameFault {
    file: string; // relative path:line
    text: string; // the literal
    use: string; // callee or table the literal is used in
    kind: NameFaultKind;
    detail: string;
}

export interface NameSets {
    /** Lower-case display names and debugnames (underscores as spaces) of items, NPCs, objects, quests, skills, prayers, spells. */
    all: Set<string>;
    items: Set<string>;
    npcs: Set<string>;
    locs: Set<string>;
    quests: Set<string>;
    /** Every name above in one array, for substring and regular-expression matches. */
    list: string[];
    npcList: string[];
    /** Debugnames of items, NPCs and objects: a table keyed by debugname is valid, a substring or pattern match is not. */
    debugs: Set<string>;
    /** Per id: the debugname and the display name. */
    idNames: { obj: Map<number, string[]>; npc: Map<number, string[]>; loc: Map<number, string[]> };
}

export interface NameScan {
    faults: NameFault[];
    namesChecked: number;
    idsChecked: number;
    callees: Map<string, { total: number; real: number }>;
}

// Strings that the SDK matches as a substring or regular expression, and that tables use as exact names.
// A callee joins this set when most of its string arguments are real names (see discoverCallees).
export const GAME_CALLEES = new Set([
    'findInventoryItem', 'findBankItem', 'findEquipmentItem', 'findEquippedItem', 'findGroundItem',
    'getInventoryItem', 'getBankItem', 'getEquipmentItem', 'countInventoryItems', 'withdrawItem',
    'depositItem', 'dropItem', 'equipItem', 'eatFood', 'pickupItem', 'useItemOnLoc', 'useItemOnNpc',
    'buyFromShop', 'sellToShop', 'findNearbyNpc', 'findNearbyLoc', 'getNearbyNpc', 'getNearbyLoc',
    'interactNpc', 'interactLoc', 'attack', 'talkTo',
]);

/** Built-in string and regular-expression methods: their patterns are not game names. */
export const STRING_METHODS = new Set(['test', 'match', 'matchAll', 'search', 'replace', 'replaceAll', 'split', 'exec', 'startsWith', 'endsWith', 'includes', 'indexOf', 'some', 'every', 'filter', 'find']);

/** Quest-script helpers whose second argument is a regular expression for the NPC's name. */
export const TALK_CALLEES = new Set(['talk', 'talkOnce', 'talkChoose', 'talkChat', 'talkWait']);

/** Callees that read many real names but take other strings too (skill names, plain labels). */
export const NOT_GAME_CALLEES = new Set(['getSkill', 'getSkillXp', 'level', 'xp', 'skill', 'skillXp', 'lvl', 'lv', 'meter', 'id', 'objId', 'npcId', 'locId', 's', 't']);

/** Strings that call a game helper but name no game thing. Each entry carries its reason. */
export const NAME_ALLOW: ReadonlyArray<{ file: string; text: string; reason: string }> = [
    { file: 'scripts/generated/quest-scorpion.ts', text: 'equip failed', reason: 'the fallback text of `?? \'equip failed\'`, a message and not a name' },
    { file: 'packages/planner/src/pk-kits.ts', text: 'Mage Arena', reason: 'the content has the Mage Arena varp (267) and no journal entry, so the label has no content spelling' },
    { file: 'packages/dashboard/goal-details.ts', text: 'Legends Guild shop', reason: 'prose label of the shop inventory generallegends' },
    { file: 'packages/dashboard/server/world.ts', text: 'Quest Points', reason: 'a board name of the hiscores, not a game object' },
    { file: 'packages/planner/src/haggis.ts', text: 'Quest Points', reason: 'a board name of the hiscores, not a game object' },
    { file: 'packages/knowledge/src/method-model/production.ts', text: 'Glass orb', reason: 'the label of the skill guide row (skill_guide.dbrow:331), not an item name' },
    { file: 'packages/planner/src/gear-progression/model.ts', text: "heroes' quest", reason: 'alias key: an input spelling that maps to the journal name' },
    { file: 'packages/planner/src/gear-progression/model.ts', text: 'heroes quest', reason: 'alias key: an input spelling that maps to the journal name' },
    { file: 'packages/planner/src/gear-progression/model.ts', text: 'hero quest', reason: 'alias key: an input spelling that maps to the journal name' },
    { file: 'packages/planner/src/gear-progression/model.ts', text: "legends' quest", reason: 'alias key: an input spelling that maps to the journal name' },
    { file: 'packages/planner/src/gear-progression/model.ts', text: 'the legends quest', reason: 'alias key: an input spelling that maps to the journal name' },
    { file: 'scripts/generated/quest-itwatchtower.ts', text: '2391', reason: 'the ogre potion takes ground bat bones; the key batBones is a short label' },
    { file: 'scripts/generated/quest-upass.ts', text: '1035', reason: 'the zamorak robe top is the item "Robe of zamorak"; the key robeTop is a label' },
];

const SKIP_DIRS = new Set(['node_modules', 'vendor', '.practice', 'generated-assets']);

function walkTs(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir).sort()) {
        if (SKIP_DIRS.has(f)) continue;
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walkTs(p, out);
        else if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')) out.push(p);
    }
    return out;
}

function walkExt(dir: string, ext: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir).sort()) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walkExt(p, ext, out);
        else if (f.endsWith(ext)) out.push(p);
    }
    return out;
}

function packById(path: string): Map<number, string> {
    const out = new Map<number, string>();
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const i = line.indexOf('=');
        const id = Number(line.slice(0, i));
        if (i > 0 && Number.isSafeInteger(id)) out.set(id, line.slice(i + 1).trim());
    }
    return out;
}

export const norm = (s: string) => s.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');

/** Names from the configs whose debugname the engine pack lists, and each id's display name and debugname. */
const debugNames = new Set<string>();
function configNames(content: string, ext: string, pack: Map<number, string>): { names: Set<string>; byId: Map<number, string[]> } {
    const names = new Set<string>();
    const display = new Map<string, string>();
    const debugs = new Set(pack.values());
    for (const f of walkExt(join(content, 'scripts'), ext)) {
        let cur = '';
        for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
            const line = raw.trim();
            const head = /^\[([^\]]+)\]$/.exec(line);
            if (head) { cur = head[1]!; continue; }
            if (cur && debugs.has(cur) && line.startsWith('name=')) { names.add(norm(line.slice(5))); display.set(cur, norm(line.slice(5))); }
        }
    }
    const byId = new Map<number, string[]>();
    for (const dbg of debugs) debugNames.add(dbg.toLowerCase());
    for (const [id, dbg] of pack) byId.set(id, [norm(dbg), ...(display.has(dbg) ? [display.get(dbg)!] : [])]);
    return { names, byId };
}

const nameSetCache = new Map<string, NameSets>();

/** Reads the content once for each root; later calls return the same sets. */
export function loadNameSets(repoRoot = resolve(import.meta.dir, '..'), baseline?: Rev289Baseline): NameSets {
    const cached = nameSetCache.get(repoRoot);
    if (cached) return cached;
    const sets = readNameSets(repoRoot, baseline);
    nameSetCache.set(repoRoot, sets);
    return sets;
}

function readNameSets(repoRoot: string, baseline?: Rev289Baseline): NameSets {
    const base = baseline ?? loadRev289Baseline(repoRoot);
    const content = join(repoRoot, 'vendor', 'rs-sdk', 'server', 'content');
    const obj = configNames(content, '.obj', packById(join(content, 'pack', 'obj.pack')));
    const npc = configNames(content, '.npc', packById(join(content, 'pack', 'npc.pack')));
    const loc = configNames(content, '.loc', packById(join(content, 'pack', 'loc.pack')));
    const quests = new Set<string>();
    const enumText = readFileSync(join(content, 'scripts', 'general', 'configs', 'quest.enum'), 'utf8');
    for (const m of enumText.matchAll(/^val=\d+,(.+)$/gm)) quests.add(norm(m[1]!));
    // The journal prints its own spelling of each quest name.
    const journal = readFileSync(join(content, 'scripts', 'player', 'interfaces', 'questlist.if'), 'utf8');
    for (const m of journal.matchAll(/^text=(.+)$/gm)) quests.add(norm(m[1]!));
    const all = new Set<string>([...obj.names, ...npc.names, ...loc.names, ...quests]);
    for (const s of [...base.skills, ...base.prayers, ...base.spells]) all.add(norm(s));
    return { all, items: obj.names, npcs: npc.names, locs: loc.names, quests, list: [...all], npcList: [...npc.names], debugs: debugNames, idNames: { obj: obj.byId, npc: npc.byId, loc: loc.byId } };
}

/** A pattern matches when the SDK would find a name with it: substring for text, a test for a regular expression. */
function patternMatches(text: string, isRegex: boolean, flags: string, sets: NameSets): boolean {
    if (isRegex) {
        let re: RegExp;
        try { re = new RegExp(text, flags.includes('i') ? flags : `${flags}i`); } catch { return true; }
        return sets.list.some(n => re.test(n));
    }
    const t = norm(text);
    if (t === '') return true;
    if (sets.all.has(t) || isPinnedForm(t, sets)) return true;
    return sets.list.some(n => n.includes(t));
}

function editDistance(a: string, b: string, cap: number): number {
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let min = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (cur[j]! < min) min = cur[j]!;
        }
        if (min > cap) return cap + 1;
        prev = cur;
    }
    return prev[b.length]!;
}

/** The nearest real name within two edits, or a name that holds the text with its words in another order. */
/**
 * The planner's pinned dialect: a bill or price line may name a real item in the singular or with a stripped plural
 * ("studded chap" for Studded chaps; packages/planner/src/autopilot.ts norm), "mort myre fungus" for Mort myre fungi, and
 * "<herb> potion (unf)" for the one item "Unfinished potion" (packages/planner/src/supply-bill.ts idsFor).
 */
export function isPinnedForm(text: string, sets: NameSets): boolean {
    const t = text.replace(/\s*\((?:noted|quest)\)$/, '');
    if (t !== text && sets.all.has(t)) return true;
    const forms = [t + 's', t.replace(/y$/, 'ies'), t.replace(/us$/, 'i'), t + 'es', t.replace(/s$/, '')];
    if (forms.some(f => sets.all.has(f))) return true;
    return /^[a-z' ]+ potion \(unf\)$/.test(t);
}

export function nearestName(text: string, sets: NameSets): string | null {
    const t = norm(text);
    if (t.length < 8) return null;
    const words = t.split(' ').sort().join(' ');
    let best: string | null = null;
    let bestD = 3;
    for (const n of sets.list) {
        if (n.split(' ').sort().join(' ') === words) return n;
        const d = editDistance(t, n, 2);
        if (d < bestD) { bestD = d; best = n; }
    }
    return best;
}

const NAME_KEYS = new Set(['name', 'item', 'npc', 'loc', 'obj', 'object', 'quest', 'itemName', 'npcName', 'locName']);
const ID_KEYS = new Map<string, 'obj' | 'npc' | 'loc'>([
    ['itemId', 'obj'], ['objId', 'obj'], ['item_id', 'obj'], ['npcId', 'npc'], ['locId', 'loc'],
]);

function calleeName(e: ts.Expression): string | null {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
    return null;
}

function literalText(n: ts.Node): { text: string; regex: boolean; flags: string } | null {
    if (ts.isStringLiteralLike(n)) return { text: n.text, regex: false, flags: '' };
    if (ts.isRegularExpressionLiteral(n)) {
        const m = /^\/(.*)\/([a-z]*)$/s.exec(n.text);
        if (m) return { text: m[1]!, regex: true, flags: m[2]! };
    }
    return null;
}

/** Callees whose options object holds a `label` that is error text for a log, not a game name (scripts/gear-reconcile.ts reconcileLoadout). */
export const LABEL_OPTION_CALLEES = new Set(['reconcileLoadout']);
function isLabelOption(n: ts.Node): boolean {
    const p = n.parent, o = p?.parent, c = o?.parent;
    return !!p && ts.isPropertyAssignment(p) && p.initializer === n && ts.isIdentifier(p.name) && p.name.text === 'label'
        && !!o && ts.isObjectLiteralExpression(o) && !!c && ts.isCallExpression(c) && LABEL_OPTION_CALLEES.has(calleeName(c.expression) ?? '');
}

interface Lit { node: ts.Node; text: string; regex: boolean; flags: string; callee: string | null; argIndex: number; container: ts.Node | null }

function collect(sf: ts.SourceFile): { lits: Lit[]; calls: ts.CallExpression[] } {
    const lits: Lit[] = [];
    const calls: ts.CallExpression[] = [];
    const visit = (n: ts.Node, container: ts.Node | null) => {
        if (ts.isCallExpression(n)) calls.push(n);
        const lt = literalText(n);
        if (lt && !isLabelOption(n)) {
            const p = n.parent;
            let callee: string | null = null;
            let argIndex = -1;
            if (p && ts.isCallExpression(p) && p.expression !== n) {
                callee = calleeName(p.expression);
                argIndex = p.arguments.indexOf(n as ts.Expression);
            }
            lits.push({ node: n, ...lt, callee, argIndex, container });
        }
        const next = ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n) ? n : container;
        ts.forEachChild(n, c => visit(c, next));
    };
    visit(sf, null);
    return { lits, calls };
}

const posOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

export interface ScanOptions {
    repoRoot?: string;
    baseline?: Rev289Baseline;
    sets?: NameSets;
    /** Source files to scan; default: scripts/ and packages/ without tests. */
    files?: string[];
    allow?: typeof NAME_ALLOW;
}

export function scanNames(opts: ScanOptions = {}): NameScan {
    const repoRoot = opts.repoRoot ?? resolve(import.meta.dir, '..');
    const baseline = opts.baseline ?? loadRev289Baseline(repoRoot);
    const sets = opts.sets ?? loadNameSets(repoRoot, baseline);
    const files = opts.files ?? [...walkTs(join(repoRoot, 'scripts')), ...walkTs(join(repoRoot, 'packages'))];
    const allow = opts.allow ?? NAME_ALLOW;
    const parsed = files.map(f => {
        const text = readFileSync(f, 'utf8');
        const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
        return { rel: relative(repoRoot, f).replace(/\\/g, '/'), sf, ...collect(sf) };
    });

    // A callee is a game call when it is listed, or when most of its string arguments are exact real names.
    // The test runs per file, because a local helper of one file can share its name with a game helper of another.
    type Stat = { total: number; real: number; rtotal: number; rreal: number };
    const callees = new Map<string, Stat>();
    const fileCallees = new Map<string, Map<string, Stat>>();
    for (const { rel, lits } of parsed) {
        const local = new Map<string, Stat>();
        fileCallees.set(rel, local);
        for (const l of lits) {
            if (!l.callee) continue;
            const real = l.regex ? patternMatches(l.text, true, l.flags, sets) : sets.all.has(norm(l.text));
            for (const m of [callees, local]) {
                const c = m.get(l.callee) ?? { total: 0, real: 0, rtotal: 0, rreal: 0 };
                if (l.regex) { c.rtotal++; if (real) c.rreal++; } else { c.total++; if (real) c.real++; }
                m.set(l.callee, c);
            }
        }
    }
    // A helper that takes name patterns (findItem(/headless arrow/i)) joins when a third of its patterns match a name, and two do.
    const isGameCallee = (rel: string, name: string, regex: boolean) => {
        if (GAME_CALLEES.has(name)) return true;
        const c = fileCallees.get(rel)?.get(name);
        if (!c || NOT_GAME_CALLEES.has(name) || STRING_METHODS.has(name)) return false;
        if (regex && c.rreal >= 2 && c.rreal / c.rtotal >= 0.3) return true;
        return !regex && c.total >= 5 && c.real / c.total >= 0.8;
    };

    const faults: NameFault[] = [];
    let namesChecked = 0;
    let idsChecked = 0;
    const seen = new Set<string>();
    const add = (rel: string, line: number, text: string, use: string, kind: NameFaultKind, detail: string) => {
        if (allow.some(a => a.file === rel && a.text === text)) return;
        const key = `${rel}:${line}:${text}:${kind}`;
        if (seen.has(key)) return;
        seen.add(key);
        faults.push({ file: `${rel}:${line}`, text, use, kind, detail });
    };

    for (const { rel, sf, lits, calls } of parsed) {
        // Per container: how many of its strings are exact real names.
        const tally = new Map<ts.Node, { total: number; real: number }>();
        for (const l of lits) {
            if (!l.container || l.regex) continue;
            const t = tally.get(l.container) ?? { total: 0, real: 0 };
            t.total++;
            if (sets.all.has(norm(l.text)) || sets.debugs.has(l.text.trim().toLowerCase().replace(/ /g, '_'))) t.real++;
            tally.set(l.container, t);
        }
        for (const l of lits) {
            const line = posOf(sf, l.node);
            // The quest helpers take the NPC to talk to as a regular expression in their second argument.
            if (l.callee && TALK_CALLEES.has(l.callee) && l.argIndex === 1 && l.regex) {
                namesChecked++;
                let re: RegExp | null = null;
                try { re = new RegExp(l.text, l.flags.includes('i') ? l.flags : `${l.flags}i`); } catch { /* not a pattern */ }
                if (re && !sets.npcList.some(n => re!.test(n))) add(rel, line, `/${l.text}/${l.flags}`, `${l.callee}() npc`, 'osrs-only', 'matches no revision-289 NPC name');
                continue;
            }
            if (l.callee && isGameCallee(rel, l.callee, l.regex) && !(l.callee === 'has' && l.regex) && (l.argIndex === 0 || /^useItemOn/.test(l.callee))) {
                if (l.text.length > 60) continue;
                namesChecked++;
                if (!patternMatches(l.text, l.regex, l.flags, sets)) {
                    const near = l.regex ? null : nearestName(l.text, sets);
                    if (near) add(rel, line, l.text, `${l.callee}()`, 'mismatch', `near "${near}"`);
                    else add(rel, line, l.text, `${l.callee}()`, 'osrs-only', 'matches no revision-289 name');
                }
                continue;
            }
            // Name table: an array or object whose strings are mostly real names.
            if (!l.regex && l.container && !l.callee) {
                const t = tally.get(l.container)!;
                if (t.total >= 3 && t.real / t.total >= 0.6 && l.text.length <= 60) {
                    const n = norm(l.text);
                    if (sets.all.has(n) || sets.debugs.has(l.text.trim().toLowerCase().replace(/ /g, '_')) || isPinnedForm(n, sets) || /^[a-z0-9]+(-[a-z0-9]+)+$/.test(l.text) || l.text.trim().split(/\s+/).length > 4) continue;
                    namesChecked++;
                    const near = nearestName(l.text, sets);
                    if (near) add(rel, line, l.text, 'name table', 'mismatch', `near "${near}"`);
                    else if (l.text.trim().includes(' ') && /^[A-Za-z]/.test(l.text)) add(rel, line, l.text, 'name table', 'osrs-only', 'matches no revision-289 name');
                }
            }
        }

        // Ids: a number beside a name key, under an id key, or bound to an identifier that spells an item name.
        const idNamesOk = (pool: 'obj' | 'npc' | 'loc', id: number, expect: string) => {
            const e = norm(expect);
            return (['obj', 'npc', 'loc'] as const).some(pl => (sets.idNames[pl].get(id) ?? []).some(n => n === e || n.includes(e) || n.includes(e.replace(/s$/, ''))));
        };
        const checkId = (id: number, pool: 'obj' | 'npc' | 'loc', expectName: string | null, line: number, use: string) => {
            idsChecked++;
            const names = sets.idNames[pool].get(id);
            if (!names) {
                add(rel, line, String(id), use, 'bad-id', `no ${pool} ${id} in the content`);
                return;
            }
            if (expectName !== null && !idNamesOk(pool, id, expectName)) {
                add(rel, line, String(id), use, 'bad-id', `${pool} ${id} is "${names[names.length - 1]}", the code expects "${expectName}"`);
            }
        };
        const visitIds = (n: ts.Node) => {
            if (ts.isObjectLiteralExpression(n)) {
                const props = new Map<string, ts.Expression>();
                for (const p of n.properties) {
                    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))) props.set(p.name.text, p.initializer);
                }
                let nm: string | null = null;
                for (const k of NAME_KEYS) {
                    const v = props.get(k);
                    if (v && ts.isStringLiteralLike(v)) { nm = v.text; break; }
                }
                for (const [k, v] of props) {
                    if (!ts.isNumericLiteral(v)) continue;
                    const id = Number(v.text);
                    const keyPool = ID_KEYS.get(k);
                    if (keyPool) { checkId(id, keyPool, nm, posOf(sf, v), `${k} key`); continue; }
                    if (k !== 'id' || nm === null) continue;
                    // id beside a name: the pool is the one that holds the name exactly; an id that the pool holds under another name is wrong.
                    const nn = norm(nm);
                    const pools = (['obj', 'npc', 'loc'] as const).filter(pl => (pl === 'obj' ? sets.items : pl === 'npc' ? sets.npcs : sets.locs).has(nn));
                    if (pools.length === 0 || /\d/.test(nn)) continue;
                    idsChecked++;
                    if (!pools.some(pl => idNamesOk(pl, id, nm!))) {
                        const have = pools.map(pl => sets.idNames[pl].get(id)?.[sets.idNames[pl].get(id)!.length - 1]).filter(Boolean);
                        add(rel, posOf(sf, v), String(id), 'id beside name', 'bad-id', have.length ? `id ${id} is "${have[0]}", the code expects "${nm}"` : `no ${pools.join('/')} ${id} in the content`);
                    }
                }
            }
            ts.forEachChild(n, visitIds);
        };
        visitIds(sf);
        // A numeric property or constant whose name spells a real item (two or more words: `rawShark: 383`, `BRONZE_AXE = 1351`).
        const spelled = (id: string) => id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().trim();
        const visitSpelled = (n: ts.Node) => {
            let name: string | null = null;
            let init: ts.Expression | undefined;
            if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) { name = n.name.text; init = n.initializer; }
            else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) { name = n.name.text; init = n.initializer; }
            if (name && init && ts.isNumericLiteral(init) && /^\d{3,5}$/.test(init.text)) {
                const words = spelled(name);
                if (words.includes(' ') && sets.items.has(words)) {
                    idsChecked++;
                    const id = Number(init.text);
                    const names = sets.idNames.obj.get(id);
                    if (!names) add(rel, posOf(sf, init), init.text, `constant ${name}`, 'bad-id', `no item ${id} in the content`);
                    else if (!names.includes(words)) add(rel, posOf(sf, init), init.text, `constant ${name}`, 'bad-id', `item ${id} is "${names[names.length - 1]}", the name says "${words}"`);
                }
            }
            ts.forEachChild(n, visitSpelled);
        };
        visitSpelled(sf);
        for (const c of calls) {
            const nme = calleeName(c.expression);
            if (!nme || !/^(?:findInventoryItemById|findBankItemById|hasItemId|invCountId|bankCountId|countById|withdrawId)$/.test(nme)) continue;
            const a = c.arguments[0];
            if (a && ts.isNumericLiteral(a)) checkId(Number(a.text), 'obj', null, posOf(sf, a), `${nme}()`);
        }
    }
    return { faults, namesChecked, idsChecked, callees };
}

if (import.meta.main) {
    const scan = scanNames();
    const byKind = (k: NameFaultKind) => scan.faults.filter(f => f.kind === k);
    for (const f of scan.faults) console.log(`${f.kind}\t${f.file}\t"${f.text}"\t${f.use}\t${f.detail}`);
    console.log(`rev289-names: ${scan.namesChecked} names checked, ${scan.idsChecked} ids checked, osrs-only=${byKind('osrs-only').length} mismatch=${byKind('mismatch').length} bad-id=${byKind('bad-id').length}`);
    if (process.argv.includes('--all')) {
        for (const [k, v] of [...scan.callees].filter(([, v]) => v.total >= 3 && v.real / v.total >= 0.6).sort()) console.log(`callee ${k} ${v.real}/${v.total}`);
    }
    process.exit(scan.faults.length ? 1 : 0);
}
