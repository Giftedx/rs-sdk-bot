import { expect, test } from 'bun:test';
import { goalTraining, ROLE_SKILL } from './server/config';

test('a "train <skill> to <level>" goal names its skill and level; other goals name none', () => {
    expect(goalTraining('train Prayer to 99 burying trooper bones on the field')).toEqual({ skill: 'Prayer', level: 99 });
    expect(goalTraining('Train defence to 70 on the Khazard troopers')).toEqual({ skill: 'Defence', level: 70 });
    for (const goal of ['aio logistics', 'train Sailing to 99', 'train Prayer to 1', 'train Prayer to 120', null, undefined, ''])
        expect(goalTraining(goal)).toBeNull();
});

test('every skill-named role maps to its skill, and the combat role to Attack', () => {
    expect(ROLE_SKILL).toMatchObject({ ranged: 'Ranged', prayer: 'Prayer', magic: 'Magic', attack: 'Attack', herblore: 'Herblore', thieving: 'Thieving', combat: 'Attack' });
    expect(ROLE_SKILL.helper).toBeUndefined();
    expect(ROLE_SKILL.bank).toBeUndefined();
});
