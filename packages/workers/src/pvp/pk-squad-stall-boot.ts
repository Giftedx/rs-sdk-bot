import { applySquadStallTicks } from './pk-squad-stall';

if (/pk-squad\.ts$/.test(process.argv[1] ?? '') || (/aio-pvp\.ts$/.test(process.argv[1] ?? '') && process.argv.includes('squad'))) {
    applySquadStallTicks();
}
