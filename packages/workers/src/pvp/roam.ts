// Wilderness PK hunt over the whole surface Wilderness.
// The world feed roster shows every player's tile and combat level, so the hunter picks the target it can reach
// first, runs to where that target will be (cutting it off on its way south), freezes it when it runs, and keeps
// attacking with the style the target does not protect against until the target dies, logs out or leaves.
//
// usage: bun scripts/pk-roam.ts <account> [MAX_MINUTES=20] [MAX_WILD=30] [EAT_AT=50] [FLEE_AT=30] [SPELL=AUTO]
//        [RANGED=bow-name-regex] [LOOT=1] [FREEZE=1] [LOOT_MIN=20000] [BANK_AT=30000]
//        [FRIENDS=name,name] (the accounts never to attack, in place of the owned and listed accounts; FRIENDS= is none)
// The account starts south of the Wilderness with its gear worn and food in its inventory.
// Stop files: .practice/stop-<account>, .practice/stop-pk-hunt (shared with scripts/pk-hunt.ts).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBot, settle } from '../../../core/src/bot';
import type { Session } from '../../../core/src/inprocess';
import { lootCapacity } from '../../../core/src/loot-policy';
import { sessionWalker, walkPath } from '../../../core/src/walk';
import { tradePartners } from '../../../core/src/tradeguard';
import { readOpponent, readOpponents } from '../../../core/src/opponent';
import { componentId } from '../../../core/src/logout';
import { assessZeroRiskKit, bestFood, castableFreeze, dangerReason, defaultSpec, estMaxHit, fightPlayer, freezeSpell, getObjNames, isMulti, itemCostOf, observePlayer, packGain, postLootBankDue, recordKillLoot } from './fight';
import { armourDefence } from './pk-read';
import { PROFILES } from './pk-spar';
import { KitSwapper, protectOf, retreatOf, ThreatWatch } from './pk-threat';
import { REPO_ROOT } from './types';
import {
    accountServer, bankTrip, bestDamageSpell, canAttack, canCastCharge, cheb, clearScoutIntel, connectRadar, escapeStep,
    hasVarrockTeleport, intercept, itemCost, kitFrom, lootAt, makeValuer, MIN_ESCAPE_TILES, multiPileThreat, outclasses,
    pickTrack, planWildernessEscape, preyScore, publishScoutIntel, Radar, readScoutIntel, sectorStart, slashWebThrough,
    spellId, sweep, wearGlory, wildLevel,
    type Cfg, type Claims, type Track,
} from './wild-rules';
export * from './wild-rules';
export { castableFreeze, freezeSpell };


