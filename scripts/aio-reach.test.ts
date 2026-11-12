// The AIO catalog (scripts/aio.ts) is the index of the game scripts. This test fails when a script under scripts/,
// scripts/generated/ or scripts/pk-live/ is reached from no catalog route and is not in OUTSIDE_CATALOG with its cause.
// A script is reached when a route names it, or when a reached script imports it or names its path in code.
// OUTSIDE_CATALOG and the reach rule are in scripts/script-index.ts, which also prints them.
import {test,expect} from 'bun:test';
import {OUTSIDE_CATALOG,unreachedScripts} from './script-index';

export {OUTSIDE_CATALOG,unreachedScripts};

test('every script is reached from an AIO route, or is listed outside the catalog with its cause', () => {
 const unreached = unreachedScripts();
 // A script with no route and no entry: give it a route, or add it to OUTSIDE_CATALOG with the cause.
 expect(unreached.filter(f => !(f in OUTSIDE_CATALOG))).toEqual([]);
 // An entry for a script that a route reaches, or that is gone: delete the entry.
 expect(Object.keys(OUTSIDE_CATALOG).filter(f => !unreached.includes(f))).toEqual([]);
 for (const cause of Object.values(OUTSIDE_CATALOG)) expect(cause.length).toBeGreaterThan(10);
});
