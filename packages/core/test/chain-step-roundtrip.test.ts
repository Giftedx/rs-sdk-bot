import { expect, test } from 'bun:test';
import { formatStep, parseStep, tokenizeStep, type Step } from '../src/chain-step';

test('legacy unmarked steps keep environment extraction and literal unquoted backslashes', () => {
    expect(parseStep('scripts/cook-food.ts 2000 lobster CAP=2000')).toEqual({
        script: 'scripts/cook-food.ts', args: ['2000', 'lobster'], env: { CAP: '2000' },
    });
    expect(parseStep(String.raw`scripts/example.ts C:\fleet\setup.json MODE=owned`)).toEqual({
        script: 'scripts/example.ts', args: [String.raw`C:\fleet\setup.json`], env: { MODE: 'owned' },
    });
    const army = String.raw`{"style":"melee","name":"O'Brien","path":"C:\\fleet","padding":"x="}`;
    expect(parseStep(`scripts/example.ts O'Brien ARMY_OPTS=${army}`)).toEqual({
        script: 'scripts/example.ts', args: ["O'Brien"], env: { ARMY_OPTS: army },
    });
    expect(tokenizeStep(`scripts/example.ts ${army}`)).toEqual(['scripts/example.ts', army]);
});

test('generated PvP steps retain KEY=value argv separately from the environment', () => {
    const step: Step = {
        script: 'scripts/pk-roam.ts',
        args: ['MODE=hunt', 'CAP=240', '--', 'TEAM=owned'],
        env: { CAP: '900', DEMO_OK: '1' },
    };
    const text = formatStep(step);
    expect(text).toBe('scripts/pk-roam.ts CAP=900 DEMO_OK=1 -- MODE=hunt CAP=240 -- TEAM=owned');
    expect(parseStep(text)).toEqual(step);
    expect(parseStep('scripts/pk-roam.ts CAP=900 -- MODE=hunt CAP=240')).toEqual({
        script: step.script, env: { CAP: '900' }, args: ['MODE=hunt', 'CAP=240'],
    });
});

test('generated steps retain empty arguments, file paths, quotes and multiline environment values', () => {
    const step: Step = {
        script: 'scripts/aio-logistics.ts',
        args: ['loadout-import', '/tmp/owned setups/source.json', String.raw`C:\fleet\native bindings.json`, '', 'a"b\'c', 'line\nnext'],
        env: { DESCRIPTION: 'owned "kit"\nnext line', ROOT: String.raw`C:\fleet\work`, EMPTY: '' },
    };
    expect(parseStep(formatStep(step))).toEqual(step);
    expect(formatStep({script: 'scripts/chain.ts', args: ['scripts/generated/quest-cook.ts'], env: {}})).toBe('scripts/chain.ts -- scripts/generated/quest-cook.ts');
});

test('quoted user tokens are decoded without expanding shell expressions', () => {
    expect(tokenizeStep(`scripts/example.ts MODE="safe target" 'C:\\owned kits\\setup.json' "a\\tb" '$HOME' '$(touch file)'`)).toEqual([
        'scripts/example.ts', 'MODE=safe target', String.raw`C:\owned kits\setup.json`, 'a\tb', '$HOME', '$(touch file)',
    ]);
    expect(parseStep('scripts/example.ts "MESSAGE=first\\nsecond"')).toEqual({
        script: 'scripts/example.ts', args: [], env: { MESSAGE: 'first\nsecond' },
    });
});

test('malformed quotes and unsafe script paths fail before execution', () => {
    for (const text of ["scripts/example.ts 'open", 'scripts/example.ts "open', 'scripts/example.ts "trailing\\'])
        expect(() => parseStep(text)).toThrow('unterminated');
    expect(() => parseStep('scripts/example.ts "invalid\\q"')).toThrow('invalid JSON escape');
    for (const script of ['/tmp/worker.ts', 'packages/worker.ts', 'scripts/worker.js', 'rm']) {
        expect(() => parseStep(script)).toThrow('scripts/*.ts');
        expect(() => formatStep({script, args: [], env: {}})).toThrow('scripts/*.ts');
    }
    expect(() => formatStep({script: 'scripts/example.ts', args: [], env: {'not a key': 'x'}})).toThrow('environment key');
});