export async function huntOnce(session: Session, cfg: Cfg, stopped: () => boolean, emit: (e: object) => void, server = accountServer(session.name)) {
    const { sdk, bot } = session;
    const me = () => { const p = sdk.getState()?.player; return p && { x: p.worldX, z: p.worldZ, level: p.level, combat: p.combatLevel, hp: p.hp, maxHp: p.maxHp }; };
    const friends = new Set([...(cfg.friends ?? tradePartners(server))].map(n => n.toLowerCase()));
    friends.add(session.name.toLowerCase());
    const route = sweep(cfg.maxWild);
    let leg = -1;
    const radar = new Radar();
    const closeRadar = connectRadar(server, radar);
    const radarKit = cfg.threat ? { ThreatWatch, KitSwapper, protectOf, retreatOf } : null;
    const threats = radarKit ? new radarKit.ThreatWatch({ sessions: () => [session], server, friends, radar, log: line => emit({ e: 'threat', line }), act: cfg.threatAct !== false }) : null;
    const swapper = radarKit ? new radarKit.KitSwapper() : null;
    const end = Date.now() + cfg.maxMs;
    const tickEnd = cfg.maxTicks ? session.tick() + cfg.maxTicks : Infinity;
    const going = () => Date.now() < end && session.tick() < tickEnd;
    const food = () => sdk.getInventory().filter(i => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text)));
    const magic = sdk.getSkill('Magic')?.baseLevel ?? 1;
    const freezeNow = () => cfg.freeze ? castableFreeze(magic, sdk.getInventory()) : null;
    const freeze = freezeNow();
    const stats = { attacks: 0, kills: 0, deaths: 0, eats: 0, freezes: 0, chases: 0, loot: [] as string[], lootValue: 0, banked: 0, escapes: 0, targets: [] as string[] };
    const walker = await sessionWalker(session);
    const skip = new Set<string>();
    const tracks = (): Track[] => {
        const seen = new Map(readOpponents(session.client).map(o => [o.name.toLowerCase(), o]));
        const all = new Map(radar.fresh() ? radar.tracks : []);
        for (const p of sdk.getState()?.nearbyPlayers ?? []) {
            const key = p.name.toLowerCase(), old = all.get(key);
            const o = seen.get(key);
            const fighting = p.inCombat && (p.combatTargetType === 'npc' || p.combatTargetType === 'player') ? p.combatTargetType : undefined;
            all.set(key, { name: p.name, x: p.x, z: p.z, combatLevel: p.combatLevel, vx: old?.vx ?? 0, vz: old?.vz ?? 0, fighting,
                skulled: o?.skulled, protect: o?.protect, hpFrac: o?.hp ? o.hp.current / o.hp.max : undefined, weapon: o?.worn.rhand });
        }
        return [...all.values()];
    };
    const claimsFile = join(REPO_ROOT, '.practice', 'pk-roam', 'claims.json');
    const readClaims = (): Claims => {
        try { return new Map(Object.entries(JSON.parse(readFileSync(claimsFile, 'utf8')))) as Claims; } catch { return new Map(); }
    };
    // Other hunter processes share the file: a write goes through a temporary file and a rename, so a reader never
    // sees a part-written file and reads every other hunter's claim. (A damaged file still reads as no claims, so the
    // next write replaces it.)
    const writeClaims = (edit: (c: Claims) => void) => {
        const tmp = `${claimsFile}.${process.pid}.tmp`;
        try {
            const c = readClaims(); edit(c);
            mkdirSync(join(claimsFile, '..'), { recursive: true });
            writeFileSync(tmp, JSON.stringify(Object.fromEntries(c)));
            renameSync(tmp, claimsFile);
        } catch {
            /* claims are a courtesy between our hunters */
            try { rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
        }
    };
    const myName = session.name.toLowerCase();
    const myWeaponValue = () => Math.max(0, ...[...(kit.melee ?? []), ...(kit.ranged ?? []), ...(kit.magic ?? [])].map(id => itemCost(id)));
    const intelFile = join(REPO_ROOT, '.practice', 'pk-roam', 'intel.json');
    const shareIntel = (t: Pick<Track, 'name' | 'x' | 'z' | 'combatLevel' | 'hpFrac' | 'skulled'>) => {
        const wild = wildLevel(t.x, t.z);
        if (wild > 0) publishScoutIntel({
            target: t.name, x: t.x, z: t.z, combatLevel: t.combatLevel,
            hpFrac: t.hpFrac, skulled: t.skulled, multi: isMulti(t.x, t.z),
            wild, scout: myName, at: Date.now(),
        }, intelFile);
    };
    const claim = (target: string) => writeClaims(c => c.set(target.toLowerCase(), { hunter: myName, at: Date.now() }));
    const release = (target: string) => {
        writeClaims(c => { if (c.get(target.toLowerCase())?.hunter === myName) c.delete(target.toLowerCase()); });
        clearScoutIntel(target, intelFile);
    };
    const pickNow = (m: { x: number; z: number; combat: number }) =>
        pickTrack({ ...m, name: myName, weaponValue: myWeaponValue() }, tracks(), friends, cfg.maxWild, skip, MIN_ESCAPE_TILES, readClaims(), Date.now());
    let wentIn = false;
    let spun = -1;
    // The fight kit is read once, as staged: the worn weapon and shield, a bow and a staff carried.
    const kit = kitFrom(sdk.getEquipment(), sdk.getInventory(), cfg.ranged);
    emit({ e: 'kit', kit });
    // Loot and banking: everything staged at the start is kit; anything else carried is loot.
    // The kit is the pack's count of each item at the start: loot often is the same items (a maxed target drops rune
    // arrows, a staff, rune armour, a dagger, a glory and runes), so an id kept as kit left all of it in the pack
    // and each bank trip deposited nothing (extra:roam-field, finding 70). An item counts in any dose or charge (a
    // drunk Prayer potion(2) or a rubbed glory is still kit): the key is its name without the "(n)".
    const GLORY = /^amulet of glory\([1-4]\)$/i;
    const kitKey = (i: { id: number; name: string }) => i.name.replace(/\(\d\)$/, '').toLowerCase();
    const startPack = new Map<string, number>();
    // Worn items count too: the fight loop's escape takes a worn glory off to rub it and leaves it in the pack.
    const addToPackMap = (map: Map<string, number>, rows: readonly { id: number; name: string; count: number }[]) => {
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!;
            const k = kitKey(row);
            map.set(k, (map.get(k) ?? 0) + row.count);
        }
    };
    addToPackMap(startPack, sdk.getInventory());
    addToPackMap(startPack, sdk.getEquipment());
    const extraLoot = () => {
        const now = new Map<string, number>();
        addToPackMap(now, sdk.getInventory());
        addToPackMap(now, sdk.getEquipment());
        for (const [k, n] of now) {
            if (n > (startPack.get(k) ?? 0)) return true;
        }
        return false;
    };
    const startFood = food()[0];
    const foodCount = startFood ? sdk.getInventory().filter(i => i.id === startFood.id).length : 0;
    const valuer = makeValuer(server);
    // 20,000 gp a stack: in extra:roam-field (seeds 1 to 8) it kept about 97% of the loot value of 1,000 and gave 24
    // kills of 32 against 21; the cheap stacks (sharks, runes) cost the ticks of a kill.
    const lootMin = cfg.lootMin ?? 20_000, bankAt = cfg.bankAt ?? 30_000;
    let carried = 0;
    const loot = async (at: { x: number; z: number }) => { carried += await lootAt(session, at, { value: valuer, min: lootMin, stats, emit }); };
    // A full pack sends the hunt to the bank only with loot to put there: the fight kit itself (18 sharks, runes,
    // potions, the bow) leaves 2 slots or fewer, and each chase then ended in a 156-tick walk to the bank and back
    // with nothing deposited (extra:army-route-spear-pair-x5, finding 68).
    const needBank = () => carried >= bankAt || (carried > 0 && 28 - sdk.getInventory().length <= 2);
    const bank = async (why: string) => {
        emit({ e: 'bank-trip', why, carried });
        const ok = await bankTrip(session, walker, startPack, kitKey, startFood?.id, foodCount, stopped, emit);
        if (ok) { stats.banked += carried; carried = 0; }
        return ok;
    };

    // Damage taken from players, for the danger checks between fights (the fight loop keeps its own).
    const hits: { tick: number; damage: number; src: number }[] = [];
    let seenHit = 0;
    const recordHits = () => {
        let maxHit = seenHit;
        for (const e of sdk.getState()?.combatEvents ?? []) {
            const id = e.observationId ?? e.tick;
            if (id <= seenHit) continue;
            if (id > maxHit) maxHit = id;
            if (e.type === 'damage_taken' && e.sourceType === 'other_player') hits.push({ tick: session.tick(), damage: e.damage, src: e.sourceIndex });
        }
        seenHit = maxHit;
    };
    const canTeleport = () => hasVarrockTeleport(sdk.getSkill('Magic')?.level ?? 1, sdk.getInventory(), sdk.getEquipment());
    // Leave the Wilderness: glory, else teleport, else run south (eating) until one works. Ends the hunt.
    const escape = async (why: string) => {
        stats.escapes++;
        emit({ e: 'escape', why, hp: me()?.hp, wild: me() ? wildLevel(me()!.x, me()!.z) : 0 });
        // A stop request does not end the escape: live, a stop file froze Mightyrod at level 36 and it died.
        let blocked = 0, removeTries = 0;
        for (let step = 0; step < 120; step++) {
            const m = me();
            if (!m) { await sdk.waitForTicks(1); continue; }
            if (m.hp * 100 <= m.maxHp * cfg.eatAt) { const meal = bestFood(sdk.getInventory() as any); if (meal) await bot.eatFood(meal as any); }
            const glory = sdk.getInventory().find(i => GLORY.test(i.name));
            const worn = sdk.getEquipment().find(i => GLORY.test(i.name));
            const how = escapeStep(wildLevel(m.x, m.z), { glory: !!glory || (!!worn && removeTries < 3), teleport: canTeleport() });
            if (how === 'out') { emit({ e: 'escaped', at: [m.x, m.z], hp: m.hp }); return true; }
            // The game rubs a glory only from the pack (amulet_of_glory.rs2 has no worn option): a worn one comes off
            // first, into a free slot (a full pack eats a food for one). Without this a roam with its glory worn
            // walked out, and a blocked walk stood 908 ticks at level 14. Three tries, then the walk.
            if (how === 'glory' && !glory) {
                const meal = sdk.getInventory().length >= 28 ? bestFood(sdk.getInventory() as any) : undefined;
                if (meal) await bot.eatFood(meal as any);
                else { removeTries++; await sdk.sendUseEquipmentItem?.(worn!.slot, 1); }
                await sdk.waitForTicks(1); continue;
            }
            if (how === 'glory') {
                const op = glory!.optionsWithIndex?.find((o: any) => /^rub$/i.test(o.text));
                await sdk.sendUseItem(glory!.slot, op?.opIndex ?? 4);
                for (let i = 0; i < 6 && !sdk.getDialog()?.isOpen; i++) await sdk.waitForTicks(1);
                await sdk.clickDialogByText(/^Edgeville/i);
                await sdk.waitForTicks(6);
                // A glory that came off to be rubbed goes back on: left in the pack, the rubbed one (a new item id)
                // read as loot and the next bank trip deposited it.
                if (removeTries > 0) await wearGlory(session);
            } else if (how === 'teleport') {
                await sdk.sendClickComponent(componentId('magic:varrock_teleport'));
                await sdk.waitForTicks(6);
            } else {
                const plan = planWildernessEscape(m, { glory: !!glory || (!!worn && removeTries < 3), teleport: canTeleport() });
                const findLoc = (loc: { id: number; x: number; z: number }) => sdk.getState()?.nearbyLocs.find(l => l.id === loc.id && Math.max(Math.abs(l.x - loc.x), Math.abs(l.z - loc.z)) <= 2)
                    ?? sdk.getState()?.nearbyLocs.find(l => l.id === loc.id);
                if ((plan.kind === 'lever' || plan.kind === 'ladder') && plan.loc) {
                    if (plan.web && cheb(m, plan.web) <= 3) await slashWebThrough(session, plan.web, () => false);
                    await walkPath(walker, [{ x: plan.loc.x, z: plan.loc.z, tol: 2 }], { maxTicks: 16, idleMs: 9000 });
                    const exitLoc = findLoc(plan.loc);
                    if (exitLoc && typeof bot.interactLoc === 'function') {
                        await bot.interactLoc(exitLoc, plan.loc.option).catch(() => {});
                        await sdk.waitForTicks(4);
                        continue;
                    }
                }
                if (plan.obstacle && cheb(m, plan.obstacle) <= 3) {
                    if (plan.obstacle.kind === 'web') await slashWebThrough(session, plan.obstacle, () => false);
                    else {
                        const obstacleLoc = findLoc(plan.obstacle);
                        if (obstacleLoc && typeof bot.interactLoc === 'function') await bot.interactLoc(obstacleLoc, plan.obstacle.option).catch(() => {});
                    }
                }
                // A walk that moved us nowhere goes 10 tiles to the side, east and west in turn, before south again.
                const side = blocked ? (blocked % 2 ? 10 : -10) : 0;
                await walkPath(walker, [{ x: m.x + side, z: Math.max(3510, m.z - (side ? 4 : 20)), tol: 2 }], { maxTicks: 12, idleMs: 9000 });
                const n = me();
                blocked = n && n.x === m.x && n.z === m.z ? blocked + 1 : 0;
            }
        }
        return false;
    };
    const survive = async (): Promise<'ok' | 'flee' | 'dead'> => {
        const m = me();
        if (!m) return 'ok';
        recordHits();
        if (wildLevel(m.x, m.z) > 0) wentIn = true;
        if (wentIn && cheb(m, { x: 3222, z: 3218 }) <= 6) { stats.deaths++; emit({ e: 'death' }); return 'dead'; }
        const attackers = (sdk.getState()?.nearbyPlayers ?? []).filter(p => hits.some(h => h.src === p.index && session.tick() - h.tick <= 10));
        const oppMax = estMaxHit(Math.max(m.combat, ...attackers.map(p => p.combatLevel)));
        if (m.hp <= Math.max(m.maxHp * cfg.eatAt / 100, oppMax + 8) && food().length) {
            const r = await bot.eatFood(bestFood(sdk.getInventory() as any) as any ?? food()[0]);
            stats.eats++; emit({ e: 'eat', hp: m.hp, ok: r.success });
        }
        const danger = wildLevel(m.x, m.z) > 0 ? dangerReason({ hp: m.hp, maxHp: m.maxHp, food: food().length > 0, prayer: sdk.getState()?.prayers?.prayerPoints ?? 1,
            // No race here: this check does not see the damage dealt, so every fight's hits read as a lost race
            // (dealt 0) and ended the hunt after its first timeout (finding 63). The fight loop runs the race itself.
            oppMax, hits, dealt: [], now: session.tick(), race: process.env.ROAM_RACE === '1', noFoodAt: cfg.fight?.noFoodAt }) : null;
        if (danger) { await escape(danger); return 'flee'; }
        if (wildLevel(m.x, m.z) > 0) {
            const seen = new Map(readOpponents(session.client).map(o => [o.name.toLowerCase(), o]));
            const threat = (sdk.getState()?.nearbyPlayers ?? []).find(p => !friends.has(p.name.toLowerCase()) && p.distance <= 12 && outclasses(
                { combat: m.combat, weaponValue: myWeaponValue() }, { combatLevel: p.combatLevel, weapon: seen.get(p.name.toLowerCase())?.worn.rhand }));
            if (threat) { await escape(`threat: ${threat.name} (combat ${threat.combatLevel}) at ${threat.distance} tiles`); return 'flee'; }
            const pile = multiPileThreat(m, sdk.getState()?.nearbyPlayers ?? [], friends);
            if (pile) { await escape(pile); return 'flee'; }
            // The threat radar: an escape that it decides, else the armour swap (it uses the tick).
            if (threats?.act && radarKit && swapper) {
                const radarNow = threats.step(session.tick()), why = radarKit.retreatOf(radarNow.actions);
                if (why) { threats.acted(session.tick()); await escape(`radar: ${why}`); return 'flee'; }
                if (await swapper.step(session, radarNow.actions, session.tick(), async () => { await sdk.waitForTicks(1); return true; }, line => emit({ e: 'threat', line }))) return 'ok';
            }
            if (wildLevel(m.x, m.z) > cfg.maxWild) { await escape(`deeper than the limit (${wildLevel(m.x, m.z)} > ${cfg.maxWild})`); return 'flee'; }
        }
        return 'ok';
    };

    // Fight one target until it dies, logs out, leaves the Wilderness, or the chase stalls.
    // The feed shows no armour, so the first pick is by reach. Once the target is in view, the chase moves, before its
    // first fight, to an idle player in view whose melee armour is at least ROAM_SOFTER (40) stab defence lower
    // (research/pvp-fight-loop.md finding 62). ROAM_SWITCH=0 keeps the first pick.
    const switchOn = process.env.ROAM_SWITCH !== '0', softer = Number(process.env.ROAM_SOFTER ?? 40);
    // cfg.specAll: every special goes at any health and with no reserve (the army leader's LEADER_SPEC=all).
    const specAll = <T extends { below: number } | undefined>(spec: T): T => (cfg.specAll && spec ? { ...spec, below: 1 } : spec);
    const stabOf = (index: number) => { const o = observePlayer(session.client, index); return o ? armourDefence(o.worn.map(id => getObjNames().get(id) ?? '')).melee : null; };
    let chasing = '';
    const chase = async (first: string): Promise<'kill' | 'gone' | 'left' | 'stall' | 'flee' | 'dead' | 'stop'> => {
        let name = chasing = first, fought = false;
        stats.chases++;
        let lastTile: { x: number; z: number } | null = null, lastDist = Infinity, contactAt = session.tick();
        let held = false, freezeReady = 0, lastSeenAt: { x: number; z: number } | null = null;
        while (!stopped() && going()) {
            // A pass that used no game tick waits one, so the client and other sessions keep running.
            if (session.tick() === spun) await sdk.waitForTicks(1);
            spun = session.tick();
            const s = await survive();
            if (s !== 'ok') return s;
            const m = me()!;
            const near = sdk.getState()?.nearbyPlayers.find(p => p.name.toLowerCase() === name.toLowerCase());
            const track = radar.tracks.get(name.toLowerCase());
            const opp = near ? readOpponent(session.client, name) : null;
            if (session.tick() % 10 === 0) {
                claim(name);
                if (near) shareIntel({ name, x: near.x, z: near.z, combatLevel: near.combatLevel, hpFrac: opp?.hp?.fresh ? opp.hp.current / Math.max(1, opp.hp.max) : undefined, skulled: opp?.skulled });
                else if (track) shareIntel(track);
            }
            if (opp?.hp?.fresh && opp.hp.current === 0) {
                stats.kills++; emit({ e: 'kill', target: name, at: lastTile });
                await sdk.waitForTicks(4);
                if (cfg.loot && lastTile) await loot(lastTile);
                return 'kill';
            }
            if (!near && radar.fresh() && !track) { emit({ e: 'gone', target: name, at: lastTile }); if (cfg.loot && lastTile && cheb(m, lastTile) <= 3) await loot(lastTile); return 'gone'; }
            const pos = near ?? track;
            if (!pos) {
                // No radar and out of view: give up after 60 ticks.
                if (session.tick() - contactAt > 60) { emit({ e: 'gone', target: name, at: lastTile }); return 'gone'; }
                await sdk.waitForTicks(1); continue;
            }
            if (wildLevel(pos.x, pos.z) === 0) { emit({ e: 'left', target: name }); return 'left'; }
            // Never follow a target past the depth limit: live, a chase took Mightyrod from level 5 to 36, past the
            // reach of its teleport (20), and it died there.
            if (wildLevel(pos.x, pos.z) > cfg.maxWild || wildLevel(m.x, m.z) > cfg.maxWild) { emit({ e: 'too-deep', target: name, wild: wildLevel(m.x, m.z) }); return 'left'; }
            lastTile = { x: pos.x, z: pos.z };

            if (near && near.distance <= 15 && switchOn && !fought) {
                const mine = stabOf(near.index);
                const soft = mine === null ? undefined : (sdk.getState()?.nearbyPlayers ?? [])
                    .filter(p => p.index !== near.index && !friends.has(p.name.toLowerCase()) && !skip.has(p.name.toLowerCase()) && p.distance <= 15 && !p.inCombat && canAttack(m, p))
                    .map(p => ({ p, stab: stabOf(p.index) })).filter(x => x.stab !== null && x.stab + softer <= mine)
                    .sort((a, b) => a.stab! - b.stab! || a.p.distance - b.p.distance)[0];
                if (soft) {
                    emit({ e: 'switch', from: name, to: soft.p.name, stab: [mine, soft.stab] });
                    release(name); name = chasing = soft.p.name; claim(name); stats.targets.push(name);
                    lastDist = Infinity; held = false; lastSeenAt = null; continue;
                }
            }
            if (near && near.distance <= 15) {
                contactAt = session.tick();
                const fleeing = near.distance > lastDist && near.distance >= 2;
                lastDist = near.distance;
                // The SDK reports every freeze as a hit (the server grants the XP before the hit roll), so a held
                // target is one that stops moving: a move after a freeze means it splashed or ended.
                if (held && lastSeenAt && cheb(lastSeenAt, near) >= 1) { held = false; freezeReady = Math.max(freezeReady, session.tick() + 5); }
                lastSeenAt = { x: near.x, z: near.z };
                // Freeze first, at first reach, before the target can run; freeze again whenever it moves.
                const castable = freezeNow();
                if (cfg.hold?.()) {
                    const range = cfg.holdRange ?? 3;
                    if (near.distance > range && !cfg.pace?.()) await walkPath(walker, [{ x: near.x, z: near.z, tol: range }], { maxTicks: 2, idleMs: 9000, stop: stopped });
                    else await sdk.waitForTicks(1);
                    continue;
                }
                if (castable && !cfg.fight?.neverSkull && canAttack(m, near) && session.tick() >= freezeReady && !held) {
                    // A cast on an immune or held target gives no XP; the SDK then waits out its timeout, so keep it short:
                    // 2.4 s is 6 live ticks (400 ms). Live, 1 s (2.5 ticks) reported every Snare as unproved.
                    const r = await bot.castSpell(near as any, castable, 2400);
                    if (r.success) { held = true; stats.freezes++; lastSeenAt = { x: near.x, z: near.z }; }
                    freezeReady = session.tick() + 3;
                    emit({ e: 'freeze', target: name, spell: freeze, ok: r.success, msg: r.success ? undefined : r.message });
                    continue;
                }
                if (!canAttack(m, near)) {
                    // Out of level range here: step toward the target, which takes us deeper.
                    await walkPath(walker, [{ x: near.x, z: near.z, tol: 1 }], { maxTicks: 4, idleMs: 9000, stop: stopped });
                    continue;
                }
                // The tribrid fight itself: scripts/pk.ts fightPlayer (style off the overhead, gear switch per turn,
                // special, food, prayer, glory escape). It exits immediately if the target leaves range or the
                // Wilderness, exceeds maxWild, or a stop condition fires.
                stats.attacks++; fought = true;
                const damageSpell = cfg.spell.toUpperCase() === 'AUTO' ? bestDamageSpell(magic, sdk.getInventory(), sdk.getEquipment()) : spellId(cfg.spell);
                const fight = await fightPlayer(session, name, {
                    ...(threats?.act && radarKit ? { threatPrayer: () => radarKit.protectOf(threats.step(session.tick()).actions, session.name) } : {}),
                    // eatAt is a percentage here and an HP value in fightPlayer. Live, a 26 HP account given 50 ate a shark every
                    // 3 ticks at full HP.
                    kit, spec: specAll(defaultSpec(kit)), freeze: freezeNow() !== null ? 'flee' : false, predictPrayer: true, snapPrayer: true, eatAt: Math.ceil((me()?.maxHp ?? 99) * cfg.eatAt / 100), exitOnDanger: true,
                    escapeAt: Math.ceil((me()?.maxHp ?? 99) * cfg.fleeAt / 100), damageSpell, ...(canCastCharge(magic, sdk.getInventory(), damageSpell) ? { charge: true } : {}),
                    escapeOutnumbered: 2, allies: [...friends],
                    cap: 120, maxWild: cfg.maxWild, maxDistance: 15, ...cfg.fight, stop: () => stopped() || !going(),
                    log: line => emit({ e: "fight", line }),
                });
                emit({ e: "fight-end", target: name, outcome: fight.outcome, ticks: fight.ticks, dealt: fight.dealt, taken: fight.taken, eaten: fight.eaten });
                stats.eats += fight.eaten;
                stats.freezes += fight.freezes;
                if (fight.outcome === "kill") {
                    stats.kills++;
                    const at = fight.targetAt ?? lastTile;
                    await sdk.waitForTicks(4);
                    if (cfg.loot && at) {
                        const beforeEq = sdk.getEquipment();
                        const ownCore = new Set(assessZeroRiskKit([...beforeEq, ...sdk.getInventory()], { cost: itemCostOf, requireProtectItem: false }).kept3);
                        const pack = sdk.getInventory().map(i => ({ id: i.id, count: i.count }));
                        await loot(at);
                        const gained = packGain(pack, sdk.getInventory());
                        recordKillLoot(fight, gained);
                        if (Object.keys(gained).length > 0) {
                            const bankCheck = postLootBankDue([...sdk.getEquipment(), ...sdk.getInventory()], {
                                cost: itemCostOf,
                                nameOf: id => getObjNames().get(id),
                                protectItem: true,
                                ownCoreIds: ownCore,
                            });
                            if (bankCheck.bankNow) {
                                emit({ e: 'post-loot-bank', reason: bankCheck.reason });
                                await escape(`post-loot bank: ${bankCheck.reason}`);
                                return "flee";
                            }
                        }
                    }
                    return "kill";
                }
                if (fight.outcome === "died") { stats.deaths++; return "dead"; }
                if (fight.outcome === "escaped") return "flee";
                if (fight.outcome === "danger") {
                    // The fight loop's own escape first (ROAM_FLEE, default on): protect prayer off the attacker's style,
                    // food, glory or the teleport spell, else a run with freezes on a chaser; as the hunt does (finding 61).
                    if (process.env.ROAM_FLEE !== '0') {
                        stats.escapes++;
                        emit({ e: 'escape', why: fight.danger ?? 'danger', hp: me()?.hp, wild: me() ? wildLevel(me()!.x, me()!.z) : 0, flee: true });
                        const e = await fightPlayer(session, name, { kit, exitOnDanger: false, cap: 200, predictPrayer: true, snapPrayer: true, flee: true,
                            eatAt: Math.ceil((me()?.maxHp ?? 99) * cfg.eatAt / 100), maxDistance: 15,
                            escapeSpell: canTeleport() ? componentId('magic:varrock_teleport') : undefined, log: line => emit({ e: 'fight', line }) });
                        emit({ e: 'flee-end', outcome: e.outcome, hp: me()?.hp });
                        if (e.outcome === 'died') { stats.deaths++; return 'dead'; }
                        const m2 = me();
                        if (m2 && wildLevel(m2.x, m2.z) === 0) return 'flee';
                    }
                    await escape(fight.danger ?? "danger"); return "flee";
                }
                lastDist = Infinity;
                continue;
            }
            // Out of view: run to the cut-off tile, re-aimed on each new roster frame.
            if (session.tick() - contactAt > 400) { emit({ e: 'stall', target: name }); return 'stall'; }
            // A group's pace: while pace() is true (someone is behind) the chase waits a tick for it.
            if (cfg.pace?.()) { await sdk.waitForTicks(1); continue; }
            const aim = track ? intercept(m, track) : { ...pos, ticks: 0 };
            const frame = radar.tick;
            await walkPath(walker, [{ x: aim.x, z: aim.z, tol: 2 }], {
                maxTicks: 40, idleMs: 9000,
                stop: () => stopped() || radar.tick !== frame || !!cfg.pace?.() ||
                    !!sdk.getState()?.nearbyPlayers.some(p => p.name.toLowerCase() === name.toLowerCase() && p.distance <= 15),
            });
        }
        return 'stop';
    };

    try {
        while (!stopped() && going()) {
            // A pass that used no game tick waits one, so the client and other sessions keep running.
            if (session.tick() === spun) await sdk.waitForTicks(1);
            spun = session.tick();
            const s = await survive();
            if (s === 'dead') break;
            const m = me();
            if (!m) { await sdk.waitForTicks(1); continue; }
            if (s === 'flee') break;
            const pick = pickNow(m);
            if (!pick) {
                // Nobody attackable: sweep the Wilderness. Start at the nearest sweep tile, then go round.
                // Each hunter starts at its own point of the loop, so several hunters spread over the Wilderness.
                if (leg < 0) leg = sectorStart(session.name, route.length);
                else if (cheb(route[leg], m) <= 4) leg = (leg + 1) % route.length;
                const before = session.tick();
                const walk = await walkPath(walker, [{ ...route[leg], tol: 3 }], { maxTicks: 30, idleMs: 9000, stop: () => stopped() || !!pickNow(me()!) });
                // Never spin: a walk that used no tick (blocked or already there) moves to the next leg and waits.
                if (session.tick() === before) {
                    if (!walk.ok) emit({ e: 'sweep-blocked', leg: route[leg], at: [m.x, m.z], detail: walk.detail });
                    leg = (leg + 1) % route.length; await sdk.waitForTicks(1);
                }
                continue;
            }
            const name = pick.track.name;
            stats.targets.push(name);
            emit({ e: 'target', target: name, combat: pick.track.combatLevel, wild: wildLevel(pick.track.x, pick.track.z), meetIn: Math.round(pick.at.ticks), at: [pick.track.x, pick.track.z] });
            claim(name);
            shareIntel(pick.track);
            const outcome = await chase(name).finally(() => release(chasing));
            emit({ e: 'chase-end', target: chasing, outcome });
            if (outcome === 'dead' || outcome === 'stop') break;
            if (outcome === 'flee') break;
            if (outcome === 'stall' || outcome === 'left') skip.add(chasing.toLowerCase());
            if (needBank() && !(await bank(carried >= bankAt ? 'loot value' : 'pack full'))) break;
        }
        // Bank whatever loot is carried before logging out; with none, just leave the Wilderness.
        const m = me();
        if (m && stats.deaths === 0) {
            // Out of the Wilderness first, whatever ended the hunt (a stop request included).
            if (wildLevel(m.x, m.z) > 0) await escape(stopped() ? 'stop requested' : 'end of hunt');
            if (extraLoot()) await bank('end of hunt');
        }
    } finally { closeRadar(); }
    return stats;
}

