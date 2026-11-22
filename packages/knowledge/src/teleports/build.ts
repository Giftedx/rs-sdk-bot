import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { knowledgeDir } from '../paths';
import { createTeleportContext } from './lookup';
import { buildJewellery, buildLyre, buildSpells, buildStaffs } from './spells-items';
import { MAGIC_RS, SPELL_RS, STATIC_ENGINE_RULES, WILD_PROC } from './tables';
import type { TeleportContext, TeleportsOut } from './types';
import { buildLocTeleports, buildNpcTeleports, buildRunecraft, buildSpiritTrees } from './world-builders';

function buildRules(ctx: TeleportContext): TeleportsOut['rules'] {
    const out: TeleportsOut['rules'] = [];
    const pre = ctx.block(SPELL_RS, /^\[proc,pre_tele_checks\]/);
    const r = (rel: string, re: RegExp, text: string, start = 0, end?: number) => out.push({ text, src: ctx.at(rel, ctx.find(rel, re, start, end).i) });
    r(WILD_PROC, /return \(calc\(\(coordz\(\$coord\) - coordz\(\$coord1\)\)\/8 \+ 1\)\)/, 'wilderness level = (z - zone south edge z) / 8 + 1 inside wilderness_zones; 0 outside');
    r(SPELL_RS, /~in_tutorial_island\(coord\) = true/, 'no teleport from Tutorial Island', pre.start, pre.end);
    r(SPELL_RS, /trawler_wreck_zones/, 'no teleport in the Fishing Trawler wreck', pre.start, pre.end);
    r(SPELL_RS, /trawler_game_zones/, 'no teleport during Fishing Trawler', pre.start, pre.end);
    r(SPELL_RS, /~in_duel_arena\(\$coord\) = true/, 'no teleport during a duel', pre.start, pre.end);
    r(SPELL_RS, /~in_castlewars_game\(coord\) = true \| ~in_castlewars_waitingroom/, 'no teleport in Castle Wars game or waiting room', pre.start, pre.end);
    const post = ctx.block(SPELL_RS, /^\[proc,post_tele_checks\]/);
    r(SPELL_RS, /inv_del\(inv, karamja_rum/, 'teleport through player_teleport_normal breaks Karamja rum in the inventory', post.start, post.end);
    r(SPELL_RS, /plaguesample/, 'teleport destroys the plague sample', post.start, post.end);
    r(MAGIC_RS, /if \(map_members = \^false & \$staff ! null & oc_members\(\$staff\) = true\)/, 'a members staff gives no free runes on a free world');
    r(MAGIC_RS, /def_obj \$staff = inv_getobj\(worn, \^wearpos_rhand\)/, 'only the wielded weapon-slot staff replaces runes');
    r(MAGIC_RS, /\$rune_count1 = null;/, 'a matching staff removes the whole count of that rune');
    out.push(...STATIC_ENGINE_RULES);
    return out;
}

export function buildTeleports(): TeleportsOut {
    const ctx = createTeleportContext();
    const rc = buildRunecraft(ctx);
    const teleports = [
        ...buildSpells(ctx),
        ...buildJewellery(ctx),
        buildLyre(ctx),
        ...buildLocTeleports(ctx),
        ...buildNpcTeleports(ctx),
        ...buildSpiritTrees(ctx),
        ...rc.teleports,
    ];
    const counts: Record<string, number> = {};
    for (const t of teleports) counts[t.kind] = (counts[t.kind] ?? 0) + 1;
    const gaps = teleports.flatMap(t => t.gaps.map(g => `${t.id}: ${g}`));
    return {
        rev: 289,
        teleports,
        staffs: buildStaffs(ctx),
        rules: buildRules(ctx),
        wildernessZones: ctx.wildernessZones.map(z => ({
            from: { x: z.from.x, z: z.from.z, level: z.from.level },
            to: { x: z.to.x, z: z.to.z, level: z.to.level },
            src: z.src,
        })),
        counts,
        unplaced: rc.unplaced,
        gaps,
    };
}

export function runTeleportsCli(): void {
    const out = buildTeleports();
    writeFileSync(join(knowledgeDir(), 'teleports.json'), JSON.stringify(out, null, 1) + '\n');
    console.log(`teleports ${out.teleports.length}`);
    for (const [k, v] of Object.entries(out.counts)) console.log(`${k.padEnd(18)} ${v}`);
    for (const g of out.gaps) console.log(`gap: ${g}`);
}
