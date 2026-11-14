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

// A data file is asked again on each load (no-cache) with a weak ETag, so a new round's data shows at once; images keep
// the hour.
test('the asset route revalidates JSON data files and caches images', () => {
    const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    expect(server).toContain("if(!name.endsWith('.json'))return new Response(file,{headers:{'cache-control':'public,max-age=3600'}});");
    expect(server).toContain("if(req.headers.get('if-none-match')===tag)return new Response(null,{status:304");
    expect(server).toContain("return new Response(file,{headers:{etag:tag,'cache-control':'no-cache'}});");
});

// The To level chance belongs to the gathering skills: Firemaking's logs are its input.
test('the Skills tab tooltip adds a gather chance for Fishing, Mining and Woodcutting only', () => {
    const shell = readFileSync(new URL('./client-shell.js', import.meta.url), 'utf8');
    expect(shell).toContain("typeof gatherText==='function'&&/^(fishing|mining|woodcutting)$/i.test(sk.dataset.skill)?gatherText(");
});
