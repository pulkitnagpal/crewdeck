// Test helpers for the signed-in portals (ADR-0008): a fictional portal on www.portal.test, saved pages, and a fake
// launcher that serves them (no real browser in unit tests).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './helpers.ts';
import { type Portal, parsePortals } from '../../src/jobs/portals/catalog.ts';
import type { Launch, OpenPage, PortalBrowser } from '../../src/jobs/portals/profile.ts';
import type { Captured } from '../../src/jobs/portals/extract.ts';
import type { PortalProfile } from '../../src/jobs/portals/queries.ts';

export const FIXTURES = join(REPO, 'test', 'fixtures', 'jobs', 'portals');
export const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

export const FIXTURE_YAML = `
defaults:
  limits: { searches_per_run: 3, pages_per_search: 1, delay_ms: 10000, min_hours: 6, pages_per_day: 30 }
  sign_in_wall: ['^/(login|signin)\\b']
  auth_hosts: [www.recaptcha.net]
portals:
  - id: fixture
    name: Fixture Portal
    countries: [in]
    fields: [any]
    hosts: [www.portal.test, portal.test]
    cdn_hosts: [cdn.portal-static.test]
    signup_url: https://www.portal.test/register
    login_url: https://www.portal.test/login
    signed_in: { cookie: fx_session, url_pattern: '^/dashboard' }
    search:
      url: https://www.portal.test/jobs/{q_slug}-jobs?days={recency}&wfh={remote}&page={page}
      url_place: https://www.portal.test/jobs/{q_slug}-jobs-in-{place_slug}?days={recency}&page={page}
      remote: 'yes'
      recency: { 1: '1', 7: '7', 30: '30' }
      page: { start: 1, step: 1, omit_first: true }
      place_aliases: { bengaluru: bangalore }
    job_url: { pattern: '^/job/[A-Za-z0-9-]+-[A-Za-z0-9]{8}$' }
    json:
      - url: '/api/search'
        list: results
        fields: { url: link, title: name, company: org.name, location: where }
    limits: { searches_per_run: 3, pages_per_search: 2, delay_ms: 10000, min_hours: 6, pages_per_day: 30 }
    risk: Fixture risk note.
    verified: true
`;

export function fixturePortal(patch: Partial<Portal> = {}): Portal {
  const { cat, problems } = parsePortals(FIXTURE_YAML);
  if (problems.length) throw new Error(problems.join('; '));
  return { ...cat.byId.get('fixture')!, ...patch };
}

export const INDIA_PROFILE: PortalProfile = { targets: [{ name: 'Data', titles: ['Data Analyst', 'BI Analyst', 'Analytics Engineer', 'Insights Analyst'] }], titles: [], countries: ['in'], workModes: ['onsite', 'remote'], places: ['Bengaluru'] };

export type Page = { status?: number; html?: string; url?: string; captured?: Captured[]; throws?: string };
export type Fake = {
  launch: Launch; gotos: string[]; launches: { headless: boolean; signIn?: boolean }[]; closes: number; cleared: number;
  cookies: { name: string; domain: string }[]; open: OpenPage[]; closedByUser: boolean;
};

/** A launcher whose pages come from `route(url)` (a function or a map of URL prefixes → pages). */
export function fakeLaunch(route: ((url: string) => Page) | Record<string, Page>, o: { cookies?: { name: string; domain: string }[]; fail?: string } = {}): Fake {
  const f: Fake = { launch: null as any, gotos: [], launches: [], closes: 0, cleared: 0, cookies: o.cookies ?? [{ name: 'fx_session', domain: '.portal.test' }], open: [], closedByUser: false };
  const pick = (url: string): Page => {
    if (typeof route === 'function') return route(url);
    const k = Object.keys(route).find((p) => url.startsWith(p));
    return k ? route[k] : { status: 404, html: '<html><body>not found</body></html>' };
  };
  f.launch = async (_portal, lo) => {
    if (o.fail) throw new Error(o.fail);
    f.launches.push(lo);
    const b: PortalBrowser = {
      async newPage() {
        let cur: Page = {};
        return {
          async goto(url: string) {
            f.gotos.push(url);
            cur = pick(url);
            if (cur.throws) throw new Error(cur.throws);
            return { status: cur.status ?? 200, url: cur.url ?? url };
          },
          html: async () => cur.html ?? '',
          captured: () => cur.captured ?? [],
        };
      },
      cookies: async () => f.cookies,
      pages: async () => f.open,
      closed: () => f.closedByUser,
      clearPortal: async () => { f.cleared++; f.cookies = []; },
      blocked: () => [],
      close: async () => { f.closes++; },
    };
    return b;
  };
  return f;
}

/** A search page with `n` job cards on the fixture portal. */
export function cardsPage(n: number, tag = 'a'): string {
  const cards = Array.from({ length: n }, (_, i) => `<div class="card"><a href="/job/Data-Analyst-${tag}${i}-Ab${String(i).padStart(6, '0')}">Data Analyst ${tag}${i}</a><div>Fictional Co ${i}</div><div>Bengaluru</div></div>`);
  return `<html><body>${cards.join('\n')}</body></html>`;
}
