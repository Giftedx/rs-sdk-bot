// Shared BenchCase type definition used by aio-bench-cases.ts and modular case manifest files.
import type { SaveConfig } from '../../packages/practice/src/presets';

export type BenchCase = {
  key: string;
  engineEnv?: Record<string, string>;
  script: string;
  preset: string;
  presetConfig?: SaveConfig;
  scriptArgs: string[];
  pass: (stdout: string) => boolean;
  timeoutMs?: number;
  jobFiles?: Record<string, unknown>;
  companions?: { suffix: string; preset: string; presetConfig?: SaveConfig }[];
  output?: RegExp;
  known?: string;
};
