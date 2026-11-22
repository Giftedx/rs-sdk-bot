import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COOKED_FOOD_BASE_IDS, foodStock, hasDelivery, selectCookedFoodSource, type DemandNear } from '../../core/src/bank-demand';
import { repoRoot } from '../../core/src/practice-paths';

export type CourierItem = { id?: number; name: string; count: number };
export type CourierSlotItem = { id: number; name: string; count: number; slot: number };
export interface SeparationDeps {
    inventory(): readonly CourierSlotItem[];
    bank(): readonly CourierSlotItem[] | null;
    openBank(): Promise<boolean>;
    closeBank(): Promise<boolean>;
    deposit(item: CourierSlotItem): Promise<boolean>;
    withdraw(item: CourierSlotItem, count: number): Promise<boolean>;
    tradeNotes(count: number): Promise<{ success: boolean; given: number }>;
    observed(predicate: () => boolean): Promise<boolean>;
}

export async function separateTroutNotes(d: SeparationDeps): Promise<number> {
    const count = (items: readonly CourierSlotItem[], id: number) =>
        items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const food = count(d.inventory(), 333), notes = count(d.inventory(), 334);
    const fail = (why: string) => new Error(`no delivery progress: need-bank-separation ${why}`);
    if (!food || !notes || d.inventory().some(i => /^trout$/i.test(i.name) && i.id !== 333 && i.id !== 334)) {
        throw fail('identity unknown');
    }
    if (!await d.openBank() || !d.bank()) throw fail('bank readiness unknown');
    const bankBefore = count(d.bank()!, 333);
    let problem: unknown;
    try {
        const item = d.inventory().find(i => i.id === 333);
        if (!item || !await d.deposit(item) || !await d.observed(() =>
            count(d.inventory(), 333) === 0 && count(d.inventory(), 334) === notes && !!d.bank() && count(d.bank()!, 333) === bankBefore + food
        )) throw fail('deposit not conserved');
        if (!await d.closeBank()) throw fail('cannot close bank');
        const trade = await d.tradeNotes(notes);
        if (!trade.success || trade.given !== notes || !await d.observed(() =>
            count(d.inventory(), 333) === 0 && count(d.inventory(), 334) === 0
        )) throw fail('notes transfer not verified');
    } catch (e) {
        problem = e;
    } finally {
        const missing = food - count(d.inventory(), 333);
        if (missing < 0) throw fail('restore inventory changed');
        if (missing > 0) {
            if (!await d.openBank() || !d.bank() || count(d.bank()!, 333) !== bankBefore + missing) {
                throw fail('restore bank delta unknown; food remains banked');
            }
            const item = d.bank()!.find(i => i.id === 333);
            if (!item || !await d.withdraw(item, missing) || !await d.observed(() =>
                count(d.inventory(), 333) === food && !!d.bank() && count(d.bank()!, 333) === bankBefore
            )) throw fail('restore incomplete; inspect banked working food');
        } else if (!d.bank() || count(d.bank()!, 333) !== bankBefore) {
            throw fail('bank conservation unknown');
        }
        if (!await d.closeBank()) throw fail('restore cannot close bank');
    }
    if (problem) throw problem;
    return notes;
}

export type DeliveryJob = { account?: string; accounts?: string[]; script?: string; args?: readonly string[]; goal?: string; env?: Record<string, string> };

export function retainedTrout(env: Record<string, string | undefined> = {}): number {
    const raw = env.RETAIN_TROUT ?? '2';
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('invalid RETAIN_TROUT');
    return Number(raw);
}

// ID333 is unnoted cooked Trout. Retain a count, not the whole food family.
export function courierCargo(inventory: readonly CourierItem[], reserve: number): { items: { name: string; count: number }[]; blocked: string[] } {
    const valid = inventory.filter(i => i && typeof i.name === 'string' && Number.isSafeInteger(i.count) && i.count > 0 && !/^coins$/i.test(i.name));
    const food = valid.filter(i => /^trout$/i.test(i.name));
    if (reserve > 0 && food.some(i => !Number.isSafeInteger(i.id))) return { items: [], blocked: ['Trout: identity unknown'] };
    const unnoted = food.filter(i => i.id === 333).reduce((n, i) => n + i.count, 0);
    if (reserve > 0 && unnoted > 0 && food.some(i => i.id !== 333)) return { items: [], blocked: ['Trout: need-bank-separation'] };
    const amounts = new Map<string, { name: string; count: number }>();
    let left = reserve;
    for (const i of valid) {
        const kept = i.id === 333 ? Math.min(left, i.count) : 0;
        left -= kept;
        const count = i.count - kept;
        if (count <= 0) continue;
        const key = i.name.toLowerCase(), prior = amounts.get(key);
        amounts.set(key, { name: prior?.name ?? i.name, count: (prior?.count ?? 0) + count });
    }
    return { items: [...amounts.values()], blocked: [] };
}

