import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { practiceBotsRoot, rsSdkRoot } from './paths';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomPassword(length = 12): string {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, b => ALNUM[b % ALNUM.length]!).join('');
}

function enforce(env: string, key: string, value: string): string {
    const re = new RegExp(`^${key}=.*$`, 'm');
    return re.test(env) ? env.replace(new RegExp(`^${key}=.*$`, 'gm'), `${key}=${value}`) : `${env.trimEnd()}\n${key}=${value}\n`;
}

export async function createBot(
    name: string,
    opts: { legacyVendorDir?: boolean; botsDir?: string } = {},
): Promise<{ name: string; envPath: string }> {
    if (!/^[a-zA-Z0-9]{1,12}$/.test(name)) {
        throw new Error(`invalid bot username ${name}: must be 1-12 alphanumeric chars`);
    }
    if (opts.legacyVendorDir) {
        const root = rsSdkRoot();
        const envPath = join(root, 'bots', name, 'bot.env');
        const generated = !existsSync(envPath);
        if (generated) {
            const r = Bun.spawnSync(['bun', 'bots/create-bot.ts', name, '--local', '--no-chat'], { cwd: root, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
            if (r.exitCode !== 0 || !existsSync(envPath)) {
                throw new Error(`create-bot failed for ${name}: ${r.stderr.toString()}${r.stdout.toString()}`);
            }
        }
        let env = readFileSync(envPath, 'utf8');
        if (generated) {
            const lines = env.split(/\r?\n/);
            const servers = lines.filter(line => line.startsWith('SERVER='));
            const gateways = lines.filter(line => line.startsWith('GATEWAY_URL='));
            if (servers.length !== 1 || !/^SERVER=(?:localhost|127\.0\.0\.1)(?::8888)?$/.test(servers[0]!)
                || gateways.length > 1 || gateways.some(line => !/^GATEWAY_URL=ws:\/\/(?:localhost|127\.0\.0\.1):7780$/.test(line))) {
                throw new Error(`create-bot did not generate a default loopback profile for ${name}`);
            }
            env = enforce(env, 'SERVER', 'localhost:8888');
            env = enforce(env, 'GATEWAY_URL', 'ws://localhost:7780');
        }
        env = enforce(env, 'TELEMETRY', 'false');
        env = enforce(env, 'SHOW_CHAT', 'false');
        writeFileSync(envPath, env);
        return { name, envPath };
    }

    const envPath = join(opts.botsDir ?? practiceBotsRoot(), name, 'bot.env');
    if (!existsSync(envPath)) {
        mkdirSync(dirname(envPath), { recursive: true });
        writeFileSync(envPath, [
            `BOT_USERNAME=${name}`,
            `PASSWORD=${randomPassword()}`,
            'SERVER=localhost:8888',
            'GATEWAY_URL=ws://localhost:7780',
            'SHOW_CHAT=false',
            'TELEMETRY=false',
            '',
        ].join('\n'));
        return { name, envPath };
    }
    let env = readFileSync(envPath, 'utf8');
    env = enforce(env, 'TELEMETRY', 'false');
    env = enforce(env, 'SHOW_CHAT', 'false');
    writeFileSync(envPath, env);
    return { name, envPath };
}
