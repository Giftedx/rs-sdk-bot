import { join } from 'node:path';
import { SPECIALIST_BOARDS } from '../../../core/src/specialist-launch';
import { levelForXp } from '../../../planner/src/curve';
import { LIBRARY_DIR, readLibrary, SKILLS, type SaveSummary } from '../save-library';
import type { Segment, SupplierSpec, Where } from './types';

const FORBIDDEN_SPECIALIST_ENV = /PASSWORD|SECRET|TOKEN|HAGGIS_RUN|WORKER_|DEMO_OK|^BUN_|^COORDINATOR_|^TICK_RECORD|^REPLAY_ONLY|^PRACTICE_/i;
const FORBIDDEN_SUPPLIER_ENV = /PASSWORD|SECRET|TOKEN|HAGGIS_RUN|WORKER_|DEMO_OK|^BUN_|^COORDINATOR_|^TICK_RECORD|^REPLAY_ONLY/i;

function checkSupplierSpec(sup: SupplierSpec) {
    if (!sup || typeof sup !== 'object' || !sup.save || typeof sup.save !== 'object' || Array.isArray(sup.save) || !/^scripts\/[\w/-]+\.ts$/.test(sup.script ?? ''))
        throw Error('invalid specialist supplier configuration');
    if (Object.keys(sup.env ?? {}).some(k => !/^[_a-z][_a-z0-9]*$/i.test(k) || FORBIDDEN_SUPPLIER_ENV.test(k)))
        throw Error('invalid specialist supplier environment');
}

export function resolveSegmentSuppliers(seg: Pick<Segment, 'supplier' | 'suppliers'>): SupplierSpec[] {
    if (seg.supplier !== undefined && seg.suppliers !== undefined)
        throw Error('specialist rehearsal cannot set both supplier and suppliers');
    if (seg.suppliers !== undefined) {
        if (!Array.isArray(seg.suppliers) || seg.suppliers.length < 1 || seg.suppliers.length > 32)
            throw Error('specialist rehearsal suppliers must contain 1 to 32 items');
        return seg.suppliers;
    }
    return seg.supplier !== undefined ? [seg.supplier] : [];
}

export function checkSpecialistSegment(seg: Segment, account: string) {
    const name = typeof account === 'string' ? account.toLowerCase() : '';
    const board = Object.hasOwn(SPECIALIST_BOARDS, name) ? SPECIALIST_BOARDS[name]!.name : undefined;
    if (!board) throw Error('unknown reserved specialist');
    if (!seg.start || !('fresh' in seg.start) || seg.start.fresh !== true || Object.keys(seg.start).length !== 1 || seg.capture)
        throw Error('specialist rehearsal needs a fresh engine account with no fixture or segment capture');
    if (seg.expect?.skills?.[board] !== 99) throw Error('specialist rehearsal must target level 99');
    if (!seg.plan || !Number.isSafeInteger(seg.plan.ticks) || seg.plan.ticks <= 0 || !seg.plan.source?.trim())
        throw Error('specialist rehearsal needs a priced route plan');
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(seg.id) || !/^scripts\/[\w/-]+\.ts$/.test(seg.script))
        throw Error('invalid specialist segment or worker path');
    if (Object.keys(seg.env ?? {}).some(k => !/^[_a-z][_a-z0-9]*$/i.test(k) || FORBIDDEN_SPECIALIST_ENV.test(k)))
        throw Error('invalid specialist worker environment');
    for (const sup of resolveSegmentSuppliers(seg)) checkSupplierSpec(sup);
    return board;
}

export function findSegment(id: string, dir = LIBRARY_DIR): Segment {
    const s = ((readLibrary(dir) as {segments?: Segment[]}).segments ?? []).find(s => s.id === id);
    if (!s) throw new Error(`no segment ${id} in ${join(dir, 'library.json')}`);
    return s;
}

export function itemCount(s: SaveSummary, id: string, where: Where = 'any'): number {
    const from = where === 'any' ? [s.inventory, s.bank, s.worn] : [s[where]];
    return from.reduce((n, c) => n + (c[id] ?? 0), 0);
}

export function checkExpect(s: SaveSummary, expect: Segment['expect']): Record<string, boolean> {
    const unknown = Object.keys(expect).filter(k => !['skills', 'items', 'position'].includes(k));
    if (unknown.length) throw new Error(`unknown expectation keys: ${unknown.join(', ')}`);
    const out: Record<string, boolean> = {};
    for (const [skill, min] of Object.entries(expect.skills ?? {})) {
        if (!SKILLS.includes(skill as never)) throw new Error(`unknown skill ${skill}`);
        const info = s.skills[skill];
        out[`skill.${skill}>=${min}`] = Math.max(info?.level ?? 1, levelForXp(info?.xp ?? 0)) >= min;
    }
    for (const [id, e] of Object.entries(expect.items ?? {})) {
        if (e.in !== undefined && e.in !== 'inventory' && e.in !== 'bank' && e.in !== 'worn' && e.in !== 'any') {
            throw new Error(`unknown item expectation location ${String(e.in)} for ${id}`);
        }
        if (e.min !== undefined && (!Number.isSafeInteger(e.min) || e.min < 0)) throw new Error(`invalid min expectation for ${id}`);
        if (e.max !== undefined && (!Number.isSafeInteger(e.max) || e.max < 0)) throw new Error(`invalid max expectation for ${id}`);
        if (e.min !== undefined && e.max !== undefined && e.min > e.max) throw new Error(`min > max expectation for ${id}`);
        const n = itemCount(s, id, e.in);
        out[`item.${id}.${e.in ?? 'any'}`] = (e.min === undefined || n >= e.min) && (e.max === undefined || n <= e.max);
    }
    const p = expect.position;
    if (p) out.position = s.position.level === p.level && Math.max(Math.abs(s.position.x - p.x), Math.abs(s.position.z - p.z)) <= p.radius;
    return out;
}

// Engine ticks from the first poll that sees the account in the world to the first poll that sees it gone.
// One poll every 100 ms against a 150 ms tick reads each boundary to within one tick.
export class TickWindow {
    enter: number | null = null;
    leave: number | null = null;
    constructor(private readonly relog = false) {}
    observe(tick: number, inWorld: boolean) {
        if (inWorld) {
            if (this.enter === null) this.enter = tick;
            if (this.relog) this.leave = null;
        } else if (this.enter !== null && this.leave === null) {
            this.leave = tick;
        }
    }
    get ticks(): number | null { return this.enter !== null && this.leave !== null ? this.leave - this.enter : null; }
}
