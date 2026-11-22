// Quest route, XP budget, varp, and pre-route skill helpers for PK kits.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { levelForXp, xpForLevel } from '../curve';
import { kitOf, kitSkills } from './kits';
import { MAXED, pkKitsRoot } from './model';

// Each quest's varp and the value that completes it (pack/varp.pack; the quests' ^<quest>_complete constants), the
// value the wear checks of levelrequire.rs2 compare: a kit worn at the start skips them, but a weapon or shield put
// back on after a two-handed bow is checked, so a kit whose quest was not set fought with no dragon mace or square
// shield after its first bow turn (finding 72).
const QUEST_VARP: Readonly<Record<string, readonly [number, number]>> = {
    'Lost City': [147, 6], 'Dragon Slayer': [176, 10], "Hero's Quest": [188, 15], "Legends Quest": [139, 75], Regicide: [328, 15],
    'The Fremennik Trials': [347, 10], 'Underground Pass': [161, 10],
};

// The server's XP rate (WorldConfig.ts xpRate), and the rewards that knowledge/quests.json does not hold, in whole XP
// (quest_waterfall.rs2:491-492).
const XP_RATE = 25;
const MORE_REWARDS: Readonly<Record<string, { skill: string; xp: number }[]>> = {
    quest_waterfall: [{ skill: 'attack', xp: 13750 }, { skill: 'strength', xp: 13750 }],
};

// The most XP that the fights of a quest give to one skill, at the server's rate, where the quest script sets the
// style: a route counts it with the rewards. The Fremennik Trials: the bot fights Koschei unarmed with Kick, which
// trains only Strength, and the Draugen the same way; practice runs of the whole quest gave 23,100 to 29,400 XP (research/pvp-fight-loop.md, "Quest routes of the
// builds"). Lost City gives its fight XP to Strength too, and every kit with a dragon weapon has Strength 99.
// Regicide: the quest script casts the Falador and Ardougne teleports; a practice run gave 4,250 Magic XP.
// The Mage Arena: the casts at Kolodion and the 99 casts of Flames of Zamorak; practice runs gave 184,300 to 200,062
// Magic XP.
const FIGHT_XP: Readonly<Record<string, { skill: string; xp: number }[]>> = {
    quest_viking: [{ skill: 'strength', xp: 35_000 }],
    quest_regicide: [{ skill: 'magic', xp: 5_000 }],
    area_mage_arena: [{ skill: 'magic', xp: 205_000 }],
};

// The Prayer level of Protect from Magic, which the Mage Arena needs: each spell of Kolodion and of the battle mages
// hits up to 20, and an account with no such prayer did not pass in practice.
const ARENA_PRAYER = 37;

// The fight XP of a quest that goes to the style of the account, measured on the maxed presets: a kit with the quest
// on its route needs one of Strength, Ranged and Magic at 99 to take it (research/pvp-fight-loop.md, "Quest routes of
// the builds").
const SINK_XP: Readonly<Record<string, number>> = { quest_upass: 53_400, quest_regicide: 11_100 };

let rewards: Map<string, { skill: string; xp: number }[]> | undefined;
const rewardsOf = (folder: string) => {
    rewards ??= (JSON.parse(readFileSync(join(pkKitsRoot, 'knowledge/quests.json'), 'utf8')) as { folder: string; xp: { skill: string; xp: number }[] }[])
        .reduce((m, q) => m.set(q.folder, [...(m.get(q.folder) ?? []), ...q.xp]), new Map<string, { skill: string; xp: number }[]>());
    return [...(rewards.get(folder) ?? []), ...(MORE_REWARDS[folder] ?? [])];
};

