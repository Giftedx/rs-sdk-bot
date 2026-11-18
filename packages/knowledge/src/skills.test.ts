import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseConfigs } from './config';
import { anvilXpPerBar, buildConfigSkillActions, buildSkillActions, type SkillAction } from './skills';
import { FIREMAKING_TIERS, HERBLORE_TIERS, SMITHING_TIERS } from '../../planner/src/haggis';

const parse = (file: string, lines: string[]) => parseConfigs(lines.join('\n'), file);

test('firemaking, herblore and smelting rows come from object and struct params, in whole XP', () => {
    const rows = buildConfigSkillActions({
        objs: parse('scripts/skill_firemaking/configs/firemaking.obj', ['[oak_logs]', 'name=Oak logs', 'param=levelrequire,15', 'param=productexp,600', '[tinderbox]', 'name=Tinderbox']),
        structs: [
            ...parse('scripts/skill_herblore/configs/brewing/brew_potion.struct', [
                '[attack_potion]', 'param=brew_potion_ingredient,eye_of_newt', 'param=brew_potion_solvent,guamvial', 'param=brew_potion_mixture,3doseattack', 'param=brew_potion_exp,250',
                '[strength_potion]', 'param=brew_potion_ingredient,limpwurt_root', 'param=brew_potion_solvent,tarrominvial', 'param=brew_potion_level,12', 'param=brew_potion_exp,500', 'param=brew_potion_mixture,3dose1strength',
                '[unf_guam_potion]', 'param=brew_potion_ingredient,guam_leaf', 'param=brew_potion_solvent,vial_water', 'param=brew_potion_mixture,guamvial',
            ]),
            ...parse('scripts/skill_smithing/configs/smelting/smelting.struct', ['[smelting_bronze_bar]', 'param=levelrequired,1', 'param=productexp,62', 'param=ingredient,copper_ore', 'param=ingredient_secondary,tin_ore', 'param=product,bronze_bar']),
        ],
    });
    const by = (row: string) => rows.find(r => r.row === row)!;
    expect(rows.map(r => r.row)).toEqual(['oak_logs', 'attack_potion', 'strength_potion', 'unf_guam_potion', 'smelting_bronze_bar']);
    expect(by('oak_logs')).toMatchObject({ skill: 'firemaking', level: 15, xp: 60, inputs: ['oak_logs'], src: { level: 'scripts/skill_firemaking/configs/firemaking.obj:3', xp: 'scripts/skill_firemaking/configs/firemaking.obj:4' } });
    // No brew_potion_level: the content checks no level (level 0). No brew_potion_exp: no XP.
    expect(by('attack_potion')).toMatchObject({ skill: 'herblore', level: 0, xp: 25, inputs: ['guamvial', 'eye_of_newt'], outputs: ['3doseattack'] });
    expect(by('strength_potion')).toMatchObject({ level: 12, xp: 50 });
    expect(by('unf_guam_potion')).toMatchObject({ level: 0, xp: null });
    expect(by('smelting_bronze_bar')).toMatchObject({ skill: 'smithing', level: 1, xp: 6.2, inputs: ['copper_ore', 'tin_ore'], outputs: ['bronze_bar'] });
});

test('an anvil row takes bar_amount x xpperbar of the struct that the bar object names', () => {
    const sources = {
        objs: parse('scripts/skill_smithing/configs/smelting/smelting.obj', ['[bronze_bar]', 'param=smithing_anvil_struct,smithing_bronze_bar']),
        structs: parse('scripts/skill_smithing/configs/smelting/smithing.struct', ['[smithing_bronze_bar]', 'param=xpperbar,125']),
    };
    expect(anvilXpPerBar(sources).get('bronze_bar')).toEqual({ xp: 12.5, src: 'scripts/skill_smithing/configs/smelting/smithing.struct:2' });
    const table = { table: 'smithing', columns: [], def: null, rows: [{ name: 'bronze_platebody', def: 'x:1', data: { levelrequired: [['18']], bar: [['bronze_bar']], bar_amount: [['5']] }, src: { levelrequired: ['x:2'] } }] };
    const [row] = buildSkillActions([table], sources);
    expect(row).toMatchObject({ skill: 'smithing', row: 'bronze_platebody', level: 18, xp: 62.5 });
});

test('the planner hand tables of herblore, firemaking and smithing XP match the content rows', () => {
    const rows = JSON.parse(readFileSync(new URL('../../../knowledge/skills.json', import.meta.url), 'utf8')) as SkillAction[];
    const X = 25; // the server XP rate of haggis.ts
    for (const [skill, tiers] of [['herblore', HERBLORE_TIERS], ['firemaking', FIREMAKING_TIERS], ['smithing', SMITHING_TIERS]] as const) {
        expect(rows.some(r => r.skill === skill)).toBe(true);
        for (const t of tiers) {
            // A content row with no level check has level 0: the first level that an account has is 1.
            const hit = rows.find(r => r.skill === skill && Math.max(1, r.level) === t.level && r.xp !== null && Math.abs(r.xp * X - t.xpPerAction) <= 1.3);
            expect([skill, t.id, hit !== undefined]).toEqual([skill, t.id, true]);
        }
    }
    // The smithing anvil and smelting rows all carry XP now.
    expect(rows.filter(r => r.skill === 'smithing' && r.xp === null)).toEqual([]);
});
