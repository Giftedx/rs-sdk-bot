import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {openBot,finish} from '../../core/src/bot';
import {waitTicks} from '../../core/src/ticks';
import {rsSdkRoot} from './paths';

// Register a freshly seeded local account before authenticated partner checks.
if(import.meta.main){
    const name=process.argv[2];
    if(!name||!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(rsSdkRoot(),'bots',name,'bot.env'),'utf8')))throw Error('practice account required');
    const session=await openBot(name);await waitTicks(session,3);await finish([session],true,'practice ownership registered');
}
