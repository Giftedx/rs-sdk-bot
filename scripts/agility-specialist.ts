// Continuous fresh-clock 1 -> 99 Agility specialist runner for the Polevaulter board.
// Supports composable A/B route levers via env/args:
//   AGI_ROUTE=monkeybars|gnome|tourist   (default: monkeybars)
//   AGI_POTION=1|0                       (default: 1, continuous +3 Agility potion boost and 49+ Wildy gate boost)
//   AGI_PRAY=1|0                         (default: 1, Protect from Melee for Mercenary Captain / safety)
//   AGI_PIPE_ALIGN=1|0                   (default: 0, align to (3004,3937) before Wildy pipe to skip server walk delay)
//   AGI_CAP=<ticks>                      (default: 9000)
//   SUPPLIER_EXTERNAL=1                  (default: 0; when 0 and <supplier>/bot.env exists, runs built-in supplier)
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, finish, settle } from '../packages/core/src/bot';
import { disembark, sail } from '../packages/core/src/boat';
import type { Session } from '../packages/core/src/inprocess';
import { componentId } from '../packages/core/src/logout';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { applyKnownDoorBlocks, sessionWalker, walkPath, type PathDeps } from '../packages/core/src/walk';
import { fireSpell } from './fire-spells';
import { burstTradeHost, fastTradeExternalReceive } from './fast-skills-lib';
import { openQuest } from './generated/quest-lib';
import { leaveRuneStarter } from './rune-starter';
import { countById, exactNameRe } from './specialist-supplier';
import { resumeStep } from './agility-order';

export type AgilityRoute = 'tourist' | 'monkeybars' | 'gnome';

export interface AgilityRouteConfig {
    route: AgilityRoute;
    usePotion: boolean;
    usePrayer: boolean;
    alignPipe: boolean;
    cap: number;
    supplier: string;
}

export interface SupplyEntry {
    id: number;
    name: string;
    count: number;
}

// Exact cataloged IDs in knowledge/items.json (tradeable, unnoted).
export const ITEMS = {
    coins: 995,
    glory4: 1712,
    glory3: 1710,
    glory2: 1708,
    glory1: 1706,
    games8: 3853,
    duel8: 2552,
    fireStaff: 1387,
    airRune: 556,
    chaosRune: 562,
    lawRune: 563,
    cosmicRune: 564,
    emeraldRing: 1639,
    redBead: 1470,
    yellowBead: 1472,
    blackBead: 1474,
    whiteBead: 1476,
    headlessArrow: 53,
    bronzeArrowtips: 39,
    bronzeArrow: 882,
    dragonBones: 536,
    hammer: 2347,
    bronzeBar: 2349,
    feather: 314,
    desertShirt: 1833,
    desertRobe: 1835,
    desertBoots: 1837,
    shantayPass: 1854,
    shantayDisclaimer: 1848,
    waterskin4: 1823,
    prayerPot4: 2434,
    prayerPot: [2434, 139, 141, 143] as readonly number[],
    agilityPot4: 3032,
    agilityPot: [3032, 3034, 3036, 3038] as readonly number[],
    superEnergy4: 3016,
    superEnergy: [3016, 3018, 3020, 3022] as readonly number[],
    shark: 385,
    chocolateCake: 1897,
    chocolateCakeParts: [1901, 1899, 1897] as readonly number[],
    slaveShirt: 1844,
    slaveRobe: 1845,
    slaveBoots: 1846,
    metalKey: 1839,
    bedKey: 1852,
    plans: 1850,
    dartTip: 1853,
    dart: 1849,
    pineapple: 1851,
    barrel: 1841,
    ana: 1842,
    vial: 229,
} as const;

export const TOURIST_TRADE_1: readonly SupplyEntry[] = [
    { id: ITEMS.glory4, name: 'Amulet of glory(4)', count: 1 },
    { id: ITEMS.fireStaff, name: 'Staff of fire', count: 1 },
    { id: ITEMS.redBead, name: 'Red bead', count: 1 },
    { id: ITEMS.yellowBead, name: 'Yellow bead', count: 1 },
    { id: ITEMS.blackBead, name: 'Black bead', count: 1 },
    { id: ITEMS.whiteBead, name: 'White bead', count: 1 },
    { id: ITEMS.airRune, name: 'Air rune', count: 400 },
    { id: ITEMS.chaosRune, name: 'Chaos rune', count: 100 },
    { id: ITEMS.lawRune, name: 'Law rune', count: 10 },
    { id: ITEMS.headlessArrow, name: 'Headless arrow', count: 150 },
    { id: ITEMS.bronzeArrowtips, name: 'Bronze arrowtips', count: 150 },
    { id: ITEMS.dragonBones, name: 'Dragon bones', count: 14 },
    { id: ITEMS.superEnergy4, name: 'Super energy(4)', count: 1 },
];

export const TOURIST_TRADE_2: readonly SupplyEntry[] = [
    { id: ITEMS.hammer, name: 'Hammer', count: 1 },
    { id: ITEMS.bronzeBar, name: 'Bronze bar', count: 10 },
    { id: ITEMS.desertShirt, name: 'Desert shirt', count: 1 },
    { id: ITEMS.desertRobe, name: 'Desert robe', count: 1 },
    { id: ITEMS.desertBoots, name: 'Desert boots', count: 1 },
    { id: ITEMS.superEnergy4, name: 'Super energy(4)', count: 1 },
    { id: ITEMS.shark, name: 'Shark', count: 2 },
];

export const TOURIST_TRADE_2B: readonly SupplyEntry[] = [
    { id: ITEMS.bronzeBar, name: 'Bronze bar', count: 11 },
    { id: ITEMS.shantayPass, name: 'Shantay pass', count: 1 },
    { id: ITEMS.waterskin4, name: 'Waterskin(4)', count: 1 },
    { id: ITEMS.feather, name: 'Feather', count: 200 },
    { id: ITEMS.prayerPot4, name: 'Prayer potion(4)', count: 2 },
    { id: ITEMS.shark, name: 'Shark', count: 4 },
    { id: ITEMS.superEnergy4, name: 'Super energy(4)', count: 1 },
];

export const TOURIST_TRADE_3: readonly SupplyEntry[] = [
    { id: ITEMS.agilityPot4, name: 'Agility potion(4)', count: 6 },
    { id: ITEMS.superEnergy4, name: 'Super energy(4)', count: 3 },
    { id: ITEMS.chocolateCake, name: 'Chocolate cake', count: 4 },
    { id: ITEMS.prayerPot4, name: 'Prayer potion(4)', count: 3 },
];

export const MONKEYBARS_TRADE_1: readonly SupplyEntry[] = [
    { id: ITEMS.glory4, name: 'Amulet of glory(4)', count: 1 },
    { id: ITEMS.coins, name: 'Coins', count: 500 },
    { id: ITEMS.dragonBones, name: 'Dragon bones', count: 11 },
    { id: ITEMS.prayerPot4, name: 'Prayer potion(4)', count: 3 },
    { id: ITEMS.agilityPot4, name: 'Agility potion(4)', count: 6 },
    { id: ITEMS.superEnergy4, name: 'Super energy(4)', count: 2 },
    { id: ITEMS.chocolateCake, name: 'Chocolate cake', count: 4 },
];

export const MONKEYBARS_TRADE_1_NOPOT: readonly SupplyEntry[] = [
    { id: ITEMS.glory4, name: 'Amulet of glory(4)', count: 1 },
    { id: ITEMS.coins, name: 'Coins', count: 500 },
    { id: ITEMS.dragonBones, name: 'Dragon bones', count: 11 },
    { id: ITEMS.prayerPot4, name: 'Prayer potion(4)', count: 3 },
    { id: ITEMS.chocolateCake, name: 'Chocolate cake', count: 5 },
];

export const GNOME_TRADE_1: readonly SupplyEntry[] = [
    { id: ITEMS.glory4, name: 'Amulet of glory(4)', count: 1 },
    { id: ITEMS.coins, name: 'Coins', count: 100 },
    { id: ITEMS.dragonBones, name: 'Dragon bones', count: 11 },
    { id: ITEMS.prayerPot4, name: 'Prayer potion(4)', count: 1 },
    { id: ITEMS.agilityPot4, name: 'Agility potion(4)', count: 4 },
    { id: ITEMS.superEnergy4, name: 'Super energy(4)', count: 7 },
    { id: ITEMS.chocolateCake, name: 'Chocolate cake', count: 3 },
];

export const GNOME_TRADE_1_NOPRAY: readonly SupplyEntry[] = [
    { id: ITEMS.glory4, name: 'Amulet of glory(4)', count: 1 },
    { id: ITEMS.coins, name: 'Coins', count: 100 },
    { id: ITEMS.agilityPot4, name: 'Agility potion(4)', count: 5 },
    { id: ITEMS.superEnergy4, name: 'Super energy(4)', count: 12 },
    { id: ITEMS.chocolateCake, name: 'Chocolate cake', count: 9 },
];

export function trade1ForConfig(cfg: Pick<AgilityRouteConfig, 'route' | 'usePrayer'> & { usePotion?: boolean }): readonly SupplyEntry[] {
    if (cfg.route === 'tourist') return TOURIST_TRADE_1;
    if (cfg.route === 'monkeybars') {
        if (cfg.usePotion === false) return MONKEYBARS_TRADE_1_NOPOT;
        return cfg.usePrayer
            ? MONKEYBARS_TRADE_1
            : [
                { id: ITEMS.glory4, name: 'Amulet of glory(4)', count: 1 },
                { id: ITEMS.coins, name: 'Coins', count: 500 },
                { id: ITEMS.agilityPot4, name: 'Agility potion(4)', count: 5 },
                { id: ITEMS.superEnergy4, name: 'Super energy(4)', count: 12 },
                { id: ITEMS.chocolateCake, name: 'Chocolate cake', count: 9 },
            ];
    }
    return cfg.usePrayer ? GNOME_TRADE_1 : GNOME_TRADE_1_NOPRAY;
}

export function inventorySlotsNeeded(entries: readonly SupplyEntry[], stackableIds: ReadonlySet<number>): number {
    return entries.reduce((sum, e) => sum + (stackableIds.has(e.id) ? 1 : e.count), 0);
}

export const STACKABLE_IDS = new Set<number>([
    ITEMS.coins,
    ITEMS.airRune,
    ITEMS.chaosRune,
    ITEMS.lawRune,
    ITEMS.cosmicRune,
    ITEMS.headlessArrow,
    ITEMS.bronzeArrowtips,
    ITEMS.bronzeArrow,
    ITEMS.feather,
]);

export function resolveAgilityRouteConfig(
    bot: string,
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>> = process.env,
): AgilityRouteConfig {
    const kv = new Map<string, string>();
    const pos: string[] = [];
    for (const a of args) {
        const eq = a.indexOf('=');
        if (eq > 0) kv.set(a.slice(0, eq), a.slice(eq + 1));
        else pos.push(a);
    }
    const get = (key: string, fallback?: string) => kv.get(key) ?? env[key] ?? fallback;
    const rawRoute = (get('AGI_ROUTE', pos.find(p => /^(tourist|monkeybars|gnome)$/i.test(p)) ?? 'monkeybars') ?? 'monkeybars').toLowerCase();
    const route: AgilityRoute = rawRoute === 'tourist' || rawRoute === 'gnome' ? rawRoute : 'monkeybars';
    const supplierEnv = (env.PRACTICE_SUPPLIER ?? env.SUPPLIER ?? '').trim();
    const supplierArg = pos.find(p => !/^(tourist|monkeybars|gnome|\d+)$/i.test(p));
    const capArg = pos.find(p => /^\d+$/.test(p));
    return {
        route,
        usePotion: get('AGI_POTION', '1') !== '0',
        usePrayer: get('AGI_PRAY', '1') !== '0',
        alignPipe: get('AGI_PIPE_ALIGN', '0') !== '0',
        cap: Number(get('CAP', get('AGI_CAP', capArg ?? '9000'))),
        supplier: get('AGI_SUPPLIER', supplierArg ?? (supplierEnv || `${bot}b`))!,
    };
}

export interface WildyStep {
    name: string;
    id: number;
    x: number;
    z: number;
    xp: number;
    alt?: readonly { id: number; x: number; z: number }[];
}

export const WILDERNESS_STEPS: readonly WildyStep[] = [
    { name: 'pipe', id: 2288, x: 3004, z: 3938, xp: 125 },
    { name: 'ropeswing', id: 2283, x: 3005, z: 3952, xp: 200 },
    { name: 'stones', id: 2311, x: 3001, z: 3960, xp: 200 },
    { name: 'log', id: 2297, x: 3001, z: 3945, xp: 200 },
    { name: 'rocks', id: 2328, x: 2994, z: 3936, xp: 0, alt: [{ id: 2328, x: 2993, z: 3936 }, { id: 2328, x: 2995, z: 3936 }] },
];

export const WILDERNESS_ORDER: Readonly<Record<string, number>> = {
    pipe: 1,
    ropeswing: 2,
    stones: 3,
    log: 4,
    rocks: 5,
};

export function nextWildernessProgress(progress: number, stepName: string): number {
    const n = WILDERNESS_ORDER[stepName] ?? 0;
    const next = progress + 1 >= n ? n : progress;
    return next === 5 ? 0 : next;
}

export function startedWildernessObstacle(name: string, p: { worldX: number; worldZ: number }): boolean {
    switch (name) {
        case 'pipe': return p.worldX === 3004 && p.worldZ >= 3940 && p.worldZ <= 3950;
        case 'ropeswing': return p.worldX === 3005 && p.worldZ >= 3953 && p.worldZ <= 3958;
        case 'stones': return p.worldZ === 3960 && p.worldX >= 2996 && p.worldX <= 3001;
        case 'log': return p.worldZ === 3945 && p.worldX >= 2994 && p.worldX <= 3000;
        case 'rocks': return p.worldX >= 2993 && p.worldX <= 2995 && p.worldZ >= 3933 && p.worldZ <= 3936;
        default: return false;
    }
}

export function canPreClickNextObstacle(name: string, p: { worldX: number; worldZ: number }): boolean {
    switch (name) {
        case 'pipe': return p.worldX === 3004 && p.worldZ >= 3948 && p.worldZ <= 3950;
        case 'ropeswing': return p.worldX === 3005 && p.worldZ >= 3957 && p.worldZ <= 3958;
        case 'stones': return p.worldZ === 3960 && p.worldX <= 2997 && p.worldX >= 2996;
        case 'log': return p.worldZ === 3945 && p.worldX <= 2995 && p.worldX >= 2994;
        case 'rocks': return p.worldX >= 2993 && p.worldX <= 2995 && p.worldZ <= 3934 && p.worldZ >= 3933;
        default: return false;
    }
}

