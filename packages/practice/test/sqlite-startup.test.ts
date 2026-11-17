import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

test('the engine SQLite startup waits for an exclusive writer before enabling WAL', async () => {
    const sourcePath = resolve(import.meta.dir, '../../../vendor/rs-sdk/server/engine/src/db/query.ts');
    const pragmas = readFileSync(sourcePath, 'utf8').match(/const SQLITE_PRAGMAS = "([^"]+)";/)?.[1];
    if (!pragmas) throw Error(`Cannot read SQLITE_PRAGMAS from ${sourcePath}`);

    const tempRoot = resolve(tmpdir());
    const directory = mkdtempSync(join(tempRoot, 'rsbot-sqlite-startup-'));
    const dbPath = join(directory, 'scratch.sqlite');
    const holderPath = join(directory, 'hold.ts');
    let database: Database | undefined;
    let stopHolder: (() => Promise<void>) | undefined;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        database = new Database(dbPath);
        database.exec('PRAGMA journal_mode = DELETE; CREATE TABLE witness(value INTEGER); INSERT INTO witness VALUES(0);');
        database.close();
        database = undefined;
        writeFileSync(holderPath, `
import { Database } from 'bun:sqlite';
const failsafe = setTimeout(() => process.exit(124), 2000);
const db = new Database(process.argv[2]);
db.exec('BEGIN EXCLUSIVE; UPDATE witness SET value = value + 1;');
console.log('LOCKED');
const input = Bun.stdin.stream().getReader();
await input.read();
input.releaseLock();
await Bun.sleep(400);
db.exec('COMMIT;');
db.close();
clearTimeout(failsafe);
`);
        const holder = Bun.spawn([process.execPath, holderPath, dbPath], {
            stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: 2500,
        });
        const stderr = new Response(holder.stderr).text();
        stopHolder = async () => {
            if (holder.exitCode === null) holder.kill();
            await holder.exited;
            await stderr;
        };
        await Promise.race([
            (async () => {
                let output = '';
                for await (const chunk of holder.stdout) {
                    output += new TextDecoder().decode(chunk);
                    if (output.includes('LOCKED\n')) return;
                }
                throw Error(`SQLite lock holder exited before readiness: ${await stderr}`);
            })(),
            new Promise<never>((_, reject) => {
                readyTimer = setTimeout(() => reject(Error('SQLite lock holder readiness timeout')), 1500);
            }),
        ]);
        clearTimeout(readyTimer);
        readyTimer = undefined;

        database = new Database(dbPath);
        // Release only after this connection exists. The child keeps its lock for 400 ms after the signal.
        holder.stdin.write('release\n');
        await holder.stdin.flush();
        holder.stdin.end();
        database.exec(pragmas);
        expect(await holder.exited).toBe(0);
        expect(await stderr).toBe('');
        expect(database.query('PRAGMA journal_mode;').get()).toEqual({ journal_mode: 'wal' });
        expect(database.query('SELECT value FROM witness;').get()).toEqual({ value: 1 });
    } finally {
        if (readyTimer) clearTimeout(readyTimer);
        try {
            database?.close();
        } finally {
            try {
                await stopHolder?.();
            } finally {
                if (dirname(directory) !== tempRoot || !basename(directory).startsWith('rsbot-sqlite-startup-')) {
                    throw Error(`Refusing to clean an unexpected SQLite test directory: ${directory}`);
                }
                rmSync(directory, { recursive: true, force: true });
            }
        }
    }
}, 4500);
