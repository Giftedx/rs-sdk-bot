import { describe, expect, test } from 'bun:test';
import { LIVE_MS, STRANDED_MS, planTransfers, type ClaimRow, type OwnerRow, type SideView } from './fleet-assign';
import { ORPHAN_CLAIM_MS } from './fleet-trade-claim';

const NOW = 1_800_000_000_000, S = 'rs-sdk-demo.fly.dev';
const row = (side: string, home?: string): OwnerRow => ({ side, server: S, ...(home ? { home } : {}) });
const base = (o: Partial<Parameters<typeof planTransfers>[0]> = {}) => planTransfers({
    side: 'claude-cloud', capacity: 3, now: NOW, canLogin: () => true, claims: new Map(),
    owners: { Alpha: row('local'), Bravo: row('local'), Charlie: row('local'), Delta: row('local') },
    sides: { local: { seen: NOW - STRANDED_MS }, 'claude-cloud': { seen: NOW } }, ...o,
});

describe('fleet adoption', () => {
    test('the stranded rule matches the orphan-claim rule', () => expect(STRANDED_MS).toBe(ORPHAN_CLAIM_MS));

    test('adopts a stranded side\'s accounts up to capacity, by name, remembering their home', () => {
        expect(base()).toEqual([
            { account: 'Alpha', from: 'local', to: 'claude-cloud', home: 'local' },
            { account: 'Bravo', from: 'local', to: 'claude-cloud', home: 'local' },
            { account: 'Charlie', from: 'local', to: 'claude-cloud', home: 'local' },
        ]);
    });

    test('a side seen within the hour keeps its accounts; a full side adopts nothing', () => {
        expect(base({ sides: { local: { seen: NOW - STRANDED_MS + 1 } } })).toEqual([]);
        expect(base({ capacity: 0 })).toEqual([]);
        expect(base({ owners: { Mine: row('claude-cloud'), Alpha: row('local') }, capacity: 1 })).toEqual([]);
    });

    test('never moves the main account, a specialist, a paused account, a stopped side, a reservation or one it cannot log in', () => {
        const owners = { Haggis: row('local'), Alpha: row('local'), Bravo: row('local'), Charlie: row('local'), Echo: { ...row('local'), reservation: 'task-x' } };
        expect(base({ owners, capacity: 9, sides: { local: { seen: NOW - STRANDED_MS, paused: ['bravo'] } }, canLogin: n => n !== 'Charlie' }).map(m => m.account)).toEqual(['Alpha']);
        expect(base({ owners, capacity: 9, sides: { local: { seen: NOW - STRANDED_MS, stopped: true } } })).toEqual([]);
        // A death on the side that ran it holds the account there for a person.
        expect(base({ owners, capacity: 9, sides: { local: { seen: NOW - STRANDED_MS, died: ['alpha'] } }, canLogin: n => n !== 'Charlie' }).map(m => m.account)).toEqual(['Bravo']);
    });

    test('a held trade claim or a fresh swarm claim holds the account; an hour-old swarm claim of a silent side does not', () => {
        const claims = new Map<string, ClaimRow>([
            ['alpha', { phase: 'held', side: 'local', at: NOW - 10 * STRANDED_MS }],
            ['bravo', { phase: 'held', kind: 'swarm', side: 'local', at: NOW - 60_000 }],
            ['charlie', { phase: 'held', kind: 'swarm', side: 'local', at: NOW - STRANDED_MS }],
            ['delta', null],
        ]);
        expect(base({ claims, capacity: 9 }).map(m => m.account)).toEqual(['Charlie']);
    });

    test('a side with no lease record counts as stranded, but its held swarm claim stays held', () => {
        const claims = new Map<string, ClaimRow>([['alpha', { phase: 'held', kind: 'swarm', side: 'cloud-kit', at: NOW - 9 * STRANDED_MS }]]);
        expect(base({ owners: { Alpha: row('cloud-kit'), Bravo: row('cloud-kit') }, sides: {}, claims }).map(m => m.account)).toEqual(['Bravo']);
    });

    test('its own accounts coming home go first and drop the home mark', () => {
        const owners = { Alpha: row('local'), Zulu: row('local', 'claude-cloud') };
        expect(base({ owners, capacity: 1 })).toEqual([{ account: 'Zulu', from: 'local', to: 'claude-cloud', home: null }]);
    });

    test('hands an idle adopted account back to its live home side with room, and adopts nothing in that pass', () => {
        const owners = { Alpha: row('claude-cloud', 'local'), Bravo: row('claude-cloud', 'local'), Kilo: row('cloud') };
        const sides: Record<string, SideView> = { local: { seen: NOW - LIVE_MS + 1, capacity: 1 }, cloud: { seen: NOW - 9 * STRANDED_MS } };
        expect(base({ owners, sides, capacity: 9 })).toEqual([{ account: 'Alpha', from: 'claude-cloud', to: 'local', home: null }]);
        // Running (claim held), home not live, home full or home stopped: it stays, and adoption goes on.
        const running = new Map<string, ClaimRow>([['alpha', { phase: 'held', kind: 'swarm', side: 'claude-cloud', at: NOW }]]);
        expect(base({ owners, sides, capacity: 9, claims: running })).toEqual([{ account: 'Bravo', from: 'claude-cloud', to: 'local', home: null }]);
        expect(base({ owners, capacity: 9, sides: { ...sides, local: { seen: NOW - LIVE_MS, capacity: 5 } } }).map(m => m.account)).toEqual(['Kilo']);
        expect(base({ owners, capacity: 9, sides: { ...sides, local: { seen: NOW, capacity: 0 } } }).map(m => m.account)).toEqual(['Kilo']);
        expect(base({ owners, capacity: 9, sides: { ...sides, local: { seen: NOW, capacity: 5, stopped: true } } }).map(m => m.account)).toEqual(['Kilo']);
        // Paused by the owner of the side holding it: the stop file is here, so it stays here.
        expect(base({ owners, capacity: 9, sides: { ...sides, 'claude-cloud': { seen: NOW, paused: ['alpha'] } } })).toEqual([{ account: 'Bravo', from: 'claude-cloud', to: 'local', home: null }]);
    });
});
