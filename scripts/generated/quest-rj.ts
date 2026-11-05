// Romeo & Juliet from preset quest_rj (beside Romeo in Varrock Square; Haggis at the qp-filler row: every skill 99,
// rune set; cadava berries and Varrock teleport runes from a helper). Reward: 5 QP, no XP (quest_romeojuliet.rs2).
// Varp %rjquest: 0 -> 20 Juliet ("I guess I could find him." gives the message at once, juliet.rs2), 30 Romeo,
// 40 Father Lawrence, 50 Apothecary, potion on a second talk, 60 Juliet, 100 Romeo (queued completion).
// Server truth: areas/area_varrock/scripts/juliet.rs2, romeo.rs2, father_lawrence.rs2, apothecary.rs2.
import { openQuest } from './quest-lib';
import { questFlags } from '../../packages/core/src/quest-status';
import { componentId } from '../../packages/core/src/logout';

const ROMEO = { x: 3211, z: 3425 };
const JULIET = { x: 3158, z: 3425 };                       // level 1
const STAIRS = { id: 1722, x: 3156, z: 3435 };             // level 0; stairstop 1723 on level 1
const LAWRENCE = { x: 3254, z: 3475 };
const APOTHECARY = { x: 3195, z: 3404 };
const ITEM = { message: 755, berries: 753, potion: 756 };

export const hasJulietMessage = (items: readonly {id:number;count:number}[]) => items.some(i => i.id === ITEM.message && i.count > 0);

