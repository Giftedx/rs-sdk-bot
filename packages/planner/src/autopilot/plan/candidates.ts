// Candidate template enumeration, gate miss tracking, and progressive army weapon/armour/ranged kit stages.
import {
    AMMO_MARKET, ARMOUR_MARKET, WEAPON_BAND, WEAPON_MARKET, bandLeft, norm, pairKey, placeOf, questDone, withFare,
    type Acct, type Template,
} from '../world';
import { AMMO_STAGE, KIT_BUY_SCRIPT, TRAIN_SHARE } from '../pricing';
import { FRAIL_FOOD_BUY, FRAIL_FOOD_BUY_ID, buildBand } from '../catalogue';
import { coinShort, frailShort, kitLacks, meets, withoutCoins } from './needs';
import { armourItemsFor, kitStyle, kitStylesOf, rangedStagesFor, weaponStageFor } from './kits';
import type { PlanState } from './context';

export function collectCandidates(s: PlanState): Set<string> {
    const { inp, byId, mine, squadNames, cands, cachedWayCost, finiteOrder, valueOf, makesCoins, admitted, fundable, lacksFare, miss, worth } = s;

    for (const a of mine) for (const listed of inp.templates) {
        if (listed.squadOnly && !inp.squad?.active && !(inp.specialists?.length ?? 0)) continue;
        if (squadNames.has(a.name.toLowerCase())) continue;
        const band = buildBand(listed, a, inp.builds?.get(a.name.toLowerCase()), inp.buildQuests?.get(a.name.toLowerCase()), inp.buildBefore?.get(a.name.toLowerCase()));
        if (!band) continue;
        if (inp.retired?.has(pairKey(a.name, band.id))) { miss(a, band, 'retired'); continue; }
        if (!admitted(band, a)) { miss(a, band, 'pilot'); continue; }
        // The reach rule (wayCost): no candidate for a place with no way from where the account stands. The ferry fare
        // of the way is a coin need of the job, so an account without the fare is funded as for any coin need.
        const finite = finiteOrder(band, a); if (!finite) { miss(a, band, 'demand'); continue; }
        const selected = inp.templateFor?.(finite, a) ?? finite;
        const place = placeOf(selected);
        // Surface combat and goldfarm workers only walk/route from ground level (level 0); upstairs accounts wait until recovered.
        if ((selected.script === 'scripts/gather-combat.ts' || selected.script === 'scripts/goldfarm.ts') && (place?.level ?? 0) === 0 && a.pos && a.pos.level !== 0) {
            miss(a, selected, 'reach');
            continue;
        }
        const fare = cachedWayCost(a.pos, place, inp.mountain?.(a) ?? true);
        if (fare === null) { miss(a, selected, 'reach'); continue; }
        const t = fare ? withFare(selected, fare) : selected;
        if (t.quest && t.tier !== 'goal') {
            const lacks = kitLacks(a, t.needs, i => !!inp.market?.[i]);
            if (questDone(a, t.quest.name)) continue;
            if (lacks === null || coinShort(a, t.needs) > 0) { miss(a, t, lacks === null ? 'needs' : 'coins'); continue; }
            const after: Acct = { ...a, quests: new Set([...(a.quests ?? []), norm(t.quest.name)]) }, before = cands.length;
            for (const u of t.quest.unlocks.map(id => byId.get(id)).filter((u): u is Template => !!u && admitted(u, a) && !inp.retired?.has(pairKey(a.name, u.id)))) {
                if (!meets(after, u.needs)) continue;
                const value = TRAIN_SHARE * valueOf(u, after);
                if (value > 0 || makesCoins(u, after)) cands.push({ account: a.name, template: t, value, resources: [...(t.resources ?? []), ...(u.resources ?? [])], reason: `completes ${t.quest.name} for ${u.id}`, supply: { template: u, account: after, share: TRAIN_SHARE }, ...(lacks.length ? { lacks } : {}) });
            }
            if (cands.length === before) miss(a, t, 'demand');
            continue;
        }
        if (t.tier === 'goal') {
            // One candidate per goal band whose target an army account has not met; never for anyone else. A band's
            // target is a skill level, or a quest: that one stands until the account's status lists the quest complete,
            // and an account whose status names no quests gets none.
            const left = bandLeft(t, a);
            if (left <= 0) continue;
            if (!inp.army?.has(a.name.toLowerCase())) { miss(a, t, kitLacks(a, t.needs) === null ? 'needs' : 'roster'); continue; }
            const goal = { band: t.band ?? 0, left }, reason = t.trains ? `army band ${goal.band}: ${t.trains.skill} to ${t.trains.to}` : t.quest ? `army band ${goal.band}: ${t.quest.name}` : `army band ${goal.band}: ${t.stock!.to} ${t.stock!.item}`;
            // Keep only a confirmed live instance of this exact band. A parked enabled job still needs its full kit
            // before a new start. kitLacks preserves the band's level, quest and under-target admission rules.
            if (inp.running?.has(a.name.toLowerCase()) && inp.current?.get(a.name.toLowerCase()) === t.id && kitLacks(a, t.needs) !== null) {
                cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal });
                continue;
            }
            if (fare && coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs))) lacksFare(a, t, fare);
            // Notes remain owned stock for acquisition, but the held-normal Prayer worker can bury only id526.
            // This gates a new execution; the active instance above and missing-kit acquisition below keep their rules.
            const usableNormalBones = t.script !== 'scripts/train-prayer.ts' || t.env?.BURY_HELD !== '1' || t.env?.BONE_ID !== undefined
                || (a.items['bone (unnoted)'] ?? 0) >= (t.needs?.items?.bones ?? 0);
            if (meets(a, t.needs) && usableNormalBones) cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal });
            else if (usableNormalBones && fundable(a) && coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs)))
                cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal, coins: coinShort(a, t.needs), fare });
            else {
                // Acquisition chooses the source, purchase batch and price after donor arbitration.
                const lacks = kitLacks(a, t.needs, i => !!inp.market?.[i]);
                if (lacks?.length) cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal, lacks, coins: coinShort(a, t.needs) });
                else miss(a, t, 'needs');
            }
            continue;
        }
        if (t.provides) {
            // A shop step for a maker. The item is the one input the maker lacks: every other need is met.
            const item = norm(t.provides.item), held: Acct = { ...a, items: { ...a.items, [item]: Math.max(1, a.items[item] ?? 0) } }, before = cands.length;
            if ((a.items[item] ?? 0) >= 1) continue;
            if (coinShort(a, t.needs) > 0 || !meets(a, withoutCoins(t.needs))) { miss(a, t, coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs)) ? 'coins' : 'needs'); continue; }
            for (const u of t.provides.unlocks.map(id => byId.get(id)).filter((u): u is Template => !!u && admitted(u, a) && !inp.retired?.has(pairKey(a.name, u.id)))) {
                if (!meets(held, u.needs)) continue;
                const value = TRAIN_SHARE * valueOf(u, held);
                if (value > 0) cands.push({ account: a.name, template: t, value, resources: [...(t.resources ?? []), ...(u.resources ?? [])], reason: `buys a ${t.provides.item} for ${u.id}`, supply: { template: u, account: held, share: TRAIN_SHARE } });
            }
            if (cands.length === before) miss(a, t, 'demand');
            continue;
        }
        if (t.trains) {
            if ((a.skills[t.trains.skill] ?? 1) >= t.trains.to) continue;
            if (!meets(a, t.needs)) { miss(a, t, 'needs'); continue; }
            const trained: Acct = { ...a, skills: { ...a.skills, [t.trains.skill]: t.trains.to } }, before = cands.length;
            for (const u of t.trains.unlocks.map(id => byId.get(id)).filter((u): u is Template => !!u && admitted(u, a) && !inp.retired?.has(pairKey(a.name, u.id)))) {
                // The frail rule counts what the account holds when the unlocked job starts, which is not known yet.
                if (!meets(a, { ...u.needs, frail: undefined }, t.trains)) continue;
                const value = TRAIN_SHARE * valueOf(u, trained);
                if (value > 0 || makesCoins(u, trained)) cands.push({ account: a.name, template: t, value, resources: [...(t.resources ?? []), ...(u.resources ?? [])], reason: `trains ${t.trains.skill} ${t.trains.to} for ${u.id}`, supply: { template: u, account: trained, share: TRAIN_SHARE } });
            }
            if (cands.length === before) miss(a, t, 'demand');
        } else if (meets(a, t.needs)) {
            const value = valueOf(t, a);
            if (value > 0 || makesCoins(t, a)) cands.push({ account: a.name, template: t, value, resources: t.resources ?? [], reason: t.yields(a).map(f => f.item).join('+'), supply: { template: t, account: a, share: 1 } });
            else miss(a, t, 'demand');
        } else if (coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs))) {
            const value = valueOf(t, a);
            if (value > 0 && fare) lacksFare(a, t, fare);
            if ((value > 0 || makesCoins(t, a)) && fundable(a)) cands.push({ account: a.name, template: t, value, resources: t.resources ?? [], reason: t.yields(a).map(f => f.item).join('+'), coins: coinShort(a, t.needs), fare, supply: { template: t, account: a, share: 1 } });
            else miss(a, t, value > 0 || makesCoins(t, a) ? 'coins' : 'demand');
        } else if (t.needs?.frail && frailShort(a, t.needs) > 0 && meets(a, { ...t.needs, frail: undefined })) {
            // Spare owned food precedes the existing full food purchase. Both
            // routes require finite coin demand and a free knight spot.
            const value = TRAIN_SHARE * valueOf(t, a), lacks = kitLacks(a, t.needs);
            if (lacks?.length && (value > 0 || makesCoins(t, a))) cands.push({ account: a.name,
                template: { ...t, id: FRAIL_FOOD_BUY_ID, batchFor: account => Object.fromEntries(t.needs!.frail!.of.map(item => [norm(item), (account.items[norm(item)] ?? 0) + FRAIL_FOOD_BUY])) },
                value, resources: t.resources ?? [], reason: `prepares food for ${t.family}`, lacks, supply: { template: t, account: a, share: TRAIN_SHARE } });
            else miss(a, t, 'demand');
        } else {
            const lacks = kitLacks(a, t.needs, i => !!inp.market?.[i]), value = valueOf(t, a);
            if (lacks?.length && value > 0) cands.push({ account: a.name, template: t, value, resources: t.resources ?? [], reason: `prepares ${t.goal}`, lacks, coins: coinShort(a, t.needs),
                supply: { template: t, account: a, share: 1 } });
            else miss(a, t, lacks === null ? 'needs' : 'demand');
        }
    }
    // Progressive weapon & armour kit buys precede combat bands. Owned stock can supply them without a market quote.
    for (const a of mine) {
        const lower = a.name.toLowerCase();
        if (!inp.army?.has(lower) || squadNames.has(lower)) continue;
        const bands = cands.filter(c => c.account === a.name && c.goal).sort((x, y) => x.goal!.band - y.goal!.band || x.goal!.left - y.goal!.left);
        const style = kitStyle(a, inp, bands), styles = kitStylesOf(style);
        const wStage = styles.melee ? weaponStageFor(a, inp) : null;
        if (wStage) {
            const template: Template = { id: wStage.id, item: wStage.item, attack: 30, goal: wStage.goal, family: 'kit-buy', script: KIT_BUY_SCRIPT, role: 'supply', yields: () => [], kitFirst: true, needs: { items: { [wStage.item]: 1 } } } as Template & { item: string; attack: number };
            cands.push({ account: a.name, template, value: 0, resources: [WEAPON_MARKET], reason: `army band ${WEAPON_BAND}: stages 1 ${wStage.item}`, goal: { band: WEAPON_BAND, left: 0 }, lacks: [{ of: [wStage.item], count: 1 }] });
        }
        if (style === 'ranged') for (const stage of rangedStagesFor(a, inp)) {
            const template: Template = { id: stage.id, goal: stage.goal, family: 'kit-buy', script: KIT_BUY_SCRIPT, role: 'supply', yields: () => [], kitFirst: true,
                needs: { items: Object.fromEntries(stage.items.map(i => [i.item, i.count])) } };
            cands.push({ account: a.name, template, value: 0, resources: [stage.id === AMMO_STAGE ? AMMO_MARKET : WEAPON_MARKET], reason: `army band ${WEAPON_BAND}: stages ${stage.items.map(i => `${i.count} ${i.item}`).join(', ')}`,
                goal: { band: WEAPON_BAND + (stage.id === AMMO_STAGE ? 0.01 : 0), left: 0 }, lacks: stage.items.map(i => ({ of: [i.item], count: i.count })) });
        }
        for (const arm of armourItemsFor(a, inp, styles)) {
            const needsItems = Object.fromEntries(arm.items.map(i => [i, 1]));
            const template: Template = { id: arm.id, goal: arm.goal, family: 'kit-buy', script: KIT_BUY_SCRIPT, role: 'supply', yields: () => [], kitFirst: true, needs: { items: needsItems } };
            cands.push({ account: a.name, template, value: 0, resources: [ARMOUR_MARKET], reason: `army band ${arm.band}: stages ${arm.items.join(', ')}`, goal: { band: arm.band, left: 0 }, lacks: arm.items.map(i => ({ of: [i], count: 1 })) });
        }
    }
    return new Set(cands.filter(c => !c.lacks && !c.coins && (c.goal || worth(c) > 0)).map(c => c.account));
}
