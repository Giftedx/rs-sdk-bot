import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFilesByExt, parseConfigs, type ConfigBlock } from '../config';
import { contentRoot } from '../paths';
import { cleanLines } from '../text';
import type { Content, Hit } from './types';

/** Content-relative script paths inspected by the method models. */
export const MODEL_FILES = {
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
    courses: {
        gnome: 'scripts/skill_agility/scripts/gnome_course.rs2',
        barbarian: 'scripts/skill_agility/scripts/barbarian_course.rs2',
        wilderness: 'scripts/skill_agility/scripts/wilderness_course.rs2',
    } as Record<string, string>,
};

/** Reads files relative to the content root. Config indexes prefer a block outside `_unpack/` (the curated copy). */
export function loadContent(root = contentRoot()): Content {
    const texts = new Map<string, string[] | null>();
    const lines = (file: string) => {
        if (!texts.has(file)) {
            const p = join(root, file);
            texts.set(file, existsSync(p) ? cleanLines(readFileSync(p, 'utf8')) : null);
        }
        return texts.get(file)!;
    };
    let filesByExt: Map<string, string[]> | undefined;
    const filesFor = (ext: string) => {
        if (!filesByExt) filesByExt = listConfigFilesByExt(['.obj', '.struct', '.npc'], root);
        return filesByExt.get(ext) ?? [];
    };
    const indexes = new Map<string, { byName: Map<string, ConfigBlock>; all: ConfigBlock[] }>();
    const index = (ext: string) => {
        let ix = indexes.get(ext);
        if (!ix) {
            const all: ConfigBlock[] = [];
            const byName = new Map<string, ConfigBlock>();
            for (const f of filesFor(ext)) for (const b of parseConfigs(readFileSync(join(root, f), 'utf8'), f)) {
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
        lines,
        obj: n => index('.obj').byName.get(n),
        struct: n => index('.struct').byName.get(n),
        structs: () => index('.struct').all,
        npc: n => index('.npc').byName.get(n),
    };
}

/** `param=key,value` of a config block, with its `file:line`. */
export function param(b: ConfigBlock | undefined, key: string): { value: string; src: string } | null {
    if (!b) return null;
    const vals = b.props.param ?? [];
    for (let i = 0; i < vals.length; i++) {
        const v = vals[i]!, c = v.indexOf(',');
        if (v.slice(0, c) === key) return { value: v.slice(c + 1), src: `${b.file}:${b.propLines.param![i]}` };
    }
    return null;
}

/** First `key=value` property of a config block, with its `file:line`. */
export function prop(b: ConfigBlock | undefined, key: string): { value: string; src: string } | null {
    const v = b?.props[key]?.[0];
    return v === undefined ? null : { value: v, src: `${b!.file}:${b!.propLines[key]![0]}` };
}

const BLOCK_INDEX = new WeakMap<Content, Map<string, Map<string, { from: number; to: number }> | null>>();

function blockIndex(c: Content, file: string): Map<string, { from: number; to: number }> | null {
    let byFile = BLOCK_INDEX.get(c);
    if (!byFile) {
        byFile = new Map();
        BLOCK_INDEX.set(c, byFile);
    }
    if (byFile.has(file)) return byFile.get(file)!;
    const ls = c.lines(file);
    if (!ls) {
        byFile.set(file, null);
        return null;
    }
    const headers: number[] = [];
    for (let i = 0; i < ls.length; i++) if (ls[i]!.charCodeAt(0) === 91 /* '[' */) headers.push(i);
    const map = new Map<string, { from: number; to: number }>();
    for (let h = 0; h < headers.length; h++) {
        const from = headers[h]!;
        const to = headers[h + 1] ?? ls.length;
        const m = /^\[(?:([a-z_0-9]+),)?([^\]]+)\]/.exec(ls[from]!);
        if (!m) continue;
        const range = { from, to };
        if (!map.has(m[2]!)) map.set(m[2]!, range);
        if (m[1] !== undefined) {
            const full = `${m[1]},${m[2]}`;
            if (!map.has(full)) map.set(full, range);
        }
    }
    byFile.set(file, map);
    return map;
}

/** Line range of the block whose header is `[kind,name]` or `[name]`, header to next header. */
export function block(c: Content, file: string, name: string): { from: number; to: number } | null {
    return blockIndex(c, file)?.get(name) ?? null;
}

/** Every match of `re` in a file (or in one script block of it), on comment-stripped lines. */
export function findAll(c: Content, file: string, re: RegExp, inBlock?: string): Hit[] {
    const ls = c.lines(file);
    if (!ls) return [];
    const r = inBlock ? block(c, file, inBlock) : { from: 0, to: ls.length };
    if (!r) return [];
    const out: Hit[] = [];
    const reset = re.global || re.sticky;
    for (let i = r.from; i < r.to; i++) {
        if (reset) re.lastIndex = 0;
        const m = re.exec(ls[i]!);
        if (m) out.push({ m, src: `${file}:${i + 1}`, line: i + 1 });
    }
    return out;
}

/** First match of `re` in a file (or in one script block of it). */
export function find(c: Content, file: string, re: RegExp, inBlock?: string): Hit | null {
    const ls = c.lines(file);
    if (!ls) return null;
    const r = inBlock ? block(c, file, inBlock) : { from: 0, to: ls.length };
    if (!r) return null;
    const reset = re.global || re.sticky;
    for (let i = r.from; i < r.to; i++) {
        if (reset) re.lastIndex = 0;
        const m = re.exec(ls[i]!);
        if (m) return { m, src: `${file}:${i + 1}`, line: i + 1 };
    }
    return null;
}

const STRUCT_INDEX = new WeakMap<Content, Map<string, Map<string, ConfigBlock>>>();

/** Lookup the first struct block whose `param=key,value` equals `value`. */
export function struct(c: Content, key: string, value: string): ConfigBlock | undefined {
    let byKey = STRUCT_INDEX.get(c);
    if (!byKey) {
        byKey = new Map();
        STRUCT_INDEX.set(c, byKey);
    }
    let byVal = byKey.get(key);
    if (!byVal) {
        byVal = new Map();
        for (const s of c.structs()) {
            const p = param(s, key);
            if (p && !byVal.has(p.value)) byVal.set(p.value, s);
        }
        byKey.set(key, byVal);
    }
    return byVal.get(value);
}
