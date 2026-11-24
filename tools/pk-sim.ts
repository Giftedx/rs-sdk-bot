// Offline fight simulator: two builds of scripts/pk-kits.ts fight by the server's own combat rules, with no engine.
// A batch of 12 full fights on a practice engine takes about 35 seconds and 2 to 3 GB; this runs thousands of fights a
// second, so a wide search over kits runs here first and only its best candidates go to the bench. It does not play
// the champion profile: no prayer flick, no overhead that changes on the opponent's attack tick (snapPrayer,
// counterRead) and no learnt style choice (adaptStyles). Use it to rank kits, not fight options.
// Rules it follows (vendor/rs-sdk/server/content/scripts):
// - effective level = floor(level * prayer / 100) + 8 + style bonus; a roll is effective * (bonus + 64); a hit lands when
//   randominc(attack roll) > randominc(defence roll) (skill_combat/scripts/combat.rs2, player/player_combat_stat.rs2).
// - max hit = floor((effective strength * (strength bonus + 64) + 320) / 640); damage is randominc(max hit); a protect
//   prayer cuts the max hit to 60% (pvp/pvp_melee.rs2, pvp_ranged.rs2, pvp_magic.rs2). Both are rolled on the attack tick.
// - one attack timer for all styles: a spell 5 ticks, a weapon its attackrate, a bow on rapid one less; a shark adds 3
//   ticks to it and can be eaten every 3 ticks (player/scripts/consumption/consume.rs2).
// - the dragon dagger special: two hits, each 115% damage and accuracy, against slash defence, 250 energy; energy comes
//   back 100 every 50 ticks (pvp/specs/scripts/pvp_dragon_dagger.rs2, skill_combat/configs/combat.constant).
// - prayer points: each tick the drain counter grows by the drain of the prayers that are on (an overhead 12, Steel
//   Skin 12, the two melee prayers 12 each); each 60 + 2 * prayer bonus of counter costs one point
//   (skill_prayer/scripts/prayer.rs2, player/scripts/equip.rs2). A dose of prayer restore gives 31 points. At 0 points
//   every prayer is off. The fight loop flicks its prayers and keeps most of its points; the simulator does not.
// What it leaves out: movement, freezes, poison. Fighters stand next to each other. Check a result on the bench before it goes into the fight loop.
// Usage: bun tools/pk-sim.ts <kit a> <kit b> [fights, default 2000] [options a as JSON] [options b as JSON]
//        bun tools/pk-sim.ts --table [fights]   every kit against the tribrid
//        bun tools/pk-sim.ts --league <kit,kit,...> [fights]   every kit of the list against every other
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KITS, type KitSpec } from '../scripts/pk-kits';
import { objIdByDebugName, questFoodDefinitions } from '../packages/core/src/sustain';
import { seededRandom, SPELLS, styleOfName, type Style } from '../scripts/pk';
import { prayerLevel, specialBar, specialEnergy } from '../packages/core/src/content-facts';

type Bonus = { stab: number; slash: number; crush: number; magic: number; ranged: number; dStab: number; dSlash: number; dCrush: number; dMagic: number; dRanged: number; str: number; rangeStr: number; rate: number; prayer: number };
const BONUS_KEYS: readonly (keyof Bonus)[] = ['stab', 'slash', 'crush', 'magic', 'ranged', 'dStab', 'dSlash', 'dCrush', 'dMagic', 'dRanged', 'str', 'rangeStr', 'rate', 'prayer'];
const PARAM: Record<string, keyof Bonus> = { stabattack: 'stab', slashattack: 'slash', crushattack: 'crush', magicattack: 'magic', rangeattack: 'ranged',
    stabdefence: 'dStab', slashdefence: 'dSlash', crushdefence: 'dCrush', magicdefence: 'dMagic', rangedefence: 'dRanged', strengthbonus: 'str', rangebonus: 'rangeStr', attackrate: 'rate', prayerbonus: 'prayer' };
