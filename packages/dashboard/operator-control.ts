// Operator requests write validated Brain OperatorCommands to .practice/live/operator-commands/
// and manage owned account/side stop files and swarm.json under the .practice/live lock.
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GOAL_KINDS, validateOperatorCommand, type OperatorCommand, type CampaignState, type MissionState } from '../brain/src/contracts';
import { defaultActivityCatalog } from '../brain/src/catalog';
import { mySide } from '../core/src/fleet';
import { NAMES } from '../core/src/names';
import { controllerStates } from '../core/src/controllers';
import { atomicJson } from '../core/src/plan-lock';
import { findStopFile, liveRoot, operatorCommandsDir, practiceRoot } from '../core/src/practice-paths';
import { appendOwnerRequest, applyCommand, validateCommand, REQUEST_MAX, HOLD_PREFIX } from './publish-commands';

export function createOperatorControl(options: { root: string; readOnly?: boolean; nonce?: string; alive?: (pid: number) => boolean }) {
 const { root } = options, nonce = options.nonce ?? randomUUID();
 const liveDir = liveRoot(root), commandsDir = operatorCommandsDir(root), audit = join(practiceRoot(root), 'dashboard-controls');
 const alive = options.alive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } });
 const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
 const owned = () => { const path = join(root, 'vendor/rs-sdk/bots'); return existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter(n => n.isDirectory() && /^[A-Za-z0-9]{1,12}$/.test(n.name)).map(n => n.name) : []; };
 const held = () => { let names: string[] = []; try { names = readdirSync(practiceRoot(root)); } catch { /* no folder yet */ } return names.filter(n => /^stop-[A-Za-z0-9]{1,12}$/.test(n)).map(n => n.slice(5)).filter(name => { try { return statSync(join(root, 'vendor/rs-sdk/bots', name)).isDirectory(); } catch { return false; } }); };

 function catalog() {
  return defaultActivityCatalog(root).list().map(a => ({
   id: a.id,
   goal: a.label,
   workerId: a.workerId,
   family: a.family,
   kind: a.kind,
   ...(a.skill ? { skill: a.skill } : {}),
   ...(a.questSlug ? { questSlug: a.questSlug } : {}),
   ...(a.spotId ? { spotId: a.spotId } : {}),
   trust: a.trust,
  }));
 }

 function enqueueCommand(cmd: OperatorCommand) {
  const errors = validateOperatorCommand(cmd);
  if (errors.length > 0) throw Error(errors.join('; '));
  const pendingFile = join(commandsDir, `${cmd.id}.json`);
  const appliedFile = join(commandsDir, 'applied', `${cmd.id}.json`);
  const rejectedFile = join(commandsDir, 'rejected', `${cmd.id}.json`);
  for (const candidate of [pendingFile, appliedFile]) {
   if (existsSync(candidate) && JSON.stringify(read(candidate)) !== JSON.stringify(cmd)) {
    throw Error('Command identity conflicts with existing operator command');
   }
  }
  if (!existsSync(pendingFile) && !existsSync(appliedFile) && !existsSync(rejectedFile)) {
   mkdirSync(commandsDir, { recursive: true });
   atomicJson(pendingFile, cmd);
  }
 }

 function metadata() {
  let brainRunning = false;
  try {
   const owner = read(join(liveDir, 'swarm-owner.json'));
   brainRunning = Number.isSafeInteger(owner.pid) && owner.pid > 0 && alive(owner.pid);
  } catch { /* owner file absent or unreadable */ }
  const controllers = controllerStates(root, { alive }).map(c => ({ name: c.name, label: c.label, state: c.state, seenAt: c.seenAt }));
  const stopped = Boolean(findStopFile('swarm', root));
  return {
   nonce,
   readOnly: !!options.readOnly,
   brainRunning,
   controllers,
   goals: [...GOAL_KINDS],
   roles: Object.keys(NAMES).filter(n => n !== 'main'),
   paused: stopped,
   fleetPaused: stopped,
   capabilities: catalog(),
   accountHolds: held().map(name => {
    let text = '';
    try { text = readFileSync(join(practiceRoot(root), 'stop-' + name), 'utf8'); } catch { /* gone */ }
    return { name, owner: text.startsWith(HOLD_PREFIX) ? 'dashboard' : 'other' };
   }),
   requests: existsSync(audit) ? readdirSync(audit).filter(n => /^[a-f0-9-]+\.json$/.test(n)).map(n => {
    try {
     const r = read(join(audit, n));
     const terminalFailure = ['refused', 'failed', 'rejected'].includes(r.status);
     const isCommandAction = ['override-account', 'clear-defect', 'set-campaign-state', 'set-mission-state', 'pause', 'resume', 'side-pause', 'side-resume'].includes(r.action);
     const status = isCommandAction && !terminalFailure
      ? (existsSync(join(commandsDir, 'applied', `${r.id}.json`)) ? 'accepted' : existsSync(join(commandsDir, 'rejected', `${r.id}.json`)) ? 'rejected' : existsSync(join(commandsDir, `${r.id}.json`)) ? 'submitted' : r.status)
      : r.status;
     const note = typeof r.note === 'string' ? r.note.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
     return { id: r.id, action: r.action, at: r.at, taskId: r.taskId ?? null, status, ...(note ? { note } : {}) };
    } catch { return null; }
   }).filter(r => r !== null).sort((a, b) => b.at - a.at).slice(0, 30) : [],
  };
 }

 return async (req: Request, remote: string) => {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return Response.json({ error: 'Local operator access only' }, { status: 403 });
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(req.url).hostname)) return Response.json({ error: 'Use the local dashboard address' }, { status: 403 });
  if (req.method === 'GET') return Response.json(metadata(), { headers: { 'cache-control': 'no-store' } });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (options.readOnly) return Response.json({ error: 'This dashboard is read-only; commands are disabled' }, { status: 403 });
  const url = new URL(req.url);
  if (req.headers.get('origin') !== url.origin || req.headers.get('x-atlas-control') !== nonce) {
   return Response.json({ error: 'Reload the local dashboard before sending a command' }, { status: 403 });
  }
  if (!req.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'JSON command required' }, { status: 415 });
  try {
   const bytes = await req.text();
   if (bytes.length > 32768) throw Error('Command exceeds 32 KiB');
   const input = JSON.parse(bytes), id = input.id;
   if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) throw Error('Command identity required');
   const action = input.action;
   const allowed = ['pause', 'resume', 'side-pause', 'side-resume', 'swarm-pause', 'swarm-resume', 'account-pause', 'account-release', 'override-account', 'clear-defect', 'set-campaign-state', 'set-mission-state', 'job-disable', 'job-enable', 'request'];
   if (!allowed.includes(action)) throw Error('Unknown operator command');
   mkdirSync(audit, { recursive: true });
   const receipt = join(audit, id + '.json');
   if (existsSync(receipt)) {
    const prior = read(receipt);
    if (prior.input !== bytes) throw Error('Command identity was already used for different input');
    return Response.json(prior);
   }
   const now = Date.now();
   let status: string | undefined;
   if (action === 'account-pause' || action === 'account-release') {
    if (typeof input.account !== 'string' || !/^[A-Za-z0-9]{1,12}$/.test(input.account) || !owned().includes(input.account)) {
     throw Error('Choose an owned account');
    }
    const file = join(practiceRoot(root), 'stop-' + input.account);
    if (action === 'account-pause') {
     mkdirSync(practiceRoot(root), { recursive: true });
     if (!existsSync(file)) writeFileSync(file, HOLD_PREFIX + id, { flag: 'wx' });
     enqueueCommand({ schemaVersion: 1, id, issuedAt: now, issuedBy: 'dashboard', kind: 'pause_account', account: input.account, reason: HOLD_PREFIX + id });
     status = 'stop-requested';
    } else {
     if (!existsSync(file) || !readFileSync(file, 'utf8').startsWith(HOLD_PREFIX)) {
      throw Error('This hold belongs elsewhere; inspect it before changing it');
     }
     unlinkSync(file);
     enqueueCommand({ schemaVersion: 1, id, issuedAt: now, issuedBy: 'dashboard', kind: 'resume_account', account: input.account, ...(input.clearDead === true ? { clearDead: true } : {}) });
     status = 'dashboard-hold-released';
    }
   } else if (action === 'pause' || action === 'resume' || ['swarm-pause', 'swarm-resume', 'side-pause', 'side-resume', 'job-disable', 'job-enable'].includes(action)) {
    const mapped = action === 'pause' ? 'side-pause' : action === 'resume' ? 'side-resume' : action;
    const cmd = validateCommand({ id, action: mapped, at: now, account: input.account });
    if (cmd.account && !owned().includes(cmd.account)) throw Error('Choose an owned account');
    const out = await applyCommand(cmd, { root, now });
    if (out.status === 'refused') throw Error(out.note ?? 'Refused');
    status = out.status;
   } else if (action === 'override-account') {
    if (typeof input.account !== 'string' || !/^[A-Za-z0-9]{1,12}$/.test(input.account) || !owned().includes(input.account)) {
     throw Error('Choose an owned account');
    }
    const activityId = input.activityId;
    if (activityId !== undefined && activityId !== null) {
     if (typeof activityId !== 'string' || !activityId.trim()) throw Error('Invalid activityId');
     if (!defaultActivityCatalog(root).has(activityId)) throw Error(`Unknown activity "${activityId}"`);
    }
    const mins = typeof input.durationMin === 'number' && Number.isFinite(input.durationMin) ? Math.max(1, Math.min(1440, input.durationMin)) : 30;
    enqueueCommand({
     schemaVersion: 1,
     id,
     issuedAt: now,
     issuedBy: 'dashboard',
     kind: 'override_account',
     account: input.account,
     ...(activityId !== undefined ? { activityId } : {}),
     ...(typeof input.role === 'string' && Object.hasOwn(NAMES, input.role) && input.role !== 'main' ? { role: input.role as any } : {}),
     expiresAt: now + mins * 60_000,
     ...(typeof input.reason === 'string' && input.reason.trim() ? { reason: input.reason.trim().slice(0, 200) } : {}),
    });
    status = 'submitted';
   } else if (action === 'clear-defect') {
    if (typeof input.activityId !== 'string' || !input.activityId.trim()) throw Error('Activity ID is required');
    enqueueCommand({
     schemaVersion: 1,
     id,
     issuedAt: now,
     issuedBy: 'dashboard',
     kind: 'clear_defect',
     activityId: input.activityId.trim(),
     ...(typeof input.defectId === 'string' && input.defectId.trim() ? { defectId: input.defectId.trim() } : {}),
     ...(typeof input.faultSignature === 'string' && input.faultSignature.trim() ? { faultSignature: input.faultSignature.trim() } : {}),
     ...(typeof input.reason === 'string' && input.reason.trim() ? { reason: input.reason.trim().slice(0, 200) } : {}),
    });
    status = 'submitted';
   } else if (action === 'set-campaign-state') {
    enqueueCommand({
     schemaVersion: 1,
     id,
     issuedAt: now,
     issuedBy: 'dashboard',
     kind: 'set_campaign_state',
     campaignId: String(input.campaignId ?? ''),
     state: input.state as CampaignState,
     ...(typeof input.reason === 'string' && input.reason.trim() ? { reason: input.reason.trim().slice(0, 200) } : {}),
    });
    status = 'submitted';
   } else if (action === 'set-mission-state') {
    enqueueCommand({
     schemaVersion: 1,
     id,
     issuedAt: now,
     issuedBy: 'dashboard',
     kind: 'set_mission_state',
     missionId: String(input.missionId ?? ''),
     state: input.state as MissionState,
     ...(typeof input.reason === 'string' && input.reason.trim() ? { reason: input.reason.trim().slice(0, 200) } : {}),
    });
    status = 'submitted';
   } else if (action === 'request') {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > REQUEST_MAX) {
     throw Error(`A request needs text of up to ${REQUEST_MAX} characters`);
    }
    appendOwnerRequest(root, input.text);
    status = 'request-recorded';
   }

   const result = { id, action, at: now, status: status ?? 'submitted', input: bytes };
   atomicJson(receipt, result);
   return Response.json(result);
  } catch (error) {
   return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
 };
}
