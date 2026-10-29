// Installs the coordinator watchdog as a Windows scheduled task for the current user, every 5 minutes; it resumes
// after a restart once the user logs in. The at-logon task needs admin rights and is skipped without them.
// wscript runs a generated .vbs with window style 0, so no console window opens. Usage:
//   bun packages/router/src/watchdog-install.ts            install or replace
//   bun packages/router/src/watchdog-install.ts --remove   delete both tasks
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const TASKS = ['rs-sdk-coordinator-watchdog', 'rs-sdk-coordinator-watchdog-logon'];

export function launcherScript(bun: string, repo: string): string {
    const q = (s: string) => s.replace(/"/g, '""');
    return [
        'Set shell = CreateObject("WScript.Shell")',
        `shell.CurrentDirectory = "${q(repo)}"`,
        `shell.Run """${q(bun)}"" ""${q(join(repo, 'packages', 'router', 'src', 'watchdog.ts'))}""", 0, False`,
        '',
    ].join('\r\n');
}

function schtasks(args: string[]) {
    const r = Bun.spawnSync(['schtasks', ...args], { windowsHide: true, stdout: 'pipe', stderr: 'pipe' });
    return { code: r.exitCode, out: (r.stdout.toString() + r.stderr.toString()).trim() };
}

if (import.meta.main) {
    if (process.argv.includes('--remove')) { for (const t of TASKS) console.log(t, schtasks(['/Delete', '/TN', t, '/F']).out); process.exit(0); }
    const bun = process.execPath, dir = join(root, '.practice', 'coordinator'), vbs = join(dir, 'watchdog.vbs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(vbs, launcherScript(bun, root));
    const run = `wscript.exe "${vbs}"`;
    for (const [task, trigger] of [[TASKS[0]!, ['/SC', 'MINUTE', '/MO', '5']], [TASKS[1]!, ['/SC', 'ONLOGON']]] as const) {
        const r = schtasks(['/Create', '/TN', task, '/TR', run, ...trigger, '/F']);
        console.log(task, r.code === 0 ? 'installed' : trigger[1] === 'ONLOGON' ? 'skipped (needs admin rights)' : 'FAILED', r.out);
    }
}