const ZERO: Bonus = { stab: 0, slash: 0, crush: 0, magic: 0, ranged: 0, dStab: 0, dSlash: 0, dCrush: 0, dMagic: 0, dRanged: 0, str: 0, rangeStr: 0, rate: 0, prayer: 0 };
const DEFAULT_CONTENT_SCRIPTS = resolve(import.meta.dir, '..', 'vendor/rs-sdk/server/content/scripts');
const itemsByRoot = new Map<string, Map<string, Bonus>>();
// Every item's combat bonuses from the content's item configs.
export function itemBonuses(root = DEFAULT_CONTENT_SCRIPTS): Map<string, Bonus> {
    const cached = itemsByRoot.get(root);
    if (cached) return cached;
    const map = new Map<string, Bonus>();
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) { walk(path); continue; }
            if (!entry.name.endsWith('.obj')) continue;
            const text = readFileSync(path, 'utf8');
            if (!text.includes('param=')) continue;
            let name = '';
            let cur: Bonus | undefined;
            let pos = 0;
            const total = text.length;
            while (pos <= total) {
                const nl = text.indexOf('\n', pos);
                let end = nl === -1 ? total : nl;
                if (end > pos && text.charCodeAt(end - 1) === 13) end--;
                if (end > pos) {
                    const first = text.charCodeAt(pos);
                    if (first === 91 /* '[' */ && text.charCodeAt(end - 1) === 93 /* ']' */ && end - pos > 2) {
                        name = text.slice(pos + 1, end - 1);
                        cur = map.get(name);
                    } else if (name && first === 112 /* 'p' */ && text.startsWith('param=', pos)) {
                        const comma = text.indexOf(',', pos + 6);
                        if (comma > pos + 6 && comma < end) {
                            const key = PARAM[text.slice(pos + 6, comma)];
                            if (key) {
                                const valStr = text.slice(comma + 1, end);
                                if (/^-?\d+$/.test(valStr)) {
                                    if (!cur) { cur = { ...ZERO }; map.set(name, cur); }
                                    cur[key] = Number(valStr);
                                }
                            }
                        }
                    }
                }
                if (nl === -1) break;
                pos = nl + 1;
            }
        }
    };
    walk(root);
    itemsByRoot.set(root, map);
    return map;
}

// The fight options the simulator knows, by the names of scripts/pk.ts FightOptions.
export type SimOptions = { rotation?: Style[]; eatAt?: number; specBelow?: number | null; readOverheads?: boolean; castArmour?: 'torso' | 'keep';
    defencePrayer?: boolean; predictPrayer?: boolean; mixStyles?: boolean; styleByArmour?: boolean; restorePrayerAt?: number;
    // The share of the opponent's hits that find our overhead on their style already (default 0.15). On the bench an
    // overhead that follows the weapon was on the right style for 32 of 196 hits of a tribrid in the tick of the roll:
    // the weapon change and the hit come in one tick.
    guardRate?: number };
type MeleeType = 'stab' | 'slash' | 'crush';
type MeleeDefKey = 'dStab' | 'dSlash' | 'dCrush';
type WeaponInfo = { bonus: Bonus; meleeType: MeleeType; meleeDef: MeleeDefKey; rate: number; style: Style };
const weaponInfoCache = new WeakMap<Map<string, Bonus>, Map<string, WeaponInfo>>();
const styleCache = new Map<string, Style>();
const styleOf = (weapon: string | undefined): Style => {
    const key = weapon ?? '';
    let st = styleCache.get(key);
    if (!st) { st = styleOfName(key); styleCache.set(key, st); }
    return st;
};
function weaponInfo(table: Map<string, Bonus>, weapon: string): WeaponInfo {
    let byWeapon = weaponInfoCache.get(table);
    if (!byWeapon) { byWeapon = new Map(); weaponInfoCache.set(table, byWeapon); }
    let info = byWeapon.get(weapon);
    if (!info) {
        const bonus = table.get(weapon) ?? ZERO;
        let meleeType: MeleeType = 'stab', bestVal = bonus.stab;
        if (bonus.slash > bestVal) { meleeType = 'slash'; bestVal = bonus.slash; }
        if (bonus.crush > bestVal) { meleeType = 'crush'; }
        const meleeDef: MeleeDefKey = meleeType === 'stab' ? 'dStab' : meleeType === 'slash' ? 'dSlash' : 'dCrush';
        info = { bonus, meleeType, meleeDef, rate: bonus.rate || 4, style: styleOf(weapon) };
        byWeapon.set(weapon, info);
    }
    return info;
}

