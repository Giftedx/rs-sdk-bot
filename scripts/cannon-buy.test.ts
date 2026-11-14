import { expect, test } from 'bun:test';
import { CANNON_PRICE, NULODION_DOOR, buyCannon } from './cannon-fight';

// A fake Nulodion: the porch door, then his post-quest talk (nulodion.rs2:56-76, 145-160) as pages of options.
function fixture(coins: number) {
    let tick = 0;
    const listeners = new Set<() => void>(), sent: string[] = [], walks: number[][] = [];
    const inv: any[] = [{ id: 995, name: 'Coins', count: coins, slot: 0 }];
    const position = { worldX: NULODION_DOOR.x + 1, worldZ: NULODION_DOOR.z, level: 0 };
    let page: { text: string; options: { index: number; text: string }[] } | null = null;
    const pages: Record<string, { text: string; options: string[] }> = {
        hello: { text: 'Hello traveller', options: ['I was hoping you might sell me a cannon?', 'Well, take care of yourself then.', 'I want to know more about the cannon.', "I've lost my cannon."] },
        price: { text: 'For the full set up... 750,000 coins.', options: ["Ok, I'll take a cannon please.", 'Can I look at the separate parts please?', "Sorry, that's too much for me.", 'Have you any ammo or instructions to sell?'] },
    };
    const show = (k: string) => { const p = pages[k]!; page = { text: p.text, options: p.options.map((text, i) => ({ index: i + 1, text })) }; };
    const timer = setInterval(() => { tick++; for (const f of [...listeners]) f(); }, 1);
    const s: any = {
        tick: () => tick,
        onTick: (f: () => void) => { listeners.add(f); return () => listeners.delete(f); },
        sdk: {
            getState: () => ({
                player: position,
                nearbyLocs: [{ id: NULODION_DOOR.id, x: NULODION_DOOR.x, z: NULODION_DOOR.z, optionsWithIndex: [{ text: 'Open', opIndex: 1 }] }],
                nearbyNpcs: position.worldX < NULODION_DOOR.x ? [{ index: 7, name: 'Nulodion', optionsWithIndex: [{ text: 'Talk-to', opIndex: 1 }, { text: 'Trade', opIndex: 3 }] }] : [],
            }),
            getInventory: () => inv,
            getDialog: () => page ? { isOpen: true, isWaiting: false, text: page.text, options: page.options, allComponents: [] } : { isOpen: false, isWaiting: false, options: [] },
            sendClickDialog: async (i: number) => {
                const text = page?.options.find(o => o.index === i)?.text ?? 'continue';
                sent.push(text);
                if (/sell me a cannon/.test(text)) show('price');
                else if (/take a cannon please/.test(text)) {
                    const c = inv.find(r => r.id === 995)!;
                    if (c.count < CANNON_PRICE) page = { text: "Oops, I don't have enough money.", options: [] };
                    else {
                        c.count -= CANNON_PRICE;
                        for (const [n, id] of [['Cannon base', 6], ['Cannon stand', 8], ['Cannon barrels', 10], ['Cannon furnace', 12], ['Ammo mould', 4], ['Instruction manual', 5]] as const) inv.push({ id, name: n, count: 1, slot: inv.length });
                        page = null;
                    }
                } else page = null;
                return { success: true };
            },
        },
        direct: async (a: any) => {
            sent.push(`${a.type}:${a.locId ?? a.npcIndex}`);
            if (a.type === 'interactNpc') show('hello');
            return { success: true };
        },
        bot: { walkTo: async (x: number, z: number) => { position.worldX = x; position.worldZ = z; return { success: true }; } },
    };
    return { s, inv, sent, walks, walk: async (to: { x: number; z: number }) => { walks.push([to.x, to.z]); return true; }, dispose: () => clearInterval(timer) };
}

test('buyCannon opens the porch door, asks for the full set and holds the four parts and the mould', async () => {
    const f = fixture(760_000);
    try {
        const r = await buyCannon(f.s, { walk: f.walk });
        expect(r).toEqual({ ok: true, detail: 'bought' });
        expect(f.walks[0]).toEqual([NULODION_DOOR.x, NULODION_DOOR.z]);
        expect(f.sent.slice(0, 4)).toEqual([`interactLoc:${NULODION_DOOR.id}`, 'interactNpc:7', 'I was hoping you might sell me a cannon?', "Ok, I'll take a cannon please."]);
        expect(f.inv.find(i => i.id === 995).count).toBe(10_000);
        expect(f.inv.map(i => i.id).sort((a, b) => a - b)).toEqual([4, 5, 6, 8, 10, 12, 995]);
    } finally { f.dispose(); }
});

test('buyCannon reports a partial kit with its missing parts, and a full kit as held, with no walk', async () => {
    const f = fixture(760_000);
    try {
        f.inv.push({ id: 6, name: 'Cannon base', count: 1, slot: 1 }, { id: 10, name: 'Cannon barrels', count: 1, slot: 2 });
        expect(await buyCannon(f.s, { walk: f.walk })).toEqual({ ok: false, detail: 'incomplete cannon in the pack: missing cannon stand, cannon furnace' });
        f.inv.push({ id: 8, name: 'Cannon stand', count: 1, slot: 3 }, { id: 12, name: 'Cannon furnace', count: 1, slot: 4 });
        expect(await buyCannon(f.s, { walk: f.walk })).toEqual({ ok: true, detail: 'cannon already in the pack' });
        expect(f.walks).toEqual([]);
    } finally { f.dispose(); }
});

test('buyCannon refuses before any walk with fewer than 750,000 coins', async () => {
    const f = fixture(749_999);
    try {
        const r = await buyCannon(f.s, { walk: f.walk });
        expect(r.ok).toBe(false);
        expect(r.detail).toBe('749999 coins in the pack, 750000 needed');
        expect(f.walks).toEqual([]);
    } finally { f.dispose(); }
});
