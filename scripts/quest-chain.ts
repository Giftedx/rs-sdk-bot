// Run several quests on one account, one after another, with scripts/quest-sweep.ts (each run takes the quest's
// pack from the bank, walks to its start and logs out). A quest the status file shows complete is skipped. A failed
// quest is logged and the chain goes on to the next; a death ends the chain. Prints QUEST_CHAIN per quest and RESULT.
// Usage: bun scripts/quest-chain.ts <account> <quest,quest,...>   e.g. bun scripts/quest-chain.ts Bigchopper cook,sheep
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

// A death is `RESULT fail died` or `died=true`; every quest result prints `died=false`.
export const questDied = (result: string) => /^RESULT fail died\b/.test(result) || /\bdied=true\b/.test(result);

export function questsLeft(quests: string[], statusQuests: { name: string; state: string }[] | undefined): string[] {
    const done = new Set((statusQuests ?? []).filter(q => q.state === 'complete').map(q => q.name.toLowerCase()));
    return quests.filter(q => !done.has((QUEST_NAMES[q] ?? q).toLowerCase()));
}

if (import.meta.main) {
    const [account, list] = process.argv.slice(2);
    if (!account || !list) { console.log('RESULT fail usage: quest-chain.ts <account> <quest,quest,...>'); process.exit(2); }
    const status = () => { try { return JSON.parse(readFileSync(join(root, '.practice/status', `${account}.json`), 'utf8')); } catch { return {}; } };
    const done: string[] = [], failed: string[] = [];
    for (const q of questsLeft(list.split(','), status().quests)) {
        if (!questsLeft([q], status().quests).length) continue;
        const p = Bun.spawn(['bun', 'scripts/quest-sweep.ts', account, q], { cwd: root, stdout: 'pipe', stderr: 'inherit', windowsHide: true, env: process.env });
        let out = '';
        // Child lines are indented: the supervisor reads only this chain's own RESULT line.
        for await (const c of p.stdout) { const t = new TextDecoder().decode(c); out += t; process.stdout.write(t.replace(/^(?=.)/gm, '  | ')); }
        await p.exited;
        const result = out.split(/\r?\n/).filter(l => l.startsWith('RESULT')).at(-1) ?? 'RESULT fail no result';
        const ok = result.startsWith('RESULT ok');
        (ok ? done : failed).push(q);
        console.log(`QUEST_CHAIN ${q} ${ok ? 'ok' : 'fail'} ${result.slice(0, 200)}`);
        if (questDied(result)) { console.log(`RESULT fail died during ${q} done=${done.join(',')} failed=${failed.join(',')}`); process.exit(1); }
        if (existsStop(account)) break;
    }
    console.log(`RESULT ${done.length ? 'ok' : 'fail'} quest-chain done=${done.join(',') || '-'} failed=${failed.join(',') || '-'}`);
    process.exit(done.length ? 0 : 1);
}
function existsStop(a: string) { try { readFileSync(join(root, '.practice', `stop-${a}`)); return true; } catch { return false; } }
