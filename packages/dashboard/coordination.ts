import type { FleetState, PlannedStep } from '../brain/src/contracts';

function describeStep(step: PlannedStep): string {
 switch (step.stepKind) {
  case 'work':
   return step.activityId;
  case 'acquire':
   return `${step.source} ${step.itemName ?? step.itemId} ×${step.quantity}`;
  case 'gear_upgrade':
   return `upgrade ${step.slot} ${step.itemName ?? step.itemId}`;
  case 'unlock':
   return `unlock ${step.questSlug ?? step.skill ?? step.activityId}`;
  case 'recover':
   return `recover ${step.recoveryKind}: ${step.reason}`;
 }
}

// Read-only projection of Brain's FleetState (.practice/live/fleet-state.json).
export function coordinationView(state: unknown, at: number, now: number, paused = false) {
 const s = state as Partial<FleetState> | null;
 if (
  !s ||
  s.schemaVersion !== 1 ||
  !s.accounts ||
  typeof s.accounts !== 'object' ||
  Array.isArray(s.accounts) ||
  !s.activeChains ||
  typeof s.activeChains !== 'object' ||
  Array.isArray(s.activeChains)
 ) {
  return {
   available: false,
   at: null,
   fresh: false,
   ...(paused ? { paused: true } : {}),
   tasks: [] as any[],
   agents: [] as any[],
   counts: {} as Record<string, number>,
   activeChains: 0,
   goals: 0,
   defects: 0,
   infraOpen: false,
   chains: [] as { account: string; goal: string; step: string; demandId?: string; scorePerHour: number; running: boolean }[],
  };
 }

 const stampedAt = Number.isFinite(at) ? at : Number.isFinite(s.emittedAt) ? (s.emittedAt as number) : NaN;
 const fresh = Number.isFinite(stampedAt) && now >= stampedAt && now - stampedAt < 10_000;
 const goalsList = Array.isArray(s.goals) ? s.goals : [];
 const goalById = new Map(goalsList.map(g => [g.id, g]));
 const defectsList = Array.isArray(s.quarantinedDefects) ? s.quarantinedDefects : [];
 const chains: { account: string; goal: string; step: string; demandId?: string; scorePerHour: number; running: boolean }[] = [];
 const tasks: any[] = [];

 for (const [account, plan] of Object.entries(s.activeChains)) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) continue;
  const firstStep = plan.steps[0]!;
  const workStep = plan.steps.find(st => st.stepKind === 'work');
  const demandId = plan.demandId ?? workStep?.demandId;
  const goalRec = demandId ? goalById.get(demandId) : undefined;
  const goalLabel = goalRec?.goalKind ?? demandId ?? 'fleet';
  const step = describeStep(firstStep);
  const acct = s.accounts[account] ?? s.accounts[account.toLowerCase()];
  const running = Boolean(acct?.activeJob);
  const startedAt = acct?.activeJob?.startedAt;
  const capability = workStep?.activityId ?? (firstStep.stepKind === 'unlock' ? firstStep.activityId : undefined);
  const scorePerHour = typeof plan.scorePerHour === 'number' && Number.isFinite(plan.scorePerHour) ? plan.scorePerHour : 0;

  chains.push({
   account,
   goal: goalLabel,
   step,
   ...(demandId ? { demandId } : {}),
   scorePerHour,
   running,
  });

  tasks.push({
   id: `chain:${account}:${demandId ?? workStep?.activityId ?? firstStep.stepKind}`,
   goal: goalLabel,
   kind: firstStep.stepKind,
   status: running ? 'running' : 'pending',
   why: step,
   dependsOn: [] as string[],
   attempts: 0,
   ...(capability ? { capability } : {}),
   agent: 'brain',
   account,
   ...(startedAt != null ? { startedAt } : {}),
   detail: scorePerHour > 0 ? `${step} (${Math.round(scorePerHour)}/h)` : step,
  });
 }

 for (const d of defectsList) {
  if (!d || d.quarantined === false) continue;
  tasks.push({
   id: String(d.id),
   goal: 'defect',
   kind: d.outcomeKind,
   status: 'failed',
   why: d.faultSignature,
   dependsOn: [] as string[],
   attempts: typeof d.count === 'number' ? d.count : 1,
   capability: d.activityId,
   agent: 'brain',
   account: d.account,
   ...(d.observedAt != null ? { startedAt: d.observedAt } : {}),
   ...(d.quarantinedAt != null ? { finishedAt: d.quarantinedAt } : {}),
   ...(typeof d.detail === 'string' && d.detail ? { detail: d.detail } : {}),
  });
 }

 chains.sort((a, b) => Number(b.running) - Number(a.running) || a.account.localeCompare(b.account));
 const counts = Object.fromEntries(['running', 'pending', 'succeeded', 'failed'].map(status => [status, tasks.filter(t => t.status === status).length]));
 const agents = [{
  name: 'brain',
  tasks: tasks.filter(t => t.status === 'running').map(t => t.id),
  planning: !paused && !s.infraCircuitBreaker?.open,
  fresh,
  paused,
 }];

 return {
  available: true,
  at: Number.isFinite(stampedAt) ? stampedAt : null,
  fresh,
  paused,
  agents,
  tasks,
  counts,
  activeChains: chains.length,
  goals: goalsList.filter(g => g?.active).length,
  defects: defectsList.filter(d => d?.quarantined).length,
  campaigns: Array.isArray(s.campaigns) ? s.campaigns.map(c => ({ id: c.id, account: c.account, board: c.board, state: c.state })) : [],
  missions: Array.isArray(s.missions) ? s.missions.map(m => ({ id: m.id, state: m.state, participants: [...(m.participants ?? [])] })) : [],
  idleReasons: s.idleReasons && typeof s.idleReasons === 'object' ? { ...s.idleReasons } : {},
  infraOpen: Boolean(s.infraCircuitBreaker?.open),
  chains,
 };
}