// Active instructions in romeojuliet_journal.rs2 distinguish started stages without guessing from item absence.
export function rjJournalStage(body: string): number | undefined {
    const text = body.replace(/@[a-z0-9]+@/gi, '').replace(/\s+/g, ' ');
    if (/QUEST COMPLETE!/i.test(text)) return 100;
    if (/I have to find Romeo and tell him what's happened/i.test(text)) return 60;
    if (/I should take this cadava potion|I should take these cadava berries|I will have to find some cadava berries/i.test(text)) return 50;
    if (/I need to find the Apothecary/i.test(text)) return 40;
    if (/I should find Father Lawrence/i.test(text)) return 30;
    if (/I should take the message from Juliet to Romeo/i.test(text)) return 20;
    if (/I should go and speak to Juliet/i.test(text)) return 10;
    if (/I can start this quest by talking to Romeo/i.test(text)) return 0;
    return undefined;
}

type Quest = Awaited<ReturnType<typeof openQuest>>;
export async function readRjStage(q: Pick<Quest, 's' | 'waitUntil'>): Promise<number> {
    const c = q.s.client as any;
    const close = async () => {
        if (c.mainModalId !== -1) await q.s.direct({type:'closeModal',reason:'SDK'});
        if (!await q.waitUntil(() => c.mainModalId === -1, 5)) throw Error('RJ journal close unobserved');
    };
    if (q.s.sdk.getDialog()?.isOpen) throw Error('RJ journal blocked by dialogue');
    await close();
    await q.s.direct({type:'clickComponent',componentId:componentId('questlist:romeojuliet'),reason:'SDK'});
    let stage: number | undefined;
    const seen = await q.waitUntil(() => {
        if (c.mainModalId !== 8134 || !/Romeo & Juliet/i.test(c.ifType(8144)?.text ?? '')) return false;
        stage = rjJournalStage(Array.from({length:50}, (_,i) => c.ifType(8145+i+(i>0?1:0))?.text ?? '').join(' '));
        return stage !== undefined;
    }, 10);
    await close();
    if (!seen || stage === undefined) throw Error('RJ stage unobserved within deadline');
    console.log('RJ_STAGE '+JSON.stringify({stage}));
    return stage;
}

if (import.meta.main || (globalThis as { QUEST_SESSION?: unknown }).QUEST_SESSION) {
    const cap = Number(process.env.CAP ?? 1500);
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('RJ CAP must be a positive integer');
    const q = await openQuest({ cap });
    try {
        const msgItem = () => hasJulietMessage(q.inv());
        const state = () => questFlags(q.s.client)?.find(f => f.name === 'Romeo & Juliet')?.state ?? 'unknown';
        if (!await q.waitUntil(() => state() !== 'unknown' && !!q.pos() && Array.isArray(q.st()?.inventory), 20))
            throw Error('RJ entry state unobserved within deadline');
        const stage = await readRjStage(q);
        if (stage === 100) throw Error('Romeo & Juliet already complete');
        const questDone = () => state() === 'complete';

        // Juliet's room. Her house's doors are loc_1533 / loc_1530 (maps/m49_53.jm2): the north door (3160,3440) into the
        // stairs room, the stairs (3156,3435), then two doors upstairs (3156,3431 and 3159,3427). The SDK plan finds no
        // way into the stairs room, so each door is opened by tile and the stairs are clicked from outside them.
        const toJuliet = async (label: string): Promise<void> => {
            await q.walk(`${label} house`, [{ x: 3161, z: 3441, tol: 1 }]);
            await q.openDoor(`${label} north door`, 3160, 3440);
            await q.climb(`${label} stairs up`, () => q.locAt(STAIRS.x, STAIRS.z), /climb-up/i, () => q.lvl() === 1);
            await q.openDoor(`${label} door up 1`, 3156, 3431);
            await q.openDoor(`${label} door up 2`, 3159, 3427);
        };
        const downstairs = async (label: string): Promise<void> => {
            await q.openDoor(`${label} door up 2`, 3159, 3427);
            await q.openDoor(`${label} door up 1`, 3156, 3431);
            await q.climb(`${label} stairs down`, () => q.locAt(STAIRS.x, STAIRS.z), /climb-down/i, () => q.lvl() === 0);
            await q.openDoor(`${label} north door`, 3160, 3440);
            await q.dash(`${label} out`, 3161, 3441, 1);
        };

        // 1. Juliet: "I guess I could find him." gives her message (0 -> 20).
        if (stage <= 20 && !msgItem()) {
            await toJuliet('juliet 1');
            await q.talk('juliet 1', /^juliet$/i, [/i guess i could find him/i, /certainly, i will do so/i], msgItem, JULIET);
            q.milestone(20);
        }

        // 2. Romeo takes the message (20 -> 30).
        if (stage <= 20) {
            if (q.lvl() === 1) await downstairs('romeo 1');
            await q.walk('to romeo', [{ x: ROMEO.x, z: ROMEO.z, tol: 4 }]);
            await q.talk('romeo 1', /^romeo$/i, [], () => !msgItem(), ROMEO);
            q.milestone(30);
        }

        // 3. Father Lawrence in the church (30 -> 40).
        if (stage <= 30) {
            await q.walk('to lawrence', [{ x: LAWRENCE.x, z: LAWRENCE.z - 2, tol: 3 }]);
            await q.talk('lawrence', /^father lawrence$/i, [], () => q.sawText(/tell him i sent you|need a cadava potion/i), LAWRENCE);
            q.milestone(40);
        }

        // 4. The Apothecary: the first talk asks for the berries (40 -> 50), the second brews the potion.
        if (stage <= 50 && !q.has(ITEM.potion)) {
            await q.walk('to apothecary', [{ x: APOTHECARY.x, z: APOTHECARY.z + 1, tol: 2 }]);
            if (stage < 50) {
                await q.talk('apothecary 1', /^apothecary$/i, [], () => q.sawText(/bring them here when you have them/i), APOTHECARY);
                q.milestone(50);
            }
            await q.talk('apothecary 2', /^apothecary$/i, [], () => q.has(ITEM.potion), APOTHECARY);
            q.milestone('potion');
        }

        // 5. Juliet takes the potion (50 -> 60).
        if (stage < 60) {
            await toJuliet('juliet 2');
            await q.talk('juliet 2', /^juliet$/i, [], () => !q.has(ITEM.potion), JULIET);
            q.milestone(60);
        }

        // 6. Varrock teleport to the square (3212,3424), Romeo: the completion is queued (60 -> 100).
        await q.teleport('varrock teleport', 'magic:varrock_teleport', 3212, 3424);
        await q.talk('romeo 2', /^romeo$/i, [], questDone, ROMEO, 40, true);
        await q.waitUntil(questDone, 5);
        q.milestone(100);
        await q.end(questDone(), `qp=5`);
    } catch (e) { await q.fail(String(e)); }
}
