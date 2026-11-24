// Unified foraging, care, Miscellania coffer, and combat QoL utility worker.
import { existsSync, readFileSync } from 'node:fs';
import { openBot, settle } from '../../../core/src/bot';
import { equipmentObserved } from '../../../core/src/container-observation';
import { componentId } from '../../../core/src/logout';
import { questFlags } from '../../../core/src/quest-status';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { watchProductionLife } from './runtime';
import type { Session } from './types';

const marker = (s: Session) =>
    Math.max(-1, ...(s.sdk.getState()?.gameMessages ?? []).map(m => m.observationId ?? m.tick), ...(s.sdk.getState()?.recentDialogs ?? []).map(m => m.observationId ?? m.tick));
const fresh = (s: Session, cursor: number, re: RegExp) =>
    (s.sdk.getState()?.gameMessages ?? []).some(m => m.type === 0 && (m.observationId ?? m.tick) > cursor && re.test(m.text)) ||
    (s.sdk.getState()?.recentDialogs ?? []).some(m => (m.observationId ?? m.tick) > cursor && re.test(m.text.join(' ')));
const count = (s: Session, id: number) => {
    let n = 0;
    const inv = s.sdk.getInventory();
    for (let i = 0; i < inv.length; i++) {
        if (inv[i]!.id === id) n += inv[i]!.count;
    }
    return n;
};
const KITTEN_NAME_RE = /^Kitten$/i;
const DROP_OP_RE = /^drop$/i;
const CANNON_LOAD_RE = /You load the cannon with (\d+) cannonballs\./;
const CANNON_WITH_RE = /with (\d+) cannonballs/;
const SPECBAR_RE = /^combat_(blunt|axe|crossbow|bow|stabsword|hacksword|spiked|thrown|spear|claw|pickaxe|polearm|heavysword|unarmed):specbar$/;
const sameEquipmentRows = (
    a: readonly { id: number; slot: number; count: number }[],
    b: readonly { id: number; slot: number; count: number }[],
): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i]!.id !== b[i]!.id || a[i]!.slot !== b[i]!.slot || a[i]!.count !== b[i]!.count) return false;
    }
    return true;
};
const sameSkillXp = (a: readonly { experience: number }[], b: readonly number[]): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i]!.experience !== b[i]!) return false;
    }
    return true;
};
const samePackTotals = (inv: readonly { id: number; count: number }[], baseline: ReadonlyMap<number, number>): boolean => {
    const cur = new Map<number, number>();
    for (let i = 0; i < inv.length; i++) {
        const row = inv[i]!;
        cur.set(row.id, (cur.get(row.id) ?? 0) + row.count);
    }
    if (cur.size !== baseline.size) return false;
    for (const [id, n] of baseline) {
        if (cur.get(id) !== n) return false;
    }
    return true;
};

// ---- Care, Miscellania Weed, and Druid Pouch (microbot-c-care.ts) ----

const fishIds = [317, 321, 327, 335, 333, 331, 329, 359, 361];

export async function kittenCare(s: Session, npcIndex: number, mode: 'feed' | 'wool' | 'stroke', cap: number, stop: () => boolean = () => false) {
    if (!Number.isSafeInteger(npcIndex) || npcIndex < 0 || !['feed', 'wool', 'stroke'].includes(mode) || !Number.isSafeInteger(cap) || cap < 1) {
        throw Error('invalid kitten care');
    }
    const life = watchProductionLife(s, stop);
    const start = s.tick();
    const over = () => life.stopped() || s.tick() - start >= cap;
    const target = s.sdk.getState()?.nearbyNpcs.find(n => n.index === npcIndex && /^Kitten$/i.test(n.name));
    if (!target) throw Error('selected kitten not nearby');
    const stock = s.sdk.getInventory().map(i => ({ id: i.id, count: count(s, i.id) }));
    const cursor = marker(s);
    let input: number | undefined;
    let ok = false;
    let detail = '';
    try {
        if (over()) throw Error(life.reason() || 'kitten budget');
        if (mode === 'stroke') {
            await s.sdk.sendInteractNpc(npcIndex, 3);
        } else {
            const item = s.sdk.getInventory().find(i => (mode === 'wool' ? i.id === 1759 : fishIds.includes(i.id)));
            if (!item) throw Error(mode === 'wool' ? 'stage a ball of wool' : 'stage a native kitten fish');
            input = item.id;
            await s.sdk.sendUseItemOnNpc(item.slot, npcIndex);
        }
        const expected = mode === 'feed' ? /kitten gobbles up/ : mode === 'wool' ? /kitten loves to play with that ball of wool/ : /softly stroke your cat/;
        await waitUntil(s, () => fresh(s, cursor, expected) || over(), { timeoutTicks: cap });
        const conserved = stock.every(i => count(s, i.id) === i.count - (mode === 'feed' && i.id === input ? 1 : 0));
        ok = fresh(s, cursor, expected) && conserved && !life.stopped();
        if (!ok) detail = life.reason() || 'kitten care effect/stock unconfirmed';
    } catch (error) {
        detail = String(error);
    }
    return {
        ok,
        mode,
        npcIndex,
        input: input ?? null,
        ticks: s.tick() - start,
        detail,
        proof: 'fresh native care message and exact fish debit or wool preservation; hidden hunger/attention varp is not read',
    };
}

