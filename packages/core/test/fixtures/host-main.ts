import { finish } from '../../src/bot';
import { helperMain } from './host-main-helper';

async function main() {
    await Bun.sleep(5);
    console.log(`MAIN ${process.argv[2]} helper=${helperMain} literal=import.meta.main`);
    await finish([], !helperMain, `guarded ${process.argv[2]}`);
    console.log('NEVER after finish');
}
if (import.meta.main) await main();
