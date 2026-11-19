import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beginSessionAttempt} from '../../core/src/session-lifecycle';
import {LIVE_SERVER,loginAfterOf} from '../src/login-attempts';

// The creation time of an attempt is the first 13 digits of its id. The lifecycle keeps a floor for it that is shared by
// each test file that runs in one process (createdAt = max(now(), floor)), so the test reads the time back and never
// assumes the time that it passed.
const createdAt = (attempt: { attemptId: string }) => Number(attempt.attemptId.slice(0, 13));

test('a login attempt after a time is read from the lifecycle pointer, and an unknown account cannot exclude one', () => {
 const root = mkdtempSync(join(tmpdir(), 'login-attempts-'));
 try {
  const lifecycle = join(root, '.practice', 'session-lifecycle');
  let now = 1_000_000;
  const hook = loginAfterOf(root, LIVE_SERVER, 30_000, () => now);
  // No record of the account: a newer attempt cannot be excluded. An invalid name is the same.
  expect(hook('Helper', 5_000)).toBe(true);
  expect(hook('bad name!!', 5_000)).toBe(true);
  // The newest attempt began at `first`.
  const first = createdAt(beginSessionAttempt({ account: 'Helper', server: LIVE_SERVER }, { root: lifecycle, now: () => 10_000 }));
  const fresh = loginAfterOf(root, LIVE_SERVER, 30_000, () => now);
  expect(fresh('Helper', first + 10_000)).toBe(false);   // a read after the newest attempt
  expect(fresh('Helper', first)).toBe(false);
  expect(fresh('helper', first - 1)).toBe(true);        // an attempt began after a read before it (name case is the same account)
  // A newer attempt is seen after the cache time, not before it.
  const second = createdAt(beginSessionAttempt({ account: 'Helper', server: LIVE_SERVER }, { root: lifecycle, now: () => first + 30_000 }));
  expect(second).toBe(first + 30_000);
  expect(fresh('Helper', first + 10_000)).toBe(false);
  now += 30_001;
  expect(fresh('Helper', first + 10_000)).toBe(true);
  expect(fresh('Helper', second)).toBe(false);
 } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