export async function weedMiscellania(s: Session, maximum: number, cap: number, stop: () => boolean = () => false, xpMultiplier = 25) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(cap) || cap < 1 || !Number.isSafeInteger(xpMultiplier) || xpMultiplier < 1 || !Number.isSafeInteger(xpMultiplier * (maximum + 1))) {
        throw Error('invalid miscellania order/XP multiplier');
    }
    const start = s.tick();
    const client = s.client as any;
    const executor = client?.executeBotAction;
    const state = () => s.sdk.getState();
    const p0 = state()?.player;
    const life = p0?.lifeId;
    const respawns = p0?.respawnCount ?? 0;
    const hp = s.sdk.getSkill('Hitpoints')?.level;
    const approval = () => {
        const raw = client?.var?.[361];
        return Number.isSafeInteger(raw) && raw >= -0x80000000 && raw <= 0xffffffff ? (raw >>> 18) & 127 : undefined;
    };
    const pack = () => {
        const out: Record<number, number> = {};
        for (const row of s.sdk.getInventory()) out[row.id] = (out[row.id] ?? 0) + row.count;
        return Object.entries(out).sort((a, b) => Number(a[0]) - Number(b[0]));
    };
    const gear = () => JSON.stringify(s.sdk.getEquipment());
    const skills = () => state()?.skills.map(k => k.experience);
    const xpBounds = (n: number) => [Math.floor((xpMultiplier * n) / 10), Math.ceil((xpMultiplier * n) / 10)] as const;
    const originalPack = JSON.stringify(pack());
    const originalGear = gear();
    const originalSkills = skills();
    const initialApproval = approval();
    let ended = false;
    let made = 0;
    let detail = '';
    void s.ended?.then(() => { ended = true; });
    if (
        !client ||
        typeof executor !== 'function' ||
        !p0 ||
        !Number.isSafeInteger(life) ||
        !Number.isSafeInteger(hp) ||
        hp! < 1 ||
        !equipmentObserved(client) ||
        originalSkills?.length !== 21 ||
        originalSkills.some(n => !Number.isSafeInteger(n) || n < 0) ||
        initialApproval === undefined
    ) {
        throw Error('Miscellania public owned state/approval unknown');
    }
    const unsafe = () => {
        const p = state()?.player;
        const xp = skills();
        return (
            ended ||
            s.client !== client ||
            client.executeBotAction !== executor ||
            stop() ||
            existsSync('.practice/stop-all') ||
            (!!s.name && existsSync('.practice/stop-' + s.name)) ||
            (!!process.env.STOP_FILE && existsSync(process.env.STOP_FILE)) ||
            !p ||
            p.isDead ||
            p.lifeId !== life ||
            (p.respawnCount ?? 0) !== respawns ||
            s.sdk.getSkill('Hitpoints')?.level !== hp ||
            s.sdk.getStateAge() > 5000 ||
            !equipmentObserved(client) ||
            JSON.stringify(pack()) !== originalPack ||
            gear() !== originalGear ||
            xp?.length !== 21 ||
            xp.some((n, i) => !Number.isSafeInteger(n) || (i !== 15 && n !== originalSkills[i]) || (i === 15 && (n < originalSkills[i]! + xpBounds(made)[0] || n > originalSkills[i]! + xpBounds(made + 1)[1])))
        );
    };
    const over = () => unsafe() || s.tick() - start >= cap;
    try {
        if ((s.sdk.getSkill('Herblore')?.level ?? 0) < 35) throw Error('Miscellania weeding requires 35 Herblore');
        if (!s.sdk.getEquipment().some(i => i.slot === 3 && [3899, 2961, 2963].includes(i.id))) throw Error('Miscellania weeding requires worn sickle');
        while (made < maximum && !over()) {
            const loc = () => state()?.nearbyLocs.filter(l => [4677, 4678, 4679].includes(l.id) && l.reachable !== false).sort((a, b) => a.distance - b.distance)[0];
            if (!loc()) await waitUntil(s, () => !!loc() || over(), { timeoutTicks: Math.min(60, Math.max(1, cap - (s.tick() - start))) });
            if (over()) break;
            const target = loc();
            const before = approval();
            const beforeXp = skills()![15]!;
            const cursor = marker(s);
            if (!target || before === undefined || before >= 127) throw Error('Miscellania patch/approval unavailable or full');
            const success = () => (state()?.gameMessages ?? []).some(m => m.type === 0 && (m.observationId ?? m.tick) > cursor && m.text === 'You manage to weed some herbs and give them to Gardener Gunnhild.');
            const paid = () => success() && approval() === before + 1 && skills()![15]! - beforeXp >= xpBounds(1)[0] && skills()![15]! - beforeXp <= xpBounds(1)[1];
            if (over()) break;
            await s.direct({ type: 'interactLoc', x: target.x, z: target.z, locId: target.id, optionIndex: 1, reason: 'finite native Miscellania weed' });
            await waitUntil(s, () => paid() || over(), { timeoutTicks: Math.min(40, Math.max(1, cap - (s.tick() - start))) });
            if (unsafe() || !paid()) throw Error('Miscellania fresh system success/public approval or owned state unconfirmed');
            made++;
            if (made < maximum && !over()) await waitTicks(s, Math.min(2, Math.max(1, cap - (s.tick() - start))));
        }
        if (made !== maximum) throw Error('Miscellania stop/life/owner/state or tick budget');
    } catch (error) {
        detail = String(error);
    }
    const preserved = JSON.stringify(pack()) === originalPack && gear() === originalGear;
    if (unsafe() || approval() !== initialApproval + made || skills()![15]! - originalSkills[15]! < xpBounds(made)[0] || skills()![15]! - originalSkills[15]! > xpBounds(made)[1]) {
        detail ||= 'Miscellania original owned state/approval lost';
    }
    return {
        ok: !detail && made === maximum && preserved,
        made,
        preserved,
        ticks: s.tick() - start,
        detail,
        xpMultiplier,
        approval: { before: initialApproval, after: approval(), source: 'public transmitted varp361 bits18..24' },
        herblorePublicXpDelta: (skills()?.[15] ?? NaN) - originalSkills[15]!,
        proof: 'exact fresh native system success and approval increment; public XP floors raw tenths',
    };
}

