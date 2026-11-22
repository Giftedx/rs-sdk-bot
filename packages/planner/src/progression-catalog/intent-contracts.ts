import { readFileSync } from 'node:fs';
import type {
    CatalogAccept,
    ProgressionCatalog,
    WorkIntent,
} from '../../../core/src/progression-adapter';
import { trainingTargets } from '../progression';
import { finiteLevel, key, setting, whole } from './catalog';

export type EnvRecord = Readonly<Record<string, string | undefined>>;

export function trainingIntent(targets: Record<string, number>): WorkIntent | null {
    const normalized = trainingTargets({ kind: 'train-all', targets });
    if (!normalized) return null;
    const entries = Object.entries(normalized);
    return entries.length === 1
        ? { kind: 'train', skill: entries[0]![0], targetLevel: entries[0]![1] }
        : { kind: 'train-all', targets: normalized };
}

function sameTargets(a: WorkIntent, b: WorkIntent): boolean {
    const sortEntries = (intent: WorkIntent) => JSON.stringify(Object.entries(trainingTargets(intent) ?? {}).sort());
    return sortEntries(a) === sortEntries(b);
}

// openBot removes a leading actor name: the donor retains [receiver, amount],
// while the receiver retains [donor, receiver, amount]. The worker supplies the
// same exact participant pair for both; ownership and bank reserves stay its guards.
export function coinTransferIntent(args: readonly string[], env: EnvRecord): WorkIntent | null {
    const account = (s: unknown): s is string =>
        typeof s === 'string' && s.trim() === s && /^[A-Za-z0-9_ -]{1,12}$/.test(s) && !/^(main|haggis)$/i.test(s);
    const pair = (v: unknown): v is [string, string] =>
        Array.isArray(v) && v.length === 2 && v.every(account) && key(v[0]) !== key(v[1]);
    let participants: [string, string] | undefined;
    if (env.COORDINATOR_PARTICIPANTS !== undefined) {
        try {
            const parsed: unknown = JSON.parse(env.COORDINATOR_PARTICIPANTS);
            if (!pair(parsed)) return null;
            participants = parsed;
        } catch {
            return null;
        }
    }
    let from: string, to: string, amountText: string, options: readonly string[];
    if (account(args[0]) && account(args[1]) && /^\d+$/.test(args[2] ?? '')) {
        from = args[0]!;
        to = args[1]!;
        amountText = args[2]!;
        options = args.slice(3);
        if (!pair([from, to]) || (participants && (key(from) !== key(participants[0]) || key(to) !== key(participants[1])))) {
            return null;
        }
    } else if (participants && key(args[0] ?? '') === key(participants[1]) && /^\d+$/.test(args[1] ?? '')) {
        [from, to] = participants;
        amountText = args[1]!;
        options = args.slice(2);
    } else {
        return null;
    }
    const amount = Number(amountText);
    if (!whole(amount) || amount < 1 || amount > 2147483647) return null;
    const values: Record<string, number> = {
        reserve: 0,
        'bank-x': 3185,
        'bank-z': 3436,
        'request-ms': 30000,
        'timeout-ms': 240000,
        'grace-ms': 45000,
    };
    const seen = new Set<string>();
    for (const option of options) {
        const match = /^--(reserve|bank-x|bank-z|approach-ms|request-ms|timeout-ms|grace-ms)=(\d+)$/.exec(option);
        if (!match || seen.has(match[1]!)) return null;
        const value = Number(match[2]);
        if (!whole(value)) return null;
        seen.add(match[1]!);
        values[match[1]!] = value;
    }
    if (
        values.reserve! > 2147483647
        || !['bank-x', 'bank-z'].every(k => values[k]! > 0 && values[k]! < 16384)
        || (values['approach-ms'] !== undefined && (values['approach-ms']! < 1000 || values['approach-ms']! > 1800000))
        || values['request-ms']! < 1000 || values['request-ms']! > 60000
        || values['timeout-ms']! < values['request-ms']! || values['timeout-ms']! > 600000
        || values['grace-ms']! < 1000 || values['grace-ms']! > 60000
    ) {
        return null;
    }
    return {
        kind: 'service',
        objective: `finite owned coin transfer ${from} -> ${to}: ${amount} coins; donor bank reserve ${values.reserve}`,
    };
}

