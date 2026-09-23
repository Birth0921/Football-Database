import { describe, it, expect } from 'vitest';
import { generateSecret, hashKey, fingerprint } from '../../src/keys/service.js';
import { parsePaging, pageInfo } from '../../src/util/http.js';
import { splitNameCountry, parseHeightToInt, parsePossession, paramsHash, eventKey } from '../../src/util/hash.js';

describe('API key generation', () => {
  it('has correct format and entropy', () => {
    const { fullKey, prefix } = generateSecret();
    expect(fullKey.startsWith('pf_live_')).toBe(true);
    expect(fullKey.length).toBeGreaterThanOrEqual(50); // 8 + 43
    expect(prefix).toBe(fullKey.slice(0, 12));
    // two keys never collide
    expect(generateSecret().fullKey).not.toBe(fullKey);
  });

  it('hash is deterministic but not reversible', () => {
    const { fullKey } = generateSecret();
    expect(hashKey(fullKey)).toBe(hashKey(fullKey));
    expect(hashKey(fullKey)).not.toContain(fullKey);
    expect(hashKey(fullKey + 'x')).not.toBe(hashKey(fullKey));
  });

  it('fingerprint differs for different keys', () => {
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });
});

describe('paging', () => {
  it('clamps values', () => {
    expect(parsePaging({ page: '0', perPage: '9999' })).toEqual({ page: 1, perPage: 100, offset: 0 });
    expect(parsePaging({ page: '3', perPage: '25' })).toEqual({ page: 3, perPage: 25, offset: 50 });
  });
  it('pageInfo computes totals', () => {
    expect(pageInfo(2, 25, 60)).toEqual({ page: 2, perPage: 25, total: 60, totalPages: 3 });
  });
});

describe('util parsing', () => {
  it('splits referee name/country', () => {
    expect(splitNameCountry('Michael Oliver, England')).toEqual({ name: 'Michael Oliver', country: 'England' });
    expect(splitNameCountry(null).name).toBe('');
    expect(splitNameCountry('Someone').country).toBeNull();
  });
  it('parses heights/weights', () => {
    expect(parseHeightToInt('183 cm')).toBe(183);
    expect(parseHeightToInt('0 cm')).toBeNull();
    expect(parseHeightToInt(null)).toBeNull();
  });
  it('parses possession', () => {
    expect(parsePossession('58%')).toBe(58);
    expect(parsePossession(null)).toBeNull();
  });
  it('params hash is order-independent', () => {
    expect(paramsHash('fixtures', { league: 39, season: 2025 })).toBe(paramsHash('fixtures', { season: 2025, league: 39 }));
    expect(paramsHash('fixtures', { league: 39 })).not.toBe(paramsHash('fixtures', { league: 140 }));
  });
  it('event key stable and includes index', () => {
    const k1 = eventKey([1, 2, 'Goal']);
    const k2 = eventKey([1, 2, 'Goal']);
    const k3 = eventKey([1, 2, 'Goal', 1]);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });
});
