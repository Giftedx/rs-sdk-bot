import { openBot } from '../../src/bot';

void openBot(process.argv[2]!).catch(() => {});
process.exit(3);