export function shouldDrinkAgilityPotion(baseLevel: number, currentLevel: number, atGate: boolean): boolean {
    if (baseLevel >= 99 || currentLevel >= 99) return false;
    if (atGate && currentLevel < 52) return true;
    if (baseLevel < 65) return currentLevel <= baseLevel + 2;
    return currentLevel <= Math.min(97, baseLevel + 1);
}

// 10 bronze bars -> 3,125 XP >= 3,105 XP (Level 20): 2 daggers (2), 1 scimitar (2), 2 warhammers (6).
export const SMITH_TO_20_SEQUENCE = [
    { name: 'dagger', component: 1119, slot: 0, op: 1, count: 2, barsEach: 1, targetXp: 625 },
    { name: 'scimitar', component: 1119, slot: 2, op: 1, count: 1, barsEach: 2, targetXp: 1250 },
    { name: 'warhammer', component: 1120, slot: 2, op: 1, count: 2, barsEach: 3, targetXp: 3105 },
] as const;

const ROOT = resolve(import.meta.dir, '..');
const PRAYER_MELEE = 14;
const FOOD_FAIL_MSG = /slip|lose your footing|lost your balance|fall|bites you|stumble/i;

const invOf = (s: Session): any[] => s.sdk.getState()?.inventory ?? [];
const wornOf = (s: Session): any[] => (s.sdk.getState()?.equipment ?? []) as any[];
const posOf = (s: Session) => s.sdk.getState()?.player;
const skillLvl = (s: Session, name: string) => s.sdk.getSkill(name)?.baseLevel ?? 1;
const skillCur = (s: Session, name: string) => s.sdk.getSkill(name)?.level ?? 1;
const skillXp = (s: Session, name: string) => s.sdk.getSkillXp(name) ?? 0;
const cntId = (s: Session, id: number) => invOf(s).filter(i => i.id === id).reduce((a, i) => a + i.count, 0);
const cntIds = (s: Session, ids: readonly number[]) => invOf(s).filter(i => ids.includes(i.id)).reduce((a, i) => a + i.count, 0);
const cheb = (a: { worldX: number; worldZ: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.worldX - b.x), Math.abs(a.worldZ - b.z));

async function clearDialogTick(s: Session): Promise<void> {
    if (s.sdk.getState()?.dialog?.isOpen) {
        await s.direct({ type: 'closeModal', reason: 'SDK' });
    }
}

async function clearAllDialogs(s: Session, maxTicks = 12): Promise<void> {
    let shut = s.sdk.getState()?.dialog?.isOpen ? 0 : 2;
    for (let t = 0; t < maxTicks && shut < 2; t++) {
        if (s.sdk.getState()?.dialog?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
        await waitTicks(s, 1);
        shut = s.sdk.getState()?.dialog?.isOpen ? 0 : shut + 1;
    }
}

async function drinkFirstMatching(s: Session, ids: readonly number[]): Promise<boolean> {
    const item = invOf(s).find(i => ids.includes(i.id));
    if (!item) return false;
    await s.direct({ type: 'useInventoryItem', slot: item.slot, optionIndex: 1, reason: 'SDK' });
    return true;
}

const lastRunClick = new WeakMap<Session, number>();

function canClickRunOn(s: Session): boolean {
    const varp173 = (s.client as { var?: number[] } | undefined)?.var?.[173];
    if (varp173 !== 0 || (posOf(s)?.runEnergy ?? 0) < 2) return false;
    return s.tick() - (lastRunClick.get(s) ?? -10) >= 3;
}

async function ensureRunOn(s: Session): Promise<void> {
    if (!canClickRunOn(s)) return;
    lastRunClick.set(s, s.tick());
    await s.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' });
}

async function maintainEnergy(s: Session, threshold = 65): Promise<void> {
    const energy = posOf(s)?.runEnergy ?? 100;
    if (energy < threshold) await drinkFirstMatching(s, ITEMS.superEnergy);
    await ensureRunOn(s);
}

// Keeps Protect from Melee points above `floor` (the prayer guard flicks it on for hunters) with the traded potions.
async function sipPrayer(s: Session, floor = 4): Promise<void> {
    if (skillLvl(s, 'Prayer') < 43) return;
    if ((s.sdk.getState()?.prayers?.prayerPoints ?? 99) <= floor) await drinkFirstMatching(s, ITEMS.prayerPot);
}

// Keeps Protect from Melee active when prayer points exist and level is >= 43.
async function setProtectFromMelee(s: Session, on: boolean): Promise<void> {
    if (skillLvl(s, 'Prayer') < 43) return;
    const active = !!s.sdk.getState()?.prayers?.activePrayers?.[PRAYER_MELEE];
    if (active === on) return;
    if (on && (s.sdk.getState()?.prayers?.prayerPoints ?? 0) <= 0) return;
    await s.direct({ type: 'togglePrayer', prayerIndex: PRAYER_MELEE, reason: 'SDK' });
}

async function dropItemsById(s: Session, keepIds: ReadonlySet<number>, limit = 5): Promise<number> {
    let sent = 0;
    const budget = s.sdk.getState()?.dialog?.isOpen ? Math.min(limit, 4) : limit;
    if (s.sdk.getState()?.dialog?.isOpen) {
        await s.direct({ type: 'closeModal', reason: 'SDK' });
    }
    for (const item of invOf(s)) {
        if (keepIds.has(item.id)) continue;
        await s.direct({ type: 'dropItem', slot: item.slot, reason: 'SDK' });
        sent++;
        if (sent >= budget) break;
    }
    return sent;
}

async function dropAllMatching(s: Session, ids: ReadonlySet<number>, maxTicks = 12): Promise<void> {
    for (let t = 0; t < maxTicks; t++) {
        const todo = invOf(s).filter(i => ids.has(i.id));
        if (!todo.length) return;
        for (const item of todo.slice(0, 5)) {
            await s.direct({ type: 'dropItem', slot: item.slot, reason: 'SDK' });
        }
        await waitTicks(s, 1);
    }
}

async function dropExcept(s: Session, keepIds: ReadonlySet<number>, maxTicks = 12): Promise<void> {
    for (let t = 0; t < maxTicks; t++) {
        const sent = await dropItemsById(s, keepIds, 5);
        if (sent === 0) return;
        await waitTicks(s, 1);
    }
}

async function wearItem(s: Session, id: number): Promise<void> {
    if (wornOf(s).some(w => w.id === id)) return;
    for (let t = 0; t < 6 && !wornOf(s).some(w => w.id === id); t++) {
        const item = invOf(s).find(i => i.id === id);
        if (!item) return;
        const op = item.optionsWithIndex?.find((o: any) => /wield|wear/i.test(o.text))?.opIndex ?? 2;
        await s.direct({ type: 'useInventoryItem', slot: item.slot, optionIndex: op, reason: 'SDK' });
        await waitTicks(s, 1);
    }
}

async function removeWornItem(s: Session, id: number): Promise<void> {
    for (let t = 0; t < 6 && wornOf(s).some(w => w.id === id); t++) {
        const w = wornOf(s).find(e => e.id === id);
        if (!w) return;
        await s.direct({ type: 'useEquipmentItem', slot: w.slot, optionIndex: 1, reason: 'SDK' });
        await waitTicks(s, 1);
    }
}

const GLORY_IDS: readonly number[] = [ITEMS.glory4, ITEMS.glory3, ITEMS.glory2, ITEMS.glory1];

async function rubGlory(s: Session, destRe: RegExp, target: { x: number; z: number }, maxTicks = 25): Promise<void> {
    const t0 = s.tick();
    const near = () => { const p = posOf(s); return !!p && p.level === 0 && cheb(p, target) <= 8; };
    while (!near() && s.tick() - t0 < maxTicks) {
        const dlg: any = s.sdk.getDialog();
        if (dlg?.isOpen) {
            if (!dlg.isWaiting) {
                const opt = (dlg.options ?? []).find((o: any) => destRe.test(o.text));
                if (opt) await s.sdk.sendClickDialog(opt.index);
                else await s.direct({ type: 'closeModal', reason: 'SDK' });
            }
            await waitTicks(s, 1);
            continue;
        }
        const glory = invOf(s).find(i => GLORY_IDS.includes(i.id));
        if (!glory) {
            if (wornOf(s).some(w => GLORY_IDS.includes(w.id))) { await removeWornItem(s, wornOf(s).find(w => GLORY_IDS.includes(w.id))!.id); continue; }
            throw Error('no charged amulet of glory in pack');
        }
        const op = glory.optionsWithIndex?.find((o: any) => /rub/i.test(o.text))?.opIndex ?? 4;
        await s.direct({ type: 'useInventoryItem', slot: glory.slot, optionIndex: op, reason: 'SDK' });
        await waitTicks(s, 1);
    }
    if (!near()) throw Error(`glory teleport to ${target.x},${target.z} failed`);
}

async function walkNear(
    s: Session,
    target: { x: number; z: number; level?: number },
    tol = 2,
    maxTicks = 200,
    opts?: { ignoreHunters?: boolean; preDrinkAgility?: boolean; stop?: () => boolean },
): Promise<void> {
    const t0 = s.tick();
    const at = () => {
        const p = posOf(s);
        return !!p && (target.level === undefined || p.level === target.level) && cheb(p, target) <= tol;
    };
    if (at()) return;
    await clearAllDialogs(s, 4);
    const p0 = posOf(s);
    if (p0 && cheb(p0, target) > 8) {
        let lastDrink = -10;
        let lastEat = -10;
        let lastPot = -10;
        const off = s.onTick(() => {
            if (s.tick() - lastDrink >= 3 && (posOf(s)?.runEnergy ?? 100) < 78) {
                const pot = invOf(s).find(i => ITEMS.superEnergy.includes(i.id));
                if (pot) {
                    lastDrink = s.tick();
                    void s.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
                }
            }
            if (canClickRunOn(s)) {
                lastRunClick.set(s, s.tick());
                void s.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' });
            }
            if (opts?.preDrinkAgility && s.tick() - lastPot >= 3 && skillCur(s, 'Agility') < 52) {
                const pNow = posOf(s);
                if (pNow && cheb(pNow, target) <= 15) {
                    const ap = invOf(s).find(i => ITEMS.agilityPot.includes(i.id));
                    if (ap) {
                        lastPot = s.tick();
                        void s.direct({ type: 'useInventoryItem', slot: ap.slot, optionIndex: 1, reason: 'SDK' });
                    }
                }
            }
            if (s.tick() - lastEat >= 3 && skillLvl(s, 'Hitpoints') <= 35 && skillCur(s, 'Hitpoints') <= Math.max(8, Math.ceil(skillLvl(s, 'Hitpoints') * 0.35))) {
                const food = invOf(s).find(i => i.id === ITEMS.shark || ITEMS.chocolateCakeParts.includes(i.id));
                if (food) {
                    lastEat = s.tick();
                    void s.direct({ type: 'useInventoryItem', slot: food.slot, optionIndex: 1, reason: 'SDK' });
                }
            }
            if (s.tick() - lastDrink >= 3 && skillLvl(s, 'Prayer') >= 43 && (s.sdk.getState()?.prayers?.prayerPoints ?? 99) <= 6) {
                const pot = invOf(s).find(i => ITEMS.prayerPot.includes(i.id));
                if (pot) {
                    lastDrink = s.tick();
                    void s.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
                }
            }
        });
        try {
            const base = await sessionWalker(s);
            let walker: PathDeps = base;
            if (opts?.ignoreHunters) {
                const pf: any = await import('../vendor/rs-sdk/sdk/pathfinding');
                const grid = await import('../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
                const { withDoorPolicy } = await import('../packages/core/src/door-policy');
                walker = {
                    ...base,
                    hunters: () => [],
                    plan: (level, from, to) => {
                        pf.initPathfinding();
                        const blocks = applyKnownDoorBlocks(s.sdk, level, from, to)
                            .map(b => b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b);
                        return withDoorPolicy(grid, blocks, () =>
                            pf.findLongPath(level, from.x, from.z, to.x, to.z, 500, (s.sdk as any).temporaryDoorBlocks?.active?.() ?? []),
                        );
                    },
                };
            }
            const res = await walkPath(walker, [{ x: target.x, z: target.z, tol }], { maxTicks, stop: opts?.stop });
            if (res.ok || at()) return;
            if (opts?.stop?.()) throw Error(`walkNear aborted at ${posOf(s)?.worldX},${posOf(s)?.worldZ}`);
        } finally {
            off();
        }
    }
    while (!at() && !opts?.stop?.() && s.tick() - t0 < maxTicks) {
        await clearDialogTick(s);
        await maintainEnergy(s, 35);
        if (skillLvl(s, 'Hitpoints') <= 35 && skillCur(s, 'Hitpoints') <= Math.max(8, Math.ceil(skillLvl(s, 'Hitpoints') * 0.35))) {
            await drinkFirstMatching(s, [ITEMS.shark, ...ITEMS.chocolateCakeParts]);
        }
        await s.direct({ type: 'walkTo', x: target.x, z: target.z, running: true, reason: 'SDK' });
        await waitTicks(s, 2);
    }
    if (!at()) throw Error(`walkNear timeout at ${posOf(s)?.worldX},${posOf(s)?.worldZ} -> ${target.x},${target.z}`);
}

async function receiveTradeFrom(
    s: Session,
    partnerName: string,
    want: readonly SupplyEntry[],
    maxTicks = 180,
    supplierReady?: () => boolean,
): Promise<void> {
    const t0 = s.tick();
    const partnerRe = exactNameRe(partnerName);
    const allowed = new Set(want.map(w => w.id));
    const received = () => want.every(w => cntId(s, w.id) >= w.count);
    while (!received() && s.tick() - t0 < maxTicks) {
        if (supplierReady && !supplierReady()) {
            await waitTicks(s, 1);
            continue;
        }
        const partner = (s.sdk.getState()?.nearbyPlayers ?? []).find((p: any) => partnerRe.test(p.name));
        if (!partner) {
            await waitTicks(s, 1);
            continue;
        }
        await clearAllDialogs(s, 4);
        const tr = await s.bot.trade(partnerRe, {
            accept: offer => offer.every((o: any) => allowed.has(o.id)) && want.every(w => countById(offer, w.id) >= w.count),
            requestTimeout: 10_000,
            timeout: 45_000,
            retryOnBusy: true,
        });
        if (tr.success || received()) return;
        await waitTicks(s, 1);
    }
    if (!received()) {
        const missing = want.filter(w => cntId(s, w.id) < w.count).map(w => `${w.id}:${cntId(s, w.id)}/${w.count}`).join(',');
        throw Error(`trade with ${partnerName} timed out (missing=${missing})`);
    }
}

async function waitNearbyLoc(s: Session, re: RegExp, near?: { x: number; z: number }, r = 10, ticks = 25): Promise<any> {
    let found: any;
    await waitUntil(s, () => {
        const locs = (s.sdk.getState()?.nearbyLocs ?? []) as any[];
        found = locs.filter(l => re.test(l.name) && (!near || Math.max(Math.abs(l.x - near.x), Math.abs(l.z - near.z)) <= r))
            .sort((a, b) => a.distance - b.distance)[0];
        return !!found;
    }, { timeoutTicks: ticks });
    return found;
}

class SupplierAgent {
    private session: Session | null = null;
    private readonly name: string;
    private readyPhase = 0;
    private completedPhase = 0;
    private edgevilleTrigger = false;
    private error: Error | null = null;
    private stopFlag = false;

    constructor(name: string) {
        this.name = name;
    }

    stop(): void { this.stopFlag = true; }
    startEdgevilleMove(): void { this.edgevilleTrigger = true; }
    markPhaseDone(phase: number): void { if (phase > this.completedPhase) this.completedPhase = phase; }
    lastError(): Error | null { return this.error; }
    isReadyFor(phase: number): boolean { return this.readyPhase >= phase && !this.error; }
    sessionHandle(): Session | null { return this.session; }

    async init(): Promise<void> {
        // The supplier idles at a bank until the runner arrives, which can exceed the 900-tick stall window: a stall stop
        // of the companion must not end the runner's process, so only a non-stall stop is recorded as its error.
        this.session = await openBot(this.name, {
            log: line => {
                if (!/^START |^RELEASE |^LOGOUT /.test(line)) console.log(`SUPPLIER ${line}`);
            },
            onStop: async (_s, reason) => {
                if (!/^no progress:/.test(reason)) this.error = this.error ?? Error(`supplier stopped: ${reason}`);
            },
        });
        await waitTicks(this.session, 2);
    }

    async giveBatch(runnerName: string, want: readonly SupplyEntry[], maxTicks = 220): Promise<void> {
        const s = this.session!;
        const t0 = s.tick();
        const runnerRe = exactNameRe(runnerName);
        const startCounts = new Map<number, number>();
        for (const w of want) if (!startCounts.has(w.id)) startCounts.set(w.id, cntId(s, w.id));
        const gaveAll = () => want.every(w => cntId(s, w.id) <= Math.max(0, (startCounts.get(w.id) ?? 0) - w.count));
        const giveList = want.map(w => ({
            item: exactNameRe(w.name),
            amount: (startCounts.get(w.id) ?? 0) === w.count ? -1 : w.count,
        }));
        while (!this.stopFlag && !gaveAll() && s.tick() - t0 < maxTicks) {
            await clearAllDialogs(s, 3);
            await s.bot.serveTrades({
                from: runnerRe,
                give: giveList,
                accept: offer => offer.length === 0,
                maxTrades: 1,
                tradeTimeout: 45_000,
                timeout: Math.max(5_000, (maxTicks - (s.tick() - t0)) * 600),
            });
            if (gaveAll()) return;
            await waitTicks(s, 1);
        }
        throw Error(`supplier batch timeout (${this.name})`);
    }

    async restockAtBank(bankSpot: { x: number; z: number }, withdraw: readonly SupplyEntry[]): Promise<void> {
        const s = this.session!;
        await walkNear(s, bankSpot, 2, 340);
        const booth = await waitNearbyLoc(s, /^bank booth$|^banker$/i, bankSpot, 8, 20);
        if (!booth) throw Error(`supplier bank booth missing near ${bankSpot.x},${bankSpot.z}`);
        for (let t = 0; t < 25 && !s.sdk.getState()?.bank?.isOpen; t++) {
            await clearDialogTick(s);
            const op = booth.optionsWithIndex?.find((o: any) => /use-quickly|bank/i.test(o.text))?.opIndex ?? 2;
            await s.direct({ type: 'interactLoc', x: booth.x, z: booth.z, locId: booth.id, optionIndex: op, reason: 'SDK' });
            await waitTicks(s, 2);
        }
        if (!s.sdk.getState()?.bank?.isOpen) throw Error('supplier failed to open bank');
        await waitTicks(s, 1);
        for (let round = 0; round < 6 && invOf(s).length > 0; round++) {
            const seen = new Set<number>();
            let ops = 0;
            for (const it of invOf(s)) {
                if (seen.has(it.id)) continue;
                seen.add(it.id);
                await s.direct({ type: 'bankDeposit', slot: it.slot, amount: -1, reason: 'SDK' });
                if (++ops >= 4) break;
            }
            await waitTicks(s, 1);
        }
        let ops = 0;
        for (const w of withdraw) {
            const b = ((s.sdk.getState() as any)?.bank?.items ?? []).find((i: any) => i.id === w.id);
            if (!b || b.count < w.count) throw Error(`supplier bank short on ${w.id} (have ${b?.count ?? 0} need ${w.count})`);
            if (b.count === w.count || (STACKABLE_IDS.has(w.id) && b.count <= w.count)) {
                await s.direct({ type: 'bankWithdraw', slot: b.slot, amount: -1, reason: 'SDK' });
                if (++ops % 4 === 0) await waitTicks(s, 1);
            } else {
                let rem = w.count;
                for (const step of [10, 5, 1]) {
                    while (rem >= step) {
                        await s.direct({ type: 'bankWithdraw', slot: b.slot, amount: step, reason: 'SDK' });
                        rem -= step;
                        if (++ops % 4 === 0) await waitTicks(s, 1);
                    }
                }
            }
        }
        await waitUntil(s, () => withdraw.every(w => cntId(s, w.id) >= w.count), { timeoutTicks: 20 });
        await s.direct({ type: 'closeModal', reason: 'SDK' });
        await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 10 });
    }

    async runTouristFlow(_runnerName: string): Promise<void> {
        try {
            const s = this.session!;
            await waitUntil(s, () => this.stopFlag || invOf(s).length > 0, { timeoutTicks: 20 });
            if (this.stopFlag) return;
            // Trade 1 in Lumbridge.
            this.readyPhase = 1;
            await waitUntil(s, () => this.stopFlag || this.completedPhase >= 1, { timeoutTicks: 240 });
            if (this.stopFlag) return;

            // Teleport Edgeville using supplier Glory -> walk to Varrock West Bank for Trade 2 (Smithing 20) + Trade 2B (Tourist Trap).
            await rubGlory(s, /edgeville/i, { x: 3087, z: 3496 }, 25);
            await this.restockAtBank({ x: 3185, z: 3436 }, TOURIST_TRADE_2);
            await walkNear(s, { x: 3186, z: 3436 }, 1, 20);
            this.readyPhase = 2;
            await waitUntil(s, () => this.stopFlag || this.completedPhase >= 2, { timeoutTicks: 1500 });
            if (this.stopFlag) return;

            await this.restockAtBank({ x: 3185, z: 3436 }, TOURIST_TRADE_2B);
            await walkNear(s, { x: 3186, z: 3436 }, 1, 20);
            this.readyPhase = 3;
            await waitUntil(s, () => this.stopFlag || this.completedPhase >= 3, { timeoutTicks: 1500 });
            if (this.stopFlag) return;

            // Wait partway into Tourist Trap so Supplier never crosses the 900-tick stall window idle at Edgeville.
            const tWait = s.tick();
            await waitUntil(s, () => this.stopFlag || this.edgevilleTrigger || s.tick() - tWait >= 450, { timeoutTicks: 500 });
            if (this.stopFlag) return;

            await this.restockAtBank({ x: 3094, z: 3491 }, TOURIST_TRADE_3);
            await walkNear(s, { x: 3093, z: 3491 }, 1, 20);
            this.readyPhase = 4;
            await waitUntil(s, () => this.stopFlag || this.completedPhase >= 4, { timeoutTicks: 2500 });
        } catch (err) {
            this.error = err instanceof Error ? err : Error(String(err));
        }
    }

    async runSingleLumbridgeFlow(_runnerName: string, _trade: readonly SupplyEntry[]): Promise<void> {
        try {
            const s = this.session!;
            await waitUntil(s, () => this.stopFlag || invOf(s).length > 0, { timeoutTicks: 20 });
            if (this.stopFlag) return;
            this.readyPhase = 1;
            const t0 = s.tick();
            while (!this.stopFlag && s.tick() - t0 < 220) await waitTicks(s, 1);
            this.completedPhase = 1;
        } catch (err) {
            this.error = err instanceof Error ? err : Error(String(err));
        }
    }

    async close(): Promise<void> {
        if (!this.session) return;
        const s = this.session;
        this.session = null;
        await settle([s], !this.error, this.error ? this.error.message : 'supplier complete', {
            log: line => {
                if (!/^START |^RELEASE |^LOGOUT |^RESULT /.test(line)) console.log(`SUPPLIER ${line}`);
            },
        });
    }
}