export function druidPouchFillDelta(rows: readonly { id: number; count: number }[]) {
    const held = (id: number) => rows.filter(r => r.id === id).reduce((n, r) => n + r.count, 0);
    const empty = held(2957) > 0;
    if (!empty && held(2958) < 1) throw Error('owned native Druid pouch absent');
    const delta: Record<number, number> = {};
    let needed = 3;
    let charges = 0;
    for (const [id, weight] of [
        [2974, 3],
        [2972, 2],
        [2970, 1],
    ]) {
        const use = Math.min(needed, held(id!));
        if (use) {
            delta[id!] = -use;
            charges += use * weight!;
            needed -= use;
        }
    }
    if (needed) throw Error('Druid pouch requires three owned native harvests');
    if (empty) delta[2957] = -1;
    delta[2958] = charges;
    return { delta, charges, input: empty ? 2957 : 2958 };
}

export async function fillDruidPouch(s: Session, maximum: number, cap: number, stop: () => boolean = () => false) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 20 || !Number.isSafeInteger(cap) || cap < 1 || cap > 1000) {
        throw Error('invalid finite Druid pouch order');
    }
    if (!questFlags(s.client)?.some(q => q.name === 'Nature Spirit' && q.state === 'complete')) {
        throw Error('Druid pouch utility requires observed completed Nature Spirit; staged quest fill remains in quest-druidspirit');
    }
    const client = s.client;
    const executor = (client as any)?.executeBotAction;
    if (!client || typeof executor !== 'function' || !Number.isSafeInteger(s.sdk.getState()?.player?.lifeId)) {
        throw Error('Druid pouch executor unobserved');
    }
    const life = watchProductionLife(s, stop);
    const began = s.tick();
    const over = () => s.client !== client || (client as any).executeBotAction !== executor || life.stopped() || s.tick() - began >= cap || existsSync('.practice/stop-all') || existsSync(`.practice/stop-${s.name}`);
    const totals = () => {
        const a: Record<number, number> = {};
        for (const r of s.sdk.getInventory()) a[r.id] = (a[r.id] ?? 0) + r.count;
        return a;
    };
    let made = 0;
    let charges = 0;
    let uncertain = false;
    let detail = '';
    const receipts: unknown[] = [];
    try {
        while (made < maximum) {
            if (over()) throw Error(life.reason() || 'Druid pouch stopped');
            const effect = druidPouchFillDelta(s.sdk.getInventory());
            const before = totals();
            const cursor = marker(s);
            const row = s.sdk.getInventory().find(i => i.id === effect.input);
            const gear = JSON.stringify(s.sdk.getEquipment());
            const xp = JSON.stringify(s.sdk.getState()?.skills.map(i => i.experience));
            if (!row) throw Error('Druid pouch selection lost');
            const paid = () => {
                const now = totals();
                return [...new Set([...Object.keys(before), ...Object.keys(now), ...Object.keys(effect.delta)])].every(
                    k => (now[Number(k)] ?? 0) - (before[Number(k)] ?? 0) === (effect.delta[Number(k)] ?? 0),
                );
            };
            uncertain = true;
            try {
                if (over()) throw Error('Druid pouch executor changed before fill');
                await s.direct({ type: 'useInventoryItem', slot: row.slot, optionIndex: 1, reason: 'owned finite native Druid pouch fill' });
            } catch {}
            if (
                !await waitUntil(
                    s,
                    () => over() || (paid() && fresh(s, cursor, new RegExp('^You add ' + effect.charges + ' natures harvests to your druid pouch\\.$'))),
                    { timeoutTicks: Math.min(8, Math.max(1, cap - (s.tick() - began))) },
                ) ||
                over() ||
                !paid() ||
                JSON.stringify(s.sdk.getEquipment()) !== gear ||
                JSON.stringify(s.sdk.getState()?.skills.map(i => i.experience)) !== xp
            ) {
                throw Error('Druid pouch exact fresh fill unconfirmed');
            }
            uncertain = false;
            made++;
            charges += effect.charges;
            receipts.push(effect);
        }
    } catch (error) {
        detail = String(error);
    }
    return { ok: !detail && made === maximum, made, charges, receipts, uncertain, detail, ticks: s.tick() - began };
}

// ---- Miscellania Coffer (microbot-misc-coffer.ts) ----

export const MISC_COFFER = {
    npc: 1375,
    interface: componentId('misc_both_manage'),
    balance: componentId('misc_both_manage:com_87'),
    deposit: componentId('misc_both_manage:com_88'),
    maximum: 5000000,
} as const;

export function cofferText(text: unknown) {
    if (typeof text !== 'string' || !/^(0|[1-9]\d*)$/.test(text)) return;
    const n = Number(text);
    return Number.isSafeInteger(n) && n <= MISC_COFFER.maximum ? n : undefined;
}

export function cofferDepositEffect(amount: number, beforeCoins: number, afterCoins: number, before: number, after: number) {
    return (
        [amount, beforeCoins, afterCoins, before, after].every(Number.isSafeInteger) &&
        amount > 0 &&
        beforeCoins >= amount &&
        afterCoins >= 0 &&
        before >= 0 &&
        after <= MISC_COFFER.maximum &&
        beforeCoins - afterCoins === amount &&
        after - before === amount
    );
}

export const MISC_RESOURCES = { 'Maple Logs': 1518, Coal: 454, Tuna: 362, Swordfish: 374, 'Raw Tuna': 360, 'Raw Swordfish': 372 } as const;
export const MISC_HERBS = [254, 256, 258, 260, 262, 264, 266, 2482, 268] as const;
export const MISC_NOTES: readonly number[] = [...Object.values(MISC_RESOURCES), ...MISC_HERBS];

export function miscResourceText(text: string) {
    const normalized = text.replace(/<br\s*\/?>/gi, ' ').replace(/[|\n]/g, ' ').trim();
    if (normalized === 'No Resources') return {} as Record<string, number>;
    const result: Record<string, number> = {};
    let invalid = false;
    const rest = normalized.replace(/([1-9]\d*) (Maple Logs|Coal|Raw Tuna|Raw Swordfish|Tuna|Swordfish|Herbs)/g, (_, n: string, label: string) => {
        if (result[label] !== undefined || !Number.isSafeInteger(Number(n))) invalid = true;
        result[label] = Number(n);
        return '';
    });
    return !invalid && !rest.trim() && Object.keys(result).length ? result : undefined;
}

