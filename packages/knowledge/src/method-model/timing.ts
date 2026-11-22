import { block, find, findAll } from './content';
import { ACTIONS_PER_TICK, ACTIONS_PER_TICK_SRC, P_DELAY_SRC, WEAKQUEUE_SRC, pDelayTicks } from './rates';
import type { Content, Facts, Roll, Row, Timing } from './types';

export const facts = (o: Partial<Facts>): Facts => ({
    xpPerAction: null, xpSrc: null, xpNote: null, inputs: null, outputs: null,
    tools: [], level: null, levelSrc: null, timing: null, gaps: [], ...o,
});

export const tenths = (v: string) => Number(v) / 10;

export const rowCol = (row: Row | null, name: string, i = 0) => row?.data[name]?.[i];
export const rowColSrc = (row: Row | null, name: string, i = 0) => row?.src[name]?.[i] ?? null;
export const rowItems = (row: Row | null, name: string, count: number) => {
    const v = rowCol(row, name)?.[0];
    return v ? [{ debugname: v, count }] : null;
};

/** Combine partial rung facts with a resolved `Timing` or an error string gap. */
export function doneFacts(f: Partial<Facts>, t: Timing | string | null): Facts {
    const out = facts(f);
    if (typeof t === 'string') out.gaps.push(`ticks per action unknown: ${t}`);
    else out.timing = t;
    return out;
}

/** `p_delay` timing of one script block. `reclick`: the action ends and the next one needs a new client packet. */
export function pDelayTiming(c: Content, file: string, blockName: string, reclick: boolean, note: string): Timing | string {
    const hits = findAll(c, file, /p_delay\((\d+)\)/, blockName);
    if (!hits.length) return `no p_delay in [${blockName}] of ${file}`;
    const ticks = pDelayTicks(hits.map(h => Number(h.m[1])), reclick);
    return {
        basis: 'p_delay', ticksPerTry: ticks, rolls: [],
        note: `${hits.map(h => `p_delay(${h.m[1]})`).join(' + ')}${reclick ? ' + 1 refused decode' : ''} = ${ticks} ticks. ${note}`.trim(),
        src: [...hits.map(h => h.src), P_DELAY_SRC],
    };
}

/** An item action with no `p_delay` and no queue: 5 per tick. */
export function instantTiming(c: Content, file: string, blockName: string, note = ''): Timing | string {
    const b = block(c, file, blockName);
    if (!b) return `[${blockName}] not found in ${file}`;
    const delayed = findAll(c, file, /p_delay\(|weakqueue|queue\*?\(/, blockName);
    if (delayed.length) return `[${blockName}] in ${file} has a delay at ${delayed[0]!.src}`;
    return {
        basis: 'instant', ticksPerTry: 1 / ACTIONS_PER_TICK, rolls: [],
        note: `no p_delay or queue in [${blockName}]: up to ${ACTIONS_PER_TICK} actions per tick. ${note}`.trim(),
        src: [`${file}:${b.from + 1}`, ACTIONS_PER_TICK_SRC],
    };
}

/** A make-X loop that re-queues itself with weakqueue delay `d`: `d + 1` ticks per item. */
export function queueLoopTiming(c: Content, file: string, re: RegExp, note = ''): Timing | string {
    const h = find(c, file, re);
    if (!h) return `queue loop ${re} not found in ${file}`;
    const d = Number(h.m[1]);
    return {
        basis: 'queue-loop', ticksPerTry: d + 1, rolls: [],
        note: `make-X loop re-queues with delay ${d}: ${d + 1} ticks per item. ${note}`.trim(),
        src: [h.src, WEAKQUEUE_SRC],
    };
}

export const withRolls = (t: Timing | string, rolls: Roll[], note: string): Timing | string =>
    typeof t === 'string' ? t : { ...t, basis: 'roll', rolls, note: `${t.note} ${note}`.trim() };
