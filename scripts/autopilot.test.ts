import { expect, test } from 'bun:test';
import { catalogue, finishedTrainers, jobFor, mergeJobs, plan, type Acct, type Inputs } from '../packages/planner/src/autopilot';
import { missionSignature, startable } from './swarm';

const side = 'claude-cloud';
const inputs = (a: Acct): Inputs => ({ side, accounts: [a], owners: new Map([[a.name.toLowerCase(), { side }]]), bill: [], templates: catalogue(), prices: {} });
const settled = () => 60_000;

test('a trainer at its target stays ended for the swarm, and the next pass starts the account on its next template', () => {
    const fresh: Acct = { name: 'TrouserSnake', side, skills: { Hitpoints: 10 }, items: {} };
    const [first] = plan(inputs(fresh));
    const trainer = jobFor(first!, side);
    expect(trainer).toMatchObject({ template: 'thieving55', enabled: true, repeat: false, standing: true });

    // The trainer's ok RESULT: the supervisor ends done, and a job that does not repeat is blocked on that end.
    const ended = new Map([['TrouserSnake', { reason: 'done after 1 runs', at: 1000, revision: missionSignature(trainer) }]]);
    expect(startable(['TrouserSnake'], trainer.repeat, ended, settled, undefined, missionSignature(trainer)))
        .toEqual({ start: [], blocked: { TrouserSnake: 'ended: done after 1 runs' } });
    // The daemon sees the finish in the job's log since its assignment and passes without waiting for the timer.
    const assigned = { TrouserSnake: { template: 'thieving55', offset: 0 } };
    expect(finishedTrainers([trainer], side, assigned, catalogue(), () => ['RESULT ok thieving=55 xp=16000 ticks=1736 died=false'])).toEqual(['TrouserSnake']);

    // That pass reads the status at the target level: the trainer is skipped, a knight spot replaces it, and the new
    // mission starts although the account's last end is done.
    const [next] = plan(inputs({ ...fresh, skills: { ...fresh.skills, Thieving: 55 } }));
    expect(next!.template!.id).toMatch(/^goldfarm@/);
    const merged = mergeJobs([trainer], side, [next!]);
    expect(merged.fresh).toEqual(['TrouserSnake']);
    expect(merged.jobs).toEqual([jobFor(next!, side)]);
    expect(merged.jobs[0].repeat).toBe(true);
    expect(startable(['TrouserSnake'], merged.jobs[0].repeat, ended, settled, undefined, missionSignature(merged.jobs[0])).start).toEqual(['TrouserSnake']);
});
