// Runecraft ladder: XP per essence from skill_runecraft/configs/runecraft.dbrow (tenths, x25 server rate).
// Cycle per pack from knowledge/rates.json craft_air_runes_trade_loop: 19 ticks (12 trade + 7 craft).
import { xpForLevel } from '../packages/planner/src/curve';
const ALTARS: [string, number, number][] = [['air', 1, 50], ['water', 5, 60], ['earth', 9, 65], ['fire', 14, 70], ['body', 20, 75], ['cosmic', 27, 80], ['chaos', 35, 85], ['nature', 44, 90], ['law', 54, 95], ['death', 65, 100]];
const CYCLE = 19;
function run(allowed: string[], ess: number) {
    let t = 0;
    for (let l = 1; l < 99; l++) {
        const best = ALTARS.filter(a => allowed.includes(a[0]) && a[1] <= l).sort((a, b) => b[2] - a[2])[0]!;
        t += (xpForLevel(l + 1) - xpForLevel(l)) / ((ess * best[2] * 2.5) / CYCLE);
    }
    return t;
}
const h = (t: number) => `${Math.round(t)} ticks (${((t * 0.6) / 60).toFixed(0)} min at 600 ms)`;
console.log('air only, 27 ess:          ', h(run(['air'], 27)));
console.log('free altars, 27 ess:       ', h(run(['air', 'water', 'earth', 'fire', 'body'], 27)));
console.log('+chaos/nature/law, 27 ess: ', h(run(['air', 'water', 'earth', 'fire', 'body', 'chaos', 'nature', 'law'], 27)));
console.log('+death, 27 ess:            ', h(run(ALTARS.map(a => a[0]), 27)));
console.log('+death, 28 ess:            ', h(run(ALTARS.map(a => a[0]), 28)));
