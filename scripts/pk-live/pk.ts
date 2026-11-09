// The live run uses the canonical fight loop. This file was a copy of scripts/pk.ts that fell behind (it
// predates the session-dropped fix, commit c36a5b87), so fixes to scripts/pk.ts never reached live. Keep
// the re-export: scripts/swarm.ts's WORKER_ENTRY and the live release pin follow this path, and the
// coordinator's release hash covers it.
export * from '../pk';
