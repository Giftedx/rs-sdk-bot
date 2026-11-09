// A fake game that ticks on its own (every 1 ms) and applies bot commands on the next tick.
export function fakeGame(start: { x: number; z: number; level: number; hp?: number; maxHp?: number; inventory?: { slot: number; id: number; name: string; count: number }[]; nearbyLocs?: any[] }) {
    const st: any = {
        player: { worldX: start.x, worldZ: start.z, level: start.level },
        skills: [{ name: 'Hitpoints', level: start.hp ?? 10, baseLevel: start.maxHp ?? 10, experience: 0 }],
        inventory: start.inventory ?? [],
        nearbyLocs: start.nearbyLocs ?? [],
        opFeedback: { opRejectedCount: 0 },
    };
    let tick = 0;
    const listeners = new Set<() => void>();
    const pending: (() => void)[] = [];
    const calls: string[] = [];
    // Hooks so a test can make the next walk land off target, or a climb do nothing.
    const quirks = { walkOffBy: 0, climbFails: 0, climbDelayTicks: 0, doorShut: false, climbTo: null as null | { x: number; z: number; level: number },
        // What a direct loc click does (a scripted gate): open a dialogue, or move the player.
        onDirectLoc: null as null | ((a: any) => void) };
    const timer = setInterval(() => {
        tick++;
        for (const f of pending.splice(0)) f();
        for (const l of [...listeners]) l();
    }, 1);
    const g = {
        state: st,
        calls,
        quirks,
        sdk: {
            getState: () => ({ ...st, tick }),
            getDialog: () => st.dialog ?? { isOpen: false, isWaiting: false, options: [] },
            async sendClickDialog(i: number) { calls.push(`dialog ${i}`); pending.push(() => { st.dialog = null; }); },
        },
        async direct(a: any) {
            if (a.type === 'walkTo') return g.bot.walkTo(a.x, a.z);
            if (a.type === 'interactLoc') { calls.push(`direct interact ${a.x},${a.z} op${a.optionIndex}`); quirks.onDirectLoc?.(a); }
            return { success: true };
        },
        tick: () => tick,
        onTick(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
        bot: {
            async walkTo(x: number, z: number) {
                calls.push(`walk ${x},${z}`);
                const off = quirks.walkOffBy; quirks.walkOffBy = 0;
                pending.push(() => { st.player.worldX = x + off; st.player.worldZ = z; });
                return { success: true };
            },
            async openDoor(loc: any) {
                calls.push(`open ${loc?.x},${loc?.z}`);
                quirks.doorShut = false;
                return { success: true };
            },
            async interactLoc(loc: any, option: number) {
                calls.push(`interact ${loc?.x},${loc?.z} op${option}`);
                if (quirks.doorShut) return { success: false, message: "Can't reach Staircase" };
                if (quirks.climbFails > 0) { quirks.climbFails--; return { success: true }; }
                const to = quirks.climbTo;
                if (to) { const at = tick + quirks.climbDelayTicks; const apply = () => { if (tick >= at) { st.player.worldX = to.x; st.player.worldZ = to.z; st.player.level = to.level; } else pending.push(apply); }; pending.push(apply); }
                return { success: true };
            },
            async eatFood(re: RegExp) {
                calls.push('eat');
                const i = st.inventory.findIndex((it: any) => re.test(it.name));
                if (i >= 0) { st.inventory.splice(i, 1); pending.push(() => { st.skills[0].level = Math.min(st.skills[0].baseLevel, st.skills[0].level + 3); }); }
                return { success: i >= 0 };
            },
        },
        setHp(hp: number) { st.skills[0].level = hp; },
        stop() { clearInterval(timer); },
    };
    return g;
}
