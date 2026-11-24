// Pure zero-heavy-dependency logistics preflight parsers, validators, and location/kit checks.
import { combatLevel } from '../../../core/src/danger/catalog';

export const ACCOUNT_NAME_RE = /^[A-Za-z0-9_ -]{1,12}$/;

export type HandoffItem = { name: string; count: number };
export type Handoff = {
    donor: string;
    receiver: string;
    items: HandoffItem[];
    notes: boolean;
    keep?: string;
    x: number;
    z: number;
    approachMs?: number;
    requestMs: number;
    timeoutMs: number;
    graceMs: number;
};

const HANDOFF_NUMERIC_FIELDS: Readonly<Record<string, 'x' | 'z' | 'approachMs' | 'requestMs' | 'timeoutMs' | 'graceMs'>> = {
    '--bank-x': 'x',
    '--bank-z': 'z',
    '--approach-ms': 'approachMs',
    '--request-ms': 'requestMs',
    '--timeout-ms': 'timeoutMs',
    '--grace-ms': 'graceMs',
};
const HANDOFF_ITEM_RE = /^(\d+):(.+)$/;
const DIGITS_ONLY_RE = /^\d+$/;
const RESERVED_HANDOFF_NAME_RE = /^(main|haggis)$/i;

export function parseHandoff(args: string[]): Handoff {
    const [donor, receiver] = args;
    if (!donor || !receiver || donor.trim() !== donor || receiver.trim() !== receiver
        || !ACCOUNT_NAME_RE.test(donor) || !ACCOUNT_NAME_RE.test(receiver)
        || RESERVED_HANDOFF_NAME_RE.test(donor) || RESERVED_HANDOFF_NAME_RE.test(receiver)
        || donor.toLowerCase() === receiver.toLowerCase()) {
        throw new Error('two distinct non-reserved account names required');
    }
    const cfg: Handoff = { donor, receiver, items: [], notes: false, x: 2654, z: 3283, requestMs: 30_000, timeoutMs: 240_000, graceMs: 45_000 };
    const seen = new Set<string>();
    const seenItems = new Set<string>();
    let keepRegex: RegExp | undefined;
    for (let idx = 2; idx < args.length; idx++) {
        const arg = args[idx]!;
        if (!arg.startsWith('--')) {
            const m = HANDOFF_ITEM_RE.exec(arg);
            const count = Number(m?.[1]), name = m?.[2]?.trim();
            if (!name || /[\r\n\0]/.test(name) || name.length > 80 || !Number.isSafeInteger(count) || count < 1) throw new Error('invalid handoff item/count');
            const lowerName = name.toLowerCase();
            if (seenItems.has(lowerName)) throw new Error('duplicate handoff item');
            seenItems.add(lowerName);
            cfg.items.push({ name, count });
            continue;
        }
        const eq = arg.indexOf('=');
        const key = eq >= 0 ? arg.slice(0, eq) : arg;
        const hasVal = eq >= 0;
        const v = hasVal ? arg.slice(eq + 1) : '';
        if (seen.has(key)) throw new Error('duplicate handoff option');
        seen.add(key);
        if (key === '--notes' && !hasVal) cfg.notes = true;
        else if (key === '--keep' && v && v.length <= 300) {
            keepRegex = new RegExp(v, 'i');
            cfg.keep = v;
        } else {
            const field = HANDOFF_NUMERIC_FIELDS[key];
            if (field && hasVal && DIGITS_ONLY_RE.test(v)) {
                cfg[field] = Number(v);
            } else {
                throw new Error(`unknown/invalid handoff option ${key}`);
            }
        }
    }
    if (!cfg.items.length || !Number.isSafeInteger(cfg.x) || cfg.x <= 0 || cfg.x >= 16384
        || !Number.isSafeInteger(cfg.z) || cfg.z <= 0 || cfg.z >= 16384
        || cfg.approachMs !== undefined && (!Number.isSafeInteger(cfg.approachMs) || cfg.approachMs < 1000 || cfg.approachMs > 1_800_000)
        || !Number.isSafeInteger(cfg.requestMs) || cfg.requestMs < 1000 || cfg.requestMs > 60_000
        || !Number.isSafeInteger(cfg.timeoutMs) || cfg.timeoutMs < cfg.requestMs || cfg.timeoutMs > 600_000
        || !Number.isSafeInteger(cfg.graceMs) || cfg.graceMs < 1000 || cfg.graceMs > 60_000) {
        throw new Error('invalid handoff bounds/items');
    }
    if (keepRegex && cfg.items.some(i => keepRegex!.test(i.name))) throw new Error('requested item overlaps protected KEEP');
    return cfg;
}

