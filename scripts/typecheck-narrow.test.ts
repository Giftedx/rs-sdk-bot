import {expect,test} from 'bun:test';
import {narrowConfig,tsFiles} from './typecheck-narrow';

test('tsFiles keeps TypeScript paths one time each and leaves out the SDK submodule', () => {
    expect(tsFiles(['scripts/b.ts','AGENTS.md','','packages\\core\\src\\a.ts','scripts/b.ts','vendor/rs-sdk/sdk/x.ts','swarm.json']))
        .toEqual(['packages/core/src/a.ts','scripts/b.ts']);
});

test('narrowConfig checks only the named files and takes the options of the root project', () => {
    const c=narrowConfig('F:/repo',['scripts/b.ts'],'F:/main/node_modules/@types');
    expect(c.extends).toBe('F:/repo/tsconfig.json');
    expect(c.include).toEqual([]);
    expect(c.files).toHaveLength(1);
    expect(c.files[0]!.endsWith('/repo/scripts/b.ts')).toBe(true);
    expect(c.compilerOptions.typeRoots).toEqual(['F:/main/node_modules/@types']);
});
