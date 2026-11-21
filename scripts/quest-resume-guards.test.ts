import { expect, test } from 'bun:test';
import { componentId } from '../packages/core/src/logout';
import {
    inPaterdomusTemple,
    priestPerilJournalStage,
    readPriestPerilStage,
} from './generated/quest-priestperil';
import {
    ZANARIS_MIN_FOOD,
    ZANARIS_PRAYER_MIN,
    readZanarisStage,
    validateEntranaDungeonEntry,
    zanarisJournalStage,
} from './generated/quest-zanaris';

function makeJournalReader(questKey: string, title: string, body: string) {
    const actions: unknown[] = [];
    const c: any = {
        mainModalId: 123,
        ifType: (id: number) => (id === 8144 ? { text: title } : id === 8145 ? { text: body } : undefined),
    };
    const q = {
        s: {
            client: c,
            sdk: { getDialog: () => ({ isOpen: false }) },
            direct: async (a: any) => {
                actions.push(a);
                if (a.type === 'closeModal') c.mainModalId = -1;
                if (a.type === 'clickComponent' && a.componentId === componentId(`questlist:${questKey}`)) c.mainModalId = 8134;
                return { success: true };
            },
        },
        waitUntil: async (f: () => boolean) => f(),
    };
    return { q, actions, closed: () => c.mainModalId === -1 };
}

test('inPaterdomusTemple includes the x=3408 interior alcoves and excludes the west porch doors', () => {
    expect(inPaterdomusTemple(3408, 3485, 0)).toBe(true);
    expect(inPaterdomusTemple(3408, 3486, 0)).toBe(true);
    expect(inPaterdomusTemple(3408, 3491, 0)).toBe(true);
    expect(inPaterdomusTemple(3409, 3489, 0)).toBe(true);
    expect(inPaterdomusTemple(3420, 3489, 0)).toBe(true);
    expect(inPaterdomusTemple(3408, 3488, 0)).toBe(false);
    expect(inPaterdomusTemple(3408, 3489, 0)).toBe(false);
    expect(inPaterdomusTemple(3407, 3485, 0)).toBe(false);
    expect(inPaterdomusTemple(3408, 3485, 1)).toBe(false);
});

test('priestPerilJournalStage parses every stage from journal text in descending precedence', () => {
    const cases: Array<[string, number]> = [
        ['@dbl@I can start this quest by speaking to @dre@King Roald@dbl@ in @dre@Varrock Palace', 0],
        ['@str@I spoke to King Roald who asked me to investigate why his|@str@friend Priest Drezel has stopped communicating with him.||@dre@Drezel@dbl@ lives in a @dre@temple@dbl@ to the @dre@east@dbl@ of Varrock Palace.', 1],
        ['@str@I spoke to King Roald who asked me to investigate why his friend Priest Drezel has stopped communicating with him. @dbl@He told me that there was an annoying @dre@dog@dbl@ below the temple, and has asked me to @dre@kill it@dbl@ for him', 2],
        ["@dbl@I should tell @dre@King Roald@dbl@ everything's fine with @dre@Drezel@dbl@ now I have killed that @dre@dog@dbl@ for him", 3],
        ['@dbl@I must return to the @dre@temple@dbl@ and find out what happened to the real @dre@Drezel', 4],
        ['@dbl@I need to find the @dre@key@dbl@ to his cell and free him!', 5],
        ['@dbl@but I still have to do something about that @dre@vampire', 6],
        ['@dbl@I should speak to @dre@Drezel@dbl@ again', 7],
        ['@dbl@I should head downstairs to the @dre@monument@dbl@ like @dre@Drezel@dbl@ asked me to', 8],
        ['@dbl@I need to bring Drezel @dre@fifty rune essences@dbl@ to undo the damage', 10],
        ['@str@I spoke to King Roald... @red@QUEST COMPLETE!', 60],
    ];
    for (const [text, expected] of cases) {
        expect(priestPerilJournalStage(text)).toBe(expected);
    }
    expect(priestPerilJournalStage('unrelated modal text')).toBeUndefined();
});

