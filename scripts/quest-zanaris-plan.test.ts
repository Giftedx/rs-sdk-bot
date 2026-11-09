import { expect, test } from 'bun:test';
import { lostCityRoute } from './quest-zanaris-plan';

test('Lost City keeps the default food and prayer route', () => {
    expect(lostCityRoute(undefined)).toEqual({ food: 379, eatAt: 45, windBolt: null });
});

test('the Prayer 1 route preserves 40 casts for the spirit', () => {
    expect(lostCityRoute('wind-bolt')).toEqual({
        food: 385, eatAt: 32, windBolt: { axeCasts: 80, spiritCasts: 40, sharks: 21 },
    });
    expect(() => lostCityRoute('unknown')).toThrow('Invalid LOST_CITY_ROUTE');
});