type Fighter = {
    kit: KitSpec; o: SimOptions; hp: number; food: number; eatReady: number; actionAt: number; energy: number; regenAt: number;
    baseBonus: Bonus; weaponInfo: WeaponInfo; torsoBonus: Bonus; shieldBonus: Bonus;
    initTorsoBonus: Bonus; meleeShieldBonus: Bonus; hasTorso: boolean; hasMeleeShield: boolean;
    torsoStripsMagic: boolean; torsoStripsRanged: boolean; isDds: boolean;
    switchInfo: { magic?: WeaponInfo; ranged?: WeaponInfo; melee?: WeaponInfo };
    shown: Style; seenOrder: Style[]; last: number;
    boost: { attack: number; strength: number; ranged: number }; taken: number; spellMax: number; rotation: Style[];
    prayer: number; doses: number; drain: number;
    // Base levels of the build (99 unless the kit sets them), its full Hitpoints and what one piece of its food heals.
    lvAttack: number; lvStrength: number; lvDefence: number; lvRanged: number; lvMagic: number; lvPrayer: number;
    maxHp: number; heal: number; boostMax: { attack: number; strength: number; ranged: number };
    defTier: number; atkTier: number; strTier: number;
};
const MAXED = { Attack: 99, Strength: 99, Defence: 99, Ranged: 99, Magic: 99, Prayer: 99, Hitpoints: 99 };
const foodHealCache = new Map<string, number>();
// HP one piece of a kit's food heals, by content debug name (consume_normal.dbrow, read by core/sustain.ts).
export const foodHeal = (debugName: string): number => {
    const cached = foodHealCache.get(debugName);
    if (cached !== undefined) return cached;
    const id = objIdByDebugName(debugName), heal = id === undefined ? undefined : questFoodDefinitions().get(id)?.heal;
    if (heal === undefined) throw Error(`pk-sim: ${debugName} is not a food in the content`);
    foodHealCache.set(debugName, heal);
    return heal;
};
// The 5%, 10% and 15% prayers of a skill, by the Prayer level that opens each (prayers.dbrow; the 105, 110 and 115 of
// player_combat_stat.rs2:215-229 are script literals).
const tier = (prayer: number, levels: [number, number, number]) => (prayer >= levels[2] ? 1.15 : prayer >= levels[1] ? 1.1 : prayer >= levels[0] ? 1.05 : 1);
const PROTECT_LEVEL: Record<Style, number> = { magic: prayerLevel('Protect from Magic'), ranged: prayerLevel('Protect from Missiles'), melee: prayerLevel('Protect from Melee') };
const levels3 = (names: [string, string, string]): [number, number, number] => [prayerLevel(names[0]), prayerLevel(names[1]), prayerLevel(names[2])];
const DEFENCE_PRAYERS = levels3(['Thick Skin', 'Rock Skin', 'Steel Skin']), ATTACK_PRAYERS = levels3(['Clarity of Thought', 'Improved Reflexes', 'Incredible Reflexes']), STRENGTH_PRAYERS = levels3(['Burst of Strength', 'Superhuman Strength', 'Ultimate Strength']);
// The special attack bar (combat.constant sa_*; the dragon dagger's sa_energy param). The 115% of a hit is a script literal (pvp_dragon_dagger.rs2).
export const SPECIAL = { ...specialBar(), cost: specialEnergy('dragon dagger')! };
// Body armour that the fight loop takes off for a cast or a shot (scripts/pk.ts negativeCastArmour).
const STRIP: Record<Style, RegExp> = { magic: /(platebody|chainbody|dragonhide_body|leather_body|studded_body)$/, ranged: /(platebody|chainbody)$/, melee: /^$/ };
const carries = (kit: KitSpec, name: string) => kit.carried.some(c => (typeof c === 'string' ? c : c[0]) === name);