async function doLumbridgePrepTourist(s: Session): Promise<void> {
    // Drop unneeded tutorial starter items cleanly (5/tick = 4 ticks).
    await dropExcept(s, new Set<number>(), 8);
    // Receive Trade 1 from supplier standing in Lumbridge.
    const cfgKeep = new Set<number>(TOURIST_TRADE_1.map(t => t.id));
    await dropExcept(s, cfgKeep, 6);
}

async function runFletchingTo10(s: Session): Promise<void> {
    const t0 = s.tick();
    while (skillLvl(s, 'Fletching') < 20 && s.tick() - t0 < 10) {
        const heads = invOf(s).find(i => i.id === ITEMS.headlessArrow);
        const tips = invOf(s).find(i => i.id === ITEMS.bronzeArrowtips);
        if (!heads || !tips) break;
        await clearDialogTick(s);
        for (let k = 0; k < 5; k++) {
            await s.direct({ type: 'useItemOnItem', sourceSlot: tips.slot, targetSlot: heads.slot, reason: 'SDK' });
        }
        await waitTicks(s, 1);
    }
    await dropAllMatching(s, new Set([ITEMS.bronzeArrow, ITEMS.headlessArrow, ITEMS.bronzeArrowtips]), 4);
    if (skillLvl(s, 'Fletching') < 10) throw Error(`fletching reached ${skillLvl(s, 'Fletching')} (< 10)`);
}

async function runPrayerTo43(s: Session, targetLevel = 43): Promise<void> {
    const t0 = s.tick();
    while (skillLvl(s, 'Prayer') < targetLevel && s.tick() - t0 < 80) {
        const bones = invOf(s).filter(i => i.id === ITEMS.dragonBones);
        if (!bones.length) break;
        const acts: Promise<unknown>[] = [];
        if (s.sdk.getState()?.dialog?.isOpen) acts.push(s.direct({ type: 'closeModal', reason: 'SDK' }));
        acts.push(s.direct({ type: 'useInventoryItem', slot: bones[0].slot, optionIndex: 1, reason: 'SDK' }));
        await Promise.all(acts);
        await waitTicks(s, 1);
    }
    await clearDialogTick(s);
    if (skillLvl(s, 'Prayer') < 43) throw Error(`prayer reached ${skillLvl(s, 'Prayer')} (< 43)`);
}

async function runImpCatcherAndEnchant(s: Session, cap: number): Promise<void> {
    await rubGlory(s, /draynor/i, { x: 3105, z: 3251 }, 20);
    const q = await openQuest({ session: s, burst: true, cap, eatAt: 6, food: [ITEMS.shark], lumbridgeOk: true });
    let done = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete|completed.*imp catcher/i) > 0) done = true; });
    try {
        // Walk into Wizard Tower ground floor staircase -> climb up twice to Mizgog.
        await q.walk('to wizard tower', [{ x: 3109, z: 3167, tol: 1 }]);
        await q.openDoor('tower door', 3109, 3166);
        await q.walk('to ladder 0', [{ x: 3104, z: 3161, tol: 1 }]);
        await q.climb('ladder 0->1', () => q.findLoc((l: any) => (l.id === 1738 || /staircase/i.test(l.name)) && l.x === 3103 && l.z === 3159), /^climb-up$/i, () => q.lvl() === 1);
        await q.climb('ladder 1->2', () => q.findLoc((l: any) => (l.id === 1739 || /staircase/i.test(l.name)) && l.x === 3103 && l.z === 3159), /^climb-up$/i, () => q.lvl() === 2);
        const miz = /^wizard mizgog$/i;
        const spot = { x: 3103, z: 3163 };
        await q.talk('mizgog 1', miz, [/^give me a quest!$/i, /give me a quest please/i], () => q.sawText(/get my beads back/i), spot);
        await q.talk('mizgog 2', miz, [], () => done, spot, 40, true);
        await q.converse([], () => !q.dialogOpen(), 8);
    } finally {
        off();
        await q.dispose();
    }
    // Imp Catcher gives 21,875 XP (Level 44 Magic on curve.ts), unlocking both Varrock Teleport and Fire Bolt directly.
    await clearAllDialogs(s, 6);
    if (skillLvl(s, 'Magic') < 35) throw Error(`magic reached ${skillLvl(s, 'Magic')} (< 35)`);
    const teleComp = componentId('magic:varrock_teleport');
    for (let t = 0; t < 20; t++) {
        const p = posOf(s);
        if (p && p.level === 0 && cheb(p, { x: 3213, z: 3424 }) <= 8) break;
        await clearDialogTick(s);
        await s.direct({ type: 'clickComponent', componentId: teleComp, reason: 'SDK' });
        await waitTicks(s, 2);
    }
}

