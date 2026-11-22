import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, parseConfigs, type ConfigBlock } from '../config';
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

/** Line range of the block whose header is `[kind,name]` or `[name]`, header to next header. */
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

/** Every match of `re` in a file (or in one script block of it), on comment-stripped lines. */
export function findAll(c: Content, file: string, re: RegExp, inBlock?: string): Hit[] {
    const ls = c.lines(file);
    if (!ls) return [];
    const r = inBlock ? block(c, file, inBlock) : { from: 0, to: ls.length };
    if (!r) return [];
    const out: Hit[] = [];
    for (let i = r.from; i < r.to; i++) {
        const m = re.exec(ls[i]!);
        if (m) out.push({ m, src: `${file}:${i + 1}`, line: i + 1 });
    }
    return out;
}

/** First match of `re` in a file (or in one script block of it). */
export const find = (c: Content, file: string, re: RegExp, inBlock?: string): Hit | null => findAll(c, file, re, inBlock)[0] ?? null;

/** Lookup the first struct block whose `param=key,value` equals `value`. */
export function struct(c: Content, key: string, value: string): ConfigBlock | undefined {
    return c.structs().find(s => param(s, key)?.value === value);
}
