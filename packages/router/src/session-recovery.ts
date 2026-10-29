// Compatibility for existing API imports. The retired CLI never opens a session.
export * from "../../core/src/session-recovery";
if(import.meta.main){console.error("RECOVERY_HELD retired entry; use packages/core/src/session-recovery.ts; no connection attempted");process.exitCode=1;}
