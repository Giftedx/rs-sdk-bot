import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idleReasons, tickWaste, wasteShare } from './tick-waste';

const ledger = 'LEDGER ticks=1000 move=100 anim=0 dialog=0 stun=0 idle=900';
const marker = (id: string) => 'SWARM_JOB ' + id.repeat(64);
function report(lines: string[], latest = false) {
    const dir = mkdtempSync(join(tmpdir(), 'tick-waste-'));
    writeFileSync(join(dir, 'account.log'), lines.join('\n') + '\n');
    return tickWaste(dir, { latest });
}

test('--latest counts each family only on the release of its newest run', () => {
    const run = (release: string | null, idle: number) => [marker('a'), ...(release ? ['START 1 2 0', `RELEASE ${release}`] : ['START 1 2 0']),
        `LEDGER ticks=1000 move=0 anim=0 dialog=0 stun=0 idle=${idle}`, 'RESULT fail feathers=2000 gained=0 kills=0 idle=0 ticks=2'];
    const lines = [...run(null, 900), ...run('aaaaaaaaaaaa', 800), ...run('bbbbbbbbbbbb', 100), ...run('bbbbbbbbbbbb', 300)];
    expect(report(lines).get('gather-feathers')?.idle).toBe(2100);
    expect(report(lines, true).get('gather-feathers')).toMatchObject({ runs: 2, idle: 400, release: 'bbbbbbbbbbbb' });
    // A run from before RELEASE lines in a new job is `unknown`, not the release of the job before it.
    expect(report([...run('cccccccccccc', 50), ...run(null, 70)], true).get('gather-feathers')).toMatchObject({ runs: 1, idle: 70, release: 'unknown' });
});

test('tick waste leaves a ledger unattributed if only the next job has a result', () => {
    const agg = report([marker('a'), ledger, marker('b'), 'RESULT ok coinsGained=10']);
    expect(agg.get('?')?.ticks).toBe(1000);
    expect(wasteShare(agg, 1).goldfarm).toBeUndefined();
});

test('the same job and legacy hosted output retain their existing family attribution', () => {
    for (const prefix of [[marker('a')], []]) {
        const agg = report([...prefix, '[Worker] ' + ledger, 'noise', '| [Worker] RESULT ok coinsGained=10']);
        expect(agg.get('goldfarm')).toEqual({runs:1,ticks:1000,idle:900,move:100,anim:0,stun:0,dialog:0,idleBy:{}});
    }
});

test('idle reasons of the LEDGER lines add up by family', () => {
    expect(idleReasons('LEDGER ticks=9 idle=5 longestIdle=3@t1(1,2) idleBy=combat:3,after:walkTo:2')).toEqual({combat: 3, 'after:walkTo': 2});
    expect(idleReasons(ledger)).toEqual({});
    const agg = report([marker('a'), ledger + ' idleBy=combat:600,bank:300', 'RESULT ok coinsGained=1', marker('b'), ledger + ' idleBy=combat:100', 'RESULT ok coinsGained=2']);
    expect(agg.get('goldfarm')?.idleBy).toEqual({combat: 700, bank: 300});
});
