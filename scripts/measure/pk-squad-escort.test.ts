import { describe, expect, test } from 'bun:test';
import { benchCases, escortPass } from './aio-bench-cases';

describe('escort bench case', () => {
    const c = benchCases().find(k => k.key === 'extra:escort-keep-5-x1')!;
    test('the walker is the account of the run, then five of ours and the three clones', () => {
        expect(c.script).toBe('scripts/measure/pk-squad-escort.ts');
        expect(c.presetConfig!.position).toEqual({ x: 2619, z: 3332, level: 0 });
        expect(c.companions!.map(k => k.suffix)).toEqual('bcdefghi'.split(''));
        expect(c.scriptArgs.slice(0, 8)).toEqual('bcdefghi'.split('').map(l => `{bot:${l}}`));
        // The last three companions are the clones on the gang's post.
        for (const k of c.companions!.slice(5)) expect(k.presetConfig!.position).toMatchObject({ x: 3078, z: 3640 });
        expect(c.scriptArgs).not.toContain('squad');
        for (const a of ['SQUAD_GANG=3', 'MAX_MINUTES=20', 'STALL_TICKS=0', 'ESCORT_WALK_TICKS=300', 'SQUAD_GANG_HUNT=1', 'SQUAD_GANG_SPLIT=1']) expect(c.scriptArgs).toContain(a);
        expect(c.scriptArgs.filter(a => /^(MAX_MINUTES|STALL_TICKS)=/.test(a))).toEqual(['MAX_MINUTES=20', 'STALL_TICKS=0']);
    });
    const line = (o: string) => `[aiob] ESCORT clear after 412 ticks: goondelf dead\nRESULT ok squad accounts=5 kills=3 died=0 hold=1\nRESULT ${o}\n`;
    const okLine = 'ok escort gate=open enteredAt=470 stood=300 walkerHits=0 walkerTaken=0 walkerDied=false walkerNpcTaken=0 walkerMinHp=99 walkerAt=3155,3924 squadOk=true squadDied=0 entered="a" | squad accounts=5 kills=3 died=0 hold=1';
    test('pass: the gate opened, no player hit the walker, no death', () => {
        expect(escortPass(line(okLine))).toBe(true);
        expect(escortPass(line(okLine.replace('walkerHits=0', 'walkerHits=2')))).toBe(false);
        expect(escortPass(line(okLine.replace('walkerDied=false', 'walkerDied=true')))).toBe(false);
        expect(escortPass(line(okLine.replace('squadDied=0', 'squadDied=1')))).toBe(false);
        expect(escortPass(line(okLine.replace('ok escort gate=open', 'fail escort gate=escort_not_clear')))).toBe(false);
        // The gate's own line must be in the output: a walker that went in with no gate does not pass.
        expect(escortPass(line(okLine).replace(/^.*ESCORT clear.*\n/, ''))).toBe(false);
    });
});
