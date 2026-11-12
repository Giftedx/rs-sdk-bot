// Vampire Slayer from preset quest_vampire (in Morgan's house, Draynor; every skill 99, rune scimitar; beer, hammer,
// garlic and two Varrock teleports from a helper). Reward: 3 QP, 4,825 Attack XP before 25x (quest_vampire.rs2:41-45).
// Varp %vampire: 0 -> 1 Morgan, 2 Harlow, then the beer gives the stake; Count Draynor killed with stake and hammer
// in the pack queues the completion (count_draynor.rs2:49-80).
// Server truth: areas/area_draynor/scripts/morgan.rs2, areas/area_varrock/scripts/harlow.rs2,
// quests/quest_vampire/scripts/quest_vampire.rs2 (coffin loc_2614 spawns the Count), count_draynor.rs2.
import { openQuest } from './quest-lib';
import { questFlags, type QuestFlag } from '../../packages/core/src/quest-status';

const MORGAN = { x: 3098, z: 3268 };
const HARLOW = { x: 3277, z: 3492 };
const STAIRS = { id: 2616, x: 3115, z: 3357 };            // cryptstairsdown, to 3077,9771 (stairs.rs2:408-416)
const COFFIN = { id: 2614, x: 3077, z: 9775 };
const ITEM = { beer: 1917, stake: 1549, hammer: 2347, garlic: 1550 };

// The talks still to do, from the observed quest list and pack. Morgan's opening runs only at %vampire 0; at 1 and 2
// he says "How are you doing with the quest?" and sets nothing (morgan.rs2:3-9,32-35). The quest list shows 1 and 2
// both as started, so one Harlow talk takes either branch (harlow.rs2:1-7); a held stake needs no Harlow talk.
export function vampireOpening(state: QuestFlag['state'], stake: boolean): { morgan: boolean; harlow: boolean } {
    if (state === 'unknown') throw Error('Vampire Slayer quest state unknown');
    if (state === 'complete') throw Error('Vampire Slayer already complete');
    return { morgan: state === 'not started', harlow: !stake };
}