export function miscResourceEffect(before: ReadonlyMap<number, number>, after: ReadonlyMap<number, number>, text: string) {
    const report = miscResourceText(text);
    if (!report) return;
    const delta = (id: number) => (after.get(id) ?? 0) - (before.get(id) ?? 0);
    const credits: Record<number, number> = {};
    for (const [label, id] of Object.entries(MISC_RESOURCES)) {
        if (delta(id) !== (report[label] ?? 0)) return;
        if (delta(id)) credits[id] = delta(id);
    }
    let herbs = 0;
    for (const id of MISC_HERBS) {
        if (delta(id) < 0) return;
        herbs += delta(id);
        if (delta(id)) credits[id] = delta(id);
    }
    if (herbs !== (report.Herbs ?? 0)) return;
    if ([...new Set([...before.keys(), ...after.keys()])].some(id => !MISC_NOTES.includes(id) && delta(id) !== 0)) return;
    return credits;
}

export async function depositMiscCoffer(
    s: Session,
    amount: number,
    cap: number,
    requestStop: () => boolean = () => false,
    options: { collectResources?: boolean } = {},
) {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > MISC_COFFER.maximum || !Number.isSafeInteger(cap) || cap < 1 || cap > 500) {
        throw Error('invalid finite Miscellania coffer deposit');
    }
    const ui = s.client as { membersAccount?: number; getModalInterface: () => number; isChatBackInputOpen: () => boolean; ifType: (id: number) => { text?: string } };
    const state = () => s.sdk.getState();
    const first = state()?.player;
    if (
        !first ||
        first.level !== 1 ||
        Math.max(Math.abs(first.worldX - 2499), Math.abs(first.worldZ - 3857)) > 8 ||
        !Number.isSafeInteger(first.lifeId) ||
        ui.membersAccount !== 1 ||
        !questFlags(s.client)?.some(q => /^Throne of Miscellania$/i.test(q.name) && q.state === 'complete')
    ) {
        throw Error('observed member account, original life and completed Throne of Miscellania required');
    }
    const lifeId = first.lifeId;
    const respawns = first.respawnCount ?? 0;
    const life = watchProductionLife(s, requestStop);
    const start = s.tick();
    const over = () => life.stopped() || s.tick() - start >= cap;
    const alive = () => {
        const p = state()?.player;
        return !!p && !p.isDead && p.lifeId === lifeId && (p.respawnCount ?? 0) === respawns && (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0;
    };
    const rows = () => [...s.sdk.getInventory(), ...s.sdk.getEquipment()];
    const stock = () => {
        const a = new Map<number, number>();
        for (const i of rows()) a.set(i.id, (a.get(i.id) ?? 0) + i.count);
        return a;
    };
    const initial = stock();
    const coins0 = initial.get(995) ?? 0;
    const gear = JSON.stringify(s.sdk.getEquipment().map(i => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot));
    if (coins0 < amount) throw Error('declared coffer amount exceeds owned carried coins');
    let collectionStock = initial;
    const unchanged = () => {
        const now = stock();
        return [...new Set([...collectionStock.keys(), ...now.keys()])].every(id => (collectionStock.get(id) ?? 0) === (now.get(id) ?? 0));
    };
    const balance = () => (ui.getModalInterface() === MISC_COFFER.interface ? cofferText(ui.ifType(MISC_COFFER.balance)?.text) : undefined);
    let pendingChoice: string | undefined;
    const choiceKey = () => JSON.stringify(s.sdk.getDialog()?.options.map(o => [o.index, o.text, o.componentId]));
    let collectionSubmitted = false;
    let collectionConfirmed = false;
    let collectionText = '';
    let collectionCredits: Record<number, number> = {};
    let collectionCursor = -1;
    let submitted = false;
    let ownedUi = false;
    let prompt = false;
    let asked = false;
    let before: number | undefined;
    let after: number | undefined;
    let detail = '';
    const cursor = marker(s);
    const observeCollection = () => {
        if (collectionSubmitted && !collectionConfirmed) {
            for (const d of state()?.recentDialogs ?? []) {
                if ((d.observationId ?? d.tick) <= collectionCursor) continue;
                const text = d.text.join(' ');
                const credits = miscResourceEffect(initial, stock(), text);
                if (credits) {
                    collectionText = text;
                    collectionCredits = credits;
                    collectionStock = stock();
                    collectionConfirmed = true;
                    break;
                }
            }
        }
    };
    const check = () => {
        if (over()) throw Error(life.reason() || 'Miscellania deposit tick budget');
    };
    const step = async () => {
        check();
        await waitTicks(s, 1);
        check();
    };
    const proceed = async () => {
        const d = s.sdk.getDialog();
        if (d?.isOpen && !d.isWaiting) {
            if (d.options.length !== 1 || !/continue/i.test(d.options[0]!.text)) throw Error('unmapped Miscellania continuation');
            check();
            await s.sdk.sendClickDialog(d.options[0]!.index);
        }
    };
    try {
        check();
        await s.sdk.sendCloseModal();
        await step();
        const targets = state()?.nearbyNpcs.filter(n => n.id === MISC_COFFER.npc && n.distance <= 5 && n.reachable !== false) ?? [];
        if (targets.length !== 1) throw Error('stage beside the unique observed Advisor Ghrim');
        ownedUi = true;
        if (!(await s.sdk.sendInteractNpc(targets[0]!.index, 1)).success) throw Error('Ghrim conversation refused');
        while (ui.getModalInterface() !== MISC_COFFER.interface) {
            check();
            const d = s.sdk.getDialog();
            if (pendingChoice) {
                if (choiceKey() === pendingChoice) {
                    await step();
                    continue;
                }
                pendingChoice = undefined;
            }
            if (d?.isOpen && !d.isWaiting && d.options.length > 1) {
                const option = !asked
                    ? d.options.find(o => o.text === 'How is the Kingdom faring?')
                    : fresh(s, cursor, /Would you like to collect the resources gathered by your subjects\?/i)
                      ? d.options.find(o => o.text === (options.collectResources ? 'Yes' : 'No'))
                      : undefined;
                if (!option) throw Error('unmapped Ghrim choice');
                if (asked && options.collectResources) {
                    const pack = s.sdk.getInventory();
                    if (
                        collectionSubmitted ||
                        28 - pack.length < MISC_NOTES.filter(id => !pack.some(i => i.id === id)).length ||
                        MISC_NOTES.some(id => (stock().get(id) ?? 0) > 2147483647 - 200000)
                    ) {
                        throw Error('Miscellania collection needs all native note slots and stack headroom');
                    }
                    collectionSubmitted = true;
                    collectionCursor = marker(s);
                }
                pendingChoice = choiceKey();
                if (!(await s.sdk.clickDialogByText(!asked ? /^How is the Kingdom faring\?$/i : options.collectResources ? /^Yes$/i : /^No$/i)).success) {
                    throw Error('guarded Ghrim choice refused; no retry');
                }
                asked = true;
            } else {
                observeCollection();
                await proceed();
            }
            await step();
        }
        await step();
        for (let settleTick = 0; collectionSubmitted && !collectionConfirmed && settleTick < 8; settleTick++) {
            observeCollection();
            if (!collectionConfirmed) await step();
        }
        if (collectionSubmitted && !collectionConfirmed) throw Error('native resource report/pack credits unconfirmed; no retry');
        before = balance();
        if (before === undefined) throw Error('fresh canonical coffer balance text unavailable');
        if (!unchanged()) throw Error('owned assets changed before deposit');
        if (amount > MISC_COFFER.maximum - before) throw Error('declared coffer amount exceeds observed capacity');
        const depositCursor = marker(s);
        check();
        if (!(await s.sdk.sendClickComponent(MISC_COFFER.deposit)).success) throw Error('coffer deposit button refused');
        while (!ui.isChatBackInputOpen()) {
            check();
            prompt ||= fresh(s, depositCursor, new RegExp('You are carrying ' + coins0 + ' coins\\.')) && fresh(s, depositCursor, /Enter an amount to deposit in the coffers\./);
            const d = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting && prompt) await proceed();
            await step();
        }
        check();
        if (!prompt || !unchanged()) throw Error('coffer amount prompt or owned funds changed');
        submitted = true;
        if (!(await s.sdk.sendCountDialog(amount)).success) throw Error('coffer amount dispatch uncertain; no retry');
        const added = new RegExp('Added ' + amount + ' coins to the coffers\\.');
        while (true) {
            check();
            after = balance();
            const confirmed = fresh(s, depositCursor, added);
            if (after !== undefined && confirmed && cofferDepositEffect(amount, coins0, stock().get(995) ?? 0, before, after)) break;
            if (!confirmed && fresh(s, depositCursor, /Added \d+ coins to the coffers\./)) throw Error('native coffer addition receipt differs');
            const d = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting && confirmed) await proceed();
            await step();
        }
        if (!cofferDepositEffect(amount, coins0, stock().get(995) ?? 0, before, after)) throw Error('exact declared coin/coffer transfer unconfirmed');
    } catch (error) {
        detail = String(error);
    } finally {
        if (ownedUi && alive()) {
            try {
                await s.sdk.sendCloseModal();
            } catch (error) {
                detail ||= String(error);
            }
        }
    }
    const final = stock();
    const preserved =
        [...new Set([...initial.keys(), ...final.keys()])].every(id => id === 995 || (initial.get(id) ?? 0) + (collectionCredits[id] ?? 0) === (final.get(id) ?? 0)) &&
        gear === JSON.stringify(s.sdk.getEquipment().map(i => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot));
    return {
        ok: !detail && !life.stopped() && preserved && submitted && before !== undefined && after !== undefined && cofferDepositEffect(amount, coins0, final.get(995) ?? 0, before, after),
        amount,
        submitted,
        collectionRequested: !!options.collectResources,
        collectionSubmitted,
        collectionConfirmed,
        collectionCredits,
        collectionText,
        coinsSpent: coins0 - (final.get(995) ?? 0),
        cofferBefore: before,
        cofferAfter: after,
        preserved,
        ticks: s.tick() - start,
        detail,
        collectionPending: collectionSubmitted && !collectionConfirmed,
        pending: (collectionSubmitted && !collectionConfirmed) || (submitted && (before === undefined || after === undefined || !cofferDepositEffect(amount, coins0, final.get(995) ?? 0, before, after))),
        scope: 'one optional native noted-resource collection and declared coffer deposit; no withdrawal or worker allocation; native bank delivery is commented out',
    };
}

