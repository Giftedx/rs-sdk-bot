import { expect, test } from 'bun:test';
import { nativeRequirementMetadata, resolveItemRequirements, type RequirementMetadata } from '../src/item-requirements';

const definitions: Record<number, RequirementMetadata> = {
    1: { stackable: false, noted: false, unit: { kind: 'doses', family: 'prayer', units: 4 } },
    2: { stackable: false, noted: false, unit: { kind: 'doses', family: 'prayer', units: 3 } },
    3: { stackable: false, noted: false, unit: { kind: 'doses', family: 'prayer', units: 2 } },
    4: { stackable: false, noted: true, unit: { kind: 'doses', family: 'prayer', units: 4 } },
    5: { stackable: false, noted: false, unit: { kind: 'doses', family: 'restore', units: 4 } },
    6: { stackable: true, noted: false },
    7: { stackable: false, noted: false },
};
const metadata = (id: number) => definitions[id];

test('partial native units resolve to exact fullest-first IDs within the slot bound', () => {
    expect(resolveItemRequirements([{ id: 1, kind: 'doses', minUnits: 8, maxSlots: 3 }], [{ id: 2, count: 2 }, { id: 3, count: 1 }], metadata))
        .toMatchObject({ ok: true, slots: 3, items: [{ id: 2, count: 2 }, { id: 3, count: 1 }], shortages: [] });
    const short = resolveItemRequirements([{ id: 1, kind: 'doses', minUnits: 8, maxSlots: 2 }], [{ id: 2, count: 4 }], metadata);
    expect(short.ok).toBe(false);
    expect(short.shortages[0]).toMatchObject({ id: 1, unit: 'doses', required: 8, available: 6, reason: 'units' });
});

test('notes and another native family cannot fund a dose requirement', () => {
    const r = resolveItemRequirements([{ id: 1, kind: 'doses', minUnits: 4, maxSlots: 1 }], [{ id: 4, count: 10 }, { id: 5, count: 10 }], metadata);
    expect(r.ok).toBe(false);
    expect(r.shortages[0]?.available).toBe(0);
});

test('exact requirements retain exact identity and reserve stock before family choice', () => {
    const r = resolveItemRequirements([{ id: 1, kind: 'doses', minUnits: 3, maxSlots: 1 }, { id: 1, count: 1 }], [{ id: 1, count: 1 }, { id: 2, count: 1 }], metadata);
    expect(r).toMatchObject({ ok: true, items: [{ id: 1, count: 1 }, { id: 2, count: 1 }], slots: 2 });
    expect(resolveItemRequirements([{ id: 7, count: 1 }], [{ id: 1, count: 1 }], metadata).ok).toBe(false);
});

test('joint family allocation preserves each request slot limit in either input order', () => {
    const two = { id: 1, kind: 'doses' as const, minUnits: 2, maxSlots: 1 };
    const four = { id: 1, kind: 'doses' as const, minUnits: 4, maxSlots: 1 };
    const stock = [{ id: 3, count: 1 }, { id: 1, count: 1 }];
    for (const requirements of [[two, four], [four, two]]) {
        expect(resolveItemRequirements(requirements, stock, metadata)).toMatchObject({ ok: true, items: [{ id: 1, count: 1 }, { id: 3, count: 1 }], slots: 2, shortages: [] });
    }
    expect(resolveItemRequirements([{ ...four }, { ...two, minUnits: 1, maxSlots: 2 }], [{ id: 2, count: 1 }, { id: 3, count: 1 }], metadata).ok).toBe(false);
});

test('joint allocation finds a feasible split that strictest-first fullest greedy misses', () => {
    const a = { id: 1, kind: 'doses' as const, minUnits: 5, maxSlots: 2 };
    const b = { id: 1, kind: 'doses' as const, minUnits: 4, maxSlots: 2 };
    const stock = [{ id: 1, count: 1 }, { id: 2, count: 1 }, { id: 3, count: 1 }];
    for (const requests of [[a, b], [b, a]]) {
        expect(resolveItemRequirements(requests, stock, metadata, 3)).toMatchObject({ ok: true, slots: 3, items: [{ id: 1, count: 1 }, { id: 2, count: 1 }, { id: 3, count: 1 }] });
    }
});

test('stackable units cost one slot and unknown or overflowing requirements stay explicit', () => {
    expect(resolveItemRequirements([{ id: 6, count: 100 }], [{ id: 6, count: 100 }], metadata, 1)).toMatchObject({ ok: true, slots: 1 });
    expect(resolveItemRequirements([{ id: 7, count: 2 }], [{ id: 7, count: 2 }], metadata, 1).shortages[0]?.reason).toBe('slots');
    expect(resolveItemRequirements([{ id: 999, count: 1 }], [], metadata).shortages[0]?.reason).toBe('unknown');
    expect(resolveItemRequirements([{ id: 6, count: 2147483648 }], [{ id: 6, count: 2147483648 }], metadata).shortages[0]?.reason).toBe('invalid');
    expect(resolveItemRequirements([{ id: 6, count: 1 }], [{ id: 6, count: 2147483647 }, { id: 6, count: 1 }], metadata).shortages[0]?.reason).toBe('overflow');
});

test('malformed runtime arrays and unknown metadata fail as explicit invalid results', () => {
    for (const value of [null, {}, [null], [false]]) {
        expect(resolveItemRequirements(value as any, [], metadata)).toMatchObject({ ok: false, shortages: [expect.objectContaining({ reason: 'invalid' })] });
        expect(resolveItemRequirements([], value as any, metadata)).toMatchObject({ ok: false, shortages: [expect.objectContaining({ reason: 'invalid' })] });
    }
    expect(resolveItemRequirements([{ id: 1, count: 1 }], [{ id: 1, count: 1 }], () => { throw Error('no native observation'); })).toMatchObject({ ok: false, shortages: [expect.objectContaining({ reason: 'unknown' })] });
});

test('native metadata uses pinned potion families and charged glory chain without modern equivalents', () => {
    expect(nativeRequirementMetadata(2434)?.unit).toMatchObject({ kind: 'doses', units: 4 });
    expect(nativeRequirementMetadata(139)?.unit).toMatchObject({ kind: 'doses', units: 3, family: nativeRequirementMetadata(2434)?.unit?.family });
    expect(nativeRequirementMetadata(1712)?.unit).toMatchObject({ kind: 'charges', units: 4 });
    expect(nativeRequirementMetadata(1706)?.unit).toMatchObject({ kind: 'charges', units: 1, family: nativeRequirementMetadata(1712)?.unit?.family });
    expect(nativeRequirementMetadata(1704)?.unit).toBeUndefined();
    expect(nativeRequirementMetadata(12625)).toBeUndefined();
    expect(nativeRequirementMetadata(2435)?.noted).toBe(true);
    const escape = [{ id: 1712, kind: 'charges' as const, minUnits: 1, maxSlots: 1 }];
    expect(resolveItemRequirements(escape, [{ id: 1706, count: 1 }], nativeRequirementMetadata)).toMatchObject({ ok: true, items: [{ id: 1706, count: 1 }], slots: 1 });
    expect(resolveItemRequirements(escape, [{ id: 1704, count: 1 }], nativeRequirementMetadata)).toMatchObject({ ok: false, shortages: [{ id: 1712, unit: 'charges', required: 1, available: 0, reason: 'units' }] });
});
