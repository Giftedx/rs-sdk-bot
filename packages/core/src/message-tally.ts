// A count of game messages that does not stop at the client's window. The client publishes only the last 50 game
// messages (vendor/rs-sdk/server/webclient/src/bot/StateCollector.ts MAX_GAME_MESSAGES), so a count of matches inside
// that window stops rising once an old match drops out as a new one comes in. The tally keeps every message it reads.
// Read it each tick (`pull` in an onTick hook) so that no message passes through the window between two reads.
//
// Messages group by observationId (one publication can hold several), else by tick. The k-th message of a group is new
// when the group never held k messages before. Only the oldest group in the window can lose messages, and that lowers
// its count, never raises it.
export type TallyMessage = { type: number; text: string; tick: number; observationId?: number };

export function messageTally(read: () => readonly TallyMessage[] | undefined, type = 0) {
    const seen: string[] = [];
    const perGroup = new Map<string, number>();
    const pull = (): void => {
        const nth = new Map<string, number>();
        for (const m of read() ?? []) {
            if (m.type !== type) continue;
            const g = typeof m.observationId === 'number' ? `o${m.observationId}` : `t${m.tick}`;
            const k = (nth.get(g) ?? 0) + 1;
            nth.set(g, k);
            if (k > (perGroup.get(g) ?? 0)) { perGroup.set(g, k); seen.push(m.text); }
        }
    };
    const count = (re: RegExp): number => { pull(); return seen.filter(t => re.test(t)).length; };
    return { pull, count };
}