// ---- QoL Combat / Pack Helpers (microbot-c-qol.ts) ----

export async function holdPrayer(s: Session, index: number, ticks: number, stop: () => boolean = () => false) {
    if (!Number.isSafeInteger(index) || index < 0 || index > 14 || !Number.isSafeInteger(ticks) || ticks < 1) throw Error('invalid prayer hold');
    const life = watchProductionLife(s, stop);
    const start = s.tick();
    const initial = s.sdk.isPrayerActive(index);
    let activated = false;
    let restored = initial;
    let detail = '';
    try {
        if (life.stopped()) throw Error(life.reason());
        if (!initial) {
            const result = await s.bot.activatePrayer(index);
            if (!result.success) throw Error(result.message);
            activated = true;
        }
        if (!s.sdk.isPrayerActive(index)) throw Error('prayer activation unobserved');
        await waitUntil(s, () => life.stopped() || !s.sdk.isPrayerActive(index) || s.tick() - start >= ticks, { timeoutTicks: ticks });
        detail = life.reason() || (!s.sdk.isPrayerActive(index) ? 'prayer hold ended early' : '');
    } catch (error) {
        detail = String(error);
    } finally {
        if (activated) {
            try {
                const r = await s.bot.deactivatePrayer(index);
                restored = r.success && !s.sdk.isPrayerActive(index);
            } catch (error) {
                detail ||= String(error);
            }
        }
    }
    return { ok: !detail && restored, activated, restored, ticks: s.tick() - start, detail };
}