export function makeWineOrderIntent(args: readonly string[], accept?: CatalogAccept): WorkIntent | null {
    const maximum = Number(args[0]);
    const cap = Number(args[1] ?? 1000);
    const reserve = Number(args[2] ?? 0);
    if (args.length < 1 || args.length > 3 || ![maximum, cap, reserve].every(whole) || maximum < 1 || cap < 1) return null;
    // This is a new-notes delta, not an existing bank balance or incidental Cooking XP.
    if (accept && (Object.keys(accept).length !== 1 || Object.keys(accept.counters ?? {}).length !== 1 || accept.counters?.preservedWine !== maximum)) {
        return null;
    }
    return {
        kind: 'service',
        objective: `preserve ${maximum} new unfermented wine notes (1996) from owned grapes (1987) and jugs of water (1937); reconcile assets; input reserve ${reserve}; CAP ${cap}`,
        units: 1,
    };
}

export function trainPrayerIntent(
    args: readonly string[],
    env: EnvRecord,
    accept: CatalogAccept,
    requestedItems: Record<number, number>,
): WorkIntent | undefined {
    if (!accept.skills) return undefined;
    const skills = Object.entries(accept.skills);
    const target = Number(args[0] ?? env.TARGET_LEVEL ?? 43);
    const bone = Number(env.BONE_ID ?? 526);
    const reserve = Number(env.BONE_RESERVE ?? 6);
    const cap = Number(env.CAP ?? 1500);
    const maximum = Number(env.MAX_BURY ?? 175);
    // Matching Prayer work owns the intent; retained bank stock stays a coordinator postcondition.
    if (
        args.length <= 1
        && skills.length === 1
        && key(skills[0]![0]) === 'prayer'
        && skills[0]![1] === target
        && finiteLevel(target)
        && target >= 43
        && [526, 532, 536].includes(bone)
        && whole(reserve) && reserve >= 6
        && requestedItems[bone] !== undefined && requestedItems[bone]! >= reserve
        && whole(cap) && cap >= 1 && cap <= 1000000
        && whole(maximum) && maximum >= 1 && maximum <= 1000000
        && (env.BURY_HELD === undefined || env.BURY_HELD === '0')
        && accept.quests === undefined
        && accept.counters === undefined
    ) {
        return { kind: 'train', skill: 'prayer', targetLevel: target };
    }
    return undefined;
}

export function cannonFightIntent(
    args: readonly string[],
    env: EnvRecord,
    consumer: string,
    acceptedSkills: readonly [string, number][],
    accept?: CatalogAccept,
): WorkIntent | null {
    const mode = setting(env, args, 'MODE');
    if (mode === 'buy' || mode === 'reclaim') return { kind: 'acquire', items: { 6: 1, 8: 1, 10: 1, 12: 1 }, consumer };
    if (mode !== undefined) return null;
    const text = setting(env, args, 'STOP');
    const targets: Record<string, number> = {};
    if (text !== undefined) {
        for (const part of text.split(',')) {
            const match = part.trim().match(/^([A-Za-z]+)=(\d+)$/);
            if (!match || Object.hasOwn(targets, key(match[1]!))) return null;
            targets[key(match[1]!)] = Number(match[2]);
        }
    } else {
        targets[setting(env, args, 'STOP_SKILL') ?? 'Ranged'] = Number(setting(env, args, 'STOP_LEVEL') ?? 99);
    }
    const actual = trainingIntent(targets);
    if (!actual) return null;
    if (acceptedSkills.length) {
        const declared = trainingIntent(accept!.skills!);
        return declared && sameTargets(actual, declared) ? declared : null;
    }
    return actual;
}

export function rangedLivePrepIntent(args: readonly string[], env: EnvRecord): WorkIntent | null {
    const modeArg = args.find(a => a.startsWith('--mode='));
    const mode = (modeArg ? modeArg.slice(7) : 'all').trim().toLowerCase();
    if (!['all', 'leather', 'brew', 'decant'].includes(mode)) return null;
    const capArg = args.find(a => a.startsWith('--cap='));
    const positional = args.filter(a => !a.startsWith('--'));
    const posCap = positional.length >= 2 && /^\d+$/.test(positional[1]!)
        ? positional[1]
        : positional.length === 1 && /^\d+$/.test(positional[0]!)
            ? positional[0]
            : undefined;
    const cap = Number(capArg ? capArg.slice(6) : setting(env, args, 'CAP') ?? posCap ?? '2400');
    if (!whole(cap) || cap < 100 || cap > 20000) return null;
    return { kind: 'service', objective: `ranged-live-prep:${mode}`, units: 1 };
}

