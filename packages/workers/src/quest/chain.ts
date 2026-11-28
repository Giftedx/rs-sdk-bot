// Run several quests on one account, one after another, with quest sweep (each run takes the quest's
// pack from the bank, walks to its start and logs out). A quest the status file shows complete is skipped. A failed
// quest is logged and the chain goes on to the next. A stop, death or disconnect ends the chain.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../../../core/src/inprocess';
import { REPO_ROOT } from './types';

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

export const QUEST_SKILLS: Record<string, Record<string, number>> = {
    seaslug: { firemaking: 30 }, junglepotion: { herblore: 3 }, zanaris: { woodcutting: 36, crafting: 31 },
    dig: { herblore: 10, agility: 10, thieving: 25 }, elemental: { mining: 20, smithing: 20, crafting: 20 },
    upass: { thieving: 50 }, regicide: { agility: 56, crafting: 10, magic: 51 },
    ikov: { ranged: 40, thieving: 42, prayer: 37 },
    desertrescue: { fletching: 10, smithing: 20 },
    horror: { agility: 35, prayer: 40 },
    zombiequeen: { crafting: 20, agility: 32 },
    chompybird: { fletching: 5, cooking: 30, ranged: 30 },
    viking: { woodcutting: 40, crafting: 40, fletching: 25 },
    itwatchtower: { magic: 14, thieving: 15, agility: 25, herblore: 14, mining: 40 },
    mortton: { crafting: 20, herblore: 15, firemaking: 5 },
    routequest: { agility: 25 },
    troll: { agility: 15, thieving: 30, prayer: 43 },
    trolllove: { agility: 28, prayer: 43 },
    eadgar: { herblore: 31, prayer: 40 },
    hauntedmine: { agility: 15, crafting: 35, prayer: 40 },
    crest: { mining: 40, crafting: 40, smithing: 40, magic: 59 },
    hero: { cooking: 53, fishing: 53, herblore: 25, mining: 50 },
    magearena: { magic: 60, prayer: 37 },
    tbwt: { agility: 15, cooking: 30, fishing: 5, firemaking: 30 },
    misc: { herblore: 35, woodcutting: 45 },
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

function hosted() {
    return !!(globalThis as { __rsBotHost?: unknown }).__rsBotHost;
}

async function inProcess(account: string, quest: string): Promise<string> {
    const [{ openBot: hostOpenBot, finish: botFinish, settle, finishHooks, openHooks }, { getQuestRuntime }] = await Promise.all([
        import('../../../core/src/bot'),
        import('./runtime'),
    ]);
    const sweep = getQuestRuntime().sweep;
    if (!sweep) throw Error('quest chain: runtime sweep handler not registered');
    const key = account.toLowerCase();
    let opened: Session | undefined;
    openHooks.set(key, async (name, opts) =>
        opened = await hostOpenBot(name, {
            ...opts,
            onStop: opts?.onStop ?? ((s, d) => botFinish([s], false, d)),
            onSessionEnd: opts?.onSessionEnd ?? ((s, d) => botFinish([s], false, d)),
        }),
    );
    const ended = new Promise<string>(resolve =>
        finishHooks.set(key, (ok, detail) =>
            resolve(`RESULT ${ok ? 'ok' : 'fail'} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`),
        ),
    );
    const crashed = sweep(account, quest, `run=${key}-${Date.now()}`).then(
        () => new Promise<string>(() => {}),
        e => `RESULT fail ${String(e).slice(0, 300)}`,
    );
    try {
        const result = await Promise.race([ended, crashed]);
        if (opened && result.startsWith('RESULT fail')) await settle([opened], false, result);
        return result;
    } finally {
        finishHooks.delete(key);
        openHooks.delete(key);
    }
}

async function subprocess(account: string, quest: string): Promise<string> {
    const { runDirectChild } = await import('../../../core/src/run-child');
    return runDirectChild(['scripts/aio-quester.ts', account, 'sweep', quest]);
}

function existsStop(a: string) {
    try {
        readFileSync(join(REPO_ROOT, '.practice', `stop-${a}`));
        return true;
    } catch {
        return false;
    }
}

export async function runQuestChainFromAccount(account: string, quests: string[]): Promise<{ ok: boolean; result: string }> {
    const status = () => {
        try {
            return JSON.parse(readFileSync(join(REPO_ROOT, '.practice/status', `${account}.json`), 'utf8'));
        } catch {
            return {};
        }
    };
    const result = await runQuestChain(quests, {
        status,
        stopped: () => existsStop(account),
        run: q => (hosted() ? inProcess(account, q) : subprocess(account, q)),
        log: line => console.log(line),
    });
    return { ok: result.startsWith('RESULT ok'), result };
}
