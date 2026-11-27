import { expect, test } from 'bun:test';
import { parseStageKit, stageKitShortfall } from '../src/logistics/stage-kit';

test('STAGE_KIT parses id:count pairs and refuses a malformed entry', () => {
    expect(parseStageKit('333:2,954:10')).toEqual([{ itemId: 333, count: 2 }, { itemId: 954, count: 10 }]);
    expect(parseStageKit(undefined)).toEqual([]);
    expect(parseStageKit('')).toEqual([]);
    expect(() => parseStageKit('333')).toThrow('invalid STAGE_KIT entry');
    expect(() => parseStageKit('333:0')).toThrow('invalid STAGE_KIT entry');
});

test('the shortfall is the kit less what the pack holds', () => {
    const kit = [{ itemId: 1941, count: 100 }, { itemId: 954, count: 10 }, { itemId: 583, count: 1 }];
    expect(stageKitShortfall(kit, [{ id: 1941, count: 40 }, { id: 583, count: 1 }])).toEqual([{ itemId: 1941, count: 60 }, { itemId: 954, count: 10 }]);
    expect(stageKitShortfall(kit, [{ id: 1941, count: 100 }, { id: 954, count: 10 }, { id: 583, count: 1 }])).toEqual([]);
});
