import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rsSdkRoot } from './paths';

function enforce(env: string, key: string, value: string): string {
    const re = new RegExp(`^${key}=.*$`, 'm');
    return re.test(env) ? env.replace(new RegExp(`^${key}=.*$`, 'gm'), `${key}=${value}`) : `${env.trimEnd()}\n${key}=${value}\n`;
}

export async function createBot(name: string): Promise<{ name: string; envPath: string }> {
    const root = rsSdkRoot();
    const envPath = join(root, 'bots', name, 'bot.env');
    if (!existsSync(envPath)) {
        const r = Bun.spawnSync(['bun', 'bots/create-bot.ts', name, '--local', '--no-chat'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
        if (r.exitCode !== 0 || !existsSync(envPath)) {
            throw new Error(`create-bot failed for ${name}: ${r.stderr.toString()}${r.stdout.toString()}`);
        }
    }
    let env = readFileSync(envPath, 'utf8');
    env = enforce(env, 'TELEMETRY', 'false');
    env = enforce(env, 'SHOW_CHAT', 'false');
    writeFileSync(envPath, env);
    return { name, envPath };
}