async function smithTo20AtVarrock(s: Session): Promise<void> {
    await walkNear(s, { x: 3188, z: 3426 }, 1, 30);
    const anvil = await waitNearbyLoc(s, /^anvil$/i, { x: 3188, z: 3426 }, 4, 15);
    if (!anvil) throw Error('Varrock west anvil not found');
    for (const step of SMITH_TO_20_SEQUENCE) {
        for (let iter = 0; iter < step.count && skillXp(s, 'Smithing') < step.targetXp; iter++) {
            const barsBefore = cntId(s, ITEMS.bronzeBar);
            const targetBars = barsBefore - step.barsEach;
            for (let tries = 0; tries < 25 && cntId(s, ITEMS.bronzeBar) > targetBars && skillXp(s, 'Smithing') < step.targetXp; tries++) {
                await clearDialogTick(s);
                const iface: any = (s.sdk.getState() as any)?.interface;
                if (!iface?.isOpen) {
                    const bar = invOf(s).find(i => i.id === ITEMS.bronzeBar);
                    if (!bar) throw Error(`out of bronze bars before ${step.name}`);
                    await s.direct({ type: 'useItemOnLoc', itemSlot: bar.slot, x: anvil.x, z: anvil.z, locId: anvil.id, reason: 'SDK' });
                    await waitTicks(s, 1);
                    continue;
                }
                await s.direct({ type: 'clickComponentWithOption', componentId: step.component, optionIndex: step.op, slot: step.slot, reason: 'SDK' });
                const w0 = s.tick();
                while (cntId(s, ITEMS.bronzeBar) > targetBars && skillXp(s, 'Smithing') < step.targetXp && s.tick() - w0 < 12) {
                    await clearDialogTick(s);
                    await waitTicks(s, 1);
                }
            }
        }
    }
    await clearAllDialogs(s, 6);
    if (skillLvl(s, 'Smithing') < 20) throw Error(`smithing reached ${skillLvl(s, 'Smithing')} (< 20)`);
}

async function disableAutoRetaliate(s: Session): Promise<void> {
    if (s.sdk.getState()?.autoRetaliateEnabled === false) return;
    await clearAllDialogs(s, 3);
    // Component 151 is controls:com_3 (Auto Retaliate OFF); keeps guard hits from cancelling NPC dialogue.
    await s.direct({ type: 'clickComponent', componentId: 151, reason: 'SDK' });
    await waitTicks(s, 1);
}

