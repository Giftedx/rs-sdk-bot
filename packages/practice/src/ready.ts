export type Service = 'engine' | 'gateway' | 'lite';

// Copied from real runs on 2026-10-22.
const READY: Record<Service, string> = {
    engine: 'World ready',
    gateway: 'Gateway running at',
    lite: 'Gateway connected, registering as',
};

export function isReady(service: Service, line: string): boolean {
    return line.includes(READY[service]);
}
