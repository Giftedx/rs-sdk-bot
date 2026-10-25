import { expect, test } from 'bun:test';
import { isLocalServer } from '../src/localserver';

test('our own machine counts as local, with or without a port', () => {
    for (const s of ['localhost', 'localhost:8888', 'LOCALHOST:8888', '127.0.0.1', '127.0.0.1:8888', '127.1.2.3:80', '::1', '[::1]:8888', ' localhost:8888 '])
        expect(isLocalServer(s)).toBe(true);
});

test('a name that only starts like a local one is not local', () => {
    for (const s of ['localhost.example.com', 'localhost.example.com:443', 'localhostx:8888', '127.evil.io', '127.0.0.1.evil.io',
        '127.0.0.1.nip.io:8888', '127.0.0', '127.0.0.256', 'localhost:8888/x', 'localhost:', 'rs-sdk-demo.fly.dev', '', '0.0.0.0:8888'])
        expect(isLocalServer(s)).toBe(false);
});
