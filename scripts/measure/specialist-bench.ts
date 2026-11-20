// Runs a fresh-clock specialist worker beside its supplier companion inside the AIO bench harness.
import { existsSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { killTree } from '../../packages/practice/src/proc';
import { playerSavePath } from '../../packages/practice/src/save-library';

const ROOT = resolve(import.meta.dir, '..', '..');

export interface SpecialistBenchPlan {
    bot: string;
    supplier: string;
    specialistScript: string;
    supplierScript: string;
    specialistArgs: string[];
    childEnv: Record<string, string>;
}

export function parseSpecialistBenchArgs(argv: readonly string[], root = ROOT): SpecialistBenchPlan {
    const [bot, supplier, specialistScript, ...rest] = argv;
    if (!bot || !supplier || !specialistScript) {
        throw Error('usage: specialist-bench.ts <bot> <supplier> <specialist-script> [--supplier-script=<path>] [KEY=VALUE ...] [args...]');
    }
    let supplierScript = 'scripts/specialist-supplier.ts';
    const specialistArgs: string[] = [];
    const childEnv: Record<string, string> = {};
    for (const arg of rest) {
        if (arg.startsWith('--supplier-script=')) {
            supplierScript = arg.slice('--supplier-script='.length);
            continue;
        }
        const eq = arg.indexOf('=');
        if (eq > 0 && /^[A-Z][A-Z0-9_]*$/.test(arg.slice(0, eq))) {
            childEnv[arg.slice(0, eq)] = arg.slice(eq + 1);
            continue;
        }
        specialistArgs.push(arg);
    }
    for (const rel of [specialistScript, supplierScript]) {
        const abs = resolve(root, rel);
        const norm = relative(root, abs).replaceAll('\\', '/');
        if (norm.startsWith('..') || !existsSync(abs)) {
            throw Error(`specialist-bench: missing script ${rel}`);
        }
    }
    return { bot, supplier, specialistScript, supplierScript, specialistArgs, childEnv };
}

async function pumpPrefixed(
    stream: ReadableStream<Uint8Array>,
    prefix: string,
    target: NodeJS.WriteStream,
    onLine?: (line: string) => void,
): Promise<void> {
    const decoder = new TextDecoder();
    let rest = '';
    for await (const chunk of stream) {
        rest += decoder.decode(chunk, { stream: true });
        const lines = rest.split('\n');
        rest = lines.pop() ?? '';
        for (const raw of lines) {
            const line = raw.replace(/\r$/, '');
            target.write(`${prefix}${line}\n`);
            onLine?.(line);
        }
    }
    if (rest.length > 0) {
        const line = rest.replace(/\r$/, '');
        target.write(`${prefix}${line}\n`);
        onLine?.(line);
    }
}

async function main(): Promise<void> {
    const plan = parseSpecialistBenchArgs(process.argv.slice(2));

    // Delete any preset save written by bench prepare() so the specialist logs into Tutorial Island at playtime=0.
    rmSync(playerSavePath(plan.bot), { force: true });

    const supplierProc = Bun.spawn(['bun', resolve(ROOT, plan.supplierScript), plan.supplier, plan.bot, '20000'], {
        cwd: ROOT,
        env: {
            ...process.env,
            DEMO_OK: '',
            LOOT_WATCH: '0',
            PRAYER_GUARD: '0',
            EAT_GUARD: '0',
            RANDOM_EVENTS: '0',
            COORDINATOR_RUN_ID: '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
    });

    let supplierReady = false;
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const readyPromise = new Promise<void>((res, rej) => {
        resolveReady = res;
        rejectReady = rej;
    });

    const supOutDone = pumpPrefixed(supplierProc.stdout, 'SUPPLIER ', process.stdout, line => {
        if (!supplierReady && line.includes('SUPPLIER_READY ')) {
            supplierReady = true;
            resolveReady();
        }
    });
    const supErrDone = pumpPrefixed(supplierProc.stderr, 'SUPPLIER_ERR ', process.stderr);
    void supplierProc.exited.then(code => {
        if (!supplierReady) rejectReady(Error(`supplier exited early (${code}) before SUPPLIER_READY`));
    });

    let specProc: ReturnType<typeof Bun.spawn> | undefined;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            readyPromise,
            new Promise<never>((_, rej) => {
                readyTimer = setTimeout(() => rej(Error('supplier did not log SUPPLIER_READY within 60 s')), 60_000);
            }),
        ]);
        clearTimeout(readyTimer);

        specProc = Bun.spawn(['bun', resolve(ROOT, plan.specialistScript), plan.bot, ...plan.specialistArgs], {
            cwd: ROOT,
            env: {
                ...process.env,
                ...plan.childEnv,
                PRACTICE_SUPPLIER: plan.supplier,
                DEMO_OK: '',
                COORDINATOR_RUN_ID: '',
            },
            stdout: 'pipe',
            stderr: 'pipe',
            windowsHide: true,
        });

        const specOutDone = pumpPrefixed(specProc.stdout as ReadableStream<Uint8Array>, '', process.stdout);
        const specErrDone = pumpPrefixed(specProc.stderr as ReadableStream<Uint8Array>, '', process.stderr);
        const [specCode] = await Promise.all([specProc.exited, specOutDone, specErrDone]);
        process.exitCode = specCode;
    } finally {
        clearTimeout(readyTimer);
        if (specProc && specProc.exitCode === null) await killTree(specProc.pid).catch(() => {});
        if (supplierProc.exitCode === null) {
            let stopTimer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                supplierProc.exited,
                new Promise<void>(r => { stopTimer = setTimeout(r, 5_000); }),
            ]).finally(() => clearTimeout(stopTimer));
            if (supplierProc.exitCode === null) await killTree(supplierProc.pid).catch(() => {});
        }
        await Promise.allSettled([supOutDone, supErrDone]);
    }
}

if (import.meta.main) {
    main().catch(error => {
        console.log(`RESULT fail ${String(error instanceof Error ? error.message : error)}`);
        process.exit(1);
    });
}
