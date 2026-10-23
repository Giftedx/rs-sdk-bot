// Stun guests: bury bones or cast enchants inside each 8-tick pickpocket stun at the Ardougne knights.
// Usage: MODE=base|bury|enchant bun scripts/measure/stun-guest.ts <bot> [ticks=600]
// Presets: stun_base, stun_bury (22 dragon bones, Prayer 99), stun_enchant (Magic 99, water + cosmic, 20 sapphire rings).
//
// Code facts (rev 289, CODE-READ):
// - A failed pick runs p_delay(0) twice, then sets %action_delay and %stunned to map_clock + 8 and prints
//   "You've been stunned!" (skill_thieving/scripts/thieving.rs2:28-51). Nothing else blocks the player.
// - Bury: [opheld1,_bones], p_delay(0) (skill_prayer/scripts/bury_bone.rs2), so one bone every 2 ticks.
// - Enchant: [opheldt,magic:enchant_lvl1], p_delay(1) (skill_magic/scripts/spells/enchant.rs2:1-53), one cast every 3
//   ticks. Neither script reads %stunned or %action_delay.
// The bot clicks a knight every 2 ticks outside a stun (the goldfarm cadence). Inside a stun it eats if HP <= 4,
// else it sends a guest action when the action's delay ends before the stun does (bury: now + 1, enchant: now + 2).
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';

const [bot, tArg] = process.argv.slice(2);
const CAP = Number(tArg ?? 600);
const MODE = (process.env.MODE ?? 'base') as 'base' | 'bury' | 'enchant';
const KNIGHT = /^knight of ardougne$/i;
const ENCHANT_LVL1 = 1155; // vendor/rs-sdk/sdk/spells.ts
const s = await openBot(bot!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 3);
    const st = () => s.sdk.getState()!;
    const me = () => st().player!;
    console.log(`START ${me().worldX} ${me().worldZ} ${me().level}`);
    const inv = () => s.sdk.getInventory() ?? [];
    const slotOf = (re: RegExp) => inv().find((i: any) => re.test(i.name)) as any;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const xp = (k: string) => s.sdk.getSkillXp(k) ?? 0;
    const msgs: { text: string; at: number }[] = [];
    const seen = new Set<string>();
    s.onTick(() => {
        for (const m of (st().gameMessages ?? []) as any[]) {
            const k = `${m.observationId ?? ''}:${m.tick}:${m.text}`;
            if (seen.has(k)) continue;
            seen.add(k);
            msgs.push({ text: m.text, at: s.tick() });
        }
    });
    const skills = ['Thieving', 'Prayer', 'Magic'];
    const x0 = Object.fromEntries(skills.map(k => [k, xp(k)]));
    const t0 = s.tick();
    let stuns = 0, stunEnd = -1, nextGuest = -1, guests = 0, eats = 0, clicks = 0, lastClick = -99, msgIdx = msgs.length;
    let guestXpInStun = 0, guestStunTicks = 0, itemsOut = 0;
    const perStun: number[] = [];
    let guestThisStun = 0;
    let gx = xp('Prayer') + xp('Magic');
    await new Promise<void>(resolve => {
        const off = s.onTick(() => {
            const now = s.tick();
            if (now - t0 >= CAP || hp() <= 0) { off(); resolve(); return; }
            for (; msgIdx < msgs.length; msgIdx++) {
                if (/you've been stunned/i.test(msgs[msgIdx]!.text)) {
                    if (stunEnd > 0) perStun.push(guestThisStun);
                    stuns++; stunEnd = msgs[msgIdx]!.at + 8; nextGuest = msgs[msgIdx]!.at; guestThisStun = 0;
                }
            }
            const g = xp('Prayer') + xp('Magic');
            const inStun = now < stunEnd;
            if (inStun) { guestXpInStun += g - gx; guestStunTicks++; }
            gx = g;
            if (inStun) {
                if (hp() <= 4) {
                    const f = slotOf(/^lobster$/i);
                    if (f) { void s.direct({ type: 'useInventoryItem', slot: f.slot, optionIndex: 1, reason: 'SDK' }); eats++; nextGuest = now + 1; return; }
                }
                if (MODE === 'base' || now < nextGuest) return;
                if (MODE === 'bury' && now + 1 <= stunEnd) {
                    const b = slotOf(/bones$/i);
                    if (!b) { itemsOut++; return; }
                    const op = b.optionsWithIndex?.find((o: any) => /bury/i.test(o.text))?.opIndex ?? 1;
                    void s.direct({ type: 'useInventoryItem', slot: b.slot, optionIndex: op, reason: 'SDK' });
                    guests++; guestThisStun++; nextGuest = now + 2; return;
                }
                if (MODE === 'enchant' && now + 2 <= stunEnd) {
                    const r = slotOf(/^sapphire ring$/i);
                    if (!r) { itemsOut++; return; }
                    void s.direct({ type: 'spellOnItem', slot: r.slot, spellComponent: ENCHANT_LVL1, reason: 'SDK' });
                    guests++; guestThisStun++; nextGuest = now + 3; return;
                }
                return;
            }
            if (hp() <= 4) {
                const f = slotOf(/^lobster$/i);
                if (f) { void s.direct({ type: 'useInventoryItem', slot: f.slot, optionIndex: 1, reason: 'SDK' }); eats++; return; }
            }
            if (now - lastClick < 2) return;
            const p = me();
            const k = ((st().nearbyNpcs ?? []) as any[]).filter(n => KNIGHT.test(n.name) && Math.max(Math.abs(n.x - p.worldX), Math.abs(n.z - p.worldZ)) <= 10).sort((a, b) => a.distance - b.distance)[0];
            if (!k) return;
            const op = k.optionsWithIndex.find((o: any) => /pickpocket/i.test(o.text))?.opIndex;
            if (op === undefined) return;
            void s.direct({ type: 'interactNpc', npcIndex: k.index, optionIndex: op, reason: 'SDK' });
            clicks++; lastClick = now;
        });
        void s.ended.then(() => { off(); resolve(); });
    });
    if (stunEnd > 0) perStun.push(guestThisStun);
    const ticks = s.tick() - t0;
    const gn = Object.fromEntries(skills.map(k => [k, xp(k) - x0[k]!]));
    for (const k of skills) if (gn[k]) console.log(`RATE ${k.toLowerCase()} ${gn[k]} ${ticks}`);
    const stunTicks = stuns * 8;
    const guestXp = gn.Prayer! + gn.Magic!;
    await finish([s], gn.Thieving! > 0 && hp() > 0,
        `mode=${MODE} ticks=${ticks} thievXp=${gn.Thieving} thievXpPerTick=${(gn.Thieving! / ticks).toFixed(1)} stuns=${stuns} stunTicks=${stunTicks} ` +
        `guests=${guests} guestsPerStun=${(guests / Math.max(1, stuns)).toFixed(2)} prayerXp=${gn.Prayer} magicXp=${gn.Magic} guestXpPerStunTick=${(guestXp / Math.max(1, stunTicks)).toFixed(1)} ` +
        `guestXpInStunWindow=${guestXpInStun} perStun=${perStun.join(',')} itemsOut=${itemsOut} eats=${eats} clicks=${clicks} hp=${hp()} lobsters=${countItems(s, /^lobster$/i)} ` +
        `bones=${countItems(s, /bones$/i)} rings=${countItems(s, /^sapphire ring$/i)} recoil=${countItems(s, /ring of recoil/i)}`);
} catch (e) { await finish([s], false, String(e)); }