type KitTemplate = {
    baseBonus: Bonus; initWeapon: WeaponInfo; initTorsoBonus: Bonus; initShieldBonus: Bonus;
    meleeShieldBonus: Bonus; hasTorso: boolean; hasMeleeShield: boolean;
    torsoStripsMagic: boolean; torsoStripsRanged: boolean; isDds: boolean;
    switchInfo: { magic?: WeaponInfo; ranged?: WeaponInfo; melee?: WeaponInfo };
    styles: Style[]; defaultRotation: Style[];
    lvAttack: number; lvStrength: number; lvDefence: number; lvRanged: number; lvMagic: number; lvPrayer: number; maxHp: number;
    heal: number; doses: number; spellMax: number;
    boostMax: { attack: number; strength: number; ranged: number };
    defTier: number; atkTier: number; strTier: number;
};
const templateCache = new WeakMap<Map<string, Bonus>, WeakMap<KitSpec, KitTemplate>>();
function templateFor(kit: KitSpec, table: Map<string, Bonus>): KitTemplate {
    let byKit = templateCache.get(table);
    if (!byKit) { byKit = new WeakMap(); templateCache.set(table, byKit); }
    let tpl = byKit.get(kit);
    if (tpl) return tpl;
    const baseBonus: Bonus = { ...ZERO };
    let weaponName = '', torso: string | undefined, shield: string | undefined;
    for (const [slot, item] of Object.entries(kit.worn)) {
        const name = typeof item === 'string' ? item : (item as [string, number])[0];
        if (slot === 'weapon') weaponName = name;
        else if (slot === 'torso') torso = name;
        else if (slot === 'shield') shield = name;
        else {
            const b = table.get(name);
            if (b) for (const k of BONUS_KEYS) baseBonus[k] += b[k];
        }
    }
    const initWeapon = weaponInfo(table, weaponName);
    const initTorsoBonus = torso ? (table.get(torso) ?? ZERO) : ZERO;
    const initShieldBonus = shield ? (table.get(shield) ?? ZERO) : ZERO;
    const meleeShield = kit.switches.melee?.[1] ?? shield;
    const meleeShieldBonus = meleeShield ? (table.get(meleeShield) ?? ZERO) : ZERO;
    const switchInfo: { magic?: WeaponInfo; ranged?: WeaponInfo; melee?: WeaponInfo } = {};
    const styles: Style[] = [];
    for (const st of ['magic', 'ranged', 'melee'] as Style[]) {
        const w = kit.switches[st]?.[0];
        if (w) { styles.push(st); switchInfo[st] = weaponInfo(table, w); }
    }
    const lv = { ...MAXED, ...kit.skills };
    const boostMax = {
        attack: carries(kit, '4dose2attack') ? 5 + Math.floor(lv.Attack * 0.15) : 0,
        strength: carries(kit, '4dose2strength') ? 5 + Math.floor(lv.Strength * 0.15) : 0,
        ranged: carries(kit, '4doserangerspotion') ? 4 + Math.floor(lv.Ranged / 10) : 0,
    };
    const god = kit.options?.damageSpell === SPELLS.flamesOfZamorak && kit.options.charge, iban = kit.options?.damageSpell === SPELLS.ibanBlast;
    const spellMax = god ? 30 : iban ? 25 : carries(kit, 'bloodrune') && lv.Magic >= 75 ? 20 : carries(kit, 'deathrune') && lv.Magic >= 59 ? 16 : carries(kit, 'chaosrune') && lv.Magic >= 35 ? 12 : 8;
    const defaultRotation = (kit.options?.rotation ?? ['magic', 'ranged', 'melee']).filter(st => styles.includes(st));
    tpl = {
        baseBonus, initWeapon, initTorsoBonus, initShieldBonus, meleeShieldBonus,
        hasTorso: !!torso, hasMeleeShield: !!meleeShield,
        torsoStripsMagic: STRIP.magic.test(torso ?? ''), torsoStripsRanged: STRIP.ranged.test(torso ?? ''),
        isDds: !!kit.switches.melee?.[0]?.startsWith('dragon_dagger'),
        switchInfo, styles, defaultRotation,
        lvAttack: lv.Attack, lvStrength: lv.Strength, lvDefence: lv.Defence, lvRanged: lv.Ranged, lvMagic: lv.Magic, lvPrayer: lv.Prayer, maxHp: lv.Hitpoints,
        heal: foodHeal(kit.foodItem ?? 'shark'),
        doses: 4 * kit.carried.filter(c => (typeof c === 'string' ? c : c[0]) === '4doseprayerrestore').length,
        spellMax, boostMax,
        defTier: tier(lv.Prayer, DEFENCE_PRAYERS), atkTier: tier(lv.Prayer, ATTACK_PRAYERS), strTier: tier(lv.Prayer, STRENGTH_PRAYERS),
    };
    byKit.set(kit, tpl);
    return tpl;
}