export async function enableSpecial(s: Session, bar: string, minimumEnergy: number, cap: number, stop: () => boolean = () => false) {
    if (
        !/^combat_(blunt|axe|crossbow|bow|stabsword|hacksword|spiked|thrown|spear|claw|pickaxe|polearm|heavysword|unarmed):specbar$/.test(bar) ||
        !Number.isSafeInteger(minimumEnergy) ||
        minimumEnergy < 1 ||
        minimumEnergy > 1000 ||
        !Number.isSafeInteger(cap) ||
        cap < 1
    ) {
        throw Error('invalid special order');
    }
    const life = watchProductionLife(s, stop);
    const start = s.tick();
    const c = s.client as any;
    if (!Number.isSafeInteger(c?.var?.[300]) || !Number.isSafeInteger(c?.var?.[301])) throw Error('native transmitted special vars unavailable');
    if (!s.sdk.getEquipment().some(i => i.slot === 3)) throw Error('stage a special weapon');
    const before = { energy: c.var[300] as number, enabled: c.var[301] as number };
    if (before.energy < minimumEnergy) throw Error('special energy below explicit threshold');
    if (life.stopped()) return { ok: false, changed: false, energy: before.energy, ticks: 0, detail: life.reason() };
    if (before.enabled === 1) return { ok: true, changed: false, energy: before.energy, ticks: 0, detail: 'special already enabled' };
    await s.sdk.sendClickComponent(componentId(bar));
    await waitUntil(s, () => c.var[301] === 1 || c.var[300] < before.energy || life.stopped(), { timeoutTicks: cap });
    const ok = !life.stopped() && (c.var[301] === 1 || c.var[300] < before.energy);
    return { ok, changed: ok, energy: c.var[300], ticks: s.tick() - start, detail: life.reason() || (ok ? 'native special state/energy effect' : 'special effect unconfirmed') };
}

export async function refillCannon(s: Session, x: number, z: number, cap: number, stop: () => boolean = () => false) {
    if (![x, z, cap].every(Number.isSafeInteger) || x < 0 || z < 0 || cap < 1) throw Error('invalid cannon refill');
    const life = watchProductionLife(s, stop);
    const start = s.tick();
    const invCount = () => s.sdk.getInventory().filter(i => i.id === 2).reduce((n, i) => n + i.count, 0);
    const loc = s.sdk.getState()?.nearbyLocs.find(l => l.id === 6 && l.x === x && l.z === z);
    const item = s.sdk.getInventory().find(i => i.id === 2);
    if (!loc || !item) throw Error('stage cannonballs beside selected assembled cannon');
    if (life.stopped()) return { ok: false, loaded: 0, ticks: 0, detail: life.reason() };
    const before = invCount();
    const cursor = Math.max(-1, ...(s.sdk.getState()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
    const messageCount = () => {
        const m = (s.sdk.getState()?.gameMessages ?? []).find(m => m.type === 0 && (m.observationId ?? m.tick) > cursor && /You load the cannon with (\d+) cannonballs\./.test(m.text));
        return m ? Number(m.text.match(/with (\d+) cannonballs/)![1]) : 0;
    };
    await s.sdk.sendUseItemOnLoc(item.slot, x, z, 6);
    await waitUntil(s, () => (before > invCount() && messageCount() === before - invCount()) || life.stopped(), { timeoutTicks: cap });
    const loaded = before - invCount();
    const ok = !life.stopped() && loaded > 0 && loaded <= 30 && messageCount() === loaded;
    return { ok, loaded, ticks: s.tick() - start, detail: life.reason() || (ok ? 'owned native cannon loaded' : 'cannon ownership/capacity/load effect unconfirmed') };
}

export type QolDropOrder = { ids: number[]; names: string[]; mode: 'listed' | 'except'; order: 'slot' | 'reverse' | 'column'; maximumDrops: number; cap: number };

export function qolDropSelection(rows: readonly { id: number; name: string; slot: number; count: number }[], o: QolDropOrder) {
    if (
        !o ||
        !Array.isArray(o.ids) ||
        !Array.isArray(o.names) ||
        (o.mode !== 'listed' && o.mode !== 'except') ||
        (o.order !== 'slot' && o.order !== 'reverse' && o.order !== 'column') ||
        !Number.isSafeInteger(o.maximumDrops) ||
        o.maximumDrops < 1 ||
        o.maximumDrops > 28 ||
        !Number.isSafeInteger(o.cap) ||
        o.cap < 1 ||
        o.cap > 1000 ||
        o.ids.some(id => !Number.isSafeInteger(id) || id < 0) ||
        o.names.some(n => typeof n !== 'string' || !n.trim()) ||
        o.ids.length + o.names.length < 1
    ) {
        throw Error('explicit finite native drop selection required');
    }
    let seenMask = 0;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        if (!Number.isSafeInteger(row.slot) || row.slot < 0 || row.slot > 27 || !Number.isSafeInteger(row.count) || row.count < 1) {
            throw Error('drop inventory unknown');
        }
        const bit = 1 << row.slot;
        if ((seenMask & bit) !== 0) throw Error('drop inventory unknown');
        seenMask |= bit;
    }
    const idSet = o.ids.length > 3 ? new Set(o.ids) : null;
    const names = o.names.length > 0 ? o.names.map(n => n.trim().toLowerCase()) : null;
    const nameSet = names && names.length > 3 ? new Set(names) : null;
    const wantListed = o.mode === 'listed';
    const selected: { id: number; name: string; slot: number; count: number }[] = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const listed =
            (idSet ? idSet.has(row.id) : o.ids.includes(row.id))
            || (names !== null && (nameSet ? nameSet.has(row.name.toLowerCase()) : names.includes(row.name.toLowerCase())));
        if (listed === wantListed) selected.push(row);
    }
    selected.sort((a, b) =>
        o.order === 'reverse'
            ? b.slot - a.slot
            : o.order === 'column'
              ? a.slot % 4 - b.slot % 4 || Math.floor(a.slot / 4) - Math.floor(b.slot / 4)
              : a.slot - b.slot,
    );
    return selected.length > o.maximumDrops ? selected.slice(0, o.maximumDrops) : selected;
}

