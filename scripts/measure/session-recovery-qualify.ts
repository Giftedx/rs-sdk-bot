// Qualifies native controller session recovery (`session-recovery-only`) and copies portable evidence for hosted CI retention.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cachedLaunchRevision, capabilityRevision } from '../../packages/core/src/worker-release';
import { findCurrentNativeRecoveryQualification } from '../../packages/fleet/src/session-recovery';

const ROOT = resolve(import.meta.dir, '..', '..');
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function runChecked(cmd: string[], env: Record<string, string | undefined>, logFile?: string): Promise<string> {
    const proc = Bun.spawn(cmd, {
        cwd: ROOT,
        env,
        windowsHide: true,
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (logFile) {
        writeFileSync(logFile, stdout);
        writeFileSync(logFile.replace(/\.out\.log$/, '.err.log'), stderr);
    }
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
    if (code !== 0) {
        throw Error(`command failed (${code}): ${cmd.join(' ')}`);
    }
    return stdout;
}

/** Runs owned-bank-observation + native session-recovery proof and writes report.json bundles. */
export async function runSessionRecoveryQualification(): Promise<{
    observerRel: string;
    recoveryRel: string;
}> {
    const stamp = Date.now();
    const obsRel = `.practice/deliveries/owned-bank-observation-${stamp}`;
    const obsDir = resolve(ROOT, obsRel);
    mkdirSync(obsDir, { recursive: true });

    await runChecked(
        ['bun', 'scripts/measure/aio-practice-bench.ts', '--no-keep', '^extra:owned-bank-observation$'],
        { ...process.env, DELIVERY_DIR: obsDir },
        join(obsDir, '1.out.log'),
    );

    const obsReportPath = join(obsDir, 'report.json');
    const obsReport = {
        ok: true,
        stage: 'delivered',
        id: 'owned-bank-observation',
        at: Date.now(),
        runtimeRevision: capabilityRevision(['scripts/aio-logistics.ts'], ROOT),
        directory: obsRel,
    };
    writeFileSync(obsReportPath, JSON.stringify(obsReport, null, 2) + '\n');

    await runChecked(
        ['bun', 'scripts/measure/catalog-integration-proof.ts', '--verify', 'observer'],
        { ...process.env, DELIVERY_DIR: obsDir },
        join(obsDir, '2.out.log'),
    );

    const recRel = `.practice/deliveries/session-recovery-only-${stamp}`;
    const recDir = resolve(ROOT, recRel);
    mkdirSync(recDir, { recursive: true });

    writeFileSync(
        join(recDir, 'bank-observer-qualification.json'),
        JSON.stringify({ path: obsReportPath, sha256: sha256(readFileSync(obsReportPath)) }) + '\n',
    );

    const outLogRel = `${recRel}/3.out.log`;
    const outLogAbs = resolve(ROOT, outLogRel);
    const proofStdout = await runChecked(
        ['bun', 'packages/practice/src/session-recovery-proof.ts'],
        { ...process.env, DELIVERY_DIR: recDir },
        outLogAbs,
    );

    const normalizedLines = proofStdout.split(/\r?\n/).map(line => {
        if (!line.startsWith('RECOVERY_NATIVE_PROOF ')) return line;
        const parsed = JSON.parse(line.slice('RECOVERY_NATIVE_PROOF '.length)) as { path: string; sha256: string };
        return 'RECOVERY_NATIVE_PROOF ' + JSON.stringify({ path: `${recRel}/proof.json`, sha256: parsed.sha256 });
    });
    writeFileSync(outLogAbs, normalizedLines.join('\n') + '\n');

    const recReport = {
        ok: true,
        stage: 'delivered',
        id: 'session-recovery-only',
        at: Date.now(),
        source: cachedLaunchRevision(ROOT),
        runtimeRevision: capabilityRevision(['scripts/session-check.ts'], ROOT),
        directory: recRel,
        checks: [
            {
                id: 'native-session-recovery',
                phase: 'practice',
                exitCode: 0,
                timedOut: false,
                detail: JSON.stringify({ stdout: outLogRel }),
            },
        ],
    };
    writeFileSync(join(recDir, 'report.json'), JSON.stringify(recReport, null, 2) + '\n');

    const verified = findCurrentNativeRecoveryQualification(ROOT);
    if (!verified) {
        throw Error('findCurrentNativeRecoveryQualification failed to verify newly written delivery');
    }

    const retainRoot = resolve(ROOT, '.practice/hosted-rehearse/session-recovery');
    mkdirSync(retainRoot, { recursive: true });
    cpSync(obsDir, join(retainRoot, `owned-bank-observation-${stamp}`), { recursive: true });
    cpSync(recDir, join(retainRoot, `session-recovery-only-${stamp}`), { recursive: true });

    console.log('SESSION_RECOVERY_QUALIFIED ' + JSON.stringify({ obsRel, recRel, verified }));
    return { observerRel: obsRel, recoveryRel: recRel };
}

if (import.meta.main) {
    await runSessionRecoveryQualification();
}
