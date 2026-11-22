import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfigs } from '../config';
import { baseTeleport, choiceLabels, dest, findsquareArgs } from './lookup';
import { GLORY_RS, JEWEL_OBJ, LYRE_RS, MAGIC_RS, RING_OF_LIFE_RS, SPELL_DB, SPELL_RS, STAFF_DB, STAGED_JEWEL_SPECS } from './tables';
import type { Charge, Teleport, TeleportContext, TeleportsOut } from './types';

export function buildSpells(ctx: TeleportContext): Teleport[] {
    const out: Teleport[] = [];
    const rows = parseConfigs(readFileSync(join(ctx.root, SPELL_DB), 'utf8'), SPELL_DB);
    const label = ctx.block(SPELL_RS, /^\[label,magic_teleport\]/);
    const move = ctx.find(SPELL_RS, /~player_teleport_normal\((.+)\);$/, label.start, label.end);
    const fs = findsquareArgs(move.m[1]!);
    if (!fs || !/tele_coord/.test(move.m[1]!)) throw new Error('magic_teleport move line shape changed');
    const wild = ctx.wildLimit(SPELL_RS, label.start, label.end);
    const membersLine = ctx.find(MAGIC_RS, /magic_spell_table:members, 0\) = true & map_members = \^false/);
    const levelLine = ctx.find(MAGIC_RS, /stat\(magic\) < db_getfield\(\$spell_data, magic_spell_table:levelrequired/);
    // One line can hold several spell gates joined by |, so take every match on each line.
    const questLines = ctx.findAll(SPELL_RS, /\$spell = \^\w+ & %\w+ < \^\w+/, label.start, label.end)
        .flatMap(({ i }) => [...ctx.clean(SPELL_RS)[i]!.matchAll(/\$spell = \^(\w+) & %(\w+) < \^(\w+)/g)].map(m => ({ i, m })));
    for (const { i, m } of ctx.findAll(SPELL_RS, /^\[if_button,magic:(\w+)\] @magic_teleport\(\^(\w+)\);$/)) {
        const com = m[1]!, spellConst = m[2]!;
        const row = rows.find(r => r.props.data?.some(d => d === `spell,^${spellConst}`));
        const t = baseTeleport(`spell:${com}`, 'spell', com.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()), `[if_button,magic:${com}]`, ctx.at(SPELL_RS, i));
        if (!row) { t.gaps.push(`no magic_spell_table row has spell,^${spellConst}`); out.push(t); continue; }
        const field = (k: string) => {
            const idx = row.props.data!.findIndex(d => d.startsWith(`${k},`));
            return idx < 0 ? null : { value: row.props.data![idx]!.slice(k.length + 1), src: `${SPELL_DB}:${row.propLines.data![idx]}` };
        };
        const lvl = field('levelrequired'), mem = field('members'), runes = field('runesrequired'), xp = field('experience'), coord = field('tele_coord');
        if (lvl) t.requires.push({ type: 'skill', skill: 'magic', level: Number(lvl.value), src: lvl.src });
        else t.gaps.push('levelrequired missing');
        if (mem?.value === 'true') t.requires.push({ type: 'members', src: mem.src });
        // Quest gates: a spell can have several lines on one varp; the highest threshold applies.
        const byVarp = new Map<string, { value: number; constName: string; src: string[]; message: string | null }>();
        for (const q of questLines.filter(q => q.m[1] === spellConst)) {
            const v = Number(ctx.constant(q.m[3]!).value);
            const cur = byVarp.get(q.m[2]!);
            const srcs = [...(cur?.src ?? []), ctx.at(SPELL_RS, q.i)];
            if (!cur || v > cur.value) byVarp.set(q.m[2]!, { value: v, constName: q.m[3]!, src: srcs, message: cur?.message ?? ctx.mesText(SPELL_RS, q.i + 1) });
            else cur.src = srcs;
        }
        for (const [varp, q] of byVarp) t.requires.push(ctx.varpReq(varp, '>=', q.constName, q.src, q.message));
        if (runes) {
            const p = runes.value.split(',');
            for (let k = 0; k + 1 < p.length; k += 2) if (p[k] !== 'null') t.runes.push({ item: p[k]!, id: ctx.itemId(p[k]!), count: Number(p[k + 1]), src: runes.src });
        } else t.gaps.push('runesrequired missing');
        if (xp) t.xp = { skill: 'magic', xp: Number(xp.value) / 10, tenths: Number(xp.value), src: xp.src };
        t.wildernessMax = wild;
        if (coord) t.to.push(dest(null, [ctx.tile(coord.value, coord.src)], fs, ctx.at(SPELL_RS, move.i)));
        else t.gaps.push('tele_coord missing');
        if (mem?.value === 'true') t.requires.push({ type: 'note', text: 'members spell needs a members world', src: ctx.at(MAGIC_RS, membersLine.i) });
        t.requires.push({ type: 'note', text: 'stat(magic) is the current level, so boosts count', src: ctx.at(MAGIC_RS, levelLine.i) });
        out.push(t);
    }
    return out;
}

