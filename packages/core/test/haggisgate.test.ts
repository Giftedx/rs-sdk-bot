import { expect, test } from 'bun:test';
import { assertLoginAllowed } from '../src/haggisgate';

test('other accounts are never blocked', () => {
    expect(() => assertLoginAllowed('Mightyrod', Date.now(), {})).not.toThrow();
});

test('Haggis is refused without HAGGIS_RUN=1', () => {
    expect(() => assertLoginAllowed('Haggis', Date.now(), {})).toThrow(/HAGGIS_RUN=1/);
    expect(() => assertLoginAllowed('haggis', Date.now(), {})).toThrow(/HAGGIS_RUN=1/);
});

test('Haggis is refused when the gates have not passed', () => {
    // The gate file is absent or failing in this repo until every gate passes.
    expect(() => assertLoginAllowed('Haggis', Date.now(), { HAGGIS_RUN: '1' })).toThrow(/refused/);
});
