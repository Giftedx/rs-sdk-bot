import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {gateSteps,statusBody,checkoutProblem,localSteps,partSteps} from './ci-gate';

test('a posted status needs the SDK patch and no changed or untracked files',()=>{
 expect(checkoutProblem('',true,true)).toBeNull();
 expect(checkoutProblem('?? scripts/new-helper.ts\n',true,true)).toContain('scripts/new-helper.ts');
 expect(checkoutProblem(' M scripts/a.ts\n',true,false)).toBeNull();
 expect(checkoutProblem('',false,false)).toContain('rs-sdk-working.patch');
});

test('the gate runs exactly the workflow\'s one-line bun checks, with their env',()=>{
 const steps=gateSteps(readFileSync(join(import.meta.dir,'..','.github','workflows','ci.yml'),'utf8'));
 expect(steps.map(s=>s.cmd.join(' '))).toEqual(['bun run check-pin','bun run typecheck','bun test ./scripts ./packages ./tools','bun test ./packages/dashboard']);
 expect(steps[1].env).toEqual({NODE_OPTIONS:'--max-old-space-size=6144'});
 expect(steps[0].env).toEqual({});
});

test('setup steps and multi-line scripts are not gate checks',()=>{
 const yml=['    steps:','      - uses: actions/checkout@v4','        with:','          submodules: recursive','      - name: Install','        run: |','          bun install --no-save','      - run: bun test ./x  # comment','      - run: git -C vendor apply p.patch'].join('\n');
 expect(gateSteps(yml).map(s=>s.cmd)).toEqual([['bun','test','./x']]);
});

test('the posted status names the failed check, or the count and time',()=>{
 expect(statusBody(true,[{name:'a',ok:true,s:10.4},{name:'b',ok:true,s:20}])).toEqual({state:'success',context:'local-gate',description:'2 checks passed in 30 s'});
 expect(statusBody(false,[{name:'bun run typecheck',ok:false,s:5}]).description).toBe('failed: bun run typecheck');
});

test('the local gate runs the test steps in shards, only the reached files unless --full, and no folder twice',()=>{
 const steps=[{cmd:['bun','run','typecheck']},{cmd:['bun','test','./scripts','./packages','./tools']},{cmd:['bun','test','./packages/dashboard']}];
 expect(localSteps(steps,false).map(s=>s.cmd.join(' '))).toEqual(['bun run typecheck','bun tools/test-shards.ts --changed origin/master ./scripts ./packages ./tools']);
 expect(localSteps(steps,true).map(s=>s.cmd.join(' '))).toEqual(['bun run typecheck','bun tools/test-shards.ts ./scripts ./packages ./tools']);
});

test('a CI test-shards step is the bun test step that it splits, and --part splits the gate the same way',()=>{
 const yml=['      - run: bun tools/test-shards.ts --part $TEST_PART ./scripts ./packages ./tools','        env:','          TEST_PART: ${{ matrix.part }}/2','      - run: bun run typecheck'].join('\n');
 expect(gateSteps(yml).map(s=>s.cmd.join(' '))).toEqual(['bun test ./scripts ./packages ./tools','bun run typecheck']);
 const local=localSteps(gateSteps(yml),true);
 expect(partSteps(local,'1/3').map(s=>s.cmd.join(' '))).toEqual(['bun tools/test-shards.ts --part 1/3 ./scripts ./packages ./tools','bun run typecheck']);
 expect(partSteps(local,'2/3').map(s=>s.cmd.join(' '))).toEqual(['bun tools/test-shards.ts --part 2/3 ./scripts ./packages ./tools']);
 expect(partSteps(local,undefined)).toEqual(local);
});
