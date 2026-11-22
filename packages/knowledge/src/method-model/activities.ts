import { MODEL_FILES, find, findAll, param, prop } from './content';
import { doneFacts, facts, instantTiming, pDelayTiming, rowCol, rowColSrc, withRolls } from './timing';
import type { Content, Facts, Hit, ModelInput, Row, Timing } from './types';

const COURSE_RUNGS: Record<string, string> = {
    'course-gnome-stronghold-agility-course': 'gnome',
    'course-barbarian-outpost-agility-course': 'barbarian',
    'course-wilderness-course': 'wilderness',
};

function magicFacts(c: Content, rowName: string, row: Row | null): Facts {
    const spell = rowName.replace(/^magic_spell_/, '');
    const isCombat = !!(row?.data.maxhit || row?.data.stat_change || row?.data.freeze_time);
    let t: Timing | string;
    let note: string | null = null;
    const S = (f: string) => `${MODEL_FILES.spells}${f}.rs2`;
    if (/^enchant_level\d$/.test(spell)) t = pDelayTiming(c, S('enchant'), 'magic_spell_enchant', true, '');
    else if (spell === 'high_alch') t = pDelayTiming(c, S('alchemy'), 'magic_spell_high_alch', true, '');
    else if (spell === 'low_alch') t = pDelayTiming(c, S('alchemy'), 'magic_spell_low_alch', true, '');
    else if (spell === 'superheat') t = pDelayTiming(c, S('superheat'), 'magic_spell_superheat', true, 'Also gives smithing XP.');
    else if (/^charge_[a-z]+_orb$/.test(spell)) t = pDelayTiming(c, S('charge_orb'), 'magic_spell_charge_orb', true, 'Cast on the obelisk.');
    else if (spell === 'bones_to_bananas') t = pDelayTiming(c, S('convert_bones'), 'magic_spell_convert_bones', true, '');
    else if (spell === 'telegrab') t = pDelayTiming(c, S('telegrab'), 'magic_spell_telegrab', true, 'Needs a ground item in range.');
    else if (/^teleport_/.test(spell)) t = pDelayTiming(c, S('teleport'), 'player_teleport_normal', true, 'Ticks are the teleport delays; walking back is not counted.');
    else if (spell === 'charge') t = instantTiming(c, S('charge'), 'magic:charge', 'Needs the Mage Arena god staff (%magearena).');
    else if (isCombat) {
        const d = find(c, MODEL_FILES.playerMagic, /%action_delay = add\(map_clock, (\d+)\)/);
        t = d
            ? { basis: 'p_delay', ticksPerTry: Number(d.m[1]), rolls: [], note: `one cast every ${d.m[1]} ticks (combat spell attack delay). A hit also gives 2 XP per damage (${MODEL_FILES.combat}:161); the model counts only the base cast XP.`, src: [d.src] }
            : `combat spell delay not found in ${MODEL_FILES.playerMagic}`;
        note = 'base cast XP; damage XP not counted';
    } else t = `no timing model for spell ${spell}`;
    return doneFacts({ xpNote: note }, t);
}

const COMBAT_XP: Record<string, { tenthsPerDamage: number; re: RegExp; note: string }> = {
    attack: { tenthsPerDamage: 40, re: /stat_advance\(attack, scale\(\$multiplier, 1000, scale\(400, 100, \$base\)\)\)/, note: 'accurate style, 4 XP per damage' },
    strength: { tenthsPerDamage: 40, re: /stat_advance\(strength, scale\(\$multiplier, 1000, scale\(400, 100, \$base\)\)\)/, note: 'aggressive style, 4 XP per damage' },
    defence: { tenthsPerDamage: 40, re: /stat_advance\(defence, scale\(\$multiplier, 1000, scale\(400, 100, \$base\)\)\)/, note: 'defensive style, 4 XP per damage' },
    ranged: { tenthsPerDamage: 40, re: /stat_advance\(ranged, scale\(\$multiplier, 1000, scale\(400, 100, \$base\)\)\)/, note: 'accurate or rapid style, 4 XP per damage' },
    hitpoints: { tenthsPerDamage: 13.3, re: /stat_advance\(hitpoints, scale\(\$multiplier, 1000, scale\(133, 100, \$base\)\)\)/, note: 'any style, 1.33 XP per damage' },
};

