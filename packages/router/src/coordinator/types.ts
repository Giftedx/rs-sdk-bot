import type {DeliveryTask} from '../delivery';
export {boundAccounts} from '../../../core/src/coordinator-accounts';

export const GOALS=['wealth','skills','quests','gear','specialists','main24'] as const;
export type GoalId=typeof GOALS[number];
export type Effect={skills?:Record<string,number>;bank?:Record<string,number>;quests?:string[];counters?:Record<string,number>};
export interface CoordTask {
 id:string;goal:GoalId;kind:'build'|'qualify'|'provision'|'run'|'review';dependsOn:string[];
 priority:number;estimatedMs:number;why:string;capability?:string;
 account?:string;accountFrom?:string;role?:string;env?:Record<string,string>;
 participants?:string[];args?:string[];acceptIndex?:number;
 accept?:Effect;timeoutMs?:number;
 launch?:'ordinary'|'specialist'|'main';
 repairs?:{account:string;endedAt:number}[];
 sessionRecovery?:{account:string;endedAt:number};
 agent?:'codex'|'claude';
 // Explicit continuation only: rerun delivery and review without changing this exact prepared source.
 resumeSource?:string;
 // Build only: command types whose replay difference is this build's stated change (model-worker.ts reviewGate).
 replayAllow?:string[];
 // Build only: the observation this build has that the failed builds lacked. It passes one repeated-fault hold.
 newEvidence?:string;
 /** Set when a deterministic rule (coordinator-rules.ts) created the task. */
 rule?:'next-band';
}
export interface Receipt {taskId:string;runId:string;ok:boolean;at:number;output:any;error?:string}
export interface TaskRecord {
 spec:CoordTask;status:'pending'|'running'|'succeeded'|'failed'|'superseded';createdAt:number;attempts:number;supersededBy?:string;
 runId?:string;startedAt?:number;pid?:number;receipt?:Receipt;
 /** latestReceiptSequence when this receipt settled: a value above plannerReceiptSequence is an outcome no plan saw. */
 receiptSequence?:number;
 agent?:'codex'|'claude';
}
/** A settled gameplay effect, distinct from a recovery login or native proof. */
export function usefulLiveReceipt(record:TaskRecord,now:number):Receipt|undefined{
 const receipt=record.receipt;
 if(record.spec.kind==='run'&&!record.spec.sessionRecovery&&record.status==='succeeded'&&record.runId
  &&receipt?.taskId===record.spec.id&&receipt.runId===record.runId&&receipt.ok===true
  &&receipt.output?.ok===true&&receipt.output.evidence==='live'&&Number.isFinite(receipt.at)&&receipt.at>0&&receipt.at<=now)return receipt;
}
export type CapabilityChange={definition:DeliveryTask;expectedSource:string|null};
export interface CoordinatorState {
 version:1;sequence:number;tasks:TaskRecord[];
 goals:{id:GoalId;lastStartedAt:number;lastSucceededAt:number;completedTasks:number}[];
 planner?:{runId:string;startedAt:number;pid?:number;agent?:'codex'|'claude'};lastPlanAt:number;lastPlanReason:string;
 /** Failed planning rounds in a row (planRetryMs, coordinator-decisions.ts). */
 planFailures?:number;
 /** The newest model proposal that validation refused, until a proposal is accepted. The next planner prompt names it. */
 rejectedPlan?:{runId:string;error:string};
 latestReceiptSequence?:number; plannerReceiptSequence?:number;
 pendingSubmission?:{sha256:string;capabilities:CapabilityChange[]}&({file:string}|{runId:string;count:number});
}
export const NEW_EVIDENCE_MAX=500;
// Finished tasks older than this leave state.json for the archive. Their receipts hold most of the file's bytes.
export const ARCHIVE_AFTER_MS=2*24*60*60*1000;
export const finishedAt=(r:TaskRecord)=>r.receipt?.at??r.startedAt??r.createdAt;
export function initialState():CoordinatorState{
 return{version:1,sequence:0,tasks:[],goals:GOALS.map(id=>({id,lastStartedAt:0,lastSucceededAt:0,completedTasks:0})),lastPlanAt:0,lastPlanReason:'bootstrap'};
}
export function provisionRefs(task:CoordTask):string[]{
 return [...(task.accountFrom?[task.accountFrom]:[]),...(task.participants??[]).filter(n=>n.startsWith('@')).map(n=>n.slice(1))];
}