export function courierDeliveryWaiting(
    names: readonly string[],
    near?: DemandNear,
    jobs?: readonly DeliveryJob[],
    readStatus = (name: string): any => JSON.parse(readFileSync(join(repoRoot, '.practice', 'status', `${name}.json`), 'utf8')),
    now = Date.now(),
): boolean {
    if (!jobs) {
        try {
            const plan = JSON.parse(readFileSync(join(repoRoot, 'swarm.json'), 'utf8'));
            if (!Array.isArray(plan.jobs)) throw new Error('missing jobs');
            jobs = plan.jobs;
        } catch {
            console.warn('DELIVERY demand unknown: cannot read swarm plan');
            return false;
        }
    }
    return names.some(name => {
        if (!/^[A-Za-z0-9_ -]{1,12}$/.test(name)) return false;
        try {
            const status = readStatus(name);
            const job = jobs!.find(j => [...(j.accounts ?? []), j.account ?? ''].some(a => a.toLowerCase() === name.toLowerCase()));
            const file = (path: string) => path.replaceAll('\\', '/').split('/').at(-1);
            const script = job?.script && file(job.script);
            const role = script === 'aio-logistics.ts'
                ? (job?.args as string[] | undefined)?.find((a: string) => !a.includes('=') && !a.startsWith('-'))?.toLowerCase()
                : undefined;
            const isFoodCourier = script === 'foodcourier.ts' || role === 'food-courier';
            const isNoteCourier = script === 'note-courier.ts' || role === 'note-courier';
            if (isFoodCourier && job?.env?.OUTBOUND_ONLY === '1') return false;
            if (!isNoteCourier) return hasDelivery(status, now, near);
            const goal = typeof status?.goal === 'string' ? status.goal.trim() : '';
            const matchesGoalScript = !!goal && (file(goal) === script || (script === 'aio-logistics.ts' && file(goal) === 'note-courier.ts'));
            if (!goal || !(matchesGoalScript || (!goal.endsWith('.ts') && goal === job?.goal?.trim()))) return false;
            const cargo = courierCargo(status?.inventory ?? [], retainedTrout(job?.env));
            return cargo.blocked.length === 0 && hasDelivery({ ...status, inventory: cargo.items }, now, near);
        } catch {
            return false;
        }
    });
}

export type CourierTile = { x: number; z: number };
export const ARDY_BANK: CourierTile = { x: 2654, z: 3283 };
export const NORTH_BANK: CourierTile = { x: 2619, z: 3332 };
export const SARIM: CourierTile = { x: 3029, z: 3217 };
export const NORTH_TO_SOUTH: CourierTile = { x: 2644, z: 3293 };
export const BOAT_FARES_OUT = 60;
export const BOAT_FARES_ROUND = 120;
export type OutboundStart = 'boat-south' | 'boat-north' | 'land' | 'refuse';
export type RoutePoint = [number, number, number];
export const DRAYNOR_BANK: CourierTile = { x: 3092, z: 3243 };
export const LUMBRIDGE_TO_DRAYNOR: RoutePoint[] = [
    [3226, 3250, 2], [3180, 3258, 3], [3100, 3285, 3],
    [3089, 3266, 2], [3092, 3250, 1], [DRAYNOR_BANK.x, DRAYNOR_BANK.z, 2],
];

export function selectFoodSource(
    names: readonly string[],
    statuses: readonly any[],
    owned: ReadonlySet<string>,
    now: number,
    minimum = 1,
    server = 'rs-sdk-demo.fly.dev',
): string | undefined {
    if (names.some(n => typeof n !== 'string')) return undefined;
    return selectCookedFoodSource(names, statuses, owned, now, minimum, server);
}

