import { test, expect } from 'bun:test';
import { portInUse } from '../src/ports';

test('portInUse is true while a listener holds the port and false after', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = server.port;
    expect(await portInUse(port)).toBe(true);
    server.stop(true);
    expect(await portInUse(port)).toBe(false);
});
