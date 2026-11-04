// Measures run-record cost on a synthetic skilling hour: 6,000 ticks of a full-size bot state (28 inventory slots,
// 23 skills, 25 moving NPCs, 10 players, 80 locs, 100 game messages), xp and an item every 4 ticks.
//   bun packages/core/src/tick-record-measure.ts <out-dir>
import { statSync } from 'node:fs';
import { createTickRecorder } from './tick-record';

const root = process.argv[2];
if (!root) throw new Error('usage: bun packages/core/src/tick-record-measure.ts <out-dir>');
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const state = (t: number) => ({
    tick: t, revision: t, inGame: true,
    player: { name: 'Fixture', worldX: 3200 + (t >> 6) % 8, worldZ: 3200, level: 0, animId: t % 4 ? 879 : -1, hp: 10, combatLevel: 3, runEnergy: 100 - t % 100 },
    skills: range(23).map(i => ({ name: 'Skill' + i, level: 10, baseLevel: 10, experience: i === 8 ? Math.floor(t / 4) * 25 : 1154 })),
    inventory: range(Math.min(28, 1 + (t >> 2) % 28)).map(i => ({ slot: i, id: 1511, name: 'Logs', count: 1, optionsWithIndex: [{ text: 'Use', opIndex: 1 }, { text: 'Drop', opIndex: 5 }] })),
    equipment: range(3).map(i => ({ slot: i, id: 1351 + i, name: 'Bronze axe', count: 1 })),
    nearbyNpcs: range(25).map(i => ({ index: i, name: 'Man', combatLevel: 2, x: 3200 + ((i + t) % 9), z: 3200 + i % 7, distance: (i + t) % 9, hp: 7, maxHp: 7, healthPercentage: null, inCombat: false, options: ['Talk-to', 'Attack', 'Pickpocket'], optionsWithIndex: [{ text: 'Talk-to', opIndex: 1 }, { text: 'Attack', opIndex: 2 }] })),
    nearbyPlayers: range(10).map(i => ({ index: i, name: 'Player' + i, combatLevel: 30, x: 3205 + ((i * 3 + t) % 5), z: 3205, distance: 5 })),
    nearbyLocs: range(80).map(i => ({ id: 1276, name: 'Tree', x: 3190 + i % 20, z: 3190 + (i / 20 | 0), distance: i % 15, options: ['Chop down'], optionsWithIndex: [{ text: 'Chop down', opIndex: 1 }] })),
    groundItems: range(6).map(i => ({ id: 526, name: 'Bones', count: 1, x: 3201 + i, z: 3201, distance: i })),
    gameMessages: range(100).map(i => ({ type: 0, text: 'You get some logs.', sender: '', tick: t - ((t / 10 | 0) % 100) - i })),
    recentDialogs: [], dialog: { isOpen: false, options: [], isWaiting: false, text: null },
    interface: { isOpen: false, interfaceId: 0, options: [] }, shop: { isOpen: false, items: [] }, bank: { isOpen: false, items: [] },
    modalOpen: false, modalInterface: -1, combatEvents: [], prayers: { activePrayers: [], prayerPoints: 1 },
    opFeedback: { opRejectedCount: 0, lastOpTick: t - t % 4 },
});
const ticks = 6000;
const rec = createTickRecorder({ account: 'fixture', server: 'localhost:8888', script: 'scripts/measure.ts', argv: [], startedAt: Date.now() }, { root, env: {} })!;
let collect = 0;
const cpu0 = process.cpuUsage();
for (let t = 1; t <= ticks; t++) {
    const start = performance.now();
    const s = state(t);
    collect += performance.now() - start;
    rec.publish(t, s, 's');
    if (t % 4 === 0) { rec.action(t, t, { type: 'interactLoc', x: 3190, z: 3190, locId: 1276, option: 1, reason: 'SDK' }, false); rec.result(t + 1, t, { success: true, message: 'chopped' }); }
}
const st = rec.stats();
rec.end(ticks, 'measure');
await new Promise(r => setTimeout(r, 500));
const cpu = process.cpuUsage(cpu0), processCpuMs = (cpu.user + cpu.system) / 1000 - collect;
const gz = statSync(rec.file).size, fullJson = JSON.stringify(state(ticks)).length;
console.log(JSON.stringify({ ticks, fullStateBytes: fullJson, rawBytes: st.rawBytes, gzipBytes: gz, recordCpuMs: Math.round(st.cpuMs), cpuMsPerTick: +(st.cpuMs / ticks).toFixed(3), processCpuMsPerTick: +(processCpuMs / ticks).toFixed(3), file: rec.file }));
