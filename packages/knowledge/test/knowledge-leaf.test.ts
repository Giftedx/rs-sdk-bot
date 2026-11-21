import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const knowledgeSrc = join(repoRoot, 'packages', 'knowledge', 'src');

function tsSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) tsSourceFiles(full, out);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
    }
    return out.sort();
}

test('packages/knowledge/src production modules import only within packages/knowledge', () => {
    const violations: string[] = [];
    for (const file of tsSourceFiles(knowledgeSrc)) {
        const fromRel = relative(repoRoot, file).replace(/\\/g, '/');
        const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (spec.startsWith('@rsbot/')) {
                violations.push(`${fromRel} -> ${spec}`);
                continue;
            }
            if (!spec.startsWith('.')) continue;
            const target = relative(repoRoot, resolve(dirname(file), spec)).replace(/\\/g, '/');
            if (!target.startsWith('packages/knowledge/')) {
                violations.push(`${fromRel} -> ${target}`);
            }
        }
    }
    expect(violations).toEqual([]);
});
