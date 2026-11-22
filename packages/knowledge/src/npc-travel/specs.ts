import { SEA_SPECS } from './specs-sea';
import { EXCLUDED, WORLD_SPECS } from './specs-world';
import type { Spec } from './types';

export const SPECS: Spec[] = [...SEA_SPECS, ...WORLD_SPECS];
export { EXCLUDED };
