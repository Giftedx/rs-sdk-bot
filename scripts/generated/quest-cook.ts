// Cook's Assistant with supplied ingredients, including the quest-items-order Draynor endpoint.
// Server truth: maps/m50_50.jm2, areas/area_lumbridge/scripts/cook.rs2,
// quests/quest_cook/scripts/quest_cook.rs2. The parent quest-order verifies saved QP and banks assets.
import { openQuest } from './quest-lib';
import { questFlags } from '../../packages/core/src/quest-status';

const COOK = { x: 3209, z: 3215 };
const INGREDIENTS = [1944, 1927, 1933] as const;
type Quest = Awaited<ReturnType<typeof openQuest>>;
type CookIO = Pick<Quest, 'pos' | 'lvl' | 'near' | 'walk' | 'openDoor' | 'waitUntil' |
    'cnt' | 'talk' | 'converse' | 'dialogOpen' | 'milestone'> & {
    questState(): 'unknown' | 'not started' | 'started' | 'complete';
    packReady(): boolean;
};

// Helpers return observations. openQuest remains the sole session/cleanup owner.
export async function completeCook(q: CookIO): Promise<{ ok: true; detail: string }> {
    if (!await q.waitUntil(() => q.questState() !== 'unknown' && q.packReady() && !!q.pos(), 20))
        throw Error('Cook entry state unobserved within deadline');
    const initial = q.questState();
    if (initial === 'complete') throw Error('Cook quest already complete');
    if (initial !== 'not started' && initial !== 'started') throw Error('Cook quest state unknown');
    if (q.lvl() !== 0) throw Error('Cook entry requires ground floor');
    const before = INGREDIENTS.map(id => q.cnt(id));
    if (before.some(count => count !== 1)) throw Error('Cook requires exactly one egg, milk and flour');

    const inside = () => {
        const p = q.pos();
        return p?.level === 0 && p.worldX >= 3205 && p.worldX <= 3212 && p.worldZ >= 3212 && p.worldZ <= 3216;
    };
    if (!inside()) {
        // Reuse quest-items-order's northern corridor. A direct Draynor -> castle line crosses dark wizards.
        if (q.pos().worldX < 3180) await q.walk('cook northern approach', [
            { x: 3092, z: 3250, tol: 1 }, { x: 3089, z: 3266, tol: 1 },
            { x: 3100, z: 3270, tol: 2 }, { x: 3140, z: 3270, tol: 2 },
            { x: 3180, z: 3258, tol: 2 }, { x: 3218, z: 3256, tol: 2 },
            { x: 3217, z: 3220, tol: 1 },
        ]);
        // m50_50: north wall z=3217, door loc_1536 at x=3207. The old tol=5 NPC
        // approach stopped at 3209,3218 outside this wall (2026-10-28 consumer.log).
        // quest-lib.walk/openDoor -> this consumer: reuse, then require interior arrival.
        await q.walk('cook kitchen door approach', [{ x: 3207, z: 3218, tol: 0 }]);
        await q.openDoor('cook kitchen north door', 3207, 3217);
        await q.walk('cook kitchen entry', [{ x: 3207, z: 3216, tol: 0 }, { x: 3208, z: 3214, tol: 0 }]);
        if (!inside() || !q.near(3208, 3214, 1)) throw Error('Cook kitchen arrival unobserved');
    }

    const done = () => q.questState() === 'complete';
    if (initial === 'not started') {
        await q.talk('cook 1', /^cook$/i, [/^what's wrong\?$/i, /yes, i'll help you/i],
            () => q.questState() === 'started', COOK);
        q.milestone(1);
    }
    // Completion is queued after all three inv_del calls. A message or lost inputs alone is insufficient.
    await q.talk('cook 2', /^cook$/i, [], done, COOK, 40, true);
    if (!await q.converse([], () => !q.dialogOpen(), 10)) throw Error('Cook final dialogue still open');
    if (!await q.waitUntil(() => done() && q.packReady() &&
        INGREDIENTS.every((id, i) => q.cnt(id) === before[i]! - 1), 15))
        throw Error('Cook completion flag or ingredient deltas unobserved');
    q.milestone(2);
    return { ok: true, detail: 'Cook flag=complete consumed=egg:1,milk:1,flour:1; saved QP checked by quest-order' };
}

if (import.meta.main) {
    // CAP is a game-tick budget. Account argv and server selection remain owned by openQuest/openBot.
    const cap = Number(process.env.CAP ?? 600);
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('Cook CAP must be a positive integer');
    const q = await openQuest({ cap });
    try {
        const result = await completeCook({ ...q,
            questState: () => questFlags(q.s.client)?.find(f => f.name === "Cook's Assistant")?.state ?? 'unknown',
            packReady: () => Array.isArray(q.st()?.inventory),
        });
        await q.end(result.ok, result.detail);
    } catch (e) { await q.fail(String(e)); }
}
