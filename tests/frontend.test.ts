/**
 * Frontend security & UX structure tests (static analysis of the served
 * assets — no browser required):
 *  - no API keys or admin credentials of any kind in the frontend bundle
 *  - the browser never sends credentials itself (the proxy holds them)
 *  - loading/error/retry/toggle/toast/responsive mechanisms are present
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const pub = (...p: string[]) => path.resolve(process.cwd(), 'src/web/public', ...p);
const read = (f: string) => fs.readFileSync(pub(f), 'utf8');

const indexHtml = read('index.html');
const appJs = read('app.js');
const stylesCss = read('styles.css');
const adminHtml = read('admin/index.html');
const adminJs = read('admin/admin.js');

const allFrontend = { indexHtml, appJs, stylesCss, adminHtml, adminJs };

describe('frontend holds no credentials', () => {
  it('contains no hardcoded API keys (the revoked-key bug cannot recur)', () => {
    for (const [name, src] of Object.entries(allFrontend)) {
      expect(String(src).match(/pf_live_[A-Za-z0-9_]{6,}/), `${name} must not contain API keys`).toBeNull();
    }
  });

  it('contains no admin/server secrets or configuration', () => {
    const banned = ['ADMIN_PASSWORD', 'JWT_SECRET', 'API_FOOTBALL_KEY', 'DATABASE_URL', 'REDIS_URL', 'API_FOOTBALL_BASE_URL'];
    for (const [name, src] of Object.entries(allFrontend)) {
      for (const token of banned) {
        expect(String(src).includes(token), `${name} must not contain ${token}`).toBe(false);
      }
    }
  });

  it('the browser never sends an API key — only the server-side proxy does', () => {
    expect(appJs.includes('x-api-key')).toBe(false);
    expect(appJs.includes('X-API-Key')).toBe(false);
    expect(appJs.includes('Authorization')).toBe(false);
    expect(adminJs.includes('x-api-key')).toBe(false); // admin uses its own JWT bearer, no API key
  });
});

describe('frontend UX mechanisms are present', () => {
  it('has loading skeletons, error cards with retry, and empty states', () => {
    expect(indexHtml.includes('tpl-skeleton-card')).toBe(true);
    expect(appJs.includes('stateCard')).toBe(true);
    expect(appJs.includes('Unable to load fixtures')).toBe(true);
    expect(appJs.includes("We're having trouble connecting to the data service. Please try again.")).toBe(true);
    expect(appJs.includes('data-retry')).toBe(true);
    expect(appJs.includes('No fixtures available')).toBe(true);
  });

  it('has the Live/Upcoming/Finished toggle and lands on upcoming data', () => {
    expect(indexHtml.includes('fixture-toggle')).toBe(true);
    expect(indexHtml.includes('data-seg="live"')).toBe(true);
    expect(indexHtml.includes('data-seg="upcoming"')).toBe(true);
    expect(indexHtml.includes('data-seg="finished"')).toBe(true);
    expect(indexHtml.includes('role="tablist"')).toBe(true);
    expect(indexHtml.includes('aria-selected')).toBe(true);
    expect(indexHtml.includes('data-seg="upcoming" role="tab" aria-selected="true"')).toBe(true);
    expect(appJs.includes("let fixtureSegment = 'upcoming'" )).toBe(true);
  });

  it('has a toast/notification system in a consistent, aria-live location', () => {
    for (const src of [indexHtml, adminHtml]) {
      expect(src.includes('toast-stack')).toBe(true);
      expect(src.includes('aria-live="polite"')).toBe(true);
    }
    expect(appJs.includes('toast(')).toBe(true);
    expect(adminJs.includes('toast(')).toBe(true);
  });

  it('fixture cards use team names/logos, kickoff, competition and venue', () => {
    expect(appJs.includes('home_team_logo')).toBe(true);
    expect(appJs.includes('away_team_logo')).toBe(true);
    expect(appJs.includes('venue_name')).toBe(true);
    expect(appJs.includes('kickoff_utc')).toBe(true);
    expect(appJs.includes('competition_name')).toBe(true);
  });

  it('is responsive: mobile navigation and no fixed-width layout', () => {
    expect(indexHtml.includes('nav-toggle')).toBe(true);
    expect(stylesCss.includes('@media (max-width: 860px)')).toBe(true);
    expect(stylesCss.includes('prefers-reduced-motion')).toBe(true);
  });

  it('escapes all dynamic content (XSS-safe rendering)', () => {
    expect(appJs.includes('const esc =')).toBe(true);
    expect(adminJs.includes('const esc =')).toBe(true);
  });
});

describe('admin UX (destructive actions)', () => {
  it('shows managed/unmanaged indicator with read-only website badge', () => {
    expect(adminJs.includes('managed_role')).toBe(true);
    expect(adminJs.includes('Managed automatically')).toBe(true);
    expect(adminJs.includes('Read-only')).toBe(true);
  });

  it('permanent deletion asks for confirmation showing ONLY the key prefix', () => {
    expect(adminJs.includes('Permanently delete this API key?')).toBe(true);
    expect(adminJs.includes('data-delete')).toBe(true);
    expect(adminJs.includes('key_prefix')).toBe(true);
  });

  it('website rotation explains the safe order of operations', () => {
    expect(adminJs.includes('Rotate Website API key?')).toBe(true);
    expect(adminJs.includes('create and verify a replacement key before removing the old one')).toBe(true);
    expect(adminJs.includes('rotate-website')).toBe(true);
  });

  it('never displays the full secret after creation (one-time modal only)', () => {
    expect(adminJs.includes('showSecret')).toBe(true);
    expect(adminHtml.includes("I've saved it")).toBe(true);
    // the website-key rotation handler must NOT open the secret modal (secret stays server-side)
    const handlerMatch = adminJs.match(/async function rotateWebsiteKey[\s\S]*?\n  \}/);
    expect(handlerMatch).toBeTruthy();
    expect(handlerMatch![0].includes('showSecret')).toBe(false);
  });
});