export function geProofIntent(args: readonly string[]): WorkIntent | null {
    const actor = args[1];
    if (!actor || !/^[A-Za-z0-9]{1,12}$/.test(actor)) return null;
    if (args[0] === '--snapshot') {
        return args.length === 2 ? { kind: 'observe', objective: `observe the owned native GE bank of ${actor} once`, units: 1 } : null;
    }
    if (args[0] !== '--sell' || args.length !== 5) return null;
    const item = Number(args[2]);
    const quantity = Number(args[3]);
    const price = Number(args[4]);
    return [item, quantity, price].every(n => whole(n) && n > 0)
        && item !== 995
        && item <= 2147483647
        && Number.isSafeInteger(quantity * price)
        && quantity * price <= 2147483647
        ? { kind: 'service', objective: `post one owned native GE sell offer: ${quantity} of item ${item} at ${price} each; confirm escrow debit and logout`, units: 1 }
        : null;
}

export function handoffInputsIntent(args: readonly string[], env: EnvRecord): WorkIntent | null {
    // These are new-output/delta orders. Existing stock cannot satisfy them before
    // the worker reconciles the exact debit, bank credit and logout. Explicit parent targets still win above.
    if (args[0] === '--headless-order') {
        const maximum = Number(args[1]);
        const logs = Number(args[2]);
        const cap = Number(env.CAP ?? 1600);
        return args.length === 3 && [maximum, logs, cap].every(whole) && maximum >= 15 && maximum % 15 === 0 && logs >= 1 && logs <= 25 && cap > 0
            ? { kind: 'service', objective: `bank ${maximum} new headless arrows (53) from ${logs} plain logs (1511), owned shafts (52) and feathers (314); retain knife (946) and input reserves; CAP ${cap}`, units: 1 }
            : null;
    }
    const [donor, receiver, ...rest] = args;
    const order = env.HANDOFF_ORDER;
    const items = rest.filter(a => !a.startsWith('--'));
    if (
        !donor || !receiver || donor.toLowerCase() === receiver.toLowerCase()
        || ![donor, receiver].every(n => /^[A-Za-z0-9_ -]{1,12}$/.test(n) && n.trim() === n && !/^(main|haggis)$/i.test(n))
        || !order || !/^[a-zA-Z0-9-]{1,64}$/.test(order)
        || !items.length
        || items.some(item => { const m = item.match(/^([1-9]\d*):([^\r\n\0]+)$/); return !m || !whole(Number(m[1])) || !m[2]!.trim(); })
    ) {
        return null;
    }
    return {
        kind: 'service',
        objective: `settle exact owned handoff ${order} ${JSON.stringify(args)}${env.HANDOFF_ITEM_ID ? ' plain item ID ' + env.HANDOFF_ITEM_ID : ''}; reconcile donor debit and receiver bank credit`,
        units: 1,
    };
}

export function jewelleryTripIntent(
    args: readonly string[],
    env: EnvRecord,
    consumer: string,
    data?: ProgressionCatalog,
): WorkIntent | null {
    try {
        const raw = args[0];
        const order = raw
            ? JSON.parse(readFileSync(raw, 'utf8'))
            : { recipe: env.RECIPE, target: Number(env.TARGET), stringAmulet: env.STRING_AMULET === '1' };
        if (typeof order.recipe !== 'string' || !whole(order.target) || order.target < 1 || order.target > 10000) return null;
        const native = data?.methods.find(m => {
            const job = m.execution?.bankJob;
            return !!job && job.family === 'jewellery' && job.recipe === order.recipe;
        });
        let products = native && Object.keys(native.effects.items ?? {});
        if (products?.length !== 1) return null;
        if (order.stringAmulet) {
            const id = Number(products[0]);
            const stringers = data?.methods.filter(m => {
                const job = m.execution?.bankJob;
                return !!job && job.family === 'inventory' && typeof job.recipe === 'string' && job.recipe.startsWith('string-') && !!m.inputs?.[id];
            }) ?? [];
            if (stringers.length !== 1) return null;
            products = Object.keys(stringers[0]!.effects.items ?? {});
            if (products.length !== 1) return null;
        }
        return { kind: 'produce', items: { [Number(products[0])]: order.target }, consumer };
    } catch {
        return null;
    }
}

