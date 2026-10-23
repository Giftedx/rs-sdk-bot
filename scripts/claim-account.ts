// Claims an account name on the server: log in once (the first login registers the name with the bot.env password),
// then log out on the first tick the player is in the world, so the account gets as little playtime as possible.
// Usage: DEMO_OK=1 bun scripts/claim-account.ts <bot>. Prints CLAIM <ticks in world> <logout result>.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertServerAllowed, serverFromEnv, logoutSession, closeWithin } from '../packages/core/src/bot';
import { connectInProcess } from '../packages/core/src/inprocess';

const name = process.argv[2]!;
const root = resolve(import.meta.dir, '..');
const env = readFileSync(join(root, 'vendor', 'rs-sdk', 'bots', name, 'bot.env'), 'utf8');
const password = env.match(/^PASSWORD=(.*)$/m)?.[1]?.trim();
if (!password) throw new Error(`no PASSWORD in bots/${name}/bot.env`);
const server = serverFromEnv(env);
assertServerAllowed(server);
const s = await connectInProcess({ name, password, server });
// Log out the moment the client reports it is in the game: no tutorial, no actions.
const t0 = Date.now();
while (!s.sdk.getState()?.inGame && Date.now() - t0 < 30_000) await Bun.sleep(20);
const inAt = s.tick();
const out = s.sdk.getState()?.inGame ? await logoutSession(s) : 'never in game';
console.log(`CLAIM ticks=${s.tick() - inAt} in_game=${!!s.sdk.getState()} logout=${out}`);
await closeWithin([s], 5000);
process.exit(out === 'logged-out' ? 0 : 1);
