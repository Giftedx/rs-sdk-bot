// Installs the fleet watchdog as a Windows scheduled task for the current user every 5 minutes and at logon.
// Usage: bun packages/fleet/src/watchdog-install.ts [--remove]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const TASKS = ['rs-sdk-coordinator-watchdog', 'rs-sdk-coordinator-watchdog-logon'];

export function launcherScript(bun: string, repo: string, entry = join('packages', 'fleet', 'src', 'watchdog.ts')): string {
    const q = (s: string) => s.replace(/"/g, '""');
    return [
        'Set shell = CreateObject("WScript.Shell")',
        `shell.CurrentDirectory = "${q(repo)}"`,
        `shell.Run """${q(bun)}"" ""${q(join(repo, entry))}""", 0, False`,
        '',
    ].join('\r\n');
}

function schtasks(args: string[]) {
    const r = Bun.spawnSync(['schtasks', ...args], { windowsHide: true, stdout: 'pipe', stderr: 'pipe' });
    return { code: r.exitCode, out: (r.stdout.toString() + r.stderr.toString()).trim() };
}

if (import.meta.main) {
    if (process.argv.includes('--remove')) {
        for (const t of TASKS) console.log(t, schtasks(['/Delete', '/TN', t, '/F']).out);
        process.exit(0);
    }
    const bun = process.execPath, dir = join(root, '.practice', 'fleet'), vbs = join(dir, 'watchdog.vbs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(vbs, launcherScript(bun, root));
    const run = `wscript.exe "${vbs}"`;
    for (const [task, trigger] of [[TASKS[0]!, ['/SC', 'MINUTE', '/MO', '5']], [TASKS[1]!, ['/SC', 'ONLOGON']]] as const) {
        const r = schtasks(['/Create', '/TN', task, '/TR', run, ...trigger, '/F']);
        console.log(task, r.code === 0 ? 'installed' : trigger[1] === 'ONLOGON' ? 'skipped (needs admin rights)' : 'FAILED', r.out);
    }
}
