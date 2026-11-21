// Route supply and unlock requirement aggregation across chosen variants and Overall finish boundaries.
import { chooseVariants, type Activity, type Board, type ScheduleOptions, type ScheduleResult, type Supply } from './model';
import { chooseRoute } from './schedule';

// Supplies a helper stages for the activities the scenario uses, summed by item. With `boards`, the route is the
// one schedule() uses (chooseRoute); without, the raw-tick choice. An item made by a row of the route is left out.
export function suppliesFor(activities: Activity[], opts: ScheduleOptions, boards?: Board[]): Supply[] {
    return goalRequirementsFor(activities, opts, boards).supplies.map(({ consumers, ...supply }) => supply);
}

// Stage the rows that begin before the last 99, including a row that still runs at that tick.
export function overallRequirementsFor(activities: Activity[], opts: ScheduleOptions, plan: Pick<ScheduleResult, 'overallFinish' | 'order' | 'route'>) {
    const finish = plan.overallFinish;
    if (finish === null || !Number.isFinite(finish) || finish < 0) throw Error('Overall has no modeled finish');
    const started = new Set(plan.order.filter(row => row.start < finish).map(row => row.id));
    return goalRequirementsFor(activities.filter(a => started.has(a.id)), { ...opts, force: { ...opts.force, ...plan.route } });
}

// Keep shared unlocks once, but add consumables across consumers. These are requirements,
// not completion claims: activity IDs must not be treated as observed quest flags.
export function goalRequirementsFor(activities: Activity[], opts: ScheduleOptions, boards?: Board[]) {
    const route = boards && opts.route !== 'ticks' ? chooseRoute(boards, activities, opts).route : {};
    const acts = chooseVariants(activities, { ...opts, force: { ...opts.force, ...route } });
    const ids = new Set(acts.map(a => a.id));
    const out = new Map<string | number, { item: string; itemId?: number; count: number; consumers: string[] }>();
    const unlocks = new Map<string, { activity: string; consumers: string[]; selected: boolean }>();
    for (const a of acts) {
        for (const id of a.requires ?? []) {
            const row = unlocks.get(id) ?? { activity: id, consumers: [], selected: ids.has(id) };
            if (!row.consumers.includes(a.id)) row.consumers.push(a.id);
            unlocks.set(id, row);
        }
        for (const s of a.supplies ?? []) if (!s.from || !ids.has(s.from)) {
            const key = s.itemId ?? s.item;
            const row = out.get(key) ?? { item: s.item, ...(s.itemId === undefined ? {} : { itemId: s.itemId }), count: 0, consumers: [] };
            row.count += s.count;
            if (!row.consumers.includes(a.id)) row.consumers.push(a.id);
            out.set(key, row);
        }
    }
    return { supplies: [...out.values()], unlocks: [...unlocks.values()] };
}
