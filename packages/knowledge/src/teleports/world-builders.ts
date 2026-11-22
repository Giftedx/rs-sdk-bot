import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, parseConfigs, type ConfigBlock } from '../config';
import { baseTeleport, choiceLabels, dest, findsquareArgs } from './lookup';
import {
    CROMPERTY_RS, ESSENCE_WIZARDS, ESS_ENUM, ESS_RS, FS_TYPES,
    LOC_TELEPORT_SPECS, RUNECRAFT_DB, RUNECRAFT_RS, SPIRIT_TREE_RS,
} from './tables';
import type { LocTeleportSpec, Teleport, TeleportContext } from './types';

function locTeleport(ctx: TeleportContext, spec: LocTeleportSpec): Teleport {
    const b = ctx.block(spec.rel, new RegExp(`^\\[${spec.opt},${spec.locName}\\]`));
    const t = baseTeleport(spec.id, spec.kind, spec.name, b.head, ctx.at(spec.rel, b.start));
    t.from = ctx.spawnsOf(ctx.locSpawns, spec.locName, t.gaps, 'loc');
    const mv = ctx.findAll(spec.rel, /(?:~player_teleport_normal|p_telejump)\((.+)\);/, b.start, b.end)[0];
    if (!mv) { t.gaps.push('no move line in trigger'); return t; }
    const fs = findsquareArgs(mv.m[1]!);
    t.to.push(dest(null, [ctx.coordTile(fs?.coord ?? mv.m[1]!, ctx.at(spec.rel, mv.i))], fs, ctx.at(spec.rel, mv.i)));
    if (spec.zanarisExtra) {
        const c = ctx.find(spec.rel, /if\(inv_total\(worn, (dramen_staff)\) > 0 & map_members = \^true\)/, b.start, b.end);
        const ax = ctx.find(spec.rel, /if\(\$entering = false\)/, b.start, b.end);
        t.requires.push({ type: 'worn', item: c.m[1]!, id: ctx.itemId(c.m[1]!), src: ctx.at(spec.rel, c.i) });
        t.requires.push({ type: 'members', src: ctx.at(spec.rel, c.i) });
        t.requires.push({ type: 'note', text: 'fires only when ~check_axis(coord, loc_coord, loc_angle) is false (player not on the door tile axis)', src: ctx.at(spec.rel, ax.i) });
        t.gaps.push('which side of the shed door gives check_axis false is not resolved from geometry');
    }
    return t;
}

export function buildLocTeleports(ctx: TeleportContext): Teleport[] {
    return LOC_TELEPORT_SPECS.map(s => locTeleport(ctx, s));
}

