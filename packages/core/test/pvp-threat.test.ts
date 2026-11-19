import { expect, test } from 'bun:test';
import { canProtect, classifyThreat, DEFAULT_ODDS, decideAdapt, fightOdds, threatLine, ThreatBook, type Member, type Sighting } from '../src/pvp-threat';
import type { CombatStyle } from '../src/opponent';

// Style by weapon id for the tests: 1 staff, 2 bow, 3 whip. Animation 10 casts, 11 shoots, 12 hits.
const weaponStyle = (id?: number): CombatStyle => id === 1 ? 'magic' : id === 2 ? 'ranged' : 'melee';
const attackStyle = (anim: number): CombatStyle | null => anim === 10 ? 'magic' : anim === 11 ? 'ranged' : anim === 12 ? 'melee' : null;
const book = (friends: string[] = []) => new ThreatBook({ friends: new Set(friends), weaponStyle, attackStyle, multiAt: (x, z) => x >= 3000 && z >= 3600, wildAt: (_x, z) => (z >= 3520 ? Math.floor((z - 3520) / 8) + 1 : 0) });
// The combat-level rule of the Wilderness, reduced: a player can attack within 20 levels.
const canAttack = (me: { combat: number }, them: { combatLevel: number }) => Math.abs(me.combat - them.combatLevel) <= 20;
const squad: Member[] = [{ name: 'Ours1', x: 3070, z: 3640, combat: 126 }, { name: 'Ours2', x: 3072, z: 3640, combat: 126 }];
const rival = (o: Partial<Sighting> = {}): Sighting => ({ name: 'Rival', combat: 120, x: 3075, z: 3650, inView: true, worn: { weapon: 1 }, ...o });
const outclasses = (_me: Member, them: { combat: number }) => them.combat >= 145;

test('the book gives one record for each player that is not ours or a friend, with the tile rules of the world', () => {
    const b = book(['friend']);
    const records = b.observe(1, squad, [rival(), rival({ name: 'Ours1' }), rival({ name: 'friend' })]);
    expect(records.map(r => r.name)).toEqual(['Rival']);
    expect(records[0]).toMatchObject({ combat: 120, wild: 17, multi: true, nearest: { member: 'Ours1', dist: 10 }, closing: false, weaponStyle: 'magic', targeting: null });
});

test('a player that gets closer to the nearest member is closing, with its speed in tiles for each tick', () => {
    const b = book();
    b.observe(10, squad, [rival({ x: 3082, z: 3650 })]);
    const [r] = b.observe(12, squad, [rival({ x: 3078, z: 3648 })]);
    expect(r!.closing).toBe(true);
    expect(r!.speed).toBe(1);
    const [away] = b.observe(13, squad, [rival({ x: 3084, z: 3650 })]);
    expect(away!.closing).toBe(false);
    expect(away!.speed).toBeLessThan(0);
});

test('an attack animation sets the style, two styles make a hybrid, and the memory ends', () => {
    const b = book();
    const look = (tick: number, anim: number) => classifyThreat(b.observe(tick, squad, [rival({ anim, worn: { weapon: 3 } })])[0]!, squad, { canAttack });
    expect(look(1, -1)).toMatchObject({ style: 'melee', by: 'weapon', cover: 'melee' });
    expect(look(2, 10)).toMatchObject({ style: 'magic', by: 'attack', cover: 'magic' });
    expect(look(3, 11)).toMatchObject({ style: 'hybrid', by: 'attack', cover: 'ranged' });
    // 60 ticks later with no attack: the memory (50) is over, so the weapon (a whip) tells again.
    expect(look(63, -1)).toMatchObject({ style: 'melee', by: 'weapon', cover: 'melee' });
});

test('a player on the feed only has no known style, and no cover', () => {
    const b = book();
    const c = classifyThreat(b.observe(1, squad, [rival({ inView: false, worn: undefined })])[0]!, squad, { canAttack });
    expect(c).toMatchObject({ style: 'unknown', by: 'none', cover: null });
});