// Run directly, or imported by scripts/quest-sweep.ts (openQuest takes its session from globalThis.QUEST_SESSION).
if (import.meta.main || (globalThis as { QUEST_SESSION?: unknown }).QUEST_SESSION) {
    // CAP is a game-tick budget; the Magic-1 walk to Varrock and back needs more than the teleport route.
    const cap = Number(process.env.CAP ?? 1500);
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('Vampire CAP must be a positive integer');
    const q = await openQuest({ cap });
    try {
        const state = () => questFlags(q.s.client)?.find(f => f.name === 'Vampire Slayer')?.state ?? 'unknown';
        if (!await q.waitUntil(() => state() !== 'unknown' && Array.isArray(q.st()?.inventory) && !!q.pos(), 20))
            throw Error('Vampire entry state unobserved within deadline');
        const opening = vampireOpening(state(), q.has(ITEM.stake));
        if (!q.has(ITEM.hammer) || !q.has(ITEM.garlic) || (opening.harlow && !q.has(ITEM.beer)))
            throw Error(`Vampire requires hammer, garlic${opening.harlow ? ' and beer' : ''}`);
        const beer0 = q.cnt(ITEM.beer);
        const harlow = /^dr harlow$/i;

        // 1. Morgan: "Ok, I'm up for an adventure." sets 1 (morgan.rs2:11-26).
        if (opening.morgan) {
            await q.talk('morgan', /^morgan$/i, [/up for an adventure/i], () => state() === 'started', MORGAN);
            q.milestone(1);
        }

        // 2. Varrock teleport (or the walk without the Magic level or a law rune); the Jolly Boar Inn. At 1 "Morgan
        // needs your help" sets 2 and the talk ends; at 2 the talk takes the beer and gives the stake (harlow.rs2:9-55).
        if (opening.harlow) {
            await q.teleport('varrock teleport 1', 'magic:varrock_teleport', 3212, 3424);
            await q.walk('to harlow', [{ x: HARLOW.x, z: HARLOW.z, tol: 3 }]);
            await q.talk('harlow 1', harlow, [/morgan needs your help/i, /ok mate/i], () => q.sawText(/buy ush a drink anyway/i) || q.has(ITEM.stake), HARLOW);
            q.milestone(2);
            if (!q.has(ITEM.stake)) await q.talk('harlow 2', harlow, [/ok mate/i], () => q.has(ITEM.stake), HARLOW, 60);
            if (!await q.waitUntil(() => q.has(ITEM.stake) && q.cnt(ITEM.beer) === beer0 - 1, 5))
                throw Error('Harlow stake credit or beer debit unobserved');
            q.milestone('stake');
            // 3. Varrock teleport, the walk to Draynor Manor.
            await q.teleport('varrock teleport 2', 'magic:varrock_teleport', 3212, 3424);
        }
        // The front doors open from the south only (quest_haunted.rs2:4-11).
        await q.walk('to manor', [{ x: 3108, z: 3352, tol: 1 }]);
        const inManor = () => (q.pos()?.worldZ ?? 0) >= 3354 && (q.pos()?.worldZ ?? 0) < 9000;
        await q.step('manor door', () => { const d = q.findLoc(l => (l.id === 134 || l.id === 135) && l.z === 3353); return d ? q.opLoc(d, 1) : q.waitTicks(1); }, inManor, 8, 4);
        // Inside, the SDK plan goes through closet_door 131 at 3107,3367, which is locked (91-92 ticks stood there in two
        // trials). The way to the crypt stairs (maps/m48_52.jm2): hall door loc_1530 at 3109,3358, the north room, door
        // loc_1530 at 3106,3368, the north corridor, the east rooms (3114-3118,3362-3367), the 3118-3119 passage south.
        await q.openDoor('hall door', 3109, 3358);
        await q.dash('north room', 3106, 3367, 0);
        await q.openDoor('corridor door', 3106, 3368);
        await q.dash('corridor', 3114, 3370, 0);
        await q.dash('east room', 3118, 3362, 1);
        await q.dash('to crypt stairs', STAIRS.x, STAIRS.z - 1, 0);
        await q.climb('crypt stairs', () => q.locAt(STAIRS.x, STAIRS.z) ?? STAIRS, /walk-down|climb-down|go-down/i, () => (q.pos()?.worldZ ?? 0) > 9000);
        q.milestone('crypt');

        // 4. The coffin spawns the Count after p_delay(4) (quest_vampire.rs2:9-31). Garlic in the pack weakens him on his
        // first hit (count_draynor.rs2:6-17); at 0 HP the stake and hammer finish him (:57-80).
        await q.step('coffin', () => { const c = q.findLoc(l => l.x === COFFIN.x && l.z === COFFIN.z); return c ? q.opLoc(c, 1) : q.opLoc(COFFIN, 1); }, () => !!q.npc(/^count draynor$/i), 10, 4);
        q.milestone('count');
        const done = () => state() === 'complete';
        const attack = (n: any) => q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
        for (let t = 0; t < 200 && !done(); t++) {
            await q.guard('count');
            const n = q.npc(/^count draynor$/i);
            if (n && q.has(ITEM.stake) && t % 4 === 0) await attack(n);
            if (!n && q.has(ITEM.stake) && t % 10 === 9) await q.opLoc(COFFIN, 1);
            await q.waitTicks(1);
        }
        // The stake is debited before the completion queue (count_draynor.rs2:73-80).
        if (!done() || q.has(ITEM.stake)) throw Error(`Vampire completion unobserved: state=${state()} stake=${q.cnt(ITEM.stake)}`);
        q.milestone(3);
        await q.end(true, `qp=3 flag=complete stakeUsed=true beerUsed=${beer0 - q.cnt(ITEM.beer)}`);
    } catch (e) { await q.fail(String(e)); }
}
