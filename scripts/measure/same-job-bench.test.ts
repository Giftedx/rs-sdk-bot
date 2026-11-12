import {expect, test} from 'bun:test';
import {room} from './same-job-bench';

const files = (freeGB: unknown, tasks: unknown) => (path: string) =>
  JSON.stringify(path.endsWith('swarm-state.json') ? {freeGB} : {tasks});
const run = {spec: {id: 'run-a', capability: 'cook-stock'}, status: 'running'};
const recovery = (status: string) => ({spec: {id: 'run-session-recovery-a', capability: 'session-recovery-only'}, status});

test('room needs free memory and no open session recovery', () => {
  expect(room('main', 12, files(9.5, [run, recovery('success')])).ok).toBe(true);
  expect(room('main', 12, files(9.5, [run, recovery('pending')]))).toMatchObject({ok: false, recoveries: ['pending:run-session-recovery-a']});
  expect(room('main', 12, files(9.5, [run, recovery('running')])).ok).toBe(false);
  expect(room('main', 12, files(7.9, [run])).ok).toBe(false);
  expect(room('main', 7.9, files(9.5, [run])).ok).toBe(false);
});

test('a state the check cannot read is no room', () => {
  // The capability of a task is under `spec`; a task list with the field at the top level is an unknown shape.
  expect(room('main', 12, files(9.5, [{capability: 'session-recovery-only', status: 'pending'}])).ok).toBe(false);
  expect(room('main', 12, files('9.5', [run])).ok).toBe(false);
  expect(room('main', 12, () => '{').ok).toBe(false);
});
