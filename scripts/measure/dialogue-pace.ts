// Dialogue pace benchmark on Father Aereck's welcome talk (areas/area_lumbridge/scripts/father_aereck.rs2): choices
// "Who's Saradomin?", "Oh, sorry. I'm not from this world.", "You don't understand. This is a computer game!" give
// 13 continue pages in blocks of 1, 5, 4, 3 between 3 choices: 16 pages, the talk Cairn filmed (research/
// community-and-upstream.md section 7). The talk repeats while %prieststart is 0.
// Modes (DIALOG_MODE): converse = quest-lib.ts converse (await each click, wait a tick when the tick did not move);
// tick = answer each new page from the tick callback; burst = from the tick callback, the whole block of continues as
// raw RESUME_PAUSEBUTTON packets (at most 5 a tick, the USER_EVENT cap), then the choice when it shows.
// ResumePauseButtonHandler.ts resumes any paused script, with no page id check, so a blind burst is valid.
// Usage: bun scripts/measure/dialogue-pace.ts <bot> [talks=3] [converse|tick|burst] (or DIALOG_MODE)
import { openBot, finish } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';
import { ClientProt } from '../../vendor/rs-sdk/server/webclient/src/io/ClientProt';

const [bot, talksArg, modeArg] = process.argv.slice(2);
const MODE = modeArg ?? process.env.DIALOG_MODE ?? 'converse';
const TALKS = Number(talksArg ?? 3);
const AERECK = { x: 3243, z: 3208 };
const CHOICES = [/who's saradomin/i, /not from this world/i, /computer game/i];
const BLOCKS = [1, 5, 4, 3];
const RESUME = ClientProt.RESUME_PAUSEBUTTON;
if (!['converse', 'tick', 'burst'].includes(MODE)) throw new Error(`DIALOG_MODE ${MODE}`);

const s = await openBot(bot!);
try {
    await waitTicks(s, 3);
    const dialog = (): any => s.sdk.getDialog();
    const open = (): boolean => !!dialog()?.isOpen;
    const choice = (): any => (dialog()?.options ?? []).find((o: any) => CHOICES.some(re => re.test(o.text)));
    // One answer per page: a page that is still showing next tick was already answered.
    // getDialog().text is often empty (quest-lib.ts pageText), so the key also holds every component's text.
    const key = (): string => { const d = dialog(); return [d?.text ?? '', ...(d?.allComponents ?? []).map((c: any) => c.text ?? ''), ...(d?.options ?? []).map((o: any) => o.text)].join('|'); };
    const aereck = (): any => (s.sdk.getState()?.nearbyNpcs ?? []).find((n: any) => /^father aereck$/i.test(n.name));
    await s.bot.walkTo(AERECK.x, AERECK.z);
    const ticks: number[] = [];
    let clicks = 0;
    for (let talk = 1; talk <= TALKS; talk++) {
        const n = aereck();
        if (!n) throw new Error('Father Aereck not in view');
        const op = n.optionsWithIndex?.find((o: any) => /talk/i.test(o.text))?.opIndex ?? 1;
        await s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: op, reason: 'SDK' });
        if (!await waitUntil(s, open, { timeoutTicks: 30 })) throw new Error(`talk ${talk}: no dialog`);
        const tOpen = s.tick();
        let block = 0, left = BLOCKS[0]!, closedAt = -1, answered = '';
        const off = MODE === 'converse' ? () => {} : s.onTick(() => {
            const d = dialog();
            if (!d?.isOpen) { if (closedAt < 0) closedAt = s.tick(); return; }
            closedAt = -1;
            if (d.isWaiting || answered === key()) return;
            const c = choice();
            if (c) { answered = key(); clicks++; block++; left = BLOCKS[block] ?? 0; void s.sdk.sendClickDialog(c.index); return; }
            if (MODE === 'tick') { answered = key(); clicks++; void s.sdk.sendClickDialog(0); return; }
            const client: any = s.client;
            const k = Math.min(5, left);
            if (!client || k <= 0 || client.chatModalId === -1) return;
            for (let i = 0; i < k; i++) { client.writeOpcode(RESUME); client.out.p2(client.chatModalId); }
            client.flush?.();
            answered = key(); clicks += k; left -= k;
        });
        if (MODE === 'converse') {
            while (s.tick() - tOpen < 120) {
                const d = dialog();
                if (!d?.isOpen) { if (closedAt < 0) closedAt = s.tick(); if (s.tick() - closedAt >= 3) break; await waitTicks(s, 1); continue; }
                closedAt = -1;
                if (!d.isWaiting) {
                    const before = s.tick();
                    const c = choice();
                    clicks++;
                    await s.sdk.sendClickDialog(c ? c.index : 0);
                    if (s.tick() !== before) continue;
                }
                await waitTicks(s, 1);
            }
        } else await waitUntil(s, () => closedAt >= 0 && s.tick() - closedAt >= 3, { timeoutTicks: 120 });
        off();
        if (closedAt < 0) throw new Error(`talk ${talk}: dialog still open after 120 ticks`);
        ticks.push(closedAt - tOpen);
        console.log(`CYCLE talk=${talk} mode=${MODE} ticks=${closedAt - tOpen}`);
        await waitTicks(s, 2);
    }
    const mean = ticks.reduce((a, b) => a + b, 0) / ticks.length;
    await finish([s], true, `dialogue mode=${MODE} talks=${TALKS} pages=16 ticks=${ticks.join(',')} mean=${mean.toFixed(1)} perPage=${(mean / 16).toFixed(2)} clicks=${clicks}`);
} catch (e) { await finish([s], false, String(e)); }