function fighter(kit: KitSpec, o: SimOptions, table: Map<string, Bonus>): Fighter {
    const t = templateFor(kit, table);
    const rotation = o.rotation ? o.rotation.filter(st => t.styles.includes(st)) : t.defaultRotation;
    return {
        kit, o, hp: t.maxHp, food: kit.food, eatReady: 0, actionAt: 1, energy: SPECIAL.max, regenAt: 0,
        baseBonus: t.baseBonus, weaponInfo: t.initWeapon, torsoBonus: t.initTorsoBonus, shieldBonus: t.initShieldBonus,
        initTorsoBonus: t.initTorsoBonus, meleeShieldBonus: t.meleeShieldBonus, hasTorso: t.hasTorso, hasMeleeShield: t.hasMeleeShield,
        torsoStripsMagic: t.torsoStripsMagic, torsoStripsRanged: t.torsoStripsRanged, isDds: t.isDds,
        switchInfo: t.switchInfo,
        shown: t.initWeapon.style, seenOrder: [], last: -1,
        prayer: t.lvPrayer, doses: t.doses, drain: 0,
        boost: { attack: t.boostMax.attack, strength: t.boostMax.strength, ranged: t.boostMax.ranged }, taken: 0,
        spellMax: t.spellMax, rotation,
        lvAttack: t.lvAttack, lvStrength: t.lvStrength, lvDefence: t.lvDefence, lvRanged: t.lvRanged, lvMagic: t.lvMagic, lvPrayer: t.lvPrayer,
        maxHp: t.maxHp, heal: t.heal, boostMax: t.boostMax,
        defTier: t.defTier, atkTier: t.atkTier, strTier: t.strTier,
    };
}
const sum = (f: Fighter, key: keyof Bonus) => f.baseBonus[key] + f.weaponInfo.bonus[key] + f.torsoBonus[key] + f.shieldBonus[key];
const effDefence = (f: Fighter) => Math.floor(f.lvDefence * (f.o.defencePrayer === false || f.prayer <= 0 ? 1 : f.defTier));
// A build holds the overhead against a style only from the Prayer level of that prayer.
const protects = (f: Fighter, style: Style) => f.prayer > 0 && f.lvPrayer >= PROTECT_LEVEL[style];
// The style our armour is weakest to, for an opponent that reads it.
const weakest = (f: Fighter, open: readonly Style[]): Style => {
    let bestStyle = open[0]!;
    let bestDef = sum(f, bestStyle === 'magic' ? 'dMagic' : bestStyle === 'ranged' ? 'dRanged' : 'dStab');
    for (let i = 1; i < open.length; i++) {
        const st = open[i]!;
        const d = sum(f, st === 'magic' ? 'dMagic' : st === 'ranged' ? 'dRanged' : 'dStab');
        if (d < bestDef) { bestDef = d; bestStyle = st; }
    }
    return bestStyle;
};

