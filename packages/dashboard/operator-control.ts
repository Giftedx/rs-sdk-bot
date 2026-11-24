// Operator requests write validated Brain OperatorCommands to .practice/live/operator-commands/
// and manage owned account/side stop files and swarm.json under the .practice/live lock.
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ACCOUNT_ROLES, GOAL_KINDS, type AccountRole, type OperatorCommand, type CampaignState, type MissionState } from '../brain/src/contracts';
import { defaultActivityCatalog, type ActivityCatalog } from '../brain/src/catalog';
import { controllerStates } from '../core/src/controllers';
import { atomicJson } from '../core/src/plan-lock';
import { findStopFile, listStopEntries, liveRoot, operatorCommandsDir, practiceRoot } from '../core/src/practice-paths';
import { appendOwnerRequest, applyCommand, enqueueBrainCommand, existingStopFiles, validateCommand, REQUEST_MAX, HOLD_PREFIX } from './publish-commands';
import { MAIN_ACCOUNT } from './publish-relay';

const OVERRIDE_ROLES = ACCOUNT_ROLES.filter((role): role is Exclude<AccountRole, 'main'> => role !== 'main');
const TERMINAL_AUDIT_STATUSES = new Set(['refused', 'failed', 'rejected', 'not-applied']);
const COMMAND_AUDIT_ACTIONS = new Set([
    'override-account', 'clear-defect', 'set-campaign-state', 'set-mission-state',
    'pause', 'resume', 'side-pause', 'side-resume',
    'swarm-pause', 'swarm-resume', 'account-pause', 'account-release',
]);
const catalogViewCache = new WeakMap<ActivityCatalog, {
    id: string;
    goal: string;
    workerId: string;
    family: string;
    kind: string;
    skill?: string;
    questSlug?: string;
    spotId?: string;
    trust: string;
}[]>();

