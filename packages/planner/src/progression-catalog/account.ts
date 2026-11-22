import type { ObservedAccount } from '../../../core/src/progression-adapter';
import { dated, finiteLevel, key, whole } from './catalog';

function countRows(rows: unknown): Record<number, number> | null {
    if (!Array.isArray(rows)) return null;
    const out: Record<number, number> = {};
    for (const row of rows) {
        const id = row?.id ?? row?.baseId;
        const n = row?.count;
        if (!whole(id) || id < 1 || !whole(n)) return null;
        const total = (out[id] ?? 0) + n;
        if (!whole(total)) return null;
        out[id] = total;
    }
    return out;
}

function makeObservation(rows: unknown, time: unknown, at: number, now: number, source: string) {
    const value = countRows(rows);
    return dated(time, now) && at > 0 && time <= at && value !== null ? { at: time, value, source } : null;
}

function parseSkills(rawSkills: unknown, at: number): ObservedAccount['skills'] {
    const skills: ObservedAccount['skills'] = {};
    if (!at || !Array.isArray(rawSkills)) return skills;
    for (const skill of rawSkills) {
        const name = typeof skill?.name === 'string' ? key(skill.name) : '';
        const level = skill?.baseLevel ?? skill?.level;
        const xp = skill?.xp ?? skill?.experience;
        if (name && finiteLevel(level) && typeof xp === 'number' && Number.isFinite(xp) && xp >= 0) {
            skills[name] = { level, xp };
        }
    }
    return skills;
}

function parseQuests(status: any, at: number, now: number): ObservedAccount['quests'] {
    const questRows = Array.isArray(status.questJournal) ? status.questJournal : status.quests;
    const questAt = status.questsAt ?? at;
    if (!at || !Array.isArray(questRows) || !dated(questAt, now) || questAt > at) return null;
    const quests: Record<string, true | false | null> = {};
    for (const q of questRows) {
        if (typeof q === 'string') {
            quests[key(q)] = true;
        } else if (typeof q?.name === 'string') {
            quests[key(q.name)] = q.state === 'complete'
                ? true
                : q.state === 'not started' || q.state === 'in progress' || q.state === 'started'
                    ? false
                    : null;
        }
    }
    return { at: questAt, value: quests, source: 'status.quests' };
}

function parseFacts(status: any): Record<string, true | false | null> {
    const facts: Record<string, true | false | null> = {};
    for (const [fact, value] of Object.entries(status.facts ?? {})) {
        if (value === true || value === false || value === null) facts[fact] = value;
    }
    if (typeof status.members === 'boolean') facts.members = status.members;
    else if (typeof status.isMembers === 'boolean') facts.members = status.isMembers;
    return facts;
}

function parseReservations(raw: unknown): Record<number, number> {
    const reservations: Record<number, number> = {};
    for (const [id, n] of Object.entries(raw ?? {})) {
        if (whole(Number(id)) && Number(id) > 0 && whole(n)) reservations[Number(id)] = n;
    }
    return reservations;
}

/** Normalizes a raw account status snapshot while keeping container observations independent. */
// Keep containers independent: a recent status cannot refresh its older bank, and noted items retain their exact ID.
export function accountFromStatus(account: string, status: any, now = Date.now()): ObservedAccount {
    if (!account.trim()) throw Error('account identity required');
    const empty: ObservedAccount = { account, at: 0, skills: {}, inventory: null, equipment: null, bank: null, quests: null };
    if (status === null || status === undefined) return empty;
    const identity = status.name ?? status.account;
    if (typeof identity !== 'string' || key(identity) !== key(account)) throw Error('account identity observation mismatch');
    const at = dated(status.at, now) ? status.at : 0;
    const p = status.pos ?? status.player;
    const x = p?.x ?? p?.worldX;
    const z = p?.z ?? p?.worldZ;
    const plane = p?.level;
    const hasValidClock = status.clock
        && typeof status.clock.protected === 'boolean'
        && typeof status.clock.fresh === 'boolean'
        && typeof status.clock.authorized === 'boolean';
    return {
        account,
        at,
        skills: parseSkills(status.skills, at),
        inventory: makeObservation(status.inventory, at, at, now, 'status.inventory'),
        equipment: status.equipmentObserved === false ? null : makeObservation(status.equipment, at, at, now, 'status.equipment'),
        bank: makeObservation(status.bank, status.bankAt, at, now, 'status.bank'),
        quests: parseQuests(status, at, now),
        ...(typeof status.server === 'string' ? { server: status.server } : {}),
        ...(typeof status.role === 'string' ? { role: status.role } : {}),
        ...(typeof status.workRevision === 'string' ? { source: status.workRevision } : {}),
        ...(at && whole(x) && whole(z) && whole(plane) && plane <= 3 ? { position: { at, value: { x, z, level: plane }, source: 'status.position' } } : {}),
        ...(whole(status.hp?.now) ? { currentHP: status.hp.now } : {}),
        facts: parseFacts(status),
        reservations: parseReservations(status.reservations),
        ...(hasValidClock ? { clock: status.clock } : {}),
        ...(status.build?.maxLevels ? { build: { maxLevels: status.build.maxLevels } } : {}),
    };
}