export type SimFight = { winner: 'a' | 'b' | 'draw'; ticks: number; takenA: number; takenB: number; attacksA: Record<Style | 'special' | 'eats', number>; damageA: Record<Style | 'special', number> };
export function simulate(kitA: string, kitB: string, optionsA: SimOptions = {}, optionsB: SimOptions = {}, seed = 1, cap = 900): SimFight {
    const table = itemBonuses(), rand = seededRandom(seed), roll = (max: number) => Math.floor(rand() * (Math.max(0, max) + 1));
    const a = fighter(KITS[kitA]!, optionsA, table), b = fighter(KITS[kitB]!, optionsB, table);
    const landing: { at: number; who: Fighter; damage: number }[] = [];
    // Damage that is due: a melee hit lands on its own tick, so this runs after the actions of a tick too.
    const land = (tick: number) => {
        if (!landing.length) return;
        let write = 0;
        for (let i = 0; i < landing.length; i++) {
            const l = landing[i]!;
            if (l.at <= tick) { l.who.hp -= l.damage; l.who.taken += l.damage; }
            else landing[write++] = l;
        }
        landing.length = write;
    };
    const attacksA = { magic: 0, ranged: 0, melee: 0, special: 0, eats: 0 }, damageA = { magic: 0, ranged: 0, melee: 0, special: 0 };
    // The overhead of a defender: against the style the attacker showed last, or the one it is predicted to use next.
    const guess = (def: Fighter, att: Fighter): Style | undefined => {
        if (def.prayer <= 0) return undefined;
        const order = att.seenOrder, len = order.length;
        if (!def.o.predictPrayer || len < 4) return att.shown;
        const shown = att.shown;
        let cMagic = 0, cRanged = 0, cMelee = 0, total = 0;
        for (let i = 0; i < len - 1; i++) {
            if (order[i] === shown) {
                const nxt = order[i + 1]!;
                total++;
                if (nxt === 'magic') cMagic++;
                else if (nxt === 'ranged') cRanged++;
                else cMelee++;
            }
        }
        let bestStyle: Style = 'magic', bestCount = cMagic;
        if (cRanged > bestCount) { bestStyle = 'ranged'; bestCount = cRanged; }
        if (cMelee > bestCount) { bestStyle = 'melee'; bestCount = cMelee; }
        return bestCount >= 2 && bestCount / total >= 0.6 ? bestStyle : shown;
    };
    const overhead = (def: Fighter, att: Fighter): Style | undefined => {
        const pick = guess(def, att);
        return pick && protects(def, pick) ? pick : undefined;
    };
    const hit = (def: Fighter, attackRoll: number, defenceRoll: number, max: number, style: Style, guarded: Style | undefined, at: number): number => {
        const damage = roll(attackRoll) > roll(defenceRoll) ? Math.min(roll(Math.floor(guarded === style ? max * 0.6 : max)), def.hp) : 0;
        landing.push({ at, who: def, damage });
        return damage;
    };
    const usableBuf: Style[] = [];
    // A turn in two parts, as the server runs a tick: every player's input (food, gear) first, then the attacks. `act`
    // does the first part and returns the second.
    const act = (me: Fighter, opp: Fighter, tick: number, guard: Style | undefined): (() => void) | undefined => {
        // Prayer points: a dose at the restore level, then the drain of the prayers that are on in this tick.
        if (me.prayer <= Math.min(me.o.restorePrayerAt ?? 20, me.lvPrayer - 1) && me.doses > 0) { me.doses--; me.prayer = Math.min(me.lvPrayer, me.prayer + 7 + Math.floor(me.lvPrayer / 4)); }
        if (me.prayer > 0) {
            me.drain += (me.lvPrayer >= 37 ? 12 : 0) + (me.o.defencePrayer === false ? 0 : 12) + (me.shown === 'melee' ? 24 : 0);
            const resistance = 60 + 2 * sum(me, 'prayer');
            if (me.drain >= resistance) { me.prayer = Math.max(0, me.prayer - Math.floor(me.drain / resistance)); me.drain %= resistance; }
        }
        // Boosts fall one level each 100 ticks; a dose brings a spent one back (four doses, no cost in ticks).
        if (tick % 100 === 0) {
            if (me.boost.attack > 0) me.boost.attack = me.boost.attack <= 6 ? me.boostMax.attack : me.boost.attack - 1;
            if (me.boost.strength > 0) me.boost.strength = me.boost.strength <= 6 ? me.boostMax.strength : me.boost.strength - 1;
            if (me.boost.ranged > 0) me.boost.ranged = me.boost.ranged <= 6 ? me.boostMax.ranged : me.boost.ranged - 1;
        }
        if (tick >= me.regenAt && me.energy < SPECIAL.max) { me.energy = Math.min(SPECIAL.max, me.energy + SPECIAL.regenAmount); me.regenAt = tick + SPECIAL.regenInterval; }
        if (me.hp < me.maxHp && me.hp <= (me.o.eatAt ?? 50) && me.food > 0 && tick >= me.eatReady) { me.hp = Math.min(me.maxHp, me.hp + me.heal); me.food--; me.eatReady = tick + 3; me.actionAt += 3; if (me === a) attacksA.eats++; }
        if (tick < me.actionAt) return undefined;
        usableBuf.length = 0;
        const rot = me.rotation;
        const readOh = me.o.readOverheads !== false;
        for (let i = 0; i < rot.length; i++) {
            const st = rot[i]!;
            if (!readOh || st !== guard) usableBuf.push(st);
        }
        const usable = usableBuf.length ? usableBuf : rot;
        let style: Style;
        if (me.o.styleByArmour) style = weakest(opp, usable);
        else if (me.o.mixStyles) style = usable[Math.floor(rand() * usable.length)]!;
        else { let i = me.last; do { i = (i + 1) % rot.length; } while (!usable.includes(rot[i]!)); me.last = i; style = rot[i]!; }
        const below = me.o.specBelow === undefined ? 0.65 : me.o.specBelow;
        const special = below !== null && me.isDds && me.energy >= SPECIAL.cost && opp.hp / opp.maxHp <= below && (guard !== 'melee' || opp.hp / opp.maxHp <= 0.25);
        if (special) style = 'melee';
        // The gear of the turn, as the fight loop wears it: the torso comes off for a cast or a shot and goes back on for
        // melee; a bow takes the shield off.
        me.weaponInfo = me.switchInfo[style]!;
        if (style === 'melee') {
            if (me.hasTorso) me.torsoBonus = me.initTorsoBonus;
            if (me.hasMeleeShield) me.shieldBonus = me.meleeShieldBonus;
        } else {
            if (me.hasTorso) me.torsoBonus = me.initTorsoBonus;
            if (me.o.castArmour !== 'keep' && me.hp > 40 && (style === 'magic' ? me.torsoStripsMagic : me.torsoStripsRanged)) me.torsoBonus = ZERO;
            if (style === 'ranged') me.shieldBonus = ZERO;
        }
        return () => {
        if (protects(opp, style) && rand() < (opp.o.guardRate ?? 0.15)) guard = style;
        const defence = effDefence(opp) + 8;
        if (style === 'melee') {
            const on = me.prayer > 0, attack = Math.floor((me.lvAttack + me.boost.attack) * (on ? me.atkTier : 1)) + 8;
            const strength = Math.floor((me.lvStrength + me.boost.strength) * (on ? me.strTier : 1)) + 8 + 3;
            // A melee hit uses the attack type the weapon is best at, against the defence of that type.
            const wInfo = me.weaponInfo;
            const max = Math.floor((strength * (sum(me, 'str') + 64) + 320) / 640), attackRoll = attack * (sum(me, wInfo.meleeType) + 64);
            if (special) {
                me.energy -= SPECIAL.cost; if (me.energy === SPECIAL.max - SPECIAL.cost) me.regenAt = tick + SPECIAL.regenInterval;
                let d = 0;
                const specAtk = Math.floor(attack * (sum(me, 'slash') + 64) * 1.15);
                const specDef = defence * (sum(opp, 'dSlash') + 64);
                const specMax = Math.floor(max * 1.15);
                for (let i = 0; i < 2; i++) d += hit(opp, specAtk, specDef, specMax, 'melee', guard, tick);
                if (me === a) { attacksA.special++; damageA.special += d; }
            } else { const d = hit(opp, attackRoll, defence * (sum(opp, wInfo.meleeDef) + 64), max, 'melee', guard, tick); if (me === a) { attacksA.melee++; damageA.melee += d; } }
            me.actionAt = tick + wInfo.rate;
        } else if (style === 'ranged') {
            const ranged = me.lvRanged + me.boost.ranged + 8;
            const d = hit(opp, ranged * (sum(me, 'ranged') + 64), defence * (sum(opp, 'dRanged') + 64), Math.floor((ranged * (sum(me, 'rangeStr') + 64) + 320) / 640), 'ranged', guard, tick + 1);
            if (me === a) { attacksA.ranged++; damageA.ranged += d; }
            me.actionAt = tick + Math.max(1, me.weaponInfo.rate - 1);
        } else {
            const magicDefence = Math.floor((7 * opp.lvMagic + 3 * effDefence(opp)) / 10) + 8;
            const d = hit(opp, (me.lvMagic + 9) * (sum(me, 'magic') + 64), magicDefence * (sum(opp, 'dMagic') + 64), me.spellMax, 'magic', guard, tick + 2);
            if (me === a) { attacksA.magic++; damageA.magic += d; }
            me.actionAt = tick + 5;
        }
        me.seenOrder.push(style);
        };
    };
    for (let tick = 1; tick <= cap; tick++) {
        land(tick);
        if (a.hp <= 0 || b.hp <= 0) return { winner: a.hp <= 0 && b.hp <= 0 ? 'draw' : a.hp <= 0 ? 'b' : 'a', ticks: tick, takenA: a.taken, takenB: b.taken, attacksA, damageA };
        // Both act on what they saw at the end of the last tick.
        const guardB = overhead(b, a), guardA = overhead(a, b);
        const strikeA = act(a, b, tick, guardB), strikeB = act(b, a, tick, guardA);
        strikeA?.(); strikeB?.();
        land(tick);
        a.shown = a.weaponInfo.style; b.shown = b.weaponInfo.style;
    }
    return { winner: 'draw', ticks: cap, takenA: a.taken, takenB: b.taken, attacksA, damageA };
}

