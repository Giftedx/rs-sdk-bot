// Native practice proof: a full-health fighter with 28 pack slots uses its worn glory to leave level 23.
import {openBot, finish} from '../../packages/core/src/bot';
import {tickWaits} from '../../packages/core/src/tick-stream';
import {fightPlayer, ITEMS, nextTick, wildernessLevel} from '../pk';

const [name, targetName] = process.argv.slice(2);
if (!name || !targetName) throw Error('runner and target required');
tickWaits.active++;
const runner = await openBot(name);
const target = await openBot(targetName, {onStop: async () => {}});
tickWaits.active--;
let done = false;
const idle = (async () => {while (!done && await nextTick(target)) { /* Keep the lockstep target waiting. */ }})();
const before = runner.sdk.getState()!;
const foodBefore = before.inventory.filter(i => i.id === ITEMS.shark).reduce((n, i) => n + i.count, 0);
const items = (state: typeof before) => [...state.inventory, ...state.equipment];
const kept = items(before).filter(i => i.id !== ITEMS.shark && !(ITEMS.glory as readonly number[]).includes(i.id));
const result = await fightPlayer(runner, targetName, {kit: {}, flee: true, cap: 30});
const after = runner.sdk.getState()!;
const foodDebit = foodBefore - after.inventory.filter(i => i.id === ITEMS.shark).reduce((n, i) => n + i.count, 0);
const glories = items(after).filter(i => (ITEMS.glory as readonly number[]).includes(i.id));
const assetsPreserved = kept.every(i => items(after).filter(j => j.id === i.id).reduce((n, j) => n + j.count, 0)
    === kept.filter(j => j.id === i.id).reduce((n, j) => n + j.count, 0));
const ok = before.inventory.length === 28 && before.player?.hp === before.player?.maxHp && result.outcome === 'escaped'
    && result.eaten === 1 && foodDebit === 1 && glories.length === 1 && glories[0]!.id === 1710 && assetsPreserved
    && after.player?.lifeId === before.player?.lifeId && (after.player?.hp ?? 0) > 0
    && wildernessLevel(after.player?.worldZ ?? 0) === 0 && Math.abs((after.player?.worldX ?? 0) - 3087) <= 10
    && Math.abs((after.player?.worldZ ?? 0) - 3496) <= 10;
done = true;
await Promise.race([idle, new Promise(resolve => setTimeout(resolve, 2000))]);
console.log('PK_ESCAPE_PROOF ' + JSON.stringify({ok, outcome: result.outcome, ticks: result.ticks, packBefore: before.inventory.length,
    foodDebit, glory: glories[0]?.id, assetsPreserved, at: [after.player?.worldX, after.player?.worldZ]}));
await finish([runner, target], ok, `pk-escape full-pack ${result.outcome} foodDebit=${foodDebit} assetsPreserved=${assetsPreserved}`);
