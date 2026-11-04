import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {gateSteps,statusBody} from './ci-gate';

test('the gate runs exactly the workflow\'s one-line bun checks, with their env',()=>{
 const steps=gateSteps(readFileSync(join(import.meta.dir,'..','.github','workflows','ci.yml'),'utf8'));
 expect(steps.map(s=>s.cmd.join(' '))).toEqual(['bun run check-pin','bun run typecheck','bun test ./scripts ./packages','bun test ./packages/dashboard']);
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
