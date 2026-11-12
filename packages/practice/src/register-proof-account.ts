import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {openBot,finish} from '../../core/src/bot';
import {waitTicks} from '../../core/src/ticks';
import {rsSdkRoot} from './paths';

// The quest-items-order Native fixture name from runBotName('flqhjob',1).
export const HETTY_IPV4_FIXTURE=/^flqhjox[a-z0-9]{4}1$/;
export const PRACTICE_IPV4={server:'127.0.0.1:8888',gateway:'ws://127.0.0.1:7780'} as const;
type Receipt={name?:unknown;saveAbsent?:unknown;credentialsAbsent?:unknown};
// Windows DNS can return ::1 before 127.0.0.1 for localhost, and the native stack binds IPv4.
// Only a fresh Hetty fixture, with its delivery receipt, may use the exact IPv4 endpoints.
// Every other caller keeps the default localhost profile.
export function practiceProfile(name:string,env:string,receipt:Receipt|null):'localhost'|'ipv4'|null{
 if(/^SERVER=localhost:8888\r?$/m.test(env))return 'localhost';
 const lines=env.split(/\r?\n/),servers=lines.filter(l=>l.startsWith('SERVER=')),gateways=lines.filter(l=>l.startsWith('GATEWAY_URL='));
 const exact=servers.length===1&&servers[0]===`SERVER=${PRACTICE_IPV4.server}`&&gateways.length===1&&gateways[0]===`GATEWAY_URL=${PRACTICE_IPV4.gateway}`;
 const fresh=HETTY_IPV4_FIXTURE.test(name)&&receipt?.name===name&&receipt.saveAbsent===true&&receipt.credentialsAbsent===true;
 return exact&&fresh?'ipv4':null;
}
export function readFixtureReceipt(dir:string|undefined):Receipt|null{
 if(!dir)return null;
 try{return JSON.parse(readFileSync(join(dir,'fixture.json'),'utf8'));}catch{return null;}
}

// Register a freshly seeded local account before authenticated partner checks.
if(import.meta.main){
    const name=process.argv[2];
    if(!name||!practiceProfile(name,readFileSync(join(rsSdkRoot(),'bots',name,'bot.env'),'utf8'),readFixtureReceipt(process.env.DELIVERY_DIR)))throw Error('practice account required');
    const session=await openBot(name);await waitTicks(session,3);await finish([session],true,'practice ownership registered');
}
