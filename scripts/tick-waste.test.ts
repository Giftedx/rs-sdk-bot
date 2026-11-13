import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idleReasons, tickWaste, wasteShare } from './tick-waste';

const ledger = 'LEDGER ticks=1000 move=100 anim=0 dialog=0 stun=0 idle=900';
const marker = (id: string) => 'SWARM_JOB ' + id.repeat(64);
function report(lines: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'tick-waste-'));
    writeFileSync(join(dir, 'account.log'), lines.join('\n') + '\n');
    return tickWaste(dir);
}

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
