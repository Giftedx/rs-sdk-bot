// Bench worker for the prayer guard (packages/core/src/prayer-guard.ts). It stands on its start tile for a number of
// ticks. Options make one condition for the guard each:
//   PRAYERS=9,10,11   the script turns these prayers on at the start, so the guard only keeps them free
//   FISH=fly:8        the script fishes with this method of scripts/microbot-b-fishing.ts until it has this many fish
//   CHOP=oak:6        the script chops this tree of TREES until it has this many logs
//   RETALIATE=off     the script turns auto-retaliate off at the start (button 151 of the controls tab)
//                     (also the environment variable GUARD_STAND_RETALIATE=off, for the bench's `--set`)
//   RIVAL=<account>   a second account logs in and attacks this one (both must stand in the Wilderness)
//   RIVAL_SPELL=magic:wind_strike   the second account casts this spell (a name of pack/interface.pack) each 5 ticks
//   The environment variable GUARD_STAND_FISH takes the place of FISH (for the bench's `--set`).
// Usage: bun scripts/measure/guard-stand.ts <bot> <ticks> [PRAYERS=..] [FISH=method:count] [CHOP=tree:count] [RETALIATE=off] [RIVAL=account]
import { finish, openBot } from '../../packages/core/src/bot';
import { componentId } from '../../packages/core/src/logout';
import type { Session } from '../../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';
import { FISH_PROFILES, pickFishSpot, type FishMethod } from '../microbot-b-fishing';

const [name, ticks = '300', ...rest] = process.argv.slice(2);
const option = (key: string) => rest.find(a => a.startsWith(key + '='))?.slice(key.length + 1);
if (!name || !Number.isSafeInteger(Number(ticks)) || Number(ticks) < 1) throw new Error('usage: guard-stand.ts <bot> <ticks> [PRAYERS=..] [FISH=method:count] [CHOP=tree:count] [RIVAL=account]');
// Loc and log ids (content pack/loc.pack, pack/obj.pack).
const TREES: Record<string, { locs: number[]; log: number }> = { tree: { locs: [1276, 1278], log: 1511 }, oak: { locs: [1281], log: 1521 }, willow: { locs: [1308], log: 1519 } };
const cap = Number(ticks);
const s = await openBot(name);
const sessions: Session[] = [s];
const state = () => s.sdk.getState();
const hitpoints = () => state()?.skills?.find((k: { name: string }) => k.name === 'Hitpoints')?.level ?? 0;
const points = () => state()?.prayers?.prayerPoints ?? 0;
const before = hitpoints(), pointsBefore = points(), start = s.tick();
const left = () => cap - (s.tick() - start);
// The prayers the state showed, with the number of ticks for each set.
const seen = new Map<string, number>();
// The ticks on which an NPC had this player as its target.
let targeted = 0;
const watch = s.onTick(() => { const slot = (s.client as any)?.selfSlot; if ((state()?.nearbyNpcs ?? []).some(n => n.targetIndex === 32768 + slot)) targeted++; const key = (state()?.prayers?.activePrayers ?? []).flatMap((on: boolean, i: number) => (on ? [i] : [])).join('+') || 'none'; seen.set(key, (seen.get(key) ?? 0) + 1); });
const parts: string[] = [];
if (process.env.GUARD_STAND_DEBUG) console.log('NPCS', (state()?.nearbyNpcs ?? []).map(n => `${n.name}@${n.x},${n.z} d=${n.distance} lvl=${n.combatLevel}`).join(' | '), 'COMBAT', state()?.player?.combatLevel);

for (const prayer of (option('PRAYERS') ?? '').split(',').filter(Boolean).map(Number)) {
    await s.sdk.sendTogglePrayer(prayer);
    if (!await waitUntil(s, () => !!state()?.prayers?.activePrayers[prayer], { timeoutTicks: 6 })) throw new Error(`prayer ${prayer} did not come on`);
}

if ((option('RETALIATE') ?? process.env.GUARD_STAND_RETALIATE) === 'off') {
    await s.direct({ type: 'clickComponent', componentId: 151, reason: 'bench condition' });
    if (!await waitUntil(s, () => state()?.autoRetaliateEnabled === false, { timeoutTicks: 8 })) throw new Error('auto-retaliate did not go off');
}