export function createOperatorControl(options: { root: string; readOnly?: boolean; nonce?: string; alive?: (pid: number) => boolean }) {
 const { root } = options, nonce = options.nonce ?? randomUUID();
 const liveDir = liveRoot(root), commandsDir = operatorCommandsDir(root), audit = join(practiceRoot(root), 'dashboard-controls');
 const alive = options.alive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } });
 const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
 const botsDir = join(root, 'vendor/rs-sdk/bots');
 let cachedOwned: { mtimeMs: number; size: number; ino: number; names: string[] } | null = null;
 const owned = (): string[] => {
  let st;
  try { st = statSync(botsDir); } catch { cachedOwned = null; return []; }
  const nowWall = Date.now();
  if (
   cachedOwned
   && nowWall - st.mtimeMs > 1000
   && cachedOwned.mtimeMs === st.mtimeMs
   && cachedOwned.size === st.size
   && cachedOwned.ino === st.ino
  ) {
   return cachedOwned.names;
  }
  const names: string[] = [];
  for (const entry of readdirSync(botsDir, { withFileTypes: true })) {
   if (entry.isDirectory() && /^[A-Za-z0-9]{1,12}$/.test(entry.name)) names.push(entry.name);
  }
  cachedOwned = { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, names };
  return names;
 };
 const auditJsonCache = new Map<string, { mtimeMs: number; size: number; doc: any }>();
 const readAuditJson = (file: string, nowWall: number): any | null => {
  try {
   const st = statSync(file);
   const hit = auditJsonCache.get(file);
   if (hit && nowWall - st.mtimeMs > 1000 && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return hit.doc;
   }
   const doc = JSON.parse(readFileSync(file, 'utf8'));
   if (auditJsonCache.size >= 500) auditJsonCache.clear();
   auditJsonCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, doc });
   return doc;
  } catch {
   return null;
  }
 };
 const resolveOwned = (rawAccount: unknown): string => {
  if (typeof rawAccount !== 'string' || !/^[A-Za-z0-9]{1,12}$/.test(rawAccount)) throw Error('Choose an owned account');
  if (rawAccount.toLowerCase() === MAIN_ACCOUNT.toLowerCase()) throw Error('The main account is not controlled from the dashboard');
  const match = owned().find(n => n.toLowerCase() === rawAccount.toLowerCase());
  if (!match) throw Error('Choose an owned account');
  return match;
 };
 const accountHolds = () => {
  const ownedByLower = new Map(owned().map(name => [name.toLowerCase(), name]));
  const holds = new Map<string, { name: string; owner: 'dashboard' | 'other' }>();
  for (const entry of listStopEntries(root)) {
   if (entry.location === 'sim' || !/^[A-Za-z0-9]{1,12}$/.test(entry.flag)) continue;
   const lower = entry.flag.toLowerCase(), name = ownedByLower.get(lower);
   if (!name) continue;
   const owner: 'dashboard' | 'other' = entry.text.startsWith(HOLD_PREFIX) ? 'dashboard' : 'other';
   const prior = holds.get(lower);
   holds.set(lower, { name, owner: prior?.owner === 'other' || owner === 'other' ? 'other' : 'dashboard' });
  }
  return [...holds.values()].sort((a, b) => a.name.localeCompare(b.name));
 };

 function catalog() {
  const cat = defaultActivityCatalog(root);
  let cached = catalogViewCache.get(cat);
  if (!cached) {
   cached = cat.list().map(a => ({
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
   catalogViewCache.set(cat, cached);
  }
  return cached;
 }

 function enqueueCommand(cmd: OperatorCommand) {
  const err = enqueueBrainCommand(root, cmd);
  if (err) throw Error(err === 'command identity conflicts with existing operator command' ? 'Command identity conflicts with existing operator command' : err);
 }

 function metadata() {
  let brainRunning = false;
  try {
   const owner = read(join(liveDir, 'swarm-owner.json'));
   brainRunning = Number.isSafeInteger(owner.pid) && owner.pid > 0 && alive(owner.pid);
  } catch { /* owner file absent or unreadable */ }
  const controllers = controllerStates(root, { alive }).map(c => ({ name: c.name, label: c.label, state: c.state, seenAt: c.seenAt }));
  const stopped = Boolean(findStopFile('swarm', root));
  let requests: { id: unknown; action: unknown; at: number; taskId: unknown; status: unknown; note?: string }[] = [];
  if (existsSync(audit)) {
   const nowWall = Date.now();
   const parsed: any[] = [];
   for (const n of readdirSync(audit)) {
    if (!/^[a-f0-9-]+\.json$/.test(n)) continue;
    const r = readAuditJson(join(audit, n), nowWall);
    if (r) parsed.push(r);
   }
   parsed.sort((a, b) => b.at - a.at);
   const top = parsed.slice(0, 30);
   requests = top.map(r => {
    const terminalFailure = TERMINAL_AUDIT_STATUSES.has(r.status);
    const isCommandAction = COMMAND_AUDIT_ACTIONS.has(r.action);
    let status = r.status;
    let rawNote = typeof r.note === 'string' ? r.note : '';
    if (isCommandAction && !terminalFailure) {
     const appliedPath = join(commandsDir, 'applied', `${r.id}.json`);
     const rejectedPath = join(commandsDir, 'rejected', `${r.id}.json`);
     const pendingPath = join(commandsDir, `${r.id}.json`);
     let resolved = false;
     try {
      const appliedDoc = read(appliedPath);
      status = appliedDoc?.applied === false ? 'not-applied' : 'accepted';
      resolved = true;
     } catch {
      if (existsSync(appliedPath)) {
       status = 'accepted';
       resolved = true;
      }
     }
     if (!resolved) {
      try {
       const rejectedDoc = read(rejectedPath);
       status = 'rejected';
       resolved = true;
       if (!rawNote) {
        if (typeof rejectedDoc?.error === 'string' && rejectedDoc.error.trim()) rawNote = rejectedDoc.error;
        else if (Array.isArray(rejectedDoc?.errors) && rejectedDoc.errors.length) rawNote = rejectedDoc.errors.map(String).join('; ');
       }
      } catch {
       if (existsSync(rejectedPath)) {
        status = 'rejected';
        resolved = true;
       }
      }
     }
     if (!resolved && existsSync(pendingPath)) {
      status = 'submitted';
     }
    }
    const note = rawNote.replace(/\s+/g, ' ').trim().slice(0, 200);
    return { id: r.id, action: r.action, at: r.at, taskId: r.taskId ?? null, status, ...(note ? { note } : {}) };
   });
  }
  return {
   nonce,
   readOnly: !!options.readOnly,
   brainRunning,
   controllers,
   goals: [...GOAL_KINDS],
   roles: [...OVERRIDE_ROLES],
   paused: stopped,
   fleetPaused: stopped,
   capabilities: catalog(),
   accountHolds: accountHolds(),
   requests,
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
    const account = resolveOwned(input.account);
    const file = join(practiceRoot(root), 'stop-' + account);
    if (action === 'account-pause') {
     if (findStopFile(account, root)) {
      status = 'already-held';
     } else {
      enqueueCommand({ schemaVersion: 1, id, issuedAt: now, issuedBy: 'dashboard', kind: 'pause_account', account, reason: HOLD_PREFIX + id });
      mkdirSync(practiceRoot(root), { recursive: true });
      writeFileSync(file, HOLD_PREFIX + id, { flag: 'wx' });
      status = 'stop-requested';
     }
    } else {
     const existing = existingStopFiles(root, account);
     if (!existing.length || existing.some(p => !readFileSync(p, 'utf8').startsWith(HOLD_PREFIX))) {
      throw Error('This hold belongs elsewhere; inspect it before changing it');
     }
     enqueueCommand({ schemaVersion: 1, id, issuedAt: now, issuedBy: 'dashboard', kind: 'resume_account', account, ...(input.clearDead === true ? { clearDead: true } : {}) });
     for (const p of existing) unlinkSync(p);
     status = 'dashboard-hold-released';
    }
   } else if (action === 'pause' || action === 'resume' || ['swarm-pause', 'swarm-resume', 'side-pause', 'side-resume', 'job-disable', 'job-enable'].includes(action)) {
    const mapped = action === 'pause' ? 'side-pause' : action === 'resume' ? 'side-resume' : action;
    const account = input.account != null ? resolveOwned(input.account) : undefined;
    const cmd = validateCommand({ id, action: mapped, at: now, ...(account !== undefined ? { account } : {}) });
    const out = await applyCommand(cmd, { root, now });
    if (out.status === 'refused') throw Error(out.note ?? 'Refused');
    status = out.status;
   } else if (action === 'override-account') {
    const account = resolveOwned(input.account);
    const activityId = input.activityId;
    if (activityId !== undefined && activityId !== null) {
     if (typeof activityId !== 'string' || !activityId.trim()) throw Error('Invalid activityId');
     if (!defaultActivityCatalog(root).has(activityId)) throw Error(`Unknown activity "${activityId}"`);
    }
    let role: Exclude<AccountRole, 'main'> | undefined;
    if (input.role !== undefined && input.role !== null && input.role !== '') {
     if (typeof input.role !== 'string' || !(OVERRIDE_ROLES as readonly string[]).includes(input.role)) {
      throw Error(`Invalid role "${String(input.role)}"`);
     }
     role = input.role as Exclude<AccountRole, 'main'>;
    }
    const mins = typeof input.durationMin === 'number' && Number.isFinite(input.durationMin) ? Math.max(1, Math.min(1440, input.durationMin)) : 30;
    enqueueCommand({
     schemaVersion: 1,
     id,
     issuedAt: now,
     issuedBy: 'dashboard',
     kind: 'override_account',
     account,
     ...(activityId !== undefined ? { activityId } : {}),
     ...(role ? { role } : {}),
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