export function buildStaffs(ctx: TeleportContext): TeleportsOut['staffs'] {
    const out: TeleportsOut['staffs'] = [];
    for (const b of parseConfigs(readFileSync(join(ctx.root, STAFF_DB), 'utf8'), STAFF_DB)) {
        const rune = b.props.data?.find(d => d.startsWith('rune,'))?.slice(5);
        const list = (b.props.data ?? []).filter(d => d.startsWith('staff,')).map(d => d.slice(6));
        if (rune) out.push({ rune, staffs: list, src: `${STAFF_DB}:${b.line}` });
    }
    return out;
}

function chargeChain(ctx: TeleportContext, items: string[]): Charge[] {
    const set = new Set(items);
    return items.map(n => {
        const b = ctx.objByName.get(n)!;
        const next = ctx.param(b, 'next_obj_stage');
        const ch = ctx.param(b, 'charges');
        let steps = 0, cur: string | null = n;
        while (cur && set.has(cur)) { steps++; cur = ctx.param(ctx.objByName.get(cur)!, 'next_obj_stage')?.value ?? null; }
        return { item: n, id: ctx.itemId(n), charges: ch ? Number(ch.value) : steps, next: next?.value ?? null, src: ch?.src ?? next?.src ?? `${b.file}:${b.line}` };
    }).sort((a, b) => b.charges - a.charges);
}

