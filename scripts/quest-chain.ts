// Run several quests on one account, one after another, with scripts/quest-sweep.ts (each run takes the quest's
// pack from the bank, walks to its start and logs out). A quest the status file shows complete is skipped. A failed
// quest is logged and the chain goes on to the next; a death ends the chain. Prints QUEST_CHAIN per quest and RESULT.
// Usage: bun scripts/quest-chain.ts <account> <quest,quest,...>   e.g. bun scripts/quest-chain.ts Bigchopper cook,sheep
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// In a bot host this import is rewritten to the host's per-bot openBot and finish (packages/core/src/host.ts).
import { openBot as hostOpenBot, finish as botFinish, settle, finishHooks, openHooks } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';

const root = resolve(import.meta.dir, '..');
// Script name (scripts/generated/quest-<name>.ts) -> quest name in the status file.
export const QUEST_NAMES: Record<string, string> = {
    cook: "Cook's Assistant", sheep: 'Sheep Shearer', rj: 'Romeo & Juliet', runemysteries: 'Rune Mysteries Quest',
    druid: 'Druidic Ritual', gobdip: 'Goblin Diplomacy', doric: "Doric's Quest", fluffs: "Gertrude's Cat",
    sheepherder: 'Sheep Herder', hazeelcult: 'Hazeel Cult', prince: 'Prince Ali Rescue', imp: 'Imp Catcher',
    hetty: "Witch's Potion", haunted: 'The Restless Ghost', blackknight: "Black Knight's Fortress", demon: 'Demon Slayer',
    dig: 'Digsite Quest', drunkmonk: "Monk's Friend", fishingcompo: 'Fishing Contest', elemental: 'Elemental Workshop',
    priest: 'Priest in Peril', vampire: 'Vampire Slayer', squire: "The Knight's Sword", arrav: 'Shield of Arrav',
    murder: 'Murder Mystery', death: 'Death Plateau', tree: 'Tree Gnome Village', grandtree: 'The Grand Tree',
    junglepotion: 'Jungle Potion', merlin: "Merlin's Crystal", seaslug: 'Sea Slug Quest', scorpion: 'Scorpion Catcher',
};

// Skill levels a quest checks before it can finish. Sea Slug: the dry sticks light only at Firemaking 30
// (quest_seaslug.rs2:43). Fishing Contest: the contest needs Fishing 10 (hemenster_fishing.rs2:70).
export const QUEST_SKILLS: Record<string, Record<string, number>> = { seaslug: { firemaking: 30 }, fishingcompo: { fishing: 10 } };
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

if (import.meta.main) {
    // The list may arrive as one comma-joined argument or, from a host job (--args a,b), as several.
    const [account, ...rest] = process.argv.slice(2), list = rest.join(",");
    if (!account || !list) { console.log('RESULT fail usage: quest-chain.ts <account> <quest,quest,...>'); process.exit(2); }
    const status = () => { try { return JSON.parse(readFileSync(join(root, '.practice/status', `${account}.json`), 'utf8')); } catch { return {}; } };
    const done: string[] = [], failed: string[] = [];
    for (const q of questsLeft(list.split(','), status().quests)) {
        if (!questsLeft([q], status().quests).length) continue;
        const short = questShortfall(q, status().skills);
        if (short.length) { console.log(`QUEST_CHAIN ${q} skip needs ${short.join(', ')}`); continue; }
        const result = hosted() ? await inProcess(account, q) : await subprocess(account, q);
        const ok = result.startsWith('RESULT ok');
        (ok ? done : failed).push(q);
        console.log(`QUEST_CHAIN ${q} ${ok ? 'ok' : 'fail'} ${result.slice(0, 200)}`);
        if (questDied(result)) { console.log(`RESULT fail died during ${q} done=${done.join(',')} failed=${failed.join(',')}`); process.exit(1); }
        if (existsStop(account)) break;
    }
    console.log(`RESULT ${done.length ? 'ok' : 'fail'} quest-chain done=${done.join(',') || '-'} failed=${failed.join(',') || '-'}`);
    process.exit(done.length ? 0 : 1);
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
async function subprocess(account: string, quest: string): Promise<string> {
    const p = Bun.spawn(['bun', 'scripts/quest-sweep.ts', account, quest], { cwd: root, stdout: 'pipe', stderr: 'inherit', windowsHide: true, env: process.env });
    let out = '';
    // Child lines are indented: the supervisor reads only this chain's own RESULT line.
    for await (const c of p.stdout) { const t = new TextDecoder().decode(c); out += t; process.stdout.write(t.replace(/^(?=.)/gm, '  | ')); }
    await p.exited;
    return out.split(/\r?\n/).filter(l => l.startsWith('RESULT')).at(-1) ?? 'RESULT fail no result';
}
function existsStop(a: string) { try { readFileSync(join(root, '.practice', `stop-${a}`)); return true; } catch { return false; } }
