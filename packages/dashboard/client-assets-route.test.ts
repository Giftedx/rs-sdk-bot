import { expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';

// Every JSON file that the page fetches from /client-assets/ must pass the server's asset allowlist.
test('the asset route serves every JSON data file that the page asks for', () => {
    const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    const allowed = server.match(/if\(!\[([^\]]*)\]\.includes\(name\)/)?.[1] ?? '';
    const page = ['client-shell.js', 'operations.js', 'index.html'].map(f => readFileSync(new URL('./' + f, import.meta.url), 'utf8')).join('\n');
    const asked = [...new Set([...page.matchAll(/(?:client-assets\/|asset\(')([a-z-]+\.json)/g)].map(m => m[1]!))];
    expect(asked).toEqual(expect.arrayContaining(['item-list.json', 'resources.json']));
    for (const name of asked) {
        expect(allowed).toContain(`'${name}'`);
        expect(existsSync(new URL('./client-assets/' + name, import.meta.url))).toBe(true);
    }
});