test('dangerous: can attack a member and either fights one, or is in range and closing or very near', () => {
    const b = book();
    const far = classifyThreat(b.observe(1, squad, [rival({ x: 3100, z: 3700 })])[0]!, squad, { canAttack });
    expect(far.dangerous).toBe(false);
    const near = classifyThreat(b.observe(2, squad, [rival({ x: 3074, z: 3643 })])[0]!, squad, { canAttack });
    expect(near).toMatchObject({ dangerous: true, canHit: ['Ours1', 'Ours2'] });
    // Out of the combat-level range of both members: it cannot attack, however near.
    const low = classifyThreat(book().observe(1, squad, [rival({ combat: 40, x: 3074, z: 3643 })])[0]!, squad, { canAttack });
    expect(low).toMatchObject({ dangerous: false, canHit: [] });
    // Fighting a member counts at any range.
    const fighting = classifyThreat(book().observe(1, squad, [rival({ x: 3100, z: 3700, targeting: 'Ours2' })])[0]!, squad, { canAttack });
    expect(fighting.dangerous).toBe(true);
});

const classes = (sightings: Sighting[], tick = 1, b = book()) => b.observe(tick, squad, sightings).map(r => classifyThreat(r, squad, { canAttack }));
const near = (name: string, o: Partial<Sighting> = {}) => rival({ name, x: 3074, z: 3643, ...o });
// The four members of a live squad. A team of 3 does not outnumber them; 5 do.
const squad4: Member[] = [...squad, { name: 'Ours3', x: 3071, z: 3641, combat: 126 }, { name: 'Ours4', x: 3073, z: 3641, combat: 126 }];
const classes4 = (sightings: Sighting[], b = book()) => b.observe(1, squad4, sightings).map(r => classifyThreat(r, squad4, { canAttack }));
const attackers = (n: number) => Array.from({ length: n }, (_, i) => near(`Att${i}`, { x: 3074 + (i % 3), z: 3643 + Math.floor(i / 3) }));

test('a mage that closes in: protect from magic for each member that it can hit, and the armour swap for the member that has one', () => {
    const actions = decideAdapt(classes([near('Mage')]), squad, { outclasses, counterFor: (member, style) => member === 'Ours1' && style === 'magic' ? { wear: [1135, 1099], gain: 38 } : null });
    expect(actions.filter(a => a.kind === 'protect')).toEqual([
        { kind: 'protect', member: 'Ours1', style: 'magic', reason: 'Mage magic by weapon, 4 tiles' },
        { kind: 'protect', member: 'Ours2', style: 'magic', reason: 'Mage magic by weapon, 3 tiles' },
    ]);
    expect(actions.filter(a => a.kind === 'kit')).toEqual([{ kind: 'kit', member: 'Ours1', style: 'magic', wear: [1135, 1099], gain: 38, reason: 'Mage magic: wear 1135+1099 (+38)' }]);
    expect(actions.some(a => a.kind === 'retreat')).toBe(false);
});

test('the last attack decides the cover over the weapon', () => {
    const b = book();
    b.observe(1, squad, [near('Pure', { worn: { weapon: 3 } })]);
    const actions = decideAdapt(b.observe(2, squad, [near('Pure', { worn: { weapon: 3 }, anim: 11 })]).map(r => classifyThreat(r, squad, { canAttack })), squad, { outclasses });
    expect(actions[0]).toMatchObject({ kind: 'protect', member: 'Ours1', style: 'ranged' });
});

test('a player that outclasses the strongest member is a retreat, before any protect', () => {
    const actions = decideAdapt(classes([near('Boss', { combat: 145 })]), squad, { outclasses });
    expect(actions[0]).toEqual({ kind: 'retreat', reason: 'outclassed by Boss(145,magic) at 3 tiles' });
});

test('a team on a multi-way tile goes to a single-way tile when one is known, else retreats', () => {
    const team = classes4(attackers(3));
    const to = { x: 3040, z: 3600 };
    expect(decideAdapt(team, squad4, { outclasses, singleWayFrom: () => to })[0]).toMatchObject({ kind: 'single-way', to });
    const retreat = decideAdapt(team, squad4, { outclasses })[0]!;
    expect(retreat).toMatchObject({ kind: 'retreat' });
    expect((retreat as { reason: string }).reason).toContain('team of 3');
    // Two are not a team.
    expect(decideAdapt(team.slice(0, 2), squad4, { outclasses }).some(a => a.kind === 'retreat' || a.kind === 'single-way')).toBe(false);
});

