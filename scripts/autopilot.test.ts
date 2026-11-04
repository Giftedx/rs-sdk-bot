import { expect, test } from 'bun:test';
import { catalogue, jobFor, plan, type Acct } from '../packages/planner/src/autopilot';
import { missionSignature, startable } from './swarm';

const side = 'claude-cloud';
const acct = (name: string, skills: Record<string, number> = {}): Acct => ({ name, side, skills: { Hitpoints: 10, ...skills }, items: {} });
const inputs = (accounts: Acct[]) => ({ side, accounts, owners: new Map(accounts.map(a => [a.name.toLowerCase(), { side }])), bill: [], templates: catalogue(), prices: {} });

test('a finished training job is not restarted by the swarm; the job its level unlocks starts', () => {
    const [train] = plan(inputs([acct('Fresh')]));
    const trainer = jobFor(train!, side);
    expect(trainer).toMatchObject({ template: 'thieving55', repeat: false, standing: true });
    // The supervisor's end for the trainer's ok RESULT, recorded against the trainer's mission.
    const ended = new Map([['Fresh', { at: 1000, reason: 'done after 1 runs', revision: missionSignature(trainer as any) }]]);
    const settled = () => 60_000;
    expect(startable(['Fresh'], trainer.repeat, ended, settled, undefined, missionSignature(trainer as any))).toEqual({ start: [], blocked: { Fresh: 'ended: done after 1 runs' } });
    // The next pass sees Thieving 55 in the status file and hands the account a knight spot: a changed mission starts.
    const [next] = plan(inputs([acct('Fresh', { Thieving: 55 })]));
    const goldfarm = jobFor(next!, side);
    expect(goldfarm).toMatchObject({ script: 'scripts/goldfarm.ts', repeat: true });
    expect(startable(['Fresh'], goldfarm.repeat, ended, settled, undefined, missionSignature(goldfarm as any))).toEqual({ start: ['Fresh'], blocked: {} });
});
