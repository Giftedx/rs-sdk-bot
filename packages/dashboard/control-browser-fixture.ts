// Browser integration fixture. Uses production UI/control code and an isolated Brain live state.
// Never runs live logins or game actions.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createOperatorControl } from './operator-control';
import { coordinationView } from './coordination';
import { atomicJson } from '../core/src/plan-lock';
import { findStopFile, fleetStateFile, liveRoot } from '../core/src/practice-paths';

const project = resolve(import.meta.dir, '../..');
const root = resolve(process.argv[2] ?? join(project, '.practice/osrs-client/control-fixture'));
const liveDir = liveRoot(root);
const statePath = fleetStateFile(root);
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

mkdirSync(liveDir, { recursive: true });
mkdirSync(join(root, 'vendor/rs-sdk/bots/Bigpackage'), { recursive: true });
if (!existsSync(join(root, 'swarm.json'))) {
 atomicJson(join(root, 'swarm.json'), { maxBots: 4, jobs: [] });
}
if (!existsSync(statePath)) {
 atomicJson(statePath, {
  schemaVersion: 1,
  emittedAt: Date.now(),
  side: 'local',
  server: 'localhost:8888',
  maxBots: 4,
  accounts: {},
  activeChains: {},
  idleReasons: {},
  goals: [],
  campaigns: [],
  missions: [],
  pendingTransfers: [],
  quarantinedDefects: [],
 });
}
atomicJson(join(liveDir, 'swarm-owner.json'), { pid: process.pid, nonce: 'fixture', at: Date.now() });

const controls = createOperatorControl({ root });
async function state() {
 const live = await (await fetch('http://127.0.0.1:3100/api/state')).json();
 live.now = Date.now();
 const paused = Boolean(findStopFile('swarm', root));
 live.coordination = coordinationView(read(statePath), Date.now(), Date.now(), paused);
 live.brain = live.coordination;
 return live;
}

const server = Bun.serve({
 hostname: '127.0.0.1',
 port: 3101,
 idleTimeout: 0,
 async fetch(req, host) {
  const url = new URL(req.url);
  if (url.pathname === '/api/control') return controls(req, host.requestIP(req)?.address ?? '');
  if (url.pathname === '/api/state') return Response.json(await state());
  if (url.pathname === '/events') {
   let timer: any;
   return new Response(
    new ReadableStream({
     start(c) {
      const emit = async () => {
       try {
        c.enqueue('data: ' + JSON.stringify(await state()) + '\n\n');
       } catch {
        clearInterval(timer);
       }
      };
      void emit();
      timer = setInterval(emit, 1500);
     },
     cancel() {
      clearInterval(timer);
     },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
   );
  }
  if (req.method !== 'GET') return new Response('Fixture accepts commands only through /api/control', { status: 405 });
  const response = await fetch('http://127.0.0.1:3100' + url.pathname + url.search);
  if (url.pathname === '/') {
   const html = (await response.text()).replace(
    '</head>',
    '<style>.client-title:after{content:"CONTROL TEST FIXTURE · NO GAME ACTIONS";color:#eeb665;font:10px Tahoma;margin-left:8px}</style></head>',
   );
   return new Response(html, { headers: response.headers });
  }
  return new Response(response.body, { status: response.status, headers: response.headers });
 },
});

console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.port, root, pid: process.pid }));