function targetFacts(c: Content, r: ModelInput): Facts {
    const npc = r.npc ? c.npc(r.npc) : undefined;
    const hp = prop(npc, 'hitpoints');
    const mult = param(npc, 'combat_xp_multiplier');
    const def = find(c, MODEL_FILES.combatParam, /^default=(\d+)/, 'combat_xp_multiplier');
    const rule = COMBAT_XP[r.skill];
    const line = rule ? find(c, MODEL_FILES.combat, rule.re, 'give_combat_experience') : null;
    const gaps = ['ticks per kill unknown: they need max hit and hit chance (player_melee.rs2, player_ranged.rs2), which depend on levels and gear'];
    if (!hp || !rule || !line) return facts({ gaps: [hp ? `combat XP rule not found for ${r.skill}` : `hitpoints not found for npc ${r.npc}`, ...gaps] });
    const m = Number(mult?.value ?? def?.m[1] ?? 1000);
    const xp = Math.round(Number(hp.value) * rule.tenthsPerDamage * m / 1000) / 10;
    return facts({ xpPerAction: xp, xpSrc: hp.src, xpNote: `XP per kill: hitpoints ${hp.value} x ${rule.note} (${line.src}) x multiplier ${m}/1000 (${mult?.src ?? def?.src ?? 'default'})`, gaps });
}

/** Model facts for magic, thieving, agility courses, and combat targets, or `null` for other kinds. */
export function activityFacts(c: Content, r: ModelInput, rowName: string): Facts | null {
    const row = r.row;
    switch (r.kind) {
    case 'magic_spell_table': return magicFacts(c, rowName, row);
    case 'pickpocket': {
        const t = pDelayTiming(c, MODEL_FILES.thieving, 'pick_pocket', true, '');
        const ch = rowCol(row, 'success_chance'), stun = rowCol(row, 'stun_ticks')?.[0];
        if (!ch || typeof t === 'string') return doneFacts({}, t);
        const stunAt = find(c, MODEL_FILES.thieving, /%action_delay = calc\(map_clock \+ \$stun_ticks\)/, 'fail_pick_pocket');
        return doneFacts({}, withRolls(t, [{ tool: null, toolLevel: 1, rollTicks: t.ticksPerTry, failTicks: Number(stun ?? 0), low: Number(ch[0]), high: Number(ch[1]), fixedChance: null, src: rowColSrc(row, 'success_chance')! }],
            `A failed try stuns for stun_ticks ${stun} (${stunAt?.src ?? 'fail_pick_pocket'}, ${rowColSrc(row, 'stun_ticks')}); the model adds the stun to each fail.`));
    }
    case 'stealing': return doneFacts({}, pDelayTiming(c, MODEL_FILES.thieving, 'steal_from_stall', true, 'The stall then respawns; the model assumes a ready stall and no guard.'));
    case 'trapped_chest': return doneFacts({}, pDelayTiming(c, MODEL_FILES.thieving, 'disarm_trapped_chest', true, 'The chest then respawns; the model assumes a ready chest.'));
    case 'course': {
        const key = COURSE_RUNGS[rowName];
        if (!key) return doneFacts({ gaps: [`XP per action and ticks unknown: the guide row ${rowName} names an activity (agility arena or gnomeball) with no lap script, and its XP is paid by other scripts`] }, null);
        // A lap is the blocks that advance the course varp, plus the varp proc that pays the lap bonus.
        const file = MODEL_FILES.courses[key]!, ls = c.lines(file) ?? [];
        const hits: Hit[] = [];
        for (let i = 0; i < ls.length; i++) {
            const h = /^\[([a-z_0-9]+),([^\]]+)\]/.exec(ls[i]!);
            if (!h) continue;
            const inLap = h[1] === 'proc' ? /^update_\w+_varp$/.test(h[2]!) : findAll(c, file, /~update_\w+_varp\(/, h[2]!).length > 0;
            if (inLap) hits.push(...findAll(c, file, /(?:stat_advance\(agility, |~agility_climb_up\(|~agility_force_move\()(\d+)/, h[2]!));
        }
        const xp = hits.reduce((a, h) => a + Number(h.m[1]), 0) / 10;
        return doneFacts({
            xpPerAction: xp, xpSrc: hits[0]?.src ?? null,
            xpNote: `one lap: XP calls in the blocks that advance the course varp, lap bonus included (lines ${hits.map(h => h.src.split(':').pop()).join(', ')}); agility_climb_up and agility_force_move award their first argument (scripts/skill_agility/scripts/agility.rs2:6,16)`,
            gaps: ['lap ticks unknown: each obstacle moves the player with forcemove and walk steps that the generator does not sum'],
        }, null);
    }
    case 'target': return targetFacts(c, r);
    default: return null;
    }
}
