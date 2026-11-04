// Lists what a RuneLite plugin does, at the commit research/runelite-parity.md pins: its files and every setting
// name (@ConfigItem name = "..."), read through the GitHub API (gh). The first step of the parity check for a
// dashboard part. Usage: bun packages/dashboard/tools/runelite-features.ts <plugin dir> [more dirs]
// Example: bun packages/dashboard/tools/runelite-features.ts xptracker hiscore
export const RUNELITE_SHA = '7715a1d26e6cbbfdce7ad266a39c8c3c611211a0';
const BASE = 'runelite-client/src/main/java/net/runelite/client/plugins';

export const settingNames = (java: string) => [...java.matchAll(/name\s*=\s*"([^"]+)"/g)].map(m => m[1]!).filter(Boolean);

function gh(path: string): string {
    const p = Bun.spawnSync(['gh', 'api', `repos/runelite/runelite/contents/${path}?ref=${RUNELITE_SHA}`], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    if (p.exitCode !== 0) throw Error(`gh api ${path}: ${p.stderr.toString().trim()}`);
    return p.stdout.toString();
}

if (import.meta.main) {
    const plugins = process.argv.slice(2);
    if (!plugins.length) { console.error('usage: bun packages/dashboard/tools/runelite-features.ts <plugin dir> [more dirs]'); process.exit(2); }
    for (const plugin of plugins) {
        const files = (JSON.parse(gh(`${BASE}/${plugin}`)) as { name: string; type: string }[]).filter(f => f.type === 'file').map(f => f.name);
        console.log(`${plugin} @ ${RUNELITE_SHA.slice(0, 7)}: ${files.join(', ')}`);
        for (const f of files.filter(f => f.endsWith('Config.java'))) {
            const java = Buffer.from(JSON.parse(gh(`${BASE}/${plugin}/${f}`)).content, 'base64').toString('utf8');
            console.log(`  ${f}: ${settingNames(java).join(' · ')}`);
        }
    }
}
