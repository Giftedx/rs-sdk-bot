// This ordinary dependency must never receive the hosted entry's main=true define.
export const helperMain = import.meta.main;
if (import.meta.main) throw new Error('HELPER MAIN must not run');
