// Run several quests on one account, one after another, with scripts/quest-sweep.ts (each run takes the quest's
// pack from the bank, walks to its start and logs out). A quest the status file shows complete is skipped. A failed
// quest is logged and the chain goes on to the next. A stop, death or disconnect ends the chain.
// Usage: bun scripts/quest-chain.ts <account> <quest,quest,...>   e.g. bun scripts/quest-chain.ts Bigchopper cook,sheep
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// In a bot host this import is rewritten to the host's per-bot openBot and finish (packages/core/src/host.ts).
import { openBot as hostOpenBot, finish as botFinish, settle, finishHooks, openHooks } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { runDirectChild } from '../packages/core/src/run-child';

const root = resolve(import.meta.dir, '..');
// Script name (scripts/generated/quest-<name>.ts) -> quest name in the status file.
export const QUEST_NAMES: Record<string, string> = {
    cook: "Cook's Assistant", sheep: 'Sheep Shearer', rj: 'Romeo & Juliet', runemysteries: 'Rune Mysteries Quest',
    druid: 'Druidic Ritual', gobdip: 'Goblin Diplomacy', doric: "Doric's Quest", fluffs: "Gertrude's Cat",
    sheepherder: 'Sheep Herder', hazeelcult: 'Hazeel Cult', prince: 'Prince Ali Rescue', imp: 'Imp Catcher',
    hetty: "Witch's Potion", haunted: 'Ernest the Chicken', blackknight: "Black Knight's Fortress", demon: 'Demon Slayer',
    dig: 'Digsite Quest', drunkmonk: "Monk's Friend", fishingcompo: 'Fishing Contest', elemental: 'Elemental Workshop',
    priest: 'The Restless Ghost', vampire: 'Vampire Slayer', squire: "The Knight's Sword", arrav: 'Shield of Arrav',
    murder: 'Murder Mystery', death: 'Death Plateau', tree: 'Tree Gnome Village', grandtree: 'The Grand Tree',
    junglepotion: 'Jungle Potion', merlin: "Merlin's Crystal", seaslug: 'Sea Slug Quest', scorpion: 'Scorpion Catcher',
    arena: "Fight Arena", ball: "Witch's House", biohazard: "Biohazard", chompybird: "Big Chompy Bird Hunting",
    cog: "Clock Tower", crest: "Family Crest", desertrescue: "The Tourist Trap", dragon: "Dragon Slayer",
    druidspirit: "Nature Spirit", eadgar: "Eadgar's Ruse", elena: "Plague City", grail: "Holy Grail",
    hauntedmine: "Haunted Mine", hero: "Hero's Quest", horror: "Horror from the Deep", hunt: "Pirate's Treasure", legends: "Legends Quest",
    ikov: "Temple of Ikov", itgronigen: "Observatory Quest", itwatchtower: "Watch Tower",
    misc: "Throne of Miscellania", mm: "Monkey Madness", mortton: "Shades of Mortton",
    priestperil: "Priest in Peril", regicide: "Regicide", routequest: "In Search of the Myreque",
    tbwt: "Tai Bwo Wannai Trio", totem: "Tribal Totem", troll: "Troll Stronghold", trolllove: "Troll Romance",
    upass: "Underground Pass", viking: "The Fremennik Trials", zanaris: "Lost City", zombiequeen: "Shilo Village",
};

// Skill levels a quest checks before it can finish. Sea Slug: the dry sticks light only at Firemaking 30
// (quest_seaslug.rs2:43). Fishing Contest: the contest needs Fishing 10 (hemenster_fishing.rs2:70). Digsite: the exam
// and the site want Herblore 10, Agility 10 and Thieving 25 (quest_itexam stat_base checks). Elemental Workshop: the
// workshop wants Mining, Smithing and Crafting 20 (quest_elemental_workshop stat_base checks). Jungle Potion: identifying
// the snake weed wants Herblore 3 (skill_herblore identify.rs2; Druidic Ritual's reward), else "You need a higher Herblore
// level" ends the quest at its first herb. Fishing Contest's Fishing 10 is not a gate: the sweep nets shrimps to it
// (quest-sweep.ts questSkillTraining). Lost City: the dramen tree wants Woodcutting 36 and the staff Crafting 31
// (quest_zanaris.rs2:37,78); Monk's Friend gives Woodcutting 56 and Murder Mystery Crafting 51 at this server's 25
// times experience (stat_advance 20000 and 14060 tenths), so a chain that runs them first meets both. Underground
// Pass: the cage doors want Thieving 50 (quest_upass.rs2:248). Regicide: the Tirannwn crossings want Agility 56
// (quest_regicide.rs2:404), the loom Crafting 10 (:674) and the Ardougne teleport of the quest script Magic 51.
export const QUEST_SKILLS: Record<string, Record<string, number>> = {
    seaslug: { firemaking: 30 }, junglepotion: { herblore: 3 }, zanaris: { woodcutting: 36, crafting: 31 },
    dig: { herblore: 10, agility: 10, thieving: 25 }, elemental: { mining: 20, smithing: 20, crafting: 20 },
    upass: { thieving: 50 }, regicide: { agility: 56, crafting: 10, magic: 51 },
};
// The skills a quest needs that the account lacks, as "skill have/need"; empty when it can run.
export function questShortfall(quest: string, skills: { name: string; level: number }[] | undefined): string[] {
    const have = new Map((skills ?? []).map(s => [s.name.toLowerCase(), s.level]));
    return Object.entries(QUEST_SKILLS[quest] ?? {}).flatMap(([k, need]) => (have.get(k) ?? 1) < need ? [`${k} ${have.get(k) ?? 1}/${need}`] : []);
}