async function runFastTouristTrap(s: Session, cap: number, _usePrayer: boolean, onHalfway?: () => void): Promise<void> {
    await disableAutoRetaliate(s);
    // Enter Shantay Pass from Al Kharid glory spot.
    await walkNear(s, { x: 3304, z: 3118 }, 2, 70);
    const passGate = await waitNearbyLoc(s, /shantay pass/i, { x: 3302, z: 3116 }, 5, 15);
    if (!passGate) throw Error('Shantay pass gate missing');
    for (let t = 0; t < 25 && (posOf(s)?.worldZ ?? 9999) >= 3116; t++) {
        const dlg: any = s.sdk.getDialog();
        if (dlg?.isOpen) {
            if (!dlg.isWaiting) {
                const yes = (dlg.options ?? []).find((o: any) => /doesn't scare me|yes/i.test(o.text));
                await s.sdk.sendClickDialog(yes ? yes.index : 0);
            }
        } else {
            await s.direct({ type: 'interactLoc', x: passGate.x, z: passGate.z, locId: passGate.id, optionIndex: 1, reason: 'SDK' });
        }
        await waitTicks(s, 1);
    }
    await dropAllMatching(s, new Set([ITEMS.shantayDisclaimer]), 6);

    const q = await openQuest({ session: s, burst: true, cap, eatAt: 10, food: [ITEMS.shark, ITEMS.chocolateCake], lumbridgeOk: true });
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    try {
        const IRENA = { x: 3303, z: 3113 };
        const CAPTAIN = { x: 3270, z: 3029 };
        const GATE = { id: 2673, x: 3273, z: 3029 };
        const SLAVE = { x: 3302, z: 3016 };
        const MINE_IN = { id: 2675, x: 3301, z: 3036 };
        const MINE_OUT = { id: 2690, x: 3278, z: 9426 };
        const CAVE_W = { id: 2699, x: 3281, z: 9415 };
        const CAVE_E = { id: 2698, x: 3283, z: 9415 };
        const SHABIM = { x: 3171, z: 3025 };
        const BED_GUARD = { x: 3170, z: 3045 };
        const ANVIL = { id: 2672, x: 3171, z: 3048 };
        const TENT_DOOR = { id: 2700, x: 3169, z: 3046 };
        const LADDER = { id: 1747, x: 3290, z: 3036 };
        const LADDER_TOP = { id: 1746, x: 3290, z: 3036 };
        const BOOKCASE = { id: 2678, x: 3284, z: 3032 };
        const CHEST = { id: 2677, x: 3292, z: 3033 };
        const LOW_CART = { id: 2684, x: 3303, z: 9417 };
        const ANA_CART = { id: 2684, x: 3318, z: 9430 };
        const LOW_BARREL = { id: 2681, x: 3303, z: 9418 };
        const LIFT = { id: 2668, x: 3292, z: 9423 };
        const WINCH = { id: 2667, x: 3279, z: 3017 };
        const UP_BARREL = { id: 2680, x: 3278, z: 3017 };
        const CART = { id: 2682, x: 3287, z: 3023 };
        const ANA = { x: 3302, z: 9466 };

        const x = () => q.pos()?.worldX ?? 0;
        const z = () => q.pos()?.worldZ ?? 0;
        const lvl = () => q.pos()?.level ?? 0;
        const msgSince = (re: RegExp, t: number) => (q.st()?.gameMessages ?? []).some((m: any) => m.type === 0 && m.tick >= t && re.test(m.text));
        const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 8); };
        const loc = (l: { id: number; x: number; z: number }) => q.locAt(l.x, l.z) ?? l;
        const worn = (id: number) => wornOf(s).some(e => e.id === id);
        const inPrisonCell = () => lvl() === 0 && x() >= 3284 && x() <= 3287 && z() >= 3031 && z() <= 3037;
        const onPrisonCliff = () => lvl() === 0 && x() >= 3280 && x() <= 3283 && z() >= 3032 && z() <= 3039;
        const inCamp = () => !(inPrisonCell() || onPrisonCliff()) && x() >= 3274 && x() <= 3306 && z() >= 3011 && z() <= 3043;
        const locTalk = async (label: string, sendFn: () => unknown, pats: RegExp[], okFn: () => boolean, tries = 4, ticks = 35) => {
            for (let i = 0; i < tries && !okFn(); i++) {
                await q.guard(label);
                await maintainEnergy(s, 40);
                await closeDlg();
                await sendFn();
                await q.waitUntil(() => q.dialogOpen() || okFn(), 12);
                let shut = 0;
                await q.converse(pats, () => { shut = q.dialogOpen() ? 0 : shut + 1; return (okFn() && !q.dialogOpen()) || shut >= 2; }, ticks);
            }
            if (!okFn()) await q.fail(`step ${label}`);
        };
        const fightCaptainForKey = async () => {
            await closeDlg();
            await wearItem(s, ITEMS.fireStaff);
            await q.walk('to captain', [{ x: CAPTAIN.x + 2, z: CAPTAIN.z, tol: 2 }]);
            for (let w = 0; w < 60 && !q.npc(/^mercenary captain$/i); w++) await q.waitTicks(1);
            await q.talk('captain', /^mercenary captain$/i, [/wow! a real captain/i, /love to work for a tough guy/i, /can't i do something for a strong captain/i, /sorry sir, i don't think/i, /funny captain who can't fight/i, /i've some information/i],
                () => q.sawText(/guards gather around to watch the fight|run you through myself/i), CAPTAIN, 70);
            // Reset PrayerGuard's pending='other' left by clickDialogOption so Protect from Melee turns ON before Captain's attacks loop.
            await s.direct({ type: 'walkTo', x: x(), z: z(), running: true, reason: 'SDK' });
            await q.waitUntil(() => !!q.st()?.prayers?.activePrayers?.[PRAYER_MELEE], 12);
            const fightStart = q.s.tick();
            const hp0 = q.hp();
            await q.waitUntil(() => q.hp() < hp0 || (((q.npc(/^mercenary captain$/i)?.distance ?? 9) <= 1) && q.s.tick() - fightStart >= 3), 8);
            const spellComp = componentId(fireSpell(skillLvl(s, 'Magic'), id => q.has(id)));
            let lastCast = -999;
            for (let t = 0; t < 180 && !q.has(ITEMS.metalKey); t++) {
                await q.guard('captain fight');
                if ((q.st()?.prayers?.prayerPoints ?? 0) <= 5) await drinkFirstMatching(s, ITEMS.prayerPot);
                if (q.dialogOpen()) {
                    const d: any = q.s.sdk.getDialog();
                    const no = (d?.options ?? []).find((o: any) => /no thanks, i've had second/i.test(o.text));
                    if (no) {
                        await q.s.sdk.sendClickDialog(no.index);
                        await q.waitTicks(3);
                        continue;
                    }
                    await closeDlg();
                }
                const n = q.npc(/^mercenary captain$/i);
                if (n && q.s.tick() - lastCast >= 5) {
                    lastCast = q.s.tick();
                    await s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: spellComp, reason: 'SDK' });
                }
                await q.waitTicks(1);
            }
            if (!q.has(ITEMS.metalKey)) await q.fail('no metal key');
            await closeDlg();
            // Unequip weapon inside inventory before entering camp (camp guards arrest worn weapons/armour).
            for (let t = 0; t < 10 && worn(ITEMS.fireStaff); t++) await removeWornItem(s, ITEMS.fireStaff);
            if (worn(ITEMS.fireStaff)) await q.fail('failed to unequip fire staff before gate');
        };
        const ensureFullPrayer = async (minFloor = 26) => {
            if (!_usePrayer) return;
            const floor = Math.min(minFloor, skillLvl(s, 'Prayer'), 44);
            for (let t = 0; t < 4 && Math.min(q.st()?.prayers?.prayerPoints ?? floor, skillCur(s, 'Prayer')) < floor; t++) {
                if (!await drinkFirstMatching(s, ITEMS.prayerPot)) break;
                await q.waitTicks(2);
            }
        };
        const walkCamp = async (label: string, pts: { x: number; z: number; tol?: number }[], maxTicks = 90) => {
            await q.guard(label);
            await ensureFullPrayer(26);
            for (const pt of pts) {
                await walkNear(s, pt, pt.tol ?? 1, maxTicks, { ignoreHunters: true });
            }
            await q.guard(label);
        };
        const escapePrisonCell = async () => {
            if (!inPrisonCell()) return;
            await closeDlg();
            await walkNear(s, { x: 3284, z: 3032 }, 1, 20);
            let idle = 0;
            for (let t = 0; t < 80 && inPrisonCell(); t++) {
                await q.guard('cell window');
                if ((q.st()?.prayers?.prayerPoints ?? 99) <= 10) {
                    if (await drinkFirstMatching(s, ITEMS.prayerPot)) await q.waitTicks(2);
                }
                const d: any = q.s.sdk.getDialog();
                if (d?.isOpen) {
                    idle = 0;
                    if (!d.isWaiting) {
                        const opts = d.options ?? [];
                        const bend = opts.find((o: any) => /yes, i'll bend the bar/i.test(o.text));
                        const idx = bend ? bend.index : (opts.length === 1 ? opts[0].index : 0);
                        await s.direct({ type: 'clickDialogOption', optionIndex: idx, reason: 'SDK' });
                    }
                } else if (idle === 0 || idle >= 10) {
                    const win = q.findLoc((l: any) => l.id === 2683 && l.x === 3284 && l.z === 3032);
                    if (win) {
                        const op = q.opIndex(win, /search/i);
                        await q.opLoc(win, op === 1 ? 2 : op);
                    }
                    idle = 1;
                } else {
                    idle++;
                }
                await q.waitTicks(1);
            }
            if (inPrisonCell()) await q.fail('step cell window');
            if (x() >= 3281) await walkNear(s, { x: 3282, z: 3037 }, 0, 20);
            for (let retry = 0; retry < 40 && x() > 3272 && !inPrisonCell(); retry++) {
                await q.guard('cell rock');
                if ((q.st()?.prayers?.prayerPoints ?? 99) <= 10) {
                    if (await drinkFirstMatching(s, ITEMS.prayerPot)) await q.waitTicks(2);
                }
                if (q.hp() <= 10 && q.has(ITEMS.shark)) {
                    await q.waitUntil(() => q.hp() > 10 || !q.has(ITEMS.shark), 6);
                }
                const curX = x(), slip0 = q.msgCount(/slip a little/i);
                const rid = curX >= 3280 ? 2694 : curX >= 3278 ? 2695 : curX >= 3276 ? 2696 : 2697;
                let rockIdle = 0;
                for (let t = 0; t < 24 && x() === curX && q.msgCount(/slip a little/i) === slip0 && !inPrisonCell(); t++) {
                    await q.guard('cell rock');
                    const d: any = q.s.sdk.getDialog();
                    if (d?.isOpen) {
                        rockIdle = 0;
                        if (!d.isWaiting) {
                            const opts = d.options ?? [];
                            const tryClimb = opts.find((o: any) => /yes, i'll give it a try/i.test(o.text));
                            const idx = tryClimb ? tryClimb.index : (opts.length === 1 ? opts[0].index : 0);
                            await s.direct({ type: 'clickDialogOption', optionIndex: idx, reason: 'SDK' });
                        }
                    } else if (rockIdle === 0 || rockIdle >= 12) {
                        const rock = q.findLoc((l: any) => l.id === rid && l.reachable !== false) ?? q.findLoc((l: any) => l.id === rid);
                        if (rock) {
                            const op = q.opIndex(rock, /climb/i);
                            await s.direct({ type: 'interactLoc', x: rock.x, z: rock.z, locId: rock.id, optionIndex: op === 1 ? 2 : op, reason: 'SDK' });
                        }
                        rockIdle = 1;
                    } else {
                        rockIdle++;
                    }
                    await q.waitTicks(1);
                }
                await q.waitTicks(1);
            }
            if (x() > 3272 || inPrisonCell()) await q.fail(`failed prison cliff escape at ${x()},${z()}`);
            await ensureFullPrayer();
        };
        const gateIn = async () => {
            if (inPrisonCell() || onPrisonCliff()) await escapePrisonCell();
            if (!q.has(ITEMS.metalKey)) await fightCaptainForKey();
            if (inCamp()) return;
            for (let t = 0; t < 10 && worn(ITEMS.fireStaff); t++) await removeWornItem(s, ITEMS.fireStaff);
            await q.walk('to gate', [{ x: 3272, z: 3029, tol: 0 }]);
            await q.step('gate in', () => q.opLoc(loc(GATE), 1), () => x() >= 3274, 12, 4);
            await q.waitTicks(2);
            await ensureFullPrayer();
        };
        const gateOut = async () => {
            for (const id of [ITEMS.slaveShirt, ITEMS.slaveRobe, ITEMS.slaveBoots]) {
                for (let t = 0; t < 12 && worn(id); t++) await removeWornItem(s, id);
            }
            if (!inCamp()) return;
            if (z() >= 3032 && x() >= 3290) {
                await walkCamp('to gate inside', [{ x: 3304, z: 3024, tol: 2 }, { x: 3278, z: 3018, tol: 2 }, { x: 3274, z: 3029, tol: 0 }]);
            } else {
                await walkCamp('to gate inside', [{ x: 3274, z: 3029, tol: 0 }]);
            }
            await q.step('gate out', () => q.opLoc(loc(GATE), 1), () => x() <= 3273, 12, 4);
            await q.waitTicks(2);
        };
        const slaveClothes = async () => {
            for (const id of [ITEMS.slaveShirt, ITEMS.slaveRobe, ITEMS.slaveBoots]) {
                for (let t = 0; t < 12 && !worn(id); t++) {
                    await closeDlg();
                    await wearItem(s, id);
                }
            }
        };
        const mineIn = async () => {
            await slaveClothes();
            await ensureFullPrayer();
            for (let attempt = 0; attempt < 3 && z() < 9427; attempt++) {
                if (z() < 4000) {
                    // Route along south/east camp perimeter with ignoreHunters (PrayerGuard blocks melee Rowdy Guards).
                    await walkCamp('to mine doors', [
                        ...(x() < 3290 ? [{ x: 3278, z: 3018, tol: 2 }] : []),
                        ...(z() < 3024 || x() < 3290 ? [{ x: 3304, z: 3024, tol: 2 }] : []),
                        { x: MINE_IN.x, z: MINE_IN.z - 1, tol: 0 },
                    ]);
                    await q.step('mine doors', () => q.opLoc(loc(MINE_IN), 1), () => z() > 9000, 12, 4);
                }
                // open_and_close_double_door2 opens 2690/2691 for 3 ticks after p_delay(0) and teleports to (3278,9427).
                // Clear any first-entry mesbox, step clear north of 2690, and block 2690/2691 from walkPath.
                await q.waitTicks(2);
                await closeDlg();
                if (z() > 9000 && z() < 9427) {
                    await s.direct({ type: 'walkTo', x: 3278, z: 9430, running: true, reason: 'SDK' });
                    await q.waitUntil(() => z() >= 9427 || z() < 4000, 6);
                }
                if (z() > 9000 && z() < 9427) {
                    await q.step('mine exit retry', () => q.opLoc(loc(MINE_OUT), 1), () => z() < 4000, 12, 4);
                    await q.waitTicks(2);
                }
            }
            if (z() < 9427) await q.fail(`failed clearing mine entrance at ${x()},${z()}`);
            q.s.sdk.blockDoorTemporarily?.(0, 3278, 9426, 3_600_000);
            q.s.sdk.blockDoorTemporarily?.(0, 3279, 9426, 3_600_000);
            if (z() < 9431) await walkNear(s, { x: 3278, z: 9432 }, 2, 12);
        };
        const mineOut = async () => {
            await q.step('mine exit', () => q.opLoc(loc(MINE_OUT), 1), () => z() < 4000, 25, 4);
            await q.waitTicks(2);
        };
        const shabim = (label: string, pats: RegExp[], okFn: () => boolean) => q.talk(label, /^al shabim$/i, pats, okFn, SHABIM, 60);

        await q.talk('irena', /^irena$/i, [/what's the matter/i, /is there a reward/i, /okay irena, calm down/i], () => q.sawText(/red silk scarf/i), IRENA, 60);
        q.milestone(1);

        // Mercenary Captain: PrayerGuard auto-activates Protect from Melee without switching manual=true.
        await maintainEnergy(s, 50);
        await fightCaptainForKey();
        await ensureFullPrayer();
        q.milestone(4);

        await gateIn();
        q.milestone(5);
        const gotClothes = () => worn(ITEMS.slaveShirt) && worn(ITEMS.slaveRobe) && worn(ITEMS.slaveBoots);
        const slavePats = [/i've just arrived/i, /oh yes, that sounds interesting/i, /what's that then/i, /i can try to undo them/i, /funny you should say that/i, /let's give it a go/i, /give it another go/i, /yes, i'll trade/i];
        const findBlockingRowdyGuard = (maxDist: number) => (q.st()?.nearbyNpcs ?? [])
            .filter((n: any) => /^rowdy guard$/i.test(n.name) && n.hp !== 0 && (n.distance ?? 9) <= maxDist)
            .sort((a: any, b: any) => (a.distance ?? 9) - (b.distance ?? 9))[0];
        const clearRowdyGuard = async (guardIndex: number) => {
            await closeDlg();
            await ensureFullPrayer();
            await wearItem(s, ITEMS.fireStaff);
            // Reset PrayerGuard's pending='other' so Protect from Melee engages immediately against Rowdy Guard swings.
            await s.direct({ type: 'walkTo', x: x(), z: z(), running: true, reason: 'SDK' });
            await q.waitUntil(() => !!q.st()?.prayers?.activePrayers?.[PRAYER_MELEE], 8);
            const spellComp = componentId(fireSpell(skillLvl(s, 'Magic'), id => q.has(id)));
            let lastCast = -999;
            for (let t = 0; t < 150; t++) {
                await q.guard('clear guard');
                if (inPrisonCell() || !inCamp()) break;
                if ((q.st()?.prayers?.prayerPoints ?? 0) <= 5) await drinkFirstMatching(s, ITEMS.prayerPot);
                if (q.dialogOpen()) await closeDlg();
                const g = (q.st()?.nearbyNpcs ?? []).find((n: any) => n.index === guardIndex);
                if (!g || g.hp === 0) break;
                if (q.s.tick() - lastCast >= 5) {
                    lastCast = q.s.tick();
                    await s.direct({ type: 'spellOnNpc', npcIndex: g.index, spellComponent: spellComp, reason: 'SDK' });
                }
                await q.waitTicks(1);
            }
            await q.waitTicks(2);
            for (let t = 0; t < 10 && worn(ITEMS.fireStaff); t++) await removeWornItem(s, ITEMS.fireStaff);
            if (worn(ITEMS.fireStaff)) await q.fail('failed to unequip fire staff after rowdy guard');
            await ensureFullPrayer();
        };

        // Picklock Male Slave at Thieving 1 (~8.6%/try); if 3rd fail within 10 tiles of a guard jails player, recover cell+key and retry.
        for (let attempt = 0; attempt < 24 && !gotClothes(); attempt++) {
            await q.guard('slave loop');
            if (inPrisonCell() || onPrisonCliff()) await escapePrisonCell();
            if (!q.has(ITEMS.metalKey)) await fightCaptainForKey();
            await ensureFullPrayer();
            if (!inCamp()) await gateIn();
            for (const id of [ITEMS.desertShirt, ITEMS.desertRobe, ITEMS.desertBoots]) await wearItem(s, id);
            // Keep prayer === 43 (so dangerSet admits Rowdy Guards) and route south via (3278,3018) -> (3302,3015) inside camp walls.
            if (z() > 3020 || x() < 3290) {
                await walkCamp('to slave', [
                    { x: 3278, z: 3018, tol: 2 },
                    { x: SLAVE.x, z: SLAVE.z - 1, tol: 1 },
                ]);
            } else {
                await walkCamp('to slave', [{ x: SLAVE.x, z: SLAVE.z - 1, tol: 1 }]);
            }
            if (inPrisonCell()) { await escapePrisonCell(); continue; }
            const preGuard = findBlockingRowdyGuard(6);
            if (preGuard && ((preGuard.distance ?? 9) <= 4 || preGuard.inCombat)) {
                await clearRowdyGuard(preGuard.index);
                if (inPrisonCell()) { await escapePrisonCell(); continue; }
                await walkCamp('to slave post-clear', [{ x: SLAVE.x, z: SLAVE.z - 1, tol: 1 }]);
                if (inPrisonCell()) { await escapePrisonCell(); continue; }
            }
            for (let mw = 0; mw < 12; mw++) {
                const nearMerc = (q.st()?.nearbyNpcs ?? []).some((n: any) =>
                    /^mercenary$/i.test(n.name) && Math.max(Math.abs((n.x ?? 0) - x()), Math.abs((n.z ?? 0) - z())) <= 10,
                );
                if (!nearMerc || findBlockingRowdyGuard(4) || inPrisonCell() || !inCamp()) break;
                await q.waitTicks(1);
            }
            const slaveNpc = (q.st()?.nearbyNpcs ?? [])
                .filter((n: any) => /^male slave$/i.test(n.name) && (n.z ?? 0) <= 3020)
                .sort((a: any, b: any) => Math.hypot((a.x ?? 0) - SLAVE.x, (a.z ?? 0) - SLAVE.z) - Math.hypot((b.x ?? 0) - SLAVE.x, (b.z ?? 0) - SLAVE.z))[0]
                ?? q.npc(/^male slave$/i);
            if (!slaveNpc) { console.log(`SLAVE_TRACE attempt=${attempt} no_npc pos=${x()},${z()}`); await q.waitTicks(2); continue; }
            await closeDlg();
            const attemptStart = q.s.tick();
            const talkOp = slaveNpc.optionsWithIndex?.find((o: any) => /talk/i.test(o.text))?.opIndex ?? 1;
            await s.direct({ type: 'interactNpc', npcIndex: slaveNpc.index, optionIndex: talkOp, reason: 'SDK' });
            await q.waitUntil(() => q.dialogOpen() || gotClothes() || inPrisonCell() || !inCamp() || msgSince(/nearby guard spots you|guards search you|roughed up/i, attemptStart), 12);
            let shut = 0;
            await q.converse(slavePats, () => {
                if (gotClothes() || inPrisonCell() || !inCamp() || msgSince(/nearby guard spots you|guards search you|roughed up/i, attemptStart)) return true;
                shut = q.dialogOpen() ? 0 : shut + 1;
                return shut >= 3;
            }, 120);
            const jailedMsg = msgSince(/nearby guard spots you|guards search you|roughed up/i, attemptStart);
            if (jailedMsg) {
                await q.waitUntil(() => inPrisonCell() || !inCamp(), 22);
            }
            await q.waitUntil(() => gotClothes() || inPrisonCell() || !inCamp() || !q.dialogOpen(), 4);
            await closeDlg();
            if (!gotClothes()) {
                console.log(`SLAVE_TRACE attempt=${attempt} ticks=${q.s.tick() - attemptStart} got=${gotClothes()} inCell=${inPrisonCell()} inCamp=${inCamp()} key=${q.has(ITEMS.metalKey)} jailedMsg=${jailedMsg} pos=${x()},${z()}`);
            }
            if (!gotClothes() && !inPrisonCell() && !jailedMsg && inCamp()) {
                const postGuard = findBlockingRowdyGuard(8);
                if (postGuard) await clearRowdyGuard(postGuard.index);
            }
        }
        if (!gotClothes()) {
            await q.fail('failed male slave clothes trade');
        }
        // Now Male Slave succeeded: drop combat magic items to leave inventory clear for barrel/plans.
        await dropAllMatching(s, new Set([ITEMS.fireStaff, ITEMS.airRune, ITEMS.chaosRune, ITEMS.vial, ITEMS.shantayDisclaimer]), 5);
        q.milestone(8);

        await mineIn();
        await ensureFullPrayer();
        await q.guard('to cave guard');
        await walkNear(s, { x: 3275, z: 9459 }, 3, 60, { ignoreHunters: true });
        await walkNear(s, { x: 3280, z: 9415 }, 1, 80, { ignoreHunters: true });
        await q.guard('to cave guard');
        await q.talk('cave guard', /^mercenary$/i, [/mine in a different area/i, /you're quite right sir/i, /we understand each other perfectly/i], () => q.sawText(/winks at you knowingly/i), { x: 3280, z: 9415 }, 50);
        await mineOut();
        await gateOut();

        await maintainEnergy(s, 50);
        await shabim('shabim key', [/looking for a pineapple/i, /yes, i'm interested/i], () => q.has(ITEMS.bedKey));
        q.milestone(11);
        onHalfway?.();

        await gateIn();
        const curtain = async () => {
            if (!q.findLoc((l: any) => l.id === 1528 && l.x === 3291 && l.z === 3031)) return;
            await q.step('curtain', () => { const c = q.findLoc((l: any) => l.id === 1528 && l.x === 3291 && l.z === 3031); return c ? q.opLoc(c, 1) : waitTicks(s, 1); },
                () => !q.findLoc((l: any) => l.id === 1528 && l.x === 3291 && l.z === 3031), 10, 3);
        };
        await walkCamp('to curtain', [{ x: 3291, z: 3030, tol: 0 }]);
        await curtain();
        await q.dash('through curtain', 3291, 3032, 0, 8);
        await q.dash('to ladder', LADDER.x, LADDER.z - 1, 1, 12);
        await q.climb('ladder up', () => q.locAt(LADDER.x, LADDER.z) ?? LADDER, /climb-up|^climb/i, () => lvl() === 1);
        await q.walk('to bookcase', [{ x: 3285, z: 3032, tol: 0 }]);
        await locTalk('bookcase', () => { const b = loc(BOOKCASE); return q.opLoc(b, q.opIndex(b, /search/i) === 1 ? 2 : q.opIndex(b, /search/i)); }, [], () => q.sawText(/subject of sailing/i));
        for (let i = 0; i < 4 && !q.has(ITEMS.plans); i++) {
            let siadDone = false;
            await q.talk('siad', /^captain siad$/i, [/wanted to have a chat/i, /you seem to have a lot of books/i, /interested in sailing/i, /cut of your jib/i], () => {
                if (i === 0) return q.sawText(/looks quite distracted/i);
                if (q.dialogOpen() && /looks quite distracted/i.test([q.s.sdk.getDialog()?.text ?? '', ...(q.s.sdk.getDialog()?.allComponents ?? []).map((c: any) => c.text ?? '')].join(' '))) {
                    siadDone = true;
                }
                return siadDone;
            }, { x: 3291, z: 3032 }, 60);
            const spot0 = q.msgCount(/spots you before you manage/i);
            await locTalk('chest', () => { const c = loc(CHEST); return q.opLoc(c, q.opIndex(c, /open/i)); }, [], () => q.has(ITEMS.plans) || q.msgCount(/spots you before you manage/i) > spot0, 2);
        }
        if (!q.has(ITEMS.plans)) await q.fail('no plans');
        await q.walk('to ladder top', [{ x: LADDER_TOP.x, z: LADDER_TOP.z - 1, tol: 0 }]);
        await q.climb('ladder down', () => q.locAt(LADDER_TOP.x, LADDER_TOP.z) ?? LADDER_TOP, /climb-down|^climb/i, () => lvl() === 0);
        await q.dash('to curtain inside', 3291, 3031, 0, 14);
        await curtain();
        await q.dash('out of curtain', 3291, 3029, 1, 8);
        await gateOut();

        await maintainEnergy(s, 50);
        await shabim('shabim plans', [/yes, i'm very interested/i, /kind of curious/i], () => q.sawText(/anvil in the other tent/i));
        await q.talk('bedabin guard', /^bedabin nomad guard$/i, [], () => z() >= 3046, BED_GUARD, 30);

        for (let i = 0; i < 16 && !q.has(ITEMS.dartTip) && q.has(ITEMS.bronzeBar); i++) {
            const waste0 = q.msgCount(/waste the bronze bar/i);
            const rolled = () => q.has(ITEMS.dartTip) || q.msgCount(/waste the bronze bar/i) > waste0;
            await q.guard('anvil');
            await closeDlg();
            await q.useOnLoc(ITEMS.bronzeBar, loc(ANVIL));
            await q.waitUntil(() => q.dialogOpen() || rolled(), 12);
            await q.converse([/yes, i'd like to try/i], () => !q.dialogOpen(), 16);
            await q.waitUntil(rolled, 16);
            await q.converse([], () => !q.dialogOpen(), 6);
        }
        if (!q.has(ITEMS.dartTip)) await q.fail('no dart tip');
        await dropAllMatching(s, new Set([ITEMS.bronzeBar, ITEMS.hammer]), 4);

        for (let i = 0; i < 20 && !q.has(ITEMS.dart); i++) {
            await q.guard('feathers');
            await closeDlg();
            const f0 = q.cnt(ITEMS.feather);
            await (i % 2 === 0 ? q.useOnItem(ITEMS.feather, ITEMS.dartTip) : q.useOnItem(ITEMS.dartTip, ITEMS.feather));
            await q.waitUntil(() => q.dialogOpen() || q.has(ITEMS.dart), 6);
            await q.converse([], () => q.has(ITEMS.dart) || q.cnt(ITEMS.feather) < f0 || !q.dialogOpen(), 20);
        }
        if (!q.has(ITEMS.dart)) await q.fail('no dart');
        await closeDlg();
        await q.step('tent out', () => q.opLoc(loc(TENT_DOOR), 1), () => z() <= 3045, 10, 3);
        await shabim('shabim dart', [], () => q.has(ITEMS.pineapple));
        q.milestone(16);

        await maintainEnergy(s, 50);
        await gateIn();
        await mineIn();
        await ensureFullPrayer();
        await q.guard('to cave guard 2');
        await walkNear(s, { x: 3275, z: 9459 }, 3, 60, { ignoreHunters: true });
        await walkNear(s, { x: 3280, z: 9415 }, 1, 80, { ignoreHunters: true });
        await q.guard('to cave guard 2');
        await q.talk('pineapple', /^mercenary$/i, [], () => !q.has(ITEMS.pineapple) && q.sawText(/a deal's a deal/i), { x: 3280, z: 9415 }, 50);
        await walkCamp('to cave', [{ x: CAVE_W.x - 1, z: CAVE_W.z, tol: 0 }]);
        await q.step('cave east', () => q.opLoc(loc(CAVE_W), 1), () => x() >= 3285, 12, 4);
        await q.waitTicks(2);

        await walkCamp('to barrels', [{ x: 3302, z: 9418, tol: 1 }]);
        await locTalk('empty barrel', () => { const b = q.findLoc((l: any) => l.id === 2681 && Math.abs(l.x - 3303) <= 3 && Math.abs(l.z - 9417) <= 3) ?? LOW_BARREL; return q.opLoc(b, q.opIndex(b, /search|take/i) === 1 ? 2 : q.opIndex(b, /search|take/i)); }, [/yeah, cool/i], () => q.has(ITEMS.barrel));
        await locTalk('low cart', () => { const c = loc(LOW_CART); return q.opLoc(c, q.opIndex(c, /search/i) === 1 ? 2 : q.opIndex(c, /search/i)); }, [/yes, of course/i], () => z() >= 9428 && x() >= 3310, 24);

        await maintainEnergy(s, 45);
        await walkCamp('to ana', [{ x: ANA.x, z: ANA.z - 1, tol: 3 }]);
        await q.step('ana barrel', () => { const n = q.npc(/^ana$/i); return n ? q.useOnNpc(ITEMS.barrel, n) : waitTicks(s, 1); }, () => q.has(ITEMS.ana), 20, 4);
        await closeDlg();

        await walkCamp('to ana cart', [{ x: 3319, z: 9431, tol: 1 }]);
        await q.step('ana in cart', () => q.useOnLoc(ITEMS.ana, loc(ANA_CART)), () => !q.has(ITEMS.ana), 12, 3);
        await q.waitTicks(4);
        await locTalk('cart back', () => { const c = loc(ANA_CART); return q.opLoc(c, q.opIndex(c, /search/i) === 1 ? 2 : q.opIndex(c, /search/i)); }, [/yes, of course/i], () => z() <= 9420, 24);
        await locTalk('ana barrel 2', () => { const b = q.findLoc((l: any) => l.id === 2681 && Math.abs(l.x - 3303) <= 3 && Math.abs(l.z - 9417) <= 3) ?? LOW_BARREL; return q.opLoc(b, q.opIndex(b, /search|take/i) === 1 ? 2 : q.opIndex(b, /search|take/i)); }, [], () => q.has(ITEMS.ana));

        await walkCamp('to lift', [{ x: LIFT.x, z: LIFT.z - 1, tol: 1 }]);
        await locTalk('lift', () => q.useOnLoc(ITEMS.ana, loc(LIFT)), [/yes please/i, /very gregarious/i], () => !q.has(ITEMS.ana) && q.sawText(/no one operating the lift/i));

        await walkCamp('to cave back', [{ x: CAVE_E.x + 1, z: CAVE_E.z, tol: 0 }]);
        await q.step('cave west', () => q.opLoc(loc(CAVE_E), 1), () => x() <= 3279, 12, 4);
        await q.waitTicks(2);
        await mineOut();

        // Keep along the east/south camp perimeter from mine exit to bypass Rowdy Guards at (3296,3026), (3287,3030) and (3280,3026).
        await walkCamp('to winch', [
            { x: 3304, z: 3024, tol: 2 },
            { x: 3300, z: 3015, tol: 2 },
            { x: 3280, z: 3018, tol: 0 },
        ]);
        await locTalk('winch', () => { const w = loc(WINCH); return q.opLoc(w, q.opIndex(w, /operate|pull|use/i) === 1 ? 2 : q.opIndex(w, /operate|pull|use/i)); }, [], () => q.sawText(/get me out of here/i));
        await locTalk('up barrel', () => { const b = loc(UP_BARREL); return q.opLoc(b, q.opIndex(b, /search/i) === 1 ? 2 : q.opIndex(b, /search/i)); }, [], () => q.has(ITEMS.ana));

        await walkCamp('to cart', [{ x: CART.x - 1, z: CART.z, tol: 1 }]);
        await locTalk('ana on cart', () => q.useOnLoc(ITEMS.ana, loc(CART)), [], () => !q.has(ITEMS.ana));
        await q.talk('driver', /^mine cart driver$/i, [/^nice cart/i, /one wagon wheel/i, /one good turn/i, /fired\.\.\. no, shot/i, /in for a penny/i, /it's like this/i, /prison riot/i, /you can't leave me here/i],
            () => q.sawText(/jump in the cart then|get in the cart or i'll go without you/i), { x: 3287, z: 3022 }, 90);
        await locTalk('ride out', () => { const c = loc(CART); return q.opLoc(c, q.opIndex(c, /search/i) === 1 ? 2 : q.opIndex(c, /search/i)); }, [/yes, i'll get on/i], () => q.has(ITEMS.ana) && x() < 3270);

        await q.walk('to irena', [{ x: IRENA.x, z: IRENA.z - 1, tol: 2 }]);
        await q.talk('irena end', /^irena$/i, [/^agility/i], () => questDone, IRENA, 60);
        await q.converse([/^agility/i], () => questDone, 20);
        await q.waitUntil(() => questDone, 10);
    } finally {
        off();
        await q.dispose();
    }
    await clearAllDialogs(s, 8);
    if (skillLvl(s, 'Agility') < 77) throw Error(`expected Agility 77 after Tourist Trap, got ${skillLvl(s, 'Agility')}`);
}

async function crossEdgevilleGate(
    s: Session,
    from: { x: number; z: number },
    gatePos: { x: number; z: number },
    gateIds: readonly number[],
    stepTo: { x: number; z: number },
    crossed: (p: { worldX: number; worldZ: number }) => boolean,
    stop?: () => boolean,
): Promise<void> {
    await walkNear(s, { ...from, level: 0 }, 1, 100, { ignoreHunters: true, stop });
    for (let t = 0; t < 20 && !stop?.(); t++) {
        const p = posOf(s);
        if (p && crossed(p)) return;
        const gate = ((s.sdk.getState()?.nearbyLocs ?? []) as any[])
            .find(l => gateIds.includes(l.id) && Math.abs(l.x - gatePos.x) <= 1 && Math.abs(l.z - gatePos.z) <= 1
                && l.optionsWithIndex?.some((o: any) => /^open$/i.test(o.text)));
        if (gate) {
            await s.direct({ type: 'interactLoc', x: gate.x, z: gate.z, locId: gate.id, optionIndex: 1, reason: 'SDK' });
        } else {
            await s.direct({ type: 'walkTo', x: stepTo.x, z: stepTo.z, running: true, reason: 'SDK' });
        }
        await waitTicks(s, 1);
    }
    throw Error(`failed to cross Edgeville Dungeon gate at ${gatePos.x},${gatePos.z} (pos=${posOf(s)?.worldX},${posOf(s)?.worldZ})`);
}

async function crossEdgevilleToMonkeybars(s: Session, forward: boolean, stop?: () => boolean): Promise<void> {
    if (forward) {
        await crossEdgevilleGate(s, { x: 3102, z: 9909 }, { x: 3103, z: 9909 }, [1557, 1558], { x: 3105, z: 9909 }, p => p.worldX >= 3104, stop);
        await crossEdgevilleGate(s, { x: 3131, z: 9916 }, { x: 3131, z: 9917 }, [1596, 1597], { x: 3131, z: 9919 }, p => p.worldZ >= 9918, stop);
    } else {
        await crossEdgevilleGate(s, { x: 3131, z: 9918 }, { x: 3131, z: 9917 }, [1596, 1597], { x: 3131, z: 9915 }, p => p.worldZ <= 9916, stop);
        await crossEdgevilleGate(s, { x: 3104, z: 9909 }, { x: 3103, z: 9909 }, [1557, 1558], { x: 3101, z: 9909 }, p => p.worldX <= 3102, stop);
    }
}

async function train1To49Monkeybars(s: Session, usePotion: boolean, usePrayer = true, stop?: () => boolean): Promise<void> {
    // 1 -> 12+ on Brimhaven Agility Arena fixed plank (zero fail damage),
    // then 15 -> 49 on Edgeville Dungeon monkeybars (2320, 500 XP, 100% pass).
    await rubGlory(s, /karamja/i, { x: 2918, z: 3176 }, 20);
    await walkNear(s, { x: 2808, z: 3191, level: 0 }, 2, 100);
    for (let t = 0; t < 35 && (posOf(s)?.level ?? 0) === 0; t++) {
        const dlg: any = s.sdk.getDialog();
        if (dlg?.isOpen) {
            if (!dlg.isWaiting) {
                const opt = (dlg.options ?? []).find((o: any) => /use the agility arena|okay, here's 200 coins/i.test(o.text));
                await s.sdk.sendClickDialog(opt ? opt.index : 0);
            }
            await waitTicks(s, 1);
            continue;
        }
        const ladder = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.id === 3617);
        const clerk = (s.sdk.getState()?.nearbyNpcs ?? []).find((n: any) => /izzy/i.test(n.name));
        if (clerk && !((s.sdk.getState()?.gameMessages ?? []).some((m: any) => /you give cap/i.test(m.text)))) {
            const op = clerk.optionsWithIndex?.find((o: any) => /^pay$/i.test(o.text))?.opIndex ?? 3;
            await s.direct({ type: 'interactNpc', npcIndex: clerk.index, optionIndex: op, reason: 'SDK' });
        } else if (ladder) {
            await s.direct({ type: 'interactLoc', x: ladder.x, z: ladder.z, locId: ladder.id, optionIndex: 1, reason: 'SDK' });
        }
        await waitTicks(s, 1);
    }
    if ((posOf(s)?.level ?? 0) !== 3) throw Error(`failed to descend Brimhaven Agility Arena ladder (level ${posOf(s)?.level ?? -1})`);

    const brimTarget = usePotion ? 12 : 15;
    let lastXp = skillXp(s, 'Agility'), still = 0, lastKey = '', crossing = false;
    const safePlankZ = () => {
        const locs = (s.sdk.getState()?.nearbyLocs ?? []) as any[];
        return [9590, 9591, 9589].find(z => !locs.some(l => l.id === 3576 && l.z === z && (l.x === 2801 || l.x === 2798))) ?? 9590;
    };
    for (let t = 0; t < 240 && skillLvl(s, 'Agility') < brimTarget; t++) {
        await maintainEnergy(s, 45);
        const p = posOf(s);
        if (!p) { await waitTicks(s, 1); continue; }
        if (skillCur(s, 'Hitpoints') <= 6) await drinkFirstMatching(s, [...ITEMS.chocolateCakeParts, ITEMS.shark]);
        const key = `${p.worldX},${p.worldZ},${p.level}`;
        still = key === lastKey ? still + 1 : 0;
        lastKey = key;
        const gained = skillXp(s, 'Agility') - lastXp;
        if (gained > 0) {
            lastXp = skillXp(s, 'Agility');
            crossing = false;
            if (skillLvl(s, 'Agility') >= brimTarget) break;
            const safeZ = safePlankZ();
            const onEast = p.worldX >= 2800;
            const plankX = onEast ? 2802 : 2797;
            const plank = ((s.sdk.getState()?.nearbyLocs ?? []) as any[])
                .find(l => l.x === plankX && l.z === safeZ && (l.id === 3570 || l.id === 3571 || l.id === 3572));
            if (plank) {
                crossing = true;
                const acts: Promise<unknown>[] = [];
                if (s.sdk.getState()?.dialog?.isOpen) acts.push(s.direct({ type: 'closeModal', reason: 'SDK' }));
                acts.push(s.direct({ type: 'interactLoc', x: plank.x, z: plank.z, locId: plank.id, optionIndex: 1, reason: 'SDK' }));
                await Promise.all(acts);
                still = 0;
            }
        }
        if (p.level === 0 && p.worldZ > 9000) {
            crossing = false;
            if (still >= 1) {
                const rope = ((s.sdk.getState()?.nearbyLocs ?? []) as any[])
                    .filter(l => l.id === 3610 && l.reachable !== false)
                    .sort((a, b) => a.distance - b.distance)[0];
                if (rope) await s.direct({ type: 'interactLoc', x: rope.x, z: rope.z, locId: rope.id, optionIndex: 1, reason: 'SDK' });
                still = 0;
            }
            await waitTicks(s, 1);
            continue;
        }
        if (p.level === 3 && (!crossing || still >= 1)) {
            const safeZ = safePlankZ();
            const onEast = p.worldX >= 2800;
            const plankX = onEast ? 2802 : 2797;
            const plank = ((s.sdk.getState()?.nearbyLocs ?? []) as any[])
                .find(l => l.x === plankX && l.z === safeZ && (l.id === 3570 || l.id === 3571 || l.id === 3572));
            if (plank) {
                crossing = true;
                const acts: Promise<unknown>[] = [];
                if (s.sdk.getState()?.dialog?.isOpen) acts.push(s.direct({ type: 'closeModal', reason: 'SDK' }));
                acts.push(s.direct({ type: 'interactLoc', x: plank.x, z: plank.z, locId: plank.id, optionIndex: 1, reason: 'SDK' }));
                await Promise.all(acts);
            } else {
                const entryX = onEast ? 2803 : 2796;
                await s.direct({ type: 'walkTo', x: entryX, z: safeZ, running: true, reason: 'SDK' });
            }
            still = 0;
        }
        await waitTicks(s, 1);
    }
    if (skillLvl(s, 'Agility') < brimTarget) throw Error(`failed to reach Agility ${brimTarget} at Brimhaven (lvl ${skillLvl(s, 'Agility')})`);
    await clearDialogTick(s);

    await rubGlory(s, /edgeville/i, { x: 3087, z: 3496 }, 20);
    await walkNear(s, { x: 3097, z: 3468, level: 0 }, 2, 35);
    for (let t = 0; t < 20 && (posOf(s)?.worldZ ?? 0) < 9000; t++) {
        const td = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => /trapdoor/i.test(l.name) && l.x === 3097 && l.z === 3468) as any;
        if (td) {
            const climbOp = td.optionsWithIndex?.find((o: any) => /climb/i.test(o.text))?.opIndex;
            await s.direct({ type: 'interactLoc', x: td.x, z: td.z, locId: td.id, optionIndex: climbOp ?? 1, reason: 'SDK' });
        }
        await waitTicks(s, 1);
    }
    const manualPrayer = process.env.PRAYER_GUARD === '0';
    if (usePrayer && manualPrayer) await setProtectFromMelee(s, true);
    await crossEdgevilleToMonkeybars(s, true, stop);
    await walkNear(s, { x: 3120, z: 9964, level: 0 }, 2, 120, { ignoreHunters: true, stop });
    const targetLvl = usePotion ? 49 : 52;
    let mLastXp = skillXp(s, 'Agility');
    for (let t = 0; skillLvl(s, 'Agility') < targetLvl && t < 1200 && !stop?.(); t++) {
        await maintainEnergy(s, 45);
        const p = posOf(s);
        if (!p || p.isDead || p.worldZ < 9000) throw Error(`monkeybars left dungeon at ${p?.worldX},${p?.worldZ}`);
        if (skillCur(s, 'Hitpoints') <= 7) await drinkFirstMatching(s, [...ITEMS.chocolateCakeParts, ITEMS.shark]);
        if (usePrayer) {
            await sipPrayer(s, 10);
            if (manualPrayer) await setProtectFromMelee(s, true);
        }
        if (usePotion && skillCur(s, 'Agility') < 15) await drinkFirstMatching(s, ITEMS.agilityPot);
        const gained = skillXp(s, 'Agility') - mLastXp;
        if (gained > 0) mLastXp = skillXp(s, 'Agility');
        if (skillLvl(s, 'Agility') >= targetLvl) break;
        // shortcuts.rs2:196 appends p_delay(0) after stat_advance; clicking at either endpoint every tick starts immediately when delay clears.
        if (t === 0 || p.worldZ <= 9964 || p.worldZ >= 9969) {
            const target = p.worldZ < 9966 ? { x: 3120, z: 9964 } : { x: 3120, z: 9969 };
            const acts: Promise<unknown>[] = [];
            if (s.sdk.getState()?.dialog?.isOpen) acts.push(s.direct({ type: 'closeModal', reason: 'SDK' }));
            acts.push(s.direct({ type: 'interactLoc', x: target.x, z: target.z, locId: 2320, optionIndex: 1, reason: 'SDK' }));
            await Promise.all(acts);
        } else if (s.sdk.getState()?.dialog?.isOpen) {
            await clearDialogTick(s);
        }
        await waitTicks(s, 1);
    }
    if (skillLvl(s, 'Agility') < targetLvl) throw Error(`monkeybars did not reach Agility ${targetLvl} (lvl ${skillLvl(s, 'Agility')})`);
    if (usePrayer && manualPrayer) await setProtectFromMelee(s, false);
    await rubGlory(s, /edgeville/i, { x: 3087, z: 3496 }, 25);
}

async function train1To49Gnome(s: Session, stop?: () => boolean): Promise<void> {
    await rubGlory(s, /karamja/i, { x: 2918, z: 3176 }, 20);
    await walkNear(s, { x: 2772, z: 3225, level: 0 }, 2, 180);
    const guardHp = async () => {
        if (skillCur(s, 'Hitpoints') <= 6) await drinkFirstMatching(s, [...ITEMS.chocolateCakeParts, ITEMS.shark]);
        await maintainEnergy(s, 40);
    };
    const sailed = await sail(s as any, {
        npc: /^customs officer$/i,
        choices: [/journey on this ship/i, /search away/i, /^ok\.?$/i],
        deck: { x: 2683, z: 3268 },
        before: guardHp,
        deadline: s.tick() + 80,
        retryTicks: 1,
    });
    if (!sailed.ok) throw Error(`customs officer sail failed: ${sailed.detail}`);
    const docked = await disembark(s as any, {
        before: guardHp,
        deadline: s.tick() + 25,
        attempts: 6,
        missTicks: 1,
    });
    if (!docked.ok) throw Error(`ardougne gangplank failed: ${docked.detail}`);
    await walkNear(s, { x: 2461, z: 3382, level: 0 }, 2, 260);
    // Open stronghold gate (talk Femi if closed).
    for (let t = 0; t < 35 && (posOf(s)?.worldZ ?? 0) <= 3384; t++) {
        const dlg: any = s.sdk.getDialog();
        if (dlg?.isOpen) {
            if (!dlg.isWaiting) {
                const yes = (dlg.options ?? []).find((o: any) => /ok then|help|sure|okay|yes/i.test(o.text));
                await s.sdk.sendClickDialog(yes ? yes.index : 0);
            }
            await waitTicks(s, 1);
            continue;
        }
        const gate = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => /gate/i.test(l.name) && Math.abs(l.x - 2460) <= 3 && Math.abs(l.z - 3384) <= 3);
        if (gate) await s.direct({ type: 'interactLoc', x: gate.x, z: gate.z, locId: gate.id, optionIndex: 1, reason: 'SDK' });
        else await s.direct({ type: 'walkTo', x: 2461, z: 3390, running: true, reason: 'SDK' });
        await waitTicks(s, 1);
    }
    await walkNear(s, { x: 2474, z: 3436, level: 0 }, 2, 50);
    const steps = [
        { id: 2295, x: 2474, z: 3435 },
        { id: 2285, x: 2473, z: 3425 },
        { id: 2313, x: 2473, z: 3422 },
        { id: 2312, x: 2478, z: 3420 },
        { id: 2314, x: 2486, z: 3419 },
        { id: 2286, x: 2485, z: 3426 },
        { id: 154, x: 2484, z: 3431 },
    ];
    let si = 0, lastXp = skillXp(s, 'Agility'), still = 0, lp = '';
    for (let t = 0; skillLvl(s, 'Agility') < 49 && t < 1800 && !stop?.(); t++) {
        await clearDialogTick(s);
        await maintainEnergy(s, 45);
        const p = posOf(s);
        const key = `${p?.worldX},${p?.worldZ},${p?.level}`;
        still = key === lp ? still + 1 : 0;
        lp = key;
        const gained = skillXp(s, 'Agility') - lastXp;
        if (gained > 0) {
            lastXp = skillXp(s, 'Agility');
            si = (si + 1) % steps.length;
            still = 0;
        }
        if (gained > 0 || still >= 2) {
            const st = steps[si]!;
            await s.direct({ type: 'interactLoc', x: st.x, z: st.z, locId: st.id, optionIndex: 1, reason: 'SDK' });
            still = 0;
        }
        await waitTicks(s, 1);
    }
    if (skillLvl(s, 'Agility') < 49) throw Error(`gnome course did not reach Agility 49 (lvl ${skillLvl(s, 'Agility')})`);
    await rubGlory(s, /edgeville/i, { x: 3087, z: 3496 }, 20);
}

async function runWildernessCourseTo99(s: Session, cfg: AgilityRouteConfig, stop?: () => boolean): Promise<{
    laps: number; fails: number; doses: number; preClicks: number; closes: number; courseTicks: number;
}> {
    const manualPrayer = process.env.PRAYER_GUARD === '0';
    // Walk from Edgeville (or surface ladder) to Wilderness Ridge Gate (2998, 3916).
    if ((posOf(s)?.worldZ ?? 0) < 3916) {
        if (cfg.usePrayer && manualPrayer) await setProtectFromMelee(s, true);
        await walkNear(s, { x: 2998, z: 3915, level: 0 }, 3, 520, { ignoreHunters: true, preDrinkAgility: cfg.usePotion, stop });
    }

    // Drink Agility potion if needed and enter Ridge Gate (2998, 3917).
    let doses = 0;
    for (let t = 0; t < 160 && (posOf(s)?.worldZ ?? 0) < 3930 && !stop?.(); t++) {
        await clearDialogTick(s);
        if (cfg.usePotion && skillCur(s, 'Agility') < 52) {
            if (await drinkFirstMatching(s, ITEMS.agilityPot)) {
                doses++;
            }
        }
        if (skillCur(s, 'Hitpoints') <= 7) {
            await drinkFirstMatching(s, [...ITEMS.chocolateCakeParts, ITEMS.shark]);
        }
        if (skillCur(s, 'Agility') >= 52) {
            await s.direct({ type: 'interactLoc', x: 2998, z: 3917, locId: 2309, optionIndex: 1, reason: 'SDK' });
        }
        await waitTicks(s, 1);
    }
    if ((posOf(s)?.worldZ ?? 0) < 3930) throw Error(`failed to cross Wildy ridge gate (agi=${skillCur(s, 'Agility')})`);
    await waitUntil(s, () => (posOf(s)?.worldZ ?? 0) >= 3931, { timeoutTicks: 8 });
    if (cfg.usePrayer && manualPrayer) await setProtectFromMelee(s, false);

    if (cfg.alignPipe) {
        await s.direct({ type: 'walkTo', x: 3004, z: 3937, running: true, reason: 'SDK' });
        await waitUntil(s, () => {
            const p = posOf(s);
            return !!p && p.worldX === 3004 && p.worldZ === 3937;
        }, { timeoutTicks: 12 });
    }

    const seen = new Set<string>();
    let failSeen = 0;
    const offMsg = s.onTick(() => {
        for (const m of (s.sdk.getState()?.gameMessages ?? []) as any[]) {
            const k = `${m.observationId ?? ''}:${m.tick}:${m.text}`;
            if (seen.has(k)) continue;
            seen.add(k);
            if (FOOD_FAIL_MSG.test(m.text) && !/carefully|safely|skilfully|skillfully/i.test(m.text)) failSeen++;
        }
    });

    const tStart = s.tick();
    const PIT = { id: 1755, x: 3005, z: 10363 };
    const LOG_IDX = 3;
    let i = 0, prog = 0, laps = 0, fails = 0, preClicks = 0, closes = 0, energyMin = 100;
    let stepXp = skillXp(s, 'Agility'), lastPos = '', still = 0, inPit = false, pitClicked = false, preBlock = -1, sentTick = -1;
    let lastPotTick = -10;

    const sipAgilityPot = async () => {
        if (!cfg.usePotion) return;
        if (s.tick() - lastPotTick < 3) return;
        if (!shouldDrinkAgilityPotion(skillLvl(s, 'Agility'), skillCur(s, 'Agility'), false)) return;
        if (await drinkFirstMatching(s, ITEMS.agilityPot)) {
            doses++;
            lastPotTick = s.tick();
        }
    };

    const nearestLocForStep = (step: WildyStep) => {
        const st = s.sdk.getState();
        const p = posOf(s);
        if (!st || !p) return { st, c: { id: step.id, x: step.x, z: step.z }, seenLoc: undefined as any };
        const cands = [{ id: step.id, x: step.x, z: step.z }, ...(step.alt ?? [])]
            .sort((a, b) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ)) - Math.max(Math.abs(b.x - p.worldX), Math.abs(b.z - p.worldZ)));
        const c = cands[0]!;
        const seenLoc = (st.nearbyLocs ?? []).find((l: any) => l.id === c.id && l.x === c.x && l.z === c.z) as any;
        return { st, c, seenLoc };
    };

    const canReachStep = (step: WildyStep): boolean => {
        const { seenLoc } = nearestLocForStep(step);
        return !!seenLoc && seenLoc.reachable !== false;
    };

    const clickStep = async (step: WildyStep) => {
        const { st, c, seenLoc } = nearestLocForStep(step);
        const op = seenLoc?.optionsWithIndex?.[0]?.opIndex ?? 1;
        sentTick = s.tick();
        const acts: Promise<unknown>[] = [];
        if (st?.dialog?.isOpen) {
            acts.push(s.direct({ type: 'closeModal', reason: 'SDK' }));
            closes++;
        }
        acts.push(s.direct({ type: 'interactLoc', x: c.x, z: c.z, locId: c.id, optionIndex: op, reason: 'SDK' }));
        await Promise.all(acts);
    };

    try {
        const hpThreshold = () => {
            const maxHp = skillLvl(s, 'Hitpoints');
            return maxHp <= 15 ? 5 : Math.max(5, Math.floor(maxHp * 0.55));
        };
        const maybeEat = async () => {
            if (skillCur(s, 'Hitpoints') <= hpThreshold()) {
                await drinkFirstMatching(s, [...ITEMS.chocolateCakeParts, ITEMS.shark]);
            }
        };
        const syncPrayer = async (stepIdx: number) => {
            if (!cfg.usePrayer) return;
            if (stepIdx !== 0) await sipPrayer(s, 10);
            if (!manualPrayer) return;
            const needPrayer = inPit || stepIdx === 3 || stepIdx === 4;
            if (needPrayer) {
                await setProtectFromMelee(s, true);
            } else {
                await setProtectFromMelee(s, false);
            }
        };

        // Top-of-course potion, energy, prayer & HP prep before clicking Pipe.
        await sipAgilityPot();
        await maintainEnergy(s, 78);
        await syncPrayer(0);
        await maybeEat();
        await clickStep(WILDERNESS_STEPS[0]!);

        while (skillLvl(s, 'Agility') < 99 && s.tick() - tStart < cfg.cap && !stop?.()) {
            await waitTicks(s, 1);
            const p = posOf(s);
            if (!p || p.isDead) continue;
            energyMin = Math.min(energyMin, p.runEnergy ?? 100);
            if (skillCur(s, 'Hitpoints') <= 5) await maybeEat();
            const key = `${p.worldX},${p.worldZ},${p.level}`;
            const moved = key !== lastPos;
            still = moved ? 0 : still + 1;
            lastPos = key;

            if (failSeen > 0) {
                failSeen = 0;
                fails++;
                preBlock = s.tick();
            }

            const gained = skillXp(s, 'Agility') - stepXp;
            if (gained > 0) {
                stepXp = skillXp(s, 'Agility');
                if (skillLvl(s, 'Agility') >= 99) break;
                if (gained >= 4989 * 2.2) laps++;
                prog = nextWildernessProgress(prog, WILDERNESS_STEPS[i]!.name);
                i = (i + 1) % WILDERNESS_STEPS.length;
                if (i === 0) {
                    await sipAgilityPot();
                    await maintainEnergy(s, 78);
                    await syncPrayer(0);
                    await maybeEat();
                    if (cfg.alignPipe && (p.worldX !== 3004 || p.worldZ !== 3937)) {
                        await s.direct({ type: 'walkTo', x: 3004, z: 3937, running: true, reason: 'SDK' });
                        still = 0;
                        continue;
                    }
                } else {
                    await syncPrayer(i);
                    await maybeEat();
                }
                await clickStep(WILDERNESS_STEPS[i]!);
                still = 0;
                continue;
            }

            const step = WILDERNESS_STEPS[i]!;
            if (step.name === 'rocks') {
                const atEnd = p.worldZ <= 3933 && p.worldZ < 9000;
                if (atEnd && (prog !== 4 || still >= 3)) {
                    prog = nextWildernessProgress(prog, 'rocks');
                    i = 0;
                    stepXp = skillXp(s, 'Agility');
                    await sipAgilityPot();
                    await maintainEnergy(s, 78);
                    await syncPrayer(0);
                    await maybeEat();
                    if (cfg.alignPipe && (p.worldX !== 3004 || p.worldZ !== 3937)) {
                        await s.direct({ type: 'walkTo', x: 3004, z: 3937, running: true, reason: 'SDK' });
                        still = 0;
                        continue;
                    }
                    await clickStep(WILDERNESS_STEPS[0]!);
                    still = 0;
                    continue;
                }
            }

            if (p.worldZ > 9000) {
                if (!inPit) {
                    inPit = true;
                    pitClicked = false;
                }
                if (!pitClicked || still >= 1) {
                    pitClicked = true;
                    await syncPrayer(3);
                    await maybeEat();
                    if (s.sdk.getState()?.dialog?.isOpen) { await s.direct({ type: 'closeModal', reason: 'SDK' }); closes++; }
                    await s.direct({ type: 'interactLoc', x: PIT.x, z: PIT.z, locId: PIT.id, optionIndex: 1, reason: 'SDK' });
                }
                continue;
            }
            if (preBlock >= 0 && moved && s.tick() > preBlock + 1) preBlock = -1;
            if ((still >= 1 || (inPit && moved)) && (inPit || (i === 1 && p.worldZ >= 3955))) {
                const wasInPit = inPit;
                inPit = false;
                pitClicked = false;
                let nextI = resumeStep('wilderness', p as any);
                if (wasInPit && WILDERNESS_STEPS[nextI]?.name === 'stones') nextI = LOG_IDX;
                i = nextI;
                stepXp = skillXp(s, 'Agility');
                await syncPrayer(i);
                await maybeEat();
                await clickStep(WILDERNESS_STEPS[i]!);
                still = 0;
                continue;
            }

            // V2 wilderness pre-click: stay silent mid-obstacle so current crosses uninterrupted and PrayerGuard avoids
            // false interactLoc holds, then send next obstacle's click on finishing tiles once reachable.
            if (preBlock < 0 && startedWildernessObstacle(step.name, p)) {
                const nextIdx = (i + 1) % WILDERNESS_STEPS.length;
                const readyToPreClick = step.name === 'ropeswing' || canPreClickNextObstacle(step.name, p);
                if (readyToPreClick && sentTick !== s.tick()) {
                    if (nextIdx === 0 && cfg.alignPipe) {
                        preClicks++;
                        await s.direct({ type: 'walkTo', x: 3004, z: 3937, running: true, reason: 'SDK' });
                    } else if (canReachStep(WILDERNESS_STEPS[nextIdx]!)) {
                        preClicks++;
                        await syncPrayer(nextIdx);
                        await maybeEat();
                        await clickStep(WILDERNESS_STEPS[nextIdx]!);
                    }
                }
                continue;
            }

            if (i === 0 && cfg.alignPipe) {
                if (p.worldX === 3004 && p.worldZ === 3937) {
                    await syncPrayer(0);
                    await maybeEat();
                    await clickStep(step);
                    still = 0;
                } else if (still >= 1) {
                    await s.direct({ type: 'walkTo', x: 3004, z: 3937, running: true, reason: 'SDK' });
                    still = 0;
                }
                continue;
            }

            if (still >= 1) {
                await syncPrayer(i);
                await maybeEat();
                await clickStep(step);
                still = 0;
            }
        }
    } finally {
        console.log(`WILDY_END laps=${laps} fails=${fails} doses=${doses} preClicks=${preClicks} energyMin=${energyMin} energyEnd=${posOf(s)?.runEnergy ?? -1}`);
        offMsg();
        if (cfg.usePrayer && manualPrayer) await setProtectFromMelee(s, false);
    }
    return { laps, fails, doses, preClicks, closes, courseTicks: s.tick() - tStart };
}

export async function runAgilitySpecialist(bot: string, argv: readonly string[] = process.argv.slice(2)): Promise<never> {
    const cfg = resolveAgilityRouteConfig(bot, argv);
    let stopped = false;
    const stop = () => stopped || existsSync(join(ROOT, '.practice', `stop-${bot}`));
    const spec = await openBot(bot, { onStop: async () => { stopped = true; } });
    let supplier: SupplierAgent | null = null;
    let supplierTask: Promise<void> | null = null;
    try {
        const supplierEnv = (process.env.PRACTICE_SUPPLIER ?? process.env.SUPPLIER ?? '').trim();
        const useBuiltInSupplier = process.env.SUPPLIER_EXTERNAL !== '1'
            && !supplierEnv
            && existsSync(join(ROOT, 'vendor', 'rs-sdk', 'bots', cfg.supplier, 'bot.env'));
        const trade1 = trade1ForConfig(cfg);
        if (useBuiltInSupplier) {
            supplier = new SupplierAgent(cfg.supplier);
            await supplier.init();
            supplierTask = cfg.route === 'tourist'
                ? supplier.runTouristFlow(bot)
                : supplier.runSingleLumbridgeFlow(bot, trade1);
        }

        const t0 = spec.tick();
        await leaveRuneStarter(spec, stop);
        const tutorialTicks = spec.tick() - t0;

        await dropAllMatching(spec, new Set(invOf(spec).map(i => i.id)), 6);
        await walkNear(spec, { x: 3222, z: 3218, level: 0 }, 2, 20);
        const supplierNames = supplierEnv
            ? supplierEnv.split(',').map(v => v.trim()).filter(Boolean)
            : [cfg.supplier];
        const receiveTradePhase = async (want: readonly SupplyEntry[], phase: number, timeoutTicks: number, stopSupplierAfter = false) => {
            if (supplier) {
                await waitUntil(spec, () => stop() || supplier!.isReadyFor(phase) || !!supplier!.lastError(), { timeoutTicks });
                if (supplier.lastError()) throw supplier.lastError()!;
                const giveCounts = new Map<number, number>();
                for (const w of want) giveCounts.set(w.id, (giveCounts.get(w.id) ?? 0) + w.count);
                const sup = supplier.sessionHandle()!;
                try {
                    await burstTradeHost(spec, sup, {
                        giveIds: want.map(w => w.id),
                        giveCounts,
                        deadlineTick: spec.tick() + timeoutTicks,
                        allowHelperOnSingleModal: true,
                    });
                } catch (err) {
                    const fmtInv = (ses: Session) => invOf(ses).map(i => `${i.id}:${i.name}x${i.count}`).join(',');
                    const fmtMsg = (ses: Session) => (ses.sdk.getState()?.gameMessages ?? []).slice(-6).map((m: any) => m.text).join(' | ');
                    console.log(`TRADE_FAIL phase=${phase} specInv=[${fmtInv(spec)}] supInv=[${fmtInv(sup)}] specTrade=${JSON.stringify(spec.sdk.getTradeState())} supTrade=${JSON.stringify(sup.sdk.getTradeState())} specMsgs=[${fmtMsg(spec)}] supMsgs=[${fmtMsg(sup)}]`);
                    throw err;
                }
                supplier.markPhaseDone(phase);
                if (stopSupplierAfter) supplier.stop();
            } else {
                await fastTradeExternalReceive(spec, supplierNames, {
                    acceptOffer: offer => want.every(w => countById(offer, w.id) >= w.count),
                    deadlineTick: spec.tick() + timeoutTicks,
                });
            }
        };
        await receiveTradePhase(trade1, 1, 200, cfg.route !== 'tourist');
        await spec.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' });

        let setupTicks = 0;
        let wildStats = { laps: 0, fails: 0, doses: 0, preClicks: 0, closes: 0, courseTicks: 0 };

        if (cfg.route === 'tourist') {
            await wearItem(spec, ITEMS.fireStaff);
            await runFletchingTo10(spec);
            await runPrayerTo43(spec, 46);
            await runImpCatcherAndEnchant(spec, cfg.cap);

            await walkNear(spec, { x: 3185, z: 3436, level: 0 }, 2, 40);
            await clearAllDialogs(spec, 3);
            await dropExcept(spec, new Set([...GLORY_IDS, ITEMS.airRune, ITEMS.chaosRune]), 8);
            if (invOf(spec).length > 6) {
                throw Error(`pre-trade-2 inventory too full (${invOf(spec).length}): ${invOf(spec).map(i => i.id).join(',')}`);
            }
            await receiveTradePhase(TOURIST_TRADE_2, 2, 450);
            await wearItem(spec, ITEMS.desertShirt);
            await wearItem(spec, ITEMS.desertRobe);
            await wearItem(spec, ITEMS.desertBoots);
            await smithTo20AtVarrock(spec);
            for (const id of [ITEMS.fireStaff, ITEMS.desertShirt, ITEMS.desertRobe, ITEMS.desertBoots]) await wearItem(spec, id);
            await dropExcept(spec, new Set([...GLORY_IDS, ITEMS.airRune, ITEMS.chaosRune, ITEMS.hammer, ITEMS.shark]), 8);
            if (invOf(spec).length > 6) {
                throw Error(`pre-trade-2b inventory too full (${invOf(spec).length}): ${invOf(spec).map(i => i.id).join(',')}`);
            }
            await walkNear(spec, { x: 3185, z: 3436, level: 0 }, 2, 30);
            await receiveTradePhase(TOURIST_TRADE_2B, 3, 450);
            await rubGlory(spec, /al kharid/i, { x: 3293, z: 3163 }, 20);

            await runFastTouristTrap(spec, cfg.cap, cfg.usePrayer, () => supplier?.startEdgevilleMove());
            await rubGlory(spec, /edgeville/i, { x: 3087, z: 3496 }, 20);
            await walkNear(spec, { x: 3094, z: 3491, level: 0 }, 2, 25);
            await dropAllMatching(spec, new Set(invOf(spec).map(i => i.id).filter(id => !GLORY_IDS.includes(id))), 8);
            await receiveTradePhase(TOURIST_TRADE_3, 4, 450, true);
            if (supplierTask) {
                await supplierTask;
                if (supplier?.lastError()) throw supplier.lastError()!;
                await supplier?.close();
                supplier = null;
                supplierTask = null;
            }
        } else {
            if (supplierTask) {
                await supplierTask;
                if (supplier?.lastError()) throw supplier.lastError()!;
                await supplier?.close();
                supplier = null;
                supplierTask = null;
            }
            if (cfg.usePrayer) await runPrayerTo43(spec);
            if (cfg.route === 'monkeybars') {
                await train1To49Monkeybars(spec, cfg.usePotion, cfg.usePrayer, stop);
            } else {
                await train1To49Gnome(spec, stop);
            }
        }

        setupTicks = spec.tick() - t0;
        wildStats = await runWildernessCourseTo99(spec, cfg, stop);

        const totalTicks = spec.tick() - t0;
        const agiLvl = skillLvl(spec, 'Agility');
        const ok = !stop() && agiLvl >= 99;
        return await finish(
            [spec],
            ok,
            `route=${cfg.route} potion=${cfg.usePotion ? 1 : 0} pray=${cfg.usePrayer ? 1 : 0} alignPipe=${cfg.alignPipe ? 1 : 0} ` +
            `agility=1->${agiLvl} xp=${skillXp(spec, 'Agility')} ticks=${totalTicks} tutorial=${tutorialTicks} setup=${setupTicks} ` +
            `wildy=${wildStats.courseTicks} laps=${wildStats.laps} fails=${wildStats.fails} doses=${wildStats.doses} ` +
            `preClicks=${wildStats.preClicks} closes=${wildStats.closes}`,
        );
    } catch (e) {
        supplier?.stop();
        if (supplierTask) await supplierTask.catch(() => {});
        await supplier?.close().catch(() => {});
        return await finish([spec], false, `${e instanceof Error ? e.message : String(e)} ticks=${spec.tick()}`);
    }
}

if (import.meta.main) {
    const [bot, ...rest] = process.argv.slice(2);
    if (!bot) {
        console.log('usage: bun scripts/agility-specialist.ts <bot> [supplierBot] [AGI_ROUTE=tourist|monkeybars|gnome]');
        process.exit(2);
    }
    await runAgilitySpecialist(bot, rest);
}