test('readPriestPerilStage reads the live questlist:priestperil modal and honours PRIEST_FROM', async () => {
    const reader = makeJournalReader(
        'priestperil',
        'Priest in Peril',
        '@str@I spoke to King Roald who asked me to investigate why his friend Priest Drezel has stopped communicating with him. @dre@Drezel@dbl@ lives in a @dre@temple@dbl@ to the @dre@east@dbl@ of Varrock Palace.',
    );
    delete process.env.PRIEST_FROM;
    expect(await readPriestPerilStage(reader.q)).toBe(1);
    expect(reader.closed()).toBe(true);
    expect(reader.actions).toEqual([
        { type: 'closeModal', reason: 'SDK' },
        { type: 'clickComponent', componentId: componentId('questlist:priestperil'), reason: 'SDK' },
        { type: 'closeModal', reason: 'SDK' },
    ]);

    try {
        process.env.PRIEST_FROM = '5';
        expect(await readPriestPerilStage(reader.q)).toBe(5);
        process.env.PRIEST_FROM = 'bad';
        await expect(readPriestPerilStage(reader.q)).rejects.toThrow('Invalid PRIEST_FROM');
    } finally {
        delete process.env.PRIEST_FROM;
    }
});

test('zanarisJournalStage parses every stage from journal text in descending precedence', () => {
    const cases: Array<[string, number]> = [
        ['@dbl@I can start this quest by speaking to the Adventurers in the Swamp just south of Lumbridge.', 0],
        ['@str@According to one of the adventurers... @dbl@Apparently there is a @dre@leprechaun@dbl@ hiding in a @dre@tree@dbl@ nearby', 1],
        ['@dbl@I can find a @dre@Dramen Tree@dbl@ in a cave on @dre@Entrana', 2],
        ['@dbl@With the @dre@Spirit@dbl@ defeated I can cut a @dre@branch@dbl@ from the tree', 3],
        ['@dbl@I should @dre@craft@dbl@ the @dre@branch@dbl@ from the tree into a @dre@staff', 4],
        ['@dbl@I should enter @dre@Zanaris@dbl@ by going to the @dre@shed@dbl@ in @dre@Lumbridge Swamp', 5],
        ['@str@With the mystical Dramen Staff... @red@QUEST COMPLETE!', 6],
    ];
    for (const [text, expected] of cases) {
        expect(zanarisJournalStage(text)).toBe(expected);
    }
    expect(zanarisJournalStage('unrelated')).toBeUndefined();
});

test('readZanarisStage reads questlist:zanaris and honours ZANARIS_FROM', async () => {
    const reader = makeJournalReader(
        'zanaris',
        'Lost City',
        '@dbl@Apparently there is a @dre@leprechaun@dbl@ hiding in a @dre@tree@dbl@ nearby',
    );
    delete process.env.ZANARIS_FROM;
    expect(await readZanarisStage(reader.q)).toBe(1);
    expect(reader.closed()).toBe(true);

    try {
        process.env.ZANARIS_FROM = '3';
        expect(await readZanarisStage(reader.q)).toBe(3);
        process.env.ZANARIS_FROM = '-1';
        await expect(readZanarisStage(reader.q)).rejects.toThrow('Invalid ZANARIS_FROM');
    } finally {
        delete process.env.ZANARIS_FROM;
    }
});

test('validateEntranaDungeonEntry blocks low food or drained Prayer >= 43 with no Prayer potion before cave monk', () => {
    expect(validateEntranaDungeonEntry({
        foodCount: ZANARIS_MIN_FOOD, prayerBase: 99, prayerPoints: 99, prayerPotCount: 0, windBolt: false,
    })).toBeNull();
    expect(validateEntranaDungeonEntry({
        foodCount: ZANARIS_MIN_FOOD, prayerBase: ZANARIS_PRAYER_MIN, prayerPoints: 1, prayerPotCount: 1, windBolt: false,
    })).toBeNull();
    expect(validateEntranaDungeonEntry({
        foodCount: 21, prayerBase: 1, prayerPoints: 1, prayerPotCount: 0, windBolt: true,
    })).toBeNull();

    expect(validateEntranaDungeonEntry({
        foodCount: ZANARIS_MIN_FOOD - 1, prayerBase: 99, prayerPoints: 99, prayerPotCount: 2, windBolt: false,
    })).toContain(`>= ${ZANARIS_MIN_FOOD}`);

    expect(validateEntranaDungeonEntry({
        foodCount: 10, prayerBase: 94, prayerPoints: 1, prayerPotCount: 0, windBolt: false,
    })).toContain(`>= ${ZANARIS_PRAYER_MIN}`);
});
