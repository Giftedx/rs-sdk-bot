import { expect, test } from 'bun:test';
import { otherSideAccount } from './swarm';

test('a job whose account another side owns is skipped; unlisted accounts are local', () => {
    const owners = new Map([['quickhandjob', { side: 'claude-cloud', server: 'rs-sdk-demo.fly.dev' }], ['moneyshot', { side: 'local', server: 'rs-sdk-demo.fly.dev' }]]);
    expect(otherSideAccount(['Quickhandjob'], 'claude-cloud', owners)).toBeUndefined();
    expect(otherSideAccount(['Moneyshot'], 'claude-cloud', owners)).toEqual({ account: 'Moneyshot', side: 'local' });
    expect(otherSideAccount(['Unlisted'], 'local', owners)).toBeUndefined();
    expect(otherSideAccount(['Moneyshot', 'Quickhandjob'], 'local', owners)).toEqual({ account: 'Quickhandjob', side: 'claude-cloud' });
});