export function buildNpcTeleports(ctx: TeleportContext): Teleport[] {
    const out: Teleport[] = [];
    const label = ctx.block(ESS_RS, /^\[label,teleport_to_essence_mine\]/);
    const rm = ctx.find(ESS_RS, /if\(%(\w+) < \^(\w+)\)/, label.start, label.end);
    const pick = ctx.find(ESS_RS, /map_findsquare\(\$coord, (\d+), (\d+), \^(\w+)\)/, label.start, label.end);
    const jump = ctx.find(ESS_RS, /p_telejump\(\$coord\)/, label.start, label.end);
    const mine = ctx.findAll(ESS_ENUM, /^val=\d+,(\S+)$/).map(({ i, m }) => ctx.tile(m[1]!, ctx.at(ESS_ENUM, i)));
    const backByConst = new Map<string, string>();
    for (const [npc, rel, name] of ESSENCE_WIZARDS) {
        const op = ctx.find(rel, new RegExp(`^\\[(opnpc\\d),${npc}\\]$`));
        // The menu op that goes straight to the teleport label.
        const direct = ctx.findAll(rel, new RegExp(`^\\[(opnpc\\d),${npc}\\]`)).find(h => /@teleport_to_essence_mine/.test(ctx.lines(rel).slice(h.i, h.i + 3).join('\n'))) ?? op;
        const call = ctx.find(rel, /@teleport_to_essence_mine\(\^(\w+)\)/, direct.i);
        backByConst.set(call.m[1]!, name);
        const t = baseTeleport(`npc:essence_mine:${npc}`, 'npc', `${name} to the Rune essence mine`, ctx.lines(rel)[direct.i]!.trim(), ctx.at(rel, direct.i));
        t.from = ctx.spawnsOf(ctx.npcSpawns, npc, t.gaps, 'npc');
        t.requires.push(ctx.varpReq(rm.m[1]!, '>=', rm.m[2]!, [ctx.at(ESS_RS, rm.i)], ctx.mesText(ESS_RS, rm.i + 2)));
        t.to.push(dest('Rune essence mine', mine, { min: Number(pick.m[1]), max: Number(pick.m[2]), type: FS_TYPES[pick.m[3]!] ?? null }, ctx.at(ESS_RS, jump.i)));
        t.requires.push({ type: 'note', text: `sets the essence mine exit to ^${call.m[1]}`, src: ctx.at(rel, call.i) });
        out.push(t);
    }
    // Exit portal: back to the wizard who sent the player (default Sedridor).
    const portal = ctx.block(ESS_RS, /^\[oploc1,blankrunestone_exit_portal\]/);
    const pfs = ctx.find(ESS_RS, /map_findsquare\(%exit_essence_mine_coord, (\d+), (\d+), \^(\w+)\)/, portal.start, portal.end);
    const pj = ctx.find(ESS_RS, /p_telejump\(\$coord\)/, portal.start, portal.end);
    const def = ctx.find(ESS_RS, /%exit_essence_mine_coord = \^(\w+);/, portal.start, portal.end);
    const t = baseTeleport('runecraft_portal:blankrunestone_exit_portal', 'runecraft_portal', 'Rune essence mine exit portal', portal.head, ctx.at(ESS_RS, portal.start));
    t.from = ctx.spawnsOf(ctx.locSpawns, 'blankrunestone_exit_portal', t.gaps, 'loc');
    for (const [k, name] of backByConst) {
        t.to.push(dest(name, [ctx.coordTile(`^${k}`, '')], { min: Number(pfs.m[1]), max: Number(pfs.m[2]), type: FS_TYPES[pfs.m[3]!] ?? null }, ctx.at(ESS_RS, pj.i),
            k === def.m[1] ? 'the player entered through this wizard, or the exit coord is unset' : 'the player entered through this wizard'));
    }
    const f2p = ctx.find(ESS_RS, /map_members = \^false\)/, portal.start, portal.end);
    t.requires.push({ type: 'note', text: 'on a free world an exit that is not Aubury or Sedridor resets to Sedridor', src: ctx.at(ESS_RS, f2p.i) });
    out.push(t);

    // Cromperty's research teleport (Tribal Totem).
    const tl = ctx.block(CROMPERTY_RS, /^\[label,cromperty_teleport\]/);
    const gate = ctx.find(CROMPERTY_RS, /if\(%(\w+) < \^(\w+)\)/, tl.start, tl.end);
    const rp = ctx.block(CROMPERTY_RS, /^\[label,rpdt_teleport\]/);
    const d0 = ctx.find(CROMPERTY_RS, /def_coord \$coord = (\S+);$/, rp.start, rp.end);
    const cond = ctx.find(CROMPERTY_RS, /if\(%(\w+) >= \^(\w+)\)/, rp.start, rp.end);
    const d1 = ctx.find(CROMPERTY_RS, /\$coord = (\S+);$/, cond.i + 1, rp.end);
    const rj = ctx.find(CROMPERTY_RS, /p_telejump\(\$coord\)/, rp.start, rp.end);
    const c = baseTeleport('npc:cromperty_rpdt', 'npc', 'Wizard Cromperty teleport block', '[opnpc1,ardounge_wizard] dialogue: Can I be teleported please?', ctx.at(CROMPERTY_RS, tl.start));
    c.from = ctx.spawnsOf(ctx.npcSpawns, 'ardounge_wizard', c.gaps, 'npc');
    c.requires.push(ctx.varpReq(gate.m[1]!, '<', gate.m[2]!, [ctx.at(CROMPERTY_RS, gate.i)], 'the teleport works only before the quest is complete'));
    const crate = ctx.constant(cond.m[2]!);
    c.to.push(dest(null, [ctx.tile(d0.m[1]!, ctx.at(CROMPERTY_RS, d0.i))], null, ctx.at(CROMPERTY_RS, rj.i), `%${cond.m[1]} < ${crate.value} (^${cond.m[2]}, ${crate.src})`));
    c.to.push(dest(null, [ctx.tile(d1.m[1]!, ctx.at(CROMPERTY_RS, d1.i))], null, ctx.at(CROMPERTY_RS, rj.i), `%${cond.m[1]} >= ${crate.value} (^${cond.m[2]}, ${crate.src})`));
    out.push(c);
    return out;
}

