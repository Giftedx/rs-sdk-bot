// Refresh one owned helper's state without travelling or changing its items.
import { openBot, finish } from '../packages/core/src/bot';
import { waitTicks } from '../packages/core/src/ticks';
const s = await openBot(process.argv[2]!);
try {
    await waitTicks(s, 5);
    const st = s.sdk.getState()!;
    console.log(`INSPECT ${JSON.stringify({ name: s.name, pos: st.player, skills: st.skills, inventory: st.inventory, npcs: st.nearbyNpcs.map(n => ({ name: n.name, x: n.x, z: n.z })), locs: st.nearbyLocs.filter(l => /bank|tree|flax|furnace|range|fireplace|stair|ladder/i.test(l.name)).map(l => ({ name: l.name, id: l.id, x: l.x, z: l.z, level: l.level, options:l.optionsWithIndex })) })}`);
    const bankNear = st.nearbyNpcs.some(n => /banker/i.test(n.name)) || st.nearbyLocs.some(l => /bank booth|bank chest/i.test(l.name));
    if (bankNear) {
        const opened = await s.bot.openBank();
        if (opened.success) { await waitTicks(s,2); console.log(`BANK ${JSON.stringify(s.sdk.getState()?.bank?.items)}`); await s.bot.closeBank(); }
    }
    await finish([s], true, 'inspection');
} catch (e) { await finish([s], false, String(e)); }