test('a gang that the squad hunts on purpose is protected against but is not a reason to retreat', () => {
    const gang = classes4([near('A', { combat: 145 }), near('B', { x: 3075 }), near('C', { x: 3076 })]);
    const actions = decideAdapt(gang, squad4, { outclasses, expected: new Set(['a', 'b', 'c']) });
    expect(actions.some(a => a.kind === 'retreat' || a.kind === 'single-way')).toBe(false);
    expect(actions.filter(a => a.kind === 'protect')).toHaveLength(4);
    // One stranger among them is still a stranger: it outclasses.
    const mixed = classes([near('A'), near('Boss', { combat: 145 })]);
    expect(decideAdapt(mixed, squad, { outclasses, expected: new Set(['a']) })[0]).toMatchObject({ kind: 'retreat' });
});

test('a team on a single-way tile is held there: no single-way move and no retreat, protect only', () => {
    const team = classes4(attackers(3));
    const held = decideAdapt(team, squad4, { outclasses, multiAt: () => false, singleWayFrom: () => ({ x: 1, z: 1 }) });
    expect(held.some(a => a.kind === 'retreat' || a.kind === 'single-way')).toBe(false);
    expect(held.some(a => a.kind === 'protect')).toBe(true);
    const multi = decideAdapt(team, squad4, { outclasses, multiAt: () => true, singleWayFrom: () => ({ x: 1, z: 1 }) });
    expect(multi[0]).toMatchObject({ kind: 'single-way', to: { x: 1, z: 1 } });
});

// The policy of the attacker benches (research/gang-clones.md "The attackers"): a lone attacker is fought with the protect prayer, a team that
// outnumbers the squad is left (single-way ground does not help), and a team with no prayer points in the squad is left at once.
test('attackers at members + 1 or more are a retreat, also on single-way ground; one fewer is not', () => {
    const single = { outclasses, multiAt: () => false, singleWayFrom: () => ({ x: 1, z: 1 }) };
    const five = decideAdapt(classes4(attackers(5)), squad4, single)[0]!;
    expect(five).toMatchObject({ kind: 'retreat' });
    expect((five as { reason: string }).reason).toContain('outnumbered: 5 attackers against 4 members');
    expect(decideAdapt(classes4(attackers(4)), squad4, single).some(a => a.kind === 'retreat')).toBe(false);
    // On multi-way ground 5 is a retreat, not a single-way move: single-way ground does not help against 5.
    expect(decideAdapt(classes4(attackers(5)), squad4, { outclasses, multiAt: () => true, singleWayFrom: () => ({ x: 1, z: 1 }) })[0]).toMatchObject({ kind: 'retreat' });
    // A solo account meets three (a team), not two.
    const solo: Member[] = [squad[0]!];
    const closeBy = (n: number) => Array.from({ length: n }, (_, i) => near(`Solo${i}`, { x: 3071 + i, z: 3641 }));
    const soloClasses = (n: number) => book().observe(1, solo, closeBy(n)).map(r => classifyThreat(r, solo, { canAttack }));
    expect(decideAdapt(soloClasses(2), solo, { outclasses, multiAt: () => false }).some(a => a.kind === 'retreat')).toBe(false);
    expect(decideAdapt(soloClasses(3), solo, { outclasses, multiAt: () => false })[0]).toMatchObject({ kind: 'retreat' });
});

test('a team of 3 and no prayer points in the squad is a retreat at once, on single-way ground too; with prayer points left it is not', () => {
    const dry = squad4.map(m => ({ ...m, prayer: 0 }));
    const team = classes4(attackers(3));
    const single = { outclasses, multiAt: () => false };
    const retreat = decideAdapt(team, dry, single)[0]!;
    expect(retreat).toMatchObject({ kind: 'retreat' });
    expect((retreat as { reason: string }).reason).toContain('team of 3 that no member can protect against');
    // One member has prayer points, or the points are not known: not dry.
    expect(decideAdapt(team, [{ ...dry[0]!, prayer: 12 }, ...dry.slice(1)], single).some(a => a.kind === 'retreat')).toBe(false);
    expect(decideAdapt(team, squad4, single).some(a => a.kind === 'retreat')).toBe(false);
    // Two attackers are not a team, dry or not.
    expect(decideAdapt(classes4(attackers(2)), dry, single).some(a => a.kind === 'retreat')).toBe(false);
});

