import { runScript } from '../vendor/rs-sdk/sdk/runner';

// Prints the bot's position as `POS x z level`. prove uses it to check that a preset save was loaded.
await runScript(async ({ sdk }) => {
    const p = sdk.getState()?.player;
    console.log(p ? `POS ${p.worldX} ${p.worldZ} ${p.level}` : 'POS unknown');
}, { timeout: 30_000 });
