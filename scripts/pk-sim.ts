// Offline fight simulator: two builds of scripts/pk-kits.ts fight by the server's own combat rules, with no engine.
// One spar on a practice engine takes about 4 seconds and 1.7 GB; this runs thousands of fights a second, so a search
// over kits and fight options runs here first and only its best candidates go to the bench.
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
//   every prayer is off. On the bench both sides of a mirror end at 0 points: the points are the clock of a fight.
// What it leaves out: movement, freezes, poison. Fighters stand next to each other. Check a result on the bench before it goes into the fight loop.
// Usage: bun scripts/pk-sim.ts <kit a> <kit b> [fights, default 2000] [options a as JSON] [options b as JSON]
//        bun scripts/pk-sim.ts --table [fights]   every kit against the tribrid
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KITS, type KitSpec } from './pk-kits';
import { seededRandom, type Style } from './pk';

type Bonus = { stab: number; slash: number; crush: number; magic: number; ranged: number; dStab: number; dSlash: number; dCrush: number; dMagic: number; dRanged: number; str: number; rangeStr: number; rate: number; prayer: number };
const PARAM: Record<string, keyof Bonus> = { stabattack: 'stab', slashattack: 'slash', crushattack: 'crush', magicattack: 'magic', rangeattack: 'ranged',
    stabdefence: 'dStab', slashdefence: 'dSlash', crushdefence: 'dCrush', magicdefence: 'dMagic', rangedefence: 'dRanged', strengthbonus: 'str', rangebonus: 'rangeStr', attackrate: 'rate', prayerbonus: 'prayer' };
const ZERO: Bonus = { stab: 0, slash: 0, crush: 0, magic: 0, ranged: 0, dStab: 0, dSlash: 0, dCrush: 0, dMagic: 0, dRanged: 0, str: 0, rangeStr: 0, rate: 0, prayer: 0 };
let items: Map<string, Bonus> | undefined;
// Every item's combat bonuses from the content's item configs.
export function itemBonuses(root = resolve(import.meta.dir, '..', 'vendor/rs-sdk/server/content/scripts')): Map<string, Bonus> {
    if (items) return items;
    items = new Map();
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) { walk(path); continue; }
            if (!entry.endsWith('.obj')) continue;
            let name = '';
            for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
                const head = /^\[(.+)\]$/.exec(line);
                if (head) { name = head[1]!; continue; }
                const param = /^param=(\w+),(-?\d+)$/.exec(line), key = param && PARAM[param[1]!];
                if (!name || !key) continue;
                if (!items!.has(name)) items!.set(name, { ...ZERO });
                items!.get(name)![key] = Number(param![2]);
            }
        }
    };
    walk(root);
    return items;
}

// The fight options the simulator knows, by the names of scripts/pk.ts FightOptions.
export type SimOptions = { rotation?: Style[]; eatAt?: number; specBelow?: number | null; readOverheads?: boolean; castArmour?: 'torso' | 'keep';
    defencePrayer?: boolean; predictPrayer?: boolean; mixStyles?: boolean; styleByArmour?: boolean; restorePrayerAt?: number;
    // The share of the opponent's hits that find our overhead on their style already (default 0.9). On the bench a side
    // sees the new weapon before the hit rolls: 188 of 196 hits of a tribrid met the right overhead of a ranger.
    guardRate?: number };