test('canProtect: the points and the Prayer level of the protect prayer that covers the style', () => {
    const m = (o: Partial<Member>): Member => ({ name: 'M', x: 0, z: 0, combat: 126, ...o });
    expect(canProtect(m({}), 'melee')).toBe(true);
    expect(canProtect(m({ prayer: 0, prayerLevel: 99 }), 'magic')).toBe(false);
    expect(canProtect(m({ prayer: 40, prayerLevel: 36 }), 'magic')).toBe(false);
    expect(canProtect(m({ prayer: 40, prayerLevel: 37 }), 'magic')).toBe(true);
    expect(canProtect(m({ prayer: 40, prayerLevel: 40 }), 'ranged')).toBe(true);
    expect(canProtect(m({ prayer: 40, prayerLevel: 40 }), 'melee')).toBe(false);
    expect(canProtect(m({ prayer: 40, prayerLevel: 43 }), 'melee')).toBe(true);
});

test('a team that no member can protect against is a retreat at once, by the protect prayer of each attacker style', () => {
    const at = (level: number) => squad4.map(m => ({ ...m, prayer: 50, prayerLevel: level }));
    const single = { outclasses, multiAt: () => false };
    const melee = classes4(attackers(3).map(s => ({ ...s, worn: { weapon: 3 } })));
    const mage = classes4(attackers(3));
    // Prayer 40: Magic (37) and Missiles (40) are open, Melee (43) is not.
    expect(decideAdapt(melee, at(40), single)[0]).toMatchObject({ kind: 'retreat' });
    expect((decideAdapt(melee, at(40), single)[0] as { reason: string }).reason).toContain('that no member can protect against');
    expect(decideAdapt(mage, at(40), single).some(a => a.kind === 'retreat')).toBe(false);
    // Prayer 43 covers all three; Prayer 30 covers none.
    expect(decideAdapt(melee, at(43), single).some(a => a.kind === 'retreat')).toBe(false);
    expect(decideAdapt(mage, at(30), single)[0]).toMatchObject({ kind: 'retreat' });
    // One member that can protect is enough, and a mixed team with one protectable attacker is not unprotected.
    expect(decideAdapt(melee, [...at(40).slice(1), { ...at(43)[0]! }], single).some(a => a.kind === 'retreat')).toBe(false);
    const mixed = classes4([near('A', { worn: { weapon: 3 } }), near('B', { x: 3075 }), near('C', { x: 3076, z: 3643 })]);
    expect(decideAdapt(mixed, at(40), single).some(a => a.kind === 'retreat')).toBe(false);
});

test('a lone attacker of any style is met with the protect prayer and no retreat, dry or not', () => {
    const dry = squad4.map(m => ({ ...m, prayer: 0 }));
    for (const members of [squad4, dry]) {
        const actions = decideAdapt(classes4([near('Mage')]), members, { outclasses, multiAt: () => false });
        expect(actions.some(a => a.kind === 'retreat')).toBe(false);
        expect(actions.filter(a => a.kind === 'protect')).toHaveLength(4);
    }
});

test('no danger, no action; the log line holds the record', () => {
    expect(decideAdapt(classes([rival({ x: 3100, z: 3700 })]), squad, { outclasses })).toEqual([]);
    const [c] = classes([near('Mage', { worn: { weapon: 1, torso: 577, legs: 1095, back: 1052 } })]);
    expect(threatLine(c!)).toBe('THREAT Mage combat=120 style=magic by=weapon wild=16 multi dist=3 to=Ours2 hits=Ours1+Ours2 weapon=1 torso=577 legs=1095 back=1052');
});

// Fight or flight by the win-chance estimate (fightOdds).
const fed = (n: number) => squad4.slice(0, n).map(m => ({ ...m, hp: 99, food: 10, prayer: 50, prayerLevel: 99 }));
const side = (n: number, combat = 126) => Array.from({ length: n }, () => ({ hp: 98 + 20 * DEFAULT_ODDS.theirFood, dps: combat }));
const ours = (n: number) => Array.from({ length: n }, () => ({ hp: 99 + 200, dps: 126 }));