// A death is `RESULT fail died` or `died=true`; every quest result prints `died=false`.
export const questDied = (result: string) => /^RESULT fail died\b/.test(result) || /\bdied=true\b/.test(result);

export function questsLeft(quests: string[], statusQuests: { name: string; state: string }[] | undefined): string[] {
    const done = new Set((statusQuests ?? []).filter(q => q.state === 'complete').map(q => q.name.toLowerCase()));
    return quests.filter(q => !done.has((QUEST_NAMES[q] ?? q).toLowerCase()));
}

export async function runQuestChain(quests: string[], deps: {
    status: () => { quests?: Parameters<typeof questsLeft>[1]; skills?: Parameters<typeof questShortfall>[1] };
    stopped: () => boolean;
    run: (quest: string) => Promise<string>;
    log: (line: string) => void;
}): Promise<string> {
    const done: string[] = [], failed: string[] = [];
    const summary = (prefix: string) => `${prefix} quest-chain done=${done.join(',') || '-'} failed=${failed.join(',') || '-'}`;
    for (const q of quests) {
        if (deps.stopped()) return summary('RESULT fail stop file');
        const status = deps.status();
        if (!questsLeft([q], status.quests).length) continue;
        const short = questShortfall(q, status.skills);
        if (short.length) { deps.log(`QUEST_CHAIN ${q} skip needs ${short.join(', ')}`); continue; }
        const result = await deps.run(q);
        const died = questDied(result);
        const ok = !died && result.startsWith('RESULT ok');
        (ok ? done : failed).push(q);
        deps.log(`QUEST_CHAIN ${q} ${ok ? 'ok' : 'fail'} ${result.slice(0, 200)}`);
        if (died) return summary(`RESULT fail died during ${q}`);
        if (deps.stopped() || /^RESULT fail (?:stop file\b|quest-sweep \S+ Error: worker finished: stop file$)/.test(result)) {
            return summary('RESULT fail stop file');
        }
        if (/^RESULT fail session ended\b/.test(result)) return summary(result.slice(0, 200));
    }
    if (deps.stopped()) return summary('RESULT fail stop file');
    return summary(done.length ? 'RESULT ok' : 'RESULT fail');
}

if (import.meta.main) {
    // The list may arrive as one comma-joined argument or, from a host job (--args a,b), as several.
    const [account, ...rest] = process.argv.slice(2), list = rest.join(",");
    if (!account || !list) { console.log('RESULT fail usage: quest-chain.ts <account> <quest,quest,...>'); process.exit(2); }
    const status = () => { try { return JSON.parse(readFileSync(join(root, '.practice/status', `${account}.json`), 'utf8')); } catch { return {}; } };
    const result = await runQuestChain(list.split(','), {
        status, stopped: () => existsStop(account),
        run: q => hosted() ? inProcess(account, q) : subprocess(account, q),
        log: line => console.log(line),
    });
    console.log(result);
    process.exit(result.startsWith('RESULT ok') ? 0 : 1);
}
// In a bot host (packages/core/src/host.ts) many accounts share this process: the quest runs here, and finish()
// reports through bot.ts finishHooks instead of exiting. Alone, each quest runs in its own process.
function hosted() { return !!(globalThis as { __rsBotHost?: unknown }).__rsBotHost; }
async function inProcess(account: string, quest: string): Promise<string> {
    const { sweep } = await import('./quest-sweep');
    const key = account.toLowerCase();
    let opened: Session | undefined;
    // Logins for this account go through the host's openBot; its stop and session-end callbacks settle through
    // bot.ts finish, which the finish hook turns into this quest's result.
    openHooks.set(key, async (name, opts) => opened = await hostOpenBot(name, { ...opts, onStop: opts?.onStop ?? ((s, d) => botFinish([s], false, d)), onSessionEnd: opts?.onSessionEnd ?? ((s, d) => botFinish([s], false, d)) }));
    const ended = new Promise<string>(resolve => finishHooks.set(key, (ok, detail) => resolve(`RESULT ${ok ? 'ok' : 'fail'} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)));
    const crashed = sweep(account, quest, `run=${key}-${Date.now()}`).then(() => new Promise<string>(() => {}), e => `RESULT fail ${String(e).slice(0, 300)}`);
    try {
        const result = await Promise.race([ended, crashed]);
        // A crashed quest leaves its session open: log it out before the next quest logs in again (settle runs once
        // per session, so a session finish() already settled is not settled twice).
        if (opened && result.startsWith('RESULT fail')) await settle([opened], false, result);
        return result;
    } finally { finishHooks.delete(key); openHooks.delete(key); }
}
// The child's START, LEDGER and RESULT lines pass through, so a supervisor of the chain sees each quest's session.
function subprocess(account: string, quest: string): Promise<string> { return runDirectChild(['scripts/quest-sweep.ts', account, quest]); }
function existsStop(a: string) { try { readFileSync(join(root, '.practice', `stop-${a}`)); return true; } catch { return false; } }
