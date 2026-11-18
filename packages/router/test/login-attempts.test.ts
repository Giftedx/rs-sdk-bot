import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beginSessionAttempt} from '../../core/src/session-lifecycle';
import {LIVE_SERVER,loginAfterOf} from '../src/login-attempts';

test('a login attempt after a time is read from the lifecycle pointer, and an unknown account cannot exclude one', () => {
 const root = mkdtempSync(join(tmpdir(), 'login-attempts-'));
 try {
  const lifecycle = join(root, '.practice', 'session-lifecycle');
  let now = 1_000_000;
  const hook = loginAfterOf(root, LIVE_SERVER, 30_000, () => now);
  // No record of the account: a newer attempt cannot be excluded. An invalid name is the same.
  expect(hook('Helper', 5_000)).toBe(true);
  expect(hook('bad name!!', 5_000)).toBe(true);
  // The newest attempt began at 10_000.
  beginSessionAttempt({ account: 'Helper', server: LIVE_SERVER }, { root: lifecycle, now: () => 10_000 });
  const fresh = loginAfterOf(root, LIVE_SERVER, 30_000, () => now);
  expect(fresh('Helper', 20_000)).toBe(false);   // the read at 20_000 came after the newest attempt
  expect(fresh('Helper', 10_000)).toBe(false);
  expect(fresh('helper', 9_999)).toBe(true);     // an attempt began after a read at 9_999 (name case is the same account)
  // A newer attempt is seen after the cache time, not before it.
  beginSessionAttempt({ account: 'Helper', server: LIVE_SERVER }, { root: lifecycle, now: () => 40_000 });
  expect(fresh('Helper', 20_000)).toBe(false);
  now += 30_001;
  expect(fresh('Helper', 20_000)).toBe(true);
  expect(fresh('Helper', 40_000)).toBe(false);
 } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
