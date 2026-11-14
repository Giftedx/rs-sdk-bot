import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { marketPrices, skillRow, shoppingList, type Rung } from '../src/unlock-bill';
import { MARKET_CACHE_MS, MARKET_FILE } from '../../../scripts/market-cache';

const rung = (id: string, level: number, xp: number, extra: Partial<Rung> = {}): Rung => ({ id, skill: 'runecraft', level, label: id, kind: 'k', xpPerAction: xp, xpPerTick: null, inputs: [], requires: [], quest: null, worker: null, ...extra });
const own = new Map([['A', new Map([['air_talisman', 1]])], ['B', new Map([['mind_talisman', 2]])]]);

test('the best usable rung is chosen and its missing item names another account as a source', () => {
    const rungs = [rung('air', 1, 5, { requires: [{ id: 1, debugname: 'air_talisman', name: 'Air talisman' }] }), rung('mind', 2, 6, { requires: [{ id: 2, debugname: 'mind_talisman', name: 'Mind talisman' }] }), rung('water', 5, 7)];
    const r = skillRow('A', {}, 'runecraft', 3, rungs, [], own, () => []);
    expect(r.best?.id).toBe('mind');
    expect(r.blockers).toEqual([{ kind: 'item', name: 'Mind talisman', item: 'mind_talisman', have: 0, sources: ['B 2', 'GE'] }]);
    expect(r.next?.id).toBe('water');
    expect(shoppingList([r])[0]).toMatchObject({ item: 'mind_talisman', accounts: ['A'] });
});

test('a rung whose item cannot be obtained is not chosen; a quest gate is a blocker', () => {
    const rungs = [rung('low', 1, 1), rung('high', 1, 9, { inputs: [{ id: 3, debugname: 'rare', name: 'Rare', count: 1 }] }), rung('quest', 1, 5, { quest: { name: 'Rune Mysteries Quest' } })];
    const r = skillRow('A', { quests: [] }, 'runecraft', 1, rungs, [], own, () => [], i => i !== 'rare');
    expect(r.best?.id).toBe('quest');
    expect(r.blockers[0]).toMatchObject({ kind: 'quest', name: 'Rune Mysteries Quest' });
});

test('a shared completed quest unlocks its rung through the full journal or legacy completed names', () => {
    const quest = 'Rune Mysteries Quest', rungs = [rung('quest', 1, 5, { quest: { name: quest } })];
    for (const status of [
        { quests: [{ name: quest, state: 'complete' }] },
        { quests: [quest.toLowerCase()] },
        { quests: [], questJournal: [{ id: 7335, name: quest, state: 'complete' }] },
    ]) {
        expect(skillRow('A', status, 'runecraft', 1, rungs, [], own, () => []).blockers).toEqual([]);
    }
    for (const questJournal of [[], [{ id: 7335, name: quest, state: 'unknown' }], [{ id: 7335, name: quest, state: 'started' }]]) {
        const row = skillRow('A', { quests: [quest], questJournal }, 'runecraft', 1, rungs, [], own, () => []);
        expect(row.blockers).toEqual([{ kind: 'quest', name: quest, have: 0, sources: [] }]);
    }
});

function marketFixture(names: string[]) {
    const base = mkdtempSync(join(tmpdir(), 'unlock-market-'));
    mkdirSync(join(base, 'knowledge'));
    mkdirSync(join(base, '.practice/coordinator'), { recursive: true });
    const items = names.map((debugname, index) => ({ id: index + 1, debugname, name: debugname }));
    writeFileSync(join(base, 'knowledge/items.json'), JSON.stringify(items));
    writeFileSync(join(base, 'knowledge/ladders.json'), JSON.stringify({ ladders: { runecraft: [rung('market', 1, 5, {
        inputs: items.map(i => ({ ...i, count: 1 })),
    })] } }));
    return base;
}

test('unlock pricing shares fresh all-item observations without new requests or refreshed ages', async () => {
    const base = marketFixture(['sold', 'empty', 'newer']), now = 30_000_000, at = now - 2000;
    try {
        writeFileSync(join(base, MARKET_FILE), JSON.stringify({ at, items: {
            1: { ask: 8, bid: 3, sell: 7 }, 2: { ask: null, bid: null, sell: 0 }, 3: { ask: 8, bid: 3, sell: 7 },
        } }));
        const newer = { at: now - 1000, ask: 9, bid: 4, sell: 5 };
        writeFileSync(join(base, '.practice/coordinator/market-prices.json'), JSON.stringify({
            sold: { at: now - 5000, ask: 30, bid: 20, sell: 2 }, newer,
        }));
        const requests: string[] = [], pauses: number[] = [];
        const prices = await marketPrices(base, now, async url => { requests.push(url); return {}; }, async ms => { pauses.push(ms); });
        expect(prices).toEqual({ sold: { at, ask: 8, bid: 3, sell: 7 }, empty: { at, ask: null, bid: null, sell: 0 }, newer });
        expect(requests).toEqual([]);
        expect(pauses).toEqual([]);
        expect(JSON.parse(readFileSync(join(base, '.practice/coordinator/market-prices.json'), 'utf8'))).toEqual(prices);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('missing and invalid shared supply observations fall back to per-item market requests', async () => {
    const base = marketFixture(['legacy', 'invalid', 'missing']), now = 30_000_000;
    try {
        writeFileSync(join(base, MARKET_FILE), JSON.stringify({ at: now - 1000, items: {
            1: { ask: 8, bid: 3 }, 2: { ask: 8, bid: 3, sell: -1 },
        } }));
        const requests: string[] = [], pauses: number[] = [];
        const prices = await marketPrices(base, now, async url => {
            requests.push(url); return { ask: 12, bid: 5, sellQuantity: 3 };
        }, async ms => { pauses.push(ms); });
        expect(requests.map(url => Number(url.split('/').pop()))).toEqual([1, 2, 3]);
        expect(pauses).toEqual([550, 550, 550]);
        for (const quote of Object.values(prices)) expect(quote).toEqual({ at: now, ask: 12, bid: 5, sell: 3 });
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('expired or future-dated all-item observations cannot stand in for current market requests', async () => {
    const now = 30_000_000;
    for (const at of [now - MARKET_CACHE_MS, now + 1]) {
        const base = marketFixture(['supply']);
        try {
            writeFileSync(join(base, MARKET_FILE), JSON.stringify({ at, items: { 1: { ask: 8, bid: 3, sell: 7 } } }));
            let requests = 0;
            const prices = await marketPrices(base, now, async () => { requests++; return { ask: null, bid: 2, sellQuantity: 0 }; }, async () => {});
            expect(requests).toBe(1);
            expect(prices.supply).toEqual({ at: now, ask: null, bid: 2, sell: 0 });
        } finally { rmSync(base, { recursive: true, force: true }); }
    }
});