test('fightOdds: four members beat three attackers and lose to five; single-way ground helps the squad; protection helps; no attackers is a win', () => {
    expect(fightOdds({ ours: ours(4), theirs: side(3), protectedShare: 1, singleWay: false })).toBeGreaterThan(1.5);
    const five = fightOdds({ ours: ours(4), theirs: side(5), protectedShare: 1, singleWay: false });
    expect(five).toBeLessThan(DEFAULT_ODDS.lose);
    expect(fightOdds({ ours: ours(4), theirs: side(5), protectedShare: 1, singleWay: true })).toBeGreaterThan(five);
    expect(fightOdds({ ours: ours(4), theirs: side(5), protectedShare: 0, singleWay: false })).toBeLessThan(five);
    expect(fightOdds({ ours: ours(4), theirs: [], protectedShare: 0, singleWay: false })).toBe(Infinity);
    expect(fightOdds({ ours: [], theirs: side(1), protectedShare: 0, singleWay: false })).toBe(0);
});

test('odds mode: fight a lone attacker and three attackers; against five leave, or go to a single-way tile when that makes the fight even or better', () => {
    const o = { outclasses, odds: DEFAULT_ODDS, multiAt: () => true };
    const members = fed(4);
    expect(decideAdapt(classes4([near('Mage')]), members, o).some(a => a.kind === 'retreat' || a.kind === 'single-way')).toBe(false);
    expect(decideAdapt(classes4(attackers(3)), members, o).some(a => a.kind === 'retreat' || a.kind === 'single-way')).toBe(false);
    const five = decideAdapt(classes4(attackers(5)), members, o)[0]!;
    expect(five).toMatchObject({ kind: 'retreat' });
    expect((five as { reason: string }).reason).toContain('lost fight: odds');
    const to = { x: 3040, z: 3600 };
    const moved = decideAdapt(classes4(attackers(5)), members, { ...o, singleWayFrom: () => to })[0]!;
    expect(moved).toMatchObject({ kind: 'single-way', to });
    expect((moved as { reason: string }).reason).toContain('on single-way ground');
    // On single-way ground the odds are those of single-way ground: the squad holds it and fights.
    expect(decideAdapt(classes4(attackers(5)), members, { ...o, multiAt: () => false }).some(a => a.kind === 'retreat' || a.kind === 'single-way')).toBe(false);
});

test('odds mode: a squad with no food and low Hitpoints leaves a fight that a fed squad takes; unprotected attackers are worse', () => {
    const o = { outclasses, odds: DEFAULT_ODDS, multiAt: () => false };
    const weak = squad4.map(m => ({ ...m, hp: 30, food: 0, prayer: 50, prayerLevel: 99 }));
    expect(decideAdapt(classes4(attackers(3)), weak, o)[0]).toMatchObject({ kind: 'retreat' });
    expect(decideAdapt(classes4(attackers(3)), fed(4), o).some(a => a.kind === 'retreat')).toBe(false);
    // Four attackers: protected the fed squad takes it; with Prayer 1 (no protection) it leaves.
    const bare = squad4.map(m => ({ ...m, hp: 99, food: 4, prayer: 1, prayerLevel: 1 }));
    const protectedSquad = squad4.map(m => ({ ...m, hp: 99, food: 4, prayer: 50, prayerLevel: 99 }));
    const four = classes4(attackers(4));
    expect(decideAdapt(four, protectedSquad, o).some(a => a.kind === 'retreat')).toBe(false);
    expect(decideAdapt(four, bare, o)[0]).toMatchObject({ kind: 'retreat' });
});

test('odds mode counts the squad targets too: a lost fight against the gang is left, and the outclass rule counts only for a solo account', () => {
    const o = { outclasses, odds: DEFAULT_ODDS, multiAt: () => false, expected: new Set(['att0', 'att1', 'att2', 'att3']) };
    const two = fed(2);
    expect(decideAdapt(classes4(attackers(4)), two, o)[0]).toMatchObject({ kind: 'retreat' });
    const withBoss = classes4([near('Boss', { combat: 145 }), ...attackers(2)]);
    const squadActions = decideAdapt(withBoss, fed(4), { ...o, expected: new Set(['att0', 'att1']) });
    expect(squadActions.some(a => a.kind === 'retreat')).toBe(false);
    const soloMember: Member[] = [{ ...squad[0]!, hp: 99, food: 10, prayer: 50, prayerLevel: 99 }];
    const solo = decideAdapt(book().observe(1, soloMember, [near('Boss', { combat: 145, x: 3072, z: 3641 })]).map(r => classifyThreat(r, soloMember, { canAttack })), soloMember, { outclasses, odds: DEFAULT_ODDS, multiAt: () => false })[0]!;
    expect((solo as { reason: string }).reason).toContain('outclassed by Boss');
});