export type SimSummary = { fights: number; winsA: number; winsB: number; draws: number; winRateA: number; ticks: number; netA: number };
// Many fights of one matchup; the seed of fight i is seed + i.
export function series(kitA: string, kitB: string, optionsA: SimOptions = {}, optionsB: SimOptions = {}, fights = 2000, seed = 1): SimSummary {
    let winsA = 0, winsB = 0, ticks = 0, net = 0;
    for (let i = 0; i < fights; i++) {
        const f = simulate(kitA, kitB, optionsA, optionsB, seed + i);
        if (f.winner === 'a') winsA++; else if (f.winner === 'b') winsB++;
        ticks += f.ticks; net += ((f.takenB - f.takenA) * 100) / f.ticks;
    }
    return { fights, winsA, winsB, draws: fights - winsA - winsB, winRateA: Number((winsA / fights).toFixed(3)), ticks: Math.round(ticks / fights), netA: Number((net / fights).toFixed(1)) };
}

// Every kit of a list against every other: the win rate of each pair and, for each kit, its mean over the others.
export function league(kits: readonly string[], fights = 1000): { kit: string; mean: number; against: Record<string, number> }[] {
    return kits.map(kit => {
        const against = Object.fromEntries(kits.filter(other => other !== kit).map(other => [other, series(kit, other, {}, {}, fights).winRateA]));
        const rates = Object.values(against);
        return { kit, mean: Number((rates.reduce((n, r) => n + r, 0) / Math.max(1, rates.length)).toFixed(3)), against };
    }).sort((x, y) => y.mean - x.mean);
}