export function parseCoins(args: string[]) {
    const [from, to, amount, ...options] = args;
    if (!amount || !DIGITS_ONLY_RE.test(amount) || Number(amount) > 2147483647) throw Error('positive exact coin amount required');
    let reserveCount = 0;
    let reserveOpt: string | undefined;
    const rest: string[] = [];
    let hasBankX = false;
    let hasBankZ = false;
    for (let i = 0; i < options.length; i++) {
        const opt = options[i]!;
        const eq = opt.indexOf('=');
        const key = eq >= 0 ? opt.slice(0, eq) : opt;
        if (key === '--reserve') {
            reserveCount++;
            reserveOpt = opt;
        } else {
            if (key === '--bank-x') hasBankX = true;
            else if (key === '--bank-z') hasBankZ = true;
            rest.push(opt);
        }
    }
    if (reserveCount > 1) throw Error('duplicate coin reserve option');
    const text = reserveOpt ? reserveOpt.slice('--reserve='.length) : '0';
    const reserve = Number(text);
    if ((reserveOpt !== undefined && (!reserveOpt.startsWith('--reserve=') || !DIGITS_ONLY_RE.test(text)))
        || !Number.isSafeInteger(reserve) || reserve < 0 || reserve > 2147483647) {
        throw Error('coin donor bank reserve must be an integer from 0 to 2147483647');
    }
    const handoffArgs = [from ?? '', to ?? '', `${amount}:Coins`];
    if (!hasBankX) handoffArgs.push('--bank-x=3185');
    if (!hasBankZ) handoffArgs.push('--bank-z=3436');
    for (let i = 0; i < rest.length; i++) handoffArgs.push(rest[i]!);
    const c = parseHandoff(handoffArgs);
    if (c.notes || c.keep) throw Error('coin courier does not accept notes or keep options');
    return { ...c, amount: Number(amount), reserve };
}

export function parseFanout(args: string[]) {
    const [donor, ...rest] = args, amount = rest.at(-1), receivers = rest.slice(0, -1);
    if (!donor || !amount || !DIGITS_ONLY_RE.test(amount) || !receivers.length) throw Error('usage: coin-fanout <donor> <receiver> [receiver ...] <amount>');
    const seen = new Set<string>([donor.toLowerCase()]);
    for (let i = 0; i < receivers.length; i++) {
        const lower = receivers[i]!.toLowerCase();
        if (seen.has(lower)) throw Error('each account once');
        seen.add(lower);
    }
    return { donor, receivers, pairs: receivers.map(r => parseCoins([donor, r, amount])) };
}

export function parseFanin(args: string[]) {
    const item = args.at(-1), [receiver, ...donors] = args.slice(0, -1);
    if (!receiver || !donors.length || !item || DIGITS_ONLY_RE.test(item)) throw Error('usage: item-fanin <receiver> <donor> [donor ...] <item name>');
    const seen = new Set<string>([receiver.toLowerCase()]);
    for (let i = 0; i < donors.length; i++) {
        const lower = donors[i]!.toLowerCase();
        if (seen.has(lower)) throw Error('each account once');
        seen.add(lower);
    }
    for (const donor of donors) parseHandoff([donor, receiver, '1:' + item]);
    return { receiver, donors, item };
}