type Fighter = {
    kit: KitSpec; o: SimOptions; hp: number; food: number; eatReady: number; actionAt: number; energy: number; regenAt: number;
    worn: Record<string, string>; torso: string | undefined; shield: string | undefined; shown: Style; seenOrder: Style[]; last: number;
    boost: { attack: number; strength: number; ranged: number }; taken: number; spellMax: number; rotation: Style[];
    prayer: number; doses: number; drain: number;
};
const styleOf = (weapon: string | undefined): Style => (/(shortbow|longbow|crossbow)/.test(weapon ?? '') ? 'ranged' : /staff/.test(weapon ?? '') ? 'magic' : 'melee');
const carries = (kit: KitSpec, name: string) => kit.carried.some(c => (typeof c === 'string' ? c : c[0]) === name);
function fighter(kit: KitSpec, o: SimOptions): Fighter {
    const worn: Record<string, string> = {};
    for (const [slot, item] of Object.entries(kit.worn)) worn[slot] = typeof item === 'string' ? item : (item as [string, number])[0];
    const styles = (['magic', 'ranged', 'melee'] as Style[]).filter(st => kit.switches[st]?.length);
    return { kit, o, hp: 99, food: kit.food, eatReady: 0, actionAt: 1, energy: 1000, regenAt: 0, worn, torso: worn.torso, shield: worn.shield, shown: styleOf(worn.weapon), seenOrder: [], last: -1,
        prayer: 99, doses: 4 * kit.carried.filter(c => (typeof c === 'string' ? c : c[0]) === '4doseprayerrestore').length, drain: 0,
        boost: { attack: carries(kit, '4dose2attack') ? 19 : 0, strength: carries(kit, '4dose2strength') ? 19 : 0, ranged: carries(kit, '4doserangerspotion') ? 13 : 0 }, taken: 0,
        spellMax: carries(kit, 'bloodrune') ? 20 : carries(kit, 'deathrune') ? 16 : carries(kit, 'chaosrune') ? 12 : 8,
        rotation: (o.rotation ?? kit.options?.rotation ?? ['magic', 'ranged', 'melee']).filter(st => styles.includes(st)) };
}
const sum = (f: Fighter, key: keyof Bonus, table: Map<string, Bonus>) => Object.values(f.worn).reduce((n, item) => n + (table.get(item)?.[key] ?? 0), 0);
const effDefence = (f: Fighter) => Math.floor(99 * (f.o.defencePrayer === false || f.prayer <= 0 ? 1 : 1.15));
// The style our armour is weakest to, for an opponent that reads it.
const weakest = (f: Fighter, open: Style[], table: Map<string, Bonus>): Style => [...open].sort((a, b) => sum(f, a === 'magic' ? 'dMagic' : a === 'ranged' ? 'dRanged' : 'dStab', table) - sum(f, b === 'magic' ? 'dMagic' : b === 'ranged' ? 'dRanged' : 'dStab', table))[0]!;