export function buildSpiritTrees(ctx: TeleportContext): Teleport[] {
    const tele = ctx.block(SPIRIT_TREE_RS, /^\[label,spirit_tree_tele\]/);
    const mem = ctx.find(SPIRIT_TREE_RS, /if\(map_members = \^false\)/, tele.start, tele.end);
    const jump = ctx.find(SPIRIT_TREE_RS, /p_telejump\(\$dest\)/, tele.start, tele.end);
    const out: Teleport[] = [];
    for (const h of ctx.findAll(SPIRIT_TREE_RS, /^\[oploc1,(\w+)\]/)) {
        const loc = h.m[1]!;
        const end = ctx.blockEnd(SPIRIT_TREE_RS, h.i);
        const t = baseTeleport(`spirit_tree:${loc}`, 'spirit_tree', `Spirit tree (${loc})`, `[oploc1,${loc}]`, ctx.at(SPIRIT_TREE_RS, h.i));
        t.from = ctx.spawnsOf(ctx.locSpawns, loc, t.gaps, 'loc');
        const q = ctx.find(SPIRIT_TREE_RS, /if\(%(\w+) ! \^(\w+)\)/, h.i, end);
        t.requires.push(ctx.varpReq(q.m[1]!, '=', q.m[2]!, [ctx.at(SPIRIT_TREE_RS, q.i)], ctx.mesText(SPIRIT_TREE_RS, q.i + 1)));
        t.requires.push({ type: 'members', src: ctx.at(SPIRIT_TREE_RS, mem.i) });
        const cases = ctx.findAll(SPIRIT_TREE_RS, /case (\d) : \$end_pos = \^(\w+);/, h.i, end);
        if (cases.length) {
            const ch = cases[0]!.i - 1;
            const labels = choiceLabels(ctx.lines(SPIRIT_TREE_RS)[ch]!);
            for (const cs of cases) t.to.push(dest(labels.get(Number(cs.m[1])) ?? null, [ctx.coordTile(`^${cs.m[2]}`, '')], null, ctx.at(SPIRIT_TREE_RS, jump.i)));
        } else {
            const d = ctx.find(SPIRIT_TREE_RS, /@spirit_tree_tele\(\^(\w+)\)/, h.i, end);
            t.to.push(dest(null, [ctx.coordTile(`^${d.m[1]}`, '')], null, ctx.at(SPIRIT_TREE_RS, jump.i)));
        }
        out.push(t);
    }
    return out;
}

