import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createOperatorControl } from './operator-control';
import { defaultActivityCatalog } from '../brain/src/catalog';
import { GOAL_KINDS } from '../brain/src/contracts';

function fixture(readOnly = false) {
 const root = mkdtempSync(join(tmpdir(), 'atlas-control-'));
 const liveDir = join(root, '.practice', 'live');
 mkdirSync(liveDir, { recursive: true });
 writeFileSync(join(root, 'swarm.json'), JSON.stringify({ maxBots: 4, jobs: [] }));
 const handler = createOperatorControl({ root, readOnly, nonce: 'test-nonce', alive: () => false });
 const send = (body: any, headers: any = {}) =>
  handler(
   new Request('http://127.0.0.1:3100/api/control', {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:3100', 'x-atlas-control': 'test-nonce', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
   }),
   '127.0.0.1',
  );
 return { root, liveDir, handler, send, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('read-only dashboards expose metadata but refuse every command before writing', async () => {
 const f = fixture(true);
 try {
  const meta = (await (await f.handler(new Request('http://127.0.0.1:3100/api/control'), '127.0.0.1')).json()) as any;
  expect(meta.readOnly).toBe(true);
  expect(meta.goals).toEqual([...GOAL_KINDS]);
  for (const action of ['pause', 'resume', 'override-account', 'clear-defect', 'account-pause', 'account-release', 'request', 'swarm-pause', 'swarm-resume', 'job-enable', 'job-disable']) {
   expect((await f.send({ id: randomUUID(), action })).status).toBe(403);
  }
  expect(existsSync(join(f.root, '.practice/stop-swarm'))).toBe(false);
  expect(existsSync(join(f.root, '.practice/dashboard-controls'))).toBe(false);
 } finally {
  f.close();
 }
});

test('brain runtime presence reads .practice/live/swarm-owner.json independently of state freshness', async () => {
 const f = fixture();
 try {
  const handler = createOperatorControl({ root: f.root, alive: pid => pid === 42 });
  const meta = async () => (await (await handler(new Request('http://127.0.0.1:3100/api/control'), '127.0.0.1')).json()) as any;
  expect((await meta()).brainRunning).toBe(false);
  writeFileSync(join(f.liveDir, 'swarm-owner.json'), JSON.stringify({ pid: 42, at: 1 }));
  expect((await meta()).brainRunning).toBe(true);
  writeFileSync(join(f.liveDir, 'swarm-owner.json'), JSON.stringify({ pid: 43, at: 1 }));
  expect((await meta()).brainRunning).toBe(false);
 } finally {
  f.close();
 }
});

test('the metadata names the fleet agent and the swarm as never, down, running or stopped', async () => {
 const f = fixture();
 try {
  const handler = createOperatorControl({ root: f.root, alive: pid => pid === 42 });
  const states = async () =>
   ((await (await handler(new Request('http://127.0.0.1:3100/api/control'), '127.0.0.1')).json()) as any).controllers.map((c: any) => c.name + ' ' + c.state);
  expect(await states()).toEqual(['fleet-agent never', 'swarm never']);
  writeFileSync(join(f.root, '.practice/fleet-agent.log'), 'ran');
  expect(await states()).toEqual(['fleet-agent never', 'swarm never']);
  writeFileSync(join(f.root, '.practice/fleet-agent.launch.json'), JSON.stringify({ args: [], env: { DEMO_OK: '1' } }));
  writeFileSync(join(f.root, '.practice/swarm.launch.json'), JSON.stringify({ args: [join(f.root, 'swarm.json')], env: {} }));
  expect(await states()).toEqual(['fleet-agent down', 'swarm down']);
  writeFileSync(join(f.root, '.practice/fleet-agent.lock'), '42');
  writeFileSync(join(f.root, '.practice/stop-swarm'), '');
  expect(await states()).toEqual(['fleet-agent running', 'swarm stopped']);
  writeFileSync(join(f.root, '.practice/fleet-agent.lock'), '43');
  const meta = (await (await handler(new Request('http://127.0.0.1:3100/api/control'), '127.0.0.1')).json()) as any;
  expect(meta.controllers[0]).toMatchObject({ name: 'fleet-agent', label: 'Fleet agent', state: 'down' });
  expect(Object.keys(meta.controllers[0]).sort()).toEqual(['label', 'name', 'seenAt', 'state']);
 } finally {
  f.close();
 }
});

test('operator controls require loopback, same origin and the current session nonce', async () => {
 const f = fixture();
 try {
  expect((await f.handler(new Request('http://127.0.0.1:3100/api/control'), '10.0.0.1')).status).toBe(403);
  expect((await f.handler(new Request('http://rebound.invalid:3100/api/control'), '127.0.0.1')).status).toBe(403);
  for (const headers of [{ origin: 'https://other.test' }, { 'x-atlas-control': 'old' }]) {
   expect((await f.send({ id: randomUUID(), action: 'pause' }, headers)).status).toBe(403);
  }
  expect(existsSync(join(f.root, '.practice/stop-swarm'))).toBe(false);
 } finally {
  f.close();
 }
});

test('account controls only release dashboard holds, enqueue Brain commands, and retain other owners and failure evidence', async () => {
 const f = fixture();
 try {
  mkdirSync(join(f.root, 'vendor/rs-sdk/bots/Worker'), { recursive: true });
  writeFileSync(join(f.root, '.practice/failure-Worker'), 'retained');
  const pauseId = randomUUID();
  expect((await f.send({ id: pauseId, action: 'account-pause', account: 'Worker' })).status).toBe(200);
  expect(readFileSync(join(f.root, '.practice/stop-Worker'), 'utf8')).toStartWith('dashboard-stop:');
  expect(JSON.parse(readFileSync(join(f.liveDir, 'operator-commands', `${pauseId}.json`), 'utf8')).kind).toBe('pause_account');
  expect((await f.send({ id: randomUUID(), action: 'account-release', account: 'Worker' })).status).toBe(200);
  expect(readFileSync(join(f.root, '.practice/failure-Worker'), 'utf8')).toBe('retained');
  writeFileSync(join(f.root, '.practice/stop-Worker'), 'other owner');
  expect((await f.send({ id: randomUUID(), action: 'account-release', account: 'Worker' })).status).toBe(400);
  expect((await f.send({ id: randomUUID(), action: 'account-pause', account: '../escape' })).status).toBe(400);
  expect(readFileSync(join(f.root, '.practice/stop-Worker'), 'utf8')).toBe('other owner');
 } finally {
  f.close();
 }
});

test('override-account and clear-defect submit validated OperatorCommands idempotently and follow applied/rejected status', async () => {
 const f = fixture();
 try {
  mkdirSync(join(f.root, 'vendor/rs-sdk/bots/Worker'), { recursive: true });
  const activity = defaultActivityCatalog(f.root).list()[0];
  expect(activity).toBeDefined();
  const id = randomUUID();
  const payload = { id, action: 'override-account', account: 'Worker', activityId: activity!.id, durationMin: 15, reason: 'Operator focus' };
  expect((await f.send(payload)).status).toBe(200);
  expect((await f.send(payload)).status).toBe(200);
  expect((await f.send({ ...payload, reason: 'Changed' })).status).toBe(400);
  const cmdDir = join(f.liveDir, 'operator-commands');
  expect(readdirSync(cmdDir).filter(n => n.endsWith('.json'))).toHaveLength(1);
  const meta1 = (await (await f.handler(new Request('http://127.0.0.1:3100/api/control'), '127.0.0.1')).json()) as any;
  expect(meta1.requests.find((r: any) => r.id === id).status).toBe('submitted');
  expect(meta1.capabilities.length).toBeGreaterThan(0);

  mkdirSync(join(cmdDir, 'applied'), { recursive: true });
  writeFileSync(join(cmdDir, 'applied', `${id}.json`), JSON.stringify({ id, at: 1 }));
  const meta2 = (await (await f.handler(new Request('http://127.0.0.1:3100/api/control'), '127.0.0.1')).json()) as any;
  expect(meta2.requests.find((r: any) => r.id === id).status).toBe('accepted');

  expect((await f.send({ id: randomUUID(), action: 'override-account', account: 'Worker', activityId: 'nonexistent_activity' })).status).toBe(400);
  expect((await f.send({ id: randomUUID(), action: 'clear-defect', activityId: activity!.id })).status).toBe(200);
 } finally {
  f.close();
 }
});

test('side pause and resume use .practice/stop-swarm and retain account holds', async () => {
 const f = fixture();
 try {
  writeFileSync(join(f.root, '.practice/stop-Worker'), 'owner hold');
  expect((await f.send({ id: randomUUID(), action: 'pause' })).status).toBe(200);
  expect(existsSync(join(f.root, '.practice/stop-swarm'))).toBe(true);
  expect((await f.send({ id: randomUUID(), action: 'resume' })).status).toBe(200);
  expect(existsSync(join(f.root, '.practice/stop-swarm'))).toBe(false);
  expect(readFileSync(join(f.root, '.practice/stop-Worker'), 'utf8')).toBe('owner hold');
  writeFileSync(join(f.root, '.practice/stop-swarm'), 'manual stop');
  expect((await f.send({ id: randomUUID(), action: 'resume' })).status).toBe(400);
 } finally {
  f.close();
 }
});

test('override-account advertises Brain ACCOUNT_ROLES, persists valid roles, and rejects non-Brain roles', async () => {
 const f = fixture();
 try {
  mkdirSync(join(f.root, 'vendor/rs-sdk/bots/Worker'), { recursive: true });
  const meta = (await (await f.handler(new Request('http://127.0.0.1:3100/api/control'), '127.0.0.1')).json()) as any;
  expect(meta.roles).toEqual(['auto', 'army', 'helper', 'specialist']);

  const okId = randomUUID();
  const okRes = await f.send({ id: okId, action: 'override-account', account: 'Worker', role: 'army', durationMin: 20 });
  expect(okRes.status).toBe(200);
  const queued = JSON.parse(readFileSync(join(f.liveDir, 'operator-commands', `${okId}.json`), 'utf8'));
  expect(queued.role).toBe('army');

  for (const badRole of ['mining', 'main', 123]) {
   const badId = randomUUID();
   const res = await f.send({ id: badId, action: 'override-account', account: 'Worker', role: badRole, durationMin: 20 });
   expect(res.status).toBe(400);
   expect(existsSync(join(f.liveDir, 'operator-commands', `${badId}.json`))).toBe(false);
  }
 } finally {
  f.close();
 }
});

test('account holds and releases handle .practice/live/stop-* files and preserve non-dashboard holds', async () => {
 const f = fixture();
 try {
  mkdirSync(join(f.root, 'vendor/rs-sdk/bots/Worker'), { recursive: true });
  writeFileSync(join(f.liveDir, 'stop-Worker'), 'dashboard-stop:live-hold');
  const meta1 = (await (await f.handler(new Request('http://127.0.0.1:3100/api/control'), '127.0.0.1')).json()) as any;
  expect(meta1.accountHolds).toEqual([{ name: 'Worker', owner: 'dashboard' }]);

  const releaseId = randomUUID();
  expect((await f.send({ id: releaseId, action: 'account-release', account: 'Worker' })).status).toBe(200);
  expect(existsSync(join(f.liveDir, 'stop-Worker'))).toBe(false);

  writeFileSync(join(f.liveDir, 'stop-Worker'), 'owner live hold');
  const meta2 = (await (await f.handler(new Request('http://127.0.0.1:3100/api/control'), '127.0.0.1')).json()) as any;
  expect(meta2.accountHolds).toEqual([{ name: 'Worker', owner: 'other' }]);
  expect((await f.send({ id: randomUUID(), action: 'account-release', account: 'Worker' })).status).toBe(400);
  expect(existsSync(join(f.liveDir, 'stop-Worker'))).toBe(true);
 } finally {
  f.close();
 }
});

test('Brain receipt reconciliation distinguishes applied:false, tracks account/swarm commands, and allows idempotent re-enqueue', async () => {
 const f = fixture();
 try {
  mkdirSync(join(f.root, 'vendor/rs-sdk/bots/Worker'), { recursive: true });
  const cmdDir = join(f.liveDir, 'operator-commands');
  const appliedDir = join(cmdDir, 'applied');
  mkdirSync(appliedDir, { recursive: true });

  const noopId = randomUUID();
  const activity = defaultActivityCatalog(f.root).list()[0]!;
  expect((await f.send({ id: noopId, action: 'clear-defect', activityId: activity.id })).status).toBe(200);
  const queuedNoop = JSON.parse(readFileSync(join(cmdDir, `${noopId}.json`), 'utf8'));
  rmSync(join(cmdDir, `${noopId}.json`));
  writeFileSync(join(appliedDir, `${noopId}.json`), JSON.stringify({ ...queuedNoop, appliedAt: queuedNoop.issuedAt + 50, applied: false }));

  const pauseId = randomUUID();
  expect((await f.send({ id: pauseId, action: 'account-pause', account: 'Worker' })).status).toBe(200);
  const queuedPause = JSON.parse(readFileSync(join(cmdDir, `${pauseId}.json`), 'utf8'));
  rmSync(join(cmdDir, `${pauseId}.json`));
  writeFileSync(join(appliedDir, `${pauseId}.json`), JSON.stringify({ ...queuedPause, appliedAt: queuedPause.issuedAt + 50, applied: true }));

  const meta = (await (await f.handler(new Request('http://127.0.0.1:3100/api/control'), '127.0.0.1')).json()) as any;
  expect(meta.requests.find((r: any) => r.id === noopId).status).toBe('not-applied');
  expect(meta.requests.find((r: any) => r.id === pauseId).status).toBe('accepted');

  // Remove dashboard audit receipt to exercise enqueueCommand's own idempotency check against applied/<id>.json.
  rmSync(join(f.root, '.practice', 'dashboard-controls', `${noopId}.json`));
  const realNow = Date.now;
  Date.now = () => queuedNoop.issuedAt;
  try {
   expect((await f.send({ id: noopId, action: 'clear-defect', activityId: activity.id })).status).toBe(200);
   rmSync(join(f.root, '.practice', 'dashboard-controls', `${noopId}.json`));
   expect((await f.send({ id: noopId, action: 'clear-defect', activityId: activity.id, reason: 'different' })).status).toBe(400);
  } finally {
   Date.now = realNow;
  }
 } finally {
  f.close();
 }
});

test('main account commands are refused, stop files stay unchanged on enqueue conflicts, and rejection notes surface', async () => {
 const f = fixture();
 try {
  mkdirSync(join(f.root, 'vendor/rs-sdk/bots/Haggis'), { recursive: true });
  mkdirSync(join(f.root, 'vendor/rs-sdk/bots/Worker'), { recursive: true });
  writeFileSync(join(f.root, 'swarm.json'), JSON.stringify({ maxBots: 4, jobs: [{ account: 'Haggis', script: 'scripts/aio.ts', enabled: false }] }));

  for (const payload of [
   { id: randomUUID(), action: 'account-pause', account: 'Haggis' },
   { id: randomUUID(), action: 'account-release', account: 'haggis' },
   { id: randomUUID(), action: 'override-account', account: 'Haggis', role: 'army' },
   { id: randomUUID(), action: 'job-enable', account: 'Haggis' },
  ]) {
   const res = await f.send(payload);
   expect(res.status).toBe(400);
  }
  expect(existsSync(join(f.root, '.practice/stop-Haggis'))).toBe(false);

  const cmdDir = join(f.liveDir, 'operator-commands');
  mkdirSync(join(cmdDir, 'rejected'), { recursive: true });
  const conflictId = randomUUID();
  writeFileSync(join(cmdDir, `${conflictId}.json`), JSON.stringify({ schemaVersion: 1, id: conflictId, issuedAt: 1, issuedBy: 'dashboard', kind: 'clear_defect', activityId: 'other' }));
  expect((await f.send({ id: conflictId, action: 'account-pause', account: 'Worker' })).status).toBe(400);
  expect(existsSync(join(f.root, '.practice/stop-Worker'))).toBe(false);

  writeFileSync(join(f.root, '.practice/stop-Worker'), 'dashboard-stop:old');
  expect((await f.send({ id: conflictId, action: 'account-release', account: 'Worker' })).status).toBe(400);
  expect(existsSync(join(f.root, '.practice/stop-Worker'))).toBe(true);

  const pauseRes = await f.send({ id: randomUUID(), action: 'account-pause', account: 'Worker' });
  expect((await pauseRes.json() as any).status).toBe('already-held');

  const rejId = randomUUID();
  const activity = defaultActivityCatalog(f.root).list()[0]!;
  expect((await f.send({ id: rejId, action: 'clear-defect', activityId: activity.id })).status).toBe(200);
  rmSync(join(cmdDir, `${rejId}.json`));
  writeFileSync(join(cmdDir, 'rejected', `${rejId}.json`), JSON.stringify({ file: `${rejId}.json`, errors: ['defect not found'], rejectedAt: 2 }));
  const meta = (await (await f.handler(new Request('http://127.0.0.1:3100/api/control'), '127.0.0.1')).json()) as any;
  expect(meta.requests.find((r: any) => r.id === rejId)).toMatchObject({ status: 'rejected', note: 'defect not found' });
 } finally {
  f.close();
 }
});
