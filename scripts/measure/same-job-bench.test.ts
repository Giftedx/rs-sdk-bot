import {expect, test} from 'bun:test';
import {benchCommand, resultRows, room} from './same-job-bench';
import {benchCases} from './aio-bench-cases';

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

test('the bench command of a case runs it also when the case is marked known', () => {
  const command = benchCommand('extra:same-jewel-legacy', '2');
  expect(command).toEqual(['bun', 'scripts/measure/aio-practice-bench.ts', '^extra:same-jewel-legacy$', '--all', '--seed', '2', '--parallel', '1']);
  // The case this guards: it is marked known, and the bench leaves such a case out with no `--all`.
  expect(benchCases().find(c => c.key === 'extra:same-jewel-legacy')?.known).toBeTruthy();
});

test('only a result row of the selected case counts as a run', () => {
  const row = (key: string) => `AIO_BENCH_RESULT ${JSON.stringify({case: key, ok: false, output: null, xp: null, result: null})}`;
  expect(resultRows(['AIO_BENCH_COVERAGE {}', row('extra:same-knights'), 'AIO_BENCH_SUMMARY {}'].join('\n'), 'extra:same-knights').map(r => r.case)).toEqual(['extra:same-knights']);
  expect(resultRows(['AIO_BENCH_COVERAGE {}', row('extra:same-knights')].join('\r\n'), 'extra:same-jewel-legacy')).toEqual([]);
  expect(resultRows('AIO_BENCH_COVERAGE {}\nAIO_BENCH_SUMMARY {}', 'extra:same-jewel-legacy')).toEqual([]);
});
