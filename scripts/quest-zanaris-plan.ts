const defaultRoute = { food: 379, eatAt: 45, windBolt: null } as const;
const windBoltRoute = {
    food: 385, eatAt: 32, windBolt: { axeCasts: 80, spiritCasts: 40, sharks: 21 },
} as const;

export function lostCityRoute(value: string | undefined) {
    if (value === undefined) return defaultRoute;
    if (value === 'wind-bolt') return windBoltRoute;
    throw new Error('Invalid LOST_CITY_ROUTE');
}
