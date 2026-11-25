import { test, expect } from 'bun:test';
import { nearestHubBank } from '../src/contracts';

test('a dungeon tile picks the hub bank nearest the land above it', () => {
    // The pocket under the Ikov dark stairs lies below East Ardougne (2639,3337).
    expect(nearestHubBank({ x: 2639, z: 9737, level: 0 })).toBe('ardougne');
    // The Witch's House basement and the Paterdomus room lie nearer Varrock.
    expect(nearestHubBank({ x: 2907, z: 9873, level: 0 })).toBe('varrock_west');
    expect(nearestHubBank({ x: 3428, z: 9891, level: 0 })).toBe('varrock_west');
});

test('a surface tile keeps its own distance, and an unknown tile takes the fallback', () => {
    expect(nearestHubBank({ x: 2575, z: 3269, level: 1 })).toBe('ardougne');
    expect(nearestHubBank({ x: 3210, z: 3420, level: 0 })).toBe('varrock_west');
    expect(nearestHubBank(undefined)).toBe('varrock_west');
    expect(nearestHubBank(null, 'ardougne')).toBe('ardougne');
});
