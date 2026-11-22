import { MODEL_FILES, find, findAll, param } from './content';
import { P_DELAY_SRC, pDelayTicks } from './rates';
import { doneFacts, facts, rowCol, rowColSrc, rowItems, tenths, withRolls } from './timing';
import type { Content, Facts, ModelInput, Roll, Timing } from './types';

function fishFacts(c: Content, fish: string | undefined): Facts {
    if (!fish) return facts({ gaps: ['catch item not resolved'] });
    const fs = param(c.obj(fish), 'fishing_struct');
    const s = fs ? c.struct(fs.value) : undefined;
    const xp = param(s, 'productexp'), lo = param(s, 'success_low'), hi = param(s, 'success_high');
    // The spot script that rolls this fish: its hidden-op label holds the roll delay and the equipment check.
    let best: { ticks: number; src: string[]; tool: string | null; bait: string | null } | null = null;
    for (const file of MODEL_FILES.fishingSpots) {
        const calls = findAll(c, file, new RegExp(`~fish_roll(?:_loc)?\\(([^)]*\\b${fish}\\b[^)]*)\\)`));
        for (const call of calls) {
            const ls = c.lines(file)!;
            let head = call.line - 1;
            while (head > 0 && !ls[head]!.startsWith('[')) head--;
            const name = /^\[[a-z_0-9]+,([^\]]+)\]/.exec(ls[head]!)?.[1];
            if (!name) continue;
            const d = find(c, file, /%action_delay = calc\(map_clock \+ (\d+)\)/, name);
            const eq = find(c, file, /check_fish_equipment\((\w+)\)/, name);
            if (!d) continue;
            const ticks = Number(d.m[1]) + 1;
            const args = call.m[1]!.split(',').map(x => x.trim());
            const bait = args.length >= 4 && args[3] !== 'null' ? args[3]! : null;
            if (!best || ticks < best.ticks) best = { ticks, src: [d.src, call.src], tool: eq?.m[1] ?? null, bait };
        }
    }
    // Spots that roll inline (big net, karambwan): stat_random, inv_add and stat_advance on nearby lines.
    let inline: { xp: number; xpSrc: string; low: number; high: number; rollSrc: string; ticks: number; src: string[]; basis: Timing['basis']; tool: string | null } | null = null;
    if (!fs) for (const file of MODEL_FILES.fishingSpots) {
        const ls = c.lines(file);
        if (!ls) continue;
        for (const add of findAll(c, file, new RegExp(`inv_add\\(inv, ${fish}, 1\\)`))) {
            const i = add.line - 1;
            let roll: RegExpExecArray | null = null, rollLine = -1, adv: RegExpExecArray | null = null, advLine = -1;
            for (let k = i; k >= Math.max(0, i - 3) && !roll; k--) { roll = /stat_random\(fishing, (\d+), (\d+)\)/.exec(ls[k]!); rollLine = k; }
            for (let k = i; k <= Math.min(ls.length - 1, i + 3) && !adv; k++) { adv = /stat_advance\(fishing, (\d+)\)/.exec(ls[k]!); advLine = k; }
            if (!roll || !adv) continue;
            let head = i;
            while (head > 0 && !ls[head]!.startsWith('[')) head--;
            const m = /^\[([a-z_0-9]+),([^\]]+)\]/.exec(ls[head]!);
            if (!m) continue;
            // The delay is in the block itself, or in the label that calls this proc.
            let host = m[2]!;
            if (m[1] === 'proc') {
                const caller = find(c, file, new RegExp(`~${host}\\b`));
                if (caller) {
                    let h = caller.line - 1;
                    while (h > 0 && !ls[h]!.startsWith('[')) h--;
                    host = /^\[[a-z_0-9]+,([^\]]+)\]/.exec(ls[h]!)?.[1] ?? host;
                }
            }
            const d = find(c, file, /%action_delay = calc\(map_clock \+ (\d+)\)/, host);
            const pd = findAll(c, file, /p_delay\((\d+)\)/, host).filter(h => h.line <= rollLine + 1);
            const eq = find(c, file, /check_fish_equipment\((\w+)\)/, host);
            const timing = d ? { ticks: Number(d.m[1]) + 1, src: [d.src], basis: 'roll' as const }
                : pd.length ? { ticks: pDelayTicks(pd.map(h => Number(h.m[1])), true), src: [...pd.map(h => h.src), P_DELAY_SRC], basis: 'roll' as const } : null;
            if (!timing) continue;
            const cand = { xp: Number(adv[1]) / 10, xpSrc: `${file}:${advLine + 1}`, low: Number(roll[1]), high: Number(roll[2]), rollSrc: `${file}:${rollLine + 1}`, ...timing, tool: eq?.m[1] ?? null };
            if (!inline || cand.ticks < inline.ticks) inline = cand;
        }
    }
    if (inline) return facts({
        xpPerAction: inline.xp, xpSrc: inline.xpSrc, tools: inline.tool ? [inline.tool] : [], outputs: [{ debugname: fish, count: 1 }],
        timing: {
            basis: 'roll', ticksPerTry: inline.ticks, note: `inline roll every ${inline.ticks} ticks. Other catches at the spot roll first or after; the model counts this catch alone.`,
            src: [...inline.src, inline.rollSrc],
            rolls: [{ tool: inline.tool, toolLevel: 1, rollTicks: inline.ticks, failTicks: 0, low: inline.low, high: inline.high, fixedChance: null, src: inline.rollSrc }],
        },
    });
    const gaps: string[] = [];
    if (!xp) gaps.push(`XP per action unknown: ${fish} has no fishing_struct param and no fishing spot script adds it (it comes from ${fish === 'raw_mantaray' || fish === 'raw_seaturtle' ? 'the Fishing Trawler reward, scripts/minigames/game_trawler/scripts/trawler_win.rs2' : 'a script outside skill_fishing'})`);
    if (!best) gaps.push(`ticks per action unknown: no fishing spot script rolls ${fish}`);
    return facts({
        xpPerAction: xp ? tenths(xp.value) : null, xpSrc: xp?.src ?? null, tools: best?.tool ? [best.tool] : [],
        inputs: best?.bait ? [{ debugname: best.bait, count: 1 }] : null, outputs: [{ debugname: fish, count: 1 }],
        timing: best && lo && hi ? {
            basis: 'roll', ticksPerTry: best.ticks, note: `a roll every ${best.ticks} ticks (the poll tick plus the action delay). The spot may roll a better fish first; the model counts this fish alone.`,
            src: best.src,
            rolls: [{ tool: best.tool, toolLevel: 1, rollTicks: best.ticks, failTicks: 0, low: Number(lo.value), high: Number(hi.value), fixedChance: null, src: lo.src }],
        } : null,
        gaps,
    });
}

