import { test, expect } from 'bun:test';
import { goTo } from '../src/walk';
import { journalGuildStage, startedJournalQuests } from '../src/guild-observation';
import { doorBlocks } from '../src/world';

const PRIEST = 8115, STARTED = 0xf8f800, COMPLETE = 0x00f800;
const STAGE5 = 'Priest in Peril|I need to find the key to his cell and free him.';

// A session standing between the Paterdomus gates whose journal says stage 5. The world has a route only for an account
// whose priestperil stage opens pip_underground_door1.
function fixture(colour: number | undefined, journal = STAGE5) {
    let tick = 0, clicks = 0;
    const client: any = {
        ingame: true, mainModalId: -1,
        ifType: (id: number) => id === PRIEST ? { colour } : id === 8144 ? { text: 'Priest in Peril' } : id === 8145 ? { text: journal } : {},
    };
    const state = { player: { worldX: 3428, worldZ: 9891, level: 0 }, skills: [], inventory: [], equipment: [], nearbyLocs: [] };
    const s: any = {
        client, tick: () => tick,
        onTick: (cb: () => void) => { let active = true; queueMicrotask(() => { if (active) { tick++; cb(); } }); return () => { active = false; }; },
        sdk: { getState: () => state, getDialog: () => null },
        direct: async (a: any) => {
            if (a.type === 'clickComponent') { clicks++; client.mainModalId = a.componentId === PRIEST ? 8134 : -1; }
            if (a.type === 'closeModal') client.mainModalId = -1;
            return { success: true };
        },
        bot: {},
    };
    const actors: any[] = [];
    const world: any = {
        route: (_from: any, _to: any, actor: any) => {
            actors.push(actor);
            return (actor.questStages?.priestperil ?? -1) >= 5 ? { ok: true, legs: [], cost: 0 } : { ok: false, reason: 'no_route' };
        },
    };
    return { s, world, actors, get clicks() { return clicks; } };
}
const varrock = { x: 3185, z: 3436, level: 0 }, account = { skills: {}, varps: {}, items: [] };

test('the Priest in Peril journal gives the priestperil stage', () => {
    expect(journalGuildStage('Priest in Peril', 'I need to find the key to his cell and free him.')).toEqual({ key: 'priestperil', lowerBound: 5 });
    expect(journalGuildStage('Priest in Peril', 'text the parser does not know')).toBeNull();
});

test('only a quest that the quest list shows started is read', () => {
    expect(startedJournalQuests(fixture(STARTED).s.client)).toEqual(['priestperil']);
    expect(startedJournalQuests(fixture(COMPLETE).s.client)).toEqual([]);
    expect(startedJournalQuests(fixture(undefined).s.client)).toEqual([]);
});

test('a walk with no route reads the started journal and plans again with its stage', async () => {
    const f = fixture(STARTED);
    const result = await goTo(f.s, f.world, varrock, account);
    expect(result.ok).toBe(true);
    expect(f.clicks).toBe(1);
    expect(f.actors.length).toBe(2);
    expect(f.actors[1].questStages.priestperil).toBe(5);
    const gate1 = { id: 3444, loc: 'pip_underground_door1', x: 3405, z: 9895, level: 0, kind: 'quest', need: { varp: 'priestperil', minimum: 5 }, trigger: '', src: '' } as any;
    expect(doorBlocks(gate1, f.actors[0])).toBe(true);
    expect(doorBlocks(gate1, f.actors[1])).toBe(false);
}, 5000);

test('a journal stage below the gate still gives no route, and a quest not started opens no journal', async () => {
    const low = fixture(STARTED, 'Priest in Peril|I must return to the temple and find out what happened to the real Drezel.');
    expect(await goTo(low.s, low.world, varrock, account)).toMatchObject({ ok: false, reason: 'precondition' });
    expect(low.actors.length).toBe(2);
    expect(low.actors[1].questStages.priestperil).toBe(4);
    const none = fixture(undefined);
    expect(await goTo(none.s, none.world, varrock, account)).toMatchObject({ ok: false, reason: 'precondition' });
    expect(none.clicks).toBe(0);
    expect(none.actors.length).toBe(1);
}, 5000);
