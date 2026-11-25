import { readFileSync } from 'node:fs';
import { questDefinitions, questFlags } from './quest-status';

export interface GuildActorFacts {
    varps: Record<string, number>;
    questStages: Record<string, number>;
    unlocks: string[];
    castlewarsTeam?: 0 | 1;
}
export interface GuildRefreshResult extends GuildActorFacts { admission?: { legendsEntry: 'crossed'|'refused'|'unknown' } }
const evidence = new WeakMap<object, { stages: Record<string,number>; unlocks: Set<string> }>();
// A green questlist entry adds the unlock `complete:<varp>` (never an exact stage): knowledge/quests.json holds each
// quest's varp and completion value (scripts/general/scripts/quests.rs2). A questlist component is named after its quest
// folder (quest_<name>); the one exception is fortress (quest_blackknight). travelAllowed (travel.ts) takes the unlock
// for a need of exactly that completion value while the stage is unknown: the Tree Gnome Village spirit trees need
// treequest = 9 (spirit_tree.rs2:26). The Grand Tree keeps its own glider admission.
let finals: Map<string, { varp: string; complete: number }> | undefined;
export const questFinals = () => finals ??= new Map((JSON.parse(readFileSync(new URL('../../../knowledge/quests.json', import.meta.url), 'utf8')) as { folder?: string | null; varp?: string; complete?: number }[])
    .filter(q => q.folder && q.varp && Number.isInteger(q.complete)).map(q => [q.folder!, { varp: q.varp!, complete: q.complete! }]));