export function microbotGeTripIntent(args: readonly string[]): WorkIntent | null {
    try {
        const file = args.find(a => a.endsWith('.json') && !a.includes('='));
        if (!file) return null;
        const r = JSON.parse(readFileSync(file, 'utf8'));
        if (
            !/^[a-z0-9]{1,12}$/i.test(r?.actor ?? '') || !r?.server || !/^[a-z0-9_-]{1,64}$/i.test(r?.goal ?? '')
            || ![r.item, r.quantity, r.price, r.floor, r.deadline].every(whole) || r.item < 1 || r.item === 995
            || r.quantity < 1 || r.quantity > 24 || r.floor < 1 || r.price < r.floor || r.price * r.quantity > 2147483647
            || !whole(r.reserve) || !whole(r.fillWait) || r.fillWait > 200 || !whole(r.cap) || r.cap < 500 || r.cap > 100000
        ) {
            return null;
        }
        return { kind: 'service', objective: `ge-trip:${r.item}:${r.quantity}:${r.price}`, units: 1 };
    } catch {
        return null;
    }
}

export function microbotBankSellerIntent(args: readonly string[]): WorkIntent | null {
    try {
        const file = args.find(a => a.endsWith('.json') && !a.includes('='));
        if (!file) return null;
        const r = JSON.parse(readFileSync(file, 'utf8'));
        if (
            !r || r.allTradeable !== true || !Array.isArray(r.protect) || r.protect.some((id: unknown) => !whole(id))
            || !r.reserves || typeof r.reserves !== 'object'
            || Object.entries(r.reserves).some(([id, n]) => !/^\d+$/.test(id) || !whole(n))
            || !whole(r.maxItems) || r.maxItems < 1 || r.maxItems > 32
            || !whole(r.maxUnits) || r.maxUnits < 1 || r.maxUnits > 768
            || !whole(r.perItem) || r.perItem < 1 || r.perItem > 24
            || ![0, 5, 10, 50].includes(r.discount)
            || !whole(r.floor) || r.floor < 1 || !whole(r.unitCap) || r.unitCap < r.floor
            || !whole(r.childCap) || r.childCap < 600 || r.childCap > 100000
            || !whole(r.cap) || r.cap < r.childCap + 200 || r.cap > 100000
            || !whole(r.fillWait) || r.fillWait > 200
            || !whole(r.deadline) || r.deadline < 1
            || !/^[a-z0-9_-]{1,20}$/i.test(r.goal ?? '')
        ) {
            return null;
        }
        return { kind: 'service', objective: `bank-seller:${r.goal}:${r.maxItems}:${r.maxUnits}`, units: 1 };
    } catch {
        return null;
    }
}

export function shopToBidIntent(args: readonly string[], env: EnvRecord): WorkIntent | null {
    const positional = args.filter(a => !a.includes('=') && !a.startsWith('-'));
    const offset = positional.length === 3 && /^[a-z0-9]{1,12}$/i.test(positional[0]!) && !positional[0]!.includes(',') ? 1 : 0;
    const profiles = positional[offset]?.toLowerCase();
    const itemIds = positional[offset + 1];
    const bounds = [['UNITS', 1], ['LOTS', 1], ['MIN_NET', 0], ['COIN_RESERVE', 0], ['MAX_SPEND', 0], ['WAIT_TICKS', 0], ['MIN_LOT', 0]] as const;
    if (
        positional.length - offset !== 2
        || !profiles || !/^[a-z0-9_]+(?:,[a-z0-9_]+)*$/.test(profiles)
        || !itemIds || !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(itemIds)
        || bounds.some(([k, min]) => { const raw = setting(env, args, k); return raw !== undefined && (!whole(Number(raw)) || Number(raw) < min); })
    ) {
        return null;
    }
    return { kind: 'service', objective: `shop-to-bid:${profiles}:${itemIds}`, units: 1 };
}