export type SimFight = { winner: 'a' | 'b' | 'draw'; ticks: number; takenA: number; takenB: number; attacksA: Record<Style | 'special' | 'eats', number>; damageA: Record<Style | 'special', number> };
export function simulate(kitA: string, kitB: string, optionsA: SimOptions = {}, optionsB: SimOptions = {}, seed = 1, cap = 900): SimFight {
    const table = itemBonuses(), rand = seededRandom(seed), roll = (max: number) => Math.floor(rand() * (Math.max(0, max) + 1));
    const a = fighter(KITS[kitA]!, optionsA), b = fighter(KITS[kitB]!, optionsB);
    let landing: { at: number; who: Fighter; damage: number }[] = [];
    // Damage that is due: a melee hit lands on its own tick, so this runs after the actions of a tick too.
    const land = (tick: number) => { for (const l of landing) if (l.at <= tick) { l.who.hp -= l.damage; l.who.taken += l.damage; } landing = landing.filter(l => l.at > tick); };
    const attacksA = { magic: 0, ranged: 0, melee: 0, special: 0, eats: 0 }, damageA = { magic: 0, ranged: 0, melee: 0, special: 0 };
    // The overhead of a defender: against the style the attacker showed last, or the one it is predicted to use next.
    const overhead = (def: Fighter, att: Fighter): Style | undefined => {
        if (def.prayer <= 0) return undefined;
        if (!def.o.predictPrayer || att.seenOrder.length < 4) return att.shown;
        const after = att.seenOrder.flatMap((st, i) => (st === att.shown && att.seenOrder[i + 1] ? [att.seenOrder[i + 1]!] : []));
        const best = (['magic', 'ranged', 'melee'] as Style[]).map(st => [st, after.filter(x => x === st).length] as const).sort((x, y) => y[1] - x[1])[0]!;
        return best[1] >= 2 && best[1] / after.length >= 0.6 ? best[0] : att.shown;
    };
    const hit = (att: Fighter, def: Fighter, attackRoll: number, defenceRoll: number, max: number, style: Style, guarded: Style | undefined, at: number): number => {
        const damage = roll(attackRoll) > roll(defenceRoll) ? Math.min(roll(Math.floor(guarded === style ? max * 0.6 : max)), def.hp) : 0;
        landing.push({ at, who: def, damage });
        return damage;
    };
    // A turn in two parts, as the server runs a tick: every player's input (food, gear) first, then the attacks. `act`
    // does the first part and returns the second.
    const act = (me: Fighter, opp: Fighter, tick: number, guard: Style | undefined): (() => void) | undefined => {
        // Prayer points: a dose at the restore level, then the drain of the prayers that are on in this tick.
        if (me.prayer <= (me.o.restorePrayerAt ?? 20) && me.doses > 0) { me.doses--; me.prayer = Math.min(99, me.prayer + 31); }
        if (me.prayer > 0) {
            me.drain += 12 + (me.o.defencePrayer === false ? 0 : 12) + (me.shown === 'melee' ? 24 : 0);
            const resistance = 60 + 2 * sum(me, 'prayer', table);
            if (me.drain >= resistance) { me.prayer = Math.max(0, me.prayer - Math.floor(me.drain / resistance)); me.drain %= resistance; }
        }
        // Boosts fall one level each 100 ticks; a dose brings a spent one back (four doses, no cost in ticks).
        if (tick % 100 === 0) for (const k of ['attack', 'strength', 'ranged'] as const) if (me.boost[k] > 0) me.boost[k] = me.boost[k] <= 6 ? (k === 'ranged' ? 13 : 19) : me.boost[k] - 1;
        if (tick >= me.regenAt && me.energy < 1000) { me.energy = Math.min(1000, me.energy + 100); me.regenAt = tick + 50; }
        if (me.hp <= (me.o.eatAt ?? 50) && me.food > 0 && tick >= me.eatReady) { me.hp = Math.min(99, me.hp + 20); me.food--; me.eatReady = tick + 3; me.actionAt += 3; if (me === a) attacksA.eats++; }
        if (tick < me.actionAt) return undefined;
        const open = me.rotation.filter(st => me.o.readOverheads === false || st !== guard);
        const usable = open.length ? open : me.rotation;
        let style: Style;
        if (me.o.styleByArmour) style = weakest(opp, usable, table);
        else if (me.o.mixStyles) style = usable[Math.floor(rand() * usable.length)]!;
        else { let i = me.last; do { i = (i + 1) % me.rotation.length; } while (!usable.includes(me.rotation[i]!)); me.last = i; style = me.rotation[i]!; }
        const below = me.o.specBelow === undefined ? 0.65 : me.o.specBelow;
        const special = below !== null && me.kit.switches.melee?.[0]?.startsWith('dragon_dagger') && me.energy >= 250 && opp.hp / 99 <= below && (guard !== 'melee' || opp.hp / 99 <= 0.25);
        if (special) style = 'melee';
        // The gear of the turn, as the fight loop wears it: the torso comes off for a cast or a shot and goes back on for
        // melee; a bow takes the shield off.
        me.worn.weapon = me.kit.switches[style]![0]!;
        if (style === 'melee') { if (me.torso) me.worn.torso = me.torso; const shield = me.kit.switches.melee?.[1] ?? me.shield; if (shield) me.worn.shield = shield; }
        else { if (me.o.castArmour !== 'keep' && me.hp > 40) delete me.worn.torso; if (style === 'ranged') delete me.worn.shield; }
        return () => {
        if (opp.prayer > 0 && rand() < (opp.o.guardRate ?? 0.9)) guard = style;
        const defence = effDefence(opp) + 8;
        if (style === 'melee') {
            const pray = me.prayer > 0 ? 1.15 : 1, attack = Math.floor((99 + me.boost.attack) * pray) + 8, strength = Math.floor((99 + me.boost.strength) * pray) + 8 + 3;
            // A melee hit uses the attack type the weapon is best at, against the defence of that type.
            const type = (['stab', 'slash', 'crush'] as const).reduce((x, y) => ((table.get(me.worn.weapon!)?.[y] ?? 0) > (table.get(me.worn.weapon!)?.[x] ?? 0) ? y : x));
            const typeDefence = ({ stab: 'dStab', slash: 'dSlash', crush: 'dCrush' } as const)[type];
            const max = Math.floor((strength * (sum(me, 'str', table) + 64) + 320) / 640), attackRoll = attack * (sum(me, type, table) + 64);
            if (special) {
                me.energy -= 250; if (me.energy === 750) me.regenAt = tick + 50;
                let d = 0;
                for (let i = 0; i < 2; i++) d += hit(me, opp, Math.floor(attack * (sum(me, 'slash', table) + 64) * 1.15), defence * (sum(opp, 'dSlash', table) + 64), Math.floor(max * 1.15), 'melee', guard, tick);
                if (me === a) { attacksA.special++; damageA.special += d; }
            } else { const d = hit(me, opp, attackRoll, defence * (sum(opp, typeDefence, table) + 64), max, 'melee', guard, tick); if (me === a) { attacksA.melee++; damageA.melee += d; } }
            me.actionAt = tick + (table.get(me.worn.weapon)?.rate || 4);
        } else if (style === 'ranged') {
            const ranged = 99 + me.boost.ranged + 8;
            const d = hit(me, opp, ranged * (sum(me, 'ranged', table) + 64), defence * (sum(opp, 'dRanged', table) + 64), Math.floor((ranged * (sum(me, 'rangeStr', table) + 64) + 320) / 640), 'ranged', guard, tick + 1);
            if (me === a) { attacksA.ranged++; damageA.ranged += d; }
            me.actionAt = tick + Math.max(1, (table.get(me.worn.weapon)?.rate || 4) - 1);
        } else {
            const magicDefence = Math.floor((7 * 99 + 3 * effDefence(opp)) / 10) + 8;
            const d = hit(me, opp, (99 + 9) * (sum(me, 'magic', table) + 64), magicDefence * (sum(opp, 'dMagic', table) + 64), me.spellMax, 'magic', guard, tick + 2);
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
        a.shown = styleOf(a.worn.weapon); b.shown = styleOf(b.worn.weapon);
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

if (import.meta.main) {
    const argv = process.argv.slice(2);
    if (argv[0] === '--table') {
        const fights = Number(argv[1] ?? 2000);
        for (const kit of Object.keys(KITS)) console.log(`SIM ${JSON.stringify({ kit, against: 'tribrid', ...series(kit, 'tribrid', {}, {}, fights) })}`);
    } else {
        const [kitA, kitB, fights, optionsA, optionsB] = argv;
        if (!kitA || !kitB || !KITS[kitA] || !KITS[kitB]) { console.log(`usage: bun scripts/pk-sim.ts <kit a> <kit b> [fights] [options a] [options b]; kits: ${Object.keys(KITS).join(', ')}`); process.exit(2); }
        console.log(`SIM ${JSON.stringify({ a: kitA, b: kitB, ...series(kitA, kitB, optionsA ? JSON.parse(optionsA) : {}, optionsB ? JSON.parse(optionsB) : {}, Number(fights ?? 2000)) })}`);
    }
}
