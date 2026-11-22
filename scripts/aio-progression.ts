// Pass-through shim retained while aio-fighter transitions away from legacy progression selection.
import type { Step } from '../packages/core/src/chain-step';

export interface AioProgressionContext {
    status?: any;
    catalog?: unknown;
    accept?: unknown;
    now?: number;
    intentTarget?: number;
}

export interface AioProgressionDecisionSummary {
    state?: string;
    selected?: string;
    basis?: string;
    expectedTicks?: number;
}

export interface AioProgressionChoice {
    step: Step | null;
    decision: AioProgressionDecisionSummary | null;
    reason: string;
    changed: boolean;
    blocked?: boolean;
}

export function selectAioProgression(
    _account: string,
    step: Step,
    _env: Record<string, string | undefined>,
    _context: AioProgressionContext = {},
    _readStatus = true,
): AioProgressionChoice {
    return { step, decision: null, reason: 'Retaining authored AIO step', changed: false };
}
