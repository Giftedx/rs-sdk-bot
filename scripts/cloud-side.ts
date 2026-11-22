import { runCloudSideCli } from '../packages/fleet/src/cloud-side';
export * from '../packages/fleet/src/cloud-side';

if (import.meta.main) {
    await runCloudSideCli(process.argv.slice(2));
}
