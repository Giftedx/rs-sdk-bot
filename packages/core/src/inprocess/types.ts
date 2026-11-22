import type { BotSDK } from '../../../../vendor/rs-sdk/sdk/index';
import type { FleetTradeClaim } from '../fleet-trade-claim';
import type { ProgressionSession } from '../progression-session';
import type { BankObservation, SessionCore } from '../session-types';
import type { TickRecorder } from '../tick-record';

export type { BankObservation, SessionCore } from '../session-types';

export interface ClientLike {
    collectBotState(tick: number): unknown;
    executeBotAction(action: unknown): unknown | Promise<unknown>;
    setOnGameTickCallback(cb: (() => void) | null): void;
    pumpPackets?(): Promise<void>;
    flush?(): void;
    writeOpcode?(opcode: number): void;
    getMaxMessageLength?(): number;
    ifMutable?(id: number): unknown;
    ptype0?: number;
    packetsReceived?: number;
    mainModalId?: number;
}

export interface Shim {
    start(): void;
    stop(reason: string): void;
    tick(): number;
    onTick(cb: () => void): () => void;
    bankObservation(): BankObservation | null;
    // Sends one action straight to the client, skipping the queue (used for logout, which must not wait
    // behind a slow or stuck action).
    direct(action: { type: string; [k: string]: unknown }): Promise<unknown>;
    // Starts the per-tick run record (tick-record.ts) from the next publication; null stops it.
    record(recorder: TickRecorder | null): void;
    setProgressionGuard(guard: (action: unknown) => string | null): void;
}

export interface Session extends SessionCore {
    progression?: ProgressionSession;
}

export type FetchRow = { url: string | null; status?: number; length?: string | null; error?: string; ms: number };

export type TradeAdmission = {
    orderId: string;
    role: FleetTradeClaim['role'];
    check(server: string): void;
    prepare(claim: FleetTradeClaim): void;
};

export type StartSession = (o: any) => Promise<{ client: unknown; stop(): void; stopped: Promise<unknown> }>;
