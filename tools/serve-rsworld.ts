// Serves the production build of the rs-world viewer (vendor/rs-world/build) on http://localhost:3000.
// Replaces `yarn start`: the dev server covered the page with TypeScript type-check errors from a newer TypeScript
// than the viewer was written for; the code runs fine. Build once with:
//   cd vendor/rs-world && TSC_COMPILE_ON_ERROR=true DISABLE_ESLINT_PLUGIN=true npx yarn@1.22.22 build
// The viewer shares buffers with its workers (SharedArrayBuffer), so every response carries the cross-origin
// isolation headers from build/_headers, plus CORP so the dashboard can embed it.
import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..', 'vendor', 'rs-world');
const build = join(root, 'build');
const PORT = Number(process.env.RSW_PORT ?? 3000);
const headers = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
};

function fileFor(pathname: string): string | null {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([\\/])+/, '');
    if (rel.includes('..')) return null;
    // The map cache sits next to the build (yarn sync-cache writes vendor/rs-world/caches).
    const base = rel.startsWith('caches') ? root : build;
    const p = join(base, rel);
    return existsSync(p) && statSync(p).isFile() ? p : null;
}

Bun.serve({
    port: PORT,
    fetch(req) {
        const url = new URL(req.url);
        const p = fileFor(url.pathname === '/' ? '/index.html' : url.pathname) ?? join(build, 'index.html');
        return new Response(Bun.file(p), { headers });
    },
});
console.log(`rs-world: http://localhost:${PORT}`);