if (import.meta.main) {
    const argv = process.argv.slice(2);
    if (argv[0] === '--league') {
        const kits = (argv[1] ?? '').split(',').filter(Boolean), unknown = kits.filter(k => !KITS[k]);
        if (kits.length < 2 || unknown.length) { console.log(`usage: bun tools/pk-sim.ts --league <kit,kit,...> [fights]; unknown: ${unknown.join(', ') || 'none'}`); process.exit(2); }
        for (const row of league(kits, Number(argv[2] ?? 1000))) console.log(`SIM ${JSON.stringify(row)}`);
    } else if (argv[0] === '--table') {
        const fights = Number(argv[1] ?? 2000);
        for (const kit of Object.keys(KITS)) console.log(`SIM ${JSON.stringify({ kit, against: 'tribrid', ...series(kit, 'tribrid', {}, {}, fights) })}`);
    } else {
        const [kitA, kitB, fights, optionsA, optionsB] = argv;
        if (!kitA || !kitB || !KITS[kitA] || !KITS[kitB]) { console.log(`usage: bun tools/pk-sim.ts <kit a> <kit b> [fights] [options a] [options b]; kits: ${Object.keys(KITS).join(', ')}`); process.exit(2); }
        console.log(`SIM ${JSON.stringify({ a: kitA, b: kitB, ...series(kitA, kitB, optionsA ? JSON.parse(optionsA) : {}, optionsB ? JSON.parse(optionsB) : {}, Number(fights ?? 2000)) })}`);
    }
}