const rivalName = option('RIVAL');
if (rivalName) {
    const rival = await openBot(rivalName);
    sessions.push(rival);
    const spell = option('RIVAL_SPELL');
    let attacks = 0;
    while (left() > 0) {
        const target = rival.sdk.getState()?.nearbyPlayers.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (target && spell) { await rival.sdk.sendSpellOnPlayer(target.index, componentId(spell)); attacks++; }
        else if (target && rival.sdk.getState()?.player?.combat.targetType !== 'player') { await rival.sdk.sendInteractPlayer(target.index, 2); attacks++; }
        await waitTicks(s, Math.min(spell ? 5 : 8, left()));
    }
    parts.push(`rivalAttacks=${attacks}`);
}

const chop = option('CHOP');
if (chop) {
    const [kind = '', amount = '5'] = chop.split(':');
    const tree = TREES[kind];
    if (!tree) throw new Error(`unknown tree ${kind}`);
    const count = () => (state()?.inventory ?? []).filter(i => i.id === tree.log).reduce((n, i) => n + i.count, 0);
    const first = count();
    let clicks = 0;
    while (left() > 0 && count() - first < Number(amount)) {
        if (state()?.dialog?.isOpen) { await s.sdk.sendClickDialog(0); await waitTicks(s, 1); }
        const loc = (state()?.nearbyLocs ?? []).filter(l => tree.locs.includes(l.id) && l.optionsWithIndex.some(o => /^chop/i.test(o.text))).sort((a, b) => a.distance - b.distance)[0];
        if (!loc) { await waitTicks(s, 1); continue; }
        const had = count();
        await s.sdk.sendInteractLoc(loc.x, loc.z, loc.id, loc.optionsWithIndex.find(o => /^chop/i.test(o.text))!.opIndex);
        clicks++;
        // One click chops until the tree falls; the wait ends at a log so the loop can count it.
        await waitUntil(s, () => count() > had || left() <= 0 || !!state()?.dialog?.isOpen, { timeoutTicks: 40 });
    }
    parts.push(`logs=${count() - first} clicks=${clicks} chopTicks=${s.tick() - start}`);
    if (count() - first < Number(amount)) parts.push('short=1');
}

const fish = process.env.GUARD_STAND_FISH ?? option('FISH');
if (fish) {
    const [method, amount = '5'] = fish.split(':') as [FishMethod, string];
    const profile = FISH_PROFILES[method];
    if (!profile) throw new Error(`unknown fishing method ${method}`);
    const count = () => (state()?.inventory ?? []).filter(i => (profile.products as readonly number[]).includes(i.id)).reduce((n, i) => n + i.count, 0);
    const first = count();
    let clicks = 0;
    while (left() > 0 && count() - first < Number(amount)) {
        // A level-up message stops the fishing; the next click needs it closed.
        if (state()?.dialog?.isOpen) { await s.sdk.sendClickDialog(0); await waitTicks(s, 1); }
        const spot = state() ? pickFishSpot(state()!, method) : undefined;
        if (!spot) { await waitTicks(s, 1); continue; }
        const had = count();
        await s.sdk.sendInteractNpc(spot.index, profile.op);
        clicks++;
        // One click fishes until the spot moves; the wait ends at a catch so the loop can count it.
        await waitUntil(s, () => count() > had || left() <= 0 || !!state()?.dialog?.isOpen, { timeoutTicks: 40 });
    }
    parts.push(`caught=${count() - first} clicks=${clicks} fishTicks=${s.tick() - start}`);
    if (count() - first < Number(amount)) parts.push('short=1');
} else if (!rivalName && !chop) {
    await waitTicks(s, cap);
}

watch();
const after = hitpoints(), alive = !state()?.player?.isDead, short = parts.includes('short=1');
const sets = [...seen].sort((a, b) => b[1] - a[1]).map(([key, n]) => `${key}:${n}`).join(',');
console.log(`RESULT ${alive && !short ? 'ok' : 'fail'} ticks=${s.tick() - start} hp=${before}->${after} points=${pointsBefore}->${points()} prayers=${sets} targeted=${targeted} combat=${state()?.player?.combatLevel} ${parts.join(' ')}`);
await finish(sessions, alive && !short, 'stood');