/** Bind quest route tables and validators using the facade's `mageArenaQuest` label. */
export function createKitRoutes(mageArenaQuest: string) {
    // The quest that an item of a kit needs to be worn (levelrequire/scripts/tier*.rs2) and the quest that a varp of a
    // kit stands for.
    const ITEM_QUEST: Readonly<Record<string, string>> = {
        dragon_dagger: 'Lost City', dragon_dagger_p: 'Lost City', dragon_longsword: 'Lost City', dragon_mace: "Hero's Quest", dragon_battleaxe: "Hero's Quest",
        dragon_halberd: 'Regicide', dragon_sq_shield: "Legends Quest", rune_platebody: 'Dragon Slayer', dragonhide_body: 'Dragon Slayer',
        viking_helmet_crush: 'The Fremennik Trials', viking_helmet_range: 'The Fremennik Trials', viking_helmet_slash: 'The Fremennik Trials', viking_helmet_magic: 'The Fremennik Trials',
        ibanstaff: 'Underground Pass', saradomin_staff: mageArenaQuest, saradomin_cape: mageArenaQuest, guthix_staff: mageArenaQuest, guthix_cape: mageArenaQuest, zamorak_staff: mageArenaQuest, zamorak_cape: mageArenaQuest,
    };
    const VARP_QUEST: Readonly<Record<number, string>> = {
        139: "Legends Quest", 267: mageArenaQuest, 288: 'Underground Pass', 328: 'Regicide', 347: 'The Fremennik Trials',
    };
    // Each quest with the quests that it needs, as content folders (vendor/rs-sdk/server/content/scripts/quests). Lost
    // City stands with the two quests of the planner's chain, which give its Woodcutting and Crafting. The Mage Arena is
    // a minigame with no XP reward: its folder is under areas. Sources: quest_hero.rs2:2-4, legends_guard.rs2:50-53.
    const LOST_CITY = ['quest_drunkmonk', 'quest_murder', 'quest_zanaris'];
    const UPASS = ['quest_elena', 'quest_biohazard', 'quest_upass'];
    const HEROES = [...LOST_CITY, 'quest_dragon', 'quest_arthur', 'quest_blackarmgang', 'quest_hero'];
    const QUEST_CHAIN: Readonly<Record<string, readonly string[]>> = {
        'Lost City': LOST_CITY, 'Dragon Slayer': ['quest_dragon'], 'The Fremennik Trials': ['quest_viking'], [mageArenaQuest]: ['area_mage_arena'], 'Underground Pass': UPASS,
        Regicide: [...UPASS, 'quest_regicide'], "Hero's Quest": HEROES,
        "Legends Quest": [...HEROES, 'quest_crest', 'quest_junglepotion', 'quest_zombiequeen', ...UPASS, 'quest_waterfall', 'quest_legends'],
    };

    // The XP that a list of quests, with the quests they need, gives in a combat skill at the server's rate: the
    // rewards and the fights with a set style.
    const routeXp = (quests: readonly string[], skill: string) => [...new Set(quests.flatMap(q => QUEST_CHAIN[q]!))]
        .reduce((n, folder) => n + rewardsOf(folder).filter(x => x.skill === skill.toLowerCase()).reduce((m, x) => m + x.xp * XP_RATE, 0)
            + (FIGHT_XP[folder] ?? []).filter(x => x.skill === skill.toLowerCase()).reduce((m, x) => m + x.xp, 0), 0);

    // The quest route of a kit: the quests that its items and varps need, and each combat skill that the rewards of
    // those quests and of the quests they need take over the level of the kit, counted from level 1. A kit with an
    // empty `breaks` has a route.
    function kitRoute(name: string): { quests: string[]; breaks: string[] } {
        const k = kitOf(name), levels = kitSkills(name);
        const items = [...Object.values(k.worn).flatMap(w => (typeof w === 'string' ? [w] : Array.isArray(w) ? [w[0]] : [])), ...k.carried.map(c => (typeof c === 'string' ? c : c[0]))];
        const quests = [...new Set([...items.map(i => ITEM_QUEST[i]), ...Object.keys(k.varps ?? {}).map(v => VARP_QUEST[Number(v)])].filter((q): q is string => !!q))].sort();
        const breaks = Object.keys(MAXED).flatMap(skill => {
            const level = levelForXp(routeXp(quests, skill));
            return level > 1 && level > (levels[skill] ?? 1) ? [`${skill} ${level}`] : [];
        });
        const sink = [...new Set(quests.flatMap(q => QUEST_CHAIN[q]!))].find(folder => SINK_XP[folder] && !['Strength', 'Ranged', 'Magic'].some(skill => (levels[skill] ?? 1) >= 99));
        if (quests.includes(mageArenaQuest) && (levels.Prayer ?? 1) < ARENA_PRAYER) breaks.push(`Prayer ${levels.Prayer ?? 1} under the ${ARENA_PRAYER} of the Mage Arena`);
        if (sink) breaks.push(`no skill at 99 for the ${SINK_XP[sink]!.toLocaleString('en-US')} fight XP of ${sink}`);
        return { quests, breaks };
    }

    // Full special energy and each quest of the kit's route done, then the varps of the build. A kit gets no quest that
    // its route does not have.
    const kitVarps = (name: string): Record<number, number> => {
        const varps: Record<number, number> = { 300: 1000 };
        for (const q of kitRoute(name).quests) { const v = QUEST_VARP[q]; if (v) varps[v[0]] = v[1]; }
        return { ...varps, ...kitOf(name).varps };
    };

    // The levels an account of a kit may have before the quests of its route: in each combat skill the highest level
    // from which the rewards of the route end at or under the level of the kit. Hitpoints stay as the kit has them.
    function levelsBeforeRoute(name: string): Record<string, number> {
        const levels = kitSkills(name), quests = kitRoute(name).quests;
        return Object.fromEntries(Object.keys(MAXED).map(skill => {
            let level = levels[skill] ?? 1;
            if (skill !== 'Hitpoints') for (const xp = routeXp(quests, skill); level > 1 && levelForXp(xpForLevel(level) + xp) > (levels[skill] ?? 1);) level--;
            return [skill, level];
        }));
    }

    // Whether a run that gave `gains` XP (whole XP for each skill, lower-case names) to an account at `before` levels
    // leaves every combat skill at or under the level of the kit. The first skill over its level, or null.
    function overBuild(name: string, before: Readonly<Record<string, number>>, gains: Readonly<Record<string, number>>): string | null {
        const levels = kitSkills(name);
        for (const skill of Object.keys(MAXED)) {
            const after = levelForXp(xpForLevel(before[skill] ?? 1) + (gains[skill.toLowerCase()] ?? 0));
            if (skill !== 'Hitpoints' && after > (levels[skill] ?? 1)) return `${skill} ${after}`;
        }
        return null;
    }

    return { QUEST_VARP, QUEST_CHAIN, kitRoute, kitVarps, levelsBeforeRoute, overBuild };
}
