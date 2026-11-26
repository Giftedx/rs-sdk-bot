import type { Session } from './inprocess';
import { componentId } from './logout';

export type JournalQuestReader = {
    s: {
        client?: Session['client'];
        sdk: { getDialog(): { isOpen?: boolean } | null | undefined };
        direct: Session['direct'];
    };
    waitUntil: (f: () => boolean, ticks: number) => Promise<boolean>;
};

// The journal text without colour tags (@dbl@, @str@), markup and line breaks (|), with single spaces.
export function journalText(body: string): string {
    return body.replace(/@[a-z0-9]+@/gi, '').replace(/<[^>]*>/g, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
}

// Reads the live quest journal modal (interface 8134) when the server does not transmit the quest varp.
// Closes any open modal first, opens questlist:<questKey>, parses the journal text, and closes the modal.
export async function readQuestJournalStage<T>(
    q: JournalQuestReader,
    questKey: string,
    titleRe: RegExp,
    parseStage: (body: string) => T | undefined,
): Promise<T> {
    const c = q.s.client as any;
    if (!c) throw Error(`${questKey} journal client unavailable`);
    const close = async () => {
        if (c.mainModalId !== -1) await q.s.direct({ type: 'closeModal', reason: 'SDK' });
        if (!await q.waitUntil(() => c.mainModalId === -1, 5)) throw Error(`${questKey} journal close unobserved`);
    };
    if (q.s.sdk.getDialog()?.isOpen) throw Error(`${questKey} journal blocked by dialogue`);
    await close();
    await q.s.direct({ type: 'clickComponent', componentId: componentId(`questlist:${questKey}`), reason: 'SDK' });
    let stage: T | undefined;
    const seen = await q.waitUntil(() => {
        if (c.mainModalId !== 8134 || !titleRe.test(c.ifType(8144)?.text ?? '')) return false;
        const body = Array.from({ length: 50 }, (_, i) => c.ifType(8145 + i + (i > 0 ? 1 : 0))?.text ?? '').join(' ');
        stage = parseStage(body);
        return stage !== undefined;
    }, 10);
    await close();
    if (!seen || stage === undefined) throw Error(`${questKey} stage unobserved within deadline`);
    return stage;
}