export const questFolder = (key: string) => `quest_${key === 'fortress' ? 'blackknight' : key}`;let keys: Map<number, string> | undefined;
const questKeys = () => keys ??= new Map(questDefinitions().map(q => [q.id, q.key]));
// The completion unlocks of the client's green questlist entries, for the router's account (door-policy accountForSdk).
// They stay out of guildActorFacts, which the status file publishes.
export function completedQuestUnlocks(client: any): string[] {
    if (!client || client.ingame !== true) return [];
    const out: string[] = [];
    for (const q of questFlags(client) ?? []) {
        const key = q.state === 'complete' ? questKeys().get(q.id) : undefined;
        const final = key && key !== 'grandtree' ? questFinals().get(questFolder(key)) : undefined;
        if (final) out.push(`complete:${final.varp}`);
    }
    return out;
}
export const cleanGuildText = (v: unknown) => String(v ?? '').replace(/@[^@]{3}@/g, '').replace(/<[^>]*>/g, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
/** Returns the per-client mutable store backing observed guild stages and unlocks. */
export function savedGuildEvidence(client: object) {
    let value = evidence.get(client);
    if (!value) { value = { stages: {}, unlocks: new Set() }; evidence.set(client, value); }
    return value;
}

// The returned stages are observed lower bounds, never exact private varp values.
// Sources: pinned quest journals, questlist IF_SETCOLOUR and CW team overlays.
export function guildActorFacts(client: any, state?: any): GuildActorFacts {
    const facts: GuildActorFacts = { varps: {}, questStages: {}, unlocks: [] };
    if (!client || client.ingame !== true) return facts;
    const prior = savedGuildEvidence(client);
    facts.questStages = { ...prior.stages };
    facts.unlocks = [...prior.unlocks];
    // varServ is only written by incoming VARP packets; client.var includes local writes.
    const qp = client.varServ?.[101];
    if (Number.isInteger(qp) && qp > 0) facts.varps.qp = qp;
    for (const q of questFlags(client) ?? []) {
        // Green is completion, not an exact private stage. The native map is the final glider admission.
        if (q.id === 7361 && q.state === 'complete' && client.membersAccount === 1 && state?.inGame !== false) facts.unlocks.push('grandtree-glider');
        const key = q.id === 7363 ? 'heroquest' : q.id === 7366 ? 'legendsquest' : q.id === 7356 ? 'mcannon' : undefined;
        if (!key) continue;
        const bound = q.state === 'complete' ? (key === 'heroquest' ? 15 : key === 'legendsquest' ? 75 : 11)
            : q.state === 'started' ? 1 : 0;
        if (bound) facts.questStages[key] = Math.max(facts.questStages[key] ?? 0, bound);
    }
    const p = state?.player;
    const x = p?.worldX, z = p?.worldZ;
    const inGame = Number.isInteger(p?.level) && p.level >= 0 && p.level <= 3 && x >= 2368 && x <= 2431
        && ((z >= 3072 && z <= 3135) || (p.level === 0 && z >= 9472 && z <= 9535));
    const waiting = p?.level === 0 && z >= 9472 && ((x <= 2393 && z <= 9497) || (x >= 2408 && z >= 9512));
    if (inGame && !waiting && client.mainOverlayId === 11146) facts.castlewarsTeam = 0;
    if (inGame && !waiting && client.mainOverlayId === 11344) facts.castlewarsTeam = 1;
    return facts;
}

// Parses the %priestperil (302) stage from priestperil_journal.rs2 text, checked from the highest stage down.
export function priestPerilJournalStage(body: string): number | undefined {
    const text = body.replace(/@[a-z0-9]+@/gi, '').replace(/<[^>]*>/g, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
    if (/QUEST COMPLETE!/i.test(text)) return 60;
    if (/I need to bring Drezel fifty rune essences/i.test(text)) return 10;
    if (/I should head downstairs to the monument like Drezel asked/i.test(text)) return 8;
    if (/I should speak to Drezel again/i.test(text)) return 7;
    if (/but I still have to do something about that vampire/i.test(text)) return 6;
    if (/I need to find the key to his cell and free him/i.test(text)) return 5;
    if (/I must return to the temple and find out what happened to the real Drezel/i.test(text)) return 4;
    if (/I should tell King Roald everything's fine with Drezel now I have killed that dog/i.test(text)) return 3;
    if (/He told me that there was an annoying dog below the temple, and has asked me to kill it for him/i.test(text)) return 2;
    if (/I spoke to King Roald who asked me to investigate why his friend Priest Drezel has stopped communicating with him/i.test(text)
        && /Drezel lives in a temple to the east of Varrock Palace/i.test(text)) return 1;
    if (/I can start this quest by speaking to King Roald/i.test(text)) return 0;
    return undefined;
}

// Quests whose journal names the stage that their gates test (quest varps never reach the client). A walk with no route
// reads the journal of each one that the quest list shows started, and plans again with the stage as a lower bound:
// an account between the Paterdomus gates (gates.rs2) has a route out only from %priestperil 5.
export const JOURNAL_STAGES: readonly { varp: string; questId: number; title: string; stage: (body: string) => number | undefined }[] = [
    { varp: 'priestperil', questId: 8115, title: 'Priest in Peril', stage: priestPerilJournalStage },
];
export function startedJournalQuests(client: any): string[] {
    const flags = questFlags(client) ?? [];
    return JOURNAL_STAGES.filter(j => flags.some(q => q.id === j.questId && q.state === 'started')).map(j => j.varp);
}

export function journalGuildStage(title: string, body: string): { key: string; lowerBound: number } | null {
    title = cleanGuildText(title); body = cleanGuildText(body);
    for (const j of JOURNAL_STAGES) {
        if (title !== j.title) continue;
        const stage = j.stage(body);
        return stage === undefined ? null : { key: j.varp, lowerBound: stage };
    }
    if (title === 'Dwarf Cannon') {
        if (/The Commander has asked me to check up on his guards at the watchtower to the South of his camp\./.test(body)
            || /I went to the watchtower where I found some dwarf remains\./.test(body)) return { key: 'mcannon', lowerBound: 2 };
        // These later pages independently establish that the guarded tower step passed.
        if (/I gave the remains to the Commander\.|I found the Goblin's base\. Next I need to find the Dwarf child\.|I have rescued the dwarf child|fix the multicannon|fixed the broken multicannon|Nulodion the Cannon Engineer|I've spoken to Nulodion, He gave me an ammo mould and notes,|buy a multicannon/.test(body)) return { key: 'mcannon', lowerBound: 2 };
    }
    if (title === 'The Legends Quest' && (/Radimus asked me to join him inside the Legends Guild to discuss my reward\./.test(body)
        || /The gilded totem pole is on display in the Legends Guild/.test(body))) return { key: 'legendsquest', lowerBound: 50 };
    return null;
}
