import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {releaseFiles} from '../packages/core/src/worker-release';

test('carrier release excludes unrelated supply and quest workers',()=>{
 const files=releaseFiles(['scripts/rune-bank-craft.ts'],resolve(import.meta.dir,'..'));
 for(const file of ['scripts/rune-supply.ts','scripts/generated/quest-lib.ts','scripts/quest-walk.ts'])
  expect(files).not.toContain(file);
 expect(files).toContain('scripts/rune-starter.ts');
});