export function parseTakeFromBankerArgs(args: readonly string[]) {
    let banker = 'Moneyshot';
    const items: { name: string; count: number }[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a.startsWith('--banker=')) {
            if (banker === 'Moneyshot') banker = a.slice(9);
        } else if (!a.startsWith('--')) {
            const colon = a.indexOf(':');
            const c = colon >= 0 ? a.slice(0, colon) : a;
            const n = colon >= 0 ? a.slice(colon + 1) : '';
            items.push({ name: n, count: Number(c) });
        }
    }
    if (!items.length || items.some(i => !i.name || !Number.isSafeInteger(i.count) || i.count <= 0)) {
        throw new Error('usage: take-from-banker <bot> <count>:<item> ... [--banker=Moneyshot]');
    }
    return { banker, items };
}

export type Altar = { id: number; x: number; z: number; level: number; label: string };

export const PRAYER_ALTARS: readonly Altar[] = [
    { id: 61, x: 3239, z: 3608, level: 0, label: 'Wilderness chaos temple' },
    { id: 409, x: 3253, z: 3486, level: 0, label: 'Varrock east church' },
    { id: 411, x: 2932, z: 3513, level: 0, label: 'Goblin Village chaos altar' },
    { id: 411, x: 3259, z: 3381, level: 0, label: 'Varrock south-east chaos altar' },
    { id: 410, x: 2925, z: 3483, level: 0, label: 'Taverley altar of Guthix' },
    { id: 409, x: 2617, z: 3309, level: 0, label: 'East Ardougne church' },
    { id: 409, x: 2694, z: 3462, level: 0, label: 'Seers Village church' },
    { id: 409, x: 2853, z: 3348, level: 0, label: 'Entrana church' },
    { id: 409, x: 3243, z: 3205, level: 0, label: 'Lumbridge church' },
    { id: 409, x: 2991, z: 3177, level: 0, label: 'Port Sarim church' },
];

export const inWilderness = (a: Pick<Altar, 'x' | 'z'>): boolean =>
    a.x >= 2944 && a.x <= 3391 && a.z >= 3520 && a.z <= 3967;

export const SAFE_ALTARS: readonly Altar[] = PRAYER_ALTARS.filter(a => !inWilderness(a));

export const altarText = (args: readonly string[], env: string | undefined): string | undefined =>
    args.find(a => /^ALTAR=/.test(a))?.slice(6) ?? (env || undefined);

export function parseAltar(text: string | undefined, list: readonly Altar[] = PRAYER_ALTARS): Altar | undefined {
    if (!text) return undefined;
    const m = text.match(/^(\d+),(\d+)$/);
    const a = m ? list.find(r => r.x === Number(m[1]) && r.z === Number(m[2])) : undefined;
    if (!a) throw Error(`ALTAR=${text} is not in PRAYER_ALTARS`);
    return a;
}

export const GLORY_UNCHARGED = [1704, 1706, 1708, 1710] as const;

export function canEnterHeroesBasement(acct: {
    quests?: ReadonlySet<string>;
    varps?: Readonly<Record<string, number>>;
    questStages?: Readonly<Record<string, number>>;
    unlocks?: readonly string[];
    skills: Record<string, number>;
}): { ok: boolean; reason?: string } {
    const heroDone = !!acct.quests?.has("hero's quest") || (acct.varps?.heroquest ?? acct.questStages?.heroquest ?? 0) >= 15 || !!acct.unlocks?.includes('complete:heroquest');
    if (!heroDone) return { ok: false, reason: "Hero's Quest is required for the Fountain of Heroes" };
    const skills: Record<string, number> = {};
    for (const k in acct.skills) {
        if (Object.hasOwn(acct.skills, k)) skills[k.toLowerCase()] = acct.skills[k]!;
    }
    const cb = combatLevel(skills), hp = skills.hitpoints ?? 10;
    if (cb < 111 && hp < 75) return { ok: false, reason: `Heroes basement safety requires combat >= 111 or Hitpoints >= 75 (observed combat=${cb}, hp=${hp})` };
    return { ok: true };
}

export function parseRecoveryTargetArg(args: readonly string[]): { x: number; z: number; level: number } | undefined {
    const raw = args.find(a => a.startsWith('--target='));
    if (!raw) return undefined;
    const parts = raw.slice('--target='.length).split(',').map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isSafeInteger(n))) {
        throw Error(`invalid --target=${raw}`);
    }
    return { x: parts[0]!, z: parts[1]!, level: parts[2] ?? 0 };
}
