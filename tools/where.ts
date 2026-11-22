// Practice tool: prints the position of a bot as `POS x z level` (packages/practice/src/prove.ts).
import { runScript } from '../vendor/rs-sdk/sdk/runner';

await runScript(async ({ sdk }) => {
    const p = sdk.getState()?.player;
    console.log(p ? `POS ${p.worldX} ${p.worldZ} ${p.level}` : 'POS unknown');
}, { timeout: 30_000 });
