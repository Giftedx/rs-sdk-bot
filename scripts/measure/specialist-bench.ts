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

    const suppliers = plan.supplier.split(',').map(s => s.trim()).filter(Boolean);
    if (!suppliers.length) throw Error('specialist-bench: missing supplier account');

    const supplierProcs: ReturnType<typeof Bun.spawn>[] = [];
    const pumpPromises: Promise<void>[] = [];
    const readyPromises: Promise<void>[] = [];

    for (let i = 0; i < suppliers.length; i++) {
        const supName = suppliers[i]!;
        const prefix = suppliers.length === 1 ? 'SUPPLIER ' : `SUPPLIER[${supName}] `;
        const errPrefix = suppliers.length === 1 ? 'SUPPLIER_ERR ' : `SUPPLIER_ERR[${supName}] `;
        const roleEnv =
            plan.childEnv.SUPPLIER_ROLE ??
            (suppliers.length > 1 ? (i === 0 ? 'starter' : 'runner') : undefined);
        const proc = Bun.spawn(['bun', resolve(ROOT, plan.supplierScript), supName, plan.bot, '20000'], {
            cwd: ROOT,
            env: {
                ...process.env,
                ...(plan.childEnv.SUPPLIER_KIT ? { SUPPLIER_KIT: plan.childEnv.SUPPLIER_KIT } : {}),
                ...(plan.childEnv.RUNECRAFT_ESS_BATCH ? { RUNECRAFT_ESS_BATCH: plan.childEnv.RUNECRAFT_ESS_BATCH } : {}),
                ...(roleEnv ? { SUPPLIER_ROLE: roleEnv } : {}),
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
        supplierProcs.push(proc);

        let isReady = false;
        let resolveReady!: () => void;
        let rejectReady!: (err: Error) => void;
        readyPromises.push(new Promise<void>((res, rej) => {
            resolveReady = res;
            rejectReady = rej;
        }));

        pumpPromises.push(
            pumpPrefixed(proc.stdout as ReadableStream<Uint8Array>, prefix, process.stdout, line => {
                if (!isReady && line.includes('SUPPLIER_READY ')) {
                    isReady = true;
                    resolveReady();
                }
            }),
            pumpPrefixed(proc.stderr as ReadableStream<Uint8Array>, errPrefix, process.stderr),
        );
        void proc.exited.then(code => {
            if (!isReady) rejectReady(Error(`supplier ${supName} exited early (${code}) before SUPPLIER_READY`));
        });
    }

    let specProc: ReturnType<typeof Bun.spawn> | undefined;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            Promise.all(readyPromises),
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
                PRACTICE_SUPPLIER: suppliers.join(','),
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
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            Promise.allSettled(supplierProcs.map(p => (p.exitCode === null ? p.exited : Promise.resolve()))),
            new Promise<void>(r => { stopTimer = setTimeout(r, suppliers.length > 1 ? 2_000 : 5_000); }),
        ]).finally(() => clearTimeout(stopTimer));
        await Promise.allSettled(
            supplierProcs.filter(p => p.exitCode === null).map(p => killTree(p.pid).catch(() => {})),
        );
        await Promise.allSettled(pumpPromises);
    }
}

if (import.meta.main) {
    main().catch(error => {
        console.log(`RESULT fail ${String(error instanceof Error ? error.message : error)}`);
        process.exit(1);
    });
}
