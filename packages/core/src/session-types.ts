import type { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import type { BotActions } from '../../../vendor/rs-sdk/sdk/actions';
import type { SessionAttempt } from './session-lifecycle';
import type { TickRecorder } from './tick-record';

export interface BankObservation {
    generation: number;
    at: number;
    items: { id: number; name: string; count: number }[];
}

export interface SessionCore {
    name: string;
    sdk: BotSDK;
    bot: BotActions;
    tick(): number;
    onTick(cb: () => void): () => void;
    direct(action: { type: string; [k: string]: unknown }): Promise<unknown>;
    close(): Promise<void>;
    ended: Promise<{ reason: string }>;
    // The LiteClient itself, for packets the action layer has no action for (quest-mm.ts: OPHELD5 on a puzzle
    // component). Absent on sessions that are not in-process.
    client?: unknown;
    // Local readiness contract; does not change the vendored SDK's state schema.
    bankObservation?(): BankObservation | null;
    // This session's own lifecycle attempt (session-lifecycle.ts). Absent on test doubles.
    lifecycle?: SessionAttempt;
    // Per-tick run record (tick-record.ts). Absent on test doubles.
    record?(recorder: TickRecorder | null): void;
}
