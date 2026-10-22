import { test, expect } from 'bun:test';
import { isReady } from '../src/ready';

test('engine ready line', () => {
    expect(isReady('engine', '22/10/2026 04:44:52\t INFO\t World ready: Visit http://localhost:8888/rs2.cgi')).toBe(true);
});

test('gateway ready line is the running line, not the Bot/SDK line', () => {
    expect(isReady('gateway', '[Gateway] Gateway running at http://localhost:7780')).toBe(true);
    expect(isReady('gateway', '[Gateway] Bot/SDK: ws://localhost:7780')).toBe(false);
});

test('lite ready line', () => {
    expect(isReady('lite', "[lite-runner] Gateway connected, registering as 'practice1'")).toBe(true);
    expect(isReady('lite', "[lite-runner] 'practice1' logged into localhost:8888")).toBe(false);
});