export function featherPurchaseAmount(cap: number, name: string, status: any, now: number, server = 'rs-sdk-demo.fly.dev'): number {
    if (
        typeof status?.name !== 'string' || status.name.toLowerCase() !== name.toLowerCase() || status.server !== server
        || status.result || !Number.isFinite(status.at) || now - status.at < 0 || now - status.at >= 30000
        || !Array.isArray(status.inventory) || !status.inventory.every((i: any) => Number.isSafeInteger(i?.id) && i.id >= 0 && Number.isSafeInteger(i.count) && i.count > 0)
    ) return cap;
    const stock = status.inventory.filter((i: any) => i.id === 314).reduce((n: number, i: any) => n + i.count, 0);
    return Number.isSafeInteger(stock) ? Math.min(cap, Math.max(0, 1000 - stock)) : cap;
}

export function foodDeficit(name: string, status: any, now: number, buffer = 80, server = 'rs-sdk-demo.fly.dev'): number | undefined {
    const rows = (v: any) => Array.isArray(v) && v.every(i => Number.isSafeInteger(i?.id) && i.id >= 0 && Number.isSafeInteger(i.count) && i.count > 0);
    if (
        !Number.isSafeInteger(buffer) || buffer < 1 || typeof status?.name !== 'string' || status.name.toLowerCase() !== name.toLowerCase()
        || status.server !== server || status.result || !Number.isFinite(status.at) || now - status.at < 0 || now - status.at >= 30000
        || !Number.isFinite(status.bankAt) || status.bankAt <= 0 || status.bankAt > now || !rows(status.bank) || !rows(status.inventory)
    ) return undefined;
    const food = foodStock(status.bank.filter((i: { id: number }) => COOKED_FOOD_BASE_IDS.has(i.id))) + foodStock(status.inventory);
    return Number.isSafeInteger(food) ? Math.max(0, buffer - food) : undefined;
}

export function foodRestockAmount(name: string, status: any, now: number, server = 'rs-sdk-demo.fly.dev'): number | undefined {
    const deficit = foodDeficit(name, status, now, 80, server);
    return deficit === undefined ? undefined : deficit > 0 ? deficit + 80 : 0;
}

export function deliveryRecipientAtBank(
    p: { worldX: number; worldZ: number; level: number } | null | undefined,
    players: readonly { name: string; distance: number }[],
    name: string,
    bank: CourierTile,
): boolean {
    return p?.level === 0 && Math.max(Math.abs(p.worldX - bank.x), Math.abs(p.worldZ - bank.z)) <= 2
        && players.some(other => other.name.toLowerCase() === name.toLowerCase() && Number.isFinite(other.distance) && other.distance >= 0 && other.distance <= 2);
}

export function onKaramja(p: { worldX: number; worldZ: number; level: number } | null | undefined): boolean {
    return !!p && p.level === 0 && p.worldX >= 2760 && p.worldX <= 2965 && p.worldZ >= 3130 && p.worldZ <= 3235;
}

export function draynorApproach(p: { worldX: number; worldZ: number; level: number } | null | undefined): RoutePoint[] {
    if (p && p.level === 0 && p.worldX >= 3110) return LUMBRIDGE_TO_DRAYNOR;
    return [[DRAYNOR_BANK.x, DRAYNOR_BANK.z, 2]];
}

const cheb = (a: CourierTile, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));

export function outboundStart(p: { worldX: number; worldZ: number; level: number } | null | undefined): OutboundStart {
    if (!p || p.level !== 0) return 'refuse';
    if (cheb(ARDY_BANK, p) <= 10) return 'boat-south';
    if (cheb(NORTH_BANK, p) <= 10) return 'boat-north';
    if (p.worldX >= 2950 && cheb(SARIM, p) < cheb(ARDY_BANK, p)) return 'land';
    return 'refuse';
}

export function deliveryResume(
    p: { worldX: number; worldZ: number; level: number } | null | undefined,
    notes: number,
    farmers: number,
): 'bank' | 'karamja' | null {
    if (!Number.isSafeInteger(notes) || notes < 1 || !Number.isSafeInteger(farmers) || farmers < 1) return null;
    if (onKaramja(p)) return 'karamja';
    if (p?.level === 0 && Math.max(Math.abs(p.worldX - 2653), Math.abs(p.worldZ - 3302)) <= 16) return 'bank';
    const start = outboundStart(p);
    if (start === 'boat-south' || start === 'boat-north') return 'bank';
    return null;
}