const arg = (args: string[], key: string, d: string) => args.find(a => a.startsWith(key + '='))?.slice(key.length + 1) ?? d;

export async function runPkRoamCli(argv: readonly string[], existingSession?: Session): Promise<number> {
    const [name, ...args] = argv;
    if (!name) throw new Error('usage: bun scripts/pk-roam.ts <account> [MAX_MINUTES=20] [MAX_WILD=30] [EAT_AT=50] [FLEE_AT=30] [SPELL=AUTO] [RANGED=regex] [LOOT=1] [FREEZE=1] [LOOT_MIN=20000] [BANK_AT=30000] [MAX_TICKS=n] [FRIENDS=name,name]');
    const stop = () => existsSync('.practice/stop-' + name) || existsSync('.practice/stop-pk-hunt');
    if (stop()) throw new Error('PK stop file present');
    const ranged = arg(args, 'RANGED', '');
    const cfg: Cfg = {
        maxMs: Number(arg(args, 'MAX_MINUTES', '20')) * 60_000, maxWild: Number(arg(args, 'MAX_WILD', '30')),
        eatAt: Number(arg(args, 'EAT_AT', '50')), fleeAt: Number(arg(args, 'FLEE_AT', '30')),
        spell: arg(args, 'SPELL', 'AUTO'), ranged: ranged ? new RegExp(ranged, 'i') : undefined,
        loot: arg(args, 'LOOT', '1') === '1', freeze: arg(args, 'FREEZE', '1') === '1',
        ...(arg(args, 'THREAT', '0') === '1' ? { threat: true, threatAct: arg(args, 'THREAT_ACT', '1') !== '0' } : {}),
        lootMin: Number(arg(args, 'LOOT_MIN', '20000')), bankAt: Number(arg(args, 'BANK_AT', '30000')),
        ...(arg(args, 'MAX_TICKS', '') ? { maxTicks: Number(arg(args, 'MAX_TICKS', '')) } : {}),
        ...(args.some(a => a.startsWith('FRIENDS=')) ? { friends: arg(args, 'FRIENDS', '').split(',').filter(Boolean) } : {}),
    };
    const session = existingSession ?? (await openBot(name));
    const roamProfile = arg(args, 'ROAM_PROFILE', 'auto'), combat = session.sdk.getState()?.player?.combatLevel ?? 0;
    const chosen = roamProfile === 'auto' ? (combat >= 115 ? 'champion' : '') : roamProfile === 'none' ? '' : roamProfile;
    if (chosen) {
        const { specBelow: _below, ...profile } = PROFILES[chosen] ?? (() => { throw new Error(`unknown ROAM_PROFILE ${chosen}`); })();
        cfg.fight = { ...cfg.fight, ...profile };
    }
    const emit = (e: object) => console.log('PK_EVENT ' + JSON.stringify({ t: session.tick(), ...e }));
    let result: Awaited<ReturnType<typeof huntOnce>> | undefined, failure: string | undefined;
    try { result = await huntOnce(session, cfg, stop, emit); }
    catch (error) { failure = String(error); }
    const ok = !!result && !failure;
    if (existingSession) {
        console.log('PK_HUNT ' + JSON.stringify({ ok, failure, ...result }));
        return ok ? 0 : 1;
    }
    const loggedOut = await settle([session], ok, failure ?? `PK hunt: ${result!.kills} kills, ${result!.deaths} deaths, ${result!.attacks} attacks`);
    console.log('PK_HUNT ' + JSON.stringify({ ok, failure, ...result, loggedOut }));
    return ok && loggedOut ? 0 : 1;
}
