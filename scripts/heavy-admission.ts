// One rule for the size of a heavy tool job (test shards, a type check): it takes the memory that is free above a
// floor, and it never takes the floor. A job gets smaller when memory is short. It is not refused, and no flag
// overrides the rule: one test process, or a small compiler heap, still starts.
//
// The floor is the fleet's floor (FREE_FLOOR_GB, packages/core/src/memory.ts) on a machine where a swarm runs: the
// swarm starts a bot only while that much memory is free, so a tool that takes it stops the fleet's starts.
// On a machine with no swarm (a cloud container, a hosted runner) the floor is TOOL_FLOOR_GB.
// This file is tooling. Runtime code does not import it, so a change here does not change a worker release.
export * from '../packages/core/src/heavy-admission';