/** Model facts for woodcutting, mining, and fishing rungs, or `null` for other kinds. */
export function gatheringFacts(c: Content, r: ModelInput): Facts | null {
    const row = r.row;
    switch (r.kind) {
    case 'woodcutting_trees': {
        // Kharazi jungle trees have their own oploc script with one roll for every axe.
        if (row?.data.tree?.some(t => /^kharazi_jungle_tree/.test(t[0]!))) {
            const d = find(c, MODEL_FILES.jungle, /%action_delay = calc\(map_clock \+ (\d+)\)/, 'chop_jungle');
            const roll = find(c, MODEL_FILES.jungle, /stat_random\(woodcutting, (\d+), (\d+)\)/, 'chop_jungle');
            if (!d || !roll) return doneFacts({}, `jungle roll not found in [label,chop_jungle] of ${MODEL_FILES.jungle}`);
            const rollTicks = Number(d.m[1]) + 1;
            return doneFacts({ outputs: rowItems(row, 'product', 1) }, {
                basis: 'roll', ticksPerTry: rollTicks, note: `a roll every ${rollTicks} ticks with any usable axe. Needs the Legends Quest Kharazi map ([label,start_chop_jungle]); a cut moves the player one tile.`,
                src: [d.src, roll.src], rolls: [{ tool: null, toolLevel: 1, rollTicks, failTicks: 0, low: Number(roll.m[1]), high: Number(roll.m[2]), fixedChance: null, src: roll.src }],
            });
        }
        const period = find(c, MODEL_FILES.woodcut, /%action_delay = calc\(map_clock \+ (\d+)\)/, 'cut_tree');
        if (!period) return doneFacts({}, `roll delay not found in [label,cut_tree] of ${MODEL_FILES.woodcut}`);
        const rollTicks = Number(period.m[1]) + 1;
        const rolls: Roll[] = (row?.data.successchance ?? []).map((v, i) => ({
            tool: v[0]!, toolLevel: Math.max(1, Number(param(c.obj(v[0]!), 'levelrequire')?.value ?? 1)), rollTicks, failTicks: 0,
            low: Number(v[1]), high: Number(v[2]), fixedChance: null, src: row!.src.successchance![i]!,
        }));
        const respawn = rowCol(row, 'respawnrate')?.[0];
        return doneFacts({ outputs: rowItems(row, 'product', 1), tools: rolls.map(x => x.tool!) },
            withRolls({ basis: 'roll', ticksPerTry: rollTicks, rolls: [], note: `a roll every ${rollTicks} ticks (the poll tick plus ${period.m[1]}).`, src: [period.src] }, rolls,
                `Success: stat_random with the best axe usable at the level. ${respawn === '0' ? 'Normal trees fall on the first log.' : 'A tree falls with chance 1/8 per log.'} The model assumes a ready tree.`));
    }
    case 'mining_table': {
        const period = find(c, MODEL_FILES.mining, /%action_delay = calc\(map_clock \+ \$mining_rate\)/);
        const chance = rowCol(row, 'rock_successchance');
        if (!period || !chance) return doneFacts({}, `mining roll delay or rock_successchance not found (${MODEL_FILES.mining}, ${r.id})`);
        const rolls: Roll[] = [];
        for (const pick of ['bronze_pickaxe', 'iron_pickaxe', 'steel_pickaxe', 'mithril_pickaxe', 'adamant_pickaxe', 'rune_pickaxe']) {
            const rate = param(c.obj(pick), 'mining_rate'), lvl = param(c.obj(pick), 'levelrequire');
            if (!rate) continue;
            rolls.push({ tool: pick, toolLevel: Math.max(1, Number(lvl?.value ?? 1)), rollTicks: Number(rate.value) + 1, failTicks: 0, low: Number(chance[0]), high: Number(chance[1]), fixedChance: null, src: rate.src });
        }
        const respawn = rowCol(row, 'rock_respawnrate')?.[0];
        return doneFacts({ outputs: rowItems(row, 'rock_output', 1), tools: rolls.map(x => x.tool!) },
            withRolls({ basis: 'roll', ticksPerTry: rolls[0]?.rollTicks ?? 0, rolls: [], note: 'a roll every pickaxe mining_rate + 1 ticks.', src: [period.src, rowColSrc(row, 'rock_successchance')!] }, rolls,
                `Success: stat_random(rock_successchance). The rock depletes after one ore${respawn ? ` (respawn ${respawn} ticks)` : ''}; the model assumes a ready rock. A 1/256 gem roll replaces the ore roll.`));
    }
    case 'catch': return fishFacts(c, r.outputs[0]);
    default: return null;
    }
}
