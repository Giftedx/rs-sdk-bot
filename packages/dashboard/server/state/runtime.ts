import { MAP, SECRET_MARK, SECRET_RE } from '../config';
import { buildState } from './build';
import { clients, refreshPrs, sampleCpu, scanProcs, setBuildMs } from './host';
import { runGate } from './plans';

// One state for everyone: built every 2 s only while a client watches, serialized once, sent to each SSE client.
let latest = { at: 0, json: '' };
let lastGcAt = 0;
const STATE_GC_INTERVAL_MS = 30_000;
// A page that connects gets the last built state at once, and the next tick sends a new one. A build holds the
// server for 150 to 300 ms, and each other request of the loading page waits behind it. The publisher reads the
// state each 60 s, so the last state is younger than this limit while the publisher runs.
const FIRST_STATE_MAX_AGE_MS = 90_000;
function current() {
    // The main account's name never leaves the server unasked: every string value has it swapped for a marker, which
    // the page draws as a blurred block (owner rule: screenshots must not show it). /api/reveal returns it on a click.
    if (Date.now() - latest.at > 1500) {
        try {
            // One replace on the finished text masks every value and every key.
            const t0 = performance.now(), json = JSON.stringify(buildState()).replace(SECRET_RE, SECRET_MARK);
            setBuildMs(Math.round(performance.now() - t0));
            const now = Date.now();
            latest = { at: now, json };
            if (now - lastGcAt >= STATE_GC_INTERVAL_MS) {
                lastGcAt = now;
                Bun.gc(false);
            }
        } catch (e) {
            // A malformed status file or a transient read failure must not stop the dashboard for every client.
            // Keep the last good state, and expose the failure so the page can show it.
            console.error(`state build failed: ${String(e)}`);
            if (latest.json) {
                try {
                    const stale = JSON.parse(latest.json);
                    stale.stateError = String(e).replace(SECRET_RE, SECRET_MARK);
                    latest = { at: Date.now(), json: JSON.stringify(stale) };
                } catch {
                    // If the previous state cannot be parsed, fall through to a minimal error state.
                }
            }
            if (!latest.json) {
                latest = { at: Date.now(), json: JSON.stringify({
                    now: Date.now(), stateError: String(e).replace(SECRET_RE, SECRET_MARK), bots: [], boards: [], events: [], results: [],
                    scripts: [], alerts: [], requests: [], mainPlan: null, capacity: null, swarm: null,
                    viewerTimings: [], race: null, gates: [], chain: null, gapHistory: [], economy: null,
                    pageVersion: 0, icons: {}, vault: null, collection: null, map: { ...MAP, ready: false },
                    sys: null, snapshotAt: null, liveTopsAt: 0, liveTops: 0, world: {}, worldPlayers: 0,
                }) };
            }
        }
    }
    return latest.json;
}
// ---------- SSE broadcast ----------
function getLatest() { return latest; }
function startStateBackground() {
    setInterval(sampleCpu, 4000);
    setInterval(() => void scanProcs(), 30_000);
    setInterval(() => void refreshPrs(), 300_000);
    void refreshPrs();
    setInterval(() => void runGate(), 600_000);
    setTimeout(() => void runGate(), 20_000);
    setInterval(() => {
        if (!clients.size) return;
        const msg = `data: ${current()}\n\n`;
        for (const c of clients) {
            // A client that holds the socket open and does not read would queue each state without limit.
            if ((c.desiredSize ?? 1) < -64) { clients.delete(c); try { c.close(); } catch { /* closed */ } continue; }
            try { c.enqueue(msg); } catch { clients.delete(c); }
        }
    }, 2000);
    // The first build reads every status file and every bot.env, which takes seconds. Do it at the start, so the
    // first page load does not wait for it.
    setTimeout(() => void current(), 1_000);
}

export {
    current,
    FIRST_STATE_MAX_AGE_MS,
    getLatest,
    startStateBackground,
};