function qolOwnedState(s: Session, stop: () => boolean) {
    const client = s.client as any;
    const executor = client?.executeBotAction;
    const first = s.sdk.getState();
    const p = first?.player;
    const hp = s.sdk.getSkill('Hitpoints')?.level;
    const life = p?.lifeId;
    const respawns = p?.respawnCount ?? 0;
    if (!client || typeof executor !== 'function' || !p || !Number.isSafeInteger(life) || !Number.isSafeInteger(hp) || hp! < 1 || !equipmentObserved(client)) {
        throw Error('QoL owned state/gear/life unknown');
    }
    const gear = first!.equipment.map(i => ({ id: i.id, slot: i.slot, count: i.count }));
    const xp = first!.skills.map(i => i.experience);
    const x = p.worldX;
    const z = p.worldZ;
    const plane = p.level;
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const unsafe = () => {
        const st = s.sdk.getState();
        const me = st?.player;
        return (
            ended ||
            s.client !== client ||
            client.executeBotAction !== executor ||
            stop() ||
            existsSync('.practice/stop-all') ||
            existsSync(`.practice/stop-${s.name}`) ||
            (!!process.env.STOP_FILE && existsSync(process.env.STOP_FILE)) ||
            !me ||
            me.isDead ||
            me.lifeId !== life ||
            (me.respawnCount ?? 0) !== respawns ||
            s.sdk.getSkill('Hitpoints')?.level !== hp ||
            me.worldX !== x ||
            me.worldZ !== z ||
            me.level !== plane ||
            !equipmentObserved(client) ||
            s.sdk.getStateAge() > 5000 ||
            !sameEquipmentRows(st!.equipment, gear) ||
            !sameSkillXp(st!.skills, xp)
        );
    };
    return { client, unsafe };
}

const qolPack = (s: Session) => {
    const a: Record<number, number> = {};
    for (const i of s.sdk.getInventory()) a[i.id] = (a[i.id] ?? 0) + i.count;
    return a;
};
const qolPackEffect = (a: Record<number, number>, b: Record<number, number>, delta: Record<number, number>) => {
    for (const k in a) {
        if ((b[Number(k)] ?? 0) - (a[Number(k)] ?? 0) !== (delta[Number(k)] ?? 0)) return false;
    }
    for (const k in b) {
        if (k in a) continue;
        if ((b[Number(k)] ?? 0) !== (delta[Number(k)] ?? 0)) return false;
    }
    for (const k in delta) {
        if (k in a || k in b) continue;
        if ((delta[Number(k)] ?? 0) !== 0) return false;
    }
    return true;
};

export async function dropQolItems(s: Session, o: QolDropOrder, stop: () => boolean = () => false) {
    const selected = qolDropSelection(s.sdk.getInventory(), o);
    const guard = qolOwnedState(s, stop);
    const began = s.tick();
    const initial = qolPack(s);
    const dropped: Record<number, number> = {};
    let slots = 0;
    let units = 0;
    let uncertain = false;
    let failure = '';
    const clear = () => {
        const st = s.sdk.getState();
        return !!st && !st.bank.isOpen && !st.interface.isOpen && !st.dialog.isOpen;
    };
    try {
        if (guard.unsafe()) throw Error('QoL drop stopped/owner/life/assets');
        if (s.sdk.getInventory().length !== 28) return { ok: true, slots, units, dropped, uncertain: false, skipped: 'pack not full', ticks: 0, failure: '' };
        if (!clear()) throw Error('QoL drop needs ordinary inventory');
        for (const original of selected) {
            if (guard.unsafe() || s.tick() - began >= o.cap || !clear()) throw Error('QoL drop stopped/owner/cap/interface');
            const row = s.sdk.getInventory().find(i => i.slot === original.slot && i.id === original.id && i.count === original.count);
            const custom = row?.optionsWithIndex.filter(v => v.opIndex === 5) ?? [];
            if (!row || custom.length > 1 || custom.some(v => !/^drop$/i.test(v.text))) throw Error('fresh native Drop slot required');
            const before = qolPack(s);
            uncertain = true;
            try {
                if (guard.unsafe()) throw Error('QoL drop ownership changed');
                await s.direct({ type: 'dropItem', slot: row.slot, reason: 'declared finite full-pack QoL drop' });
            } catch {}
            const paid = () => qolPackEffect(before, qolPack(s), { [row.id]: -row.count });
            if (!await waitUntil(s, () => guard.unsafe() || paid(), { timeoutTicks: Math.min(8, Math.max(1, o.cap - (s.tick() - began))) }) || guard.unsafe() || !paid()) {
                throw Error('native QoL drop exact effect unconfirmed');
            }
            uncertain = false;
            slots++;
            units += row.count;
            dropped[row.id] = (dropped[row.id] ?? 0) + row.count;
        }
        const delta = Object.fromEntries(Object.entries(dropped).map(([id, n]) => [Number(id), -n]));
        if (!qolPackEffect(initial, qolPack(s), delta)) throw Error('QoL final drop assets changed');
    } catch (error) {
        failure = String(error);
    }
    return { ok: !failure && !uncertain, slots, units, dropped, uncertain, failure, ticks: s.tick() - began };
}

