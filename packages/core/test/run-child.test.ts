import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastResult, runChild, runDirectChild, streamChildOutput } from '../src/run-child';

async function* chunks(parts: Uint8Array[]) { for (const part of parts) yield part; }

test('fragmented UTF-8 and protocol lines preserve exact direct output and the final unterminated result', async () => {
    const text = 'START worker\nRESULT fail first\nMILESTONE café 🐟\nRESULT ok item=café 🐟';
    const bytes = Buffer.from(text), written: string[] = [];
    const result = await streamChildOutput(chunks(Array.from(bytes, (_, i) => bytes.subarray(i, i + 1))), text => written.push(text));
    expect(written.join('')).toBe(text);
    expect(result).toBe('RESULT ok item=café 🐟');
});

test('child indentation follows real line starts across chunks and split CRLF', async () => {
    const written: string[] = [];
    const result = await streamChildOutput(chunks(['hel', 'lo\n', '\nwo', 'rld\r', '\nRES', 'ULT ok done\n'].map(text => Buffer.from(text))), text => written.push(text), true);
    expect(written.join('')).toBe('  | hello\n\n  | world\r\n  | RESULT ok done\n');
    expect(result).toBe('RESULT ok done');
});

test('diagnostic prefixes and indented nested results cannot replace the worker result', async () => {
    const text = 'RESULT ok credited=5\nRESULT_METADATA fail\n  | RESULT fail nested\nRESULTANT invalid';
    expect(lastResult(text)).toBe('RESULT ok credited=5');
    expect(await streamChildOutput(chunks([Buffer.from(text)]), () => {})).toBe('RESULT ok credited=5');
    expect(lastResult('RESULT_METADATA ok')).toBe('RESULT fail no result');
});

test('a long diagnostic line is streamed while a later result remains available', async () => {
    let written = 0;
    const noise = Buffer.alloc(1024 * 1024, 'x');
    async function* output() {
        yield Buffer.from('RESULT fail previous\n');
        for (let n = 0; n < 16; n++) yield noise;
        yield Buffer.from('\nRESULT ok complete=1\n');
    }
    expect(await streamChildOutput(output(), text => { written += text.length; })).toBe('RESULT ok complete=1');
    expect(written).toBe(16 * noise.length + 'RESULT fail previous\n\nRESULT ok complete=1\n'.length);
});

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function child(source: string) {
    const folder = mkdtempSync(join(tmpdir(), 'run-child-')); folders.push(folder);
    const file = join(folder, 'worker.ts'); writeFileSync(file, source); return file;
}

test('real child exit failure overrides an apparent success in both dispatch modes', async () => {
    const file = child("console.log('RESULT ok credited=1'); process.exit(7);");
    const writes: string[] = [];
    const out = spyOn(process.stdout, 'write').mockImplementation(((text: string) => { writes.push(String(text)); return true; }) as any);
    const log = spyOn(console, 'log').mockImplementation(text => { writes.push(String(text) + '\n'); });
    try {
        expect(await runChild([file])).toBe('RESULT fail child exit 7: RESULT ok credited=1');
        expect(writes.join('')).toBe('  | RESULT ok credited=1\n');
        writes.length = 0;
        expect(await runDirectChild([file])).toBe('RESULT fail child exit 7: RESULT ok credited=1');
        expect(writes.join('')).toBe('RESULT ok credited=1\nRESULT fail child exit 7: RESULT ok credited=1\n');
    } finally { out.mockRestore(); log.mockRestore(); }
});

test('direct output keeps an existing missing-result failure once and supplies a missing result when necessary', async () => {
    const writes: string[] = [];
    const out = spyOn(process.stdout, 'write').mockImplementation(((text: string) => { writes.push(String(text)); return true; }) as any);
    const log = spyOn(console, 'log').mockImplementation(text => { writes.push(String(text) + '\n'); });
    try {
        expect(await runDirectChild([child("console.log('RESULT fail no result');")])).toBe('RESULT fail no result');
        expect(writes.join('')).toBe('RESULT fail no result\n');
        writes.length = 0;
        expect(await runDirectChild([child("console.log('START worker');")])).toBe('RESULT fail no result');
        expect(writes.join('')).toBe('START worker\nRESULT fail no result\n');
    } finally { out.mockRestore(); log.mockRestore(); }
});

test('synthesized failures start at column zero after unterminated child output', async () => {
    const writes: string[] = [];
    const out = spyOn(process.stdout, 'write').mockImplementation(((text: string) => { writes.push(String(text)); return true; }) as any);
    const log = spyOn(console, 'log').mockImplementation(text => { writes.push(String(text) + '\n'); });
    try {
        expect(await runDirectChild([child("process.stdout.write('START worker');")])).toBe('RESULT fail no result');
        expect(writes.join('')).toBe('START worker\nRESULT fail no result\n');
        writes.length = 0;
        expect(await runDirectChild([child("process.stdout.write('RESULT ok credited=1'); process.exit(7);")])).toBe('RESULT fail child exit 7: RESULT ok credited=1');
        expect(writes.join('')).toBe('RESULT ok credited=1\nRESULT fail child exit 7: RESULT ok credited=1\n');
    } finally { out.mockRestore(); log.mockRestore(); }
});