export function buildRunecraft(ctx: TeleportContext): { teleports: Teleport[]; unplaced: string[] } {
    const rows = parseConfigs(readFileSync(join(ctx.root, RUNECRAFT_DB), 'utf8'), RUNECRAFT_DB);
    const rowOf = (type: string) => rows.find(r => r.props.data?.includes(`type,${type}`));
    const field = (r: ConfigBlock, k: string) => (r.props.data ?? [])
        .map((d, idx) => ({ d, line: r.propLines.data![idx]! }))
        .filter(x => x.d.startsWith(`${k},`))
        .map(x => ({ value: x.d.slice(k.length + 1), src: `${RUNECRAFT_DB}:${x.line}` }));
    const enter = ctx.block(RUNECRAFT_RS, /^\[label,teleport_to_ruins\]/);
    const enterJump = ctx.find(RUNECRAFT_RS, /p_telejump\(map_findsquare\(db_getfield\(\$data, runecraft_table:enter_coord/, enter.start, enter.end);
    const memLine = ctx.find(RUNECRAFT_RS, /runecraft_table:members, 0\) = \^true/, enter.start, enter.end);
    const exit = ctx.block(RUNECRAFT_RS, /^\[oploc1,_rc_exit_portal\]/);
    const exitJump = ctx.find(RUNECRAFT_RS, /p_telejump\(map_findsquare\(db_getfield\(\$data, runecraft_table:exit_coord/, exit.start, exit.end);
    const ruinsHead = ctx.find(RUNECRAFT_RS, /^\[oplocu,_rc_ruins\]/);
    const locBlocks = listConfigFiles('.loc').flatMap(f => parseConfigs(readFileSync(join(ctx.root, f), 'utf8'), f));
    const coordList = (vals: { value: string; src: string }[]) => vals.map(v => {
        const [c, min, max, type] = v.value.split(',');
        return { t: ctx.tile(c!, v.src), min: Number(min), max: Number(max), type: ctx.fsByNum[type!] ?? null };
    });

    const out: Teleport[] = [];
    const unplaced: string[] = [];
    for (const lb of locBlocks) {
        const cat = lb.props.category?.[0];
        if (cat !== 'rc_ruins' && cat !== 'rc_exit_portal') continue;
        const rt = lb.props.param?.find(p => p.startsWith('rune_type,'))?.slice(10);
        const row = rt ? rowOf(rt) : undefined;
        const ruins = cat === 'rc_ruins';
        const t = baseTeleport(
            `${ruins ? 'runecraft_ruins' : 'runecraft_portal'}:${lb.name}`,
            ruins ? 'runecraft_ruins' : 'runecraft_portal',
            `${row ? field(row, 'name')[0]?.value : lb.name} ${ruins ? 'mysterious ruins' : 'altar exit portal'}`,
            ruins ? '[oplocu,_rc_ruins] use talisman' : '[oploc1,_rc_exit_portal]',
            ruins ? ctx.at(RUNECRAFT_RS, ruinsHead.i) : ctx.at(RUNECRAFT_RS, exit.start),
        );
        t.from = ctx.locSpawns.get(lb.name) ?? [];
        if (!row) t.gaps.push(`no runecraft_table row for rune_type ${rt}`);
        if (t.from.length === 0) { unplaced.push(`${lb.name} (${lb.file}:${lb.line}) has no map spawn; not listed`); continue; }
        (t as Teleport & { runeType?: string }).runeType = rt;
        if (row) {
            if (ruins) {
                const tal = field(row, 'talisman')[0];
                if (tal) t.requires.push({ type: 'held', item: tal.value, id: ctx.itemId(tal.value), src: tal.src });
                const mem = field(row, 'members')[0];
                if (mem?.value === '1') t.requires.push({ type: 'members', src: `${mem.src} (${ctx.at(RUNECRAFT_RS, memLine.i)})` });
            }
            const list = coordList(field(row, ruins ? 'enter_coord' : 'exit_coord'));
            // Group candidates that share one radius (the script picks one entry at random, then map_findsquare).
            const r0 = list[0];
            if (r0 && list.every(x => x.min === r0.min && x.max === r0.max && x.type === r0.type)) {
                t.to.push(dest(null, list.map(x => x.t), { min: r0.min, max: r0.max, type: r0.type }, ctx.at(RUNECRAFT_RS, ruins ? enterJump.i : exitJump.i)));
            } else {
                for (const x of list) t.to.push(dest(null, [x.t], { min: x.min, max: x.max, type: x.type }, ctx.at(RUNECRAFT_RS, ruins ? enterJump.i : exitJump.i)));
            }
        }
        out.push(t);
    }
    // An exit portal whose rune type has no placed ruins: its exit_coord is not a ruins-side tile.
    const ruinTypes = new Set(out.filter(t => t.kind === 'runecraft_ruins').map(t => (t as Teleport & { runeType?: string }).runeType));
    for (const t of out) {
        const rt = (t as Teleport & { runeType?: string }).runeType;
        if (t.kind === 'runecraft_portal' && !ruinTypes.has(rt)) t.gaps.push(`rune_type ${rt} has no placed mysterious ruins; the exit_coord row value is used as written`);
        delete (t as Teleport & { runeType?: string }).runeType;
    }
    return { teleports: out, unplaced };
}