export async function enableQolRun(s: Session, threshold: number, cap: number, stop: () => boolean = () => false) {
    if (!Number.isSafeInteger(threshold) || threshold < 0 || threshold > 100 || !Number.isSafeInteger(cap) || cap < 1 || cap > 100) {
        throw Error('finite run threshold0..100/cap1..100 required');
    }
    const guard = qolOwnedState(s, stop);
    const c = guard.client;
    const initial = s.sdk.getState();
    const energy = initial?.player?.runEnergy;
    const before = c.var?.[173];
    const stock = qolPack(s);
    const began = s.tick();
    let uncertain = false;
    let failure = '';
    if (!Number.isSafeInteger(energy) || energy! < 0 || energy! > 100 || ![0, 1].includes(before)) {
        throw Error('native public run state/energy unknown');
    }
    try {
        if (guard.unsafe()) throw Error('QoL run stopped/owner/life/assets');
        if (before === 1 || energy! <= threshold) {
            return { ok: true, changed: false, enabled: before === 1, energyBefore: energy, energyAfter: energy, skipped: before === 1 ? 'already enabled' : 'energy threshold', ticks: 0, uncertain: false, failure: '' };
        }
        if (initial!.player!.combat.targetType !== 'none' || c.localPlayer?.routeLength !== 0 || initial!.bank.isOpen || initial!.interface.isOpen || initial!.dialog.isOpen) {
            throw Error('QoL run requires idle ordinary controls');
        }
        uncertain = true;
        try {
            if (guard.unsafe()) throw Error('QoL run ownership changed');
            await s.direct({ type: 'clickComponent', componentId: 153, reason: 'explicit finite native run threshold' });
        } catch {}
        if (!await waitUntil(s, () => guard.unsafe() || (s.tick() > began && c.var[173] === 1), { timeoutTicks: cap }) || guard.unsafe() || c.var[173] !== 1 || !qolPackEffect(stock, qolPack(s), {})) {
            throw Error('native run enable unconfirmed');
        }
        uncertain = false;
    } catch (error) {
        failure = String(error);
    }
    return {
        ok: !failure && !uncertain,
        changed: !failure,
        enabled: c.var?.[173] === 1,
        energyBefore: energy,
        energyAfter: s.sdk.getState()?.player?.runEnergy,
        ticks: s.tick() - began,
        uncertain,
        failure,
    };
}

// ---- CLI Entry Points ----

export async function runForagingQolCli(
    method: string,
    account: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
) {
    if (method === 'miscellania-coffer') {
        if (!account) throw Error('account and exact coin amount required');
        let stopped = false;
        process.once('SIGINT', () => { stopped = true; });
        process.once('SIGTERM', () => { stopped = true; });
        const s = await openBot(account);
        let ok = false;
        try {
            const r = await depositMiscCoffer(
                s,
                Number(restArgs[0]),
                Number(restArgs[1] ?? 120),
                () => stopped || existsSync('.practice/stop-all') || existsSync('.practice/stop-' + account) || existsSync('.practice/stop-misc-coffer'),
                { collectResources: restArgs[2] === '--collect' },
            );
            console.log('MISC_COFFER ' + JSON.stringify(r));
            ok = r.ok;
        } finally {
            process.exitCode = (await settle([s], ok, 'finite native coffer deposit')) ? 0 : 1;
        }
        return;
    }
    if (method === 'qol') {
        const mode = restArgs[0] ?? '';
        const arg = restArgs[1] ?? '';
        const value = Number(restArgs[2] ?? 30);
        const cap = Number(restArgs[3] ?? 40);
        if (!account || !['prayer', 'special', 'cannon', 'drop', 'run'].includes(mode) || !Number.isSafeInteger(value) || !Number.isSafeInteger(cap) || cap < 1) {
            throw Error('Usage: bun scripts/aio-skiller.ts <account> artisan foraging qol <prayer|special|cannon|drop|run> <arg> <val> [cap]');
        }
        let stopped = false;
        process.once('SIGINT', () => { stopped = true; });
        process.once('SIGTERM', () => { stopped = true; });
        const s = await openBot(account);
        let ok = false;
        try {
            const r =
                mode === 'drop'
                    ? await dropQolItems(s, JSON.parse(readFileSync(arg, 'utf8')), () => stopped)
                    : mode === 'run'
                      ? await enableQolRun(s, Number(arg), cap, () => stopped)
                      : mode === 'prayer'
                        ? await holdPrayer(s, Number(arg), value, () => stopped)
                        : mode === 'special'
                          ? await enableSpecial(s, arg, value, cap, () => stopped)
                          : await refillCannon(s, Number(arg), value, cap, () => stopped);
            console.log('QOL_RESULT ' + JSON.stringify(r));
            ok = r.ok;
        } finally {
            ok = await settle([s], ok, 'finite native QOL order');
        }
        process.exitCode = ok ? 0 : 1;
        return;
    }
    const mode = restArgs[0] ?? '';
    const value = Number(restArgs[1] ?? 1);
    const cap = Number(restArgs[2] ?? 80);
    if (!account || !['feed', 'wool', 'stroke', 'miscellania', 'pouch'].includes(mode) || !Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(cap) || cap < 1) {
        throw Error('Usage: bun scripts/aio-skiller.ts <account> artisan foraging care <feed|wool|stroke|miscellania|pouch> <npc-index|weed-count> [ticks]');
    }
    let stopped = false;
    process.once('SIGINT', () => { stopped = true; });
    process.once('SIGTERM', () => { stopped = true; });
    const s = await openBot(account);
    let ok = false;
    try {
        const result =
            mode === 'pouch'
                ? await fillDruidPouch(s, value, cap, () => stopped)
                : mode === 'miscellania'
                  ? await weedMiscellania(s, value, cap, () => stopped, Number(env.MISC_WEED_XP_RATE ?? 25))
                  : await kittenCare(s, value, mode as 'feed' | 'wool' | 'stroke', cap, () => stopped);
        console.log('CARE_RESULT ' + JSON.stringify(result));
        ok = result.ok;
    } finally {
        ok = await settle([s], ok, 'finite native care order');
    }
    process.exitCode = ok ? 0 : 1;
}