function glory(ctx: TeleportContext): Teleport {
    const heads = ctx.findAll(GLORY_RS, /^\[opheld4,(amulet_of_glory_\d)\] @amulet_of_glory_interface/);
    const t = baseTeleport('jewellery:amulet_of_glory', 'jewellery', 'Amulet of glory', '[opheld4,amulet_of_glory_N] Rub', ctx.at(GLORY_RS, heads[0]!.i));
    const label = ctx.block(GLORY_RS, /^\[label,amulet_of_glory_interface\]/);
    const choice = ctx.find(GLORY_RS, /~p_choice5_header\((.+)\);$/, label.start, label.end);
    const labels = choiceLabels(choice.m[1]!);
    t.wildernessMax = ctx.wildLimit(GLORY_RS, label.start, label.end);
    for (const { i, m } of ctx.findAll(GLORY_RS, /case (\d) : ~player_teleport_normal\((\S+)\);$/, label.start, label.end)) {
        t.to.push(dest(labels.get(Number(m[1])) ?? null, [ctx.tile(m[2]!, ctx.at(GLORY_RS, i))], null, ctx.at(GLORY_RS, i)));
    }
    t.charges = chargeChain(ctx, heads.map(h => h.m[1]!));
    const set = ctx.find(GLORY_RS, /inv_setslot\(inv, \$slot, oc_param\(\$item, next_obj_stage\), 1\)/, label.start, label.end);
    t.requires.push({ type: 'note', text: 'rub from the inventory (opheld4); no opworn trigger exists, so a worn amulet cannot teleport', src: ctx.at(GLORY_RS, heads[0]!.i) });
    t.requires.push({ type: 'note', text: 'each use replaces the slot with next_obj_stage', src: ctx.at(GLORY_RS, set.i) });
    const ob = ctx.objByName.get('amulet_of_glory_4')!;
    if (ob.props.members?.[0] === 'yes') t.requires.push({ type: 'members', src: `${ob.file}:${ob.propLines.members![0]}` });
    const dead = ctx.find(GLORY_RS, /^\[opheld4,amulet_of_glory\] mes\(/);
    t.requires.push({ type: 'note', text: 'amulet_of_glory (no charges) does not teleport', src: ctx.at(GLORY_RS, dead.i) });
    return t;
}

function stagedJewel(ctx: TeleportContext, id: string, name: string, rel: string, header: RegExp, items: string[], options: number[]): Teleport {
    const b = ctx.block(rel, header);
    const t = baseTeleport(id, 'jewellery', name, b.head, ctx.at(rel, b.start));
    const choice = ctx.find(rel, /~p_choice\d_header\((.+)\);$/, b.start, b.end);
    const labels = choiceLabels(choice.m[1]!);
    t.wildernessMax = ctx.wildLimit(rel, b.start, b.end);
    const moves = ctx.findAll(rel, /~player_teleport_normal\((.+)\);$/, b.start, b.end);
    if (moves.length !== options.length) throw new Error(`${rel}: ${moves.length} move lines, expected ${options.length}`);
    moves.forEach((mv, k) => {
        const fs = findsquareArgs(mv.m[1]!)!;
        const label = labels.get(options[k]!) ?? null;
        if (!label || label === 'Nowhere') throw new Error(`${rel}: option ${options[k]} is not a destination`);
        t.to.push(dest(label, [ctx.tile(fs.coord, ctx.at(rel, mv.i))], fs, ctx.at(rel, mv.i)));
    });
    t.charges = chargeChain(ctx, items);
    const cr = ctx.find(rel, /inv_delslot\(inv, \$slot\)/, b.start, b.end);
    t.requires.push({ type: 'note', text: 'rub from the inventory (opheld4); the last charge deletes the item', src: ctx.at(rel, cr.i) });
    const ob = ctx.objByName.get(t.charges[0]!.item)!;
    if (ob.props.members?.[0] === 'yes') t.requires.push({ type: 'members', src: `${ob.file}:${ob.propLines.members![0]}` });
    return t;
}

function ringOfLife(ctx: TeleportContext): Teleport {
    const b = ctx.block(RING_OF_LIFE_RS, /^\[proc,ring_of_life_check\]/);
    const t = baseTeleport('jewellery:ring_of_life', 'jewellery', 'Ring of life', b.head, ctx.at(RING_OF_LIFE_RS, b.start));
    const cond = ctx.find(RING_OF_LIFE_RS, /inv_getobj\(worn, \^wearpos_ring\) ! ring_of_life \| map_members = \^false \| ~wilderness_level\(coord\) > (\d+) \| stat\(hitpoints\) > scale\((\d+), (\d+), stat_base\(hitpoints\)\)/, b.start, b.end);
    t.requires.push({ type: 'worn', item: 'ring_of_life', id: ctx.itemId('ring_of_life'), src: ctx.at(RING_OF_LIFE_RS, cond.i) });
    t.requires.push({ type: 'members', src: ctx.at(RING_OF_LIFE_RS, cond.i) });
    t.requires.push({ type: 'note', text: `fires by itself when hitpoints <= ${cond.m[2]}/${cond.m[3]} of base hitpoints; not a chosen route leg`, src: ctx.at(RING_OF_LIFE_RS, cond.i) });
    t.wildernessMax = { level: Number(cond.m[1]), src: ctx.at(RING_OF_LIFE_RS, cond.i) };
    const del = ctx.find(RING_OF_LIFE_RS, /inv_delslot\(worn, \^wearpos_ring\)/, b.start, b.end);
    t.charges = [{ item: 'ring_of_life', id: ctx.itemId('ring_of_life'), charges: 1, next: null, src: ctx.at(RING_OF_LIFE_RS, del.i) }];
    const mv = ctx.find(RING_OF_LIFE_RS, /~player_teleport_normal\((.+)\);$/, b.start, b.end);
    const fs = findsquareArgs(mv.m[1]!)!;
    t.to.push(dest(null, [ctx.tile(fs.coord, ctx.at(RING_OF_LIFE_RS, mv.i))], fs, ctx.at(RING_OF_LIFE_RS, mv.i)));
    return t;
}

export function buildJewellery(ctx: TeleportContext): Teleport[] {
    const cat = (c: string) => ctx.objBlocks.filter(b => b.file === JEWEL_OBJ && b.props.category?.[0] === c).map(b => b.name);
    return [
        glory(ctx),
        ...STAGED_JEWEL_SPECS.map(s => stagedJewel(ctx, s.id, s.name, s.rel, s.header, cat(s.category), s.options)),
        ringOfLife(ctx),
    ];
}

export function buildLyre(ctx: TeleportContext): Teleport {
    const b = ctx.block(LYRE_RS, /^\[opheld1,magic_strung_lyre\]/);
    const t = baseTeleport('item:magic_strung_lyre', 'item', 'Enchanted lyre', b.head, ctx.at(LYRE_RS, b.start));
    t.requires.push({ type: 'held', item: 'magic_strung_lyre', id: ctx.itemId('magic_strung_lyre'), src: ctx.at(LYRE_RS, b.start) });
    const ob = ctx.objByName.get('magic_strung_lyre')!;
    if (ob.props.members?.[0] === 'yes') t.requires.push({ type: 'members', src: `${ob.file}:${ob.propLines.members![0]}` });
    t.wildernessMax = ctx.wildLimit(LYRE_RS, b.start, b.end);
    const mv = ctx.find(LYRE_RS, /~player_teleport_normal\((.+)\);$/, b.start, b.end);
    const fs = findsquareArgs(mv.m[1]!)!;
    t.to.push(dest('Rellekka', [ctx.tile(fs.coord, ctx.at(LYRE_RS, mv.i))], fs, ctx.at(LYRE_RS, mv.i)));
    const set = ctx.find(LYRE_RS, /inv_setslot\(inv, \$slot, (\w+), 1\);$/, b.start, b.end);
    t.charges = [{ item: 'magic_strung_lyre', id: ctx.itemId('magic_strung_lyre'), charges: 1, next: set.m[1]!, src: ctx.at(LYRE_RS, set.i) }];
    const shrine = ctx.block(LYRE_RS, /^\[oplocu,viking_lake_shrine_altar\]/);
    const done = ctx.find(LYRE_RS, /if\(%viking = \^(\w+)\)/, shrine.start, shrine.end);
    const fish = ctx.find(LYRE_RS, /last_useitem = (raw_shark) \| last_useitem = (raw_seaturtle) \| last_useitem = (raw_mantaray)/, shrine.start, shrine.end);
    t.requires.push(ctx.varpReq('viking', '=', done.m[1]!, [ctx.at(LYRE_RS, done.i)], 'enchanting at the shrine needs the quest complete'));
    t.requires.push({ type: 'note', text: `enchant viking_strung_lyre by using ${fish.m[1]}, ${fish.m[2]} or ${fish.m[3]} on viking_lake_shrine_altar; one enchant gives one teleport`, src: ctx.at(LYRE_RS, fish.i) });
    return t;
}
